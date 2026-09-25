"""Albayan Studio results sync (plan tasks P3-01, P3-03, P3-04c; PLAN.md §7.1 ``adCampaignResults``,
§7.4 "Results and status sync"; DECISIONS D26, D27, D28).

Meta's view of every request the studio desk LINKED to a Meta campaign, kept in the request's
``adCampaignResults`` row (studio_results.py) and read through the platform door
meta_ads.get_campaign_results: one combined read, refused before any call unless the ad account is
on the allowlist and the campaign is claimed by THIS request.

* **Where it runs.** One job of the studio jobs loop (studio_jobs.py, ``results``), claimed in the
  tick's heartbeat write like the other jobs, and only while a Meta token is configured. A pass
  (``run_results_sync``) makes at most 5 Meta reads, starts none after 10 seconds, and starts none
  at all while Albayan's Meta pause runs (meta_ads.studio_meta_pause_seconds). The staff "Check
  Meta now" button (``check_now``) syncs one request the same way.
* **One worker per request.** A sync first CLAIMS the row: ``syncClaimedUntil`` = now + 2 minutes,
  written with a version check (a first row: an insert only). Only the claim's winner reads Meta,
  and its result is written with a version check against its own claim: a write in between
  (another process, a manual check) wins and the late result is dropped. A crashed sync's claim
  simply runs out.
* **What is due.** A linked Approved request never read for its current Meta campaign (a first link
  or a relink: the row starts again, nothing carries over from another campaign) or whose row an
  unlink left stranded (``not_allowed`` with no ``nextSyncAt``: staff linked the same campaign
  again), else a row whose ``nextSyncAt`` has come:
  - linked and not ended (running, in review, paused, rejected, a delivery problem): every 15 minutes;
  - ended (nothing delivering or in review, and an end signal: the request's end date, a Meta end
    time, a deleted campaign, a stop request, a Stopped or settled request; ACTIVE ads after a Meta
    end time do not deliver): ``deliveryEndedAt`` is stamped once (the earliest Meta end time that
    passed, else the read's time), ``settleReadDueAt`` = deliveryEndedAt +
    ``settlement.spendDelayHours`` (48 h, D28) and ``driftWatchUntil`` = deliveryEndedAt +
    ``settlement.driftWatchDays`` (28). The next
    read is AT settleReadDueAt (the final read, stamped ``settleReadAt`` once Meta's insights
    answered), then one a day until driftWatchUntil, then none. Delivery that starts again clears
    those times;
  - a request no longer linked, or neither Approved nor Stopped: never read (``not_allowed``).
* **Money numbers** are Meta's LIFETIME spend, impressions, reach, clicks and main result. When the
  insights read fails (``insightsState`` unavailable) the stored numbers stay: spend is never
  overwritten with 0. An ad account billing in another currency is flagged (``syncState`` error,
  ``lastErrorCode`` currency_mismatch): its spend is kept apart (``rawSpendMinor`` +
  ``rawSpendCurrency``) and never written as ``spendMinorUSD`` / ``spendConfirmedAt`` / the final
  read ``settleReadAt`` (then read once a day until the drift watch ends); the stage shows no "Meta
  used" value. ``neverDelivered``: 0 impressions and $0 once delivery
  ended (at once with ``settlement.neverDeliveredImmediate``, else from the final read).
* **Errors** are stored as ``syncState`` + ``lastErrorCode`` (Albayan's error class and Meta's
  numeric code; never a message, never a token) and the last good values stay: ``not_found`` and
  ``not_allowed`` are read again in 6 hours, other failures in 30 minutes. A throttle, a timeout,
  an unreachable Meta or an authorization failure also PARKS that ad account for 15 minutes
  (``studioJobState.resultsParkedUntil``, a ``results_parked`` alert once a day per account): the
  pass skips its requests and goes on with the others.
* **Alerts** (studio_jobs.raise_alert: one per request and Tripoli day). ``running_past_end``: an ad
  ACTIVE past the end (the end date passed, the campaign deleted, the request Stopped or settled;
  after a Meta end time Meta itself stopped it, so that is Ended, not an alert). ``meta_drift``:
  once the request is settled (Stopped, or a ``settleBasis``),
  Meta's spend above the settled spend (``settledSpendMinorUSD``, else what the stop recorded as
  spent) by more than $0.50. Albayan absorbs it (D27); the alert feeds the owner's reconciliation.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import text

from ... import meta_ads as _meta
from ...db import db_conn, json_field_sql, json_fields_select_sql
from . import studio_jobs
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_diagnostics import parse_time
from .studio_results import (
    MANUAL_CHECK_EVERY,
    RESULTS_TYPE,
    ResultsRowChanged,
    derive_display_stage,
    linked_meta_ids,
    load_request,
    load_results_row,
    meta_delivery,
    meta_time_ended_at,
    minor,
    next_manual_check_at,
    normalize_results,
    results_id,
    write_results_row,
)
from .studio_settings import read_all_settings

ACTIVE_EVERY = timedelta(minutes=15)  # linked and not ended
DRIFT_EVERY = timedelta(days=1)  # after the final read, until driftWatchUntil
RETRY_AFTER_ERROR = timedelta(minutes=30)
RETRY_NOT_FOUND = timedelta(hours=6)
PARK_FOR = timedelta(minutes=15)
CLAIM_FOR = timedelta(minutes=2)
PASS_MAX_READS = 5  # PLAN.md §7.4: <= 5 results syncs per tick
PASS_MAX_SECONDS = 10.0  # ... within <= 10 s wall time
DRIFT_TOLERANCE_MINOR = 50  # $0.50
SYNCED_STATUSES = frozenset({"Approved", "Stopped"})  # Stopped: the drift reads after settle
PARKS_FIELD = "resultsParkedUntil"  # studioJobState: {ad account digits: until}
DRIFT_ALERT = "meta_drift"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
LINK_MEMO_FOR = timedelta(minutes=10)  # due_candidates reads an unchanged request's link again this often
_LINK_READ_CHUNK = 200
# due_candidates' memo of the live Approved requests: {request id: (last_modified, read at, (account
# digits, Meta campaign id) or None when not linked)}. Keyed by the row version, so a changed request
# is read again at once; the age limit covers a write that kept its last_modified.
_LINK_MEMO: dict[str, tuple[int, datetime, tuple[str, str] | None]] = {}

# A first read of a Meta campaign (a first link or a relink) starts from these: nothing of another
# campaign carries over.
_FRESH: dict[str, Any] = {
    "metaCampaignName": "", "campaignEffectiveStatus": "", "campaignStopTime": None, "adStatusCounts": {},
    "anyAdDelivering": False, "adsetEndTime": None, "reviewFeedbackPublic": "", "reviewFeedbackStaff": "",
    "metaStage": "", "spendMinorUSD": 0, "spendConfirmedAt": None, "insightsState": "never",
    "lifetimeImpressions": None, "impressions": None, "reach": None, "clicks": None, "resultType": "",
    "resultCount": None, "costPerResultMinorUSD": None, "currency": "", "rawSpendMinor": None,
    "rawSpendCurrency": "", "deliveryEndedAt": None,
    "settleReadDueAt": None, "settleReadAt": None, "driftWatchUntil": None, "neverDelivered": False,
    "stopEffectiveAt": None, "lastSyncedAt": None, "syncState": "never", "lastErrorCode": "", "nextSyncAt": None,
}
_ENDED_TIMES = {"deliveryEndedAt": None, "settleReadDueAt": None, "settleReadAt": None, "driftWatchUntil": None}

# "Check Meta now" answers that did not bring a fresh reading (the stored one is shown).
CHECK_ERRORS: dict[str, dict[str, str]] = {
    "META_PAUSED": {"en": "Meta is busy right now. The saved reading is shown; try again in a few minutes.",
                    "ar": "ميتا مشغولة الآن. تظهر آخر قراءة محفوظة؛ أعد المحاولة بعد دقائق."},
    "META_NOT_CONFIGURED": {"en": "Albayan's Meta connection is not set up.", "ar": "ربط البيان مع ميتا غير مُعدّ."},
    "SYNC_RUNNING": {"en": "This ad is being checked right now. The saved reading is shown.",
                     "ar": "يجري فحص هذا الإعلان الآن. تظهر آخر قراءة محفوظة."},
    "META_NOT_FOUND": {"en": "Meta could not find this campaign. Check the link.",
                       "ar": "لم تجد ميتا هذه الحملة. تحقق من الربط."},
    "META_NOT_ALLOWED": {"en": "This campaign is not on an allowed ad account or not linked to this request.",
                         "ar": "هذه الحملة ليست على حساب إعلاني مسموح أو ليست مربوطة بهذا الطلب."},
    "META_ERROR": {"en": "Meta did not answer. The saved reading is shown.", "ar": "لم تُجب ميتا. تظهر آخر قراءة محفوظة."},
}
_CHECK_CODES = {"not_found": "META_NOT_FOUND", "not_allowed": "META_NOT_ALLOWED", "rate_limited": "META_PAUSED",
                "not_configured": "META_NOT_CONFIGURED"}


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The sync's clock (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _meta_configured() -> bool:
    return bool(_meta.load_meta_ads_config().configured)


def _account_digits(value: Any) -> str:
    raw = str(value or "").strip()
    raw = raw[4:] if raw.startswith("act_") else raw
    return raw if raw.isascii() and raw.isdigit() and len(raw) <= 40 else ""


def settled_spend_minor(request: dict[str, Any]) -> int | None:
    """What Albayan settled the request at (D27): ``settledSpendMinorUSD`` once the settle step wrote
    it, else what a stop recorded as spent; None while the request is not settled."""
    settled = request.get("settledSpendMinorUSD")
    if settled not in (None, ""):
        return minor(settled)
    if str(request.get("status") or "") == "Stopped" or str(request.get("settleBasis") or "").strip():
        return minor(request.get("spendMinorUSD"))
    return None


# ------------------------------------------------------------------ one Meta read -> the row (PURE)

def fields_after_read(
    previous: dict[str, Any] | None,
    request: dict[str, Any],
    read: dict[str, Any],
    now: datetime,
    settings: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(fields to write, facts) for one answered read (PURE: no database, no clock of its own).

    ``previous``: the stored row (any shape); ``read``: meta_ads.get_campaign_results' answer;
    ``settings``: studio_settings.read_all_settings(). Facts: ``stage`` (the display stage after the
    write), ``runningPastEnd`` (an ad ACTIVE past the end) and ``drift`` (None, or the numbers of a
    post-settle drift above $0.50).
    """
    now = _aware(now)
    at = _iso(now)
    base = normalize_results(previous)
    fields: dict[str, Any] = {} if base["metaCampaignId"] == read["campaignId"] else dict(_FRESH)
    if fields:
        base = normalize_results({**base, **fields})
    fields.update({
        "metaCampaignId": read["campaignId"],
        "metaAdAccountId": f"act_{read['accountId']}",
        "metaCampaignName": read.get("name") or "",
        "campaignEffectiveStatus": read.get("effectiveStatus") or "",
        "campaignStopTime": read.get("stopTime") or None,
        "adStatusCounts": dict(read.get("adStatusCounts") or {}),
        "anyAdDelivering": read.get("anyAdDelivering") is True,
        # None: Meta did not answer the ad sets read, so the end time known so far stays.
        "adsetEndTime": base["adsetEndTime"] if read.get("adsetEndTime") is None else (read["adsetEndTime"] or None),
        "reviewFeedbackStaff": read.get("reviewFeedback") or "",
        "lastSyncedAt": at,
        "lastAttemptAt": at,
        "syncState": "ok",
        "lastErrorCode": "",
        "syncClaimedUntil": None,
    })
    link = request.get("metaLinkResult") if isinstance(request.get("metaLinkResult"), dict) else {}
    currency = str(read.get("currency") or "").upper() or base["currency"] or str(link.get("metaCurrency") or "").upper()
    fields["currency"] = currency
    usd = currency == "USD"  # only a USD amount is money here: another currency is never counted as USD
    insights_ok = read.get("insightsState") == "ok" and read.get("spendMinor") is not None
    spend = minor(read.get("spendMinor"))
    impressions = minor(read.get("impressions"))
    if insights_ok:
        count = read.get("resultCount")
        fields.update({
            "insightsState": "ok",
            "lifetimeImpressions": read.get("impressions"), "impressions": read.get("impressions"),
            "reach": read.get("reach"), "clicks": read.get("clicks"), "resultType": read.get("resultType") or "",
            "resultCount": count,
        })
        if usd:
            fields.update({
                "spendMinorUSD": spend, "spendConfirmedAt": at, "rawSpendMinor": None, "rawSpendCurrency": "",
                "costPerResultMinorUSD": spend // count if isinstance(count, int) and count > 0 else None,
            })
        else:  # kept apart for staff; spendMinorUSD, spendConfirmedAt and the final read stay untouched
            fields.update({"rawSpendMinor": spend, "rawSpendCurrency": currency, "costPerResultMinorUSD": None})
    else:
        fields["insightsState"] = "unavailable"  # the last confirmed numbers stay: never 0 for "unknown"
    if currency and not usd:
        fields.update({"syncState": "error", "lastErrorCode": "currency_mismatch"})

    current = normalize_results({**base, **fields})
    delivery = meta_delivery(request, current, now)
    if str(request.get("stopRequestedAt") or "").strip() and not delivery["delivering"] and not base["stopEffectiveAt"]:
        fields["stopEffectiveAt"] = at
    next_at: datetime | None = now + ACTIVE_EVERY
    if delivery["ended"]:
        rules = settings["settlement"]
        # Stamped once: a Meta end time that passed is when Meta stopped delivering (its ads may still
        # say ACTIVE), else this read.
        ended_at = parse_time(base["deliveryEndedAt"]) or meta_time_ended_at(current, now) or now
        settle_due = ended_at + timedelta(hours=int(rules["spendDelayHours"]))
        watch_until = ended_at + timedelta(days=int(rules["driftWatchDays"]))
        final_at = parse_time(base["settleReadAt"])
        if final_at is None and insights_ok and usd and now >= settle_due:
            final_at = now  # this is the final read (D28)
        fields.update({
            "deliveryEndedAt": _iso(ended_at), "settleReadDueAt": _iso(settle_due),
            "driftWatchUntil": _iso(watch_until), "settleReadAt": _iso(final_at) if final_at else None,
        })
        if final_at is None and now >= settle_due and insights_ok and not usd:
            # A non-USD account never gives a final read (staff must fix the link): once a day until
            # the drift watch ends, not every 30 minutes forever.
            next_at = min(now + DRIFT_EVERY, watch_until) if now < watch_until else None
        elif final_at is None:
            next_at = settle_due if now < settle_due else now + RETRY_AFTER_ERROR  # the final read needs insights
        elif now >= watch_until:
            next_at = None  # the drift watch is over
        else:
            next_at = min(now + DRIFT_EVERY, watch_until)
        if insights_ok:
            nothing = spend == 0 and impressions == 0
            if nothing and (final_at is not None or rules.get("neverDeliveredImmediate") is True):
                fields["neverDelivered"] = True
            elif not nothing:
                fields["neverDelivered"] = False
    elif base["deliveryEndedAt"] or base["settleReadDueAt"]:
        fields.update({**_ENDED_TIMES, "neverDelivered": False})  # not ended any more: delivery started again
    fields["nextSyncAt"] = _iso(next_at) if next_at else None
    stage = derive_display_stage(request, {**base, **fields}, now)
    fields["metaStage"] = stage["stageKey"]

    drift = None
    settled = settled_spend_minor(request)
    if settled is not None and insights_ok and currency == "USD" and spend - settled > DRIFT_TOLERANCE_MINOR:
        drift = {"metaSpendMinorUSD": spend, "settledSpendMinorUSD": settled, "driftMinorUSD": spend - settled}
    facts = {
        "stage": stage["stage"],
        "runningPastEnd": delivery["delivering"] and delivery["pastEnd"],
        "drift": drift,
    }
    return fields, facts


# ------------------------------------------------------------------ one request

def _error_plan(error: Any, now: datetime) -> dict[str, Any]:
    """What a failed read means for the row and the pass (see the module docstring, "Errors")."""
    code = str(getattr(error, "code", "") or "meta_error")
    if _meta.is_meta_pause_refusal(error):  # Albayan's own pause: nothing reached Meta, the pass stops
        wait = max(_meta.studio_meta_pause_seconds(), 60)
        return {"state": "throttled", "next": now + timedelta(seconds=wait), "park": False, "stop": True, "called": False}
    if code == "not_configured":
        return {"state": "error", "next": now + RETRY_AFTER_ERROR, "park": False, "stop": True, "called": False}
    if code == "not_allowed":
        return {"state": "not_allowed", "next": now + RETRY_NOT_FOUND, "park": False, "stop": False, "called": False}
    if code == "not_found":
        return {"state": "not_found", "next": now + RETRY_NOT_FOUND, "park": False, "stop": False, "called": True}
    if code == "rate_limited":
        return {"state": "throttled", "next": now + PARK_FOR, "park": True, "stop": False, "called": True}
    if bool(getattr(error, "retryable", False)) or code == "authorization":
        return {"state": "error", "next": now + PARK_FOR, "park": True, "stop": False, "called": True}
    return {"state": "error", "next": now + RETRY_AFTER_ERROR, "park": False, "stop": False, "called": True}


def _error_code(error: Any) -> str:
    code = str(getattr(error, "code", "") or "meta_error")
    provider = str(getattr(error, "provider_code", "") or "")
    return (f"{code}:{provider}" if provider else code)[:60]


def _write_quietly(campaign_id: str, owner_id: str, fields: dict[str, Any], version: int | None) -> dict[str, Any] | None:
    """A version-checked write that yields to anyone who wrote the row first (None then)."""
    try:
        with db_conn() as conn:
            return write_results_row(conn, campaign_id, owner_id, fields, expected_last_modified=version,
                                     expect_new=version is None)
    except ResultsRowChanged:
        return None


def _raise_alerts(request: dict[str, Any], data: dict[str, Any], facts: dict[str, Any], now: datetime) -> list[str]:
    raised: list[str] = []
    owner = request.get("ownerId") or None
    base = {"metaCampaignId": data.get("metaCampaignId"), "stage": facts["stage"]}
    wanted = []
    if facts["runningPastEnd"]:
        wanted.append(("running_past_end", {**base, "endDate": str(request.get("endDate") or "")[:10],
                                            "status": str(request.get("status") or "")}))
    if facts["drift"]:
        wanted.append((DRIFT_ALERT, {**base, **facts["drift"]}))
    for kind, details in wanted:
        try:
            with db_conn() as conn:
                studio_jobs.raise_alert(conn, kind, related_type=AD_CAMPAIGN_COLLECTION, related_id=request["id"],
                                        owner_id=owner, details=details, now=now)
            raised.append(kind)
        except Exception as error:  # an alert that cannot be written never undoes the reading
            print(f"[albayan] Studio results alert '{kind}' failed ({type(error).__name__}).")
    return raised


def sync_campaign(
    campaign_id: str,
    now: datetime | None = None,
    *,
    settings: dict[str, Any] | None = None,
    manual: bool = False,
) -> dict[str, Any]:
    """Sync ONE request's results row (see the module docstring). Never raises for Meta's answers.

    Returns ``{campaignId, outcome, metaCalled, park, stopPass, code, alerts}``; ``outcome`` is
    ``synced``, ``error`` (``code`` = Albayan's error class), ``not_linked`` (no call), ``claimed``
    (another sync holds the row) or ``lost_claim``. ``park`` is the ad account to park, or ''.
    ``manual`` (Check Meta now) stamps ``manualCheckAt`` with the claim.
    """
    now = _aware(now or utc_now())
    out: dict[str, Any] = {"campaignId": campaign_id, "outcome": "", "metaCalled": False, "park": "", "stopPass": False,
                           "code": "", "alerts": []}
    with db_conn() as conn:
        request = load_request(conn, campaign_id)
        row, version = load_results_row(conn, campaign_id)
    ids = linked_meta_ids(request) if request else None
    if not request or not ids or str(request.get("status") or "") not in SYNCED_STATUSES:
        if row is not None and (row["nextSyncAt"] or row["syncState"] != "not_allowed"):
            _write_quietly(campaign_id, str((request or {}).get("ownerId") or row["ownerId"]),
                           {"syncState": "not_allowed", "nextSyncAt": None, "syncClaimedUntil": None}, version)
        return {**out, "outcome": "not_linked"}
    account, meta_id = ids
    claimed_until = parse_time(row["syncClaimedUntil"]) if row else None
    if claimed_until is not None and claimed_until > now:
        return {**out, "outcome": "claimed"}
    claim: dict[str, Any] = {"syncClaimedUntil": _iso(now + CLAIM_FOR), "lastAttemptAt": _iso(now)}
    if row is None or row["metaCampaignId"] != meta_id:  # a first read of this campaign: start again
        # ... and stay due: a read that never lands is tried again once the claim runs out.
        claim.update({**_FRESH, "metaCampaignId": meta_id, "metaAdAccountId": f"act_{account}", "nextSyncAt": _iso(now)})
    if manual:
        claim["manualCheckAt"] = _iso(now)
    claimed = _write_quietly(campaign_id, request["ownerId"], claim, version)
    if claimed is None:
        return {**out, "outcome": "lost_claim"}
    claim_version = int(claimed["_lastModified"])
    try:
        read = _meta.get_campaign_results(account, meta_id, request_id=campaign_id)
    except _meta.MetaAdsError as error:
        plan = _error_plan(error, now)
        _write_quietly(campaign_id, request["ownerId"], {
            "syncState": plan["state"], "lastErrorCode": _error_code(error), "nextSyncAt": _iso(plan["next"]),
            "syncClaimedUntil": None,
        }, claim_version)
        return {**out, "outcome": "error", "code": str(error.code), "metaCalled": plan["called"],
                "park": account if plan["park"] else "", "stopPass": plan["stop"]}
    except Exception as error:  # a fault of ours: free the claim at once, then let the caller see it
        _write_quietly(campaign_id, request["ownerId"], {
            "syncState": "error", "lastErrorCode": "internal", "nextSyncAt": _iso(now + RETRY_AFTER_ERROR),
            "syncClaimedUntil": None,
        }, claim_version)
        raise error
    fields, facts = fields_after_read(claimed, request, read, now, settings or read_all_settings())
    data = _write_quietly(campaign_id, request["ownerId"], fields, claim_version)
    if data is None:
        return {**out, "outcome": "lost_claim", "metaCalled": True}
    return {**out, "outcome": "synced", "metaCalled": True, "stage": facts["stage"],
            "alerts": _raise_alerts(request, data, facts, now)}


# ------------------------------------------------------------------ the pass (the jobs loop)

def approved_requests_sql() -> str:
    """The live Approved requests as ``id, last_modified`` only: no JSON is parsed for the answer. Type
    and status are literals, so PostgreSQL filters through the partial expression index
    idx_ad_campaign_requests_status (add_jsonb_indexes.py), as studio_jobs.waiting_requests_sql does."""
    return (
        f"SELECT id, last_modified FROM entities WHERE type = '{AD_CAMPAIGN_COLLECTION}' "
        f"AND deleted = false AND {json_field_sql('status')} = 'Approved'"
    )


def _approved_links(conn: Any, now: datetime) -> dict[str, tuple[str, str]]:
    """{request id: (account digits, Meta campaign id)} of the live Approved LINKED requests.

    A steady tick reads ids and versions only (approved_requests_sql). A request's own fields are
    read (its JSON parsed, images and all) only when it is new to this process, changed since (a
    new ``last_modified``), or its memo entry is ``LINK_MEMO_FOR`` old, in chunks by id.
    """
    global _LINK_MEMO
    versions = {str(row["id"]): int(row["last_modified"])
                for row in conn.execute(text(approved_requests_sql())).mappings().all()}
    memo = dict(_LINK_MEMO)
    stale = [
        request_id for request_id, version in versions.items()
        if not (request_id in memo and memo[request_id][0] == version
                and timedelta(0) <= now - memo[request_id][1] < LINK_MEMO_FOR)
    ]
    for start in range(0, len(stale), _LINK_READ_CHUNK):
        chunk = {f"i{index}": request_id for index, request_id in enumerate(stale[start:start + _LINK_READ_CHUNK])}
        where = (f"type = '{AD_CAMPAIGN_COLLECTION}' AND deleted = false "
                 f"AND id IN ({', '.join(':' + name for name in chunk)})")
        for item in conn.execute(text(json_fields_select_sql(
            ("status", "metaCampaignId", "metaAdAccountId"), ("id", "last_modified"), where,
        )), chunk).mappings().all():
            ids = linked_meta_ids({"metaCampaignId": item.get("f_metacampaignid"),
                                   "metaAdAccountId": item.get("f_metaadaccountid")})
            memo[str(item["id"])] = (int(item["last_modified"]), now,
                                     ids if str(item.get("f_status") or "") == "Approved" else None)
    _LINK_MEMO = {request_id: memo[request_id] for request_id in versions if request_id in memo}
    return {request_id: entry[2] for request_id, entry in _LINK_MEMO.items() if entry[2]}


def due_candidates(now: datetime) -> list[dict[str, Any]]:
    """The requests to read, oldest due first: ``[{campaignId, account, dueAt}]`` (claimed rows left out).

    Two reads that parse no image in a steady tick: the live Approved requests (ids and versions,
    _approved_links) and the results rows (small documents). A first read is due for an Approved
    linked request with no row for its Meta campaign, or whose row the sync STRANDED when it saw the
    request unlinked or closed (``syncState`` not_allowed, no ``nextSyncAt``): a relink of the same
    campaign reads it again.
    """
    now = _aware(now)
    with db_conn() as conn:
        approved = _approved_links(conn, now)
        rows = conn.execute(text(json_fields_select_sql(
            ("campaignId", "metaCampaignId", "metaAdAccountId", "nextSyncAt", "syncClaimedUntil", "syncState"), ("id",),
            "type = :type AND deleted = false",
        )), {"type": RESULTS_TYPE}).mappings().all()
    stored: dict[str, Any] = {}
    for item in rows:
        campaign_id = str(item.get("f_campaignid") or "")
        if campaign_id and str(item["id"]) == results_id(campaign_id):
            stored[campaign_id] = item
    due: dict[str, dict[str, Any]] = {}
    for campaign_id, (account, meta_id) in approved.items():
        item = stored.get(campaign_id)
        stranded = (item is not None and str(item.get("f_syncstate") or "") == "not_allowed"
                    and parse_time(item.get("f_nextsyncat")) is None)
        if item is not None and str(item.get("f_metacampaignid") or "") == meta_id and not stranded:
            continue  # read before: its nextSyncAt decides (below)
        claim = parse_time(item.get("f_syncclaimeduntil")) if item is not None else None
        if claim is None or claim <= now:
            due[campaign_id] = {"campaignId": campaign_id, "account": account, "dueAt": _EPOCH}  # a first read
    for campaign_id, item in stored.items():
        when = parse_time(item.get("f_nextsyncat"))
        claim = parse_time(item.get("f_syncclaimeduntil"))
        if campaign_id in due or when is None or when > now or (claim is not None and claim > now):
            continue
        account = approved[campaign_id][0] if campaign_id in approved else _account_digits(item.get("f_metaadaccountid"))
        due[campaign_id] = {"campaignId": campaign_id, "account": account, "dueAt": when}
    return sorted(due.values(), key=lambda entry: (entry["dueAt"], entry["campaignId"]))


def active_parks(now: datetime) -> dict[str, datetime]:
    """{ad account digits: parked until} for the accounts still parked at ``now``."""
    stored = studio_jobs.read_job_state().get(PARKS_FIELD)
    out: dict[str, datetime] = {}
    for account, until in (stored.items() if isinstance(stored, dict) else []):
        moment = parse_time(until)
        if _account_digits(account) and moment is not None and moment > _aware(now):
            out[_account_digits(account)] = moment
    return out


def _save_parks(parked: dict[str, datetime], now: datetime) -> None:
    def change(state: dict[str, Any]) -> dict[str, Any]:
        current = state.get(PARKS_FIELD) if isinstance(state.get(PARKS_FIELD), dict) else {}
        kept = {str(account): until for account, until in current.items() if (parse_time(until) or _EPOCH) > now}
        kept.update({account: _iso(until) for account, until in parked.items()})
        return {PARKS_FIELD: kept}

    studio_jobs.update_job_state(change)
    for account, until in parked.items():
        try:
            with db_conn() as conn:
                studio_jobs.raise_alert(conn, "results_parked", related_type="metaAdAccount", related_id=f"act_{account}",
                                        details={"until": _iso(until)}, now=now)
        except Exception as error:
            print(f"[albayan] Studio results park alert failed ({type(error).__name__}).")


def run_results_sync(
    now: datetime | None = None,
    *,
    settings: dict[str, Any] | None = None,
    max_reads: int = PASS_MAX_READS,
    max_seconds: float = PASS_MAX_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """One budgeted pass of the jobs loop: at most ``max_reads`` Meta reads, none started after
    ``max_seconds``, parked accounts skipped. Returns counts and ids (no Meta text)."""
    now = _aware(now or utc_now())
    report: dict[str, Any] = {"reads": 0, "synced": [], "errors": [], "parked": [], "skipped": ""}
    if not _meta_configured():
        return {**report, "skipped": "not_configured"}
    if _meta.studio_meta_pause_seconds():
        return {**report, "skipped": "meta_paused"}
    settings = settings or read_all_settings()
    parks = active_parks(now)
    parked_now: dict[str, datetime] = {}
    started = clock()
    for item in due_candidates(now):
        if report["reads"] >= max_reads or clock() - started >= max_seconds:
            break
        if item["account"] in parks:
            continue
        try:
            outcome = sync_campaign(item["campaignId"], now, settings=settings)
        except Exception as error:  # one broken row never stops the others
            print(f"[albayan] Studio results sync of one request failed ({type(error).__name__}).")
            report["errors"].append({"campaignId": item["campaignId"], "code": "internal"})
            continue
        report["reads"] += 1 if outcome["metaCalled"] else 0
        if outcome["outcome"] == "synced":
            report["synced"].append(item["campaignId"])
        elif outcome["outcome"] == "error":
            report["errors"].append({"campaignId": item["campaignId"], "code": outcome["code"]})
        if outcome["park"]:
            parks[outcome["park"]] = parked_now[outcome["park"]] = now + PARK_FOR
        if outcome["stopPass"]:
            report["skipped"] = "stopped"
            break
    if parked_now:
        _save_parks(parked_now, now)
    report["parked"] = sorted(parked_now)
    return report


# ------------------------------------------------------------------ staff "Check Meta now" (P3-04c)

def _check_error(code: str) -> dict[str, str]:
    return {"code": code, **CHECK_ERRORS[code]}


def check_now(campaign_id: str, now: datetime | None = None) -> dict[str, Any]:
    """One staff press: ``{outcome, cached, nextAllowedAt, checkError}``.

    ``cached`` is true when the answer shows the stored reading: a press within 10 minutes of the
    last one that reached Meta (``manualCheckAt``), Albayan's Meta pause, no Meta connection, a sync
    already running for the request, or a failed read (the claim stamped ``manualCheckAt``, so a
    retry waits its 10 minutes too).
    """
    now = _aware(now or utc_now())
    with db_conn() as conn:
        row, _version = load_results_row(conn, campaign_id)
    wait = next_manual_check_at(row, now)
    if wait:
        return {"outcome": "cached", "cached": True, "nextAllowedAt": wait, "checkError": None}
    if not _meta_configured():
        return {"outcome": "cached", "cached": True, "nextAllowedAt": None, "checkError": _check_error("META_NOT_CONFIGURED")}
    if _meta.studio_meta_pause_seconds():
        return {"outcome": "cached", "cached": True, "nextAllowedAt": None, "checkError": _check_error("META_PAUSED")}
    result = sync_campaign(campaign_id, now, manual=True)
    later = _iso(now + MANUAL_CHECK_EVERY)
    if result["outcome"] == "synced":
        return {"outcome": "synced", "cached": False, "nextAllowedAt": later, "checkError": None}
    if result["outcome"] in ("claimed", "lost_claim"):
        return {"outcome": result["outcome"], "cached": True, "nextAllowedAt": None, "checkError": _check_error("SYNC_RUNNING")}
    if result["outcome"] == "not_linked":
        return {"outcome": "not_linked", "cached": True, "nextAllowedAt": None, "checkError": _check_error("META_NOT_ALLOWED")}
    code = _CHECK_CODES.get(result["code"], "META_ERROR")
    return {"outcome": "error", "code": result["code"], "cached": True, "nextAllowedAt": later, "checkError": _check_error(code)}
