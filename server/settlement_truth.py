"""Server-authoritative settlement money truth for receipts.

Two pure recompute passes that run inside the receipt row lock, immediately
before persistence (main.py's atomic receipt patch):

- ``apply_delivery_completion_truth``: on the transition to Delivered,
  re-derive every money field from locked receipt/ad state. Company-covered
  dollars are netted out first — the driver only ever collects the customer's
  remaining share, so covered money can never be recovered twice.
- ``apply_coverage_settlement_truth``: on settle/unsettle of a covered
  receipt outside the delivery flow, keep ``amountUSD`` equal to CUSTOMER
  cash only (the company share lives in ``companyCoveredUSD``).

Main-owned helpers (the delivery collection target and rate validator) and
the overpay constants are injected so this module stays free of main.py's
import cycle, mirroring company_debt_coverage.py.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Callable

from fastapi import HTTPException

from .financial_core import _financial_minor, _financial_usd


def apply_delivery_completion_truth(
    receipt_id: str,
    old: dict[str, Any],
    merged: dict[str, Any],
    ad_rows: list[Any],
    *,
    delivery_collection_target: Callable[..., dict[str, Any]],
    valid_rate: Callable[[Any], Decimal | None],
    overpay_abs_local: float,
    overpay_ratio: float,
) -> None:
    """Recompute delivery money from locked receipt/ad state before persistence."""
    if (
        str(merged.get("deliveryStatus") or "").strip() != "Delivered"
        or str(old.get("deliveryStatus") or "").strip() == "Delivered"
    ):
        return

    target = delivery_collection_target(receipt_id, old, ad_rows)
    debt_usd = int(target["usdMinor"])
    debt_local = int(target["localMinor"])
    collected_local = _financial_minor(
        merged.get("amountCollectedFromCustomer"),
        "amountCollectedFromCustomer",
    )

    trusted_rate: Decimal | None = None
    if target["source"] == "linked_ads" and debt_usd > 0 and debt_local > 0:
        trusted_rate = Decimal(debt_local) / Decimal(debt_usd)
    if trusted_rate is None:
        trusted_rate = valid_rate(old.get("exchangeRate"))
    if trusted_rate is None and debt_usd > 0 and debt_local > 0:
        trusted_rate = Decimal(debt_local) / Decimal(debt_usd)

    # Company coverage is stored in USD; the driver's cash math is LYD. The
    # debt's own USD/LYD ratio is the exact converter (covered money is a
    # slice of that same debt); the receipt rate is the fallback.
    covered_usd = (
        _financial_minor(old.get("companyCoveredUSD"), "stored companyCoveredUSD")
        if old.get("companyCoveredUSD") is not None
        else 0
    )
    covered_usd = max(min(covered_usd, debt_usd), 0) if debt_usd > 0 else max(covered_usd, 0)
    if covered_usd > 0:
        if debt_usd > 0 and debt_local > 0:
            covered_local = int(
                (Decimal(covered_usd) * Decimal(debt_local) / Decimal(debt_usd)).quantize(
                    Decimal("1"), rounding=ROUND_HALF_UP
                )
            )
        elif trusted_rate:
            covered_local = int(
                (Decimal(covered_usd) * trusted_rate).quantize(
                    Decimal("1"), rounding=ROUND_HALF_UP
                )
            )
        else:
            raise HTTPException(
                status_code=409,
                detail="Company-covered receipt has no usable exchange rate; office must settle it",
            )
    else:
        covered_local = 0
    # The customer only owes what the company has not already absorbed.
    outstanding_local = max(debt_local - covered_local, 0)

    over_local = collected_local - outstanding_local
    over_abs_minor = int(
        (Decimal(str(overpay_abs_local)) * Decimal(100)).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )
    debt_ceiling = int(
        (Decimal(outstanding_local) * Decimal(str(overpay_ratio))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )
    if over_local > over_abs_minor and collected_local > debt_ceiling:
        raise HTTPException(
            status_code=400,
            detail="Collected amount far exceeds the delivery debt; office confirmation required",
        )

    diff = collected_local - outstanding_local
    if diff == 0:
        payment_result = "PAID_EXACT"
        overpaid = 0
        remaining_due = 0
    elif diff > 0:
        payment_result = "OVERPAID"
        overpaid = diff
        remaining_due = 0
    else:
        payment_result = "UNDERPAID"
        overpaid = 0
        remaining_due = -diff

    if trusted_rate:
        collected_usd = int(
            (Decimal(collected_local) / trusted_rate).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
    else:
        # Preserve the historical no-rate behavior without ever treating LYD as USD.
        collected_usd = debt_usd

    merged["debtAmountUSD"] = _financial_usd(debt_usd)
    merged["debtAmountLocal"] = _financial_usd(debt_local)
    merged["amountUSD"] = _financial_usd(collected_usd)
    merged["amountLocal"] = _financial_usd(collected_local)
    if target["source"] == "linked_ads" and trusted_rate:
        merged["exchangeRate"] = float(trusted_rate)
    merged["paymentResult"] = payment_result
    merged["overpaidAmount"] = _financial_usd(overpaid)
    merged["remainingDue"] = _financial_usd(remaining_due)
    if covered_usd > 0 or old.get("customerOutstandingUSD") is not None:
        # Keep the coverage summary truthful after collection: what the
        # customer still owes is the uncollected part of THEIR share.
        if remaining_due <= 0:
            outstanding_usd_after = 0
        elif outstanding_local > 0:
            outstanding_usd_after = int(
                (
                    Decimal(remaining_due)
                    * Decimal(max(debt_usd - covered_usd, 0))
                    / Decimal(outstanding_local)
                ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            )
        else:
            outstanding_usd_after = 0
        merged["customerOutstandingUSD"] = _financial_usd(outstanding_usd_after)
    if remaining_due == 0:
        merged["status"] = "Paid"
        merged["isPaid"] = True
    else:
        merged["status"] = "Not Paid"
        merged["isPaid"] = False


def apply_coverage_settlement_truth(
    old: dict[str, Any], merged: dict[str, Any], *,
    due_total: Callable[[dict[str, Any]], int],
) -> None:
    """Keep amountUSD = CUSTOMER cash across settle/unsettle of a covered receipt.

    Settling an in-shop receipt records that the customer paid their remaining
    share — never the company's share. Without this, a covered receipt kept its
    gross amount on settle, so customer 'Paid' totals inflated by exactly the
    covered dollars. The delivery completion truth already writes collected
    cash itself, so this only acts when that path did not run.
    """
    covered_minor = (
        _financial_minor(old.get("companyCoveredUSD"), "stored companyCoveredUSD")
        if old.get("companyCoveredUSD") is not None
        else 0
    )
    if covered_minor <= 0:
        return
    delivery_truth_ran = (
        str(merged.get("deliveryStatus") or "").strip() == "Delivered"
        and str(old.get("deliveryStatus") or "").strip() != "Delivered"
    )
    if delivery_truth_ran:
        return
    old_paid = str(old.get("status") or "") == "Paid" or old.get("isPaid") is True
    new_paid = str(merged.get("status") or "") == "Paid" or merged.get("isPaid") is True
    if old_paid == new_paid:
        # Direct debt/payment edits are part of the same financial lifecycle as
        # settlement. Recompute only when relevant inputs change: a note edit
        # must not silently repair historical accounting state.
        money_fields = ("amountUSD", "amountLocal", "debtAmountUSD", "debtAmountLocal",
                        "exchangeRate", "deliveryStatus", "status", "isPaid")
        if any(old.get(field) != merged.get(field) for field in money_fields):
            if new_paid or str(merged.get("status") or "") in {"Canceled", "Lost", "Destroyed"} or str(merged.get("deliveryStatus") or "") == "Canceled":
                merged["customerOutstandingUSD"] = 0.0
            else:
                collected_minor = (
                    _financial_minor(merged.get("amountUSD"), "receipt collected amount")
                    if str(merged.get("deliveryStatus") or "") == "Delivered"
                    else 0
                )
                merged["customerOutstandingUSD"] = _financial_usd(
                    max(due_total(merged) - covered_minor - collected_minor, 0)
                )
        return

    amount_minor = _financial_minor(merged.get("amountUSD"), "receipt amount")
    local_minor = _financial_minor(merged.get("amountLocal"), "receipt amount")
    already_delivered = str(old.get("deliveryStatus") or "").strip() == "Delivered"
    if not old_paid and new_paid:
        if already_delivered:
            # amountUSD is the driver's real collected cash — leave it alone;
            # settling just declares the shortfall resolved.
            merged["customerOutstandingUSD"] = 0.0
            return
        # Settle: strip the company share out of the recorded customer money.
        new_amount_minor = max(amount_minor - covered_minor, 0)
        merged["customerOutstandingUSD"] = 0.0
    else:
        if already_delivered:
            # Unsettling a completed delivery keeps its collected cash; the
            # customer owes the gross debt minus company share minus cash.
            gross_minor = (
                _financial_minor(old.get("debtAmountUSD"), "stored receipt debt")
                if old.get("debtAmountUSD") is not None
                else amount_minor + covered_minor
            )
            merged["customerOutstandingUSD"] = _financial_usd(
                max(gross_minor - covered_minor - amount_minor, 0)
            )
            return
        # Unsettle back to debt: the pot promise becomes gross again and the
        # customer owes everything the company has not absorbed.
        new_amount_minor = amount_minor + covered_minor
        merged["customerOutstandingUSD"] = _financial_usd(
            max(new_amount_minor - covered_minor, 0)
        )
    if amount_minor > 0 and local_minor > 0:
        merged["amountLocal"] = _financial_usd(
            int(
                (
                    Decimal(local_minor) * Decimal(new_amount_minor) / Decimal(amount_minor)
                ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            )
        )
    merged["amountUSD"] = _financial_usd(new_amount_minor)
