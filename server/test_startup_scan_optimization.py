"""Focused regressions for bounded startup financial scans."""

import json
import sys
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine, text

import server.main as main_module
from server.financial_core import _financial_minor
from server.unpaid_receipt_growth import repair_legacy_unpaid_receipt_overgrowth


def test_financial_active_row_batches_are_keyset_bounded_and_strip_media(monkeypatch):
    """A real SQLite scan is ordered, lossless, page-bounded, and photo-free."""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    monkeypatch.setattr(main_module, "get_engine", lambda: engine)
    ids = [
        "scan_opt_ad_03",
        "scan_opt_ad_01",
        "scan_opt_ad_05",
        "scan_opt_ad_02",
        "scan_opt_ad_04",
    ]
    image = "data:image/png;base64," + ("A" * 2_000)

    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE entities ("
                    "type TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, "
                    "deleted BOOLEAN NOT NULL, created_at BIGINT NOT NULL, "
                    "created_by TEXT, last_modified BIGINT NOT NULL, "
                    "PRIMARY KEY (type, id))"
                )
            )
            for index, entity_id in enumerate(ids):
                conn.execute(
                    text(
                        "INSERT INTO entities "
                        "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                        "VALUES ('ads',:id,:data,false,:stamp,NULL,:stamp)"
                    ),
                    {
                        "id": entity_id,
                        "data": json.dumps(
                            {
                                "recordType": "ad",
                                "amountUSD": index + 1,
                                "receiptAllocations": [],
                                "dueAllocations": [],
                                "adPhotos": [image],
                                "photos": [image],
                                "metaThumbnailData": image,
                            }
                        ),
                        "stamp": index + 1,
                    },
                )

            pages = list(
                main_module._financial_active_row_batches(
                    conn, "ads", batch_size=2
                )
            )

        assert [len(page) for page in pages] == [2, 2, 1]
        rows = [row for page in pages for row in page]
        scanned_ids = [str(row["id"]) for row in rows]
        assert scanned_ids == sorted(ids)
        assert len(scanned_ids) == len(set(scanned_ids)) == len(ids)

        for row in rows:
            raw = str(row["data_json"])
            assert "base64" not in raw
            data = json.loads(raw)
            assert data["amountUSD"] > 0
            for field in ("adPhotos", "photos", "metaThumbnailData"):
                assert field not in data
    finally:
        engine.dispose()


def test_unpaid_overgrowth_uses_one_locked_batched_snapshot_and_preserves_floors():
    """Multiple repairs share one ad pass without weakening debt safeguards."""
    candidate_ids = (
        "scan_opt_receipt_a",
        "scan_opt_receipt_b",
        "scan_opt_receipt_c",
    )
    unproven_id = "scan_opt_receipt_manual_unproven"

    def receipt_row(receipt_id, current, manual_base=None):
        history = []
        if manual_base is not None:
            history = [
                {
                    "editedAt": "2026-08-01T00:00:00Z",
                    "editedBy": "System",
                    "changes": [
                        {
                            "field": "Amount (USD)",
                            "from": f"${manual_base:.2f}",
                            "to": f"${current:.2f}",
                        },
                        {"field": "Funding Ad", "from": "-", "to": "legacy-ad"},
                    ],
                }
            ]
        data = {
            "recordType": "receipt",
            "status": "Not Paid",
            "isPaid": False,
            "statusDetail": {"notPaidCollection": "office"},
            "deliveryStatus": "Office",
            "receiptType": "",
            "amountUSD": current,
            "amountLocal": current * 2,
            "exchangeRate": 2,
            "payments": [],
            "transfers": [],
            "editHistory": history,
            "editCount": len(history),
        }
        return {
            "type": "receipts",
            "id": receipt_id,
            "data_json": json.dumps(data),
            "deleted": False,
            "created_at": 1,
            "created_by": "system",
            "last_modified": 10,
        }

    receipt_rows = [
        receipt_row(candidate_ids[0], 50, 10),
        receipt_row(candidate_ids[1], 25, 20),
        receipt_row(candidate_ids[2], 8, 5),
        receipt_row(unproven_id, 40, None),
    ]
    receipt_by_id = {str(row["id"]): row for row in receipt_rows}

    def ad_row(ad_id, data):
        return {
            "type": "ads",
            "id": ad_id,
            "data_json": json.dumps({"recordType": "ad", **data}),
            "deleted": False,
            "created_at": 1,
            "created_by": "system",
            "last_modified": 10,
        }

    ad_rows = [
        ad_row(
            "scan_opt_modern_a_1",
            {
                "dueAllocations": [
                    {"receiptId": candidate_ids[0], "amountUSD": 12.34}
                ]
            },
        ),
        ad_row(
            "scan_opt_legacy_b",
            {
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": candidate_ids[1],
                "dueAmountToUseUSD": 5,
            },
        ),
        ad_row(
            "scan_opt_modern_a_2_and_c",
            {
                "dueAllocations": [
                    {"receiptId": candidate_ids[0], "amountUSD": 17.66},
                    {"receiptId": candidate_ids[2], "amountUSD": 12},
                ]
            },
        ),
        ad_row(
            "scan_opt_scalar_suppressed_by_real_due_rows",
            {
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": candidate_ids[1],
                "dueAmountToUseUSD": 99,
                "dueAllocations": [
                    {"receiptId": "scan_opt_other_receipt", "amountUSD": 1}
                ],
            },
        ),
    ]

    traversals = {"receipts": 0, "ads": 0}
    events = []
    lock_counts = {receipt_id: 0 for receipt_id in (*candidate_ids, unproven_id)}
    writes = {}
    period_checks = []

    def active_row_batches(_conn, collection):
        traversals[collection] += 1
        events.append(f"scan:{collection}:start")
        if collection == "receipts":
            yield receipt_rows[:2]
            yield receipt_rows[2:]
            return
        assert collection == "ads"
        assert all(lock_counts[receipt_id] >= 1 for receipt_id in candidate_ids)
        assert lock_counts[unproven_id] == 0
        yield ad_rows[:2]
        yield ad_rows[2:]

    def full_scan_must_not_run(_conn, collection):
        raise AssertionError(f"unbounded {collection} scan was used")

    def lock_row(_conn, collection, entity_id, *, postgres):
        assert collection == "receipts"
        assert postgres is True
        lock_counts[entity_id] = lock_counts.get(entity_id, 0) + 1
        events.append(f"lock:{entity_id}:{lock_counts[entity_id]}")
        return receipt_by_id.get(entity_id)

    def row_data(row):
        return json.loads(row.get("data_json") or "{}")

    def write_row(_conn, row, data):
        writes[str(row["id"])] = deepcopy(data)

    def period_open(collection, data, *, conn):
        assert collection == "receipts"
        period_checks.append((str(data.get("amountUSD")), conn))

    ctx = {
        "financial_active_rows": full_scan_must_not_run,
        "financial_active_row_batches": active_row_batches,
        "financial_due_total": lambda data: _financial_minor(
            data.get("amountUSD"), "receipt due amount"
        ),
        "financial_valid_rate": lambda value: Decimal(str(value)),
        "financial_row_data": row_data,
        "receipt_transfer_fields": {
            "transfers",
            "receiptType",
            "transferFromReceiptId",
            "sourceReceiptId",
            "toReceiptId",
        },
        "iso_utc": lambda: "2026-08-13T12:00:00Z",
        "sanitize_str": lambda value, limit: str(value)[:limit],
        "assert_financial_period_open": period_open,
        "lock_row": lock_row,
        "write_row": write_row,
        "postgres": True,
    }

    sentinel_conn = object()
    stats = repair_legacy_unpaid_receipt_overgrowth(sentinel_conn, ctx=ctx)

    assert traversals == {"receipts": 1, "ads": 1}
    first_ads_scan = events.index("scan:ads:start")
    for receipt_id in candidate_ids:
        assert events.index(f"lock:{receipt_id}:1") < first_ads_scan
        assert lock_counts[receipt_id] == 2
    assert lock_counts[unproven_id] == 0

    assert stats == {"scanned": 3, "repaired": 2, "skipped": 1, "failed": 0}
    assert set(writes) == {candidate_ids[0], candidate_ids[1]}

    # Modern rows total exactly $30 for A.
    assert writes[candidate_ids[0]]["amountUSD"] == 30
    assert writes[candidate_ids[0]]["amountLocal"] == 60
    # B has only $5 of live legacy due, but its proven $20 manual base is a floor.
    assert writes[candidate_ids[1]]["amountUSD"] == 20
    assert writes[candidate_ids[1]]["amountLocal"] == 40
    # C needs $12 while storing $8; startup is one-way and must never grow it.
    assert candidate_ids[2] not in writes
    # No Funding Ad history means the $40 may be genuine manual debt.
    assert unproven_id not in writes

    for repaired in writes.values():
        assert repaired["editCount"] == 2
        assert repaired["editHistory"][-1]["editedBy"] == "System startup repair"
        assert any(
            change.get("field") == "Debt Reconciliation"
            for change in repaired["editHistory"][-1]["changes"]
        )
    assert len(period_checks) == 4
    # Fake writes cannot mutate the locked source snapshots before persistence.
    assert row_data(receipt_by_id[candidate_ids[1]])["amountUSD"] == 25
    assert row_data(receipt_by_id[unproven_id])["amountUSD"] == 40
