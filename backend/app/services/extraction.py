import json
import logging
import uuid

from openai import OpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import CommodityGroup, Organization
from app.schemas.extraction import ExtractedVendorData, ExtractionResponse

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a data extraction and classification specialist. Always respond with "
    "valid JSON only, no markdown or code blocks. Extract all information accurately "
    "from German business documents and classify into the appropriate commodity "
    "group based on the full context of the offer."
)


def _build_prompt(
    pdf_text: str,
    commodity_groups_list: str,
    org_mappings: dict[str, int] | None = None,
) -> str:
    prompt = f"""You are a data extraction and classification specialist. Extract procurement/vendor offer information from the following German document text AND classify it into the appropriate commodity group.

Document Text:
{pdf_text}

Please extract the following information:
1. Title/Short Description (A brief summary of what this procurement is for - e.g., "Office Equipment Purchase", "Software Licenses", etc.)
2. Vendor Name (Lieferant/Anbieter/Firma/Company name)
3. VAT ID (Umsatzsteuer-Identifikationsnummer/VAT ID/USt-IdNr/Tax ID)
4. Department/Customer (Abteilung/Kunde/Offered to/Customer name)
5. Order Lines/Items (All line items with):
   - Position Description (Bezeichnung/Product/Item/Artikel)
   - Unit Price (Einzelpreis/Unit Price/Preis/Price per unit)
   - Amount (Menge/Quantity/Anzahl)
   - Unit (Einheit/Unit/ME - e.g., "licenses", "pieces", "Stück", "items")
   - Total Price (Gesamtpreis/Total/Gesamt)
   - Commodity Group ID & Name for THIS ITEM (see Step 7 below)
6. Total Cost (Gesamtsumme/Total Cost/Total Offer Cost)
7. Commodity Group Classification for each item - Select the most appropriate commodity group for EACH item from the list below

Available Commodity Groups (ID | Category | Name):
{commodity_groups_list}

IMPORTANT INSTRUCTIONS:
- For the title, create a SHORT (2-5 words) description based on the main items being purchased
- Extract ALL line items, even if there are many
- For unit prices and totals, extract only the numeric value (remove currency symbols)
- For the unit field, translate German terms to English (e.g., "Stück" -> "pieces", "Lizenzen" -> "licenses")
- Be careful with German number formatting (e.g., "1.438,00" = 1438.00)
- For commodity group classification of each item, consider its PRIMARY nature and purpose:
  * Branded office decor/furniture → Office Equipment (15)
  * Traditional promotional items (brochures, giveaways, banners) → Promotional Materials (43)
  * Software/IT products → Software (31) or IT Services (30)
  * If genuinely uncertain, set commodityGroupId to null
"""

    # Add Step 8 if organization has custom mappings
    if org_mappings:
        mappings_list = "\n".join(
            f'  - "{keyword}" → commodity group {group_id}'
            for keyword, group_id in org_mappings.items()
        )
        prompt += f"""
8. Custom Commodity Group Classification for Items (Organization-Specific Overrides)
This organization has specific business requirements for certain item types. For items whose descriptions match the keywords below, use the mapped commodity group instead of the Step 7 classification:

{mappings_list}

CUSTOM CLASSIFICATION RULES FOR ITEMS:
- For EACH item, search its description for keywords that match these mappings (case-insensitive substring matching)
- If an item's description contains a matching keyword, use the mapped commodity group ID for that item
- Custom mappings take PRIORITY over Step 7 classification for matching items
- Only use a mapped group if the keyword appears in the item's description
- Items that don't match any keyword should use the Step 7 classification

Examples:
- If an item description includes "cable ties", assign it the mapped group for "cable ties" instead of AI classification
- If an item description includes "printer toner", assign it the mapped group for "printer toner" instead of AI classification
- If an item doesn't match any keyword, use Step 7 classification normally for that item
"""

    prompt += """
Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "title": "Short description of procurement",
  "vendorName": "Company Name",
  "vatId": "DE123456789",
  "department": "Department Name",
  "orderLines": [
    {
      "positionDescription": "Item description",
      "unitPrice": 150.00,
      "amount": 10,
      "unit": "licenses",
      "totalPrice": 1500.00,
      "commodityGroupId": 15,
      "commodityGroupName": "Office Equipment"
    }
  ],
  "totalCost": 1500.00,
  "commodityGroupId": 15,
  "commodityGroupName": "Office Equipment"
}"""

    return prompt


def _strip_markdown_fences(content: str) -> str:
    cleaned = content.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned.removeprefix("```json").strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```").strip()
    if cleaned.endswith("```"):
        cleaned = cleaned.removesuffix("```").strip()
    return cleaned


def extract_vendor_data(
    pdf_text: str,
    db: Session,
    organization_id: uuid.UUID | None = None,
) -> ExtractionResponse:
    """Extract vendor data and classify commodity group in one AI call.

    Applies organization-specific commodity group mappings if configured.

    Args:
        pdf_text: Extracted PDF text
        db: Database session
        organization_id: Organization context for custom commodity mappings
    """
    if not pdf_text or not pdf_text.strip():
        return ExtractionResponse(success=False, error="No text provided for extraction")

    if not settings.openai_api_key:
        return ExtractionResponse(
            success=False,
            error="OPENAI_API_KEY is not configured on the server",
        )

    commodity_groups = list(
        db.scalars(select(CommodityGroup).order_by(CommodityGroup.id))
    )
    if not commodity_groups:
        return ExtractionResponse(
            success=False,
            error="Failed to load commodity groups for classification",
        )

    # Give the model the full commodity catalog so it has complete context to
    # pick the most accurate match in a single pass.
    commodity_groups_list = "\n".join(
        f"{g.id} | {g.category} | {g.name}" for g in commodity_groups
    )

     # Load org-specific mappings if organization context provided and feature is enabled
    org_mappings = None
    if organization_id is not None:
        org = db.get(Organization, organization_id)
        if org and org.settings:
            # Only apply mappings if the feature is explicitly enabled
            if org.settings.get("enable_commodity_group_mappings", False):
                mappings = org.settings.get("commodity_group_mappings", {})
                # Only pass non-empty mappings to the prompt
                if mappings:
                    org_mappings = mappings

    try:
        client = OpenAI(api_key=settings.openai_api_key)
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_prompt(
                    pdf_text,
                    commodity_groups_list,
                    org_mappings
                )},
            ],
            max_completion_tokens=4000,
            temperature=0.3,
        )

        content = response.choices[0].message.content
        if not content:
            return ExtractionResponse(success=False, error="Empty response from AI")

        extracted = ExtractedVendorData.model_validate(
            json.loads(_strip_markdown_fences(content))
        )
    except Exception as exc:  # noqa: BLE001 — mirror the original catch-all
        logger.exception("Error extracting vendor data")
        return ExtractionResponse(success=False, error=str(exc))

     # Check which fields are missing or empty (same rules as the original).
    missing_fields: list[str] = []
    if not extracted.title.strip():
        missing_fields.append("Title/Short Description")
    if not extracted.vendor_name.strip():
        missing_fields.append("Vendor Name")
    if not extracted.vat_id or not extracted.vat_id.strip():
        missing_fields.append("VAT ID")
    if not extracted.department.strip():
        missing_fields.append("Department")
    if not extracted.order_lines:
        missing_fields.append("Order Lines")
    if not extracted.total_cost:
        missing_fields.append("Total Cost")
    if not extracted.commodity_group_id or not extracted.commodity_group_name:
        missing_fields.append("Commodity Group")

     # Build a lookup map from commodity group ID to group object
    commodity_group_map = {g.id: g for g in commodity_groups}
    
    # Validate and resolve commodity group names for request-level group.
    if extracted.commodity_group_id is not None:
        if extracted.commodity_group_id not in commodity_group_map:
            logger.warning(
                "Invalid commodity group ID returned: %s", extracted.commodity_group_id
            )
            extracted.commodity_group_id = None
            extracted.commodity_group_name = None
            if "Commodity Group" not in missing_fields:
                missing_fields.append("Commodity Group")
        else:
            # Look up the name from the database instead of trusting AI
            group = commodity_group_map[extracted.commodity_group_id]
            extracted.commodity_group_name = group.name
    
    # Validate and resolve per-item commodity groups (from Step 8 overrides or Step 7 baseline).
    for line in extracted.order_lines:
        if line.commodity_group_id is not None:
            if line.commodity_group_id not in commodity_group_map:
                logger.warning(
                    "Invalid item commodity group ID returned: %s", line.commodity_group_id
                )
                # Fall back to request-level commodity group
                line.commodity_group_id = extracted.commodity_group_id
                line.commodity_group_name = extracted.commodity_group_name
            else:
                # Look up the name from the database instead of trusting AI
                group = commodity_group_map[line.commodity_group_id]
                line.commodity_group_name = group.name

    return ExtractionResponse(
        success=True,
        data=extracted,
        missing_fields=missing_fields or None,
    )
