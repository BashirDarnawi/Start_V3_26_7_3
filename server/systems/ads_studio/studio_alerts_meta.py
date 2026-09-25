"""Albayan Studio's Meta watch (plan tasks P3-18a, P3-18b, P3-18c; PLAN.md §7.4, §7.1, §7.7, §8.2).

Three things the team must hear about before a customer does:

* **The Meta connection (P3-18a).** Albayan reads ads and answers comments with ONE system token.
  - ``run_meta_watch()`` runs from the studio jobs loop every 10 minutes, only while Meta is
    configured (``meta_watch_configured``): the daily token check (meta_token_health.
    daily_token_check: at most one Meta call a day), the expiry alerts ``meta_token_expiring`` at
    14/7/2 days (the ``thresholds.tokenExpiryWarnDays`` setting) before ``expires_at`` or
    ``data_access_expires_at``, ONE per threshold and expiry (an alert raised for it on any day is
    not raised again), a recheck while the connection is down, and every 6 hours the ad-account
    funds/status check below.
  - ``after_authorization_failure()``: whatever in the studio Meta refused for authorization calls
    it. It runs check_token_now(), which reaches Meta at most once per 10 minutes per process.
    Only a check that says INVALID (``is_valid`` false, or a 190 on the token itself) sets the
    global state ``meta_connection_down``; 190.492 (page role lost) and the permission codes stay
    per-page problems (``is_per_page_auth_code``) and never set it, and a check that could not run
    changes nothing. A later check that says valid clears it (recovery).
  - The state is the platform record metaHealthState/"connection" ``{state: ok|down, since,
    lastDirectCheckAt, errorCode, recoveredAt}``, written through meta_ads' door (codes and times
    only, never a token). ``/api/studio/me`` shows it as the neutral ``metaConnection`` flag with a
    bilingual banner text (``meta_connection_flag``); admins get a ``meta_connection_down`` alert
    that counts the parked replies.
* **Parked replies (P3-18b)** are kept by social_studio.py; this module answers "is it down?" and
  "when is the next check?" (``RECHECK_EVERY``).
* **Ad-account funds and status (P3-18c).** D26: studio campaigns run on the same allowlisted ad
  accounts as the agency. Each account that carries a studio campaign (an Approved, unsettled
  request linked to a Meta campaign on it) is compared with its EXPOSURE: for each such request,
  what the customer paid minus what Meta confirmed it used (``adCampaignResults.spendMinorUSD``).
  The funds come from meta_ads' stored reading (metaFundsState, refreshed every 10 minutes by the
  Meta worker); only when no reading younger than an hour exists, get_meta_account_funds() reads
  Meta (its own cache first). Per account:
  - prepaid: the funds (or the spend-cap room, when lower) below the exposure -> ``studio_funds_low``;
  - card-funded: no funds to compare; a spend cap whose room is below the exposure ->
    ``studio_funds_low``;
  - any account whose ``account_status`` is not 1 (active) -> ``studio_account_inactive``;
  - funds Meta does not show (no Full control, P0-01(n3)), a failed read or a non-USD account ->
    ``studio_funds_unreadable``.
  One alert per account, kind and Tripoli day (studio_jobs.raise_alert); requests approved but not
  linked yet cannot be placed on an account, so their total is only reported (``notLinkedMinorUSD``).
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import text

from ... import meta_ads as _meta
from ... import meta_token_health as _token_health
from ...db import db_conn, json_field_sql, json_fields_select_sql
from ...wallet_payments import campaign_hold_minor
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .social_studio import LOG_TYPE, PARKED_REASON
from .studio_diagnostics import parse_time
from .studio_results import RESULTS_TYPE, minor, results_id
from .studio_settings import read_all_settings

CONNECTION_STATE_ID = "connection"  # metaHealthState row (platform record, meta_ads door)
WATCH_EVERY = timedelta(minutes=10)  # the jobs loop's cadence for run_meta_watch
RECHECK_EVERY = timedelta(minutes=10)  # check_token_now() reaches Meta at most this often (PLAN §7.4)
FUNDS_EVERY = timedelta(hours=6)  # PLAN §7.4 "Studio account funds (P3-18c). Every 6 h"
FUNDS_READING_FRESH = timedelta(hours=1)  # a stored funds reading this young is used without a Meta call
FUNDS_MARGIN_MINOR_USD = 0  # D30 (funding float) sets a margin; until then the exposure alone
ACTIVE_ACCOUNT_STATUS = 1  # Meta account_status 1 = ACTIVE
STATE_WRITE_ATTEMPTS = 3
TOKEN_ALERT_ID = "token"

BANNER_LABELS = {
    "en": "Facebook and Instagram updates are delayed right now. The Albayan team is on it, "
          "and comment replies that are waiting are sent once it is fixed.",
    "ar": "تحديثات فيسبوك وإنستغرام متأخرة حالياً. فريق البيان يعمل على ذلك، "
          "وتُرسل الردود المنتظرة على التعليقات فور حلّه.",
}


def _jobs() -> Any:
    from . import studio_jobs  # late: studio_jobs imports this module

    return studio_jobs


def _aware(moment: datetime | None) -> datetime:
    moment = moment or datetime.now(timezone.utc)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(value: Any) -> str | None:
    moment = value if isinstance(value, datetime) else parse_time(value)
    return _aware(moment).astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if moment else None


def meta_watch_configured() -> bool:
    """True while Albayan's Meta token is set (MetaAdsConfig.configured's rule), read from the
    environment only: the jobs loop asks on every tick and must not build the Meta config for it."""
    return bool((os.getenv("ALBAYAN_META_ACCESS_TOKEN") or "").strip())


# ------------------------------------------------------------------ the connection state (P3-18a)

def connection_state() -> dict[str, Any]:
    """metaHealthState/"connection" read through today's rules (a missing or odd row reads as ok)."""
    stored = _meta.load_meta_health_state(CONNECTION_STATE_ID)
    down = stored.get("state") == "down"
    return {
        "state": "down" if down else "ok",
        "since": _iso(stored.get("since")) if down else None,
        "errorCode": _meta._clean_text(stored.get("errorCode"), 24) if down else "",
        "lastDirectCheckAt": _iso(stored.get("lastDirectCheckAt")),
        "recoveredAt": _iso(stored.get("recoveredAt")),
    }


def connection_down() -> bool:
    return connection_state()["state"] == "down"


def meta_connection_flag() -> dict[str, Any]:
    """``metaConnection`` of /api/studio/me: a neutral flag for the customer banner. No codes, times or
    token facts: ``{"down": false}``, or ``{"down": true, "labels": {"en", "ar"}}``."""
    return {"down": True, "labels": dict(BANNER_LABELS)} if connection_down() else {"down": False}


def _write_connection(change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> bool:
    """Merge ``change(stored data)`` into the connection row; nothing is written when it returns None.
    ``change`` must be pure: it runs on a first read and again inside the write's transaction."""
    if not change(dict(_meta.load_meta_health_state(CONNECTION_STATE_ID))):
        return False
    for _ in range(STATE_WRITE_ATTEMPTS):
        try:
            _meta.save_meta_health_state(CONNECTION_STATE_ID, lambda stored: {**stored, **(change(dict(stored)) or {})})
            return True
        except Exception:  # another process wrote first, or the database is away: read again
            continue
    return False


def parked_reply_count() -> int:
    """How many Social Studio replies wait for the connection (P3-18b), over every customer."""
    with db_conn() as conn:
        return int(conn.execute(
            text(
                f"SELECT COUNT(*) FROM entities WHERE type = :type AND deleted = false "
                f"AND {json_field_sql('parkedReason')} = :reason AND COALESCE({json_field_sql('retryAfter')}, '') <> ''"
            ),
            {"type": LOG_TYPE, "reason": PARKED_REASON},
        ).scalar() or 0)


def _raise_connection_alert(now: datetime) -> int:
    """The day's ``meta_connection_down`` admin alert (system: no customer), with the parked replies."""
    state = connection_state()
    try:
        parked = parked_reply_count()
    except Exception:
        parked = 0
    with db_conn() as conn:
        _jobs().raise_alert(
            conn, "meta_connection_down", related_type="metaConnection", related_id=TOKEN_ALERT_ID,
            details={"since": state["since"], "errorCode": state["errorCode"], "parkedReplies": parked}, now=now,
        )
    return parked


def apply_token_reading(reading: Any, now: datetime | None = None) -> str:
    """Set or clear ``meta_connection_down`` from one token reading; returns the state after it.

    invalid -> down (a new outage raises the admin alert); valid and checked after the outage
    began -> ok (recovery, ``recoveredAt``); unknown (no check, Meta unreachable) -> unchanged.
    """
    now = _aware(now)
    verdict = _token_health.token_verdict(reading)
    checked_at = _iso(reading.get("checkedAt")) if isinstance(reading, dict) else None
    before = connection_state()
    if verdict == "invalid":
        code = _meta._clean_text(reading.get("errorCode"), 24) or "invalid"

        def mark_down(stored: dict[str, Any]) -> dict[str, Any] | None:
            if stored.get("state") == "down":
                return {"lastDirectCheckAt": checked_at} if checked_at and stored.get("lastDirectCheckAt") != checked_at else None
            return {"state": "down", "since": checked_at or _iso(now), "errorCode": code,
                    "lastDirectCheckAt": checked_at, "recoveredAt": None}

        _write_connection(mark_down)
        if before["state"] != "down":
            print("[albayan] Studio: Albayan's Meta connection is down (the token check says invalid); replies are parked.")
            try:
                _raise_connection_alert(now)
            except Exception as error:
                print(f"[albayan] Studio connection alert failed ({type(error).__name__}).")
        return "down"
    if verdict == "valid" and before["state"] == "down":
        since, checked = parse_time(before["since"]), parse_time(checked_at)
        if checked is not None and (since is None or checked > since):

            def mark_up(stored: dict[str, Any]) -> dict[str, Any] | None:
                if stored.get("state") != "down":
                    return None
                return {"state": "ok", "recoveredAt": checked_at, "lastDirectCheckAt": checked_at, "errorCode": ""}

            _write_connection(mark_up)
            print("[albayan] Studio: Albayan's Meta connection is back; parked replies are resent.")
            return "ok"
    return before["state"]


def after_authorization_failure() -> bool:
    """Meta refused something in the studio for authorization: run the token check and apply it.

    check_token_now() reaches Meta at most once per 10 minutes per process (it hands back the saved
    reading in between). True when the connection is down afterwards; a check that cannot run
    (no app id, Meta unreachable, the database away) leaves the state as it was.
    """
    try:
        reading = _token_health.check_token_now()
    except Exception:
        return connection_down()
    return apply_token_reading(reading) == "down"


def recheck_connection() -> bool:
    """While the connection is down: one more token check (the same 10-minute limit). True while down."""
    if not connection_down():
        return False
    return after_authorization_failure()


def is_per_page_auth_code(code: Any) -> bool:
    """Meta authorization refusals that concern one page, never the whole connection: 190.492 (the
    page role was lost), the permission family (3, 10, 200-299) and a page Albayan's token got no
    page token for (no code). PLAN §7.4: these stay per-page health reasons."""
    major, _dot, sub = str(code or "").strip().partition(".")
    if not major:
        return True
    if major == "190":
        return sub == "492"
    if major in {"3", "10"}:
        return True
    return major.isdigit() and 200 <= int(major) <= 299


# ------------------------------------------------------------------ expiry alerts (P3-18a)

def _alert_raised_before(conn: Any, kind: str, related_id: str) -> bool:
    return conn.execute(
        text(
            f"SELECT 1 FROM entities WHERE type = :type AND {json_field_sql('kind')} = :kind "
            f"AND {json_field_sql('relatedId')} = :related LIMIT 1"
        ),
        {"type": _jobs().ALERTS_TYPE, "kind": kind, "related": related_id},
    ).first() is not None


def raise_expiry_alerts(reading: Any, now: datetime | None = None, warn_days: Any = None) -> list[str]:
    """``meta_token_expiring`` once per threshold (14/7/2 days by default) and expiry; returns the
    related ids raised now. A refreshed token has a new expiry, so its warnings start again."""
    now = _aware(now)
    days = _token_health.EXPIRY_WARN_DAYS if warn_days is None else warn_days
    raised: list[str] = []
    for warning in _token_health.expiry_warnings(reading, days, now.timestamp()):
        related = f"{warning['field']}:{warning['expiresAt']}:{warning['thresholdDays']}d"
        with db_conn() as conn:
            if _alert_raised_before(conn, "meta_token_expiring", related):
                continue
            _jobs().raise_alert(conn, "meta_token_expiring", related_type="metaToken", related_id=related,
                                details=dict(warning), now=now)
        raised.append(related)
    return raised


# ------------------------------------------------------------------ ad-account funds and status (P3-18c)

def studio_account_exposure(conn: Any) -> tuple[dict[str, dict[str, int]], int]:
    """({account digits: {exposureMinorUSD, campaigns}}, total of Approved requests not linked yet).

    Only Approved, live (not archived) requests without a ``settleBasis``; exposure = what the
    customer paid (``paidMinorUSD``, else the request's total, as the link's budget check reads it)
    minus the spend Meta confirmed for that same Meta campaign, never below 0.
    """
    where = f"type = '{AD_CAMPAIGN_COLLECTION}' AND deleted = false AND {json_field_sql('status')} = 'Approved'"
    rows = conn.execute(text(json_fields_select_sql(
        ("status", "metaAdAccountId", "metaCampaignId", "settleBasis", "paidMinorUSD", "totalBudgetMinorUSD",
         "budgetMinorUSD"),
        ("id",), where,
    ))).mappings().all()
    spend: dict[str, tuple[str, int]] = {}
    results = conn.execute(text(json_fields_select_sql(
        ("campaignId", "metaCampaignId", "spendMinorUSD"), ("id",), "type = :type AND deleted = false",
    )), {"type": RESULTS_TYPE}).mappings().all()
    for row in results:
        campaign_id = str(row.get("f_campaignid") or "")
        if campaign_id and str(row["id"]) == results_id(campaign_id):
            spend[campaign_id] = (str(row.get("f_metacampaignid") or ""), minor(row.get("f_spendminorusd")))
    accounts: dict[str, dict[str, int]] = {}
    not_linked = 0
    for row in rows:
        if str(row.get("f_status") or "") != "Approved" or str(row.get("f_settlebasis") or "").strip():
            continue
        paid = minor(row.get("f_paidminorusd")) or campaign_hold_minor(
            {"totalBudgetMinorUSD": row.get("f_totalbudgetminorusd"), "budgetMinorUSD": row.get("f_budgetminorusd")}
        )
        account = str(row.get("f_metaadaccountid") or "").strip()
        account = account[4:] if account.startswith("act_") else account
        meta_campaign = str(row.get("f_metacampaignid") or "").strip()
        if not (account.isascii() and account.isdigit() and meta_campaign):
            not_linked += paid
            continue
        linked_campaign, used = spend.get(str(row["id"]), ("", 0))
        item = accounts.setdefault(account, {"exposureMinorUSD": 0, "campaigns": 0})
        item["exposureMinorUSD"] += max(paid - (used if linked_campaign == meta_campaign else 0), 0)
        item["campaigns"] += 1
    return accounts, not_linked


def read_studio_funds(now: datetime | None = None) -> dict[str, dict[str, Any]]:
    """{account digits: meta_ads funds row}: the stored reading while it is younger than an hour,
    else get_meta_account_funds() (its own cache first; None when a read is already running, then
    the stored reading stays the answer)."""
    now = _aware(now)
    stored = _meta._load_funds_state()
    rows = stored.get("accounts") if isinstance(stored.get("accounts"), list) else []
    updated = parse_time(stored.get("updatedAt"))
    if updated is None or not timedelta(0) <= now - updated < FUNDS_READING_FRESH:
        try:
            fresh = _meta.get_meta_account_funds(refresh=False, interactive=False)
        except Exception:  # not configured, Meta refused or away: the stored reading is the answer
            fresh = None
        if fresh and isinstance(fresh.get("accounts"), list):
            rows = fresh["accounts"]
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        account = str(row.get("id") or "").strip() if isinstance(row, dict) else ""
        account = account[4:] if account.startswith("act_") else account
        if account.isascii() and account.isdigit():
            out[account] = row
    return out


def _whole_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return max(int(value), 0)
    except (TypeError, ValueError, OverflowError):
        return None


def account_findings(exposure_minor: int, row: Any) -> list[tuple[str, dict[str, Any]]]:
    """Pure: the alerts one account's funds row raises against its exposure, as (kind, details)."""
    if not isinstance(row, dict):
        return [("studio_funds_unreadable", {"reason": "not_read"})]
    if str(row.get("error") or ""):
        # Meta was busy ("waiting"): read again later, not a finding.
        return [] if row.get("waiting") else [("studio_funds_unreadable", {"reason": "read_error"})]
    found: list[tuple[str, dict[str, Any]]] = []
    status = _whole_or_none(row.get("status"))
    if status and status != ACTIVE_ACCOUNT_STATUS:
        found.append(("studio_account_inactive", {"accountStatus": status}))
    currency = str(row.get("currency") or "").strip().upper()
    if currency and currency != "USD":
        return found + [("studio_funds_unreadable", {"reason": "currency_not_usd", "currency": currency[:12]})]
    funds = _whole_or_none(row.get("fundsMinor"))
    cap_room = _whole_or_none(row.get("capRemainingMinor"))
    prepaid = row.get("isPrepay") is True or (row.get("isPrepay") is None and funds is not None)
    room: list[tuple[int, str]] = [] if cap_room is None else [(cap_room, "spend_cap")]
    if prepaid and funds is not None:
        room.append((funds, "prepaid_funds"))
    elif prepaid or row.get("isPrepay") is None:  # Meta did not show the funds (Full control is needed)
        found.append(("studio_funds_unreadable", {"reason": "funds_hidden" if row.get("fundsHidden") else "funding_unknown"}))
    need = int(exposure_minor) + FUNDS_MARGIN_MINOR_USD
    if room and min(room)[0] < need:
        available, basis = min(room)
        found.append(("studio_funds_low", {"basis": basis, "availableMinor": available, "neededMinorUSD": need}))
    return found


def check_studio_accounts(now: datetime | None = None) -> dict[str, Any]:
    """P3-18c: the funds/status alerts of the ad accounts that carry studio campaigns."""
    now = _aware(now)
    with db_conn() as conn:
        exposure, not_linked = studio_account_exposure(conn)
    if not exposure:
        return {"accounts": 0, "alerts": []}
    rows = read_studio_funds(now)
    raised: list[dict[str, str]] = []
    for account, item in sorted(exposure.items()):
        row = rows.get(account)
        for kind, extra in account_findings(item["exposureMinorUSD"], row):
            details = {
                "account": f"act_{account}", "exposureMinorUSD": item["exposureMinorUSD"], "campaigns": item["campaigns"],
                "notLinkedMinorUSD": not_linked, "readAt": _iso((row or {}).get("readAt")) if isinstance(row, dict) else None,
                "stale": bool(isinstance(row, dict) and row.get("stale")), **extra,
            }
            with db_conn() as conn:
                _jobs().raise_alert(conn, kind, related_type="metaAdAccount", related_id=f"act_{account}",
                                    count=item["campaigns"], details=details, now=now)
            raised.append({"kind": kind, "account": f"act_{account}"})
    return {"accounts": len(exposure), "alerts": raised}


def _claim_funds_check(now: datetime) -> bool:
    """The 6-hour turn of the funds check, claimed in the jobs state row (one process wins)."""
    jobs = _jobs()
    at = _iso(now)

    def claim(state: dict[str, Any]) -> dict[str, Any] | None:
        return {"lastFundsCheckAt": at} if jobs._due(state.get("lastFundsCheckAt"), FUNDS_EVERY, now) else None

    return jobs.update_job_state(claim) is not None


# ------------------------------------------------------------------ the jobs loop's Meta watch

def run_meta_watch(now: datetime | None = None, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """One turn of the Meta watch (the studio jobs loop, every 10 minutes while Meta is configured)."""
    now = _aware(now)
    if not meta_watch_configured():
        return {"skipped": "meta_not_configured"}
    settings = settings or read_all_settings()
    reading = _token_health.daily_token_check(now.timestamp())
    if connection_down():
        try:  # recovery: the same 10-minute limit as every other check
            reading = _token_health.check_token_now()
        except Exception:
            pass
    state = apply_token_reading(reading, now)
    out: dict[str, Any] = {
        "token": _token_health.token_verdict(reading),
        "connection": state,
        "expiryAlerts": raise_expiry_alerts(reading, now, settings["thresholds"]["tokenExpiryWarnDays"]),
    }
    if state == "down":
        out["parkedReplies"] = _raise_connection_alert(now)
    if _claim_funds_check(now):
        out["funds"] = check_studio_accounts(now)
    return out
