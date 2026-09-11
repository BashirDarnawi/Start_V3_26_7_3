"""Exercise old-format rows directly, not rows created by today's write path."""

import json
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, text

import server.backfills as backfills
import server.main as main
from server.data_compatibility import DATA_COMPATIBILITY_VERSION
from server.db import METADATA, define_schema


@pytest.fixture()
def old_database(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:")
    define_schema()
    METADATA.create_all(engine)

    @contextmanager
    def connect():
        with engine.begin() as conn:
            yield conn

    for module in (main, backfills):
        monkeypatch.setattr(module, "db_conn", connect)
        monkeypatch.setattr(module, "get_engine", lambda: engine)
    monkeypatch.setattr(backfills, "financial_period_is_closed", lambda *_a, **_k: False)
    monkeypatch.setattr(backfills, "now_ms", lambda: 200)
    yield engine
    engine.dispose()


def insert(engine, collection, entity_id, data, *, modified=100, deleted=False):
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
            "VALUES(:type,:id,:data,:deleted,1,'original_creator',:modified)"
        ), {"type": collection, "id": entity_id, "data": json.dumps(data),
            "deleted": deleted, "modified": modified})


def raw_rows(engine):
    with engine.begin() as conn:
        return [dict(row) for row in conn.execute(text(
            "SELECT * FROM entities ORDER BY type,id"
        )).mappings().all()]


@pytest.mark.parametrize("include_media", [True, False])
@pytest.mark.parametrize("delta", [False, True])
def test_old_receipt_list_and_detail_share_truth_without_writing(old_database, include_media, delta):
    old = {"status": "Not Paid", "isPaid": False, "amountUSD": 150,
           "amountLocal": 1455, "exchangeRate": 9.7,
           "statusDetail": {"notPaidCollection": "office"},
           "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
           "photos": ["data:image/png;base64,old-photo"], "note": "Original note"}
    insert(old_database, "receipts", "old_receipt", old)
    original = raw_rows(old_database)
    admin = {"id": "admin", "role": "Admin", "permissions": {}}
    rows = main.get_collection("receipts", user=admin, include_media=include_media,
                               updated_since=1 if delta else None)
    assert len(rows) == 1
    assert rows[0].data["customerOutstandingUSD"] == 110
    assert rows[0].lastModified == 100
    assert rows[0].createdBy == "original_creator"
    detail = main.get_collection_item("receipts", "old_receipt", user=admin)
    assert detail.data["customerOutstandingUSD"] == 110
    assert detail.data["amountUSD"] == 150
    assert detail.data["exchangeRate"] == 9.7
    assert detail.data["photos"] == old["photos"]
    if not include_media:
        assert "photos" not in rows[0].data
        assert rows[0].data["_photoCount"] == 1
    assert raw_rows(old_database) == original


def test_existing_ad_summaries_use_allocations_without_touching_history(old_database):
    old = {"amountUSD": 100, "companyFundingAllocations": [{"receiptId": "r", "amountUSD": 40}],
           "dueAllocations": [{"receiptId": "r", "amountUSD": 60}],
           "companyFundedUSD": 0, "customerDueUSD": 100,
           "refundDueBaseline": [{"receiptId": "r", "amountUSD": 100}],
           "adPhotos": ["data:image/png;base64,old-ad"]}
    insert(old_database, "ads", "old_ad", old)
    original = raw_rows(old_database)
    admin = {"id": "admin", "role": "Admin", "permissions": {}}
    detail = main.get_collection_item("ads", "old_ad", user=admin)
    assert detail.data["companyFundedUSD"] == 40
    assert detail.data["customerDueUSD"] == 60
    assert detail.data["refundDueBaseline"] == old["refundDueBaseline"]
    assert detail.data["adPhotos"] == old["adPhotos"]
    assert raw_rows(old_database) == original


def test_compatibility_projection_does_not_restore_redacted_fields(old_database):
    old = {"status": "Not Paid", "amountUSD": 100, "companyCoveredUSD": 40,
           "customerOutstandingUSD": 100, "phone": "private-contact",
           "statusDetail": {"notPaidCollection": "office"},
           "adPhotos": ["private-photo"]}
    insert(old_database, "receipts", "old_private_receipt", old)
    employee = {"id": "employee", "role": "Employee", "permissions_json": json.dumps({"receipts": ["view"]})}
    detail = main.get_collection_item("receipts", "old_private_receipt", user=employee)
    assert detail.data["customerOutstandingUSD"] == 60
    assert "phone" not in detail.data
    insert(old_database, "receipts", "deleted", old, deleted=True)
    rows = main.get_collection("receipts", updated_since=1, user=employee)
    tombstone = next(row.data for row in rows if row.id == "deleted")
    assert tombstone["_deleted"] is True
    assert "customerOutstandingUSD" not in tombstone


def test_watermarks_publish_read_version_even_without_any_row_edits(old_database):
    driver = {"id": "driver", "role": "Delivery", "permissions": {}}
    result = main.get_sync_watermarks(user=driver)
    assert result["dataCompatibilityVersion"] == DATA_COMPATIBILITY_VERSION
    assert isinstance(DATA_COMPATIBILITY_VERSION, int) and DATA_COMPATIBILITY_VERSION > 0
    assert "pages" not in result["watermarks"]
    assert all(value == 0 for value in result["watermarks"].values())


@pytest.mark.parametrize("kind", ["name", "covered-settled", "relinked"])
def test_backfill_changes_reach_delta_sync_and_second_pass_is_noop(old_database, kind):
    if kind == "name":
        insert(old_database, "customers", "c", {"name": "Old Customer"})
        collection, data = "receipts", {"customerId": "c", "amountUSD": 100}
        run = backfills.backfill_customer_names
    elif kind == "covered-settled":
        collection, data = "receipts", {"status": "Paid", "amountUSD": 100, "amountLocal": 970,
                                       "companyCoveredUSD": 40, "customerOutstandingUSD": 60}
        run = backfills.backfill_covered_settled_receipts
    else:
        collection, data = "ads", {"receiptAllocations": [{"receiptId": "new", "amountUSD": 60}],
                                  "stopAllocationBaseline": {"receipt": [{"receiptId": "old", "amountUSD": 60}]}}
        run = backfills.backfill_relink_baselines
    data["photos"] = ["data:image/png;base64,original-photo"]
    insert(old_database, collection, "old", data, modified=1000)
    assert run() == 1
    after = raw_rows(old_database)
    changed = next(row for row in after if row["id"] == "old")
    assert changed["last_modified"] == 1001  # monotonic even with a future old timestamp
    changed_data = json.loads(changed["data_json"])
    assert changed_data["_lastModified"] == 1001
    assert changed_data["photos"] == data["photos"]
    assert changed["created_at"] == 1 and changed["created_by"] == "original_creator"
    rows = main.list_entities(collection, updated_since=1000)
    assert "old" in {row["id"] for row in rows}
    assert run() == 0
    assert raw_rows(old_database) == after


def test_backfill_never_changes_closed_period_rows(old_database, monkeypatch):
    insert(old_database, "receipts", "closed", {
        "status": "Paid", "amountUSD": 100, "companyCoveredUSD": 40,
        "customerOutstandingUSD": 60,
    })
    original = raw_rows(old_database)
    monkeypatch.setattr(backfills, "financial_period_is_closed", lambda *_a, **_k: True)
    assert backfills.backfill_covered_settled_receipts() == 0
    assert raw_rows(old_database) == original
