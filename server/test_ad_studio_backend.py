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


class TestAdsStudioViewOnlyStaffPrivacy:
    """A staff account with plain .view (no .review) must not read drafts.

    The privacy scope used to switch on only for holders of the review
    permission, so a view-only employee skipped it entirely and read every
    customer's private Draft.
    """

    def test_view_without_review_cannot_see_private_drafts(self, actors):
        email = "ad-studio-viewonly@tests.albayanhub.com"
        password = "AdStudioViewOnly123!"
        _create_user(actors["admin"], email, password, {"adCampaignRequests": ["view"]})
        viewer = _login(email, password)

        draft = _create_campaign(
            actors["owner"], _complete_campaign("Private Draft vs viewer"), "ad_studio_viewonly_draft"
        )
        assert draft.status_code == 200, draft.text

        listed = client.get("/api/collections/adCampaignRequests", cookies=viewer)
        assert listed.status_code == 200, listed.text
        rows = listed.json()
        rows = rows if isinstance(rows, list) else rows.get("items") or []
        assert all(r.get("id") != "ad_studio_viewonly_draft" for r in rows), (
            "a view-only employee can see a customer's private draft"
        )
        direct = client.get(
            "/api/collections/adCampaignRequests/ad_studio_viewonly_draft", cookies=viewer
        )
        assert direct.status_code == 404, direct.text

        # Once submitted it becomes workflow-visible, exactly as before.
        submitted = _submit_campaign(
            actors["owner"], "ad_studio_viewonly_draft", draft.json()["lastModified"], "viewonly-submit-01"
        )
        assert submitted.status_code == 200, submitted.text
        listed = client.get("/api/collections/adCampaignRequests", cookies=viewer)
        rows = listed.json()
        rows = rows if isinstance(rows, list) else rows.get("items") or []
        assert any(r.get("id") == "ad_studio_viewonly_draft" for r in rows), (
            "submitted campaigns must stay visible to staff"
        )

    def test_owner_still_sees_their_own_draft(self, actors):
        own = _create_campaign(
            actors["owner"], _complete_campaign("Owner reads own draft"), "ad_studio_owner_reads"
        )
        assert own.status_code == 200
        listed = client.get("/api/collections/adCampaignRequests", cookies=actors["owner"])
        rows = listed.json()
        rows = rows if isinstance(rows, list) else rows.get("items") or []
        assert any(r.get("id") == "ad_studio_owner_reads" for r in rows), (
            "the customer lost sight of their own draft"
        )


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
        # 404, not 403: a private draft must not even confirm it exists to a
        # non-owner (the draft guard now keys on the record, so it fires for
        # every non-admin who is not the creator — not only for reviewers).
        assert other_get.status_code == 404, other_get.text

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
                "reviewReasonCode": "text_policy",
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
                "reviewReasonCode": "text_policy",
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
        original_prepare = main_module._prepare_ad_campaign_fields
        submit_operation = "submit-concurrent-operation-001"
        # Proof the simulated race really fired: the routes live in
        # ad_campaign_actions.py now and reach main's helpers through
        # late-bound ctx lambdas. An eager binding would skip these fakes and
        # the test would pass without ever exercising the race branch.
        fired = {"submit": 0, "review": 0}

        def identical_submit_commits_during_validation(*args, **kwargs):
            # Submit validates first, then locks and re-reads the row (P1-02):
            # an identical request that committed in between is adopted there.
            result = original_prepare(*args, **kwargs)
            if kwargs.get("strict") and not fired["submit"]:
                fired["submit"] += 1
                original_patch(
                    "adCampaignRequests", campaign_id,
                    {"status": "Submitted", "submittedAt": main_module._iso_utc(), "submittedBy": actors["owner_id"],
                     "lastSubmitOperationId": submit_operation, "schemaVersion": 2, "totalBudgetMinorUSD": 2500,
                     "legacyRules": False},
                    actors["owner_id"], enforce_ad_campaign_quota=False,
                )
            return result

        monkeypatch.setattr(main_module, "_prepare_ad_campaign_fields", identical_submit_commits_during_validation)
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
        assert fired["submit"] == 1, "the simulated submit race never fired"

        review_operation = "review-concurrent-operation-001"

        def commit_review_then_report_conflict(*args, **kwargs):
            result = original_patch(*args, **kwargs)
            updates = args[2] if len(args) > 2 else {}
            if updates.get("lastReviewOperationId") == review_operation:
                fired["review"] += 1
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
        assert fired["review"] == 1, "the simulated review conflict never fired"
        # The conflict branch adopts the identical winner's commit: it writes no
        # audit row of its own (the winner audits) and the budget is captured once.
        with db_conn() as conn:
            audit_actions = [
                str(r[0]) for r in conn.execute(
                    text("SELECT action FROM audit_logs WHERE resource_id = :id AND action IN ('submit','review')"),
                    {"id": campaign_id},
                )
            ]
        assert audit_actions == [], audit_actions
        captures = [
            r for r in _wallet_rows_for(actors, actors["owner_id"])
            if r.get("type") == "campaign_payment" and r.get("referenceId") == campaign_id
        ]
        assert len(captures) == 1, captures

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
                "reviewReasonCode": "text_policy",
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
                "reviewReasonCode": "text_policy",
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


def _review_campaign(actors, campaign_id: str, last_modified: int, decision: str, op: str, note: str = "",
                     reason: str = "other"):
    body = {"expectedLastModified": last_modified, "decision": decision, "note": note, "operationId": op}
    if decision != "Approved":
        body["reviewReasonCode"] = reason  # P1-12: a send-back or a reject names its reason
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json=body, cookies=actors["reviewer"])


class TestStudioWalletPayments:
    """The customer wallet: gateway-ready charges, holds, and captures."""

    @pytest.mark.parametrize("currency,other_currency", [("USD", "LYD"), ("LYD", "USD")])
    def test_payment_retry_keeps_currency_and_rejects_changed_instruction(self, actors, currency, other_currency):
        # Independent actors avoid sharing open-request limits or rate buckets
        # with the lifecycle tests. No gateway or real payment is contacted.
        email = f"wallet-currency-{currency.lower()}@tests.albayanhub.com"
        password = "WalletCurrencyTest123!"
        _create_user(actors["admin"], email, password, {})
        cookies = _login(email, password)
        request = {
            "amountMinor": 1000, "currency": currency, "method": "adfali",
            "idempotencyKey": f"wallet-currency-retry-{currency.lower()}",
        }
        created = client.post("/api/wallet/payment-requests", json=request, cookies=cookies)
        assert created.status_code == 200, created.text
        rid = created.json()["id"]
        exact = client.post("/api/wallet/payment-requests", json=request, cookies=cookies)
        assert exact.status_code == 200 and exact.json()["id"] == rid
        assert exact.json()["data"]["currency"] == currency
        changed = client.post(
            "/api/wallet/payment-requests",
            json={**request, "currency": other_currency}, cookies=cookies,
        )
        assert changed.status_code == 409, changed.text
        # Rejection must leave the original request intact and still usable.
        original = client.get(f"/api/wallet/payment-requests/{rid}", cookies=cookies)
        assert original.status_code == 200
        assert original.json()["data"]["currency"] == currency
        assert original.json()["data"]["amountMinor"] == 1000
        assert client.post(f"/api/wallet/payment-requests/{rid}/cancel", cookies=cookies).status_code == 200

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
                   reason: str | None = None, refund: int | None = None,
                   close_reason: str | None = None):
    body: dict = {"expectedLastModified": last_modified, "operationId": op}
    if reason is not None:
        body["reason"] = reason
    if refund is not None:
        body["refundMinorUSD"] = refund
    if close_reason is not None:
        body["closeReason"] = close_reason
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
        approved3 = _approved_campaign(actors, cookies, "livestarted", 1100)  # $1/day floor x 11 days (P1-15)
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


def _reset_reviewer_limits(actors) -> None:
    """Approvals share the reviewer's per-minute mutation and image-check budgets."""
    for kind in ("mutations", "media"):
        reset_rate_limit(f"ad-studio:{kind}:{actors['reviewer_id']}")


class TestStudioCloseReason:
    """P1-04: why a request reached Stopped, and finished requests leave the lists."""

    def test_close_reason_completed_staff_only(self, actors):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "closewhy", 7500)
        approved = _approved_campaign(actors, cookies, "closewhy", 2500)
        cid, lm = approved["id"], approved["lastModified"]

        # A customer cannot declare their own ad finished or staff-stopped.
        for index, reason in enumerate(("completed", "staff_stop")):
            refused = _stop_campaign(cookies, cid, lm, f"close-why-owner-0{index}", close_reason=reason)
            assert refused.status_code == 403, refused.text
            assert "Only staff can choose how a campaign closed" in refused.text
        unknown = _stop_campaign(cookies, cid, lm, "close-why-owner-09", close_reason="refunded")
        assert unknown.status_code in (400, 422), unknown.text
        still = client.get(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies)
        assert still.status_code == 200, still.text
        assert still.json()["data"]["status"] == "Approved"
        assert still.json()["lastModified"] == lm
        assert "closeReason" not in still.json()["data"]
        assert not [r for r in _wallet_rows_for(actors, user["id"]) if r.get("type") == "campaign_refund"]

        # The owner's own stop is always customer_stop, named or not.
        own = _stop_campaign(cookies, cid, lm, "close-why-owner-10", close_reason="customer_stop")
        assert own.status_code == 200, own.text
        assert own.json()["data"]["closeReason"] == "customer_stop"
        implicit = _approved_campaign(actors, cookies, "closewhyown", 2500)
        own_default = _stop_campaign(cookies, implicit["id"], implicit["lastModified"], "close-why-owner-11")
        assert own_default.status_code == 200, own_default.text
        assert own_default.json()["data"]["closeReason"] == "customer_stop"

        # Staff: staff_stop by default (completed is covered by the archive test).
        by_staff = _approved_campaign(actors, cookies, "closewhystaff", 2500)
        staff = _stop_campaign(
            actors["reviewer"], by_staff["id"], by_staff["lastModified"], "close-why-staff-01", refund=2500,
        )
        assert staff.status_code == 200, staff.text
        assert staff.json()["data"]["closeReason"] == "staff_stop"
        with db_conn() as conn:
            meta = conn.execute(
                text("SELECT metadata_json FROM audit_logs WHERE action = 'stop' AND resource_id = :id"),
                {"id": by_staff["id"]},
            ).scalar_one()
        assert json_loads(meta)["closeReason"] == "staff_stop"

        # The generic API can neither create nor forge it.
        draft = _create_campaign(
            cookies, {**_complete_campaign("Close forge"), "closeReason": "completed"}, "close_why_forge",
        )
        assert draft.status_code == 200, draft.text
        assert "closeReason" not in draft.json()["data"]
        forged = client.patch(
            "/api/collections/adCampaignRequests/close_why_forge",
            json={"data": {"closeReason": "completed"}, "expectedLastModified": draft.json()["lastModified"]},
            cookies=cookies,
        )
        assert forged.status_code == 403, forged.text

    def test_finished_request_can_be_archived(self, actors):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "finished", 2500)
        approved = _approved_campaign(actors, cookies, "finished", 2500)
        cid = approved["id"]
        live = _publish_status(
            actors["reviewer"], cid, approved["lastModified"], "finished-live-01", "live", meta_id="555000111",
        )
        assert live.status_code == 200, live.text
        lm = live.json()["lastModified"]

        # The ad ran: the owner can neither self-stop it nor archive it while the capture is open.
        assert _stop_campaign(cookies, cid, lm, "finished-owner-stop-01").status_code == 409
        blocked = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies)
        assert blocked.status_code == 409, blocked.text

        # Staff finish it: Meta used $20.00, the unused $5.00 comes back.
        finished = _stop_campaign(
            actors["reviewer"], cid, lm, "finished-staff-01", refund=500, close_reason="completed",
        )
        assert finished.status_code == 200, finished.text
        data = finished.json()["data"]
        assert data["status"] == "Stopped" and data["closeReason"] == "completed"
        assert data["refundMinorUSD"] == 500 and data["spendMinorUSD"] == 2000
        assert _balance_minor(actors, user["id"]) == 500
        replay = _stop_campaign(
            actors["reviewer"], cid, lm, "finished-staff-01", refund=500, close_reason="completed",
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["lastModified"] == finished.json()["lastModified"]

        # The owner archives the finished request; the money history stays as it was.
        ledger_before = _wallet_rows_for(actors, user["id"])
        archived = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies)
        assert archived.status_code == 200, archived.text
        assert client.get(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies).status_code == 404
        listed = client.get("/api/collections/adCampaignRequests", cookies=cookies)
        assert listed.status_code == 200, listed.text
        assert all(row["id"] != cid for row in listed.json())
        ledger_after = _wallet_rows_for(actors, user["id"])
        assert len(ledger_after) == len(ledger_before)
        payment_tx = approved["data"]["paymentTransactionId"]
        chain = sorted(
            str(r.get("type")) for r in ledger_after if r.get("referenceId") in (cid, payment_tx)
        )
        assert chain == ["campaign_payment", "campaign_refund"], chain
        assert _balance_minor(actors, user["id"]) == 500
        again = client.delete(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies)
        assert again.status_code == 200, again.text

    def test_lifecycle_audit_entries_are_kept_forever(self):
        import server.main as main_module

        new_kept = (
            "stop", "withdraw", "publish_status", "stop_request", "settle_override",
            "contact_link", "subscribe_smoke_test", "ig_read_test", "check_comments",
        )
        for action in new_kept:
            assert f"'{action}'" in main_module._AUDIT_KEEP_ACTIONS, action
        old_ts = now_ms() - 400 * 24 * 3600 * 1000  # older than the 365-day default
        ids = {action: f"audit_p104_{action}" for action in (*new_kept, "update")}
        with db_conn() as conn:
            for action, row_id in ids.items():
                conn.execute(
                    text("INSERT INTO audit_logs (id, ts, user_id, action, resource_type, resource_id, message, metadata_json) "
                         "VALUES (:id, :ts, NULL, :action, 'adCampaignRequests', 'p104_kept', 'P1-04 keep list', '{}')"),
                    {"id": row_id, "ts": old_ts, "action": action},
                )
        main_module.cleanup_old_audit_logs()
        with db_conn() as conn:
            left = {
                str(r[0]) for r in conn.execute(text("SELECT id FROM audit_logs WHERE resource_id = 'p104_kept'"))
            }
            conn.execute(text("DELETE FROM audit_logs WHERE resource_id = 'p104_kept'"))
        assert left == {ids[action] for action in new_kept}, left


# ------------------------------------------------------------------ P1-06 (owner), P1-11, P1-12, P1-15, P1-18(a), P1-22

from datetime import date, timedelta  # noqa: E402 (the budget classes below only)

from server.systems.ads_studio import ad_campaign_actions as _actions  # noqa: E402

# The real count, taken before any test starts (conftest.py stands a zero count in for it).
_REAL_SUBMISSIONS_TODAY = _actions.count_submissions_today


@pytest.fixture
def studio_setting():
    """Change studio settings for one test; every settings row is put back exactly afterwards
    (versions too), so the setting tests of test_studio_api.py still start from version 0."""
    from server.systems.ads_studio import studio_settings

    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(
            text("SELECT * FROM entities WHERE type = 'studioSettings'")
        ).mappings().all()]

    def change(key: str, **fields):
        record = studio_settings.read_setting(key)
        studio_settings.save_setting(key, fields, record["version"], "", "2026-09-25T00:00:00Z",
                                     audit=lambda *args: None)

    yield change
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'studioSettings'"))
        for row in saved:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                row,
            )


def _business_day() -> date:
    from server.operations import _business_today

    return _business_today()


def _budget_request(tag: str, **fields) -> dict:
    body = dict(_complete_campaign(f"Budget {tag}"))
    body.update(fields)
    return body


def _draft_and_submit(cookies, tag: str, **fields):
    """create -> submit; returns (create response, submit response)."""
    created = _create_campaign(cookies, _budget_request(tag, **fields), f"budget_{tag}")
    assert created.status_code == 200, created.text
    submitted = _submit_campaign(cookies, f"budget_{tag}", created.json()["lastModified"], f"budget-submit-{tag}")
    return created, submitted


def _force_campaign_fields(campaign_id: str, **fields) -> int:
    """Write fields straight into a request row (None removes one): a state the routes cannot
    reach any more, such as a request sent before P1."""
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json, last_modified FROM entities WHERE type='adCampaignRequests' AND id=:id"),
            {"id": campaign_id},
        ).mappings().first()
        data = {**(json_loads(row["data_json"]) or {}), **fields}
        for name, value in fields.items():
            if value is None:
                data.pop(name, None)
        modified = int(row["last_modified"]) + 1
        data["_lastModified"] = modified
        conn.execute(
            text("UPDATE entities SET data_json=:d, last_modified=:m WHERE type='adCampaignRequests' AND id=:id"),
            {"d": json_dumps(data), "m": modified, "id": campaign_id},
        )
    return modified


class TestStudioBudgetsLimitsIntake:
    """Owner answers D4 + D5: daily or lifetime, hold and charge = the total, limits from the
    studio 'limits' setting; P1-11 days; P1-12 reasons; P1-18(a) legacy rows; P1-22 intake."""

    def test_new_daily_submit_holds_daily_times_days(self, actors):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "daily7", 6999)
        created, short = _draft_and_submit(
            cookies, "daily7", budgetType="daily", budgetMinorUSD=1000, durationDays=7, startDate="2027-01-10",
        )
        assert created.json()["data"]["endDate"] == "2027-01-16"  # 7 days, both ends counted
        # The wallet check uses the TOTAL (7 x $10 = $70), not one day.
        assert short.status_code == 409 and "Insufficient wallet balance" in short.text, short.text
        topped = client.post(
            "/api/wallet/top-ups",
            json={"userId": user["id"], "amountMinor": 1, "currency": "USD", "idempotencyKey": "wallet-fund-daily7-b"},
            cookies=actors["admin"],
        )
        assert topped.status_code == 200, topped.text
        submitted = _submit_campaign(cookies, "budget_daily7", created.json()["lastModified"], "budget-submit-daily7-b")
        assert submitted.status_code == 200, submitted.text
        data = submitted.json()["data"]
        assert data["totalBudgetMinorUSD"] == 7000 and data["schemaVersion"] == 2 and data["legacyRules"] is False
        from server.wallet_payments import wallet_campaign_holds_minor

        with db_conn() as conn:
            assert wallet_campaign_holds_minor(conn, user["id"]) == 7000  # the one-day hold bug is gone
        approved = _review_campaign(actors, "budget_daily7", submitted.json()["lastModified"], "Approved", "budget-approve-daily7")
        assert approved.status_code == 200, approved.text
        assert approved.json()["data"]["paidMinorUSD"] == 7000
        captures = [r for r in _wallet_rows_for(actors, user["id"]) if r.get("type") == "campaign_payment"]
        assert [r["amountMinor"] for r in captures] == [7000]
        assert _balance_minor(actors, user["id"]) == 0
        # The owner's stop before the start returns what the ledger says was captured.
        stopped = _stop_campaign(cookies, "budget_daily7", approved.json()["lastModified"], "budget-stop-daily7")
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["data"]["refundMinorUSD"] == 7000
        assert _balance_minor(actors, user["id"]) == 7000

    def test_patch_accepts_duration_days(self, actors, studio_setting):
        _, cookies = _fresh_funded_customer(actors, "patchdays", 0)
        created = _create_campaign(cookies, _budget_request("patchdays"), "budget_patchdays")
        assert created.status_code == 200, created.text
        state = {"lm": created.json()["lastModified"]}

        def patch(data):
            return client.patch(
                "/api/collections/adCampaignRequests/budget_patchdays",
                json={"data": data, "expectedLastModified": state["lm"]}, cookies=cookies,
            )

        saved = patch({"durationDays": 7, "startDate": "2027-02-01"})
        assert saved.status_code == 200, saved.text
        assert saved.json()["data"]["durationDays"] == 7 and saved.json()["data"]["endDate"] == "2027-02-07"
        state["lm"] = saved.json()["lastModified"]
        moved = patch({"startDate": "2027-03-30"})  # the end follows the start: still 7 days
        assert moved.status_code == 200, moved.text
        assert moved.json()["data"]["endDate"] == "2027-04-05"
        state["lm"] = moved.json()["lastModified"]
        for bad in (0, -3, 2.5, True, "7"):
            refused = patch({"durationDays": bad})
            assert refused.status_code == 400, (bad, refused.text)
            assert refused.json()["detail"].startswith("durationDays must be a whole number of days"), refused.text
        too_long = patch({"durationDays": 91})
        assert too_long.status_code == 400, too_long.text
        assert too_long.json()["detail"].startswith("The ad can run for at most 90 days"), too_long.text
        studio_setting("limits", maxDays=30)  # the limit comes from the setting, never a fixed number
        assert patch({"durationDays": 31}).json()["detail"].startswith("The ad can run for at most 30 days")
        fits = patch({"durationDays": 30})
        assert fits.status_code == 200, fits.text
        assert fits.json()["data"]["endDate"] == "2027-04-28"
        state["lm"] = fits.json()["lastModified"]
        cleared = patch({"durationDays": None})
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["data"]["durationDays"] is None
        state["lm"] = cleared.json()["lastModified"]
        # The server computes the total; a client can never write it.
        forged = patch({"totalBudgetMinorUSD": 1})
        assert forged.status_code in (400, 403), forged.text

    def test_late_approval_keeps_duration(self, actors):
        _reset_reviewer_limits(actors)
        today = _business_day()
        for tag, start_offset in (("late2", -2), ("latepast", -10)):
            user, cookies = _fresh_funded_customer(actors, tag, 2500)
            created, submitted = _draft_and_submit(cookies, tag, durationDays=7, startDate="2027-01-10")
            assert submitted.status_code == 200, submitted.text
            # The request waited: approved 2 days after its start (then long after its end).
            start = today + timedelta(days=start_offset)
            lm = _force_campaign_fields(
                f"budget_{tag}", startDate=start.isoformat(), endDate=(start + timedelta(days=6)).isoformat(),
            )
            approved = _review_campaign(actors, f"budget_{tag}", lm, "Approved", f"budget-approve-{tag}")
            assert approved.status_code == 200, approved.text
            data = approved.json()["data"]
            assert data["startDate"] == today.isoformat()
            assert data["endDate"] == (today + timedelta(days=6)).isoformat()  # still 7 days
            assert data["durationDays"] == 7 and data["paidMinorUSD"] == 2500

    def test_budget_limits_enforced_for_new_rows(self, actors, studio_setting):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "limits", 1000)
        cases = (
            ("lowtotal", {"budgetMinorUSD": 499}, "The total budget must be at least $5.00"),
            ("hightotal", {"budgetMinorUSD": 200_001}, "The total budget must be at most $2,000.00"),
            ("dailyhigh", {"budgetType": "daily", "budgetMinorUSD": 30_000, "durationDays": 7},
             "The total budget must be at most $2,000.00"),  # 7 x $300 = $2,100
            ("thinlife", {"budgetMinorUSD": 500}, "Budget per day is below the minimum"),  # $5 over 11 days
            ("thindaily", {"budgetType": "daily", "budgetMinorUSD": 99, "durationDays": 7},
             "Budget per day is below the minimum"),
            ("toolong", {"budgetMinorUSD": 50_000, "startDate": "2027-01-01", "endDate": "2027-04-01"},
             "The ad can run for at most 90 days"),  # 91 days from the dates
        )
        for tag, fields, prefix in cases:
            _, refused = _draft_and_submit(cookies, tag, **fields)
            assert refused.status_code == 400, (tag, refused.text)
            assert refused.json()["detail"].startswith(prefix), (tag, refused.text)
            still = client.get(f"/api/collections/adCampaignRequests/budget_{tag}", cookies=cookies).json()
            assert still["data"]["status"] == "Draft" and "totalBudgetMinorUSD" not in still["data"]
        # Exactly at the limits passes: $5.00 over 5 days = $1.00 a day.
        _, edge = _draft_and_submit(cookies, "edge", budgetMinorUSD=500, durationDays=5)
        assert edge.status_code == 200, edge.text
        # The numbers come from the setting (and /me shows the same ones to the form).
        studio_setting("limits", minTotalMinorUSD=1000)
        me = client.get("/api/studio/me", cookies=cookies)
        assert me.status_code == 200, me.text
        assert me.json()["adLimits"] == {
            "minTotalMinorUSD": 1000, "maxTotalMinorUSD": 200_000, "minPerDayMinorUSD": 100, "maxDays": 90,
        }
        _, raised = _draft_and_submit(cookies, "raised", budgetMinorUSD=900, durationDays=3)
        assert raised.status_code == 400, raised.text
        assert raised.json()["detail"].startswith("The total budget must be at least $10.00"), raised.text
        # Approval checks today's limits again for a new row: nothing is captured.
        approval = _review_campaign(actors, "budget_edge", edge.json()["lastModified"], "Approved", "budget-approve-edge")
        assert approval.status_code == 400, approval.text
        assert approval.json()["detail"].startswith("The total budget must be at least $10.00"), approval.text
        assert _balance_minor(actors, user["id"]) == 1000
        assert not [r for r in _wallet_rows_for(actors, user["id"]) if r.get("type") == "campaign_payment"]
        latest = client.get("/api/collections/adCampaignRequests/budget_edge", cookies=cookies).json()
        assert latest["data"]["status"] == "Submitted"

    def test_legacy_submitted_row_skips_new_limits(self, actors, studio_setting):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "legacy", 5000)
        _, submitted = _draft_and_submit(cookies, "legacy")
        assert submitted.status_code == 200, submitted.text
        # As a daily request sent before P1 left it: $0.50 a day, one day held, no schemaVersion 2.
        lm = _force_campaign_fields(
            "budget_legacy", schemaVersion=1, budgetType="daily", budgetMinorUSD=50,
            totalBudgetMinorUSD=None, legacyRules=None,
        )
        from server.wallet_payments import wallet_campaign_holds_minor

        with db_conn() as conn:
            assert wallet_campaign_holds_minor(conn, user["id"]) == 50  # the hold it was submitted with
        studio_setting("limits", p1CutoverAt="2026-01-01T00:00:00Z")
        approved = _review_campaign(actors, "budget_legacy", lm, "Approved", "budget-approve-legacy")
        assert approved.status_code == 200, approved.text  # no per-day floor refusal
        data = approved.json()["data"]
        assert data["legacyRules"] is True and data["paidMinorUSD"] == 50
        assert "totalBudgetMinorUSD" not in data
        captures = [r["amountMinor"] for r in _wallet_rows_for(actors, user["id"]) if r.get("type") == "campaign_payment"]
        assert captures == [50]  # the old capture amount
        # A new daily request with the same numbers is refused.
        _, fresh = _draft_and_submit(cookies, "legacynew", budgetType="daily", budgetMinorUSD=50, durationDays=11)
        assert fresh.status_code == 400, fresh.text
        assert fresh.json()["detail"].startswith("Budget per day is below the minimum"), fresh.text

    def test_intake_paused_blocks_submit_not_drafts(self, actors, studio_setting):
        _, cookies = _fresh_funded_customer(actors, "paused", 2500)
        studio_setting("intake", open=False)
        created, paused = _draft_and_submit(cookies, "paused")
        assert paused.status_code == 409, paused.text
        assert paused.json()["detail"].startswith("New ad requests are paused"), paused.text
        assert client.get("/api/studio/me", cookies=cookies).json()["intake"] == {"open": False}
        edited = client.patch(
            "/api/collections/adCampaignRequests/budget_paused",
            json={"data": {"headline": "Saved while paused"}, "expectedLastModified": created.json()["lastModified"]},
            cookies=cookies,
        )
        assert edited.status_code == 200, edited.text  # drafts still save
        assert edited.json()["data"]["status"] == "Draft"
        studio_setting("intake", open=True)
        sent = _submit_campaign(cookies, "budget_paused", edited.json()["lastModified"], "budget-submit-paused-2")
        assert sent.status_code == 200, sent.text

    def test_daily_cap_blocks_submit(self, actors, studio_setting, monkeypatch):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "cap", 10_000)
        today = _business_day().isoformat()
        base = _REAL_SUBMISSIONS_TODAY(today)  # sends of earlier tests today
        monkeypatch.setattr(_actions, "count_submissions_today", lambda day: _REAL_SUBMISSIONS_TODAY(day) - base)
        studio_setting("intake", maxSubmissionsPerDay=2)
        _, first = _draft_and_submit(cookies, "capa")
        _, second = _draft_and_submit(cookies, "capb")
        assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
        created, third = _draft_and_submit(cookies, "capc")
        assert third.status_code == 409, third.text
        assert third.json()["detail"].startswith("Today's limit of new ad requests is reached"), third.text
        # A resubmit after Changes Requested counts too.
        sent_back = _review_campaign(actors, "budget_capa", first.json()["lastModified"], "Changes Requested",
                                     "budget-cap-back", note="New photo please", reason="creative_quality")
        assert sent_back.status_code == 200, sent_back.text
        again = _submit_campaign(cookies, "budget_capa", sent_back.json()["lastModified"], "budget-cap-resubmit")
        assert again.status_code == 409 and "Today's limit" in again.text, again.text
        studio_setting("intake", maxSubmissionsPerDay=3)
        again = _submit_campaign(cookies, "budget_capa", sent_back.json()["lastModified"], "budget-cap-resubmit-2")
        assert again.status_code == 200, again.text
        assert again.json()["data"]["submitDayCount"] == 2  # this request was sent twice today
        still = _submit_campaign(cookies, "budget_capc", created.json()["lastModified"], "budget-submit-capc-2")
        assert still.status_code == 409, still.text
        edited = client.patch(
            "/api/collections/adCampaignRequests/budget_capc",
            json={"data": {"headline": "Tomorrow"}, "expectedLastModified": created.json()["lastModified"]},
            cookies=cookies,
        )
        assert edited.status_code == 200, edited.text  # the draft still saves

    def test_review_reason_codes_required_and_stored(self, actors):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "reasons", 2500)
        _, submitted = _draft_and_submit(cookies, "reasons")
        assert submitted.status_code == 200, submitted.text
        state = {"lm": submitted.json()["lastModified"]}

        def review(decision, op, **extra):
            body = {"expectedLastModified": state["lm"], "decision": decision, "note": extra.pop("note", ""),
                    "operationId": op, **extra}
            return client.post("/api/ad-studio/campaigns/budget_reasons/review", json=body, cookies=actors["reviewer"])

        for decision in ("Changes Requested", "Rejected"):
            missing = review(decision, "budget-reason-missing", note="Please fix it")
            assert missing.status_code == 400, missing.text
            assert missing.json()["detail"].startswith("Choose a reason for this decision"), missing.text
            for bad in ("nonsense", 7, "BUDGET_DATES"):
                unknown = review(decision, "budget-reason-unknown", reviewReasonCode=bad)
                assert unknown.status_code == 400, unknown.text
                assert unknown.json()["detail"].startswith("Unknown reason code"), unknown.text
        # D33: a request sent back for its budget and dates; the note is optional.
        sent_back = review("Changes Requested", "budget-reason-back", reviewReasonCode="budget_dates")
        assert sent_back.status_code == 200, sent_back.text
        data = sent_back.json()["data"]
        assert data["reviewReasonCode"] == "budget_dates" and data["reviewNote"] == ""
        assert data["reviewHistory"][-1]["reasonCode"] == "budget_dates"
        replay = review("Changes Requested", "budget-reason-back", reviewReasonCode="budget_dates")
        assert replay.status_code == 200, replay.text
        assert replay.json()["lastModified"] == sent_back.json()["lastModified"]
        remixed = review("Changes Requested", "budget-reason-back", reviewReasonCode="targeting")
        assert remixed.status_code == 409, remixed.text
        owner_view = client.get("/api/collections/adCampaignRequests/budget_reasons", cookies=cookies).json()
        assert owner_view["data"]["reviewReasonCode"] == "budget_dates"  # returned to the owner
        with db_conn() as conn:
            meta = conn.execute(
                text("SELECT metadata_json FROM audit_logs WHERE action = 'review' AND resource_id = 'budget_reasons'"),
            ).scalar_one()
        assert json_loads(meta)["reviewReasonCode"] == "budget_dates"
        # Resubmitting clears the reason; an approval needs none (a code sent with it is ignored).
        resubmitted = _submit_campaign(cookies, "budget_reasons", sent_back.json()["lastModified"], "budget-reason-resubmit")
        assert resubmitted.status_code == 200, resubmitted.text
        assert resubmitted.json()["data"]["reviewReasonCode"] == ""
        state["lm"] = resubmitted.json()["lastModified"]
        approved = review("Approved", "budget-reason-approve", reviewReasonCode="whatever")
        assert approved.status_code == 200, approved.text
        assert approved.json()["data"]["reviewReasonCode"] == ""
        assert "reasonCode" not in approved.json()["data"]["reviewHistory"][-1]
        assert approved.json()["data"]["reviewHistory"][0]["reasonCode"] == "budget_dates"  # history keeps it


# ------------------------------------------------------------------ P1-02 serialised submit, P1-03 withdraw, P1-03b self-release

import threading  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

from server.systems.ads_studio.ad_campaign_actions import (  # noqa: E402
    REFUSE_WITHDRAW_APPROVED,
    REFUSE_WITHDRAW_NOT_SUBMITTED,
)


def _withdraw_campaign(cookies, campaign_id: str, last_modified: int, op: str):
    return client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/withdraw",
        json={"expectedLastModified": last_modified, "operationId": op},
        cookies=cookies,
    )


def _campaign_money(actors, user_id: str, campaign_id: str) -> dict[str, list[int]]:
    """This request's ledger rows (every cycle): amounts by row type."""
    money: dict[str, list[int]] = {"campaign_payment": [], "campaign_payment_release": [], "campaign_refund": []}
    pay = f"cpay:{campaign_id}:"
    for row in _wallet_rows_for(actors, user_id):
        key = str(row.get("idempotencyKey") or "")
        if key.startswith((pay, f"rel:{pay}", f"stoprefund:{pay}")):
            money.setdefault(str(row.get("type") or ""), []).append(int(row["amountMinor"]))
    return money


def _available_minor(user_id: str) -> int:
    """The number every debit and submit checks: ledger balance - Submitted holds."""
    import server.main as main_module

    with db_conn() as conn:
        return main_module._wallet_available_after_holds(conn, user_id, "USD")


def _assert_wallet_identity(cookies, user_id: str) -> dict:
    """The studio wallet summary (P1-07) still adds up: added + adjustments - in ads - being
    returned - spent = available + reserved, and available is the server's own number."""
    reset_rate_limit(f"studio:wallet-summary:{user_id}")
    response = client.get("/api/studio/wallet/summary", cookies=cookies)
    assert response.status_code == 200, response.text
    usd = response.json()["usd"]
    left = usd["addedMinor"] + usd["adjustmentsMinor"] - usd["inAdsMinor"] - usd["beingReturnedMinor"] - usd["spentMinor"]
    assert left == usd["availableMinor"] + usd["reservedMinor"], usd
    assert usd["availableMinor"] == _available_minor(user_id), usd
    return usd


def _sent_campaign(cookies, campaign_id: str, name: str) -> dict:
    """create -> submit; returns the submit response entity."""
    created = _create_campaign(cookies, _complete_campaign(name), campaign_id)
    assert created.status_code == 200, created.text
    sent = _submit_campaign(cookies, campaign_id, created.json()["lastModified"], f"{campaign_id}-send")
    assert sent.status_code == 200, sent.text
    return sent.json()


def _audit_rows(campaign_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        return [
            json_loads(r[0]) or {} for r in conn.execute(
                text("SELECT metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
                {"id": campaign_id, "action": action},
            )
        ]


def _approval_paused_before_status_write(monkeypatch, actors, campaign_id: str, last_modified: int, op: str, meanwhile):
    """Run an approval that stops after its capture, right before its status write; run
    ``meanwhile()`` here while it waits, then let it finish. Returns (meanwhile's result, the
    approval's response). Only the FIRST status write with ``op`` waits, so an identical
    approval sent meanwhile goes straight through."""
    import server.main as main_module

    original_patch = main_module.patch_entity
    paused, resume = threading.Event(), threading.Event()

    def pause_status_write(*args, **kwargs):
        updates = args[2] if len(args) > 2 else {}
        if updates.get("lastReviewOperationId") == op and not paused.is_set():
            paused.set()
            if not resume.wait(15):
                raise HTTPException(status_code=500, detail="the test never resumed the approval")
        return original_patch(*args, **kwargs)

    def approve():
        own = TestClient(app, headers={"Origin": "http://testserver"})
        try:
            return own.post(
                f"/api/ad-studio/campaigns/{campaign_id}/review",
                json={"expectedLastModified": last_modified, "decision": "Approved", "note": "", "operationId": op},
                cookies=actors["reviewer"],
            )
        finally:
            own.close()

    monkeypatch.setattr(main_module, "patch_entity", pause_status_write)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            approving = pool.submit(approve)
            try:
                assert paused.wait(15), "the approval never reached its status write"
                outcome = meanwhile()
            finally:
                resume.set()
            response = approving.result(timeout=30)
    finally:
        monkeypatch.setattr(main_module, "patch_entity", original_patch)
    return outcome, response


class TestStudioSubmitSerialised:
    """P1-02: submit runs one locked transaction (owner row -> campaign row -> rel: key)."""

    def test_two_parallel_submits_cannot_overreserve(self, actors, monkeypatch):
        import server.main as main_module

        user, cookies = _fresh_funded_customer(actors, "parallel", 4000)
        drafts = {}
        for tag in ("a", "b"):
            created = _create_campaign(cookies, _complete_campaign(f"Parallel submit {tag}"), f"parallel_submit_{tag}")
            assert created.status_code == 200, created.text
            drafts[f"parallel_submit_{tag}"] = created.json()["lastModified"]
        real_prepare = main_module._prepare_ad_campaign_fields
        both_validated = threading.Barrier(2)

        def validate_together(*args, **kwargs):
            result = real_prepare(*args, **kwargs)
            if kwargs.get("strict") and str((args[0] if args else {}).get("name") or "").startswith("Parallel submit"):
                both_validated.wait(timeout=10)  # both sends leave validation at the same moment
            return result

        monkeypatch.setattr(main_module, "_prepare_ad_campaign_fields", validate_together)

        def send(campaign_id):
            own = TestClient(app, headers={"Origin": "http://testserver"})
            try:
                response = own.post(
                    f"/api/ad-studio/campaigns/{campaign_id}/submit",
                    json={"expectedLastModified": drafts[campaign_id], "operationId": f"{campaign_id}-send"},
                    cookies=cookies,
                )
                return campaign_id, response.status_code, response.json()
            finally:
                own.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, drafts))
        # $25 + $25 against $40 Available: exactly one send holds its budget, the other is refused.
        assert sorted(status for _, status, _ in results) == [200, 409], results
        refused = next(body for _, status, body in results if status == 409)
        assert refused["detail"].startswith("Insufficient wallet balance"), refused
        statuses = {
            cid: client.get(f"/api/collections/adCampaignRequests/{cid}", cookies=cookies).json()["data"]["status"]
            for cid in drafts
        }
        assert sorted(statuses.values()) == ["Draft", "Submitted"], statuses
        from server.wallet_payments import wallet_campaign_holds_minor

        with db_conn() as conn:
            assert wallet_campaign_holds_minor(conn, user["id"]) == 2500
        assert _available_minor(user["id"]) == 1500
        _assert_wallet_identity(cookies, user["id"])
        assert len(_audit_rows(next(cid for cid, status, _ in results if status == 200), "submit")) == 1


class TestStudioWithdraw:
    """P1-03: the owner takes a Submitted request back to Draft in one locked transaction."""

    def test_withdraw_returns_request_to_draft_and_replays(self, actors):
        user, cookies = _fresh_funded_customer(actors, "wdbasic", 2500)
        sent = _sent_campaign(cookies, "withdraw_basic", "Withdraw me")
        assert _available_minor(user["id"]) == 0  # the request holds the whole wallet
        withdrawn = _withdraw_campaign(cookies, "withdraw_basic", sent["lastModified"], "withdraw-basic-op")
        assert withdrawn.status_code == 200, withdrawn.text
        data = withdrawn.json()["data"]
        assert data["status"] == "Draft" and data["withdrawnAt"]
        assert data["lastWithdrawOperationId"] == "withdraw-basic-op"
        # The cycle's payment key stays readable: submittedAt and the submit operation are kept.
        assert data["submittedAt"] == sent["data"]["submittedAt"]
        assert data["lastSubmitOperationId"] == "withdraw_basic-send"
        assert _available_minor(user["id"]) == 2500  # the hold ended at once
        money = _campaign_money(actors, user["id"], "withdraw_basic")
        assert money == {"campaign_payment": [], "campaign_payment_release": [], "campaign_refund": []}, money
        # A lost response is replayed with the same operationId: the same committed result.
        replay = _withdraw_campaign(cookies, "withdraw_basic", sent["lastModified"], "withdraw-basic-op")
        assert replay.status_code == 200, replay.text
        assert replay.json()["lastModified"] == withdrawn.json()["lastModified"]
        again = _withdraw_campaign(cookies, "withdraw_basic", withdrawn.json()["lastModified"], "withdraw-basic-op-2")
        assert again.status_code == 409 and again.json()["detail"].startswith(REFUSE_WITHDRAW_NOT_SUBMITTED), again.text
        audits = _audit_rows("withdraw_basic", "withdraw")
        assert len(audits) == 1 and audits[0]["operationId"] == "withdraw-basic-op", audits
        _assert_wallet_identity(cookies, user["id"])
        # The Draft is edited and sent again: a new cycle, holding the budget again.
        edited = client.patch(
            "/api/collections/adCampaignRequests/withdraw_basic",
            json={"data": {"headline": "Edited after withdraw"}, "expectedLastModified": withdrawn.json()["lastModified"]},
            cookies=cookies,
        )
        assert edited.status_code == 200, edited.text
        resent = _submit_campaign(cookies, "withdraw_basic", edited.json()["lastModified"], "withdraw-basic-send-2")
        assert resent.status_code == 200, resent.text
        assert resent.json()["data"]["submittedAt"] != sent["data"]["submittedAt"]
        assert _available_minor(user["id"]) == 0

    def test_withdraw_owner_only_version_checked_and_lapsed_ok(self, actors):
        user, cookies = _fresh_funded_customer(actors, "wdowner", 2500)
        sent = _sent_campaign(cookies, "withdraw_owner", "Withdraw owner only")
        last_modified = sent["lastModified"]
        for who in ("other", "reviewer", "admin"):
            probe = _withdraw_campaign(actors[who], "withdraw_owner", last_modified, "withdraw-probe-op")
            assert probe.status_code == 404, (who, probe.text)  # another account never learns it exists
        missing = _withdraw_campaign(cookies, "withdraw_owner_missing", 0, "withdraw-probe-op")
        assert missing.status_code == 404, missing.text
        stale = _withdraw_campaign(cookies, "withdraw_owner", last_modified - 1, "withdraw-stale-op")
        assert stale.status_code == 409 and stale.json()["detail"] == "Conflict: record has changed", stale.text
        still = client.get("/api/collections/adCampaignRequests/withdraw_owner", cookies=cookies).json()
        assert still["data"]["status"] == "Submitted"
        # A lapsed plan does not keep the customer's money held: withdraw only returns their own.
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
        withdrawn = _withdraw_campaign(cookies, "withdraw_owner", last_modified, "withdraw-lapsed-op")
        assert withdrawn.status_code == 200, withdrawn.text
        assert withdrawn.json()["data"]["status"] == "Draft"
        assert _available_minor(user["id"]) == 2500

    def test_withdraw_after_capture_returns_money(self, actors, monkeypatch):
        import server.main as main_module

        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "wdcapture", 2500)
        sent = _sent_campaign(cookies, "withdraw_capture", "Withdraw after capture")
        original_patch = main_module.patch_entity

        def crash_status_write(*args, **kwargs):
            updates = args[2] if len(args) > 2 else {}
            if updates.get("lastReviewOperationId") == "withdraw-capture-approve":
                raise HTTPException(status_code=503, detail="simulated crash after the capture")
            return original_patch(*args, **kwargs)

        # An approval captures the budget, then dies before its status write.
        monkeypatch.setattr(main_module, "patch_entity", crash_status_write)
        crashed = _review_campaign(actors, "withdraw_capture", sent["lastModified"], "Approved", "withdraw-capture-approve")
        monkeypatch.setattr(main_module, "patch_entity", original_patch)
        assert crashed.status_code == 503, crashed.text
        assert _campaign_money(actors, user["id"], "withdraw_capture")["campaign_payment"] == [2500]
        assert _balance_minor(actors, user["id"]) == 0
        withdrawn = _withdraw_campaign(cookies, "withdraw_capture", sent["lastModified"], "withdraw-capture-op")
        assert withdrawn.status_code == 200, withdrawn.text
        assert withdrawn.json()["data"]["status"] == "Draft"
        # The capture came back in the same transaction: the ledger is as before the submit.
        money = _campaign_money(actors, user["id"], "withdraw_capture")
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [2500], money
        assert _balance_minor(actors, user["id"]) == 2500 and _available_minor(user["id"]) == 2500
        released = _audit_rows("withdraw_capture", "wallet_release")
        assert len(released) == 1 and released[0]["transactionId"], released
        replay = _withdraw_campaign(cookies, "withdraw_capture", sent["lastModified"], "withdraw-capture-op")
        assert replay.status_code == 200, replay.text
        # The reviewer's retry of the crashed approval finds a Draft: nothing is captured again.
        retry = _review_campaign(actors, "withdraw_capture", sent["lastModified"], "Approved", "withdraw-capture-approve")
        assert retry.status_code == 409, retry.text
        assert _campaign_money(actors, user["id"], "withdraw_capture") == money
        assert len(_audit_rows("withdraw_capture", "wallet_release")) == 1
        _assert_wallet_identity(cookies, user["id"])

    def test_withdraw_after_approval_is_refused(self, actors):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "wdlate", 2500)
        sent = _sent_campaign(cookies, "withdraw_late", "Withdraw too late")
        approved = _review_campaign(actors, "withdraw_late", sent["lastModified"], "Approved", "withdraw-late-approve")
        assert approved.status_code == 200, approved.text
        late = _withdraw_campaign(cookies, "withdraw_late", sent["lastModified"], "withdraw-late-op")
        assert late.status_code == 409, late.text
        assert late.json()["detail"] == REFUSE_WITHDRAW_APPROVED
        latest = client.get("/api/collections/adCampaignRequests/withdraw_late", cookies=cookies).json()
        assert latest["data"]["status"] == "Approved"
        money = _campaign_money(actors, user["id"], "withdraw_late")
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
        assert _audit_rows("withdraw_late", "withdraw") == []
        _assert_wallet_identity(cookies, user["id"])


class TestStudioApprovalSelfRelease:
    """P1-03b: an approval that lost its status write after its capture returns that capture
    when the request left the cycle; a concurrent approval that won keeps it."""

    def test_capture_then_withdraw_then_approval_conflict_returns_money(self, actors, monkeypatch):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "selfrelwd", 2500)
        sent = _sent_campaign(cookies, "self_release_wd", "Self release withdraw")
        before = _balance_minor(actors, user["id"])  # a submit writes no ledger row: the pre-submit state

        def withdraw_meanwhile():
            captured = _campaign_money(actors, user["id"], "self_release_wd")["campaign_payment"]
            return captured, _withdraw_campaign(cookies, "self_release_wd", sent["lastModified"], "self-release-wd-op")

        (captured, withdrawn), approval = _approval_paused_before_status_write(
            monkeypatch, actors, "self_release_wd", sent["lastModified"], "self-release-wd-approve", withdraw_meanwhile,
        )
        assert captured == [2500]  # the approval's capture had committed when the withdraw ran
        assert withdrawn.status_code == 200 and withdrawn.json()["data"]["status"] == "Draft", withdrawn.text
        assert approval.status_code == 409, approval.text  # the withdraw won the row
        money = _campaign_money(actors, user["id"], "self_release_wd")
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [2500], money
        assert _balance_minor(actors, user["id"]) == before and _available_minor(user["id"]) == before
        latest = client.get("/api/collections/adCampaignRequests/self_release_wd", cookies=cookies).json()
        assert latest["data"]["status"] == "Draft"
        usd = _assert_wallet_identity(cookies, user["id"])
        assert usd["beingReturnedMinor"] == 0 and usd["inAdsMinor"] == 0 and usd["availableMinor"] == before

    def test_approval_returns_its_capture_when_the_request_left_the_cycle(self, actors, monkeypatch):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "selfrelback", 2500)
        sent = _sent_campaign(cookies, "self_release_back", "Self release send back")
        before = _balance_minor(actors, user["id"])

        def sent_back_without_release():
            # A send-back whose status write committed but whose release never ran (crash).
            _force_campaign_fields("self_release_back", status="Changes Requested", reviewDecision="Changes Requested")

        _, approval = _approval_paused_before_status_write(
            monkeypatch, actors, "self_release_back", sent["lastModified"], "self-release-back-approve",
            sent_back_without_release,
        )
        assert approval.status_code == 409, approval.text
        # Nothing else would return this capture: the approval returned it itself.
        money = _campaign_money(actors, user["id"], "self_release_back")
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [2500], money
        assert _balance_minor(actors, user["id"]) == before and _available_minor(user["id"]) == before
        released = _audit_rows("self_release_back", "wallet_release")
        assert len(released) == 1 and released[0]["operationId"] == "self-release-back-approve", released
        # A retry of the same approval changes nothing.
        retry = _review_campaign(actors, "self_release_back", sent["lastModified"], "Approved", "self-release-back-approve")
        assert retry.status_code == 409, retry.text
        assert _campaign_money(actors, user["id"], "self_release_back") == money
        usd = _assert_wallet_identity(cookies, user["id"])
        assert usd["beingReturnedMinor"] == 0 and usd["availableMinor"] == before

    def test_identical_concurrent_approval_is_never_released(self, actors, monkeypatch):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "selfrelsame", 2500)
        sent = _sent_campaign(cookies, "self_release_same", "Self release identical")
        op = "self-release-same-approve"
        winner, loser = _approval_paused_before_status_write(
            monkeypatch, actors, "self_release_same", sent["lastModified"], op,
            lambda: _review_campaign(actors, "self_release_same", sent["lastModified"], "Approved", op),
        )
        # The paused one lost the row to its identical twin and adopted the twin's commit.
        assert winner.status_code == 200 and loser.status_code == 200, (winner.text, loser.text)
        assert loser.json()["lastModified"] == winner.json()["lastModified"]
        assert loser.json()["data"]["status"] == "Approved"
        money = _campaign_money(actors, user["id"], "self_release_same")
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
        assert _balance_minor(actors, user["id"]) == 0
        assert len(_audit_rows("self_release_same", "review")) == 1
        assert _audit_rows("self_release_same", "wallet_release") == []
        usd = _assert_wallet_identity(cookies, user["id"])
        assert usd["inAdsMinor"] == 2500 and usd["beingReturnedMinor"] == 0

    def test_approval_that_loses_to_another_approval_keeps_the_capture(self, actors, monkeypatch):
        _reset_reviewer_limits(actors)
        user, cookies = _fresh_funded_customer(actors, "selfrelother", 2500)
        sent = _sent_campaign(cookies, "self_release_other", "Self release other approval")
        winner, loser = _approval_paused_before_status_write(
            monkeypatch, actors, "self_release_other", sent["lastModified"], "self-release-other-a",
            lambda: _review_campaign(actors, "self_release_other", sent["lastModified"], "Approved", "self-release-other-b"),
        )
        assert winner.status_code == 200, winner.text
        assert loser.status_code == 409, loser.text  # a different approval won: this one reports the conflict
        money = _campaign_money(actors, user["id"], "self_release_other")
        # The winner's ad uses the one capture of this cycle: it is never returned.
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
        latest = client.get("/api/collections/adCampaignRequests/self_release_other", cookies=cookies).json()
        assert latest["data"]["status"] == "Approved" and latest["data"]["lastReviewOperationId"] == "self-release-other-b"
        assert _audit_rows("self_release_other", "wallet_release") == []
        _assert_wallet_identity(cookies, user["id"])
