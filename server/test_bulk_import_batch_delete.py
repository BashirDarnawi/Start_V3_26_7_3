"""
Tests for the transactional bulk import (POST /api/admin/import) and the
atomic batch delete (POST /api/batch/delete).

Run with:
  PYTHONPATH=. pytest server/test_bulk_import_batch_delete.py -v
"""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

from server.main import app
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})

TEST_ADMIN_EMAIL = os.getenv("TEST_ADMIN_EMAIL", "bulkadmin@tests.albayanhub.com")
TEST_ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "TestPassword123!Secure")


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    init_db()
    pw = hash_password(TEST_ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
                {"email": TEST_ADMIN_EMAIL},
            )
            .mappings()
            .first()
        )
        if not row:
            conn.execute(
                text(
                    """
                    INSERT INTO users (id, name, email, role, permissions_json, password_hash,
                                       password_salt, password_algo, password_iterations,
                                       deleted, created_at, created_by, last_modified)
                    VALUES (:id, :name, :email, 'Admin', :permissions_json, :password_hash,
                            :password_salt, :password_algo, :password_iterations,
                            false, :now, NULL, :now)
                    """
                ),
                {
                    "id": new_id("user"),
                    "name": "Bulk Admin",
                    "email": TEST_ADMIN_EMAIL,
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "now": now,
                },
            )
    yield


@pytest.fixture()
def admin_cookies():
    r = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    )
    assert r.status_code == 200, r.text
    token = r.cookies.get("albayan_session")
    try:
        client.cookies.clear()
    except Exception:
        pass
    return {"albayan_session": token}


def _seed_entity(entity_type: str, entity_id: str, data: dict, *, deleted=False, last_modified=None):
    now = now_ms() if last_modified is None else int(last_modified)
    body = dict(data)
    body["id"] = entity_id
    with db_conn() as conn:
        conn.execute(
            text("DELETE FROM entities WHERE type = :t AND id = :i"),
            {"t": entity_type, "i": entity_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                VALUES (:t, :i, :d, :del, :now, NULL, :lm)
                """
            ),
            {"t": entity_type, "i": entity_id, "d": json_dumps(body), "del": deleted, "now": now, "lm": now},
        )


def _get_row(entity_type: str, entity_id: str):
    with db_conn() as conn:
        return (
            conn.execute(
                text("SELECT * FROM entities WHERE type = :t AND id = :i LIMIT 1"),
                {"t": entity_type, "i": entity_id},
            )
            .mappings()
            .first()
        )


class TestAdminBulkImport:
    def test_requires_admin(self):
        r = client.post("/api/admin/import", json={"collections": {"customers": []}})
        assert r.status_code in (401, 403)

    def test_import_replaces_prunes_and_stamps_now(self, admin_cookies):
        t0 = now_ms()
        # Server currently holds: keep-me (will be updated), prune-me (absent
        # from backup -> must become deleted), backup also adds new-one.
        _seed_entity("customers", "cust_keep", {"name": "Old Name"}, last_modified=1111)
        _seed_entity("customers", "cust_prune", {"name": "Prune Me"}, last_modified=1111)
        backup = {
            "collections": {
                "customers": [
                    {"id": "cust_keep", "name": "New Name", "_created": 2222},
                    {"id": "cust_new", "name": "Brand New", "_created": 3333},
                ]
            }
        }
        r = client.post("/api/admin/import", json=backup, cookies=admin_cookies)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["collections"]["customers"] == {"restored": 2, "pruned": 1}

        keep = _get_row("customers", "cust_keep")
        assert keep["deleted"] is False or keep["deleted"] == 0
        assert "New Name" in keep["data_json"]
        # SYNC FIX: restored rows must be visible to delta-sync cursors.
        assert int(keep["last_modified"]) >= t0

        new = _get_row("customers", "cust_new")
        assert new is not None
        assert int(new["created_at"]) == 3333
        assert int(new["last_modified"]) >= t0

        pruned = _get_row("customers", "cust_prune")
        assert bool(pruned["deleted"]) is True
        assert int(pruned["last_modified"]) >= t0

    def test_backup_deleted_records_are_pruned(self, admin_cookies):
        _seed_entity("pages", "page_dead", {"name": "Dead"}, last_modified=1111)
        backup = {"collections": {"pages": [{"id": "page_dead", "name": "Dead", "_deleted": True}]}}
        r = client.post("/api/admin/import", json=backup, cookies=admin_cookies)
        assert r.status_code == 200, r.text
        assert r.json()["collections"]["pages"] == {"restored": 0, "pruned": 1}
        assert bool(_get_row("pages", "page_dead")["deleted"]) is True

    def test_bad_record_rolls_back_everything(self, admin_cookies):
        # A duplicate id inside the backup must fail the WHOLE import with the
        # server data untouched — not half-applied.
        _seed_entity("ads", "ad_before", {"title": "Before"}, last_modified=1111)
        backup = {
            "collections": {
                "ads": [
                    {"id": "ad_x", "title": "X"},
                    {"id": "ad_x", "title": "X again"},  # duplicate -> 400
                ]
            }
        }
        r = client.post("/api/admin/import", json=backup, cookies=admin_cookies)
        assert r.status_code == 400
        # Nothing changed: ad_before still visible, ad_x never created.
        row = _get_row("ads", "ad_before")
        assert bool(row["deleted"]) is False
        assert int(row["last_modified"]) == 1111
        assert _get_row("ads", "ad_x") is None

    def test_users_collection_refused(self, admin_cookies):
        r = client.post(
            "/api/admin/import",
            json={"collections": {"users": [{"id": "u1"}]}},
            cookies=admin_cookies,
        )
        assert r.status_code == 400


class TestSingleRestoreStampsNow:
    def test_restore_ignores_backup_last_modified(self, admin_cookies):
        t0 = now_ms()
        r = client.put(
            "/api/admin/collections/customers/cust_restamp/restore",
            json={
                "data": {"id": "cust_restamp", "name": "Restamped", "_created": 4444, "_lastModified": 1111},
                "createdAt": 4444,
                "lastModified": 1111,  # old value from the backup — must be ignored
                "deleted": False,
            },
            cookies=admin_cookies,
        )
        assert r.status_code == 200, r.text
        assert int(r.json()["lastModified"]) >= t0
        assert int(_get_row("customers", "cust_restamp")["last_modified"]) >= t0


class TestBatchDelete:
    def test_requires_auth(self):
        r = client.post("/api/batch/delete", json={"items": [{"collection": "receipts", "id": "r1"}]})
        assert r.status_code in (401, 403)

    def test_deletes_all_in_one_call(self, admin_cookies):
        t0 = now_ms()
        _seed_entity("receipts", "r_b1", {"amountUSD": 10}, last_modified=1111)
        _seed_entity("receipts", "r_b2", {"amountUSD": 20}, last_modified=1111)
        _seed_entity("ads", "a_b1", {"title": "Ad"}, last_modified=1111)
        r = client.post(
            "/api/batch/delete",
            json={
                "items": [
                    {"collection": "receipts", "id": "r_b1"},
                    {"collection": "receipts", "id": "r_b2"},
                    {"collection": "ads", "id": "a_b1"},
                ]
            },
            cookies=admin_cookies,
        )
        assert r.status_code == 200, r.text
        assert r.json()["deleted"] == 3
        for (t, i) in [("receipts", "r_b1"), ("receipts", "r_b2"), ("ads", "a_b1")]:
            row = _get_row(t, i)
            assert bool(row["deleted"]) is True
            assert int(row["last_modified"]) >= t0

    def test_missing_records_are_skipped_not_fatal(self, admin_cookies):
        _seed_entity("receipts", "r_b3", {"amountUSD": 30}, last_modified=1111)
        r = client.post(
            "/api/batch/delete",
            json={
                "items": [
                    {"collection": "receipts", "id": "r_b3"},
                    {"collection": "receipts", "id": "r_ghost_does_not_exist"},
                ]
            },
            cookies=admin_cookies,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["deleted"] == 1
        assert body["skipped"] == 1
        assert bool(_get_row("receipts", "r_b3")["deleted"]) is True

    def test_users_refused(self, admin_cookies):
        r = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "users", "id": "u1"}]},
            cookies=admin_cookies,
        )
        assert r.status_code == 400
