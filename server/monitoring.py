"""Small, dependency-free application metrics and structured event logging."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return round(float(ordered[index]), 2)


class ApplicationMonitor:
    """Thread-safe process metrics with optional NDJSON event persistence.

    Container logs remain the primary production log stream. Set
    ``ALBAYAN_MONITOR_LOG_FILE`` only when a durable mounted log file is wanted.
    Keeping file output optional avoids unbounded writes inside the application
    container while still making the health endpoint useful.
    """

    def __init__(self, log_file: str | None = None, sample_size: int = 1000):
        configured = (log_file if log_file is not None else os.getenv("ALBAYAN_MONITOR_LOG_FILE", "")).strip()
        self.log_file = Path(configured) if configured else None
        if self.log_file:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._durations: deque[float] = deque(maxlen=max(10, int(sample_size)))
        self.request_count = 0
        self.error_count = 0
        self.start_time = time.monotonic()

    def observe_request(self, status: int, duration_ms: float) -> None:
        """Record counters without emitting a second copy of the access log."""
        with self._lock:
            self.request_count += 1
            if int(status) >= 500:
                self.error_count += 1
            self._durations.append(max(0.0, float(duration_ms)))

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
            durations = list(self._durations)
        uptime_seconds = max(0.0, time.monotonic() - self.start_time)
        return {
            "uptime_seconds": round(uptime_seconds, 2),
            "uptime_hours": round(uptime_seconds / 3600, 4),
            "total_requests": request_count,
            "total_errors": error_count,
            "error_rate": round(error_count / max(request_count, 1), 6),
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
