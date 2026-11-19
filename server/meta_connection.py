"""Connect with Facebook: the stored, encrypted Meta system-user key (platform module).

Until an admin completes Connect, nothing here changes Albayan's behaviour: the key comes from
ALBAYAN_META_ACCESS_TOKEN and the ad-account allowlist from ALBAYAN_META_AD_ACCOUNT_IDS. Once a
connection is stored (entities row metaHealthState/"connection", refused by the generic API, the
admin import and the single-record restore, and left out of the full backup download), its key
wins over the environment key and its account selection replaces the environment list (an empty
selection while connected means NO account, never "all").

Rules this module keeps:
  * It never imports main.py, and meta_ads imports it (never the other way at import time).
  * Nothing here raises into a caller: a missing key, an unreadable record or a database error
    means "use the environment key" (plus reconnect_needed() when a record exists but cannot be
    read). Log lines are generic and never carry a secret.
  * The plain key is never stored. The record holds AES-256-GCM ciphertext bound (AAD) to the
    record id and the Meta app id, plus harmless facts.
  * On import it installs the logging redaction: httpx request lines and uvicorn's access log
    never show code, state, tokens or the client secret.

Records (all type metaHealthState): "connection" (key + facts), "connectionPending" (hashed OAuth
state), "connectionChoice" (encrypted short-lived user token + system-user candidates),
"connectionSettings" (login config id, not secret), "connectionResult" (the last outcome).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import text

from .db import db_conn, json_dumps, json_loads, now_ms

RECORD_TYPE = "metaHealthState"
RECORD_PREFIX = "connection"
CONNECTION_ID = "connection"
PENDING_ID = "connectionPending"
CHOICE_ID = "connectionChoice"
SETTINGS_ID = "connectionSettings"
RESULT_ID = "connectionResult"
RECORD_IDS = (CONNECTION_ID, PENDING_ID, CHOICE_ID, SETTINGS_ID, RESULT_ID)

KEY_ENV = "ALBAYAN_META_CONNECTION_KEY"
APP_ID_ENV = "ALBAYAN_META_APP_ID"
APP_SECRET_ENV = "ALBAYAN_META_APP_SECRET"
TOKEN_ENV = "ALBAYAN_META_ACCESS_TOKEN"
LOGIN_CONFIG_ENV = "ALBAYAN_META_LOGIN_CONFIG_ID"

ALG = "A256GCM"
FORMAT_VERSION = 1
CRYPTO_FIELDS = ("v", "alg", "kid", "nonce", "ct")
_HKDF_SALT = b"albayan-meta-connection"
_HKDF_INFO = b"v1"
_AAD_PREFIX = b"albayan:meta-connection:v1|"
CACHE_TTL_SECONDS = 30.0
_ERROR_RETRY_SECONDS = 5.0
_APP_ID_RE = re.compile(r"^[0-9]{1,40}$")

_LOG = logging.getLogger("albayan.meta_connection")


def _quiet(message: str) -> None:
    """A generic line without any secret (never the exception text: it could quote a value)."""
    try:
        _LOG.warning("[albayan] Meta connection: %s", message)
    except Exception:
        pass


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- key and crypto


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def _explicit_key() -> bytes | None:
    """ALBAYAN_META_CONNECTION_KEY: URL-safe base64 of 32 bytes (operations._backup_key's shape)."""
    raw = _env(KEY_ENV)
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception:
        return None
    return decoded if len(decoded) == 32 else None


def connection_key() -> bytes | None:
    """The 32-byte key: the dedicated variable when set (an invalid value gives no key, never a
    silent fallback), otherwise HKDF-SHA256 of the Meta app secret. None when neither exists."""
    try:
        if _env(KEY_ENV):
            return _explicit_key()
        app_secret = _env(APP_SECRET_ENV)
        if not app_secret:
            return None
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        return HKDF(algorithm=hashes.SHA256(), length=32, salt=_HKDF_SALT, info=_HKDF_INFO).derive(
            app_secret.encode("utf-8")
        )
    except Exception:
        _quiet("the encryption key could not be prepared")
        return None


def key_source() -> str:
    """'key' (dedicated variable), 'app_secret' (derived), 'invalid' (variable set but unusable) or ''."""
    if _env(KEY_ENV):
        return "key" if _explicit_key() is not None else "invalid"
    return "app_secret" if _env(APP_SECRET_ENV) else ""


def key_state() -> str:
    """For a boot line: ok, INVALID or MISSING (like operations.backup_key_state)."""
    source = key_source()
    if source == "invalid":
        return "INVALID"
    return "ok" if source else "MISSING"


def key_id(key: bytes) -> str:
    return hmac.new(key, b"kid", hashlib.sha256).hexdigest()[:8]


def app_id() -> str:
    value = _env(APP_ID_ENV)
    return value if _APP_ID_RE.fullmatch(value) else ""


def app_ready() -> bool:
    """Connect can work: a numeric app id, the app secret and an encryption key all exist."""
    return bool(app_id() and _env(APP_SECRET_ENV) and connection_key() is not None)


def _aad(record_id: str, application_id: str) -> bytes:
    return _AAD_PREFIX + str(record_id).encode("utf-8") + b"|" + str(application_id).encode("utf-8")


def encrypt_secret(plain: str, record_id: str, application_id: str | None = None) -> dict[str, Any] | None:
    """{v, alg, kid, nonce, ct} for one secret, or None (no key, no app id, empty value)."""
    try:
        key = connection_key()
        bound_app = app_id() if application_id is None else str(application_id)
        if key is None or not plain or not bound_app:
            return None
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = secrets.token_bytes(12)
        cipher = AESGCM(key).encrypt(nonce, str(plain).encode("utf-8"), _aad(record_id, bound_app))
        return {
            "v": FORMAT_VERSION,
            "alg": ALG,
            "kid": key_id(key),
            "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
            "ct": base64.urlsafe_b64encode(cipher).decode("ascii"),
        }
    except Exception:
        _quiet("a value could not be encrypted")
        return None


def decrypt_secret(record: Any, record_id: str, application_id: str | None = None) -> str | None:
    """The plain value, or None (missing key, other key, other app id, damaged record). Never raises."""
    try:
        if not isinstance(record, dict) or record.get("alg") != ALG or record.get("v") != FORMAT_VERSION:
            return None
        key = connection_key()
        bound_app = app_id() if application_id is None else str(application_id)
        if key is None or not bound_app:
            return None
        if not hmac.compare_digest(str(record.get("kid") or ""), key_id(key)):
            return None
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = base64.urlsafe_b64decode(str(record.get("nonce") or ""))
        cipher = base64.urlsafe_b64decode(str(record.get("ct") or ""))
        if len(nonce) != 12 or not cipher:
            return None
        plain = AESGCM(key).decrypt(nonce, cipher, _aad(record_id, bound_app)).decode("utf-8")
        return plain or None
    except Exception:
        return None


def public_facts(record: Any) -> dict[str, Any]:
    """A record without its ciphertext, nonce, key id or bookkeeping fields."""
    if not isinstance(record, dict):
        return {}
    hidden = set(CRYPTO_FIELDS) | {"_created", "_lastModified", "_deleted", "recordType"}
    return {key: value for key, value in record.items() if key not in hidden}


# --------------------------------------------------------------------------- storage


class _ReadError(Exception):
    pass


def _static_pool_busy() -> bool:
    """True when this thread already holds the in-memory SQLite connection (a nested transaction
    there would commit or roll back the caller's work), so the read must be skipped."""
    try:
        from . import db as _db
        from sqlalchemy.pool import StaticPool

        engine = _db.get_engine()
        if not isinstance(engine.pool, StaticPool):
            return False
        lock = getattr(_db, "_SQLITE_STATIC_POOL_LOCK", None)
        owned = getattr(lock, "_is_owned", None)
        return bool(owned and owned())
    except Exception:
        return False


def _read_row(record_id: str) -> dict[str, Any] | None:
    """The row's data, None when missing; raises _ReadError on a database problem."""
    if _static_pool_busy():
        raise _ReadError()
    try:
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type=:type AND id=:id AND deleted=false LIMIT 1"),
                {"type": RECORD_TYPE, "id": record_id},
            ).mappings().first()
    except Exception as error:
        raise _ReadError() from error
    if not row:
        return None
    try:
        data = json_loads(row.get("data_json") or "{}")
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def load_record(record_id: str) -> dict[str, Any]:
    """One connection row's data ({} when missing or unreadable). Never raises."""
    if record_id not in RECORD_IDS:
        return {}
    try:
        return _read_row(record_id) or {}
    except _ReadError:
        return {}


def _write(conn: Any, record_id: str, row: Any, data: dict[str, Any]) -> dict[str, Any]:
    stamp = now_ms()
    clean = dict(data)
    clean.update({"id": record_id, "recordType": RECORD_TYPE, "updatedAt": iso_now(), "_deleted": False})
    if row:
        baseline = int(row["last_modified"] or 0)
        modified = max(stamp, baseline + 1)
        clean["_created"] = clean.get("_created") or int(row["created_at"] or stamp)
        clean["_lastModified"] = modified
        result = conn.execute(
            text(
                "UPDATE entities SET data_json=:data,last_modified=:modified,deleted=false "
                "WHERE type=:type AND id=:id AND last_modified=:baseline"
            ),
            {"data": json_dumps(clean), "modified": modified, "type": RECORD_TYPE, "id": record_id, "baseline": baseline},
        )
        if result.rowcount != 1:
            raise RuntimeError("changed by another writer")
    else:
        clean["_created"] = stamp
        clean["_lastModified"] = stamp
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,false,:stamp,NULL,:stamp)"
            ),
            {"type": RECORD_TYPE, "id": record_id, "data": json_dumps(clean), "stamp": stamp},
        )
    return clean


def _select_for_write(conn: Any, record_id: str) -> Any:
    return conn.execute(
        text(
            "SELECT id,data_json,deleted,created_at,last_modified FROM entities "
            "WHERE type=:type AND id=:id LIMIT 1"
        ),
        {"type": RECORD_TYPE, "id": record_id},
    ).mappings().first()


def _row_data(row: Any) -> dict[str, Any]:
    if not row or row.get("deleted"):
        return {}
    try:
        data = json_loads(row.get("data_json") or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def update_record(
    record_id: str, update: Callable[[dict[str, Any]], dict[str, Any] | None]
) -> dict[str, Any] | None:
    """Read, change and write one row in one transaction. ``update`` gets the current data ({} when
    missing) and returns the new data. Returns the saved data, or None when nothing was saved
    (database error, a concurrent writer, an unknown id, or ``update`` returned None)."""
    if record_id not in RECORD_IDS:
        return None
    try:
        with db_conn() as conn:
            row = _select_for_write(conn, record_id)
            changed = update(dict(_row_data(row)))
            if changed is None:
                return None
            saved = _write(conn, record_id, row, dict(changed))
    except Exception:
        _quiet(f"the {record_id} record could not be saved")
        return None
    if record_id == CONNECTION_ID:
        invalidate()
    return saved


def save_record(record_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    """Replace one row's data. Returns the saved data or None. Never raises."""
    return update_record(record_id, lambda _current: dict(data))


def delete_record(record_id: str) -> bool:
    """Remove one row for good (no tombstone keeps ciphertext around). True when a row was removed."""
    if record_id not in RECORD_IDS:
        return False
    try:
        with db_conn() as conn:
            result = conn.execute(
                text("DELETE FROM entities WHERE type=:type AND id=:id"),
                {"type": RECORD_TYPE, "id": record_id},
            )
            removed = bool(result.rowcount)
    except Exception:
        _quiet(f"the {record_id} record could not be removed")
        return False
    if record_id == CONNECTION_ID:
        invalidate()
    return removed


def consume_record(record_id: str, accept: Callable[[dict[str, Any]], bool]) -> dict[str, Any] | None:
    """Single use: read the row and, when ``accept(data)`` is true, delete it in the same transaction
    (compare-and-delete on last_modified, so two callers can never both consume it). Returns the
    consumed data, or None (missing, refused, already consumed, database error)."""
    if record_id not in RECORD_IDS:
        return None
    try:
        with db_conn() as conn:
            row = _select_for_write(conn, record_id)
            data = _row_data(row)
            if not data:
                return None
            try:
                accepted = bool(accept(dict(data)))
            except Exception:
                accepted = False
            if not accepted:
                return None
            result = conn.execute(
                text("DELETE FROM entities WHERE type=:type AND id=:id AND last_modified=:baseline"),
                {"type": RECORD_TYPE, "id": record_id, "baseline": int(row["last_modified"] or 0)},
            )
            if result.rowcount != 1:
                return None
    except Exception:
        _quiet(f"the {record_id} record could not be consumed")
        return None
    if record_id == CONNECTION_ID:
        invalidate()
    return data


# --------------------------------------------------------------------------- active key


@dataclass(frozen=True)
class ActiveConnection:
    """The decrypted, cached view of the stored connection."""

    token: str = field(repr=False)
    facts: dict[str, Any] = field(default_factory=dict, compare=False)
    selected_account_ids: tuple[str, ...] = ()


# state: "none" (no row), "unreadable" (row exists, key cannot open it), "ok" (view available)
_CACHE_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {"at": None, "state": "none", "view": None, "identity": None}


def invalidate() -> None:
    """Forget the cached view: the next caller re-reads the record."""
    with _CACHE_LOCK:
        _CACHE.update({"at": None, "state": "none", "view": None, "identity": None})


def _selected(record: dict[str, Any]) -> tuple[str, ...]:
    picked: list[str] = []
    values = record.get("selectedAccountIds")
    for value in values if isinstance(values, list) else []:
        text_value = str(value or "").strip()
        if text_value.startswith("act_"):
            text_value = text_value[4:]
        if text_value.isdigit() and text_value not in picked:
            picked.append(text_value)
    return tuple(picked)


def _resolve() -> tuple[str, ActiveConnection | None]:
    """(state, view), cached for CACHE_TTL_SECONDS. A database error keeps the last known state."""
    now = time.monotonic()
    with _CACHE_LOCK:
        at = _CACHE["at"]
        if at is not None and now - at < CACHE_TTL_SECONDS:
            return _CACHE["state"], _CACHE["view"]
        previous = (_CACHE["state"], _CACHE["view"], _CACHE["identity"])
    try:
        record = _read_row(CONNECTION_ID)
    except _ReadError:
        with _CACHE_LOCK:
            # Retry soon, keep what we knew (a first-ever failure means "environment key").
            _CACHE["at"] = now - CACHE_TTL_SECONDS + _ERROR_RETRY_SECONDS
            return _CACHE["state"], _CACHE["view"]
    if record is None:
        state, view, identity = "none", None, None
    else:
        key = connection_key()
        identity = (str(record.get("updatedAt") or ""), str(record.get("_lastModified") or ""),
                    key_id(key) if key else "", app_id())
        if previous[2] == identity and previous[0] in ("ok", "unreadable"):
            state, view = previous[0], previous[1]
        else:
            token = decrypt_secret(record, CONNECTION_ID)
            if token:
                state = "ok"
                view = ActiveConnection(token=token, facts=public_facts(record), selected_account_ids=_selected(record))
            else:
                state, view = "unreadable", None
                _quiet("the stored key cannot be read; the hosting key is used until an admin reconnects")
    with _CACHE_LOCK:
        _CACHE.update({"at": now, "state": state, "view": view, "identity": identity})
    return state, view


def active_connection() -> ActiveConnection | None:
    try:
        state, view = _resolve()
        return view if state == "ok" else None
    except Exception:
        _quiet("the stored connection could not be checked")
        return None


def active_token(env_token: str | None = None) -> str:
    """The stored key when readable, else the environment key ('' when neither)."""
    view = active_connection()
    if view is not None:
        return view.token
    return (_env(TOKEN_ENV) if env_token is None else str(env_token or "")).strip()


def token_source(env_token: str | None = None) -> str:
    """'connection' | 'environment' | 'none'."""
    if active_connection() is not None:
        return "connection"
    env_value = (_env(TOKEN_ENV) if env_token is None else str(env_token or "")).strip()
    return "environment" if env_value else "none"


def reconnect_needed() -> bool:
    """True when a connection record exists but cannot be read (other key, other app id, damage)."""
    try:
        state, _view = _resolve()
        return state == "unreadable"
    except Exception:
        return False


def allowlist_required() -> bool:
    """While connected, the stored selection is the allowlist and an empty one means no account."""
    return active_connection() is not None


def active_allowed_accounts(env_ids: Any = ()) -> tuple[str, ...]:
    """The stored selection while connected, else the environment ids (unchanged)."""
    view = active_connection()
    if view is not None:
        return tuple(view.selected_account_ids)
    return tuple(env_ids or ())


def meta_token_present() -> bool:
    """Cheap (cached): a readable stored connection or the environment key exists."""
    return token_source() != "none"


# --------------------------------------------------------------------------- logging redaction

CALLBACK_PATH = "/api/meta-ads/connection/callback"
SECRET_QUERY_RE = re.compile(
    r"((?:input_token|access_token|client_secret|appsecret_proof|fb_exchange_token|revoke_token"
    r"|(?<![A-Za-z0-9_])code|(?<![A-Za-z0-9_])state)=)[^&\s\"'#]*",
    re.IGNORECASE,
)
_CALLBACK_QUERY_RE = re.compile(re.escape(CALLBACK_PATH) + r"\?[^\s\"']*")


def redact_text(value: str) -> str:
    return SECRET_QUERY_RE.sub(r"\1[redacted]", value)


def _redact_access_text(value: str) -> str:
    return redact_text(_CALLBACK_QUERY_RE.sub(CALLBACK_PATH + "?[redacted]", value))


class _SecretQueryRedactor(logging.Filter):
    """Keeps httpx's request log line, but never the token, code or secret values in its URL."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple) and record.args:
                record.args = tuple(
                    redact_text(str(arg)) if isinstance(arg, (str, _url_types())) and SECRET_QUERY_RE.search(str(arg)) else arg
                    for arg in record.args
                )
            elif not record.args and isinstance(record.msg, str):
                record.msg = redact_text(record.msg)
        except Exception:
            pass
        return True


class _AccessLogRedactor(logging.Filter):
    """uvicorn.access: the Connect callback's query string (code, state) is never written."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple) and record.args:
                record.args = tuple(
                    _redact_access_text(arg) if isinstance(arg, str) else arg for arg in record.args
                )
            elif not record.args and isinstance(record.msg, str):
                record.msg = _redact_access_text(record.msg)
        except Exception:
            pass
        return True


def _url_types() -> tuple[type, ...]:
    try:
        import httpx

        return (httpx.URL,)
    except Exception:
        return ()


def install_log_guards() -> None:
    """Idempotent: one redacting filter on "httpx" and one on "uvicorn.access"."""
    for name, kind in (("httpx", _SecretQueryRedactor), ("uvicorn.access", _AccessLogRedactor)):
        logger = logging.getLogger(name)
        if not any(type(item).__name__ == kind.__name__ for item in logger.filters):
            logger.addFilter(kind())


install_log_guards()
