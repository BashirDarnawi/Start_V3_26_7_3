"""Balance and idempotency lookups filter in SQL; the answer must not change.

Both helpers used to read a whole collection and filter in Python, inside a
transaction holding FOR UPDATE locks. Pushing the filter into the database is
only safe if it returns exactly the same rows, so these pin the equivalence on
the cases that differ from a naive filter: mixed currencies, both directions of
a transfer, unrelated users, and rows missing the field entirely.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_field_sql, now_ms
from server.main import (
    _find_entity_by_idempotency,
    _wallet_amount_minor,
    _wallet_balance_minor,
)

USER = "user_scan_probe"
OTHER = "user_scan_other"

ROWS = [
    # (id, data)
    ("wtx_in_usd", {"toUserId": USER, "currency": "USD", "amountMinor": 5000, "idempotencyKey": "k-in"}),
    ("wtx_out_usd", {"fromUserId": USER, "currency": "USD", "amountMinor": 2000, "idempotencyKey": "k-out"}),
    # Different currency: must not affect the USD balance.
    ("wtx_in_lyd", {"toUserId": USER, "currency": "LYD", "amountMinor": 999999, "idempotencyKey": "k-lyd"}),
    # Someone else's money entirely.
    ("wtx_other", {"toUserId": OTHER, "currency": "USD", "amountMinor": 7777, "idempotencyKey": "k-other"}),
    # Self-transfer: credited AND debited, so it must net to zero.
    ("wtx_self", {"toUserId": USER, "fromUserId": USER, "currency": "USD", "amountMinor": 1234, "idempotencyKey": "k-self"}),
    # Legacy row with no currency and no idempotency key at all.
    ("wtx_bare", {"toUserId": USER, "amountMinor": 42}),
]


def _python_balance(conn, user_id: str, currency: str) -> int:
    """The pre-pushdown implementation, kept here as the reference answer."""
    from server.db import json_loads

    balance = 0
    rows = conn.execute(
        text("SELECT data_json FROM entities WHERE type = 'walletTransactions' AND deleted = false")
    ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("currency") or "").upper() != currency:
            continue
        amount = _wallet_amount_minor(data)
        if str(data.get("toUserId") or "") == user_id:
            balance += amount
        if str(data.get("fromUserId") or "") == user_id:
            balance -= amount
    return balance


def _seed(conn):
    for eid, data in ROWS:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('walletTransactions',:i,:d,false,:now,'system',:now)"
            ),
            {"i": eid, "d": json_dumps(data), "now": now_ms()},
        )


def _clear(conn):
    for eid, _data in ROWS:
        conn.execute(text("DELETE FROM entities WHERE type='walletTransactions' AND id=:i"), {"i": eid})


def test_sql_filtered_balance_matches_the_python_scan():
    init_db()
    with db_conn() as conn:
        _seed(conn)
    try:
        with db_conn() as conn:
            for uid in (USER, OTHER, "user_nobody"):
                for currency in ("USD", "LYD"):
                    assert _wallet_balance_minor(conn, uid, currency) == _python_balance(conn, uid, currency), (
                        f"SQL-filtered balance disagreed with the scan for {uid}/{currency}"
                    )
            # And the value itself is right: 5000 in, 2000 out, self-transfer nets 0.
            assert _wallet_balance_minor(conn, USER, "USD") == 3000
            assert _wallet_balance_minor(conn, USER, "LYD") == 999999
    finally:
        with db_conn() as conn:
            _clear(conn)


def test_idempotency_lookup_finds_the_row_and_only_that_row():
    init_db()
    with db_conn() as conn:
        _seed(conn)
    try:
        with db_conn() as conn:
            found = _find_entity_by_idempotency(conn, "walletTransactions", "k-out")
            assert found is not None and found["id"] == "wtx_out_usd"
            # A key nobody used, and the empty string (rows that omit the
            # field must NOT be treated as matching "").
            assert _find_entity_by_idempotency(conn, "walletTransactions", "k-missing") is None
            assert _find_entity_by_idempotency(conn, "walletTransactions", "") is None
    finally:
        with db_conn() as conn:
            _clear(conn)


def test_json_field_sql_refuses_a_name_it_cannot_safely_interpolate():
    """The field name is interpolated, so it must never accept punctuation."""
    for bad in ("toUserId'; DROP TABLE entities;--", "a b", "", "1abc", "a.b"):
        try:
            json_field_sql(bad)
        except ValueError:
            continue
        raise AssertionError(f"json_field_sql accepted an unsafe field name: {bad!r}")
    assert "toUserId" in json_field_sql("toUserId")
