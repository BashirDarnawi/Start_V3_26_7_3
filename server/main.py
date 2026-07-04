import json
import math
import os
import secrets
import threading
import traceback
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

# SQLite doesn't support row-level locking, so we use a threading lock for counter operations
_SQLITE_COUNTER_LOCK = threading.Lock()

# Debug mode: set ALBAYAN_DEBUG_MODE=true to enable debug endpoints
DEBUG_MODE = os.getenv("ALBAYAN_DEBUG_MODE", "").strip().lower() in {"1", "true", "yes"}

from .db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from .rbac import user_has_permission
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from .schemas import (
    AdminRestoreEntityRequest,
    BootstrapResponse,
    ChangePasswordRequest,
    CreateUserRequest,
    EntityCreateRequest,
    EntityResponse,
    EntityUpdateRequest,
    LoginRequest,
    LoginResponse,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    UpdateUserRequest,
    UserPublic,
)
from .security import (
    PBKDF2_ITERATIONS_DEFAULT,
    hash_password,
    hash_token,
    new_id,
    new_session_cookie_value,
    parse_session_cookie_value,
    verify_password,
)


def _receipt_serial_exists(serial: str, *, exclude_id: str | None = None) -> bool:
    """True if any non-deleted receipt already has this final receipt number."""
    serial = sanitize_str(str(serial or ""))[:80]
    if not serial:
        return False
    exclude_id = sanitize_str(str(exclude_id or ""))[:80] or None
    dialect = str(get_engine().dialect.name or "")
    if dialect == "postgresql":
        # IMPORTANT: do NOT use "(:exclude_id IS NULL OR ...)" because passing NULL can trigger
        # psycopg.errors.AmbiguousParameter in Postgres (cannot infer parameter type).
        base_sql = """
        SELECT 1
        FROM entities
        WHERE type = 'receipts'
          AND deleted = false
          AND (
            (data_json::jsonb ->> 'serialNumber') = :serial
            OR (data_json::jsonb ->> 'finalReceiptNo') = :serial
          )
        """
        params: dict[str, Any] = {"serial": serial}
        if exclude_id:
            base_sql += " AND id <> :exclude_id"
            params["exclude_id"] = exclude_id
        sql = base_sql + " LIMIT 1"
        with db_conn() as conn:
            row = conn.execute(text(sql), params).first()
            return row is not None
    # Fallback (SQLite/dev): use JSON extract functions if available, else scan bounded set
    with db_conn() as conn:
        # SQLite 3.38+ supports json_extract, try it first
        try:
            sql = """
            SELECT 1 FROM entities
            WHERE type = 'receipts'
              AND deleted = 0
              AND (
                json_extract(data_json, '$.serialNumber') = :serial
                OR json_extract(data_json, '$.finalReceiptNo') = :serial
              )
            """
            params: dict[str, Any] = {"serial": serial}
            if exclude_id:
                sql += " AND id <> :exclude_id"
                params["exclude_id"] = exclude_id
            sql += " LIMIT 1"
            row = conn.execute(text(sql), params).first()
            return row is not None
        except Exception:
            pass  # Fall back to manual scan if json_extract not supported

        # Manual scan fallback - but with LIMIT to avoid loading entire table
        rows = (
            conn.execute(text(
                "SELECT id, data_json FROM entities WHERE type='receipts' AND deleted = 0 LIMIT 10000"
            ))
            .mappings()
            .all()
        )
        for r in rows:
            rid = str(r.get("id") or "")
            if exclude_id and rid == exclude_id:
                continue
            data = json_loads(r.get("data_json")) or {}
            if str(data.get("serialNumber") or "") == serial or str(data.get("finalReceiptNo") or "") == serial:
                return True
    return False


def _is_valid_serial_number(serial: str) -> bool:
    """
    Check if a serial number is valid.
    Valid formats:
    - Regular: digits only, no leading zeros (1, 123, 456, etc.)
    - Auto-serial (LTT/Libyana/Madar): S-prefix + digits (S1, S2, S3, etc.)
    """
    serial = str(serial or "").strip()
    if not serial:
        return False
    # S-prefixed auto-serial (S1, S2, S3...)
    if serial.upper().startswith("S") and len(serial) > 1:
        return serial[1:].isdigit() and not serial[1:].startswith("0")
    # Regular numeric serial
    return serial.isdigit() and not serial.startswith("0")


def _temp_receipt_no_exists(temp_no: str, *, exclude_id: str | None = None) -> bool:
    """True if any non-deleted receipt already has this temp delivery receipt number."""
    temp_no = sanitize_str(str(temp_no or ""))[:80]
    if not temp_no:
        return False
    exclude_id = sanitize_str(str(exclude_id or ""))[:80] or None
    dialect = str(get_engine().dialect.name or "")
    if dialect == "postgresql":
        # IMPORTANT: avoid NULL-typed exclude_id param ambiguity in Postgres.
        base_sql = """
        SELECT 1
        FROM entities
        WHERE type = 'receipts'
          AND deleted = false
          AND (data_json::jsonb ->> 'tempReceiptNo') = :temp_no
        """
        params: dict[str, Any] = {"temp_no": temp_no}
        if exclude_id:
            base_sql += " AND id <> :exclude_id"
            params["exclude_id"] = exclude_id
        sql = base_sql + " LIMIT 1"
        with db_conn() as conn:
            row = conn.execute(text(sql), params).first()
            return row is not None
    # Fallback (SQLite/dev): scan a bounded set
    with db_conn() as conn:
        rows = (
            conn.execute(text("SELECT id, data_json, deleted FROM entities WHERE type='receipts'"))
            .mappings()
            .all()
        )
        for r in rows:
            if bool(r.get("deleted")):
                continue
            rid = str(r.get("id") or "")
            if exclude_id and rid == exclude_id:
                continue
            data = json_loads(r.get("data_json")) or {}
            if str(data.get("tempReceiptNo") or "") == temp_no:
                return True
    return False


def _next_temp_delivery_receipt_no(created_by: str | None = None) -> str:
    """
    Generate the next sequential temp delivery receipt number (D{n}) safely.

    Uses a row-level lock on a dedicated counter entity in Postgres to avoid duplicates across users/devices.
    For SQLite, uses a threading lock to prevent race conditions in multi-threaded dev environments.
    """

    created_by = sanitize_str(str(created_by or ""))[:80] or None
    dialect = str(get_engine().dialect.name or "")
    now = now_ms()

    counter_type = "counters"
    counter_id = "temp_delivery_receipt_no"

    # Use threading lock for SQLite to prevent race conditions
    use_sqlite_lock = dialect != "postgresql"
    if use_sqlite_lock:
        _SQLITE_COUNTER_LOCK.acquire()
    
    try:
        return _next_temp_delivery_receipt_no_inner(created_by, dialect, now, counter_type, counter_id)
    finally:
        if use_sqlite_lock:
            _SQLITE_COUNTER_LOCK.release()


def _next_temp_delivery_receipt_no_inner(created_by: str | None, dialect: str, now: int, counter_type: str, counter_id: str) -> str:
    """Inner implementation of temp receipt number generation (called with appropriate lock held)."""
    with db_conn() as conn:
        # Lock the counter row (Postgres) to prevent races.
        if dialect == "postgresql":
            # Seed the counter row first, idempotently. FOR UPDATE cannot lock a
            # row that does not exist yet, so on a fresh DB two concurrent
            # first-use requests would both fall through to INSERT and the second
            # commit would raise an uncaught IntegrityError (500) on the (type,id)
            # primary key. ON CONFLICT DO NOTHING guarantees the row exists so the
            # FOR UPDATE below always has something to lock.
            conn.execute(
                text(
                    """
                    INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                    VALUES (:type, :id, :data_json, false, :created_at, :created_by, :last_modified)
                    ON CONFLICT (type, id) DO NOTHING
                    """
                ),
                {
                    "type": counter_type,
                    "id": counter_id,
                    "data_json": json_dumps({"last": 0, "updatedAt": now}),
                    "created_at": now,
                    "created_by": created_by,
                    "last_modified": now,
                },
            )
            row = (
                conn.execute(
                    text(
                        "SELECT data_json FROM entities WHERE type = :type AND id = :id FOR UPDATE"
                    ),
                    {"type": counter_type, "id": counter_id},
                )
                .mappings()
                .first()
            )
        else:
            row = (
                conn.execute(
                    text("SELECT data_json FROM entities WHERE type = :type AND id = :id"),
                    {"type": counter_type, "id": counter_id},
                )
                .mappings()
                .first()
            )

        last_n = 0
        if row and row.get("data_json"):
            try:
                data = json_loads(row["data_json"]) or {}
                last_n = int(data.get("last") or 0)
            except Exception:
                last_n = 0

        next_n = last_n + 1
        # Defense-in-depth: ensure uniqueness even if counter got out of sync.
        while _temp_receipt_no_exists(f"D{next_n}"):
            next_n += 1

        payload = {"last": int(next_n), "updatedAt": now}
        payload_json = json_dumps(payload)

        if row:
            conn.execute(
                text(
                    """
                    UPDATE entities
                    SET data_json = :data_json, deleted = false, last_modified = :last_modified
                    WHERE type = :type AND id = :id
                    """
                ),
                {
                    "data_json": payload_json,
                    "last_modified": now,
                    "type": counter_type,
                    "id": counter_id,
                },
            )
        else:
            conn.execute(
                text(
                    """
                    INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                    VALUES (:type, :id, :data_json, false, :created_at, :created_by, :last_modified)
                    """
                ),
                {
                    "type": counter_type,
                    "id": counter_id,
                    "data_json": payload_json,
                    "created_at": now,
                    "created_by": created_by,
                    "last_modified": now,
                },
            )

        return f"D{next_n}"


PROJECT_ROOT = Path(__file__).resolve().parent.parent
INDEX_PATH = PROJECT_ROOT / "index.html"
SCRIPT_PATH = PROJECT_ROOT / "script.js"
SCRIPT_MIN_PATH = PROJECT_ROOT / "script.min.js"
STYLE_PATH = PROJECT_ROOT / "style.css"
ASSETS_DIR = PROJECT_ROOT / "assets"
PRIVACY_PATH = PROJECT_ROOT / "privacy.html"

COOKIE_NAME = "albayan_session"
SESSION_DURATION_MS = int(os.getenv("ALBAYAN_SESSION_MS", str(8 * 60 * 60 * 1000)))
# SECURITY: Default to secure cookies in production (HTTPS only)
# In development, can be set to False via environment variable.
# Tri-state: if the env var is set, honor its boolean value (so testing over
# plain HTTP on a LAN IP can turn Secure OFF); only when it is unset do we
# default to "secure unless DEBUG". The old expression `<truthy> or not DEBUG`
# could never be forced to False.
_COOKIE_SECURE_ENV = os.getenv("ALBAYAN_COOKIE_SECURE", "").strip().lower()
if _COOKIE_SECURE_ENV in {"1", "true", "yes"}:
    COOKIE_SECURE = True
elif _COOKIE_SECURE_ENV in {"0", "false", "no"}:
    COOKIE_SECURE = False
else:
    COOKIE_SECURE = not DEBUG_MODE

# If set, ALL requests must include the origin secret header (added by Cloudflare) or they'll be blocked.
# This protects your ALB/origin from being accessed directly if someone finds the ALB DNS name.
ORIGIN_SECRET_HEADER = os.getenv("ALBAYAN_ORIGIN_HEADER", "X-Albayan-Origin").strip() or "X-Albayan-Origin"
# Allow a comma-separated list to support secret rotation with zero downtime.
ORIGIN_SECRETS = [s.strip() for s in os.getenv("ALBAYAN_ORIGIN_SECRET", "").split(",") if s.strip()]
# ALB health checks can't send custom headers, so this path must remain reachable.
ORIGIN_BYPASS_PATH_PREFIXES = ("/api/health",)

# Rate limiting configuration (supports both in-memory and Redis)
# SECURITY: Rate limit login attempts to prevent brute force attacks
# Default: 20 attempts per 15 minutes per IP+email (increased from 10 for better UX on flaky networks)
_LOGIN_WINDOW_MS = int(os.getenv("ALBAYAN_LOGIN_WINDOW_MS", str(15 * 60 * 1000)))
_LOGIN_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_MAX_ATTEMPTS", "20"))

PASSWORD_RESET_TOKEN_MS = int(os.getenv("ALBAYAN_PASSWORD_RESET_TOKEN_MS", str(15 * 60 * 1000)))
PASSWORD_RESET_DEV_RETURN_CODE = os.getenv("ALBAYAN_DEV_PASSWORD_RESET_RETURN_CODE", "").strip().lower() in {"1", "true", "yes"}

_RESET_WINDOW_MS = int(os.getenv("ALBAYAN_RESET_WINDOW_MS", str(15 * 60 * 1000)))
_RESET_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_MAX_ATTEMPTS", "5"))


def _client_ip(request: Request) -> str:
    """Real client IP, preferring X-Forwarded-For when behind ALB/Cloudflare.

    Without this, request.client.host is the load-balancer node IP in
    production, so every user shares one rate-limit bucket: a single attacker
    could lock out password resets platform-wide, or lock any victim's login by
    spamming their email. The access-log middleware already trusts X-Forwarded-For
    the same way, so this is consistent with the existing proxy assumption.
    """
    try:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
    except Exception:
        pass
    return request.client.host if request.client else "unknown"


def _rate_key(request: Request, email: str) -> str:
    """Generate rate limit key from IP + email"""
    return f"{_client_ip(request)}|{email.lower()}"


def _rate_check(request: Request, email: str) -> tuple[bool, int]:
    """
    Check login rate limit using Redis (if configured) or in-memory.
    
    Returns:
        (is_allowed, wait_ms)
        - is_allowed: True if request should proceed
        - wait_ms: Milliseconds to wait if rate limited
    """
    from .rate_limiter import check_rate_limit
    
    key = f"login:{_rate_key(request, email)}"
    is_allowed, attempts_left, retry_after_ms = check_rate_limit(key, _LOGIN_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)
    
    if not is_allowed:
        return False, int(retry_after_ms or 0)
    
    return True, 0


def _reset_rate_check(request: Request, email: str) -> tuple[bool, int]:
    """
    Check password reset rate limit using Redis (if configured) or in-memory.
    
    Returns:
        (is_allowed, wait_ms)
        - is_allowed: True if request should proceed
        - wait_ms: Milliseconds to wait if rate limited
    """
    from .rate_limiter import check_rate_limit
    
    key = f"reset:{_rate_key(request, email)}"
    is_allowed, attempts_left, retry_after_ms = check_rate_limit(key, _RESET_MAX_ATTEMPTS, _RESET_WINDOW_MS)
    
    if not is_allowed:
        return False, int(retry_after_ms or 0)
    
    return True, 0


BLOCKED_KEYS = {"__proto__", "prototype", "constructor"}

# BEST PRACTICE: Maximum input length limits to prevent DoS
MAX_INPUT_LENGTH = 10000  # Maximum length for text inputs
# Data-URL image fields (receiptImage, photos[]) are base64 and legitimately
# far larger than a text field. Cap them well above a real photo but under the
# 10MB request-size middleware, so they are never silently truncated (which
# would corrupt the image) while still bounding memory.
MAX_DATA_URL_LENGTH = 8 * 1024 * 1024
MAX_JSON_DEPTH = 20  # Maximum nesting depth for JSON

# Financial validation constants
MAX_FINANCIAL_AMOUNT = 10_000_000  # $10 million max for any single amount
MIN_FINANCIAL_AMOUNT = 0  # No negative amounts allowed
MAX_EXCHANGE_RATE = 1000  # Maximum exchange rate (LYD per USD)
MIN_EXCHANGE_RATE = 0.001  # Minimum exchange rate

# Fields that should be validated as financial amounts (no negatives, reasonable max)
FINANCIAL_AMOUNT_FIELDS = {
    "amountUSD", "amountLocal", "amount", "debtAmountUSD", "debtAmountLocal",
    "spentUSD", "spentLocal", "remainingUSD", "remainingLocal",
    "collectedAmount", "amountCollectedFromCustomer", "quotedDeliveryFee",
    "actualDeliveryFeeCollected", "deliveryFeeCollected", "overpaidAmount",
    "remainingDue", "dueAmountToUseUSD", "dueAmountToUseLYD"
}

EXCHANGE_RATE_FIELDS = {"exchangeRate", "rate"}


def validate_financial_amount(value: Any, field_name: str = "") -> float:
    """Validate and sanitize a financial amount."""
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return 0.0

    # Check for special float values
    if not math.isfinite(amount):
        return 0.0

    # No negative amounts
    if amount < MIN_FINANCIAL_AMOUNT:
        return 0.0

    # Cap at maximum
    if amount > MAX_FINANCIAL_AMOUNT:
        return MAX_FINANCIAL_AMOUNT

    # Round to 2 decimal places to avoid floating point issues
    return round(amount, 2)


def validate_exchange_rate(value: Any) -> float:
    """Validate and sanitize an exchange rate."""
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return 1.0

    # Check for special float values
    if not math.isfinite(rate):
        return 1.0

    # Clamp to valid range
    if rate < MIN_EXCHANGE_RATE:
        return MIN_EXCHANGE_RATE
    if rate > MAX_EXCHANGE_RATE:
        return MAX_EXCHANGE_RATE

    return round(rate, 4)


def sanitize_str(s: str, max_length: int = MAX_INPUT_LENGTH) -> str:
    # Server-side defense-in-depth (frontend already escapes output)
    s = (s or "").replace("\x00", "").strip()
    # BEST PRACTICE: Enforce maximum length to prevent DoS attacks
    if len(s) > max_length:
        s = s[:max_length]
    # Prevent HTML/attribute injection
    s = s.replace("<", "").replace(">", "")
    # Prevent javascript: protocol
    s_low = s.lower()
    if s_low.startswith("javascript:") or s_low.startswith("vbscript:"):
        return ""
    return s


def sanitize_json(obj: Any, depth: int = 0, parent_key: str = "") -> Any:
    # BEST PRACTICE: Use constant for max depth
    if depth > MAX_JSON_DEPTH:
        return None  # Return None instead of unsanitized obj for security
    if obj is None:
        return None
    if isinstance(obj, str):
        # Base64 image data URLs must not be truncated to 10k (that corrupts
        # the image). They contain no HTML anyway. Give them a large cap.
        if obj.startswith("data:image/"):
            return sanitize_str(obj, MAX_DATA_URL_LENGTH)
        return sanitize_str(obj)
    if isinstance(obj, (int, float)):
        # Validate financial amounts and exchange rates
        if parent_key in FINANCIAL_AMOUNT_FIELDS:
            return validate_financial_amount(obj, parent_key)
        if parent_key in EXCHANGE_RATE_FIELDS:
            return validate_exchange_rate(obj)
        # For other numeric fields, just ensure finite value
        if isinstance(obj, float) and not math.isfinite(obj):
            return 0.0
        return obj
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, list):
        return [sanitize_json(x, depth + 1, parent_key) for x in obj]
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if not isinstance(k, str):
                continue
            if k in BLOCKED_KEYS:
                continue
            sk = sanitize_str(k)[:100]
            if not sk or sk in BLOCKED_KEYS:
                continue
            # Pass field name to child for validation context
            out[sk] = sanitize_json(v, depth + 1, sk)
        return out
    return obj


def _ensure_minified_script() -> None:
    """
    Minify the frontend JS so the served file is much harder to read.
    NOTE: This does NOT "hide" code from a determined attacker (browsers must download JS),
    but it significantly reduces readability/copy/paste.
    """
    if not SCRIPT_PATH.exists():
        return
    try:
        if SCRIPT_MIN_PATH.exists() and SCRIPT_MIN_PATH.stat().st_mtime >= SCRIPT_PATH.stat().st_mtime:
            return
        try:
            from rjsmin import jsmin  # type: ignore
        except Exception:
            # Keep the app running even if rjsmin isn't installed (e.g., local dev).
            print("[albayan] rjsmin not installed; serving script.js unminified")
            return
        src = SCRIPT_PATH.read_text(encoding="utf-8")
        SCRIPT_MIN_PATH.write_text(jsmin(src), encoding="utf-8")
        print("[albayan] Minified script.js -> script.min.js")
    except Exception as e:
        # Fail open: do not break app startup if minification fails.
        print(f"[albayan] Script minify skipped/failed: {type(e).__name__}")


def parse_permissions_json(permissions_json: str | None) -> dict[str, list[str]]:
    if not permissions_json:
        return {}
    try:
        data = json.loads(permissions_json)
        if isinstance(data, dict):
            out: dict[str, list[str]] = {}
            for k, v in data.items():
                if isinstance(k, str) and isinstance(v, list):
                    out[k] = [str(x) for x in v]
            return out
    except Exception:
        return {}
    return {}


def user_row_to_public(row: dict[str, Any]) -> UserPublic:
    return UserPublic(
        id=row["id"],
        name=row["name"],
        email=row["email"],
        role=row["role"],
        permissions=parse_permissions_json(row.get("permissions_json")),
    )


def _is_trusted_app_origin(origin: str) -> bool:
    """
    True for origins that are explicitly allowlisted for cross-origin use:
    the packaged Capacitor/Ionic mobile apps and any ALBAYAN_CORS_ORIGINS
    entries. These are exact-string matches against the CORS allowlist (the
    same list the CORS middleware enforces), so a hostile website's origin
    can never pass.
    """
    try:
        return bool(origin) and origin in CORS_ORIGINS
    except NameError:
        # CORS_ORIGINS not initialized yet (import order) — be strict.
        return False


def require_same_origin(request: Request):
    """
    Enhanced CSRF protection for cookie-based auth.
    Checks both Origin and Referer headers with proper fallback.
    Explicitly allowlisted app origins (Capacitor/Ionic mobile shells,
    ALBAYAN_CORS_ORIGINS) are accepted as trusted cross-origin callers.
    For production, also run behind HTTPS + reverse proxy.
    """
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")
    host = request.headers.get("host")

    # SECURITY FIX: Must have at least one of origin/referer.
    # Exception: the packaged mobile apps use Capacitor's native HTTP layer
    # (CapacitorHttp — required because iOS WKWebView blocks cross-site
    # cookies), and native requests carry no Origin/Referer at all. They DO
    # always carry the app's custom X-Request-ID header. That header is a
    # safe CSRF marker: HTML forms cannot set custom headers, and fetch()
    # from a hostile website would need a CORS preflight that only
    # allowlisted origins pass. (Standard custom-request-header defense.)
    if not origin and not referer:
        if request.headers.get("x-request-id"):
            return
        raise HTTPException(status_code=403, detail="Missing origin/referer header")

    # Packaged mobile apps and explicitly configured frontends are trusted:
    # they legitimately call the API from a different origin.
    if _is_trusted_app_origin(origin):
        return

    # Check origin if present
    if origin and host:
        # Extract hostname from origin (handles ports)
        try:
            from urllib.parse import urlparse
            origin_host = urlparse(origin).netloc or origin.replace("https://", "").replace("http://", "").split("/")[0]
            if host != origin_host:
                raise HTTPException(status_code=403, detail="Origin mismatch")
        except Exception:
            raise HTTPException(status_code=403, detail="Invalid origin")
    
    # Check referer as fallback if origin missing
    if not origin and referer and host:
        try:
            from urllib.parse import urlparse
            referer_host = urlparse(referer).netloc or referer.replace("https://", "").replace("http://", "").split("/")[0]
            # SECURITY FIX: Use strict equality, not substring match
            # 'host in referer_host' would allow evil-good.com to match good.com
            if host != referer_host:
                raise HTTPException(status_code=403, detail="Referer mismatch")
        except Exception:
            raise HTTPException(status_code=403, detail="Invalid referer")


def _get_user_by_email(email: str) -> Optional[dict[str, Any]]:
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM users WHERE lower(email)=lower(:email) AND deleted = false LIMIT 1"),
                {"email": email},
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


def _get_user_by_id(user_id: str) -> Optional[dict[str, Any]]:
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM users WHERE id = :id AND deleted = false LIMIT 1"),
                {"id": user_id},
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


def _get_user_by_id_any(user_id: str) -> Optional[dict[str, Any]]:
    """Fetch a user by id including deleted users (used for post-update reads)."""
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM users WHERE id = :id LIMIT 1"),
                {"id": user_id},
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


def _create_session(user_id: str, request: Request) -> tuple[str, str]:
    session_id = new_id("sess")
    token = new_id("tok")
    token_hash = hash_token(token)
    now = now_ms()
    expires = now + SESSION_DURATION_MS
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")

    with db_conn() as conn:
        conn.execute(
            text(
                """
                INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
                VALUES (:id, :user_id, :token_hash, :created_at, :expires_at, :last_seen_at, :ip, :user_agent)
                """
            ),
            {
                "id": session_id,
                "user_id": user_id,
                "token_hash": token_hash,
                "created_at": now,
                "expires_at": expires,
                "last_seen_at": now,
                "ip": ip,
                "user_agent": ua,
            },
        )

    return session_id, token


def _delete_session(session_id: str):
    with db_conn() as conn:
        conn.execute(text("DELETE FROM sessions WHERE id = :id"), {"id": session_id})


def _auth_user_from_cookie(request: Request) -> Optional[dict[str, Any]]:
    cookie_val = request.cookies.get(COOKIE_NAME)
    parsed = parse_session_cookie_value(cookie_val or "")
    if not parsed:
        return None
    session_id, token = parsed
    token_h = hash_token(token)

    with db_conn() as conn:
        sess = (
            conn.execute(
                text("SELECT * FROM sessions WHERE id = :id LIMIT 1"),
                {"id": session_id},
            )
            .mappings()
            .first()
        )
        if not sess:
            return None

        expires_at = int(sess.get("expires_at") or 0)
        if expires_at <= now_ms():
            conn.execute(text("DELETE FROM sessions WHERE id = :id"), {"id": session_id})
            return None

        if not secrets_compare(token_h, str(sess.get("token_hash") or "")):
            # Token mismatch -> possible session theft
            conn.execute(text("DELETE FROM sessions WHERE id = :id"), {"id": session_id})
            return None

        # Update last seen, throttled to once per minute. The frontend polls the
        # API every ~3 seconds, so writing on every request would generate constant
        # bookkeeping writes; last_seen_at only needs coarse accuracy.
        last_seen_at = int(sess.get("last_seen_at") or 0)
        if now_ms() - last_seen_at > 60_000:
            conn.execute(
                text("UPDATE sessions SET last_seen_at = :ts WHERE id = :id"),
                {"ts": now_ms(), "id": session_id},
            )

        user = (
            conn.execute(
                text("SELECT * FROM users WHERE id = :user_id AND deleted = false LIMIT 1"),
                {"user_id": sess.get("user_id")},
            )
            .mappings()
            .first()
        )
        if not user:
            return None

        data = dict(user)
        data["session_id"] = session_id
        return data


def secrets_compare(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a, b)


def current_user(request: Request) -> dict[str, Any]:
    user = _auth_user_from_cookie(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    # Make user id available to middleware/logging.
    try:
        request.state.user_id = str(user.get("id") or "")
    except Exception:
        pass
    return user


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if str(user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


def audit(user_id: Optional[str], action: str, resource_type: str, resource_id: str, message: str, metadata: dict[str, Any] | None = None):
    meta = json_dumps(metadata or {})
    with db_conn() as conn:
        conn.execute(
            text(
                """
                INSERT INTO audit_logs (id, ts, user_id, action, resource_type, resource_id, message, metadata_json)
                VALUES (:id, :ts, :user_id, :action, :resource_type, :resource_id, :message, :metadata_json)
                """
            ),
            {
                "id": new_id("audit"),
                "ts": now_ms(),
                "user_id": user_id,
                "action": action,
                "resource_type": resource_type,
                "resource_id": resource_id,
                "message": message,
                "metadata_json": meta,
            },
        )


# Audit log retention: keep logs for 90 days by default
AUDIT_LOG_RETENTION_DAYS = int(os.getenv("ALBAYAN_AUDIT_LOG_RETENTION_DAYS", "90"))
AUDIT_LOG_MAX_RECORDS = int(os.getenv("ALBAYAN_AUDIT_LOG_MAX_RECORDS", "100000"))


def cleanup_old_audit_logs():
    """
    Clean up audit logs older than AUDIT_LOG_RETENTION_DAYS or exceeding AUDIT_LOG_MAX_RECORDS.
    Called periodically to prevent unbounded growth.
    """
    retention_ms = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    cutoff_ts = now_ms() - retention_ms

    with db_conn() as conn:
        # Delete logs older than retention period
        result = conn.execute(
            text("DELETE FROM audit_logs WHERE ts < :cutoff"),
            {"cutoff": cutoff_ts}
        )
        deleted_by_age = result.rowcount if result else 0

        # Check total count and delete oldest if exceeding max
        count_result = conn.execute(text("SELECT COUNT(*) as cnt FROM audit_logs")).first()
        total_count = count_result[0] if count_result else 0

        deleted_by_limit = 0
        if total_count > AUDIT_LOG_MAX_RECORDS:
            excess = total_count - AUDIT_LOG_MAX_RECORDS
            # Delete oldest excess records
            conn.execute(
                text("""
                    DELETE FROM audit_logs
                    WHERE id IN (
                        SELECT id FROM audit_logs
                        ORDER BY ts ASC
                        LIMIT :excess
                    )
                """),
                {"excess": excess}
            )
            deleted_by_limit = excess

        if deleted_by_age > 0 or deleted_by_limit > 0:
            print(f"[albayan] Audit log cleanup: deleted {deleted_by_age} by age, {deleted_by_limit} by limit")


def list_entities(
    entity_type: str,
    *,
    updated_since: int | None = None,
    limit: int = 500,
    offset: int = 0,
    include_deleted: bool = False,
    created_by: str | None = None,
    assigned_to: str | None = None,
    id_in: list[str] | None = None,
) -> list[dict[str, Any]]:
    entity_type = sanitize_str(entity_type)[:40]
    if not entity_type:
        return []
    # Keep the per-request payload bounded to avoid memory spikes on small containers (ECS/Fargate).
    # Clients should paginate with offset.
    requested_limit = max(1, min(int(limit), 1000))
    requested_offset = max(0, int(offset))
    limit = requested_limit
    offset = requested_offset

    dialect = str(get_engine().dialect.name or "")
    python_assigned_to: str | None = None
    if assigned_to is not None:
        assigned_to = sanitize_str(str(assigned_to))[:80] or None
        # Postgres can filter JSON in SQL. For SQLite/dev, do a safe Python filter.
        if assigned_to and dialect != "postgresql":
            python_assigned_to = assigned_to
            # Fetch a bounded superset then slice after filtering.
            limit = 1000
            offset = 0

    where = ["type = :type"]
    params: dict[str, Any] = {"type": entity_type}
    # For delta sync (updated_since), we intentionally include deleted rows as tombstones
    # so clients can remove them without requiring a full refresh.
    if not include_deleted and updated_since is None:
        where.append("deleted = false")
    if updated_since is not None:
        where.append("last_modified > :updated_since")
        # Delta-sync grace window: a write can commit slightly after a poll read
        # its cursor, so re-scan the last 15s each poll. applyServerDelta upserts
        # by id, so re-delivered records are idempotent — no missed writes.
        params["updated_since"] = max(0, int(updated_since) - 15000)
    if created_by is not None:
        where.append("created_by = :created_by")
        params["created_by"] = created_by

    if assigned_to and dialect == "postgresql":
        # data_json is stored as TEXT; cast to jsonb for filtering.
        where.append("(data_json::jsonb ->> 'deliveryPersonId') = :delivery_person_id")
        params["delivery_person_id"] = assigned_to

    if id_in is not None:
        # Safe bounded "IN" filter (used for delivery-scoped customer reads)
        clean_ids = [sanitize_str(str(x))[:80] for x in id_in if str(x or "").strip()]
        clean_ids = clean_ids[:1000]
        if not clean_ids:
            return []
        ph = []
        for i, cid in enumerate(clean_ids):
            k = f"id_{i}"
            ph.append(f":{k}")
            params[k] = cid
        where.append(f"id IN ({', '.join(ph)})")

    # ORDER BY: for full (non-delta) listing, order by an IMMUTABLE key so that
    # an edit committed mid-load cannot move a row across the OFFSET window and
    # cause a record to be skipped or duplicated. Delta queries keep
    # last_modified ordering (they re-scan by cursor and upsert idempotently).
    order_by = "last_modified DESC" if updated_since is not None else "created_at DESC, id DESC"
    sql = f"SELECT * FROM entities WHERE {' AND '.join(where)} ORDER BY {order_by} LIMIT :limit OFFSET :offset"
    params["limit"] = limit
    params["offset"] = offset

    with db_conn() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
        out = []
        for r in rows:
            d = dict(r)
            data = json_loads(d["data_json"]) or {}
            delivery_person_id = data.get("deliveryPersonId")
            # Inject server truth into record for frontend compatibility
            data["id"] = d["id"]
            data["_lastModified"] = int(d["last_modified"])
            data["_deleted"] = bool(d["deleted"])
            data["_created"] = int(d["created_at"])
            if d.get("created_by") is not None:
                data["createdBy"] = d.get("created_by")

            # If caller didn't request deleted records, but we're in delta mode,
            # return a minimal tombstone payload for deleted rows (defense-in-depth).
            if not include_deleted and bool(d["deleted"]):
                data = {
                    "id": d["id"],
                    "_lastModified": int(d["last_modified"]),
                    "_deleted": True,
                    "_created": int(d["created_at"]),
                }
                if d.get("created_by") is not None:
                    data["createdBy"] = d.get("created_by")
                if delivery_person_id is not None:
                    data["deliveryPersonId"] = delivery_person_id
            out.append(
                {
                    "id": d["id"],
                    "type": d["type"],
                    "deleted": bool(d["deleted"]),
                    "createdAt": int(d["created_at"]),
                    "createdBy": d.get("created_by"),
                    "lastModified": int(d["last_modified"]),
                    "data": data,
                }
            )
        if python_assigned_to:
            out = [
                e
                for e in out
                if str((e.get("data") or {}).get("deliveryPersonId") or "") == str(python_assigned_to)
            ]
            out = out[requested_offset : requested_offset + requested_limit]
        return out


def get_entity(entity_type: str, entity_id: str) -> Optional[dict[str, Any]]:
    """
    Retrieve a single entity from the database.
    
    Args:
        entity_type: Collection name (e.g., 'receipts', 'ads', 'customers')
        entity_id: Unique identifier for the entity
    
    Returns:
        Entity dict with metadata (id, type, deleted, timestamps, data) or None if not found
    
    Note:
        - Returns even deleted entities (caller must filter)
        - data_json is automatically parsed into a Python dict
        - All timestamps are in milliseconds since epoch
    """
    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM entities WHERE type = :type AND id = :id LIMIT 1"),
                {"type": entity_type, "id": entity_id},
            )
            .mappings()
            .first()
        )
        if not row:
            return None
        d = dict(row)
        return {
            "id": d["id"],
            "type": d["type"],
            "deleted": bool(d["deleted"]),
            "createdAt": int(d["created_at"]),
            "createdBy": d.get("created_by"),
            "lastModified": int(d["last_modified"]),
            "data": json_loads(d["data_json"]) or {},
        }


def upsert_entity(entity_type: str, entity_id: str, data: dict[str, Any], user_id: str, *, create_if_missing: bool = True) -> dict[str, Any]:
    """
    Create or update an entity in the database (atomic operation).
    
    Args:
        entity_type: Collection name (e.g., 'receipts', 'ads')
        entity_id: Unique identifier
        data: Entity data (will be sanitized)
        user_id: ID of user performing the operation
        create_if_missing: If True, creates new entity; if False, raises 404 for missing entities
    
    Returns:
        Saved entity with metadata (id, type, timestamps, data)
    
    Behavior:
        - If entity exists: Updates data_json and last_modified, preserves created_at/created_by
        - If entity missing and create_if_missing=True: Creates new entity
        - If entity missing and create_if_missing=False: Raises HTTP 404
        - Always sanitizes input data to prevent injection attacks
        - Sets server timestamp (_lastModified) to ensure consistency across clients
    
    Thread Safety:
        - Uses database transaction (atomic commit/rollback)
        - Safe for concurrent use from multiple processes/servers
    """
    now = now_ms()
    entity_type = sanitize_str(entity_type)[:40]
    entity_id = sanitize_str(entity_id)[:80]
    if not entity_type or not entity_id:
        raise HTTPException(status_code=400, detail="Invalid entity id/type")

    clean = sanitize_json(data)
    # Force server timestamps for consistency
    clean["_lastModified"] = now

    with db_conn() as conn:
        existing = (
            conn.execute(
                text(
                    "SELECT id, created_at, created_by, deleted FROM entities WHERE type = :type AND id = :id LIMIT 1"
                ),
                {"type": entity_type, "id": entity_id},
            )
            .mappings()
            .first()
        )

        if existing:
            created_at = int(existing["created_at"])
            created_by = existing["created_by"]
            # DATA-INTEGRITY FIX: preserve the soft-delete flag on updates.
            # The UPDATE used to force deleted=false, so a PATCH arriving just
            # after a delete (easy with the 3s polling sync) silently
            # resurrected the record. Restores go through the dedicated admin
            # restore endpoint, and POST create refuses existing ids, so
            # nothing legitimate relied on this resurrection.
            deleted = bool(existing["deleted"])
            # Protected fields
            clean["id"] = entity_id
            clean["_created"] = clean.get("_created") or created_at
            clean["createdBy"] = clean.get("createdBy") or created_by

            try:
                conn.execute(
                    text(
                        """
                        UPDATE entities
                        SET data_json = :data_json, last_modified = :last_modified, deleted = :deleted
                        WHERE type = :type AND id = :id
                        """
                    ),
                    {
                        "data_json": json_dumps(clean),
                        "last_modified": now,
                        "deleted": deleted,
                        "type": entity_type,
                        "id": entity_id,
                    },
                )
            except IntegrityError:
                # Postgres partial unique indexes on receipt numbers
                # (uq_receipts_* in add_jsonb_indexes.py) caught a duplicate
                # that raced past the application-level check.
                raise HTTPException(status_code=409, detail="Receipt number already exists")
        else:
            if not create_if_missing:
                raise HTTPException(status_code=404, detail="Not found")
            created_at = now
            created_by = user_id
            deleted = False
            clean["id"] = entity_id
            clean["_created"] = clean.get("_created") or created_at
            clean["createdBy"] = clean.get("createdBy") or created_by

            try:
                conn.execute(
                    text(
                        """
                        INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                        VALUES (:type, :id, :data_json, false, :created_at, :created_by, :last_modified)
                        """
                    ),
                    {
                        "type": entity_type,
                        "id": entity_id,
                        "data_json": json_dumps(clean),
                        "created_at": created_at,
                        "created_by": created_by,
                        "last_modified": now,
                    },
                )
            except IntegrityError as e:
                # Two possible causes, both races past application checks:
                # - duplicate receipt number (unique indexes uq_receipts_*)
                # - duplicate primary key (two clients created the same id)
                if "uq_receipts" in str(e).lower():
                    raise HTTPException(status_code=409, detail="Receipt number already exists")
                raise HTTPException(status_code=409, detail="Record with this ID already exists")

    return {
        "id": entity_id,
        "type": entity_type,
        "deleted": bool(deleted),
        "createdAt": created_at,
        "createdBy": created_by,
        "lastModified": now,
        "data": clean,
    }


def patch_entity(entity_type: str, entity_id: str, updates: dict[str, Any], user_id: str) -> dict[str, Any]:
    """
    Partially update an existing entity (merge semantics).
    
    Args:
        entity_type: Collection name
        entity_id: Entity identifier
        updates: Fields to update (will be merged with existing data)
        user_id: ID of user performing the update
    
    Returns:
        Updated entity with metadata
    
    Behavior:
        - Loads existing entity from database
        - Merges updates into existing data (dict.update semantics)
        - Protected fields (id, _created, createdBy, createdAt, creatorId) cannot be changed
        - Raises HTTP 404 if entity doesn't exist
        - Updates last_modified timestamp automatically
    
    Security:
        - Input is sanitized via sanitize_json()
        - Protected fields are removed before merge
        - Uses database transaction for atomicity
    """
    existing = get_entity(entity_type, entity_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")

    data = existing["data"] or {}
    upd = sanitize_json(updates)
    # Protected keys
    for k in ["id", "_created", "createdBy", "createdAt", "creatorId"]:
        if k in upd:
            del upd[k]

    data.update(upd)
    return upsert_entity(entity_type, entity_id, data, user_id, create_if_missing=False)


def get_entity_meta(entity_type: str, entity_id: str) -> Optional[dict[str, Any]]:
    with db_conn() as conn:
        row = (
            conn.execute(
                text(
                    "SELECT id, type, deleted, created_at, created_by, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1"
                ),
                {"type": entity_type, "id": entity_id},
            )
            .mappings()
            .first()
        )
        if not row:
            return None
        return dict(row)


def soft_delete_entity(entity_type: str, entity_id: str, user_id: str):
    now = now_ms()
    with db_conn() as conn:
        exists = (
            conn.execute(
                text("SELECT id FROM entities WHERE type = :type AND id = :id LIMIT 1"),
                {"type": entity_type, "id": entity_id},
            )
            .mappings()
            .first()
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(
            text("UPDATE entities SET deleted = true, last_modified = :ts WHERE type = :type AND id = :id"),
            {"ts": now, "type": entity_type, "id": entity_id},
        )


app = FastAPI(title="Albayan Server", version="1.0.0")

# PERFORMANCE: Enable gzip compression for JSON/text responses.
# This reduces payload sizes for large collections (receipts/ads/customers) and helps under load.
from starlette.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """
    Return a JSON error payload for unexpected 500s so the frontend can display a real reason
    (instead of a generic 'Request failed'), and so operators can correlate with server logs.
    """
    err_id = new_id("err")
    request_id = getattr(request.state, "request_id", "unknown")
    try:
        # BEST PRACTICE: Include request ID in error logs for better tracing
        print(f"[albayan] unhandled_error_id={err_id} request_id={request_id} type={type(exc).__name__} msg={str(exc)[:300]}")
        print(traceback.format_exc())
    except Exception:
        pass
    # SECURITY: In production, don't leak exception details to clients
    # Keep response safe and short; avoid leaking large stack traces to clients.
    if DEBUG_MODE:
        safe_msg = sanitize_str(str(exc)).replace("\n", " ").replace("\r", " ")[:240]
        return JSONResponse(
            {"detail": f"Internal error ({err_id}): {type(exc).__name__}: {safe_msg}"},
            status_code=500,
        )
    else:
        # Production: return generic error without details
        return JSONResponse(
            {"detail": f"Internal error ({err_id}). Please contact support."},
            status_code=500,
        )


def _bootstrap_first_admin_if_empty():
    """
    Optional one-time bootstrap for first deployment.

    If the database has ZERO users, and the following env vars are set:
      - ALBAYAN_BOOTSTRAP_ADMIN_EMAIL
      - ALBAYAN_BOOTSTRAP_ADMIN_PASSWORD
    then create the first Admin user automatically.

    This avoids needing to exec into the container for initial setup.
    """
    email = (os.getenv("ALBAYAN_BOOTSTRAP_ADMIN_EMAIL") or "").strip().lower()
    password = os.getenv("ALBAYAN_BOOTSTRAP_ADMIN_PASSWORD") or ""
    name = (os.getenv("ALBAYAN_BOOTSTRAP_ADMIN_NAME") or "Admin").strip() or "Admin"

    if not email or not password:
        return

    try:
        with db_conn() as conn:
            count = conn.execute(text("SELECT COUNT(*) FROM users WHERE deleted = false")).scalar()
            if int(count or 0) > 0:
                return

            pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
            now = now_ms()
            user_id = new_id("user")

            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id, name, email, role, permissions_json,
                      password_hash, password_salt, password_algo, password_iterations,
                      deleted, created_at, created_by, last_modified
                    )
                    VALUES (
                      :id, :name, :email, 'Admin', :permissions_json,
                      :password_hash, :password_salt, :password_algo, :password_iterations,
                      false, :created_at, :created_by, :last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": sanitize_str(name),
                    "email": email,
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "created_at": now,
                    "created_by": user_id,
                    "last_modified": now,
                },
            )
        # Avoid logging secrets; just confirm bootstrap happened.
        print(f"[albayan] Bootstrapped first admin user: {email}")
    except Exception as e:
        # Fail closed-ish: if bootstrap fails, server still starts; you can create admin manually later.
        print(f"[albayan] Bootstrap admin skipped/failed: {type(e).__name__}")


@app.on_event("startup")
def _startup():
    _ensure_minified_script()
    init_db()
    _bootstrap_first_admin_if_empty()

    # Ensure query indexes exist (Postgres only; both are idempotent via
    # IF NOT EXISTS and no-ops on SQLite). Previously these were manual
    # scripts that were easy to forget after a fresh deployment, leaving
    # receipt/delivery lookups as sequential scans.
    try:
        from .create_indexes import create_performance_indexes
        from .add_jsonb_indexes import add_jsonb_indexes
        create_performance_indexes()
        add_jsonb_indexes()
    except Exception as e:
        print(f"[albayan] Index creation skipped/failed: {type(e).__name__}: {e}")


    # BEST PRACTICE: Clean up expired sessions on startup
    try:
        with db_conn() as conn:
            result = conn.execute(
                text("DELETE FROM sessions WHERE expires_at <= :now"),
                {"now": now_ms()}
            )
            if result.rowcount > 0:
                print(f"[albayan] Cleaned up {result.rowcount} expired sessions")
    except Exception as e:
        print(f"[albayan] Session cleanup failed: {e}")

    # Clean up old audit logs to prevent unbounded growth
    try:
        cleanup_old_audit_logs()
    except Exception as e:
        print(f"[albayan] Audit log cleanup failed: {e}")


@app.on_event("shutdown")
def _shutdown():
    """BEST PRACTICE: Gracefully close database connections on shutdown"""
    try:
        engine = get_engine()
        engine.dispose()
        print("[albayan] Database connections closed gracefully")
    except Exception as e:
        print(f"[albayan] Shutdown error: {e}")


# SECURITY FIX: Request size limiting to prevent DoS attacks
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    """Prevent DoS via large payloads (max 10 MB)"""
    if request.method in ["POST", "PUT", "PATCH"]:
        content_length = request.headers.get("content-length")
        max_size = 10 * 1024 * 1024  # 10 MB
        if content_length:
            try:
                size = int(content_length)
                if size > max_size:
                    return JSONResponse(
                        {"detail": f"Request too large (max {max_size/1024/1024:.0f} MB)"},
                        status_code=413
                    )
            except (ValueError, TypeError):
                pass  # Invalid content-length, let request proceed (will fail later if truly invalid)
        elif request.url.path.startswith("/api/"):
            # No Content-Length on an API write means a chunked/streamed body,
            # which bypasses the size check above and lets a client stream an
            # unbounded body into memory. All legitimate app clients (browser
            # fetch, CapacitorHttp) send Content-Length for JSON, so require it.
            return JSONResponse(
                {"detail": "Length Required: Content-Length header is required for this request"},
                status_code=411,
            )
    return await call_next(request)


# CORS Configuration - Allow cross-origin requests for frontend (only when explicitly configured)
# SECURITY: Never use wildcard origins with credentials.
#
# IMPORTANT: Albayan typically serves the frontend from the same origin as the API, so CORS is not
# required for normal operation. If you host the frontend separately (different domain/port),
# set ALBAYAN_CORS_ORIGINS="https://yourdomain.com,https://www.yourdomain.com".
#
# MOBILE APP SUPPORT: Capacitor/Ionic apps use capacitor:// or ionic:// schemes.
# These are automatically added to allowed origins for mobile app connectivity.
CORS_ORIGINS_ENV = os.getenv("ALBAYAN_CORS_ORIGINS", "").strip()
if not CORS_ORIGINS_ENV:
    if DEBUG_MODE:
        # Development default (safe fallback)
        CORS_ORIGINS_ENV = "http://localhost:8000,http://127.0.0.1:8000"
    else:
        # Production safe default: no cross-origin access (same-origin works without CORS middleware)
        print("[albayan] ⚠️  ALBAYAN_CORS_ORIGINS is not set; CORS middleware disabled (same-origin only).")
        CORS_ORIGINS_ENV = ""

CORS_ORIGINS = [origin.strip() for origin in CORS_ORIGINS_ENV.split(",") if origin.strip()]

# Always add Capacitor/Ionic mobile app origins for iOS/Android app support
MOBILE_APP_ORIGINS = [
    "capacitor://localhost",   # iOS WebView
    "ionic://localhost",
    "https://localhost",       # Android WebView (androidScheme: 'https' in capacitor.config.json)
    "http://localhost",        # Android WebView (legacy androidScheme: 'http')
]
for mobile_origin in MOBILE_APP_ORIGINS:
    if mobile_origin not in CORS_ORIGINS:
        CORS_ORIGINS.append(mobile_origin)

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,  # Explicit origins only (never "*")
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        # Allow tracing headers from web + Capacitor apps
        allow_headers=["Content-Type", "Authorization", "X-Request-ID", "X-Client-Platform"],  # Specific headers only
        expose_headers=["X-Request-ID"],  # Specific headers only
    )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if ORIGIN_SECRETS and not any(request.url.path.startswith(p) for p in ORIGIN_BYPASS_PATH_PREFIXES):
        provided = request.headers.get(ORIGIN_SECRET_HEADER)
        ok = bool(provided) and any(secrets.compare_digest(provided, s) for s in ORIGIN_SECRETS)
        if not ok:
            resp: Response = JSONResponse({"detail": "Forbidden"}, status_code=403)
            resp.headers["X-Content-Type-Options"] = "nosniff"
            resp.headers["X-Frame-Options"] = "SAMEORIGIN"
            resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
            resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
            return resp
    resp: Response = await call_next(request)
    # Core security headers
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    # SECURITY FIX: Additional defense-in-depth headers
    resp.headers["X-Permitted-Cross-Domain-Policies"] = "none"
    # Content Security Policy. All styling/icons/fonts are bundled locally under
    # /assets (no CDNs, no 'unsafe-eval'). 'unsafe-inline' is still required by
    # the app's inline onclick handlers.
    # Note: CSP is also set in index.html meta tag for first load before server responds
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; "
        "img-src 'self' data: blob: https:; "
        "connect-src 'self' https:; "
        "frame-ancestors 'self'; "
        "form-action 'self'; "
        "base-uri 'self';"
    )
    # NOTE:
    # Cross-origin isolation headers (COEP/COOP/CORP) can BREAK loading third-party CDN assets
    # (Tailwind CDN, icon CDNs, Google Fonts) unless every cross-origin resource is CORS-enabled.
    # Albayan serves frontend + API from the same origin by default, so these headers are optional.
    #
    # If you need crossOriginIsolation (e.g., SharedArrayBuffer), enable it explicitly:
    #   ALBAYAN_CROSS_ORIGIN_ISOLATION=true
    if os.getenv("ALBAYAN_CROSS_ORIGIN_ISOLATION", "").strip().lower() in {"1", "true", "yes"}:
        resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        # Do NOT set CORP here; it is best configured per-resource and can cause unexpected breakage.
    return resp


# OBSERVABILITY: Request ID + access logging (outermost user middleware).
# - Accepts incoming X-Request-ID from the client (sanitized), otherwise generates one.
# - Echoes X-Request-ID in ALL responses for log correlation.
# - Logs method/path/status/duration/user_id so we can debug refresh storms + slow endpoints.
@app.middleware("http")
async def request_context_and_logging(request: Request, call_next):
    import re
    import time

    started = time.time()

    # Prefer client-provided request id for end-to-end correlation, but sanitize strictly.
    incoming = (request.headers.get("X-Request-ID") or "").strip()
    if incoming and re.fullmatch(r"[A-Za-z0-9._:-]{6,64}", incoming):
        request_id = incoming
    else:
        request_id = str(uuid.uuid4())[:12]

    request.state.request_id = request_id

    response: Response = await call_next(request)

    # Always expose request id
    try:
        response.headers["X-Request-ID"] = request_id
    except Exception:
        pass

    # Structured access log (stdout -> CloudWatch on ECS)
    try:
        duration_ms = int((time.time() - started) * 1000)
        user_id = getattr(request.state, "user_id", None)
        ip = None
        try:
            # Prefer X-Forwarded-For when behind ALB/Cloudflare
            xff = request.headers.get("x-forwarded-for")
            if xff:
                ip = xff.split(",")[0].strip()
            else:
                ip = request.client.host if request.client else None
        except Exception:
            ip = None

        print(
            json.dumps(
                {
                    "ts": now_ms(),
                    "type": "access",
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": int(getattr(response, "status_code", 0) or 0),
                    "duration_ms": duration_ms,
                    "user_id": str(user_id) if user_id else None,
                    "ip": ip,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception:
        pass

    return response


def _asset_version(path: Path) -> str:
    """
    Short cache-busting version for a static asset, derived from the file's
    mtime and size. Changes whenever the file changes, stable otherwise.
    """
    try:
        st = path.stat()
        return f"{st.st_mtime_ns:x}{st.st_size:x}"[-16:]
    except Exception:
        return "0"


def _select_script_source() -> Path:
    """
    Serve minified JS only if it's up-to-date; otherwise serve script.js.
    This prevents stale deployments when rjsmin isn't installed but an old
    script.min.js exists.
    """
    src = SCRIPT_PATH
    try:
        if SCRIPT_MIN_PATH.exists() and SCRIPT_PATH.exists():
            if SCRIPT_MIN_PATH.stat().st_mtime >= SCRIPT_PATH.stat().st_mtime:
                src = SCRIPT_MIN_PATH
        elif SCRIPT_MIN_PATH.exists() and not SCRIPT_PATH.exists():
            src = SCRIPT_MIN_PATH
    except Exception:
        # Fail open to script.js
        src = SCRIPT_PATH
    return src


# Long-lived caching for correctly-versioned asset URLs. index.html itself is
# always no-store, and it references script.js/style.css with ?v=<version>, so
# a deploy changes the URLs and clients/CDNs fetch the new files immediately.
_ASSET_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}
_NO_STORE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


@app.get("/")
def serve_index(request: Request):
    if not INDEX_PATH.exists():
        raise HTTPException(status_code=500, detail="index.html not found")
    # Inject cache-busting versions into the asset URLs at serve time. The file
    # on disk stays unversioned so static serving (Capacitor www/, npx serve)
    # keeps working unchanged.
    try:
        html = INDEX_PATH.read_text(encoding="utf-8")
        script_v = _asset_version(_select_script_source())
        style_v = _asset_version(STYLE_PATH)
        html = html.replace('src="script.js"', f'src="script.js?v={script_v}"')
        html = html.replace('href="style.css"', f'href="style.css?v={style_v}"')
        # Version the bundled assets the same way (fonts, tailwind, lucide).
        for asset in ("fonts.css", "tailwind.css", "lucide.min.js"):
            attr = "src" if asset.endswith(".js") else "href"
            v = _asset_version(ASSETS_DIR / asset)
            html = html.replace(
                f'{attr}="assets/{asset}"', f'{attr}="assets/{asset}?v={v}"'
            )
        return HTMLResponse(html, headers=_NO_STORE_HEADERS)
    except Exception:
        # Fail open: serve the file as-is (unversioned assets fall back to no-store).
        return FileResponse(str(INDEX_PATH), headers=_NO_STORE_HEADERS)


@app.get("/api/health")
def health():
    """
    Health check endpoint with database connectivity test and system metrics.
    
    Returns:
        - ok: True if system is healthy
        - ts: Current timestamp
        - database: Database connection status
        - metrics: Optional performance metrics (if monitoring enabled)
    
    Note:
        - This endpoint bypasses CSRF checks (for load balancer health checks)
        - Returns 500 if database is unreachable
    """
    # Test database connectivity
    try:
        with db_conn() as conn:
            conn.execute(text("SELECT 1")).first()
        db_status = "connected"
    except Exception as e:
        db_status = f"error: {str(e)[:100]}"
        return JSONResponse(
            {"ok": False, "ts": now_ms(), "database": db_status},
            status_code=500
        )
    
    response = {
        "ok": True,
        "ts": now_ms(),
        "database": db_status,
        "version": "1.0.0"
    }
    
    # Include metrics if monitoring is available
    try:
        from .monitoring import get_metrics
        response["metrics"] = get_metrics()
    except Exception as e:
        # Log the error for debugging (don't fail the health check)
        print(f"[albayan] Health check metrics error: {type(e).__name__}: {e}")
        pass
    
    return response


# ==========================================
# DEBUG TELEMETRY (DEV ONLY)
# ==========================================
@app.get("/api/_debug/ping")
def debug_ping(request: Request):
    """
    Minimal debug endpoint to confirm the browser is reaching this server.
    Writes a NDJSON event via the host-side ingest server.
    
    Note: Only enabled when ALBAYAN_DEBUG_MODE=true
    """
    if not DEBUG_MODE:
        raise HTTPException(status_code=404, detail="Not found")
    # Also print to server logs so we can confirm requests even if NDJSON is not cleared/visible.
    try:
        print(
            "[albayan] debug_ping host=%s origin=%s ua=%s"
            % (
                str(request.headers.get("host") or "")[:80],
                str(request.headers.get("origin") or "")[:120],
                str(request.headers.get("user-agent") or "")[:120],
            )
        )
    except Exception:
        pass
    # Also return minimal debug info so the user can visually confirm they hit the right server.
    return JSONResponse(
        {
            "ok": True,
            "host": str(request.headers.get("host") or "")[:80],
            "origin": str(request.headers.get("origin") or "")[:120],
            "ua": str(request.headers.get("user-agent") or "")[:160],
            "ts": now_ms(),
        },
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/api/_debug/probe")
def debug_probe(request: Request):
    """
    Tiny debug HTML page to confirm:
    - the device can reach this server
    - JS can successfully call /api/_debug/telemetry (same-origin)
    - UA/host are visible without needing console access
    
    Note: Only enabled when ALBAYAN_DEBUG_MODE=true
    """
    if not DEBUG_MODE:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        print(
            "[albayan] debug_probe host=%s ua=%s"
            % (
                str(request.headers.get("host") or "")[:80],
                str(request.headers.get("user-agent") or "")[:120],
            )
        )
    except Exception:
        pass
    # Keep the page extremely small and cache-busted.
    html = f"""<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Albayan Debug Probe</title></head>
<body style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; padding: 16px;">
<h3>Albayan Debug Probe</h3>
<pre id="out">loading...</pre>
<p>
  <a id="open-app" href="/" style="display:none; padding:10px 14px; border:1px solid #333; border-radius:8px; text-decoration:none;">
    Open Albayan App
  </a>
</p>
<script>
(() => {{
  const out = document.getElementById('out');
  const openApp = document.getElementById('open-app');
  const now = Date.now();
  const payload = {{
    sessionId: 'debug-session',
    runId: 'audit-pre',
    hypothesisId: 'H-PROBE',
    location: 'server/main.py:debug_probe(html)',
    message: 'probe',
    data: {{
      origin: String(location.origin || '').slice(0,120),
      host: String(location.host || '').slice(0,120),
      ua: String(navigator.userAgent || '').slice(0,160),
    }},
    timestamp: now,
  }};
  const state = {{ openedAt: now, ua: payload.data.ua, host: payload.data.host, origin: payload.data.origin }};
  Promise.all([
    fetch('/api/_debug/ping?src=probe&ts=' + now, {{ cache: 'no-store' }}).then(r => r.json()).then(j => (state.ping = j)).catch(e => (state.pingErr = String(e))),
    fetch('/api/_debug/telemetry', {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(payload) }}).then(r => r.json()).then(j => (state.telemetry = j)).catch(e => (state.telemetryErr = String(e))),
  ]).finally(() => {{
    out.textContent = JSON.stringify(state, null, 2);
    try {{
      if (openApp) openApp.style.display = 'inline-block';
    }} catch (_) {{}}
  }});
}})();
</script>
</body>
</html>"""
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.post("/api/_debug/telemetry")
def debug_telemetry(request: Request, payload: dict[str, Any]):
    """
    Same-origin debug telemetry endpoint.

    Why it exists:
    - Browser-to-ingest requests can be blocked by CSP/mixed-content/privacy extensions.
    - This endpoint is same-origin, then the server forwards the event to the local ingest server
      (running on the host) via host.docker.internal.

    Security:
    - Requires same-origin request (CSRF protection).
    - Truncates fields and drops non-dict data to reduce abuse risk.
    - Intended for local/dev troubleshooting only.
    
    Note: Only enabled when ALBAYAN_DEBUG_MODE=true
    """
    if not DEBUG_MODE:
        raise HTTPException(status_code=404, detail="Not found")
    # Print a tiny line to docker logs so we can confirm the browser is hitting telemetry at all.
    try:
        print(
            "[albayan] debug_telemetry host=%s origin=%s ua=%s"
            % (
                str(request.headers.get("host") or "")[:80],
                str(request.headers.get("origin") or "")[:120],
                str(request.headers.get("user-agent") or "")[:120],
            )
        )
    except Exception:
        pass
    require_same_origin(request)
    try:
        # Minimal shape enforcement + truncation (avoid PII; our client logs should already exclude it)
        safe = {
            "sessionId": str(payload.get("sessionId") or "")[:64],
            "runId": str(payload.get("runId") or "")[:64],
            "hypothesisId": str(payload.get("hypothesisId") or "")[:32],
            "location": str(payload.get("location") or "")[:180],
            "message": str(payload.get("message") or "")[:240],
            "data": payload.get("data") if isinstance(payload.get("data"), dict) else {},
            "timestamp": int(payload.get("timestamp") or now_ms()),
        }
        # Surface the event in server logs (visible via docker logs / journalctl).
        print("[albayan] debug_telemetry event: %s" % json.dumps(safe, ensure_ascii=False)[:2000])
    except Exception:
        # Never break the app because of debug telemetry.
        pass
    return {"ok": True}


@app.get("/script.js")
def serve_script(request: Request):
    src = _select_script_source()
    if not src.exists():
        raise HTTPException(status_code=500, detail="script.js not found")
    # Cache aggressively only when the URL carries the current version
    # (injected by serve_index); any other request stays uncached for freshness.
    v = request.query_params.get("v")
    headers = _ASSET_CACHE_HEADERS if v and v == _asset_version(src) else _NO_STORE_HEADERS
    return FileResponse(str(src), media_type="application/javascript", headers=headers)


@app.get("/style.css")
def serve_style(request: Request):
    if not STYLE_PATH.exists():
        raise HTTPException(status_code=500, detail="style.css not found")
    v = request.query_params.get("v")
    headers = _ASSET_CACHE_HEADERS if v and v == _asset_version(STYLE_PATH) else _NO_STORE_HEADERS
    return FileResponse(str(STYLE_PATH), media_type="text/css", headers=headers)


_ASSET_MEDIA_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".woff2": "font/woff2",
}


def _serve_asset_file(path: Path, request: Request, always_cache: bool = False):
    """Serve one bundled asset with strict name validation done by the caller."""
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    media = _ASSET_MEDIA_TYPES.get(path.suffix.lower())
    if media is None:
        raise HTTPException(status_code=404, detail="Not found")
    v = request.query_params.get("v")
    if always_cache or (v and v == _asset_version(path)):
        headers = _ASSET_CACHE_HEADERS
    else:
        # Unversioned request: cache briefly so direct hits stay fresh-ish.
        headers = {"Cache-Control": "public, max-age=3600"}
    return FileResponse(str(path), media_type=media, headers=headers)


@app.get("/privacy")
def serve_privacy():
    """Public privacy policy — the URL app stores require for listings."""
    if not PRIVACY_PATH.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        str(PRIVACY_PATH),
        media_type="text/html",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/assets/{filename}")
def serve_asset(filename: str, request: Request):
    # Only plain filenames — no separators, no traversal.
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=404, detail="Not found")
    return _serve_asset_file(ASSETS_DIR / filename, request)


@app.get("/assets/fonts/{filename}")
def serve_asset_font(filename: str, request: Request):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=404, detail="Not found")
    # Font files have content-unique names (from Google's CDN), so they are
    # safe to cache forever even without a version parameter.
    return _serve_asset_file(ASSETS_DIR / "fonts" / filename, request, always_cache=True)


@app.post("/api/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request):
    require_same_origin(request)

    allowed, wait_ms = _rate_check(request, str(payload.email))
    if not allowed:
        wait_seconds = max(1, int(wait_ms / 1000))
        wait_minutes = max(1, wait_seconds // 60)
        # Return a proper 429 with Retry-After header for clients to respect
        raise HTTPException(
            status_code=429, 
            detail=f"Too many login attempts. Please wait {wait_minutes} minute(s) before trying again.",
            headers={"Retry-After": str(wait_seconds)}
        )

    user = _get_user_by_email(str(payload.email))
    if not user:
        # Helpful setup hint (safe, local-first): if there are ZERO users, the server isn't initialized yet.
        # Avoid leaking exact user counts; only disclose the "empty" case.
        try:
            with db_conn() as conn:
                n = conn.execute(text("SELECT COUNT(*) FROM users WHERE deleted = false")).scalar()
            if int(n or 0) == 0:
                raise HTTPException(
                    status_code=503,
                    detail="Server not initialized (no users). Create the first admin: docker compose exec albayan python -m server.create_admin --email YOUR_EMAIL --name Admin",
                )
        except HTTPException:
            raise
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not verify_password(
        payload.password,
        user["password_hash"],
        user["password_salt"],
        user["password_algo"],
        int(user["password_iterations"]),
    ):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    session_id, token = _create_session(user["id"], request)
    cookie_val = new_session_cookie_value(session_id, token)

    resp = JSONResponse(content=LoginResponse(user=user_row_to_public(user)).model_dump())
    # The packaged mobile apps call the API cross-origin (their WebView origin
    # is capacitor://localhost or https://localhost), and browsers/WebViews do
    # not send SameSite=Lax cookies on cross-site requests. For logins coming
    # from a trusted app origin, issue the cookie with SameSite=None (requires
    # Secure). Web logins keep the stricter Lax cookie.
    login_origin = request.headers.get("origin") or ""
    is_mobile_app_login = login_origin in MOBILE_APP_ORIGINS
    resp.set_cookie(
        COOKIE_NAME,
        cookie_val,
        httponly=True,
        secure=True if is_mobile_app_login else COOKIE_SECURE,
        samesite="none" if is_mobile_app_login else "lax",
        max_age=int(SESSION_DURATION_MS / 1000),
        path="/",
    )
    
    # Reset rate limit on successful login so user isn't penalized for previous failed attempts
    from .rate_limiter import reset_rate_limit
    reset_rate_limit(f"login:{_rate_key(request, str(payload.email))}")
    
    audit(user["id"], "login", "auth", user["id"], f"User {user['email']} logged in", {})
    return resp


@app.post("/api/auth/logout")
def logout(request: Request, user: dict[str, Any] = Depends(current_user)):
    require_same_origin(request)
    cookie_val = request.cookies.get(COOKIE_NAME)
    parsed = parse_session_cookie_value(cookie_val or "")
    if parsed:
        session_id, _ = parsed
        _delete_session(session_id)

    resp = JSONResponse(content={"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    audit(user.get("id"), "logout", "auth", str(user.get("id")), "User logged out", {})
    return resp


@app.get("/api/auth/me", response_model=UserPublic)
def me(user: dict[str, Any] = Depends(current_user)):
    return user_row_to_public(user)


@app.post("/api/auth/password-change")
def change_password(body: ChangePasswordRequest, request: Request, user: dict[str, Any] = Depends(current_user)):
    require_same_origin(request)

    # SECURITY FIX: Rate limit password change attempts to prevent brute force
    from .rate_limiter import check_rate_limit, reset_rate_limit
    
    # Rate limit based on user ID + IP for additional protection
    ip = request.client.host if request.client else "unknown"
    key = f"pwchange:{user['id']}:{ip}"
    allowed, _, retry_after_ms = check_rate_limit(key, max_attempts=5, window_ms=15*60*1000)
    if not allowed:
        audit(str(user.get("id")), "password_change_blocked", "auth", str(user.get("id")), "Password change rate limited", {"ip": ip})
        wait_seconds = max(1, int((retry_after_ms or (15 * 60 * 1000)) / 1000))
        wait_minutes = max(1, wait_seconds // 60)
        raise HTTPException(
            status_code=429,
            detail=f"Too many password change attempts. Please wait {wait_minutes} minute(s) and try again.",
            headers={"Retry-After": str(wait_seconds)},
        )

    # Verify current password
    if not verify_password(
        body.currentPassword,
        user["password_hash"],
        user["password_salt"],
        user["password_algo"],
        int(user["password_iterations"]),
    ):
        # SECURITY: Log failed current password verification (potential session theft detection)
        audit(str(user.get("id")), "password_change_failed", "auth", str(user.get("id")), "Current password verification failed", {"ip": ip})
        raise HTTPException(status_code=401, detail="Invalid current password")
    
    # Reset rate limit on successful current password verification
    reset_rate_limit(key)

    now = now_ms()
    pw = hash_password(body.newPassword, iterations=PBKDF2_ITERATIONS_DEFAULT)
    user_id = str(user.get("id"))
    current_session_id = user.get("session_id")

    with db_conn() as conn:
        conn.execute(
            text(
                """
                UPDATE users
                SET password_hash = :password_hash,
                    password_salt = :password_salt,
                    password_algo = :password_algo,
                    password_iterations = :password_iterations,
                    last_modified = :last_modified
                WHERE id = :id
                """
            ),
            {
                "password_hash": pw.hash_hex,
                "password_salt": pw.salt_hex,
                "password_algo": pw.algo,
                "password_iterations": pw.iterations,
                "last_modified": now,
                "id": user_id,
            },
        )

        # SECURITY FIX: Delete ALL sessions including current (force re-login)
        # This prevents session fixation attacks where stolen sessions remain valid
        conn.execute(
            text("DELETE FROM sessions WHERE user_id = :user_id"),
            {"user_id": user_id}
        )

    audit(user_id, "password_change", "auth", user_id, "User changed password (forced logout)", {})
    
    # Delete session cookie to force re-authentication
    resp = JSONResponse(content={"ok": True, "requires_reauth": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.post("/api/auth/password-reset/request")
def password_reset_request(body: PasswordResetRequest, request: Request):
    require_same_origin(request)

    allowed, wait_ms = _reset_rate_check(request, str(body.email))
    if not allowed:
        raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {int(wait_ms/1000)}s")

    email = str(body.email).lower()
    user = _get_user_by_email(email)

    # Always return ok to avoid account enumeration.
    if not user:
        audit(None, "password_reset_request", "auth", email, "Password reset requested (unknown email)", {"email": email})
        return {"ok": True}

    token = secrets.token_urlsafe(32)
    token_hash = hash_token(token)
    now = now_ms()
    expires = now + PASSWORD_RESET_TOKEN_MS
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")

    with db_conn() as conn:
        # Clean up old tokens for this user + expired tokens
        # BEST PRACTICE: Atomic cleanup - combine into single query to prevent race condition
        conn.execute(
            text("DELETE FROM password_resets WHERE expires_at <= :now OR used_at IS NOT NULL OR user_id = :user_id"),
            {"now": now, "user_id": user["id"]}
        )

        conn.execute(
            text(
                """
                INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at, ip, user_agent)
                VALUES (:id, :user_id, :token_hash, :created_at, :expires_at, NULL, :ip, :user_agent)
                """
            ),
            {
                "id": new_id("pwreset"),
                "user_id": user["id"],
                "token_hash": token_hash,
                "created_at": now,
                "expires_at": expires,
                "ip": ip,
                "user_agent": ua,
            },
        )

    audit(user["id"], "password_reset_request", "auth", user["id"], "Password reset requested", {"email": email})

    resp: dict[str, Any] = {"ok": True}
    # Dev/testing only: optionally return the reset code in the response.
    if PASSWORD_RESET_DEV_RETURN_CODE:
        resp["resetCode"] = token
    return resp


@app.post("/api/auth/password-reset/confirm")
def password_reset_confirm(body: PasswordResetConfirmRequest, request: Request):
    require_same_origin(request)

    # SECURITY: Rate limit password reset confirm to prevent brute force attacks
    allowed, wait_ms = _reset_rate_check(request, "reset_confirm")
    if not allowed:
        raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {int(wait_ms/1000)}s")

    # SECURITY: Validate token format and length (secrets.token_urlsafe(32) produces ~43 char tokens)
    token = sanitize_str(body.token)[:256]
    if not token:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    # Validate token length (should be reasonable for URL-safe base64)
    if len(token) < 20 or len(token) > 100:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    # Validate token contains only URL-safe characters
    if not all(c.isalnum() or c in '-_' for c in token):
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")

    token_hash = hash_token(token)
    now = now_ms()

    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM password_resets WHERE token_hash = :token_hash LIMIT 1"),
                {"token_hash": token_hash},
            )
            .mappings()
            .first()
        )

        if not row:
            raise HTTPException(status_code=400, detail="Invalid or expired reset code")

        if row.get("used_at") is not None:
            raise HTTPException(status_code=400, detail="Invalid or expired reset code")

        if int(row.get("expires_at") or 0) <= now:
            conn.execute(text("DELETE FROM password_resets WHERE id = :id"), {"id": row["id"]})
            raise HTTPException(status_code=400, detail="Invalid or expired reset code")

        user_id = str(row.get("user_id"))
        pw = hash_password(body.newPassword, iterations=PBKDF2_ITERATIONS_DEFAULT)

        conn.execute(
            text(
                """
                UPDATE users
                SET password_hash = :password_hash,
                    password_salt = :password_salt,
                    password_algo = :password_algo,
                    password_iterations = :password_iterations,
                    last_modified = :last_modified
                WHERE id = :id
                """
            ),
            {
                "password_hash": pw.hash_hex,
                "password_salt": pw.salt_hex,
                "password_algo": pw.algo,
                "password_iterations": pw.iterations,
                "last_modified": now,
                "id": user_id,
            },
        )

        # Mark token used and invalidate sessions
        conn.execute(text("UPDATE password_resets SET used_at = :used_at WHERE id = :id"), {"used_at": now, "id": row["id"]})
        conn.execute(text("DELETE FROM sessions WHERE user_id = :user_id"), {"user_id": user_id})

    audit(user_id, "password_reset", "auth", user_id, "Password reset via token", {})
    return {"ok": True}


def _page_all(collection: str, **kwargs: Any) -> list[dict[str, Any]]:
    # list_entities caps a single call at 1000 rows; page through so callers
    # keep a "returns all records" contract instead of silently truncating.
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = list_entities(collection, limit=1000, offset=offset, **kwargs)
        out.extend(page)
        if len(page) < 1000:
            return out
        offset += 1000


def _bootstrap_fetch_scoped(collection: str, user: dict[str, Any]) -> list[dict[str, Any]]:
    """Fetch a collection for /api/bootstrap using the SAME visibility rules as
    GET /api/collections/{collection}. Previously bootstrap returned the entire
    table to any authenticated user, so a Delivery driver (or a viewOwn-only
    user) received every ad/receipt/customer in the business. This mirrors
    get_collection's delivery scoping and view/viewOwn permission checks.
    """
    role_lower = str(user.get("role") or "").lower()

    # Delivery users: only records assigned to them (mirror get_collection).
    if role_lower == "delivery" and collection in {"ads", "receipts", "customers"}:
        uid = sanitize_str(str(user.get("id") or ""))[:80]
        if not uid:
            return []
        if collection in {"ads", "receipts"}:
            return _page_all(collection, include_deleted=False, assigned_to=uid)
        # customers: only those referenced by the driver's assigned deliveries.
        customer_ids: set[str] = set()
        for c in ("ads", "receipts"):
            for it in _page_all(c, include_deleted=False, assigned_to=uid):
                cid = (it.get("data") or {}).get("customerId")
                if cid:
                    customer_ids.add(sanitize_str(str(cid))[:80])
        if not customer_ids:
            return []
        return _page_all("customers", include_deleted=False, id_in=sorted(customer_ids))

    module = _module_for_collection(collection)
    action = _action_for_collection(collection, "view")
    can_view_all = user_has_permission(user, module, action)
    can_view_own = user_has_permission(user, module, action, record_creator_id=str(user.get("id") or ""))
    if not can_view_all and not can_view_own:
        return []

    include_deleted = can_view_all and user_has_permission(
        user, module, _action_for_collection(collection, "delete")
    )
    created_by_filter = None if can_view_all else str(user.get("id") or "")
    return _page_all(collection, include_deleted=include_deleted, created_by=created_by_filter)


@app.get("/api/bootstrap", response_model=BootstrapResponse)
def bootstrap(user: dict[str, Any] = Depends(current_user)):
    # For huge datasets, prefer the paginated endpoints.
    # This endpoint returns all records and is best for small/medium deployments.
    ads = _bootstrap_fetch_scoped("ads", user)
    receipts = _bootstrap_fetch_scoped("receipts", user)
    customers = _bootstrap_fetch_scoped("customers", user)
    pages = _bootstrap_fetch_scoped("pages", user)
    # Exchange-rate history is non-sensitive reference data every client needs to
    # render historical money conversions; keep it readable to all authenticated
    # users (unchanged behavior).
    exh = _page_all("exchangeRateHistory", include_deleted=True)
    logs = []  # audit logs are available via /api/audit

    return BootstrapResponse(
        user=user_row_to_public(user),
        ads=[e["data"] for e in ads],
        receipts=[e["data"] for e in receipts],
        customers=[e["data"] for e in customers],
        pages=[e["data"] for e in pages],
        exchangeRateHistory=[e["data"] for e in exh],
        logs=logs,
    )


def _module_for_collection(name: str) -> str:
    # collection names map to permission modules
    if name in {"ads", "receipts", "customers", "pages"}:
        return name
    if name == "exchangeRateHistory":
        return "settings"
    return name


def _action_for_collection(collection: str, op: str) -> str:
    """
    Map collection operations to permission actions.
    op: view | add | edit | delete
    """
    if collection == "exchangeRateHistory":
        # This is controlled by Settings permissions in the frontend
        if op in {"add", "edit", "delete"}:
            return "manageExchangeRate"
        return "view"
    return op


@app.get("/api/collections/{collection}", response_model=list[EntityResponse])
def get_collection(
    collection: str,
    updated_since: Optional[int] = None,
    limit: int = 500,
    offset: int = 0,
    include_deleted: bool = False,
    user: dict[str, Any] = Depends(current_user),
):
    role_lower = str(user.get("role") or "").lower()
    # Delivery users should only see records assigned to them (deliveryPersonId == user.id).
    # This avoids leaking the full Ads/Receipts/Customers database to drivers.
    if role_lower == "delivery":
        uid = sanitize_str(str(user.get("id") or ""))[:80]
        if not uid:
            raise HTTPException(status_code=403, detail="Forbidden")

        if collection in {"ads", "receipts"}:
            items = list_entities(
                collection,
                updated_since=updated_since,
                limit=limit,
                offset=offset,
                include_deleted=False,
                assigned_to=uid,
            )
            return [EntityResponse(**i) for i in items]

        if collection == "customers":
            # Only customers referenced by the delivery user's assigned deliveries.
            customer_ids: set[str] = set()
            for c in ("ads", "receipts"):
                items = list_entities(
                    c,
                    updated_since=None,
                    limit=5000,
                    offset=0,
                    include_deleted=False,
                    assigned_to=uid,
                )
                for it in items:
                    cid = (it.get("data") or {}).get("customerId")
                    if cid:
                        customer_ids.add(sanitize_str(str(cid))[:80])

            if not customer_ids:
                return []

            items = list_entities(
                "customers",
                updated_since=updated_since,
                limit=limit,
                offset=offset,
                include_deleted=False,
                id_in=sorted(customer_ids),
            )
            return [EntityResponse(**i) for i in items]

    module = _module_for_collection(collection)
    action = _action_for_collection(collection, "view")
    can_view_all = user_has_permission(user, module, action)
    can_view_own = user_has_permission(user, module, action, record_creator_id=str(user.get("id") or ""))
    if not can_view_all and not can_view_own:
        raise HTTPException(status_code=403, detail="Forbidden")

    # include_deleted is only allowed if user has delete permission
    if include_deleted and not user_has_permission(user, module, _action_for_collection(collection, "delete")):
        include_deleted = False

    created_by_filter = None if can_view_all else str(user.get("id") or "")
    items = list_entities(
        collection,
        updated_since=updated_since,
        limit=limit,
        offset=offset,
        include_deleted=include_deleted if can_view_all else False,
        created_by=created_by_filter,
    )
    return [EntityResponse(**i) for i in items]


@app.get("/api/collections/{collection}/{entity_id}", response_model=EntityResponse)
def get_collection_item(
    collection: str,
    entity_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    role_lower = str(user.get("role") or "").lower()
    if role_lower == "delivery" and collection in {"ads", "receipts"}:
        item = get_entity(collection, entity_id)
        if not item:
            raise HTTPException(status_code=404, detail="Not found")
        data = item.get("data") or {}
        if str(data.get("deliveryPersonId") or "") != str(user.get("id") or ""):
            raise HTTPException(status_code=403, detail="Forbidden")
        return EntityResponse(**item)

    module = _module_for_collection(collection)
    action = _action_for_collection(collection, "view")
    if not user_has_permission(user, module, action) and not user_has_permission(
        user, module, action, record_creator_id=str(user.get("id") or "")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")

    item = get_entity(collection, entity_id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")

    # If user only has viewOwn, enforce creator ownership
    creator = item.get("createdBy") or (item.get("data") or {}).get("createdBy") or (item.get("data") or {}).get("creatorId")
    if user_has_permission(user, module, action):
        return EntityResponse(**item)
    if user_has_permission(user, module, action, record_creator_id=str(creator or "")):
        return EntityResponse(**item)

    raise HTTPException(status_code=403, detail="Forbidden")


@app.post("/api/collections/{collection}", response_model=EntityResponse)
def create_collection_item(
    collection: str,
    body: EntityCreateRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    module = _module_for_collection(collection)
    if not user_has_permission(user, module, _action_for_collection(collection, "add")):
        raise HTTPException(status_code=403, detail="Forbidden")

    entity_id = sanitize_str(body.id or "")[:80] or new_id(collection[:10] or "id")

    # Create must not overwrite existing records
    if get_entity_meta(collection, entity_id):
        raise HTTPException(status_code=409, detail="ID already exists")

    # Normalize/validate certain flows server-side (multi-user safe).
    if collection == "ads":
        data_in = sanitize_json(body.data or {}) or {}
        payment_status = sanitize_str(str(data_in.get("paymentStatus") or ""))[:40]
        collection_method = sanitize_str(str(data_in.get("collectionMethod") or ""))[:40]
        # Not Paid + Driver flow must NOT create deliveries on ads (delivery is tracked on the receipt).
        if payment_status == "not_paid" and collection_method == "driver":
            data_in["deliveryPersonId"] = ""
            data_in["deliveryStatus"] = "Office"
        body_data = data_in

    # Receipt number uniqueness enforcement + temp receipt generation (server-side, multi-user safe)
    elif collection == "receipts":
        data_in = sanitize_json(body.data or {}) or {}

        status_in = sanitize_str(str(data_in.get("status") or ""))[:40]
        delivery_status_in = sanitize_str(str(data_in.get("deliveryStatus") or ""))[:40]
        delivery_person_id_in = sanitize_str(str(data_in.get("deliveryPersonId") or ""))[:80]
        status_detail_in = data_in.get("statusDetail") if isinstance(data_in.get("statusDetail"), dict) else {}
        not_paid_collection_in = sanitize_str(str((status_detail_in or {}).get("notPaidCollection") or ""))[:40]

        is_temp_delivery = bool(
            status_in == "Not Paid"
            and (not_paid_collection_in == "delivery" or delivery_status_in == "Needs Delivery")
        )

        # Enforce: temp delivery receipts must be assigned to a driver.
        if is_temp_delivery and not delivery_person_id_in:
            raise HTTPException(status_code=400, detail="deliveryPersonId is required for delivery receipts")

        temp_in = sanitize_str(str(data_in.get("tempReceiptNo") or ""))[:80]

        # Server-generated temp receipt number (preferred): if not provided, generate D{n} safely.
        if is_temp_delivery and not temp_in:
            temp_in = _next_temp_delivery_receipt_no(str(user.get("id") or "system"))
            data_in["tempReceiptNo"] = temp_in
            # Keep temp delivery receipts from accidentally using temp as serial
            data_in["serialNumber"] = sanitize_str(str(data_in.get("serialNumber") or ""))[:80]
            if data_in.get("serialNumber") and str(data_in.get("serialNumber")).strip().upper().startswith("D"):
                data_in["serialNumber"] = ""
            data_in["receiptType"] = sanitize_str(str(data_in.get("receiptType") or ""))[:40] or "DELIVERY_TEMP"

        if temp_in:
            # Temp delivery receipt format: D{n}
            if not (temp_in.startswith("D") and temp_in[1:].isdigit()):
                raise HTTPException(status_code=400, detail="Invalid tempReceiptNo (expected D{n})")
            if _temp_receipt_no_exists(temp_in):
                raise HTTPException(status_code=409, detail="tempReceiptNo already exists")

        # Validate finalReceiptNo AND serialNumber independently. Previously only
        # the first non-empty of the two was checked, so a request that sent a
        # valid finalReceiptNo alongside an invalid/duplicate serialNumber stored
        # the bad serial without any format or uniqueness check. Read fresh from
        # data_in so the temp-delivery block above (which may clear serialNumber)
        # is respected.
        _final_no = sanitize_str(str(data_in.get("finalReceiptNo") or ""))[:80]
        _serial_no = sanitize_str(str(data_in.get("serialNumber") or ""))[:80]
        _serials_to_check = [_final_no]
        if _serial_no and _serial_no != _final_no:
            _serials_to_check.append(_serial_no)
        for _s in _serials_to_check:
            if not _s:
                continue
            # Allow S-prefixed auto-serial (S1, S2, S3) for LTT/Libyana/Madar, or regular digits
            if not _is_valid_serial_number(_s):
                raise HTTPException(status_code=400, detail="Invalid serialNumber (must be digits or S-prefixed like S1, S2)")
            if _receipt_serial_exists(_s):
                raise HTTPException(status_code=409, detail="serialNumber already exists")

        # Persist server-generated/normalized fields
        body_data = data_in
    else:
        body_data = body.data

    saved = upsert_entity(collection, entity_id, body_data, str(user.get("id") or "system"), create_if_missing=True)
    audit(str(user.get("id")), "create", collection, entity_id, f"Created {collection} {entity_id}", {})
    return EntityResponse(**saved)


@app.patch("/api/collections/{collection}/{entity_id}", response_model=EntityResponse)
def update_collection_item(
    collection: str,
    entity_id: str,
    body: EntityUpdateRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    module = _module_for_collection(collection)

    existing = get_entity(collection, entity_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")

    role_lower = str(user.get("role") or "").lower()
    # Delivery users can update ONLY their assigned deliveries.
    if role_lower == "delivery" and collection in {"ads", "receipts"}:
        data = existing.get("data") or {}
        if str(data.get("deliveryPersonId") or "") != str(user.get("id") or ""):
            raise HTTPException(status_code=403, detail="Forbidden")

        updates = sanitize_json(body.data or {}) or {}
        # Remove protected keys + disallow reassignment
        for k in ["id", "_created", "createdBy", "createdAt", "creatorId", "deliveryPersonId"]:
            updates.pop(k, None)

        if collection == "ads":
            allowed_fields = {
                "deliveryStatus",
                "acceptedDate",
                "isPaid",
                "collectionDate",
                "status",
                "isReceivedInOffice",
                # cancellation
                "deliveryCancelReason",
                "deliveryCancelledAt",
                "deliveryCancelledBy",
                # history (client-maintained)
                "deliveryHistory",
            }
            updates = {k: v for k, v in updates.items() if k in allowed_fields}
            if not updates:
                raise HTTPException(status_code=400, detail="No allowed fields to update")

            desired = str(updates.get("deliveryStatus") or "").strip()
            now = now_ms()
            if desired == "Canceled":
                reason = sanitize_str(str(updates.get("deliveryCancelReason") or ""))[:500]
                if not reason:
                    raise HTTPException(status_code=400, detail="deliveryCancelReason is required")
                updates["deliveryCancelReason"] = reason
                updates["deliveryCancelledAt"] = updates.get("deliveryCancelledAt") or now
                updates["deliveryCancelledBy"] = updates.get("deliveryCancelledBy") or sanitize_str(
                    str(user.get("id") or "")
                )[:80]

        if collection == "receipts":
            # Delivery receipts: strict confirmation flow on DELIVERED.
            allowed_fields = {
                # existing delivery fields
                "deliveryStatus",
                "acceptedDate",
                "isReceivedInOffice",
                # driver completion inputs
                "finalReceiptNo",
                "serialNumber",
                "receiptImage",
                "photos",
                "amountCollectedFromCustomer",
                "actualDeliveryFeeCollected",
                "deliveryFeeCollected",
                "driverNotes",
                # cancellation
                "deliveryCancelReason",
                "deliveryCancelledAt",
                "deliveryCancelledBy",
                # history (client-maintained)
                "deliveryHistory",
                # payment status (required for marking delivered)
                "status",
                "isPaid",
                "collectionDate",
                # computed fields (server may override, but allow client to send)
                "paymentResult",
                "overpaidAmount",
                "remainingDue",
                "feeDifferenceStatus",
                "feeDiff",
                "ownerCoveredExtraFee",
                "ownerCoveredNotes",
                "debtAmountLocal",
                "debtAmountUSD",
                "amountLocal",
                "amountUSD",
                "deliveredAt",
            }
            updates = {k: v for k, v in updates.items() if k in allowed_fields}
            if not updates:
                raise HTTPException(status_code=400, detail="No allowed fields to update")

            def _as_float(v: Any) -> Optional[float]:
                if v is None:
                    return None
                if isinstance(v, (int, float)):
                    return float(v)
                s = str(v).strip()
                if not s:
                    return None
                try:
                    return float(s)
                except Exception:
                    return None

            desired = str(updates.get("deliveryStatus") or "").strip()
            now = now_ms()
            current_status = str(data.get("deliveryStatus") or "").strip()

            # SECURITY: payment/settlement and server-computed fields may ONLY
            # be written by the server's Delivered-confirmation computation
            # below. Otherwise a driver could PATCH e.g. status=Paid,
            # amountUSD=999999 on a non-Delivered update and bypass every
            # verification (finding: delivery-role settlement bypass). Strip
            # them from any update that is not a Delivered transition.
            SETTLEMENT_FIELDS = {
                "status", "isPaid", "collectionDate",
                "paymentResult", "overpaidAmount", "remainingDue",
                "feeDifferenceStatus", "feeDiff",
                "debtAmountLocal", "debtAmountUSD",
                "amountLocal", "amountUSD", "deliveredAt",
                "finalReceiptNo", "serialNumber",
                # Proof + collected-amount inputs: these are the settlement
                # EVIDENCE. They may only be written as part of the server's
                # Delivered-confirmation computation below. Otherwise a driver
                # could PATCH a receipt that is already Delivered (desired == "",
                # so the transition check is skipped) with a smaller
                # amountCollectedFromCustomer and a swapped proof photo, falsifying
                # what they collected. Strip them from any non-Delivered update.
                "amountCollectedFromCustomer",
                "actualDeliveryFeeCollected",
                "deliveryFeeCollected",
                "receiptImage",
                "photos",
            }
            if desired != "Delivered":
                for _f in SETTLEMENT_FIELDS:
                    updates.pop(_f, None)

            # Validate delivery status transitions
            VALID_TRANSITIONS = {
                "": {"Needs Delivery", "In Progress", "Office"},  # Initial state
                "Office": {"Needs Delivery", "In Progress"},
                "Needs Delivery": {"In Progress", "Canceled"},
                "In Progress": {"Delivered", "Canceled"},
                "Delivered": set(),  # Terminal state - no transitions allowed
                "Canceled": set(),   # Terminal state - no transitions allowed
            }

            if desired and desired != current_status:
                allowed = VALID_TRANSITIONS.get(current_status, set())
                if desired not in allowed:
                    if current_status in {"Delivered", "Canceled"}:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Cannot change status from '{current_status}' - this is a terminal state"
                        )
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid status transition from '{current_status}' to '{desired}'. Allowed: {', '.join(allowed) if allowed else 'none'}"
                    )

            if desired == "Delivered":
                # Required fields (driver must confirm)
                final_no = sanitize_str(
                    str(updates.get("finalReceiptNo") or updates.get("serialNumber") or "")
                )[:80]
                if not final_no:
                    raise HTTPException(status_code=400, detail="finalReceiptNo is required")
                # Allow S-prefixed auto-serial (S1, S2, S3) for LTT/Libyana/Madar, or regular digits
                if not _is_valid_serial_number(final_no):
                    raise HTTPException(status_code=400, detail="finalReceiptNo must be digits (no leading 0) or S-prefixed (S1, S2)")
                if _receipt_serial_exists(final_no, exclude_id=entity_id):
                    raise HTTPException(status_code=409, detail="finalReceiptNo already exists")

                receipt_image = str(updates.get("receiptImage") or data.get("receiptImage") or "").strip()
                if not receipt_image:
                    raise HTTPException(status_code=400, detail="receiptImage is required")

                amt_collected = _as_float(updates.get("amountCollectedFromCustomer"))
                if amt_collected is None:
                    raise HTTPException(status_code=400, detail="amountCollectedFromCustomer is required")
                if amt_collected < 0:
                    raise HTTPException(status_code=400, detail="amountCollectedFromCustomer must be >= 0")

                fee_collected = _as_float(updates.get("actualDeliveryFeeCollected"))
                if fee_collected is None:
                    fee_collected = _as_float(updates.get("deliveryFeeCollected"))
                if fee_collected is None:
                    raise HTTPException(status_code=400, detail="actualDeliveryFeeCollected is required")
                if fee_collected < 0:
                    raise HTTPException(status_code=400, detail="actualDeliveryFeeCollected must be >= 0")

                # Preserve debt baseline (what customer SHOULD pay)
                debt_local = _as_float(data.get("debtAmountLocal"))
                if debt_local is None:
                    debt_local = _as_float(data.get("amountLocal")) or 0.0
                    updates["debtAmountLocal"] = float(debt_local)
                debt_usd = _as_float(data.get("debtAmountUSD"))
                if debt_usd is None:
                    debt_usd = _as_float(data.get("amountUSD")) or 0.0
                    updates["debtAmountUSD"] = float(debt_usd)

                # Compute debt comparison
                diff = float(amt_collected) - float(debt_local or 0.0)
                if abs(diff) < 1e-9:
                    payment_result = "PAID_EXACT"
                    overpaid = 0.0
                    remaining_due = 0.0
                elif diff > 0:
                    payment_result = "OVERPAID"
                    overpaid = float(diff)
                    remaining_due = 0.0
                else:
                    payment_result = "UNDERPAID"
                    overpaid = 0.0
                    remaining_due = float(abs(diff))

                # Fee comparison (quoted vs actual)
                quoted_fee = _as_float(data.get("quotedDeliveryFee")) or 0.0
                fee_diff = float(fee_collected) - float(quoted_fee)
                if abs(fee_diff) < 1e-9:
                    fee_status = "SAME"
                elif fee_diff < 0:
                    fee_status = "LOWER"
                else:
                    fee_status = "HIGHER"

                # Server-truth fields
                updates["finalReceiptNo"] = final_no
                updates["serialNumber"] = final_no
                updates["receiptImage"] = receipt_image
                updates["amountCollectedFromCustomer"] = float(amt_collected)
                updates["actualDeliveryFeeCollected"] = float(fee_collected)
                updates["deliveryFeeCollected"] = float(fee_collected)
                updates["paymentResult"] = payment_result
                updates["overpaidAmount"] = overpaid
                updates["remainingDue"] = remaining_due
                updates["feeDifferenceStatus"] = fee_status
                updates["feeDiff"] = fee_diff
                updates["deliveredAt"] = updates.get("deliveredAt") or now

                # Revenue: delivery fee is NOT business revenue. Only amountCollectedFromCustomer counts.
                updates["amountLocal"] = float(amt_collected)
                # Convert collected LYD to USD. The receipt's exchangeRate can be
                # missing or the clamped-invalid sentinel (0.001) when Rate 2 was
                # left blank at creation; dividing by that fabricates enormous USD
                # ad credit (500 LYD -> $500,000). So only trust a real rate; else
                # derive it from the receipt's own debt baseline, and if there is
                # no baseline either, fall back to the USD debt directly rather
                # than storing raw LYD as USD.
                ex_rate = _as_float(data.get("exchangeRate"))
                trusted_rate = ex_rate if (ex_rate is not None and ex_rate > MIN_EXCHANGE_RATE) else None
                if trusted_rate is None and debt_local and debt_usd and debt_local > 0 and debt_usd > 0:
                    trusted_rate = float(debt_local) / float(debt_usd)
                if trusted_rate and trusted_rate > 0:
                    updates["amountUSD"] = float(amt_collected) / float(trusted_rate)
                else:
                    # No usable rate at all: use the USD debt baseline (0 if none),
                    # never raw LYD misrepresented as USD.
                    updates["amountUSD"] = float(debt_usd or 0.0)

                # Payment status based on remaining due
                if remaining_due <= 1e-9:
                    updates["status"] = "Paid"
                    updates["isPaid"] = True
                else:
                    updates["status"] = "Not Paid"
                    updates["isPaid"] = False

            if desired == "Canceled":
                reason = sanitize_str(str(updates.get("deliveryCancelReason") or ""))[:500]
                if not reason:
                    raise HTTPException(status_code=400, detail="deliveryCancelReason is required")
                updates["deliveryCancelReason"] = reason
                updates["deliveryCancelledAt"] = updates.get("deliveryCancelledAt") or now
                updates["deliveryCancelledBy"] = updates.get("deliveryCancelledBy") or sanitize_str(
                    str(user.get("id") or "")
                )[:80]

        # Optimistic concurrency: if client provides expectedLastModified, enforce it
        if body.expectedLastModified is not None:
            meta = get_entity_meta(collection, entity_id)
            if meta and int(meta.get("last_modified") or 0) != int(body.expectedLastModified):
                raise HTTPException(status_code=409, detail="Conflict: record has changed")

        saved = patch_entity(collection, entity_id, updates, str(user.get("id") or "system"))
        audit(str(user.get("id")), "update", collection, entity_id, f"Updated {collection} {entity_id} (delivery)", {})
        return EntityResponse(**saved)

    creator = existing.get("createdBy") or (existing.get("data") or {}).get("createdBy") or (existing.get("data") or {}).get("creatorId")
    if not user_has_permission(user, module, _action_for_collection(collection, "edit"), record_creator_id=str(creator or "")):
        raise HTTPException(status_code=403, detail="Forbidden")

    # Optimistic concurrency: if client provides expectedLastModified, enforce it
    if body.expectedLastModified is not None:
        meta = get_entity_meta(collection, entity_id)
        if meta and int(meta.get("last_modified") or 0) != int(body.expectedLastModified):
            raise HTTPException(status_code=409, detail="Conflict: record has changed")

    # Strict rule: temp delivery receipts can only be marked DELIVERED by the assigned delivery user.
    if collection == "receipts":
        updates_in = sanitize_json(body.data or {}) or {}
        desired_delivery_status = str(updates_in.get("deliveryStatus") or "").strip()
        if desired_delivery_status == "Delivered":
            data0 = existing.get("data") or {}
            if str(data0.get("tempReceiptNo") or "").strip():
                raise HTTPException(status_code=403, detail="Only the assigned delivery user can mark this receipt delivered")

    # Receipt number uniqueness enforcement (server-side, multi-user safe)
    if collection == "receipts":
        updates_in = sanitize_json(body.data or {}) or {}
        temp_in = sanitize_str(str(updates_in.get("tempReceiptNo") or ""))[:80]

        if temp_in:
            if not (temp_in.startswith("D") and temp_in[1:].isdigit()):
                raise HTTPException(status_code=400, detail="Invalid tempReceiptNo (expected D{n})")
            if _temp_receipt_no_exists(temp_in, exclude_id=entity_id):
                raise HTTPException(status_code=409, detail="tempReceiptNo already exists")

        # Validate finalReceiptNo AND serialNumber independently (see create path).
        _final_no = sanitize_str(str(updates_in.get("finalReceiptNo") or ""))[:80]
        _serial_no = sanitize_str(str(updates_in.get("serialNumber") or ""))[:80]
        _serials_to_check = [_final_no]
        if _serial_no and _serial_no != _final_no:
            _serials_to_check.append(_serial_no)
        for _s in _serials_to_check:
            if not _s:
                continue
            # Allow S-prefixed auto-serial (S1, S2, S3) for LTT/Libyana/Madar, or regular digits
            if not _is_valid_serial_number(_s):
                raise HTTPException(status_code=400, detail="Invalid serialNumber (must be digits or S-prefixed like S1, S2)")
            if _receipt_serial_exists(_s, exclude_id=entity_id):
                raise HTTPException(status_code=409, detail="serialNumber already exists")

    # Enforce: Ads must NOT create deliveries in the Not Paid + Driver receipt-linked flow.
    updates_to_save: dict[str, Any] = body.data
    if collection == "ads":
        upd = sanitize_json(body.data or {}) or {}
        data0 = existing.get("data") or {}
        merged: dict[str, Any] = {}
        if isinstance(data0, dict):
            merged.update(data0)
        if isinstance(upd, dict):
            merged.update(upd)
        payment_status = sanitize_str(str(merged.get("paymentStatus") or ""))[:40]
        collection_method = sanitize_str(str(merged.get("collectionMethod") or ""))[:40]
        if payment_status == "not_paid" and collection_method == "driver":
            upd["deliveryPersonId"] = ""
            upd["deliveryStatus"] = "Office"
            updates_to_save = upd

    saved = patch_entity(collection, entity_id, updates_to_save, str(user.get("id") or "system"))
    audit(str(user.get("id")), "update", collection, entity_id, f"Updated {collection} {entity_id}", {})
    return EntityResponse(**saved)


@app.put("/api/admin/collections/{collection}/{entity_id}/restore", response_model=EntityResponse)
def admin_restore_collection_item(
    collection: str,
    entity_id: str,
    body: AdminRestoreEntityRequest,
    request: Request,
    admin: dict[str, Any] = Depends(require_admin),
):
    """
    Deterministic admin-only restore/replace for a single entity.

    Why this exists:
    - PATCH merges and cannot remove keys => not a perfect restore.
    - POST always sets created_by to the current user => breaks ownership on fresh restores.

    This endpoint lets the backup/restore flow write the record exactly, including:
    createdAt/createdBy/lastModified and deleted flag.
    """
    require_same_origin(request)

    entity_type = sanitize_str(collection)[:40]
    ent_id = sanitize_str(entity_id)[:80]
    if not entity_type or not ent_id:
        raise HTTPException(status_code=400, detail="Invalid entity type/id")

    # Desired metadata (optional, but recommended for perfect restores)
    deleted = bool(body.deleted) if body.deleted is not None else False
    created_at_in = body.createdAt
    last_modified_in = body.lastModified

    created_by_in = None
    if body.createdBy is not None:
        created_by_in = sanitize_str(str(body.createdBy or ""))[:80] or None

    # Sanitize record body
    data = sanitize_json(body.data or {}) or {}
    data["id"] = ent_id

    def _as_int(v: Any) -> Optional[int]:
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    created_at_in_i = _as_int(created_at_in)
    last_modified_in_i = _as_int(last_modified_in)

    with db_conn() as conn:
        existing = (
            conn.execute(
                text(
                    "SELECT deleted, created_at, created_by, last_modified FROM entities WHERE type = :type AND id = :id LIMIT 1"
                ),
                {"type": entity_type, "id": ent_id},
            )
            .mappings()
            .first()
        )

        # Fallback to existing metadata when not provided
        created_at = created_at_in_i if created_at_in_i is not None else (int(existing["created_at"]) if existing else None)
        created_by = created_by_in if body.createdBy is not None else (existing.get("created_by") if existing else None)
        last_modified = last_modified_in_i if last_modified_in_i is not None else (int(existing["last_modified"]) if existing else now_ms())

        # For a *new* record, createdAt is required to keep deterministic backups
        if created_at is None:
            raise HTTPException(status_code=400, detail="createdAt is required for new records during restore")

        # Validate createdBy FK if present
        if created_by is not None:
            ok = (
                conn.execute(
                    text("SELECT id FROM users WHERE id = :id AND deleted = false LIMIT 1"),
                    {"id": str(created_by)},
                )
                .mappings()
                .first()
            )
            if not ok:
                raise HTTPException(status_code=400, detail=f"createdBy user not found: {created_by}")

        # Ensure server truth is consistent with metadata columns
        data["_created"] = int(created_at)
        data["_lastModified"] = int(last_modified)
        data["_deleted"] = bool(deleted)
        if created_by is not None:
            data["createdBy"] = str(created_by)
        else:
            # Remove if present (server will omit createdBy when created_by is NULL)
            data.pop("createdBy", None)

        payload = {
            "type": entity_type,
            "id": ent_id,
            "data_json": json_dumps(data),
            "deleted": bool(deleted),
            "created_at": int(created_at),
            "created_by": str(created_by) if created_by is not None else None,
            "last_modified": int(last_modified),
        }

        if existing:
            conn.execute(
                text(
                    """
                    UPDATE entities
                    SET data_json = :data_json,
                        deleted = :deleted,
                        created_at = :created_at,
                        created_by = :created_by,
                        last_modified = :last_modified
                    WHERE type = :type AND id = :id
                    """
                ),
                payload,
            )
        else:
            conn.execute(
                text(
                    """
                    INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
                    VALUES (:type, :id, :data_json, :deleted, :created_at, :created_by, :last_modified)
                    """
                ),
                payload,
            )

    audit(str(admin.get("id")), "restore", entity_type, ent_id, f"Restored {entity_type} {ent_id}", {})
    return EntityResponse(
        id=ent_id,
        type=entity_type,
        deleted=bool(deleted),
        createdAt=int(created_at),
        createdBy=str(created_by) if created_by is not None else None,
        lastModified=int(last_modified),
        data=data,
    )


@app.delete("/api/collections/{collection}/{entity_id}")
def delete_collection_item(
    collection: str,
    entity_id: str,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    module = _module_for_collection(collection)
    delete_action = _action_for_collection(collection, "delete")
    if not user_has_permission(user, module, delete_action):
        existing = get_entity(collection, entity_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        creator = existing.get("createdBy") or (existing.get("data") or {}).get("createdBy") or (existing.get("data") or {}).get("creatorId")
        if not user_has_permission(user, module, delete_action, record_creator_id=str(creator or "")):
            raise HTTPException(status_code=403, detail="Forbidden")

    soft_delete_entity(collection, entity_id, str(user.get("id") or "system"))
    audit(str(user.get("id")), "delete", collection, entity_id, f"Deleted {collection} {entity_id}", {})
    return {"ok": True}


@app.get("/api/audit")
def list_audit(
    limit: int = 200,
    offset: int = 0,
    user: dict[str, Any] = Depends(current_user),
):
    # Only admins can view global audit logs for now
    if str(user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")

    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    with db_conn() as conn:
        rows = (
            conn.execute(
                text("SELECT * FROM audit_logs ORDER BY ts DESC LIMIT :limit OFFSET :offset"),
                {"limit": limit, "offset": offset},
            )
            .mappings()
            .all()
        )
        rows = [dict(r) for r in rows]
        for r in rows:
            r["metadata"] = json_loads(r.get("metadata_json") or "{}") or {}
            r.pop("metadata_json", None)
        return rows


@app.post("/api/audit/cleanup")
def cleanup_audit_logs(
    days_to_keep: int = 365,
    user: dict[str, Any] = Depends(require_admin),
    request: Request = None,
):
    """
    Delete audit logs older than specified days (default: 1 year).
    Admin-only operation with CSRF protection.
    """
    require_same_origin(request)
    
    days_to_keep = max(30, min(int(days_to_keep), 3650))  # Min 30 days, max 10 years
    cutoff_ts = now_ms() - (days_to_keep * 24 * 60 * 60 * 1000)
    
    with db_conn() as conn:
        # Count logs to be deleted
        count_row = conn.execute(
            text("SELECT COUNT(*) as cnt FROM audit_logs WHERE ts < :cutoff"),
            {"cutoff": cutoff_ts}
        ).mappings().first()
        deleted_count = int(count_row.get("cnt") or 0) if count_row else 0
        
        # Delete old logs
        conn.execute(
            text("DELETE FROM audit_logs WHERE ts < :cutoff"),
            {"cutoff": cutoff_ts}
        )
    
    audit(
        str(user.get("id")),
        "cleanup",
        "audit_logs",
        "bulk",
        f"Cleaned up {deleted_count} audit logs older than {days_to_keep} days",
        {"deleted_count": deleted_count, "days_to_keep": days_to_keep}
    )
    
    return {
        "ok": True,
        "deleted_count": deleted_count,
        "cutoff_days": days_to_keep,
        "cutoff_timestamp": cutoff_ts
    }


@app.get("/api/audit/stats")
def audit_stats(admin: dict[str, Any] = Depends(require_admin)):
    """
    Get audit log statistics (total count, oldest entry, size estimates).
    Admin-only operation.
    """
    with db_conn() as conn:
        stats_row = conn.execute(
            text("""
                SELECT 
                    COUNT(*) as total_count,
                    MIN(ts) as oldest_ts,
                    MAX(ts) as newest_ts
                FROM audit_logs
            """)
        ).mappings().first()
        
        total = int(stats_row.get("total_count") or 0) if stats_row else 0
        oldest = int(stats_row.get("oldest_ts") or 0) if stats_row else 0
        newest = int(stats_row.get("newest_ts") or 0) if stats_row else 0
        
    return {
        "total_count": total,
        "oldest_timestamp": oldest,
        "newest_timestamp": newest,
        "oldest_date": None if oldest == 0 else str(oldest),
        "newest_date": None if newest == 0 else str(newest)
    }


@app.post("/api/deliveries/check-stuck")
def check_stuck_deliveries(
    hours_threshold: int = 72,
    user: dict[str, Any] = Depends(require_admin),
    request: Request = None,
):
    """
    Find deliveries that have been 'In Progress' for more than X hours (default: 72h = 3 days).
    Admin-only operation. Returns stuck delivery receipts for manual review.
    """
    require_same_origin(request)
    
    hours_threshold = max(1, min(int(hours_threshold), 720))  # Min 1 hour, max 30 days
    cutoff_ts = now_ms() - (hours_threshold * 60 * 60 * 1000)
    
    stuck_deliveries = []
    
    with db_conn() as conn:
        # Get receipts with deliveryStatus = 'In Progress'. Production receipts
        # carry inline base64 photos (up to 8MB each), so loading EVERY receipt's
        # data_json to filter in Python could materialize gigabytes and OOM-kill
        # the small ECS task. On Postgres, filter deliveryStatus in SQL so only
        # candidate rows load their data_json. Cap results as a backstop.
        dialect = str(get_engine().dialect.name or "")
        if dialect == "postgresql":
            rows = (
                conn.execute(
                    text("""
                        SELECT id, data_json, created_at, last_modified
                        FROM entities
                        WHERE type = 'receipts' AND deleted = false
                          AND (data_json::jsonb ->> 'deliveryStatus') = 'In Progress'
                        LIMIT 5000
                    """)
                )
                .mappings()
                .all()
            )
        else:
            # SQLite (dev): no JSON operator dependency; bounded scan.
            rows = (
                conn.execute(
                    text("""
                        SELECT id, data_json, created_at, last_modified
                        FROM entities
                        WHERE type = 'receipts' AND deleted = false
                        LIMIT 5000
                    """)
                )
                .mappings()
                .all()
            )
        
        for row in rows:
            data = json_loads(row.get("data_json") or "{}") or {}
            delivery_status = str(data.get("deliveryStatus") or "").strip()
            
            if delivery_status == "In Progress":
                # Check when it was accepted or last modified
                accepted_date = data.get("acceptedDate")
                if accepted_date:
                    try:
                        from datetime import datetime
                        accepted_dt = datetime.fromisoformat(accepted_date.replace('Z', '+00:00'))
                        accepted_ts = int(accepted_dt.timestamp() * 1000)
                    except:
                        accepted_ts = int(row.get("created_at") or 0)
                else:
                    accepted_ts = int(row.get("created_at") or 0)
                
                if accepted_ts < cutoff_ts:
                    stuck_deliveries.append({
                        "id": row.get("id"),
                        "tempReceiptNo": data.get("tempReceiptNo"),
                        "finalReceiptNo": data.get("finalReceiptNo"),
                        "customerId": data.get("customerId"),
                        "deliveryPersonId": data.get("deliveryPersonId"),
                        "acceptedDate": accepted_date,
                        "hoursStuck": int((now_ms() - accepted_ts) / (1000 * 60 * 60)),
                        "amountLocal": data.get("amountLocal"),
                        "amountUSD": data.get("amountUSD")
                    })
    
    return {
        "ok": True,
        "stuck_count": len(stuck_deliveries),
        "hours_threshold": hours_threshold,
        "stuck_deliveries": stuck_deliveries
    }


@app.get("/api/users", response_model=list[UserPublic])
def list_users(admin: dict[str, Any] = Depends(require_admin)):
    with db_conn() as conn:
        rows = (
            conn.execute(text("SELECT * FROM users WHERE deleted = false ORDER BY email ASC"))
            .mappings()
            .all()
        )
        rows = [dict(r) for r in rows]
    return [user_row_to_public(r) for r in rows]


@app.get("/api/users/public")
def list_users_public(user: dict[str, Any] = Depends(current_user)):
    # Minimal user list for UI dropdowns (delivery assignment, etc.)
    with db_conn() as conn:
        rows = (
            conn.execute(text("SELECT id, name, role FROM users WHERE deleted = false ORDER BY name ASC"))
            .mappings()
            .all()
        )
        rows = [dict(r) for r in rows]
    return rows


@app.post("/api/users", response_model=UserPublic)
def create_user(body: CreateUserRequest, request: Request, admin: dict[str, Any] = Depends(require_admin)):
    require_same_origin(request)
    now = now_ms()
    pw = hash_password(body.password, iterations=PBKDF2_ITERATIONS_DEFAULT)

    permissions_json = json_dumps(body.permissions or {})
    user_id = new_id("user")

    try:
        with db_conn() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id, name, email, role, permissions_json,
                      password_hash, password_salt, password_algo, password_iterations,
                      deleted, created_at, created_by, last_modified
                    )
                    VALUES (
                      :id, :name, :email, :role, :permissions_json,
                      :password_hash, :password_salt, :password_algo, :password_iterations,
                      false, :created_at, :created_by, :last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": sanitize_str(body.name),
                    "email": str(body.email).lower(),
                    "role": sanitize_str(body.role),
                    "permissions_json": permissions_json,
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "created_at": now,
                    "created_by": str(admin.get("id")),
                    "last_modified": now,
                },
            )
    except IntegrityError:
        # Duplicate email (unique constraint) — return a clear 409, not a 500.
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    audit(str(admin.get("id")), "create", "users", user_id, f"Created user {body.email}", {})
    created = _get_user_by_id(user_id)
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return user_row_to_public(created)


@app.patch("/api/users/{user_id}", response_model=UserPublic)
def update_user(user_id: str, body: UpdateUserRequest, request: Request, admin: dict[str, Any] = Depends(require_admin)):
    require_same_origin(request)
    user_id = sanitize_str(user_id)[:80]
    now = now_ms()

    existing = _get_user_by_id(user_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")

    # SECURITY: Whitelist allowed fields to prevent SQL injection
    ALLOWED_USER_UPDATE_FIELDS = {
        "name", "email", "role", "permissions_json",
        "password_hash", "password_salt", "password_algo", "password_iterations",
        "deleted", "last_modified"
    }

    update_fields: dict[str, Any] = {}

    if body.name is not None:
        update_fields["name"] = sanitize_str(body.name)
    if body.email is not None:
        update_fields["email"] = str(body.email).lower()
    if body.role is not None:
        update_fields["role"] = sanitize_str(body.role)
    if body.permissions is not None:
        update_fields["permissions_json"] = json_dumps(body.permissions)
    if body.password is not None:
        pw = hash_password(body.password, iterations=PBKDF2_ITERATIONS_DEFAULT)
        update_fields["password_hash"] = pw.hash_hex
        update_fields["password_salt"] = pw.salt_hex
        update_fields["password_algo"] = pw.algo
        update_fields["password_iterations"] = pw.iterations
    if body.deleted is not None:
        update_fields["deleted"] = bool(body.deleted)

    update_fields["last_modified"] = now

    if not update_fields:
        return user_row_to_public(existing)

    # SECURITY: Validate all keys are in whitelist before building SQL
    invalid_fields = [k for k in update_fields.keys() if k not in ALLOWED_USER_UPDATE_FIELDS]
    if invalid_fields:
        raise HTTPException(status_code=400, detail=f"Invalid field(s): {', '.join(invalid_fields)}")

    try:
        with db_conn() as conn:
            # SECURITY: Only use whitelisted fields in SQL construction
            set_clause = ", ".join([f"{k} = :{k}" for k in update_fields.keys() if k in ALLOWED_USER_UPDATE_FIELDS])
            params = {**update_fields, "id": user_id}
            conn.execute(text(f"UPDATE users SET {set_clause} WHERE id = :id"), params)
    except IntegrityError:
        # Changing email to one already used by another user.
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    audit(str(admin.get("id")), "update", "users", user_id, f"Updated user {user_id}", {})
    # Use include-deleted fetch so "delete user" can return a response instead of 404
    # (the regular _get_user_by_id() filters deleted=false).
    updated = _get_user_by_id_any(user_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Not found")
    return user_row_to_public(updated)


# ==========================================
# SPA CATCH-ALL ROUTE (Must be LAST)
# ==========================================
# Serve index.html for all frontend routes (SPA routing)
# This allows URLs like /ads, /receipts, /customers to work
FRONTEND_ROUTES = {
    "/analytics",
    "/ads", 
    "/customers",
    "/receipts",
    "/pages",
    "/users",
    "/audit-logs",
    "/delivery",
    "/receipt-balance",
    "/no-access",
    "/smart-systems",
    "/wallet",
    "/account",
}

@app.get("/{path:path}")
def spa_catch_all(path: str, request: Request):
    """
    Catch-all route for SPA frontend routing.
    Returns index.html for known frontend routes, 404 for unknown paths.
    """
    full_path = f"/{path}"
    
    # Serve index.html for known frontend routes
    if full_path in FRONTEND_ROUTES:
        if not INDEX_PATH.exists():
            raise HTTPException(status_code=500, detail="index.html not found")
        return FileResponse(
            str(INDEX_PATH),
            headers={
                "Cache-Control": "no-store, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )
    
    # Return 404 for unknown paths (not a frontend route and not an API route)
    raise HTTPException(status_code=404, detail="Not found")


