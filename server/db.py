import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    text,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.pool import StaticPool


METADATA = MetaData()


# NOTE: We use composite primary key (type, id) for entities to avoid cross-type ID conflicts.
USERS = "users"
SESSIONS = "sessions"
ENTITIES = "entities"
AUDIT_LOGS = "audit_logs"
PASSWORD_RESETS = "password_resets"


def _default_sqlite_path() -> Path:
    base = Path(__file__).resolve().parent
    data_dir = base / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "albayan.db"


def _sqlite_url(path: Path) -> str:
    # sqlite+pysqlite requires 4 slashes for absolute paths on unix
    return f"sqlite+pysqlite:///{path}"


def get_database_url() -> str:
    # Preferred for production (Postgres):
    # DATABASE_URL=postgresql+psycopg://user:pass@host:5432/dbname
    url = (os.getenv("DATABASE_URL") or os.getenv("ALBAYAN_DATABASE_URL") or "").strip()
    if url:
        return url

    # Dev fallback: SQLite (still supported for local testing)
    env_path = os.getenv("ALBAYAN_DB_PATH", "").strip()
    if env_path:
        p = Path(env_path).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        return _sqlite_url(p)
    return _sqlite_url(_default_sqlite_path())


_ENGINE: Optional[Engine] = None
_ENGINE_URL: Optional[str] = None


def get_engine() -> Engine:
    global _ENGINE, _ENGINE_URL

    url = get_database_url()
    # If tests/runtime change DATABASE_URL after initial import, recreate the engine.
    # This avoids flaky tests when multiple test modules set different URLs.
    if _ENGINE is not None and _ENGINE_URL == url:
        return _ENGINE
    if _ENGINE is not None and _ENGINE_URL != url:
        try:
            _ENGINE.dispose()
        except Exception:
            pass
        _ENGINE = None
        _ENGINE_URL = None
    connect_args = {}
    # Needed for SQLite threading in dev mode
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}

    # Special case: in-memory SQLite needs a shared pool, otherwise each connection sees a blank DB.
    is_sqlite_memory = url.endswith(":///:memory:") or url.endswith("://:memory:") or url.endswith(":memory:")
    if url.startswith("sqlite") and is_sqlite_memory:
        _ENGINE = create_engine(
            url,
            pool_pre_ping=True,
            future=True,
            connect_args=connect_args,
            poolclass=StaticPool,
        )
    else:
        # BEST PRACTICE: Configure connection pooling limits to prevent resource exhaustion.
        # Make these tunable via env vars for ECS/RDS sizing.
        def _int_env(name: str, default: int, *, min_v: int, max_v: int) -> int:
            raw = (os.getenv(name) or "").strip()
            if not raw:
                return default
            try:
                v = int(raw)
                return max(min_v, min(max_v, v))
            except Exception:
                return default

        pool_size = _int_env("ALBAYAN_DB_POOL_SIZE", 10, min_v=1, max_v=50)
        max_overflow = _int_env("ALBAYAN_DB_MAX_OVERFLOW", 20, min_v=0, max_v=100)
        pool_timeout = _int_env("ALBAYAN_DB_POOL_TIMEOUT", 30, min_v=1, max_v=120)
        pool_recycle = _int_env("ALBAYAN_DB_POOL_RECYCLE", 3600, min_v=60, max_v=24 * 3600)

        _ENGINE = create_engine(
            url,
            pool_pre_ping=True,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=pool_timeout,
            pool_recycle=pool_recycle,
            future=True,
            connect_args=connect_args,
        )
    _ENGINE_URL = url
    return _ENGINE


def now_ms() -> int:
    return int(time.time() * 1000)


def json_dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def json_loads(s: str):
    return json.loads(s) if s else None


@contextmanager
def db_conn() -> Connection:
    """
    Yields a SQLAlchemy Connection inside a transaction.
    Commits on success; rolls back on exception.
    """
    engine = get_engine()
    with engine.begin() as conn:
        yield conn


def define_schema():
    """
    Register all table definitions on METADATA (idempotent, no DB access).
    Shared by init_db() and Alembic's migration environment
    (server/migrations/env.py) so there is exactly one schema definition.
    """
    # Define schema once (safe if called multiple times)
    if USERS not in METADATA.tables:
        Table(
            USERS,
            METADATA,
            Column("id", String(80), primary_key=True),
            Column("name", String(120), nullable=False),
            Column("email", String(255), nullable=False, unique=True),
            Column("role", String(40), nullable=False),
            Column("permissions_json", Text, nullable=True),
            Column("password_hash", String(128), nullable=False),
            Column("password_salt", String(128), nullable=False),
            Column("password_algo", String(40), nullable=False),
            Column("password_iterations", Integer, nullable=False),
            Column("deleted", Boolean, nullable=False, server_default=text("false")),
            Column("created_at", BigInteger, nullable=False),
            Column("created_by", String(80), nullable=True),
            Column("last_modified", BigInteger, nullable=False),
        )

    if SESSIONS not in METADATA.tables:
        Table(
            SESSIONS,
            METADATA,
            Column("id", String(80), primary_key=True),
            Column("user_id", String(80), ForeignKey(f"{USERS}.id"), nullable=False),
            Column("token_hash", String(128), nullable=False),
            Column("created_at", BigInteger, nullable=False),
            Column("expires_at", BigInteger, nullable=False),
            Column("last_seen_at", BigInteger, nullable=False),
            Column("ip", String(80), nullable=True),
            Column("user_agent", Text, nullable=True),
        )
        sessions_table = METADATA.tables[SESSIONS]
        Index("sessions_user_id", sessions_table.c.user_id)
        Index("sessions_expires_at", sessions_table.c.expires_at)

    if ENTITIES not in METADATA.tables:
        Table(
            ENTITIES,
            METADATA,
            Column("type", String(64), primary_key=True),
            Column("id", String(80), primary_key=True),
            Column("data_json", Text, nullable=False),
            Column("deleted", Boolean, nullable=False, server_default=text("false")),
            Column("created_at", BigInteger, nullable=False),
            Column("created_by", String(80), ForeignKey(f"{USERS}.id"), nullable=True),
            Column("last_modified", BigInteger, nullable=False),
        )
        entities_table = METADATA.tables[ENTITIES]
        Index("entities_type", entities_table.c.type)
        Index("entities_type_last_modified", entities_table.c.type, entities_table.c.last_modified)
        Index("entities_type_deleted", entities_table.c.type, entities_table.c.deleted)
        Index("entities_created_by", entities_table.c.created_by)
        # Composite index for common query pattern: type + deleted + last_modified (for sync queries)
        Index("entities_type_deleted_modified", entities_table.c.type, entities_table.c.deleted, entities_table.c.last_modified)

    if AUDIT_LOGS not in METADATA.tables:
        Table(
            AUDIT_LOGS,
            METADATA,
            Column("id", String(80), primary_key=True),
            Column("ts", BigInteger, nullable=False),
            Column("user_id", String(80), nullable=True),
            Column("action", String(64), nullable=False),
            Column("resource_type", String(64), nullable=False),
            Column("resource_id", String(80), nullable=False),
            Column("message", Text, nullable=False),
            Column("metadata_json", Text, nullable=True),
        )
        audit_table = METADATA.tables[AUDIT_LOGS]
        Index("audit_logs_ts", audit_table.c.ts)
        Index("audit_logs_user_ts", audit_table.c.user_id, audit_table.c.ts)

    if PASSWORD_RESETS not in METADATA.tables:
        Table(
            PASSWORD_RESETS,
            METADATA,
            Column("id", String(80), primary_key=True),
            Column("user_id", String(80), ForeignKey(f"{USERS}.id"), nullable=False),
            Column("token_hash", String(128), nullable=False, unique=True),
            Column("created_at", BigInteger, nullable=False),
            Column("expires_at", BigInteger, nullable=False),
            Column("used_at", BigInteger, nullable=True),
            Column("ip", String(80), nullable=True),
            Column("user_agent", Text, nullable=True),
        )
        pr = METADATA.tables[PASSWORD_RESETS]
        Index("password_resets_user_id", pr.c.user_id)
        Index("password_resets_expires_at", pr.c.expires_at)
        Index("password_resets_token_hash", pr.c.token_hash)


def init_db():
    """
    Create tables if they don't exist (works for Postgres + SQLite).
    Schema CHANGES to an existing production database are managed with
    Alembic migrations — see server/MIGRATIONS.md.
    """
    engine = get_engine()
    define_schema()
    METADATA.create_all(engine)


