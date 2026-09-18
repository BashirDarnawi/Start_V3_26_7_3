"""Health probes, kept out of main.py.

``/api/health/live`` is deliberately ``async`` and touches nothing: it must
answer even when every worker thread is busy and every pooled connection is
taken, because the container health check depends on it. ``/api/health/ready``
(and the legacy ``/api/health``) prove the database and report the release.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .db import db_conn, get_engine, now_ms


def build_health_router(app_version: str, release_sha: str) -> APIRouter:
    router = APIRouter()

    def _readiness_response() -> Any:
        try:
            with db_conn() as conn:
                conn.execute(text("SELECT 1")).first()
        except Exception as e:
            # Keep connection strings, hostnames and driver details out of the
            # public response; the exception type is enough in the server log.
            print(f"[albayan] Readiness database check failed: {type(e).__name__}")
            return JSONResponse(
                {"ok": False, "ts": now_ms(), "database": "unavailable", "version": app_version},
                status_code=500,
            )
        response: dict[str, Any] = {
            "ok": True,
            "ts": now_ms(),
            "database": "connected",
            # A container that lost its DATABASE_URL would come up on SQLite and
            # look healthy; the dialect makes that visible.
            "dialect": str(get_engine().dialect.name or ""),
            "version": app_version,
            "release": release_sha,
        }
        try:
            from .monitoring import get_metrics

            response["metrics"] = get_metrics()
        except Exception as e:
            print(f"[albayan] Health check metrics error: {type(e).__name__}: {e}")
        return response

    @router.get("/api/health/live")
    async def liveness() -> dict[str, Any]:
        """Process check for orchestrators: no thread pool, no database."""
        return {"ok": True, "ts": now_ms(), "version": app_version, "release": release_sha}

    @router.get("/api/health/ready")
    def readiness() -> Any:
        """Deployment readiness check including database connectivity."""
        return _readiness_response()

    @router.get("/api/health")
    def health() -> Any:
        """Backward-compatible readiness endpoint used by existing deployments."""
        return _readiness_response()

    return router
