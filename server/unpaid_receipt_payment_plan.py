"""Canonical storage for uncollected Not Paid In-Shop receipt plans.

Historically one version of the receipt form put the *planned* LYD bank
transfer row in ``payments``.  The rest of the financial system correctly
treats ``payments`` as money already collected, so those receipts disappeared
from the unpaid-receipt picker.  This module repairs only the one legacy shape
whose values prove that the row is the receipt's plan, not a collection.
"""

from contextlib import nullcontext
from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from typing import Any

from fastapi import HTTPException


NORMALIZATION_VERSION = "unpaid-in-shop-plan-v1"
_LYD_BANK_TRANSFER = "Bank Transfer (LYD)"
_OFFICE_VALUES = {"office", "shop", "in shop", "in-shop", "in_shop"}
_TRANSFER_FIELDS = {
    "transferFromReceiptId", "transferFromCustomerId", "sourceReceiptId",
    "sourceCustomerId", "toReceiptId", "toCustomerId",
}
_COLLECTION_FIELDS = {
    "collectionDate", "collectedAt", "paidAt", "receivedAt", "settledAt",
    "paymentReceivedAt", "collectorId", "collectedBy", "settledBy",
    "transactionId", "paymentReference", "bankReference",
    "providerTransactionId", "receiptReference",
}
_TRANSFER_AMOUNT_FIELDS = {
    "transferredAmount", "transferredUSD", "outgoingTransferTotalUSD",
    "amountTransferred", "transferAmountUSD",
}


def _decimal(value: Any) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _money_equal(left: Any, right: Any) -> bool:
    a, b = _decimal(left), _decimal(right)
    if a is None or b is None:
        return False
    return a.quantize(Decimal("0.01")) == b.quantize(Decimal("0.01"))


def _rate_equal(left: Any, right: Any) -> bool:
    a, b = _decimal(left), _decimal(right)
    return bool(a is not None and b is not None and abs(a - b) <= Decimal("0.0001"))


def _is_target_receipt(receipt: dict[str, Any]) -> bool:
    detail = receipt.get("statusDetail")
    detail = detail if isinstance(detail, dict) else {}
    collection = str(detail.get("notPaidCollection") or "").strip().lower()
    delivery_status = str(receipt.get("deliveryStatus") or "").strip().lower()
    receipt_type = str(receipt.get("receiptType") or "").strip().upper()
    in_shop = collection in _OFFICE_VALUES or (not collection and delivery_status == "office")
    return bool(
        str(receipt.get("status") or "").strip().lower() == "not paid"
        and receipt.get("isPaid") is not True
        and in_shop
        and delivery_status in {"", "office"}
        and receipt_type not in {"TRANSFER_IN", "DELIVERY_TEMP"}
        and not str(receipt.get("tempReceiptNo") or "").strip()
    )


def _has_collection_or_transfer_evidence(receipt: dict[str, Any], row: dict[str, Any]) -> bool:
    if receipt.get("isReceivedInOffice") is True:
        return True
    # A short-lived legacy form stamped a generic top-level collectionDate on
    # every receipt, including explicit Not Paid receipts.  On its own that
    # date is not proof of collection.  Keep every stronger receipt marker,
    # and keep *row-level* collectionDate as hard evidence because that dates
    # the individual payment rather than the receipt form submission.
    receipt_collection_fields = _COLLECTION_FIELDS - {"collectionDate"}
    if any(
        str(receipt.get(field) or "").strip()
        for field in receipt_collection_fields | _TRANSFER_FIELDS
    ):
        return True
    if any(str(row.get(field) or "").strip() for field in _COLLECTION_FIELDS | _TRANSFER_FIELDS):
        return True
    if isinstance(receipt.get("transfers"), list) and receipt.get("transfers"):
        return True
    for field in _TRANSFER_AMOUNT_FIELDS:
        value = _decimal(receipt.get(field))
        if value is not None and value != 0:
            return True
    row_status = str(row.get("status") or "").strip().lower()
    if row_status in {"paid", "collected", "received", "settled", "complete", "completed"}:
        return True
    return False


def _legacy_plan_evidence(receipt: dict[str, Any]) -> tuple[bool, str]:
    """Prove the one-row LYD pseudo-payment shape without guessing."""
    if not _is_target_receipt(receipt):
        return False, "not a Not Paid In-Shop receipt"
    payments = receipt.get("payments")
    planned = receipt.get("plannedPayments")
    if not isinstance(payments, list) or len(payments) != 1:
        return False, "requires exactly one legacy payment row"
    if planned not in (None, []) or (planned is not None and not isinstance(planned, list)):
        return False, "already has a payment plan"
    history = receipt.get("editHistory")
    if history not in (None, []) or (history is not None and not isinstance(history, list)):
        return False, "has edit-history evidence"
    row = payments[0]
    if not isinstance(row, dict):
        return False, "payment row is invalid"
    if (
        str(row.get("method") or "").strip() != _LYD_BANK_TRANSFER
        or str(receipt.get("paymentMethod") or "").strip() != _LYD_BANK_TRANSFER
    ):
        return False, "not the legacy LYD bank-transfer shape"
    amount = _decimal(row.get("amount"))
    rate = _decimal(row.get("rate"))
    rate2 = _decimal(row.get("rate2"))
    if amount is None or amount <= 0 or rate is None or rate not in {Decimal("0"), Decimal("0.001")}:
        return False, "legacy amount or rate is not exact"
    if rate2 is None or rate2 <= 0 or not _rate_equal(receipt.get("exchangeRate"), rate2):
        return False, "Rate 2 does not match the receipt"
    # Mirrors the historical form: round the row upward to cents and, when
    # non-integral, apply its customer-favouring extra cent to the total.
    expected_minor = int((amount / rate2 * 100).to_integral_value(rounding=ROUND_CEILING))
    if expected_minor % 100:
        expected_minor += 1
    if not _money_equal(receipt.get("amountUSD"), Decimal(expected_minor) / 100):
        return False, "USD total does not prove the row"
    # The affected legacy form stored LYD amountLocal as the entered LYD row.
    # Also accept zero, used by a short-lived build with a zero Rate 1.
    if not (_money_equal(receipt.get("amountLocal"), amount) or _money_equal(receipt.get("amountLocal"), 0)):
        return False, "LYD total does not prove the row"
    if _has_collection_or_transfer_evidence(receipt, row):
        return False, "contains collection or transfer evidence"
    return True, "exact legacy planned LYD bank-transfer row"


def normalize_receipt_paid_pair(old: dict[str, Any], updates: dict[str, Any]) -> None:
    """Keep receipt status/isPaid canonical for generic and dedicated paths."""
    explicit_status = "status" in updates
    explicit_paid = "isPaid" in updates
    requested_status = str(updates.get("status") or "") if explicit_status else ""
    requested_paid = updates.get("isPaid") if explicit_paid else None
    if explicit_paid and not isinstance(requested_paid, bool):
        raise HTTPException(status_code=400, detail="Receipt isPaid must be true or false")
    if explicit_status and explicit_paid:
        contradictory = (
            (requested_status == "Paid" and requested_paid is not True)
            or (requested_status == "Not Paid" and requested_paid is not False)
        )
        if contradictory:
            raise HTTPException(
                status_code=400, detail="Receipt status and isPaid must agree"
            )
    if explicit_status:
        if requested_status == "Paid":
            updates["isPaid"] = True
        elif requested_status == "Not Paid":
            updates["isPaid"] = False
    elif explicit_paid:
        if requested_paid is True:
            updates["status"] = "Paid"
        else:
            old_status = str(old.get("status") or "")
            updates["status"] = (
                old_status
                if old_status in {"Not Paid", "Canceled", "Lost", "Destroyed"}
                else "Not Paid"
            )


def enforce_explicit_paid_to_debt_conversion(
    old: dict[str, Any], merged: dict[str, Any], *, explicit_conversion: bool
) -> None:
    """Forbid a normal edit from reclassifying an already-paid receipt."""
    old_was_paid = (
        str(old.get("status") or "").strip().lower() == "paid"
        or old.get("isPaid") is True
    )
    merged_stays_paid = (
        str(merged.get("status") or "").strip().lower() == "paid"
        or merged.get("isPaid") is True
    )
    if old_was_paid and not merged_stays_paid and not explicit_conversion:
        raise HTTPException(
            status_code=409,
            detail=(
                "A Paid receipt cannot be changed to Not Paid with a normal edit. "
                "Use the dedicated receipt debt-conversion action."
            ),
        )


def canonicalize_unpaid_in_shop_payment_plan(
    data: dict[str, Any], *, source: str = "write", now_iso: str | None = None
) -> tuple[dict[str, Any], bool]:
    """Return canonical receipt data or reject ambiguous collected money.

    The caller must invoke this at the final persistence boundary.  Values are
    copied byte-for-byte between arrays; only their accounting classification
    changes.
    """
    receipt = deepcopy(data)
    if not _is_target_receipt(receipt):
        return receipt, False
    payments = receipt.get("payments")
    planned = receipt.get("plannedPayments")
    if payments is None:
        payments = []
        receipt["payments"] = []
    if not isinstance(payments, list):
        raise HTTPException(status_code=409, detail="Stored receipt payment information is invalid")
    if planned is not None and not isinstance(planned, list):
        raise HTTPException(status_code=409, detail="Stored receipt payment plan is invalid")
    if not payments:
        return receipt, False
    proven, reason = _legacy_plan_evidence(receipt)
    if not proven:
        raise HTTPException(
            status_code=409,
            detail=(
                "Not Paid In-Shop receipts cannot contain collected payment rows. "
                "Use plannedPayments for an uncollected payment plan; manual review is required "
                f"for this record ({reason})."
            ),
        )
    receipt["plannedPayments"] = deepcopy(payments)
    receipt["payments"] = []
    stamp = str(now_iso or "")
    receipt["unpaidPaymentPlanNormalization"] = {
        "version": NORMALIZATION_VERSION,
        "source": str(source or "write")[:40],
        "normalizedAt": stamp,
    }
    if source != "create":
        history = list(receipt.get("editHistory") or [])
        history.append(
            {
                "editedAt": stamp,
                "editedBy": "System startup repair" if source == "startup" else "System canonicalization",
                "changes": [
                    {
                        "field": "Payment Classification",
                        "from": "Legacy payments row",
                        "to": "Uncollected plannedPayments row",
                    }
                ],
            }
        )
        receipt["editHistory"] = history
        receipt["editCount"] = len(history)
    return receipt, True


def repair_legacy_unpaid_receipt_payment_plans(conn: Any, *, ctx: dict[str, Any]) -> dict[str, int]:
    """Repair only mathematically proven legacy rows under receipt locks."""
    stats = {"scanned": 0, "repaired": 0, "skipped": 0, "failed": 0}
    financial_active_row_batches = ctx.get("financial_active_row_batches")
    if callable(financial_active_row_batches):
        discovery_batches = financial_active_row_batches(conn, "receipts")
    else:
        # Compatibility for focused callers with the older injected context.
        discovery_batches = (ctx["financial_active_rows"](conn, "receipts"),)
    candidate_ids: set[str] = set()
    for rows in discovery_batches:
        for row in rows:
            try:
                receipt = ctx["financial_row_data"](row)
                if _is_target_receipt(receipt) and isinstance(receipt.get("payments"), list) and receipt.get("payments"):
                    receipt_id = str(row.get("id") or "")
                    if receipt_id:
                        candidate_ids.add(receipt_id)
            except Exception:
                continue
    postgres = bool(ctx.get("postgres"))
    for receipt_id in sorted(candidate_ids):
        try:
            row = ctx["lock_row"](conn, "receipts", receipt_id, postgres=postgres)
            stats["scanned"] += 1
            if not row or bool(row["deleted"]):
                stats["skipped"] += 1
                continue
            before = ctx["financial_row_data"](row)
            proven, _ = _legacy_plan_evidence(before)
            if not proven:
                stats["skipped"] += 1
                continue
            after, changed = canonicalize_unpaid_in_shop_payment_plan(
                before, source="startup", now_iso=ctx["iso_utc"]()
            )
            if not changed:
                stats["skipped"] += 1
                continue
            ctx["assert_financial_period_open"]("receipts", before, conn=conn)
            ctx["assert_financial_period_open"]("receipts", after, conn=conn)
            ctx["write_row"](conn, row, after)
            stats["repaired"] += 1
        except Exception as exc:
            stats["failed"] += 1
            detail = getattr(exc, "detail", str(exc))
            print(
                f"[albayan] unpaid payment-plan repair skipped {receipt_id}: "
                f"{type(exc).__name__}: {detail}"
            )
    return stats


def run_legacy_unpaid_receipt_payment_plan_backfill(
    *, open_transaction: Any, sqlite_guard: Any, ctx_factory: Any
) -> dict[str, int]:
    """Own the startup transaction; a migration failure must never stop boot."""
    try:
        ctx = ctx_factory()
        guard = nullcontext() if bool(ctx.get("postgres")) else sqlite_guard
        with guard, open_transaction() as conn:
            stats = repair_legacy_unpaid_receipt_payment_plans(conn, ctx=ctx)
    except Exception as exc:
        print(
            "[albayan] unpaid receipt payment-plan backfill failed: "
            f"{type(exc).__name__}: {exc}"
        )
        return {"scanned": 0, "repaired": 0, "skipped": 0, "failed": 1}
    if stats["repaired"]:
        print(
            "[albayan] Normalized legacy unpaid payment plans on "
            f"{stats['repaired']} receipt(s)"
        )
    return stats
