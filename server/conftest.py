"""Shared pytest plumbing for the backend suite."""

import os

import pytest

os.environ.setdefault("ALBAYAN_ALLOW_SQLITE", "true")  # the suite runs on SQLite on purpose

from server.rate_limiter import reset_rate_limit


@pytest.fixture(autouse=True, scope="module")
def _clear_shared_login_ceiling():
    """Every module logs in through the one TestClient address, and the per-IP
    login ceiling (120 per 15 minutes) is a production guard, not a test
    budget: clear it before each module so the suite's own growth never turns
    into 429s in whichever module happens to run late."""
    for ip in ("testclient", "192.0.2.99", "192.0.2.88", "198.51.100.77", "127.0.0.1"):
        reset_rate_limit(f"login:ip:{ip}")
    for email in ("admin@test.com", "testadmin@tests.albayanhub.com"):  # fixed fixture emails reused across modules
        reset_rate_limit(f"login:email:{email}")
    yield


@pytest.fixture(autouse=True, scope="module")
def _no_studio_daily_submission_cap():
    """The Ads Studio daily submission cap (P1-22, studio intake setting, 5 a day by default)
    counts every send of the whole run in the one shared database: a production staffing
    guard, not a test budget. Each module sees no sends counted; the cap's own tests in
    test_studio_budgets.py and test_ad_studio_backend.py put the real count back."""
    from server.systems.ads_studio import ad_campaign_actions

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(ad_campaign_actions, "count_submissions_today", lambda day: 0)
        yield
