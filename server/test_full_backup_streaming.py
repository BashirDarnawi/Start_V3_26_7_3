"""Isolated lifecycle/memory tests for the owner's full backup stream."""

import base64
import gzip
import hashlib
import json
import os
import threading
import tracemalloc
from types import SimpleNamespace

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import ClientDisconnect, Request

from server import full_backup as backup
from server import rate_limiter


def create_backup_tables(engine):
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE entities (type TEXT, id TEXT, data_json TEXT, deleted BOOLEAN, "
            "created_at BIGINT, created_by TEXT, last_modified BIGINT, PRIMARY KEY(type,id))"
        ))
        conn.execute(text(
            "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, "
            "permissions_json TEXT, deleted BOOLEAN, created_at BIGINT, created_by TEXT, last_modified BIGINT)"
        ))
        conn.execute(text(
            "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, ts BIGINT, user_id TEXT, action TEXT, "
            "resource_type TEXT, resource_id TEXT, message TEXT, metadata_json TEXT)"
        ))


def insert_entity(engine, entity_id="ad-001", data=None):
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO entities VALUES ('ads',:id,:data,false,1,'admin',1)"
        ), {"id": entity_id, "data": json.dumps(data or {"name": "Test ad"})})


def make_harness(engine, monkeypatch):
    events = []
    slot = threading.BoundedSemaphore(1)
    monkeypatch.setattr(backup, "get_engine", lambda: engine)
    monkeypatch.setattr(backup, "_STREAM_SLOT", slot)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda *a, **kw: (True, 2, 0))
    router = backup.create_full_backup_router(
        current_user_dependency=lambda: {"id": "admin", "role": "Admin"},
        audit_fn=lambda *args: events.append(args),
    )
    endpoint = next(route.endpoint for route in router.routes if route.path.endswith("/full"))
    request = Request({
        "type": "http", "method": "GET", "path": "/api/admin/backup/full", "headers": [],
        "client": ("127.0.0.1", 1234),
    })
    return SimpleNamespace(
        engine=engine, events=events, slot=slot,
        response=lambda: endpoint(request, {"id": "admin", "role": "Admin"}),
    )


@pytest.fixture
def harness(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'backup.sqlite3').as_posix()}")
    create_backup_tables(engine)
    insert_entity(engine)
    yield make_harness(engine, monkeypatch)
    engine.dispose()


def read_backup(response):
    raw = gzip.decompress(b"".join(response._backup_iterator))
    lines = raw.splitlines(keepends=True)
    records = [json.loads(line) for line in lines]
    footer = records[-1]
    assert footer["_type"] == "footer"
    assert footer["sha256"] == hashlib.sha256(b"".join(lines[:-1])).hexdigest()
    assert footer["bytes"] == sum(map(len, lines[:-1]))
    return records


def assert_released(harness):
    assert harness.engine.pool.checkedout() == 0
    assert harness.slot.acquire(blocking=False)
    harness.slot.release()


def test_complete_stream_has_verifiable_footer(harness):
    records = read_backup(harness.response())
    assert records[0]["format"] == backup.BACKUP_FORMAT
    assert records[-1]["complete"] is True
    assert records[-1]["counts"] == {"ads": 1}
    assert harness.events[-1][-1]["complete"] is True
    assert_released(harness)


def test_download_remains_a_real_gzip_file_after_http_decoding(harness):
    app = FastAPI()
    app.add_middleware(GZipMiddleware, minimum_size=1)
    app.include_router(backup.create_full_backup_router(
        current_user_dependency=lambda: {"id": "admin", "role": "Admin"},
        audit_fn=lambda *args: None,
    ))
    response = TestClient(app).get("/api/admin/backup/full")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/gzip"
    assert response.content.startswith(b"\x1f\x8b")
    records = [json.loads(line) for line in gzip.decompress(response.content).splitlines()]
    assert records[-1]["complete"] is True
    assert_released(harness)


@pytest.mark.parametrize("after_footer", [False, True])
def test_closing_generator_releases_connection_and_slot(harness, after_footer):
    response = harness.response()
    iterator = response._backup_iterator
    assert next(iterator)  # gzip header, while the DB connection is checked out
    if after_footer:
        assert next(iterator)  # small export fits in its final gzip chunk
    iterator.close()  # must never raise "generator ignored GeneratorExit"
    assert_released(harness)
    assert harness.events[-1][-1]["complete"] is False
    assert read_backup(harness.response())[-1]["complete"] is True


@pytest.mark.parametrize("fail_on", ["http.response.start", "http.response.body"])
def test_asgi_disconnect_closes_even_a_never_started_iterator(harness, fail_on):
    response = harness.response()

    async def exercise():
        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == fail_on:
                raise OSError("simulated browser disconnect")

        with pytest.raises((ClientDisconnect, OSError)):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)

    anyio.run(exercise)
    assert_released(harness)
    assert len([event for event in harness.events if event[1] == "backup_download_completed"]) == 1
    assert harness.events[-1][-1]["complete"] is False


def test_asgi_task_cancellation_also_runs_shielded_cleanup(harness):
    response = harness.response()

    async def exercise():
        first_body = anyio.Event()

        async def receive():
            await first_body.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                first_body.set()
                await anyio.sleep_forever()  # disconnected mid-send

        await response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send)

    anyio.run(exercise)
    assert_released(harness)
    assert harness.events[-1][-1]["complete"] is False


def test_midstream_failure_is_incomplete_without_leaking_exception(harness, monkeypatch):
    def fail(_row):
        raise RuntimeError("SECRET_ROW_OR_DRIVER_DATA")

    monkeypatch.setattr(backup, "_entity_chunks", fail)
    records = read_backup(harness.response())
    assert records[-1]["complete"] is False
    assert any(record["_type"] == "error" for record in records)
    assert "SECRET_ROW_OR_DRIVER_DATA" not in json.dumps(records)
    assert_released(harness)


def test_time_limit_marks_backup_incomplete(harness, monkeypatch):
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", -1)
    records = read_backup(harness.response())
    assert records[-1]["complete"] is False
    assert_released(harness)


def test_start_audit_failure_does_not_take_download_slot(harness, monkeypatch):
    router = backup.create_full_backup_router(
        current_user_dependency=lambda: {},
        audit_fn=lambda *args: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
    )
    endpoint = next(route.endpoint for route in router.routes if route.path.endswith("/full"))
    request = Request({"type": "http", "headers": []})
    with pytest.raises(RuntimeError, match="audit unavailable"):
        endpoint(request, {"id": "admin", "role": "Admin"})
    assert_released(harness)


def test_photo_heavy_stream_does_not_buffer_a_batch(harness):
    # 64 MiB of incompressible base64 media, created BEFORE memory accounting.
    # The old 200-row .all() implementation holds all 128 photos simultaneously.
    photo = "data:image/jpeg;base64," + base64.b64encode(os.urandom(384 * 1024)).decode("ascii")
    payload = json.dumps({"adPhotos": [photo]})
    with harness.engine.begin() as conn:
        conn.execute(text("INSERT INTO entities VALUES ('ads',:id,:data,false,1,'admin',1)"), [
            {"id": f"photo-{index:04}", "data": payload} for index in range(128)
        ])
    response = harness.response()
    tracemalloc.start()
    try:
        # Consume to a sink, just like the socket; do NOT retain response bytes.
        for _chunk in response._backup_iterator:
            pass
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        response._backup_iterator.close()
    assert peak < 8 * 1024 * 1024, f"Backup buffered {peak / 1024 / 1024:.1f} MiB"
    assert harness.events[-1][-1]["counts"]["ads"] == 129
    assert_released(harness)
