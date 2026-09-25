"""Albayan Studio staff alert channel (plan task P3-21; PLAN.md §7.4 "Staff alert channel", §7.5,
§7.6, §12.6 "Studio jobs heartbeat late", §12.7 "Alert channel silent").

Urgent, staff-only events reach the private business alert channel through the platform's
operations sender (operations._send_alert: one POST of a JSON payload to the URL in
``ALBAYAN_ALERT_WEBHOOK_URL``, a 10-second timeout, at most one alert per payload ``kind`` every
``ALBAYAN_ALERT_COOLDOWN_SECONDS``, 30 minutes by default). While the variable is not set nothing
is sent and nothing is stamped as sent: the on-duty rule, the after-hours urgent line for customers
and the overdue alarm in the desk are the fallback (D29, §7.6). A payload holds a kind, two titles
(English and Arabic), a short body and references (a ``T-`` ticket number, an ``ALB-S-`` studio
code, counts and times) only: never a name, an e-mail, a phone number, a customer's note or a
message text (§7.5). Its ``text`` field (the one line a chat webhook shows, P0-01(u)) is
"<title en> | <title ar>" plus the body.

* ``notify_staff(kind, title_en, title_ar, body, dedupe_key)``: the one door. The payload kind is
  ``<kind>:<dedupe key>`` (the §7.4 rule ``studio_stop:<ticket number>``), so the sender's per-kind
  cooldown never hides the second stop request of the day, while the same key is sent once per
  process within ``DEDUPE_HOURS``. The POST runs on its own thread: a request never waits for the
  webhook. ``wait=`` lets a caller that is itself on a background thread wait (bounded) for the
  webhook's answer; it returns True only when the endpoint accepted the alert.
* ``send_pending(now)``: the pass the background threads run: the operations worker calls it every
  300 s through ``operations_watch`` (the studio jobs loop may call it too: it is idempotent). One
  notification per open stop request, deduplicated on the ``studioStopRequests`` row: it is stamped
  ``channelSentAt`` once the webhook accepted the alert, so a later pass, another process or a
  restart never sends it twice, and one per channel-worthy studio alert of the last day
  (``studioAlerts.channelSentAt``, the same way): stop_request_overdue, meta_connection_down,
  meta_token_expiring, integrity_violation, studio_funds_low, studio_account_inactive and
  studio_funds_unreadable (§7.4). At most ``SENDS_PER_PASS`` sends per pass; a send the webhook
  refused is tried again on a later pass (after the sender's cooldown).
* ``report_heartbeat(beat)``: the operations worker's watch of the studio jobs loop, which cannot
  report its own death (§7.4). ``beat`` is studio_jobs.jobs_heartbeat(): while the loop is switched
  on and late (no tick for 5 minutes) one notification goes out per stale episode (keyed by the last
  tick time; a loop that never ticked is reported once that lasted 5 minutes; a reminder every
  ``HEARTBEAT_REMIND_HOURS``), and a ``jobs_heartbeat_late`` studio alert is raised for the admin
  list (best effort: the database may be the very problem).
* ``POST /api/studio/admin/alert-channel/test`` (admin, from the Albayan site itself, one press per
  10 minutes for the whole channel, audited ``alert_channel_test``): sends one test notification
  and waits up to ``TEST_WAIT_SECONDS`` for the webhook's answer (the one place a request waits:
  that is what the button is for). Answers ``{sent, configured}``; a second press within the 10
  minutes is 429 RATE_LIMITED.
"""

import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from ... import operations
from ...db import db_conn, json_dumps, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_diagnostics import parse_time
from .studio_errors import studio_error
from .studio_jobs import ALERT_LABELS, ALERTS_TYPE, JOB_STATE_TYPE, raise_alert
from .studio_types import STUDIO_STOP_REQUESTS_TYPE

WEBHOOK_ENV = "ALBAYAN_ALERT_WEBHOOK_URL"  # the variable operations.py posts to; nothing else configures the channel
STOP_TYPE = STUDIO_STOP_REQUESTS_TYPE
# PLAN.md §7.4: the studio alerts that go to the channel (a new stop request and a late heartbeat
# are sent by their own paths below).
CHANNEL_ALERT_KINDS = frozenset({
    "stop_request_overdue", "meta_connection_down", "meta_token_expiring", "integrity_violation",
    "studio_funds_low", "studio_account_inactive", "studio_funds_unreadable",
})
HEARTBEAT_ALERT = "jobs_heartbeat_late"
SENDS_PER_PASS = 5
SEND_WAIT_SECONDS = 15.0  # above the sender's own 10-second timeout: the answer is known when the wait ends
TEST_WAIT_SECONDS = 15.0
DEDUPE_HOURS = 24
HEARTBEAT_REMIND_HOURS = 6
HEARTBEAT_NEVER_GRACE_SECONDS = 300  # a loop that never ticked is reported once that lasted 5 minutes
STOP_WINDOW = timedelta(days=7)  # a stop request older than this is never sent late (it was handled by hand)
ALERT_WINDOW = timedelta(hours=24)
BODY_MAX_CHARS = 300
KEY_MAX_CHARS = 80
TEST_RATE_KEY = "studio:alert-channel-test"
TEST_EVERY_MS = 10 * 60 * 1000
AUDIT_ALERT_TEST = "alert_channel_test"
STAMP_ATTEMPTS = 3
_KIND_RE = re.compile(r"[a-z][a-z0-9_]{1,40}")

_LOCK = threading.Lock()
_SENT: dict[str, float] = {}  # payload kind -> monotonic time of its send (the in-process dedupe)
_HEARTBEAT: dict[str, Any] = {"key": None, "at": 0.0, "neverSince": None}


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The channel's clock (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return _aware(moment).astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _line(value: Any, limit: int) -> str:
    """One line of text: control characters and runs of white space become one space."""
    return " ".join(str(value if value is not None else "").split())[:limit]


def channel_configured() -> bool:
    return bool(str(os.environ.get(WEBHOOK_ENV) or "").strip())


def reset_channel_state() -> None:
    """Forget the in-process dedupe (tests)."""
    with _LOCK:
        _SENT.clear()
        _HEARTBEAT.update({"key": None, "at": 0.0, "neverSince": None})


def _prune(clock: float) -> None:
    stale = [kind for kind, at in _SENT.items() if clock - at > DEDUPE_HOURS * 3600]
    for kind in stale:
        _SENT.pop(kind, None)


# ------------------------------------------------------------------ the one door

def notify_staff(
    kind: str,
    title_en: str,
    title_ar: str,
    body: str = "",
    dedupe_key: str = "",
    *,
    severity: str = "high",
    wait: float | None = None,
) -> bool:
    """Send one staff notification through operations._send_alert (see the module docstring).

    Returns False at once when the channel is not configured or this process already sent this
    kind and key within ``DEDUPE_HOURS``; otherwise True once the send is queued, or, with ``wait``
    (seconds), True only when the webhook accepted it within that time. The texts are cut to one
    line each; the caller passes references, never personal data.
    """
    if not _KIND_RE.fullmatch(str(kind or "")):
        raise ValueError(f"bad staff alert kind {kind!r}")
    key = _line(dedupe_key, KEY_MAX_CHARS)
    payload_kind = f"{kind}:{key}" if key else kind
    if not channel_configured():
        return False
    clock = time.monotonic()
    with _LOCK:
        _prune(clock)
        if payload_kind in _SENT:
            return False
        _SENT[payload_kind] = clock
    title_en, title_ar, body = _line(title_en, 200), _line(title_ar, 200), _line(body, BODY_MAX_CHARS)
    line = f"{title_en} | {title_ar}" + (f"\n{body}" if body else "")
    details = {"titleEn": title_en, "titleAr": title_ar, "body": body, "dedupeKey": key, "system": "ads_studio"}
    box: dict[str, Any] = {"sent": None}

    def deliver() -> None:
        try:
            box["sent"] = bool(operations._send_alert(payload_kind, severity, title_en, details, line=line))
        except Exception as error:  # the sender never raises, but a queued send must never kill its thread
            print(f"[albayan] Studio staff alert failed ({type(error).__name__}).")
            box["sent"] = False
        if box["sent"] is False:
            with _LOCK:
                _SENT.pop(payload_kind, None)  # a refused send may be tried again (after the sender's cooldown)

    thread = threading.Thread(target=deliver, name="albayan-studio-alert", daemon=True)
    thread.start()
    if wait is None:
        return True
    thread.join(max(float(wait), 0.0))
    return box["sent"] is True


# ------------------------------------------------------------------ pending notifications

def _studio_ref(conn: Any, campaign_id: str) -> str:
    if not campaign_id:
        return ""
    row = conn.execute(
        text(json_fields_select_sql(("studioRef",), ("id",), "type = :type AND id = :id")),
        {"type": AD_CAMPAIGN_COLLECTION, "id": str(campaign_id)},
    ).mappings().first()
    return _line((row or {}).get("f_studioref"), 20)


def _stamp_sent(row_type: str, row_id: str, at: str) -> bool:
    """Write ``channelSentAt`` on one row, conditional on its version; a row rewritten meanwhile is
    re-read and stamped again (a stop row that was resolved, an alert that was refreshed)."""
    for _ in range(STAMP_ATTEMPTS):
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json, last_modified FROM entities WHERE type = :type AND id = :id AND deleted = false LIMIT 1"),
                {"type": row_type, "id": row_id},
            ).mappings().first()
            if not row:
                return False
            data = json_loads(row["data_json"]) or {}
            if not isinstance(data, dict):
                return False
            baseline = int(row["last_modified"])
            modified = max(now_ms(), baseline + 1)
            data.update({"channelSentAt": at, "_lastModified": modified})
            result = conn.execute(
                text("UPDATE entities SET data_json = :data, last_modified = :modified "
                     "WHERE type = :type AND id = :id AND last_modified = :baseline"),
                {"data": json_dumps(data), "modified": modified, "type": row_type, "id": row_id, "baseline": baseline},
            )
            if int(result.rowcount or 0) == 1:
                return True
    return False


def _unsent_rows(conn: Any, row_type: str, since: datetime, column: str) -> list[tuple[str, dict[str, Any]]]:
    rows = conn.execute(
        text(f"SELECT id, data_json FROM entities WHERE type = :type AND deleted = false AND {column} >= :since"),
        {"type": row_type, "since": int(since.timestamp() * 1000)},
    ).mappings().all()
    out = []
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        if isinstance(data, dict) and not str(data.get("channelSentAt") or "").strip():
            out.append((str(row["id"]), data))
    return out


def stop_request_notification(data: dict[str, Any], studio_ref: str) -> dict[str, str]:
    """The texts of one stop request's notification (references only)."""
    number = _line(data.get("ticketNumber"), 20)
    due = parse_time(data.get("dueAt"))
    parts = [f"Ticket {number}" if number else "Ticket", studio_ref, f"due {_iso(due)}" if due else "",
             "after hours" if data.get("afterHours") is True else ""]
    return {
        "kind": "studio_stop",
        "titleEn": "New stop request: pause the ad in Meta",
        "titleAr": "طلب إيقاف جديد: أوقف الإعلان في ميتا",
        "body": " · ".join(part for part in parts if part),
        "dedupeKey": number or _line(data.get("id"), KEY_MAX_CHARS),
    }


def send_pending(now: datetime | None = None) -> dict[str, Any]:
    """One notification per open, unsent stop request and per unsent channel-worthy alert (see the
    module docstring). Safe to run from any thread, any number of times."""
    now = _aware(now or utc_now())
    out: dict[str, Any] = {"configured": channel_configured(), "stopRequests": [], "alerts": [], "skipped": 0}
    if not out["configured"]:
        return out
    with db_conn() as conn:
        stops = [
            (row_id, data) for row_id, data in _unsent_rows(conn, STOP_TYPE, now - STOP_WINDOW, "created_at")
            if str(data.get("state") or "open") != "resolved"
        ]
        alerts = [
            (row_id, data) for row_id, data in _unsent_rows(conn, ALERTS_TYPE, now - ALERT_WINDOW, "last_modified")
            if str(data.get("kind") or "") in CHANNEL_ALERT_KINDS and not str(data.get("acknowledgedAt") or "").strip()
        ]
    budget = SENDS_PER_PASS
    at = _iso(now)
    for row_id, data in stops:
        if budget <= 0:
            out["skipped"] += 1
            continue
        budget -= 1
        with db_conn() as conn:
            ref = _studio_ref(conn, str(data.get("campaignId") or ""))
        note = stop_request_notification(data, ref)
        if notify_staff(note["kind"], note["titleEn"], note["titleAr"], note["body"], note["dedupeKey"], wait=SEND_WAIT_SECONDS):
            _stamp_sent(STOP_TYPE, row_id, at)
            out["stopRequests"].append(note["dedupeKey"])
    for row_id, data in alerts:
        if budget <= 0:
            out["skipped"] += 1
            continue
        budget -= 1
        kind = str(data.get("kind") or "")
        labels = ALERT_LABELS.get(kind) or {"en": kind, "ar": kind}
        ref = ""
        if str(data.get("relatedType") or "") == AD_CAMPAIGN_COLLECTION:
            with db_conn() as conn:
                ref = _studio_ref(conn, str(data.get("relatedId") or ""))
        else:
            ref = _line(data.get("relatedId"), 40)
        parts = [f"count {int(data.get('count') or 0)}", ref, f"day {_line(data.get('day'), 10)}"]
        sent = notify_staff(kind, labels["en"], labels["ar"], " · ".join(part for part in parts if part), row_id,
                            wait=SEND_WAIT_SECONDS)
        if sent:
            _stamp_sent(ALERTS_TYPE, row_id, at)
            out["alerts"].append(row_id)
    return out


# ------------------------------------------------------------------ the heartbeat watch

def report_heartbeat(beat: Any, now: datetime | None = None) -> bool:
    """The operations worker's watch of the studio jobs loop (see the module docstring). True when a
    notification went out for this stale episode."""
    if not isinstance(beat, dict) or not beat.get("enabled"):
        return False
    clock = time.monotonic()
    if not beat.get("late"):
        with _LOCK:
            _HEARTBEAT.update({"key": None, "at": 0.0, "neverSince": None})
        return False
    last = str(beat.get("lastTickAt") or "").strip()
    key = last or "never"
    with _LOCK:
        if not last:
            since = _HEARTBEAT.get("neverSince")
            if since is None:
                _HEARTBEAT["neverSince"] = clock
                return False
            if clock - float(since) < HEARTBEAT_NEVER_GRACE_SECONDS:
                return False
        if _HEARTBEAT["key"] == key and clock - float(_HEARTBEAT["at"]) < HEARTBEAT_REMIND_HOURS * 3600:
            return False
        _HEARTBEAT.update({"key": key, "at": clock})
    now = _aware(now or utc_now())
    age = beat.get("ageSeconds")
    body = f"last tick {key}" + (f" · {int(age)} s ago" if isinstance(age, int) else "") + " · restart the container"
    try:
        with db_conn() as conn:
            raise_alert(conn, HEARTBEAT_ALERT, related_type=JOB_STATE_TYPE, related_id=f"studio-jobs:{key}",
                        details={"lastTickAt": last or None, "ageSeconds": age if isinstance(age, int) else None}, now=now)
    except Exception as error:  # the database may be the very problem: the channel still hears about it
        print(f"[albayan] Studio heartbeat alert row not written ({type(error).__name__}).")
    bucket = int(clock // (HEARTBEAT_REMIND_HOURS * 3600))
    return notify_staff(
        HEARTBEAT_ALERT, "Albayan Studio jobs loop is late", "حلقة مهام استوديو البيان متأخرة", body,
        f"{key}:{bucket}", severity="critical",
    )


def operations_watch(beat: Any, now: datetime | None = None) -> dict[str, Any]:
    """What the operations worker runs every 300 s: the heartbeat watch, then the pending
    notifications; each part guarded on its own."""
    out: dict[str, Any] = {"heartbeat": False, "pending": None}
    try:
        out["heartbeat"] = report_heartbeat(beat, now)
    except Exception as error:
        print(f"[albayan] Studio heartbeat watch failed ({type(error).__name__}).")
    try:
        out["pending"] = send_pending(now)
    except Exception as error:
        print(f"[albayan] Studio pending notifications failed ({type(error).__name__}).")
    return out


# ------------------------------------------------------------------ the admin test button

def create_studio_alert_out_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """``POST /admin/alert-channel/test`` under /api/studio (``ctx``: audit)."""
    router = APIRouter()

    @router.post("/admin/alert-channel/test")
    def test_alert_channel(request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")
        if str(user.get("role") or "").lower() != "admin":
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")
        allowed, _left, retry_after_ms = check_rate_limit(TEST_RATE_KEY, 1, TEST_EVERY_MS)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "One test alert every 10 minutes. Please wait and try again.",
                headers={"Retry-After": str(max(1, -(-int(retry_after_ms or 0) // 1000)))},
            )
        now = utc_now()
        configured = channel_configured()
        sent = False
        if configured:
            sent = notify_staff(
                "studio_alert_test", "Albayan Studio test alert: the channel works",
                "تنبيه تجريبي من استوديو البيان: القناة تعمل", f"pressed at {_iso(now)}",
                _iso(now), severity="low", wait=TEST_WAIT_SECONDS,
            )
        ctx["audit"](
            str(user.get("id") or ""), AUDIT_ALERT_TEST, ALERTS_TYPE, "alert-channel",
            "Sent a test alert to the staff channel" if sent else "Pressed the staff channel test",
            {"configured": configured, "sent": sent},
        )
        return {"sent": sent, "configured": configured}

    return router
