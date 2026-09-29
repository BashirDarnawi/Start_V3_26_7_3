"""Review loop r4, batch MG (finding 21): a device that has not synced a customer
merge yet is told the customer was MERGED (pick the kept one), not "restore the
customer first", which is impossible and wrong for a merged record.

Disposable records with a unique TAG only; everything this module creates is
soft-deleted again at the end.
"""

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r4-mg-admin-{TAG}@tests.albayanhub.com"
ADMIN_PASSWORD = "R4MergeAdmin123!"
MERGED = "This customer was merged into another customer"
DELETED = "This customer was deleted; restore the customer first"
_created_ids: list[tuple[str, str]] = []


def _insert_entity(collection, entity_id, data, creator_id, *, deleted=False):
    stamp = now_ms()
    payload = dict(data)
    payload.update({"id": entity_id, "_created": stamp, "_lastModified": stamp,
                    "_deleted": bool(deleted), "createdBy": creator_id})
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,:deleted,:created,:creator,:modified)"),
            {"type": collection, "id": entity_id, "data": json_dumps(payload), "deleted": bool(deleted),
             "created": stamp, "creator": creator_id, "modified": stamp},
        )
    _created_ids.append((collection, entity_id))
    return stamp


@pytest.fixture(scope="module")
def actors():
    init_db()
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    admin_id = new_id("r4mg_admin")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,'R4 MG Admin',:email,'Admin',:permissions,:password_hash,:password_salt,"
                 ":password_algo,:password_iterations,false,:created_at,NULL,:last_modified)"),
            {"id": admin_id, "email": ADMIN_EMAIL, "permissions": json_dumps({}),
             "password_hash": password.hash_hex, "password_salt": password.salt_hex,
             "password_algo": password.algo, "password_iterations": password.iterations,
             "created_at": stamp, "last_modified": stamp},
        )
    login = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert login.status_code == 200, login.text
    admin = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    yield {"admin": admin, "admin_id": admin_id}
    with db_conn() as conn:
        for collection, entity_id in _created_ids:
            conn.execute(text("UPDATE entities SET deleted=true WHERE type=:type AND id=:id"),
                         {"type": collection, "id": entity_id})
        conn.execute(text("UPDATE users SET deleted=true WHERE id=:id"), {"id": admin_id})


def _merged_pair(actors):
    keep_id, dup_id = new_id(f"r4mg_{TAG}_keep"), new_id(f"r4mg_{TAG}_dup")
    shared = "09" + str(secrets.randbelow(10 ** 8)).zfill(8)
    keep_v = _insert_entity("customers", keep_id, {"name": "Keep", "phones": [shared]}, actors["admin_id"])
    dup_v = _insert_entity("customers", dup_id, {"name": "Dup", "phones": [shared]}, actors["admin_id"])
    merged = client.post("/api/customers/merge", cookies=actors["admin"], json={
        "keepCustomerId": keep_id, "duplicateCustomerId": dup_id,
        "expectedKeepLastModified": keep_v, "expectedDuplicateLastModified": dup_v,
        "idempotencyKey": f"r4mg-merge-{new_id('op')}",
    })
    assert merged.status_code == 200, merged.text
    assert merged.json()["duplicate"]["data"]["mergedIntoCustomerId"] == keep_id
    return keep_id, dup_id


def test_new_receipt_for_a_merged_customer_names_the_merge(actors):
    keep_id, dup_id = _merged_pair(actors)
    receipt_id = new_id(f"r4mg_{TAG}_r")
    response = client.post("/api/collections/receipts", cookies=actors["admin"], json={
        "id": receipt_id,
        "data": {"customerId": dup_id, "amountUSD": 10, "amountLocal": 50, "exchangeRate": 5,
                 "status": "Paid", "isPaid": True, "serialNumber": str(secrets.randbelow(10 ** 9))},
    })
    _created_ids.append(("receipts", receipt_id))
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail.startswith(MERGED), detail
    assert "restore" not in detail


def test_repointing_a_receipt_to_a_merged_customer_names_the_merge(actors):
    keep_id, dup_id = _merged_pair(actors)
    receipt_id = new_id(f"r4mg_{TAG}_rp")
    stamp = _insert_entity("receipts", receipt_id, {"customerId": keep_id, "amountUSD": 5, "status": "Paid"},
                           actors["admin_id"])
    response = client.patch(f"/api/collections/receipts/{receipt_id}", cookies=actors["admin"],
                            json={"data": {"customerId": dup_id}, "expectedLastModified": stamp})
    assert response.status_code == 409, response.text
    assert response.json()["detail"].startswith(MERGED)


def test_ad_for_a_merged_customer_names_the_merge(actors):
    keep_id, dup_id = _merged_pair(actors)
    ad_id = new_id(f"r4mg_{TAG}_ad")
    response = client.post("/api/ads/mutate", cookies=actors["admin"], json={
        "action": "create", "adId": ad_id, "idempotencyKey": f"r4mg-ad-{new_id('k')}",
        "data": {"customerId": dup_id, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                 "exchangeRate": 5, "startDate": "2026-09-01"},
    })
    _created_ids.append(("ads", ad_id))
    assert response.status_code in (404, 409), response.text
    assert response.json()["detail"].startswith(MERGED), response.text


def test_a_plainly_deleted_customer_keeps_the_restore_advice(actors):
    gone_id = new_id(f"r4mg_{TAG}_gone")
    _insert_entity("customers", gone_id, {"name": "Gone", "phones": []}, actors["admin_id"], deleted=True)
    receipt_id = new_id(f"r4mg_{TAG}_rg")
    response = client.post("/api/collections/receipts", cookies=actors["admin"], json={
        "id": receipt_id,
        "data": {"customerId": gone_id, "amountUSD": 10, "amountLocal": 50, "exchangeRate": 5,
                 "status": "Paid", "isPaid": True, "serialNumber": str(secrets.randbelow(10 ** 9))},
    })
    _created_ids.append(("receipts", receipt_id))
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == DELETED
