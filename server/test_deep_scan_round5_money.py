"""Round 5 (2026-09-18): receipt money-state sequences that broke conservation."""

import hashlib
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.company_debt_coverage import coverable_ad_debt_detail
from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r5-money-admin-{TAG}@tests.albayanhub.com"
ADMIN_PASSWORD = "R5Money123!Secure"
DRIVER_ID = f"r5_driver_{TAG}"


@pytest.fixture(scope="module")
def admin():
    init_db()
    pw = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        conn.execute(text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                          "password_iterations,deleted,created_at,created_by,last_modified) "
                          "VALUES (:id,'R5 Money Admin',:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"),
                     {"id": new_id("user"), "email": ADMIN_EMAIL, "perm": json_dumps({}), "h": pw.hash_hex, "s": pw.salt_hex,
                      "a": pw.algo, "i": pw.iterations, "now": now})
    login = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _phone(cid):
    return f"09{int.from_bytes(hashlib.sha256(cid.encode()).digest()[:8], 'big') % 100_000_000:08d}"


def _create(collection, entity_id, data, admin):
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=admin)
    assert r.status_code == 200, r.text
    return r.json()


def _customer(cid, admin):
    return _create("customers", cid, {"name": cid, "phones": [_phone(cid)]}, admin)


def _unpaid_office_receipt(rid, cid, amount, admin):
    return _create("receipts", rid, {"recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5,
                                     "debtAmountUSD": amount, "debtAmountLocal": amount * 5, "exchangeRate": 5, "status": "Not Paid",
                                     "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}, admin)


def _paid_receipt(rid, cid, amount, admin, **extra):
    data = {"recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5, "exchangeRate": 5,
            "status": "Paid", "isPaid": True, "deliveryStatus": "Office", "payments": []}
    data.update(extra)
    return _create("receipts", rid, data, admin)


def _shop_ad(ad_id, cid, rid, due, admin, *, start_date=None):
    data = {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5, "receiptId": rid,
            "dueAllocations": [{"receiptId": rid, "amountUSD": due}], "receiptAllocations": []}
    if start_date:
        data["startDate"] = start_date
    r = client.post("/api/ads/mutate", json={"action": "create", "adId": ad_id, "idempotencyKey": f"{ad_id}-create", "data": data}, cookies=admin)
    assert r.status_code == 200, r.text
    return r.json()["ad"]


def _entity(collection, entity_id, admin):
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=admin)
    assert r.status_code == 200, r.text
    return r.json()


def _patch(collection, entity_id, data, admin):
    expected = _entity(collection, entity_id, admin)["lastModified"]
    return client.patch(f"/api/collections/{collection}/{entity_id}", json={"data": data, "expectedLastModified": expected}, cookies=admin)


def _cover(rid, amount_minor, key, admin):
    expected = _entity("receipts", rid, admin)["lastModified"]
    return client.post(f"/api/receipts/{rid}/company-coverages",
                       json={"amountMinorUSD": amount_minor, "idempotencyKey": key, "expectedLastModified": expected, "reason": "r5 coverage"},
                       cookies=admin)


def _stop(ad_id, key, spent_minor, admin):
    expected = _entity("ads", ad_id, admin)["lastModified"]
    return client.post(f"/api/ads/{ad_id}/stop", json={"spentMinorUSD": spent_minor, "idempotencyKey": key, "expectedLastModified": expected}, cookies=admin)


def test_paid_receipt_marked_delivered_keeps_its_money(admin):
    cid, rid = f"r5a_cust_{TAG}", f"r5a_receipt_{TAG}"
    _customer(cid, admin)
    _paid_receipt(rid, cid, 100, admin, deliveryStatus="Needs Delivery", deliveryPersonId=DRIVER_ID, deliveryPlaceName="place", quotedDeliveryFee=5)
    r = _patch("receipts", rid, {"deliveryStatus": "Delivered"}, admin)
    assert r.status_code == 200, r.text
    after = _entity("receipts", rid, admin)["data"]
    assert after["status"] == "Paid" and after["isPaid"] is True and after["deliveryStatus"] == "Delivered"
    assert round(float(after["amountUSD"]) * 100) == 10000


def test_settle_with_delivered_on_a_non_temp_receipt_pays_it(admin):
    cid, rid = f"r5a2_cust_{TAG}", f"r5a2_receipt_{TAG}"
    _customer(cid, admin)
    _unpaid_office_receipt(rid, cid, 100, admin)
    before = _entity("receipts", rid, admin)
    r = client.post(f"/api/receipts/{rid}/settle", json={"idempotencyKey": f"r5a2-settle-{TAG}", "expectedLastModified": before["lastModified"],
                                                         "data": {"isPaid": True, "status": "Paid", "deliveryStatus": "Delivered",
                                                                  "collectionDate": "2026-09-18T10:00:00Z"}}, cookies=admin)
    assert r.status_code == 200, r.text
    after = _entity("receipts", rid, admin)["data"]
    assert after["status"] == "Paid" and round(float(after["amountUSD"]) * 100) == 10000, after


def test_covered_ad_records_its_real_spend_after_the_receipt_was_canceled(admin):
    cid, rid, aid = f"r5b_cust_{TAG}", f"r5b_receipt_{TAG}", f"r5b_ad_{TAG}"
    _customer(cid, admin)
    _unpaid_office_receipt(rid, cid, 100, admin)
    _shop_ad(aid, cid, rid, 100, admin)
    assert _cover(rid, 3000, f"r5b-cover-{TAG}", admin).status_code == 200
    assert _patch("receipts", rid, {"status": "Canceled"}, admin).status_code == 200
    stopped = _stop(aid, f"r5b-stop-{TAG}", 10000, admin)
    assert stopped.status_code == 200, stopped.text


def test_deleting_a_canceled_covered_receipt_keeps_the_company_money_on_the_ad(admin):
    cid, rid, aid = f"r5c_cust_{TAG}", f"r5c_receipt_{TAG}", f"r5c_ad_{TAG}"
    _customer(cid, admin)
    _unpaid_office_receipt(rid, cid, 100, admin)
    _shop_ad(aid, cid, rid, 100, admin)
    assert _cover(rid, 3000, f"r5c-cover-{TAG}", admin).status_code == 200
    assert _patch("receipts", rid, {"status": "Canceled"}, admin).status_code == 200
    before = _entity("ads", aid, admin)["data"]
    assert coverable_ad_debt_detail(before) == ("coverable", 7000)
    deleted = client.delete(f"/api/collections/receipts/{rid}", cookies=admin)
    assert deleted.status_code == 200, deleted.text
    after = _entity("ads", aid, admin)["data"]
    assert after.get("companyFundingAllocations") in ([], None)
    assert round(float(after.get("companyDirectCoverageUSD") or 0) * 100) == 3000   # moved, not lost
    assert coverable_ad_debt_detail(after) == ("coverable", 7000)                     # not offered twice


def test_office_settle_of_a_covered_receipt_still_nets_the_covered_share(admin):
    cid, rid, aid = f"r5d_cust_{TAG}", f"r5d_receipt_{TAG}", f"r5d_ad_{TAG}"
    _customer(cid, admin)
    _unpaid_office_receipt(rid, cid, 100, admin)
    _shop_ad(aid, cid, rid, 100, admin)
    assert _cover(rid, 3000, f"r5d-cover-{TAG}", admin).status_code == 200
    before = _entity("receipts", rid, admin)
    # The office quick action: paid + delivered, with no driver cash figure.
    r = client.post(f"/api/receipts/{rid}/settle", json={"idempotencyKey": f"r5d-settle-{TAG}", "expectedLastModified": before["lastModified"],
                                                         "data": {"isPaid": True, "status": "Paid", "deliveryStatus": "Delivered",
                                                                  "collectionDate": "2026-09-18T10:00:00Z"}}, cookies=admin)
    assert r.status_code == 200, r.text
    after = _entity("receipts", rid, admin)["data"]
    assert after["status"] == "Paid"
    assert round(float(after["amountUSD"]) * 100) == 7000, after     # customer cash only; the company's $30 is not "paid by the customer"


def test_cancel_refuses_to_rewrite_an_ad_in_a_closed_month(admin):
    cid, rid, aid, period = f"r5i_cust_{TAG}", f"r5i_receipt_{TAG}", f"r5i_ad_{TAG}", "2019-06"
    _customer(cid, admin)
    _unpaid_office_receipt(rid, cid, 100, admin)
    _shop_ad(aid, cid, rid, 100, admin, start_date=f"{period}-15")
    ad_before = _entity("ads", aid, admin)
    closed = client.post("/api/admin/operations/financial-periods/close", json={"period": period, "forceReason": "r5"}, cookies=admin)
    assert closed.status_code == 200, closed.text
    try:
        r = _patch("receipts", rid, {"status": "Canceled"}, admin)
        assert r.status_code == 423, r.text
        assert _entity("ads", aid, admin)["lastModified"] == ad_before["lastModified"]
    finally:
        unlocked = client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "r5 restore"}, cookies=admin)
        assert unlocked.status_code == 200, unlocked.text
