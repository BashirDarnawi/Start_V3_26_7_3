"""Remember-me session semantics: opt-in long lifetime, strict validation.

The login endpoint accepts an OPTIONAL strict-boolean ``rememberMe`` flag:
- true  -> session row expires_at and cookie Max-Age use
           SESSION_REMEMBER_DURATION_MS (ALBAYAN_SESSION_REMEMBER_MS,
           default 30 days)
- false/absent -> the standard SESSION_DURATION_MS (default 8h)
- anything that is not a JSON boolean -> 422, no session, no cookie

Expiry must be enforced by the SERVER per session row (not just the cookie
lifetime), so these tests assert against the sessions table directly.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server.db import db_conn, init_db, json_dumps, now_ms
import server.main as main_module
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
USER_EMAIL = "remember-me-user@tests.albayanhub.com"
USER_PASSWORD = "RememberMe123!"


def _ensure_user() -> str:
    pw = hash_password(USER_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": USER_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Remember Me User',:email,'Admin',:perms,:hash,:salt,:algo,:iterations,"
                "false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": USER_EMAIL,
                "perms": json_dumps({}),
                "hash": pw.hash_hex,
                "salt": pw.salt_hex,
                "algo": pw.algo,
                "iterations": pw.iterations,
                "now": now,
            },
        )
        return uid


@pytest.fixture(scope="module")
def user_id():
    init_db()
    uid = _ensure_user()
    yield uid


def _login(payload_extra: dict | None = None):
    payload = {"email": USER_EMAIL, "password": USER_PASSWORD}
    if payload_extra:
        payload.update(payload_extra)
    response = client.post("/api/auth/login", json=payload)
    client.cookies.clear()
    return response


def _session_row(response):
    cookie_val = response.cookies.get("albayan_session")
    assert cookie_val and "." in cookie_val, "login response is missing the session cookie"
    session_id = cookie_val.split(".", 1)[0]
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id, created_at, expires_at FROM sessions WHERE id=:id LIMIT 1"),
            {"id": session_id},
        ).mappings().first()
    assert row is not None, "session row was not created"
    return dict(row), cookie_val


def _max_age_from(response) -> int:
    set_cookie = response.headers.get("set-cookie") or ""
    assert "albayan_session=" in set_cookie
    for part in set_cookie.split(";"):
        part = part.strip()
        if part.lower().startswith("max-age="):
            return int(part.split("=", 1)[1])
    raise AssertionError(f"no Max-Age in set-cookie: {set_cookie}")


class TestRememberMeSessions:
    def test_remembered_session_expiry_far_exceeds_default(self, user_id):
        response = _login({"rememberMe": True})
        assert response.status_code == 200, response.text

        row, _ = _session_row(response)
        lifetime = int(row["expires_at"]) - int(row["created_at"])
        assert lifetime == main_module.SESSION_REMEMBER_DURATION_MS
        # Default env: 30 days vs 8 hours — a remembered session must be far
        # longer than the standard one, not marginally longer.
        assert lifetime >= 10 * main_module.SESSION_DURATION_MS
        assert _max_age_from(response) == int(
            main_module.SESSION_REMEMBER_DURATION_MS / 1000
        )

    def test_unchecked_or_absent_flag_keeps_default_expiry(self, user_id):
        for extra in (None, {"rememberMe": False}):
            response = _login(extra)
            assert response.status_code == 200, response.text
            row, _ = _session_row(response)
            lifetime = int(row["expires_at"]) - int(row["created_at"])
            assert lifetime == main_module.SESSION_DURATION_MS
            assert _max_age_from(response) == int(
                main_module.SESSION_DURATION_MS / 1000
            )

    def test_remember_flag_must_be_a_json_boolean(self, user_id):
        # StrictBool: strings ("true"/"banana"), numbers, null, arrays and
        # objects must all be rejected — nothing coerces into a long session.
        for bad in ("true", "banana", 1, 0, None, [True], {"v": True}):
            response = _login({"rememberMe": bad})
            assert response.status_code == 422, (
                f"rememberMe={bad!r} was not rejected: {response.status_code} {response.text}"
            )
            assert response.cookies.get("albayan_session") is None

    def test_remembered_session_expiry_is_enforced_server_side(self, user_id):
        response = _login({"rememberMe": True})
        assert response.status_code == 200, response.text
        row, cookie_val = _session_row(response)

        # The cookie is still "alive" from the browser's point of view, but
        # once the DB row expires the server must reject and delete it.
        with db_conn() as conn:
            conn.execute(
                text("UPDATE sessions SET expires_at=:exp WHERE id=:id"),
                {"exp": now_ms() - 1000, "id": row["id"]},
            )

        me = client.get("/api/auth/me", cookies={"albayan_session": cookie_val})
        assert me.status_code == 401

        with db_conn() as conn:
            gone = conn.execute(
                text("SELECT id FROM sessions WHERE id=:id"),
                {"id": row["id"]},
            ).mappings().first()
        assert gone is None, "expired session row must be deleted on use"

    def test_login_audit_records_which_session_mode_was_used(self, user_id):
        response = _login({"rememberMe": True})
        assert response.status_code == 200, response.text

        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT metadata_json FROM audit_logs "
                    "WHERE user_id=:uid AND action='login' ORDER BY ts DESC LIMIT 1"
                ),
                {"uid": user_id},
            ).mappings().first()
        assert row is not None, "login must write an audit row"
        meta = json.loads(row["metadata_json"] or "{}")
        assert meta.get("rememberMe") is True
        assert meta.get("sessionLifetimeMs") == main_module.SESSION_REMEMBER_DURATION_MS
