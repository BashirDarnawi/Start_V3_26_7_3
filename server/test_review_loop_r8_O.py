"""Review loop round 8, batch O: misc (server side).

* n=11  the Meta worker parks an ad as "Another ad is already linked to this Meta ad. Unlink one
        of them." only when two live ads really share the Meta ad. Any other 409 (the imported
        page changed between its read and its write, the ad changed) is a race: it is recorded
        as a retryable 'temporary' failure and tried again within a minute. Before, every 409 was
        a 'duplicate_link' with the 15-minute non-retryable backoff and told staff to unlink a
        correctly linked ad.
* n=18  account changes are audited with what they did: which fields, the role before/after,
        the permissions granted and removed, a password reset (never the password or its hash),
        a delete (action 'delete'); a new account's audit row carries its role and permissions.
        Before, every one of them read "Updated user <id>" with empty metadata.

Disposable users and ads tagged per run; everything written here is removed afterwards.
"""

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

import server.main as main
import server.meta_ads as meta_ads
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR8OPassword123!"
ORIGIN = {"Origin": "http://testserver"}
_DIGITS = f"{int(TAG, 16) % 10**10:010d}"
ACCOUNT = "93" + _DIGITS + "001"
PAGE_META_ID = "94" + _DIGITS + "001"
RACE_META_ID = "91" + _DIGITS + "001"
TWIN_META_ID = "91" + _DIGITS + "002"
_USERS: list[str] = []
_ENTITIES: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()
    yield
    with db_conn() as conn:
        for uid in _USERS:
            for table in ("sessions", "app_logins", "password_resets"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
            conn.execute(text("DELETE FROM audit_logs WHERE user_id=:uid OR (resource_type='users' AND resource_id=:uid)"),
                         {"uid": uid})
            conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})
        for entity_id in _ENTITIES:
            conn.execute(text("DELETE FROM entities WHERE id=:i"), {"i": entity_id})


# ---------------------------------------------------------------- n=11


def _insert_ad(ad_id, data):
    stamp = now_ms()
    payload = {"id": ad_id, "_created": stamp, "_lastModified": stamp, "_deleted": False, **data}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:data,false,:stamp,NULL,:stamp)"),
            {"id": ad_id, "data": json_dumps(payload), "stamp": stamp},
        )
    _ENTITIES.append(ad_id)


def _ad(ad_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:i"), {"i": ad_id}).first()
    return json_loads(row[0])


def _snapshot(meta_ad_id):
    return {
        "metaLinkState": "linked", "metaLinkVersion": 1, "metaAdId": meta_ad_id,
        "metaAdName": f"Ad {meta_ad_id}", "metaAdSetId": "555555555555555", "metaAdSetName": "Set",
        "metaCampaignId": "666666666666666", "metaCampaignName": "Camp", "metaCreativeId": "",
        "metaThumbnailUrl": "", "metaThumbnailSource": "", "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
        "metaMediaResolvedAt": "2026-09-28T10:00:00Z", "metaMediaTrace": "",
        "metaPageId": PAGE_META_ID, "metaPageName": "R8 O Client Page", "metaPageCategory": "Shop",
        "metaPagePictureUrl": "", "metaAdAccountId": ACCOUNT, "metaAdAccountName": "Albayan Business",
        "metaCurrency": "USD", "metaConfiguredStatus": "ACTIVE", "metaEffectiveStatus": "ACTIVE",
        "metaAdSetStatus": "ACTIVE", "metaCampaignStatus": "ACTIVE", "metaObjective": "MESSAGES",
        "metaBudgetSource": "adset", "metaDailyBudgetMinor": 500, "metaLifetimeBudgetMinor": 0,
        "metaTotalBudgetMinor": 5000, "metaTotalBudgetKind": "estimated_daily", "metaBudgetRemainingMinor": 0,
        "metaTotalRemainingBudgetMinor": 5000, "metaStartTime": "2026-09-20T00:00:00Z",
        "metaEndTime": "2026-09-30T00:00:00Z", "metaDurationDays": 10, "metaAdCreatedTime": "2026-09-20T00:00:00Z",
        "metaAdUpdatedTime": "2026-09-20T00:00:00Z", "metaSpend": 0.0, "metaSpendMinor": 0, "metaReach": 0,
        "metaImpressions": 0, "metaClicks": 0, "metaPrimaryResultType": "", "metaPrimaryResultValue": 0.0,
        "metaActions": [], "metaSyncedAt": "2026-09-28T10:00:00Z", "metaLastAttemptAt": "2026-09-28T10:00:00Z",
        "metaSyncError": "", "metaSyncErrorCode": "", "metaSyncFailureCount": 0,
        "metaNextSyncAt": now_ms() + 900_000, "metaUnlinkedAt": "",
    }


class _FakeMetaClient:
    def __init__(self):
        self.calls = []

    def get_ad_snapshot(self, meta_ad_id):
        self.calls.append(str(meta_ad_id))
        return _snapshot(str(meta_ad_id))


@pytest.fixture
def meta_worker(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "test-token")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta_ads, "_refresh_meta_provider_state", lambda *a, **k: None)
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", lambda: meta_ads.MetaAdsConfig(
        access_token="t", app_secret="", graph_version="v25.0", allowed_account_ids=(ACCOUNT,),
        background_sync=False, sync_interval_minutes=15, sync_batch_size=50, request_timeout_seconds=15,
    ))
    fake = _FakeMetaClient()
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    ours: set[str] = set()
    original_due = meta_ads._due_meta_ads
    # Only this module's ads take part (other modules' rows share the database).
    monkeypatch.setattr(meta_ads, "_due_meta_ads", lambda limit: [r for r in original_due(1000) if r["adId"] in ours])
    return ours


def _linked_ad(label, meta_ad_id, **extra):
    ad_id = f"ad_r8o_{label}_{TAG}"
    _insert_ad(ad_id, {
        "recordType": "ad", "status": "Active", "startDate": "2026-09-20", "amountUSD": 50,
        "metaAdId": meta_ad_id, "metaAdAccountId": ACCOUNT, "metaNextSyncAt": 0,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION, "metaSyncedAt": "2026-09-27T00:00:00Z", **extra,
    })
    return ad_id


def test_a_page_write_race_is_a_retryable_failure_not_a_duplicate_link(meta_worker, monkeypatch):
    ad_id = _linked_ad("race", RACE_META_ID, metaImportSource="meta_ads")
    meta_worker.add(ad_id)

    def page_changed_mid_write(conn, snapshot):
        # What _write_entity_data raises when the media lane archived the page avatar (or staff
        # assigned the new page an owner) between this pass's read and its write.
        raise HTTPException(status_code=409, detail="Conflict: imported entity has changed")

    monkeypatch.setattr(meta_ads, "_ensure_import_page", page_changed_mid_write)
    started = now_ms()
    meta_ads._sync_due_meta_ads_unlocked()
    after = _ad(ad_id)
    assert after["metaSyncErrorCode"] == "temporary", after.get("metaSyncErrorCode")
    assert "Unlink" not in after["metaSyncError"]
    assert int(after["metaSyncFailureCount"]) == 1
    # The retryable clock (1 minute), not the 15-minute non-retryable backoff.
    assert int(after["metaNextSyncAt"]) <= started + 5 * 60_000 + 5_000


def test_two_live_ads_on_one_meta_ad_are_still_parked_as_a_duplicate_link(meta_worker):
    first = _linked_ad("twin1", TWIN_META_ID)
    second = _linked_ad("twin2", TWIN_META_ID)
    meta_worker.update({first, second})
    meta_ads._sync_due_meta_ads_unlocked()
    for ad_id in (first, second):
        after = _ad(ad_id)
        assert after["metaSyncErrorCode"] == "duplicate_link", (ad_id, after.get("metaSyncErrorCode"))
        assert after["metaSyncError"] == "Another ad is already linked to this Meta ad. Unlink one of them."
    with db_conn() as conn:
        with pytest.raises(HTTPException) as refused:
            meta_ads._ensure_unique_link(conn, first, TWIN_META_ID)
    assert refused.value.status_code == 409  # routes still see the same 409 and text
    assert refused.value.detail == "This Meta ad is already linked to another Albayan ad"


# ---------------------------------------------------------------- n=18


def _seed_user(label, *, role="Employee", permissions=None):
    uid = new_id(f"r8o{label}")
    email = f"r8-o-{label}-{TAG}@tests.albayanhub.com"
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,last_modified) "
                 "VALUES (:id,'R8 O test',:email,:role,:perm,:h,:s,:a,:i,false,:n,:n)"),
            {"id": uid, "email": email, "role": role, "perm": json_dumps(permissions or {}), "h": pw.hash_hex,
             "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "n": now_ms()},
        )
    _USERS.append(uid)
    return {"id": uid, "email": email}


def _signed_in(user):
    login = TestClient(main.app, headers=ORIGIN).post(
        "/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert login.status_code == 200, login.text
    cookie = login.cookies.get("albayan_session")
    return TestClient(main.app, headers={**ORIGIN, "Cookie": f"albayan_session={cookie}"})


def _audit_rows(uid):
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id,action,message,metadata_json FROM audit_logs WHERE resource_type='users' AND resource_id=:uid"),
            {"uid": uid},
        ).mappings().all()
    return {row["id"]: dict(row) for row in rows}


def _one_new_row(uid, before):
    new = [row for row_id, row in _audit_rows(uid).items() if row_id not in before]
    assert len(new) == 1, new
    row = new[0]
    row["metadata"] = json_loads(row["metadata_json"] or "{}")
    return row


def test_account_changes_record_what_they_did():
    manager = _seed_user("mgr", permissions={
        "users": ["managePermissions", "changeRole", "resetPassword", "delete", "edit"],
        "receipts": ["export"], "customers": ["viewContacts"],
    })
    target = _seed_user("target")
    client = _signed_in(manager)

    before = _audit_rows(target["id"])
    grant = client.patch(f"/api/users/{target['id']}",
                         json={"permissions": {"receipts": ["export"], "customers": ["viewContacts"]}})
    assert grant.status_code == 200, grant.text
    row = _one_new_row(target["id"], before)
    assert row["action"] == "update"
    assert row["metadata"]["fields"] == ["permissions_json"]
    assert row["metadata"]["permissionsAdded"] == ["customers.viewContacts", "receipts.export"]
    assert row["metadata"]["permissionsRemoved"] == []

    before = _audit_rows(target["id"])
    revoke = client.patch(f"/api/users/{target['id']}", json={"permissions": {"receipts": ["export"]}})
    assert revoke.status_code == 200, revoke.text
    assert _one_new_row(target["id"], before)["metadata"]["permissionsRemoved"] == ["customers.viewContacts"]

    before = _audit_rows(target["id"])
    promote = client.patch(f"/api/users/{target['id']}", json={"role": "Delivery"})
    assert promote.status_code == 200, promote.text
    row = _one_new_row(target["id"], before)
    assert (row["metadata"]["roleBefore"], row["metadata"]["roleAfter"]) == ("Employee", "Delivery")
    assert "Employee -> Delivery" in row["message"]

    before = _audit_rows(target["id"])
    reset = client.patch(f"/api/users/{target['id']}", json={"password": "AnotherPassword123!"})
    assert reset.status_code == 200, reset.text
    row = _one_new_row(target["id"], before)
    assert row["metadata"]["passwordReset"] is True
    with db_conn() as conn:
        stored = conn.execute(text("SELECT password_hash,password_salt FROM users WHERE id=:i"),
                              {"i": target["id"]}).mappings().first()
    assert stored["password_hash"] not in row["metadata_json"] and stored["password_salt"] not in row["metadata_json"]
    assert "AnotherPassword123!" not in row["metadata_json"]
    assert not any(key.startswith("password_") for key in row["metadata"]["fields"])

    before = _audit_rows(target["id"])
    email = f"r8-o-renamed-{TAG}@tests.albayanhub.com"
    rename = client.patch(f"/api/users/{target['id']}", json={"email": email})
    assert rename.status_code == 200, rename.text
    row = _one_new_row(target["id"], before)
    assert (row["metadata"]["emailBefore"], row["metadata"]["emailAfter"]) == (target["email"], email)

    before = _audit_rows(target["id"])
    delete = client.patch(f"/api/users/{target['id']}", json={"deleted": True})
    assert delete.status_code == 200, delete.text
    row = _one_new_row(target["id"], before)
    assert row["action"] == "delete" and row["metadata"]["deleted"] is True
    assert row["message"] == f"Deleted user {target['id']}"


def test_a_new_account_is_audited_with_its_role_and_permissions():
    admin = _seed_user("admin", role="Admin")
    client = _signed_in(admin)
    email = f"r8-o-new-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={
        "name": "R8 O new", "email": email, "password": PASSWORD, "role": "Employee",
        "permissions": {"receipts": ["view", "export"]},
    })
    assert created.status_code == 200, created.text
    uid = created.json()["id"]
    _USERS.append(uid)
    rows = list(_audit_rows(uid).values())
    assert len(rows) == 1 and rows[0]["action"] == "create"
    assert json_loads(rows[0]["metadata_json"]) == {"role": "Employee", "permissions": ["receipts.export", "receipts.view"]}
