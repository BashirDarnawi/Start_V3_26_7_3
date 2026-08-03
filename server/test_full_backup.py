"""The owner's downloadable full backup: complete, and free of credentials."""

import gzip
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "backup-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "BackupAdmin123!"
STAFF_EMAIL = "backup-staff@tests.albayanhub.com"
STAFF_PASSWORD = "BackupStaff123!"
# A tiny but real base64 data URL, so the media assertion is meaningful.
PHOTO = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)


def _ensure_admin() -> str:
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        existing = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
            {"e": ADMIN_EMAIL},
        ).mappings().first()
        if existing:
            return str(existing["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Backup Admin',:e,'Admin',:p,:h,:s,:a,:i,false,:now,NULL,:now)"
            ),
            {
                "id": uid, "e": ADMIN_EMAIL, "p": json_dumps({}),
                "h": password.hash_hex, "s": password.salt_hex,
                "a": password.algo, "i": password.iterations, "now": now,
            },
        )
    return uid


def _login(email: str, password: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    token = response.cookies.get("albayan_session")
    client.cookies.clear()
    return {"albayan_session": token}


@pytest.fixture(scope="module")
def actors():
    init_db()
    _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    staff = client.post(
        "/api/users",
        json={
            "name": "Backup Staff", "email": STAFF_EMAIL, "password": STAFF_PASSWORD,
            "role": "Employee", "permissions": {"receipts": ["view"]},
        },
        cookies=admin,
    )
    assert staff.status_code == 200, staff.text
    # A clothes row and a photo-carrying receipt: the two things the old
    # Settings export could never include.
    now = now_ms()
    with db_conn() as conn:
        for etype, eid, data in (
            ("clothesProducts", "backup_probe_product", {"name": "Test Shirt", "price": 50}),
            ("receipts", "backup_probe_receipt", {"amountUSD": 10, "photos": [PHOTO]}),
        ):
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:t,:i,:d,false,:now,'system',:now)"
                ),
                {"t": etype, "i": eid, "d": json_dumps(data), "now": now},
            )
    return {"admin": admin, "staff": _login(STAFF_EMAIL, STAFF_PASSWORD)}


def _download(cookies) -> tuple[int, list[dict]]:
    response = client.get("/api/admin/backup/full", cookies=cookies)
    if response.status_code != 200:
        return response.status_code, []
    raw = response.content
    # TestClient may transparently decompress; handle both.
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    lines = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    return 200, lines


class TestFullBackup:
    def test_only_an_admin_can_download(self, actors):
        assert client.get("/api/admin/backup/full").status_code in (401, 403)
        assert client.get("/api/admin/backup/full", cookies=actors["staff"]).status_code == 403
        assert client.get("/api/admin/backup/full/estimate", cookies=actors["staff"]).status_code == 403

    def test_estimate_reports_the_collections(self, actors):
        response = client.get("/api/admin/backup/full/estimate", cookies=actors["admin"])
        assert response.status_code == 200, response.text
        payload = response.json()
        names = {row["collection"] for row in payload["collections"]}
        assert "receipts" in names and "clothesProducts" in names
        assert payload["records"] >= 2
        assert payload["users"] >= 2
        assert payload["approxDownloadBytes"] > 0

    def test_stream_is_complete_and_includes_clothes_and_media(self, actors):
        status, lines = _download(actors["admin"])
        assert status == 200
        assert lines, "empty backup"
        header, footer = lines[0], lines[-1]
        assert header["_type"] == "header"
        assert header["format"] == "albayan-full-backup/1"
        assert header["includesMedia"] is True
        # The footer is the completeness proof: a truncated file lacks it.
        assert footer["_type"] == "footer"
        assert footer["complete"] is True
        assert footer["sha256"]

        entities = [row for row in lines if row.get("_type") == "entity"]
        collections = {row["collection"] for row in entities}
        assert "clothesProducts" in collections, "clothes domain missing from the backup"
        receipt = next(r for r in entities if r["id"] == "backup_probe_receipt")
        assert receipt["data"]["photos"][0].startswith("data:image/"), "photo was not included"
        assert any(row.get("_type") == "user" for row in lines)

    def test_backup_carries_no_credential_material(self, actors):
        response = client.get("/api/admin/backup/full", cookies=actors["admin"])
        assert response.status_code == 200
        raw = response.content
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        body = raw.decode("utf-8")
        # Field NAMES legitimately appear once, inside the header's "excluded"
        # list. What must never appear is a field carrying a VALUE.
        for secret in (
            "password_hash", "password_salt", "password_algo", "password_iterations",
            "token_hash", "code_hash", "challenge_hash",
        ):
            assert f'"{secret}":' not in body, f"{secret} leaked into the backup"
        assert "ALBAYAN_BACKUP_KEY" not in body
        # The admin's real hash must not appear either.
        with db_conn() as conn:
            stored = conn.execute(
                text("SELECT password_hash FROM users WHERE lower(email)=lower(:e)"),
                {"e": ADMIN_EMAIL},
            ).mappings().first()
        assert stored and stored["password_hash"] not in body
        # ...while the user's readable identity IS present.
        assert ADMIN_EMAIL in body
