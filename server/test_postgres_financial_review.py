"""Opt-in real PostgreSQL checks for financial review regressions.

Run: ALBAYAN_TEST_POSTGRES_URL=<loopback test DB URL> python -m pytest
     server/test_postgres_financial_review.py -q

Never falls back to DATABASE_URL. The explicit target must be PostgreSQL on
loopback, with database name albayan_test[_...] or test_albayan[_...]. Each
scenario owns a random temporary schema, dropped in the parent even if its
child times out. Application code runs in a child process so SQLite fixtures
and cached engines in the ordinary suite cannot redirect these tests.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path
from threading import Barrier, Event

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url


ROOT = Path(__file__).resolve().parent.parent
SCHEMA_RE = re.compile(r"^albayan_fin_review_[0-9a-f]{32}$")
TEST_DATABASE_RE = re.compile(r"^(?:albayan_test|test_albayan)(?:_[a-z0-9_]+)?$")
SCENARIOS = ("refund", "company_budget", "debt_growth", "concurrent_funding",
             "coverage_lifecycle", "coverage_lock_order", "coverage_overlaps", "period_lock_protocol",
             "legacy_compatibility", "legacy_backfills",
             "campaign_submit_serialisation", "campaign_withdraw_vs_approve", "campaign_approval_self_release",
             "campaign_submit_vs_sibling_approval", "studio_privacy_scrub")


def _guarded_url(raw: str) -> URL:
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError("Invalid explicit PostgreSQL test URL") from None
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise ValueError("Financial integration tests require PostgreSQL/psycopg")
    if url.host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("Financial integration tests require a loopback host")
    if not TEST_DATABASE_RE.fullmatch(url.database or ""):
        raise ValueError("Financial integration tests require a disposable test database name")
    if not url.username or url.query:
        # In particular, libpq host/hostaddr/service/options parameters must
        # never override the validated host or the generated search_path.
        raise ValueError("Explicit test username required; URL query overrides are forbidden")
    return url.set(drivername="postgresql+psycopg", host="127.0.0.1" if url.host == "localhost" else url.host)


def _explicit_url() -> URL:
    raw = (os.getenv("ALBAYAN_TEST_POSTGRES_URL") or "").strip()
    if not raw:
        pytest.skip("Set ALBAYAN_TEST_POSTGRES_URL to opt into disposable PostgreSQL tests")
    return _guarded_url(raw)


def _child_environment(url: URL, schema: str) -> dict[str, str]:
    env = {
        name: value for name, value in os.environ.items()
        if name != "DATABASE_URL" and not name.startswith(("ALBAYAN_", "PG"))
    }
    env.update({
        "ALBAYAN_TEST_POSTGRES_URL": url.render_as_string(hide_password=False),
        "PG_FINANCIAL_TEST_SCHEMA": schema,
        "ALBAYAN_META_BACKGROUND_SYNC": "false",
        "ALBAYAN_BACKUP_ENABLED": "false",
        "ALBAYAN_DB_POOL_SIZE": "6",
        "ALBAYAN_DB_MAX_OVERFLOW": "4",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


@pytest.fixture
def postgres_scenario_target():
    url = _explicit_url()
    schema = f"albayan_fin_review_{uuid.uuid4().hex}"
    assert SCHEMA_RE.fullmatch(schema)
    # Override PGHOSTADDR/PGSERVICE defaults as well as the URL host; libpq
    # otherwise lets inherited environment settings redirect this connection.
    control = create_engine(url, connect_args={"connect_timeout": 10, "hostaddr": url.host})
    created = False
    try:
        with control.begin() as conn:
            assert conn.scalar(text("SELECT current_database()")) == url.database
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            created = True
        yield url, schema
    finally:
        try:
            if created:
                with control.begin() as conn:
                    conn.execute(text("SET LOCAL lock_timeout = '10s'"))
                    conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        finally:
            control.dispose()


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_postgres_financial_workflow(postgres_scenario_target, scenario):
    url, schema = postgres_scenario_target
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--scenario", scenario],
        cwd=ROOT, env=_child_environment(url, schema),
        capture_output=True, text=True, timeout=120,
    )
    output = result.stdout + result.stderr
    for secret in (url.render_as_string(hide_password=False), url.password):
        if secret:
            output = output.replace(secret, "[redacted]")
    assert result.returncode == 0, output
    assert f"PASS postgresql {scenario}" in result.stdout, output


@pytest.mark.parametrize("url", [
    "sqlite+pysqlite:///:memory:",
    "postgresql://test:secret@production.example.com/albayan_test_review",
    "postgresql://test:secret@127.0.0.1/production",
    "postgresql://test:secret@127.0.0.1/albayan_test_review?host=production.example.com",
    "postgresql://test:secret@127.0.0.1/albayan_test_review?options=-csearch_path=public",
    "postgresql:///albayan_test_review",
])
def test_postgres_test_target_rejects_unsafe_urls(url):
    with pytest.raises(ValueError):
        _guarded_url(url)


def test_postgres_tests_never_infer_target_from_database_url(monkeypatch):
    monkeypatch.delenv("ALBAYAN_TEST_POSTGRES_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://production.example.com/live")
    with pytest.raises(pytest.skip.Exception):
        _explicit_url()


def test_postgres_child_drops_inherited_database_and_worker_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://production.example.com/live")
    monkeypatch.setenv("PGHOSTADDR", "203.0.113.5")
    monkeypatch.setenv("PGSERVICE", "production")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "not-a-real-token")
    monkeypatch.setenv("ALBAYAN_BACKUP_ENABLED", "true")
    url = _guarded_url("postgresql://test:secret@127.0.0.1/albayan_test_review")
    env = _child_environment(url, f"albayan_fin_review_{uuid.uuid4().hex}")
    assert not {"DATABASE_URL", "PGHOSTADDR", "PGSERVICE", "ALBAYAN_META_ACCESS_TOKEN"}.intersection(env)
    assert env["ALBAYAN_META_BACKGROUND_SYNC"] == env["ALBAYAN_BACKUP_ENABLED"] == "false"


def _concurrent_funding(t, actors) -> None:
    from fastapi.testclient import TestClient
    from server.db import db_conn, json_loads
    from server.main import app

    customer_id, receipt_id = "pg_race_customer", "pg_race_receipt"
    t._customer(customer_id, actors)
    t._paid_receipt(receipt_id, customer_id, 100, actors)

    def race(payloads):
        barrier = Barrier(2)

        def submit(payload):
            client = TestClient(app, headers={"Origin": "http://testserver"})
            try:
                barrier.wait(timeout=10)
                response = client.post("/api/ads/mutate", json=payload, cookies=actors["admin"])
                return response.status_code, response.json()
            finally:
                client.close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(submit, payload) for payload in payloads]
            return [future.result(timeout=40) for future in futures]

    def create_payload(ad_id, key, amount):
        return {
            "action": "create", "adId": ad_id, "idempotencyKey": key,
            "data": {"customerId": customer_id, "paymentStatus": "paid",
                     "receiptAllocations": [{"receiptId": receipt_id, "amountUSD": amount}]},
        }

    # Both independent requests see the same receipt, but PostgreSQL row
    # locks must serialize the capacity check so only one $80 draw commits.
    competing = race([
        create_payload("pg_race_ad_a", "pg-race-fund-a", 80),
        create_payload("pg_race_ad_b", "pg-race-fund-b", 80),
    ])
    assert sorted(status for status, _ in competing) == [200, 409], competing
    duplicate = create_payload("pg_idem_ad", "pg-race-same-key", 20)
    replay = race([duplicate, duplicate])
    assert [status for status, _ in replay] == [200, 200], replay
    assert sorted(body["replayed"] for _, body in replay) == [False, True], replay
    assert replay[0][1]["ad"]["id"] == replay[1][1]["ad"]["id"] == "pg_idem_ad"
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND deleted=false")).scalars().all()
        allocations = [entry for row in rows for entry in json_loads(row).get("receiptAllocations", [])]
        assert sum(round(entry["amountUSD"] * 100) for entry in allocations if entry["receiptId"] == receipt_id) == 10_000
        assert len(rows) == 2


def _coverage_lock_order(t, actors) -> None:
    """Force the previously deadlocking overlap, using real PostgreSQL locks.

    Hold an ordinary ad edit after its ad lock, then let customer coverage
    reach that same ad. Old code held the customer while waiting for the ad,
    so the edit's next customer lock deadlocked. Fixed code holds no customer
    lock yet, so the edit finishes and coverage continues without HTTP 500.
    """
    from fastapi.testclient import TestClient
    from sqlalchemy import event
    from server.db import get_engine

    cid, aid = "pg_coverage_lock_c", "pg_coverage_lock_a"
    t._customer(cid, actors)
    created = t.client.post("/api/ads/mutate", json={
        "action": "create", "adId": aid, "idempotencyKey": "pg-coverage-lock-create",
        "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                 "exchangeRate": 5, "collectionPayments": [{"method": "Cash (USD)", "amount": 100, "rate": 1, "rate2": 1}]},
    }, cookies=actors["admin"])
    assert created.status_code == 200, created.text
    ad = created.json()["ad"]
    ad_held, coverage_attempted_ad = Event(), Event()
    holder = []

    def before_lock(conn, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" in statement and isinstance(parameters, dict) and parameters.get("type") == "ads" and parameters.get("id") == aid:
            if holder and conn is not holder[0]:
                coverage_attempted_ad.set()

    def after_lock(conn, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" in statement and isinstance(parameters, dict) and parameters.get("type") == "ads" and parameters.get("id") == aid and not holder:
            holder.append(conn)
            ad_held.set()
            assert coverage_attempted_ad.wait(8), "Coverage never attempted its ad lock"

    def post(path, payload):
        client = TestClient(t.app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)
        try:
            response = client.post(path, json=payload, cookies=actors["admin"])
            return response.status_code, response.text
        finally:
            client.close()

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", before_lock)
    event.listen(engine, "after_cursor_execute", after_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            editing = pool.submit(post, "/api/ads/mutate", {
                "action": "update", "adId": aid, "idempotencyKey": "pg-coverage-lock-edit",
                "expectedLastModified": ad["lastModified"], "data": {"notes": "Concurrent note edit"},
            })
            assert ad_held.wait(8)
            covering = pool.submit(post, f"/api/customers/{cid}/company-coverages", {
                "amountMinorUSD": 4000, "expectedOutstandingMinorUSD": 10000,
                "idempotencyKey": "pg-coverage-lock-cover", "reason": "Isolated concurrency test",
            })
            results = [editing.result(timeout=30), covering.result(timeout=30)]
        assert [status for status, _ in results] == [200, 200], results
        saved = t._entity("ads", aid, actors["admin"])["data"]
        assert saved["notes"] == "Concurrent note edit"
        assert saved["companyDirectCoverageUSD"] == 40
    finally:
        event.remove(engine, "before_cursor_execute", before_lock)
        event.remove(engine, "after_cursor_execute", after_lock)


def _coverage_overlaps(t, actors) -> None:
    """Exercise customer coverage alongside the other financial lock paths."""
    from fastapi.testclient import TestClient
    from server.company_debt_coverage import company_pool_total_minor

    for operation in ("receipt_cover", "settle", "relink", "create"):
        tag = "pg_overlap_" + operation
        cid, rid, aid = tag + "_c", tag + "_r", tag + "_a"
        t._customer(cid, actors)
        receipt = t._unpaid_receipt(rid, cid, 100, actors)
        ad = t._create_ad(aid, cid, rid, 100, actors)
        created = t.client.post("/api/ads/mutate", json={
            "action": "create", "adId": tag + "_gap", "idempotencyKey": tag + "_gap_create",
            "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                     "exchangeRate": 5, "collectionPayments": [{"method": "Cash (USD)", "amount": 100, "rate": 1, "rate2": 1}]},
        }, cookies=actors["admin"])
        assert created.status_code == 200, created.text
        if operation == "receipt_cover":
            competing_path = f"/api/receipts/{rid}/company-coverages"
            payload = {"amountMinorUSD": 4000, "expectedLastModified": receipt["lastModified"],
                       "idempotencyKey": tag + "_receipt_cover", "reason": "Isolated receipt coverage"}
        elif operation == "settle":
            competing_path = f"/api/receipts/{rid}/settle"
            payload = {"expectedLastModified": receipt["lastModified"], "idempotencyKey": tag + "_settle"}
        elif operation == "relink":
            t._unpaid_receipt(tag + "_next_r", cid, 100, actors)
            competing_path = "/api/ads/mutate"
            payload = {"action": "update", "adId": aid, "expectedLastModified": ad["lastModified"],
                       "idempotencyKey": tag + "_relink", "data": {"relinkReceiptOnly": True,
                       "receiptId": tag + "_next_r", "receiptAllocations": [],
                       "dueAllocations": [{"receiptId": tag + "_next_r", "amountUSD": 100}]}}
        else:
            t._paid_receipt(tag + "_paid", cid, 10, actors)
            competing_path = "/api/ads/mutate"
            payload = {"action": "create", "adId": tag + "_new", "idempotencyKey": tag + "_create",
                       "data": {"customerId": cid, "paymentStatus": "paid",
                                "receiptAllocations": [{"receiptId": tag + "_paid", "amountUSD": 10}]}}
        barrier = Barrier(2)

        def post(path, body):
            client = TestClient(t.app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)
            try:
                barrier.wait(timeout=10)
                result = client.post(path, json=body, cookies=actors["admin"])
                return result.status_code, result.text
            finally:
                client.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            coverage = pool.submit(post, f"/api/customers/{cid}/company-coverages", {
                "amountMinorUSD": 4000, "expectedOutstandingMinorUSD": 10000,
                "idempotencyKey": tag + "_customer_cover", "reason": "Isolated simultaneous coverage",
            })
            competing = pool.submit(post, competing_path, payload)
            results = [coverage.result(timeout=30), competing.result(timeout=30)]
        assert results[1][0] == 200, results
        assert results[0][0] in ({200, 409} if operation == "create" else {200}), results
        # The receiptless ad can only get its one $40 company allocation.
        saved = t._entity("ads", tag + "_gap", actors["admin"])["data"]
        assert company_pool_total_minor(saved) == (4000 if results[0][0] == 200 else 0)


def _period_lock_protocol(t, actors) -> None:
    """Real writers coexist; close waits for them and protects later writes."""
    from fastapi import HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy import event
    from server.db import get_engine
    from server.main import _insert_entity_in_transaction
    from server.operations import _lock_financial_period, _financial_period_lock_key

    engine = get_engine()
    period = "2020-01"
    cid, rid = "pg_period_c", "pg_period_r"
    t._customer(cid, actors)
    close_attempted = Event()

    def before_close(conn, cursor, statement, parameters, context, executemany):
        if "SELECT pg_advisory_xact_lock(" in statement and parameters.get("lock_key") == _financial_period_lock_key(period):
            close_attempted.set()

    def close():
        client = TestClient(t.app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)
        try:
            response = client.post("/api/admin/operations/financial-periods/close", json={"period": period}, cookies=actors["admin"])
            return response.status_code, response.json()
        finally:
            client.close()

    event.listen(engine, "before_cursor_execute", before_close)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with engine.begin() as writer:
                _lock_financial_period(writer, period)
                # A second same-month writer must not queue behind the first.
                with engine.begin() as other:
                    other.execute(text("SET LOCAL statement_timeout='1500ms'"))
                    _lock_financial_period(other, period)
                _insert_entity_in_transaction(writer, "receipts", rid, {
                    "recordType": "receipt", "customerId": cid, "date": period + "-05",
                    "status": "Paid", "isPaid": True, "amountUSD": 12, "amountLocal": 60,
                    "exchangeRate": 5, "deliveryStatus": "Office",
                }, actors["admin_id"])
                closing = pool.submit(close)
                assert close_attempted.wait(5)
                with pytest.raises(FutureTimeoutError):
                    closing.result(timeout=0.1)
            status, result = closing.result(timeout=15)
        assert status == 200, result
        # The snapshot includes the committed write the close waited for.
        assert result["snapshot"]["totals"]["paidReceiptsUSD"] == 12
        changed = t.client.patch(f"/api/collections/receipts/{rid}", json={"data": {"notes": "must reject"}}, cookies=actors["admin"])
        assert changed.status_code == 423, changed.text
        unlocked = t.client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "Isolated test reopening"}, cookies=actors["admin"])
        assert unlocked.status_code == 200, unlocked.text
        changed = t.client.patch(f"/api/collections/receipts/{rid}", json={"data": {"notes": "open again"}}, cookies=actors["admin"])
        assert changed.status_code == 200, changed.text
        # An active exclusive close never leaves a row-holding writer queued.
        with engine.begin() as closer:
            _lock_financial_period(closer, period, exclusive=True)
            with engine.begin() as writer:
                with pytest.raises(HTTPException) as blocked:
                    _lock_financial_period(writer, period)
                assert blocked.value.status_code == 409
    finally:
        event.remove(engine, "before_cursor_execute", before_close)


def _legacy_backfills(actors) -> None:
    """Real PostgreSQL media-safe backfills publish monotonic delta cursors."""
    from server import backfills, main
    from server.db import db_conn, json_dumps, json_loads
    from server.operations import FINANCIAL_CLOSE_COLLECTION

    media = "data:image/png;base64," + ("A" * 40_000)
    records = [
        ("customers", "pg_legacy_customer", {"name": "Original customer"}),
        ("receipts", "pg_legacy_name", {"customerId": "pg_legacy_customer", "amountUSD": 100, "photos": [media]}),
        ("receipts", "pg_legacy_settled", {"status": "Paid", "amountUSD": 100, "amountLocal": 500,
                                          "companyCoveredUSD": 40, "customerOutstandingUSD": 60, "photos": [media]}),
        ("ads", "pg_legacy_relink", {"receiptAllocations": [{"receiptId": "current", "amountUSD": 60}],
                                    "stopAllocationBaseline": {"receipt": [{"receiptId": "vacated", "amountUSD": 60}]},
                                    "adPhotos": [media]}),
        ("receipts", "pg_legacy_closed", {"status": "Paid", "amountUSD": 100, "amountLocal": 500,
                                         "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
                                         "date": "2024-02-10", "photos": [media]}),
        (FINANCIAL_CLOSE_COLLECTION, "financial-close-2024-02", {"period": "2024-02", "status": "closed"}),
    ]
    with db_conn() as conn:
        for collection, entity_id, data in records:
            conn.execute(text(
                "INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES(:type,:id,:data,false,1,:creator,1000)"
            ), {"type": collection, "id": entity_id, "data": json_dumps(data),
                "creator": actors["admin_id"]})

    def raw():
        with db_conn() as conn:
            return {row["id"]: dict(row) for row in conn.execute(text(
                "SELECT id,data_json,last_modified,created_at,created_by FROM entities ORDER BY type,id"
            )).mappings()}

    before = raw()
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(backfills, "now_ms", lambda: 200)
        monkeypatch.setattr(backfills, "_BACKFILL_SCAN_BATCH_SIZE", 2)
        assert backfills.backfill_customer_names() == 1
        assert backfills.backfill_covered_settled_receipts() == 1
        assert backfills.backfill_relink_baselines() == 1
        after = raw()
        for collection, entity_id, field in [
            ("receipts", "pg_legacy_name", "photos"),
            ("receipts", "pg_legacy_settled", "photos"),
            ("ads", "pg_legacy_relink", "adPhotos"),
        ]:
            row = after[entity_id]
            data = json_loads(row["data_json"])
            assert row["last_modified"] == data["_lastModified"] == 1001
            assert row["created_at"] == 1 and row["created_by"] == actors["admin_id"]
            assert data[field] == [media]
            assert entity_id in {item["id"] for item in main.list_entities(collection, updated_since=1000)}
        assert after["pg_legacy_closed"] == before["pg_legacy_closed"]
        assert after["financial-close-2024-02"] == before["financial-close-2024-02"]
        assert backfills.backfill_customer_names() == 0
        assert backfills.backfill_covered_settled_receipts() == 0
        assert backfills.backfill_relink_baselines() == 0
        assert raw() == after


def _run_scenario(scenario: str) -> None:
    if scenario not in SCENARIOS:
        raise ValueError("Unknown PostgreSQL financial test scenario")
    url = _guarded_url(os.environ.get("ALBAYAN_TEST_POSTGRES_URL", ""))
    schema = os.environ.get("PG_FINANCIAL_TEST_SCHEMA", "")
    if not SCHEMA_RE.fullmatch(schema):
        raise ValueError("A generated, isolated financial test schema is required")
    scoped_url = url.update_query_dict({
        "options": f"-csearch_path={schema} -cstatement_timeout=15000 -clock_timeout=5000",
        "connect_timeout": "10",
        "hostaddr": str(url.host),
    })
    # Set before importing any application module, and never start the app
    # lifespan: no background workers, scheduled backups, or startup repairs.
    os.environ["DATABASE_URL"] = scoped_url.render_as_string(hide_password=False)
    sys.path.insert(0, str(ROOT))
    from server.db import get_engine
    engine = get_engine()
    try:
        assert engine.dialect.name == "postgresql"
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT current_schema()")) == schema
            assert conn.scalar(text("SELECT current_database()")) == url.database
            assert conn.scalar(text("SELECT count(*) FROM information_schema.tables WHERE table_schema=:schema"), {"schema": schema}) == 0
        from server import test_receipt_company_coverages as t
        actors = t.actors.__wrapped__()
        try:
            assert get_engine() is engine, "Imported fixtures redirected the PostgreSQL engine"
            if scenario == "refund":
                for refund_type, amount in (("Partial", 2), ("Full", 10)):
                    t.test_refund_status_update_keeps_exact_money_through_api(actors, refund_type, amount)
            elif scenario == "company_budget":
                for amount in (40, 100):
                    t.test_covered_ad_budget_survives_note_edit_and_paid_conversion(actors, amount)
            elif scenario == "debt_growth":
                t.test_covered_receipt_outstanding_tracks_debt_growth_and_release(actors)
            elif scenario == "coverage_lifecycle":
                from server import test_financial_lifecycle_regressions as lifecycle
                for covered in (20, 40, 60):
                    for stopped in (False, True):
                        for settle in (False, True):
                            lifecycle.test_refund_cover_undo_conserves_funding(actors, covered, stopped, settle)
                for covered in (40, 100):
                    for operation in ("ad", "transfer"):
                        lifecycle.test_settled_coverage_leaves_real_customer_cash_available(actors, operation, covered)
                lifecycle.test_direct_receipt_debt_edits_refresh_outstanding_and_next_coverage(actors)
                lifecycle.test_coverage_still_reserves_unpaid_capacity(actors)
                for settle in (False, True):
                    lifecycle.test_mixed_paid_due_refund_coverage_and_undo(actors, settle)
            elif scenario == "coverage_lock_order":
                _coverage_lock_order(t, actors)
            elif scenario == "coverage_overlaps":
                _coverage_overlaps(t, actors)
            elif scenario == "period_lock_protocol":
                _period_lock_protocol(t, actors)
            elif scenario == "legacy_compatibility":
                from server import test_financial_compatibility as compatibility
                compatibility.test_old_receipt_api_list_and_detail_project_without_writing(actors)
                compatibility.test_old_receipt_corrected_response_can_be_edited_without_405(actors)
                compatibility.test_old_receipt_can_cover_corrected_outstanding_not_stale_cache(actors)
                compatibility.test_old_ad_derived_summary_echoes_do_not_mutate_coverage_rows()
                with pytest.MonkeyPatch.context() as monkeypatch:
                    compatibility.test_closed_period_old_receipt_is_readable_but_not_rewritten(actors, monkeypatch)
            elif scenario == "legacy_backfills":
                _legacy_backfills(actors)
            elif scenario == "campaign_submit_serialisation":
                _campaign_submit_serialisation(t)
            elif scenario == "campaign_withdraw_vs_approve":
                _campaign_withdraw_vs_approve(t)
            elif scenario == "campaign_approval_self_release":
                _campaign_approval_self_release(t)
            elif scenario == "campaign_submit_vs_sibling_approval":
                _campaign_submit_vs_sibling_approval(t)
            elif scenario == "studio_privacy_scrub":  # P1-16: anonymisation vs a reply-log write, both orders
                from server import test_studio_privacy as privacy
                privacy.postgres_scrub_race()
            else:
                _concurrent_funding(t, actors)
            assert get_engine() is engine, "Financial scenario changed its database target"
        finally:
            t.client.close()
        print(f"PASS postgresql {scenario}")
    finally:
        engine.dispose()


# Albayan Studio money races (PLAN.md 7.8 lock table; TASKS P1-02, P1-03, P1-03b, P1-19).
# Row-lock statements are told apart by their SQL text: submit and withdraw lock the request
# with "SELECT * FROM entities", an approval's capture with "SELECT data_json FROM entities
# WHERE type = 'adCampaignRequests'", its status write (main.patch_entity) with "SELECT type,
# id, data_json, ...", and submit locks the owner with "SELECT id FROM users".

_ACTION_ROW_LOCK = "SELECT * FROM entities WHERE type = "
_CAPTURE_ROW_LOCK = "SELECT data_json FROM entities WHERE type = 'adCampaignRequests'"
_STATUS_WRITE_ROW_LOCK = "SELECT type, id, data_json, deleted, created_at, created_by, last_modified FROM entities"
_OWNER_ROW_LOCK = "SELECT id FROM users WHERE id = "


def _row_lock(statement, parameters, lock_sql: str, row_id: str) -> bool:
    return (
        lock_sql in statement and "FOR UPDATE" in statement
        and isinstance(parameters, dict) and parameters.get("id") == row_id
    )


def _studio_actors():
    """The Ads Studio actors of test_ad_studio_backend (admin, funded customers, reviewer)."""
    from server import test_ad_studio_backend as ad
    return ad, ad.actors.__wrapped__()


def _studio_post(app, path: str, body: dict, cookies: dict, barrier=None):
    from fastapi.testclient import TestClient

    client = TestClient(app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)
    try:
        if barrier is not None:
            barrier.wait(timeout=10)
        response = client.post(path, json=body, cookies=cookies)
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, response.text
    finally:
        client.close()


def _studio_sent(ad, cookies: dict, campaign_id: str) -> int:
    """create -> submit ($25 lifetime); the Submitted row's lastModified."""
    created = ad._create_campaign(cookies, ad._complete_campaign(f"PG {campaign_id}"), campaign_id)
    assert created.status_code == 200, created.text
    sent = ad._submit_campaign(cookies, campaign_id, created.json()["lastModified"], f"{campaign_id}-send")
    assert sent.status_code == 200, sent.text
    return sent.json()["lastModified"]


def _studio_request(campaign_id: str) -> dict:
    from server.db import db_conn, json_loads

    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = 'adCampaignRequests' AND id = :id"),
                           {"id": campaign_id}).scalar_one()
    return json_loads(raw) or {}


def _studio_money(campaign_id: str) -> dict[str, list[int]]:
    """One request's ledger rows (every cycle), as amounts by row type."""
    from server.db import db_conn, json_loads

    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type = 'walletTransactions' AND deleted = false")).scalars().all()
    money: dict[str, list[int]] = {"campaign_payment": [], "campaign_payment_release": [], "campaign_refund": []}
    pay = f"cpay:{campaign_id}:"
    for raw in rows:
        data = json_loads(raw) or {}
        if str(data.get("idempotencyKey") or "").startswith((pay, "rel:" + pay, "stoprefund:" + pay)):
            money.setdefault(str(data.get("type") or ""), []).append(int(data["amountMinor"]))
    return money


def _studio_balance(user_id: str) -> int:
    from server import main
    from server.db import db_conn

    with db_conn() as conn:
        return main._wallet_balance_minor(conn, user_id, "USD")


def _assert_studio_wallet_identity(user_id: str) -> dict:
    """PLAN.md 7.8, from the studio wallet summary (one REPEATABLE READ snapshot): added +
    adjustments - in ads - being returned - spent = available + reserved, available is the
    number every debit checks, and available + reserved is the USD ledger balance."""
    from datetime import datetime, timezone
    from server import main
    from server.db import db_conn
    from server.systems.ads_studio.studio_wallet import wallet_summary

    with db_conn() as conn:
        usd = wallet_summary(conn, user_id, datetime.now(timezone.utc))["usd"]
    with db_conn() as conn:
        balance = main._wallet_balance_minor(conn, user_id, "USD")
        available = main._wallet_available_after_holds(conn, user_id, "USD")
    left = usd["addedMinor"] + usd["adjustmentsMinor"] - usd["inAdsMinor"] - usd["beingReturnedMinor"] - usd["spentMinor"]
    assert left == usd["availableMinor"] + usd["reservedMinor"], usd
    assert usd["availableMinor"] == available and usd["availableMinor"] + usd["reservedMinor"] == balance, (usd, balance)
    return usd


def _with_hooks(engine, before=None, after=None):
    """Listen for the duration of a with block (removed even when an assertion fails)."""
    from contextlib import contextmanager
    from sqlalchemy import event

    @contextmanager
    def listening():
        hooks = [(name, hook) for name, hook in (("before_cursor_execute", before), ("after_cursor_execute", after)) if hook]
        for name, hook in hooks:
            event.listen(engine, name, hook)
        try:
            yield
        finally:
            for name, hook in hooks:
                event.remove(engine, name, hook)
    return listening()


def _campaign_submit_serialisation(t) -> None:
    """P1-02: two sends of one owner whose budgets together exceed Available ($25 + $25 > $40).

    The first send to lock the owner's user row keeps it until the second send is queued on
    that same row, so both are provably inside submit at once; the second then counts the
    first one's hold. Exactly one is refused with the usual "Insufficient wallet balance" 409.
    """
    from server.db import db_conn, get_engine
    from server.wallet_payments import wallet_campaign_holds_minor

    ad, studio = _studio_actors()
    user, cookies = ad._fresh_funded_customer(studio, "pgsubmit", 4000)
    drafts = {}
    for tag in ("a", "b"):
        created = ad._create_campaign(cookies, ad._complete_campaign(f"PG submit {tag}"), f"pg_submit_{tag}")
        assert created.status_code == 200, created.text
        drafts[f"pg_submit_{tag}"] = created.json()["lastModified"]
    holder, queued = [], Event()

    def queue_second(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _OWNER_ROW_LOCK, user["id"]) and holder and conn is not holder[0]:
            queued.set()

    def hold_first(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _OWNER_ROW_LOCK, user["id"]) and not holder:
            holder.append(conn)
            assert queued.wait(10), "The second send never queued on the owner's row"

    barrier = Barrier(2)
    with _with_hooks(get_engine(), before=queue_second, after=hold_first):
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {
                cid: pool.submit(_studio_post, t.app, f"/api/ad-studio/campaigns/{cid}/submit",
                                 {"expectedLastModified": lm, "operationId": f"{cid}-send"}, cookies, barrier)
                for cid, lm in drafts.items()
            }
            results = {cid: future.result(timeout=40) for cid, future in futures.items()}
    assert queued.is_set(), results
    assert sorted(status for status, _ in results.values()) == [200, 409], results
    refused = next(body for status, body in results.values() if status == 409)
    assert str(refused["detail"]).startswith("Insufficient wallet balance"), refused
    assert sorted(_studio_request(cid)["status"] for cid in drafts) == ["Draft", "Submitted"], results
    with db_conn() as conn:
        assert wallet_campaign_holds_minor(conn, user["id"]) == 2500
    usd = _assert_studio_wallet_identity(user["id"])
    assert (usd["availableMinor"], usd["reservedMinor"]) == (1500, 2500), usd


def _campaign_submit_vs_sibling_approval(t) -> None:
    """P1-02: a submit racing a FULL approval (capture, then the Approved write) of a sibling
    request of the same owner. $40 in the wallet, the sibling holds $25, the new request asks
    $25: Available is $15 before and after the approval, so the submit is refused in every order.

    (a) The submit stops between its two money reads while the sibling's approval commits in
        full (the approval takes neither the owner's row nor the new request's row, so it never
        waits for the submit). The gate read the holds first (the sibling still Submitted), then
        the balance (the capture taken): refused. Balance first read $40, then no hold, and
        reserved $25 of $15.
    (b) Free races started by one Barrier.
    After each: the sibling is Approved with one capture, the new request stays a Draft, the
    wallet identity holds, Available is $15 and nothing is reserved.
    """
    from server.db import get_engine

    ad, studio = _studio_actors()
    engine = get_engine()

    def gate_read(statement: str) -> str:
        if "type = 'adCampaignRequests' AND deleted = false AND created_by = " in statement:
            return "holds"  # wallet_payments.wallet_campaign_holds_minor
        if "type = 'walletTransactions' AND deleted = false AND UPPER(COALESCE(" in statement:
            return "balance"  # main._wallet_balance_minor
        return ""

    def setup(tag):
        ad._reset_reviewer_limits(studio)
        user, cookies = ad._fresh_funded_customer(studio, f"pgsibling{tag}", 4000)
        sibling, draft = f"pg_sibling_held_{tag}", f"pg_sibling_next_{tag}"
        sibling_lm = _studio_sent(ad, cookies, sibling)
        created = ad._create_campaign(cookies, ad._complete_campaign(f"PG sibling next {tag}"), draft)
        assert created.status_code == 200, created.text
        return user, cookies, sibling, sibling_lm, draft, created.json()["lastModified"]

    def approve(sibling, last_modified, barrier=None):
        return _studio_post(t.app, f"/api/ad-studio/campaigns/{sibling}/review",
                            {"expectedLastModified": last_modified, "decision": "Approved", "note": "",
                             "operationId": f"{sibling}-approve"}, studio["reviewer"], barrier)

    def submit(cookies, draft, last_modified, barrier=None):
        return _studio_post(t.app, f"/api/ad-studio/campaigns/{draft}/submit",
                            {"expectedLastModified": last_modified, "operationId": f"{draft}-send"}, cookies, barrier)

    def assert_refused(user, sibling, draft, approval, submission):
        assert approval[0] == 200 and approval[1]["data"]["status"] == "Approved", (approval, submission)
        assert submission[0] == 409, (approval, submission)
        assert str(submission[1]["detail"]).startswith("Insufficient wallet balance"), submission
        assert (_studio_request(sibling)["status"], _studio_request(draft)["status"]) == ("Approved", "Draft")
        assert _studio_money(sibling)["campaign_payment"] == [2500] and _studio_money(draft)["campaign_payment"] == []
        usd = _assert_studio_wallet_identity(user["id"])
        assert (usd["availableMinor"], usd["reservedMinor"], usd["inAdsMinor"]) == (1500, 0, 2500), usd

    # (a) The approval commits in full between the submit's two money reads.
    user, cookies, sibling, sibling_lm, draft, draft_lm = setup("a")
    holder, reads, between, approved = [], [], Event(), Event()

    def submit_pauses(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _OWNER_ROW_LOCK, user["id"]) and not holder:
            holder.append(conn)  # the submit's transaction
        elif holder and conn is holder[0] and gate_read(statement):
            reads.append(gate_read(statement))
            if not between.is_set():
                between.set()
                assert approved.wait(30), "The sibling's approval never finished"

    with _with_hooks(engine, after=submit_pauses), ThreadPoolExecutor(max_workers=1) as pool:
        submitting = pool.submit(submit, cookies, draft, draft_lm)
        try:
            assert between.wait(30), "The submit never reached its money check"
            approval = approve(sibling, sibling_lm)
        finally:
            approved.set()
        submission = submitting.result(timeout=40)
    assert reads == ["holds", "balance"], reads
    assert_refused(user, sibling, draft, approval, submission)

    # (b) Free races: the approval always wins, the submit is always refused.
    for n in range(3):
        user, cookies, sibling, sibling_lm, draft, draft_lm = setup(f"free{n}")
        barrier = Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            approving = pool.submit(approve, sibling, sibling_lm, barrier)
            submitting = pool.submit(submit, cookies, draft, draft_lm, barrier)
            approval, submission = approving.result(timeout=40), submitting.result(timeout=40)
        assert_refused(user, sibling, draft, approval, submission)


def _campaign_withdraw_vs_approve(t) -> None:
    """P1-03: a withdraw racing an approval of one Submitted request: exactly one wins.

    Approval first (the withdraw waits until the approval answered): the withdraw gets 409
    REFUSE_WITHDRAW_APPROVED and the capture stays in the ad. Withdraw first (it holds the row
    until the approval's capture is queued on it): the capture finds a Draft and takes nothing.
    Then free races started by one Barrier. The wallet identity holds after every race.
    """
    from server.db import get_engine
    from server.systems.ads_studio.ad_campaign_actions import REFUSE_WITHDRAW_APPROVED

    ad, studio = _studio_actors()
    ad._reset_reviewer_limits(studio)
    user, cookies = ad._fresh_funded_customer(studio, "pgwva", 20_000)
    engine = get_engine()

    def race(cid, last_modified, *, before=None, after=None, approval_answered=None):
        barrier = Barrier(2)

        def approve():
            try:
                return _studio_post(t.app, f"/api/ad-studio/campaigns/{cid}/review",
                                    {"expectedLastModified": last_modified, "decision": "Approved", "note": "",
                                     "operationId": f"{cid}-approve"}, studio["reviewer"], barrier)
            finally:
                if approval_answered is not None:
                    approval_answered.set()

        with _with_hooks(engine, before=before, after=after), ThreadPoolExecutor(max_workers=2) as pool:
            approving = pool.submit(approve)
            withdrawing = pool.submit(_studio_post, t.app, f"/api/ad-studio/campaigns/{cid}/withdraw",
                                      {"expectedLastModified": last_modified, "operationId": f"{cid}-withdraw"},
                                      cookies, barrier)
            return approving.result(timeout=40), withdrawing.result(timeout=40)

    def assert_approval_won(cid, approval, withdrawal):
        assert approval[0] == 200 and approval[1]["data"]["status"] == "Approved", (approval, withdrawal)
        assert withdrawal[0] == 409 and withdrawal[1]["detail"] == REFUSE_WITHDRAW_APPROVED, (approval, withdrawal)
        money = _studio_money(cid)
        assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
        assert _studio_request(cid)["status"] == "Approved"

    def assert_withdraw_won(cid, approval, withdrawal):
        assert withdrawal[0] == 200 and withdrawal[1]["data"]["status"] == "Draft", (approval, withdrawal)
        assert approval[0] == 409, (approval, withdrawal)
        money = _studio_money(cid)
        # Nothing captured, or captured and returned in the withdraw's own transaction.
        assert money["campaign_payment"] == money["campaign_payment_release"] and len(money["campaign_payment"]) <= 1, money
        assert _studio_request(cid)["status"] == "Draft"

    # Order 1: the approval commits first; the withdraw is held before it locks the row.
    cid = "pg_wva_approve_first"
    last_modified = _studio_sent(ad, cookies, cid)
    answered = Event()

    def withdraw_waits(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _ACTION_ROW_LOCK, cid) and not answered.is_set():
            assert answered.wait(20), "The approval never answered"

    approval, withdrawal = race(cid, last_modified, before=withdraw_waits, approval_answered=answered)
    assert_approval_won(cid, approval, withdrawal)
    _assert_studio_wallet_identity(user["id"])

    # Order 2: the withdraw holds the row until the approval's capture is queued on it.
    cid = "pg_wva_withdraw_first"
    last_modified = _studio_sent(ad, cookies, cid)
    holder, capture_queued = [], Event()

    def capture_queues(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _CAPTURE_ROW_LOCK, cid):
            capture_queued.set()

    def withdraw_holds(conn, cursor, statement, parameters, context, executemany):
        if _row_lock(statement, parameters, _ACTION_ROW_LOCK, cid) and not holder:
            holder.append(conn)
            assert capture_queued.wait(20), "The approval's capture never queued on the row"

    approval, withdrawal = race(cid, last_modified, before=capture_queues, after=withdraw_holds)
    assert capture_queued.is_set()
    assert_withdraw_won(cid, approval, withdrawal)
    assert str(approval[1]["detail"]).startswith("Campaign is no longer awaiting review"), approval
    assert _studio_money(cid)["campaign_payment"] == []  # the capture saw the Draft: nothing taken
    _assert_studio_wallet_identity(user["id"])

    # Free races: whoever locks the row first wins; never both, never neither.
    for n in range(3):
        cid = f"pg_wva_free_{n}"
        last_modified = _studio_sent(ad, cookies, cid)
        approval, withdrawal = race(cid, last_modified)
        assert sorted([approval[0], withdrawal[0]]) == [200, 409], (approval, withdrawal)
        (assert_approval_won if approval[0] == 200 else assert_withdraw_won)(cid, approval, withdrawal)
        _assert_studio_wallet_identity(user["id"])


def _campaign_approval_self_release(t) -> None:
    """P1-03b: an approval that captured the budget and then lost its status write (409).

    (a) capture -> withdraw -> the approval's status write loses: one return in all (the
        withdraw's), the ledger equals the pre-submit state.
    (b) capture -> the request left the cycle with no return (a send-back whose release
        crashed) -> the approval's status write loses: the approval returns the capture itself.
    (c) two IDENTICAL approvals (same operationId): the one that loses the row adopts its
        twin's commit; the capture is never returned.
    (d) two different approvals: the loser answers 409; the winner's capture is never returned.
    The wallet identity holds after each.
    """
    from server.db import db_conn, get_engine, json_dumps, json_loads, now_ms

    ad, studio = _studio_actors()
    user, cookies = ad._fresh_funded_customer(studio, "pgselfrel", 20_000)
    engine = get_engine()

    def review_path(cid):
        return f"/api/ad-studio/campaigns/{cid}/review"

    def approval_body(cid, last_modified, op):
        return {"expectedLastModified": last_modified, "decision": "Approved", "note": "", "operationId": op}

    def paused_approval(cid, last_modified, meanwhile):
        """The approval stops right before its status write (its capture has committed);
        ``meanwhile()`` runs, then the approval goes on."""
        paused, resume = Event(), Event()

        def pause(conn, cursor, statement, parameters, context, executemany):
            if _row_lock(statement, parameters, _STATUS_WRITE_ROW_LOCK, cid) and not paused.is_set():
                paused.set()
                assert resume.wait(20), "The test never resumed the approval"

        with _with_hooks(engine, before=pause), ThreadPoolExecutor(max_workers=1) as pool:
            approving = pool.submit(_studio_post, t.app, review_path(cid),
                                    approval_body(cid, last_modified, f"{cid}-approve"), studio["reviewer"])
            try:
                assert paused.wait(30), "The approval never reached its status write"
                outcome = meanwhile()
            finally:
                resume.set()
            return outcome, approving.result(timeout=40)

    def twin_approvals(cid, last_modified, ops):
        """Two approvals at once; the first to reach its status write waits until the other
        one holds the row, so it provably loses the row race."""
        holder, twin_locked, barrier = [], Event(), Barrier(2)

        def loser_waits(conn, cursor, statement, parameters, context, executemany):
            if _row_lock(statement, parameters, _STATUS_WRITE_ROW_LOCK, cid) and not holder:
                holder.append(conn)
                assert twin_locked.wait(20), "The other approval never locked the row"

        def winner_locked(conn, cursor, statement, parameters, context, executemany):
            if _row_lock(statement, parameters, _STATUS_WRITE_ROW_LOCK, cid) and holder and conn is not holder[0]:
                twin_locked.set()

        with _with_hooks(engine, before=loser_waits, after=winner_locked), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(_studio_post, t.app, review_path(cid), approval_body(cid, last_modified, op),
                                   studio["reviewer"], barrier) for op in ops]
            results = [future.result(timeout=40) for future in futures]
        assert twin_locked.is_set(), results
        return results

    # (a) capture -> withdraw -> approval 409.
    ad._reset_reviewer_limits(studio)
    cid = "pg_selfrel_withdrawn"
    before = _studio_balance(user["id"])  # a submit writes no ledger row: the pre-submit state
    last_modified = _studio_sent(ad, cookies, cid)

    def withdraw_now():
        captured = _studio_money(cid)["campaign_payment"]
        return captured, _studio_post(t.app, f"/api/ad-studio/campaigns/{cid}/withdraw",
                                      {"expectedLastModified": last_modified, "operationId": f"{cid}-withdraw"}, cookies)

    (captured, withdrawal), approval = paused_approval(cid, last_modified, withdraw_now)
    assert captured == [2500], captured  # the capture had committed before the withdraw ran
    assert withdrawal[0] == 200 and withdrawal[1]["data"]["status"] == "Draft", withdrawal
    assert approval[0] == 409, approval
    money = _studio_money(cid)
    assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [2500], money
    assert _studio_balance(user["id"]) == before and _studio_request(cid)["status"] == "Draft"
    usd = _assert_studio_wallet_identity(user["id"])
    assert usd["beingReturnedMinor"] == 0 and usd["inAdsMinor"] == 0 and usd["availableMinor"] == before, usd

    # (b) capture -> left the cycle with no return -> the approval returns its own capture.
    cid = "pg_selfrel_sent_back"
    last_modified = _studio_sent(ad, cookies, cid)

    def sent_back_without_release():
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = 'adCampaignRequests' AND id = :id"),
                               {"id": cid}).mappings().one()
            data = {**(json_loads(row["data_json"]) or {}), "status": "Changes Requested", "reviewDecision": "Changes Requested"}
            modified = max(now_ms(), int(row["last_modified"]) + 1)
            data["_lastModified"] = modified
            conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = 'adCampaignRequests' AND id = :id"),
                         {"d": json_dumps(data), "m": modified, "id": cid})

    _, approval = paused_approval(cid, last_modified, sent_back_without_release)
    assert approval[0] == 409, approval
    money = _studio_money(cid)
    assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [2500], money
    assert _studio_balance(user["id"]) == before
    with db_conn() as conn:
        released = conn.execute(text("SELECT count(*) FROM audit_logs WHERE action = 'wallet_release' AND resource_id = :id"),
                                {"id": cid}).scalar_one()
    assert released == 1, released
    usd = _assert_studio_wallet_identity(user["id"])
    assert usd["beingReturnedMinor"] == 0 and usd["availableMinor"] == before, usd

    # (c) identical approvals: the loser adopts its twin's commit; nothing is returned.
    ad._reset_reviewer_limits(studio)
    cid = "pg_selfrel_identical"
    last_modified = _studio_sent(ad, cookies, cid)
    results = twin_approvals(cid, last_modified, [f"{cid}-approve"] * 2)
    assert [status for status, _ in results] == [200, 200], results
    assert results[0][1]["lastModified"] == results[1][1]["lastModified"], results
    money = _studio_money(cid)
    assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
    assert _studio_request(cid)["status"] == "Approved"
    usd = _assert_studio_wallet_identity(user["id"])
    assert usd["inAdsMinor"] == 2500 and usd["beingReturnedMinor"] == 0, usd

    # (d) different approvals: one wins; the loser answers 409 and returns nothing.
    cid = "pg_selfrel_other"
    last_modified = _studio_sent(ad, cookies, cid)
    results = twin_approvals(cid, last_modified, [f"{cid}-approve-a", f"{cid}-approve-b"])
    assert sorted(status for status, _ in results) == [200, 409], results
    money = _studio_money(cid)
    assert money["campaign_payment"] == [2500] and money["campaign_payment_release"] == [], money
    assert _studio_request(cid)["status"] == "Approved"
    usd = _assert_studio_wallet_identity(user["id"])
    assert usd["inAdsMinor"] == 5000 and usd["beingReturnedMinor"] == 0, usd


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--scenario":
        raise SystemExit("Run this module through pytest, not directly")
    _run_scenario(sys.argv[2])
