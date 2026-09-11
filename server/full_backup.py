"""Owner-downloadable full backup: every row the app owns, in one file.

Why this exists beside the encrypted server backup:

* ``server/operations.py`` already makes a complete AES-GCM ``pg_dump`` — but
  it lands on the Jelastic volume with no download route, and reading it needs
  the backup key, Python and ``pg_restore``. The owner cannot get his own data.
* The Settings "export" is a report built from the BROWSER cache: it is
  permission-scoped, omits the whole clothes domain, and contains no photos at
  all (media never reaches the client — see ``entity_projection``).

This module streams gzip-compressed NDJSON: one line per record, media
included, with memory bounded by one stored row and small encoding buffers.
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
from typing import Any, Callable, Generator, Iterator

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from .db import get_engine

BACKUP_FORMAT = "albayan-full-backup/1"
# Yield at least this often so an idle-timeout proxy always sees traffic.
FLUSH_EVERY_CHUNKS = 64
FLUSH_EVERY_BYTES = 256 * 1024
# Media rows may each contain several MB. A row count of 200 is not a safe
# memory bound: fetch one row and encode its JSON in bounded chunks instead.
ROW_BATCH = 1
JSON_CHUNK_CHARS = 64 * 1024
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


def _entity_chunks(row: Any) -> Iterator[bytes]:
    """Serialize one row without parsing or copying its entire media JSON.

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
    yield (prefix + ',"data":').encode("utf-8")
    for start in range(0, len(data_json), JSON_CHUNK_CHARS):
        yield data_json[start:start + JSON_CHUNK_CHARS].encode("utf-8")
    yield b"}\n"


class _BackupStreamingResponse(StreamingResponse):
    """Close the sync iterator even when ASGI cancels before/while streaming."""

    def __init__(self, iterator: Generator[bytes, None, None], cleanup: Callable[[], None], **kwargs: Any):
        super().__init__(iterator, **kwargs)
        self._backup_iterator = iterator
        self._backup_cleanup = cleanup

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Starlette's iterate_in_threadpool does not close its underlying
            # synchronous generator on disconnect. Shield cleanup from the
            # cancellation and cover the never-started-generator case too.
            with anyio.CancelScope(shield=True):
                try:
                    await anyio.to_thread.run_sync(self._backup_iterator.close)
                finally:
                    await anyio.to_thread.run_sync(self._backup_cleanup)


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

        # This is a cookie-authenticated GET, so a SameSite=lax session cookie
        # IS sent on a top-level navigation: any page the admin opens could
        # point at this URL and pull the entire database onto their disk (and
        # burn the daily quota). Browsers label such a navigation cross-site;
        # native clients send no Sec-Fetch-Site and are unaffected.
        if str(request.headers.get("sec-fetch-site") or "").lower() == "cross-site":
            raise HTTPException(status_code=403, detail="Cross-site backup download blocked")
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
        try:
            audit_fn(
                admin_id, "backup_download_started", "backup", filename,
                "Started a full data backup download",
                {"ip": getattr(getattr(request, "client", None), "host", "") or ""},
            )
        except BaseException:
            _STREAM_SLOT.release()
            raise

        state: dict[str, Any] = {"conn": None, "complete": False, "bytes": 0, "counts": {}}
        cleanup_lock = threading.Lock()
        cleaned_up = False

        def cleanup() -> None:
            nonlocal cleaned_up
            with cleanup_lock:
                if cleaned_up:
                    return
                cleaned_up = True
            try:
                if state["conn"] is not None:
                    state["conn"].close()
            finally:
                _STREAM_SLOT.release()
                try:
                    audit_fn(
                        admin_id, "backup_download_completed", "backup", filename,
                        f"Full backup download finished ({'complete' if state['complete'] else 'INCOMPLETE'})",
                        {key: state[key] for key in ("bytes", "complete", "counts")},
                    )
                except Exception:
                    pass

        def generate() -> Generator[bytes, None, None]:
            # Audited on completion too: logging only at the end would make an
            # aborted mass download invisible.
            compressor = zlib.compressobj(9, zlib.DEFLATED, 31)
            digest = hashlib.sha256()
            counts: dict[str, int] = state["counts"]
            plain_bytes = 0
            complete = True
            pending = 0
            pending_bytes = 0

            def emit(chunk: bytes) -> bytes:
                nonlocal plain_bytes
                plain_bytes += len(chunk)
                state["bytes"] = plain_bytes
                digest.update(chunk)
                return compressor.compress(chunk)

            def stream_rows(statement: str):
                # Apply streaming to SELECTs only, never transaction commands.
                # Explicit yield_per=1 also bounds psycopg's fetch buffer.
                with conn.execute(text(statement).execution_options(
                    stream_results=True, yield_per=ROW_BATCH,
                )) as result:
                    yield from result.mappings()

            def timed_out() -> bool:
                return time.monotonic() - started_at > MAX_STREAM_SECONDS

            try:
                try:
                    conn = get_engine().connect()
                    state["conn"] = conn
                    if _is_postgres():
                        # Set isolation before BEGIN and before any server-side
                        # SELECT cursor. DECLARE CURSOR FOR SET is invalid SQL.
                        conn = conn.execution_options(isolation_level="REPEATABLE READ")
                    trans = conn.begin()
                    if not _is_postgres():
                        # sqlite3's legacy mode does not BEGIN for a SELECT.
                        # Make all three tables share an actual read snapshot.
                        conn.exec_driver_sql("BEGIN")
                    for raw_chunk in records(stream_rows, timed_out, counts):
                        out = emit(raw_chunk)
                        pending += 1
                        pending_bytes += len(raw_chunk)
                        if out:
                            yield out
                        if pending >= FLUSH_EVERY_CHUNKS or pending_bytes >= FLUSH_EVERY_BYTES:
                            out = compressor.flush(zlib.Z_SYNC_FLUSH)
                            pending = 0
                            pending_bytes = 0
                            if out:
                                yield out
                    complete = not timed_out()
                    trans.rollback()
                except Exception:
                    # A mid-download failure cannot change HTTP status, but it
                    # must never be reported as a usable backup. Do not expose
                    # SQL/driver exception text (which may contain row data).
                    complete = False
                    out = emit(_json_line({
                        "_type": "error",
                        "message": "Backup did not finish. Download a new copy before relying on it.",
                    }))
                    if out:
                        yield out

                footer = emit(_json_line({
                    "_type": "footer", "complete": complete, "counts": counts,
                    "bytes": plain_bytes, "sha256": digest.hexdigest(),
                }))
                if footer:
                    yield footer
                tail = compressor.flush(zlib.Z_FINISH)
                if tail:
                    yield tail
                state["complete"] = complete
            finally:
                # No yields here: GeneratorExit on a cancelled download must
                # reach resource release, including while yielding the footer.
                cleanup()

        def records(stream_rows: Callable, timed_out: Callable,
                    counts: dict[str, int]) -> Iterator[bytes]:
            yield _json_line({
                "_type": "header", "format": BACKUP_FORMAT,
                "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "release": release_sha or "",
                "dialect": "postgresql" if _is_postgres() else "sqlite",
                "includesMedia": True,
                "excluded": [
                    "password_hash", "password_salt", "password_algo",
                    "password_iterations", "sessions", "password_resets", "app_logins",
                ],
            })
            # One index-ordered cursor, one row fetched at a time. Never
            # materialize a list of photo-bearing records with .all().
            for row in stream_rows(
                "SELECT type, id, data_json, deleted, created_at, created_by, last_modified "
                "FROM entities ORDER BY type, id"
            ):
                if timed_out():
                    return
                collection = str(row["type"])
                counts[collection] = counts.get(collection, 0) + 1
                yield from _entity_chunks(row)
            for row in stream_rows(
                "SELECT id, name, email, role, permissions_json, deleted, "
                "created_at, created_by, last_modified FROM users ORDER BY id"
            ):
                if timed_out():
                    return
                counts["users"] = counts.get("users", 0) + 1
                yield _json_line({
                    "_type": "user", "id": str(row["id"]),
                    "name": row["name"], "email": row["email"], "role": row["role"],
                    "permissions": row["permissions_json"], "deleted": bool(row["deleted"]),
                    "createdAt": int(row["created_at"] or 0), "createdBy": row["created_by"],
                    "lastModified": int(row["last_modified"] or 0),
                })
            for row in stream_rows(
                "SELECT id, ts, user_id, action, resource_type, resource_id, "
                "message, metadata_json FROM audit_logs ORDER BY id"
            ):
                if timed_out():
                    return
                counts["auditLogs"] = counts.get("auditLogs", 0) + 1
                yield _json_line({
                    "_type": "audit", "id": str(row["id"]), "ts": int(row["ts"] or 0),
                    "userId": row["user_id"], "action": row["action"],
                    "resourceType": row["resource_type"], "resourceId": row["resource_id"],
                    "message": row["message"], "metadata": row["metadata_json"],
                })

        return _BackupStreamingResponse(
            generate(), cleanup,
            media_type="application/gzip",
            headers={
                # This is a .gz FILE, not gzip transport encoding. "gzip"
                # here makes browsers transparently decompress the file while
                # retaining its .gz filename. Explicit identity also stops
                # GZipMiddleware from compressing the archive a second time.
                "Content-Encoding": "identity",
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )

    return router
