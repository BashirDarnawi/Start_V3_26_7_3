"""Albayan Studio inbox: the owner's activity feed and its seen marker (plan task P3-05; PLAN.md §7.3,
§7.6, M7).

Routes under the studio router's /api/studio prefix (studio_stop.create_studio_desk_router includes them):

* ``GET /api/studio/activity?cursor=`` (any signed-in user, lapsed customers too; always the caller's
  OWN items): ``{items: [{id, kind, title: {en, ar}, body: {en, ar}, relatedType, relatedId, createdAt,
  unread}], unreadCount, nextCursor, seenAt}``, newest first, 20 a page. ``cursor`` is the
  ``nextCursor`` of the previous page (null on the last page).
* ``POST /api/studio/activity/seen`` ``{upTo}`` (same, from the Albayan site itself): the newest
  ``createdAt`` the owner has seen. The marker only moves forward (an older or repeated ``upTo``
  changes nothing) and never past now. It is kept as ``activitySeenAt`` on the owner's studio profile
  row (studioProfiles, the row studio_profile.py writes; its other fields stay as they are). An item is
  unread while it is newer than the marker. Audited ``activity_seen`` when the marker moves. Answer:
  ``{activitySeenAt, unreadCount}``.

Where the items come from:

* **Written at the lifecycle points** (``record_activity``). Type ``studioActivity``, one row per
  event, id ``act_`` + sha256(owner|kind|related id|event key)[:40]: a retried action finds the row it
  already wrote and never adds a second one. ``created_by`` = the owner (a real user, else nothing is
  written) and ``created_at`` = the event time. ad_campaign_actions.py writes request_sent_back,
  request_approved and request_rejected (review), request_live (the Meta link or the "live" marker,
  once per request) and settled (a staff stop); studio_stop.py writes stop_request_received; the
  ticket module (studio_support.py, P3-07) writes ticket_answered through ``record_activity`` when the
  team answers.
* **Read from the records themselves** (nothing kept twice): payment_confirmed from the owner's wallet
  ledger (a credit for one of their charge requests, through the platform door
  wallet_payments.wallet_ledger_rows) and ad_ended from the owner's adCampaignResults rows
  (``deliveryEndedAt``, written by the Meta sync, studio_results_sync.py).

A row never holds free text: its kind, the related type and id, and a few plain values (amounts in
minor units, a review reason code, the studio code, a ticket number). The titles and bodies are built
on read from ``ACTIVITY_TEXTS`` (English and Arabic), so no staff name or id can reach a customer
through the inbox and the anonymisation scrub has nothing to remove here. Every list filters
``created_by`` = the caller in SQL.
"""

import math
import re
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from ...db import db_conn, json_dumps, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from ...wallet_payments import WALLET_PAYMENT_COLLECTION, wallet_ledger_rows
from .ad_campaign_actions import REVIEW_REASON_LABELS
from .studio_diagnostics import parse_time
from .studio_errors import studio_error
from .studio_results import RESULTS_TYPE, normalize_results, results_id
from .studio_types import STUDIO_ACTIVITY_TYPE, STUDIO_PROFILES_TYPE, created_by_or_none, derived_id

ACTIVITY_TYPE = STUDIO_ACTIVITY_TYPE
ID_PREFIX = "act"
PROFILE_ID_PREFIX = "stp"  # the owner's studio profile row (studio_profile.profile_id)
PAGE_SIZE = 20
READS_PER_MINUTE = 60
SEEN_WRITES_PER_MINUTE = 30
SEEN_AUDIT_ACTION = "activity_seen"
SEEN_WRITE_ATTEMPTS = 3
KINDS = (
    "request_sent_back", "request_approved", "request_live", "request_rejected", "ad_ended", "settled",
    "ticket_answered", "payment_confirmed", "stop_request_received",
)
RELATED_TYPES = ("campaign", "ticket", "payment")
# The plain values a row may carry (anything else is dropped): no free text, ever.
PARAM_RULES: dict[str, type] = {
    "reasonCode": str, "studioRef": str, "number": str, "currency": str, "amountMinor": int, "refundMinor": int,
}
_PARAM_TEXT_RE = re.compile(r"[A-Za-z0-9_.:-]{1,40}")
_PARAM_MAX_MINOR = 10**12
_CURSOR_RE = re.compile(r"(\d{1,15}):([A-Za-z0-9][A-Za-z0-9._:-]{0,79})")
_MAX_TIME_TEXT = 40

# kind -> title and body in English and Arabic. ``body`` uses the row's values ({reason}, {amount},
# {number}); ``plain`` is the body when that value is missing; ``zero`` (settled) when nothing came back.
ACTIVITY_TEXTS: dict[str, dict[str, dict[str, str]]] = {
    "request_sent_back": {
        "title": {"en": "Your ad needs changes", "ar": "إعلانك يحتاج تعديلات"},
        "body": {"en": "The team sent it back: {reason}. Fix it and send it again.",
                 "ar": "أعاده الفريق: {reason}. عدّله ثم أرسله مرة أخرى."},
        "plain": {"en": "The team sent it back. Fix it and send it again.",
                  "ar": "أعاده الفريق. عدّله ثم أرسله مرة أخرى."},
    },
    "request_approved": {
        "title": {"en": "Your ad was approved", "ar": "تمت الموافقة على إعلانك"},
        "body": {"en": "{amount} was paid from your wallet. The team is setting it up in Meta.",
                 "ar": "دُفع {amount} من محفظتك. يجهّزه الفريق الآن في ميتا."},
        "plain": {"en": "The team is setting it up in Meta.", "ar": "يجهّزه الفريق الآن في ميتا."},
    },
    "request_live": {
        "title": {"en": "Your ad was launched in Meta", "ar": "أُطلق إعلانك في ميتا"},
        "body": {"en": "Meta reviews it first, then it starts running.", "ar": "تراجعه ميتا أولاً ثم يبدأ بالعمل."},
    },
    "request_rejected": {
        "title": {"en": "Your ad request was declined", "ar": "رُفض طلب إعلانك"},
        "body": {"en": "Reason: {reason}. Its reserved budget is free again in your wallet.",
                 "ar": "السبب: {reason}. عادت ميزانيته المحجوزة متاحة في محفظتك."},
        "plain": {"en": "Its reserved budget is free again in your wallet.",
                  "ar": "عادت ميزانيته المحجوزة متاحة في محفظتك."},
    },
    "ad_ended": {
        "title": {"en": "Your ad has ended", "ar": "انتهى إعلانك"},
        "body": {"en": "We return what Meta did not spend once its numbers are final (usually within 2 to 3 days).",
                 "ar": "نعيد لك ما لم تصرفه ميتا بعد أن تثبت أرقامها (عادةً خلال يومين إلى ثلاثة)."},
    },
    "settled": {
        "title": {"en": "Your ad is settled", "ar": "تمت تسوية إعلانك"},
        "body": {"en": "{amount} went back to your wallet.", "ar": "أعدنا {amount} إلى محفظتك."},
        "zero": {"en": "Meta used the whole budget, so nothing was left to return.",
                 "ar": "صرفت ميتا الميزانية كلها، فلم يبقَ ما نعيده."},
    },
    "ticket_answered": {
        "title": {"en": "The team answered your ticket", "ar": "ردّ الفريق على تذكرتك"},
        "body": {"en": "Ticket {number}: open it to read the answer.", "ar": "التذكرة {number}: افتحها لقراءة الرد."},
        "plain": {"en": "Open the ticket to read the answer.", "ar": "افتح التذكرة لقراءة الرد."},
    },
    "payment_confirmed": {
        "title": {"en": "Your payment was confirmed", "ar": "تم تأكيد دفعتك"},
        "body": {"en": "{amount} was added to your wallet.", "ar": "أضفنا {amount} إلى محفظتك."},
        "plain": {"en": "The money was added to your wallet.", "ar": "أضفنا المبلغ إلى محفظتك."},
    },
    "stop_request_received": {
        "title": {"en": "We received your stop request", "ar": "وصلنا طلب إيقاف إعلانك"},
        "body": {"en": "Ticket {number}. The team pauses the ad in Meta as soon as possible; we return what Meta did not spend.",
                 "ar": "التذكرة {number}. يوقف الفريق الإعلان في ميتا في أقرب وقت، ونعيد لك ما لم تصرفه ميتا."},
        "plain": {"en": "The team pauses the ad in Meta as soon as possible; we return what Meta did not spend.",
                  "ar": "يوقف الفريق الإعلان في ميتا في أقرب وقت، ونعيد لك ما لم تصرفه ميتا."},
    },
}


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The clock of the inbox (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ms(moment: datetime) -> int:
    return int(_aware(moment).timestamp() * 1000)


def _from_ms(stamp: int) -> datetime:
    return datetime.fromtimestamp(int(stamp) / 1000, tz=timezone.utc)


def _part(value: Any) -> str:
    """One part of a derived id: never empty, never the separator."""
    raw = str(value if value is not None else "").replace("|", "_").strip()
    return raw[:120] or "-"


def activity_id(owner_id: str, kind: str, related_id: Any, key: Any) -> str:
    return derived_id(ID_PREFIX, _part(owner_id), kind, _part(related_id), _part(key))


def profile_row_id(owner_id: str) -> str:
    return derived_id(PROFILE_ID_PREFIX, owner_id)


def clean_params(params: Any) -> dict[str, Any]:
    """Only the plain values of PARAM_RULES: whole amounts and short codes, never free text."""
    out: dict[str, Any] = {}
    for key, value in (params if isinstance(params, dict) else {}).items():
        rule = PARAM_RULES.get(str(key))
        if rule is int and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _PARAM_MAX_MINOR:
            out[key] = value
        elif rule is str and isinstance(value, str) and _PARAM_TEXT_RE.fullmatch(value):
            out[key] = value
    return out


def _money(minor: int, currency: str, language: str) -> str:
    amount = f"{minor / 100:,.2f}"
    if str(currency or "USD").upper() == "LYD":  # dinars never wear "$" (15g-studio-core.js studioLyd)
        return f"{amount} {'د.ل' if language == 'ar' else 'LYD'}"
    return f"${amount}"


def activity_texts(kind: str, params: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    """(title, body), each ``{en, ar}``, for one item."""
    entry = ACTIVITY_TEXTS[kind]
    reason_code = str(params.get("reasonCode") or "")
    reason = REVIEW_REASON_LABELS.get(reason_code) if reason_code else None
    amount = params.get("refundMinor") if kind == "settled" else params.get("amountMinor")
    number = str(params.get("number") or "")
    template = entry["body"]
    if kind == "settled" and amount == 0:
        template = entry["zero"]
    elif ("{reason}" in template["en"] and not reason) or ("{amount}" in template["en"] and amount is None) \
            or ("{number}" in template["en"] and not number):
        template = entry.get("plain") or entry["body"]
    body = {}
    for language in ("en", "ar"):
        body[language] = template[language].format(
            reason=(reason or {}).get(language, ""),
            amount=_money(int(amount or 0), str(params.get("currency") or "USD"), language),
            number=number,
        )
    return dict(entry["title"]), body


# ------------------------------------------------------------------ writing an item

def record_activity(
    conn: Any,
    *,
    owner_id: Any,
    kind: str,
    related_type: str,
    related_id: Any,
    key: Any,
    at: Any = None,
    params: dict[str, Any] | None = None,
) -> bool:
    """Write one inbox item on the caller's transaction; True when a new row was written.

    ``key`` names the event (an operation id, the review time, "live"...): the same owner, kind,
    related id and key always give the same row, so a repeat writes nothing. ``at`` (a time or an ISO
    text, now when missing) is the item's time. An owner that is not a real, live user gets nothing.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown studio activity kind {kind!r}")
    if related_type not in RELATED_TYPES:
        raise ValueError(f"unknown studio activity related type {related_type!r}")
    owner = created_by_or_none(conn, owner_id)
    if owner is None:
        return False
    moment = at if isinstance(at, datetime) else parse_time(at)
    moment = _aware(moment) if moment else utc_now()
    stamp = _ms(moment)
    row_id = activity_id(owner, kind, related_id, key)
    written = now_ms()
    data = {
        "recordType": ACTIVITY_TYPE, "id": row_id, "ownerId": owner, "kind": kind, "relatedType": related_type,
        "relatedId": str(related_id or "")[:80], "at": _iso(moment), "params": clean_params(params),
        "_created": stamp, "_lastModified": written, "_deleted": False,
    }
    result = conn.execute(
        text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :written) ON CONFLICT (type, id) DO NOTHING"
        ),
        {"type": ACTIVITY_TYPE, "id": row_id, "data": json_dumps(data), "stamp": stamp, "owner": owner,
         "written": written},
    )
    return int(result.rowcount or 0) == 1


def record_activity_safe(**kwargs: Any) -> bool:
    """``record_activity`` in its own transaction, for a caller whose change already committed: an
    inbox item must never undo or fail a money action. A failure is logged (error type only)."""
    try:
        with db_conn() as conn:
            return record_activity(conn, **kwargs)
    except Exception as error:
        print(f"[albayan] Studio inbox item '{kwargs.get('kind')}' was not written ({type(error).__name__}).")
        return False


# ------------------------------------------------------------------ reading the feed

def _item(row_id: str, stamp: int, kind: str, related_type: str, related_id: Any, params: Any) -> dict[str, Any]:
    return {"id": row_id, "ms": int(stamp), "kind": kind, "relatedType": related_type,
            "relatedId": str(related_id or ""), "params": clean_params(params)}


def _stored_items(conn: Any, owner_id: str, before: tuple[int, str] | None, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"type": ACTIVITY_TYPE, "uid": owner_id, "limit": int(limit)}
    older = ""
    if before is not None:
        older = " AND (created_at < :before_at OR (created_at = :before_at AND id < :before_id))"
        params.update({"before_at": int(before[0]), "before_id": str(before[1])})
    rows = conn.execute(
        text(
            "SELECT id, data_json, created_at FROM entities WHERE type = :type AND created_by = :uid "
            f"AND deleted = false{older} ORDER BY created_at DESC, id DESC LIMIT :limit"
        ),
        params,
    ).mappings().all()
    items = []
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        kind = str(data.get("kind") or "")
        related_type = str(data.get("relatedType") or "")
        if kind in KINDS and related_type in RELATED_TYPES:
            items.append(_item(str(row["id"]), int(row["created_at"]), kind, related_type, data.get("relatedId"),
                               data.get("params")))
    return items


def _stored_unread(conn: Any, owner_id: str, seen_ms: int) -> int:
    return int(conn.execute(
        text("SELECT COUNT(*) FROM entities WHERE type = :type AND created_by = :uid AND deleted = false "
             "AND created_at > :seen"),
        {"type": ACTIVITY_TYPE, "uid": owner_id, "seen": int(seen_ms)},
    ).scalar() or 0)


def _payment_items(conn: Any, owner_id: str) -> list[dict[str, Any]]:
    """payment_confirmed: the owner's ledger credits for their own charge requests (the confirm path
    writes one per request, wallet_payments.confirm_payment_request)."""
    items = []
    for row in wallet_ledger_rows(conn, owner_id):
        if row["type"] != "credit" or row["referenceType"] != WALLET_PAYMENT_COLLECTION or row["toUserId"] != owner_id:
            continue
        if row["status"] not in ("", "posted"):
            continue
        moment = parse_time(row["createdAt"])
        if moment is None:
            continue
        items.append(_item(
            activity_id(owner_id, "payment_confirmed", row["id"], "credit"), _ms(moment), "payment_confirmed", "payment",
            row["referenceId"], {"amountMinor": int(row["amountMinor"]), "currency": row["currency"] or "USD"},
        ))
    return items


def _ended_items(conn: Any, owner_id: str) -> list[dict[str, Any]]:
    """ad_ended: the owner's results rows whose delivery ended (the Meta sync's deliveryEndedAt)."""
    rows = conn.execute(
        text("SELECT id, data_json FROM entities WHERE type = :type AND deleted = false AND created_by = :uid"),
        {"type": RESULTS_TYPE, "uid": owner_id},
    ).mappings().all()
    items = []
    for row in rows:
        data = normalize_results(json_loads(row["data_json"]))
        campaign_id = data["campaignId"]
        ended = parse_time(data.get("deliveryEndedAt"))
        if not campaign_id or str(row["id"]) != results_id(campaign_id) or ended is None:
            continue
        items.append(_item(activity_id(owner_id, "ad_ended", campaign_id, _iso(ended)), _ms(ended), "ad_ended", "campaign",
                           campaign_id, {}))
    return items


def derived_items(conn: Any, owner_id: str) -> list[dict[str, Any]]:
    return _payment_items(conn, owner_id) + _ended_items(conn, owner_id)


def _key(item: dict[str, Any]) -> tuple[int, str]:
    return item["ms"], item["id"]


def item_view(item: dict[str, Any], seen_ms: int) -> dict[str, Any]:
    title, body = activity_texts(item["kind"], item["params"])
    return {
        "id": item["id"],
        "kind": item["kind"],
        "title": title,
        "body": body,
        "relatedType": item["relatedType"],
        "relatedId": item["relatedId"] or None,
        "createdAt": _iso(_from_ms(item["ms"])),
        "unread": item["ms"] > seen_ms,
    }


def unread_count(conn: Any, owner_id: str, seen_ms: int, derived: list[dict[str, Any]] | None = None) -> int:
    derived = derived_items(conn, owner_id) if derived is None else derived
    return _stored_unread(conn, owner_id, seen_ms) + sum(1 for item in derived if item["ms"] > seen_ms)


def load_feed(
    conn: Any, owner_id: str, *, before: tuple[int, str] | None = None, limit: int = PAGE_SIZE, seen_ms: int = 0,
) -> dict[str, Any]:
    """One page of the owner's items, newest first (time, then id), merged from both sources."""
    uid = str(owner_id or "")
    derived = derived_items(conn, uid)
    older = [item for item in derived if before is None or _key(item) < before]
    merged = sorted(_stored_items(conn, uid, before, limit + 1) + older, key=_key, reverse=True)
    page = merged[:limit]
    more = len(merged) > limit
    return {
        "items": [item_view(item, seen_ms) for item in page],
        "unreadCount": unread_count(conn, uid, seen_ms, derived),
        "nextCursor": f"{page[-1]['ms']}:{page[-1]['id']}" if more and page else None,
    }


# ------------------------------------------------------------------ the seen marker

def _profile_row(conn: Any, owner_id: str, *, lock: bool = False) -> Any:
    suffix = " FOR UPDATE" if lock and conn.dialect.name == "postgresql" else ""
    return conn.execute(
        text("SELECT id, data_json, deleted, created_at, last_modified FROM entities "
             f"WHERE type = :type AND id = :id LIMIT 1{suffix}"),
        {"type": STUDIO_PROFILES_TYPE, "id": profile_row_id(owner_id)},
    ).mappings().first()


def _live_profile(row: Any) -> dict[str, Any]:
    if not row or bool(row["deleted"]):
        return {}
    data = json_loads(row["data_json"] or "{}")
    return data if isinstance(data, dict) else {}


def read_seen_at(conn: Any, owner_id: str) -> datetime | None:
    return parse_time(_live_profile(_profile_row(conn, owner_id)).get("activitySeenAt"))


def save_seen_at(owner_id: str, up_to: datetime, *, audit: Callable[[Any, str, str], None]) -> datetime:
    """Move the owner's marker forward to ``up_to`` (never back); returns the marker now stored.

    One transaction per attempt; the write is conditional on the row's version, so a profile saved at
    the same moment (studio_profile.save_profile) is never overwritten: the next attempt re-reads it.
    ``audit(conn, row_id, iso)`` runs in the same transaction when the marker moves."""
    uid = str(owner_id or "")
    row_id = profile_row_id(uid)
    wanted = _aware(up_to)
    for _attempt in range(SEEN_WRITE_ATTEMPTS):
        with db_conn() as conn:
            row = _profile_row(conn, uid, lock=True)
            data = _live_profile(row)
            current = parse_time(data.get("activitySeenAt"))
            if current is not None and current >= wanted:
                return current
            stamp = now_ms()
            new = dict(data)
            new.update({"id": row_id, "recordType": STUDIO_PROFILES_TYPE, "ownerId": uid,
                        "activitySeenAt": _iso(wanted), "_deleted": False})
            if row:
                baseline = int(row["last_modified"] or 0)
                modified = max(stamp, baseline + 1)
                new["_created"] = int(new.get("_created") or row["created_at"] or modified)
                new["_lastModified"] = modified
                result = conn.execute(
                    text("UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                         "WHERE type = :type AND id = :id AND last_modified = :baseline"),
                    {"data": json_dumps(new), "modified": modified, "type": STUDIO_PROFILES_TYPE, "id": row_id,
                     "baseline": baseline},
                )
            else:
                new["_created"] = new["_lastModified"] = stamp
                result = conn.execute(
                    text("INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                         "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp) ON CONFLICT (type, id) DO NOTHING"),
                    {"type": STUDIO_PROFILES_TYPE, "id": row_id, "data": json_dumps(new), "stamp": stamp,
                     "owner": created_by_or_none(conn, uid)},
                )
            if int(result.rowcount or 0) == 1:
                audit(conn, row_id, _iso(wanted))
                return wanted
    studio_error(409, "VERSION_CONFLICT", "Your inbox was updated from another screen. Reload it, then try again.")


def clean_seen_body(body: Any, now: datetime) -> datetime:
    """``{upTo}``: an ISO time with its zone; a time after ``now`` counts as now."""
    if not isinstance(body, dict):
        studio_error(400, "INVALID_REQUEST", "Send {upTo}")
    extra = sorted(str(key) for key in set(body) - {"upTo"})
    if extra:
        studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{extra[0][:40]}'. Send {{upTo}}")
    raw = body.get("upTo")
    moment = parse_time(raw) if isinstance(raw, str) and len(raw) <= _MAX_TIME_TEXT else None
    if moment is None or moment.year < 2020:
        studio_error(400, "INVALID_VALUE", "upTo must be the createdAt of the newest item you have seen")
    return min(moment, _aware(now))


def parse_cursor(raw: Any) -> tuple[int, str] | None:
    if raw is None or raw == "":
        return None
    match = _CURSOR_RE.fullmatch(str(raw).strip())
    if not match:
        studio_error(400, "INVALID_VALUE", "cursor must be the nextCursor value of the previous page")
    return int(match.group(1)), match.group(2)


# ------------------------------------------------------------------ routes

def create_studio_activity_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """``GET /activity`` and ``POST /activity/seen`` under the studio router's /api/studio prefix.
    ``ctx["audit"]`` is main.audit (it joins the caller's transaction with ``conn=``)."""
    router = APIRouter()

    def rate_limit(user: dict[str, Any], bucket: str, per_minute: int) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    @router.get("/activity")
    def get_studio_activity(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "activity-read", READS_PER_MINUTE)
        before = parse_cursor(request.query_params.get("cursor"))
        uid = str(user.get("id") or "")
        with db_conn() as conn:
            seen = read_seen_at(conn, uid)
            feed = load_feed(conn, uid, before=before, seen_ms=_ms(seen) if seen else 0)
        feed["seenAt"] = _iso(seen) if seen else None
        return feed

    @router.post("/activity/seen")
    def mark_studio_activity_seen(
        request: Request,
        body: Any = Body(None),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        same_origin(request)
        rate_limit(user, "activity-seen", SEEN_WRITES_PER_MINUTE)
        up_to = clean_seen_body(body, utc_now())
        uid = str(user.get("id") or "")

        def audit_seen(conn: Any, row_id: str, seen_iso: str) -> None:
            ctx["audit"](uid, SEEN_AUDIT_ACTION, STUDIO_PROFILES_TYPE, row_id, "Marked the studio inbox as seen",
                         {"upTo": seen_iso}, conn=conn)

        seen = save_seen_at(uid, up_to, audit=audit_seen)
        with db_conn() as conn:
            unread = unread_count(conn, uid, _ms(seen))
        return {"activitySeenAt": _iso(seen), "unreadCount": unread}

    return router
