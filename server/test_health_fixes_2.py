"""
Regression tests for the 2026-07-04 health-scan Stage 2 backend fixes.

Covers:
  - /api/bootstrap now scopes Delivery-role users to their assigned records
    (was: returned the entire database to any authenticated user).
  - Receipt serialNumber is validated independently of finalReceiptNo
    (was: only the first non-empty of the two was checked).
  - Delivery-role settlement fields (collected amount, proof photo) are stripped
    from any update that is not the server-validated Delivered transition.

Run with the standard recipe:
  docker run ... python -m pytest server/test_health_fixes_2.py -v
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Match test_main.py: in-memory SQLite shared via StaticPool.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.main import app
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})

DRIVER_EMAIL = "driver1@tests.albayanhub.com"
OTHER_DRIVER_EMAIL = "driver2@tests.albayanhub.com"
ADMIN_EMAIL = "hf2admin@tests.albayanhub.com"
PASSWORD = "TestPassword123!Secure"


def _make_user(email: str, role: str, permissions: dict | None = None) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
                {"email": email},
            )
            .mappings()
            .first()
        )
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(
            text(
                """
                INSERT INTO users (
                  id, name, email, role, permissions_json,
                  password_hash, password_salt, password_algo, password_iterations,
                  deleted, created_at, created_by, last_modified
                ) VALUES (
                  :id, :name, :email, :role, :permissions_json,
                  :password_hash, :password_salt, :password_algo, :password_iterations,
                  false, :created_at, :created_by, :last_modified
                )
                """
            ),
            {
                "id": uid,
                "name": role,
                "email": email,
                "role": role,
                "permissions_json": json_dumps(permissions or {}),
                "password_hash": pw.hash_hex,
                "password_salt": pw.salt_hex,
                "password_algo": pw.algo,
                "password_iterations": pw.iterations,
                "created_at": now,
                "created_by": uid,
                "last_modified": now,
            },
        )
        return uid


def _insert_receipt(rid: str, data: dict) -> None:
    now = now_ms()
    data = dict(data)
    data.setdefault("id", rid)
    with db_conn() as conn:
        conn.execute(
            text(
                """
                INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                VALUES ('receipts', :id, :data_json, false, :created_at, 'system', :last_modified)
                """
            ),
            {"id": rid, "data_json": json_dumps(data), "created_at": now, "last_modified": now},
        )


def _insert_ad(aid: str, data: dict) -> None:
    now = now_ms()
    data = dict(data)
    data.setdefault("id", aid)
    with db_conn() as conn:
        conn.execute(
            text(
                """
                INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                VALUES ('ads', :id, :data_json, false, :created_at, 'system', :last_modified)
                """
            ),
            {"id": aid, "data_json": json_dumps(data), "created_at": now, "last_modified": now},
        )


def _login(email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, f"login failed for {email}: {resp.status_code} {resp.text[:200]}"
    token = resp.cookies.get("albayan_session")
    try:
        client.cookies.clear()
    except Exception:
        pass
    return token


@pytest.fixture(scope="module", autouse=True)
def setup():
    init_db()
    driver_id = _make_user(DRIVER_EMAIL, "Delivery")
    other_id = _make_user(OTHER_DRIVER_EMAIL, "Delivery")
    # Grant admin-like full permissions via role 'Admin'.
    _make_user(ADMIN_EMAIL, "Admin")

    # One receipt assigned to driver1, one to driver2.
    _insert_receipt(
        "hf2_r_mine",
        {"customerId": "c_mine", "deliveryPersonId": driver_id, "deliveryStatus": "In Progress", "amountLocal": 100},
    )
    _insert_receipt(
        "hf2_r_theirs",
        {"customerId": "c_theirs", "deliveryPersonId": other_id, "deliveryStatus": "In Progress", "amountLocal": 999},
    )
    yield


class TestBootstrapDeliveryScoping:
    def test_driver_bootstrap_only_sees_assigned_records(self):
        token = _login(DRIVER_EMAIL)
        resp = client.get("/api/bootstrap", cookies={"albayan_session": token})
        assert resp.status_code == 200
        receipts = resp.json().get("receipts", [])
        ids = {r.get("id") for r in receipts}
        assert "hf2_r_mine" in ids, "driver must still see their own assigned receipt"
        assert "hf2_r_theirs" not in ids, "driver must NOT see another driver's receipt via bootstrap"

    def test_admin_bootstrap_sees_all(self):
        token = _login(ADMIN_EMAIL)
        resp = client.get("/api/bootstrap", cookies={"albayan_session": token})
        assert resp.status_code == 200
        ids = {r.get("id") for r in resp.json().get("receipts", [])}
        assert {"hf2_r_mine", "hf2_r_theirs"}.issubset(ids), "admin must still get the full dataset"


class TestSerialIndependentValidation:
    def test_invalid_serial_alongside_valid_final_no_is_rejected(self):
        token = _login(ADMIN_EMAIL)
        resp = client.post(
            "/api/collections/receipts",
            json={"id": "hf2_serial_bad", "data": {"finalReceiptNo": "7001", "serialNumber": "0123", "amountLocal": 10}},
            cookies={"albayan_session": token},
        )
        # serialNumber "0123" has a leading zero -> must be rejected even though
        # finalReceiptNo is valid.
        assert resp.status_code == 400, resp.text[:200]

    def test_distinct_valid_serial_is_reserved_for_uniqueness(self):
        token = _login(ADMIN_EMAIL)
        # Both distinct + valid -> accepted, and BOTH values become reserved.
        r1 = client.post(
            "/api/collections/receipts",
            json={"id": "hf2_serial_ok", "data": {"finalReceiptNo": "7002", "serialNumber": "7003", "amountLocal": 10}},
            cookies={"albayan_session": token},
        )
        assert r1.status_code == 200, r1.text[:200]
        # Reusing the serialNumber "7003" on a new receipt must now conflict.
        r2 = client.post(
            "/api/collections/receipts",
            json={"id": "hf2_serial_dup", "data": {"serialNumber": "7003", "amountLocal": 10}},
            cookies={"albayan_session": token},
        )
        assert r2.status_code == 409, r2.text[:200]


class TestDeliverySettlementLockdown:
    def test_driver_cannot_rewrite_collected_amount_without_delivered_transition(self):
        token = _login(DRIVER_EMAIL)
        # Non-Delivered update trying to set collected amount + swap proof photo.
        resp = client.patch(
            "/api/collections/receipts/hf2_r_mine",
            json={"data": {"amountCollectedFromCustomer": 1, "receiptImage": "data:image/png;base64,AAAA"}},
            cookies={"albayan_session": token},
        )
        # Either the settlement fields are stripped (leaving nothing to update ->
        # 400) or the update succeeds but those fields were NOT written.
        with db_conn() as conn:
            row = (
                conn.execute(
                    text("SELECT data_json FROM entities WHERE type='receipts' AND id='hf2_r_mine'"),
                )
                .mappings()
                .first()
            )
        import json as _json
        data = _json.loads(row["data_json"])
        assert "amountCollectedFromCustomer" not in data or data.get("amountCollectedFromCustomer") in (None, "", 0), (
            "driver must not be able to write amountCollectedFromCustomer outside a Delivered confirmation"
        )
        assert not str(data.get("receiptImage") or "").startswith("data:image/png;base64,AAAA"), (
            "driver must not be able to swap the proof photo outside a Delivered confirmation"
        )


def _driver_id() -> str:
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
                {"e": DRIVER_EMAIL},
            )
            .mappings()
            .first()
        )
    return str(row["id"])


class TestAdDeliveryTerminalStateLockdown:
    def test_driver_cannot_reopen_a_delivered_ad(self):
        did = _driver_id()
        _insert_ad("hf2_ad_delivered", {"deliveryPersonId": did, "deliveryStatus": "Delivered", "amountUSD": 50})
        token = _login(DRIVER_EMAIL)
        # Attempt to move the ad OUT of the terminal 'Delivered' state.
        resp = client.patch(
            "/api/collections/ads/hf2_ad_delivered",
            json={"data": {"deliveryStatus": "In Progress"}},
            cookies={"albayan_session": token},
        )
        assert resp.status_code == 400, resp.text[:200]
        # State must be unchanged on the server.
        with db_conn() as conn:
            row = (
                conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id='hf2_ad_delivered'"))
                .mappings()
                .first()
            )
        import json as _json
        assert _json.loads(row["data_json"]).get("deliveryStatus") == "Delivered"

    def test_driver_can_still_progress_an_ad_forward(self):
        did = _driver_id()
        _insert_ad("hf2_ad_progress", {
            "deliveryPersonId": did, "deliveryStatus": "In Progress",
            "amountUSD": 50, "isPaid": True,
        })
        token = _login(DRIVER_EMAIL)
        # The normal forward flow (In Progress -> Delivered) must still work.
        resp = client.patch(
            "/api/collections/ads/hf2_ad_progress",
            json={"data": {"deliveryStatus": "Delivered"}},
            cookies={"albayan_session": token},
        )
        assert resp.status_code == 200, resp.text[:200]
