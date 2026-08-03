"""Which receipts are still referenced, and therefore cannot be deleted.

Split out of main.py to keep it under its architecture line cap.

The scanning form answers for ONE receipt by reading both the ads and the
receipts tables. That is fine for a single delete, but batch delete calls it
per item: a 500-receipt batch ran 1,000 unbounded scans inside one locked
transaction, each materializing every row's data_json with its base64 photos.
``build_receipt_reference_index`` answers the same question for every receipt
in a single pass, and the two paths are pinned as equivalent by
server/test_refund_spend_integrity.py.

Everything main-owned arrives through ``ctx`` so no logic is duplicated.
"""

from typing import Any

from .financial_core import _financial_outgoing


def build_receipt_reference_index(conn: Any, ctx: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Map receipt id -> reason it is referenced, built in ONE pass.

    Precedence must match the scanning path below: ad funding first, then
    transfer links.
    """
    active_rows = ctx["financial_active_rows"]
    row_data = ctx["financial_row_data"]
    receipt_ids = ctx["financial_receipt_ids"]

    funded: dict[str, str] = {}
    for ad_row in active_rows(conn, "ads"):
        for rid in receipt_ids(row_data(ad_row)):
            funded.setdefault(str(rid), "ad funding")

    linked: dict[str, str] = {}
    for other_row in active_rows(conn, "receipts"):
        other_id = str(other_row.get("id") or "")
        other = row_data(other_row)
        source_id = str(other.get("transferFromReceiptId") or "")
        if source_id and source_id != other_id:
            linked.setdefault(source_id, "linked transfer receipt")
        for transfer in other.get("transfers") or []:
            if isinstance(transfer, dict):
                target = str(transfer.get("toReceiptId") or "")
                if target and target != other_id:
                    linked.setdefault(target, "linked transfer")
    return {"funded": funded, "linked": linked}


def receipt_reference_reason(
    conn: Any,
    ctx: dict[str, Any],
    receipt_id: str,
    data: dict[str, Any] | None = None,
    reference_index: dict[str, dict[str, str]] | None = None,
) -> str | None:
    """Why this receipt cannot be deleted, or None when it is free."""
    receipt = data
    if receipt is None:
        row = ctx["clothes_lock_row"](conn, "receipts", receipt_id, postgres=False)
        if not row or bool(row["deleted"]):
            return None
        receipt = ctx["financial_row_data"](row)
    if _financial_outgoing(receipt) > 0:
        return "outgoing transfer"
    if str(receipt.get("receiptType") or "") == "TRANSFER_IN" or receipt.get("transferFromReceiptId"):
        return "incoming transfer"
    if reference_index is not None:
        return (
            reference_index["funded"].get(receipt_id)
            or reference_index["linked"].get(receipt_id)
        )
    active_rows = ctx["financial_active_rows"]
    row_data = ctx["financial_row_data"]
    for ad_row in active_rows(conn, "ads"):
        if receipt_id in ctx["financial_receipt_ids"](row_data(ad_row)):
            return "ad funding"
    for other_row in active_rows(conn, "receipts"):
        if str(other_row.get("id") or "") == receipt_id:
            continue
        other = row_data(other_row)
        if str(other.get("transferFromReceiptId") or "") == receipt_id:
            return "linked transfer receipt"
        for transfer in other.get("transfers") or []:
            if isinstance(transfer, dict) and str(transfer.get("toReceiptId") or "") == receipt_id:
                return "linked transfer"
    return None
