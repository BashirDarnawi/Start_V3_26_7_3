"""Alembic migration environment for Albayan.

Wired to the application's own schema definition and database URL so there
is exactly one source of truth:
- URL:    server.db.get_database_url()  (DATABASE_URL / ALBAYAN_DB_PATH env)
- Schema: server.db.define_schema() registers tables on server.db.METADATA
"""
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

# Make `server` importable when alembic runs from the project root
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.db import METADATA, define_schema, get_database_url  # noqa: E402

define_schema()
target_metadata = METADATA

config = context.config


def run_migrations_offline() -> None:
    """Generate SQL to stdout without a live DB connection (--sql mode)."""
    context.configure(
        url=get_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against the real database."""
    engine = create_engine(get_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
