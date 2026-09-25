"""Albayan Studio service hours (plan task P3-16; PLAN.md §7.2, D11): due times in working time.

The default calendar is Sun-Thu 09:00-17:00 Tripoli time (UTC+2 all year). Dates used below:
2026-09-24 is a Thursday; the Ramadan window of the tests runs Monday 2027-02-08 to Tuesday
2027-03-09 with 10:00-15:00. Pure functions: no database is needed.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest

from server.systems.ads_studio import studio_hours, studio_jobs, studio_settings
from server.systems.ads_studio.studio_hours import due_at, is_open_at, is_open_now, next_open_at, target_due_at

TRIPOLI = timezone(timedelta(hours=2))


def _t(year, month, day, hour, minute=0) -> datetime:
    """A Tripoli wall-clock time as an aware datetime."""
    return datetime(year, month, day, hour, minute, tzinfo=TRIPOLI)


def _hours(**change) -> dict:
    return studio_settings.validate_setting("hours", change)


def _settings(hours: dict | None = None, **targets) -> dict:
    value = {key: studio_settings.default_value(key) for key in studio_settings.SETTING_KEYS}
    if hours is not None:
        value["hours"] = hours
    value["targets"].update(targets)
    return value


DEFAULT = _settings()


def _due(start, **kwargs):
    kwargs.setdefault("settings", DEFAULT)
    return due_at(start, **kwargs)


# ------------------------------------------------------------------ the TASKS cases


def test_weekend():
    # Thursday 16:00 + 4 working hours: 1 h on Thursday, Friday and Saturday closed, 3 h on Sunday.
    assert _due(_t(2026, 9, 24, 16), minutes=240) == _t(2026, 9, 27, 12)
    # Sent during the weekend: the count starts on Sunday at 09:00.
    assert _due(_t(2026, 9, 25, 11), minutes=240) == _t(2026, 9, 27, 13)
    assert _due(_t(2026, 9, 26, 23, 59), minutes=240) == _t(2026, 9, 27, 13)
    # A stop request (2 working hours) sent on Thursday evening: Sunday 11:00.
    assert _due(_t(2026, 9, 24, 20), minutes=120) == _t(2026, 9, 27, 11)
    # Business days: closing time of the Nth working day after the day it was sent.
    assert _due(_t(2026, 9, 24, 10, 30), business_days=1) == _t(2026, 9, 27, 17)
    assert _due(_t(2026, 9, 24, 10, 30), business_days=2) == _t(2026, 9, 28, 17)
    assert _due(_t(2026, 9, 25, 10), business_days=1) == _t(2026, 9, 27, 17)  # sent on Friday
    assert _due(_t(2026, 9, 27, 8), business_days=1) == _t(2026, 9, 28, 17)   # Sunday before opening
    # Every result is UTC.
    assert _due(_t(2026, 9, 24, 16), minutes=240).tzinfo == timezone.utc


def test_eve_of_holiday():
    hours = _hours(holidays=[{"date": "2026-10-01", "labelEn": "Test holiday", "labelAr": "عطلة تجريبية"}])
    settings = _settings(hours)
    # Wednesday 15:00 before a Thursday holiday: 2 h on Wednesday, then Sunday 09:00 + 2 h.
    assert due_at(_t(2026, 9, 30, 15), minutes=240, settings=settings) == _t(2026, 10, 4, 11)
    # On the holiday itself nothing counts.
    assert due_at(_t(2026, 10, 1, 10), minutes=240, settings=settings) == _t(2026, 10, 4, 13)
    # One business day from the eve of the holiday skips it (and the weekend).
    assert due_at(_t(2026, 9, 30, 10), business_days=1, settings=settings) == _t(2026, 10, 4, 17)
    # Without the holiday Thursday counts as usual.
    assert _due(_t(2026, 9, 30, 15), minutes=240) == _t(2026, 10, 1, 11)
    # A Sunday holiday after the weekend: Thursday 16:30 + 4 h -> Monday 12:30.
    sunday = _settings(_hours(holidays=[{"date": "2026-10-04"}]))
    assert due_at(_t(2026, 10, 1, 16, 30), minutes=240, settings=sunday) == _t(2026, 10, 5, 12, 30)
    # The hours value alone works as well as the whole settings.
    assert due_at(_t(2026, 9, 30, 15), minutes=240, settings=hours) == _t(2026, 10, 4, 11)


def test_ramadan_override():
    settings = _settings(_hours(ramadan={"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"}))
    # Wednesday 14:00 in Ramadan: 1 h left that day (until 15:00), then Thursday 10:00 + 1 h.
    assert due_at(_t(2027, 2, 10, 14), minutes=120, settings=settings) == _t(2027, 2, 11, 11)
    # 09:30 is before the Ramadan opening (ordinary hours would already count it).
    assert due_at(_t(2027, 2, 10, 9, 30), minutes=60, settings=settings) == _t(2027, 2, 10, 11)
    # Business days close at the Ramadan closing time.
    assert due_at(_t(2027, 2, 10, 9), business_days=1, settings=settings) == _t(2027, 2, 11, 15)


def test_ramadan_weekend_and_edges():
    settings = _settings(_hours(ramadan={"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"}))
    # A Ramadan Friday and Saturday stay closed: Thursday 14:30 + 1 h -> Sunday 10:30.
    assert due_at(_t(2027, 2, 11, 14, 30), minutes=60, settings=settings) == _t(2027, 2, 14, 10, 30)
    # The last Ramadan day, then ordinary hours again: Tuesday 14:30 + 2 h -> Wednesday 10:30.
    assert due_at(_t(2027, 3, 9, 14, 30), minutes=120, settings=settings) == _t(2027, 3, 10, 10, 30)
    # The day before Ramadan starts: Sunday 16:00 + 4 h -> 1 h Sunday, then Monday (Ramadan) 10:00 + 3 h.
    assert due_at(_t(2027, 2, 7, 16), minutes=240, settings=settings) == _t(2027, 2, 8, 13)


# ------------------------------------------------------------------ counting rules


def test_counting_edges():
    assert _due(_t(2026, 9, 24, 9), minutes=60) == _t(2026, 9, 24, 10)          # exactly at opening
    assert _due(_t(2026, 9, 24, 7), minutes=60) == _t(2026, 9, 24, 10)          # before opening
    assert _due(_t(2026, 9, 24, 16), minutes=60) == _t(2026, 9, 24, 17)         # due exactly at closing: same day
    assert _due(_t(2026, 9, 23, 17), minutes=60) == _t(2026, 9, 24, 10)         # at closing = already closed
    assert _due(_t(2026, 9, 24, 12, 15), minutes=0) == _t(2026, 9, 24, 12, 15)  # zero inside the hours
    assert _due(_t(2026, 9, 24, 18), minutes=0) == _t(2026, 9, 27, 9)           # zero after hours: next opening
    assert _due(_t(2026, 9, 27, 9), minutes=8 * 60 * 5) == _t(2026, 10, 1, 17)  # a whole working week
    # Seconds are kept: 10:00:30 + 30 min = 10:30:30.
    assert _due(_t(2026, 9, 24, 10) + timedelta(seconds=30), minutes=30) == _t(2026, 9, 24, 10, 30) + timedelta(seconds=30)
    # A time without a zone is read as UTC (07:00 UTC = 09:00 Tripoli).
    assert _due(datetime(2026, 9, 24, 7, 0), minutes=60) == _t(2026, 9, 24, 10)
    # The day changes at Tripoli midnight: Sunday 00:30 Tripoli is Saturday 22:30 UTC.
    assert _due(datetime(2026, 9, 26, 22, 30, tzinfo=timezone.utc), minutes=60) == _t(2026, 9, 27, 10)
    assert _due(datetime(2026, 9, 26, 22, 30, tzinfo=timezone.utc), business_days=1) == _t(2026, 9, 28, 17)


def test_business_days_match_the_overdue_review_alert():
    """The due time a screen shows equals the time the jobs loop's review_overdue alert uses."""
    hours = _hours(holidays=[{"date": "2026-10-01"}], ramadan={"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"})
    settings = _settings(hours)
    start = _t(2026, 9, 20, 8)
    for step in range(0, 24 * 200, 7):  # every 7 hours over ~200 days, weekends, the holiday and Ramadan included
        moment = start + timedelta(hours=step)
        for days in (1, 2, 3):
            expected = studio_jobs.review_due_at(moment.astimezone(timezone.utc).isoformat(), days, hours)
            assert due_at(moment, business_days=days, settings=settings) == expected, (moment, days)


def test_minutes_never_count_closed_time():
    """Brute force: the working minutes between start and due equal the target (minute resolution)."""
    hours = _hours(holidays=[{"date": "2026-10-01"}])
    settings = _settings(hours)

    def working_minutes(begin: datetime, end: datetime) -> int:
        count, moment = 0, begin
        while moment < end:
            count += 1 if studio_settings.service_open_at(hours, moment) else 0
            moment += timedelta(minutes=1)
        return count

    for start in (_t(2026, 9, 24, 16, 17), _t(2026, 9, 30, 8, 5), _t(2026, 9, 26, 12), _t(2026, 9, 29, 16, 59)):
        for minutes in (1, 45, 240, 600):
            due = due_at(start, minutes=minutes, settings=settings)
            assert working_minutes(start, due) == minutes, (start, minutes, due)
            assert is_open_at(due - timedelta(minutes=1), settings)  # the last counted minute was open


# ------------------------------------------------------------------ targets, open now, next opening


def test_targets_from_the_settings():
    start = _t(2026, 9, 24, 16)  # Thursday 16:00
    assert target_due_at("ticket", start, DEFAULT) == _t(2026, 9, 27, 12)        # 240 working minutes
    assert target_due_at("stop_request", start, DEFAULT) == _t(2026, 9, 27, 10)  # 120
    assert target_due_at("payment", start, DEFAULT) == _t(2026, 9, 27, 12)       # 240
    assert target_due_at("review", start, DEFAULT) == _t(2026, 9, 27, 17)        # 1 business day
    assert target_due_at("settlement", start, DEFAULT) == _t(2026, 9, 28, 17)    # 2 business days
    assert target_due_at("tiktok", start, DEFAULT) == _t(2026, 9, 27, 17)        # 1 business day
    tight = _settings(ticketFirstResponseMinutes=60, stopRequestMinutes=15)
    assert target_due_at("ticket", start, tight) == _t(2026, 9, 24, 17)
    assert target_due_at("stop_request", start, tight) == _t(2026, 9, 24, 16, 15)
    with pytest.raises(ValueError):
        target_due_at("coffee", start, DEFAULT)


def test_open_now_and_next_opening(monkeypatch):
    settings = _settings(_hours(holidays=[{"date": "2026-10-04"}]))
    assert is_open_at(_t(2026, 9, 24, 10), settings) is True
    assert is_open_at(_t(2026, 9, 24, 17), settings) is False
    assert is_open_at(_t(2026, 10, 4, 10), settings) is False  # the holiday
    monkeypatch.setattr(studio_hours, "utc_now", lambda: _t(2026, 9, 25, 10).astimezone(timezone.utc))
    assert is_open_now(settings) is False  # Friday
    assert is_open_now(settings, now=_t(2026, 9, 24, 10)) is True
    assert next_open_at(_t(2026, 9, 24, 10), settings) == _t(2026, 9, 24, 10)  # already open
    assert next_open_at(_t(2026, 9, 24, 17), settings) == _t(2026, 9, 27, 9)
    assert next_open_at(_t(2026, 10, 1, 18), settings) == _t(2026, 10, 5, 9)   # past the Sunday holiday


def test_settings_are_read_when_not_given(monkeypatch):
    hours = _hours(holidays=[{"date": "2026-10-01"}])
    monkeypatch.setattr(studio_hours, "read_all_settings", lambda: _settings(hours, ticketFirstResponseMinutes=120))
    assert due_at(_t(2026, 9, 30, 16), minutes=120) == _t(2026, 10, 4, 10)
    assert target_due_at("ticket", _t(2026, 9, 30, 16)) == _t(2026, 10, 4, 10)


def test_bad_arguments_and_no_working_time():
    start = _t(2026, 9, 24, 10)
    for kwargs in ({}, {"minutes": 10, "business_days": 1}, {"minutes": -1}, {"minutes": 1.5}, {"minutes": True},
                   {"business_days": 0}, {"business_days": "2"}):
        with pytest.raises(ValueError):
            due_at(start, settings=DEFAULT, **kwargs)
    with pytest.raises(ValueError):
        due_at("2026-09-24T10:00:00Z", minutes=10, settings=DEFAULT)
    closed = {"week": {day: None for day in studio_settings.WEEKDAYS}, "holidays": [], "ramadan": None}
    assert due_at(start, minutes=10, settings=closed) is None  # never loops forever
    assert due_at(start, business_days=1, settings=closed) is None
    assert next_open_at(start, closed) is None
    assert studio_hours.iso(_t(2026, 9, 27, 12)) == "2026-09-27T10:00:00.000Z" and studio_hours.iso(None) is None
