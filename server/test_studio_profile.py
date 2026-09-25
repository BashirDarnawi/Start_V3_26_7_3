"""Albayan Studio profile: GET/PUT /api/studio/profile (plan task P2-07; PLAN.md §7.1, §7.3, §7.5).

* A WhatsApp number is stored only with the owner's consent, and only as E.164 after the same
  rules as the screens' studioParsePhone (the shared table phone_cases.json).
* Only the owner: the routes take no user id, so staff and admins read and write their own row only.
* The audit entry never carries the number; the anonymisation scrub removes it.

Every test creates its own users (unique e-mails per run) and reads only its own rows.
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
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES
from server.systems.ads_studio.social_studio import SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_errors import STUDIO_ERROR_CODES
from server.systems.ads_studio.studio_privacy import scrub_studio_personal_data_conn
from server.systems.ads_studio.studio_profile import (
    AUDIT_ACTION,
    CONSENT_REFUSAL_CODE,
    PHONE_REFUSAL_CODE,
    normalize_phone,
    profile_id,
)
from server.systems.ads_studio.studio_types import STUDIO_PROFILES_TYPE, derived_id

TAG = secrets.token_hex(4)
PASSWORD = "StudioProfilePassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
PHONE_CASES = json.loads((Path(__file__).parent / "systems" / "ads_studio" / "phone_cases.json").read_text(encoding="utf-8"))["cases"]
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("profile_user")
    email = f"studio-profile-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"Profile {label}", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
                "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    for bucket in ("profile-read", "profile-write"):
        reset_rate_limit(f"studio:{bucket}:{user_id}")
    return {"id": user_id, "email": email, "cookies": cookies}


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()  # idempotent; the module may run alone on a fresh in-memory database


def _customer(label: str = "customer") -> dict:
    return _insert_user(label, "Employee", CUSTOMER_PERMISSIONS)


def _get(user: dict, **kwargs):
    return client.get("/api/studio/profile", cookies=user["cookies"], **kwargs)


def _put(user: dict, body, **kwargs):
    return client.put("/api/studio/profile", json=body, cookies=user["cookies"], **kwargs)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code, detail
    return detail


def _row(owner_id: str) -> dict | None:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id, data_json, created_by, deleted, last_modified FROM entities WHERE type = :type AND id = :id"),
            {"type": STUDIO_PROFILES_TYPE, "id": profile_id(owner_id)},
        ).mappings().first()
    return None if row is None else {**dict(row), "data": json_loads(row["data_json"])}


def _audits(row_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, action, resource_type, resource_id, message, metadata_json FROM audit_logs "
                 "WHERE resource_type = :type AND resource_id = :id ORDER BY ts"),
            {"type": STUDIO_PROFILES_TYPE, "id": row_id},
        ).mappings().all()
    return [dict(row) for row in rows]


EMPTY = {"whatsappNumber": None, "whatsappConsentAt": None, "updatedAt": None}


# ------------------------------------------------------------------ the phone rule


def test_profile_phone_rule_matches_the_screens():
    """The shared table: studioParsePhone (15g) gives the same answers (scripts/test-mobile-ui.js)."""
    assert len(PHONE_CASES) >= 30
    wrong = [(raw, want, normalize_phone(raw)) for raw, want in PHONE_CASES if normalize_phone(raw) != want]
    assert wrong == []
    assert normalize_phone(912345678) == "" and normalize_phone(["0912345678"]) == ""  # text only


def test_profile_refusals_use_their_own_codes():
    """PLAN.md §7.3: PHONE_INVALID and CONSENT_REQUIRED are catalogued studio codes (400), and the
    screens' error map (15g STUDIO_ERROR_TEXTS) carries their words (scripts/test-mobile-ui.js)."""
    assert (PHONE_REFUSAL_CODE, CONSENT_REFUSAL_CODE) == ("PHONE_INVALID", "CONSENT_REQUIRED")
    assert STUDIO_ERROR_CODES["PHONE_INVALID"] == 400 and STUDIO_ERROR_CODES["CONSENT_REQUIRED"] == 400
    user = _customer("codes")
    assert _error(_put(user, {"whatsappNumber": "12345", "whatsappConsent": True}), 400, "PHONE_INVALID")["message"]
    assert _error(_put(user, {"whatsappNumber": "0912345678", "whatsappConsent": False}), 400, "CONSENT_REQUIRED")["message"]


# ------------------------------------------------------------------ consent


def test_profile_phone_requires_consent():
    user = _customer("consent")
    assert _get(user).json() == EMPTY
    for body in (
        {"whatsappNumber": "0912345678"},
        {"whatsappNumber": "0912345678", "whatsappConsent": False},
        {"whatsappNumber": "+218 91 234 5678", "whatsappConsent": False},
    ):
        _error(_put(user, body), 400, CONSENT_REFUSAL_CODE)
    assert _row(user["id"]) is None and _get(user).json() == EMPTY and _audits(profile_id(user["id"])) == []

    saved = _put(user, {"whatsappNumber": "٠٩١ ٢٣٤ ٥٦٧٨", "whatsappConsent": True})
    assert saved.status_code == 200, saved.text
    view = saved.json()
    assert view["whatsappNumber"] == "+218912345678" and view["whatsappConsentAt"] and view["updatedAt"]
    assert _get(user).json() == view
    row = _row(user["id"])
    assert row["created_by"] == user["id"] and not row["deleted"]
    assert row["data"]["whatsappNumber"] == "+218912345678" and row["data"]["ownerId"] == user["id"]
    assert row["id"] == derived_id("stp", user["id"])  # the id the anonymisation scrub looks for

    # Changing the number needs consent again; the stored number stays until then.
    _error(_put(user, {"whatsappNumber": "0923456789"}), 400, CONSENT_REFUSAL_CODE)
    assert _get(user).json()["whatsappNumber"] == "+218912345678"


def test_profile_refuses_what_is_not_a_phone_number():
    user = _customer("invalid")
    for raw in ("12345", "abc", "+0123456789", "0912-345-67a", "   ", 912345678, ["0912345678"], {"n": 1}):
        _error(_put(user, {"whatsappNumber": raw, "whatsappConsent": True}), 400, PHONE_REFUSAL_CODE)
    _error(_put(user, ["0912345678"]), 400, "INVALID_REQUEST")
    _error(_put(user, {"whatsappNumber": "0912345678", "whatsappConsent": "yes"}), 400, "INVALID_VALUE")
    assert _row(user["id"]) is None


def test_profile_remove_clears_the_number_and_its_consent():
    user = _customer("remove")
    assert _put(user, {"whatsappNumber": "0912345678", "whatsappConsent": True}).status_code == 200
    for body in ({"whatsappNumber": None}, {"whatsappNumber": ""}, {"whatsappNumber": None, "whatsappConsent": False}):
        removed = _put(user, body)
        assert removed.status_code == 200, removed.text
        assert removed.json()["whatsappNumber"] is None and removed.json()["whatsappConsentAt"] is None
    data = _row(user["id"])["data"]
    assert "whatsappNumber" not in data and "whatsappConsentAt" not in data
    assert _get(user).json()["whatsappNumber"] is None


# ------------------------------------------------------------------ only the owner


def test_profile_is_owner_only():
    owner = _customer("owner")
    other = _customer("other")
    admin = _insert_user("admin", "Admin", {})
    reviewer = _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]})
    assert _put(owner, {"whatsappNumber": "0912345678", "whatsappConsent": True}).status_code == 200
    stored = _row(owner["id"])

    # Every other account reads its own (empty) profile, never the owner's.
    for person in (other, admin, reviewer):
        answer = _get(person)
        assert answer.status_code == 200 and answer.json() == EMPTY, answer.text
        assert "+218912345678" not in answer.text
        for query in ({"userId": owner["id"]}, {"ownerId": owner["id"]}):
            assert _get(person, params=query).json() == EMPTY
    # No route takes a user id: a body naming the owner is refused, and nothing changes.
    for person in (other, admin):
        for field in ("userId", "ownerId"):
            _error(_put(person, {field: owner["id"], "whatsappNumber": None}), 400, "UNKNOWN_FIELD")
    assert _row(owner["id"]) == stored
    # An admin's own save lands on the admin's own row.
    assert _put(admin, {"whatsappNumber": "+44 20 7946 0958", "whatsappConsent": True}).json()["whatsappNumber"] == "+442079460958"
    assert _row(owner["id"]) == stored and _row(admin["id"])["created_by"] == admin["id"]
    assert _get(owner).json()["whatsappNumber"] == "+218912345678"

    # The generic collections API never reaches the row (router-only type).
    assert STUDIO_PROFILES_TYPE in OWNED_TYPES and STUDIO_PROFILES_TYPE in SOCIAL_STUDIO_COLLECTIONS
    for response in (
        client.get(f"/api/collections/{STUDIO_PROFILES_TYPE}", cookies=admin["cookies"]),
        client.get(f"/api/collections/{STUDIO_PROFILES_TYPE}/{profile_id(owner['id'])}", cookies=admin["cookies"]),
    ):
        assert response.status_code == 404, response.text


def test_profile_needs_login_and_the_site_itself():
    assert client.get("/api/studio/profile").status_code == 401
    assert client.put("/api/studio/profile", json={"whatsappNumber": None}).status_code == 401
    user = _customer("origin")
    _error(_put(user, {"whatsappNumber": "0912345678", "whatsappConsent": True}, headers={"Origin": "https://evil.example"}),
           403, "CROSS_SITE")
    assert _row(user["id"]) is None


# ------------------------------------------------------------------ audit, idempotency, other fields


def test_profile_audit_never_holds_the_number():
    user = _customer("audit")
    row_id = profile_id(user["id"])
    steps = [
        ({"whatsappNumber": "091 234 5678", "whatsappConsent": True}, "set"),
        ({"whatsappNumber": "+218912345678", "whatsappConsent": True}, None),  # the same number: nothing happens
        ({"whatsappNumber": "0923456789", "whatsappConsent": True}, "changed"),
        ({"whatsappNumber": None}, "removed"),
        ({"whatsappNumber": ""}, None),  # already removed
    ]
    for body, _change in steps:
        answer = _put(user, body)
        assert answer.status_code == 200, answer.text
    audits = _audits(row_id)
    assert [json.loads(entry["metadata_json"])["whatsapp"] for entry in audits] == ["set", "changed", "removed"]
    for entry in audits:
        assert entry["action"] == AUDIT_ACTION and entry["user_id"] == user["id"]
        written = f"{entry['message']} {entry['metadata_json']}"
        for number in ("218912345678", "912345678", "0912345678", "218923456789", "923456789", "234 5678"):
            assert number not in written, written


def test_profile_repeat_changes_nothing_and_keeps_the_consent_time():
    user = _customer("repeat")
    first = _put(user, {"whatsappNumber": "0912345678", "whatsappConsent": True}).json()
    before = _row(user["id"])
    again = _put(user, {"whatsappNumber": "+218 91 234 5678", "whatsappConsent": True})
    assert again.status_code == 200 and again.json() == first
    assert _row(user["id"]) == before  # not rewritten


def test_profile_keeps_other_fields_and_the_scrub_removes_the_number():
    user = _customer("fields")
    row_id = profile_id(user["id"])
    stamp = now_ms()
    with db_conn() as conn:  # a row another feature wrote first (P3-05 keeps activitySeenAt here)
        conn.execute(text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
        ), {"type": STUDIO_PROFILES_TYPE, "id": row_id, "stamp": stamp, "owner": user["id"],
            "data": json_dumps({"id": row_id, "ownerId": user["id"], "activitySeenAt": "2027-01-01T00:00:00Z", "_lastModified": stamp})})
    assert _put(user, {"whatsappNumber": "0912345678", "whatsappConsent": True}).status_code == 200
    row = _row(user["id"])
    assert row["data"]["activitySeenAt"] == "2027-01-01T00:00:00Z" and row["data"]["whatsappNumber"] == "+218912345678"
    assert row["last_modified"] > stamp and row["data"]["_lastModified"] == row["last_modified"]

    with db_conn() as conn:
        assert scrub_studio_personal_data_conn(conn, user["id"])["profiles"] == 1
    scrubbed = _row(user["id"])
    assert "+218912345678" not in scrubbed["data_json"] and "whatsappConsentAt" not in scrubbed["data"]
    assert scrubbed["data"]["activitySeenAt"] == "2027-01-01T00:00:00Z"
    assert _get(user).json()["whatsappNumber"] is None


def test_profile_reads_a_hand_edited_number_as_none():
    user = _customer("edited")
    row_id = profile_id(user["id"])
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
        ), {"type": STUDIO_PROFILES_TYPE, "id": row_id, "stamp": stamp, "owner": user["id"],
            "data": json_dumps({"id": row_id, "whatsappNumber": "call me <b>maybe</b>", "whatsappConsentAt": "x"})})
    assert _get(user).json() == {"whatsappNumber": None, "whatsappConsentAt": None, "updatedAt": None}

    # The owner is told "no number", so a removal must really remove what the row still holds.
    removed = _put(user, {"whatsappNumber": None})
    assert removed.status_code == 200, removed.text
    assert removed.json()["whatsappNumber"] is None and removed.json()["updatedAt"]
    data = _row(user["id"])["data"]
    assert "whatsappNumber" not in data and "whatsappConsentAt" not in data and "maybe" not in json.dumps(data)
    assert [json.loads(entry["metadata_json"])["whatsapp"] for entry in _audits(row_id)] == ["removed"]
    assert _put(user, {"whatsappNumber": ""}).status_code == 200  # nothing left: no second write
    assert len(_audits(row_id)) == 1


def test_profile_remove_clears_a_number_saved_before_a_stricter_rule():
    """A number stored under an older, looser rule (a Libyan mobile with a digit missing) reads as none
    and is removed on request, consent time included."""
    user = _customer("older-rule")
    row_id = profile_id(user["id"])
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(text(
            "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
            "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp)"
        ), {"type": STUDIO_PROFILES_TYPE, "id": row_id, "stamp": stamp, "owner": user["id"],
            "data": json_dumps({"id": row_id, "whatsappNumber": "+21891234567", "whatsappConsentAt": "2026-01-01T00:00:00Z"})})
    assert normalize_phone("+21891234567") == "" and _get(user).json()["whatsappNumber"] is None
    assert _put(user, {"whatsappNumber": None, "whatsappConsent": False}).status_code == 200
    data = _row(user["id"])["data"]
    assert "whatsappNumber" not in data and "whatsappConsentAt" not in data
    # Setting a number over it is a change, not a first save.
    assert _put(user, {"whatsappNumber": "0912345678", "whatsappConsent": True}).json()["whatsappNumber"] == "+218912345678"
    assert [json.loads(entry["metadata_json"])["whatsapp"] for entry in _audits(row_id)] == ["removed", "set"]
