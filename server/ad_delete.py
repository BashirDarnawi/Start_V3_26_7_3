"""Ad deletion that releases the ad's server-grown receipt debt at once.

Deleting an unpaid In-Shop ad used to leave the debt it had added on the
customer's open receipt until the next restart repair. The delete now shrinks
that receipt in the same transaction, through the same calculation the stop
and the restart repair use, and refuses an ad that company funds paid for.
Everything main-owned arrives through ``ctx`` (no import of main).
"""

from contextlib import nullcontext
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text

from .company_debt_coverage import company_pool_total_minor
from .db import db_conn, now_ms
from .financial_core import _financial_ad_payment_status, _financial_minor
from .unpaid_receipt_growth import reconcile_unpaid_receipt_debt

AD_DELETE_COMPANY_FUNDED_DETAIL = (
    "An ad paid from company funds cannot be deleted; stop it instead"
)
# The "released plan": due rows emptied AND both legacy scalar mirrors cleared,
# so the array reader and the legacy reader both see zero. Never stored.
_RELEASED_DUE = {"dueAllocations": [], "dueAmountToUseUSD": 0, "dueAmountToUseLYD": 0}


def ad_delete_receipt_ids(ad: dict[str, Any], ctx: dict[str, Any]) -> set[str]:
    try:
        return set(ctx["financial_receipt_ids"](ad))
    except HTTPException:
        return set()  # a junk stored link must not make an ad undeletable


def _may_hold_managed_debt(ad: dict[str, Any]) -> bool:
    return (
        _financial_ad_payment_status(ad) == "not_paid"
        and str(ad.get("collectionMethod") or "") == "in_shop"
        and bool(str(ad.get("receiptId") or ""))
    )


def release_ad_debt_for_delete(
    conn: Any,
    actor: dict[str, Any],
    ad_id: str,
    ad: dict[str, Any],
    *,
    locked_receipts: dict[str, Any],
    ad_rows: Any,
    skip_receipt_ids: set[str] | frozenset[str] = frozenset(),
    ctx: dict[str, Any],
) -> list[str]:
    """Refuse a company-funded ad; else shrink its managed receipt. Returns written ids.

    ``ad_rows`` is a zero-argument callable so the full ads snapshot is only
    taken for an ad that can hold managed debt.
    """
    if str(ad.get("recordType") or "") == "receipt":
        return []
    if company_pool_total_minor(ad) > 0:
        raise HTTPException(status_code=409, detail=AD_DELETE_COMPANY_FUNDED_DETAIL)
    if not _may_hold_managed_debt(ad):
        return []
    usable = {
        receipt_id: row
        for receipt_id, row in locked_receipts.items()
        if row and not bool(row["deleted"]) and receipt_id not in skip_receipt_ids
    }
    try:
        prepared = reconcile_unpaid_receipt_debt(
            conn,
            actor,
            None,
            dict(_RELEASED_DUE),
            ad,
            locked_receipts=usable,
            ad_rows=ad_rows(),
            ad_id=ad_id,
            ctx=ctx,
            allow_derived_growth=False,
            require_receipt_permission=False,
        )
    except HTTPException as exc:
        if exc.status_code == 423:
            raise  # closed month: the delete is refused, nothing is written
        return []  # not a receipt the server may shrink: delete as before
    updated: list[str] = []
    for receipt_id, row, expanded, _validation_row in prepared:
        current = ctx["financial_row_data"](row)
        covered = _financial_minor(current.get("companyCoveredUSD"), "stored company coverage")
        new_minor = _financial_minor(expanded.get("amountUSD"), "released receipt amount")
        if new_minor < covered or new_minor >= ctx["financial_due_total"](current):
            continue  # never below the company share, and a delete never raises debt
        ctx["write_row"](conn, row, expanded)
        locked_receipts[receipt_id] = ctx["lock_row"](
            conn, "receipts", receipt_id, postgres=bool(ctx.get("postgres"))
        )
        updated.append(receipt_id)
    return updated


def _mark_ad_deleted(conn: Any, ad_id: str, baseline: int) -> int:
    stamp = max(now_ms(), baseline + 1)
    result = conn.execute(
        text(
            "UPDATE entities SET deleted = true, last_modified = :ts "
            "WHERE type = 'ads' AND id = :id AND last_modified = :baseline"
        ),
        {"ts": stamp, "id": ad_id, "baseline": baseline},
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="Conflict: record has changed")
    return stamp


def delete_ad_atomic(
    actor: dict[str, Any], ad_id: str, *, ctx: dict[str, Any], sqlite_guard: Any
) -> dict[str, Any]:
    """Receipts -> ad lock order (as stop and mutate); one transaction."""
    postgres = bool(ctx.get("postgres"))
    lock_row, row_data = ctx["lock_row"], ctx["financial_row_data"]
    with (nullcontext() if postgres else sqlite_guard), db_conn() as conn:
        initial = lock_row(conn, "ads", ad_id, postgres=False)
        if not initial:
            raise HTTPException(status_code=404, detail="Not found")
        receipt_ids = (
            set() if bool(initial["deleted"]) else ad_delete_receipt_ids(row_data(initial), ctx)
        )
        locked = {
            receipt_id: lock_row(conn, "receipts", receipt_id, postgres=postgres)
            for receipt_id in sorted(receipt_ids)
        }
        row = lock_row(conn, "ads", ad_id, postgres=postgres)
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        updated: list[str] = []
        if not bool(row["deleted"]):
            ad = row_data(row)
            ctx["assert_financial_period_open"]("ads", ad, conn=conn)
            if ad_delete_receipt_ids(ad, ctx) - set(locked):
                raise HTTPException(status_code=409, detail="Conflict: ad funding has changed")
            updated = release_ad_debt_for_delete(
                conn, actor, ad_id, ad, locked_receipts=locked,
                ad_rows=lambda: ctx["financial_active_rows"](conn, "ads"), ctx=ctx,
            )
        stamp = _mark_ad_deleted(conn, ad_id, int(row["last_modified"]))
    return {"lastModified": stamp, "updatedReceiptIds": updated}


def batch_ad_receipt_ids(conn: Any, ad_ids: set[str], ctx: dict[str, Any]) -> set[str]:
    """Unlocked discovery read: the receipts the batch's live ads name."""
    found: set[str] = set()
    for ad_id in sorted(ad_ids):
        row = ctx["lock_row"](conn, "ads", ad_id, postgres=False)
        if row and not bool(row["deleted"]):
            found |= ad_delete_receipt_ids(ctx["financial_row_data"](row), ctx)
    return found


def release_batch_ads_for_delete(
    conn: Any,
    actor: dict[str, Any],
    ad_ids: set[str],
    *,
    locked_receipts: dict[str, Any],
    skip_receipt_ids: set[str],
    ctx: dict[str, Any],
) -> list[str]:
    """Lock the batch's ads (sorted), then release each live one's debt.

    ``locked_receipts`` holds every receipt locked for this batch;
    ``skip_receipt_ids`` are the ones the batch itself deletes (no point
    shrinking a receipt that is tombstoned in the same transaction).
    """
    postgres = bool(ctx.get("postgres"))
    live: dict[str, dict[str, Any]] = {}
    for ad_id in sorted(ad_ids):
        row = ctx["lock_row"](conn, "ads", ad_id, postgres=postgres)
        if row and not bool(row["deleted"]):
            live[ad_id] = ctx["financial_row_data"](row)
    for ad in live.values():
        if ad_delete_receipt_ids(ad, ctx) - set(locked_receipts):
            raise HTTPException(status_code=409, detail="Conflict: ad funding has changed")
    snapshot: list[Any] | None = None

    def other_ads() -> list[Any]:
        nonlocal snapshot
        if snapshot is None:
            snapshot = [
                ad_row
                for ad_row in ctx["financial_active_rows"](conn, "ads")
                if str(ad_row.get("id") or "") not in ad_ids
            ]
        return snapshot

    updated: list[str] = []
    for ad_id in sorted(live):
        for receipt_id in release_ad_debt_for_delete(
            conn, actor, ad_id, live[ad_id], locked_receipts=locked_receipts,
            ad_rows=other_ads, skip_receipt_ids=skip_receipt_ids, ctx=ctx,
        ):
            if receipt_id not in updated:
                updated.append(receipt_id)
    return updated
