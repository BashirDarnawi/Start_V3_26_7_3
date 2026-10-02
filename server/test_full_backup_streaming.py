"""Isolated lifecycle/memory tests for the owner's full backup stream."""

import base64
import gzip
import hashlib
import json
import os
import threading
import tracemalloc
import zlib
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


def parse_cut_backup(data):
    """What reached the client of a backup the server could not finish: NOT a
    finished gzip, yet every line up to the complete:false footer is readable."""
    with pytest.raises(EOFError):  # gunzip: "unexpected end of file"
        gzip.decompress(data)
    inflater = zlib.decompressobj(31)
    raw = inflater.decompress(data)
    assert inflater.eof is False  # the gzip trailer was never written
    lines = raw.splitlines(keepends=True)
    records = [json.loads(line) for line in lines]
    footer = records[-1]
    assert footer["_type"] == "footer"
    assert footer["complete"] is False
    assert footer["sha256"] == hashlib.sha256(b"".join(lines[:-1])).hexdigest()
    assert footer["bytes"] == sum(map(len, lines[:-1]))
    return records


def read_cut_backup(response):
    chunks = []
    with pytest.raises(RuntimeError, match="^full backup incomplete$") as cut:
        for chunk in response._backup_iterator:
            chunks.append(chunk)
    # The server logs this exception with its chain: the swallowed SQL/driver
    # error (which may carry row data) must not ride along.
    assert cut.value.__cause__ is None and cut.value.__context__ is None
    return parse_cut_backup(b"".join(chunks))


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
    # Before: read_backup() opened this stream, i.e. the failed backup was a finished .gz.
    records = read_cut_backup(harness.response())
    assert records[-1]["complete"] is False
    assert any(record["_type"] == "error" for record in records)
    assert "SECRET_ROW_OR_DRIVER_DATA" not in json.dumps(records)
    assert_released(harness)
    assert harness.events[-1][1] == "backup_download_completed"
    assert harness.events[-1][-1]["complete"] is False
    assert "INCOMPLETE" in harness.events[-1][4]


def test_time_limit_marks_backup_incomplete(harness, monkeypatch):
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", -1)
    # Before: read_backup() opened this stream, i.e. the cut backup was a finished .gz.
    records = read_cut_backup(harness.response())
    assert records[0]["_type"] == "header"
    assert records[-1]["complete"] is False
    assert records[-1]["counts"] == {}  # stopped before the first row
    assert_released(harness)
    assert harness.events[-1][1] == "backup_download_completed"
    assert harness.events[-1][-1]["complete"] is False
    assert "INCOMPLETE" in harness.events[-1][4]
    # Nothing stays held: with the limit back, the next download is whole.
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", 30 * 60)
    assert read_backup(harness.response())[-1]["complete"] is True
    assert harness.events[-1][-1]["complete"] is True
    assert_released(harness)


def test_time_limit_is_configurable_and_keeps_its_default(monkeypatch):
    # The clock includes the browser's download time, so a large backup on a slow
    # line is cut (and now fails) at the same point on every retry: the limit is a setting.
    name = "ALBAYAN_FULL_BACKUP_MAX_SECONDS"
    assert backup.MAX_STREAM_SECONDS == backup._max_stream_seconds()  # the limit in force is the setting
    monkeypatch.delenv(name, raising=False)
    assert backup._max_stream_seconds() == 30 * 60
    for raw, seconds in (("7200", 7200), (" 3600 ", 3600), ("", 30 * 60), ("soon", 30 * 60),
                         ("5", 60), ("0", 60), ("-1", 60), ("999999", 6 * 60 * 60)):
        monkeypatch.setenv(name, raw)
        assert backup._max_stream_seconds() == seconds, raw


def run_asgi(response, spec_version):
    """Drive a response the way the server does: (messages sent, error raised or None)."""
    sent = []

    async def exercise():
        async def receive():
            await anyio.sleep_forever()  # the browser stays connected

        async def send(message):
            sent.append(message)

        try:
            await response({"type": "http", "asgi": {"spec_version": spec_version}}, receive, send)
        except Exception as exc:
            return exc
        return None

    return sent, anyio.run(exercise)


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
def test_cut_backup_aborts_the_response_instead_of_finishing_it(harness, monkeypatch, spec_version):
    # uvicorn writes the closing chunk only for a final body message (more_body
    # false). An app that raises mid-body gets its connection closed without
    # one, and that is what a browser reports as a failed download.
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", -1)
    sent, error = run_asgi(harness.response(), spec_version)
    assert type(error) is RuntimeError and str(error) == "full backup incomplete"
    assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 200
    bodies = sent[1:]
    assert bodies and all(m["type"] == "http.response.body" and m["more_body"] is True for m in bodies)
    parse_cut_backup(b"".join(m["body"] for m in bodies))
    assert_released(harness)
    assert len([event for event in harness.events if event[1] == "backup_download_completed"]) == 1
    assert harness.events[-1][-1]["complete"] is False

    # Control: a backup that finishes still ends both its response and its gzip.
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", 30 * 60)
    sent, error = run_asgi(harness.response(), spec_version)
    assert error is None
    assert sent[-1] == {"type": "http.response.body", "body": b"", "more_body": False}
    inflater = zlib.decompressobj(31)
    inflater.decompress(b"".join(m["body"] for m in sent[1:]))
    assert inflater.eof is True
    assert harness.events[-1][-1]["complete"] is True
    assert_released(harness)


def test_cut_backup_never_downloads_as_a_finished_gzip(harness, monkeypatch):
    # The real app's layering: @app.middleware("http") functions around the
    # route. Each one ENDS the response normally when the layer below fails,
    # so without the guard the browser was still handed a finished download.
    app = FastAPI()
    app.add_middleware(GZipMiddleware, minimum_size=1)
    app.include_router(backup.create_full_backup_router(
        current_user_dependency=lambda: {"id": "admin", "role": "Admin"},
        audit_fn=lambda *args: harness.events.append(args),
    ))

    @app.middleware("http")
    async def inner_layer(request, call_next):
        return await call_next(request)

    @app.middleware("http")
    async def outer_layer(request, call_next):
        response = await call_next(request)
        response.headers["X-Request-ID"] = "test"
        return response

    app.add_middleware(backup.AbortCutBackupDownload)  # last = outermost, as in server/main.py
    wire = []  # every message the whole app hands the server

    async def recorded(scope, receive, send):
        async def record(message):
            wire.append(message)
            await send(message)

        await app(scope, receive, record)

    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", -1)
    with pytest.raises(RuntimeError, match="^full backup incomplete$"):
        TestClient(recorded).get("/api/admin/backup/full")  # the server sees a failed request
    assert wire[0]["type"] == "http.response.start" and wire[0]["status"] == 200  # the headers had already left
    headers = dict(wire[0]["headers"])
    assert headers[b"content-type"] == b"application/gzip"
    assert headers[b"content-encoding"] == b"identity"  # the middleware did not re-compress it
    bodies = wire[1:]
    # No closing chunk: uvicorn then drops the connection and the browser reports a failed download.
    assert bodies and all(m["type"] == "http.response.body" and m["more_body"] is True for m in bodies)
    sent = b"".join(m["body"] for m in bodies)
    assert sent.startswith(b"\x1f\x8b")
    # Before: gzip.decompress() opened these bytes without complaint.
    records = parse_cut_backup(sent)
    assert records[0]["_type"] == "header"
    assert_released(harness)
    assert harness.events[-1][-1]["complete"] is False

    # Control: with the limit back, the same app ends the download properly.
    monkeypatch.setattr(backup, "MAX_STREAM_SECONDS", 30 * 60)
    del wire[:]
    response = TestClient(recorded).get("/api/admin/backup/full")
    assert response.status_code == 200 and response.headers["x-request-id"] == "test"
    assert wire[-1]["type"] == "http.response.body" and not wire[-1].get("more_body", False)
    assert [json.loads(line) for line in gzip.decompress(response.content).splitlines()][-1]["complete"] is True
    assert harness.events[-1][-1]["complete"] is True
    assert_released(harness)


def test_closing_chunk_guard_only_holds_the_backup_download():
    order = []

    async def failing_after_the_closing_chunk(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"part", "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        order.append("app continues")
        if scope.get("fail"):
            raise RuntimeError("full backup incomplete")

    def run(scope):
        del order[:]
        sent = []

        async def exercise():
            async def send(message):
                sent.append(message)
                order.append(message["type"] + ("" if message.get("more_body", True) else ":closing"))

            try:
                await backup.AbortCutBackupDownload(failing_after_the_closing_chunk)(scope, None, send)
            except RuntimeError as exc:
                return exc
            return None

        return sent, anyio.run(exercise), list(order)

    closing = {"type": "http.response.body", "body": b"", "more_body": False}
    download = {"type": "http", "path": backup.FULL_BACKUP_PATH}
    # A failed download: the closing chunk never leaves.
    sent, error, _ = run({**download, "fail": True})
    assert str(error) == "full backup incomplete" and closing not in sent and len(sent) == 2
    # A finished download: it leaves once the app has ended cleanly.
    sent, error, seen = run(download)
    assert error is None and sent[-1] == closing and seen[-2:] == ["app continues", "http.response.body:closing"]
    # Every other address is passed straight through, untouched and unheld.
    for scope in ({"type": "http", "path": "/api/admin/backup/full/estimate", "fail": True},
                  {"type": "http", "path": "/api/users", "fail": True},
                  {"type": "websocket", "path": backup.FULL_BACKUP_PATH, "fail": True}):
        sent, error, seen = run(scope)
        assert str(error) == "full backup incomplete"
        assert sent[-1] == closing and seen[-2:] == ["http.response.body:closing", "app continues"]


def test_closing_chunk_guard_watches_the_real_download_route():
    router = backup.create_full_backup_router(current_user_dependency=lambda: {}, audit_fn=lambda *args: None)
    assert backup.FULL_BACKUP_PATH in [route.path for route in router.routes]


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
