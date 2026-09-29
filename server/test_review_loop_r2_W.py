"""Review loop round 2, batch W: wallet and server correctness.

* n=11 an approval is not refused ("wallet can no longer cover") while ANOTHER request of the same customer
       sits between its capture and its Approved write (its money left the balance, its hold is still summed);
       a wallet that really cannot cover is still refused.
* n=13 "Add money" takes a per-owner lock before its per-key lock, so the open-requests cap holds on PostgreSQL.
* n=16 the Delivery (and personal) sync watermarks read live rows only, which the partial indexes serve.
* n=25 after an unlink, linking ANOTHER Meta campaign while the earlier one delivered is refused
       (REFUSE_LINK_AFTER_SPEND): the settle still judges the earlier campaign; only an admin may relink,
       with a written reason, audited settle_override with what the earlier campaign delivered.
* n=27 the integrity scan judges a settled refund on Meta's spend AT SETTLE, not on a later drift read.
* n=32 POST /api/audit/cleanup with an infinite days_to_keep is a clean 400 and deletes nothing.

Every test builds its own users (unique e-mails per run) through the real routes; Meta is faked.
"""

import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
import server.meta_ads as meta_ads
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_actions as actions
from server.systems.ads_studio.ad_campaign_actions import (
    REFUSE_LINK_AFTER_SPEND,
    REFUSE_OVERRIDE_ADMIN,
    REFUSE_OVERRIDE_REASON,
    REFUSE_REFUND_ABOVE_CAP,
)
from server.systems.ads_studio.studio_integrity import scan_studio_money
from server.systems.ads_studio.studio_results import write_results_row
from server.wallet_payments import capture_campaign_budget, wallet_ledger_rows

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR2WPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
ACCOUNT_DIGITS = "7772" + f"{int(TAG, 16) % 10**8:08d}"
ACCOUNT = f"act_{ACCOUNT_DIGITS}"
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
UTC = timezone.utc
_counter = [0]
_INSERTED: list[tuple[str, str]] = []  # (type, id) rows these tests wrote straight into entities: removed at the end


def _uid(prefix: str) -> str:
    _counter[0] += 1
    return f"{prefix}_{TAG}_{_counter[0]}"


def _meta_id() -> str:
    _counter[0] += 1
    return f"1208{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ------------------------------------------------------------------ people

def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl_r2w_user")
    email = f"review-loop-r2w-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R2W {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies, "role": role}


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


@pytest.fixture(scope="module", autouse=True)
def _inserted_rows_removed_afterwards():
    """Later modules read the ads, receipts and subscriptions tables: nothing written straight in outlives the module."""
    yield
    with db_conn() as conn:
        for kind, entity_id in _INSERTED:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": kind, "id": entity_id})


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)
    monkeypatch.setattr(actions, "check_rate_limit", lambda *a, **k: (True, 1, 0))


# ------------------------------------------------------------------ money and requests (real routes)

def _credit(staff, user_id: str, amount: int, currency: str = "USD") -> str:
    response = client.post("/api/wallet/top-ups", json={"userId": user_id, "amountMinor": amount, "currency": currency,
                                                        "idempotencyKey": _uid("topup-key")}, cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _balance(user_id: str, currency: str = "USD") -> int:
    with db_conn() as conn:
        return main_module._wallet_balance_minor(conn, user_id, currency)


def _customer(staff) -> dict:
    user = _insert_user("customer", "Employee", CUSTOMER_PERMISSIONS)
    bought = client.post("/api/subscriptions/purchase", json={"serviceId": "ad_maker", "idempotencyKey": _uid("sub-key")},
                         cookies=user["cookies"])
    assert bought.status_code == 200, bought.text
    return user


def _last_modified(campaign_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT last_modified FROM entities WHERE type = :t AND id = :id"),
                                {"t": CAMPAIGNS, "id": campaign_id}).scalar())


def _data(campaign_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
    return {**json_loads(row["data_json"]), "id": campaign_id, "createdBy": row["created_by"]}


def _force(campaign_id: str, **fields) -> None:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
        data = {**json_loads(row["data_json"]), **fields}
        modified = max(now_ms(), int(row["last_modified"]) + 1)
        data["_lastModified"] = modified
        conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = :t AND id = :id"),
                     {"d": json_dumps(data), "m": modified, "t": CAMPAIGNS, "id": campaign_id})


def _create(user: dict, budget: int) -> str:
    campaign_id = _uid("r2wcmp")
    body = {
        "name": f"R2W offer {campaign_id}", "objective": "messages", "platforms": ["facebook", "instagram"],
        "pageName": "R2W Test Page", "primaryText": "Message us for this week's offer.", "headline": "Weekly offer",
        "description": "R2W test.", "callToAction": "Send Message", "destination": "https://wa.me/218910000000",
        "locations": ["Tripoli, Libya"], "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"],
        "interests": ["Shopping"], "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": budget,
        "budgetType": "lifetime", "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }
    response = client.post(f"/api/collections/{CAMPAIGNS}", json={"id": campaign_id, "data": body}, cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return campaign_id


def _submit(user: dict, campaign_id: str) -> None:
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                           json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                           cookies=user["cookies"])
    assert response.status_code == 200, response.text


def _review(staff, campaign_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": "Approved", "note": "",
        "operationId": _uid("review-op"), "reviewReasonCode": "",
    }, cookies=staff["reviewer"]["cookies"])


def _approved(staff, budget: int = 3000) -> tuple[dict, str]:
    user = _customer(staff)
    _credit(staff, user["id"], budget)
    campaign_id = _create(user, budget)
    _submit(user, campaign_id)
    approved = _review(staff, campaign_id)
    assert approved.status_code == 200, approved.text
    return user, campaign_id


def _crash_capture(staff, campaign_id: str) -> None:
    """An approval that captured the budget and has not written Approved yet (or died before it)."""
    with main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        capture_campaign_budget(conn, main_module._WALLET_PAYMENTS_CTX, _data(campaign_id), staff["reviewer"]["id"])


def _cpay_rows(user_id: str) -> list[dict]:
    with db_conn() as conn:
        return [row for row in wallet_ledger_rows(conn, user_id) if row["idempotencyKey"].startswith("cpay:")]


def _stop(cookies: dict, campaign_id: str, refund: int | None = None):
    body = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("stop-op"), "reason": "test"}
    if refund is not None:
        body["refundMinorUSD"] = refund
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop", json=body, cookies=cookies)


def _scan(owner_id: str) -> list[dict]:
    with db_conn() as conn:
        return scan_studio_money(conn, datetime.now(UTC), owner_ids=[owner_id])


def _audits(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
            {"id": resource_id, "action": action},
        ).mappings().all()
    return [{"user_id": row["user_id"], **(json_loads(row["metadata_json"]) or {})} for row in rows]


def _final_read(campaign_id: str, owner_id: str, meta_id: str, spend: int, impressions: int = 900, **fields) -> None:
    """Meta's results for ``meta_id``: delivery ended 50 hours ago, the final read done, ``spend`` confirmed (USD)."""
    now = datetime.now(UTC)
    ended = now - timedelta(hours=50)
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner_id, {
            "metaCampaignId": meta_id, "metaAdAccountId": ACCOUNT, "syncState": "ok", "lastSyncedAt": _iso(now),
            "currency": "USD", "insightsState": "ok", "campaignEffectiveStatus": "PAUSED", "adStatusCounts": {"PAUSED": 1},
            "anyAdDelivering": False, "deliveryEndedAt": _iso(ended), "settleReadDueAt": _iso(ended + timedelta(hours=48)),
            "settleReadAt": _iso(now), "spendMinorUSD": spend, "spendConfirmedAt": _iso(now), "lifetimeImpressions": impressions,
            **fields,
        })


# ------------------------------------------------------------------ n=11: a sibling between capture and status write

def test_an_approval_is_not_refused_while_a_sibling_request_is_between_its_capture_and_its_status_write(staff):
    customer = _customer(staff)
    _credit(staff, customer["id"], 10_000)
    first, second = _create(customer, 6_000), _create(customer, 4_000)
    _submit(customer, first)
    _submit(customer, second)
    _crash_capture(staff, first)  # the first approval's capture committed; the request still says Submitted
    assert _balance(customer["id"]) == 4_000 and _data(first)["status"] == "Submitted"

    # The second request is covered exactly: before the fix 409 "Customer wallet can no longer cover this campaign budget".
    approved = _review(staff, second)
    assert approved.status_code == 200, approved.text
    assert _data(second)["status"] == "Approved" and _balance(customer["id"]) == 0

    # The first approval then finishes: its capture is replayed, nothing is taken twice.
    finished = _review(staff, first)
    assert finished.status_code == 200, finished.text
    assert _data(first)["status"] == "Approved" and _balance(customer["id"]) == 0
    paid = sorted(row["amountMinor"] for row in _cpay_rows(customer["id"]))
    assert paid == [4_000, 6_000], paid
    assert _scan(customer["id"]) == []  # the wallet identity holds


def test_a_capture_the_wallet_really_cannot_cover_is_still_refused(staff):
    """Control: the sibling's capture is added back once, never more: money that is not there stays refused."""
    customer = _customer(staff)
    _credit(staff, customer["id"], 10_000)
    first, second = _create(customer, 6_000), _create(customer, 4_000)
    _submit(customer, first)
    _submit(customer, second)
    _crash_capture(staff, first)
    _force(second, budgetMinorUSD=5_000, totalBudgetMinorUSD=5_000)  # holds 11,000 against 10,000 ever paid in
    with pytest.raises(HTTPException) as refused:
        _crash_capture(staff, second)
    assert refused.value.status_code == 409 and "can no longer cover" in str(refused.value.detail)
    assert _balance(customer["id"]) == 4_000 and len(_cpay_rows(customer["id"])) == 1


# ------------------------------------------------------------------ n=13: Add money serializes per owner

def test_a_charge_request_locks_its_owner_before_its_key(staff, monkeypatch):
    """PostgreSQL: the open-requests count and the insert run under a per-owner advisory lock, taken before the
    per-key one on every create (one lock order), so parallel creates with different keys cannot all pass the cap."""
    customer = _insert_user("charger", "Employee", {})
    taken: list[tuple[str, str]] = []

    def record(conn, key, *, postgres, namespace="wallet"):
        taken.append((namespace, str(key)))

    monkeypatch.setitem(main_module._WALLET_PAYMENTS_CTX, "lock_idempotency_key", record)
    key = _uid("charge-key")
    created = client.post("/api/wallet/payment-requests", json={"amountMinor": 1000, "currency": "USD", "method": "adfali",
                                                                "idempotencyKey": key}, cookies=customer["cookies"])
    assert created.status_code == 200, created.text
    assert taken[:2] == [("walletPaymentOwner", customer["id"]), ("walletPayment", key)], taken
    cancelled = client.post(f"/api/wallet/payment-requests/{created.json()['id']}/cancel", cookies=customer["cookies"])
    assert cancelled.status_code == 200, cancelled.text  # no pending charge outlives the test


# ------------------------------------------------------------------ n=16: watermarks the partial indexes serve

def _insert_entity(kind: str, data: dict, *, deleted: bool, modified: int, created_by: str | None = None) -> str:
    entity_id = _uid(f"r2w{kind}")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:t,:id,:d,:deleted,:stamp,:by,:m)"),
            {"t": kind, "id": entity_id, "d": json_dumps({**data, "id": entity_id, "_lastModified": modified}),
             "deleted": deleted, "stamp": modified, "by": created_by, "m": modified},
        )
    _INSERTED.append((kind, entity_id))
    return entity_id


def test_delivery_and_personal_watermarks_read_live_rows_only(staff):
    driver = _insert_user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]})
    base = now_ms()
    _insert_entity("ads", {"deliveryPersonId": driver["id"], "deliveryStatus": "Delivered"}, deleted=False, modified=base)
    _insert_entity("ads", {"deliveryPersonId": driver["id"], "deliveryStatus": "Delivered"}, deleted=True, modified=base + 5000)
    marks = client.get("/api/sync/watermarks", cookies=driver["cookies"])
    assert marks.status_code == 200, marks.text
    assert marks.json()["watermarks"]["ads"] == base, marks.json()  # before: base + 5000 (the tombstone)

    customer = _insert_user("personal", "Employee", {})
    _insert_entity("serviceSubscriptions", {"userId": customer["id"], "serviceId": "r2w_probe", "status": "expired"},
                   deleted=False, modified=base + 10, created_by=customer["id"])
    _insert_entity("serviceSubscriptions", {"userId": customer["id"], "serviceId": "r2w_probe", "status": "expired"},
                   deleted=True, modified=base + 9000, created_by=customer["id"])
    personal = client.get("/api/sync/watermarks", cookies=customer["cookies"])
    assert personal.status_code == 200, personal.text
    assert personal.json()["watermarks"]["serviceSubscriptions"] == base + 10, personal.json()


# ------------------------------------------------------------------ n=25: a relink never erases the earlier campaign's spend

class _FakeMeta:
    """The Meta client the desk link reads (no network): campaigns already named with the studio code."""

    def __init__(self):
        self.campaigns: dict[str, dict] = {}
        self.reads: list[str] = []

    def get_campaign(self, campaign_id):
        self.reads.append(str(campaign_id))
        found = self.campaigns.get(str(campaign_id))
        if found is None:
            raise meta_ads.MetaAdsError("not_found", "not found", provider_code="100.33")
        return {"id": str(campaign_id), "name": found["name"], "accountId": ACCOUNT_DIGITS, "effectiveStatus": "PAUSED",
                "dailyBudgetMinor": 0, "lifetimeBudgetMinor": 0, "adSetDailyBudgetMinor": 0, "adSetLifetimeBudgetMinor": 0,
                "currency": "USD"}

    def rename_campaign(self, campaign_id, name):  # never needed: the names already carry the code
        raise AssertionError("no rename expected")


@pytest.fixture()
def meta(monkeypatch):
    fake = _FakeMeta()
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"r2w-token-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", f"r2w-secret-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_ID", "123456789012345")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT_DIGITS)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    return fake


def _desk_link(cookies: dict, campaign_id: str, meta_id: str, **extra):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("link-op"),
        "metaAdAccountId": ACCOUNT_DIGITS, "metaCampaignId": meta_id, **extra,
    }, cookies=cookies)


def _unlink(staff, campaign_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/unlink-meta", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("unlink-op"), "reason": "Rebuilding the ad",
    }, cookies=staff["reviewer"]["cookies"])


def _two_campaigns(meta, campaign_id: str) -> tuple[str, str]:
    ref = _data(campaign_id).get("studioRef") or ""
    assert ref.startswith("ALB-S-")
    first, second = _meta_id(), _meta_id()
    meta.campaigns[first] = {"name": f"{ref} · first build"}
    meta.campaigns[second] = {"name": f"{ref} · rebuilt"}
    return first, second


def _delivered_then_unlinked(staff, meta) -> tuple[dict, str, str, str]:
    """Paid 30.00, linked on the desk to a campaign that spent 20.00 (final read done), then unlinked."""
    user, campaign_id = _approved(staff, 3000)
    first, second = _two_campaigns(meta, campaign_id)
    linked = _desk_link(staff["reviewer"]["cookies"], campaign_id, first)
    assert linked.status_code == 200, linked.text
    _final_read(campaign_id, user["id"], first, 2000)
    unlinked = _unlink(staff, campaign_id)
    assert unlinked.status_code == 200, unlinked.text
    assert _data(campaign_id)["lastLinkedMetaCampaignId"] == first
    meta.reads.clear()
    return user, campaign_id, first, second


def test_linking_another_campaign_after_the_earlier_one_spent_is_refused(staff, meta):
    user, campaign_id, first, second = _delivered_then_unlinked(staff, meta)
    refused = _desk_link(staff["reviewer"]["cookies"], campaign_id, second)
    assert refused.status_code == 409 and refused.json()["detail"] == REFUSE_LINK_AFTER_SPEND, refused.text
    assert meta.reads == []  # refused before any Meta call
    # A reviewer cannot lift it with a reason; an admin's reason needs 10-300 characters.
    by_reviewer = _desk_link(staff["reviewer"]["cookies"], campaign_id, second, relinkReason="The customer changed the photo")
    assert by_reviewer.status_code == 403 and by_reviewer.json()["detail"] == REFUSE_OVERRIDE_ADMIN, by_reviewer.text
    short = _desk_link(staff["admin"]["cookies"], campaign_id, second, relinkReason="rebuilt")
    assert short.status_code == 400 and short.json()["detail"].startswith(REFUSE_OVERRIDE_REASON), short.text
    data = _data(campaign_id)
    assert data["metaCampaignId"] == "" and data["lastLinkedMetaCampaignId"] == first
    assert _audits(campaign_id, "settle_override") == []
    # The settle still judges the request on the campaign that spent: paid 30.00 minus Meta's 20.00.
    above = _stop(staff["reviewer"]["cookies"], campaign_id, 3000)
    assert above.status_code == 400 and above.json()["detail"].startswith(REFUSE_REFUND_ABOVE_CAP), above.text
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert settled.status_code == 200, settled.text
    body = settled.json()["data"]
    assert body["refundMinorUSD"] == 1000 and body["settleBasis"] == "final_read" and body["metaSpendAtSettleMinorUSD"] == 2000
    assert _balance(user["id"]) == 1000


def test_an_admin_relinks_after_spend_only_with_a_written_reason_audited_forever(staff, meta):
    _user, campaign_id, first, second = _delivered_then_unlinked(staff, meta)
    reason = "The customer changed the photo, so the ad was rebuilt in Meta; the first campaign is paused."
    linked = _desk_link(staff["admin"]["cookies"], campaign_id, second, relinkReason=reason)
    assert linked.status_code == 200, linked.text
    data = _data(campaign_id)
    assert data["metaCampaignId"] == second and data["lastLinkedMetaCampaignId"] == second
    rows = _audits(campaign_id, "settle_override")
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["user_id"] == staff["admin"]["id"] and row["relink"] is True and row["reason"] == reason
    assert row["metaCampaignId"] == second and row["earlierLink"]["metaCampaignId"] == first
    assert row["earlierLink"]["spendMinorUSD"] == 2000 and row["earlierLink"]["lifetimeImpressions"] == 900
    assert row["earlierLink"]["metaAdAccountId"] == ACCOUNT


def test_a_relink_that_loses_no_known_spend_still_works(staff, meta):
    """Controls: a mistaken link Meta never delivered may be replaced by any reviewer, and the campaign that
    spent may always be linked again (nothing is dropped)."""
    _user, never_ran = _approved(staff, 1500)
    first, second = _two_campaigns(meta, never_ran)
    assert _desk_link(staff["reviewer"]["cookies"], never_ran, first).status_code == 200
    assert _unlink(staff, never_ran).status_code == 200
    relinked = _desk_link(staff["reviewer"]["cookies"], never_ran, second)
    assert relinked.status_code == 200, relinked.text
    assert _data(never_ran)["metaCampaignId"] == second

    _user2, campaign_id, spent, _other = _delivered_then_unlinked(staff, meta)
    again = _desk_link(staff["reviewer"]["cookies"], campaign_id, spent)
    assert again.status_code == 200, again.text
    assert _data(campaign_id)["metaCampaignId"] == spent and _audits(campaign_id, "settle_override") == []


# ------------------------------------------------------------------ n=27: the refund is judged on the spend at settle

def _desk_linked_final_read(staff, spend: int, **fields) -> tuple[dict, str, str]:
    user, campaign_id = _approved(staff, 3000)
    meta_id = _meta_id()
    _force(campaign_id, metaCampaignId=meta_id, metaAdAccountId=ACCOUNT, publishStatus="meta_review",
           linkedAt=_iso(datetime.now(UTC)), metaLinkResult={"metaCurrency": "USD"})
    _final_read(campaign_id, user["id"], meta_id, spend, **fields)
    return user, campaign_id, meta_id


def test_a_later_meta_drift_does_not_raise_refund_above_unspent(staff):
    user, campaign_id, meta_id = _desk_linked_final_read(staff, 2000)
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)  # the default: exactly the cap, 10.00 back
    assert settled.status_code == 200, settled.text
    assert settled.json()["data"]["refundMinorUSD"] == 1000 and settled.json()["data"]["metaSpendAtSettleMinorUSD"] == 2000
    assert _scan(user["id"]) == []
    # The drift watch writes Meta's later lifetime spend (3 cents more): not an integrity violation (meta_drift's job).
    _final_read(campaign_id, user["id"], meta_id, 2003)
    assert _scan(user["id"]) == [], _scan(user["id"])
    # A refund above paid minus the spend the settle was based on is still found.
    _force(campaign_id, metaSpendAtSettleMinorUSD=2500)
    assert {item["code"] for item in _scan(user["id"])} == {"refund_above_unspent"}


def test_a_never_delivered_settle_stays_clean_when_meta_later_reports_cents(staff):
    user, campaign_id, meta_id = _desk_linked_final_read(staff, 0, impressions=0, neverDelivered=True)
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert settled.status_code == 200, settled.text
    body = settled.json()["data"]
    assert body["settleBasis"] == "never_delivered" and body["refundMinorUSD"] == 3000
    assert _scan(user["id"]) == []
    _final_read(campaign_id, user["id"], meta_id, 5, impressions=0, neverDelivered=True)
    assert _scan(user["id"]) == [], _scan(user["id"])


# ------------------------------------------------------------------ n=32: an infinite days_to_keep is a clean 400

def test_audit_cleanup_with_an_infinite_days_to_keep_is_a_clean_400(staff):
    with db_conn() as conn:
        before = int(conn.execute(text("SELECT COUNT(*) FROM audit_logs")).scalar() or 0)
    for raw in ('{"days_to_keep": 1e400}', '{"days_to_keep": -1e400}', '{"days_to_keep": Infinity}'):
        response = client.post("/api/audit/cleanup", content=raw, headers={"Content-Type": "application/json"},
                               cookies=staff["admin"]["cookies"])
        assert response.status_code == 400, (raw, response.status_code, response.text)
        assert "days_to_keep" in response.json()["detail"]
    with db_conn() as conn:
        after = int(conn.execute(text("SELECT COUNT(*) FROM audit_logs")).scalar() or 0)
    assert after >= before  # nothing was deleted
