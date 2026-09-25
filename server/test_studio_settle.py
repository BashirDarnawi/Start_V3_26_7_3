"""Albayan Studio settle gates and the admin override (plan tasks P3-06a, P3-06d; PLAN.md §7.8 rule 5,
§7.3 the /stop and /settle-override rows; DECISIONS D27, D28).

Money states come from the real routes (test_studio_wallet's helpers: charge, create, submit,
approve); the desk link and Meta's numbers are written straight into the rows, as the link step
and the results sync leave them (Meta is never called). Every test creates its own customer
(unique e-mails per run); the rows this module wrote are removed when it ends.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_loads
from server.systems.ads_studio import ad_campaign_actions as actions, studio_settings
from server.systems.ads_studio.ad_campaign_actions import (
    REFUSE_OVERRIDE_ADMIN,
    REFUSE_OVERRIDE_REASON,
    REFUSE_OVERRIDE_REFUND,
    REFUSE_REFUND_ABOVE_CAP,
    REFUSE_REFUND_ABOVE_PAID,
    REFUSE_REFUND_LAUNCHED,
    REFUSE_SETTLE_DELIVERING,
    REFUSE_SETTLE_NOT_ENDED,
    REFUSE_SETTLE_NOT_READY,
    REFUSE_SETTLE_NOT_USD,
    SETTLE_NOT_READY,
    SETTLE_NOT_READY_AR,
    settle_plan,
)
from server.systems.ads_studio.studio_diagnostics import libya_today
from server.systems.ads_studio.studio_jobs import ALERTS_TYPE, alert_id
from server.systems.ads_studio.studio_results import RESULTS_TYPE, results_id, write_results_row
from server.test_studio_wallet import (
    CAMPAIGNS,
    _campaign_data,
    _create,
    _credit,
    _customer,
    _force,
    _insert_user,
    _last_modified,
    _meta_id,
    _review,
    _stop,
    _submit,
    _uid,
    client,
)
from server.wallet_payments import wallet_ledger_rows

UTC = timezone.utc
ACCOUNT = "act_1234567890"
STUDIO_REF = "ALB-S-SETTLE22"
_WRITTEN: list[str] = []


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("settle-admin", "Admin", {}),
        "reviewer": _insert_user("settle-reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


@pytest.fixture(autouse=True)
def _settings_restored():
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


@pytest.fixture(scope="module", autouse=True)
def _rows_cleanup():
    yield
    with db_conn() as conn:
        for campaign_id in _WRITTEN:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": RESULTS_TYPE, "id": results_id(campaign_id)})
            conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"),
                         {"t": ALERTS_TYPE, "like": f"%{campaign_id}%"})


# ------------------------------------------------------------------ helpers

def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _approved(staff, budget: int = 3000) -> tuple[dict, str]:
    user = _customer("settle")
    _credit(staff, user["id"], budget)
    campaign_id = _create(user, budget)
    assert _submit(user, campaign_id).status_code == 200
    assert _review(staff, campaign_id, "Approved").status_code == 200, campaign_id
    _WRITTEN.append(campaign_id)
    return user, campaign_id


def _linked(staff, budget: int = 3000) -> tuple[dict, str, str]:
    """An Approved request linked by the desk (account + Meta campaign id, as _link_meta_campaign writes)."""
    user, campaign_id = _approved(staff, budget)
    meta_id = _meta_id()
    with db_conn() as conn:
        _force(campaign_id, conn, metaCampaignId=meta_id, metaAdAccountId=ACCOUNT, publishStatus="meta_review",
               studioRef=STUDIO_REF, linkedAt=_iso(_now()), metaLinkResult={"metaCurrency": "USD"})
    return user, campaign_id, meta_id


def _results(campaign_id: str, owner_id: str, meta_id: str, **fields) -> None:
    stamp = _iso(_now())
    base = {"metaCampaignId": meta_id, "metaAdAccountId": ACCOUNT, "syncState": "ok", "lastSyncedAt": stamp,
            "currency": "USD", "insightsState": "ok", "campaignEffectiveStatus": "PAUSED", "adStatusCounts": {"PAUSED": 1}}
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner_id, {**base, **fields})


def _refunds(user_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = wallet_ledger_rows(conn, user_id)
    return [row for row in rows if str(row.get("idempotencyKey") or "").startswith("stoprefund:")]


def _balance(user: dict) -> int:
    summary = client.get("/api/studio/wallet/summary", cookies=user["cookies"])
    assert summary.status_code == 200, summary.text
    return int(summary.json()["usd"]["availableMinor"])


def _override(cookies: dict, campaign_id: str, **body):
    payload = {"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("override-op"), **body}
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/settle-override", json=payload, cookies=cookies)


def _audits(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, action, metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
            {"id": resource_id, "action": action},
        ).mappings().all()
    return [dict(row) for row in rows]


def _setting(key: str, **fields) -> None:
    record = studio_settings.read_setting(key)
    studio_settings.save_setting(key, fields, record["version"], "", "2026-09-25T00:00:00Z", audit=lambda *args: None)


# ------------------------------------------------------------------ the gates (P3-06a)

def test_settle_gate_refuses_while_meta_delivers(staff):
    user, campaign_id, meta_id = _linked(staff)
    _results(campaign_id, user["id"], meta_id, campaignEffectiveStatus="ACTIVE", adStatusCounts={"ACTIVE": 1},
             anyAdDelivering=True, spendMinorUSD=500, spendConfirmedAt=_iso(_now()))
    refused = _stop(staff["reviewer"]["cookies"], campaign_id, 2500)
    assert refused.status_code == 409 and refused.json()["detail"].startswith(REFUSE_SETTLE_DELIVERING), refused.text
    data = _campaign_data(campaign_id)
    assert data["status"] == "Approved" and "settleBasis" not in data
    assert _refunds(user["id"]) == [] and _balance(user) == 0

    # Nothing delivers, but the sync never saw delivery end: still no settle.
    _results(campaign_id, user["id"], meta_id, campaignEffectiveStatus="PAUSED", adStatusCounts={"PAUSED": 1},
             anyAdDelivering=False)
    refused = _stop(staff["reviewer"]["cookies"], campaign_id, 2500)
    assert refused.status_code == 409 and refused.json()["detail"].startswith(REFUSE_SETTLE_NOT_ENDED), refused.text
    assert _campaign_data(campaign_id)["status"] == "Approved"


def test_settle_gate_waits_for_the_final_read(staff):
    user, campaign_id, meta_id = _linked(staff)
    ended = _now() - timedelta(hours=1)
    _results(campaign_id, user["id"], meta_id, anyAdDelivering=False, deliveryEndedAt=_iso(ended),
             settleReadDueAt=_iso(ended + timedelta(hours=48)), spendMinorUSD=500, spendConfirmedAt=_iso(ended))
    refused = _stop(staff["reviewer"]["cookies"], campaign_id, 2500)
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == SETTLE_NOT_READY and detail["message"].startswith(REFUSE_SETTLE_NOT_READY)
    assert detail["messageAr"].startswith(SETTLE_NOT_READY_AR) and "until" in detail["message"]
    ready_at = datetime.fromisoformat(detail["readyAt"].replace("Z", "+00:00"))
    assert abs((ready_at - (ended + timedelta(hours=48))).total_seconds()) < 1
    assert detail["readyAt"] in detail["message"] and detail["readyAt"] in detail["messageAr"]
    assert _campaign_data(campaign_id)["status"] == "Approved" and _refunds(user["id"]) == []

    # The wait is the settlement setting, not a number in the code: 1 hour, and a spend confirmed
    # after delivery ended plus that hour counts as the final read.
    _setting("settlement", spendDelayHours=1, neverDeliveredImmediate=True, driftWatchDays=28)
    _results(campaign_id, user["id"], meta_id, spendConfirmedAt=_iso(ended + timedelta(minutes=30)))
    still = _stop(staff["reviewer"]["cookies"], campaign_id, 2500)
    assert still.status_code == 409 and still.json()["detail"]["code"] == SETTLE_NOT_READY, still.text
    _results(campaign_id, user["id"], meta_id, spendConfirmedAt=_iso(_now()))

    # Above the cap (paid 3000 - Meta 500) -> 400, nothing moves.
    too_much = _stop(staff["reviewer"]["cookies"], campaign_id, 2501)
    assert too_much.status_code == 400 and too_much.json()["detail"].startswith(REFUSE_REFUND_ABOVE_CAP), too_much.text
    assert _refunds(user["id"]) == []

    # No amount given: the cap comes back; the row records what the settle was based on.
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert settled.status_code == 200, settled.text
    data = settled.json()["data"]
    assert data["status"] == "Stopped" and data["closeReason"] == "staff_stop"
    assert data["refundMinorUSD"] == 2500 and data["spendMinorUSD"] == 500
    assert data["settleBasis"] == "final_read" and data["metaSpendAtSettleMinorUSD"] == 500
    assert data["settledSpendMinorUSD"] == 500 and data["settledAt"] == data["stoppedAt"]
    assert data["settleOverrideReason"] == ""
    refunds = _refunds(user["id"])
    assert len(refunds) == 1 and int(refunds[0]["amountMinor"]) == 2500
    assert _balance(user) == 2500
    assert _audits(campaign_id, "settle_override") == []


def test_settle_gate_final_read_stamp_opens_the_settle(staff):
    """settleReadAt written by the sync's final read counts, whatever the spend confirmation time."""
    user, campaign_id, meta_id = _linked(staff)
    ended = _now() - timedelta(hours=50)
    _results(campaign_id, user["id"], meta_id, anyAdDelivering=False, deliveryEndedAt=_iso(ended),
             settleReadDueAt=_iso(ended + timedelta(hours=48)), settleReadAt=_iso(ended + timedelta(hours=48)),
             spendMinorUSD=3000, spendConfirmedAt=_iso(ended + timedelta(hours=48)), lifetimeImpressions=1200)
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert settled.status_code == 200, settled.text
    data = settled.json()["data"]
    assert data["refundMinorUSD"] == 0 and data["refundTransactionId"] == "" and data["settleBasis"] == "final_read"
    assert data["metaSpendAtSettleMinorUSD"] == 3000 and data["settledSpendMinorUSD"] == 3000
    assert _refunds(user["id"]) == [] and _balance(user) == 0


def test_settle_gate_non_usd_account_needs_the_override(staff):
    user, campaign_id, meta_id = _linked(staff)
    ended = _now() - timedelta(hours=60)
    _results(campaign_id, user["id"], meta_id, anyAdDelivering=False, deliveryEndedAt=_iso(ended), currency="EUR",
             rawSpendMinor=400, rawSpendCurrency="EUR", syncState="error", lastErrorCode="currency_mismatch")
    refused = _stop(staff["reviewer"]["cookies"], campaign_id, 2600)
    assert refused.status_code == 409 and refused.json()["detail"].startswith(REFUSE_SETTLE_NOT_USD), refused.text
    lifted = _override(staff["admin"]["cookies"], campaign_id, refundMinorUSD=2600,
                       reason="Account bills in EUR; spend read in Ads Manager by the owner")
    assert lifted.status_code == 200, lifted.text
    data = lifted.json()["data"]
    assert data["settleBasis"] == "override" and data["metaSpendAtSettleMinorUSD"] is None
    assert data["refundMinorUSD"] == 2600 and data["settledSpendMinorUSD"] == 400
    assert _balance(user) == 2600


def test_never_delivered_full_return(staff):
    user, campaign_id, meta_id = _linked(staff)
    ended = _now() - timedelta(hours=1)
    _results(campaign_id, user["id"], meta_id, anyAdDelivering=False, deliveryEndedAt=_iso(ended),
             settleReadDueAt=_iso(ended + timedelta(hours=48)), neverDelivered=True, lifetimeImpressions=0,
             spendMinorUSD=0, spendConfirmedAt=_iso(ended))
    settled = _stop(staff["reviewer"]["cookies"], campaign_id)  # no amount: the whole payment, at once
    assert settled.status_code == 200, settled.text
    data = settled.json()["data"]
    assert data["status"] == "Stopped" and data["refundMinorUSD"] == 3000 and data["spendMinorUSD"] == 0
    assert data["settleBasis"] == "never_delivered" and data["metaSpendAtSettleMinorUSD"] == 0
    assert data["settledSpendMinorUSD"] == 0 and data["settledAt"]
    refunds = _refunds(user["id"])
    assert len(refunds) == 1 and int(refunds[0]["amountMinor"]) == 3000 and _balance(user) == 3000
    again = _stop(staff["reviewer"]["cookies"], campaign_id)
    assert again.status_code == 409 and again.json()["detail"] == "Only Approved campaigns can be stopped"
    assert len(_refunds(user["id"])) == 1  # one return per cycle

    # The flag alone is not enough: impressions or spend make it an ordinary ended ad (the wait applies).
    user2, campaign2, meta2 = _linked(staff)
    _results(campaign2, user2["id"], meta2, anyAdDelivering=False, deliveryEndedAt=_iso(ended),
             settleReadDueAt=_iso(ended + timedelta(hours=48)), neverDelivered=True, lifetimeImpressions=40,
             spendMinorUSD=0, spendConfirmedAt=_iso(ended))
    waits = _stop(staff["reviewer"]["cookies"], campaign2)
    assert waits.status_code == 409 and waits.json()["detail"]["code"] == SETTLE_NOT_READY, waits.text


def test_unlinked_staff_stop_keeps_the_older_rules(staff):
    user, campaign_id = _approved(staff)
    settled = _stop(staff["reviewer"]["cookies"], campaign_id, 1500)
    assert settled.status_code == 200, settled.text
    data = settled.json()["data"]
    assert data["refundMinorUSD"] == 1500 and data["spendMinorUSD"] == 1500
    assert data["settleBasis"] == "never_linked" and data["metaSpendAtSettleMinorUSD"] is None
    assert data["settledSpendMinorUSD"] == 1500 and data["settledAt"]

    # A legacy request marked launched by hand (no account): the amount stays required and bounded.
    user2, campaign2 = _approved(staff)
    with db_conn() as conn:
        _force(campaign2, conn, publishStatus="live", metaCampaignId="123456789")
    missing = _stop(staff["reviewer"]["cookies"], campaign2)
    assert missing.status_code == 400 and missing.json()["detail"] == REFUSE_REFUND_LAUNCHED, missing.text
    partial = _stop(staff["reviewer"]["cookies"], campaign2, 1000)
    assert partial.status_code == 200, partial.text
    assert partial.json()["data"]["settleBasis"] == "" and partial.json()["data"]["settledSpendMinorUSD"] == 2000


def test_settle_plan_is_pure():
    now = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)
    linked = {"status": "Approved", "metaCampaignId": "120212345", "metaAdAccountId": ACCOUNT, "endDate": "2026-09-20"}
    row = {"metaCampaignId": "120212345", "currency": "USD", "spendMinorUSD": 700, "spendConfirmedAt": "2026-09-23T12:00:00Z",
           "deliveryEndedAt": "2026-09-21T12:00:00Z", "settleReadAt": "2026-09-23T12:00:00Z", "adStatusCounts": {"PAUSED": 2}}
    plan = settle_plan(linked, row, 3000, None, now, {"spendDelayHours": 48})
    assert plan == {"refund": 2300, "capMinorUSD": 2300, "metaSpendMinorUSD": 700, "settleBasis": "final_read", "absorbedMinorUSD": 0}
    # Meta spent more than the customer paid: the cap is 0 and Albayan absorbs the rest (D27).
    over = settle_plan(linked, {**row, "spendMinorUSD": 3400}, 3000, None, now, {"spendDelayHours": 48})
    assert over["refund"] == 0 and over["capMinorUSD"] == 0 and over["absorbedMinorUSD"] == 400
    # The override lifts the cap up to the payment; what comes back above the cap is absorbed too.
    lifted = settle_plan(linked, {**row, "adStatusCounts": {"ACTIVE": 1}}, 3000, 3000, now, {"spendDelayHours": 48},
                         override_reason="Owner decision after a dispute")
    assert lifted == {"refund": 3000, "capMinorUSD": 2300, "metaSpendMinorUSD": 700, "settleBasis": "override", "absorbedMinorUSD": 700}
    with pytest.raises(actions.HTTPException) as refused:
        settle_plan(linked, row, 3000, 3001, now, {"spendDelayHours": 48}, override_reason="Owner decision after a dispute")
    assert refused.value.status_code == 400 and refused.value.detail == REFUSE_REFUND_ABOVE_PAID
    # A row of an earlier link says nothing about this campaign: the sync must see delivery end first.
    with pytest.raises(actions.HTTPException) as other:
        settle_plan(linked, {**row, "metaCampaignId": "120299999"}, 3000, None, now, {"spendDelayHours": 48})
    assert other.value.status_code == 409 and other.value.detail == REFUSE_SETTLE_NOT_ENDED


# ------------------------------------------------------------------ the admin override (P3-06d)

def test_settle_override_admin_only_audited(staff):
    user, campaign_id, meta_id = _linked(staff)
    _results(campaign_id, user["id"], meta_id, campaignEffectiveStatus="ACTIVE", adStatusCounts={"ACTIVE": 1},
             anyAdDelivering=True, spendMinorUSD=2000, spendConfirmedAt=_iso(_now()))
    reason = "Owner decision: refund the customer in full after the delivery dispute"
    forbidden = _override(staff["reviewer"]["cookies"], campaign_id, refundMinorUSD=3000, reason=reason)
    assert forbidden.status_code == 403 and forbidden.json()["detail"] == REFUSE_OVERRIDE_ADMIN, forbidden.text
    cross = client.post(f"/api/ad-studio/campaigns/{campaign_id}/settle-override",
                        json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("override-x"),
                              "refundMinorUSD": 3000, "reason": reason},
                        cookies=staff["admin"]["cookies"], headers={"Origin": "https://evil.example"})
    assert cross.status_code == 403, cross.text
    short = _override(staff["admin"]["cookies"], campaign_id, refundMinorUSD=3000, reason="too short")
    assert short.status_code == 400 and short.json()["detail"] == REFUSE_OVERRIDE_REASON, short.text
    no_amount = _override(staff["admin"]["cookies"], campaign_id, reason=reason)
    assert no_amount.status_code == 400 and no_amount.json()["detail"] == REFUSE_OVERRIDE_REFUND, no_amount.text
    above_paid = _override(staff["admin"]["cookies"], campaign_id, refundMinorUSD=3001, reason=reason)
    assert above_paid.status_code == 400 and above_paid.json()["detail"] == REFUSE_REFUND_ABOVE_PAID, above_paid.text
    assert _campaign_data(campaign_id)["status"] == "Approved" and _refunds(user["id"]) == []
    assert _audits(campaign_id, "settle_override") == []

    op = _uid("override-op")
    baseline = _last_modified(campaign_id)
    lifted = client.post(f"/api/ad-studio/campaigns/{campaign_id}/settle-override",
                         json={"expectedLastModified": baseline, "operationId": op, "refundMinorUSD": 3000, "reason": reason},
                         cookies=staff["admin"]["cookies"])
    assert lifted.status_code == 200, lifted.text
    data = lifted.json()["data"]
    assert data["status"] == "Stopped" and data["closeReason"] == "staff_stop" and data["stopReason"] == ""
    assert data["refundMinorUSD"] == 3000 and data["spendMinorUSD"] == 0
    assert data["settleBasis"] == "override" and data["settleOverrideReason"] == reason
    assert data["metaSpendAtSettleMinorUSD"] == 2000 and data["settledSpendMinorUSD"] == 2000
    assert data["settledAt"] == data["stoppedAt"] and data["lastStopOperationId"] == op
    refunds = _refunds(user["id"])
    assert len(refunds) == 1 and int(refunds[0]["amountMinor"]) == 3000 and _balance(user) == 3000

    audits = _audits(campaign_id, "settle_override")
    assert len(audits) == 1 and audits[0]["user_id"] == staff["admin"]["id"]
    meta = json.loads(audits[0]["metadata_json"])
    assert meta["reason"] == reason and meta["operationId"] == op
    assert (meta["refundMinorUSD"], meta["capMinorUSD"], meta["paidMinorUSD"]) == (3000, 1000, 3000)
    assert meta["metaSpendAtSettleMinorUSD"] == 2000 and meta["absorbedMinorUSD"] == 2000
    assert meta["before"]["status"] == "Approved" and meta["before"]["settleBasis"] is None
    assert meta["after"]["status"] == "Stopped" and meta["after"]["settleBasis"] == "override"
    assert meta["after"]["refundMinorUSD"] == 3000 and meta["after"]["settleOverrideReason"] == reason
    assert len(_audits(campaign_id, "stop")) == 1  # the lifecycle entry too (both kept forever)

    # D27: Albayan absorbs the $20 above the cap: the meta_overspend alert, for the customer's row.
    row_id = alert_id("meta_overspend", campaign_id, libya_today(_now()).isoformat())
    with db_conn() as conn:
        alert = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                             {"t": ALERTS_TYPE, "id": row_id}).mappings().first()
    assert alert is not None and alert["created_by"] == user["id"]
    details = json_loads(alert["data_json"])["details"]
    assert details["absorbedMinorUSD"] == 2000 and details["settleBasis"] == "override" and details["refundMinorUSD"] == 3000

    # A lost answer: the same operationId replays the committed result, nothing moves twice.
    replay = client.post(f"/api/ad-studio/campaigns/{campaign_id}/settle-override",
                         json={"expectedLastModified": baseline, "operationId": op, "refundMinorUSD": 3000, "reason": reason},
                         cookies=staff["admin"]["cookies"])
    assert replay.status_code == 200 and replay.json()["data"]["refundMinorUSD"] == 3000, replay.text
    assert len(_refunds(user["id"])) == 1
    # The customer sees no staff id on the settled row.
    mine = client.get(f"/api/collections/{CAMPAIGNS}/{campaign_id}", cookies=user["cookies"])
    assert mine.status_code == 200 and staff["admin"]["id"] not in mine.text


def test_settle_override_within_the_cap_absorbs_nothing(staff):
    user, campaign_id, meta_id = _linked(staff)
    _results(campaign_id, user["id"], meta_id, campaignEffectiveStatus="ACTIVE", adStatusCounts={"ACTIVE": 1},
             anyAdDelivering=True, spendMinorUSD=1000, spendConfirmedAt=_iso(_now()))
    lifted = _override(staff["admin"]["cookies"], campaign_id, refundMinorUSD=2000, closeReason="completed",
                       reason="Ad paused by hand in Ads Manager; the customer asked for the unspent part today")
    assert lifted.status_code == 200, lifted.text
    data = lifted.json()["data"]
    assert data["closeReason"] == "completed" and data["settleBasis"] == "override" and data["refundMinorUSD"] == 2000
    with db_conn() as conn:
        found = conn.execute(text("SELECT id FROM entities WHERE type = :t AND id = :id"),
                             {"t": ALERTS_TYPE, "id": alert_id("meta_overspend", campaign_id, libya_today(_now()).isoformat())}).first()
    assert found is None  # nothing above the cap: no overspend alert
    assert len(_audits(campaign_id, "settle_override")) == 1
