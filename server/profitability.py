"""Validation for the immutable USD acquisition cost ledger."""

from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from fastapi import HTTPException


def _decimal(value: Any, field: str, maximum: str) -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be a number")
    if not number.is_finite() or number <= 0 or number > Decimal(maximum):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    return number


def _short_text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


def validate_dollar_purchase(data: Any) -> dict[str, Any]:
    """Return a normalized cost lot; derived totals are always server-owned."""
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Invalid dollar purchase")

    amount = _decimal(data.get("amountUSD"), "amountUSD", "1000000").quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    rate = _decimal(data.get("rateLYD"), "rateLYD", "1000").quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP
    )
    purchase_date = _short_text(data.get("purchaseDate"), 10)
    try:
        parsed_date = date.fromisoformat(purchase_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="purchaseDate must be YYYY-MM-DD")
    if parsed_date > date.today():
        raise HTTPException(status_code=400, detail="purchaseDate cannot be in the future")

    return {
        "purchaseDate": purchase_date,
        "amountUSD": float(amount),
        "rateLYD": float(rate),
        "totalLYD": float((amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
        "source": _short_text(data.get("source"), 120),
        "note": _short_text(data.get("note"), 240),
    }
