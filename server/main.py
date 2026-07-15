import json
import hashlib
import math
import os
import re
import secrets
import threading
import traceback
import uuid
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

# SQLite doesn't support row-level locking, so we use a threading lock for counter operations
_SQLITE_COUNTER_LOCK = threading.Lock()
# SQLite has no SELECT ... FOR UPDATE.  Serialize read/merge/write entity
# patches in-process; the conditional UPDATE below also detects a writer in a
# different process instead of silently overwriting its newer version.
_SQLITE_ENTITY_PATCH_LOCK = threading.Lock()
# Clothes orders and their product stock must commit as one unit. PostgreSQL
# uses row/advisory locks; SQLite needs a process-wide transaction guard.
_SQLITE_CLOTHES_LOCK = threading.Lock()
# User-role membership must be serialized when enforcing the invariant that
# at least one active Admin always remains.
_SQLITE_ADMIN_MEMBERSHIP_LOCK = threading.Lock()
# Password-reset codes are one-shot capabilities. SQLite needs an in-process
# guard around the conditional claim; PostgreSQL serializes the row update.
_SQLITE_PASSWORD_RESET_LOCK = threading.Lock()
# Wallet balance checks and ledger inserts must be serialized in SQLite too;
# Postgres uses row locks on the participating user records instead.
_SQLITE_WALLET_LOCK = threading.Lock()
# Receipt transfers, ad funding, ad stops and receipt capacity edits share one
# money pool. SQLite has no row locks, so those operations need one guard too.
_SQLITE_FINANCIAL_LOCK = threading.Lock()

# Debug mode: set ALBAYAN_DEBUG_MODE=true to enable debug endpoints
DEBUG_MODE = os.getenv("ALBAYAN_DEBUG_MODE", "").strip().lower() in {"1", "true", "yes"}
# Whole-backup replacement is a maintenance operation. It is disabled on a
# live API unless an operator makes the risk explicit for an offline window.
ENABLE_ONLINE_IMPORT = os.getenv("ALBAYAN_ENABLE_ONLINE_IMPORT", "").strip().lower() in {"1", "true", "yes"}
SETUP_TOKEN = os.getenv("ALBAYAN_SETUP_TOKEN", "")

from .db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from .rbac import VALID_USER_ROLES, normalize_permissions, user_has_permission
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from .schemas import (
    AdminBulkImportRequest,
    AdminRestoreEntityRequest,
    AdMutationRequest,
    AdMutationResponse,
    AdStopRequest,
    AdStopResponse,
    BatchDeleteRequest,
    BootstrapResponse,
    ChangePasswordRequest,
    ClothesOrderMutationRequest,
    ClothesOrderMutationResponse,
    ClothesShipmentMutationRequest,
    ClothesShipmentMutationResponse,
    CreateUserRequest,
    EntityCreateRequest,
    EntityResponse,
    EntityUpdateRequest,
    LoginRequest,
    LoginResponse,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    ReceiptTransferRequest,
    ReceiptTransferResponse,
    SetupAdminRequest,
    SubscriptionPurchaseRequest,
    UpdateUserRequest,
    UserPublic,
    WalletReversalRequest,
    WalletTopUpRequest,
    WalletTransferRequest,
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


# Auto-serial prefixes issued by the app for payment methods that come with no
# provider receipt (must mirror AUTO_SERIAL_GROUPS in src/14-forms.js):
#   S = LTT / Libyana / Madar   B = Bank Transfer (LYD|USD)
#   O = Transfer Office         E = Sadad / USDT
AUTO_SERIAL_PREFIXES = ("S", "B", "O", "E")


def _is_valid_serial_number(serial: str) -> bool:
    """
    Check if a serial number is valid.
    Valid formats:
    - Regular: digits only, no leading zeros (1, 123, 456, etc.)
    - Auto-serial: prefix + digits, no leading zeros (S1, B2, O3, E4, ...)
    """
    serial = str(serial or "").strip()
    if not serial:
        return False
    # Prefixed auto-serial (S1, B2, O3, E4...)
    if len(serial) > 1 and serial[0].upper() in AUTO_SERIAL_PREFIXES:
        rest = serial[1:]
        return rest.isdigit() and not rest.startswith("0")
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
# Forwarded client-IP headers are trustworthy only when every request reaches
# us through a configured proxy that overwrites them. Direct deployments must
# default to the socket peer address so clients cannot rotate limiter buckets.
TRUST_PROXY_HEADERS = os.getenv("ALBAYAN_TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes"}
# ALB health checks can't send custom headers, so this path must remain reachable.
ORIGIN_BYPASS_PATH_PREFIXES = ("/api/health",)

# Rate limiting configuration (supports both in-memory and Redis)
# SECURITY: Rate limit login attempts to prevent brute force attacks
# Default: 20 attempts per 15 minutes per IP+email (increased from 10 for better UX on flaky networks)
_LOGIN_WINDOW_MS = int(os.getenv("ALBAYAN_LOGIN_WINDOW_MS", str(15 * 60 * 1000)))
_LOGIN_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_MAX_ATTEMPTS", "20"))
# IP-independent per-account cap (defense against IP rotation). Higher than the
# per-IP cap so a shared office IP with a few users' honest mistakes never trips
# it, but far below what brute-forcing a password would need.
_LOGIN_EMAIL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_EMAIL_MAX_ATTEMPTS", "60"))

PASSWORD_RESET_TOKEN_MS = int(os.getenv("ALBAYAN_PASSWORD_RESET_TOKEN_MS", str(15 * 60 * 1000)))
PASSWORD_RESET_DEV_RETURN_CODE = os.getenv("ALBAYAN_DEV_PASSWORD_RESET_RETURN_CODE", "").strip().lower() in {"1", "true", "yes"}

_RESET_WINDOW_MS = int(os.getenv("ALBAYAN_RESET_WINDOW_MS", str(15 * 60 * 1000)))
_RESET_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_MAX_ATTEMPTS", "5"))
_RESET_EMAIL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_EMAIL_MAX_ATTEMPTS", "15"))
_SETUP_WINDOW_MS = int(os.getenv("ALBAYAN_SETUP_WINDOW_MS", str(15 * 60 * 1000)))
_SETUP_IP_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_SETUP_IP_MAX_ATTEMPTS", "10"))
_SETUP_GLOBAL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_SETUP_GLOBAL_MAX_ATTEMPTS", "100"))


def _client_ip(request: Request) -> str:
    """Real client IP for rate limiting, behind Cloudflare + ALB.

    SECURITY: the old version returned the LEFTMOST X-Forwarded-For entry, which
    is fully client-controlled — proxies APPEND, so a client-supplied
    `X-Forwarded-For: <random>` survives as element [0]. An attacker could then
    rotate that value each request and get a fresh (ip,email) rate-limit bucket,
    bypassing brute-force protection entirely. We now prefer Cloudflare's
    CF-Connecting-IP (Cloudflare overwrites any client-supplied value at its
    edge), and for the XFF fallback we take the RIGHTMOST entry (added by the
    closest trusted proxy) which a client cannot forge, rather than the spoofable
    leftmost one.
    """
    if TRUST_PROXY_HEADERS:
        try:
            cf = request.headers.get("cf-connecting-ip")
            if cf and cf.strip():
                return cf.strip()
            xff = request.headers.get("x-forwarded-for")
            if xff:
                parts = [p.strip() for p in xff.split(",") if p.strip()]
                if parts:
                    return parts[-1]
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

    # Defense in depth: an IP-independent per-account bucket. Even if an
    # attacker rotates IPs (or a forged proxy header) to dodge the (ip,email)
    # bucket above, a single account still can't be guessed more than
    # _LOGIN_EMAIL_MAX_ATTEMPTS times per window. Set high enough not to lock
    # out a legitimate user's honest mistakes across a shared office IP.
    email_key = f"login:email:{email.lower()}"
    ok2, _left2, retry2 = check_rate_limit(email_key, _LOGIN_EMAIL_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)
    if not ok2:
        return False, int(retry2 or 0)

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

    # IP-independent per-account bucket (see _rate_check) so IP rotation can't
    # grant unlimited reset requests against one email.
    email_key = f"reset:email:{email.lower()}"
    ok2, _left2, retry2 = check_rate_limit(email_key, _RESET_EMAIL_MAX_ATTEMPTS, _RESET_WINDOW_MS)
    if not ok2:
        return False, int(retry2 or 0)

    return True, 0


def _reset_confirm_rate_check(request: Request, token_hash: str) -> tuple[bool, int]:
    """Limit confirms by peer IP and one-way token hash, never a global key."""
    from .rate_limiter import check_rate_limit

    ip_key = f"reset-confirm:ip:{_client_ip(request)}"
    allowed, _left, retry = check_rate_limit(
        ip_key, _RESET_EMAIL_MAX_ATTEMPTS, _RESET_WINDOW_MS
    )
    if not allowed:
        return False, int(retry or 0)
    token_key = f"reset-confirm:token:{token_hash}"
    allowed, _left, retry = check_rate_limit(
        token_key, _RESET_MAX_ATTEMPTS, _RESET_WINDOW_MS
    )
    return bool(allowed), 0 if allowed else int(retry or 0)


def _setup_rate_check(request: Request) -> tuple[bool, int]:
    """Dedicated bootstrap limiter; never consumes login/account buckets."""
    from .rate_limiter import check_rate_limit

    allowed, _left, retry = check_rate_limit(
        f"setup:ip:{_client_ip(request)}", _SETUP_IP_MAX_ATTEMPTS, _SETUP_WINDOW_MS
    )
    if not allowed:
        return False, int(retry or 0)
    allowed, _left, retry = check_rate_limit(
        "setup:global", _SETUP_GLOBAL_MAX_ATTEMPTS, _SETUP_WINDOW_MS
    )
    return bool(allowed), 0 if allowed else int(retry or 0)


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


SAFE_ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")

# These are relationship identifiers consumed by current business flows and
# must match the browser validator in src/02-security.js.  Deliberately do not
# validate every nested key named ``id``: passkeys[].id, for example, is an
# opaque WebAuthn credential and is not a database record identifier.
RELATIONSHIP_ID_FIELDS = {
    "adId",
    "customerId",
    "creatorId",
    "deliveryPersonId",
    "driverId",
    "fromUserId",
    "fundingReceiptId",
    "linkedDeliveryReceiptId",
    "linkedReceiptId",
    "orderId",
    "pageId",
    "paymentTxId",
    "productId",
    "receiptId",
    "referenceId",
    "resourceId",
    "serviceId",
    "shipmentId",
    "targetCustomerId",
    "targetUserId",
    "toCustomerId",
    "toReceiptId",
    "toUserId",
    "transactionId",
    "transferFromCustomerId",
    "transferFromReceiptId",
    "userId",
}
RELATIONSHIP_ID_LIST_FIELDS = {
    "adReceiptIds",
    "customerIds",
    "linkedCustomerIds",
    "receiptIds",
}


def validate_entity_id(value: Any) -> str:
    """Reject unsafe IDs exactly as supplied; never sanitize/rewrite them."""
    raw = str(value or "")
    if not SAFE_ENTITY_ID_RE.fullmatch(raw):
        raise HTTPException(
            status_code=400,
            detail="Invalid entity id (use 1-80 letters, numbers, dot, underscore, colon or hyphen)",
        )
    return raw


def validate_relationship_ids(value: Any, path: str = "data", depth: int = 0) -> None:
    """Reject unsafe known relationship IDs without rewriting stored links."""
    if depth > 12 or value is None:
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            validate_relationship_ids(child, f"{path}[{index}]", depth + 1)
        return
    if not isinstance(value, dict):
        return

    for key, child in value.items():
        child_path = f"{path}.{key}"
        if key in RELATIONSHIP_ID_FIELDS:
            blank = child is None or (isinstance(child, str) and child.strip() == "")
            if not blank and (not isinstance(child, str) or not SAFE_ENTITY_ID_RE.fullmatch(child)):
                raise HTTPException(status_code=400, detail=f"Unsafe relationship identifier at {child_path}")
        elif key in RELATIONSHIP_ID_LIST_FIELDS and child is not None:
            if not isinstance(child, list):
                raise HTTPException(status_code=400, detail=f"Invalid relationship identifier list at {child_path}")
            for index, item in enumerate(child):
                if not isinstance(item, str) or not SAFE_ENTITY_ID_RE.fullmatch(item):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Unsafe relationship identifier at {child_path}[{index}]",
                    )

        if isinstance(child, (dict, list)):
            validate_relationship_ids(child, child_path, depth + 1)


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
    personal_user_id: str | None = None,
    referenced_customer_by: str | None = None,
    id_in: list[str] | None = None,
    before_created_at: int | None = None,
    before_id: str | None = None,
    after_last_modified: int | None = None,
    after_id: str | None = None,
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
    if assigned_to is not None:
        assigned_to = sanitize_str(str(assigned_to))[:80] or None
    if personal_user_id is not None:
        personal_user_id = sanitize_str(str(personal_user_id))[:80] or None
    if referenced_customer_by is not None:
        referenced_customer_by = sanitize_str(str(referenced_customer_by))[:80] or None

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
    if before_created_at is not None and before_id is not None:
        where.append(
            "(created_at < :before_created_at OR "
            "(created_at = :before_created_at AND id < :before_id))"
        )
        params["before_created_at"] = int(before_created_at)
        params["before_id"] = validate_entity_id(before_id)
        offset = 0
    if after_last_modified is not None and after_id is not None:
        where.append(
            "(last_modified > :after_last_modified OR "
            "(last_modified = :after_last_modified AND id > :after_id))"
        )
        params["after_last_modified"] = int(after_last_modified)
        params["after_id"] = validate_entity_id(after_id)
        offset = 0
    if created_by is not None:
        where.append("created_by = :created_by")
        params["created_by"] = created_by

    if assigned_to:
        json_delivery = (
            "(data_json::jsonb ->> 'deliveryPersonId')"
            if dialect == "postgresql"
            else "json_extract(data_json, '$.deliveryPersonId')"
        )
        where.append(f"{json_delivery} = :delivery_person_id")
        params["delivery_person_id"] = assigned_to

    if personal_user_id:
        if dialect == "postgresql":
            json_value = lambda key: f"(data_json::jsonb ->> '{key}')"
        else:
            json_value = lambda key: f"json_extract(data_json, '$.{key}')"
        if entity_type == "walletTransactions":
            where.append(
                f"({json_value('fromUserId')}=:personal_uid OR "
                f"{json_value('toUserId')}=:personal_uid)"
            )
        else:
            where.append(f"{json_value('userId')}=:personal_uid")
        params["personal_uid"] = personal_user_id

    if referenced_customer_by:
        if dialect == "postgresql":
            customer_expr = "(d.data_json::jsonb ->> 'customerId')"
            assigned_expr = "(d.data_json::jsonb ->> 'deliveryPersonId')"
        else:
            customer_expr = "json_extract(d.data_json, '$.customerId')"
            assigned_expr = "json_extract(d.data_json, '$.deliveryPersonId')"
        where.append(
            "EXISTS (SELECT 1 FROM entities d "
            "WHERE d.type IN ('ads','receipts') AND d.deleted=false "
            f"AND {customer_expr}=entities.id "
            f"AND {assigned_expr}=:referenced_delivery_uid)"
        )
        params["referenced_delivery_uid"] = referenced_customer_by

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
    order_by = "last_modified ASC, id ASC" if updated_since is not None else "created_at DESC, id DESC"
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
    entity_id = validate_entity_id(entity_id)
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


def patch_entity(
    entity_type: str,
    entity_id: str,
    updates: dict[str, Any],
    user_id: str,
    *,
    expected_last_modified: int | None = None,
) -> dict[str, Any]:
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
    entity_type = sanitize_str(entity_type)[:40]
    entity_id = validate_entity_id(entity_id)
    if not entity_type:
        raise HTTPException(status_code=400, detail="Invalid entity type")

    upd = sanitize_json(updates)
    if not isinstance(upd, dict):
        raise HTTPException(status_code=400, detail="Invalid update data")
    # Protected keys
    for k in ["id", "_created", "_lastModified", "createdBy", "createdAt", "creatorId"]:
        if k in upd:
            del upd[k]

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_ENTITY_PATCH_LOCK
    with guard:
        with db_conn() as conn:
            lock_suffix = " FOR UPDATE" if postgres else ""
            row = conn.execute(
                text(
                    "SELECT type, id, data_json, deleted, created_at, created_by, last_modified "
                    "FROM entities WHERE type=:type AND id=:id LIMIT 1" + lock_suffix
                ),
                {"type": entity_type, "id": entity_id},
            ).mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Not found")

            baseline = int(row["last_modified"])
            if expected_last_modified is not None and baseline != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: record has changed")

            data = json_loads(row["data_json"]) or {}
            if not isinstance(data, dict):
                data = {}
            data.update(upd)
            modified = max(now_ms(), baseline + 1)
            data["id"] = entity_id
            data["_created"] = data.get("_created") or int(row["created_at"])
            data["_lastModified"] = modified
            if row.get("created_by") is not None:
                data["createdBy"] = str(row["created_by"])
            else:
                data.pop("createdBy", None)

            try:
                result = conn.execute(
                    text(
                        "UPDATE entities SET data_json=:data_json, last_modified=:modified "
                        "WHERE type=:type AND id=:id AND last_modified=:baseline"
                    ),
                    {
                        "data_json": json_dumps(data),
                        "modified": modified,
                        "type": entity_type,
                        "id": entity_id,
                        "baseline": baseline,
                    },
                )
            except IntegrityError:
                raise HTTPException(status_code=409, detail="Receipt number already exists")
            if result.rowcount != 1:
                raise HTTPException(status_code=409, detail="Conflict: record has changed")

            return {
                "id": entity_id,
                "type": entity_type,
                "deleted": bool(row["deleted"]),
                "createdAt": int(row["created_at"]),
                "createdBy": row.get("created_by"),
                "lastModified": modified,
                "data": data,
            }


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
    login_email = str(payload.email).lower()
    reset_rate_limit(f"login:{_rate_key(request, login_email)}")
    reset_rate_limit(f"login:email:{login_email}")
    
    audit(user["id"], "login", "auth", user["id"], f"User {user['email']} logged in", {})
    return resp


@app.get("/api/auth/needs-setup")
def needs_setup(request: Request):
    """Public: does this server still need its first admin?

    Lets the login page show a 'create first admin' option up-front instead
    of only after a failed login. Reveals no more than the login 503 already
    does (whether the server is initialized) — never any user data."""
    with db_conn() as conn:
        n = conn.execute(text("SELECT COUNT(*) FROM users WHERE deleted = false")).scalar()
    setup_enabled = len(SETUP_TOKEN) >= 16
    return {
        "needsSetup": int(n or 0) == 0 and setup_enabled,
        "setupEnabled": setup_enabled,
    }


@app.post("/api/auth/setup-admin", response_model=LoginResponse)
def setup_admin(payload: SetupAdminRequest, request: Request):
    """Create the FIRST admin from the browser and log them in.

    Guarded so it is a one-time bootstrap only: if any non-deleted user
    already exists, it returns 409 and does nothing. This lets a fresh
    server be initialized without shell access, replacing the
    `python -m server.create_admin` step, while never becoming a way to
    add admins after the first one.
    """
    require_same_origin(request)

    # Cheap already-initialized guard first: after bootstrap this endpoint is
    # permanently inert and does not consume any rate-limit bucket.
    with db_conn() as conn:
        existing_count = conn.execute(
            text("SELECT COUNT(*) FROM users WHERE deleted = false")
        ).scalar()
    if int(existing_count or 0) > 0:
        raise HTTPException(status_code=409, detail="Server already initialized. Use normal login.")

    # Browser setup is disabled unless the operator supplied a strong one-time
    # secret out of band. Fresh deployments can always use create_admin or the
    # bootstrap environment variables instead.
    if len(SETUP_TOKEN) < 16:
        raise HTTPException(
            status_code=503,
            detail="Browser setup is disabled. Configure ALBAYAN_SETUP_TOKEN or use the admin CLI.",
        )

    allowed, wait_ms = _setup_rate_check(request)
    if not allowed:
        wait_seconds = max(1, int(wait_ms / 1000))
        raise HTTPException(
            status_code=429,
            detail="Too many setup attempts. Please wait and try again.",
            headers={"Retry-After": str(wait_seconds)},
        )
    submitted_token = str(payload.setupToken or "")
    if not secrets.compare_digest(submitted_token.encode("utf-8"), SETUP_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Invalid setup token")

    email = str(payload.email).strip().lower()
    name = (payload.name or "").strip() or "Admin"
    password = payload.password or ""
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    now = now_ms()
    user_id = new_id("user")

    with db_conn() as conn:
        # Cheap already-initialized guard FIRST — return 409 before spending any
        # CPU on PBKDF2 so a flood against an initialized server stays cheap.
        existing = conn.execute(
            text("SELECT COUNT(*) FROM users WHERE deleted = false")
        ).scalar()
        if int(existing or 0) > 0:
            raise HTTPException(status_code=409, detail="Server already initialized. Use normal login.")

        # Atomic one-time guard against a TOCTOU race: two concurrent bootstraps
        # (different emails) could both pass the COUNT above under READ COMMITTED
        # and both insert an admin. A fixed-PK sentinel row makes them collide —
        # only one INSERT wins; the loser gets IntegrityError -> 409 and its whole
        # transaction (admin included) rolls back. Works on Postgres and SQLite.
        try:
            conn.execute(
                text(
                    "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                    "VALUES ('_bootstrap', 'singleton', '{}', false, :now, NULL, :now)"
                ),
                {"now": now},
            )
        except IntegrityError:
            raise HTTPException(status_code=409, detail="Server already initialized. Use normal login.")

        # We are the sole bootstrapper — safe to spend the KDF cost now.
        pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
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
                "name": name,
                "email": email,
                "permissions_json": json_dumps({}),  # Admin gets all permissions server-side
                "password_hash": pw.hash_hex,
                "password_salt": pw.salt_hex,
                "password_algo": pw.algo,
                "password_iterations": pw.iterations,
                "created_at": now,
                "created_by": user_id,
                "last_modified": now,
            },
        )

    user = _get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=500, detail="Admin creation failed")

    session_id, token = _create_session(user["id"], request)
    cookie_val = new_session_cookie_value(session_id, token)
    resp = JSONResponse(content=LoginResponse(user=user_row_to_public(user)).model_dump())
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
    audit(user["id"], "setup_admin", "auth", user["id"], f"First admin {email} created via setup", {})
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
    if DEBUG_MODE and PASSWORD_RESET_DEV_RETURN_CODE:
        resp["resetCode"] = token
    return resp


@app.post("/api/auth/password-reset/confirm")
def password_reset_confirm(body: PasswordResetConfirmRequest, request: Request):
    require_same_origin(request)

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
    # Confirm attempts are isolated by peer IP and the one-way token hash.
    # Never feed a pseudo-email into _reset_rate_check: that creates one global
    # account bucket an attacker can exhaust for every user.
    allowed, wait_ms = _reset_confirm_rate_check(request, token_hash)
    if not allowed:
        raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {int(wait_ms/1000)}s")
    now = now_ms()
    # Reject random well-formed tokens before paying the deliberately expensive
    # PBKDF2 cost. This is only a cheap capability lookup (the response remains
    # the same generic 400); the conditional claim below is still the atomic
    # source of truth if two valid confirms race.
    with db_conn() as conn:
        plausible = conn.execute(
            text(
                "SELECT 1 FROM password_resets WHERE token_hash=:token_hash "
                "AND used_at IS NULL AND expires_at>:now LIMIT 1"
            ),
            {"token_hash": token_hash, "now": now},
        ).first()
    if not plausible:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    # PBKDF2 is deliberately expensive. Do it before taking the database lock,
    # then atomically claim the one-shot token and change the password in the
    # same transaction. The conditional UPDATE guarantees exactly one winner.
    pw = hash_password(body.newPassword, iterations=PBKDF2_ITERATIONS_DEFAULT)
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_PASSWORD_RESET_LOCK

    with guard:
        with db_conn() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id, user_id FROM password_resets "
                        "WHERE token_hash=:token_hash LIMIT 1"
                    ),
                    {"token_hash": token_hash},
                )
                .mappings()
                .first()
            )
            if not row:
                raise HTTPException(status_code=400, detail="Invalid or expired reset code")

            claimed = conn.execute(
                text(
                    "UPDATE password_resets SET used_at=:used_at "
                    "WHERE id=:id AND used_at IS NULL AND expires_at>:now"
                ),
                {"used_at": now, "now": now, "id": row["id"]},
            )
            if claimed.rowcount != 1:
                raise HTTPException(status_code=400, detail="Invalid or expired reset code")

            user_id = str(row.get("user_id"))
            updated = conn.execute(
                text(
                    """
                    UPDATE users
                    SET password_hash = :password_hash,
                        password_salt = :password_salt,
                        password_algo = :password_algo,
                        password_iterations = :password_iterations,
                        last_modified = :last_modified
                    WHERE id = :id AND deleted=false
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
            if updated.rowcount != 1:
                raise HTTPException(status_code=400, detail="Invalid or expired reset code")
            conn.execute(
                text("DELETE FROM sessions WHERE user_id = :user_id"),
                {"user_id": user_id},
            )

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


# Per-user money records. There is NO grantable permission module for these
# (they never appear in the frontend's PERMISSION_MODULES), so a module-based
# check would 403 every non-admin forever — even one holding all permissions.
# Instead, non-admins get ownership-scoped access to their own rows.
PERSONAL_SCOPED_COLLECTIONS = {"walletTransactions", "serviceSubscriptions"}

WALLET_CURRENCIES = frozenset({"LYD", "USD", "EUR"})
MAX_WALLET_AMOUNT_MINOR = 1_000_000_000_000

# Server-owned subscription catalog.  Client-supplied price, currency, expiry,
# and duration are deliberately ignored.  Current UI offers are free; changing
# a service to paid must happen here (or in a future catalog table), never in a
# browser bundle.
SERVICE_SUBSCRIPTION_CATALOG: dict[str, dict[str, Any]] = {
    "international_shipping": {"priceMinor": 0, "currency": "LYD", "durationDays": 30},
    "local_shipping": {"priceMinor": 0, "currency": "LYD", "durationDays": 30},
    "warehouse": {"priceMinor": 0, "currency": "LYD", "durationDays": 30},
    "smart_systems": {"priceMinor": 0, "currency": "LYD", "durationDays": 30},
    "clothes_system": {"priceMinor": 0, "currency": "LYD", "durationDays": 30},
}


def _iso_utc(dt: datetime | None = None) -> str:
    return (dt or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _entity_from_db_row(row: Any) -> dict[str, Any]:
    d = dict(row)
    return {
        "id": str(d["id"]),
        "type": str(d["type"]),
        "deleted": bool(d["deleted"]),
        "createdAt": int(d["created_at"]),
        "createdBy": d.get("created_by"),
        "lastModified": int(d["last_modified"]),
        "data": json_loads(d.get("data_json") or "{}") or {},
    }


def _insert_entity_in_transaction(
    conn: Any,
    collection: str,
    entity_id: str | None,
    data: dict[str, Any],
    created_by: str,
) -> dict[str, Any]:
    """Insert one entity using an already-open transaction."""
    collection = sanitize_str(str(collection or ""))[:40]
    entity_id = validate_entity_id(entity_id or new_id(collection[:10] or "id"))
    if not collection or not entity_id:
        raise HTTPException(status_code=400, detail="Invalid entity id/type")
    existing = conn.execute(
        text("SELECT id FROM entities WHERE type = :type AND id = :id LIMIT 1"),
        {"type": collection, "id": entity_id},
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="ID already exists")

    now = now_ms()
    clean = sanitize_json(data or {}) or {}
    clean["id"] = entity_id
    clean["_created"] = now
    clean["_lastModified"] = now
    clean["_deleted"] = False
    clean["createdBy"] = created_by
    conn.execute(
        text(
            """
            INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified)
            VALUES (:type, :id, :data_json, false, :created_at, :created_by, :last_modified)
            """
        ),
        {
            "type": collection,
            "id": entity_id,
            "data_json": json_dumps(clean),
            "created_at": now,
            "created_by": created_by,
            "last_modified": now,
        },
    )
    return {
        "id": entity_id,
        "type": collection,
        "deleted": False,
        "createdAt": now,
        "createdBy": created_by,
        "lastModified": now,
        "data": clean,
    }


def _find_entity_by_idempotency(conn: Any, collection: str, key: str) -> dict[str, Any] | None:
    rows = conn.execute(
        text("SELECT * FROM entities WHERE type = :type AND deleted = false"),
        {"type": collection},
    ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("idempotencyKey") or "") == key:
            return _entity_from_db_row(row)
    return None


def _wallet_amount_minor(data: dict[str, Any]) -> int:
    try:
        amount = int(data.get("amountMinor"))
    except (TypeError, ValueError, OverflowError):
        try:
            amount = round(float(data.get("amount")) * 100)
        except (TypeError, ValueError, OverflowError):
            return 0
    return amount if amount > 0 else 0


def _wallet_balance_minor(conn: Any, user_id: str, currency: str) -> int:
    balance = 0
    rows = conn.execute(
        text("SELECT data_json FROM entities WHERE type = 'walletTransactions' AND deleted = false")
    ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("currency") or "").upper() != currency:
            continue
        amount = _wallet_amount_minor(data)
        if str(data.get("toUserId") or "") == user_id:
            balance += amount
        if str(data.get("fromUserId") or "") == user_id:
            balance -= amount
    return balance


def _lock_and_validate_wallet_users(conn: Any, user_ids: list[str], *, postgres: bool) -> None:
    """Validate active wallet participants and lock them in stable order."""
    for uid in sorted({sanitize_str(str(x or ""))[:80] for x in user_ids if x and x != "system"}):
        suffix = " FOR UPDATE" if postgres else ""
        row = conn.execute(
            text(f"SELECT id FROM users WHERE id = :id AND deleted = false{suffix}"),
            {"id": uid},
        ).first()
        if not row:
            raise HTTPException(status_code=404, detail=f"Wallet user not found: {uid}")


def _lock_idempotency_key(conn: Any, key: str, *, postgres: bool, namespace: str = "wallet") -> None:
    """Serialize equal idempotency keys, including across different users."""
    if not postgres:
        # Every SQLite money operation already holds _SQLITE_WALLET_LOCK.
        return
    conn.execute(
        text(
            "SELECT pg_advisory_xact_lock("
            "hashtextextended(CAST(:key AS text), 0)"
            ")"
        ),
        {"key": f"{namespace}:{key}"},
    )


def _validate_wallet_values(amount_minor: Any, currency: Any, idempotency_key: Any) -> tuple[int, str, str]:
    if isinstance(amount_minor, bool):
        raise HTTPException(status_code=400, detail="amountMinor must be an integer")
    if isinstance(amount_minor, float) and not amount_minor.is_integer():
        raise HTTPException(status_code=400, detail="amountMinor must be an integer")
    try:
        amount = int(amount_minor)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(status_code=400, detail="amountMinor must be an integer")
    if amount <= 0 or amount > MAX_WALLET_AMOUNT_MINOR:
        raise HTTPException(status_code=400, detail="Invalid amountMinor")
    cur = sanitize_str(str(currency or "")).upper()[:3]
    if cur not in WALLET_CURRENCIES:
        raise HTTPException(status_code=400, detail="Unsupported wallet currency")
    idem = sanitize_str(str(idempotency_key or ""))[:120]
    if len(idem) < 8:
        raise HTTPException(status_code=400, detail="idempotencyKey is required (minimum 8 characters)")
    return amount, cur, idem


def _wallet_transfer_atomic(
    actor: dict[str, Any],
    *,
    to_user_id: str,
    amount_minor: Any,
    currency: Any,
    idempotency_key: Any,
    memo: Any = None,
    requested_id: str | None = None,
) -> tuple[dict[str, Any], bool]:
    from_uid = sanitize_str(str(actor.get("id") or ""))[:80]
    to_uid = sanitize_str(str(to_user_id or ""))[:80]
    amount, cur, idem = _validate_wallet_values(amount_minor, currency, idempotency_key)
    if not from_uid or not to_uid:
        raise HTTPException(status_code=400, detail="Missing wallet participant")
    if to_uid == "system":
        raise HTTPException(status_code=403, detail="Transfers to the system account require a server operation")
    if from_uid == to_uid:
        raise HTTPException(status_code=400, detail="Cannot transfer to self")

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_WALLET_LOCK
    with guard:
        with db_conn() as conn:
            _lock_and_validate_wallet_users(conn, [from_uid, to_uid], postgres=postgres)
            _lock_idempotency_key(conn, idem, postgres=postgres)
            prior = _find_entity_by_idempotency(conn, "walletTransactions", idem)
            if prior:
                d = prior.get("data") or {}
                same = (
                    str(d.get("type") or "") == "transfer"
                    and str(d.get("fromUserId") or "") == from_uid
                    and str(d.get("toUserId") or "") == to_uid
                    and str(d.get("currency") or "") == cur
                    and _wallet_amount_minor(d) == amount
                )
                if not same:
                    raise HTTPException(status_code=409, detail="Idempotency key was already used for another operation")
                return prior, False
            if _wallet_balance_minor(conn, from_uid, cur) < amount:
                raise HTTPException(status_code=409, detail="Insufficient wallet balance")
            data = {
                "type": "transfer",
                "schemaVersion": 2,
                "amountMinor": amount,
                "amount": amount / 100,
                "currency": cur,
                "fromUserId": from_uid,
                "toUserId": to_uid,
                "memo": sanitize_str(str(memo or "Transfer"))[:180],
                "idempotencyKey": idem,
                "status": "posted",
                "createdAt": _iso_utc(),
            }
            return _insert_entity_in_transaction(
                conn, "walletTransactions", requested_id, data, from_uid
            ), True


def _wallet_top_up_atomic(
    admin: dict[str, Any],
    *,
    user_id: str,
    amount_minor: Any,
    currency: Any,
    idempotency_key: Any,
    memo: Any = None,
    requested_id: str | None = None,
) -> tuple[dict[str, Any], bool]:
    if str(admin.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    uid = sanitize_str(str(user_id or ""))[:80]
    amount, cur, idem = _validate_wallet_values(amount_minor, currency, idempotency_key)
    if not uid or uid == "system":
        raise HTTPException(status_code=400, detail="Invalid top-up recipient")

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_WALLET_LOCK
    with guard:
        with db_conn() as conn:
            _lock_and_validate_wallet_users(conn, [uid], postgres=postgres)
            _lock_idempotency_key(conn, idem, postgres=postgres)
            prior = _find_entity_by_idempotency(conn, "walletTransactions", idem)
            if prior:
                d = prior.get("data") or {}
                same = (
                    str(d.get("type") or "") == "credit"
                    and not d.get("fromUserId")
                    and str(d.get("toUserId") or "") == uid
                    and str(d.get("currency") or "") == cur
                    and _wallet_amount_minor(d) == amount
                )
                if not same:
                    raise HTTPException(status_code=409, detail="Idempotency key was already used for another operation")
                return prior, False
            data = {
                "type": "credit",
                "schemaVersion": 2,
                "amountMinor": amount,
                "amount": amount / 100,
                "currency": cur,
                "fromUserId": None,
                "toUserId": uid,
                "memo": sanitize_str(str(memo or "Top-up"))[:180],
                "idempotencyKey": idem,
                "status": "posted",
                "createdAt": _iso_utc(),
            }
            return _insert_entity_in_transaction(
                conn, "walletTransactions", requested_id, data, str(admin.get("id") or "system")
            ), True


def _wallet_reversal_atomic(
    admin: dict[str, Any], transaction_id: str, memo: Any = None
) -> tuple[dict[str, Any], bool]:
    if str(admin.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    tx_id = sanitize_str(str(transaction_id or ""))[:80]
    if not tx_id:
        raise HTTPException(status_code=400, detail="Missing transactionId")
    idem = f"rev:{tx_id}"
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_WALLET_LOCK
    with guard:
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT * FROM entities WHERE type = 'walletTransactions' "
                    "AND id = :id AND deleted = false LIMIT 1"
                ),
                {"id": tx_id},
            ).mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Wallet transaction not found")
            original = _entity_from_db_row(row)
            od = original.get("data") or {}
            if str(od.get("type") or "") == "reversal":
                raise HTTPException(status_code=400, detail="A reversal cannot itself be reversed")
            from_uid = sanitize_str(str(od.get("toUserId") or "system"))[:80] or "system"
            to_uid = sanitize_str(str(od.get("fromUserId") or "system"))[:80] or "system"
            _lock_and_validate_wallet_users(conn, [from_uid, to_uid], postgres=postgres)
            _lock_idempotency_key(conn, idem, postgres=postgres)
            prior = _find_entity_by_idempotency(conn, "walletTransactions", idem)
            if prior:
                return prior, False
            amount = _wallet_amount_minor(od)
            cur = sanitize_str(str(od.get("currency") or "")).upper()[:3]
            if amount <= 0 or cur not in WALLET_CURRENCIES:
                raise HTTPException(status_code=400, detail="Original wallet transaction is invalid")
            data = {
                "type": "reversal",
                "schemaVersion": 2,
                "amountMinor": amount,
                "amount": amount / 100,
                "currency": cur,
                "fromUserId": from_uid,
                "toUserId": to_uid,
                "memo": sanitize_str(str(memo or f"Reversal of {tx_id}"))[:180],
                "idempotencyKey": idem,
                "status": "posted",
                "referenceType": "reversalOf",
                "referenceId": tx_id,
                "createdAt": _iso_utc(),
            }
            return _insert_entity_in_transaction(
                conn, "walletTransactions", None, data, str(admin.get("id") or "system")
            ), True


def _parse_subscription_expiry(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _subscription_purchase_atomic(
    actor: dict[str, Any],
    *,
    service_id: str,
    idempotency_key: str,
    user_id: str | None = None,
    requested_id: str | None = None,
) -> tuple[dict[str, Any], bool, dict[str, Any] | None]:
    actor_uid = sanitize_str(str(actor.get("id") or ""))[:80]
    target_uid = sanitize_str(str(user_id or actor_uid))[:80]
    if not actor_uid or not target_uid:
        raise HTTPException(status_code=400, detail="Missing subscription user")
    if target_uid != actor_uid and str(actor.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Cannot subscribe another user")
    sid = sanitize_str(str(service_id or ""))[:80]
    offer = SERVICE_SUBSCRIPTION_CATALOG.get(sid)
    if not offer:
        raise HTTPException(status_code=400, detail="Service is not available for subscription")
    idem = sanitize_str(str(idempotency_key or ""))[:120]
    if len(idem) < 8:
        raise HTTPException(status_code=400, detail="idempotencyKey is required (minimum 8 characters)")
    amount, cur, _ = _validate_wallet_values(
        max(1, int(offer.get("priceMinor") or 0)), offer.get("currency"), idem
    )
    price_minor = int(offer.get("priceMinor") or 0)
    if price_minor < 0:
        raise HTTPException(status_code=500, detail="Invalid server service price")
    # _validate_wallet_values requires a positive amount, so restore the
    # catalog's legitimate zero price after validating currency/idempotency.
    if price_minor == 0:
        amount = 0
    duration_days = int(offer.get("durationDays") or 0)
    if duration_days < 1 or duration_days > 3660:
        raise HTTPException(status_code=500, detail="Invalid server subscription duration")

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_WALLET_LOCK
    with guard:
        with db_conn() as conn:
            _lock_and_validate_wallet_users(conn, [target_uid], postgres=postgres)
            _lock_idempotency_key(conn, idem, postgres=postgres, namespace="subscription")
            prior = _find_entity_by_idempotency(conn, "serviceSubscriptions", idem)
            if prior:
                d = prior.get("data") or {}
                if str(d.get("userId") or "") != target_uid or str(d.get("serviceId") or "") != sid:
                    raise HTTPException(status_code=409, detail="Idempotency key was already used for another operation")
                payment = None
                payment_id = str(d.get("paymentTxId") or "")
                if payment_id:
                    prow = conn.execute(
                        text("SELECT * FROM entities WHERE type='walletTransactions' AND id=:id LIMIT 1"),
                        {"id": payment_id},
                    ).mappings().first()
                    payment = _entity_from_db_row(prow) if prow else None
                return prior, False, payment

            now_dt = datetime.now(timezone.utc)
            rows = conn.execute(
                text("SELECT data_json FROM entities WHERE type='serviceSubscriptions' AND deleted=false")
            ).mappings().all()
            for row in rows:
                d = json_loads(row.get("data_json") or "{}") or {}
                if str(d.get("userId") or "") != target_uid or str(d.get("serviceId") or "") != sid:
                    continue
                if str(d.get("status") or "").lower() != "active":
                    continue
                expiry = _parse_subscription_expiry(d.get("expiresAt"))
                if expiry is None or expiry > now_dt:
                    raise HTTPException(status_code=409, detail="Service subscription is already active")

            payment: dict[str, Any] | None = None
            if amount > 0:
                if _wallet_balance_minor(conn, target_uid, cur) < amount:
                    raise HTTPException(status_code=409, detail="Insufficient wallet balance")
                payment_idempotency = f"subpay:{idem}"
                _lock_idempotency_key(conn, payment_idempotency, postgres=postgres)
                if _find_entity_by_idempotency(conn, "walletTransactions", payment_idempotency):
                    # A committed purchase would already have returned through
                    # the subscription-idempotency branch above.  A lone row
                    # with this key is therefore a conflicting legacy/manual
                    # operation and must never be charged again.
                    raise HTTPException(
                        status_code=409,
                        detail="Subscription payment idempotency key is already in use",
                    )
                payment_data = {
                    "type": "service_payment",
                    "schemaVersion": 2,
                    "amountMinor": amount,
                    "amount": amount / 100,
                    "currency": cur,
                    "fromUserId": target_uid,
                    "toUserId": "system",
                    "memo": f"Subscription: {sid}",
                    "idempotencyKey": payment_idempotency,
                    "status": "posted",
                    "referenceType": "subscription",
                    "referenceId": sid,
                    "createdAt": _iso_utc(now_dt),
                }
                payment = _insert_entity_in_transaction(
                    conn, "walletTransactions", None, payment_data, actor_uid
                )

            expires = now_dt + timedelta(days=duration_days)
            subscription_data = {
                "userId": target_uid,
                "serviceId": sid,
                "status": "active",
                "startedAt": _iso_utc(now_dt),
                "expiresAt": _iso_utc(expires),
                "priceMinor": amount,
                "price": amount / 100,
                "currency": cur,
                "paymentTxId": payment.get("id") if payment else None,
                "idempotencyKey": idem,
                "createdAt": _iso_utc(now_dt),
            }
            subscription = _insert_entity_in_transaction(
                conn, "serviceSubscriptions", requested_id, subscription_data, actor_uid
            )
            return subscription, True, payment


def _subscription_cancel_atomic(
    actor: dict[str, Any], entity_id: str, expected_last_modified: int | None
) -> dict[str, Any]:
    """Apply exactly one active -> canceled transition under a DB/user lock."""
    sub_id = validate_entity_id(entity_id)
    initial = get_entity("serviceSubscriptions", sub_id)
    if not initial:
        raise HTTPException(status_code=404, detail="Not found")
    initial_data = initial.get("data") or {}
    target_uid = sanitize_str(str(initial_data.get("userId") or ""))[:80]
    actor_uid = sanitize_str(str(actor.get("id") or ""))[:80]
    if not target_uid or not actor_uid:
        raise HTTPException(status_code=400, detail="Subscription has an invalid user")
    if str(actor.get("role") or "").lower() != "admin" and target_uid != actor_uid:
        raise HTTPException(status_code=403, detail="Forbidden")

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_WALLET_LOCK
    with guard:
        with db_conn() as conn:
            _lock_and_validate_wallet_users(conn, [target_uid], postgres=postgres)
            suffix = " FOR UPDATE" if postgres else ""
            row = conn.execute(
                text(
                    "SELECT * FROM entities WHERE type='serviceSubscriptions' "
                    f"AND id=:id AND deleted=false LIMIT 1{suffix}"
                ),
                {"id": sub_id},
            ).mappings().first()
            if not row:
                raise HTTPException(status_code=404, detail="Not found")
            current = _entity_from_db_row(row)
            data = current.get("data") or {}
            if str(actor.get("role") or "").lower() != "admin" and str(data.get("userId") or "") != actor_uid:
                raise HTTPException(status_code=403, detail="Forbidden")
            if expected_last_modified is not None and int(current["lastModified"]) != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: record has changed")
            if str(data.get("status") or "").lower() != "active":
                raise HTTPException(status_code=409, detail="Only an active subscription can be canceled")

            canceled_at = _iso_utc()
            modified = now_ms()
            data.update(
                {
                    "status": "canceled",
                    "canceledAt": canceled_at,
                    "expiresAt": canceled_at,
                    "canceledBy": actor_uid,
                    "_lastModified": modified,
                }
            )
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data, last_modified=:modified "
                    "WHERE type='serviceSubscriptions' AND id=:id"
                ),
                {"data": json_dumps(data), "modified": modified, "id": sub_id},
            )
            return {
                **current,
                "lastModified": modified,
                "data": data,
            }


CLOTHES_ORDER_STATUSES = frozenset({"New", "On the way", "Delivered", "Returned", "Canceled"})
CLOTHES_ORDER_ACTIVE_STATUSES = frozenset({"New", "On the way", "Delivered"})
CLOTHES_PAYMENT_STATUSES = frozenset({"Not Paid", "Partially Paid", "Paid"})
CLOTHES_ORDER_MUTATION_COLLECTION = "clothesOrderMutations"
CLOTHES_SHIPMENT_STATUSES = frozenset({"Ordered", "Shipped", "Arrived", "Received"})
CLOTHES_SHIPMENT_MUTATION_COLLECTION = "clothesShipmentMutations"
CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS = frozenset(
    {
        "clothesOrders",
        CLOTHES_ORDER_MUTATION_COLLECTION,
        CLOTHES_SHIPMENT_MUTATION_COLLECTION,
    }
)
CLOTHES_INVENTORY_RESTORE_BLOCKED_COLLECTIONS = frozenset(
    {*CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS, "clothesProducts", "clothesShipments"}
)
GENERIC_RESTORE_BLOCKED_COLLECTIONS = frozenset(
    {*CLOTHES_INVENTORY_RESTORE_BLOCKED_COLLECTIONS, "ads", "receipts"}
)
CLOTHES_BUSINESS_COLLECTIONS = frozenset(
    {"clothesProducts", "clothesShipments", "clothesOrders", "clothesSettings"}
)
_CLOTHES_ORDER_EDITABLE_FIELDS = frozenset(
    {
        "customerName",
        "customerPhone",
        "note",
        "lines",
        "deliveryFeeLYD",
        "paymentStatus",
        "amountPaidLYD",
        "paymentMethod",
    }
)


def _has_active_clothes_subscription(user: dict[str, Any]) -> bool:
    if str(user.get("role") or "").lower() == "admin":
        return True
    uid = sanitize_str(str(user.get("id") or ""))[:80]
    if not uid:
        return False
    dialect = str(get_engine().dialect.name or "")
    with db_conn() as conn:
        try:
            if dialect == "postgresql":
                sql = (
                    "SELECT data_json FROM entities WHERE type='serviceSubscriptions' "
                    "AND deleted=false AND (data_json::jsonb ->> 'userId')=:uid "
                    "AND (data_json::jsonb ->> 'serviceId')='clothes_system' "
                    "AND lower(data_json::jsonb ->> 'status')='active'"
                )
            else:
                sql = (
                    "SELECT data_json FROM entities WHERE type='serviceSubscriptions' "
                    "AND deleted=false AND json_extract(data_json, '$.userId')=:uid "
                    "AND json_extract(data_json, '$.serviceId')='clothes_system' "
                    "AND lower(json_extract(data_json, '$.status'))='active'"
                )
            rows = conn.execute(text(sql), {"uid": uid}).mappings().all()
        except Exception:
            rows = conn.execute(
                text(
                    "SELECT data_json FROM entities "
                    "WHERE type='serviceSubscriptions' AND deleted=false"
                )
            ).mappings().all()
    now_dt = datetime.now(timezone.utc)
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if (
            str(data.get("userId") or "") != uid
            or str(data.get("serviceId") or "") != "clothes_system"
            or str(data.get("status") or "").lower() != "active"
        ):
            continue
        expiry = _parse_subscription_expiry(data.get("expiresAt"))
        if expiry is None or expiry > now_dt:
            return True
    return False


def _require_clothes_subscription(user: dict[str, Any]) -> None:
    if not _has_active_clothes_subscription(user):
        raise HTTPException(status_code=403, detail="An active clothes_system subscription is required")


def _clothes_money(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail=f"{field} must be a non-negative number")
    try:
        amount = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(status_code=400, detail=f"{field} must be a non-negative number")
    if not math.isfinite(amount) or amount < 0 or amount > MAX_FINANCIAL_AMOUNT:
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    return round(amount, 2)


def _clothes_variant_key(color: Any, size: Any) -> tuple[str, str]:
    return (str(color or "").strip().lower(), str(size or "").strip().lower())


def _clothes_find_variant(product_data: dict[str, Any], color: Any, size: Any) -> dict[str, Any] | None:
    variants = product_data.get("variants")
    if not isinstance(variants, list):
        return None
    wanted = _clothes_variant_key(color, size)
    for variant in variants:
        if isinstance(variant, dict) and _clothes_variant_key(variant.get("color"), variant.get("size")) == wanted:
            return variant
    return None


def _clothes_lock_row(
    conn: Any,
    collection: str,
    entity_id: str,
    *,
    postgres: bool,
) -> Any | None:
    suffix = " FOR UPDATE" if postgres else ""
    return conn.execute(
        text(
            "SELECT type, id, data_json, deleted, created_at, created_by, last_modified "
            "FROM entities WHERE type=:type AND id=:id LIMIT 1" + suffix
        ),
        {"type": collection, "id": entity_id},
    ).mappings().first()


def _clothes_require_permission(
    actor: dict[str, Any], module: str, action: str, creator_id: Any = None
) -> None:
    if not user_has_permission(
        actor,
        module,
        action,
        record_creator_id=str(creator_id or ""),
    ):
        raise HTTPException(status_code=403, detail="Forbidden")


def _clothes_write_row(
    conn: Any,
    row: Any,
    data: dict[str, Any],
    *,
    deleted: bool | None = None,
) -> dict[str, Any]:
    baseline = int(row["last_modified"])
    modified = max(now_ms(), baseline + 1)
    next_deleted = bool(row["deleted"]) if deleted is None else bool(deleted)
    clean = sanitize_json(data or {}) or {}
    clean["id"] = str(row["id"])
    clean["_created"] = clean.get("_created") or int(row["created_at"])
    clean["_lastModified"] = modified
    clean["_deleted"] = next_deleted
    if row.get("created_by") is not None:
        clean["createdBy"] = str(row["created_by"])
    else:
        clean.pop("createdBy", None)
    result = conn.execute(
        text(
            "UPDATE entities SET data_json=:data, deleted=:deleted, last_modified=:modified "
            "WHERE type=:type AND id=:id AND last_modified=:baseline"
        ),
        {
            "data": json_dumps(clean),
            "deleted": next_deleted,
            "modified": modified,
            "type": str(row["type"]),
            "id": str(row["id"]),
            "baseline": baseline,
        },
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="Conflict: record has changed")
    return {
        "id": str(row["id"]),
        "type": str(row["type"]),
        "deleted": next_deleted,
        "createdAt": int(row["created_at"]),
        "createdBy": row.get("created_by"),
        "lastModified": modified,
        "data": clean,
    }


def _clothes_parse_order_lines(raw_lines: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_lines, list) or not raw_lines or len(raw_lines) > 500:
        raise HTTPException(status_code=400, detail="Order must contain 1-500 lines")
    parsed: list[dict[str, Any]] = []
    total_qty = 0
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail=f"Invalid order line {index + 1}")
        product_id = validate_entity_id(raw.get("productId"))
        qty_raw = raw.get("qty")
        if isinstance(qty_raw, bool):
            raise HTTPException(status_code=400, detail=f"Invalid quantity on line {index + 1}")
        try:
            qty = int(qty_raw)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=400, detail=f"Invalid quantity on line {index + 1}")
        if qty <= 0 or qty > 1_000_000 or str(qty) != str(qty_raw).strip():
            raise HTTPException(status_code=400, detail=f"Invalid quantity on line {index + 1}")
        total_qty += qty
        if total_qty > 10_000_000:
            raise HTTPException(status_code=400, detail="Order quantity is too large")
        parsed.append(
            {
                "productId": product_id,
                "color": sanitize_str(str(raw.get("color") or ""), 60),
                "size": sanitize_str(str(raw.get("size") or ""), 60),
                "qty": qty,
                "priceLYD": _clothes_money(raw.get("priceLYD"), f"line {index + 1} priceLYD"),
            }
        )
    return parsed


def _clothes_load_products_for_update(
    conn: Any,
    product_ids: set[str],
    actor: dict[str, Any],
    *,
    postgres: bool,
) -> dict[str, tuple[Any, dict[str, Any]]]:
    products: dict[str, tuple[Any, dict[str, Any]]] = {}
    for product_id in sorted(product_ids):
        row = _clothes_lock_row(conn, "clothesProducts", product_id, postgres=postgres)
        if not row:
            continue
        _clothes_require_permission(actor, "clothesProducts", "edit", row.get("created_by"))
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            data = {}
        products[product_id] = (row, data)
    return products


def _clothes_restore_order_stock(
    lines: Any,
    products: dict[str, tuple[Any, dict[str, Any]]],
    changed: set[str],
) -> None:
    if not isinstance(lines, list):
        raise HTTPException(status_code=409, detail="Order stock history is invalid")
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(status_code=409, detail="Order stock history is invalid")
        product_id = str(line.get("productId") or "")
        product_entry = products.get(product_id)
        if not product_entry or bool(product_entry[0]["deleted"]):
            raise HTTPException(
                status_code=409,
                detail=f"Cannot restore stock because product is missing: {product_id}",
            )
        variant = _clothes_find_variant(product_entry[1], line.get("color"), line.get("size"))
        if not variant:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot restore stock because product variant is missing: {product_id}",
            )
        try:
            ordered = int(line.get("qty") or 0)
            deducted = int(line.get("deductedQty", ordered))
            available = int(variant.get("qty") or 0)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=409, detail="Order stock history is invalid")
        if ordered <= 0 or deducted <= 0 or deducted > ordered or available < 0:
            raise HTTPException(status_code=409, detail="Order stock history is invalid")
        variant["qty"] = available + deducted
        changed.add(product_id)


def _clothes_deduct_order_stock(
    lines: list[dict[str, Any]],
    products: dict[str, tuple[Any, dict[str, Any]]],
    changed: set[str],
) -> None:
    for line in lines:
        product_id = line["productId"]
        product_entry = products.get(product_id)
        if not product_entry or bool(product_entry[0]["deleted"]):
            raise HTTPException(status_code=404, detail=f"Product not found: {product_id}")
        variant = _clothes_find_variant(product_entry[1], line.get("color"), line.get("size"))
        if not variant:
            raise HTTPException(status_code=409, detail=f"Product variant is unavailable: {product_id}")
        available = max(0, int(variant.get("qty") or 0))
        qty = int(line["qty"])
        if available < qty:
            raise HTTPException(
                status_code=409,
                detail=f"Insufficient stock for {product_id}: {available} available, {qty} requested",
            )
        variant["qty"] = available - qty
        line["deductedQty"] = qty
        changed.add(product_id)


def _clothes_normalize_order_payload(
    raw_data: dict[str, Any],
    lines: list[dict[str, Any]],
    products: dict[str, tuple[Any, dict[str, Any]]],
    old_data: dict[str, Any] | None,
) -> dict[str, Any]:
    unknown = set(raw_data.keys()) - _CLOTHES_ORDER_EDITABLE_FIELDS
    if unknown:
        raise HTTPException(status_code=400, detail=f"Server-controlled order fields: {', '.join(sorted(unknown))}")
    customer_name = sanitize_str(str(raw_data.get("customerName") or ""), 120)
    if not customer_name:
        raise HTTPException(status_code=400, detail="customerName is required")

    snapshots: dict[tuple[str, str, str], list[float]] = {}
    for old_line in (old_data or {}).get("lines", []) if isinstance((old_data or {}).get("lines"), list) else []:
        if not isinstance(old_line, dict):
            continue
        key = (
            str(old_line.get("productId") or ""),
            *_clothes_variant_key(old_line.get("color"), old_line.get("size")),
        )
        snapshots.setdefault(key, []).append(_clothes_money(old_line.get("costUSDAtSale"), "costUSDAtSale"))

    for line in lines:
        key = (line["productId"], *_clothes_variant_key(line.get("color"), line.get("size")))
        prior = snapshots.get(key) or []
        if prior:
            line["costUSDAtSale"] = prior.pop(0)
        else:
            product_entry = products.get(line["productId"])
            if not product_entry or bool(product_entry[0]["deleted"]):
                raise HTTPException(status_code=404, detail=f"Product not found: {line['productId']}")
            line["costUSDAtSale"] = _clothes_money(product_entry[1].get("costUSD"), "product costUSD")

    delivery_fee = _clothes_money(raw_data.get("deliveryFeeLYD"), "deliveryFeeLYD")
    goods_total = round(sum(int(line["qty"]) * float(line["priceLYD"]) for line in lines), 2)
    total = round(goods_total + delivery_fee, 2)
    payment_status = str(raw_data.get("paymentStatus") or "Not Paid")
    if payment_status not in CLOTHES_PAYMENT_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid paymentStatus")
    amount_paid = _clothes_money(raw_data.get("amountPaidLYD"), "amountPaidLYD")
    if payment_status == "Paid":
        amount_paid = total
    elif payment_status == "Not Paid":
        amount_paid = 0.0
    elif amount_paid > total:
        raise HTTPException(status_code=400, detail="amountPaidLYD cannot exceed the order total")

    paid_at = (old_data or {}).get("paidAt")
    if payment_status == "Paid" and not paid_at:
        paid_at = _iso_utc()
    return {
        "customerName": customer_name,
        "customerPhone": sanitize_str(str(raw_data.get("customerPhone") or ""), 40),
        "note": sanitize_str(str(raw_data.get("note") or ""), 500),
        "lines": lines,
        "deliveryFeeLYD": delivery_fee,
        "paymentStatus": payment_status,
        "amountPaidLYD": amount_paid,
        "paymentMethod": sanitize_str(str(raw_data.get("paymentMethod") or ""), 60),
        "paidAt": paid_at,
    }


def _clothes_read_mutation_result(
    conn: Any, marker: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    marker_data = marker.get("data") or {}
    order_id = validate_entity_id(marker_data.get("orderId"))
    row = _clothes_lock_row(conn, "clothesOrders", order_id, postgres=False)
    if not row:
        raise HTTPException(status_code=409, detail="Idempotent order result no longer exists")
    order = _entity_from_db_row(row)
    products: list[dict[str, Any]] = []
    for product_id in marker_data.get("updatedProductIds") or []:
        try:
            pid = validate_entity_id(product_id)
        except HTTPException:
            continue
        product_row = _clothes_lock_row(conn, "clothesProducts", pid, postgres=False)
        if product_row:
            products.append(_entity_from_db_row(product_row))
    return order, products


def _clothes_mutation_marker_id(namespace: str, idempotency_key: str) -> str:
    digest = hashlib.sha256(
        f"{namespace}\0{idempotency_key}".encode("utf-8")
    ).hexdigest()
    return f"clothes_idem_{digest[:48]}"


def _clothes_get_mutation_marker(
    conn: Any,
    collection: str,
    namespace: str,
    idempotency_key: str,
) -> dict[str, Any] | None:
    marker_id = _clothes_mutation_marker_id(namespace, idempotency_key)
    row = _clothes_lock_row(conn, collection, marker_id, postgres=False)
    return _entity_from_db_row(row) if row else None


def _clothes_order_mutation_atomic(
    actor: dict[str, Any],
    *,
    action: str,
    idempotency_key: str,
    order_id: str | None = None,
    expected_last_modified: int | None = None,
    data: dict[str, Any] | None = None,
    status: str | None = None,
    payment_status: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    actor_id = validate_entity_id(actor.get("id"))
    act = str(action or "")
    if act not in {"create", "update", "status", "payment", "delete"}:
        raise HTTPException(status_code=400, detail="Invalid clothes order action")
    idem = sanitize_str(str(idempotency_key or ""), 120)
    if len(idem) < 8:
        raise HTTPException(status_code=400, detail="idempotencyKey is required (minimum 8 characters)")
    # A retry with the same idempotency key must address the same order even
    # when an older client omitted orderId. Deriving the fallback from the key
    # keeps both the request hash and result stable across network retries.
    fallback_id = f"clothes_order_{hashlib.sha256(idem.encode('utf-8')).hexdigest()[:32]}"
    target_id = validate_entity_id(order_id or fallback_id)
    raw_data = data or {}
    if not isinstance(raw_data, dict):
        raise HTTPException(status_code=400, detail="Invalid order data")
    validate_relationship_ids(raw_data, "clothes order")
    clean_data = sanitize_json(raw_data) or {}
    request_payload = {
        "action": act,
        "orderId": target_id,
        "expectedLastModified": expected_last_modified,
        "status": status,
        "paymentStatus": payment_status,
        "data": clean_data,
    }
    request_hash = hashlib.sha256(json_dumps(request_payload).encode("utf-8")).hexdigest()
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK

    with guard:
        with db_conn() as conn:
            _lock_idempotency_key(
                conn,
                idem,
                postgres=postgres,
                namespace="clothesOrder",
            )
            prior_marker = _clothes_get_mutation_marker(
                conn, CLOTHES_ORDER_MUTATION_COLLECTION, "order", idem
            )
            if prior_marker:
                marker_data = prior_marker.get("data") or {}
                if (
                    str(marker_data.get("actorId") or "") != actor_id
                    or str(marker_data.get("requestHash") or "") != request_hash
                ):
                    raise HTTPException(status_code=409, detail="Idempotency key was already used")
                order, products = _clothes_read_mutation_result(conn, prior_marker)
                return order, products, True

            order_row = _clothes_lock_row(conn, "clothesOrders", target_id, postgres=postgres)
            order_data = (
                json_loads(order_row.get("data_json") or "{}") or {} if order_row else {}
            )
            if not isinstance(order_data, dict):
                order_data = {}

            if act == "create":
                _clothes_require_permission(actor, "clothesOrders", "add")
                if order_row:
                    raise HTTPException(status_code=409, detail="Order ID already exists")
            else:
                if not order_row or bool(order_row["deleted"]):
                    raise HTTPException(status_code=404, detail="Order not found")
                permission_action = "delete" if act == "delete" else "edit"
                _clothes_require_permission(
                    actor, "clothesOrders", permission_action, order_row.get("created_by")
                )
                if expected_last_modified is None:
                    raise HTTPException(status_code=400, detail="expectedLastModified is required")
                if int(order_row["last_modified"]) != int(expected_last_modified):
                    raise HTTPException(status_code=409, detail="Conflict: order has changed")

            new_lines: list[dict[str, Any]] = []
            if act in {"create", "update"}:
                new_lines = _clothes_parse_order_lines(clean_data.get("lines"))
            old_lines = order_data.get("lines") if isinstance(order_data.get("lines"), list) else []
            product_ids = {
                str(line.get("productId") or "")
                for line in [*old_lines, *new_lines]
                if isinstance(line, dict) and line.get("productId")
            }
            products = _clothes_load_products_for_update(
                conn, product_ids, actor, postgres=postgres
            )
            changed_products: set[str] = set()

            if act == "create":
                normalized = _clothes_normalize_order_payload(clean_data, new_lines, products, None)
                _clothes_deduct_order_stock(new_lines, products, changed_products)
                _lock_idempotency_key(
                    conn, "global", postgres=postgres, namespace="clothesOrderNumber"
                )
                max_order_no = 0
                for existing in conn.execute(
                    text("SELECT data_json FROM entities WHERE type='clothesOrders'")
                ).mappings().all():
                    existing_data = json_loads(existing.get("data_json") or "{}") or {}
                    try:
                        max_order_no = max(max_order_no, int(existing_data.get("orderNo") or 0))
                    except (TypeError, ValueError, OverflowError):
                        pass
                normalized.update(
                    {
                        "orderNo": max_order_no + 1,
                        "status": "New",
                        "stockDeducted": True,
                        "deliveredAt": None,
                        "createdAt": _iso_utc(),
                    }
                )
                order = _insert_entity_in_transaction(
                    conn, "clothesOrders", target_id, normalized, actor_id
                )
            elif act == "update":
                if str(order_data.get("status") or "") not in CLOTHES_ORDER_ACTIVE_STATUSES:
                    raise HTTPException(status_code=409, detail="Returned/Canceled orders cannot be edited")
                if order_data.get("stockDeducted") is not True:
                    raise HTTPException(status_code=409, detail="Active order stock state is inconsistent")
                normalized = _clothes_normalize_order_payload(clean_data, new_lines, products, order_data)
                _clothes_restore_order_stock(old_lines, products, changed_products)
                _clothes_deduct_order_stock(new_lines, products, changed_products)
                next_order = dict(order_data)
                next_order.update(normalized)
                next_order["stockDeducted"] = True
                order = _clothes_write_row(conn, order_row, next_order)
            elif act == "status":
                next_status = str(status or "")
                if next_status not in CLOTHES_ORDER_STATUSES:
                    raise HTTPException(status_code=400, detail="Invalid order status")
                current_status = str(order_data.get("status") or "")
                if current_status not in CLOTHES_ORDER_STATUSES:
                    raise HTTPException(status_code=409, detail="Order has an invalid current status")
                was_active = current_status in CLOTHES_ORDER_ACTIVE_STATUSES
                will_be_active = next_status in CLOTHES_ORDER_ACTIVE_STATUSES
                next_order = dict(order_data)
                if was_active and not will_be_active:
                    if order_data.get("stockDeducted") is True:
                        _clothes_restore_order_stock(old_lines, products, changed_products)
                    next_order["stockDeducted"] = False
                elif not was_active and will_be_active:
                    if order_data.get("stockDeducted") is True:
                        raise HTTPException(status_code=409, detail="Inactive order stock state is inconsistent")
                    reactivated_lines = [dict(line) for line in old_lines if isinstance(line, dict)]
                    _clothes_deduct_order_stock(reactivated_lines, products, changed_products)
                    next_order["lines"] = reactivated_lines
                    next_order["stockDeducted"] = True
                next_order["status"] = next_status
                if next_status == "Delivered" and not next_order.get("deliveredAt"):
                    next_order["deliveredAt"] = _iso_utc()
                order = _clothes_write_row(conn, order_row, next_order)
            elif act == "payment":
                next_payment = str(payment_status or "")
                if next_payment not in CLOTHES_PAYMENT_STATUSES:
                    raise HTTPException(status_code=400, detail="Invalid payment status")
                next_order = dict(order_data)
                total = round(
                    sum(
                        max(0, int(line.get("qty") or 0)) * float(line.get("priceLYD") or 0)
                        for line in old_lines
                        if isinstance(line, dict)
                    )
                    + float(order_data.get("deliveryFeeLYD") or 0),
                    2,
                )
                next_order["paymentStatus"] = next_payment
                if next_payment == "Paid":
                    next_order["amountPaidLYD"] = total
                    next_order["paidAt"] = next_order.get("paidAt") or _iso_utc()
                elif next_payment == "Not Paid":
                    next_order["amountPaidLYD"] = 0.0
                order = _clothes_write_row(conn, order_row, next_order)
            else:
                if order_data.get("stockDeducted") is True:
                    _clothes_restore_order_stock(old_lines, products, changed_products)
                next_order = dict(order_data)
                next_order["stockDeducted"] = False
                order = _clothes_write_row(conn, order_row, next_order, deleted=True)

            updated_products: list[dict[str, Any]] = []
            for product_id in sorted(changed_products):
                product_row, product_data = products[product_id]
                updated_products.append(
                    _clothes_write_row(conn, product_row, product_data)
                )

            _insert_entity_in_transaction(
                conn,
                CLOTHES_ORDER_MUTATION_COLLECTION,
                _clothes_mutation_marker_id("order", idem),
                {
                    "actorId": actor_id,
                    "idempotencyKey": idem,
                    "requestHash": request_hash,
                    "action": act,
                    "orderId": target_id,
                    "updatedProductIds": sorted(changed_products),
                    "createdAt": _iso_utc(),
                },
                actor_id,
            )
            return order, updated_products, False


@app.post(
    "/api/clothes/orders/mutate",
    response_model=ClothesOrderMutationResponse,
)
def mutate_clothes_order(
    body: ClothesOrderMutationRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    _require_clothes_subscription(user)
    order, updated_products, replayed = _clothes_order_mutation_atomic(
        user,
        action=body.action,
        idempotency_key=body.idempotencyKey,
        order_id=body.orderId,
        expected_last_modified=body.expectedLastModified,
        data=body.data,
        status=body.status,
        payment_status=body.paymentStatus,
    )
    if not replayed:
        audit(
            str(user.get("id")),
            body.action,
            "clothesOrders",
            order["id"],
            f"Clothes order {body.action}",
            {"updatedProducts": [product["id"] for product in updated_products]},
        )
    return ClothesOrderMutationResponse(
        order=EntityResponse(**order),
        updatedProducts=[EntityResponse(**product) for product in updated_products],
        replayed=replayed,
    )


def _clothes_parse_shipment_lines(raw_lines: Any) -> list[dict[str, Any]]:
    """Validate persisted shipment lines before they can affect inventory."""
    if not isinstance(raw_lines, list) or not raw_lines or len(raw_lines) > 500:
        raise HTTPException(status_code=409, detail="Shipment has invalid inventory lines")
    parsed: list[dict[str, Any]] = []
    total_qty = 0
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            raise HTTPException(status_code=409, detail=f"Invalid shipment line {index + 1}")
        product_id = validate_entity_id(raw.get("productId"))
        qty_raw = raw.get("qty")
        if isinstance(qty_raw, bool):
            raise HTTPException(status_code=409, detail=f"Invalid quantity on shipment line {index + 1}")
        try:
            qty = int(qty_raw)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=409, detail=f"Invalid quantity on shipment line {index + 1}")
        if qty <= 0 or qty > 1_000_000 or str(qty) != str(qty_raw).strip():
            raise HTTPException(status_code=409, detail=f"Invalid quantity on shipment line {index + 1}")
        total_qty += qty
        if total_qty > 10_000_000:
            raise HTTPException(status_code=409, detail="Shipment quantity is too large")
        parsed.append(
            {
                "productId": product_id,
                "color": sanitize_str(str(raw.get("color") or ""), 60),
                "size": sanitize_str(str(raw.get("size") or ""), 60),
                "qty": qty,
            }
        )
    return parsed


def _clothes_apply_shipment_stock(
    lines: list[dict[str, Any]],
    products: dict[str, tuple[Any, dict[str, Any]]],
    changed: set[str],
    *,
    receive: bool,
) -> None:
    for line in lines:
        product_id = line["productId"]
        product_entry = products.get(product_id)
        if not product_entry or bool(product_entry[0]["deleted"]):
            raise HTTPException(status_code=409, detail=f"Shipment product is missing: {product_id}")
        product_data = product_entry[1]
        variants = product_data.get("variants")
        if not isinstance(variants, list):
            variants = []
            product_data["variants"] = variants
        variant = _clothes_find_variant(product_data, line.get("color"), line.get("size"))
        if not variant:
            if not receive:
                raise HTTPException(
                    status_code=409,
                    detail=f"Cannot un-receive missing product variant: {product_id}",
                )
            variant = {
                "color": line.get("color") or "",
                "size": line.get("size") or "",
                "qty": 0,
            }
            variants.append(variant)
        try:
            available = int(variant.get("qty") or 0)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=409, detail=f"Invalid stock quantity: {product_id}")
        if available < 0:
            raise HTTPException(status_code=409, detail=f"Invalid stock quantity: {product_id}")
        qty = int(line["qty"])
        if not receive and available < qty:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot un-receive {product_id}: {available} available, {qty} required",
            )
        variant["qty"] = available + qty if receive else available - qty
        changed.add(product_id)


def _clothes_read_shipment_mutation_result(
    conn: Any, marker: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    marker_data = marker.get("data") or {}
    shipment_id = validate_entity_id(marker_data.get("shipmentId"))
    row = _clothes_lock_row(conn, "clothesShipments", shipment_id, postgres=False)
    if not row:
        raise HTTPException(status_code=409, detail="Idempotent shipment result no longer exists")
    shipment = _entity_from_db_row(row)
    products: list[dict[str, Any]] = []
    for product_id in marker_data.get("updatedProductIds") or []:
        try:
            pid = validate_entity_id(product_id)
        except HTTPException:
            continue
        product_row = _clothes_lock_row(conn, "clothesProducts", pid, postgres=False)
        if product_row:
            products.append(_entity_from_db_row(product_row))
    return shipment, products


def _clothes_shipment_mutation_atomic(
    actor: dict[str, Any],
    *,
    action: str,
    idempotency_key: str,
    shipment_id: str,
    expected_last_modified: int,
    status: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    actor_id = validate_entity_id(actor.get("id"))
    act = str(action or "")
    if act not in {"status", "delete"}:
        raise HTTPException(status_code=400, detail="Invalid clothes shipment action")
    idem = sanitize_str(str(idempotency_key or ""), 120)
    if len(idem) < 8:
        raise HTTPException(status_code=400, detail="idempotencyKey is required (minimum 8 characters)")
    target_id = validate_entity_id(shipment_id)
    request_payload = {
        "action": act,
        "shipmentId": target_id,
        "expectedLastModified": expected_last_modified,
        "status": status,
    }
    request_hash = hashlib.sha256(json_dumps(request_payload).encode("utf-8")).hexdigest()
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK

    with guard:
        with db_conn() as conn:
            _lock_idempotency_key(conn, idem, postgres=postgres, namespace="clothesShipment")
            prior_marker = _clothes_get_mutation_marker(
                conn, CLOTHES_SHIPMENT_MUTATION_COLLECTION, "shipment", idem
            )
            if prior_marker:
                marker_data = prior_marker.get("data") or {}
                if (
                    str(marker_data.get("actorId") or "") != actor_id
                    or str(marker_data.get("requestHash") or "") != request_hash
                ):
                    raise HTTPException(status_code=409, detail="Idempotency key was already used")
                shipment, products = _clothes_read_shipment_mutation_result(conn, prior_marker)
                return shipment, products, True

            shipment_row = _clothes_lock_row(
                conn, "clothesShipments", target_id, postgres=postgres
            )
            if not shipment_row or bool(shipment_row["deleted"]):
                raise HTTPException(status_code=404, detail="Shipment not found")
            permission_action = "delete" if act == "delete" else "edit"
            _clothes_require_permission(
                actor,
                "clothesShipments",
                permission_action,
                shipment_row.get("created_by"),
            )
            if int(shipment_row["last_modified"]) != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: shipment has changed")
            shipment_data = json_loads(shipment_row.get("data_json") or "{}") or {}
            if not isinstance(shipment_data, dict):
                raise HTTPException(status_code=409, detail="Shipment data is invalid")

            current_status = str(shipment_data.get("status") or "")
            stock_applied = shipment_data.get("stockApplied") is True
            if current_status not in CLOTHES_SHIPMENT_STATUSES:
                raise HTTPException(status_code=409, detail="Shipment has an invalid current status")
            if (current_status == "Received") != stock_applied:
                raise HTTPException(status_code=409, detail="Shipment stock state is inconsistent")

            changed_products: set[str] = set()
            products: dict[str, tuple[Any, dict[str, Any]]] = {}
            next_shipment = dict(shipment_data)
            if act == "delete":
                if current_status == "Received" or stock_applied:
                    raise HTTPException(
                        status_code=409,
                        detail="A received shipment must be un-received before deletion",
                    )
                shipment = _clothes_write_row(
                    conn, shipment_row, next_shipment, deleted=True
                )
            else:
                next_status = str(status or "")
                if next_status not in CLOTHES_SHIPMENT_STATUSES:
                    raise HTTPException(status_code=400, detail="Invalid shipment status")
                if next_status != current_status and (
                    next_status == "Received" or current_status == "Received"
                ):
                    lines = _clothes_parse_shipment_lines(shipment_data.get("lines"))
                    products = _clothes_load_products_for_update(
                        conn,
                        {line["productId"] for line in lines},
                        actor,
                        postgres=postgres,
                    )
                    if next_status == "Received":
                        _clothes_apply_shipment_stock(
                            lines, products, changed_products, receive=True
                        )
                        next_shipment["stockApplied"] = True
                        next_shipment["receivedAt"] = _iso_utc()
                    else:
                        _clothes_apply_shipment_stock(
                            lines, products, changed_products, receive=False
                        )
                        next_shipment["stockApplied"] = False
                        next_shipment["receivedAt"] = None
                next_shipment["status"] = next_status
                shipment = _clothes_write_row(conn, shipment_row, next_shipment)

            updated_products: list[dict[str, Any]] = []
            for product_id in sorted(changed_products):
                product_row, product_data = products[product_id]
                updated_products.append(_clothes_write_row(conn, product_row, product_data))

            _insert_entity_in_transaction(
                conn,
                CLOTHES_SHIPMENT_MUTATION_COLLECTION,
                _clothes_mutation_marker_id("shipment", idem),
                {
                    "actorId": actor_id,
                    "idempotencyKey": idem,
                    "requestHash": request_hash,
                    "action": act,
                    "shipmentId": target_id,
                    "updatedProductIds": sorted(changed_products),
                    "createdAt": _iso_utc(),
                },
                actor_id,
            )
            return shipment, updated_products, False


def _clothes_referenced_variant_keys(
    conn: Any,
    product_id: str,
    candidate_keys: set[tuple[str, str]],
) -> set[tuple[str, str]]:
    """Return product variants still referenced by order/shipment history."""
    if not candidate_keys:
        return set()
    found: set[tuple[str, str]] = set()
    rows = conn.execute(
        text(
            "SELECT type, data_json FROM entities "
            "WHERE type IN ('clothesOrders','clothesShipments') AND deleted=false"
        )
    ).mappings().all()
    for row in rows:
        record = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(record, dict):
            continue
        lines = record.get("lines")
        if not isinstance(lines, list):
            continue
        for line in lines:
            if not isinstance(line, dict) or str(line.get("productId") or "") != product_id:
                continue
            key = _clothes_variant_key(line.get("color"), line.get("size"))
            if key in candidate_keys:
                found.add(key)
    return found


def _clothes_product_is_referenced(conn: Any, product_id: str) -> bool:
    rows = conn.execute(
        text(
            "SELECT data_json FROM entities "
            "WHERE type IN ('clothesOrders','clothesShipments') AND deleted=false"
        )
    ).mappings().all()
    for row in rows:
        record = json_loads(row.get("data_json") or "{}") or {}
        for line in record.get("lines") if isinstance(record, dict) and isinstance(record.get("lines"), list) else []:
            if isinstance(line, dict) and str(line.get("productId") or "") == product_id:
                return True
    return False


def _clothes_validate_variants(raw_variants: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_variants, list) or len(raw_variants) > 2000:
        raise HTTPException(status_code=400, detail="variants must be a list of at most 2000 items")
    variants: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, raw in enumerate(raw_variants):
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail=f"Invalid product variant {index + 1}")
        color = sanitize_str(str(raw.get("color") or ""), 60)
        size = sanitize_str(str(raw.get("size") or ""), 60)
        key = _clothes_variant_key(color, size)
        if key in seen:
            raise HTTPException(status_code=400, detail="Duplicate product variant")
        seen.add(key)
        qty_raw = raw.get("qty")
        if isinstance(qty_raw, bool):
            raise HTTPException(status_code=400, detail=f"Invalid quantity on variant {index + 1}")
        try:
            qty = int(qty_raw)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=400, detail=f"Invalid quantity on variant {index + 1}")
        if qty < 0 or qty > 1_000_000 or str(qty) != str(qty_raw).strip():
            raise HTTPException(status_code=400, detail=f"Invalid quantity on variant {index + 1}")
        clean = sanitize_json(raw) or {}
        clean.update({"color": color, "size": size, "qty": qty})
        variants.append(clean)
    return variants


def _clothes_patch_product_atomic(
    actor: dict[str, Any],
    product_id: str,
    updates: dict[str, Any],
    expected_last_modified: int | None,
) -> dict[str, Any]:
    """Patch product metadata/stock under the same locks as orders/shipments."""
    target_id = validate_entity_id(product_id)
    clean_updates = sanitize_json(updates or {}) or {}
    for key in ["id", "_created", "_lastModified", "createdBy", "createdAt", "creatorId"]:
        clean_updates.pop(key, None)
    if "variants" in clean_updates:
        if expected_last_modified is None:
            raise HTTPException(status_code=400, detail="expectedLastModified is required for stock changes")
        clean_updates["variants"] = _clothes_validate_variants(clean_updates.get("variants"))

    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "clothesProducts", target_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Product not found")
            _clothes_require_permission(actor, "clothesProducts", "edit", row.get("created_by"))
            if expected_last_modified is not None and int(row["last_modified"]) != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: product has changed")
            product_data = json_loads(row.get("data_json") or "{}") or {}
            if not isinstance(product_data, dict):
                product_data = {}
            if "variants" in clean_updates:
                old_keys = {
                    _clothes_variant_key(item.get("color"), item.get("size"))
                    for item in product_data.get("variants", [])
                    if isinstance(item, dict)
                }
                new_keys = {
                    _clothes_variant_key(item.get("color"), item.get("size"))
                    for item in clean_updates["variants"]
                }
                removed = old_keys - new_keys
                referenced = _clothes_referenced_variant_keys(conn, target_id, removed)
                if referenced:
                    raise HTTPException(
                        status_code=409,
                        detail="A referenced product variant cannot be removed",
                    )
            product_data.update(clean_updates)
            return _clothes_write_row(conn, row, product_data)


def _clothes_delete_product_atomic(actor: dict[str, Any], product_id: str) -> dict[str, Any]:
    target_id = validate_entity_id(product_id)
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "clothesProducts", target_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Product not found")
            _clothes_require_permission(actor, "clothesProducts", "delete", row.get("created_by"))
            if _clothes_product_is_referenced(conn, target_id):
                raise HTTPException(status_code=409, detail="A referenced product cannot be deleted")
            data = json_loads(row.get("data_json") or "{}") or {}
            return _clothes_write_row(conn, row, data if isinstance(data, dict) else {}, deleted=True)


def _clothes_validate_and_lock_shipment_products(
    conn: Any,
    raw_lines: Any,
    *,
    postgres: bool,
) -> None:
    try:
        lines = _clothes_parse_shipment_lines(raw_lines)
    except HTTPException as exc:
        raise HTTPException(status_code=400, detail=exc.detail)
    for product_id in sorted({line["productId"] for line in lines}):
        row = _clothes_lock_row(conn, "clothesProducts", product_id, postgres=postgres)
        if not row or bool(row["deleted"]):
            raise HTTPException(status_code=409, detail=f"Shipment product is missing: {product_id}")


def _clothes_create_inventory_entity_atomic(
    actor: dict[str, Any],
    collection: str,
    entity_id: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    """Create a product/shipment inside the shared inventory lock domain."""
    target_id = validate_entity_id(entity_id)
    clean = sanitize_json(data or {}) or {}
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK
    try:
        with guard:
            with db_conn() as conn:
                _lock_idempotency_key(
                    conn, target_id, postgres=postgres, namespace=f"{collection}Create"
                )
                if collection == "clothesProducts":
                    clean["variants"] = _clothes_validate_variants(clean.get("variants", []))
                elif collection == "clothesShipments":
                    clean["status"] = "Ordered"
                    clean["stockApplied"] = False
                    clean["receivedAt"] = None
                    _clothes_validate_and_lock_shipment_products(
                        conn, clean.get("lines"), postgres=postgres
                    )
                else:
                    raise HTTPException(status_code=400, detail="Invalid inventory collection")
                return _insert_entity_in_transaction(
                    conn, collection, target_id, clean, str(actor.get("id") or "system")
                )
    except IntegrityError:
        raise HTTPException(status_code=409, detail="ID already exists")


def _clothes_patch_shipment_atomic(
    actor: dict[str, Any],
    shipment_id: str,
    updates: dict[str, Any],
    expected_last_modified: int | None,
) -> dict[str, Any]:
    target_id = validate_entity_id(shipment_id)
    clean_updates = sanitize_json(updates or {}) or {}
    if set(clean_updates) & {"status", "stockApplied", "receivedAt"}:
        raise HTTPException(
            status_code=405,
            detail="Shipment status must be changed through the transactional clothes API",
        )
    for key in ["id", "_created", "_lastModified", "createdBy", "createdAt", "creatorId"]:
        clean_updates.pop(key, None)
    if expected_last_modified is None:
        raise HTTPException(status_code=400, detail="expectedLastModified is required")
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_CLOTHES_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "clothesShipments", target_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Shipment not found")
            _clothes_require_permission(actor, "clothesShipments", "edit", row.get("created_by"))
            if int(row["last_modified"]) != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: shipment has changed")
            data = json_loads(row.get("data_json") or "{}") or {}
            if not isinstance(data, dict):
                raise HTTPException(status_code=409, detail="Shipment data is invalid")
            if str(data.get("status") or "") == "Received" or data.get("stockApplied") is True:
                raise HTTPException(status_code=409, detail="A received shipment cannot be edited")
            if "lines" in clean_updates:
                _clothes_validate_and_lock_shipment_products(
                    conn, clean_updates.get("lines"), postgres=postgres
                )
            data.update(clean_updates)
            return _clothes_write_row(conn, row, data)


# ---------------------------------------------------------------------------
# Receipt/ad money operations
# ---------------------------------------------------------------------------

RECEIPT_TRANSFER_MUTATION_COLLECTION = "receiptTransferMutations"
AD_FUNDING_MUTATION_COLLECTION = "adFundingMutations"
AD_STOP_MUTATION_COLLECTION = "adStopMutations"
FINANCIAL_MUTATION_COLLECTIONS = frozenset(
    {
        RECEIPT_TRANSFER_MUTATION_COLLECTION,
        AD_FUNDING_MUTATION_COLLECTION,
        AD_STOP_MUTATION_COLLECTION,
    }
)

# These fields decide how much receipt credit an ad consumes. They may only be
# changed by the transactional endpoints below. Delivery-only fields remain
# available through the generic workflow routes.
AD_FUNDING_FIELDS = frozenset(
    {
        "amountUSD",
        "amountLocal",
        "initialAmountUSD",
        "spentUSD",
        "stoppedAt",
        "stopAllocationBaseline",
        "receiptAllocations",
        "dueAllocations",
        "mergedPaidAllocations",
        "receiptIds",
        "receiptId",
        "fundingReceiptId",
        "linkedDeliveryReceiptId",
        "dueAmountToUseUSD",
        "dueAmountToUseLYD",
        "hasMergedPaidFunds",
        "isPaid",
        "refundAllocationBaseline",
        "refundDueBaseline",
        "refundType",
        "refundAmount",
        "refundStatus",
        "topUps",
    }
)
RECEIPT_TRANSFER_FIELDS = frozenset(
    {
        "transfers",
        "receiptType",
        "transferFromReceiptId",
        "transferFromCustomerId",
        "sourceReceiptId",
        "sourceCustomerId",
        "toReceiptId",
        "toCustomerId",
    }
)
RECEIPT_CAPACITY_FIELDS = frozenset(
    {
        "amountUSD",
        "amountLocal",
        "debtAmountUSD",
        "debtAmountLocal",
        "exchangeRate",
        "customerId",
        "status",
        "isPaid",
        "payments",
    }
)


def _financial_minor(value: Any, field: str, *, allow_zero: bool = True) -> int:
    """Convert a stored/requested USD value to exact cents."""
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail=f"{field} must be a money amount")
    try:
        amount = Decimal(str(0 if value is None or value == "" else value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    if not amount.is_finite() or amount < 0 or amount > Decimal(str(MAX_FINANCIAL_AMOUNT)):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    minor = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if not allow_zero and minor <= 0:
        raise HTTPException(status_code=400, detail=f"{field} must be greater than zero")
    return minor


def _financial_usd(minor: int) -> float:
    return float((Decimal(int(minor)) / Decimal(100)).quantize(Decimal("0.01")))


def _financial_rate(value: Any) -> Decimal:
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        rate = Decimal(1)
    if not rate.is_finite() or rate <= 0 or rate > Decimal(str(MAX_EXCHANGE_RATE)):
        rate = Decimal(1)
    return rate


def _financial_row_data(row: Any) -> dict[str, Any]:
    data = json_loads(row.get("data_json") or "{}") or {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=409, detail="Stored financial record is invalid")
    return data


def _financial_marker_id(namespace: str, idempotency_key: str) -> str:
    digest = hashlib.sha256(f"{namespace}\0{idempotency_key}".encode("utf-8")).hexdigest()
    return f"financial_idem_{digest[:48]}"


def _financial_request_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _financial_get_marker(
    conn: Any, collection: str, namespace: str, idempotency_key: str
) -> dict[str, Any] | None:
    row = _clothes_lock_row(
        conn,
        collection,
        _financial_marker_id(namespace, idempotency_key),
        postgres=False,
    )
    return _entity_from_db_row(row) if row else None


def _financial_check_marker(
    marker: dict[str, Any] | None, actor_id: str, request_hash: str
) -> dict[str, Any] | None:
    if not marker:
        return None
    data = marker.get("data") or {}
    if (
        str(data.get("actorId") or "") != actor_id
        or str(data.get("requestHash") or "") != request_hash
    ):
        raise HTTPException(status_code=409, detail="Idempotency key was already used")
    return data


def _financial_insert_marker(
    conn: Any,
    collection: str,
    namespace: str,
    idempotency_key: str,
    actor_id: str,
    request_hash: str,
    result: dict[str, Any],
) -> None:
    _insert_entity_in_transaction(
        conn,
        collection,
        _financial_marker_id(namespace, idempotency_key),
        {
            "actorId": actor_id,
            "requestHash": request_hash,
            "idempotencyKey": idempotency_key,
            **result,
        },
        actor_id,
    )


def _financial_active_rows(conn: Any, collection: str) -> list[Any]:
    return conn.execute(
        text(
            "SELECT type,id,data_json,deleted,created_at,created_by,last_modified "
            "FROM entities WHERE type=:type AND deleted=false"
        ),
        {"type": collection},
    ).mappings().all()


def _financial_allocations(raw: Any, field: str, *, allow_empty: bool = True) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 500:
        raise HTTPException(status_code=400, detail=f"{field} must be a list")
    totals: dict[str, int] = {}
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise HTTPException(status_code=400, detail=f"Invalid {field}[{index}]")
        receipt_id = validate_entity_id(entry.get("receiptId"))
        amount = _financial_minor(entry.get("amountUSD"), f"{field}[{index}].amountUSD")
        if amount <= 0:
            continue
        totals[receipt_id] = totals.get(receipt_id, 0) + amount
        if totals[receipt_id] > 1_000_000_000:
            raise HTTPException(status_code=400, detail=f"Invalid {field} total")
    rows = [
        {"receiptId": receipt_id, "amountUSD": _financial_usd(amount)}
        for receipt_id, amount in sorted(totals.items())
    ]
    if not allow_empty and not rows:
        raise HTTPException(status_code=400, detail=f"{field} must contain funding")
    return rows


def _financial_allocation_map(raw: Any) -> dict[str, int]:
    result: dict[str, int] = {}
    if not isinstance(raw, list):
        return result
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        receipt_id = str(entry.get("receiptId") or "")
        if not receipt_id:
            continue
        result[receipt_id] = result.get(receipt_id, 0) + _financial_minor(
            entry.get("amountUSD"), "stored allocation"
        )
    return result


def _financial_ad_general_usage(ad: dict[str, Any], receipt_id: str) -> int:
    """Mirror getReceiptUsageStats, including legacy records."""
    receipt_map = _financial_allocation_map(ad.get("receiptAllocations"))
    due_map = _financial_allocation_map(ad.get("dueAllocations"))
    receipt_sum = receipt_map.get(receipt_id, 0)
    due_sum = due_map.get(receipt_id, 0)
    legacy_due = 0
    if str(ad.get("linkedDeliveryReceiptId") or "") == receipt_id and due_sum == 0:
        legacy_due = _financial_minor(ad.get("dueAmountToUseUSD"), "stored due allocation")
        if legacy_due == 0 and ad.get("dueAmountToUseLYD"):
            local_minor = _financial_minor(ad.get("dueAmountToUseLYD"), "stored due allocation")
            rate = _financial_rate(ad.get("exchangeRate"))
            legacy_due = int((Decimal(local_minor) / rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    explicit = receipt_sum + due_sum + legacy_due
    if explicit > 0:
        return explicit
    if isinstance(ad.get("receiptAllocations"), list) or isinstance(ad.get("dueAllocations"), list):
        return 0
    references = {
        str(ad.get("fundingReceiptId") or ""),
        str(ad.get("receiptId") or ""),
        str(ad.get("linkedDeliveryReceiptId") or ""),
    }
    if receipt_id not in references:
        return 0
    fallback = ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD")
    return _financial_minor(fallback, "stored legacy ad amount")


def _financial_ad_due_usage(ad: dict[str, Any], receipt_id: str) -> int:
    due = _financial_allocation_map(ad.get("dueAllocations")).get(receipt_id, 0)
    if due > 0:
        return due
    if str(ad.get("linkedDeliveryReceiptId") or "") != receipt_id:
        return 0
    direct = _financial_minor(ad.get("dueAmountToUseUSD"), "stored due allocation")
    if direct:
        return direct
    local = _financial_minor(ad.get("dueAmountToUseLYD"), "stored due allocation")
    if not local:
        return 0
    return int(
        (Decimal(local) / _financial_rate(ad.get("exchangeRate"))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def _financial_ad_explicit_usage(ad: dict[str, Any], receipt_id: str) -> int:
    """Money this ad EXPLICITLY commits against a receipt, from either pool.

    Allocation rows (paid + due) plus the legacy due mirror, which only speaks for an ad
    that has no due row for this receipt. Unlike _financial_ad_general_usage there is NO
    whole-ad fallback: that fallback charges a pre-allocation ad's entire spend against any
    receipt it merely REFERENCES, and a driver-collected ad references its delivery receipt
    while being funded by the customer's cash, not by the receipt's credit.
    """
    paid_rows = _financial_allocation_map(ad.get("receiptAllocations")).get(receipt_id, 0)
    due_rows = _financial_allocation_map(ad.get("dueAllocations")).get(receipt_id, 0)
    legacy_due = 0
    if str(ad.get("linkedDeliveryReceiptId") or "") == receipt_id and due_rows == 0:
        legacy_due = _financial_minor(ad.get("dueAmountToUseUSD"), "stored due allocation")
        if legacy_due == 0 and ad.get("dueAmountToUseLYD"):
            local_minor = _financial_minor(ad.get("dueAmountToUseLYD"), "stored due allocation")
            rate = _financial_rate(ad.get("exchangeRate"))
            legacy_due = int((Decimal(local_minor) / rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return paid_rows + due_rows + legacy_due


def _financial_explicit_usage(
    ad_rows: list[Any], receipt_id: str, *, exclude_ad_id: str | None = None
) -> int:
    total = 0
    for row in ad_rows:
        if exclude_ad_id and str(row.get("id") or "") == exclude_ad_id:
            continue
        ad = _financial_row_data(row)
        if str(ad.get("recordType") or "") == "receipt":
            continue
        total += _financial_ad_explicit_usage(ad, receipt_id)
    return total


def _financial_ad_committed(ad: dict[str, Any], receipt_id: str) -> int:
    """The money this ad TRULY commits against a receipt — the number the capacity
    check must count for every OTHER ad.

    Explicit rows + due mirror first (that already covers modern and legacy-due ads).
    Only a ROWLESS, genuinely receipt-funded ad falls back to its whole spend. A
    not_paid/driver ad is excluded from that fallback: its receiptId points at the
    delivery receipt for linkage, but it is funded by the customer's CASH, so charging
    its amountUSD here would be the same phantom commitment the due reader had to drop.
    Sits between _financial_ad_explicit_usage (misses legacy PAID ads -> lets a self-draw
    through) and _financial_ad_general_usage (charges cash-driver ads -> false-blocks).
    """
    explicit = _financial_ad_explicit_usage(ad, receipt_id)
    if explicit > 0:
        return explicit
    if isinstance(ad.get("receiptAllocations"), list) or isinstance(ad.get("dueAllocations"), list):
        return 0
    if str(ad.get("paymentStatus") or "") == "not_paid" and str(ad.get("collectionMethod") or "") == "driver":
        return 0
    references = {
        str(ad.get("fundingReceiptId") or ""),
        str(ad.get("receiptId") or ""),
        str(ad.get("linkedDeliveryReceiptId") or ""),
    }
    if receipt_id not in references:
        return 0
    fallback = ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD")
    return _financial_minor(fallback, "stored legacy ad amount")


def _financial_committed_usage(
    ad_rows: list[Any], receipt_id: str, *, exclude_ad_id: str | None = None
) -> int:
    total = 0
    for row in ad_rows:
        if exclude_ad_id and str(row.get("id") or "") == exclude_ad_id:
            continue
        ad = _financial_row_data(row)
        if str(ad.get("recordType") or "") == "receipt":
            continue
        total += _financial_ad_committed(ad, receipt_id)
    return total


def _financial_usage(
    ad_rows: list[Any], receipt_id: str, *, due: bool = False, exclude_ad_id: str | None = None
) -> int:
    total = 0
    for row in ad_rows:
        if exclude_ad_id and str(row.get("id") or "") == exclude_ad_id:
            continue
        ad = _financial_row_data(row)
        if str(ad.get("recordType") or "") == "receipt":
            continue
        total += (
            _financial_ad_due_usage(ad, receipt_id)
            if due
            else _financial_ad_general_usage(ad, receipt_id)
        )
    return total


def _financial_validate_combined_capacity(
    paid_allocations: list[dict[str, Any]],
    due_allocations: list[dict[str, Any]],
    *,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    current_ad_id: str | None,
) -> None:
    """ONE POT across BOTH pools for THIS ad.

    The per-pool validators each exclude the current ad and check only their own pool's
    request, so an ad drawing $150 paid AND $150 due from the same $200 receipt passed
    both (the same money, promised twice). Sum this ad's TOTAL request per receipt and
    check it against the capacity left by every OTHER ad plus outgoing transfers. Uses the
    unified capacity (_financial_due_total: amountUSD once collected, else the debt) and
    explicit usage (no whole-ad fallback), so it agrees with the client's readers.
    """
    requested: dict[str, int] = {}
    for alloc in list(paid_allocations) + list(due_allocations):
        rid = str(alloc.get("receiptId") or "")
        if rid:
            requested[rid] = requested.get(rid, 0) + _financial_minor(
                alloc.get("amountUSD"), "receipt allocation"
            )
    for rid, amount in requested.items():
        row = locked_receipts.get(rid)
        if not row or bool(row["deleted"]):
            continue  # existence/eligibility already enforced by the per-pool validators
        data = _financial_row_data(row)
        capacity = _financial_due_total(data)
        committed = _financial_committed_usage(
            ad_rows, rid, exclude_ad_id=current_ad_id
        ) + _financial_outgoing(data)
        if committed + amount > capacity:
            raise HTTPException(
                status_code=409, detail=f"Insufficient balance on receipt {rid}"
            )


def _financial_outgoing(data: dict[str, Any]) -> int:
    transfers = data.get("transfers")
    if transfers is None:
        return 0
    if not isinstance(transfers, list):
        raise HTTPException(status_code=409, detail="Stored receipt transfers are invalid")
    total = 0
    for transfer in transfers:
        if not isinstance(transfer, dict):
            raise HTTPException(status_code=409, detail="Stored receipt transfer is invalid")
        total += _financial_minor(transfer.get("amountUSD"), "stored transfer")
    return total


def _financial_due_total(data: dict[str, Any]) -> int:
    """The receipt's capacity — ONE number, whichever pool is asking.

    Before collection a delivery receipt is worth the debt the driver will collect.
    Once collected it is worth what was ACTUALLY collected (amountUSD); the debt fields
    survive only as history. Reading the frozen debt as a capacity of its own after
    collection is what let one receipt advertise its money twice — once as due credit and
    once as paid balance — so two ads could each spend the same note. Over-collecting
    legitimately adds real balance; re-reading the stale debt invents it.
    """
    if bool(data.get("isPaid")) or str(data.get("status") or "") == "Paid":
        return _financial_minor(data.get("amountUSD"), "receipt due amount")
    local_value = data.get("debtAmountLocal")
    if local_value is None:
        local_value = data.get("amountLocal")
    local = _financial_minor(local_value, "receipt due amount")
    rate = _financial_rate(data.get("exchangeRate"))
    if local > 0 and rate > 0:
        return int((Decimal(local) / rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    usd_value = data.get("debtAmountUSD")
    if usd_value is None:
        usd_value = data.get("amountUSD")
    return _financial_minor(usd_value, "receipt due amount")


def _financial_receipt_ids(ad: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for field in ("receiptAllocations", "dueAllocations", "mergedPaidAllocations"):
        if isinstance(ad.get(field), list):
            for entry in ad[field]:
                if isinstance(entry, dict) and entry.get("receiptId"):
                    ids.add(str(entry["receiptId"]))
    for field in ("receiptId", "fundingReceiptId", "linkedDeliveryReceiptId"):
        if ad.get(field):
            ids.add(str(ad[field]))
    for baseline_name in (
        "stopAllocationBaseline",
        "refundAllocationBaseline",
        "refundDueBaseline",
    ):
        baseline = ad.get(baseline_name)
        if isinstance(baseline, list):
            baseline = {"receipt": baseline}
        if isinstance(baseline, dict):
            for value in baseline.values():
                if isinstance(value, list):
                    for entry in value:
                        if isinstance(entry, dict) and entry.get("receiptId"):
                            ids.add(str(entry["receiptId"]))
    return {validate_entity_id(value) for value in ids if value}


def _financial_lock_receipts(
    conn: Any, receipt_ids: set[str] | list[str], *, postgres: bool
) -> dict[str, Any]:
    locked: dict[str, Any] = {}
    for receipt_id in sorted(set(receipt_ids)):
        locked[receipt_id] = _clothes_lock_row(
            conn, "receipts", receipt_id, postgres=postgres
        )
    return locked


def _financial_entity_result(conn: Any, collection: str, entity_id: str) -> dict[str, Any]:
    row = _clothes_lock_row(conn, collection, entity_id, postgres=False)
    if not row:
        raise HTTPException(status_code=409, detail="Idempotent operation result is missing")
    return _entity_from_db_row(row)


def _receipt_transfer_atomic(
    actor: dict[str, Any], body: ReceiptTransferRequest
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], bool]:
    actor_id = validate_entity_id(actor.get("id"))
    if not user_has_permission(actor, "receipts", "transfer"):
        raise HTTPException(status_code=403, detail="Forbidden")
    source_id = validate_entity_id(body.sourceReceiptId)
    target_customer_id = validate_entity_id(body.targetCustomerId)
    target_receipt_id = validate_entity_id(body.targetReceiptId)
    idem = sanitize_str(body.idempotencyKey, 120)
    note = sanitize_str(str(body.note or ""), 500)
    request_hash = _financial_request_hash(
        {
            "sourceReceiptId": source_id,
            "targetCustomerId": target_customer_id,
            "targetReceiptId": target_receipt_id,
            "amountMinorUSD": body.amountMinorUSD,
            "expectedSourceLastModified": body.expectedSourceLastModified,
            "note": note,
        }
    )
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            _lock_idempotency_key(conn, idem, postgres=postgres, namespace="receiptTransfer")
            prior = _financial_check_marker(
                _financial_get_marker(
                    conn, RECEIPT_TRANSFER_MUTATION_COLLECTION, "receiptTransfer", idem
                ),
                actor_id,
                request_hash,
            )
            if prior:
                source = _financial_entity_result(conn, "receipts", str(prior.get("sourceReceiptId")))
                target = _financial_entity_result(conn, "receipts", str(prior.get("targetReceiptId")))
                return source, target, prior.get("transfer") or {}, True

            source_row = _clothes_lock_row(conn, "receipts", source_id, postgres=postgres)
            if not source_row or bool(source_row["deleted"]):
                raise HTTPException(status_code=404, detail="Source receipt not found")
            if int(source_row["last_modified"]) != int(body.expectedSourceLastModified):
                raise HTTPException(status_code=409, detail="Conflict: source receipt has changed")
            source = _financial_row_data(source_row)
            source_status = str(source.get("status") or "")
            if source_status in {"Canceled", "Lost"} or not (
                source_status == "Paid" or source.get("isPaid") is True
            ):
                raise HTTPException(status_code=400, detail="Only a paid receipt can transfer balance")
            source_customer_id = validate_entity_id(source.get("customerId"))
            if source_customer_id == target_customer_id:
                raise HTTPException(status_code=400, detail="Target customer must be different")

            customer_rows: dict[str, Any] = {}
            for customer_id in sorted({source_customer_id, target_customer_id}):
                customer_rows[customer_id] = _clothes_lock_row(
                    conn, "customers", customer_id, postgres=postgres
                )
            if not customer_rows.get(source_customer_id) or bool(customer_rows[source_customer_id]["deleted"]):
                raise HTTPException(status_code=409, detail="Source receipt customer is not active")
            if not customer_rows.get(target_customer_id) or bool(customer_rows[target_customer_id]["deleted"]):
                raise HTTPException(status_code=404, detail="Target customer not found")
            if _clothes_lock_row(conn, "receipts", target_receipt_id, postgres=postgres):
                raise HTTPException(status_code=409, detail="Target receipt ID already exists")

            ad_rows = _financial_active_rows(conn, "ads")
            total = _financial_minor(source.get("amountUSD"), "receipt amount")
            committed = _financial_usage(ad_rows, source_id) + _financial_outgoing(source)
            if committed + int(body.amountMinorUSD) > total:
                raise HTTPException(status_code=409, detail="Insufficient available receipt balance")

            try:
                rate = Decimal(str(source.get("exchangeRate")))
            except (InvalidOperation, ValueError, TypeError):
                rate = Decimal(0)
            if not rate.is_finite() or rate <= 0 or rate > Decimal(str(MAX_EXCHANGE_RATE)):
                raise HTTPException(status_code=409, detail="Source receipt has an invalid exchange rate")
            local_minor = int(
                (Decimal(int(body.amountMinorUSD)) * rate).quantize(
                    Decimal("1"), rounding=ROUND_HALF_UP
                )
            )
            now_iso = _iso_utc()
            transfer = {
                "id": f"transfer_{hashlib.sha256(idem.encode('utf-8')).hexdigest()[:32]}",
                "toCustomerId": target_customer_id,
                "toReceiptId": target_receipt_id,
                "amountUSD": _financial_usd(body.amountMinorUSD),
                "amountLocal": _financial_usd(local_minor),
                "date": now_iso,
                "note": note,
            }
            transfers = list(source.get("transfers") or [])
            transfers.append(transfer)
            source["transfers"] = transfers
            saved_source = _clothes_write_row(conn, source_row, source)
            target_data = {
                "recordType": "receipt",
                "customerId": target_customer_id,
                "amountUSD": _financial_usd(body.amountMinorUSD),
                "exchangeRate": float(rate),
                "amountLocal": _financial_usd(local_minor),
                "status": "Paid",
                "isPaid": True,
                "paymentMethod": "Transfer",
                "receiptType": "TRANSFER_IN",
                "transferFromReceiptId": source_id,
                "transferFromCustomerId": source_customer_id,
                "serialNumber": "",
                "payments": [],
                "phoneNumber": "",
                "collected": False,
                "deliveryStatus": "Office",
                "isReceivedInOffice": True,
                "startDate": now_iso,
                "endDate": now_iso,
                "collectionDate": now_iso,
                "createdAt": now_iso,
                "note": note,
            }
            saved_target = _insert_entity_in_transaction(
                conn, "receipts", target_receipt_id, target_data, actor_id
            )
            _financial_insert_marker(
                conn,
                RECEIPT_TRANSFER_MUTATION_COLLECTION,
                "receiptTransfer",
                idem,
                actor_id,
                request_hash,
                {
                    "sourceReceiptId": source_id,
                    "targetReceiptId": target_receipt_id,
                    "transfer": transfer,
                },
            )
            return saved_source, saved_target, transfer, False


def _financial_collection_payments(raw: Any) -> tuple[list[dict[str, Any]], int]:
    if raw is None:
        return [], 0
    if not isinstance(raw, list) or len(raw) > 100:
        raise HTTPException(status_code=400, detail="collectionPayments must be a list")
    usd_methods = {"USDT", "Bank Transfer (USD)", "Cash (USD)"}
    payments: list[dict[str, Any]] = []
    total_minor = 0
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise HTTPException(status_code=400, detail=f"Invalid collectionPayments[{index}]")
        method = sanitize_str(str(entry.get("method") or ""), 80)
        if not method:
            raise HTTPException(status_code=400, detail="Payment method is required")
        try:
            amount = Decimal(str(entry.get("amount", 0)))
            rate1 = Decimal(str(entry.get("rate", 0) or 0))
            rate2 = Decimal(str(entry.get("rate2", 0) or 0))
        except (InvalidOperation, ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Invalid collection payment")
        if (
            not amount.is_finite()
            or not rate1.is_finite()
            or not rate2.is_finite()
            or amount < 0
            or rate1 < 0
            or rate2 <= 0
            or amount > Decimal(str(MAX_FINANCIAL_AMOUNT))
            or rate1 > Decimal(str(MAX_EXCHANGE_RATE))
            or rate2 > Decimal(str(MAX_EXCHANGE_RATE))
        ):
            raise HTTPException(status_code=400, detail="Invalid collection payment")
        r1 = amount * rate1
        raw_usd = (r1 / rate2) if method in usd_methods else (amount / rate2)
        row_minor = int((raw_usd * 100).quantize(Decimal("1"), rounding=ROUND_CEILING))
        total_minor += row_minor
        payments.append(
            {
                "method": method,
                "amount": float(amount),
                "rate": float(rate1),
                "rate2": float(rate2),
                "collectionType": sanitize_str(str(entry.get("collectionType") or ""), 40),
                "deliveryPersonId": (
                    validate_entity_id(entry.get("deliveryPersonId"))
                    if entry.get("deliveryPersonId")
                    else ""
                ),
            }
        )
    # Preserve the application's historical customer-favouring one-cent total
    # adjustment, but do it with integers (no floating point residue).
    if total_minor % 100:
        total_minor += 1
    if total_minor > 1_000_000_000:
        raise HTTPException(status_code=400, detail="Collection payment total is too large")
    return payments, total_minor


def _financial_topups(raw: Any) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(raw, list) or len(raw) > 200:
        raise HTTPException(status_code=400, detail="topUps must be a list")
    result: list[dict[str, Any]] = []
    total = 0
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise HTTPException(status_code=400, detail=f"Invalid topUps[{index}]")
        amount = _financial_minor(entry.get("amount"), f"topUps[{index}].amount")
        try:
            days = int(entry.get("extendDays", 0) or 0)
        except (TypeError, ValueError, OverflowError):
            raise HTTPException(status_code=400, detail="Invalid top-up extension")
        if days < 0 or days > 36500:
            raise HTTPException(status_code=400, detail="Invalid top-up extension")
        if amount == 0 and days == 0:
            raise HTTPException(status_code=400, detail="A top-up must add money or time")
        row = sanitize_json(entry) or {}
        row["amount"] = _financial_usd(amount)
        row["extendDays"] = days
        result.append(row)
        total += amount
    return result, total


def _financial_validate_paid_receipts(
    receipt_allocations: list[dict[str, Any]],
    *,
    customer_id: str,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    current_ad_id: str | None,
) -> None:
    for allocation in receipt_allocations:
        receipt_id = str(allocation["receiptId"])
        row = locked_receipts.get(receipt_id)
        if not row or bool(row["deleted"]):
            raise HTTPException(status_code=404, detail=f"Funding receipt not found: {receipt_id}")
        data = _financial_row_data(row)
        status = str(data.get("status") or "")
        if status in {"Canceled", "Lost"} or not (
            status == "Paid" or data.get("isPaid") is True
        ):
            raise HTTPException(status_code=400, detail="Ad funding requires paid receipts")
        if str(data.get("customerId") or "") != customer_id:
            raise HTTPException(status_code=400, detail="Funding receipt belongs to another customer")
        total = _financial_minor(data.get("amountUSD"), "receipt amount")
        committed = _financial_usage(
            ad_rows, receipt_id, exclude_ad_id=current_ad_id
        ) + _financial_outgoing(data)
        requested = _financial_minor(allocation.get("amountUSD"), "receipt allocation")
        if committed + requested > total:
            raise HTTPException(status_code=409, detail=f"Insufficient balance on receipt {receipt_id}")


def _financial_validate_due_receipt(
    due_allocations: list[dict[str, Any]],
    *,
    linked_receipt_id: str,
    customer_id: str,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    current_ad_id: str | None,
    require_pending: bool = True,
) -> None:
    if any(str(row.get("receiptId") or "") != linked_receipt_id for row in due_allocations):
        raise HTTPException(status_code=400, detail="Due funding must use the linked delivery receipt")
    row = locked_receipts.get(linked_receipt_id)
    if not row or bool(row["deleted"]):
        raise HTTPException(status_code=404, detail="Linked delivery receipt not found")
    data = _financial_row_data(row)
    if str(data.get("customerId") or "") != customer_id:
        raise HTTPException(status_code=400, detail="Linked delivery receipt belongs to another customer")
    temp_number = str(data.get("tempReceiptNo") or "")
    delivery_status = str(data.get("deliveryStatus") or "")
    if require_pending and (
        not (temp_number.startswith("D") and temp_number[1:].isdigit())
        or delivery_status in {"Delivered", "Office", "Canceled"}
        or str(data.get("status") or "") in {"Canceled", "Lost"}
        or not str(data.get("deliveryPersonId") or "").strip()
    ):
        raise HTTPException(status_code=400, detail="Linked receipt is not a pending assigned delivery receipt")
    requested = sum(
        _financial_minor(entry.get("amountUSD"), "due allocation") for entry in due_allocations
    )
    # ONE POT: count every EXPLICIT commitment against this receipt, from EITHER pool.
    # Counting only due rows meant that once a delivery receipt was collected, ads funded
    # from its PAID balance were invisible here — so the same money could be handed out
    # again as due credit. Transfers out leave the receipt too, so they are committed money.
    #
    # Deliberately NOT _financial_ad_general_usage: that has a whole-ad fallback for
    # pre-allocation records which charges an ad's ENTIRE spend against any receipt it
    # merely REFERENCES. A driver-collected ad references its delivery receipt but is
    # funded by the customer's cash, not by the receipt's credit — charging it here would
    # 409 the customer's next legitimate ad against credit they really hold.
    committed = _financial_explicit_usage(
        ad_rows, linked_receipt_id, exclude_ad_id=current_ad_id
    ) + _financial_outgoing(data)
    if committed + requested > _financial_due_total(data):
        raise HTTPException(status_code=409, detail="Insufficient delivery due credit")


def _financial_derive_ad(
    actor: dict[str, Any],
    requested: dict[str, Any],
    existing: dict[str, Any] | None,
    *,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    current_ad_id: str | None,
) -> dict[str, Any]:
    """Merge ordinary ad edits, then replace every funding mirror."""
    base = dict(existing or {})
    clean = sanitize_json(requested or {}) or {}
    for key in (
        "id",
        "_created",
        "_lastModified",
        "_deleted",
        "createdAt",
        "createdBy",
        "creatorId",
        "amountUSD",
        "amountLocal",
        "initialAmountUSD",
        "spentUSD",
        "stoppedAt",
        "stopAllocationBaseline",
        "receiptIds",
        "fundingReceiptId",
        "dueAmountToUseUSD",
        "dueAmountToUseLYD",
        "hasMergedPaidFunds",
        "isPaid",
    ):
        clean.pop(key, None)
    # Only /stop changes into or out of Stopped. Ordinary edit payloads often
    # echo the current status, which is harmless and kept stable here.
    requested_status = str(clean.pop("status", "") or "")
    old_status = str((existing or {}).get("status") or "")
    if existing and requested_status and requested_status != old_status:
        raise HTTPException(status_code=405, detail="Ad status changes require their dedicated workflow")
    base.update(clean)
    base["status"] = old_status or "Active"
    base["recordType"] = "ad"
    base["creatorId"] = str((existing or {}).get("creatorId") or actor.get("id") or "")

    customer_id = validate_entity_id(base.get("customerId"))
    payment_status = str(base.get("paymentStatus") or "paid").lower()
    if payment_status not in {"paid", "not_paid", "wont_pay"}:
        raise HTTPException(status_code=400, detail="Invalid ad paymentStatus")
    collection_method = str(base.get("collectionMethod") or "")
    paid_request = base.get("receiptAllocations")
    due_request = base.get("dueAllocations")
    merged_request = base.get("mergedPaidAllocations")
    linked_id = str(base.get("linkedDeliveryReceiptId") or "")

    paid_allocations: list[dict[str, Any]] = []
    due_allocations: list[dict[str, Any]] = []
    payments: list[dict[str, Any]] = []
    amount_minor = 0
    if payment_status == "paid":
        paid_allocations = _financial_allocations(
            paid_request, "receiptAllocations", allow_empty=False
        )
        _financial_validate_paid_receipts(
            paid_allocations,
            customer_id=customer_id,
            locked_receipts=locked_receipts,
            ad_rows=ad_rows,
            current_ad_id=current_ad_id,
        )
        amount_minor = sum(
            _financial_minor(row["amountUSD"], "receipt allocation")
            for row in paid_allocations
        )
        linked_id = ""
        collection_method = ""
    elif payment_status == "not_paid" and collection_method == "driver":
        linked_id = validate_entity_id(linked_id or base.get("receiptId"))
        merged_allocations = _financial_allocations(
            merged_request if merged_request is not None else paid_request,
            "mergedPaidAllocations",
        )
        if paid_request is not None:
            supplied_paid = _financial_allocations(paid_request, "receiptAllocations")
            if merged_request is not None and supplied_paid != merged_allocations:
                raise HTTPException(status_code=400, detail="Merged paid allocation mirrors disagree")
        paid_allocations = merged_allocations
        due_allocations = _financial_allocations(due_request, "dueAllocations")
        _financial_validate_paid_receipts(
            paid_allocations,
            customer_id=customer_id,
            locked_receipts=locked_receipts,
            ad_rows=ad_rows,
            current_ad_id=current_ad_id,
        )
        _financial_validate_due_receipt(
            due_allocations,
            linked_receipt_id=linked_id,
            customer_id=customer_id,
            locked_receipts=locked_receipts,
            ad_rows=ad_rows,
            current_ad_id=current_ad_id,
        )
        # Both pools can point at the same receipt here (merged paid + linked due);
        # cap the ad's TOTAL draw per receipt so it cannot spend the same money twice.
        _financial_validate_combined_capacity(
            paid_allocations,
            due_allocations,
            locked_receipts=locked_receipts,
            ad_rows=ad_rows,
            current_ad_id=current_ad_id,
        )
        amount_minor = sum(
            _financial_minor(row["amountUSD"], "ad allocation")
            for row in [*paid_allocations, *due_allocations]
        )
        base["deliveryPersonId"] = ""
        base["deliveryStatus"] = "Office"
    else:
        if any(
            _financial_allocations(value, name)
            for name, value in (
                ("receiptAllocations", paid_request),
                ("dueAllocations", due_request),
                ("mergedPaidAllocations", merged_request),
            )
        ):
            raise HTTPException(status_code=400, detail="This unpaid ad cannot use receipt funding")
        payments, amount_minor = _financial_collection_payments(base.get("collectionPayments"))
        linked_id = ""

    rate = _financial_rate(base.get("exchangeRate"))
    local_minor = int(
        (Decimal(amount_minor) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )
    paid_ids = [str(row["receiptId"]) for row in paid_allocations]
    due_minor = sum(
        _financial_minor(row["amountUSD"], "due allocation") for row in due_allocations
    )
    base.update(
        {
            "customerId": customer_id,
            "paymentStatus": payment_status,
            "collectionMethod": collection_method,
            "collectionPayments": [] if payment_status == "paid" else payments,
            "paymentMethod": "" if payment_status == "paid" else (payments[0]["method"] if payments else ""),
            "exchangeRate": float(rate),
            "amountUSD": _financial_usd(amount_minor),
            "amountLocal": _financial_usd(local_minor),
            "receiptAllocations": paid_allocations,
            "mergedPaidAllocations": paid_allocations
            if payment_status == "not_paid" and collection_method == "driver"
            else [],
            "dueAllocations": due_allocations,
            "receiptIds": paid_ids,
            "fundingReceiptId": paid_ids[0] if paid_ids else "",
            "linkedDeliveryReceiptId": linked_id,
            "receiptId": linked_id if linked_id else (paid_ids[0] if paid_ids else ""),
            "dueAmountToUseUSD": _financial_usd(due_minor),
            "hasMergedPaidFunds": bool(paid_allocations)
            if payment_status == "not_paid" and collection_method == "driver"
            else False,
            "isPaid": payment_status == "paid",
        }
    )
    topups = base.get("topUps") if isinstance(base.get("topUps"), list) else []
    topup_minor = sum(_financial_minor(row.get("amount"), "top-up") for row in topups if isinstance(row, dict))
    base["initialAmountUSD"] = _financial_usd(max(amount_minor - topup_minor, 0))
    return base


def _financial_reduce_allocations(
    allocations: list[dict[str, Any]], amount_minor: int
) -> tuple[list[dict[str, Any]], int]:
    result = [dict(row) for row in allocations]
    remaining = int(amount_minor)
    for row in reversed(result):
        if remaining <= 0:
            break
        current = _financial_minor(row.get("amountUSD"), "allocation")
        returned = min(current, remaining)
        row["amountUSD"] = _financial_usd(current - returned)
        remaining -= returned
    return result, remaining


def _financial_apply_refund(
    actor: dict[str, Any], requested: dict[str, Any], existing: dict[str, Any]
) -> dict[str, Any]:
    result = dict(existing)
    refund_type = str(requested.get("refundType") or "None")
    if refund_type not in {"None", "Full", "Partial"}:
        raise HTTPException(status_code=400, detail="Invalid refundType")
    ad_amount = _financial_minor(existing.get("amountUSD"), "ad amount")
    refund_amount = 0 if refund_type == "None" else _financial_minor(
        requested.get("refundAmount"), "refundAmount"
    )
    if refund_type == "Full":
        refund_amount = ad_amount
    if refund_amount > ad_amount:
        raise HTTPException(status_code=400, detail="Refund exceeds ad amount")

    current_paid = _financial_allocations(existing.get("receiptAllocations"), "receiptAllocations")
    current_due = _financial_allocations(existing.get("dueAllocations"), "dueAllocations")
    stored_paid_baseline = existing.get("refundAllocationBaseline")
    stored_due_baseline = existing.get("refundDueBaseline")
    paid_baseline = _financial_allocations(
        stored_paid_baseline if isinstance(stored_paid_baseline, list) else current_paid,
        "refundAllocationBaseline",
    )
    due_baseline = _financial_allocations(
        stored_due_baseline if isinstance(stored_due_baseline, list) else current_due,
        "refundDueBaseline",
    )
    # An ad from before the allocation arrays holds its due usage in the dueAmountToUse*
    # mirror with no row, so the baseline above comes back EMPTY and the refund released
    # nothing — the delivery credit stayed locked forever. That is bug #51 on the server,
    # for exactly the records the fix is meant to serve. Stand the mirror up as the
    # allocation it represents so the refund has something to give back.
    if not isinstance(stored_due_baseline, list) and not due_baseline:
        linked_due_id = str(existing.get("linkedDeliveryReceiptId") or "")
        legacy_due_minor = 0
        if linked_due_id:
            legacy_due_minor = _financial_minor(
                existing.get("dueAmountToUseUSD"), "stored due allocation"
            )
            if legacy_due_minor == 0 and existing.get("dueAmountToUseLYD"):
                local_minor = _financial_minor(
                    existing.get("dueAmountToUseLYD"), "stored due allocation"
                )
                rate = _financial_rate(existing.get("exchangeRate"))
                legacy_due_minor = int(
                    (Decimal(local_minor) / rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                )
        if legacy_due_minor > 0:
            due_baseline = _financial_allocations(
                [{"receiptId": linked_due_id, "amountUSD": _financial_usd(legacy_due_minor)}],
                "refundDueBaseline",
            )
    if refund_type == "None":
        result["receiptAllocations"] = paid_baseline
        result["dueAllocations"] = due_baseline
        result["refundAllocationBaseline"] = None
        result["refundDueBaseline"] = None
        result["refundType"] = "None"
        result["refundAmount"] = 0
        result.pop("refundStatus", None)
        result.pop("spentUSD", None)
        # Undo returns to the status that existed before the refund. Legacy
        # rows did not save it, so Active is the conservative usable default.
        result["status"] = str(existing.get("preRefundStatus") or "Active")
        result.pop("preRefundStatus", None)
    else:
        reduced_paid, remaining = _financial_reduce_allocations(paid_baseline, refund_amount)
        reduced_due, _ = _financial_reduce_allocations(due_baseline, remaining)
        result["receiptAllocations"] = reduced_paid
        result["dueAllocations"] = reduced_due
        result["refundAllocationBaseline"] = paid_baseline
        result["refundDueBaseline"] = due_baseline
        result["refundType"] = refund_type
        result["refundAmount"] = _financial_usd(refund_amount)
        result["refundStatus"] = sanitize_str(str(requested.get("refundStatus") or "Pending"), 40)
        result["preRefundStatus"] = str(existing.get("preRefundStatus") or existing.get("status") or "Active")
        result["status"] = "Canceled"
        result["canceledBy"] = str(actor.get("id") or "")
        result["spentUSD"] = _financial_usd(ad_amount - refund_amount)
    paid = _financial_allocations(result.get("receiptAllocations"), "receiptAllocations")
    due = _financial_allocations(result.get("dueAllocations"), "dueAllocations")
    result["receiptAllocations"] = paid
    result["dueAllocations"] = due
    if str(result.get("paymentStatus") or "") == "not_paid" and str(result.get("collectionMethod") or "") == "driver":
        result["mergedPaidAllocations"] = paid
    result["receiptIds"] = [row["receiptId"] for row in paid]
    result["fundingReceiptId"] = paid[0]["receiptId"] if paid else ""
    result["dueAmountToUseUSD"] = _financial_usd(
        sum(_financial_minor(row["amountUSD"], "due allocation") for row in due)
    )
    # The usage readers fall back to the LYD half whenever the USD half is zero, so a stale
    # value would re-lock the very credit this refund is returning. Clearing it is safe ONLY
    # because the baseline above already folded it into a real allocation row — never zero
    # this without folding first, or an ad's true due usage is erased and the receipt reads
    # as free while the ad still holds it.
    result["dueAmountToUseLYD"] = 0.0
    result["hasMergedPaidFunds"] = bool(paid) and str(result.get("paymentStatus")) == "not_paid"
    return result


def _financial_validate_ad_plan(
    ad: dict[str, Any],
    *,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    current_ad_id: str,
) -> None:
    customer_id = validate_entity_id(ad.get("customerId"))
    paid = _financial_allocations(ad.get("receiptAllocations"), "receiptAllocations")
    _financial_validate_paid_receipts(
        paid,
        customer_id=customer_id,
        locked_receipts=locked_receipts,
        ad_rows=ad_rows,
        current_ad_id=current_ad_id,
    )
    due = _financial_allocations(ad.get("dueAllocations"), "dueAllocations")
    linked = str(ad.get("linkedDeliveryReceiptId") or "")
    if due:
        _financial_validate_due_receipt(
            due,
            linked_receipt_id=validate_entity_id(linked),
            customer_id=customer_id,
            locked_receipts=locked_receipts,
            ad_rows=ad_rows,
            current_ad_id=current_ad_id,
            require_pending=False,
        )
    # Cap the ad's TOTAL draw per receipt across both pools (refund-undo / stop rebuild
    # allocations, so this re-take must fit what the receipt has left).
    _financial_validate_combined_capacity(
        paid,
        due,
        locked_receipts=locked_receipts,
        ad_rows=ad_rows,
        current_ad_id=current_ad_id,
    )


def _ad_mutation_atomic(
    actor: dict[str, Any], body: AdMutationRequest
) -> tuple[dict[str, Any], bool]:
    actor_id = validate_entity_id(actor.get("id"))
    ad_id = validate_entity_id(body.adId)
    idem = sanitize_str(body.idempotencyKey, 120)
    clean_request = sanitize_json(body.data or {}) or {}
    validate_relationship_ids(clean_request, "ad data")
    request_hash = _financial_request_hash(
        {
            "action": body.action,
            "adId": ad_id,
            "expectedLastModified": body.expectedLastModified,
            "data": clean_request,
        }
    )
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            _lock_idempotency_key(conn, idem, postgres=postgres, namespace="adFunding")
            prior = _financial_check_marker(
                _financial_get_marker(conn, AD_FUNDING_MUTATION_COLLECTION, "adFunding", idem),
                actor_id,
                request_hash,
            )
            if prior:
                return _financial_entity_result(conn, "ads", str(prior.get("adId"))), True

            initial_row = _clothes_lock_row(conn, "ads", ad_id, postgres=False)
            initial_data = _financial_row_data(initial_row) if initial_row else {}
            if body.action == "create":
                if not user_has_permission(actor, "ads", "add"):
                    raise HTTPException(status_code=403, detail="Forbidden")
                if initial_row:
                    raise HTTPException(status_code=409, detail="Ad ID already exists")
            else:
                if not initial_row or bool(initial_row["deleted"]):
                    raise HTTPException(status_code=404, detail="Ad not found")
                if body.expectedLastModified is None:
                    raise HTTPException(status_code=400, detail="expectedLastModified is required")

            # Discover both old and requested receipt identities before taking
            # row locks. Re-reading the ad after the locks detects any race.
            discovery = dict(initial_data)
            discovery.update(clean_request)
            receipt_ids = _financial_receipt_ids(discovery) | _financial_receipt_ids(initial_data)
            locked_receipts = _financial_lock_receipts(conn, receipt_ids, postgres=postgres)
            ad_row = _clothes_lock_row(conn, "ads", ad_id, postgres=postgres)
            if body.action == "create":
                if ad_row:
                    raise HTTPException(status_code=409, detail="Ad ID already exists")
                existing: dict[str, Any] | None = None
            else:
                if not ad_row or bool(ad_row["deleted"]):
                    raise HTTPException(status_code=404, detail="Ad not found")
                if int(ad_row["last_modified"]) != int(body.expectedLastModified):
                    raise HTTPException(status_code=409, detail="Conflict: ad has changed")
                existing = _financial_row_data(ad_row)
                creator = ad_row.get("created_by") or existing.get("creatorId")
                if not user_has_permission(
                    actor, "ads", "edit", record_creator_id=str(creator or "")
                ):
                    raise HTTPException(status_code=403, detail="Forbidden")
                if _financial_receipt_ids(existing) - set(locked_receipts):
                    raise HTTPException(status_code=409, detail="Conflict: ad funding has changed")

            is_refund = body.action == "update" and "refundType" in clean_request
            if existing is not None and not is_refund and (
                str(existing.get("status") or "") in {"Stopped", "Canceled", "Completed", "Lost"}
                or (existing.get("refundType") and str(existing.get("refundType")) != "None")
            ):
                raise HTTPException(status_code=409, detail="A terminal or refunded ad cannot be edited")
            ad_rows = _financial_active_rows(conn, "ads")
            is_topup = body.action == "update" and "topUps" in clean_request and not is_refund
            if is_refund:
                assert existing is not None
                saved_data = _financial_apply_refund(actor, clean_request, existing)
                _financial_validate_ad_plan(
                    saved_data,
                    locked_receipts=locked_receipts,
                    ad_rows=ad_rows,
                    current_ad_id=ad_id,
                )
            else:
                prepared_request = dict(clean_request)
                if is_topup:
                    assert existing is not None
                    if str(existing.get("paymentStatus") or "") != "paid" or str(existing.get("status") or "") in {
                        "Canceled", "Completed", "Lost", "Stopped"
                    } or (existing.get("refundType") and existing.get("refundType") != "None"):
                        raise HTTPException(status_code=409, detail="Only active paid ads can be topped up")
                    topups, topup_total = _financial_topups(clean_request.get("topUps"))
                    old_topups = existing.get("topUps") if isinstance(existing.get("topUps"), list) else []
                    old_topup_total = sum(
                        _financial_minor(row.get("amount"), "stored top-up")
                        for row in old_topups
                        if isinstance(row, dict)
                    )
                    old_amount = _financial_minor(existing.get("amountUSD"), "ad amount")
                    base_minor = _financial_minor(existing.get("initialAmountUSD"), "initial ad amount") \
                        if existing.get("initialAmountUSD") is not None \
                        else max(old_amount - old_topup_total, 0)
                    expected_total = base_minor + topup_total
                    supplied_allocations = _financial_allocations(
                        clean_request.get("receiptAllocations", existing.get("receiptAllocations")),
                        "receiptAllocations",
                        allow_empty=False,
                    )
                    if sum(_financial_minor(row["amountUSD"], "allocation") for row in supplied_allocations) != expected_total:
                        raise HTTPException(status_code=400, detail="Top-up allocations do not match the server total")
                    prepared_request = {
                        **existing,
                        **clean_request,
                        "topUps": topups,
                        "receiptAllocations": supplied_allocations,
                    }
                    base_end_raw = str(existing.get("initialEndDate") or existing.get("endDate") or "")
                    if base_end_raw:
                        try:
                            base_end = datetime.fromisoformat(base_end_raw.replace("Z", "+00:00"))
                        except ValueError:
                            raise HTTPException(status_code=409, detail="Stored ad end date is invalid")
                        if base_end.tzinfo is None:
                            base_end = base_end.replace(tzinfo=timezone.utc)
                        extension_days = sum(int(row.get("extendDays") or 0) for row in topups)
                        prepared_request["initialEndDate"] = _iso_utc(base_end)
                        prepared_request["endDate"] = _iso_utc(
                            base_end + timedelta(days=extension_days)
                        )
                saved_data = _financial_derive_ad(
                    actor,
                    prepared_request,
                    existing,
                    locked_receipts=locked_receipts,
                    ad_rows=ad_rows,
                    current_ad_id=ad_id if existing else None,
                )
                if is_topup:
                    saved_data["initialAmountUSD"] = _financial_usd(base_minor)

            # The customer itself must be active; funding receipts were already
            # locked in deterministic order above.
            customer_id = validate_entity_id(saved_data.get("customerId"))
            customer_row = _clothes_lock_row(conn, "customers", customer_id, postgres=postgres)
            if not customer_row or bool(customer_row["deleted"]):
                raise HTTPException(status_code=404, detail="Ad customer not found")

            if body.action == "create":
                saved = _insert_entity_in_transaction(conn, "ads", ad_id, saved_data, actor_id)
            else:
                assert ad_row is not None
                saved = _clothes_write_row(conn, ad_row, saved_data)
            _financial_insert_marker(
                conn,
                AD_FUNDING_MUTATION_COLLECTION,
                "adFunding",
                idem,
                actor_id,
                request_hash,
                {"adId": ad_id},
            )
            return saved, False


def _financial_proportional_plan(
    entries: list[tuple[str, str, int]], target_minor: int
) -> dict[tuple[str, str], int]:
    """Allocate exact cents by baseline share using deterministic remainders."""
    positive = [(pool, receipt_id, amount) for pool, receipt_id, amount in entries if amount > 0]
    total = sum(amount for _, _, amount in positive)
    if not positive or total <= 0:
        return {(pool, receipt_id): 0 for pool, receipt_id, _ in entries}
    target = min(max(int(target_minor), 0), total)
    plan: dict[tuple[str, str], int] = {}
    remainders: list[tuple[int, str, str]] = []
    assigned = 0
    for pool, receipt_id, amount in positive:
        quotient, remainder = divmod(amount * target, total)
        plan[(pool, receipt_id)] = quotient
        assigned += quotient
        remainders.append((remainder, pool, receipt_id))
    for _remainder, pool, receipt_id in sorted(
        remainders, key=lambda row: (-row[0], row[1], row[2])
    )[: target - assigned]:
        plan[(pool, receipt_id)] += 1
    for pool, receipt_id, _ in entries:
        plan.setdefault((pool, receipt_id), 0)
    return plan


def _financial_stop_baseline(ad: dict[str, Any]) -> dict[str, Any]:
    stored = ad.get("stopAllocationBaseline")
    if isinstance(stored, dict):
        receipt = _financial_allocations(stored.get("receipt"), "stop baseline receipt")
        due = _financial_allocations(stored.get("due"), "stop baseline due")
        merged = _financial_allocations(stored.get("merged"), "stop baseline merged")
        legacy = _financial_minor(stored.get("dueLegacy"), "stop baseline legacy due")
        return {
            "receipt": receipt,
            "due": due,
            "merged": merged,
            "dueLegacy": _financial_usd(legacy),
        }
    receipt = _financial_allocations(ad.get("receiptAllocations"), "receiptAllocations")
    due = _financial_allocations(ad.get("dueAllocations"), "dueAllocations")
    merged = _financial_allocations(ad.get("mergedPaidAllocations"), "mergedPaidAllocations")
    legacy = 0
    if not due:
        legacy = _financial_minor(ad.get("dueAmountToUseUSD"), "legacy due allocation")
    return {
        "receipt": receipt,
        "due": due,
        "merged": merged,
        "dueLegacy": _financial_usd(legacy),
    }


def _financial_apply_stop(ad: dict[str, Any], spent_minor: int) -> dict[str, Any]:
    amount_minor = _financial_minor(ad.get("amountUSD"), "ad amount")
    if spent_minor < 0 or spent_minor > amount_minor:
        raise HTTPException(status_code=400, detail="Spent amount must be between zero and the ad amount")
    baseline = _financial_stop_baseline(ad)
    receipt_map = _financial_allocation_map(baseline.get("receipt"))
    due_map = _financial_allocation_map(baseline.get("due"))
    legacy_minor = _financial_minor(baseline.get("dueLegacy"), "stop baseline legacy due")
    linked_id = str(ad.get("linkedDeliveryReceiptId") or "")
    entries: list[tuple[str, str, int]] = [
        *(('receipt', receipt_id, amount) for receipt_id, amount in sorted(receipt_map.items())),
        *(('due', receipt_id, amount) for receipt_id, amount in sorted(due_map.items())),
    ]
    if legacy_minor and linked_id:
        entries.append(("legacyDue", linked_id, legacy_minor))
    pool_total = sum(entry[2] for entry in entries)
    if pool_total > 0 and spent_minor > pool_total:
        raise HTTPException(status_code=409, detail="Spent amount exceeds the ad's funding baseline")
    plan = _financial_proportional_plan(entries, spent_minor)
    receipt_plan = [
        {"receiptId": receipt_id, "amountUSD": _financial_usd(plan[("receipt", receipt_id)])}
        for receipt_id in sorted(receipt_map)
    ]
    due_plan = [
        {"receiptId": receipt_id, "amountUSD": _financial_usd(plan[("due", receipt_id)])}
        for receipt_id in sorted(due_map)
    ]
    result = dict(ad)
    result["stopAllocationBaseline"] = baseline
    result["receiptAllocations"] = receipt_plan
    result["dueAllocations"] = due_plan
    if str(result.get("paymentStatus") or "") == "not_paid" and str(result.get("collectionMethod") or "") == "driver":
        result["mergedPaidAllocations"] = [dict(row) for row in receipt_plan]
    else:
        result["mergedPaidAllocations"] = []
    due_total = sum(plan[("due", receipt_id)] for receipt_id in due_map)
    if legacy_minor and linked_id:
        due_total += plan[("legacyDue", linked_id)]
    result["dueAmountToUseUSD"] = _financial_usd(due_total)
    result["receiptIds"] = [row["receiptId"] for row in receipt_plan]
    result["fundingReceiptId"] = receipt_plan[0]["receiptId"] if receipt_plan else ""
    result["hasMergedPaidFunds"] = bool(receipt_plan) and str(result.get("paymentStatus")) == "not_paid"
    result["status"] = "Stopped"
    result["spentUSD"] = _financial_usd(spent_minor)
    if not result.get("stoppedAt"):
        result["stoppedAt"] = _iso_utc()
    result["lastUpdated"] = _iso_utc()
    return result


def _ad_stop_atomic(
    actor: dict[str, Any], ad_id_raw: str, body: AdStopRequest
) -> tuple[dict[str, Any], bool]:
    actor_id = validate_entity_id(actor.get("id"))
    ad_id = validate_entity_id(ad_id_raw)
    if not user_has_permission(actor, "ads", "stopAd"):
        raise HTTPException(status_code=403, detail="Forbidden")
    idem = sanitize_str(body.idempotencyKey, 120)
    request_hash = _financial_request_hash(
        {
            "adId": ad_id,
            "spentMinorUSD": body.spentMinorUSD,
            "expectedLastModified": body.expectedLastModified,
        }
    )
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            _lock_idempotency_key(conn, idem, postgres=postgres, namespace="adStop")
            prior = _financial_check_marker(
                _financial_get_marker(conn, AD_STOP_MUTATION_COLLECTION, "adStop", idem),
                actor_id,
                request_hash,
            )
            if prior:
                return _financial_entity_result(conn, "ads", str(prior.get("adId"))), True
            initial = _clothes_lock_row(conn, "ads", ad_id, postgres=False)
            if not initial or bool(initial["deleted"]):
                raise HTTPException(status_code=404, detail="Ad not found")
            initial_data = _financial_row_data(initial)
            locked_receipts = _financial_lock_receipts(
                conn, _financial_receipt_ids(initial_data), postgres=postgres
            )
            ad_row = _clothes_lock_row(conn, "ads", ad_id, postgres=postgres)
            if not ad_row or bool(ad_row["deleted"]):
                raise HTTPException(status_code=404, detail="Ad not found")
            if int(ad_row["last_modified"]) != int(body.expectedLastModified):
                raise HTTPException(status_code=409, detail="Conflict: ad has changed")
            ad = _financial_row_data(ad_row)
            if _financial_receipt_ids(ad) - set(locked_receipts):
                raise HTTPException(status_code=409, detail="Conflict: ad funding has changed")
            if str(ad.get("status") or "") in {"Canceled", "Completed", "Lost"} or (
                ad.get("refundType") and str(ad.get("refundType")) != "None"
            ):
                raise HTTPException(status_code=409, detail="A terminal or refunded ad cannot be stopped")
            plan = _financial_apply_stop(ad, int(body.spentMinorUSD))
            _financial_validate_ad_plan(
                plan,
                locked_receipts=locked_receipts,
                ad_rows=_financial_active_rows(conn, "ads"),
                current_ad_id=ad_id,
            )
            saved = _clothes_write_row(conn, ad_row, plan)
            _financial_insert_marker(
                conn,
                AD_STOP_MUTATION_COLLECTION,
                "adStop",
                idem,
                actor_id,
                request_hash,
                {"adId": ad_id},
            )
            return saved, False


def _financial_receipt_transferable(data: dict[str, Any]) -> bool:
    status = str(data.get("status") or "")
    return status not in {"Canceled", "Lost"} and (
        status == "Paid" or data.get("isPaid") is True
    )


def _financial_release_canceled_due(
    conn: Any,
    receipt_id: str,
    ad_rows: list[Any],
    *,
    postgres: bool,
) -> list[dict[str, Any]]:
    affected = [
        row
        for row in ad_rows
        if receipt_id in _financial_receipt_ids(_financial_row_data(row))
        and _financial_ad_due_usage(_financial_row_data(row), receipt_id) > 0
    ]
    saved: list[dict[str, Any]] = []
    for discovered in sorted(affected, key=lambda row: str(row.get("id") or "")):
        ad_row = _clothes_lock_row(
            conn, "ads", str(discovered["id"]), postgres=postgres
        )
        if not ad_row or bool(ad_row["deleted"]):
            continue
        ad = _financial_row_data(ad_row)
        due = [
            dict(entry)
            for entry in (ad.get("dueAllocations") or [])
            if isinstance(entry, dict) and str(entry.get("receiptId") or "") != receipt_id
        ]
        ad["dueAllocations"] = due
        if str(ad.get("linkedDeliveryReceiptId") or "") == receipt_id:
            ad["dueAmountToUseUSD"] = 0.0
            ad["dueAmountToUseLYD"] = 0.0
        baseline = ad.get("stopAllocationBaseline")
        if isinstance(baseline, dict):
            next_baseline = dict(baseline)
            next_baseline["due"] = [
                dict(entry)
                for entry in (baseline.get("due") or [])
                if isinstance(entry, dict) and str(entry.get("receiptId") or "") != receipt_id
            ]
            if str(ad.get("linkedDeliveryReceiptId") or "") == receipt_id:
                next_baseline["dueLegacy"] = 0.0
            ad["stopAllocationBaseline"] = next_baseline
        if isinstance(ad.get("refundDueBaseline"), list):
            ad["refundDueBaseline"] = [
                dict(entry)
                for entry in ad["refundDueBaseline"]
                if isinstance(entry, dict) and str(entry.get("receiptId") or "") != receipt_id
            ]
        saved.append(_clothes_write_row(conn, ad_row, ad))
    return saved


def _financial_patch_receipt_atomic(
    actor: dict[str, Any],
    receipt_id_raw: str,
    updates: dict[str, Any],
    expected_last_modified: int | None,
) -> dict[str, Any]:
    receipt_id = validate_entity_id(receipt_id_raw)
    clean = sanitize_json(updates or {}) or {}
    if set(clean) & (RECEIPT_TRANSFER_FIELDS - {"receiptType"}):
        raise HTTPException(status_code=405, detail="Receipt transfer fields are server-controlled")
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "receipts", receipt_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Receipt not found")
            if expected_last_modified is not None and int(row["last_modified"]) != int(expected_last_modified):
                raise HTTPException(status_code=409, detail="Conflict: receipt has changed")
            old = _financial_row_data(row)
            if "receiptType" in clean:
                requested_type = str(clean.get("receiptType") or "")
                old_type = str(old.get("receiptType") or "")
                if old_type == "TRANSFER_IN" or requested_type != old_type:
                    raise HTTPException(status_code=405, detail="Receipt type is server-controlled")
                clean.pop("receiptType", None)
            if str(old.get("receiptType") or "") == "TRANSFER_IN" and set(clean) & RECEIPT_CAPACITY_FIELDS:
                raise HTTPException(status_code=405, detail="Transferred-in receipt money fields are immutable")
            merged = dict(old)
            for key in ("id", "_created", "_lastModified", "_deleted", "createdBy", "createdAt", "creatorId"):
                clean.pop(key, None)
            merged.update(clean)
            ad_rows = _financial_active_rows(conn, "ads")
            if str(merged.get("deliveryStatus") or "") == "Canceled" and str(old.get("deliveryStatus") or "") != "Canceled":
                _financial_release_canceled_due(
                    conn, receipt_id, ad_rows, postgres=postgres
                )
                ad_rows = _financial_active_rows(conn, "ads")
            general_used = _financial_usage(ad_rows, receipt_id)
            due_used = _financial_usage(ad_rows, receipt_id, due=True)
            primary_used = max(general_used - due_used, 0)
            outgoing = _financial_outgoing(old)
            # ONE capacity, same function the readers use: amountUSD once collected, else the
            # debt the driver will collect (_financial_due_total). Measuring commitments
            # against the raw amountUSD instead used the *collected cash* as the cap on a
            # still-uncollected delivery receipt — so an underpaid completion (amountUSD drops
            # to the low collected amount while the debt-backed due credit is still fully
            # committed) and every later benign PATCH on it (office handover, corrections)
            # 409'd, stranding the receipt. The debt basis keeps the committed credit backed;
            # the shortfall lives only as remainingDue and is never spendable.
            capacity = _financial_due_total(merged)
            if capacity < general_used + outgoing:
                raise HTTPException(status_code=409, detail="Receipt amount is below committed ads and transfers")
            if capacity < due_used:
                raise HTTPException(status_code=409, detail="Receipt due amount is below committed ads")
            if (primary_used > 0 or outgoing > 0) and not _financial_receipt_transferable(merged):
                raise HTTPException(status_code=409, detail="A funded or transferred receipt must remain paid")
            if str(merged.get("customerId") or "") != str(old.get("customerId") or "") and (
                general_used > 0 or outgoing > 0
            ):
                raise HTTPException(status_code=409, detail="A committed receipt cannot change customer")
            return _clothes_write_row(conn, row, merged)


def _financial_receipt_reference_reason(
    conn: Any, receipt_id: str, data: dict[str, Any] | None = None
) -> str | None:
    receipt = data
    if receipt is None:
        row = _clothes_lock_row(conn, "receipts", receipt_id, postgres=False)
        if not row or bool(row["deleted"]):
            return None
        receipt = _financial_row_data(row)
    if _financial_outgoing(receipt) > 0:
        return "outgoing transfer"
    if str(receipt.get("receiptType") or "") == "TRANSFER_IN" or receipt.get("transferFromReceiptId"):
        return "incoming transfer"
    for ad_row in _financial_active_rows(conn, "ads"):
        if receipt_id in _financial_receipt_ids(_financial_row_data(ad_row)):
            return "ad funding"
    for other_row in _financial_active_rows(conn, "receipts"):
        if str(other_row.get("id") or "") == receipt_id:
            continue
        other = _financial_row_data(other_row)
        if str(other.get("transferFromReceiptId") or "") == receipt_id:
            return "linked transfer receipt"
        for transfer in other.get("transfers") or []:
            if isinstance(transfer, dict) and str(transfer.get("toReceiptId") or "") == receipt_id:
                return "linked transfer"
    return None


def _financial_delete_receipt_atomic(receipt_id_raw: str) -> dict[str, Any]:
    receipt_id = validate_entity_id(receipt_id_raw)
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "receipts", receipt_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Not found")
            data = _financial_row_data(row)
            reason = _financial_receipt_reference_reason(conn, receipt_id, data)
            if reason:
                raise HTTPException(status_code=409, detail=f"Receipt cannot be deleted while linked to {reason}")
            return _clothes_write_row(conn, row, data, deleted=True)


def _financial_delete_customer_atomic(customer_id_raw: str) -> dict[str, Any]:
    """Delete an unreferenced customer without allowing a partial cascade."""
    customer_id = validate_entity_id(customer_id_raw)
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK
    with guard:
        with db_conn() as conn:
            row = _clothes_lock_row(conn, "customers", customer_id, postgres=postgres)
            if not row or bool(row["deleted"]):
                raise HTTPException(status_code=404, detail="Not found")
            for collection in ("receipts", "ads"):
                for linked_row in _financial_active_rows(conn, collection):
                    linked = _financial_row_data(linked_row)
                    if str(linked.get("customerId") or "") == customer_id:
                        raise HTTPException(
                            status_code=409,
                            detail="Customer cannot be deleted while linked records exist",
                        )
            return _clothes_write_row(
                conn, row, _financial_row_data(row), deleted=True
            )


@app.post("/api/receipts/transfers", response_model=ReceiptTransferResponse)
def transfer_receipt_balance(
    body: ReceiptTransferRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    source, target, transfer, replayed = _receipt_transfer_atomic(user, body)
    if not replayed:
        audit(
            str(user.get("id")),
            "transfer",
            "receipts",
            source["id"],
            "Transferred receipt balance",
            {"targetReceiptId": target["id"], "amountUSD": transfer.get("amountUSD")},
        )
    return ReceiptTransferResponse(
        sourceReceipt=EntityResponse(**source),
        targetReceipt=EntityResponse(**target),
        transfer=transfer,
        replayed=replayed,
    )


@app.post("/api/ads/mutate", response_model=AdMutationResponse)
def mutate_ad_funding(
    body: AdMutationRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    ad, replayed = _ad_mutation_atomic(user, body)
    if not replayed:
        audit(
            str(user.get("id")), body.action, "ads", ad["id"], f"Ad {body.action}", {}
        )
    return AdMutationResponse(ad=EntityResponse(**ad), replayed=replayed)


@app.post("/api/ads/{ad_id}/stop", response_model=AdStopResponse)
def stop_ad_atomic(
    ad_id: str,
    body: AdStopRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    ad, replayed = _ad_stop_atomic(user, ad_id, body)
    if not replayed:
        audit(str(user.get("id")), "stop", "ads", ad["id"], "Stopped ad", {})
    return AdStopResponse(ad=EntityResponse(**ad), replayed=replayed)


@app.post(
    "/api/clothes/shipments/mutate",
    response_model=ClothesShipmentMutationResponse,
)
def mutate_clothes_shipment(
    body: ClothesShipmentMutationRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    _require_clothes_subscription(user)
    shipment, updated_products, replayed = _clothes_shipment_mutation_atomic(
        user,
        action=body.action,
        idempotency_key=body.idempotencyKey,
        shipment_id=body.shipmentId,
        expected_last_modified=body.expectedLastModified,
        status=body.status,
    )
    if not replayed:
        audit(
            str(user.get("id")),
            body.action,
            "clothesShipments",
            shipment["id"],
            f"Clothes shipment {body.action}",
            {"updatedProducts": [product["id"] for product in updated_products]},
        )
    return ClothesShipmentMutationResponse(
        shipment=EntityResponse(**shipment),
        updatedProducts=[EntityResponse(**product) for product in updated_products],
        replayed=replayed,
    )


@app.post("/api/wallet/transfers", response_model=EntityResponse)
def create_wallet_transfer(
    body: WalletTransferRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    saved, created = _wallet_transfer_atomic(
        user,
        to_user_id=body.toUserId,
        amount_minor=body.amountMinor,
        currency=body.currency,
        idempotency_key=body.idempotencyKey,
        memo=body.memo,
    )
    if created:
        audit(str(user.get("id")), "create", "walletTransactions", saved["id"], "Created wallet transfer", {})
    return EntityResponse(**saved)


@app.post("/api/wallet/top-ups", response_model=EntityResponse)
def create_wallet_top_up(
    body: WalletTopUpRequest,
    request: Request,
    admin: dict[str, Any] = Depends(require_admin),
):
    require_same_origin(request)
    saved, created = _wallet_top_up_atomic(
        admin,
        user_id=body.userId,
        amount_minor=body.amountMinor,
        currency=body.currency,
        idempotency_key=body.idempotencyKey,
        memo=body.memo,
    )
    if created:
        audit(str(admin.get("id")), "create", "walletTransactions", saved["id"], "Created wallet top-up", {})
    return EntityResponse(**saved)


@app.post("/api/wallet/reversals", response_model=EntityResponse)
def create_wallet_reversal(
    body: WalletReversalRequest,
    request: Request,
    admin: dict[str, Any] = Depends(require_admin),
):
    require_same_origin(request)
    saved, created = _wallet_reversal_atomic(admin, body.transactionId, body.memo)
    if created:
        audit(str(admin.get("id")), "create", "walletTransactions", saved["id"], "Created wallet reversal", {})
    return EntityResponse(**saved)


@app.post("/api/subscriptions/purchase", response_model=EntityResponse)
def purchase_subscription(
    body: SubscriptionPurchaseRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    saved, created, payment = _subscription_purchase_atomic(
        user,
        service_id=body.serviceId,
        idempotency_key=body.idempotencyKey,
        user_id=body.userId,
    )
    if created:
        audit(
            str(user.get("id")),
            "create",
            "serviceSubscriptions",
            saved["id"],
            f"Purchased subscription {body.serviceId}",
            {"paymentTxId": payment.get("id") if payment else None},
        )
    return EntityResponse(**saved)


def _owns_personal_record(collection: str, data: dict[str, Any] | None, uid: str) -> bool:
    d = data or {}
    if collection == "walletTransactions":
        return str(d.get("fromUserId") or "") == uid or str(d.get("toUserId") or "") == uid
    return str(d.get("userId") or "") == uid


# Fields a PATCH may touch under the deliveries.* permissions (office staff
# managing the delivery workflow on ads/receipts without full edit rights).
_DELIVERY_WORKFLOW_FIELDS = {
    "deliveryPersonId", "deliveryStatus", "acceptedDate", "deliveredAt",
    "isReceivedInOffice", "receivedInOfficeAt", "officeHandover", "officeHandoverAt",
    "deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy",
    "deliveryNotes", "_lastModified",
}

_DELIVERY_PAYMENT_FIELDS = {
    "isPaid", "status", "collectionDate", "paymentResult", "overpaidAmount",
    "remainingDue", "feeDifferenceStatus", "feeDiff", "debtAmountLocal",
    "debtAmountUSD", "amountLocal", "amountUSD", "amountCollectedFromCustomer",
    "actualDeliveryFeeCollected", "deliveryFeeCollected", "finalReceiptNo",
    "serialNumber", "receiptImage", "photos",
}

_DELIVERY_TRANSITIONS: dict[str, set[str]] = {
    "": {"Needs Delivery", "In Progress", "Office"},
    "Office": {"Needs Delivery", "In Progress"},
    "Needs Delivery": {"In Progress", "Canceled", "Office"},
    "In Progress": {"Canceled"},  # Delivered uses assigned-driver proof flow.
    "Delivered": set(),
    "Canceled": set(),
}


def _active_delivery_user(user_id: Any) -> bool:
    uid = sanitize_str(str(user_id or ""))[:80]
    if not uid:
        return False
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE id=:id AND lower(role)='delivery' AND deleted=false LIMIT 1"),
            {"id": uid},
        ).first()
    return row is not None


def _delivery_patch_allowed(user: dict[str, Any], existing: dict[str, Any], updates: dict[str, Any]) -> bool:
    """The deliveries permission group (assign/reassign/accept/complete/
    markCollected) previously had no server-side meaning for non-delivery
    roles — the frontend gates delivery actions on it, but the server only
    accepted ads/receipts edit. Allow a PATCH that touches ONLY delivery-
    workflow fields when the caller holds the matching deliveries.* grants."""
    keys = set(updates.keys())
    if not keys or not keys.issubset(_DELIVERY_WORKFLOW_FIELDS):
        return False

    def has(action: str) -> bool:
        return user_has_permission(user, "deliveries", action)

    data = existing.get("data") or {}
    current_status = str(data.get("deliveryStatus") or "").strip()
    target_status = str(updates.get("deliveryStatus") or "").strip()

    if "deliveryPersonId" in keys:
        if current_status in {"Delivered", "Canceled"}:
            return False
        already = bool(str(data.get("deliveryPersonId") or "").strip())
        if not (has("reassign") if already else has("assign")):
            return False
        target_driver = str(updates.get("deliveryPersonId") or "").strip()
        if target_driver and not _active_delivery_user(target_driver):
            return False

    if target_status:
        if target_status == "Delivered":
            # Completion is handled only by the assigned-driver branch, which
            # verifies final receipt number, photo and collected amounts.
            return False
        if target_status != current_status:
            if target_status not in _DELIVERY_TRANSITIONS.get(current_status, set()):
                return False
            if target_status == "In Progress":
                if not has("accept"):
                    return False
            elif not (has("assign") or has("reassign")):
                return False

    if "acceptedDate" in keys and not (target_status == "In Progress" and has("accept")):
        return False

    cancel_fields = {"deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy"}
    if keys & cancel_fields:
        if current_status in {"Delivered", "Canceled"}:
            return False
        if target_status != "Canceled" or not (has("assign") or has("reassign")):
            return False
        if not str(updates.get("deliveryCancelReason") or "").strip():
            return False

    office_fields = {"isReceivedInOffice", "receivedInOfficeAt", "officeHandover", "officeHandoverAt"}
    if keys & office_fields:
        if not has("markCollected") or current_status != "Delivered":
            return False
        if "receivedInOfficeAt" in keys and "isReceivedInOffice" not in keys:
            return False
        if "officeHandoverAt" in keys and "officeHandover" not in keys:
            return False

    if "deliveredAt" in keys:
        return False
    if "deliveryNotes" in keys and not (has("accept") or has("assign") or has("reassign")):
        return False
    return has("accept") or has("assign") or has("reassign") or has("markCollected")


SYNC_WATERMARK_COLLECTIONS = (
    "ads",
    "receipts",
    "customers",
    "pages",
    "exchangeRateHistory",
    "clothesProducts",
    "clothesShipments",
    "clothesOrders",
    "clothesSettings",
    "walletTransactions",
    "serviceSubscriptions",
)


def _sync_watermark_max(
    conn: Any,
    collection: str,
    *,
    created_by: str | None = None,
    assigned_to: str | None = None,
    personal_user_id: str | None = None,
    referenced_customer_by: str | None = None,
) -> int:
    dialect = str(get_engine().dialect.name or "")

    def json_value(alias: str, key: str) -> str:
        if dialect == "postgresql":
            return f"({alias}.data_json::jsonb ->> '{key}')"
        return f"json_extract({alias}.data_json, '$.{key}')"

    where = ["e.type=:type"]
    params: dict[str, Any] = {"type": collection}
    if created_by:
        where.append("e.created_by=:created_by")
        params["created_by"] = created_by
    if assigned_to:
        where.append(f"{json_value('e', 'deliveryPersonId')}=:assigned_to")
        params["assigned_to"] = assigned_to
    if personal_user_id:
        if collection == "walletTransactions":
            where.append(
                f"({json_value('e', 'fromUserId')}=:personal_uid OR "
                f"{json_value('e', 'toUserId')}=:personal_uid)"
            )
        else:
            where.append(f"{json_value('e', 'userId')}=:personal_uid")
        params["personal_uid"] = personal_user_id
    if referenced_customer_by:
        where.append(
            "EXISTS (SELECT 1 FROM entities d "
            "WHERE d.type IN ('ads','receipts') AND d.deleted=false "
            f"AND {json_value('d', 'customerId')}=e.id "
            f"AND {json_value('d', 'deliveryPersonId')}=:delivery_uid)"
        )
        params["delivery_uid"] = referenced_customer_by
    value = conn.execute(
        text(f"SELECT COALESCE(MAX(e.last_modified),0) FROM entities e WHERE {' AND '.join(where)}"),
        params,
    ).scalar()
    return max(0, int(value or 0))


@app.get("/api/sync/watermarks")
def get_sync_watermarks(user: dict[str, Any] = Depends(current_user)):
    """Capture visibility-scoped collection cursors before a keyset full load."""
    role_lower = str(user.get("role") or "").lower()
    uid = sanitize_str(str(user.get("id") or ""))[:80]
    clothes_entitled = _has_active_clothes_subscription(user)
    watermarks: dict[str, int] = {}
    with db_conn() as conn:
        if str(get_engine().dialect.name or "") == "postgresql":
            # All MAX reads below must describe one instant, not a sequence of
            # independently advancing READ COMMITTED snapshots.
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        for collection in SYNC_WATERMARK_COLLECTIONS:
            if collection in CLOTHES_BUSINESS_COLLECTIONS and not clothes_entitled:
                continue
            if collection in PERSONAL_SCOPED_COLLECTIONS and role_lower != "admin":
                if uid:
                    watermarks[collection] = _sync_watermark_max(
                        conn, collection, personal_user_id=uid
                    )
                continue
            if role_lower == "delivery":
                if collection in {"ads", "receipts"}:
                    watermarks[collection] = _sync_watermark_max(
                        conn, collection, assigned_to=uid
                    )
                elif collection == "customers":
                    watermarks[collection] = _sync_watermark_max(
                        conn, collection, referenced_customer_by=uid
                    )
                elif collection == "exchangeRateHistory":
                    watermarks[collection] = _sync_watermark_max(conn, collection)
                continue

            module = _module_for_collection(collection)
            action = _action_for_collection(collection, "view")
            can_view_all = collection == "exchangeRateHistory" or user_has_permission(
                user, module, action
            )
            if can_view_all:
                watermarks[collection] = _sync_watermark_max(conn, collection)
            elif uid and user_has_permission(
                user, module, action, record_creator_id=uid
            ):
                watermarks[collection] = _sync_watermark_max(
                    conn, collection, created_by=uid
                )
    return {"watermarks": watermarks}


@app.get("/api/collections/{collection}", response_model=list[EntityResponse])
def get_collection(
    collection: str,
    updated_since: Optional[int] = None,
    limit: int = 500,
    offset: int = 0,
    include_deleted: bool = False,
    before_created_at: Optional[int] = None,
    before_id: Optional[str] = None,
    after_last_modified: Optional[int] = None,
    after_id: Optional[str] = None,
    user: dict[str, Any] = Depends(current_user),
):
    role_lower = str(user.get("role") or "").lower()
    if collection in CLOTHES_BUSINESS_COLLECTIONS:
        _require_clothes_subscription(user)

    full_pair = before_created_at is not None or before_id is not None
    delta_pair = after_last_modified is not None or after_id is not None
    if (before_created_at is None) != (before_id is None):
        raise HTTPException(status_code=400, detail="before_created_at and before_id are required together")
    if (after_last_modified is None) != (after_id is None):
        raise HTTPException(status_code=400, detail="after_last_modified and after_id are required together")
    if full_pair and (updated_since is not None or delta_pair):
        raise HTTPException(status_code=400, detail="Full and delta cursors cannot be mixed")
    if delta_pair and updated_since is None:
        raise HTTPException(status_code=400, detail="updated_since is required with a delta cursor")
    if before_created_at is not None and before_created_at < 0:
        raise HTTPException(status_code=400, detail="Invalid full cursor")
    if after_last_modified is not None and after_last_modified < 0:
        raise HTTPException(status_code=400, detail="Invalid delta cursor")

    # Personal money records (wallet ledger, subscriptions): every non-admin —
    # regardless of role or granted permissions — receives ONLY their own rows.
    # Previously these 403'd for all non-delivery non-admins (no grantable
    # module exists), so employees' wallet/subscription data was silently
    # wiped to [] on every load.
    if collection in PERSONAL_SCOPED_COLLECTIONS and role_lower != "admin":
        uid = sanitize_str(str(user.get("id") or ""))[:80]
        if not uid:
            raise HTTPException(status_code=403, detail="Forbidden")
        rows = list_entities(
            collection,
            updated_since=updated_since,
            include_deleted=False,
            limit=limit,
            offset=offset,
            personal_user_id=uid,
            before_created_at=before_created_at,
            before_id=before_id,
            after_last_modified=after_last_modified,
            after_id=after_id,
        )
        return [EntityResponse(**i) for i in rows]

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
                before_created_at=before_created_at,
                before_id=before_id,
                after_last_modified=after_last_modified,
                after_id=after_id,
            )
            return [EntityResponse(**i) for i in items]

        if collection == "customers":
            items = list_entities(
                "customers",
                updated_since=updated_since,
                limit=limit,
                offset=offset,
                include_deleted=False,
                referenced_customer_by=uid,
                before_created_at=before_created_at,
                before_id=before_id,
                after_last_modified=after_last_modified,
                after_id=after_id,
            )
            return [EntityResponse(**i) for i in items]

    module = _module_for_collection(collection)
    action = _action_for_collection(collection, "view")
    can_view_all = user_has_permission(user, module, action)
    can_view_own = user_has_permission(user, module, action, record_creator_id=str(user.get("id") or ""))
    # Exchange-rate history is non-sensitive reference data every client needs
    # to render historical money conversions (same policy as /api/bootstrap) —
    # readable by ANY authenticated user. Writes stay gated on
    # settings.manageExchangeRate via _action_for_collection.
    if collection == "exchangeRateHistory":
        can_view_all = True
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
        before_created_at=before_created_at,
        before_id=before_id,
        after_last_modified=after_last_modified,
        after_id=after_id,
    )
    return [EntityResponse(**i) for i in items]


def _delivery_customer_is_referenced(customer_id: str, delivery_user_id: str) -> bool:
    """Whether an active assigned ad/receipt references this customer."""
    customer_id = validate_entity_id(customer_id)
    delivery_user_id = validate_entity_id(delivery_user_id)
    dialect = str(get_engine().dialect.name or "")
    with db_conn() as conn:
        try:
            if dialect == "postgresql":
                sql = (
                    "SELECT 1 FROM entities WHERE type IN ('ads','receipts') "
                    "AND deleted=false "
                    "AND (data_json::jsonb ->> 'customerId')=:customer_id "
                    "AND (data_json::jsonb ->> 'deliveryPersonId')=:delivery_user_id LIMIT 1"
                )
            else:
                sql = (
                    "SELECT 1 FROM entities WHERE type IN ('ads','receipts') "
                    "AND deleted=false "
                    "AND json_extract(data_json, '$.customerId')=:customer_id "
                    "AND json_extract(data_json, '$.deliveryPersonId')=:delivery_user_id LIMIT 1"
                )
            return conn.execute(
                text(sql),
                {"customer_id": customer_id, "delivery_user_id": delivery_user_id},
            ).first() is not None
        except Exception:
            # JSON SQL may be unavailable on older SQLite builds. This fallback
            # is unbounded on purpose: authorization must never become incorrect
            # merely because the referenced row is beyond a paging cap.
            rows = conn.execute(
                text(
                    "SELECT data_json FROM entities "
                    "WHERE type IN ('ads','receipts') AND deleted=false"
                )
            ).mappings().all()
            for row in rows:
                data = json_loads(row.get("data_json") or "{}") or {}
                if (
                    str(data.get("customerId") or "") == customer_id
                    and str(data.get("deliveryPersonId") or "") == delivery_user_id
                ):
                    return True
            return False


@app.get("/api/collections/{collection}/{entity_id}", response_model=EntityResponse)
def get_collection_item(
    collection: str,
    entity_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    role_lower = str(user.get("role") or "").lower()
    if collection in CLOTHES_BUSINESS_COLLECTIONS:
        _require_clothes_subscription(user)
    if role_lower == "delivery":
        if collection in {"ads", "receipts"}:
            item = get_entity(collection, entity_id)
            if not item or item.get("deleted"):
                raise HTTPException(status_code=404, detail="Not found")
            data = item.get("data") or {}
            if str(data.get("deliveryPersonId") or "") != str(user.get("id") or ""):
                raise HTTPException(status_code=403, detail="Forbidden")
            return EntityResponse(**item)
        if collection == "customers":
            item = get_entity(collection, entity_id)
            if not item or item.get("deleted"):
                raise HTTPException(status_code=404, detail="Not found")
            if not _delivery_customer_is_referenced(entity_id, str(user.get("id") or "")):
                raise HTTPException(status_code=403, detail="Forbidden")
            return EntityResponse(**item)
        # Exchange-rate history is intentionally public to all authenticated
        # roles; every other direct collection lookup is outside a driver's
        # assigned-delivery scope.
        if collection != "exchangeRateHistory":
            raise HTTPException(status_code=403, detail="Forbidden")

    # Personal money records: non-admins may fetch ONLY their own rows.
    if collection in PERSONAL_SCOPED_COLLECTIONS and role_lower != "admin":
        item = get_entity(collection, entity_id)
        if not item or item.get("deleted"):
            raise HTTPException(status_code=404, detail="Not found")
        if not _owns_personal_record(collection, item.get("data"), str(user.get("id") or "")):
            raise HTTPException(status_code=403, detail="Forbidden")
        return EntityResponse(**item)

    module = _module_for_collection(collection)
    action = _action_for_collection(collection, "view")
    # Exchange-rate history: non-sensitive reference data, readable by any
    # authenticated user (mirrors get_collection / bootstrap).
    if collection != "exchangeRateHistory" and not user_has_permission(user, module, action) and not user_has_permission(
        user, module, action, record_creator_id=str(user.get("id") or "")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")

    item = get_entity(collection, entity_id)
    if not item or item.get("deleted"):
        raise HTTPException(status_code=404, detail="Not found")

    # If user only has viewOwn, enforce creator ownership
    creator = item.get("createdBy") or (item.get("data") or {}).get("createdBy") or (item.get("data") or {}).get("creatorId")
    if collection == "exchangeRateHistory":
        return EntityResponse(**item)
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
    if collection in CLOTHES_BUSINESS_COLLECTIONS:
        _require_clothes_subscription(user)
    validate_relationship_ids(body.data)
    if collection in CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS:
        raise HTTPException(
            status_code=405,
            detail="Clothes orders must be changed through the transactional clothes API",
        )
    if collection in FINANCIAL_MUTATION_COLLECTIONS:
        raise HTTPException(status_code=405, detail="Financial mutation records are server-controlled")
    module = _module_for_collection(collection)

    # Compatibility bridge for existing clients: old builds still POST these
    # collections through the generic route.  They now go through exactly the
    # same server-authoritative atomic operations as the dedicated endpoints;
    # arbitrary ledger/subscription rows are never accepted.
    if collection == "walletTransactions":
        data = sanitize_json(body.data or {}) or {}
        tx_type = sanitize_str(str(data.get("type") or "")).lower()[:40]
        if tx_type == "credit":
            saved, created = _wallet_top_up_atomic(
                user,
                user_id=str(data.get("toUserId") or ""),
                amount_minor=data.get("amountMinor"),
                currency=data.get("currency"),
                idempotency_key=data.get("idempotencyKey"),
                memo=data.get("memo"),
                requested_id=body.id,
            )
        elif tx_type == "transfer":
            if str(data.get("fromUserId") or "") != str(user.get("id") or ""):
                raise HTTPException(status_code=403, detail="A transfer can only debit the authenticated user")
            saved, created = _wallet_transfer_atomic(
                user,
                to_user_id=str(data.get("toUserId") or ""),
                amount_minor=data.get("amountMinor"),
                currency=data.get("currency"),
                idempotency_key=data.get("idempotencyKey"),
                memo=data.get("memo"),
                requested_id=body.id,
            )
        elif tx_type == "reversal":
            saved, created = _wallet_reversal_atomic(
                user, str(data.get("referenceId") or ""), data.get("memo")
            )
        else:
            raise HTTPException(
                status_code=403,
                detail="Wallet ledger rows must be created through a supported server operation",
            )
        if created:
            audit(str(user.get("id")), "create", collection, saved["id"], f"Created wallet {tx_type}", {})
        return EntityResponse(**saved)

    if collection == "serviceSubscriptions":
        data = sanitize_json(body.data or {}) or {}
        saved, created, payment = _subscription_purchase_atomic(
            user,
            service_id=str(data.get("serviceId") or ""),
            idempotency_key=str(data.get("idempotencyKey") or ""),
            user_id=str(data.get("userId") or "") or None,
            requested_id=body.id,
        )
        if created:
            audit(
                str(user.get("id")),
                "create",
                collection,
                saved["id"],
                f"Purchased subscription {data.get('serviceId') or ''}",
                {"paymentTxId": payment.get("id") if payment else None},
            )
        return EntityResponse(**saved)

    if not user_has_permission(user, module, _action_for_collection(collection, "add")):
        raise HTTPException(status_code=403, detail="Forbidden")

    generic_data = sanitize_json(body.data or {}) or {}
    if collection == "ads" and (
        set(generic_data) & AD_FUNDING_FIELDS
        or str(generic_data.get("status") or "") == "Stopped"
    ):
        raise HTTPException(status_code=405, detail="Ad funding must use /api/ads/mutate")
    if collection == "receipts" and (
        str(generic_data.get("receiptType") or "") == "TRANSFER_IN"
        or set(generic_data) & (RECEIPT_TRANSFER_FIELDS - {"receiptType"})
    ):
        raise HTTPException(status_code=405, detail="Transferred receipts must use /api/receipts/transfers")

    entity_id = validate_entity_id(body.id or new_id(collection[:10] or "id"))

    # Create must not overwrite existing records
    if get_entity_meta(collection, entity_id):
        raise HTTPException(status_code=409, detail="ID already exists")

    # Normalize/validate certain flows server-side (multi-user safe).
    if collection == "clothesProducts":
        body_data = sanitize_json(body.data or {}) or {}
        body_data["variants"] = _clothes_validate_variants(
            body_data.get("variants", [])
        )
    elif collection == "ads":
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
    elif collection == "clothesShipments":
        body_data = sanitize_json(body.data or {}) or {}
        # Receiving is inventory-affecting and must use the transactional API.
        body_data["status"] = "Ordered"
        body_data["stockApplied"] = False
        body_data["receivedAt"] = None
    else:
        body_data = body.data

    if collection in {"clothesProducts", "clothesShipments"}:
        saved = _clothes_create_inventory_entity_atomic(
            user, collection, entity_id, body_data
        )
    else:
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
    if collection in CLOTHES_BUSINESS_COLLECTIONS:
        _require_clothes_subscription(user)
    validate_relationship_ids(body.data)
    if collection in CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS:
        raise HTTPException(
            status_code=405,
            detail="Clothes orders must be changed through the transactional clothes API",
        )
    if collection in FINANCIAL_MUTATION_COLLECTIONS:
        raise HTTPException(status_code=405, detail="Financial mutation records are server-controlled")
    module = _module_for_collection(collection)

    existing = get_entity(collection, entity_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")

    financial_updates = sanitize_json(body.data or {}) or {}
    if collection == "ads":
        existing_status = str((existing.get("data") or {}).get("status") or "")
        requested_status = str(financial_updates.get("status") or "")
        collection_completion = (
            set(financial_updates).issubset({"isPaid", "status", "collectionDate", "deliveryStatus", "_lastModified"})
            and financial_updates.get("isPaid") is True
            and requested_status == "Completed"
            and existing_status not in {"Stopped", "Canceled", "Completed", "Lost"}
        )
        if (set(financial_updates) & AD_FUNDING_FIELDS and not collection_completion) or requested_status == "Stopped" or (
            existing_status == "Stopped" and requested_status and requested_status != "Stopped"
        ):
            raise HTTPException(status_code=405, detail="Ad funding and stopping require the transactional ad API")
    if collection == "receipts":
        old_receipt_type = str((existing.get("data") or {}).get("receiptType") or "")
        if set(financial_updates) & (RECEIPT_TRANSFER_FIELDS - {"receiptType"}):
            raise HTTPException(status_code=405, detail="Receipt transfer fields are server-controlled")
        if "receiptType" in financial_updates and (
            old_receipt_type == "TRANSFER_IN"
            or str(financial_updates.get("receiptType") or "") != old_receipt_type
        ):
            raise HTTPException(status_code=405, detail="Receipt type is server-controlled")

    if collection == "clothesShipments":
        shipment_updates = sanitize_json(body.data or {}) or {}
        if set(shipment_updates) & {"status", "stockApplied", "receivedAt"}:
            raise HTTPException(
                status_code=405,
                detail="Shipment status must be changed through the transactional clothes API",
            )
        shipment_data = existing.get("data") or {}
        if str(shipment_data.get("status") or "") == "Received" or shipment_data.get("stockApplied") is True:
            raise HTTPException(status_code=409, detail="A received shipment cannot be edited")

    # The wallet is an append-only ledger.  Admins correct mistakes with the
    # reversal endpoint; nobody may rewrite a posted historical row.
    if collection == "walletTransactions":
        raise HTTPException(status_code=405, detail="Wallet transactions are immutable; create a reversal")

    role_lower = str(user.get("role") or "").lower()
    # Delivery users can update ONLY their assigned deliveries.
    if role_lower == "delivery" and collection in {"ads", "receipts"}:
        data = existing.get("data") or {}
        if str(data.get("deliveryPersonId") or "") != str(user.get("id") or ""):
            raise HTTPException(status_code=403, detail="Forbidden")

        updates = sanitize_json(body.data or {}) or {}
        submitted_keys = set(updates.keys())
        # Remove protected keys + disallow reassignment
        for k in ["id", "_created", "createdBy", "createdAt", "creatorId", "deliveryPersonId"]:
            updates.pop(k, None)

        if collection == "ads":
            if submitted_keys & (_DELIVERY_PAYMENT_FIELDS | {"isReceivedInOffice", "receivedInOfficeAt"}):
                raise HTTPException(
                    status_code=403,
                    detail="Delivery users cannot change payment or office-handover fields",
                )
            allowed_fields = {
                "deliveryStatus",
                "acceptedDate",
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
            if "acceptedDate" in submitted_keys and desired != "In Progress":
                raise HTTPException(status_code=403, detail="acceptedDate is server-controlled")
            if submitted_keys & {"deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy"} and desired != "Canceled":
                raise HTTPException(status_code=403, detail="Cancellation metadata requires a Canceled transition")
            if desired == "In Progress":
                updates["acceptedDate"] = _iso_utc()

            # SECURITY: ad deliveries are intentionally proof-less (the driver
            # legitimately sets isPaid/status via the collection flow, so those
            # fields stay writable — unlike receipts). But a terminal delivery
            # state must be final: a delivery-role user must NOT be able to move
            # an ad OUT of 'Delivered' or 'Canceled' (the receipts branch already
            # enforces this). This blocks re-opening a completed/cancelled ad
            # delivery without touching any legitimate forward flow.
            current_status = str(data.get("deliveryStatus") or "").strip()
            if desired and desired != current_status and current_status in {"Delivered", "Canceled"}:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot change delivery status from '{current_status}' - this is a terminal state",
                )

            valid_ad_transitions = {
                "": {"Needs Delivery", "In Progress"},
                "Needs Delivery": {"In Progress", "Canceled"},
                "In Progress": {"Delivered", "Canceled"},
                "Delivered": set(),
                "Canceled": set(),
            }
            if desired and desired != current_status and desired not in valid_ad_transitions.get(current_status, set()):
                raise HTTPException(status_code=400, detail="Invalid ad delivery status transition")
            if desired == "Delivered" and data.get("isPaid") is not True:
                raise HTTPException(
                    status_code=400,
                    detail="Ad payment must be confirmed by an authorized office workflow before delivery completion",
                )

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
            if submitted_keys & {"isReceivedInOffice", "receivedInOfficeAt", "officeHandover", "officeHandoverAt"}:
                raise HTTPException(status_code=403, detail="Drivers cannot mark office handover")
            submitted_status = str(updates.get("deliveryStatus") or "").strip()
            if submitted_status != "Delivered" and submitted_keys & _DELIVERY_PAYMENT_FIELDS:
                raise HTTPException(
                    status_code=403,
                    detail="Settlement fields are only accepted during verified delivery completion",
                )
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
            if "acceptedDate" in submitted_keys and desired != "In Progress":
                raise HTTPException(status_code=403, detail="acceptedDate is server-controlled")
            if submitted_keys & {"deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy"} and desired != "Canceled":
                raise HTTPException(status_code=403, detail="Cancellation metadata requires a Canceled transition")
            if desired == "In Progress":
                updates["acceptedDate"] = _iso_utc()

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
                # SECURITY: a finalized delivery is TERMINAL. The transition
                # check above only fires when desired != current_status, so a
                # Delivered->Delivered no-op slipped through and re-ran this
                # settlement computation — letting the assigned driver rewrite
                # amountCollectedFromCustomer, amountUSD, status and the proof
                # image on an already-completed delivery (even down to 0,
                # pocketing the cash). Block re-settlement of a receipt that is
                # already Delivered or Canceled. A legitimate first-time
                # In Progress -> Delivered has current_status 'In Progress' and
                # passes; a driver's office-handover update (isReceivedInOffice,
                # desired == "") never enters this block.
                if current_status in {"Delivered", "Canceled"}:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Receipt delivery is already finalized ('{current_status}') and cannot be re-settled",
                    )
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

        if collection == "receipts":
            saved = _financial_patch_receipt_atomic(
                user, entity_id, updates, body.expectedLastModified
            )
        else:
            saved = patch_entity(
                collection,
                entity_id,
                updates,
                str(user.get("id") or "system"),
                expected_last_modified=body.expectedLastModified,
            )
        audit(str(user.get("id")), "update", collection, entity_id, f"Updated {collection} {entity_id} (delivery)", {})
        return EntityResponse(**saved)

    # Subscription history is server-controlled.  Every role, including
    # Admin, may only perform an active -> canceled transition; identity,
    # service, price, payment and expiry history cannot be rewritten.
    if collection == "serviceSubscriptions":
        _uid = str(user.get("id") or "")
        _updates = sanitize_json(body.data or {}) or {}
        _allowed_keys = {"status", "canceledAt", "cancelledAt", "expiresAt", "_lastModified"}
        if (set(_updates.keys()) - _allowed_keys) or str(_updates.get("status") or "") != "canceled":
            raise HTTPException(status_code=403, detail="Only subscription cancellation is allowed")
        saved = _subscription_cancel_atomic(user, entity_id, body.expectedLastModified)
        audit(_uid, "update", collection, entity_id, f"Canceled subscription {entity_id}", {})
        return EntityResponse(**saved)

    creator = existing.get("createdBy") or (existing.get("data") or {}).get("createdBy") or (existing.get("data") or {}).get("creatorId")
    delivery_grant_patch = False
    if not user_has_permission(user, module, _action_for_collection(collection, "edit"), record_creator_id=str(creator or "")):
        # Delivery-workflow PATCHes (assign/accept/complete/collect) are also
        # authorized by the deliveries.* permission group.
        _dw_updates = sanitize_json(body.data or {}) or {}
        if not (collection in {"ads", "receipts"} and _delivery_patch_allowed(user, existing, _dw_updates)):
            raise HTTPException(status_code=403, detail="Forbidden")
        delivery_grant_patch = True

    if delivery_grant_patch:
        # Client clocks/identities are not authoritative workflow evidence.
        # Normalize action metadata after authorization and before persistence.
        normalized_delivery_updates = sanitize_json(body.data or {}) or {}
        normalized_delivery_updates.pop("_lastModified", None)
        target_status = str(normalized_delivery_updates.get("deliveryStatus") or "").strip()
        now_iso = _iso_utc()
        if target_status == "In Progress":
            normalized_delivery_updates["acceptedDate"] = now_iso
        if target_status == "Canceled":
            normalized_delivery_updates["deliveryCancelReason"] = sanitize_str(
                str(normalized_delivery_updates.get("deliveryCancelReason") or "")
            )[:500]
            normalized_delivery_updates["deliveryCancelledAt"] = now_iso
            normalized_delivery_updates["deliveryCancelledBy"] = str(user.get("id") or "")
        if "isReceivedInOffice" in normalized_delivery_updates or "officeHandover" in normalized_delivery_updates:
            received = bool(
                normalized_delivery_updates.get(
                    "isReceivedInOffice", normalized_delivery_updates.get("officeHandover")
                )
            )
            normalized_delivery_updates["isReceivedInOffice"] = received
            normalized_delivery_updates["receivedInOfficeAt"] = now_iso if received else ""
            if "officeHandover" in normalized_delivery_updates:
                normalized_delivery_updates["officeHandover"] = received
                normalized_delivery_updates["officeHandoverAt"] = now_iso if received else ""
        body.data.clear()
        body.data.update(normalized_delivery_updates)

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

    if collection == "clothesProducts":
        saved = _clothes_patch_product_atomic(
            user, entity_id, updates_to_save, body.expectedLastModified
        )
    elif collection == "clothesShipments":
        saved = _clothes_patch_shipment_atomic(
            user, entity_id, updates_to_save, body.expectedLastModified
        )
    elif collection == "receipts":
        saved = _financial_patch_receipt_atomic(
            user, entity_id, updates_to_save, body.expectedLastModified
        )
    else:
        saved = patch_entity(
            collection,
            entity_id,
            updates_to_save,
            str(user.get("id") or "system"),
            expected_last_modified=body.expectedLastModified,
        )
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
    createdAt/createdBy and deleted flag.

    SYNC FIX: lastModified is now ALWAYS stamped with the restore time (the
    body's value is accepted but ignored). Restoring with the backup's old
    last_modified put the row BELOW every online device's delta-sync cursor,
    so other devices received the import's deletions but never the restored
    data until a full reload.
    """
    require_same_origin(request)
    validate_relationship_ids(body.data)

    entity_type = sanitize_str(collection)[:40]
    ent_id = validate_entity_id(entity_id)
    if not entity_type:
        raise HTTPException(status_code=400, detail="Invalid entity type/id")
    if entity_type in PERSONAL_SCOPED_COLLECTIONS:
        raise HTTPException(
            status_code=405,
            detail="Wallet and subscription history cannot be restored through the online API",
        )
    if entity_type in GENERIC_RESTORE_BLOCKED_COLLECTIONS or entity_type in FINANCIAL_MUTATION_COLLECTIONS:
        raise HTTPException(
            status_code=405,
            detail="This record has cross-record side effects and requires a dedicated transactional restore",
        )

    # Desired metadata (optional, but recommended for perfect restores).
    # body.lastModified is accepted for backward compatibility but ignored —
    # the restore time is stamped instead (see docstring).
    deleted = bool(body.deleted) if body.deleted is not None else False
    created_at_in = body.createdAt

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
        # Stamp restore time so delta-sync clients receive the restored row
        # (see docstring). The backup's lastModified is deliberately ignored.
        last_modified = now_ms()

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


@app.post("/api/admin/import")
def admin_bulk_import(
    body: AdminBulkImportRequest,
    request: Request,
    admin: dict[str, Any] = Depends(require_admin),
):
    """
    Transactional whole-backup import (admin only).

    Replaces every listed collection in ONE database transaction:
    - active backup records are upserted exactly (createdAt/createdBy kept)
    - records absent from the backup, or marked _deleted in it, are
      soft-deleted ("prune")
    - every touched row is stamped last_modified = import time so online
      delta-sync clients receive the restored data (not only the deletions)

    A failure anywhere raises and rolls back EVERYTHING — the server can
    never be left half backup / half current data, which the old
    one-request-per-record flow allowed on a mid-import error.
    """
    require_same_origin(request)
    if not ENABLE_ONLINE_IMPORT:
        raise HTTPException(
            status_code=405,
            detail=(
                "Online backup import is disabled. Restore during a maintenance/offline window "
                "with ALBAYAN_ENABLE_ONLINE_IMPORT=true."
            ),
        )

    raw_collections = body.collections or {}
    if not raw_collections:
        raise HTTPException(status_code=400, detail="No collections to import")
    if len(raw_collections) > 20:
        raise HTTPException(status_code=400, detail="Too many collections")

    def _as_int(v: Any) -> Optional[int]:
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    now = now_ms()

    # Validate + sanitize everything BEFORE touching the database, so bad
    # input fails fast without opening a transaction at all.
    prepared: list[tuple[str, set[str], list[tuple[str, dict[str, Any], Optional[int], Optional[str]]]]] = []
    for raw_name, raw_records in raw_collections.items():
        name = sanitize_str(str(raw_name))[:40]
        if not name:
            raise HTTPException(status_code=400, detail="Invalid collection name")
        if name == "users":
            raise HTTPException(status_code=400, detail="Users are not imported through this endpoint")
        if name in PERSONAL_SCOPED_COLLECTIONS:
            raise HTTPException(
                status_code=405,
                detail="Wallet and subscription history cannot be imported through the online API",
            )
        if name in CLOTHES_INVENTORY_RESTORE_BLOCKED_COLLECTIONS:
            raise HTTPException(
                status_code=405,
                detail="Clothes order state cannot be imported through the online API",
            )
        if name in FINANCIAL_MUTATION_COLLECTIONS:
            raise HTTPException(status_code=405, detail="Financial idempotency records cannot be imported")
        records = raw_records or []
        if len(records) > 50000:
            raise HTTPException(status_code=400, detail=f"Too many records in '{name}'")
        seen_ids: set[str] = set()
        active: list[tuple[str, dict[str, Any], Optional[int], Optional[str]]] = []
        for rec in records:
            if not isinstance(rec, dict):
                raise HTTPException(status_code=400, detail=f"'{name}' contains a non-object record")
            validate_relationship_ids(rec, f"{name} record")
            try:
                rid = validate_entity_id(rec.get("id"))
            except HTTPException:
                raise HTTPException(status_code=400, detail=f"'{name}' contains an invalid record id")
            if rid in seen_ids:
                raise HTTPException(status_code=400, detail=f"'{name}' contains duplicate id '{rid}'")
            seen_ids.add(rid)
            if rec.get("_deleted"):
                # Stays (or becomes) deleted via the prune step below.
                continue
            data = sanitize_json(rec) or {}
            data["id"] = rid
            created_at = _as_int(data.get("_created"))
            created_by = sanitize_str(str(data.get("createdBy") or ""))[:80] or None
            active.append((rid, data, created_at, created_by))
        prepared.append((name, seen_ids, active))

    summary: dict[str, dict[str, int]] = {}
    with db_conn() as conn:
        # createdBy FK safety: the entities.created_by column references
        # users.id, so it may only hold ids that actually exist (deleted
        # users included — history stays attributed). Unknown creators get a
        # NULL column while data.createdBy keeps the backup's value.
        user_rows = conn.execute(text("SELECT id FROM users")).mappings().all()
        existing_user_ids = {str(r["id"]) for r in user_rows}

        for (name, _seen_ids, active) in prepared:
            existing_rows = conn.execute(
                text("SELECT id, deleted, created_at FROM entities WHERE type = :type"),
                {"type": name},
            ).mappings().all()
            existing_meta = {str(r["id"]): r for r in existing_rows}
            active_ids = {rid for (rid, _d, _c, _cb) in active}

            pruned = 0
            for eid, meta in existing_meta.items():
                if bool(meta["deleted"]):
                    continue
                if eid not in active_ids:
                    conn.execute(
                        text("UPDATE entities SET deleted = true, last_modified = :ts WHERE type = :type AND id = :id"),
                        {"ts": now, "type": name, "id": eid},
                    )
                    pruned += 1

            restored = 0
            for (rid, data, created_at_in, created_by_in) in active:
                existing = existing_meta.get(rid)
                created_at = created_at_in if created_at_in is not None else (int(existing["created_at"]) if existing else now)
                col_created_by = created_by_in if (created_by_in and created_by_in in existing_user_ids) else None
                data["_created"] = int(created_at)
                data["_lastModified"] = int(now)
                data["_deleted"] = False
                payload = {
                    "type": name,
                    "id": rid,
                    "data_json": json_dumps(data),
                    "deleted": False,
                    "created_at": int(created_at),
                    "created_by": col_created_by,
                    "last_modified": int(now),
                }
                # A backup whose active set has two records sharing a unique
                # field (e.g. two receipts with the same serialNumber after a
                # swap) trips a partial unique index. Surface a clear 409 instead
                # of an opaque 500; the whole import transaction rolls back.
                try:
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
                except IntegrityError:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Import conflict in '{name}' (record {rid}): a unique field (e.g. receipt number) collides. The backup was not applied.",
                    )
                restored += 1

            summary[name] = {"restored": restored, "pruned": pruned}

    # Audit AFTER the committed transaction (audit() opens its own connection).
    audit(
        str(admin.get("id")),
        "import",
        "backup",
        "bulk",
        "Transactional server import: " + ", ".join(f"{k}={v['restored']}+{v['pruned']}del" for k, v in summary.items()),
        summary,
    )
    return {"ok": True, "lastModified": now, "collections": summary}


@app.post("/api/batch/delete")
def batch_delete_entities(
    body: BatchDeleteRequest,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    """
    Soft-delete several entities in ONE transaction (all-or-nothing).

    Cascade deletes (a customer with their receipts, ads and linked transfer
    receipts) previously fired one DELETE per record with no retry — on a
    flaky connection some succeeded and some silently failed, leaving the
    cascade half-applied and the failed records resurrecting on other
    devices. This endpoint applies the whole set atomically.

    Permissions mirror the single DELETE endpoint, checked per item BEFORE
    any write. Items already gone from the server are skipped (idempotent),
    matching how a re-run of the same cascade should behave.
    """
    require_same_origin(request)

    normalized: list[tuple[str, str]] = []
    for item in body.items:
        col = sanitize_str(item.collection)[:40]
        eid = sanitize_str(item.id)[:80]
        if not col or not eid:
            raise HTTPException(status_code=400, detail="Invalid collection/id in batch")
        if col in CLOTHES_BUSINESS_COLLECTIONS:
            _require_clothes_subscription(user)
        if col == "users":
            raise HTTPException(status_code=400, detail="Users cannot be deleted through this endpoint")
        if col in PERSONAL_SCOPED_COLLECTIONS:
            raise HTTPException(status_code=405, detail="Wallet and subscription history cannot be deleted")
        if col in CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS:
            raise HTTPException(
                status_code=405,
                detail="Clothes orders must be deleted through the transactional clothes API",
            )
        if col in FINANCIAL_MUTATION_COLLECTIONS:
            raise HTTPException(status_code=405, detail="Financial mutation records are server-controlled")
        if col == "clothesShipments":
            raise HTTPException(
                status_code=405,
                detail="Clothes shipments must be deleted through the transactional clothes API",
            )
        module = _module_for_collection(col)
        delete_action = _action_for_collection(col, "delete")
        if not user_has_permission(user, module, delete_action):
            existing = get_entity(col, eid)
            if not existing:
                # Missing records are skipped later; nothing to authorize.
                normalized.append((col, eid))
                continue
            creator = existing.get("createdBy") or (existing.get("data") or {}).get("createdBy") or (existing.get("data") or {}).get("creatorId")
            if not user_has_permission(user, module, delete_action, record_creator_id=str(creator or "")):
                raise HTTPException(status_code=403, detail=f"Forbidden: {col}/{eid}")
        normalized.append((col, eid))

    now = now_ms()
    deleted = 0
    skipped = 0
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    financial_batch = any(col in {"receipts", "customers"} for col, _ in normalized)
    guard = (nullcontext() if postgres else _SQLITE_FINANCIAL_LOCK) if financial_batch else nullcontext()
    with guard:
        with db_conn() as conn:
            if financial_batch:
                receipt_ids = {eid for col, eid in normalized if col == "receipts"}
                customer_ids = {eid for col, eid in normalized if col == "customers"}
                if customer_ids:
                    for receipt_row in _financial_active_rows(conn, "receipts"):
                        receipt_data = _financial_row_data(receipt_row)
                        if str(receipt_data.get("customerId") or "") in customer_ids:
                            receipt_ids.add(str(receipt_row["id"]))
                locked_receipts = _financial_lock_receipts(conn, receipt_ids, postgres=postgres)
                for receipt_id, receipt_row in locked_receipts.items():
                    if not receipt_row or bool(receipt_row["deleted"]):
                        continue
                    reason = _financial_receipt_reference_reason(
                        conn, receipt_id, _financial_row_data(receipt_row)
                    )
                    if reason:
                        raise HTTPException(
                            status_code=409,
                            detail=f"Receipt {receipt_id} cannot be deleted while linked to {reason}",
                        )
                for customer_id in sorted(customer_ids):
                    _clothes_lock_row(conn, "customers", customer_id, postgres=postgres)

            for (col, eid) in normalized:
                exists = (
                    conn.execute(
                        text("SELECT id FROM entities WHERE type = :type AND id = :id LIMIT 1"),
                        {"type": col, "id": eid},
                    )
                    .mappings()
                    .first()
                )
                if not exists:
                    skipped += 1
                    continue
                conn.execute(
                    text("UPDATE entities SET deleted = true, last_modified = :ts WHERE type = :type AND id = :id"),
                    {"ts": now, "type": col, "id": eid},
                )
                deleted += 1

    for (col, eid) in normalized:
        audit(str(user.get("id")), "delete", col, eid, f"Deleted {col} {eid} (atomic batch)", {})
    return {"ok": True, "deleted": deleted, "skipped": skipped}


@app.delete("/api/collections/{collection}/{entity_id}")
def delete_collection_item(
    collection: str,
    entity_id: str,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    require_same_origin(request)
    if collection in CLOTHES_BUSINESS_COLLECTIONS:
        _require_clothes_subscription(user)
    if collection in PERSONAL_SCOPED_COLLECTIONS:
        raise HTTPException(status_code=405, detail="Wallet and subscription history cannot be deleted")
    if collection in CLOTHES_ORDER_SERVER_CONTROLLED_COLLECTIONS:
        raise HTTPException(
            status_code=405,
            detail="Clothes orders must be deleted through the transactional clothes API",
        )
    if collection in FINANCIAL_MUTATION_COLLECTIONS:
        raise HTTPException(status_code=405, detail="Financial mutation records are server-controlled")
    if collection == "clothesShipments":
        raise HTTPException(
            status_code=405,
            detail="Clothes shipments must be deleted through the transactional clothes API",
        )
    if collection == "clothesProducts":
        deleted_product = _clothes_delete_product_atomic(user, entity_id)
        audit(str(user.get("id")), "delete", collection, entity_id, f"Deleted {collection} {entity_id}", {})
        return {"ok": True, "lastModified": deleted_product["lastModified"]}
    module = _module_for_collection(collection)
    delete_action = _action_for_collection(collection, "delete")
    if not user_has_permission(user, module, delete_action):
        existing = get_entity(collection, entity_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        creator = existing.get("createdBy") or (existing.get("data") or {}).get("createdBy") or (existing.get("data") or {}).get("creatorId")
        if not user_has_permission(user, module, delete_action, record_creator_id=str(creator or "")):
            raise HTTPException(status_code=403, detail="Forbidden")

    if collection == "customers":
        deleted_customer = _financial_delete_customer_atomic(entity_id)
        audit(str(user.get("id")), "delete", collection, entity_id, f"Deleted {collection} {entity_id}", {})
        return {"ok": True, "lastModified": deleted_customer["lastModified"]}
    if collection == "receipts":
        deleted_receipt = _financial_delete_receipt_atomic(entity_id)
        audit(str(user.get("id")), "delete", collection, entity_id, f"Deleted {collection} {entity_id}", {})
        return {"ok": True, "lastModified": deleted_receipt["lastModified"]}

    soft_delete_entity(collection, entity_id, str(user.get("id") or "system"))
    audit(str(user.get("id")), "delete", collection, entity_id, f"Deleted {collection} {entity_id}", {})
    return {"ok": True}


@app.get("/api/audit")
def list_audit(
    limit: int = 200,
    offset: int = 0,
    user: dict[str, Any] = Depends(current_user),
):
    # auditLogs.view => full log; auditLogs.viewOwn => only own activity.
    # Admins pass automatically via the role bypass in user_has_permission.
    can_view_all = user_has_permission(user, "auditLogs", "view")
    can_view_own = user_has_permission(user, "auditLogs", "viewOwn")
    if not can_view_all and not can_view_own:
        raise HTTPException(status_code=403, detail="Forbidden")

    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    with db_conn() as conn:
        if can_view_all:
            rows = (
                conn.execute(
                    text("SELECT * FROM audit_logs ORDER BY ts DESC LIMIT :limit OFFSET :offset"),
                    {"limit": limit, "offset": offset},
                )
                .mappings()
                .all()
            )
        else:
            rows = (
                conn.execute(
                    text("SELECT * FROM audit_logs WHERE user_id = :uid ORDER BY ts DESC LIMIT :limit OFFSET :offset"),
                    {"uid": str(user.get("id") or ""), "limit": limit, "offset": offset},
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
    payload: dict[str, Any] | None = Body(default=None),
    user: dict[str, Any] = Depends(current_user),
    request: Request = None,
):
    """
    Delete audit logs older than specified days (default: 1 year).
    Requires the auditLogs.clear permission (admins pass automatically).
    CSRF-protected.
    """
    require_same_origin(request)
    if not user_has_permission(user, "auditLogs", "clear"):
        raise HTTPException(status_code=403, detail="Forbidden")

    # The client sends days_to_keep in the JSON body (query param also
    # accepted for backwards compatibility; body wins).
    if isinstance(payload, dict) and payload.get("days_to_keep") is not None:
        try:
            days_to_keep = int(payload.get("days_to_keep"))
        except (TypeError, ValueError):
            days_to_keep = 365

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
def audit_stats(user: dict[str, Any] = Depends(current_user)):
    """
    Get audit log statistics (total count, oldest entry, size estimates).
    Requires auditLogs.view (admins pass automatically).
    """
    if not user_has_permission(user, "auditLogs", "view"):
        raise HTTPException(status_code=403, detail="Forbidden")
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
    request: Request,
    hours_threshold: int = 72,
    payload: dict[str, Any] | None = Body(default=None),
    user: dict[str, Any] = Depends(current_user),
):
    """
    Find deliveries that have been 'In Progress' for more than X hours (default: 72h = 3 days).
    Requires the deliveries.assign permission (admins pass automatically) —
    matching the client-side gate. Returns stuck delivery receipts for review.
    """
    require_same_origin(request)
    if not user_has_permission(user, "deliveries", "assign"):
        raise HTTPException(status_code=403, detail="Forbidden")

    # The client sends hours_threshold in the JSON body; also accept the query
    # param for backwards compatibility (body wins).
    if isinstance(payload, dict) and payload.get("hours_threshold") is not None:
        try:
            hours_threshold = int(payload.get("hours_threshold"))
        except (TypeError, ValueError):
            hours_threshold = 72

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
def list_users(user: dict[str, Any] = Depends(current_user)):
    # Admins pass via the role bypass inside user_has_permission; non-admins
    # need the users.view permission (managePermissions implies needing the
    # list too). Previously this was role-gated, which made the users.view
    # permission sold in the Permissions Manager unenforceable.
    if not (
        user_has_permission(user, "users", "view")
        or user_has_permission(user, "users", "managePermissions")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")
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


def _free_email_if_soft_deleted(email: str, now: int) -> bool:
    """Deleted users are only soft-deleted (their row is kept for audit and
    restore), so their email keeps holding the unique constraint FOREVER —
    deleting a user then re-adding them with the same address failed with a
    confusing error. If the address is held by a soft-deleted row, rename that
    tombstone's email (prefix keeps it a valid, unique address) so the live
    address can be reused. Returns True when an address was freed."""
    e = str(email).lower().strip()
    if not e:
        return False
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id, deleted FROM users WHERE lower(email) = :e LIMIT 1"),
            {"e": e},
        ).mappings().first()
        if not row or not bool(row["deleted"]):
            return False
        conn.execute(
            text("UPDATE users SET email = :new_e, last_modified = :now WHERE id = :id"),
            {"new_e": f"deleted{now}.{e}", "now": now, "id": str(row["id"])},
        )
    return True


def _validated_role(raw_role: Any) -> str:
    role = sanitize_str(str(raw_role or "")).strip()
    if role not in VALID_USER_ROLES:
        raise HTTPException(status_code=400, detail="Invalid user role")
    return role


def _validated_permission_payload(raw_permissions: Any) -> dict[str, list[str]]:
    try:
        return normalize_permissions(raw_permissions)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _ensure_actor_can_grant_permissions(
    actor: dict[str, Any], permissions: dict[str, list[str]], *, explicit: bool
) -> None:
    """Prevent delegated user managers from granting power they do not have."""
    if str(actor.get("role") or "").lower() == "admin":
        return
    if explicit and permissions and not user_has_permission(actor, "users", "managePermissions"):
        raise HTTPException(status_code=403, detail="users.managePermissions is required to grant permissions")
    for module, actions in permissions.items():
        for action in actions:
            if not user_has_permission(actor, module, action):
                raise HTTPException(
                    status_code=403,
                    detail=f"Cannot grant permission you do not hold: {module}.{action}",
                )


ALLOWED_USER_UPDATE_FIELDS = frozenset(
    {
        "name",
        "email",
        "role",
        "permissions_json",
        "password_hash",
        "password_salt",
        "password_algo",
        "password_iterations",
        "deleted",
        "last_modified",
    }
)


def _apply_user_update_atomic(
    user_id: str,
    update_fields: dict[str, Any],
    actor: dict[str, Any],
) -> None:
    """Apply a user update while atomically preserving one active Admin."""
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _SQLITE_ADMIN_MEMBERSHIP_LOCK
    with guard:
        with db_conn() as conn:
            if postgres:
                _lock_idempotency_key(
                    conn,
                    "membership",
                    postgres=True,
                    namespace="activeAdmin",
                )
            suffix = " FOR UPDATE" if postgres else ""
            current = conn.execute(
                text(f"SELECT * FROM users WHERE id=:id LIMIT 1{suffix}"),
                {"id": user_id},
            ).mappings().first()
            if not current:
                raise HTTPException(status_code=404, detail="Not found")
            if (
                str(actor.get("role") or "").lower() != "admin"
                and str(current.get("role") or "").lower() == "admin"
            ):
                raise HTTPException(status_code=403, detail="Only an Admin can modify an Admin account")

            current_is_admin = (
                str(current.get("role") or "").lower() == "admin"
                and not bool(current.get("deleted"))
            )
            next_role = str(update_fields.get("role", current.get("role")) or "")
            next_deleted = bool(update_fields.get("deleted", current.get("deleted")))
            removes_active_admin = current_is_admin and (
                next_role.lower() != "admin" or next_deleted
            )
            if removes_active_admin:
                other_count = conn.execute(
                    text(
                        "SELECT COUNT(*) FROM users "
                        "WHERE lower(role)='admin' AND deleted=false AND id<>:id"
                    ),
                    {"id": user_id},
                ).scalar()
                if int(other_count or 0) < 1:
                    raise HTTPException(
                        status_code=400,
                        detail="Cannot remove the last remaining admin. Promote another user to Admin first.",
                    )

            set_clause = ", ".join(
                f"{key} = :{key}"
                for key in update_fields
                if key in ALLOWED_USER_UPDATE_FIELDS
            )
            params = {**update_fields, "id": user_id}
            conn.execute(text(f"UPDATE users SET {set_clause} WHERE id=:id"), params)
            if "password_hash" in update_fields or update_fields.get("deleted") is True:
                conn.execute(
                    text("DELETE FROM sessions WHERE user_id=:uid"),
                    {"uid": user_id},
                )


@app.post("/api/users", response_model=UserPublic)
def create_user(body: CreateUserRequest, request: Request, admin: dict[str, Any] = Depends(current_user)):
    require_same_origin(request)
    # users.add permission (admins pass automatically). Anti-escalation: a
    # non-admin can never create an Admin account.
    if not user_has_permission(admin, "users", "add"):
        raise HTTPException(status_code=403, detail="Forbidden")
    requested_role = _validated_role(body.role)
    requested_permissions = _validated_permission_payload(body.permissions or {})
    _ensure_actor_can_grant_permissions(
        admin, requested_permissions, explicit=body.permissions is not None
    )
    if str(admin.get("role") or "").lower() != "admin":
        if requested_role == "Admin":
            raise HTTPException(status_code=403, detail="Only an Admin can create Admin accounts")
        if requested_role != "Employee" and not user_has_permission(admin, "users", "changeRole"):
            raise HTTPException(status_code=403, detail="users.changeRole is required to create this role")
    now = now_ms()
    pw = hash_password(body.password, iterations=PBKDF2_ITERATIONS_DEFAULT)

    permissions_json = json_dumps(requested_permissions)
    user_id = new_id("user")

    def _insert() -> None:
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
                    "role": requested_role,
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

    try:
        _insert()
    except IntegrityError:
        # Duplicate email. If the holder is a soft-deleted user, free the
        # address and retry so "delete user, then re-add them" just works.
        if not _free_email_if_soft_deleted(str(body.email), now):
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        try:
            _insert()
        except IntegrityError:
            raise HTTPException(status_code=409, detail="A user with this email already exists")

    audit(str(admin.get("id")), "create", "users", user_id, f"Created user {body.email}", {})
    created = _get_user_by_id(user_id)
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return user_row_to_public(created)


@app.patch("/api/users/{user_id}", response_model=UserPublic)
def update_user(user_id: str, body: UpdateUserRequest, request: Request, admin: dict[str, Any] = Depends(current_user)):
    require_same_origin(request)
    user_id = sanitize_str(user_id)[:80]
    now = now_ms()

    existing = _get_user_by_id(user_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")

    requested_role = _validated_role(body.role) if body.role is not None else None
    requested_permissions = (
        _validated_permission_payload(body.permissions) if body.permissions is not None else None
    )
    if requested_permissions is not None:
        _ensure_actor_can_grant_permissions(admin, requested_permissions, explicit=True)

    # Permission gating. Admins pass everything (role bypass inside
    # user_has_permission); non-admins need the matching users.* permission
    # per field, may self-edit name/email, and can NEVER touch an Admin
    # account, grant the Admin role, or delete themselves.
    _actor_is_admin = str(admin.get("role") or "").lower() == "admin"
    _is_self = str(admin.get("id") or "") == user_id
    if not _actor_is_admin:
        if str(existing.get("role") or "").lower() == "admin":
            raise HTTPException(status_code=403, detail="Only an Admin can modify an Admin account")
        if requested_role == "Admin":
            raise HTTPException(status_code=403, detail="Only an Admin can grant the Admin role")

        def _need(perm: str) -> None:
            if not user_has_permission(admin, "users", perm):
                raise HTTPException(status_code=403, detail="Forbidden")

        if (body.name is not None or body.email is not None) and not _is_self:
            _need("edit")
        if body.password is not None:
            if _is_self:
                # Self password changes must verify the current password.
                raise HTTPException(status_code=400, detail="Use /api/auth/password-change to change your own password")
            _need("resetPassword")
        if requested_role is not None and requested_role != str(existing.get("role") or ""):
            _need("changeRole")
        if body.permissions is not None:
            _need("managePermissions")
        if body.deleted is not None:
            if body.deleted is True and _is_self:
                raise HTTPException(status_code=400, detail="You cannot delete your own account")
            _need("delete")

    # SECURITY: Whitelist allowed fields to prevent SQL injection
    update_fields: dict[str, Any] = {}

    if body.name is not None:
        update_fields["name"] = sanitize_str(body.name)
    if body.email is not None:
        update_fields["email"] = str(body.email).lower()
    if requested_role is not None:
        update_fields["role"] = requested_role
    if requested_permissions is not None:
        update_fields["permissions_json"] = json_dumps(requested_permissions)
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

    # LOCKOUT GUARD: never let the LAST active admin lose admin (by being
    # soft-deleted or demoted). Without this, an admin could self-demote (or
    # delete the only other admin then self-demote) and leave the platform with
    # zero admins — every admin-only endpoint (users, import, restore, audit)
    # then 403s and recovery needs direct DB access.
    def _apply_update() -> None:
        _apply_user_update_atomic(user_id, update_fields, admin)

    try:
        _apply_update()
    except IntegrityError:
        # Changing email to one already used by another user. If that other
        # user is soft-deleted, free the address and retry (same rule as
        # create_user) so old deleted accounts never hold emails hostage.
        if body.email is None or not _free_email_if_soft_deleted(str(body.email), now):
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        try:
            _apply_update()
        except IntegrityError:
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
# Must stay in sync with VIEW_TO_PATH in src/11-routing-cloud.js — every view
# needs a real URL that survives a refresh / a shared link.
FRONTEND_ROUTES = {
    "/analytics",
    "/ads",
    "/customers",
    "/receipts",
    "/pages",
    "/users",
    "/deliveries",
    "/reconciliation",
    "/settings",
    "/audit-logs",
    "/delivery",
    "/receipt-balance",
    "/no-access",
    "/smart-systems",
    "/clothes-system",
    "/service",
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
