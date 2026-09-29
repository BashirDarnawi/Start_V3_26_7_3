"""Review loop round 2, batch T (texts shown to users): the server contracts the client fixes rely on.

Batch T changed only screens (15c, 15f, 15g, 15o, 15p, 15r and one startup line in 09-api-auth.js); their
behaviour tests are in scripts/test-mobile-ui.js. These tests pin what those screens now depend on:

* n=30 the Team desk's new "Stop & return all" on the launch card of a never-linked Approved request (no stop
       request, before its end date, its start day already passed so the owner can no longer stop it): the
       staff /stop with the whole payment and closeReason staff_stop is accepted (settle_plan never_linked),
       returns everything to the wallet and shows stage 12 "Stopped" (money "returned").
* n=29 the classic staff close now sends closeReason 'completed' for a launched ad past its end with no stop
       request: stage 11 "Finished"; without it the server keeps its staff_stop default (stage 12).
* n=26 the classic staff close pre-fills the cap from the staff results view: that view carries Meta's
       confirmed spend of the linked campaign (metaCampaignId, currency, spendMinorUSD, spendConfirmedAt,
       neverDelivered).

Every test builds its own users (unique e-mails per run) through the real routes.
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
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_actions as actions
from server.systems.ads_studio.studio_results import derive_display_stage, libya_today, results_view

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR2TPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
UTC = timezone.utc
_counter = [0]


def _uid(prefix: str) -> str:
    _counter[0] += 1
    return f"{prefix}_{TAG}_{_counter[0]}"


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl_r2t_user")
    email = f"review-loop-r2t-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R2T {label}", "email": email, "role": role,
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


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)
    monkeypatch.setattr(actions, "check_rate_limit", lambda *a, **k: (True, 1, 0))


def _credit(staff, user_id: str, amount: int) -> None:
    response = client.post("/api/wallet/top-ups", json={"userId": user_id, "amountMinor": amount, "currency": "USD",
                                                        "idempotencyKey": _uid("topup-key")}, cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text


def _balance(user_id: str) -> int:
    with db_conn() as conn:
        return main_module._wallet_balance_minor(conn, user_id, "USD")


def _last_modified(campaign_id: str) -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT last_modified FROM entities WHERE type = :t AND id = :id"),
                                {"t": CAMPAIGNS, "id": campaign_id}).scalar())


def _data(campaign_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).scalar()
    return {**json_loads(row), "id": campaign_id}


def _force(campaign_id: str, **fields) -> None:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
        data = {**json_loads(row["data_json"]), **fields}
        modified = max(now_ms(), int(row["last_modified"]) + 1)
        data["_lastModified"] = modified
        conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = :t AND id = :id"),
                     {"d": json_dumps(data), "m": modified, "t": CAMPAIGNS, "id": campaign_id})


def _approved(staff, budget: int = 3000) -> tuple[dict, str]:
    """A customer with the ad_maker plan and an Approved (captured) request running 2027-01-10 .. 2027-01-20."""
    user = _insert_user("customer", "Employee", CUSTOMER_PERMISSIONS)
    bought = client.post("/api/subscriptions/purchase", json={"serviceId": "ad_maker", "idempotencyKey": _uid("sub-key")},
                         cookies=user["cookies"])
    assert bought.status_code == 200, bought.text
    _credit(staff, user["id"], budget)
    campaign_id = _uid("r2tcmp")
    body = {
        "name": f"R2T offer {campaign_id}", "objective": "messages", "platforms": ["facebook", "instagram"],
        "pageName": "R2T Test Page", "primaryText": "Message us for this week's offer.", "headline": "Weekly offer",
        "description": "R2T test.", "callToAction": "Send Message", "destination": "https://wa.me/218910000000",
        "locations": ["Tripoli, Libya"], "ageMin": 18, "ageMax": 55, "genders": ["all"], "languages": ["Arabic"],
        "interests": ["Shopping"], "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": budget,
        "budgetType": "lifetime", "notes": "", "specialAdCategories": ["none"], "creativeImages": [PNG], "creativeAssetIds": [],
    }
    created = client.post(f"/api/collections/{CAMPAIGNS}", json={"id": campaign_id, "data": body}, cookies=user["cookies"])
    assert created.status_code == 200, created.text
    submitted = client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                            json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                            cookies=user["cookies"])
    assert submitted.status_code == 200, submitted.text
    reviewed = client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": _last_modified(campaign_id), "decision": "Approved", "note": "",
        "operationId": _uid("review-op"), "reviewReasonCode": "",
    }, cookies=staff["reviewer"]["cookies"])
    assert reviewed.status_code == 200, reviewed.text
    return user, campaign_id


def _stop(cookies: dict, campaign_id: str, refund: int | None = None, **extra):
    body = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("stop-op"), "reason": None, **extra}
    if refund is not None:
        body["refundMinorUSD"] = refund
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop", json=body, cookies=cookies)


def _days_from_today(days: int) -> str:
    return (libya_today(datetime.now(UTC)) + timedelta(days=days)).isoformat()


# ------------------------------------------------------------------ n=30: the desk's stop before the ad ran

def test_a_never_linked_approved_ad_is_stopped_by_staff_before_its_end_with_everything_back(staff):
    user, campaign_id = _approved(staff, 3000)
    # Its start day passed (the owner can no longer stop it), its end is still ahead, and it was never linked.
    _force(campaign_id, startDate=_days_from_today(-2), endDate=_days_from_today(5))
    before = _balance(user["id"])
    own = _stop(user["cookies"], campaign_id)
    assert own.status_code == 409 and "already started" in own.text, own.text

    stopped = _stop(staff["reviewer"]["cookies"], campaign_id, 3000, closeReason="staff_stop")
    assert stopped.status_code == 200, stopped.text
    data = _data(campaign_id)
    assert data["status"] == "Stopped" and int(data["refundMinorUSD"]) == 3000
    assert data["closeReason"] == "staff_stop" and data["settleBasis"] == "never_linked"
    assert _balance(user["id"]) == before + 3000
    stage = derive_display_stage(data, None, datetime.now(UTC))
    assert stage["stage"] == 12 and stage["moneyKey"] == "returned"


# ------------------------------------------------------------------ n=29: a finished ad closes as completed

def test_the_classic_close_of_an_ended_launched_ad_shows_finished_only_with_completed(staff):
    ended = {"publishStatus": "live", "startDate": _days_from_today(-10), "endDate": _days_from_today(-3)}
    _user, finished_id = _approved(staff, 2000)
    _force(finished_id, **ended)
    finished = _stop(staff["reviewer"]["cookies"], finished_id, 0, closeReason="completed")
    assert finished.status_code == 200, finished.text
    finished_data = _data(finished_id)
    assert finished_data["closeReason"] == "completed"
    assert derive_display_stage(finished_data, None, datetime.now(UTC))["stage"] == 11

    # The old classic body (no closeReason): the server's staff_stop default, stage 12 "Stopped".
    _user, plain_id = _approved(staff, 2000)
    _force(plain_id, **ended)
    plain = _stop(staff["reviewer"]["cookies"], plain_id, 0)
    assert plain.status_code == 200, plain.text
    plain_data = _data(plain_id)
    assert plain_data["closeReason"] == "staff_stop"
    assert derive_display_stage(plain_data, None, datetime.now(UTC))["stage"] == 12


# ------------------------------------------------------------------ n=26: what the classic close pre-fills from

def test_the_staff_results_view_carries_the_confirmed_spend_the_classic_close_reads():
    now = datetime.now(UTC)
    meta_id = "120200000000026" + f"{int(TAG, 16) % 1000:03d}"
    request = {"id": "r2t_view", "status": "Approved", "metaCampaignId": meta_id, "metaAdAccountId": "7771",
               "paidMinorUSD": 10000, "startDate": _days_from_today(-10), "endDate": _days_from_today(-3)}
    row = {"metaCampaignId": meta_id, "currency": "USD", "spendMinorUSD": 3000,
           "spendConfirmedAt": (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
           "lastSyncedAt": (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"), "neverDelivered": False}
    staff_view = results_view(request, row, now, staff=True)["staff"]
    for field in ("metaCampaignId", "currency", "spendMinorUSD", "spendConfirmedAt", "neverDelivered"):
        assert field in staff_view, field
    assert staff_view["metaCampaignId"] == meta_id and staff_view["currency"] == "USD" and staff_view["spendMinorUSD"] == 3000
    assert staff_view["spendConfirmedAt"] and staff_view["neverDelivered"] is False
    assert "staff" not in results_view(request, row, now, staff=False)
