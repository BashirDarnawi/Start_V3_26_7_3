"""The startup index pass must create the composite (type, deliveryPersonId)
index the Delivery role's poll depends on, in its own connection, and must
do nothing at all on SQLite.

Background (bug-hunt 2026-09-04): the driver poll filters ads/receipts by
deliveryPersonId and customers by a correlated EXISTS over both types; the
per-type partial indexes cannot serve that cross-type predicate, so Postgres
sequentially scanned and JSON-parsed every ad and receipt (inline photos
included) per driver per tick and starved the connection pool.

Run with: PYTHONPATH=. pytest server/test_add_jsonb_indexes.py -v
"""

import os
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import add_jsonb_indexes as module


class _Dialect:
    def __init__(self, name):
        self.name = name


class _Engine:
    def __init__(self, name):
        self.dialect = _Dialect(name)


def _recording_db_conn(connections):
    @contextmanager
    def _db_conn():
        statements = []
        connections.append(statements)

        class _Conn:
            def execute(self, stmt, params=None):
                statements.append(str(stmt))

        yield _Conn()

    return _db_conn


def test_composite_delivery_person_index_is_created_in_its_own_connection(monkeypatch):
    connections = []
    monkeypatch.setattr(module, "get_engine", lambda: _Engine("postgresql"))
    monkeypatch.setattr(module, "db_conn", _recording_db_conn(connections))

    module.add_jsonb_indexes()

    composite = [
        statements
        for statements in connections
        if any("idx_entities_type_delivery_person" in s for s in statements)
    ]
    assert len(composite) == 1, connections
    # Alone in its connection so a failure cannot poison the other passes.
    assert len(composite[0]) == 1
    ddl = composite[0][0]
    assert "ON entities (type, ((data_json::jsonb->>'deliveryPersonId')))" in ddl
    assert "WHERE deleted = false" in ddl
    assert "IF NOT EXISTS" in ddl


def test_index_pass_is_a_no_op_on_sqlite(monkeypatch):
    connections = []
    monkeypatch.setattr(module, "get_engine", lambda: _Engine("sqlite"))
    monkeypatch.setattr(module, "db_conn", _recording_db_conn(connections))

    module.add_jsonb_indexes()

    assert connections == []
