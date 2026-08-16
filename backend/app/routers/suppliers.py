from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.deps import get_current_membership
from app.db.session import get_db
from app.models import OrganizationMember, Supplier
from app.schemas.suppliers import SupplierMatch, SupplierMatchPage, SupplierOut

router = APIRouter(prefix="/suppliers", tags=["suppliers"])

# Below this similarity ratio, a name match is too weak to be worth surfacing.
NAME_MATCH_THRESHOLD = 0.5
MAX_MATCHES = 5


def _normalize_vat(value: str) -> str:
    return "".join(value.split()).upper()


@router.get("", response_model=list[SupplierOut])
def list_suppliers(
    search: str | None = Query(default=None, description="Filter by name (case-insensitive)"),
    category: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> list[SupplierOut]:
    stmt = select(Supplier).where(
        Supplier.organization_id == membership.organization_id
    )
    if search:
        stmt = stmt.where(Supplier.name.ilike(f"%{search}%"))
    if category:
        stmt = stmt.where(Supplier.category == category)
    stmt = stmt.order_by(Supplier.name).offset(offset).limit(limit)
    return [SupplierOut.model_validate(s) for s in db.scalars(stmt)]


@router.get("/match", response_model=SupplierMatchPage)
def match_suppliers(
    name: str | None = Query(default=None, description="Extracted vendor name to match"),
    vat_id: str | None = Query(default=None, description="Extracted VAT id to match"),
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> SupplierMatchPage:
    """Match an extracted vendor against the org's supplier catalog.

    Prefers an exact VAT id match (score 1.0). Falls back to fuzzy name
    matching via difflib when no VAT match is found (or no VAT was supplied).
    """
    suppliers = list(
        db.scalars(
            select(Supplier).where(Supplier.organization_id == membership.organization_id)
        )
    )

    if vat_id:
        target_vat = _normalize_vat(vat_id)
        vat_matches = [
            SupplierMatch(supplier=SupplierOut.model_validate(s), score=1.0, match_type="vat")
            for s in suppliers
            if s.vat_id and _normalize_vat(s.vat_id) == target_vat
        ]
        if vat_matches:
            return SupplierMatchPage(matches=vat_matches[:MAX_MATCHES])

    if not name:
        return SupplierMatchPage(matches=[])

    target_name = name.strip().lower()
    scored = []
    for s in suppliers:
        ratio = SequenceMatcher(None, target_name, s.name.strip().lower()).ratio()
        if ratio >= NAME_MATCH_THRESHOLD:
            scored.append((ratio, s))
    scored.sort(key=lambda pair: pair[0], reverse=True)

    matches = [
        SupplierMatch(supplier=SupplierOut.model_validate(s), score=round(ratio, 4), match_type="name")
        for ratio, s in scored[:MAX_MATCHES]
    ]
    return SupplierMatchPage(matches=matches)


@router.get("/count")
def count_suppliers(
    membership: OrganizationMember = Depends(get_current_membership),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    total = (
        db.scalar(
            select(func.count())
            .select_from(Supplier)
            .where(Supplier.organization_id == membership.organization_id)
        )
        or 0
    )
    return {"count": total}
