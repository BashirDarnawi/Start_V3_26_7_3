"""Albayan Studio jobs loop (plan task P1-21; PLAN.md §7.4 "Studio jobs loop", §7.8, §7.1 types).

ONE daemon thread per process, started by the /api/studio router's startup event
(``create_studio_jobs_router``, included by studio_api.create_studio_router: 0 main.py lines),
whether or not Meta is configured: the money jobs never call Meta or need a Meta token. Three Meta
jobs run only while a Meta token is set (ALBAYAN_META_ACCESS_TOKEN, read without loading the Meta
client): the results sync (``results``, studio_results_sync.py, P3-03), one budgeted pass per tick
(at most 5 reads within 10 seconds), the Meta watch (token health and funds, P3-18), and the
Instagram polling source (``ig_poll``, studio_ig_source.py, P4-09), one budgeted pass per tick (at
most 20 reads within 10 seconds) claimed only while ``capabilities.igPublicReply`` is ``poll``. The env switch
``ALBAYAN_STUDIO_JOBS`` (default on; ``off``/``false``/``0``/``no`` = off) stops it, and it never starts
under pytest (``PYTEST_CURRENT_TEST``): the tests call the job functions directly. Every 30 s a tick
writes the heartbeat and runs the jobs that are due; a job that fails is logged (error type only),
remembered in ``studioJobState.lastError`` and runs again at its next turn, and the loop goes on.

* **Heartbeat and claims.** Each tick writes ``studioJobState.lastTickAt`` and, in the SAME write
  (conditional on the row's version, ``last_modified``), stamps the jobs it takes. Only one
  process can win that write, so a second process (there is one today, server/Dockerfile) never
  runs a claimed job twice.
* **Orphan sweep** (every 2 minutes). PLAN.md §7.4 line "money (no Meta): orphan sweep every 2 min",
  §7.8 lock table row "Orphan sweep (planned P1-21) | campaign row → ``rel:`` key", §7.8 "Being
  returned ... on its way back to you (usually within minutes)" and §12.5 "the jobs loop (sweep,
  daily scan) ... Orphans are released by the existing paths" say the sweep RETURNS money: a budget
  captured for a submission cycle its request has LEFT (sent back, rejected, withdrawn, or archived
  while waiting) and never returned. It locks the campaign row first and the ``rel:`` key second
  (the lock table order), re-checks under both locks, returns the capture through the platform door
  wallet_payments.release_orphan_campaign_payment (idempotency key ``rel:{cpay key}``: at most one
  return per payment cycle, whoever gets there first) and audits ``wallet_release`` in the same
  transaction. The ledger row and the audit entry have no user (NULL): the system did it. It looks
  at requests changed in the last 48 hours (a request that leaves a cycle is always rewritten); the
  daily run looks at all of them.
* **Interrupted approvals** (every 5 minutes). PLAN.md §7.4: "stale Submitted + capture > 15 min →
  ``approval_interrupted`` alert (never auto-released)". A capture older than 15 minutes whose
  request is STILL Submitted in that cycle (the approval's status write never happened) raises the
  alert and is NEVER returned by this loop: approving that cycle again reuses the capture
  (capture_campaign_budget replays its ``cpay:`` key), so returning it would give the ad away. Staff
  approve it or send it back (the send-back returns it). This check and the next read only the live
  Submitted requests: the database filters them (waiting_requests_sql, an index on PostgreSQL).
* **Overdue reviews** (every 5 minutes): a request Submitted longer than the review target
  (``targets.reviewBusinessDays``, counted on the working days of the ``hours`` setting, holidays
  skipped) raises ``review_overdue`` (a kind next to ``stop_request_overdue`` and
  ``payment_confirm_overdue``). Until the service-hours helper (P3-16) exists, a request is due at
  closing time of the Nth working day after the day it was sent.
* **Stop requests** (P3-10; on the same 5-minute turn, reported as ``stop_requests``):
  studio_stop.check_stop_requests resolves a handled stop request and its ticket (the request is
  Stopped, or Meta shows nothing delivering since the request) and raises ``stop_request_overdue``
  for one still open after its due time (``targets.stopRequestMinutes`` working minutes).
* **Daily money check** (the first tick at or after 04:00 Tripoli time, once per Tripoli day): the
  full sweep, then studio_integrity.scan_studio_money() on one snapshot → one
  ``integrity_violation`` alert per day holding the findings (counts and request/user ids, for
  admins); ``studioJobState.lastIntegrityResult`` keeps the counts only. A scan that fails is a
  ``check_failed`` finding, never silence.
* **Meta watch** (every 10 minutes, claimed ONLY while Meta is configured; the one job that calls
  Meta): studio_alerts_meta.run_meta_watch (P3-18a/c): the daily token check and its 14/7/2-day
  expiry alerts, the ``meta_connection_down`` state (rechecked while down) and, every 6 hours, the
  funds and status of the ad accounts that carry studio campaigns.
* **Staff channel** (the end of every tick that won the heartbeat write, reported as ``channel``):
  studio_alert_out.send_pending (P3-21) sends the open stop requests and the channel-worthy alerts
  nobody sent yet. It is idempotent (each row is stamped ``channelSentAt`` once the webhook accepted
  it) and answers at once while ``ALBAYAN_ALERT_WEBHOOK_URL`` is not set, so it costs nothing next
  to the operations worker's 300-s pass; it only makes a new stop request reach the team sooner.

Records (router-only types: the generic /api/collections API refuses both):

* ``studioAlerts``: id ``sal_`` + sha256(kind|related id|Tripoli day)[:40], so one finding raises at
  most one alert per item and day, however often it is seen (a repeat refreshes ``lastAt`` and
  ``count`` at most once an hour unless they change). ``created_by`` = the customer the alert is
  about, or NULL for a system alert, never a made-up value such as 'system' (the column is a
  foreign key to users.id). Fields: kind, relatedType, relatedId, ownerId, day, firstAt, lastAt,
  count, customerVisible (false), acknowledgedAt, acknowledgedBy, channelSentAt, details.
* ``studioJobState``: one row (``sjs_`` + sha256('studio-jobs')[:40]), ``created_by`` NULL:
  lastTickAt, lastSweepAt, lastWaitingCheckAt, lastIntegrityScanDay, lastIntegrityScanAt,
  lastIntegrityResult (counts only), lastError (job, error type, time; never a message),
  lastResultsSyncAt and resultsParkedUntil (the results sync's parked ad accounts),
  lastMetaWatchAt and lastFundsCheckAt (the Meta watch's turns), lastIgPollAt (the Instagram poll's
  last pass; its per-account state is metaHealthState/"studioIgPoll", studio_ig_source.py).

``GET /api/studio/admin/alerts`` (admin only, 30 reads a minute): newest first, ``limit`` 1-50
(20 by default), ``before`` = the ``nextBefore`` of the previous page; ``jobs`` = jobs_heartbeat().
Diagnostics shows the same heartbeat; it is ``late`` after 5 minutes (§7.4).

The wallet helpers (locks, idempotency lookups, the ledger insert, audit, the SQL balance the daily
scan checks the wallet screen against) come from main.py through a router ctx (D36: never an import
of main.py): the /api/studio router's own ctx when it carries them, else the ctx main.py gives the
Ads Studio routers (social_studio._ctx(), which spreads main's _WALLET_PAYMENTS_CTX).
"""

import math
import os
import re
import threading
from collections import defaultdict
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text

from ...db import db_conn, json_dumps, json_field_sql, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from ...wallet_payments import (
    _campaign_payment_key,
    campaign_capture_open_minor,
    release_orphan_campaign_payment,
    wallet_ledger_rows,
)
from . import social_studio, studio_integrity
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_alerts_meta import WATCH_EVERY as META_WATCH_EVERY, meta_watch_configured, run_meta_watch
from .studio_diagnostics import libya_today, parse_time
from .studio_errors import studio_error
from .studio_ig_source import ig_poll_configured, run_ig_poll
from .studio_settings import SERVICE_TIMEZONE, WEEKDAYS, read_all_settings
from .studio_types import created_by_or_none, derived_id

ALERTS_TYPE = "studioAlerts"
JOB_STATE_TYPE = "studioJobState"
JOB_STATE_ID = derived_id("sjs", "studio-jobs")
ENV_SWITCH = "ALBAYAN_STUDIO_JOBS"
_OFF_VALUES = {"0", "off", "false", "no"}

TICK_SECONDS = 30
FIRST_TICK_DELAY_SECONDS = 15  # let startup settle before the first database work
SWEEP_EVERY = timedelta(minutes=2)
WAITING_EVERY = timedelta(minutes=5)
RESULTS_EVERY = timedelta(seconds=TICK_SECONDS)  # one budgeted Meta results pass per tick (P3-03)
IG_POLL_EVERY = timedelta(seconds=TICK_SECONDS)  # one budgeted Instagram poll pass per tick (P4-09, studio_ig_source.py)
META_TOKEN_ENV = "ALBAYAN_META_ACCESS_TOKEN"
SWEEP_LOOKBACK = timedelta(hours=48)
INTERRUPTED_AFTER_MINUTES = studio_integrity.CAPTURE_GRACE_MINUTES  # 15 (PLAN.md §7.4)
DAILY_SCAN_AT = "04:00"  # Tripoli time
HEARTBEAT_LATE_SECONDS = 300  # PLAN.md §7.4: jobs_heartbeat_late after 5 minutes
ALERT_REFRESH = timedelta(hours=1)
CLOCK_SKEW = timedelta(minutes=5)  # a "last run" this far in the future means the clock moved back: run now
STATE_WRITE_ATTEMPTS = 3
ALERTS_PAGE_DEFAULT = 20
ALERTS_PAGE_MAX = 50
ALERT_READS_PER_MINUTE = 30

# PLAN.md §7.1 studioAlerts kinds, plus review_overdue (this loop's overdue-review alert) and
# meta_drift (the results sync's post-settle spend drift, P3-03).
ALERT_KINDS = (
    "reply_failure_burst", "page_health_drop", "meta_overspend", "post_settle_spend_drift", "running_past_end",
    "approval_interrupted", "results_parked", "studio_account_config", "studio_funds_low", "studio_account_inactive",
    "meta_connection_down", "meta_token_expiring", "replies_parked", "instagram_comments_not_arriving",
    "integrity_violation", "jobs_heartbeat_late", "stop_request_overdue", "payment_confirm_overdue",
    "storage_threshold", "studio_core_collision", "review_overdue", "meta_drift",
    "studio_funds_unreadable",  # P3-18c: Meta does not show an ad account's funds (studio_alerts_meta.py)
)
ALERT_LABELS: dict[str, dict[str, str]] = {
    # P3-18a/c (studio_alerts_meta.py)
    "meta_connection_down": {
        "en": "Albayan's Meta connection is down: the token check says it is not valid; comment replies are parked",
        "ar": "ربط البيان مع ميتا متوقف: فحص الرمز يقول إنه غير صالح؛ الردود على التعليقات محفوظة حتى يعود",
    },
    "meta_token_expiring": {
        "en": "Albayan's Meta token expires soon: refresh it before it stops",
        "ar": "رمز البيان في ميتا تنتهي صلاحيته قريباً: جدّده قبل أن يتوقف",
    },
    "studio_funds_low": {
        "en": "An ad account with studio ads has less money than those ads still need",
        "ar": "حساب إعلاني فيه إعلانات الاستوديو رصيده أقل مما تحتاجه هذه الإعلانات",
    },
    "studio_account_inactive": {
        "en": "An ad account with studio ads is not active in Meta",
        "ar": "حساب إعلاني فيه إعلانات الاستوديو غير نشط في ميتا",
    },
    "studio_funds_unreadable": {
        "en": "Meta does not show the funds of an ad account with studio ads (full control is needed)",
        "ar": "ميتا لا تعرض رصيد حساب إعلاني فيه إعلانات الاستوديو (يلزم تحكم كامل)",
    },
    "approval_interrupted": {
        "en": "An approval stopped halfway: the budget was paid but the request still waits for review",
        "ar": "توقفت موافقة في منتصفها: دُفعت الميزانية والطلب ما زال بانتظار المراجعة",
    },
    "review_overdue": {
        "en": "A request has waited for review longer than the target",
        "ar": "انتظر طلب المراجعة أكثر من الوقت المحدد",
    },
    "stop_request_overdue": {  # P3-10 (studio_stop.check_stop_requests)
        "en": "A stop request has waited longer than the target: pause the ad in Meta now",
        "ar": "انتظر طلب إيقاف أكثر من الوقت المحدد: أوقف الإعلان في ميتا الآن",
    },
    "integrity_violation": {
        "en": "The daily money check found a problem",
        "ar": "وجد فحص الأموال اليومي مشكلة",
    },
    "running_past_end": {
        "en": "An ad is still running on Meta after its end",
        "ar": "إعلان ما زال يعمل على ميتا بعد موعد انتهائه",
    },
    "meta_drift": {
        "en": "Meta reports more spend than the settled amount (more than $0.50)",
        "ar": "تُظهر ميتا صرفاً أكبر من المبلغ المسوّى (أكثر من 0.50 دولار)",
    },
    "results_parked": {
        "en": "Meta results reads of an ad account are paused for a few minutes",
        "ar": "توقفت قراءة نتائج ميتا لحساب إعلاني بضع دقائق",
    },
    "meta_overspend": {  # D27: the settle step's admin override above paid - Meta spend (P3-06d)
        "en": "Meta spent more than the customer paid on an ad; Albayan absorbs the difference",
        "ar": "أنفقت ميتا أكثر مما دفعه العميل على إعلان؛ يتحمل البيان الفرق",
    },
    "replies_parked": {  # P3-18b: comment replies kept for the retry pass while the connection is down
        "en": "Comment replies are parked until the Meta connection is back",
        "ar": "الردود على التعليقات محفوظة حتى يعود اتصال ميتا",
    },
    "page_health_drop": {  # P4-03 (social_studio page health): a reply or a check found a problem on a linked page
        "en": "A linked page needs attention: a reply or a check found a problem (see its reason)",
        "ar": "صفحة مربوطة تحتاج انتباهاً: وجد ردّ أو فحص مشكلة (انظر السبب)",
    },
    "instagram_comments_not_arriving": {  # P4-03: the Instagram heuristic (comments grew, no comment event)
        "en": "New Instagram comments are not reaching Albayan for a linked account (make sure it is public)",
        "ar": "التعليقات الجديدة على إنستغرام لا تصل إلى البيان لحساب مربوط (تأكد أنه عام)",
    },
    "jobs_heartbeat_late": {  # P3-21 (studio_alert_out.report_heartbeat): the operations worker's watch of this loop
        "en": "The studio jobs loop has not run for more than 5 minutes",
        "ar": "لم تعمل حلقة مهام الاستوديو منذ أكثر من 5 دقائق",
    },
}
# A request in one of these states has left its submission cycle (studio_wallet.cycle_state "being
# returned"); a Submitted request that was archived has left it too. Anything else is never swept.
LEFT_CYCLE_STATUSES = frozenset({"Draft", "Changes Requested", "Rejected"})
# What the loop needs from main.py (through a router ctx).
WALLET_CTX_KEYS = (
    "is_postgres", "sqlite_patch_lock", "sqlite_wallet_lock", "find_entity_by_idempotency", "lock_idempotency_key",
    "insert_entity_in_transaction", "iso_utc", "audit", "wallet_balance_minor",
)
_CURSOR_RE = re.compile(r"(\d{1,15}):([A-Za-z0-9][A-Za-z0-9._:-]{0,79})")

_THREAD: threading.Thread | None = None
_STOP = threading.Event()
_STOP_JOINED = False  # a stop already waited for the loop since the last start
_LOCK = threading.Lock()


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The loop's clock (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_or_none(value: Any) -> str | None:
    moment = parse_time(value)
    return _iso(moment) if moment else None


def _ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


def _zone() -> Any:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(SERVICE_TIMEZONE)
    except Exception:  # no time-zone database: Libya has kept UTC+2 all year since 2013
        return timezone(timedelta(hours=2))


def _minutes_since(moment: Any, now: datetime) -> float | None:
    parsed = parse_time(moment)
    return None if parsed is None else (now - parsed).total_seconds() / 60


def jobs_enabled() -> bool:
    """False under pytest and when ALBAYAN_STUDIO_JOBS is off; on otherwise (the default)."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    return str(os.environ.get(ENV_SWITCH) or "on").strip().lower() not in _OFF_VALUES


def results_sync_configured() -> bool:
    """True while a Meta token is set: the only condition for claiming the results job (the pass
    itself checks the full Meta configuration and Albayan's Meta pause)."""
    return bool(str(os.environ.get(META_TOKEN_ENV) or "").strip())


def _run_results_sync(now: datetime) -> dict[str, Any]:
    from .studio_results_sync import run_results_sync  # late: the sync imports this module

    return run_results_sync(now)


def _run_stop_check(now: datetime) -> dict[str, Any]:
    from .studio_stop import check_stop_requests  # late: studio_stop imports this module

    return check_stop_requests(now)


def resolve_jobs_ctx(router_ctx: dict[str, Any] | None) -> dict[str, Any]:
    """The wallet helpers from main.py: the Ads Studio routers' ctx, overlaid by the studio router's own."""
    merged: dict[str, Any] = {}
    try:
        merged.update(social_studio._ctx())
    except RuntimeError:
        pass  # the social studio router was not created: the studio router's ctx must carry everything
    merged.update(router_ctx or {})
    missing = [key for key in WALLET_CTX_KEYS if key not in merged]
    if missing:
        raise RuntimeError("Studio jobs need these helpers from main.py: " + ", ".join(missing))
    return merged


def left_cycle(status: Any, archived: bool) -> bool:
    status = str(status or "Draft")
    return status in LEFT_CYCLE_STATUSES or (status == "Submitted" and bool(archived))


# ------------------------------------------------------------------ working days (until P3-16)

def _day_hours(hours: dict[str, Any], day: date) -> dict[str, Any] | None:
    """The opening hours of one Tripoli day, or None when closed (studio_settings.service_open_at's rules)."""
    iso = day.isoformat()
    if any(item.get("date") == iso for item in hours.get("holidays") or []):
        return None
    today = (hours.get("week") or {}).get(WEEKDAYS[(day.weekday() + 1) % 7])  # weekday(): Monday = 0
    if not today:
        return None
    ramadan = hours.get("ramadan")
    if ramadan and ramadan["from"] <= iso <= ramadan["to"]:
        return ramadan
    return today


def review_due_at(submitted_at: Any, business_days: int, hours: dict[str, Any]) -> datetime | None:
    """Closing time (UTC) of the Nth working day after the Tripoli day the request was sent."""
    submitted = parse_time(submitted_at)
    if submitted is None:
        return None
    zone = _zone()
    day = submitted.astimezone(zone).date()
    wanted = max(int(business_days or 1), 1)
    counted = 0
    for _ in range(400):
        day += timedelta(days=1)
        opening = _day_hours(hours, day)
        if not opening:
            continue
        counted += 1
        if counted >= wanted:
            hour, minute = (int(part) for part in str(opening["close"]).split(":"))
            return datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone).astimezone(timezone.utc)
    return None


# ------------------------------------------------------------------ studioAlerts

def alert_id(kind: str, related_id: str, day: str) -> str:
    return derived_id("sal", kind, related_id or "-", day)


def raise_alert(
    conn: Any,
    kind: str,
    *,
    related_type: str,
    related_id: str,
    owner_id: str | None = None,
    count: int = 1,
    details: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> tuple[dict[str, Any], bool]:
    """Insert the day's alert for (kind, related id), or refresh it; returns (alert data, inserted).

    Safe to call from two processes at once: the fixed id and ``ON CONFLICT DO NOTHING`` let one
    insert win, and the other refreshes the row. Run it on the caller's transaction.
    """
    if kind not in ALERT_KINDS:
        raise ValueError(f"unknown studio alert kind {kind!r}")
    now = _aware(now or utc_now())
    day = libya_today(now).isoformat()
    row_id = alert_id(kind, related_id, day)
    at = _iso(now)
    stamp = now_ms()
    owner = created_by_or_none(conn, owner_id)  # a real, live user or None (a system alert)
    fields = {"lastAt": at, "count": max(int(count), 0), "details": details or {}}
    data = {
        "recordType": ALERTS_TYPE, "id": row_id, "kind": kind, "relatedType": related_type,
        "relatedId": related_id, "ownerId": owner, "day": day, "firstAt": at, **fields,
        "customerVisible": False, "acknowledgedAt": None, "acknowledgedBy": None, "channelSentAt": None,
        "_created": stamp, "_lastModified": stamp, "_deleted": False,
    }
    inserted = conn.execute(
        text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp) ON CONFLICT (type, id) DO NOTHING"
        ),
        {"type": ALERTS_TYPE, "id": row_id, "data": json_dumps(data), "stamp": stamp, "owner": owner},
    )
    if int(inserted.rowcount or 0) == 1:
        return data, True
    row = conn.execute(
        text("SELECT data_json, deleted, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1"),
        {"type": ALERTS_TYPE, "id": row_id},
    ).mappings().first()
    current = (json_loads(row["data_json"]) or {}) if row else {}
    if not row or bool(row["deleted"]):
        return current, False
    last = parse_time(current.get("lastAt"))
    same = int(current.get("count") or 0) == fields["count"] and current.get("details") == fields["details"]
    if same and last is not None and timedelta(0) <= now - last < ALERT_REFRESH:
        return current, False
    baseline = int(row["last_modified"])
    updated = {**current, **fields, "_lastModified": max(stamp, baseline + 1)}
    # Conditional: a writer that got there first keeps its (just as fresh) copy.
    conn.execute(
        text(
            "UPDATE entities SET data_json = :data, last_modified = :modified "
            "WHERE type = :type AND id = :id AND last_modified = :baseline"
        ),
        {"data": json_dumps(updated), "modified": updated["_lastModified"], "type": ALERTS_TYPE, "id": row_id,
         "baseline": baseline},
    )
    return updated, False


def _public_alert(row: Any) -> dict[str, Any]:
    data = json_loads(row["data_json"]) or {}
    kind = str(data.get("kind") or "")
    return {
        "id": str(row["id"]),
        "kind": kind,
        "labels": dict(ALERT_LABELS.get(kind) or {"en": kind, "ar": kind}),
        "relatedType": data.get("relatedType"),
        "relatedId": data.get("relatedId"),
        "ownerId": data.get("ownerId"),
        "day": data.get("day"),
        "firstAt": data.get("firstAt"),
        "lastAt": data.get("lastAt"),
        "count": data.get("count"),
        "customerVisible": bool(data.get("customerVisible")),
        "acknowledgedAt": data.get("acknowledgedAt"),
        "acknowledgedBy": data.get("acknowledgedBy"),
        "channelSentAt": data.get("channelSentAt"),
        "details": data.get("details") if isinstance(data.get("details"), dict) else {},
    }


def list_alerts_page(conn: Any, limit: int = ALERTS_PAGE_DEFAULT, before: tuple[int, str] | None = None) -> dict[str, Any]:
    """Newest first (created_at, then id); ``nextBefore`` is the cursor of the next page or None."""
    params: dict[str, Any] = {"type": ALERTS_TYPE, "limit": int(limit) + 1}
    after = ""
    if before is not None:
        after = " AND (created_at < :before_at OR (created_at = :before_at AND id < :before_id))"
        params.update({"before_at": int(before[0]), "before_id": str(before[1])})
    rows = conn.execute(
        text(
            f"SELECT id, data_json, created_at FROM entities WHERE type = :type AND deleted = false{after} "
            "ORDER BY created_at DESC, id DESC LIMIT :limit"
        ),
        params,
    ).mappings().all()
    page = rows[: int(limit)]
    more = len(rows) > int(limit)
    return {
        "alerts": [_public_alert(row) for row in page],
        "nextBefore": f"{int(page[-1]['created_at'])}:{page[-1]['id']}" if more and page else None,
    }


# ------------------------------------------------------------------ studioJobState

def _state_row(conn: Any) -> Any:
    return conn.execute(
        text("SELECT data_json, deleted, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1"),
        {"type": JOB_STATE_TYPE, "id": JOB_STATE_ID},
    ).mappings().first()


def _state_data(row: Any) -> dict[str, Any]:
    if not row or bool(row["deleted"]):
        return {}
    try:
        data = json_loads(row["data_json"]) or {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def read_job_state() -> dict[str, Any]:
    with db_conn() as conn:
        return _state_data(_state_row(conn))


def update_job_state(change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> dict[str, Any] | None:
    """Apply ``change(current state) -> fields to write`` (None or {} = nothing) and write the row back
    only if nobody wrote it since it was read; a lost race is retried on a fresh read. Returns the
    fields written, or None (nothing to write, or every attempt lost)."""
    for _ in range(STATE_WRITE_ATTEMPTS):
        with db_conn() as conn:
            row = _state_row(conn)
            current = _state_data(row)
            fields = change(dict(current))
            if not fields:
                return None
            stamp = now_ms()
            data = {**current, **fields, "recordType": JOB_STATE_TYPE, "id": JOB_STATE_ID, "_deleted": False}
            if row is None:
                data["_created"] = data["_lastModified"] = stamp
                result = conn.execute(
                    text(
                        "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                        "VALUES (:type, :id, :data, false, :stamp, NULL, :stamp) ON CONFLICT (type, id) DO NOTHING"
                    ),
                    {"type": JOB_STATE_TYPE, "id": JOB_STATE_ID, "data": json_dumps(data), "stamp": stamp},
                )
            else:
                baseline = int(row["last_modified"])
                data["_lastModified"] = max(stamp, baseline + 1)
                result = conn.execute(
                    text(
                        "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                        "WHERE type = :type AND id = :id AND last_modified = :baseline"
                    ),
                    {"data": json_dumps(data), "modified": data["_lastModified"], "type": JOB_STATE_TYPE,
                     "id": JOB_STATE_ID, "baseline": baseline},
                )
            if int(result.rowcount or 0) == 1:
                return fields
    return None


def jobs_heartbeat(now: datetime | None = None) -> dict[str, Any]:
    """The loop's health for admins (diagnostics, the alerts list): times and counts only."""
    now = _aware(now or utc_now())
    state = read_job_state()
    last = parse_time(state.get("lastTickAt"))
    age = None if last is None else max(int((now - last).total_seconds()), 0)
    result = state.get("lastIntegrityResult") if isinstance(state.get("lastIntegrityResult"), dict) else None
    error = state.get("lastError") if isinstance(state.get("lastError"), dict) else None
    thread = _THREAD
    return {
        "enabled": jobs_enabled(),
        "runningHere": bool(thread and thread.is_alive()),
        "lastTickAt": _iso(last) if last else None,
        "ageSeconds": age,
        "late": age is None or age > HEARTBEAT_LATE_SECONDS,
        "lateAfterSeconds": HEARTBEAT_LATE_SECONDS,
        "lastSweepAt": _iso_or_none(state.get("lastSweepAt")),
        "lastWaitingCheckAt": _iso_or_none(state.get("lastWaitingCheckAt")),
        "lastIntegrityScanAt": _iso_or_none(state.get("lastIntegrityScanAt")),
        "lastResultsSyncAt": _iso_or_none(state.get("lastResultsSyncAt")),
        "lastIgPollAt": _iso_or_none(state.get("lastIgPollAt")),  # P4-09 (studio_ig_source.py)
        "lastIntegrityResult": None if result is None else {
            "total": int(result.get("total") or 0),
            "byCode": {
                str(code): int(count) for code, count in (result.get("byCode") or {}).items()
                if str(code) in studio_integrity.VIOLATION_LABELS
            },
        },
        "lastError": None if error is None else {
            "job": str(error.get("job") or "")[:20],
            "error": re.sub(r"[^A-Za-z0-9_.]", "", str(error.get("error") or ""))[:60],
            "at": _iso_or_none(error.get("at")),
        },
    }


# ------------------------------------------------------------------ the money jobs

def release_left_cycle_capture(ctx: dict[str, Any], campaign_id: str) -> str:
    """Return the capture of a cycle its request has left; '' when there is nothing to return.

    Locks (PLAN.md §7.8 lock table, "Orphan sweep"): the campaign row, then the ``rel:`` key. On
    SQLite the process locks go entity-patch lock -> wallet lock, like stop and archive.
    """
    postgres = bool(ctx["is_postgres"]())
    patch_guard = nullcontext() if postgres else ctx["sqlite_patch_lock"]()
    wallet_guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
    with patch_guard, wallet_guard:
        with db_conn() as conn:
            suffix = " FOR UPDATE" if postgres else ""
            row = conn.execute(
                text(f"SELECT data_json, deleted FROM entities WHERE type = :type AND id = :id LIMIT 1{suffix}"),
                {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
            ).mappings().first()
            if not row:
                return ""
            data = json_loads(row["data_json"]) or {}
            status = str(data.get("status") or "Draft")
            if not str(data.get("submittedAt") or "").strip() or not left_cycle(status, bool(row["deleted"])):
                return ""  # it moved on (or back) since the read: nothing to return
            campaign = {**data, "id": campaign_id}
            ctx["lock_idempotency_key"](conn, f"rel:{_campaign_payment_key(campaign)}", postgres=postgres)
            if campaign_capture_open_minor(conn, ctx, campaign) <= 0:
                return ""  # never captured, or already returned through one of the doors
            released = release_orphan_campaign_payment(conn, ctx, campaign, None)
            if released:
                ctx["audit"](
                    None, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id,
                    f"Studio jobs returned an orphan capture for {campaign_id}",
                    {"transactionId": released, "source": "studio_jobs_sweep", "status": status},
                    conn=conn,
                )
            return released


def sweep_orphans(ctx: dict[str, Any], now: datetime | None = None, *, full: bool = False) -> dict[str, Any]:
    """Return every capture whose request left its cycle (see the module docstring). Idempotent."""
    now = _aware(now or utc_now())
    if full:
        where, params = "type = :type", {"type": AD_CAMPAIGN_COLLECTION}
    else:
        where = "type = :type AND last_modified >= :since"
        params = {"type": AD_CAMPAIGN_COLLECTION, "since": _ms(now - SWEEP_LOOKBACK)}
    found: list[str] = []
    examined = 0
    with db_conn() as conn:
        rows = conn.execute(
            text(json_fields_select_sql(("status", "submittedAt"), ("id", "deleted", "created_by"), where)), params,
        ).mappings().all()
        by_owner: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for row in rows:
            owner = str(row.get("created_by") or "")
            cycle = str(row.get("f_submittedat") or "").strip()
            if owner and cycle and left_cycle(row.get("f_status"), bool(row.get("deleted"))):
                campaign_id = str(row["id"])
                by_owner[owner].append((_campaign_payment_key({"id": campaign_id, "submittedAt": cycle}), campaign_id))
        for owner, items in sorted(by_owner.items()):
            examined += len(items)
            captures = studio_integrity.open_captures(wallet_ledger_rows(conn, owner), owner)
            found.extend(campaign_id for key, campaign_id in items if key in captures)
    released = [campaign_id for campaign_id in found if release_left_cycle_capture(ctx, campaign_id)]
    return {"full": full, "examined": examined, "released": released}


def waiting_requests_sql() -> str:
    """The live Submitted requests (id, owner, status, submittedAt), filtered by the database: only the
    waiting rows are parsed, never every request with its images. Type and status are literals, so
    PostgreSQL can use the partial expression index idx_ad_campaign_requests_status (add_jsonb_indexes.py:
    ``(data_json::jsonb->>'status') WHERE type = 'adCampaignRequests' AND deleted = false``)."""
    where = f"type = '{AD_CAMPAIGN_COLLECTION}' AND deleted = false AND {json_field_sql('status')} = 'Submitted'"
    return json_fields_select_sql(("status", "submittedAt"), ("id", "created_by"), where)


def check_waiting_requests(now: datetime | None = None, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """Alerts for the live Submitted requests: an interrupted approval (a capture older than 15 minutes,
    never returned here) and a review past its target."""
    now = _aware(now or utc_now())
    settings = settings or read_all_settings()
    business_days = int(settings["targets"]["reviewBusinessDays"])
    hours = settings["hours"]
    interrupted: list[dict[str, Any]] = []
    overdue: list[dict[str, Any]] = []
    waiting = 0
    with db_conn() as conn:
        rows = conn.execute(text(waiting_requests_sql())).mappings().all()
        by_owner: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for row in rows:
            if str(row.get("f_status") or "") == "Submitted" and row.get("created_by"):
                by_owner[str(row["created_by"])].append((str(row["id"]), str(row.get("f_submittedat") or "").strip()))
        for owner, items in sorted(by_owner.items()):
            waiting += len(items)
            captures = studio_integrity.open_captures(wallet_ledger_rows(conn, owner), owner)
            for campaign_id, cycle in items:
                pay = captures.get(_campaign_payment_key({"id": campaign_id, "submittedAt": cycle}))
                age = _minutes_since(pay["createdAt"], now) if pay else None
                if pay and (age is None or age > INTERRUPTED_AFTER_MINUTES):
                    interrupted.append({"campaignId": campaign_id, "ownerId": owner, "capturedAt": pay["createdAt"] or None,
                                        "paidMinorUSD": int(pay["amountMinor"])})
                due = review_due_at(cycle, business_days, hours)
                if due is not None and now > due:
                    overdue.append({"campaignId": campaign_id, "ownerId": owner, "submittedAt": cycle, "dueAt": _iso(due)})
    for kind, items in (("approval_interrupted", interrupted), ("review_overdue", overdue)):
        for item in items:
            with db_conn() as conn:
                raise_alert(conn, kind, related_type=AD_CAMPAIGN_COLLECTION, related_id=item["campaignId"],
                            owner_id=item["ownerId"], details={k: v for k, v in item.items() if k != "ownerId"}, now=now)
    return {
        "waiting": waiting,
        "approvalInterrupted": [item["campaignId"] for item in interrupted],
        "reviewOverdue": [item["campaignId"] for item in overdue],
    }


def run_daily_money_check(
    ctx: dict[str, Any] | Callable[[], dict[str, Any]],
    now: datetime | None = None,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The full sweep, then scan_studio_money() on one snapshot; a finding -> one integrity_violation alert.
    The scan checks the wallet screen against main's own SQL balance, ``ctx["wallet_balance_minor"]``."""
    now = _aware(now or utc_now())
    settings = settings or read_all_settings()
    jobs_ctx: dict[str, Any] = {}
    try:
        jobs_ctx = ctx() if callable(ctx) else ctx
        swept: dict[str, Any] = sweep_orphans(jobs_ctx, now, full=True)
    except Exception as error:  # the scan still runs: a failed sweep shows up as stranded money
        print(f"[albayan] Studio full orphan sweep failed ({type(error).__name__}).")
        swept = {"full": True, "error": type(error).__name__}
    try:
        with db_conn() as conn:
            if conn.dialect.name == "postgresql":
                # Every read of the scan describes one instant (a commit between two reads is no finding).
                conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
            violations = studio_integrity.scan_studio_money(
                conn, now, stranded_minutes=settings["thresholds"]["strandedCaptureMaxMinutes"],
                balance_minor=(jobs_ctx or {}).get("wallet_balance_minor"),
            )
    except Exception as error:
        print(f"[albayan] Studio money scan failed ({type(error).__name__}).")
        violations = [studio_integrity.failed_check("scan_studio_money", error)]
    counts = studio_integrity.violation_counts(violations)
    alert_id_raised = None
    if violations:
        with db_conn() as conn:
            alert, _inserted = raise_alert(
                conn, "integrity_violation", related_type=JOB_STATE_TYPE, related_id="scan_studio_money",
                count=counts["total"], details={"violations": violations}, now=now,
            )
        alert_id_raised = alert.get("id")
    update_job_state(lambda state: {"lastIntegrityScanAt": _iso(now), "lastIntegrityResult": counts})
    return {"swept": swept, "violations": violations, "counts": counts, "alertId": alert_id_raised}


# ------------------------------------------------------------------ the tick and the loop

def _due(last: Any, every: timedelta, now: datetime) -> bool:
    moment = parse_time(last)
    return moment is None or moment > now + CLOCK_SKEW or now - moment >= every


def _guarded(job: str, now: datetime, action: Callable[[], Any]) -> Any:
    try:
        return action()
    except Exception as error:
        print(f"[albayan] Studio job '{job}' failed ({type(error).__name__}); it runs again at its next turn.")
        try:
            update_job_state(lambda state: {"lastError": {"job": job, "error": type(error).__name__, "at": _iso(now)}})
        except Exception:
            pass
        return {"error": type(error).__name__}


def run_tick(ctx_provider: Callable[[], dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """One tick: the heartbeat plus the claims of the due jobs in one conditional write, then those jobs."""
    now = _aware(now or utc_now())
    claimed: list[str] = []
    poll_on = ig_poll_configured()  # P4-09: a Meta token and capabilities.igPublicReply = poll (one settings read)

    def heartbeat(state: dict[str, Any]) -> dict[str, Any]:
        claimed.clear()
        at = _iso(now)
        fields: dict[str, Any] = {"lastTickAt": at}
        local = now.astimezone(_zone())
        today = local.date().isoformat()
        if local.strftime("%H:%M") >= DAILY_SCAN_AT and state.get("lastIntegrityScanDay") != today:
            fields.update({"lastIntegrityScanDay": today, "lastSweepAt": at})  # the daily run sweeps everything
            claimed.append("daily")
        elif _due(state.get("lastSweepAt"), SWEEP_EVERY, now):
            fields["lastSweepAt"] = at
            claimed.append("sweep")
        if meta_watch_configured() and _due(state.get("lastMetaWatchAt"), META_WATCH_EVERY, now):
            fields["lastMetaWatchAt"] = at
            claimed.append("meta_watch")
        if _due(state.get("lastWaitingCheckAt"), WAITING_EVERY, now):
            fields["lastWaitingCheckAt"] = at
            claimed.append("waiting")
        if results_sync_configured() and _due(state.get("lastResultsSyncAt"), RESULTS_EVERY, now):
            fields["lastResultsSyncAt"] = at
            claimed.append("results")
        if poll_on and _due(state.get("lastIgPollAt"), IG_POLL_EVERY, now):
            fields["lastIgPollAt"] = at
            claimed.append("ig_poll")
        return fields

    if update_job_state(heartbeat) is None:
        return {"claimed": []}  # lost every write race: another process is ticking right now
    jobs: dict[str, Callable[[], Any]] = {
        "daily": lambda: run_daily_money_check(ctx_provider, now),
        "sweep": lambda: sweep_orphans(ctx_provider(), now),
        "meta_watch": lambda: run_meta_watch(now),  # P3-18a/c (studio_alerts_meta.py)
        "waiting": lambda: check_waiting_requests(now),
        "results": lambda: _run_results_sync(now),
        "ig_poll": lambda: run_ig_poll(now),  # P4-09: the Instagram polling source (studio_ig_source.py)
    }
    ran: dict[str, Any] = {"claimed": list(claimed)}
    for job in claimed:
        ran[job] = _guarded(job, now, jobs[job])
    if "waiting" in claimed:  # P3-10: the stop requests ride the same 5-minute turn (studio_stop.py)
        ran["stop_requests"] = _guarded("stop_requests", now, lambda: _run_stop_check(now))
    ran["channel"] = _guarded("channel", now, lambda: _send_pending_notifications(now))  # P3-21 (studio_alert_out.py)
    return ran


def _send_pending_notifications(now: datetime) -> dict[str, Any]:
    from .studio_alert_out import send_pending  # late: studio_alert_out imports this module

    return send_pending(now)


def _loop(stop: threading.Event, ctx_provider: Callable[[], dict[str, Any]]) -> None:
    if stop.wait(FIRST_TICK_DELAY_SECONDS):
        return
    while not stop.is_set():
        try:
            run_tick(ctx_provider)
        except Exception as error:  # e.g. the database is away: the next tick tries again
            print(f"[albayan] Studio jobs tick failed ({type(error).__name__}); it will retry.")
        stop.wait(TICK_SECONDS)


def start_studio_jobs(ctx_provider: Callable[[], dict[str, Any]]) -> bool:
    """Start the one loop of this process (a second call while it runs does nothing). True if started."""
    global _THREAD, _STOP, _STOP_JOINED
    if not jobs_enabled():
        return False
    with _LOCK:
        if _THREAD and _THREAD.is_alive():
            return False
        _STOP = threading.Event()
        _STOP_JOINED = False
        _THREAD = threading.Thread(target=_loop, args=(_STOP, ctx_provider), name="albayan-studio-jobs", daemon=True)
        _THREAD.start()
    print("[albayan] Studio jobs loop started (orphan sweep, alerts, daily money check; Meta results sync when configured; "
          "Instagram poll when switched on).")
    return True


def stop_studio_jobs(timeout: float = 2.0) -> None:
    """Set the stop flag; only the first call since the last start waits (``timeout``) for the loop.

    FastAPI copies a nested router's shutdown hook into every router above it and also runs each
    router's own lifespan, so one shutdown of the app calls this three times, on the event loop:
    the later calls only set the flag again instead of each waiting up to ``timeout`` more."""
    global _THREAD, _STOP_JOINED
    with _LOCK:
        thread = _THREAD
        _STOP.set()
        if _STOP_JOINED:
            return
        _STOP_JOINED = True
    if thread and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=timeout)
    with _LOCK:
        if _THREAD is thread and not (thread and thread.is_alive()):
            _THREAD = None  # a thread still finishing its tick stays known, so a restart cannot overlap it


# ------------------------------------------------------------------ the router

def _parse_limit(raw: Any) -> int:
    if raw is None or raw == "":
        return ALERTS_PAGE_DEFAULT
    value = str(raw).strip()
    # isascii first: "²" or "١٠" pass isdigit() but int() refuses the first one (a 500, not a 400).
    if not (value.isascii() and value.isdigit()) or not 1 <= int(value) <= ALERTS_PAGE_MAX:
        studio_error(400, "INVALID_VALUE", f"limit must be a whole number from 1 to {ALERTS_PAGE_MAX}")
    return int(value)


def _parse_cursor(raw: Any) -> tuple[int, str] | None:
    if raw is None or raw == "":
        return None
    match = _CURSOR_RE.fullmatch(str(raw).strip())
    if not match:
        studio_error(400, "INVALID_VALUE", "before must be the nextBefore value of the previous page")
    return int(match.group(1)), match.group(2)


def create_studio_jobs_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """``GET /admin/alerts`` under /api/studio, and the startup/shutdown events of the jobs loop."""
    router = APIRouter()

    @router.on_event("startup")
    def _start_studio_jobs() -> None:
        start_studio_jobs(lambda: resolve_jobs_ctx(ctx))

    @router.on_event("shutdown")
    def _stop_studio_jobs() -> None:
        stop_studio_jobs()

    @router.get("/admin/alerts")
    def list_studio_alerts(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        if str(user.get("role") or "").lower() != "admin":
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:alerts:{user.get('id')}", ALERT_READS_PER_MINUTE, 60_000)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )
        limit = _parse_limit(request.query_params.get("limit"))
        before = _parse_cursor(request.query_params.get("before"))
        with db_conn() as conn:
            page = list_alerts_page(conn, limit, before)
        page["jobs"] = jobs_heartbeat()
        return page

    return router
