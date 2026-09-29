"""Review loop round 8, batch D (the staff desk): the server half. Every test here failed before its fix.

* n6: the desk's Tickets badge counts an open stop request whose urgent ticket the team resolved by hand
  (``openTickets + stopRequests - stopTicketsOpen``: the stop row stays open until the ad is stopped, or Meta
  shows an ad that was delivering paused), but the staff ``active`` ticket list left every resolved ticket
  out, so the badge pointed at an empty list. The staff ``active`` list now keeps the ticket of a stop
  request still open (pinned with the urgent work, marked ``stopOpen``), and lets it go once the stop
  request is resolved. The customer's own list and the other filters are unchanged.

Every test builds its own users (unique e-mails per run) and removes every row they own afterwards (the
tickets and stop rows too), so no open ticket or stop request outlives it.
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_settings, studio_stop, studio_support

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR8DPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl8d_user")
    email = f"review-loop-r8-d-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R8 D {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
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
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "admin": _insert_user("admin", "Admin", {}),
    }


@pytest.fixture(autouse=True)
def _isolated(people, monkeypatch):
    """Settings rows put back exactly, every row of this module's users removed (tickets and stop rows
    too), the help desk's rate limits off and the others reset."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    monkeypatch.setattr(studio_support, "check_rate_limit", lambda *a, **k: (True, 1, 0))
    for uid in _USERS:
        for bucket in ("ad-studio:mutations", "studio:staff-pulse"):
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
    studio_stop.reset_pulse_cache()


def _setting(key: str, **fields) -> None:
    record = studio_settings.read_setting(key)
    studio_settings.save_setting(key, fields, record["version"], "", "2026-09-25T00:00:00Z", audit=lambda *args: None)


def _campaign(owner_id: str, label: str, **data) -> str:
    campaign_id = f"rl8d_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"R8 D ad {label}", "status": "Approved", "creativeImages": ["data:image/png;base64,AAAA"],
            "studioRef": "ALB-S-ABCDEFGH", **data}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    return campaign_id


def _active(user: dict) -> list[dict]:
    response = client.get("/api/studio/staff/tickets", params={"status": "active"}, cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["tickets"]


def _badge(user: dict) -> int:
    pulse = client.get("/api/studio/staff/pulse", cookies=user["cookies"])
    assert pulse.status_code == 200, pulse.text
    body = pulse.json()
    return body["openTickets"] + body["stopRequests"] - body["stopTicketsOpen"]


def test_n6_active_list_keeps_a_hand_resolved_stop_ticket_while_its_stop_request_is_open(people):
    owner, reviewer, admin = people["owner"], people["reviewer"], people["admin"]
    _setting("rollout", services={"help": "on", "stopRequest": "on", "tiktok": "off"})
    badge_before = _badge(admin)
    # A linked ad still in Meta review (no Meta read: not delivering when the stop was asked), so the stop row
    # stays open until the team stops the ad.
    campaign_id = _campaign(owner["id"], "review", metaCampaignId="120200000000881", metaAdAccountId="9876543210")
    asked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                        json={"operationId": f"stop-{secrets.token_hex(6)}"}, cookies=owner["cookies"])
    assert asked.status_code == 200, asked.text
    ticket_id = asked.json()["ticket"]["id"]
    # The team paused it in Meta and resolved the urgent ticket by hand.
    resolved = client.post(f"/api/studio/staff/tickets/{ticket_id}/status",
                           json={"status": "resolved", "operationId": f"status-{secrets.token_hex(6)}"}, cookies=admin["cookies"])
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["ticket"]["status"] == "resolved"
    assert studio_stop.check_stop_requests()["resolved"] == []  # nothing Meta showed: the stop request stays open
    assert _badge(admin) == badge_before + 1  # the desk badge still counts it ...

    for user in (admin, reviewer):  # ... and the list the badge leads to shows it, pinned with the urgent work
        listed = _active(user)
        held = [item for item in listed if item["id"] == ticket_id]
        assert len(held) == 1, (user["email"], [item["id"] for item in listed])
        assert held[0]["status"] == "resolved" and held[0]["stopOpen"] is True and held[0]["kind"] == "stop_request"
        assert listed[0]["id"] == ticket_id or listed[0]["priority"] == "urgent"
    # The other filters are unchanged: the resolved list still has it, the customer's own active list does not.
    resolved_list = client.get("/api/studio/staff/tickets", params={"status": "resolved"}, cookies=admin["cookies"]).json()["tickets"]
    assert ticket_id in [item["id"] for item in resolved_list]
    own = client.get("/api/studio/tickets", params={"status": "active"}, cookies=owner["cookies"])
    assert own.status_code == 200, own.text
    assert ticket_id not in [item["id"] for item in own.json()["tickets"]]
    assert all("stopOpen" not in item for item in own.json()["tickets"])

    # Once the ad is stopped the stop request is resolved: the ticket leaves the active list, and the badge.
    assert studio_stop.resolve_stop_request(campaign_id, "stopped") is True
    assert ticket_id not in [item["id"] for item in _active(admin)]
    assert _badge(admin) == badge_before


def test_n6_open_and_answered_tickets_keep_their_place(people):
    """A stop request whose ticket is still open is listed once (not twice through the stop-request rule),
    marked stopOpen; a plain resolved ticket stays out of the active list."""
    owner, admin = people["owner"], people["admin"]
    _setting("rollout", services={"help": "on", "stopRequest": "on", "tiktok": "off"})
    campaign_id = _campaign(owner["id"], "open")
    asked = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                        json={"operationId": f"stop-{secrets.token_hex(6)}"}, cookies=owner["cookies"])
    assert asked.status_code == 200, asked.text
    ticket_id = asked.json()["ticket"]["id"]
    plain = client.post("/api/studio/tickets", json={
        "subject": "A plain question", "category": "other", "message": "Where is my receipt?",
        "operationId": f"ticket-{secrets.token_hex(6)}"}, cookies=owner["cookies"])
    assert plain.status_code == 200, plain.text
    plain_id = plain.json()["ticket"]["id"]
    closed = client.post(f"/api/studio/staff/tickets/{plain_id}/status",
                         json={"status": "resolved", "operationId": f"status-{secrets.token_hex(6)}"}, cookies=admin["cookies"])
    assert closed.status_code == 200, closed.text
    listed = _active(admin)
    ids = [item["id"] for item in listed]
    assert ids.count(ticket_id) == 1 and plain_id not in ids
    stop_view = next(item for item in listed if item["id"] == ticket_id)
    assert stop_view["status"] == "open" and stop_view["stopOpen"] is True
    assert studio_stop.resolve_stop_request(campaign_id, "stopped") is True
