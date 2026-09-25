"""Albayan Studio money integrity scan (plan task P1-07b; PLAN.md §7.8 "Integrity checks").

A clean lifecycle (charge, submit, approve, link, Meta spend, settle, send back after an interrupted
approval, reject, a request still waiting) reports nothing; every check is then seeded with the
violation it must find. The suite shares one database, so each scan is limited to this module's own
customers (``owner_ids``) unless a test says otherwise.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.main as main_module
from server import wallet_payments
from server.db import db_conn, init_db, json_dumps, now_ms
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
    _create,
    _crash_capture,
    _credit,
    _customer,
    _force,
    _insert_user,
    _link,
    _meta_id,
    _review,
    _stop,
    _submit,
    _uid,
    CAMPAIGNS,
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
    _results(settled, user["id"], meta_id, 300, metaCampaignName="ALB-S-ABCDEFGH · Settled ad")
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
    real = studio_integrity.wallet_campaign_holds_minor
    monkeypatch.setattr(studio_integrity, "wallet_campaign_holds_minor", lambda conn, uid: real(conn, uid) + 700)
    found = _codes(_scan([user["id"]]))
    assert "hold_without_submitted_request" in found and found["hold_without_submitted_request"]["userIds"] == [user["id"]]


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
    user = _customer("identity")
    _credit(staff, user["id"], 4_000)
    _approved(staff, user, 1_200)
    assert _scan([user["id"]]) == []
    real = studio_integrity.compute_wallet_summary

    def broken(*args, **kwargs):
        summary = real(*args, **kwargs)
        summary["usd"]["spentMinor"] += 1
        return summary

    monkeypatch.setattr(studio_integrity, "compute_wallet_summary", broken)
    assert set(_codes(_scan([user["id"]]))) == {"wallet_identity_break"}


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
