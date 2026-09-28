"""Review loop round 1, batch A1: server money and campaign actions.

* n=1  deleting an account with wallet money in ANY currency is refused (409), also for a users.delete
       holder who is not an admin, and the check runs again under the user row lock.
* n=4  an orphan capture returned on archive or on account deletion is audited ``wallet_release``.
* n=2  a reviewer cannot clear a desk link and set a Meta id by hand: that would wipe the recorded ad
       account and lift the settle cap (only the desk link may link such a request again).
* n=22 a stop request blocks the link and the live/paused marker of an ad never launched, unless staff
       confirm it already exists in Meta (``stopRequestAcknowledged``: recorded, and the stop row then
       resolves once Meta shows the ad paused); Stop returns the whole payment.

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
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_actions as actions
from server.systems.ads_studio import studio_settings
from server.systems.ads_studio.ad_campaign_actions import (
    REFUSE_LINK_DESK_ONLY,
    REFUSE_LINK_STOP_REQUESTED,
    REFUSE_REFUND_ABOVE_CAP,
)
from server.systems.ads_studio.studio_results import write_results_row
from server.systems.ads_studio.studio_stop import STOP_TYPE, check_stop_requests, resolve_stop_request, stop_row_id
from server.wallet_payments import capture_campaign_budget

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopA1Password123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
ACCOUNT_DIGITS = "7771" + f"{int(TAG, 16) % 10**8:08d}"
ACCOUNT = f"act_{ACCOUNT_DIGITS}"
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
UTC = timezone.utc
_counter = [0]
_ASKED: list[str] = []  # requests these tests asked to stop: their queue rows and tickets are closed at the end


def _uid(prefix: str) -> str:
    _counter[0] += 1
    return f"{prefix}_{TAG}_{_counter[0]}"


def _meta_id() -> str:
    _counter[0] += 1
    return f"1207{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ------------------------------------------------------------------ people

def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl_a1_user")
    email = f"review-loop-a1-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"A1 {label}", "email": email, "role": role,
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
        "manager": _insert_user("manager", "Employee", {"users": ["view", "delete"]}),
    }


@pytest.fixture(scope="module", autouse=True)
def _stop_requests_closed_afterwards():
    """Later modules count the desk's open stop requests and tickets: none of these outlives the module."""
    yield
    for campaign_id in _ASKED:
        resolve_stop_request(campaign_id, "stopped")


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)
    monkeypatch.setattr(actions, "check_rate_limit", lambda *a, **k: (True, 1, 0))


@pytest.fixture(autouse=True)
def _settings_restored():
    """The stop-request service is switched on for these tests; every settings row is put back after."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    yield
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'studioSettings'"))
        for row in saved:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                row,
            )


def _stop_requests_on() -> None:
    record = studio_settings.read_setting("rollout")
    studio_settings.save_setting("rollout", {"services": {"help": "on", "stopRequest": "on", "tiktok": "off"}},
                                 record["version"], "", "2026-09-29T00:00:00Z", audit=lambda *args: None)


# ------------------------------------------------------------------ money and requests (real routes)

def _credit(staff, user_id: str, amount: int, currency: str = "USD") -> str:
    response = client.post("/api/wallet/top-ups", json={"userId": user_id, "amountMinor": amount, "currency": currency,
                                                        "idempotencyKey": _uid("topup-key")}, cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _reverse(staff, transaction_id: str) -> None:
    response = client.post("/api/wallet/reversals", json={"transactionId": transaction_id},
                           cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text


def _balance(user_id: str, currency: str = "USD") -> int:
    with db_conn() as conn:
        return main_module._wallet_balance_minor(conn, user_id, currency)


def _is_deleted(user_id: str) -> bool:
    with db_conn() as conn:
        return bool(conn.execute(text("SELECT deleted FROM users WHERE id = :id"), {"id": user_id}).scalar())


def _delete_user(cookies: dict, user_id: str):
    return client.patch(f"/api/users/{user_id}", json={"deleted": True}, cookies=cookies)


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
    campaign_id = _uid("a1cmp")
    body = {
        "name": f"A1 offer {campaign_id}", "objective": "messages", "platforms": ["facebook", "instagram"],
        "pageName": "A1 Test Page", "primaryText": "Message us for this week's offer.", "headline": "Weekly offer",
        "description": "A1 test.", "callToAction": "Send Message", "destination": "https://wa.me/218910000000",
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


def _approve(staff, campaign_id: str) -> None:
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": "Approved", "note": "",
        "operationId": _uid("review-op"), "reviewReasonCode": "",
    }, cookies=staff["reviewer"]["cookies"])
    assert response.status_code == 200, response.text


def _approved(staff, budget: int = 3000) -> tuple[dict, str]:
    user = _customer(staff)
    _credit(staff, user["id"], budget)
    campaign_id = _create(user, budget)
    _submit(user, campaign_id)
    _approve(staff, campaign_id)
    return user, campaign_id


def _crash_capture(staff, campaign_id: str) -> None:
    """An approval that captured the budget and died before its status write."""
    with main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        capture_campaign_budget(conn, main_module._WALLET_PAYMENTS_CTX, _data(campaign_id), staff["reviewer"]["id"])


def _stop(cookies: dict, campaign_id: str, refund: int | None = None, **extra):
    body = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("stop-op"), "reason": "test", **extra}
    if refund is not None:
        body["refundMinorUSD"] = refund
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop", json=body, cookies=cookies)


def _publish(staff, campaign_id: str, **body):
    payload = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("publish-op"), **body}
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/publish-status", json=payload,
                       cookies=staff["reviewer"]["cookies"])


def _ask_stop(user: dict, campaign_id: str):
    _ASKED.append(campaign_id)
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                       json={"operationId": _uid("stop-request-op")}, cookies=user["cookies"])


def _audits(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
            {"id": resource_id, "action": action},
        ).mappings().all()
    return [{"user_id": row["user_id"], **(json_loads(row["metadata_json"]) or {})} for row in rows]


def _release_rows(campaign_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id, data_json FROM entities WHERE type = 'walletTransactions' AND data_json LIKE :like"),
            {"like": f"%rel:cpay:{campaign_id}:%"},
        ).mappings().all()
    return [{"id": row["id"], **(json_loads(row["data_json"]) or {})} for row in rows]


def _stop_row(campaign_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": STOP_TYPE, "id": stop_row_id(campaign_id)}).scalar()
    return json_loads(row) or {}


# ------------------------------------------------------------------ n=1: an account with wallet money is never deleted

def test_an_account_with_wallet_money_in_any_currency_cannot_be_deleted(staff):
    customer = _insert_user("walletholder", "Employee", {})
    usd = _credit(staff, customer["id"], 3700, "USD")
    refused = _delete_user(staff["admin"]["cookies"], customer["id"])
    assert refused.status_code == 409 and "money in its wallet" in refused.json()["detail"], refused.text
    assert not _is_deleted(customer["id"])
    # A users.delete holder who is not an admin sees no one else's ledger: the server still refuses.
    by_manager = _delete_user(staff["manager"]["cookies"], customer["id"])
    assert by_manager.status_code == 409 and "money in its wallet" in by_manager.json()["detail"], by_manager.text
    assert not _is_deleted(customer["id"])

    # Any currency: the USD is returned, 150 LYD remain.
    _reverse(staff, usd)
    lyd = _credit(staff, customer["id"], 15000, "LYD")
    assert _balance(customer["id"], "USD") == 0 and _balance(customer["id"], "LYD") == 15000
    refused_lyd = _delete_user(staff["admin"]["cookies"], customer["id"])
    assert refused_lyd.status_code == 409 and "money in its wallet" in refused_lyd.json()["detail"], refused_lyd.text
    assert not _is_deleted(customer["id"])

    # Positive control: every wallet at zero, the delete goes through.
    _reverse(staff, lyd)
    deleted = _delete_user(staff["admin"]["cookies"], customer["id"])
    assert deleted.status_code == 200, deleted.text
    assert _is_deleted(customer["id"])


def test_the_delete_checks_run_again_under_the_user_row_lock(staff):
    """Money that lands after update_user's first check (a charge confirmed, a stop refund) is caught by the
    check inside the locked transaction: the delete is refused and nothing is written."""
    customer = _insert_user("racer", "Employee", {})
    _credit(staff, customer["id"], 500, "EUR")
    admin = {"id": staff["admin"]["id"], "role": "Admin"}
    with pytest.raises(HTTPException) as refused:
        main_module._apply_user_update_atomic(customer["id"], {"deleted": True, "last_modified": now_ms()}, admin)
    assert refused.value.status_code == 409 and "money in its wallet" in str(refused.value.detail)
    assert not _is_deleted(customer["id"])


# ------------------------------------------------------------------ n=4: orphan-capture returns are audited

def test_archiving_a_request_with_an_orphan_capture_audits_the_return(staff):
    customer = _customer(staff)
    _credit(staff, customer["id"], 2500)
    campaign_id = _create(customer, 2500)
    _submit(customer, campaign_id)
    _crash_capture(staff, campaign_id)  # the approval died after its capture: still Submitted
    archived = client.delete(f"/api/collections/{CAMPAIGNS}/{campaign_id}", cookies=staff["admin"]["cookies"])
    assert archived.status_code == 200, archived.text
    released = _release_rows(campaign_id)
    assert len(released) == 1 and released[0]["amountMinor"] == 2500, released
    rows = _audits(campaign_id, "wallet_release")
    assert len(rows) == 1, rows
    assert rows[0]["transactionId"] == released[0]["id"] and rows[0]["source"] == "archive"
    assert rows[0]["user_id"] == staff["admin"]["id"]


def test_account_delete_audits_the_orphan_return_and_keeps_the_money_reachable(staff):
    """The account-delete path returns a crashed approval's capture (audited wallet_release) and then
    refuses the delete, because the returned money now sits in the wallet: it is never stranded."""
    customer = _customer(staff)
    _credit(staff, customer["id"], 2500)
    campaign_id = _create(customer, 2500)
    _submit(customer, campaign_id)
    _crash_capture(staff, campaign_id)
    _force(campaign_id, status="Rejected")  # the send-back committed, its release did not
    assert _balance(customer["id"]) == 0
    refused = _delete_user(staff["admin"]["cookies"], customer["id"])
    assert refused.status_code == 409 and "money in its wallet" in refused.json()["detail"], refused.text
    assert not _is_deleted(customer["id"])
    assert _balance(customer["id"]) == 2500  # returned, and still reachable (transfer, reversal)
    released = _release_rows(campaign_id)
    assert len(released) == 1, released
    rows = _audits(campaign_id, "wallet_release")
    assert len(rows) == 1 and rows[0]["transactionId"] == released[0]["id"] and rows[0]["source"] == "account_delete", rows
    # A second attempt returns nothing new and writes no second audit row.
    assert _delete_user(staff["admin"]["cookies"], customer["id"]).status_code == 409
    assert len(_audits(campaign_id, "wallet_release")) == 1 and len(_release_rows(campaign_id)) == 1


# ------------------------------------------------------------------ n=2: a hand-set Meta id cannot wipe a desk link

def _desk_linked_and_final_read(staff) -> tuple[dict, str, str]:
    user, campaign_id = _approved(staff, 3000)
    meta_id = _meta_id()
    now = datetime.now(UTC)
    _force(campaign_id, metaCampaignId=meta_id, metaAdAccountId=ACCOUNT, publishStatus="meta_review",
           linkedAt=_iso(now), metaLinkResult={"metaCurrency": "USD"})
    ended = now - timedelta(hours=50)
    with db_conn() as conn:
        write_results_row(conn, campaign_id, user["id"], {
            "metaCampaignId": meta_id, "metaAdAccountId": ACCOUNT, "syncState": "ok", "lastSyncedAt": _iso(now),
            "currency": "USD", "insightsState": "ok", "campaignEffectiveStatus": "PAUSED", "adStatusCounts": {"PAUSED": 1},
            "anyAdDelivering": False, "deliveryEndedAt": _iso(ended), "settleReadDueAt": _iso(ended + timedelta(hours=48)),
            "settleReadAt": _iso(now), "spendMinorUSD": 2000, "spendConfirmedAt": _iso(now), "lifetimeImpressions": 900,
        })
    return user, campaign_id, meta_id


def test_clearing_a_desk_link_then_setting_a_meta_id_by_hand_is_refused(staff):
    user, campaign_id, meta_id = _desk_linked_and_final_read(staff)
    cleared = _publish(staff, campaign_id, publishStatus="")
    assert cleared.status_code == 200, cleared.text
    assert _data(campaign_id)["lastLinkedMetaAdAccountId"] == ACCOUNT
    for hand_id in (meta_id, _meta_id()):  # the same campaign again, or any unclaimed number
        remarked = _publish(staff, campaign_id, publishStatus="live", metaCampaignId=hand_id)
        assert remarked.status_code == 409 and remarked.json()["detail"] == REFUSE_LINK_DESK_ONLY, remarked.text
    data = _data(campaign_id)
    assert data["lastLinkedMetaCampaignId"] == meta_id and data["lastLinkedMetaAdAccountId"] == ACCOUNT
    assert data["metaCampaignId"] == "" and data["everLinked"] is True
    # The settle cap still holds: paid 30.00 minus Meta's 20.00.
    above = _stop(staff["reviewer"]["cookies"], campaign_id, 3000)
    assert above.status_code == 400 and above.json()["detail"].startswith(REFUSE_REFUND_ABOVE_CAP), above.text
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert settled.status_code == 200, settled.text
    assert settled.json()["data"]["refundMinorUSD"] == 1000 and settled.json()["data"]["settleBasis"] == "final_read"
    assert _audits(campaign_id, "settle_override") == []


def test_a_hand_marker_without_a_desk_link_still_works(staff):
    """Control: a request the desk never linked may still carry a hand-set Meta id (the classic marker)."""
    _user, campaign_id = _approved(staff, 1500)
    meta_id = _meta_id()
    marked = _publish(staff, campaign_id, publishStatus="live", metaCampaignId=meta_id)
    assert marked.status_code == 200, marked.text
    assert _data(campaign_id)["metaCampaignId"] == meta_id


# ------------------------------------------------------------------ n=22: a stop request blocks the launch

class _FakeMeta:
    """The Meta client the desk link reads (no network): one campaign already named with the studio code."""

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

    def rename_campaign(self, campaign_id, name):  # never needed: the name already carries the code
        raise AssertionError("no rename expected")


@pytest.fixture()
def meta(monkeypatch):
    fake = _FakeMeta()
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"a1-token-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", f"a1-secret-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_ID", "123456789012345")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT_DIGITS)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    return fake


def _stop_asked(staff) -> tuple[dict, str]:
    _stop_requests_on()
    user, campaign_id = _approved(staff, 2000)
    asked = _ask_stop(user, campaign_id)
    assert asked.status_code == 200, asked.text
    assert _stop_row(campaign_id)["deliveringAtRequest"] is False and _stop_row(campaign_id)["state"] == "open"
    return user, campaign_id


def test_a_stop_request_blocks_the_link_and_the_launch_marker(staff, meta):
    user, campaign_id = _stop_asked(staff)
    meta_id = _meta_id()
    meta.campaigns[meta_id] = {"name": f"{_data(campaign_id).get('studioRef') or 'x'} · made anyway"}
    live = _publish(staff, campaign_id, publishStatus="live")
    assert live.status_code == 409 and live.json()["detail"] == REFUSE_LINK_STOP_REQUESTED, live.text
    paused = _publish(staff, campaign_id, publishStatus="paused")
    assert paused.status_code == 409 and paused.json()["detail"] == REFUSE_LINK_STOP_REQUESTED, paused.text
    hand = _publish(staff, campaign_id, publishStatus="live", metaCampaignId=meta_id)
    assert hand.status_code == 409 and hand.json()["detail"] == REFUSE_LINK_STOP_REQUESTED, hand.text
    desk = _publish(staff, campaign_id, metaAdAccountId=ACCOUNT_DIGITS, metaCampaignId=meta_id)
    assert desk.status_code == 409 and desk.json()["detail"] == REFUSE_LINK_STOP_REQUESTED, desk.text
    assert meta.reads == []  # refused before any Meta call
    data = _data(campaign_id)
    assert not str(data.get("publishStatus") or "") and not str(data.get("metaCampaignId") or "") and data.get("everLinked") is not True
    # Staff settle it instead: never linked, the whole payment back, the stop request handled.
    stopped = _stop(staff["reviewer"]["cookies"], campaign_id, closeReason="customer_stop")
    assert stopped.status_code == 200, stopped.text
    body = stopped.json()["data"]
    assert body["settleBasis"] == "never_linked" and body["refundMinorUSD"] == 2000 and body["closeReason"] == "customer_stop"
    assert _balance(user["id"]) == 2000
    assert _stop_row(campaign_id)["state"] == "resolved"


def test_an_acknowledged_desk_link_over_a_stop_request_is_recorded_and_resolves_once_meta_pauses(staff, meta):
    user, campaign_id = _stop_asked(staff)
    meta_id = _meta_id()
    ref = _data(campaign_id).get("studioRef") or ""
    assert ref.startswith("ALB-S-")
    meta.campaigns[meta_id] = {"name": f"{ref} · already made in Meta"}
    linked = _publish(staff, campaign_id, metaAdAccountId=ACCOUNT_DIGITS, metaCampaignId=meta_id, stopRequestAcknowledged=True)
    assert linked.status_code == 200, linked.text
    data = _data(campaign_id)
    assert data["metaCampaignId"] == meta_id and data["metaAdAccountId"] == ACCOUNT
    row = _stop_row(campaign_id)
    assert row["deliveringAtRequest"] is True and row["state"] == "open" and row.get("launchedOverRequestAt")
    recorded = [item for item in _audits(campaign_id, "stop_request") if item.get("stopRequestAcknowledged") is True]
    assert len(recorded) == 1 and recorded[0]["metaCampaignId"] == meta_id and recorded[0]["user_id"] == staff["reviewer"]["id"]
    # Meta shows the ad paused in a read after the request: the stop request is handled.
    later = datetime.now(UTC) + timedelta(minutes=5)
    with db_conn() as conn:
        write_results_row(conn, campaign_id, user["id"], {
            "metaCampaignId": meta_id, "metaAdAccountId": ACCOUNT, "syncState": "ok", "lastSyncedAt": _iso(later),
            "adStatusCounts": {"PAUSED": 1}, "campaignEffectiveStatus": "PAUSED", "anyAdDelivering": False, "currency": "USD",
        })
    outcome = check_stop_requests(later + timedelta(minutes=1))
    assert campaign_id in outcome["resolved"], outcome
    assert _stop_row(campaign_id)["resolvedReason"] == "meta_paused"


def test_an_acknowledged_launch_marker_over_a_stop_request_is_recorded(staff):
    _user, campaign_id = _stop_asked(staff)
    meta_id = _meta_id()
    marked = _publish(staff, campaign_id, publishStatus="live", metaCampaignId=meta_id, stopRequestAcknowledged=True)
    assert marked.status_code == 200, marked.text
    assert _data(campaign_id)["metaCampaignId"] == meta_id and _data(campaign_id)["publishStatus"] == "live"
    assert _stop_row(campaign_id)["deliveringAtRequest"] is True
    assert [item for item in _audits(campaign_id, "stop_request") if item.get("stopRequestAcknowledged") is True]
    # A request that was launched before the stop request is not blocked (no acknowledgement needed).
    _user2, launched = _approved(staff, 1200)
    assert _publish(staff, launched, publishStatus="live").status_code == 200
    asked = _ask_stop(_user2, launched)
    assert asked.status_code == 200, asked.text
    assert _publish(staff, launched, publishStatus="paused").status_code == 200
