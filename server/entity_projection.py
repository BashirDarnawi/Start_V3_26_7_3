"""Read-side projections for large media and permission-sensitive contacts.

Keeping these pure transforms outside the HTTP application makes them easy to
test and reuse without importing the entire server or touching the database.
"""

from __future__ import annotations

import re
from typing import Any


INLINE_MEDIA_FIELDS: dict[str, tuple[str, ...]] = {
    "receipts": ("photos", "receiptImage"),
    # metaThumbnailData / metaPagePictureData are our OWN stored copies of the
    # Facebook images: the fbcdn links beside them expire, these do not. They
    # are stripped from list responses like any other inline image, or every
    # sync would carry tens of megabytes.
    "ads": ("adPhotos", "photos", "metaThumbnailData"),
    "adCampaignRequests": ("creativeImages",),
    "walletPaymentRequests": ("receiptPhoto",),
    "pages": ("metaPagePictureData",),
}

# Stripping and COUNTING are different questions. _photoCount answers "how
# many photos did a person attach", which drives the photo badge and the
# hydration guard that refuses to edit an ad whose images failed to load.
# An archived Facebook creative is neither: counting it made Meta-linked ads
# with no uploads claim a photo and become uneditable when hydration failed.
COUNTED_MEDIA_FIELDS: dict[str, tuple[str, ...]] = {
    "receipts": ("photos", "receiptImage"),
    "ads": ("adPhotos", "photos"),
    "adCampaignRequests": ("creativeImages",),
    "walletPaymentRequests": ("receiptPhoto",),
    "pages": (),
}

_SQL_JSON_COLUMN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")

CONTACT_REDACTED_ENTITY_TYPES = frozenset({"customers", "receipts", "ads"})
CONTACT_FIELD_MARKERS = (
    "phone",
    "profile",
    "address",
    "contact",
    "email",
    "whatsapp",
)
CONTACT_FIELD_ALIASES = frozenset({"deliveryplace", "deliveryplacename"})


def _is_customer_contact_field(key: Any) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(key or "").lower())
    return normalized in CONTACT_FIELD_ALIASES or any(
        marker in normalized for marker in CONTACT_FIELD_MARKERS
    )


def _without_customer_contacts(value: Any) -> Any:
    """Copy a JSON value while removing contact-bearing keys at any depth."""
    if isinstance(value, dict):
        return {
            key: _without_customer_contacts(child)
            for key, child in value.items()
            if not _is_customer_contact_field(key)
        }
    if isinstance(value, list):
        return [_without_customer_contacts(child) for child in value]
    return value


def project_entity_contacts(entity: dict[str, Any], can_view_contacts: bool) -> dict[str, Any]:
    entity_type = str(entity.get("type") or "")
    if entity_type not in CONTACT_REDACTED_ENTITY_TYPES or can_view_contacts:
        return entity
    projected = dict(entity)
    data = projected.get("data")
    if isinstance(data, dict):
        projected["data"] = _without_customer_contacts(data)
    return projected


def _without_inline_media(entity_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """Return a lightweight response copy plus a trustworthy photo count."""
    fields = INLINE_MEDIA_FIELDS.get(entity_type)
    if not fields:
        return data
    lean = dict(data)
    counted_fields = COUNTED_MEDIA_FIELDS.get(entity_type, fields)
    seen: set[str] = set()
    for field in fields:
        value = lean.pop(field, None)
        if field not in counted_fields:
            continue  # stripped, but it is not a photo a person attached
        values = value if isinstance(value, list) else [value]
        for source in values:
            if isinstance(source, str) and source.strip():
                seen.add(source.strip())
    lean["_mediaOmitted"] = True
    lean["_photoCount"] = len(seen)
    return lean


def _inline_media_sql_projection(
    entity_type: str,
    dialect: str,
    *,
    json_column: str = "data_json",
) -> tuple[str, str] | None:
    """Return SQL expressions for lean JSON and its exact attached-media count.

    The fields are removed by the database so a normal list request never
    transfers large base64 values into Python.  The count deliberately mirrors
    :func:`_without_inline_media`: only non-empty strings count, duplicates are
    counted once, and archived Meta thumbnails are stripped but not counted.

    Only constant application column names are accepted.  Entity media keys
    come exclusively from the fixed mappings above, never from request data.
    """
    fields = INLINE_MEDIA_FIELDS.get(entity_type)
    if not fields:
        return None
    if not _SQL_JSON_COLUMN_RE.fullmatch(str(json_column or "")):
        raise ValueError("Unsafe JSON column name")

    counted_fields = COUNTED_MEDIA_FIELDS.get(entity_type, fields)
    dialect_name = str(dialect or "").lower()
    if dialect_name == "postgresql":
        stripped = f"{json_column}::jsonb" + "".join(
            f" - '{field}'" for field in fields
        )
        data_expression = f"({stripped})::text"
        sources = []
        for field in counted_fields:
            source = f"{json_column}::jsonb -> '{field}'"
            normalized_array = (
                f"CASE WHEN jsonb_typeof({source})='array' THEN {source} "
                f"WHEN jsonb_typeof({source})='string' "
                f"THEN jsonb_build_array({source}) ELSE '[]'::jsonb END"
            )
            sources.append(
                "SELECT BTRIM(media_item.item #>> '{}') AS media_value "
                f"FROM jsonb_array_elements({normalized_array}) AS media_item(item) "
                "WHERE jsonb_typeof(media_item.item)='string'"
            )
    elif dialect_name == "sqlite":
        paths = "".join(f", '$.{field}'" for field in fields)
        data_expression = f"json_remove({json_column}{paths})"
        sources = [
            "SELECT TRIM(CAST(media_item.value AS TEXT)) AS media_value "
            f"FROM json_each({json_column}, '$.{field}') AS media_item "
            "WHERE media_item.type='text'"
            for field in counted_fields
        ]
    else:
        return None

    if not sources:
        count_expression = "0"
    else:
        union = " UNION ALL ".join(sources)
        count_expression = (
            "(SELECT COUNT(DISTINCT media_value) "
            f"FROM ({union}) AS media_values WHERE media_value <> '')"
        )
    return data_expression, count_expression


def _project_entity_media(entity: dict[str, Any], include_media: bool) -> dict[str, Any]:
    if include_media:
        return entity
    projected = dict(entity)
    data = projected.get("data")
    if isinstance(data, dict):
        projected["data"] = _without_inline_media(str(projected.get("type") or ""), data)
    return projected


def can_include_entity_media(
    entity_type: str,
    requested: bool,
    can_view_ad_photos: bool,
) -> bool:
    if not requested:
        return False
    if entity_type == "ads":
        return can_view_ad_photos
    return True
