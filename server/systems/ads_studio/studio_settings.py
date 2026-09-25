"""Albayan Studio switches and service settings (plan task P0-04, PLAN.md §7.1 studioSettings, §12.2 switches).

Each setting is one ``studioSettings`` record in the entities table, found by a fixed id
(``derived_id("sts", key)``). A record keeps the current value and a version number; every save
must name the version it read (``expectedVersion``), so two admins can never overwrite each
other without seeing it (409). Every save writes its audit entry (action ``studio_setting``,
the value before and after) in the SAME transaction: both are kept or neither is. A record
that was soft-deleted (an admin restore, a batch delete) reads as never saved (version 0), and
the next save with ``expectedVersion`` 0 brings the same row back.

Keys (anything else is refused):

* ``rollout``: ``ui`` (customer layout ``off|pilot|on`` + ``uiAllowlist`` of user ids),
  ``services`` (``help``, ``stopRequest``, ``tiktok``: each ``off|pilot|on``, shown in BOTH
  layouts; ``pilot`` = only the users in ``uiAllowlist``; a stored or sent true/false from the
  first shape reads as on/off), ``staffDesk`` (``off|pilot|on`` + ``staffAllowlist``; its own
  switch, independent of the customer layout and of the env kill switch; it cannot go off while
  open tickets or stop requests exist: 409 STAFF_DESK_IN_USE, P3-20).
* ``intake``: ``open`` (new submissions allowed) and ``maxSubmissionsPerDay`` (1-500).
* ``capabilities``: the PLAN.md §7.1 labels ``fbPublicReply``, ``fbPrivateReply``,
  ``igPublicReply``, ``igPrivateReply``, ``tiktokService``, each ``on|gated|off|unavailable``;
  ``poll`` (Instagram road 1) is allowed only for ``igPublicReply``.
* ``limits`` (PLAN.md adLimits; D4 + D5): ``minTotalMinorUSD`` / ``maxTotalMinorUSD`` (the total
  a customer pays for one request: the lifetime amount, or daily x days), ``minPerDayMinorUSD``
  (the per-day floor), ``maxDays`` (1-90, the durationDays range) and ``p1CutoverAt`` (a time
  with its zone, or null until the P1 release stamps it, P1-18). Always minimum total <= maximum
  total, and per-day floor <= minimum total.
* ``settlement`` (D28): ``spendDelayHours`` (0-168; the wait after delivery ends),
  ``neverDeliveredImmediate`` and ``driftWatchDays`` (1-90; it must outlast the wait: days x 24 >
  hours, equal is refused).
* ``hours`` (D11): the working-hours calendar, always read in ``Africa/Tripoli`` time. ``week``
  (per weekday ``{open, close}`` as HH:MM, or null = closed; at least one working day),
  ``holidays`` (``{date, labelEn, labelAr}``, ISO dates, labels optional), ``ramadan`` (null or
  one ``{from, to, open, close}`` window that replaces the hours of the working days) and
  ``onDutyUntil`` (HH:MM or null: until when the urgent line answers stop requests, D29).
* ``contact``: ``whatsapp``, ``phone``, ``email`` (shown to customers) and ``urgentWhatsapp``
  (the on-duty line, shown only in the after-hours stop-request answer). Each is optional;
  numbers are kept in international form (+218...), never as free text or HTML.
* ``targets`` (D11): the working time each queue may take (reviews, first ticket answers, stop
  requests, payment confirmations, settlements, TikTok requests). An urgent stop request may
  never be given longer than an ordinary ticket.
* ``thresholds`` (D32): the pilot go/no-go numbers of PLAN.md §12.8 and the Meta token alert days
  of §7.1 (see ``DEFAULTS``).

There is no ``studio-accounts`` key: owner decision D26 (2026-09-24) keeps studio ads on the SAME
ad accounts as the agency (no dedicated Studio ad account), so PLAN.md's ``studioAccounts`` list
and its ``STUDIO_ACCOUNTS_MISMATCH`` check are not built.

Safe defaults (used until an admin saves, and for any stored field that is unreadable):
everything off / classic, intake open with a cap of 500 (in effect no cap until the owner decides
D29), capabilities, limits, hours, targets and thresholds as in ``DEFAULTS`` below, no contact
details. A stored value is always read back through today's rules (``normalise_stored``), so a
hand-edited row never reaches a customer.

Env kill switch ``ALBAYAN_STUDIO_V2`` (read on every request): ``off`` (also when unset or
misspelt) forces the classic customer layout whatever the record says; ``pilot`` allows the new
layout only for the allowlist; ``on`` follows the record. It never touches services or the
staff desk, so switching the layout back to classic never hides a ticket or the staff queue
(PLAN.md §12.2(b)).
"""

import copy
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ...db import db_conn, json_dumps, json_loads, now_ms
from .ad_campaign_fields import MAX_AD_CAMPAIGN_BUDGET_MINOR_USD
from .studio_errors import studio_error
from .studio_types import STUDIO_SETTINGS_TYPE, derived_id, looks_like_user_id

ENV_SWITCH = "ALBAYAN_STUDIO_V2"
MODES = ("off", "pilot", "on")
# No "studio-accounts": D26 = the same ad accounts, no dedicated Studio account (see the docstring).
SETTING_KEYS = ("rollout", "intake", "capabilities", "limits", "settlement", "hours", "contact", "targets", "thresholds")
SERVICE_NAMES = ("help", "stopRequest", "tiktok")
CAPABILITY_STATES = ("on", "gated", "off", "unavailable")
# channel -> the states it may take (poll = "checked every few minutes", Instagram road 1 only)
CAPABILITY_CHANNELS: dict[str, tuple[str, ...]] = {
    "fbPublicReply": CAPABILITY_STATES,
    "fbPrivateReply": CAPABILITY_STATES,
    "igPublicReply": ("on", "poll", "gated", "off", "unavailable"),
    "igPrivateReply": CAPABILITY_STATES,
    "tiktokService": CAPABILITY_STATES,
}
MAX_ALLOWLIST = 200
MIN_SUBMISSIONS_PER_DAY = 1
MAX_SUBMISSIONS_PER_DAY = 500
MAX_DURATION_DAYS = 90  # the durationDays field range, 1-90 (PLAN.md §7.1)
SERVICE_TIMEZONE = "Africa/Tripoli"
WEEKDAYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
DAY_HOURS_FIELDS = ("open", "close")
RAMADAN_FIELDS = ("from", "to", "open", "close")
HOLIDAY_FIELDS = ("date", "labelEn", "labelAr")
MAX_HOLIDAYS = 60
MAX_LABEL_CHARS = 60
# What /api/studio/me shows every signed-in user (nothing private, nothing staff-only). The budget
# form checks the same limits the server enforces (PLAN.md §7.3, P1-08b, P1-15), per-day floor
# included; only p1CutoverAt (a release stamp) stays out.
PUBLIC_LIMIT_FIELDS = ("minTotalMinorUSD", "maxTotalMinorUSD", "minPerDayMinorUSD", "maxDays")
PUBLIC_CONTACT_FIELDS = ("whatsapp", "phone", "email")

_WORKDAY = {"open": "09:00", "close": "17:00"}

DEFAULTS: dict[str, dict[str, Any]] = {
    "rollout": {
        "ui": "off",
        "uiAllowlist": [],
        "services": {"help": "off", "stopRequest": "off", "tiktok": "off"},
        "staffDesk": "off",
        "staffAllowlist": [],
    },
    # MAX_SUBMISSIONS_PER_DAY (500) = effectively no cap: until the owner decides D29 (plan start value 5).
    # The cap applies to the live classic studio as soon as the image deploys; saved values are unaffected.
    "intake": {"open": True, "maxSubmissionsPerDay": MAX_SUBMISSIONS_PER_DAY},
    # Honest labels until the facts are in (PLAN.md §8.2, DECISIONS D8a, D24b, D34):
    # * fbPublicReply gated ("waiting for Meta"): it works only after fact P0-01(g) proves
    #   delivery to commenters without an app role and the page is subscribed; if (g) fails,
    #   D24b (a) keeps this label.
    # * fbPrivateReply, igPrivateReply unavailable: Business Verification is postponed (D8a),
    #   so nothing is waiting at Meta and private messages are "not available now", not gated.
    # * igPublicReply unavailable: no approval is pending (D8a, D34 (a)); an admin sets poll
    #   only after the road 1 test P0-01(w) passes.
    # * tiktokService off: a manual service run by the team (§8.4), not blocked by any platform,
    #   so neither gated nor unavailable fits; it stays off until the owner opens it (TikTok is
    #   hidden in Preview A, §12.3).
    "capabilities": {
        "fbPublicReply": "gated",
        "fbPrivateReply": "unavailable",
        "igPublicReply": "unavailable",
        "igPrivateReply": "unavailable",
        "tiktokService": "off",
    },
    # D4 + D5 (owner, 2026-09-24): the total a customer pays for one request is $5 - $2,000. The
    # per-day floor is $1 until fact P0-01(f) reads Meta's min_daily_budget for the ad accounts.
    "limits": {
        "minTotalMinorUSD": 500,
        "maxTotalMinorUSD": 200_000,
        "minPerDayMinorUSD": 100,
        "maxDays": MAX_DURATION_DAYS,
        "p1CutoverAt": None,
    },
    # D28 (a): settle 48 h after delivery ends, never-delivered ads at once, and watch for spend
    # changes to day 28 (Meta says its numbers are final after 28 days).
    "settlement": {"spendDelayHours": 48, "neverDeliveredImmediate": True, "driftWatchDays": 28},
    # D11 [ASSUMPTION until the owner confirms days, hours, Ramadan hours and holidays]: Sun-Thu
    # 09:00-17:00 Tripoli time. onDutyUntil stays null until the owner names the on-duty person
    # and number (D29 recommends 23:00).
    "hours": {
        "timezone": SERVICE_TIMEZONE,
        "week": {day: (dict(_WORKDAY) if day in ("sun", "mon", "tue", "wed", "thu") else None) for day in WEEKDAYS},
        "holidays": [],
        "ramadan": None,
        "onDutyUntil": None,
    },
    # Nothing is shown to customers until the owner gives the numbers (D16, D23).
    "contact": {"whatsapp": None, "phone": None, "email": None, "urgentWhatsapp": None},
    # D11: review <= 1 business day; first ticket answer <= 4 working hours; stop request <= 2;
    # payment confirmation <= 4 (admin); settlement <= 2 business days after the final Meta read
    # (settleReadDueAt); TikTok <= 1 business day. Minutes count only inside ``hours`` (P3-16).
    "targets": {
        "reviewBusinessDays": 1,
        "ticketFirstResponseMinutes": 240,
        "stopRequestMinutes": 120,
        "paymentConfirmMinutes": 240,
        "settlementBusinessDays": 2,
        "tiktokBusinessDays": 1,
    },
    # D32 (recommendation "as proposed" until the owner answers): the numbers of PLAN.md §12.8 and
    # the token alert days of §7.1. The zero-tolerance rows (integrity violations, refunds above
    # the cap without an override, comments lost to a token outage, an open money incident, a
    # wallet identity break, a duplicate charge, a studio ad in the core books) are fixed rules,
    # never numbers an admin could loosen, so they are not stored. The storage and funds-margin
    # alert numbers arrive with the storage read and D30 (P3), which define them.
    "thresholds": {
        "goConsecutiveWeeks": 2,               # every go row green this many weeks in a row
        "reconcileToleranceMinorUSD": 500,     # reconciliation difference <= max($5, ...
        "reconcileToleranceBasisPoints": 100,  # ... 1% of the month's studio spend); 100 bp = 1%
        "queueOnTargetPercent": 90,            # reviews, stop requests, payments on target (+ §12.3 widening)
        "resultsFreshPercent": 90,             # linked ads checked less than ...
        "resultsFreshHours": 6,                # ... this many hours ago
        "webhookReplyP95Seconds": 120,
        "pollReplyP95Seconds": 600,
        "replyFailureMaxPercent": 5,           # reply failures stay below this (gated channels excluded)
        "restoreProofMaxDays": 7,              # a restore proven within the last N days
        "tokenMinDaysLeft": 14,                # Meta token valid with more than N days left
        "strandedCaptureMaxMinutes": 60,       # stop rule: "Being returned" older than this
        "replyOutageMaxHours": 6,              # stop rule: comment replies down longer than this
        "heartbeatLateMaxMinutes": 15,         # stop rule: studio jobs heartbeat late by more
        "tokenExpiryWarnDays": [14, 7, 2],     # alerts before the Meta token expires
    },
}


def env_switch() -> str:
    """The kill switch value now: off, pilot or on (unset or unknown = off, the safe side)."""
    value = str(os.environ.get(ENV_SWITCH) or "").strip().lower()
    return value if value in MODES else "off"


def setting_id(key: str) -> str:
    return derived_id("sts", key)


def default_value(key: str) -> dict[str, Any]:
    return copy.deepcopy(DEFAULTS[key])


def require_known_key(key: str) -> str:
    if key not in DEFAULTS:
        studio_error(404, "UNKNOWN_SETTING", f"Unknown studio setting '{str(key)[:40]}'. Known: {', '.join(SETTING_KEYS)}")
    return key


# ---------------------------------------------------------------- validation

Rule = Callable[[str, Any], Any]

_CLOCK_RE = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_INSTANT_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_YEARS = (2020, 2100)
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_PHONE_RE = re.compile(r"\+[1-9][0-9]{7,14}")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}")
_UNSAFE_TEXT_RE = re.compile(r"[<>\x00-\x1f\x7f]")  # no HTML, no control characters


def _bad(field: str, rule: str) -> None:
    studio_error(400, "INVALID_VALUE", f"{field} {rule}")


def _unknown(field: str, allowed: Any) -> None:
    studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{str(field)[:40]}'. Allowed: {', '.join(allowed)}")


def _mode(field: str, value: Any) -> str:
    if not isinstance(value, str) or value not in MODES:
        _bad(field, "must be one of: off, pilot, on")
    return value


def _flag(field: str, value: Any) -> bool:
    if not isinstance(value, bool):
        _bad(field, "must be true or false")
    return value


def _service_mode(field: str, value: Any) -> str:
    if isinstance(value, bool):  # the first shape stored true/false
        return "on" if value else "off"
    return _mode(field, value)


def _whole(field: str, value: Any, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        _bad(field, f"must be a whole number from {low} to {high}")
    return value


def _whole_rule(low: int, high: int) -> Rule:
    return lambda field, value: _whole(field, value, low, high)


def _clock(field: str, value: Any) -> str:
    if not isinstance(value, str) or not _CLOCK_RE.fullmatch(value):
        _bad(field, "must be a time of day as HH:MM (00:00 to 23:59)")
    return value


def _clock_or_null(field: str, value: Any) -> str | None:
    return None if value is None else _clock(field, value)


def _day(field: str, value: Any) -> str:
    try:
        ok = isinstance(value, str) and bool(_DATE_RE.fullmatch(value)) and _YEARS[0] <= date.fromisoformat(value).year <= _YEARS[1]
    except ValueError:
        ok = False
    if not ok:
        _bad(field, f"must be a date as YYYY-MM-DD between {_YEARS[0]} and {_YEARS[1]}")
    return value


def _instant_or_null(field: str, value: Any) -> str | None:
    """null, or a moment with its zone (Z or +hh:mm), kept in UTC as 2026-10-01T08:00:00.000Z."""
    if value is None:
        return None
    moment = None
    if isinstance(value, str) and _INSTANT_RE.fullmatch(value):
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        except (ValueError, OverflowError):  # OverflowError: year 1 or 9999 moved past the calendar by its zone
            moment = None
    if moment is None or not _YEARS[0] <= moment.year <= _YEARS[1]:
        _bad(field, "must be null or a time with its zone, such as 2026-10-01T08:00:00Z")
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _label(field: str, value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value.strip()) > MAX_LABEL_CHARS or _UNSAFE_TEXT_RE.search(value):
        _bad(field, f"must be plain text of at most {MAX_LABEL_CHARS} characters (no < or >)")
    return value.strip()


def _phone(field: str, value: Any) -> str | None:
    """Empty = not shown. Arabic digits, spaces, dots, dashes and brackets are accepted and
    removed; 00 becomes +. The result must be an international number (E.164)."""
    if value is None or value == "":
        return None
    number = ""
    if isinstance(value, str) and len(value) <= 32:
        number = re.sub(r"[\s().-]", "", value.translate(_ARABIC_DIGITS))
        number = "+" + number[2:] if number.startswith("00") else number
    if not _PHONE_RE.fullmatch(number):
        _bad(field, "must be empty or an international number such as +218912345678")
    return number


def _email(field: str, value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value.strip()) > 254 or not _EMAIL_RE.fullmatch(value.strip()):
        _bad(field, "must be empty or an e-mail address such as help@albayanhub.com")
    return value.strip()


def _allowlist(field: str, value: Any, id_validator: Callable[[Any], str] | None) -> list[str]:
    if not isinstance(value, list):
        _bad(field, "must be a list of user ids")
    if len(value) > MAX_ALLOWLIST:
        _bad(field, f"may hold at most {MAX_ALLOWLIST} user ids")
    for item in value:
        ok = isinstance(item, str) and looks_like_user_id(item)
        if ok and id_validator is not None:
            try:
                id_validator(item)
            except Exception:
                ok = False
        if not ok:
            _bad(field, "must hold user ids only (letters, numbers, dot, underscore, colon or hyphen)")
    return list(dict.fromkeys(value))  # repeats dropped, first order kept


def _fields(rules: dict[str, Rule], check: Callable[[dict[str, Any]], None] | None = None) -> Callable[..., None]:
    """The applier of a flat record: one rule per field, then ``check`` on the whole result (so
    a partial change is tested against the fields it did not send)."""

    def apply(current: dict[str, Any], raw: dict[str, Any], _id_validator: Any) -> None:
        for field, value in raw.items():
            rule = rules.get(field)
            if rule is None:
                _unknown(field, rules)
            current[field] = rule(field, value)
        if check is not None:
            check(current)

    return apply


def _apply_rollout(current: dict[str, Any], raw: dict[str, Any], id_validator: Callable[[Any], str] | None) -> None:
    for field, value in raw.items():
        if field in ("ui", "staffDesk"):
            # staffDesk "off" while open tickets or stop requests exist is refused by save_setting
            # (refuse_desk_off_while_in_use, P3-20): it needs the database, this rule does not.
            current[field] = _mode(field, value)
        elif field in ("uiAllowlist", "staffAllowlist"):
            current[field] = _allowlist(field, value, id_validator)
        elif field == "services":
            if not isinstance(value, dict):
                _bad("services", "must be an object")
            services = dict(current.get("services") or {})
            for name, flag in value.items():
                if name not in SERVICE_NAMES:
                    _unknown(f"services.{name}", SERVICE_NAMES)
                services[name] = _service_mode(f"services.{name}", flag)
            current["services"] = services
        else:
            _unknown(field, DEFAULTS["rollout"])


def _apply_capabilities(current: dict[str, Any], raw: dict[str, Any], _id_validator: Any) -> None:
    for field, value in raw.items():
        allowed = CAPABILITY_CHANNELS.get(field)
        if allowed is None:
            _unknown(field, CAPABILITY_CHANNELS)
        if not isinstance(value, str) or value not in allowed:
            _bad(field, "must be one of: " + ", ".join(allowed))
        current[field] = value


def _limits_check(value: dict[str, Any]) -> None:
    if value["minTotalMinorUSD"] > value["maxTotalMinorUSD"]:
        _bad("minTotalMinorUSD", "must not be above maxTotalMinorUSD")
    if value["minPerDayMinorUSD"] > value["minTotalMinorUSD"]:
        _bad("minPerDayMinorUSD", "must not be above minTotalMinorUSD")


def _settlement_check(value: dict[str, Any]) -> None:
    if value["driftWatchDays"] * 24 <= value["spendDelayHours"]:
        _bad("driftWatchDays", "must last longer than spendDelayHours (the spend watch outlives the wait)")


def _targets_check(value: dict[str, Any]) -> None:
    if value["stopRequestMinutes"] > value["ticketFirstResponseMinutes"]:
        _bad("stopRequestMinutes", "must not be above ticketFirstResponseMinutes (a stop request is urgent)")


def _warn_days(field: str, value: Any) -> list[int]:
    if not isinstance(value, list) or not 1 <= len(value) <= 5:
        _bad(field, "must be a list of 1 to 5 day counts")
    return sorted({_whole(field, item, 1, 60) for item in value}, reverse=True)


def _day_hours(field: str, value: Any) -> dict[str, str] | None:
    """null = closed all day; otherwise ``{open, close}`` on the same day (no overnight shifts)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        _bad(field, "must be null (closed) or {open, close}")
    for name in value:
        if name not in DAY_HOURS_FIELDS:
            _unknown(f"{field}.{name}", DAY_HOURS_FIELDS)
    opens = _clock(f"{field}.open", value.get("open"))
    closes = _clock(f"{field}.close", value.get("close"))
    if opens >= closes:
        _bad(field, "must close later on the same day than it opens")
    return {"open": opens, "close": closes}


def _ramadan(field: str, value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        _bad(field, "must be null or {from, to, open, close}")
    for name in value:
        if name not in RAMADAN_FIELDS:
            _unknown(f"{field}.{name}", RAMADAN_FIELDS)
    first = _day(f"{field}.from", value.get("from"))
    last = _day(f"{field}.to", value.get("to"))
    if not 0 <= (date.fromisoformat(last) - date.fromisoformat(first)).days <= 30:
        _bad(field, "must end on or after its first day and last at most 31 days")
    hours = _day_hours(field, {"open": value.get("open"), "close": value.get("close")})
    return {"from": first, "to": last, "open": hours["open"], "close": hours["close"]}


def _holidays(field: str, value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or len(value) > MAX_HOLIDAYS:
        _bad(field, f"must be a list of at most {MAX_HOLIDAYS} days")
    clean: dict[str, dict[str, str]] = {}
    for index, item in enumerate(value):
        where = f"{field}[{index}]"
        if not isinstance(item, dict):
            _bad(where, "must be {date, labelEn, labelAr}")
        for name in item:
            if name not in HOLIDAY_FIELDS:
                _unknown(f"{where}.{name}", HOLIDAY_FIELDS)
        day = _day(f"{where}.date", item.get("date"))
        if day in clean:
            _bad(where, f"repeats the date {day}")
        clean[day] = {
            "date": day,
            "labelEn": _label(f"{where}.labelEn", item.get("labelEn")),
            "labelAr": _label(f"{where}.labelAr", item.get("labelAr")),
        }
    return [clean[day] for day in sorted(clean)]


def _apply_hours(current: dict[str, Any], raw: dict[str, Any], _id_validator: Any) -> None:
    for field, value in raw.items():
        if field == "timezone":
            if value != SERVICE_TIMEZONE:
                _bad("timezone", f"is fixed to {SERVICE_TIMEZONE}")
        elif field == "week":  # a partial week changes only the days it names
            if not isinstance(value, dict):
                _bad("week", "must be an object of weekdays (sun to sat)")
            week = dict(current.get("week") or {})
            for day, hours in value.items():
                if day not in WEEKDAYS:
                    _unknown(f"week.{day}", WEEKDAYS)
                week[day] = _day_hours(f"week.{day}", hours)
            current["week"] = week
        elif field == "holidays":
            current["holidays"] = _holidays("holidays", value)
        elif field == "ramadan":
            current["ramadan"] = _ramadan("ramadan", value)
        elif field == "onDutyUntil":
            current["onDutyUntil"] = _clock_or_null("onDutyUntil", value)
        else:
            _unknown(field, DEFAULTS["hours"])
    if not any((current.get("week") or {}).get(day) for day in WEEKDAYS):
        _bad("week", "must keep at least one working day")


_APPLY: dict[str, Callable[..., None]] = {
    "rollout": _apply_rollout,
    "intake": _fields({"open": _flag, "maxSubmissionsPerDay": _whole_rule(MIN_SUBMISSIONS_PER_DAY, MAX_SUBMISSIONS_PER_DAY)}),
    "capabilities": _apply_capabilities,
    "limits": _fields(
        {
            "minTotalMinorUSD": _whole_rule(100, MAX_AD_CAMPAIGN_BUDGET_MINOR_USD),
            "maxTotalMinorUSD": _whole_rule(100, MAX_AD_CAMPAIGN_BUDGET_MINOR_USD),
            "minPerDayMinorUSD": _whole_rule(1, MAX_AD_CAMPAIGN_BUDGET_MINOR_USD),
            "maxDays": _whole_rule(1, MAX_DURATION_DAYS),
            "p1CutoverAt": _instant_or_null,
        },
        _limits_check,
    ),
    "settlement": _fields(
        {"spendDelayHours": _whole_rule(0, 168), "neverDeliveredImmediate": _flag, "driftWatchDays": _whole_rule(1, 90)},
        _settlement_check,
    ),
    "hours": _apply_hours,
    "contact": _fields({"whatsapp": _phone, "phone": _phone, "email": _email, "urgentWhatsapp": _phone}),
    "targets": _fields(
        {
            "reviewBusinessDays": _whole_rule(1, 10),
            "ticketFirstResponseMinutes": _whole_rule(15, 2400),
            "stopRequestMinutes": _whole_rule(15, 480),
            "paymentConfirmMinutes": _whole_rule(15, 2400),
            "settlementBusinessDays": _whole_rule(1, 10),
            "tiktokBusinessDays": _whole_rule(1, 10),
        },
        _targets_check,
    ),
    "thresholds": _fields(
        {
            "goConsecutiveWeeks": _whole_rule(1, 8),
            "reconcileToleranceMinorUSD": _whole_rule(0, 100_000),
            "reconcileToleranceBasisPoints": _whole_rule(0, 1000),
            "queueOnTargetPercent": _whole_rule(50, 100),
            "resultsFreshPercent": _whole_rule(50, 100),
            "resultsFreshHours": _whole_rule(1, 48),
            "webhookReplyP95Seconds": _whole_rule(10, 3600),
            "pollReplyP95Seconds": _whole_rule(60, 7200),
            "replyFailureMaxPercent": _whole_rule(0, 50),
            "restoreProofMaxDays": _whole_rule(1, 30),
            "tokenMinDaysLeft": _whole_rule(1, 60),
            "strandedCaptureMaxMinutes": _whole_rule(5, 1440),
            "replyOutageMaxHours": _whole_rule(1, 72),
            "heartbeatLateMaxMinutes": _whole_rule(5, 240),
            "tokenExpiryWarnDays": _warn_days,
        }
    ),
}


def validate_setting(
    key: str,
    raw: Any,
    current: dict[str, Any] | None = None,
    id_validator: Callable[[Any], str] | None = None,
) -> dict[str, Any]:
    """``current`` changed by the fields in ``raw`` (a partial object is fine). Every field is
    checked, then the rules between fields; one bad or unknown field refuses the whole change
    (HTTP 400, nothing is saved)."""
    require_known_key(key)
    if not isinstance(raw, dict):
        studio_error(400, "INVALID_REQUEST", "value must be an object")
    merged = copy.deepcopy(current if isinstance(current, dict) else default_value(key))
    _APPLY[key](merged, raw, id_validator)
    return merged


_MERGED_FIELDS = ("services", "week")  # objects whose entries are saved one by one (a partial change merges)
# Lists whose items must not repeat by one part of the item (holidays: one per date); in the other
# lists the whole checked item must not repeat.
_UNIQUE_ITEM_PART = {"holidays": "date"}


def _try_field(key: str, raw: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    try:
        return validate_setting(key, raw, value)
    except Exception:
        return value


def _salvage_items(key: str, field: str, items: list[Any]) -> list[Any]:
    """The stored list items that pass their own rule, in their order, a repeat dropped (the first
    is kept). Each item is checked once, alone, against the safe default: an item's own rule never
    depends on the other fields, and the list as a whole is checked afterwards (``_try_list``)."""
    base = default_value(key)
    part = _UNIQUE_ITEM_PART.get(field)
    kept: list[Any] = []
    seen: set[str] = set()
    for item in items:
        trial = _try_field(key, {field: [item]}, base)
        if trial is base:
            continue
        checked = trial.get(field) or []
        identity = repr([entry[part] for entry in checked] if part else checked)
        if identity not in seen:
            seen.add(identity)
            kept.append(item)
    return kept


def _try_list(key: str, field: str, items: list[Any], value: dict[str, Any]) -> dict[str, Any]:
    """``value`` with the kept ``items`` checked once as a whole (the list rules and the rules
    between fields). Over a length cap, the longest leading run that passes is kept (found by
    halving, a few checks instead of one per item). No items = ``value`` unchanged."""
    if not items:
        return value
    whole = _try_field(key, {field: items}, value)
    if whole is not value:
        return whole
    best, low, high = value, 1, len(items) - 1
    while low <= high:
        middle = (low + high) // 2
        trial = _try_field(key, {field: items[:middle]}, value)
        if trial is value:
            high = middle - 1
        else:
            best, low = trial, middle + 1
    return best


def normalise_stored(key: str, stored: Any) -> dict[str, Any]:
    """A stored value read back through today's rules. The whole value is tried first, so the
    rules between fields (min <= max) see every stored field; if it fails, each field and each
    entry of an object that fails keeps its safe default instead of breaking /api/studio/me, and
    a list keeps the items that pass (each item checked once on its own, then the kept list once
    as a whole). Unknown stored fields are dropped. The field-by-field pass runs twice, so a
    field refused only because a later field was still at its default gets a second chance."""
    value = default_value(key)
    if not isinstance(stored, dict):
        return value
    known = {field: field_value for field, field_value in stored.items() if field in value}
    whole = _try_field(key, known, value)
    if whole is not value:
        return whole
    lists = {
        field: _salvage_items(key, field, field_value)
        for field, field_value in known.items()
        if isinstance(field_value, list)
    }
    for _pass in range(2):
        for field, field_value in known.items():
            if field in _MERGED_FIELDS and isinstance(field_value, dict):
                for name, item in field_value.items():
                    value = _try_field(key, {field: {name: item}}, value)
            elif field in lists:
                value = _try_list(key, field, lists[field], value)
            else:
                value = _try_field(key, {field: field_value}, value)
    return value


# ------------------------------------------------------------------ storage

def _select_row(conn: Any, key: str) -> Any:
    """The key's row whatever its deleted flag: a soft-deleted row must never block a save."""
    return conn.execute(
        text(
            "SELECT id, data_json, deleted, created_at, last_modified FROM entities "
            "WHERE type = :type AND id = :id LIMIT 1"
        ),
        {"type": STUDIO_SETTINGS_TYPE, "id": setting_id(key)},
    ).mappings().first()


def _live_data(row: Any) -> Any:
    """The stored data of a live row; None for no row or a soft-deleted one (= never saved)."""
    return json_loads(row["data_json"]) if row and not bool(row["deleted"]) else None


def _record(key: str, data: Any) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    try:
        version = max(int(data.get("version") or 0), 0)
    except (TypeError, ValueError, OverflowError):
        version = 0
    return {
        "key": key,
        "id": setting_id(key),
        "value": normalise_stored(key, data.get("value")) if version else default_value(key),
        "version": version,
        "updatedAt": str(data.get("updatedAt") or "") or None,
    }


def read_setting(key: str) -> dict[str, Any]:
    """``{key, id, value, version, updatedAt}``; version 0 = never saved (the defaults)."""
    require_known_key(key)
    with db_conn() as conn:
        row = _select_row(conn, key)
    return _record(key, _live_data(row))


def read_all_settings() -> dict[str, dict[str, Any]]:
    """Every key's current value (defaults for keys never saved), in one query."""
    ids = {setting_id(key): key for key in SETTING_KEYS}
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id, data_json FROM entities WHERE type = :type AND deleted = false"),
            {"type": STUDIO_SETTINGS_TYPE},
        ).mappings().all()
    found = {ids[str(r["id"])]: json_loads(r["data_json"]) for r in rows if str(r["id"]) in ids}
    return {key: _record(key, found.get(key))["value"] for key in SETTING_KEYS}


_SAVED_FIRST = "This setting was saved by someone else just now. Reload it, then save again."


def desk_hidden(rollout: dict[str, Any]) -> bool:
    """True when the rollout shows the v2 team desk to nobody: ``staffDesk`` off, or ``pilot`` with an
    empty ``staffAllowlist`` (staff_desk_layout answers classic for every staff member then)."""
    mode = str(rollout.get("staffDesk") or "off")
    return mode == "off" or (mode == "pilot" and not (rollout.get("staffAllowlist") or []))


def refuse_desk_off_while_in_use(conn: Any, before: dict[str, Any], after: dict[str, Any]) -> None:
    """P3-20: the team desk (``staffDesk``) cannot be hidden (off, or pilot with nobody on the staff
    allowlist: desk_hidden) while it still holds work that only it shows: unresolved tickets or open
    stop requests, counted by studio_stop.staff_desk_in_use exactly as the desk and the pulse count
    them -> 409 STAFF_DESK_IN_USE. Counted on the save's own transaction; any other rollout change
    (the customer layout included) is never held."""
    if desk_hidden(before) or not desk_hidden(after):
        return
    from .studio_stop import staff_desk_in_use  # late: studio_stop imports this module

    in_use = staff_desk_in_use(conn)
    if in_use["tickets"] or in_use["stopRequests"]:
        studio_error(
            409,
            "STAFF_DESK_IN_USE",
            f"The team desk still has {in_use['tickets']} unresolved ticket(s) and {in_use['stopRequests']} open stop "
            "request(s). Resolve them before switching the desk off.",
        )


def save_setting(
    key: str,
    raw_value: Any,
    expected_version: int,
    actor_id: str,
    iso_now: str,
    *,
    audit: Callable[[Any, dict[str, Any], dict[str, Any]], None],
    id_validator: Callable[[Any], str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate and save; returns (record before, record after). 409 when someone saved first.

    ``audit(conn, before, after)`` writes the audit entry on the same connection before the
    commit, so when it fails the save is rolled back too (a switch never changes unrecorded).
    """
    require_known_key(key)
    with db_conn() as conn:
        row = _select_row(conn, key)
        before = _record(key, _live_data(row))
        if int(expected_version) != before["version"]:
            studio_error(
                409,
                "VERSION_CONFLICT",
                f"This setting changed (now version {before['version']}). Reload it, then save again.",
            )
        value = validate_setting(key, raw_value, before["value"], id_validator)
        if key == "rollout":
            refuse_desk_off_while_in_use(conn, before["value"], value)
        stamp = now_ms()
        # A soft-deleted row reads as version 0, but its old numbers were handed out: count on from
        # them, so a page still holding a pre-delete version gets 409 instead of overwriting the revive.
        used = _record(key, json_loads(row["data_json"]))["version"] if row else 0
        data = {
            "id": setting_id(key),
            "recordType": STUDIO_SETTINGS_TYPE,
            "settingKey": key,
            "version": max(before["version"], used) + 1,
            "value": value,
            "updatedAt": iso_now,
            "updatedBy": str(actor_id or ""),
            "_deleted": False,
        }
        if row:
            # A live row is updated; a soft-deleted one is brought back (deleted = false), both
            # only if nobody touched the row since it was read.
            baseline = int(row["last_modified"])
            modified = max(stamp, baseline + 1)
            data["_created"] = int(row["created_at"])
            data["_lastModified"] = modified
            result = conn.execute(
                text(
                    "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                    "WHERE type = :type AND id = :id AND deleted = :was_deleted AND last_modified = :baseline"
                ),
                {"data": json_dumps(data), "modified": modified, "type": STUDIO_SETTINGS_TYPE,
                 "id": setting_id(key), "was_deleted": bool(row["deleted"]), "baseline": baseline},
            )
            if int(result.rowcount or 0) != 1:
                studio_error(409, "VERSION_CONFLICT", _SAVED_FIRST)
        else:
            data["_created"] = stamp
            data["_lastModified"] = stamp
            try:
                # A system row: created_by stays NULL (the acting admin is in updatedBy and the audit log).
                conn.execute(
                    text(
                        "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                        "VALUES (:type, :id, :data, false, :stamp, NULL, :stamp)"
                    ),
                    {"type": STUDIO_SETTINGS_TYPE, "id": setting_id(key), "data": json_dumps(data), "stamp": stamp},
                )
            except IntegrityError:
                # Two first saves at the same moment: the fixed id lets only one insert win.
                studio_error(409, "VERSION_CONFLICT", _SAVED_FIRST)
        after = _record(key, data)
        audit(conn, before, after)
    return before, after


# ------------------------------------------------------- what a user gets

def utc_now() -> datetime:
    """The clock of /api/studio/me (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _service_zone() -> Any:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(SERVICE_TIMEZONE)
    except Exception:  # no time-zone database: Libya has kept UTC+2 all year since 2013
        return timezone(timedelta(hours=2))


def _local(when: datetime) -> datetime:
    return (when if when.tzinfo else when.replace(tzinfo=timezone.utc)).astimezone(_service_zone())


def service_open_at(hours: dict[str, Any], when: datetime) -> bool:
    """True when ``when`` (UTC if it has no zone) falls inside the working hours, read in Tripoli
    time. A holiday or a closed weekday is closed all day; inside the Ramadan window the working
    days use the Ramadan hours. Open at ``open``, closed from ``close``."""
    local = _local(when)
    day = local.date().isoformat()
    if any(item.get("date") == day for item in hours.get("holidays") or []):
        return False
    today = (hours.get("week") or {}).get(WEEKDAYS[(local.weekday() + 1) % 7])  # weekday(): Monday = 0
    if not today:
        return False
    ramadan = hours.get("ramadan")
    if ramadan and ramadan["from"] <= day <= ramadan["to"]:
        today = ramadan
    return today["open"] <= local.strftime("%H:%M") < today["close"]


def public_service_hours(hours: dict[str, Any], contact: dict[str, Any], when: datetime) -> dict[str, Any]:
    """The customer's view of the calendar: past holidays and a finished Ramadan window left out.
    ``onDutyUntil`` is promised only while an urgent line exists to call."""
    today = _local(when).date().isoformat()
    ramadan = hours.get("ramadan")
    return {
        "timezone": SERVICE_TIMEZONE,
        "openNow": service_open_at(hours, when),
        "week": copy.deepcopy(hours.get("week") or {}),
        "holidays": [dict(item) for item in hours.get("holidays") or [] if item["date"] >= today],
        "ramadan": dict(ramadan) if ramadan and ramadan["to"] >= today else None,
        "onDutyUntil": hours.get("onDutyUntil") if contact.get("urgentWhatsapp") else None,
    }


def public_contact(contact: dict[str, Any]) -> dict[str, Any]:
    """What every customer may see. The urgent on-duty line is left out: only the after-hours
    stop-request answer shows it (PLAN.md §7.1 contact, §7.3 stop-request, Phase 3)."""
    return {field: contact.get(field) for field in PUBLIC_CONTACT_FIELDS}


def _rank(mode: str) -> int:
    return MODES.index(mode) if mode in MODES else 0


def customer_layout(rollout: dict[str, Any], user_id: str, env: str | None = None) -> str:
    """'v2' or 'classic'. The stricter of the env switch and the record wins."""
    mode = MODES[min(_rank(env_switch() if env is None else env), _rank(str(rollout.get("ui") or "off")))]
    if mode == "on":
        return "v2"
    if mode == "pilot" and user_id and user_id in (rollout.get("uiAllowlist") or []):
        return "v2"
    return "classic"


def staff_desk_layout(rollout: dict[str, Any], user_id: str, is_staff: bool) -> str:
    """'v2' or 'classic' for the Team desk; only the staffDesk switch decides (never the env)."""
    if not is_staff:
        return "classic"
    mode = str(rollout.get("staffDesk") or "off")
    if mode == "on":
        return "v2"
    if mode == "pilot" and user_id and user_id in (rollout.get("staffAllowlist") or []):
        return "v2"
    return "classic"


def service_access(rollout: dict[str, Any], user_id: str) -> dict[str, bool]:
    """Each service for this user: on = everyone, pilot = only the customer allowlist
    (``uiAllowlist``), off = nobody. Neither the env kill switch nor the customer layout is
    consulted: switching the layout off never hides a service (PLAN.md §12.2(b))."""
    services = rollout.get("services") or {}
    allowed = bool(user_id) and user_id in (rollout.get("uiAllowlist") or [])
    return {
        name: services.get(name) == "on" or (services.get(name) == "pilot" and allowed)
        for name in SERVICE_NAMES
    }


def me_view(
    settings: dict[str, dict[str, Any]], user_id: str, is_admin: bool, is_staff: bool, now: datetime | None = None
) -> dict[str, Any]:
    """/api/studio/me: the switches for this user plus what any customer needs and nothing
    private (budget limits, the service calendar with "open now" in Tripoli time, the public
    contact details). Staff-only settings (settlement, targets, thresholds) never appear here."""
    rollout = settings["rollout"]
    return {
        "ui": customer_layout(rollout, user_id),
        "services": service_access(rollout, user_id),
        "staffDesk": staff_desk_layout(rollout, user_id, is_staff),
        "capabilities": dict(settings["capabilities"]),
        "intake": {"open": bool(settings["intake"].get("open"))},
        "adLimits": {field: settings["limits"][field] for field in PUBLIC_LIMIT_FIELDS},
        "serviceHours": public_service_hours(settings["hours"], settings["contact"], now or utc_now()),
        "contact": public_contact(settings["contact"]),
        "isAdmin": bool(is_admin),
        "isStaff": bool(is_staff),
    }
