"""Add composite indexes used by collection keyset pagination.

Revision ID: 0002_entity_keyset_indexes
Revises: 0001_baseline
Create Date: 2026-07-14
"""

from alembic import op


revision = "0002_entity_keyset_indexes"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Fresh installs may already have these because the baseline calls the
    # current SQLAlchemy metadata. Existing installs need this explicit step.
    op.create_index(
        "entities_type_created_id",
        "entities",
        ["type", "created_at", "id"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "entities_type_modified_id",
        "entities",
        ["type", "last_modified", "id"],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("entities_type_modified_id", table_name="entities", if_exists=True)
    op.drop_index("entities_type_created_id", table_name="entities", if_exists=True)
