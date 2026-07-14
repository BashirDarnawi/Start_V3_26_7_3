"""Transactional clothes-order and inventory regression tests."""

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import _clothes_order_mutation_atomic, app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "clothes-transaction-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "ClothesTransaction123!"


def _ensure_admin() -> str:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
        uid = new_id("user")
        now = now_ms()
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Clothes Transaction Admin',:email,'Admin',:permissions,:hash,:salt,"
                ":algo,:iterations,false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "permissions": json_dumps({}),
                "hash": password.hash_hex,
                "salt": password.salt_hex,
                "algo": password.algo,
                "iterations": password.iterations,
                "now": now,
            },
        )
        return uid


@pytest.fixture(scope="module")
def actor():
    init_db()
    uid = _ensure_admin()
    response = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {
        "cookies": cookies,
        "user": {"id": uid, "role": "Admin", "permissions_json": "{}"},
    }


@pytest.fixture(scope="module")
def subscriber_actor(actor):
    email = "clothes-subscriber@tests.albayanhub.com"
    password_text = "ClothesSubscriber123!"
    password = hash_password(password_text, iterations=PBKDF2_ITERATIONS_DEFAULT)
    permissions = json_dumps(
        {
            "clothesProducts": ["view", "add", "edit", "delete"],
            "clothesShipments": ["view", "add", "edit", "delete"],
            "clothesOrders": ["view", "add", "edit", "delete"],
            "clothesSettings": ["viewOwn", "add", "editOwn"],
        }
    )
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": email},
        ).mappings().first()
        uid = str(row["id"]) if row else "clothes_subscription_test_user"
        if row:
            conn.execute(
                text(
                    "UPDATE users SET role='Employee',permissions_json=:permissions,"
                    "password_hash=:hash,password_salt=:salt,password_algo=:algo,"
                    "password_iterations=:iterations,deleted=false,last_modified=:now WHERE id=:id"
                ),
                {
                    "permissions": permissions,
                    "hash": password.hash_hex,
                    "salt": password.salt_hex,
                    "algo": password.algo,
                    "iterations": password.iterations,
                    "now": now,
                    "id": uid,
                },
            )
        else:
            conn.execute(
                text(
                    "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                    "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                    "VALUES (:id,'Clothes Subscriber',:email,'Employee',:permissions,:hash,:salt,"
                    ":algo,:iterations,false,:now,NULL,:now)"
                ),
                {
                    "id": uid,
                    "email": email,
                    "permissions": permissions,
                    "hash": password.hash_hex,
                    "salt": password.salt_hex,
                    "algo": password.algo,
                    "iterations": password.iterations,
                    "now": now,
                },
            )
        rows = conn.execute(
            text("SELECT id,data_json FROM entities WHERE type='serviceSubscriptions'")
        ).mappings().all()
        for subscription in rows:
            data = json_loads(subscription["data_json"]) or {}
            if str(data.get("userId") or "") == uid and str(data.get("serviceId") or "") == "clothes_system":
                conn.execute(
                    text("DELETE FROM entities WHERE type='serviceSubscriptions' AND id=:id"),
                    {"id": subscription["id"]},
                )
    response = client.post(
        "/api/auth/login", json={"email": email, "password": password_text}
    )
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "cookies": cookies}


def _create_product(actor, product_id: str, qty: int):
    response = client.post(
        "/api/collections/clothesProducts",
        json={
            "id": product_id,
            "data": {
                "name": product_id,
                "costUSD": 3.25,
                "priceLYD": 20,
                "variants": [{"color": "Red", "size": "M", "qty": qty}],
            },
        },
        cookies=actor["cookies"],
    )
    assert response.status_code == 200, response.text
    return response.json()


def _order_data(product_id: str, qty: int, customer: str = "Test Customer"):
    return {
        "customerName": customer,
        "customerPhone": "0910000000",
        "note": "transaction test",
        "lines": [
            {
                "productId": product_id,
                "color": "Red",
                "size": "M",
                "qty": qty,
                "priceLYD": 20,
            }
        ],
        "deliveryFeeLYD": 5,
        "paymentStatus": "Not Paid",
        "amountPaidLYD": 0,
        "paymentMethod": "Cash",
    }


def _mutate(actor, payload: dict):
    return client.post(
        "/api/clothes/orders/mutate", json=payload, cookies=actor["cookies"]
    )


def _mutate_shipment(actor, payload: dict):
    return client.post(
        "/api/clothes/shipments/mutate", json=payload, cookies=actor["cookies"]
    )


def _product_qty(product_id: str) -> int:
    with db_conn() as conn:
        row = conn.execute(
            text(
                "SELECT data_json FROM entities "
                "WHERE type='clothesProducts' AND id=:id AND deleted=false"
            ),
            {"id": product_id},
        ).mappings().one()
    return int((json_loads(row["data_json"])["variants"])[0]["qty"])


class TestClothesOrderLifecycle:
    def test_create_without_order_id_replays_same_result(self, actor):
        product_id = "clothes_tx_product_derived_order_id"
        _create_product(actor, product_id, 2)
        payload = {
            "action": "create",
            "idempotencyKey": "clothes-create-derived-order-id-001",
            "data": _order_data(product_id, 1),
        }
        first = _mutate(actor, payload)
        second = _mutate(actor, payload)
        assert first.status_code == second.status_code == 200
        assert second.json()["replayed"] is True
        assert second.json()["order"]["id"] == first.json()["order"]["id"]
        assert _product_qty(product_id) == 1

    def test_create_retry_insufficient_update_status_payment_delete_and_restore(self, actor):
        product_id = "clothes_tx_product_lifecycle"
        order_id = "clothes_tx_order_lifecycle"
        _create_product(actor, product_id, 5)

        create_payload = {
            "action": "create",
            "idempotencyKey": "clothes-create-lifecycle-001",
            "orderId": order_id,
            "data": _order_data(product_id, 4),
        }
        created = _mutate(actor, create_payload)
        assert created.status_code == 200, created.text
        created_body = created.json()
        assert created_body["order"]["data"]["orderNo"] >= 1
        assert created_body["order"]["data"]["lines"][0]["deductedQty"] == 4
        assert _product_qty(product_id) == 1

        retried = _mutate(actor, create_payload)
        assert retried.status_code == 200
        assert retried.json()["replayed"] is True
        assert retried.json()["order"]["id"] == order_id
        assert _product_qty(product_id) == 1

        reused = _mutate(actor, {**create_payload, "data": _order_data(product_id, 3)})
        assert reused.status_code == 409
        assert _product_qty(product_id) == 1

        insufficient = _mutate(
            actor,
            {
                "action": "create",
                "idempotencyKey": "clothes-create-insufficient-001",
                "orderId": "clothes_tx_order_insufficient",
                "data": _order_data(product_id, 2),
            },
        )
        assert insufficient.status_code == 409
        assert _product_qty(product_id) == 1
        with db_conn() as conn:
            assert conn.execute(
                text(
                    "SELECT id FROM entities "
                    "WHERE type='clothesOrders' AND id='clothes_tx_order_insufficient'"
                )
            ).first() is None

        missing_update = _mutate(
            actor,
            {
                "action": "update",
                "idempotencyKey": "clothes-update-invalid-001",
                "orderId": order_id,
                "expectedLastModified": created_body["order"]["lastModified"],
                "data": _order_data("clothes_tx_missing_product", 1),
            },
        )
        assert missing_update.status_code == 404
        assert _product_qty(product_id) == 1

        updated = _mutate(
            actor,
            {
                "action": "update",
                "idempotencyKey": "clothes-update-lifecycle-001",
                "orderId": order_id,
                "expectedLastModified": created_body["order"]["lastModified"],
                "data": _order_data(product_id, 2, "Edited Customer"),
            },
        )
        assert updated.status_code == 200, updated.text
        updated_body = updated.json()
        assert updated_body["order"]["data"]["customerName"] == "Edited Customer"
        assert _product_qty(product_id) == 3

        stale = _mutate(
            actor,
            {
                "action": "status",
                "idempotencyKey": "clothes-status-stale-001",
                "orderId": order_id,
                "expectedLastModified": created_body["order"]["lastModified"],
                "status": "Returned",
            },
        )
        assert stale.status_code == 409
        assert _product_qty(product_id) == 3

        returned_payload = {
            "action": "status",
            "idempotencyKey": "clothes-status-returned-001",
            "orderId": order_id,
            "expectedLastModified": updated_body["order"]["lastModified"],
            "status": "Returned",
        }
        returned = _mutate(actor, returned_payload)
        assert returned.status_code == 200, returned.text
        returned_body = returned.json()
        assert returned_body["order"]["data"]["stockDeducted"] is False
        assert _product_qty(product_id) == 5
        returned_retry = _mutate(actor, returned_payload)
        assert returned_retry.status_code == 200
        assert returned_retry.json()["replayed"] is True
        assert _product_qty(product_id) == 5

        reactivated = _mutate(
            actor,
            {
                "action": "status",
                "idempotencyKey": "clothes-status-reactivate-001",
                "orderId": order_id,
                "expectedLastModified": returned_body["order"]["lastModified"],
                "status": "New",
            },
        )
        assert reactivated.status_code == 200, reactivated.text
        reactivated_body = reactivated.json()
        assert reactivated_body["order"]["data"]["stockDeducted"] is True
        assert _product_qty(product_id) == 3

        paid = _mutate(
            actor,
            {
                "action": "payment",
                "idempotencyKey": "clothes-payment-paid-001",
                "orderId": order_id,
                "expectedLastModified": reactivated_body["order"]["lastModified"],
                "paymentStatus": "Paid",
            },
        )
        assert paid.status_code == 200, paid.text
        paid_body = paid.json()
        assert paid_body["order"]["data"]["amountPaidLYD"] == 45
        assert paid_body["order"]["data"]["paidAt"]
        assert _product_qty(product_id) == 3

        delete_payload = {
            "action": "delete",
            "idempotencyKey": "clothes-delete-lifecycle-001",
            "orderId": order_id,
            "expectedLastModified": paid_body["order"]["lastModified"],
        }
        deleted = _mutate(actor, delete_payload)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["order"]["deleted"] is True
        assert _product_qty(product_id) == 5
        deleted_retry = _mutate(actor, delete_payload)
        assert deleted_retry.status_code == 200
        assert deleted_retry.json()["replayed"] is True
        assert _product_qty(product_id) == 5

    def test_transaction_rolls_back_when_marker_write_fails(self, actor, monkeypatch):
        product_id = "clothes_tx_product_rollback"
        order_id = "clothes_tx_order_rollback"
        _create_product(actor, product_id, 2)
        original_insert = main_module._insert_entity_in_transaction

        def fail_marker(conn, collection, entity_id, data, created_by):
            if collection == main_module.CLOTHES_ORDER_MUTATION_COLLECTION:
                raise HTTPException(status_code=500, detail="forced marker failure")
            return original_insert(conn, collection, entity_id, data, created_by)

        monkeypatch.setattr(main_module, "_insert_entity_in_transaction", fail_marker)
        response = _mutate(
            actor,
            {
                "action": "create",
                "idempotencyKey": "clothes-create-rollback-001",
                "orderId": order_id,
                "data": _order_data(product_id, 2),
            },
        )
        assert response.status_code == 500
        assert _product_qty(product_id) == 2
        with db_conn() as conn:
            assert conn.execute(
                text(
                    "SELECT id FROM entities WHERE type='clothesOrders' AND id=:id"
                ),
                {"id": order_id},
            ).first() is None


class TestClothesOrderConcurrencyAndBypasses:
    def test_concurrent_orders_cannot_oversell(self, actor):
        product_id = "clothes_tx_product_concurrent"
        _create_product(actor, product_id, 1)

        def create(index: int) -> int:
            try:
                _clothes_order_mutation_atomic(
                    actor["user"],
                    action="create",
                    idempotency_key=f"clothes-concurrent-create-{index}",
                    order_id=f"clothes_tx_order_concurrent_{index}",
                    data=_order_data(product_id, 1),
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(create, [1, 2]))
        assert sorted(statuses) == [200, 409]
        assert _product_qty(product_id) == 0
        with db_conn() as conn:
            count = conn.execute(
                text(
                    "SELECT COUNT(*) FROM entities WHERE type='clothesOrders' "
                    "AND id IN ('clothes_tx_order_concurrent_1','clothes_tx_order_concurrent_2') "
                    "AND deleted=false"
                )
            ).scalar()
        assert int(count or 0) == 1

    def test_generic_order_mutation_paths_are_blocked(self, actor):
        order_id = "clothes_tx_order_generic_bypass"
        created = client.post(
            "/api/collections/clothesOrders",
            json={"id": order_id, "data": {"customerName": "Bypass"}},
            cookies=actor["cookies"],
        )
        patched = client.patch(
            f"/api/collections/clothesOrders/{order_id}",
            json={"data": {"stockDeducted": False}},
            cookies=actor["cookies"],
        )
        deleted = client.delete(
            f"/api/collections/clothesOrders/{order_id}", cookies=actor["cookies"]
        )
        restored = client.put(
            f"/api/admin/collections/clothesOrders/{order_id}/restore",
            json={"data": {"customerName": "Bypass"}, "createdAt": now_ms()},
            cookies=actor["cookies"],
        )
        imported = client.post(
            "/api/admin/import",
            json={"collections": {"clothesOrders": []}},
            cookies=actor["cookies"],
        )
        batch = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "clothesOrders", "id": order_id}]},
            cookies=actor["cookies"],
        )
        assert {
            created.status_code,
            patched.status_code,
            deleted.status_code,
            restored.status_code,
            imported.status_code,
            batch.status_code,
        } == {405}


class TestClothesShipmentTransactions:
    def test_receive_retry_unreceive_delete_and_generic_guards(self, actor):
        product_id = "clothes_tx_product_shipment_lifecycle"
        shipment_id = "clothes_tx_shipment_lifecycle"
        _create_product(actor, product_id, 2)
        created = client.post(
            "/api/collections/clothesShipments",
            json={
                "id": shipment_id,
                "data": {
                    "ref": "SHIP-1",
                    "status": "Received",
                    "stockApplied": True,
                    "receivedAt": "forged",
                    "lines": [
                        {
                            "productId": product_id,
                            "color": "Red",
                            "size": "M",
                            "qty": 3,
                            "unitCostUSD": 3.25,
                        }
                    ],
                },
            },
            cookies=actor["cookies"],
        )
        assert created.status_code == 200, created.text
        assert created.json()["data"]["status"] == "Ordered"
        assert created.json()["data"]["stockApplied"] is False

        receive_payload = {
            "action": "status",
            "idempotencyKey": "clothes-shipment-receive-001",
            "shipmentId": shipment_id,
            "expectedLastModified": created.json()["lastModified"],
            "status": "Received",
        }
        received = _mutate_shipment(actor, receive_payload)
        assert received.status_code == 200, received.text
        assert received.json()["shipment"]["data"]["stockApplied"] is True
        assert received.json()["shipment"]["data"]["receivedAt"]
        assert _product_qty(product_id) == 5
        replay = _mutate_shipment(actor, receive_payload)
        assert replay.status_code == 200
        assert replay.json()["replayed"] is True
        assert _product_qty(product_id) == 5

        generic_status = client.patch(
            f"/api/collections/clothesShipments/{shipment_id}",
            json={
                "data": {"status": "Arrived", "stockApplied": False},
                "expectedLastModified": received.json()["shipment"]["lastModified"],
            },
            cookies=actor["cookies"],
        )
        generic_delete = client.delete(
            f"/api/collections/clothesShipments/{shipment_id}",
            cookies=actor["cookies"],
        )
        assert generic_status.status_code == generic_delete.status_code == 405
        assert _product_qty(product_id) == 5

        unreceive_payload = {
            "action": "status",
            "idempotencyKey": "clothes-shipment-unreceive-001",
            "shipmentId": shipment_id,
            "expectedLastModified": received.json()["shipment"]["lastModified"],
            "status": "Arrived",
        }
        unreceived = _mutate_shipment(actor, unreceive_payload)
        assert unreceived.status_code == 200, unreceived.text
        assert unreceived.json()["shipment"]["data"]["stockApplied"] is False
        assert _product_qty(product_id) == 2

        delete_payload = {
            "action": "delete",
            "idempotencyKey": "clothes-shipment-delete-001",
            "shipmentId": shipment_id,
            "expectedLastModified": unreceived.json()["shipment"]["lastModified"],
        }
        deleted = _mutate_shipment(actor, delete_payload)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["shipment"]["deleted"] is True
        delete_replay = _mutate_shipment(actor, delete_payload)
        assert delete_replay.status_code == 200
        assert delete_replay.json()["replayed"] is True
        assert _product_qty(product_id) == 2

    def test_unreceive_rolls_back_when_received_pieces_were_sold(self, actor):
        product_id = "clothes_tx_product_shipment_sold"
        shipment_id = "clothes_tx_shipment_sold"
        _create_product(actor, product_id, 0)
        created = client.post(
            "/api/collections/clothesShipments",
            json={
                "id": shipment_id,
                "data": {
                    "lines": [
                        {"productId": product_id, "color": "Red", "size": "M", "qty": 2}
                    ]
                },
            },
            cookies=actor["cookies"],
        )
        received = _mutate_shipment(
            actor,
            {
                "action": "status",
                "idempotencyKey": "clothes-shipment-receive-sold-001",
                "shipmentId": shipment_id,
                "expectedLastModified": created.json()["lastModified"],
                "status": "Received",
            },
        )
        assert received.status_code == 200, received.text
        order = _mutate(
            actor,
            {
                "action": "create",
                "idempotencyKey": "clothes-order-sell-shipment-001",
                "orderId": "clothes_tx_order_shipment_sold",
                "data": _order_data(product_id, 1),
            },
        )
        assert order.status_code == 200, order.text
        assert _product_qty(product_id) == 1

        failed = _mutate_shipment(
            actor,
            {
                "action": "status",
                "idempotencyKey": "clothes-shipment-unreceive-sold-001",
                "shipmentId": shipment_id,
                "expectedLastModified": received.json()["shipment"]["lastModified"],
                "status": "Arrived",
            },
        )
        assert failed.status_code == 409
        assert _product_qty(product_id) == 1
        current = client.get(
            f"/api/collections/clothesShipments/{shipment_id}",
            cookies=actor["cookies"],
        )
        assert current.status_code == 200
        assert current.json()["data"]["status"] == "Received"
        assert current.json()["data"]["stockApplied"] is True


class TestClothesSubscriptionBoundary:
    def test_none_expired_canceled_and_active_entitlement(self, subscriber_actor):
        cookies = subscriber_actor["cookies"]
        uid = subscriber_actor["id"]
        no_subscription = client.get(
            "/api/collections/clothesProducts", cookies=cookies
        )
        no_subscription_write = client.post(
            "/api/collections/clothesProducts",
            json={"id": "clothes_forbidden_without_subscription", "data": {"variants": []}},
            cookies=cookies,
        )
        assert no_subscription.status_code == no_subscription_write.status_code == 403

        subscription_id = "clothes_subscription_boundary_record"

        def set_subscription(status: str, expires_at: str):
            data = {
                "id": subscription_id,
                "userId": uid,
                "serviceId": "clothes_system",
                "status": status,
                "expiresAt": expires_at,
            }
            stamp = now_ms()
            with db_conn() as conn:
                conn.execute(
                    text("DELETE FROM entities WHERE type='serviceSubscriptions' AND id=:id"),
                    {"id": subscription_id},
                )
                conn.execute(
                    text(
                        "INSERT INTO entities "
                        "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                        "VALUES ('serviceSubscriptions',:id,:data,false,:stamp,:uid,:stamp)"
                    ),
                    {
                        "id": subscription_id,
                        "data": json_dumps(data),
                        "stamp": stamp,
                        "uid": uid,
                    },
                )

        set_subscription("active", "2000-01-01T00:00:00Z")
        assert client.get("/api/collections/clothesProducts", cookies=cookies).status_code == 403
        set_subscription("canceled", "2099-01-01T00:00:00Z")
        assert client.get("/api/collections/clothesProducts", cookies=cookies).status_code == 403
        set_subscription("active", "2099-01-01T00:00:00Z")
        allowed = client.get("/api/collections/clothesProducts", cookies=cookies)
        assert allowed.status_code == 200, allowed.text
        watermarks = client.get("/api/sync/watermarks", cookies=cookies)
        assert watermarks.status_code == 200
        assert "clothesProducts" in watermarks.json()["watermarks"]
