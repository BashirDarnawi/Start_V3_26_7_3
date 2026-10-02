"""Bug-hunt R1 (server-data-plane-2): a customer deleted mid-save never ends up owning a record.

The receipts/ads routes refuse a deleted customer with an UNLOCKED pre-check
(_refuse_deleted_customer). An admin's delete that committed between that check and the write
left the new receipt (or the moved ad or receipt) on a deleted customer: hidden from the customer
pages and reported as missing_customer by the integrity scan. The write transaction now re-checks
the customer under a lock (main._lock_live_customer), so the late write is refused with 409.

Each case lets the admin's DELETE commit exactly in that window: after the route's pre-checks,
right before its write transaction starts.
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
from server.data_integrity import scan_database
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "DeleteRace123!"
client = TestClient(main.app, headers={"Origin": "http://testserver"})
_USERS: list[str] = []


def _user(label, role, permissions):
    uid = new_id(f"r1dr{label}")
    email = f"r1-dr-{label}-{TAG}@tests.albayanhub.com"
    pw = hash_password(PASSWORD, iterations=1000)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:n,NULL,:n)"),
            {"id": uid, "name": f"R1 {label}", "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "n": now_ms()},
        )
    _USERS.append(uid)
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "cookies": cookies}


@pytest.fixture(scope="module")
def actors():
    init_db()
    try:
        yield {
            "admin": _user("admin", "Admin", {}),
            "clerk": _user("clerk", "Employee", {"receipts": ["view", "add"], "customers": ["view"]}),
        }
    finally:
        with db_conn() as conn:
            for uid in _USERS:
                conn.execute(text("DELETE FROM entities WHERE created_by=:uid"), {"uid": uid})
                for table in ("sessions", "audit_logs"):
                    conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
                conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})


def _customer(actors, label):
    created = client.post("/api/collections/customers", cookies=actors["admin"]["cookies"], json={"data": {
        "name": f"Race {label} {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}})
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _delete_customer_before(monkeypatch, write_name, actors, customer_id):
    """The admin's DELETE commits after the pre-checks, right before main.<write_name> writes."""
    real = getattr(main, write_name)
    outcome = {}

    def late_write(*args, **kwargs):
        outcome["delete"] = client.delete(
            f"/api/collections/customers/{customer_id}", cookies=actors["admin"]["cookies"]
        ).status_code
        return real(*args, **kwargs)

    monkeypatch.setattr(main, write_name, late_write)
    return outcome


def _row(collection, entity_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, deleted FROM entities WHERE type=:t AND id=:id"),
                           {"t": collection, "id": entity_id}).mappings().first()
    return row and {"data": json_loads(row["data_json"]), "deleted": bool(row["deleted"])}


def test_a_receipt_created_while_its_customer_is_deleted_is_refused(actors, monkeypatch):
    customer_id = _customer(actors, "receipt")
    outcome = _delete_customer_before(monkeypatch, "upsert_entity", actors, customer_id)
    receipt_id = new_id("r1dr_receipt")
    created = client.post("/api/collections/receipts", cookies=actors["clerk"]["cookies"], json={
        "id": receipt_id, "data": {
            "recordType": "receipt", "customerId": customer_id, "status": "Paid", "isPaid": True,
            "serialNumber": str(secrets.randbelow(9 * 10**8) + 10**8),
            "amountUSD": 50, "amountLocal": 350, "exchangeRate": 7}})
    assert outcome["delete"] == 200  # the delete really committed inside the window
    assert created.status_code == 409, created.text  # before: 200, a receipt owned by a deleted customer
    assert "deleted" in created.json()["detail"]
    assert _row("receipts", receipt_id) is None
    assert not [issue for issue in scan_database()["issues"] if issue.get("entityId") == receipt_id]


def test_an_ad_moved_to_a_customer_deleted_meanwhile_is_refused(actors, monkeypatch):
    first, second = _customer(actors, "ad-from"), _customer(actors, "ad-to")
    ad_id = new_id("r1dr_ad")
    stamp = now_ms()
    with db_conn() as conn:  # an unfunded office ad (no receipt or company money on it)
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:d,false,:t,:u,:t)"),
            {"id": ad_id, "u": actors["admin"]["id"], "t": stamp, "d": json_dumps({
                "id": ad_id, "recordType": "ad", "customerId": first, "status": "Active",
                "paymentStatus": "paid", "collectionMethod": "office"})},
        )
    outcome = _delete_customer_before(monkeypatch, "patch_entity", actors, second)
    moved = client.patch(f"/api/collections/ads/{ad_id}", cookies=actors["admin"]["cookies"],
                         json={"data": {"customerId": second}, "expectedLastModified": stamp})
    assert outcome["delete"] == 200
    assert moved.status_code == 409, moved.text  # before: 200, the ad now belonged to a deleted customer
    assert _row("ads", ad_id)["data"]["customerId"] == first


def test_a_receipt_moved_to_a_customer_deleted_meanwhile_is_refused(actors, monkeypatch):
    first, second = _customer(actors, "rc-from"), _customer(actors, "rc-to")
    created = client.post("/api/collections/receipts", cookies=actors["admin"]["cookies"], json={"data": {
        "recordType": "receipt", "customerId": first, "status": "Not Paid", "isPaid": False,
        "amountUSD": 10, "amountLocal": 70, "exchangeRate": 7}})
    assert created.status_code == 200, created.text
    receipt = created.json()
    outcome = _delete_customer_before(monkeypatch, "_financial_patch_receipt_atomic", actors, second)
    moved = client.patch(f"/api/collections/receipts/{receipt['id']}", cookies=actors["admin"]["cookies"],
                         json={"data": {"customerId": second}, "expectedLastModified": receipt["lastModified"]})
    assert outcome["delete"] == 200
    assert moved.status_code == 409, moved.text  # before: 200
    assert _row("receipts", receipt["id"])["data"]["customerId"] == first


def test_batch_delete_locks_ads_before_customers(actors):
    """Lock order receipts -> ads -> customers, as patch_entity takes it (ad, then the new customer):
    a batch that locked the customer first could deadlock an ad move on PostgreSQL."""
    from sqlalchemy import event
    from server.db import get_engine

    customer = _customer(actors, "batch-order")
    ad_id = new_id("r1dr_bad")
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:d,false,:t,:u,:t)"),
            {"id": ad_id, "u": actors["admin"]["id"], "t": stamp, "d": json_dumps({
                "id": ad_id, "recordType": "ad", "customerId": customer, "status": "Active",
                "paymentStatus": "paid", "collectionMethod": "office"})},
        )
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        flat = " ".join(str(statement).split())
        # Only the row-lock helper (_clothes_lock_row): the route's own pre-check reads come earlier.
        if flat.startswith("SELECT type, id, data_json, deleted, created_at, created_by, last_modified FROM entities WHERE type="):
            values = parameters.values() if isinstance(parameters, dict) else (parameters or ())
            for value in values:
                if value in (ad_id, customer):
                    seen.append("ad" if value == ad_id else "customer")
                    break

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", record)
    try:
        deleted = client.post("/api/batch/delete", cookies=actors["admin"]["cookies"], json={"items": [
            {"collection": "customers", "id": customer}, {"collection": "ads", "id": ad_id}]})
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert deleted.status_code == 200, deleted.text
    assert "ad" in seen and "customer" in seen, seen
    assert seen.index("ad") < seen.index("customer"), seen  # before: the customer row was locked first
