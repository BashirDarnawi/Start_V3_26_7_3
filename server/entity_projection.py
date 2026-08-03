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
