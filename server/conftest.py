"""Shared pytest plumbing for the backend suite."""

import pytest

from server.rate_limiter import reset_rate_limit


@pytest.fixture(autouse=True, scope="module")
def _clear_shared_login_ceiling():
    """Every module logs in through the one TestClient address, and the per-IP
    login ceiling (120 per 15 minutes) is a production guard, not a test
    budget: clear it before each module so the suite's own growth never turns
    into 429s in whichever module happens to run late."""
    for ip in ("testclient", "192.0.2.99", "127.0.0.1"):
        reset_rate_limit(f"login:ip:{ip}")
    yield
