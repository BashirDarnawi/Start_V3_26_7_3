"""Bug-hunt R3 (server-main-routes-1): a taken automatic receipt number gets the next free one.

The app numbers receipts paid by LTT, Libyana, Madar (S), bank transfer (B), Transfer Office (O),
Sadad or USDT (E) itself, from the receipts the account can SEE, and the number box is read-only.
A cashier holding receipts [viewOwn, add, editOwn] sees none of the others' receipts, so the app
proposed S1 while S1..S3 existed and the server answered 409 to every such save. The server now
writes the group's next free number when every payment method is auto-numbered and the asked
number is taken. Paper numbers (digits), Cash or mixed receipts and destroyed receipts keep the 409.

The suite shares one in-memory database: numbers here start far above anything other modules use,
and every receipt this module writes is deleted at the end.
"""

import os
import re
import secrets
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.db as db_module
import server.main as main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "AutoSerialPassword123!"
BASE = 8_000_000_000 + secrets.randbelow(10**6) * 1000  # far above every S number other modules use
client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.151", 50000))
RECEIPTS = "/api/collections/receipts"


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    hashed = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    user_id, email = new_id("autoserial"), f"auto-serial-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:perms,:hash,:salt,:algo,:iterations,false,:now,NULL,:now)"
            ),
            {"id": user_id, "name": f"Auto {label}", "email": email, "role": role, "perms": json_dumps(permissions),
             "hash": hashed.hash_hex, "salt": hashed.salt_hex, "algo": hashed.algo,
             "iterations": hashed.iterations, "now": now_ms()},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    out = {
        "admin": _insert_user("admin", "Admin", {}),
        "cashier": _insert_user("cashier", "Employee", {"receipts": ["viewOwn", "add", "editOwn"]}),
    }
    yield out
    with db_conn() as conn:
        for person in out.values():
            conn.execute(text("DELETE FROM entities WHERE type='receipts' AND created_by=:id"), {"id": person["id"]})


def _s(offset: int) -> str:
    return f"S{BASE + offset}"


def _paper(offset: int) -> str:
    return str(7_300_000_000 + int(TAG, 16) % 10_000_000 * 10 + offset)


def _row(method: str) -> dict:
    return {"method": method, "amount": 97, "rate": 0.7 if method == "Libyana" else 1, "rate2": 9.7,
            "collectionType": "office", "deliveryPersonId": ""}


def _receipt(person: dict, number: str, *methods: str, **extra):
    methods = methods or ("Libyana",)
    data = {
        "recordType": "receipt", "status": "Paid", "isPaid": True, "amountUSD": 10 * len(methods),
        "amountLocal": 97 * len(methods), "exchangeRate": 9.7, "serialNumber": number, "finalReceiptNo": number,
        "paymentMethod": methods[0] if len(methods) == 1 else "Split Payment",
        "payments": [_row(method) for method in methods], **extra,
    }
    return client.post(RECEIPTS, json={"id": new_id("autoserial_r"), "data": data}, cookies=person["cookies"])


def _highest_s() -> int:
    """The highest S number any live receipt holds (all the allocator may skip past)."""
    highest = 0
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type='receipts' AND deleted=false")).mappings().all()
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        for field in ("serialNumber", "finalReceiptNo"):
            match = re.fullmatch(r"S([0-9]+)", str(data.get(field) or "").strip().upper())
            if match:
                highest = max(highest, int(match.group(1)))
    return highest


def test_a_view_own_cashier_gets_the_next_free_number(people):
    admin, cashier = people["admin"], people["cashier"]
    for offset in (1, 2, 3):
        made = _receipt(admin, _s(offset))
        assert made.status_code == 200, made.text
        assert made.json()["data"]["serialNumber"] == _s(offset)  # a free number is kept as asked
    listed = client.get(RECEIPTS, cookies=cashier["cookies"])
    assert listed.status_code == 200 and listed.json() == []  # sees none of them, so its app proposes the first
    saved = _receipt(cashier, _s(1))
    assert saved.status_code == 200, saved.text  # before: 409 "serialNumber already exists"
    data = saved.json()["data"]
    assert data["serialNumber"] == data["finalReceiptNo"] == _s(4)
    stored = client.get(f"{RECEIPTS}/{saved.json()['id']}", cookies=cashier["cookies"])
    assert stored.status_code == 200 and stored.json()["data"]["serialNumber"] == _s(4)
    # A split of two auto groups may ask for either group's number; the same group is re-issued.
    split = _receipt(cashier, _s(2), "Libyana", "Bank Transfer (LYD)")
    assert split.status_code == 200, split.text
    assert split.json()["data"]["serialNumber"] == _s(5)


@pytest.fixture()
def taken_s1(people):
    """S(BASE+1) is taken and is the highest S number (also when a test runs alone)."""
    if _highest_s() < BASE + 1:
        made = _receipt(people["admin"], _s(1))
        assert made.status_code == 200 and made.json()["data"]["serialNumber"] == _s(1), made.text


def test_paper_numbers_mixed_and_destroyed_receipts_keep_the_409(people, taken_s1):
    admin, cashier = people["admin"], people["cashier"]
    paper = _receipt(admin, _paper(1), "Cash (LYD)")
    assert paper.status_code == 200, paper.text
    refused = {
        "paper number": _receipt(cashier, _paper(1), "Cash (LYD)"),
        "paper number on a Libyana receipt": _receipt(cashier, _paper(1)),
        "Cash + Libyana": _receipt(cashier, _s(1), "Cash (LYD)", "Libyana"),
        "another group's number": _receipt(cashier, _s(1), "Bank Transfer (LYD)"),
        "destroyed": client.post(RECEIPTS, json={"id": new_id("autoserial_r"), "data": {
            "recordType": "receipt", "status": "Destroyed", "paymentMethod": "Libyana",
            "serialNumber": _s(1), "finalReceiptNo": _s(1)}}, cookies=cashier["cookies"]),
    }
    for case, response in refused.items():
        assert response.status_code == 409, (case, response.text)
        assert response.json()["detail"] == "serialNumber already exists", case


def test_two_saves_asking_the_same_free_number_get_two_numbers(people, taken_s1):
    cashier = people["cashier"]
    wanted = _highest_s() - BASE + 10
    first, second = _receipt(cashier, _s(wanted)), _receipt(cashier, _s(wanted))
    assert first.status_code == second.status_code == 200, (first.text, second.text)
    assert first.json()["data"]["serialNumber"] == _s(wanted)
    assert second.json()["data"]["serialNumber"] == _s(wanted + 1)
    # Two devices at the same moment: never the same number.
    wanted = _highest_s() - BASE + 10
    with ThreadPoolExecutor(max_workers=2) as pool:
        together = list(pool.map(lambda _: _receipt(cashier, _s(wanted)), range(2)))
    assert [response.status_code for response in together] == [200, 200], [r.text for r in together]
    numbers = sorted(response.json()["data"]["serialNumber"] for response in together)
    assert numbers == sorted([_s(wanted), _s(wanted + 1)])


def test_a_patch_switching_cash_to_libyana_gets_the_next_free_number(people, taken_s1):
    cashier = people["cashier"]
    assert _receipt(people["admin"], _paper(8), "Cash (LYD)").status_code == 200
    made = _receipt(cashier, _paper(7), "Cash (LYD)")
    assert made.status_code == 200, made.text
    receipt_id, version = made.json()["id"], made.json()["lastModified"]
    expected = f"S{_highest_s() + 1}"
    switched = client.patch(f"{RECEIPTS}/{receipt_id}", json={"expectedLastModified": version, "data": {
        "paymentMethod": "Libyana", "payments": [_row("Libyana")], "serialNumber": _s(1), "finalReceiptNo": _s(1),
    }}, cookies=cashier["cookies"])
    assert switched.status_code == 200, switched.text  # before: 409 "serialNumber already exists"
    data = switched.json()["data"]
    assert data["serialNumber"] == data["finalReceiptNo"] == expected
    # Saving it again with its own number changes nothing.
    again = client.patch(f"{RECEIPTS}/{receipt_id}", json={"data": {
        "serialNumber": expected, "finalReceiptNo": expected, "notes": "same number"}}, cookies=cashier["cookies"])
    assert again.status_code == 200, again.text
    assert again.json()["data"]["serialNumber"] == expected
    # A PATCH that keeps Cash and asks for a taken paper number is still refused.
    taken = client.patch(f"{RECEIPTS}/{made.json()['id']}", json={"data": {
        "paymentMethod": "Cash (LYD)", "payments": [_row("Cash (LYD)")], "serialNumber": _paper(8),
        "finalReceiptNo": _paper(8)}}, cookies=cashier["cookies"])
    assert taken.status_code == 409, taken.text


def test_a_paid_receipt_edit_through_settle_gets_the_next_free_number(people, taken_s1):
    """The receipt form saves every edit of a Paid receipt through /settle (updateRecord), so a
    cashier switching its own Paid Cash receipt to Libyana met the same 409 there."""
    cashier = people["cashier"]
    made = _receipt(cashier, _paper(9), "Cash (LYD)")
    assert made.status_code == 200, made.text
    receipt_id = made.json()["id"]
    expected = f"S{_highest_s() + 1}"
    body = {"expectedLastModified": made.json()["lastModified"], "idempotencyKey": f"autoserial-settle-{TAG}",
            "data": {"paymentMethod": "Libyana", "payments": [_row("Libyana")], "serialNumber": _s(1),
                     "finalReceiptNo": _s(1)}}
    settled = client.post(f"/api/receipts/{receipt_id}/settle", json=body, cookies=cashier["cookies"])
    assert settled.status_code == 200, settled.text  # before: 409 "Receipt number already exists"
    data = settled.json()["receipt"]["data"]
    assert data["serialNumber"] == data["finalReceiptNo"] == expected
    replay = client.post(f"/api/receipts/{receipt_id}/settle", json=body, cookies=cashier["cookies"])
    assert replay.status_code == 200 and replay.json()["replayed"] is True, replay.text
    assert replay.json()["receipt"]["data"]["serialNumber"] == expected  # a retry gets the same number


def test_the_groups_mirror_the_receipt_form():
    """receipt_serials.AUTO_SERIAL_GROUPS must stay the client's AUTO_SERIAL_GROUPS (src/14-forms.js)."""
    from server.receipt_serials import AUTO_SERIAL_GROUPS

    forms = (Path(__file__).resolve().parent.parent / "src" / "14-forms.js").read_text(encoding="utf-8")
    block = forms.split("const AUTO_SERIAL_GROUPS = {", 1)[1].split("};", 1)[0]
    client_groups = {prefix: tuple(re.findall(r"'([^']+)'", methods))
                     for prefix, methods in re.findall(r"([SBOE]):\s*\[([^\]]*)\]", block)}
    assert client_groups == AUTO_SERIAL_GROUPS and tuple(AUTO_SERIAL_GROUPS) == main.AUTO_SERIAL_PREFIXES


class _FakeConn:
    def __init__(self, rows):
        self.rows, self.statements = rows, []

    def execute(self, statement, params=None):
        self.statements.append((str(statement), dict(params or {})))
        rows = [] if "pg_advisory_xact_lock" in str(statement) else self.rows

        class _Result:
            def mappings(self):
                return self

            def all(self):
                return rows

        return _Result()


def test_postgres_allocation_locks_the_group_and_parses_each_row_once(monkeypatch):
    monkeypatch.setattr(db_module, "get_engine", lambda: type("E", (), {"dialect": type("D", (), {"name": "postgresql"})()})())
    rows = [
        {"id": "a", "f_serialnumber": "S7", "f_finalreceiptno": "S7", "f_tempreceiptno": None,
         "f_paymentmethod": "Libyana", "f_payments": None, "f_status": "Paid"},
        {"id": "b", "f_serialnumber": "S9", "f_finalreceiptno": None, "f_tempreceiptno": None,
         "f_paymentmethod": "Cash (LYD)", "f_payments": None, "f_status": "Destroyed"},  # destroyed rows count
        {"id": "c", "f_serialnumber": "12", "f_finalreceiptno": "12", "f_tempreceiptno": None,
         "f_paymentmethod": "Split Payment", "f_status": "Paid",
         "f_payments": '[{"method": "Madar"}, {"method": "LTT"}]'},  # legacy bare S digits
        {"id": "d", "f_serialnumber": "99", "f_finalreceiptno": None, "f_tempreceiptno": None,
         "f_paymentmethod": "Cash (LYD)", "f_payments": None, "f_status": "Paid"},  # a paper number never counts
        {"id": "e", "f_serialnumber": "B40", "f_finalreceiptno": None, "f_tempreceiptno": "D41",
         "f_paymentmethod": "Bank Transfer", "f_payments": None, "f_status": "Paid"},  # another group
    ]
    conn = _FakeConn(rows)
    data = {"paymentMethod": "Libyana", "payments": [{"method": "Libyana"}], "serialNumber": "S7", "finalReceiptNo": ""}
    main._issue_free_auto_serial_conn(conn, "r_new", data, {}, postgres=True)
    assert data["serialNumber"] == data["finalReceiptNo"] == "S13"
    lock, scan = conn.statements
    assert "pg_advisory_xact_lock" in lock[0] and lock[1] == {"key": "receiptNumber:S*"}
    assert scan[0].count("::jsonb") == 1 and "f_payments" in scan[0] and "id<>:receipt_id" in scan[0].split("parsed_once")[0]
    assert scan[1] == {"receipt_id": "r_new"}
    # A free number, a number the receipt already had, or a Cash receipt: left as asked.
    for asked, old, methods in (("S30", {}, ["Libyana"]), ("S7", {"serialNumber": "S7"}, ["Libyana"]),
                                ("S7", {}, ["Libyana", "Cash (LYD)"])):
        conn = _FakeConn(rows)
        data = {"payments": [{"method": m} for m in methods], "serialNumber": asked, "finalReceiptNo": asked}
        main._issue_free_auto_serial_conn(conn, "r_x", data, old, postgres=True)
        assert data["serialNumber"] == asked
