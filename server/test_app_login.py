"""System-browser app login (Phase 2): handoff + exchange endpoints.

The packaged iOS/Android apps sign in through the phone's real browser:
- the app opens the hosted login page with a PKCE-style SHA-256 challenge,
- the signed-in web session calls POST /api/auth/app-login/handoff to mint
  a ONE-TIME code (stored hashed, bound to that challenge),
- the app exchanges code+verifier at POST /api/auth/app-login/exchange for
  its own session cookie.

These tests pin the security contract:
- handoff requires an authenticated web session and a well-formed challenge
- exchange is single-use, expiring, and burned even on a wrong verifier
- a newer handoff invalidates the user's previous outstanding code
- exchanged sessions get the long app lifetime (APP_LOGIN_SESSION_MS)
"""

import hashlib
import json
import os
import secrets
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
USER_EMAIL = "app-login-user@tests.albayanhub.com"
USER_PASSWORD = "AppLogin123!"


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
                "VALUES (:id,'App Login User',:email,'Admin',:perms,:hash,:salt,:algo,:iterations,"
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


def _web_login_cookie() -> str:
    response = client.post(
        "/api/auth/login", json={"email": USER_EMAIL, "password": USER_PASSWORD}
    )
    client.cookies.clear()
    assert response.status_code == 200, response.text
    cookie_val = response.cookies.get("albayan_session")
    assert cookie_val
    return cookie_val


def _new_verifier_pair() -> tuple[str, str]:
    verifier = secrets.token_hex(32)
    challenge = hashlib.sha256(verifier.encode("utf-8")).hexdigest()
    return verifier, challenge


def _handoff(cookie: str, challenge: str, platform: str | None = "ios"):
    body = {"challenge": challenge}
    if platform is not None:
        body["platform"] = platform
    response = client.post(
        "/api/auth/app-login/handoff",
        json=body,
        cookies={"albayan_session": cookie},
    )
    client.cookies.clear()
    return response


def _exchange(code: str, verifier: str):
    response = client.post(
        "/api/auth/app-login/exchange", json={"code": code, "verifier": verifier}
    )
    client.cookies.clear()
    return response


class TestAppLoginHandoff:
    def test_handoff_requires_authentication(self, user_id):
        _, challenge = _new_verifier_pair()
        response = client.post("/api/auth/app-login/handoff", json={"challenge": challenge})
        client.cookies.clear()
        assert response.status_code == 401

    def test_handoff_rejects_malformed_challenges(self, user_id):
        cookie = _web_login_cookie()
        for bad in ("", "zz" * 32, "abc", "A" * 64, secrets.token_hex(16)):
            response = _handoff(cookie, bad)
            assert response.status_code == 422, (
                f"challenge={bad!r} was not rejected: {response.status_code} {response.text}"
            )

    def test_handoff_stores_hashed_single_row_per_user(self, user_id):
        cookie = _web_login_cookie()
        _, challenge = _new_verifier_pair()
        response = _handoff(cookie, challenge)
        assert response.status_code == 200, response.text
        code = response.json().get("code")
        assert code and len(code) >= 20

        with db_conn() as conn:
            rows = conn.execute(
                text(
                    "SELECT code_hash, challenge_hash, used_at, expires_at, created_at "
                    "FROM app_logins WHERE user_id=:uid"
                ),
                {"uid": user_id},
            ).mappings().all()
        assert len(rows) == 1, "handoff must keep exactly one live code per user"
        row = rows[0]
        # Stored hashed — the plaintext code must never appear in the DB.
        assert row["code_hash"] != code
        assert row["challenge_hash"] == challenge
        assert row["used_at"] is None
        assert (
            int(row["expires_at"]) - int(row["created_at"])
            == main_module.APP_LOGIN_CODE_TTL_MS
        )


class TestAppLoginExchange:
    def test_full_round_trip_creates_long_app_session(self, user_id):
        cookie = _web_login_cookie()
        verifier, challenge = _new_verifier_pair()
        code = _handoff(cookie, challenge).json()["code"]

        response = _exchange(code, verifier)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["user"]["email"] == USER_EMAIL

        cookie_val = response.cookies.get("albayan_session")
        assert cookie_val and "." in cookie_val, "exchange must set the session cookie"
        session_id = cookie_val.split(".", 1)[0]
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT created_at, expires_at FROM sessions WHERE id=:id LIMIT 1"),
                {"id": session_id},
            ).mappings().first()
        assert row is not None
        lifetime = int(row["expires_at"]) - int(row["created_at"])
        assert lifetime == main_module.APP_LOGIN_SESSION_MS

        me = client.get("/api/auth/me", cookies={"albayan_session": cookie_val})
        client.cookies.clear()
        assert me.status_code == 200
        assert me.json()["email"] == USER_EMAIL

        with db_conn() as conn:
            audit_row = conn.execute(
                text(
                    "SELECT metadata_json FROM audit_logs "
                    "WHERE user_id=:uid AND action='app_login' ORDER BY ts DESC LIMIT 1"
                ),
                {"uid": user_id},
            ).mappings().first()
        assert audit_row is not None, "app login must write an audit row"
        meta = json.loads(audit_row["metadata_json"] or "{}")
        assert meta.get("sessionLifetimeMs") == main_module.APP_LOGIN_SESSION_MS

    def test_code_is_single_use(self, user_id):
        cookie = _web_login_cookie()
        verifier, challenge = _new_verifier_pair()
        code = _handoff(cookie, challenge).json()["code"]

        first = _exchange(code, verifier)
        assert first.status_code == 200, first.text
        second = _exchange(code, verifier)
        assert second.status_code == 400
        assert second.cookies.get("albayan_session") is None

    def test_wrong_verifier_burns_the_code(self, user_id):
        cookie = _web_login_cookie()
        verifier, challenge = _new_verifier_pair()
        code = _handoff(cookie, challenge).json()["code"]

        wrong = _exchange(code, secrets.token_hex(32))
        assert wrong.status_code == 400
        assert wrong.cookies.get("albayan_session") is None
        # The claim happened before verification, so even the CORRECT
        # verifier cannot redeem the code afterwards.
        retry = _exchange(code, verifier)
        assert retry.status_code == 400

    def test_expired_code_is_rejected(self, user_id):
        cookie = _web_login_cookie()
        verifier, challenge = _new_verifier_pair()
        code = _handoff(cookie, challenge).json()["code"]

        with db_conn() as conn:
            conn.execute(
                text("UPDATE app_logins SET expires_at=:exp WHERE user_id=:uid"),
                {"exp": now_ms() - 1000, "uid": user_id},
            )
        response = _exchange(code, verifier)
        assert response.status_code == 400

    def test_new_handoff_invalidates_previous_code(self, user_id):
        cookie = _web_login_cookie()
        verifier_a, challenge_a = _new_verifier_pair()
        code_a = _handoff(cookie, challenge_a).json()["code"]
        verifier_b, challenge_b = _new_verifier_pair()
        code_b = _handoff(cookie, challenge_b).json()["code"]

        stale = _exchange(code_a, verifier_a)
        assert stale.status_code == 400, "older outstanding code must be revoked"
        fresh = _exchange(code_b, verifier_b)
        assert fresh.status_code == 200, fresh.text

    def test_malformed_inputs_are_rejected_without_db_probing(self, user_id):
        # Too short / illegal charset never reaches the token lookup.
        for code, verifier in (
            ("short", secrets.token_hex(32)),
            (secrets.token_hex(32), "short"),
            ("bad code with spaces!!!!", secrets.token_hex(32)),
            (secrets.token_hex(32), "bad verifier with spaces!!"),
        ):
            response = _exchange(code, verifier)
            assert response.status_code in (400, 422), (
                f"code={code!r} verifier={verifier!r}: {response.status_code}"
            )
            assert response.cookies.get("albayan_session") is None
