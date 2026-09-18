"""Round 4 (2026-09-18): wallet orphan-capture doors, LYD rounding, delete stamps.

Shares the Ads Studio fixtures (funded customers, reviewer, admin) with
server/test_ad_studio_backend.py."""

import secrets

from sqlalchemy import text

import server.main as main
from server import wallet_payments
from server.db import db_conn, json_dumps, now_ms
from server.security import new_id
import pytest

from server.db import init_db
from server.rate_limiter import reset_rate_limit
from server.test_ad_studio_backend import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    CUSTOMER_PERMISSIONS,
    REVIEWER_PERMISSIONS,
    _create_user,
    _ensure_admin,
    _login,
    _subscribe,
    client,
    _balance_minor,
    _complete_campaign,
    _create_campaign,
    _fresh_funded_customer,
    _review_campaign,
    _stop_campaign,
    _submit_campaign,
    _wallet_rows_for,
)

TAG = secrets.token_hex(3)


@pytest.fixture(scope="module")
def actors():
    """Same shape as test_ad_studio_backend.actors, with unique emails so both
    modules can run in one pytest session (the shared in-memory DB keeps users)."""
    init_db()
    # The per-IP login ceiling is shared by every module of the pytest run;
    # this module's extra logins must not push a later module over it.
    _clear_login_ip_bucket()
    _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    pw = "Str0ngPassw0rd!x"
    owner_user = _create_user(admin, f"r4-owner-{TAG}@tests.albayanhub.com", pw, CUSTOMER_PERMISSIONS)
    other_user = _create_user(admin, f"r4-other-{TAG}@tests.albayanhub.com", pw, CUSTOMER_PERMISSIONS)
    reviewer_user = _create_user(admin, f"r4-reviewer-{TAG}@tests.albayanhub.com", pw, REVIEWER_PERMISSIONS)
    owner = _login(f"r4-owner-{TAG}@tests.albayanhub.com", pw)
    other = _login(f"r4-other-{TAG}@tests.albayanhub.com", pw)
    reviewer = _login(f"r4-reviewer-{TAG}@tests.albayanhub.com", pw)
    _subscribe(owner, f"r4-owner-{TAG}")
    _subscribe(other, f"r4-other-{TAG}")
    for uid, tag in ((owner_user["id"], "owner"), (other_user["id"], "other")):
        funded = client.post("/api/wallet/top-ups", json={"userId": uid, "amountMinor": 100_000_000, "currency": "USD",
                                                        "idempotencyKey": f"r4-wallet-{tag}-{TAG}", "memo": "R4 funding"}, cookies=admin)
        assert funded.status_code == 200, funded.text
    try:
        yield {"admin": admin, "owner": owner, "owner_id": owner_user["id"], "other": other, "other_id": other_user["id"],
               "reviewer": reviewer, "reviewer_id": reviewer_user["id"]}
    finally:
        _clear_login_ip_bucket()


def _clear_login_ip_bucket():
    for ip in ("testclient", "192.0.2.99", "127.0.0.1"):
        reset_rate_limit(f"login:ip:{ip}")


def _insert_orphan_capture(user_id, campaign_id, submitted_at, amount):
    """A capture whose reject/CR release never committed (the crash window)."""
    orphan_tx = new_id("tx")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('walletTransactions',:id,:d,false,:now,:uid,:now)"),
            {"id": orphan_tx, "now": now_ms(), "uid": user_id,
             "d": json_dumps({"type": "campaign_payment", "schemaVersion": 2, "amountMinor": amount, "amount": amount / 100,
                              "currency": "USD", "fromUserId": user_id, "toUserId": "system",
                              "memo": f"Ad campaign budget {campaign_id}", "idempotencyKey": f"cpay:{campaign_id}:{submitted_at}",
                              "status": "posted", "referenceType": "adCampaignRequest", "referenceId": campaign_id,
                              "createdAt": submitted_at})},
        )
    return orphan_tx


def _rows_of_type(actors, uid, kind):
    return [r for r in _wallet_rows_for(actors, uid) if str(r.get("type") or "") == kind]


def test_orphan_capture_on_a_rejected_campaign_returns_when_archived(actors):
    user, cookies = _fresh_funded_customer(actors, f"r4rej{TAG}", 2500)
    cid = f"r4_rej_{TAG}"
    created = _create_campaign(cookies, _complete_campaign("R4 Reject"), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, cid, created.json()["lastModified"], f"r4-rej-submit-{TAG}")
    assert submitted.status_code == 200, submitted.text
    rejected = _review_campaign(actors, cid, submitted.json()["lastModified"], "Rejected", f"r4-rej-{TAG}", note="No")
    assert rejected.status_code == 200, rejected.text
    _insert_orphan_capture(user["id"], cid, submitted.json()["data"]["submittedAt"], 2500)
    assert _balance_minor(actors, user["id"]) == 0
    deleted = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=actors["admin"])
    assert deleted.status_code == 200, deleted.text
    assert len(_rows_of_type(actors, user["id"], "campaign_payment_release")) == 1
    assert _balance_minor(actors, user["id"]) == 2500          # the money came back


def test_resubmit_releases_the_previous_cycles_orphan_capture(actors):
    user, cookies = _fresh_funded_customer(actors, f"r4cr{TAG}", 5000)
    cid = f"r4_cr_{TAG}"
    created = _create_campaign(cookies, _complete_campaign("R4 CR"), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, cid, created.json()["lastModified"], f"r4-cr-submit1-{TAG}")
    assert submitted.status_code == 200, submitted.text
    cr = _review_campaign(actors, cid, submitted.json()["lastModified"], "Changes Requested", f"r4-cr-{TAG}", note="Fix name")
    assert cr.status_code == 200, cr.text
    _insert_orphan_capture(user["id"], cid, submitted.json()["data"]["submittedAt"], 2500)
    assert _balance_minor(actors, user["id"]) == 2500
    edited = client.patch(f"/api/collections/adCampaignRequests/{cid}",
                          json={"data": {"name": "R4 CR fixed"}, "expectedLastModified": cr.json()["lastModified"]}, cookies=cookies)
    assert edited.status_code == 200, edited.text
    resubmitted = _submit_campaign(cookies, cid, edited.json()["lastModified"], f"r4-cr-submit2-{TAG}")
    assert resubmitted.status_code == 200, resubmitted.text
    assert _balance_minor(actors, user["id"]) == 5000          # old cycle's capture returned before the new hold
    assert len(_rows_of_type(actors, user["id"], "campaign_payment_release")) == 1
    approved = _review_campaign(actors, cid, resubmitted.json()["lastModified"], "Approved", f"r4-cr-approve-{TAG}")
    assert approved.status_code == 200, approved.text
    assert _balance_minor(actors, user["id"]) == 2500          # charged once for one campaign
    stopped = _stop_campaign(cookies, cid, approved.json()["lastModified"], f"r4-cr-stop-{TAG}")
    assert stopped.status_code == 200, stopped.text
    assert _balance_minor(actors, user["id"]) == 5000
    # The stop's refund closes the door: archiving must not release a second time.
    deleted = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=actors["admin"])
    assert deleted.status_code == 200, deleted.text
    assert _balance_minor(actors, user["id"]) == 5000


def test_stopped_campaign_with_spent_budget_is_not_refunded_on_archive(actors):
    user, cookies = _fresh_funded_customer(actors, f"r4spent{TAG}", 2500)
    cid = f"r4_spent_{TAG}"
    created = _create_campaign(cookies, _complete_campaign("R4 Spent"), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, cid, created.json()["lastModified"], f"r4-spent-submit-{TAG}")
    assert submitted.status_code == 200, submitted.text
    approved = _review_campaign(actors, cid, submitted.json()["lastModified"], "Approved", f"r4-spent-approve-{TAG}")
    assert approved.status_code == 200, approved.text
    assert _balance_minor(actors, user["id"]) == 0
    # Staff stop it with nothing to refund (the whole budget was spent on Meta).
    stopped = _stop_campaign(actors["reviewer"], cid, approved.json()["lastModified"], f"r4-spent-stop-{TAG}", reason="Budget spent", refund=0)
    assert stopped.status_code == 200, stopped.text
    deleted = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=actors["admin"])
    assert deleted.status_code == 200, deleted.text
    assert _rows_of_type(actors, user["id"], "campaign_payment_release") == []
    assert _balance_minor(actors, user["id"]) == 0                 # spent money stays spent


def test_lyd_instruction_uses_integer_rounding():
    assert wallet_payments.lyd_minor_for(100, 4.9) == 490      # float ceil said 491
    assert wallet_payments.lyd_minor_for(100, 4.00005) == 401   # half-up, like the client's Math.round
    assert wallet_payments.lyd_minor_for(100, 1.1) == 110
    assert wallet_payments.lyd_minor_for(100, 8.3) == 830
    assert wallet_payments.lyd_minor_for(1, 4.9) == 5          # still rounds UP, never under-covers
    assert wallet_payments.lyd_minor_for(333, 4.925) == 1641   # ceil(1640.025)


def test_generic_delete_answers_with_the_tombstone_stamp(actors):
    created = client.post("/api/collections/pages", json={"data": {"id": f"page_r4_{TAG}", "name": "R4 page", "category": "General", "customerIds": []}},
                          cookies=actors["admin"])
    assert created.status_code == 200, created.text
    deleted = client.delete(f"/api/collections/pages/{created.json()['id']}", cookies=actors["admin"])
    assert deleted.status_code == 200, deleted.text
    assert int(deleted.json()["lastModified"]) > int(created.json()["lastModified"])


def test_plan_catalog_cannot_be_replaced_by_restore_or_generic_patch(actors):
    forged = {"settingKey": main.PLAN_SETTINGS_KEY, "version": 999999, "plans": []}
    restored = client.put(f"/api/admin/collections/appSettings/plan_r4_{TAG}/restore",
                          json={"data": {"id": f"plan_r4_{TAG}", **forged}, "createdAt": now_ms()}, cookies=actors["admin"])
    assert restored.status_code == 405, restored.text
    row_id = f"plan_live_r4_{TAG}"
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('appSettings',:id,:d,false,:now,'system',:now)"),
                     {"id": row_id, "d": json_dumps({"id": row_id, **forged, "version": 1}), "now": now_ms()})
    try:
        patched = client.patch(f"/api/collections/appSettings/{row_id}", json={"data": {"version": 2}}, cookies=actors["admin"])
        assert patched.status_code == 405, patched.text
        # ... nor overwritten by a restore that omits the key (the live row is what matters).
        overwrite = client.put(f"/api/admin/collections/appSettings/{row_id}/restore",
                               json={"data": {"id": row_id, "note": "gone"}, "createdAt": now_ms()}, cookies=actors["admin"])
        assert overwrite.status_code == 405, overwrite.text
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": row_id})


def test_restore_keeps_history_of_deleted_staff(actors):
    email = f"r4-left-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={"name": "Left", "email": email, "password": "Str0ngPassw0rd!x", "role": "Employee", "permissions": {}},
                          cookies=actors["admin"])
    assert created.status_code == 200, created.text
    left_id = created.json()["id"]
    with db_conn() as conn:  # the account was removed later (soft delete)
        conn.execute(text("UPDATE users SET deleted = true WHERE id = :id"), {"id": left_id})
    restored = client.put(f"/api/admin/collections/pages/page_left_r4_{TAG}/restore",
                          json={"data": {"id": f"page_left_r4_{TAG}", "name": "Old page", "category": "General", "customerIds": []},
                                "createdAt": now_ms(), "createdBy": left_id}, cookies=actors["admin"])
    assert restored.status_code == 200, restored.text


def test_import_refusal_names_the_coverage_fields(actors, monkeypatch):
    monkeypatch.setattr(main, "ENABLE_ONLINE_IMPORT", True)
    imported = client.post("/api/admin/import",
                           json={"collections": {"receipts": [{"id": f"cov_r4_{TAG}", "companyCoveredUSD": 5.0}]}}, cookies=actors["admin"])
    assert imported.status_code == 405, imported.text
    assert "coverage" in imported.text and "encrypted database backup" in imported.text
