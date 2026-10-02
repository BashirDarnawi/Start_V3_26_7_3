"""F-cover: company funds cover FINISHED ads only, and come back when an
already-covered ad ends below its coverage.

Real routes throughout. A "legacy" state (coverage recorded while the ad was
still running) can no longer be produced by the routes, so those cases write
the stored shape directly, exactly as the old code saved it.
"""

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
EMAIL = "coverage-stop-admin@tests.albayanhub.com"
PASSWORD = "CoverageStopAdmin123!Secure"
BUDGET = "The ad budget cannot go below the company funds already recorded on it"
# The one refusal of the return rule (a returned cent would become customer debt on a receipt the ad is not tied to).
MOVED = ("Company money on this ad cannot be returned automatically: it sits on a receipt that is still unpaid. "
         "Settle that receipt first, or keep the spend at or above the company amount")


@pytest.fixture(scope="module")
def admin():
    init_db()
    hashed = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        if not conn.execute(text("SELECT id FROM users WHERE lower(email)=lower(:e)"), {"e": EMAIL}).first():
            conn.execute(text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) VALUES "
                "(:id,'Coverage Stop Admin',:email,'Admin',:perm,:hash,:salt,:algo,:it,false,:now,NULL,:now)"),
                {"id": new_id("user"), "email": EMAIL, "perm": json_dumps({}), "hash": hashed.hash_hex,
                 "salt": hashed.salt_hex, "algo": hashed.algo, "it": hashed.iterations, "now": now})
    response = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _phone(value):
    return f"09{int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], 'big') % 100_000_000:08d}"


def _create(collection, entity_id, data, admin):
    response = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=admin)
    assert response.status_code == 200, response.text
    return response.json()


def _get(collection, entity_id, admin):
    response = client.get(f"/api/collections/{collection}/{entity_id}", cookies=admin)
    assert response.status_code == 200, response.text
    return response.json()


def _customer(customer_id, admin):
    return _create("customers", customer_id, {"name": customer_id, "phones": [_phone(customer_id)]}, admin)


def _unpaid_receipt(receipt_id, customer_id, amount, admin):
    return _create("receipts", receipt_id, {
        "recordType": "receipt", "customerId": customer_id, "amountUSD": amount, "amountLocal": amount * 5,
        "debtAmountUSD": amount, "debtAmountLocal": amount * 5, "exchangeRate": 5, "status": "Not Paid",
        "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}, admin)


def _mutate(action, ad_id, data, key, admin, expected=None):
    body = {"action": action, "adId": ad_id, "idempotencyKey": key, "data": data}
    if expected is not None:
        body["expectedLastModified"] = expected
    return client.post("/api/ads/mutate", json=body, cookies=admin)


def _manual_ad(ad_id, customer_id, amount, admin):
    response = _mutate("create", ad_id, {
        "customerId": customer_id, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5,
        "collectionPayments": [{"method": "Cash (USD)", "amount": amount, "rate": 1, "rate2": 1}]}, f"{ad_id}-create", admin)
    assert response.status_code == 200, response.text
    return response.json()["ad"]


def _due_ad(ad_id, customer_id, receipt_id, due, admin):
    response = _mutate("create", ad_id, {
        "customerId": customer_id, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5,
        "receiptId": receipt_id, "dueAllocations": [{"receiptId": receipt_id, "amountUSD": due}],
        "receiptAllocations": []}, f"{ad_id}-create", admin)
    assert response.status_code == 200, response.text
    return response.json()["ad"]


def _stop(ad_id, spent_minor, key, expected, admin):
    return client.post(f"/api/ads/{ad_id}/stop", json={
        "spentMinorUSD": spent_minor, "customerInformed": True, "idempotencyKey": key,
        "expectedLastModified": expected}, cookies=admin)


def _cover_customer(customer_id, amount_minor, expected_minor, key, admin):
    return client.post(f"/api/customers/{customer_id}/company-coverages", json={
        "amountMinorUSD": amount_minor, "idempotencyKey": key, "expectedOutstandingMinorUSD": expected_minor,
        "reason": "Company absorbs the debt"}, cookies=admin)


def _cover_receipt(receipt_id, amount_minor, key, expected, admin):
    return client.post(f"/api/receipts/{receipt_id}/company-coverages", json={
        "amountMinorUSD": amount_minor, "idempotencyKey": key, "expectedLastModified": expected,
        "reason": "Company absorbs the debt"}, cookies=admin)


def _legacy_patch(collection, entity_id, patch):
    """Write the stored shape the OLD code produced (coverage on a running ad)."""
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type=:t AND id=:id"),
                           {"t": collection, "id": entity_id}).mappings().first()
        data = json_loads(row["data_json"])
        data.update(patch)
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type=:t AND id=:id"),
                     {"d": json_dumps(data), "t": collection, "id": entity_id})


def _releases(ad_id):
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type='receiptCompanyCoverages'")).mappings().all()
    found = [json_loads(row["data_json"]) for row in rows]
    return [row for row in found if row.get("entryType") == "release" and row.get("adId") == ad_id]


def _cents(value):
    return round(float(value or 0) * 100)


def _pool(ad):
    return sum(_cents(row["amountUSD"]) for row in ad.get("companyFundingAllocations") or []) + _cents(ad.get("companyDirectCoverageUSD"))


# 1 -------------------------------------------------------------------------
def test_running_ad_offers_nothing_and_becomes_coverable_at_its_real_spend(admin):
    _customer("cstop_c1", admin)
    ad = _manual_ad("cstop_a1", "cstop_c1", 100, admin)
    assert ad["data"]["status"] == "Active"
    assert _cover_customer("cstop_c1", 10000, 10000, "cstop-a1-cover-old", admin).status_code == 409
    assert _cover_customer("cstop_c1", 100, 0, "cstop-a1-cover-zero", admin).status_code == 409
    explain = client.get("/api/admin/company-coverage/customer-explain/cstop_c1", cookies=admin).json()
    assert explain["coverableAdDebtUSD"] == 0
    assert explain["ads"][0]["reason"] == "ad_active_has_not_finished_spending"
    assert _pool(_get("ads", "cstop_a1", admin)["data"]) == 0

    stopped = _stop("cstop_a1", 9987, "cstop-a1-stop", ad["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    covered = _cover_customer("cstop_c1", 9987, 9987, "cstop-a1-cover-real", admin)
    assert covered.status_code == 200, covered.text
    assert covered.json()["updatedAds"][0]["data"]["companyDirectCoverageUSD"] == 99.87
    assert _releases("cstop_a1") == []


# 2 -------------------------------------------------------------------------
def test_legacy_direct_coverage_comes_back_when_the_ad_stops_lower(admin):
    _customer("cstop_c2", admin)
    ad = _manual_ad("cstop_a2", "cstop_c2", 100, admin)
    _legacy_patch("ads", "cstop_a2", {"companyDirectCoverageUSD": 100.0})

    stopped = _stop("cstop_a2", 9987, "cstop-a2-stop", ad["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    saved = stopped.json()["ad"]["data"]
    assert saved["status"] == "Stopped" and saved["spentUSD"] == 99.87
    assert saved["companyDirectCoverageUSD"] == 99.87
    assert stopped.json()["updatedReceipts"] == []
    releases = _releases("cstop_a2")
    assert len(releases) == 1
    assert releases[0]["amountMinorUSD"] == -13 and releases[0]["releasedUSD"] == 0.13 and "amountUSD" not in releases[0]
    assert releases[0]["coverageScope"] == "customer_ads" and releases[0]["trigger"] == "stop"
    assert releases[0]["adCompanyPoolBeforeMinorUSD"] == 10000 and releases[0]["adCompanyPoolAfterMinorUSD"] == 9987
    assert releases[0]["customerPayment"] is False and releases[0]["countsAsCustomerRevenue"] is False

    replay = _stop("cstop_a2", 9987, "cstop-a2-stop", ad["lastModified"], admin)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert len(_releases("cstop_a2")) == 1
    # Nothing left to cover and nothing owed: spend 99.87 = company 99.87.
    assert client.get("/api/admin/company-coverage/customer-explain/cstop_c2", cookies=admin).json()["coverableAdDebtUSD"] == 0

    # A later correction UP never takes company money again on its own: the
    # extra 0.13 is customer debt the admin may cover with a new decision.
    fresh = _get("ads", "cstop_a2", admin)
    again = _stop("cstop_a2", 10000, "cstop-a2-restop", fresh["lastModified"], admin)
    assert again.status_code == 200, again.text
    assert again.json()["ad"]["data"]["companyDirectCoverageUSD"] == 99.87
    assert len(_releases("cstop_a2")) == 1
    assert client.get("/api/admin/company-coverage/customer-explain/cstop_c2", cookies=admin).json()["coverableAdDebtUSD"] == 0.13


# 3 -------------------------------------------------------------------------
def test_receipt_coverage_of_a_running_ad_comes_back_on_stop(admin):
    _customer("cstop_c3", admin)
    receipt = _unpaid_receipt("cstop_r3", "cstop_c3", 100, admin)
    ad = _due_ad("cstop_a3", "cstop_c3", "cstop_r3", 100, admin)
    # Covering the RECEIPT's debt is unchanged, running ad or not.
    covered = _cover_receipt("cstop_r3", 10000, "cstop-r3-cover", receipt["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    ad = covered.json()["updatedAds"][0]
    assert ad["data"]["status"] == "Active"
    assert ad["data"]["companyFundingAllocations"] == [{"receiptId": "cstop_r3", "amountUSD": 100.0}]
    coverage_id = covered.json()["coverage"]["id"]

    stopped = _stop("cstop_a3", 9987, "cstop-a3-stop", ad["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    saved = stopped.json()["ad"]["data"]
    assert saved["spentUSD"] == 99.87 and saved["dueAllocations"] == []
    assert saved["companyFundingAllocations"] == [{"receiptId": "cstop_r3", "amountUSD": 99.87}]
    assert saved["companyFundedUSD"] == 99.87
    assert [row["id"] for row in stopped.json()["updatedReceipts"]] == ["cstop_r3"]
    after = _get("receipts", "cstop_r3", admin)["data"]
    # The receipt itself (the customer's promise) is untouched; only the
    # company's share shrinks, so the customer owes the unspent 0.13 again.
    assert after["amountUSD"] == 100 and after["debtAmountUSD"] == 100 and after["amountLocal"] == 500
    assert after["status"] == "Not Paid" and after["isPaid"] is False
    assert after["companyCoveredUSD"] == 99.87
    assert after["customerOutstandingUSD"] == 0.13
    assert after["companyCoverageCount"] == 1 and after["lastCompanyCoverageId"] == coverage_id
    releases = _releases("cstop_a3")
    assert len(releases) == 1
    assert releases[0]["amountMinorUSD"] == -13 and releases[0]["receiptId"] == "cstop_r3"
    assert releases[0]["relatedCoverageId"] == coverage_id
    assert releases[0]["companyCoveredBeforeMinorUSD"] == 10000 and releases[0]["companyCoveredAfterMinorUSD"] == 9987
    import server.main as main
    snapshot = _get("receipts", "cstop_r3", admin)
    main.backfill_repair_legacy_unpaid_receipt_overgrowth()   # what a restart runs: a hand-written receipt is never shrunk
    assert _get("receipts", "cstop_r3", admin) == snapshot
    replay = _stop("cstop_a3", 9987, "cstop-a3-stop", ad["lastModified"], admin)
    assert replay.json()["replayed"] is True and len(_releases("cstop_a3")) == 1
    assert [row["id"] for row in replay.json()["updatedReceipts"]] == ["cstop_r3"]
    # conservation: receipt's company share == company money on its ads
    assert _cents(after["companyCoveredUSD"]) == _pool(saved) == 9987
    # the 0.13 that came back is ordinary receipt debt: coverable again by a NEW decision
    fresh = _get("receipts", "cstop_r3", admin)
    again = _cover_receipt("cstop_r3", 13, "cstop-r3-cover-rest", fresh["lastModified"], admin)
    assert again.status_code == 200, again.text
    assert again.json()["coverage"]["data"]["unassignedAmountMinorUSD"] == 13


# 3b ------------------------------------------------------------------------
def test_finished_ad_covered_through_the_routes_then_corrected_lower(admin):
    _customer("cstop_c3b", admin)
    receipt = _unpaid_receipt("cstop_r3b", "cstop_c3b", 100, admin)
    ad = _due_ad("cstop_a3b", "cstop_c3b", "cstop_r3b", 100, admin)
    stopped = _stop("cstop_a3b", 10000, "cstop-a3b-stop", ad["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    covered = _cover_receipt("cstop_r3b", 4000, "cstop-r3b-cover", receipt["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    ad = covered.json()["updatedAds"][0]
    assert ad["data"]["dueAllocations"] == [{"receiptId": "cstop_r3b", "amountUSD": 60.0}]

    # 80 real spend: company 40 stays whole, customer share 60 -> 40. No release.
    at80 = _stop("cstop_a3b", 8000, "cstop-a3b-80", ad["lastModified"], admin)
    assert at80.status_code == 200, at80.text
    assert at80.json()["ad"]["data"]["dueAllocations"] == [{"receiptId": "cstop_r3b", "amountUSD": 40.0}]
    assert _releases("cstop_a3b") == []
    assert _get("receipts", "cstop_r3b", admin)["data"]["companyCoveredUSD"] == 40

    # 30 real spend: below the company's 40 -> 10 comes back.
    at30 = _stop("cstop_a3b", 3000, "cstop-a3b-30", at80.json()["ad"]["lastModified"], admin)
    assert at30.status_code == 200, at30.text
    saved = at30.json()["ad"]["data"]
    assert saved["dueAllocations"] == []
    assert saved["companyFundingAllocations"] == [{"receiptId": "cstop_r3b", "amountUSD": 30.0}]
    receipt_after = _get("receipts", "cstop_r3b", admin)["data"]
    assert receipt_after["amountUSD"] == 100 and receipt_after["companyCoveredUSD"] == 30
    assert receipt_after["customerOutstandingUSD"] == 70
    assert [row["amountMinorUSD"] for row in _releases("cstop_a3b")] == [-1000]

    # Correcting back UP to 80: the customer's own baseline (60) funds it;
    # the company's returned 10 does not come back by itself.
    at80b = _stop("cstop_a3b", 8000, "cstop-a3b-80b", at30.json()["ad"]["lastModified"], admin)
    assert at80b.status_code == 200, at80b.text
    saved = at80b.json()["ad"]["data"]
    assert saved["companyFundingAllocations"] == [{"receiptId": "cstop_r3b", "amountUSD": 30.0}]
    assert saved["dueAllocations"] == [{"receiptId": "cstop_r3b", "amountUSD": 50.0}]
    assert len(_releases("cstop_a3b")) == 1


# 4 -------------------------------------------------------------------------
def test_budget_cannot_be_lowered_below_recorded_company_funds(admin):
    _customer("cstop_c4", admin)
    ad = _manual_ad("cstop_a4", "cstop_c4", 100, admin)
    _legacy_patch("ads", "cstop_a4", {"companyDirectCoverageUSD": 100.0})
    lowered = _mutate("update", "cstop_a4", {
        "collectionMethod": "", "collectionPayments": [{"method": "Cash (USD)", "amount": 50, "rate": 1, "rate2": 1}]},
        "cstop-a4-lower", admin, ad["lastModified"])
    assert lowered.status_code == 409, lowered.text
    assert lowered.json()["detail"].startswith(BUDGET)
    assert _get("ads", "cstop_a4", admin)["data"]["amountUSD"] == 100
    # Unrelated edits and raising the budget still work.
    note = _mutate("update", "cstop_a4", {"notes": "hello"}, "cstop-a4-note", admin, ad["lastModified"])
    assert note.status_code == 200, note.text
    raised = _mutate("update", "cstop_a4", {
        "collectionMethod": "", "collectionPayments": [{"method": "Cash (USD)", "amount": 120, "rate": 1, "rate2": 1}]},
        "cstop-a4-raise", admin, note.json()["ad"]["lastModified"])
    assert raised.status_code == 200, raised.text
    assert raised.json()["ad"]["data"]["amountUSD"] == 120
    # The way out is the stop, at any real figure.
    stopped = _stop("cstop_a4", 5000, "cstop-a4-stop", raised.json()["ad"]["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["ad"]["data"]["companyDirectCoverageUSD"] == 50
    assert [row["amountMinorUSD"] for row in _releases("cstop_a4")] == [-5000]


def test_ad_already_below_its_coverage_is_not_trapped(admin):
    """Stored data nobody measured: budget 50 under coverage 100 (old edit)."""
    _customer("cstop_c4b", admin)
    ad = _manual_ad("cstop_a4b", "cstop_c4b", 50, admin)
    _legacy_patch("ads", "cstop_a4b", {"companyDirectCoverageUSD": 100.0})
    note = _mutate("update", "cstop_a4b", {"notes": "still editable"}, "cstop-a4b-note", admin, ad["lastModified"])
    assert note.status_code == 200, note.text
    stopped = _stop("cstop_a4b", 5000, "cstop-a4b-stop", note.json()["ad"]["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["ad"]["data"]["companyDirectCoverageUSD"] == 50
    assert [row["amountMinorUSD"] for row in _releases("cstop_a4b")] == [-5000]


# 5 -------------------------------------------------------------------------
def test_partial_refund_of_the_unspent_part_returns_company_money(admin):
    _customer("cstop_c5", admin)
    ad = _manual_ad("cstop_a5", "cstop_c5", 100, admin)
    _legacy_patch("ads", "cstop_a5", {"companyDirectCoverageUSD": 100.0})
    refund = _mutate("update", "cstop_a5", {"refundType": "Partial", "refundAmount": 0.13}, "cstop-a5-refund", admin, ad["lastModified"])
    assert refund.status_code == 200, refund.text
    saved = refund.json()["ad"]["data"]
    assert saved["status"] == "Canceled" and saved["spentUSD"] == 99.87
    assert saved["companyDirectCoverageUSD"] == 99.87
    releases = _releases("cstop_a5")
    assert [(row["amountMinorUSD"], row["trigger"]) for row in releases] == [(-13, "refund")]
    # Marking the same refund as Refunded moves no money and books nothing.
    resave = _mutate("update", "cstop_a5", {"refundType": "Partial", "refundAmount": 0.13, "refundStatus": "Refunded"},
                     "cstop-a5-resave", admin, refund.json()["ad"]["lastModified"])
    assert resave.status_code == 200, resave.text
    assert resave.json()["ad"]["data"]["companyDirectCoverageUSD"] == 99.87
    assert len(_releases("cstop_a5")) == 1


def test_refund_changes_and_undo_never_take_company_money_back_by_themselves(admin):
    _customer("cstop_c5u", admin)
    ad = _manual_ad("cstop_a5u", "cstop_c5u", 100, admin)
    _legacy_patch("ads", "cstop_a5u", {"companyDirectCoverageUSD": 100.0})
    first = _mutate("update", "cstop_a5u", {"refundType": "Partial", "refundAmount": 0.13}, "cstop-a5u-1", admin, ad["lastModified"])
    assert first.status_code == 200, first.text
    bigger = _mutate("update", "cstop_a5u", {"refundType": "Partial", "refundAmount": 5}, "cstop-a5u-2", admin, first.json()["ad"]["lastModified"])
    assert bigger.status_code == 200, bigger.text
    assert bigger.json()["ad"]["data"]["spentUSD"] == 95 and bigger.json()["ad"]["data"]["companyDirectCoverageUSD"] == 95
    assert sorted(row["amountMinorUSD"] for row in _releases("cstop_a5u")) == [-487, -13]
    undo = _mutate("update", "cstop_a5u", {"refundType": "None"}, "cstop-a5u-3", admin, bigger.json()["ad"]["lastModified"])
    assert undo.status_code == 200, undo.text
    saved = undo.json()["ad"]["data"]
    assert saved["status"] == "Active" and saved["amountUSD"] == 100
    assert saved["companyDirectCoverageUSD"] == 95          # the returned 5.00 stays returned
    assert len(_releases("cstop_a5u")) == 2
    # running again: its unfunded 5.00 is customer debt, offered only once the ad is final
    assert client.get("/api/admin/company-coverage/customer-explain/cstop_c5u", cookies=admin).json()["coverableAdDebtUSD"] == 0


def test_full_refund_of_a_receipt_covered_ad_returns_all_company_money(admin):
    _customer("cstop_c5b", admin)
    _unpaid_receipt("cstop_r5b", "cstop_c5b", 100, admin)
    ad = _due_ad("cstop_a5b", "cstop_c5b", "cstop_r5b", 100, admin)
    _legacy_patch("ads", "cstop_a5b", {
        "dueAllocations": [{"receiptId": "cstop_r5b", "amountUSD": 60.0}], "dueAmountToUseUSD": 60.0,
        "companyFundingAllocations": [{"receiptId": "cstop_r5b", "amountUSD": 40.0}], "companyFundedUSD": 40.0})
    _legacy_patch("receipts", "cstop_r5b", {"companyCoveredUSD": 40.0, "customerOutstandingUSD": 60.0, "companyCoverageCount": 1})
    refund = _mutate("update", "cstop_a5b", {"refundType": "Full"}, "cstop-a5b-refund", admin, ad["lastModified"])
    assert refund.status_code == 200, refund.text
    saved = refund.json()["ad"]["data"]
    assert saved["spentUSD"] == 0 and saved["dueAllocations"] == [] and _pool(saved) == 0
    assert [row["id"] for row in refund.json()["updatedReceipts"]] == ["cstop_r5b"]
    receipt = _get("receipts", "cstop_r5b", admin)["data"]
    assert receipt["companyCoveredUSD"] == 0 and receipt["customerOutstandingUSD"] == 100
    assert [row["amountMinorUSD"] for row in _releases("cstop_a5b")] == [-4000]


# 6 -------------------------------------------------------------------------
def test_grown_receipt_shrinks_with_the_released_company_share(admin):
    """Server-grown receipt debt follows the ad: gross and coverage drop together."""
    _customer("cstop_c6", admin)
    receipt = _unpaid_receipt("cstop_r6", "cstop_c6", 100, admin)
    _due_ad("cstop_a6a", "cstop_c6", "cstop_r6", 100, admin)
    grown = _mutate("create", "cstop_a6b", {
        "customerId": "cstop_c6", "paymentStatus": "not_paid", "collectionMethod": "in_shop", "receiptId": "cstop_r6",
        "receiptAllocations": [], "dueAllocations": [{"receiptId": "cstop_r6", "amountUSD": 50}],
        "unpaidReceiptDebtIncrease": {"receiptId": "cstop_r6", "amountUSD": 50, "expectedLastModified": receipt["lastModified"]}},
        "cstop-a6b-create", admin)
    assert grown.status_code == 200, grown.text
    fresh = _get("receipts", "cstop_r6", admin)
    assert fresh["data"]["amountUSD"] == 150
    covered = _cover_receipt("cstop_r6", 13000, "cstop-r6-cover", fresh["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    ad_b = next(row for row in covered.json()["updatedAds"] if row["id"] == "cstop_a6b")
    assert ad_b["data"]["dueAllocations"] == [{"receiptId": "cstop_r6", "amountUSD": 20.0}]
    assert ad_b["data"]["companyFundingAllocations"] == [{"receiptId": "cstop_r6", "amountUSD": 30.0}]

    stopped = _stop("cstop_a6b", 1000, "cstop-a6b-stop", ad_b["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    saved = stopped.json()["ad"]["data"]
    assert saved["dueAllocations"] == [] and saved["companyFundingAllocations"] == [{"receiptId": "cstop_r6", "amountUSD": 10.0}]
    after = _get("receipts", "cstop_r6", admin)["data"]
    # ads now hold 100 (a) + 10 (b) of company money: the grown 50 shrinks to 10.
    assert after["amountUSD"] == after["debtAmountUSD"] == 110
    assert after["companyCoveredUSD"] == 110 and after["customerOutstandingUSD"] == 0
    assert [row["id"] for row in stopped.json()["updatedReceipts"]] == ["cstop_r6"]
    assert [row["amountMinorUSD"] for row in _releases("cstop_a6b")] == [-2000]


def test_fully_covered_grown_receipt_follows_the_release_without_waiting_for_a_restart(admin):
    import server.main as main
    _customer("cstop_c6g", admin)
    receipt = _create("receipts", "cstop_r6g", {
        "recordType": "receipt", "customerId": "cstop_c6g", "amountUSD": 0, "amountLocal": 0, "exchangeRate": 5,
        "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}, admin)
    made = _mutate("create", "cstop_a6g", {
        "customerId": "cstop_c6g", "paymentStatus": "not_paid", "collectionMethod": "in_shop", "receiptId": "cstop_r6g",
        "receiptAllocations": [], "dueAllocations": [{"receiptId": "cstop_r6g", "amountUSD": 100}],
        "unpaidReceiptDebtIncrease": {"receiptId": "cstop_r6g", "amountUSD": 100, "expectedLastModified": receipt["lastModified"]}},
        "cstop-a6g-create", admin)
    assert made.status_code == 200, made.text
    fresh = _get("receipts", "cstop_r6g", admin)
    covered = _cover_receipt("cstop_r6g", 10000, "cstop-r6g-cover", fresh["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    stopped = _stop("cstop_a6g", 9987, "cstop-a6g-stop", covered.json()["updatedAds"][0]["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    assert [row["id"] for row in stopped.json()["updatedReceipts"]] == ["cstop_r6g"]
    after = _get("receipts", "cstop_r6g", admin)
    # The receipt existed only for this ad's budget, so it follows the real spend at once.
    assert after["data"]["amountUSD"] == 99.87 and after["data"]["amountLocal"] == 499.35
    assert after["data"]["companyCoveredUSD"] == 99.87 and after["data"]["customerOutstandingUSD"] == 0
    # ... and what a restart runs finds nothing left to repair.
    main.backfill_repair_legacy_unpaid_receipt_overgrowth()
    assert _get("receipts", "cstop_r6g", admin) == after


def _driver_ad(tag, admin):
    """A rowless $100 driver ad on its $100 pending delivery receipt; the company covers 40 through the receipt."""
    c, r, a = f"cstop_c{tag}", f"cstop_r{tag}", f"cstop_a{tag}"
    _customer(c, admin)
    made = client.post("/api/users", json={"name": "Coverage Stop Driver", "email": "coverage-stop-driver@tests.albayanhub.com",
                       "password": "CoverageStopDriver123!Secure", "role": "Delivery",
                       "permissions": {"deliveries": ["view", "accept", "complete"]}}, cookies=admin)
    assert made.status_code in {200, 409}, made.text
    driver_id = next(u["id"] for u in client.get("/api/users", cookies=admin).json()
                     if u["email"] == "coverage-stop-driver@tests.albayanhub.com")
    receipt = _create("receipts", r, {"deliveryPersonId": driver_id,
        "recordType": "receipt", "customerId": c, "amountUSD": 100, "amountLocal": 500,
        "debtAmountUSD": 100, "debtAmountLocal": 500, "exchangeRate": 5, "status": "Not Paid", "isPaid": False,
        "deliveryStatus": "In Progress", "statusDetail": {"notPaidCollection": "delivery"}}, admin)
    stamp = now_ms()
    ad_data = {"id": a, "recordType": "ad", "customerId": c, "paymentStatus": "not_paid", "isPaid": False,
               "collectionMethod": "driver", "linkedDeliveryReceiptId": r, "receiptId": r,
               "amountUSD": 100.0, "amountLocal": 500.0, "exchangeRate": 5, "status": "Active", "dueAllocations": [],
               "receiptAllocations": [], "_created": stamp, "_lastModified": stamp, "_deleted": False}
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:i,:d,false,:s,NULL,:s)"), {"i": a, "d": json_dumps(ad_data), "s": stamp})
    covered = _cover_receipt(r, 4000, f"{r}-cover", receipt["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    ad = covered.json()["updatedAds"][0]
    assert ad["data"]["companyFundingAllocations"] == [{"receiptId": r, "amountUSD": 40.0}]
    assert _receipt_figures(r, admin) == ("Not Paid", 100, 40, 60) and _ledger(c) == 4000
    return c, r, a


def test_driver_ad_on_a_pending_delivery_receipt_returns_company_money_only_after_it_is_settled(admin):
    """(repair 4: the RULE) Was: stop 25 -> 200 with the receipt at covered 25 / outstanding 75 and the ad tied to nothing.

    While the delivery is pending the returned 15 would become debt the driver collects on a receipt the ad's
    baselines are not tied to, so the return is refused; once the receipt is settled the same stop goes through.
    """
    c, r, a = _driver_ad("6d", admin)
    ad = _get("ads", a, admin)
    before = _snapshot(a, r, r, admin)
    refused = _stop(a, 2500, f"{a}-stop", ad["lastModified"], admin)
    assert refused.status_code == 409 and refused.json()["detail"] == MOVED, refused.text
    full = _mutate("update", a, {"refundType": "Full"}, f"{a}-full" + K, admin, ad["lastModified"])
    assert full.status_code == 409 and full.json()["detail"] == MOVED, full.text
    assert _snapshot(a, r, r, admin) == before and _releases(a) == []       # ad, receipt, ledger byte-identical
    _settle(r, admin)                                                         # the driver's 60 is in: nothing is owed on R any more
    assert _receipt_figures(r, admin) == ("Paid", 60, 40, 0)
    d = _step(a, admin, 1, stop=2500)                                         # the SAME stop
    assert d["spentUSD"] == 25 and d["receiptAllocations"] == [] and d["dueAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r, "amountUSD": 25.0}]
    assert _receipt_figures(r, admin) == ("Paid", 60, 25, 0) and _ledger(c) == 2500 == _pool(d)
    assert _get("receipts", r, admin)["data"]["amountLocal"] == 300           # the customer's cash is never edited
    assert [(x["receiptId"], x["amountMinorUSD"], x["trigger"]) for x in _releases(a)] == [(r, -1500, "stop")]
    assert _explain(c, admin) == 0


def test_rowless_driver_ad_covered_then_delivered_still_returns_company_money(admin):
    """The normal driver case: covered 40 while pending, the delivery is settled, THEN the ad ends lower."""
    c, r, a = _driver_ad("6e", admin)
    _settle(r, admin)
    assert _receipt_figures(r, admin) == ("Paid", 60, 40, 0)
    d = _get("ads", a, admin)["data"]
    assert d["receiptAllocations"] == [{"receiptId": r, "amountUSD": 60.0}] and _pool(d) == 4000
    d = _step(a, admin, 1, stop=2500)
    assert d["spentUSD"] == 25 and d["receiptAllocations"] == [] and d["dueAllocations"] == [] and _pool(d) == 2500
    assert _receipt_figures(r, admin) == ("Paid", 60, 25, 0) and _ledger(c) == 2500
    d = _step(a, admin, 2, stop=8000)                                         # correction upward: customer cash 55 + company 25
    assert d["receiptAllocations"] == [{"receiptId": r, "amountUSD": 55.0}] and _pool(d) == 2500 and _explain(c, admin) == 0
    d = _step(a, admin, 3, refund={"refundType": "Full"})
    assert d["spentUSD"] == 0 and _pool(d) == 0 and d["receiptAllocations"] == []
    assert _receipt_figures(r, admin) == ("Paid", 60, 0, 0) and _ledger(c) == 0
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1500, -2500]


def test_closed_month_on_the_covered_receipt_refuses_the_whole_stop(admin):
    period = "2019-05"
    _customer("cstop_c6p", admin)
    receipt = _create("receipts", "cstop_r6p", {
        "recordType": "receipt", "customerId": "cstop_c6p", "amountUSD": 100, "amountLocal": 500, "debtAmountUSD": 100,
        "debtAmountLocal": 500, "exchangeRate": 5, "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office",
        "statusDetail": {"notPaidCollection": "office"}, "date": f"{period}-15"}, admin)
    ad = _due_ad("cstop_a6p", "cstop_c6p", "cstop_r6p", 100, admin)
    covered = _cover_receipt("cstop_r6p", 10000, "cstop-r6p-cover", receipt["lastModified"], admin)
    assert covered.status_code == 200, covered.text
    ad = covered.json()["updatedAds"][0]
    receipt_before = _get("receipts", "cstop_r6p", admin)
    closed = client.post("/api/admin/operations/financial-periods/close",
                         json={"period": period, "forceReason": "coverage release period protection"}, cookies=admin)
    assert closed.status_code == 200, closed.text
    try:
        refused = _stop("cstop_a6p", 9987, "cstop-a6p-stop", ad["lastModified"], admin)
        assert refused.status_code == 423, refused.text
        assert _get("ads", "cstop_a6p", admin) == ad
        assert _get("receipts", "cstop_r6p", admin) == receipt_before
        assert _releases("cstop_a6p") == []
    finally:
        unlocked = client.post(f"/api/admin/operations/financial-periods/{period}/unlock",
                               json={"reason": "restore after coverage release test"}, cookies=admin)
        assert unlocked.status_code == 200, unlocked.text
    assert _stop("cstop_a6p", 9987, "cstop-a6p-stop2", ad["lastModified"], admin).status_code == 200


def test_shrink_company_pool_is_pure_and_never_grows():
    from server.company_debt_coverage import company_pool_total_minor, shrink_company_pool
    ad = {"companyDirectCoverageUSD": 5.0, "companyFundedUSD": 40.0,
          "companyFundingAllocations": [{"receiptId": "a", "amountUSD": 10.0}, {"receiptId": "b", "amountUSD": 30.0}]}
    raw = json_dumps(ad)
    assert shrink_company_pool(ad, 4500) is ad and shrink_company_pool(ad, 99999) is ad      # never grows
    direct_only = shrink_company_pool(ad, 4200)                                               # direct first
    assert direct_only["companyDirectCoverageUSD"] == 2.0 and direct_only["companyFundingAllocations"] == ad["companyFundingAllocations"]
    deep = shrink_company_pool(ad, 1500)                                                      # then last receipt id first
    assert deep["companyDirectCoverageUSD"] == 0.0
    assert deep["companyFundingAllocations"] == [{"receiptId": "a", "amountUSD": 10.0}, {"receiptId": "b", "amountUSD": 5.0}]
    assert deep["companyFundedUSD"] == 15.0 and company_pool_total_minor(deep) == 1500
    assert company_pool_total_minor(shrink_company_pool(ad, 0)) == 0
    assert json_dumps(ad) == raw
    legacy = {"companyDirectCoverageUSD": None, "companyFundingAllocations": [{"receiptId": "a", "amountUSD": 10.0}]}
    assert "companyDirectCoverageUSD" not in {k for k, v in shrink_company_pool(legacy, 500).items() if v is not None and k == "companyDirectCoverageUSD"}


# 7 -------------------------------------------------------------------------
def test_release_on_a_settled_receipt_lowers_its_pot_by_the_same_cents(admin):
    _customer("cstop_c7", admin)
    receipt = _unpaid_receipt("cstop_r7", "cstop_c7", 100, admin)
    ad = _due_ad("cstop_a7", "cstop_c7", "cstop_r7", 100, admin)
    stopped = _stop("cstop_a7", 10000, "cstop-a7-stop", ad["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    assert _cover_receipt("cstop_r7", 4000, "cstop-r7-cover", receipt["lastModified"], admin).status_code == 200
    fresh = _get("receipts", "cstop_r7", admin)
    settled = client.post("/api/receipts/cstop_r7/settle", json={
        "idempotencyKey": "cstop-r7-settle", "expectedLastModified": fresh["lastModified"],
        "data": {"status": "Paid", "isPaid": True}}, cookies=admin)
    assert settled.status_code == 200, settled.text
    paid = _get("receipts", "cstop_r7", admin)["data"]
    assert paid["amountUSD"] == 60 and paid["companyCoveredUSD"] == 40
    ad = _get("ads", "cstop_a7", admin)
    assert ad["data"]["receiptAllocations"] == [{"receiptId": "cstop_r7", "amountUSD": 60.0}]

    restop = _stop("cstop_a7", 3000, "cstop-a7-30", ad["lastModified"], admin)
    assert restop.status_code == 200, restop.text
    saved = restop.json()["ad"]["data"]
    assert saved["receiptAllocations"] == [] and saved["dueAllocations"] == []
    assert saved["companyFundingAllocations"] == [{"receiptId": "cstop_r7", "amountUSD": 30.0}]
    after = _get("receipts", "cstop_r7", admin)["data"]
    # Customer cash is untouched; the company's share of the pot drops 40 -> 30.
    assert after["status"] == "Paid" and after["amountUSD"] == 60 and after["amountLocal"] == 300
    assert after["companyCoveredUSD"] == 30 and after["customerOutstandingUSD"] == 0
    assert [row["amountMinorUSD"] for row in _releases("cstop_a7")] == [-1000]


def test_client_mirror_keeps_the_same_finished_status_list():
    """coverable_ad_debt_detail and getCustomerCoverableAdDebt must stay identical."""
    import re
    from server.company_debt_coverage import FINAL_AD_STATUSES, coverable_ad_debt_detail
    source = (Path(__file__).parent.parent / "src" / "13-filters-helpers.js").read_text(encoding="utf-8")
    body = source.split("function getCustomerCoverableAdDebt(", 1)[1].split("function openCustomerAdDebtCoverageModal", 1)[0]
    found = re.search(r"if \(!\[([^\]]+)\]\.includes\(String\(ad\.status \|\| ''\)\.trim\(\)\.toLowerCase\(\)\)\) return;", body)
    assert found, "the client mirror lost its finished-status gate"
    assert {item.strip().strip("'") for item in found.group(1).split(",")} == set(FINAL_AD_STATUSES)
    ad = {"paymentStatus": "not_paid", "collectionMethod": "in_shop", "amountUSD": 100, "receiptAllocations": [], "dueAllocations": []}
    for status in ("Active", "", None, "Scheduled", " active "):
        assert coverable_ad_debt_detail({**ad, "status": status}) == ("ad_active_has_not_finished_spending", 0)
    for status in ("Pending", "Paused"):
        assert coverable_ad_debt_detail({**ad, "status": status}) == (f"ad_{status.lower()}_has_not_spent_yet", 0)
    assert coverable_ad_debt_detail({**ad, "status": "Stopped", "spentUSD": 99.87}) == ("coverable", 9987)
    assert coverable_ad_debt_detail({**ad, "status": "Stopped", "spentUSD": None}) == ("fully_funded_nothing_left_to_cover", 0)
    assert coverable_ad_debt_detail({**ad, "status": "Completed"}) == ("coverable", 10000)
    assert coverable_ad_debt_detail({**ad, "status": "Cancelled", "spentUSD": 12.5}) == ("coverable", 1250)


# ---- Review additions (tests 17-23 of the final design) ----
K = "-review-key-0001"
def _explain(cid, admin):
    return client.get(f"/api/admin/company-coverage/customer-explain/{cid}", cookies=admin).json()["coverableAdDebtUSD"]

def _grown(cid, rid, aid, amount, admin):
    _customer(cid, admin)
    receipt = _create("receipts", rid, {"recordType": "receipt", "customerId": cid, "amountUSD": 0, "amountLocal": 0, "exchangeRate": 5,
        "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}, admin)
    made = _mutate("create", aid, {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "receiptId": rid,
        "receiptAllocations": [], "dueAllocations": [{"receiptId": rid, "amountUSD": amount}],
        "unpaidReceiptDebtIncrease": {"receiptId": rid, "amountUSD": amount, "expectedLastModified": receipt["lastModified"]}}, f"{aid}-create{K}", admin)
    assert made.status_code == 200, made.text

# 17
def test_correction_upward_after_a_return_puts_the_debt_back_on_the_same_receipt(admin):
    _customer("rv_c17", admin)
    r = _unpaid_receipt("rv_r17", "rv_c17", 100, admin)
    _due_ad("rv_a17", "rv_c17", "rv_r17", 100, admin)
    cov = _cover_receipt("rv_r17", 10000, "rv-r17-c" + K, r["lastModified"], admin); assert cov.status_code == 200, cov.text
    ad = cov.json()["updatedAds"][0]
    s = _stop("rv_a17", 3000, "rv-a17-s1" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    d = s.json()["ad"]["data"]
    assert d["dueAllocations"] == [] and d["companyFundingAllocations"] == [{"receiptId": "rv_r17", "amountUSD": 30.0}]
    assert d["stopAllocationBaseline"]["due"] == [{"receiptId": "rv_r17", "amountUSD": 70.0}]
    rc = _get("receipts", "rv_r17", admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 30, 70)
    assert _explain("rv_c17", admin) == 0
    s2 = _stop("rv_a17", 10000, "rv-a17-s2" + K, s.json()["ad"]["lastModified"], admin); assert s2.status_code == 200, s2.text
    d = s2.json()["ad"]["data"]
    assert d["spentUSD"] == 100 and d["dueAllocations"] == [{"receiptId": "rv_r17", "amountUSD": 70.0}]
    assert d["companyFundingAllocations"] == [{"receiptId": "rv_r17", "amountUSD": 30.0}]
    rc = _get("receipts", "rv_r17", admin)
    assert (rc["data"]["amountUSD"], rc["data"]["companyCoveredUSD"], rc["data"]["customerOutstandingUSD"]) == (100, 30, 70)
    assert len(_releases("rv_a17")) == 1 and _releases("rv_a17")[0]["amountMinorUSD"] == -7000
    # the 70 is ONE debt: not offered as ad debt, coverable once through the receipt
    assert _explain("rv_c17", admin) == 0
    assert _cover_customer("rv_c17", 7000, 7000, "rv-c17-cc" + K, admin).status_code == 409
    again = _cover_receipt("rv_r17", 7000, "rv-r17-c2" + K, rc["lastModified"], admin); assert again.status_code == 200, again.text
    d = _get("ads", "rv_a17", admin)["data"]
    assert d["dueAllocations"] == [] and _pool(d) == 10000
    rc = _get("receipts", "rv_r17", admin)["data"]
    assert (rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 0)

# 18
def test_refund_undo_after_a_return_restores_the_whole_debt_and_the_ad_can_be_stopped(admin):
    _customer("rv_c18", admin)
    r = _unpaid_receipt("rv_r18", "rv_c18", 100, admin)
    _due_ad("rv_a18", "rv_c18", "rv_r18", 100, admin)
    cov = _cover_receipt("rv_r18", 4000, "rv-r18-c" + K, r["lastModified"], admin); assert cov.status_code == 200
    ad = cov.json()["updatedAds"][0]
    f = _mutate("update", "rv_a18", {"refundType": "Full"}, "rv-a18-f" + K, admin, ad["lastModified"]); assert f.status_code == 200, f.text
    d = f.json()["ad"]["data"]
    assert _pool(d) == 0 and d["dueAllocations"] == [] and d["refundDueBaseline"] == [{"receiptId": "rv_r18", "amountUSD": 100.0}]
    u = _mutate("update", "rv_a18", {"refundType": "None"}, "rv-a18-u" + K, admin, f.json()["ad"]["lastModified"]); assert u.status_code == 200, u.text
    d = u.json()["ad"]["data"]
    assert d["status"] == "Active" and d["dueAllocations"] == [{"receiptId": "rv_r18", "amountUSD": 100.0}] and _pool(d) == 0
    rc = _get("receipts", "rv_r18", admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 0, 100)
    s = _stop("rv_a18", 10000, "rv-a18-s" + K, u.json()["ad"]["lastModified"], admin); assert s.status_code == 200, s.text
    assert s.json()["ad"]["data"]["dueAllocations"] == [{"receiptId": "rv_r18", "amountUSD": 100.0}]
    assert _explain("rv_c18", admin) == 0
    assert [x["amountMinorUSD"] for x in _releases("rv_a18")] == [-4000]

# 19
def test_partial_refund_changes_keep_spend_fully_backed(admin):
    _customer("rv_c19", admin)
    r = _unpaid_receipt("rv_r19", "rv_c19", 100, admin)
    _due_ad("rv_a19", "rv_c19", "rv_r19", 100, admin)
    cov = _cover_receipt("rv_r19", 4000, "rv-r19-c" + K, r["lastModified"], admin); assert cov.status_code == 200
    ad = cov.json()["updatedAds"][0]
    f = _mutate("update", "rv_a19", {"refundType": "Partial", "refundAmount": 70}, "rv-a19-f" + K, admin, ad["lastModified"]); assert f.status_code == 200, f.text
    d = f.json()["ad"]["data"]
    assert d["spentUSD"] == 30 and d["dueAllocations"] == [] and _pool(d) == 3000
    assert d["refundDueBaseline"] == [{"receiptId": "rv_r19", "amountUSD": 70.0}]
    f2 = _mutate("update", "rv_a19", {"refundType": "Partial", "refundAmount": 50}, "rv-a19-f2" + K, admin, f.json()["ad"]["lastModified"]); assert f2.status_code == 200, f2.text
    d = f2.json()["ad"]["data"]
    assert d["spentUSD"] == 50 and d["dueAllocations"] == [{"receiptId": "rv_r19", "amountUSD": 20.0}] and _pool(d) == 3000
    assert _explain("rv_c19", admin) == 0          # 20 due + 30 company = 50 spent: nothing unbacked
    rc = _get("receipts", "rv_r19", admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 30, 70)
    assert [x["amountMinorUSD"] for x in _releases("rv_a19")] == [-1000]

# 20
def test_grown_receipt_follows_down_and_back_up(admin):
    _grown("rv_c20", "rv_r20", "rv_a20", 100, admin)
    fr = _get("receipts", "rv_r20", admin)
    cov = _cover_receipt("rv_r20", 10000, "rv-r20-c" + K, fr["lastModified"], admin); assert cov.status_code == 200
    ad = cov.json()["updatedAds"][0]
    s = _stop("rv_a20", 3000, "rv-a20-s1" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    rc = _get("receipts", "rv_r20", admin)["data"]
    assert (rc["amountUSD"], rc["amountLocal"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (30, 150, 30, 0)
    s2 = _stop("rv_a20", 10000, "rv-a20-s2" + K, s.json()["ad"]["lastModified"], admin); assert s2.status_code == 200, s2.text
    d = s2.json()["ad"]["data"]
    assert d["dueAllocations"] == [{"receiptId": "rv_r20", "amountUSD": 70.0}] and _pool(d) == 3000
    rc = _get("receipts", "rv_r20", admin)["data"]
    assert (rc["amountUSD"], rc["amountLocal"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 500, 30, 70)
    assert _explain("rv_c20", admin) == 0

# 21
def test_settled_receipt_gets_no_due_back_and_the_cap_is_the_existing_refusal(admin):
    _customer("rv_c21", admin)
    r = _unpaid_receipt("rv_r21", "rv_c21", 100, admin)
    _due_ad("rv_a21", "rv_c21", "rv_r21", 100, admin)
    assert _cover_receipt("rv_r21", 4000, "rv-r21-c" + K, r["lastModified"], admin).status_code == 200
    fr = _get("receipts", "rv_r21", admin)
    st = client.post("/api/receipts/rv_r21/settle", json={"idempotencyKey": "rv-r21-settle" + K, "expectedLastModified": fr["lastModified"],
        "data": {"status": "Paid", "isPaid": True}}, cookies=admin)
    assert st.status_code == 200, st.text
    a = _get("ads", "rv_a21", admin)
    s = _stop("rv_a21", 3000, "rv-a21-s1" + K, a["lastModified"], admin); assert s.status_code == 200, s.text
    d = s.json()["ad"]["data"]
    assert d["stopAllocationBaseline"]["due"] == [] and d["stopAllocationBaseline"]["receipt"] == [{"receiptId": "rv_r21", "amountUSD": 60.0}]
    up = _stop("rv_a21", 10000, "rv-a21-s2" + K, s.json()["ad"]["lastModified"], admin)
    assert up.status_code == 409 and up.json()["detail"] == "Spent amount exceeds the ad's funding baseline"
    ok = _stop("rv_a21", 9000, "rv-a21-s3" + K, s.json()["ad"]["lastModified"], admin); assert ok.status_code == 200, ok.text
    d = ok.json()["ad"]["data"]
    assert d["receiptAllocations"] == [{"receiptId": "rv_r21", "amountUSD": 60.0}] and _pool(d) == 3000
    rc = _get("receipts", "rv_r21", admin)["data"]
    assert (rc["status"], rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == ("Paid", 60, 30, 0)

# 22
def test_conflicting_paid_markers_never_get_an_outstanding_written(admin):
    _customer("rv_c22", admin)
    r = _unpaid_receipt("rv_r22", "rv_c22", 100, admin)
    _due_ad("rv_a22", "rv_c22", "rv_r22", 100, admin)
    cov = _cover_receipt("rv_r22", 10000, "rv-r22-c" + K, r["lastModified"], admin); assert cov.status_code == 200
    _legacy_patch("receipts", "rv_r22", {"isPaid": True})     # stored: status Not Paid beside isPaid true
    ad = _get("ads", "rv_a22", admin)
    s = _stop("rv_a22", 9987, "rv-a22-s1" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    rc = _get("receipts", "rv_r22", admin)["data"]
    assert rc["companyCoveredUSD"] == 99.87 and rc["customerOutstandingUSD"] == 0
    import server.main as main
    before = _get("receipts", "rv_r22", admin)
    main.backfill_covered_settled_receipts()
    assert _get("receipts", "rv_r22", admin) == before

# 23
def test_restore_released_due_baselines_is_pure_and_narrow():
    from server.company_debt_coverage import restore_released_due_baselines
    live = {"deleted": False, "data": {"status": "Not Paid", "isPaid": False}}
    paid = {"deleted": False, "data": {"status": "Paid", "isPaid": True}}
    gone = {"deleted": True, "data": {"status": "Not Paid", "isPaid": False}}
    rd = lambda row: row["data"]
    before = {"paymentStatus": "not_paid", "collectionMethod": "in_shop", "receiptId": "a",
              "companyFundingAllocations": [{"receiptId": "a", "amountUSD": 40.0}, {"receiptId": "b", "amountUSD": 10.0}]}
    after = {**before, "companyFundingAllocations": [{"receiptId": "a", "amountUSD": 30.0}],
             "stopAllocationBaseline": {"receipt": [], "due": [{"receiptId": "a", "amountUSD": 5.0}], "paymentStatus": "not_paid"}}
    raw = json_dumps(after)
    out = restore_released_due_baselines(before, after, {"a": live, "b": paid}, rd)
    # only the ad's linked receipt ("a"): the 10 returned from the settled "b" is debt nowhere, never a second due receipt
    assert out["stopAllocationBaseline"]["due"] == [{"receiptId": "a", "amountUSD": 15.0}]
    # THE RULE (repair 4): a returned cent that becomes customer debt (live receipt still tracking debt) must be tied
    # back to the ad on that same receipt here; possible only for a Not Paid In-Shop ad on its linked receipt.
    from server.company_debt_coverage import UNTIED_RETURN_REFUSAL, return_company_money, returned_cents_become_customer_debt
    import server.company_debt_coverage as coverage_module
    from fastapi import HTTPException
    assert UNTIED_RETURN_REFUSAL == MOVED
    assert not hasattr(coverage_module, "refuse_return_onto_moved_live_receipt") and not hasattr(coverage_module, "company_rows_off_own_receipts")
    canceled = {"deleted": False, "data": {"status": "Canceled", "isPaid": False}}
    dead_delivery = {"deleted": False, "data": {"status": "Not Paid", "isPaid": False, "deliveryStatus": "Canceled"}}
    transfer = {"deleted": False, "data": {"status": "Not Paid", "isPaid": False, "receiptType": "TRANSFER_IN"}}
    assert returned_cents_become_customer_debt(live, rd(live)) is True
    for dead in (paid, canceled, dead_delivery, transfer, gone):
        assert returned_cents_become_customer_debt(dead, rd(dead)) is False
    assert returned_cents_become_customer_debt(None, None) is False
    for moved in (before, {**before, "receiptId": "b"}, {**before, "receiptId": ""}):
        lower = {**return_company_money(moved, 3000), "stopAllocationBaseline": {"receipt": [], "due": []}}   # takes 10 off "b" and 10 off "a"
        assert lower["companyFundingAllocations"] == [{"receiptId": "a", "amountUSD": 30.0}] and json_dumps(moved) != json_dumps(lower)
        assert return_company_money(moved, 5000) is moved and return_company_money(moved, 99999) is moved   # nothing to return
        off = sorted({"a", "b"} - {moved["receiptId"]})                        # shrinking rows on receipts the ad is not linked to
        with pytest.raises(HTTPException) as refused:
            restore_released_due_baselines(moved, lower, {"a": live, "b": live}, rd)
        assert refused.value.status_code == 409 and refused.value.detail == MOVED
        for dead in (paid, canceled, dead_delivery, transfer, gone, None):     # those receipts track no debt: allowed
            receipts = {"a": live, "b": live, **{receipt_id: dead for receipt_id in off}}
            tied = restore_released_due_baselines(moved, lower, receipts, rd)
            assert tied["companyFundingAllocations"] == lower["companyFundingAllocations"]
            assert tied["stopAllocationBaseline"]["due"] == ([{"receiptId": moved["receiptId"], "amountUSD": 10.0}] if moved["receiptId"] else [])
            # the ad's own state decides whether the debt cents CAN be tied back: a driver or Paid ad cannot
            for variant in ({"collectionMethod": "driver"}, {"paymentStatus": "paid"}):
                if moved["receiptId"]:
                    with pytest.raises(HTTPException):
                        restore_released_due_baselines(moved, {**lower, **variant}, receipts, rd)
                    settled = {**receipts, moved["receiptId"]: paid}                   # ... until that receipt is settled too
                    assert restore_released_due_baselines(moved, {**lower, **variant}, settled, rd)["stopAllocationBaseline"]["due"] == []
        for receipt_id in off:                                                 # one live untied receipt is enough
            with pytest.raises(HTTPException):
                restore_released_due_baselines(moved, lower, {"a": paid, "b": paid, receipt_id: live}, rd)
    linked_b = {**before, "receiptId": "b"}                                    # "a" is live and untied but only "b" (linked) shrinks
    assert restore_released_due_baselines(linked_b, {**return_company_money(linked_b, 4500), "stopAllocationBaseline": {"due": []}},
                                          {"a": live, "b": live}, rd)["companyFundingAllocations"] == [
        {"receiptId": "a", "amountUSD": 40.0}, {"receiptId": "b", "amountUSD": 5.0}]
    own = {**before, "companyFundingAllocations": [{"receiptId": "a", "amountUSD": 40.0}, {"receiptId": "b", "amountUSD": 0}]}
    assert return_company_money(own, 3000)["companyFundingAllocations"] == [{"receiptId": "a", "amountUSD": 30.0}]
    tied = restore_released_due_baselines(own, {**return_company_money(own, 3000), "stopAllocationBaseline": {"due": []}}, {"a": live, "b": live}, rd)
    assert tied["companyFundingAllocations"] == [{"receiptId": "a", "amountUSD": 30.0}]
    assert tied["stopAllocationBaseline"]["due"] == [{"receiptId": "a", "amountUSD": 10.0}]
    with pytest.raises(HTTPException):                                         # no baseline to write to: the debt would be tied to nothing
        restore_released_due_baselines(own, return_company_money(own, 3000), {"a": live, "b": live}, rd)
    for variant in ({"collectionMethod": "driver"}, {"paymentStatus": "paid"}):          # was: returned untied; the rule refuses it
        with pytest.raises(HTTPException) as refused:
            restore_released_due_baselines(before, {**after, **variant}, {"a": live, "b": paid}, rd)
        assert refused.value.detail == MOVED
        assert restore_released_due_baselines(before, {**after, **variant}, {"a": paid, "b": paid}, rd)["stopAllocationBaseline"] == after["stopAllocationBaseline"]
    assert json_dumps(after) == raw and "refundDueBaseline" not in out
    assert restore_released_due_baselines(before, after, {"a": paid, "b": gone}, rd) is after
    assert restore_released_due_baselines(before, after, {}, rd) is after
    assert restore_released_due_baselines(before, before, {"a": live, "b": live}, rd) is before          # nothing released
    refund = {**after, "refundType": "Partial", "refundDueBaseline": [{"receiptId": "a", "amountUSD": 60.0}]}
    out = restore_released_due_baselines(before, refund, {"a": live, "b": paid}, rd)
    assert out["refundDueBaseline"] == [{"receiptId": "a", "amountUSD": 70.0}]


def _ledger(customer_id):
    """Company money booked for one customer: coverage lines minus release lines, in cents."""
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type='receiptCompanyCoverages'")).mappings().all()
    found = [row for row in (json_loads(row["data_json"]) for row in rows) if row.get("customerId") == customer_id]
    return sum(int(row["amountMinorUSD"]) if row.get("amountMinorUSD") is not None else _cents(row.get("amountUSD")) for row in found)


def _receipt_figures(receipt_id, admin):
    rc = _get("receipts", receipt_id, admin)["data"]
    return rc["status"], rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]


def _settle(receipt_id, admin):
    response = client.post(f"/api/receipts/{receipt_id}/settle", json={
        "idempotencyKey": f"{receipt_id}-settle" + K, "expectedLastModified": _get("receipts", receipt_id, admin)["lastModified"],
        "data": {"status": "Paid", "isPaid": True}}, cookies=admin)
    assert response.status_code == 200, response.text


def _cancel_receipt(receipt_id, admin):
    response = client.patch(f"/api/collections/receipts/{receipt_id}", json={
        "data": {"status": "Canceled"}, "expectedLastModified": _get("receipts", receipt_id, admin)["lastModified"]}, cookies=admin)
    assert response.status_code == 200, response.text


def _ordinary(tag, admin):
    """A stopped $100 ad due on its own $100 receipt R1, company covers 40 through R1 (due 60 + company 40)."""
    c, r1, a = f"rv_c{tag}", f"rv_r{tag}", f"rv_a{tag}"
    _customer(c, admin)
    first = _unpaid_receipt(r1, c, 100, admin)
    ad = _due_ad(a, c, r1, 100, admin)
    s = _stop(a, 10000, f"{a}-s0" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    cov = _cover_receipt(r1, 4000, f"{a}-c" + K, first["lastModified"], admin); assert cov.status_code == 200, cov.text
    return c, r1, a


def _step(a, admin, n, *, stop=None, refund=None):
    """One stop or refund on the ad as it stands now; returns the saved ad data."""
    last = _get("ads", a, admin)["lastModified"]
    response = (_stop(a, stop, f"{a}-n{n}" + K, last, admin) if stop is not None
                else _mutate("update", a, refund, f"{a}-n{n}" + K, admin, last))
    assert response.status_code == 200, response.text
    return response.json()["ad"]["data"]


# 24 (repair 2) -------------------------------------------------------------
def _moved(tag, admin, extra_cover=0):
    """Cover R1 40 on a stopped $100 ad, then move the ad's debt to R2 (due 60): the company row stays on R1."""
    c, r1, r2, a = f"rv_c{tag}", f"rv_r{tag}a", f"rv_r{tag}b", f"rv_a{tag}"
    _customer(c, admin)
    first = _unpaid_receipt(r1, c, 100, admin)
    _unpaid_receipt(r2, c, 100, admin)
    ad = _due_ad(a, c, r1, 100, admin)
    s = _stop(a, 10000, f"{a}-s0" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    cov = _cover_receipt(r1, 4000, f"{a}-c" + K, first["lastModified"], admin); assert cov.status_code == 200, cov.text
    relink = _mutate("update", a, {"relinkReceiptOnly": True, "receiptAllocations": [],
        "dueAllocations": [{"receiptId": r2, "amountUSD": 60}]}, f"{a}-relink" + K, admin, _get("ads", a, admin)["lastModified"])
    assert relink.status_code == 200, relink.text
    if extra_cover:
        cov = _cover_receipt(r2, extra_cover * 100, f"{a}-c2" + K, _get("receipts", r2, admin)["lastModified"], admin)
        assert cov.status_code == 200, cov.text
    return a, r1, r2


def _snapshot(a, r1, r2, admin):
    with db_conn() as conn:
        ledger = conn.execute(text("SELECT id, data_json, last_modified FROM entities WHERE type='receiptCompanyCoverages' ORDER BY id")).all()
    return json_dumps([_get("ads", a, admin), _get("receipts", r1, admin), _get("receipts", r2, admin), [tuple(row) for row in ledger]])


def test_stop_below_company_money_on_a_moved_row_is_refused_and_writes_nothing(admin):
    a, r1, r2 = _moved("24", admin)
    ad = _get("ads", a, admin)
    assert ad["data"]["dueAllocations"] == [{"receiptId": r2, "amountUSD": 60.0}]
    assert ad["data"]["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 40.0}]
    before = _snapshot(a, r1, r2, admin)
    for spent in (3000, 3999, 0):
        refused = _stop(a, spent, f"{a}-low{spent}" + K, ad["lastModified"], admin)
        assert refused.status_code == 409 and refused.json()["detail"] == MOVED, refused.text
        assert _snapshot(a, r1, r2, admin) == before and _releases(a) == []
    last = ad["lastModified"]
    for spent, due in ((4000, 0.0), (9000, 50.0), (10000, 60.0)):      # at or above the company money: accepted, no return
        s = _stop(a, spent, f"{a}-ok{spent}" + K, last, admin); assert s.status_code == 200, s.text
        d, last = s.json()["ad"]["data"], s.json()["ad"]["lastModified"]
        assert d["dueAllocations"] == ([{"receiptId": r2, "amountUSD": due}] if due else []) and _pool(d) == 4000
        assert _cents(d["spentUSD"]) == spent == _cents(due) + 4000
    rc = _get("receipts", r1, admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 40, 60) and _releases(a) == []


def test_refund_below_company_money_on_a_moved_row_is_refused_and_writes_nothing(admin):
    a, r1, r2 = _moved("25", admin)
    ad = _get("ads", a, admin)
    before = _snapshot(a, r1, r2, admin)
    for n, data in enumerate(({"refundType": "Full"}, {"refundType": "Partial", "refundAmount": 60.01})):
        refused = _mutate("update", a, data, f"{a}-f{n}" + K, admin, ad["lastModified"])
        assert refused.status_code == 409 and refused.json()["detail"] == MOVED, refused.text
        assert _snapshot(a, r1, r2, admin) == before and _releases(a) == []
    ok = _mutate("update", a, {"refundType": "Partial", "refundAmount": 60}, f"{a}-p" + K, admin, ad["lastModified"])
    assert ok.status_code == 200, ok.text                                  # the whole customer share: no company money moves
    d = ok.json()["ad"]["data"]
    assert d["spentUSD"] == 40 and d["dueAllocations"] == [] and _pool(d) == 4000 and _releases(a) == []
    more = _mutate("update", a, {"refundType": "Full"}, f"{a}-f9" + K, admin, ok.json()["ad"]["lastModified"])
    assert more.status_code == 409 and more.json()["detail"] == MOVED, more.text
    undo = _mutate("update", a, {"refundType": "None"}, f"{a}-u" + K, admin, ok.json()["ad"]["lastModified"])
    assert undo.status_code == 200, undo.text
    d = undo.json()["ad"]["data"]
    assert d["dueAllocations"] == [{"receiptId": r2, "amountUSD": 60.0}] and _pool(d) == 4000
    assert _explain("rv_c25", admin) == 0 and _releases(a) == []           # spend fully backed, nothing counted twice
    rc = _get("receipts", r1, admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 40, 60)


def test_company_rows_on_the_linked_receipt_and_another_one_are_refused_the_same_way(admin):
    a, r1, r2 = _moved("26", admin, extra_cover=20)
    ad = _get("ads", a, admin)
    assert ad["data"]["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 40.0}, {"receiptId": r2, "amountUSD": 20.0}]
    before = _snapshot(a, r1, r2, admin)
    refused = _stop(a, 3000, f"{a}-low" + K, ad["lastModified"], admin)     # 20 off the linked R2, then 10 off the moved R1
    assert refused.status_code == 409 and refused.json()["detail"] == MOVED, refused.text
    full = _mutate("update", a, {"refundType": "Full"}, f"{a}-f" + K, admin, ad["lastModified"])
    assert full.status_code == 409 and full.json()["detail"] == MOVED, full.text
    assert _snapshot(a, r1, r2, admin) == before and _releases(a) == []
    ok = _stop(a, 6000, f"{a}-ok" + K, ad["lastModified"], admin); assert ok.status_code == 200, ok.text
    assert _pool(ok.json()["ad"]["data"]) == 6000 and ok.json()["ad"]["data"]["dueAllocations"] == [] and _releases(a) == []
    # (repair 3) money that comes off the ad's OWN live receipt only is the ordinary return: R1 is not touched
    own = _stop(a, 5000, f"{a}-own" + K, ok.json()["ad"]["lastModified"], admin); assert own.status_code == 200, own.text
    d = own.json()["ad"]["data"]
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 40.0}, {"receiptId": r2, "amountUSD": 10.0}]
    assert d["dueAllocations"] == [] and d["stopAllocationBaseline"]["due"] == [{"receiptId": r2, "amountUSD": 50.0}]
    assert [(x["receiptId"], x["amountMinorUSD"]) for x in _releases(a)] == [(r2, -1000)] and _ledger("rv_c26") == 5000
    assert _receipt_figures(r1, admin) == ("Not Paid", 100, 40, 60) and _receipt_figures(r2, admin) == ("Not Paid", 100, 10, 90)
    up = _stop(a, 10000, f"{a}-up" + K, own.json()["ad"]["lastModified"], admin); assert up.status_code == 200, up.text
    d = up.json()["ad"]["data"]
    assert d["dueAllocations"] == [{"receiptId": r2, "amountUSD": 50.0}] and _pool(d) == 5000 and _explain("rv_c26", admin) == 0
    before = _snapshot(a, r1, r2, admin)
    for n, again in enumerate((_stop(a, 3000, f"{a}-low2" + K, up.json()["ad"]["lastModified"], admin),
                               _mutate("update", a, {"refundType": "Full"}, f"{a}-f2" + K, admin, up.json()["ad"]["lastModified"]))):
        assert again.status_code == 409 and again.json()["detail"] == MOVED, (n, again.text)   # reaching the moved row is still refused
    assert _snapshot(a, r1, r2, admin) == before and len(_releases(a)) == 1


def test_relinking_back_to_the_covered_receipt_restores_the_ordinary_return(admin):
    a, r1, r2 = _moved("27", admin)
    ad = _get("ads", a, admin)
    assert _stop(a, 3000, f"{a}-low" + K, ad["lastModified"], admin).status_code == 409
    back = _mutate("update", a, {"relinkReceiptOnly": True, "receiptAllocations": [],
        "dueAllocations": [{"receiptId": r1, "amountUSD": 60}]}, f"{a}-back" + K, admin, ad["lastModified"])
    assert back.status_code == 200, back.text
    s = _stop(a, 3000, f"{a}-s1" + K, back.json()["ad"]["lastModified"], admin); assert s.status_code == 200, s.text
    d = s.json()["ad"]["data"]
    assert d["dueAllocations"] == [] and d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert d["stopAllocationBaseline"]["due"] == [{"receiptId": r1, "amountUSD": 70.0}]
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1000]
    rc = _get("receipts", r1, admin)["data"]
    assert (rc["amountUSD"], rc["companyCoveredUSD"], rc["customerOutstandingUSD"]) == (100, 30, 70)
    up = _stop(a, 10000, f"{a}-s2" + K, s.json()["ad"]["lastModified"], admin); assert up.status_code == 200, up.text
    d = up.json()["ad"]["data"]
    assert d["dueAllocations"] == [{"receiptId": r1, "amountUSD": 70.0}] and _pool(d) == 3000
    assert _explain("rv_c27", admin) == 0 and len(_releases(a)) == 1


# 28 (repair 3) -------------------------------------------------------------
# The refusal is only for returned cents that become customer debt on a receipt the ad is not tied back to.
# A stop/refund that leaves a Paid ad with no paid row clears its receiptId, and canceling a receipt removes the
# due row: those rows sit on a settled / canceled receipt, the returned cents are debt nowhere, so they come back.
def test_settled_receipt_keeps_returning_company_money_after_the_ad_lost_its_link(admin):
    c, r1, a = _ordinary("28", admin)
    _settle(r1, admin)
    assert _receipt_figures(r1, admin) == ("Paid", 60, 40, 0) and _ledger(c) == 4000
    d = _step(a, admin, 1, stop=3000)
    assert d["receiptId"] == "" and d["receiptAllocations"] == [] and d["dueAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 30, 0) and _ledger(c) == 3000
    d = _step(a, admin, 2, stop=2000)                                          # was 409: the ad has no receipt of its own left
    assert d["spentUSD"] == 20 and d["receiptId"] == "" and d["receiptAllocations"] == [] and d["dueAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 20.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 20, 0) and _ledger(c) == 2000
    d = _step(a, admin, 3, refund={"refundType": "Full"})                      # was 409
    assert d["status"] == "Canceled" and d["spentUSD"] == 0 and _pool(d) == 0 and d["companyFundingAllocations"] == []
    assert _receipt_figures(r1, admin) == ("Paid", 60, 0, 0) and _ledger(c) == 0
    assert _get("receipts", r1, admin)["data"]["amountLocal"] == 300           # the customer's cash is never edited
    assert [(x["receiptId"], x["amountMinorUSD"], x["trigger"]) for x in _releases(a)] == [
        (r1, -1000, "stop"), (r1, -1000, "stop"), (r1, -2000, "refund")]
    assert client.delete(f"/api/collections/ads/{a}", cookies=admin).status_code == 200


def test_settled_receipt_partial_refunds_then_full_return_every_cent(admin):
    c, r1, a = _ordinary("29", admin)
    _settle(r1, admin)
    d = _step(a, admin, 1, refund={"refundType": "Partial", "refundAmount": 70})
    assert d["spentUSD"] == 30 and d["receiptId"] == "" and d["receiptAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 30, 0) and _ledger(c) == 3000
    d = _step(a, admin, 2, refund={"refundType": "Partial", "refundAmount": 80})          # was 409
    assert d["spentUSD"] == 20 and d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 20.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 20, 0) and _ledger(c) == 2000
    d = _step(a, admin, 3, refund={"refundType": "Full"})                                 # was 409
    assert d["spentUSD"] == 0 and _pool(d) == 0
    assert _receipt_figures(r1, admin) == ("Paid", 60, 0, 0) and _ledger(c) == 0
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1000, -1000, -2000]
    d = _step(a, admin, 4, refund={"refundType": "None"})                                 # undo: never re-applied
    assert d["status"] == "Stopped" and d["spentUSD"] == 100 and _pool(d) == 0
    assert d["receiptAllocations"] == [{"receiptId": r1, "amountUSD": 60.0}] and d["receiptId"] == r1
    assert _receipt_figures(r1, admin) == ("Paid", 60, 0, 0) and _ledger(c) == 0 and len(_releases(a)) == 3


def test_return_before_and_after_the_receipt_is_settled(admin):
    c, r1, a = _ordinary("30", admin)
    d = _step(a, admin, 1, stop=3000)                                          # still unpaid: the customer owes the 10 on R1 again
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert d["stopAllocationBaseline"]["due"] == [{"receiptId": r1, "amountUSD": 70.0}]
    assert _receipt_figures(r1, admin) == ("Not Paid", 100, 30, 70) and _ledger(c) == 3000
    _settle(r1, admin)
    assert _receipt_figures(r1, admin) == ("Paid", 70, 30, 0)
    d = _step(a, admin, 2, stop=2000)
    assert d["receiptId"] == "" and d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 20.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 70, 20, 0) and _ledger(c) == 2000
    d = _step(a, admin, 3, stop=1000)                                          # was 409
    assert d["spentUSD"] == 10 and d["receiptAllocations"] == [] and d["dueAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 10.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 70, 10, 0) and _ledger(c) == 1000
    assert _get("receipts", r1, admin)["data"]["amountLocal"] == 350
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1000, -1000, -1000]


def _unsettle(receipt_id, admin):
    response = client.post(f"/api/receipts/{receipt_id}/unsettle", json={
        "idempotencyKey": f"{receipt_id}-unsettle" + K, "expectedLastModified": _get("receipts", receipt_id, admin)["lastModified"],
        "data": {"status": "Not Paid", "isPaid": False}}, cookies=admin)
    assert response.status_code == 200, response.text


# 34 (repair 4: the RULE)
def test_unsettled_receipt_after_a_low_stop_refuses_the_return_until_it_is_settled_again(admin):
    """Settle R1, stop 30 (the Paid ad loses its link), unsettle R1: R1 tracks debt again and the ad is tied to nothing on it."""
    c, r1, a = _ordinary("34", admin)
    _settle(r1, admin)
    d = _step(a, admin, 1, stop=3000)
    assert d["receiptId"] == "" and d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 30, 0) and _ledger(c) == 3000
    _unsettle(r1, admin)
    assert _receipt_figures(r1, admin)[0] == "Not Paid" and _get("receipts", r1, admin)["data"]["companyCoveredUSD"] == 30
    ad = _get("ads", a, admin)
    before = _snapshot(a, r1, r1, admin)
    refused = _stop(a, 2000, f"{a}-low" + K, ad["lastModified"], admin)
    assert refused.status_code == 409 and refused.json()["detail"] == MOVED, refused.text
    full = _mutate("update", a, {"refundType": "Full"}, f"{a}-full" + K, admin, ad["lastModified"])
    assert full.status_code == 409 and full.json()["detail"] == MOVED, full.text
    assert _snapshot(a, r1, r1, admin) == before and len(_releases(a)) == 1   # ad, receipt, ledger byte-identical
    _settle2 = client.post(f"/api/receipts/{r1}/settle", json={
        "idempotencyKey": f"{r1}-settle-again" + K, "expectedLastModified": _get("receipts", r1, admin)["lastModified"],
        "data": {"status": "Paid", "isPaid": True}}, cookies=admin)
    assert _settle2.status_code == 200, _settle2.text
    assert _receipt_figures(r1, admin) == ("Paid", 60, 30, 0) and _ledger(c) == 3000
    d = _step(a, admin, 2, stop=2000)                                          # "Settle that receipt first": now it goes through
    assert d["spentUSD"] == 20 and d["receiptAllocations"] == [] and d["dueAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 20.0}]
    assert _receipt_figures(r1, admin) == ("Paid", 60, 20, 0) and _ledger(c) == 2000 == _pool(d)
    d = _step(a, admin, 3, refund={"refundType": "Full"})
    assert d["status"] == "Canceled" and d["spentUSD"] == 0 and _pool(d) == 0 and d["companyFundingAllocations"] == []
    assert _receipt_figures(r1, admin) == ("Paid", 60, 0, 0) and _ledger(c) == 0
    assert _get("receipts", r1, admin)["data"]["amountLocal"] == 300           # the customer's cash is never edited
    assert [(x["receiptId"], x["amountMinorUSD"], x["trigger"]) for x in _releases(a)] == [
        (r1, -1000, "stop"), (r1, -1000, "stop"), (r1, -2000, "refund")]
    assert _explain(c, admin) == 0


# 31 (repair 3)
def test_canceled_covered_receipt_does_not_trap_the_ad(admin):
    c, r1, a = _ordinary("31", admin)
    _cancel_receipt(r1, admin)
    d = _get("ads", a, admin)["data"]
    assert d["receiptId"] == "" and d["dueAllocations"] == [] and d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 40.0}]
    assert _receipt_figures(r1, admin) == ("Canceled", 100, 40, 0) and _ledger(c) == 4000
    d = _step(a, admin, 1, stop=3000)                                          # was 409
    assert d["spentUSD"] == 30 and d["dueAllocations"] == [] and d["receiptAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert _receipt_figures(r1, admin) == ("Canceled", 100, 30, 0) and _ledger(c) == 3000
    assert [(x["receiptId"], x["amountMinorUSD"]) for x in _releases(a)] == [(r1, -1000)]
    assert _explain(c, admin) == 0                                             # 30 spent, 30 company: nothing left to offer
    d = _step(a, admin, 2, refund={"refundType": "Full"})                      # was 409
    assert d["status"] == "Canceled" and d["spentUSD"] == 0 and _pool(d) == 0
    assert _receipt_figures(r1, admin) == ("Canceled", 100, 0, 0) and _ledger(c) == 0
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1000, -3000]
    assert client.delete(f"/api/collections/ads/{a}", cookies=admin).status_code == 200    # was 409 company-paid: no way out


# 32 (repair 3)
def _moved_off_dead_receipt_conserves(tag, kill, dead, admin):
    """MOVED ad whose OLD receipt no longer tracks debt: the return is allowed and no cent is counted twice."""
    a, r1, r2 = _moved(tag, admin)
    c = f"rv_c{tag}"
    kill(r1, admin)
    status, amount = dead
    assert _receipt_figures(r1, admin) == (status, amount, 40, 0) and _ledger(c) == 4000
    other = _get("receipts", r2, admin)
    d = _step(a, admin, 1, stop=3000)                                          # was 409
    assert d["spentUSD"] == 30 and d["receiptId"] == r2 and d["dueAllocations"] == [] and d["receiptAllocations"] == []
    assert d["companyFundingAllocations"] == [{"receiptId": r1, "amountUSD": 30.0}]
    assert d["stopAllocationBaseline"]["due"] == [{"receiptId": r2, "amountUSD": 60.0}]    # nothing tied back to the dead R1
    assert _receipt_figures(r1, admin) == (status, amount, 30, 0) and _ledger(c) == 3000
    assert [(x["receiptId"], x["amountMinorUSD"]) for x in _releases(a)] == [(r1, -1000)]
    d = _step(a, admin, 2, stop=9000)                                          # correction upward: due 60 on R2 + company 30
    assert d["dueAllocations"] == [{"receiptId": r2, "amountUSD": 60.0}] and _pool(d) == 3000 and d["spentUSD"] == 90
    d = _step(a, admin, 3, refund={"refundType": "Full"})                      # was 409
    assert d["spentUSD"] == 0 and _pool(d) == 0 and d["dueAllocations"] == []
    assert _receipt_figures(r1, admin) == (status, amount, 0, 0) and _ledger(c) == 0
    assert [x["amountMinorUSD"] for x in _releases(a)] == [-1000, -3000]
    d = _step(a, admin, 4, refund={"refundType": "None"})                      # undo: company money is never re-applied
    assert d["status"] == "Stopped" and d["spentUSD"] == 90 and _pool(d) == 0
    assert d["dueAllocations"] == [{"receiptId": r2, "amountUSD": 60.0}] and d["companyFundingAllocations"] == []
    # What the customer really owes for this ad: 60 inside R2's debt + 30 backed by nothing = the 90 spent, once.
    # The cents returned from R1 are debt nowhere (R1 stays settled/canceled with nothing outstanding), R2 is untouched.
    unbacked = _cents(_explain(c, admin))
    assert unbacked == 3000 == _cents(d["spentUSD"]) - 6000 - _pool(d)
    assert _receipt_figures(r1, admin) == (status, amount, 0, 0) and _get("receipts", r2, admin) == other
    assert other["data"]["status"] == "Not Paid" and other["data"]["amountUSD"] == 100 and not other["data"].get("companyCoveredUSD")
    assert _ledger(c) == 0 and len(_releases(a)) == 2


def test_moved_ad_whose_old_receipt_is_settled_returns_company_money_and_conserves(admin):
    _moved_off_dead_receipt_conserves("32", _settle, ("Paid", 60), admin)
    assert _get("receipts", "rv_r32a", admin)["data"]["amountLocal"] == 300    # the customer's cash on R1 is untouched


def test_moved_ad_whose_old_receipt_is_canceled_returns_company_money_and_conserves(admin):
    _moved_off_dead_receipt_conserves("33", _cancel_receipt, ("Canceled", 100), admin)


# 36 (final sweep follow-up)
def _stored_receipt(receipt_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='receipts' AND id=:id"), {"id": receipt_id}).mappings().first()
    return json_loads(row["data_json"])


def test_full_return_leaves_a_receipt_every_screen_reads_the_same_settled_or_not(admin):
    """The last company cent leaves a receipt. Settled or not, the receipt then says what the customer owes on it.

    Known gap, reported to the owner and deliberately not asserted here: the month-close "unpaid receipts" counter reads
    the stored summary, which stays 0 on a receipt that was settled when the money came back, so after a later unsettle
    that counter does not list the receipt although every screen shows its debt. Dropping the stored summary instead was
    tried and withdrawn: it changed the same counter on other receipt shapes (canceled deliveries, LYD-only receipts)."""
    c, r1, a = _ordinary("36", admin)                       # stopped $100 ad: due R1 60 + company R1 40
    _settle(r1, admin)
    assert _receipt_figures(r1, admin) == ("Paid", 60, 40, 0)
    d = _step(a, admin, 1, stop=0)                          # every company cent comes back
    assert _pool(d) == 0 and _ledger(c) == 0
    assert _receipt_figures(r1, admin) == ("Paid", 60, 0, 0)
    _unsettle(r1, admin)
    status, amount, covered, outstanding = _receipt_figures(r1, admin)
    assert status == "Not Paid" and covered == 0 and outstanding == amount == 60

    # A receipt that is still unpaid when the last company cent returns keeps its stored summary in step.
    c2, r2, a2 = _ordinary("36b", admin)
    d = _step(a2, admin, 1, stop=0)
    assert _pool(d) == 0 and _ledger(c2) == 0
    stored = _stored_receipt(r2)
    assert stored["companyCoveredUSD"] == 0 and stored["customerOutstandingUSD"] == 100
    assert _receipt_figures(r2, admin) == ("Not Paid", 100, 0, 100)


# 37 (a debt figure nothing else records is never dropped)
def test_full_return_keeps_a_stored_outstanding_that_nothing_else_records(admin):
    """Older delivered receipts, saved before the planned debt was kept (no debtAmountUSD), carry the customer's debt
    only in the stored summary: nothing can derive it. A return keeps that summary in step (outstanding + returned),
    also when the last company cent leaves, instead of dropping it."""
    from server.financial_compatibility import receipt_customer_outstanding_minor

    for tag, legacy in (("37a", {"deliveryStatus": "Delivered", "debtAmountUSD": None}),
                        ("37b", {"deliveryStatus": "Delivered", "debtAmountUSD": None, "amountUSD": 0, "amountLocal": 0,
                                 "paymentResult": "UNDERPAID", "amountCollectedFromCustomer": 0})):
        c, r1, a = _ordinary(tag, admin)                    # stopped $100 ad: due R1 60 + company R1 40
        _legacy_patch("receipts", r1, legacy)               # the stored shape old code left behind
        before = _stored_receipt(r1)
        assert receipt_customer_outstanding_minor(before) is None           # nothing can derive this debt
        assert before["companyCoveredUSD"] == 40 and before["customerOutstandingUSD"] == 60
        d = _step(a, admin, 1, stop=3000)                   # 10 of the 40 company dollars come back
        stored = _stored_receipt(r1)
        assert _pool(d) == 3000 and _ledger(c) == 3000
        assert stored["companyCoveredUSD"] == 30 and stored["customerOutstandingUSD"] == 70
        d = _step(a, admin, 2, stop=0)                      # every company cent comes back
        assert _pool(d) == 0 and _ledger(c) == 0
        stored = _stored_receipt(r1)
        assert stored["companyCoveredUSD"] == 0
        assert stored["customerOutstandingUSD"] == 100      # 60 + the 40 that came back; dropping the key would lose the debt
        # the returned debt is tied back to the ad on the same receipt, once
        assert d["stopAllocationBaseline"]["due"] == [{"receiptId": r1, "amountUSD": 100.0}]


# 38 (a row with conflicting paid markers: nothing can derive its debt, so its summary is neither dropped nor raised)
def test_full_return_on_conflicting_paid_markers_leaves_the_stored_summary_alone(admin):
    _customer("rv_c38", admin)
    r = _unpaid_receipt("rv_r38", "rv_c38", 100, admin)
    _due_ad("rv_a38", "rv_c38", "rv_r38", 100, admin)
    cov = _cover_receipt("rv_r38", 10000, "rv-r38-c" + K, r["lastModified"], admin); assert cov.status_code == 200
    _legacy_patch("receipts", "rv_r38", {"isPaid": True})     # stored: status Not Paid beside isPaid true
    summary_before = _stored_receipt("rv_r38")["customerOutstandingUSD"]
    ad = _get("ads", "rv_a38", admin)
    s = _stop("rv_a38", 0, "rv-a38-s1" + K, ad["lastModified"], admin); assert s.status_code == 200, s.text
    stored = _stored_receipt("rv_r38")
    assert stored["companyCoveredUSD"] == 0 and _pool(s.json()["ad"]["data"]) == 0 and _ledger("rv_c38") == 0
    assert stored["customerOutstandingUSD"] == summary_before == 0      # neither dropped nor raised
    import server.main as main
    before = _get("receipts", "rv_r38", admin)
    main.backfill_covered_settled_receipts()                  # what a restart runs: no rewrite of this row
    assert _get("receipts", "rv_r38", admin) == before
