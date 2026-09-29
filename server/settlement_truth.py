"""Server-authoritative settlement money truth for receipts.

Two pure recompute passes that run inside the receipt row lock, immediately
before persistence (main.py's atomic receipt patch):

- ``apply_delivery_completion_truth``: on the transition to Delivered,
  re-derive every money field from locked receipt/ad state. Company-covered
  dollars are netted out first — the driver only ever collects the customer's
  remaining share, so covered money can never be recovered twice.
- ``apply_coverage_settlement_truth``: on settle/unsettle/re-save of a covered
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

from .financial_core import MAX_EXCHANGE_RATE, MIN_EXCHANGE_RATE, _financial_minor, _financial_usd

# Same set as main._USD_BASED_PAYMENT_METHODS (this module cannot import main).
_USD_ROW_METHODS = frozenset({"USDT", "Bank Transfer (USD)", "Cash (USD)"})


def _row_rate2_at(row: dict[str, Any], trusted_rate: Decimal) -> float:
    """Rate 2 that makes one completion row back the dollars credited for it.

    The server credits amount x Rate 1 / trusted_rate. The client form and
    main._receipt_payments_credit_minor read a dollar row as amount x Rate 1 /
    Rate 2 but any other row as amount / Rate 2, so a Libyana row at Rate 1
    0.70 needs Rate 2 = trusted_rate / 0.70, and a row whose Rate 1 adds no
    LYD (0 or unreadable) backs no dollars (Rate 2 = 0). sanitize_json clamps
    a Rate 1 of 0 up to MIN_EXCHANGE_RATE, so that sentinel adds no LYD too,
    and a Rate 2 outside [MIN, MAX] is never written (the credit reader
    rejects the whole receipt's rows for one such row).
    """
    if str(row.get("method") or "") in _USD_ROW_METHODS:
        return float(trusted_rate)
    try:
        rate1 = Decimal(str(row.get("rate") or 0))
    except ArithmeticError:  # decimal.InvalidOperation: not a number
        return 0.0
    if not rate1.is_finite() or rate1 <= Decimal(str(MIN_EXCHANGE_RATE)):
        return 0.0
    rate2 = trusted_rate / rate1
    if not rate2.is_finite() or not Decimal(str(MIN_EXCHANGE_RATE)) <= rate2 <= Decimal(str(MAX_EXCHANGE_RATE)):
        return 0.0
    return float(rate2)


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
        # A bare status flip on a receipt already paid in the office keeps its
        # payment (the completion form's own pre-computed money still applies).
        or (str(old.get("status") or "") == "Paid" and bool(old.get("isPaid")))
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
    if trusted_rate and isinstance(merged.get("payments"), list):
        # The stored rows must reproduce the dollars credited above. A row kept
        # at the driver's default rate re-derived other money on the next
        # office edit (a no-op save raised or cut the customer's USD credit).
        merged["payments"] = [
            {**row, "rate2": _row_rate2_at(row, trusted_rate)} if isinstance(row, dict) else row
            for row in merged["payments"]
        ]
    if target["source"] == "linked_ads" and trusted_rate:
        merged["exchangeRate"] = float(trusted_rate)
    merged["paymentResult"] = payment_result
    merged["overpaidAmount"] = _financial_usd(overpaid)
    merged["remainingDue"] = _financial_usd(remaining_due)
    if True:  # always stored: an uncovered underpaid delivery used to show the FULL debt on the customer card
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


def _reads_as_gross(amount_minor: int, gross_minor: int, net_minor: int) -> bool:
    """Did the office send the GROSS (form prefill / gross payment rows) rather
    than the customer's net cash? The form derives amountUSD from payment rows,
    so a rate change or cent rounding lands a little under the gross and still
    means "the gross". When a small company share puts the net inside that
    rounding band, the exact net (give or take a house cent) stays net cash, so
    real customer money is never stripped a second time. Anything above it is
    the gross: keeping it as cash would let customer cash plus the company
    share exceed the receipt's gross (free credit nobody paid).
    """
    gross_floor = gross_minor - max(100, gross_minor // 100)
    return amount_minor >= gross_floor and amount_minor > net_minor + 1


def _row_cent_drift(payments: Any) -> int:
    """Cents a rows total can sit above the cash it records: the credit reader
    (and the client) round every positive row UP to the cent."""
    count = 0
    for entry in payments if isinstance(payments, list) else []:
        try:
            count += isinstance(entry, dict) and float(entry.get("amount") or 0) > 0
        except (TypeError, ValueError, OverflowError):
            continue
    return max(1, count)


def apply_coverage_settlement_truth(
    old: dict[str, Any], merged: dict[str, Any], *,
    due_total: Callable[[dict[str, Any]], int],
    delivery_truth_allowed: bool | None = None,
    old_rows_minor: int | None = None,
    new_rows_minor: int | None = None,
) -> None:
    """Keep amountUSD = CUSTOMER cash across settle/unsettle of a covered receipt.

    Settling an in-shop receipt records that the customer paid their remaining
    share — never the company's share. Without this, a covered receipt kept its
    gross amount on settle, so customer 'Paid' totals inflated by exactly the
    covered dollars. The delivery completion truth already writes collected
    cash itself, so this only acts when that path did not run.

    ``old_rows_minor`` is the ads credit the STORED payment rows back (main.py's
    _receipt_payments_credit_minor of old["payments"]; None = no usable rows).
    It tells a re-save of net-cash rows from one of gross-prefilled rows.
    ``new_rows_minor`` is the same reader over merged["payments"]: on a settled
    receipt the cash may grow only by what the rows grew.
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
        # The caller gates the delivery pass (only a verified completion runs
        # it); when it was skipped, the covered share still has to be netted here.
        and (delivery_truth_allowed is None or bool(delivery_truth_allowed))
    )
    if delivery_truth_ran:
        return
    old_paid = str(old.get("status") or "") == "Paid" or old.get("isPaid") is True
    new_paid = str(merged.get("status") or "") == "Paid" or merged.get("isPaid") is True
    already_delivered = str(old.get("deliveryStatus") or "").strip() == "Delivered"
    if old_paid == new_paid:
        # Direct debt/payment edits are part of the same financial lifecycle as
        # settlement. Recompute only when relevant inputs change: a note edit
        # must not silently repair historical accounting state.
        money_fields = ("amountUSD", "amountLocal", "debtAmountUSD", "debtAmountLocal",
                        "exchangeRate", "deliveryStatus", "status", "isPaid")
        if not any(old.get(field) != merged.get(field) for field in money_fields):
            return
        canceled = str(merged.get("status") or "") in {"Canceled", "Lost", "Destroyed"} or str(merged.get("deliveryStatus") or "") == "Canceled"
        if new_paid or canceled:
            merged["customerOutstandingUSD"] = 0.0
        else:
            collected_minor = (
                _financial_minor(merged.get("amountUSD"), "receipt collected amount")
                if str(merged.get("deliveryStatus") or "") == "Delivered"
                else 0
            )
            # The gross can never go under what the company already covered
            # (unassigned coverage sits on no ad row, so no capacity check sees
            # it): settling that later gave more credit than the gross.
            # Only an edit that LOWERS the gross is refused: a receipt the old
            # bug already left under its coverage must still take unrelated
            # edits (the driver accepting the job); the settle check stops it.
            new_due = due_total(merged)
            if new_due < covered_minor and new_due < due_total(old):
                raise HTTPException(
                    status_code=409,
                    detail=f"The company already covered ${_financial_usd(covered_minor):.2f} of this receipt; its amount cannot go below that",
                )
            merged["customerOutstandingUSD"] = _financial_usd(
                max(due_total(merged) - covered_minor - collected_minor, 0)
            )
        # A Paid receipt whose delivery was canceled, or that was delivered
        # after the office settled it, still has to net a gross re-save below.
        if not new_paid or str(merged.get("status") or "") in {"Canceled", "Lost", "Destroyed"}:
            return

    amount_minor = _financial_minor(merged.get("amountUSD"), "receipt amount")
    local_minor = _financial_minor(merged.get("amountLocal"), "receipt amount")
    if old_paid == new_paid:
        # Re-saving a settled covered receipt: the form re-derives amountUSD
        # from the stored (gross-prefilled) payment rows. Keeping that gross
        # next to companyCoveredUSD counted the company share twice as free
        # customer credit. Net it exactly like the settle branch below.
        old_minor = _financial_minor(old.get("amountUSD"), "stored receipt amount")
        if old_rows_minor is not None and abs(old_rows_minor - old_minor) <= 1:
            # The stored rows are the customer's NET cash (settled with net
            # rows), so a total re-derived from them is cash too: a top-up is
            # real money, and main.py's raise guard caps it at the rows.
            # Netting it stripped the company share from the customer again.
            return
        gross_minor = old_minor + covered_minor
        rows_are_gross = old_rows_minor is not None and abs(old_rows_minor - gross_minor) <= 1
        drift = _row_cent_drift(merged.get("payments"))
        capped_minor = None
        if old_rows_minor is not None and new_rows_minor is not None and amount_minor > old_minor + drift:
            # The cash grows only by what the rows grew. A rows-only PATCH
            # first (amount unchanged) and the re-derived amount second made
            # the stored rows neither net nor gross, and skipped every check.
            allowed_minor = old_minor + max(new_rows_minor - old_rows_minor, 0) + drift
            if amount_minor > allowed_minor:
                if not _reads_as_gross(amount_minor, gross_minor, old_minor):
                    raise HTTPException(
                        status_code=409,
                        detail="This receipt is partly covered by the company: record the full receipt amount or the customer's net cash",
                    )
                capped_minor = min(max(amount_minor - covered_minor, 0), allowed_minor)
        if capped_minor is not None:
            new_amount_minor = capped_minor
        else:
            if already_delivered and not rows_are_gross:
                # Driver-collected cash (its rows back the cash, or a legacy receipt
                # has no rows): only the office's gross rows are netted here.
                return
            if rows_are_gross and old_minor + drift < amount_minor < gross_minor - max(100, gross_minor // 100):
                # The stored rows are the gross, so a lower or re-rated total built
                # from them is not the customer's cash: keeping it minted up to the
                # company share as free credit. (Each net row adds up to a cent.)
                raise HTTPException(
                    status_code=409,
                    detail="This receipt is partly covered by the company: record the full receipt amount or the customer's net cash",
                )
            if rows_are_gross and amount_minor == old_minor + 1 and new_rows_minor != amount_minor:
                # The net cash plus the form's house cent: the rows do not back
                # that cent, so cash + covered would pass the gross.
                merged["amountUSD"] = _financial_usd(old_minor)
                return
            if not _reads_as_gross(amount_minor, gross_minor, old_minor):
                return
            new_amount_minor = max(amount_minor - covered_minor, 0)
    elif not old_paid and new_paid:
        if already_delivered:
            # amountUSD is the driver's real collected cash — leave it alone;
            # settling just declares the shortfall resolved.
            merged["customerOutstandingUSD"] = 0.0
            return
        # Settle: the office records either the GROSS (the form prefill) or the
        # net cash the customer actually paid. Only the gross carries the
        # company share; subtracting it from net cash destroyed real money.
        gross_minor = due_total(old)
        if gross_minor < covered_minor:
            raise HTTPException(
                status_code=409,
                detail=f"The company already covered ${_financial_usd(covered_minor):.2f} of this receipt; its amount cannot go below that",
            )
        net_expected = max(gross_minor - covered_minor, 0)
        # The form derives amountUSD from payment rows: a rate change or cent
        # rounding lands a little under the gross and still means "the gross".
        gross_floor = gross_minor - max(100, gross_minor // 100)
        # The form adds a house cent to a fractional total: net + 1 is net cash.
        if covered_minor > 0 and net_expected + 1 < amount_minor < gross_floor:
            raise HTTPException(
                status_code=409,
                detail="This receipt is partly covered by the company: record the full receipt amount or the customer's net cash",
            )
        # A small company share puts the net inside that band: the exact net
        # stays cash, anything above it is the gross.
        treat_as_gross = _reads_as_gross(amount_minor, gross_minor, net_expected)
        new_amount_minor = max(amount_minor - covered_minor, 0) if treat_as_gross else amount_minor
        merged["customerOutstandingUSD"] = 0.0
        if amount_minor == net_expected + 1 and new_rows_minor != amount_minor:
            # The house cent is not customer cash unless the rows back it:
            # keeping it stored cash + covered one cent above the gross. The
            # LYD amount is the real cash, so it is kept as typed.
            merged["amountUSD"] = _financial_usd(net_expected)
            return
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
        # customer owes everything the company has not absorbed. The form may
        # already send the gross (its payment rows); adding the company share
        # to that again charged the customer for it twice.
        old_minor = _financial_minor(old.get("amountUSD"), "stored receipt amount")
        if _reads_as_gross(amount_minor, old_minor + covered_minor, old_minor):
            new_amount_minor = amount_minor
        else:
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
