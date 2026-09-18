"""Conservative mutation-time compatibility for settled receipt relinks."""

from typing import Any

from fastapi import HTTPException

from .financial_core import (
    _financial_ad_direct_coverage,
    _financial_ad_payment_status,
    _financial_allocation_map,
    _financial_minor,
    _financial_rows_from_allocation_map,
)


def settled_relink_stop_baseline(
    ad: dict[str, Any], baseline: dict[str, Any], *, strict: bool = True
) -> dict[str, Any]:
    """Convert a stale unpaid baseline only when its paid mapping is certain.

    Old relink-settlements moved current funding to paid receipts but left the
    original stop baseline in the unpaid pool. A later spend correction then
    resurrected customer debt. Keep the original customer budget, while using
    the one receipt explicitly selected for settlement. If several receipts
    now fund a partially spent ad, the original split is unknown: never invent
    it from current proportions or rates. A relink can still complete, but a
    later spend correction requires review in that ambiguous historical case.

    This pure helper runs only in authorized money mutations, never on reads
    or at startup. It does not alter receipt amounts, rates or company money.
    """
    if (
        _financial_ad_payment_status(ad) != "paid"
        or _financial_ad_payment_status({"paymentStatus": baseline.get("paymentStatus")}) != "not_paid"
    ):
        return baseline

    paid = _financial_allocation_map(ad.get("receiptAllocations"))
    due = _financial_allocation_map(ad.get("dueAllocations"))
    company = sum(_financial_allocation_map(ad.get("companyFundingAllocations")).values()) + _financial_ad_direct_coverage(ad)
    paid_total = sum(paid.values())
    spent = _financial_minor(ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD"), "stored settled ad spend")
    total = sum(_financial_allocation_map(baseline.get("receipt")).values()) + sum(_financial_allocation_map(baseline.get("due")).values()) + _financial_minor(baseline.get("dueLegacy"), "stored stop legacy baseline")
    certain = (
        not due
        and _financial_minor(ad.get("dueAmountToUseUSD"), "stored due mirror") == 0
        and _financial_minor(ad.get("dueAmountToUseLYD"), "stored due mirror") == 0
        and paid_total + company == spent
        and total >= paid_total
        and (len(paid) == 1 or total == paid_total)
    )
    if not certain:
        if strict:
            raise HTTPException(
                status_code=409,
                detail="The settled ad's original funding split needs review before changing final spend; no money was changed",
            )
        return baseline

    paid_baseline = {next(iter(paid)): total} if len(paid) == 1 else paid
    return {
        **baseline,
        "receipt": _financial_rows_from_allocation_map(paid_baseline),
        "due": [],
        "merged": [],
        "dueLegacy": 0.0,
        "dueLegacyReceiptId": "",
        "paymentStatus": "paid",
    }
