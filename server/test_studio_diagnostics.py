"""Albayan Studio diagnostics operations lines (plan tasks P3-19, P3-14; PLAN.md §12.3, §12.7, §12.8).

* The queue, staff-time, capacity, reply, results, money and go/no-go lines computed from
  hand-built rows on a fixed clock (pure: compute_operations, go_no_go).
* ``GET /api/studio/admin/diagnostics`` carries the ``operations`` block and never a name, id,
  handle or text.
* P3-14 SQL spy: the diagnostics, the staff pulse, the customer feed and the wallet summary read
  the request rows through projections only, never a request's full ``data_json``.
* Storage lines are counts only and cached; the two wallet doors return no ids.

Every test creates its own users and rows (unique per run) and removes what it wrote.
"""

import copy
import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text

from server.db import db_conn, get_engine, init_db, json_dumps, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import social_studio, studio_activity, studio_diagnostics as diag, studio_stop, studio_wallet
from server.systems.ads_studio.studio_settings import DEFAULTS
from server.systems.ads_studio.studio_types import STUDIO_STOP_REQUESTS_TYPE, SUPPORT_TICKETS_TYPE
from server.wallet_payments import WALLET_PAYMENT_COLLECTION, payment_request_timings, usd_customer_balances_total

TAG = secrets.token_hex(4)
PASSWORD = "StudioDiagnosticsPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
RESULTS = "adCampaignResults"
REPLY_LOG = "socialReplyLog"
ALERTS = "studioAlerts"
LEDGER = "walletTransactions"
UTC = timezone.utc
NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)  # Wednesday, 14:00 in Tripoli; hours Sun-Thu 09:00-17:00 (07:00-15:00 UTC)
SETTINGS = copy.deepcopy(DEFAULTS)
_counter = [0]


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _at(day: str, hour: int, minute: int = 0) -> str:
    return _iso(datetime.fromisoformat(f"2026-{day}T00:00:00+00:00").replace(hour=hour, minute=minute))


def _ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


def _uid(label: str) -> str:
    _counter[0] += 1
    return f"diag_{TAG}_{_counter[0]:03d}_{label}"


# ------------------------------------------------------------------ the pure computation


def _campaign(label: str, **fields) -> dict:
    row = {"id": _uid(label), "ownerId": f"owner_{TAG}", "archived": False, "createdAtMs": _ms(NOW - timedelta(days=40)),
           "status": "Draft", "submittedAt": None, "reviewedAt": None, "approvedAt": None, "linkedAt": None, "stoppedAt": None,
           "closeReason": None, "settleBasis": None, "paidMinorUSD": None, "refundMinorUSD": None, "metaCampaignId": None}
    row.update(fields)
    return row


def _inputs() -> dict:
    c1 = _campaign("c1", status="Approved", submittedAt=_at("09-27", 7), reviewedAt=_at("09-27", 9), approvedAt=_at("09-27", 9),
                   linkedAt=_at("09-27", 10), paidMinorUSD=1000, metaCampaignId="111")
    c2 = _campaign("c2", status="Rejected", submittedAt=_at("09-24", 7), reviewedAt=_at("09-28", 7))  # Thursday -> Monday: late
    c3 = _campaign("c3", status="Submitted", submittedAt=_at("09-24", 8))  # waiting since Thursday: overdue
    c4 = _campaign("c4", status="Submitted", submittedAt=_at("09-30", 10))  # sent today: not due yet
    c5 = _campaign("c5", status="Rejected", submittedAt=_at("08-01", 7), reviewedAt=_at("08-02", 7))  # older than 30 days
    c6 = _campaign("c6", status="Approved", submittedAt=_at("09-04", 7), reviewedAt=_at("09-05", 7), approvedAt=_at("09-05", 7),
                   linkedAt=_at("09-05", 9), paidMinorUSD=500, metaCampaignId="222")  # inside 30 days, outside the week
    c7 = _campaign("c7", status="Stopped", closeReason="completed", stoppedAt=_at("09-29", 10), paidMinorUSD=2000,
                   refundMinorUSD=500, metaCampaignId="333", submittedAt=_at("08-20", 7), reviewedAt=_at("08-20", 8))
    c8 = _campaign("c8", status="Stopped", closeReason="completed", stoppedAt=_at("09-28", 12), paidMinorUSD=300,
                   refundMinorUSD=300, metaCampaignId="444", submittedAt=_at("08-21", 7), reviewedAt=_at("08-21", 8))
    c9 = _campaign("c9", status="Stopped", closeReason="customer_stop", stoppedAt=_at("08-15", 12), paidMinorUSD=100,
                   refundMinorUSD=50, metaCampaignId="555", submittedAt=_at("08-10", 7), reviewedAt=_at("08-10", 8))
    c10 = _campaign("c10", status="Approved", archived=True, paidMinorUSD=9999, metaCampaignId="666")
    results = {
        c1["id"]: {"campaignId": c1["id"], "metaCampaignId": "111", "spendMinorUSD": 1200, "currency": "USD",
                   "lastSyncedAt": _iso(NOW - timedelta(hours=1)), "settleReadDueAt": None, "deliveryEndedAt": None, "neverDelivered": "false"},
        c6["id"]: {"campaignId": c6["id"], "metaCampaignId": "222", "spendMinorUSD": 100, "currency": "USD",
                   "lastSyncedAt": _iso(NOW - timedelta(hours=10)), "settleReadDueAt": None, "deliveryEndedAt": None, "neverDelivered": 0},
        c7["id"]: {"campaignId": c7["id"], "metaCampaignId": "333", "spendMinorUSD": 1600, "currency": "USD",
                   "lastSyncedAt": _at("09-29", 8), "settleReadDueAt": _at("09-29", 8), "deliveryEndedAt": _at("09-27", 8), "neverDelivered": 0},
        c8["id"]: {"campaignId": c8["id"], "metaCampaignId": "444", "spendMinorUSD": 0, "currency": "USD",
                   "lastSyncedAt": _at("09-28", 11), "settleReadDueAt": _at("09-30", 11), "deliveryEndedAt": _at("09-28", 11), "neverDelivered": 1},
        c9["id"]: {"campaignId": c9["id"], "metaCampaignId": "555", "spendMinorUSD": 50, "currency": "USD",
                   "lastSyncedAt": _at("08-15", 12), "settleReadDueAt": None, "deliveryEndedAt": None, "neverDelivered": 0},
    }
    tickets = [
        {"kind": "question", "status": "answered", "createdAt": _at("09-27", 7), "firstStaffAt": _at("09-27", 8)},
        {"kind": "tiktok_request", "status": "answered", "createdAt": _at("09-27", 7), "firstStaffAt": _at("09-28", 8)},
        {"kind": "question", "status": "open", "createdAt": _at("09-24", 7), "firstStaffAt": None},  # waiting past its due time
        {"kind": "stop_request", "status": "open", "createdAt": _at("09-24", 7), "firstStaffAt": None},  # the stop queue's
        {"kind": None, "status": "open", "createdAt": _iso(NOW - timedelta(hours=1)), "firstStaffAt": None},  # not due yet
        {"kind": "question", "status": "resolved", "createdAt": _at("09-24", 7), "firstStaffAt": None},  # closed by the customer
    ]
    stops = [
        {"campaignId": "x", "requestedAt": _at("09-27", 7), "dueAt": _at("09-27", 9), "resolvedAt": _at("09-27", 8), "state": "resolved", "resolvedReason": "stopped"},
        {"campaignId": "y", "requestedAt": _at("09-27", 7), "dueAt": _at("09-27", 9), "resolvedAt": _at("09-27", 10), "state": "resolved", "resolvedReason": "meta_paused"},
        {"campaignId": "z", "requestedAt": _at("09-24", 7), "dueAt": _at("09-24", 9), "resolvedAt": None, "state": "open", "resolvedReason": None},
        {"campaignId": "w", "requestedAt": _iso(NOW - timedelta(minutes=10)), "dueAt": _iso(NOW + timedelta(minutes=110)), "resolvedAt": None, "state": "open", "resolvedReason": None},
    ]
    payments = [
        {"status": "confirmed", "currency": "USD", "createdAt": _at("09-27", 7), "confirmedAt": _at("09-27", 8)},
        {"status": "confirmed", "currency": "LYD", "createdAt": _at("09-27", 7), "confirmedAt": _at("09-28", 7)},
        {"status": "pending", "currency": "USD", "createdAt": _at("09-24", 7), "confirmedAt": ""},
        {"status": "canceled", "currency": "USD", "createdAt": _at("09-24", 7), "confirmedAt": ""},
        {"status": "pending", "currency": "USD", "createdAt": _iso(NOW), "confirmedAt": ""},
    ]

    def reply(source, *, actions, error="", retry_after="", parked="", processing=0, comment_ago=100, changed_ago=40):
        return {"source": source, "commentAt": _iso(NOW - timedelta(seconds=comment_ago)), "actions": actions, "error": error,
                "retryAfter": retry_after, "processing": processing, "parkedReason": parked,
                "lastModifiedMs": _ms(NOW - timedelta(seconds=changed_ago)), "ownerId": "o"}

    replies = [
        reply("webhook", actions=["reply"], comment_ago=100, changed_ago=40),  # 60 s
        reply("webhook", actions=["reply", "like"], comment_ago=200, changed_ago=80),  # 120 s
        reply("poll", actions=["reply"], comment_ago=700, changed_ago=100),  # 600 s
        reply("webhook", actions=[], error="boom"),  # failed
        reply("webhook", actions=[], error="auth", retry_after=_iso(NOW + timedelta(minutes=10)), parked="meta_connection_down"),  # parked
        {**reply("poll", actions=[]), **social_studio._missed_patch()},  # lost to the outage, in the writer's own shape
        reply("webhook", actions=[], processing=1),  # still running: not judged
        reply("webhook", actions=["reply"], comment_ago=10 * 86400, changed_ago=10 * 86400 - 5),  # outside the week
    ]
    alerts = [
        {"kind": "integrity_violation", "acknowledgedAt": None},
        {"kind": "integrity_violation", "acknowledgedAt": _iso(NOW)},
        {"kind": "review_overdue", "acknowledgedAt": None},
    ]
    return {"campaigns": [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10], "results": results, "tickets": tickets, "stops": stops,
            "payments": payments, "replies": replies, "alerts": alerts, "balances": {"balanceMinor": 12345, "users": 3, "negative": 1}}


def test_percentiles_and_queue_lines():
    assert diag.percentile([], 50) is None
    assert diag.percentile([7.0], 90) == 7.0
    assert diag.percentile([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0], 90) == 9.0
    assert diag.percentile([3.0, 1.0, 2.0], 50) == 2.0
    line = diag._queue_line([(NOW, NOW + timedelta(minutes=1)), (NOW, NOW - timedelta(minutes=1)), (NOW, None)], 2, {"value": 1}, 90)
    assert line == {"target": {"value": 1}, "met": 1, "missed": 3, "waitingOverdue": 2, "sample": 4, "percent": 25.0, "onTarget": False}
    assert diag._queue_line([], 0, {}, 90)["percent"] is None and diag._queue_line([], 0, {}, 90)["onTarget"] is None
    assert diag._queue_line([(NOW, NOW)], 0, {}, 90) == {"target": {}, "met": 1, "missed": 0, "waitingOverdue": 0, "sample": 1, "percent": 100.0, "onTarget": True}


def test_operations_lines_from_seeded_rows():
    ops = diag.compute_operations(_inputs(), SETTINGS, NOW, submissions_today=1)
    assert ops["window"] == {"queueDays": 7, "timesDays": 30, "replyDays": 7}

    queues = ops["queues"]
    assert queues["reviews"]["target"] == {"field": "reviewBusinessDays", "value": 1, "unit": "businessDays"}
    assert {k: queues["reviews"][k] for k in ("met", "missed", "waitingOverdue", "sample", "percent", "onTarget")} == \
        {"met": 1, "missed": 2, "waitingOverdue": 1, "sample": 3, "percent": 33.3, "onTarget": False}
    assert queues["tickets"]["target"] == {"field": "ticketFirstResponseMinutes", "value": 240, "unit": "minutes"}
    assert (queues["tickets"]["met"], queues["tickets"]["missed"], queues["tickets"]["waitingOverdue"]) == (1, 1, 1)
    # The TikTok request (answered the next morning) is judged on its own 1-business-day promise, not the 4 working hours.
    assert queues["tiktok"]["target"] == {"field": "tiktokBusinessDays", "value": 1, "unit": "businessDays"}
    assert (queues["tiktok"]["met"], queues["tiktok"]["missed"], queues["tiktok"]["waitingOverdue"], queues["tiktok"]["percent"]) == (1, 0, 0, 100.0)
    assert (queues["stopRequests"]["met"], queues["stopRequests"]["missed"], queues["stopRequests"]["percent"]) == (1, 2, 33.3)
    assert queues["stopRequests"]["target"]["value"] == 120
    assert (queues["payments"]["met"], queues["payments"]["missed"], queues["payments"]["waitingOverdue"]) == (1, 2, 1)
    assert queues["payments"]["target"] == {"field": "paymentConfirmMinutes", "value": 240, "unit": "minutes"}

    times = ops["staffTimes"]
    assert times["review"] == {"p50": 1440.0, "p90": 5760.0, "unit": "minutes", "sample": 3}
    assert times["link"] == {"p50": 60.0, "p90": 120.0, "unit": "minutes", "sample": 2}
    assert times["settle"] == {"p50": 60.0, "p90": 120.0, "unit": "minutes", "sample": 2}
    assert times["ticketFirstResponse"] == {"p50": 60.0, "p90": 1500.0, "unit": "minutes", "sample": 2}
    assert times["stopToPaused"] == {"p50": 60.0, "p90": 180.0, "unit": "minutes", "sample": 2}
    assert times["paymentConfirmation"] == {"p50": 60.0, "p90": 1440.0, "unit": "minutes", "sample": 2}

    assert ops["capacity"] == {
        "intake": {"open": True, "maxSubmissionsPerDay": 500}, "submissionsToday": 1, "usedPercent": 0.2,
        "sendsPerDay7d": {"average": 0.57, "max": 2}, "waitingReview": 2, "reviewed30d": 3,
    }

    replies = ops["replies"]
    assert replies["latency"] == {"webhook": {"p95Seconds": 120.0, "sample": 2}, "poll": {"p95Seconds": 600.0, "sample": 1},
                                  "manual_check": {"p95Seconds": None, "sample": 0}}
    assert replies["failures"] == {"answered": 3, "failed": 2, "sample": 5, "percent": 40.0, "ok": False}
    assert replies["missedDuringOutage"] == 1 and replies["parked"] == 1

    assert ops["results"] == {"linked": 2, "fresh": 1, "freshHours": 6, "percent": 50.0, "ok": False}

    money = ops["money"]
    assert money["owed"] == {"walletBalancesMinorUSD": 12345, "walletsWithMoney": 3, "negativeWallets": 1, "inAdsMinorUSD": 1500, "owedMinorUSD": 13845}
    assert money["absorbedOverspend"] == {"totalMinorUSD": 200, "thisMonthMinorUSD": 200, "campaigns": 1}
    assert money["reconciliation"] == {"month": "2026-09", "settled": 2, "keptMinorUSD": 1500, "metaSpendMinorUSD": 1600,
                                       "differenceMinorUSD": -100, "toleranceMinorUSD": 500, "withinTolerance": True}
    assert money["openIncidents"] == 1
    json.dumps(ops)  # always serialisable


def test_go_no_go_booleans_from_the_numbers():
    ops = diag.compute_operations(_inputs(), SETTINGS, NOW, submissions_today=1)
    facts = {
        "scan": {"total": 2, "byCode": {"stranded_capture": 1, "refund_above_unspent": 1}},
        "jobsAgeSeconds": 100,
        "token": {"configured": True, "checked": True, "stale": False, "isValid": True, "expiresNever": False, "daysLeft": 30,
                  "dataAccessExpiresNever": True, "dataAccessDaysLeft": None},
        "connection": {"state": "down", "since": _iso(NOW - timedelta(hours=7))},
        "now": NOW,
    }
    verdict = diag.go_no_go(ops, facts, SETTINGS["thresholds"])
    go = {name: row["ok"] for name, row in verdict["go"].items()}
    assert go == {
        "integrityViolations": False, "refundsAboveCap": False, "reconciliation": True, "reviewsOnTarget": False,
        "stopRequestsOnTarget": False, "paymentsOnTarget": False, "ticketsOnTarget": False, "resultsFresh": False,
        "webhookReplyP95": True, "pollReplyP95": True, "replyFailureRate": False, "commentsLostToOutage": False,
        "noOpenMoneyIncident": False, "runbookRehearsed": None, "restoreProven": None, "tokenValid": True,
    }
    assert verdict["go"]["integrityViolations"]["value"] == 2 and verdict["go"]["tokenValid"]["value"] == 30
    assert {name: row["fired"] for name, row in verdict["stop"].items()} == {
        "walletIdentityBreak": False, "duplicateCharge": False, "strandedCapture": True, "studioInCoreBooks": False,
        "replyOutage": True, "heartbeatLate": False,
    }
    assert verdict["stop"]["replyOutage"]["hours"] == 7.0 and verdict["stop"]["heartbeatLate"]["ageSeconds"] == 100
    assert verdict["unknown"] == ["restoreProven", "runbookRehearsed"]
    assert verdict["allKnownOk"] is False and verdict["goVerdict"] is None and verdict["stopVerdict"] is True
    assert verdict["consecutiveWeeksNeeded"] == 2

    # A token about to expire, a fine scan and a live heartbeat: the stop rules stay quiet.
    quiet = diag.go_no_go(ops, {
        "scan": {"total": 0, "byCode": {}}, "jobsAgeSeconds": 30, "now": NOW,
        "token": {"configured": True, "checked": True, "stale": False, "isValid": True, "expiresNever": False, "daysLeft": 14},
        "connection": {"state": "ok"},
    }, SETTINGS["thresholds"])
    assert quiet["go"]["tokenValid"]["ok"] is False and quiet["go"]["integrityViolations"]["ok"] is True
    assert quiet["stopVerdict"] is False and all(row["fired"] is False for row in quiet["stop"].values())
    stale = diag.go_no_go(ops, {"token": {"configured": True, "checked": True, "stale": True}, "jobsAgeSeconds": None, "now": NOW}, SETTINGS["thresholds"])
    assert stale["go"]["tokenValid"]["ok"] is None and stale["stop"]["heartbeatLate"]["fired"] is True
    assert stale["stop"]["walletIdentityBreak"]["fired"] is None


def test_tiktok_requests_are_judged_on_their_own_business_day_target():
    sunday = _at("09-27", 8)  # Sunday 10:00 in Tripoli
    inputs = {"tickets": [
        {"kind": "tiktok_request", "status": "answered", "createdAt": sunday, "firstStaffAt": _at("09-27", 14)},  # 6 working hours: met
        {"kind": "tiktok_request", "status": "open", "createdAt": sunday, "firstStaffAt": None},  # Wednesday: past Monday's close
        {"kind": "question", "status": "answered", "createdAt": sunday, "firstStaffAt": _at("09-27", 14)},  # 4 working hours: missed
    ]}
    ops = diag.compute_operations(inputs, SETTINGS, NOW)
    queues = ops["queues"]
    assert (queues["tiktok"]["met"], queues["tiktok"]["missed"], queues["tiktok"]["waitingOverdue"]) == (1, 1, 1)
    assert queues["tiktok"]["target"] == {"field": "tiktokBusinessDays", "value": 1, "unit": "businessDays"}
    assert (queues["tickets"]["met"], queues["tickets"]["missed"], queues["tickets"]["waitingOverdue"]) == (0, 1, 0)
    assert ops["staffTimes"]["ticketFirstResponse"]["sample"] == 2  # both first answers still count as ticket first responses


def test_go_rows_prefer_the_precise_reply_latency():
    """P4-02: read_operations adds social_studio.reply_latency_by_source (sentAt - receivedAt) as
    ``latencyBySource``; the go rows judge it against the thresholds whenever it has a sample."""
    ops = diag.compute_operations(_inputs(), SETTINGS, NOW, submissions_today=1)
    facts = {"scan": {"total": 0, "byCode": {}}, "jobsAgeSeconds": 10, "now": NOW}
    assert diag.go_no_go(ops, facts, SETTINGS["thresholds"])["go"]["webhookReplyP95"] == {"ok": True, "value": 120.0}
    ops["replies"]["latencyBySource"] = {"webhook": {"count": 40, "p50Seconds": 30, "p95Seconds": 999},
                                        "poll": {"count": 0, "p50Seconds": None, "p95Seconds": None}}
    verdict = diag.go_no_go(ops, facts, SETTINGS["thresholds"])
    assert verdict["go"]["webhookReplyP95"] == {"ok": False, "value": 999}  # the precise measure wins when it has a sample
    assert verdict["go"]["pollReplyP95"] == {"ok": True, "value": 600.0}  # no sample: the log rows' measure stays
    ops["replies"]["latencyBySource"] = {"readError": "RuntimeError"}
    assert diag.go_no_go(ops, facts, SETTINGS["thresholds"])["go"]["webhookReplyP95"] == {"ok": True, "value": 120.0}


def test_empty_inputs_give_unknowns_not_a_crash():
    ops = diag.compute_operations({}, SETTINGS, NOW)
    assert all(line["percent"] is None and line["onTarget"] is None and line["sample"] == 0 for line in ops["queues"].values())
    assert all(value is None for value in ops["staffTimes"].values())
    assert ops["capacity"]["submissionsToday"] == 0 and ops["capacity"]["sendsPerDay7d"] == {"average": 0.0, "max": 0}
    assert ops["replies"]["failures"]["ok"] is None and ops["results"]["ok"] is None
    assert ops["money"]["owed"]["owedMinorUSD"] == 0 and ops["money"]["reconciliation"]["withinTolerance"] is None
    junk = {"campaigns": [{"status": "Approved", "submittedAt": 12345, "paidMinorUSD": "lots"}, {}], "results": {"": {}},
            "tickets": [{"createdAt": "never"}, {}], "stops": [{}, {"requestedAt": "x"}], "payments": [{"status": "confirmed"}, {}],
            "replies": [{"lastModifiedMs": "abc", "actions": "not a list"}, {}], "alerts": [{}], "balances": {"balanceMinor": "x"}}
    ops = diag.compute_operations(junk, SETTINGS, NOW)
    assert ops["money"]["owed"]["inAdsMinorUSD"] == 0
    json.dumps(ops)
    verdict = diag.go_no_go(ops, {}, SETTINGS["thresholds"])
    assert verdict["goVerdict"] is None and "integrityViolations" in verdict["unknown"]
    assert verdict["stop"]["heartbeatLate"]["fired"] is True


# ------------------------------------------------------------------ the database and the route


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    stamp = now_ms()
    user_id = new_id("diag_user")
    email = f"studio-diag-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"Diag {label} Person {TAG}", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
                "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "email": email, "cookies": cookies, "name": f"Diag {label} Person {TAG}"}


def _insert(entity_type: str, row_id: str, owner: str | None, data: dict, *, created_ms: int | None = None, deleted: bool = False) -> str:
    stamp = created_ms or now_ms()
    body = {"id": row_id, "recordType": entity_type, "_created": stamp, "_lastModified": stamp, "_deleted": deleted, **data}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,:deleted,:stamp,:owner,:stamp)"),
            {"type": entity_type, "id": row_id, "data": json_dumps(body), "deleted": deleted, "stamp": stamp, "owner": owner},
        )
    return row_id


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()


@pytest.fixture(scope="module")
def people():
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "staff": _insert_user("staff", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "owner": _insert_user("owner", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
    }


@pytest.fixture
def seeded(people):
    """Rows with identifying content across every type the operations lines read."""
    owner = people["owner"]["id"]
    made: list[tuple[str, str]] = []
    campaign = _uid("route")
    made.append((CAMPAIGNS, _insert(CAMPAIGNS, campaign, owner, {
        "status": "Approved", "name": f"Secret Route Campaign {TAG}", "pageName": f"Private Page {TAG}", "paidMinorUSD": 700,
        "submittedAt": _iso(NOW - timedelta(days=1)), "reviewedAt": _iso(NOW - timedelta(hours=20)), "approvedAt": _iso(NOW - timedelta(hours=20)),
        "linkedAt": _iso(NOW - timedelta(hours=19)), "metaCampaignId": "120987654321", "creativeImages": ["data:image/png;base64," + "A" * 5000],
    })))
    made.append((RESULTS, _insert(RESULTS, f"acr_{TAG}_{campaign[-8:]}", owner, {
        "campaignId": campaign, "metaCampaignId": "120987654321", "spendMinorUSD": 900, "currency": "USD",
        "lastSyncedAt": _iso(NOW - timedelta(minutes=30)), "metaCampaignName": f"ALB-S-ABCDEFGH · Secret Route Campaign {TAG}",
    })))
    made.append((SUPPORT_TICKETS_TYPE, _insert(SUPPORT_TICKETS_TYPE, f"tkt_{secrets.token_hex(20)}", owner, {
        "kind": "tiktok_request", "status": "answered", "category": "tiktok", "audience": "staff", "subject": f"TikTok · @secret_{TAG}",
        "tiktokHandle": f"secret_{TAG}", "createdAt": _iso(NOW - timedelta(hours=5)), "firstStaffAt": _iso(NOW - timedelta(hours=4)),
        "number": "T-999001",
    })))
    made.append((STUDIO_STOP_REQUESTS_TYPE, _insert(STUDIO_STOP_REQUESTS_TYPE, f"ssr_{secrets.token_hex(20)}", owner, {
        "campaignId": campaign, "ownerId": owner, "requestedAt": _iso(NOW - timedelta(hours=3)), "dueAt": _iso(NOW - timedelta(hours=1)),
        "resolvedAt": _iso(NOW - timedelta(hours=2)), "state": "resolved", "resolvedReason": "stopped", "ticketNumber": "T-999002",
    })))
    made.append((REPLY_LOG, _insert(REPLY_LOG, f"srl_{secrets.token_hex(20)}", owner, {
        "source": "webhook", "commentAt": _iso(NOW - timedelta(seconds=90)), "actions": ["reply"], "error": "", "fromId": f"commenter_{TAG}",
        "commentText": f"secret comment {TAG}",
    }, created_ms=_ms(NOW - timedelta(seconds=30)))))
    made.append((ALERTS, _insert(ALERTS, f"sal_{secrets.token_hex(20)}", None, {"kind": "integrity_violation", "acknowledgedAt": None, "details": {"userIds": [owner]}})))
    made.append((WALLET_PAYMENT_COLLECTION, _insert(WALLET_PAYMENT_COLLECTION, f"wpr_{TAG}_route", owner, {
        "userId": owner, "reference": f"PAY-{TAG.upper()}A", "status": "confirmed", "amountMinor": 5000, "currency": "USD",
        "createdAt": _iso(NOW - timedelta(hours=6)), "confirmedAt": _iso(NOW - timedelta(hours=5)), "receiptPhoto": "data:image/png;base64," + "B" * 4000,
    })))
    made.append((LEDGER, _insert(LEDGER, f"wtx_{TAG}_credit", owner, {
        "type": "credit", "currency": "USD", "amountMinor": 5000, "fromUserId": None, "toUserId": owner, "idempotencyKey": f"payreq:{TAG}",
        "referenceType": WALLET_PAYMENT_COLLECTION, "referenceId": f"wpr_{TAG}_route", "createdAt": _iso(NOW - timedelta(hours=5)), "status": "posted",
        "memo": f"Wallet charge PAY-{TAG.upper()}A",
    })))
    yield {"owner": owner, "campaign": campaign, "ids": made}
    with db_conn() as conn:
        for entity_type, row_id in made:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": entity_type, "id": row_id})
    diag.reset_storage_cache()


def test_diagnostics_route_carries_the_operations_block_without_personal_data(people, seeded, monkeypatch):
    monkeypatch.setattr(diag, "count_submissions_today", lambda day: 0)
    diag.reset_storage_cache()
    reset_rate_limit(f"studio:diagnostics:{people['admin']['id']}")
    for who in ("staff", "owner"):
        response = client.get("/api/studio/admin/diagnostics", cookies=people[who]["cookies"])
        assert response.status_code == 403 and response.json()["detail"]["code"] == "ADMIN_ONLY"
    response = client.get("/api/studio/admin/diagnostics", cookies=people["admin"]["cookies"])
    assert response.status_code == 200, response.text
    body = response.json()
    ops = body["operations"]
    assert set(ops) == {"window", "queues", "staffTimes", "capacity", "replies", "results", "money", "storage", "meta", "goNoGo", "jobs"}
    assert set(ops["queues"]) == {"reviews", "tickets", "tiktok", "stopRequests", "payments"}
    assert ops["queues"]["stopRequests"]["sample"] >= 1 and ops["queues"]["payments"]["sample"] >= 1
    assert ops["queues"]["tiktok"]["sample"] >= 1 and ops["queues"]["reviews"]["sample"] >= 1  # the seeded ticket is a TikTok request
    assert ops["staffTimes"]["link"]["sample"] >= 1 and ops["staffTimes"]["stopToPaused"]["sample"] >= 1
    assert ops["results"]["linked"] >= 1 and ops["money"]["owed"]["inAdsMinorUSD"] >= 700
    assert ops["money"]["owed"]["walletBalancesMinorUSD"] >= 5000 and ops["money"]["owed"]["owedMinorUSD"] >= 5700
    assert ops["money"]["absorbedOverspend"]["totalMinorUSD"] >= 200 and ops["money"]["openIncidents"] >= 1
    assert "studioFunds" in ops["money"] and set(ops["money"]["studioFunds"]) == {"readAt", "allowlistConfigured", "accounts", "fundsMinorUSD", "unreadable"}
    assert ops["replies"]["latency"]["webhook"]["sample"] >= 1
    assert set(ops["replies"]["latencyBySource"]["webhook"]) == {"count", "p50Seconds", "p95Seconds"}  # P4-02, counts and seconds
    assert set(ops["meta"]) == {"connection", "token", "webhookCounters", "instagramPoll"}
    assert {"capability", "claimed", "accounts", "byOutcome"} <= set(ops["meta"]["instagramPoll"])  # P4-09, counts and times
    assert set(ops["meta"]["token"]) <= set(diag._TOKEN_FIELDS) | {"readError"}  # health fields only, never a token value
    assert set(ops["goNoGo"]) == {"go", "stop", "allKnownOk", "unknown", "goVerdict", "stopVerdict", "consecutiveWeeksNeeded"}
    assert ops["goNoGo"]["go"]["noOpenMoneyIncident"]["ok"] is False
    assert ops["storage"]["totalRows"] >= len(seeded["ids"]) and all(set(item) == {"rows", "bytes"} for item in ops["storage"]["topOwners"])
    assert all(set(item) == {"type", "rows", "bytes"} for item in ops["storage"]["byType"]) and len(ops["storage"]["byType"]) <= 10
    assert set(ops["storage"]["lastBackup"]) == {"enabled", "at", "bytes"}
    assert body["jobs"] == ops["jobs"] and "late" in body["jobs"]
    owner = people["owner"]
    for secret in (owner["id"], owner["email"], owner["name"], seeded["campaign"], f"Secret Route Campaign {TAG}", f"Private Page {TAG}",
                   f"secret_{TAG}", f"commenter_{TAG}", f"secret comment {TAG}", f"PAY-{TAG.upper()}A", "T-999001", "T-999002",
                   "120987654321", "ALB-S-ABCDEFGH", "base64", people["admin"]["id"], people["staff"]["id"], "@"):
        assert secret not in response.text, secret


# ------------------------------------------------------------------ P3-14: projections only


_PROJECTED = (
    re.compile(r"data_json::jsonb AS doc"),
    re.compile(r"json_extract\(data_json, '\$\.[A-Za-z_][A-Za-z0-9_]*'\)"),
    re.compile(r"octet_length\(data_json\)"),
    re.compile(r"length\(CAST\(data_json AS BLOB\)\)"),
)


class _Spy:
    """Every SELECT the engine runs, with the values it was bound with."""

    def __init__(self):
        self.statements: list[tuple[str, list]] = []

    def __call__(self, conn, clauseelement, multiparams, params, execution_options):
        values: list = []
        for group in list(multiparams or []) + [params or {}]:
            for item in group if isinstance(group, (list, tuple)) else [group]:
                if isinstance(item, dict):
                    values.extend(item.values())
        self.statements.append((str(clauseelement), values))

    def reads_of(self, entity_type: str) -> list[str]:
        found = []
        for sql, values in self.statements:
            head = sql.lstrip().upper()
            if not head.startswith("SELECT"):
                continue
            if f"'{entity_type}'" in sql or entity_type in values:
                found.append(sql)
        return found


def _bare_data_json(sql: str) -> bool:
    stripped = sql
    for pattern in _PROJECTED:
        stripped = pattern.sub("", stripped)
    return "data_json" in stripped


@pytest.fixture
def spy():
    listener = _Spy()
    event.listen(get_engine(), "before_execute", listener)
    try:
        yield listener
    finally:
        event.remove(get_engine(), "before_execute", listener)


def test_pulse_feed_summary_and_diagnostics_never_read_a_request_document(people, seeded, spy, monkeypatch):
    monkeypatch.setattr(diag, "count_submissions_today", lambda day: 0)
    diag.reset_storage_cache()
    owner = people["owner"]["id"]
    with db_conn() as conn:
        studio_stop.staff_pulse(conn, people["staff"]["id"], admin=False, now=NOW)
        studio_stop.staff_pulse(conn, people["admin"]["id"], admin=True, now=NOW)
        studio_activity.load_feed(conn, owner)
        studio_wallet.wallet_summary(conn, owner, NOW)
    diag.read_diagnostics(NOW)
    reads = spy.reads_of(CAMPAIGNS)
    assert len(reads) >= 4, "the spy saw too few request reads (two pulses, the wallet summary, the diagnostics)"
    bare = [sql for sql in reads if _bare_data_json(sql)]
    assert bare == [], "a request's full data_json was read:\n" + "\n".join(bare)
    for sql in reads:
        assert "creativeImages" not in sql
    # The diagnostics read the other studio lists through projections as well.
    spy.statements.clear()
    diag.read_diagnostics(NOW)
    for entity_type in (CAMPAIGNS, RESULTS, SUPPORT_TICKETS_TYPE, STUDIO_STOP_REQUESTS_TYPE, REPLY_LOG, ALERTS, WALLET_PAYMENT_COLLECTION, LEDGER):
        reads = spy.reads_of(entity_type)
        assert reads, entity_type
        assert [sql for sql in reads if _bare_data_json(sql)] == [], entity_type
    campaign_reads = spy.reads_of(CAMPAIGNS)
    assert sum("parsed_once" in sql or "json_extract" in sql for sql in campaign_reads) == len(campaign_reads)


def test_spy_catches_a_full_document_read(spy):
    with db_conn() as conn:
        conn.execute(text("SELECT id, data_json FROM entities WHERE type = :type LIMIT 1"), {"type": CAMPAIGNS}).all()
        conn.execute(text(f"SELECT json_extract(data_json, '$.status') AS f_status FROM entities WHERE type = '{CAMPAIGNS}' LIMIT 1")).all()
    reads = spy.reads_of(CAMPAIGNS)
    assert len(reads) == 2 and [_bare_data_json(sql) for sql in reads] == [True, False]
    assert not _bare_data_json("SELECT created_at, (doc ->> 'status') AS f_status FROM (SELECT created_at, data_json::jsonb AS doc FROM entities WHERE type = :type OFFSET 0) AS parsed_once")
    assert _bare_data_json("SELECT data_json::jsonb ->> 'status' FROM entities")


# ------------------------------------------------------------------ storage and the wallet doors


def test_storage_lines_are_counts_only_and_cached(people):
    diag.reset_storage_cache()
    markers = [_insert("studioProfiles", f"stp_{TAG}_storage1", people["owner"]["id"], {"whatsappNumber": None})]
    try:
        with db_conn() as conn:
            first = diag.read_storage(conn, force=True)
            assert first["totalRows"] >= 1 and first["totalBytes"] >= 1 and first["databaseBytes"] is not None and first["databaseBytes"] > 0
            assert all(set(item) == {"type", "rows", "bytes"} and item["rows"] >= 1 for item in first["byType"])
            assert first["byType"] == sorted(first["byType"], key=lambda item: (-item["bytes"], item["type"]))
            assert 1 <= len(first["byType"]) <= 10  # the ten biggest types of the shared table (the marker's may be smaller)
            assert all(set(item) == {"rows", "bytes"} for item in first["topOwners"]) and 1 <= len(first["topOwners"]) <= 5
            assert set(first["lastBackup"]) == {"enabled", "at", "bytes"} and first["cacheSeconds"] == 600
        markers.append(_insert("studioProfiles", f"stp_{TAG}_storage2", people["owner"]["id"], {"whatsappNumber": None}))
        with db_conn() as conn:
            cached = diag.read_storage(conn)
            assert cached["totalRows"] == first["totalRows"] and cached["readAt"] == first["readAt"]
            fresh = diag.read_storage(conn, force=True)
            assert fresh["totalRows"] == first["totalRows"] + 1
    finally:
        with db_conn() as conn:
            for marker in markers:
                conn.execute(text("DELETE FROM entities WHERE type = 'studioProfiles' AND id = :id"), {"id": marker})
        diag.reset_storage_cache()
    assert people["owner"]["id"] not in json.dumps(first)


def test_wallet_doors_return_counts_and_times_only(people):
    a, b = people["owner"]["id"], people["staff"]["id"]
    rows = [
        (f"wtx_{TAG}_a1", {"type": "credit", "currency": "USD", "amountMinor": 1000, "fromUserId": None, "toUserId": a}),
        (f"wtx_{TAG}_a2", {"type": "campaign_payment", "currency": "usd", "amountMinor": 400, "fromUserId": a, "toUserId": "system"}),
        (f"wtx_{TAG}_a3", {"type": "credit", "currency": "LYD", "amountMinor": 999, "fromUserId": None, "toUserId": a}),
        (f"wtx_{TAG}_a4", {"type": "credit", "currency": "USD", "amount": 2.5, "fromUserId": None, "toUserId": a}),  # legacy amount
        (f"wtx_{TAG}_b1", {"type": "transfer", "currency": "USD", "amountMinor": 100, "fromUserId": b, "toUserId": a}),
    ]
    made = [_insert(LEDGER, row_id, None, data) for row_id, data in rows]
    made.append(_insert(LEDGER, f"wtx_{TAG}_gone", None, {"type": "credit", "currency": "USD", "amountMinor": 77, "toUserId": a}, deleted=True))
    payments = [
        (f"wpr_{TAG}_p1", {"status": "confirmed", "currency": "USD", "createdAt": "2026-09-01T07:00:00Z", "confirmedAt": "2026-09-01T08:00:00Z", "amountMinor": 1}),
        (f"wpr_{TAG}_p2", {"status": "pending", "createdAt": "2026-09-02T07:00:00Z", "userId": a, "reference": f"PAY-{TAG}"}),
    ]
    made += [_insert(WALLET_PAYMENT_COLLECTION, row_id, a, data) for row_id, data in payments]
    made.append(_insert(WALLET_PAYMENT_COLLECTION, f"wpr_{TAG}_p3", a, {"status": "confirmed", "createdAt": "x"}, deleted=True))
    try:
        with db_conn() as conn:
            totals = usd_customer_balances_total(conn)
            timings = payment_request_timings(conn)
    finally:
        with db_conn() as conn:
            for row_id in made:
                conn.execute(text("DELETE FROM entities WHERE id = :id"), {"id": row_id})
    # a: +1000 - 400 + 250 + 100 = 950 (the LYD and deleted rows never count); b: -100 (below zero, not owed).
    assert totals["balanceMinor"] >= 950 and totals["users"] >= 1 and totals["negative"] >= 1
    mine = [row for row in timings if row["createdAt"] in ("2026-09-01T07:00:00Z", "2026-09-02T07:00:00Z")]
    assert sorted(mine, key=lambda row: row["createdAt"]) == [
        {"status": "confirmed", "currency": "USD", "createdAt": "2026-09-01T07:00:00Z", "confirmedAt": "2026-09-01T08:00:00Z"},
        {"status": "pending", "currency": "USD", "createdAt": "2026-09-02T07:00:00Z", "confirmedAt": ""},
    ]
    assert all(set(row) == {"status", "currency", "createdAt", "confirmedAt"} for row in timings)
    assert a not in json.dumps(timings) and f"PAY-{TAG}" not in json.dumps(timings)


def test_studio_funds_line_reads_the_stored_reading_with_tails_only(monkeypatch):
    monkeypatch.setattr(diag._meta, "_load_funds_state", lambda: {"updatedAt": "2026-09-30T10:00:00Z", "accounts": [
        {"id": "act_1234567890", "fundsMinor": 50_000, "capRemainingMinor": None, "isPrepay": True, "currency": "USD", "status": 1},
        {"id": "2234567891", "fundsMinor": None, "isPrepay": False, "currency": "USD", "status": 2, "fundsHidden": True},
        {"id": "act_3234567892", "fundsMinor": 700, "isPrepay": True, "currency": "EUR", "status": 1},
        {"id": "act_4234567893", "fundsMinor": 900, "error": "rate_limited", "waiting": True},
        "junk",
    ]})
    monkeypatch.setattr(diag._meta, "load_meta_ads_config", lambda: type("Config", (), {"allowed_account_ids": ("1234567890", "2234567891", "3234567892", "4234567893")})())
    funds = diag.read_studio_funds()
    assert funds["readAt"] == "2026-09-30T10:00:00Z" and funds["allowlistConfigured"] is True
    assert [item["account"] for item in funds["accounts"]] == ["…7890", "…7891", "…7892", "…7893"]
    assert funds["fundsMinorUSD"] == 50_000 and funds["unreadable"] == 3
    assert funds["accounts"][1] == {"account": "…7891", "currency": "USD", "isPrepay": False, "fundsMinor": None, "capRemainingMinor": None,
                                    "status": 2, "fundsHidden": True, "readError": False, "stale": False}
    assert "1234567890" not in json.dumps(funds)
    monkeypatch.setattr(diag._meta, "load_meta_ads_config", lambda: type("Config", (), {"allowed_account_ids": ("9999999999",)})())
    assert diag.read_studio_funds()["accounts"] == [] and diag.read_studio_funds()["fundsMinorUSD"] is None
