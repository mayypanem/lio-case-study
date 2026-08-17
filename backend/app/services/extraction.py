import json
import logging
import time
import uuid

from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field
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

OVERRIDE_SYSTEM_PROMPT = (
    "You are a product-matching specialist. Always respond with valid JSON only, "
    "no markdown or code blocks. You only decide whether item descriptions match "
    "given keywords — you have no other task."
)


class _ItemOverridesResponse(BaseModel):
    """Result of the isolated custom-mapping override call.

    Deliberately has NO request-level/overall field of any kind — this call's
    schema makes it structurally impossible for a per-item override to leak
    into an overall/request-level commodity group, because that concept does
    not exist in this call at all.
    """

    model_config = ConfigDict(populate_by_name=True)

    overrides: dict[str, int] = Field(default_factory=dict)


def _build_baseline_prompt(pdf_text: str, commodity_groups_list: str) -> str:
     """Prompt for the baseline extraction + classification call.

     This prompt intentionally contains NO mention of organization-specific
     custom mappings. Keeping the two concerns in separate LLM calls guarantees
     the request-level classification can never be influenced by a per-item
     custom-mapping override, since the override keywords are never present in
     this call's context at all.
     """
     return f"""You are a data extraction and classification specialist. Extract procurement/vendor offer information from the following German document text AND classify it into the appropriate commodity group.

 Document Text:
 {pdf_text}

 Please extract the following information:
 1. Title/Short Description (A brief summary of what this procurement is for - e.g., "Office Equipment Purchase", "Software Licenses", etc.)
 2. Vendor Name (Lieferant/Anbieter/Firma/Company name - this is the SUPPLIER/VENDOR, not the recipient/customer)
 3. VAT ID (Umsatzsteuer-Identifikationsnummer/VAT ID/USt-IdNr/Tax ID of the vendor/supplier)
 4. Department/Customer (Abteilung/Kunde/Offered to/Customer name - the internal department or recipient, not the vendor)
 5. Total Cost (Gesamtsumme/Total Cost/Total Offer Cost - DO NOT include VAT/tax rows in this total; sum only the product/service items)
 6. Overall Commodity Group Classification for the request - Select ONE commodity group that best represents the offer AS A WHOLE (its primary/dominant nature).
 7. Order Lines/Items (All line items with):
    - Position Description (Bezeichnung/Product/Item/Artikel)
    - Unit Price (Einzelpreis/Unit Price/Preis/Price per unit)
    - Amount (Menge/Quantity/Anzahl)
    - Unit (Einheit/Unit/ME - e.g., "licenses", "pieces", "Stück", "items")
    - Total Price (Gesamtpreis/Total/Gesamt)
    - Commodity Group ID & Name for THIS ITEM (see Step 8 below)
 8. Commodity Group Classification for each item - Select the most appropriate commodity group for EACH item from the list below. Every item MUST be assigned a commodity group ID — do not leave any item's commodityGroupId null.

 Available Commodity Groups (ID | Category | Name):
 {commodity_groups_list}

 IMPORTANT INSTRUCTIONS:
 - For the title, create a SHORT (2-5 words) description based on the main items being purchased
 - EXCLUDE VAT/tax/regulatory fee rows (e.g., "MwSt.", "Umsatzsteuer", "Urheberrechtsabgabe") from the order lines — these are not products/services and clutter the data. Only include actual product/service items.
 - Extract ONLY the genuine product/service line items; skip lines that describe taxes, fees, or adjustments
 - For unit prices and totals, extract only the numeric value (remove currency symbols)
 - For the unit field, translate German terms to English (e.g., "Stück" -> "pieces", "Lizenzen" -> "licenses")
 - Be careful with German number formatting (e.g., "1.438,00" = 1438.00, "1,28" = 1.28)
 - IMPORTANT: unitPrice × amount MUST equal totalPrice. If the document shows inconsistent values, use the most reliable calculation (prefer unitPrice × amount over a potentially wrong totalPrice from the document)
 - For commodity group classification of each item (Step 8), consider its PRIMARY nature and purpose:
   * Branded office decor/furniture → Office Equipment (15)
   * Traditional promotional items (brochures, giveaways, banners) → Promotional Materials (43)
   * Software/IT products → Software (31) or IT Services (30)
   * Delivery/installation/service lines → Services (see category, pick the closest match)
   * Every item must get a commodityGroupId — pick the closest match even if uncertain, never leave it null
 - The overall request-level commodity group (Step 6) reflects the offer as a whole; the per-item groups (Step 8) reflect each individual line — these are two separate, independent decisions and do not need to match each other

 Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{{
  "title": "Short description of procurement",
  "vendorName": "Company Name",
  "vatId": "DE123456789",
  "department": "Department Name",
  "totalCost": 1500.00,
  "commodityGroupId": 15,
  "commodityGroupName": "Office Equipment",
  "orderLines": [
    {{
      "positionDescription": "Item description",
      "unitPrice": 150.00,
      "amount": 10,
      "unit": "licenses",
      "totalPrice": 1500.00,
      "commodityGroupId": 15,
      "commodityGroupName": "Office Equipment"
    }}
  ]
}}"""


def _build_override_prompt(
    item_descriptions: list[str],
    org_mappings: dict[str, int],
) -> str:
    """Prompt for the isolated per-item custom-mapping override call.

    This call receives ONLY item descriptions and keyword mappings — no
    document text, no request-level field, no commodity group catalog. Its
    output schema (_ItemOverridesResponse) has no field that could represent
    an overall/request-level classification, so there is nothing for a
    per-item match to leak into.
    """
    items_list = "\n".join(
        f'{i}: "{desc}"' for i, desc in enumerate(item_descriptions)
    )
    mappings_list = "\n".join(
        f'  - "{keyword}" → commodity group {group_id}'
        for keyword, group_id in org_mappings.items()
    )
    return f"""An organization has specific business requirements for certain item types. For each of the following order line items, determine whether its description semantically matches one of the given keywords (not just substring matching — a semantic match means the item IS the same product or a variant of what the keyword describes).

Items (index: description):
{items_list}

Keyword → Commodity Group mappings:
{mappings_list}

RULES:
- Only evaluate the item's own description against the keywords — do not consider other items or the offer as a whole
- Service/labor lines (e.g. delivery, installation, assembly, shipping, training, maintenance, setup) are NOT a semantic match for a product keyword, even when they relate to or accompany a matching product — only the line describing the product itself matches
- If multiple keywords could apply to one item, use your best judgment to pick the most relevant one
- Only include an item in your output if it semantically matches a keyword — omit items that don't match anything

Examples:
- If the keyword is "cable ties" and the item is "reusable cable fasteners", this is a semantic match
- If the keyword is "printer toner" and the item is "toner cartridge for HP printer", this is a semantic match
- If the keyword is "office supplies" and the item is "A4 paper ream", this is NOT a semantic match
- If the keyword is "grinding machine" and the item is "delivery and installation service", this is NOT a semantic match (it's a service line, not the machine itself)

Return ONLY valid JSON in this exact format (no markdown, no code blocks). Include ONLY the indices of items that matched a keyword, mapped to the matched commodity group ID. Use an empty object if nothing matched:
{{
  "overrides": {{
    "0": 1
  }}
}}"""


def _is_tax_or_fee_line(description: str) -> bool:
    """Detect if a line is a tax/fee/adjustment and should be filtered out."""
    lower = description.lower().strip()
    tax_keywords = {
        'mwst', 'umsatzsteuer', 'vat', 'sales tax', 'steuern', 'tax',
        'urheberrechtsabgabe', 'copyright fee', 'gebühr', 'fee',
        'mehrwertsteuer', 'inkasso', 'collection fee', 'versand', 'shipping',
        'versandkosten', 'rabatt', 'discount', 'skonto', 'nachlass',
        'bearbeitungsgebühr', 'processing fee'
    }
    return any(keyword in lower for keyword in tax_keywords)


def _recalculate_line_price(line) -> None:
    """Recalculate totalPrice = unitPrice × amount to ensure consistency."""
    # Recalculate the total price to guarantee it's consistent with unit price and amount
    if line.unit_price and line.amount:
        line.total_price = round(line.unit_price * line.amount, 2)


def _strip_markdown_fences(content: str) -> str:
     cleaned = content.strip()
     if cleaned.startswith("```json"):
         cleaned = cleaned.removeprefix("```json").strip()
     elif cleaned.startswith("```"):
         cleaned = cleaned.removeprefix("```").strip()
     if cleaned.endswith("```"):
         cleaned = cleaned.removesuffix("```").strip()
     return cleaned


def _get_item_overrides(
    client: OpenAI,
    item_descriptions: list[str],
    org_mappings: dict[str, int],
) -> dict[int, int]:
    """Run the isolated override call and return {item_index: commodity_group_id}.

    Any failure here is non-fatal — the caller should fall back to the
    baseline per-item classification if this returns an empty dict.
    """
    try:
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": OVERRIDE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": _build_override_prompt(item_descriptions, org_mappings),
                },
            ],
            max_completion_tokens=1000,
            temperature=0.3,
        )
        content = response.choices[0].message.content
        if not content:
            return {}
        parsed = _ItemOverridesResponse.model_validate(
            json.loads(_strip_markdown_fences(content))
        )
        result: dict[int, int] = {}
        for key, group_id in parsed.overrides.items():
            try:
                index = int(key)
            except ValueError:
                continue
            if 0 <= index < len(item_descriptions):
                result[index] = group_id
        return result
    except Exception:  # noqa: BLE001 — override call is best-effort
        logger.exception("Error resolving custom commodity group overrides")
        return {}


def extract_vendor_data(
    pdf_text: str,
    db: Session,
    organization_id: uuid.UUID | None = None,
) -> ExtractionResponse:
    """Extract vendor data and classify commodity groups.

    Runs a baseline extraction + classification call first. If the
    organization has custom commodity group mappings enabled, a second,
    isolated call is made purely to resolve per-item overrides — this call
    has no request-level field in its schema, so it is structurally
    impossible for it to influence the request-level commodity group.

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
    org_mappings: dict[str, int] | None = None
    if organization_id is not None:
        org = db.get(Organization, organization_id)
        if org and org.settings:
            # Only apply mappings if the feature is explicitly enabled
            if org.settings.get("enable_commodity_group_mappings", False):
                mappings = org.settings.get("commodity_group_mappings", {})
                # Only pass non-empty mappings to the prompt
                if mappings:
                    org_mappings = mappings

    client = OpenAI(api_key=settings.openai_api_key)

    # Retry mechanism with exponential backoff (up to 3 attempts)
    max_attempts = 3
    last_error = None
    
    for attempt in range(1, max_attempts + 1):
        try:
            response = client.chat.completions.create(
                model=settings.openai_model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": _build_baseline_prompt(pdf_text, commodity_groups_list),
                    },
                ],
                max_completion_tokens=4000,
                temperature=0.3,
            )

            content = response.choices[0].message.content
            if not content:
                last_error = "Empty response from AI"
                if attempt < max_attempts:
                    wait_time = 2 ** (attempt - 1)  # 1s, 2s, 4s
                    logger.warning(
                        "Empty response from AI on attempt %d/%d, retrying in %ds",
                        attempt,
                        max_attempts,
                        wait_time,
                    )
                    time.sleep(wait_time)
                    continue
                else:
                    return ExtractionResponse(success=False, error=last_error)

            extracted = ExtractedVendorData.model_validate(
                json.loads(_strip_markdown_fences(content))
            )
            # Success — break out of retry loop
            break

        except Exception as exc:  # noqa: BLE001 — mirror the original catch-all
            last_error = str(exc)
            if attempt < max_attempts:
                wait_time = 2 ** (attempt - 1)  # 1s, 2s, 4s
                logger.warning(
                    "Extraction attempt %d/%d failed: %s. Retrying in %ds",
                    attempt,
                    max_attempts,
                    exc,
                    wait_time,
                )
                time.sleep(wait_time)
            else:
                logger.exception("Error extracting vendor data after %d attempts", max_attempts)
                return ExtractionResponse(success=False, error=last_error)

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

    # Validate and resolve per-item commodity groups from the baseline call.
    for line in extracted.order_lines:
        if line.commodity_group_id is None or line.commodity_group_id not in commodity_group_map:
            if line.commodity_group_id is not None:
                logger.warning(
                    "Invalid item commodity group ID returned: %s", line.commodity_group_id
                )
            else:
                logger.warning(
                    "Item missing commodity group ID: %r", line.position_description
                )
            # Fall back to request-level commodity group
            line.commodity_group_id = extracted.commodity_group_id
            line.commodity_group_name = extracted.commodity_group_name
        else:
            # Look up the name from the database instead of trusting AI
            group = commodity_group_map[line.commodity_group_id]
            line.commodity_group_name = group.name

    # --- POST-PROCESSING: Filter and validate extracted data ---
    
    # 1. Filter out tax/fee/adjustment lines and recalculate prices for remaining lines
    cleaned_lines = []
    for line in extracted.order_lines:
        # Skip VAT/tax/regulatory fee rows
        if _is_tax_or_fee_line(line.position_description):
            logger.debug("Filtered out tax/fee line: %s", line.position_description)
            continue
        
        # Recalculate total price to ensure consistency with unit price and amount
        _recalculate_line_price(line)
        
        cleaned_lines.append(line)
    
    extracted.order_lines = cleaned_lines
    
    # 2. Recalculate request-level total cost from the cleaned order lines
    # (instead of trusting the AI's extraction which may have included taxes)
    if extracted.order_lines:
        recalculated_total = sum(line.total_price for line in extracted.order_lines)
        extracted.total_cost = round(recalculated_total, 2)
    
    # Apply organization-specific custom mapping overrides via a fully
    # isolated second call. This can only ever change extracted.order_lines
    # entries — it has no way to touch extracted.commodity_group_id/_name.
    if org_mappings and extracted.order_lines:
        item_descriptions = [line.position_description for line in extracted.order_lines]
        overrides = _get_item_overrides(client, item_descriptions, org_mappings)
        for index, group_id in overrides.items():
            if group_id not in commodity_group_map:
                logger.warning(
                    "Custom mapping override returned invalid commodity group ID: %s",
                    group_id,
                )
                continue
            line = extracted.order_lines[index]
            line.commodity_group_id = group_id
            line.commodity_group_name = commodity_group_map[group_id].name

    return ExtractionResponse(
        success=True,
        data=extracted,
        missing_fields=missing_fields or None,
    )
