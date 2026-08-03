"""Money scans drop photos at the database; the money answers must not move.

_financial_active_rows runs inside transactions holding FOR UPDATE locks, so
it now asks the database to strip each row's base64 images instead of shipping
and parsing them. That is only safe if two things hold, and both are pinned
here: the money fields survive untouched, and the images really are gone (a
caller that wrote such a row back would erase them, which is why the helper's
contract forbids it).
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import (
    _financial_active_rows,
    _financial_committed_usage,
    _financial_row_data,
    _financial_usage,
)

BIG_IMAGE = "data:image/png;base64," + ("A" * 20000)

AD_ROWS = [
    (
        "ad_proj_paid",
        {
            "recordType": "ad",
            "customerId": "cust_proj",
            "amountUSD": 100.0,
            "status": "Active",
            "paymentStatus": "paid",
            "receiptAllocations": [{"receiptId": "rcpt_proj", "amountUSD": 60.0}],
            "dueAllocations": [],
            "adPhotos": [BIG_IMAGE, BIG_IMAGE],
            "photos": [BIG_IMAGE],
            "metaThumbnailData": BIG_IMAGE,
        },
    ),
    (
        "ad_proj_due",
        {
            "recordType": "ad",
            "customerId": "cust_proj",
            "amountUSD": 40.0,
            "status": "Active",
            "paymentStatus": "not_paid",
            "receiptAllocations": [],
            "dueAllocations": [{"receiptId": "rcpt_proj", "amountUSD": 25.0}],
            "adPhotos": [BIG_IMAGE],
        },
    ),
]


def _seed():
    with db_conn() as conn:
        for eid, data in AD_ROWS:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('ads',:i,:d,false,:now,'system',:now)"
                ),
                {"i": eid, "d": json_dumps(data), "now": now_ms()},
            )


def _clear():
    with db_conn() as conn:
        for eid, _data in AD_ROWS:
            conn.execute(text("DELETE FROM entities WHERE type='ads' AND id=:i"), {"i": eid})


def test_money_math_is_identical_with_photos_stripped():
    init_db()
    _seed()
    try:
        with db_conn() as conn:
            rows = _financial_active_rows(conn, "ads")
            by_id = {str(r.get("id")): _financial_row_data(r) for r in rows}
            assert set(by_id) >= {"ad_proj_paid", "ad_proj_due"}

            # Money fields survive exactly.
            assert by_id["ad_proj_paid"]["amountUSD"] == 100.0
            assert by_id["ad_proj_paid"]["receiptAllocations"] == [
                {"receiptId": "rcpt_proj", "amountUSD": 60.0}
            ]
            assert by_id["ad_proj_due"]["dueAllocations"] == [
                {"receiptId": "rcpt_proj", "amountUSD": 25.0}
            ]
            assert by_id["ad_proj_paid"]["paymentStatus"] == "paid"
            assert by_id["ad_proj_paid"]["customerId"] == "cust_proj"

            # The aggregate readers reach the same numbers as before.
            probe = [r for r in rows if str(r.get("id")) in {"ad_proj_paid", "ad_proj_due"}]
            assert _financial_committed_usage(probe, "rcpt_proj") == 85_00
            assert _financial_usage(probe, "rcpt_proj", due=True) == 25_00
    finally:
        _clear()


def test_the_images_really_are_gone_from_the_money_scan():
    """If they were still present the whole change would be pointless."""
    init_db()
    _seed()
    try:
        with db_conn() as conn:
            rows = _financial_active_rows(conn, "ads")
            for row in rows:
                if str(row.get("id")) not in {"ad_proj_paid", "ad_proj_due"}:
                    continue
                raw = row.get("data_json") or ""
                assert "base64" not in raw, "money scan still carries image data"
                data = _financial_row_data(row)
                for field in ("adPhotos", "photos", "metaThumbnailData"):
                    assert field not in data, f"{field} was not stripped"
    finally:
        _clear()


def test_a_collection_with_no_media_fields_still_loads():
    """customers has no INLINE_MEDIA_FIELDS entry; that path must not break."""
    init_db()
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('customers','cust_proj',:d,false,:now,'system',:now)"
            ),
            {"d": json_dumps({"name": "Projection Probe"}), "now": now_ms()},
        )
    try:
        with db_conn() as conn:
            rows = _financial_active_rows(conn, "customers")
            names = {_financial_row_data(r).get("name") for r in rows}
            assert "Projection Probe" in names
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='customers' AND id='cust_proj'"))
