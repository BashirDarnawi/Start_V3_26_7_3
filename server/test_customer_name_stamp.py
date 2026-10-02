"""customerName denormalization: authoritative stamp, protection, and backfill.

A role with receipts.view/ads.view but WITHOUT the customers permission cannot
load the customers collection, so it used to see "Unknown" on every receipt/ad.
These tests pin the fix that keeps the customer NAME (never phone/contact)
readable: stamped from the authoritative customers table at creation, protected
from ordinary edits, and backfilled onto legacy records at startup.
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

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app, backfill_customer_names
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "customer-name-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "CustomerName123!"


def _insert_entity(collection, entity_id, data, creator_id, *, deleted=False):
    stamp = now_ms()
    payload = dict(data)
    payload.update(
        {
            "id": entity_id,
            "_created": stamp,
            "_lastModified": stamp,
            "_deleted": bool(deleted),
            "createdBy": creator_id,
        }
    )
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities "
                "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:created,:creator,:modified)"
            ),
            {
                "type": collection,
                "id": entity_id,
                "data": json_dumps(payload),
                "deleted": bool(deleted),
                "created": stamp,
                "creator": creator_id,
                "modified": stamp,
            },
        )
    return stamp


def _row_data(collection, entity_id):
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json FROM entities WHERE type=:t AND id=:id LIMIT 1"),
            {"t": collection, "id": entity_id},
        ).mappings().first()
    return json_loads(row["data_json"]) if row else None


@pytest.fixture(scope="module")
def actors():
    init_db()
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    admin_id = new_id("cust_name_admin")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users "
                "(id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                "password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Customer Name Admin',:email,'Admin',:permissions,:password_hash,"
                ":password_salt,:password_algo,:password_iterations,false,:created_at,NULL,:last_modified)"
            ),
            {
                "id": admin_id,
                "email": ADMIN_EMAIL,
                "permissions": json_dumps({}),
                "password_hash": password.hash_hex,
                "password_salt": password.salt_hex,
                "password_algo": password.algo,
                "password_iterations": password.iterations,
                "created_at": stamp,
                "last_modified": stamp,
            },
        )
    login = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert login.status_code == 200, login.text
    admin = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    try:
        yield {"admin": admin, "admin_id": admin_id}
    finally:
        # The suite shares one database; leave nothing behind that would change
        # another module's counts (or a later backfill scan).
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE created_by = :admin_id"),
                {"admin_id": admin_id},
            )
            conn.execute(
                text("DELETE FROM sessions WHERE user_id = :admin_id"),
                {"admin_id": admin_id},
            )
            conn.execute(
                text("DELETE FROM audit_logs WHERE user_id = :admin_id"),
                {"admin_id": admin_id},
            )
            conn.execute(text("DELETE FROM users WHERE id = :admin_id"), {"admin_id": admin_id})


def _create_customer(cookies, entity_id, name, phones):
    return client.post(
        "/api/collections/customers",
        cookies=cookies,
        json={"id": entity_id, "data": {"name": name, "phones": phones}},
    )


def test_receipt_customer_name_is_stamped_from_the_customers_table_and_spoof_proof(actors):
    customer_id = new_id("stamp_customer")
    created_customer = _create_customer(
        actors["admin"], customer_id, "Authoritative Customer", ["0910000001"]
    )
    assert created_customer.status_code == 200, created_customer.text

    # The client sends a FORGED customerName alongside a real customerId. The
    # server must overwrite it with the authoritative customers-table name.
    receipt = client.post(
        "/api/collections/receipts",
        cookies=actors["admin"],
        json={
            "data": {
                "customerId": customer_id,
                "customerName": "SPOOFED NAME",
                "status": "Paid",
            }
        },
    )
    assert receipt.status_code == 200, receipt.text
    body = receipt.json()
    assert body["data"]["customerName"] == "Authoritative Customer"
    assert "SPOOFED NAME" not in receipt.text
    # Never leaks contact fields into the stamp.
    assert "phones" not in body["data"] or body["data"].get("phones") != ["0910000001"]


def test_receipt_customer_name_survives_a_normal_update(actors):
    customer_id = new_id("survive_customer")
    assert _create_customer(
        actors["admin"], customer_id, "Persistent Customer", ["0910000002"]
    ).status_code == 200

    created = client.post(
        "/api/collections/receipts",
        cookies=actors["admin"],
        json={"data": {"customerId": customer_id, "status": "Paid"}},
    )
    assert created.status_code == 200, created.text
    rid = created.json()["id"]
    assert created.json()["data"]["customerName"] == "Persistent Customer"

    # A full-document-ish edit that changes another field AND tries to rewrite
    # customerName: the protected key is stripped, so the stamp is unchanged.
    patched = client.patch(
        f"/api/collections/receipts/{rid}",
        cookies=actors["admin"],
        json={"data": {"note": "edited", "customerName": "Hacked Rename"}},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["customerName"] == "Persistent Customer"
    assert patched.json()["data"]["note"] == "edited"
    assert _row_data("receipts", rid)["customerName"] == "Persistent Customer"


def test_backfill_stamps_legacy_receipts_and_ads_without_touching_stamped_rows(actors):
    admin_id = actors["admin_id"]
    customer_id = new_id("backfill_customer")
    _insert_entity(
        "customers",
        customer_id,
        {"name": "Backfilled Customer", "phones": ["0910000003"]},
        admin_id,
    )

    legacy_receipt_id = new_id("backfill_receipt")
    legacy_ad_id = new_id("backfill_ad")
    already_named_id = new_id("backfill_named_receipt")
    orphan_receipt_id = new_id("backfill_orphan_receipt")

    # (b) has customerId, (c) lacks customerName -> gets stamped.
    _insert_entity("receipts", legacy_receipt_id, {"customerId": customer_id, "status": "Paid"}, admin_id)
    _insert_entity("ads", legacy_ad_id, {"customerId": customer_id, "status": "Active"}, admin_id)
    # Already carries a name -> left untouched (idempotent / no clobber).
    _insert_entity(
        "receipts",
        already_named_id,
        {"customerId": customer_id, "customerName": "Do Not Overwrite"},
        admin_id,
    )
    # customerId points to a non-existent customer -> skipped, no name invented.
    _insert_entity("receipts", orphan_receipt_id, {"customerId": new_id("ghost")}, admin_id)

    stamped = backfill_customer_names()
    assert stamped >= 2

    assert _row_data("receipts", legacy_receipt_id)["customerName"] == "Backfilled Customer"
    assert _row_data("ads", legacy_ad_id)["customerName"] == "Backfilled Customer"
    assert _row_data("receipts", already_named_id)["customerName"] == "Do Not Overwrite"
    assert "customerName" not in _row_data("receipts", orphan_receipt_id)

    # Idempotent: a second pass changes nothing for these records.
    backfill_customer_names()
    assert _row_data("receipts", legacy_receipt_id)["customerName"] == "Backfilled Customer"
    assert _row_data("receipts", already_named_id)["customerName"] == "Do Not Overwrite"


# --- Bug-hunt R1 (server-data-plane-4): a record moved to another customer carries THAT name ---
# Moving a receipt or ad to another customer (edit, /api/ads/mutate, or a merge) kept the previous
# customer's stamp, and /api/ads/mutate even stored a client-sent customerName. A role with
# receipts/ads view but no customers access read the wrong person on the record.

VIEWER_EMAIL = "customer-name-viewer@tests.albayanhub.com"


@pytest.fixture(scope="module")
def viewer(actors):
    """receipts/ads view WITHOUT the customers permission: the stamp is all it sees."""
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    viewer_id = new_id("cust_name_viewer")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users "
                "(id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                "password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Customer Name Viewer',:email,'Employee',:permissions,:password_hash,"
                ":password_salt,:password_algo,:password_iterations,false,:created_at,NULL,:last_modified)"
            ),
            {
                "id": viewer_id,
                "email": VIEWER_EMAIL,
                "permissions": json_dumps({"receipts": ["view"], "ads": ["view"]}),
                "password_hash": password.hash_hex,
                "password_salt": password.salt_hex,
                "password_algo": password.algo,
                "password_iterations": password.iterations,
                "created_at": stamp,
                "last_modified": stamp,
            },
        )
    login = client.post("/api/auth/login", json={"email": VIEWER_EMAIL, "password": ADMIN_PASSWORD})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    assert client.get("/api/collections/customers", cookies=cookies).status_code == 403
    try:
        yield cookies
    finally:
        with db_conn() as conn:
            for table in ("sessions", "audit_logs"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id = :uid"), {"uid": viewer_id})
            conn.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": viewer_id})


def _new_customer(actors, name):
    customer_id = new_id("moved_customer")
    phone = "092" + str(secrets.randbelow(10**7)).zfill(7)
    created = _create_customer(actors["admin"], customer_id, name, [phone])
    assert created.status_code == 200, created.text
    return customer_id


def _viewer_sees(viewer, collection, entity_id):
    seen = client.get(f"/api/collections/{collection}/{entity_id}", cookies=viewer)
    assert seen.status_code == 200, seen.text
    return seen.json()["data"].get("customerName")


def _mutate_create(actors, ad_id, data):
    created = client.post("/api/ads/mutate", cookies=actors["admin"], json={
        "action": "create", "adId": ad_id, "idempotencyKey": f"{ad_id}_create",
        "data": {"paymentStatus": "not_paid", "collectionMethod": "in_shop",
                 "receiptAllocations": [], "dueAllocations": [], **data}})
    assert created.status_code == 200, created.text
    return created.json()["ad"]


def test_a_receipt_moved_to_another_customer_carries_that_customers_name(actors, viewer):
    first = _new_customer(actors, "Receipt Owner Before")
    second = _new_customer(actors, "Receipt Owner After")
    created = client.post("/api/collections/receipts", cookies=actors["admin"], json={"data": {
        "customerId": first, "status": "Not Paid", "isPaid": False,
        "amountUSD": 10, "amountLocal": 70, "exchangeRate": 7}})
    assert created.status_code == 200, created.text
    moved = client.patch(
        f"/api/collections/receipts/{created.json()['id']}", cookies=actors["admin"],
        json={"data": {"customerId": second}, "expectedLastModified": created.json()["lastModified"]})
    assert moved.status_code == 200, moved.text
    assert _viewer_sees(viewer, "receipts", created.json()["id"]) == "Receipt Owner After"  # before: "...Before"


def test_an_ad_moved_by_a_plain_edit_carries_the_new_customers_name_not_the_clients(actors, viewer):
    first = _new_customer(actors, "Ad Owner Before")
    second = _new_customer(actors, "Ad Owner After")
    ad_id = new_id("moved_ad")
    stamp = _insert_entity("ads", ad_id, {  # an unfunded office ad, stamped for its first customer
        "recordType": "ad", "customerId": first, "customerName": "Ad Owner Before",
        "status": "Active", "paymentStatus": "paid", "collectionMethod": "office"}, actors["admin_id"])
    moved = client.patch(f"/api/collections/ads/{ad_id}", cookies=actors["admin"], json={
        "data": {"customerId": second, "customerName": "Spoof"}, "expectedLastModified": stamp})
    assert moved.status_code == 200, moved.text
    assert _viewer_sees(viewer, "ads", ad_id) == "Ad Owner After"  # before: "Ad Owner Before"


def test_an_ad_moved_through_the_ad_api_carries_the_new_customers_name_not_the_clients(actors, viewer):
    first = _new_customer(actors, "Mutate Owner Before")
    second = _new_customer(actors, "Mutate Owner After")
    ad_id = new_id("moved_mutate_ad")
    created = _mutate_create(actors, ad_id, {"customerId": first})
    updated = client.post("/api/ads/mutate", cookies=actors["admin"], json={
        "action": "update", "adId": ad_id, "idempotencyKey": f"{ad_id}_update",
        "expectedLastModified": created["lastModified"],
        "data": {"customerId": second, "customerName": "Spoof"}})
    assert updated.status_code == 200, updated.text
    assert _viewer_sees(viewer, "ads", ad_id) == "Mutate Owner After"  # before: "Spoof"


def test_records_of_a_merged_customer_carry_the_kept_customers_name(actors, viewer):
    admin_id = actors["admin_id"]
    shared = "093" + str(secrets.randbelow(10**7)).zfill(7)
    duplicate, keep = new_id("merged_away_customer"), new_id("kept_customer")
    duplicate_v = _insert_entity("customers", duplicate, {"name": "Merged Away", "phones": [shared]}, admin_id)
    keep_v = _insert_entity("customers", keep, {"name": "Kept Customer", "phones": [shared]}, admin_id)
    receipt_id, ad_id = new_id("merged_receipt"), new_id("merged_ad")
    _insert_entity("receipts", receipt_id, {"customerId": duplicate, "customerName": "Merged Away",
                                            "status": "Paid", "amountUSD": 5}, admin_id)
    _insert_entity("ads", ad_id, {"customerId": duplicate, "customerName": "Merged Away"}, admin_id)
    merged = client.post("/api/customers/merge", cookies=actors["admin"], json={
        "keepCustomerId": keep, "duplicateCustomerId": duplicate,
        "expectedKeepLastModified": keep_v, "expectedDuplicateLastModified": duplicate_v,
        "idempotencyKey": f"merge-{new_id('op')}"})
    assert merged.status_code == 200, merged.text
    assert _viewer_sees(viewer, "receipts", receipt_id) == "Kept Customer"  # before: "Merged Away"
    assert _viewer_sees(viewer, "ads", ad_id) == "Kept Customer"


def test_an_ad_created_through_the_ad_api_never_keeps_a_client_name(actors, viewer):
    owner = _new_customer(actors, "Created Ad Owner")
    ad_id = new_id("created_mutate_ad")
    _mutate_create(actors, ad_id, {"customerId": owner, "customerName": "Spoof"})
    assert _viewer_sees(viewer, "ads", ad_id) == "Created Ad Owner"
