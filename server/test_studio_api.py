"""/api/studio foundation (Albayan Studio plan tasks P0-03, P0-04, P0-05a/b, P0-08; D36 doors).

Every test creates its own users (unique e-mails per run), removes the studioSettings rows it
wrote, restores what was there before, and never depends on counts left by other modules.
"""

import json
import os
import secrets
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_fields_select_sql, json_loads, now_ms
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
from server.user_directory import access_row, account_created_at, user_exists
from server.wallet_payments import WALLET_PAYMENT_COLLECTION, confirmed_top_up_amounts

TAG = secrets.token_hex(4)
PASSWORD = "StudioApiPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _insert_user(
    label: str, role: str, permissions: dict, *, created_at: int | None = None, name: str | None = None, deleted: bool = False
) -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("studio_user")
    email = f"studio-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,:deleted,:created,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": name or f"Studio {label}", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": password_hash.hash_hex,
                "salt": password_hash.salt_hex, "algo": password_hash.algo,
                "iterations": password_hash.iterations, "deleted": deleted, "created": created_at or stamp, "stamp": stamp,
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


def test_me_reflects_safe_defaults(actors, monkeypatch):
    monkeypatch.setattr(studio_settings, "utc_now", lambda: datetime(2026, 9, 24, 8, 30, tzinfo=timezone.utc))  # Thu 10:30 Tripoli
    customer = _me(actors["customer"])
    workday = {"open": "09:00", "close": "17:00"}
    assert customer == {
        "ui": "classic",
        "services": {"help": False, "stopRequest": False, "tiktok": False},
        "staffDesk": "classic",
        # PLAN.md §7.1 keys; defaults from §8.2 and D8a/D24b/D34 (see studio_settings.DEFAULTS)
        "capabilities": {"fbPublicReply": "gated", "fbPrivateReply": "unavailable", "igPublicReply": "unavailable",
                         "igPrivateReply": "unavailable", "tiktokService": "off"},
        "intake": {"open": True},
        # D4 + D5: $5 - $2,000; the $1 per-day floor too (client limits = server limits, P1-08b)
        "adLimits": {"minTotalMinorUSD": 500, "maxTotalMinorUSD": 200_000, "minPerDayMinorUSD": 100, "maxDays": 90},
        "serviceHours": {  # D11 default: Sun-Thu 09:00-17:00 Tripoli
            "timezone": "Africa/Tripoli", "openNow": True,
            "week": {"sun": workday, "mon": workday, "tue": workday, "wed": workday, "thu": workday, "fri": None, "sat": None},
            "holidays": [], "ramadan": None, "onDutyUntil": None,
        },
        "contact": {"whatsapp": None, "phone": None, "email": None},
        "isAdmin": False,
        "isStaff": False,
        "metaConnection": {"down": False},  # P3-18a: the neutral banner flag (test_studio_meta_health.py)
    }
    staff = _me(actors["staff"])
    assert staff["isStaff"] is True and staff["isAdmin"] is False and staff["staffDesk"] == "classic"
    admin = _me(actors["admin"])
    assert admin["isStaff"] is True and admin["isAdmin"] is True and admin["ui"] == "classic"
    record = client.get("/api/studio/admin/settings/intake", cookies=actors["admin"]["cookies"]).json()
    # The default cap is the maximum (500, in effect no cap) until the owner decides D29 (plan start value 5).
    assert record["version"] == 0 and record["value"] == {"open": True, "maxSubmissionsPerDay": 500}
    assert studio_settings.DEFAULTS["intake"]["maxSubmissionsPerDay"] == studio_settings.MAX_SUBMISSIONS_PER_DAY
    rollout = client.get("/api/studio/admin/settings/rollout", cookies=actors["admin"]["cookies"]).json()
    assert rollout["value"]["services"] == {"help": "off", "stopRequest": "off", "tiktok": "off"}


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


def test_services_follow_the_pilot_allowlist(actors, monkeypatch):
    """PLAN.md §7.1: services off|pilot|on; pilot follows the customer allowlist, never the layout."""
    pilot = actors["customer"]["id"]
    saved = _put(actors["admin"], "rollout", {"uiAllowlist": [pilot], "services": {"help": "pilot", "stopRequest": "on"}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["value"]["services"] == {"help": "pilot", "stopRequest": "on", "tiktok": "off"}
    assert saved.json()["value"]["ui"] == "off"  # the customer layout stays classic for everyone
    for env in ("off", "pilot", "on"):  # the kill switch never touches services
        monkeypatch.setenv(studio_settings.ENV_SWITCH, env)
        me = _me(actors["customer"])
        assert me["ui"] == "classic" and me["services"] == {"help": True, "stopRequest": True, "tiktok": False}, env
        assert _me(actors["customer2"])["services"] == {"help": False, "stopRequest": True, "tiktok": False}, env
    assert _me(actors["staff"])["services"]["help"] is False  # pilot = the allowlist, not the staff
    assert _put(actors["admin"], "rollout", {"services": {"help": "on", "stopRequest": "off"}}, expected_version=1).status_code == 200
    assert _me(actors["customer2"])["services"] == {"help": True, "stopRequest": False, "tiktok": False}


def test_legacy_service_flags_read_as_modes(actors):
    """The first shape stored services as true/false: sent or stored, true is on and false is off."""
    saved = _put(actors["admin"], "rollout", {"services": {"help": True, "tiktok": False}})
    assert saved.status_code == 200 and saved.json()["value"]["services"] == {"help": "on", "stopRequest": "off", "tiktok": "off"}
    stamp = now_ms()
    data = {"settingKey": "rollout", "version": 4, "value": {"services": {"help": True, "stopRequest": False, "tiktok": True}}}
    _replace_settings_rows([{
        "type": STUDIO_SETTINGS_TYPE, "id": derived_id("sts", "rollout"), "data_json": json_dumps(data),
        "deleted": False, "created_at": stamp, "created_by": None, "last_modified": stamp,
    }])
    record = client.get("/api/studio/admin/settings/rollout", cookies=actors["admin"]["cookies"]).json()
    assert record["version"] == 4 and record["value"]["services"] == {"help": "on", "stopRequest": "off", "tiktok": "on"}
    assert _me(actors["customer2"])["services"] == {"help": True, "stopRequest": False, "tiktok": True}


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
    assert [r["action"] for r in rows] == ["studio_setting", "studio_setting"]  # the refused save wrote none
    assert "'studio_setting'" in main_module._AUDIT_KEEP_ACTIONS  # settings history is never cleaned up
    audits = [json_loads(r["metadata_json"]) for r in rows]
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
    ("rollout", {"services": {"help": 1}}, "INVALID_VALUE"),
    ("rollout", {"services": "on"}, "INVALID_VALUE"),
    ("rollout", {"services": {"chat": True}}, "UNKNOWN_FIELD"),
    ("rollout", {"everyone": True}, "UNKNOWN_FIELD"),
    ("rollout", ["ui", "on"], "INVALID_REQUEST"),
    ("intake", {"open": "true"}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 0}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 501}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": True}, "INVALID_VALUE"),
    ("intake", {"maxSubmissionsPerDay": 5.5}, "INVALID_VALUE"),
    ("capabilities", {"fbPublicReply": "poll"}, "INVALID_VALUE"),  # poll is Instagram road 1 only
    ("capabilities", {"igPrivateReply": "poll"}, "INVALID_VALUE"),
    ("capabilities", {"tiktokService": "poll"}, "INVALID_VALUE"),
    ("capabilities", {"fbPrivateReply": "yes"}, "INVALID_VALUE"),
    ("capabilities", {"whatsapp": "on"}, "UNKNOWN_FIELD"),
    ("capabilities", {"fbReplies": "on"}, "UNKNOWN_FIELD"),  # the first draft's key, not PLAN.md §7.1
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
    # D26 = the same ad accounts: PLAN.md's studio-accounts setting is not built.
    _error(_put(admin, "studio-accounts", {"x": 1}), 404, "UNKNOWN_SETTING")
    _error(client.get("/api/studio/admin/settings/studio-accounts", cookies=admin["cookies"]), 404, "UNKNOWN_SETTING")
    good = _put(admin, "capabilities", {"igPublicReply": "poll", "fbPublicReply": "on"})
    assert good.status_code == 200 and good.json()["value"]["igPublicReply"] == "poll"
    assert _me(actors["customer"])["capabilities"]["fbPublicReply"] == "on"


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
    assert record["value"]["services"] == {"help": "on", "stopRequest": "off", "tiktok": "off"}  # legacy true = on


def test_audit_failure_rolls_back_the_save(actors):
    """The setting and its audit entry commit together: a failing audit leaves the switch unchanged."""
    admin = actors["admin"]
    assert _put(admin, "intake", {"maxSubmissionsPerDay": 9}).json()["version"] == 1

    def broken_audit(*_args, **_kwargs):
        raise RuntimeError("audit log unavailable")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(main_module, "audit", broken_audit)  # ctx["audit"] looks main.audit up at call time
        try:
            response = _put(admin, "intake", {"open": False}, expected_version=1)
        except RuntimeError:
            response = None  # the test client re-raises server errors
        assert response is None or response.status_code == 500
    record = client.get("/api/studio/admin/settings/intake", cookies=admin["cookies"]).json()
    assert record["version"] == 1 and record["value"] == {"open": True, "maxSubmissionsPerDay": 9}
    assert _put(admin, "intake", {"open": False}, expected_version=1).json()["version"] == 2  # no 409 on the retry

    def refuse(conn, before, after):
        raise RuntimeError("audit refused")

    with pytest.raises(RuntimeError):  # a first save rolls back too: no row is left behind
        studio_settings.save_setting("capabilities", {"fbPublicReply": "on"}, 0, admin["id"], "2026-09-25T00:00:00Z", audit=refuse)
    assert studio_settings.read_setting("capabilities")["version"] == 0
    assert [r["id"] for r in _settings_rows()] == [derived_id("sts", "intake")]
    seen = {}

    def check_same_transaction(conn, before, after):
        row = conn.execute(text("SELECT data_json FROM entities WHERE type=:t AND id=:id"),
                           {"t": STUDIO_SETTINGS_TYPE, "id": after["id"]}).mappings().first()
        seen.update(before=before["version"], after=after["version"], stored=json_loads(row["data_json"])["version"])

    studio_settings.save_setting("capabilities", {"fbPublicReply": "on"}, 0, admin["id"], "2026-09-25T00:00:00Z",
                                 audit=check_same_transaction)
    assert seen == {"before": 0, "after": 1, "stored": 1}  # the audit callback sees the new row, uncommitted


def test_soft_deleted_setting_never_blocks_a_save(actors):
    """After an admin restore with deleted:true (or a batch delete) the next save brings the row back."""
    admin = actors["admin"]
    assert _put(admin, "intake", {"maxSubmissionsPerDay": 7}).json()["version"] == 1
    created = _settings_rows()[0]["created_at"]
    with db_conn() as conn:
        conn.execute(
            text("UPDATE entities SET deleted = true, last_modified = last_modified + 1 WHERE type=:t AND id=:id"),
            {"t": STUDIO_SETTINGS_TYPE, "id": derived_id("sts", "intake")},
        )
    record = client.get("/api/studio/admin/settings/intake", cookies=admin["cookies"]).json()
    assert record["version"] == 0 and record["value"] == {"open": True, "maxSubmissionsPerDay": 500}  # reads as never saved
    _error(_put(admin, "intake", {"open": False}, expected_version=1), 409, "VERSION_CONFLICT")
    revived = _put(admin, "intake", {"open": False}, expected_version=0)
    assert revived.status_code == 200, revived.text
    # Version 1 was handed out before the delete, so the revive is version 2 and a page still holding 1 gets 409.
    assert revived.json()["version"] == 2 and revived.json()["value"] == {"open": False, "maxSubmissionsPerDay": 500}
    rows = _settings_rows()
    assert len(rows) == 1 and not rows[0]["deleted"] and rows[0]["created_at"] == created  # the same row, revived
    assert json_loads(rows[0]["data_json"])["_deleted"] is False
    assert _me(actors["customer"])["intake"] == {"open": False}
    _error(_put(admin, "intake", {"open": True}, expected_version=1), 409, "VERSION_CONFLICT")
    assert _put(admin, "intake", {"open": True}, expected_version=2).json()["version"] == 3


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


def test_user_directory_door(actors):
    """D36: system code reads users only through server/user_directory.py; deleted users do not count."""
    gone = _insert_user("gone", "Employee", {}, deleted=True, created_at=_ms("2026-01-02T00:00:00Z"))
    live = actors["staff"]
    with db_conn() as conn:
        assert user_exists(conn, live["id"]) is True
        for missing in (gone["id"], "user_missing", "", None):
            assert user_exists(conn, missing) is False
        assert created_by_or_none(conn, gone["id"]) is None  # a deleted account is never a new row's creator
        stamps = account_created_at(conn, [live["id"], gone["id"], "user_missing", ""])
        assert set(stamps) == {live["id"], gone["id"]} and int(stamps[gone["id"]]) == _ms("2026-01-02T00:00:00Z")
        row = access_row(conn, live["id"])
        assert set(row) == {"id", "role", "permissions_json"} and row["role"] == "Employee"
        assert json_loads(row["permissions_json"]) == {CAMPAIGNS: ["view", "review"]}
        assert access_row(conn, gone["id"]) is None and access_row(conn, "") is None


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
            joined = account_created_at(conn, [o1, o2])
        assert len(rows) == len(seed)
        report = studio_diagnostics.compute_diagnostics(rows, joined, now)
        assert report["campaigns"] == {"total": 9, "archived": 0, "byStatus": {
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


def test_archived_requests_keep_history_baselines(actors):
    """An archived request still happened: B1, B2, B5, B6 keep it; byStatus, total, holds, B3, B4 do not."""
    owner = _insert_user("archiver", "Employee", {}, created_at=_ms("2026-09-01T00:00:00Z"))["id"]
    t = f"arc_{TAG}_"
    first = t + "first"  # sent back, then approved: its owner's earliest approval
    _insert_campaign(first, owner, "2026-09-02T00:00:00Z",
                     status="Approved", budgetMinorUSD=1000, submittedAt="2026-09-03T00:00:00Z",
                     reviewedAt="2026-09-03T04:00:00Z", approvedAt="2026-09-03T04:00:00Z", endDate="2026-09-10",
                     reviewHistory=[{"decision": "Changes Requested", "reviewedAt": "2026-09-02T10:00:00Z"},
                                    {"decision": "Approved", "reviewedAt": "2026-09-03T04:00:00Z"}])
    _insert_campaign(t + "later", owner, "2026-09-05T00:00:00Z",
                     status="Approved", budgetMinorUSD=500, submittedAt="2026-09-05T02:00:00Z",
                     reviewedAt="2026-09-05T12:00:00Z", approvedAt="2026-09-05T12:00:00Z", endDate="2026-09-30",
                     reviewHistory=[{"decision": "Approved", "reviewedAt": "2026-09-05T12:00:00Z"}])
    _insert_campaign(t + "hold", owner, "2026-09-06T00:00:00Z",
                     status="Submitted", budgetMinorUSD=700, submittedAt="2026-09-06T01:00:00Z")
    now = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)

    def report() -> dict:
        with db_conn() as conn:
            rows = [r for r in studio_diagnostics.load_campaign_rows(conn) if r["ownerId"] == owner]
            joined = account_created_at(conn, [owner])
        return studio_diagnostics.compute_diagnostics(rows, joined, now)

    try:
        before = report()
        assert before["campaigns"]["total"] == 3 and before["campaigns"]["archived"] == 0
        assert before["campaigns"]["byStatus"]["Approved"] == 2 and before["holds"] == {"count": 1}
        assert before["baselines"]["B2"] == {"value": 33.3, "unit": "percent", "sample": 3}  # 1 of 3 sent back
        assert before["baselines"]["B6"] == {"value": 52.0, "unit": "hours", "sample": 1}    # 09-01 00:00 -> 09-03 04:00
        assert before["baselines"]["B4"] == {"value": 1, "unit": "count", "sample": 2}
        for campaign_id in (first, t + "hold"):  # the real archive route (an admin may archive any status)
            response = client.delete(f"/api/collections/{CAMPAIGNS}/{campaign_id}", cookies=actors["admin"]["cookies"])
            assert response.status_code == 200, response.text
        with db_conn() as conn:
            archived = conn.execute(text("SELECT deleted FROM entities WHERE type=:t AND id=:id"),
                                    {"t": CAMPAIGNS, "id": first}).scalar()
        assert bool(archived)
        after = report()
        assert after["campaigns"]["total"] == 1 and after["campaigns"]["archived"] == 2
        assert after["campaigns"]["byStatus"]["Approved"] == 1 and after["campaigns"]["byStatus"]["Submitted"] == 0
        assert after["holds"] == {"count": 0} and after["baselines"]["B3"] == {"value": 0, "unit": "count", "sample": 0}
        assert after["baselines"]["B4"] == {"value": 0, "unit": "count", "sample": 1}
        for key in ("B1", "B2", "B5", "B6"):  # the history is unchanged by archiving
            assert after["baselines"][key] == before["baselines"][key], key
    finally:
        _delete_campaigns([first, t + "later", t + "hold"])


def test_campaign_rows_sql_parses_json_once_on_postgresql():
    """PostgreSQL casts data_json to jsonb once per row (not once per field); SQLite keeps json_extract."""
    fields = ", ".join(f"(doc ->> '{f}') AS f_{f.lower()}" for f in studio_diagnostics._FIELDS)
    assert studio_diagnostics.campaign_rows_sql("postgresql") == (
        f"SELECT created_at, created_by, deleted, {fields} FROM (SELECT created_at, created_by, deleted, "
        "data_json::jsonb AS doc FROM entities WHERE type = :type OFFSET 0) AS parsed_once"
    )
    sqlite = studio_diagnostics.campaign_rows_sql("sqlite")
    assert "::jsonb" not in sqlite and "json_extract(data_json, '$.reviewHistory') AS f_reviewhistory" in sqlite
    for sql in (sqlite, studio_diagnostics.campaign_rows_sql("postgresql")):
        assert "creativeImages" not in sql and "deleted = false" not in sql  # archived rows are read too
    for bad_fields, bad_columns in ((["x'y"], []), (["ok"], ["data_json; DROP"]), ([], [])):
        with pytest.raises(ValueError):
            json_fields_select_sql(bad_fields, bad_columns, "type = :type", "postgresql")


def _insert_payment(row_id: str, owner_id: str, *, deleted: bool = False, **data) -> None:
    stamp = now_ms()
    body = {"id": row_id, "recordType": "walletPaymentRequest", "userId": owner_id, "reference": f"PAY-{row_id[-8:]}",
            "receiptPhoto": "data:image/png;base64," + "A" * 4000, **data}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:stamp,:owner,:stamp)"
            ),
            {"type": WALLET_PAYMENT_COLLECTION, "id": row_id, "data": json_dumps(body), "deleted": deleted,
             "stamp": stamp, "owner": owner_id},
        )


def test_top_up_presets_are_counts_only(actors):
    """P0-05b, D25: the most common confirmed USD top-ups from Albayan's own history, amounts and counts only."""
    payer = actors["customer"]["id"]
    common = 1_000_000 + int(TAG, 16) % 100_000 * 10  # amounts no other module uses
    second = common + 5
    ids = []

    def add(amount: int, status: str, currency: str | None = "USD", deleted: bool = False) -> None:
        row_id = f"wpr_{TAG}_{len(ids)}"
        ids.append(row_id)
        extra = {"currency": currency} if currency else {}  # a request without a currency is legacy USD
        _insert_payment(row_id, payer, deleted=deleted, amountMinor=amount, status=status, **extra)

    for _ in range(3):
        add(common, "confirmed")
        add(second, "confirmed")
    add(common, "confirmed", currency=None)
    add(common, "pending")
    add(common, "canceled")
    add(second, "confirmed", deleted=True)
    for _ in range(5):
        add(common, "confirmed", currency="LYD")
    try:
        with db_conn() as conn:
            usd = confirmed_top_up_amounts(conn, "USD", limit=100_000)
            lyd = confirmed_top_up_amounts(conn, "LYD", limit=100_000)
            top_one = confirmed_top_up_amounts(conn, "USD", limit=1)
        counts = {e["amountMinor"]: e["count"] for e in usd["amounts"]}
        assert counts[common] == 4 and counts[second] == 3  # pending, canceled, deleted and LYD rows left out
        assert usd["amounts"] == sorted(usd["amounts"], key=lambda e: (-e["count"], e["amountMinor"]))
        assert usd["sample"] == sum(counts.values()) and len(top_one["amounts"]) == 1
        assert {e["amountMinor"]: e["count"] for e in lyd["amounts"]}[common] == 5

        response = client.get("/api/studio/admin/diagnostics", cookies=actors["admin"]["cookies"])
        assert response.status_code == 200, response.text
        presets = response.json()["topUpPresets"]
        assert presets["currency"] == "USD" and presets["sample"] >= 7 and 1 <= len(presets["amounts"]) <= 5
        for entry in presets["amounts"]:
            assert set(entry) == {"amountMinor", "count"} and all(isinstance(v, int) and v > 0 for v in entry.values())
        for secret in [payer, "PAY-", "base64", *ids]:
            assert secret not in json.dumps(presets), secret
    finally:
        with db_conn() as conn:
            for row_id in ids:
                conn.execute(text("DELETE FROM entities WHERE type=:t AND id=:id"), {"t": WALLET_PAYMENT_COLLECTION, "id": row_id})


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


# ------------------------------------ P0-04: limits, settlement, hours, contact, targets, thresholds

NEW_KEYS = ("limits", "settlement", "hours", "contact", "targets", "thresholds")
WORKDAY = {"open": "09:00", "close": "17:00"}
DEFAULT_WEEK = {"sun": WORKDAY, "mon": WORKDAY, "tue": WORKDAY, "wed": WORKDAY, "thu": WORKDAY, "fri": None, "sat": None}


def _utc(*parts) -> datetime:
    return datetime(*parts, tzinfo=timezone.utc)


THURSDAY_1030_TRIPOLI = _utc(2026, 9, 24, 8, 30)  # Tripoli is UTC+2 all year

# key -> (value sent, value stored and read back)
ROUND_TRIPS = {
    "limits": (
        {"minTotalMinorUSD": 1_000, "maxTotalMinorUSD": 150_000, "minPerDayMinorUSD": 200, "maxDays": 30,
         "p1CutoverAt": "2026-10-01T10:00:00+02:00"},
        {"minTotalMinorUSD": 1_000, "maxTotalMinorUSD": 150_000, "minPerDayMinorUSD": 200, "maxDays": 30,
         "p1CutoverAt": "2026-10-01T08:00:00.000Z"},  # kept in UTC
    ),
    "settlement": (
        {"spendDelayHours": 72, "neverDeliveredImmediate": False, "driftWatchDays": 30},
        {"spendDelayHours": 72, "neverDeliveredImmediate": False, "driftWatchDays": 30},
    ),
    "hours": (
        {"timezone": "Africa/Tripoli", "week": {"sat": {"open": "10:00", "close": "14:00"}, "thu": None},
         "holidays": [{"date": "2026-12-24", "labelEn": " Independence Day ", "labelAr": "عيد الاستقلال"}, {"date": "2026-10-10"}],
         "ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"},
         "onDutyUntil": "23:00"},
        {"timezone": "Africa/Tripoli",
         "week": {**DEFAULT_WEEK, "sat": {"open": "10:00", "close": "14:00"}, "thu": None},  # a partial week merges
         "holidays": [{"date": "2026-10-10", "labelEn": "", "labelAr": ""},  # sorted by date, labels optional
                      {"date": "2026-12-24", "labelEn": "Independence Day", "labelAr": "عيد الاستقلال"}],
         "ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"},
         "onDutyUntil": "23:00"},
    ),
    "contact": (
        {"whatsapp": "+218 91 234 5678", "phone": "٠٠٢١٨٢١٤٤٤٤٤٤٤", "email": " help@albayanhub.com ",
         "urgentWhatsapp": "+218-92-000-1111"},
        {"whatsapp": "+218912345678", "phone": "+218214444444", "email": "help@albayanhub.com",
         "urgentWhatsapp": "+218920001111"},  # Arabic digits, spaces and dashes; 00 becomes +
    ),
    "targets": (
        {"reviewBusinessDays": 2, "ticketFirstResponseMinutes": 180, "stopRequestMinutes": 60,
         "paymentConfirmMinutes": 300, "settlementBusinessDays": 3, "tiktokBusinessDays": 2},
        {"reviewBusinessDays": 2, "ticketFirstResponseMinutes": 180, "stopRequestMinutes": 60,
         "paymentConfirmMinutes": 300, "settlementBusinessDays": 3, "tiktokBusinessDays": 2},
    ),
    "thresholds": (
        {"goConsecutiveWeeks": 3, "reconcileToleranceMinorUSD": 1_000, "reconcileToleranceBasisPoints": 50,
         "queueOnTargetPercent": 95, "resultsFreshPercent": 80, "resultsFreshHours": 12, "webhookReplyP95Seconds": 60,
         "pollReplyP95Seconds": 900, "replyFailureMaxPercent": 3, "restoreProofMaxDays": 5, "tokenMinDaysLeft": 21,
         "strandedCaptureMaxMinutes": 30, "replyOutageMaxHours": 4, "heartbeatLateMaxMinutes": 10,
         "tokenExpiryWarnDays": [3, 21, 7, 7]},
        {"goConsecutiveWeeks": 3, "reconcileToleranceMinorUSD": 1_000, "reconcileToleranceBasisPoints": 50,
         "queueOnTargetPercent": 95, "resultsFreshPercent": 80, "resultsFreshHours": 12, "webhookReplyP95Seconds": 60,
         "pollReplyP95Seconds": 900, "replyFailureMaxPercent": 3, "restoreProofMaxDays": 5, "tokenMinDaysLeft": 21,
         "strandedCaptureMaxMinutes": 30, "replyOutageMaxHours": 4, "heartbeatLateMaxMinutes": 10,
         "tokenExpiryWarnDays": [21, 7, 3]},  # repeats dropped, largest first
    ),
}


def _get_setting(user: dict, key: str) -> dict:
    response = client.get(f"/api/studio/admin/settings/{key}", cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _store(values: dict, version: int = 3) -> None:
    """Rows written by hand (an old release or a manual edit), bypassing every save rule."""
    stamp = now_ms()
    _replace_settings_rows([{
        "type": STUDIO_SETTINGS_TYPE, "id": derived_id("sts", key),
        "data_json": json_dumps({"settingKey": key, "version": version, "value": value}),
        "deleted": False, "created_at": stamp, "created_by": None, "last_modified": stamp,
    } for key, value in values.items()])


def test_new_settings_start_from_the_decided_defaults(actors):
    admin = actors["admin"]
    records = {key: _get_setting(admin, key) for key in NEW_KEYS}
    assert all(record["version"] == 0 and record["updatedAt"] is None for record in records.values())
    assert records["limits"]["value"] == {  # D4 + D5 (owner): $5 - $2,000; $1 per-day floor until P0-01(f)
        "minTotalMinorUSD": 500, "maxTotalMinorUSD": 200_000, "minPerDayMinorUSD": 100, "maxDays": 90, "p1CutoverAt": None}
    assert records["settlement"]["value"] == {"spendDelayHours": 48, "neverDeliveredImmediate": True, "driftWatchDays": 28}  # D28
    assert records["hours"]["value"] == {  # D11 [ASSUMPTION until the owner confirms]
        "timezone": "Africa/Tripoli", "week": DEFAULT_WEEK, "holidays": [], "ramadan": None, "onDutyUntil": None}
    assert records["contact"]["value"] == {"whatsapp": None, "phone": None, "email": None, "urgentWhatsapp": None}
    assert records["targets"]["value"] == {  # D11: 1 business day, 4 h, 2 h, 4 h, 2 business days, 1 business day
        "reviewBusinessDays": 1, "ticketFirstResponseMinutes": 240, "stopRequestMinutes": 120,
        "paymentConfirmMinutes": 240, "settlementBusinessDays": 2, "tiktokBusinessDays": 1}
    thresholds = records["thresholds"]["value"]  # D32 / PLAN.md §12.8
    assert thresholds["reconcileToleranceMinorUSD"] == 500 and thresholds["reconcileToleranceBasisPoints"] == 100
    assert thresholds["queueOnTargetPercent"] == 90 and thresholds["goConsecutiveWeeks"] == 2
    assert (thresholds["resultsFreshPercent"], thresholds["resultsFreshHours"]) == (90, 6)
    assert (thresholds["webhookReplyP95Seconds"], thresholds["pollReplyP95Seconds"], thresholds["replyFailureMaxPercent"]) == (120, 600, 5)
    assert (thresholds["strandedCaptureMaxMinutes"], thresholds["replyOutageMaxHours"], thresholds["heartbeatLateMaxMinutes"]) == (60, 6, 15)
    assert thresholds["tokenExpiryWarnDays"] == [14, 7, 2] and thresholds["tokenMinDaysLeft"] == 14
    assert set(studio_settings.SETTING_KEYS) == {"rollout", "intake", "capabilities", *NEW_KEYS}  # no studio-accounts (D26)


@pytest.mark.parametrize("key", NEW_KEYS)
def test_every_new_setting_round_trips(actors, key):
    admin = actors["admin"]
    sent, expected = ROUND_TRIPS[key]
    started = now_ms()
    saved = _put(admin, key, sent)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1 and saved.json()["value"] == expected
    assert _get_setting(admin, key)["value"] == expected  # read back through today's rules unchanged
    assert studio_settings.read_all_settings()[key] == expected
    again = _put(admin, key, expected, expected_version=1)  # the stored shape is accepted as it is
    assert again.status_code == 200 and again.json()["version"] == 2 and again.json()["value"] == expected
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT metadata_json FROM audit_logs WHERE action='studio_setting' AND resource_id=:r AND ts >= :t ORDER BY ts"),
            {"r": derived_id("sts", key), "t": started},
        ).mappings().all()
    audits = [json_loads(r["metadata_json"]) for r in rows]
    assert [a["version"] for a in audits] == [1, 2] and audits[0]["after"] == expected
    assert audits[0]["before"] == studio_settings.DEFAULTS[key] and audits[0]["key"] == key


def test_partial_saves_keep_the_other_fields(actors):
    admin = actors["admin"]
    assert _put(admin, "limits", {"p1CutoverAt": "2026-10-01T08:00:00Z"}).json()["value"] == {
        "minTotalMinorUSD": 500, "maxTotalMinorUSD": 200_000, "minPerDayMinorUSD": 100, "maxDays": 90,
        "p1CutoverAt": "2026-10-01T08:00:00.000Z"}
    cleared = _put(admin, "limits", {"p1CutoverAt": None, "maxDays": 45}, expected_version=1)
    assert cleared.json()["value"]["p1CutoverAt"] is None and cleared.json()["value"]["maxDays"] == 45
    assert _put(admin, "contact", {"whatsapp": "+218912345678", "email": "help@albayanhub.com"}).status_code == 200
    emptied = _put(admin, "contact", {"whatsapp": ""}, expected_version=1)  # "" or null = not shown
    assert emptied.json()["value"] == {"whatsapp": None, "phone": None, "email": "help@albayanhub.com", "urgentWhatsapp": None}
    week = _put(admin, "hours", {"week": {"fri": {"open": "10:00", "close": "12:00"}}}).json()["value"]["week"]
    assert week == {**DEFAULT_WEEK, "fri": {"open": "10:00", "close": "12:00"}}


_SIXTY_ONE_DAYS = [{"date": (date(2027, 1, 1) + timedelta(days=i)).isoformat()} for i in range(61)]


@pytest.mark.parametrize("key,value,code", [
    # limits: whole US cents, $1 minimum totals, the $1,000,000 request ceiling, 1-90 days, a time with its zone
    ("limits", {"minTotalMinorUSD": 99}, "INVALID_VALUE"),
    ("limits", {"maxTotalMinorUSD": 100_000_001}, "INVALID_VALUE"),
    ("limits", {"minTotalMinorUSD": "500"}, "INVALID_VALUE"),
    ("limits", {"minTotalMinorUSD": 500.0}, "INVALID_VALUE"),
    ("limits", {"minPerDayMinorUSD": 0}, "INVALID_VALUE"),
    ("limits", {"maxDays": 0}, "INVALID_VALUE"),
    ("limits", {"maxDays": 91}, "INVALID_VALUE"),
    ("limits", {"maxDays": True}, "INVALID_VALUE"),
    ("limits", {"p1CutoverAt": "2026-10-01"}, "INVALID_VALUE"),
    ("limits", {"p1CutoverAt": "2026-10-01T08:00:00"}, "INVALID_VALUE"),  # no zone
    ("limits", {"p1CutoverAt": "2026-13-01T08:00:00Z"}, "INVALID_VALUE"),
    ("limits", {"p1CutoverAt": "2019-12-31T08:00:00Z"}, "INVALID_VALUE"),
    ("limits", {"p1CutoverAt": 1_790_000_000_000}, "INVALID_VALUE"),
    # moved to UTC these fall off the calendar (OverflowError): still a 400, never a 500
    ("limits", {"p1CutoverAt": "0001-01-01T00:30:00+01:00"}, "INVALID_VALUE"),
    ("limits", {"p1CutoverAt": "9999-12-31T23:59:59-01:00"}, "INVALID_VALUE"),
    ("limits", {"minTotalMinorUSD": 300_000}, "INVALID_VALUE"),  # above the (default) maximum
    ("limits", {"maxTotalMinorUSD": 400}, "INVALID_VALUE"),      # below the (default) minimum
    ("limits", {"minPerDayMinorUSD": 600}, "INVALID_VALUE"),     # a floor above the minimum total
    ("limits", {"minTotal": 500}, "UNKNOWN_FIELD"),
    ("limits", [500, 200_000], "INVALID_REQUEST"),
    # settlement: 0-168 hours, 1-90 days, and the watch must outlast the wait
    ("settlement", {"spendDelayHours": -1}, "INVALID_VALUE"),
    ("settlement", {"spendDelayHours": 169}, "INVALID_VALUE"),
    ("settlement", {"neverDeliveredImmediate": "yes"}, "INVALID_VALUE"),
    ("settlement", {"driftWatchDays": 91}, "INVALID_VALUE"),
    ("settlement", {"driftWatchDays": 1}, "INVALID_VALUE"),  # 24 h < the 48 h wait
    ("settlement", {"driftWatchDays": 2}, "INVALID_VALUE"),  # 48 h = the 48 h wait: the watch must outlast it
    ("settlement", {"spendDelayHours": 168, "driftWatchDays": 7}, "INVALID_VALUE"),  # 7 x 24 = 168: equal is refused
    ("settlement", {"waitHours": 48}, "UNKNOWN_FIELD"),
    # hours
    ("hours", {"timezone": "Europe/London"}, "INVALID_VALUE"),
    ("hours", {"timezone": "UTC"}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "9:00", "close": "17:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "17:00", "close": "09:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "09:00", "close": "09:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "09:00", "close": "24:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "09:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "٠٩:٠٠", "close": "12:00"}}}, "INVALID_VALUE"),
    ("hours", {"week": {"fri": {"open": "09:00", "close": "12:00", "note": "x"}}}, "UNKNOWN_FIELD"),
    ("hours", {"week": {"friday": None}}, "UNKNOWN_FIELD"),
    ("hours", {"week": "sun-thu"}, "INVALID_VALUE"),
    ("hours", {"week": {day: None for day in ("sun", "mon", "tue", "wed", "thu", "fri", "sat")}}, "INVALID_VALUE"),
    ("hours", {"holidays": ["2026-12-24"]}, "INVALID_VALUE"),
    ("hours", {"holidays": {"date": "2026-12-24"}}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "24/12/2026"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-02-30"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "٢٠٢٦-١٢-٢٤"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2101-01-01"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-12-24"}, {"date": "2026-12-24", "labelEn": "again"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-12-24", "labelEn": "<b>Holiday</b>"}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-12-24", "labelAr": "ع" * 61}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-12-24", "labelAr": 5}]}, "INVALID_VALUE"),
    ("hours", {"holidays": [{"date": "2026-12-24", "name": "x"}]}, "UNKNOWN_FIELD"),
    ("hours", {"holidays": _SIXTY_ONE_DAYS}, "INVALID_VALUE"),
    ("hours", {"ramadan": {"from": "2027-03-09", "to": "2027-02-08", "open": "10:00", "close": "15:00"}}, "INVALID_VALUE"),
    ("hours", {"ramadan": {"from": "2027-02-01", "to": "2027-03-09", "open": "10:00", "close": "15:00"}}, "INVALID_VALUE"),
    ("hours", {"ramadan": {"from": "2027-02-08", "to": "2027-03-09"}}, "INVALID_VALUE"),
    ("hours", {"ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "15:00", "close": "10:00"}}, "INVALID_VALUE"),
    ("hours", {"ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00", "days": []}}, "UNKNOWN_FIELD"),
    ("hours", {"ramadan": "2027-02-08"}, "INVALID_VALUE"),
    ("hours", {"onDutyUntil": "11pm"}, "INVALID_VALUE"),
    ("hours", {"openNow": True}, "UNKNOWN_FIELD"),  # computed by the server, never stored
    # contact: international numbers and a plain e-mail address only
    ("contact", {"whatsapp": "0912345678"}, "INVALID_VALUE"),  # no country code
    ("contact", {"whatsapp": "+218 91 abc"}, "INVALID_VALUE"),
    ("contact", {"whatsapp": "<a href='https://x'>+218912345678</a>"}, "INVALID_VALUE"),
    ("contact", {"phone": "+0218912345678"}, "INVALID_VALUE"),
    ("contact", {"phone": "+2189"}, "INVALID_VALUE"),
    ("contact", {"phone": 218912345678}, "INVALID_VALUE"),
    ("contact", {"email": "not-an-email"}, "INVALID_VALUE"),
    ("contact", {"email": "<script>@albayanhub.com"}, "INVALID_VALUE"),
    ("contact", {"email": "help@albayanhub"}, "INVALID_VALUE"),
    ("contact", {"urgentWhatsapp": "call Ali"}, "INVALID_VALUE"),
    ("contact", {"facebook": "albayan"}, "UNKNOWN_FIELD"),
    # targets: ranges, and a stop request never slower than an ordinary ticket
    ("targets", {"reviewBusinessDays": 0}, "INVALID_VALUE"),
    ("targets", {"reviewBusinessDays": 11}, "INVALID_VALUE"),
    ("targets", {"ticketFirstResponseMinutes": 10}, "INVALID_VALUE"),
    ("targets", {"stopRequestMinutes": 481}, "INVALID_VALUE"),
    ("targets", {"paymentConfirmMinutes": 2401}, "INVALID_VALUE"),
    ("targets", {"stopRequestMinutes": 300}, "INVALID_VALUE"),         # above the 240-minute ticket target
    ("targets", {"ticketFirstResponseMinutes": 60}, "INVALID_VALUE"),  # below the 120-minute stop target
    ("targets", {"reviewHours": 8}, "UNKNOWN_FIELD"),
    # thresholds
    ("thresholds", {"queueOnTargetPercent": 101}, "INVALID_VALUE"),
    ("thresholds", {"queueOnTargetPercent": 49}, "INVALID_VALUE"),
    ("thresholds", {"reconcileToleranceBasisPoints": 1001}, "INVALID_VALUE"),
    ("thresholds", {"reconcileToleranceMinorUSD": -1}, "INVALID_VALUE"),
    ("thresholds", {"goConsecutiveWeeks": 1.5}, "INVALID_VALUE"),
    ("thresholds", {"tokenExpiryWarnDays": []}, "INVALID_VALUE"),
    ("thresholds", {"tokenExpiryWarnDays": [30, 14, 7, 3, 2, 1]}, "INVALID_VALUE"),
    ("thresholds", {"tokenExpiryWarnDays": [0]}, "INVALID_VALUE"),
    ("thresholds", {"tokenExpiryWarnDays": "14,7,2"}, "INVALID_VALUE"),
    ("thresholds", {"integrityViolationsMax": 1}, "UNKNOWN_FIELD"),  # zero-tolerance rows are fixed rules
])
def test_new_settings_refuse_invalid_values_with_codes(actors, key, value, code):
    _error(_put(actors["admin"], key, value), 400, code)
    assert _settings_rows() == []


def test_limits_rules_hold_across_partial_saves(actors):
    admin = actors["admin"]
    both = _put(admin, "limits", {"minTotalMinorUSD": 300_000, "maxTotalMinorUSD": 400_000})  # one save may move both
    assert both.status_code == 200, both.text
    detail = _error(_put(admin, "limits", {"maxTotalMinorUSD": 250_000}, expected_version=1), 400, "INVALID_VALUE")
    assert "maxTotalMinorUSD" in detail["message"]  # checked against the stored minimum
    _error(_put(admin, "limits", {"minPerDayMinorUSD": 300_001}, expected_version=1), 400, "INVALID_VALUE")
    assert _put(admin, "limits", {"minPerDayMinorUSD": 300_000}, expected_version=1).json()["version"] == 2  # equal is fine
    assert _put(admin, "limits", {"minTotalMinorUSD": 400_000}, expected_version=2).json()["version"] == 3  # min == max is fine
    _error(_put(admin, "limits", {"minTotalMinorUSD": 299_999}, expected_version=3), 400, "INVALID_VALUE")  # below the floor
    assert _get_setting(admin, "limits")["version"] == 3  # refused saves never used a version
    assert _me(actors["customer"])["adLimits"] == {
        "minTotalMinorUSD": 400_000, "maxTotalMinorUSD": 400_000, "minPerDayMinorUSD": 300_000, "maxDays": 90}


def test_settlement_and_target_rules_between_fields(actors):
    admin = actors["admin"]
    # The drift watch must outlast the settle wait: 7 x 24 = 168 h equals the wait and is refused.
    _error(_put(admin, "settlement", {"spendDelayHours": 168, "driftWatchDays": 7}), 400, "INVALID_VALUE")
    assert _put(admin, "settlement", {"spendDelayHours": 168, "driftWatchDays": 8}).status_code == 200  # 192 h > 168 h
    _error(_put(admin, "settlement", {"driftWatchDays": 7}, expected_version=1), 400, "INVALID_VALUE")  # partial: equal again
    zero = _put(admin, "settlement", {"spendDelayHours": 0, "driftWatchDays": 1}, expected_version=1)
    assert zero.status_code == 200 and zero.json()["value"]["spendDelayHours"] == 0
    assert _put(admin, "targets", {"stopRequestMinutes": 240}).status_code == 200  # equal to the ticket target
    _error(_put(admin, "targets", {"ticketFirstResponseMinutes": 239}, expected_version=1), 400, "INVALID_VALUE")
    both = _put(admin, "targets", {"ticketFirstResponseMinutes": 60, "stopRequestMinutes": 30}, expected_version=1)
    assert both.status_code == 200 and both.json()["version"] == 2


def test_stored_new_settings_are_renormalised_on_read(actors, monkeypatch):
    """A hand-edited row is read through today's rules: bad fields, entries and items fall back one by
    one, the rules between fields still hold, and /me never breaks or shows what failed."""
    monkeypatch.setattr(studio_settings, "utc_now", lambda: THURSDAY_1030_TRIPOLI)
    _store({
        "limits": {"minTotalMinorUSD": 300_000, "maxTotalMinorUSD": 400_000, "minPerDayMinorUSD": 10**12,
                   "maxDays": "30", "junk": 1},
        "hours": {"timezone": "Europe/London",
                  "week": {"sun": {"open": "18:00", "close": "08:00"}, "fri": {"open": "10:00", "close": "13:00"}, "xyz": {}},
                  "holidays": [{"date": "2026-12-24", "labelEn": "Independence Day"}, {"date": "bad"}, {"date": "2026-12-24"},
                               "2026-10-10", {"date": "2026-10-07", "labelAr": "<script>"}],
                  "ramadan": {"from": "2027-02-08", "to": "2027-01-01", "open": "10:00", "close": "15:00"},
                  "onDutyUntil": "25:00"},
        "contact": {"whatsapp": "<b>call us</b>", "phone": "+218 21 444 4444", "email": "help@albayanhub.com",
                    "urgentWhatsapp": 5},
        "targets": {"stopRequestMinutes": 400, "ticketFirstResponseMinutes": 300},
        "thresholds": {"tokenExpiryWarnDays": [30, "x", 3, 30], "queueOnTargetPercent": 150},
        "settlement": "not an object",
    })
    admin = actors["admin"]
    limits = _get_setting(admin, "limits")
    # min 300,000 is kept once max 400,000 is read (the second pass); the rest fall back to the defaults.
    assert limits["version"] == 3 and limits["value"] == {
        "minTotalMinorUSD": 300_000, "maxTotalMinorUSD": 400_000, "minPerDayMinorUSD": 100, "maxDays": 90, "p1CutoverAt": None}
    assert _get_setting(admin, "hours")["value"] == {
        "timezone": "Africa/Tripoli", "week": {**DEFAULT_WEEK, "fri": {"open": "10:00", "close": "13:00"}},
        "holidays": [{"date": "2026-12-24", "labelEn": "Independence Day", "labelAr": ""}],
        "ramadan": None, "onDutyUntil": None}
    assert _get_setting(admin, "contact")["value"] == {
        "whatsapp": None, "phone": "+218214444444", "email": "help@albayanhub.com", "urgentWhatsapp": None}
    targets = _get_setting(admin, "targets")["value"]  # a stop target above the ticket target is never read back
    assert targets["ticketFirstResponseMinutes"] == 300 and targets["stopRequestMinutes"] == 120
    thresholds = _get_setting(admin, "thresholds")["value"]
    assert thresholds["tokenExpiryWarnDays"] == [30, 3] and thresholds["queueOnTargetPercent"] == 90
    assert _get_setting(admin, "settlement")["value"] == studio_settings.DEFAULTS["settlement"]
    response = client.get("/api/studio/me", cookies=actors["customer"]["cookies"])
    assert response.status_code == 200, response.text
    me = response.json()
    assert me["contact"] == {"whatsapp": None, "phone": "+218214444444", "email": "help@albayanhub.com"}
    assert me["adLimits"] == {"minTotalMinorUSD": 300_000, "maxTotalMinorUSD": 400_000, "minPerDayMinorUSD": 100, "maxDays": 90}
    assert me["serviceHours"]["openNow"] is True and "<" not in response.text
    # The next save starts from the clean value, so nothing refused is ever written back.
    saved = _put(admin, "hours", {"onDutyUntil": "22:00"}, expected_version=3)
    assert saved.status_code == 200 and saved.json()["value"]["timezone"] == "Africa/Tripoli"
    stored = json_loads(next(r for r in _settings_rows() if r["id"] == derived_id("sts", "hours"))["data_json"])
    assert stored["value"]["holidays"] == [{"date": "2026-12-24", "labelEn": "Independence Day", "labelAr": ""}]


def test_long_allowlists_with_bad_ids_are_salvaged_in_one_pass(actors, monkeypatch):
    """A stored rollout with 200 + 200 ids and a few bad ones keeps every valid id (in order, a repeat
    once) and drops the bad ones. Each id is checked a few times, not once per id kept before it: the
    old item-by-item pass made tens of thousands of checks here (~100 ms on every /me). Counted, not timed."""
    ui = [f"studio_user_ui_{index:03d}" for index in range(200)]
    staff = [f"studio_user_staff_{index:03d}" for index in range(200)]
    bad = {7: "bad id!", 50: 5, 120: "<b>x</b>", 199: None}
    for index, item in bad.items():
        ui[index] = item
    ui[150] = actors["customer"]["id"]
    staff[10] = "system"  # a placeholder, never a user id
    staff[20] = staff[19]  # a repeat
    staff[100] = actors["staff"]["id"]
    checks: list[str] = []
    real = studio_settings.looks_like_user_id
    monkeypatch.setattr(studio_settings, "looks_like_user_id", lambda value: checks.append(value) or real(value))
    stored = {"ui": "pilot", "uiAllowlist": ui, "staffDesk": "pilot", "staffAllowlist": staff}
    value = studio_settings.normalise_stored("rollout", stored)
    assert value["uiAllowlist"] == [item for index, item in enumerate(ui) if index not in bad]
    assert value["staffAllowlist"] == [item for index, item in enumerate(staff) if index not in (10, 20)]
    assert value["ui"] == "pilot" and value["staffDesk"] == "pilot"
    assert len(checks) <= 10 * (len(ui) + len(staff)), len(checks)  # linear in the ids
    # The same row through /me: the salvaged allowlists still let the pilot users in.
    monkeypatch.setenv(studio_settings.ENV_SWITCH, "on")
    _store({"rollout": stored})
    assert _me(actors["customer"])["ui"] == "v2" and _me(actors["customer2"])["ui"] == "classic"
    assert _me(actors["staff"])["staffDesk"] == "v2" and _me(actors["staff2"])["staffDesk"] == "classic"


def test_stored_lists_over_a_cap_keep_their_leading_items():
    """Over a length cap (a hand edit, or a cap lowered later) the first items that fit are kept, as
    the item-by-item pass did; bad items and repeats do not use up the cap."""
    ids = [f"studio_user_{index:03d}" for index in range(205)]
    assert studio_settings.normalise_stored("rollout", {"uiAllowlist": ["bad id!", ids[0], *ids]})["uiAllowlist"] == ids[:200]
    warn_days = studio_settings.normalise_stored("thresholds", {"tokenExpiryWarnDays": [9, "x", 9, 1, 2, 3, 4, 5, 6]})
    assert warn_days["tokenExpiryWarnDays"] == [9, 4, 3, 2, 1]
    dates = [(date(2027, 1, 1) + timedelta(days=index)).isoformat() for index in range(62)]
    days = [{"date": day} for day in dates]
    hours = studio_settings.normalise_stored("hours", {"holidays": [days[61], {"date": "bad"}, days[61], *days]})
    assert [item["date"] for item in hours["holidays"]] == [*dates[:59], dates[61]]  # the first 60 kept, sorted
    assert studio_settings.normalise_stored("thresholds", {"tokenExpiryWarnDays": ["x", 0]})["tokenExpiryWarnDays"] == [14, 7, 2]


def test_me_gives_customers_public_fields_only(actors, monkeypatch):
    monkeypatch.setattr(studio_settings, "utc_now", lambda: THURSDAY_1030_TRIPOLI)
    admin = actors["admin"]
    urgent = "+218920001111"
    for key, value in {
        "contact": {"whatsapp": "+218912345678", "phone": "+218214444444", "email": "help@albayanhub.com", "urgentWhatsapp": urgent},
        "limits": {"minTotalMinorUSD": 700, "maxTotalMinorUSD": 150_000, "minPerDayMinorUSD": 250, "maxDays": 45,
                   "p1CutoverAt": "2026-10-01T08:00:00Z"},
        "hours": {"holidays": [{"date": "2026-09-01", "labelEn": "Past day"},
                               {"date": "2026-12-24", "labelEn": "Independence Day", "labelAr": "عيد الاستقلال"}],
                  "ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"},
                  "onDutyUntil": "23:00"},
        "settlement": {"spendDelayHours": 71},
        "targets": {"paymentConfirmMinutes": 333},
        "thresholds": {"tokenMinDaysLeft": 17},
    }.items():
        assert _put(admin, key, value).status_code == 200, key
    for who in ("customer", "staff", "admin"):
        response = client.get("/api/studio/me", cookies=actors[who]["cookies"])
        assert response.status_code == 200, response.text
        me = response.json()
        assert set(me) == {"ui", "services", "staffDesk", "capabilities", "intake", "adLimits", "serviceHours", "contact",
                           "isAdmin", "isStaff", "metaConnection"}
        # The per-day floor is not secret: the form checks the same limits as the server (P1-08b, P1-15).
        assert me["adLimits"] == {"minTotalMinorUSD": 700, "maxTotalMinorUSD": 150_000, "minPerDayMinorUSD": 250, "maxDays": 45}
        assert me["contact"] == {"whatsapp": "+218912345678", "phone": "+218214444444", "email": "help@albayanhub.com"}
        assert me["serviceHours"] == {
            "timezone": "Africa/Tripoli", "openNow": True, "week": DEFAULT_WEEK,
            "holidays": [{"date": "2026-12-24", "labelEn": "Independence Day", "labelAr": "عيد الاستقلال"}],  # past days left out
            "ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"},
            "onDutyUntil": "23:00",
        }
        # The urgent line (only for the after-hours stop answer) and staff-only settings never reach /me
        # (the exact comparisons above already pin every value that does).
        for private in (urgent, "urgentWhatsapp", "p1CutoverAt", "2026-10-01", "spendDelayHours",
                        "tokenMinDaysLeft", "paymentConfirmMinutes", "settlement", "targets", "thresholds"):
            assert private not in response.text, (who, private)
    # Without an urgent line to call, no on-duty time is promised.
    assert _put(admin, "contact", {"urgentWhatsapp": None}, expected_version=1).status_code == 200
    assert _me(actors["customer"])["serviceHours"]["onDutyUntil"] is None


def test_open_now_uses_tripoli_time_weekends_holidays_and_ramadan():
    hours = studio_settings.validate_setting("hours", {
        "holidays": [{"date": "2026-10-04", "labelEn": "Test holiday", "labelAr": "عطلة تجريبية"}],
        "ramadan": {"from": "2027-02-08", "to": "2027-03-09", "open": "10:00", "close": "15:00"},
    })
    cases = [
        (_utc(2026, 9, 24, 8, 30), True),    # Thursday 10:30 in Tripoli
        (_utc(2026, 9, 24, 6, 59), False),   # Thursday 08:59: not open yet
        (_utc(2026, 9, 24, 7, 0), True),     # 09:00 Tripoli opens (07:00 read as UTC would still be closed)
        (_utc(2026, 9, 24, 14, 59), True),   # 16:59
        (_utc(2026, 9, 24, 15, 0), False),   # 17:00 closes (15:00 read as UTC would still be open)
        (_utc(2026, 9, 25, 8, 30), False),   # Friday: weekend
        (_utc(2026, 9, 26, 8, 30), False),   # Saturday: weekend
        (_utc(2026, 9, 27, 7, 30), True),    # Sunday 09:30: the week starts
        (_utc(2026, 10, 4, 8, 30), False),   # Sunday, but a holiday
        (_utc(2026, 10, 5, 7, 30), True),    # Monday after the holiday
        (_utc(2027, 2, 10, 12, 0), True),    # Ramadan Wednesday 14:00 (10:00-15:00)
        (_utc(2027, 2, 10, 13, 30), False),  # Ramadan 15:30: ordinary hours would say open
        (_utc(2027, 2, 10, 7, 30), False),   # Ramadan 09:30: ordinary hours would say open
        (_utc(2027, 2, 12, 12, 0), False),   # a Ramadan Friday stays closed
        (_utc(2027, 3, 10, 13, 30), True),   # the day after Ramadan: ordinary hours again (15:30)
        (datetime(2026, 9, 24, 8, 30), True),  # a time without a zone is read as UTC
    ]
    for moment, expected in cases:
        assert studio_settings.service_open_at(hours, moment) is expected, moment
    # The day changes at Tripoli midnight (22:00 UTC), not at UTC midnight.
    all_day = studio_settings.validate_setting("hours", {
        "week": {"sun": {"open": "00:00", "close": "23:59"}, "mon": {"open": "00:00", "close": "23:59"}},
        "holidays": [{"date": "2026-10-05", "labelEn": "Monday holiday", "labelAr": "عطلة الاثنين"}],
    })
    assert studio_settings.service_open_at(all_day, _utc(2026, 10, 4, 21, 30)) is True    # Sunday 23:30 Tripoli
    assert studio_settings.service_open_at(all_day, _utc(2026, 10, 4, 22, 30)) is False   # Monday 00:30 = the holiday
    assert studio_settings.service_open_at(all_day, _utc(2026, 10, 5, 21, 30)) is False   # Monday 23:30: still the holiday
    assert studio_settings.service_open_at(all_day, _utc(2026, 10, 5, 22, 30)) is False   # Tuesday 00:30: ordinary 09:00 opening


def test_me_open_now_follows_a_fixed_tripoli_clock(actors, monkeypatch):
    holiday = {"date": "2026-10-04", "labelEn": "Test holiday", "labelAr": "عطلة تجريبية"}
    assert _put(actors["admin"], "hours", {"holidays": [holiday]}).status_code == 200
    for moment, open_now, holidays in [
        (THURSDAY_1030_TRIPOLI, True, [holiday]),
        (_utc(2026, 9, 24, 16, 0), False, [holiday]),   # Thursday 18:00 Tripoli: after hours
        (_utc(2026, 9, 25, 8, 30), False, [holiday]),   # Friday (weekend)
        (_utc(2026, 9, 26, 8, 30), False, [holiday]),   # Saturday (weekend)
        (_utc(2026, 10, 4, 8, 30), False, [holiday]),   # the holiday itself (still listed today)
        (_utc(2026, 10, 5, 7, 30), True, []),           # Monday 09:30: open, the holiday is past
    ]:
        monkeypatch.setattr(studio_settings, "utc_now", lambda moment=moment: moment)
        hours = _me(actors["customer"])["serviceHours"]
        assert hours["openNow"] is open_now and hours["holidays"] == holidays, moment
