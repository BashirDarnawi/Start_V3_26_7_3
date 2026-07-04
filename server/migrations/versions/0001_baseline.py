"""Baseline: the schema as it existed when Alembic was introduced.

Creates all tables defined in server/db.py (users, sessions, entities,
audit_logs, password_resets) if they do not exist yet. Running this against
an EXISTING database is safe — create_all skips tables that already exist,
so both fresh and long-lived databases end up at the same revision.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-07-04

"""
from alembic import op

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from server.db import METADATA, define_schema  # noqa: E402

# revision identifiers, used by Alembic.
revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    define_schema()
    # checkfirst=True (the default) makes this a no-op for tables that
    # already exist, so the baseline is safe on production databases.
    METADATA.create_all(op.get_bind())


def downgrade() -> None:
    # Never drop the baseline schema automatically — that would delete all
    # data. If you truly need to tear down a database, do it manually.
    raise RuntimeError("Refusing to drop the baseline schema (would destroy all data)")
