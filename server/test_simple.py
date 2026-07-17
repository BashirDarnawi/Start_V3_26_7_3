"""
Simple smoke tests for Albayan Manager API (no auth required).

Run with: docker compose exec albayan pytest server/test_simple.py -v
"""
import sys
from pathlib import Path

# Add parent directory to Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import text
import server.db as db_module
import server.main as main_module
from server.main import app
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, hash_token

client = TestClient(app)


def test_health_endpoint():
    """Health endpoint should return ok status"""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert "ts" in data
    assert "database" in data


def test_serve_index():
    """Should serve index.html"""
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_serve_script():
    """Should serve script.js"""
    response = client.get("/script.js")
    assert response.status_code == 200
    assert "javascript" in response.headers["content-type"]


def test_serve_style():
    """Should serve style.css"""
    response = client.get("/style.css")
    assert response.status_code == 200
    assert "css" in response.headers["content-type"]


def test_serve_privacy_policy():
    """The store-required privacy policy must be served at /privacy"""
    response = client.get("/privacy")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Privacy Policy" in response.text
    assert "سياسة الخصوصية" in response.text  # Arabic section present
    assert "Libyan Spider JPaaS (Jelastic)" in response.text
    assert "Amazon Web Services" not in response.text
    assert 'href="/delete-account"' in response.text


def test_serve_account_deletion_request_page():
    """Account deletion instructions must be public and work without auth."""
    response = client.get("/delete-account")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Request deletion of your Albayan account" in response.text
    assert "طلب حذف حسابك في البيان" in response.text
    assert "mailto:bashirdernawi1999@gmail.com" in response.text
    assert "does not immediately or automatically delete data" in response.text


def test_public_policy_routes_bypass_origin_secret_exactly(monkeypatch):
    """Store policy URLs stay public without exposing similarly named APIs."""
    monkeypatch.setattr(main_module, "ORIGIN_SECRETS", ["unit-test-origin-secret"])

    assert client.get("/api/health").status_code == 200
    assert client.get("/privacy").status_code == 200
    assert client.get("/delete-account").status_code == 200

    # Exact matching matters: prefix matching would accidentally bypass these.
    assert client.get("/api/healthcheck").status_code == 403
    assert client.get("/privacy-extra").status_code == 403
    assert client.get("/api/auth/me").status_code == 403

    protected_with_secret = client.get(
        "/api/auth/me",
        headers={main_module.ORIGIN_SECRET_HEADER: "unit-test-origin-secret"},
    )
    assert protected_with_secret.status_code == 401


def test_privacy_links_are_available_without_settings_permission():
    """Login and both sidebar variants expose the two account-policy links."""
    views_source = (Path(__file__).parent.parent / "src" / "12-views.js").read_text(
        encoding="utf-8"
    )
    assert views_source.count('data-account-policy-links') >= 2
    assert views_source.count('${renderAlwaysAvailableAccountLinks()}') >= 2
    assert views_source.count('https://albayanhub.com/privacy') >= 2
    assert views_source.count('https://albayanhub.com/delete-account') >= 2


def test_privacy_anonymization_removes_pii_and_preserves_record_ids(tmp_path, monkeypatch):
    """Verified erasure leaves an inert id tombstone so financial history stays valid."""
    db_path = (tmp_path / "privacy-anonymization.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")
    monkeypatch.setattr(db_module, "_ENGINE", None)
    monkeypatch.setattr(db_module, "_ENGINE_URL", None)
    init_db()

    admin_id = "user_privacy_admin"
    target_id = "user_privacy_target"
    old_name = "Privacy Person"
    old_email = "privacy.person@tests.albayanhub.com"
    password = hash_password("OldPassword123!", iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()

    with db_conn() as conn:
        for user_id, name, email, role, deleted in (
            (admin_id, "Privacy Admin", "privacy.admin@tests.albayanhub.com", "Admin", False),
            (target_id, old_name, old_email, "Employee", True),
        ):
            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id,name,email,role,permissions_json,password_hash,password_salt,
                      password_algo,password_iterations,deleted,created_at,created_by,last_modified
                    ) VALUES (
                      :id,:name,:email,:role,:permissions_json,:password_hash,:password_salt,
                      :password_algo,:password_iterations,:deleted,:created_at,:created_by,:last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": name,
                    "email": email,
                    "role": role,
                    "permissions_json": json_dumps({"receipts": ["view"]}),
                    "password_hash": password.hash_hex,
                    "password_salt": password.salt_hex,
                    "password_algo": password.algo,
                    "password_iterations": password.iterations,
                    "deleted": deleted,
                    "created_at": now,
                    "created_by": admin_id,
                    "last_modified": now,
                },
            )

        conn.execute(
            text(
                """
                INSERT INTO sessions
                  (id,user_id,token_hash,created_at,expires_at,last_seen_at,ip,user_agent)
                VALUES
                  ('privacy_session',:user_id,:token_hash,:now,:expires,:now,'192.0.2.1','private-agent')
                """
            ),
            {
                "user_id": target_id,
                "token_hash": hash_token("privacy-token"),
                "now": now,
                "expires": now + 60_000,
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO password_resets
                  (id,user_id,token_hash,created_at,expires_at,used_at,ip,user_agent)
                VALUES
                  ('privacy_reset',:user_id,:token_hash,:now,:expires,NULL,'192.0.2.2','private-agent')
                """
            ),
            {
                "user_id": target_id,
                "token_hash": hash_token("privacy-reset-token"),
                "now": now,
                "expires": now + 60_000,
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO entities
                  (type,id,data_json,deleted,created_at,created_by,last_modified)
                VALUES
                  ('receipts','privacy_receipt',:data_json,false,:now,:created_by,:now)
                """
            ),
            {
                "data_json": json_dumps({"amountLocal": 125, "customerName": "Business record"}),
                "now": now,
                "created_by": target_id,
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO audit_logs
                  (id,ts,user_id,action,resource_type,resource_id,message,metadata_json)
                VALUES
                  ('privacy_audit',:now,:user_id,'login','auth',:user_id,:message,:metadata_json)
                """
            ),
            {
                "now": now,
                "user_id": target_id,
                "message": f"User {old_email} ({old_name}) logged in",
                "metadata_json": json_dumps({"email": old_email, "ip": "192.0.2.3"}),
            },
        )

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": f"/api/users/{target_id}/privacy-anonymize",
            "headers": [(b"host", b"testserver"), (b"origin", b"http://testserver")],
        }
    )
    admin = {"id": admin_id, "role": "Admin"}
    with pytest.raises(HTTPException) as wrong_confirmation:
        main_module.privacy_anonymize_user(
            target_id, request, {"confirmation": "ANONYMIZE"}, admin
        )
    assert wrong_confirmation.value.status_code == 400

    result = main_module.privacy_anonymize_user(
        target_id,
        request,
        {"confirmation": f"ANONYMIZE {target_id}"},
        admin,
    )
    assert result.id == target_id
    assert result.name == "Deleted user"
    assert str(result.email) != old_email
    assert str(result.email).endswith("@privacy.albayanhub.com")

    with db_conn() as conn:
        user_row = conn.execute(
            text("SELECT * FROM users WHERE id=:id"), {"id": target_id}
        ).mappings().one()
        assert bool(user_row["deleted"]) is True
        assert user_row["password_hash"] != password.hash_hex
        assert user_row["permissions_json"] == json_dumps({})
        assert conn.execute(
            text("SELECT COUNT(*) FROM sessions WHERE user_id=:id"), {"id": target_id}
        ).scalar_one() == 0
        assert conn.execute(
            text("SELECT COUNT(*) FROM password_resets WHERE user_id=:id"), {"id": target_id}
        ).scalar_one() == 0

        receipt = conn.execute(
            text("SELECT * FROM entities WHERE type='receipts' AND id='privacy_receipt'")
        ).mappings().one()
        assert receipt["created_by"] == target_id
        assert '"amountLocal":125' in receipt["data_json"]

        audit_row = conn.execute(
            text("SELECT * FROM audit_logs WHERE id='privacy_audit'")
        ).mappings().one()
        assert audit_row["user_id"] == target_id
        assert audit_row["resource_id"] == target_id
        assert old_email not in audit_row["message"]
        assert old_name not in audit_row["message"]
        assert audit_row["metadata_json"] == json_dumps({})


def test_serve_bundled_assets():
    """Should serve the locally bundled tailwind/fonts/lucide assets"""
    for name, ctype in [
        ("tailwind.css", "css"),
        ("fonts.css", "css"),
        ("lucide.min.js", "javascript"),
    ]:
        response = client.get(f"/assets/{name}")
        assert response.status_code == 200, name
        assert ctype in response.headers["content-type"], name


def test_index_references_versioned_assets():
    """serve_index should inject cache-busting ?v= into all asset URLs"""
    html = client.get("/").text
    assert 'src="script.js?v=' in html
    assert 'href="style.css?v=' in html
    assert 'href="assets/tailwind.css?v=' in html
    assert 'href="assets/fonts.css?v=' in html
    assert 'src="assets/lucide.min.js?v=' in html


def test_assets_reject_traversal_and_unknown_types():
    """Asset routes must not serve arbitrary files"""
    # Encoded traversal (starlette decodes %2e%2e%2f into ../)
    response = client.get("/assets/%2e%2e%2fserver%2fmain.py")
    assert response.status_code in (400, 404)
    # Unknown extension inside assets/ must 404 even if the file existed
    response = client.get("/assets/whatever.py")
    assert response.status_code == 404


def test_login_requires_credentials():
    """Login should require email and password"""
    response = client.post("/api/auth/login", json={})
    assert response.status_code == 422  # Validation error


def test_bootstrap_requires_auth():
    """Bootstrap endpoint should require authentication"""
    response = client.get("/api/bootstrap")
    assert response.status_code == 401  # Unauthorized


def test_collections_require_auth():
    """Collections API should require authentication"""
    response = client.get("/api/collections/receipts")
    assert response.status_code == 401


def test_users_list_requires_admin():
    """Users list should require admin role"""
    response = client.get("/api/users")
    assert response.status_code == 401


def test_audit_requires_admin():
    """Audit logs should require admin role"""
    response = client.get("/api/audit")
    assert response.status_code == 401


def test_audit_stats_requires_admin():
    """Audit stats should require admin role"""
    response = client.get("/api/audit/stats")
    assert response.status_code == 401


def test_cleanup_requires_admin():
    """Audit cleanup should require admin role"""
    response = client.post("/api/audit/cleanup", json={"days_to_keep": 365})
    assert response.status_code == 401


def test_stuck_deliveries_requires_admin():
    """Stuck deliveries check should require admin role"""
    response = client.post("/api/deliveries/check-stuck", json={"hours_threshold": 72})
    assert response.status_code == 401


# Input validation tests (no auth needed - fail early)
def test_security_escapes_html():
    """Test that security module escapes HTML correctly"""
    from server.main import sanitize_str
    
    # Should remove < and > characters
    assert "<" not in sanitize_str("<script>alert('xss')</script>")
    assert ">" not in sanitize_str("<script>alert('xss')</script>")
    
    # Should handle normal text
    assert "Hello World" == sanitize_str("Hello World")


def test_security_blocks_null_bytes():
    """Test that null bytes are removed"""
    from server.main import sanitize_str
    
    result = sanitize_str("Hello\x00World")
    assert "\x00" not in result
    assert "HelloWorld" == result


def test_security_sanitizes_json():
    """Test that JSON sanitization removes dangerous keys"""
    from server.main import sanitize_json
    
    dangerous = {
        "name": "Test",
        "__proto__": "hack",
        "constructor": "hack",
        "prototype": "hack"
    }
    
    safe = sanitize_json(dangerous)
    assert "name" in safe
    assert "__proto__" not in safe
    assert "constructor" not in safe
    assert "prototype" not in safe


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
