"""Delivery operations that are not plain CRUD.

Split out of main.py to keep it under its architecture line cap. The only
endpoint here answers "which deliveries are stuck?" for the dispatch screen.

PERMISSION NOTE: deliveries.assign is deliberately grantable on its own, so
this endpoint must not become a side door to receipts money. Customer ids and
amounts are included ONLY for callers who also hold receipts.view, and a
driver account sees only its own rows.
"""

from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, get_engine, json_loads, now_ms


def create_delivery_ops_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/deliveries", tags=["deliveries"])

    @router.post("/check-stuck")
    def check_stuck_deliveries(
        request: Request,
        hours_threshold: int = 72,
        payload: dict[str, Any] | None = Body(default=None),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """
        Find deliveries that have been 'In Progress' for more than X hours (default: 72h = 3 days).
        Requires the deliveries.assign permission (admins pass automatically) —
        matching the client-side gate. Returns stuck delivery receipts for review.
        """
        require_same_origin(request)
        if not ctx["user_has_permission"](user, "deliveries", "assign"):
            raise HTTPException(status_code=403, detail="Forbidden")
        caller_uid = str(user.get("id") or "")
        is_delivery_role = str(user.get("role") or "").lower() == "delivery"
        # deliveries.assign is grantable on its own, so it must not become a side
        # door to receipt money and customer ids.
        can_see_receipt_money = ctx["user_has_permission"](user, "receipts", "view")

        # The client sends hours_threshold in the JSON body; also accept the query
        # param for backwards compatibility (body wins).
        if isinstance(payload, dict) and payload.get("hours_threshold") is not None:
            try:
                hours_threshold = int(payload.get("hours_threshold"))
            except (TypeError, ValueError):
                hours_threshold = 72

        hours_threshold = max(1, min(int(hours_threshold), 720))  # Min 1 hour, max 30 days
        cutoff_ts = now_ms() - (hours_threshold * 60 * 60 * 1000)
    
        stuck_deliveries = []
    
        with db_conn() as conn:
            # Get receipts with deliveryStatus = 'In Progress'. Production receipts
            # carry inline base64 photos (up to 8MB each), so loading EVERY receipt's
            # data_json to filter in Python could materialize gigabytes and OOM-kill
            # the small ECS task. On Postgres, filter deliveryStatus in SQL so only
            # candidate rows load their data_json. Cap results as a backstop.
            dialect = str(get_engine().dialect.name or "")
            if dialect == "postgresql":
                rows = (
                    conn.execute(
                        text("""
                            SELECT id, data_json, created_at, last_modified
                            FROM entities
                            WHERE type = 'receipts' AND deleted = false
                              AND (data_json::jsonb ->> 'deliveryStatus') = 'In Progress'
                            LIMIT 5000
                        """)
                    )
                    .mappings()
                    .all()
                )
            else:
                # SQLite (dev): no JSON operator dependency; bounded scan.
                rows = (
                    conn.execute(
                        text("""
                            SELECT id, data_json, created_at, last_modified
                            FROM entities
                            WHERE type = 'receipts' AND deleted = false
                            LIMIT 5000
                        """)
                    )
                    .mappings()
                    .all()
                )
        
            for row in rows:
                data = json_loads(row.get("data_json") or "{}") or {}
                delivery_status = str(data.get("deliveryStatus") or "").strip()
            
                if delivery_status == "In Progress":
                    # Check when it was accepted or last modified
                    accepted_date = data.get("acceptedDate")
                    if accepted_date:
                        try:
                            from datetime import datetime
                            accepted_dt = datetime.fromisoformat(accepted_date.replace('Z', '+00:00'))
                            accepted_ts = int(accepted_dt.timestamp() * 1000)
                        except:
                            accepted_ts = int(row.get("created_at") or 0)
                    else:
                        accepted_ts = int(row.get("created_at") or 0)
                
                    if accepted_ts < cutoff_ts:
                        # A driver only ever sees their OWN stuck deliveries.
                        if is_delivery_role and str(data.get("deliveryPersonId") or "") != caller_uid:
                            continue
                        row_out = {
                            "id": row.get("id"),
                            "tempReceiptNo": data.get("tempReceiptNo"),
                            "finalReceiptNo": data.get("finalReceiptNo"),
                            "deliveryPersonId": data.get("deliveryPersonId"),
                            "acceptedDate": accepted_date,
                            "hoursStuck": int((now_ms() - accepted_ts) / (1000 * 60 * 60)),
                        }
                        # Money and the customer link are receipts data. A dispatcher
                        # granted only deliveries.assign gets the operational list —
                        # which is what this screen needs — without the amounts.
                        if can_see_receipt_money:
                            row_out["customerId"] = data.get("customerId")
                            row_out["amountLocal"] = data.get("amountLocal")
                            row_out["amountUSD"] = data.get("amountUSD")
                        stuck_deliveries.append(row_out)
    
        return {
            "ok": True,
            "stuck_count": len(stuck_deliveries),
            "hours_threshold": hours_threshold,
            "stuck_deliveries": stuck_deliveries
        }

    return router
