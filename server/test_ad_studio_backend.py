"""Security and workflow tests for customer Ads Studio campaign requests."""

import base64
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "ad-studio-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "AdStudioAdmin123!"
OWNER_EMAIL = "ad-studio-owner@tests.albayanhub.com"
OWNER_PASSWORD = "AdStudioOwner123!"
OTHER_EMAIL = "ad-studio-other@tests.albayanhub.com"
OTHER_PASSWORD = "AdStudioOther123!"
REVIEWER_EMAIL = "ad-studio-reviewer@tests.albayanhub.com"
REVIEWER_PASSWORD = "AdStudioReviewer123!"
UNSUBSCRIBED_EMAIL = "ad-studio-unsubscribed@tests.albayanhub.com"
UNSUBSCRIBED_PASSWORD = "AdStudioUnsubscribed123!"

CUSTOMER_PERMISSIONS = {
    "adCampaignRequests": [
        "viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn",
    ]
}
REVIEWER_PERMISSIONS = {"adCampaignRequests": ["view", "review"]}
VALID_PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)


def _ensure_admin() -> str:
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        existing = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": ADMIN_EMAIL},
        ).mappings().first()
        if existing:
            return str(existing["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Ads Studio Admin',:email,'Admin',:permissions,:hash,:salt,"
                ":algo,:iterations,false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "permissions": json_dumps({}),
                "hash": password.hash_hex,
                "salt": password.salt_hex,
                "algo": password.algo,
                "iterations": password.iterations,
                "now": now,
            },
        )
    return uid


def _login(email: str, password: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    token = response.cookies.get("albayan_session")
    client.cookies.clear()
    return {"albayan_session": token}


def _create_user(admin: dict[str, str], email: str, password: str, permissions: dict) -> dict:
    response = client.post(
        "/api/users",
        json={
            "name": email.split("@")[0],
            "email": email,
            "password": password,
            "role": "Employee",
            "permissions": permissions,
        },
        cookies=admin,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _subscribe(cookies: dict[str, str], suffix: str) -> dict:
    response = client.post(
        "/api/subscriptions/purchase",
        json={
            "serviceId": "ad_maker",
            "idempotencyKey": f"ad-studio-subscription-{suffix}",
        },
        cookies=cookies,
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def actors():
    init_db()
    _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)

    owner_user = _create_user(admin, OWNER_EMAIL, OWNER_PASSWORD, CUSTOMER_PERMISSIONS)
    other_user = _create_user(admin, OTHER_EMAIL, OTHER_PASSWORD, CUSTOMER_PERMISSIONS)
    reviewer_user = _create_user(admin, REVIEWER_EMAIL, REVIEWER_PASSWORD, REVIEWER_PERMISSIONS)
    unsubscribed_user = _create_user(
        admin, UNSUBSCRIBED_EMAIL, UNSUBSCRIBED_PASSWORD, CUSTOMER_PERMISSIONS
    )
    owner = _login(OWNER_EMAIL, OWNER_PASSWORD)
    other = _login(OTHER_EMAIL, OTHER_PASSWORD)
    reviewer = _login(REVIEWER_EMAIL, REVIEWER_PASSWORD)
    unsubscribed = _login(UNSUBSCRIBED_EMAIL, UNSUBSCRIBED_PASSWORD)
    _subscribe(owner, "owner")
    _subscribe(other, "other")
    # Submitting holds the campaign budget in the customer's USD wallet, so
    # every studio actor gets a comfortably funded wallet for the tests.
    for uid, tag in ((owner_user["id"], "owner"), (other_user["id"], "other")):
        funded = client.post(
            "/api/wallet/top-ups",
            json={
                "userId": uid,
                "amountMinor": 100_000_000,
                "currency": "USD",
                "idempotencyKey": f"ad-studio-wallet-{tag}",
                "memo": "Studio test funding",
            },
            cookies=admin,
        )
        assert funded.status_code == 200, funded.text
    return {
        "admin": admin,
        "owner": owner,
        "owner_id": owner_user["id"],
        "other": other,
        "other_id": other_user["id"],
        "reviewer": reviewer,
        "reviewer_id": reviewer_user["id"],
        "unsubscribed": unsubscribed,
        "unsubscribed_id": unsubscribed_user["id"],
    }


def _complete_campaign(name: str = "Tripoli Messages Campaign") -> dict:
    return {
        "name": name,
        "objective": "messages",
        "platforms": ["facebook", "instagram"],
        "pageName": "Test Business Page",
        "primaryText": "Message us for this week's offer.",
        "headline": "Weekly offer",
        "description": "A reviewed customer request, not a live Meta ad.",
        "callToAction": "Send Message",
        "destination": "https://wa.me/218910000000",
        "locations": ["Tripoli, Libya"],
        "ageMin": 18,
        "ageMax": 55,
        "genders": ["all"],
        "languages": ["Arabic"],
        "interests": ["Shopping"],
        "startDate": "2027-01-10",
        "endDate": "2027-01-20",
        "budgetMinorUSD": 2500,
        "budgetType": "lifetime",
        "notes": "Please review before launch.",
        "specialAdCategories": ["none"],
        "creativeImages": [VALID_PNG_DATA_URL],
        "creativeAssetIds": [],
    }


def _create_campaign(cookies: dict[str, str], data: dict, campaign_id: str | None = None):
    return client.post(
        "/api/collections/adCampaignRequests",
        json={"id": campaign_id or new_id("campaign"), "data": data},
        cookies=cookies,
    )


class TestAdsStudioAllowlistAndSubscription:
    def test_permission_module_is_grantable_but_customer_role_is_not_added(self, actors):
        allowed = client.post(
            "/api/users",
            json={
                "name": "Narrow Ads User",
                "email": "ad-studio-allowlist@tests.albayanhub.com",
                "password": "AdStudioAllowlist123!",
                "role": "Employee",
                "permissions": {"adCampaignRequests": ["viewOwn", "submitOwn"]},
            },
            cookies=actors["admin"],
        )
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["permissions"] == {
            "adCampaignRequests": ["viewOwn", "submitOwn"]
        }

        invalid_role = client.post(
            "/api/users",
            json={
                "name": "Invalid Role",
                "email": "ad-studio-invalid-role@tests.albayanhub.com",
                "password": "AdStudioInvalidRole123!",
                "role": "Customer",
                "permissions": {},
            },
            cookies=actors["admin"],
        )
        assert invalid_role.status_code == 400

        invalid_action = client.post(
            "/api/users",
            json={
                "name": "Invalid Permission",
                "email": "ad-studio-invalid-permission@tests.albayanhub.com",
                "password": "AdStudioInvalidPermission123!",
                "role": "Employee",
                "permissions": {"adCampaignRequests": ["publishLive"]},
            },
            cookies=actors["admin"],
        )
        assert invalid_action.status_code == 400

    def test_non_admin_requires_active_ad_maker_subscription(self, actors):
        # READS stay open without a subscription (an expired customer must
        # still see the campaigns holding their money) — ownership-scoped,
        # so an unsubscribed stranger simply sees their own empty list.
        listing = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["unsubscribed"]
        )
        assert listing.status_code == 200
        assert listing.json() == []
        # Every MUTATING route keeps the subscription gate.
        create = _create_campaign(actors["unsubscribed"], {"name": "No subscription"})
        assert create.status_code == 403
        watermarks = client.get("/api/sync/watermarks", cookies=actors["unsubscribed"])
        assert watermarks.status_code == 200
        assert "adCampaignRequests" not in watermarks.json()["watermarks"]

        reviewer_listing = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["reviewer"]
        )
        assert reviewer_listing.status_code == 200


class TestAdsStudioPublicUserPrivacy:
    def test_owner_only_account_receives_only_its_own_public_user(self, actors):
        response = client.get("/api/users/public", cookies=actors["owner"])
        assert response.status_code == 200, response.text

        rows = response.json()
        assert [row["id"] for row in rows] == [actors["owner_id"]]
        assert rows[0]["name"] == OWNER_EMAIL.split("@")[0]
        assert rows[0]["role"] == "Employee"
        assert set(rows[0]) == {"id", "name", "role"}

    def test_reviewer_can_resolve_campaign_owner(self, actors):
        response = client.get("/api/users/public", cookies=actors["reviewer"])
        assert response.status_code == 200, response.text

        rows = response.json()
        owner = next((row for row in rows if row["id"] == actors["owner_id"]), None)
        assert owner is not None
        assert owner["name"] == OWNER_EMAIL.split("@")[0]
        assert owner["role"] == "Employee"
        assert set(owner) == {"id", "name", "role"}


class TestAdsStudioDraftSecurity:
    def test_create_forces_draft_strips_workflow_and_lists_media_lightweight(self, actors):
        data = _complete_campaign("Forced Draft")
        data.update(
            {
                "status": "Approved",
                "reviewedBy": actors["owner_id"],
                "metaCampaignId": "forged-live-id",
                "internalMoneyCredit": 999999,
            }
        )
        created = _create_campaign(actors["owner"], data, "ad_studio_forced_draft")
        assert created.status_code == 200, created.text
        replayed_create = _create_campaign(actors["owner"], data, "ad_studio_forced_draft")
        assert replayed_create.status_code == 200, replayed_create.text
        assert replayed_create.json()["lastModified"] == created.json()["lastModified"]
        payload = created.json()
        stored = payload["data"]
        assert payload["createdBy"] == actors["owner_id"]
        assert stored["status"] == "Draft"
        assert stored["budgetMinorUSD"] == 2500
        assert stored["creativeImages"] == [VALID_PNG_DATA_URL]
        assert "reviewedBy" not in stored
        assert "metaCampaignId" not in stored
        assert "internalMoneyCredit" not in stored

        listing = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["owner"]
        )
        assert listing.status_code == 200, listing.text
        listed = next(item for item in listing.json() if item["id"] == payload["id"])
        assert "creativeImages" not in listed["data"]
        assert listed["data"]["_mediaOmitted"] is True
        assert listed["data"]["_photoCount"] == 1

        hydrated = client.get(
            f"/api/collections/adCampaignRequests/{payload['id']}",
            cookies=actors["owner"],
        )
        assert hydrated.status_code == 200
        assert hydrated.json()["data"]["creativeImages"] == [VALID_PNG_DATA_URL]

    def test_owner_isolation_and_privilege_escalation_attempts(self, actors):
        created = _create_campaign(
            actors["owner"], _complete_campaign("Owner only"), "ad_studio_owner_only"
        )
        assert created.status_code == 200, created.text
        entity_id = created.json()["id"]

        other_list = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["other"]
        )
        assert other_list.status_code == 200
        assert all(row["id"] != entity_id for row in other_list.json())
        other_get = client.get(
            f"/api/collections/adCampaignRequests/{entity_id}", cookies=actors["other"]
        )
        assert other_get.status_code == 403

        escalate = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={
                "data": {"status": "Approved", "reviewedBy": actors["other_id"]},
                "expectedLastModified": created.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert escalate.status_code == 403

        bad_budget = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={
                "data": {"budgetMinorUSD": "2500"},
                "expectedLastModified": created.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert bad_budget.status_code == 400

        missing_version = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={"data": {"headline": "Unsafe unversioned edit"}},
            cookies=actors["owner"],
        )
        assert missing_version.status_code == 409

        other_patch = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={"data": {"name": "Stolen"}},
            cookies=actors["other"],
        )
        assert other_patch.status_code == 403

        saved_patch = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={
                "data": {"headline": "Saved despite response loss"},
                "expectedLastModified": created.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert saved_patch.status_code == 200, saved_patch.text
        replayed_patch = client.patch(
            f"/api/collections/adCampaignRequests/{entity_id}",
            json={
                "data": {"headline": "Saved despite response loss"},
                "expectedLastModified": created.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert replayed_patch.status_code == 200, replayed_patch.text
        assert replayed_patch.json()["lastModified"] == saved_patch.json()["lastModified"]

    def test_draft_validation_and_media_limits(self, actors):
        incomplete = _create_campaign(
            actors["owner"], {"name": "Incomplete"}, "ad_studio_incomplete"
        )
        assert incomplete.status_code == 200
        submit = client.post(
            "/api/ad-studio/campaigns/ad_studio_incomplete/submit",
            json={
                "expectedLastModified": incomplete.json()["lastModified"],
                "operationId": "submit-incomplete-001",
            },
            cookies=actors["owner"],
        )
        assert submit.status_code == 400

        too_many_images = _complete_campaign("Too many images")
        too_many_images["creativeImages"] = [
            "data:image/png;base64,AAAA",
            "data:image/png;base64,BBBB",
            "data:image/png;base64,CCCC",
            "data:image/png;base64,DDDD",
        ]
        response = _create_campaign(actors["owner"], too_many_images)
        assert response.status_code == 400

    def test_launch_fields_and_image_bytes_are_strictly_validated(self, actors):
        for field, value in (
            ("budgetType", "sometimes"),
            ("callToAction", "Do Anything"),
            ("destination", "not-a-link"),
            ("ageMin", 17),
        ):
            data = _complete_campaign(f"Invalid {field}")
            data[field] = value
            response = _create_campaign(actors["owner"], data)
            assert response.status_code == 400, (field, response.text)

        invalid_base64 = _complete_campaign("Invalid base64")
        invalid_base64["creativeImages"] = ["data:image/png;base64,%%%"]
        assert _create_campaign(actors["owner"], invalid_base64).status_code == 400

        oversized_header = (
            b"\x89PNG\r\n\x1a\n"
            + (13).to_bytes(4, "big")
            + b"IHDR"
            + (5000).to_bytes(4, "big")
            + (5000).to_bytes(4, "big")
        )
        pixel_bomb = _complete_campaign("Pixel bomb")
        pixel_bomb["creativeImages"] = [
            "data:image/png;base64," + base64.b64encode(oversized_header).decode("ascii")
        ]
        assert _create_campaign(actors["owner"], pixel_bomb).status_code == 413

        truncated_header = (
            b"\x89PNG\r\n\x1a\n"
            + (13).to_bytes(4, "big")
            + b"IHDR"
            + (1).to_bytes(4, "big")
            + (1).to_bytes(4, "big")
        )
        truncated = _complete_campaign("Truncated image")
        truncated["creativeImages"] = [
            "data:image/png;base64," + base64.b64encode(truncated_header).decode("ascii")
        ]
        invalid_image = _create_campaign(actors["owner"], truncated)
        assert invalid_image.status_code == 400, invalid_image.text

    def test_media_validation_is_limited_before_expensive_decode(self, actors):
        key = f"ad-studio:media:{actors['owner_id']}"
        reset_rate_limit(key)
        invalid = _complete_campaign("Rate-limited invalid media")
        invalid["creativeImages"] = ["data:image/png;base64,AAAA"]
        try:
            for _index in range(24):
                response = _create_campaign(actors["owner"], invalid)
                assert response.status_code == 400, response.text
            blocked = _create_campaign(actors["owner"], invalid)
            assert blocked.status_code == 429, blocked.text
            assert int(blocked.headers.get("Retry-After") or 0) >= 1
        finally:
            reset_rate_limit(key)

    def test_past_schedule_and_missing_creative_cannot_be_submitted(self, actors):
        for campaign_id, mutate in (
            ("ad_studio_past_schedule", lambda data: data.update({"startDate": "2020-01-01", "endDate": "2020-01-02"})),
            ("ad_studio_missing_creative", lambda data: data.update({"creativeImages": []})),
        ):
            data = _complete_campaign(campaign_id)
            mutate(data)
            created = _create_campaign(actors["owner"], data, campaign_id)
            assert created.status_code == 200, created.text
            submitted = client.post(
                f"/api/ad-studio/campaigns/{campaign_id}/submit",
                json={
                    "expectedLastModified": created.json()["lastModified"],
                    "operationId": f"submit-{campaign_id}",
                },
                cookies=actors["owner"],
            )
            assert submitted.status_code == 400, submitted.text

    def test_delete_is_idempotent_and_campaign_batch_delete_is_blocked(self, actors):
        campaign_id = "ad_studio_delete_replay"
        created = _create_campaign(actors["owner"], {"name": "Delete replay"}, campaign_id)
        assert created.status_code == 200, created.text
        batch = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "adCampaignRequests", "id": campaign_id}]},
            cookies=actors["owner"],
        )
        assert batch.status_code == 405
        first = client.delete(
            f"/api/collections/adCampaignRequests/{campaign_id}", cookies=actors["owner"]
        )
        replay = client.delete(
            f"/api/collections/adCampaignRequests/{campaign_id}", cookies=actors["owner"]
        )
        assert first.status_code == 200, first.text
        assert replay.status_code == 200, replay.text
        assert replay.json()["lastModified"] == first.json()["lastModified"]


class TestAdsStudioReviewerPrivacy:
    def test_reviewer_never_sees_private_editable_campaigns(self, actors):
        campaign_id = "ad_studio_reviewer_private"
        created = _create_campaign(
            actors["owner"], _complete_campaign("Private until submitted"), campaign_id
        )
        assert created.status_code == 200, created.text

        draft_list = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["reviewer"]
        )
        assert draft_list.status_code == 200
        assert all(row["id"] != campaign_id for row in draft_list.json())
        assert client.get(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["reviewer"],
        ).status_code == 404

        submit_operation = "submit-reviewer-private-001"
        submitted = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "operationId": submit_operation,
            },
            cookies=actors["owner"],
        )
        assert submitted.status_code == 200, submitted.text
        visible = client.get(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["reviewer"],
        )
        assert visible.status_code == 200
        assert visible.json()["data"]["creativeImages"] == [VALID_PNG_DATA_URL]

        changed = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Changes Requested",
                "note": "Please update the offer.",
                "operationId": "review-private-changes-001",
            },
            cookies=actors["reviewer"],
        )
        assert changed.status_code == 200, changed.text
        assert client.get(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["reviewer"],
        ).status_code == 404

        private_edit = client.patch(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            json={
                "data": {"headline": "Private revised offer"},
                "expectedLastModified": changed.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert private_edit.status_code == 200, private_edit.text

        repeated_review = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Changes Requested",
                "note": "Please update the offer.",
                "operationId": "review-private-changes-001",
            },
            cookies=actors["reviewer"],
        )
        assert repeated_review.status_code == 200, repeated_review.text
        replay_payload = repeated_review.json()
        assert replay_payload["deleted"] is True
        assert set(replay_payload["data"]) == {"id", "_lastModified", "_deleted"}
        assert "Private revised offer" not in repeated_review.text

        delta = client.get(
            "/api/collections/adCampaignRequests",
            params={
                "updated_since": submitted.json()["lastModified"],
                "include_deleted": "true",
            },
            cookies=actors["reviewer"],
        )
        assert delta.status_code == 200, delta.text
        tombstone = next(row for row in delta.json() if row["id"] == campaign_id)
        assert tombstone["deleted"] is True
        assert tombstone["data"]["_deleted"] is True
        assert "name" not in tombstone["data"]

        final_list = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["reviewer"]
        )
        assert all(row["id"] != campaign_id for row in final_list.json())


class TestAdsStudioWorkflow:
    def test_workflow_operation_recovers_when_identical_request_wins_lock_race(
        self, actors, monkeypatch
    ):
        import server.main as main_module

        campaign_id = "ad_studio_concurrent_operation"
        created = _create_campaign(
            actors["owner"], _complete_campaign("Concurrent operation"), campaign_id
        )
        assert created.status_code == 200, created.text
        original_patch = main_module.patch_entity
        submit_operation = "submit-concurrent-operation-001"

        def commit_submit_then_report_conflict(*args, **kwargs):
            result = original_patch(*args, **kwargs)
            updates = args[2] if len(args) > 2 else {}
            if updates.get("lastSubmitOperationId") == submit_operation:
                raise HTTPException(status_code=409, detail="simulated lock-race conflict")
            return result

        monkeypatch.setattr(main_module, "patch_entity", commit_submit_then_report_conflict)
        submitted = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "operationId": submit_operation,
            },
            cookies=actors["owner"],
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["data"]["status"] == "Submitted"

        review_operation = "review-concurrent-operation-001"

        def commit_review_then_report_conflict(*args, **kwargs):
            result = original_patch(*args, **kwargs)
            updates = args[2] if len(args) > 2 else {}
            if updates.get("lastReviewOperationId") == review_operation:
                raise HTTPException(status_code=409, detail="simulated lock-race conflict")
            return result

        monkeypatch.setattr(main_module, "patch_entity", commit_review_then_report_conflict)
        reviewed = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Approved",
                "note": "Approved once despite the repeated request.",
                "operationId": review_operation,
            },
            cookies=actors["reviewer"],
        )
        assert reviewed.status_code == 200, reviewed.text
        assert reviewed.json()["data"]["status"] == "Approved"

    def test_submit_changes_resubmit_and_approve(self, actors):
        created = _create_campaign(
            actors["owner"], _complete_campaign("Lifecycle"), "ad_studio_lifecycle"
        )
        assert created.status_code == 200, created.text
        campaign_id = created.json()["id"]

        forbidden_review = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "decision": "Approved",
                "note": "forged",
                "operationId": "review-forbidden-owner-001",
            },
            cookies=actors["owner"],
        )
        assert forbidden_review.status_code == 403

        submitted = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "operationId": "submit-lifecycle-001",
            },
            cookies=actors["owner"],
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["data"]["status"] == "Submitted"
        assert submitted.json()["data"]["submittedBy"] == actors["owner_id"]
        assert "creativeImages" not in submitted.json()["data"]
        assert submitted.json()["data"]["_photoCount"] == 1

        submit_replay = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "operationId": "submit-lifecycle-001",
            },
            cookies=actors["owner"],
        )
        assert submit_replay.status_code == 200, submit_replay.text
        assert submit_replay.json()["lastModified"] == submitted.json()["lastModified"]

        stale_submit = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": created.json()["lastModified"],
                "operationId": "submit-lifecycle-stale-001",
            },
            cookies=actors["owner"],
        )
        assert stale_submit.status_code == 409

        edit_submitted = client.patch(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            json={
                "data": {"headline": "Cannot edit yet"},
                "expectedLastModified": submitted.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert edit_submitted.status_code == 409

        missing_review_note = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Changes Requested",
                "note": "",
                "operationId": "review-lifecycle-empty-note-001",
            },
            cookies=actors["reviewer"],
        )
        assert missing_review_note.status_code == 400

        changes = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Changes Requested",
                "note": "Please clarify the offer.",
                "operationId": "review-lifecycle-changes-001",
            },
            cookies=actors["reviewer"],
        )
        assert changes.status_code == 200, changes.text
        assert changes.json()["data"]["status"] == "Changes Requested"
        assert changes.json()["data"]["reviewedBy"] == actors["reviewer_id"]
        assert changes.json()["data"]["reviewHistory"][-1]["note"] == "Please clarify the offer."

        changes_replay = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": submitted.json()["lastModified"],
                "decision": "Changes Requested",
                "note": "Please clarify the offer.",
                "operationId": "review-lifecycle-changes-001",
            },
            cookies=actors["reviewer"],
        )
        assert changes_replay.status_code == 200, changes_replay.text
        assert changes_replay.json()["lastModified"] == changes.json()["lastModified"]

        edited = client.patch(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            json={
                "data": {"headline": "Clear weekly offer"},
                "expectedLastModified": changes.json()["lastModified"],
            },
            cookies=actors["owner"],
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["data"]["status"] == "Changes Requested"

        resubmitted = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/submit",
            json={
                "expectedLastModified": edited.json()["lastModified"],
                "operationId": "submit-lifecycle-002",
            },
            cookies=actors["owner"],
        )
        assert resubmitted.status_code == 200, resubmitted.text
        assert resubmitted.json()["data"]["status"] == "Submitted"

        approved = client.post(
            f"/api/ad-studio/campaigns/{campaign_id}/review",
            json={
                "expectedLastModified": resubmitted.json()["lastModified"],
                "decision": "Approved",
                "note": "Approved for a later, separate publishing process.",
                "operationId": "review-lifecycle-approved-001",
            },
            cookies=actors["reviewer"],
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["data"]["status"] == "Approved"
        assert approved.json()["data"]["reviewDecision"] == "Approved"
        assert len(approved.json()["data"]["reviewHistory"]) == 2
        assert "creativeImages" not in approved.json()["data"]
        assert "metaCampaignId" not in approved.json()["data"]

        admin_edit_approved = client.patch(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            json={
                "data": {"headline": "Approved content must stay immutable"},
                "expectedLastModified": approved.json()["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert admin_edit_approved.status_code == 409

        # Archiving an Approved campaign with captured money would forfeit
        # it — the server refuses and points at the stop-refund flow.
        forfeit_blocked = client.delete(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["owner"],
        )
        assert forfeit_blocked.status_code == 409, forfeit_blocked.text
        stopped = _stop_campaign(
            actors["owner"], campaign_id, approved.json()["lastModified"],
            "review-lifecycle-stop-001",
        )
        assert stopped.status_code == 200, stopped.text
        owner_delete = client.delete(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["owner"],
        )
        assert owner_delete.status_code == 200
        assert client.get(
            f"/api/collections/adCampaignRequests/{campaign_id}",
            cookies=actors["owner"],
        ).status_code == 404

    def test_sync_watermark_is_present_for_entitled_owner(self, actors):
        response = client.get("/api/sync/watermarks", cookies=actors["owner"])
        assert response.status_code == 200, response.text
        assert "adCampaignRequests" in response.json()["watermarks"]


def _fresh_funded_customer(actors, tag: str, fund_minor: int) -> tuple[dict, dict]:
    """A brand-new subscribed studio customer with an exact wallet balance."""
    user = _create_user(
        actors["admin"], f"ad-studio-wallet-{tag}@tests.albayanhub.com",
        f"AdStudioWallet{tag}123!", CUSTOMER_PERMISSIONS,
    )
    cookies = _login(f"ad-studio-wallet-{tag}@tests.albayanhub.com", f"AdStudioWallet{tag}123!")
    _subscribe(cookies, f"wallet-{tag}")
    if fund_minor > 0:
        funded = client.post(
            "/api/wallet/top-ups",
            json={
                "userId": user["id"],
                "amountMinor": fund_minor,
                "currency": "USD",
                "idempotencyKey": f"wallet-fund-{tag}",
            },
            cookies=actors["admin"],
        )
        assert funded.status_code == 200, funded.text
    return user, cookies


def _wallet_rows_for(actors, user_id: str) -> list[dict]:
    payload = client.get(
        "/api/collections/walletTransactions", cookies=actors["admin"]
    ).json()
    rows = payload if isinstance(payload, list) else (payload.get("items") or [])
    datas = [r.get("data") or {} for r in rows if isinstance(r, dict)]
    return [
        d for d in datas
        if str(d.get("fromUserId") or "") == user_id
        or str(d.get("toUserId") or "") == user_id
    ]


def _submit_campaign(cookies, campaign_id: str, last_modified: int, op: str):
    return client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/submit",
        json={"expectedLastModified": last_modified, "operationId": op},
        cookies=cookies,
    )


def _review_campaign(actors, campaign_id: str, last_modified: int, decision: str, op: str, note: str = ""):
    return client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/review",
        json={
            "expectedLastModified": last_modified,
            "decision": decision,
            "note": note,
            "operationId": op,
        },
        cookies=actors["reviewer"],
    )


class TestStudioWalletPayments:
    """The customer wallet: gateway-ready charges, holds, and captures."""

    def test_payment_request_lifecycle_credits_exactly_once(self, actors):
        created = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 5000,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-req-001",
            },
            cookies=actors["owner"],
        )
        assert created.status_code == 200, created.text
        entity = created.json()
        rid = entity["id"]
        assert entity["data"]["status"] == "pending"
        assert str(entity["data"]["reference"]).startswith("PAY-")

        replay = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 5000,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-req-001",
            },
            cookies=actors["owner"],
        )
        assert replay.status_code == 200 and replay.json()["id"] == rid

        denied = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={"providerRef": "bank-123"},
            cookies=actors["owner"],
        )
        assert denied.status_code == 403, denied.text

        confirmed = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={"providerRef": "bank-123"},
            cookies=actors["admin"],
        )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["data"]["status"] == "confirmed"

        again = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={"providerRef": "bank-123"},
            cookies=actors["admin"],
        )
        assert again.status_code == 200
        credits = [
            r for r in _wallet_rows_for(actors, actors["owner_id"])
            if str(r.get("idempotencyKey") or "") == f"payreq:{rid}"
        ]
        assert len(credits) == 1, credits
        assert credits[0]["amountMinor"] == 5000

    def test_payment_request_cancel_rules(self, actors):
        created = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 2000,
                "currency": "USD",
                "method": "yusr_pay_qr",
                "idempotencyKey": "studio-pay-req-002",
            },
            cookies=actors["owner"],
        )
        rid = created.json()["id"]
        foreign = client.post(
            f"/api/wallet/payment-requests/{rid}/cancel", cookies=actors["other"]
        )
        assert foreign.status_code == 404, foreign.text  # no existence oracle
        canceled = client.post(
            f"/api/wallet/payment-requests/{rid}/cancel", cookies=actors["owner"]
        )
        assert canceled.status_code == 200
        assert canceled.json()["data"]["status"] == "canceled"
        confirm_after = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={},
            cookies=actors["admin"],
        )
        assert confirm_after.status_code == 409, confirm_after.text

        pending_list = client.get(
            "/api/wallet/payment-requests?scope=pending", cookies=actors["owner"]
        )
        assert pending_list.status_code == 403
        own_list = client.get("/api/wallet/payment-requests", cookies=actors["owner"])
        assert own_list.status_code == 200
        assert all(
            str(r["data"].get("userId")) == actors["owner_id"]
            for r in own_list.json()["requests"]
        )

    def test_submitted_budget_is_held_and_protected_from_other_debits(self, actors):
        user, cookies = _fresh_funded_customer(actors, "hold", 2500)
        first = _create_campaign(cookies, _complete_campaign("Hold A"), "wallet_hold_a")
        assert first.status_code == 200, first.text
        submitted = _submit_campaign(
            cookies, "wallet_hold_a", first.json()["lastModified"], "wallet-hold-a-01"
        )
        assert submitted.status_code == 200, submitted.text

        second = _create_campaign(cookies, _complete_campaign("Hold B"), "wallet_hold_b")
        assert second.status_code == 200
        blocked = _submit_campaign(
            cookies, "wallet_hold_b", second.json()["lastModified"], "wallet-hold-b-01"
        )
        assert blocked.status_code == 409, blocked.text
        assert "wallet" in blocked.json()["detail"].lower()

        # The held money cannot leave through a transfer either.
        drained = client.post(
            "/api/wallet/transfers",
            json={
                "toUserId": actors["other_id"],
                "amountMinor": 1,
                "currency": "USD",
                "idempotencyKey": "wallet-hold-drain-01",
            },
            cookies=cookies,
        )
        assert drained.status_code == 409, drained.text

        # Rejecting releases the hold; the second campaign can then submit.
        rejected = _review_campaign(
            actors, "wallet_hold_a", submitted.json()["lastModified"],
            "Rejected", "wallet-hold-reject-01", note="No budget this month",
        )
        assert rejected.status_code == 200, rejected.text
        retry = _submit_campaign(
            cookies, "wallet_hold_b", second.json()["lastModified"], "wallet-hold-b-02"
        )
        assert retry.status_code == 200, retry.text

    def test_approval_captures_the_budget_exactly_once(self, actors):
        user, cookies = _fresh_funded_customer(actors, "capture", 2500)
        created = _create_campaign(cookies, _complete_campaign("Capture"), "wallet_capture_a")
        assert created.status_code == 200
        submitted = _submit_campaign(
            cookies, "wallet_capture_a", created.json()["lastModified"], "wallet-capture-01"
        )
        assert submitted.status_code == 200, submitted.text
        approved = _review_campaign(
            actors, "wallet_capture_a", submitted.json()["lastModified"],
            "Approved", "wallet-approve-01",
        )
        assert approved.status_code == 200, approved.text
        stored = approved.json()["data"]
        assert stored["paidMinorUSD"] == 2500
        assert stored["paymentTransactionId"]

        replay = _review_campaign(
            actors, "wallet_capture_a", submitted.json()["lastModified"],
            "Approved", "wallet-approve-01",
        )
        assert replay.status_code == 200
        payments = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment"
        ]
        assert len(payments) == 1, payments
        assert payments[0]["amountMinor"] == 2500

        # The wallet is empty now: nothing else can be submitted.
        third = _create_campaign(cookies, _complete_campaign("Broke"), "wallet_capture_b")
        assert third.status_code == 200
        broke = _submit_campaign(
            cookies, "wallet_capture_b", third.json()["lastModified"], "wallet-capture-02"
        )
        assert broke.status_code == 409, broke.text

    def test_capture_key_is_scoped_per_submission_cycle(self, actors):
        # Reject → edit budget → resubmit → approve must capture the NEW
        # budget as a NEW payment, never replay the first cycle's key.
        user, cookies = _fresh_funded_customer(actors, "cycle", 10_000)
        created = _create_campaign(cookies, _complete_campaign("Cycle"), "wallet_cycle_a")
        assert created.status_code == 200
        submitted = _submit_campaign(
            cookies, "wallet_cycle_a", created.json()["lastModified"], "wallet-cycle-01"
        )
        assert submitted.status_code == 200, submitted.text
        rejected = _review_campaign(
            actors, "wallet_cycle_a", submitted.json()["lastModified"],
            "Rejected", "wallet-cycle-reject-01", note="Change the budget",
        )
        assert rejected.status_code == 200, rejected.text

        # A rejected campaign cannot be resubmitted; edit a fresh draft copy
        # with a different budget for the second cycle.
        second = dict(_complete_campaign("Cycle 2"))
        second["budgetMinorUSD"] = 4000
        created2 = _create_campaign(cookies, second, "wallet_cycle_b")
        assert created2.status_code == 200
        submitted2 = _submit_campaign(
            cookies, "wallet_cycle_b", created2.json()["lastModified"], "wallet-cycle-02"
        )
        assert submitted2.status_code == 200, submitted2.text
        approved = _review_campaign(
            actors, "wallet_cycle_b", submitted2.json()["lastModified"],
            "Approved", "wallet-cycle-approve-01",
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["data"]["paidMinorUSD"] == 4000
        payments = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment"
        ]
        assert len(payments) == 1 and payments[0]["amountMinor"] == 4000, payments
        # No refund rows exist: the reject found no orphan capture to release.
        releases = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment_release"
        ]
        assert releases == [], releases

    def test_create_replay_is_owner_and_shape_checked(self, actors):
        first = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 3000,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-shared-key-01",
            },
            cookies=actors["owner"],
        )
        assert first.status_code == 200, first.text
        # Same key, DIFFERENT user: must not leak the owner's request.
        stolen = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 3000,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-shared-key-01",
            },
            cookies=actors["other"],
        )
        assert stolen.status_code == 409, stolen.text
        # Same key, same user, different amount: refused, not replayed.
        reshaped = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 9999,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-shared-key-01",
            },
            cookies=actors["owner"],
        )
        assert reshaped.status_code == 409, reshaped.text

    def test_cancel_refused_once_the_payment_credit_exists(self, actors):
        created = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 1500,
                "currency": "USD",
                "method": "adfali",
                "idempotencyKey": "studio-pay-req-cancelrace",
            },
            cookies=actors["owner"],
        )
        rid = created.json()["id"]
        confirmed = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={},
            cookies=actors["admin"],
        )
        assert confirmed.status_code == 200
        # Money arrived: the request can never be canceled afterwards.
        canceled = client.post(
            f"/api/wallet/payment-requests/{rid}/cancel", cookies=actors["owner"]
        )
        assert canceled.status_code == 409, canceled.text

    def test_bank_transfer_needs_receipt_photo_before_confirm(self, actors):
        # Bank transfers confirm only after the customer attaches the
        # transfer receipt (or the admin explicitly overrides).
        created = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 4000,
                "currency": "USD",
                "method": "bank_transfer",
                "idempotencyKey": "studio-pay-receipt-001",
            },
            cookies=actors["owner"],
        )
        assert created.status_code == 200, created.text
        rid = created.json()["id"]

        blocked = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={},
            cookies=actors["admin"],
        )
        assert blocked.status_code == 409, blocked.text
        assert "receipt" in blocked.json()["detail"].lower()

        # A stranger cannot attach; the owner can.
        foreign = client.post(
            f"/api/wallet/payment-requests/{rid}/receipt",
            json={"photo": VALID_PNG_DATA_URL},
            cookies=actors["other"],
        )
        assert foreign.status_code == 404, foreign.text  # no existence oracle
        attached = client.post(
            f"/api/wallet/payment-requests/{rid}/receipt",
            json={"photo": VALID_PNG_DATA_URL, "note": "paid from Jumhouria acc"},
            cookies=actors["owner"],
        )
        assert attached.status_code == 200, attached.text
        lean = attached.json()["data"]
        assert "receiptPhoto" not in lean and lean.get("_photoCount") == 1, lean

        # Lists stay lean; the dedicated GET hydrates for owner/admin only.
        listed = client.get("/api/wallet/payment-requests", cookies=actors["owner"]).json()["requests"]
        mine = next(r for r in listed if r["id"] == rid)
        assert "receiptPhoto" not in mine["data"], mine
        full = client.get(f"/api/wallet/payment-requests/{rid}", cookies=actors["admin"])
        assert full.status_code == 200 and full.json()["data"]["receiptPhoto"].startswith("data:image/")
        hidden = client.get(f"/api/wallet/payment-requests/{rid}", cookies=actors["other"])
        assert hidden.status_code == 404, hidden.text

        confirmed = client.post(
            f"/api/wallet/payment-requests/{rid}/confirm",
            json={},
            cookies=actors["admin"],
        )
        assert confirmed.status_code == 200, confirmed.text

        # Override path: a second bank transfer confirmed without a photo.
        second = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 1000,
                "currency": "USD",
                "method": "bank_transfer",
                "idempotencyKey": "studio-pay-receipt-002",
            },
            cookies=actors["owner"],
        )
        overridden = client.post(
            f"/api/wallet/payment-requests/{second.json()['id']}/confirm",
            json={"overrideMissingReceipt": True},
            cookies=actors["admin"],
        )
        assert overridden.status_code == 200, overridden.text

    def test_payment_methods_catalog_is_served_with_rate(self, actors):
        response = client.get("/api/wallet/payment-requests/methods", cookies=actors["owner"])
        assert response.status_code == 200, response.text
        payload = response.json()
        ids = [m["id"] for m in payload["methods"]]
        assert "adfali" in ids and "bank_transfer" in ids and "yusr_pay_qr" in ids
        assert "card" not in ids and "qr" not in ids  # legacy ids retired
        for m in payload["methods"]:
            assert m["name"]["ar"] and m["name"]["en"] and "webhook" not in m

    def test_generic_routes_cannot_touch_payment_requests(self, actors):
        created = client.post(
            "/api/collections/walletPaymentRequests",
            json={"id": "forged_payment_request", "data": {"status": "confirmed"}},
            cookies=actors["admin"],
        )
        assert created.status_code == 405, created.text
        patched = client.patch(
            "/api/collections/walletPaymentRequests/anything",
            json={"data": {"status": "confirmed"}},
            cookies=actors["admin"],
        )
        assert patched.status_code == 405, patched.text
        deleted = client.delete(
            "/api/collections/walletPaymentRequests/anything",
            cookies=actors["admin"],
        )
        assert deleted.status_code == 405, deleted.text


def _stop_campaign(cookies, campaign_id: str, last_modified: int, op: str,
                   reason: str | None = None, refund: int | None = None):
    body: dict = {"expectedLastModified": last_modified, "operationId": op}
    if reason is not None:
        body["reason"] = reason
    if refund is not None:
        body["refundMinorUSD"] = refund
    return client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/stop", json=body, cookies=cookies
    )


def _publish_status(cookies, campaign_id: str, last_modified: int, op: str,
                    value: str, meta_id: str | None = None):
    body: dict = {
        "expectedLastModified": last_modified,
        "operationId": op,
        "publishStatus": value,
    }
    if meta_id is not None:
        body["metaCampaignId"] = meta_id
    return client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/publish-status",
        json=body,
        cookies=cookies,
    )


def _balance_minor(actors, user_id: str) -> int:
    total = 0
    for row in _wallet_rows_for(actors, user_id):
        amount = int(row.get("amountMinor") or 0)
        if str(row.get("toUserId") or "") == user_id:
            total += amount
        if str(row.get("fromUserId") or "") == user_id:
            total -= amount
    return total


def _approved_campaign(actors, cookies, tag: str, budget: int = 2500) -> dict:
    """create → submit → approve; returns the approve response entity."""
    body = dict(_complete_campaign(f"Stop {tag}"))
    body["budgetMinorUSD"] = budget
    created = _create_campaign(cookies, body, f"stop_{tag}")
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(
        cookies, f"stop_{tag}", created.json()["lastModified"], f"stop-submit-{tag}"
    )
    assert submitted.status_code == 200, submitted.text
    approved = _review_campaign(
        actors, f"stop_{tag}", submitted.json()["lastModified"],
        "Approved", f"stop-approve-{tag}",
    )
    assert approved.status_code == 200, approved.text
    return approved.json()


class TestStudioStopRefund:
    """Stop-with-refund: the third money door must open at most once."""

    def test_stop_refunds_full_budget_exactly_once(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopfull", 2500)
        approved = _approved_campaign(actors, cookies, "full", 2500)
        cid = approved["id"]
        assert _balance_minor(actors, user["id"]) == 0

        stopped = _stop_campaign(
            cookies, cid, approved["lastModified"], "stop-full-op-01", reason="Changed my plans"
        )
        assert stopped.status_code == 200, stopped.text
        data = stopped.json()["data"]
        assert data["status"] == "Stopped"
        assert data["refundMinorUSD"] == 2500
        assert data["spendMinorUSD"] == 0
        assert data["refundTransactionId"]
        assert _balance_minor(actors, user["id"]) == 2500

        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert len(refunds) == 1, refunds
        assert refunds[0]["referenceId"] == approved["data"]["paymentTransactionId"]

        # Lost-response replay: same operationId returns the committed state.
        replay = _stop_campaign(
            cookies, cid, approved["lastModified"], "stop-full-op-01"
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["data"]["status"] == "Stopped"
        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert len(refunds) == 1, refunds

        # A NEW stop attempt is a conflict: the campaign already left Approved.
        again = _stop_campaign(
            cookies, cid, stopped.json()["lastModified"], "stop-full-op-02"
        )
        assert again.status_code == 409, again.text

        # Stopped campaigns are visible to the reviewer like other decided ones.
        reviewer_list = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["reviewer"]
        )
        assert reviewer_list.status_code == 200
        rows = reviewer_list.json()
        rows = rows if isinstance(rows, list) else rows.get("items") or []
        assert any(
            r.get("id") == cid and (r.get("data") or {}).get("status") == "Stopped"
            for r in rows
        ), "reviewer should see the Stopped campaign"

        # The refunded money is immediately spendable on a fresh campaign.
        fresh = _approved_campaign(actors, cookies, "fullagain", 2500)
        assert fresh["data"]["paidMinorUSD"] == 2500
        assert _balance_minor(actors, user["id"]) == 0

    def test_stop_is_atomic_with_status_write(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopatomic", 2500)
        approved = _approved_campaign(actors, cookies, "atomic", 2500)
        wrong = _stop_campaign(
            cookies, approved["id"], approved["lastModified"] + 5, "stop-atomic-op-01"
        )
        assert wrong.status_code == 409, wrong.text
        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert refunds == [], "a failed stop must not leave a refund row"
        assert _balance_minor(actors, user["id"]) == 0

    def test_stop_authorization(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopauth", 2500)
        approved = _approved_campaign(actors, cookies, "auth", 2500)
        cid = approved["id"]

        foreign = _stop_campaign(
            actors["other"], cid, approved["lastModified"], "stop-auth-foreign-01"
        )
        assert foreign.status_code == 403, foreign.text
        unsubscribed = _stop_campaign(
            actors["unsubscribed"], cid, approved["lastModified"], "stop-auth-unsub-01"
        )
        assert unsubscribed.status_code == 403, unsubscribed.text
        # Choosing the refund amount is a staff decision, never the customer's.
        partial = _stop_campaign(
            cookies, cid, approved["lastModified"], "stop-auth-partial-01", refund=100
        )
        assert partial.status_code == 403, partial.text

        # Staff (reviewer) can stop with an explicit partial refund.
        staff = _stop_campaign(
            actors["reviewer"], cid, approved["lastModified"],
            "stop-auth-staff-01", reason="Customer asked by phone", refund=1500,
        )
        assert staff.status_code == 200, staff.text
        data = staff.json()["data"]
        assert data["refundMinorUSD"] == 1500
        assert data["spendMinorUSD"] == 1000
        assert _balance_minor(actors, user["id"]) == 1500

    def test_owner_stop_blocked_once_started_or_marked_live(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stoplive", 6000)
        approved = _approved_campaign(actors, cookies, "live", 2500)
        cid = approved["id"]

        # Only staff can mark a launch; only Approved campaigns take the marker.
        denied = _publish_status(
            cookies, cid, approved["lastModified"], "publish-owner-01", "live"
        )
        assert denied.status_code == 403, denied.text
        marked = _publish_status(
            actors["reviewer"], cid, approved["lastModified"],
            "publish-staff-01", "live", meta_id="123456789",
        )
        assert marked.status_code == 200, marked.text
        assert marked.json()["data"]["publishStatus"] == "live"
        assert marked.json()["data"]["metaCampaignId"] == "123456789"
        replayed = _publish_status(
            actors["reviewer"], cid, approved["lastModified"],
            "publish-staff-01", "live", meta_id="123456789",
        )
        assert replayed.status_code == 200, replayed.text
        # Same operationId with a DIFFERENT Meta id is not a replay.
        remixed = _publish_status(
            actors["reviewer"], cid, approved["lastModified"],
            "publish-staff-01", "live", meta_id="987654321",
        )
        assert remixed.status_code == 409, remixed.text

        # The owner's instant stop is now blocked; staff handles the refund.
        blocked = _stop_campaign(
            cookies, cid, marked.json()["lastModified"], "stop-live-owner-01"
        )
        assert blocked.status_code == 409, blocked.text
        too_big = _stop_campaign(
            actors["reviewer"], cid, marked.json()["lastModified"],
            "stop-live-staff-01", refund=2501,
        )
        assert too_big.status_code == 400, too_big.text
        partial = _stop_campaign(
            actors["reviewer"], cid, marked.json()["lastModified"],
            "stop-live-staff-02", refund=1000,
        )
        assert partial.status_code == 200, partial.text
        assert partial.json()["data"]["spendMinorUSD"] == 1500
        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert len(refunds) == 1 and refunds[0]["amountMinor"] == 1000

        # A zero refund records the stop without writing any wallet row.
        approved2 = _approved_campaign(actors, cookies, "livezero", 2500)
        zero = _stop_campaign(
            actors["reviewer"], approved2["id"], approved2["lastModified"],
            "stop-live-staff-03", refund=0,
        )
        assert zero.status_code == 200, zero.text
        assert zero.json()["data"]["status"] == "Stopped"
        assert zero.json()["data"]["refundTransactionId"] == ""
        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert len(refunds) == 1, "refund=0 must not add a wallet row"

        # A campaign whose start date has arrived is no longer owner-stoppable.
        approved3 = _approved_campaign(actors, cookies, "livestarted", 1000)
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json FROM entities "
                    "WHERE type='adCampaignRequests' AND id=:id"
                ),
                {"id": approved3["id"]},
            ).mappings().first()
            aged = json_loads(row["data_json"]) or {}
            aged["startDate"] = "2020-01-01"
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:d "
                    "WHERE type='adCampaignRequests' AND id=:id"
                ),
                {"d": json_dumps(aged), "id": approved3["id"]},
            )
        started = _stop_campaign(
            cookies, approved3["id"], approved3["lastModified"], "stop-live-owner-02"
        )
        assert started.status_code == 409, started.text

    def test_stop_only_from_approved_and_orphans_stay_single_door(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopstates", 5000)
        draft = _create_campaign(cookies, _complete_campaign("Stop Draft"), "stop_state_draft")
        assert draft.status_code == 200
        as_draft = _stop_campaign(
            cookies, "stop_state_draft", draft.json()["lastModified"], "stop-state-op-01"
        )
        assert as_draft.status_code == 409, as_draft.text

        submitted = _submit_campaign(
            cookies, "stop_state_draft", draft.json()["lastModified"], "stop-state-submit-01"
        )
        assert submitted.status_code == 200
        as_submitted = _stop_campaign(
            cookies, "stop_state_draft", submitted.json()["lastModified"], "stop-state-op-02"
        )
        assert as_submitted.status_code == 409, as_submitted.text

        # Fake a crashed approval: the cpay row exists, status is Submitted.
        submitted_at = str(submitted.json()["data"]["submittedAt"])
        orphan_tx = new_id("tx")
        with db_conn() as conn:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('walletTransactions',:id,:d,false,:now,:uid,:now)"
                ),
                {
                    "id": orphan_tx,
                    "d": json_dumps({
                        "type": "campaign_payment",
                        "schemaVersion": 2,
                        "amountMinor": 2500,
                        "amount": 25.0,
                        "currency": "USD",
                        "fromUserId": user["id"],
                        "toUserId": "system",
                        "memo": "Ad campaign budget stop_state_draft",
                        "idempotencyKey": f"cpay:stop_state_draft:{submitted_at}",
                        "status": "posted",
                        "referenceType": "adCampaignRequest",
                        "referenceId": "stop_state_draft",
                        "createdAt": submitted_at,
                    }),
                    "now": now_ms(),
                    "uid": user["id"],
                },
            )
        rejected = _review_campaign(
            actors, "stop_state_draft", submitted.json()["lastModified"],
            "Rejected", "stop-state-reject-01", note="Not this month",
        )
        assert rejected.status_code == 200, rejected.text
        releases = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment_release"
        ]
        assert len(releases) == 1 and releases[0]["amountMinor"] == 2500

        as_rejected = _stop_campaign(
            cookies, "stop_state_draft", rejected.json()["lastModified"], "stop-state-op-03"
        )
        assert as_rejected.status_code == 409, as_rejected.text
        refunds = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_refund"
        ]
        assert refunds == [], "released money must never also be stop-refunded"

    def test_stopped_is_terminal_and_archive_safe(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopterm", 2500)
        approved = _approved_campaign(actors, cookies, "term", 2500)
        cid = approved["id"]
        stopped = _stop_campaign(
            cookies, cid, approved["lastModified"], "stop-term-op-01"
        )
        assert stopped.status_code == 200, stopped.text
        lm = stopped.json()["lastModified"]

        edited = client.patch(
            f"/api/collections/adCampaignRequests/{cid}",
            json={"data": {"headline": "Sneaky edit"}, "expectedLastModified": lm},
            cookies=cookies,
        )
        assert edited.status_code == 409, edited.text
        resubmitted = _submit_campaign(cookies, cid, lm, "stop-term-submit-01")
        assert resubmitted.status_code == 409, resubmitted.text
        reviewed = _review_campaign(actors, cid, lm, "Approved", "stop-term-review-01")
        assert reviewed.status_code == 409, reviewed.text

        rows_before = len(_wallet_rows_for(actors, user["id"]))
        archived = client.delete(
            f"/api/collections/adCampaignRequests/{cid}", cookies=cookies
        )
        assert archived.status_code == 200, archived.text
        assert len(_wallet_rows_for(actors, user["id"])) == rows_before, (
            "archiving a Stopped campaign must not move money"
        )

    def test_generic_routes_cannot_fake_stop_or_boost_workflow(self, actors):
        user, cookies = _fresh_funded_customer(actors, "stopforge", 0)
        created = _create_campaign(
            cookies, _complete_campaign("Forge Stop"), "stop_forge_a"
        )
        assert created.status_code == 200
        lm = created.json()["lastModified"]
        for payload in (
            {"status": "Stopped"},
            {"refundMinorUSD": 1},
            {"refundTransactionId": "tx_fake"},
            {"publishStatus": "live"},
            {"stoppedBy": user["id"]},
        ):
            forged = client.patch(
                f"/api/collections/adCampaignRequests/stop_forge_a",
                json={"data": payload, "expectedLastModified": lm},
                cookies=cookies,
            )
            assert forged.status_code == 403, (payload, forged.text)

        seeded = client.post(
            "/api/collections/adCampaignRequests",
            json={
                "id": "stop_forge_b",
                "data": {
                    **_complete_campaign("Forge Create"),
                    "status": "Stopped",
                    "refundMinorUSD": 999,
                    "publishStatus": "live",
                },
            },
            cookies=cookies,
        )
        assert seeded.status_code == 200, seeded.text
        seeded_data = seeded.json()["data"]
        assert seeded_data["status"] == "Draft"
        assert "refundMinorUSD" not in seeded_data
        assert "publishStatus" not in seeded_data


class TestAdsStudioBoostFields:
    """Boost Post / Boost Page customer fields ride the untouched money engine."""

    def test_boost_fields_are_strictly_validated(self, actors):
        base = _complete_campaign("Boost Validation")
        for bad in (
            {"boostType": "mega_boost"},
            {"sourcePostRef": "http://facebook.com/p/1"},
            {"sourcePostRef": "https://evil-facebook.com/p/1"},
            {"sourcePostRef": "https://user:pw@facebook.com/p/1"},
            {"sourcePostRef": "https://phish.example/facebook.com"},
            # Percent-encoded host tricks must fail the host-charset rule.
            {"sourcePostRef": "https://facebook.com%2f.instagram.com/evil"},
            {"sourcePostRef": "https://facebook.com%00.instagram.com/evil"},
            {"sourcePostRef": "https://a%2eb.facebook.com/post/1"},
            {"autoReply": "yes"},
            {"extendsCampaignId": "../../etc/passwd"},
        ):
            attempt = _create_campaign(
                actors["owner"], {**base, **bad}, f"boost_bad_{new_id('c')[:12]}"
            )
            assert attempt.status_code == 400, (bad, attempt.text)

    def test_boost_post_requires_source_and_flows_through_capture(self, actors):
        user, cookies = _fresh_funded_customer(actors, "boostflow", 2500)
        incomplete = dict(_complete_campaign("Boost Missing Source"))
        incomplete["boostType"] = "boost_post"
        created = _create_campaign(cookies, incomplete, "boost_flow_a")
        assert created.status_code == 200, created.text
        blocked = _submit_campaign(
            cookies, "boost_flow_a", created.json()["lastModified"], "boost-flow-submit-01"
        )
        assert blocked.status_code == 400, blocked.text
        assert "sourcePostRef" in blocked.json()["detail"]

        complete = dict(_complete_campaign("Boost Complete"))
        complete.update(
            {
                "boostType": "boost_post",
                "sourcePostRef": "https://www.facebook.com/mypage/posts/12345",
                "autoReply": True,
            }
        )
        created2 = _create_campaign(cookies, complete, "boost_flow_b")
        assert created2.status_code == 200, created2.text
        submitted = _submit_campaign(
            cookies, "boost_flow_b", created2.json()["lastModified"], "boost-flow-submit-02"
        )
        assert submitted.status_code == 200, submitted.text
        approved = _review_campaign(
            actors, "boost_flow_b", submitted.json()["lastModified"],
            "Approved", "boost-flow-approve-01",
        )
        assert approved.status_code == 200, approved.text
        data = approved.json()["data"]
        assert data["boostType"] == "boost_post"
        assert data["sourcePostRef"] == "https://www.facebook.com/mypage/posts/12345"
        assert data["autoReply"] is True
        assert data["paidMinorUSD"] == 2500
        payments = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment"
        ]
        assert len(payments) == 1 and payments[0]["amountMinor"] == 2500


class TestStopRefundReviewFindings:
    """Regression pins for the adversarial-review findings on stop-refund."""

    def test_admin_reversal_of_campaign_rows_is_refused(self, actors):
        user, cookies = _fresh_funded_customer(actors, "revguard", 2500)
        approved = _approved_campaign(actors, cookies, "revguard", 2500)
        cpay_tx = str(approved["data"]["paymentTransactionId"])
        reversed_ = client.post(
            "/api/wallet/reversals",
            json={"transactionId": cpay_tx, "memo": "manual correction"},
            cookies=actors["admin"],
        )
        assert reversed_.status_code == 409, reversed_.text
        # The single legitimate door still works after the refusal.
        stopped = _stop_campaign(
            cookies, approved["id"], approved["lastModified"], "revguard-stop-01"
        )
        assert stopped.status_code == 200, stopped.text
        assert _balance_minor(actors, user["id"]) == 2500
        refund_tx = str(stopped.json()["data"]["refundTransactionId"])
        re_reversed = client.post(
            "/api/wallet/reversals",
            json={"transactionId": refund_tx},
            cookies=actors["admin"],
        )
        assert re_reversed.status_code == 409, re_reversed.text

    def test_stop_probe_on_private_draft_is_404_for_staff(self, actors):
        draft = _create_campaign(
            actors["owner"], _complete_campaign("Private Draft Probe"), "stop_probe_draft"
        )
        assert draft.status_code == 200
        lm = draft.json()["lastModified"]
        probe = _stop_campaign(actors["reviewer"], "stop_probe_draft", lm, "probe-stop-op-01")
        assert probe.status_code == 404, probe.text  # not a 409 status oracle
        publish_probe = _publish_status(
            actors["reviewer"], "stop_probe_draft", lm, "probe-publish-op-01", "live"
        )
        assert publish_probe.status_code == 404, publish_probe.text
        missing = _stop_campaign(actors["reviewer"], "stop_probe_missing", 0, "probe-stop-op-02")
        assert missing.status_code == 404
        # The owner still gets the honest 409 about their own draft.
        own = _stop_campaign(actors["owner"], "stop_probe_draft", lm, "probe-stop-op-03")
        assert own.status_code == 409, own.text

    def test_review_replay_recovers_crashed_release(self, actors):
        user, cookies = _fresh_funded_customer(actors, "replayrel", 2500)
        created = _create_campaign(cookies, _complete_campaign("Replay Release"), "replay_release_a")
        assert created.status_code == 200
        submitted = _submit_campaign(
            cookies, "replay_release_a", created.json()["lastModified"], "replayrel-submit-01"
        )
        assert submitted.status_code == 200
        rejected = _review_campaign(
            actors, "replay_release_a", submitted.json()["lastModified"],
            "Rejected", "replayrel-reject-01", note="Not now",
        )
        assert rejected.status_code == 200, rejected.text
        # Simulate the crash window: a capture exists for the rejected cycle
        # but its release never ran (process died between the transactions).
        submitted_at = str(submitted.json()["data"]["submittedAt"])
        orphan_tx = new_id("tx")
        with db_conn() as conn:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('walletTransactions',:id,:d,false,:now,:uid,:now)"
                ),
                {
                    "id": orphan_tx,
                    "d": json_dumps({
                        "type": "campaign_payment",
                        "schemaVersion": 2,
                        "amountMinor": 2500,
                        "amount": 25.0,
                        "currency": "USD",
                        "fromUserId": user["id"],
                        "toUserId": "system",
                        "memo": "Ad campaign budget replay_release_a",
                        "idempotencyKey": f"cpay:replay_release_a:{submitted_at}",
                        "status": "posted",
                        "referenceType": "adCampaignRequest",
                        "referenceId": "replay_release_a",
                        "createdAt": submitted_at,
                    }),
                    "now": now_ms(),
                    "uid": user["id"],
                },
            )
        # The client retry replays the SAME reject — the fix releases the
        # stranded capture with the replayed response.
        replay = _review_campaign(
            actors, "replay_release_a", submitted.json()["lastModified"],
            "Rejected", "replayrel-reject-01", note="Not now",
        )
        assert replay.status_code == 200, replay.text
        releases = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment_release"
        ]
        assert len(releases) == 1 and releases[0]["amountMinor"] == 2500
        # A second replay must not release twice.
        again = _review_campaign(
            actors, "replay_release_a", submitted.json()["lastModified"],
            "Rejected", "replayrel-reject-01", note="Not now",
        )
        assert again.status_code == 200
        releases = [
            r for r in _wallet_rows_for(actors, user["id"])
            if str(r.get("type") or "") == "campaign_payment_release"
        ]
        assert len(releases) == 1

    def test_reviewer_cannot_choose_refund_for_own_campaign(self, actors):
        email = "ad-studio-revowner@tests.albayanhub.com"
        password = "AdStudioRevOwner123!"
        perms = {"adCampaignRequests": CUSTOMER_PERMISSIONS["adCampaignRequests"] + ["review"]}
        user = _create_user(actors["admin"], email, password, perms)
        cookies = _login(email, password)
        _subscribe(cookies, "revowner")
        funded = client.post(
            "/api/wallet/top-ups",
            json={
                "userId": user["id"],
                "amountMinor": 2500,
                "currency": "USD",
                "idempotencyKey": "wallet-fund-revowner",
            },
            cookies=actors["admin"],
        )
        assert funded.status_code == 200
        created = _create_campaign(cookies, _complete_campaign("Reviewer Own"), "rev_own_a")
        assert created.status_code == 200
        submitted = _submit_campaign(
            cookies, "rev_own_a", created.json()["lastModified"], "revown-submit-01"
        )
        assert submitted.status_code == 200
        approved = _review_campaign(
            actors, "rev_own_a", submitted.json()["lastModified"],
            "Approved", "revown-approve-01",
        )
        assert approved.status_code == 200, approved.text
        # Nobody chooses their own refund amount, review permission or not.
        self_partial = _stop_campaign(
            cookies, "rev_own_a", approved.json()["lastModified"],
            "revown-stop-01", refund=100,
        )
        assert self_partial.status_code == 403, self_partial.text
        # The customer path still works for them (future start, full refund).
        self_stop = _stop_campaign(
            cookies, "rev_own_a", approved.json()["lastModified"], "revown-stop-02"
        )
        assert self_stop.status_code == 200, self_stop.text
        assert self_stop.json()["data"]["refundMinorUSD"] == 2500

    def test_owner_stop_survives_lapsed_subscription(self, actors):
        user, cookies = _fresh_funded_customer(actors, "lapsed", 2500)
        approved = _approved_campaign(actors, cookies, "lapsed", 2500)
        with db_conn() as conn:
            rows = conn.execute(
                text("SELECT id, data_json FROM entities WHERE type='serviceSubscriptions' AND deleted=false")
            ).mappings().all()
            for row in rows:
                data = json_loads(row["data_json"]) or {}
                if str(data.get("userId") or "") == user["id"]:
                    data["status"] = "canceled"
                    conn.execute(
                        text("UPDATE entities SET data_json=:d WHERE type='serviceSubscriptions' AND id=:id"),
                        {"d": json_dumps(data), "id": row["id"]},
                    )
        # Their subscription lapsed, but stopping only returns their money.
        stopped = _stop_campaign(
            cookies, approved["id"], approved["lastModified"], "lapsed-stop-01"
        )
        assert stopped.status_code == 200, stopped.text
        assert _balance_minor(actors, user["id"]) == 2500
