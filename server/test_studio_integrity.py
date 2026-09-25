"""Albayan Studio money integrity scan (plan task P1-07b; PLAN.md §7.8 "Integrity checks").

A clean lifecycle (charge, submit, approve, link, Meta spend, settle, send back after an interrupted
approval, reject, a request still waiting) reports nothing, and so does every point of random
sequences of real route calls; every check is then seeded with the violation it must find, on each
of the two independent sources it compares. The suite shares one database, so each scan is limited
to this module's own customers (``owner_ids``) unless a test says otherwise.
"""

import json
import random
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.rate_limiter import reset_rate_limit
from server.systems.ads_studio import studio_integrity
from server.systems.ads_studio.studio_integrity import (
    MAX_IDS,
    VIOLATION_LABELS,
    failed_check,
    scan_studio_money,
    scan_studio_money_report,
    violation_counts,
)
from server.systems.ads_studio.studio_results import write_results_row
from server.test_studio_wallet import (
    _archive,
    _campaign_data,
    _charge,
    _create,
    _crash_capture,
    _credit,
    _customer,
    _force,
    _insert_user,
    _last_modified,
    _link,
    _meta_id,
    _review,
    _stop,
    _submit,
    _uid,
    CAMPAIGNS,
    client,
)
from server.wallet_payments import _campaign_payment_key, wallet_ledger_rows


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("integrity-admin", "Admin", {}),
        "reviewer": _insert_user("integrity-reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


def _now(minutes: float = 0) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def _scan(owners, minutes: float = 0, **kwargs) -> list[dict]:
    with db_conn() as conn:
        return scan_studio_money(conn, _now(minutes), owner_ids=list(owners), **kwargs)


def _codes(violations: list[dict]) -> dict[str, dict]:
    return {item["code"]: item for item in violations}


def _approved(staff, user: dict, budget: int, name: str = "") -> str:
    campaign_id = _create(user, budget, name)
    assert _submit(user, campaign_id).status_code == 200
    assert _review(staff, campaign_id, "Approved").status_code == 200
    return campaign_id


def _results(campaign_id: str, owner_id: str, meta_id: str, spend: int, **fields) -> None:
    stamp = _now().isoformat().replace("+00:00", "Z")
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner_id, {
            "metaCampaignId": meta_id, "syncState": "ok", "lastSyncedAt": stamp, "adStatusCounts": {"PAUSED": 1},
            "campaignEffectiveStatus": "PAUSED", "spendMinorUSD": spend, "spendConfirmedAt": stamp,
            "insightsState": "ok", "currency": "USD", **fields,
        })


def _ledger_insert(admin_id: str, data: dict) -> str:
    with main_module._SQLITE_WALLET_LOCK, db_conn() as conn:
        saved = main_module._insert_entity_in_transaction(
            conn, "walletTransactions", None, {"status": "posted", "currency": "USD", "createdAt": main_module._iso_utc(),
                                               **data}, admin_id)
    return saved["id"]


def _cpay_row(user_id: str, campaign_id: str) -> dict:
    key = _campaign_payment_key(_campaign_data(campaign_id))
    with db_conn() as conn:
        return next(row for row in wallet_ledger_rows(conn, user_id) if row["idempotencyKey"] == key)


# ------------------------------------------------------------------ clean

def test_studio_money_checks_clean_lifecycle_reports_none(staff):
    user = _customer("clean")
    _credit(staff, user["id"], 30_000)
    settled = _approved(staff, user, 3_000, "Settled ad")
    meta_id = _meta_id()
    assert _link(staff, settled, meta_id).status_code == 200
    _results(settled, user["id"], meta_id, 300, metaCampaignName=_campaign_data(settled)["studioName"])  # P1-09 name
    assert _stop(staff["reviewer"]["cookies"], settled, refund=2_700).status_code == 200
    running = _approved(staff, user, 2_000, "Running ad")
    rejected = _create(user, 1_500)
    assert _submit(user, rejected).status_code == 200
    assert _review(staff, rejected, "Rejected").status_code == 200
    interrupted = _create(user, 1_200)
    assert _submit(user, interrupted).status_code == 200
    _crash_capture(staff, interrupted)
    assert _review(staff, interrupted, "Changes Requested").status_code == 200  # the send-back returns the capture
    waiting = _create(user, 1_100)
    assert _submit(user, waiting).status_code == 200
    archived = _create(user, 1_100)
    assert _archive(user, archived).status_code == 200

    with db_conn() as conn:
        report = scan_studio_money_report(conn, _now(120), owner_ids=[user["id"]])
    assert report["violations"] == [], report
    assert report["checked"] == {"customers": 1, "requests": 6}
    assert _campaign_data(running)["status"] == "Approved" and _campaign_data(waiting)["status"] == "Submitted"


def test_studio_money_checks_empty_scope_is_clean():
    with db_conn() as conn:
        assert scan_studio_money(conn, _now(), owner_ids=[]) == []


# ------------------------------------------------------------------ captures

def test_studio_money_checks_capture_without_approval(staff):
    user = _customer("approving")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    assert _scan([user["id"]], 10) == []  # an approval may still be writing its status
    found = _codes(_scan([user["id"]], 16))
    assert set(found) == {"capture_without_approval"}
    item = found["capture_without_approval"]
    assert (item["count"], item["requestIds"], item["userIds"]) == (1, [campaign_id], [user["id"]])
    assert item["labels"] == VIOLATION_LABELS["capture_without_approval"] and item["labels"]["ar"]
    assert _review(staff, campaign_id, "Approved").status_code == 200  # the approval reuses the capture
    assert _scan([user["id"]], 16) == []


def test_studio_money_checks_stranded_capture(staff):
    user = _customer("stranded")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_500)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, status="Changes Requested")  # the send-back committed, its return did not
    assert _scan([user["id"]], 30) == []  # "Being returned" for up to an hour is normal
    found = _codes(_scan([user["id"]], 61))
    assert set(found) == {"stranded_capture"} and found["stranded_capture"]["requestIds"] == [campaign_id]
    assert set(_codes(_scan([user["id"]], 6, stranded_minutes=5))) == {"stranded_capture"}  # the threshold setting


def test_studio_money_checks_duplicate_and_excess_returns(staff):
    user = _customer("returns")
    _credit(staff, user["id"], 5_000)
    campaign_id = _approved(staff, user, 2_000)
    assert _stop(staff["reviewer"]["cookies"], campaign_id, refund=1_500).status_code == 200
    assert _scan([user["id"]]) == []
    pay = _cpay_row(user["id"], campaign_id)
    # An old admin reversal of the same payment (the door is closed today; rows from before remain).
    _ledger_insert(staff["admin"]["id"], {
        "type": "reversal", "amountMinor": 1_000, "amount": 10, "fromUserId": "system", "toUserId": user["id"],
        "idempotencyKey": f"rev:{pay['id']}", "referenceType": "reversalOf", "referenceId": pay["id"],
    })
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"duplicate_return", "return_above_paid"}
    assert found["duplicate_return"]["requestIds"] == [campaign_id]


# ------------------------------------------------------------------ each request against its own ledger rows

def _seed(campaign_id: str, **fields) -> None:
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, **fields)


def test_studio_money_checks_request_payment_mismatch(staff):
    user = _customer("paid-fields")
    _credit(staff, user["id"], 9_000)
    approved = _approved(staff, user, 2_000)
    stopped = _approved(staff, user, 1_300)
    assert _stop(staff["reviewer"]["cookies"], stopped, refund=300).status_code == 200
    assert _scan([user["id"]]) == []
    for campaign_id in (approved, stopped):
        pay, data = _cpay_row(user["id"], campaign_id), _campaign_data(campaign_id)
        assert (data["paidMinorUSD"], data["paymentTransactionId"]) == (pay["amountMinor"], pay["id"])
        for fields in ({"paidMinorUSD": pay["amountMinor"] + 100}, {"paymentTransactionId": _uid("tx_other")},
                       {"paymentTransactionId": ""}):
            _seed(campaign_id, **fields)
            found = _codes(_scan([user["id"]]))
            assert set(found) == {"request_payment_mismatch"}, (campaign_id, fields, found)
            assert found["request_payment_mismatch"]["requestIds"] == [campaign_id]
            assert found["request_payment_mismatch"]["labels"]["ar"]
            _seed(campaign_id, paidMinorUSD=pay["amountMinor"], paymentTransactionId=pay["id"])
    assert _scan([user["id"]]) == []

    # A request approved before the wallet existed never paid and claims no payment: not judged.
    legacy = _create(user, 1_500)
    _seed(legacy, status="Approved", submittedAt="2026-07-01T10:00:00Z", schemaVersion=None, paidMinorUSD=None,
          paymentTransactionId=None)
    assert _scan([user["id"]]) == []
    # One that says it paid, or one sent from P1 on (it paid on approval), must have its cycle's payment.
    for fields in ({"paymentTransactionId": _uid("tx_never_written")}, {"paidMinorUSD": 1_500}, {"schemaVersion": 2}):
        _seed(legacy, **fields)
        found = _codes(_scan([user["id"]]))
        assert set(found) == {"request_payment_mismatch"} and found["request_payment_mismatch"]["requestIds"] == [legacy]
        _seed(legacy, schemaVersion=None, paidMinorUSD=None, paymentTransactionId=None)
    assert _scan([user["id"]]) == []


def test_studio_money_checks_request_refund_mismatch(staff):
    user = _customer("refund-fields")
    _credit(staff, user["id"], 9_000)
    refunded, kept = _approved(staff, user, 2_000), _approved(staff, user, 1_200)
    assert _stop(staff["reviewer"]["cookies"], refunded, refund=1_500).status_code == 200
    assert _stop(staff["reviewer"]["cookies"], kept, refund=0).status_code == 200  # all spent: no refund row
    assert _scan([user["id"]]) == []
    key = f"stoprefund:{_campaign_payment_key(_campaign_data(refunded))}"
    with db_conn() as conn:
        row = next(r for r in wallet_ledger_rows(conn, user["id"]) if r["idempotencyKey"] == key)
    assert (_campaign_data(refunded)["refundMinorUSD"], _campaign_data(refunded)["refundTransactionId"]) == (1_500, row["id"])
    for campaign_id, fields, restore in (
        (refunded, {"refundMinorUSD": 1_400}, {"refundMinorUSD": 1_500}),
        (refunded, {"refundTransactionId": ""}, {"refundTransactionId": row["id"]}),
        (kept, {"refundMinorUSD": 100}, {"refundMinorUSD": 0}),
        (kept, {"refundTransactionId": _uid("tx_never_written")}, {"refundTransactionId": ""}),
    ):
        _seed(campaign_id, **fields)
        found = _codes(_scan([user["id"]]))
        assert set(found) == {"request_refund_mismatch"}, (campaign_id, fields, found)
        assert found["request_refund_mismatch"]["requestIds"] == [campaign_id]
        _seed(campaign_id, **restore)
    assert _archive(user, refunded).status_code == 200  # archived requests are judged too
    _seed(refunded, refundMinorUSD=900)
    assert set(_codes(_scan([user["id"]]))) == {"request_refund_mismatch"}
    _seed(refunded, refundMinorUSD=1_500)
    assert _scan([user["id"]]) == []


# ------------------------------------------------------------------ random clean sequences of real route calls

def _review_at(staff, campaign_id: str, decision: str, expected: int):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json={
        "expectedLastModified": expected, "decision": decision, "note": "" if decision == "Approved" else "Fix the photo",
        "operationId": _uid("review-op"), "reviewReasonCode": "" if decision == "Approved" else "creative_quality",
    }, cookies=staff["reviewer"]["cookies"])


def _reset_image_checks(*user_ids: str) -> None:
    """Each submit and approval re-checks the images (24 a minute per account): a budget, not under test here."""
    for user_id in user_ids:
        reset_rate_limit(f"ad-studio:media:{user_id}")


def _fuzz_step(rng: random.Random, staff, users: list[dict], campaigns: dict[str, dict]) -> str:
    user = rng.choice(users)
    _reset_image_checks(staff["reviewer"]["id"], user["id"])
    mine =[c for c in campaigns.values() if c["owner"] == user["id"] and not c["archived"]]

    def pick(*statuses, **flags):
        found = [c for c in mine if c["status"] in statuses and all(c[k] == v for k, v in flags.items())]
        return rng.choice(found) if found else None

    weights = {"credit": 1, "charge": 1, "transfer": 1, "submit_new": 3}
    if pick("Submitted"):
        weights.update(approve=4, send_back=1, withdraw=1, stale_approve=1)
    if pick("Draft", "Changes Requested"):
        weights["resubmit"] = 2
    if pick("Approved"):
        weights["settle"] = 2
    if pick("Approved", linked=False):
        weights.update(link=2, self_stop=1)
    if pick("Draft", "Changes Requested", "Rejected", "Stopped"):
        weights["archive"] = 1
    ops = sorted(weights)
    op = rng.choices(ops, weights=[weights[name] for name in ops])[0]
    if op == "credit":
        _credit(staff, user["id"], rng.randint(500, 9_000))
    elif op == "charge":
        _charge(staff, user, rng.randint(100, 6_000))
    elif op == "transfer":
        other = rng.choice([u for u in users if u is not user])
        response = client.post("/api/wallet/transfers", json={
            "toUserId": other["id"], "amountMinor": rng.randint(100, 3_000), "currency": "USD", "idempotencyKey": _uid("fz-t"),
        }, cookies=user["cookies"])
        assert response.status_code in (200, 409), response.text
    elif op == "submit_new":
        budget = rng.randint(1_500, 5_000)
        campaign_id = _create(user, budget)
        campaigns[campaign_id] = {"id": campaign_id, "owner": user["id"], "budget": budget, "status": "Draft",
                                  "archived": False, "linked": False, "spend": 0}
        response = _submit(user, campaign_id)
        assert response.status_code in (200, 409), response.text  # 409: not enough available
        if response.status_code == 200:
            campaigns[campaign_id]["status"] = "Submitted"
    elif op == "resubmit":
        campaign = pick("Draft", "Changes Requested")
        response = _submit(user, campaign["id"])
        assert response.status_code in (200, 409), response.text
        if response.status_code == 200:
            campaign["status"] = "Submitted"
    elif op == "approve":
        campaign = pick("Submitted")
        response = _review(staff, campaign["id"], "Approved")
        assert response.status_code == 200, response.text
        campaign["status"] = "Approved"
    elif op == "stale_approve":
        # A reviewer's page loaded before the request's last change: refused before any capture.
        campaign = pick("Submitted")
        with db_conn() as conn:
            before = sorted(row["id"] for row in wallet_ledger_rows(conn, user["id"]))
        response = _review_at(staff, campaign["id"], "Approved", _last_modified(campaign["id"]) - 1)
        assert response.status_code == 409 and response.json()["detail"] == "Conflict: record has changed", response.text
        with db_conn() as conn:
            assert sorted(row["id"] for row in wallet_ledger_rows(conn, user["id"])) == before  # nothing captured
    elif op == "send_back":
        campaign = pick("Submitted")
        decision = rng.choice(["Changes Requested", "Rejected"])
        assert _review(staff, campaign["id"], decision).status_code == 200
        campaign["status"] = decision
    elif op == "withdraw":
        campaign = pick("Submitted")
        response = client.post(f"/api/ad-studio/campaigns/{campaign['id']}/withdraw", json={
            "expectedLastModified": _last_modified(campaign["id"]), "operationId": _uid("fz-w"),
        }, cookies=user["cookies"])
        assert response.status_code == 200, response.text
        campaign["status"] = "Draft"
    elif op == "link":
        campaign = pick("Approved", linked=False)
        meta_id = _meta_id()
        assert _link(staff, campaign["id"], meta_id).status_code == 200
        campaign.update(linked=True, spend=rng.randint(0, campaign["budget"]))
        _results(campaign["id"], user["id"], meta_id, campaign["spend"])
    elif op == "settle":
        campaign = pick("Approved")
        refund = rng.randint(0, campaign["budget"] - campaign["spend"])  # never above paid - Meta's confirmed spend
        assert _stop(staff["reviewer"]["cookies"], campaign["id"], refund=refund).status_code == 200
        campaign["status"] = "Stopped"
    elif op == "self_stop":
        campaign = pick("Approved", linked=False)
        response = _stop(user["cookies"], campaign["id"])
        assert response.status_code == 200, response.text  # not started yet: the whole budget comes back
        campaign["status"] = "Stopped"
    elif op == "archive":
        campaign = pick("Draft", "Changes Requested", "Rejected", "Stopped")
        assert _archive(user, campaign["id"]).status_code == 200
        campaign["archived"] = True
    return op


FUZZ_SEEDS = (5, 17)
FUZZ_STEPS = 40
FUZZ_OPERATIONS = {
    "credit", "charge", "transfer", "submit_new", "resubmit", "approve", "stale_approve", "send_back", "withdraw",
    "link", "settle", "self_stop", "archive",
}


def test_random_clean_route_sequences_report_nothing(staff):
    """Any sequence of real route calls leaves money the scan finds nothing wrong with, at every step, even
    judged two hours later (an approval half done or a return on its way would be found by then)."""
    ran: set[str] = set()
    for seed in FUZZ_SEEDS:
        rng = random.Random(seed)
        users = [_customer(f"fuzz{seed}a"), _customer(f"fuzz{seed}b")]
        for user in users:
            _credit(staff, user["id"], rng.randint(6_000, 15_000))
        campaigns: dict[str, dict] = {}
        done: list[str] = []
        for number in range(FUZZ_STEPS):
            done.append(_fuzz_step(rng, staff, users, campaigns))
            assert _scan([user["id"] for user in users], 120) == [], (seed, number, done[-5:])
        ran.update(done)
        assert any(c["status"] in ("Approved", "Stopped") for c in campaigns.values()), (seed, done)
    _reset_image_checks(staff["reviewer"]["id"])
    assert ran == FUZZ_OPERATIONS, sorted(FUZZ_OPERATIONS - ran)  # together the sequences used every operation


# ------------------------------------------------------------------ refunds and Meta spend

def test_studio_money_checks_refund_above_unspent(staff):
    user = _customer("refund")
    _credit(staff, user["id"], 8_000)
    campaign_id = _approved(staff, user, 3_000)
    meta_id = _meta_id()
    assert _link(staff, campaign_id, meta_id).status_code == 200
    _results(campaign_id, user["id"], meta_id, 1_000)  # Meta confirmed $10 used
    assert _stop(staff["reviewer"]["cookies"], campaign_id, refund=2_500).status_code == 200  # $5 too much back
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"refund_above_unspent"} and found["refund_above_unspent"]["requestIds"] == [campaign_id]
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, settleOverrideReason="Meta double-counted a day; checked by the owner")
    assert _scan([user["id"]]) == []  # an admin override with a written reason is allowed


def test_refund_check_needs_the_same_confirmed_meta_campaign(staff):
    user = _customer("refund-other")
    _credit(staff, user["id"], 8_000)
    campaign_id = _approved(staff, user, 3_000)
    meta_id = _meta_id()
    assert _link(staff, campaign_id, meta_id).status_code == 200
    _results(campaign_id, user["id"], _meta_id(), 2_900)  # a row about ANOTHER Meta campaign
    assert _stop(staff["reviewer"]["cookies"], campaign_id, refund=2_000).status_code == 200
    assert _scan([user["id"]]) == []
    _results(campaign_id, user["id"], meta_id, 2_900, spendConfirmedAt=None)  # the right one, never confirmed
    assert _scan([user["id"]]) == []


# ------------------------------------------------------------------ holds

def test_studio_money_checks_submitted_request_without_hold(staff):
    user = _customer("nohold")
    _credit(staff, user["id"], 5_000)
    zero, undated = _create(user, 1_200), _create(user, 1_100)
    for campaign_id in (zero, undated):
        assert _submit(user, campaign_id).status_code == 200
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(zero, conn, budgetMinorUSD=0, totalBudgetMinorUSD=0)
        _force(undated, conn, submittedAt="")
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"submitted_request_without_hold"}
    assert found["submitted_request_without_hold"]["requestIds"] == sorted([zero, undated])


def test_studio_money_checks_hold_without_submitted_request(staff, monkeypatch):
    user = _customer("hold")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 1_200)
    assert _submit(user, campaign_id).status_code == 200
    assert _scan([user["id"]]) == []
    # The debit gates hold back more than the requests themselves hold.
    real = studio_integrity.wallet_campaign_holds_minor
    with monkeypatch.context() as patch:
        patch.setattr(studio_integrity, "wallet_campaign_holds_minor", lambda conn, uid: real(conn, uid) + 700)
        found = _codes(_scan([user["id"]]))
    assert "hold_without_submitted_request" in found and found["hold_without_submitted_request"]["userIds"] == [user["id"]]
    assert _scan([user["id"]]) == []


def test_hold_check_reads_the_rows_apart_from_the_gates(staff):
    """The two sides really are two readers: a row whose JSON repeats "status" is Submitted to the gates'
    SQL projection (SQLite json_extract takes the first key) and Draft to the capture's read of the row
    (Python keeps the last key). The gates hold its budget; its approval could never capture it."""
    user = _customer("hold-readers")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 1_200)
    assert _submit(user, campaign_id).status_code == 200
    with db_conn() as conn:
        if conn.dialect.name != "sqlite":
            pytest.skip("PostgreSQL jsonb keeps one key per name: both readers agree there")
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).scalar()
        assert json_loads(raw)["status"] == "Submitted" and raw.rstrip().endswith("}")
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                     {"d": raw.rstrip()[:-1] + ', "status": "Draft"}', "t": CAMPAIGNS, "id": campaign_id})
    try:
        with db_conn() as conn:
            assert wallet_payments.wallet_campaign_holds_minor(conn, user["id"]) == 1_200  # the gates still hold it
        found = _codes(_scan([user["id"]]))
        assert set(found) == {"hold_without_submitted_request"}, found
        assert found["hold_without_submitted_request"]["userIds"] == [user["id"]]
    finally:
        with db_conn() as conn:
            conn.execute(text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                         {"d": raw, "t": CAMPAIGNS, "id": campaign_id})
    assert _scan([user["id"]]) == []


# ------------------------------------------------------------------ the wallet identity

def test_studio_money_checks_negative_available(staff):
    user = _customer("negative")
    _credit(staff, user["id"], 1_000)
    _create(user, 1_200)  # a studio customer: the owner of at least one request, a draft is enough
    _ledger_insert(staff["admin"]["id"], {  # a debit that skipped the Available check
        "type": "transfer", "amountMinor": 1_500, "amount": 15, "fromUserId": user["id"], "toUserId": "system",
        "idempotencyKey": _uid("raw-debit"),
    })
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"wallet_negative_available"} and found["wallet_negative_available"]["userIds"] == [user["id"]]


def test_studio_money_checks_identity_break(staff, monkeypatch):
    """The wallet screen's numbers against main's own SQL balance (the debit gates' number): a fault on
    either side is found."""
    user = _customer("identity")
    _credit(staff, user["id"], 4_000)
    _charge(staff, user, 1_500)
    _approved(staff, user, 1_200)
    assert _scan([user["id"]]) == []
    with db_conn() as conn:
        assert main_module._wallet_balance_minor(conn, user["id"], "USD") == 4_300  # the side the scan compares with
    # 1. The summary puts one row in the wrong bucket.
    real_summary = studio_integrity.compute_wallet_summary

    def broken(*args, **kwargs):
        summary = real_summary(*args, **kwargs)
        summary["usd"]["spentMinor"] += 1
        return summary

    with monkeypatch.context() as patch:
        patch.setattr(studio_integrity, "compute_wallet_summary", broken)
        assert set(_codes(_scan([user["id"]]))) == {"wallet_identity_break"}
    # 2. The summary's ledger reader misses a row that the gates count (the charge's credit).
    real_rows = studio_integrity.wallet_ledger_rows
    with monkeypatch.context() as patch:
        patch.setattr(studio_integrity, "wallet_ledger_rows",
                      lambda conn, uid: [row for row in real_rows(conn, uid) if not row["idempotencyKey"].startswith("payreq:")])
        found = _codes(_scan([user["id"]]))
    assert set(found) == {"wallet_identity_break"} and found["wallet_identity_break"]["userIds"] == [user["id"]]
    # 3. The gates' balance itself is off.
    with db_conn() as conn:
        off = scan_studio_money(conn, _now(), owner_ids=[user["id"]],
                                balance_minor=lambda c, uid, cur: main_module._wallet_balance_minor(c, uid, cur) + 1)
    assert set(_codes(off)) == {"wallet_identity_break"}
    assert _scan([user["id"]]) == []


def test_identity_check_that_cannot_reach_the_balance_is_a_finding(staff, monkeypatch):
    user = _customer("identity-nobalance")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 1_200)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)

    def unreachable():
        raise RuntimeError("the jobs ctx is not there")

    monkeypatch.setattr(studio_integrity, "_jobs_balance_reader", unreachable)
    found = _codes(_scan([user["id"]], 16))
    assert set(found) == {"check_failed", "capture_without_approval"}  # the other checks still ran
    assert found["check_failed"]["checks"] == ["wallet_balance:RuntimeError"]


# ------------------------------------------------------------------ Studio / core separation (D26)

def test_studio_money_checks_studio_ad_in_core_books(staff):
    user = _customer("core")
    _credit(staff, user["id"], 5_000)
    campaign_id = _approved(staff, user, 2_000)
    meta_id = _meta_id()
    assert _link(staff, campaign_id, meta_id).status_code == 200
    assert _scan([user["id"]]) == []
    claimed_ad, named_ad = _uid("core_ad"), _uid("core_ad_named")
    stamp = now_ms()
    with db_conn() as conn:
        for ad_id, data in (
            (claimed_ad, {"metaCampaignId": meta_id, "metaCampaignName": "Imported by discovery"}),
            (named_ad, {"metaCampaignId": _meta_id(), "metaCampaignName": f"alb-s-{_uid('x')} summer"}),
        ):
            conn.execute(text(
                "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                "VALUES ('ads', :id, :data, false, :stamp, NULL, :stamp)"
            ), {"id": ad_id, "data": json_dumps({"id": ad_id, "paymentStatus": "pending_setup", **data}), "stamp": stamp})
    try:
        found = _codes(_scan([user["id"]]))
        assert set(found) == {"studio_in_core_books"}
        assert (found["studio_in_core_books"]["count"], found["studio_in_core_books"]["requestIds"]) == (1, [campaign_id])
        with db_conn() as conn:  # the daily (global) scan also counts the row that only carries the code
            everyone = _codes(scan_studio_money(conn, _now()))
        assert everyone["studio_in_core_books"]["count"] >= 2
        assert claimed_ad not in json.dumps(everyone) and named_ad not in json.dumps(everyone)  # request ids only
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type = 'ads' AND id IN (:a, :b)"), {"a": claimed_ad, "b": named_ad})


def test_studio_money_checks_linked_name_without_code(staff):
    user = _customer("names")
    _credit(staff, user["id"], 9_000)
    plain, coded, own_ref = (_approved(staff, user, 1_200) for _ in range(3))
    metas = {campaign_id: _meta_id() for campaign_id in (plain, coded, own_ref)}
    for campaign_id, meta_id in metas.items():
        assert _link(staff, campaign_id, meta_id).status_code == 200
    assert _scan([user["id"]]) == []  # no names known yet: nothing to judge
    _results(plain, user["id"], metas[plain], 0, metaCampaignName="Summer offer")
    _results(coded, user["id"], metas[coded], 0, metaCampaignName="alb-s-abcdefgh · Summer offer")
    _results(own_ref, user["id"], metas[own_ref], 0, metaCampaignName="ALB-S-ABCDEFGH · Winter offer")
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(own_ref, conn, studioRef="ALB-S-ZZZZZZZZ")  # its own code is not in the name
        _force(coded, conn, studioRef="")  # approved before P1-09 stamped codes: any ALB-S- code counts
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"linked_name_without_code"}
    assert found["linked_name_without_code"]["requestIds"] == sorted([plain, own_ref])
    _results(own_ref, user["id"], metas[own_ref], 0, metaCampaignName="Winter · alb-s-zzzzzzzz")
    assert _codes(_scan([user["id"]]))["linked_name_without_code"]["requestIds"] == [plain]


# ------------------------------------------------------------------ failures and shape

def test_studio_money_checks_a_failed_check_is_a_finding(staff, monkeypatch):
    user = _customer("failing")
    _credit(staff, user["id"], 1_000)

    def boom(conn):
        raise RuntimeError("database away")

    monkeypatch.setattr(studio_integrity, "collision_report", boom)
    found = _codes(_scan([user["id"]]))
    assert set(found) == {"check_failed"} and found["check_failed"]["checks"] == ["studio_in_core_books:RuntimeError"]
    assert "database away" not in json.dumps(found)  # the error type only, never its text


def test_violation_shape_counts_and_id_cap():
    findings = studio_integrity._Findings()
    for number in range(MAX_IDS + 5):
        findings.add("stranded_capture", request_ids=[f"cmp_{number}"], user_id="user_1")
    findings.add("wallet_negative_available", user_id="user_2")
    result = findings.result()
    assert [item["code"] for item in result] == ["wallet_negative_available", "stranded_capture"]  # label order
    stranded = result[1]
    assert stranded["count"] == MAX_IDS + 5 and len(stranded["requestIds"]) == MAX_IDS and stranded["moreIds"] == 5
    assert violation_counts(result) == {"total": MAX_IDS + 6, "byCode": {"wallet_negative_available": 1,
                                                                          "stranded_capture": MAX_IDS + 5}}
    for code, labels in VIOLATION_LABELS.items():
        assert labels["en"] and labels["ar"] and labels["en"] != labels["ar"], code
    failed = failed_check("scan_studio_money", ValueError("secret text"))
    assert failed["code"] == "check_failed" and failed["checks"] == ["scan_studio_money:ValueError"]


def test_scan_reads_no_names_or_amounts(staff):
    user = _customer("private")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000, "Very Private Campaign Name")
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    found = _scan([user["id"]], 16)
    assert [item["code"] for item in found] == ["capture_without_approval"]
    text_out = json.dumps(found, ensure_ascii=False)
    for secret in ("Very Private Campaign Name", "2000", "@", "memo"):
        assert secret not in text_out


# ------------------------------------------------------------------ the admin's "scan now" (P3-24, studio_jobs.py)

def test_on_demand_scan_route_reports_like_the_daily_scan(staff, monkeypatch):
    """POST /api/studio/admin/integrity/scan answers with the daily job's report: the violations
    scan_studio_money finds on the same snapshot, in the same shape, and the same per-day alert."""
    from server.systems.ads_studio import studio_jobs
    from server.systems.ads_studio.studio_jobs import ALERTS_TYPE, alert_id
    from server.systems.ads_studio.studio_settings import read_all_settings

    monkeypatch.setattr(studio_integrity, "MAX_IDS", 100_000)  # the whole shared test database is scanned
    user = _customer("scan-route")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000, "Very Private Route Name")
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    later = _now(16)
    monkeypatch.setattr(studio_jobs, "utc_now", lambda: later)
    admin = staff["admin"]
    key = f"studio:integrity-scan:{admin['id']}"
    reset_rate_limit(key)
    response = client.post("/api/studio/admin/integrity/scan", cookies=admin["cookies"])
    assert response.status_code == 200, response.text
    body = response.json()
    stranded = read_all_settings()["thresholds"]["strandedCaptureMaxMinutes"]
    with db_conn() as conn:
        direct = scan_studio_money(conn, later, stranded_minutes=stranded)
    assert body["violations"] == direct  # the route ran the same scan on the same (already swept) state
    assert body["counts"] == violation_counts(direct)
    for item in body["violations"]:
        assert set(item) - {"checks"} == {"code", "count", "requestIds", "userIds", "moreIds", "labels"}, item
        assert item["labels"] == VIOLATION_LABELS[item["code"]]
    found = _codes(body["violations"])
    assert campaign_id in found["capture_without_approval"]["requestIds"]
    assert user["id"] in found["capture_without_approval"]["userIds"]
    assert "Very Private Route Name" not in json.dumps(body, ensure_ascii=False)
    assert body["alertId"] == alert_id("integrity_violation", "scan_studio_money", studio_jobs.libya_today(later).isoformat())
    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": ALERTS_TYPE, "id": body["alertId"]}).scalar()
    assert json_loads(raw)["details"]["violations"] == direct
    reset_rate_limit(key)
