"""Review loop round 3, batch OS: offline storage, sync and the privacy of the browser cache.

Backend behaviour tests for the verified findings of this batch:

* n4: a request the customer WITHDRAWS (Submitted -> Draft + withdrawnAt, P1-03) never reached a
  reviewer's delta read, so it stayed "Under Review" in their cache. It now arrives as a redacted
  tombstone; a brand-new Draft still never enters the reviewer query. (Failed before its fix.)
* n6: the batch delete (every receipt/customer delete in server mode) stamped the tombstone with
  a time taken BEFORE it waited for the row lock, so an edit that committed meanwhile looked newer
  than the delete and other devices dropped the tombstone. The stamp is now taken under the lock,
  above the row's own stamp, and returned so the client can adopt it. (Failed before its fix.)
* n9: the server refuses a WRITE whose account header names another user (the client now sends
  the header on writes too; this pins the server half of that contract).

Every test builds its own users (unique e-mails per run) and removes the rows it wrote.
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

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR3OSPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
PREFIX = f"rlr3os_{TAG}_"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
REVIEWER_PERMISSIONS = {CAMPAIGNS: ["view", "review"]}
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rlr3os_user")
    email = f"review-loop-r3-os-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R3 OS {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
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
        "owner": _insert_user("owner", "Employee", CUSTOMER_PERMISSIONS),
        "reviewer": _insert_user("reviewer", "Employee", REVIEWER_PERMISSIONS),
        "admin": _insert_user("admin", "Admin", {}),
    }


@pytest.fixture(autouse=True)
def _isolated(people):
    for uid in _USERS:
        reset_rate_limit(f"ad-studio:mutations:{uid}")
    yield
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE id LIKE :prefix"), {"prefix": f"{PREFIX}%"})
        for uid in _USERS:
            conn.execute(text("DELETE FROM entities WHERE created_by = :uid"), {"uid": uid})


def _seed(entity_type: str, label: str, data: dict, *, created_by: str | None = None,
          last_modified: int | None = None) -> str:
    entity_id = f"{PREFIX}{label}_{secrets.token_hex(3)}"
    created = now_ms()
    stamp = created if last_modified is None else int(last_modified)
    body = {"id": entity_id, "_created": created, "_lastModified": stamp, "_deleted": False, **data}
    if created_by:
        body["createdBy"] = created_by
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:created,:owner,:stamp)"),
            {"type": entity_type, "id": entity_id, "data": json_dumps(body), "created": created,
             "owner": created_by, "stamp": stamp},
        )
    return entity_id


def _row(entity_type: str, entity_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT * FROM entities WHERE type = :t AND id = :id"), {"t": entity_type, "id": entity_id}
        ).mappings().first()
    assert row is not None
    return {**dict(row), "data": json_loads(row["data_json"])}


def _reviewer_delta(people: dict, since: int) -> list[dict]:
    response = client.get(
        f"/api/collections/{CAMPAIGNS}?updated_since={since}&limit=1000&include_deleted=true&include_media=false",
        cookies=people["reviewer"]["cookies"],
    )
    assert response.status_code == 200, response.text
    return response.json()


# ------------------------------------------------------------------ n4: a withdrawn request leaves the reviewer cache


def test_n4_withdrawn_request_reaches_the_reviewer_delta_as_a_redacted_tombstone(people):
    owner = people["owner"]
    campaign_id = _seed(CAMPAIGNS, "withdrawn", {
        "name": "Secret launch copy", "headline": "Private headline", "status": "Submitted",
        "budgetUSD": 200, "submittedAt": "2026-09-28T10:00:00Z", "studioRef": "ALB-S-ABCDEFGH",
    }, created_by=owner["id"])
    submitted_stamp = _row(CAMPAIGNS, campaign_id)["last_modified"]

    full = client.get(f"/api/collections/{CAMPAIGNS}?limit=1000&include_media=false", cookies=people["reviewer"]["cookies"])
    assert full.status_code == 200, full.text
    assert any(row["id"] == campaign_id for row in full.json()), "the reviewer sees the Submitted request"

    withdrawn = client.post(
        f"/api/ad-studio/campaigns/{campaign_id}/withdraw",
        json={"expectedLastModified": int(submitted_stamp), "operationId": f"withdraw-{secrets.token_hex(6)}"},
        cookies=owner["cookies"],
    )
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()["data"]["status"] == "Draft" and withdrawn.json()["data"]["withdrawnAt"]

    delta = _reviewer_delta(people, int(submitted_stamp))
    tombstone = next((row for row in delta if row["id"] == campaign_id), None)
    assert tombstone is not None, "the withdrawn request never reached the reviewer's delta read"
    assert tombstone["deleted"] is True and tombstone["data"]["_deleted"] is True
    for private in ("name", "headline", "status", "budgetUSD", "withdrawnAt", "submittedAt"):
        assert private not in tombstone["data"], private

    # The full read still hides it, and the owner still reads their own draft in full.
    full_after = client.get(f"/api/collections/{CAMPAIGNS}?limit=1000&include_media=false", cookies=people["reviewer"]["cookies"])
    assert all(row["id"] != campaign_id for row in full_after.json())
    own = client.get(
        f"/api/collections/{CAMPAIGNS}?updated_since={int(submitted_stamp)}&limit=1000&include_deleted=true&include_media=false",
        cookies=owner["cookies"],
    )
    mine = next(row for row in own.json() if row["id"] == campaign_id)
    assert mine["deleted"] is False and mine["data"]["status"] == "Draft" and mine["data"]["name"] == "Secret launch copy"


def test_n4_a_brand_new_draft_still_never_enters_the_reviewer_query(people):
    since = now_ms() - 1000
    draft_id = _seed(CAMPAIGNS, "newdraft", {"name": "Never shown", "status": "Draft"}, created_by=people["owner"]["id"])
    changes_id = _seed(CAMPAIGNS, "changes", {"name": "Being revised", "status": "Changes Requested"},
                       created_by=people["owner"]["id"])
    delta_ids = {row["id"]: row for row in _reviewer_delta(people, since)}
    assert draft_id not in delta_ids, "a never-submitted draft (even its id) must stay private"
    assert delta_ids[changes_id]["deleted"] is True and "name" not in delta_ids[changes_id]["data"]


# ------------------------------------------------------------------ n6: batch delete stamps under the lock


def test_n6_batch_delete_stamps_above_an_edit_that_committed_while_it_waited(people):
    admin = people["admin"]
    later_edit = now_ms() + 60_000  # stands in for a PATCH that committed while the batch waited for the lock
    edited = _seed("receipts", "edited", {"amountUSD": 10}, last_modified=later_edit)
    plain = _seed("receipts", "plain", {"amountUSD": 20}, last_modified=1111)
    started = now_ms()
    response = client.post(
        "/api/batch/delete",
        json={"items": [{"collection": "receipts", "id": edited}, {"collection": "receipts", "id": plain}]},
        cookies=admin["cookies"],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["deleted"] == 2
    edited_row, plain_row = _row("receipts", edited), _row("receipts", plain)
    assert bool(edited_row["deleted"]) and bool(plain_row["deleted"])
    assert int(edited_row["last_modified"]) > later_edit, "the tombstone must be newer than the edit it follows"
    assert int(plain_row["last_modified"]) >= started
    assert body["stamps"] == {
        f"receipts:{edited}": int(edited_row["last_modified"]),
        f"receipts:{plain}": int(plain_row["last_modified"]),
    }


def test_n6_batch_delete_of_a_missing_record_returns_no_stamp(people):
    response = client.post(
        "/api/batch/delete",
        json={"items": [{"collection": "receipts", "id": f"{PREFIX}ghost"}]},
        cookies=people["admin"]["cookies"],
    )
    assert response.status_code == 200, response.text
    assert response.json()["skipped"] == 1 and response.json()["stamps"] == {}


# ------------------------------------------------------------------ n9: a write under another tab's account is refused


def test_n9_write_with_a_foreign_account_header_is_refused(people):
    admin = people["admin"]
    receipt_id = _seed("receipts", "foreign", {"amountUSD": 5}, last_modified=1111)
    refused = client.post(
        "/api/batch/delete",
        json={"items": [{"collection": "receipts", "id": receipt_id}]},
        cookies=admin["cookies"],
        headers={"X-Albayan-User": "user_someone_else"},
    )
    assert refused.status_code == 401 and "another tab" in refused.text
    assert not bool(_row("receipts", receipt_id)["deleted"])
    accepted = client.post(
        "/api/batch/delete",
        json={"items": [{"collection": "receipts", "id": receipt_id}]},
        cookies=admin["cookies"],
        headers={"X-Albayan-User": admin["id"]},
    )
    assert accepted.status_code == 200, accepted.text
    assert bool(_row("receipts", receipt_id)["deleted"])
