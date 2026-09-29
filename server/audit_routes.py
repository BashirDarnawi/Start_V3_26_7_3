"""Audit-log routes: list, cleanup and stats.

Moved out of main.py word for word to keep it under its line cap (Albayan Studio
plan, task P0-02). Behaviour is unchanged: the same URLs, permissions, limits and
the same protected money-trail actions (main._AUDIT_KEEP_ACTIONS, passed in as
ctx["audit_keep_actions"]) that a cleanup never deletes.
"""

from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, json_loads, now_ms


def create_audit_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter()
    keep_actions = ctx["audit_keep_actions"]

    def user_has_permission(*args: Any, **kwargs: Any) -> bool:
        return ctx["user_has_permission"](*args, **kwargs)

    def audit(*args: Any, **kwargs: Any) -> None:
        ctx["audit"](*args, **kwargs)

    @router.get("/api/audit")
    def list_audit(
        limit: int = 200,
        offset: int = 0,
        before_ts: int | None = None,
        before_id: str | None = None,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        # auditLogs.view => full log; auditLogs.viewOwn => only own activity.
        # Admins pass automatically via the role bypass in user_has_permission.
        can_view_all = user_has_permission(user, "auditLogs", "view")
        can_view_own = user_has_permission(user, "auditLogs", "viewOwn")
        if not can_view_all and not can_view_own:
            raise HTTPException(status_code=403, detail="Forbidden")

        limit = max(1, min(int(limit), 1000))
        offset = max(0, min(int(offset), 10_000_000))  # a huge OFFSET overflows the database's bigint (500)

        # Newest first, id breaks ts ties. An export pages with the previous
        # page's last (ts, id) instead of OFFSET: rows written or deleted
        # meanwhile can no longer repeat or skip entries between pages.
        where: list[str] = []
        params: dict[str, Any] = {"limit": limit}
        if not can_view_all:
            where.append("user_id = :uid")
            params["uid"] = str(user.get("id") or "")
        paging = ""
        if before_ts is not None and before_id is not None:
            where.append("(ts < :bts OR (ts = :bts AND id < :bid))")
            params.update({"bts": max(0, min(int(before_ts), 2**62)), "bid": str(before_id)[:80]})
        else:
            paging = " OFFSET :offset"
            params["offset"] = offset
        sql = "SELECT * FROM audit_logs" + (f" WHERE {' AND '.join(where)}" if where else "")
        with db_conn() as conn:
            rows = conn.execute(text(f"{sql} ORDER BY ts DESC, id DESC LIMIT :limit{paging}"), params).mappings().all()
            rows = [dict(r) for r in rows]
            for r in rows:
                r["metadata"] = json_loads(r.get("metadata_json") or "{}") or {}
                r.pop("metadata_json", None)
            return rows

    @router.post("/api/audit/cleanup")
    def cleanup_audit_logs(
        days_to_keep: int = 365,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(current_user_dependency),
        request: Request = None,
    ):
        """Delete audit logs older than N days (auditLogs.clear; CSRF-protected). Money-trail actions are kept forever."""
        require_same_origin(request)
        if not user_has_permission(user, "auditLogs", "clear"):
            raise HTTPException(status_code=403, detail="Forbidden")

        # The client sends days_to_keep in the JSON body (query param also
        # accepted for backwards compatibility; body wins).
        if isinstance(payload, dict) and payload.get("days_to_keep") is not None:
            try:
                days_to_keep = int(payload.get("days_to_keep"))
            except (TypeError, ValueError):
                days_to_keep = 365
            except OverflowError:  # 1e400 / Infinity in JSON: refuse, never guess how much history to delete
                raise HTTPException(status_code=400, detail="days_to_keep must be a whole number of days")

        days_to_keep = max(30, min(int(days_to_keep), 3650))  # Min 30 days, max 10 years
        cutoff_ts = now_ms() - (days_to_keep * 24 * 60 * 60 * 1000)

        with db_conn() as conn:
            # Count logs to be deleted
            count_row = conn.execute(
                text(f"SELECT COUNT(*) as cnt FROM audit_logs WHERE ts < :cutoff AND action NOT IN {keep_actions}"),
                {"cutoff": cutoff_ts}
            ).mappings().first()
            deleted_count = int(count_row.get("cnt") or 0) if count_row else 0

            # Delete old logs (same protected set as the retention job: close/import/coverage/... rows stay)
            conn.execute(
                text(f"DELETE FROM audit_logs WHERE ts < :cutoff AND action NOT IN {keep_actions}"),
                {"cutoff": cutoff_ts}
            )

        audit(
            str(user.get("id")),
            "cleanup",
            "audit_logs",
            "bulk",
            f"Cleaned up {deleted_count} audit logs older than {days_to_keep} days",
            {"deleted_count": deleted_count, "days_to_keep": days_to_keep}
        )

        return {
            "ok": True,
            "deleted_count": deleted_count,
            "cutoff_days": days_to_keep,
            "cutoff_timestamp": cutoff_ts
        }

    @router.get("/api/audit/stats")
    def audit_stats(user: dict[str, Any] = Depends(current_user_dependency)):
        """
        Get audit log statistics (total count, oldest entry, size estimates).
        Requires auditLogs.view (admins pass automatically).
        """
        if not user_has_permission(user, "auditLogs", "view"):
            raise HTTPException(status_code=403, detail="Forbidden")
        with db_conn() as conn:
            stats_row = conn.execute(
                text("""
                    SELECT
                        COUNT(*) as total_count,
                        MIN(ts) as oldest_ts,
                        MAX(ts) as newest_ts
                    FROM audit_logs
                """)
            ).mappings().first()

            total = int(stats_row.get("total_count") or 0) if stats_row else 0
            oldest = int(stats_row.get("oldest_ts") or 0) if stats_row else 0
            newest = int(stats_row.get("newest_ts") or 0) if stats_row else 0

        return {
            "total_count": total,
            "oldest_timestamp": oldest,
            "newest_timestamp": newest,
            "oldest_date": None if oldest == 0 else str(oldest),
            "newest_date": None if newest == 0 else str(newest)
        }

    return router
