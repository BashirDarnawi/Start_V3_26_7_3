"""Review loop round 6, batch R: receipt screens.

Behaviour tests for the server half of the batch; each one failed before its fix:

* 1  a delivery completion stores payment rows whose Rate 2 reproduces the credited dollars, so
     a later no-op office edit (the form re-derives amountUSD from those rows) can no longer
     raise the customer's USD credit through /settle;
* 3  a writer without customers.viewContacts (who never receives phoneNumber / deliveryPlaceName)
     cannot blank them: the generic PATCH and /settle keep the stored values;
* 6  an office Not Paid receipt switched to Delivery by an edit gets its D-number, so the
     verified-completion guards (keyed on tempReceiptNo) cover the new job;
* 2/7 the refusal texts the receipt form can meet are translated by the client refusal map.

The client halves are in scripts/test-review-regressions.js ("r6 R").
Users are made here with unique emails; every record made here is soft-deleted at the end.
Run: python -m pytest server/test_review_loop_r6_R.py -q
"""

import os
import re
import secrets
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.settlement_truth import apply_delivery_completion_truth


ROOT = Path(__file__).parent.parent
client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.76", 50000))
PW = "ReviewLoopR6RPassword1!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
PROOF = "data:image/jpeg;base64,YQ=="
_MADE: list[str] = []


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name: str, role: str, permissions: dict) -> dict:
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    uid = new_id("user")
    email = f"r6r-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": stamp},
        )
    return {"id": uid, "email": email, "cookies": _login(email)}


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin = _user("admin", "Admin", {})
    out = {
        "admin": admin,
        "driver": _user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
        # The built-in Accountant preset: receipts add/edit, customers view/viewBalance, no viewContacts.
        "accountant": _user("accountant", "Employee", {"receipts": ["view", "add", "edit"], "customers": ["view", "viewBalance"]}),
        "editor": _user("editor", "Employee", {"receipts": ["view", "add", "edit"], "customers": ["view", "viewContacts"]}),
    }
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"R6 R Customer {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}},
        cookies=admin["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    _MADE.append(out["customer_id"])
    yield out
    # Soft-delete everything made here so later modules never see these receipts or jobs.
    with db_conn() as conn:
        for rid in _MADE:
            conn.execute(text("UPDATE entities SET deleted = true WHERE id = :id"), {"id": rid})


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


def _patch(actors, who: str, receipt_id: str, data: dict, expected: int | None = None):
    body = {"data": data}
    if expected is not None:
        body["expectedLastModified"] = expected
    return client.patch(f"{RECEIPTS}/{receipt_id}", json=body, cookies=actors[who]["cookies"])


# ---- n=1: completion rows reproduce the credited dollars -------------------------------------

def _complete_unit(payments: list[dict], collected_lyd: float) -> dict:
    old = {"deliveryStatus": "In Progress", "status": "Not Paid", "isPaid": False, "exchangeRate": 9.7}
    merged = dict(old, deliveryStatus="Delivered", amountCollectedFromCustomer=collected_lyd, payments=payments)
    apply_delivery_completion_truth(
        "r6r-receipt", old, merged, [],
        delivery_collection_target=lambda receipt_id, row, ads: {"usdMinor": 10000, "localMinor": 97000, "source": "receipt_amount"},
        valid_rate=lambda value: Decimal(str(value)) if value else None,
        overpay_abs_local=50.0, overpay_ratio=1.5,
    )
    return merged


def test_1_completion_rows_carry_the_rate_the_dollars_were_credited_at():
    # The driver's row was seeded with today's default rate 9.5; the receipt's rate is 9.7.
    merged = _complete_unit([{"method": "Cash (LYD)", "amount": 970, "rate": 1, "rate2": 9.5, "collectionType": "delivery"}], 970)
    assert merged["amountUSD"] == 100.0
    assert merged["payments"][0]["rate2"] == 9.7
    assert merged["payments"][0]["collectionType"] == "delivery"
    assert main._receipt_payments_credit_minor(merged["payments"]) in {10000, 10001}  # before: 10211 ($102.11)
    # A dollar row (Rate 1 = the receipt rate) converts back to the same dollars.
    usd = _complete_unit([{"method": "Cash (USD)", "amount": 100, "rate": 9.7, "rate2": 10}], 970)
    assert main._receipt_payments_credit_minor(usd["payments"]) in {10000, 10001}  # before: 9700


def test_1_a_no_op_office_edit_after_completion_cannot_raise_the_credit(actors):
    receipt = _create(actors, status="Not Paid", isPaid=False, amountUSD=100, amountLocal=970, exchangeRate=9.7,
                      debtAmountLocal=970, debtAmountUSD=100, tempReceiptNo="D" + _number(), deliveryStatus="Needs Delivery",
                      deliveryPersonId=actors["driver"]["id"], isReceivedInOffice=False, deliveryPlaceName="Tripoli",
                      statusDetail={"notPaidCollection": "delivery"})
    assert _patch(actors, "driver", receipt["id"], {"deliveryStatus": "In Progress"}).status_code == 200
    done = _patch(actors, "driver", receipt["id"], {
        "deliveryStatus": "Delivered", "finalReceiptNo": _number(), "receiptImage": PROOF,
        "amountCollectedFromCustomer": 970, "actualDeliveryFeeCollected": 0,
        "payments": [{"method": "Cash (LYD)", "amount": 970, "rate": 1, "rate2": 9.5, "collectionType": "delivery"}],
    })
    assert done.status_code == 200, done.text
    stored = done.json()
    assert stored["data"]["status"] == "Paid" and stored["data"]["amountUSD"] == 100.0
    # The receipt form re-derives the money from the stored rows (ceil(970 / Rate 2) + the house cent).
    edit = client.post(f"/api/receipts/{receipt['id']}/settle", json={
        "expectedLastModified": stored["lastModified"], "idempotencyKey": "r6r-" + secrets.token_hex(8),
        "data": {"status": "Paid", "amountUSD": 102.12, "amountLocal": 970, "exchangeRate": 9.5,
                 "deliveryStatus": "Delivered", "payments": stored["data"]["payments"]},
    }, cookies=actors["admin"]["cookies"])
    assert edit.status_code == 409, edit.text  # before: 200 and $2.12 of credit nobody paid for
    assert "cannot be increased" in edit.text
    assert _get(actors, receipt["id"])["data"]["amountUSD"] == 100.0


# ---- n=3: hidden contact fields survive an edit ------------------------------------------------

def test_3_staff_without_view_contacts_cannot_blank_the_stored_phone_or_place(actors):
    receipt = _create(actors, status="Paid", isPaid=True, amountUSD=100, amountLocal=500, exchangeRate=5,
                      serialNumber=_number(), phoneNumber="0912345678", deliveryPlaceName="Hay Andalus",
                      payments=[{"method": "Cash (LYD)", "amount": 500, "rate": 1, "rate2": 5}])
    # What they receive has no contact fields at all.
    seen = client.get(f"{RECEIPTS}/{receipt['id']}", cookies=actors["accountant"]["cookies"])
    assert seen.status_code == 200, seen.text
    assert "phoneNumber" not in seen.json()["data"] and "deliveryPlaceName" not in seen.json()["data"]
    patched = _patch(actors, "accountant", receipt["id"], {"status": "Paid", "phoneNumber": "", "deliveryPlaceName": "",
                                                           "amountUSD": 100}, seen.json()["lastModified"])
    assert patched.status_code == 200, patched.text
    after = _get(actors, receipt["id"])["data"]
    assert after["phoneNumber"] == "0912345678"  # before: ''
    assert after["deliveryPlaceName"] == "Hay Andalus"
    # The same through the settle endpoint (Not Paid -> Paid).
    debt = _create(actors, status="Not Paid", isPaid=False, amountUSD=50, amountLocal=250, exchangeRate=5,
                   phoneNumber="0923456789", deliveryPlaceName="Souq", statusDetail={"notPaidCollection": "office"},
                   deliveryStatus="Office")
    settled = client.post(f"/api/receipts/{debt['id']}/settle", json={
        "expectedLastModified": debt["lastModified"], "idempotencyKey": "r6r-" + secrets.token_hex(8),
        "data": {"status": "Paid", "serialNumber": _number(), "phoneNumber": "", "deliveryPlaceName": "",
                 "payments": [{"method": "Cash (LYD)", "amount": 250, "rate": 1, "rate2": 5}]},
    }, cookies=actors["accountant"]["cookies"])
    assert settled.status_code == 200, settled.text
    after = _get(actors, debt["id"])["data"]
    assert after["phoneNumber"] == "0923456789" and after["deliveryPlaceName"] == "Souq"
    # A value they actually type is still written, and a writer who can see contacts changes them freely.
    fresh = _get(actors, receipt["id"])
    typed = _patch(actors, "accountant", receipt["id"], {"phoneNumber": "0940000000"}, fresh["lastModified"])
    assert typed.status_code == 200, typed.text
    assert _get(actors, receipt["id"])["data"]["phoneNumber"] == "0940000000"
    fresh = _get(actors, receipt["id"])
    changed = _patch(actors, "editor", receipt["id"], {"phoneNumber": "0931111111", "deliveryPlaceName": ""}, fresh["lastModified"])
    assert changed.status_code == 200, changed.text
    assert _get(actors, receipt["id"])["data"]["phoneNumber"] == "0931111111"
    assert _get(actors, receipt["id"])["data"]["deliveryPlaceName"] == ""


# ---- n=6: an office receipt switched to Delivery gets its D-number ------------------------------

def test_6_an_office_receipt_switched_to_delivery_gets_a_d_number_and_the_completion_guard(actors):
    receipt = _create(actors, status="Not Paid", isPaid=False, amountUSD=100, amountLocal=500, exchangeRate=5,
                      statusDetail={"notPaidCollection": "office"}, deliveryStatus="Office", tempReceiptNo="")
    assert not receipt["data"].get("tempReceiptNo")
    # What the receipt form sends when the office picks "Delivery" (the D-number is left to the server).
    switched = _patch(actors, "editor", receipt["id"], {
        "status": "Not Paid", "isPaid": False, "statusDetail": {"notPaidCollection": "delivery"},
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["driver"]["id"], "tempReceiptNo": "",
        "deliveryPlaceName": "Tripoli", "quotedDeliveryFee": 10,
    }, receipt["lastModified"])
    assert switched.status_code == 200, switched.text
    temp_no = switched.json()["data"].get("tempReceiptNo") or ""
    assert re.fullmatch(r"D[0-9]+", temp_no), switched.json()["data"]  # before: ''
    # Staff can no longer mark the job delivered around the verified completion workflow.
    bypass = client.post(f"/api/receipts/{receipt['id']}/settle", json={
        "expectedLastModified": switched.json()["lastModified"], "idempotencyKey": "r6r-" + secrets.token_hex(8),
        "data": {"status": "Paid", "deliveryStatus": "Delivered", "statusDetail": {"paidCollection": "delivery"},
                 "serialNumber": _number(), "payments": [{"method": "Cash (LYD)", "amount": 500, "rate": 1, "rate2": 5}]},
    }, cookies=actors["editor"]["cookies"])
    assert bypass.status_code == 403, bypass.text  # before: 200 with no proof photo or final number
    # An edit that keeps the job keeps its number.
    again = _patch(actors, "editor", receipt["id"], {"statusDetail": {"notPaidCollection": "delivery"}, "status": "Not Paid",
                                                      "tempReceiptNo": temp_no, "deliveryStatus": "Needs Delivery"},
                   switched.json()["lastModified"])
    assert again.status_code == 200, again.text
    assert again.json()["data"]["tempReceiptNo"] == temp_no


# ---- n=2/7: the refusals the receipt form meets are translated ----------------------------------

def _client_refusal_rules() -> list[tuple[str, str]]:
    source = (ROOT / "src" / "08-data-audit.js").read_text(encoding="utf-8")
    block = source.split("const _SERVER_REFUSAL_AR = [", 1)[1].split("\n];", 1)[0]
    rules = []
    for line in block.splitlines():
        line = line.strip()
        regex = re.match(r"^\[/(.+?)/, '", line)
        if regex:
            rules.append(("regex", regex.group(1)))
            continue
        prefix = re.match(r"""^\[(['"])(.+?)\1, '""", line)
        if prefix:
            rules.append(("prefix", prefix.group(2)))
    return rules


def test_2_7_receipt_form_refusals_are_in_the_client_refusal_map():
    main_src = (ROOT / "server" / "main.py").read_text(encoding="utf-8")
    plan_src = (ROOT / "server" / "unpaid_receipt_payment_plan.py").read_text(encoding="utf-8")
    details = [
        "Reassign a paid receipt's customer through the receipt transfer endpoint",
        "A canceled receipt the company already covered cannot be reopened; record a new receipt",
        "Insufficient available receipt balance",
    ]
    for detail in details:
        assert f'"{detail}"' in main_src, f"server text changed: {detail}"
    normal_edit = "A Paid receipt cannot be changed to Not Paid with a normal edit. "
    assert f'"{normal_edit}"' in plan_src
    details.append(normal_edit + "Use the dedicated receipt debt-conversion action.")
    rules = _client_refusal_rules()
    missing = [d for d in details if not any(
        (kind == "prefix" and d.startswith(p)) or (kind == "regex" and re.search(p, d)) for kind, p in rules)]
    assert not missing, missing
