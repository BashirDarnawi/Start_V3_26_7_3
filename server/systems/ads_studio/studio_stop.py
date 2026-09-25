"""Albayan Studio urgent stop requests and the team desk's live counters (plan tasks P3-10, P3-11,
P3-17, P3-20; PLAN.md §5.3, §5.5 J5 and J10, §7.1, §7.3, §7.5, §7.6, §12.2).

**Ask to stop (P3-10).** ``POST /api/ad-studio/campaigns/{id}/stop-request`` ``{operationId, note?}``.
It is registered on the /api/ad-studio router (ad_campaign_actions.create_ad_campaign_actions_router
calls ``add_stop_request_route``), so its refusals are plain texts like the other /api/ad-studio routes:

* The owner only: anyone else, staff too, gets 404 "Campaign request not found" (staff stop an ad
  with /stop). An Approved request only: 409 "Only Approved campaigns can be stopped" (the same text
  as /stop). A lapsed plan is fine (it only protects the owner's own money). The ``stopRequest``
  service must be on for this user (studio_settings.service_access), else 403 REFUSE_STOP_REQUEST_OFF;
  the customer layout never matters (P3-20). A help-desk refusal met while the ticket is opened (an
  operationId the customer already used for another ticket, a counter race) is answered in the same
  plain shape (``classic_refusal``: REFUSE_STOP_OPERATION_USED, "Conflict: record has changed",
  REFUSE_STOP_TICKET), never as the /api/studio ``{code, message}`` dict.
* ONE transaction on the locked request row: an urgent ticket (category ``ad``, related ``campaign``,
  made by studio_support.open_ticket_conn, see Tickets below), the request's ``stopRequestedAt``,
  ``stopRequestTicketId`` and ``lastStopRequestOperationId``, the staff queue row below, the owner's
  inbox item ``stop_request_received`` (studio_activity.py) and the audit entry ``stop_request``
  (in main's keep list: never deleted).
* After the commit the staff channel hears about it at once (``notify_channel_soon``:
  studio_alert_out.send_pending on its own daemon thread, P3-21; the request never waits for the
  webhook, and a send that fails is the operations worker's and the jobs loop's to try again).
* The answer: ``{ticket, stopRequestedAt, afterHours, urgentContact?}``. ``afterHours`` is true when
  the team is outside its working hours now (the ``hours`` setting, Tripoli time); only then
  ``urgentContact`` is there, with the on-duty WhatsApp line (``contact.urgentWhatsapp``) and the
  public phone, each only when set. The screen shows ``serviceHours.onDutyUntil`` from /me with it.
* One stop request per ad: a repeat (a lost answer, a second tap, another device, another
  operationId) answers with the SAME ticket and changes nothing.

**The staff queue.** ``studioStopRequests``: one slim row per ad (id ``ssr_`` + sha256(campaign
id)[:40], ``created_by`` = the owner): campaignId, ownerId, ticketId, ticketNumber, requestedAt,
``dueAt`` (``targets.stopRequestMinutes`` WORKING minutes after the request), afterHours,
``deliveringAtRequest`` (the last Meta read before the request showed an ad delivering), ``state``
open | resolved, resolvedAt, resolvedReason (``stopped`` | ``meta_paused``). The desk counts it
without reading the ad requests themselves (their rows carry the photos). ``check_stop_requests``
(the studio jobs loop, on its 5-minute waiting-requests turn) resolves a row, and its ticket, ONLY
once the request is Stopped (or archived), or once Meta shows the ad paused or ended AFTER it had
been delivering and after the stop was asked (``meta_handled_stop``: ``deliveringAtRequest``, then a
read since the request with no ad delivering or in review and every ad paused, the campaign
paused/deleted/archived or a Meta end time passed). An ad in Meta review, with issues or that never
started delivering is NOT a handled stop request: its row and ticket stay open and go overdue as
configured (``adCampaignResults.stopEffectiveAt`` stays the p90 metric only, PLAN.md §7.1). An open
row past its ``dueAt`` raises ``stop_request_overdue`` (one alert per ad and Tripoli day). A stop
through /stop resolves it at once (``on_campaign_stopped``).

**Staff pulse (P3-17).** ``GET /api/studio/staff/pulse`` (staff: admins and reviewers; others 403
STAFF_ONLY): counts only, ``{waitingReview, stopRequests, openTickets, paymentsWaiting, alerts,
updatedAt}``. waitingReview = live Submitted requests (a reviewer's own left out: no self-review;
PostgreSQL answers it from the status index); stopRequests = open queue rows; openTickets = tickets waiting for the team
(status ``open``; reviewers count only tickets whose audience is not ``admin``); alerts = studio
alerts of the last 24 hours nobody acknowledged; ``paymentsWaiting`` (charge requests waiting for
confirmation, the platform door wallet_payments.pending_payment_requests_count) exists for admins
only and is reused for up to a minute. Never an id, a name or an amount.

**Staff contact link (P3-11).** ``GET /api/studio/staff/customers/{id}/contact``
``[?relatedType=campaign|ticket&relatedId=...]`` (staff, from the Albayan site itself: the read is
audited): the customer's WhatsApp number and a
``wa.me`` link with a short Arabic greeting (naming the studio code or ticket number when an item is
given), only when the customer saved it with consent (studio_profile.py), else 409 NO_CONSENT. A
reviewer reaches only a customer with a request the team can see or a ticket that is not admin-only,
and never an admin-only ticket (404 UNKNOWN_CUSTOMER, as for an unknown id); admins reach every
customer. Each number handed out is audited ``contact_link`` (kept forever) without the number.

**Team desk in use (P3-20).** ``desk_counts(conn)`` is the ONE source of the desk's numbers: open
queue rows (``stopRequests``), tickets waiting for the team (``openTickets``, status open) and
unresolved tickets (``unresolvedTickets``: open, answered or waiting for the customer, the desk's
``active`` list), through studio_support.staff_ticket_counts. The pulse and ``staff_desk_in_use(conn)``
(unresolved tickets + open stop requests) read it, so studio_settings' refusal to hide ``staffDesk``
while either is non-zero (409 STAFF_DESK_IN_USE) names only work the desk shows.

**Tickets.** The urgent ticket is opened by ``studio_support.open_ticket_conn`` on the stop request's
own transaction (priority urgent, kind stop_request, the open-ticket cap not enforced, settings read
before the transaction). Once the ad is Stopped, ``studio_support.system_resolve_ticket_conn``
resolves it on the same transaction as the stop row; the caller audits.

**Service hours.** ``studio_hours.is_open_now(settings=, now=)`` and ``studio_hours.due_at(start,
minutes=, settings=)`` (P3-16, built in parallel) when present; until then the same rules:
studio_settings.service_open_at and ``working_due_at`` below (working minutes inside the week hours,
holidays and the Ramadan window, Tripoli time).
"""

import math
import threading
import time
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text

from ...db import db_conn, json_dumps, json_field_sql, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from ...user_directory import user_exists
from ...wallet_payments import pending_payment_requests_count
from .ad_campaign_actions import (
    AD_CAMPAIGN_COLLECTION,
    REVIEWER_VISIBLE_STATUSES,
    _clean_operation_id,
    _lock_campaign_row,
)
from .studio_activity import create_studio_activity_router, record_activity
from .studio_diagnostics import parse_time
from .studio_errors import error_code, studio_error
from .studio_jobs import ALERTS_TYPE, _day_hours, _zone, raise_alert
from .studio_privacy import redact_staff_identity
from .studio_profile import profile_id, profile_view
from .studio_results import (
    PAUSED_STATUSES,
    REVIEW_STATUSES,
    load_request,
    load_results_row,
    meta_delivery,
    meta_time_ended_at,
)
from .studio_settings import read_all_settings, service_access, service_open_at
from .studio_types import (
    STUDIO_PROFILES_TYPE,
    STUDIO_STOP_REQUESTS_TYPE,
    SUPPORT_TICKET_MESSAGES_TYPE,
    SUPPORT_TICKETS_TYPE,
    created_by_or_none,
    derived_id,
)

STOP_TYPE = STUDIO_STOP_REQUESTS_TYPE
TICKETS_TYPE = SUPPORT_TICKETS_TYPE
TICKET_MESSAGES_TYPE = SUPPORT_TICKET_MESSAGES_TYPE
STOP_ID_PREFIX = "ssr"
NOTE_MAX_CHARS = 1000
AUDIT_STOP_REQUEST = "stop_request"
AUDIT_CONTACT_LINK = "contact_link"
PULSE_READS_PER_MINUTE = 30
CONTACT_READS_PER_MINUTE = 20
PAYMENTS_CACHE_SECONDS = 60
ALERTS_WINDOW = timedelta(hours=24)
# Meta statuses that mean "not delivering, and not about to": every ad paused, deleted or archived.
GONE_STATUSES = PAUSED_STATUSES + ("DELETED", "ARCHIVED")
# Refusal texts of the /api/ad-studio stop-request route (the classic Arabic map carries each prefix).
REFUSE_STOP_REQUEST_OFF = "Stop requests are not open yet. Please contact the Albayan team"
REFUSE_STOP_NOT_APPROVED = "Only Approved campaigns can be stopped"  # the same text as /stop
REFUSE_NOTE = "note must be text"
# The help desk's refusals (studio_support, {code, message}) in this route's plain shape (PLAN.md §7.3).
REFUSE_STOP_OPERATION_USED = "operationId was already used for another ticket"  # IDEMPOTENCY_MISMATCH
REFUSE_RECORD_CHANGED = "Conflict: record has changed"  # VERSION_CONFLICT: the same text as /stop
REFUSE_STOP_TICKET = "Stop request could not be recorded. Please try again"  # anything else
DEFAULT_STOP_MESSAGE = "Please stop this ad. — أرجو إيقاف هذا الإعلان."
TICKET_VIEW_FIELDS = (
    "id", "number", "subject", "category", "status", "audience", "relatedType", "relatedId", "createdAt",
    "updatedAt", "dueAt", "lastMessageAt",
)

_PAYMENTS_CACHE: dict[str, float] = {"at": -1.0, "count": 0.0}


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The clock of the stop requests and the desk (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return _aware(moment).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stop_row_id(campaign_id: str) -> str:
    return derived_id(STOP_ID_PREFIX, campaign_id)


def is_staff(ctx: dict[str, Any], user: dict[str, Any]) -> bool:
    return str(user.get("role") or "").lower() == "admin" or bool(
        ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review")
    )


def _clock_minutes(value: str) -> tuple[int, int]:
    hour, minute = (int(part) for part in str(value).split(":"))
    return hour, minute


def working_due_at(start: datetime, minutes: int, hours: dict[str, Any]) -> datetime | None:
    """``minutes`` of working time after ``start`` (UTC), counted only inside the working hours of the
    ``hours`` setting in Tripoli time (closed days, holidays and the Ramadan hours as
    studio_settings.service_open_at reads them). Outside the hours the count starts at the next
    opening. None when no working day comes within 400 days (the setting always keeps one)."""
    zone = _zone()
    local = _aware(start).astimezone(zone)
    left = float(max(int(minutes), 0))
    day = local.date()
    for _ in range(400):
        opening = _day_hours(hours, day)
        if opening:
            open_h, open_m = _clock_minutes(opening["open"])
            close_h, close_m = _clock_minutes(opening["close"])
            begin = datetime(day.year, day.month, day.day, open_h, open_m, tzinfo=zone)
            end = datetime(day.year, day.month, day.day, close_h, close_m, tzinfo=zone)
            if day == local.date():
                begin = max(begin, local)
            if begin < end:
                span = (end - begin).total_seconds() / 60
                if left <= span:
                    return (begin + timedelta(minutes=left)).astimezone(timezone.utc)
                left -= span
        day += timedelta(days=1)
    return None


def _hours_module() -> Any:
    try:
        from . import studio_hours  # P3-16, built in parallel
    except ImportError:
        return None
    return studio_hours


def team_open_now(settings: dict[str, Any], now: datetime) -> bool:
    """True inside the team's working hours (studio_hours.is_open_now when it exists)."""
    check = getattr(_hours_module(), "is_open_now", None)
    if callable(check):
        try:
            answer = check(settings=settings, now=now)
            if isinstance(answer, bool):
                return answer
        except Exception:
            pass
    return service_open_at(settings["hours"], now)


def stop_due_at(start: datetime, settings: dict[str, Any]) -> datetime | None:
    """When a stop request made at ``start`` must be handled (the D11 stop-request target)."""
    minutes = int(settings["targets"]["stopRequestMinutes"])
    due = getattr(_hours_module(), "due_at", None)
    if callable(due):
        try:
            answer = due(start, minutes=minutes, settings=settings)
            if isinstance(answer, datetime) and _aware(answer) >= _aware(start):
                return _aware(answer)
        except Exception:
            pass
    return working_due_at(start, minutes, settings["hours"])


# ------------------------------------------------------------------ tickets (studio_support.py, P3-07)

def ticket_view(data: Any) -> dict[str, Any]:
    """The contract fields of a ticket (never an internal note or a staff id) plus ``urgent``."""
    data = data if isinstance(data, dict) else {}
    view = {field: data.get(field) for field in TICKET_VIEW_FIELDS}
    view["urgent"] = data.get("urgent") is True or str(data.get("priority") or "") == "urgent"
    return view


def load_ticket(conn: Any, ticket_id: str) -> dict[str, Any]:
    row = conn.execute(
        text("SELECT data_json FROM entities WHERE type = :type AND id = :id AND deleted = false LIMIT 1"),
        {"type": TICKETS_TYPE, "id": str(ticket_id or "")},
    ).mappings().first()
    data = (json_loads(row["data_json"]) or {}) if row else {}
    return data if isinstance(data, dict) and data else {"id": str(ticket_id or "")}


def create_stop_ticket(conn: Any, *, settings: dict[str, Any], urgent: bool = True, **arguments: Any) -> dict[str, Any]:
    """The stop request's ticket (studio_support.open_ticket_conn, P3-07): urgent, kind stop_request, never
    refused by the open-ticket cap; a replay of the same operationId returns the first ticket."""
    from . import studio_support  # late: keeps the two desk modules free of an import cycle

    ticket, _first_message, _created = studio_support.open_ticket_conn(
        conn, priority="urgent" if urgent else "normal", kind="stop_request", enforce_open_limit=False,
        settings=settings, **arguments,
    )
    return ticket


def resolve_ticket(conn: Any, ticket_id: str, reason: str, at: str) -> None:
    """Mark a stop request's ticket resolved on the caller's transaction (studio_support, P3-07)."""
    if not ticket_id:
        return
    from . import studio_support  # late, see create_stop_ticket

    studio_support.system_resolve_ticket_conn(conn, ticket_id, reason=reason)


def classic_refusal(error: HTTPException) -> HTTPException:
    """A /api/studio ``{code, message}`` refusal (studio_error) as this /api/ad-studio route answers
    it: a plain text with a stable prefix, so the classic Arabic map matches. A plain-text error is
    returned as it is."""
    code = error_code(error.detail)
    if not code:
        return error
    if code == "IDEMPOTENCY_MISMATCH":
        detail = REFUSE_STOP_OPERATION_USED
    elif code == "VERSION_CONFLICT":
        detail = REFUSE_RECORD_CHANGED
    else:
        detail = REFUSE_STOP_TICKET
    return HTTPException(status_code=error.status_code, detail=detail, headers=error.headers)


def delivering_at_request(request: dict[str, Any], results: dict[str, Any] | None, now: datetime) -> bool:
    """The last Meta read of the request's linked campaign shows an ad delivering (the ``delivering``
    rule of studio_results.meta_delivery). False without a link, without a read, or with a results
    row of another campaign: then Meta can never be the one that handled the stop request."""
    meta_id = str(request.get("metaCampaignId") or "").strip()
    if not results or not meta_id or results["metaCampaignId"] != meta_id or not results["lastSyncedAt"]:
        return False
    return meta_delivery(request, results, now)["delivering"]


def meta_handled_stop(item: dict[str, Any], results: dict[str, Any] | None, now: datetime) -> bool:
    """True when Meta shows the ad paused or ended AFTER it had been delivering and after the stop
    was asked (PURE): the queue row saw it delivering at the request (``deliveringAtRequest``), and
    a Meta read since the request shows no ad delivering or in review, with every ad paused, deleted
    or archived, the campaign paused/deleted/archived, or a Meta end time passed. An ad in Meta
    review, with issues, without ads yet or that never started delivering is NOT handled."""
    if not results or item.get("deliveringAtRequest") is not True:
        return False
    requested = parse_time(item.get("requestedAt"))
    read_at = parse_time(results.get("lastSyncedAt"))
    if requested is None or read_at is None or read_at <= requested:
        return False  # no Meta read since the request yet
    counts = results["adStatusCounts"]
    total = sum(counts.values())
    if not total or any(counts.get(status, 0) for status in REVIEW_STATUSES):
        return False
    ended = meta_time_ended_at(results, now) is not None
    if (counts.get("ACTIVE", 0) > 0 or results["anyAdDelivering"]) and not ended:
        return False  # still delivering
    paused = results["campaignEffectiveStatus"] in ("PAUSED", "DELETED", "ARCHIVED") or (
        sum(counts.get(status, 0) for status in GONE_STATUSES) == total
    )
    return paused or ended


# ------------------------------------------------------------------ the stop-request route

class StopRequestBody(BaseModel):
    """``operationId`` (one per tap, checked by the route) and an optional ``note`` for the team."""

    operationId: Optional[Any] = None
    note: Optional[Any] = None


def _stop_subject(data: dict[str, Any]) -> str:
    ref = str(data.get("studioRef") or "").strip()
    name = " ".join(str(data.get("name") or "").replace("<", "").replace(">", "").split())[:60]
    return f"Stop request · طلب إيقاف · {ref or name or 'ad'}"[:120]


def _answer(ticket: Any, requested_at: str, settings: dict[str, Any], now: datetime, user: dict[str, Any]) -> dict[str, Any]:
    after_hours = not team_open_now(settings, now)
    out: dict[str, Any] = {
        "ticket": redact_staff_identity(ticket_view(ticket), user),
        "stopRequestedAt": requested_at,
        "afterHours": after_hours,
    }
    if after_hours:
        contact = settings["contact"]
        out["urgentContact"] = {
            key: value for key, value in (("whatsapp", contact.get("urgentWhatsapp")), ("phone", contact.get("phone")))
            if value
        }
    return out


def _write_stop_row(conn: Any, campaign_id: str, owner: str | None, fields: dict[str, Any]) -> None:
    row_id = stop_row_id(campaign_id)
    stamp = now_ms()
    data = {"recordType": STOP_TYPE, "id": row_id, "campaignId": campaign_id, **fields,
            "_created": stamp, "_lastModified": stamp, "_deleted": False}
    conn.execute(
        text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp) "
            "ON CONFLICT (type, id) DO UPDATE SET data_json = excluded.data_json, deleted = false, "
            "last_modified = excluded.last_modified"
        ),
        {"type": STOP_TYPE, "id": row_id, "data": json_dumps(data), "stamp": stamp, "owner": owner},
    )


def notify_channel_soon() -> threading.Thread | None:
    """P3-21: after a stop request's commit the staff channel hears about it now, not at the operations
    worker's next 300-second turn: studio_alert_out.send_pending on its own daemon thread. The request
    never waits for the webhook; the queue row is stamped only once the webhook accepted the alert, so
    the worker's pass and the jobs loop never send it twice, and a send that fails is theirs to retry.
    Never raises. Returns the thread (tests wait for it), or None when none could start."""

    def run() -> None:
        try:
            from .studio_alert_out import send_pending  # late: studio_alert_out imports the jobs module this one imports

            send_pending()
        except Exception as error:
            print(f"[albayan] Stop request notification left to the worker ({type(error).__name__}).")

    try:
        thread = threading.Thread(target=run, name="albayan-studio-stop-notify", daemon=True)
        thread.start()
        return thread
    except Exception as error:
        print(f"[albayan] Stop request notification thread not started ({type(error).__name__}).")
        return None


def add_stop_request_route(
    router: APIRouter,
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> None:
    """Register ``POST /{campaign_id}/stop-request`` on the /api/ad-studio/campaigns router (its ctx:
    main's campaign-action helpers)."""

    @router.post("/{campaign_id}/stop-request")
    def request_ad_campaign_stop(
        campaign_id: str,
        body: StopRequestBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """P3-10: the owner asks the team to stop a running (Approved) ad; see the module docstring."""
        require_same_origin(request)
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        if body.note is not None and not isinstance(body.note, str):
            raise HTTPException(status_code=400, detail=REFUSE_NOTE)
        note = ctx["sanitize_str"](str(body.note or ""), NOTE_MAX_CHARS).strip()
        actor_id = str(user.get("id") or "")
        now = utc_now()
        settings = read_all_settings()
        postgres = bool(ctx["is_postgres"]())
        patch_guard = nullcontext() if postgres else ctx["sqlite_patch_lock"]()
        with patch_guard:
            with db_conn() as conn:
                row = _lock_campaign_row(conn, ctx, campaign_id)
                if not row:
                    raise HTTPException(status_code=404, detail="Campaign request not found")
                entity = ctx["entity_from_db_row"](row)
                data = dict(entity.get("data") or {})
                creator = str(entity.get("createdBy") or data.get("createdBy") or "")
                if not actor_id or actor_id != creator:
                    raise HTTPException(status_code=404, detail="Campaign request not found")  # owner only
                if not ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "stop", record_creator_id=creator):
                    raise HTTPException(status_code=403, detail="Forbidden")
                asked_at = str(data.get("stopRequestedAt") or "").strip()
                ticket_id = str(data.get("stopRequestTicketId") or "").strip()
                if asked_at and ticket_id:
                    # One stop request per ad: the same ticket again, nothing written.
                    return _answer(load_ticket(conn, ticket_id), asked_at, settings, now, user)
                if not service_access(settings["rollout"], actor_id)["stopRequest"]:
                    raise HTTPException(status_code=403, detail=REFUSE_STOP_REQUEST_OFF)
                ctx["enforce_ad_campaign_rate"](user)
                if str(data.get("status") or "Draft") != "Approved":
                    raise HTTPException(status_code=409, detail=REFUSE_STOP_NOT_APPROVED)
                requested_at = _iso(now)
                due = stop_due_at(now, settings)
                after_hours = not team_open_now(settings, now)
                results, _version = load_results_row(conn, campaign_id)
                delivering = delivering_at_request(data, results, now)  # the signal check_stop_requests needs
                try:
                    ticket = create_stop_ticket(
                        conn, owner_id=actor_id, subject=_stop_subject(data), category="ad",
                        message=note or DEFAULT_STOP_MESSAGE, related_type="campaign", related_id=campaign_id,
                        urgent=True, operation_id=operation_id, settings=settings,
                    )
                except HTTPException as error:
                    raise classic_refusal(error) from None  # the help desk's {code, message}: this route's plain shape
                ticket_id = str(ticket.get("id") or "")
                number = str(ticket.get("number") or "")
                baseline = int(entity.get("lastModified") or 0)
                modified = max(now_ms(), baseline + 1)
                data.update({"stopRequestedAt": requested_at, "stopRequestTicketId": ticket_id,
                             "lastStopRequestOperationId": operation_id, "_lastModified": modified})
                result = conn.execute(
                    text("UPDATE entities SET data_json = :d, last_modified = :m "
                         "WHERE type = :t AND id = :id AND deleted = false AND last_modified = :baseline"),
                    {"d": json_dumps(data), "m": modified, "t": AD_CAMPAIGN_COLLECTION, "id": campaign_id,
                     "baseline": baseline},
                )
                if int(result.rowcount or 0) != 1:
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")  # rolls the ticket back too
                _write_stop_row(conn, campaign_id, created_by_or_none(conn, creator), {
                    "ownerId": creator, "ticketId": ticket_id, "ticketNumber": number, "requestedAt": requested_at,
                    "dueAt": _iso(due) if due else None, "afterHours": after_hours, "operationId": operation_id,
                    "deliveringAtRequest": delivering, "state": "open", "resolvedAt": None, "resolvedReason": None,
                })
                record_activity(conn, owner_id=creator, kind="stop_request_received", related_type="campaign",
                                related_id=campaign_id, key="stop", at=now, params={"number": number})
                ctx["audit"](
                    actor_id, AUDIT_STOP_REQUEST, AD_CAMPAIGN_COLLECTION, campaign_id,
                    f"Asked the team to stop campaign request {campaign_id}",
                    {"operationId": operation_id, "ticketId": ticket_id, "ticketNumber": number,
                     "dueAt": _iso(due) if due else None, "afterHours": after_hours, "withNote": bool(note)},
                    conn=conn,
                )
        notify_channel_soon()  # committed: the staff channel hears about it without waiting for the worker
        return _answer(ticket, requested_at, settings, now, user)


# ------------------------------------------------------------------ the queue: resolve and overdue

def _stop_rows(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        text("SELECT id, data_json FROM entities WHERE type = :type AND deleted = false"), {"type": STOP_TYPE},
    ).mappings().all()
    out = []
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        if isinstance(data, dict) and str(row["id"]) == stop_row_id(str(data.get("campaignId") or "-")):
            out.append(data)
    return out


def open_stop_requests(conn: Any) -> list[dict[str, Any]]:
    return [data for data in _stop_rows(conn) if str(data.get("state") or "open") != "resolved"]


def resolve_stop_request(campaign_id: str, reason: str, now: datetime | None = None) -> bool:
    """Close the ad's queue row and its ticket in one transaction; False when there is nothing open."""
    now = _aware(now or utc_now())
    row_id = stop_row_id(campaign_id)
    with db_conn() as conn:
        lock = " FOR UPDATE" if conn.dialect.name == "postgresql" else ""
        row = conn.execute(
            text(f"SELECT data_json, deleted, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1{lock}"),
            {"type": STOP_TYPE, "id": row_id},
        ).mappings().first()
        if not row or bool(row["deleted"]):
            return False
        data = json_loads(row["data_json"]) or {}
        if str(data.get("state") or "open") == "resolved":
            return False
        at = _iso(now)
        baseline = int(row["last_modified"])
        modified = max(now_ms(), baseline + 1)
        data.update({"state": "resolved", "resolvedAt": at, "resolvedReason": reason, "_lastModified": modified})
        result = conn.execute(
            text("UPDATE entities SET data_json = :data, last_modified = :modified "
                 "WHERE type = :type AND id = :id AND last_modified = :baseline"),
            {"data": json_dumps(data), "modified": modified, "type": STOP_TYPE, "id": row_id, "baseline": baseline},
        )
        if int(result.rowcount or 0) != 1:
            return False  # another writer resolved it first
        resolve_ticket(conn, str(data.get("ticketId") or ""), reason, at)
    return True


def on_campaign_stopped(campaign_id: str) -> bool:
    """Called by /stop after its commit: a stopped ad's stop request is handled. Never raises."""
    try:
        return resolve_stop_request(str(campaign_id or ""), "stopped")
    except Exception as error:
        print(f"[albayan] Stop request of a stopped ad stays open until the jobs loop ({type(error).__name__}).")
        return False


def check_stop_requests(now: datetime | None = None) -> dict[str, Any]:
    """The jobs loop's pass over the open stop requests: resolve the handled ones, alert the late ones."""
    now = _aware(now or utc_now())
    with db_conn() as conn:
        pending = open_stop_requests(conn)
    resolved: list[str] = []
    overdue: list[str] = []
    for item in pending:
        campaign_id = str(item.get("campaignId") or "")
        with db_conn() as conn:
            request = load_request(conn, campaign_id)
            results, _modified = load_results_row(conn, campaign_id)
        reason = ""
        if request is None or request["archived"] or str(request.get("status") or "") == "Stopped":
            reason = "stopped"
        elif meta_handled_stop(item, results, now):
            reason = "meta_paused"  # Meta paused or ended an ad that was delivering when the stop was asked
        if reason:
            if resolve_stop_request(campaign_id, reason, now):
                resolved.append(campaign_id)
            continue
        due = parse_time(item.get("dueAt"))
        if due is not None and now > due:
            with db_conn() as conn:
                raise_alert(
                    conn, "stop_request_overdue", related_type=AD_CAMPAIGN_COLLECTION, related_id=campaign_id,
                    owner_id=str(item.get("ownerId") or "") or None,
                    details={"campaignId": campaign_id, "ticketNumber": str(item.get("ticketNumber") or ""),
                             "requestedAt": item.get("requestedAt"), "dueAt": _iso(due)},
                    now=now,
                )
            overdue.append(campaign_id)
    return {"open": len(pending) - len(resolved), "resolved": resolved, "overdue": overdue}


# ------------------------------------------------------------------ counts (pulse, desk in use)

def desk_counts(conn: Any, *, admin: bool = True, now: datetime | None = None) -> dict[str, int]:
    """The ONE source of the desk's numbers, so the pulse, the STAFF_DESK_IN_USE guard and the desk
    lists always agree: ``stopRequests`` = open queue rows; ``openTickets`` = tickets waiting for the
    team (status open); ``unresolvedTickets`` = open, answered or waiting for the customer (the desk's
    ``active`` list). Both ticket counts come from studio_support.staff_ticket_counts (a reviewer's
    counts leave out admin-audience tickets, as their list does)."""
    from . import studio_support  # late, see create_stop_ticket

    tickets = studio_support.staff_ticket_counts(conn, include_admin=admin, now=now)
    return {"openTickets": tickets["open"], "unresolvedTickets": tickets["active"],
            "stopRequests": len(open_stop_requests(conn))}


def staff_desk_in_use(conn: Any) -> dict[str, int]:
    """P3-20: the work only the team desk shows, counted as the desk shows it (desk_counts): unresolved
    ``tickets`` (open, answered or waiting for the customer) and open ``stopRequests`` (queue rows). A
    stop request Meta handled (resolved ``meta_paused``) no longer counts, even while its ad still
    waits for its settlement through /stop."""
    counts = desk_counts(conn)
    return {"tickets": counts["unresolvedTickets"], "stopRequests": counts["stopRequests"]}


def _payments_waiting(conn: Any) -> int:
    """The platform count, reused for PAYMENTS_CACHE_SECONDS (every open admin desk polls the pulse)."""
    clock = time.monotonic()
    if _PAYMENTS_CACHE["at"] >= 0 and clock - _PAYMENTS_CACHE["at"] < PAYMENTS_CACHE_SECONDS:
        return int(_PAYMENTS_CACHE["count"])
    count = pending_payment_requests_count(conn)
    _PAYMENTS_CACHE.update({"at": clock, "count": float(count)})
    return count


def reset_pulse_cache() -> None:
    _PAYMENTS_CACHE.update({"at": -1.0, "count": 0.0})


def staff_pulse(conn: Any, viewer_id: str, *, admin: bool, now: datetime) -> dict[str, Any]:
    # A reviewer never reviews their own request (ad_campaign_actions review: 403); an admin may.
    not_own = "" if admin else " AND (created_by IS NULL OR created_by <> :uid)"
    waiting = conn.execute(
        text(f"SELECT COUNT(*) FROM entities WHERE type = '{AD_CAMPAIGN_COLLECTION}' AND deleted = false "
             f"AND {json_field_sql('status')} = 'Submitted'{not_own}"),
        {} if admin else {"uid": viewer_id},
    ).scalar()
    counts = desk_counts(conn, admin=admin, now=now)
    alert_rows = conn.execute(
        text(json_fields_select_sql(("acknowledgedAt",), (), "type = :type AND deleted = false AND last_modified >= :since")),
        {"type": ALERTS_TYPE, "since": int((now - ALERTS_WINDOW).timestamp() * 1000)},
    ).mappings().all()
    pulse: dict[str, Any] = {
        "waitingReview": int(waiting or 0),
        "stopRequests": counts["stopRequests"],
        "openTickets": counts["openTickets"],
        "alerts": sum(1 for row in alert_rows if not str(row.get("f_acknowledgedat") or "").strip()),
    }
    if admin:
        pulse["paymentsWaiting"] = _payments_waiting(conn)
    pulse["updatedAt"] = _iso(now)
    return pulse


# ------------------------------------------------------------------ the contact link (P3-11)

def whatsapp_link(number: str, reference: str) -> str:
    greeting = "مرحباً، معك فريق البيان" + (f" بخصوص {reference}" if reference else "") + "."
    return f"https://wa.me/{number.lstrip('+')}?text={quote(greeting)}"


def _reviewer_can_reach(conn: Any, customer_id: str) -> bool:
    statuses = ", ".join(f"'{status}'" for status in sorted(REVIEWER_VISIBLE_STATUSES))
    visible = conn.execute(
        text(f"SELECT id FROM entities WHERE type = '{AD_CAMPAIGN_COLLECTION}' AND deleted = false "
             f"AND created_by = :cid AND {json_field_sql('status')} IN ({statuses}) LIMIT 1"),
        {"cid": customer_id},
    ).first()
    if visible is not None:
        return True
    rows = conn.execute(
        text(json_fields_select_sql(("audience",), ("id",), "type = :type AND deleted = false AND created_by = :cid")),
        {"type": TICKETS_TYPE, "cid": customer_id},
    ).mappings().all()
    return any(str(row.get("f_audience") or "") != "admin" for row in rows)


def _related_reference(conn: Any, customer_id: str, related_type: str, related_id: str, admin: bool) -> str:
    """The studio code or ticket number of an item the customer owns and this staff member may see."""
    if related_type == "campaign":
        row = conn.execute(
            text(json_fields_select_sql(("status", "studioRef"), ("created_by",),
                                        "type = :type AND id = :id AND deleted = false")),
            {"type": AD_CAMPAIGN_COLLECTION, "id": related_id},
        ).mappings().first()
        if not row or str(row.get("created_by") or "") != customer_id or (
            not admin and str(row.get("f_status") or "Draft") not in REVIEWER_VISIBLE_STATUSES
        ):
            studio_error(404, "UNKNOWN_CUSTOMER", "No such customer item for the team")
        return str(row.get("f_studioref") or "")
    row = conn.execute(
        text(json_fields_select_sql(("audience", "number", "ownerId"), ("created_by",),
                                    "type = :type AND id = :id AND deleted = false")),
        {"type": TICKETS_TYPE, "id": related_id},
    ).mappings().first()
    owner = str((row or {}).get("created_by") or (row or {}).get("f_ownerid") or "")
    if not row or owner != customer_id or (not admin and str(row.get("f_audience") or "") == "admin"):
        studio_error(404, "UNKNOWN_CUSTOMER", "No such customer item for the team")
    return str(row.get("f_number") or "")


# ------------------------------------------------------------------ the /api/studio routes

def create_studio_desk_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """Under the studio router's /api/studio prefix: the owner's inbox (studio_activity.py), the staff
    pulse and the staff contact link. ``ctx``: user_has_permission, audit, validate_entity_id."""
    router = APIRouter()
    router.include_router(create_studio_activity_router(
        current_user_dependency=current_user_dependency, require_same_origin=require_same_origin, ctx=ctx,
    ))

    def rate_limit(user: dict[str, Any], bucket: str, per_minute: int) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def require_staff(user: dict[str, Any]) -> bool:
        if not is_staff(ctx, user):
            studio_error(403, "STAFF_ONLY", "Only the Albayan team can use this")
        return str(user.get("role") or "").lower() == "admin"

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    @router.get("/staff/pulse")
    def get_staff_pulse(user: dict[str, Any] = Depends(current_user_dependency)):
        admin = require_staff(user)
        rate_limit(user, "staff-pulse", PULSE_READS_PER_MINUTE)
        with db_conn() as conn:
            return staff_pulse(conn, str(user.get("id") or ""), admin=admin, now=_aware(utc_now()))

    @router.get("/staff/customers/{customer_id}/contact")
    def get_customer_contact(
        customer_id: str,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        same_origin(request)  # the read writes an audit entry: never from another site
        admin = require_staff(user)
        rate_limit(user, "staff-contact", CONTACT_READS_PER_MINUTE)
        try:
            customer_id = ctx["validate_entity_id"](customer_id)
        except HTTPException:
            studio_error(404, "UNKNOWN_CUSTOMER", "No such customer for the team")
        related_type = str(request.query_params.get("relatedType") or "").strip()
        related_id = str(request.query_params.get("relatedId") or "").strip()
        if related_type not in ("", "campaign", "ticket") or bool(related_type) != bool(related_id):
            studio_error(400, "INVALID_VALUE", "relatedType (campaign or ticket) and relatedId go together")
        if related_id:
            try:
                related_id = ctx["validate_entity_id"](related_id)
            except HTTPException:
                studio_error(404, "UNKNOWN_CUSTOMER", "No such customer item for the team")
        viewer = str(user.get("id") or "")
        with db_conn() as conn:
            if not user_exists(conn, customer_id):
                studio_error(404, "UNKNOWN_CUSTOMER", "No such customer for the team")
            reference = ""
            if related_type:
                reference = _related_reference(conn, customer_id, related_type, related_id, admin)
            elif not admin and not _reviewer_can_reach(conn, customer_id):
                studio_error(404, "UNKNOWN_CUSTOMER", "No such customer for the team")
            row = conn.execute(
                text("SELECT data_json, deleted FROM entities WHERE type = :type AND id = :id LIMIT 1"),
                {"type": STUDIO_PROFILES_TYPE, "id": profile_id(customer_id)},
            ).mappings().first()
            data = (json_loads(row["data_json"]) or {}) if row and not bool(row["deleted"]) else {}
            profile = profile_view(data)
            number = profile["whatsappNumber"]
            if not number or not profile["whatsappConsentAt"]:
                studio_error(409, "NO_CONSENT", "This customer has not given a WhatsApp number with consent. Use a ticket instead.")
            ctx["audit"](
                viewer, AUDIT_CONTACT_LINK, STUDIO_PROFILES_TYPE, profile_id(customer_id),
                "Opened a customer's WhatsApp contact link",
                {"customerId": customer_id, "relatedType": related_type or None, "relatedId": related_id or None},
                conn=conn,
            )
        return {
            "customerId": customer_id,
            "whatsapp": number,
            "whatsappUrl": whatsapp_link(number, reference),
            "consentAt": profile["whatsappConsentAt"],
            "relatedType": related_type or None,
            "relatedId": related_id or None,
        }

    return router
