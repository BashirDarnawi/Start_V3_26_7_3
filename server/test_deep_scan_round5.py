"""Round 5 (2026-09-18): resource exhaustion, log privacy, native handoff."""

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.startup_support import safe_exception_text

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
PW = "Str0ngPassw0rd!r5"


def _seed_admin(suffix):
    uid = new_id("user")
    email = f"r5-{suffix}-{TAG}@tests.albayanhub.com"
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        conn.execute(text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                          "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                          "VALUES (:id,'R5 Admin',:email,'Admin','{}',:h,:s,:a,:i,false,:t,NULL,:t)"),
                     {"id": uid, "email": email, "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()})
    login = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    return uid, cookies


@pytest.fixture(scope="module", autouse=True)
def _db():
    init_db()


def test_anonymous_big_bodies_are_refused_before_parsing():
    big = "{" + ",".join(f'"k{i}": {{}}' for i in range(40000)) + "}"
    assert len(big) > 256 * 1024
    anonymous = client.post("/api/collections/customers", content=big, headers={"Content-Type": "application/json"})
    assert anonymous.status_code == 401 and "Sign in" in anonymous.text
    # A signed-in caller keeps the normal 10 MB budget (the body still fails validation, not size).
    _uid, cookies = _seed_admin("bodies")
    signed_in = client.post("/api/collections/customers", content=big, headers={"Content-Type": "application/json"}, cookies=cookies)
    assert signed_in.status_code in (400, 422), signed_in.text
    # Small anonymous bodies (login) are untouched.
    small = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "x"})
    assert small.status_code in (400, 401, 429), small.text


def test_validation_errors_do_not_echo_the_input():
    secret = f"hunter2-{TAG}"
    response = client.post("/api/auth/login", json={"email": "someone@example.com", "password": [secret]})
    assert response.status_code == 422, response.text
    assert secret not in response.text
    assert response.json()["detail"][0]["loc"][-1] == "password"


def test_receipt_listings_with_media_are_throttled_per_user():
    _uid, cookies = _seed_admin("media")
    statuses = [client.get("/api/collections/receipts?limit=500&include_media=true", cookies=cookies).status_code for _ in range(31)]
    assert statuses[:30] == [200] * 30 and statuses[30] == 429, statuses
    assert client.get("/api/collections/receipts?limit=25&include_media=true", cookies=cookies).status_code == 200
    assert client.get("/api/collections/receipts?limit=500&include_media=false", cookies=cookies).status_code == 200


def test_phone_collision_still_detected_with_the_narrow_scan():
    _uid, cookies = _seed_admin("phones")
    phone = f"09{secrets.randbelow(10**8):08d}"
    first = client.post("/api/collections/customers", json={"data": {"id": f"cust_r5_a_{TAG}", "name": "A", "phones": [phone]}}, cookies=cookies)
    assert first.status_code == 200, first.text
    second = client.post("/api/collections/customers", json={"data": {"id": f"cust_r5_b_{TAG}", "name": "B", "phone": phone}}, cookies=cookies)
    assert second.status_code == 409, second.text


def test_legacy_scalar_phones_do_not_crash_the_collision_scan():
    _uid, cookies = _seed_admin("scalar")
    phone = f"09{secrets.randbelow(10**8):08d}"
    legacy = client.post("/api/collections/customers", json={"data": {"id": f"cust_r5_legacy_{TAG}", "name": "Legacy", "phones": phone}}, cookies=cookies)
    assert legacy.status_code == 200, legacy.text
    clash = client.post("/api/collections/customers", json={"data": {"id": f"cust_r5_clash_{TAG}", "name": "Clash", "phones": [phone]}}, cookies=cookies)
    assert clash.status_code == 409, clash.text          # detected, not a 500
    other = client.post("/api/collections/customers", json={"data": {"id": f"cust_r5_other_{TAG}", "name": "Other", "phones": [f"09{secrets.randbelow(10**8):08d}"]}}, cookies=cookies)
    assert other.status_code == 200, other.text


def test_safe_exception_text_strips_bound_parameters():
    class Boom(Exception):
        pass
    text_value = safe_exception_text(Boom("INSERT failed [parameters: {'password_hash': 'abc'}]"))
    assert "password_hash" not in text_value and "redacted" in text_value


def test_fresh_login_handoff_caps_the_browser_session(monkeypatch):
    uid, cookies = _seed_admin("handoff")
    challenge = secrets.token_hex(32)
    with db_conn() as conn:
        before = conn.execute(text("SELECT expires_at FROM sessions WHERE user_id=:uid ORDER BY expires_at DESC LIMIT 1"), {"uid": uid}).scalar()
    minted = client.post("/api/auth/app-login/handoff", json={"challenge": challenge, "platform": "android", "consumeSession": True},
                         cookies=cookies, headers={"Origin": "http://testserver"})
    assert minted.status_code == 200, minted.text
    with db_conn() as conn:
        after = conn.execute(text("SELECT expires_at FROM sessions WHERE user_id=:uid ORDER BY expires_at DESC LIMIT 1"), {"uid": uid}).scalar()
    assert int(after) < int(before) and int(after) <= now_ms() + 10 * 60 * 1000 + 5000
    # The "Continue to the app" path (an existing browser session) leaves its session alone.
    uid2, cookies2 = _seed_admin("continue")
    with db_conn() as conn:
        before2 = conn.execute(text("SELECT expires_at FROM sessions WHERE user_id=:uid"), {"uid": uid2}).scalar()
    kept = client.post("/api/auth/app-login/handoff", json={"challenge": secrets.token_hex(32), "platform": "android"}, cookies=cookies2,
                       headers={"Origin": "http://testserver"})
    assert kept.status_code == 200, kept.text
    with db_conn() as conn:
        after2 = conn.execute(text("SELECT expires_at FROM sessions WHERE user_id=:uid"), {"uid": uid2}).scalar()
    assert int(after2) == int(before2)


def test_plain_http_localhost_is_not_a_trusted_origin():
    assert "http://localhost" not in main.MOBILE_APP_ORIGINS


def test_origin_check_needs_a_host_header():
    from fastapi import HTTPException, Request
    scope = {"type": "http", "method": "POST", "path": "/api/x", "headers": [(b"origin", b"https://evil.example")], "query_string": b""}
    with pytest.raises(HTTPException) as refused:
        main.require_same_origin(Request(scope))
    assert refused.value.status_code == 403


def test_logout_deletes_the_cookie_with_matching_attributes():
    _uid, cookies = _seed_admin("logout")
    response = client.post("/api/auth/logout", cookies=cookies, headers={"Origin": "http://testserver"})
    assert response.status_code == 200, response.text
    set_cookie = response.headers.get("set-cookie", "")
    assert "albayan_session=" in set_cookie and "HttpOnly" in set_cookie and "SameSite=lax" in set_cookie
