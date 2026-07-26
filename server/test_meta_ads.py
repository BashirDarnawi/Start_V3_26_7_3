"""Security and accounting-isolation tests for read-only Meta Ads sync."""

import os
import sys
import hashlib
import hmac
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
import httpx
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
import server.meta_ads as meta_ads


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "meta-ads-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "MetaAdsAdmin123!"
EMPLOYEE_EMAIL = "meta-ads-employee@tests.albayanhub.com"
EMPLOYEE_PASSWORD = "MetaAdsEmployee123!"


def _insert_user(name, email, password, role, permissions):
    password_hash = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("meta_user")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:password_hash,:password_salt,"
                ":password_algo,:password_iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id,
                "name": name,
                "email": email,
                "role": role,
                "permissions": json_dumps(permissions),
                "password_hash": password_hash.hash_hex,
                "password_salt": password_hash.salt_hex,
                "password_algo": password_hash.algo,
                "password_iterations": password_hash.iterations,
                "stamp": stamp,
            },
        )
    return user_id


def _login(email, password):
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _insert_ad(ad_id, creator_id, **updates):
    stamp = now_ms()
    data = {
        "id": ad_id,
        "customerId": "meta_customer",
        "customerName": "Protected Customer",
        "amountUSD": 75.25,
        "amountLocal": 729.925,
        "exchangeRate": 9.7,
        "paymentStatus": "not_paid",
        "status": "Stopped",
        "receiptId": "protected_receipt",
        "receiptAllocations": [{"receiptId": "protected_receipt", "amountUSD": 50}],
        "dueAllocations": [{"receiptId": "due_receipt", "amountUSD": 25.25}],
        "adPhotos": ["data:image/png;base64,cHJvdGVjdGVk"],
        "notes": "Keep this local note",
        "_created": stamp,
        "_lastModified": stamp,
        "_deleted": False,
        "createdBy": creator_id,
    }
    data.update(updates)
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('ads',:id,:data,false,:stamp,:creator,:stamp)"
            ),
            {"id": ad_id, "data": json_dumps(data), "stamp": stamp, "creator": creator_id},
        )
    return stamp


def _stored_ad(ad_id):
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json,last_modified FROM entities WHERE type='ads' AND id=:id"),
            {"id": ad_id},
        ).mappings().first()
    assert row
    return json_loads(row["data_json"]), int(row["last_modified"])


def _snapshot(meta_ad_id="111111111111111", *, live_status="ACTIVE", daily=2000, spend=3.5):
    stamp = "2026-07-26T12:00:00Z"
    return {
        "metaLinkState": "linked",
        "metaLinkVersion": 1,
        "metaAdId": str(meta_ad_id),
        "metaAdName": f"Live Meta Ad {meta_ad_id}",
        "metaAdSetId": "222222222222222",
        "metaAdSetName": "Tripoli Messages",
        "metaCampaignId": "333333333333333",
        "metaCampaignName": "Summer Campaign",
        "metaAdAccountId": "444444444444444",
        "metaAdAccountName": "Albayan Business",
        "metaCurrency": "USD",
        "metaConfiguredStatus": "ACTIVE",
        "metaEffectiveStatus": live_status,
        "metaAdSetStatus": "ACTIVE",
        "metaCampaignStatus": "ACTIVE",
        "metaObjective": "OUTCOME_ENGAGEMENT",
        "metaBudgetSource": "adset",
        "metaDailyBudgetMinor": daily,
        "metaLifetimeBudgetMinor": 0,
        "metaBudgetRemainingMinor": 1650,
        "metaStartTime": "2026-07-25T00:00:00Z",
        "metaEndTime": "2026-07-30T00:00:00Z",
        "metaAdCreatedTime": "2026-07-24T00:00:00Z",
        "metaAdUpdatedTime": stamp,
        "metaSpend": spend,
        "metaSpendMinor": round(spend * 100),
        "metaReach": 1200,
        "metaImpressions": 1800,
        "metaClicks": 42,
        "metaPrimaryResultType": "messaging_conversation_started_7d",
        "metaPrimaryResultValue": 18,
        "metaActions": [{"type": "messaging_conversation_started_7d", "value": 18}],
        "metaSyncedAt": stamp,
        "metaLastAttemptAt": stamp,
        "metaLastChangedAt": stamp,
        "metaSyncError": "",
        "metaSyncErrorCode": "",
        "metaSyncFailureCount": 0,
        "metaNextSyncAt": now_ms() + 900_000,
        "metaUnlinkedAt": "",
    }


class FakeMetaClient:
    def __init__(self):
        self.snapshots = {}

    def get_ad_snapshot(self, meta_ad_id):
        return dict(self.snapshots.get(str(meta_ad_id)) or _snapshot(str(meta_ad_id)))

    def list_accounts(self):
        return [{"id": "444444444444444", "name": "Albayan Business", "currency": "USD", "timezone": "Africa/Tripoli", "status": 1}]

    def list_ads(self, account_id, search=""):
        rows = [{"id": "111111111111111", "name": "Live Meta Ad", "effectiveStatus": "ACTIVE", "campaignName": "Summer Campaign"}]
        needle = str(search or "").casefold()
        return [row for row in rows if not needle or needle in str(row).casefold()]


def test_real_meta_client_keeps_token_out_of_url_and_redacts_provider_errors(monkeypatch):
    token = "top-secret-meta-token"
    app_secret = "top-secret-app-secret"
    expected_proof = hmac.new(app_secret.encode(), token.encode(), hashlib.sha256).hexdigest()
    real_client_class = httpx.Client
    seen_requests = []

    def handler(request):
        seen_requests.append(request)
        assert request.headers.get("Authorization") == f"Bearer {token}"
        assert "access_token" not in request.url.params
        assert request.url.params.get("appsecret_proof") == expected_proof
        if request.url.path.endswith("/me/adaccounts"):
            return httpx.Response(
                200,
                json={"data": [{"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1}]},
            )
        return httpx.Response(401, json={"error": {"code": 190, "message": f"Provider echoed {token} {app_secret}"}})

    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return real_client_class(transport=transport, **kwargs)

    monkeypatch.setattr(meta_ads.httpx, "Client", client_factory)
    config = meta_ads.MetaAdsConfig(
        access_token=token,
        app_secret=app_secret,
        graph_version="v25.0",
        allowed_account_ids=("444444444444444",),
        background_sync=False,
        sync_interval_minutes=15,
        sync_batch_size=20,
        request_timeout_seconds=15,
    )
    real = meta_ads.MetaAdsClient(config)
    accounts = real.list_accounts()
    assert accounts[0]["id"] == "444444444444444"
    assert seen_requests[0].url.host == "graph.facebook.com"
    assert seen_requests[0].url.path.startswith("/v25.0/")

    with pytest.raises(meta_ads.MetaAdsError) as raised:
        real._get("me")
    assert raised.value.code == "authorization"
    assert token not in str(raised.value)
    assert app_secret not in str(raised.value)


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin_id = _insert_user("Meta Admin", ADMIN_EMAIL, ADMIN_PASSWORD, "Admin", {})
    employee_id = _insert_user("Meta Employee", EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD, "Employee", {"ads": ["view", "edit"]})
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    employee = _login(EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD)
    try:
        yield {"admin": admin, "employee": employee, "admin_id": admin_id, "employee_id": employee_id}
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE created_by IN (:admin,:employee)"), {"admin": admin_id, "employee": employee_id})
            conn.execute(text("DELETE FROM sessions WHERE user_id IN (:admin,:employee)"), {"admin": admin_id, "employee": employee_id})
            conn.execute(text("DELETE FROM audit_logs WHERE user_id IN (:admin,:employee) OR resource_id LIKE 'meta_test_%'"), {"admin": admin_id, "employee": employee_id})
            conn.execute(text("DELETE FROM users WHERE id IN (:admin,:employee)"), {"admin": admin_id, "employee": employee_id})


@pytest.fixture()
def configured_meta(monkeypatch):
    fake = FakeMetaClient()
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "secret-token-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "secret-app-value-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "444444444444444")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    return fake


def test_status_is_admin_only_and_never_reveals_secrets(actors, configured_meta):
    denied = client.get("/api/meta-ads/status", cookies=actors["employee"])
    assert denied.status_code == 403

    response = client.get("/api/meta-ads/status", cookies=actors["admin"])
    assert response.status_code == 200, response.text
    assert response.json()["configured"] is True
    assert response.json()["readOnly"] is True
    assert response.json()["allowedAccountCount"] == 1
    assert "secret-token" not in response.text
    assert "secret-app" not in response.text


def test_account_and_ad_browser_is_admin_only(actors, configured_meta):
    accounts = client.get("/api/meta-ads/accounts", cookies=actors["admin"])
    assert accounts.status_code == 200, accounts.text
    assert accounts.json()["accounts"][0]["id"] == "444444444444444"
    ads = client.get("/api/meta-ads/accounts/444444444444444/ads?search=Live", cookies=actors["admin"])
    assert ads.status_code == 200, ads.text
    assert ads.json()["ads"][0]["id"] == "111111111111111"
    denied = client.get("/api/meta-ads/accounts", cookies=actors["employee"])
    assert denied.status_code == 403


def test_link_and_sync_preserve_every_albayan_accounting_field(actors, configured_meta):
    ad_id = "meta_test_preserve"
    version = _insert_ad(ad_id, actors["admin_id"])
    before, _ = _stored_ad(ad_id)
    protected = {key: before[key] for key in ("customerId", "amountUSD", "amountLocal", "exchangeRate", "paymentStatus", "status", "receiptId", "receiptAllocations", "dueAllocations", "adPhotos", "notes")}

    linked = client.post(
        f"/api/meta-ads/ads/{ad_id}/link",
        json={"metaAdId": "111111111111111", "expectedLastModified": version, "operationId": "meta-link-preserve-1"},
        cookies=actors["admin"],
    )
    assert linked.status_code == 200, linked.text
    data, linked_version = _stored_ad(ad_id)
    assert data["metaAdId"] == "111111111111111"
    assert data["metaEffectiveStatus"] == "ACTIVE"
    for key, value in protected.items():
        assert data[key] == value, key
    assert any(change["field"] == "Meta ad link" for change in data["editHistory"][-1]["changes"])

    configured_meta.snapshots["111111111111111"] = _snapshot(live_status="PAUSED", daily=3500, spend=9.25)
    synced = client.post(
        f"/api/meta-ads/ads/{ad_id}/sync",
        json={"expectedLastModified": linked_version, "operationId": "meta-sync-preserve-1"},
        cookies=actors["admin"],
    )
    assert synced.status_code == 200, synced.text
    data, _ = _stored_ad(ad_id)
    assert data["metaEffectiveStatus"] == "PAUSED"
    assert data["metaDailyBudgetMinor"] == 3500
    assert data["metaSpendMinor"] == 925
    for key, value in protected.items():
        assert data[key] == value, key
    changed_fields = [change["field"] for change in data["editHistory"][-1]["changes"]]
    assert "Meta live status" in changed_fields
    assert "Meta daily budget" in changed_fields


def test_duplicate_meta_link_is_blocked_without_changing_second_ad(actors, configured_meta):
    first_id = "meta_test_unique_a"
    second_id = "meta_test_unique_b"
    first_version = _insert_ad(first_id, actors["admin_id"])
    second_version = _insert_ad(second_id, actors["admin_id"])
    first = client.post(
        f"/api/meta-ads/ads/{first_id}/link",
        json={"metaAdId": "555555555555555", "expectedLastModified": first_version, "operationId": "meta-unique-link-a"},
        cookies=actors["admin"],
    )
    assert first.status_code == 200, first.text
    duplicate = client.post(
        f"/api/meta-ads/ads/{second_id}/link",
        json={"metaAdId": "555555555555555", "expectedLastModified": second_version, "operationId": "meta-unique-link-b"},
        cookies=actors["admin"],
    )
    assert duplicate.status_code == 409
    second, unchanged_version = _stored_ad(second_id)
    assert "metaAdId" not in second
    assert unchanged_version == second_version


def test_unlink_removes_meta_only_and_is_idempotent(actors, configured_meta):
    ad_id = "meta_test_unlink"
    version = _insert_ad(ad_id, actors["admin_id"])
    before, _ = _stored_ad(ad_id)
    linked = client.post(
        f"/api/meta-ads/ads/{ad_id}/link",
        json={"metaAdId": "666666666666666", "expectedLastModified": version, "operationId": "meta-unlink-link-1"},
        cookies=actors["admin"],
    )
    assert linked.status_code == 200, linked.text
    linked_version = linked.json()["ad"]["lastModified"]
    payload = {"expectedLastModified": linked_version, "operationId": "meta-unlink-action-1"}
    removed = client.post(f"/api/meta-ads/ads/{ad_id}/unlink", json=payload, cookies=actors["admin"])
    assert removed.status_code == 200, removed.text
    replay = client.post(f"/api/meta-ads/ads/{ad_id}/unlink", json=payload, cookies=actors["admin"])
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    data, _ = _stored_ad(ad_id)
    assert "metaAdId" not in data
    assert data["metaLinkState"] == "unlinked"
    for key in ("customerId", "amountUSD", "amountLocal", "exchangeRate", "paymentStatus", "status", "receiptId", "receiptAllocations", "dueAllocations", "adPhotos", "notes"):
        assert data[key] == before[key], key


def test_ordinary_mutation_routes_cannot_forge_meta_state(actors, configured_meta):
    ad_id = "meta_test_forgery"
    version = _insert_ad(ad_id, actors["admin_id"])
    generic = client.patch(
        f"/api/collections/ads/{ad_id}",
        json={"data": {"metaEffectiveStatus": "ACTIVE"}, "expectedLastModified": version},
        cookies=actors["admin"],
    )
    assert generic.status_code == 403
    financial = client.post(
        "/api/ads/mutate",
        json={"action": "update", "adId": ad_id, "idempotencyKey": "meta-forge-mutate-1", "expectedLastModified": version, "data": {"metaAdId": "999999999999999"}},
        cookies=actors["admin"],
    )
    assert financial.status_code == 403
    data, unchanged_version = _stored_ad(ad_id)
    assert "metaAdId" not in data
    assert unchanged_version == version
