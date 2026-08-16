import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class ArticleCreate(BaseModel):
    """Input schema for creating a new article."""
    
    article_number: str
    supplier_id: uuid.UUID
    description: str
    unit_price: float
    currency: str = "EUR"
    unit: str
    quantity: float = 1.0


class ArticleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    article_number: str
    supplier_id: uuid.UUID
    supplier_name: str | None = None
    description: str
    unit_price: Decimal
    currency: str
    unit: str
    quantity: Decimal
    created_at: datetime


class ArticlePage(BaseModel):
    """A page of articles plus the totals the UI needs to render pagination."""

    items: list[ArticleOut]
    total: int
    limit: int
    offset: int


class ArticleMatchLine(BaseModel):
    """One order line to match against a supplier's catalog."""

    index: int
    description: str


class ArticleMatchRequest(BaseModel):
    supplier_id: uuid.UUID = Field(alias="supplierId")
    lines: list[ArticleMatchLine]


class ArticleMatch(BaseModel):
    article: ArticleOut
    score: float
    recommended: bool


class ArticleMatchResponse(BaseModel):
    """Keyed by the order line's index (as a string, JSON object requirement)."""

    matches: dict[str, list[ArticleMatch]]
