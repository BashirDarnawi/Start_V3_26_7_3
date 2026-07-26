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

from server.db import db_conn, init_db, json_dumps, now_ms
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
        "viewOwn", "add", "editOwn", "deleteOwn", "submitOwn",
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
        listing = client.get(
            "/api/collections/adCampaignRequests", cookies=actors["unsubscribed"]
        )
        assert listing.status_code == 403
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
