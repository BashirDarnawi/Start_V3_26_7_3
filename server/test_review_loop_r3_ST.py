"""Review loop round 3, batch ST (studio roles, wallet and plans): the server halves. Every test here
failed before its fix.

* n12: a customer who tapped the "Ad" (or "Other") chip first and then picked "Payment: PAY-..." in the
  related-item picker opened a STAFF-audience ticket: every reviewer saw the payment question. A ticket
  about a payment is admin-only whatever its category, and an older one still SAVED as 'staff' stays
  hidden from reviewers too (every staff read checks relatedType: ticket, queue, pulse, contact link).
* n14: POST /api/ad-studio/campaigns/{id}/review answered 409 "Only Submitted campaigns can be reviewed"
  for another customer's private Draft / Changes Requested request, where an unknown id answers 404:
  the reviewer learned the draft exists. Now 404 like the link, stop and single-GET routes; the
  reviewer's own retry of the review that sent it back still replays.
* n16: a free (price 0) plan could be bought again and again (a new idempotency key each time), each
  purchase stacking another period, up to ~10 years ahead; the rows kept the service after the owner
  priced the plan. A free plan now renews only near its end (at most two periods ahead).
* n19: the admin "Payments waiting" page flagged "Past the target" by clock minutes while the target
  is in working minutes. GET /api/studio/admin/payments/due gives each waiting request's due time in
  working minutes (studio_hours, the diagnostics rule), keyed by its createdAt.

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
from fastapi.testclient import TestClient
from sqlalchemy import text

from server import subscription_plans
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_settings, studio_stop, studio_support
from server.systems.ads_studio.studio_hours import target_due_at

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR3STPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
_USERS: list[str] = []
_counter = [0]


def _op(label: str = "op") -> str:
    _counter[0] += 1
    return f"{label}-{TAG}-{_counter[0]:05d}"


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl3st_user")
    email = f"review-loop-r3-st-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R3 ST {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
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
        "customer": _insert_user("customer", "Employee", CUSTOMER_PERMISSIONS),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "reviewer2": _insert_user("reviewer2", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "admin": _insert_user("admin", "Admin", {}),
    }


def _help_settings() -> dict:
    value = {key: studio_settings.default_value(key) for key in studio_settings.SETTING_KEYS}
    value["rollout"]["services"]["help"] = "on"
    return value


@pytest.fixture(autouse=True)
def _isolated(people, monkeypatch):
    """The Help service on (no settings row written), rate limits reset, every row of this module's users removed."""
    monkeypatch.setattr(studio_support, "read_all_settings", _help_settings)
    monkeypatch.setattr(studio_support, "check_rate_limit", lambda *a, **k: (True, 1, 0))
    for uid in _USERS:
        for bucket in ("ad-studio:mutations", "studio:payment-due", "studio:diagnostics"):
            reset_rate_limit(f"{bucket}:{uid}")
    yield
    with db_conn() as conn:
        for chunk in (_USERS[i:i + 50] for i in range(0, len(_USERS), 50)):
            params = {f"u{i}": uid for i, uid in enumerate(chunk)}
            names = ", ".join(f":u{i}" for i in range(len(chunk)))
            conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names})"), params)


def _insert_entity(entity_type: str, owner_id: str, data: dict, row_id: str | None = None) -> str:
    row_id = row_id or f"rl3st_{entity_type[:8]}_{TAG}_{secrets.token_hex(4)}"
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": entity_type, "id": row_id, "data": json_dumps({"id": row_id, **data}), "stamp": stamp, "owner": owner_id},
        )
    return row_id


def _row(entity_type: str, row_id: str) -> dict | None:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json FROM entities WHERE type = :type AND id = :id"), {"type": entity_type, "id": row_id},
        ).mappings().first()
    return None if row is None else json_loads(row["data_json"])


# ------------------------------------------------------------------ n12: a ticket about a payment is admin-only


def _staff_ids(person: dict) -> list[str]:
    ids, cursor = [], None
    while True:
        params = {"limit": 50, **({"cursor": cursor} if cursor else {})}
        page = client.get("/api/studio/staff/tickets", params=params, cookies=person["cookies"])
        assert page.status_code == 200, page.text
        ids += [item["id"] for item in page.json()["tickets"]]
        cursor = page.json()["nextCursor"]
        if not cursor:
            return ids


def test_n12_a_ticket_about_a_payment_is_admin_only_whatever_the_category(people):
    customer, reviewer, admin = people["customer"], people["reviewer"], people["admin"]
    reference = "PAY-R3ST" + secrets.token_hex(2).upper()
    _insert_entity("walletPaymentRequests", customer["id"], {"userId": customer["id"], "reference": reference, "status": "pending",
                                                              "createdAt": "2026-09-24T20:00:00.000Z"})
    opened = {}
    for category in ("ad", "other"):
        response = client.post("/api/studio/tickets", json={
            "subject": "Where is my charge?", "category": category, "message": "I sent the money yesterday.",
            "relatedType": "payment", "relatedId": reference, "operationId": _op("n12"),
        }, cookies=customer["cookies"])
        assert response.status_code == 200, response.text
        opened[category] = response.json()["ticket"]
        assert opened[category]["audience"] == "admin", opened[category]  # before: 'staff'
    plain = client.post("/api/studio/tickets", json={
        "subject": "My ad is late", "category": "ad", "message": "Please check.", "operationId": _op("n12"),
    }, cookies=customer["cookies"]).json()["ticket"]
    assert plain["audience"] == "staff"
    reviewer_ids, admin_ids = _staff_ids(reviewer), _staff_ids(admin)
    assert plain["id"] in reviewer_ids
    for ticket in opened.values():
        assert ticket["id"] not in reviewer_ids and ticket["id"] in admin_ids
        hidden = client.get(f"/api/studio/staff/tickets/{ticket['id']}", cookies=reviewer["cookies"])
        assert hidden.status_code == 404 and hidden.json()["detail"]["code"] == "UNKNOWN_TICKET", hidden.text
        assert client.get(f"/api/studio/staff/tickets/{ticket['id']}", cookies=admin["cookies"]).status_code == 200


def test_n12_an_older_payment_ticket_saved_as_staff_stays_admin_only(people, monkeypatch):
    """A payment ticket opened before audience_for took relatedType was SAVED with audience 'staff'
    (category 'ad'). Every staff read checks relatedType too, so a reviewer never reaches it: not the
    ticket, not the queue, not the pulse count, not the customer's contact link through it."""
    monkeypatch.setattr(studio_stop, "check_rate_limit", lambda *a, **k: (True, 1, 0))
    reviewer, admin = people["reviewer"], people["admin"]
    customer = _insert_user("oldpay", "Employee", CUSTOMER_PERMISSIONS)  # nothing else a reviewer could reach

    def pulse(person: dict) -> int:
        response = client.get("/api/studio/staff/pulse", cookies=person["cookies"])
        assert response.status_code == 200, response.text
        return response.json()["openTickets"]

    before = {"reviewer": pulse(reviewer), "admin": pulse(admin)}
    at = "2026-09-20T10:00:00.000Z"
    old = _insert_entity(studio_support.SUPPORT_TICKETS_TYPE, customer["id"], {
        "number": f"T-9{secrets.randbelow(10**5):05d}", "seq": 1, "ownerId": customer["id"], "subject": "Where is my charge?",
        "category": "ad", "audience": "staff", "priority": "normal", "kind": "question", "relatedType": "payment",
        "relatedId": "PAY-R3STOLD1", "status": "open", "createdAt": at, "updatedAt": at, "dueAt": None, "lastMessageAt": at,
        "lastCustomerAt": at, "lastStaffAt": None, "firstStaffAt": None, "resolvedAt": None, "messageCount": 1,
    }, row_id="tkt_" + secrets.token_hex(20))

    hidden = client.get(f"/api/studio/staff/tickets/{old}", cookies=reviewer["cookies"])
    assert hidden.status_code == 404 and hidden.json()["detail"]["code"] == "UNKNOWN_TICKET", hidden.text  # before: 200
    shown = client.get(f"/api/studio/staff/tickets/{old}", cookies=admin["cookies"])
    assert shown.status_code == 200, shown.text
    assert shown.json()["ticket"]["audience"] == "admin"  # read as what it is, whatever the stored field says
    assert old not in _staff_ids(reviewer) and old in _staff_ids(admin)  # before: in the reviewers' queue
    assert pulse(reviewer) == before["reviewer"]  # before: +1
    assert pulse(admin) == before["admin"] + 1
    by_ticket = client.get(f"/api/studio/staff/customers/{customer['id']}/contact", cookies=reviewer["cookies"],
                           params={"relatedType": "ticket", "relatedId": old})
    assert by_ticket.status_code == 404 and by_ticket.json()["detail"]["code"] == "UNKNOWN_CUSTOMER", by_ticket.text  # before: 409
    plain = client.get(f"/api/studio/staff/customers/{customer['id']}/contact", cookies=reviewer["cookies"])
    assert plain.status_code == 404 and plain.json()["detail"]["code"] == "UNKNOWN_CUSTOMER", plain.text  # before: 409
    # An admin still reaches the customer (no number saved, so the consent refusal, not a 404).
    reached = client.get(f"/api/studio/staff/customers/{customer['id']}/contact", cookies=admin["cookies"])
    assert reached.status_code == 409 and reached.json()["detail"]["code"] == "NO_CONSENT", reached.text


# ------------------------------------------------------------------ n14: a private draft answers 404 on review


def _campaign(owner_id: str, status: str, **data) -> str:
    stamp = now_ms()
    campaign_id = f"rl3st_c_{TAG}_{secrets.token_hex(3)}"
    return _insert_entity(CAMPAIGNS, owner_id, {"createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
                                               "name": f"R3 ST {status}", "status": status, **data}, campaign_id)


def _review(person: dict, campaign_id: str, operation: str, decision: str = "Approved", **extra):
    body = {"expectedLastModified": 0, "decision": decision, "operationId": operation, **extra}
    return client.post(f"/api/ad-studio/campaigns/{campaign_id}/review", json=body, cookies=person["cookies"])


def test_n14_review_never_confirms_a_private_draft(people):
    customer, reviewer, reviewer2 = people["customer"], people["reviewer"], people["reviewer2"]
    unknown = _review(reviewer, f"rl3st_nothing_{TAG}", _op("n14"))
    assert unknown.status_code == 404 and unknown.json()["detail"] == "Campaign request not found"
    for status in ("Draft", "Changes Requested"):
        private = _campaign(customer["id"], status)
        response = _review(reviewer, private, _op("n14"))
        assert response.status_code == 404, response.text  # before: 409 "Only Submitted campaigns can be reviewed"
        assert response.json()["detail"] == unknown.json()["detail"]
        again = _review(reviewer, private, _op("n14"), "Rejected", note="No", reviewReasonCode="text_policy")
        assert again.status_code == 404, again.text
    # Reviewer-visible states keep their 409.
    rejected = _campaign(customer["id"], "Rejected")
    visible = _review(reviewer, rejected, _op("n14"))
    assert visible.status_code == 409 and "Only Submitted" in visible.json()["detail"], visible.text
    # The reviewer who sent a request back may still replay that review (its capture release and tombstone);
    # anyone else holding the same operationId learns nothing.
    sent_back_op = _op("n14-sentback")
    sent_back = _campaign(customer["id"], "Changes Requested", lastReviewOperationId=sent_back_op, reviewedBy=reviewer["id"],
                          reviewDecision="Changes Requested", reviewNote="Fix the photo", reviewReasonCode="creative_quality")
    replay = _review(reviewer, sent_back, sent_back_op, "Changes Requested", note="Fix the photo", reviewReasonCode="creative_quality")
    assert replay.status_code == 200 and replay.json()["deleted"] is True and "name" not in replay.json()["data"], replay.text
    other = _review(reviewer2, sent_back, sent_back_op, "Changes Requested", note="Fix the photo", reviewReasonCode="creative_quality")
    assert other.status_code == 404, other.text


# ------------------------------------------------------------------ n16: a free plan never stacks far ahead


def _catalog(price_minor: int, service_id: str) -> dict:
    return {
        "rl3st_free": {"id": "rl3st_free", "name": "R3 free", "nameAr": "مجاني", "serviceIds": [service_id], "priceMinor": price_minor,
                       "currency": "LYD", "durationDays": 30, "active": True, "sortOrder": 0},
    }


def test_n16_a_free_plan_renews_only_near_its_end(people, monkeypatch):
    customer = people["customer"]
    service_id = f"rl3st_service_{TAG}"
    monkeypatch.setattr(subscription_plans, "load_subscription_plans", lambda ctx, conn=None: _catalog(0, service_id))

    first_key = _op("n16-idem")

    def buy(key: str | None = None):
        return client.post("/api/subscriptions/purchase-plan", json={"planId": "rl3st_free", "idempotencyKey": key or _op("n16-idem")},
                           cookies=customer["cookies"])

    first, second = buy(first_key), buy()
    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    third = buy()
    assert third.status_code == 409 and third.json()["detail"] == "A free plan can only be renewed near its end", third.text
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type = 'serviceSubscriptions' AND created_by = :uid"),
                            {"uid": customer["id"]}).mappings().all()
    mine = [json_loads(row["data_json"]) for row in rows if json_loads(row["data_json"]).get("serviceId") == service_id]
    assert len(mine) == 2  # before: 3, and ~123 back-to-back purchases reached ~10 years
    latest = max(datetime.fromisoformat(str(row["expiresAt"]).replace("Z", "+00:00")) for row in mine)
    assert latest <= datetime.now(timezone.utc) + timedelta(days=61)
    # A replay of a committed free purchase still answers (the guard is for NEW sales only).
    replay = buy(first_key)
    assert replay.status_code == 200 and replay.json()["subscriptions"][0]["id"] == first.json()["subscriptions"][0]["id"], replay.text


# ------------------------------------------------------------------ n19: payment due times in working minutes


def test_n19_payment_due_times_count_working_minutes(people):
    customer, reviewer, admin = people["customer"], people["reviewer"], people["admin"]
    # Thursday 22:00 in Tripoli (20:00 UTC): outside the working hours.
    created = "2026-09-24T20:00:00.000Z"
    confirmed_at = "2026-09-24T20:30:00.000Z"
    _insert_entity("walletPaymentRequests", customer["id"], {"userId": customer["id"], "reference": "PAY-R3STDUE1", "status": "pending",
                                                              "amountMinor": 5000, "currency": "LYD", "createdAt": created})
    _insert_entity("walletPaymentRequests", customer["id"], {"userId": customer["id"], "reference": "PAY-R3STDUE2", "status": "confirmed",
                                                              "amountMinor": 5000, "currency": "LYD", "createdAt": confirmed_at,
                                                              "confirmedAt": "2026-09-27T08:00:00.000Z"})
    forbidden = client.get("/api/studio/admin/payments/due", cookies=reviewer["cookies"])
    assert forbidden.status_code == 403 and forbidden.json()["detail"]["code"] == "ADMIN_ONLY", forbidden.text
    response = client.get("/api/studio/admin/payments/due", cookies=admin["cookies"])
    assert response.status_code == 200, response.text  # before: 404 (no such route: the page counted clock minutes)
    due_map = response.json()["dueAt"]
    assert confirmed_at not in due_map  # only requests still waiting
    due = datetime.fromisoformat(due_map[created].replace("Z", "+00:00"))
    start = datetime.fromisoformat(created.replace("Z", "+00:00"))
    assert due == target_due_at("payment", start, studio_settings.read_all_settings())
    target_minutes = int(studio_settings.read_all_settings()["targets"]["paymentConfirmMinutes"])
    # Evenings and weekends do not count: far more than the target in clock minutes (the old flag's rule).
    assert due - start > timedelta(minutes=target_minutes + 8 * 60)
    for key in due_map:
        assert "PAY-" not in key and "rl3st" not in key  # keyed by the request's time only: no reference, no id
