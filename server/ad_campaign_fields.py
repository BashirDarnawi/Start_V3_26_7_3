"""Customer-editable ad-campaign envelope: limits, text/date sanitizers, image
verification, and the field validator behind every campaign create/edit.

Moved VERBATIM out of ``server/main.py`` (which sits at its enforced line
cap) so the next server change has room. Behaviour is identical; the only
difference is that the few helpers that still live in ``main.py``
(``sanitize_str``, ``sanitize_json``, ``validate_entity_id``, and the general
``MAX_DATA_URL_LENGTH`` / ``AD_CAMPAIGN_ALLOWED_FIELDS`` limits) are injected
through a small ``ctx`` dict — the same pattern the routers in this package
use — instead of being reached as module globals. ``main.py`` keeps its old
private names as thin bindings, so every existing call site is unchanged.

This is a request/approval record only. It deliberately contains no Meta
access token, live campaign ID, internal ad, receipt, or wallet mutation.
"""

from __future__ import annotations

import base64
import binascii
import io
import re
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from .ad_campaign_actions import (
    apply_boost_campaign_fields,
    enforce_boost_submission_rules,
    normalize_ad_campaign_destination,
)


MAX_AD_CAMPAIGN_BUDGET_MINOR_USD = 100_000_000  # USD 1,000,000
MAX_AD_CAMPAIGN_MEDIA_BYTES = 7 * 1024 * 1024
MAX_AD_CAMPAIGN_DECODED_MEDIA_BYTES = 5 * 1024 * 1024
MAX_AD_CAMPAIGN_DECODED_IMAGE_BYTES = 4 * 1024 * 1024
MAX_AD_CAMPAIGN_IMAGE_DIMENSION = 8192
MAX_AD_CAMPAIGN_IMAGE_PIXELS = 16_000_000
MAX_AD_CAMPAIGN_TOTAL_IMAGE_PIXELS = 24_000_000
AD_CAMPAIGN_BUDGET_TYPES = frozenset({"daily", "lifetime"})
AD_CAMPAIGN_CALL_TO_ACTIONS = frozenset(
    {
        "Send Message",
        "Learn More",
        "Shop Now",
        "Contact Us",
        "Sign Up",
        "Get Quote",
        "Call Now",
    }
)
AD_CAMPAIGN_CALL_TO_ACTION_ALIASES = {
    "send_message": "Send Message",
    "learn_more": "Learn More",
    "shop_now": "Shop Now",
    "contact_us": "Contact Us",
    "sign_up": "Sign Up",
    "get_quote": "Get Quote",
    "call_now": "Call Now",
}


# ctx keys (all provided by main.py):
#   sanitize_str(value, max_length) -> str
#   sanitize_json(obj) -> Any
#   validate_entity_id(value) -> str        (raises HTTPException when invalid)
#   max_data_url_length: int
#   allowed_fields: frozenset[str]           (AD_CAMPAIGN_ALLOWED_FIELDS)
Ctx = dict[str, Any]


def ad_campaign_string(value: Any, field: str, max_length: int, ctx: Ctx) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{field} must be text")
    return ctx["sanitize_str"](value, max_length)


def ad_campaign_string_list(
    value: Any,
    field: str,
    ctx: Ctx,
    *,
    max_items: int,
    item_length: int = 120,
    lower: bool = False,
) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > max_items:
        raise HTTPException(status_code=400, detail=f"{field} must be a list of at most {max_items} items")
    result: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            raise HTTPException(status_code=400, detail=f"{field} must contain only text")
        item = ctx["sanitize_str"](raw, item_length)
        if lower:
            item = item.lower()
        if item and item not in result:
            result.append(item)
    return result


def ad_campaign_date(value: Any, field: str, ctx: Ctx) -> tuple[str, datetime] | None:
    raw = ad_campaign_string(value, field, 40, ctx)
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a valid ISO date")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return raw, parsed


def ad_campaign_image_dimensions(decoded: bytes, mime: str) -> tuple[int, int] | None:
    """Read dimensions from supported formats without decoding pixel buffers."""
    if mime == "png":
        if (
            len(decoded) < 24
            or not decoded.startswith(b"\x89PNG\r\n\x1a\n")
            or decoded[12:16] != b"IHDR"
        ):
            return None
        return (
            int.from_bytes(decoded[16:20], "big"),
            int.from_bytes(decoded[20:24], "big"),
        )
    if mime in {"jpg", "jpeg"}:
        if len(decoded) < 4 or not decoded.startswith(b"\xff\xd8"):
            return None
        index = 2
        sof_markers = {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }
        while index + 3 < len(decoded):
            while index < len(decoded) and decoded[index] != 0xFF:
                index += 1
            while index < len(decoded) and decoded[index] == 0xFF:
                index += 1
            if index >= len(decoded):
                break
            marker = decoded[index]
            index += 1
            if marker in {0xD8, 0xD9}:
                continue
            if marker == 0xDA or index + 2 > len(decoded):
                break
            segment_length = int.from_bytes(decoded[index:index + 2], "big")
            if segment_length < 2 or index + segment_length > len(decoded):
                return None
            if marker in sof_markers:
                if segment_length < 7:
                    return None
                height = int.from_bytes(decoded[index + 3:index + 5], "big")
                width = int.from_bytes(decoded[index + 5:index + 7], "big")
                return width, height
            index += segment_length
        return None
    if mime == "webp":
        if (
            len(decoded) < 30
            or decoded[:4] != b"RIFF"
            or decoded[8:12] != b"WEBP"
        ):
            return None
        chunk = decoded[12:16]
        if chunk == b"VP8X":
            return (
                1 + int.from_bytes(decoded[24:27], "little"),
                1 + int.from_bytes(decoded[27:30], "little"),
            )
        if chunk == b"VP8 " and len(decoded) >= 30 and decoded[23:26] == b"\x9d\x01\x2a":
            return (
                int.from_bytes(decoded[26:28], "little") & 0x3FFF,
                int.from_bytes(decoded[28:30], "little") & 0x3FFF,
            )
        if chunk == b"VP8L" and len(decoded) >= 25 and decoded[20] == 0x2F:
            b1, b2, b3, b4 = decoded[21:25]
            return (
                1 + b1 + ((b2 & 0x3F) << 8),
                1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0F) << 10),
            )
    return None


def validate_ad_campaign_image_source(source: str) -> tuple[str, int, int]:
    match = re.fullmatch(
        r"data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})",
        source,
        flags=re.IGNORECASE,
    )
    if not match:
        raise HTTPException(
            status_code=400,
            detail="creativeImages supports valid PNG, JPEG, or WebP base64 data images",
        )
    mime = match.group(1).lower()
    try:
        decoded = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="creativeImages contains invalid base64")
    if not decoded or len(decoded) > MAX_AD_CAMPAIGN_DECODED_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Each campaign image must be 4 MB or smaller after decoding",
        )
    dimensions = ad_campaign_image_dimensions(decoded, mime)
    if not dimensions:
        raise HTTPException(
            status_code=400,
            detail="creativeImages contains an invalid or mismatched image file",
        )
    width, height = dimensions
    if (
        width <= 0
        or height <= 0
        or width > MAX_AD_CAMPAIGN_IMAGE_DIMENSION
        or height > MAX_AD_CAMPAIGN_IMAGE_DIMENSION
        or width * height > MAX_AD_CAMPAIGN_IMAGE_PIXELS
    ):
        raise HTTPException(
            status_code=413,
            detail="Campaign image dimensions are too large",
        )

    # Header inspection above lets us reject pixel bombs before allocating a
    # pixel buffer. Pillow then verifies and fully decodes the file so a
    # forged/truncated header cannot be stored as if it were a real image.
    expected_format = "JPEG" if mime in {"jpg", "jpeg"} else mime.upper()
    try:
        with Image.open(io.BytesIO(decoded)) as image:
            if (
                str(image.format or "").upper() != expected_format
                or image.size != (width, height)
                or bool(getattr(image, "is_animated", False))
            ):
                raise ValueError("Image type, size, or animation is not supported")
            image.verify()
        # verify() checks structure without decoding pixels. Re-open and load
        # one bounded image at a time to also catch truncated/corrupt payloads.
        with Image.open(io.BytesIO(decoded)) as image:
            if str(image.format or "").upper() != expected_format or image.size != (width, height):
                raise ValueError("Image changed between verification and decode")
            image.load()
    except (
        Image.DecompressionBombError,
        UnidentifiedImageError,
        OSError,
        SyntaxError,
        ValueError,
    ):
        raise HTTPException(
            status_code=400,
            detail="creativeImages contains a corrupt, truncated, animated, or mismatched image file",
        )
    return source, len(decoded), width * height


def prepare_ad_campaign_fields(
    raw_data: Any,
    *,
    strict: bool,
    reject_unknown: bool = False,
    trusted_media: bool = False,
    ctx: Ctx,
) -> dict[str, Any]:
    """Sanitize the customer-editable campaign envelope.

    This is a request/approval record only. It deliberately contains no Meta
    access token, live campaign ID, internal ad, receipt, or wallet mutation.
    """
    allowed_fields: frozenset[str] = ctx["allowed_fields"]
    sanitize_str: Callable[..., str] = ctx["sanitize_str"]
    sanitize_json: Callable[..., Any] = ctx["sanitize_json"]
    validate_entity_id: Callable[[Any], str] = ctx["validate_entity_id"]
    max_data_url_length: int = ctx["max_data_url_length"]

    def _string(value: Any, field: str, max_length: int) -> str:
        return ad_campaign_string(value, field, max_length, ctx)

    def _string_list(value: Any, field: str, **kwargs: Any) -> list[str]:
        return ad_campaign_string_list(value, field, ctx, **kwargs)

    def _date(value: Any, field: str) -> tuple[str, datetime] | None:
        return ad_campaign_date(value, field, ctx)

    if not isinstance(raw_data, dict):
        raise HTTPException(status_code=400, detail="Campaign data must be an object")
    if reject_unknown:
        unknown = set(raw_data) - allowed_fields
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported campaign field: {sorted(unknown)[0]}",
            )
    sanitized = sanitize_json(raw_data) or {}
    data = {key: sanitized[key] for key in allowed_fields if key in sanitized}
    clean: dict[str, Any] = {}

    string_limits = {
        "name": 160,
        "pageName": 160,
        "connectedAssetId": 80,
        "primaryText": 5000,
        "headline": 255,
        "description": 1000,
        "callToAction": 80,
        "destination": 2048,
        "budgetType": 40,
        "notes": 3000,
    }
    for field, limit in string_limits.items():
        if field in data:
            clean[field] = _string(data.get(field), field, limit)

    if "destination" in data:
        clean["destination"] = normalize_ad_campaign_destination(data.get("destination"), _string)

    if "callToAction" in data:
        cta = _string(data.get("callToAction"), "callToAction", 80)
        cta = AD_CAMPAIGN_CALL_TO_ACTION_ALIASES.get(cta.lower(), cta)
        if cta and cta not in AD_CAMPAIGN_CALL_TO_ACTIONS:
            raise HTTPException(status_code=400, detail="Unsupported callToAction")
        clean["callToAction"] = cta

    if "budgetType" in data:
        budget_type = _string(data.get("budgetType"), "budgetType", 40).lower()
        if budget_type and budget_type not in AD_CAMPAIGN_BUDGET_TYPES:
            raise HTTPException(status_code=400, detail="budgetType must be daily or lifetime")
        clean["budgetType"] = budget_type

    apply_boost_campaign_fields(data, clean, _string, validate_entity_id)

    if clean.get("connectedAssetId"):
        try:
            clean["connectedAssetId"] = validate_entity_id(clean["connectedAssetId"])
        except HTTPException:
            raise HTTPException(status_code=400, detail="connectedAssetId is invalid")

    if "objective" in data:
        objective = _string(data.get("objective"), "objective", 40).lower().replace(" ", "_")
        valid_objectives = {
            "awareness", "traffic", "engagement", "leads", "app_promotion",
            "sales", "messages",
        }
        if objective and objective not in valid_objectives:
            raise HTTPException(status_code=400, detail="Unsupported campaign objective")
        clean["objective"] = objective

    if "platforms" in data:
        platforms = _string_list(
            data.get("platforms"), "platforms", max_items=4, item_length=40, lower=True
        )
        if any(item not in {"facebook", "instagram", "messenger"} for item in platforms):
            raise HTTPException(status_code=400, detail="Unsupported advertising platform")
        clean["platforms"] = platforms

    for field, maximum, item_length in (
        ("locations", 25, 160),
        ("languages", 20, 80),
        ("interests", 50, 120),
    ):
        if field in data:
            clean[field] = _string_list(
                data.get(field), field, max_items=maximum, item_length=item_length
            )

    if "genders" in data:
        genders = _string_list(
            data.get("genders"), "genders", max_items=3, item_length=20, lower=True
        )
        if any(item not in {"all", "male", "female"} for item in genders):
            raise HTTPException(status_code=400, detail="Unsupported gender targeting value")
        clean["genders"] = genders

    if "specialAdCategories" in data:
        categories = _string_list(
            data.get("specialAdCategories"),
            "specialAdCategories",
            max_items=4,
            item_length=60,
            lower=True,
        )
        valid_categories = {
            "none", "credit", "employment", "housing",
            "social_issues_elections_politics",
        }
        if any(item not in valid_categories for item in categories):
            raise HTTPException(status_code=400, detail="Unsupported special ad category")
        if "none" in categories and len(categories) > 1:
            raise HTTPException(status_code=400, detail="specialAdCategories cannot combine none with another category")
        clean["specialAdCategories"] = categories

    for field in ("ageMin", "ageMax"):
        if field in data:
            value = data.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 18 or value > 65:
                raise HTTPException(status_code=400, detail=f"{field} must be an integer from 18 to 65")
            clean[field] = value
    if clean.get("ageMin") is not None and clean.get("ageMax") is not None:
        if int(clean["ageMin"]) > int(clean["ageMax"]):
            raise HTTPException(status_code=400, detail="ageMin cannot be greater than ageMax")

    if "budgetMinorUSD" in data:
        budget = data.get("budgetMinorUSD")
        if (
            isinstance(budget, bool)
            or not isinstance(budget, int)
            or budget < 0
            or budget > MAX_AD_CAMPAIGN_BUDGET_MINOR_USD
        ):
            raise HTTPException(
                status_code=400,
                detail="budgetMinorUSD must be a non-negative integer within the campaign limit",
            )
        clean["budgetMinorUSD"] = budget

    start = _date(data.get("startDate"), "startDate") if "startDate" in data else None
    end = _date(data.get("endDate"), "endDate") if "endDate" in data else None
    if start:
        clean["startDate"] = start[0]
    elif "startDate" in data:
        clean["startDate"] = ""
    if end:
        clean["endDate"] = end[0]
    elif "endDate" in data:
        clean["endDate"] = ""
    if start and end:
        if end[1] < start[1]:
            raise HTTPException(status_code=400, detail="endDate cannot be before startDate")
        if (end[1] - start[1]).days > 366:
            raise HTTPException(status_code=400, detail="Campaign duration cannot exceed 366 days")
    if strict and start and start[1].date() < datetime.now(timezone.utc).date():
        raise HTTPException(status_code=400, detail="startDate cannot be in the past")

    if "creativeAssetIds" in data:
        ids = _string_list(
            data.get("creativeAssetIds"), "creativeAssetIds", max_items=10, item_length=80
        )
        for asset_id in ids:
            try:
                validate_entity_id(asset_id)
            except HTTPException:
                raise HTTPException(status_code=400, detail="creativeAssetIds contains an invalid id")
        clean["creativeAssetIds"] = ids

    if "creativeImages" in data:
        images = data.get("creativeImages")
        if not isinstance(images, list) or len(images) > 3:
            raise HTTPException(status_code=400, detail="creativeImages must contain at most 3 images")
        clean_images: list[str] = []
        total_size = 0
        total_decoded_size = 0
        total_pixels = 0
        for image in images:
            if not isinstance(image, str):
                raise HTTPException(status_code=400, detail="creativeImages must contain data-image strings")
            if len(image) > max_data_url_length:
                raise HTTPException(status_code=413, detail="A campaign image data URL is too large")
            source = sanitize_str(image, max_data_url_length)
            if trusted_media:
                # Internal merge-only path: both the stored creative and any
                # incoming replacement were already decoder-verified earlier
                # in this request. Never use this flag on raw client input.
                encoded = source.partition(",")[2]
                decoded_size = max(0, (len(encoded) * 3) // 4 - (len(encoded) - len(encoded.rstrip("="))))
                image_pixels = 0
            else:
                source, decoded_size, image_pixels = validate_ad_campaign_image_source(source)
            total_size += len(source.encode("utf-8"))
            if total_size > MAX_AD_CAMPAIGN_MEDIA_BYTES:
                raise HTTPException(status_code=413, detail="creativeImages exceeds the 7 MB campaign limit")
            total_decoded_size += decoded_size
            if total_decoded_size > MAX_AD_CAMPAIGN_DECODED_MEDIA_BYTES:
                raise HTTPException(status_code=413, detail="creativeImages exceeds the 5 MB decoded-image limit")
            total_pixels += image_pixels
            if total_pixels > MAX_AD_CAMPAIGN_TOTAL_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Campaign images contain too many total pixels")
            clean_images.append(source)
        clean["creativeImages"] = clean_images

    if strict:
        required_text = (
            "name", "objective", "primaryText", "destination",
            "callToAction", "budgetType",
        )
        for field in required_text:
            if not str(clean.get(field) or "").strip():
                raise HTTPException(status_code=400, detail=f"{field} is required before submission")
        if not clean.get("platforms"):
            raise HTTPException(status_code=400, detail="At least one platform is required before submission")
        if not (str(clean.get("pageName") or "").strip() or str(clean.get("connectedAssetId") or "").strip()):
            raise HTTPException(status_code=400, detail="pageName or connectedAssetId is required before submission")
        if not clean.get("locations"):
            raise HTTPException(status_code=400, detail="At least one location is required before submission")
        if not start or not end:
            raise HTTPException(status_code=400, detail="startDate and endDate are required before submission")
        if int(clean.get("budgetMinorUSD") or 0) <= 0:
            raise HTTPException(status_code=400, detail="A positive budgetMinorUSD is required before submission")
        if not clean.get("creativeImages"):
            raise HTTPException(
                status_code=400,
                detail="At least one campaign image is required before submission",
            )
        enforce_boost_submission_rules(clean)

    return clean
