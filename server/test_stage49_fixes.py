"""
Tests for Stage 49 server-side fixes:
- Driver cannot RE-settle an already-Delivered receipt (terminal-state guard).
- Admin password change / soft-delete invalidates the target's sessions.
- Last-admin lockout guard.
- _client_ip no longer trusts the spoofable leftmost X-Forwarded-For.

Run with: PYTHONPATH=. pytest server/test_stage49_fixes.py -v
"""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

import server.main as main_module
from server.main import app, _client_ip
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})

ADMIN_EMAIL = os.getenv("TEST_ADMIN_EMAIL", "stage49admin@tests.albayanhub.com")
ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "TestPassword123!Secure")


def _ensure_admin(email, password, name="Admin"):
    pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"), {"e": email}
        ).mappings().first()
        if row:
            uid = str(row["id"])
            conn.execute(text(
                "UPDATE users SET role='Admin', deleted=false, password_hash=:h, password_salt=:s, "
                "password_algo=:a, password_iterations=:i, last_modified=:lm WHERE id=:id"
            ), {"h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "lm": now, "id": uid})
            return uid
        uid = new_id("user")
        conn.execute(text(
            "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
            "VALUES (:id,:name,:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
        ), {"id": uid, "name": name, "email": email, "perm": json_dumps({}),
            "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "now": now})
        return uid


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    init_db()
    _ensure_admin(ADMIN_EMAIL, ADMIN_PASSWORD)
    yield


def _admin_cookies():
    r = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    tok = r.cookies.get("albayan_session")
    try:
        client.cookies.clear()
    except Exception:
        pass
    return {"albayan_session": tok}


def _make_driver(admin_cookies, email):
    client.post("/api/users", json={
        "name": "Driver 49", "email": email, "role": "Delivery",
        "password": "DriverPass123!", "permissions": {"deliveries": ["view", "accept", "complete"]},
    }, cookies=admin_cookies)
    users = client.get("/api/users", cookies=admin_cookies).json()
    driver = next(u for u in users if u["email"] == email)
    r = client.post("/api/auth/login", json={"email": email, "password": "DriverPass123!"})
    assert r.status_code == 200, r.text
    tok = r.cookies.get("albayan_session")
    try:
        client.cookies.clear()
    except Exception:
        pass
    return driver["id"], {"albayan_session": tok}


class TestDriverCannotReSettle:
    def test_resettle_blocked(self):
        admin = _admin_cookies()
        driver_id, driver = _make_driver(admin, "driver49-resettle@tests.albayanhub.com")
        # Admin creates an In Progress receipt assigned to the driver.
        client.post("/api/collections/receipts", json={
            "id": "s49_receipt",
            "data": {
                "deliveryPersonId": driver_id, "deliveryStatus": "In Progress",
                "status": "Not Paid", "isPaid": False,
                "amountUSD": 100.0, "amountLocal": 500.0,
                "debtAmountLocal": 500.0, "debtAmountUSD": 100.0,
            },
        }, cookies=admin)

        # First legitimate settlement: In Progress -> Delivered, collected 500.
        r1 = client.patch("/api/collections/receipts/s49_receipt", json={"data": {
            "deliveryStatus": "Delivered",
            "finalReceiptNo": "77001",
            "receiptImage": "data:image/png;base64,AAAA",
            "amountCollectedFromCustomer": 500.0,
            "actualDeliveryFeeCollected": 0.0,
        }}, cookies=driver)
        assert r1.status_code == 200, r1.text

        # Re-settle attempt: Delivered -> Delivered with a smaller amount. The
        # terminal-state/idempotency guard reports this as a state conflict.
        r2 = client.patch("/api/collections/receipts/s49_receipt", json={"data": {
            "deliveryStatus": "Delivered",
            "finalReceiptNo": "77001",
            "receiptImage": "data:image/png;base64,BBBB",
            "amountCollectedFromCustomer": 0.0,
            "actualDeliveryFeeCollected": 0.0,
        }}, cookies=driver)
        assert r2.status_code == 409, r2.text
        conflict_reason = r2.json().get("detail", "").lower()
        assert "already" in conflict_reason
        assert "delivered" in conflict_reason

        # The recorded settlement is unchanged.
        got = client.get("/api/collections/receipts/s49_receipt", cookies=admin).json()["data"]
        assert float(got.get("amountCollectedFromCustomer")) == 500.0

    def test_driver_office_handover_is_rejected_after_delivered(self):
        admin = _admin_cookies()
        driver_id, driver = _make_driver(admin, "driver49-handover@tests.albayanhub.com")
        client.post("/api/collections/receipts", json={
            "id": "s49_handover",
            "data": {
                "deliveryPersonId": driver_id, "deliveryStatus": "In Progress",
                "status": "Not Paid", "isPaid": False,
                "amountUSD": 20.0, "amountLocal": 100.0,
                "debtAmountLocal": 100.0, "debtAmountUSD": 20.0,
            },
        }, cookies=admin)
        r1 = client.patch("/api/collections/receipts/s49_handover", json={"data": {
            "deliveryStatus": "Delivered", "finalReceiptNo": "77002",
            "receiptImage": "data:image/png;base64,AAAA",
            "amountCollectedFromCustomer": 100.0, "actualDeliveryFeeCollected": 0.0,
        }}, cookies=driver)
        assert r1.status_code == 200, r1.text
        # Office handover is an office/admin action, not a driver action.
        r2 = client.patch("/api/collections/receipts/s49_handover", json={
            "data": {"isReceivedInOffice": True},
        }, cookies=driver)
        assert r2.status_code == 403, r2.text


class TestAdminPasswordChangeKillsSessions:
    def test_password_change_invalidates_target_sessions(self):
        admin = _admin_cookies()
        email = "s49-victim@tests.albayanhub.com"
        client.post("/api/users", json={
            "name": "Victim", "email": email, "role": "Employee",
            "password": "OldPassword123!", "permissions": {},
        }, cookies=admin)
        users = client.get("/api/users", cookies=admin).json()
        victim = next(u for u in users if u["email"] == email)

        # Victim logs in — session valid.
        r = client.post("/api/auth/login", json={"email": email, "password": "OldPassword123!"})
        assert r.status_code == 200, r.text
        victim_cookies = {"albayan_session": r.cookies.get("albayan_session")}
        try:
            client.cookies.clear()
        except Exception:
            pass
        assert client.get("/api/auth/me", cookies=victim_cookies).status_code == 200

        # Admin resets the victim's password.
        assert client.patch(f"/api/users/{victim['id']}", json={"password": "NewPassword456!"},
                            cookies=admin).status_code == 200

        # Victim's old session is now rejected.
        assert client.get("/api/auth/me", cookies=victim_cookies).status_code == 401


class TestLastAdminGuard:
    def test_cannot_demote_or_delete_last_admin(self):
        # Solo admin authorizes AND is the target; when it's the only active
        # admin, demoting/deleting it must be blocked.
        solo_email = "s49-solo@tests.albayanhub.com"
        solo_id = _ensure_admin(solo_email, "SoloPass123!Secure", name="Solo")
        r = client.post("/api/auth/login", json={"email": solo_email, "password": "SoloPass123!Secure"})
        assert r.status_code == 200, r.text
        solo = {"albayan_session": r.cookies.get("albayan_session")}
        try:
            client.cookies.clear()
        except Exception:
            pass

        # Temporarily make solo the ONLY active admin.
        with db_conn() as conn:
            others = [str(x["id"]) for x in conn.execute(text(
                "SELECT id FROM users WHERE lower(role)='admin' AND deleted=false AND id != :id"
            ), {"id": solo_id}).mappings().all()]
            for oid in others:
                conn.execute(text("UPDATE users SET deleted=true WHERE id=:id"), {"id": oid})
        try:
            demote = client.patch(f"/api/users/{solo_id}", json={"role": "Employee"}, cookies=solo)
            assert demote.status_code == 400, demote.text
            assert "admin" in demote.json().get("detail", "").lower()

            delete = client.patch(f"/api/users/{solo_id}", json={"deleted": True}, cookies=solo)
            assert delete.status_code == 400, delete.text
        finally:
            with db_conn() as conn:
                for oid in others:
                    conn.execute(text("UPDATE users SET deleted=false WHERE id=:id"), {"id": oid})

    def test_can_demote_when_other_admins_exist(self):
        admin = _admin_cookies()
        # A second admin can be demoted while the primary admin remains.
        second_email = "s49-second-admin@tests.albayanhub.com"
        second_id = _ensure_admin(second_email, "SecondPass123!Secure", name="Second")
        r = client.patch(f"/api/users/{second_id}", json={"role": "Employee"}, cookies=admin)
        assert r.status_code == 200, r.text


class TestClientIpNotSpoofable:
    def _req(self, headers, host="10.0.0.1"):
        from starlette.datastructures import Headers

        class _R:
            pass
        r = _R()
        r.headers = Headers(headers)
        r.client = type("C", (), {"host": host})()
        return r

    def test_cf_connecting_ip_preferred(self, monkeypatch):
        monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)
        req = self._req({"cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8"})
        assert _client_ip(req) == "203.0.113.9"

    def test_xff_uses_rightmost_not_spoofable_leftmost(self, monkeypatch):
        monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)
        # A client-forged leftmost entry must NOT be returned.
        req = self._req({"x-forwarded-for": "66.66.66.66, 5.6.7.8"})
        assert _client_ip(req) == "5.6.7.8"

    def test_falls_back_to_socket_peer(self):
        req = self._req({})
        assert _client_ip(req) == "10.0.0.1"
