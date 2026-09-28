"""Review loop round 1, batch B2: support tickets, stop requests, the inbox, campaign field validation and
the audit route. Every test here failed before its fix.

* n5: an extreme campaign date (9999-12-31 in a zone west of UTC, 0001-01-01 east of it, or a 9999 start
  plus a duration) was an OverflowError (HTTP 500), not a 400.
* n6/n25: ``wants`` holding an object or a list made ``set(values)`` raise TypeError (HTTP 500) on
  POST /api/studio/tiktok/requests, before the rate limit and the service check.
* n9: GET /api/audit?offset=<huge> overflowed the database integer (HTTP 500).
* n23: a customer's reply on (or reopen of) a stop ticket the SYSTEM resolved brought it back as an
  URGENT stop request (stop due time, pinned, counted as an open stop ticket by the desk badge).
  Follow-up: the same for a stop ticket the team resolved by hand whose stop row resolved later.
* n24: a stop request was accepted for an Approved ad whose delivery had already ended (display stage
  10): an urgent ticket, a promise to pause it, and overdue alerts nobody could clear. Follow-up: only
  a Meta reading proves the end; an unlinked ad past its end date stays askable.
* n26: the inbox item "Your ad has ended" took Meta's end time, which can be older than a seen marker
  set before the sync noticed the end: the item was born already read.

Every test builds its own users (unique e-mails per run) and removes every row they own afterwards.
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

from server import main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_fields, studio_settings, studio_stop, studio_support
from server.systems.ads_studio.studio_activity import record_activity
from server.systems.ads_studio.studio_hours import iso, target_due_at
from server.systems.ads_studio.studio_results import load_request, load_results_row, write_results_row
from server.systems.ads_studio.studio_results_sync import fields_after_read
from server.systems.ads_studio.studio_stop import REFUSE_STOP_ALREADY_ENDED, STOP_TYPE, stop_row_id
from server.systems.ads_studio.studio_types import SUPPORT_TICKETS_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopB2Password123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
THURSDAY_OPEN = datetime(2026, 9, 24, 8, 30, tzinfo=timezone.utc)  # Thu 10:30 in Tripoli: working hours
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl1b2_user")
    email = f"review-loop-b2-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"B2 {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
             "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    _USERS.append(user_id)
    return {"id": user_id, "email": email, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    return {
        "owner": _insert_user("owner", "Employee", CUSTOMER_PERMISSIONS),
        "admin": _insert_user("admin", "Admin", {}),
        "own_audit": _insert_user("ownaudit", "Employee", {"auditLogs": ["viewOwn"]}),
    }


@pytest.fixture(autouse=True)
def _isolated(people):
    """Settings rows put back exactly, every row of this module's users removed, rate limits reset."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    for uid in _USERS:
        for bucket in ("ad-studio:mutations", "studio:ticket-write", "studio:ticket-read", "studio:tiktok-create",
                       "studio:activity-read", "studio:activity-seen", "studio:staff-ticket-write"):
            reset_rate_limit(f"{bucket}:{uid}")
    studio_stop.reset_pulse_cache()
    yield
    with db_conn() as conn:
        for chunk in (_USERS[i:i + 50] for i in range(0, len(_USERS), 50)):
            params = {f"u{i}": uid for i, uid in enumerate(chunk)}
            names = ", ".join(f":u{i}" for i in range(len(chunk)))
            conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names})"), params)
        conn.execute(text("DELETE FROM entities WHERE type = 'studioSettings'"))
        for row in saved:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                row,
            )


def _setting(key: str, **fields) -> None:
    record = studio_settings.read_setting(key)
    studio_settings.save_setting(key, fields, record["version"], "", "2026-09-25T00:00:00Z", audit=lambda *args: None)


def _services_on() -> None:
    _setting("rollout", services={"help": "on", "stopRequest": "on", "tiktok": "off"})


def _campaign(owner_id: str, label: str, status: str = "Approved", **data) -> str:
    campaign_id = f"rl1b2_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"B2 ad {label}", "status": status, "creativeImages": ["data:image/png;base64,AAAA"],
            "studioRef": "ALB-S-ABCDEFGH", **data}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    return campaign_id


def _row(row_type: str, row_id: str) -> dict | None:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id, data_json, created_by FROM entities WHERE type = :t AND id = :id"),
            {"t": row_type, "id": row_id},
        ).mappings().first()
    return None if row is None else {**dict(row), "data": json_loads(row["data_json"])}


def _ask(user: dict, campaign_id: str):
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                       json={"operationId": f"stop-{secrets.token_hex(6)}"}, cookies=user["cookies"])


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _fix_clock(monkeypatch, moment: datetime) -> None:
    monkeypatch.setattr(studio_stop, "utc_now", lambda: moment)
    monkeypatch.setattr(studio_support, "utc_now", lambda: moment)


# ------------------------------------------------------------------ n5: campaign dates never overflow


@pytest.mark.parametrize("value", ["9999-12-31T23:59:59-05:00", "0001-01-01T00:00:00+05:00", "1999-12-31", "2101-01-01"])
def test_n5_extreme_campaign_date_is_a_400_not_an_overflow(people, value):
    ctx = main._AD_CAMPAIGN_FIELDS_CTX
    with pytest.raises(HTTPException) as refused:
        ad_campaign_fields.ad_campaign_date(value, "startDate", ctx)
    assert refused.value.status_code == 400 and refused.value.detail == "startDate must be a valid ISO date"
    with pytest.raises(HTTPException) as through_prepare:  # the function the collection POST/PATCH calls
        main._prepare_ad_campaign_fields({"startDate": value}, strict=False)
    assert through_prepare.value.status_code == 400


def test_n5_far_start_with_a_duration_is_a_400_and_normal_dates_still_work(people):
    with pytest.raises(HTTPException) as refused:
        main._prepare_ad_campaign_fields({"startDate": "9999-12-31", "durationDays": 2}, strict=False)
    assert refused.value.status_code == 400 and refused.value.detail == "startDate must be a valid ISO date"
    clean = main._prepare_ad_campaign_fields({"startDate": "2027-01-10", "durationDays": 7}, strict=False)
    assert clean["startDate"] == "2027-01-10" and clean["endDate"] == "2027-01-16"
    zoned = main._prepare_ad_campaign_fields({"startDate": "2100-12-31T20:00:00-02:00"}, strict=False)
    assert zoned["startDate"] == "2100-12-31T20:00:00-02:00"


# ------------------------------------------------------------------ n6 / n25: TikTok wants of the wrong kind


@pytest.mark.parametrize("wants", [[{}], [[], "advice"], ["advice", {"x": 1}], [["advice"]]])
def test_n6_tiktok_wants_with_objects_or_lists_is_a_400(people, wants):
    owner = people["owner"]
    response = client.post("/api/studio/tiktok/requests",
                           json={"handle": "myshop", "wants": wants, "operationId": f"tt-{secrets.token_hex(5)}"},
                           cookies=owner["cookies"])
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == "INVALID_VALUE"
    with db_conn() as conn:
        tickets = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND created_by = :uid"),
                               {"t": SUPPORT_TICKETS_TYPE, "uid": owner["id"]}).scalar()
    assert tickets == 0


# ------------------------------------------------------------------ n9: the audit list offset


def test_n9_audit_huge_offset_is_an_empty_page_not_a_500(people):
    huge = "100000000000000000000000"
    for who in ("admin", "own_audit"):  # auditLogs.view (the whole log) and viewOwn (own rows only)
        response = client.get(f"/api/audit?offset={huge}", cookies=people[who]["cookies"])
        assert response.status_code == 200, (who, response.text)
        assert response.json() == []
    first = client.get("/api/audit?limit=5", cookies=people["admin"]["cookies"])
    assert first.status_code == 200 and isinstance(first.json(), list)  # a normal page still reads


# ------------------------------------------------------------------ n23: a reply on a stop ticket the system resolved


def _counts() -> dict:
    return studio_support.staff_ticket_counts(include_admin=True)


def test_n23_reply_or_reopen_on_a_system_resolved_stop_ticket_is_a_plain_question(people, monkeypatch):
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    owner, admin = people["owner"], people["admin"]
    settings = studio_settings.read_all_settings()
    tickets = {}
    for label in ("reply", "reopen", "byhand"):
        campaign_id = _campaign(owner["id"], label)
        asked = _ask(owner, campaign_id)
        assert asked.status_code == 200, asked.text
        tickets[label] = (campaign_id, asked.json()["ticket"]["id"])
    for label in ("reply", "reopen"):  # the ad was Stopped (or Meta paused it): the stop row and its ticket resolve
        assert studio_stop.resolve_stop_request(tickets[label][0], "stopped", THURSDAY_OPEN) is True
        assert _row(SUPPORT_TICKETS_TYPE, tickets[label][1])["data"]["resolvedBy"] == "system"

    before = _counts()
    replied = client.post(f"/api/studio/tickets/{tickets['reply'][1]}/messages",
                          json={"text": "Thanks!", "operationId": f"reply-{secrets.token_hex(5)}"}, cookies=owner["cookies"])
    assert replied.status_code == 200, replied.text
    assert replied.json()["ticket"]["status"] == "open"
    assert replied.json()["ticket"]["priority"] == "normal" and replied.json()["ticket"]["kind"] == "question"
    stored = _row(SUPPORT_TICKETS_TYPE, tickets["reply"][1])["data"]
    assert stored["dueAt"] == iso(target_due_at("ticket", THURSDAY_OPEN, settings))  # the plain ticket target
    assert stored["dueAt"] != iso(target_due_at("stop_request", THURSDAY_OPEN, settings))
    after = _counts()
    assert after["open"] == before["open"] + 1
    assert after["stopOpen"] == before["stopOpen"] and after["urgent"] == before["urgent"]  # no phantom stop ticket

    reopened = client.post(f"/api/studio/tickets/{tickets['reopen'][1]}/reopen",
                           json={"operationId": f"reopen-{secrets.token_hex(5)}"}, cookies=owner["cookies"])
    assert reopened.status_code == 200, reopened.text
    view = reopened.json()["ticket"]
    assert view["status"] == "open" and view["priority"] == "normal" and view["kind"] == "question"
    assert _counts()["stopOpen"] == before["stopOpen"]

    # A stop ticket the TEAM resolved by hand keeps its kind: its stop row may still be open.
    campaign_id, ticket_id = tickets["byhand"]
    staff = client.post(f"/api/studio/staff/tickets/{ticket_id}/status",
                        json={"status": "resolved", "operationId": f"staff-{secrets.token_hex(5)}"}, cookies=admin["cookies"])
    assert staff.status_code == 200, staff.text
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["state"] == "open"
    again = client.post(f"/api/studio/tickets/{ticket_id}/reopen",
                        json={"operationId": f"reopen-{secrets.token_hex(5)}"}, cookies=owner["cookies"])
    assert again.status_code == 200, again.text
    assert again.json()["ticket"]["priority"] == "urgent" and again.json()["ticket"]["kind"] == "stop_request"


def _staff_status(admin: dict, ticket_id: str, status: str):
    return client.post(f"/api/studio/staff/tickets/{ticket_id}/status",
                       json={"status": status, "operationId": f"staff-{secrets.token_hex(5)}"}, cookies=admin["cookies"])


def test_n23_hand_resolved_stop_ticket_whose_stop_row_resolves_later_is_a_plain_question(people, monkeypatch):
    """Review r1 follow-up: the team resolves the stop ticket by hand while its stop row is still open;
    later the row resolves (Meta paused the ad, or it was Stopped). system_resolve_ticket_conn used to
    skip the already-resolved ticket, so a customer's "thanks" brought it back URGENT, pinned and
    counted as an open stop ticket. Also: a system-resolved stop ticket the team reopened and resolved
    again (resolvedBy becomes 'team') stays a handled stop."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    owner, admin = people["owner"], people["admin"]
    settings = studio_settings.read_all_settings()
    tickets = {}
    for label in ("handfirst", "teamagain"):
        campaign_id = _campaign(owner["id"], label)
        asked = _ask(owner, campaign_id)
        assert asked.status_code == 200, asked.text
        tickets[label] = (campaign_id, asked.json()["ticket"]["id"])

    # The team answers and resolves the stop ticket by hand; its stop row is still open.
    campaign_id, ticket_id = tickets["handfirst"]
    assert _staff_status(admin, ticket_id, "resolved").status_code == 200
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["state"] == "open"
    # Later the stop row resolves (the jobs loop saw Meta pause it): the ticket stays resolved by the team.
    assert studio_stop.resolve_stop_request(campaign_id, "meta_paused", THURSDAY_OPEN) is True
    stored = _row(SUPPORT_TICKETS_TYPE, ticket_id)["data"]
    assert stored["status"] == "resolved" and stored["resolvedBy"] == "team"

    before = _counts()
    replied = client.post(f"/api/studio/tickets/{ticket_id}/messages",
                          json={"text": "Thanks!", "operationId": f"reply-{secrets.token_hex(5)}"}, cookies=owner["cookies"])
    assert replied.status_code == 200, replied.text
    view = replied.json()["ticket"]
    assert view["status"] == "open" and view["priority"] == "normal" and view["kind"] == "question"
    stored = _row(SUPPORT_TICKETS_TYPE, ticket_id)["data"]
    assert stored["dueAt"] == iso(target_due_at("ticket", THURSDAY_OPEN, settings))  # the plain ticket target
    after = _counts()
    assert after["open"] == before["open"] + 1
    assert after["stopOpen"] == before["stopOpen"] and after["urgent"] == before["urgent"]  # no phantom stop ticket

    # The system resolves the row and ticket, the team reopens it and resolves it again by hand.
    campaign_id, ticket_id = tickets["teamagain"]
    assert studio_stop.resolve_stop_request(campaign_id, "stopped", THURSDAY_OPEN) is True
    assert _staff_status(admin, ticket_id, "open").status_code == 200
    assert _staff_status(admin, ticket_id, "resolved").status_code == 200
    assert _row(SUPPORT_TICKETS_TYPE, ticket_id)["data"]["resolvedBy"] == "team"
    before = _counts()
    reopened = client.post(f"/api/studio/tickets/{ticket_id}/reopen",
                           json={"operationId": f"reopen-{secrets.token_hex(5)}"}, cookies=owner["cookies"])
    assert reopened.status_code == 200, reopened.text
    view = reopened.json()["ticket"]
    assert view["status"] == "open" and view["priority"] == "normal" and view["kind"] == "question"
    assert _counts()["stopOpen"] == before["stopOpen"]


# ------------------------------------------------------------------ n24: no stop request for an ad that already ended


def test_n24_stop_request_refused_for_an_ad_whose_delivery_ended(people):
    _services_on()
    owner = people["owner"]
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    ended_id, running_id = "120200000077001", "120200000077002"
    ended = _campaign(owner["id"], "ended", metaCampaignId=ended_id, metaAdAccountId="act_123456",
                      startDate=(now - timedelta(days=9)).date().isoformat(), endDate=(now - timedelta(days=2)).date().isoformat())
    with db_conn() as conn:
        write_results_row(conn, ended, owner["id"], {
            "metaCampaignId": ended_id, "metaAdAccountId": "act_123456", "adStatusCounts": {"PAUSED": 1},
            "lastSyncedAt": _stamp(now - timedelta(minutes=10)), "deliveryEndedAt": _stamp(yesterday),
            "settleReadDueAt": _stamp(yesterday + timedelta(hours=48)),
        })
    refused = _ask(owner, ended)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == REFUSE_STOP_ALREADY_ENDED
    assert _row(STOP_TYPE, stop_row_id(ended)) is None
    assert not _row(CAMPAIGNS, ended)["data"].get("stopRequestedAt")
    with db_conn() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND created_by = :uid"),
                             {"t": SUPPORT_TICKETS_TYPE, "uid": owner["id"]}).scalar()
    assert count == 0  # no urgent ticket, no channel alert

    # Control: an ad still delivering (stage 8, even past its end date) can still be asked to stop.
    running = _campaign(owner["id"], "running", metaCampaignId=running_id, metaAdAccountId="act_123456",
                        endDate=(now - timedelta(days=2)).date().isoformat())
    with db_conn() as conn:
        write_results_row(conn, running, owner["id"], {
            "metaCampaignId": running_id, "metaAdAccountId": "act_123456", "adStatusCounts": {"ACTIVE": 1},
            "lastSyncedAt": _stamp(now - timedelta(minutes=10)),
        })
    accepted = _ask(owner, running)
    assert accepted.status_code == 200, accepted.text
    assert _row(STOP_TYPE, stop_row_id(running))["data"]["deliveringAtRequest"] is True


@pytest.mark.parametrize("marker", [{"publishStatus": "live"}, {"metaCampaignId": "launched-by-hand"}, {}])
def test_n24_unlinked_ad_past_its_end_date_can_still_be_asked_to_stop(people, marker):
    """Review r1 follow-up: an unlinked Approved ad past its end date is display stage 10 without any Meta
    reading (a hand-launched legacy ad may still be running in Meta; a never-linked one is a full return).
    The refusal needs a Meta reading, so these stay askable, as the classic card still offers."""
    _services_on()
    owner = people["owner"]
    now = datetime.now(timezone.utc)
    campaign_id = _campaign(owner["id"], "unlinked", startDate=(now - timedelta(days=9)).date().isoformat(),
                            endDate=(now - timedelta(days=2)).date().isoformat(), **marker)
    asked = _ask(owner, campaign_id)
    assert asked.status_code == 200, asked.text
    ticket = _row(SUPPORT_TICKETS_TYPE, asked.json()["ticket"]["id"])["data"]
    assert ticket["kind"] == "stop_request" and ticket["priority"] == "urgent"
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["state"] == "open"
    assert _row(CAMPAIGNS, campaign_id)["data"].get("stopRequestedAt")


# ------------------------------------------------------------------ n26: "Your ad has ended" is never born read


def test_n26_ad_ended_item_is_unread_when_the_end_is_noticed_after_the_seen_marker(people):
    owner = people["owner"]
    t0 = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(microsecond=0)  # Meta's end time
    meta_id = "120200000077003"
    campaign_id = _campaign(owner["id"], "inbox", metaCampaignId=meta_id, metaAdAccountId="act_123456",
                            endDate=(t0 + timedelta(days=3)).date().isoformat())
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner["id"], {
            "metaCampaignId": meta_id, "metaAdAccountId": "act_123456", "adStatusCounts": {"ACTIVE": 1},
            "lastSyncedAt": _stamp(t0 - timedelta(minutes=15)),
        })
        # A ticket answer lands at T0+5 and the owner taps "Mark all seen" before the next results sync.
        record_activity(conn, owner_id=owner["id"], kind="ticket_answered", related_type="ticket",
                        related_id="tkt_" + "b" * 40, key=f"answer-{TAG}", at=t0 + timedelta(minutes=5),
                        params={"number": "T-000001"})
    seen = client.post("/api/studio/activity/seen", json={"upTo": _stamp(t0 + timedelta(minutes=5))}, cookies=owner["cookies"])
    assert seen.status_code == 200, seen.text

    # The sync at T0+10 sees Meta's ad set end time (T0) passed: deliveryEndedAt = T0.
    read = {"campaignId": meta_id, "accountId": "123456", "name": "B2 ad", "status": "ACTIVE", "effectiveStatus": "ACTIVE",
            "startTime": "", "stopTime": "", "adStatusCounts": {"ACTIVE": 1}, "adsTotal": 1, "anyAdDelivering": False,
            "adsetEndTime": _stamp(t0), "reviewFeedback": "", "insightsState": "unavailable", "spendMinor": None,
            "currency": "", "impressions": None, "reach": None, "clicks": None, "resultType": "", "resultCount": None}
    noticed = t0 + timedelta(minutes=10)
    with db_conn() as conn:
        request = load_request(conn, campaign_id)
        previous, _version = load_results_row(conn, campaign_id)
    settings = studio_settings.read_all_settings()
    fields, _facts = fields_after_read(previous, request, read, noticed, settings)
    assert datetime.fromisoformat(fields["deliveryEndedAt"].replace("Z", "+00:00")) == t0  # Meta's end, older than the marker
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner["id"], fields)

    feed = client.get("/api/studio/activity", cookies=owner["cookies"])
    assert feed.status_code == 200, feed.text
    items = [item for item in feed.json()["items"] if item["kind"] == "ad_ended" and item["relatedId"] == campaign_id]
    assert len(items) == 1
    assert items[0]["unread"] is True  # before the fix: its time was T0, below the marker T0+5
    assert feed.json()["unreadCount"] >= 1

    # The next sync keeps the first noticed time (the item does not jump forward and pop up again).
    with db_conn() as conn:
        again_previous, _version = load_results_row(conn, campaign_id)
    later, _facts = fields_after_read(again_previous, request, read, noticed + timedelta(minutes=15), settings)
    assert later["deliveryEndedNoticedAt"] == again_previous["deliveryEndedNoticedAt"]
    # An end stamped before the field existed gets none: its item keeps the end time, as before.
    legacy = {**again_previous, "deliveryEndedNoticedAt": None}
    old, _facts = fields_after_read(legacy, request, read, noticed + timedelta(minutes=15), settings)
    assert old["deliveryEndedNoticedAt"] is None
