"""
Simple smoke tests for Albayan Manager API (no auth required).

Run with: docker compose exec albayan pytest server/test_simple.py -v
"""
import sys
from pathlib import Path

# Add parent directory to Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
from server.main import app

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

