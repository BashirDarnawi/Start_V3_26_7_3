"""GET /api/studio/public/contact (plan task P2-09, journey J0): the studio front door's login help
line reads the public contact numbers WITHOUT a login. Only the public fields leave the server (never
the on-duty urgent line), the answer follows the admin's contact setting, and the read is limited per
client IP (60 a minute) so an anonymous caller cannot hammer the settings table.

Each test restores the settings rows it touched and never depends on other modules' rows.
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
from server.systems.ads_studio import studio_api, studio_settings
from server.systems.ads_studio.studio_types import STUDIO_SETTINGS_TYPE

TAG = secrets.token_hex(4)
PASSWORD = "StudioContactPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
PATH = "/api/studio/public/contact"


def _insert_admin() -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("studio_contact_admin")
    email = f"studio-contact-admin-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,'Admin',:permissions,:hash,:salt,:algo,:iterations,false,:created,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": "Contact admin", "email": email, "permissions": json_dumps({}),
                "hash": password_hash.hash_hex, "salt": password_hash.salt_hex, "algo": password_hash.algo,
                "iterations": password_hash.iterations, "created": stamp, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "email": email, "cookies": cookies}


def _settings_rows() -> list[dict]:
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(text("SELECT * FROM entities WHERE type=:type"), {"type": STUDIO_SETTINGS_TYPE}).mappings().all()]


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


def _reset_public_limit() -> None:
    reset_rate_limit("studio:public-contact:testclient")


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()


@pytest.fixture(scope="module")
def admin(_database):
    return _insert_admin()


@pytest.fixture(autouse=True)
def clean_settings(_database):
    saved = _settings_rows()
    _replace_settings_rows([])
    _reset_public_limit()
    yield
    _replace_settings_rows(saved)
    _reset_public_limit()


def test_public_contact_needs_no_login_and_shows_only_public_fields(admin):
    client.cookies.clear()
    empty = client.get(PATH)
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"whatsapp": None, "phone": None, "email": None}

    saved = client.put(
        "/api/studio/admin/settings/contact",
        json={"expectedVersion": 0, "value": {"whatsapp": "+218912345678", "phone": "+218213333333", "email": "help@albayanhub.com", "urgentWhatsapp": "+218911111111"}},
        cookies=admin["cookies"],
    )
    assert saved.status_code == 200, saved.text
    client.cookies.clear()

    public = client.get(PATH)
    assert public.status_code == 200, public.text
    body = public.json()
    assert body == {"whatsapp": "+218912345678", "phone": "+218213333333", "email": "help@albayanhub.com"}
    assert "urgentWhatsapp" not in body and "+218911111111" not in public.text
    assert set(body) == set(studio_settings.PUBLIC_CONTACT_FIELDS)


def test_public_contact_answers_the_same_with_a_stale_session_cookie():
    """A visitor whose old session cookie expired (the login page's usual state) is served, never 401."""
    client.cookies.clear()
    response = client.get(PATH, cookies={"albayan_session": "expired-or-forged-session-value"})
    assert response.status_code == 200, response.text
    assert set(response.json()) == set(studio_settings.PUBLIC_CONTACT_FIELDS)
    client.cookies.clear()


def test_public_contact_is_rate_limited_per_ip():
    client.cookies.clear()
    limit = studio_api.PUBLIC_CONTACT_READS_PER_MINUTE
    assert limit == 60
    for _ in range(limit):
        assert client.get(PATH).status_code == 200
    refused = client.get(PATH)
    assert refused.status_code == 429, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "RATE_LIMITED" and refused.headers.get("Retry-After")
    _reset_public_limit()
    assert client.get(PATH).status_code == 200
