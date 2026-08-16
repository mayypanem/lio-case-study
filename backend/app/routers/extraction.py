import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models import OrganizationMember, User
from app.schemas.extraction import ExtractionRequest, ExtractionResponse
from app.services.extraction import extract_vendor_data

router = APIRouter(prefix="/extraction", tags=["extraction"])


def _get_optional_organization_id(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> uuid.UUID | None:
    """Optionally resolve organization ID if user has organization membership.
    
    Does not fail if user has no membership - returns None instead.
    This allows extraction to work without org membership while still applying
    custom mappings when the user does have an organization.
    """
    membership = db.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == user.id)
    )
    return membership.organization_id if membership else None


@router.post("", response_model=ExtractionResponse, response_model_by_alias=True,
             dependencies=[Depends(get_current_user)])
def extract(
    payload: ExtractionRequest,
    db: Session = Depends(get_db),
    organization_id: uuid.UUID | None = Depends(_get_optional_organization_id),
) -> ExtractionResponse:
    """Extract structured vendor data from PDF text via OpenAI.

    Returns ``{success, data?, error?, missingFields?}`` — the same envelope the
    original server action produced (errors are part of the payload, not HTTP
    errors, so the UI can show partial-extraction warnings).
    
    Applies organization-specific commodity group mappings if the user has an
    organization and has configured custom mappings.
    """
    return extract_vendor_data(payload.text, db, organization_id)
