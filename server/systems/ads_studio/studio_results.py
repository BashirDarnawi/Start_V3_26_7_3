"""Albayan Studio stage model and Meta results rows (plan task P1-20; PLAN.md §5.4, §7.1, §7.3).

One shared answer to "where is my ad, what does it mean for my money, and whose turn is it?",
built before any screen:

* ``adCampaignResults`` (``RESULTS_TYPE``): Meta's view of one studio request that staff linked to
  a Meta campaign. Id ``acr_`` + sha256(campaign id)[:40] (studio_types.derived_id), so a sync
  always finds the row it wrote; ``created_by`` = the request owner, or NULL when that is not a
  real user (the users.id foreign key rule). Router-only: the generic /api/collections API refuses
  the type. The Meta sync fills it from P3 (P3-03); until then only tests and the e2e seed write
  rows (``write_results_row``). Every read goes through ``normalize_results()``: a stored field
  that fails today's rules reads as its safe default, so a hand-edited row never reaches a
  customer. ``spendMinorUSD`` is the last CONFIRMED value (``spendConfirmedAt``); an unreadable
  pass never overwrites it (the sync's job). ``lastSyncedAt`` is the last read Meta answered.
* ``derive_display_stage(request, results, now)``: PURE. The 13 stages of PLAN.md §5.4 with their
  labels (EN/AR), colour + icon, money meaning, next actor, customer actions and flags.
  stage_cases.json (next to this file) holds the same tables plus the cases, so the client
  fallback (P2-01) is tested against the same answers; test_studio_results.py fails when the JSON
  tables and the ones below drift apart.
* ``GET /api/studio/campaigns/summary`` (any signed-in user, lapsed customers too): the caller's
  OWN live requests (archived ones left out), ``{<campaign id>: {stage, stageKey, labels, ...,
  checkedAt, checkedAgo, metaUsedMinor, stopRequestedAt, dueAt, settleExpectedAt}}``. Staff ids
  and names are never part of it (the route passes it through studio_privacy.redact_staff_identity,
  P1-05), nor the staff-only Meta review text. ``dueAt`` stays null until the service-hours helper
  exists (P3-16).

Stage rules (PLAN.md §5.4). Status comes first: Draft 1 (also after a withdraw), Submitted 2,
Changes Requested 3, Rejected 13, Stopped 11 (``closeReason`` completed; legacy rows without a
``closeReason``: spend > 0 and stopped after the end date) or 12. Within Approved:

1. settled (``settleBasis`` written) -> 11;
2. linked (the request has a ``metaCampaignId``) and checked (a results row for that same Meta
   campaign with a read Meta answered): Meta's AD-level statuses decide, in the order
   Running (8) > Meta reviewing (5) > Ended (10) > Meta rejected (6) > Delivery problem (7) >
   Paused (9); nothing of these (e.g. no ads yet) -> 4, the team is still setting it up;
3. linked but not checked -> 4 "Checking Meta…";
4. not linked -> 4 with NO Meta-used value; 10 (full return) once the request's end date
   (Libya calendar) has passed. A legacy request that staff marked launched by hand
   (``publishStatus``) without a Meta campaign id is 10 without the full-return promise.

End signals: ad set ``end_time`` or campaign ``stop_time`` passed, campaign DELETED/ARCHIVED, the
request's end date passed, or a stop was requested. Running or reviewing past an end DATE (not a
stop request: that has its own chip, ``stopRequested`` on stages 4-9) keeps the stage and sets
``runningPastEnd``. A check older than 6 hours keeps the stage and sets
``stale`` (the screen turns "checked X ago" amber). The customer never sees "billing": a
PENDING_BILLING_INFO ad reads as a delivery problem.
"""

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ...db import db_conn, json_dumps, json_fields_select_sql, json_loads, json_loads_or_raw, now_ms
from ...rate_limiter import check_rate_limit
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_diagnostics import libya_today, parse_day, parse_time
from .studio_errors import studio_error
from .studio_privacy import redact_staff_identity
from .studio_types import created_by_or_none, derived_id

RESULTS_TYPE = "adCampaignResults"
RESULTS_ID_PREFIX = "acr"
STALE_CHECK_HOURS = 6
SUMMARY_READS_PER_MINUTE = 60

# Meta's effective_status values (ad level; the campaign level uses the first six).
AD_STATUSES = (
    "ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED",
    "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED",
)
CAMPAIGN_STATUSES = AD_STATUSES[:6]
REVIEW_STATUSES = ("PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED")
PROBLEM_STATUSES = ("WITH_ISSUES", "PENDING_BILLING_INFO")
PAUSED_STATUSES = ("PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED")
SYNC_STATES = ("never", "ok", "throttled", "parked", "not_found", "not_allowed", "error")
INSIGHTS_STATES = ("never", "ok", "unavailable")

# ------------------------------------------------------------------ the tables (EN / AR)

# stage -> key, labels, colour + icon (never colour alone), money meaning, next actor,
# tracker dot (Sent -> Approved -> Meta review -> Running -> Ended -> Finished; a side state
# replaces the current dot with its own chip) and the customer actions the screen may offer.
STAGES: dict[int, dict[str, Any]] = {
    1: {"key": "draft", "en": "Draft — not sent", "ar": "مسودة — لم تُرسل", "tone": "slate", "icon": "pencil",
        "money": "nothing_reserved", "nextActor": "you", "tracker": "not_sent", "side": False,
        "actions": ["edit", "send", "delete"]},
    2: {"key": "waiting_review", "en": "Waiting for Albayan review", "ar": "بانتظار مراجعة فريق البيان",
        "tone": "amber", "icon": "clock", "money": "reserved", "nextActor": "albayan", "tracker": "sent",
        "side": False, "actions": ["withdraw", "ask"]},
    3: {"key": "needs_changes", "en": "Needs your changes", "ar": "يحتاج تعديلك", "tone": "orange",
        "icon": "message-warning", "money": "reserve_released", "nextActor": "you", "tracker": "sent",
        "side": True, "actions": ["fix", "ask"]},
    4: {"key": "approved_setup", "en": "Approved — being set up in Meta", "ar": "مقبول — نجهّزه في ميتا",
        "tone": "blue", "icon": "badge-check", "money": "paid", "nextActor": "albayan", "tracker": "approved",
        "side": False, "actions": ["stop_refund", "ask_to_stop", "ask"]},
    5: {"key": "meta_reviewing", "en": "Meta is reviewing", "ar": "ميتا تراجع الإعلان", "tone": "blue",
        "icon": "shield", "money": "paid", "nextActor": "meta", "tracker": "meta_review", "side": False,
        "actions": ["ask_to_stop", "ask"]},
    6: {"key": "meta_rejected", "en": "Meta rejected the ad — the team is fixing it",
        "ar": "ميتا رفضت الإعلان — الفريق يعالجه", "tone": "red-orange", "icon": "shield-alert",
        "money": "paid_meta_rejected", "nextActor": "albayan", "tracker": "meta_review", "side": True,
        "actions": ["ask", "ask_to_stop"]},
    7: {"key": "delivery_problem", "en": "Delivery problem — the team is fixing it",
        "ar": "مشكلة في التشغيل — الفريق يعالجها", "tone": "orange", "icon": "alert-triangle", "money": "paid",
        "nextActor": "albayan", "tracker": "running", "side": True, "actions": ["ask", "ask_to_stop"]},
    8: {"key": "running", "en": "Running", "ar": "يعمل الآن", "tone": "green", "icon": "play",
        "money": "paid_running", "nextActor": "none", "tracker": "running", "side": False,
        "actions": ["ask_to_stop", "ask"]},
    9: {"key": "paused", "en": "Paused", "ar": "متوقف مؤقتاً", "tone": "slate-blue", "icon": "pause",
        "money": "paid", "nextActor": "albayan", "tracker": "running", "side": True,
        "actions": ["ask_to_stop", "ask"]},
    10: {"key": "ended_settling", "en": "Ended — final amount being calculated", "ar": "انتهى — نحسب المبلغ النهائي",
         "tone": "slate", "icon": "hourglass", "money": "paid_settling", "nextActor": "albayan", "tracker": "ended",
         "side": False, "actions": ["ask"]},
    11: {"key": "finished", "en": "Finished", "ar": "انتهى", "tone": "slate", "icon": "flag", "money": "final",
         "nextActor": "none", "tracker": "finished", "side": False, "actions": ["archive"]},
    12: {"key": "stopped", "en": "Stopped", "ar": "أُوقف", "tone": "rose", "icon": "stop", "money": "returned",
         "nextActor": "none", "tracker": "finished", "side": True, "actions": ["archive"]},
    13: {"key": "rejected", "en": "Rejected by Albayan", "ar": "مرفوض من فريق البيان", "tone": "red", "icon": "x",
         "money": "reserve_released", "nextActor": "none", "tracker": "sent", "side": True,
         "actions": ["read_reasons", "copy_fix", "delete"]},
}

# What the stage means for the customer's money (the numbers come from the wallet summary).
MONEY_MEANINGS: dict[str, dict[str, str]] = {
    "nothing_reserved": {"en": "Nothing reserved", "ar": "لا يوجد مبلغ محجوز"},
    "reserved": {"en": "Reserved — still yours", "ar": "محجوز — ما زال لك"},
    "reserve_released": {"en": "The reserved amount is back in your balance", "ar": "عاد المبلغ المحجوز إلى رصيدك"},
    "paid": {"en": "Paid — counted in \"In your ads\"", "ar": "مدفوع — ضمن «في إعلاناتك»"},
    "paid_meta_rejected": {
        "en": "Paid — usually nothing was used; if it cannot be fixed in time, the full amount comes back",
        "ar": "مدفوع — عادةً لم يُصرف شيء، وإن تعذّر إصلاحه في الوقت المحدد نعيد المبلغ كاملاً",
    },
    "paid_running": {"en": "Paid — Meta reports what it used so far", "ar": "مدفوع — تعرض ميتا ما استخدمته حتى الآن"},
    "paid_settling": {
        "en": "Unused money comes back after Meta's final numbers, usually within 2–3 days",
        "ar": "نحسب المبلغ النهائي بعد أن تثبت أرقام ميتا — عادةً خلال يومين إلى ثلاثة",
    },
    "full_return": {
        "en": "Meta never showed your ad — we return the full amount within one working day",
        "ar": "لم تعرض ميتا إعلانك — نعيد المبلغ كاملاً خلال يوم عمل",
    },
    "final": {"en": "Final — what Meta used is spent, the rest came back", "ar": "نهائي — صُرف ما استخدمته ميتا وعاد الباقي"},
    "returned": {"en": "The unused amount came back to your wallet", "ar": "عاد المبلغ غير المصروف إلى محفظتك"},
}

NEXT_ACTORS: dict[str, dict[str, str]] = {
    "you": {"en": "You", "ar": "أنت"},
    "albayan": {"en": "Albayan team", "ar": "فريق البيان"},
    "meta": {"en": "Meta (about 24 hours)", "ar": "ميتا (نحو 24 ساعة)"},
    "none": {"en": "Nothing needed now", "ar": "لا شيء مطلوب الآن"},
}

# A variant is a second line under the stage label.
VARIANTS: dict[str, dict[str, str]] = {
    "checking": {"en": "Checking Meta…", "ar": "نتحقق من ميتا…"},
    "never_delivered": {"en": "Meta never showed this ad", "ar": "لم تعرض ميتا هذا الإعلان"},
    "never_linked": {"en": "This ad was never created in Meta", "ar": "لم يُنشأ هذا الإعلان في ميتا"},
}

FLAG_LABELS: dict[str, dict[str, str]] = {
    "runningPastEnd": {"en": "Running past the promised end — the team is on it",
                       "ar": "ما زال يعمل بعد موعد الانتهاء — الفريق يتابعه"},
    "stopRequested": {"en": "Stop requested — we will pause it soon", "ar": "طُلب الإيقاف — سنوقفه قريباً"},
    "stale": {"en": "Meta has not been checked for a while", "ar": "لم نتحقق من ميتا منذ مدة"},
}


def stage_tables() -> dict[str, Any]:
    """The tables above as JSON-ready data (the ``tables`` part of stage_cases.json)."""
    return {
        "staleCheckHours": STALE_CHECK_HOURS,
        "stages": {str(number): dict(entry) for number, entry in STAGES.items()},
        "money": MONEY_MEANINGS,
        "nextActors": NEXT_ACTORS,
        "variants": VARIANTS,
        "flags": FLAG_LABELS,
    }


# ------------------------------------------------------------------ adCampaignResults rows

_TIME_FIELDS = (
    "campaignStopTime", "adsetEndTime", "spendConfirmedAt", "deliveryEndedAt", "settleReadDueAt",
    "driftWatchUntil", "stopEffectiveAt", "lastSyncedAt", "nextSyncAt", "syncClaimedUntil",
)
_COUNT_FIELDS = ("lifetimeImpressions", "reach", "impressions", "clicks", "resultCount", "costPerResultMinorUSD")
_TEXT_FIELDS = {
    "metaCampaignName": 400, "reviewFeedbackPublic": 1000, "reviewFeedbackStaff": 2000, "metaStage": 40,
    "resultType": 60, "lastErrorCode": 60,
}
_MAX_MINOR = 10**12
_MAX_AD_COUNT = 10_000


def results_id(campaign_id: Any) -> str:
    return derived_id(RESULTS_ID_PREFIX, campaign_id)


def _int_or_none(value: Any, top: int = _MAX_MINOR) -> int | None:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or number > top or number != int(number):
        return None
    return int(number)


def _iso_or_none(value: Any) -> str | None:
    moment = parse_time(value)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if moment else None


def _meta_id(value: Any) -> str:
    raw = str(value or "").strip()
    return raw if raw.isascii() and raw.isdigit() and len(raw) <= 40 else ""


def _text(value: Any, limit: int) -> str:
    raw = value if isinstance(value, str) else ""
    return "".join(ch for ch in raw if ch >= " " or ch in "\n\t")[:limit]


def normalize_results(data: Any) -> dict[str, Any]:
    """A results row read through today's rules: every field present, bad values -> safe default."""
    raw = data if isinstance(data, dict) else {}
    out: dict[str, Any] = {
        "recordType": RESULTS_TYPE,
        "schemaVersion": 1,
        "campaignId": str(raw.get("campaignId") or "")[:80],
        "ownerId": str(raw.get("ownerId") or "")[:80],
        "metaCampaignId": _meta_id(raw.get("metaCampaignId")),
        "metaAdAccountId": "",
    }
    account = str(raw.get("metaAdAccountId") or "").strip()
    digits = account[4:] if account.startswith("act_") else account
    if _meta_id(digits):
        out["metaAdAccountId"] = f"act_{digits}"
    status = str(raw.get("campaignEffectiveStatus") or "").strip().upper()
    out["campaignEffectiveStatus"] = status if status in CAMPAIGN_STATUSES else ""
    counts: dict[str, int] = {}
    raw_counts = raw.get("adStatusCounts") if isinstance(raw.get("adStatusCounts"), dict) else {}
    for key, value in raw_counts.items():
        name = str(key or "").strip().upper()
        number = _int_or_none(value, _MAX_AD_COUNT)
        if name in AD_STATUSES and number:
            counts[name] = counts.get(name, 0) + number
    out["adStatusCounts"] = counts
    out["anyAdDelivering"] = raw.get("anyAdDelivering") is True
    out["neverDelivered"] = raw.get("neverDelivered") is True
    out["spendMinorUSD"] = _int_or_none(raw.get("spendMinorUSD")) or 0
    for field in _COUNT_FIELDS:
        out[field] = _int_or_none(raw.get(field))
    for field in _TIME_FIELDS:
        out[field] = _iso_or_none(raw.get(field))
    for field, limit in _TEXT_FIELDS.items():
        out[field] = _text(raw.get(field), limit)
    insights = str(raw.get("insightsState") or "")
    out["insightsState"] = insights if insights in INSIGHTS_STATES else "never"
    sync = str(raw.get("syncState") or "")
    out["syncState"] = sync if sync in SYNC_STATES else "never"
    currency = str(raw.get("currency") or "").strip().upper()
    out["currency"] = currency if len(currency) == 3 and currency.isalpha() and currency.isascii() else ""
    return out


class ResultsRowChanged(Exception):
    """write_results_row: someone wrote the row after the caller read it (``expected_last_modified``)."""


def write_results_row(
    conn: Any,
    campaign_id: str,
    owner_id: str,
    fields: dict[str, Any],
    *,
    stamp_ms: int | None = None,
    expected_last_modified: int | None = None,
) -> dict[str, Any]:
    """Insert or update the results row of one request; returns the normalized data.

    ``fields`` are merged over the stored row, then the whole row is normalized, so an unknown or
    bad field never lands. ``expected_last_modified`` (optional) makes the update conditional
    (the P3 sync claims rows this way); a mismatch raises ResultsRowChanged. Run it on the
    caller's transaction.
    """
    row_id = results_id(campaign_id)
    stamp = int(stamp_ms or now_ms())
    found = conn.execute(
        text("SELECT data_json, created_at, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1"),
        {"type": RESULTS_TYPE, "id": row_id},
    ).mappings().first()
    merged = {**(json_loads(found["data_json"]) if found else {}), **dict(fields or {})}
    merged.update({"campaignId": str(campaign_id), "ownerId": str(owner_id or "")})
    data = normalize_results(merged)
    data["id"] = row_id
    data["_deleted"] = False
    if found:
        baseline = int(found["last_modified"])
        if expected_last_modified is not None and int(expected_last_modified) != baseline:
            raise ResultsRowChanged(row_id)
        modified = max(stamp, baseline + 1)
        data["_created"] = int(found["created_at"])
        data["_lastModified"] = modified
        result = conn.execute(
            text(
                "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                "WHERE type = :type AND id = :id AND last_modified = :baseline"
            ),
            {"data": json_dumps(data), "modified": modified, "type": RESULTS_TYPE, "id": row_id, "baseline": baseline},
        )
        if int(result.rowcount or 0) != 1:
            raise ResultsRowChanged(row_id)
        return data
    if expected_last_modified is not None:
        raise ResultsRowChanged(row_id)
    data["_created"] = stamp
    data["_lastModified"] = stamp
    try:
        conn.execute(
            text(
                "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
            ),
            {"type": RESULTS_TYPE, "id": row_id, "data": json_dumps(data), "stamp": stamp,
             "owner": created_by_or_none(conn, owner_id)},
        )
    except IntegrityError as error:  # two first writes at once: the fixed id lets one win
        raise ResultsRowChanged(row_id) from error
    return data


# ------------------------------------------------------------------ request rows

REQUEST_FIELDS = (
    "status", "name", "submittedAt", "budgetMinorUSD", "startDate", "endDate", "metaCampaignId", "publishStatus",
    "spendMinorUSD", "refundMinorUSD", "paidMinorUSD", "stopRequestedAt", "closeReason", "changeReasons",
    "settleBasis", "stoppedAt",
    # What a Submitted request holds (wallet_payments.campaign_hold_minor: the total from P1 on) and
    # whether budgetMinorUSD is one day of it (the wallet summary's Reserved list).
    "totalBudgetMinorUSD", "budgetType",
)


def minor(value: Any) -> int:
    """A stored amount in minor units, read like wallet_payments.wallet_campaign_holds_minor."""
    try:
        return max(int(float(value or 0)), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def load_owner_requests(conn: Any, owner_id: str, *, include_archived: bool) -> list[dict[str, Any]]:
    """The owner's requests (only the fields the stage and money models need; never the images)."""
    where = "type = :type AND created_by = :uid" + ("" if include_archived else " AND deleted = false")
    rows = conn.execute(
        text(json_fields_select_sql(REQUEST_FIELDS, ("id", "deleted"), where)),
        {"type": AD_CAMPAIGN_COLLECTION, "uid": str(owner_id or "")},
    ).mappings().all()
    out = []
    for row in rows:
        item = {field: row.get(f"f_{field.lower()}") for field in REQUEST_FIELDS}
        item["changeReasons"] = json_loads_or_raw(item.get("changeReasons"))
        item["id"] = str(row["id"])
        item["archived"] = bool(row.get("deleted"))
        out.append(item)
    return out


def load_owner_results(conn: Any, owner_id: str, campaign_ids: Any) -> dict[str, dict[str, Any]]:
    """{campaign id: normalized results row} for the owner's own requests only."""
    wanted = {str(cid) for cid in campaign_ids}
    if not wanted:
        return {}
    rows = conn.execute(
        text("SELECT id, data_json FROM entities WHERE type = :type AND deleted = false AND created_by = :uid"),
        {"type": RESULTS_TYPE, "uid": str(owner_id or "")},
    ).mappings().all()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        data = normalize_results(json_loads(row["data_json"]))
        campaign_id = data["campaignId"]
        if campaign_id in wanted and str(row["id"]) == results_id(campaign_id):
            out[campaign_id] = data
    return out


# ------------------------------------------------------------------ the pure stage function

def _labels(entry: dict[str, str]) -> dict[str, str]:
    return {"en": entry["en"], "ar": entry["ar"]}


def _reasons(value: Any) -> list[str]:
    items = value if isinstance(value, list) else []
    out = []
    for item in items[:10]:
        code = str(item or "").strip()
        if code and len(code) <= 40 and code.replace("_", "").replace("-", "").isalnum() and code.isascii():
            out.append(code)
    return out


def _not_started(request: dict[str, Any], today: Any) -> bool:
    """The customer's own stop still returns everything (mirrors the stop route's 'started' rule)."""
    start = parse_day(request.get("startDate"))
    return bool(
        start
        and today <= start
        and not str(request.get("publishStatus") or "").strip()
        and not str(request.get("metaCampaignId") or "").strip()
        and minor(request.get("spendMinorUSD")) == 0
    )


def _stopped_stage(request: dict[str, Any], now: datetime) -> int:
    reason = str(request.get("closeReason") or "").strip()
    if reason:
        return 11 if reason == "completed" else 12
    # Legacy rows (no closeReason): finished when money was spent and the stop came after the end.
    end = parse_day(request.get("endDate"))
    stopped = parse_time(request.get("stoppedAt")) or now
    if minor(request.get("spendMinorUSD")) > 0 and end and libya_today(stopped) > end:
        return 11
    return 12


def _meta_stage(request: dict[str, Any], results: dict[str, Any], now: datetime, end_passed: bool) -> tuple[int, bool]:
    """(stage, past the promised end) from a checked results row (precedence of PLAN.md §5.4).

    A stop request is an end signal too, but "past the promised end" is about dates only: a
    running ad with a stop request shows the stop chip instead.
    """
    counts = results["adStatusCounts"]
    total = sum(counts.values())
    campaign = results["campaignEffectiveStatus"]
    meta_end_times = [parse_time(results[field]) for field in ("adsetEndTime", "campaignStopTime")]
    past_end = (
        end_passed
        or campaign in ("DELETED", "ARCHIVED")
        or any(moment is not None and moment <= now for moment in meta_end_times)
    )
    ended = past_end or bool(str(request.get("stopRequestedAt") or "").strip())
    if counts.get("ACTIVE", 0) > 0 or results["anyAdDelivering"]:
        return 8, past_end
    if any(counts.get(status, 0) for status in REVIEW_STATUSES):
        return 5, past_end
    if ended:
        return 10, past_end
    if total and counts.get("DISAPPROVED", 0) == total:
        return 6, False
    if any(counts.get(status, 0) for status in PROBLEM_STATUSES) or campaign == "WITH_ISSUES":
        return 7, False
    if campaign == "PAUSED" or (total and sum(counts.get(s, 0) for s in PAUSED_STATUSES) == total):
        return 9, False
    return 4, False


def derive_display_stage(request: dict[str, Any], results: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    """The display stage of one request (PURE: no database, no clock of its own).

    ``request``: the request's data fields (REQUEST_FIELDS); ``results``: its adCampaignResults
    row (any shape; normalized here) or None; ``now``: an aware time.
    """
    now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    today = libya_today(now)
    status = str(request.get("status") or "Draft")
    meta_id = _meta_id(request.get("metaCampaignId"))
    linked = bool(meta_id)
    row = normalize_results(results) if results else None
    checked_at = None
    if linked and row and row["metaCampaignId"] == meta_id and row["lastSyncedAt"]:
        checked_at = row["lastSyncedAt"]
    end = parse_day(request.get("endDate"))
    end_passed = bool(end and today > end)
    variant = ""
    past_end = False

    if status == "Submitted":
        stage = 2
    elif status == "Changes Requested":
        stage = 3
    elif status == "Rejected":
        stage = 13
    elif status == "Stopped":
        stage = _stopped_stage(request, now)
    elif status != "Approved":
        stage = 1  # Draft, a withdrawn request, or a status this model does not know
    elif str(request.get("settleBasis") or "").strip():
        stage = 11
    elif checked_at and row is not None:
        stage, past_end = _meta_stage(request, row, now, end_passed)
        if stage == 10 and row["neverDelivered"]:
            variant = "never_delivered"
    elif linked:
        stage, variant = 4, "checking"
    elif end_passed:
        # A legacy request that staff marked launched by hand (publishStatus, or a Meta id that
        # is not a number) did run: it waits for its final amount like any ended ad. Only a
        # request with no launch marker at all is a full return.
        marked = str(request.get("publishStatus") or "").strip() or str(request.get("metaCampaignId") or "").strip()
        stage, variant = 10, ("" if marked else "never_linked")
    else:
        stage = 4

    entry = STAGES[stage]
    money_key = entry["money"]
    if stage == 10 and variant in ("never_delivered", "never_linked"):
        money_key = "full_return"
    in_meta = status == "Approved" and stage in (4, 5, 6, 7, 8, 9, 10) and checked_at is not None
    meta_used = None
    if in_meta and row is not None and row["currency"] == "USD" and row["spendConfirmedAt"]:
        meta_used = row["spendMinorUSD"]
    stale = bool(in_meta and (now - parse_time(checked_at)) > timedelta(hours=STALE_CHECK_HOURS))
    stop_requested_at = _iso_or_none(request.get("stopRequestedAt")) if status == "Approved" else None
    stop_overlay = bool(stop_requested_at) and 4 <= stage <= 9
    actions = list(entry["actions"])
    if stage == 4 and not _not_started(request, today):
        actions.remove("stop_refund")
    if stop_overlay and "ask_to_stop" in actions:
        actions.remove("ask_to_stop")
    return {
        "stage": stage,
        "stageKey": entry["key"],
        "labels": _labels(entry),
        "tone": entry["tone"],
        "icon": entry["icon"],
        "moneyKey": money_key,
        "money": dict(MONEY_MEANINGS[money_key]),
        "nextActor": entry["nextActor"],
        "nextActorLabels": dict(NEXT_ACTORS[entry["nextActor"]]),
        "variant": variant,
        "variantLabels": dict(VARIANTS[variant]) if variant else None,
        "linked": linked,
        "checking": variant == "checking",
        "checkedAt": checked_at if in_meta else None,
        "stale": stale,
        "metaUsedMinor": meta_used,
        "runningPastEnd": bool(stage in (5, 8) and past_end),
        "stopRequested": stop_overlay,  # the overlay chip on stages 4-9
        "stopRequestedAt": stop_requested_at,
        "tracker": {"step": entry["tracker"], "side": entry["side"]},
        "actions": actions,
        "reasons": _reasons(request.get("changeReasons")) if stage in (3, 13) else [],
    }


# ------------------------------------------------------------------ "checked X ago"

def _ar_count(number: int, one: str, two: str, few: str, many: str) -> str:
    if number == 1:
        return one
    if number == 2:
        return two
    return f"{number} {few if 3 <= number <= 10 else many}"


def checked_ago(checked_at: Any, now: datetime) -> dict[str, Any] | None:
    """{seconds, en, ar} for "checked X ago" (a check in the future reads as "just now")."""
    moment = parse_time(checked_at)
    if not moment:
        return None
    seconds = max(int((now - moment).total_seconds()), 0)
    if seconds < 60:
        return {"seconds": seconds, "en": "checked just now", "ar": "فُحص الآن"}
    minutes, hours, days = seconds // 60, seconds // 3600, seconds // 86400
    if minutes < 60:
        en = f"checked {minutes} minute{'s' if minutes != 1 else ''} ago"
        ar = _ar_count(minutes, "دقيقة", "دقيقتين", "دقائق", "دقيقة")
    elif hours < 48:
        en = f"checked {hours} hour{'s' if hours != 1 else ''} ago"
        ar = _ar_count(hours, "ساعة", "ساعتين", "ساعات", "ساعة")
    else:
        en = f"checked {days} days ago"
        ar = _ar_count(days, "يوم", "يومين", "أيام", "يوماً")
    return {"seconds": seconds, "en": en, "ar": f"فُحص قبل {ar}"}


# ------------------------------------------------------------------ the summary route

def utc_now() -> datetime:
    """The clock of the summary routes (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def campaigns_summary(conn: Any, owner_id: str, now: datetime) -> dict[str, dict[str, Any]]:
    """{campaign id: display stage + checkedAgo, dueAt, settleExpectedAt} for the owner's live requests."""
    requests = load_owner_requests(conn, owner_id, include_archived=False)
    results = load_owner_results(conn, owner_id, (r["id"] for r in requests))
    out: dict[str, dict[str, Any]] = {}
    for request in requests:
        row = results.get(request["id"])
        stage = derive_display_stage(request, row, now)
        stage["checkedAgo"] = checked_ago(stage["checkedAt"], now)
        stage["dueAt"] = None  # the service-hours helper (P3-16) fills the team's due time
        settle = row.get("settleReadDueAt") if row and stage["stage"] == 10 and stage["checkedAt"] else None
        stage["settleExpectedAt"] = settle if stage["variant"] == "" else None
        out[request["id"]] = stage
    return out


def summary_rate_limit(user: dict[str, Any], bucket: str, per_minute: int = SUMMARY_READS_PER_MINUTE) -> None:
    allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
    if not allowed:
        studio_error(
            429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
            headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
        )


def create_studio_results_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """``GET /campaigns/summary`` under the studio router's /api/studio prefix (read only)."""
    router = APIRouter()

    @router.get("/campaigns/summary")
    def get_campaigns_summary(user: dict[str, Any] = Depends(current_user_dependency)):
        summary_rate_limit(user, "campaigns-summary")
        with db_conn() as conn:
            summary = campaigns_summary(conn, str(user.get("id") or ""), utc_now())
        return redact_staff_identity(summary, user)  # P1-05: never a staff id, even from a future field

    return router
