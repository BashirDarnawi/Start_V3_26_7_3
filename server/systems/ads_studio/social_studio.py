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

Albayan Studio redesign (PLAN.md stage P4; DECISIONS D9, D24b, D34):

* **P4-01 pages by ``pageRefs``.** A rule may name the socialPages rows (this owner's, on the
  rule's platform) it answers on; empty = every page. An unlinked page shows as "page removed"
  on the rule (``pages[].removed``) and the rule no longer fires there; linking the same Meta
  page to the same owner again revives the old row (same id), so the rule fires again.
* **P4-02 reply log.** ``GET /api/social-studio/log``: the owner's rows only (an admin may name an
  owner), paged, with counters by action and outcome and the ``receivedAt`` / ``sentAt`` /
  ``source`` latency; ``reply_latency_by_source()`` gives diagnostics the p95 per source. Each
  reply action is saved to its log row the moment Meta accepts it (``_reply_row``), so a server
  killed mid-reply never replays the whole rule.
* **P4-03 page health.** ``_set_page_health()`` is the one writer of ``healthState`` /
  ``healthReason`` / ``healthy``; ``health`` in the page list carries the bilingual label and fix
  step; ``check_page_health()`` reads the webhook subscription (subscribing on link and as a
  backfill while the platform's public replies are switched on), maps Meta's per-page refusals
  and runs the Instagram "comments not arriving" heuristic; ``run_page_health_pass()`` is the
  daily, budgeted turn; staff set ``instagram_private`` through ``POST /pages/{id}/health``.
* **P4-05 capability gates.** Once an admin saves the ``capabilities`` setting (the gates arm:
  ``capability_gates()``), the executor sends an action only on an ``on`` channel (``poll`` for
  Instagram public replies) and the log row records what was held and why; the rule editor
  refuses an action whose channel is ``off`` or ``unavailable``.
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
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import text

from ... import meta_ads as _meta
from ...startup_support import read_env_int
from ...db import db_conn, get_engine, json_dumps, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from ...auth_limits import _client_ip as _shared_client_ip
from ...security import constant_time_equal, new_id
from ...user_directory import access_row, user_exists
from .studio_types import STUDIO_ROUTER_ONLY_TYPES

SETTINGS_TYPE = "socialStudioSettings"
PAGES_TYPE = "socialPages"
RULES_TYPE = "socialReplyRules"
POSTS_TYPE = "socialPosts"
LOG_TYPE = "socialReplyLog"
# Router-only types: main.py's generic /api/collections refuses every one of them.
SOCIAL_STUDIO_COLLECTIONS = frozenset(
    {SETTINGS_TYPE, PAGES_TYPE, RULES_TYPE, POSTS_TYPE, LOG_TYPE}
) | STUDIO_ROUTER_ONLY_TYPES | {"adCampaignResults", "studioAlerts", "studioJobState"}  # + studio_results (P1-20), studio_jobs (P1-21) types

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
_STOP_JOINED = False  # the stop function ran once since the last start
_WORKER_THREAD: threading.Thread | None = None
_WORKER_LOCK = threading.Lock()
WORKER_INTERVAL_SECONDS = 20
_RETRY_TICK = 0
# P3-18b: while Albayan's Meta connection is down (studio_alerts_meta.py), a reply Meta refused for
# authorization is parked instead of lost. A private reply may still go out until 7 days after the
# comment (Meta's window), a public reply or a like until 24 hours after it (PLAN §7.4).
PARKED_REASON = "meta_connection_down"
MISSED_DURING_OUTAGE = "missed_during_outage"
PRIVATE_REPLY_WINDOW = timedelta(days=7)
PUBLIC_REPLY_WINDOW = timedelta(hours=24)

# ---------------------------------------------------------------------------
# P4-03 page health (PLAN §5.5 J7, §7.1 socialPages, §7.4 "Page health check")
# ---------------------------------------------------------------------------
# ``healthState`` / ``healthReason`` / ``healthy`` of a socialPages row are written only by
# _set_page_health(), so the classic dot (``healthy``) and the v2 health chip (``health``) agree.
PAGE_HEALTH_STATES = ("ok", "attention")
PAGE_HEALTH_REASONS = (
    "token_revoked", "page_role_lost", "permission_missing", "webhook_not_subscribed",
    "instagram_not_professional_or_unlinked", "instagram_private", "instagram_comments_not_arriving", "throttled",
)
# Reasons a reply or a check finds on its own; a later success or check clears them. The staff-set
# and heuristic Instagram reasons are cleared by a comment that arrives (or by staff).
REPLY_CLEARED_REASONS = frozenset({"token_revoked", "page_role_lost", "permission_missing", "throttled"})
IG_EVENT_CLEARED_REASONS = frozenset({"instagram_comments_not_arriving", "instagram_private"})
STAFF_SET_HEALTH_REASONS = ("instagram_private",)
TEAM_ACTION_REASONS = frozenset({"webhook_not_subscribed", "throttled"})  # nothing the customer can do
PAGE_THROTTLE_CODES = frozenset({"32", "80001", "80002", "80006"})  # Meta's page / IG / Messenger limits (PLAN §8.1)
PAGE_HEALTH_EVERY = timedelta(hours=24)  # the daily check per page (run_page_health_pass)
PAGE_HEALTH_PASS_EVERY_TICKS = 60  # about every 20 minutes of the worker (WORKER_INTERVAL_SECONDS)
PAGE_HEALTH_PASS_LIMIT = 5  # pages per pass (budgeted, PLAN §7.4)
IG_EVENT_SILENCE = timedelta(hours=24)  # comments_count grew over this long with no comment event
IG_EVENT_STAMP_EVERY = timedelta(minutes=10)  # igLastCommentEventAt is rewritten at most this often
IG_MEDIA_COUNTED = 10  # recent media whose comments_count the heuristic adds up
PAGE_HEALTH_OK_LABEL = {"en": "Working", "ar": "يعمل"}
PAGE_HEALTH_GENERIC_LABEL = {
    "label": {"en": "Needs attention", "ar": "يحتاج انتباهاً"},
    "fix": {"en": "Tell the team; they will check the page", "ar": "أبلغ الفريق ليفحص الصفحة"},
}
# When Albayan's own Meta connection is down (P3-18a) per-page reasons are suppressed: the neutral
# banner explains it (PLAN §5.5 J7).
PAGE_HEALTH_CONNECTION_LABEL = {
    "en": "Facebook and Instagram updates are delayed right now; page checks resume once the connection is back",
    "ar": "تحديثات فيسبوك وإنستغرام متأخرة حالياً؛ تعود فحوص الصفحات بعد عودة الاتصال",
}
PAGE_HEALTH_LABELS: dict[str, dict[str, dict[str, str]]] = {
    "token_revoked": {
        "label": {"en": "Albayan's access to this page stopped working", "ar": "توقف وصول البيان إلى هذه الصفحة"},
        "fix": {"en": "Share the page with Albayan again in Meta Business Suite, then tell the team",
                "ar": "شارك الصفحة مع البيان مرة أخرى من Meta Business Suite ثم أبلغ الفريق"},
    },
    "page_role_lost": {
        "label": {"en": "Albayan no longer has a role on this page", "ar": "لم يعد للبيان دور على هذه الصفحة"},
        "fix": {"en": "Give Albayan access to the page again in Meta Business Suite",
                "ar": "أعد منح البيان صلاحية الوصول إلى الصفحة من Meta Business Suite"},
    },
    "permission_missing": {
        "label": {"en": "A permission Albayan needs on this page is missing", "ar": "ينقص البيان إذن يحتاجه على هذه الصفحة"},
        "fix": {"en": "In Meta Business Suite, give Albayan full access to the page (content, messages and comments)",
                "ar": "من Meta Business Suite امنح البيان وصولاً كاملاً إلى الصفحة (المحتوى والرسائل والتعليقات)"},
    },
    "webhook_not_subscribed": {
        "label": {"en": "Comment notifications are not switched on for this page yet", "ar": "إشعارات التعليقات غير مفعّلة لهذه الصفحة بعد"},
        "fix": {"en": "The Albayan team switches them on; nothing to do on your side", "ar": "فريق البيان يفعّلها؛ لا شيء مطلوب منك"},
    },
    "instagram_not_professional_or_unlinked": {
        "label": {"en": "This Instagram account is not a professional account linked to a Facebook page",
                  "ar": "حساب إنستغرام هذا ليس حساباً احترافياً مربوطاً بصفحة فيسبوك"},
        "fix": {"en": "Switch the account to a business or creator account and link it to your Facebook page",
                "ar": "حوّل الحساب إلى حساب أعمال أو صانع محتوى واربطه بصفحة فيسبوك الخاصة بك"},
    },
    "instagram_private": {
        "label": {"en": "This Instagram account is private, so comments do not reach Albayan",
                  "ar": "حساب إنستغرام هذا خاص، لذلك لا تصل التعليقات إلى البيان"},
        "fix": {"en": "Make the account public in Instagram settings, then tell the team",
                "ar": "اجعل حسابك عاماً من إعدادات إنستغرام ثم أبلغ الفريق"},
    },
    "instagram_comments_not_arriving": {
        "label": {"en": "New comments on this Instagram account are not reaching Albayan",
                  "ar": "التعليقات الجديدة على حساب إنستغرام هذا لا تصل إلى البيان"},
        "fix": {"en": "First make sure the account is public in Instagram settings, then tell the team",
                "ar": "تأكد أولاً أن الحساب عام من إعدادات إنستغرام ثم أبلغ الفريق"},
    },
    "throttled": {
        "label": {"en": "Meta is limiting this page for a while; replies resume automatically",
                  "ar": "تحدّ ميتا من هذه الصفحة لفترة؛ تعود الردود تلقائياً"},
        "fix": {"en": "Nothing to do; the team is watching it", "ar": "لا شيء مطلوب؛ الفريق يتابع الأمر"},
    },
}
PAGE_REMOVED_LABEL = {"en": "Page removed", "ar": "الصفحة أُزيلت"}  # P4-01: a rule's page was unlinked

# ---------------------------------------------------------------------------
# P4-05 capability gates (PLAN §7.1 studioCapabilities, §8.2, §12.2 (c); DECISIONS D9, D24b, D34)
# ---------------------------------------------------------------------------
# Which capability switch (studio_settings ``capabilities``) each reply action of each platform
# needs. A like is public engagement, so it follows the public-reply switch; Instagram has no like.
CHANNEL_OF: dict[tuple[str, str], str] = {
    ("fb", "dm"): "fbPrivateReply", ("fb", "public"): "fbPublicReply", ("fb", "like"): "fbPublicReply",
    ("ig", "dm"): "igPrivateReply", ("ig", "public"): "igPublicReply",
}
CHANNEL_OPEN_STATES = frozenset({"on", "poll"})  # poll is accepted for igPublicReply only (studio_settings)
# The rule editor refuses an action whose channel is off or not available (D34: removed from the
# editor rather than shown as waiting); a gated one is saved and shown as waiting (D9), never sent.
EDITOR_REFUSED_STATES = frozenset({"off", "unavailable"})
CHANNEL_STATE_LABELS: dict[str, dict[str, str]] = {
    "on": {"en": "Working", "ar": "يعمل"},
    "poll": {"en": "Working, checked every 5 minutes", "ar": "يعمل — نفحص كل 5 دقائق"},
    "gated": {"en": "Waiting for Meta approval", "ar": "بانتظار موافقة ميتا"},
    "off": {"en": "Switched off", "ar": "متوقف"},
    "unavailable": {"en": "Not available now", "ar": "غير متاح حالياً"},
}
_ACTION_WORDS = {"dm": "Private messages", "public": "Public replies", "like": "Likes"}
_PLATFORM_WORDS = {"fb": "Facebook pages", "ig": "Instagram accounts"}

# ---------------------------------------------------------------------------
# P4-02 reply log (PLAN §7.1 socialReplyLog, §7.3 GET /api/social-studio/log)
# ---------------------------------------------------------------------------
LOG_PAGE_DEFAULT = 50
LOG_PAGE_MAX = 100
LOG_WINDOW_DAYS_DEFAULT = 30
LOG_WINDOW_DAYS_MAX = 90
LOG_WINDOW_ROWS_MAX = 5000  # the rows of one window read for the counters (newest first)
LOG_OUTCOMES = ("sent", "partial", "failed", "waiting", "parked", "missed", "skipped", "sending", "none")
LOG_OUTCOME_LABELS: dict[str, dict[str, str]] = {
    "sent": {"en": "Sent", "ar": "أُرسل"},
    "partial": {"en": "Partly sent", "ar": "أُرسل جزئياً"},
    "failed": {"en": "Failed", "ar": "فشل"},
    "waiting": {"en": "Waiting to retry", "ar": "بانتظار إعادة المحاولة"},
    "parked": {"en": "Waiting for the Meta connection", "ar": "بانتظار عودة ربط ميتا"},
    "missed": {"en": "Missed during the outage", "ar": "فات أثناء الانقطاع"},
    "skipped": {"en": "Not sent: channel not available", "ar": "لم يُرسل: القناة غير متاحة"},
    "sending": {"en": "Sending", "ar": "قيد الإرسال"},
    "none": {"en": "Nothing to send", "ar": "لا شيء للإرسال"},
}
_CURSOR_RE = re.compile(r"^(\d{1,15}):([A-Za-z0-9][A-Za-z0-9._:-]{0,79})$")
# The reply-log row the actions sent inside a _reply_row() block are saved to as each one succeeds
# (P4-02): a server killed mid-reply leaves the exact list behind, so nothing is ever replayed.
_REPLY_ROW: ContextVar[tuple[str, str] | None] = ContextVar("albayan_social_reply_row", default=None)


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


# Meta fetches a post's photos once, right when the post is created, so a
# signed link only needs to outlive that fetch (plus generous retry room).
MEDIA_URL_TTL_SECONDS = max(600, read_env_int("ALBAYAN_SOCIAL_MEDIA_URL_TTL_SECONDS", 172800))


def _unix_now() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def _media_signing_key() -> bytes:
    # A dedicated key derived from the app secret: the secret Meta trusts us
    # with is never used directly as the HMAC key for links we hand out.
    secret = (os.getenv("ALBAYAN_META_APP_SECRET") or "").strip() or _FALLBACK_MEDIA_SECRET
    return hmac.new(secret.encode("utf-8"), b"albayan:social-studio:media-url", hashlib.sha256).digest()


def media_signature(post_id: str, index: int, expires_at: int) -> str:
    message = f"{post_id}:{int(index)}:{int(expires_at)}".encode("utf-8")
    return hmac.new(_media_signing_key(), message, hashlib.sha256).hexdigest()


def media_public_url(post_id: str, index: int, *, expires_at: int | None = None) -> str:
    base = (os.getenv("ALBAYAN_PUBLIC_BASE_URL") or "https://albayanhub.com").strip().rstrip("/")
    exp = int(expires_at) if expires_at is not None else _unix_now() + MEDIA_URL_TTL_SECONDS
    return (
        f"{base}/api/social-studio/media/{post_id}/{int(index)}"
        f"?exp={exp}&sig={media_signature(post_id, index, exp)}"
    )


def _keyword_matches(keyword: str, normalized: str) -> bool:
    """Substring match, except that very short Latin keywords ("hi", "ok")
    must stand alone: "hi" inside "Benghazi" is not a greeting. Arabic
    prefixes (the keyword inside a longer word) stay substring matches."""
    if len(keyword) <= 3 and re.fullmatch(r"[a-z0-9]+", keyword):
        return re.search(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])", normalized) is not None
    return keyword in normalized


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
    already_replied_rule_ids: set[str] | None = None,
    page_id: str = "",
) -> dict[str, Any] | None:
    """Pick the first enabled rule that applies to a comment (pure, no I/O).

    ``post_ref`` is the Meta post/media id the comment belongs to, or a set of
    equivalent ids (Meta id + the matching socialPosts id) so a rule scoped to
    "chosen posts" can name either. ``already_replied_from_ids`` are commenters
    the page already answered automatically. Rules are checked in the order
    given; the caller passes them oldest-first so the first match wins.
    ``page_id`` is the socialPages row the comment came in on: a rule with
    ``pageRefs`` (P4-01) answers only on the pages it names; an empty list
    means every page (rules from before pageRefs).
    """
    if not _bool((settings or {}).get("masterEnabled"), True):
        return None
    refs = {post_ref} if isinstance(post_ref, str) else {str(x) for x in (post_ref or [])}
    refs.discard("")
    normalized = normalize_text(text)
    quiet = (settings or {}).get("quietHours") or {}
    replied = {str(x) for x in (already_replied_from_ids or set())}
    # "Once per person" is per RULE: a generic thank-you must not use up the
    # person's one price reply.
    replied_rules = {str(x) for x in (already_replied_rule_ids or set())}
    for rule in rules:
        if not isinstance(rule, dict) or not _bool(rule.get("enabled"), True):
            continue
        if str(rule.get("platform") or "") != platform:
            continue
        page_refs = [str(x) for x in (rule.get("pageRefs") or []) if str(x or "")]
        if page_refs and str(page_id or "") not in page_refs:
            continue
        if str(rule.get("scope") or "all") == "chosen":
            wanted = {str(x) for x in (rule.get("postIds") or []) if str(x or "")}
            if not (wanted & refs):
                continue
        if str(rule.get("trigger") or "every") == "keywords":
            keywords = [normalize_text(k) for k in (rule.get("keywords") or [])]
            if not any(keyword and _keyword_matches(keyword, normalized) for keyword in keywords):
                continue
        if _bool(rule.get("oncePerPerson")) and (
            str(from_id or "") in replied
            or "*" in replied_rules
            or str(rule.get("id") or "") in replied_rules
        ):
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


def _public(
    entity: dict[str, Any], user: dict[str, Any], *, connection_down: bool = False,
    pages: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One row as ``user`` may see it: through studio_privacy.redact_staff_identity (P1-05), so a
    customer never gets a staff id (a page's ``linkedBy`` admin becomes 'team'); staff see it as is.

    A page carries its ``health`` view (P4-03; ``connection_down`` swaps the per-page reason for
    the neutral connection text) and ``healthy`` derived from the same stored state; a rule carries
    ``pages``, one entry per ``pageRefs`` id with ``removed`` for an unlinked page (P4-01; ``pages``
    = the owner's live pages by id when the caller already has them)."""
    from .studio_privacy import redact_staff_identity  # late: studio_privacy imports this module

    data = {k: v for k, v in (entity.get("data") or {}).items() if k not in _PRIVATE_KEYS}
    data["id"] = str(entity.get("id") or data.get("id") or "")
    data["lastModified"] = int(entity.get("lastModified") or 0)
    entity_type = str(entity.get("type") or "")
    if entity_type == PAGES_TYPE:
        data["health"] = page_health_view(data, connection_down=connection_down)
        data["healthy"] = page_health_state(data)[0] == "ok"
    elif entity_type == RULES_TYPE:
        refs = [str(r) for r in (data.get("pageRefs") or []) if str(r or "")]
        data["pageRefs"] = refs
        data["pages"] = _rule_pages_view(refs, str(data.get("ownerId") or ""), pages)
        data["pageRemoved"] = any(p["removed"] for p in data["pages"])
        data["pageRemovedLabel"] = dict(PAGE_REMOVED_LABEL) if data["pageRemoved"] else None
    return redact_staff_identity(data, user)


def _rule_pages_view(refs: list[str], owner_id: str, live: dict[str, dict[str, Any]] | None) -> list[dict[str, Any]]:
    """P4-01: what a rule's ``pageRefs`` point at now. ``removed``: the page was unlinked (or is
    another owner's): the rule no longer fires there and the screen shows «الصفحة أُزيلت»."""
    out: list[dict[str, Any]] = []
    for ref in refs:
        page = (live or {}).get(ref)
        if page is None and _SAFE_ID_RE.fullmatch(ref):
            page = _ctx()["get_entity"](PAGES_TYPE, ref)
        data = (page or {}).get("data") or {}
        removed = not page or bool(page.get("deleted")) or str(data.get("ownerId") or "") != owner_id
        out.append({
            "id": ref, "removed": removed,
            "name": str(data.get("name") or "") if page and str(data.get("ownerId") or "") == owner_id else "",
            "platform": str(data.get("platform") or "") if page and str(data.get("ownerId") or "") == owner_id else "",
        })
    return out


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


def _unlinked_page_row(owner_id: str, platform: str, meta_page_id: str) -> Any:
    """The owner's most recently unlinked (soft-deleted) row for this Meta page and platform, or None."""
    sql = json_fields_select_sql(("metaPageId", "platform", "ownerId"), ("id", "created_at", "last_modified"),
                                 "type = :type AND deleted = true AND created_by = :owner")
    with db_conn() as conn:
        rows = conn.execute(text(sql), {"type": PAGES_TYPE, "owner": owner_id}).mappings().all()
    matches = [
        row for row in rows
        if str(row.get("f_metapageid") or "") == meta_page_id and str(row.get("f_platform") or "") == platform
        and str(row.get("f_ownerid") or "") == owner_id
    ]
    return max(matches, key=lambda row: (int(row["last_modified"] or 0), str(row["id"]))) if matches else None


def _revive_unlinked_page(
    ctx: dict[str, Any], owner_id: str, platform: str, meta_page_id: str, data: dict[str, Any]
) -> dict[str, Any] | None:
    """P4-01: link the same Meta page to the same owner again on its OLD row (same id, fresh data),
    so the rules whose ``pageRefs`` name it fire again. main's upsert never revives a soft-deleted
    row (a late PATCH must not resurrect a record), so this is one conditional UPDATE on this
    system's own type. None when the owner never had that page (a new row is made)."""
    row = _unlinked_page_row(owner_id, platform, meta_page_id)
    if row is None:
        return None
    page_id = str(row["id"])
    baseline = int(row["last_modified"] or 0)
    stamp = max(now_ms(), baseline + 1)
    full = ctx["sanitize_json"]({**data, "id": page_id, "_created": int(row["created_at"] or stamp), "createdBy": owner_id, "_lastModified": stamp})
    with db_conn() as conn:
        result = conn.execute(
            text(
                "UPDATE entities SET deleted = false, data_json = :data, last_modified = :stamp "
                "WHERE type = :type AND id = :id AND deleted = true AND last_modified = :baseline"
            ),
            {"data": json_dumps(full), "stamp": stamp, "type": PAGES_TYPE, "id": page_id, "baseline": baseline},
        )
    if int(result.rowcount or 0) != 1:
        raise HTTPException(status_code=409, detail="This page is already linked to an account")  # someone linked it first
    return ctx["get_entity"](PAGES_TYPE, page_id)


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
        return user_exists(conn, owner_id)


def _owner_can_automate(owner_id: str) -> bool:
    """Background work must use current account access, not its creation-time grant."""
    if not owner_id:
        return False
    with db_conn() as conn:
        row = access_row(conn, owner_id)
    if not row:
        return False
    # Match the internal auth identity shape, including permissions_json for
    # the existing staff-reviewer exemption; public API user shapes differ.
    return bool(_ctx()["has_ad_maker_subscription"](row))


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


# What decides which comments a rule answers: a change to any of them (or switching the rule on)
# moves its ``activeSince`` to now, so a comment Albayan reads later is answered only by rules that
# already applied to it when it was written. pageRefs (P4-01) is a list a rule from before it lacks.
RULE_MATCH_FIELDS = ("platform", "scope", "postIds", "trigger", "keywords", "pageRefs")


def _match_fields_changed(old: dict[str, Any], clean: dict[str, Any]) -> bool:
    for field in RULE_MATCH_FIELDS:
        before, after = old.get(field), clean.get(field)
        if isinstance(after, list):
            before = list(before or [])
        if before != after:
            return True
    return False


def capability_gates() -> dict[str, str] | None:
    """P4-05: the reply channels' states (fbPublicReply, fbPrivateReply, igPublicReply,
    igPrivateReply: on/poll/gated/off/unavailable) once an admin has saved the ``capabilities``
    setting, or None while it was never saved.

    The gates ARM with that first save (PLAN §12.2 switch (c)): until then the classic Social
    Studio keeps sending every action a rule asks for, as it does today, so a dark deploy of the
    redesign never switches off replies that already work. Saved once, the executor sends only on
    an open channel and the editor refuses what a channel cannot do.
    """
    from .studio_settings import read_setting  # late: studio_settings loads before this module's router

    record = read_setting("capabilities")
    if int(record.get("version") or 0) < 1:
        return None
    value = record.get("value") or {}
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


def channel_state(gates: dict[str, str] | None, platform: str, kind: str) -> str | None:
    """None when the action may be sent (gates not armed, an open state, or an action without a
    channel); else the closed state (gated / off / unavailable) the log row records."""
    if gates is None:
        return None
    channel = CHANNEL_OF.get((str(platform or ""), str(kind or "")))
    if channel is None:
        return None
    state = str(gates.get(channel) or "")
    if state == "poll" and channel != "igPublicReply":
        state = "gated"  # poll means "read by polling": only Instagram public replies work that way
    return None if state in CHANNEL_OPEN_STATES else (state or "unavailable")


def webhook_wanted(platform: str, gates: dict[str, str] | None) -> bool:
    """P4-03: whether Albayan's app should be subscribed to the page's webhook: the platform's public
    replies are switched ``on`` (webhook delivery). ``poll`` reads Instagram itself, and while the
    gates are not armed (or the channel waits) no subscribe call is made."""
    if gates is None:
        return False
    channel = "fbPublicReply" if str(platform or "") == "fb" else "igPublicReply"
    return str(gates.get(channel) or "") == "on"


def editor_refusal(platform: str, kind: str) -> str:
    """The stable English refusal of the rule editor (its Arabic lives in the client map)."""
    return f"{_ACTION_WORDS[kind]} are not available for {_PLATFORM_WORDS[platform]} right now"


def rule_active_since_ms(rule: dict[str, Any]) -> int:
    """Since when (ms) the rule has applied as it is: max(_created, activeSince); a rule from before
    activeSince has only _created. 0 = unknown creation (such a rule never answers a read comment)."""
    def ms(value: Any) -> int:
        try:
            return max(int(float(value or 0)), 0)
        except (TypeError, ValueError, OverflowError):
            return 0

    created = ms(rule.get("_created"))
    return max(created, ms(rule.get("activeSince"))) if created else 0


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
    like_comment = _bool(raw.get("likeComment"))
    if trigger == "keywords" and not keywords:
        raise HTTPException(status_code=400, detail="Add at least one keyword for a keyword rule")
    if scope == "chosen" and not post_ids:
        raise HTTPException(status_code=400, detail="Choose at least one post for a chosen-posts rule")
    if not public_reply and not (dm_enabled and dm_text):
        raise HTTPException(status_code=400, detail="A rule needs a public reply or a private message")
    # P4-01: the pages the rule answers on, by socialPages row id; each must be a live page of this
    # owner on the rule's platform. Empty = every page (rules from before pageRefs).
    page_refs: list[str] = []
    for ref in _string_list(raw.get("pageRefs"), "pageRefs", max_items=MAX_POST_PAGES, max_chars=80):
        page = ctx["get_entity"](PAGES_TYPE, ctx["validate_entity_id"](ref))
        if not page or page.get("deleted") or str(page["data"].get("ownerId") or "") != owner_id:
            raise HTTPException(status_code=400, detail=f"Page {ref} is not linked to this account")
        if str(page["data"].get("platform") or "") != platform:
            raise HTTPException(status_code=400, detail=f"Page {ref} is not on this rule's platform")
        page_refs.append(ref)
    # P4-05: an action its channel cannot do is refused here, with the reason; a gated one is
    # saved and shown as waiting for Meta, and the executor holds it (channel_state).
    gates = capability_gates()
    wanted = [("dm", dm_enabled and bool(dm_text)), ("public", bool(public_reply)), ("like", like_comment)]
    for kind, asked in wanted:
        if asked and channel_state(gates, platform, kind) in EDITOR_REFUSED_STATES:
            raise HTTPException(status_code=400, detail=editor_refusal(platform, kind))
    return {
        "ownerId": owner_id,
        "name": name,
        "platform": platform,
        "enabled": _bool(raw.get("enabled"), True),
        "scope": scope,
        "postIds": post_ids,
        "pageRefs": page_refs,
        "trigger": trigger,
        "keywords": keywords,
        "publicReply": public_reply,
        "dmEnabled": dm_enabled,
        "dmText": dm_text,
        "likeComment": like_comment,
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
        "publishAttempts": 0,
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


def publish_post(post_id: str, *, actor_id: str = "", from_scheduler: bool = False) -> dict[str, Any]:
    """publish_post with one guarantee: an unexpected error never leaves the post claimed."""
    holder: list[dict[str, Any]] = []
    try:
        return _publish_post_inner(post_id, actor_id=actor_id, from_scheduler=from_scheduler, _results_holder=holder)
    except HTTPException:
        raise
    except Exception:
        _mark_publish_interrupted(post_id, actor_id, "Publishing was interrupted by a server error; check the page before retrying.",
                                  results=holder or None)
        raise


def _publish_post_inner(post_id: str, *, actor_id: str = "", from_scheduler: bool = False,
                        _results_holder: list[dict[str, Any]] | None = None) -> dict[str, Any]:
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
    if not _owner_can_automate(owner_id):
        # Keep the draft, media and any earlier successful results for an
        # explicit retry after renewal. Never silently publish overdue work.
        return ctx["patch_entity"](POSTS_TYPE, post_id, {
            "status": "failed", "updatedAt": _iso_now(),
            "lastError": "Publishing paused: the owner's account needs active Social Studio access.",
        }, actor_id or owner_id)
    previous = {
        str(r.get("pageId") or ""): r
        for r in (data.get("results") or [])
        if isinstance(r, dict) and r.get("metaPostId") and not r.get("error")
    }
    client: Any = None
    client_error = ""
    client_error_retryable = False
    try:
        client = _meta.get_meta_ads_client()
    except _meta.MetaAdsError as error:
        client_error = error.public_message
        client_error_retryable = bool(error.retryable)
    results: list[dict[str, Any]] = _results_holder if _results_holder is not None else []  # visible to the wrapper on a crash
    errors: list[str] = []
    _current_ids = {str(p) for p in (data.get("pageIds") or [])}
    for _prev_id, _prev in previous.items():
        if _prev_id not in _current_ids:
            results.append({**_prev, "removed": True})  # unticked, but live on Meta: its id travels with every durable write
    for page_id in [str(p) for p in (data.get("pageIds") or [])]:
        if page_id in previous:
            results.append({**previous[page_id], "removed": False})
            continue
        result = {"pageId": page_id, "metaPostId": "", "error": ""}
        page = ctx["get_entity"](PAGES_TYPE, page_id) if _SAFE_ID_RE.fullmatch(page_id) else None
        if client is None:
            result["error"] = client_error
            result["retryable"] = client_error_retryable
        elif not page or page.get("deleted") or str(page["data"].get("ownerId") or "") != owner_id:
            result["error"] = "This page is no longer linked to the account."
        else:
            page_reason = ""
            try:
                result["metaPostId"] = _publish_to_page(client, page["data"], post_id, data)
            except _meta.MetaAdsError as error:
                # A timeout on the create call is AMBIGUOUS: Meta may have
                # published; a blind retry duplicated posts. Ask a human.
                ambiguous = error.code == "timeout"  # sent but unanswered; a connect failure ("network") is a normal retry
                result["error"] = "Meta did not answer in time; it may have published. Check the page before retrying." if ambiguous else error.public_message
                result["retryable"] = bool(error.retryable) and not ambiguous
                page_reason = page_problem_reason(error)
            except Exception as error:  # never leak tokens/stack traces into rows
                result["error"] = f"Publishing failed ({type(error).__name__})."
            # The one health writer (P4-03): a per-page refusal marks the page, a success clears it.
            _page_health_after_meta({**page["data"], "id": page_id}, page_reason, succeeded=bool(result["metaPostId"]))
        if result["error"]:
            errors.append(result["error"])
        results.append(result)
        if result.get("metaPostId"):
            try:  # durable at once: a kill before the final write must not let a retry post this page twice
                ctx["patch_entity"](POSTS_TYPE, post_id, {"results": [dict(r) for r in results], "updatedAt": _iso_now(), "publishingSince": _iso_now()}, owner_id)  # heartbeat: a long multi-page publish is not "stuck"
            except Exception:
                pass
    now = _iso_now()
    # A manual "Publish now" starts a fresh retry budget.
    attempts = (int(data.get("publishAttempts") or 0) if from_scheduler else 0) + 1
    temporary_only = bool(errors) and all(bool(r.get("retryable")) for r in results if r.get("error"))
    if from_scheduler and temporary_only and attempts < 6:
        # A temporary Meta condition (pause, outage) must not turn a scheduled
        # post into a permanent failure: keep it scheduled a little later.
        delay_minutes = min(240, 5 * (2 ** (attempts - 1)))
        updates: dict[str, Any] = {
            "results": results,
            "status": "scheduled",
            "scheduledAt": _iso_at(datetime.now(timezone.utc) + timedelta(minutes=delay_minutes)),
            "publishAttempts": attempts,
            "lastError": errors[0],
            "updatedAt": now,
        }
    else:
        updates = {
            "results": results,
            "status": "published" if not errors else "failed",
            "lastError": "" if not errors else errors[0],
            "publishAttempts": attempts,
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
            {"status": "publishing", "publishingSince": _iso_now(), "updatedAt": _iso_now()},
            actor_id,
            expected_last_modified=int(entity.get("lastModified") or 0),
        )
    except HTTPException as error:
        if error.status_code in (404, 409):
            return False
        raise
    return True


def _due_scheduled_posts(now: datetime, limit: int) -> list[dict[str, Any]]:
    """Scan compact keyset batches so future posts cannot hide due work.

    Parse dates in Python to retain support for historical timezone offsets.
    The publishing claim needs metadata only; media is loaded after claiming.
    """
    if limit <= 0:
        return []
    due = []
    cursor_created, cursor_id = -1, ""
    while True:
        with db_conn() as conn:
            rows = conn.execute(text(
                "SELECT type,id,deleted,created_at,created_by,last_modified, "
                f"{_json_field('scheduledAt')} AS scheduled_at, {_json_field('ownerId')} AS owner_id "
                "FROM entities WHERE type=:type AND deleted=false "
                f"AND {_json_field('status')}=:status "
                "AND (created_at>:cursor_created OR (created_at=:cursor_created AND id>:cursor_id)) "
                "ORDER BY created_at ASC,id ASC LIMIT 500"
            ), {"type": POSTS_TYPE, "status": "scheduled", "cursor_created": cursor_created,
                "cursor_id": cursor_id}).mappings().all()
        for row in rows:
            scheduled_at = _parse_iso(row["scheduled_at"])
            if scheduled_at is not None and scheduled_at <= now:
                entity = _entity_from_row(row)
                entity["data"] = {"ownerId": row["owner_id"], "scheduledAt": row["scheduled_at"], "status": "scheduled"}
                due.append(entity)
                if len(due) >= limit:
                    return due
        if len(rows) < 500:
            break
        cursor_created, cursor_id = int(rows[-1]["created_at"]), str(rows[-1]["id"])
    return due


def _mark_publish_interrupted(post_id: str, actor_id: str, message: str, results: list[dict[str, Any]] | None = None) -> None:
    """A post must never stay claimed as ``publishing`` forever (a redeploy or a
    server error mid-publish used to leave it without any button). Page ids
    already obtained travel with it so a retry never posts them twice."""
    try:
        patch: dict[str, Any] = {"status": "failed", "lastError": message, "updatedAt": _iso_now()}
        if results:
            patch["results"] = [dict(r) for r in results if isinstance(r, dict)]
        _ctx()["patch_entity"](POSTS_TYPE, post_id, patch, actor_id or "system")
    except Exception:
        pass


def _recover_stuck_publishing(now: datetime, limit: int = 50) -> int:
    """Release claims the worker never finished (process killed mid-publish)."""
    cutoff = _iso_at(now - timedelta(minutes=15))
    with db_conn() as conn:
        rows = conn.execute(
            text(
                f"SELECT id, {_json_field('ownerId')} AS owner_id FROM entities WHERE type=:type AND deleted=false "
                f"AND {_json_field('status')}='publishing' AND COALESCE({_json_field('publishingSince')}, {_json_field('updatedAt')}, '') < :cutoff LIMIT :limit"
            ),
            {"type": POSTS_TYPE, "cutoff": cutoff, "limit": max(1, int(limit))},
        ).mappings().all()
    for row in rows:
        _mark_publish_interrupted(str(row["id"]), str(row.get("owner_id") or ""), "Publishing was interrupted (the server restarted); check the page before retrying.")
    return len(rows)


def run_scheduler_tick(*, now: datetime | None = None, limit: int = 20) -> int:
    """Publish every due scheduled post once. Returns how many were attempted."""
    ctx = _ctx()
    current = now or datetime.now(timezone.utc)
    attempted = 0
    try:
        _recover_stuck_publishing(current)
    except Exception:
        print("[albayan] Social Studio stuck-claim recovery failed; it will retry.")
    for entity in _due_scheduled_posts(current, limit):
        owner_id = str(entity["data"].get("ownerId") or "")
        if not _claim_post(ctx, entity, owner_id):
            continue  # another worker generation/process took it
        attempted += 1
        try:
            publish_post(entity["id"], actor_id=owner_id, from_scheduler=True)
        except Exception as error:
            print(f"[albayan] Social Studio publish failed for {entity['id']} ({type(error).__name__}).")
    # The retry pass scans the reply log; every sixth tick (about two minutes)
    # is plenty for delays that start at fifteen minutes.
    global _RETRY_TICK
    _RETRY_TICK += 1
    if _RETRY_TICK % 6 == 1:
        try:
            _retry_pending_replies(current)
        except Exception:
            print("[albayan] Social Studio reply retry pass failed; it will retry.")
    # P4-03: the daily page check, a few pages at a time, about every 20 minutes (a no-op until the
    # capability gates are armed). The studio jobs loop may take this turn over (run_page_health_pass).
    if _RETRY_TICK % PAGE_HEALTH_PASS_EVERY_TICKS == 2:
        try:
            run_page_health_pass(current)
        except Exception:
            print("[albayan] Social Studio page health pass failed; it will retry.")
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
    global _STOP_JOINED
    _STOP_JOINED = False
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
    global _WORKER_THREAD, _STOP_JOINED
    with _WORKER_LOCK:
        thread = _WORKER_THREAD
        if _STOP_JOINED:
            return  # already stopped once; the second hook must not pay the join again
        _WORKER_STOP.set()
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=1)
    with _WORKER_LOCK:
        _STOP_JOINED = True
        if _WORKER_THREAD is thread and not (thread and thread.is_alive()):
            _WORKER_THREAD = None  # a live thread stays known so a restart cannot overlap it


def _find_page(platform: str, entry_id: str) -> dict[str, Any] | None:
    field = "metaPageId" if platform == "fb" else "igUserId"
    for entity in _rows_where_json(PAGES_TYPE, field, entry_id, limit=50):
        if str(entity["data"].get("platform") or "") == platform:
            return entity
    return None


def _log_id(owner_id: str, platform: str, comment_id: str) -> str:
    digest = hashlib.sha256(f"{owner_id}:{platform}:{comment_id}".encode("utf-8")).hexdigest()
    return f"srl_{digest[:32]}"


@contextmanager
def _comment_reservation_guard(owner_id: str):
    """Serialize rule selection and durable reservation, never the Meta call."""
    with _COMMENT_LOCK:
        if str(get_engine().dialect.name or "") == "postgresql":
            with db_conn() as conn:
                _ctx()["lock_idempotency_key"](
                    conn, owner_id, postgres=True, namespace="socialReplyReservation"
                )
                yield
        else:
            yield


def _person_replied_rule_ids(owner_id: str, page_id: str, from_id: str) -> set[str]:
    """Rules that already answered this person on this page (full history).

    Only a sent DM or public reply (or a reply still in flight) counts; a
    bare like is not an answer."""
    found: set[str] = set()
    with db_conn() as conn:
        params = {"type": LOG_TYPE, "owner": owner_id, "page": page_id, "person": from_id, "after": ""}
        query = text(
            f"SELECT id, {_json_field('actions')} AS actions, {_json_field('processing')} AS processing, "
            f"{_json_field('ruleId')} AS rule_id, {_json_field('retryAfter')} AS retry_after "
            f"FROM entities WHERE type=:type AND deleted=false AND created_by=:owner "
            f"AND {_json_field('ownerId')}=:owner AND {_json_field('pageId')}=:page "
            f"AND {_json_field('fromId')}=:person AND id>:after ORDER BY id ASC LIMIT 100"
        )
        # Bounded Python memory even for very old, busy accounts. The database
        # returns only action metadata for the relevant person, never comments.
        while rows := conn.execute(query, params).mappings().all():
            for row in rows:
                actions = row["actions"]
                if isinstance(actions, str):
                    try:
                        actions = json_loads(actions)
                    except ValueError:
                        actions = []
                answered = _bool(row["processing"]) or bool(row["retry_after"]) or (
                    isinstance(actions, list) and any(str(a) in ("dm", "public") for a in actions)
                )
                if answered:
                    # History rows written before replies carried a rule id
                    # keep their old page-wide meaning ("*" = every rule).
                    found.add(str(row["rule_id"] or "") or "*")
            params["after"] = rows[-1]["id"]
    return found


def _has_person_reply(owner_id: str, page_id: str, from_id: str) -> bool:
    """Check this person's full history, not the latest 1,000 display rows."""
    return bool(_person_replied_rule_ids(owner_id, page_id, from_id))


def _iso_at(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _retry_after_iso(attempt: int) -> str:
    """15 min, 30 min, 1 h, 2 h, 4 h ... after a temporary Meta problem."""
    minutes = min(240, 15 * (2 ** max(0, int(attempt) - 1)))
    return _iso_at(datetime.now(timezone.utc) + timedelta(minutes=minutes))


class _ReplyOutcome(tuple):
    """What _execute_rule_actions returns: (actions, errors, retryable), plus ``auth_codes``, Meta's
    codes of the authorization refusals among the failures, ``auth_failed_at``, when the first one
    came, ``timed_out``, the actions whose send timed out and so may have landed (P3-18b),
    ``skipped``, the actions a capability gate held back (P4-05: ``{action, channel, state}``
    each), and ``sent_at``, when Meta accepted the first action (P4-02 latency). A plain 3-tuple
    (a test's stand-in) has none."""

    auth_codes: tuple[str, ...] = ()
    auth_failed_at: datetime | None = None
    timed_out: tuple[str, ...] = ()
    skipped: tuple[dict[str, str], ...] = ()
    sent_at: str = ""

    @classmethod
    def of(
        cls, actions: list[str], errors: list[str], retryable: bool, auth_codes: list[str],
        auth_failed_at: datetime | None = None, timed_out: list[str] | None = None,
        skipped: list[dict[str, str]] | None = None, sent_at: str = "",
    ) -> "_ReplyOutcome":
        outcome = cls((actions, errors, retryable))
        outcome.auth_codes = tuple(auth_codes)
        outcome.auth_failed_at = auth_failed_at
        outcome.timed_out = tuple(timed_out or ())
        outcome.skipped = tuple(dict(item) for item in (skipped or ()))
        outcome.sent_at = str(sent_at or "")
        return outcome


@contextmanager
def _reply_row(log_id: str, owner_id: str):
    """P4-02: the reply-log row the actions sent inside this block are saved to as each succeeds."""
    marker = _REPLY_ROW.set((str(log_id or ""), str(owner_id or "")))
    try:
        yield
    finally:
        _REPLY_ROW.reset(marker)


def _save_sent_actions(actions: list[str], sent_at: str) -> None:
    """Write the actions sent so far to the reply-log row of the surrounding _reply_row() block (none:
    nothing to do). Best effort: the final write repeats it, and a failure here never undoes a reply
    Meta already accepted; what it buys is that a process killed after this write never resends."""
    row = _REPLY_ROW.get()
    if not row or not row[0]:
        return
    try:
        _ctx()["patch_entity"](LOG_TYPE, row[0], {"actions": list(actions), "sentAt": sent_at}, row[1] or "system")
    except Exception:
        pass


def page_problem_reason(error: Any) -> str:
    """P4-03: the page health reason a Meta refusal stands for, or '' (a global problem, P3-18a, or
    an ordinary failure): 190.460 (the token was revoked, e.g. a password change) -> token_revoked;
    190.492 (the page role was lost) or no page token at all -> page_role_lost; the permission
    family (3, 10, 200-299) -> permission_missing; one of Meta's PAGE-scoped limits (32, 80001,
    80002, 80006; PLAN §8.1) -> throttled (an app-wide limit is not the page's problem)."""
    code = str(getattr(error, "code", "") or "")
    provider = str(getattr(error, "provider_code", "") or "").strip()
    major, _dot, sub = provider.partition(".")
    if code == "authorization":
        if not major:
            return "page_role_lost"
        if major == "190":
            return {"460": "token_revoked", "492": "page_role_lost"}.get(sub, "")
        if major in {"3", "10"} or (major.isdigit() and 200 <= int(major) <= 299):
            return "permission_missing"
        return ""
    if code == "rate_limited" and major in PAGE_THROTTLE_CODES:
        return "throttled"
    return ""


def _dm_pending(rule: dict[str, Any], actions: list[str]) -> bool:
    """The rule still owes this comment a private reply."""
    return (
        "dm" not in actions and _bool(rule.get("dmEnabled")) and bool(str(rule.get("dmText") or ""))
        and not _bool(rule.get("pauseDms"))
    )


def _comment_time(data: dict[str, Any], now: datetime) -> datetime:
    return _parse_iso(data.get("commentAt")) or _parse_iso(data.get("at")) or now


def _missed_patch() -> dict[str, Any]:
    """A parked reply whose window passed during the outage: finished, visible in the log."""
    return {
        "retryAfter": "", "parkedReason": "", "problemCode": MISSED_DURING_OUTAGE,
        "error": f"{MISSED_DURING_OUTAGE}: the reply window passed while Albayan's Meta connection was down.",
    }


_REPLY_ACTIONS = ("dm", "public", "like")


def _skip_actions(value: Any) -> set[str]:
    """``skipActions`` of a reply-log row: the actions never sent again (their send timed out)."""
    return {str(kind) for kind in value if str(kind) in _REPLY_ACTIONS} if isinstance(value, list) else set()


def _without_actions(rule: dict[str, Any], skip: set[str]) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    if "dm" in skip:
        changes["dmEnabled"] = False
    if "public" in skip:
        changes["publicReply"] = ""
    if "like" in skip:
        changes["likeComment"] = False
    return {**rule, **changes} if changes else rule


def _parked_patch(
    outcome: Any, data: dict[str, Any], rule: dict[str, Any], now: datetime, verdict: str | None = None,
) -> dict[str, Any] | None:
    """P3-18b: how a reply Meta refused for authorization keeps waiting, or None (it is not parked).

    Any authorization refusal runs the token check (studio_alerts_meta.after_authorization_failure: at
    most one Meta call per 10 minutes) unless the caller already has its ``verdict``. The reply is
    parked when that check leaves the connection DOWN, or has no verdict on this refusal yet
    (``pending``: e.g. a saved "valid" reading from before the token died), nothing was sent, and a
    refusal is not a per-page one (190.492 page role lost, the permission codes: those stay per-page
    problems). Parked = ``parkedReason`` meta_connection_down, ``retryAfter`` the next check,
    ``giveUpAt`` the comment's time + 7 days while a private reply is owed, else + 24 hours; a reply
    already past that window is finished as missed_during_outage. A pending one also keeps
    ``authCheckPendingSince`` (the refusal's time): the retry pass checks again before resending. An
    action whose send timed out may have landed: it goes into ``skipActions`` and is never resent.
    """
    codes = tuple(getattr(outcome, "auth_codes", ()) or ())
    if not codes:
        return None
    from . import studio_alerts_meta  # late: it imports this module

    failed_at = getattr(outcome, "auth_failed_at", None) or datetime.now(timezone.utc)
    if verdict is None:
        try:
            verdict = studio_alerts_meta.after_authorization_failure(failed_at)
        except Exception as error:  # the webhook path never raises: without a verdict nothing is parked
            print(f"[albayan] Social Studio connection check failed ({type(error).__name__}).")
            return None
    actions = list(outcome[0] or [])
    if verdict not in ("down", "pending") or actions or all(
        studio_alerts_meta.is_per_page_auth_code(code) for code in codes
    ):
        return None
    skip = _skip_actions(data.get("skipActions")) | set(getattr(outcome, "timed_out", ()) or ())
    window = PRIVATE_REPLY_WINDOW if _dm_pending(_without_actions(rule, skip), actions) else PUBLIC_REPLY_WINDOW
    give_up = _comment_time(data, now) + window
    if now >= give_up:
        return _missed_patch()
    patch = {
        "parkedReason": PARKED_REASON,
        "retryAfter": _iso_at(min(now + studio_alerts_meta.RECHECK_EVERY, give_up)),
        "giveUpAt": _iso_at(give_up),
        "authCheckPendingSince": _iso_at(failed_at) if verdict == "pending" else "",
    }
    if skip:
        patch["skipActions"] = sorted(skip)
    return patch


def _rule_for_resend(rule: dict[str, Any], data: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The rule a retried reply is sent with: never an action in ``skipActions`` (its send timed out
    and may have landed), and for a parked reply sent after the outage, past 24 hours after the
    comment only the private reply still goes out (public replies and likes only within 24 hours,
    PLAN §7.4). The rule itself when nothing changes."""
    skip = _skip_actions(data.get("skipActions"))
    if data.get("parkedReason") == PARKED_REASON and now >= _comment_time(data, now) + PUBLIC_REPLY_WINDOW:
        skip |= {"public", "like"}
    return _without_actions(rule, skip)


def _reply_left(rule: dict[str, Any], platform: str) -> bool:
    """The rule still has something to send for a comment on ``platform``."""
    return _dm_pending(rule, []) or bool(str(rule.get("publicReply") or "")) or (
        platform == "fb" and _bool(rule.get("likeComment"))
    )


def _execute_rule_actions(
    page: dict[str, Any], rule: dict[str, Any], platform: str, comment_id: str, _actions_holder: list[str] | None = None
) -> tuple[list[str], list[str], bool]:
    """Send the DM / public reply / like for one comment.

    Returns (actions, errors, retryable): retryable when nothing was sent and
    every failure was a temporary Meta condition (pause, outage), so the
    scheduler may try again instead of the comment being lost. The tuple also
    carries ``auth_codes``, ``auth_failed_at`` and ``timed_out`` (_ReplyOutcome)
    for the parking rule (P3-18b), ``skipped`` (P4-05: an action whose channel
    is gated, off or unavailable is never sent; nothing reaches Meta when every
    action is held) and ``sent_at`` (P4-02). Each action is saved to the reply
    log row of the surrounding _reply_row() block as soon as Meta accepts it,
    and a per-page refusal (page_problem_reason) or a success updates the
    page's health (P4-03) when ``page`` carries its row ``id``."""
    actions: list[str] = _actions_holder if _actions_holder is not None else []  # visible to the caller on a crash
    errors: list[str] = []
    auth_codes: list[str] = []
    timed_out: list[str] = []
    auth_failed: list[datetime] = []
    skipped: list[dict[str, str]] = []
    sent_at = ""
    page_reasons: list[str] = []
    failures = 0
    temporary = 0
    client: Any = None
    token = ""
    gates = capability_gates()

    def open_channel(kind: str) -> bool:
        state = channel_state(gates, platform, kind)
        if state is None:
            return True
        skipped.append({"action": kind, "channel": CHANNEL_OF[(platform, kind)], "state": state})
        return False

    dm_text = str(rule.get("dmText") or "")
    dm_wanted = _bool(rule.get("dmEnabled")) and bool(dm_text) and not _bool(rule.get("pauseDms")) and open_channel("dm")
    public_reply = str(rule.get("publicReply") or "")
    public_wanted = bool(public_reply) and open_channel("public")
    like_wanted = platform == "fb" and _bool(rule.get("likeComment")) and open_channel("like")
    if not (dm_wanted or public_wanted or like_wanted):
        return _ReplyOutcome.of(actions, errors, False, auth_codes, None, timed_out, skipped)  # nothing open: no Meta call

    def refused(code: Any) -> None:
        auth_codes.append(str(code or ""))
        if not auth_failed:
            auth_failed.append(datetime.now(timezone.utc))  # the first refusal's time (the token check's yardstick)

    def sent(kind: str) -> None:
        nonlocal sent_at
        actions.append(kind)
        sent_at = sent_at or _iso_now()  # when the person got the first answer (P4-02 latency)
        _save_sent_actions(actions, sent_at)

    try:
        client = _meta.get_meta_ads_client()
        token = client.page_access_token(str(page.get("metaPageId") or ""))
    except _meta.MetaAdsError as error:
        client = None
        errors.append(error.public_message)
        failures += 1
        temporary += 1 if error.retryable else 0
        if error.code == "authorization":
            refused(error.provider_code)
        if page_problem_reason(error):
            page_reasons.append(page_problem_reason(error))
    dm_sent = False
    refreshed = False

    def post(path: str, data: dict[str, Any]) -> None:
        # A Page token revoked since it was cached: meta_ads forgot it, so fetch a fresh one
        # and retry this action once. Meta applied nothing on an authorization refusal, so the
        # retry cannot send twice.
        nonlocal token, refreshed
        try:
            client._post(path, data, access_token=token)
        except _meta.MetaAdsError as error:
            if error.code != "authorization" or refreshed:
                raise
            refreshed = True
            fresh = client.page_access_token(str(page.get("metaPageId") or ""))
            if not fresh or fresh == token:
                raise
            token = fresh
            client._post(path, data, access_token=token)

    def note(kind: str, error: Any) -> str:
        if getattr(error, "code", "") == "authorization":
            refused(getattr(error, "provider_code", ""))
        if getattr(error, "code", "") == "timeout":
            timed_out.append(kind)  # the send may have landed: never resent (parking's skipActions)
        if page_problem_reason(error):
            page_reasons.append(page_problem_reason(error))
        code = f" ({error.provider_code})" if getattr(error, "provider_code", "") else ""
        return f"{kind}: {error.public_message}{code}"

    if client is not None:
        if dm_wanted:
            try:
                # One private reply per comment, within 7 days of the comment, through the
                # Page's (FB) or the Instagram account's (IG) messages endpoint. The old
                # /{comment-id}/private_replies edge was removed after Graph API v3.2.
                # A refusal (already replied, too old) is a permanent request_failed: never retried.
                sender = page.get("metaPageId") if platform == "fb" else page.get("igUserId")
                post(
                    f"{sender}/messages",
                    {
                        "recipient": json.dumps({"comment_id": str(comment_id)}, separators=(",", ":")),
                        "message": json.dumps({"text": dm_text}, separators=(",", ":"), ensure_ascii=False),
                    },
                )
                sent("dm")
                dm_sent = True
            except _meta.MetaAdsError as error:
                errors.append(note("dm", error))
                failures += 1
                temporary += 1 if (error.retryable and error.code != "timeout") else 0  # a timed-out send may have landed: never resend blindly
        if public_wanted and not (_bool(rule.get("skipPublicAfterDm")) and dm_sent):
            try:
                path = f"{comment_id}/comments" if platform == "fb" else f"{comment_id}/replies"
                post(path, {"message": public_reply})
                sent("public")
            except _meta.MetaAdsError as error:
                errors.append(note("public", error))
                failures += 1
                temporary += 1 if (error.retryable and error.code != "timeout") else 0  # a timed-out send may have landed: never resend blindly
        if like_wanted:
            try:
                post(f"{comment_id}/likes", {})
                sent("like")
            except _meta.MetaAdsError as error:
                errors.append(note("like", error))
                failures += 1
                temporary += 1 if (error.retryable and error.code != "timeout") else 0  # a timed-out send may have landed: never resend blindly
    _page_health_after_meta(page, page_reasons[0] if page_reasons else "", succeeded=bool(actions))
    retryable = not actions and failures > 0 and temporary == failures
    return _ReplyOutcome.of(actions, errors, retryable, auth_codes, auth_failed[0] if auth_failed else None, timed_out,
                            skipped, sent_at)


def _retry_pending_replies(now: datetime, limit: int = 20) -> int:
    """Answer comments whose reply hit a temporary Meta problem earlier.

    The reservation row kept the claim; without this pass such a comment was
    never answered ("will resume automatically" was a lie). Meta's private
    reply window is seven days from the COMMENT (``commentAt``; a row from
    before it has only ``at``, the claim time), so older rows are left alone:
    a comment a manual check read six days late has one day left, not seven.

    Parked replies (P3-18b, ``parkedReason``): while Albayan's Meta connection
    is down they are left alone (the pass runs one token check, at most one
    Meta call per 10 minutes, to notice the recovery); after it they are
    resent like any other, a private reply until 7 days after the comment, a
    public reply or a like until 24 hours after it. Past ``giveUpAt`` they
    are finished as missed_during_outage, visible in the reply log. One parked
    while the token check had no verdict (``authCheckPendingSince``) is checked
    again first: down, it waits like the others; valid (checked after the
    refusal), it is resent once and a new refusal finishes it; still no verdict,
    it is resent and a new refusal parks it again until ``giveUpAt``. An action
    in ``skipActions`` (its send timed out and may have landed) is never resent."""
    from . import studio_alerts_meta  # late: it imports this module

    ctx = _ctx()
    now_iso = _iso_at(now)
    cutoff = _iso_at(now - timedelta(days=7))
    written = f"COALESCE(NULLIF({_json_field('commentAt')}, ''), {_json_field('at')})"
    try:
        down = studio_alerts_meta.recheck_connection()
    except Exception:
        down = studio_alerts_meta.connection_down()
    held = f"AND COALESCE({_json_field('parkedReason')}, '') = '' " if down else ""
    with db_conn() as conn:
        rows = conn.execute(
            text(
                f"SELECT id, data_json FROM entities WHERE type=:type AND deleted=false {held}"
                f"AND COALESCE({_json_field('retryAfter')}, '') <> '' AND {_json_field('retryAfter')} <= :now "
                f"AND {written} >= :cutoff ORDER BY {_json_field('retryAfter')} ASC LIMIT :limit"
            ),
            {"type": LOG_TYPE, "now": now_iso, "cutoff": cutoff, "limit": max(1, int(limit))},
        ).mappings().all()
        expired = conn.execute(
            text(
                f"SELECT id, data_json FROM entities WHERE type=:type AND deleted=false "
                f"AND COALESCE({_json_field('retryAfter')}, '') <> '' AND {written} < :cutoff LIMIT :limit"
            ),
            {"type": LOG_TYPE, "cutoff": cutoff, "limit": max(1, int(limit))},
        ).mappings().all()
        gave_up = conn.execute(
            text(
                f"SELECT id, data_json FROM entities WHERE type=:type AND deleted=false "
                f"AND {_json_field('parkedReason')} = :parked AND COALESCE({_json_field('retryAfter')}, '') <> '' "
                f"AND COALESCE({_json_field('giveUpAt')}, '') <> '' AND {_json_field('giveUpAt')} <= :now LIMIT :limit"
            ),
            {"type": LOG_TYPE, "parked": PARKED_REASON, "now": now_iso, "limit": max(1, int(limit))},
        ).mappings().all()
    stuck_cutoff = _iso_at(now - timedelta(minutes=15))
    with db_conn() as conn:  # a claim the process never finished (killed mid-reply): hand it to the retry pass
        stuck = conn.execute(
            text(
                f"SELECT id, data_json FROM entities WHERE type=:type AND deleted=false "
                f"AND CAST(COALESCE({_json_field('processing')}, '') AS TEXT) IN ('true', '1') AND COALESCE({_json_field('retryAfter')}, '') = '' "
                f"AND {_json_field('at')} < :stuck AND {written} >= :cutoff LIMIT :limit"
            ),
            {"type": LOG_TYPE, "stuck": stuck_cutoff, "cutoff": cutoff, "limit": max(1, int(limit))},
        ).mappings().all()
    for row in stuck:
        data = json_loads(row.get("data_json") or "{}") or {}
        _release: dict[str, Any] = {"processing": False, "error": "interrupted"}
        if not data.get("actions"):  # nothing was sent: the retry pass may answer; otherwise never resend blindly
            _release.update({"retryAfter": now_iso, "attempts": int(data.get("attempts") or 0) + 1})
        try:
            ctx["patch_entity"](LOG_TYPE, str(row["id"]), _release, str(data.get("ownerId") or "system"))
        except Exception:
            pass
    finished: set[str] = set()
    for row in [*gave_up, *expired]:
        # Released, so the person no longer counts as answered by a reply that
        # was never sent, and the row is not scanned again.
        if str(row["id"]) in finished:
            continue
        finished.add(str(row["id"]))
        data = json_loads(row.get("data_json") or "{}") or {}
        parked = isinstance(data, dict) and data.get("parkedReason") == PARKED_REASON
        try:
            ctx["patch_entity"](LOG_TYPE, str(row["id"]),
                                _missed_patch() if parked else {"retryAfter": "", "error": "Reply window expired (7 days)."},
                                str(data.get("ownerId") or "") if isinstance(data, dict) else "")
        except HTTPException:
            pass
    attempted = 0
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict) or str(row["id"]) in finished:
            continue
        owner_id = str(data.get("ownerId") or "")
        attempts = max(1, int(data.get("attempts") or 1))
        parked = data.get("parkedReason") == PARKED_REASON
        give_up = _parse_iso(data.get("giveUpAt")) if parked else None
        page_entity = ctx["get_entity"](PAGES_TYPE, str(data.get("pageId") or "")) if data.get("pageId") else None
        rule_entity = ctx["get_entity"](RULES_TYPE, str(data.get("ruleId") or "")) if data.get("ruleId") else None
        usable = (
            _owner_can_automate(owner_id)
            and page_entity and not page_entity.get("deleted")
            and str((page_entity.get("data") or {}).get("ownerId") or "") == owner_id
            and rule_entity and not rule_entity.get("deleted")
            and _bool((rule_entity.get("data") or {}).get("enabled"), True)
        )
        if give_up is not None and now >= give_up:
            patch: dict[str, Any] | None = _missed_patch()
        elif not usable:
            patch = {"retryAfter": "", "error": "Reply retry stopped: the page, rule or access is no longer available."}
        else:
            settings = _settings_entity(ctx, owner_id)["data"]
            if not _bool(settings.get("masterEnabled"), True):
                patch = {"retryAfter": _iso_at(now + timedelta(hours=1))}  # paused by the owner: keep waiting
            elif _bool(rule_entity["data"].get("quietHours")) and _in_quiet_window(settings.get("quietHours") or {}, datetime.now(_zone(settings.get("timezone")))):
                patch = {"retryAfter": _iso_at(now + timedelta(minutes=30))}  # quiet hours: later
            else:
                patch = None
        pending_since = _parse_iso(data.get("authCheckPendingSince")) if parked else None
        verdict: str | None = None
        if patch is None and pending_since is not None:
            # The token check had no verdict on this refusal (P3-18b): ask again before resending.
            try:
                verdict = studio_alerts_meta.after_authorization_failure(pending_since)
            except Exception:
                verdict = "pending"
            if verdict == "down":  # an ordinary parked reply now: it waits for the recovery
                later = now + studio_alerts_meta.RECHECK_EVERY
                patch = {"retryAfter": _iso_at(min(later, give_up) if give_up else later), "authCheckPendingSince": ""}
            # ok_fresh (the token is fine) or still no verdict (no app id, Meta unreachable): the reply
            # itself tries again below. A refused send applied nothing on Meta, so it cannot double up.
        if patch is None:
            rule = _rule_for_resend(rule_entity["data"], data, now)
            if rule is not rule_entity["data"] and not _reply_left(rule, str(data.get("platform") or "")):
                # A parked reply past its public 24 hours with no private reply owed (or nothing left
                # that did not time out before).
                patch = _missed_patch() if parked else {"retryAfter": ""}
            else:
                with _reply_row(str(row["id"]), owner_id):  # P4-02: each action lands on the row as it succeeds
                    outcome = _execute_rule_actions(
                        {**page_entity["data"], "id": str(page_entity["id"])}, rule,
                        str(data.get("platform") or ""), str(data.get("commentId") or ""),
                    )
                actions, errors, retryable = outcome
                patch = {"actions": actions, "error": "; ".join(errors)[:500], "attempts": attempts + 1}
                patch.update(_outcome_patch(outcome))
                if pending_since is not None:
                    patch["authCheckPendingSince"] = ""
                # A new refusal is judged by the check just made: ok_fresh (the token was fine after
                # the first refusal) finishes it, so a page-level refusal cannot loop; pending parks
                # it again until giveUpAt.
                kept = _parked_patch(outcome, data, rule_entity["data"], now, verdict)
                if kept:
                    patch.update(kept)  # Albayan's Meta connection went down (again): parked, not lost
                else:
                    # No attempt cap: the delay is capped at four hours and the pass
                    # itself gives up after seven days (Meta's private-reply window).
                    patch["retryAfter"] = _retry_after_iso(attempts + 1) if retryable else ""
        if parked and patch.get("retryAfter") == "":
            patch.setdefault("parkedReason", "")  # finished: no longer waiting for the connection
        try:
            ctx["patch_entity"](LOG_TYPE, str(row["id"]), patch, owner_id)
        except HTTPException:
            pass
        attempted += 1
    return attempted


COMMENT_SOURCES = ("webhook", "poll", "manual_check")  # socialReplyLog.source (PLAN §7.1)


def process_comment(
    *, platform: str, entry_id: str, comment_id: str, post_ref: str, from_id: str, text: str,
    source: str = "webhook", comment_at: Any = None,
) -> dict[str, Any] | None:
    """Answer one new comment according to the page owner's rules.

    Returns the reply-log data when a rule acted, else None. Never raises:
    the webhook path must always acknowledge Meta. (An unknown ``source`` is
    a programming mistake: ValueError before anything runs.)

    ``source`` is kept on the log row: ``webhook`` (Meta delivered the comment)
    or ``poll`` / ``manual_check`` (Albayan read it itself, studio_ig_poll.py,
    so it may be old). A comment Albayan read needs its time ``comment_at``
    (unknown: never answered), and only rules active since before it
    (rule_active_since_ms; the same second counts) may answer it. The log row
    keeps the comment's time as ``commentAt`` (a webhook's: the delivery time),
    which starts Meta's 7-day private-reply window for the retry pass. The log
    row id depends on owner, platform and comment only, never on the source, so
    a comment is answered once however many times a check, a poll or the webhook
    hands it over.
    """
    if source not in COMMENT_SOURCES:
        raise ValueError(f"Unknown comment source {str(source)[:40]!r}")
    written_second: int | None = None
    written_at = ""
    if source != "webhook":
        written = _parse_iso(comment_at)
        if written is None:
            return None  # a comment read without its time may be old: never answered
        written_second = int(written.timestamp())
        written_at = _iso_at(written)
    ctx = _ctx()
    page_entity = _find_page(platform, entry_id)
    if not page_entity:
        return None
    page = {**page_entity["data"], "id": str(page_entity["id"])}
    _note_comment_seen(page_entity, source)  # P4-03: comments reach Albayan on this page (health)
    if str(from_id or "") in {str(page.get("metaPageId") or ""), str(page.get("igUserId") or "")}:
        return None  # the page replying to itself is not a customer comment
    owner_id = str(page.get("ownerId") or "")
    if not _owner_can_automate(owner_id):
        return None
    with _comment_reservation_guard(owner_id):
        settings = _settings_entity(ctx, owner_id)["data"]
        rules = sorted(
            (r["data"] for r in _rows(RULES_TYPE, owner_id) if _bool(r["data"].get("enabled"), True)),
            key=lambda r: (int(r.get("_created") or 0), str(r.get("id") or "")),
        )
        if written_second is not None:
            # A rule never answers a comment written before it applied as it is now: before it was
            # made, switched on or pointed at other comments (unknown creation: never).
            rules = [r for r in rules if 0 < rule_active_since_ms(r) // 1000 <= written_second]
        if not rules:
            return None
        replied_rules = (
            _person_replied_rule_ids(owner_id, page_entity["id"], from_id)
            if any(_bool(rule.get("oncePerPerson")) for rule in rules) else set()
        )
        refs = {str(post_ref or "")}
        preferred_rule_id = ""
        # Every public comment lands here; only ids and Meta results are
        # needed, never the base64 photos of every published post. A post
        # whose OTHER page failed is still live on this one, so scan both.
        for status in ("published", "failed"):
            for post in _lean_posts(owner_id, status, limit=1000):  # the helper caps at 1000
                results = [r for r in (post["data"].get("results") or []) if isinstance(r, dict)]
                if any(str(r.get("metaPostId") or "") == str(post_ref or "") for r in results):
                    refs.add(post["id"])
                    preferred_rule_id = preferred_rule_id or str(post["data"].get("autoReplyRuleId") or "")
        now_local = datetime.now(_zone(settings.get("timezone")))
        rule = None
        if preferred_rule_id:
            # The composer's "Auto-reply on this post" choice wins for this
            # post whatever the rule's own scope says.
            chosen = [dict(r, scope="all") for r in rules if str(r.get("id") or "") == preferred_rule_id]
            rule = evaluate_rules(
                chosen, settings, platform=platform, post_ref=refs, text=text, from_id=str(from_id or ""),
                already_replied_from_ids=set(), now_local=now_local, already_replied_rule_ids=replied_rules,
                page_id=str(page_entity["id"]),
            )
        if not rule:
            rule = evaluate_rules(
                rules, settings, platform=platform, post_ref=refs, text=text, from_id=str(from_id or ""),
                already_replied_from_ids=set(), now_local=now_local, already_replied_rule_ids=replied_rules,
                page_id=str(page_entity["id"]),
            )
        if not rule:
            return None
        log_id = _log_id(owner_id, platform, comment_id)
        claimed_at = _iso_now()
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
            "processing": True,
            "at": claimed_at,
            "commentAt": written_at or claimed_at,
            "receivedAt": claimed_at,  # P4-02: the webhook's arrival, or the poll's / check's read
            "sentAt": "",
            "error": "",
            "source": source,
        }
        try:
            # The row IS the idempotency claim: a duplicate delivery hits 409.
            ctx["upsert_entity"](LOG_TYPE, log_id, log_data, owner_id, reject_existing=True)
        except HTTPException as error:
            if error.status_code == 409:
                return None
            raise
    _sent: list[str] = []
    try:
        with _reply_row(log_id, owner_id):  # P4-02: each action lands on the row as it succeeds
            outcome = _execute_rule_actions(page, rule, platform, str(comment_id), _actions_holder=_sent)
        actions, errors, retryable = outcome
    except Exception:
        # A non-Meta failure (database hiccup, transport edge case, shutdown):
        # release the claim; retry only when NOTHING was sent (a DM that landed
        # must not be sent twice). A row left "processing" forever would block
        # the person for every once-per-person rule.
        try:
            _patch: dict[str, Any] = {"processing": False, "actions": list(_sent), "error": "interrupted"}
            if not _sent:
                _patch.update({"retryAfter": _retry_after_iso(1), "attempts": 1})
            ctx["patch_entity"](LOG_TYPE, log_id, _patch, owner_id)
        except Exception:
            pass
        raise
    log_data["actions"] = actions
    log_data["error"] = "; ".join(errors)[:500]
    log_data["processing"] = False
    patch: dict[str, Any] = {"actions": actions, "error": log_data["error"], "processing": False}
    patch.update(_outcome_patch(outcome))  # P4-02 sentAt, P4-05 skipped actions and their reason
    log_data.update(patch)
    kept = _parked_patch(outcome, log_data, rule, datetime.now(timezone.utc))
    if kept:
        # Albayan's Meta connection is down (P3-18b): parked for the retry pass, or missed when the
        # comment is already past its reply window.
        patch.update(kept)
        patch["attempts"] = 1
    elif retryable:
        # Nothing was sent and the cause is temporary: keep the claim and let
        # the scheduler try again instead of losing the comment for good.
        patch["retryAfter"] = _retry_after_iso(1)
        patch["attempts"] = 1
    try:
        saved = ctx["patch_entity"](LOG_TYPE, log_id, patch, owner_id)
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
                parent_id = str(value.get("parent_id") or "")
                if parent_id and parent_id != post_ref:
                    continue  # a reply inside a thread (often to our own auto-reply)
            elif obj == "instagram":
                if change.get("field") != "comments":
                    continue
                media = value.get("media") if isinstance(value.get("media"), dict) else {}
                if value.get("parent_id"):
                    continue  # a reply inside a thread (often to our own auto-reply)
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
# P4-03 page health: the one writer, the customer's view, the check, the daily pass
# ---------------------------------------------------------------------------


def page_health_state(data: dict[str, Any]) -> tuple[str, str]:
    """(state, reason) of a page row: ``healthState`` when set, else derived from the classic
    ``healthy`` flag (a row from before P4-03; its reason is unknown)."""
    state = str(data.get("healthState") or "")
    if state not in PAGE_HEALTH_STATES:
        state = "attention" if data.get("healthy") is False else "ok"
    reason = str(data.get("healthReason") or "") if state == "attention" else ""
    return state, reason if reason in PAGE_HEALTH_REASONS else ""


def page_health_view(data: dict[str, Any], *, connection_down: bool = False) -> dict[str, Any]:
    """What a customer sees of a page's health (PLAN §5.5 J7): the state, the reason, a bilingual
    label and fix step, whether the fix is the team's, and when it was checked. While Albayan's own
    Meta connection is down the per-page reason gives way to the neutral text (state
    ``connection``); the classic ``healthy`` flag keeps the stored truth."""
    state, reason = page_health_state(data)
    view: dict[str, Any] = {
        "state": state, "reason": reason, "label": dict(PAGE_HEALTH_OK_LABEL), "fix": None, "teamAction": False,
        "checkedAt": str(data.get("lastHealthCheckAt") or "") or None,
        "since": str(data.get("healthChangedAt") or "") or None,
    }
    if state == "ok":
        return view
    if connection_down:
        view.update({"state": "connection", "reason": "", "label": dict(PAGE_HEALTH_CONNECTION_LABEL), "teamAction": True})
        return view
    entry = PAGE_HEALTH_LABELS.get(reason) or PAGE_HEALTH_GENERIC_LABEL
    view.update({"label": dict(entry["label"]), "fix": dict(entry["fix"]), "teamAction": reason in TEAM_ACTION_REASONS})
    return view


def _raise_page_alert(page_id: str, owner_id: str, platform: str, reason: str, now: datetime | None) -> None:
    """One alert per page and Tripoli day when a page drops out of ``ok`` (studio_jobs.raise_alert):
    ``instagram_comments_not_arriving`` for that heuristic, ``page_health_drop`` for every other reason.
    Best effort: an alert that cannot be written never blocks the health write."""
    from . import studio_jobs  # late: it imports this module

    kind = "instagram_comments_not_arriving" if reason == "instagram_comments_not_arriving" else "page_health_drop"
    try:
        with db_conn() as conn:
            studio_jobs.raise_alert(
                conn, kind, related_type=PAGES_TYPE, related_id=page_id, owner_id=owner_id or None,
                details={"reason": reason, "platform": platform}, now=now,
            )
    except Exception as error:
        print(f"[albayan] Social Studio page alert failed ({type(error).__name__}).")


def _set_page_health(
    page_id: str, state: str, reason: str = "", *, actor_id: str = "", now: datetime | None = None, touch: bool = False,
) -> dict[str, Any] | None:
    """THE writer of a page's health (P4-03): ``healthState``, ``healthReason``, the derived classic
    ``healthy`` flag, ``lastHealthCheckAt`` and, on a change, ``healthChangedAt``; a drop out of
    ``ok`` raises the page's alert for the day. ``touch``: rewrite ``lastHealthCheckAt`` even when
    nothing changed (a check ran). Returns the page data, or None for an unknown or unlinked page."""
    if state not in PAGE_HEALTH_STATES:
        raise ValueError(f"unknown page health state {str(state)[:20]!r}")
    reason = str(reason or "") if state == "attention" else ""
    if state == "attention" and reason not in PAGE_HEALTH_REASONS:
        raise ValueError(f"unknown page health reason {reason[:40]!r}")
    if not _SAFE_ID_RE.fullmatch(str(page_id or "")):
        return None
    ctx = _ctx()
    entity = ctx["get_entity"](PAGES_TYPE, page_id)
    if not entity or entity.get("deleted"):
        return None
    data = entity.get("data") or {}
    owner_id = str(data.get("ownerId") or "")
    changed = page_health_state(data) != (state, reason)
    if not changed and not touch:
        return data
    moment = _iso_at(now) if now else _iso_now()
    patch: dict[str, Any] = {
        "healthState": state, "healthReason": reason, "healthy": state == "ok", "lastHealthCheckAt": moment, "updatedAt": moment,
    }
    if changed:
        patch["healthChangedAt"] = moment
    try:
        saved = ctx["patch_entity"](PAGES_TYPE, page_id, patch, actor_id or owner_id or "system")
    except HTTPException:
        return None
    if changed and state == "attention":
        _raise_page_alert(page_id, owner_id, str(data.get("platform") or ""), reason, now)
    return saved.get("data") or {**data, **patch}


def _page_health_after_meta(page: dict[str, Any], reason: str, *, succeeded: bool) -> None:
    """After a reply or a publish on ``page``: a per-page refusal marks the page with its reason; a
    success clears a reason a reply can clear (never the staff-set or heuristic ones). A page dict
    without its row ``id`` (a bare stand-in) is left alone."""
    page_id = str(page.get("id") or "")
    if not page_id:
        return
    try:
        if reason:
            _set_page_health(page_id, "attention", reason)
        elif succeeded:
            state, current = page_health_state(page)
            if state == "attention" and (current in REPLY_CLEARED_REASONS or not current):
                _set_page_health(page_id, "ok")
    except Exception as error:  # a health write never fails a reply that Meta accepted
        print(f"[albayan] Social Studio page health write failed ({type(error).__name__}).")


def _note_comment_seen(page_entity: dict[str, Any], source: str) -> None:
    """A comment reached Albayan on this page (webhook, poll or check): an Instagram account stamps
    ``igLastCommentEventAt`` (at most every 10 minutes; the heuristic's proof) and sheds the
    "comments not arriving" and staff-set "private" reasons; a Facebook feed webhook sheds
    ``webhook_not_subscribed`` (the delivery proves the subscription). Best effort."""
    data = page_entity.get("data") or {}
    page_id = str(page_entity.get("id") or "")
    if not page_id:
        return
    platform = str(data.get("platform") or "")
    state, reason = page_health_state(data)
    try:
        if platform == "ig":
            now = datetime.now(timezone.utc)
            last = _parse_iso(data.get("igLastCommentEventAt"))
            if last is None or now - last >= IG_EVENT_STAMP_EVERY:
                _ctx()["patch_entity"](PAGES_TYPE, page_id, {"igLastCommentEventAt": _iso_at(now)}, str(data.get("ownerId") or "") or "system")
            if state == "attention" and reason in IG_EVENT_CLEARED_REASONS:
                _set_page_health(page_id, "ok")
        elif source == "webhook" and state == "attention" and reason == "webhook_not_subscribed":
            _set_page_health(page_id, "ok")
    except Exception as error:
        print(f"[albayan] Social Studio comment stamp failed ({type(error).__name__}).")


def _ig_comment_total(client: Any, page: dict[str, Any]) -> int | None:
    """The sum of ``comments_count`` over the account's recent media (counts only, on the page lane);
    None when Meta did not answer. The Instagram "comments not arriving" heuristic compares two
    such sums a day apart (PLAN §7.4)."""
    ig_user_id = str(page.get("igUserId") or "")
    if not ig_user_id:
        return None
    with _meta.meta_call_lane("page", subject=str(page.get("metaPageId") or "")):
        payload = client._get(f"{ig_user_id}/media", {"fields": "id,comments_count", "limit": IG_MEDIA_COUNTED})
    rows = [row for row in (payload.get("data") or []) if isinstance(row, dict)][:IG_MEDIA_COUNTED]
    return sum(_meta._metric_int(row.get("comments_count")) for row in rows)


def _subscribe_page(page_id: str, data: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any] | None:
    """P4-03: subscribe Albayan's app to the page's webhook (meta_ads.subscribe_page_webhook, the page
    token on the page lane) when the platform's public replies are switched on; on link and as the
    backfill of the check. Returns meta_ads' answer, or None when no subscribe was wanted. A definite
    refusal marks the page (its reason, else webhook_not_subscribed: a team step); a temporary one
    (a pause, an outage) leaves the next check to it."""
    if not webhook_wanted(str(data.get("platform") or ""), capability_gates()):
        return None
    answer = _meta.subscribe_page_webhook(str(data.get("metaPageId") or ""))
    moment = _iso_at(now) if now else _iso_now()
    if answer.get("ok"):
        try:
            _ctx()["patch_entity"](PAGES_TYPE, page_id, {"webhookSubscribedAt": moment}, str(data.get("ownerId") or "") or "system")
        except HTTPException:
            pass
    elif not answer.get("retryable"):
        _set_page_health(page_id, "attention", answer.get("pageReason") or "webhook_not_subscribed", now=now)
    return answer


def check_page_health(page_entity: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """One health check of a linked page (the admin's "check" and the daily pass; PLAN §7.4):

    * the webhook subscription (``GET /{page-id}/subscribed_apps`` with the page token, page lane)
      when the platform's public replies are ``on``; an unsubscribed page is subscribed again (the
      backfill) and marked ``webhook_not_subscribed`` if that fails;
    * a Meta refusal on the way maps to the page's reason (page_problem_reason); a global one
      (Albayan's own token) is handed to the P3-18a token check and changes nothing here;
    * Instagram, public replies ``on`` (webhook delivery): the "comments not arriving" heuristic.
      The sum of ``comments_count`` over recent media is kept with its time; when a later sum, at
      least 24 hours after, is higher and no comment event reached Albayan in between, the page is
      marked ``instagram_comments_not_arriving`` (an event clears it, _note_comment_seen);
    * a page whose reasons all cleared goes back to ``ok``; ``lastHealthCheckAt`` is stamped always.

    Returns ``{pageId, checked, webhook, igCommentTotal, reason, health, errorCode, providerCode}``.
    """
    from . import studio_alerts_meta  # late: it imports this module

    page_id = str(page_entity.get("id") or "")
    data = dict(page_entity.get("data") or {})
    platform = str(data.get("platform") or "")
    moment = now or datetime.now(timezone.utc)
    out: dict[str, Any] = {"pageId": page_id, "checked": False, "webhook": "", "igCommentTotal": None, "reason": "",
                           "errorCode": "", "providerCode": ""}
    gates = capability_gates()
    if not _meta.load_meta_ads_config().configured:
        out["errorCode"] = "not_configured"
        out["health"] = page_health_view(_set_page_health(page_id, *page_health_state(data), now=moment, touch=True) or data)
        return out
    found: list[str] = []
    global_refusal = False
    if webhook_wanted(platform, gates):
        answer = _meta.read_page_webhook_subscription(str(data.get("metaPageId") or ""))
        out["webhook"] = answer["state"]
        if answer["state"] == "not_subscribed":
            backfill = _meta.subscribe_page_webhook(str(data.get("metaPageId") or ""))
            if backfill.get("ok"):
                out["webhook"] = "subscribed"
                try:
                    _ctx()["patch_entity"](PAGES_TYPE, page_id, {"webhookSubscribedAt": _iso_at(moment)}, str(data.get("ownerId") or "") or "system")
                except HTTPException:
                    pass
            elif backfill.get("pageReason"):
                found.append(backfill["pageReason"])
            elif not backfill.get("retryable"):
                found.append("webhook_not_subscribed")
        elif answer["state"] == "error":
            out["errorCode"], out["providerCode"] = answer["errorCode"], answer["providerCode"]
            if answer.get("pageReason"):
                found.append(answer["pageReason"])
            elif answer["errorCode"] == "authorization":
                global_refusal = True
    if platform == "ig" and str(gates.get("igPublicReply") if gates else "") == "on" and not found and not global_refusal:
        total: int | None = None
        try:
            client = _meta.get_meta_ads_client()
            total = _ig_comment_total(client, data)
        except _meta.MetaAdsError as error:
            out["errorCode"], out["providerCode"] = out["errorCode"] or error.code, out["providerCode"] or error.provider_code
            reason = page_problem_reason(error)
            if reason:
                found.append(reason)
            elif error.code == "authorization":
                global_refusal = True
        out["igCommentTotal"] = total
        if total is not None:
            snapshot = data.get("igCommentCounts") if isinstance(data.get("igCommentCounts"), dict) else {}
            earlier_total = snapshot.get("total")
            earlier_at = _parse_iso(snapshot.get("at"))
            last_event = _parse_iso(data.get("igLastCommentEventAt"))
            if (
                isinstance(earlier_total, int) and earlier_at is not None and moment - earlier_at >= IG_EVENT_SILENCE
                and total > earlier_total and (last_event is None or last_event < earlier_at)
            ):
                found.append("instagram_comments_not_arriving")
            # The snapshot moves on only after a full silence window, so a check every few hours
            # still compares sums a day apart.
            if earlier_at is None or moment - earlier_at >= IG_EVENT_SILENCE or not isinstance(earlier_total, int):
                try:
                    _ctx()["patch_entity"](PAGES_TYPE, page_id, {"igCommentCounts": {"total": total, "at": _iso_at(moment)}},
                                           str(data.get("ownerId") or "") or "system")
                except HTTPException:
                    pass
    if global_refusal:
        try:
            studio_alerts_meta.after_authorization_failure(moment)  # Albayan's own token: P3-18a decides
        except Exception as error:
            print(f"[albayan] Social Studio connection check failed ({type(error).__name__}).")
    state, current = page_health_state(data)
    if found:
        reason = found[0]
    elif state == "attention" and current in REPLY_CLEARED_REASONS | {"webhook_not_subscribed"} and not global_refusal and not out["errorCode"]:
        reason = ""  # what the check watches is fine again
    else:
        reason = current  # a staff-set or heuristic reason stays until its own clearing
    saved = _set_page_health(page_id, "attention" if reason else "ok", reason, now=moment, touch=True)
    out.update({"checked": True, "reason": reason, "health": page_health_view(saved or data)})
    return out


def page_health_due(data: dict[str, Any], now: datetime) -> bool:
    last = _parse_iso(data.get("lastHealthCheckAt"))
    return last is None or now - last >= PAGE_HEALTH_EVERY or last > now + timedelta(minutes=5)


def run_page_health_pass(now: datetime | None = None, limit: int = PAGE_HEALTH_PASS_LIMIT) -> dict[str, Any]:
    """The daily page check, budgeted: up to ``limit`` linked pages whose last check is older than
    24 hours (oldest first), only while the capability gates are armed and Meta is configured
    (before that there is nothing to check and no call is made). Returns counts only."""
    moment = now or datetime.now(timezone.utc)
    out = {"due": 0, "checked": 0, "attention": 0, "errors": 0}
    if capability_gates() is None or not _meta.load_meta_ads_config().configured:
        return out
    due = [row for row in _rows(PAGES_TYPE, None, limit=1000) if page_health_due(row.get("data") or {}, moment)]
    due.sort(key=lambda row: (str((row.get("data") or {}).get("lastHealthCheckAt") or ""), str(row.get("id") or "")))
    out["due"] = len(due)
    for row in due[: max(0, int(limit))]:
        try:
            result = check_page_health(row, now=moment)
        except Exception as error:  # the next pass tries again; the page keeps its state
            out["errors"] += 1
            print(f"[albayan] Social Studio page check failed ({type(error).__name__}).")
            continue
        out["checked"] += 1
        out["attention"] += 1 if result.get("reason") else 0
    return out


# ---------------------------------------------------------------------------
# P4-02 reply log: outcomes, the owner's page of rows, latency per source
# ---------------------------------------------------------------------------


def _outcome_patch(outcome: Any) -> dict[str, Any]:
    """The reply-log fields a _ReplyOutcome adds: ``sentAt`` (P4-02), ``skipped`` (P4-05: the actions
    a capability gate held, each with its channel and state) and, when nothing at all went out
    because of the gates, ``problemCode`` = ``channel_<state>``. A plain tuple (a test's stand-in)
    adds nothing."""
    patch: dict[str, Any] = {}
    sent_at = str(getattr(outcome, "sent_at", "") or "")
    if sent_at:
        patch["sentAt"] = sent_at
    skipped = [dict(item) for item in (getattr(outcome, "skipped", ()) or ())]
    if skipped:
        patch["skipped"] = skipped
        actions, errors = list(outcome[0] or []), list(outcome[1] or [])
        if not actions and not errors:
            patch["problemCode"] = f"channel_{skipped[0]['state']}"
    return patch


def reply_log_outcome(data: dict[str, Any]) -> str:
    """One word for what happened to a reply-log row (LOG_OUTCOMES)."""
    actions = [str(a) for a in (data.get("actions") or [])] if isinstance(data.get("actions"), list) else []
    error = str(data.get("error") or "")
    if _bool(data.get("processing")):
        return "sending"
    if str(data.get("retryAfter") or ""):
        return "parked" if str(data.get("parkedReason") or "") == PARKED_REASON else "waiting"
    if str(data.get("problemCode") or "") == MISSED_DURING_OUTAGE:
        return "missed"
    if actions:
        return "partial" if error else "sent"
    if error:
        return "failed"
    if data.get("skipped"):
        return "skipped"
    return "none"


def _latency_seconds(data: dict[str, Any]) -> int | None:
    received, sent = _parse_iso(data.get("receivedAt")), _parse_iso(data.get("sentAt"))
    if received is None or sent is None:
        return None
    return max(0, int((sent - received).total_seconds()))


def _percentile(values: list[int], share: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(share * len(ordered)) - 1))
    return ordered[index]


def _latency_summary(values: list[int]) -> dict[str, Any]:
    return {"count": len(values), "p50Seconds": _percentile(values, 0.5), "p95Seconds": _percentile(values, 0.95)}


def _log_rows_window(owner_id: str | None, since_ms: int, limit: int = LOG_WINDOW_ROWS_MAX) -> list[dict[str, Any]]:
    """The reply-log rows of one window, newest first; owner-scoped by the indexed column."""
    where = ["type = :type", "deleted = false", "created_at >= :since"]
    params: dict[str, Any] = {"type": LOG_TYPE, "since": int(since_ms), "limit": max(1, min(int(limit), LOG_WINDOW_ROWS_MAX))}
    if owner_id:
        where.append("created_by = :owner")
        params["owner"] = owner_id
    with db_conn() as conn:
        rows = conn.execute(
            text(f"SELECT * FROM entities WHERE {' AND '.join(where)} ORDER BY created_at DESC, id DESC LIMIT :limit"),
            params,
        ).mappings().all()
    entities = [_entity_from_row(r) for r in rows]
    if owner_id:
        entities = [e for e in entities if str(e["data"].get("ownerId") or "") == owner_id]
    return entities


def _log_row_view(entity: dict[str, Any], page_names: dict[str, str], rule_names: dict[str, str]) -> dict[str, Any]:
    """One row as its owner sees it: no commenter id, no staff id (the row carries none)."""
    data = entity.get("data") or {}
    actions = [str(a) for a in (data.get("actions") or [])] if isinstance(data.get("actions"), list) else []
    skipped = [dict(s) for s in (data.get("skipped") or []) if isinstance(s, dict)]
    return {
        "id": str(entity.get("id") or ""),
        "at": str(data.get("at") or ""),
        "commentAt": str(data.get("commentAt") or ""),
        "platform": str(data.get("platform") or ""),
        "pageId": str(data.get("pageId") or ""),
        "pageName": page_names.get(str(data.get("pageId") or ""), ""),
        "ruleId": str(data.get("ruleId") or ""),
        "ruleName": rule_names.get(str(data.get("ruleId") or ""), ""),
        "commentId": str(data.get("commentId") or ""),
        "postId": str(data.get("postId") or ""),
        "actions": actions,
        "skipped": skipped,
        "outcome": reply_log_outcome(data),
        "problemCode": str(data.get("problemCode") or ""),
        "error": str(data.get("error") or "")[:500],
        "source": str(data.get("source") or "webhook"),
        "receivedAt": str(data.get("receivedAt") or "") or None,
        "sentAt": str(data.get("sentAt") or "") or None,
        "latencySeconds": _latency_seconds(data),
        "attempts": int(data.get("attempts") or 0),
        "retryAfter": str(data.get("retryAfter") or "") or None,
        "parkedReason": str(data.get("parkedReason") or "") or None,
    }


def reply_log_labels() -> dict[str, Any]:
    """The bilingual words the log screen needs (outcomes, channel states, page/rule fallbacks)."""
    return {
        "outcome": {key: dict(value) for key, value in LOG_OUTCOME_LABELS.items()},
        "channelState": {key: dict(value) for key, value in CHANNEL_STATE_LABELS.items()},
        "problem": {f"channel_{state}": dict(label) for state, label in CHANNEL_STATE_LABELS.items() if state not in CHANNEL_OPEN_STATES},
        "pageRemoved": dict(PAGE_REMOVED_LABEL),
    }


def reply_log_page(
    owner_id: str | None, *, days: int = LOG_WINDOW_DAYS_DEFAULT, status: str = "", before: str = "", limit: int = LOG_PAGE_DEFAULT,
    now: datetime | None = None,
) -> dict[str, Any]:
    """P4-02: the owner's reply log, newest first, paged by ``before`` = ``<createdAt>:<id>`` of the
    last row shown; ``status`` narrows the rows to one outcome. The counters (by action, by outcome,
    latency per source) cover the whole window of ``days`` (at most LOG_WINDOW_ROWS_MAX rows), not
    just the page. ``owner_id`` None (an admin without ?ownerId=) reads every owner's rows."""
    moment = now or datetime.now(timezone.utc)
    days = max(1, min(int(days), LOG_WINDOW_DAYS_MAX))
    limit = max(1, min(int(limit), LOG_PAGE_MAX))
    status = str(status or "").strip().lower()
    if status and status not in LOG_OUTCOMES:
        raise HTTPException(status_code=400, detail="Unknown log status")
    cursor = _CURSOR_RE.fullmatch(str(before or "").strip()) if before else None
    if before and not cursor:
        raise HTTPException(status_code=400, detail="before must be <createdAt>:<id>")
    since_ms = int((moment - timedelta(days=days)).timestamp() * 1000)
    window = _log_rows_window(owner_id, since_ms)
    by_action = {kind: 0 for kind in _REPLY_ACTIONS}
    by_outcome = {kind: 0 for kind in LOG_OUTCOMES}
    latency: dict[str, list[int]] = {source: [] for source in COMMENT_SOURCES}
    for entity in window:
        data = entity["data"]
        for action in data.get("actions") or []:
            if str(action) in by_action:
                by_action[str(action)] += 1
        by_outcome[reply_log_outcome(data)] += 1
        seconds = _latency_seconds(data)
        if seconds is not None:
            latency.setdefault(str(data.get("source") or "webhook"), []).append(seconds)
    rows = window
    if status:
        rows = [e for e in rows if reply_log_outcome(e["data"]) == status]
    if cursor:
        created, row_id = int(cursor.group(1)), cursor.group(2)
        rows = [e for e in rows if (int(e["createdAt"]), str(e["id"])) < (created, row_id)]
    page_rows = rows[:limit]
    more = len(rows) > limit
    owners = {str(e["data"].get("ownerId") or "") for e in page_rows}
    page_names: dict[str, str] = {}
    rule_names: dict[str, str] = {}
    for owner in owners:
        if not owner:
            continue
        page_names.update({r["id"]: str(r["data"].get("name") or "") for r in _rows(PAGES_TYPE, owner)})
        rule_names.update({r["id"]: str(r["data"].get("name") or "") for r in _rows(RULES_TYPE, owner)})
    last = page_rows[-1] if page_rows else None
    return {
        "rows": [_log_row_view(e, page_names, rule_names) for e in page_rows],
        "nextBefore": f"{int(last['createdAt'])}:{last['id']}" if more and last else None,
        "counters": {
            "total": len(window),
            "byAction": by_action,
            "byOutcome": by_outcome,
            "latency": {source: _latency_summary(values) for source, values in latency.items()},
        },
        "windowDays": days,
        "windowTruncated": len(window) >= LOG_WINDOW_ROWS_MAX,
        "labels": reply_log_labels(),
    }


def reply_latency_by_source(days: int = 7, owner_id: str | None = None, now: datetime | None = None) -> dict[str, dict[str, Any]]:
    """P4-02, for diagnostics: per comment source (webhook / poll / manual_check) the count and the
    p50 / p95 of ``sentAt`` minus ``receivedAt`` over the last ``days`` (counts and seconds only,
    every owner unless one is named). The go/no-go targets (PLAN §12.8) are
    ``thresholds.webhookReplyP95Seconds`` and ``pollReplyP95Seconds``."""
    moment = now or datetime.now(timezone.utc)
    since_ms = int((moment - timedelta(days=max(1, min(int(days), LOG_WINDOW_DAYS_MAX)))).timestamp() * 1000)
    sql = json_fields_select_sql(("source", "receivedAt", "sentAt", "ownerId"), ("id",),
                                 "type = :type AND deleted = false AND created_at >= :since" + (" AND created_by = :owner" if owner_id else ""))
    params: dict[str, Any] = {"type": LOG_TYPE, "since": since_ms}
    if owner_id:
        params["owner"] = owner_id
    with db_conn() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    values: dict[str, list[int]] = {source: [] for source in COMMENT_SOURCES}
    for row in rows:
        if owner_id and str(row.get("f_ownerid") or "") != owner_id:
            continue
        seconds = _latency_seconds({"receivedAt": row.get("f_receivedat"), "sentAt": row.get("f_sentat")})
        if seconds is not None:
            values.setdefault(str(row.get("f_source") or "webhook"), []).append(seconds)
    return {source: _latency_summary(seconds) for source, seconds in values.items()}


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str:
    # Same proxy-aware answer as the login limiter. The leftmost
    # X-Forwarded-For entry is client-controlled, so keying a limit on it let
    # a caller mint a fresh allowance with every request.
    return (_shared_client_ip(request) or "unknown")[:80]


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
        return _public(_settings_entity(ctx, scope.owner), user)

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
        return _public(saved, user)

    # ---- rules ----------------------------------------------------------
    @router.get("/rules")
    def list_rules(ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        rows = sorted(_rows(RULES_TYPE, scope.list_owner), key=lambda r: (int(r.get("createdAt") or 0), r["id"]))
        live = {p["id"]: p for p in _rows(PAGES_TYPE, scope.list_owner)}  # P4-01: one read for every rule's pages
        return {"rules": [_public(r, user, pages=live) for r in rows],
                "channels": {"states": dict(capability_gates() or {}), "labels": {k: dict(v) for k, v in CHANNEL_STATE_LABELS.items()}}}

    @router.post("/rules")
    def create_rule(
        body: dict[str, Any],
        request: Request,
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _mutation(request, user, ctx, ownerId)
        now = _iso_now()
        clean = {**_clean_rule(ctx, scope.owner, body or {}), "createdAt": now, "updatedAt": now, "activeSince": now_ms()}
        rule_id = new_id("srule")
        saved = ctx["upsert_entity"](RULES_TYPE, rule_id, clean, scope.owner, reject_existing=True)
        ctx["audit"](scope.uid, "create", RULES_TYPE, rule_id, f"Created auto-reply rule {clean['name']}", {"ownerId": scope.owner})
        return _public(saved, user)

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
        old = entity["data"]
        if (clean["enabled"] and not _bool(old.get("enabled"), True)) or _match_fields_changed(old, clean):
            clean["activeSince"] = now_ms()  # switched on or pointed elsewhere: older comments are not its
        saved = ctx["patch_entity"](RULES_TYPE, entity["id"], clean, scope.uid)
        ctx["audit"](scope.uid, "update", RULES_TYPE, entity["id"], "Updated auto-reply rule", {"ownerId": owner_id})
        return _public(saved, user)

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
        from . import studio_alerts_meta  # late: it imports this module

        scope = _scope(user, ctx, ownerId)
        rows = sorted(_rows(PAGES_TYPE, scope.list_owner), key=lambda r: (int(r.get("createdAt") or 0), r["id"]))
        try:
            down = studio_alerts_meta.connection_down()  # P3-18a: per-page reasons give way to the neutral banner
        except Exception:
            down = False
        return {"pages": [_public(r, user, connection_down=down) for r in rows]}

    # ---- reply log (P4-02) ------------------------------------------------
    @router.get("/log")
    def reply_log(
        before: str = Query(default="", max_length=100),
        status: str = Query(default="", max_length=20),
        days: int = Query(default=LOG_WINDOW_DAYS_DEFAULT, ge=1, le=LOG_WINDOW_DAYS_MAX),
        limit: int = Query(default=LOG_PAGE_DEFAULT, ge=1, le=LOG_PAGE_MAX),
        ownerId: str = owner_query,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        scope = _scope(user, ctx, ownerId)  # owners see their rows only; an admin may name an owner
        allowed, _left, retry_after_ms = check_rate_limit(f"social-studio:log:{scope.uid}", 60, 60_000)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many reply log reads. Please wait a minute.",
                                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))})
        return reply_log_page(scope.list_owner, days=days, status=status, before=before, limit=limit)

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
            "healthState": "ok",
            "healthReason": "",
            "linkedAt": now,
            "linkedBy": scope.uid,
            "createdAt": now,
            "updatedAt": now,
        }
        # P4-01: the same Meta page linked again to the same owner gets its old row back (same id),
        # so the owner's rules (pageRefs) and posts that name it fire again; another owner gets a new row.
        saved = _revive_unlinked_page(ctx, owner_id, platform, meta_page_id, data)
        action = "relink" if saved else "link"
        if not saved:
            page_id = new_id("spg")
            saved = ctx["upsert_entity"](PAGES_TYPE, page_id, data, owner_id, reject_existing=True)
        page_id = str(saved["id"])
        ctx["audit"](scope.uid, action, PAGES_TYPE, page_id, f"Linked {platform} page {meta_page_id}", {"ownerId": owner_id})
        subscribed = _subscribe_page(page_id, saved["data"])  # P4-03: only while the channel is switched on
        if subscribed is not None:
            ctx["audit"](scope.uid, "subscribe", PAGES_TYPE, page_id, "Subscribed the page to comment webhooks" if subscribed.get("ok") else "Page webhook subscribe failed",
                         {"ok": bool(subscribed.get("ok")), "errorCode": subscribed.get("errorCode", ""), "providerCode": subscribed.get("providerCode", "")})
            saved = ctx["get_entity"](PAGES_TYPE, page_id) or saved
        return _public(saved, user)

    @router.post("/pages/{page_id}/unlink")
    def unlink_page(page_id: str, request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        _require_admin(user)
        scope = _mutation(request, user, ctx)
        entity = _load_owned(ctx, PAGES_TYPE, page_id, scope)
        ctx["soft_delete_entity"](PAGES_TYPE, entity["id"], scope.uid)
        ctx["audit"](scope.uid, "unlink", PAGES_TYPE, entity["id"], "Unlinked social page", {})
        return {"ok": True, "id": entity["id"]}

    # ---- page health (P4-03) ----------------------------------------------
    @router.post("/pages/{page_id}/health")
    def set_page_health(page_id: str, body: dict[str, Any], request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        """Staff-set health: ``{"reason": "instagram_private"}`` after confirming the account is private
        (PLAN §5.5 J7), or ``{"reason": ""}`` to clear what staff set. Admin only, audited."""
        _require_admin(user)
        scope = _mutation(request, user, ctx)
        entity = _load_owned(ctx, PAGES_TYPE, page_id, scope)
        reason = str((body or {}).get("reason") or "").strip().lower()
        if reason and reason not in STAFF_SET_HEALTH_REASONS:
            raise HTTPException(status_code=400, detail="reason must be instagram_private or empty")
        if reason == "instagram_private" and str(entity["data"].get("platform") or "") != "ig":
            raise HTTPException(status_code=409, detail="This linked page is not an Instagram account")
        before = page_health_state(entity["data"])
        saved = _set_page_health(entity["id"], "attention" if reason else "ok", reason, actor_id=scope.uid, touch=True)
        ctx["audit"](scope.uid, "page_health", PAGES_TYPE, entity["id"],
                     f"Staff set page health: {reason or 'ok'}", {"before": before[1] or before[0], "after": reason or "ok"})
        return {"id": entity["id"], "health": page_health_view(saved or entity["data"])}

    @router.post("/pages/{page_id}/check")
    def check_page(page_id: str, request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        """Run the page's health check now (webhook subscription + backfill, the Instagram
        heuristic; check_page_health). Admin only, once a minute per page, audited."""
        _require_admin(user)
        scope = _mutation(request, user, ctx)
        entity = _load_owned(ctx, PAGES_TYPE, page_id, scope)
        allowed, _left, retry_after_ms = check_rate_limit(f"social-studio:page-check:{entity['id']}", 1, 60_000)
        if not allowed:
            raise HTTPException(status_code=429, detail="This page was checked less than a minute ago. Please wait.",
                                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))})
        result = check_page_health(entity)
        ctx["audit"](scope.uid, "page_health_check", PAGES_TYPE, entity["id"],
                     f"Page health check: {result.get('reason') or 'ok'}",
                     {"checked": result["checked"], "webhook": result["webhook"], "reason": result["reason"], "errorCode": result["errorCode"]})
        return result

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
        return {"posts": [_public(r, user) for r in _lean_posts(scope.list_owner, status)]}

    @router.get("/posts/{post_id}")
    def get_post(post_id: str, ownerId: str = owner_query, user: dict[str, Any] = Depends(current_user_dependency)):
        scope = _scope(user, ctx, ownerId)
        return _public(_load_owned(ctx, POSTS_TYPE, post_id, scope), user)

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
        return _public(saved, user)

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
        _live = any(isinstance(r, dict) and r.get("metaPostId") for r in (entity["data"].get("results") or []))
        _body = body or {}
        _changed = ("caption" in _body and str(_body.get("caption") or "") != str(entity["data"].get("caption") or "")) or (
            "media" in _body and list(_body.get("media") or []) != list(entity["data"].get("media") or []))
        if _live and _changed:  # the composer always sends caption/media; only a real change diverges the live post
            raise HTTPException(status_code=409, detail="A page already published this post; its text and photos cannot be changed here. Retry the failed pages, or delete the post (the live post stays on Meta).")
        owner_id = str(entity["data"].get("ownerId") or "")
        clean = {**_clean_post(ctx, owner_id, body or {}, entity["data"]), "updatedAt": _iso_now()}
        saved = ctx["patch_entity"](POSTS_TYPE, entity["id"], clean, scope.uid,
                                    expected_last_modified=int(entity["lastModified"]))
        ctx["audit"](scope.uid, "update", POSTS_TYPE, entity["id"], f"Updated social post ({clean['status']})", {})
        return _public(saved, user)

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
        ctx["soft_delete_entity"](POSTS_TYPE, entity["id"], scope.uid,
                                  expected_last_modified=int(entity["lastModified"]))
        ctx["audit"](scope.uid, "delete", POSTS_TYPE, entity["id"], "Deleted social post", {})
        return {"ok": True, "id": entity["id"],
                "metaLive": any(isinstance(r, dict) and r.get("metaPostId") for r in (entity["data"].get("results") or []))}

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
        return _public(publish_post(entity["id"], actor_id=scope.uid), user)

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
        saved = ctx["patch_entity"](POSTS_TYPE, entity["id"], {"status": "draft", "updatedAt": _iso_now()}, scope.uid,
                                    expected_last_modified=int(entity["lastModified"]))
        ctx["audit"](scope.uid, "cancel", POSTS_TYPE, entity["id"], "Cancelled scheduled social post", {})
        return _public(saved, user)

    # ---- public signed media (fetched by Meta) ---------------------------
    @router.get("/media/{post_id}/{index}")
    def media(
        post_id: str, index: str, request: Request,
        sig: str = Query(default="", max_length=128), exp: str = Query(default="", max_length=20),
    ):
        allowed, _left, _retry = check_rate_limit(f"social-studio:media:{_client_ip(request)}", 120, 60_000)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many requests")
        if not _SAFE_ID_RE.fullmatch(post_id) or not re.fullmatch(r"[0-3]", index or ""):
            raise HTTPException(status_code=404, detail="Not found")
        position = int(index)
        if not re.fullmatch(r"[0-9]{1,12}", exp or ""):
            raise HTTPException(status_code=404, detail="Not found")
        expires_at = int(exp)
        if expires_at < _unix_now():
            raise HTTPException(status_code=404, detail="Not found")
        if not constant_time_equal(sig, media_signature(post_id, position, expires_at)):
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
