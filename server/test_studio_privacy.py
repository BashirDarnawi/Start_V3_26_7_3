"""Albayan Studio privacy (plan tasks P1-05 and P1-16; PLAN.md §7.5).

* P1-05: a customer never receives a staff id or a staff name on any read path (the generic
  collections API, the ad-studio actions, the payment-request routes and the studio summaries);
  staff and admins still do.
* P1-16: privacy anonymisation removes the studio's personal data (the optional WhatsApp number,
  the reply-log commenter data) and never touches the ledger.

``postgres_scrub_race()`` is the PostgreSQL scenario ``studio_privacy_scrub`` of
test_postgres_financial_review.py (not collected here). Every test creates its own users.
"""

import json
import os
import secrets
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.rbac import USER_DIRECTORY_PERMISSIONS, can_browse_user_directory
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES, studio_privacy, studio_results, studio_wallet
from server.systems.ads_studio.social_studio import LOG_TYPE, SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_privacy import (
    REDACTED_TYPES,
    TEAM_ID,
    TEAM_LABELS,
    is_staff_viewer,
    redact_staff_identity,
    scrub_studio_personal_data_conn,
)
from server.systems.ads_studio.studio_results import write_results_row
from server.systems.ads_studio.studio_types import STUDIO_PROFILES_TYPE, derived_id

TAG = secrets.token_hex(4)
PASSWORD = "StudioPrivacyPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
_counter = [0]


def _uid(prefix: str) -> str:
    _counter[0] += 1
    return f"{prefix}_{TAG}_{_counter[0]}"


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ people

def _insert_user_row(conn, label: str, role: str, permissions: dict, name: str) -> dict:
    stamp = now_ms()
    user_id = new_id("privacy_user")
    email = f"studio-privacy-{label}-{secrets.token_hex(3)}@tests.albayanhub.com"
    conn.execute(
        text(
            "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
            "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
        ),
        {"id": user_id, "name": name, "email": email, "role": role, "permissions": json_dumps(permissions),
         "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
         "stamp": stamp},
    )
    return {"id": user_id, "email": email, "name": name, "role": role, "permissions_json": json_dumps(permissions)}


def _insert_user(label: str, role: str, permissions: dict, name: str | None = None) -> dict:
    with db_conn() as conn:
        user = _insert_user_row(conn, label, role, permissions, name or f"Privacy {label} {TAG}")
    response = client.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert response.status_code == 200, response.text
    user["cookies"] = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return user


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("admin", "Admin", {}, f"Privacy Admin Person {TAG}"),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}, f"Privacy Reviewer Person {TAG}"),
    }


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


def _customer(staff, label: str) -> dict:
    """A studio customer whose plan period an admin bought (so it carries the admin's stamp)."""
    user = _insert_user(f"{label}-{_uid('c')}", "Employee", CUSTOMER_PERMISSIONS, f"Privacy Customer {label} {TAG}")
    bought = client.post("/api/subscriptions/purchase", json={
        "serviceId": "ad_maker", "idempotencyKey": _uid("sub-key"), "userId": user["id"],
    }, cookies=staff["admin"]["cookies"])
    assert bought.status_code == 200, bought.text
    return user


# ------------------------------------------------------------------ money and campaign steps (real routes)

def _payment_request(user: dict, amount: int, method: str = "adfali", key: str | None = None):
    return client.post("/api/wallet/payment-requests", json={
        "amountMinor": amount, "currency": "USD", "method": method, "idempotencyKey": key or _uid("charge-key"),
    }, cookies=user["cookies"])


def _campaign_body(name: str, budget: int) -> dict:
    return {
        "name": name, "objective": "messages", "platforms": ["facebook", "instagram"], "pageName": "Privacy Test Page",
        "primaryText": "Message us for this week's offer.", "headline": "Weekly offer", "description": "Privacy test.",
        "callToAction": "Send Message", "destination": "https://wa.me/218910000000", "locations": ["Tripoli, Libya"],
        "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"], "interests": ["Shopping"],
        "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": budget, "budgetType": "lifetime",
        "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }


def _last_modified(campaign_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT last_modified FROM entities WHERE type = :t AND id = :id"),
                                {"t": CAMPAIGNS, "id": campaign_id}).scalar())


def _create(user: dict, budget: int) -> str:
    campaign_id = _uid("pcmp")
    response = client.post(f"/api/collections/{CAMPAIGNS}", json={"id": campaign_id, "data": _campaign_body(f"Ad {campaign_id}", budget)},
                           cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return campaign_id


def _submit(user: dict, campaign_id: str):
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                           json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                           cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response


def _review(staff, campaign_id: str, decision: str):
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": decision,
        "note": "" if decision == "Approved" else "Please fix the photo", "operationId": _uid("review-op"),
        "reviewReasonCode": "" if decision == "Approved" else "creative_quality",
    }, cookies=staff["reviewer"]["cookies"])
    assert response.status_code == 200, response.text
    return response


def _meta_id() -> str:
    _counter[0] += 1
    return f"1203{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


def _link_and_stop(staff, user: dict, campaign_id: str) -> None:
    meta_id = _meta_id()
    linked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("link-op"), "publishStatus": "live",
        "metaCampaignId": meta_id,
    }, cookies=staff["reviewer"]["cookies"])
    assert linked.status_code == 200, linked.text
    stamp = _iso()
    with db_conn() as conn:
        write_results_row(conn, campaign_id, user["id"], {
            "metaCampaignId": meta_id, "syncState": "ok", "lastSyncedAt": stamp, "adStatusCounts": {"ACTIVE": 1},
            "campaignEffectiveStatus": "ACTIVE", "spendMinorUSD": 200, "spendConfirmedAt": stamp,
            "insightsState": "ok", "currency": "USD",
        })
    stopped = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("stop-op"), "reason": "test",
        "refundMinorUSD": 1_800,
    }, cookies=staff["reviewer"]["cookies"])
    assert stopped.status_code == 200, stopped.text


def _get(user: dict, path: str):
    for bucket in ("wallet-summary", "campaigns-summary"):
        reset_rate_limit(f"studio:{bucket}:{user['id']}")
    response = client.get(path, cookies=user["cookies"])
    assert response.status_code == 200, f"{path}: {response.text}"
    return response


# ------------------------------------------------------------------ P1-05: the rule, pure

def _viewer(user_id: str, permissions: dict | None = None, role: str = "Employee") -> dict:
    return {"id": user_id, "role": role, "permissions_json": json.dumps(permissions or CUSTOMER_PERMISSIONS)}


def test_redaction_rule_keeps_own_stamps_and_hides_staff_ones():
    customer = _viewer("user_customer")
    campaign = {
        "id": "cmp_1", "type": CAMPAIGNS, "deleted": False, "createdAt": 1, "createdBy": "user_customer", "lastModified": 2,
        "data": {
            "name": "Offer", "createdBy": "user_customer", "createdByName": "Customer Name", "creatorId": "user_customer",
            "submittedBy": "user_customer", "reviewedBy": "user_reviewer", "approvedBy": "user_reviewer",
            "publishedBy": "user_reviewer", "stoppedBy": "user_customer", "settledBy": "user_admin",
            "reviewHistory": [
                {"decision": "Changes Requested", "note": "Fix it", "reviewedBy": "user_reviewer"},
                {"decision": "Approved", "note": "", "reviewedBy": "user_admin", "reviewedByName": "Admin Person"},
            ],
            "linked": {"linkedById": "user_admin", "at": "2027-01-01"},
            "creativeImages": [PNG], "budgetType": "lifetime", "rejectedBy": None, "canceledBy": "",
        },
    }
    snapshot = json.dumps(campaign, sort_keys=True)
    seen = redact_staff_identity(campaign, customer)
    assert json.dumps(campaign, sort_keys=True) == snapshot  # the stored value is never changed
    data = seen["data"]
    assert seen["createdBy"] == data["createdBy"] == data["creatorId"] == data["submittedBy"] == data["stoppedBy"] == "user_customer"
    assert data["createdByName"] == "Customer Name"  # the viewer's own name stays
    assert data["reviewedBy"] == data["approvedBy"] == data["publishedBy"] == data["settledBy"] == TEAM_ID
    assert [entry["reviewedBy"] for entry in data["reviewHistory"]] == [TEAM_ID, TEAM_ID]
    assert "reviewedByName" not in data["reviewHistory"][1] and data["linked"]["linkedById"] == TEAM_ID
    assert data["rejectedBy"] is None and data["canceledBy"] == "" and data["creativeImages"] == [PNG]
    assert "user_reviewer" not in json.dumps(seen) and "user_admin" not in json.dumps(seen) and "Admin Person" not in json.dumps(seen)

    credit = {"id": "tx_1", "type": "walletTransactions", "createdBy": "user_admin", "data": {
        "type": "credit", "amountMinor": 500, "fromUserId": None, "toUserId": "user_customer",
        "createdBy": "user_admin", "createdByName": "Admin Person"}}
    ledger = redact_staff_identity(credit, customer)
    assert ledger["createdBy"] == ledger["data"]["createdBy"] == TEAM_ID and "createdByName" not in ledger["data"]
    assert ledger["data"]["toUserId"] == "user_customer" and ledger["data"]["amountMinor"] == 500
    system_row = {"id": "tx_2", "type": "walletTransactions", "createdBy": "system", "data": {"createdBy": "system"}}
    assert redact_staff_identity(system_row, customer) is system_row  # "system" is not a person

    # Staff and admins get the value itself; so does a customer when nothing names staff.
    reviewer = _viewer("user_reviewer", {CAMPAIGNS: ["view", "review"]})
    assert redact_staff_identity(campaign, reviewer) is campaign
    assert redact_staff_identity(campaign, _viewer("user_admin", {}, role="Admin")) is campaign
    own_draft = {"id": "cmp_2", "type": CAMPAIGNS, "createdBy": "user_customer", "data": {"submittedBy": "user_customer"}}
    assert redact_staff_identity(own_draft, customer) is own_draft
    # Other record types keep their fields ("deliveryFeePaidBy" is a Manager setting, not a person).
    ad = {"id": "ad_1", "type": "ads", "createdBy": "user_admin", "data": {"deliveryFeePaidBy": "customer"}}
    assert redact_staff_identity(ad, customer) is ad
    assert REDACTED_TYPES == {CAMPAIGNS, "walletTransactions", "walletPaymentRequests", "serviceSubscriptions"}
    # A summary (not an entity) is redacted whole, so a field added later cannot leak.
    summary = {"cmp_1": {"stage": 11, "settledBy": "user_admin", "steps": [{"confirmedBy": "user_admin"}]}}
    assert redact_staff_identity(summary, customer) == {"cmp_1": {"stage": 11, "settledBy": TEAM_ID, "steps": [{"confirmedBy": TEAM_ID}]}}
    assert TEAM_LABELS == {"en": "Albayan team", "ar": "فريق البيان"}


def test_staff_means_the_user_directory_rule():
    """Staff = admins and exactly the accounts /api/users/public gives the whole directory."""
    assert is_staff_viewer(_viewer("a", {}, role="Admin"))
    for module, action in USER_DIRECTORY_PERMISSIONS:
        grant = _viewer("s", {module: [action]})
        assert is_staff_viewer(grant) and can_browse_user_directory(grant), (module, action)
    for permissions in (CUSTOMER_PERMISSIONS, {}, {"ads": ["viewOwn", "add"]}, {"receipts": ["viewOwn"]}):
        customer = _viewer("c", permissions)
        assert not is_staff_viewer(customer) and not can_browse_user_directory(customer), permissions
    assert not is_staff_viewer(None) and not is_staff_viewer({"id": "x", "role": "Employee", "permissions_json": None})
    # The answer follows the permissions (the cache is keyed by them).
    assert not is_staff_viewer(_viewer("u", {CAMPAIGNS: ["viewOwn"]}))
    assert is_staff_viewer(_viewer("u", {CAMPAIGNS: ["viewOwn", "view"]}))


# ------------------------------------------------------------------ P1-05: every customer read path

def test_customer_never_sees_staff_ids(staff):
    admin, reviewer = staff["admin"], staff["reviewer"]
    user = _customer(staff, "reads")
    staff_marks = [admin["id"], reviewer["id"], admin["name"], reviewer["name"]]

    # Money written by staff: an admin credit, a confirmed charge with an overridden receipt, a charge
    # an admin cancelled, and one the customer cancelled.
    credit = client.post("/api/wallet/top-ups", json={"userId": user["id"], "amountMinor": 5_000, "currency": "USD",
                                                      "idempotencyKey": _uid("topup-key")}, cookies=admin["cookies"])
    assert credit.status_code == 200, credit.text
    charge_key = _uid("charge-key")
    confirmed = _payment_request(user, 3_000, "bank_transfer", charge_key)
    assert confirmed.status_code == 200, confirmed.text
    confirmed_id = confirmed.json()["id"]
    decision = client.post(f"/api/wallet/payment-requests/{confirmed_id}/confirm", json={"overrideMissingReceipt": True},
                           cookies=admin["cookies"])
    assert decision.status_code == 200, decision.text
    assert decision.json()["data"]["confirmedBy"] == admin["id"]  # the admin's own answer keeps the stamp
    payreq_credit_id = decision.json()["data"]["walletTransactionId"]
    admin_cancelled = _payment_request(user, 1_000).json()["id"]
    assert client.post(f"/api/wallet/payment-requests/{admin_cancelled}/cancel", cookies=admin["cookies"]).status_code == 200
    self_cancelled = _payment_request(user, 1_000).json()["id"]
    assert client.post(f"/api/wallet/payment-requests/{self_cancelled}/cancel", cookies=user["cookies"]).status_code == 200

    # Campaign A: sent back, resubmitted, approved, linked, stopped by staff with a return.
    campaign_a = _create(user, 2_000)
    _submit(user, campaign_a)
    _review(staff, campaign_a, "Changes Requested")
    resubmitted = _submit(user, campaign_a)  # the customer's own action answer carries the review history
    _review(staff, campaign_a, "Approved")
    _link_and_stop(staff, user, campaign_a)
    # Campaign B: rejected.
    campaign_b = _create(user, 1_500)
    _submit(user, campaign_b)
    _review(staff, campaign_b, "Rejected")

    with db_conn() as conn:
        cpay_id = conn.execute(text(
            "SELECT id FROM entities WHERE type = 'walletTransactions' AND created_by = :reviewer AND data_json LIKE :campaign"
        ), {"reviewer": reviewer["id"], "campaign": f"%cpay:{campaign_a}%"}).scalar()
        subscription_id = conn.execute(text(
            "SELECT id FROM entities WHERE type = 'serviceSubscriptions' AND created_by = :admin AND data_json LIKE :uid"
        ), {"admin": admin["id"], "uid": f"%{user['id']}%"}).scalar()
    assert cpay_id and subscription_id

    answers = {
        "resubmit answer": resubmitted,
        "campaign list": _get(user, f"/api/collections/{CAMPAIGNS}"),
        "campaign delta": _get(user, f"/api/collections/{CAMPAIGNS}?updated_since=0"),
        "campaign A": _get(user, f"/api/collections/{CAMPAIGNS}/{campaign_a}"),
        "campaign B": _get(user, f"/api/collections/{CAMPAIGNS}/{campaign_b}"),
        "ledger list": _get(user, "/api/collections/walletTransactions"),
        "admin credit": _get(user, f"/api/collections/walletTransactions/{credit.json()['id']}"),
        "charge credit": _get(user, f"/api/collections/walletTransactions/{payreq_credit_id}"),
        "capture": _get(user, f"/api/collections/walletTransactions/{cpay_id}"),
        "charge rows": _get(user, "/api/collections/walletPaymentRequests"),
        "charge row": _get(user, f"/api/collections/walletPaymentRequests/{confirmed_id}"),
        "charge list": _get(user, "/api/wallet/payment-requests"),
        "charge": _get(user, f"/api/wallet/payment-requests/{confirmed_id}"),
        "cancel replay": client.post(f"/api/wallet/payment-requests/{admin_cancelled}/cancel", cookies=user["cookies"]),
        "charge replay": _payment_request(user, 3_000, "bank_transfer", charge_key),
        "plan periods": _get(user, "/api/collections/serviceSubscriptions"),
        "plan period": _get(user, f"/api/collections/serviceSubscriptions/{subscription_id}"),
        "wallet summary": _get(user, "/api/studio/wallet/summary"),
        "campaigns summary": _get(user, "/api/studio/campaigns/summary"),
        "studio me": _get(user, "/api/studio/me"),
    }
    for label, response in answers.items():
        assert response.status_code == 200, f"{label}: {response.text}"
        for mark in staff_marks:
            assert mark not in response.text, f"{label} shows staff identity {mark!r}"

    # The stamps are there, as the team's label; the customer's own ones stay.
    seen_a = answers["campaign A"].json()["data"]
    assert seen_a["status"] == "Stopped" and seen_a["createdBy"] == seen_a["submittedBy"] == user["id"]
    assert seen_a["reviewedBy"] == seen_a["approvedBy"] == seen_a["publishedBy"] == seen_a["stoppedBy"] == TEAM_ID
    assert [entry["reviewedBy"] for entry in seen_a["reviewHistory"]] == [TEAM_ID, TEAM_ID]
    assert answers["resubmit answer"].json()["data"]["reviewHistory"][0]["reviewedBy"] == TEAM_ID
    assert answers["campaign B"].json()["data"]["rejectedBy"] == TEAM_ID
    for label in ("admin credit", "charge credit", "capture"):
        row = answers[label].json()
        assert row["createdBy"] == row["data"]["createdBy"] == TEAM_ID and "createdByName" not in row["data"], label
    charge = answers["charge"].json()["data"]
    assert charge["confirmedBy"] == charge["receiptOverriddenBy"] == TEAM_ID and charge["status"] == "confirmed"
    assert answers["charge replay"].json()["data"]["confirmedBy"] == TEAM_ID
    assert answers["cancel replay"].json()["data"]["canceledBy"] == TEAM_ID
    by_id = {row["id"]: row["data"] for row in answers["charge list"].json()["requests"]}
    assert by_id[admin_cancelled]["canceledBy"] == TEAM_ID and by_id[self_cancelled]["canceledBy"] == user["id"]
    assert answers["plan period"].json()["createdBy"] == TEAM_ID
    assert answers["wallet summary"].json()["usd"]["spentMinor"] == 200  # the numbers are untouched

    # Staff and admins still see who did what.
    staff_view = _get(reviewer, f"/api/collections/{CAMPAIGNS}/{campaign_a}").json()["data"]
    assert staff_view["reviewedBy"] == staff_view["approvedBy"] == reviewer["id"]
    assert staff_view["reviewHistory"][0]["reviewedBy"] == reviewer["id"]
    admin_charge = _get(admin, f"/api/wallet/payment-requests/{confirmed_id}").json()["data"]
    assert admin_charge["confirmedBy"] == admin_charge["receiptOverriddenBy"] == admin["id"]
    admin_credit = _get(admin, f"/api/collections/walletTransactions/{credit.json()['id']}").json()
    assert admin_credit["createdBy"] == admin["id"] and admin_credit["data"]["createdByName"] == admin["name"]
    # Nothing stored changed.
    with db_conn() as conn:
        stored = json_loads(conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                                         {"t": CAMPAIGNS, "id": campaign_a}).scalar())
    assert stored["reviewedBy"] == reviewer["id"]


def _add_stamp(entity_type: str, entity_id: str, **fields) -> None:
    """Write fields straight into a stored row, as a later release could."""
    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": entity_type, "id": entity_id}).scalar()
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                     {"d": json_dumps({**json_loads(raw), **fields}), "t": entity_type, "id": entity_id})


def test_social_studio_answers_never_name_the_admin(staff):
    """GET /api/social-studio/pages gave the customer ``linkedBy`` = the admin's id. Every customer answer
    of the Social Studio routes now passes through the same redaction (settings, rules, pages, posts)."""
    admin = staff["admin"]
    user = _customer(staff, "social")
    api = "/api/social-studio"
    linked = client.post(f"{api}/pages/link", json={
        "ownerId": user["id"], "metaPageId": f"52{secrets.randbelow(10**11):011d}", "platform": "fb", "name": "Privacy page",
    }, cookies=admin["cookies"])
    assert linked.status_code == 200, linked.text
    assert linked.json()["linkedBy"] == admin["id"]  # the admin's own answer keeps the stamp
    page_id = linked.json()["id"]
    pages = _get(user, f"{api}/pages")
    (page,) = pages.json()["pages"]
    assert page["id"] == page_id and page["linkedBy"] == TEAM_ID and page["ownerId"] == user["id"]
    assert admin["id"] not in pages.text
    admin_pages = _get(admin, f"{api}/pages?ownerId={user['id']}").json()["pages"]
    assert [item["linkedBy"] for item in admin_pages] == [admin["id"]]

    # The other answers: a staff stamp a later release might add to a settings row, a rule or a post.
    settings_id = _get(user, f"{api}/settings").json()["id"]
    rule = client.post(f"{api}/rules", json={"name": "Thanks", "platform": "fb", "trigger": "every",
                                             "publicReply": "Thanks!"}, cookies=user["cookies"])
    post = client.post(f"{api}/posts", json={"pageIds": [page_id], "caption": "Hello Tripoli"}, cookies=user["cookies"])
    assert rule.status_code == 200 and post.status_code == 200, (rule.text, post.text)
    _add_stamp("socialStudioSettings", settings_id, checkedBy=admin["id"])
    _add_stamp("socialReplyRules", rule.json()["id"], editedBy=admin["id"])
    _add_stamp("socialPosts", post.json()["id"], approvedBy=admin["id"])
    answers = {
        "settings": _get(user, f"{api}/settings"),
        "rules": _get(user, f"{api}/rules"),
        "posts": _get(user, f"{api}/posts"),
        "post": _get(user, f"{api}/posts/{post.json()['id']}"),
        "pages": _get(user, f"{api}/pages"),
    }
    for label, response in answers.items():
        assert admin["id"] not in response.text, label
    assert answers["settings"].json()["checkedBy"] == TEAM_ID
    assert answers["rules"].json()["rules"][0]["editedBy"] == TEAM_ID
    assert answers["posts"].json()["posts"][0]["approvedBy"] == answers["post"].json()["approvedBy"] == TEAM_ID
    admin_post = _get(admin, f"{api}/posts/{post.json()['id']}?ownerId={user['id']}").json()
    assert admin_post["approvedBy"] == admin["id"]  # staff still see who did it


def test_studio_summaries_pass_through_the_redaction(staff, monkeypatch):
    """The two summary routes redact their whole answer, so a staff stamp added later never leaks."""
    user = _customer(staff, "summaries")
    stamp = {"settledBy": staff["admin"]["id"], "note": "kept"}
    real_wallet, real_campaigns = studio_wallet.wallet_summary, studio_results.campaigns_summary
    monkeypatch.setattr(studio_wallet, "wallet_summary", lambda *a: {**real_wallet(*a), "extra": dict(stamp)})
    monkeypatch.setattr(studio_results, "campaigns_summary", lambda *a: {**real_campaigns(*a), "cmp_x": dict(stamp)})
    wallet = _get(user, "/api/studio/wallet/summary").json()
    campaigns = _get(user, "/api/studio/campaigns/summary").json()
    assert wallet["extra"] == campaigns["cmp_x"] == {"settledBy": TEAM_ID, "note": "kept"}
    assert "usd" in wallet
    reviewer_view = _get(staff["reviewer"], "/api/studio/wallet/summary").json()
    assert reviewer_view["extra"]["settledBy"] == staff["admin"]["id"]


# ------------------------------------------------------------------ P1-16: anonymisation

def _seed_profile(conn, owner_id: str) -> str:
    profile_id = derived_id("stp", owner_id)
    stamp = now_ms()
    data = {"id": profile_id, "ownerId": owner_id, "whatsappNumber": "+218912345678", "whatsappConsentAt": _iso(),
            "activitySeenAt": "2027-01-01T00:00:00Z", "_lastModified": stamp}
    conn.execute(text(
        "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
        "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
    ), {"type": STUDIO_PROFILES_TYPE, "id": profile_id, "data": json_dumps(data), "stamp": stamp, "owner": owner_id})
    return profile_id


def _seed_reply_log(conn, owner_id: str, **extra) -> str:
    log_id = f"srl_{secrets.token_hex(16)}"
    stamp = now_ms()
    data = {"ownerId": owner_id, "pageId": "spg_privacy", "metaPageId": "1234567890", "platform": "fb",
            "ruleId": "srr_privacy", "commentId": f"{secrets.randbelow(10**12)}", "postId": "1234567890_1",
            "fromId": "99887766554433", "actions": ["public_reply"], "processing": False, "at": _iso(), "error": "",
            "createdBy": owner_id, "createdByName": "Owner Name", **extra}
    conn.execute(text(
        "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
        "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
    ), {"type": LOG_TYPE, "id": log_id, "data": json_dumps(data), "stamp": stamp, "owner": owner_id})
    return log_id


def _row(conn, entity_type: str, entity_id: str) -> dict:
    row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = :t AND id = :id"),
                       {"t": entity_type, "id": entity_id}).mappings().first()
    return {"data": json_loads(row["data_json"]), "last_modified": int(row["last_modified"]), "raw": row["data_json"]}


def _money_rows(conn, user_id: str) -> dict:
    """Every ledger row naming the user, with its money fields (the ledger's meaning)."""
    fields = ("type", "amountMinor", "currency", "fromUserId", "toUserId", "idempotencyKey", "status",
              "referenceType", "referenceId")
    rows = conn.execute(text("SELECT id, data_json, created_by, deleted FROM entities WHERE type = 'walletTransactions'")).mappings().all()
    out = {}
    for row in rows:
        data = json_loads(row["data_json"])
        if user_id in (data.get("fromUserId"), data.get("toUserId")):
            out[row["id"]] = ({field: data.get(field) for field in fields}, row["created_by"], bool(row["deleted"]))
    return out


def test_anonymise_scrubs_studio_personal_data(staff):
    admin = staff["admin"]
    user = _customer(staff, "anon")
    other = _customer(staff, "other")
    # Real money history: an admin credit, a confirmed charge, a transfer the customer sent.
    assert client.post("/api/wallet/top-ups", json={"userId": user["id"], "amountMinor": 4_000, "currency": "USD",
                                                    "idempotencyKey": _uid("topup-key")}, cookies=admin["cookies"]).status_code == 200
    charge_id = _payment_request(user, 2_000).json()["id"]
    assert client.post(f"/api/wallet/payment-requests/{charge_id}/confirm", json={}, cookies=admin["cookies"]).status_code == 200
    sent = client.post("/api/wallet/transfers", json={"toUserId": other["id"], "amountMinor": 500, "currency": "USD",
                                                      "idempotencyKey": _uid("transfer-key")}, cookies=user["cookies"])
    assert sent.status_code == 200, sent.text
    with db_conn() as conn:
        profile_id = _seed_profile(conn, user["id"])
        other_profile_id = _seed_profile(conn, other["id"])
        log_ids = [
            _seed_reply_log(conn, user["id"]),
            # What a later release might store about the commenter: removed as well.
            _seed_reply_log(conn, user["id"], commentText="Call me on 0912345678", fromName="Commenter Person"),
        ]
        other_log_id = _seed_reply_log(conn, other["id"])
        money_before = _money_rows(conn, user["id"])
        other_before = (_row(conn, STUDIO_PROFILES_TYPE, other_profile_id), _row(conn, LOG_TYPE, other_log_id))
    assert len(money_before) == 3

    with db_conn() as conn:
        conn.execute(text("UPDATE users SET deleted = true WHERE id = :id"), {"id": user["id"]})
    confirmation = f"ANONYMIZE {user['id']}"
    answer = client.post(f"/api/users/{user['id']}/privacy-anonymize", json={"confirmation": confirmation},
                         cookies=admin["cookies"])
    assert answer.status_code == 200, answer.text
    assert answer.json()["name"] == "Deleted user"

    with db_conn() as conn:
        profile = _row(conn, STUDIO_PROFILES_TYPE, profile_id)
        logs = [_row(conn, LOG_TYPE, log_id) for log_id in log_ids]
        # The ledger keeps every row and its meaning (only main's creator-name scrub may drop a name stamp).
        assert _money_rows(conn, user["id"]) == money_before
        # Another account's studio data is untouched.
        assert (_row(conn, STUDIO_PROFILES_TYPE, other_profile_id), _row(conn, LOG_TYPE, other_log_id)) == other_before
    assert "whatsappNumber" not in profile["data"] and "whatsappConsentAt" not in profile["data"]
    assert profile["data"]["activitySeenAt"] == "2027-01-01T00:00:00Z" and profile["data"]["_lastModified"] == profile["last_modified"]
    assert "+218912345678" not in profile["raw"]
    for log in logs:
        data = log["data"]
        assert not {"fromId", "commentText", "fromName"} & set(data), data
        assert data["actions"] == ["public_reply"] and data["commentId"] and data["ownerId"] == user["id"]
        assert "99887766554433" not in log["raw"] and "0912345678" not in log["raw"] and "Commenter Person" not in log["raw"]


def test_scrub_never_touches_the_ledger_and_repeats_as_a_no_op(staff):
    """Called on its own: every row that is not the account's studio profile or reply log stays
    byte-identical (the ledger, charges, requests), and a second run changes nothing."""
    admin = staff["admin"]
    user = _customer(staff, "scrub")
    assert client.post("/api/wallet/top-ups", json={"userId": user["id"], "amountMinor": 1_500, "currency": "USD",
                                                    "idempotencyKey": _uid("topup-key")}, cookies=admin["cookies"]).status_code == 200
    _payment_request(user, 1_000)
    campaign_id = _create(user, 1_000)
    with db_conn() as conn:
        _seed_profile(conn, user["id"])
        _seed_reply_log(conn, user["id"])
        _seed_reply_log(conn, user["id"], fromId="")  # the key alone is removed too
        _seed_reply_log(conn, user["id"], commentText="hello")

    def snapshot(conn):
        rows = conn.execute(text("SELECT type, id, data_json, last_modified, deleted, created_by FROM entities "
                                 "WHERE type NOT IN (:profiles, :log) ORDER BY type, id"),
                            {"profiles": STUDIO_PROFILES_TYPE, "log": LOG_TYPE}).mappings().all()
        return [dict(row) for row in rows]

    with db_conn() as conn:
        before = snapshot(conn)
        assert any(row["id"] == campaign_id for row in before)
        assert scrub_studio_personal_data_conn(conn, user["id"]) == {"profiles": 1, "replyLog": 3, "tickets": 0}
    with db_conn() as conn:
        assert snapshot(conn) == before
        studio_rows = conn.execute(text("SELECT id, data_json, last_modified FROM entities WHERE type IN (:p, :l) AND created_by = :uid"),
                                   {"p": STUDIO_PROFILES_TYPE, "l": LOG_TYPE, "uid": user["id"]}).mappings().all()
        assert scrub_studio_personal_data_conn(conn, user["id"]) == {"profiles": 0, "replyLog": 0, "tickets": 0}
        assert scrub_studio_personal_data_conn(conn, "") == {"profiles": 0, "replyLog": 0, "tickets": 0}
    with db_conn() as conn:
        again = conn.execute(text("SELECT id, data_json, last_modified FROM entities WHERE type IN (:p, :l) AND created_by = :uid"),
                             {"p": STUDIO_PROFILES_TYPE, "l": LOG_TYPE, "uid": user["id"]}).mappings().all()
    assert [dict(row) for row in again] == [dict(row) for row in studio_rows]


def test_studio_profiles_are_router_only(staff):
    """The profile holds a phone number: the generic collections API refuses its type (P2-07 adds its route)."""
    assert STUDIO_PROFILES_TYPE in OWNED_TYPES and STUDIO_PROFILES_TYPE in SOCIAL_STUDIO_COLLECTIONS
    base = f"/api/collections/{STUDIO_PROFILES_TYPE}"
    admin = staff["admin"]["cookies"]
    answers = [
        client.get(base, cookies=admin),
        client.post(base, json={"id": "stp_forged", "data": {"whatsappNumber": "+218900000000"}}, cookies=admin),
    ]
    for response in answers:
        assert response.status_code == 404 and response.json()["detail"] == "Unknown collection", response.text


# ------------------------------------------------------------------ PostgreSQL scenario (studio_privacy_scrub)

def postgres_scrub_race() -> None:
    """P1-16 on real PostgreSQL, run by test_postgres_financial_review.py (scenario
    ``studio_privacy_scrub``): the anonymisation (with the studio scrub in its transaction) and a
    Social Studio worker write to the same reply-log row, in both orders. Neither waits forever
    (lock_timeout 5 s), the worker's write lands, the commenter id never comes back, the profile
    loses its number and the ledger rows naming the account stay byte-identical."""
    from sqlalchemy import event

    from server.db import get_engine
    from server.main import _privacy_anonymize_deleted_user_atomic, patch_entity

    engine = get_engine()
    assert engine.dialect.name == "postgresql"

    def someone_waits_for_a_lock() -> bool:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            with engine.connect() as probe:
                waiting = probe.execute(text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )).scalar()
            if waiting:
                return True
            time.sleep(0.05)
        return False

    for order in ("worker_first", "anonymise_first"):
        with db_conn() as conn:
            admin = _insert_user_row(conn, f"pg-admin-{order}", "Admin", {}, "PG Admin")
            owner = _insert_user_row(conn, f"pg-owner-{order}", "Employee", CUSTOMER_PERMISSIONS, "PG Owner")
            profile_id = _seed_profile(conn, owner["id"])
            log_id = _seed_reply_log(conn, owner["id"])
            ledger_ids = []
            for index, (sender, receiver) in enumerate(((None, owner["id"]), (owner["id"], "system"))):
                row_id = f"pg_privacy_tx_{order}_{index}"
                conn.execute(text(
                    "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                    "VALUES ('walletTransactions', :id, :data, false, 1, :admin, 1)"
                ), {"id": row_id, "admin": admin["id"], "data": json_dumps({
                    "type": "credit" if sender is None else "campaign_payment", "amountMinor": 700, "currency": "USD",
                    "fromUserId": sender, "toUserId": receiver, "idempotencyKey": f"pg-privacy-{order}-{index}",
                    "status": "posted", "createdBy": admin["id"], "createdByName": "PG Admin"})})
                ledger_ids.append(row_id)
            conn.execute(text("UPDATE users SET deleted = true WHERE id = :id"), {"id": owner["id"]})

        def ledger() -> list:
            with db_conn() as conn:
                return [dict(conn.execute(text("SELECT data_json, last_modified, created_by FROM entities WHERE id = :id"),
                                          {"id": row_id}).mappings().one()) for row_id in ledger_ids]

        money_before = ledger()
        first_holds, holder = Event(), []

        def after_execute(conn, cursor, statement, parameters, context, executemany):
            if "FOR UPDATE" not in statement or not isinstance(parameters, dict) or holder:
                return
            worker_lock = parameters.get("type") == LOG_TYPE and parameters.get("id") == log_id
            anonymiser_lock = parameters.get("id") == owner["id"] and "pat" in parameters
            if (order == "worker_first" and worker_lock) or (order == "anonymise_first" and anonymiser_lock):
                holder.append(conn)
                first_holds.set()
                assert someone_waits_for_a_lock(), f"{order}: the second writer never waited for the row"

        def worker():
            return patch_entity(LOG_TYPE, log_id, {"processing": False, "error": f"late worker {order}"}, owner["id"])

        def anonymise():
            return _privacy_anonymize_deleted_user_atomic(owner["id"])

        first, second = (worker, anonymise) if order == "worker_first" else (anonymise, worker)
        event.listen(engine, "after_cursor_execute", after_execute)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first_done = pool.submit(first)
                assert first_holds.wait(10), f"{order}: the first writer never took the row"
                second_done = pool.submit(second)
                results = [first_done.result(timeout=30), second_done.result(timeout=30)]
        finally:
            event.remove(engine, "after_cursor_execute", after_execute)
        anonymised = results[1] if order == "worker_first" else results[0]
        assert anonymised["name"] == "Deleted user", anonymised
        with db_conn() as conn:
            log = _row(conn, LOG_TYPE, log_id)
            profile = _row(conn, STUDIO_PROFILES_TYPE, profile_id)
        assert log["data"]["error"] == f"late worker {order}" and log["data"]["processing"] is False, log
        assert "fromId" not in log["data"] and "99887766554433" not in log["raw"], log
        assert "whatsappNumber" not in profile["data"] and "whatsappConsentAt" not in profile["data"], profile
        assert ledger() == money_before
