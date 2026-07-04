"""
Integration tests for Albayan Manager API

Run with: 
  cd /path/to/Start_V3
  docker compose exec albayan pytest server/test_main.py -v

Or locally:
  cd /path/to/Start_V3
  PYTHONPATH=. pytest server/test_main.py -v
"""
import sys
import os
from pathlib import Path

# Add parent directory to Python path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

# Use in-memory SQLite for testing (shared via StaticPool in server.db.get_engine)
os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

# Import after env/path are set
from sqlalchemy import text
from server.main import app
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

# Send an Origin header matching the test host so the CSRF same-origin check
# (require_same_origin) accepts requests, like a real browser would.
client = TestClient(app, headers={"Origin": "http://testserver"})

# Test credentials - use environment variables with fallback for CI/local testing
# In production CI, set these via secrets; locally, defaults are fine for isolated test DBs
# Note: the domain must be a normally-formed one — the login endpoint validates
# emails and rejects reserved TLDs like .test, so "@albayan.test" cannot log in.
TEST_ADMIN_EMAIL = os.getenv("TEST_ADMIN_EMAIL", "testadmin@tests.albayanhub.com")
TEST_ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "TestPassword123!Secure")


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    """Initialize test database"""
    init_db()
    # Ensure a known admin user exists for auth-dependent tests.
    pw = hash_password(TEST_ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
                {"email": TEST_ADMIN_EMAIL},
            )
            .mappings()
            .first()
        )
        if row:
            user_id = str(row["id"])
            conn.execute(
                text(
                    """
                    UPDATE users
                    SET
                      name = :name,
                      role = 'Admin',
                      permissions_json = :permissions_json,
                      password_hash = :password_hash,
                      password_salt = :password_salt,
                      password_algo = :password_algo,
                      password_iterations = :password_iterations,
                      deleted = false,
                      last_modified = :last_modified
                    WHERE id = :id
                    """
                ),
                {
                    "name": "Admin",
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "last_modified": now,
                    "id": user_id,
                },
            )
        else:
            user_id = new_id("user")
            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id, name, email, role, permissions_json,
                      password_hash, password_salt, password_algo, password_iterations,
                      deleted, created_at, created_by, last_modified
                    )
                    VALUES (
                      :id, :name, :email, 'Admin', :permissions_json,
                      :password_hash, :password_salt, :password_algo, :password_iterations,
                      false, :created_at, :created_by, :last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": "Admin",
                    "email": TEST_ADMIN_EMAIL,
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "created_at": now,
                    "created_by": user_id,
                    "last_modified": now,
                },
            )
    yield


@pytest.fixture(scope="module")
def admin_session():
    """
    Get admin session token for testing.
    
    Uses an auto-created test admin user from setup_database.
    """
    response = client.post("/api/auth/login", json={
        "email": TEST_ADMIN_EMAIL,
        "password": TEST_ADMIN_PASSWORD
    })
    
    if response.status_code == 200:
        session_token = response.cookies.get("albayan_session")
        # Important: do NOT let auth cookies persist on the global TestClient instance.
        # Many tests below intentionally call endpoints without cookies to assert 401/403.
        try:
            client.cookies.clear()
        except Exception:
            pass
        return session_token
    
    pytest.fail(f"Could not login as test admin (status={response.status_code}): {response.text[:200]}")


class TestAuthentication:
    """Test authentication and authorization"""
    
    def test_login_with_valid_credentials(self, admin_session):
        """Should login successfully with correct credentials"""
        assert admin_session is not None
    
    def test_login_with_invalid_credentials(self):
        """Should reject invalid credentials"""
        response = client.post("/api/auth/login", json={
            "email": "admin@test.com",
            "password": "WrongPassword"
        })
        assert response.status_code in [401, 403]
    
    def test_bootstrap_requires_auth(self):
        """Should require authentication for bootstrap"""
        response = client.get("/api/bootstrap")
        assert response.status_code == 401
    
    def test_bootstrap_with_auth(self, admin_session):
        """Should return bootstrap data when authenticated"""
        response = client.get(
            "/api/bootstrap",
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        data = response.json()
        assert "user" in data
        assert "receipts" in data
        assert "ads" in data


class TestReceipts:
    """Test receipt creation and validation"""
    
    def test_create_valid_receipt(self, admin_session):
        """Should create receipt with valid data"""
        receipt_data = {
            "id": "test_receipt_1",
            "data": {
                "customerId": "cust_1",
                "amountLocal": 100.0,
                "amountUSD": 20.0,
                "status": "Paid",
                "serialNumber": "123",
                "isPaid": True
            }
        }
        
        response = client.post(
            "/api/collections/receipts",
            json=receipt_data,
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "test_receipt_1"
    
    def test_reject_duplicate_receipt_number(self, admin_session):
        """Should reject duplicate receipt serial numbers"""
        # First receipt
        client.post(
            "/api/collections/receipts",
            json={
                "id": "test_receipt_2",
                "data": {"serialNumber": "456", "amountLocal": 100}
            },
            cookies={"albayan_session": admin_session}
        )
        
        # Try duplicate
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_receipt_3",
                "data": {"serialNumber": "456", "amountLocal": 200}
            },
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 409  # Conflict
    
    def test_reject_invalid_receipt_number(self, admin_session):
        """Should reject receipt numbers starting with zero"""
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_receipt_invalid",
                "data": {"serialNumber": "0123", "amountLocal": 100}
            },
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 400
    
    def test_temp_delivery_receipt_requires_driver(self, admin_session):
        """Should require deliveryPersonId for temp delivery receipts"""
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_receipt_temp",
                "data": {
                    "status": "Not Paid",
                    "statusDetail": {"notPaidCollection": "delivery"},
                    "amountLocal": 100,
                    # Missing deliveryPersonId
                }
            },
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 400


class TestDeliveryOperations:
    """Test delivery tracking and operations"""
    
    def test_check_stuck_deliveries(self, admin_session):
        """Should find stuck deliveries"""
        response = client.post(
            "/api/deliveries/check-stuck",
            json={"hours_threshold": 72},
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        data = response.json()
        assert "stuck_count" in data
        assert "stuck_deliveries" in data
    
    def test_check_stuck_requires_admin(self):
        """Should require admin permission"""
        response = client.post(
            "/api/deliveries/check-stuck",
            json={"hours_threshold": 72}
        )
        assert response.status_code == 401


class TestAuditLogs:
    """Test audit log management"""
    
    def test_cleanup_audit_logs(self, admin_session):
        """Should cleanup old audit logs"""
        response = client.post(
            "/api/audit/cleanup",
            json={"days_to_keep": 365},
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        data = response.json()
        assert "deleted_count" in data
    
    def test_audit_stats(self, admin_session):
        """Should return audit statistics"""
        response = client.get(
            "/api/audit/stats",
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        data = response.json()
        assert "total_count" in data
    
    def test_cleanup_requires_admin(self):
        """Should require admin for cleanup"""
        response = client.post(
            "/api/audit/cleanup",
            json={"days_to_keep": 365}
        )
        assert response.status_code == 401


class TestSecurityValidation:
    """Test input sanitization and validation"""
    
    def test_reject_xss_in_receipt_data(self, admin_session):
        """Should sanitize XSS attempts in receipt data"""
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_xss",
                "data": {
                    "notes": "<script>alert('xss')</script>",
                    "amountLocal": 100
                }
            },
            cookies={"albayan_session": admin_session}
        )
        # Should succeed but sanitize the script tags
        assert response.status_code == 200
        data = response.json()
        # Script tags should be removed by sanitize_json
        assert "<script>" not in str(data.get("data", {}))
    
    def test_reject_sql_injection_attempts(self, admin_session):
        """Should safely handle SQL-like strings"""
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_sql",
                "data": {
                    "notes": "'; DROP TABLE receipts; --",
                    "amountLocal": 100
                }
            },
            cookies={"albayan_session": admin_session}
        )
        # Should succeed and treat as normal text
        assert response.status_code == 200


class TestConcurrencyControl:
    """Test optimistic locking and race condition prevention"""
    
    def test_optimistic_locking_detects_conflicts(self, admin_session):
        """Should detect concurrent modifications"""
        # Create receipt
        response = client.post(
            "/api/collections/receipts",
            json={
                "id": "test_conflict",
                "data": {"amountLocal": 100, "serialNumber": "999"}
            },
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 200
        receipt = response.json()
        last_modified = receipt["lastModified"]
        
        # Update with old timestamp (simulating conflict)
        response = client.patch(
            "/api/collections/receipts/test_conflict",
            json={
                "data": {"amountLocal": 200},
                "expectedLastModified": last_modified - 1000  # Old timestamp
            },
            cookies={"albayan_session": admin_session}
        )
        assert response.status_code == 409  # Conflict


class TestSoftDeleteIntegrity:
    """A PATCH landing after a delete (easy with the 3s polling sync) must
    not resurrect the soft-deleted record."""

    def test_patch_does_not_resurrect_deleted_record(self, admin_session):
        cookies = {"albayan_session": admin_session}
        r = client.post(
            "/api/collections/customers",
            json={"id": "test_no_resurrect", "data": {"name": "Ghost"}},
            cookies=cookies,
        )
        assert r.status_code == 200

        r = client.delete("/api/collections/customers/test_no_resurrect", cookies=cookies)
        assert r.status_code == 200

        # Simulates client B patching 2s after client A deleted
        r = client.patch(
            "/api/collections/customers/test_no_resurrect",
            json={"data": {"name": "Ghost Updated"}},
            cookies=cookies,
        )
        assert r.status_code == 200
        assert r.json()["deleted"] is True  # still deleted — no resurrection

        # And it must not reappear in the normal (non-deleted) listing
        r = client.get("/api/collections/customers", cookies=cookies)
        assert r.status_code == 200
        payload = r.json()
        items = payload["items"] if isinstance(payload, dict) else payload
        ids = [item["id"] for item in items]
        assert "test_no_resurrect" not in ids


class TestMobileAppOrigins:
    """The packaged Capacitor apps call the API cross-origin.
    Their allowlisted origins must pass CSRF and get a cross-site cookie;
    anything else must stay blocked."""

    def _login(self, origin):
        try:
            client.cookies.clear()
        except Exception:
            pass
        response = client.post(
            "/api/auth/login",
            json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
            headers={"Origin": origin},
        )
        set_cookie = response.headers.get("set-cookie", "")
        try:
            client.cookies.clear()
        except Exception:
            pass
        return response, set_cookie

    def test_ios_capacitor_origin_login_allowed(self):
        response, set_cookie = self._login("capacitor://localhost")
        assert response.status_code == 200
        # Cross-origin cookie must be SameSite=None; Secure or WebViews drop it
        assert "samesite=none" in set_cookie.lower()
        assert "secure" in set_cookie.lower()

    def test_android_https_localhost_origin_login_allowed(self):
        response, set_cookie = self._login("https://localhost")
        assert response.status_code == 200
        assert "samesite=none" in set_cookie.lower()

    def test_web_login_keeps_lax_cookie(self):
        response, set_cookie = self._login("http://testserver")
        assert response.status_code == 200
        assert "samesite=lax" in set_cookie.lower()

    def test_untrusted_cross_origin_login_rejected(self):
        response, _ = self._login("https://evil.example.com")
        assert response.status_code == 403


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

