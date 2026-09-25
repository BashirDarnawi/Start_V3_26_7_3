"""The e2e-only seed door of the Albayan Studio browser tests (plan task P2-13; PLAN.md §7.3).

``POST /api/studio/test/seed-results`` must exist only in the disposable e2e server: the flag
``ALBAYAN_E2E_STUDIO_SEED`` exactly ``true``, SQLite, and the database file under ``.tmp/e2e``.
With the flag on and any other database the studio router refuses to build (the server does not
start). Every test creates its own users (unique e-mails per run) and removes the rows it wrote.
"""

import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import URL

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_e2e_seed, studio_results
from server.systems.ads_studio.studio_api import create_studio_router
from server.systems.ads_studio.studio_e2e_seed import E2E_DB_DIR, SEED_FLAG, e2e_seed_enabled
from server.systems.ads_studio.studio_results import RESULTS_TYPE, results_id

TAG = secrets.token_hex(4)
PASSWORD = "StudioSeedPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
SEED_PATH = "/api/studio/test/seed-results"
E2E_DB = E2E_DB_DIR / "albayan-e2e.db"
POSTGRES = "postgresql+psycopg://albayan:secret@db.example.com:5432/albayan"


def _sqlite(path: Path | str) -> str:
    return f"sqlite+pysqlite:///{Path(path).resolve().as_posix()}"


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    stamp = now_ms()
    user_id = new_id("seed_user")
    email = f"studio-seed-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Seed {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
             "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "owner": _insert_user("owner", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
    }


@pytest.fixture
def seeded():
    written: list[tuple[str, str]] = []
    yield written
    with db_conn() as conn:
        for row_type, row_id in written:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": row_type, "id": row_id})


def _campaign(seeded: list, owner_id: str, campaign_id: str, **data) -> None:
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"Ad {campaign_id}", **data}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"
            ),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    seeded.extend([(CAMPAIGNS, campaign_id), (RESULTS_TYPE, results_id(campaign_id))])


def _code(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.json()["detail"]["code"] == code


# ------------------------------------------------------------------ the guard

def test_seed_route_guarded(people, monkeypatch):
    """Not mounted without the flag (404), never with a real database (no start)."""
    admin = people["admin"]
    # The app under test was built without the flag: the path is an unknown route, whoever asks.
    # A GET answers 404; a POST answers exactly like a POST to any other unknown path (the SPA
    # catch-all is GET-only, so that is 405), never a studio answer.
    monkeypatch.setenv(SEED_FLAG, "true")  # too late: mounting is decided when the router is built
    assert client.get(SEED_PATH, cookies=admin["cookies"]).status_code == 404
    response = client.post(SEED_PATH, json={"campaignId": "cmp_x", "results": {}}, cookies=admin["cookies"])
    unknown = client.post(f"/api/studio/test/no-such-door-{TAG}", json={}, cookies=admin["cookies"])
    assert (response.status_code, response.json()) == (unknown.status_code, unknown.json())
    assert response.status_code in (404, 405) and "code" not in str(response.json())
    assert not any(getattr(route, "path", "").startswith("/api/studio/test") for route in app.routes)

    good = {SEED_FLAG: "true", "ALBAYAN_DB_PATH": str(E2E_DB)}
    assert e2e_seed_enabled(good, _sqlite(E2E_DB)) is True
    # The flag must be exactly "true".
    for flag in (None, "", "1", "TRUE", "True", "yes", "on", " true", "true "):
        env = dict(good)
        if flag is None:
            env.pop(SEED_FLAG)
        else:
            env[SEED_FLAG] = flag
        assert e2e_seed_enabled(env, _sqlite(E2E_DB)) is False, flag
    # With the flag on, any database other than SQLite refuses to start.
    for url in (POSTGRES, URL.create("postgresql+psycopg", username="u", password="p@ss", host="h", database="d"),
                "mysql+pymysql://u:p@h/d"):
        with pytest.raises(RuntimeError, match=SEED_FLAG):
            e2e_seed_enabled(good, url)
    # SQLite, but not the disposable e2e database: not mounted.
    outside = Path(__file__).resolve().parent / "data" / "albayan.db"
    escaped = E2E_DB_DIR / ".." / ".." / "server" / "data" / "albayan.db"
    for env, url in (
        (good, "sqlite+pysqlite:///:memory:"),
        ({SEED_FLAG: "true"}, _sqlite(E2E_DB)),  # ALBAYAN_DB_PATH missing
        ({SEED_FLAG: "true", "ALBAYAN_DB_PATH": str(E2E_DB_DIR / "other.db")}, _sqlite(E2E_DB)),  # not the file in use
        ({SEED_FLAG: "true", "ALBAYAN_DB_PATH": str(outside)}, _sqlite(outside)),
        ({SEED_FLAG: "true", "ALBAYAN_DB_PATH": str(escaped)}, _sqlite(escaped)),
        ({SEED_FLAG: "true", "ALBAYAN_DB_PATH": str(E2E_DB_DIR)}, _sqlite(E2E_DB_DIR)),  # the folder itself
    ):
        assert e2e_seed_enabled(env, url) is False, (env, url)

    # The whole studio router refuses to build (so uvicorn never starts) with the flag on PostgreSQL.
    monkeypatch.setattr(studio_e2e_seed, "get_database_url", lambda: POSTGRES)
    with pytest.raises(RuntimeError, match="refusing to start"):
        create_studio_router(current_user_dependency=main_module.current_user,
                             require_same_origin=main_module.require_same_origin, ctx={})
    monkeypatch.delenv(SEED_FLAG)
    router = create_studio_router(current_user_dependency=main_module.current_user,
                                  require_same_origin=main_module.require_same_origin, ctx={})
    assert not any(getattr(route, "path", "").startswith("/api/studio/test") for route in router.routes)


# ------------------------------------------------------------------ the door itself (mounted on purpose)

@pytest.fixture
def seed_client(monkeypatch):
    """A small app with only the seed router, mounted as the e2e server would mount it."""
    monkeypatch.setattr(studio_e2e_seed, "e2e_seed_enabled", lambda: True)
    router = studio_e2e_seed.create_studio_e2e_seed_router(
        current_user_dependency=main_module.current_user, require_same_origin=main_module.require_same_origin, ctx={})
    assert router is not None
    seed_app = FastAPI()
    seed_app.include_router(router, prefix="/api/studio")
    return TestClient(seed_app, headers={"Origin": "http://testserver"})


def test_seed_route_admin_only_same_origin_and_strict(people, seeded, seed_client):
    admin, owner = people["admin"], people["owner"]
    campaign_id = f"seed_strict_{TAG}"
    _campaign(seeded, owner["id"], campaign_id, status="Approved")
    body = {"campaignId": campaign_id, "results": {"spendMinorUSD": 100}}
    seed_client.cookies.clear()
    assert seed_client.post(SEED_PATH, json=body).status_code == 401
    _code(seed_client.post(SEED_PATH, json=body, cookies=owner["cookies"]), 403, "ADMIN_ONLY")
    _code(seed_client.post(SEED_PATH, json=body, cookies=admin["cookies"], headers={"Origin": "https://evil.example"}),
          403, "CROSS_SITE")
    for bad, code in (
        ([1, 2], "INVALID_REQUEST"),
        ({"campaignId": campaign_id}, "INVALID_REQUEST"),
        ({"campaignId": "bad id!", "results": {}}, "INVALID_REQUEST"),
        ({**body, "extra": 1}, "UNKNOWN_FIELD"),
        ({**body, "link": {"metaCampaignId": "12", "metaAdAccountId": "act_1", "x": 1}}, "UNKNOWN_FIELD"),
        ({**body, "link": {"metaCampaignId": "12a", "metaAdAccountId": "act_1"}}, "INVALID_VALUE"),
        ({**body, "link": "120200000000001"}, "INVALID_REQUEST"),
    ):
        response = seed_client.post(SEED_PATH, json=bad, cookies=admin["cookies"])
        _code(response, 400, code)
    _code(seed_client.post(SEED_PATH, json={**body, "campaignId": f"seed_missing_{TAG}"}, cookies=admin["cookies"]),
          404, "UNKNOWN_CAMPAIGN")
    with db_conn() as conn:  # nothing was written by the refused calls
        found = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND id = :id"),
                             {"t": RESULTS_TYPE, "id": results_id(campaign_id)}).scalar()
    assert int(found or 0) == 0


def test_seeded_results_drive_the_customer_stage(people, seeded, seed_client, monkeypatch):
    now = datetime(2026, 10, 15, 10, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(studio_results, "utc_now", lambda: now)
    admin, owner = people["admin"], people["owner"]
    campaign_id = f"seed_running_{TAG}"
    _campaign(seeded, owner["id"], campaign_id, status="Approved", startDate="2026-10-10", endDate="2026-10-20",
              budgetMinorUSD=3000, paidMinorUSD=3000)
    response = seed_client.post(SEED_PATH, cookies=admin["cookies"], json={
        "campaignId": campaign_id,
        "link": {"metaAdAccountId": "act_1234567890", "metaCampaignId": "120200000000777"},
        "results": {"metaCampaignId": "999", "syncState": "ok", "lastSyncedAt": "2026-10-15T09:55:00Z",
                    "adStatusCounts": {"ACTIVE": 1}, "spendMinorUSD": 450, "spendConfirmedAt": "2026-10-15T09:55:00Z",
                    "insightsState": "ok", "currency": "USD", "notAField": "dropped"},
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["campaignId"] == campaign_id and body["linked"] is True
    row = body["results"]
    assert row["metaCampaignId"] == "120200000000777" and row["metaAdAccountId"] == "act_1234567890"  # the link wins
    assert row["ownerId"] == owner["id"] and row["spendMinorUSD"] == 450 and "notAField" not in row
    with db_conn() as conn:
        stored = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                              {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
        results_owner = conn.execute(text("SELECT created_by FROM entities WHERE type = :t AND id = :id"),
                                     {"t": RESULTS_TYPE, "id": results_id(campaign_id)}).scalar()
    request = json_loads(stored["data_json"])
    assert request["metaCampaignId"] == "120200000000777" and request["metaAdAccountId"] == "act_1234567890"
    assert request["status"] == "Approved" and results_owner == owner["id"]
    # The customer's own summary (the real app's route) now reads the seeded Meta view.
    summary = client.get("/api/studio/campaigns/summary", cookies=owner["cookies"])
    assert summary.status_code == 200, summary.text
    entry = summary.json()[campaign_id]
    assert entry["stage"] == 8 and entry["metaUsedMinor"] == 450 and entry["checkedAt"] == "2026-10-15T09:55:00Z"
