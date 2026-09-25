"""Opt-in real PostgreSQL proofs for the Albayan Studio jobs loop (plan tasks P1-19, P1-21).

Run: ALBAYAN_TEST_POSTGRES_URL=<loopback test DB URL> python -m pytest
     server/test_postgres_studio_jobs.py -q

The same guard and isolation as test_postgres_financial_review.py (its URL checks, child
environment and throwaway-schema fixture are reused, not copied): never DATABASE_URL, only an
explicit loopback PostgreSQL whose database is albayan_test[_...] / test_albayan[_...]; each
scenario runs the application in a child process inside its own random schema, dropped afterwards.

* ``campaign_orphan_sweep``: two sweeps racing over one orphan capture; the sweep against an
  archive (each holds the campaign row first, in turn); the sweep against a send-back's own return
  (each takes the ``rel:`` key first, in turn); two checks racing over an interrupted approval (one
  alert, the capture never returned, the approval then reuses it); the 5-minute check's read served by
  its startup index; two ticks racing for the same claims; the daily money check on one PostgreSQL
  snapshot. Every race finishes inside the 5 s lock_timeout (no deadlock: PLAN.md §7.8 lock table),
  exactly one return per payment cycle, and the wallet identity holds after each.
* ``studio_system_alert_insert``: a system alert with ``created_by`` NULL is stored; the same row with
  ``created_by = 'system'`` breaks the users.id foreign key (why the rule exists, PLAN.md §7.1); a
  made-up owner is stored as NULL; two processes raising the same alert at once make one row.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event
from typing import Any, Callable

import pytest
from sqlalchemy import text

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))  # the child process runs this file as a script: `server` must import

from server.test_postgres_financial_review import (  # noqa: E402, F401  (postgres_scenario_target is a fixture)
    SCHEMA_RE,
    _child_environment,
    _guarded_url,
    postgres_scenario_target,
)

SCENARIOS = ("campaign_orphan_sweep", "studio_system_alert_insert")


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_postgres_studio_jobs(postgres_scenario_target, scenario):
    url, schema = postgres_scenario_target
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--scenario", scenario],
        cwd=ROOT, env=_child_environment(url, schema),
        capture_output=True, text=True, timeout=180,
    )
    output = result.stdout + result.stderr
    for secret in (url.render_as_string(hide_password=False), url.password):
        if secret:
            output = output.replace(secret, "[redacted]")
    assert result.returncode == 0, output
    assert f"PASS postgresql {scenario}" in result.stdout, output


# ------------------------------------------------------------------ child-process helpers

def _wait_until_blocked(engine: Any, seconds: float = 4.0) -> bool:
    """True once another session of this database waits for a lock (the second operation is queued)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        with engine.connect() as conn:
            waiting = conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()"
            )).scalar()
        if waiting:
            return True
        time.sleep(0.05)
    return False


def _in_order(match: Callable[[str, Any], bool], first: Callable[[], Any], second: Callable[[], Any]) -> tuple[Any, Any]:
    """Run ``first`` and ``second`` at once, ``first`` taking the lock that ``match`` names first.

    ``first``'s matching statement keeps its lock until ``second``'s matching statement is really
    waiting for it inside PostgreSQL; then both finish. Returns their results.
    """
    from sqlalchemy import event
    from server.db import get_engine

    engine = get_engine()
    held, attempted = Event(), Event()
    holder: list[Any] = []
    blocked: list[bool] = []

    def before(conn, cursor, statement, parameters, context, executemany):
        if holder and conn is not holder[0] and match(statement, parameters):
            attempted.set()

    def after(conn, cursor, statement, parameters, context, executemany):
        if not holder and match(statement, parameters):
            holder.append(conn)
            held.set()
            assert attempted.wait(10), "the second operation never reached the lock"
            blocked.append(_wait_until_blocked(engine))

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            one = pool.submit(first)
            assert held.wait(10), "the first operation never took the lock"
            two = pool.submit(second)
            results = (one.result(timeout=40), two.result(timeout=40))
    finally:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
    assert blocked == [True], "the second operation never waited for the first one's lock"
    return results


def _together(*actions: Callable[[], Any]) -> list[Any]:
    barrier = Barrier(len(actions))

    def run(action):
        barrier.wait(timeout=10)
        return action()

    with ThreadPoolExecutor(max_workers=len(actions)) as pool:
        futures = [pool.submit(run, action) for action in actions]
        return [future.result(timeout=40) for future in futures]


def _row_lock_of(campaign_id: str) -> Callable[[str, Any], bool]:
    def match(statement, parameters):
        return "FOR UPDATE" in statement and isinstance(parameters, dict) and parameters.get("id") == campaign_id
    return match


def _advisory_lock_of(key: str) -> Callable[[str, Any], bool]:
    def match(statement, parameters):
        return "pg_advisory_xact_lock" in statement and isinstance(parameters, dict) and parameters.get("key") == f"wallet:{key}"
    return match


def _campaign_orphan_sweep(j, staff) -> None:
    from fastapi.testclient import TestClient
    from server.db import db_conn
    from server.main import app
    from server.systems.ads_studio import studio_integrity, studio_jobs
    from server.wallet_payments import _campaign_payment_key, release_orphan_campaign_payment

    ctx = studio_jobs.resolve_jobs_ctx({})
    assert ctx["is_postgres"]()
    with db_conn() as conn:
        assert studio_integrity.scan_studio_money(conn, j._now()) == []  # a clean database reports nothing

    # 1. Two sweeps racing over the same orphan: exactly one return.
    user, orphan = j._orphan(staff, "pg-two-sweeps")
    swept = _together(lambda: studio_jobs.sweep_orphans(ctx, j._now()), lambda: studio_jobs.sweep_orphans(ctx, j._now(), full=True))
    assert sum(orphan in result["released"] for result in swept) == 1, swept
    assert len(j._keys(user["id"], "rel:")) == 1
    assert j._identity_holds(user["id"])["availableMinor"] == 5_000

    # 2. The sweep against an archive: both lock the campaign row first; each order in turn.
    for first in ("sweep", "archive"):
        user, orphan = j._orphan(staff, f"pg-archive-{first}")

        def sweep(orphan=orphan):
            return studio_jobs.release_left_cycle_capture(ctx, orphan)

        def archive(user=user, orphan=orphan):
            client = TestClient(app, headers={"Origin": "http://testserver"})
            try:
                return client.delete(f"/api/collections/{j.CAMPAIGNS}/{orphan}", cookies=user["cookies"]).status_code
            finally:
                client.close()

        order = (sweep, archive) if first == "sweep" else (archive, sweep)
        results = _in_order(_row_lock_of(orphan), *order)
        swept_tx, archived = results if first == "sweep" else results[::-1]
        assert archived == 200 and (bool(swept_tx) is (first == "sweep")), (first, results)
        assert len(j._keys(user["id"], "rel:")) == 1, first
        assert j._identity_holds(user["id"])["availableMinor"] == 5_000

    # 3. The sweep against a send-back's own return (the review's second transaction takes only the
    #    rel: key, after its status write committed): each takes the key first, in turn.
    for first in ("sweep", "send_back"):
        user = j._customer(f"pg-sendback-{first}")
        j._credit(staff, user["id"], 5_000)
        campaign_id = j._create(user, 2_000)
        assert j._submit(user, campaign_id).status_code == 200
        j._crash_capture(staff, campaign_id)
        with db_conn() as conn:
            j._force(campaign_id, conn, status="Changes Requested")  # the send-back's status write committed
        campaign = j._campaign_data(campaign_id)
        rel_key = f"rel:{_campaign_payment_key(campaign)}"

        def sweep(campaign_id=campaign_id):
            return studio_jobs.release_left_cycle_capture(ctx, campaign_id)

        def send_back_return(campaign=campaign):
            with db_conn() as conn:
                return release_orphan_campaign_payment(conn, ctx, campaign, staff["reviewer"]["id"])

        order = (sweep, send_back_return) if first == "sweep" else (send_back_return, sweep)
        results = _in_order(_advisory_lock_of(rel_key), *order)
        swept_tx, returned_tx = results if first == "sweep" else results[::-1]
        assert returned_tx and (bool(swept_tx) is (first == "sweep")), (first, results)
        assert j._keys(user["id"], "rel:") == [rel_key], first
        assert j._identity_holds(user["id"])["availableMinor"] == 5_000

    # 4. An interrupted approval: two checks at once raise ONE alert; the capture is never returned;
    #    the approval then reuses it.
    user = j._customer("pg-interrupted")
    j._credit(staff, user["id"], 5_000)
    interrupted = j._create(user, 2_000)
    assert j._submit(user, interrupted).status_code == 200
    j._crash_capture(staff, interrupted)
    later = j._now(16)
    checks = _together(lambda: studio_jobs.check_waiting_requests(later), lambda: studio_jobs.check_waiting_requests(later))
    assert all(interrupted in check["approvalInterrupted"] for check in checks)
    with db_conn() as conn:
        alerts = conn.execute(text("SELECT created_by FROM entities WHERE type = :t AND id = :id"), {
            "t": studio_jobs.ALERTS_TYPE, "id": studio_jobs.alert_id("approval_interrupted", interrupted, j._day(later)),
        }).scalars().all()
    assert alerts == [user["id"]]
    assert interrupted not in studio_jobs.sweep_orphans(ctx, later, full=True)["released"]
    assert j._keys(user["id"], "rel:") == []
    daily = studio_jobs.run_daily_money_check(j._provider, j._now(20))  # one snapshot (REPEATABLE READ READ ONLY)
    assert [item["code"] for item in daily["violations"]] == ["capture_without_approval"], daily["violations"]
    assert daily["violations"][0]["requestIds"] == [interrupted] and daily["alertId"]
    assert j._review(staff, interrupted, "Approved").status_code == 200
    usd = j._identity_holds(user["id"])
    assert (usd["inAdsMinor"], usd["availableMinor"]) == (2_000, 3_000)
    with db_conn() as conn:
        assert studio_integrity.scan_studio_money(conn, j._now(20)) == []  # everything above is consistent

    # 4b. The 5-minute check reads only the Submitted rows through the startup index (add_jsonb_indexes.py).
    import contextlib
    import io

    from server.add_jsonb_indexes import add_jsonb_indexes

    with contextlib.redirect_stdout(io.StringIO()):
        add_jsonb_indexes()
    with db_conn() as conn:
        conn.execute(text("ANALYZE entities"))
        conn.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(conn.execute(text("EXPLAIN " + studio_jobs.waiting_requests_sql())).scalars())
    assert "idx_ad_campaign_requests_status" in plan, plan

    # 5. Two ticks at the same moment claim each due job once (the version-checked state row).
    runs: list[str] = []
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: runs.append("sweep") or {})
        patch.setattr(studio_jobs, "check_waiting_requests", lambda now: runs.append("waiting") or {})
        patch.setattr(studio_jobs, "run_daily_money_check", lambda ctx, now: runs.append("daily") or {})
        j._reset_state()
        night = j._night(days=2)
        first_round = _together(lambda: studio_jobs.run_tick(j._provider, night), lambda: studio_jobs.run_tick(j._provider, night))
        assert sorted(tuple(tick["claimed"]) for tick in first_round) == [(), ("sweep", "waiting")], first_round
        again = night + studio_jobs.SWEEP_EVERY
        second_round = _together(lambda: studio_jobs.run_tick(j._provider, again), lambda: studio_jobs.run_tick(j._provider, again))
        assert sorted(tuple(tick["claimed"]) for tick in second_round) == [(), ("sweep",)], second_round
    assert sorted(runs) == ["sweep", "sweep", "waiting"]
    state = studio_jobs.read_job_state()
    assert state["lastTickAt"] == studio_jobs._iso(again)


def _studio_system_alert_insert(j, staff) -> None:
    from sqlalchemy.exc import IntegrityError
    from server.db import db_conn, json_dumps, now_ms
    from server.systems.ads_studio import studio_jobs

    now = j._now()
    with db_conn() as conn:
        alert, inserted = studio_jobs.raise_alert(conn, "integrity_violation", related_type=studio_jobs.JOB_STATE_TYPE,
                                                  related_id="pg-system-alert", details={"violations": []}, now=now)
    assert inserted

    def created_by(row_id: str, kind: str = studio_jobs.ALERTS_TYPE):
        with db_conn() as conn:
            return conn.execute(text("SELECT created_by FROM entities WHERE type = :t AND id = :id"),
                                {"t": kind, "id": row_id}).one()[0]

    assert created_by(alert["id"]) is None  # a system alert: NULL passes the users.id foreign key

    stamp = now_ms()
    try:
        with db_conn() as conn:
            conn.execute(text(
                "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                "VALUES (:type, :id, :data, false, :stamp, 'system', :stamp)"
            ), {"type": studio_jobs.ALERTS_TYPE, "id": "sal_pg_fk_probe", "data": json_dumps({"kind": "integrity_violation"}),
                "stamp": stamp})
    except IntegrityError as error:
        assert getattr(error.orig, "sqlstate", "") == "23503", error  # foreign_key_violation
    else:
        raise AssertionError("created_by = 'system' was accepted; the users.id foreign key is missing")

    user = j._customer("pg-alert-owner")
    with db_conn() as conn:
        mine, _ = studio_jobs.raise_alert(conn, "review_overdue", related_type=j.CAMPAIGNS, related_id="pg-owned",
                                          owner_id=user["id"], now=now)
        made_up, _ = studio_jobs.raise_alert(conn, "review_overdue", related_type=j.CAMPAIGNS, related_id="pg-made-up",
                                             owner_id="system", now=now)
    assert created_by(mine["id"]) == user["id"] and created_by(made_up["id"]) is None and made_up["ownerId"] is None

    def raise_same():
        with db_conn() as conn:
            return studio_jobs.raise_alert(conn, "integrity_violation", related_type=studio_jobs.JOB_STATE_TYPE,
                                           related_id="pg-same-alert", count=3, details={"violations": []}, now=now)

    raced = _together(raise_same, raise_same)
    assert sorted(inserted for _alert, inserted in raced) == [False, True]
    with db_conn() as conn:
        rows = conn.execute(text("SELECT count(*) FROM entities WHERE type = :t AND id = :id"), {
            "t": studio_jobs.ALERTS_TYPE, "id": studio_jobs.alert_id("integrity_violation", "pg-same-alert", j._day(now)),
        }).scalar()
    assert rows == 1

    j._reset_state()
    assert studio_jobs.update_job_state(lambda state: {"lastTickAt": studio_jobs._iso(now)})
    assert created_by(studio_jobs.JOB_STATE_ID, studio_jobs.JOB_STATE_TYPE) is None  # the state row is a system row


def _run_scenario(scenario: str) -> None:
    if scenario not in SCENARIOS:
        raise ValueError("Unknown PostgreSQL studio jobs scenario")
    url = _guarded_url(os.environ.get("ALBAYAN_TEST_POSTGRES_URL", ""))
    schema = os.environ.get("PG_FINANCIAL_TEST_SCHEMA", "")
    if not SCHEMA_RE.fullmatch(schema):
        raise ValueError("A generated, isolated test schema is required")
    scoped_url = url.update_query_dict({
        "options": f"-csearch_path={schema} -cstatement_timeout=15000 -clock_timeout=5000",
        "connect_timeout": "10",
        "hostaddr": str(url.host),
    })
    # Set before importing any application module, and never start the app lifespan: no
    # background workers (the studio jobs loop included), scheduled backups or startup repairs.
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
        import server.main as main_module
        from server import test_studio_jobs as j
        from server import wallet_payments
        staff = j.staff.__wrapped__()
        try:
            assert get_engine() is engine, "Imported fixtures redirected the PostgreSQL engine"
            with pytest.MonkeyPatch.context() as patch:  # many money steps in a few seconds: not a rate-limit test
                patch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
                patch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)
                if scenario == "campaign_orphan_sweep":
                    _campaign_orphan_sweep(j, staff)
                else:
                    _studio_system_alert_insert(j, staff)
            assert get_engine() is engine, "The studio scenario changed its database target"
        finally:
            j.client.close()
        print(f"PASS postgresql {scenario}")
    finally:
        engine.dispose()


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--scenario":
        raise SystemExit("Run this module through pytest, not directly")
    _run_scenario(sys.argv[2])
