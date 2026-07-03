"""
Tracing + refresh-storm regression tests.

Goals (from engineering-spec prompt):
- Client can send X-Request-ID and server echoes it back (end-to-end correlation).
- A "refresh storm" style burst of reads should NOT trigger login lockout.
- Rate limiter should NOT extend lockout when blocked attempts continue.
"""

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Add parent directory to Python path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Use in-memory SQLite for testing (shared via StaticPool in server.db.get_engine)
os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

from sqlalchemy import text  # noqa: E402
from server.db import db_conn, init_db, json_dumps, now_ms  # noqa: E402
from server.main import app  # noqa: E402
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id  # noqa: E402
from server import rate_limiter  # noqa: E402


# Send an Origin header matching the test host so the CSRF same-origin check
# (require_same_origin) accepts requests, like a real browser would.
client = TestClient(app, headers={"Origin": "http://testserver"})

# Note: the domain must be a normally-formed one — the login endpoint validates
# emails and rejects reserved TLDs like .test, so "@albayan.test" cannot log in.
TEST_ADMIN_EMAIL = os.getenv("TEST_ADMIN_EMAIL", "testadmin@tests.albayanhub.com")
TEST_ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "TestPassword123!Secure")


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    init_db()
    pw = hash_password(TEST_ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
                {"email": TEST_ADMIN_EMAIL},
            )
            .mappings()
            .first()
        )
        if row:
            user_id = str(row["id"])
            conn.execute(
                text(
                    """
                    UPDATE users
                    SET
                      name = :name,
                      role = 'Admin',
                      permissions_json = :permissions_json,
                      password_hash = :password_hash,
                      password_salt = :password_salt,
                      password_algo = :password_algo,
                      password_iterations = :password_iterations,
                      deleted = false,
                      last_modified = :last_modified
                    WHERE id = :id
                    """
                ),
                {
                    "name": "Admin",
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "last_modified": now,
                    "id": user_id,
                },
            )
        else:
            user_id = new_id("user")
            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id, name, email, role, permissions_json,
                      password_hash, password_salt, password_algo, password_iterations,
                      deleted, created_at, created_by, last_modified
                    )
                    VALUES (
                      :id, :name, :email, 'Admin', :permissions_json,
                      :password_hash, :password_salt, :password_algo, :password_iterations,
                      false, :created_at, :created_by, :last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": "Admin",
                    "email": TEST_ADMIN_EMAIL,
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "created_at": now,
                    "created_by": user_id,
                    "last_modified": now,
                },
            )
    yield


@pytest.fixture()
def admin_cookie():
    resp = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    cookie = resp.cookies.get("albayan_session")
    assert cookie
    # Clear to avoid leakage between tests
    client.cookies.clear()
    return cookie


def test_request_id_is_echoed(admin_cookie):
    rid = "test-req-123abc"
    resp = client.get(
        "/api/bootstrap",
        cookies={"albayan_session": admin_cookie},
        headers={"X-Request-ID": rid},
    )
    assert resp.status_code == 200
    assert resp.headers.get("X-Request-ID") == rid


def test_refresh_storm_like_reads_do_not_break_session(admin_cookie):
    # Simulate a burst similar to initial app load:
    # /api/health + /api/auth/me + several collections reads, repeated.
    cookies = {"albayan_session": admin_cookie}
    for i in range(20):
        rid = f"storm-{i}"
        h = {"X-Request-ID": rid}
        assert client.get("/api/health", headers=h).status_code == 200
        assert client.get("/api/auth/me", cookies=cookies, headers=h).status_code == 200
        assert client.get("/api/collections/receipts?limit=50&offset=0", cookies=cookies, headers=h).status_code in (200, 204)
        assert client.get("/api/collections/ads?limit=50&offset=0", cookies=cookies, headers=h).status_code in (200, 204)

    # After the storm, login must still work (no lockout caused by refresh).
    resp = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
        headers={"X-Request-ID": "storm-login"},
    )
    assert resp.status_code == 200, resp.text


def test_rate_limiter_does_not_extend_lockout_when_blocked():
    # Use a tiny window so this test runs fast.
    key = f"test:{time.time()}"
    max_attempts = 2
    window_ms = 200

    allowed, left, retry = rate_limiter.check_rate_limit(key, max_attempts, window_ms)
    assert allowed is True
    assert left == 1
    assert retry == 0

    allowed, left, retry = rate_limiter.check_rate_limit(key, max_attempts, window_ms)
    assert allowed is True
    assert left == 0
    assert retry == 0

    # Now blocked; repeated blocked attempts must not extend the window.
    allowed, left, retry = rate_limiter.check_rate_limit(key, max_attempts, window_ms)
    assert allowed is False
    assert left == 0
    assert retry > 0

    # Spam while blocked; retry time should not increase above the window.
    time.sleep(0.05)
    allowed2, left2, retry2 = rate_limiter.check_rate_limit(key, max_attempts, window_ms)
    assert allowed2 is False
    assert left2 == 0
    assert retry2 <= window_ms

    # Wait out the window; should be allowed again.
    time.sleep(0.25)
    allowed3, left3, retry3 = rate_limiter.check_rate_limit(key, max_attempts, window_ms)
    assert allowed3 is True
    assert left3 == 1
    assert retry3 == 0


