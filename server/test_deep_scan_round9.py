"""Deep-scan round 9: operations, audit trail, backups and the holistic-review corrections."""

import os
import secrets
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import main, operations
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r9-admin-{TAG}@tests.albayanhub.com"
EMP_EMAIL = f"r9-employee-{TAG}@tests.albayanhub.com"
PASSWORD = "Round9Pass123!"


def _seed_user(email: str, role: str, permissions: dict) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": email.split("@")[0], "email": email, "role": role, "perms": json_dumps(permissions),
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
def actors():
    init_db()
    admin_id = _seed_user(ADMIN_EMAIL, "Admin", {})
    emp_id = _seed_user(EMP_EMAIL, "Employee", {"receipts": ["view", "edit"], "customers": ["view", "edit"]})
    return {"admin": _login(ADMIN_EMAIL), "admin_id": admin_id, "employee": _login(EMP_EMAIL), "employee_id": emp_id}


def _create(collection: str, entity_id: str, data: dict, cookies) -> dict:
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _entity(collection: str, entity_id: str, cookies) -> dict:
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _audit_rows(resource_id: str, action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT user_id, message, metadata_json FROM audit_logs WHERE resource_id=:rid AND action=:action ORDER BY ts"),
            {"rid": resource_id, "action": action},
        ).mappings().all()
    return [{"user_id": r["user_id"], "message": r["message"], "meta": json_loads(r["metadata_json"] or "{}") or {}} for r in rows]


# ---------------------------------------------------------------- audit trail

def test_company_coverage_writes_an_audit_row_with_the_amount(actors):
    cid, rid, aid = f"r9_cust_{TAG}", f"r9_rcpt_{TAG}", f"r9_ad_{TAG}"
    _create("customers", cid, {"name": cid, "phones": [f"09{secrets.randbelow(10**8):08d}"]}, actors["admin"])
    _create("receipts", rid, {"recordType": "receipt", "customerId": cid, "amountUSD": 100, "amountLocal": 500,
                              "debtAmountUSD": 100, "debtAmountLocal": 500, "exchangeRate": 5, "status": "Not Paid",
                              "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}},
            actors["admin"])
    r = client.post("/api/ads/mutate", json={"action": "create", "adId": aid, "idempotencyKey": f"{aid}-create",
                                             "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                                                      "exchangeRate": 5, "receiptId": rid,
                                                      "dueAllocations": [{"receiptId": rid, "amountUSD": 100}], "receiptAllocations": []}},
                    cookies=actors["admin"])
    assert r.status_code == 200, r.text
    receipt = _entity("receipts", rid, actors["admin"])
    r = client.post(f"/api/receipts/{rid}/company-coverages",
                    json={"amountMinorUSD": 2500, "idempotencyKey": f"r9-cover-{TAG}", "expectedLastModified": receipt["lastModified"],
                          "reason": "Round nine audit coverage"}, cookies=actors["admin"])
    assert r.status_code == 200, r.text
    rows = _audit_rows(rid, "company_coverage")
    assert len(rows) == 1, rows
    assert rows[0]["user_id"] == actors["admin_id"]
    assert rows[0]["meta"]["amountMinorUSD"] == 2500 and rows[0]["meta"]["receiptId"] == rid
    assert rows[0]["meta"]["reason"] == "Round nine audit coverage" and aid in rows[0]["meta"]["adIds"]
    assert "$25.00" in rows[0]["message"]
    # a replay of the same key does not write a second trail row
    r = client.post(f"/api/receipts/{rid}/company-coverages",
                    json={"amountMinorUSD": 2500, "idempotencyKey": f"r9-cover-{TAG}", "expectedLastModified": receipt["lastModified"],
                          "reason": "Round nine audit coverage"}, cookies=actors["admin"])
    assert r.status_code == 200, r.text
    assert len(_audit_rows(rid, "company_coverage")) == 1


def test_wallet_top_up_audit_carries_the_amount_and_target(actors):
    r = client.post("/api/wallet/top-ups", json={"userId": actors["employee_id"], "amountMinor": 1250, "currency": "USD",
                                                 "idempotencyKey": f"r9-topup-{TAG}", "memo": "round nine"}, cookies=actors["admin"])
    assert r.status_code == 200, r.text
    rows = _audit_rows(r.json()["id"], "create")
    assert rows and rows[0]["meta"]["amountMinor"] == 1250, rows
    assert rows[0]["meta"]["toUserId"] == actors["employee_id"] and rows[0]["meta"]["currency"] == "USD"


def test_audit_cleanup_keeps_money_history_and_records_itself():
    old_ts = now_ms() - 400 * 24 * 3600 * 1000  # older than the 365-day default
    keep_id, drop_id = f"audit_r9keep_{TAG}", f"audit_r9drop_{TAG}"
    with db_conn() as conn:
        for row_id, action in ((keep_id, "close"), (drop_id, "update")):
            conn.execute(
                text("INSERT INTO audit_logs (id, ts, user_id, action, resource_type, resource_id, message, metadata_json) "
                     "VALUES (:id, :ts, NULL, :action, 'financialClosures', :rid, 'round nine', '{}')"),
                {"id": row_id, "ts": old_ts, "action": action, "rid": f"r9_period_{TAG}"},
            )
    main.cleanup_old_audit_logs()
    with db_conn() as conn:
        left = {r[0] for r in conn.execute(text("SELECT id FROM audit_logs WHERE id IN (:a, :b)"), {"a": keep_id, "b": drop_id})}
    assert keep_id in left and drop_id not in left, left
    cleanup_rows = _audit_rows("startup", "cleanup")
    assert cleanup_rows and cleanup_rows[-1]["meta"]["deletedByAge"] >= 1
    assert cleanup_rows[-1]["meta"]["retentionDays"] == main.AUDIT_LOG_RETENTION_DAYS
    with db_conn() as conn:
        conn.execute(text("DELETE FROM audit_logs WHERE id=:id"), {"id": keep_id})


def test_retention_defaults_match_the_ui_promise():
    assert main.AUDIT_LOG_RETENTION_DAYS >= 365
    assert main.AUDIT_LOG_MAX_RECORDS >= 500_000
    for action in ("close", "unlock", "company_coverage", "cleanup"):
        assert f"'{action}'" in main._AUDIT_KEEP_ACTIONS


# ---------------------------------------------------------------- month close history

def test_reclosing_a_month_keeps_every_snapshot_in_history(actors):
    period = "2018-03"
    admin = actors["admin"]
    for _ in range(2):
        closed = client.post("/api/admin/operations/financial-periods/close", json={"period": period, "forceReason": "round nine history"}, cookies=admin)
        assert closed.status_code == 200, closed.text
        unlocked = client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "round nine reopen"}, cookies=admin)
        assert unlocked.status_code == 200, unlocked.text
    closed = client.post("/api/admin/operations/financial-periods/close", json={"period": period, "forceReason": "round nine history"}, cookies=admin)
    assert closed.status_code == 200, closed.text
    try:
        body = closed.json()
        record = body["data"] if isinstance(body.get("data"), dict) and "history" in body["data"] else body
        history = record["history"]
        closes = [h for h in history if h["action"] == "closed"]
        assert len(closes) >= 3
        for entry in closes[-3:]:
            assert isinstance(entry.get("snapshot"), dict) and "blockers" in entry["snapshot"], entry
    finally:
        client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "round nine cleanup"}, cookies=admin)


# ---------------------------------------------------------------- backups

def test_backup_pruning_keeps_the_newest_three_files_whatever_their_age(tmp_path):
    old = time.time() - 30 * 86400
    for i in range(5):
        p = tmp_path / f"albayan-2026010{i}T000000.000000Z-abcd.backup.aesgcm"
        p.write_bytes(b"x")
        os.utime(p, (old + i * 60, old + i * 60))
    operations._cleanup_old_backups(tmp_path, retention_days=7)
    left = sorted(p.name for p in tmp_path.glob("albayan-*.backup.aesgcm"))
    assert len(left) == 3 and left[0].startswith("albayan-20260102"), left


def test_overdue_backup_is_a_setup_task(monkeypatch):
    monkeypatch.setattr(operations, "_backup_config", lambda: {"enabled": True, "encryptionReady": True, "offsiteConfigured": True,
                                                                "intervalHours": 24, "retentionDays": 30, "alertingConfigured": True})
    monkeypatch.setitem(operations._status, "lastBackupAt", now_ms() - 3 * 24 * 3600 * 1000)
    tasks = operations._public_status()["setupTasks"]
    assert any("overdue" in t for t in tasks), tasks
    monkeypatch.setitem(operations._status, "lastBackupAt", now_ms() - 3600 * 1000)
    assert not any("overdue" in t for t in operations._public_status()["setupTasks"])


def test_worker_stops_are_single_shot():
    operations._worker_stop.set()
    operations._worker_thread = None
    started = time.monotonic()
    operations.stop_operations_worker()
    operations.stop_operations_worker()
    assert time.monotonic() - started < 0.5
    from server import meta_ads
    from server.systems.ads_studio import social_studio
    social_studio.stop_social_studio_worker(); social_studio.stop_social_studio_worker()
    meta_ads.stop_meta_ads_worker(); meta_ads.stop_meta_ads_worker()


# ---------------------------------------------------------------- holistic-review corrections

def test_boot_index_uses_the_ddl_lock_guard():
    from server import create_indexes
    src = Path(create_indexes.__file__).read_text(encoding="utf-8")
    assert "_bound_ddl_locks(conn)" in src


def test_mixed_edit_from_an_old_build_keeps_a_canceled_job_canceled(actors):
    cid, rid = f"r9_cust2_{TAG}", f"r9_rcpt2_{TAG}"
    _create("customers", cid, {"name": cid, "phones": [f"09{secrets.randbelow(10**8):08d}"]}, actors["admin"])
    _create("receipts", rid, {"recordType": "receipt", "customerId": cid, "amountUSD": 40, "amountLocal": 200,
                              "exchangeRate": 5, "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office",
                              "statusDetail": {"notPaidCollection": "office"}}, actors["admin"])
    created = _entity("receipts", rid, actors["admin"])
    r = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"deliveryStatus": "Canceled"}, "expectedLastModified": created["lastModified"]},
                     cookies=actors["admin"])  # admins are exempt from the staff reopen guard
    assert r.status_code == 200, r.text
    before = _entity("receipts", rid, actors["employee"])
    # an older build re-derives deliveryStatus while the user only fixes the notes
    r = client.patch(f"/api/collections/receipts/{rid}",
                     json={"data": {"notes": "phone fixed", "deliveryStatus": "Needs Delivery"}, "expectedLastModified": before["lastModified"]},
                     cookies=actors["employee"])
    assert r.status_code == 200, r.text
    after = _entity("receipts", rid, actors["employee"])["data"]
    assert after["deliveryStatus"] == "Canceled" and after["notes"] == "phone fixed"
    # a pure status move is still refused
    latest = _entity("receipts", rid, actors["employee"])
    r = client.patch(f"/api/collections/receipts/{rid}",
                     json={"data": {"deliveryStatus": "Needs Delivery"}, "expectedLastModified": latest["lastModified"]},
                     cookies=actors["employee"])
    assert r.status_code == 400, r.text
    # and so is a mixed edit that also re-points the job at a driver
    r = client.patch(f"/api/collections/receipts/{rid}",
                     json={"data": {"notes": "with driver", "deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["employee_id"],
                                    "statusDetail": {"notPaidCollection": "delivery"}}, "expectedLastModified": latest["lastModified"]},
                     cookies=actors["employee"])
    assert r.status_code == 400 and "reopened" in r.text, r.text
    assert _entity("receipts", rid, actors["employee"])["data"]["deliveryStatus"] == "Canceled"


def test_start_day_itself_counts_as_not_started():
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    from server.systems.ads_studio.ad_campaign_actions import _campaign_start_is_in_future
    today = datetime.now(ZoneInfo("Africa/Tripoli")).date()
    assert _campaign_start_is_in_future({"startDate": today.isoformat()}) is True
    assert _campaign_start_is_in_future({"startDate": (today - timedelta(days=1)).isoformat()}) is False
    assert _campaign_start_is_in_future({"startDate": "not a date"}) is False


def test_online_import_refuses_the_plan_catalog(actors, monkeypatch):
    monkeypatch.setattr(main, "ENABLE_ONLINE_IMPORT", True, raising=False)
    r = client.post("/api/admin/import", json={"collections": {"appSettings": [{"id": f"r9_plans_{TAG}", "settingKey": main.PLAN_SETTINGS_KEY, "plans": []}]}},
                    cookies=actors["admin"])
    assert r.status_code in {405, 404, 403}, r.text
    if r.status_code == 405:
        assert "plan catalog" in r.text.lower()


def test_receipt_delta_polls_with_media_are_not_throttled(actors):
    from server.rate_limiter import reset_rate_limit
    reset_rate_limit(f"receipts-media-list:{actors['admin_id']}")
    statuses = {client.get(f"/api/collections/receipts?limit=500&include_media=true&updated_since={now_ms() - 1000}",
                           cookies=actors["admin"]).status_code for _ in range(35)}
    assert statuses == {200}, statuses
    # an "everything since the dawn of time" delta is a full listing and stays throttled
    reset_rate_limit(f"receipts-media-list:{actors['admin_id']}")
    old = [client.get("/api/collections/receipts?limit=26&include_media=true&updated_since=1", cookies=actors["admin"]).status_code
           for _ in range(31)]
    assert old[:30] == [200] * 30 and old[30] == 429, old
    reset_rate_limit(f"receipts-media-list:{actors['admin_id']}")


def test_body_size_gate_uses_the_configured_cookie_name():
    from server.startup_support import request_size_refusal
    import inspect
    assert "cookie_name" in inspect.signature(request_size_refusal).parameters
    src = Path(main.__file__).read_text(encoding="utf-8")
    assert "_request_size_refusal(request, cookie_name=COOKIE_NAME" in src
