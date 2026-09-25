"""Albayan Studio inbox: GET /api/studio/activity and POST /api/studio/activity/seen (plan task P3-05;
PLAN.md §7.3, §7.6, M7).

* Items are written at the lifecycle points (review, the Meta link or "live" marker, a staff stop, a
  stop request) and read from the owner's own ledger credits and results rows; newest first, paged.
* Isolation: a customer only ever sees their own items; nothing names a staff member.
* The seen marker moves forward only, never past now, resets the unread count and keeps the
  profile's WhatsApp number.

Every test creates its own users (unique e-mails per run) and removes every row they own afterwards.
"""

import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES, studio_activity
from server.systems.ads_studio.social_studio import SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_activity import (
    ACTIVITY_TEXTS,
    ACTIVITY_TYPE,
    KINDS,
    activity_id,
    activity_texts,
    clean_params,
    record_activity,
)
from server.systems.ads_studio.studio_profile import profile_id
from server.systems.ads_studio.studio_results import write_results_row
from server.systems.ads_studio.studio_types import STUDIO_PROFILES_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "StudioActivityPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
REVIEWER_PERMISSIONS = {CAMPAIGNS: ["view", "review"]}
ARABIC = re.compile(r"[؀-ۿ]")
PNG = ("data:image/png;base64,"
       "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC")
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("activity_user")
    email = f"studio-activity-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Activity {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    _USERS.append(user_id)
    return {"id": user_id, "email": email, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    return {
        "owner": _insert_user("owner", "Employee", CUSTOMER_PERMISSIONS),
        "other": _insert_user("other", "Employee", CUSTOMER_PERMISSIONS),
        "reviewer": _insert_user("reviewer", "Employee", REVIEWER_PERMISSIONS),
        "admin": _insert_user("admin", "Admin", {}),
    }


@pytest.fixture(autouse=True)
def _isolated(people):
    for uid in _USERS:
        for bucket in ("studio:activity-read", "studio:activity-seen", "studio:profile-write", "ad-studio:mutations"):
            reset_rate_limit(f"{bucket}:{uid}")
    yield
    with db_conn() as conn:
        params = {f"u{i}": uid for i, uid in enumerate(_USERS)}
        names = ", ".join(f":u{i}" for i in range(len(_USERS)))
        conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names}) AND type <> 'serviceSubscriptions'"), params)


def _feed(user: dict, cursor: str | None = None):
    params = {"cursor": cursor} if cursor else None
    return client.get("/api/studio/activity", params=params, cookies=user["cookies"])


def _seen(user: dict, body, **kwargs):
    return client.post("/api/studio/activity/seen", json=body, cookies=user["cookies"], **kwargs)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code, detail
    return detail


def _record(owner_id: str, kind: str, related_id: str, key: str, at: datetime, **params) -> bool:
    with db_conn() as conn:
        return record_activity(conn, owner_id=owner_id, kind=kind, related_type="campaign", related_id=related_id,
                               key=key, at=at, params=params)


T0 = datetime(2026, 9, 20, 8, 0, tzinfo=timezone.utc)


# ------------------------------------------------------------------ types, texts and the writer


def test_activity_type_is_owned_and_router_only(people):
    assert ACTIVITY_TYPE in OWNED_TYPES and ACTIVITY_TYPE in SOCIAL_STUDIO_COLLECTIONS
    owner = people["owner"]
    assert client.get(f"/api/collections/{ACTIVITY_TYPE}", cookies=owner["cookies"]).status_code == 404
    forged = client.post(f"/api/collections/{ACTIVITY_TYPE}", json={"id": "act_x", "data": {"kind": "settled"}},
                         cookies=owner["cookies"])
    assert forged.status_code == 404, forged.text


def test_activity_texts_are_bilingual_for_every_kind():
    assert set(ACTIVITY_TEXTS) == set(KINDS)
    for kind in KINDS:
        for params in ({}, {"reasonCode": "text_policy", "amountMinor": 2500, "refundMinor": 1234, "number": "T-000123"}):
            title, body = activity_texts(kind, clean_params(params))
            for part in (title, body):
                assert set(part) == {"en", "ar"} and ARABIC.search(part["ar"]) and part["en"] and "{" not in part["en"] + part["ar"]
    assert activity_texts("request_sent_back", {"reasonCode": "text_policy"})[1] == {
        "en": "The team sent it back: Text breaks ad rules. Fix it and send it again.",
        "ar": "أعاده الفريق: النص يخالف قواعد الإعلانات. عدّله ثم أرسله مرة أخرى.",
    }
    assert activity_texts("request_sent_back", {"reasonCode": "nonsense"})[1]["en"] == "The team sent it back. Fix it and send it again."
    assert activity_texts("request_approved", {"amountMinor": 250000})[1]["en"].startswith("$2,500.00 was paid")
    assert activity_texts("settled", {"refundMinor": 0})[1]["ar"] == "صرفت ميتا الميزانية كلها، فلم يبقَ ما نعيده."
    assert activity_texts("payment_confirmed", {"amountMinor": 12345, "currency": "LYD"})[1] == {
        "en": "123.45 LYD was added to your wallet.", "ar": "أضفنا 123.45 د.ل إلى محفظتك.",
    }


def test_record_activity_is_idempotent_and_keeps_no_free_text(people):
    owner = people["owner"]["id"]
    assert _record(owner, "request_sent_back", "cmp_a", "k1", T0, reasonCode="other", note="free <b>text</b>") is True
    assert _record(owner, "request_sent_back", "cmp_a", "k1", T0 + timedelta(hours=1)) is False  # the same event
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, created_by, created_at FROM entities WHERE type = :t AND id = :id"),
                           {"t": ACTIVITY_TYPE, "id": activity_id(owner, "request_sent_back", "cmp_a", "k1")}).mappings().first()
        assert row["created_by"] == owner and int(row["created_at"]) == int(T0.timestamp() * 1000)
        assert json_loads(row["data_json"])["params"] == {"reasonCode": "other"} and "free" not in row["data_json"]
        assert record_activity(conn, owner_id="system", kind="settled", related_type="campaign", related_id="x", key="k") is False
        with pytest.raises(ValueError):
            record_activity(conn, owner_id=owner, kind="nonsense", related_type="campaign", related_id="x", key="k")
        with pytest.raises(ValueError):
            record_activity(conn, owner_id=owner, kind="settled", related_type="users", related_id="x", key="k")
    assert clean_params({"amountMinor": True, "refundMinor": -1, "number": "T-1 <x>", "currency": "USD"}) == {"currency": "USD"}


# ------------------------------------------------------------------ the feed


def test_activity_requires_login_and_is_isolated(people):
    client.cookies.clear()
    assert client.get("/api/studio/activity").status_code == 401
    owner, other = people["owner"], people["other"]
    _record(owner["id"], "request_approved", "cmp_iso", "k", T0, amountMinor=500)
    mine, theirs = _feed(owner).json(), _feed(other).json()
    assert [item["relatedId"] for item in mine["items"]] == ["cmp_iso"] and mine["unreadCount"] == 1
    assert theirs == {"items": [], "unreadCount": 0, "nextCursor": None, "seenAt": None}
    staff = _feed(people["admin"]).json()
    assert all(item["relatedId"] != "cmp_iso" for item in staff["items"])  # admins read their OWN inbox here too
    assert owner["id"] not in json.dumps(mine)
    _error(_feed(owner, "not-a-cursor"), 400, "INVALID_VALUE")


def test_activity_order_paging_and_derived_items(people):
    owner = people["owner"]
    for index in range(23):
        _record(owner["id"], "request_live", f"cmp_page_{index:02d}", "live", T0 + timedelta(minutes=index))
    # payment_confirmed: a ledger credit for one of the owner's charge requests (the confirm path's row)
    credit_id = f"wtx_{TAG}_{secrets.token_hex(3)}"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('walletTransactions',:id,:data,false,:stamp,:owner,:stamp)"),
            {"id": credit_id, "owner": owner["id"], "stamp": now_ms(), "data": json_dumps({
                "type": "credit", "amountMinor": 2500, "currency": "USD", "toUserId": owner["id"], "fromUserId": None,
                "referenceType": "walletPaymentRequests", "referenceId": f"pay_{TAG}", "status": "posted",
                "idempotencyKey": f"payreq:pay_{TAG}", "createdAt": "2026-09-20T08:10:30Z"})},
        )
        write_results_row(conn, f"cmp_ended_{TAG}", owner["id"], {"metaCampaignId": "120200000000999",
                                                                  "deliveryEndedAt": "2026-09-20T08:05:30Z"})
    pages, cursor = [], None
    for _ in range(5):
        page = _feed(owner, cursor).json()
        pages.append(page)
        cursor = page["nextCursor"]
        if not cursor:
            break
    items = [item for page in pages for item in page["items"]]
    assert [len(page["items"]) for page in pages] == [20, 5]
    assert len(items) == 25 and len({item["id"] for item in items}) == 25
    times = [item["createdAt"] for item in items]
    assert times == sorted(times, reverse=True)
    payment = next(item for item in items if item["kind"] == "payment_confirmed")
    assert payment["relatedType"] == "payment" and payment["relatedId"] == f"pay_{TAG}"
    assert payment["body"]["en"] == "$25.00 was added to your wallet." and payment["createdAt"] == "2026-09-20T08:10:30.000Z"
    ended = next(item for item in items if item["kind"] == "ad_ended")
    assert ended["relatedId"] == f"cmp_ended_{TAG}" and ended["createdAt"] == "2026-09-20T08:05:30.000Z"
    assert pages[0]["unreadCount"] == 25 and all(item["unread"] for item in items)
    assert all(set(item) == {"id", "kind", "title", "body", "relatedType", "relatedId", "createdAt", "unread"} for item in items)
    assert _feed(people["other"]).json()["items"] == []  # the other customer's ledger and results are theirs


# ------------------------------------------------------------------ the seen marker


def test_seen_marker_resets_unread_and_never_moves_back(people, monkeypatch):
    owner = people["owner"]
    monkeypatch.setattr(studio_activity, "utc_now", lambda: T0 + timedelta(days=1))
    saved = client.put("/api/studio/profile", json={"whatsappNumber": "0912345678", "whatsappConsent": True},
                       cookies=owner["cookies"])
    assert saved.status_code == 200
    for index in range(3):
        _record(owner["id"], "request_live", f"cmp_seen_{index}", "live", T0 + timedelta(minutes=index))
    feed = _feed(owner).json()
    assert feed["unreadCount"] == 3 and feed["seenAt"] is None
    middle = feed["items"][1]["createdAt"]
    moved = _seen(owner, {"upTo": middle})
    assert moved.status_code == 200 and moved.json() == {"activitySeenAt": middle, "unreadCount": 1}
    assert [item["unread"] for item in _feed(owner).json()["items"]] == [True, False, False]
    older = _seen(owner, {"upTo": feed["items"][2]["createdAt"]})
    assert older.json()["activitySeenAt"] == middle  # never back
    future = _seen(owner, {"upTo": "2099-01-01T00:00:00Z"})
    assert future.json() == {"activitySeenAt": "2026-09-21T08:00:00.000Z", "unreadCount": 0}  # clamped to now
    later = _feed(owner).json()
    assert later["unreadCount"] == 0 and later["seenAt"] == "2026-09-21T08:00:00.000Z"
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": STUDIO_PROFILES_TYPE, "id": profile_id(owner["id"])}).mappings().first()
        audits = conn.execute(text("SELECT COUNT(*) FROM audit_logs WHERE action = 'activity_seen' AND user_id = :uid"),
                              {"uid": owner["id"]}).scalar()
    data = json_loads(row["data_json"])
    assert data["whatsappNumber"] == "+218912345678" and data["activitySeenAt"] == "2026-09-21T08:00:00.000Z"
    assert audits == 2  # two moves; the refused step back wrote nothing
    assert client.get("/api/studio/profile", cookies=owner["cookies"]).json()["whatsappNumber"] == "+218912345678"
    _record(owner["id"], "settled", "cmp_seen_new", "settled", T0 + timedelta(days=2), refundMinor=0)
    assert _feed(owner).json()["unreadCount"] == 1  # a newer item is unread again


def test_seen_marker_refuses_bad_bodies_and_other_sites(people):
    owner = people["owner"]
    _error(_seen(owner, {"upTo": "yesterday"}), 400, "INVALID_VALUE")
    _error(_seen(owner, {"upTo": 1790000000000}), 400, "INVALID_VALUE")
    _error(_seen(owner, {"upTo": "2026-09-20T08:00:00Z", "ownerId": people["other"]["id"]}), 400, "UNKNOWN_FIELD")
    _error(_seen(owner, ["2026-09-20T08:00:00Z"]), 400, "INVALID_REQUEST")
    _error(_seen(owner, {"upTo": "2026-09-20T08:00:00Z"}, headers={"Origin": "https://evil.example"}), 403, "CROSS_SITE")
    client.cookies.clear()
    assert client.post("/api/studio/activity/seen", json={"upTo": "2026-09-20T08:00:00Z"}).status_code == 401


# ------------------------------------------------------------------ written at the lifecycle points


def _subscribe_and_fund(user: dict, admin: dict) -> None:
    bought = client.post("/api/subscriptions/purchase", json={"serviceId": "ad_maker", "idempotencyKey": f"act-sub-{user['id']}"},
                         cookies=user["cookies"])
    assert bought.status_code == 200, bought.text
    funded = client.post("/api/wallet/top-ups", json={"userId": user["id"], "amountMinor": 1_000_000, "currency": "USD",
                                                      "idempotencyKey": f"act-fund-{user['id']}"}, cookies=admin["cookies"])
    assert funded.status_code == 200, funded.text


def _campaign_body(name: str) -> dict:
    return {
        "name": name, "objective": "messages", "platforms": ["facebook", "instagram"], "pageName": "Test Page",
        "primaryText": "Message us for this week's offer.", "headline": "Weekly offer", "description": "A request.",
        "callToAction": "Send Message", "destination": "https://wa.me/218910000000", "locations": ["Tripoli, Libya"],
        "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"], "interests": ["Shopping"],
        "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": 2500, "budgetType": "lifetime",
        "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }


def _post(path: str, user: dict, body: dict):
    response = client.post(path, json=body, cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def test_lifecycle_points_write_the_inbox(people):
    owner, reviewer, admin = people["owner"], people["reviewer"], people["admin"]
    _subscribe_and_fund(owner, admin)
    campaign_id = f"act_flow_{TAG}"
    created = _post("/api/collections/adCampaignRequests", owner, {"id": campaign_id, "data": _campaign_body("Flow")})
    base = f"/api/ad-studio/campaigns/{campaign_id}"
    sent = _post(f"{base}/submit", owner, {"expectedLastModified": created["lastModified"], "operationId": f"act-submit-1-{TAG}"})
    back = _post(f"{base}/review", reviewer, {"expectedLastModified": sent["lastModified"], "decision": "Changes Requested",
                                              "note": "Please change the photo", "operationId": f"act-review-1-{TAG}",
                                              "reviewReasonCode": "creative_quality"})
    sent = _post(f"{base}/submit", owner, {"expectedLastModified": back["lastModified"], "operationId": f"act-submit-2-{TAG}"})
    approved = _post(f"{base}/review", reviewer, {"expectedLastModified": sent["lastModified"], "decision": "Approved",
                                                  "note": "", "operationId": f"act-review-2-{TAG}"})
    live = _post(f"{base}/publish-status", reviewer, {"expectedLastModified": approved["lastModified"],
                                                      "operationId": f"act-live-1-{TAG}", "publishStatus": "live"})
    _post(f"{base}/stop", admin, {"expectedLastModified": live["lastModified"], "operationId": f"act-stop-1-{TAG}",
                                  "refundMinorUSD": 1000, "closeReason": "completed"})
    rejected_id = f"act_rej_{TAG}"
    created = _post("/api/collections/adCampaignRequests", owner, {"id": rejected_id, "data": _campaign_body("Rejected")})
    sent = _post(f"/api/ad-studio/campaigns/{rejected_id}/submit", owner,
                 {"expectedLastModified": created["lastModified"], "operationId": f"act-submit-3-{TAG}"})
    _post(f"/api/ad-studio/campaigns/{rejected_id}/review", reviewer,
          {"expectedLastModified": sent["lastModified"], "decision": "Rejected", "note": "", "operationId": f"act-review-3-{TAG}",
           "reviewReasonCode": "text_policy"})

    items = _feed(owner).json()["items"]
    flow = [item["kind"] for item in items if item["relatedId"] == campaign_id]
    assert flow == ["settled", "request_live", "request_approved", "request_sent_back"]
    by_kind = {item["kind"]: item for item in items}
    assert by_kind["request_sent_back"]["body"]["ar"] == "أعاده الفريق: جودة الصورة أو الفيديو. عدّله ثم أرسله مرة أخرى."
    assert by_kind["request_approved"]["body"]["en"] == "$25.00 was paid from your wallet. The team is setting it up in Meta."
    assert by_kind["settled"]["body"]["en"] == "$10.00 went back to your wallet."
    assert by_kind["request_rejected"]["relatedId"] == rejected_id
    assert by_kind["request_rejected"]["body"]["en"].startswith("Reason: Text breaks ad rules.")
    assert any(item["kind"] == "payment_confirmed" for item in items) is False  # an admin top-up is not a payment request
    text_out = json.dumps(items, ensure_ascii=False)
    assert reviewer["id"] not in text_out and admin["id"] not in text_out and "Please change the photo" not in text_out

    # A replayed review (same operationId) writes nothing new.
    again = client.post(f"/api/ad-studio/campaigns/{rejected_id}/review", cookies=reviewer["cookies"],
                        json={"expectedLastModified": sent["lastModified"], "decision": "Rejected", "note": "",
                              "operationId": f"act-review-3-{TAG}", "reviewReasonCode": "text_policy"})
    assert again.status_code == 200
    assert len(_feed(owner).json()["items"]) == len(items)
