"""Review loop round 3, batch MM: manager money core.

1. A company-covered Paid receipt re-saved with the gross (the form derives
   amountUSD from the gross-prefilled payment rows) kept the gross next to
   companyCoveredUSD: the covered share became free customer credit, and an
   unsettle added the covered share on top of the gross a second time.
2. A small company share (up to $1 or 1%) put the customer's exact net cash
   inside the "gross" rounding band, so settling with net cash stripped the
   covered share from real money a second time.
3. The server spend readers ignored the legacy British spelling "Cancelled"
   (the client reads it), so such an ad counted its whole budget as spend.
"""

import hashlib
import os
import secrets

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server import main
from server.company_debt_coverage import ad_effective_spend_minor, coverable_ad_debt_detail
from server.db import db_conn, init_db, json_dumps, now_ms
from server.financial_core import _financial_due_total
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.settlement_truth import apply_coverage_settlement_truth

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r3mm-admin-{TAG}@tests.albayanhub.com"
PASSWORD = "ReviewLoopR3mm123!"


def _apply(old, merged):
    apply_coverage_settlement_truth(old, merged, due_total=_financial_due_total)
    return merged


# ---------------------------------------------------------------- unit: finding 1

def _covered_office_receipt():
    return {"recordType": "receipt", "status": "Not Paid", "isPaid": False,
            "amountUSD": 100, "amountLocal": 490, "debtAmountUSD": 100, "debtAmountLocal": 490,
            "exchangeRate": 4.9, "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
            "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}


GROSS_ROWS = [{"method": "Cash (LYD)", "amount": 490, "rate": 1, "rate2": 4.9}]


def _settled():
    old = _covered_office_receipt()
    merged = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 100,
                          "amountLocal": 490, "payments": GROSS_ROWS})
    assert (merged["amountUSD"], merged["amountLocal"]) == (60.0, 294.0)
    return merged


def test_resaving_a_covered_paid_receipt_with_the_gross_mints_no_credit():
    settled = _settled()
    resaved = _apply(settled, {**settled, "amountUSD": 100, "amountLocal": 490, "phone": "0910000000"})
    assert (resaved["amountUSD"], resaved["amountLocal"]) == (60.0, 294.0)
    assert _financial_due_total(resaved) == _financial_due_total(settled) == 10000
    assert resaved["customerOutstandingUSD"] == 0


def test_resaving_a_covered_paid_receipt_keeps_net_edits_and_small_raises():
    settled = _settled()
    # Unchanged net money: nothing to repair.
    same = _apply(settled, {**settled, "notes": "phone fixed"})
    assert same["amountUSD"] == 60.0
    # A real raise recorded from net payment rows stays the customer's cash.
    raised = _apply(settled, {**settled, "amountUSD": 70, "amountLocal": 343})
    assert (raised["amountUSD"], raised["amountLocal"]) == (70, 343)
    # A form total a little under the gross (rate rounding) still means the gross.
    rounded = _apply(settled, {**settled, "amountUSD": 99.5, "amountLocal": 487.55})
    assert rounded["amountUSD"] == 59.5


def test_unsettling_a_covered_receipt_with_the_gross_charges_the_customer_share_once():
    settled = _settled()
    gross = _apply(settled, {**settled, "status": "Not Paid", "isPaid": False,
                             "amountUSD": 100, "amountLocal": 490})
    assert (gross["amountUSD"], gross["amountLocal"]) == (100.0, 490.0)
    assert gross["customerOutstandingUSD"] == 60.0
    # The net amount (what the stored receipt holds) still gets the share back.
    net = _apply(settled, {**settled, "status": "Not Paid", "isPaid": False})
    assert (net["amountUSD"], net["amountLocal"]) == (100.0, 490.0)
    assert net["customerOutstandingUSD"] == 60.0


def test_a_delivered_paid_receipt_keeps_the_driver_cash_on_resave():
    old = {**_settled(), "deliveryStatus": "Delivered"}
    merged = _apply(old, {**old, "amountUSD": 100, "amountLocal": 490})
    assert merged["amountUSD"] == 100


# ---------------------------------------------------------------- unit: finding 2

def _small_cover(gross_usd, covered_usd):
    return {"status": "Not Paid", "isPaid": False, "amountUSD": gross_usd, "amountLocal": gross_usd * 5,
            "debtAmountUSD": gross_usd, "debtAmountLocal": gross_usd * 5, "exchangeRate": 5,
            "companyCoveredUSD": covered_usd, "deliveryStatus": "Needs Delivery"}


@pytest.mark.parametrize("gross,covered", [(100, 0.80), (1000, 9), (100, 1)])
def test_settling_a_small_coverage_with_net_cash_keeps_the_cash(gross, covered):
    old = _small_cover(gross, covered)
    net = round(gross - covered, 2)
    kept = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": net, "amountLocal": round(net * 5, 2)})
    assert kept["amountUSD"] == net
    stripped = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": gross, "amountLocal": gross * 5})
    assert stripped["amountUSD"] == net


def test_large_coverage_settle_readings_are_unchanged():
    old = _small_cover(100, 40)
    assert _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 100})["amountUSD"] == 60
    assert _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 99.5})["amountUSD"] == 59.5
    assert _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 60})["amountUSD"] == 60
    with pytest.raises(HTTPException) as refused:
        _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 80})
    assert refused.value.status_code == 409


# ---------------------------------------------------------------- unit: finding 3

@pytest.mark.parametrize("spelling", ["Cancelled", "cancelled", "Canceled"])
def test_cancelled_spelling_reads_the_real_spend(spelling):
    ad = {"status": spelling, "amountUSD": 100.0, "spentUSD": 30.0,
          "paymentStatus": "Not Paid", "receiptAllocations": []}
    assert ad_effective_spend_minor(ad) == 3000
    assert coverable_ad_debt_detail(ad) == ("coverable", 3000)
    assert main._financial_status_aware_ad_spend(ad) == 3000


# ---------------------------------------------------------------- API

def _seed_admin() -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,'Admin',:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": "r3mm admin", "email": ADMIN_EMAIL, "perms": json_dumps({}),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    return uid


@pytest.fixture(scope="module")
def admin():
    init_db()
    _seed_admin()
    r = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _phone(value: str) -> str:
    return f"09{int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], 'big') % 100_000_000:08d}"


def _create(collection: str, entity_id: str, data: dict, cookies) -> dict:
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _entity(collection: str, entity_id: str, cookies) -> dict:
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _post(path: str, rid: str, key: str, data: dict, cookies):
    receipt = _entity("receipts", rid, cookies)
    return client.post(f"/api/receipts/{rid}/{path}", json={
        "idempotencyKey": key, "expectedLastModified": receipt["lastModified"], "data": data,
    }, cookies=cookies)


def test_api_resave_and_unsettle_of_a_gross_settled_covered_receipt(admin):
    cid, rid = f"r3mm_c_{TAG}", f"r3mm_r_{TAG}"
    _create("customers", cid, {"name": cid, "phones": [_phone(cid)]}, admin)
    _create("receipts", rid, {
        "recordType": "receipt", "customerId": cid, "amountUSD": 100, "amountLocal": 500,
        "debtAmountUSD": 100, "debtAmountLocal": 500, "exchangeRate": 5, "status": "Not Paid",
        "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"},
    }, admin)
    receipt = _entity("receipts", rid, admin)
    cover = client.post(f"/api/receipts/{rid}/company-coverages", json={
        "amountMinorUSD": 4000, "idempotencyKey": f"r3mm-cover-{TAG}",
        "expectedLastModified": receipt["lastModified"], "reason": "Review loop r3 coverage",
    }, cookies=admin)
    assert cover.status_code == 200, cover.text

    rows = [{"method": "Cash (LYD)", "amount": 500, "rate": 1, "rate2": 5,
             "collectionType": "office", "deliveryPersonId": ""}]
    paid = {"status": "Paid", "isPaid": True, "deliveryStatus": "Office", "amountUSD": 100,
            "amountLocal": 500, "payments": rows, "collectionDate": "2026-09-29T10:00:00Z"}
    settled = _post("settle", rid, f"r3mm-settle-{TAG}", paid, admin)
    assert settled.status_code == 200, settled.text
    data = _entity("receipts", rid, admin)["data"]
    assert (data["amountUSD"], data["amountLocal"]) == (60, 300), data

    # The full form re-saves the Paid receipt from its stored gross rows.
    resaved = _post("settle", rid, f"r3mm-resave-{TAG}", {**paid, "notes": "phone fixed"}, admin)
    assert resaved.status_code == 200, resaved.text
    data = _entity("receipts", rid, admin)["data"]
    assert (data["amountUSD"], data["amountLocal"]) == (60, 300), data   # before: 100 -> $40 free credit
    assert _financial_due_total(data) == 10000

    # The form's debt conversion: Not Paid rows become the collection plan.
    unsettled = _post("unsettle", rid, f"r3mm-unsettle-{TAG}", {
        "status": "Not Paid", "isPaid": False, "amountUSD": 100, "amountLocal": 500,
        "payments": [], "plannedPayments": rows,
    }, admin)
    assert unsettled.status_code == 200, unsettled.text
    data = _entity("receipts", rid, admin)["data"]
    assert data["amountUSD"] == 100 and data["customerOutstandingUSD"] == 60, data   # before: 140 / 100


def test_api_customer_coverage_of_a_cancelled_spelling_ad(admin):
    cid, aid = f"r3mm_cc_{TAG}", f"r3mm_ad_{TAG}"
    _create("customers", cid, {"name": cid, "phones": [_phone(cid)]}, admin)
    now = now_ms()
    ad = {"id": aid, "recordType": "ad", "customerId": cid, "customerName": cid,
          "paymentStatus": "not_paid", "isPaid": False, "collectionMethod": "in_shop",
          "exchangeRate": 5, "status": "Cancelled", "amountUSD": 100.0, "amountLocal": 500.0,
          "spentUSD": 30.0, "dueAllocations": [], "receiptAllocations": [],
          "_created": now, "_lastModified": now, "_deleted": False}
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:id,:data,false,:now,NULL,:now)"),
                     {"id": aid, "data": json_dumps(ad), "now": now})
    r = client.post(f"/api/customers/{cid}/company-coverages", json={
        "amountMinorUSD": 3000, "idempotencyKey": f"r3mm-ccover-{TAG}",
        "expectedOutstandingMinorUSD": 3000, "reason": "Company absorbs the cancelled ad's spend",
    }, cookies=admin)
    assert r.status_code == 200, r.text   # before: 409 (server read the whole $100 budget as spend)
    assert float(_entity("ads", aid, admin)["data"]["companyDirectCoverageUSD"]) == 30.0
