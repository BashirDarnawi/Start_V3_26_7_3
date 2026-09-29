"""Small, dependency-free application metrics and structured event logging."""

from __future__ import annotations

import json
import math
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

_clock = time.monotonic  # the recent window's clock (a test can move it)
_DEFAULT_WINDOW_SECONDS = 900.0


def _window_seconds() -> float:
    """ALBAYAN_ALERT_WINDOW_SECONDS: how far back "recent" reaches (default 15 minutes, 60 s to 1 day)."""
    try:
        value = float((os.getenv("ALBAYAN_ALERT_WINDOW_SECONDS") or "").strip() or _DEFAULT_WINDOW_SECONDS)
    except ValueError:
        return _DEFAULT_WINDOW_SECONDS
    return max(60.0, min(86400.0, value)) if math.isfinite(value) else _DEFAULT_WINDOW_SECONDS


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return round(float(ordered[index]), 2)


class ApplicationMonitor:
    """Thread-safe process metrics with optional NDJSON event persistence.

    Container logs remain the primary production log stream (they carry the
    access log). ``ALBAYAN_MONITOR_LOG_FILE`` only receives the explicit
    log_request/log_error/log_business_event calls, so it is not an operator
    setting; a path that cannot be written only prints a warning, never stops
    the boot.

    The "recent" figures the alerts judge (recent_error_rate,
    recent_sample_size, recent_response_ms_p95) count only requests from the
    last ALBAYAN_ALERT_WINDOW_SECONDS, at most ``sample_size`` of them: an
    incident that is over stops alerting even when little traffic follows it.
    """

    def __init__(self, log_file: str | None = None, sample_size: int = 1000):
        configured = (log_file if log_file is not None else os.getenv("ALBAYAN_MONITOR_LOG_FILE", "")).strip()
        self.log_file = Path(configured) if configured else None  # its folder is made on the first write
        self._lock = threading.Lock()
        self.sample_capacity = max(10, int(sample_size))
        # (clock, failed, duration_ms) of the latest requests
        self._recent: deque[tuple[float, bool, float]] = deque(maxlen=self.sample_capacity)
        self.request_count = 0
        self.error_count = 0
        self.start_time = time.monotonic()

    def observe_request(self, status: int, duration_ms: float) -> None:
        """Record counters without emitting a second copy of the access log."""
        with self._lock:
            self.request_count += 1
            if int(status) >= 500:
                self.error_count += 1
            self._recent.append((_clock(), int(status) >= 500, max(0.0, float(duration_ms))))

    def log_request(
        self,
        method: str,
        path: str,
        status: int,
        duration_ms: float,
        user_id: str | None = None,
    ) -> None:
        self.observe_request(status, duration_ms)
        self._write_log(
            {
                "timestamp": int(time.time() * 1000),
                "type": "request",
                "method": method,
                "path": path,
                "status": int(status),
                "duration_ms": float(duration_ms),
                "user_id": user_id,
                "is_error": int(status) >= 400,
            }
        )

    def log_error(
        self,
        error_type: str,
        message: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self.error_count += 1
        self._write_log(
            {
                "timestamp": int(time.time() * 1000),
                "type": "error",
                "error_type": error_type,
                "message": message,
                "context": context or {},
            }
        )

    def log_business_event(self, event_type: str, details: dict[str, Any]) -> None:
        self._write_log(
            {
                "timestamp": int(time.time() * 1000),
                "type": "business_event",
                "event_type": event_type,
                "details": details,
            }
        )

    def get_metrics(self) -> dict[str, Any]:
        with self._lock:
            request_count = self.request_count
            error_count = self.error_count
            rows = list(self._recent)
        window = _window_seconds()
        cutoff = _clock() - window
        recent = [row for row in rows if row[0] >= cutoff]
        durations = [row[2] for row in rows]
        uptime_seconds = max(0.0, time.monotonic() - self.start_time)
        return {
            "uptime_seconds": round(uptime_seconds, 2),
            "uptime_hours": round(uptime_seconds / 3600, 4),
            "total_requests": request_count,
            "total_errors": error_count,
            "error_rate": round(error_count / max(request_count, 1), 6),
            "recent_error_rate": round(sum(1 for row in recent if row[1]) / max(len(recent), 1), 6),
            "recent_sample_size": len(recent),
            "recent_response_ms_p95": _percentile([row[2] for row in recent], 0.95),
            "recent_window_seconds": round(window, 2),
            "recent_capacity": self.sample_capacity,
            "requests_per_minute": round(request_count / max(uptime_seconds / 60, 1), 3),
            "response_ms_p50": _percentile(durations, 0.50),
            "response_ms_p95": _percentile(durations, 0.95),
            "sample_size": len(durations),
        }

    def _write_log(self, entry: dict[str, Any]) -> None:
        if not self.log_file:
            return
        try:
            line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
            with self._lock:
                self.log_file.parent.mkdir(parents=True, exist_ok=True)
                with self.log_file.open("a", encoding="utf-8") as handle:
                    handle.write(line)
        except Exception as exc:
            print(f"[albayan] Monitoring log write failed: {type(exc).__name__}")


monitor = ApplicationMonitor()


def observe_request(status: int, duration_ms: float) -> None:
    monitor.observe_request(status, duration_ms)


def log_request(
    method: str,
    path: str,
    status: int,
    duration_ms: float,
    user_id: str | None = None,
) -> None:
    monitor.log_request(method, path, status, duration_ms, user_id)


def log_error(
    error_type: str,
    message: str,
    context: dict[str, Any] | None = None,
) -> None:
    monitor.log_error(error_type, message, context)


def log_business_event(event_type: str, details: dict[str, Any]) -> None:
    monitor.log_business_event(event_type, details)


def get_metrics() -> dict[str, Any]:
    return monitor.get_metrics()
