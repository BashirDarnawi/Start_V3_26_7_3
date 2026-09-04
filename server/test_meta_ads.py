"""Security and accounting-isolation tests for read-only Meta Ads sync."""

import os
import sys
import hashlib
import hmac
import json
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
        "metaCreativeId": "777777777777770",
        "metaThumbnailUrl": "https://lookaside.fbsbx.com/meta-ad-thumbnail.jpg",
        "metaThumbnailSource": "story",
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
        "metaMediaResolvedAt": stamp,
        "metaPageId": "777777777777777",
        "metaPageName": "Existing Meta Page",
        "metaPageCategory": "Business service",
        "metaPagePictureUrl": "https://scontent.xx.fbcdn.net/v/t39.30808-1/111111111_222222222333333_n.jpg?oh=aaa&oe=bbb",
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
        "metaTotalBudgetMinor": daily * 5,
        "metaTotalBudgetKind": "estimated_daily",
        "metaBudgetRemainingMinor": 1650,
        "metaTotalRemainingBudgetMinor": max(daily * 5 - round(spend * 100), 0),
        "metaStartTime": "2026-07-25T00:00:00Z",
        "metaEndTime": "2026-07-30T00:00:00Z",
        "metaDurationDays": 5,
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
        self.snapshot_calls = []
        self.list_calls = []
        self.spend_rows = []
        self.spend_calls = []
        self.spend_error = None
        self.page_identities = {}
        self.page_identity_calls = []
        self.account_calls = []
        self.account_currency = "USD"
        self.account_error = None
        self.rows = [
            {
                "id": "111111111111111",
                "name": "Live Meta Ad",
                "effectiveStatus": "ACTIVE",
                "campaignName": "Summer Campaign",
                "createdTime": "2026-07-20T00:00:00Z",
            }
        ]

    def get_ad_snapshot(self, meta_ad_id):
        self.snapshot_calls.append(str(meta_ad_id))
        return dict(self.snapshots.get(str(meta_ad_id)) or _snapshot(str(meta_ad_id)))

    def list_accounts(self):
        return [{"id": "444444444444444", "name": "Albayan Business", "currency": "USD", "timezone": "Africa/Tripoli", "status": 1}]

    def _get_account(self, account_id):
        # The real client caches this; discovery relies on that so the currency
        # costs one request per account, not one per imported ad.
        self.account_calls.append(str(account_id))
        if self.account_error is not None:
            raise self.account_error
        return {"id": str(account_id), "name": "Albayan Business", "currency": self.account_currency}

    def list_ads(self, account_id, search="", *, max_pages=5):
        self.list_calls.append((str(account_id), int(max_pages)))
        rows = list(self.rows)
        needle = str(search or "").casefold()
        return [row for row in rows if not needle or needle in str(row).casefold()]

    def get_ad_spend_rows_90d(self, account_id, *, max_pages=8):
        self.spend_calls.append(str(account_id))
        if self.spend_error is not None:
            raise self.spend_error
        return [dict(row) for row in self.spend_rows]

    def get_ad_page_identity(self, meta_ad_id):
        self.page_identity_calls.append(str(meta_ad_id))
        return dict(self.page_identities.get(str(meta_ad_id)) or {})


def test_meta_display_helpers_are_bounded_and_reject_private_thumbnail_urls():
    assert meta_ads._duration_days("2026-07-25T00:00:00Z", "2026-07-30T00:00:00Z") == 5
    assert meta_ads._planned_budget(2000, 0, 5) == (10000, "estimated_daily")
    assert meta_ads._planned_budget(2000, 7500, 5) == (7500, "lifetime")
    assert meta_ads._total_remaining_budget(10000, 350) == 9650
    assert meta_ads._total_remaining_budget(10000, 12000) == 0
    assert meta_ads._clean_https_url("http://example.com/ad.jpg") == ""
    assert meta_ads._clean_https_url("https://127.0.0.1/ad.jpg") == ""
    assert meta_ads._clean_https_url("https://lookaside.fbsbx.com/ad.jpg").startswith("https://")


def test_real_ad_media_wins_over_generic_page_thumbnail():
    page_logo = "https://lookaside.fbsbx.com/page-logo.jpg"
    ad_picture = "https://lookaside.fbsbx.com/actual-ad-picture.jpg"
    creative = {
        "thumbnail_url": page_logo,
        "image_url": ad_picture,
        "effective_object_story_id": "777777777777777_123456789012345",
    }
    assert meta_ads._story_object_id(creative) == "777777777777777_123456789012345"
    assert meta_ads._creative_thumbnail_url(creative, {}) == ad_picture
    assert (
        meta_ads._creative_thumbnail_url(
            {"thumbnail_url": page_logo}, {}, include_generic_thumbnail=False
        )
        == ""
    )
    assert (
        meta_ads._story_media_url(
            {
                "full_picture": ad_picture,
                "attachments": {
                    "data": [{"media": {"image": {"src": page_logo}}}]
                },
            }
        )
        == ad_picture
    )
    assert meta_ads._creative_image_hashes(
        {"image_hash": "a" * 32}, {}
    ) == ["a" * 32]
    assert meta_ads._story_page_identity(
        {"from": {"id": "777777777777777", "name": "Real Page Name"}}
    ) == ("777777777777777", "Real Page Name")


def test_transient_meta_failures_retry_soon_then_back_off_safely():
    config = meta_ads.MetaAdsConfig(
        access_token="test-token",
        app_secret="",
        graph_version="v25.0",
        allowed_account_ids=("444444444444444",),
        background_sync=False,
        sync_interval_minutes=15,
        sync_batch_size=2,
        request_timeout_seconds=15,
    )
    transient = meta_ads.MetaAdsError(
        "rate_limited", "Meta is temporarily limiting synchronization.", retryable=True
    )
    permanent = meta_ads.MetaAdsError("not_found", "Meta ad was not found.")
    assert meta_ads._sync_failure_delay_ms(config, 1, transient) == 60_000
    assert meta_ads._sync_failure_delay_ms(config, 2, transient) == 120_000
    assert meta_ads._sync_failure_delay_ms(config, 10, transient) == 15 * 60_000
    assert meta_ads._sync_failure_delay_ms(config, 1, permanent) == 15 * 60_000


def test_process_wide_meta_backoff_prevents_more_provider_calls(monkeypatch):
    client_calls = []

    def forbidden_client(**kwargs):
        client_calls.append(kwargs)
        raise AssertionError("HTTP must not be called during Meta backoff")

    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads.httpx, "Client", forbidden_client)
    real = meta_ads.MetaAdsClient(
        meta_ads.MetaAdsConfig(
            access_token="test-token",
            app_secret="",
            graph_version="v25.0",
            allowed_account_ids=("444444444444444",),
            background_sync=False,
            sync_interval_minutes=15,
            sync_batch_size=2,
            request_timeout_seconds=15,
        )
    )
    meta_ads._set_meta_remote_backoff(30)
    with pytest.raises(meta_ads.MetaAdsError) as raised:
        real._get("me/adaccounts")
    assert raised.value.code == "rate_limited"
    assert raised.value.retryable is True
    assert client_calls == []


def test_success_usage_headers_pause_before_meta_rejects_requests(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "test-token")
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_USAGE_PERCENT", 0)
    persisted = []
    monkeypatch.setattr(
        meta_ads, "_persist_meta_provider_state", lambda: persisted.append(True)
    )
    config = meta_ads.MetaAdsConfig(
        access_token="test-token",
        app_secret="",
        graph_version="v25.0",
        allowed_account_ids=("444444444444444",),
        background_sync=False,
        sync_interval_minutes=15,
        sync_batch_size=2,
        request_timeout_seconds=15,
    )
    usage = json.dumps(
        {
            "444444444444444": [
                {
                    "type": "ads_management",
                    "call_count": 93,
                    "total_cputime": 40,
                    "total_time": 55,
                }
            ]
        }
    )
    meta_ads._observe_meta_response(
        httpx.Response(200, headers={"x-business-use-case-usage": usage}),
        config,
    )
    assert meta_ads._meta_remote_backoff_remaining() >= 400
    assert meta_ads._public_meta_provider_state()["usagePercent"] == 93
    assert persisted == [True]
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)


def test_provider_cooldown_restores_after_process_restart(monkeypatch):
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_META_PROVIDER_STATE_REFRESHED_AT", 0.0)
    monkeypatch.setattr(
        meta_ads,
        "_load_meta_provider_state",
        lambda: {
            "backoffUntilMs": meta_ads.now_ms() + 120_000,
            "backoffReason": "meta_80004",
            "usagePercent": 100,
        },
    )
    meta_ads._refresh_meta_provider_state(force=True)
    state = meta_ads._public_meta_provider_state()
    assert state["paused"] is True
    assert state["retryAfterSeconds"] >= 100
    assert state["reason"] == "meta_80004"
    assert state["usagePercent"] == 100
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)


def test_rate_limit_is_provider_state_not_per_ad_failure():
    throttled = meta_ads.MetaAdsError(
        "rate_limited",
        "Meta synchronization is paused safely.",
        retryable=True,
    )
    assert (
        meta_ads.record_meta_sync_failure(
            "ad-safe-provider-pause",
            throttled,
            expected_last_modified=None,
        )
        is None
    )


def test_meta_activity_history_is_separate_and_deduplicated():
    data = {"metaChangeHistory": [], "metaChangeCount": 0}
    activity = {
        "eventId": "activity-1",
        "eventTime": "2026-07-27T12:30:00Z",
        "eventType": "update_ad_name",
        "eventLabel": "Updated ad name",
        "actorName": "Bashir",
        "objectId": "111111111111111",
        "objectName": "Summer ad",
        "objectType": "AD",
        "tool": "ADS_MANAGER",
        "extraData": json.dumps({"field": "name", "old_value": "Old", "new_value": "New"}),
    }
    assert meta_ads._append_meta_activities(data, [activity]) == 1
    assert meta_ads._append_meta_activities(data, [activity]) == 0
    assert data["metaChangeCount"] == 1
    assert data["metaChangeHistory"][0]["source"] == "meta_activity"
    assert data["metaChangeHistory"][0]["editedBy"] == "Bashir"
    assert any(change["field"] == "name" for change in data["metaChangeHistory"][0]["changes"])


def _insert_page(page_id, creator_id, name):
    stamp = now_ms()
    data = {
        "id": page_id,
        "name": name,
        "category": "Manual category",
        "customerIds": [],
        "_created": stamp,
        "_lastModified": stamp,
        "_deleted": False,
    }
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('pages',:id,:data,false,:stamp,:creator,:stamp)"
            ),
            {
                "id": page_id,
                "data": json_dumps(data),
                "stamp": stamp,
                "creator": creator_id,
            },
        )
    return stamp


def _clear_auto_import_rows():
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT type,id,data_json FROM entities WHERE deleted=false")
        ).mappings().all()
        for row in rows:
            data = json_loads(row.get("data_json") or "{}") or {}
            if row["type"] in ("metaImportState", "metaPartnerState") or (
                isinstance(data, dict) and data.get("metaImportSource") == "meta_ads"
            ):
                conn.execute(
                    text("DELETE FROM entities WHERE type=:type AND id=:id"),
                    {"type": row["type"], "id": row["id"]},
                )


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


def test_streamed_response_cap_stops_before_retaining_oversized_body():
    class _CountingStream(httpx.SyncByteStream):
        def __init__(self, chunks):
            self.chunks = chunks
            self.reads = 0

        def __iter__(self):
            for chunk in self.chunks:
                self.reads += 1
                yield chunk

    declared_stream = _CountingStream([b"must-not-be-read"])
    declared = httpx.Response(
        200,
        headers={"content-length": "100"},
        stream=declared_stream,
    )
    assert meta_ads._read_capped_response_body(declared, 10) is None
    assert declared_stream.reads == 0
    declared.close()

    chunked_stream = _CountingStream([b"1234", b"5678", b"unused"])
    chunked = httpx.Response(200, stream=chunked_stream)
    assert meta_ads._read_capped_response_body(chunked, 6) is None
    assert chunked_stream.reads == 2
    chunked.close()


def test_due_sync_job_lock_skips_overlapping_pass_without_blocking(monkeypatch):
    assert meta_ads._META_DUE_SYNC_LOCK.acquire(blocking=False)
    try:
        monkeypatch.setattr(
            meta_ads,
            "load_meta_ads_config",
            lambda: (_ for _ in ()).throw(AssertionError("overlap entered sync body")),
        )
        assert meta_ads.sync_due_meta_ads(limit=1) == []
    finally:
        meta_ads._META_DUE_SYNC_LOCK.release()


def test_real_meta_client_discovers_in_review_ads_and_tolerates_missing_insights(
    monkeypatch,
):
    real_client_class = httpx.Client
    pending_id = "999999999999991"
    adset_id = "888888888888881"
    campaign_id = "777777777777771"
    creative_id = "666666666666661"
    story_id = "777777777777777_123456789012345"
    image_hash = "a" * 32

    def handler(request):
        path = request.url.path
        if path.endswith("/act_444444444444444/ads"):
            statuses = json.loads(request.url.params.get("effective_status") or "[]")
            assert "PENDING_REVIEW" in statuses
            assert "IN_PROCESS" in statuses
            assert "DELETED" not in statuses
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": pending_id,
                            "name": "New ad in review",
                            "status": "ACTIVE",
                            "effective_status": "PENDING_REVIEW",
                            "adset_id": adset_id,
                            "campaign_id": campaign_id,
                            "created_time": "2026-07-27T14:44:00+0000",
                        }
                    ]
                },
            )
        if path.endswith(f"/{pending_id}/insights"):
            return httpx.Response(
                400,
                json={"error": {"code": 100, "message": "No insights yet"}},
            )
        if path.endswith(f"/{pending_id}"):
            return httpx.Response(
                200,
                json={
                    "id": pending_id,
                    "name": "New ad in review",
                    "status": "ACTIVE",
                    "effective_status": "PENDING_REVIEW",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {"id": creative_id},
                    "created_time": "2026-07-27T14:44:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            assert request.url.params.get("thumbnail_width") == "512"
            assert request.url.params.get("thumbnail_height") == "512"
            return httpx.Response(
                200,
                json={
                    "id": creative_id,
                    "thumbnail_url": "https://lookaside.fbsbx.com/page-logo.jpg",
                    "image_hash": image_hash,
                    "effective_object_story_id": story_id,
                },
            )
        if path.endswith(f"/{story_id}"):
            return httpx.Response(
                400,
                json={"error": {"code": 100, "message": "Page post unavailable"}},
            )
        if path.endswith("/act_444444444444444/adimages"):
            assert json.loads(request.url.params.get("hashes") or "[]") == [image_hash]
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "hash": image_hash,
                            "url": "https://lookaside.fbsbx.com/real-ad-media.jpg",
                        }
                    ]
                },
            )
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "777777777777777",
                            "name": "Real Page Name",
                            "category": "Business service",
                        }
                    ]
                },
            )
        if path.endswith("/777777777777777"):
            return httpx.Response(
                400,
                json={"error": {"code": 100, "message": "Page node unavailable"}},
            )
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(
                200,
                json={
                    "id": adset_id,
                    "name": "Pending ad set",
                    "status": "ACTIVE",
                    "effective_status": "IN_PROCESS",
                    "daily_budget": "300",
                    "start_time": "2026-07-27T00:00:00+0000",
                    "end_time": "2026-08-01T00:00:00+0000",
                },
            )
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(
                200,
                json={
                    "id": campaign_id,
                    "name": "Pending campaign",
                    "status": "ACTIVE",
                    "effective_status": "IN_PROCESS",
                },
            )
        if path.endswith("/act_444444444444444"):
            return httpx.Response(
                200,
                json={
                    "id": "act_444444444444444",
                    "account_id": "444444444444444",
                    "name": "Albayan Business",
                    "currency": "USD",
                    "account_status": 1,
                },
            )
        return httpx.Response(404, json={"error": {"code": 100}})

    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return real_client_class(transport=transport, **kwargs)

    monkeypatch.setattr(meta_ads.httpx, "Client", client_factory)
    real = meta_ads.MetaAdsClient(
        meta_ads.MetaAdsConfig(
            access_token="test-token",
            app_secret="",
            graph_version="v25.0",
            allowed_account_ids=("444444444444444",),
            background_sync=False,
            sync_interval_minutes=15,
            sync_batch_size=20,
            request_timeout_seconds=15,
        )
    )
    listed = real.list_ads("444444444444444")
    assert listed[0]["id"] == pending_id
    assert listed[0]["effectiveStatus"] == "PENDING_REVIEW"

    snapshot = real.get_ad_snapshot(pending_id)
    assert snapshot["metaEffectiveStatus"] == "PENDING_REVIEW"
    assert snapshot["metaDailyBudgetMinor"] == 300
    assert snapshot["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/real-ad-media.jpg"
    assert snapshot["metaThumbnailSource"] == "ad_image"
    assert snapshot["metaMediaVersion"] == meta_ads._META_MEDIA_VERSION
    assert snapshot["metaPageName"] == "Real Page Name"
    assert snapshot["metaDurationDays"] == 5
    assert snapshot["metaTotalBudgetMinor"] == 1500
    assert snapshot["metaTotalBudgetKind"] == "estimated_daily"
    assert snapshot["metaTotalRemainingBudgetMinor"] == 1500
    assert snapshot["metaSpendMinor"] == 0


def _real_client(monkeypatch, handler):
    real_client_class = httpx.Client
    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return real_client_class(transport=transport, **kwargs)

    monkeypatch.setattr(meta_ads.httpx, "Client", client_factory)
    return meta_ads.MetaAdsClient(
        meta_ads.MetaAdsConfig(
            access_token="test-token",
            app_secret="",
            graph_version="v25.0",
            allowed_account_ids=("444444444444444",),
            background_sync=False,
            sync_interval_minutes=15,
            sync_batch_size=20,
            request_timeout_seconds=15,
        )
    )


def test_transient_meta_data_errors_are_retryable_and_cdn_keys_are_stable():
    probe = meta_ads.MetaAdsClient(
        meta_ads.MetaAdsConfig(
            access_token="test-token",
            app_secret="",
            graph_version="v25.0",
            allowed_account_ids=("444444444444444",),
            background_sync=False,
            sync_interval_minutes=15,
            sync_batch_size=2,
            request_timeout_seconds=15,
        )
    )
    reduced = probe._safe_error(
        httpx.Response(400),
        {"error": {"code": 1, "message": "Please reduce the amount of data"}},
    )
    assert reduced.code == "temporary"
    assert reduced.retryable is True
    assert reduced.provider_code == "1"

    avatar = "https://scontent.xx.fbcdn.net/v/t39.30808-1/123456789_987654321012345_n.jpg"
    assert meta_ads._cdn_asset_key(f"{avatar}?stp=dst-jpg_p64x64&oh=aaa") == (
        meta_ads._cdn_asset_key(f"{avatar}?oh=bbb&oe=ccc")
    ) != ""
    # Generic path names must never match anything.
    assert meta_ads._cdn_asset_key("https://scontent.xx.fbcdn.net/picture") == ""
    assert meta_ads._cdn_asset_key("http://scontent.xx.fbcdn.net/a_b_c_long_name.jpg") == ""


def test_ad_account_throttling_is_retryable_and_respects_regain_time(monkeypatch):
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    probe = meta_ads.MetaAdsClient(
        meta_ads.MetaAdsConfig(
            access_token="test-token",
            app_secret="",
            graph_version="v25.0",
            allowed_account_ids=("444444444444444",),
            background_sync=False,
            sync_interval_minutes=15,
            sync_batch_size=2,
            request_timeout_seconds=15,
        )
    )
    # Marketing API ad-account throttling arrives as HTTP 400 code 80004 —
    # it must be treated as "wait and retry", never as a permanent failure.
    usage = json.dumps(
        {
            "1613934299308344": [
                {
                    "type": "ads_management",
                    "call_count": 100,
                    "total_cputime": 90,
                    "total_time": 95,
                    "estimated_time_to_regain_access": 4,
                }
            ]
        }
    )
    throttled = probe._safe_error(
        httpx.Response(400, headers={"x-business-use-case-usage": usage}),
        {"error": {"code": 80004, "message": "There have been too many calls to this ad-account."}},
    )
    assert throttled.code == "rate_limited"
    assert throttled.retryable is True
    assert throttled.provider_code == "80004"
    # The regain estimate (minutes) arms the process-wide pause.
    assert meta_ads._meta_remote_backoff_remaining() >= 200

    assert meta_ads._estimated_backoff_seconds(
        httpx.Response(400, headers={"Retry-After": "90"})
    ) == 90
    assert meta_ads._estimated_backoff_seconds(httpx.Response(400)) == 60


def test_ads_edge_falls_back_to_slim_fields_when_meta_rejects_expansion(monkeypatch):
    calls = []

    def handler(request):
        fields = str(request.url.params.get("fields") or "")
        calls.append(fields)
        if request.url.path.endswith("/act_444444444444444/ads"):
            if "creative{" in fields or "creative." in fields:
                return httpx.Response(
                    400,
                    json={"error": {"code": 1, "message": "Please reduce the amount of data you're asking for"}},
                )
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "999999999999992",
                            "name": "Slim discovered ad",
                            "status": "ACTIVE",
                            "effective_status": "ACTIVE",
                            "adset_id": "888888888888882",
                            "campaign_id": "777777777777772",
                            "created_time": "2026-07-28T00:10:00+0000",
                        }
                    ]
                },
            )
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    listed = real.list_ads("444444444444444")
    assert [row["id"] for row in listed] == ["999999999999992"]
    assert listed[0]["name"] == "Slim discovered ad"
    assert len(calls) == 2
    # The retry must not repeat the heavy creative expansion.
    assert "creative" not in calls[1]


def test_snapshot_decomposes_failed_mega_read_and_rejects_page_avatar_photo(monkeypatch):
    ad_id = "999999999999993"
    adset_id = "888888888888883"
    campaign_id = "777777777777773"
    creative_id = "666666666666663"
    page_id = "777777777777778"
    story_id = f"{page_id}_123456789012399"
    avatar_asset = "123456789_987654321012345_n.jpg"

    def handler(request):
        path = request.url.path
        fields = str(request.url.params.get("fields") or "")
        if path.endswith(f"/{ad_id}/insights"):
            return httpx.Response(400, json={"error": {"code": 100, "message": "No insights"}})
        if path.endswith(f"/{ad_id}"):
            if "insights" in fields:
                return httpx.Response(
                    400,
                    json={"error": {"code": 1, "message": "Please reduce the amount of data you're asking for"}},
                )
            return httpx.Response(
                200,
                json={
                    "id": ad_id,
                    "name": "Existing post ad",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {"id": creative_id},
                    "created_time": "2026-07-28T00:20:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            return httpx.Response(
                200,
                json={
                    "id": creative_id,
                    "thumbnail_url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?stp=dst-jpg_p64x64&oh=aaa",
                    "effective_object_story_id": story_id,
                },
            )
        if path.endswith(f"/{story_id}"):
            return httpx.Response(400, json={"error": {"code": 10, "message": "Page post denied"}})
        if path.endswith(f"/{page_id}/picture"):
            return httpx.Response(
                200,
                json={"data": {"url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?oh=bbb"}},
            )
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(
                200,
                json={"data": [{"id": page_id, "name": "Real Client Page", "category": "Clothing store"}]},
            )
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(
                200,
                json={
                    "id": adset_id,
                    "name": "Existing post ad set",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "daily_budget": "500",
                    "start_time": "2026-07-27T00:00:00+0000",
                    "end_time": "2026-08-06T00:00:00+0000",
                },
            )
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(
                200,
                json={"id": campaign_id, "name": "Existing post campaign", "status": "ACTIVE", "effective_status": "ACTIVE"},
            )
        if path.endswith("/act_444444444444444"):
            return httpx.Response(
                200,
                json={"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1},
            )
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    snapshot = real.get_ad_snapshot(ad_id)
    # The failed combined read must not fail the ad: the decomposed reads
    # still deliver the budgets, schedule and real page identity.
    assert snapshot["metaAdName"] == "Existing post ad"
    assert snapshot["metaDailyBudgetMinor"] == 500
    assert snapshot["metaDurationDays"] == 10
    assert snapshot["metaPageId"] == page_id
    assert snapshot["metaPageName"] == "Real Client Page"
    assert snapshot["metaPageCategory"] == "Clothing store"
    # The generic creative thumbnail IS the Page profile picture. The user
    # prefers a picture over an empty tile, so it is shown — but labelled
    # page_avatar so the UI can say it is a substitute, and any later real
    # photo replaces it.
    assert avatar_asset in snapshot["metaThumbnailUrl"]
    assert snapshot["metaThumbnailSource"] == "page_avatar"
    assert snapshot["metaMediaTrace"] == ""
    assert snapshot["metaMediaVersion"] == meta_ads._META_MEDIA_VERSION
    # The Page profile picture also travels on its own dedicated field, so
    # the UI can show it beside the ad photo for every ad of the page.
    assert avatar_asset in snapshot["metaPagePictureUrl"]


def test_avatar_check_fails_closed_when_page_picture_is_unreadable(monkeypatch):
    ad_id = "999999999999995"
    adset_id = "888888888888885"
    campaign_id = "777777777777775"
    creative_id = "666666666666665"
    page_id = "777777777777781"
    story_id = f"{page_id}_123456789012401"
    avatar_asset = "123456789_987654321012345_n.jpg"

    def handler(request):
        path = request.url.path
        if path.endswith(f"/{ad_id}/insights"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{ad_id}"):
            return httpx.Response(
                200,
                json={
                    "id": ad_id,
                    "name": "Existing post ad",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {"id": creative_id},
                    "created_time": "2026-07-28T00:40:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            return httpx.Response(
                200,
                json={
                    "id": creative_id,
                    "thumbnail_url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?stp=dst-jpg_p64x64",
                    "effective_object_story_id": story_id,
                },
            )
        if path.endswith(f"/{story_id}"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{page_id}/picture"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(200, json={"data": []})
        if path.endswith(f"/{page_id}"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(200, json={"id": adset_id, "name": "Set", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(200, json={"id": campaign_id, "name": "Camp", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith("/act_444444444444444"):
            return httpx.Response(200, json={"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1})
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    snapshot = real.get_ad_snapshot(ad_id)
    # The only candidate photo is the generic creative thumbnail and the
    # avatar could not be checked. The user prefers a picture over an empty
    # tile, so it is shown under the generic fallback label.
    assert avatar_asset in snapshot["metaThumbnailUrl"]
    assert snapshot["metaThumbnailSource"] == "meta_fallback"
    # An unreadable avatar leaves the dedicated field empty instead of
    # failing the snapshot; apply_meta_snapshot keeps any earlier value.
    assert snapshot["metaPagePictureUrl"] == ""


def test_adcreatives_edge_recovers_photo_when_creative_node_is_denied(monkeypatch):
    ad_id = "999999999999996"
    creative_id = "666666666666667"
    adset_id = "888888888888886"
    campaign_id = "777777777777776"

    def handler(request):
        path = request.url.path
        if path.endswith(f"/{ad_id}/insights"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{ad_id}/adcreatives"):
            assert request.url.params.get("thumbnail_width") == "512"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": creative_id,
                            "image_url": "https://lookaside.fbsbx.com/real-ad-media-edge.jpg",
                        }
                    ]
                },
            )
        if path.endswith(f"/{ad_id}"):
            return httpx.Response(
                200,
                json={
                    "id": ad_id,
                    "name": "Edge ad",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {"id": creative_id},
                    "created_time": "2026-07-28T01:00:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            return httpx.Response(400, json={"error": {"code": 10, "message": "denied"}})
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(200, json={"id": adset_id, "name": "Set", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(200, json={"id": campaign_id, "name": "Camp", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith("/act_444444444444444"):
            return httpx.Response(200, json={"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1})
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    snapshot = real.get_ad_snapshot(ad_id)
    assert snapshot["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/real-ad-media-edge.jpg"
    assert snapshot["metaThumbnailSource"] == "creative"


def test_ad_preview_recovers_photo_for_boosted_client_page_posts(monkeypatch):
    ad_id = "999999999999997"
    adset_id = "888888888888887"
    campaign_id = "777777777777779"
    creative_id = "666666666666668"
    page_id = "777777777777782"
    story_id = f"{page_id}_123456789012402"
    avatar_asset = "123456789_987654321012345_n.jpg"
    real_asset = "555666777_888999000111222_n.jpg"
    preview_url = "https://www.facebook.com/ads/api/preview_iframe.php?d=signed&t=token"

    def handler(request):
        path = request.url.path
        host = request.url.host
        if host == "www.facebook.com" and path.endswith("/ads/api/preview_iframe.php"):
            assert "Authorization" not in request.headers
            # The preview is a JS-rendered shell: the real creative URL only
            # exists JSON-escaped inside a script, never as a plain <img>.
            return httpx.Response(
                200,
                html=(
                    "<html><body>"
                    f'<img src="https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?stp=dst-jpg_p64x64&oh=x">'
                    '<script>window.__d = {"media":{"image":{"uri":'
                    f'"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t39.30808-6\\/{real_asset}?stp=dst-jpg_p720x720\\u0026oh=y"'
                    "}}};</script>"
                    '<img src="https://static.xx.fbcdn.net/rsrc.php/ui.png">'
                    "</body></html>"
                ),
            )
        if path.endswith(f"/{ad_id}/insights"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{ad_id}/previews"):
            assert request.url.params.get("ad_format") in {
                "DESKTOP_FEED_STANDARD",
                "MOBILE_FEED_STANDARD",
            }
            return httpx.Response(
                200,
                json={"data": [{"body": f'<iframe src="{preview_url}&amp;extra=1" width="320"></iframe>'}]},
            )
        if path.endswith(f"/{ad_id}"):
            return httpx.Response(
                200,
                json={
                    "id": ad_id,
                    "name": "Boosted client post",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {"id": creative_id},
                    "created_time": "2026-07-28T02:00:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            return httpx.Response(
                200,
                json={
                    "id": creative_id,
                    "thumbnail_url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?stp=dst-jpg_p64x64",
                    "effective_object_story_id": story_id,
                },
            )
        if path.endswith(f"/{story_id}"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{page_id}/picture"):
            return httpx.Response(
                200,
                json={"data": {"url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?oh=z"}},
            )
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(200, json={"data": []})
        if path.endswith(f"/{page_id}"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(200, json={"id": adset_id, "name": "Set", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(200, json={"id": campaign_id, "name": "Camp", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith("/act_444444444444444"):
            return httpx.Response(200, json={"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1})
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    snapshot = real.get_ad_snapshot(ad_id)
    # The real rendered creative wins; the page avatar and static resources
    # in the preview document are filtered out.
    assert real_asset in snapshot["metaThumbnailUrl"]
    assert snapshot["metaThumbnailSource"] == "preview"


def test_ad_preview_revalidates_every_redirect(monkeypatch):
    ad_id = "999999999999996"
    preview_url = "https://www.facebook.com/ads/api/preview_iframe.php?d=signed"
    requested_hosts = []

    def handler(request):
        requested_hosts.append(request.url.host)
        if request.url.host == "graph.facebook.com":
            assert request.url.path.endswith(f"/{ad_id}/previews")
            return httpx.Response(
                200,
                json={"data": [{"body": f'<iframe src="{preview_url}"></iframe>'}]},
            )
        if request.url.host == "www.facebook.com":
            return httpx.Response(302, headers={"location": "https://127.0.0.1/private"})
        raise AssertionError(f"unsafe redirect was requested: {request.url}")

    real = _real_client(monkeypatch, handler)
    trace = []
    assert real.get_ad_preview_media_url(ad_id, trace=trace) == ""
    assert "preview:redirect_host" in trace
    assert "127.0.0.1" not in requested_hosts


def test_ad_preview_allows_bounded_facebook_redirects(monkeypatch):
    ad_id = "999999999999995"
    creative_url = "https://scontent.xx.fbcdn.net/v/t39.30808-6/creative.jpg?stp=dst-jpg_p720x720"

    def handler(request):
        if request.url.host == "graph.facebook.com":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "body": (
                                '<iframe src="https://www.facebook.com/preview/start">'
                                "</iframe>"
                            )
                        }
                    ]
                },
            )
        if request.url.host == "www.facebook.com" and request.url.path == "/preview/start":
            return httpx.Response(302, headers={"location": "/preview/final"})
        if request.url.host == "www.facebook.com" and request.url.path == "/preview/final":
            return httpx.Response(200, html=f'<img src="{creative_url}">')
        return httpx.Response(404)

    real = _real_client(monkeypatch, handler)
    assert real.get_ad_preview_media_url(ad_id) == creative_url


def test_bulk_ad_page_map_covers_archived_history(monkeypatch):
    page_id = "777777777777783"

    def handler(request):
        path = request.url.path
        if path.endswith("/act_444444444444444/ads"):
            statuses = json.loads(request.url.params.get("effective_status") or "[]")
            assert "ARCHIVED" in statuses
            assert "DELETED" in statuses
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "900000000000010",
                            "creative": {"effective_object_story_id": f"{page_id}_1"},
                        },
                        {
                            "id": "900000000000011",
                            "creative": {"object_story_spec": {"page_id": page_id}},
                        },
                        {"id": "900000000000012", "creative": {}},
                    ]
                },
            )
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    mapping = real.get_account_ad_page_map("444444444444444")
    assert mapping == {
        "900000000000010": page_id,
        "900000000000011": page_id,
    }


def test_page_profile_picture_is_final_fallback_when_no_media_route_works(monkeypatch):
    ad_id = "999999999999998"
    adset_id = "888888888888888"
    campaign_id = "777777777777791"
    creative_id = "666666666666669"
    page_id = "777777777777784"
    story_id = f"{page_id}_123456789012403"
    avatar_asset = "123456789_987654321012345_n.jpg"

    def handler(request):
        path = request.url.path
        if path.endswith(f"/{ad_id}/insights"):
            return httpx.Response(400, json={"error": {"code": 100}})
        if path.endswith(f"/{ad_id}/adcreatives"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{ad_id}/previews"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{ad_id}"):
            return httpx.Response(
                200,
                json={
                    "id": ad_id,
                    "name": "Locked-down ad",
                    "status": "ACTIVE",
                    "effective_status": "ACTIVE",
                    "account_id": "444444444444444",
                    "adset_id": adset_id,
                    "campaign_id": campaign_id,
                    "creative": {
                        "id": creative_id,
                        "effective_object_story_id": story_id,
                        "object_story_spec": {"page_id": page_id},
                    },
                    "created_time": "2026-07-28T03:00:00+0000",
                },
            )
        if path.endswith(f"/{creative_id}"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{story_id}"):
            return httpx.Response(400, json={"error": {"code": 10}})
        if path.endswith(f"/{page_id}/picture"):
            return httpx.Response(
                200,
                json={"data": {"url": f"https://scontent.xx.fbcdn.net/v/t39.30808-1/{avatar_asset}?oh=large512"}},
            )
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(200, json={"data": [{"id": page_id, "name": "Client Page", "category": "Shopping"}]})
        if path.endswith(f"/{adset_id}"):
            return httpx.Response(200, json={"id": adset_id, "name": "Set", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith(f"/{campaign_id}"):
            return httpx.Response(200, json={"id": campaign_id, "name": "Camp", "status": "ACTIVE", "effective_status": "ACTIVE"})
        if path.endswith("/act_444444444444444"):
            return httpx.Response(200, json={"id": "act_444444444444444", "account_id": "444444444444444", "name": "Albayan Business", "currency": "USD", "account_status": 1})
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    snapshot = real.get_ad_snapshot(ad_id)
    # Every media door is closed; the Page profile picture is shown as the
    # clearly-labelled substitute instead of an empty tile (user request).
    assert avatar_asset in snapshot["metaThumbnailUrl"]
    assert snapshot["metaThumbnailSource"] == "page_avatar"
    assert snapshot["metaPageName"] == "Client Page"


def test_discovery_rows_carry_real_page_names_for_instant_import(monkeypatch):
    page_id = "777777777777779"

    def handler(request):
        path = request.url.path
        if path.endswith("/act_444444444444444/ads"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "999999999999994",
                            "name": "Boosted post ad",
                            "status": "ACTIVE",
                            "effective_status": "ACTIVE",
                            "adset_id": "888888888888884",
                            "campaign_id": "777777777777774",
                            "created_time": "2026-07-28T00:30:00+0000",
                            "creative": {
                                "id": "666666666666664",
                                "effective_object_story_id": f"{page_id}_123456789012400",
                            },
                        }
                    ]
                },
            )
        if path.endswith("/act_444444444444444/promote_pages"):
            return httpx.Response(
                200,
                json={"data": [{"id": page_id, "name": "هنقر الهلالي 8", "category": "Restaurant"}]},
            )
        return httpx.Response(404, json={"error": {"code": 100}})

    real = _real_client(monkeypatch, handler)
    listed = real.list_ads("444444444444444")
    assert listed[0]["pageId"] == page_id
    assert listed[0]["pageName"] == "هنقر الهلالي 8"
    assert listed[0]["pageCategory"] == "Restaurant"
    pending = meta_ads._pending_meta_snapshot(
        listed[0], "444444444444444", meta_ads.MetaAdsError("pending_enrichment", "loading", retryable=True)
    )
    assert pending["metaPageName"] == "هنقر الهلالي 8"
    assert pending["metaPageCategory"] == "Restaurant"


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
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "secret-token-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "secret-app-value-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "444444444444444")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    for name in (
        "ALBAYAN_META_SYNC_BATCH_SIZE",
        "ALBAYAN_META_DISCOVERY_FAST_PAGES",
        "ALBAYAN_META_DISCOVERY_BASELINE_PAGES",
        "ALBAYAN_META_WORKER_SYNC_INTERVAL_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
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
    assert response.json()["syncBatchSize"] == 2
    assert response.json()["workerSyncIntervalSeconds"] == 20
    assert response.json()["providerState"]["state"] in {"ready", "paused"}
    assert response.json()["providerState"]["minimumRequestIntervalMs"] == 750
    assert response.json()["discoveryFastPages"] == 1
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
    assert len(data["editHistory"]) == 1
    changed_fields = [change["field"] for change in data["metaChangeHistory"][-1]["changes"]]
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


def _insert_customer(customer_id, creator_id, name="Completion Customer"):
    stamp = now_ms()
    data = {
        "id": customer_id,
        "name": name,
        "phones": ["0910000001"],
        "platform": "Facebook",
        "_created": stamp,
        "_lastModified": stamp,
        "_deleted": False,
    }
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('customers',:id,:data,false,:stamp,:creator,:stamp)"
            ),
            {"id": customer_id, "data": json_dumps(data), "stamp": stamp, "creator": creator_id},
        )
    return stamp


def test_completing_an_imported_draft_records_who_did_it(actors, configured_meta):
    """An imported ad is created by the automation, so name the real person.

    Without this the ads list can only ever say "Created by: System" and there
    is no way to see who chose the customer, payment and receipt.
    """
    customer_id = "meta_completion_customer"
    ad_id = "meta_completion_ad"
    _insert_customer(customer_id, actors["admin_id"])
    version = _insert_ad(
        ad_id,
        actors["admin_id"],
        customerId=customer_id,
        metaImportState="needs_completion",
        # A plain unpaid ad: the customer owes the money, so the ad is complete
        # without any receipt or funding attached yet.
        paymentStatus="not_paid",
        status="Active",
        amountUSD=10,
        amountLocal=97,
        exchangeRate=9.7,
        receiptId="",
        receiptAllocations=[],
        dueAllocations=[],
    )
    try:
        before, _ = _stored_ad(ad_id)
        assert "metaImportCompletedBy" not in before

        done = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": ad_id,
                "idempotencyKey": "meta-completion-stamp-1",
                "expectedLastModified": version,
                "data": {"notes": "customer and payment chosen"},
            },
            cookies=actors["employee"],
        )
        assert done.status_code == 200, done.text

        stored, _ = _stored_ad(ad_id)
        assert stored["metaImportState"] == "complete"
        assert stored["metaImportCompletedAt"]
        # The employee who did the work, not the admin who owns the row.
        assert stored["metaImportCompletedBy"] == actors["employee_id"]
        assert stored["metaImportCompletedByName"] == "Meta Employee"
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type IN ('ads','customers') AND id IN (:a,:c)"),
                {"a": ad_id, "c": customer_id},
            )


def test_a_browser_cannot_claim_it_completed_an_imported_draft(actors, configured_meta):
    """Whoever can write this field can credit anyone with someone else's work."""
    ad_id = "meta_completion_forgery"
    version = _insert_ad(ad_id, actors["admin_id"], metaImportState="needs_completion")
    try:
        for field in ("metaImportCompletedBy", "metaImportCompletedByName"):
            forged = client.post(
                "/api/ads/mutate",
                json={
                    "action": "update",
                    "adId": ad_id,
                    "idempotencyKey": f"meta-completion-forge-{field}",
                    "expectedLastModified": version,
                    "data": {field: "somebody-else"},
                },
                cookies=actors["admin"],
            )
            assert forged.status_code == 403, f"{field} was accepted from a browser"
        stored, unchanged = _stored_ad(ad_id)
        assert "metaImportCompletedBy" not in stored
        assert unchanged == version
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='ads' AND id=:id"), {"id": ad_id})


def test_auto_import_baselines_then_creates_one_neutral_draft_and_reuses_page(
    actors, configured_meta
):
    _clear_auto_import_rows()
    page_id = "meta_test_existing_page"
    _insert_page(page_id, actors["admin_id"], "  Existing   Meta Page  ")
    try:
        baseline = meta_ads.discover_meta_ads(force=True)
        assert baseline["imported"] == []
        assert baseline["state"]["baselineComplete"] is True
        assert configured_meta.list_calls[-1][1] == 25

        new_meta_id = "888888888888888"
        configured_meta.rows.insert(
            0,
            {
                "id": new_meta_id,
                "name": "Just created",
                "effectiveStatus": "ACTIVE",
                "campaignName": "Automatic campaign",
                "creativeId": "666666666666666",
                "thumbnailUrl": "https://lookaside.fbsbx.com/fast-preview.jpg",
                "pageId": "777777777777777",
                "dailyBudgetMinor": 2000,
                "totalBudgetMinor": 10000,
                "totalBudgetKind": "estimated_daily",
                "startTime": "2026-07-25T00:00:00Z",
                "endTime": "2026-07-30T00:00:00Z",
                "durationDays": 5,
                "createdTime": "2026-07-27T04:00:00Z",
            },
        )
        configured_meta.snapshots[new_meta_id] = _snapshot(new_meta_id)
        discovered = meta_ads.discover_meta_ads(force=True)
        assert len(discovered["imported"]) == 1
        imported_id = discovered["imported"][0]["id"]
        stored, _ = _stored_ad(imported_id)
        assert stored["metaAdId"] == new_meta_id
        assert stored["amountUSD"] == 0
        assert stored["amountLocal"] == 0
        assert stored["paymentStatus"] == "pending_setup"
        assert stored["customerId"] == ""
        assert stored["metaImportState"] == "needs_completion"
        assert stored["metaThumbnailUrl"].startswith("https://")
        assert stored["metaMediaVersion"] == 0
        assert stored["metaDurationDays"] == 5
        assert stored["metaTotalBudgetMinor"] == 10000
        # A draft that carries budget minors must say which currency they are
        # in, otherwise the browser cannot tell $100 from EUR 100.
        assert stored["metaCurrency"] == "USD"
        assert stored["pageId"] == ""
        assert configured_meta.snapshot_calls == []
        assert configured_meta.list_calls[-1][1] == 1
        assert stored["editHistory"] == []
        assert stored["metaChangeCount"] == 1
        assert stored["metaChangeHistory"][0]["source"] == "meta_import"

        # The paced queue enriches the draft next and safely reuses the
        # manually-created page once Meta returns its real name.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
                {"id": imported_id},
            ).mappings().first()
            due_data = json_loads(row["data_json"])
            due_data["metaNextSyncAt"] = 0
            conn.execute(
                text("UPDATE entities SET data_json=:data WHERE type='ads' AND id=:id"),
                {"data": json_dumps(due_data), "id": imported_id},
            )
        assert len(meta_ads.sync_due_meta_ads(limit=1)) == 1
        stored, _ = _stored_ad(imported_id)
        assert stored["pageId"] == page_id
        assert stored["metaMediaVersion"] == meta_ads._META_MEDIA_VERSION
        assert configured_meta.snapshot_calls == [new_meta_id]

        repeated = meta_ads.discover_meta_ads(force=True)
        assert repeated["imported"] == []
        with db_conn() as conn:
            linked_ads = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND deleted=false")
            ).mappings().all()
            pages = conn.execute(
                text("SELECT id,data_json FROM entities WHERE type='pages' AND deleted=false")
            ).mappings().all()
        assert sum(
            1
            for row in linked_ads
            if (json_loads(row["data_json"]) or {}).get("metaAdId") == new_meta_id
        ) == 1
        matching_pages = [
            row
            for row in pages
            if (json_loads(row["data_json"]) or {}).get("metaPageId")
            == "777777777777777"
        ]
        assert len(matching_pages) == 1
        assert matching_pages[0]["id"] == page_id
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='pages' AND id=:id"),
                {"id": page_id},
            )
        _clear_auto_import_rows()


def _discovery_row(meta_id: str, created: str) -> dict:
    return {
        "id": meta_id,
        "name": f"Draft {meta_id}",
        "effectiveStatus": "ACTIVE",
        "campaignName": "Automatic campaign",
        "pageId": "777777777777777",
        "dailyBudgetMinor": 1000,
        "totalBudgetMinor": 3000,
        "totalBudgetKind": "estimated_daily",
        "startTime": "2026-07-25T00:00:00Z",
        "endTime": "2026-07-28T00:00:00Z",
        "durationDays": 3,
        "createdTime": created,
    }


def test_imported_drafts_carry_the_ad_accounts_real_currency(actors, configured_meta):
    """A draft ships Meta's budget minors, so it must ship the currency too.

    Without it the browser could not tell EUR 30 from $30 and would lock the
    foreign amount into the read-only Ad Budget (USD) field as customer debt.
    """
    _clear_auto_import_rows()
    try:
        assert meta_ads.discover_meta_ads(force=True)["imported"] == []

        configured_meta.account_currency = "eur"
        configured_meta.rows.insert(0, _discovery_row("888888888888890", "2026-07-27T04:00:00Z"))
        configured_meta.rows.insert(0, _discovery_row("888888888888891", "2026-07-27T05:00:00Z"))
        configured_meta.account_calls.clear()

        discovered = meta_ads.discover_meta_ads(force=True)
        assert len(discovered["imported"]) == 2
        for entry in discovered["imported"]:
            stored, _ = _stored_ad(entry["id"])
            assert stored["metaCurrency"] == "EUR"
            assert stored["metaTotalBudgetMinor"] == 3000
        # Cached per pass: two new ads on one account must not cost two reads.
        assert configured_meta.account_calls == ["444444444444444"]
    finally:
        configured_meta.account_currency = "USD"
        configured_meta.account_error = None
        _clear_auto_import_rows()


def test_unreadable_account_currency_never_sinks_an_import(actors, configured_meta):
    """A throttled account read must leave the currency blank, not guess USD."""
    _clear_auto_import_rows()
    try:
        assert meta_ads.discover_meta_ads(force=True)["imported"] == []

        configured_meta.account_error = meta_ads.MetaAdsError(
            "rate_limited", "Meta is limiting requests.", retryable=True
        )
        configured_meta.rows.insert(0, _discovery_row("888888888888892", "2026-07-27T06:00:00Z"))

        discovered = meta_ads.discover_meta_ads(force=True)
        assert len(discovered["imported"]) == 1
        stored, _ = _stored_ad(discovered["imported"][0]["id"])
        # Imported anyway, just without a currency — the budget field stays
        # manual until a later pass learns it.
        assert stored["metaAdId"] == "888888888888892"
        assert stored["metaCurrency"] == ""
        assert stored["metaTotalBudgetMinor"] == 3000
    finally:
        configured_meta.account_error = None
        _clear_auto_import_rows()


def test_auto_import_creates_retryable_draft_while_meta_is_still_preparing(
    actors, configured_meta, monkeypatch
):
    _clear_auto_import_rows()
    try:
        baseline = meta_ads.discover_meta_ads(force=True)
        assert baseline["imported"] == []

        pending_meta_id = "888888888888889"
        configured_meta.rows.insert(
            0,
            {
                "id": pending_meta_id,
                "name": "Still in Meta review",
                "status": "ACTIVE",
                "effectiveStatus": "PENDING_REVIEW",
                "adSetId": "111111111111112",
                "adSetName": "Review ad set",
                "campaignId": "222222222222223",
                "campaignName": "Review campaign",
                "createdTime": "2026-07-27T14:44:00Z",
            },
        )
        original_snapshot = configured_meta.get_ad_snapshot

        def pending_snapshot(meta_ad_id):
            if str(meta_ad_id) == pending_meta_id:
                raise meta_ads.MetaAdsError(
                    "not_ready", "Meta has not finished preparing this ad", retryable=True
                )
            return original_snapshot(meta_ad_id)

        monkeypatch.setattr(configured_meta, "get_ad_snapshot", pending_snapshot)
        discovered = meta_ads.discover_meta_ads(force=True)
        assert len(discovered["imported"]) == 1
        stored, _ = _stored_ad(discovered["imported"][0]["id"])
        assert stored["metaAdId"] == pending_meta_id
        assert stored["metaEffectiveStatus"] == "PENDING_REVIEW"
        assert stored["paymentStatus"] == "pending_setup"
        assert stored["amountUSD"] == 0
        assert stored["metaSyncErrorCode"] == "pending_enrichment"
        assert "already in Albayan" in stored["metaSyncError"]
        assert stored["metaNextSyncAt"] > now_ms()
        assert pending_meta_id not in configured_meta.snapshot_calls

        repeated = meta_ads.discover_meta_ads(force=True)
        assert repeated["imported"] == []
    finally:
        _clear_auto_import_rows()


def test_old_wrong_thumbnail_is_prioritized_for_one_safe_repair(actors):
    ad_id = "meta_test_media_repair"
    _insert_ad(
        ad_id,
        actors["admin_id"],
        metaAdId="888888888888887",
        metaMediaVersion=0,
        metaThumbnailUrl="https://lookaside.fbsbx.com/page-logo.jpg",
        metaSyncFailureCount=0,
        metaNextSyncAt=now_ms() + 900_000,
    )
    try:
        assert ad_id in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}

        # A failed repair under THIS resolver version stamps the row and hands
        # it back to the normal retry clock: Meta is never hammered.
        failed = meta_ads.record_meta_sync_failure(
            ad_id,
            meta_ads.MetaAdsError("request_failed", "Meta could not return the requested ad information."),
            expected_last_modified=None,
        )
        assert failed is not None
        stored, _ = _stored_ad(ad_id)
        assert stored["metaMediaRepairVersion"] == meta_ads._META_MEDIA_VERSION
        assert stored["metaSyncFailureCount"] == 1
        assert ad_id not in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}

        # But a row that failed under an OLDER resolver (no repair stamp for
        # the current version) gets exactly ONE fresh prioritized attempt —
        # otherwise a deployment that fixes the resolver would leave photos
        # waiting out a multi-hour backoff from the previous version.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            ).mappings().first()
            data = json_loads(row["data_json"])
            data.pop("metaMediaRepairVersion", None)
            data["metaNextSyncAt"] = now_ms() + 900_000
            conn.execute(
                text("UPDATE entities SET data_json=:data WHERE type='ads' AND id=:id"),
                {"data": json_dumps(data), "id": ad_id},
            )
        assert ad_id in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_due_and_existing_id_scans_never_decode_large_entity_blobs(actors, monkeypatch):
    """The every-minute scheduler must not materialize photos or history."""
    ad_id = "meta_test_projected_due_scan"
    meta_id = "888888888888886"
    _insert_ad(
        ad_id,
        actors["admin_id"],
        metaAdId=meta_id,
        metaNextSyncAt=0,
        metaMediaVersion=meta_ads._META_MEDIA_VERSION,
        metaMediaRepairVersion=meta_ads._META_MEDIA_VERSION,
        metaSyncFailureCount=0,
        metaAdAccountId="1613934299308344",
        metaAdSetId="222222222222222",
        metaCampaignId="333333333333333",
        metaCreativeId="777777777777770",
        metaThumbnailData="data:image/png;base64," + ("A" * 250_000),
        metaChangeHistory=[{"details": "H" * 20_000} for _ in range(8)],
    )
    try:
        projected_scan = meta_ads._scalar_entity_rows
        scan_limits = []

        def _record_projected_scan(*args, **kwargs):
            scan_limits.append(kwargs.get("limit"))
            return projected_scan(*args, **kwargs)

        monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
        monkeypatch.setattr(meta_ads, "_scalar_entity_rows", _record_projected_scan)

        def _forbid_blob_decode(*_args, **_kwargs):
            raise AssertionError("recurring Meta scan decoded a full entity blob")

        monkeypatch.setattr(meta_ads, "json_loads", _forbid_blob_decode)
        assert meta_id in meta_ads._existing_meta_ad_ids()
        due = {row["adId"]: row for row in meta_ads._due_meta_ads(limit=10_000)}
        assert due[ad_id]["metaAdId"] == meta_id
        assert due[ad_id]["metaAdAccountId"] == "1613934299308344"
        assert due[ad_id]["needsMediaRepair"] is False
        assert scan_limits == [1, 10_000]
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_resync_never_erases_resolved_photo_or_page_name(actors):
    ad_id = "meta_test_media_preserve"
    meta_id = "777000111222333"
    _insert_ad(ad_id, actors["admin_id"])

    def _apply(snapshot):
        meta_ads.apply_meta_snapshot(
            ad_id,
            snapshot,
            actor_id=None,
            actor_name="Meta automatic sync",
            expected_last_modified=None,
            operation_id=None,
            action="automatic_sync",
        )

    first = _snapshot(meta_id)
    first["metaThumbnailUrl"] = "https://lookaside.fbsbx.com/real-ad-photo.jpg"
    first["metaThumbnailSource"] = "story"
    _apply(first)

    # A later pass that cannot resolve media or the page identity (transient
    # Meta denial) must not erase what an earlier pass already learned.
    degraded = _snapshot(meta_id)
    degraded["metaThumbnailUrl"] = ""
    degraded["metaThumbnailSource"] = ""
    degraded["metaPageId"] = ""
    degraded["metaPageName"] = ""
    degraded["metaPageCategory"] = ""
    degraded["metaPagePictureUrl"] = ""
    _apply(degraded)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/real-ad-photo.jpg"
    assert stored["metaThumbnailSource"] == "story"
    assert stored["metaPageId"] == "777777777777777"
    assert stored["metaPageName"] == "Existing Meta Page"
    assert "111111111_222222222333333_n.jpg" in stored["metaPagePictureUrl"]

    # A degraded pass that could not read the ad set/campaign must not wipe
    # the budget picture either; the remaining money is recomputed from the
    # preserved total and the still-updating spend.
    no_budget = _snapshot(meta_id, spend=4.0)
    for key in ("metaDailyBudgetMinor", "metaLifetimeBudgetMinor", "metaTotalBudgetMinor",
                "metaBudgetRemainingMinor", "metaTotalRemainingBudgetMinor", "metaDurationDays"):
        no_budget[key] = 0
    for key in ("metaTotalBudgetKind", "metaBudgetSource", "metaAdSetName",
                "metaCampaignName", "metaStartTime", "metaEndTime"):
        no_budget[key] = ""
    _apply(no_budget)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaDailyBudgetMinor"] == 2000
    assert stored["metaTotalBudgetMinor"] == 10000
    assert stored["metaAdSetName"] == "Tripoli Messages"
    assert stored["metaCampaignName"] == "Summer Campaign"
    assert stored["metaStartTime"] == "2026-07-25T00:00:00Z"
    assert stored["metaSpendMinor"] == 400
    assert stored["metaTotalRemainingBudgetMinor"] == 10000 - 400

    # The user prefers SOME picture over an empty tile: even a fallback
    # picture survives a later pass that resolved nothing, while any better
    # non-empty source still replaces it.
    weak = _snapshot(meta_id)
    weak["metaThumbnailUrl"] = "https://lookaside.fbsbx.com/page-logo.jpg"
    weak["metaThumbnailSource"] = "page_avatar"
    _apply(weak)
    cleared = _snapshot(meta_id)
    cleared["metaThumbnailUrl"] = ""
    cleared["metaThumbnailSource"] = ""
    _apply(cleared)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/page-logo.jpg"
    assert stored["metaThumbnailSource"] == "page_avatar"

    better = _snapshot(meta_id)
    better["metaThumbnailUrl"] = "https://lookaside.fbsbx.com/real-photo-late.jpg"
    better["metaThumbnailSource"] = "preview"
    _apply(better)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/real-photo-late.jpg"
    assert stored["metaThumbnailSource"] == "preview"


def test_import_page_stores_picture_and_ignores_signature_rotation():
    page_meta_id = "777777777777900"
    base = "https://scontent.xx.fbcdn.net/v/t39.30808-1/999999999_888888888777777_n.jpg"
    snapshot = {
        "metaPageId": page_meta_id,
        "metaPageName": "Avatar Churn Test Page",
        "metaPageCategory": "Clothing store",
        "metaPagePictureUrl": f"{base}?oh=aaa&oe=bbb",
    }
    created_page_id = ""

    def _stored_page():
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json,last_modified FROM entities WHERE type='pages' AND id=:id"),
                {"id": created_page_id},
            ).mappings().first()
        assert row
        return json_loads(row["data_json"]), int(row["last_modified"])

    try:
        with db_conn() as conn:
            created_page_id, _, created = meta_ads._ensure_import_page(conn, snapshot)
        assert created is True
        stored, version = _stored_page()
        assert stored["metaPagePictureUrl"] == f"{base}?oh=aaa&oe=bbb"

        # The same photo behind rotated signing parameters must NOT rewrite
        # the page: the routine 15-minute ad sync would otherwise bump every
        # page's version (re-downloading it to every client) each pass.
        rotated = dict(snapshot, metaPagePictureUrl=f"{base}?oh=ccc&oe=ddd")
        with db_conn() as conn:
            meta_ads._ensure_import_page(conn, rotated)
        stored, unchanged_version = _stored_page()
        assert stored["metaPagePictureUrl"] == f"{base}?oh=aaa&oe=bbb"
        assert unchanged_version == version

        # A genuinely new profile picture (different CDN asset) replaces it.
        new_asset = (
            "https://scontent.xx.fbcdn.net/v/t39.30808-1/"
            "121212121_343434343565656_n.jpg?oh=eee"
        )
        with db_conn() as conn:
            meta_ads._ensure_import_page(
                conn, dict(snapshot, metaPagePictureUrl=new_asset)
            )
        stored, bumped_version = _stored_page()
        assert stored["metaPagePictureUrl"] == new_asset
        assert bumped_version > version
    finally:
        if created_page_id:
            with db_conn() as conn:
                conn.execute(
                    text("DELETE FROM entities WHERE type='pages' AND id=:id"),
                    {"id": created_page_id},
                )


def test_degraded_resync_never_writes_stale_page_picture_back(actors):
    """A pass whose avatar read failed must not regress the page's picture.

    Ads of one page sync on independent schedules, so an ad row can hold an
    OLDER page picture than the page entity (another ad already stored the
    new one). The merge keeps the old URL on the AD row, but only a picture
    freshly resolved by the current pass may be written to the shared page.
    """
    ad_id = "meta_test_stale_avatar"
    meta_id = "777000111222555"
    new_picture = (
        "https://scontent.xx.fbcdn.net/v/t39.30808-1/"
        "555555555_666666666777777_n.jpg?oh=new&oe=new"
    )
    _insert_ad(ad_id, actors["admin_id"], metaImportSource="meta_ads")
    try:
        def _apply(snapshot):
            meta_ads.apply_meta_snapshot(
                ad_id,
                snapshot,
                actor_id=None,
                actor_name="Meta automatic sync",
                expected_last_modified=None,
                operation_id=None,
                action="automatic_sync",
            )

        # Pass 1: this ad learns the (older) default picture; the page too.
        _apply(_snapshot(meta_id))
        stored, _ = _stored_ad(ad_id)
        page_id = stored["pageId"]
        assert page_id

        # Another ad of the same page later stores a NEWER profile picture.
        with db_conn() as conn:
            meta_ads._ensure_import_page(
                conn,
                {
                    "metaPageId": "777777777777777",
                    "metaPageName": "Existing Meta Page",
                    "metaPageCategory": "Business service",
                    "metaPagePictureUrl": new_picture,
                },
            )

        # Pass 2 for THIS ad: the avatar read failed transiently (empty), so
        # the merge restores the ad's own older URL. The ad keeps it...
        degraded = _snapshot(meta_id)
        degraded["metaPagePictureUrl"] = ""
        _apply(degraded)
        stored, _ = _stored_ad(ad_id)
        assert "111111111_222222222333333_n.jpg" in stored["metaPagePictureUrl"]

        # ...but the shared page must KEEP the newer photo.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='pages' AND id=:id"),
                {"id": page_id},
            ).mappings().first()
        assert row
        assert json_loads(row["data_json"])["metaPagePictureUrl"] == new_picture
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_failed_results_read_never_zeroes_stored_spend(actors):
    """A pass that could not READ the results must not store zeros.

    The ad node stays readable while /insights is throttled or refused, so
    the snapshot carries spend 0 with NO error code — a silent success that
    used to overwrite real money. Spend feeds reconciliation and profit, so
    the last known figures must survive until a healthy pass replaces them.
    """
    ad_id = "meta_test_insights_zeroing"
    meta_id = "777000111222999"
    _insert_ad(ad_id, actors["admin_id"], metaImportSource="meta_ads")
    try:
        def _apply(snapshot):
            meta_ads.apply_meta_snapshot(
                ad_id,
                snapshot,
                actor_id=None,
                actor_name="Meta automatic sync",
                expected_last_modified=None,
                operation_id=None,
                action="automatic_sync",
            )

        healthy = _snapshot(meta_id)
        healthy.update({
            "metaSpend": 30.0,
            "metaSpendMinor": 3000,
            "metaReach": 1200,
            "metaImpressions": 4500,
            "metaClicks": 90,
            "metaPrimaryResultType": "messaging_conversation_started_7d",
            "metaPrimaryResultValue": 12.0,
            "metaActions": [{"type": "link_click", "value": 90.0}],
        })
        _apply(healthy)
        stored, _ = _stored_ad(ad_id)
        assert stored["metaSpendMinor"] == 3000

        # Same Meta ad, results unreadable: zeros carrying the marker.
        degraded = _snapshot(meta_id)
        degraded.update({
            "metaSpend": 0.0, "metaSpendMinor": 0, "metaReach": 0,
            "metaImpressions": 0, "metaClicks": 0, "metaActions": [],
            "metaPrimaryResultType": "", "metaPrimaryResultValue": 0.0,
            "_insightsUnavailable": True,
        })
        _apply(degraded)
        stored, _ = _stored_ad(ad_id)
        assert stored["metaSpendMinor"] == 3000, "a failed results read wiped real spend"
        assert stored["metaSpend"] == 30.0
        assert stored["metaReach"] == 1200
        assert stored["metaImpressions"] == 4500
        assert stored["metaClicks"] == 90
        assert stored["metaPrimaryResultValue"] == 12.0
        assert stored["metaActions"] == [{"type": "link_click", "value": 90.0}]
        # The internal marker must never reach storage.
        assert "_insightsUnavailable" not in stored

        # A genuine zero from a HEALTHY pass still writes through.
        real_zero = _snapshot(meta_id)
        real_zero.update({
            "metaSpend": 0.0, "metaSpendMinor": 0, "metaReach": 0,
            "metaImpressions": 0, "metaClicks": 0, "metaActions": [],
        })
        _apply(real_zero)
        stored, _ = _stored_ad(ad_id)
        assert stored["metaSpendMinor"] == 0, "a healthy zero must still be stored"
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_meta_images_are_archived_into_our_own_rows(actors, monkeypatch):
    """fbcdn links expire; the stored copy is what survives.

    Also pins the failure behaviour: a URL that cannot be fetched is stamped
    as attempted so it is not retried on every pass forever, and the row keeps
    the link it already had.
    """
    ad_id = "meta_test_media_archive"
    meta_id = "777000111333444"
    photo = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
    )
    _insert_ad(ad_id, actors["admin_id"], metaImportSource="meta_ads")
    try:
        meta_ads.apply_meta_snapshot(
            ad_id, _snapshot(meta_id), actor_id=None,
            actor_name="Meta automatic sync", expected_last_modified=None,
            operation_id=None, action="automatic_sync",
        )
        stored, _ = _stored_ad(ad_id)
        assert stored.get("metaThumbnailUrl"), "fixture needs a thumbnail URL"

        monkeypatch.setattr(meta_ads, "_archive_meta_image", lambda url: photo)
        assert meta_ads.archive_meta_media(limit=10) >= 1
        stored, _ = _stored_ad(ad_id)
        assert stored["metaThumbnailData"] == photo
        assert stored["metaThumbnailArchivedFrom"] == stored["metaThumbnailUrl"]

        # A second pass is a no-op while the URL is unchanged (no re-download).
        calls = {"n": 0}

        def _counting(url):
            calls["n"] += 1
            return photo

        monkeypatch.setattr(meta_ads, "_archive_meta_image", _counting)
        meta_ads.archive_meta_media(limit=10)
        assert calls["n"] == 0, "unchanged URL was re-downloaded"

        # A download that fails leaves the previous copy and stops retrying.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT type,id,data_json,deleted,created_at,created_by,last_modified "
                     "FROM entities WHERE type='ads' AND id=:i"),
                {"i": ad_id},
            ).mappings().first()
            data = json_loads(row["data_json"])
            data["metaThumbnailUrl"] = "https://scontent.xx.fbcdn.net/v/t39/changed_9.jpg"
            meta_ads._write_entity_data(conn, row, data)
        monkeypatch.setattr(meta_ads, "_archive_meta_image", lambda url: "")
        meta_ads.archive_meta_media(limit=10)
        stored, _ = _stored_ad(ad_id)
        assert stored["metaThumbnailData"] == photo, "a failed fetch destroyed the archived copy"
        assert stored["metaThumbnailArchivedFrom"] == "https://scontent.xx.fbcdn.net/v/t39/changed_9.jpg"
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_media_archive_candidate_scan_projects_url_without_decoding_blob(actors, monkeypatch):
    ad_id = "meta_test_projected_archive_scan"
    media_url = "https://scontent.xx.fbcdn.net/v/t39/projected.jpg"
    _insert_ad(
        ad_id,
        actors["admin_id"],
        metaAdId="777000111333445",
        metaThumbnailUrl=media_url,
        metaThumbnailData="data:image/png;base64," + ("A" * 250_000),
        metaChangeHistory=[{"details": "H" * 20_000} for _ in range(8)],
    )
    try:
        # Make this deterministic even if another archive test left an
        # eligible row in the shared in-memory database.
        with db_conn() as conn:
            conn.execute(
                text("UPDATE entities SET created_at=1,last_modified=1 "
                     "WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )
        stored = []
        monkeypatch.setattr(
            meta_ads,
            "_archive_meta_image",
            lambda _url: "data:image/png;base64,cHJvamVjdGVk",
        )
        monkeypatch.setattr(
            meta_ads,
            "_store_archived_image",
            lambda *args: stored.append(args),
        )

        def _forbid_blob_decode(*_args, **_kwargs):
            raise AssertionError("media candidate scan decoded a full entity blob")

        monkeypatch.setattr(meta_ads, "json_loads", _forbid_blob_decode)
        assert meta_ads.archive_meta_media(limit=1) == 1
        assert stored and stored[0][0:3] == ("ads", ad_id, media_url)
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            )


def test_page_meta_name_is_never_blanked_by_another_ads_sync(actors):
    """An ad carrying the page id but no page details must not empty the
    stored page name/category — that text is also what the placeholder-name
    repair reads later."""
    with db_conn() as conn:
        page = meta_ads._ensure_import_page(
            conn,
            {
                "metaPageId": "777777777000111",
                "metaPageName": "Real Page Name",
                "metaPageCategory": "Shopping",
            },
        )
    page_id = page[0]
    assert page_id
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn,
            {"metaPageId": "777777777000111", "metaPageName": "", "metaPageCategory": ""},
        )
        row = conn.execute(
            text("SELECT data_json FROM entities WHERE type='pages' AND id=:id"),
            {"id": page_id},
        ).mappings().first()
    stored = json_loads(row["data_json"])
    assert stored["metaPageName"] == "Real Page Name"
    assert stored["metaPageCategory"] == "Shopping"
    assert stored["name"] == "Real Page Name"


def test_enrichment_respects_manual_page_choice_and_avoids_noop_page_writes(actors):
    _clear_auto_import_rows()
    ad_id = "meta_test_page_stick"
    meta_id = "777000111222444"
    _insert_ad(ad_id, actors["admin_id"], metaImportSource="meta_ads")
    try:
        def _apply():
            meta_ads.apply_meta_snapshot(
                ad_id,
                _snapshot(meta_id),
                actor_id=None,
                actor_name="Meta automatic sync",
                expected_last_modified=None,
                operation_id=None,
                action="automatic_sync",
            )

        _apply()
        stored, _ = _stored_ad(ad_id)
        page_id = stored["pageId"]
        assert page_id

        def _page_version():
            with db_conn() as conn:
                row = conn.execute(
                    text("SELECT last_modified FROM entities WHERE type='pages' AND id=:id"),
                    {"id": page_id},
                ).mappings().first()
            assert row
            return int(row["last_modified"])

        before = _page_version()
        _apply()
        # A routine re-sync with identical Meta values must not rewrite the
        # page entity (no client churn, no spurious edit conflicts).
        assert _page_version() == before
        stored, _ = _stored_ad(ad_id)
        assert stored["pageId"] == page_id

        # An admin manually moves the imported ad to another Albayan page:
        # the next automatic sync must not snap it back.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            ).mappings().first()
            data = json_loads(row["data_json"])
            data["pageId"] = "manual_page_choice"
            data["pageName"] = "Manual page"
            conn.execute(
                text("UPDATE entities SET data_json=:data WHERE type='ads' AND id=:id"),
                {"data": json_dumps(data), "id": ad_id},
            )
        _apply()
        stored, _ = _stored_ad(ad_id)
        assert stored["pageId"] == "manual_page_choice"
        assert stored["pageName"] == "Manual page"
    finally:
        _clear_auto_import_rows()


def test_partner_active_pages_metric_is_admin_only_cached_and_lists_pages(
    actors, configured_meta
):
    _clear_auto_import_rows()
    ad_a = "meta_test_partner_a"
    ad_b = "meta_test_partner_b"
    _insert_ad(
        ad_a,
        actors["admin_id"],
        metaAdId="900000000000001",
        metaPageId="777000000000001",
        metaPageName="Qualified Page",
    )
    _insert_ad(
        ad_b,
        actors["admin_id"],
        metaAdId="900000000000002",
        metaPageId="777000000000002",
        metaPageName="Small Page",
    )
    configured_meta.spend_rows = [
        {"adId": "900000000000001", "spendMinor": 9_000},
        {"adId": "900000000000001", "spendMinor": 6_000},
        {"adId": "900000000000002", "spendMinor": 2_500},
        # Spend from ads older than Albayan: one resolvable, one not.
        {"adId": "900000000000003", "spendMinor": 30_000},
        {"adId": "900000000000004", "spendMinor": 1_000},
    ]
    configured_meta.page_identities = {
        "900000000000003": {"pageId": "777000000000003"}
    }
    try:
        denied = client.get("/api/meta-ads/partner-pages", cookies=actors["employee"])
        assert denied.status_code == 403

        response = client.get("/api/meta-ads/partner-pages", cookies=actors["admin"])
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["thresholdMinor"] == 10_000
        assert body["targetCount"] == 500
        assert body["windowDays"] == 90
        assert body["qualifiedCount"] == 2
        by_id = {row["pageId"]: row for row in body["pages"]}
        assert by_id["777000000000001"]["qualified"] is True
        assert by_id["777000000000001"]["spendMinor"] == 15_000
        assert by_id["777000000000001"]["pageName"] == "Qualified Page"
        assert by_id["777000000000002"]["qualified"] is False
        assert by_id["777000000000003"]["qualified"] is True
        assert body["unmatchedAdCount"] == 1
        assert "secret-token" not in response.text
        first_calls = len(configured_meta.spend_calls)
        assert first_calls == 1

        # Cached: a second read must not call Meta again.
        cached = client.get("/api/meta-ads/partner-pages", cookies=actors["admin"])
        assert cached.status_code == 200
        assert len(configured_meta.spend_calls) == first_calls

        # Manual refresh is a same-origin POST. It recomputes, and both the
        # page mapping learned for the pre-Albayan ad AND the definitive
        # "no page found" miss are remembered instead of asking Meta again.
        refreshed = client.post(
            "/api/meta-ads/partner-pages/refresh", json={}, cookies=actors["admin"]
        )
        assert refreshed.status_code == 200, refreshed.text
        assert len(configured_meta.spend_calls) == first_calls + 1
        assert configured_meta.page_identity_calls.count("900000000000003") == 1
        assert configured_meta.page_identity_calls.count("900000000000004") == 1
        assert refreshed.json()["qualifiedCount"] == 2

        # A scan that Meta rate-limits must NEVER wipe the last good numbers.
        configured_meta.spend_error = meta_ads.MetaAdsError(
            "rate_limited", "Meta is temporarily limiting synchronization.", retryable=True
        )
        try:
            limited = meta_ads.get_meta_partner_page_stats(refresh=True)
        finally:
            configured_meta.spend_error = None
        assert limited["qualifiedCount"] == 2
        assert len(limited["pages"]) >= 3
        assert limited["accountErrors"]
        # And the stored state still serves the good numbers afterwards.
        after = client.get("/api/meta-ads/partner-pages", cookies=actors["admin"])
        assert after.status_code == 200
        assert after.json()["qualifiedCount"] == 2
    finally:
        _clear_auto_import_rows()
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE type='ads' AND id IN (:a,:b)"),
                {"a": ad_a, "b": ad_b},
            )


def test_meta_page_identity_cannot_be_forged_through_ordinary_routes(
    actors, configured_meta
):
    response = client.post(
        "/api/collections/pages",
        json={
            "id": "meta_test_forged_page",
            "data": {"name": "Fake", "metaPageId": "777777777777777"},
        },
        cookies=actors["admin"],
    )
    assert response.status_code == 403


def test_webhook_rejects_unsigned_payload_and_accepts_valid_signature(
    actors, configured_meta
):
    raw = b'{"object":"ad_account","entry":[]}'
    denied = client.post(
        "/api/meta-ads/webhook",
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    assert denied.status_code == 403
    secret = "secret-app-value-must-never-leak"
    signature = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    accepted = client.post(
        "/api/meta-ads/webhook",
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": signature,
        },
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json() == {"received": True}


# ---------------------------------------------------------------------------
# Placeholder page-name backfill (owner request 2026-08-01): pages created as
# "Facebook Page <id>" must receive their real Facebook name from ANY source
# the read-only token can reach, without ever touching a manual rename.
# ---------------------------------------------------------------------------


def _stored_page_by_meta_id(meta_page_id):
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id,data_json,last_modified FROM entities WHERE type='pages' AND deleted=false")
        ).mappings().all()
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        if str(data.get("metaPageId") or "") == str(meta_page_id):
            return data, int(row["last_modified"])
    return None, 0


def test_page_name_backfill_uses_locally_known_name(actors, configured_meta, monkeypatch):
    # Placeholder page + a synced ad that already learned the real name:
    # the backfill must rename the page WITHOUT any Meta call.
    with db_conn() as conn:
        page_id, _, created = meta_ads._ensure_import_page(
            conn, {"metaPageId": "556600000000001", "metaPageName": ""}
        )
    assert created
    stored, _ = _stored_page_by_meta_id("556600000000001")
    assert stored["name"] == "Facebook Page 556600000000001"

    ad_id = new_id("ad")
    with db_conn() as conn:
        meta_ads._insert_internal_entity(
            conn,
            "ads",
            ad_id,
            {
                "recordType": "ad",
                "customerId": "",
                "metaPageId": "556600000000001",
                "metaPageName": "متجر الاختبار الحقيقي",
                "metaPageCategory": "Shopping mall",
                "metaImportSource": "meta_ads",
            },
        )

    # Remote sources must not be needed: poison them to prove locality.
    monkeypatch.setattr(
        meta_ads, "get_meta_ads_client", lambda: (_ for _ in ()).throw(AssertionError("remote used"))
    )
    renamed = meta_ads.backfill_placeholder_page_names()
    assert renamed >= 1
    healed, _ = _stored_page_by_meta_id("556600000000001")
    assert healed["name"] == "متجر الاختبار الحقيقي"
    assert healed["metaPageName"] == "متجر الاختبار الحقيقي"
    assert healed["category"] == "Shopping mall"
    # Idempotent: nothing left to rename.
    assert meta_ads.backfill_placeholder_page_names() == 0


def test_page_name_backfill_uses_direct_page_read(actors, configured_meta, monkeypatch):
    # No local source knows the name: the backfill must fall back to the
    # bounded direct GET /{page-id} read.
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn, {"metaPageId": "556600000000002", "metaPageName": ""}
        )

    class _NameClient:
        def _get_account_page_identity(self, account_id, page_id):
            return {}

        def _get(self, path, params):
            assert str(path) == "556600000000002"
            assert "name" in str(params.get("fields"))
            return {"id": "556600000000002", "name": "Real Direct Name", "category": "Retail"}

    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: _NameClient())
    renamed = meta_ads.backfill_placeholder_page_names()
    assert renamed >= 1
    healed, _ = _stored_page_by_meta_id("556600000000002")
    assert healed["name"] == "Real Direct Name"
    assert healed["category"] == "Retail"


def test_page_name_backfill_never_touches_manual_names(actors, configured_meta, monkeypatch):
    # A page the owner renamed by hand is not a placeholder: the backfill
    # must not select it, and a same-named manual page must not be merged.
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn,
            {"metaPageId": "556600000000003", "metaPageName": "اسم يدوي مخصص"},
        )
    before, version_before = _stored_page_by_meta_id("556600000000003")
    assert before["name"] == "اسم يدوي مخصص"

    monkeypatch.setattr(
        meta_ads, "get_meta_ads_client", lambda: (_ for _ in ()).throw(AssertionError("remote used"))
    )
    assert meta_ads.backfill_placeholder_page_names() == 0
    after, version_after = _stored_page_by_meta_id("556600000000003")
    assert after["name"] == "اسم يدوي مخصص"
    assert version_after == version_before


def test_page_name_backfill_remembers_denied_lookups(actors, configured_meta, monkeypatch):
    # A page Meta refuses to name (deleted, permission denied) must not
    # re-spend Graph requests on every periodic pass: the failed attempt is
    # remembered and retried only after the cooldown expires.
    meta_ads._PAGE_NAME_FAILURE_UNTIL.clear()
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn, {"metaPageId": "556600000000004", "metaPageName": ""}
        )

    calls = {"identity": [], "direct": []}

    class _DeniedClient:
        def _get_account_page_identity(self, account_id, page_id):
            calls["identity"].append(str(page_id))
            return {}

        def _get(self, path, params):
            calls["direct"].append(str(path))
            raise meta_ads.MetaAdsError("not_found", "Page is not readable")

    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: _DeniedClient())
    meta_ads.backfill_placeholder_page_names()
    assert calls["direct"].count("556600000000004") == 1
    assert "556600000000004" in meta_ads._PAGE_NAME_FAILURE_UNTIL
    identity_spent = calls["identity"].count("556600000000004")

    # Second pass inside the cooldown: zero remote spend for this page.
    meta_ads.backfill_placeholder_page_names()
    assert calls["direct"].count("556600000000004") == 1
    assert calls["identity"].count("556600000000004") == identity_spent

    # Cooldown over: the page is retried — and this time Meta answers.
    meta_ads._PAGE_NAME_FAILURE_UNTIL["556600000000004"] = 0.0

    class _HealedClient(_DeniedClient):
        def _get(self, path, params):
            calls["direct"].append(str(path))
            if str(path) == "556600000000004":
                return {"id": "556600000000004", "name": "Named After Retry", "category": ""}
            raise meta_ads.MetaAdsError("not_found", "Page is not readable")

    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: _HealedClient())
    assert meta_ads.backfill_placeholder_page_names() >= 1
    assert calls["direct"].count("556600000000004") == 2
    healed, _ = _stored_page_by_meta_id("556600000000004")
    assert healed["name"] == "Named After Retry"
    assert "556600000000004" not in meta_ads._PAGE_NAME_FAILURE_UNTIL


def test_page_name_failure_cache_expires_and_remains_bounded():
    with meta_ads._PAGE_NAME_FAILURE_LOCK:
        meta_ads._PAGE_NAME_FAILURE_UNTIL.clear()
        for index in range(meta_ads._PAGE_NAME_FAILURE_MAX_ENTRIES + 50):
            meta_ads._PAGE_NAME_FAILURE_UNTIL[str(index)] = 10_000.0 + index
        meta_ads._PAGE_NAME_FAILURE_UNTIL["expired"] = 1.0
    try:
        meta_ads._remember_page_name_failure("new-page", now_monotonic=100.0)
        assert "expired" not in meta_ads._PAGE_NAME_FAILURE_UNTIL
        assert "new-page" in meta_ads._PAGE_NAME_FAILURE_UNTIL
        assert len(meta_ads._PAGE_NAME_FAILURE_UNTIL) <= (
            meta_ads._PAGE_NAME_FAILURE_MAX_ENTRIES
        )
    finally:
        with meta_ads._PAGE_NAME_FAILURE_LOCK:
            meta_ads._PAGE_NAME_FAILURE_UNTIL.clear()


def test_preview_page_name_extraction_accepts_only_json_identity_pairs():
    # The preview scraper must only accept a JSON identity pair anchored to
    # the page id itself. Rendered link/button text is NEVER trusted: it
    # mixes UI labels ("Like Page") and undecoded HTML entities into the
    # name, and a wrong auto-name would afterwards be protected as a manual
    # rename by the import guards.
    pid = "556600000000005"
    json_doc = (
        '<script>x={"__typename":"Page","id":"' + pid + '",'
        '"name":"\\u0647\\u0646\\u0642\\u0631 \\u0627\\u0644\\u0647\\u0644\\u0627\\u0644\\u064a 4",'
        '"category":"Shopping"};</script>'
    )
    assert meta_ads._preview_page_name_candidates(json_doc, pid) == ["هنقر الهلالي 4"]

    reversed_doc = '<script>y={"name":"Real Shop","id":"' + pid + '"};</script>'
    assert meta_ads._preview_page_name_candidates(reversed_doc, pid) == ["Real Shop"]

    # Anchors that target the page still never qualify — not the real name
    # link, not CTA labels, not entity-mangled text.
    anchor_doc = (
        '<div><a class="_x" href="https://www.facebook.com/' + pid + '/">'
        "<span>متجر المعاينة</span></a>"
        '<a role="button" href="https://www.facebook.com/' + pid + '/">Like Page</a>'
        '<a href="https://www.facebook.com/' + pid + '/">Sarah&#x27;s Bakery</a></div>'
    )
    assert meta_ads._preview_page_name_candidates(anchor_doc, pid) == []

    # Unanchored pairs, placeholder names, markup and broken surrogate
    # escapes never qualify either.
    noise_doc = (
        '<script>z={"id":"123","name":"Other Entity"};</script>'
        '<script>p={"id":"' + pid + '","name":"' + pid + '"};</script>'
        '<script>q={"id":"' + pid + '","name":"<b>Bold</b>"};</script>'
        '<script>s={"id":"' + pid + '","name":"\\ud83d"};</script>'
    )
    assert meta_ads._preview_page_name_candidates(noise_doc, pid) == []


def test_page_name_backfill_reads_the_ad_preview_as_last_resort(
    actors, configured_meta, monkeypatch
):
    # Meta denies the directory read AND the direct page read (the brand-new
    # client page whose ad is still PENDING_REVIEW): the backfill must fall
    # back to the page header rendered in the imported ad's official preview.
    meta_ads._PAGE_NAME_FAILURE_UNTIL.clear()
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn, {"metaPageId": "556600000000006", "metaPageName": ""}
        )
        meta_ads._insert_internal_entity(
            conn,
            "ads",
            new_id("ad"),
            {
                "recordType": "ad",
                "customerId": "",
                "metaPageId": "556600000000006",
                "metaPageName": "",
                "metaAdId": "120200000000001",
                "metaImportSource": "meta_ads",
            },
        )

    class _PreviewOnlyClient:
        def _get_account_page_identity(self, account_id, page_id):
            return {}

        def _get(self, path, params):
            raise meta_ads.MetaAdsError("not_found", "Page is not readable")

        def get_ad_preview_page_name(self, ad_id, page_id, trace=None):
            assert str(ad_id) == "120200000000001"
            assert str(page_id) == "556600000000006"
            return "هنقر المعاينة الجديد"

    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: _PreviewOnlyClient())
    assert meta_ads.backfill_placeholder_page_names() >= 1
    healed, _ = _stored_page_by_meta_id("556600000000006")
    assert healed["name"] == "هنقر المعاينة الجديد"
    assert healed["metaPageName"] == "هنقر المعاينة الجديد"
    assert "556600000000006" not in meta_ads._PAGE_NAME_FAILURE_UNTIL


def test_page_name_probe_reports_every_source_and_applies_a_found_name(
    actors, configured_meta, monkeypatch
):
    # The admin diagnostic must show WHY a page has no name (per-source
    # outcome incl. Meta's error code) and, when a source does answer,
    # apply the name on the spot through the normal import guards.
    meta_ads._PAGE_NAME_FAILURE_UNTIL.clear()
    with db_conn() as conn:
        meta_ads._ensure_import_page(
            conn, {"metaPageId": "556600000000007", "metaPageName": ""}
        )
        meta_ads._insert_internal_entity(
            conn,
            "ads",
            new_id("ad"),
            {
                "recordType": "ad",
                "customerId": "",
                "metaPageId": "556600000000007",
                "metaPageName": "",
                "metaAdId": "120200000000002",
                "metaImportSource": "meta_ads",
            },
        )

    class _ProbeClient:
        def _get_account_page_identity(self, account_id, page_id):
            raise meta_ads.MetaAdsError(
                "permission_denied", "Not allowed", provider_code="(#10)"
            )

        def _get(self, path, params):
            raise meta_ads.MetaAdsError(
                "permission_denied", "Not allowed", provider_code="(#10)"
            )

        def get_ad_preview_page_name(self, ad_id, page_id, trace=None):
            assert str(ad_id) == "120200000000002"
            if isinstance(trace, list):
                trace.append("preview:ok")
            return "اسم من المعاينة"

    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: _ProbeClient())
    denied = client.get(
        "/api/meta-ads/pages/556600000000007/name-probe", cookies=actors["employee"]
    )
    assert denied.status_code == 403

    response = client.get(
        "/api/meta-ads/pages/556600000000007/name-probe", cookies=actors["admin"]
    )
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["pageId"] == "556600000000007"
    assert report["sources"]["directRead"] == {"error": "(#10)"}
    assert report["sources"]["adPreview"]["name"] == "اسم من المعاينة"
    assert report["applied"] is True
    assert report["appliedName"] == "اسم من المعاينة"
    healed, _ = _stored_page_by_meta_id("556600000000007")
    assert healed["name"] == "اسم من المعاينة"

    bad = client.get(
        "/api/meta-ads/pages/not-a-page-id/name-probe", cookies=actors["admin"]
    )
    assert bad.status_code == 400


# ---------------------------------------------------------------------------
# Pages consistency scan — the read-only diagnostic behind repairing a
# wrong page/owner association (an ad completed too fast against the wrong
# local page, or a Facebook id stamped onto a hand-renamed page).
# ---------------------------------------------------------------------------

def _seed_scan_entity(entity_type, entity_id, data, creator_id):
    stamp = now_ms()
    payload = {"id": entity_id, "_created": stamp, "_lastModified": stamp, "_deleted": False, "createdBy": creator_id}
    payload.update(data)
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                f"VALUES ('{entity_type}',:id,:data,false,:stamp,:creator,:stamp)"
            ),
            {"id": entity_id, "data": json_dumps(payload), "stamp": stamp, "creator": creator_id},
        )


def test_pages_consistency_scan_is_admin_only(actors):
    denied = client.get("/api/meta-ads/pages/consistency-scan", cookies=actors["employee"])
    assert denied.status_code == 403


def test_pages_consistency_scan_reports_every_incident_shape(actors):
    creator = actors["admin_id"]
    _seed_scan_entity("customers", "meta_test_scan_cust1", {"name": "Maged Krid", "phones": []}, creator)
    # The reported production shape: a page named for one business carrying
    # ANOTHER business's Facebook page id, with an owner attached.
    _seed_scan_entity("pages", "meta_test_scan_pwrong", {
        "name": "V-Tech libya", "metaPageId": "108503031999207",
        "metaPageName": "Correct Arabic Name", "customerIds": ["meta_test_scan_cust1"],
    }, creator)
    _seed_scan_entity("pages", "meta_test_scan_pplain", {"name": "Plain Local Page", "customerIds": []}, creator)
    # A1: meta ad linked to a page that carries NO Facebook id at all.
    _seed_scan_entity("ads", "meta_test_scan_ad1", {
        "recordType": "ad", "metaPageId": "108503031999207", "metaPageName": "Correct Arabic Name",
        "pageId": "meta_test_scan_pplain", "pageName": "Plain Local Page",
        "metaImportSource": "meta_ads", "customerId": "meta_test_scan_cust1",
    }, creator)
    # A2: meta ad whose linked page is stamped with a DIFFERENT Facebook page.
    _seed_scan_entity("ads", "meta_test_scan_ad2", {
        "recordType": "ad", "metaPageId": "222200000000001", "metaPageName": "Other Biz",
        "pageId": "meta_test_scan_pwrong", "pageName": "V-Tech libya",
        "metaImportSource": "meta_ads",
    }, creator)
    # A3: meta ad with no local page linked at all.
    _seed_scan_entity("ads", "meta_test_scan_ad3", {
        "recordType": "ad", "metaPageId": "108503031999207", "metaPageName": "Correct Arabic Name",
        "pageId": "", "metaImportSource": "meta_ads",
    }, creator)
    # A4: fully consistent meta ad — must NOT be reported.
    _seed_scan_entity("ads", "meta_test_scan_ad4", {
        "recordType": "ad", "metaPageId": "108503031999207", "metaPageName": "Correct Arabic Name",
        "pageId": "meta_test_scan_pwrong", "pageName": "V-Tech libya",
        "metaImportSource": "meta_ads",
    }, creator)

    response = client.get("/api/meta-ads/pages/consistency-scan", cookies=actors["admin"])
    assert response.status_code == 200, response.text
    result = response.json()

    reported = {item["adId"]: item for item in result["mismatchedAds"]}
    assert "meta_test_scan_ad4" not in reported
    assert reported["meta_test_scan_ad1"]["problem"] == "linked_page_carries_no_facebook_id"
    assert reported["meta_test_scan_ad2"]["problem"] == "linked_page_is_a_different_facebook_page"
    assert reported["meta_test_scan_ad3"]["problem"] == "no_local_page_linked"

    # The scan must point straight at the repair: which page ACTUALLY holds
    # the ad's Facebook id, and who owns it.
    stamped = reported["meta_test_scan_ad1"]["pagesActuallyStampedWithThisFacebookId"]
    assert any(p["pageId"] == "meta_test_scan_pwrong" and p["name"] == "V-Tech libya"
               and p["owners"] == ["Maged Krid"] for p in stamped)
    assert reported["meta_test_scan_ad1"]["customerName"] == "Maged Krid"

    wrong_page = next(p for p in result["stampedPages"] if p["pageId"] == "meta_test_scan_pwrong")
    assert wrong_page["owners"] == ["Maged Krid"]
    assert all(p["pageId"] != "meta_test_scan_pwrong" for p in result["stampedPagesWithNoOwner"])


def test_pages_consistency_scan_flags_a_facebook_id_stamped_twice(actors):
    creator = actors["admin_id"]
    _seed_scan_entity("pages", "meta_test_scan_pdup1", {
        "name": "First Stamped", "metaPageId": "333300000000009", "customerIds": [],
    }, creator)
    _seed_scan_entity("pages", "meta_test_scan_pdup2", {
        "name": "Second Stamped", "metaPageId": "333300000000009", "customerIds": [],
    }, creator)

    response = client.get("/api/meta-ads/pages/consistency-scan", cookies=actors["admin"])
    assert response.status_code == 200, response.text
    duplicates = response.json()["duplicateFacebookIdStamps"]
    assert "333300000000009" in duplicates
    names = {p["name"] for p in duplicates["333300000000009"]}
    assert names == {"First Stamped", "Second Stamped"}
    # Both unowned stamped pages must also surface in the needs-owner list.
    unowned = {p["pageId"] for p in response.json()["stampedPagesWithNoOwner"]}
    assert {"meta_test_scan_pdup1", "meta_test_scan_pdup2"} <= unowned


# ---------------------------------------------------------------------------
# Page-link guard — an imported ad may never be attached to a local page that
# belongs to a DIFFERENT Facebook page (the fast-completion mislink incident).
# ---------------------------------------------------------------------------

def test_completing_an_imported_ad_onto_another_facebook_pages_page_is_rejected(actors):
    creator = actors["admin_id"]
    customer_id = "meta_guard_customer"
    _insert_customer(customer_id, creator)
    _seed_scan_entity("pages", "meta_guard_page_right", {
        "name": "The Real Page", "metaPageId": "555511111111111", "customerIds": [],
    }, creator)
    _seed_scan_entity("pages", "meta_guard_page_wrong", {
        "name": "Somebody Else's Page", "metaPageId": "666622222222222", "customerIds": [],
    }, creator)
    _seed_scan_entity("pages", "meta_guard_page_unstamped", {
        "name": "Plain Hand-Made Page", "customerIds": [],
    }, creator)
    ad_id = "meta_guard_ad"
    version = _insert_ad(
        ad_id, creator,
        customerId=customer_id,
        metaImportState="needs_completion",
        metaImportSource="meta_ads",
        metaPageId="555511111111111",
        metaPageName="The Real Page",
        pageId="",
        pageName="",
        paymentStatus="not_paid",
        status="Active",
        amountUSD=10, amountLocal=97, exchangeRate=9.7,
        receiptId="", receiptAllocations=[], dueAllocations=[],
    )
    try:
        def _mutate(page_id, key, expected_version):
            return client.post(
                "/api/ads/mutate",
                json={
                    "action": "update",
                    "adId": ad_id,
                    "idempotencyKey": key,
                    "expectedLastModified": expected_version,
                    "data": {"pageId": page_id, "pageName": "chosen"},
                },
                cookies=actors["employee"],
            )

        # The incident: fast completion onto another business's page. 409,
        # and the draft must remain untouched (still needs completion).
        wrong = _mutate("meta_guard_page_wrong", "meta-guard-wrong", version)
        assert wrong.status_code == 409, wrong.text
        assert "666622222222222" in wrong.json()["detail"]
        stored, version = _stored_ad(ad_id)
        assert stored.get("pageId") == ""
        assert stored["metaImportState"] == "needs_completion"

        # A page that simply does not exist is a 404, not a silent link.
        missing = _mutate("meta_guard_page_ghost", "meta-guard-ghost", version)
        assert missing.status_code == 404, missing.text

        # An unstamped hand-made page is allowed (Meta may not know it yet).
        ok_unstamped = _mutate("meta_guard_page_unstamped", "meta-guard-unstamped", version)
        assert ok_unstamped.status_code == 200, ok_unstamped.text
        stored, version = _stored_ad(ad_id)
        assert stored["pageId"] == "meta_guard_page_unstamped"

        # And so is the page stamped with the ad's OWN Facebook id.
        ok_right = _mutate("meta_guard_page_right", "meta-guard-right", version)
        assert ok_right.status_code == 200, ok_right.text
        stored, _ = _stored_ad(ad_id)
        assert stored["pageId"] == "meta_guard_page_right"
    finally:
        with db_conn() as conn:
            conn.execute(
                text("DELETE FROM entities WHERE id LIKE 'meta_guard_%'")
            )


def test_page_guard_ignores_ordinary_ads_and_unchanged_links(actors):
    creator = actors["admin_id"]
    _seed_scan_entity("pages", "meta_guard2_stamped", {
        "name": "Stamped Page", "metaPageId": "777733333333333", "customerIds": [],
    }, creator)
    _insert_customer("meta_guard2_customer", creator)

    # A plain (non-Meta) ad may point anywhere — the guard must not fire.
    plain_version = _insert_ad(
        "meta_guard2_plain", creator,
        customerId="meta_guard2_customer",
        pageId="", pageName="",
        paymentStatus="not_paid", status="Active",
        amountUSD=10, amountLocal=97, exchangeRate=9.7,
        receiptId="", receiptAllocations=[], dueAllocations=[],
    )
    try:
        moved = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "meta_guard2_plain",
                "idempotencyKey": "meta-guard2-plain",
                "expectedLastModified": plain_version,
                "data": {"pageId": "meta_guard2_stamped", "pageName": "Stamped Page"},
            },
            cookies=actors["employee"],
        )
        assert moved.status_code == 200, moved.text

        # A mislinked-BEFORE-the-guard imported ad still accepts unrelated
        # edits: the guard fires only when the page link changes.
        stuck_version = _insert_ad(
            "meta_guard2_stuck", creator,
            customerId="meta_guard2_customer",
            metaImportSource="meta_ads",
            metaPageId="888844444444444",
            pageId="meta_guard2_stamped", pageName="Stamped Page",
            paymentStatus="not_paid", status="Active",
            amountUSD=10, amountLocal=97, exchangeRate=9.7,
            receiptId="", receiptAllocations=[], dueAllocations=[],
        )
        note = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "meta_guard2_stuck",
                "idempotencyKey": "meta-guard2-note",
                "expectedLastModified": stuck_version,
                "data": {"notes": "unrelated edit on a pre-guard mislink"},
            },
            cookies=actors["employee"],
        )
        assert note.status_code == 200, note.text
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id LIKE 'meta_guard2_%'"))


def test_admin_override_allows_a_warned_cross_page_link_employees_never(actors):
    """The owner's requested escape hatch: an ADMIN who confirmed the warning
    may deliberately re-point an imported ad across Facebook pages. The flag
    is request-only (never stored), and employees stay hard-blocked with or
    without it."""
    creator = actors["admin_id"]
    _insert_customer("meta_ovr_customer", creator)
    _seed_scan_entity("pages", "meta_ovr_page_other", {
        "name": "Other Business Page", "metaPageId": "999955555555555", "customerIds": [],
    }, creator)
    ad_id = "meta_ovr_ad"
    version = _insert_ad(
        ad_id, creator,
        customerId="meta_ovr_customer",
        metaImportSource="meta_ads",
        metaPageId="555511111111111",
        metaPageName="The Real Page",
        pageId="", pageName="",
        paymentStatus="not_paid", status="Active",
        amountUSD=10, amountLocal=97, exchangeRate=9.7,
        receiptId="", receiptAllocations=[], dueAllocations=[],
    )
    try:
        def _mutate(cookies, key, expected_version, extra):
            payload = {"pageId": "meta_ovr_page_other", "pageName": "Other Business Page"}
            payload.update(extra)
            return client.post(
                "/api/ads/mutate",
                json={
                    "action": "update",
                    "adId": ad_id,
                    "idempotencyKey": key,
                    "expectedLastModified": expected_version,
                    "data": payload,
                },
                cookies=cookies,
            )

        # An employee with the flag is still refused — the hatch is admin-only.
        employee = _mutate(actors["employee"], "meta-ovr-emp", version,
                           {"confirmMetaPageOverride": True})
        assert employee.status_code == 409, employee.text
        assert "administrator" in employee.json()["detail"]

        # An admin WITHOUT the flag is refused and pointed at the warned flow.
        admin_plain = _mutate(actors["admin"], "meta-ovr-plain", version, {})
        assert admin_plain.status_code == 409, admin_plain.text
        assert "Change-page" in admin_plain.json()["detail"]

        # An admin WITH the confirmed flag goes through.
        admin_confirmed = _mutate(actors["admin"], "meta-ovr-ok", version,
                                  {"confirmMetaPageOverride": True})
        assert admin_confirmed.status_code == 200, admin_confirmed.text
        stored, _ = _stored_ad(ad_id)
        assert stored["pageId"] == "meta_ovr_page_other"
        # Request-only: the confirmation itself must never be stored.
        assert "confirmMetaPageOverride" not in stored
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id LIKE 'meta_ovr_%'"))


# ---------------------------------------------------------------------------
# Bug-hunt 2026-08-22: the page-link guard must also cover the GENERIC ads
# PATCH route, and the name-only page match must never claim an OWNED page.
# ---------------------------------------------------------------------------

def test_generic_ads_patch_cannot_cross_link_an_imported_ad(actors):
    """The guard lived only in /api/ads/mutate. A hand-crafted same-origin
    PATCH /api/collections/ads/{id} by any Employee with ads.edit re-pointed
    an imported ad to another Facebook page's local page — bypassing the
    admin-only warned override entirely."""
    creator = actors["admin_id"]
    _insert_customer("meta_gp_customer", creator)
    _seed_scan_entity("pages", "meta_gp_page_right", {
        "name": "Right Page", "metaPageId": "121200000000001", "customerIds": [],
    }, creator)
    _seed_scan_entity("pages", "meta_gp_page_wrong", {
        "name": "Wrong Page", "metaPageId": "343400000000002", "customerIds": [],
    }, creator)
    ad_id = "meta_gp_ad"
    version = _insert_ad(
        ad_id, creator,
        customerId="meta_gp_customer",
        metaImportSource="meta_ads",
        metaPageId="121200000000001",
        pageId="", pageName="",
        paymentStatus="not_paid", status="Active",
        amountUSD=10, amountLocal=97, exchangeRate=9.7,
        receiptId="", receiptAllocations=[], dueAllocations=[],
    )
    try:
        def _patch(cookies, page_id, expected):
            return client.patch(
                f"/api/collections/ads/{ad_id}",
                json={"data": {"pageId": page_id, "pageName": "x"}, "expectedLastModified": expected},
                cookies=cookies,
            )

        employee = _patch(actors["employee"], "meta_gp_page_wrong", version)
        assert employee.status_code == 409, employee.text
        assert "343400000000002" in employee.json()["detail"]

        # No override exists on the generic route, even for an admin.
        admin = _patch(actors["admin"], "meta_gp_page_wrong", version)
        assert admin.status_code == 409, admin.text

        stored, version = _stored_ad(ad_id)
        assert stored.get("pageId") == ""

        # The ad's OWN Facebook page stays allowed on the generic route (this
        # is how the Duplicate-pages merge tool re-points ads).
        right = _patch(actors["employee"], "meta_gp_page_right", version)
        assert right.status_code == 200, right.text
        stored, _ = _stored_ad(ad_id)
        assert stored["pageId"] == "meta_gp_page_right"
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id LIKE 'meta_gp_%'"))


def test_name_only_page_match_skips_an_owned_page_but_reuses_an_unowned_one(actors):
    """Two unrelated shops can share a generic name. Stamping the Facebook id
    onto a same-named page that already has OWNERS would auto-bill the
    imported ad to that customer; an unowned same-named page is the normal
    'hand-made before Meta discovered it' case and must still be reused."""
    creator = actors["admin_id"]
    _insert_customer("meta_nm_customer", creator)
    _seed_scan_entity("pages", "meta_nm_owned", {
        "name": "مطعم الشام", "customerIds": ["meta_nm_customer"],
    }, creator)
    _seed_scan_entity("pages", "meta_nm_unowned", {
        "name": "  Mataam   Beirut ", "customerIds": [],
    }, creator)
    try:
        with meta_ads._META_WRITE_LOCK, db_conn() as conn:
            owned_page_id, _, owned_created = meta_ads._ensure_import_page(
                conn, {"metaPageId": "565600000000001", "metaPageName": "مطعم الشام"}
            )
            unowned_page_id, _, unowned_created = meta_ads._ensure_import_page(
                conn, {"metaPageId": "787800000000002", "metaPageName": "mataam beirut"}
            )
        # Owned same-name page left alone: a FRESH ownerless page was created.
        assert owned_created is True
        assert owned_page_id != "meta_nm_owned"
        with db_conn() as conn:
            owned_row = conn.execute(
                text("SELECT data_json FROM entities WHERE id='meta_nm_owned'")
            ).mappings().first()
        assert "metaPageId" not in (json_loads(owned_row["data_json"]) or {})
        # Unowned same-name page reused and stamped, exactly as before.
        assert unowned_created is False
        assert unowned_page_id == "meta_nm_unowned"
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id LIKE 'meta_nm_%'"))
            conn.execute(
                text("DELETE FROM entities WHERE type='pages' AND data_json LIKE '%565600000000001%'")
            )
            conn.execute(
                text("DELETE FROM entities WHERE type='pages' AND data_json LIKE '%787800000000002%'")
            )


def test_ensure_import_page_takes_a_per_page_advisory_lock_first_on_postgres(actors, monkeypatch):
    """On Postgres the enrichment path holds only the AD row lock, so two
    overlapping syncs for two ads of one brand-new Facebook page both missed
    the page lookup and both inserted — one Facebook id on two pages,
    invisible because every by-id lookup is LIMIT 1. The page lookup must be
    preceded by a transaction-scoped advisory lock keyed on the page id."""

    class _Dialect:
        name = "postgresql"

    class _Engine:
        dialect = _Dialect()

    monkeypatch.setattr(meta_ads, "get_engine", lambda: _Engine())

    class _LockTaken(Exception):
        pass

    recorded = []

    class _Conn:
        # Records the very first statement and stops there: the lock must be
        # the FIRST thing that happens, before any lookup or insert.
        def execute(self, stmt, params=None):
            recorded.append((str(stmt), dict(params or {})))
            raise _LockTaken()

    with pytest.raises(_LockTaken):
        meta_ads._ensure_import_page(
            _Conn(), {"metaPageId": "909900000000001", "metaPageName": "Lock Test Page"}
        )
    assert len(recorded) == 1
    sql, params = recorded[0]
    assert "pg_advisory_xact_lock(hashtext(:k))" in sql
    assert params == {"k": "albayan_meta_page:909900000000001"}
