"""Albayan Studio wallet summary (plan task P1-07; PLAN.md §7.8).

The three TASKS.md P1-07 scenarios through the real routes, the orphan states, isolation, and a
property test: random sequences of charges, admin credits and reversals, transfers, submits,
approvals, sends-back, withdraws, orphans (a crashed approval, a crashed send-back), partial
settles, customer stops, links with Meta results and archives. After every step the summary must
match a simple model of what happened AND the identity

    added + adjustments - in ads - being returned - spent = available + reserved

must hold, with Available equal to the number the server's own debits check. Every test creates
its own users (unique e-mails per run).
"""

import os
import random
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_results
from server.systems.ads_studio.studio_results import write_results_row
from server.systems.ads_studio.studio_wallet import compute_wallet_summary, cycle_state, wallet_summary
from server.wallet_payments import (
    _campaign_payment_key,
    capture_campaign_budget,
    pending_payment_requests,
    release_orphan_campaign_payment,
    wallet_ledger_rows,
)

TAG = secrets.token_hex(4)
PASSWORD = "StudioWalletPassword123!"
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


def _meta_id() -> str:
    """A Meta campaign id of its own for every link (one Meta campaign never serves two requests)."""
    _counter[0] += 1
    return f"1202{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


# ------------------------------------------------------------------ people

def _insert_user(label: str, role: str, permissions: dict) -> dict:
    stamp = now_ms()
    user_id = new_id("wallet_user")
    email = f"studio-wallet-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Wallet {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


def _customer(label: str) -> dict:
    user = _insert_user(f"{label}-{_uid('c')}", "Employee", CUSTOMER_PERMISSIONS)
    bought = client.post("/api/subscriptions/purchase", json={"serviceId": "ad_maker", "idempotencyKey": _uid("sub-key")},
                         cookies=user["cookies"])
    assert bought.status_code == 200, bought.text
    return user


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    """The flows below make many changes quickly; each route's own limit is tested elsewhere."""
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


# ------------------------------------------------------------------ money and campaign steps (real routes)

def _credit(staff, user_id: str, amount: int, currency: str = "USD"):
    response = client.post("/api/wallet/top-ups", json={"userId": user_id, "amountMinor": amount, "currency": currency,
                                                        "idempotencyKey": _uid("topup-key")}, cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _charge(staff, user: dict, amount: int, currency: str = "USD") -> str:
    created = client.post("/api/wallet/payment-requests", json={
        "amountMinor": amount, "currency": currency, "method": "adfali", "idempotencyKey": _uid("charge-key"),
    }, cookies=user["cookies"])
    assert created.status_code == 200, created.text
    confirmed = client.post(f"/api/wallet/payment-requests/{created.json()['id']}/confirm", json={},
                            cookies=staff["admin"]["cookies"])
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()["data"]["walletTransactionId"]


def _campaign_body(name: str, budget: int) -> dict:
    return {
        "name": name, "objective": "messages", "platforms": ["facebook", "instagram"], "pageName": "Wallet Test Page",
        "primaryText": "Message us for this week's offer.", "headline": "Weekly offer", "description": "Wallet test.",
        "callToAction": "Send Message", "destination": "https://wa.me/218910000000", "locations": ["Tripoli, Libya"],
        "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"], "interests": ["Shopping"],
        "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": budget, "budgetType": "lifetime",
        "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }


def _last_modified(campaign_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT last_modified FROM entities WHERE type = :t AND id = :id"),
                                {"t": CAMPAIGNS, "id": campaign_id}).scalar())


def _campaign_data(campaign_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
    return {**json_loads(row["data_json"]), "id": campaign_id, "createdBy": row["created_by"]}


def _create(user: dict, budget: int, name: str = "") -> str:
    campaign_id = _uid("wcmp")
    response = client.post(f"/api/collections/{CAMPAIGNS}",
                           json={"id": campaign_id, "data": _campaign_body(name or f"Ad {campaign_id}", budget)},
                           cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return campaign_id


def _submit(user: dict, campaign_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                       json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                       cookies=user["cookies"])


def _review(staff, campaign_id: str, decision: str):
    note = "" if decision == "Approved" else "Please fix the photo"
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": decision, "note": note,
        "operationId": _uid("review-op"),
    }, cookies=staff["reviewer"]["cookies"])


def _stop(cookies: dict, campaign_id: str, refund: int | None = None):
    body = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("stop-op"), "reason": "test"}
    if refund is not None:
        body["refundMinorUSD"] = refund
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop", json=body, cookies=cookies)


def _link(staff, campaign_id: str, meta_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json={
        "expectedLastModified": _last_modified(campaign_id), "operationId": _uid("link-op"), "publishStatus": "live",
        "metaCampaignId": meta_id,
    }, cookies=staff["reviewer"]["cookies"])


def _seed_results(campaign_id: str, owner_id: str, spend: int, meta_id: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner_id, {
            "metaCampaignId": meta_id, "syncState": "ok", "lastSyncedAt": stamp, "adStatusCounts": {"ACTIVE": 1},
            "campaignEffectiveStatus": "ACTIVE", "spendMinorUSD": spend, "spendConfirmedAt": stamp,
            "insightsState": "ok", "currency": "USD",
        })


def _archive(user: dict, campaign_id: str):
    return client.delete(f"/api/collections/{CAMPAIGNS}/{campaign_id}", cookies=user["cookies"])


def _force(campaign_id: str, conn, **fields) -> None:
    """Write fields straight into a request row, as a crash between two steps leaves it."""
    row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = :t AND id = :id"),
                       {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
    data = {**json_loads(row["data_json"]), **fields}
    modified = max(now_ms(), int(row["last_modified"]) + 1)
    data["_lastModified"] = modified
    conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = :t AND id = :id"),
                 {"d": json_dumps(data), "m": modified, "t": CAMPAIGNS, "id": campaign_id})


def _crash_capture(staff, campaign_id: str) -> None:
    """An approval that captured the budget and died before its status write."""
    with main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        capture_campaign_budget(conn, main_module._WALLET_PAYMENTS_CTX, _campaign_data(campaign_id), staff["reviewer"]["id"])


def _release(staff, campaign_id: str) -> str:
    """The orphan sweep / send-back release of the request's current cycle."""
    with main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        return release_orphan_campaign_payment(conn, main_module._WALLET_PAYMENTS_CTX, _campaign_data(campaign_id),
                                               staff["reviewer"]["id"])


def _withdraw(staff, campaign_id: str) -> None:
    """The planned withdraw (P1-03): Draft, keeping submittedAt, and the cycle's capture released, one transaction."""
    with main_module._SQLITE_ENTITY_PATCH_LOCK, main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        data = _campaign_data(campaign_id)
        _force(campaign_id, conn, status="Draft", withdrawnAt=datetime.now(timezone.utc).isoformat())
        release_orphan_campaign_payment(conn, main_module._WALLET_PAYMENTS_CTX, data, staff["reviewer"]["id"])


def _summary(user: dict) -> dict:
    reset_rate_limit(f"studio:wallet-summary:{user['id']}")
    response = client.get("/api/studio/wallet/summary", cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _server_available(user_id: str) -> int:
    with db_conn() as conn:
        return main_module._wallet_available_after_holds(conn, user_id, "USD")


def _assert_identity(summary: dict, user_id: str) -> None:
    usd = summary["usd"]
    left = usd["addedMinor"] + usd["adjustmentsMinor"] - usd["inAdsMinor"] - usd["beingReturnedMinor"] - usd["spentMinor"]
    assert left == usd["availableMinor"] + usd["reservedMinor"], usd
    assert usd["availableMinor"] == _server_available(user_id), usd  # the number every debit checks
    with db_conn() as conn:  # every USD ledger row, counted independently
        balance = main_module._wallet_balance_minor(conn, user_id, "USD")
    assert usd["availableMinor"] + usd["reservedMinor"] == balance


# ------------------------------------------------------------------ the three scenarios of TASKS.md P1-07

def _scenario_one(staff) -> tuple[dict, str]:
    """Charge 100 -> submit 30 -> approve -> link + seeded results row (Meta spend 3)."""
    user = _customer("s1")
    _charge(staff, user, 10_000)
    campaign_id = _create(user, 3_000, "Summer offer")
    assert _submit(user, campaign_id).status_code == 200
    assert _review(staff, campaign_id, "Approved").status_code == 200
    unlinked = _summary(user)["usd"]
    assert unlinked["inAdsMinor"] == 3_000 and unlinked["metaUsedInAdsMinor"] is None  # no Meta line before a link
    meta_id = _meta_id()
    assert _link(staff, campaign_id, meta_id).status_code == 200
    checking = _summary(user)["usd"]
    assert checking["metaUsedInAdsMinor"] is None and checking["metaCheckedAt"] is None  # linked, never checked
    _seed_results(campaign_id, user["id"], 300, meta_id)
    return user, campaign_id


def test_wallet_summary_requires_login():
    client.cookies.clear()
    assert client.get("/api/studio/wallet/summary").status_code == 401


def test_wallet_summary_scenario_1_approved_ad_with_meta_used(staff):
    user, campaign_id = _scenario_one(staff)
    summary = _summary(user)
    usd = summary["usd"]
    assert usd["availableMinor"] == 7_000 and usd["reservedMinor"] == 0 and usd["inAdsMinor"] == 3_000
    assert usd["metaUsedInAdsMinor"] == 300 and usd["metaCheckedAt"] and usd["spentMinor"] == 0
    assert usd["beingReturnedMinor"] == 0 and usd["addedMinor"] == 10_000 and usd["adjustmentsMinor"] == 0
    assert summary["inAds"] == [{
        "campaignId": campaign_id, "name": "Summer offer", "paidMinor": 3_000, "returnedMinor": 0, "inAdsMinor": 3_000,
        "approving": False, "metaUsedMinor": 300, "checkedAt": usd["metaCheckedAt"], "stale": False,
    }]
    (chain,) = summary["chains"]
    assert (chain["state"], chain["bucket"], chain["netMinor"]) == ("in_ads", "inAds", 3_000)
    assert chain["steps"][0]["labels"] == {"en": "Ad budget paid: Summer offer", "ar": "دفع ميزانية إعلان: Summer offer"}
    assert summary["reserved"] == [] and summary["lyd"] == {"balanceMinor": 0}
    _assert_identity(summary, user["id"])


def test_wallet_summary_scenario_2_settle_then_archive(staff):
    user, campaign_id = _scenario_one(staff)
    settled = _stop(staff["reviewer"]["cookies"], campaign_id, refund=2_700)
    assert settled.status_code == 200, settled.text
    summary = _summary(user)
    usd = summary["usd"]
    assert usd["availableMinor"] == 9_700 and usd["spentMinor"] == 300 and usd["inAdsMinor"] == 0
    assert usd["metaUsedInAdsMinor"] is None and summary["inAds"] == []
    (chain,) = summary["chains"]
    assert (chain["state"], chain["paidMinor"], chain["returnedMinor"], chain["netMinor"]) == ("spent", 3_000, 2_700, 300)
    assert [step["ref"] for step in chain["steps"]] == ["cpay", "stoprefund"]
    assert chain["steps"][1]["labels"]["ar"] == "استرجاع ما لم تصرفه ميتا من: Summer offer"
    _assert_identity(summary, user["id"])

    archived = _archive(user, campaign_id)
    assert archived.status_code == 200, archived.text
    after = _summary(user)
    assert after["usd"] == usd  # archiving changes no number: spent is still 3
    assert after["chains"][0]["archived"] is True and after["chains"][0]["state"] == "spent"
    _assert_identity(after, user["id"])


def test_wallet_summary_scenario_3_pending_submit_is_reserved(staff):
    user, _first = _scenario_one(staff)
    assert _stop(staff["reviewer"]["cookies"], _first, refund=2_700).status_code == 200
    second = _create(user, 2_000, "Winter offer")
    assert _submit(user, second).status_code == 200
    summary = _summary(user)
    usd = summary["usd"]
    assert usd["reservedMinor"] == 2_000 and usd["availableMinor"] == 7_700 and usd["spentMinor"] == 300
    assert [(item["campaignId"], item["budgetMinor"], item["name"]) for item in summary["reserved"]] == [
        (second, 2_000, "Winter offer")]
    _assert_identity(summary, user["id"])


# ------------------------------------------------------------------ orphan states

def test_crashed_approval_and_crashed_send_back(staff):
    user = _customer("orphan")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    approving = _summary(user)
    usd = approving["usd"]
    # Captured but still Submitted: in "In your ads" (approving) AND still held, so Available is understated.
    assert (usd["reservedMinor"], usd["inAdsMinor"], usd["availableMinor"], usd["beingReturnedMinor"]) == (2_000, 2_000, 1_000, 0)
    assert approving["inAds"][0]["approving"] is True and approving["chains"][0]["state"] == "approving"
    _assert_identity(approving, user["id"])

    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, status="Changes Requested")  # the send-back committed, its release did not
    returning = _summary(user)
    usd = returning["usd"]
    assert (usd["reservedMinor"], usd["inAdsMinor"], usd["beingReturnedMinor"], usd["availableMinor"]) == (0, 0, 2_000, 3_000)
    assert returning["chains"][0]["state"] == "being_returned"
    _assert_identity(returning, user["id"])

    assert _release(staff, campaign_id)
    back = _summary(user)
    assert back["usd"]["beingReturnedMinor"] == 0 and back["usd"]["availableMinor"] == 5_000
    chain = back["chains"][0]
    assert chain["state"] == "returned" and [step["ref"] for step in chain["steps"]] == ["cpay", "rel"]
    assert chain["steps"][1]["labels"] == {"en": "Ad budget returned (not approved)", "ar": "استرجاع ميزانية إعلان لم يُعتمد"}
    _assert_identity(back, user["id"])


def test_withdraw_returns_a_captured_cycle(staff):
    user = _customer("withdraw")
    _credit(staff, user["id"], 4_000)
    campaign_id = _create(user, 1_500)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    _withdraw(staff, campaign_id)
    summary = _summary(user)
    assert summary["usd"]["availableMinor"] == 4_000 and summary["usd"]["reservedMinor"] == 0
    assert summary["chains"][0]["state"] == "returned"
    _assert_identity(summary, user["id"])


def test_cycle_state_rules():
    request = {"id": "cmp_1", "submittedAt": "2026-10-01T10:00:00Z", "status": "Approved"}
    key = _campaign_payment_key(request)
    assert key == "cpay:cmp_1:2026-10-01T10:00:00Z"
    assert cycle_state(request, key) == "in_ads"
    assert cycle_state({**request, "status": "Stopped"}, key) == "spent"
    assert cycle_state({**request, "status": "Stopped", "archived": True}, key) == "spent"
    assert cycle_state({**request, "status": "Submitted"}, key) == "approving"
    assert cycle_state({**request, "status": "Submitted", "archived": True}, key) == "being_returned"
    for left in ("Draft", "Changes Requested", "Rejected"):
        assert cycle_state({**request, "status": left}, key) == "being_returned"
    moved_on = {**request, "status": "Approved", "submittedAt": "2026-10-05T10:00:00Z"}  # a later cycle
    assert cycle_state(moved_on, key) == "being_returned"
    legacy = {"id": "cmp_2", "status": "Approved"}  # approved before submittedAt existed
    assert cycle_state(legacy, "cpay:cmp_2") == "in_ads"
    assert cycle_state(None, key) == "spent"


def test_old_admin_reversal_and_unjoined_returns():
    """Rows the ledger can hold from before the doors were closed: each still counted exactly once."""
    uid = "user_x"
    request = {"id": "cmp_r", "name": "Old ad", "submittedAt": "2026-01-01T00:00:00Z", "status": "Approved",
               "archived": False, "budgetMinorUSD": 1000}
    pay_key = _campaign_payment_key(request)

    def row(row_id, kind, amount, frm, to, key="", ref_type="", ref_id="", currency="USD"):
        return {"id": row_id, "type": kind, "amountMinor": amount, "currency": currency, "fromUserId": frm,
                "toUserId": to, "idempotencyKey": key, "referenceType": ref_type, "referenceId": ref_id,
                "createdAt": f"2026-01-0{len(row_id)}T00:00:00Z", "status": "posted"}

    ledger = [
        row("t1", "credit", 5000, "", uid, key="payreq:p1"),
        row("t22", "campaign_payment", 1000, uid, "system", key=pay_key, ref_type="adCampaignRequest", ref_id="cmp_r"),
        row("t333", "reversal", 1000, "system", uid, key="rev:t22", ref_type="reversalOf", ref_id="t22"),
        row("t4444", "campaign_refund", 70, "system", uid, key="stoprefund:cpay:gone:x", ref_type="reversalOf",
            ref_id="gone"),
        row("t55555", "credit", 9000, "", uid, key="k", currency="LYD"),
        row("t666666", "transfer", 300, uid, "user_y", key="tr1"),
    ]
    summary = compute_wallet_summary(uid, ledger, [request], {}, 0, [], datetime.now(timezone.utc))
    usd = summary["usd"]
    assert usd["addedMinor"] == 5000 and usd["adjustmentsMinor"] == 70 - 300  # the unjoined return + the transfer sent
    assert usd["inAdsMinor"] == 0 and usd["availableMinor"] == 5000 - 1000 + 1000 + 70 - 300
    (chain,) = summary["chains"]
    assert chain["state"] == "returned" and chain["steps"][1]["labels"]["en"] == "Correction by Albayan"
    assert summary["lyd"] == {"balanceMinor": 9000}  # never inside the USD numbers


# ------------------------------------------------------------------ isolation, currencies, pending charges

def test_own_wallet_only_and_no_staff_identity(staff):
    first, second = _customer("iso1"), _customer("iso2")
    _charge(staff, first, 6_000)
    _credit(staff, second["id"], 1_000)
    campaign_id = _create(first, 2_000)
    assert _submit(first, campaign_id).status_code == 200
    assert _review(staff, campaign_id, "Approved").status_code == 200
    response = client.get(f"/api/studio/wallet/summary?userId={first['id']}", cookies=second["cookies"])
    assert response.status_code == 200
    mine = response.json()
    assert mine["usd"]["addedMinor"] == 1_000 and mine["chains"] == [] and campaign_id not in response.text
    theirs = _summary(first)
    assert theirs["usd"]["inAdsMinor"] == 2_000
    raw = client.get("/api/studio/wallet/summary", cookies=first["cookies"]).text
    for secret in (staff["admin"]["id"], staff["reviewer"]["id"], "createdBy", "confirmedBy", "memo"):
        assert secret not in raw


def test_lyd_rows_never_mixed_into_usd(staff):
    user = _customer("lyd")
    _credit(staff, user["id"], 2_500)
    before = _summary(user)["usd"]
    _credit(staff, user["id"], 9_000, "LYD")
    _charge(staff, user, 4_000, "LYD")
    after = _summary(user)
    assert after["usd"] == before and after["lyd"] == {"balanceMinor": 13_000}
    _assert_identity(after, user["id"])


def test_pending_payments_listed_without_photo(staff):
    user = _customer("pending")
    created = client.post("/api/wallet/payment-requests", json={
        "amountMinor": 2_000, "currency": "USD", "method": "bank_transfer", "idempotencyKey": _uid("pending-key"),
    }, cookies=user["cookies"])
    assert created.status_code == 200, created.text
    attached = client.post(f"/api/wallet/payment-requests/{created.json()['id']}/receipt",
                           json={"photo": PNG}, cookies=user["cookies"])
    assert attached.status_code == 200, attached.text
    response = client.get("/api/studio/wallet/summary", cookies=user["cookies"])
    (pending,) = response.json()["pendingPayments"]
    assert pending["reference"] == created.json()["data"]["reference"] and pending["reference"].startswith("PAY-")
    assert (pending["amountMinor"], pending["currency"], pending["dueAt"]) == (2_000, "USD", None)
    assert "base64" not in response.text and "receipt" not in response.text.lower()
    assert response.json()["usd"]["addedMinor"] == 0  # not money until confirmed


def test_read_helpers_return_only_summary_fields(staff):
    user = _customer("helpers")
    _credit(staff, user["id"], 1_234)
    with db_conn() as conn:
        (row,) = wallet_ledger_rows(conn, user["id"])
        assert set(row) == {"id", "amountMinor", *wallet_payments.LEDGER_SUMMARY_FIELDS}
        assert row["amountMinor"] == 1_234 and row["currency"] == "USD" and row["toUserId"] == user["id"]
        assert wallet_ledger_rows(conn, "") == [] and pending_payment_requests(conn, "") == []


def test_wallet_summary_rate_limited(staff):
    user = _customer("limit")
    key = f"studio:wallet-summary:{user['id']}"
    for _ in range(studio_results.SUMMARY_READS_PER_MINUTE):
        assert client.get("/api/studio/wallet/summary", cookies=user["cookies"]).status_code == 200
    limited = client.get("/api/studio/wallet/summary", cookies=user["cookies"])
    assert limited.status_code == 429 and limited.json()["detail"]["code"] == "RATE_LIMITED"
    reset_rate_limit(key)


# ------------------------------------------------------------------ the property test

class _Model:
    """What the summary must say, kept from what the steps did (never from the summary itself)."""

    def __init__(self, users):
        self.users = {user["id"]: user for user in users}
        self.added = {uid: 0 for uid in self.users}
        self.adjust = {uid: 0 for uid in self.users}
        self.lyd = {uid: 0 for uid in self.users}
        self.campaigns: dict[str, dict] = {}
        self.txs: list[dict] = []  # non-campaign ledger rows the steps wrote
        self.reversed: set[str] = set()

    def expected(self, uid: str) -> dict:
        mine = [c for c in self.campaigns.values() if c["owner"] == uid]
        reserved = sum(c["budget"] for c in mine if c["status"] == "Submitted" and not c["archived"])
        in_ads = sum(c["budget"] for c in mine if c["status"] == "Approved")
        in_ads += sum(c["budget"] for c in mine if c["status"] == "Submitted" and c["captured"])
        linked = [c for c in mine if c["status"] == "Approved" and c["linked"]]
        return {
            "addedMinor": self.added[uid], "adjustmentsMinor": self.adjust[uid], "reservedMinor": reserved,
            "inAdsMinor": in_ads, "beingReturnedMinor": sum(c["budget"] for c in mine if c["crashed"]),
            "spentMinor": sum(c["budget"] - c["refund"] for c in mine if c["status"] == "Stopped"),
            "metaUsedInAdsMinor": sum(c["metaUsed"] for c in linked) if linked else None,
        }


def _step(rng: random.Random, model: _Model, staff) -> str:
    uids = list(model.users)
    uid = rng.choice(uids)
    user = model.users[uid]
    mine = [c for c in model.campaigns.values() if c["owner"] == uid]

    def pick(*statuses, **flags):
        found = [c for c in mine if c["status"] in statuses and all(c[k] == v for k, v in flags.items())]
        return rng.choice(found) if found else None

    def has(*statuses, **flags):
        return any(c["status"] in statuses and all(c[k] == v for k, v in flags.items()) for c in mine)

    # Only operations that can apply to this customer now, so no step is wasted.
    weights = {"credit": 1, "charge": 1, "lyd": 1, "transfer": 1, "submit_new": 2}
    if any(tx["id"] not in model.reversed for tx in model.txs):
        weights["reverse"] = 1
    if any(c["paid"] for c in mine):
        weights["reverse_campaign_row"] = 1
    if has("Submitted", archived=False):
        weights.update(approve=3, send_back=1, withdraw=1)
    if has("Submitted", archived=False, captured=False):
        weights["crash_capture"] = 2
    if has("Submitted", archived=False, captured=True):
        weights["crash_leave"] = 3
    if has("Changes Requested", "Draft", archived=False):
        weights["resubmit"] = 1
    if has("Approved"):
        weights.update(settle=1, self_stop=1)
    if has("Approved", linked=False):
        weights["link"] = 3
    if has("Draft", "Changes Requested", "Rejected", "Stopped", "Approved", archived=False):
        weights["archive"] = 1
    if has("Changes Requested", crashed=True):
        weights["sweep"] = 6  # else a resubmit or an archive usually returns it first
    ops = sorted(weights)
    op = rng.choices(ops, weights=[weights[name] for name in ops])[0]
    if op == "credit":
        amount = rng.randint(500, 20_000)
        model.txs.append({"id": _credit(staff, uid, amount), "from": None, "to": uid, "amount": amount, "cur": "USD"})
        model.added[uid] += amount
    elif op == "charge":
        amount = rng.randint(100, 9_000)
        model.txs.append({"id": _charge(staff, user, amount), "from": None, "to": uid, "amount": amount, "cur": "USD"})
        model.added[uid] += amount
    elif op == "lyd":
        amount = rng.randint(100, 9_000)
        model.txs.append({"id": _credit(staff, uid, amount, "LYD"), "from": None, "to": uid, "amount": amount, "cur": "LYD"})
        model.lyd[uid] += amount
    elif op == "transfer":
        other = rng.choice([u for u in uids if u != uid])
        amount = rng.randint(100, 4_000)
        response = client.post("/api/wallet/transfers", json={"toUserId": other, "amountMinor": amount, "currency": "USD",
                                                            "idempotencyKey": _uid("transfer-key")}, cookies=user["cookies"])
        if response.status_code == 409:
            return "transfer refused (short)"
        assert response.status_code == 200, response.text
        model.txs.append({"id": response.json()["id"], "from": uid, "to": other, "amount": amount, "cur": "USD"})
        model.adjust[uid] -= amount
        model.added[other] += amount
    elif op == "reverse":
        open_txs = [tx for tx in model.txs if tx["id"] not in model.reversed]
        if not open_txs:
            return "nothing to reverse"
        tx = rng.choice(open_txs)
        response = client.post("/api/wallet/reversals", json={"transactionId": tx["id"]}, cookies=staff["admin"]["cookies"])
        assert response.status_code == 200, response.text
        model.reversed.add(tx["id"])
        for who, sign in ((tx["to"], -1), (tx["from"], +1)):
            if who in model.users:
                if tx["cur"] == "USD":
                    model.adjust[who] += sign * tx["amount"]
                else:
                    model.lyd[who] += sign * tx["amount"]
    elif op == "reverse_campaign_row":
        with db_conn() as conn:
            pays = [row for row in wallet_ledger_rows(conn, uid) if row["type"] == "campaign_payment"]
        if not pays:
            return "no campaign row"
        response = client.post("/api/wallet/reversals", json={"transactionId": rng.choice(pays)["id"]},
                               cookies=staff["admin"]["cookies"])
        assert response.status_code == 409, response.text  # the stop is the only refund door
    elif op == "submit_new":
        budget = rng.randint(1_500, 6_000)  # above a $1/day floor over the 11 days
        campaign_id = _create(user, budget)
        model.campaigns[campaign_id] = {"id": campaign_id, "owner": uid, "budget": budget, "status": "Draft",
                                        "captured": False, "crashed": False, "refund": 0, "archived": False,
                                        "linked": False, "metaUsed": 0, "paid": False}
        response = _submit(user, campaign_id)
        if response.status_code == 409:
            return "submit refused (short)"
        assert response.status_code == 200, response.text
        model.campaigns[campaign_id]["status"] = "Submitted"
    elif op == "approve":
        campaign = pick("Submitted", archived=False)
        if not campaign:
            return "nothing to approve"
        response = _review(staff, campaign["id"], "Approved")
        if response.status_code == 409:
            assert not campaign["captured"], response.text
            return "approval refused (short)"
        assert response.status_code == 200, response.text
        campaign.update(status="Approved", captured=True, paid=True)
    elif op == "send_back":
        campaign = pick("Submitted", archived=False)
        if not campaign:
            return "nothing to send back"
        decision = rng.choice(["Changes Requested", "Rejected"])
        assert _review(staff, campaign["id"], decision).status_code == 200
        campaign.update(status=decision, captured=False)
    elif op == "resubmit":
        campaign = pick("Changes Requested", "Draft", archived=False)
        if not campaign:
            return "nothing to resubmit"
        response = _submit(user, campaign["id"])
        if response.status_code == 409:
            return "resubmit refused (short)"
        assert response.status_code == 200, response.text
        campaign.update(status="Submitted", captured=False, crashed=False)
    elif op == "settle":
        campaign = pick("Approved")
        if not campaign:
            return "nothing to settle"
        refund = rng.choice([0, campaign["budget"], rng.randint(0, campaign["budget"])])
        response = _stop(staff["reviewer"]["cookies"], campaign["id"], refund=refund)
        assert response.status_code == 200, response.text
        campaign.update(status="Stopped", refund=refund)
    elif op == "self_stop":
        campaign = pick("Approved")
        if not campaign:
            return "nothing to stop"
        response = _stop(user["cookies"], campaign["id"])
        if campaign["linked"]:
            assert response.status_code == 409, response.text  # started: only staff can stop it now
            return "self stop refused (started)"
        assert response.status_code == 200, response.text
        campaign.update(status="Stopped", refund=campaign["budget"])
    elif op == "archive":
        campaign = pick("Draft", "Changes Requested", "Rejected", "Stopped", "Approved", archived=False)
        if not campaign:
            return "nothing to archive"
        response = _archive(user, campaign["id"])
        if campaign["status"] == "Approved":
            assert response.status_code == 409, response.text  # stop first, so the money can come back
            return "archive refused (approved)"
        assert response.status_code == 200, response.text
        campaign.update(archived=True, crashed=False)
    elif op == "link":
        campaign = pick("Approved", linked=False)
        if not campaign:
            return "nothing to link"
        meta_id = _meta_id()
        assert _link(staff, campaign["id"], meta_id).status_code == 200
        spend = rng.randint(0, campaign["budget"])
        _seed_results(campaign["id"], uid, spend, meta_id)
        campaign.update(linked=True, metaUsed=spend)
    elif op == "crash_capture":
        campaign = pick("Submitted", archived=False, captured=False)
        if not campaign:
            return "nothing to capture"
        try:
            _crash_capture(staff, campaign["id"])
        except HTTPException as error:
            assert error.status_code == 409
            return "capture refused (short)"
        campaign.update(captured=True, paid=True)
    elif op == "crash_leave":
        campaign = pick("Submitted", archived=False, captured=True)
        if not campaign:
            return "nothing captured to leave"
        with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
            _force(campaign["id"], conn, status="Changes Requested")
        campaign.update(status="Changes Requested", captured=False, crashed=True)
    elif op == "sweep":
        campaign = pick("Changes Requested", crashed=True)
        if not campaign:
            return "nothing to sweep"
        assert _release(staff, campaign["id"])
        assert _release(staff, campaign["id"])  # a second sweep returns the same row, never pays twice
        campaign["crashed"] = False
    elif op == "withdraw":
        campaign = pick("Submitted", archived=False)
        if not campaign:
            return "nothing to withdraw"
        _withdraw(staff, campaign["id"])
        campaign.update(status="Draft", captured=False)
    return op


SEEDS = (11, 23, 37)
STEPS = 70
OPERATIONS = {
    "credit", "charge", "lyd", "transfer", "reverse", "reverse_campaign_row", "submit_new", "approve", "send_back",
    "resubmit", "settle", "self_stop", "archive", "link", "crash_capture", "crash_leave", "sweep", "withdraw",
}


def _run_sequence(staff, seed: int) -> list[str]:
    """One random sequence; the model and the identity are checked after every step."""
    rng = random.Random(seed)
    users = [_customer(f"prop{seed}a"), _customer(f"prop{seed}b"), _customer(f"prop{seed}c")]
    model = _Model(users)
    for user in users:  # everyone starts with some money, so the first steps can spend
        amount = rng.randint(5_000, 20_000)
        model.txs.append({"id": _credit(staff, user["id"], amount), "from": None, "to": user["id"], "amount": amount,
                          "cur": "USD"})
        model.added[user["id"]] += amount
    now = datetime.now(timezone.utc)
    done: list[str] = []
    spent_so_far = {user["id"]: 0 for user in users}

    def check(number: int) -> None:
        for user in users:
            with db_conn() as conn:
                summary = wallet_summary(conn, user["id"], now)
            expected = model.expected(user["id"])
            got = {key: summary["usd"][key] for key in expected}
            assert got == expected, (seed, number, done[-6:], user["id"])
            assert summary["lyd"]["balanceMinor"] == model.lyd[user["id"]], (seed, number)
            _assert_identity(summary, user["id"])
            assert summary["usd"]["spentMinor"] >= spent_so_far[user["id"]], (seed, number)  # spent never goes back
            spent_so_far[user["id"]] = summary["usd"]["spentMinor"]

    for number in range(STEPS):
        done.append(_step(rng, model, staff))
        check(number)
    # The orphan sweep reaches every crashed send-back in the end: nothing stays "being returned".
    for campaign in [c for c in model.campaigns.values() if c["crashed"]]:
        assert _release(staff, campaign["id"])
        campaign["crashed"] = False
        done.append("sweep")
        check(STEPS)
    for user in users:
        assert _summary(user)["usd"]["beingReturnedMinor"] == 0
        assert _summary(user)["usd"] == wallet_summary_now(user["id"])["usd"]  # the route says what the code says
    return done


def test_wallet_identity_property(staff):
    ran: set[str] = set()
    for seed in SEEDS:
        ran |= {step for step in _run_sequence(staff, seed) if " " not in step}
    assert ran == OPERATIONS, sorted(OPERATIONS - ran)  # together the sequences used every operation


def wallet_summary_now(user_id: str) -> dict:
    with db_conn() as conn:
        return wallet_summary(conn, user_id, studio_results.utc_now())
