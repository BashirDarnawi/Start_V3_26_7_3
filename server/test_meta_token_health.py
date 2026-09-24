"""P0-14: Albayan's Meta token health read with Graph debug_token.

Graph is faked with httpx.MockTransport; nothing here reaches the network. The
system token and the app secret must never appear in stored data, logs,
responses, audit rows or exception texts.
"""

import hashlib
import hmac
import logging
import secrets
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.meta_token_health as token_health
from server.db import db_conn, init_db, json_loads
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.test_meta_ads import _insert_user, _login

TAG = secrets.token_hex(4)
client = TestClient(app, headers={"Origin": "http://testserver"})
PASSWORD = "TokenHealthPassword123!"
SYSTEM_TOKEN = f"EAAGsystemtoken{TAG}mustneverleak"
APP_SECRET = f"appsecret{TAG}mustneverleak"
APP_ID = "123456789012345"
URL = "/api/meta-ads/token-health"


def _debug_data(**overrides):
    data = {
        "app_id": APP_ID,
        "type": "SYSTEM_USER",
        "application": "Albayan",
        "is_valid": True,
        "expires_at": 0,
        "data_access_expires_at": int(time.time()) + 10 * 86400 + 3600,
        "issued_at": 1_750_000_000,
        "user_id": "100000000000001",
        "scopes": ["ads_read", "pages_show_list", "pages_manage_metadata", "business_management"],
        "granular_scopes": [
            {"scope": "pages_show_list", "target_ids": ["888888888888888", "777777777777777"]},
            {"scope": "pages_manage_metadata", "target_ids": ["777777777777777"]},
            {"scope": "ads_read"},
        ],
    }
    data.update(overrides)
    return data


@pytest.fixture()
def graph(monkeypatch):
    """Configured env plus a fake Graph that answers debug_token."""
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.delenv("ALBAYAN_META_GRAPH_API_VERSION", raising=False)
    fake = {"requests": [], "status": 200, "body": {"data": _debug_data()}, "delay": 0.0}

    def handler(request):
        fake["requests"].append(request)
        time.sleep(fake["delay"])
        return httpx.Response(fake["status"], json=fake["body"])

    real_client_class = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(token_health.httpx, "Client", lambda **kwargs: real_client_class(transport=transport, **kwargs))
    monkeypatch.setattr(token_health, "_LAST_CHECK", {"fingerprint": "", "at": 0.0})  # no reuse across tests
    _forget_token_state()
    yield fake
    _forget_token_state()


def _forget_token_state():
    init_db()
    with db_conn() as conn:
        conn.execute(
            text("DELETE FROM entities WHERE type=:type AND id='token'"),
            {"type": meta_ads._META_HEALTH_STATE_TYPE},
        )


def _stored_token_json():
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json,created_by FROM entities WHERE type=:type AND id='token'"),
            {"type": meta_ads._META_HEALTH_STATE_TYPE},
        ).mappings().first()
    return row


@pytest.fixture(scope="module")
def people():
    init_db()
    admin_email, staff_email = f"token-admin-{TAG}@tests.albayanhub.com", f"token-staff-{TAG}@tests.albayanhub.com"
    admin_id = _insert_user("Token Admin", admin_email, PASSWORD, "Admin", {})
    staff_id = _insert_user("Token Staff", staff_email, PASSWORD, "Employee", {"ads": ["view", "edit"]})
    try:
        yield {"admin": _login(admin_email, PASSWORD), "staff": _login(staff_email, PASSWORD), "admin_id": admin_id}
    finally:
        for key in (f"meta-token-health:{admin_id}", f"meta-token-health-refresh:{admin_id}"):
            reset_rate_limit(key)
        with db_conn() as conn:
            conn.execute(text("DELETE FROM sessions WHERE user_id IN (:a,:s)"), {"a": admin_id, "s": staff_id})
            conn.execute(text("DELETE FROM audit_logs WHERE user_id IN (:a,:s)"), {"a": admin_id, "s": staff_id})
            conn.execute(text("DELETE FROM users WHERE id IN (:a,:s)"), {"a": admin_id, "s": staff_id})


@pytest.fixture()
def fresh_limits(people):
    for key in (f"meta-token-health:{people['admin_id']}", f"meta-token-health-refresh:{people['admin_id']}"):
        reset_rate_limit(key)
    yield
    for key in (f"meta-token-health:{people['admin_id']}", f"meta-token-health-refresh:{people['admin_id']}"):
        reset_rate_limit(key)


def test_debug_token_parsed(graph):
    result = token_health.read_token_debug()
    request = graph["requests"][0]
    assert request.method == "GET" and request.url.host == "graph.facebook.com"
    assert request.url.path == "/v25.0/debug_token"
    assert request.url.params.get("input_token") == SYSTEM_TOKEN  # Meta documents only this form
    assert "access_token" not in request.url.params and APP_SECRET not in str(request.url)
    assert request.headers["Authorization"] == f"Bearer {APP_ID}|{APP_SECRET}"  # app token: header only

    assert result["configured"] is True and result["isValid"] is True
    assert result["type"] == "SYSTEM_USER" and result["appMatches"] is True and result["application"] == "Albayan"
    assert result["expiresNever"] is True and result["expiresAt"] == ""
    assert result["dataAccessExpiresAt"].endswith("Z") and result["dataAccessExpiresNever"] is False
    assert result["scopes"] == ["ads_read", "business_management", "pages_manage_metadata", "pages_show_list"]
    assert "ads_management" in result["missingScopes"] and "ads_read" not in result["missingScopes"]
    assert set(result["missingScopes"]) == set(token_health.EXPECTED_SCOPES) - set(result["scopes"])
    coverage = result["pagesCoveredByScope"]
    assert coverage["pages_show_list"] == {"allTargets": False, "targetIds": ["777777777777777", "888888888888888"]}
    assert coverage["pages_manage_metadata"]["targetIds"] == ["777777777777777"]
    assert coverage["ads_read"] == {"allTargets": True, "targetIds": []}
    assert result["errorCode"] == "" and result["checkedAt"]
    assert "user_id" not in result and "100000000000001" not in str(result)

    graph["body"] = {"data": _debug_data(is_valid=False, expires_at=1_700_000_000, app_id="999",
                                          error={"code": 190, "subcode": 460, "message": "Session expired"})}
    expired = token_health.read_token_debug()
    assert expired["isValid"] is False and expired["errorCode"] == "190.460"
    assert expired["appMatches"] is False and expired["expiresAt"] == "2023-11-14T22:13:20Z"
    assert "Session expired" not in str(expired)


def test_token_never_stored_or_logged(graph, people, fresh_limits, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="httpx")
    response = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["isValid"] is True and body["checked"] is True and body["dataAccessDaysLeft"] == 10
    assert body["daysLeft"] is None and body["expiresNever"] is True
    assert "webhookCounts" in body and body["expectedScopes"] == list(token_health.EXPECTED_SCOPES)

    # httpx really logged the request line, and the guard removed the token from it.
    lines = [record.getMessage() for record in caplog.records if record.name == "httpx"]
    assert any("debug_token" in line and "input_token=[redacted]" in line for line in lines), lines
    row = _stored_token_json()
    assert row is not None and row["created_by"] is None
    with db_conn() as conn:
        audits = [r["metadata_json"] + r["message"] for r in conn.execute(
            text("SELECT metadata_json,message FROM audit_logs WHERE action='meta_token_health_check' AND user_id=:u"),
            {"u": people["admin_id"]},
        ).mappings().all()]
    assert audits
    for secret in (SYSTEM_TOKEN, APP_SECRET):
        assert secret not in caplog.text
        assert all(secret not in record.getMessage() for record in caplog.records)
        assert secret not in response.text
        assert secret not in row["data_json"]
        assert all(secret not in audit for audit in audits)

    # Meta echoing both secrets in an error must not leak them either.
    graph["status"] = 400
    graph["body"] = {"error": {"code": 190, "message": f"Bad token {SYSTEM_TOKEN} for {APP_ID}|{APP_SECRET}"}}
    failed = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert failed.status_code == 502 and "code 190" in failed.json()["detail"]
    with pytest.raises(meta_ads.MetaAdsError) as raised:
        token_health.read_token_debug()
    stored_after = _stored_token_json()["data_json"]
    assert json_loads(stored_after)["lastCheckError"] == "check_failed:190"
    assert json_loads(stored_after)["isValid"] is True  # the last good reading is kept
    for secret in (SYSTEM_TOKEN, APP_SECRET):
        assert secret not in failed.text and secret not in str(raised.value) and secret not in stored_after
        assert secret not in caplog.text

    # A network failure never carries the request URL (it holds the token) in its text.
    def unreachable(**kwargs):
        raise httpx.ConnectError(f"cannot reach https://graph.facebook.com/debug_token?input_token={SYSTEM_TOKEN}")

    monkeypatch.setattr(token_health.httpx, "Client", unreachable)
    with pytest.raises(meta_ads.MetaAdsError) as network:
        token_health.read_token_debug()
    assert network.value.code == "network" and network.value.__suppress_context__ is True
    assert SYSTEM_TOKEN not in str(network.value)


def test_log_guard_redacts_any_token_query_and_survives_reinstall():
    record = logging.LogRecord("httpx", logging.INFO, __file__, 1, 'HTTP Request: %s %s "%s %d %s"',
                               ("GET", httpx.URL("https://graph.facebook.com/v25.0/debug_token",
                                                 params={"input_token": "tok-1", "access_token": "tok-2"}),
                                "HTTP/1.1", 200, "OK"), None)
    guard = next(item for item in logging.getLogger("httpx").filters if type(item).__name__ == "_SecretQueryRedactor")
    assert guard.filter(record) is True
    message = record.getMessage()
    assert "tok-1" not in message and "tok-2" not in message and "200 OK" in message
    before = len(logging.getLogger("httpx").filters)
    token_health.install_log_guard()
    assert len(logging.getLogger("httpx").filters) == before  # installed once


def test_missing_app_id_reports_unconfigured(graph, people, fresh_limits, monkeypatch):
    monkeypatch.delenv("ALBAYAN_META_APP_ID")
    assert token_health.read_token_debug()["reason"] == "no_app_id"
    response = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert response.status_code == 200, response.text
    assert response.json()["configured"] is False and response.json()["reason"] == "no_app_id"
    assert "webhookCounts" in response.json()

    monkeypatch.setenv("ALBAYAN_META_APP_ID", "not-a-number")
    assert token_health.read_token_debug() == {
        "configured": False, "reason": "invalid_app_id", "message": "ALBAYAN_META_APP_ID must be the Meta app's numeric id."}
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    monkeypatch.delenv("ALBAYAN_META_APP_SECRET")
    assert token_health.read_token_debug()["configured"] is False
    assert token_health.read_token_debug()["reason"] == "no_app_secret"
    assert graph["requests"] == []  # no Graph call without the app id and secret
    assert _stored_token_json() is None


def test_token_health_route_is_admin_only(graph, people, fresh_limits):
    assert client.get(URL).status_code == 401
    assert client.get(URL, cookies=people["staff"]).status_code == 403
    assert client.get(f"{URL}?refresh=1", cookies=people["staff"]).status_code == 403
    plain = client.get(URL, cookies=people["admin"])
    assert plain.status_code == 200, plain.text
    assert plain.json()["configured"] is True and plain.json()["checked"] is False
    assert graph["requests"] == []  # a plain read never calls Meta


def test_refresh_is_rate_limited_and_same_origin(graph, people, fresh_limits):
    no_origin = TestClient(app)
    assert no_origin.get(f"{URL}?refresh=1", cookies=people["admin"]).status_code == 403
    assert graph["requests"] == []
    for _ in range(3):
        assert client.get(f"{URL}?refresh=1", cookies=people["admin"]).status_code == 200
    limited = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert limited.status_code == 429 and limited.headers.get("Retry-After")
    assert len(graph["requests"]) == 3
    assert client.get(URL, cookies=people["admin"]).status_code == 200  # reading stays available


# ---------------------------------------------------------------------------
# A reading is tied to the token it checked (one-way fingerprint, never returned),
# and check_token_now limits itself to one Graph call per 10 minutes per token.
# ---------------------------------------------------------------------------

OTHER_TOKEN = f"EAAGreplacedtoken{TAG}mustneverleak"
READING_FIELDS = ("isValid", "type", "application", "appMatches", "expiresAt", "expiresNever", "daysLeft",
                  "dataAccessExpiresAt", "dataAccessExpiresNever", "dataAccessDaysLeft", "scopes",
                  "missingScopes", "pagesCoveredByScope", "errorCode", "lastCheckError", "lastCheckErrorAt")


def _fingerprint(token):
    return hmac.new(APP_SECRET.encode(), token.encode(), hashlib.sha256).hexdigest()[:16]


def test_reading_of_another_token_is_stale(graph, people, fresh_limits, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    checked = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert checked.status_code == 200, checked.text
    assert checked.json()["checked"] is True and checked.json()["stale"] is False
    stored = json_loads(_stored_token_json()["data_json"])
    assert stored["tokenFingerprint"] == _fingerprint(SYSTEM_TOKEN)  # one-way, keyed with the app secret
    assert SYSTEM_TOKEN not in _stored_token_json()["data_json"]
    for response in (checked, client.get(URL, cookies=people["admin"])):
        assert "tokenFingerprint" not in response.json()
        assert stored["tokenFingerprint"] not in response.text
    assert stored["tokenFingerprint"] not in caplog.text

    # The token is replaced in Jelastic: the old token's reading is not shown as the new one's.
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", OTHER_TOKEN)
    stale = client.get(URL, cookies=people["admin"])
    assert stale.status_code == 200, stale.text
    body = stale.json()
    assert body["configured"] is True and body["checked"] is False and body["stale"] is True
    assert not set(READING_FIELDS) & set(body) and "checkedAt" not in body
    assert "webhookCounts" in body and stored["tokenFingerprint"] not in stale.text
    assert len(graph["requests"]) == 1  # a plain read never calls Meta

    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
    assert client.get(URL, cookies=people["admin"]).json()["checked"] is True
    # A reading saved before readings carried a fingerprint cannot be tied to any token.
    meta_ads.save_meta_health_state("token", lambda current: {k: v for k, v in current.items() if k != "tokenFingerprint"})
    legacy = client.get(URL, cookies=people["admin"]).json()
    assert legacy["stale"] is True and legacy["checked"] is False and "isValid" not in legacy


def test_failure_after_a_token_change_drops_the_old_reading(graph, people, fresh_limits, monkeypatch):
    assert client.get(f"{URL}?refresh=1", cookies=people["admin"]).status_code == 200
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", OTHER_TOKEN)
    graph["status"], graph["body"] = 400, {"error": {"code": 190, "message": "Invalid token"}}
    failed = client.get(f"{URL}?refresh=1", cookies=people["admin"])
    assert failed.status_code == 502, failed.text
    assert graph["requests"][-1].url.params.get("input_token") == OTHER_TOKEN

    stored = json_loads(_stored_token_json()["data_json"])
    assert stored["lastCheckError"] == "check_failed:190" and stored["tokenFingerprint"] == _fingerprint(OTHER_TOKEN)
    for field in ("isValid", "scopes", "expiresAt", "dataAccessExpiresAt", "checkedAt", "pagesCoveredByScope"):
        assert field not in stored, field  # the first token's reading is gone
    body = client.get(URL, cookies=people["admin"]).json()
    assert body["stale"] is False and body["checked"] is False and body["checkedAt"] == ""
    assert body["isValid"] is False and body["scopes"] == [] and body["dataAccessExpiresAt"] == ""
    assert body["lastCheckError"] == "check_failed:190"


def test_check_token_now_calls_meta_at_most_once_per_ten_minutes(graph, monkeypatch):
    first = token_health.check_token_now()
    again = token_health.check_token_now()
    assert len(graph["requests"]) == 1  # two calls within 10 minutes: one Graph call
    assert again == first and "tokenFingerprint" not in again

    token_health.check_token_now(max_age_seconds=0)  # what ?refresh=1 passes: always asks
    assert len(graph["requests"]) == 2
    token_health._LAST_CHECK["at"] -= 601  # the last check is now older than 10 minutes
    token_health.check_token_now()
    assert len(graph["requests"]) == 3

    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", OTHER_TOKEN)  # a changed token is always checked
    changed = token_health.check_token_now()
    assert len(graph["requests"]) == 4 and changed["isValid"] is True
    assert graph["requests"][-1].url.params.get("input_token") == OTHER_TOKEN

    # A failed check counts too: the saved reading (with its error) comes back without a call.
    graph["status"], graph["body"] = 500, {"error": {"code": 2, "message": "Service unavailable"}}
    with pytest.raises(meta_ads.MetaAdsError):
        token_health.check_token_now(max_age_seconds=0)
    assert len(graph["requests"]) == 5
    after_failure = token_health.check_token_now()
    assert len(graph["requests"]) == 5
    assert after_failure["lastCheckError"] == "check_failed:2" and after_failure["isValid"] is True
    for secret in (SYSTEM_TOKEN, OTHER_TOKEN, APP_SECRET, _fingerprint(OTHER_TOKEN)):
        assert secret not in str(after_failure)


def test_refresh_route_always_asks_meta(graph, people, fresh_limits):
    token_health.check_token_now()
    assert len(graph["requests"]) == 1
    assert client.get(f"{URL}?refresh=1", cookies=people["admin"]).status_code == 200
    assert len(graph["requests"]) == 2  # the admin's re-check skips the 10-minute reuse


def test_simultaneous_checks_cost_one_graph_call(graph):
    graph["delay"] = 0.2
    results, errors = [], []

    def check():
        try:
            results.append(token_health.check_token_now())
        except Exception as error:
            errors.append(error)

    threads = [threading.Thread(target=check) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert errors == [] and len(results) == 4
    assert len(graph["requests"]) == 1  # the lock let one caller reach Meta; the rest reused it
    assert all(result["isValid"] is True for result in results)
