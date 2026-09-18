"""Deep-scan round 10: business-day dates, import/export safety, tab identity, backups, workers."""

import os
import secrets
import threading
from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import main, operations, profitability, full_backup
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.db import db_conn, init_db, json_dumps, now_ms

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r10-admin-{TAG}@tests.albayanhub.com"
PASSWORD = "Round10Pass123!"


def _seed_user(email: str, role: str, permissions: dict) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": email.split("@")[0], "email": email, "role": role, "perms": json_dumps(permissions),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    return uid


def _login(email: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def staff():
    init_db()
    admin_id = _seed_user(ADMIN_EMAIL, "Admin", {})
    return {"admin": _login(ADMIN_EMAIL), "admin_id": admin_id}


# ---------------------------------------------------------------- business day, not the UTC day

def test_dollar_purchase_date_is_checked_against_the_business_day(monkeypatch):
    monkeypatch.setattr(operations, "_business_today", lambda: date(2030, 6, 2))
    clean = profitability.validate_dollar_purchase({"purchaseDate": "2030-06-02", "amountUSD": 100, "rateLYD": 5})
    assert clean["purchaseDate"] == "2030-06-02"
    with pytest.raises(HTTPException) as exc:
        profitability.validate_dollar_purchase({"purchaseDate": "2030-06-03", "amountUSD": 100, "rateLYD": 5})
    assert exc.value.status_code == 400


def test_reconciliation_readiness_uses_the_business_day(monkeypatch):
    monkeypatch.setattr(main, "_business_today", lambda: date(2030, 1, 2))
    assert main._financial_ad_reconciliation_ready({"endDate": "2030-01-01"}) is True
    assert main._financial_ad_reconciliation_ready({"endDate": "2030-01-02"}) is False


def test_campaign_start_check_uses_the_business_day(monkeypatch):
    from server import ad_campaign_fields
    monkeypatch.setattr(operations, "_business_today", lambda: date(2030, 3, 10))
    src = open(ad_campaign_fields.__file__, encoding="utf-8").read()
    assert "_business_today" in src and "datetime.now(timezone.utc).date()" not in src.split("startDate cannot be in the past")[0][-400:]


# ---------------------------------------------------------------- a tab must not act under another account

def test_read_with_a_foreign_account_header_is_refused(staff):
    ok = client.get("/api/auth/me", cookies=staff["admin"], headers={"X-Albayan-User": staff["admin_id"]})
    assert ok.status_code == 200, ok.text
    other = client.get("/api/auth/me", cookies=staff["admin"], headers={"X-Albayan-User": "user_someone_else"})
    assert other.status_code == 401, other.text
    assert "another tab" in other.text


# ---------------------------------------------------------------- relationship ids are validated after sanitising

def test_relationship_id_smuggled_through_a_rewritten_key_is_refused(staff):
    r = client.post("/api/collections/customers",
                    json={"id": f"r10_cust_{TAG}", "data": {"name": "Smuggle", "phones": [f"09{secrets.randbelow(10**8):08d}"],
                                                            "customer<Id": "../x y"}},
                    cookies=staff["admin"])
    assert r.status_code == 400, r.text


# ---------------------------------------------------------------- full backup: a busy slot never burns the daily quota

def test_busy_backup_slot_does_not_consume_the_daily_quota(staff):
    from server.rate_limiter import check_rate_limit, reset_rate_limit
    key = f"full-backup:{staff['admin_id']}"
    reset_rate_limit(key)
    assert full_backup._STREAM_SLOT.acquire(blocking=False)
    try:
        r = client.get("/api/admin/backup/full", cookies=staff["admin"])
        assert r.status_code == 503, r.text
    finally:
        full_backup._STREAM_SLOT.release()
    allowed, left, _ = check_rate_limit(key, max_attempts=3, window_ms=86_400_000)
    assert allowed and left == 2, (allowed, left)  # nothing was consumed by the refused call
    reset_rate_limit(key)


# ---------------------------------------------------------------- workers

def test_meta_sync_loop_stamps_before_the_call():
    from server import meta_ads
    src = open(meta_ads.__file__, encoding="utf-8").read()
    idx = src.index("sync_due_meta_ads()\n")
    before = src[max(0, idx - 300):idx]
    assert "last_sync_monotonic = current" in before


def test_bulk_import_stamps_rows_inside_the_transaction():
    src = open(main.__file__, encoding="utf-8").read()
    start = src.index("_SQLITE_FINANCIAL_LOCK), db_conn() as conn:", src.index("def admin_bulk_import("))
    assert "now = now_ms()" in src[start:start + 400]


# ---------------------------------------------------------------- Social Studio: page ids are durable page by page

import server.social_studio as studio  # noqa: E402
from server.db import json_loads  # noqa: E402
from server.test_social_studio import (  # noqa: F401, E402  (graph/_fresh are fixtures)
    API as SOCIAL_API,
    _fresh,
    _insert_user,
    _link,
    _login as _social_login,
    _post,
    _subscribe,
    client as social_client,
    graph,
)


@pytest.fixture(scope="module")
def actors():  # the shape test_social_studio's autouse _fresh fixture expects
    init_db()
    out = {}
    admin_email = f"r10-sadmin-{TAG}@tests.albayanhub.com"
    out["admin"] = {"id": _insert_user("R10 Admin", admin_email, "Admin"), "cookies": _social_login(admin_email)}
    email = f"r10-a-{TAG}@tests.albayanhub.com"
    uid = _insert_user("R10 a", email, "Employee")
    _subscribe(uid)
    out["a"] = {"id": uid, "cookies": _social_login(email)}
    return out


def test_page_ids_are_written_before_the_next_page_is_published(actors, graph, monkeypatch):
    cookies = actors["a"]["cookies"]
    p1 = _link(actors, "a", f"54{secrets.randbelow(10**11):011d}")
    p2 = _link(actors, "a", f"55{secrets.randbelow(10**11):011d}")
    post = _post(cookies, [p1["id"], p2["id"]], caption="Durable").json()
    calls: list[int] = []
    seen_mid_publish: dict = {}

    def crash_on_second_page(client_, page_data, post_id, data):
        calls.append(1)
        if len(calls) == 1:
            return "fbpost_first"
        with db_conn() as conn:  # what a kill right now would leave behind
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": post_id}).mappings().first()
        seen_mid_publish["results"] = (json_loads(row["data_json"]) or {}).get("results") or []
        raise RuntimeError("simulated crash before the final write")

    monkeypatch.setattr(studio, "_publish_to_page", crash_on_second_page)
    try:
        social_client.post(f"{SOCIAL_API}/posts/{post['id']}/publish", cookies=cookies)
    except RuntimeError:
        pass
    assert [r["metaPostId"] for r in seen_mid_publish["results"]] == ["fbpost_first"], seen_mid_publish
    # a retry publishes only the page that never got the post
    monkeypatch.setattr(studio, "_publish_to_page", lambda c, page_data, post_id, data: "fbpost_second")
    retried = social_client.post(f"{SOCIAL_API}/posts/{post['id']}/publish", cookies=cookies).json()
    ids = {r["pageId"]: r["metaPostId"] for r in retried["results"]}
    assert ids == {p1["id"]: "fbpost_first", p2["id"]: "fbpost_second"}, retried["results"]
