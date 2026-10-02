"""Bug-hunt R1 (server-data-plane-3): the next temporary D number costs ONE receipts scan.

After a backup import the D counter can lag the receipts (imported D numbers above the counter's
"last"). _next_temp_delivery_receipt_no_inner skipped each taken number with a FULL receipts scan
while it held the counter lock: a thousand imported numbers meant a thousand scans before the
first new delivery receipt, and every other delivery receipt waited behind it. The taken numbers
now come from one scan on the same locked connection.

The seeded receipts are deleted and the counter row is put back afterwards.
"""

import os
import re
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from sqlalchemy import event, text

import server.main as main
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms

TAG = secrets.token_hex(4)
CREATOR = f"r1dgap{TAG}"
SEEDED = 1000
COUNTER = {"type": "counters", "id": "temp_delivery_receipt_no"}
_ENTITY_INSERT = text(
    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
    "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"
)


def _highest_taken_d_number():
    """Other modules share this database: start above every D number already in use."""
    highest = 0
    with db_conn() as conn:
        rows = conn.execute(text(main._receipt_number_scan_sql())).mappings().all()
        counter = conn.execute(
            text("SELECT data_json FROM entities WHERE type=:type AND id=:id"), COUNTER
        ).scalar()
    for row in rows:
        for key in main._receipt_number_keys(main._receipt_number_row_fields(row)):
            match = re.fullmatch(r"D([0-9]+)", key)
            if match:
                highest = max(highest, int(match.group(1)))
    if counter:
        highest = max(highest, int((json_loads(counter) or {}).get("last") or 0))
    return highest


@pytest.fixture()
def lagging_counter():
    init_db()
    with db_conn() as conn:
        saved = conn.execute(
            text("SELECT data_json, deleted, created_at, created_by, last_modified "
                 "FROM entities WHERE type=:type AND id=:id"), COUNTER
        ).mappings().first()
    saved = dict(saved) if saved else None
    base = _highest_taken_d_number()
    stamp = now_ms()
    receipts = [
        {"type": "receipts", "id": f"r1_dgap_{TAG}_{n}", "deleted": False, "created_at": stamp,
         "created_by": CREATOR, "last_modified": stamp,
         "data_json": json_dumps({"recordType": "receipt", "status": "Not Paid", "receiptType": "DELIVERY_TEMP",
                                  "tempReceiptNo": f"D{base + n}", "deliveryPersonId": CREATOR, "amountUSD": 10})}
        for n in range(1, SEEDED + 1)
    ]
    with db_conn() as conn:  # an imported D(base+1)..D(base+1000) while the counter still says base
        conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), COUNTER)
        conn.execute(_ENTITY_INSERT, {**COUNTER, "data_json": json_dumps({"last": base, "updatedAt": stamp}),
                                      "deleted": False, "created_at": stamp, "created_by": None,
                                      "last_modified": stamp})
        conn.execute(_ENTITY_INSERT, receipts)
    try:
        yield base
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='receipts' AND created_by=:by"), {"by": CREATOR})
            conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), COUNTER)
            if saved:
                conn.execute(_ENTITY_INSERT, {**COUNTER, **saved})


def test_a_lagging_counter_costs_one_receipts_scan(lagging_counter):
    base = lagging_counter
    scans = []

    def count_receipt_scans(_conn, _cursor, statement, _params, _context, _many):
        if "FROM entities WHERE type='receipts'" in statement:
            scans.append(statement)

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", count_receipt_scans)
    try:
        first = main._next_temp_delivery_receipt_no(CREATOR)
        first_scans = len(scans)
        second = main._next_temp_delivery_receipt_no(CREATOR)
    finally:
        event.remove(engine, "before_cursor_execute", count_receipt_scans)
    assert first == f"D{base + SEEDED + 1}"
    assert first_scans == 1  # before: 1001, one full receipts scan per taken number
    assert second == f"D{base + SEEDED + 2}"
    assert len(scans) == 2
