"""Albayan Studio jobs loop (plan task P1-21; PLAN.md §7.4, §7.8 lock table, §7.1 studioAlerts/studioJobState).

The loop never runs under pytest; these tests call its job functions and its tick directly with a
fixed clock. Money states come from the real routes, plus the crash states test_studio_wallet.py
builds (a capture whose approval died before its status write; a send-back whose return died).
"""

import json
import os
import threading
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.main as main_module
from server import meta_ads, wallet_payments
from server.db import db_conn, init_db, json_loads, now_ms
from server.rate_limiter import reset_rate_limit
from server.systems.ads_studio import social_studio, studio_integrity, studio_jobs
from server.systems.ads_studio.studio_jobs import (
    ALERTS_TYPE,
    JOB_STATE_ID,
    JOB_STATE_TYPE,
    alert_id,
    check_waiting_requests,
    jobs_heartbeat,
    raise_alert,
    release_left_cycle_capture,
    resolve_jobs_ctx,
    review_due_at,
    run_daily_money_check,
    run_tick,
    sweep_orphans,
)
from server.systems.ads_studio.studio_settings import DEFAULTS
from server.systems.ads_studio.studio_wallet import wallet_summary
from server.test_studio_wallet import (
    _campaign_data,
    _crash_capture,
    _create,
    _credit,
    _customer,
    _force,
    _insert_user,
    _review,
    _stop,
    _submit,
    _uid,
    CAMPAIGNS,
    client,
)
from server.wallet_payments import _campaign_payment_key, wallet_ledger_rows

UTC = timezone.utc


@pytest.fixture(scope="module")
def staff():
    init_db()
    return {
        "admin": _insert_user("jobs-admin", "Admin", {}),
        "reviewer": _insert_user("jobs-reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
    }


@pytest.fixture(autouse=True)
def _no_rate_limits(monkeypatch):
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_enforce_ad_campaign_mutation_rate", lambda user: None)


# ------------------------------------------------------------------ helpers (the PostgreSQL scenarios use them too)

def _now(minutes: float = 0) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


def _night(days: int = 1, hour: int = 0, minute: int = 30) -> datetime:
    """A fixed UTC time on a coming day; 00:30 UTC is 02:30 in Tripoli, before the 04:00 daily check."""
    today = datetime.now(UTC).date() + timedelta(days=days)
    return datetime(today.year, today.month, today.day, hour, minute, tzinfo=UTC)


def _provider():
    return resolve_jobs_ctx({})


def _reset_state() -> None:
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": JOB_STATE_TYPE, "id": JOB_STATE_ID})


def _ledger(user_id: str) -> list[dict]:
    with db_conn() as conn:
        return sorted(wallet_ledger_rows(conn, user_id), key=lambda row: row["id"])


def _keys(user_id: str, prefix: str) -> list[str]:
    return sorted(row["idempotencyKey"] for row in _ledger(user_id) if row["idempotencyKey"].startswith(prefix))


def _orphan(staff, label: str = "orphan", budget: int = 2_000) -> tuple[dict, str]:
    """A request sent back after a capture whose return never happened ("Being returned")."""
    user = _customer(label)
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, budget)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, status="Changes Requested")
    return user, campaign_id


def _alert(row_id: str) -> tuple[dict | None, str | None]:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                           {"t": ALERTS_TYPE, "id": row_id}).mappings().first()
    return (json_loads(row["data_json"]), row["created_by"]) if row else (None, None)


def _day(moment: datetime) -> str:
    return studio_jobs.libya_today(moment).isoformat()


def _identity_holds(user_id: str) -> dict:
    with db_conn() as conn:
        usd = wallet_summary(conn, user_id, _now())["usd"]
        server_available = main_module._wallet_available_after_holds(conn, user_id, "USD")
    left = usd["addedMinor"] + usd["adjustmentsMinor"] - usd["inAdsMinor"] - usd["beingReturnedMinor"] - usd["spentMinor"]
    assert left == usd["availableMinor"] + usd["reservedMinor"] and usd["availableMinor"] == server_available, usd
    return usd


# ------------------------------------------------------------------ the orphan sweep

def test_sweep_runs_without_meta_token(staff, monkeypatch):
    def no_meta(*_args, **_kwargs):
        raise AssertionError("the studio jobs must never touch Meta")

    user, campaign_id = _orphan(staff, "nometa")
    assert _identity_holds(user["id"])["beingReturnedMinor"] == 2_000
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", no_meta)
    monkeypatch.setattr(meta_ads, "MetaAdsClient", no_meta)
    _reset_state()
    ran = run_tick(_provider, _night())
    assert ran["claimed"] == ["sweep", "waiting"] and campaign_id in ran["sweep"]["released"]
    assert "error" not in ran["waiting"]
    usd = _identity_holds(user["id"])
    assert usd["beingReturnedMinor"] == 0 and usd["availableMinor"] == 5_000
    (rel_key,) = _keys(user["id"], "rel:")
    assert rel_key == f"rel:{_campaign_payment_key(_campaign_data(campaign_id))}"
    with db_conn() as conn:
        created_by = conn.execute(text(
            "SELECT e.created_by FROM entities e WHERE e.type = 'walletTransactions' AND e.id = :id"
        ), {"id": next(r["id"] for r in _ledger(user["id"]) if r["idempotencyKey"] == rel_key)}).scalar()
        audit = conn.execute(text(
            "SELECT user_id, metadata_json FROM audit_logs WHERE action = 'wallet_release' AND resource_id = :id"
        ), {"id": campaign_id}).mappings().all()
    assert created_by is None  # a system row: no made-up user id
    assert len(audit) == 1 and audit[0]["user_id"] is None
    assert json.loads(audit[0]["metadata_json"])["source"] == "studio_jobs_sweep"


def test_orphan_sweep_idempotent(staff):
    user, orphan = _orphan(staff, "idem")
    approved = _create(user, 1_500)
    assert _submit(user, approved).status_code == 200
    assert _review(staff, approved, "Approved").status_code == 200
    stopped = _create(user, 1_200)
    assert _submit(user, stopped).status_code == 200
    assert _review(staff, stopped, "Approved").status_code == 200
    assert _stop(staff["reviewer"]["cookies"], stopped, refund=0).status_code == 200
    ctx = _provider()
    first = sweep_orphans(ctx, _now())
    assert orphan in first["released"] and approved not in first["released"] and stopped not in first["released"]
    for again in (sweep_orphans(ctx, _now()), sweep_orphans(ctx, _now(), full=True)):
        assert orphan not in again["released"]
    assert len(_keys(user["id"], "rel:")) == 1 and _keys(user["id"], "stoprefund:") == []
    assert release_left_cycle_capture(ctx, orphan) == "" and release_left_cycle_capture(ctx, approved) == ""
    usd = _identity_holds(user["id"])
    assert (usd["inAdsMinor"], usd["spentMinor"], usd["beingReturnedMinor"]) == (1_500, 1_200, 0)


def test_withdrawn_and_archived_requests_are_swept(staff):
    user = _customer("left")
    _credit(staff, user["id"], 9_000)
    withdrawn, archived, rejected = (_create(user, 1_500) for _ in range(3))
    for campaign_id in (withdrawn, archived, rejected):
        assert _submit(user, campaign_id).status_code == 200
        _crash_capture(staff, campaign_id)
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(withdrawn, conn, status="Draft", withdrawnAt=_now().isoformat())  # keeps submittedAt (P1-03)
        _force(rejected, conn, status="Rejected")
        conn.execute(text("UPDATE entities SET deleted = true, last_modified = :m WHERE type = :t AND id = :id"),
                     {"m": now_ms() + 5, "t": CAMPAIGNS, "id": archived})  # archived while waiting
    released = sweep_orphans(_provider(), _now())["released"]
    assert {withdrawn, archived, rejected} <= set(released)
    assert len(_keys(user["id"], "rel:")) == 3 and _identity_holds(user["id"])["availableMinor"] == 9_000


def test_incremental_sweep_looks_back_48_hours_and_the_daily_one_everywhere(staff):
    user, campaign_id = _orphan(staff, "old")
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET last_modified = :m WHERE type = :t AND id = :id"),
                     {"m": now_ms() - 3 * 24 * 3600 * 1000, "t": CAMPAIGNS, "id": campaign_id})
    ctx = _provider()
    assert campaign_id not in sweep_orphans(ctx, _now())["released"]
    assert campaign_id in sweep_orphans(ctx, _now(), full=True)["released"]
    assert _identity_holds(user["id"])["beingReturnedMinor"] == 0


def test_sweep_takes_the_lock_table_order(staff):
    _user, campaign_id = _orphan(staff, "locks")
    order: list[str] = []

    class Recording:
        def __init__(self, name, lock):
            self.name, self.lock = name, lock

        def __enter__(self):
            self.lock.acquire()
            order.append(self.name)
            return self

        def __exit__(self, *exc):
            self.lock.release()

    ctx = dict(_provider())
    real_lock_key = ctx["lock_idempotency_key"]
    ctx["sqlite_patch_lock"] = lambda: Recording("campaign row", main_module._SQLITE_ENTITY_PATCH_LOCK)
    ctx["sqlite_wallet_lock"] = lambda: Recording("wallet", main_module._SQLITE_WALLET_LOCK)

    def lock_key(conn, key, **kwargs):
        order.append(key.split(":", 1)[0] + ":")
        return real_lock_key(conn, key, **kwargs)

    ctx["lock_idempotency_key"] = lock_key
    assert release_left_cycle_capture(ctx, campaign_id)
    # PLAN.md §7.8 lock table, "Orphan sweep": campaign row -> rel: key (SQLite: entity-patch lock -> wallet lock).
    assert order[:3] == ["campaign row", "wallet", "rel:"] and set(order[3:]) <= {"rel:"}


def test_jobs_ctx_comes_from_the_router_ctx(monkeypatch):
    assert set(studio_jobs.WALLET_CTX_KEYS) <= set(_provider())
    monkeypatch.setattr(social_studio, "_CTX", {})
    with pytest.raises(RuntimeError, match="lock_idempotency_key"):
        resolve_jobs_ctx({"audit": lambda *a, **k: None})
    whole = {key: object() for key in studio_jobs.WALLET_CTX_KEYS}
    assert resolve_jobs_ctx(whole) == whole  # the studio router's own ctx is enough when it carries them


# ------------------------------------------------------------------ interrupted approvals and overdue reviews

def test_stale_capture_raises_an_alert_and_is_never_released(staff):
    user = _customer("stale")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    before = _ledger(user["id"])
    assert campaign_id not in check_waiting_requests(_now(10))["approvalInterrupted"]  # may still be writing
    later = _now(16)
    assert campaign_id in check_waiting_requests(later)["approvalInterrupted"]
    assert campaign_id in check_waiting_requests(later)["approvalInterrupted"]  # seen again: still one alert
    data, created_by = _alert(alert_id("approval_interrupted", campaign_id, _day(later)))
    assert created_by == user["id"] and data["ownerId"] == user["id"] and data["count"] == 1
    assert data["details"]["campaignId"] == campaign_id and data["details"]["paidMinorUSD"] == 2_000
    assert data["customerVisible"] is False and data["acknowledgedAt"] is None
    with db_conn() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM entities WHERE type = :t AND id = :id"),
                             {"t": ALERTS_TYPE, "id": alert_id("approval_interrupted", campaign_id, _day(later))}).scalar()
    assert count == 1
    assert campaign_id not in sweep_orphans(_provider(), later, full=True)["released"]  # NEVER returned
    assert _ledger(user["id"]) == before
    assert _review(staff, campaign_id, "Approved").status_code == 200  # the approval reuses that capture
    assert len([r for r in _ledger(user["id"]) if r["type"] == "campaign_payment"]) == 1
    usd = _identity_holds(user["id"])
    assert (usd["inAdsMinor"], usd["availableMinor"], usd["reservedMinor"]) == (2_000, 3_000, 0)


def test_review_due_at_counts_working_days():
    hours = DEFAULTS["hours"]
    sunday = datetime(2027, 1, 3, 8, 0, tzinfo=UTC)  # 10:00 in Tripoli
    assert review_due_at(sunday.isoformat(), 1, hours) == datetime(2027, 1, 4, 15, 0, tzinfo=UTC)  # Mon 17:00
    assert review_due_at(sunday.isoformat(), 2, hours) == datetime(2027, 1, 5, 15, 0, tzinfo=UTC)
    thursday = "2027-01-07T14:00:00Z"  # 16:00 Thursday: Friday and Saturday are closed
    assert review_due_at(thursday, 1, hours) == datetime(2027, 1, 10, 15, 0, tzinfo=UTC)
    assert review_due_at("2027-01-08T10:00:00Z", 1, hours) == datetime(2027, 1, 10, 15, 0, tzinfo=UTC)  # a Friday
    holiday = {**hours, "holidays": [{"date": "2027-01-04", "labelEn": "", "labelAr": ""}]}
    assert review_due_at(sunday.isoformat(), 1, holiday) == datetime(2027, 1, 5, 15, 0, tzinfo=UTC)
    ramadan = {**hours, "ramadan": {"from": "2027-01-01", "to": "2027-01-20", "open": "10:00", "close": "15:00"}}
    assert review_due_at(sunday.isoformat(), 1, ramadan) == datetime(2027, 1, 4, 13, 0, tzinfo=UTC)
    assert review_due_at("not a time", 1, hours) is None
    assert review_due_at(sunday.isoformat(), 1, {"week": {}, "holidays": []}) is None  # never open: never due


def test_review_overdue_alert(staff):
    user = _customer("overdue")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000)
    assert _submit(user, campaign_id).status_code == 200
    with main_module._SQLITE_ENTITY_PATCH_LOCK, db_conn() as conn:
        _force(campaign_id, conn, submittedAt="2027-01-03T08:00:00Z")  # Sunday 10:00 Tripoli: due Monday 17:00
    assert campaign_id not in check_waiting_requests(datetime(2027, 1, 4, 14, 59, tzinfo=UTC))["reviewOverdue"]
    late = datetime(2027, 1, 4, 15, 1, tzinfo=UTC)
    assert campaign_id in check_waiting_requests(late)["reviewOverdue"]
    data, created_by = _alert(alert_id("review_overdue", campaign_id, "2027-01-04"))
    assert created_by == user["id"] and data["kind"] == "review_overdue"
    assert data["details"] == {"campaignId": campaign_id, "submittedAt": "2027-01-03T08:00:00Z", "dueAt": "2027-01-04T15:00:00Z"}


# ------------------------------------------------------------------ the daily money check

def test_daily_scan_raises_alert(staff, monkeypatch):
    monkeypatch.setattr(studio_integrity, "MAX_IDS", 100_000)  # the whole shared test database is scanned
    user = _customer("daily")
    _credit(staff, user["id"], 5_000)
    campaign_id = _create(user, 2_000)
    assert _submit(user, campaign_id).status_code == 200
    _crash_capture(staff, campaign_id)
    before = _ledger(user["id"])
    later = _now(20)
    result = run_daily_money_check(_provider, later)
    found = {item["code"]: item for item in result["violations"]}
    assert campaign_id in found["capture_without_approval"]["requestIds"]
    assert result["alertId"] == alert_id("integrity_violation", "scan_studio_money", _day(later))
    data, created_by = _alert(result["alertId"])
    assert created_by is None and data["ownerId"] is None  # a system alert
    assert data["kind"] == "integrity_violation" and data["count"] == result["counts"]["total"]
    assert data["details"]["violations"] == result["violations"]
    assert _ledger(user["id"]) == before  # the scan never repairs, the sweep never returns an approving capture
    heartbeat = jobs_heartbeat(later)
    assert heartbeat["lastIntegrityResult"] == result["counts"] and heartbeat["lastIntegrityScanAt"]
    assert campaign_id not in json.dumps(heartbeat)  # counts only outside the admin alert


def test_daily_scan_without_findings_raises_no_alert(monkeypatch):
    monkeypatch.setattr(studio_integrity, "scan_studio_money", lambda conn, now, **kwargs: [])
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {"full": full, "released": []})
    now = datetime(2031, 5, 5, 3, 0, tzinfo=UTC)
    result = run_daily_money_check(lambda: {}, now)
    assert result["violations"] == [] and result["alertId"] is None and result["counts"] == {"total": 0, "byCode": {}}
    assert _alert(alert_id("integrity_violation", "scan_studio_money", "2031-05-05")) == (None, None)


def test_daily_scan_failure_is_a_finding(monkeypatch):
    def broken(conn, now, **kwargs):
        raise RuntimeError("secret database text")

    monkeypatch.setattr(studio_integrity, "scan_studio_money", broken)
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {"full": full, "released": []})
    now = datetime(2031, 5, 6, 3, 0, tzinfo=UTC)
    result = run_daily_money_check(lambda: {}, now)
    (finding,) = result["violations"]
    assert finding["code"] == "check_failed" and finding["checks"] == ["scan_studio_money:RuntimeError"]
    data, _created_by = _alert(alert_id("integrity_violation", "scan_studio_money", "2031-05-06"))
    assert data["details"]["violations"] == [finding] and "secret" not in json.dumps(data)


# ------------------------------------------------------------------ the tick, the heartbeat and the loop

def test_tick_claims_each_job_once_per_turn(monkeypatch):
    runs: list[str] = []
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: runs.append("sweep") or {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: runs.append("waiting") or {})
    monkeypatch.setattr(studio_jobs, "run_daily_money_check", lambda ctx, now: runs.append("daily") or {})
    _reset_state()
    base = _night(days=3)
    assert run_tick(_provider, base)["claimed"] == ["sweep", "waiting"]
    assert run_tick(_provider, base + timedelta(seconds=30))["claimed"] == []
    assert run_tick(_provider, base + timedelta(minutes=2))["claimed"] == ["sweep"]
    assert run_tick(_provider, base + timedelta(minutes=5))["claimed"] == ["sweep", "waiting"]
    daily = base + timedelta(hours=2)  # 04:30 in Tripoli
    assert run_tick(_provider, daily)["claimed"] == ["daily", "waiting"]  # the daily run sweeps everything itself
    assert run_tick(_provider, daily + timedelta(minutes=1))["claimed"] == []  # once a day; its sweep counted
    assert run_tick(_provider, daily + timedelta(minutes=5))["claimed"] == ["sweep", "waiting"]
    assert runs == ["sweep", "waiting", "sweep", "sweep", "waiting", "daily", "waiting", "sweep", "waiting"]
    heartbeat = jobs_heartbeat(daily + timedelta(minutes=5, seconds=40))
    assert heartbeat["lastTickAt"] == studio_jobs._iso(daily + timedelta(minutes=5)) and heartbeat["ageSeconds"] == 40
    assert heartbeat["late"] is False and heartbeat["lateAfterSeconds"] == 300
    assert jobs_heartbeat(daily + timedelta(minutes=11))["late"] is True
    assert studio_jobs.read_job_state()["lastIntegrityScanDay"] == _day(daily)


def test_a_failed_job_is_recorded_and_the_tick_goes_on(monkeypatch):
    def boom(ctx, now, full=False):
        raise RuntimeError("secret text")

    monkeypatch.setattr(studio_jobs, "sweep_orphans", boom)
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: {"waiting": 0})
    _reset_state()
    now = _night(days=4)
    ran = run_tick(_provider, now)
    assert ran["sweep"] == {"error": "RuntimeError"} and ran["waiting"] == {"waiting": 0}
    heartbeat = jobs_heartbeat(now)
    assert heartbeat["lastError"] == {"job": "sweep", "error": "RuntimeError", "at": studio_jobs._iso(now)}
    assert "secret" not in json.dumps(heartbeat)


def test_one_loop_per_process_that_survives_exceptions(monkeypatch):
    calls: list[int] = []
    done = threading.Event()

    def fake_tick(provider, now=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database away")
        if len(calls) >= 3:
            done.set()
        return {}

    monkeypatch.setattr(studio_jobs, "jobs_enabled", lambda: True)
    monkeypatch.setattr(studio_jobs, "run_tick", fake_tick)
    monkeypatch.setattr(studio_jobs, "FIRST_TICK_DELAY_SECONDS", 0)
    monkeypatch.setattr(studio_jobs, "TICK_SECONDS", 0.01)
    try:
        assert studio_jobs.start_studio_jobs(lambda: {}) is True
        assert studio_jobs.start_studio_jobs(lambda: {}) is False  # one loop per process
        assert done.wait(5), calls
        assert [t.name for t in threading.enumerate() if t.is_alive()].count("albayan-studio-jobs") == 1
        assert studio_jobs.jobs_heartbeat()["runningHere"] is True
    finally:
        studio_jobs.stop_studio_jobs()
    assert not any(t.name == "albayan-studio-jobs" and t.is_alive() for t in threading.enumerate())


def test_the_loop_is_off_under_pytest_and_by_its_switch(monkeypatch):
    assert os.environ.get("PYTEST_CURRENT_TEST") and studio_jobs.jobs_enabled() is False
    assert studio_jobs.start_studio_jobs(lambda: {}) is False
    monkeypatch.delenv("PYTEST_CURRENT_TEST")
    for value in ("off", "false", "0", "no", " OFF "):
        monkeypatch.setenv(studio_jobs.ENV_SWITCH, value)
        assert studio_jobs.jobs_enabled() is False, value
    for value in ("on", "true", "1", ""):
        monkeypatch.setenv(studio_jobs.ENV_SWITCH, value)
        assert studio_jobs.jobs_enabled() is True, value
    monkeypatch.delenv(studio_jobs.ENV_SWITCH)
    assert studio_jobs.jobs_enabled() is True  # default on, Meta or not


def test_the_studio_router_starts_and_stops_the_loop():
    startup = [getattr(handler, "__name__", "") for handler in main_module.app.router.on_startup]
    shutdown = [getattr(handler, "__name__", "") for handler in main_module.app.router.on_shutdown]
    assert startup.count("_start_studio_jobs") == 1 and shutdown.count("_stop_studio_jobs") == 1


# ------------------------------------------------------------------ records and the admin read

def test_alert_rows_follow_the_created_by_rule(staff):
    user = _customer("alert-owner")
    now = _now()
    scan_id, mine_id, fake_id = _uid("scan"), _uid("cmp"), _uid("cmp")
    with db_conn() as conn:
        system, inserted = raise_alert(conn, "integrity_violation", related_type=JOB_STATE_TYPE, related_id=scan_id, now=now)
        raise_alert(conn, "review_overdue", related_type=CAMPAIGNS, related_id=mine_id, owner_id=user["id"], now=now)
        raise_alert(conn, "review_overdue", related_type=CAMPAIGNS, related_id=fake_id, owner_id="system", now=now)
        again, inserted_again = raise_alert(conn, "integrity_violation", related_type=JOB_STATE_TYPE, related_id=scan_id,
                                            count=2, details={"violations": []}, now=now + timedelta(seconds=5))
    assert inserted and not inserted_again and again["count"] == 2 and again["firstAt"] == system["firstAt"]
    assert system["id"].startswith("sal_") and len(system["id"]) == 44
    assert _alert(system["id"])[1] is None
    assert _alert(alert_id("review_overdue", mine_id, _day(now)))[1] == user["id"]
    fake, fake_created_by = _alert(alert_id("review_overdue", fake_id, _day(now)))
    assert fake_created_by is None and fake["ownerId"] is None  # 'system' is never written as a user
    with pytest.raises(ValueError):
        with db_conn() as conn:
            raise_alert(conn, "not_a_kind", related_type="x", related_id="y")


def test_generic_collections_refuse_the_new_types(staff):
    for type_name in (ALERTS_TYPE, JOB_STATE_TYPE):
        assert client.get(f"/api/collections/{type_name}", cookies=staff["admin"]["cookies"]).status_code == 404
        created = client.post(f"/api/collections/{type_name}", json={"id": _uid("x"), "data": {}},
                              cookies=staff["admin"]["cookies"])
        assert created.status_code == 404, created.text


def test_admin_alerts_route(staff):
    user = _customer("alerts-customer")
    ids = []
    with db_conn() as conn:
        for _ in range(3):
            alert, _inserted = raise_alert(conn, "integrity_violation", related_type=JOB_STATE_TYPE,
                                           related_id=_uid("page"), details={"violations": []})
            ids.append(alert["id"])
            conn.execute(text("UPDATE entities SET created_at = created_at + :shift WHERE type = :t AND id = :id"),
                         {"shift": 10_000_000_000 + len(ids), "t": ALERTS_TYPE, "id": alert["id"]})  # newest on top
    for who in (staff["reviewer"], user):
        refused = client.get("/api/studio/admin/alerts", cookies=who["cookies"])
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "ADMIN_ONLY"
    client.cookies.clear()
    assert client.get("/api/studio/admin/alerts").status_code == 401
    admin = staff["admin"]
    reset_rate_limit(f"studio:alerts:{admin['id']}")
    first = client.get("/api/studio/admin/alerts", params={"limit": 2}, cookies=admin["cookies"])
    assert first.status_code == 200, first.text
    body = first.json()
    assert [alert["id"] for alert in body["alerts"]] == [ids[2], ids[1]] and body["nextBefore"]
    assert body["alerts"][0]["labels"]["ar"] and body["alerts"][0]["kind"] == "integrity_violation"
    assert set(body["jobs"]) >= {"enabled", "lastTickAt", "ageSeconds", "late"}
    second = client.get("/api/studio/admin/alerts", params={"limit": 2, "before": body["nextBefore"]},
                        cookies=admin["cookies"]).json()
    assert second["alerts"][0]["id"] == ids[0]
    seen, cursor = [], None  # walking every page: newest first, nothing twice
    while True:
        page = client.get("/api/studio/admin/alerts", params={"limit": 50, **({"before": cursor} if cursor else {})},
                          cookies=admin["cookies"]).json()
        seen.extend(alert["id"] for alert in page["alerts"])
        cursor = page["nextBefore"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) and seen[:3] == [ids[2], ids[1], ids[0]]
    for params in ({"limit": 0}, {"limit": 51}, {"limit": "x"}, {"before": "nope"}, {"before": "12:"}):
        refused = client.get("/api/studio/admin/alerts", params=params, cookies=admin["cookies"])
        assert refused.status_code == 400 and refused.json()["detail"]["code"] == "INVALID_VALUE", params


def test_admin_alerts_are_rate_limited(staff):
    admin = staff["admin"]
    reset_rate_limit(f"studio:alerts:{admin['id']}")
    for _ in range(studio_jobs.ALERT_READS_PER_MINUTE):
        assert client.get("/api/studio/admin/alerts", params={"limit": 1}, cookies=admin["cookies"]).status_code == 200
    limited = client.get("/api/studio/admin/alerts", cookies=admin["cookies"])
    assert limited.status_code == 429 and limited.json()["detail"]["code"] == "RATE_LIMITED"
    reset_rate_limit(f"studio:alerts:{admin['id']}")


def test_diagnostics_shows_the_jobs_heartbeat(staff, monkeypatch):
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: {})
    monkeypatch.setattr(studio_jobs, "run_daily_money_check", lambda ctx, now: {})
    _reset_state()
    run_tick(_provider, _now())
    reset_rate_limit(f"studio:diagnostics:{staff['admin']['id']}")
    response = client.get("/api/studio/admin/diagnostics", cookies=staff["admin"]["cookies"])
    assert response.status_code == 200, response.text
    jobs = response.json()["jobs"]
    assert jobs["late"] is False and 0 <= jobs["ageSeconds"] < 60 and jobs["enabled"] is False  # never under pytest
    assert jobs["lastTickAt"] and jobs["lateAfterSeconds"] == 300
