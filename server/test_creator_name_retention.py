"""Creator names must survive user deletion — and privacy erasure must not resurrect them.

User deletion is a soft delete (PATCH /api/users/{id} deleted=true), but the
user lists that sync to clients filter deleted rows, so records used to render
"Created by: Unknown". These tests pin the three retention mechanisms:

1. upsert_entity stamps an authoritative ``createdByName`` on every new record
   (client stamps cannot spoof it, PATCH cannot rewrite it).
2. GET /api/users/tombstones exposes id+name of soft-deleted users so clients
   can resolve names on records created before the stamp existed.
3. A verified privacy request (_privacy_anonymize_deleted_user_atomic) scrubs
   the stamps and renames the tombstone, so an anonymized user stays anonymous.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import (
    _privacy_anonymize_deleted_user_atomic,
    list_user_tombstones,
    patch_entity,
    upsert_entity,
)
from server.security import new_id


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()


def _insert_user(conn, name: str, *, role: str = "Employee", deleted: bool = False) -> str:
    user_id = new_id("tomb_user")
    now = now_ms()
    conn.execute(
        text(
            "INSERT INTO users "
            "(id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
            "VALUES (:id,:name,:email,:role,'{}','hash','salt','pbkdf2_sha256',1,"
            ":deleted,:now,NULL,:now)"
        ),
        {
            "id": user_id,
            "name": name,
            "email": f"{user_id}@tests.albayanhub.com",
            "role": role,
            "deleted": deleted,
            "now": now,
        },
    )
    return user_id


def _soft_delete_user(user_id: str) -> None:
    with db_conn() as conn:
        conn.execute(
            text("UPDATE users SET deleted = true, last_modified = :now WHERE id = :id"),
            {"id": user_id, "now": now_ms()},
        )


def test_creator_name_is_stamped_and_survives_soft_deletion():
    with db_conn() as conn:
        admin_id = _insert_user(conn, "Directory Admin", role="Admin")
        creator_id = _insert_user(conn, "Fatima Creator")

    # Creation stamps the authoritative name from the users table.
    saved = upsert_entity(
        "ads", new_id("tomb_ad"), {"recordType": "ad", "amountUSD": 5}, creator_id
    )
    assert saved["data"]["createdByName"] == "Fatima Creator"

    # A client-supplied stamp cannot spoof someone else's name.
    spoofed = upsert_entity(
        "ads", new_id("tomb_ad"), {"createdByName": "Somebody Else"}, creator_id
    )
    assert spoofed["data"]["createdByName"] == "Fatima Creator"

    # PATCH treats the stamp as protected and keeps the original.
    patched = patch_entity(
        "ads", saved["id"], {"createdByName": "Hacker", "amountUSD": 6}, creator_id
    )
    assert patched["data"]["createdByName"] == "Fatima Creator"
    assert patched["data"]["amountUSD"] == 6

    # A full-document update that lacks the stamp must not erase it.
    replaced = upsert_entity(
        "ads", saved["id"], {"recordType": "ad", "amountUSD": 7}, creator_id
    )
    assert replaced["data"]["createdByName"] == "Fatima Creator"

    # Soft-delete the creator: the record keeps the stamp AND the tombstone
    # directory still resolves the id for records created before the stamp.
    _soft_delete_user(creator_id)
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
            {"id": saved["id"]},
        ).mappings().one()
    assert (json_loads(row["data_json"]) or {}).get("createdByName") == "Fatima Creator"

    tombstones = list_user_tombstones(user={"id": admin_id, "role": "Admin"})
    names = {r["id"]: r["name"] for r in tombstones}
    assert names.get(creator_id) == "Fatima Creator"


def test_tombstones_require_a_directory_permission():
    with db_conn() as conn:
        _insert_user(conn, "Deleted Somebody", deleted=True)

    own_only = {
        "id": "user_own_only",
        "role": "Employee",
        "permissions_json": json_dumps({"receipts": ["addOwn", "viewOwn"]}),
    }
    assert list_user_tombstones(user=own_only) == []

    viewer = {
        "id": "user_receipts_view",
        "role": "Employee",
        "permissions_json": json_dumps({"receipts": ["view"]}),
    }
    rows = list_user_tombstones(user=viewer)
    assert any(r["name"] == "Deleted Somebody" for r in rows)
    # Only id + name are exposed — never email/role/credentials.
    assert all(set(r.keys()) == {"id", "name"} for r in rows)


def test_privacy_anonymized_user_stays_anonymized():
    with db_conn() as conn:
        admin_id = _insert_user(conn, "Privacy Admin", role="Admin")
        target_id = _insert_user(conn, "Target Person")

    record = upsert_entity(
        "ads", new_id("tomb_ad"), {"recordType": "ad", "amountUSD": 9}, target_id
    )
    assert record["data"]["createdByName"] == "Target Person"

    # Imported legacy row: creator lives only inside data_json.
    legacy_id = new_id("tomb_legacy")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities "
                "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('ads',:id,:data,false,:now,NULL,:now)"
            ),
            {
                "id": legacy_id,
                "data": json_dumps(
                    {"id": legacy_id, "createdBy": target_id, "createdByName": "Target Person"}
                ),
                "now": now_ms(),
            },
        )
        before_modified = conn.execute(
            text("SELECT last_modified FROM entities WHERE type='ads' AND id=:id"),
            {"id": record["id"]},
        ).scalar_one()

    _soft_delete_user(target_id)
    updated = _privacy_anonymize_deleted_user_atomic(target_id)
    assert updated["name"] == "Deleted user"

    with db_conn() as conn:
        stamped = conn.execute(
            text("SELECT data_json, last_modified FROM entities WHERE type='ads' AND id=:id"),
            {"id": record["id"]},
        ).mappings().one()
        legacy = conn.execute(
            text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
            {"id": legacy_id},
        ).mappings().one()

    stamped_data = json_loads(stamped["data_json"]) or {}
    assert "createdByName" not in stamped_data
    # The ownership linkage stays for financial integrity.
    assert stamped_data.get("createdBy") == target_id
    # Clients must re-sync the scrubbed copy.
    assert int(stamped["last_modified"]) >= int(before_modified)

    legacy_data = json_loads(legacy["data_json"]) or {}
    assert "createdByName" not in legacy_data
    assert legacy_data.get("createdBy") == target_id

    # The tombstone directory serves only the anonymized replacement name.
    tombstones = list_user_tombstones(user={"id": admin_id, "role": "Admin"})
    names = {r["id"]: r["name"] for r in tombstones}
    assert names.get(target_id) == "Deleted user"
