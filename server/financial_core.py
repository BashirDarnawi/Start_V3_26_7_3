"""Pure, side-effect-free financial reader helpers.

Extracted from server/main.py (which sat at its architecture-guard size cap)
so settlement logic has a focused home. Every function operates on plain
dicts — no database, no request context — and mirrors the frontend's money
readers. main.py imports these names back; the moved functions behave exactly
as before. One function is NEW here rather than moved:
_financial_rowless_driver_gap (see its docstring).
"""

import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from fastapi import HTTPException

MAX_FINANCIAL_AMOUNT = 10_000_000  # $10 million max for any single amount
MAX_EXCHANGE_RATE = 1000  # Maximum exchange rate (LYD per USD)
MIN_EXCHANGE_RATE = 0.001  # Minimum exchange rate


def _financial_minor(value: Any, field: str, *, allow_zero: bool = True) -> int:
    """Convert a stored/requested USD value to exact cents."""
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail=f"{field} must be a money amount")
    try:
        amount = Decimal(str(0 if value is None or value == "" else value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    if not amount.is_finite() or amount < 0 or amount > Decimal(str(MAX_FINANCIAL_AMOUNT)):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    minor = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if not allow_zero and minor <= 0:
        raise HTTPException(status_code=400, detail=f"{field} must be greater than zero")
    return minor


def _financial_usd(minor: int) -> float:
    return float((Decimal(int(minor)) / Decimal(100)).quantize(Decimal("0.01")))


def _financial_outgoing(data: dict[str, Any]) -> int:
    transfers = data.get("transfers")
    if transfers is None:
        return 0
    if not isinstance(transfers, list):
        raise HTTPException(status_code=409, detail="Stored receipt transfers are invalid")
    total = 0
    for transfer in transfers:
        if not isinstance(transfer, dict):
            raise HTTPException(status_code=409, detail="Stored receipt transfer is invalid")
        total += _financial_minor(transfer.get("amountUSD"), "stored transfer")
    return total


def _financial_rows_from_allocation_map(values: dict[str, int]) -> list[dict[str, Any]]:
    """Return deterministic, exact-cent allocation rows from a minor-unit map."""
    return [
        {"receiptId": receipt_id, "amountUSD": _financial_usd(amount)}
        for receipt_id, amount in sorted(values.items())
        if amount > 0
    ]


def _financial_ad_effective_amount(ad: dict[str, Any]) -> int:
    """Amount that still needs funding after stop/refund reconciliation."""
    value = ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD")
    return _financial_minor(value, "ad settlement amount")


def _financial_receipt_transferable(data: dict[str, Any]) -> bool:
    status = str(data.get("status") or "")
    return status not in {"Canceled", "Lost", "Destroyed"} and (
        status == "Paid" or data.get("isPaid") is True
    )


def _financial_destroyed_receipt_create_error(data: dict[str, Any]) -> str | None:
    """Reject any DESTROYED receipt that is more than a locked number.

    A destroyed receipt records a torn, never-used paper receipt: only its
    number may carry meaning, so nobody can ever record a payment with it.
    Any money, customer, payment or delivery field would let the locked
    number re-enter the books later.
    """
    if str(data.get("status") or "") != "Destroyed":
        return None
    number = str(data.get("finalReceiptNo") or "").strip() or str(
        data.get("serialNumber") or ""
    ).strip()
    if not number:
        return "A destroyed receipt needs the paper receipt number"
    if data.get("isPaid"):
        return "A destroyed receipt cannot be paid"
    if str(data.get("customerId") or "").strip():
        return "A destroyed receipt cannot belong to a customer"
    if str(data.get("tempReceiptNo") or "").strip():
        return "A destroyed receipt cannot use a delivery temp number"
    if str(data.get("deliveryStatus") or "").strip() or str(data.get("deliveryPersonId") or "").strip():
        return "A destroyed receipt cannot have a delivery"
    for key in ("amountUSD", "amountLocal", "debtAmountUSD", "debtAmountLocal"):
        if _financial_minor(data.get(key), "destroyed receipt amount") != 0:
            return "A destroyed receipt cannot hold money"
    if isinstance(data.get("payments"), list) and data.get("payments"):
        return "A destroyed receipt cannot hold payments"
    return None


def _financial_rate(value: Any) -> Decimal:
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        rate = Decimal(1)
    if not rate.is_finite() or rate <= 0 or rate > Decimal(str(MAX_EXCHANGE_RATE)):
        rate = Decimal(1)
    return rate


def _financial_ad_payment_status(ad: dict[str, Any] | None) -> str:
    """Return the canonical payment state for current and historical ads.

    ``paymentStatus`` is authoritative when it contains a recognized value.
    Older imports used spaces, hyphens, ``unpaid`` and typographic apostrophes,
    while still older rows only have the compatibility ``isPaid`` boolean.
    Records predating both fields were created before unpaid ads existed, so
    their historical default remains Paid.
    """
    data = ad if isinstance(ad, dict) else {}
    raw_status = str(data.get("paymentStatus") or "").strip().lower()
    normalized = re.sub(r"[‘’']", "", raw_status)
    normalized = re.sub(r"[\s-]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)

    if normalized == "paid":
        return "paid"
    if normalized in {"not_paid", "notpaid", "unpaid"}:
        return "not_paid"
    if normalized in {"wont_pay", "wontpay"}:
        return "wont_pay"

    is_paid = data.get("isPaid")
    if isinstance(is_paid, bool):
        return "paid" if is_paid else "not_paid"
    return "paid"


def _financial_allocation_map(raw: Any) -> dict[str, int]:
    result: dict[str, int] = {}
    if not isinstance(raw, list):
        return result
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        receipt_id = str(entry.get("receiptId") or "")
        if not receipt_id:
            continue
        result[receipt_id] = result.get(receipt_id, 0) + _financial_minor(
            entry.get("amountUSD"), "stored allocation"
        )
    return result


def _financial_legacy_due_receipt_id(ad: dict[str, Any]) -> str:
    """Receipt represented by the scalar dueAmountToUse* legacy mirror.

    Delivery rows historically used linkedDeliveryReceiptId.  In-Shop rows
    used receiptId instead, so treating the driver field as the only identity
    loses real customer debt when old rows are stopped, refunded or restored.
    The oldest driver rows predate linkedDeliveryReceiptId entirely and stored
    the delivery receipt in receiptId; the settlement predicate and the ad
    form both honor that fallback, so the due reader must speak for the same
    money — otherwise capacity checks ignore a promise settlement converts.
    """
    if _financial_ad_payment_status(ad) == "not_paid":
        method = str(ad.get("collectionMethod") or "")
        if method == "in_shop":
            return str(ad.get("receiptId") or "")
        if method == "driver" and not str(ad.get("linkedDeliveryReceiptId") or ""):
            return str(ad.get("receiptId") or "")
    return str(ad.get("linkedDeliveryReceiptId") or "")


def _financial_ad_general_usage(ad: dict[str, Any], receipt_id: str) -> int:
    """Mirror getReceiptUsageStats, including legacy records."""
    receipt_map = _financial_allocation_map(ad.get("receiptAllocations"))
    receipt_sum = receipt_map.get(receipt_id, 0)
    explicit = (
        receipt_sum
        + _financial_ad_due_usage(ad, receipt_id)
        + _financial_ad_company_usage(ad, receipt_id)
    )
    if explicit > 0:
        return explicit
    if (
        isinstance(ad.get("receiptAllocations"), list)
        or isinstance(ad.get("dueAllocations"), list)
        or isinstance(ad.get("companyFundingAllocations"), list)
    ):
        return 0
    references = {
        str(ad.get("fundingReceiptId") or ""),
        str(ad.get("receiptId") or ""),
        str(ad.get("linkedDeliveryReceiptId") or ""),
    }
    if receipt_id not in references:
        return 0
    fallback = ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD")
    return _financial_minor(fallback, "stored legacy ad amount")


def _financial_ad_due_usage(ad: dict[str, Any], receipt_id: str) -> int:
    due_map = _financial_allocation_map(ad.get("dueAllocations"))
    due = due_map.get(receipt_id, 0)
    if due > 0:
        return due
    # The scalar mirror is standalone money ONLY for rowless ads. Once due
    # rows exist the writers keep dueAmountToUse* equal to their sum, so
    # attributing it to the linked receipt as well would count the same
    # dollars on two receipts at once.
    if due_map:
        return 0
    if _financial_legacy_due_receipt_id(ad) != receipt_id:
        return 0
    direct = _financial_minor(ad.get("dueAmountToUseUSD"), "stored due allocation")
    if direct:
        return direct
    local = _financial_minor(ad.get("dueAmountToUseLYD"), "stored due allocation")
    if not local:
        return 0
    return int(
        (Decimal(local) / _financial_rate(ad.get("exchangeRate"))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def _financial_ad_company_usage(ad: dict[str, Any], receipt_id: str) -> int:
    """Pot money on this receipt that the COMPANY paid for this ad.

    Company coverage moves an ad's due row into companyFundingAllocations:
    same dollars in the pot, different payer. If capacity checks ignored this
    pool, every covered dollar would look free again and could be committed
    to a second ad while the customer only ever owed it once.
    """
    return _financial_allocation_map(ad.get("companyFundingAllocations")).get(receipt_id, 0)


def _financial_ad_direct_coverage(ad: dict[str, Any]) -> int:
    """Company money covering this ad's RECEIPT-LESS spend (customer-level
    coverage). Not receipt-pot money — never part of any receipt's committed
    sum — but it counts as provided funding when deciding fully_funded."""
    if ad.get("companyDirectCoverageUSD") is None:
        return 0
    return _financial_minor(
        ad.get("companyDirectCoverageUSD"), "stored companyDirectCoverageUSD"
    )


def _financial_ad_explicit_usage(ad: dict[str, Any], receipt_id: str) -> int:
    """Money this ad EXPLICITLY commits against a receipt, from any pool.

    Allocation rows (paid + due + company-funded) plus the legacy due mirror, which only
    speaks for an ad that has no due row for this receipt. Unlike
    _financial_ad_general_usage there is NO whole-ad fallback: that fallback charges a
    pre-allocation ad's entire spend against any receipt it merely REFERENCES, and a
    driver-collected ad references its delivery receipt while being funded by the
    customer's cash, not by the receipt's credit.
    """
    paid_rows = _financial_allocation_map(ad.get("receiptAllocations")).get(receipt_id, 0)
    # The due reader covers modern allocation rows plus both historical debt
    # mirrors: driver links used linkedDeliveryReceiptId, while old In-Shop
    # rows used receiptId.  Positive legacy debt is a real commitment; a bare
    # zero-debt link remains provenance only.
    return (
        paid_rows
        + _financial_ad_due_usage(ad, receipt_id)
        + _financial_ad_company_usage(ad, receipt_id)
    )


def _financial_ad_committed(ad: dict[str, Any], receipt_id: str) -> int:
    """The money this ad TRULY commits against a receipt — the number the capacity
    check must count for every OTHER ad.

    Explicit rows + due mirror first (that already covers modern and legacy-due ads).
    Only a ROWLESS, genuinely receipt-funded ad falls back to its whole spend. A
    not_paid/driver ad is excluded from that fallback: its receiptId points at the
    delivery receipt for linkage, but it is funded by the customer's CASH, so charging
    its amountUSD here would be the same phantom commitment the due reader had to drop.
    Sits between _financial_ad_explicit_usage (misses legacy PAID ads -> lets a self-draw
    through) and _financial_ad_general_usage (charges cash-driver ads -> false-blocks).
    """
    explicit = _financial_ad_explicit_usage(ad, receipt_id)
    if explicit > 0:
        return explicit
    if (
        isinstance(ad.get("receiptAllocations"), list)
        or isinstance(ad.get("dueAllocations"), list)
        or isinstance(ad.get("companyFundingAllocations"), list)
    ):
        return 0
    if _financial_ad_payment_status(ad) == "not_paid" and str(ad.get("collectionMethod") or "") in {"driver", "in_shop"}:
        return 0
    references = {
        str(ad.get("fundingReceiptId") or ""),
        str(ad.get("receiptId") or ""),
        str(ad.get("linkedDeliveryReceiptId") or ""),
    }
    if receipt_id not in references:
        return 0
    fallback = ad.get("spentUSD") if ad.get("spentUSD") is not None else ad.get("amountUSD")
    return _financial_minor(fallback, "stored legacy ad amount")


def _financial_rowless_driver_gap(ad: dict[str, Any], receipt_id: str) -> int:
    """The UNFUNDED remainder of a not_paid driver ad linked to this delivery
    receipt with no due row for it — the live Meta-import shape.

    The ad's money is the customer's cash the driver collects through the
    delivery receipt: while the receipt is unpaid this is provenance, not a
    commitment (see _financial_ad_committed). The moment the receipt is PAID,
    that collected cash IS the receipt's balance, so settlement must convert
    this remainder into an explicit paid allocation — otherwise the receipt
    re-offers money that already belongs to its own linked ads.
    """
    if _financial_ad_payment_status(ad) != "not_paid":
        return 0
    if str(ad.get("collectionMethod") or "") != "driver":
        return 0
    if str(ad.get("linkedDeliveryReceiptId") or ad.get("receiptId") or "") != receipt_id:
        return 0
    # Only the MODERN writer shape (allocation arrays present, possibly empty)
    # qualifies. A pre-allocation legacy ad with no ledger keys at all keeps
    # its provenance-only meaning: its amount/spend fields are unreliable and
    # settling from them would mint money (pinned by the hardening tests).
    if not isinstance(ad.get("receiptAllocations"), list) and not isinstance(ad.get("dueAllocations"), list):
        return 0
    if _financial_allocation_map(ad.get("dueAllocations")):
        return 0
    if _financial_ad_due_usage(ad, receipt_id) > 0:
        return 0
    # EXACTLY the settlement side's amount basis (_financial_ad_effective_amount:
    # spentUSD, else amountUSD — nothing else), so the discovery predicate and
    # the settled amount can never diverge. driverBudgetUSD is a request-only
    # transient the writer never persists, so it must not widen discovery here.
    target = ad.get("spentUSD")
    if target is None:
        target = ad.get("amountUSD")
    target_minor = _financial_minor(target, "stored driver ad amount")
    # Company money already applied to this ad is provided funding too: the
    # coverage ledger recorded it as an expense, so the settle cascade must
    # never re-plan those dollars as customer cash and discovery must never
    # re-offer them. Counting only customer rows here wrote company coverage
    # into receiptAllocations at settle and left phantom debt on the card.
    funded = (
        sum(_financial_allocation_map(ad.get("receiptAllocations")).values())
        + _financial_allocation_map(ad.get("companyFundingAllocations")).get(receipt_id, 0)
        + _financial_ad_direct_coverage(ad)
    )
    return max(target_minor - funded, 0)
