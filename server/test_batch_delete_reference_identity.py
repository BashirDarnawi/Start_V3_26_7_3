"""A batch item is identified by its collection AND ID, not ID alone."""

import pytest
from sqlalchemy import text

from server import test_receipt_relink as t
from server.db import db_conn
from server.main import _insert_entity_in_transaction


@pytest.fixture(scope="module")
def admin():
    return t.admin.__wrapped__()


@pytest.fixture
def owned_records():
    """Remove only this test's explicitly registered disposable entities.

    Other suites legitimately exercise whole-collection restore/pruning, so
    intentionally surviving collision fixtures must not leak into those tests.
    Shared login users and every unregistered record remain untouched.
    """
    records = []
    yield records
    with db_conn() as conn:
        for collection, entity_id in reversed(records):
            conn.execute(
                text("DELETE FROM entities WHERE type=:type AND id=:id"),
                {"type": collection, "id": entity_id},
            )


def _batch(items, admin):
    return t.client.post("/api/batch/delete", json={"items": [
        {"collection": collection, "id": entity_id} for collection, entity_id in items
    ]}, cookies=admin)


def _seed_reference(tag, collection, admin, owned_records):
    customer, record = tag + "_customer", tag + "_record"
    owned_records.extend([("customers", customer), (collection, record)])
    t._customer(customer, admin)
    if collection == "receipts":
        t._office_receipt(record, customer, 20, admin)
    else:
        # Supported old receiptless ad, inserted without today's create path.
        # This also tests retention of already-existing customer references.
        actor_id = t._ensure_admin()
        with db_conn() as conn:
            _insert_entity_in_transaction(conn, "ads", record, {
                "customerId": customer, "amountUSD": 20, "status": "Active",
                "paymentStatus": "not_paid", "isPaid": False,
            }, actor_id)
    return customer, record


@pytest.mark.parametrize("linked_collection", ["receipts", "ads"])
@pytest.mark.parametrize("collision_exists", [False, True])
def test_page_id_collision_cannot_bypass_customer_reference_guard(admin, owned_records, linked_collection, collision_exists):
    tag = f"batch_identity_{linked_collection}_{int(collision_exists)}"
    customer, record = _seed_reference(tag, linked_collection, admin, owned_records)
    if collision_exists:
        owned_records.append(("pages", record))
        created = t.client.post("/api/collections/pages", json={
            "id": record, "data": {"name": "Unrelated page", "customerId": ""},
        }, cookies=admin)
        assert created.status_code == 200, created.text
    result = _batch([("customers", customer), ("pages", record)], admin)
    assert result.status_code == 409, result.text
    assert t.client.get(f"/api/collections/customers/{customer}", cookies=admin).status_code == 200
    assert t.client.get(f"/api/collections/{linked_collection}/{record}", cookies=admin).status_code == 200
    if collision_exists:
        assert t.client.get(f"/api/collections/pages/{record}", cookies=admin).status_code == 200


@pytest.mark.parametrize("linked_collection,wrong_collection", [("receipts", "ads"), ("ads", "receipts")])
def test_financial_collection_collision_also_cannot_orphan_customer(admin, owned_records, linked_collection, wrong_collection):
    customer, record = _seed_reference(f"batch_financial_identity_{linked_collection}", linked_collection, admin, owned_records)
    result = _batch([("customers", customer), (wrong_collection, record)], admin)
    assert result.status_code == 409, result.text
    assert t.client.get(f"/api/collections/customers/{customer}", cookies=admin).status_code == 200
    assert t.client.get(f"/api/collections/{linked_collection}/{record}", cookies=admin).status_code == 200


@pytest.mark.parametrize("linked_collection", ["receipts", "ads"])
def test_customer_and_actual_linked_record_can_still_be_deleted_together(admin, owned_records, linked_collection):
    customer, record = _seed_reference(f"batch_valid_identity_{linked_collection}", linked_collection, admin, owned_records)
    result = _batch([("customers", customer), (linked_collection, record)], admin)
    assert result.status_code == 200, result.text
    assert result.json()["deleted"] == 2
    assert t.client.get(f"/api/collections/customers/{customer}", cookies=admin).status_code == 404
    assert t.client.get(f"/api/collections/{linked_collection}/{record}", cookies=admin).status_code == 404
