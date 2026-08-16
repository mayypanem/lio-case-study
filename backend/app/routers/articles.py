from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.core.deps import get_current_membership
from app.db.session import get_db
from app.models import Article, OrganizationMember
from app.schemas.articles import (
    ArticleCreate,
    ArticleMatch,
    ArticleMatchRequest,
    ArticleMatchResponse,
    ArticleOut,
    ArticlePage,
)

router = APIRouter(prefix="/articles", tags=["articles"])

# Below this similarity ratio, a description match is too weak to surface.
DESCRIPTION_MATCH_THRESHOLD = 0.35
# At/above this similarity ratio, the top match is confident enough to
# pre-select as the recommended one.
RECOMMENDED_THRESHOLD = 0.55
MAX_MATCHES = 5


@router.get("", response_model=ArticlePage)
def list_articles(
    search: str | None = Query(
        default=None, description="Filter by description or article number (case-insensitive)"
    ),
    supplier_id: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> ArticlePage:
    filters = [Article.organization_id == membership.organization_id]
    if search:
        term = f"%{search}%"
        filters.append(
            or_(Article.description.ilike(term), Article.article_number.ilike(term))
        )
    if supplier_id:
        filters.append(Article.supplier_id == supplier_id)

    total = db.scalar(
        select(func.count()).select_from(Article).where(*filters)
    ) or 0

    stmt = (
        select(Article)
        .where(*filters)
        .options(joinedload(Article.supplier))
        .order_by(Article.article_number)
        .offset(offset)
        .limit(limit)
    )
    items = [
        ArticleOut(
            id=a.id,
            article_number=a.article_number,
            supplier_id=a.supplier_id,
            supplier_name=a.supplier.name if a.supplier else None,
            description=a.description,
            unit_price=a.unit_price,
            currency=a.currency,
            unit=a.unit,
            quantity=a.quantity,
            created_at=a.created_at,
        )
        for a in db.scalars(stmt)
    ]
    return ArticlePage(items=items, total=total, limit=limit, offset=offset)


@router.post("/match", response_model=ArticleMatchResponse)
def match_articles(
    payload: ArticleMatchRequest,
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> ArticleMatchResponse:
    """Suggest catalog articles for a batch of order lines against one supplier.

    Matching is restricted to the given supplier's own catalog (no cross-supplier
    or org-wide fallback) and never blocks request creation — it's a pure
    optional suggestion layer.
    """
    articles = list(
        db.scalars(
            select(Article)
            .where(
                Article.organization_id == membership.organization_id,
                Article.supplier_id == payload.supplier_id,
            )
            .options(joinedload(Article.supplier))
        )
    )

    matches: dict[str, list[ArticleMatch]] = {}
    for line in payload.lines:
        target = line.description.strip().lower()
        scored = []
        for a in articles:
            ratio = SequenceMatcher(None, target, a.description.strip().lower()).ratio()
            if ratio >= DESCRIPTION_MATCH_THRESHOLD:
                scored.append((ratio, a))
        scored.sort(key=lambda pair: pair[0], reverse=True)

        top_score = scored[0][0] if scored else 0.0
        matches[str(line.index)] = [
            ArticleMatch(
                article=ArticleOut(
                    id=a.id,
                    article_number=a.article_number,
                    supplier_id=a.supplier_id,
                    supplier_name=a.supplier.name if a.supplier else None,
                    description=a.description,
                    unit_price=a.unit_price,
                    currency=a.currency,
                    unit=a.unit,
                    quantity=a.quantity,
                    created_at=a.created_at,
                ),
                score=round(ratio, 4),
                recommended=(ratio == top_score and top_score >= RECOMMENDED_THRESHOLD),
            )
            for ratio, a in scored[:MAX_MATCHES]
        ]

    return ArticleMatchResponse(matches=matches)


@router.get("/count")
def count_articles(
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    total = (
        db.scalar(
            select(func.count())
            .select_from(Article)
            .where(Article.organization_id == membership.organization_id)
        )
        or 0
    )
    return {"count": total}


@router.post("", response_model=ArticleOut, status_code=status.HTTP_201_CREATED)
def create_article(
    payload: ArticleCreate,
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> ArticleOut:
    """Create a new article in the organization's catalog."""
    # Create the article with the organization context
    article = Article(
        organization_id=membership.organization_id,
        article_number=payload.article_number,
        supplier_id=payload.supplier_id,
        description=payload.description,
        unit_price=payload.unit_price,
        currency=payload.currency,
        unit=payload.unit,
        quantity=payload.quantity,
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    
    # Load the supplier relationship for the response
    db.refresh(article, ["supplier"])
    
    return ArticleOut(
        id=article.id,
        article_number=article.article_number,
        supplier_id=article.supplier_id,
        supplier_name=article.supplier.name if article.supplier else None,
        description=article.description,
        unit_price=article.unit_price,
        currency=article.currency,
        unit=article.unit,
        quantity=article.quantity,
        created_at=article.created_at,
    )
