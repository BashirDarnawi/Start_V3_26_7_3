"""Regression tests for creator attribution on legacy ad records."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import _ad_mutation_atomic, get_entity
from server.schemas import AdMutationRequest
from server.security import new_id


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()


def _insert_user(conn, name: str) -> str:
    user_id = new_id("legacy_user")
    now = now_ms()
    conn.execute(
        text(
            "INSERT INTO users "
            "(id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
            "VALUES (:id,:name,:email,'Admin','{}','hash','salt','pbkdf2_sha256',1,"
            "false,:now,NULL,:now)"
        ),
        {
            "id": user_id,
            "name": name,
            "email": f"{user_id}@tests.albayanhub.com",
            "now": now,
        },
    )
    return user_id


def _insert_entity(
    conn,
    collection: str,
    entity_id: str,
    data: dict,
    *,
    created_by: str | None,
    modified: int | None = None,
) -> int:
    timestamp = int(modified or now_ms())
    payload = dict(data)
    payload.setdefault("id", entity_id)
    payload.setdefault("_created", timestamp)
    payload.setdefault("_lastModified", timestamp)
    payload.setdefault("_deleted", False)
    conn.execute(
        text(
            "INSERT INTO entities "
            "(type,id,data_json,deleted,created_at,created_by,last_modified) "
            "VALUES (:type,:id,:data,false,:created_at,:created_by,:last_modified)"
        ),
        {
            "type": collection,
            "id": entity_id,
            "data": json_dumps(payload),
            "created_at": timestamp,
            "created_by": created_by,
            "last_modified": timestamp,
        },
    )
    return timestamp


def _legacy_ad(customer_id: str) -> dict:
    return {
        "recordType": "ad",
        "customerId": customer_id,
        "status": "Active",
        "paymentStatus": "wont_pay",
        "collectionMethod": "",
        "collectionPayments": None,
        "receiptAllocations": [],
        "dueAllocations": [],
        "mergedPaidAllocations": [],
        "exchangeRate": 9.5,
        "amountUSD": 0,
        "amountLocal": 0,
        "isPaid": False,
    }


def test_get_entity_uses_db_creator_and_preserves_data_only_history():
    missing_id = new_id("legacy_ad_missing_json_creator")
    conflict_id = new_id("legacy_ad_conflicting_creator")
    data_only_id = new_id("legacy_ad_data_only_creator")
    with db_conn() as conn:
        db_owner = _insert_user(conn, "Database owner")
        stored_owner = _insert_user(conn, "Stored historical owner")
        _insert_entity(conn, "ads", missing_id, {}, created_by=db_owner)
        _insert_entity(
            conn,
            "ads",
            conflict_id,
            {"createdBy": stored_owner},
            created_by=db_owner,
        )
        _insert_entity(
            conn,
            "ads",
            data_only_id,
            {"createdBy": stored_owner},
            created_by=None,
        )

    missing = get_entity("ads", missing_id)
    conflict = get_entity("ads", conflict_id)
    data_only = get_entity("ads", data_only_id)

    assert missing is not None
    assert missing["createdBy"] == db_owner
    assert missing["data"]["createdBy"] == db_owner
    assert conflict is not None
    assert conflict["createdBy"] == db_owner
    assert conflict["data"]["createdBy"] == db_owner
    assert data_only is not None
    assert data_only["createdBy"] is None
    assert data_only["data"]["createdBy"] == stored_owner


def test_ad_update_preserves_authoritative_db_creator_in_legacy_payload():
    customer_id = new_id("legacy_customer")
    ad_id = new_id("legacy_ad_db_creator")
    with db_conn() as conn:
        owner_id = _insert_user(conn, "Original creator")
        editor_id = _insert_user(conn, "Later editor")
        stale_creator_id = _insert_user(conn, "Stale legacy creator")
        _insert_entity(conn, "customers", customer_id, {"name": "Legacy customer"}, created_by=owner_id)
        legacy_data = _legacy_ad(customer_id)
        legacy_data["creatorId"] = stale_creator_id
        version = _insert_entity(
            conn,
            "ads",
            ad_id,
            legacy_data,
            created_by=owner_id,
        )

    saved, replayed = _ad_mutation_atomic(
        {"id": editor_id, "role": "Admin", "permissions": {}},
        AdMutationRequest(
            action="update",
            adId=ad_id,
            idempotencyKey=new_id("legacy_creator_update"),
            expectedLastModified=version,
            data={"adLinks": ["https://example.com/legacy"]},
        ),
    )

    assert replayed is False
    assert saved["createdBy"] == owner_id
    assert saved["data"]["createdBy"] == owner_id
    assert saved["data"]["creatorId"] == owner_id
    assert saved["data"]["creatorId"] != editor_id
    assert saved["data"]["creatorId"] != stale_creator_id


def test_ad_update_keeps_truly_creatorless_legacy_record_unknown():
    customer_id = new_id("creatorless_customer")
    ad_id = new_id("creatorless_ad")
    with db_conn() as conn:
        editor_id = _insert_user(conn, "Unrelated editor")
        _insert_entity(conn, "customers", customer_id, {"name": "Creatorless customer"}, created_by=editor_id)
        version = _insert_entity(
            conn,
            "ads",
            ad_id,
            _legacy_ad(customer_id),
            created_by=None,
        )

    saved, replayed = _ad_mutation_atomic(
        {"id": editor_id, "role": "Admin", "permissions": {}},
        AdMutationRequest(
            action="update",
            adId=ad_id,
            idempotencyKey=new_id("creatorless_update"),
            expectedLastModified=version,
            data={"adLinks": ["https://example.com/unknown"]},
        ),
    )

    assert replayed is False
    assert saved["createdBy"] is None
    assert "createdBy" not in saved["data"]
    assert "creatorId" not in saved["data"]
    assert editor_id not in {saved["data"].get("createdBy"), saved["data"].get("creatorId")}
