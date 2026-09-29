"""Review loop round 5, batch DBL: double submission of money actions.

The client fixes (src/14-forms.js, src/13-filters-helpers.js, src/12-views.js) keep ONE id or
idempotency key per intended money action across retries. These tests pin the server half they
rely on, so the second request is a no-op:

* 30  a new receipt POSTed again under the same id (the manual retry after a lost reply) is a
      409 that stores nothing: still one row, same server-assigned D-number, no second debt;
* 31  a receipt balance transfer replayed with its first key, target id and the OLD source
      version after the transfer itself changed the source is a replay (replayed=true, one
      TRANSFER_IN receipt, one transfers[] row), while a NEW key with that stale version is
      still refused by the version check;
* 32  the wallet transfer replay by idempotency key is already covered by
      server/test_backend_security_hardening.py (same key -> same row).

Users are made here with unique emails; every record made here is soft-deleted at the end.
Run: python -m pytest server/test_review_loop_r5_DBL.py -q
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.75", 50000))
PW = "ReviewLoopR5DblPassword1!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
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
    email = f"r5dbl-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": stamp},
        )
    return {"id": uid, "email": email, "cookies": _login(email)}


def _customer(admin: dict, label: str) -> str:
    created = client.post("/api/collections/customers", json={"data": {
        "name": f"R5 DBL {label} {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}},
        cookies=admin["cookies"])
    assert created.status_code == 200, created.text
    _MADE.append(created.json()["id"])
    return created.json()["id"]


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin = _user("admin", "Admin", {})
    out = {
        "admin": admin,
        "driver": _user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
        "source_customer": _customer(admin, "Source"),
        "target_customer": _customer(admin, "Target"),
    }
    yield out
    # Soft-delete everything made here so later modules never see these receipts or jobs.
    with db_conn() as conn:
        for rid in _MADE:
            conn.execute(text("UPDATE entities SET deleted = true WHERE id = :id"), {"id": rid})


def _rows(where: str, params: dict) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id, data_json FROM entities WHERE type = 'receipts' AND deleted = false AND " + where),
            params,
        ).mappings().all()
    return [{"id": row["id"], **(json_loads(row["data_json"]) or {})} for row in rows]


def test_30_a_new_delivery_receipt_posted_again_under_its_id_stores_nothing(actors):
    receipt_id = f"receipt_r5dbl_{TAG}"
    # Exactly what the receipt form sends in server mode: no D-number, no type (the server fills both).
    data = {
        "recordType": "receipt", "customerId": actors["source_customer"],
        "status": "Not Paid", "isPaid": False,
        "amountUSD": 100, "amountLocal": 500, "exchangeRate": 5,
        "debtAmountLocal": 500, "debtAmountUSD": 100,
        "tempReceiptNo": "", "receiptType": "", "serialNumber": "", "finalReceiptNo": "",
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["driver"]["id"],
        "isReceivedInOffice": False, "deliveryPlaceName": "Tripoli", "quotedDeliveryFee": 10,
        "statusDetail": {"notPaidCollection": "delivery"},
        "payments": [], "plannedPayments": [],
    }
    first = client.post(RECEIPTS, json={"id": receipt_id, "data": data}, cookies=actors["admin"]["cookies"])
    assert first.status_code == 200, first.text
    _MADE.append(receipt_id)
    stored = first.json()["data"]
    assert stored["tempReceiptNo"].startswith("D") and stored["receiptType"] == "DELIVERY_TEMP"

    # The retry after a lost reply reuses the id (the client keeps one draft id per form).
    again = client.post(RECEIPTS, json={"id": receipt_id, "data": data}, cookies=actors["admin"]["cookies"])
    assert again.status_code == 409, again.text

    after = client.get(f"{RECEIPTS}/{receipt_id}", cookies=actors["admin"]["cookies"])
    assert after.status_code == 200, after.text
    assert after.json()["data"]["tempReceiptNo"] == stored["tempReceiptNo"]
    assert after.json()["lastModified"] == first.json()["lastModified"]
    jobs = _rows("id LIKE :prefix", {"prefix": f"receipt_r5dbl_{TAG}%"})
    assert len(jobs) == 1, jobs


def test_31_a_transfer_replayed_with_its_old_version_after_it_changed_the_source_moves_money_once(actors):
    admin = actors["admin"]
    source = client.post(RECEIPTS, json={"data": {
        "recordType": "receipt", "customerId": actors["source_customer"],
        "amountUSD": 500, "amountLocal": 2500, "exchangeRate": 5, "status": "Paid", "isPaid": True,
        "serialNumber": str(secrets.randbelow(9 * 10**8) + 10**8),
    }}, cookies=admin["cookies"])
    assert source.status_code == 200, source.text
    source = source.json()
    _MADE.append(source["id"])
    target_id = f"receipt_r5dbl_in_{TAG}"
    payload = {
        "sourceReceiptId": source["id"], "targetCustomerId": actors["target_customer"],
        "targetReceiptId": target_id, "amountMinorUSD": 10_000,
        "idempotencyKey": f"receipt-transfer:r5dbl-{TAG}",
        "expectedSourceLastModified": source["lastModified"], "note": "move",
    }
    first = client.post("/api/receipts/transfers", json=payload, cookies=admin["cookies"])
    assert first.status_code == 200, first.text
    _MADE.append(target_id)
    assert first.json()["replayed"] is False
    new_version = first.json()["sourceReceipt"]["lastModified"]
    assert new_version != source["lastModified"]     # the transfer itself changed the source

    # The client lost that reply; live sync then brought the new version. The retry keeps the
    # first key, target id and version: the marker is checked before the version, so it replays.
    retry = client.post("/api/receipts/transfers", json=payload, cookies=admin["cookies"])
    assert retry.status_code == 200, retry.text
    assert retry.json()["replayed"] is True
    assert retry.json()["targetReceipt"]["id"] == target_id
    assert len(retry.json()["sourceReceipt"]["data"]["transfers"]) == 1

    # A brand-new key with the stale version is still refused, so nothing moves twice.
    fresh = client.post("/api/receipts/transfers", json={
        **payload, "idempotencyKey": f"receipt-transfer:r5dbl-new-{TAG}", "targetReceiptId": f"receipt_r5dbl_in2_{TAG}",
    }, cookies=admin["cookies"])
    assert fresh.status_code == 409, fresh.text

    incoming = _rows("data_json LIKE :src", {"src": f"%{source['id']}%"})
    transfer_in = [row for row in incoming if row.get("receiptType") == "TRANSFER_IN"]
    assert [row["id"] for row in transfer_in] == [target_id], transfer_in
    stored_source = client.get(f"{RECEIPTS}/{source['id']}", cookies=admin["cookies"]).json()["data"]
    assert len(stored_source["transfers"]) == 1
