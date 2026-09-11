"""Albayan Social Studio: auto-reply rules and scheduled posts for FB/IG pages.

Customers with an active ``ad_maker`` subscription describe *rules* ("when a
comment on my page mentions 'price', send this private reply and like the
comment") and *scheduled posts* (a caption plus up to four photos that go out
to their Facebook page / Instagram account at a chosen time). Albayan owns a
single Meta business token, so ADMINS link the Meta pages Albayan manages to a
customer (the ``ownerId``); customers only ever see and edit their own rows.

Storage is the generic ``entities`` JSON table. Every Social Studio row
carries ``ownerId`` in its data AND ``created_by = ownerId`` in the indexed
column, so ownership filters never need a JSON expression on either dialect.

Meta traffic goes through :class:`server.meta_ads.MetaAdsClient` (one paced
request lane, app-secret proof, shared backoff). Page access tokens are
fetched on demand and cached in memory only: nothing token-shaped is ever
written to the database, returned to a browser, or printed.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import text

from . import meta_ads as _meta
from .db import db_conn, get_engine, json_loads
from .rate_limiter import check_rate_limit
from .security import new_id

SETTINGS_TYPE = "socialStudioSettings"
PAGES_TYPE = "socialPages"
RULES_TYPE = "socialReplyRules"
POSTS_TYPE = "socialPosts"
LOG_TYPE = "socialReplyLog"
SOCIAL_STUDIO_COLLECTIONS = frozenset(
    {SETTINGS_TYPE, PAGES_TYPE, RULES_TYPE, POSTS_TYPE, LOG_TYPE}
)

PLATFORMS = ("fb", "ig")
POST_EDITABLE_STATUSES = frozenset({"draft", "scheduled", "failed"})
MAX_POST_PAGES = 10
MAX_POST_MEDIA = 4
MAX_CAPTION_CHARS = 2200
MAX_MEDIA_DECODED_BYTES = 3 * 1024 * 1024
THUMBNAIL_MAX_CHARS = 60 * 1024
DEFAULT_TIMEZONE = "Africa/Tripoli"
DEFAULT_QUIET_HOURS = {"from": "22:00", "to": "08:00"}

_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DIGITS_RE = re.compile(r"^\d{1,40}$")
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
_DATA_URL_RE = re.compile(
    r"^data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$", re.IGNORECASE
)
# Arabic tashkeel (U+064B-U+0652), the superscript alef and tatweel: none of
# them change what a customer means, all of them break naive substring match.
_ARABIC_MARKS_RE = re.compile(r"[ً-ْٰـ]")
_ARABIC_LETTER_MAP = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ة": "ه", "ى": "ي"})

_PRIVATE_KEYS = frozenset({"_created", "_lastModified", "_deleted", "createdBy", "createdByName"})

# Populated by create_social_studio_router(); background paths (webhook,
# scheduler) reuse the same main.py helpers as the routes through it.
_CTX: dict[str, Any] = {}
_FALLBACK_MEDIA_SECRET = secrets.token_hex(32)
_COMMENT_LOCK = threading.Lock()
_WORKER_STOP = threading.Event()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_LOCK = threading.Lock()
WORKER_INTERVAL_SECONDS = 20


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _is_admin(user: dict[str, Any]) -> bool:
    return str(user.get("role") or "").lower() == "admin"


def normalize_text(value: Any) -> str:
    """Lowercase + Arabic-insensitive form used for keyword matching."""
    lowered = str(value or "").lower()
    lowered = _ARABIC_MARKS_RE.sub("", lowered).translate(_ARABIC_LETTER_MAP)
    return " ".join(lowered.split())


def _parse_hhmm(value: Any) -> int | None:
    raw = str(value or "").strip()
    if not _HHMM_RE.fullmatch(raw):
        return None
    hours, minutes = raw.split(":")
    return int(hours) * 60 + int(minutes)


def _in_quiet_window(quiet: Any, now_local: datetime) -> bool:
    quiet = quiet if isinstance(quiet, dict) else {}
    start = _parse_hhmm(quiet.get("from"))
    end = _parse_hhmm(quiet.get("to"))
    if start is None or end is None or start == end:
        return False
    minute_of_day = now_local.hour * 60 + now_local.minute
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end  # wraps midnight


def _zone(name: Any):
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(str(name or DEFAULT_TIMEZONE))
    except Exception:
        return timezone(timedelta(hours=2))  # Libya has no DST


def _data_url_decoded_size(value: str) -> int:
    payload = value.split(",", 1)[1] if "," in value else ""
    padding = len(payload) - len(payload.rstrip("="))
    return max(0, len(payload) * 3 // 4 - padding)


def media_signature(post_id: str, index: int) -> str:
    secret = (os.getenv("ALBAYAN_META_APP_SECRET") or "").strip() or _FALLBACK_MEDIA_SECRET
    return hmac.new(
        secret.encode("utf-8"), f"{post_id}:{int(index)}".encode("utf-8"), hashlib.sha256
    ).hexdigest()


def media_public_url(post_id: str, index: int) -> str:
    base = (os.getenv("ALBAYAN_PUBLIC_BASE_URL") or "https://albayanhub.com").strip().rstrip("/")
    return f"{base}/api/social-studio/media/{post_id}/{int(index)}?sig={media_signature(post_id, index)}"


def evaluate_rules(
    rules: list[dict[str, Any]],
    settings: dict[str, Any] | None,
    *,
    platform: str,
    post_ref: Any,
    text: str,
    from_id: str,
    already_replied_from_ids: set[str],
    now_local: datetime,
) -> dict[str, Any] | None:
    """Pick the first enabled rule that applies to a comment (pure, no I/O).

    ``post_ref`` is the Meta post/media id the comment belongs to, or a set of
    equivalent ids (Meta id + the matching socialPosts id) so a rule scoped to
    "chosen posts" can name either. ``already_replied_from_ids`` are commenters
    the page already answered automatically. Rules are checked in the order
    given; the caller passes them oldest-first so the first match wins.
    """
    if not _bool((settings or {}).get("masterEnabled"), True):
        return None
    refs = {post_ref} if isinstance(post_ref, str) else {str(x) for x in (post_ref or [])}
    refs.discard("")
    normalized = normalize_text(text)
    quiet = (settings or {}).get("quietHours") or {}
    replied = {str(x) for x in (already_replied_from_ids or set())}
    for rule in rules:
        if not isinstance(rule, dict) or not _bool(rule.get("enabled"), True):
            continue
        if str(rule.get("platform") or "") != platform:
            continue
        if str(rule.get("scope") or "all") == "chosen":
            wanted = {str(x) for x in (rule.get("postIds") or []) if str(x or "")}
            if not (wanted & refs):
                continue
        if str(rule.get("trigger") or "every") == "keywords":
            keywords = [normalize_text(k) for k in (rule.get("keywords") or [])]
            if not any(keyword and keyword in normalized for keyword in keywords):
                continue
        if _bool(rule.get("oncePerPerson")) and str(from_id or "") in replied:
            continue
        if _bool(rule.get("quietHours")) and _in_quiet_window(quiet, now_local):
            continue
        return rule
    return None


# ---------------------------------------------------------------------------
# Storage helpers (main.py helpers via ctx + a few read-only SQL projections)
# ---------------------------------------------------------------------------


def _ctx() -> dict[str, Any]:
    if not _CTX:
        raise RuntimeError("Social Studio router has not been created yet")
    return _CTX


def _entity_from_row(row: Any) -> dict[str, Any]:
    d = dict(row)
    data = json_loads(d.get("data_json") or "{}") or {}
    if not isinstance(data, dict):
        data = {}
    return {
        "id": str(d["id"]),
        "type": str(d["type"]),
        "deleted": bool(d["deleted"]),
        "createdAt": int(d["created_at"]),
        "createdBy": d.get("created_by"),
        "lastModified": int(d["last_modified"]),
        "data": data,
    }


def _public(entity: dict[str, Any]) -> dict[str, Any]:
    data = {k: v for k, v in (entity.get("data") or {}).items() if k not in _PRIVATE_KEYS}
    data["id"] = str(entity.get("id") or data.get("id") or "")
    data["lastModified"] = int(entity.get("lastModified") or 0)
    return data


def _rows(entity_type: str, owner_id: str | None, *, limit: int = 1000) -> list[dict[str, Any]]:
    """Owner-scoped rows (newest first) through main's list_entities."""
    kwargs: dict[str, Any] = {"limit": limit}
    if owner_id:
        kwargs["created_by"] = owner_id
    rows = _ctx()["list_entities"](entity_type, **kwargs)
    if owner_id:
        rows = [r for r in rows if str((r.get("data") or {}).get("ownerId") or "") == owner_id]
    return rows


def _json_field(field: str) -> str:
    if str(get_engine().dialect.name or "") == "postgresql":
        return f"(data_json::jsonb ->> '{field}')"
    return f"json_extract(data_json, '$.{field}')"


def _rows_where_json(
    entity_type: str, field: str, value: str, *, owner_id: str | None = None, limit: int = 1000
) -> list[dict[str, Any]]:
    """Rows whose top-level JSON ``field`` equals ``value`` (both dialects)."""
    where = ["type = :type", "deleted = false"]
    params: dict[str, Any] = {"type": entity_type, "value": value, "limit": max(1, min(int(limit), 5000))}
    if owner_id:
        where.append("created_by = :owner")
        params["owner"] = owner_id
    with db_conn() as conn:
        try:
            rows = conn.execute(
                text(
                    f"SELECT * FROM entities WHERE {' AND '.join(where)} "
                    f"AND {_json_field(field)} = :value ORDER BY created_at ASC, id ASC LIMIT :limit"
                ),
                params,
            ).mappings().all()
            return [_entity_from_row(r) for r in rows]
        except Exception:
            # Older SQLite builds may lack JSON functions: scan instead.
            params.pop("value", None)
            rows = conn.execute(
                text(f"SELECT * FROM entities WHERE {' AND '.join(where)} ORDER BY created_at ASC, id ASC"),
                params,
            ).mappings().all()
    entities = [_entity_from_row(r) for r in rows]
    return [e for e in entities if str(e["data"].get(field) or "") == value][: params["limit"]]


def _lean_posts(owner_id: str | None, status: str = "", *, limit: int = 500) -> list[dict[str, Any]]:
    """Posts without their photo payloads, projected by the database."""
    dialect = str(get_engine().dialect.name or "")
    where = ["type = :type", "deleted = false"]
    params: dict[str, Any] = {
        "type": POSTS_TYPE, "limit": max(1, min(int(limit), 1000)), "thumb_max": THUMBNAIL_MAX_CHARS,
    }
    if owner_id:
        where.append("created_by = :owner")
        params["owner"] = owner_id
    if status:
        where.append(f"COALESCE({_json_field('status')}, '') = :status")
        params["status"] = status
    if dialect == "postgresql":
        lean = "(data_json::jsonb - 'media')::text"
        count = (
            "CASE WHEN jsonb_typeof(data_json::jsonb -> 'media') = 'array' "
            "THEN jsonb_array_length(data_json::jsonb -> 'media') ELSE 0 END"
        )
        first = "COALESCE(data_json::jsonb -> 'media' ->> 0, '')"
    else:
        lean = "json_remove(data_json, '$.media')"
        count = (
            "CASE WHEN json_type(data_json, '$.media') = 'array' "
            "THEN json_array_length(data_json, '$.media') ELSE 0 END"
        )
        first = "COALESCE(json_extract(data_json, '$.media[0]'), '')"
    thumbnail = f"CASE WHEN length({first}) <= :thumb_max THEN {first} ELSE '' END"
    order = "ORDER BY created_at DESC, id DESC LIMIT :limit"
    with db_conn() as conn:
        try:
            rows = conn.execute(
                text(
                    f"SELECT type, id, deleted, created_at, created_by, last_modified, "
                    f"{lean} AS data_json, {count} AS media_count, {thumbnail} AS thumbnail "
                    f"FROM entities WHERE {' AND '.join(where)} {order}"
                ),
                params,
            ).mappings().all()
            result = []
            for row in rows:
                entity = _entity_from_row(row)
                entity["data"].pop("media", None)
                entity["data"]["mediaCount"] = int(row.get("media_count") or 0)
                entity["data"]["thumbnail"] = str(row.get("thumbnail") or "")
                result.append(entity)
            return result
        except Exception:
            params.pop("status", None)
            plain_where = [w for w in where if not w.startswith("COALESCE(")]
            rows = conn.execute(
                text(f"SELECT * FROM entities WHERE {' AND '.join(plain_where)} {order}"),
                params,
            ).mappings().all()
    result = []
    for row in rows:
        entity = _entity_from_row(row)
        if status and str(entity["data"].get("status") or "") != status:
            continue
        media = entity["data"].pop("media", None)
        media = [m for m in media if isinstance(m, str)] if isinstance(media, list) else []
        entity["data"]["mediaCount"] = len(media)
        first_item = media[0] if media else ""
        entity["data"]["thumbnail"] = first_item if len(first_item) <= THUMBNAIL_MAX_CHARS else ""
        result.append(entity)
    return result


def _owner_exists(owner_id: str) -> bool:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE id = :id AND deleted = false LIMIT 1"),
            {"id": owner_id},
        ).first()
    return bool(row)


# ---------------------------------------------------------------------------
# Access + validation
# ---------------------------------------------------------------------------


class _Scope:
    __slots__ = ("uid", "admin", "owner", "explicit")

    def __init__(self, uid: str, admin: bool, owner: str, explicit: bool):
        self.uid, self.admin, self.owner, self.explicit = uid, admin, owner, explicit

    @property
    def list_owner(self) -> str | None:
        """Owner filter for list routes: admins without ?ownerId= see everyone."""
        return None if self.admin and not self.explicit else self.owner


def _scope(user: dict[str, Any], ctx: dict[str, Any], owner_param: str = "") -> _Scope:
    ctx["require_ad_maker_subscription"](user)
    uid = str(user.get("id") or "")
    if not uid:
        raise HTTPException(status_code=401, detail="Authentication required")
    admin = _is_admin(user)
    requested = str(owner_param or "").strip()
    if requested:
        requested = ctx["validate_entity_id"](requested)
        if not admin and requested != uid:
            raise HTTPException(status_code=403, detail="You can only manage your own Social Studio")
        if requested != uid and not _owner_exists(requested):
            raise HTTPException(status_code=404, detail="Unknown owner")
    return _Scope(uid, admin, requested or uid, bool(requested))


def _require_admin(user: dict[str, Any]) -> None:
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Admin only")


def _enforce_mutation_rate(user: dict[str, Any]) -> None:
    uid = str(user.get("id") or "")
    allowed, _left, retry_after_ms = check_rate_limit(
        f"social-studio:mutations:{uid}", max_attempts=60, window_ms=60_000
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many Social Studio changes. Please wait and try again.",
            headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
        )


def _mutation(request: Request, user: dict[str, Any], ctx: dict[str, Any], owner_param: str = "") -> _Scope:
    ctx["require_same_origin"](request)
    scope = _scope(user, ctx, owner_param)
    _enforce_mutation_rate(user)
    return scope


def _load_owned(ctx: dict[str, Any], entity_type: str, entity_id: str, scope: _Scope) -> dict[str, Any]:
    entity_id = ctx["validate_entity_id"](entity_id)
    entity = ctx["get_entity"](entity_type, entity_id)
    if not entity or entity.get("deleted"):
        raise HTTPException(status_code=404, detail="Not found")
    owner = str((entity.get("data") or {}).get("ownerId") or "")
    if not scope.admin and owner != scope.uid:
        raise HTTPException(status_code=404, detail="Not found")
    return entity


def _text_field(ctx: dict[str, Any], raw: Any, label: str, maximum: int, *, required: bool = False) -> str:
    value = str(raw or "").strip()
    if required and not value:
        raise HTTPException(status_code=400, detail=f"{label} is required")
    if len(value) > maximum:
        raise HTTPException(status_code=400, detail=f"{label} must be {maximum} characters or fewer")
    return ctx["sanitize_str"](value, maximum + 1)[:maximum]


def _string_list(raw: Any, label: str, *, max_items: int, max_chars: int) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail=f"{label} must be a list")
    items: list[str] = []
    for item in raw:
        value = str(item or "").strip()
        if not value:
            continue
        if len(value) > max_chars:
            raise HTTPException(status_code=400, detail=f"Each {label} entry must be {max_chars} characters or fewer")
        if value not in items:
            items.append(value)
    if len(items) > max_items:
        raise HTTPException(status_code=400, detail=f"{label} supports at most {max_items} entries")
    return items


def _clean_settings(ctx: dict[str, Any], owner_id: str, raw: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
    clean = dict(existing)
    if "masterEnabled" in raw:
        clean["masterEnabled"] = _bool(raw.get("masterEnabled"), True)
    if "quietHours" in raw:
        quiet = raw.get("quietHours")
        if not isinstance(quiet, dict):
            raise HTTPException(status_code=400, detail="quietHours must be an object with from and to")
        for key in ("from", "to"):
            if _parse_hhmm(quiet.get(key)) is None:
                raise HTTPException(status_code=400, detail=f"quietHours.{key} must be HH:MM")
        clean["quietHours"] = {"from": str(quiet["from"]).strip(), "to": str(quiet["to"]).strip()}
    if "timezone" in raw:
        name = _text_field(ctx, raw.get("timezone"), "timezone", 64) or DEFAULT_TIMEZONE
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(name)
        except Exception:
            raise HTTPException(status_code=400, detail="Unknown timezone")
        clean["timezone"] = name
    clean["ownerId"] = owner_id
    clean["updatedAt"] = _iso_now()
    return clean


def _default_settings(owner_id: str) -> dict[str, Any]:
    now = _iso_now()
    return {
        "ownerId": owner_id,
        "masterEnabled": True,
        "quietHours": dict(DEFAULT_QUIET_HOURS),
        "timezone": DEFAULT_TIMEZONE,
        "createdAt": now,
        "updatedAt": now,
    }


def _settings_entity(ctx: dict[str, Any], owner_id: str) -> dict[str, Any]:
    settings_id = f"sst_{owner_id}"
    entity = ctx["get_entity"](SETTINGS_TYPE, settings_id)
    if entity and not entity.get("deleted"):
        return entity
    try:
        return ctx["upsert_entity"](
            SETTINGS_TYPE, settings_id, _default_settings(owner_id), owner_id, reject_existing=True
        )
    except HTTPException as error:
        if error.status_code != 409:
            raise
        return ctx["get_entity"](SETTINGS_TYPE, settings_id)


def _clean_rule(ctx: dict[str, Any], owner_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    name = _text_field(ctx, raw.get("name"), "Rule name", 80, required=True)
    platform = str(raw.get("platform") or "fb").strip().lower()
    if platform not in PLATFORMS:
        raise HTTPException(status_code=400, detail="platform must be fb or ig")
    scope = str(raw.get("scope") or "all").strip().lower()
    if scope not in ("all", "chosen"):
        raise HTTPException(status_code=400, detail="scope must be all or chosen")
    trigger = str(raw.get("trigger") or "every").strip().lower()
    if trigger not in ("every", "keywords"):
        raise HTTPException(status_code=400, detail="trigger must be every or keywords")
    post_ids = [
        ctx["sanitize_str"](p, 120)
        for p in _string_list(raw.get("postIds"), "postIds", max_items=50, max_chars=120)
    ]
    keywords: list[str] = []
    for keyword in _string_list(raw.get("keywords"), "keywords", max_items=30, max_chars=40):
        normalized = normalize_text(ctx["sanitize_str"](keyword, 40))
        if normalized and normalized not in keywords:
            keywords.append(normalized)
    public_reply = _text_field(ctx, raw.get("publicReply"), "publicReply", 1000)
    dm_text = _text_field(ctx, raw.get("dmText"), "dmText", 1000)
    dm_enabled = _bool(raw.get("dmEnabled"))
    if trigger == "keywords" and not keywords:
        raise HTTPException(status_code=400, detail="Add at least one keyword for a keyword rule")
    if scope == "chosen" and not post_ids:
        raise HTTPException(status_code=400, detail="Choose at least one post for a chosen-posts rule")
    if not public_reply and not (dm_enabled and dm_text):
        raise HTTPException(status_code=400, detail="A rule needs a public reply or a private message")
    return {
        "ownerId": owner_id,
        "name": name,
        "platform": platform,
        "enabled": _bool(raw.get("enabled"), True),
        "scope": scope,
        "postIds": post_ids,
        "trigger": trigger,
        "keywords": keywords,
        "publicReply": public_reply,
        "dmEnabled": dm_enabled,
        "dmText": dm_text,
        "likeComment": _bool(raw.get("likeComment")),
        "oncePerPerson": _bool(raw.get("oncePerPerson")),
        "skipPublicAfterDm": _bool(raw.get("skipPublicAfterDm")),
        "pauseDms": _bool(raw.get("pauseDms")),
        "quietHours": _bool(raw.get("quietHours")),
    }


def _clean_post(
    ctx: dict[str, Any], owner_id: str, raw: dict[str, Any], existing: dict[str, Any] | None
) -> dict[str, Any]:
    existing = existing or {}
    caption = _text_field(
        ctx, raw.get("caption") if "caption" in raw else existing.get("caption"), "caption", MAX_CAPTION_CHARS
    )
    page_ids_raw = raw.get("pageIds") if "pageIds" in raw else existing.get("pageIds")
    page_ids = _string_list(page_ids_raw, "pageIds", max_items=MAX_POST_PAGES, max_chars=80)
    for page_id in page_ids:
        page = ctx["get_entity"](PAGES_TYPE, ctx["validate_entity_id"](page_id))
        if not page or page.get("deleted") or str(page["data"].get("ownerId") or "") != owner_id:
            raise HTTPException(status_code=400, detail=f"Page {page_id} is not linked to this account")
    if not page_ids:
        raise HTTPException(status_code=400, detail="Choose at least one page")

    media_raw = raw.get("media") if "media" in raw else existing.get("media")
    if media_raw is None:
        media_raw = []
    if not isinstance(media_raw, list):
        raise HTTPException(status_code=400, detail="media must be a list of images")
    if len(media_raw) > MAX_POST_MEDIA:
        raise HTTPException(status_code=400, detail=f"A post supports at most {MAX_POST_MEDIA} photos")
    known = {m for m in (existing.get("media") or []) if isinstance(m, str)}
    media: list[str] = []
    for index, item in enumerate(media_raw):
        if not isinstance(item, str) or not item.startswith("data:image/"):
            raise HTTPException(status_code=400, detail=f"Photo {index + 1} must be a PNG, JPEG or WebP image")
        if _data_url_decoded_size(item) > MAX_MEDIA_DECODED_BYTES:
            raise HTTPException(status_code=400, detail=f"Photo {index + 1} must be 3 MB or smaller")
        if item not in known:
            try:
                valid = ctx["validate_image"](item)
            except HTTPException as error:
                raise HTTPException(status_code=400, detail=f"Photo {index + 1}: {error.detail}")
            if not valid:
                raise HTTPException(status_code=400, detail=f"Photo {index + 1} is not a valid image")
        media.append(item)
    if not caption and not media:
        raise HTTPException(status_code=400, detail="A post needs a caption or at least one photo")

    previous_status = str(existing.get("status") or "")
    default_status = previous_status if previous_status in ("draft", "scheduled") else "draft"
    status = str(raw.get("status") or default_status).strip().lower()
    if status not in ("draft", "scheduled"):
        raise HTTPException(status_code=400, detail="status must be draft or scheduled")
    scheduled_raw = raw.get("scheduledAt") if "scheduledAt" in raw else existing.get("scheduledAt")
    scheduled_at = _parse_iso(scheduled_raw)
    if status == "scheduled":
        if scheduled_at is None:
            raise HTTPException(status_code=400, detail="scheduledAt is required to schedule a post")
        if scheduled_at < datetime.now(timezone.utc) + timedelta(minutes=1):
            raise HTTPException(status_code=400, detail="scheduledAt must be at least one minute in the future")
    elif scheduled_raw and scheduled_at is None:
        raise HTTPException(status_code=400, detail="scheduledAt must be an ISO date-time")

    rule_raw = raw.get("autoReplyRuleId") if "autoReplyRuleId" in raw else existing.get("autoReplyRuleId")
    rule_id = str(rule_raw or "").strip()
    if rule_id:
        rule = ctx["get_entity"](RULES_TYPE, ctx["validate_entity_id"](rule_id))
        if not rule or rule.get("deleted") or str(rule["data"].get("ownerId") or "") != owner_id:
            raise HTTPException(status_code=400, detail="autoReplyRuleId is not one of your rules")

    return {
        "ownerId": owner_id,
        "pageIds": page_ids,
        "caption": caption,
        "media": media,
        "status": status,
        "scheduledAt": scheduled_at.isoformat().replace("+00:00", "Z") if scheduled_at else "",
        "autoReplyRuleId": rule_id,
        "lastError": "",
    }


# ---------------------------------------------------------------------------
# Meta publishing + comment handling
# ---------------------------------------------------------------------------


def _graph_id(payload: Any) -> str:
    value = str(payload.get("id") or "") if isinstance(payload, dict) else ""
    if not value:
        raise _meta.MetaAdsError("invalid_response", "Meta did not return an id for the published content.")
    return value


def _publish_to_page(client: Any, page: dict[str, Any], post_id: str, post: dict[str, Any]) -> str:
    """Publish one post to one linked page; returns the Meta post/media id."""
    caption = str(post.get("caption") or "")
    media = [m for m in (post.get("media") or []) if isinstance(m, str)]
    meta_page_id = str(page.get("metaPageId") or "")
    token = client.page_access_token(meta_page_id)
    if str(page.get("platform") or "") == "fb":
        if not media:
            return _graph_id(client._post(f"{meta_page_id}/feed", {"message": caption}, access_token=token))
        photo_ids = [
            _graph_id(client._post(
                f"{meta_page_id}/photos",
                {"url": media_public_url(post_id, index), "published": "false"},
                access_token=token,
            ))
            for index in range(len(media))
        ]
        form: dict[str, Any] = {"message": caption}
        for index, photo_id in enumerate(photo_ids):
            form[f"attached_media[{index}]"] = json.dumps({"media_fbid": photo_id}, separators=(",", ":"))
        return _graph_id(client._post(f"{meta_page_id}/feed", form, access_token=token))
    ig_user_id = str(page.get("igUserId") or "")
    if not media:
        raise _meta.MetaAdsError("ig_needs_image", "Instagram posts need at least one photo.")
    if len(media) == 1:
        creation_id = _graph_id(client._post(
            f"{ig_user_id}/media",
            {"image_url": media_public_url(post_id, 0), "caption": caption},
            access_token=token,
        ))
    else:
        children = [
            _graph_id(client._post(
                f"{ig_user_id}/media",
                {"image_url": media_public_url(post_id, index), "is_carousel_item": "true"},
                access_token=token,
            ))
            for index in range(len(media))
        ]
        creation_id = _graph_id(client._post(
            f"{ig_user_id}/media",
            {"media_type": "CAROUSEL", "children": ",".join(children), "caption": caption},
            access_token=token,
        ))
    return _graph_id(
        client._post(f"{ig_user_id}/media_publish", {"creation_id": creation_id}, access_token=token)
    )


def publish_post(post_id: str, *, actor_id: str = "") -> dict[str, Any]:
    """Run the publish routine for a post already claimed as ``publishing``.

    Pages that already succeeded in an earlier attempt keep their metaPostId
    and are not posted twice. Status ends ``published`` only when every page
    succeeded, otherwise ``failed`` with the first error in ``lastError``.
    """
    ctx = _ctx()
    entity = ctx["get_entity"](POSTS_TYPE, post_id)
    if not entity or entity.get("deleted"):
        raise HTTPException(status_code=404, detail="Not found")
    data = entity.get("data") or {}
    if str(data.get("status") or "") != "publishing":
        raise HTTPException(status_code=409, detail="Post is not claimed for publishing")
    owner_id = str(data.get("ownerId") or "")
    previous = {
        str(r.get("pageId") or ""): r
        for r in (data.get("results") or [])
        if isinstance(r, dict) and r.get("metaPostId") and not r.get("error")
    }
    client: Any = None
    client_error = ""
    try:
        client = _meta.get_meta_ads_client()
    except _meta.MetaAdsError as error:
        client_error = error.public_message
    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for page_id in [str(p) for p in (data.get("pageIds") or [])]:
        if page_id in previous:
            results.append(dict(previous[page_id]))
            continue
        result = {"pageId": page_id, "metaPostId": "", "error": ""}
        page = ctx["get_entity"](PAGES_TYPE, page_id) if _SAFE_ID_RE.fullmatch(page_id) else None
        if client is None:
            result["error"] = client_error
        elif not page or page.get("deleted") or str(page["data"].get("ownerId") or "") != owner_id:
            result["error"] = "This page is no longer linked to the account."
        else:
            healthy = True
            try:
                result["metaPostId"] = _publish_to_page(client, page["data"], post_id, data)
            except _meta.MetaAdsError as error:
                result["error"] = error.public_message
                healthy = error.code != "authorization"
            except Exception as error:  # never leak tokens/stack traces into rows
                result["error"] = f"Publishing failed ({type(error).__name__})."
            if bool(page["data"].get("healthy", True)) != healthy:
                try:
                    ctx["patch_entity"](PAGES_TYPE, page_id, {"healthy": healthy, "updatedAt": _iso_now()}, owner_id)
                except HTTPException:
                    pass
        if result["error"]:
            errors.append(result["error"])
        results.append(result)
    now = _iso_now()
    updates: dict[str, Any] = {
        "results": results,
        "status": "published" if not errors else "failed",
        "lastError": "" if not errors else errors[0],
        "updatedAt": now,
    }
    if not errors:
        updates["publishedAt"] = now
    saved = ctx["patch_entity"](POSTS_TYPE, post_id, updates, actor_id or owner_id)
    try:
        ctx["audit"](
            actor_id or owner_id, "publish", POSTS_TYPE, post_id,
            "Social Studio post published" if not errors else "Social Studio post failed",
            {"errors": errors[:3]},
        )
    except Exception:
        pass
    return saved


def _claim_post(ctx: dict[str, Any], entity: dict[str, Any], actor_id: str) -> bool:
    """Move a post to ``publishing`` only if nobody else changed it first."""
    try:
        ctx["patch_entity"](
            POSTS_TYPE,
            entity["id"],
            {"status": "publishing", "updatedAt": _iso_now()},
            actor_id,
            expected_last_modified=int(entity.get("lastModified") or 0),
        )
    except HTTPException as error:
        if error.status_code in (404, 409):
            return False
        raise
    return True


def _due_scheduled_posts(now: datetime, limit: int) -> list[dict[str, Any]]:
    due = []
    for entity in _rows_where_json(POSTS_TYPE, "status", "scheduled", limit=500):
        scheduled_at = _parse_iso(entity["data"].get("scheduledAt"))
        if scheduled_at is not None and scheduled_at <= now:
            due.append(entity)
            if len(due) >= limit:
                break
    return due


def run_scheduler_tick(*, now: datetime | None = None, limit: int = 20) -> int:
    """Publish every due scheduled post once. Returns how many were attempted."""
    ctx = _ctx()
    current = now or datetime.now(timezone.utc)
    attempted = 0
    for entity in _due_scheduled_posts(current, limit):
        owner_id = str(entity["data"].get("ownerId") or "")
        if not _claim_post(ctx, entity, owner_id):
            continue  # another worker generation/process took it
        attempted += 1
        try:
            publish_post(entity["id"], actor_id=owner_id)
        except Exception as error:
            print(f"[albayan] Social Studio publish failed for {entity['id']} ({type(error).__name__}).")
    return attempted


def _worker_loop(stop: threading.Event) -> None:
    if stop.wait(5):
        return
    while not stop.is_set():
        try:
            run_scheduler_tick()
        except Exception:
            print("[albayan] Social Studio scheduler pass failed; it will retry.")
        stop.wait(WORKER_INTERVAL_SECONDS)


def start_social_studio_worker() -> None:
    global _WORKER_THREAD, _WORKER_STOP
    if not _meta.load_meta_ads_config().configured:
        return
    with _WORKER_LOCK:
        if _WORKER_THREAD and _WORKER_THREAD.is_alive():
            return
        _WORKER_STOP = threading.Event()
        _WORKER_THREAD = threading.Thread(
            target=_worker_loop, args=(_WORKER_STOP,), name="albayan-social-studio", daemon=True
        )
        _WORKER_THREAD.start()
    print("[albayan] Social Studio scheduled publishing enabled.")


def stop_social_studio_worker() -> None:
    global _WORKER_THREAD
    with _WORKER_LOCK:
        thread = _WORKER_THREAD
        _WORKER_STOP.set()
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=3)
    with _WORKER_LOCK:
        if _WORKER_THREAD is thread and not (thread and thread.is_alive()):
            _WORKER_THREAD = None


def _find_page(platform: str, entry_id: str) -> dict[str, Any] | None:
    field = "metaPageId" if platform == "fb" else "igUserId"
    for entity in _rows_where_json(PAGES_TYPE, field, entry_id, limit=50):
        if str(entity["data"].get("platform") or "") == platform:
            return entity
    return None


def _log_id(owner_id: str, platform: str, comment_id: str) -> str:
    digest = hashlib.sha256(f"{owner_id}:{platform}:{comment_id}".encode("utf-8")).hexdigest()
    return f"srl_{digest[:32]}"


def process_comment(
    *, platform: str, entry_id: str, comment_id: str, post_ref: str, from_id: str, text: str
) -> dict[str, Any] | None:
    """Answer one new comment according to the page owner's rules.

    Returns the reply-log data when a rule acted, else None. Never raises:
    the webhook path must always acknowledge Meta.
    """
    ctx = _ctx()
    page_entity = _find_page(platform, entry_id)
    if not page_entity:
        return None
    page = page_entity["data"]
    if str(from_id or "") in {str(page.get("metaPageId") or ""), str(page.get("igUserId") or "")}:
        return None  # the page replying to itself is not a customer comment
    owner_id = str(page.get("ownerId") or "")
    if not owner_id:
        return None
    with _COMMENT_LOCK:
        settings = _settings_entity(ctx, owner_id)["data"]
        rules = sorted(
            (r["data"] for r in _rows(RULES_TYPE, owner_id) if _bool(r["data"].get("enabled"), True)),
            key=lambda r: (int(r.get("_created") or 0), str(r.get("id") or "")),
        )
        if not rules:
            return None
        replied = {
            str(r["data"].get("fromId") or "")
            for r in _rows(LOG_TYPE, owner_id, limit=1000)
            if str(r["data"].get("pageId") or "") == page_entity["id"] and r["data"].get("actions")
        }
        refs = {str(post_ref or "")}
        for post in _rows_where_json(POSTS_TYPE, "status", "published", owner_id=owner_id, limit=500):
            results = [r for r in (post["data"].get("results") or []) if isinstance(r, dict)]
            if any(str(r.get("metaPostId") or "") == str(post_ref or "") for r in results):
                refs.add(post["id"])
        rule = evaluate_rules(
            rules, settings, platform=platform, post_ref=refs, text=text, from_id=str(from_id or ""),
            already_replied_from_ids=replied, now_local=datetime.now(_zone(settings.get("timezone"))),
        )
        if not rule:
            return None
        log_id = _log_id(owner_id, platform, comment_id)
        log_data = {
            "ownerId": owner_id,
            "pageId": page_entity["id"],
            "metaPageId": str(page.get("metaPageId") or ""),
            "platform": platform,
            "ruleId": str(rule.get("id") or ""),
            "commentId": str(comment_id),
            "postId": str(post_ref or ""),
            "fromId": str(from_id or ""),
            "actions": [],
            "at": _iso_now(),
            "error": "",
        }
        try:
            # The row IS the idempotency claim: a duplicate delivery hits 409.
            ctx["upsert_entity"](LOG_TYPE, log_id, log_data, owner_id, reject_existing=True)
        except HTTPException as error:
            if error.status_code == 409:
                return None
            raise
    actions: list[str] = []
    errors: list[str] = []
    client: Any = None
    token = ""
    try:
        client = _meta.get_meta_ads_client()
        token = client.page_access_token(str(page.get("metaPageId") or ""))
    except _meta.MetaAdsError as error:
        client = None
        errors.append(error.public_message)
    dm_sent = False
    if client is not None:
        dm_text = str(rule.get("dmText") or "")
        if _bool(rule.get("dmEnabled")) and dm_text and not _bool(rule.get("pauseDms")):
            try:
                if platform == "fb":
                    client._post(f"{comment_id}/private_replies", {"message": dm_text}, access_token=token)
                else:
                    client._post(
                        f"{page.get('igUserId')}/messages",
                        {
                            "recipient": json.dumps({"comment_id": str(comment_id)}, separators=(",", ":")),
                            "message": json.dumps({"text": dm_text}, separators=(",", ":"), ensure_ascii=False),
                        },
                        access_token=token,
                    )
                actions.append("dm")
                dm_sent = True
            except _meta.MetaAdsError as error:
                errors.append(f"dm: {error.public_message}")
        public_reply = str(rule.get("publicReply") or "")
        if public_reply and not (_bool(rule.get("skipPublicAfterDm")) and dm_sent):
            try:
                path = f"{comment_id}/comments" if platform == "fb" else f"{comment_id}/replies"
                client._post(path, {"message": public_reply}, access_token=token)
                actions.append("public")
            except _meta.MetaAdsError as error:
                errors.append(f"public: {error.public_message}")
        if platform == "fb" and _bool(rule.get("likeComment")):
            try:
                client._post(f"{comment_id}/likes", {}, access_token=token)
                actions.append("like")
            except _meta.MetaAdsError as error:
                errors.append(f"like: {error.public_message}")
    log_data["actions"] = actions
    log_data["error"] = "; ".join(errors)[:500]
    try:
        saved = ctx["patch_entity"](LOG_TYPE, log_id, {"actions": actions, "error": log_data["error"]}, owner_id)
        return saved.get("data") or log_data
    except HTTPException:
        return log_data


def handle_meta_webhook(payload: Any) -> int:
    """Turn a signed Page/Instagram webhook into comment replies. Never raises."""
    if not isinstance(payload, dict):
        return 0
    obj = str(payload.get("object") or "")
    handled = 0
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "")
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            value = change.get("value") if isinstance(change.get("value"), dict) else {}
            sender = value.get("from") if isinstance(value.get("from"), dict) else {}
            if obj == "page":
                if change.get("field") != "feed" or value.get("item") != "comment" or value.get("verb") != "add":
                    continue
                platform, comment_id = "fb", str(value.get("comment_id") or "")
                post_ref, message = str(value.get("post_id") or ""), str(value.get("message") or "")
            elif obj == "instagram":
                if change.get("field") != "comments":
                    continue
                media = value.get("media") if isinstance(value.get("media"), dict) else {}
                platform, comment_id = "ig", str(value.get("id") or "")
                post_ref, message = str(media.get("id") or ""), str(value.get("text") or "")
            else:
                continue
            from_id = str(sender.get("id") or "")
            if not comment_id or not from_id or not entry_id or from_id == entry_id:
                continue
            try:
                if process_comment(
                    platform=platform, entry_id=entry_id, comment_id=comment_id,
                    post_ref=post_ref, from_id=from_id, text=message,
                ):
                    handled += 1
            except Exception as error:
                print(f"[albayan] Social Studio comment handling failed ({type(error).__name__}).")
    return handled


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str:
    forwarded = str(request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return (forwarded or (request.client.host if request.client else "") or "unknown")[:80]


def create_social_studio_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/social-studio", tags=["social-studio"])
    ctx = dict(ctx)
    ctx["require_same_origin"] = require_same_origin
    _CTX.clear()
    _CTX.update(ctx)

    @router.on_event("startup")
    def _start_worker() -> None:
        start_social_studio_worker()

    @router.on_event("shutdown")
    def _stop_worker() -> None:
        stop_social_studio_worker()

    def _meta_http_error(error: _meta.MetaAdsError) -> HTTPException:
        if error.code == "not_configured":
            return HTTPException(
                status_code=503,
                detail="Meta is not connected yet. Add Albayan's Meta access token to enable Social Studio.",
            )
        return HTTPException(status_code=502 if error.retryable else 400, detail=error.public_message)

    owner_query = Query(default="", max_length=80)

    # ---- settings -------------------------------------------------------
    @router.get("/settings")
    def get_settings(ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        return _public(_settings_entity(ctx, scope.owner))

    @router.put("/settings")
    def put_settings(
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _settings_entity(ctx, scope.owner)
        clean = _clean_settings(ctx, scope.owner, body or {}, entity["data"])
        saved = ctx["patch_entity"](SETTINGS_TYPE, entity["id"], clean, scope.uid)
        return _public(saved)

    # ---- rules ----------------------------------------------------------
    @router.get("/rules")
    def list_rules(ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        rows = sorted(_rows(RULES_TYPE, scope.list_owner), key=lambda r: (int(r.get("createdAt") or 0), r["id"]))
        return {"rules": [_public(r) for r in rows]}

    @router.post("/rules")
    def create_rule(
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        now = _iso_now()
        clean = {**_clean_rule(ctx, scope.owner, body or {}), "createdAt": now, "updatedAt": now}
        rule_id = new_id("srule")
        saved = ctx["upsert_entity"](RULES_TYPE, rule_id, clean, scope.owner, reject_existing=True)
        ctx["audit"](scope.uid, "create", RULES_TYPE, rule_id, f"Created auto-reply rule {clean['name']}", {"ownerId": scope.owner})
        return _public(saved)

    @router.patch("/rules/{rule_id}")
    def update_rule(
        rule_id: str,
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, RULES_TYPE, rule_id, scope)
        owner_id = str(entity["data"].get("ownerId") or "")
        merged = {**entity["data"], **(body or {})}
        clean = {**_clean_rule(ctx, owner_id, merged), "updatedAt": _iso_now()}
        saved = ctx["patch_entity"](RULES_TYPE, entity["id"], clean, scope.uid)
        ctx["audit"](scope.uid, "update", RULES_TYPE, entity["id"], "Updated auto-reply rule", {"ownerId": owner_id})
        return _public(saved)

    @router.delete("/rules/{rule_id}")
    def delete_rule(
        rule_id: str,
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, RULES_TYPE, rule_id, scope)
        ctx["soft_delete_entity"](RULES_TYPE, entity["id"], scope.uid)
        ctx["audit"](scope.uid, "delete", RULES_TYPE, entity["id"], "Deleted auto-reply rule", {})
        return {"ok": True, "id": entity["id"]}

    # ---- pages ----------------------------------------------------------
    @router.get("/pages")
    def list_pages(ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        rows = sorted(_rows(PAGES_TYPE, scope.list_owner), key=lambda r: (int(r.get("createdAt") or 0), r["id"]))
        return {"pages": [_public(r) for r in rows]}

    @router.get("/pages/available")
    def available_pages(user: dict[str, Any] = Depends(current_user_dependency)):
        _require_admin(user)
        allowed, _left, _retry = check_rate_limit(f"social-studio:available:{user.get('id')}", 30, 60_000)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many Meta page lookups. Please wait a minute.")
        try:
            rows = _meta.get_meta_ads_client()._paged(
                "me/accounts",
                {"fields": "id,name,instagram_business_account{id,username}", "limit": 100},
                max_pages=10,
            )
        except _meta.MetaAdsError as error:
            raise _meta_http_error(error)
        linked = {
            (str(r["data"].get("metaPageId") or ""), str(r["data"].get("platform") or "")): str(r["data"].get("ownerId") or "")
            for r in _rows(PAGES_TYPE, None)
        }
        pages: list[dict[str, Any]] = []
        for row in rows:
            page_id = re.sub(r"\D", "", str(row.get("id") or ""))
            if not page_id:
                continue
            owner = linked.get((page_id, "fb"))
            pages.append({
                "metaPageId": page_id,
                "name": _meta._clean_text(row.get("name"), 120) or f"Page {page_id}",
                "platform": "fb",
                "alreadyLinked": owner is not None,
                "ownerId": owner or "",
            })
            ig = row.get("instagram_business_account")
            ig = ig if isinstance(ig, dict) else {}
            ig_id = re.sub(r"\D", "", str(ig.get("id") or ""))
            if ig_id:
                owner = linked.get((page_id, "ig"))
                pages.append({
                    "metaPageId": page_id,
                    "name": _meta._clean_text(ig.get("username"), 120) or f"Instagram {ig_id}",
                    "platform": "ig",
                    "igUserId": ig_id,
                    "alreadyLinked": owner is not None,
                    "ownerId": owner or "",
                })
        return {"pages": pages}

    @router.post("/pages/link")
    def link_page(body: dict[str, Any], request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        _require_admin(user)
        scope = _mutation(request, user, ctx)
        body = body or {}
        owner_id = ctx["validate_entity_id"](str(body.get("ownerId") or "").strip())
        if not _owner_exists(owner_id):
            raise HTTPException(status_code=404, detail="Unknown owner")
        meta_page_id = str(body.get("metaPageId") or "").strip()
        if not _DIGITS_RE.fullmatch(meta_page_id):
            raise HTTPException(status_code=400, detail="metaPageId must be the numeric Meta page id")
        platform = str(body.get("platform") or "fb").strip().lower()
        if platform not in PLATFORMS:
            raise HTTPException(status_code=400, detail="platform must be fb or ig")
        ig_user_id = str(body.get("igUserId") or "").strip()
        if platform == "ig" and not _DIGITS_RE.fullmatch(ig_user_id):
            raise HTTPException(status_code=400, detail="igUserId is required for an Instagram account")
        if platform == "fb":
            ig_user_id = ""
        for existing in _rows_where_json(PAGES_TYPE, "metaPageId", meta_page_id, limit=50):
            if str(existing["data"].get("platform") or "") == platform:
                raise HTTPException(status_code=409, detail="This page is already linked to an account")
        now = _iso_now()
        data = {
            "ownerId": owner_id,
            "metaPageId": meta_page_id,
            "name": _text_field(ctx, body.get("name"), "name", 120) or f"Page {meta_page_id}",
            "platform": platform,
            "igUserId": ig_user_id,
            "healthy": True,
            "linkedAt": now,
            "linkedBy": scope.uid,
            "createdAt": now,
            "updatedAt": now,
        }
        page_id = new_id("spg")
        saved = ctx["upsert_entity"](PAGES_TYPE, page_id, data, owner_id, reject_existing=True)
        ctx["audit"](scope.uid, "link", PAGES_TYPE, page_id, f"Linked {platform} page {meta_page_id}", {"ownerId": owner_id})
        return _public(saved)

    @router.post("/pages/{page_id}/unlink")
    def unlink_page(page_id: str, request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        _require_admin(user)
        scope = _mutation(request, user, ctx)
        entity = _load_owned(ctx, PAGES_TYPE, page_id, scope)
        ctx["soft_delete_entity"](PAGES_TYPE, entity["id"], scope.uid)
        ctx["audit"](scope.uid, "unlink", PAGES_TYPE, entity["id"], "Unlinked social page", {})
        return {"ok": True, "id": entity["id"]}

    # ---- stats ----------------------------------------------------------
    @router.get("/stats")
    def stats(ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        answered = dms = fb = ig = 0
        for entity in _rows(LOG_TYPE, scope.list_owner, limit=1000):
            data = entity["data"]
            at = _parse_iso(data.get("at"))
            actions = data.get("actions") or []
            if at is None or at < cutoff or not actions:
                continue
            answered += 1
            dms += 1 if "dm" in actions else 0
            if str(data.get("platform") or "") == "ig":
                ig += 1
            else:
                fb += 1
        published = queued = 0
        for entity in _lean_posts(scope.list_owner, limit=1000):
            data = entity["data"]
            status = str(data.get("status") or "")
            if status == "scheduled":
                queued += 1
            elif status == "published":
                at = _parse_iso(data.get("publishedAt"))
                if at is not None and at >= cutoff:
                    published += 1
        total = fb + ig
        fb_share = round(fb * 100 / total) if total else 50
        config = _meta.load_meta_ads_config()
        return {
            "last24h": {
                "commentsAnswered": answered,
                "dmsSent": dms,
                "postsPublished": published,
                "scheduledInQueue": queued,
                "fbShare": fb_share,
                "igShare": 100 - fb_share,
            },
            "updatedAt": _iso_now(),
            "connected": bool(config.configured),
            "webhookConfigured": bool(config.app_secret and config.webhook_verify_token),
        }

    # ---- posts ----------------------------------------------------------
    @router.get("/posts")
    def list_posts(
        status: str = Query(default="", max_length=20),
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _scope(user, ctx, ownerId)
        status = status.strip().lower()
        if status and status not in ("draft", "scheduled", "publishing", "published", "failed"):
            raise HTTPException(status_code=400, detail="Unknown post status")
        return {"posts": [_public(r) for r in _lean_posts(scope.list_owner, status)]}

    @router.get("/posts/{post_id}")
    def get_post(post_id: str, ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        return _public(_load_owned(ctx, POSTS_TYPE, post_id, scope))

    @router.post("/posts")
    def create_post(
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        now = _iso_now()
        clean = {
            **_clean_post(ctx, scope.owner, body or {}, None),
            "publishedAt": "", "results": [], "createdAt": now, "updatedAt": now,
        }
        post_id = new_id("spost")
        saved = ctx["upsert_entity"](POSTS_TYPE, post_id, clean, scope.owner, reject_existing=True)
        ctx["audit"](scope.uid, "create", POSTS_TYPE, post_id, f"Created social post ({clean['status']})", {"ownerId": scope.owner})
        return _public(saved)

    def _editable(entity: dict[str, Any]) -> None:
        if str(entity["data"].get("status") or "") not in POST_EDITABLE_STATUSES:
            raise HTTPException(status_code=409, detail="Only draft, scheduled or failed posts can be changed")

    @router.patch("/posts/{post_id}")
    def update_post(
        post_id: str,
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, POSTS_TYPE, post_id, scope)
        _editable(entity)
        owner_id = str(entity["data"].get("ownerId") or "")
        clean = {**_clean_post(ctx, owner_id, body or {}, entity["data"]), "updatedAt": _iso_now()}
        saved = ctx["patch_entity"](POSTS_TYPE, entity["id"], clean, scope.uid)
        ctx["audit"](scope.uid, "update", POSTS_TYPE, entity["id"], f"Updated social post ({clean['status']})", {})
        return _public(saved)

    @router.delete("/posts/{post_id}")
    def delete_post(
        post_id: str,
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, POSTS_TYPE, post_id, scope)
        _editable(entity)
        ctx["soft_delete_entity"](POSTS_TYPE, entity["id"], scope.uid)
        ctx["audit"](scope.uid, "delete", POSTS_TYPE, entity["id"], "Deleted social post", {})
        return {"ok": True, "id": entity["id"]}

    @router.post("/posts/{post_id}/publish")
    def publish_now(
        post_id: str,
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, POSTS_TYPE, post_id, scope)
        _editable(entity)
        if not _claim_post(ctx, entity, scope.uid):
            raise HTTPException(status_code=409, detail="The post changed while publishing. Refresh and try again.")
        return _public(publish_post(entity["id"], actor_id=scope.uid))

    @router.post("/posts/{post_id}/cancel")
    def cancel_post(
        post_id: str,
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        entity = _load_owned(ctx, POSTS_TYPE, post_id, scope)
        if str(entity["data"].get("status") or "") != "scheduled":
            raise HTTPException(status_code=409, detail="Only scheduled posts can be cancelled")
        saved = ctx["patch_entity"](POSTS_TYPE, entity["id"], {"status": "draft", "updatedAt": _iso_now()}, scope.uid)
        ctx["audit"](scope.uid, "cancel", POSTS_TYPE, entity["id"], "Cancelled scheduled social post", {})
        return _public(saved)

    # ---- public signed media (fetched by Meta) ---------------------------
    @router.get("/media/{post_id}/{index}")
    def media(post_id: str, index: str, request: Request, sig: str = Query(default="", max_length=128)):
        allowed, _left, _retry = check_rate_limit(f"social-studio:media:{_client_ip(request)}", 120, 60_000)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many requests")
        if not _SAFE_ID_RE.fullmatch(post_id) or not re.fullmatch(r"[0-3]", index or ""):
            raise HTTPException(status_code=404, detail="Not found")
        position = int(index)
        if not sig or not hmac.compare_digest(sig, media_signature(post_id, position)):
            raise HTTPException(status_code=404, detail="Not found")
        entity = ctx["get_entity"](POSTS_TYPE, post_id)
        if not entity or entity.get("deleted"):
            raise HTTPException(status_code=404, detail="Not found")
        items = [m for m in (entity["data"].get("media") or []) if isinstance(m, str)]
        if position >= len(items):
            raise HTTPException(status_code=404, detail="Not found")
        match = _DATA_URL_RE.fullmatch(items[position])
        if not match:
            raise HTTPException(status_code=404, detail="Not found")
        try:
            payload = base64.b64decode(match.group(2), validate=True)
        except (ValueError, TypeError):
            raise HTTPException(status_code=404, detail="Not found")
        kind = match.group(1).lower()
        media_type = "image/jpeg" if kind in ("jpg", "jpeg") else f"image/{kind}"
        return Response(
            content=payload,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
        )

    return router
