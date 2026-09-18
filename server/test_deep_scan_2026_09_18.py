"""Regressions from the 2026-09-18 deep scan. Disposable local records only."""

import asyncio
import inspect

from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.requests import Request

import server.main as main
from server import auth_limits, social_studio
from server.http_security import apply_security_headers
from server.security import constant_time_equal

client = TestClient(main.app)


def _request(headers, *, path="/", client_host="203.0.113.7"):
    scope = {
        "type": "http", "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
        "server": ("testserver", 80), "client": (client_host, 1234),
        "headers": [(k.lower().encode("latin-1"), v.encode("utf-8")) for k, v in headers.items()],
    }
    return Request(scope)


def test_api_docs_are_not_served_outside_debug_mode():
    for path in ("/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "openapi" not in response.text.lower()[:400], path


def test_trailing_slash_frontend_route_redirects_to_the_shell_route():
    response = client.get("/studio/", follow_redirects=False)
    assert response.status_code == 308
    assert response.headers["location"] == "/studio"
    with_query = client.get("/studio/?tab=posts", follow_redirects=False)
    assert with_query.headers["location"] == "/studio?tab=posts"
    assert client.get("/studio").status_code == 200
    assert client.get("/", follow_redirects=False).status_code == 200


def test_constant_time_equal_handles_every_input():
    assert constant_time_equal("abc", "abc") is True
    assert constant_time_equal("abc", "abd") is False
    assert constant_time_equal("\u00e9", "sha256=abcd") is False  # raised TypeError before
    assert constant_time_equal("\u00e9", "\u00e9") is True
    assert constant_time_equal("", "") is False
    assert constant_time_equal(None, "x") is False
    assert constant_time_equal("x", None) is False


def test_origin_secret_check_refuses_non_ascii_without_crashing():
    async def call_next(_request):
        return JSONResponse({"ok": True})

    def run(headers):
        return asyncio.run(apply_security_headers(
            _request(headers, path="/api/anything"), call_next,
            origin_secrets=["real-secret"], origin_bypass_paths=frozenset(),
            origin_secret_header="X-Albayan-Origin",
        ))

    assert run({"X-Albayan-Origin": "\u00e9"}).status_code == 403
    assert run({"X-Albayan-Origin": "wrong"}).status_code == 403
    assert run({}).status_code == 403
    assert run({"X-Albayan-Origin": "real-secret"}).status_code == 200


def test_social_media_limiter_ignores_spoofable_forwarded_header(monkeypatch):
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", False)
    spoofed = _request({"X-Forwarded-For": "198.51.100.1, 10.0.0.9"})
    assert social_studio._client_ip(spoofed) == "203.0.113.7"
    assert auth_limits._client_ip(spoofed) == "203.0.113.7"


def test_untrusted_proxy_headers_are_reported_once(monkeypatch, capsys):
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", False)
    monkeypatch.setattr(auth_limits, "_UNTRUSTED_PROXY_WARNED", False)
    auth_limits._client_ip(_request({"CF-Connecting-IP": "198.51.100.1"}))
    auth_limits._client_ip(_request({"CF-Connecting-IP": "198.51.100.2"}))
    out = capsys.readouterr().out
    assert out.count("ALBAYAN_TRUST_PROXY_HEADERS=true") == 1


def test_comment_webhook_matches_posts_without_loading_photos():
    source = inspect.getsource(social_studio.process_comment)
    assert "_lean_posts(owner_id, status, limit=1000)" in source  # round 13 widened the match window; still the lean projection
    assert "_rows_where_json(POSTS_TYPE" not in source


def test_unhandled_error_log_redacts_bound_parameters():
    error = Exception(
        "(psycopg.errors.X) boom\n[SQL: UPDATE users SET password_hash=%(h)s]\n"
        "[parameters: {'h': 'deadbeefhash'}]"
    )
    text = main._safe_exception_text(error)
    assert "deadbeefhash" not in text
    assert "[parameters: redacted]" in text
    assert "boom" in text
