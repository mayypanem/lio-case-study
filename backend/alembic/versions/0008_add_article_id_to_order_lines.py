"""Add article_id to order_lines table

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-17

Links order lines to a catalog Article when the user applies a recommended
catalog match, so negotiated agreements can be tracked and reported on.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "order_lines", sa.Column("article_id", sa.Uuid(), nullable=True)
    )
    op.create_foreign_key(
        "fk_order_lines_article_id",
        "order_lines",
        "articles",
        ["article_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_order_lines_article_id", "order_lines", ["article_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_order_lines_article_id", table_name="order_lines")
    op.drop_constraint(
        "fk_order_lines_article_id", "order_lines", type_="foreignkey"
    )
    op.drop_column("order_lines", "article_id")
