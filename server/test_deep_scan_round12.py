"""Deep-scan round 12: wallet charge requests, one-pot money corrections."""

import os
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import main, operations
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r12-admin-{TAG}@tests.albayanhub.com"
CUSTOMER_EMAIL = f"r12-customer-{TAG}@tests.albayanhub.com"
PASSWORD = "Round12Pass123!"


def _seed_user(email: str, role: str, permissions: dict) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": email.split("@")[0], "email": email, "role": role, "perms": json_dumps(permissions),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    return uid


def _login(email: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def staff():
    init_db()
    admin_id = _seed_user(ADMIN_EMAIL, "Admin", {})
    customer_id = _seed_user(CUSTOMER_EMAIL, "Employee", {})
    return {"admin": _login(ADMIN_EMAIL), "admin_id": admin_id, "customer": _login(CUSTOMER_EMAIL), "customer_id": customer_id}


def _create(collection: str, entity_id: str, data: dict, cookies) -> dict:
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _entity(collection: str, entity_id: str, cookies) -> dict:
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _customer(cid: str, cookies) -> dict:
    return _create("customers", cid, {"name": cid, "phones": [f"09{secrets.randbelow(10**8):08d}"]}, cookies)


def _unpaid_receipt(rid: str, cid: str, amount: float, cookies, **extra) -> dict:
    data = {"recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5,
            "debtAmountUSD": amount, "debtAmountLocal": amount * 5, "exchangeRate": 5, "status": "Not Paid",
            "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}
    data.update(extra)
    return _create("receipts", rid, data, cookies)


def _cover(rid: str, minor: int, cookies, key: str) -> dict:
    receipt = _entity("receipts", rid, cookies)
    r = client.post(f"/api/receipts/{rid}/company-coverages",
                    json={"amountMinorUSD": minor, "idempotencyKey": key, "expectedLastModified": receipt["lastModified"],
                          "reason": "Round twelve coverage scenario"}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _settle(rid: str, cookies, key: str, **data) -> object:
    receipt = _entity("receipts", rid, cookies)
    payload = {"isPaid": True, "status": "Paid", "deliveryStatus": "Office", "collectionDate": "2026-09-19T10:00:00Z"}
    payload.update(data)
    return client.post(f"/api/receipts/{rid}/settle", json={"idempotencyKey": key, "expectedLastModified": receipt["lastModified"], "data": payload}, cookies=cookies)


# ---------------------------------------------------------------- money: settling a covered receipt

def test_settling_with_the_gross_strips_the_company_share(staff):
    admin = staff["admin"]
    cid, rid = f"r12_gcust_{TAG}", f"r12_grcpt_{TAG}"
    _customer(cid, admin); _unpaid_receipt(rid, cid, 100, admin)
    _cover(rid, 4000, admin, f"r12-gcover-{TAG}")
    r = _settle(rid, admin, f"r12-gsettle-{TAG}", amountUSD=100, amountLocal=500)
    assert r.status_code == 200, r.text
    data = _entity("receipts", rid, admin)["data"]
    assert round(float(data["amountUSD"]), 2) == 60.0 and round(float(data.get("customerOutstandingUSD") or 0), 2) == 0.0, data


def test_settling_with_the_customers_net_cash_keeps_it(staff):
    admin = staff["admin"]
    cid, rid = f"r12_ncust_{TAG}", f"r12_nrcpt_{TAG}"
    _customer(cid, admin); _unpaid_receipt(rid, cid, 100, admin)
    _cover(rid, 4000, admin, f"r12-ncover-{TAG}")
    r = _settle(rid, admin, f"r12-nsettle-{TAG}", amountUSD=60, amountLocal=300)
    assert r.status_code == 200, r.text
    data = _entity("receipts", rid, admin)["data"]
    assert round(float(data["amountUSD"]), 2) == 60.0, data   # before: 60 - 40 = 20, forty dollars destroyed


def test_settling_with_an_amount_between_net_and_gross_is_refused(staff):
    admin = staff["admin"]
    cid, rid = f"r12_bcust_{TAG}", f"r12_brcpt_{TAG}"
    _customer(cid, admin); _unpaid_receipt(rid, cid, 100, admin)
    _cover(rid, 4000, admin, f"r12-bcover-{TAG}")
    r = _settle(rid, admin, f"r12-bsettle-{TAG}", amountUSD=80, amountLocal=400)
    assert r.status_code == 409 and "net cash" in r.text, r.text
    assert round(float(_entity("receipts", rid, admin)["data"]["amountUSD"]), 2) == 100.0


def test_a_canceled_receipt_the_company_covered_cannot_be_reopened(staff):
    admin = staff["admin"]
    cid, rid = f"r12_ccust_{TAG}", f"r12_crcpt_{TAG}"
    _customer(cid, admin); _unpaid_receipt(rid, cid, 100, admin)
    _cover(rid, 4000, admin, f"r12-ccover-{TAG}")
    receipt = _entity("receipts", rid, admin)
    canceled = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"status": "Canceled"}, "expectedLastModified": receipt["lastModified"]}, cookies=admin)
    assert canceled.status_code == 200, canceled.text
    receipt = _entity("receipts", rid, admin)
    reopened = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"status": "Not Paid"}, "expectedLastModified": receipt["lastModified"]}, cookies=admin)
    assert reopened.status_code == 409 and "reopened" in reopened.text, reopened.text


def test_month_close_nets_the_cash_a_driver_collected(monkeypatch):
    rows = {"receipts": [
        {"id": "u1", "date": "2026-09-05", "status": "Not Paid", "deliveryStatus": "Delivered", "amountUSD": 60, "debtAmountUSD": 100, "paymentResult": "UNDERPAID"},  # owes 40
        {"id": "u2", "date": "2026-09-06", "status": "Not Paid", "deliveryStatus": "Delivered", "amountUSD": 100, "debtAmountUSD": 100, "paymentResult": "PAID_EXACT"},  # owes 0
        {"id": "u4", "date": "2026-09-08", "status": "Not Paid", "deliveryStatus": "Delivered", "amountUSD": 100, "debtAmountUSD": 100},  # legacy: no completion record, still owed
        {"id": "u3", "date": "2026-09-07", "status": "Not Paid", "amountUSD": 100, "companyCoveredUSD": 40},  # owes 60
    ], "ads": [], "dollarPurchases": []}
    monkeypatch.setattr(operations, "_entity_rows", lambda collection, conn=None: [dict(r) for r in rows.get(collection, [])])
    snap = operations._period_snapshot("2026-09")
    assert snap["counts"]["unpaidReceipts"] == 3, snap["counts"]
    assert round(float(snap["totals"]["companyCoveredUSD"]), 2) == 40.0, snap["totals"]


# ---------------------------------------------------------------- wallet charge requests

def _methods(cookies) -> dict:
    r = client.get("/api/wallet/payment-requests/methods", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _charge(cookies, amount_minor: int, currency: str, key: str):
    methods = _methods(cookies)["methods"]
    assert methods, "no payment methods configured"
    method = methods[0]["id"]
    return client.post("/api/wallet/payment-requests",
                       json={"amountMinor": amount_minor, "currency": currency, "method": method, "idempotencyKey": key, "note": "round twelve"},
                       cookies=cookies)


def test_pending_list_is_filtered_and_photo_free(staff):
    first = _charge(staff["customer"], 5000, "LYD", f"r12-pay1-{TAG}")
    assert first.status_code == 200, first.text
    second = _charge(staff["customer"], 7000, "LYD", f"r12-pay2-{TAG}")
    assert second.status_code == 200, second.text
    confirmed = client.post(f"/api/wallet/payment-requests/{second.json()['id']}/confirm",
                            json={"providerRef": "r12", "overrideMissingReceipt": True}, cookies=staff["admin"])
    assert confirmed.status_code == 200, confirmed.text
    listing = client.get("/api/wallet/payment-requests?scope=pending", cookies=staff["admin"])
    assert listing.status_code == 200, listing.text
    rows = listing.json()["requests"]
    ids = {row["id"] for row in rows}
    assert first.json()["id"] in ids and second.json()["id"] not in ids
    assert all(str((row.get("data") or {}).get("status")) == "pending" for row in rows)
    assert all("receiptPhoto" not in (row.get("data") or {}) or not (row.get("data") or {}).get("receiptPhoto") for row in rows)


def test_deleting_an_account_with_a_pending_charge_is_refused_and_a_deleted_account_cannot_be_credited(staff):
    victim_email = f"r12-victim-{TAG}@tests.albayanhub.com"
    victim_id = _seed_user(victim_email, "Employee", {})
    victim = _login(victim_email)
    pending = _charge(victim, 5000, "LYD", f"r12-victim-pay-{TAG}")
    assert pending.status_code == 200, pending.text
    refused = client.patch(f"/api/users/{victim_id}", json={"deleted": True}, cookies=staff["admin"])
    assert refused.status_code == 409 and "waiting for confirmation" in refused.text, refused.text
    with db_conn() as conn:  # simulate an account deleted through another path
        conn.execute(text("UPDATE users SET deleted=true WHERE id=:id"), {"id": victim_id})
    try:
        confirmed = client.post(f"/api/wallet/payment-requests/{pending.json()['id']}/confirm",
                                json={"providerRef": "r12", "overrideMissingReceipt": True}, cookies=staff["admin"])
        assert confirmed.status_code == 409 and "deleted" in confirmed.text, confirmed.text
    finally:
        with db_conn() as conn:
            conn.execute(text("UPDATE users SET deleted=false WHERE id=:id"), {"id": victim_id})


# ---------------------------------------------------------------- odd inputs never become a 500

lenient = TestClient(main.app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)


def test_a_huge_integer_amount_is_not_a_server_error(staff):
    huge = int("1" + "0" * 400)
    r = lenient.post("/api/collections/customers", json={"id": f"r12_huge_{TAG}", "data": {"name": "huge", "phones": [f"09{secrets.randbelow(10**8):08d}"], "amountUSD": huge, "exchangeRate": huge}},
                     cookies=staff["admin"])
    assert r.status_code != 500, r.text[:200]


def test_a_microscopic_rate2_is_refused_not_crashed(staff):
    cid = f"r12_rcust_{TAG}"
    _customer(cid, staff["admin"])
    r = lenient.post("/api/ads/mutate", json={"action": "create", "adId": f"r12_rad_{TAG}", "idempotencyKey": f"r12-rad-{TAG}",
                                              "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "cash", "status": "Active", "exchangeRate": 5,
                                                       "amountUSD": 5, "collectionPayments": [{"method": "Cash", "amount": 5, "rate2": 1e-30}]}},
                     cookies=staff["admin"])
    assert r.status_code in (400, 409, 422), (r.status_code, r.text[:200])


def test_a_lone_surrogate_is_stripped_not_crashed(staff):
    escaped = "ab" + chr(92) + "ud800cd"  # the JSON escape sequence for a lone surrogate, as bytes on the wire
    body = ('{"id": "r12_surr_%s", "data": {"name": "%s", "phones": ["09%08d"]}}' % (TAG, escaped, secrets.randbelow(10**8))).encode("ascii")
    r = lenient.post("/api/collections/customers", content=body, headers={"Content-Type": "application/json"}, cookies=staff["admin"])
    assert r.status_code == 200, (r.status_code, r.text[:200])
    assert _entity("customers", f"r12_surr_{TAG}", staff["admin"])["data"]["name"] == "abcd"


def test_due_usage_never_divides_by_the_rate_sentinel():
    from server import financial_core
    ad = {"dueAmountToUseLYD": 500, "dueAmountToUseUSD": 0, "exchangeRate": 0.001, "linkedDeliveryReceiptId": "r", "paymentStatus": "not_paid"}
    assert financial_core._financial_ad_due_usage(ad, "r") == 0
    ad_real = {"dueAmountToUseLYD": 500, "dueAmountToUseUSD": 0, "exchangeRate": 5, "linkedDeliveryReceiptId": "r", "paymentStatus": "not_paid"}
    assert financial_core._financial_ad_due_usage(ad_real, "r") == 10000


def test_restore_with_an_absurd_created_at_is_a_validation_error(staff):
    r = lenient.put(f"/api/admin/collections/customers/r12_nonexistent_{TAG}/restore",
                    json={"data": {"name": "x"}, "createdAt": 10**30}, cookies=staff["admin"])
    assert r.status_code == 422, (r.status_code, r.text[:200])
