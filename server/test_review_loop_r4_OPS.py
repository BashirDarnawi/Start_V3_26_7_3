"""Review loop round 4, batch OPS: backups, month close, the Control Center and the integrity scan.

* n=5/11/17/8 a failed off-site upload is a setup task (not "Connected"); "Backup now" while a backup
       runs is 409 "already running" and costs none of the 6 hourly attempts; a manual failure is
       recorded in the status the Control Center shows.
* n=7  the audit export pages by the (ts, id) cursor of the last row: rows written meanwhile never
       repeat or skip entries, and equal timestamps have a stable id order.
* n=9  closing a month with a Meta ad still running needs a force reason; unlocking a month wakes
       its Meta ads the closed month had parked for 30 days.
* n=10 "Check Data Integrity" reads live rows in pages with photos stripped by the database.
* n=14 the month-close audit row carries the real totals.
* n=22 the integrity scan finds duplicate customers under the server's canonical phone rule.

Every test builds its own users (unique e-mails per run) and removes the rows it adds.
"""

import base64
import gc
import json
import os
import secrets
import sys
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
import server.meta_ads as meta_ads
from server import data_integrity, operations
from server.data_integrity import scan_entity_rows
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR4OpsPassword123!"
client = TestClient(main_module.app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = f"r4ops-admin-{TAG}@tests.albayanhub.com"


def _seed_user(email: str, role: str) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": email.split("@")[0], "email": email, "role": role, "perms": json_dumps({}),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    return uid


def _login(email: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def admin():
    init_db()
    admin_id = _seed_user(ADMIN_EMAIL, "Admin")
    return {"cookies": _login(ADMIN_EMAIL), "id": admin_id}


def _insert(entity_type: str, entity_id: str, data: dict, *, deleted: bool = False, raw: str | None = None) -> None:
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,:deleted,:t,NULL,:t)"),
            {"type": entity_type, "id": entity_id, "data": raw if raw is not None else json_dumps(data),
             "deleted": deleted, "t": stamp},
        )


def _read(entity_type: str, entity_id: str) -> tuple[dict, int]:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json, last_modified FROM entities WHERE type=:type AND id=:id"),
            {"type": entity_type, "id": entity_id},
        ).mappings().first()
    return json_loads(row["data_json"]), int(row["last_modified"])


def _delete(*keys: tuple[str, str]) -> None:
    with db_conn() as conn:
        for entity_type, entity_id in keys:
            conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), {"type": entity_type, "id": entity_id})


# ---------------------------------------------------------------- backups (n=5, 11, 17, 8)

@pytest.fixture
def backup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ALBAYAN_BACKUP_ENABLED", "true")
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"k" * 32).decode("ascii"))
    monkeypatch.setenv("ALBAYAN_BACKUP_DIR", str(tmp_path))
    monkeypatch.setenv("ALBAYAN_BACKUP_S3_BUCKET", "albayan-backups")
    monkeypatch.setenv("ALBAYAN_BACKUP_S3_ACCESS_KEY", "expired-key")
    monkeypatch.setenv("ALBAYAN_BACKUP_S3_SECRET_KEY", "expired-secret")
    monkeypatch.delenv("ALBAYAN_ALERT_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(operations, "_status", dict(operations._status, lastOffsiteError="", lastBackupError=""))
    monkeypatch.setattr(operations, "_dump_database", lambda target: Path(target).write_bytes(b"dump"))

    def refuse_upload(path, config):
        raise RuntimeError("403 InvalidAccessKeyId")

    monkeypatch.setattr(operations, "_upload_offsite", refuse_upload)
    return tmp_path


def test_a_failed_off_site_upload_is_a_setup_task_not_connected(admin, backup_env):
    reset_rate_limit(f"backup-run:{admin['id']}")
    r = client.post("/api/admin/operations/backups/run", cookies=admin["cookies"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["backup"]["offsite"] is False and "InvalidAccessKeyId" in body["backup"]["offsiteError"]
    status = client.get("/api/admin/operations/status", cookies=admin["cookies"]).json()
    assert status["backup"]["offsiteConfigured"] is True and status["backup"]["lastOffsiteError"]
    assert any("off-site" in task.lower() and "failing" in task.lower() for task in status["setupTasks"]), status["setupTasks"]
    reset_rate_limit(f"backup-run:{admin['id']}")


def test_backup_now_while_a_backup_runs_is_busy_and_costs_no_attempt(admin, backup_env, monkeypatch):
    reset_rate_limit(f"backup-run:{admin['id']}")
    assert operations._backup_process_lock.acquire(blocking=False)
    try:
        responses = [client.post("/api/admin/operations/backups/run", cookies=admin["cookies"]) for _ in range(7)]
    finally:
        operations._backup_process_lock.release()
    assert [r.status_code for r in responses] == [409] * 7, [r.text for r in responses]
    assert "already running" in responses[0].json()["detail"]
    monkeypatch.setattr(operations, "create_encrypted_backup", lambda: {"createdAt": now_ms(), "file": "f.backup.aesgcm", "bytes": 1, "offsite": True})
    after = client.post("/api/admin/operations/backups/run", cookies=admin["cookies"])
    assert after.status_code == 200, after.text          # the busy presses were not counted (was 429)
    reset_rate_limit(f"backup-run:{admin['id']}")


def test_another_workers_backup_is_busy_not_failed(admin, backup_env, monkeypatch):
    reset_rate_limit(f"backup-run:{admin['id']}")

    def busy():
        raise operations.BackupAlreadyRunning("A backup is already running on another application worker")

    monkeypatch.setattr(operations, "create_encrypted_backup", busy)
    r = client.post("/api/admin/operations/backups/run", cookies=admin["cookies"])
    assert r.status_code == 409 and "already running" in r.json()["detail"], r.text
    assert operations._status["lastBackupError"] == ""
    reset_rate_limit(f"backup-run:{admin['id']}")


def test_a_manual_backup_failure_is_recorded_for_the_control_center(admin, backup_env, monkeypatch):
    reset_rate_limit(f"backup-run:{admin['id']}")

    def broken(target):
        raise RuntimeError("pg_dump missing")

    monkeypatch.setattr(operations, "_dump_database", broken)
    r = client.post("/api/admin/operations/backups/run", cookies=admin["cookies"])
    assert r.status_code == 503 and "pg_dump" not in r.text, r.text
    status = client.get("/api/admin/operations/status", cookies=admin["cookies"]).json()
    assert "pg_dump missing" in status["backup"]["lastBackupError"]
    reset_rate_limit(f"backup-run:{admin['id']}")


# ---------------------------------------------------------------- audit export paging (n=7)

def test_audit_export_pages_by_cursor_without_repeats_or_gaps(admin):
    base_ts = 1000 + secrets.randbelow(10_000)  # far older than any real row: only ours are at or below it
    prefix = f"r4ops-{TAG}-"
    ids = [f"{prefix}{index:03d}" for index in range(23)]

    def insert(rows):
        with db_conn() as conn:
            for row_id, ts in rows:
                conn.execute(
                    text("INSERT INTO audit_logs (id,ts,user_id,action,resource_type,resource_id,message,metadata_json) "
                         "VALUES (:id,:ts,NULL,'r4ops','test',:id,'r4 ops paging',NULL)"),
                    {"id": row_id, "ts": ts},
                )

    insert([(row_id, base_ts - (index // 5)) for index, row_id in enumerate(ids)])  # five rows share each ts
    try:
        seen: list[str] = []
        cursor = {"before_ts": base_ts + 1, "before_id": ""}
        for page in range(20):
            r = client.get("/api/audit", params={"limit": 4, **cursor}, cookies=admin["cookies"])
            assert r.status_code == 200, r.text
            rows = r.json()
            seen += [row["id"] for row in rows]
            # Staff keep working: a new row lands at the top between two export pages.
            insert([(f"{prefix}new-{page:02d}", base_ts)])
            if len(rows) < 4:
                break
            cursor = {"before_ts": rows[-1]["ts"], "before_id": rows[-1]["id"]}
        ours = [row_id for row_id in seen if not row_id.startswith(f"{prefix}new-")]
        assert len(seen) == len(set(seen)), seen            # no entry repeated
        assert sorted(ours) == sorted(ids), ours            # none skipped
        order = [(base_ts - (ids.index(row_id) // 5), row_id) for row_id in ours]
        assert order == sorted(order, reverse=True)         # ts DESC, then id DESC
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM audit_logs WHERE id LIKE :p"), {"p": f"{prefix}%"})


# ---------------------------------------------------------------- month close (n=9, 14)

def test_a_running_meta_ad_blocks_the_close_until_a_force_reason(admin):
    period = "2012-08"
    running, stopped = f"r4ops_run_{TAG}", f"r4ops_stop_{TAG}"
    base = {"recordType": "ad", "customerId": "c1", "amountUSD": 100, "paymentStatus": "Paid", "startDate": "2012-08-28"}
    _insert("ads", running, {**base, "status": "Active", "endDate": "2012-09-06", "metaAdId": "933333333333333"})
    _insert("ads", stopped, {**base, "status": "Stopped", "spentUSD": 20, "metaAdId": "944444444444444"})
    try:
        snapshot = operations._period_snapshot(period)
        blockers = {b["code"]: b["count"] for b in snapshot["blockers"]}
        assert blockers.get("ads_still_running") == 1, snapshot["blockers"]
        assert snapshot["counts"]["adsStillRunning"] == 1
        refused = client.post("/api/admin/operations/financial-periods/close", json={"period": period}, cookies=admin["cookies"])
        assert refused.status_code == 409, refused.text
    finally:
        _delete(("ads", running), ("ads", stopped), ("financialClosures", f"financial-close-{period}"))


def test_unlocking_a_month_wakes_its_parked_meta_ads(admin):
    period = "2012-07"
    parked, other = f"r4ops_parked_{TAG}", f"r4ops_other_{TAG}"
    far = now_ms() + 30 * 86_400_000
    common = {"recordType": "ad", "status": "Active", "metaNextSyncAt": far, "metaAdAccountId": "444444444444444",
              "metaMediaVersion": meta_ads._META_MEDIA_VERSION, "metaMediaRepairVersion": meta_ads._META_MEDIA_VERSION}
    _insert("ads", parked, {**common, "startDate": "2012-07-20", "metaAdId": "955555555555555"})
    _insert("ads", other, {**common, "startDate": "2012-06-20", "metaAdId": "966666666666666"})
    _insert("financialClosures", f"financial-close-{period}", {"period": period, "status": "closed"})
    try:
        _before, version_before = _read("ads", parked)
        r = client.post(f"/api/admin/operations/financial-periods/{period}/unlock",
                        json={"reason": "correct a July ad after close"}, cookies=admin["cookies"])
        assert r.status_code == 200, r.text
        after, version_after = _read("ads", parked)
        assert int(after["metaNextSyncAt"]) <= now_ms()      # sync again now, not in 30 days
        assert version_after == version_before              # a scheduling stamp, not an edit
        assert int(_read("ads", other)[0]["metaNextSyncAt"]) == far  # another month's park is untouched
        assert parked in {item["adId"] for item in meta_ads._due_meta_ads(10_000)}
    finally:
        _delete(("ads", parked), ("ads", other), ("financialClosures", f"financial-close-{period}"))


def test_the_month_close_audit_row_carries_the_totals(admin, monkeypatch):
    period = "2011-03"
    totals = {"receiptVolumeUSD": 100.0, "paidReceiptsUSD": 80.0, "adSalesUSD": 50.0, "adSpendUSD": 30.0}
    monkeypatch.setattr(operations, "_period_snapshot", lambda p, conn=None: {
        "period": p, "generatedAt": 1, "counts": {}, "totals": dict(totals, metaSpendUSD=30.0), "blockers": []})
    try:
        r = client.post("/api/admin/operations/financial-periods/close", json={"period": period}, cookies=admin["cookies"])
        assert r.status_code == 200, r.text
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT metadata_json FROM audit_logs WHERE action='close' AND resource_id=:rid ORDER BY ts DESC LIMIT 1"),
                {"rid": f"financial-close-{period}"},
            ).mappings().first()
        assert json_loads(row["metadata_json"])["totals"] == totals
    finally:
        _delete(("financialClosures", f"financial-close-{period}"))


# ---------------------------------------------------------------- integrity scan (n=10, 22)

def test_integrity_scan_never_reads_photos_or_deleted_rows(admin, monkeypatch):
    marker = f"R4OPS{TAG}"
    blob = "data:image/png;base64," + marker + "A" * (6 * 1024 * 1024)
    customer, receipt, deleted_ad, broken = f"r4ops_cust_{TAG}", f"r4ops_rcpt_{TAG}", f"r4ops_ad_{TAG}", f"r4ops_bad_{TAG}"
    _insert("customers", customer, {"name": "Scan", "phones": [f"09{secrets.randbelow(10**8):08d}"]})
    _insert("receipts", receipt, {"customerId": customer, "serialNumber": f"R4-{TAG}", "photos": [blob]})
    _insert("ads", deleted_ad, {"customerId": customer, "adPhotos": [blob]}, deleted=True)
    _insert("receipts", broken, {}, raw="{not json")
    seen = {"blob": False}
    real_loads = data_integrity.json_loads

    def spy(value):
        if isinstance(value, str) and marker in value:
            seen["blob"] = True
        return real_loads(value)

    monkeypatch.setattr(data_integrity, "json_loads", spy)
    try:
        gc.collect()
        tracemalloc.start()
        result = data_integrity.scan_database()
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert seen["blob"] is False                        # the database stripped the photo
        assert peak < 4 * 1024 * 1024, peak                 # less than one photo ever reached Python
        issues = [item for item in result["issues"] if item["entityId"] in {customer, receipt, deleted_ad, broken}]
        assert {(item["code"], item["entityId"]) for item in issues} == {("invalid_json", broken)}, issues
    finally:
        if tracemalloc.is_tracing():
            tracemalloc.stop()
        _delete(("customers", customer), ("receipts", receipt), ("ads", deleted_ad), ("receipts", broken))


def test_integrity_scan_uses_the_canonical_phone_key():
    def row(entity_id, data):
        return {"type": "customers", "id": entity_id, "data_json": json.dumps(data), "deleted": False}

    result = scan_entity_rows([
        row("x", {"phone": "0912345678"}),
        row("y", {"phones": [{"value": "+218 91 234 5678"}]}),
        row("l1", {"phone": "021 333 4455"}),
        row("l2", {"phones": ["00218213334455"]}),
    ])
    codes = [item["code"] for item in result["issues"]]
    assert result["ok"] is False
    assert codes.count("duplicate_customer_phone") == 4, result["issues"]
