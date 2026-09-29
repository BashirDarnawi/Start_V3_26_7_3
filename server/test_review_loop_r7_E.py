"""Review loop round 7, batch E: configuration and operations.

* n=13 the server alerts judge the requests of the last ALBAYAN_ALERT_WINDOW_SECONDS: an incident
       that is over stops alerting even when little traffic follows it, and a
       ALBAYAN_ALERT_MIN_REQUESTS above the 1000 requests the monitor keeps is clamped, not silent.
* n=14 an ALBAYAN_MONITOR_LOG_FILE path that cannot be made never stops the boot (the folder is made
       on the first write, inside its try), and the env example no longer suggests the dead setting.
* n=15 a failing scheduled backup waits 15, 30, 60 ... minutes before the next try; a success resets it.
* n=16 ALBAYAN_APP_SESSION_MS and the two delivery overpay settings log and fall back (a typo used to
       stop the boot; nan/inf made every driver completion a 500).
* n=17 the boot line says backup_key=ok / INVALID / MISSING, not "set" for an unusable key.
* n=18 the self-hosting Caddyfile drops a visitor-sent CF-Connecting-IP, which the env example's
       ALBAYAN_TRUST_PROXY_HEADERS=true would otherwise believe.
* n=19 the backup lease is a session lock on a committed connection; a failure releasing it after
       the file was written is a log line, not a failed backup.

No users or entity rows are created here.
"""

import base64
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from sqlalchemy.exc import OperationalError

import server.main as main_module
from server import auth_limits, monitoring, operations
from server.startup_support import read_env_float

ROOT = Path(__file__).resolve().parent.parent
_ALERT_ENV = ("ALBAYAN_ALERT_MIN_REQUESTS", "ALBAYAN_ALERT_ERROR_RATE", "ALBAYAN_ALERT_P95_MS", "ALBAYAN_ALERT_WINDOW_SECONDS")


class _FakeStop:
    """Stands in for operations._worker_stop: each wait moves the fake clock, the loop ends after `passes`."""

    def __init__(self, passes, clock=None):
        self.passes = passes
        self.clock = clock

    def wait(self, seconds):
        if self.clock is not None:
            self.clock["ms"] += int(seconds * 1000)
        if seconds >= 300:  # the loop's own pause (the first wait is the 20-second settle)
            self.passes -= 1
        return False

    def is_set(self):
        return self.passes <= 0


def _run_worker(monkeypatch, passes, metrics_fn, clock=None):
    sent = []
    monkeypatch.setattr(operations, "_worker_stop", _FakeStop(passes, clock))
    monkeypatch.setattr(operations, "get_metrics", metrics_fn)
    monkeypatch.setattr(operations, "_watch_studio_jobs", lambda: None)
    monkeypatch.setattr(operations, "_seed_last_backup_from_disk", lambda: None)
    monkeypatch.setattr(operations, "_send_alert", lambda kind, *args, **kwargs: sent.append(kind) or True)
    operations._backup_worker()
    return sent


@pytest.fixture
def worker_env(monkeypatch):
    for name in _ALERT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("ALBAYAN_BACKUP_ENABLED", raising=False)
    monkeypatch.setattr(operations, "_status", dict(operations._status, lastBackupAt=None, lastBackupError="",
                                                    backupFailureCount=0, nextBackupAttemptAt=None))
    now = {"t": 50_000.0}
    monkeypatch.setattr(monitoring, "_clock", lambda: now["t"], raising=False)
    return now


# ---------------------------------------------------------------- n=13 alert window

def test_n13_an_incident_that_is_over_stops_alerting_even_without_traffic(monkeypatch, worker_env):
    monitor = monitoring.ApplicationMonitor(log_file="", sample_size=1000)
    for _ in range(60):
        monitor.observe_request(500, 5000.0)
    for _ in range(100):
        monitor.observe_request(200, 5000.0)
    assert sorted(_run_worker(monkeypatch, 1, monitor.get_metrics)) == ["high_error_rate", "slow_responses"]

    worker_env["t"] += 20 * 60  # the office closed: twenty quiet minutes, then a few good requests
    for _ in range(5):
        monitor.observe_request(200, 30.0)
    assert _run_worker(monkeypatch, 1, monitor.get_metrics) == []  # was high_error_rate + slow_responses every cooldown
    metrics = monitor.get_metrics()
    assert metrics["recent_sample_size"] == 5 and metrics["recent_error_rate"] == 0.0
    assert metrics["recent_window_seconds"] == 900.0
    assert metrics["total_errors"] == 60 and metrics["error_rate"] > 0  # the history is still reported


def test_n13_the_window_length_is_a_setting(monkeypatch, worker_env):
    monkeypatch.setenv("ALBAYAN_ALERT_WINDOW_SECONDS", "3600")
    monitor = monitoring.ApplicationMonitor(log_file="", sample_size=1000)
    for _ in range(60):
        monitor.observe_request(500, 10.0)
    worker_env["t"] += 20 * 60
    assert monitor.get_metrics()["recent_sample_size"] == 60  # still inside a one-hour window
    for bad in ("nan", "soon"):
        monkeypatch.setenv("ALBAYAN_ALERT_WINDOW_SECONDS", bad)
        assert monitor.get_metrics()["recent_window_seconds"] == 900.0


def test_n13_a_min_requests_above_the_window_is_clamped_not_silent(monkeypatch, worker_env, capsys):
    monkeypatch.setenv("ALBAYAN_ALERT_MIN_REQUESTS", "5000")
    monkeypatch.setattr(operations, "_alert_min_clamp_logged", False, raising=False)
    monitor = monitoring.ApplicationMonitor(log_file="", sample_size=1000)
    for _ in range(1000):
        monitor.observe_request(500, 10.0)
    assert "high_error_rate" in _run_worker(monkeypatch, 2, monitor.get_metrics)  # was never sent
    out = capsys.readouterr().out
    assert out.count("ALBAYAN_ALERT_MIN_REQUESTS=5000") == 1  # said once, not every pass


# ---------------------------------------------------------------- n=14 monitor log file

def test_n14_an_unwritable_monitor_log_path_never_stops_the_boot(tmp_path, monkeypatch, capsys):
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where a folder was expected", encoding="utf-8")
    bad = blocker / "sub" / "monitor.ndjson"
    monitor = monitoring.ApplicationMonitor(log_file=str(bad))  # raised at import time before
    monitor.log_business_event("receipt_created", {"receipt_id": "r1"})
    assert "Monitoring log write failed" in capsys.readouterr().out
    monkeypatch.setenv("ALBAYAN_MONITOR_LOG_FILE", str(bad))
    monitoring.ApplicationMonitor()  # the module-level monitor reads the variable: no exception
    fresh = tmp_path / "made-on-first-write" / "monitor.ndjson"
    monitoring.ApplicationMonitor(log_file=str(fresh)).log_business_event("receipt_created", {"receipt_id": "r2"})
    assert '"type":"business_event"' in fresh.read_text(encoding="utf-8")


def test_n14_the_env_example_no_longer_suggests_the_dead_monitor_file():
    example = (ROOT / "deploy" / "albayan.env.example").read_text(encoding="utf-8")
    assert "ALBAYAN_MONITOR_LOG_FILE" not in example and "/var/log/albayan" not in example
    assert "ALBAYAN_ALERT_WINDOW_SECONDS" in (ROOT / "docs" / "OPERATIONS_SAFETY.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------- n=15 backup backoff

def test_n15_a_failing_scheduled_backup_backs_off(monkeypatch, worker_env):
    clock = {"ms": 1_800_000_000_000}
    monkeypatch.setattr(operations, "now_ms", lambda: clock["ms"])
    monkeypatch.setenv("ALBAYAN_BACKUP_ENABLED", "true")
    monkeypatch.setenv("ALBAYAN_BACKUP_INTERVAL_HOURS", "24")
    calls = []

    def full_disk():
        calls.append(clock["ms"])
        raise RuntimeError("No space left on device")

    monkeypatch.setattr(operations, "create_encrypted_backup", full_disk)
    sent = _run_worker(monkeypatch, 12, lambda: {}, clock)  # one simulated hour of 5-minute passes
    assert len(calls) == 3, len(calls)  # was 12: a full pg_dump every pass
    assert [b - a for a, b in zip(calls, calls[1:])] == [15 * 60 * 1000, 30 * 60 * 1000]
    assert sent.count("backup_failed") == 3
    assert operations._status["backupFailureCount"] == 3
    assert operations._status["nextBackupAttemptAt"] == calls[-1] + 60 * 60 * 1000
    assert "No space left" in operations._status["lastBackupError"]


def test_n15_the_backoff_never_exceeds_one_interval_and_busy_is_not_counted(monkeypatch, worker_env):
    clock = {"ms": 1_800_000_000_000}
    monkeypatch.setattr(operations, "now_ms", lambda: clock["ms"])
    monkeypatch.setenv("ALBAYAN_BACKUP_ENABLED", "true")
    monkeypatch.setenv("ALBAYAN_BACKUP_INTERVAL_HOURS", "1")
    operations._status["backupFailureCount"] = 9  # 15 min x 2^9 would be 128 hours
    calls = []

    def broken():
        calls.append(clock["ms"])
        raise RuntimeError("pg_dump: server version mismatch")

    monkeypatch.setattr(operations, "create_encrypted_backup", broken)
    _run_worker(monkeypatch, 1, lambda: {}, clock)
    assert operations._status["nextBackupAttemptAt"] == calls[0] + 3600 * 1000  # one interval, not 128 hours

    operations._status.update(backupFailureCount=0, nextBackupAttemptAt=None)

    def busy():
        raise operations.BackupAlreadyRunning("A backup is already running on another application worker")

    monkeypatch.setattr(operations, "create_encrypted_backup", busy)
    _run_worker(monkeypatch, 1, lambda: {}, clock)
    assert operations._status["backupFailureCount"] == 0 and not operations._status["nextBackupAttemptAt"]


@pytest.fixture
def backup_env(tmp_path, monkeypatch):
    pytest.importorskip("cryptography")
    monkeypatch.setenv("ALBAYAN_BACKUP_ENABLED", "true")
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"k" * 32).decode("ascii"))
    monkeypatch.setenv("ALBAYAN_BACKUP_DIR", str(tmp_path))
    for name in ("ALBAYAN_BACKUP_S3_BUCKET", "ALBAYAN_BACKUP_S3_ACCESS_KEY", "ALBAYAN_BACKUP_S3_SECRET_KEY", "ALBAYAN_ALERT_WEBHOOK_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(operations, "_status", dict(operations._status, lastBackupAt=None, lastBackupError="",
                                                    backupFailureCount=0, nextBackupAttemptAt=None))
    monkeypatch.setattr(operations, "_dump_database", lambda target: Path(target).write_bytes(b"dump"))
    return tmp_path


def test_n15_a_successful_backup_resets_the_backoff(backup_env):
    operations._status.update(backupFailureCount=4, nextBackupAttemptAt=9_999_999_999_999, lastBackupError="disk full")
    result = operations.create_encrypted_backup()  # the "Create encrypted backup now" path never waits
    assert (backup_env / result["file"]).exists()
    assert operations._status["backupFailureCount"] == 0 and operations._status["nextBackupAttemptAt"] is None
    assert operations._status["lastBackupError"] == ""


# ---------------------------------------------------------------- n=16 settings that must not crash

def test_n16_read_env_float_logs_and_falls_back(monkeypatch, capsys):
    name = "ALBAYAN_R7E_TEST_FLOAT"
    for bad in ("nan", "inf", "-inf", "3x", "NaN"):
        monkeypatch.setenv(name, bad)
        assert read_env_float(name, 3.0) == 3.0, bad
    assert f"CONFIG {name}=" in capsys.readouterr().out
    monkeypatch.setenv(name, "")
    assert read_env_float(name, 3.0) == 3.0
    monkeypatch.setenv(name, " 2.5 ")
    assert read_env_float(name, 3.0) == 2.5
    monkeypatch.setenv(name, "-1")
    assert read_env_float(name, 3.0, lo=0.0) == 0.0
    monkeypatch.setenv(name, "1e308")
    assert read_env_float(name, 3.0, hi=1_000_000.0) == 1_000_000.0
    monkeypatch.delenv(name)
    assert read_env_float(name, 7.5, lo=0.0, hi=1.0) == 7.5  # the default is never clamped


def test_n16_a_typo_or_nan_in_those_settings_never_stops_the_boot():
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": "sqlite+pysqlite:///:memory:", "ALBAYAN_ALLOW_SQLITE": "true", "ALBAYAN_META_BACKGROUND_SYNC": "false",
        "ALBAYAN_APP_SESSION_MS": "30d", "ALBAYAN_DELIVERY_OVERPAY_RATIO": "nan", "ALBAYAN_DELIVERY_OVERPAY_ABS_LOCAL": "inf",
    })
    env.pop("ALBAYAN_SESSION_REMEMBER_MS", None)
    code = "import server.main as m; print('VALUES', m.APP_LOGIN_SESSION_MS, m._DELIVERY_OVERPAY_RATIO, m._DELIVERY_OVERPAY_ABS_LOCAL)"
    run = subprocess.run([sys.executable, "-c", code], cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=240)
    assert run.returncode == 0, run.stderr[-2000:]  # was ValueError at import: the container exited
    assert "VALUES 2592000000 3.0 10000.0" in run.stdout, run.stdout[-2000:]


# ---------------------------------------------------------------- n=17 boot line

def test_n17_backup_key_state_names_an_unusable_key(monkeypatch):
    monkeypatch.delenv("ALBAYAN_BACKUP_KEY", raising=False)
    assert operations.backup_key_state() == "MISSING"
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", "   ")
    assert operations.backup_key_state() == "MISSING"
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"short").decode("ascii"))
    assert operations.backup_key_state() == "INVALID"
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", "ab" * 32)  # a hex key: 64 characters, not 32 bytes
    assert operations.backup_key_state() == "INVALID"
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"x" * 32).decode("ascii").rstrip("="))
    assert operations.backup_key_state() == "ok"


def test_n17_the_boot_line_says_invalid_not_set(monkeypatch, capsys):
    class _StopAfterBootLine(Exception):
        pass

    def stop():
        raise _StopAfterBootLine()

    monkeypatch.setattr(main_module, "_ensure_minified_script", lambda: None)
    monkeypatch.setattr(main_module, "_refuse_sqlite_in_production", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_init_db_with_retry", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "_bootstrap_first_admin_if_empty", stop)
    short_key = base64.urlsafe_b64encode(b"sixteen-byte-key").decode("ascii")
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", short_key)
    with pytest.raises(_StopAfterBootLine):
        main_module._startup()
    line = [row for row in capsys.readouterr().out.splitlines() if "[albayan] boot:" in row][-1]
    assert "backup_key=INVALID" in line and "backup_key=set" not in line, line
    assert short_key not in line  # the key itself is never printed


# ---------------------------------------------------------------- n=18 self-hosting proxy

def _caddy_forward(attacker_headers: dict, caddyfile: str, client_ip: str) -> SimpleNamespace:
    """The request the app sees after Caddyfile.example's reverse_proxy: the header_up removals are
    applied and Caddy writes X-Forwarded-For with the real client (an untrusted incoming value is replaced)."""
    removed = {name.lower() for name in re.findall(r"header_up\s+-([A-Za-z0-9-]+)", caddyfile)}
    headers = {k.lower(): v for k, v in attacker_headers.items() if k.lower() not in removed}
    headers["x-forwarded-for"] = client_ip
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host="127.0.0.1"), state=SimpleNamespace())


def test_n18_the_self_hosting_kit_never_believes_a_visitor_cf_connecting_ip(monkeypatch):
    example = (ROOT / "deploy" / "albayan.env.example").read_text(encoding="utf-8")
    caddyfile = (ROOT / "deploy" / "Caddyfile.example").read_text(encoding="utf-8")
    trust = re.search(r"^ALBAYAN_TRUST_PROXY_HEADERS=(\S+)", example, re.M)
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", bool(trust) and trust.group(1).lower() in {"1", "true", "yes"})
    monkeypatch.delenv("ALBAYAN_ORIGIN_SECRET", raising=False)
    seen = {
        auth_limits._client_ip(_caddy_forward({"CF-Connecting-IP": forged}, caddyfile, "203.0.113.7"))
        for forged in ("198.51.100.1", "198.51.100.2", "198.51.100.3")
    }
    assert seen == {"203.0.113.7"}, seen  # was one fresh login allowance per forged value


# ---------------------------------------------------------------- n=19 backup lease

class _LeaseConn:
    def __init__(self, log, *, acquired=True, unlock_fails=True):
        self.log = log
        self.acquired = acquired
        self.unlock_fails = unlock_fails

    def execute(self, statement, params=None):
        sql = str(statement)
        self.log.append(sql)
        if "unlock" in sql and self.unlock_fails:
            raise OperationalError("SELECT pg_advisory_unlock", {}, Exception("server closed the connection unexpectedly"))
        return SimpleNamespace(scalar=lambda: self.acquired)

    def commit(self):
        self.log.append("commit")

    def invalidate(self):
        self.log.append("invalidate")

    def close(self):
        self.log.append("close")


def _postgres_lease(monkeypatch, conn):
    monkeypatch.setattr(operations, "get_engine", lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql"), connect=lambda: conn))

    @contextmanager
    def dropped_transaction():  # the old path: the lock transaction's COMMIT fails after the dump
        yield conn
        raise OperationalError("COMMIT", {}, Exception("server closed the connection unexpectedly"))

    monkeypatch.setattr(operations, "db_conn", dropped_transaction)


def test_n19_a_dropped_lease_connection_never_fails_a_finished_backup(monkeypatch, backup_env, capsys):
    log = []
    conn = _LeaseConn(log)
    _postgres_lease(monkeypatch, conn)
    at_dump = []

    def dump(target):
        at_dump.append(list(log))
        Path(target).write_bytes(b"dump")

    monkeypatch.setattr(operations, "_dump_database", dump)
    result = operations.create_encrypted_backup()  # raised OperationalError before; lastBackupAt stayed old
    assert (backup_env / result["file"]).exists()
    assert operations._status["lastBackupAt"] == result["createdAt"] and operations._status["lastBackupError"] == ""
    assert at_dump[0][-1] == "commit"  # the lock's transaction was committed before the dump: idle, not idle in transaction
    assert "pg_try_advisory_lock" in at_dump[0][0] and "xact" not in at_dump[0][0]
    assert "invalidate" in log and log[-1] == "close"  # the broken session is closed for good, so its lock ends
    assert "Backup lease release failed" in capsys.readouterr().out
    assert not operations._backup_process_lock.locked()


def test_n19_the_lease_is_released_and_a_busy_lease_is_still_busy(monkeypatch, backup_env):
    log = []
    _postgres_lease(monkeypatch, _LeaseConn(log, unlock_fails=False))
    operations.create_encrypted_backup()
    assert any("pg_advisory_unlock" in row for row in log) and log[-2:] == ["commit", "close"]
    assert "invalidate" not in log

    busy_log = []
    _postgres_lease(monkeypatch, _LeaseConn(busy_log, acquired=False))
    with pytest.raises(operations.BackupAlreadyRunning):
        operations.create_encrypted_backup()
    assert busy_log[-1] == "close" and not any("unlock" in row for row in busy_log)
    assert not operations._backup_process_lock.locked()
