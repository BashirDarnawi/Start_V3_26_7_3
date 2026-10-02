"""Bug-hunt R1 (server-data-plane-1): editing a customer without customers.viewContacts
never wipes the customer's stored phone numbers or profile links.

Staff without viewContacts receive customer rows with every contact field removed, so the
edit form showed them an empty phone box. Whatever they typed then REPLACED all the stored
numbers (and the links), silently. The server now adds what such a writer types to the
stored contacts (main._add_hidden_contact_writes) and still refuses another customer's number.
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
from server.security import hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "HiddenContacts123!"
client = TestClient(main.app, headers={"Origin": "http://testserver"})
_USERS: list[str] = []


def _user(label, role, permissions):
    uid = new_id(f"r1hc{label}")
    email = f"r1-hc-{label}-{TAG}@tests.albayanhub.com"
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
            "clerk": _user("clerk", "Employee", {"customers": ["view", "edit"]}),  # no viewContacts
        }
    finally:
        with db_conn() as conn:
            for uid in _USERS:
                conn.execute(text("DELETE FROM entities WHERE created_by=:uid"), {"uid": uid})
                for table in ("sessions", "audit_logs"):
                    conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
                conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})


def _phone():
    return "091" + str(secrets.randbelow(10**7)).zfill(7)


def _customer(actors, **data):
    created = client.post("/api/collections/customers", cookies=actors["admin"]["cookies"], json={"data": {
        "name": f"Hidden {TAG}", "platform": "Facebook", **data}})
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _seen_by_clerk(actors, customer_id):
    seen = client.get(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"])
    assert seen.status_code == 200, seen.text
    assert "phones" not in seen.json()["data"] and "profileLinks" not in seen.json()["data"]
    return seen.json()["lastModified"]


def _stored(customer_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='customers' AND id=:id"),
                           {"id": customer_id}).mappings().first()
    return json_loads(row["data_json"])


def test_a_clerk_without_contacts_adds_a_phone_and_link_instead_of_replacing_them(actors):
    p1, p2, typed = _phone(), _phone(), _phone()
    customer_id = _customer(actors, phones=[p1, p2], profileLinks=["https://facebook.com/one"])
    # Exactly what the old edit form sent: the name fix plus the one number the clerk had to type.
    saved = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"], json={
        "data": {"name": f"Hidden {TAG} fixed", "phones": [typed], "platform": "Facebook",
                 "joinDate": "2026-09-01T00:00:00.000Z",
                 "profileLinks": ["https://facebook.com/two", "https://facebook.com/two", "https://facebook.com/one"]},
        "expectedLastModified": _seen_by_clerk(actors, customer_id)})
    assert saved.status_code == 200, saved.text
    assert "phones" not in saved.json()["data"]  # the reply still hides the contacts from the clerk
    after = client.get(f"/api/collections/customers/{customer_id}", cookies=actors["admin"]["cookies"]).json()["data"]
    assert after["name"] == f"Hidden {TAG} fixed"
    assert after["phones"] == [p1, p2, typed]  # before: [typed], both stored numbers were gone
    assert after["profileLinks"] == ["https://facebook.com/one", "https://facebook.com/two"]


def test_a_clerk_save_without_contact_fields_keeps_them_and_a_retyped_number_is_not_doubled(actors):
    p1 = _phone()
    customer_id = _customer(actors, phones=[p1], profileLinks=["https://facebook.com/kept"])
    saved = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"], json={
        "data": {"name": f"Hidden {TAG} name only"}, "expectedLastModified": _seen_by_clerk(actors, customer_id)})
    assert saved.status_code == 200, saved.text
    # The same number in another spelling is the same phone: stored once, as it was.
    respelled = "+218 " + p1[1:]
    saved = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"], json={
        "data": {"phones": [respelled], "profileLinks": ["https://facebook.com/kept"]},
        "expectedLastModified": _seen_by_clerk(actors, customer_id)})
    assert saved.status_code == 200, saved.text
    stored = _stored(customer_id)
    assert stored["phones"] == [p1] and stored["profileLinks"] == ["https://facebook.com/kept"]


def test_a_legacy_scalar_phone_survives_a_clerk_edit(actors):
    legacy, typed = _phone(), _phone()
    customer_id = new_id("r1hc_legacy")
    stamp = now_ms()
    with db_conn() as conn:  # an old row: its only number lives in the scalar phone field
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('customers',:id,:d,false,:t,:u,:t)"),
            {"id": customer_id, "u": actors["admin"]["id"], "t": stamp,
             "d": json_dumps({"id": customer_id, "name": f"Legacy {TAG}", "phone": legacy})},
        )
    saved = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"], json={
        "data": {"phones": [typed], "phone": typed}, "expectedLastModified": stamp})
    assert saved.status_code == 200, saved.text
    stored = _stored(customer_id)
    assert stored["phones"] == [legacy, typed]  # before: [typed], the legacy number was retired and lost
    assert "phone" not in stored and "phoneNumber" not in stored


def test_a_clerk_still_cannot_type_another_customers_number(actors):
    taken = _phone()
    _customer(actors, phones=[taken])
    own = _phone()
    customer_id = _customer(actors, phones=[own])
    refused = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["clerk"]["cookies"], json={
        "data": {"phones": [taken]}, "expectedLastModified": _seen_by_clerk(actors, customer_id)})
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == "This phone number is already linked to another customer"
    assert _stored(customer_id)["phones"] == [own]


def test_an_editor_who_sees_contacts_still_replaces_them(actors):
    p1, p2 = _phone(), _phone()
    customer_id = _customer(actors, phones=[p1, p2], profileLinks=["https://facebook.com/old"])
    seen = client.get(f"/api/collections/customers/{customer_id}", cookies=actors["admin"]["cookies"]).json()
    saved = client.patch(f"/api/collections/customers/{customer_id}", cookies=actors["admin"]["cookies"], json={
        "data": {"phones": [p2], "profileLinks": []}, "expectedLastModified": seen["lastModified"]})
    assert saved.status_code == 200, saved.text
    stored = _stored(customer_id)
    assert stored["phones"] == [p2] and stored["profileLinks"] == []


# Bug-hunt R4 (permission-matrix-1): a receipt's edit history carried the customer's old and new
# phone numbers to every role that may read receipts. The stock Accountant (no customers.viewContacts)
# saw them in the Edit History dialog; a Read Only account received and cached them. Rows about a
# contact field now reach such roles as '—', and their saves (which echo the masked history back)
# can only append rows, never overwrite the stored ones.
ACCOUNTANT = {"analytics": ["view", "export", "viewFinancials", "viewSensitive"],  # src/04-permissions.js templates
              "receipts": ["view", "add", "edit", "markCollected", "transfer", "viewHistory", "export"],
              "customers": ["view", "viewBalance"], "ads": ["view"], "auditLogs": ["view", "export"]}
READ_ONLY = {"analytics": ["view"], "ads": ["view", "viewPhotos"], "receipts": ["view"], "customers": ["view"],
             "pages": ["view"], "deliveries": ["view"], "auditLogs": ["viewOwn"]}


def _stored_receipt(receipt_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='receipts' AND id=:id"),
                           {"id": receipt_id}).mappings().first()
    return json_loads(row["data_json"])


@pytest.fixture(scope="module")
def history_actors(actors):
    return {**actors, "accountant": _user("acct", "Employee", ACCOUNTANT), "viewer": _user("view", "Employee", READ_ONLY)}


def _receipt_with_phone_history(actors, status="Paid"):
    """A receipt whose phone the admin corrected, exactly as src/14-forms.js records it."""
    old_phone, new_phone = _phone(), _phone()
    admin = actors["admin"]["cookies"]
    customer_id = _customer(actors, phones=[old_phone])
    data = {"recordType": "receipt", "customerId": customer_id, "status": status, "isPaid": status == "Paid",
            "amountUSD": 10, "amountLocal": 97, "exchangeRate": 9.7, "paymentMethod": "Cash (LYD)",
            "deliveryStatus": "Office", "phoneNumber": old_phone}
    if status == "Paid":
        data.update(serialNumber=str(700000 + secrets.randbelow(99999)),
                    payments=[{"method": "Cash (LYD)", "amount": 97, "rate": 1, "rate2": 9.7, "collectionType": "office"}])
    else:
        data.update(statusDetail={"notPaidCollection": "office"})
    created = client.post("/api/collections/receipts", cookies=admin, json={"data": data})
    assert created.status_code == 200, created.text
    history = [{"editedAt": "2026-10-02T00:00:00.000Z", "editedBy": "Admin",
                "changes": [{"field": "Phone Number", "from": old_phone, "to": new_phone},
                            {"field": "Status", "from": "Paid", "to": "Paid"}]}]
    patched = client.patch(f"/api/collections/receipts/{created.json()['id']}", cookies=admin, json={
        "data": {"phoneNumber": new_phone, "editHistory": history, "editCount": 1},
        "expectedLastModified": created.json()["lastModified"]})
    assert patched.status_code == 200, patched.text
    return created.json()["id"], old_phone, new_phone, history


def test_receipt_edit_history_hides_phone_numbers_from_roles_without_view_contacts(history_actors):
    receipt_id, old_phone, new_phone, history = _receipt_with_phone_history(history_actors)
    for who in ("accountant", "viewer"):
        cookies = history_actors[who]["cookies"]
        replies = {
            "list": client.get("/api/collections/receipts?limit=1000&include_media=false", cookies=cookies),
            "item": client.get(f"/api/collections/receipts/{receipt_id}", cookies=cookies),
            "delta": client.get("/api/collections/receipts?updated_since=0&limit=1000&include_deleted=true&include_media=false", cookies=cookies),
            "bootstrap": client.get("/api/bootstrap", cookies=cookies),
        }
        for name, reply in replies.items():
            assert reply.status_code == 200, (who, name, reply.text)
            body = reply.text
            assert old_phone not in body and new_phone not in body, (who, name)  # before: both numbers, in every reply
        changes = replies["item"].json()["data"]["editHistory"][0]["changes"]
        assert changes[0] == {"field": "Phone Number", "from": "—", "to": "—"}  # the row stays, its numbers do not
        assert changes[1] == {"field": "Status", "from": "Paid", "to": "Paid"}
    admin_view = client.get(f"/api/collections/receipts/{receipt_id}", cookies=history_actors["admin"]["cookies"]).json()
    assert admin_view["data"]["editHistory"] == history  # the admin still reads the real history


def test_an_accountant_save_echoing_the_masked_history_keeps_the_real_rows(history_actors):
    receipt_id, old_phone, new_phone, history = _receipt_with_phone_history(history_actors)
    cookies = history_actors["accountant"]["cookies"]
    seen = client.get(f"/api/collections/receipts/{receipt_id}", cookies=cookies).json()
    new_row = {"editedAt": "2026-10-02T01:00:00.000Z", "editedBy": "Accountant",
               "changes": [{"field": "Amount (USD)", "from": "$10.00", "to": "$10.00"}]}
    # What the receipt form sends: the history it received plus its own row.
    saved = client.patch(f"/api/collections/receipts/{receipt_id}", cookies=cookies, json={
        "data": {"notes": "checked", "editHistory": seen["data"]["editHistory"] + [new_row], "editCount": 2},
        "expectedLastModified": seen["lastModified"]})
    assert saved.status_code == 200, saved.text
    stored = _stored_receipt(receipt_id)
    assert stored["editHistory"] == history + [new_row]  # before: the admin's numbers were overwritten with '—'
    assert stored["editCount"] == 2 and stored["notes"] == "checked"
    # A shorter (stale) list cannot drop stored rows either.
    seen = client.get(f"/api/collections/receipts/{receipt_id}", cookies=cookies).json()
    saved = client.patch(f"/api/collections/receipts/{receipt_id}", cookies=cookies, json={
        "data": {"editHistory": [], "editCount": 0}, "expectedLastModified": seen["lastModified"]})
    assert saved.status_code == 200, saved.text
    assert _stored_receipt(receipt_id)["editHistory"] == history + [new_row] and _stored_receipt(receipt_id)["editCount"] == 2


def test_settle_by_an_accountant_keeps_the_real_phone_history(history_actors):
    receipt_id, old_phone, new_phone, history = _receipt_with_phone_history(history_actors, status="Not Paid")
    cookies = history_actors["accountant"]["cookies"]
    seen = client.get(f"/api/collections/receipts/{receipt_id}", cookies=cookies).json()
    assert seen["data"]["editHistory"][0]["changes"][0]["from"] == "—"
    new_row = {"editedAt": "2026-10-02T02:00:00.000Z", "editedBy": "Accountant",
               "changes": [{"field": "Status", "from": "Not Paid", "to": "Paid"}]}
    settled = client.post(f"/api/receipts/{receipt_id}/settle", cookies=cookies, json={
        "expectedLastModified": seen["lastModified"], "idempotencyKey": f"r4-pm1-settle-{TAG}",
        "data": {"serialNumber": str(800000 + secrets.randbelow(99999)),
                 "payments": [{"method": "Cash (LYD)", "amount": 97, "rate": 1, "rate2": 9.7, "collectionType": "office"}],
                 "editHistory": seen["data"]["editHistory"] + [new_row], "editCount": 2}})
    assert settled.status_code == 200, settled.text
    assert old_phone not in settled.text and new_phone not in settled.text
    stored = _stored_receipt(receipt_id)
    assert stored["status"] == "Paid" and stored["editHistory"] == history + [new_row]
