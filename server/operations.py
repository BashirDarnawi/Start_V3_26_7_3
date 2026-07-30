"""Operational safety controls for Albayan.

This module deliberately stays separate from the accounting engine. It adds:

* immutable monthly close snapshots and an explicit audited unlock operation;
* encrypted, restorable PostgreSQL/SQLite backups with optional S3-compatible
  off-site upload;
* deduplicated webhook alerts and an Admin-only operations status endpoint.

No secret is ever returned to the browser. Missing backup/off-site settings are
reported as setup tasks instead of silently pretending the system is protected.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from datetime import date, datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable
from urllib.request import Request as UrlRequest, urlopen
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, get_engine, json_dumps, json_loads, now_ms
from .monitoring import get_metrics


FINANCIAL_CLOSE_COLLECTION = "financialClosures"
FINANCIAL_PERIOD_COLLECTIONS = frozenset({"receipts", "ads", "dollarPurchases"})
_PERIOD_RE = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])$")
_BACKUP_MAGIC = b"ALBAYANBK1"
_worker_stop = threading.Event()
_worker_thread: threading.Thread | None = None
_backup_process_lock = threading.Lock()
_state_lock = threading.Lock()
_last_alert_at: dict[str, float] = {}
_status: dict[str, Any] = {
    "workerRunning": False,
    "lastBackupAt": None,
    "lastBackupFile": "",
    "lastBackupBytes": 0,
    "lastBackupError": "",
    "lastOffsiteAt": None,
    "lastOffsiteError": "",
    "lastAlertAt": None,
}


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int((os.getenv(name) or str(default)).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float((os.getenv(name) or str(default)).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _business_today() -> date:
    name = (os.getenv("ALBAYAN_BUSINESS_TIMEZONE") or "Africa/Tripoli").strip()
    try:
        return datetime.now(ZoneInfo(name)).date()
    except Exception:
        return datetime.now(timezone.utc).date()


def _backup_directory() -> Path:
    path = Path(os.getenv("ALBAYAN_BACKUP_DIR", "/var/lib/albayan/backups")).expanduser()
    return path.resolve()


def _backup_key() -> bytes | None:
    raw = (os.getenv("ALBAYAN_BACKUP_KEY") or "").strip()
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception:
        return None
    return decoded if len(decoded) == 32 else None


def _backup_config() -> dict[str, Any]:
    key_ready = _backup_key() is not None
    bucket = (os.getenv("ALBAYAN_BACKUP_S3_BUCKET") or "").strip()
    access = (os.getenv("ALBAYAN_BACKUP_S3_ACCESS_KEY") or "").strip()
    secret = (os.getenv("ALBAYAN_BACKUP_S3_SECRET_KEY") or "").strip()
    return {
        "enabled": _env_bool("ALBAYAN_BACKUP_ENABLED", False),
        "encryptionReady": key_ready,
        "directory": str(_backup_directory()),
        "intervalHours": _env_int("ALBAYAN_BACKUP_INTERVAL_HOURS", 24, 1, 168),
        "retentionDays": _env_int("ALBAYAN_BACKUP_RETENTION_DAYS", 30, 2, 3650),
        "offsiteConfigured": bool(bucket and access and secret),
        "offsiteBucket": bucket,
        "alertingConfigured": bool((os.getenv("ALBAYAN_ALERT_WEBHOOK_URL") or "").strip()),
    }


def _safe_number(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return number if number == number and abs(number) != float("inf") else 0.0


def _entity_rows(collection: str, conn: Any | None = None) -> list[dict[str, Any]]:
    def read_rows(active_conn: Any) -> list[Any]:
        return active_conn.execute(
            text(
                "SELECT id, data_json, created_at, created_by, last_modified "
                "FROM entities WHERE type=:type AND deleted=false"
            ),
            {"type": collection},
        ).mappings().all()
    if conn is None:
        with db_conn() as active_conn:
            rows = read_rows(active_conn)
    else:
        rows = read_rows(conn)
    result: list[dict[str, Any]] = []
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            continue
        data.setdefault("id", str(row.get("id") or ""))
        data.setdefault("_created", int(row.get("created_at") or 0))
        data.setdefault("_lastModified", int(row.get("last_modified") or 0))
        result.append(data)
    return result


def _record_date(collection: str, data: dict[str, Any]) -> date | None:
    keys = {
        "receipts": ("date", "receiptDate", "createdAt", "_created"),
        "ads": ("startDate", "date", "metaStartTime", "createdAt", "_created"),
        "dollarPurchases": ("purchaseDate", "createdAt", "_created"),
    }.get(collection, ("date", "createdAt", "_created"))
    for key in keys:
        value = data.get(key)
        if value in (None, ""):
            continue
        if isinstance(value, (int, float)):
            try:
                stamp = float(value)
                return datetime.fromtimestamp(stamp if abs(stamp) < 100_000_000_000 else stamp / 1000, tz=timezone.utc).date()
            except (OverflowError, OSError, ValueError):
                continue
        text_value = str(value).strip()
        try:
            if len(text_value) >= 10:
                return date.fromisoformat(text_value[:10])
        except ValueError:
            continue
    return None


def _period_for_record(collection: str, data: dict[str, Any]) -> str | None:
    value = _record_date(collection, data)
    return value.strftime("%Y-%m") if value else None


def _close_record(period: str, conn: Any | None = None) -> dict[str, Any] | None:
    def read_record(active_conn: Any) -> Any:
        return active_conn.execute(
            text(
                "SELECT data_json FROM entities "
                "WHERE type=:type AND id=:id AND deleted=false LIMIT 1"
            ),
            {"type": FINANCIAL_CLOSE_COLLECTION, "id": f"financial-close-{period}"},
        ).mappings().first()

    if conn is None:
        with db_conn() as active_conn:
            row = read_record(active_conn)
    else:
        row = read_record(conn)
    if not row:
        return None
    data = json_loads(row.get("data_json") or "{}") or {}
    return data if isinstance(data, dict) else None


def _financial_period_lock_key(period: str) -> int:
    digest = hashlib.sha256(f"albayan-financial-period:{period}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def _lock_financial_period(conn: Any, period: str) -> None:
    if str(conn.engine.dialect.name or "") == "postgresql":
        conn.execute(
            text("SELECT pg_advisory_xact_lock(:lock_key)"),
            {"lock_key": _financial_period_lock_key(period)},
        )


def assert_financial_period_open(
    collection: str,
    data: dict[str, Any] | None,
    *,
    conn: Any | None = None,
) -> None:
    """Reject a manual mutation whose business date belongs to a closed month."""
    if collection not in FINANCIAL_PERIOD_COLLECTIONS or not isinstance(data, dict):
        return
    period = _period_for_record(collection, data)
    if not period:
        return
    if conn is not None:
        _lock_financial_period(conn, period)
    close = _close_record(period, conn=conn)
    if close and str(close.get("status") or "").lower() == "closed":
        raise HTTPException(
            status_code=423,
            detail=f"Financial period {period} is closed. An Admin must unlock it before editing.",
        )


def financial_period_is_closed(collection: str, data: dict[str, Any] | None, *, conn: Any) -> bool:
    """Lock and identify closed rows so maintenance backfills can safely skip them."""
    if collection not in FINANCIAL_PERIOD_COLLECTIONS or not isinstance(data, dict):
        return False
    period = _period_for_record(collection, data)
    if not period:
        return False
    _lock_financial_period(conn, period)
    close = _close_record(period, conn=conn)
    return bool(close and str(close.get("status") or "").lower() == "closed")


def lock_financial_period_for_redaction(collection: str, data: dict[str, Any] | None, *, conn: Any) -> None:
    """Serialize a PII-only legal redaction; close snapshots contain no creator names."""
    if collection in FINANCIAL_PERIOD_COLLECTIONS and isinstance(data, dict):
        period = _period_for_record(collection, data)
        if period:
            _lock_financial_period(conn, period)


def assert_financial_bulk_import_open(
    collection: str,
    existing_rows: list[Any],
    active_records: list[tuple[str, dict[str, Any], Any, Any]],
    *,
    conn: Any,
) -> None:
    """Protect closed months while preserving the transactional backup importer."""
    if collection not in FINANCIAL_PERIOD_COLLECTIONS:
        return
    active_ids = {record_id for record_id, *_rest in active_records}
    existing_by_id = {str(row["id"]): row for row in existing_rows}
    for record_id, row in existing_by_id.items():
        if not bool(row["deleted"]) and record_id not in active_ids:
            assert_financial_period_open(collection, json_loads(row.get("data_json") or "{}") or {}, conn=conn)
    for record_id, data, *_rest in active_records:
        old = existing_by_id.get(record_id)
        if old is not None and not bool(old["deleted"]):
            assert_financial_period_open(collection, json_loads(old.get("data_json") or "{}") or {}, conn=conn)
        assert_financial_period_open(collection, data, conn=conn)


def _period_snapshot(period: str, conn: Any | None = None) -> dict[str, Any]:
    receipts = [row for row in _entity_rows("receipts", conn) if _period_for_record("receipts", row) == period]
    ads = [row for row in _entity_rows("ads", conn) if _period_for_record("ads", row) == period]
    purchases = [row for row in _entity_rows("dollarPurchases", conn) if _period_for_record("dollarPurchases", row) == period]

    normal_receipts = [row for row in receipts if str(row.get("receiptType") or "") != "TRANSFER_IN"]
    receipt_total = sum(max(0.0, _safe_number(row.get("amountUSD") if row.get("amountUSD") is not None else row.get("amount"))) for row in normal_receipts)
    paid_receipts = [row for row in normal_receipts if row.get("isPaid") is True or str(row.get("status") or "").lower() == "paid"]
    paid_total = sum(max(0.0, _safe_number(row.get("amountUSD") if row.get("amountUSD") is not None else row.get("amount"))) for row in paid_receipts)
    ad_sales = sum(max(0.0, _safe_number(row.get("amountUSD"))) for row in ads)
    meta_spend = sum(max(0.0, _safe_number(row.get("metaSpendMinor")) / 100) for row in ads)
    purchase_usd = sum(max(0.0, _safe_number(row.get("amountUSD"))) for row in purchases)
    purchase_cost_lyd = sum(max(0.0, _safe_number(row.get("totalLYD"))) for row in purchases)
    setup_ads = [
        row for row in ads
        if not str(row.get("customerId") or "").strip()
        or _safe_number(row.get("amountUSD")) <= 0
        or not str(row.get("paymentStatus") or "").strip()
    ]
    unpaid_receipts = [row for row in normal_receipts if row not in paid_receipts]
    blockers = []
    if setup_ads:
        blockers.append({"code": "ads_need_setup", "count": len(setup_ads), "message": "Ads still need customer, amount, or payment setup"})
    if unpaid_receipts:
        blockers.append({"code": "unpaid_receipts", "count": len(unpaid_receipts), "message": "Receipts are still unpaid"})
    return {
        "period": period,
        "generatedAt": now_ms(),
        "counts": {
            "receipts": len(normal_receipts),
            "paidReceipts": len(paid_receipts),
            "unpaidReceipts": len(unpaid_receipts),
            "ads": len(ads),
            "adsNeedingSetup": len(setup_ads),
            "dollarPurchases": len(purchases),
        },
        "totals": {
            "receiptVolumeUSD": round(receipt_total, 2),
            "paidReceiptsUSD": round(paid_total, 2),
            "adSalesUSD": round(ad_sales, 2),
            "metaSpendUSD": round(meta_spend, 2),
            "dollarsPurchasedUSD": round(purchase_usd, 2),
            "dollarPurchaseCostLYD": round(purchase_cost_lyd, 2),
        },
        "blockers": blockers,
    }


def _save_close_record(period: str, data: dict[str, Any], user_id: str, conn: Any | None = None) -> dict[str, Any]:
    entity_id = f"financial-close-{period}"
    now = now_ms()
    clean = dict(data)
    clean.update({"id": entity_id, "period": period, "_lastModified": now})
    def save(active_conn: Any) -> None:
        existing = active_conn.execute(
            text("SELECT created_at, created_by FROM entities WHERE type=:type AND id=:id LIMIT 1"),
            {"type": FINANCIAL_CLOSE_COLLECTION, "id": entity_id},
        ).mappings().first()
        if existing:
            created_at = int(existing.get("created_at") or now)
            created_by = str(existing.get("created_by") or user_id)
            clean.setdefault("_created", created_at)
            clean.setdefault("createdBy", created_by)
            active_conn.execute(
                text(
                    "UPDATE entities SET data_json=:data, deleted=false, last_modified=:modified "
                    "WHERE type=:type AND id=:id"
                ),
                {"data": json_dumps(clean), "modified": now, "type": FINANCIAL_CLOSE_COLLECTION, "id": entity_id},
            )
        else:
            clean.setdefault("_created", now)
            clean.setdefault("createdBy", user_id)
            active_conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:type,:id,:data,false,:created,:created_by,:modified)"
                ),
                {"type": FINANCIAL_CLOSE_COLLECTION, "id": entity_id, "data": json_dumps(clean), "created": now, "created_by": user_id, "modified": now},
            )
    if conn is None:
        with db_conn() as active_conn:
            save(active_conn)
    else:
        save(conn)
    return clean


def _encrypt_backup(source: Path, target: Path, key: bytes) -> int:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise RuntimeError("cryptography package is required for encrypted backups") from exc
    payload = source.read_bytes()
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, payload, _BACKUP_MAGIC)
    temp_target = target.with_suffix(target.suffix + ".tmp")
    temp_target.write_bytes(_BACKUP_MAGIC + nonce + ciphertext)
    os.replace(temp_target, target)
    return target.stat().st_size


def decrypt_backup_file(source: Path, target: Path, key: bytes) -> None:
    """Used by the restore helper and tests; it never writes into the live DB."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    payload = source.read_bytes()
    if not payload.startswith(_BACKUP_MAGIC) or len(payload) < len(_BACKUP_MAGIC) + 13:
        raise ValueError("Not an Albayan encrypted backup")
    offset = len(_BACKUP_MAGIC)
    nonce = payload[offset:offset + 12]
    plaintext = AESGCM(key).decrypt(nonce, payload[offset + 12:], _BACKUP_MAGIC)
    target.write_bytes(plaintext)


def _dump_database(target: Path) -> None:
    engine = get_engine()
    url = engine.url
    if engine.dialect.name == "postgresql":
        executable = shutil.which("pg_dump")
        if not executable:
            raise RuntimeError("pg_dump is not installed in the application container")
        args = [executable, "--format=custom", "--no-owner", "--no-acl", "--file", str(target)]
        if url.host:
            args += ["--host", str(url.host)]
        if url.port:
            args += ["--port", str(url.port)]
        if url.username:
            args += ["--username", str(url.username)]
        if url.database:
            args += ["--dbname", str(url.database)]
        env = os.environ.copy()
        if url.password:
            env["PGPASSWORD"] = str(url.password)
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=1800, check=False)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "pg_dump failed").strip()[:500])
        return
    if engine.dialect.name == "sqlite":
        source_path = Path(str(url.database or "")).resolve()
        if not source_path.exists():
            raise RuntimeError("SQLite database file was not found")
        source = sqlite3.connect(str(source_path))
        destination = sqlite3.connect(str(target))
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        return
    raise RuntimeError(f"Unsupported backup database: {engine.dialect.name}")


def _upload_offsite(path: Path, config: dict[str, Any]) -> None:
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("boto3 package is required for off-site backups") from exc
    client = boto3.client(
        "s3",
        endpoint_url=(os.getenv("ALBAYAN_BACKUP_S3_ENDPOINT_URL") or "").strip() or None,
        aws_access_key_id=(os.getenv("ALBAYAN_BACKUP_S3_ACCESS_KEY") or "").strip(),
        aws_secret_access_key=(os.getenv("ALBAYAN_BACKUP_S3_SECRET_KEY") or "").strip(),
        region_name=(os.getenv("ALBAYAN_BACKUP_S3_REGION") or "").strip() or None,
    )
    prefix = (os.getenv("ALBAYAN_BACKUP_S3_PREFIX") or "albayan").strip().strip("/")
    key = f"{prefix}/{path.name}" if prefix else path.name
    client.upload_file(str(path), config["offsiteBucket"], key)


def _send_alert(kind: str, severity: str, message: str, details: dict[str, Any] | None = None) -> None:
    url = (os.getenv("ALBAYAN_ALERT_WEBHOOK_URL") or "").strip()
    if not url:
        return
    cooldown = _env_int("ALBAYAN_ALERT_COOLDOWN_SECONDS", 1800, 60, 86400)
    now = time.time()
    with _state_lock:
        if now - _last_alert_at.get(kind, 0) < cooldown:
            return
        _last_alert_at[kind] = now
    payload = json.dumps({
        "application": "Albayan",
        "kind": kind,
        "severity": severity,
        "message": message,
        "details": details or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, separators=(",", ":")).encode("utf-8")
    try:
        req = UrlRequest(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req, timeout=10) as response:
            if int(getattr(response, "status", 200)) >= 400:
                raise RuntimeError("alert endpoint rejected the request")
        with _state_lock:
            _status["lastAlertAt"] = now_ms()
    except Exception as exc:
        print(f"[albayan] Operations alert failed: {type(exc).__name__}")


def _cleanup_old_backups(directory: Path, retention_days: int) -> None:
    cutoff = time.time() - retention_days * 86400
    for path in directory.glob("albayan-*.backup.aesgcm"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            continue


@contextmanager
def _backup_lease():
    if not _backup_process_lock.acquire(blocking=False):
        raise RuntimeError("A backup is already running in this application process")
    try:
        if str(get_engine().dialect.name or "") == "postgresql":
            lock_key = _financial_period_lock_key("backup-v1")
            with db_conn() as conn:
                acquired = conn.execute(
                    text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
                    {"lock_key": lock_key},
                ).scalar()
                if not acquired:
                    raise RuntimeError("A backup is already running on another application worker")
                yield
        else:
            yield
    finally:
        _backup_process_lock.release()


def create_encrypted_backup() -> dict[str, Any]:
    config = _backup_config()
    key = _backup_key()
    if not config["enabled"]:
        raise RuntimeError("Backups are disabled; set ALBAYAN_BACKUP_ENABLED=true")
    if key is None:
        raise RuntimeError("ALBAYAN_BACKUP_KEY must be a URL-safe base64 32-byte key")
    directory = _backup_directory()
    directory.mkdir(parents=True, exist_ok=True)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    target = directory / f"albayan-{timestamp}-{secrets.token_hex(4)}.backup.aesgcm"
    with _backup_lease():
        with tempfile.TemporaryDirectory(prefix="albayan-backup-") as temp_dir:
            dump = Path(temp_dir) / "database.dump"
            _dump_database(dump)
            size = _encrypt_backup(dump, target, key)
    try:
        target.chmod(0o600)
    except OSError:
        pass
    result = {"createdAt": now_ms(), "file": target.name, "bytes": size, "offsite": False}
    with _state_lock:
        _status.update({"lastBackupAt": result["createdAt"], "lastBackupFile": target.name, "lastBackupBytes": size, "lastBackupError": ""})
    _cleanup_old_backups(directory, config["retentionDays"])
    if config["offsiteConfigured"]:
        try:
            _upload_offsite(target, config)
            result["offsite"] = True
            with _state_lock:
                _status.update({"lastOffsiteAt": now_ms(), "lastOffsiteError": ""})
        except Exception as exc:
            result["offsiteError"] = str(exc)[:500]
            with _state_lock:
                _status["lastOffsiteError"] = str(exc)[:500]
            _send_alert("backup_offsite_failed", "high", "Encrypted backup was created but off-site upload failed", {"error": str(exc)[:300]})
    return result


def _backup_worker() -> None:
    with _state_lock:
        _status["workerRunning"] = True
    try:
        # Let startup/migrations settle before touching the database.
        if _worker_stop.wait(20):
            return
        while not _worker_stop.is_set():
            config = _backup_config()
            if config["enabled"]:
                with _state_lock:
                    last = int(_status.get("lastBackupAt") or 0)
                due = now_ms() - last >= config["intervalHours"] * 3600 * 1000
                if due:
                    try:
                        create_encrypted_backup()
                    except Exception as exc:
                        with _state_lock:
                            _status["lastBackupError"] = str(exc)[:500]
                        _send_alert("backup_failed", "critical", "Albayan encrypted backup failed", {"error": str(exc)[:300]})
            metrics = get_metrics()
            minimum_requests = _env_int("ALBAYAN_ALERT_MIN_REQUESTS", 50, 10, 1000000)
            error_rate_limit = _env_float("ALBAYAN_ALERT_ERROR_RATE", 0.05, 0.001, 1.0)
            p95_limit_ms = _env_int("ALBAYAN_ALERT_P95_MS", 3000, 250, 120000)
            if int(metrics.get("total_requests") or 0) >= minimum_requests:
                if float(metrics.get("error_rate") or 0) >= error_rate_limit:
                    _send_alert(
                        "high_error_rate",
                        "high",
                        "Albayan server error rate is above the configured limit",
                        metrics,
                    )
                if float(metrics.get("response_ms_p95") or 0) >= p95_limit_ms:
                    _send_alert(
                        "slow_responses",
                        "medium",
                        "Albayan server responses are unusually slow",
                        metrics,
                    )
            _worker_stop.wait(300)
    finally:
        with _state_lock:
            _status["workerRunning"] = False


def start_operations_worker() -> None:
    global _worker_thread
    if _worker_thread and _worker_thread.is_alive():
        return
    _worker_stop.clear()
    _worker_thread = threading.Thread(target=_backup_worker, name="albayan-operations", daemon=True)
    _worker_thread.start()


def stop_operations_worker() -> None:
    _worker_stop.set()
    if _worker_thread and _worker_thread.is_alive():
        _worker_thread.join(timeout=5)


def _public_status() -> dict[str, Any]:
    config = _backup_config()
    with _state_lock:
        runtime = dict(_status)
    directory = _backup_directory()
    local_count = 0
    if directory.exists():
        try:
            local_count = sum(1 for _ in directory.glob("albayan-*.backup.aesgcm"))
        except OSError:
            local_count = 0
    setup_tasks = []
    if not config["enabled"]:
        setup_tasks.append("Enable encrypted daily backups")
    if not config["encryptionReady"]:
        setup_tasks.append("Add a permanent backup encryption key")
    if not config["offsiteConfigured"]:
        setup_tasks.append("Connect private S3-compatible off-site storage")
    if not config["alertingConfigured"]:
        setup_tasks.append("Connect an operations alert webhook")
    return {
        "backup": {
            "enabled": config["enabled"],
            "encryptionReady": config["encryptionReady"],
            "offsiteConfigured": config["offsiteConfigured"],
            "intervalHours": config["intervalHours"],
            "retentionDays": config["retentionDays"],
            "localBackupCount": local_count,
            **runtime,
        },
        "alerts": {"configured": config["alertingConfigured"], "lastAlertAt": runtime.get("lastAlertAt")},
        "monitoring": get_metrics(),
        "setupTasks": setup_tasks,
    }


def create_operations_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    require_same_origin: Callable[[Request], None],
    audit_fn: Callable[..., Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/operations", tags=["operations"])

    def admin_user(user: dict[str, Any] = Depends(current_user_dependency)) -> dict[str, Any]:
        if str(user.get("role") or "").strip().lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        return user

    @router.on_event("startup")
    def _start() -> None:
        start_operations_worker()

    @router.on_event("shutdown")
    def _stop() -> None:
        stop_operations_worker()

    @router.get("/status")
    def operations_status(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        status = _public_status()
        status["financialPeriods"] = list_financial_periods(user)
        return status

    @router.post("/backups/run")
    def run_backup(request: Request, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        require_same_origin(request)
        try:
            result = create_encrypted_backup()
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)[:500])
        audit_fn(str(user.get("id") or ""), "backup", "operations", result["file"], "Created encrypted database backup", {"offsite": result["offsite"], "bytes": result["bytes"]})
        return {"ok": True, "backup": result, "status": _public_status()}

    @router.get("/financial-periods")
    def list_financial_periods(user: dict[str, Any] = Depends(admin_user)) -> list[dict[str, Any]]:
        rows = _entity_rows(FINANCIAL_CLOSE_COLLECTION)
        rows.sort(key=lambda row: str(row.get("period") or ""), reverse=True)
        return rows

    @router.get("/financial-periods/{period}/preview")
    def preview_financial_period(period: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        if not _PERIOD_RE.fullmatch(period):
            raise HTTPException(status_code=400, detail="Period must be YYYY-MM")
        return _period_snapshot(period)

    @router.post("/financial-periods/close")
    def close_financial_period(
        request: Request,
        body: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(admin_user),
    ) -> dict[str, Any]:
        require_same_origin(request)
        period = str((body or {}).get("period") or "").strip()
        if not _PERIOD_RE.fullmatch(period):
            raise HTTPException(status_code=400, detail="Period must be YYYY-MM")
        current_period = _business_today().strftime("%Y-%m")
        if period >= current_period:
            raise HTTPException(status_code=400, detail="Only a completed month can be closed")
        force_reason = " ".join(str((body or {}).get("forceReason") or "").split())[:500]
        with db_conn() as conn:
            _lock_financial_period(conn, period)
            existing = _close_record(period, conn=conn)
            if existing and str(existing.get("status") or "").lower() == "closed":
                return existing
            snapshot = _period_snapshot(period, conn=conn)
            if snapshot["blockers"] and len(force_reason) < 10:
                raise HTTPException(status_code=409, detail="Resolve the closing blockers or provide a clear forceReason (at least 10 characters)")
            now = now_ms()
            history = list(existing.get("history") or []) if isinstance(existing, dict) else []
            history.append({"action": "closed", "at": now, "by": str(user.get("id") or ""), "reason": force_reason})
            saved = _save_close_record(period, {
                "status": "closed",
                "closedAt": now,
                "closedBy": str(user.get("id") or ""),
                "forceReason": force_reason,
                "snapshot": snapshot,
                "history": history[-50:],
            }, str(user.get("id") or ""), conn=conn)
        audit_fn(str(user.get("id") or ""), "close", FINANCIAL_CLOSE_COLLECTION, saved["id"], f"Closed financial period {period}", {"blockers": snapshot["blockers"], "forced": bool(force_reason)})
        return saved

    @router.post("/financial-periods/{period}/unlock")
    def unlock_financial_period(
        period: str,
        request: Request,
        body: dict[str, Any] = Body(...),
        user: dict[str, Any] = Depends(admin_user),
    ) -> dict[str, Any]:
        require_same_origin(request)
        if not _PERIOD_RE.fullmatch(period):
            raise HTTPException(status_code=400, detail="Period must be YYYY-MM")
        reason = " ".join(str((body or {}).get("reason") or "").split())[:500]
        if len(reason) < 10:
            raise HTTPException(status_code=400, detail="Unlock reason must be at least 10 characters")
        with db_conn() as conn:
            _lock_financial_period(conn, period)
            existing = _close_record(period, conn=conn)
            if not existing:
                raise HTTPException(status_code=404, detail="Financial period was not found")
            now = now_ms()
            history = list(existing.get("history") or [])
            history.append({"action": "unlocked", "at": now, "by": str(user.get("id") or ""), "reason": reason})
            saved = _save_close_record(period, {
                **existing,
                "status": "open",
                "unlockedAt": now,
                "unlockedBy": str(user.get("id") or ""),
                "unlockReason": reason,
                "history": history[-50:],
            }, str(user.get("id") or ""), conn=conn)
        audit_fn(str(user.get("id") or ""), "unlock", FINANCIAL_CLOSE_COLLECTION, saved["id"], f"Unlocked financial period {period}", {"reason": reason})
        return saved

    return router
