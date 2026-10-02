"""Bug-hunt R1 (server-auth-security-1): an IPv6 /64 is ONE address for every auth limit.

Each per-address bucket (login, password reset, setup, app-login) was keyed on the FULL client
address. Behind Cloudflare an ordinary IPv6 line or server (a /64: 2**64 addresses) could use a
new address for every request, so the per-address ceilings never filled. auth_limits._rate_subject
now counts the /64 (and ::ffff:a.b.c.d as a.b.c.d); sessions, audit rows and access logs still
record the full address.

Disposable users, audit rows and limiter keys are removed afterwards.
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.auth_limits as auth_limits
import server.main as main
from server.db import db_conn, init_db, now_ms
from server.rate_limiter import _MEMORY_STORE, check_rate_limit, reset_rate_limit
from server.security import hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "Ipv6Limits123!"
PREFIX = "2001:db8:1:2"  # one /64; each request below uses another interface id inside it
MAPPED_V4 = "203.0.113.5"
_USERS: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()
    yield
    with db_conn() as conn:
        for uid in _USERS:
            for table in ("sessions", "audit_logs"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
            conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})
        conn.execute(  # the anonymous "unknown email" reset rows this module wrote
            text("DELETE FROM audit_logs WHERE action='password_reset_request' AND resource_id LIKE :tag"),
            {"tag": f"%{TAG}%"},
        )


@pytest.fixture(autouse=True)
def trusted_proxy(monkeypatch):
    # Production sits behind Cloudflare with ALBAYAN_TRUST_PROXY_HEADERS=true.
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", True)
    monkeypatch.delenv("ALBAYAN_ORIGIN_SECRET", raising=False)
    # Speed only: an unknown email burns one dummy PBKDF2; make it cheap here.
    monkeypatch.setattr(main, "_DUMMY_PASSWORD_HASH", hash_password("x", iterations=1))
    yield
    for key in [k for k in list(_MEMORY_STORE) if TAG in k or PREFIX in k or MAPPED_V4 in k]:
        reset_rate_limit(key)


def _client():
    return TestClient(main.app, headers={"Origin": "http://testserver"})


def _v6(i):
    return f"{PREFIX}:{(i >> 48) & 0xffff:x}:{(i >> 32) & 0xffff:x}:{(i >> 16) & 0xffff:x}:{i & 0xffff:x}"


def _seed_user(label):
    uid = new_id(f"r1v6{label}")
    email = f"r1-v6-{label}-{TAG}@tests.albayanhub.com"
    pw = hash_password(PASSWORD, iterations=1000)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,last_modified) "
                 "VALUES (:id,'R1 v6 test',:email,'Employee','{}',:h,:s,:a,:i,false,:n,:n)"),
            {"id": uid, "email": email, "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo,
             "i": pw.iterations, "n": now_ms()},
        )
    _USERS.append(uid)
    return {"id": uid, "email": email}


def _login(client, email, password, ip):
    response = client.post("/api/auth/login", json={"email": email, "password": password},
                           headers={"CF-Connecting-IP": ip})
    client.cookies.clear()
    return response


def _fill_email_bucket(email):
    """What a stranger achieves with wrong passwords from a few other addresses."""
    for _ in range(auth_limits._LOGIN_EMAIL_MAX_ATTEMPTS + 5):
        check_rate_limit(f"login:email:{email.lower()}", auth_limits._LOGIN_EMAIL_MAX_ATTEMPTS,
                         auth_limits._LOGIN_WINDOW_MS)


@pytest.mark.parametrize("ip, subject", [
    (f"{PREFIX}::10", f"{PREFIX}::/64"),
    (f"{PREFIX}:ffff:ffff:ffff:ffff", f"{PREFIX}::/64"),
    (f"::ffff:{MAPPED_V4}", MAPPED_V4),
    (MAPPED_V4, MAPPED_V4),
    ("testclient", "testclient"),  # not an address (TestClient's peer): unchanged
])
def test_rate_subject_counts_a_64_and_unmaps_ipv4(ip, subject):
    assert auth_limits._rate_subject(ip) == subject


def test_one_64_shares_the_per_address_login_ceiling():
    _seed_user("ceiling")  # an initialized server: unknown emails answer 401, not the first-run 503
    client = _client()
    ceiling = auth_limits._LOGIN_IP_MAX_ATTEMPTS
    statuses = [
        _login(client, f"r1-v6-stuff{i}-{TAG}@tests.albayanhub.com", "Guess123!", _v6(i + 1)).status_code
        for i in range(ceiling + 1)
    ]
    assert statuses[:ceiling] == [401] * ceiling
    assert statuses[ceiling] == 429  # before: 401, every rotated address had a fresh allowance


def test_one_64_shares_the_password_reset_ceiling():
    client = _client()
    ceiling = auth_limits._RESET_IP_MAX_ATTEMPTS
    statuses = [
        client.post("/api/auth/password-reset/request",
                    json={"email": f"r1-v6-reset{i}-{TAG}@tests.albayanhub.com"},
                    headers={"CF-Connecting-IP": _v6(10_000 + i)}).status_code
        for i in range(ceiling + 1)
    ]
    assert statuses[:ceiling] == [200] * ceiling
    assert statuses[ceiling] == 429  # before: 200, and one more anonymous audit row per request


def test_a_sign_in_from_one_address_makes_its_whole_64_known():
    user = _seed_user("known")
    client = _client()
    assert _login(client, user["email"], PASSWORD, f"{PREFIX}::10").status_code == 200
    _fill_email_bucket(user["email"])

    # A brand-new address stays blocked: the IP-rotation defence is intact.
    assert _login(client, user["email"], PASSWORD, "192.0.2.200").status_code == 429
    # The phone's next IPv6 privacy address in the same /64 is known from the session row.
    ok = _login(client, user["email"], PASSWORD, f"{PREFIX}::99")
    assert ok.status_code == 200, ok.text  # before: 429 "Too many login attempts"

    # Once the sessions expired (deleted), the login audit row still makes the /64 known.
    with db_conn() as conn:
        stored = set(conn.execute(text("SELECT ip FROM sessions WHERE user_id=:uid"),
                                  {"uid": user["id"]}).scalars().all())
        conn.execute(text("DELETE FROM sessions WHERE user_id=:uid"), {"uid": user["id"]})
    assert stored == {f"{PREFIX}::10", f"{PREFIX}::99"}  # sessions keep the full address
    _fill_email_bucket(user["email"])
    assert _login(client, user["email"], PASSWORD, "192.0.2.201").status_code == 429
    again = _login(client, user["email"], PASSWORD, f"{PREFIX}::77")
    assert again.status_code == 200, again.text  # before: 429


def test_an_ipv4_mapped_address_shares_the_ipv4_bucket():
    email = f"r1-v6-mapped-{TAG}@tests.albayanhub.com"
    client = _client()
    for _ in range(auth_limits._LOGIN_MAX_ATTEMPTS):
        assert _login(client, email, "Guess123!", MAPPED_V4).status_code == 401
    # The same client written as ::ffff:a.b.c.d gets no fresh (ip,email) allowance.
    assert _login(client, email, "Guess123!", f"::ffff:{MAPPED_V4}").status_code == 429  # before: 401
