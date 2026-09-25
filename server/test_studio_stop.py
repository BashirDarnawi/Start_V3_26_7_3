"""Albayan Studio urgent stop requests, the staff pulse, the staff contact link and the team desk switch
(plan tasks P3-10, P3-11, P3-17, P3-20; PLAN.md §5.5 J5, §7.3, §7.5, §12.2).

* ``POST /api/ad-studio/campaigns/{id}/stop-request``: owner only, Approved only, one urgent ticket per
  ad (a repeat answers the same ticket), the request's ``stopRequestedAt``, the staff queue row, the
  owner's inbox item and the audit entry in one transaction; ``afterHours`` and the on-duty line.
* The queue resolves itself (and its ticket) when the ad is Stopped, or when Meta shows an ad that was
  delivering at the request paused or ended in a read since the request (never while it is in Meta
  review, never for an ad that never delivered); a late one raises ``stop_request_overdue``.
* A help-desk refusal met by the stop request keeps the /api/ad-studio plain-text shape.
* ``GET /api/studio/staff/pulse`` (counts only; payments for admins only) and ``GET
  /api/studio/staff/customers/{id}/contact`` (WhatsApp only with consent, audited).
* ``staffDesk`` cannot be hidden (off, or pilot with an empty allowlist) while unresolved tickets or
  open stop requests exist, counted exactly as the pulse and the desk lists count them; services and
  the desk never depend on the customer layout.

Every test creates its own users (unique e-mails per run) and removes every row they own afterwards,
so no open stop request outlives its test (the desk switch tests of other modules count them).
"""

import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES, studio_jobs, studio_settings, studio_stop
from server.systems.ads_studio.social_studio import SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_activity import ACTIVITY_TYPE, activity_id
from server.systems.ads_studio.studio_jobs import ALERTS_TYPE, alert_id
from server.systems.ads_studio.studio_profile import profile_id
from server.systems.ads_studio.studio_results import load_request, load_results_row, write_results_row
from server.systems.ads_studio.studio_results_sync import fields_after_read
from server.systems.ads_studio.studio_stop import (
    REFUSE_RECORD_CHANGED,
    REFUSE_STOP_OPERATION_USED,
    REFUSE_STOP_REQUEST_OFF,
    REFUSE_STOP_TICKET,
    STOP_TYPE,
    TICKETS_TYPE,
    check_stop_requests,
    classic_refusal,
    load_ticket,
    stop_row_id,
    working_due_at,
)
from server.systems.ads_studio.studio_types import STUDIO_PROFILES_TYPE, SUPPORT_TICKET_MESSAGES_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "StudioStopPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
REVIEWER_PERMISSIONS = {CAMPAIGNS: ["view", "review"]}
THURSDAY_OPEN = datetime(2026, 9, 24, 8, 30, tzinfo=timezone.utc)  # Thu 10:30 in Tripoli: working hours
FRIDAY = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)  # Fri 12:00 in Tripoli: closed
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("stop_user")
    email = f"studio-stop-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Stop {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
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
        "other": _insert_user("other", "Employee", CUSTOMER_PERMISSIONS),
        "reviewer": _insert_user("reviewer", "Employee", REVIEWER_PERMISSIONS),
        "admin": _insert_user("admin", "Admin", {}),
    }


def _clean_rows() -> None:
    with db_conn() as conn:
        for chunk in (_USERS[i:i + 50] for i in range(0, len(_USERS), 50)):
            params = {f"u{i}": uid for i, uid in enumerate(chunk)}
            names = ", ".join(f":u{i}" for i in range(len(chunk)))
            conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names})"), params)


@pytest.fixture(autouse=True)
def _isolated(people):
    """Settings rows put back exactly, every row of this module's users removed, rate limits reset."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    for uid in _USERS:
        for bucket in ("ad-studio:mutations", "studio:staff-pulse", "studio:staff-contact", "studio:settings"):
            reset_rate_limit(f"{bucket}:{uid}")
    studio_stop.reset_pulse_cache()
    yield
    _clean_rows()
    with db_conn() as conn:
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


def _services_on(**extra) -> None:
    _setting("rollout", services={"help": "on", "stopRequest": "on", "tiktok": "off"}, **extra)


def _campaign(owner_id: str, label: str, status: str = "Approved", **data) -> str:
    campaign_id = f"stop_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"Summer <b>sale</b> {label}", "status": status, "creativeImages": ["data:image/png;base64,AAAA"],
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
            text("SELECT id, data_json, created_by, created_at, last_modified FROM entities WHERE type = :t AND id = :id"),
            {"t": row_type, "id": row_id},
        ).mappings().first()
    return None if row is None else {**dict(row), "data": json_loads(row["data_json"])}


def _ask(user: dict, campaign_id: str, op: str | None = None, **body):
    payload = {"operationId": op or f"stop-{secrets.token_hex(6)}", **body}
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request", json=payload, cookies=user["cookies"])


def _audits(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, action, metadata_json FROM audit_logs WHERE resource_id = :id AND action = :action"),
            {"id": resource_id, "action": action},
        ).mappings().all()
    return [dict(row) for row in rows]


def _fix_clock(monkeypatch, moment: datetime) -> None:
    monkeypatch.setattr(studio_stop, "utc_now", lambda: moment)


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _results(campaign_id: str, owner_id: str, **fields) -> None:
    """A Meta reading as the results sync would store it (merged over the stored row)."""
    with db_conn() as conn:
        write_results_row(conn, campaign_id, owner_id, fields)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code, detail
    return detail


# ------------------------------------------------------------------ types and the working-time rule


def test_stop_types_are_owned_and_router_only(people):
    for row_type in (STOP_TYPE, TICKETS_TYPE, SUPPORT_TICKET_MESSAGES_TYPE):
        assert row_type in OWNED_TYPES and row_type in SOCIAL_STUDIO_COLLECTIONS
        assert client.get(f"/api/collections/{row_type}", cookies=people["owner"]["cookies"]).status_code == 404
    created = client.post(f"/api/collections/{STOP_TYPE}", json={"id": "ssr_x", "data": {"state": "resolved"}},
                          cookies=people["owner"]["cookies"])
    assert created.status_code == 404, created.text
    assert stop_row_id("cmp_1") == stop_row_id("cmp_1") and stop_row_id("cmp_1").startswith("ssr_")


def test_stop_due_time_counts_working_minutes_only():
    hours = studio_settings.default_value("hours")
    thursday_late = datetime(2026, 9, 24, 14, 30, tzinfo=timezone.utc)  # Thu 16:30 Tripoli: 30 minutes left today
    assert working_due_at(thursday_late, 120, hours) == datetime(2026, 9, 27, 8, 30, tzinfo=timezone.utc)  # Sun 10:30
    assert working_due_at(FRIDAY, 120, hours) == datetime(2026, 9, 27, 9, 0, tzinfo=timezone.utc)  # Sun 11:00
    assert working_due_at(THURSDAY_OPEN, 120, hours) == datetime(2026, 9, 24, 10, 30, tzinfo=timezone.utc)
    holiday = {**hours, "holidays": [{"date": "2026-09-27", "labelEn": "", "labelAr": ""}]}
    assert working_due_at(thursday_late, 120, holiday) == datetime(2026, 9, 28, 8, 30, tzinfo=timezone.utc)  # Mon
    ramadan = {**hours, "ramadan": {"from": "2026-09-27", "to": "2026-09-30", "open": "10:00", "close": "15:00"}}
    assert working_due_at(thursday_late, 120, ramadan) == datetime(2026, 9, 27, 9, 30, tzinfo=timezone.utc)  # Sun 11:30
    assert working_due_at(FRIDAY, 0, hours) == datetime(2026, 9, 27, 7, 0, tzinfo=timezone.utc)  # the next opening


# ------------------------------------------------------------------ who may ask


def test_stop_request_requires_login_and_same_origin(people):
    campaign_id = _campaign(people["owner"]["id"], "auth")
    client.cookies.clear()
    assert client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request", json={"operationId": "stop-anon-1"}).status_code == 401
    foreign = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request", json={"operationId": "stop-cross-1"},
                          cookies=people["owner"]["cookies"], headers={"Origin": "https://evil.example"})
    assert foreign.status_code == 403, foreign.text
    assert _row(CAMPAIGNS, campaign_id)["data"].get("stopRequestedAt") is None


def test_stop_request_is_for_the_owner_only(people):
    _services_on()
    campaign_id = _campaign(people["owner"]["id"], "owner")
    for someone in ("other", "reviewer", "admin"):
        response = _ask(people[someone], campaign_id)
        assert response.status_code == 404 and response.json()["detail"] == "Campaign request not found", (someone, response.text)
    missing = _ask(people["owner"], f"stop_missing_{TAG}")
    assert missing.status_code == 404
    assert _ask(people["owner"], "bad id!").status_code == 400
    assert _row(CAMPAIGNS, campaign_id)["data"].get("stopRequestedAt") is None


def test_stop_request_follows_the_service_switch_not_the_layout(people, monkeypatch):
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    owner = people["owner"]
    campaign_id = _campaign(owner["id"], "switch")
    off = _ask(owner, campaign_id)
    assert off.status_code == 403 and off.json()["detail"] == REFUSE_STOP_REQUEST_OFF
    _setting("rollout", services={"stopRequest": "pilot"}, uiAllowlist=[people["other"]["id"]])
    assert _ask(owner, campaign_id).status_code == 403  # pilot: only the allowlist
    _setting("rollout", ui="off", uiAllowlist=[owner["id"]])  # the customer layout stays classic (P3-20)
    assert client.get("/api/studio/me", cookies=owner["cookies"]).json()["ui"] == "classic"
    assert _ask(owner, campaign_id).status_code == 200


def test_stop_request_only_for_approved_requests(people):
    _services_on()
    owner = people["owner"]
    for status in ("Draft", "Submitted", "Changes Requested", "Rejected", "Stopped"):
        campaign_id = _campaign(owner["id"], f"status{len(status)}", status=status)
        response = _ask(owner, campaign_id)
        assert response.status_code == 409 and response.json()["detail"] == "Only Approved campaigns can be stopped", status
    approved = _campaign(owner["id"], "note")
    assert _ask(owner, approved, note=["not", "text"]).status_code == 400
    assert _ask(owner, approved, operationId="short").status_code == 400
    assert _row(CAMPAIGNS, approved)["data"].get("stopRequestedAt") is None


# ------------------------------------------------------------------ the request itself


def test_stop_request_writes_ticket_marker_queue_inbox_and_audit(people, monkeypatch):
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    _setting("contact", urgentWhatsapp="+218910000001", phone="+218210000002")
    owner = people["owner"]
    campaign_id = _campaign(owner["id"], "happy")
    response = _ask(owner, campaign_id, "stop-happy-001", note="Please pause <script>it</script> now")
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"ticket", "stopRequestedAt", "afterHours"}  # working hours: no urgent line
    assert body["afterHours"] is False and body["stopRequestedAt"] == "2026-09-24T08:30:00.000Z"
    ticket = body["ticket"]
    assert ticket["id"].startswith("tkt_") and ticket["number"].startswith("T-") and ticket["urgent"] is True
    assert (ticket["category"], ticket["relatedType"], ticket["relatedId"]) == ("ad", "campaign", campaign_id)
    assert ticket["status"] == "open" and ticket["audience"] != "admin" and ticket["dueAt"]
    assert owner["id"] not in json.dumps(ticket)  # no user ids in the answer

    data = _row(CAMPAIGNS, campaign_id)["data"]
    assert data["stopRequestedAt"] == body["stopRequestedAt"] and data["stopRequestTicketId"] == ticket["id"]
    assert data["lastStopRequestOperationId"] == "stop-happy-001" and data["status"] == "Approved"
    queue = _row(STOP_TYPE, stop_row_id(campaign_id))
    assert queue["created_by"] == owner["id"]
    assert queue["data"]["state"] == "open" and queue["data"]["ticketId"] == ticket["id"]
    assert queue["data"]["dueAt"] == "2026-09-24T10:30:00.000Z"  # 120 working minutes (D11 default)
    inbox = _row(ACTIVITY_TYPE, activity_id(owner["id"], "stop_request_received", campaign_id, "stop"))
    assert inbox["created_by"] == owner["id"] and inbox["data"]["params"] == {"number": ticket["number"]}
    audits = _audits(campaign_id, "stop_request")
    assert len(audits) == 1 and audits[0]["user_id"] == owner["id"]
    meta = json.loads(audits[0]["metadata_json"])
    assert meta["ticketId"] == ticket["id"] and meta["withNote"] is True and "Please" not in audits[0]["metadata_json"]
    with db_conn() as conn:
        stored = load_ticket(conn, ticket["id"])
        messages = conn.execute(
            text("SELECT data_json FROM entities WHERE type = :t AND created_by = :uid"),
            {"t": SUPPORT_TICKET_MESSAGES_TYPE, "uid": owner["id"]},
        ).mappings().all()
    assert stored["id"] == ticket["id"]
    assert messages and any("<script>" not in row["data_json"] and "Please pause" in row["data_json"] for row in messages)

    feed = client.get("/api/studio/activity", cookies=owner["cookies"]).json()
    first = feed["items"][0]
    assert first["kind"] == "stop_request_received" and first["relatedId"] == campaign_id and first["unread"] is True
    assert ticket["number"] in first["body"]["en"] and ticket["number"] in first["body"]["ar"]
    summary = client.get("/api/studio/campaigns/summary", cookies=owner["cookies"]).json()
    assert summary[campaign_id]["stopRequested"] is True  # the stage chip reads the marker


def test_stop_request_repeat_returns_the_same_ticket(people, monkeypatch):
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    owner = people["owner"]
    campaign_id = _campaign(owner["id"], "replay")
    first = _ask(owner, campaign_id, "stop-replay-001")
    assert first.status_code == 200, first.text
    again = _ask(owner, campaign_id, "stop-replay-001")
    other_tap = _ask(owner, campaign_id, "stop-replay-002")
    assert again.status_code == other_tap.status_code == 200
    assert again.json()["ticket"]["id"] == other_tap.json()["ticket"]["id"] == first.json()["ticket"]["id"]
    assert again.json()["stopRequestedAt"] == first.json()["stopRequestedAt"]
    with db_conn() as conn:
        tickets = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND created_by = :uid"),
                               {"t": TICKETS_TYPE, "uid": owner["id"]}).scalar()
        inbox = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND created_by = :uid"),
                             {"t": ACTIVITY_TYPE, "uid": owner["id"]}).scalar()
    assert tickets == 1 and inbox == 1
    assert len(_audits(campaign_id, "stop_request")) == 1
    _setting("rollout", services={"stopRequest": "off"})
    assert _ask(owner, campaign_id, "stop-replay-003").status_code == 200  # a lost answer still comes back


def test_stop_request_after_hours_shows_the_on_duty_line(people, monkeypatch):
    _fix_clock(monkeypatch, FRIDAY)
    _services_on()
    owner = people["owner"]
    campaign_id = _campaign(owner["id"], "night")
    no_line = _ask(owner, campaign_id)
    assert no_line.status_code == 200 and no_line.json()["afterHours"] is True
    assert no_line.json()["urgentContact"] == {}  # nothing configured: nothing promised
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["dueAt"] == "2026-09-27T09:00:00.000Z"  # Sun 11:00
    _setting("contact", urgentWhatsapp="+218910000001", phone="+218210000002", whatsapp="+218910000009")
    again = _ask(owner, campaign_id).json()
    assert again["urgentContact"] == {"whatsapp": "+218910000001", "phone": "+218210000002"}
    me = client.get("/api/studio/me", cookies=owner["cookies"]).json()
    assert "urgentWhatsapp" not in json.dumps(me) and "+218910000001" not in json.dumps(me)  # only in this answer


# ------------------------------------------------------------------ the queue resolves itself


def test_stop_resolves_the_stop_request_and_its_ticket(people, monkeypatch):
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    owner, admin = people["owner"], people["admin"]
    campaign_id = _campaign(owner["id"], "staffstop")
    ticket = _ask(owner, campaign_id).json()["ticket"]
    live = _row(CAMPAIGNS, campaign_id)
    stopped = client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/stop",
        json={"expectedLastModified": live["last_modified"], "operationId": "stop-staff-001", "closeReason": "customer_stop"},
        cookies=admin["cookies"],
    )
    assert stopped.status_code == 200, stopped.text
    queue = _row(STOP_TYPE, stop_row_id(campaign_id))["data"]
    assert queue["state"] == "resolved" and queue["resolvedReason"] == "stopped"
    with db_conn() as conn:
        assert load_ticket(conn, ticket["id"])["status"] == "resolved"
    settled = _row(ACTIVITY_TYPE, activity_id(owner["id"], "settled", campaign_id, "settled"))
    assert settled is not None and settled["data"]["params"] == {"refundMinor": 0}
    assert check_stop_requests(THURSDAY_OPEN + timedelta(days=3))["resolved"] == []  # nothing left to do
    replay = _ask(owner, campaign_id)
    assert replay.status_code == 200 and replay.json()["ticket"]["status"] == "resolved"


def test_meta_handles_a_stop_request_only_after_delivery_and_late_requests_alert(people, monkeypatch):
    """Meta handled a stop request only when an ad that WAS delivering at the request shows paused (or
    ended by a Meta end time) in a read made since the request. An ad in Meta review, one that never
    delivered, or a pause read before the request stays open and goes overdue like any other."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    owner = people["owner"]
    _services_on()
    before_ask, after_ask = THURSDAY_OPEN - timedelta(minutes=10), THURSDAY_OPEN + timedelta(minutes=15)
    meta_ids = {label: f"1202000000{n:05d}" for n, label in enumerate(("paused", "ended", "review", "early", "never"))}
    ads = {label: _campaign(owner["id"], label, metaCampaignId=meta_id) for label, meta_id in meta_ids.items()}
    late = _campaign(owner["id"], "late")  # never linked: no Meta reading at all
    for label in ("paused", "ended", "review", "early"):
        _results(ads[label], owner["id"], metaCampaignId=meta_ids[label], adStatusCounts={"ACTIVE": 1}, lastSyncedAt=_stamp(before_ask))
    _results(ads["never"], owner["id"], metaCampaignId=meta_ids["never"], adStatusCounts={"PENDING_REVIEW": 1}, lastSyncedAt=_stamp(before_ask))
    everything = {**ads, "late": late}
    asked = {label: _ask(owner, cid).json() for label, cid in everything.items()}
    queue = {label: _row(STOP_TYPE, stop_row_id(cid))["data"] for label, cid in everything.items()}
    assert [queue[label]["deliveringAtRequest"] for label in ("paused", "ended", "review", "early", "never", "late")] == [
        True, True, True, True, False, False]
    # What Meta shows after the request (the sync's p90 metric stopEffectiveAt is stamped on every one).
    _results(ads["paused"], owner["id"], adStatusCounts={"PAUSED": 1}, campaignEffectiveStatus="PAUSED",
             stopEffectiveAt=_stamp(after_ask), lastSyncedAt=_stamp(after_ask))
    _results(ads["ended"], owner["id"], adStatusCounts={"ACTIVE": 1}, adsetEndTime=_stamp(after_ask),  # Meta's end time passed
             stopEffectiveAt=_stamp(after_ask), lastSyncedAt=_stamp(after_ask))
    _results(ads["review"], owner["id"], adStatusCounts={"PENDING_REVIEW": 1}, stopEffectiveAt=_stamp(after_ask),
             lastSyncedAt=_stamp(after_ask))
    _results(ads["early"], owner["id"], adStatusCounts={"PAUSED": 1}, campaignEffectiveStatus="PAUSED",
             stopEffectiveAt=_stamp(before_ask), lastSyncedAt=_stamp(before_ask))  # no read since the request
    _results(ads["never"], owner["id"], adStatusCounts={"PAUSED": 1}, campaignEffectiveStatus="PAUSED",
             stopEffectiveAt=_stamp(after_ask), lastSyncedAt=_stamp(after_ask))
    due = datetime.fromisoformat(queue["late"]["dueAt"].replace("Z", "+00:00"))
    assert due == THURSDAY_OPEN + timedelta(hours=2)  # 120 working minutes (D11 default)
    before = check_stop_requests(due - timedelta(minutes=1))
    assert set(before["resolved"]) == {ads["paused"], ads["ended"]} and before["overdue"] == []
    for label in ("paused", "ended"):
        assert _row(STOP_TYPE, stop_row_id(ads[label]))["data"]["resolvedReason"] == "meta_paused"
        with db_conn() as conn:
            assert load_ticket(conn, asked[label]["ticket"]["id"])["status"] == "resolved"
    for label in ("review", "early", "never", "late"):
        assert _row(STOP_TYPE, stop_row_id(everything[label]))["data"]["state"] == "open", label
        with db_conn() as conn:
            assert load_ticket(conn, asked[label]["ticket"]["id"])["status"] == "open", label
    after = check_stop_requests(due + timedelta(minutes=1))
    assert set(after["overdue"]) == {ads["review"], ads["early"], ads["never"], late} and after["resolved"] == []
    day = studio_jobs.libya_today(due + timedelta(minutes=1)).isoformat()
    alert = _row(ALERTS_TYPE, alert_id("stop_request_overdue", late, day))
    assert alert is not None and alert["created_by"] == owner["id"] and alert["data"]["kind"] == "stop_request_overdue"
    assert owner["email"] not in alert["data_json"] and "Summer" not in alert["data_json"]  # no personal data
    assert _row(ALERTS_TYPE, alert_id("stop_request_overdue", ads["review"], day)) is not None
    check_stop_requests(due + timedelta(minutes=6))
    with db_conn() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND id = :id"),
                             {"t": ALERTS_TYPE, "id": alert_id("stop_request_overdue", late, day)}).scalar()
    assert count == 1  # one alert per ad and day
    assert set(studio_jobs.ALERT_LABELS["stop_request_overdue"]) == {"en", "ar"}
    # Meta approves the reviewed ad later and it runs: still not handled (staff stop it with /stop).
    _results(ads["review"], owner["id"], adStatusCounts={"ACTIVE": 1}, lastSyncedAt=_stamp(due + timedelta(hours=1)))
    assert check_stop_requests(due + timedelta(hours=2))["resolved"] == []


def test_sync_metric_stamp_never_handles_a_stop_request(people, monkeypatch):
    """The results sync still stamps ``stopEffectiveAt`` (the p90 metric, PLAN.md §7.1) on the first read
    after the request that shows nothing delivering, a PENDING_REVIEW read too; the jobs check leaves
    that queue row open."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    owner = people["owner"]
    _services_on()
    meta_id = "120200000009001"
    campaign_id = _campaign(owner["id"], "metric", metaCampaignId=meta_id, metaAdAccountId="act_123456")
    _results(campaign_id, owner["id"], metaCampaignId=meta_id, metaAdAccountId="act_123456", adStatusCounts={"ACTIVE": 1},
             lastSyncedAt=_stamp(THURSDAY_OPEN - timedelta(minutes=10)))
    assert _ask(owner, campaign_id).status_code == 200
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["deliveringAtRequest"] is True
    read = {"campaignId": meta_id, "accountId": "123456", "name": "Summer sale", "status": "ACTIVE", "effectiveStatus": "ACTIVE",
            "startTime": "", "stopTime": "", "adStatusCounts": {"PENDING_REVIEW": 1}, "adsTotal": 1, "anyAdDelivering": False,
            "adsetEndTime": "", "reviewFeedback": "", "insightsState": "unavailable", "spendMinor": None, "currency": "",
            "impressions": None, "reach": None, "clicks": None, "resultType": "", "resultCount": None}
    later = THURSDAY_OPEN + timedelta(minutes=15)
    with db_conn() as conn:
        request = load_request(conn, campaign_id)
        previous, _version = load_results_row(conn, campaign_id)
    fields, _facts = fields_after_read(previous, request, read, later, studio_settings.read_all_settings())
    assert datetime.fromisoformat(fields["stopEffectiveAt"].replace("Z", "+00:00")) == later  # the metric is stamped
    _results(campaign_id, owner["id"], **fields)
    checked = check_stop_requests(later + timedelta(minutes=5))
    assert checked["resolved"] == [] and checked["open"] == 1
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["data"]["state"] == "open"


def test_stop_request_help_desk_refusals_keep_the_classic_shape(people, monkeypatch):
    """A refusal raised by the help desk while the stop ticket is opened (an operationId the customer
    already used for another ticket) answers a plain text like every /api/ad-studio route, never the
    /api/studio {code, message} dict, and records nothing."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    _services_on()
    owner = people["owner"]
    campaign_id = _campaign(owner["id"], "classic")
    operation = f"stop-shared-{TAG}"
    ticket = client.post("/api/studio/tickets", cookies=owner["cookies"],
                         json={"subject": "A question about my ad", "category": "ad", "message": "Hello?", "operationId": operation})
    assert ticket.status_code == 200, ticket.text
    refused = _ask(owner, campaign_id, operation)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == REFUSE_STOP_OPERATION_USED  # a string, not {code, message}
    assert _row(CAMPAIGNS, campaign_id)["data"].get("stopRequestedAt") is None and _row(STOP_TYPE, stop_row_id(campaign_id)) is None
    assert _ask(owner, campaign_id).status_code == 200  # a fresh operationId records it
    conflict = classic_refusal(HTTPException(409, {"code": "VERSION_CONFLICT", "message": "x"}))
    assert (conflict.status_code, conflict.detail) == (409, REFUSE_RECORD_CHANGED)
    assert classic_refusal(HTTPException(409, {"code": "TICKET_OPEN_LIMIT", "message": "x"})).detail == REFUSE_STOP_TICKET
    plain = HTTPException(404, "Campaign request not found")
    assert classic_refusal(plain) is plain
    for prefix in (REFUSE_STOP_OPERATION_USED, REFUSE_RECORD_CHANGED, REFUSE_STOP_TICKET):
        assert isinstance(prefix, str) and prefix and "{" not in prefix


def test_jobs_tick_runs_the_stop_check_on_the_waiting_turn(people, monkeypatch):
    seen: list[datetime] = []
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: {"waiting": 0})
    monkeypatch.setattr(studio_stop, "check_stop_requests", lambda now: seen.append(now) or {"open": 0})
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'studioJobState'"))
    moment = datetime(2031, 3, 3, 0, 0, tzinfo=timezone.utc)
    ran = studio_jobs.run_tick(lambda: {}, moment)
    assert "waiting" in ran["claimed"] and ran["stop_requests"] == {"open": 0} and seen == [moment]
    assert "stop_requests" not in studio_jobs.run_tick(lambda: {}, moment + timedelta(seconds=30))


# ------------------------------------------------------------------ staff pulse (P3-17)


def _ticket_row(owner_id: str, label: str, status: str, audience: str) -> str:
    ticket_id = f"tkt_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    data = {"id": ticket_id, "status": status, "audience": audience, "category": "payment" if audience == "admin" else "ad",
            "number": f"T-{secrets.randbelow(10**6):06d}", "ownerId": owner_id}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:t,:id,:data,false,:stamp,:owner,:stamp)"),
            {"t": TICKETS_TYPE, "id": ticket_id, "data": json_dumps(data), "stamp": stamp, "owner": owner_id},
        )
    return ticket_id


def _pulse(user: dict):
    return client.get("/api/studio/staff/pulse", cookies=user["cookies"])


def test_staff_pulse_counts_by_audience(people):
    owner, reviewer, admin = people["owner"], people["reviewer"], people["admin"]
    _error(_pulse(owner), 403, "STAFF_ONLY")
    client.cookies.clear()
    assert client.get("/api/studio/staff/pulse").status_code == 401
    base_reviewer, base_admin = _pulse(reviewer).json(), _pulse(admin).json()
    assert "paymentsWaiting" not in base_reviewer and isinstance(base_admin["paymentsWaiting"], int)
    assert set(base_admin) == {"waitingReview", "stopRequests", "openTickets", "paymentsWaiting", "alerts", "updatedAt"}

    _services_on()
    _campaign(owner["id"], "waiting1", status="Submitted")
    _campaign(owner["id"], "waiting2", status="Submitted")
    _campaign(reviewer["id"], "ownwait", status="Submitted")  # a reviewer's own request is not theirs to review
    _campaign(admin["id"], "adminwait", status="Submitted")  # an admin may review their own
    _ask(owner, _campaign(owner["id"], "pulsestop"))  # one stop request + its (staff) ticket
    _ticket_row(owner["id"], "team", "open", "staff")
    _ticket_row(owner["id"], "money", "open", "admin")
    _ticket_row(owner["id"], "answered", "answered", "staff")
    with db_conn() as conn:
        studio_jobs.raise_alert(conn, "review_overdue", related_type=CAMPAIGNS, related_id=f"pulse_{TAG}", owner_id=owner["id"])
        pay_id = f"pay_{TAG}_{secrets.token_hex(3)}"
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('walletPaymentRequests',:id,:data,false,:stamp,:owner,:stamp)"),
            {"id": pay_id, "data": json_dumps({"status": "pending", "userId": owner["id"], "amountMinor": 500,
                                                "receiptPhoto": "data:image/png;base64," + "A" * 200}),
             "stamp": now_ms(), "owner": owner["id"]},
        )
    studio_stop.reset_pulse_cache()
    as_reviewer, as_admin = _pulse(reviewer).json(), _pulse(admin).json()
    assert as_reviewer["waitingReview"] - base_reviewer["waitingReview"] == 3
    assert as_admin["waitingReview"] - base_admin["waitingReview"] == 4
    assert as_reviewer["stopRequests"] - base_reviewer["stopRequests"] == 1
    assert as_reviewer["openTickets"] - base_reviewer["openTickets"] == 2  # the stop ticket + the team ticket
    assert as_admin["openTickets"] - base_admin["openTickets"] == 3  # + the admin-only payment ticket
    assert as_admin["alerts"] - base_admin["alerts"] == 1
    assert as_admin["paymentsWaiting"] - base_admin["paymentsWaiting"] == 1
    assert all(isinstance(value, int) for key, value in as_admin.items() if key != "updatedAt")  # counts only
    assert owner["id"] not in json.dumps(as_admin) and owner["id"] not in json.dumps(as_reviewer)
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'walletPaymentRequests' AND id = :id"), {"id": pay_id})


# ------------------------------------------------------------------ staff contact link (P3-11)


def _save_number(user: dict, number: str = "0912345678") -> None:
    saved = client.put("/api/studio/profile", json={"whatsappNumber": number, "whatsappConsent": True}, cookies=user["cookies"])
    assert saved.status_code == 200, saved.text
    reset_rate_limit(f"studio:profile-write:{user['id']}")


def _contact(user: dict, customer_id: str, **params):
    return client.get(f"/api/studio/staff/customers/{customer_id}/contact", params=params, cookies=user["cookies"])


def test_contact_link_needs_consent_and_is_audited(people):
    owner, other, reviewer, admin = people["owner"], people["other"], people["reviewer"], people["admin"]
    _error(_contact(owner, other["id"]), 403, "STAFF_ONLY")
    cross = client.get(f"/api/studio/staff/customers/{owner['id']}/contact", cookies=admin["cookies"],
                       headers={"Origin": "https://evil.example"})
    _error(cross, 403, "CROSS_SITE")
    _error(_contact(admin, f"user_missing_{TAG}"), 404, "UNKNOWN_CUSTOMER")
    _error(_contact(admin, owner["id"]), 409, "NO_CONSENT")  # no number saved
    _save_number(owner)
    _error(_contact(reviewer, owner["id"]), 404, "UNKNOWN_CUSTOMER")  # nothing the team can see yet
    approved = _campaign(owner["id"], "contact")
    link = _contact(admin, owner["id"], relatedType="campaign", relatedId=approved)
    assert link.status_code == 200, link.text
    body = link.json()
    assert body["whatsapp"] == "+218912345678" and body["consentAt"]
    assert body["whatsappUrl"].startswith("https://wa.me/218912345678?text=")
    assert "ALB-S-ABCDEFGH" in unquote(body["whatsappUrl"]) and "فريق البيان" in unquote(body["whatsappUrl"])
    assert _contact(reviewer, owner["id"]).status_code == 200  # an Approved request the team handles
    audits = _audits(profile_id(owner["id"]), "contact_link")
    assert len(audits) == 2 and {a["user_id"] for a in audits} == {admin["id"], reviewer["id"]}
    assert all("+218" not in a["metadata_json"] and "912345678" not in a["metadata_json"] for a in audits)

    draft = _campaign(owner["id"], "draft", status="Draft")
    _error(_contact(reviewer, owner["id"], relatedType="campaign", relatedId=draft), 404, "UNKNOWN_CUSTOMER")
    foreign = _campaign(other["id"], "foreign")
    _error(_contact(admin, owner["id"], relatedType="campaign", relatedId=foreign), 404, "UNKNOWN_CUSTOMER")
    money_ticket = _ticket_row(owner["id"], "contactmoney", "open", "admin")
    _error(_contact(reviewer, owner["id"], relatedType="ticket", relatedId=money_ticket), 404, "UNKNOWN_CUSTOMER")
    admin_view = _contact(admin, owner["id"], relatedType="ticket", relatedId=money_ticket)
    assert admin_view.status_code == 200
    _error(_contact(admin, owner["id"], relatedType="page", relatedId=approved), 400, "INVALID_VALUE")
    _error(_contact(admin, owner["id"], relatedType="campaign"), 400, "INVALID_VALUE")
    removed = client.put("/api/studio/profile", json={"whatsappNumber": None}, cookies=owner["cookies"])
    assert removed.status_code == 200
    _error(_contact(admin, owner["id"]), 409, "NO_CONSENT")
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                     {"t": STUDIO_PROFILES_TYPE, "id": profile_id(owner["id"])})


# ------------------------------------------------------------------ the desk switch (P3-20)


def _put_rollout(user: dict, value: dict):
    record = studio_settings.read_setting("rollout")
    body = {"expectedVersion": record["version"], "value": value}
    return client.put("/api/studio/admin/settings/rollout", json=body, cookies=user["cookies"])


def test_staff_desk_cannot_go_off_while_in_use(people, monkeypatch):
    """P3-20: the guard counts exactly what the pulse and the desk lists show (open queue rows, unresolved
    tickets), refuses hiding the desk as pilot with nobody on the allowlist too, and lets a stop request
    Meta handled go (its ad still Approved, waiting for /stop)."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    owner, admin, reviewer = people["owner"], people["admin"], people["reviewer"]
    with db_conn() as conn:
        baseline = studio_stop.staff_desk_in_use(conn)
    assert baseline == {"tickets": 0, "stopRequests": 0}, "an earlier test left an open ticket or stop request"
    assert _put_rollout(admin, {"staffDesk": "on", "services": {"stopRequest": "on"}}).status_code == 200
    campaign_id = _campaign(owner["id"], "desk")
    assert _ask(owner, campaign_id).status_code == 200
    detail = _error(_put_rollout(admin, {"staffDesk": "off"}), 409, "STAFF_DESK_IN_USE")
    assert "1 unresolved ticket" in detail["message"] and "1 open stop" in detail["message"]
    assert studio_settings.read_setting("rollout")["value"]["staffDesk"] == "on"  # nothing saved
    # Hiding the desk as pilot with nobody on the allowlist is the same refusal; a pilot with staff is not.
    _error(_put_rollout(admin, {"staffDesk": "pilot", "staffAllowlist": []}), 409, "STAFF_DESK_IN_USE")
    assert _put_rollout(admin, {"ui": "on", "staffDesk": "pilot", "staffAllowlist": [reviewer["id"]]}).status_code == 200  # other changes still save
    _error(_put_rollout(admin, {"staffDesk": "pilot", "staffAllowlist": []}), 409, "STAFF_DESK_IN_USE")
    assert client.get("/api/studio/me", cookies=reviewer["cookies"]).json()["staffDesk"] == "v2"
    # A request Stopped by hand still has its queue row open: the guard says what the pulse says.
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                     {"d": json_dumps({**_row(CAMPAIGNS, campaign_id)["data"], "status": "Stopped"}),
                      "t": CAMPAIGNS, "id": campaign_id})
    detail = _error(_put_rollout(admin, {"staffDesk": "off"}), 409, "STAFF_DESK_IN_USE")
    pulse = _pulse(admin).json()
    assert "1 unresolved ticket" in detail["message"] and "1 open stop" in detail["message"]
    assert (pulse["stopRequests"], pulse["openTickets"]) == (1, 1)
    assert check_stop_requests()["resolved"] == [campaign_id]  # the jobs loop closes it and its ticket
    with db_conn() as conn:
        assert studio_stop.staff_desk_in_use(conn) == {"tickets": 0, "stopRequests": 0}
    # An answered ticket the customer never closes is still the desk's work (its active list shows it).
    answered = _ticket_row(owner["id"], "answered", "answered", "staff")
    detail = _error(_put_rollout(admin, {"staffDesk": "off"}), 409, "STAFF_DESK_IN_USE")
    assert "1 unresolved ticket" in detail["message"] and "0 open stop" in detail["message"]
    assert _pulse(admin).json()["openTickets"] == 0  # it waits for the customer, not for the team
    active = client.get("/api/studio/staff/tickets", params={"status": "active"}, cookies=admin["cookies"]).json()["tickets"]
    assert [item["id"] for item in active] == [answered]
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                     {"d": json_dumps({**_row(TICKETS_TYPE, answered)["data"], "status": "resolved"}), "t": TICKETS_TYPE, "id": answered})
    # A stop request Meta handled (resolved meta_paused) no longer holds the switch, although its ad is
    # still Approved with its marker set and waits for its settlement through /stop.
    second = _campaign(owner["id"], "metadesk", metaCampaignId="120200000000555")
    _results(second, owner["id"], metaCampaignId="120200000000555", adStatusCounts={"ACTIVE": 1},
             lastSyncedAt=_stamp(THURSDAY_OPEN - timedelta(minutes=5)))
    assert _ask(owner, second).status_code == 200
    _error(_put_rollout(admin, {"staffDesk": "off"}), 409, "STAFF_DESK_IN_USE")
    _results(second, owner["id"], adStatusCounts={"PAUSED": 1}, campaignEffectiveStatus="PAUSED",
             lastSyncedAt=_stamp(THURSDAY_OPEN + timedelta(minutes=15)))
    assert check_stop_requests(THURSDAY_OPEN + timedelta(minutes=20))["resolved"] == [second]
    data = _row(CAMPAIGNS, second)["data"]
    assert data["status"] == "Approved" and data["stopRequestedAt"]
    assert _pulse(admin).json()["stopRequests"] == 0
    assert _put_rollout(admin, {"staffDesk": "off"}).status_code == 200


def test_rollout_off_keeps_services(people, monkeypatch):
    """P3-20: the customer layout off (classic) never hides the services or the staff desk."""
    _fix_clock(monkeypatch, THURSDAY_OPEN)
    owner, reviewer = people["owner"], people["reviewer"]
    _setting("rollout", ui="off", staffDesk="on", services={"help": "on", "stopRequest": "on", "tiktok": "off"})
    me = client.get("/api/studio/me", cookies=owner["cookies"]).json()
    assert me["ui"] == "classic" and me["services"]["stopRequest"] is True and me["services"]["help"] is True
    assert client.get("/api/studio/me", cookies=reviewer["cookies"]).json()["staffDesk"] == "v2"
    before = _pulse(reviewer).json()["stopRequests"]
    campaign_id = _campaign(owner["id"], "classic")
    assert _ask(owner, campaign_id).status_code == 200  # asked from the classic layout
    assert _pulse(reviewer).json()["stopRequests"] == before + 1  # the desk still sees it
    feed = client.get("/api/studio/activity", cookies=owner["cookies"]).json()
    assert feed["items"][0]["kind"] == "stop_request_received"


@pytest.fixture(scope="module", autouse=True)
def _desk_rows_cleanup():
    """Tickets, their messages, stop requests and the ticket counter are this module's own; other modules
    assert an empty desk (P3-20 STAFF_DESK_IN_USE), so they are removed when the module ends."""
    yield
    with db_conn() as conn:
        for row_type in ("supportTickets", "supportTicketMessages", "studioStopRequests", "studioCounters"):
            conn.execute(text("DELETE FROM entities WHERE type = :t"), {"t": row_type})
