"""
Tests for the first-run admin bootstrap endpoint POST /api/auth/setup-admin.

Uses a dedicated file-based SQLite DB so the zero-users bootstrap path can be
tested in isolation from the shared in-memory DB the other suites populate.

Run with: PYTHONPATH=. pytest server/test_setup_admin.py -v
"""
import sys
import os
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.main import app
import server.db as db

_DB_FILE = os.path.join(tempfile.gettempdir(), "albayan_setup_admin_test.db")
client = TestClient(app, headers={"Origin": "http://testserver"})

SETUP_EMAIL = "firstadmin@tests.albayanhub.com"
SETUP_PASSWORD = "FirstAdminPass123!"


@pytest.fixture(scope="module", autouse=True)
def isolated_db():
    prev = os.environ.get("DATABASE_URL")
    try:
        if os.path.exists(_DB_FILE):
            os.remove(_DB_FILE)
    except Exception:
        pass
    os.environ["DATABASE_URL"] = f"sqlite+pysqlite:///{_DB_FILE}"
    db._ENGINE = None
    db._ENGINE_URL = None
    db.init_db()
    yield
    if prev is not None:
        os.environ["DATABASE_URL"] = prev
    else:
        os.environ.pop("DATABASE_URL", None)
    db._ENGINE = None
    db._ENGINE_URL = None
    try:
        os.remove(_DB_FILE)
    except Exception:
        pass


def _user_count():
    with db.db_conn() as conn:
        return int(conn.execute(text("SELECT COUNT(*) FROM users WHERE deleted = false")).scalar() or 0)


class TestSetupAdmin:
    def test_starts_with_zero_users(self):
        assert _user_count() == 0

    def test_needs_setup_true_when_empty(self):
        r = client.get("/api/auth/needs-setup")
        assert r.status_code == 200
        assert r.json()["needsSetup"] is True

    def test_creates_first_admin_and_logs_in(self):
        r = client.post(
            "/api/auth/setup-admin",
            json={"name": "Owner", "email": SETUP_EMAIL, "password": SETUP_PASSWORD},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user"]["email"] == SETUP_EMAIL
        assert body["user"]["role"].lower() == "admin"
        # A session cookie is set so the browser is logged straight in.
        assert r.cookies.get("albayan_session")
        assert _user_count() == 1
        try:
            client.cookies.clear()
        except Exception:
            pass

    def test_blocked_once_a_user_exists(self):
        r = client.post(
            "/api/auth/setup-admin",
            json={"name": "Second", "email": "second@tests.albayanhub.com", "password": "AnotherPass123!"},
        )
        assert r.status_code == 409
        assert _user_count() == 1  # unchanged

    def test_login_after_setup_works(self):
        r = client.post("/api/auth/login", json={"email": SETUP_EMAIL, "password": SETUP_PASSWORD})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["email"] == SETUP_EMAIL
        try:
            client.cookies.clear()
        except Exception:
            pass

    def test_short_password_rejected(self):
        # Fresh isolated check would need 0 users; here a user already exists so
        # validation (422) is what a too-short password hits first at the schema.
        r = client.post(
            "/api/auth/setup-admin",
            json={"name": "X", "email": "x@tests.albayanhub.com", "password": "short"},
        )
        assert r.status_code == 422

    def test_needs_setup_false_after_admin_exists(self):
        r = client.get("/api/auth/needs-setup")
        assert r.status_code == 200
        assert r.json()["needsSetup"] is False
