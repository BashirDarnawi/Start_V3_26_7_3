"""Review loop round 7, batch S: covered Paid receipt re-save (finding 11).

Round 3 (batch MM) taught the paid->paid re-save branch of
apply_coverage_settlement_truth to net a GROSS re-save (the form re-derives
amountUSD from gross-prefilled payment rows). But it read ANY total at or
above the gross band as "the gross". A covered receipt settled with the
customer's NET cash rows ($60 of a $100 receipt, $40 company-covered) that
later got a real top-up row in the Split Payments editor then lost the
company share a second time: +$50 saved 70 instead of 110, +$39.50 saved
59.50 (the cash went DOWN after money was added). The raise guard accepted
it because the rows back more than that, so real customer money vanished.

The stored payment rows now decide: when they are the net cash, the new
total derived from them is cash too; gross rows (or no rows) keep the
round-3 netting.
"""

import hashlib
import os
import secrets

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server import main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.financial_core import _financial_due_total
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.settlement_truth import apply_coverage_settlement_truth

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r7s-admin-{TAG}@tests.albayanhub.com"
PASSWORD = "ReviewLoopR7s123!"


def _row(lyd, rate2=4.9):
    return {"method": "Cash (LYD)", "amount": lyd, "rate": 1, "rate2": rate2}


def _apply(old, merged):
    # Exactly what main.py's atomic receipt patch passes.
    apply_coverage_settlement_truth(
        old, merged, due_total=_financial_due_total,
        old_rows_minor=main._receipt_payments_credit_minor(old.get("payments")),
    )
    return merged


def _covered_office_receipt():
    # Gross $100 (490 LYD at 4.9), of which the company covered $40.
    return {"recordType": "receipt", "status": "Not Paid", "isPaid": False,
            "amountUSD": 100, "amountLocal": 490, "debtAmountUSD": 100, "debtAmountLocal": 490,
            "exchangeRate": 4.9, "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
            "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}


def _settled_with(rows, amount_usd, amount_local):
    old = _covered_office_receipt()
    return _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": amount_usd,
                        "amountLocal": amount_local, "payments": rows})


def _top_up(settled, rows):
    total = round(sum(r["amount"] for r in rows) / 4.9, 2)
    return _apply(settled, {**settled, "payments": rows, "amountUSD": total,
                            "amountLocal": sum(r["amount"] for r in rows)})


# ---------------------------------------------------------------- unit

def test_net_cash_rows_settle_keeps_the_cash():
    settled = _settled_with([_row(294)], 60, 294)
    assert (settled["amountUSD"], settled["amountLocal"]) == (60, 294)
    assert _financial_due_total(settled) == 10000


@pytest.mark.parametrize("extra_lyd,expected_usd", [
    (49, 70.0),       # +$10 (the old rule got this one right)
    (193.55, 99.5),   # +$39.50: the old rule saved 59.50 - the cash went DOWN
    (245, 110.0),     # +$50: the old rule saved 70 - $40 of real money lost
])
def test_a_real_top_up_on_net_cash_rows_stays_the_customers_cash(extra_lyd, expected_usd):
    settled = _settled_with([_row(294)], 60, 294)
    raised = _top_up(settled, [_row(294), _row(extra_lyd)])
    assert raised["amountUSD"] == expected_usd
    assert raised["amountUSD"] >= settled["amountUSD"]
    # Capacity = customer cash + the company share, every cash cent row-backed.
    assert _financial_due_total(raised) == round(expected_usd * 100) + 4000
    assert raised["customerOutstandingUSD"] == 0


def test_net_cash_rows_edited_down_keep_the_typed_cash():
    settled = _settled_with([_row(294)], 60, 294)
    lowered = _top_up(settled, [_row(245)])
    assert lowered["amountUSD"] == 50.0


def test_gross_rows_resave_and_top_up_still_net_the_company_share():
    gross_rows = [_row(490)]
    settled = _settled_with(gross_rows, 100, 490)
    assert settled["amountUSD"] == 60.0
    resaved = _apply(settled, {**settled, "amountUSD": 100, "amountLocal": 490, "notes": "phone fixed"})
    assert resaved["amountUSD"] == 60.0            # no free credit (round-3 finding 1)
    topped = _top_up(settled, gross_rows + [_row(49)])
    assert topped["amountUSD"] == 70.0             # +$10 real money on gross rows
    assert _financial_due_total(topped) == 11000


def test_no_stored_rows_keeps_the_round_3_fallback():
    old = _covered_office_receipt()
    settled = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 60, "amountLocal": 294})
    assert settled["amountUSD"] == 60
    resaved = _apply(settled, {**settled, "amountUSD": 100, "amountLocal": 490})
    assert resaved["amountUSD"] == 60.0            # an unbacked gross re-save still nets


# ---------------------------------------------------------------- API

def _seed_admin() -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,'Admin',:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": "r7s admin", "email": ADMIN_EMAIL, "perms": json_dumps({}),
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


def _covered_settled_receipt(suffix: str, rows: list, amount_usd, amount_local, cookies) -> str:
    cid, rid = f"r7s_c_{suffix}_{TAG}", f"r7s_r_{suffix}_{TAG}"
    _create("customers", cid, {"name": cid, "phones": [_phone(cid)]}, cookies)
    _create("receipts", rid, {
        "recordType": "receipt", "customerId": cid, "amountUSD": 100, "amountLocal": 500,
        "debtAmountUSD": 100, "debtAmountLocal": 500, "exchangeRate": 5, "status": "Not Paid",
        "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"},
    }, cookies)
    receipt = _entity("receipts", rid, cookies)
    cover = client.post(f"/api/receipts/{rid}/company-coverages", json={
        "amountMinorUSD": 4000, "idempotencyKey": f"r7s-cover-{suffix}-{TAG}",
        "expectedLastModified": receipt["lastModified"], "reason": "Review loop r7 coverage",
    }, cookies=cookies)
    assert cover.status_code == 200, cover.text
    receipt = _entity("receipts", rid, cookies)
    settled = client.post(f"/api/receipts/{rid}/settle", json={
        "idempotencyKey": f"r7s-settle-{suffix}-{TAG}", "expectedLastModified": receipt["lastModified"],
        "data": {"status": "Paid", "isPaid": True, "deliveryStatus": "Office", "amountUSD": amount_usd,
                 "amountLocal": amount_local, "payments": rows, "collectionDate": "2026-09-29T10:00:00Z"},
    }, cookies=cookies)
    assert settled.status_code == 200, settled.text
    return rid


def _split_payments_save(rid: str, rows: list, cookies):
    # The Split Payments editor (saveSplitPayments) PATCHes the rows and the
    # totals it derives from them.
    receipt = _entity("receipts", rid, cookies)
    total_local = sum(r["amount"] for r in rows)
    return client.patch(f"/api/collections/receipts/{rid}", json={
        "expectedLastModified": receipt["lastModified"],
        "data": {"payments": rows, "paymentMethod": "Split Payment" if len(rows) > 1 else rows[0]["method"],
                 "amountLocal": total_local, "amountUSD": round(total_local / 5, 2), "exchangeRate": 5},
    }, cookies=cookies)


def _office_row(lyd):
    return {"method": "Cash (LYD)", "amount": lyd, "rate": 1, "rate2": 5,
            "collectionType": "office", "deliveryPersonId": ""}


def test_api_top_up_on_a_net_cash_settled_covered_receipt_keeps_the_money(admin):
    rid = _covered_settled_receipt("net", [_office_row(300)], 60, 300, admin)
    data = _entity("receipts", rid, admin)["data"]
    assert (data["amountUSD"], data["amountLocal"]) == (60, 300), data

    # The customer brings $50 more; staff add it as a second payment row.
    r = _split_payments_save(rid, [_office_row(300), _office_row(250)], admin)
    assert r.status_code == 200, r.text
    data = _entity("receipts", rid, admin)["data"]
    assert (data["amountUSD"], data["amountLocal"]) == (110, 550), data   # before: 70 -> $40 lost
    assert _financial_due_total(data) == 15000


def test_api_top_up_on_a_gross_settled_covered_receipt_still_nets(admin):
    rid = _covered_settled_receipt("gross", [_office_row(500)], 100, 500, admin)
    data = _entity("receipts", rid, admin)["data"]
    assert (data["amountUSD"], data["amountLocal"]) == (60, 300), data

    r = _split_payments_save(rid, [_office_row(500), _office_row(50)], admin)
    assert r.status_code == 200, r.text
    data = _entity("receipts", rid, admin)["data"]
    assert data["amountUSD"] == 70, data                                  # +$10 real money, no free $40
    assert _financial_due_total(data) == 11000
