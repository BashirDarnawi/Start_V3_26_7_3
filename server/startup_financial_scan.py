"""Bounded, fail-closed scans used only by startup financial repairs."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy import text

from .db import json_loads
from .entity_projection import INLINE_MEDIA_FIELDS, _inline_media_sql_projection
from .financial_core import (
    _financial_ad_committed,
    _financial_ad_due_usage,
    _financial_ad_payment_status,
    _financial_allocation_map,
    _financial_legacy_due_receipt_id,
    _financial_minor,
    _financial_outgoing,
    _financial_receipt_transferable,
    _financial_rowless_driver_gap,
)


FINANCIAL_STARTUP_SCAN_BATCH_SIZE = 128


def active_row_batches(
    conn: Any,
    collection: str,
    *,
    dialect: str,
    batch_size: int = FINANCIAL_STARTUP_SCAN_BATCH_SIZE,
    include_deleted: bool = False,
):
    """Yield live, media-stripped rows using bounded keyset pages."""
    try:
        page_size = int(batch_size)
    except (TypeError, ValueError, OverflowError):
        page_size = FINANCIAL_STARTUP_SCAN_BATCH_SIZE
    page_size = max(1, min(page_size, 1000))
    columns = "type,id,data_json,deleted,created_at,created_by,last_modified"
    if INLINE_MEDIA_FIELDS.get(collection):
        projection = _inline_media_sql_projection(collection, dialect)
        if projection is None:
            raise RuntimeError(
                f"Inline-media projection is unavailable for database dialect {dialect!r}"
            )
        data_expression, _media_count_expression = projection
        columns = (
            f"type,id,{data_expression} AS data_json,"
            "deleted,created_at,created_by,last_modified"
        )

    after_id = ""
    deleted_filter = "" if include_deleted else " AND deleted=false"
    while True:
        rows = conn.execute(
            text(
                f"SELECT {columns} FROM entities "
                f"WHERE type=:type{deleted_filter} AND id>:after_id "
                "ORDER BY id LIMIT :limit"
            ),
            {"type": collection, "after_id": after_id, "limit": page_size},
        ).mappings().all()
        if not rows:
            return
        yield rows
        next_after_id = str(rows[-1].get("id") or "")
        if not next_after_id or next_after_id <= after_id:
            raise RuntimeError("Financial startup scan did not advance")
        after_id = next_after_id


def active_rows_for_receipt(
    conn: Any,
    receipt_id: str,
    *,
    row_batches: Any,
    row_data: Any,
) -> list[Any]:
    """Retain only rows needed for one receipt's atomic cascade plan."""
    relevant: list[Any] = []
    for batch in row_batches(conn, "ads"):
        for row in batch:
            ad = row_data(row)
            if str(ad.get("recordType") or "") == "receipt":
                continue
            committed = _financial_ad_committed(ad, receipt_id)
            due = _financial_ad_due_usage(ad, receipt_id)
            rowless_gap = _financial_rowless_driver_gap(ad, receipt_id)
            stop_baseline = ad.get("stopAllocationBaseline")
            stop_due = stop_legacy = 0
            if isinstance(stop_baseline, dict):
                stop_due = _financial_allocation_map(stop_baseline.get("due")).get(
                    receipt_id, 0
                )
                stop_legacy_id = str(
                    stop_baseline.get("dueLegacyReceiptId")
                    or _financial_legacy_due_receipt_id(ad)
                    or ""
                )
                if stop_legacy_id == receipt_id:
                    stop_legacy = _financial_minor(
                        stop_baseline.get("dueLegacy"), "stop baseline legacy due"
                    )
            refund_due = _financial_allocation_map(ad.get("refundDueBaseline")).get(
                receipt_id, 0
            )
            if committed or due or rowless_gap or stop_due or stop_legacy or refund_due:
                relevant.append(row)
    return relevant


def _ad_commitment_totals(ad: dict[str, Any]) -> dict[str, int]:
    paid_map = _financial_allocation_map(ad.get("receiptAllocations"))
    due_map = _financial_allocation_map(ad.get("dueAllocations"))
    totals = dict(paid_map)
    if due_map:
        for receipt_id, amount in due_map.items():
            totals[receipt_id] = totals.get(receipt_id, 0) + amount
    else:
        legacy_id = _financial_legacy_due_receipt_id(ad)
        if legacy_id:
            legacy_due = _financial_ad_due_usage(ad, legacy_id)
            if legacy_due:
                totals[legacy_id] = totals.get(legacy_id, 0) + legacy_due

    has_ledger = isinstance(ad.get("receiptAllocations"), list) or isinstance(
        ad.get("dueAllocations"), list
    )
    is_cash_collected = (
        _financial_ad_payment_status(ad) == "not_paid"
        and str(ad.get("collectionMethod") or "") in {"driver", "in_shop"}
    )
    if not has_ledger and not is_cash_collected:
        fallback = ad.get("spentUSD")
        if fallback is None:
            fallback = ad.get("amountUSD")
        fallback_minor = _financial_minor(fallback, "stored legacy ad amount")
        for field in ("fundingReceiptId", "receiptId", "linkedDeliveryReceiptId"):
            receipt_id = str(ad.get(field) or "")
            if receipt_id and totals.get(receipt_id, 0) <= 0:
                totals[receipt_id] = fallback_minor
    return {key: value for key, value in totals.items() if key and value > 0}


def settle_rowless_driver_receipts(
    *,
    open_transaction: Any,
    row_batches: Any,
    row_data: Any,
    financial_due_total: Any,
    patch_receipt: Any,
) -> int:
    """Heal legacy paid receipts without retaining or rescanning every ad."""

    def scan_state() -> tuple[dict[str, int], dict[str, int]]:
        gaps: dict[str, int] = {}
        commitments: dict[str, int] = {}
        with open_transaction() as conn:
            for batch in row_batches(conn, "ads"):
                for row in batch:
                    try:
                        ad = row_data(row)
                    except Exception:
                        continue
                    if str(ad.get("recordType") or "") == "receipt":
                        continue
                    for receipt_id, amount in _ad_commitment_totals(ad).items():
                        commitments[receipt_id] = commitments.get(receipt_id, 0) + amount
                    receipt_id = str(
                        ad.get("linkedDeliveryReceiptId") or ad.get("receiptId") or ""
                    )
                    if not receipt_id:
                        continue
                    try:
                        gap = _financial_rowless_driver_gap(ad, receipt_id)
                    except HTTPException:
                        continue
                    if gap > 0:
                        gaps[receipt_id] = gaps.get(receipt_id, 0) + gap
        return gaps, commitments

    candidates: list[str] = []
    try:
        receipt_gaps, committed_by_receipt = scan_state()
        with open_transaction() as conn:
            for receipt_id in sorted(receipt_gaps):
                row = conn.execute(
                    text(
                        "SELECT data_json, deleted FROM entities "
                        "WHERE type='receipts' AND id=:id"
                    ),
                    {"id": receipt_id},
                ).mappings().first()
                if not row or bool(row["deleted"]):
                    continue
                try:
                    receipt = json_loads(row["data_json"] or "{}") or {}
                except Exception:
                    continue
                if not isinstance(receipt, dict) or not _financial_receipt_transferable(
                    receipt
                ):
                    continue
                try:
                    capacity = (
                        financial_due_total(receipt)
                        - _financial_outgoing(receipt)
                        - committed_by_receipt.get(receipt_id, 0)
                    )
                except HTTPException:
                    continue
                if capacity <= 0:
                    print(
                        f"[albayan] rowless-settlement stuck {receipt_id}: "
                        "paid balance already fully used; needs manual review"
                    )
                    continue
                candidates.append(receipt_id)
    except Exception as exc:
        print(
            "[albayan] rowless-settlement scan skipped/failed: "
            f"{type(exc).__name__}: {exc}"
        )
        return 0

    healed = 0
    for receipt_id in candidates:
        try:
            scan_result: dict[str, int] = {}
            patch_receipt(
                {"id": "system"},
                receipt_id,
                {},
                None,
                _startup_bounded_ad_scan=True,
                _startup_scan_result=scan_result,
            )
            if scan_result.get("gapAfter", 0) < scan_result.get("gapBefore", 0):
                healed += 1
            else:
                print(
                    f"[albayan] rowless-settlement stuck {receipt_id}: "
                    "cascade settled nothing; needs manual review"
                )
        except HTTPException as exc:
            print(
                f"[albayan] rowless-settlement skipped {receipt_id}: "
                f"{exc.status_code} {exc.detail}"
            )
        except Exception as exc:
            print(
                f"[albayan] rowless-settlement skipped {receipt_id}: "
                f"{type(exc).__name__}: {exc}"
            )
    if healed:
        print(f"[albayan] Settled rowless driver ads on {healed} paid receipt(s)")
    return healed
