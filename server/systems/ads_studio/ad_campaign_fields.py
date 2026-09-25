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

Albayan Studio v2 fields (plan tasks P1-14 and P1-13 as changed by D19): ``goalDetail`` (sets or
must match the objective), ``locationKeys`` (Libya chips) and the picked post
(``sourcePostId`` + ``sourcePostPlatform``) are validated here. At submit, whether the picked
post belongs to the customer's linked page and whether a boost has a post or its own photo and
text is checked by studio_posts.enforce_source_post_rules.
"""

from __future__ import annotations

import base64
import binascii
import io
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from .ad_campaign_actions import (
    REFUSE_DURATION,
    REFUSE_MAX_DAYS,
    apply_boost_campaign_fields,
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
AD_CAMPAIGN_OBJECTIVES = frozenset(
    {"awareness", "traffic", "engagement", "leads", "app_promotion", "sales", "messages"}
)

# --- Goal, Libya locations and the post to boost (plan tasks P1-14, P1-13 as changed by D19) ---
# Customer fields of the studio v2 wizard. main.py's AD_CAMPAIGN_ALLOWED_FIELDS (ctx) is joined
# with these here, so main.py does not grow; PATCH accepts them and still refuses unknown fields.
AD_CAMPAIGN_STUDIO_FIELDS = frozenset({"goalDetail", "locationKeys", "sourcePostId", "sourcePostPlatform"})
# goalDetail -> (the one objective it runs under, the main result Meta reports for it). The key
# names never change once released (stored on requests); labels live with the screens.
AD_CAMPAIGN_GOAL_DETAILS: dict[str, tuple[str, str]] = {
    "messages": ("messages", "messaging_conversations_started"),
    "page_likes": ("engagement", "page_likes"),
    "post_engagement": ("engagement", "post_engagement"),
    "video_views": ("engagement", "video_views"),
    "website_visits": ("traffic", "link_clicks"),
    "leads": ("leads", "leads"),
    "sales": ("sales", "purchases"),
}
# The main result of a request that has no goalDetail (older requests, the classic screens).
AD_CAMPAIGN_OBJECTIVE_RESULT_TYPES: dict[str, str] = {
    "awareness": "reach",
    "traffic": "link_clicks",
    "engagement": "post_engagement",
    "leads": "leads",
    "app_promotion": "app_installs",
    "sales": "purchases",
    "messages": "messaging_conversations_started",
}
MAX_AD_CAMPAIGN_LOCATION_KEYS = 25
LIBYA_ALL_LOCATION_KEY = "libya"
# Libya location chips: key -> (English label, Arabic label). Keys never change once released.
LIBYA_LOCATIONS: dict[str, tuple[str, str]] = {
    "libya": ("All of Libya", "كل ليبيا"),
    "tripoli": ("Tripoli", "طرابلس"),
    "benghazi": ("Benghazi", "بنغازي"),
    "misrata": ("Misrata", "مصراتة"),
    "zawiya": ("Zawiya", "الزاوية"),
    "zliten": ("Zliten", "زليتن"),
    "khoms": ("Khoms", "الخمس"),
    "tajoura": ("Tajoura", "تاجوراء"),
    "janzour": ("Janzour", "جنزور"),
    "sabratha": ("Sabratha", "صبراتة"),
    "surman": ("Surman", "صرمان"),
    "zuwara": ("Zuwara", "زوارة"),
    "gharyan": ("Gharyan", "غريان"),
    "tarhuna": ("Tarhuna", "ترهونة"),
    "msallata": ("Msallata", "مسلاتة"),
    "bani_walid": ("Bani Walid", "بني وليد"),
    "zintan": ("Zintan", "الزنتان"),
    "yafran": ("Yafran", "يفرن"),
    "nalut": ("Nalut", "نالوت"),
    "ghadames": ("Ghadames", "غدامس"),
    "sirte": ("Sirte", "سرت"),
    "hun": ("Hun", "هون"),
    "ajdabiya": ("Ajdabiya", "أجدابيا"),
    "brega": ("Brega", "البريقة"),
    "marj": ("Marj", "المرج"),
    "bayda": ("Bayda", "البيضاء"),
    "shahhat": ("Shahhat", "شحات"),
    "derna": ("Derna", "درنة"),
    "tobruk": ("Tobruk", "طبرق"),
    "sabha": ("Sabha", "سبها"),
    "ubari": ("Ubari", "أوباري"),
    "murzuq": ("Murzuq", "مرزق"),
    "ghat": ("Ghat", "غات"),
    "kufra": ("Kufra", "الكفرة"),
}
# Other spellings a screen may send; they are stored as the key above.
_LIBYA_LOCATION_ALIASES = {
    "all_libya": "libya", "all": "libya", "misurata": "misrata", "misratah": "misrata",
    "zawia": "zawiya", "az_zawiyah": "zawiya", "al_zawiya": "zawiya", "zawiyah": "zawiya",
    "al_khums": "khoms", "khums": "khoms", "alkhums": "khoms", "tajura": "tajoura", "tajurah": "tajoura",
    "janzur": "janzour", "sabratah": "sabratha", "sabrata": "sabratha", "zuwarah": "zuwara",
    "zuara": "zuwara", "gharian": "gharyan", "tarhunah": "tarhuna", "misallata": "msallata",
    "baniwalid": "bani_walid", "yefren": "yafran", "ghadamis": "ghadames", "sirt": "sirte",
    "ajdabia": "ajdabiya", "marsa_brega": "brega", "al_marj": "marj", "al_bayda": "bayda",
    "albayda": "bayda", "beida": "bayda", "shahat": "shahhat", "darnah": "derna", "tobruq": "tobruk",
    "sebha": "sabha", "awbari": "ubari", "murzuk": "murzuq", "kufrah": "kufra", "al_kufrah": "kufra",
}
_LOCATION_KEY_SEPARATORS_RE = re.compile(r"[\s\-.'’]+")
SOURCE_POST_PLATFORMS = frozenset({"fb", "ig"})
# Fields a boost of an existing post does not need at submit (the post brings its own).
POST_BOOST_NOT_REQUIRED = frozenset({"objective", "primaryText", "destination", "callToAction"})
_SOURCE_POST_ID_RES = {"fb": re.compile(r"[0-9]{1,40}_[0-9]{1,40}"), "ig": re.compile(r"[0-9]{1,40}")}
# Shared refusal prefixes (the Arabic map of the screens matches these exact texts).
GOAL_OBJECTIVE_MISMATCH = "The goal detail does not match the objective"
UNKNOWN_LOCATION = "Unknown location"


def _location_lookup() -> dict[str, str]:
    table = {key: key for key in LIBYA_LOCATIONS}
    table.update(_LIBYA_LOCATION_ALIASES)
    for key, (label_en, label_ar) in LIBYA_LOCATIONS.items():
        table.setdefault(_LOCATION_KEY_SEPARATORS_RE.sub("_", label_en.strip().lower()), key)
        table.setdefault(label_ar, key)
    return table


_LIBYA_LOCATION_LOOKUP = _location_lookup()


def libya_location_key(value: str) -> str:
    """The stored key of one location chip ('' when it is not a known Libya location)."""
    raw = " ".join(str(value or "").split())
    if raw in _LIBYA_LOCATION_LOOKUP:
        return _LIBYA_LOCATION_LOOKUP[raw]
    return _LIBYA_LOCATION_LOOKUP.get(_LOCATION_KEY_SEPARATORS_RE.sub("_", raw.lower()).strip("_"), "")


def ad_campaign_result_type(goal_detail: Any, objective: Any = "") -> str:
    """The main result Meta reports for a request: from its goalDetail, else its objective."""
    goal = AD_CAMPAIGN_GOAL_DETAILS.get(str(goal_detail or ""))
    if goal:
        return goal[1]
    return AD_CAMPAIGN_OBJECTIVE_RESULT_TYPES.get(str(objective or ""), "")


def is_source_post_id(value: str, platform: str = "") -> bool:
    """A Facebook post id (<page id>_<post id>) or an Instagram media id; either when no platform."""
    patterns = [_SOURCE_POST_ID_RES[platform]] if platform in _SOURCE_POST_ID_RES else list(_SOURCE_POST_ID_RES.values())
    return any(pattern.fullmatch(value) for pattern in patterns)


def apply_goal_location_source_fields(
    data: dict[str, Any], clean: dict[str, Any], string_fn: Callable[..., str]
) -> None:
    """goalDetail, locationKeys, sourcePostId and sourcePostPlatform (P1-14, P1-13/D19).

    Runs after ``objective``. A goalDetail sets the objective when none is given and must match
    it when one is (T9). Location keys are Libya chips (aliases and the chip labels are stored
    as their key; anything else is T10). The post id is checked for its shape here; whether it
    belongs to the customer's linked page is checked at submit (studio_posts.py, T13).
    """
    if "goalDetail" in data:
        goal = string_fn(data.get("goalDetail"), "goalDetail", 40).lower().replace(" ", "_")
        if goal and goal not in AD_CAMPAIGN_GOAL_DETAILS:
            raise HTTPException(
                status_code=400,
                detail=f"goalDetail must be one of: {', '.join(AD_CAMPAIGN_GOAL_DETAILS)}",
            )
        clean["goalDetail"] = goal
    goal = str(clean.get("goalDetail") or "")
    if goal:
        expected = AD_CAMPAIGN_GOAL_DETAILS[goal][0]
        if not clean.get("objective"):
            clean["objective"] = expected
        elif clean["objective"] != expected:
            raise HTTPException(
                status_code=400,
                detail=f"{GOAL_OBJECTIVE_MISMATCH}: {goal} runs under the {expected} objective",
            )

    if "locationKeys" in data:
        raw_keys = data.get("locationKeys")
        if raw_keys is None:
            raw_keys = []
        if not isinstance(raw_keys, list) or len(raw_keys) > MAX_AD_CAMPAIGN_LOCATION_KEYS:
            raise HTTPException(
                status_code=400,
                detail=f"locationKeys must be a list of at most {MAX_AD_CAMPAIGN_LOCATION_KEYS} items",
            )
        keys: list[str] = []
        for raw in raw_keys:
            if not isinstance(raw, str):
                raise HTTPException(status_code=400, detail="locationKeys must contain only text")
            key = libya_location_key(string_fn(raw, "locationKeys", 80))
            if not key:
                raise HTTPException(status_code=400, detail=f"{UNKNOWN_LOCATION}: {string_fn(raw, 'locationKeys', 40)}")
            if key not in keys:
                keys.append(key)
        if LIBYA_ALL_LOCATION_KEY in keys and len(keys) > 1:
            raise HTTPException(
                status_code=400,
                detail="locationKeys cannot combine all of Libya with a city",
            )
        clean["locationKeys"] = keys

    if "sourcePostPlatform" in data:
        platform = string_fn(data.get("sourcePostPlatform"), "sourcePostPlatform", 10).lower()
        if platform and platform not in SOURCE_POST_PLATFORMS:
            raise HTTPException(status_code=400, detail="sourcePostPlatform must be fb or ig")
        clean["sourcePostPlatform"] = platform
    if "sourcePostId" in data:
        post_id = string_fn(data.get("sourcePostId"), "sourcePostId", 100)
        if post_id and not is_source_post_id(post_id, str(clean.get("sourcePostPlatform") or "")):
            raise HTTPException(
                status_code=400,
                detail="sourcePostId must be a Facebook post id (pageid_postid) or an Instagram media id that matches sourcePostPlatform",
            )
        clean["sourcePostId"] = post_id


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


def ad_campaign_duration_days(value: Any) -> int | None:
    """``durationDays`` (P1-11): null (not chosen yet) or a whole number of days from 1 to the
    studio ``limits.maxDays`` (T14 / T4). Read from the limits setting, never hard-coded."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise HTTPException(status_code=400, detail=f"{REFUSE_DURATION} (1 or more)")
    from .studio_settings import read_setting  # late: studio_settings imports this module

    max_days = int(read_setting("limits")["value"]["maxDays"])
    if value > max_days:
        raise HTTPException(status_code=400, detail=f"{REFUSE_MAX_DAYS}{max_days} days (this request: {value} days)")
    return value


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
    allowed_fields: frozenset[str] = ctx["allowed_fields"] | AD_CAMPAIGN_STUDIO_FIELDS
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
        if objective and objective not in AD_CAMPAIGN_OBJECTIVES:
            raise HTTPException(status_code=400, detail="Unsupported campaign objective")
        clean["objective"] = objective

    apply_goal_location_source_fields(data, clean, _string)

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

    if "durationDays" in data:
        clean["durationDays"] = ad_campaign_duration_days(data.get("durationDays"))

    start = _date(data.get("startDate"), "startDate") if "startDate" in data else None
    end = _date(data.get("endDate"), "endDate") if "endDate" in data else None
    if start and clean.get("durationDays"):
        # P1-11: the days decide the end, both ends counted (the classic form's count): a
        # 7-day ad from the 10th ends on the 16th. A different endDate sent with them loses.
        try:
            first_day = datetime.strptime(start[0][:10], "%Y-%m-%d").date()
        except ValueError:
            first_day = start[1].date()
        last_day = first_day + timedelta(days=int(clean["durationDays"]) - 1)
        end = (last_day.isoformat(), datetime(last_day.year, last_day.month, last_day.day, tzinfo=timezone.utc))
        if end[1] < start[1]:  # a start with a time of day: the end day still counts whole
            end = (end[0], start[1])
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
    if strict and start:
        from ...operations import _business_today  # the Libya day, not the UTC day
        if start[1].date() < _business_today():
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
        # P1-13 as changed by D19, before the other checks: the post to boost (T13: it must be from
        # the customer's linked page) and T11 (a boost with neither a post nor their own photo and
        # text). Boosting an existing post needs no objective, text, button, link or photo of its own.
        from .studio_posts import enforce_source_post_rules  # late import: studio_posts imports this module

        boosts_a_post = enforce_source_post_rules(clean, raw_data)
        required_text = (
            "name", "objective", "primaryText", "destination",
            "callToAction", "budgetType",
        )
        for field in required_text:
            if boosts_a_post and field in POST_BOOST_NOT_REQUIRED:
                continue
            if not str(clean.get(field) or "").strip():
                raise HTTPException(status_code=400, detail=f"{field} is required before submission")
        if not clean.get("platforms"):
            raise HTTPException(status_code=400, detail="At least one platform is required before submission")
        if not (str(clean.get("pageName") or "").strip() or str(clean.get("connectedAssetId") or "").strip()):
            raise HTTPException(status_code=400, detail="pageName or connectedAssetId is required before submission")
        if not (clean.get("locations") or clean.get("locationKeys")):
            raise HTTPException(status_code=400, detail="At least one location is required before submission")
        if not start or not end:
            raise HTTPException(status_code=400, detail="startDate and endDate are required before submission")
        if int(clean.get("budgetMinorUSD") or 0) <= 0:
            raise HTTPException(status_code=400, detail="A positive budgetMinorUSD is required before submission")
        if not clean.get("creativeImages") and not boosts_a_post:
            raise HTTPException(
                status_code=400,
                detail="At least one campaign image is required before submission",
            )

    return clean
