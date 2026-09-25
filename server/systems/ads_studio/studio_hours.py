"""Albayan Studio service hours: due times in working time (plan task P3-16; PLAN.md §7.2, D11).

Pure helpers over the ``hours`` and ``targets`` settings (studio_settings.py). Every day is read in
``Africa/Tripoli`` time (Libya keeps UTC+2 all year), with the same rules as
studio_settings.service_open_at, the "open now" of /api/studio/me:

* a holiday (``hours.holidays``) and a weekday whose ``hours.week`` entry is null are closed all day;
* inside the Ramadan window (``hours.ramadan``) the WORKING days use the Ramadan hours; a closed
  weekday stays closed;
* a day opens at ``open`` and is closed from ``close`` (no overnight shifts: the settings refuse them).

Functions:

* ``due_at(start, minutes=N)``: the moment when N minutes of WORKING time have passed since
  ``start``. Counting starts at ``start`` when it is inside the hours, otherwise at the next opening;
  time outside the hours (evenings, weekends, holidays) does not count. A due time that lands exactly
  on a closing time stays there (17:00 the same day, not 09:00 the next working day).
* ``due_at(start, business_days=N)``: closing time of the Nth working day AFTER the Tripoli day of
  ``start`` (a request sent on Thursday with 1 business day is due on Sunday at closing time; sent on
  Friday, it is due on Sunday too). This is the rule of the jobs loop's overdue-review alert
  (studio_jobs.review_due_at), so the time a screen promises and the alert agree.
* ``target_due_at(target, start)``: the due time of one queue from the ``targets`` setting (D11):
  ``review`` and ``settlement`` and ``tiktok`` in business days, ``ticket`` (first answer),
  ``stop_request`` and ``payment`` (confirmation) in working minutes.
* ``is_open_at(when)`` / ``is_open_now()``: inside the working hours or not (an after-hours stop
  request shows the urgent line, P3-10).
* ``next_open_at(start)``: the first working moment at or after ``start``.

``settings`` may be the whole studio settings (read_all_settings()), only the ``hours`` value, or
None (read now). Every result is an aware UTC datetime (``None`` only when no working time exists in
the next ~2 years, which the settings rules make impossible: at least one working day, at most 60
holidays). A time without a zone is read as UTC.
"""

from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from .studio_settings import SERVICE_TIMEZONE, WEEKDAYS, read_all_settings, service_open_at

SEARCH_DAYS = 800  # how far ahead a due time is looked for (60 holidays and a 1-day week fit easily)

# target name -> (targets field, unit)
TARGETS: dict[str, tuple[str, str]] = {
    "review": ("reviewBusinessDays", "business_days"),
    "ticket": ("ticketFirstResponseMinutes", "minutes"),
    "stop_request": ("stopRequestMinutes", "minutes"),
    "payment": ("paymentConfirmMinutes", "minutes"),
    "settlement": ("settlementBusinessDays", "business_days"),
    "tiktok": ("tiktokBusinessDays", "business_days"),
}


def utc_now() -> datetime:
    """The clock of these helpers (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def service_zone() -> Any:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(SERVICE_TIMEZONE)
    except Exception:  # no time-zone database: Libya has kept UTC+2 all year since 2013
        return timezone(timedelta(hours=2))


def _aware(moment: datetime) -> datetime:
    if not isinstance(moment, datetime):
        raise ValueError("a due time needs a datetime to start from")
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    return settings if settings is not None else read_all_settings()


def hours_of(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """The ``hours`` value, from the whole settings, from the hours value itself, or read now."""
    value = _settings(settings)
    return value if "week" in value else value["hours"]


def targets_of(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    return _settings(settings)["targets"]


def day_hours(hours: dict[str, Any], day: date) -> dict[str, str] | None:
    """``{open, close}`` of one Tripoli day, or None when it is closed (holiday, closed weekday)."""
    iso = day.isoformat()
    if any(item.get("date") == iso for item in hours.get("holidays") or []):
        return None
    today = (hours.get("week") or {}).get(WEEKDAYS[(day.weekday() + 1) % 7])  # weekday(): Monday = 0
    if not today:
        return None
    ramadan = hours.get("ramadan")
    if ramadan and ramadan["from"] <= iso <= ramadan["to"]:
        return {"open": ramadan["open"], "close": ramadan["close"]}
    return {"open": today["open"], "close": today["close"]}


def _clock(day: date, hhmm: str, zone: Any) -> datetime:
    hour, minute = (int(part) for part in str(hhmm).split(":"))
    return datetime.combine(day, time(hour, minute), tzinfo=zone)


def _windows(hours: dict[str, Any], start: datetime):
    """(opening, closing) of each working day from the Tripoli day of ``start`` on, for SEARCH_DAYS days."""
    zone = service_zone()
    day = start.astimezone(zone).date()
    for _ in range(SEARCH_DAYS):
        opening = day_hours(hours, day)
        if opening:
            yield _clock(day, opening["open"], zone), _clock(day, opening["close"], zone)
        day += timedelta(days=1)


def _utc(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc)


def is_open_at(when: datetime, settings: dict[str, Any] | None = None) -> bool:
    """Inside the working hours at ``when`` (studio_settings.service_open_at: one rule for both)."""
    return service_open_at(hours_of(settings), _aware(when))


def is_open_now(settings: dict[str, Any] | None = None, now: datetime | None = None) -> bool:
    return is_open_at(now or utc_now(), settings)


def next_open_at(start: datetime, settings: dict[str, Any] | None = None) -> datetime | None:
    """The first working moment at or after ``start`` (``start`` itself when it is inside the hours)."""
    start = _aware(start)
    for opening, closing in _windows(hours_of(settings), start):
        if start < closing:
            return _utc(max(start, opening))
    return None


def due_at(
    start: datetime,
    *,
    minutes: int | None = None,
    business_days: int | None = None,
    settings: dict[str, Any] | None = None,
) -> datetime | None:
    """When ``minutes`` of working time have passed since ``start``, or closing time of the
    ``business_days``-th working day after the day of ``start`` (see the module docstring).
    Exactly one of the two must be given, as a whole number >= 0 (minutes) or >= 1 (days)."""
    if (minutes is None) == (business_days is None):
        raise ValueError("due_at needs exactly one of minutes or business_days")
    start = _aware(start)
    hours = hours_of(settings)
    if minutes is not None:
        if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 0:
            raise ValueError("minutes must be a whole number >= 0")
        remaining = timedelta(minutes=minutes)
        for opening, closing in _windows(hours, start):
            begin = max(start, opening)
            if begin >= closing:
                continue  # this working day is already over
            if remaining <= closing - begin:
                return _utc(begin + remaining)
            remaining -= closing - begin
        return None
    if isinstance(business_days, bool) or not isinstance(business_days, int) or business_days < 1:
        raise ValueError("business_days must be a whole number >= 1")
    start_day = start.astimezone(service_zone()).date()
    counted = 0
    for _opening, closing in _windows(hours, start):
        if closing.date() <= start_day:
            continue  # the day it was sent does not count
        counted += 1
        if counted >= business_days:
            return _utc(closing)
    return None


def target_due_at(target: str, start: datetime, settings: dict[str, Any] | None = None) -> datetime | None:
    """The due time of one queue (``TARGETS``: review, ticket, stop_request, payment, settlement,
    tiktok) from the ``targets`` setting, counted in the ``hours`` setting."""
    if target not in TARGETS:
        raise ValueError(f"unknown service target {target!r}")
    value = _settings(settings)
    field, unit = TARGETS[target]
    amount = int(targets_of(value)[field])
    if unit == "minutes":
        return due_at(start, minutes=amount, settings=value)
    return due_at(start, business_days=amount, settings=value)


def iso(moment: datetime | None) -> str | None:
    """``2026-09-27T09:00:00.000Z`` (milliseconds, UTC), or None."""
    if moment is None:
        return None
    return _utc(_aware(moment)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
