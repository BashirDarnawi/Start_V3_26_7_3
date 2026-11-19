"""Connect with Facebook, server core: the stored, encrypted Meta key (server/meta_connection.py).

Nothing here reaches the network. The rule under test first: with no stored connection Albayan
behaves exactly as before (the hosting key and allowlist). A stored, readable connection wins; an
unreadable one falls back to the hosting key and asks for a reconnect; the plain key never lands in
the database, a response, the full backup or a log line.
"""

import base64
import gzip
import json
import logging
import secrets

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.meta_connection as mc
import server.meta_token_health as token_health
from server.db import db_conn, init_db
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.systems.ads_studio import studio_alerts_meta, studio_ig_source, studio_jobs
from server.test_meta_ads import _insert_user, _login

TAG = secrets.token_hex(4)
client = TestClient(app, headers={"Origin": "http://testserver"})
PASSWORD = "ConnectCorePassword123!"
ENV_TOKEN = f"EAAGenvtoken{TAG}hostingkey"
STORED_TOKEN = f"EAAGstoredtoken{TAG}mustneverleak"
APP_SECRET = f"appsecret{TAG}mustneverleak"
APP_ID = "123456789012345"
SECRETS = (STORED_TOKEN, APP_SECRET)


def _new_key() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def _wipe_rows():
    init_db()
    with db_conn() as conn:
        conn.execute(
            text("DELETE FROM entities WHERE type='metaHealthState' AND id LIKE 'connection%'")
        )
    mc.invalidate()


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", ENV_TOKEN)
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    monkeypatch.setenv("ALBAYAN_META_CONNECTION_KEY", _new_key())
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "111,222")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    _wipe_rows()
    with meta_ads._PAGE_TOKEN_LOCK:
        meta_ads._PAGE_TOKEN_CACHE.clear()
    yield monkeypatch
    _wipe_rows()
    with meta_ads._PAGE_TOKEN_LOCK:
        meta_ads._PAGE_TOKEN_CACHE.clear()
    meta_ads._META_FUNDS_CACHE.clear()


def _store(token=STORED_TOKEN, selected=("333",), available=(("333", "Shop A"), ("444", "Shop B"))):
    sealed = mc.encrypt_secret(token, mc.CONNECTION_ID)
    assert sealed is not None
    saved = mc.save_record(mc.CONNECTION_ID, {
        **sealed,
        "appId": APP_ID,
        "businessName": "Test business",
        "systemUserName": "Albayan robot",
        "connectedAt": mc.iso_now(),
        "connectedByName": "Connect Admin",
        "scopes": ["ads_read"],
        "availableAccounts": [{"id": i, "name": n} for i, n in available],
        "selectedAccountIds": list(selected),
    })
    assert saved is not None
    return saved


def _raw_rows() -> str:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id,data_json FROM entities WHERE type='metaHealthState' AND id LIKE 'connection%'")
        ).mappings().all()
    return json.dumps([dict(row) for row in rows])


@pytest.fixture(scope="module")
def people():
    init_db()
    admin_email, staff_email = f"conn-admin-{TAG}@tests.albayanhub.com", f"conn-staff-{TAG}@tests.albayanhub.com"
    admin_id = _insert_user("Connect Admin", admin_email, PASSWORD, "Admin", {})
    staff_id = _insert_user("Connect Staff", staff_email, PASSWORD, "Employee", {"ads": ["view", "edit"]})
    try:
        yield {"admin": _login(admin_email, PASSWORD), "staff": _login(staff_email, PASSWORD), "admin_id": admin_id}
    finally:
        for key in (f"meta-token-health:{admin_id}", f"meta-token-health-refresh:{admin_id}", f"full-backup:{admin_id}"):
            reset_rate_limit(key)
        with db_conn() as conn:
            conn.execute(text("DELETE FROM sessions WHERE user_id IN (:a,:s)"), {"a": admin_id, "s": staff_id})
            conn.execute(text("DELETE FROM audit_logs WHERE user_id IN (:a,:s)"), {"a": admin_id, "s": staff_id})
            conn.execute(text("DELETE FROM users WHERE id IN (:a,:s)"), {"a": admin_id, "s": staff_id})


# --------------------------------------------------------------------------- unchanged without Connect


def test_no_stored_connection_keeps_the_hosting_key_and_allowlist(env):
    config = meta_ads.load_meta_ads_config()
    assert config.access_token == ENV_TOKEN
    assert config.allowed_account_ids == ("111", "222")
    assert config.allowlist_required is False
    assert mc.token_source() == "environment" and meta_ads.meta_token_source() == "environment"
    assert mc.reconnect_needed() is False
    assert meta_ads._server_token_matches(config) is True
    assert meta_ads.meta_token_present() is True
    # An empty hosting allowlist still means "every account the key sees", as before.
    env.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "")
    open_config = meta_ads.load_meta_ads_config()
    assert open_config.allowed_account_ids == () and open_config.allowlist_required is False
    assert meta_ads.MetaAdsClient(open_config)._ensure_allowed_account("999") == "999"
    env.delenv("ALBAYAN_META_ACCESS_TOKEN")
    assert mc.token_source() == "none" and meta_ads.meta_token_present() is False
    assert meta_ads.load_meta_ads_config().configured is False


def test_database_trouble_never_raises_and_uses_the_hosting_key(env):
    def broken():
        raise RuntimeError("database down")

    env.setattr(mc, "db_conn", broken)
    mc.invalidate()
    assert mc.active_connection() is None
    assert mc.reconnect_needed() is False
    assert meta_ads.load_meta_ads_config().access_token == ENV_TOKEN
    assert mc.load_record(mc.CONNECTION_ID) == {}
    assert mc.save_record(mc.SETTINGS_ID, {"loginConfigId": "123456"}) is None
    assert mc.delete_record(mc.CONNECTION_ID) is False
    assert mc.consume_record(mc.PENDING_ID, lambda _row: True) is None


# --------------------------------------------------------------------------- precedence and encryption


def test_stored_key_wins_over_the_hosting_key(env):
    _store()
    config = meta_ads.load_meta_ads_config()
    assert config.access_token == STORED_TOKEN
    assert config.allowed_account_ids == ("333",) and config.allowlist_required is True
    assert mc.token_source() == "connection" and mc.reconnect_needed() is False
    # Pacing, the shared pause and provider refresh follow the ACTIVE key.
    assert meta_ads._server_token_matches(config) is True
    from dataclasses import replace

    assert meta_ads._server_token_matches(replace(config, access_token=ENV_TOKEN)) is False
    assert meta_ads._server_token_matches(replace(config, access_token="")) is False
    # The plain key is never in the database; the record holds ciphertext and facts only.
    raw = _raw_rows()
    assert STORED_TOKEN not in raw and APP_SECRET not in raw
    record = mc.load_record(mc.CONNECTION_ID)
    assert record["alg"] == "A256GCM" and record["v"] == 1 and len(record["kid"]) == 8
    assert "ct" not in mc.public_facts(record) and "nonce" not in mc.public_facts(record)
    assert "kid" not in mc.public_facts(record)
    assert STORED_TOKEN not in repr(mc.active_connection())
    # Disconnect: back to the hosting key.
    assert mc.delete_record(mc.CONNECTION_ID) is True
    assert meta_ads.load_meta_ads_config().access_token == ENV_TOKEN
    assert mc.token_source() == "environment"


def test_key_change_makes_the_record_unreadable_and_falls_back(env):
    _store()
    assert mc.token_source() == "connection"
    env.setenv("ALBAYAN_META_CONNECTION_KEY", _new_key())
    mc.invalidate()
    config = meta_ads.load_meta_ads_config()
    assert config.access_token == ENV_TOKEN and config.allowed_account_ids == ("111", "222")
    assert config.allowlist_required is False
    assert mc.token_source() == "environment" and mc.reconnect_needed() is True
    assert meta_ads._server_token_matches(config) is True


def test_other_app_id_or_damaged_record_is_unreadable(env):
    _store()
    env.setenv("ALBAYAN_META_APP_ID", "999999999999999")  # the AAD binds the app id
    mc.invalidate()
    assert mc.active_connection() is None and mc.reconnect_needed() is True
    env.setenv("ALBAYAN_META_APP_ID", APP_ID)
    mc.invalidate()
    assert mc.token_source() == "connection"
    record = mc.load_record(mc.CONNECTION_ID)
    cipher = bytearray(base64.urlsafe_b64decode(record["ct"]))
    cipher[0] ^= 1
    with db_conn() as conn:  # a damaged row, written behind the module's back
        conn.execute(
            text("UPDATE entities SET data_json=:d WHERE type='metaHealthState' AND id='connection'"),
            {"d": json.dumps({**record, "ct": base64.urlsafe_b64encode(bytes(cipher)).decode("ascii"),
                              "updatedAt": "2000-01-01T00:00:00Z"})},
        )
    mc.invalidate()
    assert mc.active_connection() is None and mc.reconnect_needed() is True
    assert meta_ads.load_meta_ads_config().access_token == ENV_TOKEN
    # A record bound to another id never opens as the connection either.
    sealed = mc.encrypt_secret("other", mc.CHOICE_ID)
    assert mc.decrypt_secret(sealed, mc.CONNECTION_ID) is None
    assert mc.decrypt_secret(sealed, mc.CHOICE_ID) == "other"
    assert mc.decrypt_secret({"alg": "none"}, mc.CONNECTION_ID) is None
    assert mc.decrypt_secret("junk", mc.CONNECTION_ID) is None


def test_key_from_the_app_secret_and_invalid_key_variable(env):
    env.delenv("ALBAYAN_META_CONNECTION_KEY")
    assert mc.key_source() == "app_secret" and mc.key_state() == "ok" and mc.app_ready() is True
    _store()
    assert mc.token_source() == "connection"
    env.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET + "-reset")  # the owner reset the app secret
    mc.invalidate()
    assert mc.token_source() == "environment" and mc.reconnect_needed() is True
    env.setenv("ALBAYAN_META_CONNECTION_KEY", "not-a-valid-key")  # set but unusable: no silent fallback
    assert mc.connection_key() is None and mc.key_state() == "INVALID" and mc.app_ready() is False
    assert mc.encrypt_secret("x", mc.CONNECTION_ID) is None
    env.delenv("ALBAYAN_META_CONNECTION_KEY")
    env.delenv("ALBAYAN_META_APP_SECRET")
    assert mc.connection_key() is None and mc.key_state() == "MISSING" and mc.app_ready() is False


def test_cache_holds_for_its_ttl_and_invalidate_rereads(env):
    assert mc.token_source() == "environment"  # cached: no connection
    sealed = mc.encrypt_secret(STORED_TOKEN, mc.CONNECTION_ID)
    with db_conn() as conn:  # written behind the module's back: the cache does not see it yet
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('metaHealthState','connection',:d,false,1,NULL,1)"
            ),
            {"d": json.dumps({**sealed, "selectedAccountIds": []})},
        )
    assert mc.token_source() == "environment"
    mc.invalidate()
    assert mc.token_source() == "connection"


# --------------------------------------------------------------------------- allowlist


def test_selection_replaces_the_hosting_list_and_empty_means_none(env):
    _store(selected=("act_444", "333", "bad", "333"))
    config = meta_ads.load_meta_ads_config()
    assert config.allowed_account_ids == ("444", "333")
    assert mc.active_allowed_accounts(("111",)) == ("444", "333")
    meta_client = meta_ads.get_meta_ads_client()
    assert meta_client._ensure_allowed_account("444") == "444"
    with pytest.raises(meta_ads.MetaAdsError):
        meta_client._ensure_allowed_account("111")  # a hosting-list account is not in the selection

    def updated(current):
        return {**current, "selectedAccountIds": []}

    assert mc.update_record(mc.CONNECTION_ID, updated) is not None
    empty = meta_ads.load_meta_ads_config()
    assert empty.allowed_account_ids == () and empty.allowlist_required is True
    assert mc.allowlist_required() is True
    assert meta_ads.ad_account_allowlist_configured() is False
    empty_client = meta_ads.get_meta_ads_client()
    for account in ("111", "333", "444", "999"):
        with pytest.raises(meta_ads.MetaAdsError) as refused:
            empty_client._ensure_allowed_account(account)
        assert refused.value.code == "account_not_allowed"
    # Listing through the filtered client shows nothing (the selection UI uses an unfiltered one).
    env.setattr(meta_ads.MetaAdsClient, "_paged", lambda self, *a, **k: [{"account_id": "333", "name": "Shop A"}])
    assert empty_client.list_accounts() == []
    from dataclasses import replace

    unfiltered = meta_ads.MetaAdsClient(replace(empty, allowlist_required=False))
    assert [row["id"] for row in unfiltered.list_accounts()] == ["333"]


def test_studio_funds_flags_hide_every_account_for_an_empty_selection(env):
    _store(selected=())
    env.setattr(meta_ads, "_load_funds_state", lambda: {"accounts": [{"id": "333", "fundsKnown": True}]})
    assert meta_ads.studio_funds_flags()["accounts"] == []


# --------------------------------------------------------------------------- the change hook


def test_change_hook_clears_page_tokens_funds_and_cache_and_starts_the_worker(env):
    started = []
    env.setattr(meta_ads, "start_meta_ads_worker", lambda: started.append(True))
    with meta_ads._PAGE_TOKEN_LOCK:
        meta_ads._PAGE_TOKEN_CACHE["777"] = ("EAAGpagetoken-old", 9e18)
    meta_ads._META_FUNDS_CACHE.update({"result": {"accounts": []}, "at": 1, "ttl": 1})
    assert mc.token_source() == "environment"
    assert mc._CACHE["at"] is not None
    meta_ads.meta_connection_changed()
    assert meta_ads._PAGE_TOKEN_CACHE == {} and meta_ads._META_FUNDS_CACHE == {}
    assert mc._CACHE["at"] is None and started == [True]


def test_change_hook_never_raises(env):
    def boom():
        raise RuntimeError("worker failed")

    env.setattr(meta_ads, "start_meta_ads_worker", boom)
    meta_ads.meta_connection_changed()  # no exception


# --------------------------------------------------------------------------- studio checks


def test_studio_token_checks_see_a_stored_key(env):
    env.delenv("ALBAYAN_META_ACCESS_TOKEN")
    checks = (studio_jobs.results_sync_configured, studio_ig_source.token_set, studio_alerts_meta.meta_watch_configured)
    assert [check() for check in checks] == [False, False, False]
    _store()
    assert [check() for check in checks] == [True, True, True]
    mc.delete_record(mc.CONNECTION_ID)
    assert [check() for check in checks] == [False, False, False]
    env.setenv("ALBAYAN_META_ACCESS_TOKEN", ENV_TOKEN)
    assert [check() for check in checks] == [True, True, True]


# --------------------------------------------------------------------------- routes and reports


def test_status_and_token_health_report_the_key_source(env, people):
    response = client.get("/api/meta-ads/status", cookies=people["admin"])
    assert response.status_code == 200, response.text
    assert response.json()["tokenSource"] == "environment" and response.json()["reconnectNeeded"] is False
    assert token_health.token_health_report()["tokenSource"] == "environment"
    _store()
    response = client.get("/api/meta-ads/status", cookies=people["admin"])
    body = response.text
    assert response.json()["tokenSource"] == "connection" and response.json()["allowedAccountCount"] == 1
    report = token_health.token_health_report()
    assert report["tokenSource"] == "connection" and report["reconnectNeeded"] is False
    health = client.get("/api/meta-ads/token-health", cookies=people["admin"])
    assert health.status_code == 200, health.text
    assert health.json()["tokenSource"] == "connection"
    for secret in SECRETS:
        assert secret not in body and secret not in health.text and secret not in json.dumps(report)
    assert client.get("/api/meta-ads/status", cookies=people["staff"]).status_code == 403
    env.delenv("ALBAYAN_META_ACCESS_TOKEN")
    mc.delete_record(mc.CONNECTION_ID)
    assert token_health.token_health_report()["tokenSource"] == "none"
    assert token_health.token_health_report()["reason"] == "no_access_token"


def test_full_backup_leaves_the_connection_rows_out(env, people):
    _store()
    assert mc.save_record(mc.PENDING_ID, {"stateHash": "a" * 64}) is not None
    assert mc.save_record(mc.SETTINGS_ID, {"loginConfigId": "123456"}) is not None
    neighbour = f"probe-{TAG}"  # another metaHealthState row, which must stay in the backup
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('metaHealthState',:i,:d,false,1,NULL,1)"
            ),
            {"i": neighbour, "d": json.dumps({"id": neighbour})},
        )
    reset_rate_limit(f"full-backup:{people['admin_id']}")
    response = client.get("/api/admin/backup/full", cookies=people["admin"])
    assert response.status_code == 200, response.text
    raw = response.content
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    payload = raw.decode("utf-8")
    lines = [json.loads(line) for line in payload.splitlines() if line.strip()]
    header = lines[0]
    assert "metaHealthState/connection*" in header["excluded"]
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type='metaHealthState' AND id=:i"), {"i": neighbour})
    ids = {(row.get("collection"), row.get("id")) for row in lines[1:] if row.get("_type") == "entity"}
    assert not any(kind == "metaHealthState" and str(rid).startswith("connection") for kind, rid in ids)
    assert ("metaHealthState", neighbour) in ids
    for secret in SECRETS:
        assert secret not in payload
    record = mc.load_record(mc.CONNECTION_ID)
    assert record["ct"] not in payload and record["nonce"] not in payload


def test_generic_api_import_and_restore_cannot_touch_the_rows(env, people):
    _store()
    before = mc.load_record(mc.CONNECTION_ID)
    admin = people["admin"]
    assert client.get("/api/collections/metaHealthState", cookies=admin).status_code >= 400
    assert client.get("/api/collections/metaHealthState/connection", cookies=admin).status_code >= 400
    created = client.post("/api/collections/metaHealthState", json={"id": "connection", "data": {"ct": "x"}}, cookies=admin)
    assert created.status_code >= 400
    patched = client.patch("/api/collections/metaHealthState/connection", json={"data": {"ct": "x"}}, cookies=admin)
    assert patched.status_code >= 400
    deleted = client.delete("/api/collections/metaHealthState/connection", cookies=admin)
    assert deleted.status_code >= 400
    restored = client.put(
        "/api/admin/collections/metaHealthState/connection/restore", json={"data": {"ct": "x"}}, cookies=admin
    )
    assert restored.status_code == 405
    imported = client.post(
        "/api/admin/import",
        json={"collections": {"metaHealthState": [{"id": "connection", "ct": "x"}]}},
        cookies=admin,
    )
    assert imported.status_code == 405
    after = mc.load_record(mc.CONNECTION_ID)
    assert after["ct"] == before["ct"] and after["_lastModified"] == before["_lastModified"]
    for response in (created, patched, deleted, restored, imported):
        assert STORED_TOKEN not in response.text and before["ct"] not in response.text


# --------------------------------------------------------------------------- storage helpers


def test_storage_helpers_single_use_and_unknown_ids(env):
    assert mc.save_record("token", {"x": 1}) is None  # only connection* rows
    assert mc.load_record("token") == {}
    assert mc.delete_record("token") is False
    pending = mc.save_record(mc.PENDING_ID, {"stateHash": mc.sha256_hex("state-1"), "adminId": "a1"})
    assert pending and pending["recordType"] == "metaHealthState" and pending["updatedAt"]
    assert mc.consume_record(mc.PENDING_ID, lambda row: row.get("adminId") == "other") is None
    assert mc.load_record(mc.PENDING_ID)["adminId"] == "a1"  # a refused caller does not burn it
    taken = mc.consume_record(mc.PENDING_ID, lambda row: row.get("stateHash") == mc.sha256_hex("state-1"))
    assert taken and taken["adminId"] == "a1"
    assert mc.consume_record(mc.PENDING_ID, lambda _row: True) is None  # used once
    assert mc.load_record(mc.PENDING_ID) == {}
    first = mc.save_record(mc.RESULT_ID, {"ok": True, "code": "connected"})
    second = mc.update_record(mc.RESULT_ID, lambda current: {**current, "code": "disconnected"})
    assert second["code"] == "disconnected" and second["ok"] is True
    assert second["_lastModified"] > first["_lastModified"] - 1
    assert mc.update_record(mc.RESULT_ID, lambda _current: None) is None
    assert mc.load_record(mc.RESULT_ID)["code"] == "disconnected"


# --------------------------------------------------------------------------- log redaction


def test_httpx_log_lines_hide_code_state_secret_and_tokens(env, caplog):
    url = httpx.URL(
        "https://graph.facebook.com/v25.0/oauth/access_token",
        params={"client_id": APP_ID, "client_secret": APP_SECRET, "code": "AQcodeSECRET", "state": "stateSECRET",
                "redirect_uri": "https://example.test/cb", "access_token": STORED_TOKEN,
                "fb_exchange_token": "fbxSECRET", "revoke_token": "revokeSECRET"},
    )
    with caplog.at_level(logging.INFO, logger="httpx"):
        logging.getLogger("httpx").info('HTTP Request: %s %s "%s %d %s"', "GET", url, "HTTP/1.1", 200, "OK")
        logging.getLogger("httpx").info(f"plain line {url}")
    logged = caplog.text
    for value in (APP_SECRET, "AQcodeSECRET", "stateSECRET", STORED_TOKEN, "fbxSECRET", "revokeSECRET"):
        assert value not in logged
    assert "200 OK" in logged and APP_ID in logged
    assert mc.redact_text("error_code=190&code=abc") == "error_code=190&code=[redacted]"


def test_uvicorn_access_log_hides_the_callback_query(env, caplog):
    path = "/api/meta-ads/connection/callback?code=AQcodeSECRET&state=stateSECRET"
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", path, "1.1", 303)
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", f"/api/other?access_token={STORED_TOKEN}&state=s2SECRET", "1.1", 200
        )
    logged = caplog.text
    for value in ("AQcodeSECRET", "stateSECRET", STORED_TOKEN, "s2SECRET"):
        assert value not in logged
    assert "/api/meta-ads/connection/callback" in logged and "303" in logged
    before = (len(logging.getLogger("httpx").filters), len(logging.getLogger("uvicorn.access").filters))
    mc.install_log_guards()
    token_health.install_log_guard()
    assert (len(logging.getLogger("httpx").filters), len(logging.getLogger("uvicorn.access").filters)) == before
