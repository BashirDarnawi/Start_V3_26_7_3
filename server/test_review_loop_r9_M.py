"""Review loop round 9, batch M: company-covered receipt money (settlement_truth.py).

Each test failed before its fix:

* 1  a covered receipt paid in the office with the gross rows, whose delivery was then
     canceled (or delivered), stored the GROSS again as customer cash on a later re-save
     (free credit = the company share). Driver-collected cash is still kept.
* 2  lowering or re-rating a payment row on a gross-settled covered receipt kept the new
     rows total as cash (cash went UP though the office typed less money): now refused.
* 3  settling with the customer's exact net cash was refused when the net has cents,
     because the form adds a house cent.
* 4  a Not Paid receipt could be lowered below its (unassigned) company coverage and then
     settled for more credit than its gross.
* 5  a delivery completion row with Rate 1 of 0 (clamped to 0.001 by sanitize_json) got
     Rate 2 = trusted / 0.001, outside the valid range, so the receipt's rows backed nothing.

Users are made here with unique emails; every record made here is soft-deleted at the end.
Run: python -m pytest server/test_review_loop_r9_M.py -q
"""

import os
import secrets
from decimal import Decimal

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server import main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.financial_core import _financial_due_total
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.settlement_truth import _row_rate2_at, apply_coverage_settlement_truth

client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.91", 50000))
TAG = secrets.token_hex(4)
PW = "ReviewLoopR9MPassword1!"
RECEIPTS = "/api/collections/receipts"
PROOF = "data:image/jpeg;base64,YQ=="
_MADE: list[str] = []


def _apply(old, merged):
    # Exactly what main.py's atomic receipt patch passes.
    apply_coverage_settlement_truth(
        old, merged, due_total=_financial_due_total,
        old_rows_minor=main._receipt_payments_credit_minor(old.get("payments")),
    )
    return merged


def _row(lyd, rate2=7):
    return {"method": "Cash (LYD)", "amount": lyd, "rate": 1, "rate2": rate2}


# ---------------------------------------------------------------- n=1 (unit)

def _covered_delivery_receipt():
    # $100 (700 LYD at 7), the company covered $30; the driver already accepted the job.
    return {"recordType": "receipt", "status": "Not Paid", "isPaid": False,
            "amountUSD": 100, "amountLocal": 700, "debtAmountUSD": 100, "debtAmountLocal": 700,
            "exchangeRate": 7, "companyCoveredUSD": 30, "customerOutstandingUSD": 70,
            "deliveryStatus": "In Progress", "statusDetail": {"notPaidCollection": "delivery"}}


def _paid_in_office_with_gross_rows():
    old = _covered_delivery_receipt()
    settled = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 100,
                           "amountLocal": 700, "payments": [_row(700)]})
    assert settled["amountUSD"] == 70.0
    return settled


def test_1_a_canceled_delivery_resave_of_the_gross_rows_mints_no_credit():
    settled = _paid_in_office_with_gross_rows()
    canceled = _apply(settled, {**settled, "deliveryStatus": "Canceled"})
    assert canceled["amountUSD"] == 70.0
    # A phone / note fix: the form re-derives $100 from the gross rows.
    resaved = _apply(canceled, {**canceled, "amountUSD": 100, "amountLocal": 700, "notes": "phone fixed"})
    assert resaved["amountUSD"] == 70.0                    # before: 100
    assert _financial_due_total(resaved) == 10000          # before: 13000 ($30 nobody paid)


def test_1_a_delivered_office_paid_receipt_nets_a_top_up_on_gross_rows():
    settled = _paid_in_office_with_gross_rows()
    delivered = {**settled, "deliveryStatus": "Delivered"}
    topped = _apply(delivered, {**delivered, "payments": [_row(700), _row(70)],
                                "amountUSD": 110, "amountLocal": 770})
    assert topped["amountUSD"] == 80.0                     # before: 110
    assert _financial_due_total(topped) == 11000           # before: 14000


def test_1_driver_collected_cash_is_still_kept():
    # A driver completion rewrote the rows to back exactly the collected $70.
    delivered = {**_covered_delivery_receipt(), "status": "Paid", "isPaid": True, "deliveryStatus": "Delivered",
                 "amountUSD": 70, "amountLocal": 490, "payments": [_row(490)]}
    topped = _apply(delivered, {**delivered, "payments": [_row(490), _row(70)], "amountUSD": 80, "amountLocal": 560})
    assert topped["amountUSD"] == 80
    # A legacy delivered receipt with no rows keeps the typed cash (round 3 behaviour).
    legacy = {**delivered, "payments": []}
    assert _apply(legacy, {**legacy, "amountUSD": 100, "amountLocal": 700})["amountUSD"] == 100


# ---------------------------------------------------------------- n=2 (unit)

@pytest.mark.parametrize("rows,amount_usd", [
    ([_row(700, 7.4)], 94.6),     # Rate 2 corrected on the same LYD: before cash 94.60, pot 124.60
    ([_row(665)], 95),            # a row lowered: before cash 95, pot 125
    ([_row(560)], 80),            # before cash 80, pot 110
])
def test_2_lowering_or_re_rating_gross_rows_cannot_raise_the_cash(rows, amount_usd):
    settled = {**_paid_in_office_with_gross_rows(), "deliveryStatus": "Office"}
    with pytest.raises(HTTPException) as refused:
        _apply(settled, {**settled, "payments": rows, "amountUSD": amount_usd,
                         "amountLocal": sum(r["amount"] for r in rows)})
    assert refused.value.status_code == 409


def test_2_gross_rows_retyped_as_the_net_cash_or_topped_up_still_work():
    settled = {**_paid_in_office_with_gross_rows(), "deliveryStatus": "Office"}
    net = _apply(settled, {**settled, "payments": [_row(490)], "amountUSD": 70, "amountLocal": 490})
    assert net["amountUSD"] == 70                          # not stripped a second time
    resaved = _apply(settled, {**settled, "amountUSD": 100, "amountLocal": 700})
    assert resaved["amountUSD"] == 70.0
    topped = _apply(settled, {**settled, "payments": [_row(700), _row(70)], "amountUSD": 110, "amountLocal": 770})
    assert topped["amountUSD"] == 80.0


# ---------------------------------------------------------------- n=3 (unit)

def _office_receipt(amount_usd, covered_usd):
    return {"recordType": "receipt", "status": "Not Paid", "isPaid": False,
            "amountUSD": amount_usd, "amountLocal": amount_usd * 7, "exchangeRate": 7,
            "companyCoveredUSD": covered_usd, "deliveryStatus": "Office",
            "statusDetail": {"notPaidCollection": "office"}}


def test_3_the_exact_net_cash_with_the_house_cent_settles():
    old = _office_receipt(100, 30.5)
    # 486.5 LYD at 7 = 69.50; the form sends 69.51 (its house cent).
    kept = _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 69.51, "amountLocal": 486.5})
    assert kept["amountUSD"] == 69.51                      # before: 409
    assert kept["customerOutstandingUSD"] == 0
    assert _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 69.5})["amountUSD"] == 69.5
    assert _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 100})["amountUSD"] == 69.5
    with pytest.raises(HTTPException) as refused:
        _apply(old, {**old, "status": "Paid", "isPaid": True, "amountUSD": 69.52})
    assert refused.value.status_code == 409


# ---------------------------------------------------------------- n=4 (unit)

def test_4_a_not_paid_covered_receipt_cannot_go_below_its_coverage():
    old = _office_receipt(100, 30)
    with pytest.raises(HTTPException) as refused:
        _apply(old, {**old, "amountUSD": 20, "amountLocal": 140})
    assert refused.value.status_code == 409
    assert refused.value.detail.startswith("The company already covered $30.00")
    # Down to the covered amount itself is still allowed.
    assert _apply(old, {**old, "amountUSD": 30, "amountLocal": 210})["customerOutstandingUSD"] == 0
    # Second defence: a receipt already stored under its coverage cannot be settled into free credit.
    broken = _office_receipt(20, 30)
    with pytest.raises(HTTPException) as refused:
        _apply(broken, {**broken, "status": "Paid", "isPaid": True})
    assert refused.value.status_code == 409


# ---------------------------------------------------------------- n=5 (unit)

def test_5_a_rate_1_of_zero_or_a_microscopic_rate_1_backs_no_dollars():
    assert _row_rate2_at({"method": "Sadad", "rate": 0.001}, Decimal("9.7")) == 0.0      # before: 9700.0
    assert _row_rate2_at({"method": "Libyana", "rate": "1e-400"}, Decimal("7")) == 0.0   # before: inf
    assert _row_rate2_at({"method": "Libyana", "rate": 0.7}, Decimal("7")) == 10.0
    assert _row_rate2_at({"method": "Cash (USD)", "rate": 7}, Decimal("7")) == 7.0


# ---------------------------------------------------------------- API

def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name: str, role: str, permissions: dict) -> dict:
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    email = f"r9m-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()},
        )
    return {"id": uid, "email": email, "cookies": _login(email)}


@pytest.fixture(scope="module")
def actors():
    init_db()
    out = {
        "admin": _user("admin", "Admin", {}),
        "driver": _user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
    }
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"R9 M Customer {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}},
        cookies=out["admin"]["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    _MADE.append(out["customer_id"])
    yield out
    with db_conn() as conn:
        for entity_id in _MADE:
            conn.execute(text("UPDATE entities SET deleted = true WHERE id = :id"), {"id": entity_id})


def _number() -> str:
    return str(secrets.randbelow(9 * 10**8) + 10**8)


def _create(actors, **data) -> dict:
    body = {"recordType": "receipt", "customerId": actors["customer_id"], **data}
    created = client.post(RECEIPTS, json={"data": body}, cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    _MADE.append(created.json()["id"])
    return created.json()


def _get(actors, receipt_id: str) -> dict:
    response = client.get(f"{RECEIPTS}/{receipt_id}", cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _patch(actors, who: str, receipt_id: str, data: dict):
    return client.patch(f"{RECEIPTS}/{receipt_id}", json={"data": data}, cookies=actors[who]["cookies"])


def _cover(actors, receipt_id: str, minor: int) -> None:
    receipt = _get(actors, receipt_id)
    cover = client.post(f"/api/receipts/{receipt_id}/company-coverages", json={
        "amountMinorUSD": minor, "idempotencyKey": f"r9m-cover-{secrets.token_hex(6)}",
        "expectedLastModified": receipt["lastModified"], "reason": "Review loop r9 coverage",
    }, cookies=actors["admin"]["cookies"])
    assert cover.status_code == 200, cover.text


def _delivery_receipt(actors, **extra) -> dict:
    return _create(actors, status="Not Paid", isPaid=False, amountUSD=100, amountLocal=700, exchangeRate=7,
                   debtAmountLocal=700, debtAmountUSD=100, tempReceiptNo="D" + _number(),
                   deliveryStatus="Needs Delivery", deliveryPersonId=actors["driver"]["id"],
                   isReceivedInOffice=False, deliveryPlaceName="Tripoli",
                   statusDetail={"notPaidCollection": "delivery"}, **extra)


def test_1_api_paid_in_office_then_driver_canceled_then_a_note_edit(actors):
    receipt = _delivery_receipt(actors)
    _cover(actors, receipt["id"], 3000)
    assert _patch(actors, "driver", receipt["id"], {"deliveryStatus": "In Progress"}).status_code == 200
    stored = _get(actors, receipt["id"])
    settled = client.post(f"/api/receipts/{receipt['id']}/settle", json={
        "expectedLastModified": stored["lastModified"], "idempotencyKey": "r9m-" + secrets.token_hex(8),
        "data": {"status": "Paid", "isPaid": True, "amountUSD": 100, "amountLocal": 700,
                 "payments": [{**_row(700), "collectionType": "office", "deliveryPersonId": ""}]},
    }, cookies=actors["admin"]["cookies"])
    assert settled.status_code == 200, settled.text
    assert _get(actors, receipt["id"])["data"]["amountUSD"] == 70.0
    canceled = _patch(actors, "driver", receipt["id"], {"deliveryStatus": "Canceled",
                                                        "deliveryCancelReason": "Customer not home"})
    assert canceled.status_code == 200, canceled.text
    assert canceled.json()["data"]["status"] == "Paid"
    edit = _patch(actors, "admin", receipt["id"], {"notes": "phone fixed", "amountUSD": 100, "amountLocal": 700})
    assert edit.status_code == 200, edit.text
    data = _get(actors, receipt["id"])["data"]
    assert data["amountUSD"] == 70.0, data                 # before: 100
    assert _financial_due_total(data) == 10000             # before: 13000


def test_4_api_a_covered_not_paid_receipt_cannot_be_lowered_below_the_coverage(actors):
    receipt = _create(actors, status="Not Paid", isPaid=False, amountUSD=100, amountLocal=700, exchangeRate=7,
                      deliveryStatus="Office", statusDetail={"notPaidCollection": "office"})
    _cover(actors, receipt["id"], 3000)
    lowered = _patch(actors, "admin", receipt["id"], {"amountUSD": 20, "amountLocal": 140})
    assert lowered.status_code == 409, lowered.text        # before: 200, then a settle gave a $30 pot
    assert "The company already covered $30.00" in lowered.text
    assert _get(actors, receipt["id"])["data"]["amountUSD"] == 100


def test_5_api_a_zero_rate_completion_row_stores_rate_2_of_zero(actors):
    receipt = _create(actors, status="Not Paid", isPaid=False, amountUSD=100, amountLocal=970, exchangeRate=9.7,
                      debtAmountLocal=970, debtAmountUSD=100, tempReceiptNo="D" + _number(),
                      deliveryStatus="Needs Delivery", deliveryPersonId=actors["driver"]["id"],
                      isReceivedInOffice=False, deliveryPlaceName="Tripoli",
                      statusDetail={"notPaidCollection": "delivery"})
    assert _patch(actors, "driver", receipt["id"], {"deliveryStatus": "In Progress"}).status_code == 200
    done = _patch(actors, "driver", receipt["id"], {
        "deliveryStatus": "Delivered", "finalReceiptNo": _number(), "receiptImage": PROOF,
        "amountCollectedFromCustomer": 970, "actualDeliveryFeeCollected": 0,
        "payments": [{"method": "Cash (LYD)", "amount": 970, "rate": 1, "rate2": 9.5, "collectionType": "delivery"},
                     {"method": "Bank Transfer (LYD)", "amount": 500, "rate": 0, "rate2": 9.7, "collectionType": "delivery"}],
    })
    assert done.status_code == 200, done.text
    payments = _get(actors, receipt["id"])["data"]["payments"]
    assert payments[1]["rate2"] == 0.0                     # before: 9700.0
    assert main._receipt_payments_credit_minor(payments) in {10000, 10001}  # before: None
