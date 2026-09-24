"""/api/studio foundation (Albayan Studio plan tasks P0-03, P0-04, P0-05a/b, P0-08).

Every test creates its own users (unique e-mails per run), removes the studioSettings rows it
wrote, restores what was there before, and never depends on counts left by other modules.
"""

import json
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app, validate_entity_id
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES
from server.systems.ads_studio import studio_diagnostics, studio_settings
from server.systems.ads_studio.studio_errors import STUDIO_ERROR_CODES, studio_error
from server.systems.ads_studio.studio_types import (
    STUDIO_REF_ALPHABET,
    STUDIO_SETTINGS_TYPE,
    created_by_or_none,
    derived_id,
    is_studio_ref,
    studio_ref,
)

TAG = secrets.token_hex(4)
PASSWORD = "StudioApiPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _insert_user(label: str, role: str, permissions: dict, *, created_at: int | None = None, name: str | None = None) -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("studio_user")
    email = f"studio-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:created,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": name or f"Studio {label}", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": password_hash.hash_hex,
                "salt": password_hash.salt_hex, "algo": password_hash.algo,
                "iterations": password_hash.iterations, "created": created_at or stamp, "stamp": stamp,
            },
        )
    return {"id": user_id, "email": email}


def _login(user: dict) -> dict:
    response = client.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _insert_campaign(campaign_id: str, owner_id: str, created_iso: str, **data) -> None:
    created = _ms(created_iso)
    body = {"id": campaign_id, "createdBy": owner_id, "_created": created, "_lastModified": created, "_deleted": False}
    body.update(data)
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,false,:created,:owner,:created)"
            ),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "created": created, "owner": owner_id},
        )


def _delete_campaigns(ids) -> None:
    with db_conn() as conn:
        for campaign_id in ids:
            conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), {"type": CAMPAIGNS, "id": campaign_id})


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()  # idempotent; the module may run alone on a fresh in-memory database


@pytest.fixture(scope="module")
def actors(_database):
    users = {
        "admin": _insert_user("admin", "Admin", {}),
        "staff": _insert_user("staff", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "staff2": _insert_user("staff2", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "customer": _insert_user("customer", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
        "customer2": _insert_user("customer2", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
    }
    for user in users.values():
        user["cookies"] = _login(user)
    return users


def _settings_rows() -> list[dict]:
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(
            text("SELECT * FROM entities WHERE type=:type"), {"type": STUDIO_SETTINGS_TYPE}
        ).mappings().all()]


def _replace_settings_rows(rows: list[dict]) -> None:
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type=:type"), {"type": STUDIO_SETTINGS_TYPE})
        for row in rows:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"
                ),
                row,
            )


@pytest.fixture(autouse=True)
def clean_switches(_database, monkeypatch, request):
    """Each test starts from the safe defaults and leaves the table as it found it."""
    monkeypatch.delenv(studio_settings.ENV_SWITCH, raising=False)
    saved = _settings_rows()
    _replace_settings_rows([])
    yield
    _replace_settings_rows(saved)
    if "actors" in request.fixturenames:
        for user in request.getfixturevalue("actors").values():
            reset_rate_limit(f"studio:settings:{user['id']}")
            reset_rate_limit(f"studio:diagnostics:{user['id']}")


def _me(user: dict) -> dict:
    response = client.get("/api/studio/me", cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _put(user: dict, key: str, value, expected_version=0, **kwargs):
    body = {"expectedVersion": expected_version, "value": value}
    return client.put(f"/api/studio/admin/settings/{key}", json=body, cookies=user["cookies"], **kwargs)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code and isinstance(detail["message"], str) and detail["message"]
    return detail


# ------------------------------------------------------------------ /me

def test_me_requires_login():
    client.cookies.clear()
    assert client.get("/api/studio/me").status_code == 401
    assert client.get("/api/studio/me", cookies={"albayan_session": "not-a-session"}).status_code == 401


def test_me_reflects_safe_defaults(actors):
    customer = _me(actors["customer"])
    assert customer == {
        "ui": "classic",
        "services": {"help": False, "stopRequest": False, "tiktok": False},
        "staffDesk": "classic",
        "capabilities": {"fbReplies": "gated", "igReplies": "unavailable", "privateMessages": "unavailable", "tiktok": "unavailable"},
        "intake": {"open": True},
        "isAdmin": False,
        "isStaff": False,
    }
    staff = _me(actors["staff"])
    assert staff["isStaff"] is True and staff["isAdmin"] is False and staff["staffDesk"] == "classic"
    admin = _me(actors["admin"])
    assert admin["isStaff"] is True and admin["isAdmin"] is True and admin["ui"] == "classic"
    record = client.get("/api/studio/admin/settings/intake", cookies=actors["admin"]["cookies"]).json()
    assert record["version"] == 0 and record["value"] == {"open": True, "maxSubmissionsPerDay": 5}


def test_kill_switch_wins(actors, monkeypatch):
    saved = _put(actors["admin"], "rollout", {"ui": "on", "services": {"help": True}})
    assert saved.status_code == 200 and saved.json()["version"] == 1
    for env in (None, "off", "OFF ", "maybe"):  # unset or misspelt = off, the safe side
        if env is None:
            monkeypatch.delenv(studio_settings.ENV_SWITCH, raising=False)
        else:
            monkeypatch.setenv(studio_settings.ENV_SWITCH, env)
        me = _me(actors["customer"])
        assert me["ui"] == "classic", env
        # The kill switch is for the layout only: services stay available in the classic layout.
        assert me["services"]["help"] is True
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "on")
    assert _me(actors["customer"])["ui"] == "v2"
    assert _me(actors["customer2"])["ui"] == "v2"
    # Read at request time: flipping the env back takes effect at once, without a restart of the app object.
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "off")
    assert _me(actors["customer"])["ui"] == "classic"
    # And the record still decides when the env allows it: record off -> classic even with env on.
    assert _put(actors["admin"], "rollout", {"ui": "off"}, expected_version=1).status_code == 200
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "on")
    assert _me(actors["customer"])["ui"] == "classic"


def test_pilot_allowlist(actors, monkeypatch):
    pilot = actors["customer"]["id"]
    assert _put(actors["admin"], "rollout", {"ui": "on", "uiAllowlist": [pilot, pilot]}).status_code == 200
    stored = client.get("/api/studio/admin/settings/rollout", cookies=actors["admin"]["cookies"]).json()
    assert stored["value"]["uiAllowlist"] == [pilot] and stored["envSwitch"] == "off"
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "pilot")  # env pilot narrows a record "on" to the allowlist
    assert _me(actors["customer"])["ui"] == "v2"
    assert _me(actors["customer2"])["ui"] == "classic"
    assert _put(actors["admin"], "rollout", {"ui": "pilot"}, expected_version=1).status_code == 200
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "on")  # record pilot keeps the allowlist even with env on
    assert _me(actors["customer"])["ui"] == "v2"
    assert _me(actors["customer2"])["ui"] == "classic"
    assert _put(actors["admin"], "rollout", {"ui": "off"}, expected_version=2).status_code == 200
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "pilot")
    assert _me(actors["customer"])["ui"] == "classic"  # record off: nobody, allowlist or not


def test_staff_desk_switch_independent(actors, monkeypatch):
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "off")
    assert _put(actors["admin"], "rollout", {"staffDesk": "on", "ui": "off"}).status_code == 200
    staff = _me(actors["staff"])
    assert staff["staffDesk"] == "v2" and staff["ui"] == "classic"  # desk on while the customer layout is killed
    assert _me(actors["admin"])["staffDesk"] == "v2"
    assert _me(actors["customer"])["staffDesk"] == "classic"  # a customer never gets the desk
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "on")
    assert _put(actors["admin"], "rollout", {"staffDesk": "off", "ui": "on"}, expected_version=1).status_code == 200
    staff = _me(actors["staff"])
    assert staff["staffDesk"] == "classic" and staff["ui"] == "v2"  # customer layout on, desk off
    assert _put(
        actors["admin"], "rollout", {"staffDesk": "pilot", "staffAllowlist": [actors["staff"]["id"]]}, expected_version=2
    ).status_code == 200
    assert _me(actors["staff"])["staffDesk"] == "v2"
    assert _me(actors["staff2"])["staffDesk"] == "classic"


# ------------------------------------------------------------- settings

def test_rollout_admin_only(actors):
    for who in ("staff", "customer"):
        _error(_put(actors[who], "rollout", {"ui": "on"}), 403, "ADMIN_ONLY")
        _error(client.get("/api/studio/admin/settings/rollout", cookies=actors[who]["cookies"]), 403, "ADMIN_ONLY")
    client.cookies.clear()
    assert client.put("/api/studio/admin/settings/rollout", json={"expectedVersion": 0, "value": {}}).status_code == 401
    # Same-origin: a change sent from another website is refused before anything else.
    cross = _put(actors["admin"], "rollout", {"ui": "on"}, headers={"Origin": "https://evil.example"})
    _error(cross, 403, "CROSS_SITE")
    assert _settings_rows() == []  # nothing was saved by any refused call
    ok = _put(actors["admin"], "rollout", {"ui": "pilot"})
    assert ok.status_code == 200 and ok.json()["value"]["ui"] == "pilot" and ok.json()["version"] == 1


def test_settings_version_conflict_and_audit(actors):
    started = now_ms()
    first = _put(actors["admin"], "intake", {"maxSubmissionsPerDay": 8})
    assert first.status_code == 200 and first.json()["version"] == 1
    assert first.json()["value"] == {"open": True, "maxSubmissionsPerDay": 8}
    stale = _put(actors["admin"], "intake", {"open": False}, expected_version=0)  # someone saved in between
    detail = _error(stale, 409, "VERSION_CONFLICT")
    assert "version 1" in detail["message"]
    assert client.get("/api/studio/admin/settings/intake", cookies=actors["admin"]["cookies"]).json()["value"]["open"] is True
    second = _put(actors["admin"], "intake", {"open": False}, expected_version=1)
    assert second.status_code == 200 and second.json()["version"] == 2
    assert second.json()["value"] == {"open": False, "maxSubmissionsPerDay": 8}  # a partial change keeps the rest
    assert _me(actors["customer"])["intake"] == {"open": False}
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "SELECT action, metadata_json FROM audit_logs WHERE resource_type=:t AND resource_id=:r "
                "AND user_id=:u AND ts >= :started ORDER BY ts"
            ),
            {"t": STUDIO_SETTINGS_TYPE, "r": derived_id("sts", "intake"), "u": actors["admin"]["id"], "started": started},
        ).mappings().all()
    audits = [json_loads(r["metadata_json"]) for r in rows if r["action"] == "update"]
    assert len(audits) == 2  # the refused save wrote no audit entry
    assert audits[-1]["before"] == {"open": True, "maxSubmissionsPerDay": 8}
    assert audits[-1]["after"] == {"open": False, "maxSubmissionsPerDay": 8} and audits[-1]["version"] == 2
    # One record per key, with created_by NULL (a system row) and a fixed derived id.
    stored = _settings_rows()
    assert len(stored) == 1 and stored[0]["created_by"] is None and stored[0]["id"] == derived_id("sts", "intake")


@pytest.mark.parametrize("key,value,code", [
    ("rollout", {"ui": "maybe"}, "INVALID_VALUE"),
    ("rollout", {"ui": True}, "INVALID_VALUE"),
    ("rollout", {"staffDesk": "v2"}, "INVALID_VALUE"),
    ("rollout", {"uiAllowlist": "user_1"}, "INVALID_VALUE"),
    ("rollout", {"uiAllowlist": ["bad id with spaces"]}, "INVALID_VALUE"),
    ("rollout", {"uiAllowlist": ["system"]}, "INVALID_VALUE"),
    ("rollout", {"uiAllowlist": [f"user_{i}" for i in range(201)]}, "INVALID_VALUE"),
    ("rollout", {"services": {"help": "yes"}}, "INVALID_VALUE"),
    ("rollout", {"services": {"chat": True}}, "UNKNOWN_FIELD"),
    ("rollout", {"everyone": True}, "UNKNOWN_FIELD"),
    ("rollout", ["ui", "on"], "INVALID_REQUEST"),
    ("intake", {"open": "true"}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 0}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 501}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": True}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 5.5}, "INVALID_VALUE"),
    ("capabilities", {"fbReplies": "poll"}, "INVALID_VALUE"),  # poll is Instagram road 1 only
    ("capabilities", {"privateMessages": "yes"}, "INVALID_VALUE"),
    ("capabilities", {"whatsapp": "on"}, "UNKNOWN_FIELD"),
])
def test_invalid_values_are_refused_with_codes(actors, key, value, code):
    _error(_put(actors["admin"], key, value), 400, code)
    assert _settings_rows() == []


def test_settings_request_shape_and_unknown_key(actors):
    admin = actors["admin"]
    url = "/api/studio/admin/settings/rollout"
    _error(client.put(url, json={"value": {"ui": "on"}}, cookies=admin["cookies"]), 400, "INVALID_REQUEST")
    _error(client.put(url, json={"expectedVersion": "0", "value": {}}, cookies=admin["cookies"]), 400, "INVALID_REQUEST")
    _error(client.put(url, json={"expectedVersion": -1, "value": {}}, cookies=admin["cookies"]), 400, "INVALID_REQUEST")
    _error(client.put(url, json={"expectedVersion": 0, "value": {}, "force": True}, cookies=admin["cookies"]), 400, "UNKNOWN_FIELD")
    _error(client.put(url, json=[1, 2], cookies=admin["cookies"]), 400, "INVALID_REQUEST")
    _error(_put(admin, "limits", {"x": 1}), 404, "UNKNOWN_SETTING")
    _error(client.get("/api/studio/admin/settings/limits", cookies=admin["cookies"]), 404, "UNKNOWN_SETTING")
    good = _put(admin, "capabilities", {"igReplies": "poll", "fbReplies": "on"})
    assert good.status_code == 200 and good.json()["value"]["igReplies"] == "poll"
    assert _me(actors["customer"])["capabilities"]["fbReplies"] == "on"


def test_settings_writes_are_rate_limited(actors):
    admin = actors["admin"]
    for _ in range(30):  # refused bodies still count: the limit comes before the work
        assert _put(admin, "rollout", {"ui": "nope"}).status_code == 400
    limited = _put(admin, "rollout", {"ui": "on"})
    _error(limited, 429, "RATE_LIMITED")
    assert int(limited.headers["retry-after"]) >= 1
    assert _settings_rows() == []


def test_stored_garbage_falls_back_to_safe_defaults(actors):
    """A hand-edited or old record never breaks /me: unreadable fields keep their default."""
    stamp = now_ms()
    data = {"settingKey": "rollout", "version": 3,
            "value": {"ui": "sideways", "services": {"help": True, "stopRequest": "x"}, "staffDesk": "on", "junk": 1}}
    _replace_settings_rows([{
        "type": STUDIO_SETTINGS_TYPE, "id": derived_id("sts", "rollout"), "data_json": json_dumps(data),
        "deleted": False, "created_at": stamp, "created_by": None, "last_modified": stamp,
    }])
    me = _me(actors["staff"])
    assert me["ui"] == "classic" and me["services"] == {"help": True, "stopRequest": False, "tiktok": False}
    assert me["staffDesk"] == "v2"
    record = client.get("/api/studio/admin/settings/rollout", cookies=actors["admin"]["cookies"]).json()
    assert record["version"] == 3 and "junk" not in record["value"]


# ------------------------------------------------ the generic API refuses studio types

def test_generic_api_refuses_studio_types(actors):
    admin = actors["admin"]
    assert STUDIO_SETTINGS_TYPE in OWNED_TYPES
    assert _put(admin, "rollout", {"ui": "pilot"}).status_code == 200  # a real row exists
    row_id = derived_id("sts", "rollout")
    base = f"/api/collections/{STUDIO_SETTINGS_TYPE}"
    answers = [
        client.get(base, cookies=admin["cookies"]),
        client.get(f"{base}/{row_id}", cookies=admin["cookies"]),
        client.post(base, json={"id": "sts_forged", "data": {"value": {"ui": "on"}}}, cookies=admin["cookies"]),
        client.patch(f"{base}/{row_id}", json={"data": {"value": {"ui": "on"}}}, cookies=admin["cookies"]),
        client.delete(f"{base}/{row_id}", cookies=admin["cookies"]),
    ]
    for response in answers:
        assert response.status_code == 404 and response.json()["detail"] == "Unknown collection", response.text
    rows = _settings_rows()
    assert len(rows) == 1 and json_loads(rows[0]["data_json"])["value"]["ui"] == "pilot" and not rows[0]["deleted"]


# ------------------------------------------------------------- id helpers

def test_derived_ids_fit_entity_id_rule(actors):
    samples = [
        derived_id("sts", "rollout"),
        derived_id("tkt", "user_" + "f" * 32, "client-request-0001"),
        derived_id("abcdefghijklmnop", "x" * 500, "y" * 500),  # longest prefix, huge parts
        derived_id("acr", "cmp:with.dots_and-dashes"),
    ]
    for value in samples:
        assert validate_entity_id(value) == value and len(value) <= 80
    assert derived_id("tkt", "a", "b") == derived_id("tkt", "a", "b")
    assert derived_id("tkt", "a", "b") != derived_id("tkt", "b", "a") != derived_id("tkm", "a", "b")
    assert len(derived_id("sts", "a")) == len(derived_id("sts", "b" * 300)) == 44
    for bad in [("", "x"), ("Sts", "x"), ("s", "x"), ("sts-x", "x"), ("a" * 17, "x"), ("sts",), ("sts", ""), ("sts", "a|b")]:
        with pytest.raises(ValueError):
            derived_id(*bad)
    with db_conn() as conn:
        assert created_by_or_none(conn, actors["customer"]["id"]) == actors["customer"]["id"]
        for fake in ("system", "SYSTEM", "team", "", None, "user_that_does_not_exist", "bad id"):
            assert created_by_or_none(conn, fake) is None


def test_studio_ref_is_stable_and_prefixed():
    first = studio_ref("cmp_123")
    assert first == studio_ref("cmp_123") and first.startswith("ALB-S-") and len(first) == 14
    assert all(ch in STUDIO_REF_ALPHABET for ch in first[6:])
    assert not set("01OI") & set(STUDIO_REF_ALPHABET) and len(set(STUDIO_REF_ALPHABET)) == 32
    assert is_studio_ref(first) and is_studio_ref(first.lower()) and not is_studio_ref("ALB-S-0000000O")
    assert studio_ref("cmp_123", attempt=1) != first and studio_ref("cmp_123", attempt=1) == studio_ref("cmp_123", 1)
    refs = {studio_ref(f"cmp_{i}") for i in range(2000)}
    assert len(refs) == 2000  # different campaigns, different codes (the assigner still checks)
    with pytest.raises(ValueError):
        studio_ref("")
    with pytest.raises(ValueError):
        studio_ref("cmp_1", attempt=-1)


def test_error_helper_uses_the_catalogue():
    with pytest.raises(HTTPException) as caught:
        studio_error(409, "VERSION_CONFLICT", "changed")
    assert caught.value.status_code == 409 and caught.value.detail == {"code": "VERSION_CONFLICT", "message": "changed"}
    with pytest.raises(ValueError):
        studio_error(400, "VERSION_CONFLICT", "wrong status for this code")
    with pytest.raises(ValueError):
        studio_error(400, "NOT_A_CODE", "unknown code")
    assert all(code.isupper() and 400 <= status < 500 for code, status in STUDIO_ERROR_CODES.items())


# ----------------------------------------------------------- diagnostics

def test_diagnostics_admin_only_no_pii(actors):
    owner = _insert_user("pii-owner", "Employee", {CAMPAIGNS: ["viewOwn"]}, name=f"Pii Marker Person {TAG}")
    campaign_id = f"cmp_pii_{TAG}"
    phone = "+218910000123"
    _insert_campaign(
        campaign_id, owner["id"], "2026-09-01T08:00:00Z",
        status="Approved", name=f"Secret Campaign Name {TAG}", pageName=f"Private Page {TAG}",
        destination=phone, primaryText=f"Call {owner['email']}", budgetMinorUSD=2500,
        submittedAt="2026-09-01T09:00:00Z", reviewedAt="2026-09-01T10:00:00Z", approvedAt="2026-09-01T10:00:00Z",
        endDate="2026-09-05", reviewNote=f"note for {owner['email']}",
        reviewHistory=[{"decision": "Approved", "note": f"ok {phone}", "reviewedAt": "2026-09-01T10:00:00Z",
                        "reviewedBy": actors["staff"]["id"]}],
    )
    try:
        for who in ("staff", "customer"):
            _error(client.get("/api/studio/admin/diagnostics", cookies=actors[who]["cookies"]), 403, "ADMIN_ONLY")
        client.cookies.clear()
        assert client.get("/api/studio/admin/diagnostics").status_code == 401
        response = client.get("/api/studio/admin/diagnostics", cookies=actors["admin"]["cookies"])
        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body["baselines"]) == {"B1", "B2", "B3", "B4", "B5", "B6"}
        assert body["campaigns"]["byStatus"]["Approved"] >= 1 and body["holds"]["count"] >= 0
        assert body["switches"] == {"envStudioV2": "off"}
        for secret in (owner["email"], f"Pii Marker Person {TAG}", f"Secret Campaign Name {TAG}", f"Private Page {TAG}",
                       phone, owner["id"], campaign_id, actors["staff"]["id"], actors["admin"]["id"], "@"):
            assert secret not in response.text, secret
    finally:
        _delete_campaigns([campaign_id])


def _baseline_seed(o1: str, o2: str) -> list[tuple]:
    """(id, owner, created, fields). Expected results are worked out in the test below."""
    t = f"b_{TAG}_"
    return [
        (t + "c1", o1, "2026-09-02T00:00:00Z", dict(
            status="Approved", budgetMinorUSD=1000, submittedAt="2026-09-02T10:00:00Z", reviewedAt="2026-09-02T14:00:00Z",
            approvedAt="2026-09-02T14:00:00Z", endDate="2026-09-10",
            reviewHistory=[{"decision": "Approved", "reviewedAt": "2026-09-02T14:00:00Z"}])),
        (t + "c2", o1, "2026-09-03T00:00:00Z", dict(  # sent back once, resubmitted, approved
            status="Approved", budgetMinorUSD=1000, submittedAt="2026-09-04T00:00:00Z", reviewedAt="2026-09-04T06:00:00Z",
            approvedAt="2026-09-04T06:00:00Z", endDate="2026-09-15",
            reviewHistory=[{"decision": "Changes Requested", "reviewedAt": "2026-09-03T08:00:00Z"},
                           {"decision": "Approved", "reviewedAt": "2026-09-04T06:00:00Z"}])),
        (t + "c3", o2, "2026-09-05T12:00:00Z", dict(  # an old hold
            status="Submitted", budgetMinorUSD=500, submittedAt="2026-09-05T20:00:00Z")),
        (t + "c4", o2, "2026-09-15T00:00:00Z", dict(  # a fresh hold
            status="Submitted", budgetMinorUSD=700, submittedAt="2026-09-18T00:00:00Z")),
        (t + "c5", o2, "2026-09-06T00:00:00Z", dict(
            status="Rejected", budgetMinorUSD=900, submittedAt="2026-09-06T02:00:00Z", reviewedAt="2026-09-07T02:00:00Z",
            rejectedAt="2026-09-07T02:00:00Z", reviewHistory=[{"decision": "Rejected", "reviewedAt": "2026-09-07T02:00:00Z"}])),
        (t + "c6", o2, "2026-09-19T00:00:00Z", dict(status="Draft")),
        (t + "c7", o2, "2026-09-08T00:00:00Z", dict(
            status="Approved", budgetMinorUSD=300, submittedAt="2026-09-09T00:00:00Z", reviewedAt="2026-09-10T00:00:00Z",
            approvedAt="2026-09-10T00:00:00Z", endDate="2026-09-12",
            reviewHistory=[{"decision": "Approved", "reviewedAt": "2026-09-10T00:00:00Z"}])),
        (t + "c8", o2, "2026-09-10T00:00:00Z", dict(  # no budget, unreadable time: not a hold, no timing
            status="Submitted", budgetMinorUSD=0, submittedAt="not-a-date")),
        (t + "c9", o1, "2026-09-01T12:00:00Z", dict(
            status="Stopped", budgetMinorUSD=400, submittedAt="2026-09-01T13:00:00Z", reviewedAt="2026-09-01T15:00:00Z",
            approvedAt="2026-09-01T15:00:00Z", stoppedAt="2026-09-03T00:00:00Z", endDate="2026-09-02",
            reviewHistory=[{"decision": "Approved", "reviewedAt": "2026-09-01T15:00:00Z"}])),
    ]


def test_baselines_from_timestamps(actors):
    o1 = _insert_user("owner1", "Employee", {}, created_at=_ms("2026-09-01T00:00:00Z"))["id"]
    o2 = _insert_user("owner2", "Employee", {}, created_at=_ms("2026-09-05T00:00:00Z"))["id"]
    seed = _baseline_seed(o1, o2)
    for campaign_id, owner, created, fields in seed:
        _insert_campaign(campaign_id, owner, created, **fields)
    now = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    try:
        with db_conn() as conn:  # the real SQL projection, limited to this test's owners
            rows = [r for r in studio_diagnostics.load_campaign_rows(conn) if r["ownerId"] in {o1, o2}]
            joined = studio_diagnostics.load_account_created(conn, [o1, o2])
        assert len(rows) == len(seed)
        report = studio_diagnostics.compute_diagnostics(rows, joined, now)
        assert report["campaigns"] == {"total": 9, "byStatus": {
            "Draft": 1, "Submitted": 3, "Changes Requested": 0, "Approved": 3, "Rejected": 1, "Stopped": 1, "other": 0}}
        assert report["holds"] == {"count": 2}
        b = report["baselines"]
        assert b["B1"] == {"value": 6.0, "unit": "hours", "sample": 5}        # [2, 4, 6, 24, 24]
        assert b["B2"] == {"value": 16.7, "unit": "percent", "sample": 6}     # 1 of 6 decisions sent back
        assert b["B3"] == {"value": 1, "unit": "count", "sample": 2}          # c3 is 14 d 16 h old
        assert b["B4"] == {"value": 2, "unit": "count", "sample": 3}          # c1 and c7 ended > 7 days ago
        assert b["B5"] == {"value": 9.0, "unit": "hours", "sample": 6}        # [1, 2, 8, 10, 24, 72]; c2 left out
        assert b["B6"] == {"value": 67.5, "unit": "hours", "sample": 2}       # owner1 15 h, owner2 120 h

        # The endpoint runs the same code on the whole table (other modules' rows included).
        response = client.get("/api/studio/admin/diagnostics", cookies=actors["admin"]["cookies"])
        assert response.status_code == 200
        live = response.json()
        assert live["campaigns"]["byStatus"]["Submitted"] >= 3 and live["holds"]["count"] >= 2
        assert all(live["baselines"][k] is not None for k in ("B1", "B2", "B5", "B6"))
    finally:
        _delete_campaigns([s[0] for s in seed])


def test_missing_data_gives_null_baselines_not_a_crash():
    empty = studio_diagnostics.compute_diagnostics([], {})
    assert empty["baselines"]["B1"] is None and empty["baselines"]["B2"] is None
    assert empty["baselines"]["B5"] is None and empty["baselines"]["B6"] is None
    assert empty["baselines"]["B3"] == {"value": 0, "unit": "count", "sample": 0}
    assert empty["baselines"]["B4"] == {"value": 0, "unit": "count", "sample": 0}
    junk = [
        {"status": "Approved", "submittedAt": 12345, "reviewedAt": None, "approvedAt": "yesterday", "endDate": None,
         "budgetMinorUSD": "lots", "reviewHistory": "not a list", "createdAtMs": "abc", "ownerId": "x"},
        {"status": "Weird", "reviewHistory": [None, 5, {"decision": "Maybe"}, {"decision": "Approved", "reviewedAt": 7}],
         "createdAtMs": -5, "ownerId": ""},
        {"status": "Submitted", "budgetMinorUSD": 10**30, "submittedAt": "2026-13-45T99:00:00Z"},
        {},
    ]
    report = studio_diagnostics.compute_diagnostics(junk, {"x": "not-ms"})
    assert report["campaigns"]["byStatus"]["other"] == 1 and report["campaigns"]["byStatus"]["Draft"] == 1
    assert report["holds"] == {"count": 1}
    assert report["baselines"]["B1"] is None and report["baselines"]["B5"] is None and report["baselines"]["B6"] is None
    assert report["baselines"]["B2"] == {"value": 0.0, "unit": "percent", "sample": 1}
    json.dumps(report)  # always serialisable
