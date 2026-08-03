"""Owner-downloadable full backup: every row the app owns, in one file.

Why this exists beside the encrypted server backup:

* ``server/operations.py`` already makes a complete AES-GCM ``pg_dump`` — but
  it lands on the Jelastic volume with no download route, and reading it needs
  the backup key, Python and ``pg_restore``. The owner cannot get his own data.
* The Settings "export" is a report built from the BROWSER cache: it is
  permission-scoped, omits the whole clothes domain, and contains no photos at
  all (media never reaches the client — see ``entity_projection``).

This module streams gzip-compressed NDJSON: one line per record, media
included, written incrementally so a 400 MB export costs a few MB of RAM.
A truncated download is detectable because the trailing footer line is missing.

DELIBERATELY EXCLUDED, and it must stay that way:
  * ``users.password_hash`` / ``password_salt`` / ``password_algo`` /
    ``password_iterations`` — a file in Downloads or forwarded on WhatsApp
    would be an offline cracking target for every account. An admin can reset
    a password anyway, so including them buys nothing.
  * ``sessions``, ``password_resets``, ``app_logins`` — live or one-shot
    credential material; restoring them would resurrect logins or replay a
    reset/PKCE handoff.
  * Meta access tokens, the backup key and S3 secrets are environment-only and
    are never persisted to the database. If anyone ever caches a token on a
    row, this exclusion list must grow with it.

The file DOES contain customer names, phone numbers, addresses and receipt
photos in the clear. The UI says so before the download starts.
"""

import hashlib
import json
import threading
import time
import zlib
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from .db import get_engine

BACKUP_FORMAT = "albayan-full-backup/1"
# Yield at least this often so an idle-timeout proxy always sees traffic.
FLUSH_EVERY_ROWS = 64
FLUSH_EVERY_BYTES = 256 * 1024
ROW_BATCH = 200
# A stream that runs longer than this ends with complete:false rather than
# being cut off silently mid-record.
MAX_STREAM_SECONDS = 30 * 60

_STREAM_SLOT = threading.Semaphore(1)


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _is_postgres() -> bool:
    return str(get_engine().dialect.name or "") == "postgresql"


def _json_line(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _entity_line(row: Any) -> bytes:
    """Build one entity line WITHOUT parsing data_json.

    data_json is always valid JSON (written by db.json_dumps), so it is spliced
    in as text. That is the whole memory trick: an 8 MB data URL passes through
    as bytes instead of becoming a Python object graph.
    """
    head = {
        "_type": "entity",
        "collection": str(row["type"]),
        "id": str(row["id"]),
        "deleted": bool(row["deleted"]),
        "createdAt": int(row["created_at"] or 0),
        "createdBy": row["created_by"],
        "lastModified": int(row["last_modified"] or 0),
    }
    prefix = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1]  # drop closing }
    data_json = row["data_json"] or "{}"
    if isinstance(data_json, bytes):
        data_json = data_json.decode("utf-8", "replace")
    return (prefix + ',"data":' + data_json + "}\n").encode("utf-8")


def create_full_backup_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    audit_fn: Callable[..., Any],
    release_sha: str = "",
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/backup", tags=["backup"])

    def admin_user(user: dict[str, Any] = Depends(current_user_dependency)) -> dict[str, Any]:
        if str(user.get("role") or "").strip().lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        return user

    @router.get("/full/estimate")
    def estimate_full_backup(user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        """Cheap preflight so the owner sees the size before starting."""
        size_expr = "SUM(octet_length(data_json))" if _is_postgres() else "SUM(length(data_json))"
        collections: list[dict[str, Any]] = []
        total_bytes = 0
        total_rows = 0
        with get_engine().connect() as conn:
            rows = conn.execute(
                text(f"SELECT type, COUNT(*) AS n, COALESCE({size_expr}, 0) AS b FROM entities GROUP BY type ORDER BY type")
            ).mappings().all()
            for row in rows:
                count = int(row["n"] or 0)
                size = int(row["b"] or 0)
                total_rows += count
                total_bytes += size
                collections.append({"collection": str(row["type"]), "records": count, "bytes": size})
            users = int(conn.execute(text("SELECT COUNT(*) FROM users")).scalar() or 0)
            audit_rows = int(conn.execute(text("SELECT COUNT(*) FROM audit_logs")).scalar() or 0)
        # Photos are base64 JPEG: gzip mostly recovers the base64 overhead.
        approx_download = int(total_bytes * 0.78) + (users * 300) + (audit_rows * 400)
        return {
            "collections": collections,
            "records": total_rows,
            "users": users,
            "auditLogs": audit_rows,
            "approxBytes": total_bytes,
            "approxDownloadBytes": approx_download,
        }

    @router.get("/full")
    def download_full_backup(request: Request, user: dict[str, Any] = Depends(admin_user)):
        from .rate_limiter import check_rate_limit

        admin_id = str(user.get("id") or "")
        allowed, _left, retry_after_ms = check_rate_limit(
            f"full-backup:{admin_id}", max_attempts=3, window_ms=86_400_000
        )
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="Full backups are limited to 3 per day.",
                headers={"Retry-After": str(max(1, int((retry_after_ms or 0) / 1000)))},
            )
        if not _STREAM_SLOT.acquire(blocking=False):
            # Two concurrent multi-hundred-MB streams would hold two pool
            # connections and double the CPU on a small container.
            raise HTTPException(
                status_code=503,
                detail="Another backup download is already running. Try again shortly.",
                headers={"Retry-After": "60"},
            )

        started_at = time.monotonic()
        filename = f"albayan-full-backup-{_utc_stamp()}.ndjson.gz"
        audit_fn(
            admin_id, "backup_download_started", "backup", filename,
            "Started a full data backup download",
            {"ip": getattr(getattr(request, "client", None), "host", "") or ""},
        )

        def generate() -> Iterator[bytes]:
            # Audited on completion too: logging only at the end would make an
            # aborted mass download invisible.
            compressor = zlib.compressobj(9, zlib.DEFLATED, 31)
            digest = hashlib.sha256()
            counts: dict[str, int] = {}
            plain_bytes = 0
            complete = True
            conn = None
            pending = 0
            pending_bytes = 0

            def emit(chunk: bytes) -> bytes:
                nonlocal plain_bytes
                plain_bytes += len(chunk)
                digest.update(chunk)
                return compressor.compress(chunk)

            try:
                conn = get_engine().connect().execution_options(
                    stream_results=True, yield_per=ROW_BATCH
                )
                trans = conn.begin()
                if _is_postgres():
                    # One consistent snapshot for the whole file.
                    conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
                out = emit(_json_line({
                    "_type": "header",
                    "format": BACKUP_FORMAT,
                    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "release": release_sha or "",
                    "dialect": "postgresql" if _is_postgres() else "sqlite",
                    "includesMedia": True,
                    "excluded": [
                        "password_hash", "password_salt", "password_algo",
                        "password_iterations", "sessions", "password_resets", "app_logins",
                    ],
                }))
                if out:
                    yield out

                # Keyset cursor over (type, id): no OFFSET scans, stable order.
                last_type, last_id = "", ""
                while True:
                    batch = conn.execute(
                        text(
                            "SELECT type, id, data_json, deleted, created_at, created_by, last_modified "
                            "FROM entities WHERE (type > :t) OR (type = :t AND id > :i) "
                            "ORDER BY type, id LIMIT :lim"
                        ),
                        {"t": last_type, "i": last_id, "lim": ROW_BATCH},
                    ).mappings().all()
                    if not batch:
                        break
                    for row in batch:
                        last_type, last_id = str(row["type"]), str(row["id"])
                        counts[last_type] = counts.get(last_type, 0) + 1
                        chunk = emit(_entity_line(row))
                        pending += 1
                        pending_bytes += len(chunk)
                        if chunk:
                            yield chunk
                        if pending >= FLUSH_EVERY_ROWS or pending_bytes >= FLUSH_EVERY_BYTES:
                            flushed = compressor.flush(zlib.Z_SYNC_FLUSH)
                            pending = 0
                            pending_bytes = 0
                            if flushed:
                                yield flushed
                    if (time.monotonic() - started_at) > MAX_STREAM_SECONDS:
                        complete = False
                        break

                if complete:
                    for urow in conn.execute(text(
                        "SELECT id, name, email, role, permissions_json, deleted, "
                        "created_at, created_by, last_modified FROM users ORDER BY id"
                    )).mappings():
                        counts["users"] = counts.get("users", 0) + 1
                        out = emit(_json_line({
                            "_type": "user",
                            "id": str(urow["id"]),
                            "name": urow["name"],
                            "email": urow["email"],
                            "role": urow["role"],
                            "permissions": urow["permissions_json"],
                            "deleted": bool(urow["deleted"]),
                            "createdAt": int(urow["created_at"] or 0),
                            "createdBy": urow["created_by"],
                            "lastModified": int(urow["last_modified"] or 0),
                        }))
                        if out:
                            yield out

                    for arow in conn.execute(text(
                        "SELECT id, ts, user_id, action, resource_type, resource_id, "
                        "message, metadata_json FROM audit_logs ORDER BY id"
                    )).mappings():
                        counts["auditLogs"] = counts.get("auditLogs", 0) + 1
                        out = emit(_json_line({
                            "_type": "audit",
                            "id": str(arow["id"]),
                            "ts": int(arow["ts"] or 0),
                            "userId": arow["user_id"],
                            "action": arow["action"],
                            "resourceType": arow["resource_type"],
                            "resourceId": arow["resource_id"],
                            "message": arow["message"],
                            "metadata": arow["metadata_json"],
                        }))
                        if out:
                            yield out
                trans.rollback()
            except Exception as exc:  # noqa: BLE001 - the footer must record it
                complete = False
                try:
                    out = emit(_json_line({"_type": "error", "message": str(exc)[:300]}))
                    if out:
                        yield out
                except Exception:
                    pass
            finally:
                try:
                    footer = emit(_json_line({
                        "_type": "footer",
                        "complete": complete,
                        "counts": counts,
                        "bytes": plain_bytes,
                        "sha256": digest.hexdigest(),
                    }))
                    if footer:
                        yield footer
                    tail = compressor.flush(zlib.Z_FINISH)
                    if tail:
                        yield tail
                except Exception:
                    pass
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
                _STREAM_SLOT.release()
                try:
                    audit_fn(
                        admin_id, "backup_download_completed", "backup", filename,
                        f"Full backup download finished ({'complete' if complete else 'INCOMPLETE'})",
                        {"bytes": plain_bytes, "complete": complete, "counts": counts},
                    )
                except Exception:
                    pass

        return StreamingResponse(
            generate(),
            media_type="application/x-ndjson",
            headers={
                # Set ourselves so Starlette's GZipMiddleware does not compress
                # an already-compressed body a second time.
                "Content-Encoding": "gzip",
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )

    return router
