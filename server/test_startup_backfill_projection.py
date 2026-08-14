"""Startup backfills must not materialize collection-wide inline media."""

import json
from contextlib import contextmanager

from sqlalchemy import create_engine, text

import server.backfills as backfills
from server.startup_financial_scan import active_row_batches
from server.unpaid_receipt_payment_plan import (
    repair_legacy_unpaid_receipt_payment_plans,
)


def test_heavy_ad_backfills_page_stripped_discovery_and_preserve_full_media(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:")
    image = "data:image/png;base64," + ("A" * 200_000)
    calls = []

    class RecordingConnection:
        def __init__(self, conn):
            self._conn = conn
            self.engine = conn.engine

        def execute(self, statement, params=None):
            calls.append((str(statement), dict(params or {})))
            return self._conn.execute(statement, params or {})

    @contextmanager
    def open_transaction():
        with engine.begin() as conn:
            yield RecordingConnection(conn)

    monkeypatch.setattr(backfills, "db_conn", open_transaction)
    monkeypatch.setattr(backfills, "get_engine", lambda: engine)
    monkeypatch.setattr(backfills, "financial_period_is_closed", lambda *_a, **_k: False)
    monkeypatch.setattr(backfills, "_BACKFILL_SCAN_BATCH_SIZE", 2)

    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE entities ("
                "type TEXT NOT NULL,id TEXT NOT NULL,data_json TEXT NOT NULL,"
                "deleted BOOLEAN NOT NULL,created_at BIGINT NOT NULL,"
                "created_by TEXT,last_modified BIGINT NOT NULL,"
                "PRIMARY KEY(type,id))"
            )
        )
        conn.execute(
            text(
                "INSERT INTO entities VALUES "
                "('customers','stress_customer',:data,false,1,'system',1)"
            ),
            {"data": json.dumps({"name": "Stress Customer"})},
        )
        for index in range(5):
            data = {
                "customerId": "stress_customer",
                "receiptAllocations": [
                    {"receiptId": "stress_new_receipt", "amountUSD": 1}
                ],
                "dueAllocations": [],
                "mergedPaidAllocations": [],
                "adPhotos": [image],
                "metaThumbnailData": image,
            }
            if index == 0:
                data["stopAllocationBaseline"] = {
                    "receipt": [
                        {"receiptId": "stress_old_receipt", "amountUSD": 1}
                    ],
                    "due": [],
                    "dueLegacyReceiptId": "stress_old_receipt",
                }
            conn.execute(
                text(
                    "INSERT INTO entities VALUES "
                    "('ads',:id,:data,false,:stamp,'system',:stamp)"
                ),
                {
                    "id": f"stress_ad_{index}",
                    "data": json.dumps(data),
                    "stamp": index + 2,
                },
            )

    try:
        assert backfills.backfill_customer_names() == 5
        customer_name_pages = [
            (sql, params)
            for sql, params in calls
            if params.get("type") == "ads" and "after_id" in params
        ]
        assert len(customer_name_pages) == 4
        assert all("json_remove(data_json" in sql for sql, _ in customer_name_pages)

        calls.clear()
        assert backfills.backfill_relink_baselines() == 1

        with engine.begin() as conn:
            rows = conn.execute(
                text(
                    "SELECT id,data_json FROM entities "
                    "WHERE type='ads' ORDER BY id"
                )
            ).mappings().all()
        assert len(rows) == 5
        for row in rows:
            data = json.loads(row["data_json"])
            assert data["customerName"] == "Stress Customer"
            assert data["adPhotos"] == [image]
            assert data["metaThumbnailData"] == image

        repaired = json.loads(rows[0]["data_json"])
        baseline = repaired["stopAllocationBaseline"]
        assert baseline["receipt"] == [
            {"receiptId": "stress_new_receipt", "amountUSD": 1}
        ]
        assert baseline["dueLegacyReceiptId"] == "stress_new_receipt"

        ad_pages = [
            (sql, params)
            for sql, params in calls
            if params.get("type") == "ads" and "after_id" in params
        ]
        # The relink pass is forced across three 2-row pages plus its empty
        # keyset terminator. Every discovery query strips images in SQLite
        # before transferring JSON to Python.
        assert len(ad_pages) == 4
        assert all(params["limit"] == 2 for _sql, params in ad_pages)
        assert all("json_remove(data_json" in sql for sql, _params in ad_pages)
        assert all("ORDER BY id LIMIT" in sql for sql, _params in ad_pages)

        full_ad_reads = [
            params
            for sql, params in calls
            if sql.lstrip().startswith("SELECT id,data_json,deleted")
            and params.get("type") == "ads"
        ]
        # Exactly the stale-baseline candidate is decoded with its full media;
        # the four large-image noncandidates never receive a full-row read.
        assert full_ad_reads == [{"type": "ads", "id": "stress_ad_0"}]
        assert all(set(params) == {"type", "id"} for params in full_ad_reads)
    finally:
        engine.dispose()


def test_payment_plan_discovery_never_decodes_noncandidate_receipt_media():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    image = "data:image/png;base64," + ("R" * 200_000)
    candidate_id = "stress_plan_receipt_0"
    decoded_full_ids = []
    page_sizes = []

    def legacy_receipt(*, candidate):
        return {
            "status": "Not Paid",
            "isPaid": False,
            "statusDetail": {"notPaidCollection": "office"},
            "deliveryStatus": "Office",
            "receiptType": "",
            "tempReceiptNo": "",
            "paymentMethod": "Bank Transfer (LYD)",
            "exchangeRate": 10,
            "amountUSD": 10,
            "amountLocal": 100,
            "payments": (
                [
                    {
                        "method": "Bank Transfer (LYD)",
                        "amount": 100,
                        "rate": 0,
                        "rate2": 10,
                    }
                ]
                if candidate
                else []
            ),
            "photos": [image],
            "receiptImage": image,
        }

    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE entities ("
                "type TEXT NOT NULL,id TEXT NOT NULL,data_json TEXT NOT NULL,"
                "deleted BOOLEAN NOT NULL,created_at BIGINT NOT NULL,"
                "created_by TEXT,last_modified BIGINT NOT NULL,"
                "PRIMARY KEY(type,id))"
            )
        )
        for index in range(5):
            conn.execute(
                text(
                    "INSERT INTO entities VALUES "
                    "('receipts',:id,:data,false,:stamp,'system',:stamp)"
                ),
                {
                    "id": f"stress_plan_receipt_{index}",
                    "data": json.dumps(legacy_receipt(candidate=index == 0)),
                    "stamp": index + 1,
                },
            )

    def row_batches(conn, collection):
        for page in active_row_batches(
            conn, collection, dialect="sqlite", batch_size=2
        ):
            page_sizes.append(len(page))
            yield page

    def row_data(row):
        raw = str(row.get("data_json") or "")
        if "base64" in raw:
            decoded_full_ids.append(str(row.get("id") or ""))
        return json.loads(raw or "{}")

    def lock_row(conn, collection, entity_id, *, postgres):
        assert collection == "receipts" and postgres is False
        return conn.execute(
            text(
                "SELECT type,id,data_json,deleted,created_at,created_by,last_modified "
                "FROM entities WHERE type=:type AND id=:id"
            ),
            {"type": collection, "id": entity_id},
        ).mappings().first()

    def write_row(conn, row, data):
        conn.execute(
            text(
                "UPDATE entities SET data_json=:data "
                "WHERE type='receipts' AND id=:id"
            ),
            {"data": json.dumps(data), "id": str(row["id"])},
        )

    ctx = {
        "financial_active_rows": lambda *_a: (_ for _ in ()).throw(
            AssertionError("unbounded receipt scan was used")
        ),
        "financial_active_row_batches": row_batches,
        "financial_row_data": row_data,
        "lock_row": lock_row,
        "write_row": write_row,
        "iso_utc": lambda: "2026-08-13T12:00:00Z",
        "assert_financial_period_open": lambda *_a, **_k: None,
        "postgres": False,
    }

    try:
        with engine.begin() as conn:
            stats = repair_legacy_unpaid_receipt_payment_plans(conn, ctx=ctx)
        assert stats == {"scanned": 1, "repaired": 1, "skipped": 0, "failed": 0}
        assert page_sizes == [2, 2, 1]
        assert decoded_full_ids == [candidate_id]

        with engine.begin() as conn:
            raw = conn.execute(
                text(
                    "SELECT data_json FROM entities "
                    "WHERE type='receipts' AND id=:id"
                ),
                {"id": candidate_id},
            ).scalar_one()
        repaired = json.loads(raw)
        assert repaired["payments"] == []
        assert repaired["plannedPayments"][0]["amount"] == 100
        assert repaired["photos"] == [image]
        assert repaired["receiptImage"] == image
    finally:
        engine.dispose()
