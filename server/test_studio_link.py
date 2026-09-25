"""Albayan Studio: the studio code at approval and the LINK step (P1-09, P3-02, P0-09b; owner decision D26).

* Approval stamps a unique ``studioRef`` and ``studioName`` ("<studioRef> · <request name>").
* ``POST /api/ad-studio/campaigns/{id}/publish-status`` with ``metaAdAccountId`` + ``metaCampaignId``
  links the Approved request to a Meta campaign: allowlisted account, the campaign exists there, no
  other request claimed it; renamed in Meta to the studio name when the stored token reading shows
  ``ads_management``, else 409 NEEDS_MANUAL_RENAME; claims the campaign (discovery, import and
  Manager's link skip it) and removes Manager's untouched copies.

Meta is always faked (a fake client for the routes, httpx.MockTransport for the real client's
requests). Every test creates its own users, requests and Meta ids (unique per run).
"""

import hashlib
import hmac
import os
import secrets
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
import server.meta_ads as meta_ads
import server.meta_token_health as token_health
from server import meta_collisions, wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_actions as actions
from server.systems.ads_studio.studio_types import (
    STUDIO_NAME_SEPARATOR,
    is_studio_ref,
    studio_campaign_name,
    studio_ref,
)

TAG = secrets.token_hex(4)
PASSWORD = "StudioLinkPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
ACCOUNT = "4441" + f"{int(TAG, 16) % 10**8:08d}"
OTHER_ACCOUNT = "5551" + f"{int(TAG, 16) % 10**8:08d}"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
_counter = [0]


def _uid(prefix: str) -> str:
    _counter[0] += 1
    return f"{prefix}_{TAG}_{_counter[0]}"


def _meta_id() -> str:
    """A Meta campaign id of its own for every link (a campaign never serves two requests)."""
    _counter[0] += 1
    return f"1209{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


# ------------------------------------------------------------------ people and requests

def _insert_user(label: str, role: str, permissions: dict) -> dict:
    stamp = now_ms()
    user_id = new_id("link_user")
    email = f"studio-link-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Link {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


@pytest.fixture(scope="module", autouse=True)
def _remove_manager_copies_afterwards():
    """The Manager copies these tests write never outlive the module (later modules count core ads)."""
    init_db()
    yield
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'ads' AND id LIKE :prefix"), {"prefix": f"ad_link_{TAG}_%"})


@pytest.fixture(scope="module")
def staff():
    init_db()
    people = {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }
    customer = _insert_user("customer", "Employee", CUSTOMER_PERMISSIONS)
    bought = client.post("/api/subscriptions/purchase", json={"serviceId": "ad_maker", "idempotencyKey": _uid("sub")},
                         cookies=customer["cookies"])
    assert bought.status_code == 200, bought.text
    funded = client.post("/api/wallet/top-ups", json={"userId": customer["id"], "amountMinor": 50_000_000,
                                                      "currency": "USD", "idempotencyKey": _uid("topup")},
                         cookies=people["admin"]["cookies"])
    assert funded.status_code == 200, funded.text
    people["customer"] = customer
    return people


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch, staff):
    """The flows below make many changes quickly; the link's own limit has its own test."""
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)
    monkeypatch.setattr(actions, "check_rate_limit", lambda *a, **k: (True, 1, 0))
    for who in ("customer", "reviewer"):  # main's campaign image checks (24 a minute per account)
        reset_rate_limit(f"ad-studio:media:{staff[who]['id']}")


def _last_modified(campaign_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT last_modified FROM entities WHERE type = :t AND id = :id"),
                                {"t": CAMPAIGNS, "id": campaign_id}).scalar())


def _data(campaign_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).scalar()
    return json_loads(row) or {}


def _create(staff, name: str, budget: int = 2500, budget_type: str = "lifetime", campaign_id: str = "") -> str:
    campaign_id = campaign_id or _uid("lcmp")
    body = {
        "name": name, "objective": "messages", "platforms": ["facebook", "instagram"], "pageName": "Link Test Page",
        "primaryText": "Message us for this week's offer.", "headline": "Weekly offer", "description": "Link test.",
        "callToAction": "Send Message", "destination": "https://wa.me/218910000000", "locations": ["Tripoli, Libya"],
        "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"], "interests": ["Shopping"],
        "startDate": "2027-01-10", "endDate": "2027-01-19", "budgetMinorUSD": budget, "budgetType": budget_type,
        "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }
    response = client.post(f"/api/collections/{CAMPAIGNS}", json={"id": campaign_id, "data": body},
                           cookies=staff["customer"]["cookies"])
    assert response.status_code == 200, response.text
    return campaign_id


def _submit(staff, campaign_id: str) -> None:
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                           json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                           cookies=staff["customer"]["cookies"])
    assert response.status_code == 200, response.text


def _approve(staff, campaign_id: str, op: str = ""):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": "Approved", "note": "",
        "operationId": op or _uid("review-op"),
    }, cookies=staff["reviewer"]["cookies"])


def _approved(staff, name: str = "", **create) -> str:
    campaign_id = _create(staff, name or f"Spring offer {_uid('n')}", **create)
    _submit(staff, campaign_id)
    approved = _approve(staff, campaign_id)
    assert approved.status_code == 200, approved.text
    return campaign_id


def _link(staff, campaign_id: str, meta_id: str, *, account: str = ACCOUNT, op: str = "", version=None,
          who: str = "reviewer", http=None):
    return (http or client).post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedVersion": _last_modified(campaign_id) if version is None else version,
        "operationId": op or _uid("link-op"), "metaAdAccountId": account, "metaCampaignId": meta_id,
    }, cookies=staff[who]["cookies"])


def _audit_rows(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        return [json_loads(row[0]) or {} for row in conn.execute(
            text("SELECT metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
            {"id": resource_id, "action": action},
        )]


# ------------------------------------------------------------------ fake Meta and the stored token reading

class FakeMeta:
    """The Meta client as the link step and discovery use it (no network)."""

    def __init__(self):
        self.campaigns: dict[str, dict] = {}
        self.reads: list[str] = []
        self.renames: list[tuple[str, str]] = []
        self.read_error = None
        self.rename_error = None
        self.after_read = None
        self.rows: list[dict] = []
        self.snapshots: dict[str, dict] = {}

    def add(self, meta_id: str, name: str = "Spring promo", **fields) -> str:
        self.campaigns[meta_id] = {"name": name, "accountId": ACCOUNT, "currency": "USD", **fields}
        return meta_id

    def get_campaign(self, campaign_id):
        self.reads.append(str(campaign_id))
        if self.read_error is not None:
            raise self.read_error
        found = self.campaigns.get(str(campaign_id))
        if found is None:
            raise meta_ads.MetaAdsError("not_found", "not found", provider_code="100.33")
        result = {
            "id": str(campaign_id), "name": found["name"], "accountId": found["accountId"], "effectiveStatus": "ACTIVE",
            "dailyBudgetMinor": found.get("daily", 0), "lifetimeBudgetMinor": found.get("lifetime", 0),
            "adSetDailyBudgetMinor": found.get("adset_daily", 0), "adSetLifetimeBudgetMinor": found.get("adset_lifetime", 0),
            "currency": found["currency"],
        }
        if self.after_read is not None:
            self.after_read()
        return result

    def rename_campaign(self, campaign_id, name):
        if self.rename_error is not None:
            raise self.rename_error
        self.renames.append((str(campaign_id), str(name)))
        self.campaigns[str(campaign_id)]["name"] = str(name)

    # Discovery and Manager's link route
    def list_ads(self, account_id, search="", *, max_pages=5):
        return list(self.rows)

    def _get_account(self, account_id):
        return {"id": str(account_id), "name": "Albayan", "currency": "USD"}

    def get_campaign_name(self, campaign_id):
        return self.campaigns.get(str(campaign_id), {}).get("name", "")

    def get_ad_snapshot(self, meta_ad_id):
        return dict(self.snapshots[str(meta_ad_id)])


@pytest.fixture()
def meta(monkeypatch):
    fake = FakeMeta()
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"link-token-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", f"link-secret-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_ID", "123456789012345")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    saved = meta_ads.load_meta_health_state("token")
    _grant(None)
    yield fake
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'metaHealthState' AND id = 'token'"))
    if saved:
        meta_ads.save_meta_health_state("token", lambda _current: saved)


def _grant(scopes, *, coverage=None, valid=True, days_left=None, other_token=False) -> None:
    """Store a token reading (what P0-14 keeps) for the configured token; None = no reading at all."""
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'metaHealthState' AND id = 'token'"))
    if scopes is None:
        return
    config = meta_ads.load_meta_ads_config()
    fingerprint = "0" * 16 if other_token else token_health._token_fingerprint(config)
    expires = ""
    if days_left is not None:
        expires = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + days_left * 86400 + 3600,
                                         timezone.utc).isoformat().replace("+00:00", "Z")
    reading = {
        "isValid": valid, "type": "SYSTEM_USER", "appMatches": True, "expiresAt": expires, "expiresNever": not expires,
        "scopes": list(scopes), "pagesCoveredByScope": coverage or {},
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "tokenFingerprint": fingerprint,
    }
    meta_ads.save_meta_health_state("token", lambda _current: reading)


# ------------------------------------------------------------------ P1-09: the studio code at approval

def test_studio_name_keeps_the_code_and_fits_meta():
    ref = studio_ref("cmp_name_test")
    assert studio_campaign_name(ref, "Spring offer") == f"{ref}{STUDIO_NAME_SEPARATOR}Spring offer"
    assert studio_campaign_name(ref.lower(), "  Summer \n\t sale <b>now</b> ") == f"{ref} · Summer sale bnow/b"
    assert studio_campaign_name(ref, "") == ref and studio_campaign_name(ref, None) == ref
    long = studio_campaign_name(ref, "عرض " * 200)
    assert long.startswith(f"{ref} · عرض") and len(long) <= meta_ads.STUDIO_CAMPAIGN_NAME_MAX
    assert meta_ads.is_studio_campaign_name(long)
    with pytest.raises(ValueError):
        studio_campaign_name("ALB-S-0000", "x")


def test_studio_ref_assigned_on_approve_unique(staff):
    first = _approved(staff, "Shoes for Salma")
    second = _approved(staff, "Bags for Huda")
    a, b = _data(first), _data(second)
    assert is_studio_ref(a["studioRef"]) and is_studio_ref(b["studioRef"]) and a["studioRef"] != b["studioRef"]
    assert a["studioRef"] == studio_ref(first) and a["studioName"] == f"{a['studioRef']} · Shoes for Salma"
    assert b["studioName"] == f"{b['studioRef']} · Bags for Huda"
    assert _audit_rows(first, "review")[-1]["studioRef"] == a["studioRef"]

    # The code of attempt 0 is already carried by another request (archived too): the next one is used.
    third = _create(staff, "Dresses for Amal")
    taken = studio_ref(third)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:t,:id,:d,true,:s,NULL,:s)"),
            {"t": CAMPAIGNS, "id": _uid("holder"), "d": json_dumps({"status": "Stopped", "studioRef": taken}), "s": now_ms()},
        )
    _submit(staff, third)
    op = _uid("review-op")
    approved = _approve(staff, third, op)
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["studioRef"] == studio_ref(third, 1) != taken
    assert approved.json()["data"]["studioName"] == f"{studio_ref(third, 1)} · Dresses for Amal"
    # A replay of the approval returns the stored code; nothing is assigned twice.
    replay = client.post(f"/api/ad-studio/campaigns/{third}/review", json={
        "expectedLastModified": 0, "decision": "Approved", "note": "", "operationId": op,
    }, cookies=staff["reviewer"]["cookies"])
    assert replay.status_code == 200 and replay.json()["data"]["studioRef"] == studio_ref(third, 1)


def test_customer_cannot_write_studio_fields(staff):
    campaign_id = _create(staff, "Forged code")
    forged = client.patch(f"/api/collections/{CAMPAIGNS}/{campaign_id}",
                          json={"data": {"studioRef": "ALB-S-AAAAAAAA"}}, cookies=staff["customer"]["cookies"])
    assert forged.status_code in (400, 403), forged.text
    assert "studioRef" not in _data(campaign_id)


# ------------------------------------------------------------------ P3-02 / P0-09b: the link step

def test_link_when_the_name_already_carries_the_code(staff, meta):
    campaign_id = _approved(staff, "Code typed by hand")
    ref = _data(campaign_id)["studioRef"]
    meta_id = meta.add(_meta_id(), f"summer {ref.lower()} promo", lifetime=2500)
    linked = _link(staff, campaign_id, meta_id)
    assert linked.status_code == 200, linked.text
    body = linked.json()
    assert body["renamed"] is False and body["removedManagerCopies"] == 0 and body["warnings"] == []
    assert body["studioRef"] == ref and body["studioName"] == f"{ref} · Code typed by hand"
    data = body["data"]
    assert data["publishStatus"] == "meta_review" and data["metaCampaignId"] == meta_id
    assert data["metaAdAccountId"] == f"act_{ACCOUNT}" and data["linkedAt"] and data["linkedBy"] == staff["reviewer"]["id"]
    assert data["metaCampaignName"] == f"summer {ref.lower()} promo"
    assert meta.renames == []
    audit = _audit_rows(campaign_id, "publish_status")[-1]
    assert audit["renamed"] is False and audit["metaCampaignId"] == meta_id and audit["publishStatus"] == "meta_review"
    # The customer sees the link as the team's, never a staff id.
    own = client.get(f"/api/collections/{CAMPAIGNS}/{campaign_id}", cookies=staff["customer"]["cookies"])
    assert own.status_code == 200 and own.json()["data"]["linkedBy"] == "team"


def test_link_renames_in_meta_with_ads_management(staff, meta):
    _grant(["ads_read", "ads_management"])
    campaign_id = _approved(staff, "Renamed on link")
    meta_id = meta.add(_meta_id(), "Draft made by staff")
    linked = _link(staff, campaign_id, meta_id)
    assert linked.status_code == 200, linked.text
    name = _data(campaign_id)["studioName"]
    assert meta.renames == [(meta_id, name)]
    assert linked.json()["renamed"] is True and linked.json()["data"]["metaCampaignName"] == name
    assert _audit_rows(campaign_id, "publish_status")[-1]["renamed"] is True


def test_link_accepts_the_act_prefix_and_expected_last_modified(staff, meta):
    campaign_id = _approved(staff)
    ref = _data(campaign_id)["studioRef"]
    meta_id = meta.add(_meta_id(), ref)
    linked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("link-op"),
        "metaAdAccountId": f"act_{ACCOUNT}", "metaCampaignId": meta_id, "publishStatus": "meta_review",
    }, cookies=staff["reviewer"]["cookies"])
    assert linked.status_code == 200, linked.text


@pytest.mark.parametrize("reading", [
    {"scopes": None},                                                   # never checked
    {"scopes": ["ads_read"]},                                           # no ads_management
    {"scopes": ["ads_management"], "valid": False},                     # invalid token
    {"scopes": ["ads_management"], "other_token": True},                # a reading of an earlier token
    {"scopes": ["ads_management"], "days_left": -2},                    # expired
    {"scopes": ["ads_management"], "coverage": {"ads_management": {"allTargets": False, "targetIds": ["999"]}}},
])
def test_link_without_permission_asks_for_a_manual_rename(staff, meta, reading):
    _grant(reading.pop("scopes"), **reading)
    campaign_id = _approved(staff, "Manual rename")
    before = _last_modified(campaign_id)
    meta_id = meta.add(_meta_id(), "Draft made by staff")
    refused = _link(staff, campaign_id, meta_id)
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    data = _data(campaign_id)
    assert detail == {"code": "NEEDS_MANUAL_RENAME", "message": actions.REFUSE_NEEDS_MANUAL_RENAME,
                      "studioRef": data["studioRef"], "studioName": data["studioName"]}
    assert meta.renames == [] and _last_modified(campaign_id) == before and not data.get("metaCampaignId")

    # Staff paste the copied name in Ads Manager; the next link takes it as it is.
    meta.campaigns[meta_id]["name"] = detail["studioName"]
    linked = _link(staff, campaign_id, meta_id)
    assert linked.status_code == 200, linked.text
    assert linked.json()["renamed"] is False and meta.renames == []


def test_token_scope_rules(monkeypatch):
    base = {"configured": True, "checked": True, "stale": False, "isValid": True, "scopes": ["ads_management"],
            "daysLeft": None, "pagesCoveredByScope": {}}
    cases = [
        ({}, True),
        ({"pagesCoveredByScope": {"ads_management": {"allTargets": True, "targetIds": []}}}, True),
        ({"pagesCoveredByScope": {"ads_management": {"allTargets": False, "targetIds": [ACCOUNT]}}}, True),
        ({"pagesCoveredByScope": {"ads_management": {"allTargets": False, "targetIds": ["1"]}}}, False),
        ({"scopes": ["ads_read"]}, False),
        ({"checked": False}, False),
        ({"stale": True}, False),
        ({"isValid": False}, False),
        ({"configured": False}, False),
        ({"daysLeft": -1}, False),
        ({"daysLeft": 3}, True),
    ]
    for change, expected in cases:
        monkeypatch.setattr(token_health, "token_health_report", lambda change=change: {**base, **change})
        assert meta_ads.studio_token_can_manage_ads(f"act_{ACCOUNT}") is expected, change
    assert meta_ads.studio_token_can_manage_ads("not-an-account") is False


def test_a_rename_meta_refuses_falls_back_and_a_busy_meta_writes_nothing(staff, meta):
    _grant(["ads_management"])
    campaign_id = _approved(staff, "Rename refused")
    before = _last_modified(campaign_id)
    meta_id = meta.add(_meta_id(), "Draft")
    meta.rename_error = meta_ads.MetaAdsError("request_failed", "(#200) Permissions error", provider_code="200")
    refused = _link(staff, campaign_id, meta_id)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "NEEDS_MANUAL_RENAME", refused.text
    meta.rename_error = meta_ads.MetaAdsError("rate_limited", "limited", retryable=True, provider_code="80004")
    busy = _link(staff, campaign_id, meta_id)
    assert busy.status_code == 503 and busy.json()["detail"].startswith(actions.REFUSE_LINK_META_BUSY), busy.text
    assert int(busy.headers["Retry-After"]) >= 1
    assert _last_modified(campaign_id) == before and not _data(campaign_id).get("metaCampaignId")
    assert _audit_rows(campaign_id, "publish_status") == []


def test_meta_campaign_linked_once(staff, meta):
    first, second = _approved(staff, "First owner"), _approved(staff, "Second owner")
    meta_id = meta.add(_meta_id(), _data(first)["studioRef"])
    assert _link(staff, first, meta_id).status_code == 200
    # The same Meta campaign never serves a second request: by the link step ...
    meta.campaigns[meta_id]["name"] = f"{_data(first)['studioRef']} {_data(second)['studioRef']}"
    taken = _link(staff, second, meta_id)
    assert taken.status_code == 409 and taken.json()["detail"] == actions.REFUSE_LINK_TAKEN, taken.text
    # ... nor by the classic marker with a Meta id.
    marker = client.post(f"/api/ad-studio/campaigns/{second}/publish-status", json={
        "expectedLastModified": _last_modified(second), "operationId": _uid("mark-op"), "publishStatus": "live",
        "metaCampaignId": meta_id,
    }, cookies=staff["reviewer"]["cookies"])
    assert marker.status_code == 409 and marker.json()["detail"] == actions.REFUSE_LINK_TAKEN, marker.text
    assert not _data(second).get("metaCampaignId")
    # A linked request cannot be moved to another campaign without clearing the link first.
    other = meta.add(_meta_id(), _data(first)["studioRef"])
    relink = _link(staff, first, other)
    assert relink.status_code == 409 and relink.json()["detail"] == actions.REFUSE_LINK_RELINK, relink.text
    # Linking the same campaign again (a second press) changes nothing.
    again = _link(staff, first, meta_id)
    assert again.status_code == 200 and again.json()["data"]["metaCampaignId"] == meta_id
    assert len(_audit_rows(first, "publish_status")) == 1


def test_classic_marker_with_a_new_meta_id_claims_it(staff, meta):
    campaign_id = _approved(staff, "Classic marker")
    meta_id = _meta_id()
    copy = _manager_copy(meta_id, "classic")
    marked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("mark-op"), "publishStatus": "live",
        "metaCampaignId": meta_id,
    }, cookies=staff["reviewer"]["cookies"])
    assert marked.status_code == 200, marked.text
    assert marked.json()["data"]["publishStatus"] == "live" and marked.json()["data"]["metaCampaignId"] == meta_id
    assert _ad_deleted(copy) is True
    assert _audit_rows(campaign_id, "publish_status")[-1]["removedManagerCopies"] == 1
    cleared = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("mark-op"), "publishStatus": "",
    }, cookies=staff["reviewer"]["cookies"])
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["data"]["metaCampaignId"] == "" and cleared.json()["data"]["metaAdAccountId"] == ""
    marker_meta_review = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("mark-op"), "publishStatus": "meta_review",
    }, cookies=staff["reviewer"]["cookies"])
    assert marker_meta_review.status_code == 400, marker_meta_review.text


def test_a_request_the_marker_tied_to_a_campaign_is_linked_for_real(staff, meta):
    campaign_id = _approved(staff, "Marker first")
    meta_id = meta.add(_meta_id(), "Draft typed by staff")
    marked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("mark-op"), "publishStatus": "live",
        "metaCampaignId": meta_id,
    }, cookies=staff["reviewer"]["cookies"])
    assert marked.status_code == 200 and not marked.json()["data"].get("linkedAt"), marked.text
    _grant(["ads_management"])
    linked = _link(staff, campaign_id, meta_id)
    assert linked.status_code == 200, linked.text
    data = linked.json()["data"]
    assert data["publishStatus"] == "meta_review" and data["linkedAt"] and data["metaAdAccountId"] == f"act_{ACCOUNT}"
    assert linked.json()["renamed"] is True and meta.renames == [(meta_id, data["studioName"])]
    again = _link(staff, campaign_id, meta_id)
    assert again.status_code == 200 and again.json()["data"]["linkedAt"] == data["linkedAt"]
    assert len(meta.renames) == 1


def test_link_validation_refusals(staff, meta, monkeypatch):
    campaign_id = _approved(staff, "Validation")
    ref = _data(campaign_id)["studioRef"]
    good = meta.add(_meta_id(), ref)

    def detail(response):
        return response.json()["detail"]

    assert _link(staff, campaign_id, good, who="customer").status_code == 403
    for bad_account in ("act_", "12a", "act_x1"):
        response = _link(staff, campaign_id, good, account=bad_account)
        assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_BAD_ACCOUNT_ID, response.text
    response = _link(staff, campaign_id, "12 34")
    assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_BAD_CAMPAIGN_ID
    response = _link(staff, campaign_id, good, account=OTHER_ACCOUNT)
    assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_ACCOUNT
    response = _link(staff, campaign_id, _meta_id())
    assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_NOT_FOUND
    elsewhere = meta.add(_meta_id(), ref, accountId=OTHER_ACCOUNT)
    response = _link(staff, campaign_id, elsewhere)
    assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_WRONG_ACCOUNT
    foreign = meta.add(_meta_id(), "ALB-S-ZZZZZZZZ · someone else's ad")
    _grant(["ads_management"])
    response = _link(staff, campaign_id, foreign)
    assert response.status_code == 409 and detail(response) == actions.REFUSE_LINK_OTHER_CODE
    response = _link(staff, campaign_id, good, version=1)
    assert response.status_code == 409 and detail(response) == "Conflict: record has changed"
    meta.read_error = meta_ads.MetaAdsError("rate_limited", "paused", retryable=True)
    response = _link(staff, campaign_id, good)
    assert response.status_code == 503 and detail(response).startswith(actions.REFUSE_LINK_META_BUSY)
    meta.read_error = meta_ads.MetaAdsError("authorization", "Meta authorization failed.", provider_code="190")
    response = _link(staff, campaign_id, good)
    assert response.status_code == 502 and detail(response).startswith(actions.REFUSE_LINK_META_FAILED)
    meta.read_error = None
    assert meta.renames == [] and not _data(campaign_id).get("metaCampaignId")

    # Only an Approved request is linked; a private draft stays invisible.
    waiting = _create(staff, "Still waiting")
    _submit(staff, waiting)
    response = _link(staff, waiting, good)
    assert response.status_code == 409 and detail(response) == actions.REFUSE_LINK_NOT_APPROVED
    draft = _create(staff, "Private draft")
    assert _link(staff, draft, good).status_code == 404
    # No Meta connection, or an empty allowlist: fail closed before any Meta call.
    reads = len(meta.reads)
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "")
    response = _link(staff, campaign_id, good)
    assert response.status_code == 400 and detail(response) == actions.REFUSE_LINK_ACCOUNT
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    response = _link(staff, campaign_id, good)
    assert response.status_code == 503 and detail(response) == actions.REFUSE_LINK_NOT_CONFIGURED
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"link-token-{TAG}-never-leaks")
    assert len(meta.reads) == reads
    # The link succeeds once everything is right.
    assert _link(staff, campaign_id, good).status_code == 200


def test_link_budget_above_paid_warning(staff, meta):
    lifetime = _approved(staff, "Lifetime budget", budget=2500)
    ref = _data(lifetime)["studioRef"]
    above = _link(staff, lifetime, meta.add(_meta_id(), ref, lifetime=3000))
    assert above.status_code == 200 and above.json()["warnings"] == [actions.LINK_WARNING_BUDGET_ABOVE_PAID]
    assert above.json()["data"]["metaLinkResult"]["metaBudgetMinor"] == 3000
    assert _audit_rows(lifetime, "publish_status")[-1]["warnings"] == [actions.LINK_WARNING_BUDGET_ABOVE_PAID]

    daily = _approved(staff, "Daily budget", budget=500, budget_type="daily")  # $5 x 10 days = $50 paid
    ref = _data(daily)["studioRef"]
    within = _link(staff, daily, meta.add(_meta_id(), ref, daily=500))
    assert within.status_code == 200 and within.json()["warnings"] == []
    assert within.json()["data"]["metaLinkResult"]["metaBudgetMinor"] == 5000

    for fields, warned in (({"adset_daily": 600}, True), ({"lifetime": 9000, "currency": "EUR"}, False), ({}, False)):
        campaign_id = _approved(staff, "Ad set budgets", budget=500, budget_type="daily")
        response = _link(staff, campaign_id, meta.add(_meta_id(), _data(campaign_id)["studioRef"], **fields))
        assert response.status_code == 200, response.text
        assert (response.json()["warnings"] == [actions.LINK_WARNING_BUDGET_ABOVE_PAID]) is warned, fields


def test_link_replay_returns_the_first_result(staff, meta):
    _grant(["ads_management"])
    campaign_id = _approved(staff, "Replay")
    meta_id = meta.add(_meta_id(), "Draft for replay", lifetime=99_999)
    _manager_copy(meta_id, "replay")
    op = _uid("link-op")
    version = _last_modified(campaign_id)
    first = _link(staff, campaign_id, meta_id, op=op, version=version)
    assert first.status_code == 200, first.text
    replay = _link(staff, campaign_id, meta_id, op=op, version=version)
    assert replay.status_code == 200, replay.text
    for key in ("renamed", "removedManagerCopies", "keptManagerCopies", "warnings", "studioRef", "studioName", "lastModified"):
        assert replay.json()[key] == first.json()[key], key
    assert first.json()["renamed"] is True and first.json()["removedManagerCopies"] == 1
    assert len(meta.renames) == 1 and len(_audit_rows(campaign_id, "publish_status")) == 1
    reused = _link(staff, campaign_id, meta.add(_meta_id(), "x"), op=op, version=version)
    assert reused.status_code == 409 and reused.json()["detail"] == "operationId was already used for another update"


def test_link_rate_limit(staff, meta, monkeypatch):
    campaign_id = _approved(staff, "Rate")
    monkeypatch.setattr(actions, "check_rate_limit", lambda *a, **k: (False, 0, 12_000))
    limited = _link(staff, campaign_id, meta.add(_meta_id(), "x"))
    assert limited.status_code == 429 and limited.json()["detail"].startswith(actions.REFUSE_LINK_RATE)
    assert limited.headers["Retry-After"] == "12"


# ------------------------------------------------------------------ Manager's copies, discovery and import (D26)

def _manager_copy(meta_campaign_id: str, label: str, **extra) -> str:
    """A core ad exactly as Meta's automatic import writes it, for this Meta campaign."""
    ad_id = f"ad_link_{TAG}_{label}_{_uid('c')}"
    data = {
        "recordType": "ad", "customerId": "", "customerName": "", "pageId": "", "pageName": "",
        "amountUSD": 0.0, "amountLocal": 0.0, "exchangeRate": 0.0, "paymentStatus": "pending_setup",
        "collectionMethod": "", "collectionPayments": [], "receiptAllocations": [], "dueAllocations": [],
        "mergedPaidAllocations": [], "receiptIds": [], "fundingReceiptId": "", "receiptId": "",
        "linkedDeliveryReceiptId": "", "dueAmountToUseUSD": 0.0, "hasMergedPaidFunds": False, "status": "Active",
        "deliveryStatus": "Office", "deliveryPersonId": "", "startDate": "2026-09-20", "creatorId": "system",
        "metaImportState": "needs_completion", "metaImportSource": "meta_ads", "editHistory": [], "editCount": 0,
        "metaAdId": f"77{_counter[0]:013d}", "metaCampaignId": meta_campaign_id, "metaCampaignName": "Draft",
        **extra,
    }
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:d,false,:s,NULL,:s)"),
            {"id": ad_id, "d": json_dumps(data), "s": stamp},
        )
    return ad_id


def _ad_deleted(ad_id: str) -> bool:
    with db_conn() as conn:
        return bool(conn.execute(text("SELECT deleted FROM entities WHERE type = 'ads' AND id = :id"), {"id": ad_id}).scalar())


def test_link_removes_only_untouched_manager_copies(staff, meta):
    campaign_id = _approved(staff, "Copies")
    meta_id = meta.add(_meta_id(), _data(campaign_id)["studioRef"])
    untouched = _manager_copy(meta_id, "untouched")
    paid = _manager_copy(meta_id, "paid", receiptId="rcpt_1", paymentStatus="paid")
    edited = _manager_copy(meta_id, "edited", editCount=2)
    customer = _manager_copy(meta_id, "customer", customerId="cust_1")
    elsewhere = _manager_copy(_meta_id(), "elsewhere")
    linked = _link(staff, campaign_id, meta_id)
    assert linked.status_code == 200, linked.text
    assert linked.json()["removedManagerCopies"] == 1 and linked.json()["keptManagerCopies"] == 3
    assert _ad_deleted(untouched) is True
    assert not any(_ad_deleted(ad) for ad in (paid, edited, customer, elsewhere))

    repair_id = _audit_rows(campaign_id, "publish_status")[-1]["collisionRepairId"]
    summary = _audit_rows(repair_id, "collision_repair")[-1]
    assert summary["trigger"] == "studio_link" and summary["metaCampaignId"] == meta_id
    assert [item["adId"] for item in summary["removed"]] == [untouched]
    reasons = {item["adId"]: item["reason"] for item in summary["reported"]}
    assert reasons == {paid: "has_money", edited: "edited", customer: "edited"}
    assert _audit_rows(untouched, "collision_repair")[-1]["repairId"] == repair_id
    # The summary is a reversal record: the owner's tool can bring the removed copy back.
    with db_conn() as conn:
        restored = meta_collisions.reverse_repair(conn, summary)
    assert restored["restored"] == [untouched] and _ad_deleted(untouched) is False


def test_remove_untouched_copies_keeps_the_owners_choice(staff):
    meta_id = _meta_id()
    kept = _manager_copy(meta_id, "kept")
    with db_conn() as conn:
        row, state = meta_collisions._load_decisions(conn, lock=False)
        before = json_dumps(state)
        state["kept"][kept] = {"decidedAt": "2026-09-25T00:00:00Z", "repairId": "collision_repair_" + "0" * 32}
        meta_collisions._write_decisions(conn, row, state)
    try:
        with db_conn() as conn:
            result = meta_collisions.remove_untouched_copies(conn, meta_id, None, request_id="cmp_x")
        assert result["removed"] == [] and result["kept"] == [{"adId": kept, "reason": "kept_by_owner"}]
        assert _ad_deleted(kept) is False
        with db_conn() as conn:  # not a Meta id: nothing is looked up
            assert meta_collisions.remove_untouched_copies(conn, "12 34", None) == {"repairId": "", "removed": [], "kept": []}
    finally:
        with db_conn() as conn:
            row, _state = meta_collisions._load_decisions(conn, lock=False)
            meta_collisions._write_decisions(conn, row, json_loads(before))


def test_a_link_that_fails_after_the_removal_removes_nothing(staff, meta, monkeypatch):
    """The removal, its audit rows and the claim commit or roll back together with the link."""
    campaign_id = _approved(staff, "Rolled back")
    meta_id = meta.add(_meta_id(), _data(campaign_id)["studioRef"])
    copy = _manager_copy(meta_id, "rolled")
    real_remove = meta_collisions.remove_untouched_copies
    seen = {}

    def remove_then_fail(conn, *args, **kwargs):
        seen["result"] = real_remove(conn, *args, **kwargs)
        raise actions.HTTPException(status_code=409, detail="Conflict: record has changed")

    monkeypatch.setattr(meta_collisions, "remove_untouched_copies", remove_then_fail)
    failed = _link(staff, campaign_id, meta_id)
    assert failed.status_code == 409, failed.text
    assert seen["result"]["removed"] == [copy]  # it did run inside the link's transaction ...
    assert _ad_deleted(copy) is False  # ... and was rolled back with it
    assert not _data(campaign_id).get("metaCampaignId") and meta_id not in meta_ads.studio_claimed_campaign_ids()
    assert _audit_rows(seen["result"]["repairId"], "collision_repair") == []
    monkeypatch.setattr(meta_collisions, "remove_untouched_copies", real_remove)
    assert _link(staff, campaign_id, meta_id).status_code == 200 and _ad_deleted(copy) is True


def test_discovery_import_and_manager_link_skip_claimed_campaigns(staff, meta):
    campaign_id = _approved(staff, "Claimed")
    meta_id = meta.add(_meta_id(), _data(campaign_id)["studioRef"])
    assert not meta_ads.studio_campaign_claimed(meta_id)
    assert _link(staff, campaign_id, meta_id).status_code == 200
    assert meta_id in meta_ads.studio_claimed_campaign_ids() and meta_ads.studio_campaign_claimed(meta_id)
    claimed_ad, core_ad = f"78{TAG_NUM:08d}01", f"78{TAG_NUM:08d}02"
    core_campaign = _meta_id()
    # The Meta name lost its code (renamed by hand later): the claim still keeps the ad out.
    meta.rows = [
        {"id": claimed_ad, "name": "Claimed ad", "effectiveStatus": "ACTIVE", "campaignId": meta_id,
         "campaignName": "Renamed by hand", "pageId": "", "createdTime": "2026-09-25T08:00:00Z"},
        {"id": core_ad, "name": "Agency ad", "effectiveStatus": "ACTIVE", "campaignId": core_campaign,
         "campaignName": "Agency campaign", "pageId": "", "createdTime": "2026-09-25T08:01:00Z"},
    ]
    saved_state = meta_ads._load_import_state()
    try:
        result = meta_ads.discover_meta_ads(include_existing=True, force=True)
        assert result["studioSkipped"] >= 1
        imported = {row.get("data", {}).get("metaAdId") or row.get("metaAdId") for row in result["imported"]}
        assert _core_ads(claimed_ad) == [] and len(_core_ads(core_ad)) == 1, imported
        assert claimed_ad in meta_ads._load_import_state()["knownMetaAdIds"]

        pending = meta_ads._pending_meta_snapshot(
            {"id": f"78{TAG_NUM:08d}03", "name": "Direct", "campaignId": meta_id, "campaignName": "No code here"},
            ACCOUNT, meta_ads.MetaAdsError("pending_enrichment", "loading", retryable=True), "USD",
        )
        with pytest.raises(meta_ads.MetaAdsError) as refused:
            meta_ads.import_meta_ad_draft(pending)
        assert refused.value.code == "studio_campaign"
        assert _core_ads(f"78{TAG_NUM:08d}03") == []

        # Manager's own link route refuses a claimed campaign too.
        manager_ad = _manager_copy(core_campaign, "manager", editCount=1, metaAdId="")
        meta.snapshots[f"78{TAG_NUM:08d}04"] = {"metaAdId": f"78{TAG_NUM:08d}04", "metaCampaignId": meta_id,
                                                  "metaCampaignName": "Renamed by hand"}
        refused_link = client.post(f"/api/meta-ads/ads/{manager_ad}/link", json={
            "metaAdId": f"78{TAG_NUM:08d}04", "expectedLastModified": 0, "operationId": _uid("mlink"),
        }, cookies=staff["admin"]["cookies"])
        assert refused_link.status_code == 409 and "studio request linked its campaign" in refused_link.json()["detail"]
    finally:
        with db_conn() as conn:
            for ad in _core_ads(core_ad):
                conn.execute(text("DELETE FROM entities WHERE type = 'ads' AND id = :id"), {"id": ad})
        meta_ads._save_import_state(saved_state)


TAG_NUM = int(TAG, 16) % 10**8


def _core_ads(meta_ad_id: str) -> list[str]:
    with db_conn() as conn:
        rows = conn.execute(text("SELECT id, data_json FROM entities WHERE type = 'ads' AND deleted = false")).mappings().all()
    return [row["id"] for row in rows if (json_loads(row["data_json"]) or {}).get("metaAdId") == meta_ad_id]


# ------------------------------------------------------------------ races

def test_two_links_racing_for_one_campaign_exactly_one_wins(staff, meta):
    _grant(["ads_management"])
    first, second = _approved(staff, "Race one"), _approved(staff, "Race two")
    meta_id = meta.add(_meta_id(), "Draft both staff saw")
    both_read = threading.Barrier(2)
    meta.after_read = lambda: both_read.wait(timeout=10)  # both links pass their checks together
    versions = {first: _last_modified(first), second: _last_modified(second)}

    def link(campaign_id):
        own = TestClient(app, headers={"Origin": "http://testserver"})
        try:
            response = _link(staff, campaign_id, meta_id, version=versions[campaign_id], http=own)
            return campaign_id, response.status_code, response.json()
        finally:
            own.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(link, versions))
    finally:
        meta.after_read = None
    assert sorted(status for _, status, _ in results) == [200, 409], results
    loser = next(body for _, status, body in results if status == 409)
    assert loser["detail"] == actions.REFUSE_LINK_TAKEN
    winner = next(cid for cid, status, _ in results if status == 200)
    assert [cid for cid in versions if _data(cid).get("metaCampaignId") == meta_id] == [winner]
    assert meta.renames == [(meta_id, _data(winner)["studioName"])]  # the loser never renamed


# ------------------------------------------------------------------ the real client's requests (paced lane)

def test_real_client_reads_and_renames_a_campaign(monkeypatch):
    token, secret = f"real-token-{TAG}", f"real-secret-{TAG}"
    proof = hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()
    seen = []

    def handler(request):
        seen.append(request)
        assert request.headers.get("Authorization") == f"Bearer {token}"
        if request.method == "POST":
            return httpx.Response(200, json={"success": True})
        if request.url.path.endswith(f"/act_{ACCOUNT}"):
            return httpx.Response(200, json={"id": f"act_{ACCOUNT}", "account_id": ACCOUNT, "currency": "usd"})
        return httpx.Response(200, json={
            "id": "120900000000001", "name": "Draft <b>", "account_id": ACCOUNT, "effective_status": "PAUSED",
            "daily_budget": "", "lifetime_budget": "2500",
            "adsets": {"data": [{"daily_budget": "300"}, {"lifetime_budget": "700"}]},
        })

    real_client_class = httpx.Client
    monkeypatch.setattr(meta_ads.httpx, "Client", lambda **kw: real_client_class(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    config = meta_ads.MetaAdsConfig(
        access_token=token, app_secret=secret, graph_version="v25.0", allowed_account_ids=(ACCOUNT,),
        background_sync=False, sync_interval_minutes=15, sync_batch_size=2, request_timeout_seconds=15,
    )
    real = meta_ads.MetaAdsClient(config)
    campaign = real.get_campaign("120900000000001")
    assert campaign == {
        "id": "120900000000001", "name": "Draft b", "accountId": ACCOUNT, "effectiveStatus": "PAUSED",
        "dailyBudgetMinor": 0, "lifetimeBudgetMinor": 2500, "adSetDailyBudgetMinor": 300,
        "adSetLifetimeBudgetMinor": 700, "currency": "USD",
    }
    assert "adsets.limit(50){daily_budget,lifetime_budget}" in seen[0].url.params["fields"]
    assert seen[0].url.params["appsecret_proof"] == proof
    real.rename_campaign("120900000000001", "ALB-S-K7M2P9QX · Spring offer")
    posted = seen[-1]
    assert posted.method == "POST" and posted.url.path == "/v25.0/120900000000001"
    form = dict(item.split("=", 1) for item in posted.content.decode().split("&"))
    assert "name" in form and form["appsecret_proof"] == proof and "access_token" not in form
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        real.rename_campaign("120900000000001", "No studio code")
    assert refused.value.code == "invalid_request" and len(seen) == 3  # refused before any request
    # The pause refuses before anything reaches Meta.
    sent = len(seen)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", meta_ads.time.monotonic() + 600)
    with pytest.raises(meta_ads.MetaAdsError) as paused:
        real.rename_campaign("120900000000001", "ALB-S-K7M2P9QX · Spring offer")
    assert paused.value.code == "rate_limited" and len(seen) == sent
