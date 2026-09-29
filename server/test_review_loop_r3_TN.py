"""Review loop r3, batch TN (test time bombs), finding 24.

The Studio submit refuses a start before today's Libya day (prepare_ad_campaign_fields with
strict=True, the rule the submit route runs). The shared request fixtures used a fixed start of
2027-01-10, so from Tripoli's 2027-01-11 every submit in about 17 backend modules, the e2e wallet
journey and the PostgreSQL release scenarios would have returned 400 with no code change.

These checks move the business day past that date (and far beyond) and ask the real rule about
every fixture body. They create no users and write nothing.
"""

import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest

from server import main, operations
from server import test_ad_studio_backend as backend
from server import test_review_loop_r1_A1 as a1
from server import test_studio_activity as activity
from server import test_studio_link as link
from server import test_studio_posts as posts
from server import test_studio_privacy as privacy
from server import test_studio_wallet as wallet

ROOT = Path(__file__).parent.parent
# After the old fixed start date, and far later: the fixtures must follow any clock.
LATER_DAYS = (date(2027, 1, 11), date(2027, 2, 1), date(2031, 6, 30))


class _CapturingClient:
    """Stands in for a module's TestClient: keeps the request body a fixture would send."""

    def __init__(self):
        self.bodies = []

    def post(self, url, json=None, **kwargs):
        self.bodies.append(json["data"])
        return SimpleNamespace(status_code=200, text="", json=lambda: {"id": json.get("id"), "lastModified": 1})


def _sent_body(monkeypatch, module, call) -> dict:
    capture = _CapturingClient()
    monkeypatch.setattr(module, "client", capture)
    call()
    assert len(capture.bodies) == 1
    return capture.bodies[0]


def _fixture_bodies(monkeypatch) -> dict[str, dict]:
    return {
        "test_studio_wallet._campaign_body": wallet._campaign_body("Wallet", 2500),
        "test_ad_studio_backend._complete_campaign": backend._complete_campaign("Backend"),
        "test_studio_privacy._campaign_body": privacy._campaign_body("Privacy", 2500),
        "test_studio_activity._campaign_body": activity._campaign_body("Activity"),
        "test_studio_link._create": _sent_body(monkeypatch, link, lambda: link._create({"customer": {"cookies": {}}}, "Link")),
        "test_review_loop_r1_A1._create": _sent_body(monkeypatch, a1, lambda: a1._create({"cookies": {}}, 2500)),
    }


@pytest.mark.parametrize("today", LATER_DAYS, ids=lambda day: day.isoformat())
def test_submit_fixtures_still_pass_the_start_date_rule_on_a_later_day(monkeypatch, today):
    monkeypatch.setattr(operations, "_business_today", lambda: today)
    for name, body in _fixture_bodies(monkeypatch).items():
        start = date.fromisoformat(body["startDate"])
        assert start >= today + timedelta(days=30), (name, body["startDate"], today)
        clean = main._prepare_ad_campaign_fields(body, strict=True)  # the submit's own rule: no 400
        assert clean["startDate"] == body["startDate"], name
    boost = posts._boost("Boost")  # a quick boost is checked by its own post rules; its dates follow the day too
    assert date.fromisoformat(boost["startDate"]) >= today + timedelta(days=30)


def test_fixture_spans_keep_the_limits_the_budget_tests_rely_on(monkeypatch):
    monkeypatch.setattr(operations, "_business_today", lambda: date(2027, 2, 1))
    days = {name: (date.fromisoformat(body["endDate"]) - date.fromisoformat(body["startDate"])).days + 1
            for name, body in _fixture_bodies(monkeypatch).items()}
    # "$5 over 11 days is below the per-day minimum" (test_ad_studio_backend thinlife) needs the 11 days.
    assert days["test_ad_studio_backend._complete_campaign"] == 11 and days["test_studio_wallet._campaign_body"] == 11
    assert days["test_studio_link._create"] == 10


def test_studio_e2e_specs_submit_no_fixed_calendar_start():
    for spec in sorted((ROOT / "tests" / "e2e").glob("studio*.spec.js")):
        text = spec.read_text(encoding="utf-8")
        assert not re.search(r"startDate:\s*['\"]\d{4}-\d{2}-\d{2}", text), spec.name
