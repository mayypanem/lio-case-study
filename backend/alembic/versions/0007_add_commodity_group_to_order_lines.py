"""Add commodity_group_id to order_lines table

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-16

Adds per-item commodity group classification to order lines. Allows each order line
to have its own commodity group ID, enabling per-item commodity mapping overrides.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "order_lines", sa.Column("commodity_group_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_order_lines_commodity_group_id",
        "order_lines",
        "commodity_groups",
        ["commodity_group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_order_lines_commodity_group_id", "order_lines", ["commodity_group_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_order_lines_commodity_group_id", table_name="order_lines")
    op.drop_constraint(
        "fk_order_lines_commodity_group_id", "order_lines", type_="foreignkey"
    )
    op.drop_column("order_lines", "commodity_group_id")
