#!/usr/bin/env python3
"""Composite (type, created_by) index for viewOwn filters (PostgreSQL only).

The per-field JSON indexes live in add_jsonb_indexes.py. The GIN statements
that used to sit here were written against ``data_json->'field'``, which
PostgreSQL rejects on a TEXT column; every boot printed seven warnings and,
because all statements shared one transaction, the one valid index below was
never created either.
"""

from sqlalchemy import text

from .db import db_conn, get_engine


def create_performance_indexes():
    """Create the composite index (idempotent, own transaction)."""
    engine = get_engine()
    dialect = str(engine.dialect.name or "")

    if dialect != "postgresql":
        print("⚠️  Not Postgres - skipping JSONB indexes (only needed for production)")
        return

    sql = (
        "CREATE INDEX IF NOT EXISTS entities_type_created_by_composite "
        "ON entities (type, created_by) WHERE deleted = false"
    )
    try:
        with db_conn() as conn:
            conn.execute(text(sql))
        print("✅ Created index: entities_type_created_by_composite")
    except Exception as e:
        print(f"⚠️  Index entities_type_created_by_composite: {str(e)[:80]}")


if __name__ == "__main__":
    print("🚀 Creating performance indexes...")
    print()
    create_performance_indexes()
