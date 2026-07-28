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

    def list_ads(self, account_id, search="", *, max_pages=5):
        self.list_calls.append((str(account_id), int(max_pages)))
        rows = list(self.rows)
        needle = str(search or "").casefold()
        return [row for row in rows if not needle or needle in str(row).casefold()]


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
            if row["type"] == "metaImportState" or (
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

    avatar = "https://scontent.xx.fbcdn.net/v/t39.30808-1/123456789_987654321012345_n.jpg"
    assert meta_ads._cdn_asset_key(f"{avatar}?stp=dst-jpg_p64x64&oh=aaa") == (
        meta_ads._cdn_asset_key(f"{avatar}?oh=bbb&oe=ccc")
    ) != ""
    # Generic path names must never match anything.
    assert meta_ads._cdn_asset_key("https://scontent.xx.fbcdn.net/picture") == ""
    assert meta_ads._cdn_asset_key("http://scontent.xx.fbcdn.net/a_b_c_long_name.jpg") == ""


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
    # The generic creative thumbnail was the Page profile picture: it must be
    # rejected instead of being displayed as the ad's photo.
    assert snapshot["metaThumbnailUrl"] == ""
    assert snapshot["metaThumbnailSource"] == ""
    assert snapshot["metaMediaVersion"] == meta_ads._META_MEDIA_VERSION


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
    # The only candidate photo is the untrusted generic thumbnail of a boosted
    # Page post and the avatar could not be checked: fail CLOSED (no photo,
    # the UI shows its loading tile) instead of risking the page logo.
    assert snapshot["metaThumbnailUrl"] == ""
    assert snapshot["metaThumbnailSource"] == ""


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
    assert response.json()["workerSyncIntervalSeconds"] == 10
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

        # If Meta rejects the repair, the normal retry clock must be respected
        # instead of repeatedly calling Meta for the same image.
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
                {"id": ad_id},
            ).mappings().first()
            data = json_loads(row["data_json"])
            data["metaSyncFailureCount"] = 1
            data["metaNextSyncAt"] = now_ms() + 900_000
            conn.execute(
                text("UPDATE entities SET data_json=:data WHERE type='ads' AND id=:id"),
                {"data": json_dumps(data), "id": ad_id},
            )
        assert ad_id not in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}
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
    _apply(degraded)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaThumbnailUrl"] == "https://lookaside.fbsbx.com/real-ad-photo.jpg"
    assert stored["metaThumbnailSource"] == "story"
    assert stored["metaPageId"] == "777777777777777"
    assert stored["metaPageName"] == "Existing Meta Page"

    # A weak generic thumbnail (possibly the Page avatar) may still be
    # retired by an empty resolution so wrong photos do not stick forever.
    weak = _snapshot(meta_id)
    weak["metaThumbnailUrl"] = "https://lookaside.fbsbx.com/page-logo.jpg"
    weak["metaThumbnailSource"] = "meta_fallback"
    _apply(weak)
    cleared = _snapshot(meta_id)
    cleared["metaThumbnailUrl"] = ""
    cleared["metaThumbnailSource"] = ""
    _apply(cleared)
    stored, _ = _stored_ad(ad_id)
    assert stored["metaThumbnailUrl"] == ""
    assert stored["metaThumbnailSource"] == ""


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
