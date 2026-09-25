"""Studio diagnostics: counts and baselines only (plan tasks P0-05a, P0-05b, P3-19; PLAN.md §4.1, §12).

Nothing here returns a name, email, phone, id or message text: only counts, medians, percentiles
and shares. The baselines describe the classic studio before the pilot, from the timestamps the
classic workflow already writes on ``adCampaignRequests`` (main.py submit/review routes).

Customers archive requests (DELETE -> main._soft_delete_ad_campaign_atomic keeps every
timestamp and ``reviewHistory``), and an archived request still happened. So the history
baselines B1, B2, B5 and B6 read ALL rows, archived included; the "now" numbers (``byStatus``,
``campaigns.total``, holds, B3, B4) read only live rows; ``campaigns.archived`` counts the rest.

* **B1** median hours from submit (``submittedAt``) to the decision (``reviewedAt``). A resubmit
  clears ``reviewedAt`` and overwrites ``submittedAt``, so each request counts its latest cycle.
* **B2** share (%) of review decisions that sent the request back ("Changes Requested"), over
  every decision in ``reviewHistory``.
* **B3** number of holds (Submitted requests with a budget, whose money is held) submitted more
  than 14 days ago.
* **B4** number of Approved requests more than 7 days past their ``endDate`` (Libya calendar)
  and never settled (a settled request is ``Stopped``).
* **B5** median hours from creating the draft (the row's ``created_at``) to its FIRST submit;
  a request that was already reviewed before its latest submit is left out (its first submit
  time is not stored).
* **B6** median hours from a customer's account creation (``users.created_at``, read through
  the platform door server/user_directory.py) to their first approval (earliest ``approvedAt``).

A median or share with no usable rows is ``None`` (null in JSON), never a crash or a fake 0.
Counts (B3, B4) are real zeros when nothing matches; ``sample`` says how many rows could be judged.
Only the few fields above are read (never the creative images), each row's JSON parsed once
(db.json_fields_select_sql: on PostgreSQL one jsonb cast per row, not one per field).

**Top-up presets** (P0-05b, D25): the 5 most common confirmed USD wallet top-up amounts with
their counts, from Albayan's own payment history (wallet_payments.confirmed_top_up_amounts):
amounts and counts only, no ids, names or users.

**Operations lines (P3-19; PLAN.md §12.3, §12.7, §12.8, M17)**, under ``operations``:

* ``queues``: how many items met their D11 target (the ``targets`` setting, counted in working
  time by studio_hours.target_due_at) over the last QUEUE_WINDOW_DAYS days: reviews (submit ->
  decision), tickets (open -> first team answer, stop requests apart), stop requests (request ->
  handled, against the due time stored with the request) and payment confirmations (charge request
  -> confirmed, through the platform door wallet_payments.payment_request_timings). An item still
  waiting past its due time counts as missed. ``onTarget`` compares the share with
  ``thresholds.queueOnTargetPercent`` (the §12.3 widening rule); None while there is no sample.
* ``staffTimes``: p50/p90 in minutes over the last TIMES_WINDOW_DAYS days: review, link (approval ->
  Meta link), settle (the settle gate opening -> the staff settle), ticket first response, stop ->
  paused, payment confirmation.
* ``capacity``: today's sends against the intake cap (D29), sends per day over the last week, the
  requests waiting for review.
* ``replies``: comment-reply latency p95 by source (webhook, poll) as ``last change - comment time``
  of the answered log rows, the failure share (answered vs failed, parked retries left out), the
  comments missed during a token outage and the replies parked right now.
* ``money``: USD owed to customers (Available + Reserved = the USD wallet balances through
  wallet_payments.usd_customer_balances_total, plus In ads = what live Approved requests paid)
  against the studio ad accounts' last stored funds reading (meta_ads' metaFundsState, allowlisted
  accounts, last 4 digits only); the absorbed Meta overspend (D27: Meta spend above what the
  customer paid, from the results rows); this month's reconciliation (what Albayan kept of settled
  requests versus Meta's spend, within the D32 tolerance or not); the last daily money scan
  (studioJobState.lastIntegrityResult, counts only).
* ``storage`` (read at most once per STORAGE_CACHE_SECONDS per process): the database size when
  the engine tells it cheaply, rows and bytes by record type (top 10), the biggest owners as counts
  only (never an id), the last backup the operations worker recorded (time and size).
* ``meta``: the Meta connection state, the token reading (validity, days left, missing scopes;
  never the token) and the webhook delivery counters, through the platform doors.
* ``goNoGo``: PLAN.md §12.8 as computed booleans: each go row and stop rule is ``True``/``False``
  where the numbers exist and ``None`` where they do not (a rehearsed runbook and a restore proof
  are not recorded anywhere, so they stay None). ``go`` is True only when every go row is known
  and true; ``stop`` is True when any stop rule fired.

Every list of studio rows is projected in SQL (json_fields_select_sql: one jsonb cast per row on
PostgreSQL), never a request's full ``data_json`` with its images (P3-14); the platform types are
read through their doors only.
"""

import math
import re
import statistics
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from ... import meta_ads as _meta
from ... import meta_token_health as _token_health
from ... import operations as _operations
from ...db import db_conn, json_fields_select_sql, json_loads_or_raw
from ...user_directory import account_created_at
from ...wallet_payments import (
    campaign_hold_minor,
    confirmed_top_up_amounts,
    payment_request_timings,
    usd_customer_balances_total,
)
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION, count_submissions_today
from .social_studio import LOG_TYPE as REPLY_LOG_TYPE, MISSED_DURING_OUTAGE, PARKED_REASON
from .studio_hours import target_due_at
from .studio_settings import read_all_settings
from .studio_types import STUDIO_STOP_REQUESTS_TYPE, SUPPORT_TICKETS_TYPE

CAMPAIGN_STATUSES = ("Draft", "Submitted", "Changes Requested", "Approved", "Rejected", "Stopped")
REVIEW_DECISIONS = ("Approved", "Changes Requested", "Rejected")
HOLD_AGE_DAYS = 14
UNSETTLED_GRACE_DAYS = 7
TOP_UP_PRESETS = 5
TOP_UP_CURRENCY = "USD"
_FIELDS = (
    "status", "submittedAt", "reviewedAt", "approvedAt", "endDate", "budgetMinorUSD", "reviewHistory",
    # P3-19 operations lines: the link, settle and money stamps (never the creative images).
    "linkedAt", "stoppedAt", "closeReason", "settleBasis", "paidMinorUSD", "refundMinorUSD", "totalBudgetMinorUSD",
    "metaCampaignId",
)


def parse_time(value: Any) -> datetime | None:
    """An ISO time as written by main._iso_utc ('...Z'); a time without a zone counts as UTC."""
    raw = str(value or "").strip()
    if not raw or len(raw) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_day(value: Any) -> date | None:
    try:
        return datetime.strptime(str(value or "").strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _from_ms(value: Any) -> datetime | None:
    try:
        stamp = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if stamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(stamp / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _minor(value: Any) -> int:
    try:
        return max(int(float(value or 0)), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _hours(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 3600


def libya_today(now: datetime) -> date:
    try:
        from zoneinfo import ZoneInfo

        return now.astimezone(ZoneInfo("Africa/Tripoli")).date()
    except Exception:
        return now.astimezone(timezone.utc).date()


_ROW_COLUMNS = ("created_at", "created_by", "deleted")


def campaign_rows_sql(dialect: str | None = None, columns: tuple[str, ...] = _ROW_COLUMNS) -> str:
    """Every request row, archived ones included (the ``deleted`` column says which)."""
    return json_fields_select_sql(_FIELDS, columns, "type = :type", dialect)


def load_campaign_rows(conn: Any, *, with_id: bool = False) -> list[dict[str, Any]]:
    """The fields the baselines need, projected in SQL (no creative images are read). ``with_id``
    adds each row's ``id`` (the operations lines join the results rows on it)."""
    columns = ("id",) + _ROW_COLUMNS if with_id else _ROW_COLUMNS
    rows = conn.execute(text(campaign_rows_sql(columns=columns)), {"type": AD_CAMPAIGN_COLLECTION}).mappings().all()
    out = []
    for row in rows:
        item = {field: row.get(f"f_{field.lower()}") for field in _FIELDS}
        item["reviewHistory"] = json_loads_or_raw(item.get("reviewHistory"))
        item["createdAtMs"] = row.get("created_at")
        item["ownerId"] = str(row.get("created_by") or "")
        item["archived"] = bool(row.get("deleted"))
        if with_id:
            item["id"] = str(row.get("id") or "")
        out.append(item)
    return out


def _median_hours(values: list[float]) -> dict[str, Any] | None:
    if not values:
        return None
    return {"value": round(statistics.median(values), 2), "unit": "hours", "sample": len(values)}


def compute_diagnostics(
    rows: list[dict[str, Any]],
    account_created: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Counts by status, holds and B1-B6 from rows shaped like ``load_campaign_rows``.

    A row with ``archived`` true counts only in the history baselines (B1, B2, B5, B6).
    """
    now = now or datetime.now(timezone.utc)
    today = libya_today(now)
    by_status = {status: 0 for status in CAMPAIGN_STATUSES}
    by_status["other"] = 0
    live = archived = 0
    holds = 0
    b1: list[float] = []
    decisions = 0
    sent_back = 0
    b3_count = b3_sample = 0
    b4_count = b4_sample = 0
    b5: list[float] = []
    first_approval: dict[str, datetime] = {}

    for row in rows:
        status = str(row.get("status") or "Draft")
        is_live = not row.get("archived")
        if is_live:
            live += 1
            by_status[status if status in by_status else "other"] += 1
        else:
            archived += 1
        submitted = parse_time(row.get("submittedAt"))
        reviewed = parse_time(row.get("reviewedAt"))
        history = row.get("reviewHistory") if isinstance(row.get("reviewHistory"), list) else []
        review_times = []
        for entry in history:
            if not isinstance(entry, dict) or entry.get("decision") not in REVIEW_DECISIONS:
                continue
            decisions += 1
            sent_back += entry.get("decision") == "Changes Requested"
            review_times.append(parse_time(entry.get("reviewedAt")))

        if status != "Submitted" and submitted and reviewed and reviewed >= submitted:
            b1.append(_hours(reviewed, submitted))

        if is_live and status == "Submitted" and _minor(row.get("budgetMinorUSD")) > 0:
            holds += 1
            if submitted:
                b3_sample += 1
                b3_count += now - submitted > timedelta(days=HOLD_AGE_DAYS)

        if is_live and status == "Approved":
            end = parse_day(row.get("endDate"))
            if end:
                b4_sample += 1
                b4_count += today > end + timedelta(days=UNSETTLED_GRACE_DAYS)

        created = _from_ms(row.get("createdAtMs"))
        # The latest submit is the first one only when no review happened before it.
        if submitted and created and submitted >= created and not any(t is None or t < submitted for t in review_times):
            b5.append(_hours(submitted, created))

        approved = parse_time(row.get("approvedAt"))
        owner = str(row.get("ownerId") or "")
        if approved and owner and (owner not in first_approval or approved < first_approval[owner]):
            first_approval[owner] = approved

    b6 = []
    for owner, approved in first_approval.items():
        joined = _from_ms(account_created.get(owner))
        if joined and approved >= joined:
            b6.append(_hours(approved, joined))

    return {
        "campaigns": {"total": live, "archived": archived, "byStatus": by_status},
        "holds": {"count": holds},
        "baselines": {
            "B1": _median_hours(b1),
            "B2": (
                {"value": round(100 * sent_back / decisions, 1), "unit": "percent", "sample": decisions}
                if decisions else None
            ),
            "B3": {"value": b3_count, "unit": "count", "sample": b3_sample},
            "B4": {"value": b4_count, "unit": "count", "sample": b4_sample},
            "B5": _median_hours(b5),
            "B6": _median_hours(b6),
        },
    }


# ------------------------------------------------------------------ P3-19: operations lines

QUEUE_WINDOW_DAYS = 7  # PLAN.md §12.3: every queue on target >= 90% over the previous week
TIMES_WINDOW_DAYS = 30
REPLY_WINDOW_DAYS = 7
STORAGE_CACHE_SECONDS = 600
STORAGE_TOP_TYPES = 10
STORAGE_TOP_OWNERS = 5
RESULTS_TYPE = "adCampaignResults"  # studio_results.RESULTS_TYPE (imported late: it imports this module)
ALERTS_TYPE = "studioAlerts"  # studio_jobs.ALERTS_TYPE (same reason)
MONEY_INCIDENT_KINDS = frozenset({"integrity_violation", "approval_interrupted", "studio_core_collision"})
STOP_HANDLED_REASONS = frozenset({"stopped", "meta_paused"})
REPLY_SOURCES = ("webhook", "poll", "manual_check")
QUEUE_TARGETS = {
    # queue -> (studio_hours target name, targets field)
    "reviews": ("review", "reviewBusinessDays"),
    "tickets": ("ticket", "ticketFirstResponseMinutes"),
    "stopRequests": ("stop_request", "stopRequestMinutes"),
    "payments": ("payment", "paymentConfirmMinutes"),
}
_RESULTS_FIELDS = (
    "campaignId", "metaCampaignId", "spendMinorUSD", "currency", "lastSyncedAt", "settleReadDueAt", "deliveryEndedAt",
    "neverDelivered",
)
_TICKET_FIELDS = ("kind", "status", "createdAt", "firstStaffAt")
_STOP_FIELDS = ("campaignId", "requestedAt", "dueAt", "resolvedAt", "state", "resolvedReason")
_REPLY_FIELDS = ("source", "commentAt", "actions", "error", "retryAfter", "processing", "parkedReason")
_ALERT_FIELDS = ("kind", "acknowledgedAt")
_TOKEN_FIELDS = (
    "configured", "checked", "stale", "checkedAt", "isValid", "type", "expiresAt", "expiresNever", "daysLeft",
    "dataAccessExpiresAt", "dataAccessExpiresNever", "dataAccessDaysLeft", "missingScopes", "errorCode",
    "lastCheckError", "lastCheckErrorAt", "message",
)
_STORAGE_CACHE: dict[str, Any] = {"at": None, "value": None}


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime | None) -> str | None:
    return _aware(moment).astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if moment else None


def _minutes(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 60


def _whole_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _flag(value: Any) -> bool:
    return value is True or str(value or "").strip().lower() in ("1", "true")


def percentile(values: list[float], share: int) -> float | None:
    """The nearest-rank percentile (p50 = the median of a sorted list, p90 = the value 90% sit at or below)."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(math.ceil(share / 100 * len(ordered)) - 1, 0)]


def _spread(values: list[float], unit: str = "minutes") -> dict[str, Any] | None:
    if not values:
        return None
    return {"p50": round(percentile(values, 50), 1), "p90": round(percentile(values, 90), 1), "unit": unit, "sample": len(values)}


def _queue_line(done: list[tuple[datetime, datetime | None]], overdue_open: int, target: dict[str, Any], threshold: int) -> dict[str, Any]:
    """``done``: (finished at, due at) of the items finished inside the window; ``overdue_open``: items
    still waiting past their due time (each a miss). An item without a due time is not judged."""
    judged = [(finished, due) for finished, due in done if due is not None]
    met = sum(1 for finished, due in judged if finished <= due)
    missed = len(judged) - met + int(overdue_open)
    sample = met + missed
    percent = round(100 * met / sample, 1) if sample else None
    return {
        "target": target, "met": met, "missed": missed, "waitingOverdue": int(overdue_open), "sample": sample,
        "percent": percent, "onTarget": None if percent is None else percent >= threshold,
    }


# ---- loaders (SQL projections; each row's JSON parsed once, never a request's images)

def load_results_rows(conn: Any) -> dict[str, dict[str, Any]]:
    """{campaign id: the money and timing fields of its results row} (live rows)."""
    rows = conn.execute(
        text(json_fields_select_sql(_RESULTS_FIELDS, ("id",), "type = :type AND deleted = false")),
        {"type": RESULTS_TYPE},
    ).mappings().all()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        campaign_id = str(row.get("f_campaignid") or "")
        if campaign_id:
            out[campaign_id] = {field: row.get(f"f_{field.lower()}") for field in _RESULTS_FIELDS}
    return out


def load_ticket_rows(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        text(json_fields_select_sql(_TICKET_FIELDS, ("created_by",), "type = :type AND deleted = false")),
        {"type": SUPPORT_TICKETS_TYPE},
    ).mappings().all()
    return [{**{field: row.get(f"f_{field.lower()}") for field in _TICKET_FIELDS}, "ownerId": str(row.get("created_by") or "")}
            for row in rows]


def load_stop_rows(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        text(json_fields_select_sql(_STOP_FIELDS, ("created_by",), "type = :type AND deleted = false")),
        {"type": STUDIO_STOP_REQUESTS_TYPE},
    ).mappings().all()
    return [{**{field: row.get(f"f_{field.lower()}") for field in _STOP_FIELDS}, "ownerId": str(row.get("created_by") or "")}
            for row in rows]


def load_reply_rows(conn: Any, since: datetime) -> list[dict[str, Any]]:
    """The reply-log rows changed since ``since`` (the window), as their timing and outcome fields."""
    rows = conn.execute(
        text(json_fields_select_sql(_REPLY_FIELDS, ("last_modified", "created_by"),
                                    "type = :type AND deleted = false AND last_modified >= :since")),
        {"type": REPLY_LOG_TYPE, "since": int(_aware(since).timestamp() * 1000)},
    ).mappings().all()
    out = []
    for row in rows:
        item = {field: row.get(f"f_{field.lower()}") for field in _REPLY_FIELDS}
        item["actions"] = json_loads_or_raw(item.get("actions"))
        item["lastModifiedMs"] = int(row.get("last_modified") or 0)
        item["ownerId"] = str(row.get("created_by") or "")
        out.append(item)
    return out


def load_alert_rows(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        text(json_fields_select_sql(_ALERT_FIELDS, (), "type = :type AND deleted = false")), {"type": ALERTS_TYPE},
    ).mappings().all()
    return [{field: row.get(f"f_{field.lower()}") for field in _ALERT_FIELDS} for row in rows]


def load_operations_inputs(conn: Any, now: datetime, campaigns: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Every studio row list the operations lines need, on one connection (the doors included).
    ``campaigns``: rows already loaded with ``load_campaign_rows(conn, with_id=True)``, else read here."""
    window = max(QUEUE_WINDOW_DAYS, TIMES_WINDOW_DAYS, REPLY_WINDOW_DAYS)
    return {
        "campaigns": campaigns if campaigns is not None else load_campaign_rows(conn, with_id=True),
        "results": load_results_rows(conn),
        "tickets": load_ticket_rows(conn),
        "stops": load_stop_rows(conn),
        "payments": payment_request_timings(conn),
        "replies": load_reply_rows(conn, now - timedelta(days=window)),
        "alerts": load_alert_rows(conn),
        "balances": usd_customer_balances_total(conn),
    }


# ---- the pure computation

def _due(target: str, start: datetime | None, settings: dict[str, Any]) -> datetime | None:
    if start is None:
        return None
    try:
        return target_due_at(target, start, settings)
    except (ValueError, KeyError, TypeError):
        return None


def _paid(row: dict[str, Any]) -> int:
    """What a request paid at approval: ``paidMinorUSD``, else its hold (the link's budget check reads it so)."""
    return _minor(row.get("paidMinorUSD")) or campaign_hold_minor(
        {"totalBudgetMinorUSD": row.get("totalBudgetMinorUSD"), "budgetMinorUSD": row.get("budgetMinorUSD")}
    )


def _month_of(moment: datetime) -> str:
    return libya_today(moment).isoformat()[:7]


def compute_operations(inputs: dict[str, Any], settings: dict[str, Any], now: datetime, *, submissions_today: int = 0) -> dict[str, Any]:
    """The operations lines from rows already read (pure: see load_operations_inputs for the shapes).

    ``inputs``: ``campaigns`` (load_campaign_rows), ``results`` (load_results_rows), ``tickets``,
    ``stops``, ``payments`` (wallet_payments.payment_request_timings), ``replies``, ``alerts``,
    ``balances`` (wallet_payments.usd_customer_balances_total). Missing keys read as empty.
    """
    now = _aware(now)
    targets = settings["targets"]
    thresholds = settings["thresholds"]
    queue_since = now - timedelta(days=QUEUE_WINDOW_DAYS)
    times_since = now - timedelta(days=TIMES_WINDOW_DAYS)
    campaigns = list(inputs.get("campaigns") or [])
    results = dict(inputs.get("results") or {})
    tickets = list(inputs.get("tickets") or [])
    stops = list(inputs.get("stops") or [])
    payments = list(inputs.get("payments") or [])
    replies = list(inputs.get("replies") or [])
    alerts = list(inputs.get("alerts") or [])
    balances = dict(inputs.get("balances") or {})
    on_target = int(thresholds["queueOnTargetPercent"])
    month = _month_of(now)

    # --- reviews, links, settles, capacity and money from the request rows
    review_done: list[tuple[datetime, datetime | None]] = []
    review_overdue = 0
    review_minutes: list[float] = []
    link_minutes: list[float] = []
    settle_minutes: list[float] = []
    waiting = 0
    sends_by_day: dict[str, int] = {}
    reviewed_in_window = 0
    in_ads = 0
    linked_live = fresh_live = 0
    fresh_after = now - timedelta(hours=int(thresholds["resultsFreshHours"]))
    overspend_total = overspend_month = overspend_campaigns = 0
    kept_month = spend_month = reconciled = 0
    for row in campaigns:
        status = str(row.get("status") or "Draft")
        live = not row.get("archived")
        submitted = parse_time(row.get("submittedAt"))
        reviewed = parse_time(row.get("reviewedAt"))
        approved = parse_time(row.get("approvedAt"))
        linked = parse_time(row.get("linkedAt"))
        stopped = parse_time(row.get("stoppedAt"))
        campaign_id = str(row.get("id") or "")
        result = results.get(campaign_id) if campaign_id else None
        if submitted is not None:
            if live and status == "Submitted":
                waiting += 1
                due = _due("review", submitted, settings)
                review_overdue += bool(due is not None and now > due)
            elif reviewed is not None and reviewed >= submitted:
                if reviewed >= queue_since:
                    review_done.append((reviewed, _due("review", submitted, settings)))
                if reviewed >= times_since:
                    review_minutes.append(_minutes(reviewed, submitted))
                    reviewed_in_window += 1
            if submitted >= queue_since:
                day = libya_today(submitted).isoformat()
                sends_by_day[day] = sends_by_day.get(day, 0) + 1
        if approved is not None and linked is not None and linked >= approved and linked >= times_since:
            link_minutes.append(_minutes(linked, approved))
        if live and status == "Approved":
            in_ads += _paid(row)
            if str(row.get("metaCampaignId") or "").strip():
                linked_live += 1
                synced = parse_time((result or {}).get("lastSyncedAt"))
                fresh_live += bool(synced is not None and synced >= fresh_after)
        usd_result = bool(result) and str(result.get("currency") or "").strip().upper() == "USD" and \
            str(result.get("metaCampaignId") or "") == str(row.get("metaCampaignId") or "") and bool(str(row.get("metaCampaignId") or "").strip())
        if usd_result and status in ("Approved", "Stopped"):
            spend = _minor(result.get("spendMinorUSD"))
            over = max(spend - _paid(row), 0)
            if over:
                overspend_total += over
                overspend_campaigns += 1
                if status == "Approved" or (stopped is not None and _month_of(stopped) == month):
                    overspend_month += over
            if status == "Stopped" and stopped is not None and _month_of(stopped) == month:
                kept_month += max(_paid(row) - _minor(row.get("refundMinorUSD")), 0)
                spend_month += spend
                reconciled += 1
        if status == "Stopped" and stopped is not None and stopped >= times_since and result \
                and str(row.get("closeReason") or "") == "completed":
            gate = parse_time(result.get("deliveryEndedAt")) if _flag(result.get("neverDelivered")) else parse_time(result.get("settleReadDueAt"))
            if gate is not None:
                settle_minutes.append(max(_minutes(stopped, gate), 0.0))

    # --- tickets (stop-request tickets belong to the stop queue)
    ticket_done: list[tuple[datetime, datetime | None]] = []
    ticket_overdue = 0
    ticket_minutes: list[float] = []
    for row in tickets:
        if str(row.get("kind") or "question") == "stop_request":
            continue
        created = parse_time(row.get("createdAt"))
        first = parse_time(row.get("firstStaffAt"))
        if created is None:
            continue
        if first is not None and first >= created:
            if first >= queue_since:
                ticket_done.append((first, _due("ticket", created, settings)))
            if first >= times_since:
                ticket_minutes.append(_minutes(first, created))
        elif str(row.get("status") or "open") in ("", "open"):
            due = _due("ticket", created, settings)
            ticket_overdue += bool(due is not None and now > due)

    # --- stop requests (the due time stored with the request: working minutes at that moment)
    stop_done: list[tuple[datetime, datetime | None]] = []
    stop_overdue = 0
    stop_minutes: list[float] = []
    for row in stops:
        requested = parse_time(row.get("requestedAt"))
        if requested is None:
            continue
        due = parse_time(row.get("dueAt")) or _due("stop_request", requested, settings)
        resolved = parse_time(row.get("resolvedAt")) if str(row.get("state") or "open") == "resolved" else None
        if resolved is not None and resolved >= requested:
            if str(row.get("resolvedReason") or "") in STOP_HANDLED_REASONS or not str(row.get("resolvedReason") or ""):
                if resolved >= queue_since:
                    stop_done.append((resolved, due))
                if resolved >= times_since:
                    stop_minutes.append(_minutes(resolved, requested))
        elif resolved is None:
            stop_overdue += bool(due is not None and now > due)

    # --- payment confirmations (the platform door's rows: status and times only)
    payment_done: list[tuple[datetime, datetime | None]] = []
    payment_overdue = 0
    payment_minutes: list[float] = []
    for row in payments:
        created = parse_time(row.get("createdAt"))
        if created is None:
            continue
        status = str(row.get("status") or "")
        confirmed = parse_time(row.get("confirmedAt")) if status == "confirmed" else None
        if confirmed is not None and confirmed >= created:
            if confirmed >= queue_since:
                payment_done.append((confirmed, _due("payment", created, settings)))
            if confirmed >= times_since:
                payment_minutes.append(_minutes(confirmed, created))
        elif status == "pending":
            due = _due("payment", created, settings)
            payment_overdue += bool(due is not None and now > due)

    # --- comment replies
    reply_since = now - timedelta(days=REPLY_WINDOW_DAYS)
    latency: dict[str, list[float]] = {source: [] for source in REPLY_SOURCES}
    answered = failed = parked = missed = 0
    for row in replies:
        changed = _from_ms(row.get("lastModifiedMs"))
        if changed is None or changed < reply_since or _flag(row.get("processing")):
            continue
        actions = row.get("actions") if isinstance(row.get("actions"), list) else []
        error = str(row.get("error") or "")
        retry_pending = bool(str(row.get("retryAfter") or "").strip())
        if actions:
            answered += 1
            comment_at = parse_time(row.get("commentAt"))
            source = str(row.get("source") or "webhook")
            if comment_at is not None and changed >= comment_at and source in latency:
                latency[source].append((changed - comment_at).total_seconds())
        elif error == MISSED_DURING_OUTAGE:
            missed += 1
            failed += 1
        elif retry_pending:
            parked += str(row.get("parkedReason") or "") == PARKED_REASON
        elif error:
            failed += 1
    reply_sample = answered + failed
    failure_percent = round(100 * failed / reply_sample, 1) if reply_sample else None

    money_incidents = sum(
        1 for row in alerts
        if str(row.get("kind") or "") in MONEY_INCIDENT_KINDS and not str(row.get("acknowledgedAt") or "").strip()
    )
    cap = int(settings["intake"]["maxSubmissionsPerDay"])
    tolerance = max(int(thresholds["reconcileToleranceMinorUSD"]), spend_month * int(thresholds["reconcileToleranceBasisPoints"]) // 10_000)
    balance_minor = _whole_or_none(balances.get("balanceMinor")) or 0
    queues: dict[str, Any] = {}
    for name, done, overdue in (
        ("reviews", review_done, review_overdue), ("tickets", ticket_done, ticket_overdue),
        ("stopRequests", stop_done, stop_overdue), ("payments", payment_done, payment_overdue),
    ):
        field = QUEUE_TARGETS[name][1]
        target = {"field": field, "value": int(targets[field]), "unit": "businessDays" if field.endswith("Days") else "minutes"}
        queues[name] = _queue_line(done, overdue, target, on_target)
    return {
        "window": {"queueDays": QUEUE_WINDOW_DAYS, "timesDays": TIMES_WINDOW_DAYS, "replyDays": REPLY_WINDOW_DAYS},
        "queues": queues,
        "staffTimes": {
            "review": _spread(review_minutes),
            "link": _spread(link_minutes),
            "settle": _spread(settle_minutes),
            "ticketFirstResponse": _spread(ticket_minutes),
            "stopToPaused": _spread(stop_minutes),
            "paymentConfirmation": _spread(payment_minutes),
        },
        "capacity": {
            "intake": {"open": bool(settings["intake"]["open"]), "maxSubmissionsPerDay": cap},
            "submissionsToday": int(submissions_today),
            "usedPercent": round(100 * int(submissions_today) / cap, 1) if cap else None,
            "sendsPerDay7d": {
                "average": round(sum(sends_by_day.values()) / QUEUE_WINDOW_DAYS, 2),
                "max": max(sends_by_day.values(), default=0),
            },
            "waitingReview": waiting,
            "reviewed30d": reviewed_in_window,
        },
        "replies": {
            "latency": {
                source: {"p95Seconds": round(percentile(values, 95), 1) if values else None, "sample": len(values)}
                for source, values in latency.items()
            },
            "failures": {
                "answered": answered, "failed": failed, "sample": reply_sample, "percent": failure_percent,
                "ok": None if failure_percent is None else failure_percent < int(thresholds["replyFailureMaxPercent"]),
            },
            "missedDuringOutage": missed,
            "parked": parked,
        },
        "results": {
            "linked": linked_live, "fresh": fresh_live, "freshHours": int(thresholds["resultsFreshHours"]),
            "percent": round(100 * fresh_live / linked_live, 1) if linked_live else None,
            "ok": None if not linked_live else (100 * fresh_live / linked_live) >= int(thresholds["resultsFreshPercent"]),
        },
        "money": {
            "owed": {
                "walletBalancesMinorUSD": balance_minor,
                "walletsWithMoney": _whole_or_none(balances.get("users")) or 0,
                "negativeWallets": _whole_or_none(balances.get("negative")) or 0,
                "inAdsMinorUSD": in_ads,
                "owedMinorUSD": balance_minor + in_ads,
            },
            "absorbedOverspend": {"totalMinorUSD": overspend_total, "thisMonthMinorUSD": overspend_month, "campaigns": overspend_campaigns},
            "reconciliation": {
                "month": month, "settled": reconciled, "keptMinorUSD": kept_month, "metaSpendMinorUSD": spend_month,
                "differenceMinorUSD": kept_month - spend_month, "toleranceMinorUSD": tolerance,
                "withinTolerance": None if not reconciled else abs(kept_month - spend_month) <= tolerance,
            },
            "openIncidents": money_incidents,
        },
    }


# ---- storage, funds, Meta state (read from the database and the platform doors)

def _database_bytes(conn: Any) -> int | None:
    try:
        if conn.dialect.name == "postgresql":
            return _whole_or_none(conn.execute(text("SELECT pg_database_size(current_database())")).scalar())
        pages = _whole_or_none(conn.execute(text("PRAGMA page_count")).scalar())
        page_size = _whole_or_none(conn.execute(text("PRAGMA page_size")).scalar())
        return pages * page_size if pages is not None and page_size is not None else None
    except Exception:
        return None


def read_storage(conn: Any, *, force: bool = False) -> dict[str, Any]:
    """Rows and bytes by record type and by owner (counts only), the database size and the last backup.
    The aggregates walk the whole entities table, so they are kept for STORAGE_CACHE_SECONDS per process."""
    clock = time.monotonic()
    cached = _STORAGE_CACHE["value"]
    if not force and cached is not None and _STORAGE_CACHE["at"] is not None and clock - _STORAGE_CACHE["at"] < STORAGE_CACHE_SECONDS:
        return dict(cached, lastBackup=_last_backup())
    size = "octet_length(data_json)" if conn.dialect.name == "postgresql" else "length(CAST(data_json AS BLOB))"
    by_type = conn.execute(
        text(f"SELECT type, COUNT(*) AS row_count, COALESCE(SUM({size}), 0) AS byte_count FROM entities "
             "GROUP BY type ORDER BY byte_count DESC, type ASC LIMIT :limit"),
        {"limit": STORAGE_TOP_TYPES},
    ).mappings().all()
    totals = conn.execute(text(f"SELECT COUNT(*) AS row_count, COALESCE(SUM({size}), 0) AS byte_count FROM entities")).mappings().first()
    owners = conn.execute(
        text(f"SELECT COUNT(*) AS row_count, COALESCE(SUM({size}), 0) AS byte_count FROM entities "
             "WHERE created_by IS NOT NULL GROUP BY created_by ORDER BY byte_count DESC LIMIT :limit"),
        {"limit": STORAGE_TOP_OWNERS},
    ).mappings().all()
    value = {
        "readAt": _iso(datetime.now(timezone.utc)),
        "databaseBytes": _database_bytes(conn),
        "totalRows": int((totals or {}).get("row_count") or 0),
        "totalBytes": int((totals or {}).get("byte_count") or 0),
        "byType": [{"type": str(row["type"]), "rows": int(row["row_count"] or 0), "bytes": int(row["byte_count"] or 0)} for row in by_type],
        "topOwners": [{"rows": int(row["row_count"] or 0), "bytes": int(row["byte_count"] or 0)} for row in owners],
        "cacheSeconds": STORAGE_CACHE_SECONDS,
    }
    _STORAGE_CACHE.update({"at": clock, "value": value})
    return dict(value, lastBackup=_last_backup())


def reset_storage_cache() -> None:
    _STORAGE_CACHE.update({"at": None, "value": None})


def _last_backup() -> dict[str, Any]:
    """What the operations worker recorded of the last encrypted backup (time and size only)."""
    try:
        backup = _operations._public_status().get("backup") or {}
    except Exception:
        return {"enabled": None, "at": None, "bytes": None}
    return {
        "enabled": bool(backup.get("enabled")),
        "at": _iso(_from_ms(backup.get("lastBackupAt"))),
        "bytes": _whole_or_none(backup.get("lastBackupBytes")),
    }


def read_studio_funds() -> dict[str, Any]:
    """The last stored funds reading of the allowlisted ad accounts (D26: the studio's accounts), as
    counts and flags with the account's last 4 digits: never an id or a token."""
    try:
        allowed = set(_meta.load_meta_ads_config().allowed_account_ids)
    except Exception:
        allowed = set()
    stored = _meta._load_funds_state()
    accounts: list[dict[str, Any]] = []
    total: int | None = None
    unreadable = 0
    for row in stored.get("accounts") or []:
        digits = re.sub(r"\D", "", str(row.get("id") or "")) if isinstance(row, dict) else ""
        if not digits or (allowed and digits not in allowed):
            continue
        currency = str(row.get("currency") or "").strip().upper()
        funds = _whole_or_none(row.get("fundsMinor"))
        item = {
            "account": _meta.account_tail(digits),
            "currency": currency[:12],
            "isPrepay": row.get("isPrepay") if isinstance(row.get("isPrepay"), bool) else None,
            "fundsMinor": funds,
            "capRemainingMinor": _whole_or_none(row.get("capRemainingMinor")),
            "status": _whole_or_none(row.get("status")),
            "fundsHidden": row.get("fundsHidden") is True,
            "readError": bool(row.get("error")),
            "stale": row.get("stale") is True,
        }
        accounts.append(item)
        if funds is not None and not item["readError"] and currency in ("", "USD"):
            total = (total or 0) + max(funds, 0)
        else:
            unreadable += 1
    return {
        "readAt": _meta._clean_time(stored.get("updatedAt")) or None,
        "allowlistConfigured": bool(allowed),
        "accounts": accounts[:_meta._META_FUNDS_MAX_ACCOUNTS],
        "fundsMinorUSD": total,
        "unreadable": unreadable,
    }


def read_token_state() -> dict[str, Any]:
    """The stored token reading's health fields (meta_token_health.token_health_report, already
    scrubbed of secrets): validity, expiry, days left, missing permissions. Never the token."""
    try:
        report = _token_health.token_health_report()
    except Exception as error:
        return {"configured": None, "checked": False, "readError": type(error).__name__}
    return {field: report.get(field) for field in _TOKEN_FIELDS if field in report}


def go_no_go(operations: dict[str, Any], facts: dict[str, Any], thresholds: dict[str, Any]) -> dict[str, Any]:
    """PLAN.md §12.8 as booleans (pure). ``facts``: ``scan`` (studioJobState.lastIntegrityResult or
    None), ``jobsAgeSeconds`` (None = never ticked), ``token`` (read_token_state), ``connection``
    (studio_alerts_meta.connection_state), ``now``."""
    scan = facts.get("scan") if isinstance(facts.get("scan"), dict) else None
    by_code = {str(code): int(count) for code, count in ((scan or {}).get("byCode") or {}).items()}
    queues = operations["queues"]
    replies = operations["replies"]
    money = operations["money"]
    token = facts.get("token") if isinstance(facts.get("token"), dict) else {}
    connection = facts.get("connection") if isinstance(facts.get("connection"), dict) else {}
    now = _aware(facts.get("now") or datetime.now(timezone.utc))

    def scan_zero(*codes: str) -> bool | None:
        return None if scan is None else all(by_code.get(code, 0) == 0 for code in codes)

    def latency_ok(source: str, limit: int) -> bool | None:
        value = replies["latency"][source]["p95Seconds"]
        return None if value is None else value <= limit

    token_ok: bool | None = None
    if token.get("configured") and token.get("checked") and not token.get("stale"):
        days = token.get("daysLeft")
        data_days = token.get("dataAccessDaysLeft")
        enough = (token.get("expiresNever") is True or (isinstance(days, int) and days > int(thresholds["tokenMinDaysLeft"]))) and \
            (token.get("dataAccessExpiresNever") is True or data_days is None or (isinstance(data_days, int) and data_days > int(thresholds["tokenMinDaysLeft"])))
        token_ok = bool(token.get("isValid")) and enough
    down_since = parse_time(connection.get("since")) if connection.get("state") == "down" else None
    outage_hours = (now - down_since).total_seconds() / 3600 if down_since else 0.0
    age = facts.get("jobsAgeSeconds")
    go = {
        "integrityViolations": {"ok": None if scan is None else int(scan.get("total") or 0) == 0, "value": None if scan is None else int(scan.get("total") or 0)},
        "refundsAboveCap": {"ok": scan_zero("refund_above_unspent"), "value": by_code.get("refund_above_unspent") if scan else None},
        "reconciliation": {"ok": money["reconciliation"]["withinTolerance"], "value": money["reconciliation"]["differenceMinorUSD"]},
        "reviewsOnTarget": {"ok": queues["reviews"]["onTarget"], "value": queues["reviews"]["percent"]},
        "stopRequestsOnTarget": {"ok": queues["stopRequests"]["onTarget"], "value": queues["stopRequests"]["percent"]},
        "paymentsOnTarget": {"ok": queues["payments"]["onTarget"], "value": queues["payments"]["percent"]},
        "ticketsOnTarget": {"ok": queues["tickets"]["onTarget"], "value": queues["tickets"]["percent"]},
        "resultsFresh": {"ok": operations["results"]["ok"], "value": operations["results"]["percent"]},
        "webhookReplyP95": {"ok": latency_ok("webhook", int(thresholds["webhookReplyP95Seconds"])), "value": replies["latency"]["webhook"]["p95Seconds"]},
        "pollReplyP95": {"ok": latency_ok("poll", int(thresholds["pollReplyP95Seconds"])), "value": replies["latency"]["poll"]["p95Seconds"]},
        "replyFailureRate": {"ok": replies["failures"]["ok"], "value": replies["failures"]["percent"]},
        "commentsLostToOutage": {"ok": replies["missedDuringOutage"] == 0, "value": replies["missedDuringOutage"]},
        "noOpenMoneyIncident": {"ok": money["openIncidents"] == 0, "value": money["openIncidents"]},
        "runbookRehearsed": {"ok": None, "value": None},  # not recorded anywhere: the owner ticks it by hand
        "restoreProven": {"ok": None, "value": None},  # a restore proof is not recorded anywhere yet
        "tokenValid": {"ok": token_ok, "value": token.get("daysLeft")},
    }
    stop = {
        "walletIdentityBreak": {"fired": None if scan is None else by_code.get("wallet_identity_break", 0) > 0},
        "duplicateCharge": {"fired": None if scan is None else (by_code.get("duplicate_return", 0) + by_code.get("return_above_paid", 0)) > 0},
        "strandedCapture": {"fired": None if scan is None else by_code.get("stranded_capture", 0) > 0},
        "studioInCoreBooks": {"fired": None if scan is None else by_code.get("studio_in_core_books", 0) > 0},
        "replyOutage": {"fired": outage_hours > int(thresholds["replyOutageMaxHours"]), "hours": round(outage_hours, 1)},
        "heartbeatLate": {"fired": age is None or int(age) > int(thresholds["heartbeatLateMaxMinutes"]) * 60, "ageSeconds": age},
    }
    unknown = sorted(name for name, row in go.items() if row["ok"] is None)
    return {
        "go": {**go},
        "stop": stop,
        "allKnownOk": all(row["ok"] for row in go.values() if row["ok"] is not None),
        "unknown": unknown,
        "goVerdict": None if unknown else all(row["ok"] for row in go.values()),
        "stopVerdict": any(row["fired"] for row in stop.values()),
        "consecutiveWeeksNeeded": int(thresholds["goConsecutiveWeeks"]),
    }


def read_operations(
    now: datetime | None = None,
    settings: dict[str, Any] | None = None,
    *,
    inputs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The ``operations`` block (P3-19): rows read through projections and doors, then computed.
    ``inputs``: load_operations_inputs already read on the caller's connection, else read here."""
    from . import studio_alerts_meta, studio_jobs  # late: both import this module

    now = _aware(now or datetime.now(timezone.utc))
    settings = settings or read_all_settings()
    with db_conn() as conn:
        if inputs is None:
            inputs = load_operations_inputs(conn, now)
        storage = read_storage(conn)
    operations = compute_operations(inputs, settings, now, submissions_today=count_submissions_today(libya_today(now).isoformat()))
    jobs = studio_jobs.jobs_heartbeat(now)
    funds = read_studio_funds()
    operations["money"]["studioFunds"] = funds
    owed = operations["money"]["owed"]
    owed["studioFundsMinorUSD"] = funds["fundsMinorUSD"]
    owed["fundsMinusOwedMinorUSD"] = None if funds["fundsMinorUSD"] is None else funds["fundsMinorUSD"] - owed["owedMinorUSD"]
    operations["money"]["reconciliation"].update({
        "lastScanAt": jobs.get("lastIntegrityScanAt"),
        "violations": jobs.get("lastIntegrityResult"),
    })
    operations["storage"] = storage
    try:
        connection = studio_alerts_meta.connection_state()
    except Exception as error:
        connection = {"state": "unknown", "readError": type(error).__name__}
    token = read_token_state()
    operations["meta"] = {"connection": connection, "token": token, "webhookCounters": _meta.webhook_counts_report()}
    operations["goNoGo"] = go_no_go(
        operations,
        {"scan": jobs.get("lastIntegrityResult"), "jobsAgeSeconds": jobs.get("ageSeconds"), "token": token, "connection": connection, "now": now},
        settings["thresholds"],
    )
    operations["jobs"] = jobs
    return operations


def read_diagnostics(now: datetime | None = None) -> dict[str, Any]:
    now = _aware(now or datetime.now(timezone.utc))
    with db_conn() as conn:
        rows = load_campaign_rows(conn, with_id=True)  # one projection serves the baselines and the operations lines
        created = account_created_at(conn, (r["ownerId"] for r in rows if r.get("approvedAt")))
        top_ups = confirmed_top_up_amounts(conn, TOP_UP_CURRENCY, TOP_UP_PRESETS)
        inputs = load_operations_inputs(conn, now, campaigns=rows)
    report = compute_diagnostics(rows, created, now)
    report["topUpPresets"] = {"currency": TOP_UP_CURRENCY, **top_ups}
    report["metaLanes"] = _meta.lane_state_report(refresh=True)  # P3-00c: pauses, counts and parks (last 4 digits) only
    report["operations"] = read_operations(now, inputs=inputs)  # P3-19: queues, staff times, capacity, storage, money, go/no-go
    report["jobs"] = report["operations"]["jobs"]
    return report
