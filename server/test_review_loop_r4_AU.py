"""Review loop round 4, batch AU: sign-in.

* n=23  resetting a password with ``python -m server.create_admin`` signs every device out: the
        old sessions, pending app-login codes and reset codes are deleted with the new password.
        Before, the CLI (the documented recovery path after a leak) left all of them working.
* n=24  a full per-account login bucket no longer locks the real person out: an address this
        account signed in from (a session row, or the login audit row once the session expired)
        may still try. New addresses still get 429; a wrong password from a known one gets 401.
* n=26  CF-Connecting-IP / X-Forwarded-For values that are not an IP address are ignored, so an
        81+ character header can no longer overflow the VARCHAR(80) ip columns (500 on PostgreSQL).

Disposable users tagged per run; their rows and limiter keys are removed afterwards.
"""

import hashlib
import os
import secrets
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.auth_limits as auth_limits
import server.create_admin as create_admin
import server.main as main
from server.db import db_conn, init_db, now_ms
from server.rate_limiter import check_rate_limit, reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, hash_token, new_id

TAG = secrets.token_hex(4)
PASSWORD = "SignInR4Before123!"
NEW_PASSWORD = "SignInR4After123!"
ORIGIN = {"Origin": "http://testserver"}
KNOWN_IP = "198.51.100.50"
ATTACK_IPS = ("198.51.100.61", "198.51.100.62", "198.51.100.63", "198.51.100.64", "198.51.100.65", "198.51.100.66")
_USERS: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()
    yield
    with db_conn() as conn:
        for uid in _USERS:
            for table in ("sessions", "app_logins", "password_resets", "audit_logs"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
            conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})


def _seed_user(label, *, role="Employee"):
    uid = new_id(f"r4au{label}")
    email = f"r4-au-{label}-{TAG}@tests.albayanhub.com"
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,last_modified) "
                 "VALUES (:id,'R4 AU test',:email,:role,'{}',:h,:s,:a,:i,false,:n,:n)"),
            {"id": uid, "email": email, "role": role, "h": pw.hash_hex, "s": pw.salt_hex,
             "a": pw.algo, "i": pw.iterations, "n": now_ms()},
        )
    _USERS.append(uid)
    return {"id": uid, "email": email}


def _client(ip=None, cookie=None):
    headers = dict(ORIGIN)
    if ip:
        headers["X-Forwarded-For"] = ip
    if cookie:
        headers["Cookie"] = f"albayan_session={cookie}"
    return TestClient(main.app, headers=headers)


def _login(user, password=PASSWORD, ip=None, remember=False):
    return _client(ip).post("/api/auth/login", json={"email": user["email"], "password": password, "rememberMe": remember})


def _count(table, uid):
    with db_conn() as conn:
        return conn.execute(text(f"SELECT COUNT(*) FROM {table} WHERE user_id=:uid"), {"uid": uid}).scalar()


def _reset_login_keys(email):
    reset_rate_limit(f"login:email:{email.lower()}")
    for ip in (KNOWN_IP, *ATTACK_IPS, "testclient"):
        reset_rate_limit(f"login:{ip}|{email.lower()}")
        reset_rate_limit(f"login:ip:{ip}")


def _fill_email_bucket(email):
    """What an attacker achieves with 60 wrong passwords from three addresses."""
    for _ in range(auth_limits._LOGIN_EMAIL_MAX_ATTEMPTS + 5):
        check_rate_limit(f"login:email:{email.lower()}", auth_limits._LOGIN_EMAIL_MAX_ATTEMPTS, auth_limits._LOGIN_WINDOW_MS)


# --- n=23 ---------------------------------------------------------------------------------------

def test_create_admin_password_reset_signs_every_device_out(monkeypatch, capsys):
    user = _seed_user("cli", role="Admin")
    login = _login(user, remember=True)
    assert login.status_code == 200, login.text
    cookie = login.cookies.get("albayan_session")
    assert _client(cookie=cookie).get("/api/auth/me").status_code == 200
    challenge = hashlib.sha256(secrets.token_hex(32).encode()).hexdigest()
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO app_logins (id,user_id,code_hash,challenge_hash,created_at,expires_at) "
                 "VALUES (:id,:uid,:h,:c,:n,:e)"),
            {"id": new_id("r4auapp"), "uid": user["id"], "h": hash_token(secrets.token_urlsafe(32)),
             "c": challenge, "n": now_ms(), "e": now_ms() + 600_000},
        )
        conn.execute(
            text("INSERT INTO password_resets (id,user_id,token_hash,created_at,expires_at) VALUES (:id,:uid,:h,:n,:e)"),
            {"id": new_id("r4aureset"), "uid": user["id"], "h": hash_token(secrets.token_urlsafe(32)),
             "n": now_ms(), "e": now_ms() + 600_000},
        )

    monkeypatch.setattr(sys, "argv", ["create_admin", "--email", user["email"], "--password", NEW_PASSWORD])
    create_admin.main()

    assert _client(cookie=cookie).get("/api/auth/me").status_code == 401, "the old remember-me session must stop working"
    assert {t: _count(t, user["id"]) for t in ("sessions", "app_logins", "password_resets")} == {
        "sessions": 0, "app_logins": 0, "password_resets": 0}
    assert "signed out" in capsys.readouterr().out
    assert _login(user, NEW_PASSWORD).status_code == 200
    _reset_login_keys(user["email"])


def test_create_admin_for_a_new_email_still_creates_the_admin(monkeypatch):
    email = f"r4-au-newadmin-{TAG}@tests.albayanhub.com"
    monkeypatch.setattr(sys, "argv", ["create_admin", "--email", email, "--password", NEW_PASSWORD])
    create_admin.main()
    with db_conn() as conn:
        row = conn.execute(text("SELECT id, role FROM users WHERE email=:e"), {"e": email}).mappings().first()
    assert row and row["role"] == "Admin"
    _USERS.append(row["id"])


# --- n=24 ---------------------------------------------------------------------------------------

@pytest.fixture()
def trusted_proxy(monkeypatch):
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", True)
    monkeypatch.delenv("ALBAYAN_ORIGIN_SECRET", raising=False)


def test_full_account_bucket_still_lets_a_known_address_sign_in(trusted_proxy):
    user = _seed_user("known")
    other = _seed_user("other")
    _reset_login_keys(user["email"])
    assert _login(user, ip=KNOWN_IP).status_code == 200          # the owner's usual phone
    assert _login(other, ip=ATTACK_IPS[5]).status_code == 200    # someone else's account at another address
    _fill_email_bucket(user["email"])

    # New addresses stay blocked, whatever the password: the IP-rotation defence is intact.
    assert _login(user, "wrong-password-1", ip=ATTACK_IPS[3]).status_code == 429
    assert _login(user, ip=ATTACK_IPS[4]).status_code == 429
    # Another account's session at an address does not make it known for this account.
    assert _login(user, ip=ATTACK_IPS[5]).status_code == 429

    # The known address: a wrong password is a plain 401, the right one signs in.
    wrong = _login(user, "wrong-password-2", ip=KNOWN_IP)
    assert wrong.status_code == 401, wrong.text
    ok = _login(user, ip=KNOWN_IP)
    assert ok.status_code == 200, ok.text                        # before: 429 "Too many login attempts"
    _reset_login_keys(user["email"])
    _reset_login_keys(other["email"])


def test_known_address_survives_the_expired_session_cleanup(trusted_proxy):
    user = _seed_user("daily")
    _reset_login_keys(user["email"])
    assert _login(user, ip=KNOWN_IP).status_code == 200
    with db_conn() as conn:  # an 8-hour session that expired and was deleted
        conn.execute(text("DELETE FROM sessions WHERE user_id=:uid"), {"uid": user["id"]})
    _fill_email_bucket(user["email"])

    assert _login(user, ip=ATTACK_IPS[0]).status_code == 429
    ok = _login(user, ip=KNOWN_IP)
    assert ok.status_code == 200, ok.text
    _reset_login_keys(user["email"])


def test_unknown_email_with_a_full_bucket_gets_the_same_429(trusted_proxy):
    email = f"r4-au-nobody-{TAG}@tests.albayanhub.com"
    _reset_login_keys(email)
    _fill_email_bucket(email)
    response = _client(KNOWN_IP).post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 429
    _reset_login_keys(email)


# --- n=26 ---------------------------------------------------------------------------------------

def _raw_request(headers, host="198.51.100.2"):
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host=host), state=SimpleNamespace())


def test_client_ip_ignores_header_values_that_are_not_addresses(trusted_proxy, monkeypatch):
    long_value = "a" * 100
    assert auth_limits._client_ip(_raw_request({"cf-connecting-ip": long_value})) == "198.51.100.2"
    assert auth_limits._client_ip(_raw_request({"x-forwarded-for": "1.2.3.4, " + "b" * 100})) == "198.51.100.2"
    assert auth_limits._client_ip(
        _raw_request({"cf-connecting-ip": "not-an-ip", "x-forwarded-for": "1.2.3.4, 203.0.113.9"})) == "203.0.113.9"
    # Real addresses still pass through (IPv6 in its normal form).
    assert auth_limits._client_ip(_raw_request({"cf-connecting-ip": " 2001:DB8::1 "})) == "2001:db8::1"
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", False)
    loopback = _raw_request({"x-forwarded-for": "c" * 100}, host="127.0.0.1")
    assert auth_limits._client_ip(loopback) == "127.0.0.1"


def test_long_cf_connecting_ip_is_never_stored(trusted_proxy):
    user = _seed_user("longip")
    _reset_login_keys(user["email"])
    reset_rate_limit("reset:ip:testclient")
    reset_rate_limit(f"reset:testclient|{user['email']}")
    reset_rate_limit(f"reset:email:{user['email']}")
    forged = {**ORIGIN, "CF-Connecting-IP": "x" * 120}
    reset = TestClient(main.app, headers=forged).post("/api/auth/password-reset/request", json={"email": user["email"]})
    assert reset.status_code == 200, reset.text
    login = TestClient(main.app, headers=forged).post("/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert login.status_code == 200, login.text
    with db_conn() as conn:
        ips = [row[0] for table in ("password_resets", "sessions")
               for row in conn.execute(text(f"SELECT ip FROM {table} WHERE user_id=:uid"), {"uid": user["id"]})]
    assert ips and all(ip == "testclient" for ip in ips), ips   # before: the 120-character header was stored
    _reset_login_keys(user["email"])
