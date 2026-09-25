"""Albayan Studio help desk (plan tasks P3-07, P3-12, P3-13; PLAN.md §5.5 J8, §7.1, §7.3, §7.5).

* Customers open, read, answer, resolve and reopen their OWN tickets only (another owner's ticket
  is 404); a replay with the same operationId returns the first result, a different one is 409.
* Payment and account tickets are admin-only: a reviewer gets 404 on them and never sees them listed.
* Caps (20 open tickets, 50 messages), the 7-day reopen window, numbers in order and unique, due
  times from the service hours, and the anonymisation scrub of subjects and texts.

Every test creates its own users (unique e-mails per run). The studio settings are fixed per test
(``_settings`` below), so switches other modules save in the shared database never leak in.
``postgres_ticket_numbers()`` is the PostgreSQL scenario ``studio_ticket_numbers`` of
test_postgres_studio_jobs.py (not collected here).
"""

import json
import os
import re
import secrets
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import check_rate_limit, reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES, studio_settings, studio_support
from server.systems.ads_studio.social_studio import SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_hours import target_due_at
from server.systems.ads_studio.studio_privacy import scrub_studio_personal_data_conn
from server.systems.ads_studio.studio_types import (
    STUDIO_COUNTERS_TYPE,
    SUPPORT_TICKET_MESSAGES_TYPE,
    SUPPORT_TICKETS_TYPE,
    STUDIO_ROUTER_ONLY_TYPES,
)
from server.wallet_payments import PAYMENT_REFERENCE_RE, payment_request_belongs_to

TAG = secrets.token_hex(4)
PASSWORD = "StudioSupportPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
TRIPOLI = timezone(timedelta(hours=2))
THURSDAY_16_TRIPOLI = datetime(2026, 9, 24, 16, 0, tzinfo=TRIPOLI).astimezone(timezone.utc)
CUSTOMER_TICKET_KEYS = {
    "id", "number", "subject", "category", "status", "audience", "priority", "kind", "relatedType", "relatedId",
    "createdAt", "updatedAt", "dueAt", "lastMessageAt", "resolvedAt", "reopenUntil",
}
STAFF_TICKET_KEYS = CUSTOMER_TICKET_KEYS | {"ownerId", "firstStaffAt", "lastCustomerAt", "lastStaffAt", "messageCount", "overdue"}
_counter = [0]


def _op(label: str = "op") -> str:
    _counter[0] += 1
    return f"{label}-{TAG}-{_counter[0]:05d}"


# ------------------------------------------------------------------ people and switches


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("support_user")
    email = f"studio-support-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"Support {label} Person", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
                "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "email": email, "cookies": cookies}


def _settings(help_mode: str = "on", allowlist: list | None = None, **targets) -> dict:
    value = {key: studio_settings.default_value(key) for key in studio_settings.SETTING_KEYS}
    value["rollout"]["services"]["help"] = help_mode
    value["rollout"]["uiAllowlist"] = list(allowlist or [])
    value["targets"].update(targets)
    return value


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()  # idempotent; the module may run alone on a fresh in-memory database


@pytest.fixture(autouse=True)
def _help_on_and_no_rate_limits(monkeypatch):
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: _settings())
    monkeypatch.setattr(studio_support, "check_rate_limit", lambda *a, **k: (True, 1, 0))


@pytest.fixture(scope="module")
def staff():
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


def _customer(label: str = "customer") -> dict:
    return _insert_user(label, "Employee", CUSTOMER_PERMISSIONS)


def _freeze(monkeypatch, moment: datetime) -> None:
    monkeypatch.setattr(studio_support, "utc_now", lambda: moment)


# ------------------------------------------------------------------ calls


def _open(user: dict, *, subject="My ad is not running", category="ad", message="Please check my ad.",
          operation=None, headers=None, **extra):
    body = {"subject": subject, "category": category, "message": message, "operationId": operation or _op("open"), **extra}
    return client.post("/api/studio/tickets", json=body, cookies=user["cookies"], headers=headers)


def _opened(user: dict, **kwargs) -> dict:
    response = _open(user, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


def _get(user: dict, path: str, **params):
    return client.get(f"/api/studio{path}", params=params, cookies=user["cookies"])


def _post(user: dict, path: str, body, headers=None):
    return client.post(f"/api/studio{path}", json=body, cookies=user["cookies"], headers=headers)


def _say(user: dict, ticket: dict, words: str, *, staff_route: bool = False, operation=None):
    prefix = "/staff/tickets" if staff_route else "/tickets"
    return _post(user, f"{prefix}/{ticket['id']}/messages", {"text": words, "operationId": operation or _op("msg")})


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code, detail
    return detail


def _row(entity_type: str, row_id: str) -> dict | None:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id, data_json, created_by, deleted, last_modified FROM entities WHERE type = :type AND id = :id"),
            {"type": entity_type, "id": row_id},
        ).mappings().first()
    return None if row is None else {**dict(row), "data": json_loads(row["data_json"])}


def _audits(row_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, action, message, metadata_json FROM audit_logs WHERE resource_type = :type "
                 "AND resource_id = :id ORDER BY ts"),
            {"type": SUPPORT_TICKETS_TYPE, "id": row_id},
        ).mappings().all()
    return [dict(row) for row in rows]


def _insert_entity(entity_type: str, owner_id: str, data: dict, row_id: str | None = None) -> str:
    row_id = row_id or f"{entity_type[:3].lower()}_{secrets.token_hex(12)}"
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
        ), {"type": entity_type, "id": row_id, "data": json_dumps({"id": row_id, **data}), "stamp": stamp, "owner": owner_id})
    return row_id


# ------------------------------------------------------------------ open, read, replay


def test_open_ticket_and_read_it_back(monkeypatch):
    _freeze(monkeypatch, THURSDAY_16_TRIPOLI)
    user = _customer("open")
    answer = _open(user, subject="  My <b>ad</b>   is stuck  ", message="Line one\r\n\r\n\r\n\tLine two <script>")
    assert answer.status_code == 200, answer.text
    ticket, first = answer.json()["ticket"], answer.json()["message"]
    assert set(ticket) == CUSTOMER_TICKET_KEYS
    assert re.fullmatch(r"T-\d{6,}", ticket["number"]) and re.fullmatch(r"tkt_[0-9a-f]{40}", ticket["id"])
    assert ticket["subject"] == "My bad/b is stuck"  # angle brackets gone, spaces collapsed
    assert (ticket["status"], ticket["audience"], ticket["priority"], ticket["kind"]) == ("open", "staff", "normal", "question")
    assert ticket["relatedType"] is None and ticket["relatedId"] is None and ticket["resolvedAt"] is None
    # Thursday 16:00 + 4 working hours = Sunday 12:00 Tripoli (10:00 UTC).
    assert ticket["dueAt"] == "2026-09-27T10:00:00.000Z" == ticket_due(THURSDAY_16_TRIPOLI)
    assert ticket["createdAt"] == ticket["updatedAt"] == ticket["lastMessageAt"] == "2026-09-24T14:00:00.000Z"
    assert first == {"id": first["id"], "from": "customer", "text": "Line one\n\n Line two script", "createdAt": ticket["createdAt"]}

    listed = _get(user, "/tickets").json()
    assert [item["id"] for item in listed["tickets"]] == [ticket["id"]] and listed["nextCursor"] is None
    assert listed["tickets"][0] == ticket
    detail = _get(user, f"/tickets/{ticket['id']}").json()
    assert detail == {"ticket": ticket, "messages": [first]}

    row = _row(SUPPORT_TICKETS_TYPE, ticket["id"])
    assert row["created_by"] == user["id"] and row["data"]["ownerId"] == user["id"] and row["data"]["messageCount"] == 1
    message_row = _row(SUPPORT_TICKET_MESSAGES_TYPE, first["id"])
    assert message_row["created_by"] == user["id"] and message_row["data"]["ticketId"] == ticket["id"]
    audits = _audits(ticket["id"])
    assert [entry["action"] for entry in audits] == ["ticket_create"] and audits[0]["user_id"] == user["id"]
    assert "stuck" not in json.dumps(audits) and "Line one" not in json.dumps(audits)  # never a text


def ticket_due(start: datetime, target: str = "ticket") -> str:
    return target_due_at(target, start, _settings()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def test_replay_returns_the_same_ticket_and_a_different_one_is_refused():
    user = _customer("replay")
    operation = _op("same")
    first = _open(user, operation=operation)
    again = _open(user, operation=operation)
    assert first.status_code == again.status_code == 200 and first.json() == again.json()
    _error(_open(user, operation=operation, message="Something else"), 409, "IDEMPOTENCY_MISMATCH")
    _error(_open(user, operation=operation, category="other"), 409, "IDEMPOTENCY_MISMATCH")
    # The replay took no number: the next ticket is the very next one.
    following = _opened(user)
    assert int(following["number"][2:]) == int(first.json()["ticket"]["number"][2:]) + 1
    assert len(_get(user, "/tickets").json()["tickets"]) == 2
    assert [a["action"] for a in _audits(first.json()["ticket"]["id"])] == ["ticket_create"]
    # The same operationId from ANOTHER customer is their own new ticket.
    other = _customer("replay-other")
    assert _opened(other, operation=operation)["id"] != first.json()["ticket"]["id"]

    ticket = first.json()["ticket"]
    said = _say(user, ticket, "Any news?", operation="message-op-0001")
    assert said.status_code == 200 and _say(user, ticket, "Any news?", operation="message-op-0001").json() == said.json()
    _error(_say(user, ticket, "Different words", operation="message-op-0001"), 409, "IDEMPOTENCY_MISMATCH")
    assert len(_get(user, f"/tickets/{ticket['id']}").json()["messages"]) == 2


def test_request_shape_and_text_rules():
    user = _customer("shape")
    long_subject = "x" * 121
    cases = [
        ({"subject": "ab"}, "INVALID_VALUE"),
        ({"subject": "   a  "}, "INVALID_VALUE"),
        ({"subject": long_subject}, "INVALID_VALUE"),
        ({"subject": 12345}, "INVALID_VALUE"),
        ({"category": "replies"}, "INVALID_VALUE"),
        ({"message": ""}, "INVALID_VALUE"),
        ({"message": " \n\t "}, "INVALID_VALUE"),
        ({"message": "m" * 2001}, "INVALID_VALUE"),
        ({"operation": "short"}, "INVALID_VALUE"),
        ({"operation": "has space in it"}, "INVALID_VALUE"),
        ({"relatedType": "campaign"}, "INVALID_REQUEST"),
        ({"relatedId": "cmp_1"}, "INVALID_REQUEST"),
        ({"relatedType": "ads", "relatedId": "x1"}, "INVALID_VALUE"),
        ({"relatedType": "campaign", "relatedId": "bad id!"}, "INVALID_VALUE"),
        ({"ownerId": "someone"}, "UNKNOWN_FIELD"),
    ]
    for change, code in cases:
        _error(_open(user, **change), 400, code)
    _error(client.post("/api/studio/tickets", json=["x"], cookies=user["cookies"]), 400, "INVALID_REQUEST")
    assert _opened(user, subject="x" * 120, message="m" * 2000)["subject"] == "x" * 120
    assert _get(user, "/tickets").json()["tickets"][0]["subject"] == "x" * 120
    ticket = _get(user, "/tickets").json()["tickets"][0]
    for body, code in (({"text": "hi"}, "INVALID_VALUE"), ({"text": "", "operationId": _op()}, "INVALID_VALUE"),
                       ({"text": "hi", "operationId": _op(), "from": "team"}, "UNKNOWN_FIELD")):
        _error(_post(user, f"/tickets/{ticket['id']}/messages", body), 400, code)
    for path in ("resolve", "reopen"):
        _error(_post(user, f"/tickets/{ticket['id']}/{path}", {}), 400, "INVALID_VALUE")
        _error(_post(user, f"/tickets/{ticket['id']}/{path}", {"operationId": _op(), "status": "open"}), 400, "UNKNOWN_FIELD")
    for params in ({"status": "closed"}, {"limit": "0"}, {"limit": "51"}, {"limit": "٢"}, {"cursor": "abc"}):
        _error(_get(user, "/tickets", **params), 400, "INVALID_VALUE")


# ------------------------------------------------------------------ isolation and staff access


def test_customers_see_only_their_own_tickets(staff):
    owner = _customer("owner")
    other = _customer("other")
    ticket = _opened(owner)
    assert _get(other, "/tickets").json()["tickets"] == []
    for response in (
        _get(other, f"/tickets/{ticket['id']}"),
        _say(other, ticket, "Let me in"),
        _post(other, f"/tickets/{ticket['id']}/resolve", {"operationId": _op()}),
        _post(other, f"/tickets/{ticket['id']}/reopen", {"operationId": _op()}),
        _get(owner, "/tickets/tkt_" + "0" * 40),
        _get(owner, "/tickets/not-a-ticket-id"),
    ):
        _error(response, 404, "UNKNOWN_TICKET")
    # Staff read and act on it through the staff routes only; the customer routes stay owner-only.
    _error(_get(staff["admin"], f"/tickets/{ticket['id']}"), 404, "UNKNOWN_TICKET")
    # A customer never reaches the staff routes.
    for response in (
        _get(owner, "/staff/tickets"),
        _get(owner, f"/staff/tickets/{ticket['id']}"),
        _say(owner, ticket, "I am staff now", staff_route=True),
        _post(owner, f"/staff/tickets/{ticket['id']}/status", {"status": "resolved"}),
    ):
        _error(response, 403, "STAFF_ONLY")
    # Login and the site itself.
    assert client.get("/api/studio/tickets").status_code == 401
    assert client.post("/api/studio/tickets", json={}).status_code == 401
    assert client.get("/api/studio/staff/tickets").status_code == 401
    evil = {"Origin": "https://evil.example"}
    _error(_open(owner, headers=evil), 403, "CROSS_SITE")
    _error(_post(owner, f"/tickets/{ticket['id']}/messages", {"text": "x", "operationId": _op()}, headers=evil), 403, "CROSS_SITE")
    _error(_post(staff["admin"], f"/staff/tickets/{ticket['id']}/status", {"status": "resolved"}, headers=evil), 403, "CROSS_SITE")
    assert len(_get(owner, "/tickets").json()["tickets"]) == 1


def test_payment_and_account_tickets_are_admin_only(staff):
    admin, reviewer = staff["admin"], staff["reviewer"]
    user = _customer("audience")
    payment = _opened(user, category="payment", subject="My charge PAY-1 is waiting")
    account = _opened(user, category="account", subject="Change my password")
    ad = _opened(user, category="ad")
    assert (payment["audience"], account["audience"], ad["audience"]) == ("admin", "admin", "staff")

    def staff_ids(person, **params):
        ids, cursor = [], None
        while True:
            page = _get(person, "/staff/tickets", limit=50, **({"cursor": cursor} if cursor else {}), **params).json()
            ids += [item["id"] for item in page["tickets"]]
            cursor = page["nextCursor"]
            if not cursor:
                return ids

    reviewer_ids, admin_ids = staff_ids(reviewer), staff_ids(admin)
    assert ad["id"] in reviewer_ids and payment["id"] not in reviewer_ids and account["id"] not in reviewer_ids
    assert {ad["id"], payment["id"], account["id"]} <= set(admin_ids)
    for hidden in (payment, account):
        for response in (
            _get(reviewer, f"/staff/tickets/{hidden['id']}"),
            _say(reviewer, hidden, "Reviewer answer", staff_route=True),
            _post(reviewer, f"/staff/tickets/{hidden['id']}/status", {"status": "resolved"}),
        ):
            _error(response, 404, "UNKNOWN_TICKET")  # exactly like a ticket that does not exist
        assert _get(admin, f"/staff/tickets/{hidden['id']}").status_code == 200
    assert _get(reviewer, f"/staff/tickets/{ad['id']}").status_code == 200
    answered = _say(admin, payment, "We confirmed it.", staff_route=True)
    assert answered.status_code == 200 and answered.json()["ticket"]["status"] == "answered"
    with db_conn() as conn:
        mine = studio_support.staff_ticket_counts(conn, include_admin=True)
        theirs = studio_support.staff_ticket_counts(conn, include_admin=False)
    assert mine["active"] - theirs["active"] >= 2 and set(mine) == {"open", "overdue", "urgent", "active"}


def test_generic_api_refuses_the_ticket_types(staff):
    user = _customer("generic")
    ticket = _opened(user)
    for entity_type in (SUPPORT_TICKETS_TYPE, SUPPORT_TICKET_MESSAGES_TYPE, STUDIO_COUNTERS_TYPE):
        assert entity_type in OWNED_TYPES and entity_type in STUDIO_ROUTER_ONLY_TYPES and entity_type in SOCIAL_STUDIO_COLLECTIONS
        base = f"/api/collections/{entity_type}"
        for response in (
            client.get(base, cookies=staff["admin"]["cookies"]),
            client.get(f"{base}/{ticket['id']}", cookies=staff["admin"]["cookies"]),
            client.post(base, json={"id": "tkt_forged", "data": {"subject": "x"}}, cookies=staff["admin"]["cookies"]),
        ):
            assert response.status_code == 404 and response.json()["detail"] == "Unknown collection", response.text


# ------------------------------------------------------------------ related items


def test_related_items_must_be_the_customers_own():
    user = _customer("related")
    other = _customer("related-other")
    mine = _insert_entity(CAMPAIGNS, user["id"], {"name": "Mine", "status": "Draft"})
    theirs = _insert_entity(CAMPAIGNS, other["id"], {"name": "Theirs", "status": "Draft"})
    archived = _insert_entity(CAMPAIGNS, user["id"], {"name": "Archived", "status": "Draft"})
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted = true WHERE type = :t AND id = :id"), {"t": CAMPAIGNS, "id": archived})
    my_charge = _insert_entity("walletPaymentRequests", user["id"], {"userId": user["id"], "reference": "PAY-ABCD2345", "status": "pending"})
    my_paid = _insert_entity("walletPaymentRequests", user["id"], {"userId": user["id"], "reference": "PAY-CNFM2345", "status": "confirmed"})
    their_charge = _insert_entity("walletPaymentRequests", other["id"], {"userId": other["id"], "reference": "PAY-WXYZ6789", "status": "pending"})
    forged = _insert_entity("walletPaymentRequests", user["id"], {"userId": other["id"], "reference": "PAY-FORG2345", "status": "pending"})
    my_page = _insert_entity("socialPages", user["id"], {"ownerId": user["id"], "platform": "fb", "metaPageId": "111222333", "name": "My page"})
    their_page = _insert_entity("socialPages", other["id"], {"ownerId": other["id"], "platform": "fb", "metaPageId": "444555666", "name": "Theirs"})

    ok = _opened(user, relatedType="campaign", relatedId=mine)
    assert (ok["relatedType"], ok["relatedId"]) == ("campaign", mine)
    assert _opened(user, category="payment", relatedType="payment", relatedId=my_charge)["relatedId"] == my_charge
    assert _opened(user, category="payment", relatedType="payment", relatedId="PAY-ABCD2345")["relatedId"] == "PAY-ABCD2345"
    # J2 "Ask about this payment": a confirmed charge request is still the customer's own (by id or reference).
    assert _opened(user, category="payment", relatedType="payment", relatedId=my_paid)["relatedId"] == my_paid
    assert _opened(user, category="payment", relatedType="payment", relatedId="PAY-CNFM2345")["relatedId"] == "PAY-CNFM2345"
    assert _opened(user, category="page", relatedType="page", relatedId=my_page)["relatedId"] == my_page
    for related_type, related_id, code in (
        ("campaign", theirs, "UNKNOWN_CAMPAIGN"), ("campaign", archived, "UNKNOWN_CAMPAIGN"), ("campaign", "cmp_missing", "UNKNOWN_CAMPAIGN"),
        ("payment", their_charge, "UNKNOWN_PAYMENT"), ("payment", "PAY-WXYZ6789", "UNKNOWN_PAYMENT"), ("payment", "PAY-NOPE2345", "UNKNOWN_PAYMENT"),
        ("payment", forged, "UNKNOWN_PAYMENT"), ("payment", "PAY-FORG2345", "UNKNOWN_PAYMENT"),
        ("page", their_page, "UNKNOWN_PAGE"),
    ):
        _error(_open(user, relatedType=related_type, relatedId=related_id), 404, code)
    assert len(_get(user, "/tickets").json()["tickets"]) == 6
    # The platform door itself (D36): the help desk never reads the payment rows; it asks wallet_payments.
    assert "WALLET_PAYMENT_COLLECTION" not in Path(studio_support.__file__).read_text(encoding="utf-8")
    with db_conn() as conn:
        assert payment_request_belongs_to(conn, user["id"], my_paid) and payment_request_belongs_to(conn, user["id"], "PAY-CNFM2345")
        assert not payment_request_belongs_to(conn, user["id"], their_charge) and not payment_request_belongs_to(conn, user["id"], forged)
        assert not payment_request_belongs_to(conn, "", my_charge) and not payment_request_belongs_to(conn, user["id"], "")
    assert PAYMENT_REFERENCE_RE.fullmatch("PAY-ABCD2345") and not PAYMENT_REFERENCE_RE.fullmatch("pay-abcd2345")


# ------------------------------------------------------------------ caps, switch, rate limit


def test_open_ticket_cap_and_message_cap(staff):
    user = _customer("caps")
    tickets = [_opened(user, subject=f"Question {n}") for n in range(studio_support.MAX_OPEN_TICKETS)]
    _error(_open(user), 409, "TICKET_OPEN_LIMIT")
    assert _post(user, f"/tickets/{tickets[0]['id']}/resolve", {"operationId": _op()}).json()["ticket"]["status"] == "resolved"
    last_operation = _op("last")
    last = _opened(user, operation=last_operation)  # one resolved: room for one more
    _error(_open(user), 409, "TICKET_OPEN_LIMIT")
    # Replaying an open that already happened is never refused by the cap.
    replay = _open(user, operation=last_operation)
    assert replay.status_code == 200 and replay.json()["ticket"] == last

    ticket = tickets[1]
    for n in range(studio_support.MAX_MESSAGES - 1):  # the first message counts too
        person, route = (staff["reviewer"], True) if n % 2 else (user, False)
        assert _say(person, ticket, f"Message {n}", staff_route=route).status_code == 200
    _error(_say(user, ticket, "One too many"), 409, "TICKET_MESSAGE_LIMIT")
    _error(_say(staff["admin"], ticket, "Team too", staff_route=True), 409, "TICKET_MESSAGE_LIMIT")
    detail = _get(user, f"/tickets/{ticket['id']}").json()
    assert len(detail["messages"]) == studio_support.MAX_MESSAGES
    assert [m["text"] for m in detail["messages"][1:4]] == ["Message 0", "Message 1", "Message 2"]  # in order


def test_help_switch_gates_new_tickets_only(monkeypatch):
    user = _customer("switch")
    ticket = _opened(user)
    pilot = _customer("pilot")
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: _settings("off"))
    _error(_open(user), 403, "SERVICE_OFF")
    # Existing tickets stay readable and answerable while Help is off.
    assert _get(user, f"/tickets/{ticket['id']}").status_code == 200
    assert _say(user, ticket, "Still there?").status_code == 200
    assert _post(user, f"/tickets/{ticket['id']}/resolve", {"operationId": _op()}).status_code == 200
    monkeypatch.setattr(studio_support, "read_all_settings", lambda: _settings("pilot", [pilot["id"]]))
    _error(_open(user), 403, "SERVICE_OFF")
    assert _open(pilot).status_code == 200


def test_new_tickets_are_rate_limited(monkeypatch):
    monkeypatch.setattr(studio_support, "check_rate_limit", check_rate_limit)
    user = _customer("rate")
    reset_rate_limit(f"studio:ticket-create:{user['id']}")
    for n in range(studio_support.CREATES_PER_HOUR):
        assert _open(user, subject=f"Rate {n}").status_code == 200
    refused = _open(user)
    _error(refused, 429, "RATE_LIMITED")
    assert int(refused.headers["Retry-After"]) >= 1
    assert _get(user, "/tickets").status_code == 200  # reads have their own bucket


# ------------------------------------------------------------------ transitions and due times


def test_status_flow_and_due_times(staff, monkeypatch):
    reviewer = staff["reviewer"]
    user = _customer("flow")
    _freeze(monkeypatch, THURSDAY_16_TRIPOLI)
    ticket = _opened(user)
    assert ticket["dueAt"] == ticket_due(THURSDAY_16_TRIPOLI)

    friday = THURSDAY_16_TRIPOLI + timedelta(days=1)
    _freeze(monkeypatch, friday)
    answered = _say(reviewer, ticket, "We are on it.", staff_route=True).json()
    assert answered["ticket"]["status"] == "answered" and answered["ticket"]["dueAt"] is None
    assert answered["ticket"]["firstStaffAt"] == answered["ticket"]["lastStaffAt"] == "2026-09-25T14:00:00.000Z"
    assert answered["message"]["from"] == "team" and answered["message"]["authorId"] == reviewer["id"]
    assert set(answered["ticket"]) == STAFF_TICKET_KEYS

    saturday = friday + timedelta(days=1)
    _freeze(monkeypatch, saturday)
    again = _say(user, ticket, "Thanks, and one more thing").json()["ticket"]
    assert again["status"] == "open" and again["dueAt"] == ticket_due(saturday) == "2026-09-27T11:00:00.000Z"  # Sunday 13:00
    later = _say(user, ticket, "Hello?").json()["ticket"]
    assert later["dueAt"] == again["dueAt"]  # the clock runs from the first unanswered message

    waiting = _post(reviewer, f"/staff/tickets/{ticket['id']}/status", {"status": "waiting_customer"}).json()["ticket"]
    assert waiting["status"] == "waiting_customer" and waiting["dueAt"] is None
    audits_before = len(_audits(ticket["id"]))
    assert _post(reviewer, f"/staff/tickets/{ticket['id']}/status", {"status": "waiting_customer", "operationId": _op()}).status_code == 200
    assert len(_audits(ticket["id"])) == audits_before  # a no-op writes nothing

    resolved = _post(user, f"/tickets/{ticket['id']}/resolve", {"operationId": _op()}).json()["ticket"]
    assert resolved["status"] == "resolved" and resolved["resolvedAt"] == "2026-09-26T14:00:00.000Z"
    assert resolved["reopenUntil"] == "2026-10-03T14:00:00.000Z" and resolved["dueAt"] is None
    assert _post(user, f"/tickets/{ticket['id']}/resolve", {"operationId": _op()}).json()["ticket"] == resolved
    reopened = _post(user, f"/tickets/{ticket['id']}/reopen", {"operationId": _op()}).json()["ticket"]
    assert reopened["status"] == "open" and reopened["resolvedAt"] is None and reopened["reopenUntil"] is None
    assert reopened["dueAt"] == ticket_due(saturday)
    assert _post(user, f"/tickets/{ticket['id']}/reopen", {"operationId": _op()}).json()["ticket"] == reopened  # not resolved: no-op

    # The team resolves; after 7 days the customer can no longer reopen or write.
    _post(reviewer, f"/staff/tickets/{ticket['id']}/status", {"status": "resolved"})
    _freeze(monkeypatch, saturday + timedelta(days=7, minutes=1))
    _error(_post(user, f"/tickets/{ticket['id']}/reopen", {"operationId": _op()}), 409, "TICKET_CLOSED")
    _error(_say(user, ticket, "Are you there?"), 409, "TICKET_CLOSED")
    # The team can still write to it (it becomes answered), and staff may set any status.
    assert _say(reviewer, ticket, "Following up.", staff_route=True).json()["ticket"]["status"] == "answered"
    assert _post(reviewer, f"/staff/tickets/{ticket['id']}/status", {"status": "open"}).json()["ticket"]["dueAt"]
    _error(_post(reviewer, f"/staff/tickets/{ticket['id']}/status", {"status": "closed"}), 400, "INVALID_VALUE")
    actions = [entry["action"] for entry in _audits(ticket["id"])]
    assert actions[0] == "ticket_create" and actions.count("ticket_message") == 4 and "ticket_status" in actions


def test_a_message_within_seven_days_reopens(staff, monkeypatch):
    user = _customer("reopen")
    ticket = _opened(user)
    _post(staff["reviewer"], f"/staff/tickets/{ticket['id']}/status", {"status": "resolved"})
    _freeze(monkeypatch, datetime.now(timezone.utc) + timedelta(days=6))
    written = _say(user, ticket, "It broke again")
    assert written.status_code == 200 and written.json()["ticket"]["status"] == "open"


def test_reopen_counts_against_the_open_ticket_cap(staff):
    """A customer's reopen (by /reopen or by a message on a resolved ticket) is held by the same cap as a
    new ticket: 20 unresolved tickets stay 20. The team's reopen is never held."""
    user = _customer("reopen-cap")
    tickets = [_opened(user, subject=f"Cap {n}") for n in range(studio_support.MAX_OPEN_TICKETS)]
    resolved = tickets[:2]
    for ticket in resolved:
        assert _post(user, f"/tickets/{ticket['id']}/resolve", {"operationId": _op()}).json()["ticket"]["status"] == "resolved"
    fresh = [_opened(user, subject=f"Fresh {n}") for n in range(2)]  # back at the cap: 20 unresolved
    _error(_open(user), 409, "TICKET_OPEN_LIMIT")
    _error(_post(user, f"/tickets/{resolved[0]['id']}/reopen", {"operationId": _op()}), 409, "TICKET_OPEN_LIMIT")
    _error(_say(user, resolved[1], "It broke again"), 409, "TICKET_OPEN_LIMIT")
    with db_conn() as conn:
        assert studio_support.count_open_tickets(conn, user["id"]) == studio_support.MAX_OPEN_TICKETS
    assert _get(user, f"/tickets/{resolved[0]['id']}").json()["ticket"]["status"] == "resolved"
    assert len(_get(user, f"/tickets/{resolved[1]['id']}").json()["messages"]) == 1  # the refused message was not kept
    # One resolved makes room for exactly one reopen, either way round.
    assert _post(user, f"/tickets/{fresh[0]['id']}/resolve", {"operationId": _op()}).status_code == 200
    assert _post(user, f"/tickets/{resolved[0]['id']}/reopen", {"operationId": _op()}).json()["ticket"]["status"] == "open"
    _error(_say(user, resolved[1], "It broke again"), 409, "TICKET_OPEN_LIMIT")
    assert _post(user, f"/tickets/{fresh[1]['id']}/resolve", {"operationId": _op()}).status_code == 200
    assert _say(user, resolved[1], "It broke again").json()["ticket"]["status"] == "open"
    _error(_post(user, f"/tickets/{fresh[0]['id']}/reopen", {"operationId": _op()}), 409, "TICKET_OPEN_LIMIT")
    reopened = _post(staff["reviewer"], f"/staff/tickets/{fresh[0]['id']}/status", {"status": "open"}).json()["ticket"]
    assert reopened["status"] == "open"  # the team is never held by the customer's cap
    with db_conn() as conn:
        assert studio_support.count_open_tickets(conn, user["id"]) == studio_support.MAX_OPEN_TICKETS + 1


def test_staff_answer_puts_one_item_in_the_customer_inbox(staff):
    """P3-05 ticket_answered: the team's answer reaches the customer's inbox once per answer, on the
    answer's own transaction; a replay, the customer's own messages and other customers get nothing."""
    user = _customer("inbox")
    other = _customer("inbox-other")
    ticket = _opened(user)
    assert _get(user, "/activity").json()["items"] == []  # nothing until the team answers
    assert _say(user, ticket, "One more detail").status_code == 200  # a customer's own message adds nothing
    assert _get(user, "/activity").json()["unreadCount"] == 0
    operation = _op("answer")
    first = _say(staff["admin"], ticket, "We fixed it.", staff_route=True, operation=operation)
    replay = _say(staff["admin"], ticket, "We fixed it.", staff_route=True, operation=operation)
    assert first.status_code == replay.status_code == 200, replay.text
    feed = _get(user, "/activity").json()
    assert feed["unreadCount"] == 1 and len(feed["items"]) == 1
    item = feed["items"][0]
    assert (item["kind"], item["relatedType"], item["relatedId"], item["unread"]) == ("ticket_answered", "ticket", ticket["id"], True)
    assert ticket["number"] in item["body"]["en"] and ticket["number"] in item["body"]["ar"]
    assert "We fixed it" not in json.dumps(feed) and staff["admin"]["id"] not in json.dumps(feed)  # no text, no staff id
    assert _get(other, "/activity").json() == {"items": [], "unreadCount": 0, "nextCursor": None, "seenAt": None}
    # A second, different answer is a second item; the customer's reply in between adds none.
    assert _say(user, ticket, "Thanks").status_code == 200
    assert _say(staff["reviewer"], ticket, "You are welcome.", staff_route=True).status_code == 200
    kinds = [entry["kind"] for entry in _get(user, "/activity").json()["items"]]
    assert kinds == ["ticket_answered", "ticket_answered"]
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'studioActivity' AND created_by IN (:a, :b)"),
                     {"a": user["id"], "b": other["id"]})


def test_customer_never_sees_who_answered(staff):
    user = _customer("identity")
    ticket = _opened(user)
    for person in (staff["reviewer"], staff["admin"]):
        assert _say(person, ticket, "Answer from the team", staff_route=True).status_code == 200
    _post(staff["admin"], f"/staff/tickets/{ticket['id']}/status", {"status": "resolved"})
    customer_views = [
        _get(user, f"/tickets/{ticket['id']}").text,
        _get(user, "/tickets").text,
        _say(user, ticket, "Thanks").text,
        _post(user, f"/tickets/{ticket['id']}/reopen", {"operationId": _op()}).text,
    ]
    for body in customer_views:
        for person in (staff["reviewer"], staff["admin"]):
            assert person["id"] not in body and person["email"] not in body
        assert "authorId" not in body and "ownerId" not in body
    messages = json.loads(customer_views[0])["messages"]
    assert [m["from"] for m in messages] == ["customer", "team", "team"]
    staff_view = _get(staff["admin"], f"/staff/tickets/{ticket['id']}").json()
    assert [m["authorId"] for m in staff_view["messages"]] == [user["id"], staff["reviewer"]["id"], staff["admin"]["id"], user["id"]]
    assert staff_view["ticket"]["ownerId"] == user["id"]


# ------------------------------------------------------------------ lists


def test_lists_page_newest_first_with_urgent_pinned_for_staff(staff):
    user = _customer("pages")
    made = [_opened(user, subject=f"Page test {n}") for n in range(5)]
    urgent, _first, created = studio_support.open_ticket(
        user["id"], operation_id=_op("stop"), subject="Please stop my ad now", category="ad",
        message="Stop request", priority="urgent", kind="stop_request", enforce_open_limit=False, settings=_settings(),
    )
    assert created and urgent["priority"] == "urgent"
    def pages(person, path, size, **params):
        seen, cursor = [], None
        while True:
            page = _get(person, path, limit=size, **({"cursor": cursor} if cursor else {}), **params).json()
            assert len(page["tickets"]) <= size
            seen += page["tickets"]
            cursor = page["nextCursor"]
            if not cursor:
                return seen

    # Customer: newest first; pages of 2 give the same list as one page, no repeats, no gaps.
    small = pages(user, "/tickets", 2)
    assert small == _get(user, "/tickets", limit=50).json()["tickets"]
    assert {item["id"] for item in small} == {urgent["id"]} | {item["id"] for item in made} and len(small) == 6
    assert [item["createdAt"] for item in small] == sorted((item["createdAt"] for item in small), reverse=True)
    assert small[0]["id"] == urgent["id"]  # opened last
    # Staff (admin): unresolved urgent tickets first, whatever their age, then newest first.
    queue = pages(staff["admin"], "/staff/tickets", 3)
    pinned = [item["priority"] == "urgent" and item["status"] != "resolved" for item in queue]
    assert pinned == sorted(pinned, reverse=True) and pinned[0]
    assert urgent["id"] in [item["id"] for item, flag in zip(queue, pinned) if flag]
    assert queue == pages(staff["admin"], "/staff/tickets", 50)
    assert _get(staff["admin"], "/staff/tickets", limit=1).json()["nextCursor"].startswith("1:")
    urgent_only = _get(staff["admin"], "/staff/tickets", priority="urgent", limit=50).json()["tickets"]
    assert urgent["id"] in [item["id"] for item in urgent_only] and all(item["priority"] == "urgent" for item in urgent_only)
    # Resolved: no longer pinned, and the status filters see it.
    with db_conn() as conn:
        assert studio_support.system_resolve_ticket_conn(conn, urgent["id"], reason="campaign_stopped")["status"] == "resolved"
        assert studio_support.system_resolve_ticket_conn(conn, "tkt_" + "1" * 40, reason="x") is None
    resolved = _get(staff["admin"], "/staff/tickets", status="resolved", limit=50).json()["tickets"]
    assert urgent["id"] in [item["id"] for item in resolved] and all(item["status"] == "resolved" for item in resolved)
    active = _get(user, "/tickets", status="active", limit=50).json()["tickets"]
    assert {item["id"] for item in active} == {item["id"] for item in made}
    for params in ({"priority": "high"}, {"status": "nope"}, {"cursor": "2:1:tkt_" + "0" * 40}):
        _error(_get(staff["admin"], "/staff/tickets", **params), 400, "INVALID_VALUE")


# ------------------------------------------------------------------ numbers


def test_numbers_are_unique_and_in_order_under_parallel_opens():
    owners = [_customer(f"parallel-{n}") for n in range(4)]
    barrier = Barrier(12)

    def open_one(n: int):
        barrier.wait(timeout=10)
        ticket, _first, created = studio_support.open_ticket(
            owners[n % 4]["id"], operation_id=_op("parallel"), subject=f"Parallel {n}", category="other",
            message="Parallel open", settings=_settings(),
        )
        return ticket["seq"], created

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(open_one, range(12)))
    numbers = sorted(seq for seq, _created in results)
    assert all(created for _seq, created in results)
    assert numbers == list(range(numbers[0], numbers[0] + 12))  # unique and without gaps


def test_counter_row_recovers_from_the_highest_number():
    user = _customer("counter")
    before = _opened(user)
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": STUDIO_COUNTERS_TYPE, "id": studio_support.COUNTER_ID})
    after = _opened(user)
    assert int(after["number"][2:]) > int(before["number"][2:])
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted = true WHERE type = :t AND id = :id"), {"t": STUDIO_COUNTERS_TYPE, "id": studio_support.COUNTER_ID})
    third = _opened(user)
    assert int(third["number"][2:]) == int(after["number"][2:]) + 1
    counter = _row(STUDIO_COUNTERS_TYPE, studio_support.COUNTER_ID)
    assert counter["created_by"] is None and not counter["deleted"] and counter["data"]["value"] == int(third["number"][2:])
    assert studio_support.ticket_number(7) == "T-000007" and studio_support.ticket_number(1234567) == "T-1234567"


# ------------------------------------------------------------------ P3-12 anonymisation


def test_anonymise_scrubs_ticket_texts(staff):
    admin = staff["admin"]
    user = _customer("anon")
    other = _customer("anon-other")
    ticket = _opened(user, subject="Secret subject 0912345678", message="My number is 0912345678")
    assert _say(staff["reviewer"], ticket, "We will call 0912345678", staff_route=True).status_code == 200
    kept = _opened(other, subject="Other secret", message="Other words")
    with db_conn() as conn:
        before = conn.execute(text("SELECT id, data_json FROM entities WHERE type IN (:t, :m) AND created_by = :uid"),
                              {"t": SUPPORT_TICKETS_TYPE, "m": SUPPORT_TICKET_MESSAGES_TYPE, "uid": other["id"]}).mappings().all()
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET deleted = true WHERE id = :id"), {"id": user["id"]})
    answer = client.post(f"/api/users/{user['id']}/privacy-anonymize", json={"confirmation": f"ANONYMIZE {user['id']}"},
                         cookies=admin["cookies"])
    assert answer.status_code == 200, answer.text

    row = _row(SUPPORT_TICKETS_TYPE, ticket["id"])
    assert "subject" not in row["data"] and "createFingerprint" not in row["data"]
    assert "0912345678" not in row["data_json"] and "Secret" not in row["data_json"]
    # Ids, number, status and times stay.
    assert (row["data"]["number"], row["data"]["createdAt"], row["data"]["category"]) == (ticket["number"], ticket["createdAt"], "ad")
    assert row["data"]["status"] == "answered" and row["data"]["lastStaffAt"] and row["data"]["messageCount"] == 2
    assert row["data"]["ownerId"] == user["id"] and row["data"]["_lastModified"] == row["last_modified"]
    with db_conn() as conn:
        messages = conn.execute(text("SELECT id, data_json FROM entities WHERE type = :m AND created_by = :uid"),
                                {"m": SUPPORT_TICKET_MESSAGES_TYPE, "uid": user["id"]}).mappings().all()
        assert len(messages) == 2
        for message in messages:
            data = json_loads(message["data_json"])
            assert "text" not in data and data["ticketId"] == ticket["id"] and data["createdAt"] and data["author"]
        # Idempotent: a second run changes nothing.
        assert scrub_studio_personal_data_conn(conn, user["id"])["tickets"] == 0
        after = conn.execute(text("SELECT id, data_json FROM entities WHERE type IN (:t, :m) AND created_by = :uid"),
                             {"t": SUPPORT_TICKETS_TYPE, "m": SUPPORT_TICKET_MESSAGES_TYPE, "uid": other["id"]}).mappings().all()
    assert [dict(r) for r in after] == [dict(r) for r in before] and kept["subject"] == "Other secret"
    staff_view = _get(admin, f"/staff/tickets/{ticket['id']}").json()
    assert staff_view["ticket"]["subject"] == "" and [m["text"] for m in staff_view["messages"]] == ["", ""]
    assert "0912345678" not in json.dumps(_audits(ticket["id"]))


def test_scrub_counts_ticket_rows():
    user = _customer("scrub-count")
    ticket = _opened(user)
    assert _say(user, ticket, "Second message").status_code == 200
    with db_conn() as conn:
        assert scrub_studio_personal_data_conn(conn, user["id"]) == {"profiles": 0, "replyLog": 0, "tickets": 3, "social": 0}
        assert scrub_studio_personal_data_conn(conn, user["id"]) == {"profiles": 0, "replyLog": 0, "tickets": 0, "social": 0}


# ------------------------------------------------------------------ PostgreSQL scenario (studio_ticket_numbers)


def postgres_ticket_numbers() -> None:
    """P3-07 on real PostgreSQL, run by test_postgres_studio_jobs.py (scenario ``studio_ticket_numbers``):
    50 parallel opens by 5 customers get 50 different numbers without gaps; 10 parallel sends of ONE
    operationId make one ticket; 25 parallel opens by one customer stop exactly at the open cap."""
    from server.db import get_engine

    assert get_engine().dialect.name == "postgresql"
    settings = _settings()
    owners = [_customer(f"pg-numbers-{n}") for n in range(5)]

    def together(count: int, action):
        barrier = Barrier(count)

        def run(n):
            barrier.wait(timeout=20)
            return action(n)

        with ThreadPoolExecutor(max_workers=count) as pool:
            return [future.result(timeout=120) for future in [pool.submit(run, n) for n in range(count)]]

    def open_for(owner: dict, n: int, operation: str | None = None):
        try:
            ticket, _first, created = studio_support.open_ticket(
                owner["id"], operation_id=operation or _op("pg"), subject=f"PG ticket {n}", category="other",
                message="Parallel open on PostgreSQL", settings=settings,
            )
            return ticket, created
        except Exception as error:  # the cap refusal of the third part
            return error, False

    results = together(50, lambda n: open_for(owners[n % 5], n))
    assert all(created for _ticket, created in results), results
    numbers = sorted(ticket["seq"] for ticket, _created in results)
    assert numbers == list(range(numbers[0], numbers[0] + 50)), numbers
    assert len({ticket["number"] for ticket, _created in results}) == 50

    one = _op("pg-same")
    same = together(10, lambda n: open_for(owners[0], 0, one))
    assert sum(created for _ticket, created in same) == 1 and len({ticket["id"] for ticket, _c in same}) == 1
    with db_conn() as conn:
        assert conn.execute(text("SELECT count(*) FROM entities WHERE type = :t AND id = :id"),
                            {"t": SUPPORT_TICKETS_TYPE, "id": same[0][0]["id"]}).scalar() == 1

    capped = _customer("pg-cap")
    outcomes = together(25, lambda n: open_for(capped, n))
    opened = [ticket for ticket, created in outcomes if created]
    refused = [error for error, created in outcomes if not created]
    assert len(opened) == studio_support.MAX_OPEN_TICKETS and len(refused) == 5
    assert all(getattr(error, "status_code", None) == 409 and error.detail["code"] == "TICKET_OPEN_LIMIT" for error in refused)
    with db_conn() as conn:
        assert studio_support.count_open_tickets(conn, capped["id"]) == studio_support.MAX_OPEN_TICKETS
        seqs = [int(json_loads(row[0])["seq"]) for row in conn.execute(
            text("SELECT data_json FROM entities WHERE type = :t"), {"t": SUPPORT_TICKETS_TYPE}).all()]
    assert len(seqs) == len(set(seqs)) == 50 + 1 + studio_support.MAX_OPEN_TICKETS
    assert sorted(seqs) == list(range(1, len(seqs) + 1))  # the counter handed out 1..N, nothing skipped


@pytest.fixture(scope="module", autouse=True)
def _desk_rows_cleanup():
    """Tickets, their messages, stop requests and the ticket counter are this module's own; other modules
    assert an empty desk (P3-20 STAFF_DESK_IN_USE), so they are removed when the module ends."""
    yield
    with db_conn() as conn:
        for row_type in ("supportTickets", "supportTicketMessages", "studioStopRequests", "studioCounters"):
            conn.execute(text("DELETE FROM entities WHERE type = :t"), {"t": row_type})
