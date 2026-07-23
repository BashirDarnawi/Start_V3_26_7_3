"""Customer identity uniqueness and deliberate duplicate-merge tests."""

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
import server.main as main_module
from server.main import _preflight_import_unique_identities, app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "duplicate-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "DuplicateAdmin123!"


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


@pytest.fixture(scope="module")
def actors():
    init_db()
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    admin_id = new_id("duplicate_admin")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users "
                "(id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                "password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Duplicate Admin',:email,'Admin',:permissions,:password_hash,"
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

    employee_email = f"duplicate-employee-{new_id('u')}@tests.albayanhub.com"
    created = client.post(
        "/api/users",
        cookies=admin,
        json={
            "name": "Duplicate Employee",
            "email": employee_email,
            "password": "DuplicateEmployee123!",
            "role": "Employee",
            "permissions": {"customers": ["view", "add", "edit", "delete"]},
        },
    )
    assert created.status_code == 200, created.text
    employee_login = client.post(
        "/api/auth/login",
        json={"email": employee_email, "password": "DuplicateEmployee123!"},
    )
    assert employee_login.status_code == 200, employee_login.text
    employee = {"albayan_session": employee_login.cookies.get("albayan_session")}
    client.cookies.clear()
    employee_id = str(created.json()["id"])
    try:
        yield {
            "admin": admin,
            "admin_id": admin_id,
            "employee": employee,
            "employee_id": employee_id,
        }
    finally:
        # This test database is shared by modules in the full suite. Leave no
        # customer/page rows behind that could change another module's counts.
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE created_by IN (:admin_id,:employee_id)"),
                {"admin_id": admin_id, "employee_id": employee_id},
            )
            conn.execute(
                text("DELETE FROM sessions WHERE user_id IN (:admin_id,:employee_id)"),
                {"admin_id": admin_id, "employee_id": employee_id},
            )
            conn.execute(
                text("DELETE FROM audit_logs WHERE user_id IN (:admin_id,:employee_id)"),
                {"admin_id": admin_id, "employee_id": employee_id},
            )
            conn.execute(
                text("DELETE FROM users WHERE id IN (:admin_id,:employee_id)"),
                {"admin_id": admin_id, "employee_id": employee_id},
            )


def _create_customer(cookies, entity_id, name, phones):
    return client.post(
        "/api/collections/customers",
        cookies=cookies,
        json={
            "id": entity_id,
            "data": {
                "name": name,
                "phones": phones,
                "platform": "Facebook",
                "profileLinks": [],
            },
        },
    )


def test_equivalent_phone_formats_are_collapsed_and_blocked_without_pii(actors):
    first_id = new_id("dup_format_first")
    second_id = new_id("dup_format_second")
    first = _create_customer(
        actors["admin"],
        first_id,
        "Private First Customer",
        ["٠٩١-٢٣٤-٥٦٧٨", "+218 91 234 5678"],
    )
    assert first.status_code == 200, first.text
    assert first.json()["data"]["phones"] == ["٠٩١-٢٣٤-٥٦٧٨"]

    conflict = _create_customer(
        actors["employee"],
        second_id,
        "Private Second Customer",
        [{"phoneNumber": "00218 091 234 5678", "label": "legacy"}],
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "This phone number is already linked to another customer"
    # The conflict is useful but never becomes a contact-discovery endpoint.
    assert "091" not in conflict.text
    assert first_id not in conflict.text
    assert "Private First Customer" not in conflict.text


def test_existing_dirty_duplicates_can_be_edited_but_cannot_add_a_collision(actors):
    shared = "0923456789"
    first_id = new_id("dirty_first")
    second_id = new_id("dirty_second")
    first_version = _insert_entity(
        "customers", first_id, {"name": "Dirty One", "phones": [shared]}, actors["admin_id"]
    )
    second_version = _insert_entity(
        "customers", second_id, {"name": "Dirty Two", "phones": [shared]}, actors["admin_id"]
    )
    retained = client.patch(
        f"/api/collections/customers/{first_id}",
        cookies=actors["admin"],
        json={"data": {"name": "Dirty One Updated"}, "expectedLastModified": first_version},
    )
    assert retained.status_code == 200, retained.text

    unique_owner_id = new_id("unique_owner")
    unique_owner = _create_customer(
        actors["admin"], unique_owner_id, "Unique Owner", ["0945556677"]
    )
    assert unique_owner.status_code == 200, unique_owner.text
    collision = client.patch(
        f"/api/collections/customers/{second_id}",
        cookies=actors["admin"],
        json={
            "data": {"phones": [shared, "+218 94 555 6677"]},
            "expectedLastModified": second_version,
        },
    )
    assert collision.status_code == 409


def test_new_customer_requires_valid_phone_and_last_phone_cannot_be_removed(actors):
    missing_id = new_id("missing_phone")
    missing = _create_customer(
        actors["admin"], missing_id, "Missing Phone", []
    )
    assert missing.status_code == 400
    assert missing.json()["detail"] == "At least one valid phone number is required"

    invalid_id = new_id("invalid_phone")
    invalid = _create_customer(
        actors["admin"], invalid_id, "Invalid Phone", ["not-a-phone"]
    )
    assert invalid.status_code == 400

    customer_id = new_id("last_phone")
    created = _create_customer(
        actors["admin"], customer_id, "Has One Phone", ["0927654321"]
    )
    assert created.status_code == 200, created.text
    removed = client.patch(
        f"/api/collections/customers/{customer_id}",
        cookies=actors["admin"],
        json={
            "data": {"phones": []},
            "expectedLastModified": created.json()["lastModified"],
        },
    )
    assert removed.status_code == 400
    assert removed.json()["detail"] == "At least one valid phone number is required"


def test_phone_less_legacy_customer_can_receive_unrelated_edit(actors):
    customer_id = new_id("legacy_phone_less")
    version = _insert_entity(
        "customers",
        customer_id,
        {"name": "Legacy Without Phone", "notes": "old import"},
        actors["admin_id"],
    )
    updated = client.patch(
        f"/api/collections/customers/{customer_id}",
        cookies=actors["admin"],
        json={
            "data": {"notes": "reviewed without changing contact details"},
            "expectedLastModified": version,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["data"]["notes"] == "reviewed without changing contact details"


def test_modern_phones_patch_retires_legacy_scalar_phone_aliases(actors):
    customer_id = new_id("legacy_phone_aliases")
    version = _insert_entity(
        "customers",
        customer_id,
        {
            "name": "Legacy Aliases",
            "phone": "0914567890",
            "phoneNumber": "+218 91 456 7890",
        },
        actors["admin_id"],
    )
    updated = client.patch(
        f"/api/collections/customers/{customer_id}",
        cookies=actors["admin"],
        json={
            "data": {
                "phones": [
                    {"number": "0914567890", "label": "Main", "verified": True}
                ]
            },
            "expectedLastModified": version,
        },
    )
    assert updated.status_code == 200, updated.text
    data = updated.json()["data"]
    assert data["phones"] == [
        {"number": "0914567890", "label": "Main", "verified": True}
    ]
    assert "phone" not in data
    assert "phoneNumber" not in data


def test_concurrent_customer_creates_allow_exactly_one_phone_owner(actors):
    ids = [new_id("concurrent_customer"), new_id("concurrent_customer")]
    phones = ["0937778899", "+218 93 777 8899"]
    sessions = []
    for _ in range(2):
        login = client.post(
            "/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
        assert login.status_code == 200, login.text
        sessions.append({"albayan_session": login.cookies.get("albayan_session")})
        client.cookies.clear()

    def create(index):
        threaded_client = TestClient(app, headers={"Origin": "http://testserver"})
        return _create_with_client(
            threaded_client,
            sessions[index],
            ids[index],
            f"Concurrent {index}",
            [phones[index]],
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(create, range(2)))
    assert statuses == [200, 409]


def _create_with_client(test_client, cookies, entity_id, name, phones):
    return test_client.post(
        "/api/collections/customers",
        cookies=cookies,
        json={"id": entity_id, "data": {"name": name, "phones": phones}},
    )


def test_admin_merge_reassigns_all_links_and_is_idempotent(actors):
    keep_id = new_id("merge_keep")
    duplicate_id = new_id("merge_duplicate")
    shared = "0918887766"
    keep_version = _insert_entity(
        "customers",
        keep_id,
        {
            "name": "Chosen Customer",
            "phones": [shared],
            "profileLinks": ["https://facebook.com/keep"],
            "platform": "Facebook",
        },
        actors["admin_id"],
    )
    duplicate_version = _insert_entity(
        "customers",
        duplicate_id,
        {
            "name": "Old Duplicate",
            "phones": ["+218 91 888 7766", "0921112233"],
            "profileLinks": ["https://facebook.com/duplicate"],
            "legacyNote": "must survive",
        },
        actors["admin_id"],
    )
    page_id = new_id("merge_page")
    receipt_id = new_id("merge_receipt")
    ad_id = new_id("merge_ad")
    _insert_entity(
        "pages",
        page_id,
        {
            "name": "Merge Page",
            "customerIds": [keep_id, duplicate_id],
            "linkedCustomerIds": [duplicate_id, keep_id],
        },
        actors["admin_id"],
    )
    _insert_entity(
        "receipts",
        receipt_id,
        {
            "customerId": duplicate_id,
            "transferFromCustomerId": duplicate_id,
            "sourceCustomerId": duplicate_id,
            "targetCustomerId": duplicate_id,
            "toCustomerId": duplicate_id,
        },
        actors["admin_id"],
    )
    _insert_entity(
        "ads",
        ad_id,
        {"customerId": duplicate_id, "customer": duplicate_id},
        actors["admin_id"],
    )

    operation = {
        "keepCustomerId": keep_id,
        "duplicateCustomerId": duplicate_id,
        "expectedKeepLastModified": keep_version,
        "expectedDuplicateLastModified": duplicate_version,
        "idempotencyKey": f"merge-{new_id('operation')}",
    }
    merged = client.post("/api/customers/merge", cookies=actors["admin"], json=operation)
    assert merged.status_code == 200, merged.text
    body = merged.json()
    assert body["replayed"] is False
    assert body["customer"]["id"] == keep_id
    assert body["customer"]["data"]["legacyNote"] == "must survive"
    assert body["customer"]["data"]["phones"] == [shared, "0921112233"]
    assert body["customer"]["data"]["profileLinks"] == [
        "https://facebook.com/keep",
        "https://facebook.com/duplicate",
    ]
    assert body["duplicate"]["deleted"] is True
    assert body["updatedPages"][0]["data"]["customerIds"] == [keep_id]
    assert body["updatedPages"][0]["data"]["linkedCustomerIds"] == [keep_id]
    assert body["updatedReceipts"][0]["data"]["customerId"] == keep_id
    for field in (
        "transferFromCustomerId",
        "sourceCustomerId",
        "targetCustomerId",
        "toCustomerId",
    ):
        assert body["updatedReceipts"][0]["data"][field] == keep_id
    assert body["updatedAds"][0]["data"]["customerId"] == keep_id
    assert body["updatedAds"][0]["data"]["customer"] == keep_id

    replay = client.post("/api/customers/merge", cookies=actors["admin"], json=operation)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True


def test_merge_preserves_contact_metadata_history_tombstones_and_lean_media(actors):
    keep_id = new_id("edge_merge_keep")
    duplicate_id = new_id("edge_merge_duplicate")
    shared = "0943217654"
    keep_version = _insert_entity(
        "customers",
        keep_id,
        {
            "name": "Metadata Keeper",
            "phones": [
                {"number": shared, "label": "Main", "verified": True}
            ],
            "profileLinks": "https://facebook.com/metadata-keeper",
        },
        actors["admin_id"],
    )
    duplicate_version = _insert_entity(
        "customers",
        duplicate_id,
        {
            "name": "Metadata Duplicate",
            "phones": [
                {"phoneNumber": "+218 94 321 7654", "label": "Old duplicate"},
                {"value": "0923334455", "label": "Shop", "preferred": True},
            ],
            "profileLinks": "https://instagram.com/metadata-duplicate",
        },
        actors["admin_id"],
    )

    active_receipt_id = new_id("edge_merge_active_receipt")
    deleted_page_id = new_id("edge_merge_deleted_page")
    deleted_receipt_id = new_id("edge_merge_deleted_receipt")
    deleted_ad_id = new_id("edge_merge_deleted_ad")
    _insert_entity(
        "receipts",
        active_receipt_id,
        {
            "customerId": duplicate_id,
            "transfers": [
                {
                    "toCustomerId": duplicate_id,
                    "amountUSD": 3,
                    "note": "historical transfer",
                }
            ],
            "photos": ["data:image/png;base64,QUJD"],
            "receiptImage": "data:image/jpeg;base64,REVG",
        },
        actors["admin_id"],
    )
    _insert_entity(
        "pages",
        deleted_page_id,
        {"name": "Deleted Page", "customerId": duplicate_id},
        actors["admin_id"],
        deleted=True,
    )
    _insert_entity(
        "receipts",
        deleted_receipt_id,
        {
            "customerId": duplicate_id,
            "photos": ["data:image/png;base64,R0hJ"],
        },
        actors["admin_id"],
        deleted=True,
    )
    _insert_entity(
        "ads",
        deleted_ad_id,
        {
            "customerId": duplicate_id,
            "adPhotos": ["data:image/png;base64,SktM"],
        },
        actors["admin_id"],
        deleted=True,
    )

    operation = {
        "keepCustomerId": keep_id,
        "duplicateCustomerId": duplicate_id,
        "expectedKeepLastModified": keep_version,
        "expectedDuplicateLastModified": duplicate_version,
        "idempotencyKey": f"merge-{new_id('edge_operation')}",
    }
    merged = client.post(
        "/api/customers/merge?include_media=false",
        cookies=actors["admin"],
        json=operation,
    )
    assert merged.status_code == 200, merged.text
    body = merged.json()

    assert body["customer"]["data"]["phones"] == [
        {"number": shared, "label": "Main", "verified": True},
        {"value": "0923334455", "label": "Shop", "preferred": True},
    ]
    assert body["customer"]["data"]["profileLinks"] == [
        "https://facebook.com/metadata-keeper",
        "https://instagram.com/metadata-duplicate",
    ]

    receipts = {item["id"]: item for item in body["updatedReceipts"]}
    active_receipt = receipts[active_receipt_id]
    assert active_receipt["data"]["customerId"] == keep_id
    assert active_receipt["data"]["transfers"][0]["toCustomerId"] == keep_id
    assert "photos" not in active_receipt["data"]
    assert "receiptImage" not in active_receipt["data"]
    assert active_receipt["data"]["_mediaOmitted"] is True
    assert active_receipt["data"]["_photoCount"] == 2

    deleted_page = next(
        item for item in body["updatedPages"] if item["id"] == deleted_page_id
    )
    deleted_receipt = receipts[deleted_receipt_id]
    deleted_ad = next(
        item for item in body["updatedAds"] if item["id"] == deleted_ad_id
    )
    for entity in (deleted_page, deleted_receipt, deleted_ad):
        assert entity["deleted"] is True
        assert entity["data"]["customerId"] == keep_id
    assert "photos" not in deleted_receipt["data"]
    assert deleted_receipt["data"]["_photoCount"] == 1
    assert "adPhotos" not in deleted_ad["data"]
    assert deleted_ad["data"]["_photoCount"] == 1

    with db_conn() as conn:
        persisted = conn.execute(
            text(
                "SELECT type,id,data_json,deleted FROM entities "
                "WHERE id IN (:page_id,:receipt_id,:ad_id)"
            ),
            {
                "page_id": deleted_page_id,
                "receipt_id": deleted_receipt_id,
                "ad_id": deleted_ad_id,
            },
        ).mappings().all()
    assert len(persisted) == 3
    for row in persisted:
        assert bool(row["deleted"]) is True
        assert json_loads(row["data_json"])["customerId"] == keep_id


def test_merge_requires_admin_and_a_shared_phone(actors):
    left_id = new_id("unrelated_left")
    right_id = new_id("unrelated_right")
    left_version = _insert_entity(
        "customers", left_id, {"name": "Left", "phones": ["0910001234"]}, actors["admin_id"]
    )
    right_version = _insert_entity(
        "customers", right_id, {"name": "Right", "phones": ["0920001234"]}, actors["admin_id"]
    )
    operation = {
        "keepCustomerId": left_id,
        "duplicateCustomerId": right_id,
        "expectedKeepLastModified": left_version,
        "expectedDuplicateLastModified": right_version,
        "idempotencyKey": f"merge-{new_id('unrelated')}",
    }
    forbidden = client.post(
        "/api/customers/merge", cookies=actors["employee"], json=operation
    )
    assert forbidden.status_code == 403
    unrelated = client.post(
        "/api/customers/merge", cookies=actors["admin"], json=operation
    )
    assert unrelated.status_code == 409
    assert unrelated.json()["detail"] == "Customers can only be merged when they share a phone number"
