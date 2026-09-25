"""Albayan Studio budgets, limits, intake and review reasons (TASKS P1-06 as changed by the owner,
P1-11, P1-12, P1-15, P1-18(a), P1-22; DECISIONS D4 + D5, D33).

First the pure rules: the refusal texts the client maps to Arabic, the reason list, the day count,
the total, the limits in the client's order, the legacy rule and the hold. Then the real routes:
a daily request holds, is charged and gets back daily x days; a request sent before P1 keeps its
one-day hold; a p1CutoverAt still in the future keeps a send under the old limits; the send count
behind the daily cap. After every money step the wallet identity of PLAN.md §7.8 must hold, read
from the studio wallet summary:

    added + adjustments - in ads - being returned - spent = available + reserved

Every test creates its own users (the helpers of test_studio_wallet.py) and puts every studio
setting it changes back exactly as it was.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from server import main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads
from server.systems.ads_studio import ad_campaign_actions as actions
from server.systems.ads_studio import studio_settings
from server.test_studio_wallet import (  # noqa: F401 (_no_rate_limits is an autouse fixture)
    _assert_identity,
    _campaign_body,
    _credit,
    _customer,
    _insert_user,
    _last_modified,
    _no_rate_limits,
    _review,
    _stop,
    _summary,
    _uid,
    client,
)
from server.wallet_payments import campaign_hold_minor, wallet_campaign_holds_minor

# The real count, taken before any test starts (conftest.py stands a zero count in for it).
REAL_SUBMISSIONS_TODAY = actions.count_submissions_today
LIMITS = {"minTotalMinorUSD": 500, "maxTotalMinorUSD": 200_000, "minPerDayMinorUSD": 100, "maxDays": 90}


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {  # labels of their own: test_studio_wallet.py's staff already took "admin" and "reviewer"
        "admin": _insert_user("budget-admin", "Admin", {}),
        "reviewer": _insert_user("budget-reviewer", "Employee", {"adCampaignRequests": ["view", "review"]}),
    }


@pytest.fixture
def studio_setting():
    """Change studio settings for one test; every settings row is put back exactly afterwards."""
    init_db()
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


def _refusal(call, *args) -> str:
    with pytest.raises(HTTPException) as refused:
        call(*args)
    assert refused.value.status_code == 400
    return str(refused.value.detail)


# ------------------------------------------------------------------ the pure rules

def test_refusal_texts_are_the_shared_prefixes():
    """The client's Arabic map matches these prefixes: they must never be reworded."""
    assert actions.REFUSE_TOTAL_MIN == "The total budget must be at least "
    assert actions.REFUSE_TOTAL_MAX == "The total budget must be at most "
    assert actions.REFUSE_PER_DAY == "Budget per day is below the minimum"
    assert actions.REFUSE_MAX_DAYS == "The ad can run for at most "
    assert actions.REFUSE_INTAKE_PAUSED == "New ad requests are paused"
    assert actions.REFUSE_DAILY_CAP == "Today's limit of new ad requests is reached"
    assert actions.REFUSE_REASON_MISSING == "Choose a reason for this decision"
    assert actions.REFUSE_REASON_UNKNOWN == "Unknown reason code"
    assert actions.REFUSE_DURATION == "durationDays must be a whole number of days"


def test_review_reason_codes_and_labels():
    assert actions.REVIEW_REASON_LABELS == {
        "budget_dates": {"en": "Budget or dates", "ar": "الميزانية أو التواريخ"},
        "creative_quality": {"en": "Photo or video quality", "ar": "جودة الصورة أو الفيديو"},
        "text_policy": {"en": "Text breaks ad rules", "ar": "النص يخالف قواعد الإعلانات"},
        "targeting": {"en": "Audience or location", "ar": "الجمهور أو الموقع"},
        "page_access": {"en": "Page access", "ar": "صلاحية الصفحة"},
        "payment": {"en": "Payment", "ar": "الدفع"},
        "other": {"en": "Other", "ar": "أخرى"},
    }
    actions._require_review_reason("Approved", "")  # an approval needs none
    for decision in ("Changes Requested", "Rejected"):
        assert _refusal(actions._require_review_reason, decision, "").startswith(actions.REFUSE_REASON_MISSING)
        assert _refusal(actions._require_review_reason, decision, "Other").startswith(actions.REFUSE_REASON_UNKNOWN)
        actions._require_review_reason(decision, "budget_dates")


@pytest.mark.parametrize("data,days", [
    ({"durationDays": 7, "startDate": "2027-01-10", "endDate": "2027-01-10"}, 7),  # the chosen days win
    ({"startDate": "2027-01-10", "endDate": "2027-01-16"}, 7),                     # both ends counted
    ({"startDate": "2027-01-10", "endDate": "2027-01-10"}, 1),
    ({"startDate": "2027-01-10T00:00:00Z", "endDate": "2027-01-20T00:00:00Z"}, 11),
    ({"startDate": "2027-01-10", "endDate": "2027-01-09"}, 0),
    ({"startDate": "", "endDate": "2027-01-09"}, 0),
    ({"durationDays": True, "startDate": "2027-01-10", "endDate": "2027-01-11"}, 2),  # a flag is not a number
    ({"durationDays": 0, "startDate": "2027-01-10", "endDate": "2027-01-11"}, 2),
])
def test_days_count_both_ends(data, days):
    assert actions.campaign_days(data) == days


def test_total_is_lifetime_amount_or_daily_times_days():
    assert actions.campaign_total_minor({"budgetType": "lifetime", "budgetMinorUSD": 2500}, 7) == 2500
    assert actions.campaign_total_minor({"budgetType": "daily", "budgetMinorUSD": 1000}, 7) == 7000
    assert actions.campaign_total_minor({"budgetType": "Daily", "budgetMinorUSD": "1000"}, 3) == 3000
    assert actions.campaign_total_minor({"budgetType": "daily", "budgetMinorUSD": 1000}, 0) == 0
    assert actions.campaign_total_minor({"budgetMinorUSD": None}, 5) == 0


@pytest.mark.parametrize("days,total,prefix,tail", [
    (91, 50_000, "The ad can run for at most 90 days", " (this request: 91 days)"),
    (91, 100, "The ad can run for at most 90 days", ""),                  # days are checked first
    (5, 499, "The total budget must be at least $5.00", " (this request: $4.99)"),
    (5, 200_001, "The total budget must be at most $2,000.00", " (this request: $2,000.01)"),
    (7, 699, "Budget per day is below the minimum of $1.00", " (this request: $0.99 per day)"),
])
def test_limits_in_the_client_order(days, total, prefix, tail):
    detail = _refusal(actions.enforce_budget_limits, days, total, LIMITS)
    assert detail.startswith(prefix), detail
    assert detail.endswith(tail), detail


def test_per_day_floor_needs_no_rounding():
    actions.enforce_budget_limits(7, 700, LIMITS)      # $7.00 over 7 days = $1.00 a day
    actions.enforce_budget_limits(90, 9_000, LIMITS)
    actions.enforce_budget_limits(1, 200_000, LIMITS)
    assert _refusal(actions.enforce_budget_limits, 90, 8_999, LIMITS).startswith(actions.REFUSE_PER_DAY)
    strict = {**LIMITS, "minPerDayMinorUSD": 300, "minTotalMinorUSD": 300}
    assert _refusal(actions.enforce_budget_limits, 2, 599, strict).startswith(actions.REFUSE_PER_DAY)


def test_legacy_rule_follows_schema_version_and_cutover():
    null_cutover = {**LIMITS, "p1CutoverAt": None}
    cutover = {**LIMITS, "p1CutoverAt": "2026-10-01T08:00:00.000Z"}
    before, after = "2026-10-01T07:59:59Z", "2026-10-01T08:00:00Z"
    # p1CutoverAt null: every row WITHOUT schemaVersion >= 2 is legacy, every row with it is not.
    assert actions.legacy_budget_rules({}, null_cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": 1, "submittedAt": after}, null_cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": "x"}, null_cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": before}, null_cutover) is False
    assert actions.legacy_budget_rules({"schemaVersion": 3}, null_cutover) is False
    # With a cutover: sent before it = legacy, from it on = new rules.
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": before}, cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": after}, cutover) is False
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": "2026-10-01T09:30:00+02:00"}, cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": "2026-10-01T10:30:00+02:00"}, cutover) is False
    assert actions.legacy_budget_rules({"schemaVersion": 1, "submittedAt": after}, cutover) is True
    assert actions.legacy_budget_rules({"schemaVersion": 2, "submittedAt": "not a time"}, cutover) is True


def test_hold_prefers_the_submitted_total():
    assert campaign_hold_minor({"budgetMinorUSD": 1000, "totalBudgetMinorUSD": 7000}) == 7000
    assert campaign_hold_minor({"budgetMinorUSD": 1000}) == 1000                 # sent before P1: one day
    assert campaign_hold_minor({"budgetMinorUSD": 1000, "totalBudgetMinorUSD": 0}) == 1000
    assert campaign_hold_minor({"budgetMinorUSD": "1000", "totalBudgetMinorUSD": "7000"}) == 7000  # PostgreSQL text
    assert campaign_hold_minor({"budgetMinorUSD": "junk", "totalBudgetMinorUSD": None}) == 0


def test_duration_days_field_and_the_end_it_sets(studio_setting):
    def prepare(data, strict=False):
        return main_module._prepare_ad_campaign_fields(data, strict=strict)

    clean = prepare({"durationDays": 7, "startDate": "2027-01-10", "endDate": "2027-03-01"}, strict=False)
    assert clean["durationDays"] == 7 and clean["endDate"] == "2027-01-16"  # a different endDate loses
    one_day = prepare({"durationDays": 1, "startDate": "2027-01-10T15:00:00Z"}, strict=False)
    assert one_day["endDate"] == "2027-01-10"
    across_months = prepare({"durationDays": 30, "startDate": "2027-02-15"}, strict=False)
    assert across_months["endDate"] == "2027-03-16"
    assert prepare({"durationDays": None, "startDate": "2027-01-10"}, strict=False) == {
        "durationDays": None, "startDate": "2027-01-10",
    }
    only_days = prepare({"durationDays": 5}, strict=False)
    assert only_days == {"durationDays": 5}  # the end follows once a start exists
    for bad in (0, -1, 1.5, "3", True, [3]):
        detail = _refusal(prepare, {"durationDays": bad})
        assert detail.startswith(actions.REFUSE_DURATION), (bad, detail)
    assert _refusal(prepare, {"durationDays": 91}).startswith("The ad can run for at most 90 days")
    studio_setting("limits", maxDays=14)
    assert _refusal(prepare, {"durationDays": 15}).startswith("The ad can run for at most 14 days")
    assert prepare({"durationDays": 14}, strict=False)["durationDays"] == 14


# ------------------------------------------------------------------ the real routes

def _create(user: dict, name: str, **fields) -> str:
    campaign_id = _uid("bcmp")
    body = {**_campaign_body(name, fields.pop("budgetMinorUSD", 2_500)), **fields}
    response = client.post("/api/collections/adCampaignRequests", json={"id": campaign_id, "data": body},
                           cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return campaign_id


def _send(user: dict, campaign_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/submit",
                       json={"expectedLastModified": _last_modified(campaign_id), "operationId": _uid("submit-op")},
                       cookies=user["cookies"])


def _row(campaign_id: str) -> dict:
    with db_conn() as conn:
        return json_loads(conn.execute(
            text("SELECT data_json FROM entities WHERE type = 'adCampaignRequests' AND id = :id"), {"id": campaign_id},
        ).scalar_one())


def _force(campaign_id: str, **fields) -> None:
    """Write fields straight into a request row (None removes one), as a request sent before P1 left it."""
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json, last_modified FROM entities WHERE type = 'adCampaignRequests' AND id = :id"),
            {"id": campaign_id},
        ).mappings().first()
        data = {**json_loads(row["data_json"]), **fields}
        for name, value in fields.items():
            if value is None:
                data.pop(name, None)
        modified = int(row["last_modified"]) + 1
        data["_lastModified"] = modified
        conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = 'adCampaignRequests' AND id = :id"),
                     {"d": json_dumps(data), "m": modified, "id": campaign_id})


def _captures(user_id: str) -> list[int]:
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type = 'walletTransactions'")).scalars().all()
    return sorted(
        int(data["amountMinor"]) for data in map(json_loads, rows)
        if data.get("type") == "campaign_payment" and data.get("fromUserId") == user_id
    )


def test_daily_request_holds_charges_and_returns_the_total(staff):
    user = _customer("daily")
    _credit(staff, user["id"], 10_000)
    campaign_id = _create(user, "Daily offer", budgetType="daily", budgetMinorUSD=1_000, durationDays=7,
                          startDate="2027-01-10", endDate="")
    assert _row(campaign_id)["endDate"] == "2027-01-16"
    sent = _send(user, campaign_id)
    assert sent.status_code == 200, sent.text
    held = _summary(user)
    assert held["usd"]["reservedMinor"] == 7_000 and held["usd"]["availableMinor"] == 3_000  # 7 x $10 held
    _assert_identity(held, user["id"])
    # Another request for more than what is left is refused on its TOTAL ($5 x 7 = $35 > $30).
    second = _create(user, "Too much", budgetType="daily", budgetMinorUSD=500, durationDays=7)
    refused = _send(user, second)
    assert refused.status_code == 409 and "Insufficient wallet balance" in refused.text, refused.text
    assert _review(staff, campaign_id, "Approved").status_code == 200
    assert _captures(user["id"]) == [7_000] and _row(campaign_id)["paidMinorUSD"] == 7_000
    charged = _summary(user)
    assert charged["usd"]["inAdsMinor"] == 7_000 and charged["usd"]["reservedMinor"] == 0
    _assert_identity(charged, user["id"])
    # Staff close it having used $12.34 on Meta: the return is counted from the captured row.
    closed = _stop(staff["reviewer"]["cookies"], campaign_id, refund=7_000 - 1_234)
    assert closed.status_code == 200, closed.text
    assert closed.json()["data"]["spendMinorUSD"] == 1_234
    final = _summary(user)
    assert final["usd"]["spentMinor"] == 1_234 and final["usd"]["availableMinor"] == 10_000 - 1_234
    _assert_identity(final, user["id"])


def test_legacy_row_keeps_its_one_day_hold_and_capture(staff):
    user = _customer("legacy")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, "Old daily")
    assert _send(user, campaign_id).status_code == 200
    # As a daily request sent before P1 left it: no schemaVersion 2, no total, one day held.
    _force(campaign_id, schemaVersion=1, budgetType="daily", budgetMinorUSD=300, totalBudgetMinorUSD=None,
           legacyRules=None, durationDays=None)
    with db_conn() as conn:
        assert wallet_campaign_holds_minor(conn, user["id"]) == 300
    held = _summary(user)
    assert held["usd"]["reservedMinor"] == 300
    _assert_identity(held, user["id"])
    approved = _review(staff, campaign_id, "Approved")
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["legacyRules"] is True
    assert _captures(user["id"]) == [300] and _row(campaign_id)["paidMinorUSD"] == 300
    _assert_identity(_summary(user), user["id"])
    stopped = _stop(user["cookies"], campaign_id)  # before its start: the owner gets the capture back
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["data"]["refundMinorUSD"] == 300
    final = _summary(user)
    assert final["usd"]["availableMinor"] == 5_000
    _assert_identity(final, user["id"])


def test_a_future_cutover_keeps_a_send_under_the_old_limits(staff, studio_setting):
    user = _customer("cutover")
    _credit(staff, user["id"], 5_000)
    soon = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    studio_setting("limits", p1CutoverAt=soon)
    small = _create(user, "Small before the cutover", budgetMinorUSD=400)  # under today's $5 minimum
    sent = _send(user, small)
    assert sent.status_code == 200, sent.text
    assert sent.json()["data"]["legacyRules"] is True and sent.json()["data"]["totalBudgetMinorUSD"] == 400
    approved = _review(staff, small, "Approved")
    assert approved.status_code == 200, approved.text
    assert approved.json()["data"]["legacyRules"] is True and _captures(user["id"]) == [400]
    # Once the cutover has passed, a send follows the new limits.
    studio_setting("limits", p1CutoverAt="2026-01-01T00:00:00Z")
    late = _create(user, "Small after the cutover", budgetMinorUSD=400)
    refused = _send(user, late)
    assert refused.status_code == 400 and refused.json()["detail"].startswith(actions.REFUSE_TOTAL_MIN), refused.text
    _assert_identity(_summary(user), user["id"])


def test_a_new_row_whose_total_no_longer_matches_its_hold_is_not_captured(staff):
    user = _customer("mismatch")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, "Changed underneath", budgetType="daily", budgetMinorUSD=300, durationDays=5)
    assert _send(user, campaign_id).status_code == 200
    _force(campaign_id, durationDays=6)  # 6 x $3 = $18, but $15 is held
    refused = _review(staff, campaign_id, "Approved")
    assert refused.status_code == 409 and "Conflict" in refused.text, refused.text
    assert _captures(user["id"]) == []
    _assert_identity(_summary(user), user["id"])


def test_every_send_counts_toward_the_daily_cap(staff):
    """The count itself (read directly; the route's cap check keeps conftest's zero count, so the
    sends of the other tests today never refuse these)."""
    from server.operations import _business_today

    today = _business_today().isoformat()
    user = _customer("count")
    _credit(staff, user["id"], 10_000)
    start = REAL_SUBMISSIONS_TODAY(today)
    first = _create(user, "First")
    assert _send(user, first).status_code == 200
    assert REAL_SUBMISSIONS_TODAY(today) == start + 1
    assert _row(first)["submitDay"] == today and _row(first)["submitDayCount"] == 1
    assert _review(staff, first, "Changes Requested").status_code == 200
    assert _send(user, first).status_code == 200  # a resubmit is a send too
    assert REAL_SUBMISSIONS_TODAY(today) == start + 2 and _row(first)["submitDayCount"] == 2
    assert REAL_SUBMISSIONS_TODAY("2000-01-01") == 0
    # A row stamped on another day does not count today, even when touched today.
    _force(first, submitDay="2000-01-01")
    assert REAL_SUBMISSIONS_TODAY(today) == start
