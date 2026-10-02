"""Bug-hunt R3 (server-main-routes-3): a receipt-number collision scan parses each receipt's JSON once.

The scan read serialNumber, finalReceiptNo and tempReceiptNo with one json_field_sql each, so on
PostgreSQL every save of a numbered receipt cast every active receipt's whole data_json (photos
included) to jsonb three times. It is now built on db.json_fields_select_sql, which parses each row
once inside a subquery. The edit check's "AND id<>:receipt_id" must sit inside that subquery's WHERE:
text appended after the SQL would land after the outer FROM. SQLite output keeps json_extract.

Run with: PYTHONPATH=. pytest server/test_receipt_number_scan_sql.py -v
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.db as db_module
import server.main as main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "ScanSqlPassword123!"
client = TestClient(main.app, headers={"Origin": "http://testserver"})


class _Dialect:
    def __init__(self, name):
        self.name = name


class _Engine:
    def __init__(self, name):
        self.dialect = _Dialect(name)


class _RecordingConn:
    def __init__(self):
        self.statements = []

    def execute(self, statement, params=None):
        self.statements.append(str(statement))

        class _Result:
            def mappings(self):
                return self

            def all(self):
                return []

        return _Result()


def test_postgres_scan_parses_each_row_once_and_keeps_the_edit_filter_inside(monkeypatch):
    monkeypatch.setattr(db_module, "get_engine", lambda: _Engine("postgresql"))
    plain = main._receipt_number_scan_sql()
    assert plain.count("::jsonb") == 1, plain  # before: three casts, one per number field
    conn = _RecordingConn()
    main._validate_receipt_number_change_conn(conn, "r_edit", {}, {"serialNumber": "7781"}, postgres=True)
    scans = [s for s in conn.statements if "FROM entities" in s]
    assert len(scans) == 1, conn.statements
    scan = scans[0]
    assert scan.count("::jsonb") == 1, scan
    inner, _, after = scan.partition(") AS parsed_once")
    assert "id<>:receipt_id" in inner and "WHERE type='receipts' AND deleted=false AND id<>:receipt_id" in inner
    assert after.strip() == "", scan  # nothing appended after the outer FROM
    for column in ("f_serialnumber", "f_finalreceiptno", "f_tempreceiptno"):
        assert column in scan


def test_sqlite_scan_reads_the_same_fields(monkeypatch):
    monkeypatch.setattr(db_module, "get_engine", lambda: _Engine("sqlite"))
    sql = main._receipt_number_scan_sql(" AND id<>:receipt_id")
    assert sql == (
        "SELECT id, json_extract(data_json, '$.serialNumber') AS f_serialnumber, "
        "json_extract(data_json, '$.finalReceiptNo') AS f_finalreceiptno, "
        "json_extract(data_json, '$.tempReceiptNo') AS f_tempreceiptno "
        "FROM entities WHERE type='receipts' AND deleted=false AND id<>:receipt_id"
    )
    row = {"id": "r", "f_serialnumber": "s٧٧", "f_finalreceiptno": None, "f_tempreceiptno": "d5"}
    assert main._receipt_number_keys(main._receipt_number_row_fields(row)) == {"S77", "D5"}


# ---------------------------------------------------------------------------- the routes, on SQLite


@pytest.fixture(scope="module")
def admin():
    init_db()
    hashed = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    user_id, email, stamp = new_id("scan_admin"), f"scan-sql-admin-{TAG}@tests.albayanhub.com", now_ms()
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Scan Admin',:email,'Admin',:perms,:hash,:salt,:algo,:iterations,false,:now,NULL,:now)"
            ),
            {"id": user_id, "email": email, "perms": json_dumps({}), "hash": hashed.hash_hex,
             "salt": hashed.salt_hex, "algo": hashed.algo, "iterations": hashed.iterations, "now": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    yield {"id": user_id, "cookies": cookies}
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type='receipts' AND created_by=:id"), {"id": user_id})


def _number(offset: int) -> str:
    """A paper number no other module uses (digits, no leading zero)."""
    return str(int(TAG, 16) % 10_000_000 * 100 + 7_100_000_000 + offset)


def _create(admin, receipt_id, **data):
    return client.post("/api/collections/receipts", json={"id": receipt_id, "data": {
        "status": "Paid", "paymentMethod": "Cash (LYD)", "amountUSD": 10, "amountLocal": 97, **data,
    }}, cookies=admin["cookies"])


def test_duplicates_are_still_refused_through_the_routes(admin):
    first = _create(admin, f"scan_a_{TAG}", serialNumber=_number(1), finalReceiptNo=_number(1))
    assert first.status_code == 200, first.text
    by_serial = _create(admin, f"scan_b_{TAG}", serialNumber=_number(1), finalReceiptNo=_number(1))
    by_final = _create(admin, f"scan_c_{TAG}", serialNumber=_number(2), finalReceiptNo=_number(1))
    assert by_serial.status_code == by_final.status_code == 409, (by_serial.text, by_final.text)
    # The other receipt's number in either field, as the edited receipt's new number: refused.
    other = _create(admin, f"scan_d_{TAG}", serialNumber=_number(3), finalReceiptNo=_number(3))
    assert other.status_code == 200, other.text
    taken = client.patch(f"/api/collections/receipts/scan_d_{TAG}",
                         json={"data": {"serialNumber": _number(1), "finalReceiptNo": _number(1)}},
                         cookies=admin["cookies"])
    assert taken.status_code == 409, taken.text
    # The receipt being edited is excluded from its own check: an unchanged number saves.
    kept = client.patch(f"/api/collections/receipts/scan_a_{TAG}",
                        json={"data": {"serialNumber": _number(1), "finalReceiptNo": _number(1), "notes": "kept"}},
                        cookies=admin["cookies"])
    assert kept.status_code == 200, kept.text
    assert kept.json()["data"]["serialNumber"] == _number(1)


def test_the_authoritative_check_sees_all_three_fields(admin):
    """upsert_entity runs _validate_receipt_number_change_conn under its own lock and scan."""
    actor = admin["id"]
    temp = f"D{int(TAG, 16) % 1_000_000 + 9_100_000}"
    main.upsert_entity("receipts", f"scan_t_{TAG}", {"tempReceiptNo": temp, "status": "Not Paid"}, actor,
                       reject_existing=True)
    for field, value in (("serialNumber", _number(1)), ("finalReceiptNo", _number(1)), ("tempReceiptNo", temp)):
        with pytest.raises(HTTPException) as refused:
            main.upsert_entity("receipts", f"scan_x_{field}_{TAG}", {field: value}, actor, reject_existing=True)
        assert refused.value.status_code == 409, field
    # Re-saving a receipt with its own numbers is not a collision with itself.
    saved = main.upsert_entity("receipts", f"scan_t_{TAG}", {"tempReceiptNo": temp, "status": "Not Paid", "notes": "x"},
                               actor)
    assert saved["data"]["tempReceiptNo"] == temp
