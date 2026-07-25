"""System-browser app login: one-time handoff codes table (app_logins).

The packaged iOS/Android apps sign in through the phone's real browser
(Sabil-style): the web session mints a hashed one-time code bound to a
PKCE-style SHA-256 challenge, and the app exchanges code+verifier for its
own session. This table stores those codes (same one-shot hashed-token
model as password_resets).

Revision ID: 0003_app_logins
Revises: 0002_entity_keyset_indexes
Create Date: 2026-07-25
"""

from alembic import op

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from server.db import APP_LOGINS, METADATA, define_schema  # noqa: E402

revision = "0003_app_logins"
down_revision = "0002_entity_keyset_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    define_schema()
    # checkfirst=True (the default) makes this a no-op when the table was
    # already created by init_db()'s create_all on a fresh install.
    METADATA.tables[APP_LOGINS].create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    define_schema()
    METADATA.tables[APP_LOGINS].drop(op.get_bind(), checkfirst=True)
