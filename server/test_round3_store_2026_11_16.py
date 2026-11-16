"""Round 3 (2026-11-16), the generic data store: findings reproduced by a read-only reviewer with
in-process requests, each fixed in server/main.py or server/receipt_serials.py.

Run with:
  PYTHONPATH=. pytest server/test_round3_store_2026_11_16.py -v
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

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(main_module.app, headers={"Origin": "http://testserver"}, client=("192.0.2.93", 50000))
TAG = secrets.token_hex(4)
PASSWORD = "Round3-Store-Password-7731!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
CLOTHES = {"clothesProducts": ["viewOwn", "add", "editOwn", "deleteOwn"], "clothesShipments": ["viewOwn", "add", "editOwn", "deleteOwn"],
           "clothesOrders": ["viewOwn", "add", "editOwn", "deleteOwn"], "clothesSettings": ["viewOwn", "add", "editOwn"]}


def _account(label: str, role: str, permissions: dict) -> dict:
    uid, email = new_id("user"), f"r3store-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": f"R3 {label}", "email": email, "role": role, "perm": json_dumps(permissions), "h": _HASH.hash_hex,
             "s": _HASH.salt_hex, "a": _HASH.algo, "i": _HASH.iterations, "t": now_ms()},
        )
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    out = {
        "admin": _account("admin", "Admin", {}),
        "staff": _account("staff", "Employee", {"customers": ["view", "add", "edit"], "receipts": ["view", "add", "edit"], "pages": ["view", "add", "edit"]}),
        "shop_a": _account("shopa", "Employee", CLOTHES),
        "shop_b": _account("shopb", "Employee", CLOTHES),
    }
    customer = client.post("/api/collections/customers", json={"data": {"name": f"R3 Store {TAG}", "phone": "093" + str(secrets.randbelow(10**7)).zfill(7)}},
                           cookies=out["admin"]["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer"] = customer.json()["id"]
    yield out
    with db_conn() as conn:
        for who in ("admin", "staff", "shop_a", "shop_b"):
            conn.execute(text("DELETE FROM sessions WHERE user_id = :u"), {"u": out[who]["id"]})
            conn.execute(text("UPDATE entities SET deleted = true WHERE created_by = :u"), {"u": out[who]["id"]})
            conn.execute(text("UPDATE users SET deleted = true WHERE id = :u"), {"u": out[who]["id"]})


def _receipt_body(people, **extra) -> dict:
    return {"recordType": "receipt", "customerId": people["customer"], "status": "Paid", "isPaid": True, "amountUSD": 10, "amountLocal": 50,
            "exchangeRate": 5, "serialNumber": str(820000 + secrets.randbelow(99999)), **extra}


def _stored(collection: str, entity_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, deleted FROM entities WHERE type = :t AND id = :i"), {"t": collection, "i": entity_id}).mappings().first()
    return {"data": json_loads(row["data_json"]), "deleted": bool(row["deleted"])}


def test_a_body_cannot_mark_a_live_record_deleted(people):
    """Any add or edit grant could send "_deleted": true inside the record. The row stayed live, but
    the single-record replies carried the flag back, and the device that opened the record then hid
    a live receipt from its lists and totals while the server still counted its money."""
    staff = people["staff"]["cookies"]
    made = client.post("/api/collections/receipts", json={"data": _receipt_body(people, _deleted=True, _created=1)}, cookies=staff)
    assert made.status_code == 200, made.text
    receipt_id = made.json()["id"]
    assert made.json()["deleted"] is False and made.json()["data"]["_deleted"] is False
    assert made.json()["data"]["_created"] == made.json()["createdAt"] != 1  # the row's own time, as in list reads
    by_id = client.get(f"/api/collections/receipts/{receipt_id}", cookies=staff).json()
    assert by_id["data"]["_deleted"] is False and by_id["data"]["_lastModified"] == by_id["lastModified"]
    assert _stored("receipts", receipt_id)["data"]["_deleted"] is False

    customer = client.post("/api/collections/customers", json={"data": {"name": f"Ghost {TAG}", "phone": "094" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=staff)
    assert customer.status_code == 200, customer.text
    patched = client.patch(f"/api/collections/customers/{customer.json()['id']}", json={"data": {"_deleted": True, "notes": "still here"}}, cookies=staff)
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["_deleted"] is False and patched.json()["data"]["notes"] == "still here"
    stored = _stored("customers", customer.json()["id"])
    assert stored["deleted"] is False and stored["data"].get("_deleted") is not True
    # A record deleted the proper way still says so.
    assert client.delete(f"/api/collections/customers/{customer.json()['id']}", cookies=people["admin"]["cookies"]).status_code == 200
    gone = client.get(f"/api/collections/customers/{customer.json()['id']}", cookies=people["admin"]["cookies"])
    assert gone.status_code in (200, 404) and (gone.status_code == 404 or gone.json()["data"]["_deleted"] is True)


def test_an_over_long_receipt_number_is_refused_and_cannot_break_automatic_numbering(people):
    """The number key is cut at 80 characters. One hand-made "S" + 79 nines was accepted; the next
    automatic S number was then 81 characters long and every later one collided with it (409)."""
    admin = people["admin"]["cookies"]
    ltt = {"paymentMethod": "LTT", "payments": [{"method": "LTT", "amount": 50}]}
    for number in ("S" + "9" * 79, "S" + "9" * 13, "9" * 16):
        refused = client.post("/api/collections/receipts", json={"data": _receipt_body(people, serialNumber=number, **ltt)}, cookies=admin)
        assert refused.status_code == 400, (number[:20], refused.text)
    # Twelve digits after the letter and fifteen plain digits are still receipt numbers.
    assert main_module._is_valid_serial_number("S" + "1" * 12) and main_module._is_valid_serial_number("1" * 15)
    assert not main_module._is_valid_serial_number("S" + "1" * 13) and not main_module._is_valid_serial_number("1" * 16)
    # A too-long number stored before the limit never sets the next automatic one.
    from server.receipt_serials import issue_free_auto_serial

    class _Rows:
        def __init__(self, rows):
            self._rows = rows

        def mappings(self):
            return self

        def all(self):
            return self._rows

    class _Conn:
        def execute(self, *_args, **_kwargs):
            return _Rows([{"f_serialnumber": "S" + "9" * 79, "f_finalreceiptno": "", "f_tempreceiptno": "", "f_paymentmethod": "LTT"},
                          {"f_serialnumber": "S7", "f_finalreceiptno": "", "f_tempreceiptno": "", "f_paymentmethod": "LTT"}])

    data = {"serialNumber": "S7", "finalReceiptNo": "S7", **ltt}
    issue_free_auto_serial(_Conn(), "receipt-new", data, set(), main_module._canonical_receipt_number, scan_sql="SELECT 1", lock=lambda key: None)
    assert data["serialNumber"] == "S8" and data["finalReceiptNo"] == "S8"


def test_a_record_far_larger_than_any_real_one_is_refused_before_it_is_stored(people):
    """The only size limit was the 10 MB request: 940 keys of 10,000 characters (or a list of a
    million items) were stored whole, slowed every later list and held the server for seconds."""
    staff = people["staff"]["cookies"]
    junk = {f"k{index}": "x" * 9000 for index in range(140)}  # about 1.26 million characters
    page = client.post("/api/collections/pages", json={"data": {"name": f"Junk {TAG}", "customerIds": [people["customer"]], **junk}}, cookies=staff)
    assert page.status_code == 413 and "too large" in page.text, page.text[:200]
    receipt = client.post("/api/collections/receipts", json={"data": _receipt_body(people)}, cookies=staff)
    assert receipt.status_code == 200, receipt.text
    many = client.patch(f"/api/collections/receipts/{receipt.json()['id']}", json={"data": {"notes": "n", "junk": [{"a": 1}] * 60000},
                        "expectedLastModified": receipt.json()["lastModified"]}, cookies=staff)
    assert many.status_code == 413, many.text[:200]
    # Photos have their own limit and are not counted: a real receipt with a photo and long notes saves.
    photo = "data:image/png;base64," + "A" * 1_200_000
    real = client.post("/api/collections/receipts", json={"data": _receipt_body(people, notes="n" * 9000, receiptImage=photo, photos=[photo])}, cookies=staff)
    assert real.status_code == 200, real.text[:300]


def test_an_amount_sent_as_text_gets_the_same_checks_as_a_number(people):
    """The money checks ran only on JSON numbers. "amountUSD": "-5" was stored as sent and the screens
    read a negative receipt, while the number -5 became 0."""
    staff = people["staff"]["cookies"]
    made = client.post("/api/collections/receipts", json={"data": _receipt_body(people, amountUSD="-5", amountLocal="1e3", exchangeRate="-3")}, cookies=staff)
    assert made.status_code == 200, made.text
    data = made.json()["data"]
    assert data["amountUSD"] == 0 and data["amountLocal"] == 1000 and data["exchangeRate"] > 0
    assert all(isinstance(data[key], (int, float)) for key in ("amountUSD", "amountLocal", "exchangeRate"))
    assert main_module.sanitize_json({"amountUSD": "NaN", "rate": "Infinity", "amount": "١٢٫٥"}) == {"amountUSD": 0.0, "rate": 1.0, "amount": "١٢٫٥"}
    assert main_module.sanitize_json({"amountUSD": " 12.345 ", "amount": "", "notes": "-5"}) == {"amountUSD": 12.35, "amount": "", "notes": "-5"}
    # Payment rows keep what was typed (their own validator reads them): only the record's own fields are converted.
    assert main_module.sanitize_json({"payments": [{"method": "Cash", "amount": "120.5", "rate2": "5"}]}) == {"payments": [{"method": "Cash", "amount": "120.5", "rate2": "5"}]}


def test_a_cursor_past_the_database_range_is_not_a_500(people):
    admin = people["admin"]["cookies"]
    for query in ("updated_since=99999999999999999999999", "before_created_at=99999999999999999999999&before_id=a",
                  "updated_since=1&after_last_modified=9223372036854775808&after_id=a"):
        answer = client.get(f"/api/collections/customers?{query}", cookies=admin)
        assert answer.status_code in (200, 400, 422), (query, answer.status_code, answer.text[:160])


def test_restore_and_batch_delete_refuse_records_only_their_own_routes_may_write(people):
    """An admin restore of "users" wrote a shadow row of that type; the bulk import already refused it."""
    admin = people["admin"]["cookies"]
    for collection in ("users", "auditLogs", "adCampaignRequests", "socialPages", "studioSettings", "metaProviderState"):
        restored = client.put(f"/api/admin/collections/{collection}/r3-shadow-{TAG}/restore", json={"data": {"name": "shadow"}, "createdAt": 5}, cookies=admin)
        assert restored.status_code == 405, (collection, restored.text)
        assert _count(collection, f"r3-shadow-{TAG}") == 0
        batch = client.post("/api/batch/delete", json={"items": [{"collection": collection, "id": f"r3-shadow-{TAG}"}]}, cookies=admin)
        assert batch.status_code in (400, 403, 404, 405) or batch.json().get("deleted") == 0, (collection, batch.status_code, batch.text)
    # Accounts were already refused by the batch route (and stay so).
    assert client.post("/api/batch/delete", json={"items": [{"collection": "users", "id": people["staff"]["id"]}]}, cookies=admin).status_code == 400
    # An ordinary collection is still restored exactly.
    ok = client.put(f"/api/admin/collections/customers/r3-restored-{TAG}/restore",
                    json={"data": {"name": f"Restored {TAG}", "phones": ["0951234567"]}, "createdAt": 5}, cookies=admin)
    assert ok.status_code == 200, ok.text


def _count(collection: str, entity_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND id = :i"), {"t": collection, "i": entity_id}).scalar() or 0)


def test_a_clothes_shipment_cannot_name_another_shop_s_product(people):
    """Shop A's shipment could name shop B's product. B could then never delete or empty that
    product (409 "referenced"), could not see the shipment that blocked it (403), and the two
    different answers told A which product ids exist."""
    shop_a, shop_b = people["shop_a"]["cookies"], people["shop_b"]["cookies"]
    for who in ("shop_a", "shop_b"):
        bought = client.post("/api/subscriptions/purchase", json={"serviceId": "clothes_system", "idempotencyKey": f"r3store-sub-{who}-{TAG}"},
                             cookies=people[who]["cookies"])
        if bought.status_code != 200:
            pytest.skip(f"clothes subscription is not free in this catalog: {bought.text[:120]}")
    product_id = f"r3prod{TAG}"
    product = client.post("/api/collections/clothesProducts", json={"id": product_id, "data": {
        "name": "Shirt", "costUSD": 3, "priceLYD": 20, "variants": [{"color": "Red", "size": "M", "qty": 2}]}}, cookies=shop_b)
    assert product.status_code == 200, product.text
    line = {"productId": product_id, "color": "Red", "size": "M", "qty": 1}
    foreign = client.post("/api/collections/clothesShipments", json={"id": f"r3ship{TAG}", "data": {"supplier": "s", "lines": [line]}}, cookies=shop_a)
    missing = client.post("/api/collections/clothesShipments", json={"id": f"r3ship2{TAG}", "data": {"supplier": "s", "lines": [{**line, "productId": "r3-no-such-product"}]}}, cookies=shop_a)
    assert foreign.status_code == missing.status_code == 409, (foreign.text, missing.text)
    assert "is missing" in foreign.text and "is missing" in missing.text  # the same answer: no hint that the id exists
    # Nothing of shop A's attempt blocks the owner: the product can still be deleted.
    assert client.delete(f"/api/collections/clothesProducts/{product_id}", cookies=shop_b).status_code == 200
    # And a shop still ships its own products.
    second = client.post("/api/collections/clothesProducts", json={"id": f"r3prod2{TAG}", "data": {
        "name": "Dress", "costUSD": 3, "priceLYD": 20, "variants": [{"color": "Red", "size": "M", "qty": 2}]}}, cookies=shop_b)
    assert second.status_code == 200, second.text
    own = client.post("/api/collections/clothesShipments", json={"id": f"r3ship3{TAG}", "data": {"supplier": "s", "lines": [{**line, "productId": f"r3prod2{TAG}"}]}}, cookies=shop_b)
    assert own.status_code == 200, own.text
