"""Albayan Studio help desk: support tickets (plan tasks P3-07, P3-13; PLAN.md §5.3, §5.5 J8, §7.1,
§7.3, §7.5).

**Customer routes** (under the studio router's /api/studio prefix; any signed-in user, lapsed
customers too; always the caller's own tickets: another owner's ticket is 404, never 403):

* ``POST /tickets`` ``{subject (3-120), category, relatedType?, relatedId?, message (1-2000),
  operationId}`` -> ``{ticket, message}``. Only while the Help service is open for the caller
  (rollout ``services.help``: on = everyone, pilot = the customer allowlist; else 403 SERVICE_OFF);
  reading, answering, resolving and reopening existing tickets always work. At most 10 new tickets
  an hour and 20 unresolved tickets per customer (409 TICKET_OPEN_LIMIT). A related item must be the
  caller's own: a request (``campaign``: 404 UNKNOWN_CAMPAIGN), a charge request (``payment``, by its
  id or its PAY- reference: 404 UNKNOWN_PAYMENT) or a linked page (``page``: 404 UNKNOWN_PAGE).
* ``GET /tickets?cursor=&status=&limit=`` -> ``{tickets, nextCursor}``, newest first, 20 a page.
* ``GET /tickets/{id}`` -> ``{ticket, messages}`` (at most 50 messages, oldest first).
* ``POST /tickets/{id}/messages`` ``{text, operationId}`` -> ``{ticket, message}``: the ticket goes
  back to ``open`` (waiting for the team). A resolved ticket is reopened by a message within 7 days
  of its resolution; later it is closed for good (409 TICKET_CLOSED: open a new ticket).
* ``POST /tickets/{id}/resolve`` and ``/reopen`` ``{operationId}`` -> ``{ticket}``. Asking for the
  state the ticket is already in changes nothing (200).

**Staff routes** (admins, and reviewers = ``adCampaignRequests.review``; anyone else 403 STAFF_ONLY):
reviewers see only ``audience: 'staff'`` tickets; payment and account tickets (``audience:
'admin'``) are admin-only and answer 404 UNKNOWN_TICKET to a reviewer, exactly like a ticket that
does not exist (PLAN.md §7.5).

* ``GET /staff/tickets?status=&priority=&cursor=&limit=`` -> ``{tickets, nextCursor}``: unresolved
  urgent tickets (stop requests) pinned on top, then newest first.
* ``GET /staff/tickets/{id}`` -> ``{ticket, messages}``.
* ``POST /staff/tickets/{id}/messages`` ``{text, operationId}`` -> ``{ticket, message}``: the ticket
  becomes ``answered``.
* ``POST /staff/tickets/{id}/status`` ``{status, operationId?}`` -> ``{ticket}``: any of the four.

``status`` filters take ``open``, ``answered``, ``waiting_customer``, ``resolved`` or ``active``
(everything not resolved); ``priority`` takes ``normal`` or ``urgent``; ``cursor`` is the
``nextCursor`` of the previous page; ``limit`` 1-50.

**What a customer sees.** ``ticket``: id, number (``T-000123``), subject, category, status, audience,
priority, kind, relatedType, relatedId, createdAt, updatedAt, dueAt ("we answer by", only while the
ticket waits for the team), lastMessageAt, resolvedAt, reopenUntil. ``message``: id, from
(``customer`` or ``team``), text, createdAt. Never who answered: every answer is the Albayan team
(studio_privacy.TEAM_LABELS), and each answer passes through redact_staff_identity (P1-05). Staff also
get ownerId, firstStaffAt, lastCustomerAt, lastStaffAt, messageCount and overdue, and each message's
authorId.

**Replays.** A ticket's id is ``tkt_`` + sha256(owner|operationId)[:40] and a message's
``tkm_`` + sha256(ticket|operationId)[:40] (studio_types.derived_id): sending the same operationId
again returns what the first send made (200); the same operationId with different content is
409 IDEMPOTENCY_MISMATCH.

**Numbers.** ``T-`` + at least 6 digits, handed out in order by one counter row (type
``studioCounters``, created_by NULL). Opening a ticket locks that row first (PostgreSQL ``FOR
UPDATE``; the SQLite writers of this module share one lock), then checks the replay and the open
cap, then takes the next number, so parallel opens can never share a number or pass the cap
(PostgreSQL scenario ``studio_ticket_numbers``). A missing counter row starts from the highest number
in use.

**Due times** (P3-16, studio_hours.py): a ticket waiting for the team is due
``targets.ticketFirstResponseMinutes`` working minutes after the customer's first unanswered message
(``stopRequestMinutes`` for an urgent one), counted in the ``hours`` setting. An answer or a wait for
the customer clears it; the customer's next message starts it again.

**Records** (router-only types; the generic /api/collections API refuses them):

* ``supportTickets``: created_by = the owner. Fields: number, seq, ownerId, subject, category,
  audience, priority (normal|urgent), kind (question|stop_request), relatedType, relatedId, status,
  createdAt, updatedAt, dueAt, lastMessageAt, lastCustomerAt, lastStaffAt, firstStaffAt, resolvedAt,
  resolvedBy, reopenedAt, messageCount, operationId, createFingerprint, lastStatusOperationId.
* ``supportTicketMessages`` (append-only): created_by = the TICKET's owner (also for team answers,
  so the anonymisation scrub finds every message of the account). Fields: ticketId, ownerId, seq,
  author (customer|team), authorUserId (never shown to customers), text, createdAt, operationId.

Audit entries (``ticket_create``, ``ticket_message``, ``ticket_status``) name the ticket number,
category and status change, never a subject or a message text, so the anonymisation scrub
(studio_privacy, P3-12), which removes subjects and texts, leaves no copy behind.

**For other studio features** (the stop request P3-10, the staff pulse P3-17, the activity feed
P3-05): ``open_ticket`` / ``open_ticket_conn`` (priority, kind and the open cap are parameters),
``system_resolve_ticket_conn``, ``staff_ticket_counts``, ``ticket_view`` and ``message_view``.

**TikTok service requests (P5-01; PLAN.md §4.1 M11, §8.4, D14).** A TikTok request is a help
ticket of category ``tiktok`` and kind ``tiktok_request`` (audience staff: reviewers and admins
see it in the desk), so it needs no second record type: the ticket thread carries the
conversation and four extra fields carry the service: ``tiktokHandle`` (the username without
``@``; the profile link is derived on read), ``tiktokWants`` (``auto_replies_help`` and/or
``advice``), ``tiktokState`` (``open -> in_progress -> done | declined``; the customer may
``cancelled`` an open one by resolving the ticket) and ``tiktokNote`` (the team's bilingual note
at each step). The words say what it is: hands-on help from the team; nothing here ever calls
TikTok "connected", "linked", "managed" or "automated" (test_studio_tiktok checks the texts).

* ``POST /tiktok/requests`` ``{handle, wants, note?, operationId}`` -> ``{request, message}``
  (the ``tiktok`` service must be open for the caller: ``rollout.services.tiktok``, else 403
  SERVICE_OFF; at most MAX_OPEN_TIKTOK_REQUESTS open or in progress at once, else 409
  TICKET_OPEN_LIMIT, and at most TIKTOK_CREATES_PER_DAY requests CREATED per Tripoli day, else 429
  RATE_LIMITED with ``Retry-After``: the day count reads the created rows, so a refused body or a
  replay never uses up a place; the in-memory limiter only stops floods, TIKTOK_FLOOD_PER_HOUR).
  ``handle``: the TikTok username, with or without ``@``, or the profile link ``tiktok.com/@name``
  (2-24 letters, digits, underscores or periods, not ending with a period). ``wants``: one value or
  a list of TIKTOK_WANTS. The same ``operationId`` again returns the first request (409
  IDEMPOTENCY_MISMATCH when anything differs). The request is due after ``targets.tiktokBusinessDays``
  (the promise in TIKTOK_TEXTS), not after the plain ticket target.
* ``GET /tiktok/requests?cursor=&limit=`` -> ``{requests, nextCursor, openCount, maxOpen,
  service}`` (the caller's own, newest first; ``service`` says whether new requests are open).
* ``GET /staff/tiktok?state=&cursor=&limit=`` (staff) -> ``{requests, nextCursor}``; ``state`` is
  one of TIKTOK_STATES or ``active`` (open and in progress).
* ``POST /staff/tiktok/{id}/status`` ``{status, note: {en, ar}, operationId}`` (staff) ->
  ``{request, message}``: ``in_progress`` from open, ``done`` from in progress, ``declined`` from
  either. The note (1-TIKTOK_NOTE_MAX characters in each language) is appended to the thread as a
  team message, so the customer reads it where the rest of the conversation is; ``done`` and
  ``declined`` also resolve the ticket. A finished request answers 409 TICKET_CLOSED, a step that
  skips the order 400 INVALID_VALUE, a ticket that is not a TikTok request 404 UNKNOWN_TICKET.
  Audited ``tiktok_status`` (number and states, never the note).
* The service never outlives its ticket. A team member who resolves the ticket through the generic
  ``POST /staff/tickets/{id}/status`` instead ends the service the same way (``_finish_tiktok_service``,
  the one function both routes use): an open or in-progress request becomes ``declined`` without a
  note, so it stops counting against the customer's cap (the ``ticket_status`` audit carries the
  state change). A customer's reopen of a cancelled request (the reopen route or a new message)
  puts the service back to ``open`` and takes a place among MAX_OPEN_TIKTOK_REQUESTS like a new
  request (409 TICKET_OPEN_LIMIT past the cap).

The request appears in every ticket view as ``tiktok: {handle, profileUrl, wants, state,
stateLabels, note, stateAt}``.
"""

import hashlib
import json
import math
import re
import threading
from contextlib import contextmanager, nullcontext
from datetime import datetime, time, timedelta, timezone
from typing import Any, Callable, Iterator

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from ...db import db_conn, get_engine, json_dumps, json_field_sql, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from ...wallet_payments import payment_request_belongs_to
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_errors import studio_error
from .studio_hours import iso, service_zone, target_due_at
from .studio_posts import find_owner_page
from .studio_privacy import redact_staff_identity
from .studio_settings import read_all_settings, service_access
from .studio_types import (
    STUDIO_COUNTERS_TYPE,
    SUPPORT_TICKET_MESSAGES_TYPE,
    SUPPORT_TICKETS_TYPE,
    created_by_or_none,
    derived_id,
)

TICKET_ID_PREFIX = "tkt"
MESSAGE_ID_PREFIX = "tkm"
COUNTER_ID = derived_id("stc", SUPPORT_TICKETS_TYPE)
NUMBER_PREFIX = "T-"
NUMBER_DIGITS = 6

CATEGORIES = ("ad", "payment", "page", "account", "tiktok", "other")
ADMIN_CATEGORIES = frozenset({"payment", "account"})  # audience 'admin': admins only (PLAN.md §7.5)
RELATED_TYPES = ("campaign", "payment", "page")
STATUSES = ("open", "answered", "waiting_customer", "resolved")
STATUS_FILTERS = STATUSES + ("active",)
PRIORITIES = ("normal", "urgent")
TIKTOK_KIND = "tiktok_request"
KINDS = ("question", "stop_request", TIKTOK_KIND)
AUDIENCE_STAFF = "staff"
AUDIENCE_ADMIN = "admin"

# ---- TikTok service requests (P5-01): a service done by hand, never a connection
TIKTOK_CATEGORY = "tiktok"
TIKTOK_WANTS = ("auto_replies_help", "advice")
TIKTOK_STATES = ("open", "in_progress", "done", "declined", "cancelled")
TIKTOK_STATE_FILTERS = TIKTOK_STATES + ("active",)
TIKTOK_OPEN_STATES = frozenset({"open", "in_progress"})
TIKTOK_TRANSITIONS: dict[str, tuple[str, ...]] = {"open": ("in_progress", "declined"), "in_progress": ("done", "declined")}
MAX_OPEN_TIKTOK_REQUESTS = 3
TIKTOK_CREATES_PER_DAY = 5  # created requests per Tripoli day (count_tiktok_requests_today), never tries
TIKTOK_FLOOD_PER_HOUR = 30  # the in-memory guard of the create route: floods only
TIKTOK_HANDLE_MIN = 2
TIKTOK_HANDLE_MAX = 24
TIKTOK_NOTE_MAX = 500  # each language of the team's note
TIKTOK_CUSTOMER_NOTE_MAX = 1000
TIKTOK_CREATE_FIELDS = ("handle", "wants", "note", "operationId")
TIKTOK_STATUS_FIELDS = ("status", "note", "operationId")
TIKTOK_PROFILE_URL = "https://www.tiktok.com/@{handle}"
# Every customer-facing TikTok text lives here (test_studio_tiktok greps them for the forbidden
# words "connected", "linked", "managed", "automated" / متصل, مربوط, يدير, مؤتمت: PLAN.md §8.4).
TIKTOK_TEXTS: dict[str, Any] = {
    "service": {
        "en": "TikTok service: hands-on help from the Albayan team, without automatic replies",
        "ar": "خدمة تيك توك — مساعدة يدوية من فريق البيان، بدون ردود تلقائية",
    },
    "notice": {
        "en": "Albayan cannot reply on TikTok for you yet, because TikTok has not opened that service to us. "
              "We help you by hand and tell you as soon as it becomes available.",
        "ar": "لا يستطيع البيان حالياً الرد تلقائياً على تيك توك، لأن تيك توك لم يفتح هذه الخدمة لنا بعد. "
              "سنساعدك يدوياً ونخبرك فور توفرها.",
    },
    "promise": {
        "en": "A team member contacts you within one business day, in this ticket or on WhatsApp.",
        "ar": "يتواصل معك أحد أعضاء الفريق خلال يوم عمل، في هذه التذكرة أو عبر واتساب.",
    },
    "wants": {
        "auto_replies_help": {
            "en": "Help setting up TikTok's own built-in auto-messages (TikTok runs them, not Albayan)",
            "ar": "مساعدة في إعداد الرسائل التلقائية المدمجة في تيك توك (تيك توك يشغّلها، لا البيان)",
        },
        "advice": {
            "en": "Advice on answering comments by hand and on TikTok ads",
            "ar": "نصائح للرد على التعليقات يدوياً وعلى إعلانات تيك توك",
        },
    },
    "states": {
        "open": {"en": "Received: the team contacts you within one business day", "ar": "وصل الطلب: يتواصل معك الفريق خلال يوم عمل"},
        "in_progress": {"en": "In progress with the Albayan team", "ar": "قيد العمل مع فريق البيان"},
        "done": {"en": "Done", "ar": "تم"},
        "declined": {"en": "Not possible right now", "ar": "غير ممكن حالياً"},
        "cancelled": {"en": "Cancelled by you", "ar": "ألغيته"},
    },
    "subject": {"en": "TikTok service", "ar": "خدمة تيك توك"},
    "firstMessage": {"en": "I would like help with TikTok: {wants}.", "ar": "أريد مساعدة في تيك توك: {wants}."},
}

SUBJECT_MIN = 3
SUBJECT_MAX = 120
MESSAGE_MAX = 2000
MAX_OPEN_TICKETS = 20
MAX_MESSAGES = 50
REOPEN_DAYS = 7
PAGE_DEFAULT = 20
PAGE_MAX = 50

CREATES_PER_HOUR = 10
CUSTOMER_WRITES_PER_MINUTE = 20
STAFF_WRITES_PER_MINUTE = 60
READS_PER_MINUTE = 120

CREATE_FIELDS = ("subject", "category", "relatedType", "relatedId", "message", "operationId")
MESSAGE_FIELDS = ("text", "operationId")
OPERATION_FIELDS = ("operationId",)
STAFF_STATUS_FIELDS = ("status", "operationId")

_OPERATION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,119}")  # as ad_campaign_actions (PLAN.md §7.3)
_TICKET_ID_RE = re.compile(r"tkt_[0-9a-f]{40}")
_ENTITY_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
_CURSOR_RE = re.compile(r"([01]):([0-9]{1,15}):(tkt_[0-9a-f]{40})")
_CONTROL_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")  # every control character but the line break
_BLANK_LINES_RE = re.compile(r"\n{3,}")
# A TikTok username: letters, digits, underscores and periods, 2-24 long, no period at the end (TikTok's
# own rule); accepted bare, with a leading @, or inside the profile link tiktok.com/@name.
_TIKTOK_HANDLE_RE = re.compile(r"[A-Za-z0-9_.]{2,24}")
_TIKTOK_URL_RE = re.compile(
    r"(?:https?://)?(?:[a-z]{1,3}\.)?tiktok\.com/@([A-Za-z0-9_.]{2,24})/?(?:[?#].*)?", re.IGNORECASE | re.DOTALL,
)

_SQLITE_WRITE_LOCK = threading.RLock()


def utc_now() -> datetime:
    """The clock of the help desk (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ small helpers


def _parse(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw or len(raw) > 40:
        return None
    try:
        moment = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _text_or_none(value: Any, limit: int = 64) -> str | None:
    return value if isinstance(value, str) and value and len(value) <= limit else None


def _one_of(value: Any, allowed: tuple[str, ...], default: str) -> str:
    return value if isinstance(value, str) and value in allowed else default


def _whole(value: Any) -> int:
    try:
        return max(int(value), 0) if not isinstance(value, bool) else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def ticket_number(seq: int) -> str:
    return f"{NUMBER_PREFIX}{int(seq):0{NUMBER_DIGITS}d}"


def ticket_id(owner_id: str, operation_id: str) -> str:
    return derived_id(TICKET_ID_PREFIX, owner_id, operation_id)


def message_id(ticket: str, operation_id: str) -> str:
    return derived_id(MESSAGE_ID_PREFIX, ticket, operation_id)


def audience_for(category: str) -> str:
    return AUDIENCE_ADMIN if category in ADMIN_CATEGORIES else AUDIENCE_STAFF


def clean_text(raw: Any, *, multiline: bool) -> str | None:
    """Plain text as stored: no angle brackets (as every stored text), no control characters, no
    lone surrogates; one line collapsed to single spaces, or several lines with at most one blank
    line between them. None when ``raw`` is not a string."""
    if not isinstance(raw, str):
        return None
    value = raw.encode("utf-8", "ignore").decode("utf-8").replace("<", "").replace(">", "")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if not multiline:
        return " ".join(_CONTROL_RE.sub(" ", value.replace("\n", " ")).split())
    lines = [line.rstrip() for line in _CONTROL_RE.sub(" ", value).split("\n")]
    return _BLANK_LINES_RE.sub("\n\n", "\n".join(lines)).strip()


def _fingerprint(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(list(parts), ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _is_postgres(conn: Any) -> bool:
    return conn.dialect.name == "postgresql"


@contextmanager
def write_transaction() -> Iterator[Any]:
    """One transaction for a help-desk change. On SQLite the writers of this module queue on one
    lock (taken BEFORE the connection, like the other SQLite write locks); PostgreSQL relies on its
    row locks."""
    guard = nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else _SQLITE_WRITE_LOCK
    with guard, db_conn() as conn:
        yield conn


# ------------------------------------------------------------------ rows


def _select(conn: Any, entity_type: str, row_id: str, *, lock: bool = False) -> Any:
    suffix = " FOR UPDATE" if lock and _is_postgres(conn) else ""
    return conn.execute(
        text(
            "SELECT id, data_json, deleted, created_at, created_by, last_modified FROM entities "
            f"WHERE type = :type AND id = :id LIMIT 1{suffix}"
        ),
        {"type": entity_type, "id": row_id},
    ).mappings().first()


def _data(row: Any) -> dict[str, Any]:
    if not row:
        return {}
    try:
        data = json_loads(row["data_json"] or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _insert(conn: Any, entity_type: str, row_id: str, data: dict[str, Any], owner: str | None, stamp: int) -> bool:
    data.update({"id": row_id, "recordType": entity_type, "_created": stamp, "_lastModified": stamp, "_deleted": False})
    result = conn.execute(
        text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp) ON CONFLICT (type, id) DO NOTHING"
        ),
        {"type": entity_type, "id": row_id, "data": json_dumps(data), "stamp": stamp, "owner": owner},
    )
    return int(result.rowcount or 0) == 1


def _update(conn: Any, entity_type: str, row: Any, data: dict[str, Any]) -> None:
    """Write ``data`` back only if nobody wrote the row since it was read (409 otherwise)."""
    baseline = int(row["last_modified"] or 0)
    modified = max(now_ms(), baseline + 1)
    data["_lastModified"] = modified
    result = conn.execute(
        text(
            "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
            "WHERE type = :type AND id = :id AND last_modified = :baseline"
        ),
        {"data": json_dumps(data), "modified": modified, "type": entity_type, "id": str(row["id"]), "baseline": baseline},
    )
    if int(result.rowcount or 0) != 1:
        studio_error(409, "VERSION_CONFLICT", "This ticket changed at the same moment. Reload it and try again.")


# ------------------------------------------------------------------ numbers


def _highest_number(conn: Any) -> int:
    rows = conn.execute(
        text(f"SELECT {json_field_sql('seq')} AS seq FROM entities WHERE type = :type"),
        {"type": SUPPORT_TICKETS_TYPE},
    ).mappings().all()
    return max((_whole(row["seq"]) for row in rows), default=0)


def _lock_counter(conn: Any) -> tuple[Any, int]:
    """The counter row, locked until the transaction ends, and its value (created when missing)."""
    row = _select(conn, STUDIO_COUNTERS_TYPE, COUNTER_ID, lock=True)
    if row is None:
        _insert(conn, STUDIO_COUNTERS_TYPE, COUNTER_ID, {"counter": SUPPORT_TICKETS_TYPE, "value": _highest_number(conn)},
                None, now_ms())
        row = _select(conn, STUDIO_COUNTERS_TYPE, COUNTER_ID, lock=True)
    value = _whole(_data(row).get("value"))
    if bool(row["deleted"]):
        value = max(value, _highest_number(conn))  # a restored or hand-deleted counter never hands out a used number
    return row, value


def _advance_counter(conn: Any, row: Any, value: int) -> int:
    seq = value + 1
    data = {**_data(row), "counter": SUPPORT_TICKETS_TYPE, "value": seq, "_deleted": False}
    _update(conn, STUDIO_COUNTERS_TYPE, row, data)
    return seq


# ------------------------------------------------------------------ views


def reopen_until(data: dict[str, Any]) -> str | None:
    if data.get("status") != "resolved":
        return None
    resolved = _parse(data.get("resolvedAt"))
    return iso(resolved + timedelta(days=REOPEN_DAYS)) if resolved else None


def _can_reopen(data: dict[str, Any], now: datetime) -> bool:
    resolved = _parse(data.get("resolvedAt"))
    return resolved is None or now <= resolved + timedelta(days=REOPEN_DAYS)


def ticket_view(data: dict[str, Any], *, staff: bool = False, now: datetime | None = None) -> dict[str, Any]:
    """What the customer (or, with ``staff``, the team) sees of a stored ticket; every field is read
    back through its rule, so a hand-edited row never reaches a screen as something else."""
    status = _one_of(data.get("status"), STATUSES, "open")
    category = _one_of(data.get("category"), CATEGORIES, "other")
    related_type = _one_of(data.get("relatedType"), RELATED_TYPES, "")
    out = {
        "id": str(data.get("id") or ""),
        "number": _text_or_none(data.get("number"), 24) or "",
        "subject": data.get("subject") if isinstance(data.get("subject"), str) else "",
        "category": category,
        "status": status,
        "audience": AUDIENCE_ADMIN if data.get("audience") == AUDIENCE_ADMIN else AUDIENCE_STAFF,
        "priority": _one_of(data.get("priority"), PRIORITIES, "normal"),
        "kind": _one_of(data.get("kind"), KINDS, "question"),
        "relatedType": related_type or None,
        "relatedId": _text_or_none(data.get("relatedId"), 80) if related_type else None,
        "createdAt": _text_or_none(data.get("createdAt")),
        "updatedAt": _text_or_none(data.get("updatedAt")),
        "dueAt": _text_or_none(data.get("dueAt")) if status == "open" else None,
        "lastMessageAt": _text_or_none(data.get("lastMessageAt")),
        "resolvedAt": _text_or_none(data.get("resolvedAt")) if status == "resolved" else None,
        "reopenUntil": reopen_until({**data, "status": status}),
    }
    if staff:
        due = _parse(out["dueAt"])
        out.update({
            "ownerId": _text_or_none(data.get("ownerId"), 80),
            "firstStaffAt": _text_or_none(data.get("firstStaffAt")),
            "lastCustomerAt": _text_or_none(data.get("lastCustomerAt")),
            "lastStaffAt": _text_or_none(data.get("lastStaffAt")),
            "messageCount": _whole(data.get("messageCount")),
            "overdue": bool(due and due < (now or utc_now())),
        })
    if out["kind"] == TIKTOK_KIND:
        out["tiktok"] = tiktok_view(data)
    return out


def tiktok_view(data: dict[str, Any]) -> dict[str, Any]:
    """The service part of a TikTok request ticket, read back through its rules."""
    handle = tiktok_handle(data.get("tiktokHandle")) or ""
    state = _one_of(data.get("tiktokState"), TIKTOK_STATES, "open")
    wants = data.get("tiktokWants") if isinstance(data.get("tiktokWants"), list) else []
    note = data.get("tiktokNote") if isinstance(data.get("tiktokNote"), dict) else None
    return {
        "handle": handle,
        "profileUrl": TIKTOK_PROFILE_URL.format(handle=handle) if handle else None,
        "wants": [want for want in TIKTOK_WANTS if want in wants],
        "state": state,
        "stateLabels": dict(TIKTOK_TEXTS["states"][state]),
        "note": {lang: note.get(lang) if isinstance(note.get(lang), str) else "" for lang in ("en", "ar")} if note else None,
        "stateAt": _text_or_none(data.get("tiktokStateAt")),
    }


def tiktok_handle(raw: Any) -> str | None:
    """The username of a TikTok handle as typed (``name``, ``@name`` or ``tiktok.com/@name``), or None."""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    link = _TIKTOK_URL_RE.fullmatch(value)
    if link:
        value = link.group(1)
    elif value.startswith("@"):
        value = value[1:]
    if not _TIKTOK_HANDLE_RE.fullmatch(value) or value.endswith(".") or not TIKTOK_HANDLE_MIN <= len(value) <= TIKTOK_HANDLE_MAX:
        return None
    return value


def message_view(data: dict[str, Any], *, staff: bool = False) -> dict[str, Any]:
    out = {
        "id": str(data.get("id") or ""),
        "from": "team" if data.get("author") == "team" else "customer",
        "text": data.get("text") if isinstance(data.get("text"), str) else "",
        "createdAt": _text_or_none(data.get("createdAt")),
    }
    if staff:
        out["authorId"] = _text_or_none(data.get("authorUserId"), 80)
    return out


# ------------------------------------------------------------------ reads


def _ticket_messages(conn: Any, ticket_row: Any) -> list[dict[str, Any]]:
    where = f"type = :type AND deleted = false AND {json_field_sql('ticketId')} = :ticket"
    params = {"type": SUPPORT_TICKET_MESSAGES_TYPE, "ticket": str(ticket_row["id"])}
    if ticket_row["created_by"]:
        where += " AND created_by = :owner"  # the messages carry the ticket owner's created_by (indexed)
        params["owner"] = str(ticket_row["created_by"])
    rows = conn.execute(text(f"SELECT id, data_json, created_at FROM entities WHERE {where}"), params).mappings().all()
    items = [({**_data(row), "id": str(row["id"])}, int(row["created_at"] or 0)) for row in rows]
    items.sort(key=lambda item: (_whole(item[0].get("seq")), item[1], item[0]["id"]))
    return [item for item, _created in items]


def load_ticket(conn: Any, row_id: str, *, owner_id: str | None = None, admin: bool = False, lock: bool = False) -> tuple[Any, dict[str, Any]]:
    """The live ticket this viewer may see, else 404 UNKNOWN_TICKET. ``owner_id``: a customer (only
    their own); None: staff (``admin`` False = a reviewer, who never sees an admin-audience ticket)."""
    row = _select(conn, SUPPORT_TICKETS_TYPE, row_id, lock=lock) if _TICKET_ID_RE.fullmatch(str(row_id or "")) else None
    data = _data(row)
    visible = bool(row) and not bool(row["deleted"])
    if visible and owner_id is not None:
        visible = bool(owner_id) and str(row["created_by"] or "") == owner_id
    elif visible and not admin:
        visible = data.get("audience") == AUDIENCE_STAFF
    if not visible:
        studio_error(404, "UNKNOWN_TICKET", "Ticket not found")
    data["id"] = str(row["id"])
    return row, data


def _parse_cursor(raw: Any) -> tuple[int, int, str] | None:
    if raw is None or raw == "":
        return None
    match = _CURSOR_RE.fullmatch(str(raw).strip())
    if not match:
        studio_error(400, "INVALID_VALUE", "cursor must be the nextCursor value of the previous page")
    return int(match.group(1)), int(match.group(2)), match.group(3)


def list_tickets_page(
    conn: Any,
    *,
    owner_id: str | None = None,
    admin: bool = False,
    status: str | None = None,
    priority: str | None = None,
    kind: str | None = None,
    tiktok_state: str | None = None,
    cursor: tuple[int, int, str] | None = None,
    limit: int = PAGE_DEFAULT,
    now: datetime | None = None,
) -> dict[str, Any]:
    """A page of tickets: the owner's own (``owner_id``, newest first) or the team queue (unresolved
    urgent tickets first, then newest first; reviewers only ``audience: 'staff'``). ``kind`` narrows
    to one ticket kind and ``tiktok_state`` (a TIKTOK_STATE_FILTERS value) to one service state."""
    status_sql, priority_sql = json_field_sql("status"), json_field_sql("priority")
    where = ["type = :type", "deleted = false"]
    params: dict[str, Any] = {"type": SUPPORT_TICKETS_TYPE, "limit": int(limit) + 1}
    staff = owner_id is None
    if not staff:
        where.append("created_by = :uid")
        params["uid"] = owner_id
    elif not admin:
        where.append(f"{json_field_sql('audience')} = 'staff'")
    if status == "active":
        where.append(f"COALESCE({status_sql}, '') <> 'resolved'")
    elif status:
        where.append(f"{status_sql} = :status")
        params["status"] = status
    if priority:
        where.append(f"COALESCE({priority_sql}, 'normal') = :priority")
        params["priority"] = priority
    if kind:
        where.append(f"COALESCE({json_field_sql('kind')}, 'question') = :kind")
        params["kind"] = kind
    if tiktok_state == "active":
        where.append(f"COALESCE({json_field_sql('tiktokState')}, 'open') IN ('open', 'in_progress')")
    elif tiktok_state:
        where.append(f"COALESCE({json_field_sql('tiktokState')}, 'open') = :tiktok_state")
        params["tiktok_state"] = tiktok_state
    rank = f"(CASE WHEN {priority_sql} = 'urgent' AND COALESCE({status_sql}, '') <> 'resolved' THEN 1 ELSE 0 END)" if staff else "0"
    if cursor is not None:
        where.append(f"({rank} < :cp OR ({rank} = :cp AND (created_at < :cc OR (created_at = :cc AND id < :cid))))")
        params.update({"cp": cursor[0], "cc": cursor[1], "cid": cursor[2]})
    order = f"{rank} DESC, created_at DESC, id DESC" if staff else "created_at DESC, id DESC"  # ORDER BY 0 = a column number
    rows = conn.execute(
        text(
            f"SELECT id, data_json, created_at, {rank} AS pinned FROM entities WHERE {' AND '.join(where)} "
            f"ORDER BY {order} LIMIT :limit"
        ),
        params,
    ).mappings().all()
    page = rows[: int(limit)]
    last = page[-1] if page and len(rows) > int(limit) else None
    return {
        "tickets": [ticket_view({**_data(row), "id": str(row["id"])}, staff=staff, now=now) for row in page],
        "nextCursor": f"{int(last['pinned'])}:{int(last['created_at'])}:{last['id']}" if last else None,
    }


def count_open_tickets(conn: Any, owner_id: str) -> int:
    """The owner's unresolved tickets (the TICKET_OPEN_LIMIT count)."""
    return int(conn.execute(
        text(
            "SELECT COUNT(*) FROM entities WHERE type = :type AND created_by = :uid AND deleted = false "
            f"AND COALESCE({json_field_sql('status')}, '') <> 'resolved'"
        ),
        {"type": SUPPORT_TICKETS_TYPE, "uid": str(owner_id or "")},
    ).scalar() or 0)


def count_open_tiktok_requests(conn: Any, owner_id: str) -> int:
    """The owner's TikTok requests still open or in progress (the MAX_OPEN_TIKTOK_REQUESTS count)."""
    rows = conn.execute(
        text(json_fields_select_sql(("kind", "tiktokState"), (), "type = :type AND created_by = :uid AND deleted = false")),
        {"type": SUPPORT_TICKETS_TYPE, "uid": str(owner_id or "")},
    ).mappings().all()
    return sum(
        1 for row in rows
        if str(row.get("f_kind") or "") == TIKTOK_KIND and str(row.get("f_tiktokstate") or "open") in TIKTOK_OPEN_STATES
    )


def tripoli_day_start(now: datetime) -> datetime:
    """Midnight of ``now``'s Tripoli day (the TikTok day count's window)."""
    zone = service_zone()
    moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime.combine(moment.astimezone(zone).date(), time.min, tzinfo=zone)


def count_tiktok_requests_today(conn: Any, owner_id: str, now: datetime) -> int:
    """The owner's TikTok requests CREATED since the start of the Tripoli day (the TIKTOK_CREATES_PER_DAY
    count): only a request that exists counts, never a refused body or a replay."""
    return int(conn.execute(
        text(
            "SELECT COUNT(*) FROM entities WHERE type = :type AND created_by = :uid AND deleted = false "
            f"AND created_at >= :since AND COALESCE({json_field_sql('kind')}, 'question') = :kind"
        ),
        {"type": SUPPORT_TICKETS_TYPE, "uid": str(owner_id or ""), "kind": TIKTOK_KIND,
         "since": int(tripoli_day_start(now).timestamp() * 1000)},
    ).scalar() or 0)


def staff_ticket_counts(conn: Any | None = None, *, include_admin: bool, now: datetime | None = None) -> dict[str, int]:
    """Counts for the staff pulse (P3-17), no texts: ``open`` (waiting for the team), ``overdue``
    (waiting past dueAt), ``urgent`` (unresolved stop requests and other urgent tickets),
    ``active`` (not resolved) and ``stopOpen`` (the part of ``open`` that is a stop request's own
    ticket, kind ``stop_request``: the desk subtracts it from the open stop requests so one stop
    request is counted once, not as a ticket AND a queue row). Reviewers' counts leave out
    admin-audience tickets."""
    if conn is None:
        with db_conn() as own:
            return staff_ticket_counts(own, include_admin=include_admin, now=now)
    now = now or utc_now()
    unresolved = f"type = :type AND deleted = false AND COALESCE({json_field_sql('status')}, '') <> 'resolved'"  # resolved rows only grow
    rows = conn.execute(
        text(json_fields_select_sql(("status", "audience", "priority", "dueAt", "kind"), ("id",), unresolved)),
        {"type": SUPPORT_TICKETS_TYPE},
    ).mappings().all()
    counts = {"open": 0, "overdue": 0, "urgent": 0, "active": 0, "stopOpen": 0}
    for row in rows:
        if not include_admin and row.get("f_audience") != AUDIENCE_STAFF:
            continue
        status = str(row.get("f_status") or "")
        if status == "resolved":
            continue
        counts["active"] += 1
        counts["urgent"] += row.get("f_priority") == "urgent"
        if status in ("", "open"):
            counts["open"] += 1
            counts["stopOpen"] += row.get("f_kind") == "stop_request"
            due = _parse(row.get("f_dueat"))
            counts["overdue"] += bool(due and due < now)
    return counts


# ------------------------------------------------------------------ changes


def _due(data: dict[str, Any], start: datetime, settings: dict[str, Any]) -> str | None:
    """When the team owes its first answer: the stop-request target for an urgent ticket, the TikTok
    service's own ``tiktokBusinessDays`` for a TikTok request (P5-01: 'within one business day'),
    else the plain ticket target."""
    if data.get("priority") == "urgent":
        target = "stop_request"
    else:
        target = "tiktok" if data.get("kind") == TIKTOK_KIND else "ticket"
    return iso(target_due_at(target, start, settings))


def _set_status(data: dict[str, Any], status: str, *, by: str, now: datetime, settings: dict[str, Any]) -> None:
    """Move the stored ticket to ``status`` (by 'customer', 'team' or 'system') with its times."""
    was = data.get("status")
    at = iso(now)
    if status == "open":
        if was != "open" or not data.get("dueAt"):
            data["dueAt"] = _due(data, now, settings)  # the team's clock starts again
        if was == "resolved":
            data["reopenedAt"] = at
    else:
        data["dueAt"] = None
    if status == "resolved":
        if was != "resolved":
            data["resolvedAt"] = at
            data["resolvedBy"] = by
    else:
        data["resolvedAt"] = None
    data["status"] = status
    data["updatedAt"] = at


def open_ticket_conn(
    conn: Any,
    *,
    owner_id: str,
    operation_id: str,
    subject: str,
    category: str,
    message: str,
    related_type: str | None = None,
    related_id: str | None = None,
    priority: str = "normal",
    kind: str = "question",
    enforce_open_limit: bool = True,
    extra: dict[str, Any] | None = None,
    settings: dict[str, Any],
    now: datetime | None = None,
    audit: Callable[[Any, str, str, str, dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Open a ticket with its first message on the caller's transaction; returns (ticket data, first
    message data, created). The same operationId again returns the first result (created False), or
    409 IDEMPOTENCY_MISMATCH when anything differs. ``settings``: read_all_settings(), read BEFORE the
    transaction. ``audit(conn, action, ticket id, message, metadata)`` joins the transaction.
    ``extra``: more fields stored on the ticket (a TikTok request's service fields), part of the
    replay fingerprint. The texts and the related item must already be checked (clean_create_body,
    check_related)."""
    uid = str(owner_id or "")
    if not uid or not _OPERATION_ID_RE.fullmatch(str(operation_id or "")):
        raise ValueError("open_ticket_conn needs an owner and a valid operationId")
    if category not in CATEGORIES or priority not in PRIORITIES or kind not in KINDS:
        raise ValueError("open_ticket_conn: unknown category, priority or kind")
    if bool(related_type) != bool(related_id) or (related_type and related_type not in RELATED_TYPES):
        raise ValueError("open_ticket_conn: relatedType and relatedId go together")
    now = now or utc_now()
    row_id = ticket_id(uid, operation_id)
    first_id = message_id(row_id, operation_id)
    extra = dict(extra or {})
    fingerprint = _fingerprint(subject, category, related_type or "", related_id or "", message, priority, kind,
                               *([sorted(extra.items())] if extra else []))
    counter_row, value = _lock_counter(conn)  # every open queues here first: numbers and the cap stay exact
    existing = _select(conn, SUPPORT_TICKETS_TYPE, row_id)
    if existing is not None:
        data = _data(existing)
        if bool(existing["deleted"]) or data.get("createFingerprint") != fingerprint:
            studio_error(409, "IDEMPOTENCY_MISMATCH", "This operationId was already used for a different ticket")
        first = _data(_select(conn, SUPPORT_TICKET_MESSAGES_TYPE, first_id))
        return {**data, "id": row_id}, {**first, "id": first_id}, False
    if enforce_open_limit and count_open_tickets(conn, uid) >= MAX_OPEN_TICKETS:
        studio_error(409, "TICKET_OPEN_LIMIT", f"You already have {MAX_OPEN_TICKETS} open tickets. Resolve one, then open a new one.")
    if kind == TIKTOK_KIND and count_open_tiktok_requests(conn, uid) >= MAX_OPEN_TIKTOK_REQUESTS:
        studio_error(409, "TICKET_OPEN_LIMIT",
                     f"You already have {MAX_OPEN_TIKTOK_REQUESTS} TikTok requests in progress. Wait for the team, then send a new one.")
    if kind == TIKTOK_KIND and count_tiktok_requests_today(conn, uid, now) >= TIKTOK_CREATES_PER_DAY:
        # Counted on the created rows (the counter row is locked): a refused body or a replay never uses a place.
        next_day = tripoli_day_start(now) + timedelta(days=1)
        studio_error(429, "RATE_LIMITED",
                     f"At most {TIKTOK_CREATES_PER_DAY} TikTok requests a day. Please send the next one tomorrow.",
                     headers={"Retry-After": str(max(1, int((next_day - now).total_seconds())))})
    seq = _advance_counter(conn, counter_row, value)
    at = iso(now)
    owner = created_by_or_none(conn, uid)
    ticket: dict[str, Any] = {
        **extra,
        "number": ticket_number(seq), "seq": seq, "ownerId": uid, "subject": subject, "category": category,
        "audience": audience_for(category), "priority": priority, "kind": kind,
        "relatedType": related_type or None, "relatedId": related_id or None,
        "status": "open", "createdAt": at, "updatedAt": at, "dueAt": None, "lastMessageAt": at,
        "lastCustomerAt": at, "lastStaffAt": None, "firstStaffAt": None, "resolvedAt": None,
        "messageCount": 1, "operationId": operation_id, "createFingerprint": fingerprint,
    }
    if kind == TIKTOK_KIND:  # the service starts open at the ticket's own time (never part of the replay fingerprint)
        ticket.update({"tiktokState": "open", "tiktokStateAt": at, "tiktokNote": None})
    ticket["dueAt"] = _due(ticket, now, settings)
    first = {"ticketId": row_id, "ownerId": uid, "seq": 1, "author": "customer", "authorUserId": uid,
             "text": message, "createdAt": at, "operationId": operation_id}
    stamp = now_ms()
    if not _insert(conn, SUPPORT_TICKETS_TYPE, row_id, ticket, owner, stamp) or not _insert(
        conn, SUPPORT_TICKET_MESSAGES_TYPE, first_id, first, owner, stamp
    ):
        studio_error(409, "IDEMPOTENCY_MISMATCH", "This operationId was already used for a different ticket")
    if audit is not None:
        audit(conn, "ticket_create", row_id, f"Ticket {ticket['number']} opened ({category})", {
            "number": ticket["number"], "category": category, "audience": ticket["audience"], "priority": priority,
            "kind": kind, "relatedType": ticket["relatedType"], "relatedId": ticket["relatedId"],
        })
    return ticket, first, True


def open_ticket(owner_id: str, *, settings: dict[str, Any] | None = None, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """``open_ticket_conn`` in its own transaction (settings read first when not given)."""
    settings = settings if settings is not None else read_all_settings()
    with write_transaction() as conn:
        return open_ticket_conn(conn, owner_id=owner_id, settings=settings, **kwargs)


def _refuse_reopen_past_cap(conn: Any, owner_id: str) -> None:
    """A customer's reopen of a resolved ticket counts against MAX_OPEN_TICKETS like a new ticket (409
    TICKET_OPEN_LIMIT). The counter row is locked first, as open_ticket_conn does, so parallel reopens
    and opens count the same rows and never pass the cap together."""
    _lock_counter(conn)
    if count_open_tickets(conn, owner_id) >= MAX_OPEN_TICKETS:
        studio_error(409, "TICKET_OPEN_LIMIT", f"You already have {MAX_OPEN_TICKETS} open tickets. Resolve one before reopening this ticket.")


def _customer_reopens_service(conn: Any, owner_id: str, data: dict[str, Any], now: datetime) -> None:
    """A customer's reopen of a resolved ticket (the reopen route or a new message) whose TikTok request
    they had cancelled: the service goes back to ``open`` and takes a place among
    MAX_OPEN_TIKTOK_REQUESTS like a new request (409 TICKET_OPEN_LIMIT past the cap). Called after
    _refuse_reopen_past_cap, so the counter row is already locked. Any other ticket: nothing."""
    if data.get("kind") != TIKTOK_KIND or _one_of(data.get("tiktokState"), TIKTOK_STATES, "open") != "cancelled":
        return
    if count_open_tiktok_requests(conn, owner_id) >= MAX_OPEN_TIKTOK_REQUESTS:
        studio_error(409, "TICKET_OPEN_LIMIT",
                     f"You already have {MAX_OPEN_TIKTOK_REQUESTS} TikTok requests in progress. Wait for the team, then reopen this one.")
    _set_tiktok_state(data, "open", now)


def _finish_tiktok_service(data: dict[str, Any], state: str, now: datetime, note: dict[str, str] | None = None) -> str | None:
    """The ONE way a TikTok request's service ends with its ticket: ``state`` done or declined, from a
    request still open or in progress. The TikTok step (tiktok_transition_conn) brings the team's
    bilingual note; a generic team resolve of the ticket (change_status_conn) declines without one, so
    a request never stays 'open' behind a resolved ticket (it counted against the customer's cap for
    ever). Returns the state it left, or None when the service was finished already (nothing changes)."""
    if state not in ("done", "declined"):
        raise ValueError("a TikTok service ends as done or declined")
    current = _one_of(data.get("tiktokState"), TIKTOK_STATES, "open")
    if current not in TIKTOK_OPEN_STATES:
        return None
    _set_tiktok_state(data, state, now, note)
    return current


def post_message_conn(
    conn: Any,
    row_id: str,
    *,
    author: str,
    author_id: str,
    operation_id: str,
    body: str,
    admin: bool = False,
    settings: dict[str, Any],
    now: datetime | None = None,
    audit: Callable[[Any, str, str, str, dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Add a message by the owner (``author`` 'customer') or the team ('team'); returns (ticket data,
    message data, created). A customer's message moves the ticket to ``open`` (reopening a resolved
    one within REOPEN_DAYS, and only inside the open-ticket cap), a team answer to ``answered`` and
    puts the ``ticket_answered`` item in the owner's inbox (studio_activity, P3-05) on the same
    transaction; a replay adds no second item."""
    if author not in ("customer", "team"):
        raise ValueError("author must be 'customer' or 'team'")
    now = now or utc_now()
    owner_filter = str(author_id or "") if author == "customer" else None
    row, data = load_ticket(conn, row_id, owner_id=owner_filter, admin=admin, lock=True)
    was = data.get("status")
    message, created = _append_message(conn, row, data, author=author, author_id=author_id, operation_id=operation_id,
                                       body=body, now=now, settings=settings)
    if not created:
        return data, message, False
    _update(conn, SUPPORT_TICKETS_TYPE, row, data)
    if audit is not None:
        audit(conn, "ticket_message", row_id, f"Ticket {data.get('number')}: {author} message", {
            "number": data.get("number"), "from": author, "statusBefore": was, "status": data["status"],
        })
    return data, message, True


def _append_message(
    conn: Any,
    row: Any,
    data: dict[str, Any],
    *,
    author: str,
    author_id: str,
    operation_id: str,
    body: str,
    now: datetime,
    settings: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Insert one message of the locked ticket ``row`` and move ``data`` (status, counts, times) for
    it; the caller writes the ticket back. Returns (message data, created): a replay of the
    operationId returns the stored message (created False), a different content is 409."""
    row_id = str(row["id"])
    new_id = message_id(row_id, operation_id)
    existing = _select(conn, SUPPORT_TICKET_MESSAGES_TYPE, new_id)
    if existing is not None:
        old = _data(existing)
        if bool(existing["deleted"]) or old.get("text") != body or old.get("author") != author:
            studio_error(409, "IDEMPOTENCY_MISMATCH", "This operationId was already used for a different message")
        return {**old, "id": new_id}, False
    if author == "customer" and data.get("status") == "resolved":
        if not _can_reopen(data, now):
            studio_error(409, "TICKET_CLOSED", f"This ticket was resolved more than {REOPEN_DAYS} days ago. Open a new ticket.")
        _refuse_reopen_past_cap(conn, str(row["created_by"] or ""))
        _customer_reopens_service(conn, str(row["created_by"] or ""), data, now)  # a cancelled TikTok request opens again
    count = _whole(data.get("messageCount"))
    if count >= MAX_MESSAGES:
        studio_error(409, "TICKET_MESSAGE_LIMIT", f"This ticket already holds {MAX_MESSAGES} messages. Open a new ticket.")
    at = iso(now)
    if author == "customer":
        _set_status(data, "open", by="customer", now=now, settings=settings)
        data["lastCustomerAt"] = at
    else:
        _set_status(data, "answered", by="team", now=now, settings=settings)
        data["lastStaffAt"] = at
        data["firstStaffAt"] = data.get("firstStaffAt") or at
    data.update({"messageCount": count + 1, "lastMessageAt": at})
    message = {"ticketId": row_id, "ownerId": data.get("ownerId"), "seq": count + 1, "author": author,
               "authorUserId": str(author_id or "") or None, "text": body, "createdAt": at, "operationId": operation_id}
    if not _insert(conn, SUPPORT_TICKET_MESSAGES_TYPE, new_id, message, row["created_by"], now_ms()):
        studio_error(409, "IDEMPOTENCY_MISMATCH", "This operationId was already used for a different message")
    if author == "team":
        from .studio_activity import record_activity  # late, as ad_campaign_actions does (no import cycle either way)

        # One inbox item per team answer (the message's operationId is its key; a replay returned above); a
        # scrubbed owner gets none. TikTok status notes by the team (status route) reach the inbox the same way.
        record_activity(conn, owner_id=row["created_by"] or data.get("ownerId"), kind="ticket_answered",
                        related_type="ticket", related_id=row_id, key=operation_id, at=now,
                        params={"number": data.get("number")})
    return {**message, "id": new_id}, True


def change_status_conn(
    conn: Any,
    row_id: str,
    status: str,
    *,
    by: str,
    actor_id: str,
    operation_id: str | None = None,
    admin: bool = False,
    settings: dict[str, Any],
    now: datetime | None = None,
    audit: Callable[[Any, str, str, str, dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], bool]:
    """Move a ticket to ``status``; returns (ticket data, changed). ``by`` 'customer' may only
    resolve or reopen (open) their own ticket, reopening within REOPEN_DAYS and only inside the
    open-ticket cap (409 TICKET_OPEN_LIMIT); 'team' may set any status. The state it already has is
    a no-op (nothing written, nothing audited).

    A TikTok request's service follows the ticket (P5-01): a customer's resolve cancels an open
    request and their reopen puts a cancelled one back to open (inside the TikTok cap); a team
    resolve ends an open or in-progress request as declined through _finish_tiktok_service, the
    same function the TikTok status route uses, so no request stays open behind a resolved ticket."""
    if status not in STATUSES or by not in ("customer", "team"):
        raise ValueError("unknown status or actor")
    now = now or utc_now()
    row, data = load_ticket(conn, row_id, owner_id=str(actor_id or "") if by == "customer" else None, admin=admin, lock=True)
    was = data.get("status")
    owner_id = str(row["created_by"] or "")
    if by == "customer":
        if status not in ("resolved", "open"):
            raise ValueError("a customer only resolves or reopens")
        if status == "open" and was != "resolved":
            return data, False  # reopen of a ticket that is not resolved: nothing to do
        if status == "open" and not _can_reopen(data, now):
            studio_error(409, "TICKET_CLOSED", f"This ticket was resolved more than {REOPEN_DAYS} days ago. Open a new ticket.")
        if status == "open":
            _refuse_reopen_past_cap(conn, owner_id)
    if was == status:
        return data, False
    service_before: str | None = None
    if data.get("kind") == TIKTOK_KIND:
        if by == "customer" and status == "resolved" and _one_of(data.get("tiktokState"), TIKTOK_STATES, "open") == "open":
            _set_tiktok_state(data, "cancelled", now)  # the customer withdraws an open request
            service_before = "open"
        elif by == "customer" and status == "open":
            service_before = _one_of(data.get("tiktokState"), TIKTOK_STATES, "open")
            _customer_reopens_service(conn, owner_id, data, now)
            service_before = service_before if service_before != data.get("tiktokState") else None
        elif by == "team" and status == "resolved":
            service_before = _finish_tiktok_service(data, "declined", now)  # never left open behind a resolved ticket
    _set_status(data, status, by=by, now=now, settings=settings)
    if operation_id:
        data["lastStatusOperationId"] = operation_id
    _update(conn, SUPPORT_TICKETS_TYPE, row, data)
    if audit is not None:
        metadata = {"number": data.get("number"), "by": by, "statusBefore": was, "status": status}
        if service_before is not None:
            metadata.update({"tiktokStateBefore": service_before, "tiktokState": data.get("tiktokState")})
        audit(conn, "ticket_status", row_id, f"Ticket {data.get('number')}: {was} -> {status}", metadata)
    return data, True


def _set_tiktok_state(data: dict[str, Any], state: str, now: datetime, note: dict[str, str] | None = None) -> None:
    data["tiktokState"] = state
    data["tiktokStateAt"] = iso(now)
    if note is not None:
        data["tiktokNote"] = {"en": note["en"], "ar": note["ar"]}


def tiktok_transition_conn(
    conn: Any,
    row_id: str,
    state: str,
    *,
    note: dict[str, str],
    actor_id: str,
    operation_id: str,
    admin: bool = False,
    settings: dict[str, Any],
    now: datetime | None = None,
    audit: Callable[[Any, str, str, str, dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
    """The team moves a TikTok request to ``state`` (TIKTOK_TRANSITIONS) with a bilingual ``note``
    ``{en, ar}``, appended to the thread as a team message; ``done`` and ``declined`` resolve the
    ticket. Returns (ticket data, the note's message or None, changed). The state it already has, or
    a replay of the operationId, changes nothing (200)."""
    if state not in TIKTOK_STATES or state == "cancelled":
        raise ValueError("a TikTok request moves to in_progress, done or declined")
    now = now or utc_now()
    row, data = load_ticket(conn, row_id, admin=admin, lock=True)
    if data.get("kind") != TIKTOK_KIND:
        studio_error(404, "UNKNOWN_TICKET", "Ticket not found")
    current = _one_of(data.get("tiktokState"), TIKTOK_STATES, "open")
    existing = _select(conn, SUPPORT_TICKET_MESSAGES_TYPE, message_id(row_id, operation_id))
    if existing is not None and not bool(existing["deleted"]):
        return data, {**_data(existing), "id": message_id(row_id, operation_id)}, False  # the same step, sent again
    if current == state:
        return data, None, False
    if current not in TIKTOK_TRANSITIONS:
        studio_error(409, "TICKET_CLOSED", f"This TikTok request is already {current}. Ask the customer for a new request.")
    if state not in TIKTOK_TRANSITIONS[current]:
        studio_error(400, "INVALID_VALUE", "status must follow open -> in_progress -> done or declined (declined is allowed from open too)")
    message, _created = _append_message(conn, row, data, author="team", author_id=actor_id, operation_id=operation_id,
                                        body=f"{note['en']}\n\n{note['ar']}", now=now, settings=settings)
    if state in ("done", "declined"):
        _finish_tiktok_service(data, state, now, note)  # shared with the generic status route
        _set_status(data, "resolved", by="team", now=now, settings=settings)
    else:
        _set_tiktok_state(data, state, now, note)
    data["lastStatusOperationId"] = operation_id
    _update(conn, SUPPORT_TICKETS_TYPE, row, data)
    if audit is not None:
        audit(conn, "tiktok_status", row_id, f"Ticket {data.get('number')}: TikTok request {current} -> {state}", {
            "number": data.get("number"), "stateBefore": current, "state": state, "status": data["status"],
        })
    return data, message, True


def system_resolve_ticket_conn(conn: Any, row_id: str, *, reason: str, now: datetime | None = None) -> dict[str, Any] | None:
    """Resolve a ticket for the system (e.g. a stop request once the ad is Stopped, P3-10), on the
    caller's transaction; the caller audits. Returns the ticket data, or None when there is no such
    live ticket. An already resolved ticket is returned unchanged."""
    row = _select(conn, SUPPORT_TICKETS_TYPE, str(row_id or ""), lock=True) if _TICKET_ID_RE.fullmatch(str(row_id or "")) else None
    if not row or bool(row["deleted"]):
        return None
    data = {**_data(row), "id": str(row["id"])}
    if data.get("status") == "resolved":
        return data
    now = now or utc_now()
    data.update({"status": "resolved", "resolvedAt": iso(now), "resolvedBy": "system", "resolvedReason": str(reason or "")[:60],
                 "dueAt": None, "updatedAt": iso(now)})
    _update(conn, SUPPORT_TICKETS_TYPE, row, data)
    return data


# ------------------------------------------------------------------ request bodies


def _fields_only(body: Any, allowed: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(body, dict):
        studio_error(400, "INVALID_REQUEST", "Send {" + ", ".join(allowed) + "}")
    extra = sorted(str(key) for key in set(body) - set(allowed))
    if extra:
        studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{extra[0][:40]}'. Allowed: {', '.join(allowed)}")
    return body


def _operation_id(body: dict[str, Any], *, required: bool = True) -> str | None:
    value = body.get("operationId")
    if value is None and not required:
        return None
    if not isinstance(value, str) or not _OPERATION_ID_RE.fullmatch(value):
        studio_error(400, "INVALID_VALUE", "operationId must be 8-120 letters, digits, dots, underscores, colons or hyphens")
    return value


def _message_text(value: Any, field: str) -> str:
    body = clean_text(value, multiline=True)
    if not body or len(body) > MESSAGE_MAX:
        studio_error(400, "INVALID_VALUE", f"{field} must be text of 1 to {MESSAGE_MAX} characters")
    return body


def clean_create_body(body: Any) -> dict[str, Any]:
    """The checked fields of a new ticket (texts cleaned; the related item's owner is checked apart)."""
    body = _fields_only(body, CREATE_FIELDS)
    subject = clean_text(body.get("subject"), multiline=False)
    if subject is None or not SUBJECT_MIN <= len(subject) <= SUBJECT_MAX:
        studio_error(400, "INVALID_VALUE", f"subject must be text of {SUBJECT_MIN} to {SUBJECT_MAX} characters")
    category = body.get("category")
    if category not in CATEGORIES:
        studio_error(400, "INVALID_VALUE", "category must be one of: " + ", ".join(CATEGORIES))
    related_type = body.get("relatedType") or None
    related_id = body.get("relatedId") or None
    if related_type is not None and related_type not in RELATED_TYPES:
        studio_error(400, "INVALID_VALUE", "relatedType must be one of: " + ", ".join(RELATED_TYPES))
    if (related_type is None) != (related_id is None):
        studio_error(400, "INVALID_REQUEST", "relatedType and relatedId go together")
    if related_id is not None and (not isinstance(related_id, str) or not _ENTITY_ID_RE.fullmatch(related_id)):
        studio_error(400, "INVALID_VALUE", "relatedId must be the id of the item the ticket is about")
    return {
        "subject": subject, "category": category, "related_type": related_type, "related_id": related_id,
        "message": _message_text(body.get("message"), "message"), "operation_id": _operation_id(body),
    }


def check_related(owner_id: str, related_type: str | None, related_id: str | None) -> None:
    """404 unless the item a ticket is about is the owner's own (PLAN.md §7.5): a request (archived
    ones are gone), a charge request (its id or its PAY- reference, asked through the platform door
    wallet_payments.payment_request_belongs_to: D36, never a read of the payment rows here) or a
    linked page."""
    if not related_type:
        return
    uid = str(owner_id or "")
    if related_type == "page":
        find_owner_page(uid, related_id)  # 404 UNKNOWN_PAGE
        return
    with db_conn() as conn:
        if related_type == "campaign":
            found = conn.execute(
                text("SELECT id FROM entities WHERE type = :type AND id = :id AND created_by = :uid AND deleted = false LIMIT 1"),
                {"type": AD_CAMPAIGN_COLLECTION, "id": related_id, "uid": uid},
            ).first()
            if found is None:
                studio_error(404, "UNKNOWN_CAMPAIGN", "Campaign request not found")
            return
        owned = payment_request_belongs_to(conn, uid, str(related_id or ""))
    if not owned:
        studio_error(404, "UNKNOWN_PAYMENT", "Payment request not found")


def _tiktok_wants(raw: Any) -> list[str]:
    values = [raw] if isinstance(raw, str) else raw
    if not isinstance(values, list) or not values or len(values) > len(TIKTOK_WANTS) or len(set(values)) != len(values) \
            or any(value not in TIKTOK_WANTS for value in values):
        studio_error(400, "INVALID_VALUE", "wants must be one or more of: " + ", ".join(TIKTOK_WANTS))
    return [want for want in TIKTOK_WANTS if want in values]


def tiktok_first_message(wants: list[str]) -> str:
    """The bilingual first message of a request sent without a note (the wants in words)."""
    labels = {lang: "; ".join(TIKTOK_TEXTS["wants"][want][lang] for want in wants) for lang in ("en", "ar")}
    return "\n\n".join(TIKTOK_TEXTS["firstMessage"][lang].format(wants=labels[lang]) for lang in ("en", "ar"))


def clean_tiktok_body(body: Any) -> dict[str, Any]:
    """The checked fields of a new TikTok request: the handle as typed, the wants, the note (or the
    default first message) and the operationId."""
    body = _fields_only(body, TIKTOK_CREATE_FIELDS)
    handle = tiktok_handle(body.get("handle"))
    if handle is None:
        studio_error(400, "INVALID_VALUE",
                     f"handle must be your TikTok username ({TIKTOK_HANDLE_MIN} to {TIKTOK_HANDLE_MAX} letters, digits, "
                     "underscores or periods, not ending with a period), with or without @, or your profile link")
    wants = _tiktok_wants(body.get("wants"))
    note = None
    if body.get("note") not in (None, ""):
        note = clean_text(body.get("note"), multiline=True)
        if not note or len(note) > TIKTOK_CUSTOMER_NOTE_MAX:
            studio_error(400, "INVALID_VALUE", f"note must be text of 1 to {TIKTOK_CUSTOMER_NOTE_MAX} characters")
    return {"handle": handle, "wants": wants, "message": note or tiktok_first_message(wants), "operation_id": _operation_id(body)}


def clean_tiktok_status_body(body: Any) -> dict[str, Any]:
    """``{status, note: {en, ar}, operationId}`` of a team step; both languages of the note are required."""
    body = _fields_only(body, TIKTOK_STATUS_FIELDS)
    state = body.get("status")
    if state not in TIKTOK_STATES or state in ("open", "cancelled"):
        studio_error(400, "INVALID_VALUE", "status must be one of: in_progress, done, declined")
    note = body.get("note")
    if not isinstance(note, dict) or set(note) - {"en", "ar"}:
        studio_error(400, "INVALID_VALUE", "note must be {en, ar}: the same note in English and Arabic")
    clean: dict[str, str] = {}
    for lang in ("en", "ar"):
        words = clean_text(note.get(lang), multiline=True)
        if not words or len(words) > TIKTOK_NOTE_MAX:
            studio_error(400, "INVALID_VALUE", f"note.{lang} must be text of 1 to {TIKTOK_NOTE_MAX} characters")
        clean[lang] = words
    return {"state": state, "note": clean, "operation_id": _operation_id(body)}


def _tiktok_state_filter(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    if raw not in TIKTOK_STATE_FILTERS:
        studio_error(400, "INVALID_VALUE", "state must be one of: " + ", ".join(TIKTOK_STATE_FILTERS))
    return str(raw)


def _status_filter(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    if raw not in STATUS_FILTERS:
        studio_error(400, "INVALID_VALUE", "status must be one of: " + ", ".join(STATUS_FILTERS))
    return str(raw)


def _priority_filter(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    if raw not in PRIORITIES:
        studio_error(400, "INVALID_VALUE", "priority must be one of: " + ", ".join(PRIORITIES))
    return str(raw)


def _limit(raw: Any) -> int:
    if raw is None or raw == "":
        return PAGE_DEFAULT
    value = str(raw).strip()
    if not (value.isascii() and value.isdigit()) or not 1 <= int(value) <= PAGE_MAX:
        studio_error(400, "INVALID_VALUE", f"limit must be a whole number from 1 to {PAGE_MAX}")
    return int(value)


# ------------------------------------------------------------------ routes


def create_studio_support_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """The help-desk routes under /api/studio (see the module docstring). ``ctx``: the studio
    router's ``user_has_permission`` and ``audit`` (main.audit; it joins a transaction with ``conn=``)."""
    router = APIRouter()

    def is_admin(user: dict[str, Any]) -> bool:
        return str(user.get("role") or "").lower() == "admin"

    def require_staff(user: dict[str, Any]) -> bool:
        """True for an admin; a reviewer passes with False; anyone else gets 403."""
        if is_admin(user):
            return True
        if not ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review"):
            studio_error(403, "STAFF_ONLY", "Only the Albayan team can use this")
        return False

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    def rate_limit(user: dict[str, Any], bucket: str, limit: int, window_ms: int = 60_000) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", limit, window_ms)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def auditor(actor_id: str) -> Callable[[Any, str, str, str, dict[str, Any]], None]:
        def write(conn: Any, action: str, row_id: str, message: str, metadata: dict[str, Any]) -> None:
            ctx["audit"](actor_id or None, action, SUPPORT_TICKETS_TYPE, row_id, message, metadata, conn=conn)
        return write

    def for_customer(value: Any, user: dict[str, Any]) -> Any:
        return redact_staff_identity(value, user)

    # -------------------------------------------------------------- customer

    @router.post("/tickets")
    def open_studio_ticket(request: Request, body: Any = Body(None), user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        uid = str(user.get("id") or "")
        rate_limit(user, "ticket-create", CREATES_PER_HOUR, 3_600_000)
        clean = clean_create_body(body)
        settings = read_all_settings()
        if not service_access(settings["rollout"], uid)["help"]:
            studio_error(403, "SERVICE_OFF", "Help is not open for your account yet")
        check_related(uid, clean["related_type"], clean["related_id"])
        now = utc_now()
        with write_transaction() as conn:
            ticket, first, _created = open_ticket_conn(
                conn, owner_id=uid, operation_id=clean["operation_id"], subject=clean["subject"],
                category=clean["category"], message=clean["message"], related_type=clean["related_type"],
                related_id=clean["related_id"], settings=settings, now=now, audit=auditor(uid),
            )
        return for_customer({"ticket": ticket_view(ticket), "message": message_view(first)}, user)

    @router.get("/tickets")
    def list_studio_tickets(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "ticket-read", READS_PER_MINUTE)
        query = request.query_params
        with db_conn() as conn:
            page = list_tickets_page(
                conn, owner_id=str(user.get("id") or ""), status=_status_filter(query.get("status")),
                cursor=_parse_cursor(query.get("cursor")), limit=_limit(query.get("limit")),
            )
        return for_customer(page, user)

    @router.get("/tickets/{ticket}")
    def read_studio_ticket(ticket: str, user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "ticket-read", READS_PER_MINUTE)
        with db_conn() as conn:
            row, data = load_ticket(conn, ticket, owner_id=str(user.get("id") or ""))
            messages = _ticket_messages(conn, row)
        return for_customer({"ticket": ticket_view(data), "messages": [message_view(item) for item in messages]}, user)

    @router.post("/tickets/{ticket}/messages")
    def post_studio_ticket_message(ticket: str, request: Request, body: Any = Body(None),
                                   user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        rate_limit(user, "ticket-write", CUSTOMER_WRITES_PER_MINUTE)
        body = _fields_only(body, MESSAGE_FIELDS)
        words, operation = _message_text(body.get("text"), "text"), _operation_id(body)
        uid = str(user.get("id") or "")
        settings = read_all_settings()
        with write_transaction() as conn:
            data, message, _created = post_message_conn(
                conn, ticket, author="customer", author_id=uid, operation_id=operation, body=words,
                settings=settings, audit=auditor(uid),
            )
        return for_customer({"ticket": ticket_view(data), "message": message_view(message)}, user)

    def customer_status(ticket: str, request: Request, body: Any, user: dict[str, Any], status: str) -> dict[str, Any]:
        same_origin(request)
        rate_limit(user, "ticket-write", CUSTOMER_WRITES_PER_MINUTE)
        operation = _operation_id(_fields_only(body, OPERATION_FIELDS))
        uid = str(user.get("id") or "")
        settings = read_all_settings()
        with write_transaction() as conn:
            data, _changed = change_status_conn(
                conn, ticket, status, by="customer", actor_id=uid, operation_id=operation,
                settings=settings, audit=auditor(uid),
            )
        return for_customer({"ticket": ticket_view(data)}, user)

    @router.post("/tickets/{ticket}/resolve")
    def resolve_studio_ticket(ticket: str, request: Request, body: Any = Body(None),
                              user: dict[str, Any] = Depends(current_user_dependency)):
        return customer_status(ticket, request, body, user, "resolved")

    @router.post("/tickets/{ticket}/reopen")
    def reopen_studio_ticket(ticket: str, request: Request, body: Any = Body(None),
                             user: dict[str, Any] = Depends(current_user_dependency)):
        return customer_status(ticket, request, body, user, "open")

    # -------------------------------------------------------------- staff (P3-13)

    @router.get("/staff/tickets")
    def list_staff_tickets(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-read", READS_PER_MINUTE)
        query = request.query_params
        with db_conn() as conn:
            return list_tickets_page(
                conn, admin=admin, status=_status_filter(query.get("status")),
                priority=_priority_filter(query.get("priority")), cursor=_parse_cursor(query.get("cursor")),
                limit=_limit(query.get("limit")), now=utc_now(),
            )

    @router.get("/staff/tickets/{ticket}")
    def read_staff_ticket(ticket: str, user: dict[str, Any] = Depends(current_user_dependency)):
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-read", READS_PER_MINUTE)
        with db_conn() as conn:
            row, data = load_ticket(conn, ticket, admin=admin)
            messages = _ticket_messages(conn, row)
        return {"ticket": ticket_view(data, staff=True), "messages": [message_view(item, staff=True) for item in messages]}

    @router.post("/staff/tickets/{ticket}/messages")
    def post_staff_ticket_message(ticket: str, request: Request, body: Any = Body(None),
                                  user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-write", STAFF_WRITES_PER_MINUTE)
        body = _fields_only(body, MESSAGE_FIELDS)
        words, operation = _message_text(body.get("text"), "text"), _operation_id(body)
        uid = str(user.get("id") or "")
        settings = read_all_settings()
        with write_transaction() as conn:
            data, message, _created = post_message_conn(
                conn, ticket, author="team", author_id=uid, operation_id=operation, body=words, admin=admin,
                settings=settings, audit=auditor(uid),
            )
        return {"ticket": ticket_view(data, staff=True), "message": message_view(message, staff=True)}

    @router.post("/staff/tickets/{ticket}/status")
    def set_staff_ticket_status(ticket: str, request: Request, body: Any = Body(None),
                                user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-write", STAFF_WRITES_PER_MINUTE)
        body = _fields_only(body, STAFF_STATUS_FIELDS)
        status = body.get("status")
        if status not in STATUSES:
            studio_error(400, "INVALID_VALUE", "status must be one of: " + ", ".join(STATUSES))
        operation = _operation_id(body, required=False)
        uid = str(user.get("id") or "")
        settings = read_all_settings()
        with write_transaction() as conn:
            data, _changed = change_status_conn(
                conn, ticket, status, by="team", actor_id=uid, operation_id=operation, admin=admin,
                settings=settings, audit=auditor(uid),
            )
        return {"ticket": ticket_view(data, staff=True)}

    # -------------------------------------------------------------- TikTok service requests (P5-01)

    def tiktok_service(settings: dict[str, Any], uid: str) -> dict[str, Any]:
        return {
            "open": bool(service_access(settings["rollout"], uid)["tiktok"]),
            "labels": dict(TIKTOK_TEXTS["service"]),
            "notice": dict(TIKTOK_TEXTS["notice"]),
            "promise": dict(TIKTOK_TEXTS["promise"]),
            "wants": [{"key": want, "labels": dict(TIKTOK_TEXTS["wants"][want])} for want in TIKTOK_WANTS],
            "maxOpen": MAX_OPEN_TIKTOK_REQUESTS,
        }

    @router.post("/tiktok/requests")
    def open_tiktok_request(request: Request, body: Any = Body(None), user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        uid = str(user.get("id") or "")
        clean = clean_tiktok_body(body)  # a refused body costs nothing: the day cap counts created requests
        rate_limit(user, "tiktok-create", TIKTOK_FLOOD_PER_HOUR, 3_600_000)
        settings = read_all_settings()
        if not service_access(settings["rollout"], uid)["tiktok"]:
            studio_error(403, "SERVICE_OFF", "The TikTok service is not open for your account yet")
        subject = f"{TIKTOK_TEXTS['subject']['en']} · {TIKTOK_TEXTS['subject']['ar']} · @{clean['handle']}"
        with write_transaction() as conn:
            ticket, first, _created = open_ticket_conn(
                conn, owner_id=uid, operation_id=clean["operation_id"], subject=subject, category=TIKTOK_CATEGORY,
                message=clean["message"], kind=TIKTOK_KIND, settings=settings, now=utc_now(), audit=auditor(uid),
                extra={"tiktokHandle": clean["handle"], "tiktokWants": clean["wants"]},
            )
        return for_customer({"request": ticket_view(ticket), "message": message_view(first)}, user)

    @router.get("/tiktok/requests")
    def list_tiktok_requests(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "ticket-read", READS_PER_MINUTE)
        uid = str(user.get("id") or "")
        query = request.query_params
        settings = read_all_settings()
        with db_conn() as conn:
            page = list_tickets_page(
                conn, owner_id=uid, kind=TIKTOK_KIND, tiktok_state=_tiktok_state_filter(query.get("state")),
                cursor=_parse_cursor(query.get("cursor")), limit=_limit(query.get("limit")),
            )
            open_count = count_open_tiktok_requests(conn, uid)
        return for_customer({
            "requests": page["tickets"], "nextCursor": page["nextCursor"], "openCount": open_count,
            "maxOpen": MAX_OPEN_TIKTOK_REQUESTS, "service": tiktok_service(settings, uid),
        }, user)

    @router.get("/staff/tiktok")
    def list_staff_tiktok_requests(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-read", READS_PER_MINUTE)
        query = request.query_params
        with db_conn() as conn:
            page = list_tickets_page(
                conn, admin=admin, kind=TIKTOK_KIND, tiktok_state=_tiktok_state_filter(query.get("state")),
                cursor=_parse_cursor(query.get("cursor")), limit=_limit(query.get("limit")), now=utc_now(),
            )
        return {"requests": page["tickets"], "nextCursor": page["nextCursor"]}

    @router.post("/staff/tiktok/{ticket}/status")
    def set_tiktok_request_status(ticket: str, request: Request, body: Any = Body(None),
                                  user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        admin = require_staff(user)
        rate_limit(user, "staff-ticket-write", STAFF_WRITES_PER_MINUTE)
        clean = clean_tiktok_status_body(body)
        uid = str(user.get("id") or "")
        settings = read_all_settings()
        with write_transaction() as conn:
            data, message, _changed = tiktok_transition_conn(
                conn, ticket, clean["state"], note=clean["note"], actor_id=uid, operation_id=clean["operation_id"],
                admin=admin, settings=settings, audit=auditor(uid),
            )
        return {"request": ticket_view(data, staff=True), "message": message_view(message, staff=True) if message else None}

    return router
