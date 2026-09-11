"""Opt-in PostgreSQL export tests; use ONLY a disposable test database.

ALBAYAN_TEST_POSTGRES_URL=postgresql+psycopg://.../albayan_test
python -m pytest server/test_full_backup_postgres.py -q

Each test owns a random schema, never application tables or production data.
DATABASE_URL is deliberately ignored, and ordinary SQLite runs skip this file.
"""

import os
import re
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

from server import full_backup as backup
from server.test_full_backup_streaming import (
    assert_released, create_backup_tables, insert_entity, make_harness, read_backup,
)


def _guarded_url(raw: str) -> URL:
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError("Invalid explicit PostgreSQL test URL") from None
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise ValueError("Backup integration tests require PostgreSQL/psycopg")
    if url.query or not url.username or url.host not in {"localhost", "127.0.0.1", "::1"} or not re.fullmatch(
        r"(?:albayan_test|test_albayan)(?:_[a-z0-9_]+)?", url.database or "",
    ):
        raise ValueError("Backup tests require loopback, an explicit user, a disposable database, and no URL overrides")
    return url.set(drivername="postgresql+psycopg", host="127.0.0.1" if url.host == "localhost" else url.host)


def _connect_args(url: URL, schema: str | None = None) -> dict:
    # Explicit hostaddr defeats inherited PGHOSTADDR/PGSERVICE redirection.
    # Explicit options prevent inherited PGOPTIONS from changing search_path.
    return {
        "connect_timeout": 10, "hostaddr": url.host,
        "options": f"-csearch_path={schema}" if schema else "",
    }


@pytest.mark.parametrize("raw", [
    "postgresql://u@db.example/albayan_test",
    "postgresql://u@127.0.0.1/production",
    "postgresql://u@127.0.0.1/albayan_test?hostaddr=203.0.113.1",
    "postgresql://u@127.0.0.1/albayan_test?service=production",
    "postgresql://127.0.0.1/albayan_test",
    "sqlite:///:memory:",
])
def test_backup_postgres_guard_rejects_unsafe_targets(raw):
    with pytest.raises(ValueError):
        _guarded_url(raw)


def test_backup_postgres_guard_overrides_libpq_destination_defaults():
    url = _guarded_url("postgresql://test:synthetic@localhost/albayan_test_review")
    assert url.drivername == "postgresql+psycopg"
    assert url.host == "127.0.0.1"
    assert _connect_args(url) == {"connect_timeout": 10, "hostaddr": "127.0.0.1", "options": ""}
    assert _connect_args(url, "owned_schema")["options"] == "-csearch_path=owned_schema"


@pytest.fixture
def postgres_harness(monkeypatch):
    raw = os.getenv("ALBAYAN_TEST_POSTGRES_URL", "").strip()
    if not raw:
        pytest.skip("Set ALBAYAN_TEST_POSTGRES_URL to a disposable PostgreSQL database")
    url = _guarded_url(raw)
    schema = "codex_backup_test_" + uuid.uuid4().hex
    control = create_engine(url, connect_args=_connect_args(url))
    engine = None
    created = False
    try:
        with control.begin() as conn:
            assert conn.scalar(text("SELECT current_database()")) == url.database
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        engine = create_engine(url, connect_args=_connect_args(url, schema))
        create_backup_tables(engine)
        insert_entity(engine, data={"name": "Photo ad", "adPhotos": ["data:image/jpeg;base64,AAAA"]})
        yield make_harness(engine, monkeypatch)
    finally:
        try:
            if engine is not None:
                engine.dispose()
            if created:
                # Only the UUID-named schema created by this fixture is removed.
                assert schema.startswith("codex_backup_test_") and len(schema) == 50
                with control.begin() as conn:
                    conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        finally:
            control.dispose()


def test_postgres_export_streams_complete_media_and_metadata(postgres_harness):
    with postgres_harness.engine.begin() as conn:
        conn.execute(text("INSERT INTO users VALUES ('u','User','test@example.invalid','Employee','{}',false,1,NULL,1)"))
        conn.execute(text("INSERT INTO audit_logs VALUES ('a',1,'u','create','ads','ad-001','Created','{}')"))
    records = read_backup(postgres_harness.response())
    assert records[0]["dialect"] == "postgresql"
    assert records[-1]["complete"] is True
    assert records[-1]["counts"] == {"ads": 1, "users": 1, "auditLogs": 1}
    entity = next(record for record in records if record["_type"] == "entity")
    assert entity["data"]["adPhotos"] == ["data:image/jpeg;base64,AAAA"]
    assert_released(postgres_harness)


def test_postgres_uses_one_snapshot_across_tables(postgres_harness, monkeypatch):
    original = backup._entity_chunks
    inserted = False

    def write_during_export(row):
        nonlocal inserted
        if not inserted:
            inserted = True
            insert_entity(postgres_harness.engine, "ad-created-during-export")
            with postgres_harness.engine.begin() as conn:
                conn.execute(text("INSERT INTO users VALUES ('later','Later','later@example.invalid','Employee','{}',false,1,NULL,1)"))
        yield from original(row)

    monkeypatch.setattr(backup, "_entity_chunks", write_during_export)
    records = read_backup(postgres_harness.response())
    assert inserted
    assert records[-1]["complete"] is True
    assert records[-1]["counts"] == {"ads": 1}
    assert_released(postgres_harness)


def test_postgres_cancelled_stream_releases_its_pool_connection(postgres_harness):
    iterator = postgres_harness.response()._backup_iterator
    assert next(iterator)
    iterator.close()
    assert_released(postgres_harness)
    assert read_backup(postgres_harness.response())[-1]["complete"] is True
