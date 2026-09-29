"""Review loop round 4, batch BP (ad request form parity and the studio account): the server side.

* n=40 the ad destination reads a phone number with the ONE phone rule (studio_profile.normalize_phone, the
       screens' studioParsePhone): '91 234 5678' is +218912345678 (it was stored as +912345678, an Indian
       number), and '21 333 3333' is refused (it was stored as +213333333, an Algerian number).
* n=27/n=28/n=30 parity: the server keeps an https link with 'phone=' and 'utm_content=', one with '@' in its
       path, and one longer than 500 characters, exactly as typed (the classic client now sends them so).
* n=29 a v2 request (goalDetail 'messages') edited in the classic layout: the PATCH that changes the objective
       and clears the goal (goalDetail '') is accepted; the objective alone is still refused (T9, unchanged).
* n=41 admins remove a customer's WhatsApp number when asked: DELETE /api/studio/staff/customers/{id}/contact
       (admins only, same site), audited ``studio_profile`` "removed" without the number; the contact link
       then answers 409 NO_CONSENT and the customer's own profile shows no number.

Every test builds its own users (unique e-mails per run) through the real routes and removes the rows it made.
"""

import json
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio.ad_campaign_actions import normalize_ad_campaign_destination
from server.systems.ads_studio.studio_profile import normalize_phone, profile_id
from server.systems.ads_studio.studio_types import STUDIO_PROFILES_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR4BPPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
cross_site = TestClient(app, headers={"Origin": "https://evil.example.com"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn"]}
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
PHONE_CASES = json.loads((Path(__file__).parent / "systems" / "ads_studio" / "phone_cases.json").read_text(encoding="utf-8"))["cases"]
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl_r4bp_user")
    email = f"review-loop-r4bp-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R4BP {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    _USERS.append(user_id)
    return {"id": user_id, "cookies": cookies, "role": role}


@pytest.fixture(scope="module")
def people():
    init_db()
    yield {
        "admin": _insert_user("admin", "Admin", {}),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }
    with db_conn() as conn:
        for user_id in _USERS:
            conn.execute(text("DELETE FROM entities WHERE created_by = :uid"), {"uid": user_id})
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": STUDIO_PROFILES_TYPE, "id": profile_id(user_id)})


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


def _customer() -> dict:
    user = _insert_user("customer", "Employee", CUSTOMER_PERMISSIONS)
    bought = client.post("/api/subscriptions/purchase",
                         json={"serviceId": "ad_maker", "idempotencyKey": f"r4bp-sub-{new_id('k')}"},
                         cookies=user["cookies"])
    assert bought.status_code == 200, bought.text
    return user


def _draft(**extra) -> dict:
    return {
        "name": f"R4BP offer {new_id('n')}", "objective": "messages", "platforms": ["facebook"],
        "pageName": "R4BP Page", "primaryText": "Message us.", "callToAction": "Send Message",
        "destination": "https://wa.me/218910000000", "locations": ["Tripoli, Libya"], "ageMin": 18, "ageMax": 55,
        "genders": ["all"], "startDate": "2027-01-10", "endDate": "2027-01-20", "budgetMinorUSD": 2000,
        "budgetType": "lifetime", "creativeImages": [PNG], **extra,
    }


def _create(user: dict, data: dict):
    return client.post(f"/api/collections/{CAMPAIGNS}", json={"id": new_id("campaign"), "data": data},
                       cookies=user["cookies"])


def _patch(user: dict, entity: dict, data: dict):
    return client.patch(f"/api/collections/{CAMPAIGNS}/{entity['id']}",
                        json={"data": data, "expectedLastModified": entity["lastModified"]}, cookies=user["cookies"])


# ------------------------------------------------------------------ n=40: the one phone rule for destinations

def _destination(value):
    return normalize_ad_campaign_destination(value, lambda raw, _field, limit: str(raw or "").strip()[:limit])


def test_a_destination_phone_number_is_read_with_the_one_phone_rule():
    assert _destination("91 234 5678") == "+218912345678"  # was +912345678 (India)
    assert _destination("92-123-4567") == "+218921234567"  # was +921234567 (Pakistan)
    assert _destination("0912345678") == "+218912345678"  # was refused
    assert _destination("00218912345678") == "+218912345678"
    assert _destination("218 91 234 5678") == "+218912345678"
    assert _destination("+44 20 7946 0958") == "+442079460958"
    assert _destination("+912345678") == "+912345678"  # a foreign number typed with its + stays as it is
    for refused in ("21 333 3333", "12345678", "9123456789"):  # were stored as +213…, +1234…, +9123…
        with pytest.raises(HTTPException) as caught:
            _destination(refused)
        assert caught.value.status_code == 400, refused
    # Every number of the shared table that the phone rule reads is a destination in the same form.
    for typed, expected in PHONE_CASES:
        if isinstance(typed, str) and expected:
            assert _destination(typed) == expected == normalize_phone(typed), typed


def test_the_routes_store_the_libyan_form_and_refuse_a_foreign_looking_number(people):
    user = _customer()
    created = _create(user, _draft(destination="91 234 5678"))
    assert created.status_code == 200, created.text
    assert created.json()["data"]["destination"] == "+218912345678"
    refused = _create(user, _draft(destination="21 333 3333"))
    assert refused.status_code == 400 and "destination must be" in refused.text, refused.text


# ------------------------------------------------------------------ n=27, n=28, n=30: links kept as typed

def test_links_with_phone_utm_at_signs_and_over_500_characters_are_kept_whole(people):
    user = _customer()
    long_link = f"https://shop.example.com/p?utm_content=spring&x={'a' * 600}"
    for link in ("https://api.whatsapp.com/send?phone=218912345678&utm_content=spring",
                 "https://www.tiktok.com/@myshop", "https://www.google.com/maps/place/Shop/@32.8872,13.1913,17z",
                 long_link):
        created = _create(user, _draft(destination=link))
        assert created.status_code == 200, created.text
        assert created.json()["data"]["destination"] == link
    for bad in ("https://a.com@evil.com", "https://user:pw@evil.com"):
        assert _create(user, _draft(destination=bad)).status_code == 400, bad


# ------------------------------------------------------------------ n=29: the classic objective change clears the goal

def test_a_v2_request_edited_in_classic_changes_its_objective_with_the_goal_cleared(people):
    user = _customer()
    created = _create(user, _draft(goalDetail="messages"))
    assert created.status_code == 200, created.text
    entity = created.json()
    assert (entity["data"]["goalDetail"], entity["data"]["objective"]) == ("messages", "messages")
    alone = _patch(user, entity, {"objective": "traffic"})
    assert alone.status_code == 400 and "goal detail does not match" in alone.text.lower(), alone.text  # T9 is kept
    cleared = _patch(user, entity, {"objective": "traffic", "goalDetail": ""})
    assert cleared.status_code == 200, cleared.text
    assert (cleared.json()["data"]["goalDetail"], cleared.json()["data"]["objective"]) == ("", "traffic")


# ------------------------------------------------------------------ n=41: admins remove a number when asked

def _profile_audits(owner_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, action, message, metadata_json FROM audit_logs "
                 "WHERE resource_type = :type AND resource_id = :id ORDER BY ts"),
            {"type": STUDIO_PROFILES_TYPE, "id": profile_id(owner_id)},
        ).mappings().all()
    return [dict(row) for row in rows]


def test_an_admin_removes_a_customers_whatsapp_number_audited_without_the_number(people):
    customer = _customer()
    saved = client.put("/api/studio/profile", json={"whatsappNumber": "091 234 5678", "whatsappConsent": True},
                       cookies=customer["cookies"])
    assert saved.status_code == 200 and saved.json()["whatsappNumber"] == "+218912345678", saved.text
    path = f"/api/studio/staff/customers/{customer['id']}/contact"
    assert client.get(path, cookies=people["admin"]["cookies"]).status_code == 200

    # Only an admin, from the Albayan site itself, for a real customer.
    reviewer = client.delete(path, cookies=people["reviewer"]["cookies"])
    assert reviewer.status_code == 403 and reviewer.json()["detail"]["code"] == "ADMIN_ONLY", reviewer.text
    own = client.delete(path, cookies=customer["cookies"])
    assert own.status_code == 403 and own.json()["detail"]["code"] == "STAFF_ONLY", own.text
    other_site = cross_site.delete(path, cookies=people["admin"]["cookies"])
    assert other_site.status_code == 403 and other_site.json()["detail"]["code"] == "CROSS_SITE", other_site.text
    unknown = client.delete(f"/api/studio/staff/customers/{new_id('nobody')}/contact", cookies=people["admin"]["cookies"])
    assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "UNKNOWN_CUSTOMER", unknown.text
    assert client.get("/api/studio/profile", cookies=customer["cookies"]).json()["whatsappNumber"] == "+218912345678"

    removed = client.delete(path, cookies=people["admin"]["cookies"])
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"customerId": customer["id"], "whatsapp": None}
    mine = client.get("/api/studio/profile", cookies=customer["cookies"]).json()
    assert mine["whatsappNumber"] is None and mine["whatsappConsentAt"] is None
    link = client.get(path, cookies=people["admin"]["cookies"])
    assert link.status_code == 409 and link.json()["detail"]["code"] == "NO_CONSENT", link.text

    audits = [row for row in _profile_audits(customer["id"]) if row["action"] == "studio_profile"]
    assert [(row["user_id"], json_loads(row["metadata_json"])["whatsapp"]) for row in audits] == [
        (customer["id"], "set"), (people["admin"]["id"], "removed")]
    assert "912345678" not in json_dumps(audits)  # never the number
    again = client.delete(path, cookies=people["admin"]["cookies"])
    assert again.status_code == 200 and len([row for row in _profile_audits(customer["id"])
                                             if row["action"] == "studio_profile"]) == 2  # nothing to remove, no entry
