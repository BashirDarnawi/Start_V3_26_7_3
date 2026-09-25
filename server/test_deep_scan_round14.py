"""Deep-scan round 14: RBAC record scoping, the role-flip chain, the audit cleanup route,
delivery watermarks, and closing a launched Ads Studio campaign.

Disposable local records only; the suite shares one in-memory database, so records
carry a per-run tag.
"""

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import new_id
from server.test_permission_drift_fixes import PW, _seed_admin
from server.test_ad_studio_backend import (
    ADMIN_EMAIL as STUDIO_ADMIN_EMAIL,
    ADMIN_PASSWORD as STUDIO_ADMIN_PASSWORD,
    REVIEWER_PERMISSIONS,
    _approved_campaign,
    _balance_minor,
    _complete_campaign,
    _create_campaign,
    _create_user as _studio_create_user,
    _ensure_admin as _studio_ensure_admin,
    _fresh_funded_customer,
    _login as _studio_login,
    _publish_status,
    _review_campaign,
    _stop_campaign,
    _submit_campaign,
)

TAG = secrets.token_hex(3)
client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.99", 50000))


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _create_user(admin: dict, name: str, role: str, permissions: dict) -> dict:
    email = f"r14-{name}-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={"name": name, "email": email, "password": PW, "role": role,
                                              "permissions": permissions}, cookies=admin["cookies"])
    assert created.status_code == 200, created.text
    return {"id": created.json()["id"], "email": email, "cookies": _login(email)}


def _create(collection: str, data: dict, cookies: dict, record_id: str | None = None) -> dict:
    body = {"data": data}
    if record_id:
        body["id"] = record_id
    response = client.post(f"/api/collections/{collection}", json=body, cookies=cookies)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def staff():
    init_db()
    admin = _seed_admin(f"r14admin{TAG}")
    manager = _create_user(admin, "manager", "Employee",
                           {"users": ["view", "changeRole", "resetPassword", "edit"], "customers": ["view"]})
    target = _create_user(admin, "target", "Employee", {"receipts": ["view", "edit"], "customers": ["view"]})
    customer = _create("customers", {"name": f"R14 Customer {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}, admin["cookies"])
    other = _create("customers", {"name": f"R14 Other {TAG}", "phone": "093" + str(secrets.randbelow(10**7)).zfill(7)}, admin["cookies"])
    return {"admin": admin, "manager": manager, "target": target, "customer": customer["id"], "other": other["id"]}


# ---------------------------------------------------------------- R1: the role-flip chain

def test_role_flip_chain_cannot_take_over_a_more_powerful_colleague(staff):
    manager, target = staff["manager"], staff["target"]
    # Step 1 of the chain (re-role to Delivery, whose password reset is exempt) is refused.
    flip = client.patch(f"/api/users/{target['id']}", json={"role": "Delivery"}, cookies=manager["cookies"])
    assert flip.status_code == 403 and "role" in flip.text, flip.text
    # The direct takeover stays refused too.
    reset = client.patch(f"/api/users/{target['id']}", json={"password": "AnotherPassword123!"}, cookies=manager["cookies"])
    assert reset.status_code == 403, reset.text
    # A colleague whose every grant the manager also holds can still be re-roled.
    weak = _create_user(staff["admin"], "weak", "Employee", {"customers": ["view"]})
    ok = client.patch(f"/api/users/{weak['id']}", json={"role": "Delivery"}, cookies=manager["cookies"])
    assert ok.status_code == 200, ok.text
    assert ok.json()["role"] == "Delivery"
    # An office manager re-roles a driver created from the driver template (own-scope grants,
    # viewOwn covered by the manager's view) — the everyday case must keep working.
    office = _create_user(staff["admin"], "office", "Employee", {
        "users": ["view", "changeRole"], "deliveries": ["view", "assign", "accept", "markCollected"],
        "ads": ["view"], "customers": ["view", "viewContacts"]})
    driver = _create_user(staff["admin"], "tpl-driver", "Delivery", {
        "deliveries": ["viewOwn", "accept", "complete", "markCollected"], "ads": ["viewOwn"], "customers": ["viewOwn", "viewContacts"]})
    reroled = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee"}, cookies=office["cookies"])
    assert reroled.status_code == 200, reroled.text


# ---------------------------------------------------------------- R3: the cleanup route keeps the money trail

def test_audit_cleanup_route_keeps_protected_actions(staff):
    old_ts = now_ms() - 400 * 24 * 60 * 60 * 1000
    keep_id, drop_id = new_id("audit"), new_id("audit")
    with db_conn() as conn:
        for row_id, action in ((keep_id, "close"), (drop_id, "login")):
            conn.execute(
                text("INSERT INTO audit_logs (id, ts, user_id, action, resource_type, resource_id, message, metadata_json) "
                     "VALUES (:id, :ts, :uid, :action, 'system', :rid, 'r14', '{}')"),
                {"id": row_id, "ts": old_ts, "uid": staff["admin"]["id"], "action": action, "rid": f"r14-{TAG}"},
            )
    response = client.post("/api/audit/cleanup", json={"days_to_keep": 30}, cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text
    with db_conn() as conn:
        left = {r["id"] for r in conn.execute(text("SELECT id FROM audit_logs WHERE id IN (:a, :b)"), {"a": keep_id, "b": drop_id}).mappings()}
    assert keep_id in left and drop_id not in left, left     # before: the month-close row was erased too


# ---------------------------------------------------------------- R4: stop / transfer only what you can see

def test_view_own_plus_stop_ad_cannot_stop_another_users_ad(staff):
    admin = staff["admin"]
    created = client.post("/api/ads/mutate", json={"action": "create", "adId": f"r14_ad_{TAG}", "idempotencyKey": f"r14-ad-create-{TAG}",
                                                   "data": {"customerId": staff["customer"], "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                                                            "exchangeRate": 10, "amountUSD": 10, "status": "Active"}}, cookies=admin["cookies"])
    assert created.status_code == 200, created.text
    ad = created.json()["ad"] if "ad" in created.json() else created.json()
    stopper = _create_user(admin, "stopper", "Employee", {"ads": ["viewOwn", "stopAd"], "customers": ["view"]})
    body = {"spentMinorUSD": 500, "expectedLastModified": ad["lastModified"], "idempotencyKey": f"r14-stop-{TAG}"}
    denied = client.post(f"/api/ads/{ad['id']}/stop", json=body, cookies=stopper["cookies"])
    assert denied.status_code == 403, denied.text           # before: 200 — any ad id could be stopped
    assert client.get(f"/api/collections/ads/{ad['id']}", cookies=admin["cookies"]).json()["data"]["status"] == "Active"


def test_view_own_plus_transfer_cannot_move_money_off_another_users_receipt(staff):
    admin = staff["admin"]
    receipt = _create("receipts", {"customerId": staff["customer"], "amountUSD": 100, "amountLocal": 500, "exchangeRate": 5,
                                   "status": "Paid", "isPaid": True}, admin["cookies"], f"r14_rcpt_{TAG}")
    mover = _create_user(admin, "mover", "Employee", {"receipts": ["viewOwn", "transfer"], "customers": ["view"]})
    denied = client.post("/api/receipts/transfers", json={
        "sourceReceiptId": receipt["id"], "targetCustomerId": staff["other"], "targetReceiptId": f"r14_in_{TAG}",
        "amountMinorUSD": 2000, "idempotencyKey": f"r14-transfer-{TAG}", "expectedSourceLastModified": receipt["lastModified"],
    }, cookies=mover["cookies"])
    assert denied.status_code == 403, denied.text           # before: 200 — $20 moved off a receipt the employee cannot see
    assert client.get(f"/api/collections/receipts/r14_in_{TAG}", cookies=admin["cookies"]).status_code == 404


# ---------------------------------------------------------------- R6: delivery watermarks for other grants

def test_driver_with_an_extra_grant_gets_that_collections_watermark(staff):
    driver = _create_user(staff["admin"], "driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"], "pages": ["view"]})
    marks = client.get("/api/sync/watermarks", cookies=driver["cookies"])
    assert marks.status_code == 200, marks.text
    watermarks = marks.json()["watermarks"]
    assert "pages" in watermarks and "receipts" in watermarks, watermarks   # before: pages was skipped (full reload every tick)
    assert "users" not in watermarks


# ---------------------------------------------------------------- A1 / A10: Ads Studio

@pytest.fixture(scope="module")
def studio_actors():
    # Own reviewer with a per-run email: importing the studio module's fixture re-created its
    # fixed users (409) when both modules ran in the same session.
    init_db()
    _studio_ensure_admin()
    admin = _studio_login(STUDIO_ADMIN_EMAIL, STUDIO_ADMIN_PASSWORD)
    email, password = f"r14-reviewer-{TAG}@tests.albayanhub.com", f"R14Reviewer{TAG}123!"
    reviewer = _studio_create_user(admin, email, password, REVIEWER_PERMISSIONS)
    return {"admin": admin, "reviewer": _studio_login(email, password), "reviewer_id": reviewer["id"]}


def test_staff_must_choose_the_refund_when_closing_a_launched_campaign(studio_actors):
    user, cookies = _fresh_funded_customer(studio_actors, f"r14close{TAG}", 2500)
    approved = _approved_campaign(studio_actors, cookies, f"r14close{TAG}", 2500)
    cid = approved["id"]
    marked = _publish_status(studio_actors["reviewer"], cid, approved["lastModified"], f"r14-pub-{TAG}", "live", meta_id="987654321")
    assert marked.status_code == 200, marked.text
    last_modified = marked.json()["lastModified"]
    blind = _stop_campaign(studio_actors["reviewer"], cid, last_modified, f"r14-stop-blind-{TAG}", reason="ran to the end")
    assert blind.status_code == 400 and "refundMinorUSD is required" in blind.text, blind.text   # before: the whole $25 came back
    assert _balance_minor(studio_actors, user["id"]) == 0
    closed = _stop_campaign(studio_actors["reviewer"], cid, last_modified, f"r14-stop-close-{TAG}", reason="ran to the end", refund=0)
    assert closed.status_code == 200, closed.text
    data = closed.json()["data"]
    assert data["status"] == "Stopped" and data["refundMinorUSD"] == 0 and data["spendMinorUSD"] == 2500, data
    assert _balance_minor(studio_actors, user["id"]) == 0


def test_approving_a_campaign_whose_dates_passed_is_a_clear_409(studio_actors):
    user, cookies = _fresh_funded_customer(studio_actors, f"r14late{TAG}", 2500)
    cid = f"r14_late_{TAG}"
    created = _create_campaign(cookies, dict(_complete_campaign(f"Late {TAG}")), cid)
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, cid, created.json()["lastModified"], f"r14-late-submit-{TAG}")
    assert submitted.status_code == 200, submitted.text
    with db_conn() as conn:  # the request waited so long that both dates passed
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='adCampaignRequests' AND id=:id"), {"id": cid}).mappings().first()
        data = json_loads(row["data_json"]) or {}
        data.update({"startDate": "2026-01-05", "endDate": "2026-01-09"})
        # A request sent before P1 (no schemaVersion 2) keeps this old date rule (P1-18(a)); one
        # sent from P1 on keeps its days and starts on approval day instead (P1-11).
        data["schemaVersion"] = 1
        data.pop("totalBudgetMinorUSD", None)
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type='adCampaignRequests' AND id=:id"), {"d": json_dumps(data), "id": cid})
    decision = _review_campaign(studio_actors, cid, submitted.json()["lastModified"], "Approved", f"r14-late-approve-{TAG}")
    assert decision.status_code == 409 and "dates have passed" in decision.text, decision.text   # before: 400 "startDate cannot be in the past"
