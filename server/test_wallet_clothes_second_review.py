"""Local API regressions for the second wallet / Clothes review."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
import server.wallet_payments as payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import new_id

PHOTO = ("data:image/png;base64,"
         "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC")


@pytest.fixture
def context():
    init_db()
    actor = {"id": new_id("review2_user"), "role": "Employee", "permissions_json": json_dumps({
        "clothesOrders": ["view", "add", "edit", "delete"],
        "clothesShipments": ["view", "add", "edit", "delete"],
        "clothesProducts": ["view", "add", "edit", "delete"],
    })}
    # Authentication is isolated from these route/RBAC tests. A real participant
    # row is still required by the wallet's active-user transaction guards.
    with db_conn() as conn:
        conn.execute(text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                          "password_algo,password_iterations,deleted,created_at,last_modified) "
                          "VALUES (:id,'Local review participant',:email,'Employee',:perms,'unused','unused',"
                          "'pbkdf2_sha256',1,false,:now,:now)"),
                     {"id": actor["id"], "email": actor["id"] + "@tests.albayanhub.com", "perms": actor["permissions_json"], "now": now_ms()})
    created = []

    def seed(collection, data, *, owner=None, modified=None):
        with db_conn() as conn:
            entity = main._insert_entity_in_transaction(conn, collection, None, data, owner or actor["id"])
            created.append((collection, entity["id"]))
            if modified is not None:
                data = dict(entity["data"], _lastModified=modified)
                conn.execute(text("UPDATE entities SET data_json=:data,last_modified=:modified WHERE type=:type AND id=:id"),
                             {"data": json_dumps(data), "modified": modified, "type": collection, "id": entity["id"]})
                entity.update(data=data, lastModified=modified)
            return entity

    seed("serviceSubscriptions", {"userId": actor["id"], "serviceId": "clothes_system", "status": "active"})
    original = main.app.dependency_overrides.get(main.current_user)
    main.app.dependency_overrides[main.current_user] = lambda: actor
    client = TestClient(main.app, headers={"Origin": "http://testserver"})
    try:
        yield actor, client, seed
    finally:
        if original is None:
            main.app.dependency_overrides.pop(main.current_user, None)
        else:
            main.app.dependency_overrides[main.current_user] = original
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE created_by=:uid"), {"uid": actor["id"]})
            for collection, entity_id in created:
                conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), {"type": collection, "id": entity_id})
            conn.execute(text("DELETE FROM audit_logs WHERE user_id=:uid"), {"uid": actor["id"]})
            conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": actor["id"]})


@pytest.mark.parametrize("kind", ["order", "shipment"])
@pytest.mark.parametrize("access", ["revoked", "view_only", "record_ownership_changed", "product_ownership_changed"])
def test_clothes_replay_rechecks_current_permissions(context, kind, access):
    actor, client, seed = context
    product = seed("clothesProducts", {"name": "Inventory", "costUSD": 2, "variants": [{"color": "Red", "size": "M", "qty": 5}]})
    line = {"productId": product["id"], "color": "Red", "size": "M", "qty": 1, "priceLYD": 10}
    if kind == "order":
        url = "/api/clothes/orders/mutate"
        payload = {"action": "create", "idempotencyKey": new_id("review2_order"), "data": {
            "customerName": "Original customer", "customerPhone": "0911111111", "lines": [line], "paymentStatus": "Not Paid"}}
    else:
        shipment = seed("clothesShipments", {"status": "Shipped", "stockApplied": False, "lines": [line]})
        url = "/api/clothes/shipments/mutate"
        payload = {"action": "status", "idempotencyKey": new_id("review2_shipment"), "shipmentId": shipment["id"],
                   "expectedLastModified": shipment["lastModified"], "status": "Received"}
    initial = client.post(url, json=payload)
    assert initial.status_code == 200, initial.text
    permissions = {module: ["viewOwn"] for module in ("clothesOrders", "clothesShipments", "clothesProducts")}
    # Subscription remains active; a prior mutation never grants lasting access.
    actor["permissions_json"] = json_dumps({} if access == "revoked" else permissions)
    if access in {"record_ownership_changed", "product_ownership_changed"}:
        record = initial.json()[kind] if access == "record_ownership_changed" else product
        with db_conn() as conn:
            conn.execute(text("UPDATE entities SET created_by='other_review_owner' WHERE type=:type AND id=:id"),
                         {"type": record["type"], "id": record["id"]})
    before = main.get_entity("clothesProducts", product["id"])
    replay = client.post(url, json=payload)
    if access in {"revoked", "record_ownership_changed"}:
        assert replay.status_code == 403, replay.text
    else:
        assert replay.status_code == 200, replay.text
        assert replay.json()["replayed"] is True
        assert replay.json()[kind]["id"] == initial.json()[kind]["id"]
        expected_products = [] if access == "product_ownership_changed" else [product["id"]]
        assert [p["id"] for p in replay.json()["updatedProducts"]] == expected_products
        if access == "view_only":
            # A read-only confirmation is allowed; it cannot become a fresh write.
            fresh = client.post(url, json={**payload, "idempotencyKey": new_id("review2_fresh")})
            assert fresh.status_code == 403, fresh.text
    after = main.get_entity("clothesProducts", product["id"])
    assert after["data"] == before["data"]
    assert after["lastModified"] == before["lastModified"]


@pytest.mark.parametrize("action", ["cancel", "confirm", "receipt"])
@pytest.mark.parametrize("clock_offset", [-1000, 0, 1000])
def test_payment_decision_advances_cursor_and_returns_current_version(context, monkeypatch, action, clock_offset):
    actor, client, seed = context
    baseline = now_ms() + 10000
    payment = seed("walletPaymentRequests", {"userId": actor["id"], "status": "pending", "amountMinor": 1000,
                   "currency": "USD", "method": "adfali", "reference": "PAY-REVIEW2"}, modified=baseline)
    if action == "confirm":
        actor["role"] = "Admin"
    monkeypatch.setattr(payments, "now_ms", lambda: baseline + clock_offset)
    body = {"photo": PHOTO} if action == "receipt" else {}
    url = f"/api/wallet/payment-requests/{payment['id']}/{action}"
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    actual = main.get_entity("walletPaymentRequests", payment["id"])
    assert actual["lastModified"] > baseline
    assert response.json()["lastModified"] == actual["lastModified"]
    assert response.json()["data"]["_lastModified"] == actual["lastModified"]
    again = client.post(url, json=body)
    assert again.status_code == 200, again.text
    if action == "receipt":
        assert again.json()["lastModified"] > actual["lastModified"]
    else:
        assert again.json()["lastModified"] == actual["lastModified"]
    if action == "confirm":
        with db_conn() as conn:
            rows = conn.execute(text("SELECT data_json FROM entities WHERE type='walletTransactions' AND created_by=:uid"), {"uid": actor["id"]}).mappings().all()
        assert len(rows) == 1
        assert json_loads(rows[0]["data_json"])["amountMinor"] == 1000


@pytest.mark.parametrize("clock_offset", [-1000, 0, 1000])
def test_old_subscription_cancel_advances_sync_cursor(context, monkeypatch, clock_offset):
    actor, _client, seed = context
    baseline = now_ms() + 10000
    subscription = seed("serviceSubscriptions", {"userId": actor["id"], "serviceId": "ad_maker", "status": "active"}, modified=baseline)
    monkeypatch.setattr(main, "now_ms", lambda: baseline + clock_offset)
    canceled = main._subscription_cancel_atomic(actor, subscription["id"], baseline)
    assert canceled["lastModified"] > baseline
    assert canceled["data"]["_lastModified"] == canceled["lastModified"]


def test_payment_update_conflict_leaves_record_unchanged(context):
    actor, _client, seed = context
    payment = seed("walletPaymentRequests", {"userId": actor["id"], "status": "pending", "amountMinor": 1000})
    with db_conn() as conn:
        canceled = payments._update_payment_row(conn, payment, {**payment["data"], "status": "canceled"})
    with pytest.raises(HTTPException) as caught:
        with db_conn() as conn:
            payments._update_payment_row(conn, payment, {**payment["data"], "status": "confirmed"})
    assert caught.value.status_code == 409
    assert main.get_entity("walletPaymentRequests", payment["id"])["data"] == canceled["data"]


def test_clothes_deleted_order_retry_is_still_idempotent(context):
    actor, client, seed = context
    product = seed("clothesProducts", {"name": "Inventory", "variants": [{"color": "Red", "size": "M", "qty": 4}]})
    order = seed("clothesOrders", {"status": "New", "stockDeducted": True, "lines": [
        {"productId": product["id"], "color": "Red", "size": "M", "qty": 1, "deductedQty": 1}]})
    payload = {"action": "delete", "idempotencyKey": new_id("review2_delete"), "orderId": order["id"], "expectedLastModified": order["lastModified"]}
    first = client.post("/api/clothes/orders/mutate", json=payload)
    assert first.status_code == 200, first.text
    second = client.post("/api/clothes/orders/mutate", json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["replayed"] is True
    assert second.json()["order"]["deleted"] is True
    assert main.get_entity("clothesProducts", product["id"])["data"]["variants"][0]["qty"] == 5
