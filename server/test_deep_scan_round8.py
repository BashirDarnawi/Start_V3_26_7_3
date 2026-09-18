"""Round 8 (2026-09-18): Social Studio publishing safety, Ads Studio lifecycle."""

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.social_studio as studio
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.test_ad_studio_backend import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    CUSTOMER_PERMISSIONS,
    REVIEWER_PERMISSIONS,
    _complete_campaign,
    _create_campaign,
    _create_user,
    _ensure_admin,
    _fresh_funded_customer,
    _review_campaign,
    _stop_campaign,
    _submit_campaign,
)
from server.test_ad_studio_backend import _login as _studio_login
from server.test_ad_studio_backend import _subscribe as _studio_subscribe
from server.test_social_studio import (  # noqa: F401  (graph/_fresh are fixtures)
    API,
    _fresh,
    _future,
    _insert_user,
    _link,
    _login,
    _post,
    _subscribe,
    client,
    graph,
)

TAG = secrets.token_hex(3)


@pytest.fixture(scope="module")
def actors():
    """Same shape as test_social_studio.actors with unique emails (shared in-memory DB)."""
    init_db()
    out = {}
    admin_email = f"r8-admin-{TAG}@tests.albayanhub.com"
    admin_id = _insert_user("R8 Admin", admin_email, "Admin")
    out["admin"] = {"id": admin_id, "cookies": _login(admin_email)}
    for key in ("a", "b"):
        email = f"r8-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"R8 {key}", email, "Employee")
        _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    return out


# ---------------------------------------------------------------- Social Studio

def test_a_claim_the_worker_never_finished_is_released(actors):
    owner = actors["a"]["id"]
    post_id = f"spost_stuck_{TAG}"
    stale = studio._iso_at(datetime.now(timezone.utc) - timedelta(minutes=20))
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialPosts',:id,:d,false,:t,:o,:t)"),
                     {"id": post_id, "t": now_ms(), "o": owner,
                      "d": json_dumps({"id": post_id, "ownerId": owner, "status": "publishing", "publishingSince": stale,
                                       "updatedAt": stale, "caption": "stuck", "pageIds": [], "media": [], "results": []})})
    studio.run_scheduler_tick(now=datetime.now(timezone.utc))
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": post_id}).mappings().first()
    data = json_loads(row["data_json"])
    assert data["status"] == "failed" and "interrupted" in data["lastError"]


def test_a_timed_out_publish_is_not_retried_blindly(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", f"51{secrets.randbelow(10**11):011d}")
    post = _post(cookies, [page["id"]], caption="Timeout", status="scheduled", scheduledAt=_future(2)).json()
    graph.fail["/feed"] = meta_ads.MetaAdsError("timeout", "Meta did not answer in time.", retryable=True)
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
    saved = client.get(f"{API}/posts/{post['id']}", cookies=cookies).json()
    assert saved["status"] == "failed"                       # not rescheduled: Meta may have published
    assert "may have published" in saved["lastError"]
    # A connect failure (nothing was sent) is still a normal retry.
    post2 = _post(cookies, [page["id"]], caption="Blip", status="scheduled", scheduledAt=_future(2)).json()
    graph.fail["/feed"] = meta_ads.MetaAdsError("network", "Meta could not be reached.", retryable=True)
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
    assert client.get(f"{API}/posts/{post2['id']}", cookies=cookies).json()["status"] == "scheduled"


def test_a_partially_published_post_keeps_its_live_page_and_refuses_text_edits(actors, graph):
    cookies = actors["a"]["cookies"]
    fb = _link(actors, "a", f"52{secrets.randbelow(10**11):011d}")
    ig = _link(actors, "a", f"53{secrets.randbelow(10**11):011d}", platform="ig", ig_user_id=f"178{secrets.randbelow(10**9):09d}")
    from server.test_social_studio import VALID_PNG_DATA_URL
    post = _post(cookies, [fb["id"], ig["id"]], caption="Both", media=[VALID_PNG_DATA_URL]).json()
    graph.fail["/media_publish"] = meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True)
    failed = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies).json()
    assert failed["status"] == "failed" and failed["results"][0]["metaPostId"]
    edit = client.patch(f"{API}/posts/{post['id']}", json={"caption": "Changed"}, cookies=cookies)
    assert edit.status_code == 409, edit.text                # the live FB post would diverge
    untick = client.patch(f"{API}/posts/{post['id']}", json={"pageIds": [ig["id"]]}, cookies=cookies)
    assert untick.status_code == 200, untick.text
    retried = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies).json()   # IG still failing
    kept = [r for r in retried["results"] if r["pageId"] == fb["id"]]
    assert kept and kept[0]["metaPostId"] == failed["results"][0]["metaPostId"] and kept[0].get("removed") is True
    deleted = client.delete(f"{API}/posts/{post['id']}", cookies=cookies)                # failed post, one live page
    assert deleted.status_code == 200 and deleted.json()["metaLive"] is True


def test_reply_retry_pass_waits_while_the_owner_paused_auto_replies(actors, monkeypatch):
    owner = actors["b"]["id"]
    cookies = actors["b"]["cookies"]
    assert client.put(f"{API}/settings", json={"masterEnabled": False}, cookies=cookies).status_code == 200
    page_id, rule_id, log_id = f"spg_pause_{TAG}", f"srule_pause_{TAG}", f"srl_pause_{TAG}"
    stamp = now_ms()
    past = studio._iso_at(datetime.now(timezone.utc) - timedelta(minutes=1))
    with db_conn() as conn:
        for entity_type, entity_id, data in (
            ("socialPages", page_id, {"ownerId": owner, "metaPageId": f"54{secrets.randbelow(10**11):011d}", "platform": "fb", "name": "P"}),
            ("socialReplyRules", rule_id, {"ownerId": owner, "enabled": True, "platform": "fb", "publicReply": "Thanks"}),
            ("socialReplyLog", log_id, {"ownerId": owner, "pageId": page_id, "platform": "fb", "ruleId": rule_id,
                                        "commentId": "54_5", "fromId": "9054", "actions": [], "processing": False,
                                        "error": "Meta paused", "retryAfter": past, "attempts": 1, "at": studio._iso_now()}),
        ):
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES (:type,:id,:data,false,:t,:owner,:t)"),
                         {"type": entity_type, "id": entity_id, "data": json_dumps({"id": entity_id, **data}), "t": stamp, "owner": owner})
    monkeypatch.setattr(studio, "_owner_can_automate", lambda owner_id: True)
    monkeypatch.setattr(studio, "_execute_rule_actions", lambda *a: (_ for _ in ()).throw(AssertionError("must not send while paused")))
    try:
        studio._retry_pending_replies(datetime.now(timezone.utc))
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": log_id}).mappings().first()
        assert json_loads(row["data_json"])["retryAfter"] > studio._iso_now()      # parked later, not sent
    finally:
        with db_conn() as conn:
            for entity_id in (page_id, rule_id, log_id):
                conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": entity_id})


# ---------------------------------------------------------------- Ads Studio

@pytest.fixture(scope="module")
def studio_actors():
    init_db()
    _ensure_admin()
    admin = _studio_login(ADMIN_EMAIL, ADMIN_PASSWORD)
    pw = "Str0ngPassw0rd!x"
    reviewer_user = _create_user(admin, f"r8-reviewer-{TAG}@tests.albayanhub.com", pw,
                                 {**CUSTOMER_PERMISSIONS, "adCampaignRequests": sorted(set(CUSTOMER_PERMISSIONS.get("adCampaignRequests", [])) | set(REVIEWER_PERMISSIONS["adCampaignRequests"]))})
    reviewer = _studio_login(f"r8-reviewer-{TAG}@tests.albayanhub.com", pw)
    _studio_subscribe(reviewer, f"r8-reviewer-{TAG}")
    funded = client.post("/api/wallet/top-ups", json={"userId": reviewer_user["id"], "amountMinor": 100_000_000, "currency": "USD",
                                                    "idempotencyKey": f"r8-wallet-{TAG}", "memo": "R8"}, cookies=admin)
    assert funded.status_code == 200, funded.text
    return {"admin": admin, "reviewer": reviewer, "reviewer_id": reviewer_user["id"]}


def test_nobody_reviews_their_own_campaign(studio_actors):
    cid = f"r8_self_{TAG}"
    created = _create_campaign(studio_actors["reviewer"], _complete_campaign("R8 Self"), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(studio_actors["reviewer"], cid, created.json()["lastModified"], f"r8-self-submit-{TAG}")
    assert submitted.status_code == 200, submitted.text
    reviewed = _review_campaign(studio_actors, cid, submitted.json()["lastModified"], "Approved", f"r8-self-approve-{TAG}")
    assert reviewed.status_code == 403, reviewed.text


def test_an_account_with_open_campaigns_cannot_be_soft_deleted_and_a_passed_start_moves_to_approval_day(studio_actors):
    user, cookies = _fresh_funded_customer(studio_actors, f"r8open{TAG}", 2500)
    cid = f"r8_open_{TAG}"
    created = _create_campaign(cookies, _complete_campaign("R8 Open"), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, cid, created.json()["lastModified"], f"r8-open-submit-{TAG}")
    assert submitted.status_code == 200, submitted.text
    refused = client.patch(f"/api/users/{user['id']}", json={"deleted": True}, cookies=studio_actors["admin"])
    assert refused.status_code == 409, refused.text
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    with db_conn() as conn:  # the request waited past its start date
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": cid}).mappings().one()
        data = json_loads(row["data_json"]); data["startDate"] = yesterday
        conn.execute(text("UPDATE entities SET data_json=:d WHERE id=:id"), {"d": json_dumps(data), "id": cid})
    latest = client.get(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies).json()
    approved = _review_campaign(studio_actors, cid, latest["lastModified"], "Approved", f"r8-open-approve-{TAG}")
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["startDate"] == datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with db_conn() as conn:  # staff marked it live on Meta
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": cid}).mappings().one()
        data = json_loads(row["data_json"]); data["publishStatus"] = "live"
        conn.execute(text("UPDATE entities SET data_json=:d WHERE id=:id"), {"d": json_dumps(data), "id": cid})
    latest = client.get(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies).json()
    stopped = _stop_campaign(studio_actors["reviewer"], cid, latest["lastModified"], f"r8-open-stop-{TAG}", reason="Done", refund=0)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["data"]["publishStatus"] == ""          # not "live" any more
