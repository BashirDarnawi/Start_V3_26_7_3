"""Albayan Studio TikTok service requests (plan task P5-01; PLAN.md §4.1 M11, §8.4, D14).

* A customer sends a TikTok request (handle, what they want, a note); it is a help ticket of
  category ``tiktok`` (audience staff) that reviewers and admins see in the desk.
* The handle rule (username, ``@username`` or the profile link), the wants rule, replays by
  operationId, at most 3 requests open or in progress per customer.
* The team's steps ``open -> in_progress -> done / declined`` with a bilingual note that lands in
  the thread; a customer cancels an open request by resolving its ticket.
* The texts never call TikTok "connected", "linked", "managed" or "automated" (a static check of
  every TikTok text in studio_support.py).

Every test creates its own users (unique e-mails per run); the TikTok service is switched on per
test through a fixed settings value, and the module removes the desk rows it made at the end.
"""

import ast
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import check_rate_limit as real_check_rate_limit, reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_settings, studio_support
from server.systems.ads_studio.studio_hours import iso, target_due_at
from server.systems.ads_studio.studio_privacy import TICKET_PERSONAL_FIELDS, scrub_studio_personal_data_conn
from server.systems.ads_studio.studio_types import SUPPORT_TICKET_MESSAGES_TYPE, SUPPORT_TICKETS_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "StudioTikTokPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}
SUPPORT_SOURCE = Path(__file__).parent / "systems" / "ads_studio" / "studio_support.py"
# PLAN.md §8.4: a TikTok screen never says the account is connected, linked, managed or automated.
FORBIDDEN_EN = ("connected", "linked", "managed", "manages", "automated")
FORBIDDEN_AR = ("متصل", "مربوط", "يدير", "مؤتمت")
_counter = [0]


def _op(label: str = "op") -> str:
    _counter[0] += 1
    return f"{label}-{TAG}-{_counter[0]:05d}"


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("tiktok_user")
    email = f"studio-tiktok-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"TikTok {label} Person", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
                "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "email": email, "cookies": cookies}


def _settings(tiktok_mode: str = "on") -> dict:
    value = {key: studio_settings.default_value(key) for key in studio_settings.SETTING_KEYS}
    value["rollout"]["services"]["tiktok"] = tiktok_mode
    value["rollout"]["services"]["help"] = "on"
    return value


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()


@pytest.fixture(autouse=True)
def _tiktok_on_and_no_rate_limits(monkeypatch):
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: _settings())
    monkeypatch.setattr(studio_support, "check_rate_limit", lambda *a, **k: (True, 1, 0))


@pytest.fixture(scope="module", autouse=True)
def _desk_rows_cleanup():
    """Tickets, their messages and the ticket counter are this module's own; other modules assert an
    empty desk (P3-20 STAFF_DESK_IN_USE), so they are removed when the module ends."""
    yield
    with db_conn() as conn:
        for row_type in ("supportTickets", "supportTicketMessages", "studioCounters"):
            conn.execute(text("DELETE FROM entities WHERE type = :t"), {"t": row_type})


@pytest.fixture(scope="module")
def staff():
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


def _customer(label: str = "customer") -> dict:
    return _insert_user(label, "Employee", CUSTOMER_PERMISSIONS)


def _send(user: dict, *, handle="@shop.libya", wants="advice", note=None, operation=None, headers=None, **extra):
    body = {"handle": handle, "wants": wants, "operationId": operation or _op("tt"), **extra}
    if note is not None:
        body["note"] = note
    return client.post("/api/studio/tiktok/requests", json=body, cookies=user["cookies"], headers=headers)


def _sent(user: dict, **kwargs) -> dict:
    response = _send(user, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()["request"]


def _step(user: dict, ticket_id: str, state: str, *, en="We started.", ar="بدأنا العمل.", operation=None, note=None, headers=None):
    body = {"status": state, "note": {"en": en, "ar": ar} if note is None else note, "operationId": operation or _op("st")}
    return client.post(f"/api/studio/staff/tiktok/{ticket_id}/status", json=body, cookies=user["cookies"], headers=headers)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code, detail
    return detail


def _row(row_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": SUPPORT_TICKETS_TYPE, "id": row_id}).mappings().first()
    return json_loads(row["data_json"]) if row else {}


def _audits(row_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT action, message, metadata_json FROM audit_logs WHERE resource_type = :type AND resource_id = :id ORDER BY ts"),
            {"type": SUPPORT_TICKETS_TYPE, "id": row_id},
        ).mappings().all()
    return [{"action": r["action"], "message": r["message"], "details": json_loads(r["metadata_json"] or "{}")} for r in rows]


# ------------------------------------------------------------------ sending a request


def test_tiktok_request_is_a_staff_ticket_in_the_desk(staff):
    owner = _customer("desk")
    view = _sent(owner, handle="@Shop.Libya", wants=["advice", "auto_replies_help"], note="Please call me in the morning.")
    assert view["category"] == "tiktok" and view["audience"] == "staff" and view["kind"] == "tiktok_request"
    assert view["priority"] == "normal" and view["status"] == "open" and view["dueAt"]
    assert view["subject"] == "TikTok service · خدمة تيك توك · @Shop.Libya"
    tiktok = view["tiktok"]
    assert tiktok["handle"] == "Shop.Libya" and tiktok["profileUrl"] == "https://www.tiktok.com/@Shop.Libya"
    assert tiktok["wants"] == ["auto_replies_help", "advice"] and tiktok["state"] == "open" and tiktok["note"] is None
    assert tiktok["stateLabels"] == studio_support.TIKTOK_TEXTS["states"]["open"] and tiktok["stateAt"]

    # The customer's lists: the TikTok list and the plain ticket list both carry it.
    mine = client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()
    assert [r["id"] for r in mine["requests"]] == [view["id"]] and mine["openCount"] == 1 and mine["maxOpen"] == 3
    assert mine["service"]["open"] is True and [w["key"] for w in mine["service"]["wants"]] == ["auto_replies_help", "advice"]
    assert "@" not in mine["service"]["labels"]["en"] and mine["service"]["notice"]["ar"]
    tickets = client.get("/api/studio/tickets", cookies=owner["cookies"]).json()["tickets"]
    assert any(t["id"] == view["id"] and t["tiktok"]["handle"] == "Shop.Libya" for t in tickets)
    thread = client.get(f"/api/studio/tickets/{view['id']}", cookies=owner["cookies"]).json()
    assert thread["messages"][0]["text"] == "Please call me in the morning." and thread["messages"][0]["from"] == "customer"

    # Staff (reviewers too: audience staff) see it in the TikTok desk and in the ticket queue.
    for who in ("admin", "reviewer"):
        desk = client.get("/api/studio/staff/tiktok", cookies=staff[who]["cookies"]).json()
        assert any(r["id"] == view["id"] and r["tiktok"]["handle"] == "Shop.Libya" and r["ownerId"] == owner["id"] for r in desk["requests"]), who
        queue = client.get("/api/studio/staff/tickets", params={"status": "open"}, cookies=staff[who]["cookies"]).json()
        assert any(t["id"] == view["id"] and t["category"] == "tiktok" for t in queue["tickets"]), who
    active = client.get("/api/studio/staff/tiktok", params={"state": "active"}, cookies=staff["admin"]["cookies"]).json()
    assert any(r["id"] == view["id"] for r in active["requests"])
    done = client.get("/api/studio/staff/tiktok", params={"state": "done"}, cookies=staff["admin"]["cookies"]).json()
    assert all(r["id"] != view["id"] for r in done["requests"])
    _error(client.get("/api/studio/staff/tiktok", params={"state": "weird"}, cookies=staff["admin"]["cookies"]), 400, "INVALID_VALUE")
    _error(client.get("/api/studio/staff/tiktok", cookies=owner["cookies"]), 403, "STAFF_ONLY")

    audits = _audits(view["id"])
    assert audits[0]["action"] == "ticket_create" and audits[0]["details"]["category"] == "tiktok"
    assert audits[0]["details"]["kind"] == "tiktok_request"
    assert all("Shop.Libya" not in json_dumps(a) and "morning" not in json_dumps(a) for a in audits)


def test_tiktok_default_first_message_names_the_wants():
    owner = _customer("plain")
    view = _sent(owner, wants="auto_replies_help")
    thread = client.get(f"/api/studio/tickets/{view['id']}", cookies=owner["cookies"]).json()
    first = thread["messages"][0]["text"]
    assert first == studio_support.tiktok_first_message(["auto_replies_help"])
    assert "TikTok's own built-in auto-messages" in first and "أريد مساعدة في تيك توك" in first


@pytest.mark.parametrize("raw, handle", [
    ("shop.libya", "shop.libya"),
    ("@Shop_Libya1", "Shop_Libya1"),
    ("  @ab  ", "ab"),
    ("https://www.tiktok.com/@shop.libya", "shop.libya"),
    ("tiktok.com/@shop.libya/", "shop.libya"),
    ("https://m.tiktok.com/@shop.libya?lang=en", "shop.libya"),
    ("a" * 24, "a" * 24),
])
def test_tiktok_handle_rule_accepts(raw, handle):
    assert studio_support.tiktok_handle(raw) == handle


@pytest.mark.parametrize("raw", [
    "", " ", "a", "@", "@@shop", "shop libya", "shop.", "a" * 25, "shop/libya", "https://instagram.com/@shop",
    "https://www.tiktok.com/shop", "tiktok.com/@shop.", "شركة", None, 12, ["shop"],
])
def test_tiktok_handle_rule_refuses(raw):
    assert studio_support.tiktok_handle(raw) is None


def test_tiktok_request_shape_rules():
    owner = _customer("shape")
    _error(_send(owner, handle="shop."), 400, "INVALID_VALUE")
    _error(_send(owner, handle="https://instagram.com/@shop"), 400, "INVALID_VALUE")
    _error(_send(owner, wants=[]), 400, "INVALID_VALUE")
    _error(_send(owner, wants=["advice", "advice"]), 400, "INVALID_VALUE")
    _error(_send(owner, wants="calls"), 400, "INVALID_VALUE")
    _error(_send(owner, wants=["advice", "auto_replies_help", "advice"]), 400, "INVALID_VALUE")
    _error(_send(owner, note="x" * 1001), 400, "INVALID_VALUE")
    _error(_send(owner, note=5), 400, "INVALID_VALUE")
    _error(_send(owner, operation="short"), 400, "INVALID_VALUE")
    _error(_send(owner, extraField=1), 400, "UNKNOWN_FIELD")
    _error(client.post("/api/studio/tiktok/requests", json=[1], cookies=owner["cookies"]), 400, "INVALID_REQUEST")
    _error(_send(owner, headers={"Origin": "https://evil.example"}), 403, "CROSS_SITE")
    client.cookies.clear()
    assert client.post("/api/studio/tiktok/requests", json={}).status_code == 401
    # The note is cleaned like every stored text: no angle brackets, blank lines collapsed.
    view = _sent(owner, note="<b>Hi</b>\n\n\n\nthere")
    thread = client.get(f"/api/studio/tickets/{view['id']}", cookies=owner["cookies"]).json()
    assert thread["messages"][0]["text"] == "bHi/b\n\nthere"


def test_tiktok_replay_and_open_cap(staff):
    owner = _customer("cap")
    operation = _op("same")
    first = _sent(owner, operation=operation)
    again = _send(owner, operation=operation)
    assert again.status_code == 200 and again.json()["request"]["id"] == first["id"]
    _error(_send(owner, operation=operation, wants="auto_replies_help"), 409, "IDEMPOTENCY_MISMATCH")
    _error(_send(owner, operation=operation, handle="@other"), 409, "IDEMPOTENCY_MISMATCH")
    second = _sent(owner, handle="@second")
    third = _sent(owner, handle="@third")
    _error(_send(owner, handle="@fourth"), 409, "TICKET_OPEN_LIMIT")
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 3
    # In progress still counts as open; declined frees a place.
    assert _step(staff["admin"], second["id"], "in_progress").status_code == 200
    _error(_send(owner, handle="@fourth"), 409, "TICKET_OPEN_LIMIT")
    assert _step(staff["reviewer"], third["id"], "declined", en="Not now.", ar="ليس الآن.").status_code == 200
    assert _sent(owner, handle="@fourth")["tiktok"]["handle"] == "fourth"
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 3


def test_tiktok_day_limit_counts_created_requests_only(staff, monkeypatch):
    """Five refused bodies or five replays of one send used to lock a customer out for a day: the day
    cap counts the requests that exist; the in-memory limiter only stops floods."""
    owner = _customer("daily")
    monkeypatch.setattr(studio_support, "check_rate_limit", real_check_rate_limit)  # the route's own limiter, live
    reset_rate_limit(f"studio:tiktok-create:{owner['id']}")
    for _ in range(studio_support.TIKTOK_CREATES_PER_DAY):
        _error(_send(owner, handle="shop libya"), 400, "INVALID_VALUE")  # a refused body costs nothing
    operation = _op("day")
    first = _sent(owner, operation=operation)
    for _ in range(3):
        assert _send(owner, operation=operation).status_code == 200  # a replay costs nothing either
    created = [first]
    for i in range(1, studio_support.TIKTOK_CREATES_PER_DAY):
        assert _step(staff["reviewer"], created[-1]["id"], "declined", en="Not now.", ar="ليس الآن.").status_code == 200
        created.append(_sent(owner, handle=f"@day{i}"))
    assert _step(staff["reviewer"], created[-1]["id"], "declined", en="Not now.", ar="ليس الآن.").status_code == 200
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 0
    sixth = _send(owner, handle="@sixth")
    detail = _error(sixth, 429, "RATE_LIMITED")
    assert int(sixth.headers["Retry-After"]) >= 1 and "a day" in detail["message"]
    assert _send(owner, operation=operation).status_code == 200  # the replay of a created request still answers it
    with db_conn() as conn:
        assert studio_support.count_tiktok_requests_today(conn, owner["id"], datetime.now(timezone.utc)) == studio_support.TIKTOK_CREATES_PER_DAY
        assert studio_support.count_tiktok_requests_today(conn, staff["admin"]["id"], datetime.now(timezone.utc)) == 0


def test_tiktok_request_is_due_after_one_business_day(monkeypatch):
    moment = datetime(2026, 9, 27, 8, 30, tzinfo=timezone.utc)  # Sunday 10:30 in Tripoli
    monkeypatch.setattr(studio_support, "utc_now", lambda: moment)
    owner = _customer("due")
    view = _sent(owner)
    settings = _settings()
    assert view["dueAt"] == iso(target_due_at("tiktok", moment, settings))  # the promise: within one business day
    assert view["dueAt"] != iso(target_due_at("ticket", moment, settings))  # not the plain ticket's 4 working hours
    assert view["dueAt"].startswith("2026-09-28T")  # Monday, at the team's close


def test_tiktok_service_switch_gates_new_requests_only(monkeypatch):
    owner = _customer("switch")
    view = _sent(owner)
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: _settings("off"))
    _error(_send(owner, handle="@another"), 403, "SERVICE_OFF")
    listed = client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()
    assert listed["service"]["open"] is False and [r["id"] for r in listed["requests"]] == [view["id"]]
    assert client.get(f"/api/studio/tickets/{view['id']}", cookies=owner["cookies"]).status_code == 200
    pilot = _settings("pilot")
    pilot["rollout"]["uiAllowlist"] = [owner["id"]]
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: pilot)
    assert _send(owner, handle="@pilot").status_code == 200
    other = _customer("switch-other")
    _error(_send(other), 403, "SERVICE_OFF")


# ------------------------------------------------------------------ the team's steps


def test_tiktok_transitions_with_a_bilingual_note(staff, monkeypatch):
    owner = _customer("steps")
    view = _sent(owner)
    ticket_id = view["id"]
    _error(_step(staff["admin"], ticket_id, "done"), 400, "INVALID_VALUE")  # open -> done skips in_progress
    _error(_step(staff["admin"], ticket_id, "open"), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "cancelled"), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", note={"en": "Only English"}), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", note={"en": "x", "ar": ""}), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", note={"en": "x", "ar": "y", "fr": "z"}), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", note="plain"), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", en="x" * 501), 400, "INVALID_VALUE")
    _error(_step(staff["admin"], ticket_id, "in_progress", operation="short"), 400, "INVALID_VALUE")
    _error(_step(owner, ticket_id, "in_progress"), 403, "STAFF_ONLY")
    _error(_step(staff["admin"], ticket_id, "in_progress", headers={"Origin": "https://evil.example"}), 403, "CROSS_SITE")
    _error(_step(staff["admin"], "tkt_" + "0" * 40, "in_progress"), 404, "UNKNOWN_TICKET")
    assert _row(ticket_id)["tiktokState"] == "open"

    moment = datetime(2026, 9, 27, 8, 30, tzinfo=timezone.utc)  # Sunday 10:30 in Tripoli
    monkeypatch.setattr(studio_support, "utc_now", lambda: moment)
    operation = _op("progress")
    started = _step(staff["reviewer"], ticket_id, "in_progress", en="We are on it.", ar="نعمل عليه.", operation=operation)
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["request"]["tiktok"]["state"] == "in_progress" and body["request"]["status"] == "answered"
    assert body["request"]["tiktok"]["note"] == {"en": "We are on it.", "ar": "نعمل عليه."}
    assert body["request"]["tiktok"]["stateAt"] == "2026-09-27T08:30:00.000Z" and body["request"]["firstStaffAt"]
    assert body["message"]["text"] == "We are on it.\n\nنعمل عليه." and body["message"]["from"] == "team"
    assert body["message"]["authorId"] == staff["reviewer"]["id"]
    # The same step sent again (a lost answer) changes nothing and answers the same message.
    repeat = _step(staff["reviewer"], ticket_id, "in_progress", en="We are on it.", ar="نعمل عليه.", operation=operation)
    assert repeat.status_code == 200 and repeat.json()["message"]["id"] == body["message"]["id"]
    assert _row(ticket_id)["messageCount"] == 2
    # The state it already has: a no-op (nothing written, no message).
    same = _step(staff["admin"], ticket_id, "in_progress", en="Again", ar="مجدداً")
    assert same.status_code == 200 and same.json()["message"] is None and _row(ticket_id)["messageCount"] == 2

    finished = _step(staff["admin"], ticket_id, "done", en="All set.", ar="تم كل شيء.")
    assert finished.status_code == 200, finished.text
    assert finished.json()["request"]["tiktok"]["state"] == "done" and finished.json()["request"]["status"] == "resolved"
    assert finished.json()["request"]["resolvedAt"] == "2026-09-27T08:30:00.000Z"
    _error(_step(staff["admin"], ticket_id, "in_progress"), 409, "TICKET_CLOSED")
    _error(_step(staff["admin"], ticket_id, "declined"), 409, "TICKET_CLOSED")
    assert _row(ticket_id)["tiktokState"] == "done"

    # The customer reads the whole story without any staff identity.
    thread = client.get(f"/api/studio/tickets/{ticket_id}", cookies=owner["cookies"])
    assert thread.status_code == 200
    texts = [m["text"] for m in thread.json()["messages"]]
    assert texts[1:] == ["We are on it.\n\nنعمل عليه.", "All set.\n\nتم كل شيء."]
    assert all("authorId" not in m and m["from"] in ("customer", "team") for m in thread.json()["messages"])
    assert staff["reviewer"]["id"] not in thread.text and staff["admin"]["id"] not in thread.text
    assert thread.json()["ticket"]["tiktok"]["note"] == {"en": "All set.", "ar": "تم كل شيء."}

    actions = [a["action"] for a in _audits(ticket_id)]
    assert actions.count("tiktok_status") == 2
    steps = [a["details"] for a in _audits(ticket_id) if a["action"] == "tiktok_status"]
    assert [(s["stateBefore"], s["state"]) for s in steps] == [("open", "in_progress"), ("in_progress", "done")]
    assert all("All set" not in json_dumps(a) for a in _audits(ticket_id))  # the note stays out of the audit


def test_tiktok_declined_from_open_and_reviewer_scope(staff):
    owner = _customer("declined")
    view = _sent(owner)
    declined = _step(staff["reviewer"], view["id"], "declined", en="Not possible now.", ar="غير ممكن الآن.")
    assert declined.status_code == 200 and declined.json()["request"]["tiktok"]["state"] == "declined"
    assert declined.json()["request"]["status"] == "resolved"
    # A plain question ticket is not a TikTok request on this route.
    question = client.post("/api/studio/tickets", json={"subject": "A question", "category": "other", "message": "Hello?",
                                                         "operationId": _op("q")}, cookies=owner["cookies"])
    assert question.status_code == 200, question.text
    _error(_step(staff["admin"], question.json()["ticket"]["id"], "in_progress"), 404, "UNKNOWN_TICKET")
    assert "tiktok" not in question.json()["ticket"]


def test_tiktok_customer_cancels_by_resolving_and_may_reopen(staff):
    owner = _customer("cancel")
    view = _sent(owner)
    resolved = client.post(f"/api/studio/tickets/{view['id']}/resolve", json={"operationId": _op("r")}, cookies=owner["cookies"])
    assert resolved.status_code == 200 and resolved.json()["ticket"]["tiktok"]["state"] == "cancelled"
    assert resolved.json()["ticket"]["tiktok"]["stateLabels"]["ar"] == "ألغيته"
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 0
    cancelled = client.get("/api/studio/tiktok/requests", params={"state": "cancelled"}, cookies=owner["cookies"]).json()
    assert [r["id"] for r in cancelled["requests"]] == [view["id"]]
    reopened = client.post(f"/api/studio/tickets/{view['id']}/reopen", json={"operationId": _op("o")}, cookies=owner["cookies"])
    assert reopened.status_code == 200 and reopened.json()["ticket"]["tiktok"]["state"] == "open"
    # Once the team works on it, resolving the ticket no longer cancels the service.
    assert _step(staff["admin"], view["id"], "in_progress").status_code == 200
    resolved = client.post(f"/api/studio/tickets/{view['id']}/resolve", json={"operationId": _op("r2")}, cookies=owner["cookies"])
    assert resolved.status_code == 200 and resolved.json()["ticket"]["tiktok"]["state"] == "in_progress"


def test_tiktok_generic_team_resolve_ends_the_service(staff):
    """Staff close TikTok tickets in the desk like any ticket; the service must not stay 'open' behind a
    resolved ticket (it counted against the customer's cap for ever and sat in the active list)."""
    owner = _customer("generic")
    views = [_sent(owner, handle=f"@generic{i}") for i in range(3)]
    _error(_send(owner, handle="@fourth"), 409, "TICKET_OPEN_LIMIT")
    closed = client.post(f"/api/studio/staff/tickets/{views[0]['id']}/status", json={"status": "resolved", "operationId": _op("gs")},
                         cookies=staff["admin"]["cookies"])
    assert closed.status_code == 200, closed.text
    ticket = closed.json()["ticket"]
    assert ticket["status"] == "resolved" and ticket["tiktok"]["state"] == "declined" and ticket["tiktok"]["note"] is None
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 2
    active = client.get("/api/studio/staff/tiktok", params={"state": "active"}, cookies=staff["admin"]["cookies"]).json()
    assert all(r["id"] != views[0]["id"] for r in active["requests"])
    assert _sent(owner, handle="@fourth")["tiktok"]["state"] == "open"  # the place is free again
    status_audit = [a for a in _audits(views[0]["id"]) if a["action"] == "ticket_status"][-1]
    assert (status_audit["details"]["tiktokStateBefore"], status_audit["details"]["tiktokState"]) == ("open", "declined")
    mine = client.get(f"/api/studio/tickets/{views[0]['id']}", cookies=owner["cookies"]).json()["ticket"]
    assert mine["tiktok"]["stateLabels"] == studio_support.TIKTOK_TEXTS["states"]["declined"]
    # An in-progress request the same way; a finished one is left as it is.
    assert _step(staff["reviewer"], views[1]["id"], "in_progress").status_code == 200
    closed = client.post(f"/api/studio/staff/tickets/{views[1]['id']}/status", json={"status": "resolved"}, cookies=staff["reviewer"]["cookies"])
    assert closed.status_code == 200 and closed.json()["ticket"]["tiktok"]["state"] == "declined"
    assert _step(staff["admin"], views[2]["id"], "in_progress").status_code == 200
    assert _step(staff["admin"], views[2]["id"], "done", en="All set.", ar="تم.").status_code == 200
    answered = client.post(f"/api/studio/staff/tickets/{views[2]['id']}/status", json={"status": "answered"}, cookies=staff["admin"]["cookies"])
    assert answered.status_code == 200 and answered.json()["ticket"]["tiktok"]["state"] == "done"
    closed = client.post(f"/api/studio/staff/tickets/{views[2]['id']}/status", json={"status": "resolved"}, cookies=staff["admin"]["cookies"])
    assert closed.status_code == 200 and closed.json()["ticket"]["tiktok"]["state"] == "done"
    assert "tiktokStateBefore" not in [a for a in _audits(views[2]["id"]) if a["action"] == "ticket_status"][-1]["details"]


def test_tiktok_reopen_takes_a_place_inside_the_cap(staff):
    owner = _customer("reopen-cap")
    views = [_sent(owner, handle=f"@reopen{i}") for i in range(3)]
    first = views[0]["id"]
    resolved = client.post(f"/api/studio/tickets/{first}/resolve", json={"operationId": _op("r")}, cookies=owner["cookies"])
    assert resolved.status_code == 200 and resolved.json()["ticket"]["tiktok"]["state"] == "cancelled"
    fourth = _sent(owner, handle="@fourth")  # the cancelled one freed a place
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 3
    _error(client.post(f"/api/studio/tickets/{first}/reopen", json={"operationId": _op("o")}, cookies=owner["cookies"]), 409, "TICKET_OPEN_LIMIT")
    assert _row(first)["tiktokState"] == "cancelled" and _row(first)["status"] == "resolved"
    # A message on the cancelled ticket is a reopen too: refused past the cap the same way ...
    _error(client.post(f"/api/studio/tickets/{first}/messages", json={"text": "Still interested", "operationId": _op("m")},
                       cookies=owner["cookies"]), 409, "TICKET_OPEN_LIMIT")
    # ... and, once a place is free, it puts the service back to open (never 'cancelled' behind an open ticket).
    assert _step(staff["reviewer"], fourth["id"], "declined", en="Not now.", ar="ليس الآن.").status_code == 200
    spoke = client.post(f"/api/studio/tickets/{first}/messages", json={"text": "Still interested", "operationId": _op("m")},
                        cookies=owner["cookies"])
    assert spoke.status_code == 200, spoke.text
    assert spoke.json()["ticket"]["status"] == "open" and spoke.json()["ticket"]["tiktok"]["state"] == "open"
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 3
    assert _step(staff["admin"], first, "in_progress").status_code == 200  # the team can work it again
    # The reopen route, inside the cap, opens the service too.
    second = views[1]["id"]
    assert client.post(f"/api/studio/tickets/{second}/resolve", json={"operationId": _op("r")}, cookies=owner["cookies"]).status_code == 200
    reopened = client.post(f"/api/studio/tickets/{second}/reopen", json={"operationId": _op("o")}, cookies=owner["cookies"])
    assert reopened.status_code == 200 and reopened.json()["ticket"]["tiktok"]["state"] == "open"
    assert client.get("/api/studio/tiktok/requests", cookies=owner["cookies"]).json()["openCount"] == 3


def test_anonymisation_scrubs_the_handle_and_the_team_note_from_the_request_row(staff):
    owner = _customer("scrub")
    view = _sent(owner, handle="@secret.handle")
    assert _step(staff["admin"], view["id"], "in_progress", en="We called Ahmed on 0912345678.", ar="اتصلنا بأحمد على 0912345678.").status_code == 200
    assert {"tiktokHandle", "tiktokNote"} <= set(TICKET_PERSONAL_FIELDS)
    with db_conn() as conn:
        counts = scrub_studio_personal_data_conn(conn, owner["id"])
    assert counts["tickets"] == 3 and counts["social"] == 0  # the ticket row and its two messages
    row = _row(view["id"])
    assert "tiktokHandle" not in row and "tiktokNote" not in row and "subject" not in row
    assert "secret.handle" not in json_dumps(row) and "0912345678" not in json_dumps(row)
    assert row["tiktokState"] == "in_progress" and row["tiktokWants"] == ["advice"]
    desk = client.get(f"/api/studio/staff/tickets/{view['id']}", cookies=staff["admin"]["cookies"]).json()
    assert desk["ticket"]["tiktok"]["handle"] == "" and desk["ticket"]["tiktok"]["profileUrl"] is None and desk["ticket"]["tiktok"]["note"] is None
    assert "0912345678" not in json_dumps(desk) and "secret.handle" not in json_dumps(desk)


# ------------------------------------------------------------------ the words


def _tiktok_texts_in_source() -> list[str]:
    """Every string literal of studio_support.py that belongs to TikTok: the TIKTOK_* module values,
    and every function or route whose name mentions tiktok."""
    tree = ast.parse(SUPPORT_SOURCE.read_text(encoding="utf-8"))
    found: list[str] = []
    keys = {id(key) for node in ast.walk(tree) if isinstance(node, ast.Dict) for key in node.keys}  # "en"/"ar" are not texts

    def strings(node: ast.AST) -> list[str]:
        return [n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in keys]

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and "TIKTOK" in t.id for t in node.targets):
            found.extend(strings(node.value))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and "tiktok" in node.name.lower():
            found.extend(strings(node))
    return found


def test_tiktok_texts_never_claim_a_connection():
    texts = _tiktok_texts_in_source()
    assert len(texts) > 20  # the texts, states, wants and route strings were found
    runtime = [studio_support.TIKTOK_TEXTS["service"], studio_support.TIKTOK_TEXTS["notice"], studio_support.TIKTOK_TEXTS["promise"],
               *studio_support.TIKTOK_TEXTS["wants"].values(), *studio_support.TIKTOK_TEXTS["states"].values()]
    for labels in runtime:
        assert set(labels) == {"en", "ar"} and labels["en"].strip() and labels["ar"].strip()
        texts.extend(labels.values())
    for value in texts:
        lowered = value.lower()
        for word in FORBIDDEN_EN:
            assert not re.search(rf"\b{word}\b", lowered), f"TikTok text says {word!r}: {value!r}"
        for word in FORBIDDEN_AR:
            assert word not in value, f"TikTok text says {word!r}: {value!r}"
    # It says what it is: help by hand, TikTok's own feature.
    assert "by hand" in studio_support.TIKTOK_TEXTS["notice"]["en"] and "يدوياً" in studio_support.TIKTOK_TEXTS["notice"]["ar"]
    assert "TikTok runs them, not Albayan" in studio_support.TIKTOK_TEXTS["wants"]["auto_replies_help"]["en"]
    assert "مساعدة يدوية" in studio_support.TIKTOK_TEXTS["service"]["ar"]


def test_tiktok_static_check_catches_a_forbidden_word(tmp_path, monkeypatch):
    fake = tmp_path / "studio_support.py"
    fake.write_text('TIKTOK_BAD = {"en": "Your TikTok is connected", "ar": "حسابك متصل"}\n', encoding="utf-8")
    monkeypatch.setattr(sys.modules[__name__], "SUPPORT_SOURCE", fake)
    texts = _tiktok_texts_in_source()
    assert texts == ["Your TikTok is connected", "حسابك متصل"]
    assert any(re.search(r"\bconnected\b", t.lower()) for t in texts) and any("متصل" in t for t in texts)


def test_tiktok_view_reads_a_hand_edited_row_through_its_rules():
    view = studio_support.tiktok_view({"tiktokHandle": "bad handle", "tiktokState": "weird", "tiktokWants": ["advice", "x", 5],
                                       "tiktokNote": {"en": 1, "ar": "ok", "fr": "no"}, "tiktokStateAt": "t" * 80})
    assert view == {"handle": "", "profileUrl": None, "wants": ["advice"], "state": "open",
                    "stateLabels": studio_support.TIKTOK_TEXTS["states"]["open"], "note": {"en": "", "ar": "ok"}, "stateAt": None}
    assert studio_support.tiktok_view({})["state"] == "open"
    with pytest.raises(ValueError):
        with db_conn() as conn:
            studio_support.tiktok_transition_conn(conn, "tkt_" + "0" * 40, "cancelled", note={"en": "x", "ar": "y"},
                                                  actor_id="", operation_id=_op("v"), settings=_settings())
