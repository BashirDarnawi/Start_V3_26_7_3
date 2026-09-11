"""Read old financial rows using current rules without rewriting their history.

Only *derived summaries* are recalculated. Receipt cash, rates, funding rows,
refund/stop baselines, actors and timestamps are never invented or changed.
The same helpers serve response projection and locked coverage validation so
the amount offered by the UI cannot depend on a stale pre-upgrade summary.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from fastapi import HTTPException

from .financial_core import (
    _financial_ad_due_usage,
    _financial_due_total,
    _financial_legacy_due_receipt_id,
    _financial_minor,
    _financial_usd,
)


def receipt_customer_outstanding_minor(
    data: dict[str, Any],
    financial_due_total: Callable[[dict[str, Any]], int] = _financial_due_total,
    *,
    collected_minor: int | None = None,
) -> int | None:
    """Derive a trustworthy outstanding amount, or None when history is missing.

    An unpaid office amount is a promise; a delivered amount is actual cash.
    The latter therefore requires an explicit gross debt before subtraction.
    This deliberately does not infer that a legacy *paid* amount was gross or
    net of company funds: deciding that could alter real customer cash.
    """
    status = re.sub(r"[\s_-]+", "", str(data.get("status") or "").strip().lower())
    delivery_status = str(data.get("deliveryStatus") or "").strip().lower()
    if status in {"canceled", "cancelled", "lost", "destroyed"} or delivery_status in {"canceled", "cancelled"}:
        return 0
    if status == "paid" or (not status and data.get("isPaid") is True):
        return 0
    if status in {"notpaid", "unpaid", "pending"} and data.get("isPaid") is True:
        # Conflicting old payment markers cannot prove a new customer debt.
        return None
    if status not in {"notpaid", "unpaid", "pending"} and (status or data.get("isPaid") is not False):
        return None
    delivered = delivery_status == "delivered"
    if delivered and data.get("debtAmountUSD") is None:
        # A local debt may only be converted with a real stored rate; never
        # assume that amountUSD (now collected cash) is the original debt.
        return None
    if not delivered and data.get("amountUSD") is None and data.get("debtAmountUSD") is None:
        return None
    try:
        # Existing documented reader aliases affect the summary only. Keep
        # the original status/cash fields untouched in both storage/response.
        source = {**data, "status": "Not Paid", "isPaid": False}
        if delivered:
            source["deliveryStatus"] = "Delivered"
        gross_minor = financial_due_total(source)
        covered_minor = _financial_minor(data.get("companyCoveredUSD"), "company coverage")
        if covered_minor > gross_minor:
            # A funding/amount mismatch needs review, not a clamped history.
            return None
        collected = (
            max(int(collected_minor), 0) if collected_minor is not None
            else _financial_minor(data.get("amountUSD"), "customer cash") if delivered
            else 0
        )
        return max(gross_minor - covered_minor - collected, 0)
    except (HTTPException, TypeError, ValueError, OverflowError):
        return None


def _allocation_total(raw: Any) -> int | None:
    """Sum valid canonical allocation rows; malformed rows are not zero money."""
    if not isinstance(raw, list):
        return None
    total = 0
    try:
        for row in raw:
            if not isinstance(row, dict) or not str(row.get("receiptId") or "").strip():
                return None
            if row.get("amountUSD") is None:
                return None
            total += _financial_minor(row["amountUSD"], "allocation")
    except HTTPException:
        return None
    return total


def project_financial_data(collection: str, data: dict[str, Any]) -> dict[str, Any]:
    """Return an idempotent, non-mutating projection of cached money summaries."""
    changes: dict[str, Any] = {}
    if collection == "receipts":
        # Zero-value driver receipts can derive debt from ads on the client.
        # Do not introduce a zero cache on those legacy rows and hide that debt.
        if data.get("customerOutstandingUSD") is not None or data.get("companyCoveredUSD") is not None:
            outstanding = receipt_customer_outstanding_minor(data)
            if outstanding is not None:
                changes["customerOutstandingUSD"] = _financial_usd(outstanding)
    elif collection == "ads":
        if "companyFundingAllocations" in data:
            company = _allocation_total(data["companyFundingAllocations"])
            if company is not None:
                changes["companyFundedUSD"] = _financial_usd(company)
        if "dueAllocations" in data:
            due = _allocation_total(data["dueAllocations"])
            if due == 0:
                legacy_receipt_id = _financial_legacy_due_receipt_id(data)
                if legacy_receipt_id:
                    try:
                        due = _financial_ad_due_usage(data, legacy_receipt_id)
                    except HTTPException:
                        due = None
            if due is not None:
                changes["customerDueUSD"] = _financial_usd(due)
    changes = {key: value for key, value in changes.items() if data.get(key) != value}
    return {**data, **changes} if changes else data


def project_financial_entity(entity: dict[str, Any]) -> dict[str, Any]:
    """Apply current read rules at the shared entity-response boundary."""
    data = entity.get("data")
    if not isinstance(data, dict) or entity.get("deleted"):
        return entity
    projected = project_financial_data(str(entity.get("type") or ""), data)
    return {**entity, "data": projected} if projected is not data else entity
