"""Review loop round 5, batch SEC: server input safety and privacy.

* n=1  a charge request (Add money) locks and re-checks its owner's users row first: a create that
       passed sign-in before the account was deleted gets 404 and leaves no pending PAY- request.
* n=3  a NUL character (a quoted "\\000" session cookie, a %00 in a URL id or query) never reaches a
       query: PostgreSQL cannot bind it (500 on every signed-in route); the cookie is no session and
       the address is a 400.
* n=4  an audit row fits its columns: an unknown 81+ character e-mail in a reset request is a 200.
* n=5/34 a huge ?offset= on /api/collections/* is clamped (the database's bigint overflowed: 500).
* n=6  a lone UTF-16 surrogate (valid JSON) in the Studio phone or in a repeated client key is a 400.
* n=7  staff ad top-up extensions are capped in total, and an end date that would pass year 9999 is a 400.
* n=8  a split-payment line with a microscopic rate2 cannot back a settled receipt's raise (409, not 500).
* n=9  the privacy-anonymize confirmation compares bytes: a non-ASCII paste is the 400, not a TypeError.
* n=33 PATCH /api/users/{id} with a no-op body returns no other account's e-mail or permissions to a
       caller without the matching users.* grant.

The suite runs on SQLite, which stores a NUL; the NUL tests put a connection in front of the real one
that refuses a NUL parameter exactly as psycopg does on PostgreSQL.

Every test builds its own users (unique e-mails per run) and removes the rows it adds.
"""

import json
import os
import secrets
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
import server.wallet_payments as wallet_payments_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id, parse_session_cookie_value
from server.systems.ads_studio.studio_profile import PHONE_REFUSAL_CODE, normalize_phone

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR5SecPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(main_module.app, headers={"Origin": "http://testserver"})
_counter = [0]


def _seed_user(label: str, role: str = "Employee", permissions: dict | None = None) -> dict:
    _counter[0] += 1
    uid = new_id("user")
    email = f"r5sec-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": f"R5 {label}", "email": email, "role": role, "perms": json_dumps(permissions or {}),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iter": _HASH.iterations, "now": now_ms()},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "email": email, "cookies": cookies}


def _user_row(user_id: str) -> dict:
    with db_conn() as conn:
        return dict(conn.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_id}).mappings().first())


@pytest.fixture(scope="module")
def admin():
    init_db()
    return _seed_user("admin", "Admin")


# ---------------------------------------------------------------- n=3: a NUL never reaches a query

class _NulRefusingConn:
    """psycopg 3 on PostgreSQL: a str parameter holding NUL cannot be bound (DataError)."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, statement, *args, **kwargs):
        params = args[0] if args else kwargs.get("parameters")
        rows = params if isinstance(params, list) else [params]
        for row in rows:
            if isinstance(row, dict) and any(isinstance(v, str) and "\x00" in v for v in row.values()):
                raise ValueError("PostgreSQL text fields cannot contain NUL (0x00) bytes")
        return self._conn.execute(statement, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


@contextmanager
def _postgres_like_db_conn():
    with db_conn() as conn:
        yield _NulRefusingConn(conn)


@pytest.fixture
def postgres_nul_rule(monkeypatch):
    monkeypatch.setattr(main_module, "db_conn", _postgres_like_db_conn)
    monkeypatch.setattr(wallet_payments_module, "db_conn", _postgres_like_db_conn)


def test_a_session_cookie_part_outside_the_id_alphabet_is_no_session():
    assert parse_session_cookie_value("\x00a.b") is None
    assert parse_session_cookie_value("sess_x.tok\x00y") is None
    assert parse_session_cookie_value("sess_x.") is None and parse_session_cookie_value(".tok_y") is None
    real = f"sess_{'a' * 32}.tok_{'b' * 32}"
    assert parse_session_cookie_value(real) == (f"sess_{'a' * 32}", f"tok_{'b' * 32}")


def test_a_nul_in_the_session_cookie_is_signed_out_not_a_500(admin, postgres_nul_rule):
    # Starlette unquotes the octal escape of a quoted cookie value into a real NUL.
    response = client.get("/api/auth/me", headers={"Cookie": 'albayan_session="\\000x.y"'})
    assert response.status_code == 401, response.text
    assert client.get("/api/auth/me", cookies=admin["cookies"]).status_code == 200  # a real session still works


def test_a_nul_in_a_url_id_or_query_is_a_400_before_any_query(admin, postgres_nul_rule):
    for path in (
        "/api/wallet/payment-requests/ab%00cd",
        "/api/collections/walletTransactions/ab%00cd",
        "/api/auth/me?probe=a%00b",
    ):
        response = client.get(path, cookies=admin["cookies"])
        assert response.status_code == 400, (path, response.text)
        assert "Invalid entity id" in response.json()["detail"]
    missing = client.get(f"/api/wallet/payment-requests/payreq_missing_{TAG}", cookies=admin["cookies"])
    assert missing.status_code == 404, missing.text  # an ordinary unknown id is unchanged


# ---------------------------------------------------------------- n=1: a charge request re-checks its owner

def test_a_charge_request_racing_the_account_delete_is_refused_and_leaves_no_row(admin):
    customer = _seed_user("charge-owner")
    stale = _user_row(customer["id"])  # what the request's sign-in saw before the delete committed
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET deleted = true WHERE id = :id"), {"id": customer["id"]})
    main_module.app.dependency_overrides[main_module.current_user] = lambda: stale
    try:
        response = client.post(
            "/api/wallet/payment-requests",
            json={"amountMinor": 500, "currency": "USD", "method": "adfali", "idempotencyKey": f"r5sec-charge-{TAG}"},
        )
    finally:
        main_module.app.dependency_overrides.pop(main_module.current_user, None)
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id FROM entities WHERE type = 'walletPaymentRequests' AND created_by = :uid"),
            {"uid": customer["id"]},
        ).all()
        conn.execute(text("DELETE FROM entities WHERE type = 'walletPaymentRequests' AND created_by = :uid"), {"uid": customer["id"]})
    assert response.status_code == 404, response.text
    assert rows == []


def test_a_live_account_still_creates_its_charge_request(admin):
    customer = _seed_user("charge-live")
    created = client.post(
        "/api/wallet/payment-requests",
        json={"amountMinor": 500, "currency": "USD", "method": "adfali", "idempotencyKey": f"r5sec-live-{TAG}"},
        cookies=customer["cookies"],
    )
    assert created.status_code == 200, created.text
    cancelled = client.post(f"/api/wallet/payment-requests/{created.json()['id']}/cancel", cookies=customer["cookies"])
    assert cancelled.status_code == 200, cancelled.text  # no pending charge outlives the test


# ---------------------------------------------------------------- n=4: an audit row fits its columns

def _audit_rows(prefix: str) -> list[dict]:
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(
            text("SELECT user_id, action, resource_type, resource_id FROM audit_logs WHERE resource_id LIKE :p"),
            {"p": f"{prefix}%"},
        ).mappings().all()]


def test_audit_cuts_its_values_to_the_column_widths(admin):
    prefix = f"r5sec-audit-{TAG}-"
    main_module.audit("u" * 120, "a" * 90, "t" * 90, prefix + "x" * 200, "long values", {})
    rows = _audit_rows(prefix)
    assert len(rows) == 1, rows
    row = rows[0]
    assert len(row["resource_id"]) == 80 and len(row["user_id"]) == 80
    assert len(row["action"]) == 64 and len(row["resource_type"]) == 64


def test_a_reset_request_for_a_long_unknown_email_is_the_neutral_ok(admin):
    reset_rate_limit("reset:ip:testclient")
    local = f"r5sec{TAG}".ljust(64, "a")
    email = f"{local}@{'b' * 63}.{'c' * 40}.com"
    assert len(email) > 80
    response = client.post("/api/auth/password-reset/request", json={"email": email})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True}
    rows = _audit_rows(local)
    assert rows and all(len(r["resource_id"]) <= 80 for r in rows), rows
    reset_rate_limit("reset:ip:testclient")


# ---------------------------------------------------------------- n=5/34: a huge list offset is clamped

def test_a_huge_collection_offset_is_an_empty_page_not_a_500(admin):
    employee = _seed_user("offset")
    huge = "100000000000000000000"
    personal = client.get(f"/api/collections/walletTransactions?offset={huge}", cookies=employee["cookies"])
    assert personal.status_code == 200, personal.text
    assert personal.json() == []
    rates = client.get(f"/api/collections/exchangeRateHistory?offset={huge}", cookies=employee["cookies"])
    assert rates.status_code == 200, rates.text
    assert rates.json() == []
    staff = client.get(f"/api/collections/customers?offset={huge}", cookies=admin["cookies"])
    assert staff.status_code == 200, staff.text
    assert staff.json() == []


# ---------------------------------------------------------------- n=6: a lone surrogate is a 400

def _raw_put(path: str, raw: str, cookies: dict):
    return client.put(path, content=raw.encode("utf-8"), headers={"Content-Type": "application/json"}, cookies=cookies)


def test_a_lone_surrogate_in_the_studio_phone_is_the_phone_refusal(admin):
    assert normalize_phone(json.loads('"\\ud800091"')) == ""
    owner = _seed_user("phone")
    response = _raw_put("/api/studio/profile", '{"whatsappNumber":"\\ud800091","whatsappConsent":true}', owner["cookies"])
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == PHONE_REFUSAL_CODE


def test_a_lone_surrogate_in_an_unknown_key_is_the_unknown_field_refusal(admin):
    owner = _seed_user("unknown-key")
    response = _raw_put("/api/studio/profile", '{"\\ud800x":1}', owner["cookies"])
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "UNKNOWN_FIELD" and "Unknown field '?x'" in detail["message"], detail


def test_campaign_field_and_relationship_errors_can_carry_a_lone_surrogate_key():
    with pytest.raises(HTTPException) as unknown:
        main_module._prepare_ad_campaign_fields({"\ud800": 1}, strict=False, reject_unknown=True)
    assert unknown.value.status_code == 400
    str(unknown.value.detail).encode("utf-8")  # a JSON reply can carry it
    assert unknown.value.detail.startswith("Unsupported campaign field: ")
    with pytest.raises(HTTPException) as unsafe:
        main_module.validate_relationship_ids({"\ud800": {"userId": "bad id!"}}, "clothes order")
    assert unsafe.value.status_code == 400
    assert unsafe.value.detail == "Unsafe relationship identifier at clothes order.?.userId"


# ---------------------------------------------------------------- n=7: ad top-up extensions stay in range

def _create(collection: str, entity_id: str, data: dict, cookies: dict) -> dict:
    response = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert response.status_code == 200, response.text
    return response.json()


def _paid_ad(admin: dict, label: str, end_date: str) -> tuple[str, str, str, dict]:
    customer_id, receipt_id, ad_id = f"r5sec_cu_{label}_{TAG}", f"r5sec_rc_{label}_{TAG}", f"r5sec_ad_{label}_{TAG}"
    _create("customers", customer_id, {"name": customer_id, "phones": [f"09{secrets.randbelow(10 ** 8):08d}"]}, admin["cookies"])
    _create("receipts", receipt_id, {"recordType": "receipt", "customerId": customer_id, "amountUSD": 100, "amountLocal": 500,
                                     "exchangeRate": 5, "status": "Paid", "isPaid": True}, admin["cookies"])
    created = client.post("/api/ads/mutate", json={
        "action": "create", "adId": ad_id, "idempotencyKey": f"r5sec-{label}-create-{TAG}",
        "data": {"customerId": customer_id, "paymentStatus": "paid", "exchangeRate": 5, "startDate": "2026-09-01",
                 "endDate": end_date, "receiptAllocations": [{"receiptId": receipt_id, "amountUSD": 50}]},
    }, cookies=admin["cookies"])
    assert created.status_code == 200, created.text
    return customer_id, receipt_id, ad_id, created.json()["ad"]


def _topup(admin: dict, ad: dict, key: str, topups: list, receipt_id: str):
    return client.post("/api/ads/mutate", json={
        "action": "update", "adId": ad["id"], "idempotencyKey": key, "expectedLastModified": ad["lastModified"],
        "data": {"topUps": topups, "receiptAllocations": [{"receiptId": receipt_id, "amountUSD": 50}]},
    }, cookies=admin["cookies"])


def _drop(*keys: tuple[str, str]) -> None:
    with db_conn() as conn:
        for entity_type, entity_id in keys:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": entity_type, "id": entity_id})


def test_top_up_extensions_are_capped_in_total_and_never_overflow_the_end_date(admin):
    customer_id, receipt_id, ad_id, ad = _paid_ad(admin, "many", "2026-10-01T00:00:00Z")
    try:
        many = _topup(admin, ad, f"r5sec-many-{TAG}", [{"amount": 0, "extendDays": 36500}] * 81, receipt_id)
        assert many.status_code == 400, many.text
        assert many.json()["detail"] == "Invalid top-up extension"
        over = _topup(admin, ad, f"r5sec-over-{TAG}", [{"amount": 0, "extendDays": 36500}, {"amount": 0, "extendDays": 1}], receipt_id)
        assert over.status_code == 400, over.text
        with db_conn() as conn:
            stored = json_loads(conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"), {"id": ad_id}).scalar())
        assert stored.get("endDate") == ad["data"].get("endDate") and not stored.get("topUps")
        fine = _topup(admin, ad, f"r5sec-fine-{TAG}", [{"amount": 0, "extendDays": 30}], receipt_id)
        assert fine.status_code == 200, fine.text
        assert fine.json()["ad"]["data"]["endDate"].startswith("2026-10-31")
    finally:
        _drop(("ads", ad_id), ("receipts", receipt_id), ("customers", customer_id))

    customer_id, receipt_id, ad_id, ad = _paid_ad(admin, "edge", "9999-12-01T00:00:00Z")
    try:
        edge = _topup(admin, ad, f"r5sec-edge-{TAG}", [{"amount": 0, "extendDays": 100}], receipt_id)
        assert edge.status_code == 400, edge.text
        assert edge.json()["detail"] == "Invalid top-up extension"
    finally:
        _drop(("ads", ad_id), ("receipts", receipt_id), ("customers", customer_id))


# ---------------------------------------------------------------- n=8: a microscopic rate2 backs nothing

def test_a_microscopic_rate2_backs_no_credit():
    assert main_module._receipt_payments_credit_minor([{"amount": 1e7, "rate": 1, "rate2": 1e-300, "method": "Cash"}]) is None
    assert main_module._receipt_payments_credit_minor([{"amount": 1e7, "rate": 1, "rate2": 1e300, "method": "Cash"}]) is None
    assert main_module._receipt_payments_credit_minor([{"amount": 500, "rate": 1, "rate2": 5, "method": "Cash (LYD)"}]) == 10000


def test_raising_a_paid_receipt_with_a_microscopic_rate2_is_the_409(admin):
    customer_id, receipt_id = f"r5sec_cu_rate2_{TAG}", f"r5sec_rc_rate2_{TAG}"
    _create("customers", customer_id, {"name": customer_id, "phones": [f"09{secrets.randbelow(10 ** 8):08d}"]}, admin["cookies"])
    receipt = _create("receipts", receipt_id, {
        "recordType": "receipt", "customerId": customer_id, "amountUSD": 100, "amountLocal": 500, "exchangeRate": 5,
        "status": "Paid", "isPaid": True, "payments": [{"method": "Cash (LYD)", "amount": 500, "rate": 1, "rate2": 5}],
    }, admin["cookies"])
    try:
        response = client.patch(f"/api/collections/receipts/{receipt_id}", json={
            "data": {"amountUSD": 200, "payments": [{"method": "Cash", "amount": 10000000, "rate": 1, "rate2": 1e-300}]},
            "expectedLastModified": receipt["lastModified"],
        }, cookies=admin["cookies"])
        assert response.status_code == 409, response.text
        with db_conn() as conn:
            stored = json_loads(conn.execute(text("SELECT data_json FROM entities WHERE type='receipts' AND id=:id"), {"id": receipt_id}).scalar())
        assert stored["amountUSD"] == 100
    finally:
        _drop(("receipts", receipt_id), ("customers", customer_id))


# ---------------------------------------------------------------- n=9: the anonymize confirmation compares bytes

def test_a_non_ascii_anonymize_confirmation_is_the_400(admin):
    target = _seed_user("anon-target")
    path = f"/api/users/{target['id']}/privacy-anonymize"
    for confirmation in (f"ANONYMIZE {target['id']}‏", "ANONYMIZE ١٢"):
        response = client.post(path, json={"confirmation": confirmation}, cookies=admin["cookies"])
        assert response.status_code == 400, response.text
        assert "to confirm privacy anonymization" in response.json()["detail"]
    lone = client.post(path, content=b'{"confirmation":"\\ud800"}', headers={"Content-Type": "application/json"}, cookies=admin["cookies"])
    assert lone.status_code == 400, lone.text
    assert _user_row(target["id"])["email"] == target["email"]  # nothing was anonymized


# ---------------------------------------------------------------- n=33: a no-op PATCH reveals no other account

def test_a_no_op_user_patch_returns_no_other_account_without_a_users_grant(admin):
    viewer = _seed_user("viewer", permissions={"ads": ["view"]})
    deleter = _seed_user("deleter", permissions={"users": ["delete"]})
    target = _seed_user("target", permissions={"users": ["resetPassword"], "receipts": ["view"]})
    before = int(_user_row(target["id"])["last_modified"])
    for actor in (viewer, deleter):
        for body in ({}, {"role": "Employee"}):
            response = client.patch(f"/api/users/{target['id']}", json=body, cookies=actor["cookies"])
            assert response.status_code == 403, (actor["email"], body, response.text)
            assert target["email"] not in response.text and "resetPassword" not in response.text
    # No grant at all: an unknown id answers the same 403 (no existence oracle).
    unknown = client.patch(f"/api/users/user_missing_{TAG}", json={}, cookies=viewer["cookies"])
    assert unknown.status_code == 403, unknown.text
    # A real edit by a granted manager still works; a caller's own no-op still returns their own row.
    renamed = client.patch(f"/api/users/{viewer['id']}", json={"name": "Renamed By Deleter"}, cookies=deleter["cookies"])
    assert renamed.status_code == 403  # users.delete is not users.edit
    own = client.patch(f"/api/users/{viewer['id']}", json={}, cookies=viewer["cookies"])
    assert own.status_code == 200 and own.json()["id"] == viewer["id"], own.text
    # An admin's no-op body answers the row but writes and audits nothing.
    noop = client.patch(f"/api/users/{target['id']}", json={}, cookies=admin["cookies"])
    assert noop.status_code == 200 and noop.json()["id"] == target["id"], noop.text
    assert int(_user_row(target["id"])["last_modified"]) == before
    with db_conn() as conn:
        audited = conn.execute(
            text("SELECT COUNT(*) FROM audit_logs WHERE action = 'update' AND resource_type = 'users' AND resource_id = :id"),
            {"id": target["id"]},
        ).scalar()
    assert int(audited or 0) == 0
    deleted = client.patch(f"/api/users/{target['id']}", json={"deleted": True}, cookies=deleter["cookies"])
    assert deleted.status_code == 200, deleted.text  # the grant the deleter does hold still works
