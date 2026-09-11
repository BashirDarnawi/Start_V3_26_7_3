"""Atomic debt reconciliation for reusable unpaid In-Shop receipts.

This module is split out of ``main.py`` to keep the route module below its
architecture line cap.  It contains only the focused validation/calculation
step: locking and writes remain owned by the caller's existing transaction.

Everything main-owned arrives through ``ctx`` so the behavior stays shared
with the rest of the financial system without circular imports or duplicated
helpers.
"""

from contextlib import nullcontext
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from fastapi import HTTPException

from .financial_core import (
    _financial_ad_company_usage,
    _financial_ad_due_usage,
    _financial_ad_payment_status,
    _financial_allocation_map,
    _financial_legacy_due_receipt_id,
    _financial_minor,
    _financial_outgoing,
    _financial_usd,
)


UNPAID_RECEIPT_DEBT_INCREASE_FIELD = "unpaidReceiptDebtIncrease"


def _history_money_minor(raw: Any) -> int | None:
    text = str(raw or "").strip().replace("$", "").replace(",", "")
    if not text:
        return None
    try:
        value = (Decimal(text) * Decimal("100")).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    except Exception:
        return None
    minor = int(value)
    return minor if minor >= 0 else None


def _proven_manual_debt_base_minor(receipt: dict[str, Any]) -> int | None:
    """Return the debt that predates managed growth, when history proves it.

    ``None`` is intentionally different from zero: without a matching history
    event there is no safe way to distinguish genuine manual debt from a
    server-managed total, so startup repair must leave the receipt untouched.
    """
    history = receipt.get("editHistory")
    if not isinstance(history, list):
        return None
    for event in history:
        changes = event.get("changes") if isinstance(event, dict) else None
        if not isinstance(changes, list) or not any(
            isinstance(change, dict) and change.get("field") == "Funding Ad"
            for change in changes
        ):
            continue
        for change in changes:
            if isinstance(change, dict) and change.get("field") == "Amount (USD)":
                parsed = _history_money_minor(change.get("from"))
                if parsed is not None:
                    return parsed
    return None


def _manual_debt_base_minor(receipt: dict[str, Any], current_minor: int) -> int:
    """Recover debt that existed before the server first grew this receipt.

    Earlier releases did not persist a dedicated managed/base split, but every
    server growth appended a ``Funding Ad`` history change.  The first such
    entry's USD ``from`` value is therefore the genuine manual baseline.  A
    receipt with no server-growth history is entirely manual and must never be
    erased merely because no ad currently points at it.
    """
    proven = _proven_manual_debt_base_minor(receipt)
    return current_minor if proven is None else proven


def repair_legacy_unpaid_receipt_overgrowth(
    conn: Any, *, ctx: dict[str, Any]
) -> dict[str, int]:
    """Shrink provably managed legacy debt to its current live obligations.

    This startup pass is deliberately one-way. It never grows a receipt and it
    never touches a receipt whose history cannot prove the manual pre-growth
    baseline. Candidate rows are re-read under the same financial row lock used
    by ordinary mutations, and the caller-provided writer adds an optimistic
    ``last_modified`` condition as a second race check.
    """
    stats = {"scanned": 0, "repaired": 0, "skipped": 0, "failed": 0}
    financial_active_rows = ctx["financial_active_rows"]
    financial_active_row_batches = ctx.get("financial_active_row_batches")
    financial_due_total = ctx["financial_due_total"]
    financial_valid_rate = ctx["financial_valid_rate"]
    financial_row_data = ctx["financial_row_data"]
    receipt_transfer_fields = ctx["receipt_transfer_fields"]
    iso_utc = ctx["iso_utc"]
    sanitize_str = ctx["sanitize_str"]
    assert_financial_period_open = ctx["assert_financial_period_open"]
    lock_row = ctx["lock_row"]
    write_row = ctx["write_row"]
    postgres = bool(ctx.get("postgres"))

    def _row_batches(collection: str):
        if callable(financial_active_row_batches):
            yield from financial_active_row_batches(conn, collection)
        else:
            # Compatibility for focused callers with the older injected ctx.
            yield financial_active_rows(conn, collection)

    candidate_ids: set[str] = set()
    try:
        for discovery_rows in _row_batches("receipts"):
            for discovery_row in discovery_rows:
                try:
                    discovery = financial_row_data(discovery_row)
                except Exception:
                    continue
                if _proven_manual_debt_base_minor(discovery) is not None:
                    receipt_id = str(discovery_row.get("id") or "")
                    if receipt_id:
                        candidate_ids.add(receipt_id)
    except Exception as exc:
        stats["failed"] += 1
        print(
            "[albayan] unpaid-receipt overgrowth discovery failed: "
            f"{type(exc).__name__}: {exc}"
        )
        return stats

    ordered_ids = sorted(candidate_ids)
    # Lock every candidate before taking the shared ad snapshot. Funding
    # mutations use this same receipt-first order, so the one paginated scan
    # below is stable for every candidate without retaining receipt JSON.
    prelock_failures: dict[str, Exception] = {}
    for receipt_id in ordered_ids:
        try:
            lock_row(conn, "receipts", receipt_id, postgres=postgres)
        except Exception as exc:
            prelock_failures[receipt_id] = exc

    outstanding_by_receipt = {receipt_id: 0 for receipt_id in ordered_ids}
    ad_scan_error: Exception | None = None
    legacy_due_errors: dict[str, Exception] = {}
    if ordered_ids:
        selected_ids = set(ordered_ids)
        try:
            for ad_rows in _row_batches("ads"):
                for ad_row in ad_rows:
                    ad = financial_row_data(ad_row)
                    if str(ad.get("recordType") or "") == "receipt":
                        continue
                    due_map = _financial_allocation_map(
                        ad.get("dueAllocations")
                    )
                    if due_map:
                        for receipt_id, amount in due_map.items():
                            if receipt_id in selected_ids and amount > 0:
                                outstanding_by_receipt[receipt_id] += amount
                        continue
                    legacy_id = _financial_legacy_due_receipt_id(ad)
                    if legacy_id and legacy_id in selected_ids:
                        try:
                            legacy_due = _financial_ad_due_usage(ad, legacy_id)
                        except Exception as exc:
                            # The canonical reader parses a scalar legacy mirror
                            # only for its linked receipt. Preserve that narrow
                            # failure isolation while sharing the ad scan.
                            legacy_due_errors.setdefault(legacy_id, exc)
                            continue
                        if legacy_due > 0:
                            outstanding_by_receipt[legacy_id] += legacy_due
        except Exception as exc:
            # The old per-candidate scan failed each candidate on the same
            # corrupt ad. Retain that fail-closed behavior without reloading
            # the full ads table once per receipt.
            ad_scan_error = exc

    for receipt_id in ordered_ids:
        try:
            if receipt_id in prelock_failures:
                raise prelock_failures[receipt_id]
            row = lock_row(conn, "receipts", receipt_id, postgres=postgres)
            stats["scanned"] += 1
            if not row or bool(row["deleted"]):
                stats["skipped"] += 1
                continue
            receipt = financial_row_data(row)
            manual_base_minor = _proven_manual_debt_base_minor(receipt)
            if manual_base_minor is None:
                stats["skipped"] += 1
                continue

            current_minor = financial_due_total(receipt)
            if ad_scan_error is not None:
                raise ad_scan_error
            if receipt_id in legacy_due_errors:
                raise legacy_due_errors[receipt_id]
            outstanding_minor = outstanding_by_receipt.get(receipt_id, 0)
            target_minor = max(manual_base_minor, outstanding_minor)
            if target_minor >= current_minor:
                # Equality is already healed. A larger target needs a normal
                # user-authorized mutation; startup is never allowed to grow
                # customer debt.
                stats["skipped"] += 1
                continue

            detail = receipt.get("statusDetail")
            if detail is None:
                detail = {}
            if not isinstance(detail, dict):
                raise HTTPException(
                    status_code=409, detail="Stored receipt status is invalid"
                )
            collection = str(detail.get("notPaidCollection") or "").strip().lower()
            delivery_status = str(receipt.get("deliveryStatus") or "").strip()
            receipt_type = str(receipt.get("receiptType") or "").strip().upper()
            if (
                str(receipt.get("status") or "") != "Not Paid"
                or receipt.get("isPaid") is not False
                or collection not in {"office", "in_shop", "shop"}
                or delivery_status != "Office"
                or receipt_type in {"DELIVERY_TEMP", "TRANSFER_IN"}
                or bool(str(receipt.get("tempReceiptNo") or "").strip())
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Stored receipt is not a Not Paid In-Shop receipt",
                )
            payments = receipt.get("payments")
            transfers = receipt.get("transfers")
            if payments is not None and (
                not isinstance(payments, list) or payments
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Stored unpaid receipt contains payment information",
                )
            if transfers is not None and (
                not isinstance(transfers, list) or transfers
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Stored unpaid receipt contains transfer information",
                )
            if any(
                str(receipt.get(field) or "").strip()
                for field in receipt_transfer_fields - {"transfers", "receiptType"}
            ) or _financial_outgoing(receipt) != 0:
                raise HTTPException(
                    status_code=409,
                    detail="A transferred receipt cannot carry managed ad debt",
                )

            rate = financial_valid_rate(receipt.get("exchangeRate"))
            if rate is None:
                raise HTTPException(
                    status_code=409,
                    detail="Stored unpaid receipt needs a valid exchange rate",
                )
            old_local_minor = _financial_minor(
                receipt.get("amountLocal"), "stored receipt amountLocal"
            )
            new_local_minor = int(
                (Decimal(target_minor) * rate).quantize(
                    Decimal("1"), rounding=ROUND_HALF_UP
                )
            )
            repaired = dict(receipt)
            repaired["amountUSD"] = _financial_usd(target_minor)
            repaired["amountLocal"] = _financial_usd(new_local_minor)
            repaired_at = iso_utc()
            repaired["updatedAt"] = repaired_at
            history = (
                list(repaired.get("editHistory"))
                if isinstance(repaired.get("editHistory"), list)
                else []
            )
            history.append(
                {
                    "editedAt": repaired_at,
                    "editedBy": sanitize_str("System startup repair", 120),
                    "changes": [
                        {
                            "field": "Amount (USD)",
                            "from": f"${_financial_usd(current_minor):.2f}",
                            "to": f"${_financial_usd(target_minor):.2f}",
                        },
                        {
                            "field": "Amount (LYD)",
                            "from": f"{_financial_usd(old_local_minor):.2f} LYD",
                            "to": f"{_financial_usd(new_local_minor):.2f} LYD",
                        },
                        {
                            "field": "Debt Reconciliation",
                            "from": "Legacy managed total",
                            "to": "Manual base plus live due allocations",
                        },
                    ],
                }
            )
            repaired["editHistory"] = history
            repaired["editCount"] = len(history)
            assert_financial_period_open("receipts", receipt, conn=conn)
            assert_financial_period_open("receipts", repaired, conn=conn)
            write_row(conn, row, repaired)
            stats["repaired"] += 1
        except Exception as exc:
            stats["failed"] += 1
            detail = getattr(exc, "detail", str(exc))
            print(
                f"[albayan] unpaid-receipt overgrowth repair skipped {receipt_id}: "
                f"{type(exc).__name__}: {detail}"
            )
    return stats


def run_legacy_unpaid_receipt_overgrowth_backfill(
    *, open_transaction: Any, sqlite_guard: Any, ctx_factory: Any
) -> dict[str, int]:
    """Own the startup transaction and keep every failure non-fatal to boot."""
    try:
        ctx = ctx_factory()
        guard = nullcontext() if bool(ctx.get("postgres")) else sqlite_guard
        with guard, open_transaction() as conn:
            stats = repair_legacy_unpaid_receipt_overgrowth(conn, ctx=ctx)
    except Exception as exc:
        print(
            "[albayan] unpaid receipt overgrowth backfill failed: "
            f"{type(exc).__name__}: {exc}"
        )
        return {"scanned": 0, "repaired": 0, "skipped": 0, "failed": 1}
    if stats["repaired"]:
        print(
            "[albayan] Repaired legacy unpaid receipt debt on "
            f"{stats['repaired']} receipt(s)"
        )
    return stats


def parse_unpaid_receipt_debt_increase(
    raw: Any, ctx: dict[str, Any]
) -> dict[str, Any] | None:
    """Parse a request-only incremental receipt growth instruction.

    This is deliberately not part of the stored ad schema.  It authorizes one
    exact receipt change inside the same transaction that commits the ad's due
    allocation; accepting extra keys would turn it into an unintended generic
    receipt patch surface.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {
        "receiptId",
        "amountUSD",
        "expectedLastModified",
    }:
        raise HTTPException(
            status_code=400,
            detail="unpaidReceiptDebtIncrease must contain receiptId, amountUSD, and expectedLastModified",
        )
    receipt_id = ctx["validate_entity_id"](raw.get("receiptId"))
    amount_minor = _financial_minor(
        raw.get("amountUSD"),
        "unpaidReceiptDebtIncrease.amountUSD",
        allow_zero=False,
    )
    expected_last_modified = raw.get("expectedLastModified")
    if (
        isinstance(expected_last_modified, bool)
        or not isinstance(expected_last_modified, int)
        or expected_last_modified < 0
    ):
        raise HTTPException(
            status_code=400,
            detail="unpaidReceiptDebtIncrease.expectedLastModified must be a non-negative integer",
        )
    return {
        "receiptId": receipt_id,
        "amountUSD": _financial_usd(amount_minor),
        "amountMinorUSD": amount_minor,
        "expectedLastModified": expected_last_modified,
    }


def reconcile_unpaid_receipt_debt(
    conn: Any,
    actor: dict[str, Any],
    instruction: dict[str, Any] | None,
    requested_ad: dict[str, Any],
    existing_ad: dict[str, Any] | None,
    *,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    ad_id: str,
    ctx: dict[str, Any],
    allow_derived_growth: bool = False,
    require_receipt_permission: bool = True,
) -> list[tuple[str, Any, dict[str, Any], Any]]:
    """Prepare exact managed debt while preserving the receipt's manual base.

    The target is the larger of the pre-growth manual receipt amount and all
    live due allocations after this mutation. Positive deltas require the
    client's exact, stale-protected growth instruction. Negative deltas are
    derived from the locked old ad and the proposed replacement and are
    released automatically. The caller uses the replacement rows for ad
    validation and writes every real locked row later, immediately before the
    ad, in the same database transaction.
    """
    validate_entity_id = ctx["validate_entity_id"]
    financial_allocations = ctx["financial_allocations"]
    financial_ad_due_usage = ctx["financial_ad_due_usage"]
    financial_due_total = ctx["financial_due_total"]
    financial_usage = ctx["financial_usage"]
    financial_valid_rate = ctx["financial_valid_rate"]
    financial_row_data = ctx["financial_row_data"]
    user_has_permission = ctx["user_has_permission"]
    receipt_transfer_fields = ctx["receipt_transfer_fields"]
    sanitize_str = ctx["sanitize_str"]
    iso_utc = ctx["iso_utc"]
    assert_financial_period_open = ctx["assert_financial_period_open"]
    json_dumps = ctx["json_dumps"]

    proposed_ad = dict(existing_ad or {})
    proposed_ad.update(requested_ad)
    old_due = financial_allocations(
        (existing_ad or {}).get("dueAllocations"), "stored dueAllocations"
    )
    new_due = financial_allocations(
        proposed_ad.get("dueAllocations"), "dueAllocations"
    )

    def managed_in_shop_due(
        ad: dict[str, Any], due: list[dict[str, Any]]
    ) -> tuple[str, int]:
        linked_id = str(ad.get("receiptId") or "")
        if (
            _financial_ad_payment_status(ad) != "not_paid"
            or str(ad.get("collectionMethod") or "") != "in_shop"
            or not linked_id
        ):
            return "", 0
        if due:
            due_id = str(due[0].get("receiptId") or "") if len(due) == 1 else ""
            if due_id != linked_id:
                return "", 0
            return due_id, _financial_minor(due[0].get("amountUSD"), "due allocation")
        # Older records stored this same debt as a scalar instead of an
        # allocation row.  Reading it through the canonical helper lets a stop
        # release legacy debt without inventing a second receipt allocation.
        legacy_minor = financial_ad_due_usage(ad, linked_id)
        return (linked_id, legacy_minor) if legacy_minor > 0 else ("", 0)

    old_managed_id, _old_managed_minor = managed_in_shop_due(existing_ad or {}, old_due)
    new_managed_id, new_managed_minor = managed_in_shop_due(proposed_ad, new_due)
    affected_ids = {
        receipt_id
        for receipt_id in (old_managed_id, new_managed_id)
        if receipt_id
    }
    if not affected_ids:
        if instruction is not None:
            raise HTTPException(
                status_code=409,
                detail="Receipt debt increase must exactly match the new unfunded allocation",
            )
        return []

    customer_id = validate_entity_id(proposed_ad.get("customerId"))
    proposed_due_by_receipt = {}
    if new_managed_id:
        proposed_due_by_receipt[new_managed_id] = new_managed_minor
    plans: list[tuple[str, Any, dict[str, Any], int, int]] = []
    positive: list[tuple[str, Any]] = []
    for receipt_id in sorted(affected_ids):
        row = locked_receipts.get(receipt_id)
        if not row or bool(row["deleted"]):
            raise HTTPException(status_code=404, detail="Unpaid receipt not found")
        receipt = financial_row_data(row)
        current_minor = financial_due_total(receipt)
        # Company-covered rows are pot money the customer no longer owes but
        # the receipt still promises. Without them, coverage (which moves due
        # rows into the company pool) would read as vanished commitments and
        # silently shrink a derived receipt on the next reconcile.
        company_minor = sum(
            _financial_ad_company_usage(financial_row_data(ad_row), receipt_id)
            for ad_row in ad_rows
            if not (
                existing_ad is not None
                and str(ad_row.get("id") or "") == ad_id
            )
            and str(financial_row_data(ad_row).get("recordType") or "") != "receipt"
        ) + _financial_ad_company_usage(proposed_ad, receipt_id)
        outstanding_minor = financial_usage(
            ad_rows,
            receipt_id,
            due=True,
            exclude_ad_id=ad_id if existing_ad is not None else None,
        ) + proposed_due_by_receipt.get(receipt_id, 0) + company_minor
        target_minor = max(
            _manual_debt_base_minor(receipt, current_minor), outstanding_minor
        )
        plans.append((receipt_id, row, receipt, current_minor, target_minor))
        if target_minor > current_minor:
            positive.append((receipt_id, target_minor - current_minor))

    if positive:
        if len(positive) != 1 or (instruction is None and not allow_derived_growth):
            raise HTTPException(
                status_code=409,
                detail="Receipt debt increase must exactly match the new unfunded allocation",
            )
        receipt_id, growth_minor = positive[0]
        row = locked_receipts[receipt_id]
        if instruction is not None:
            if (
                str(instruction["receiptId"]) != receipt_id
                or int(instruction["amountMinorUSD"]) != growth_minor
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Receipt debt increase must exactly match the new unfunded allocation",
                )
            if int(row["last_modified"]) != int(instruction["expectedLastModified"]):
                raise HTTPException(
                    status_code=409, detail="Conflict: unpaid receipt has changed"
                )
    elif instruction is not None:
        raise HTTPException(
            status_code=409,
            detail="Receipt debt increase must exactly match the new unfunded allocation",
        )

    prepared: list[tuple[str, Any, dict[str, Any], Any]] = []
    for receipt_id, row, receipt, current_minor, target_minor in plans:
        if current_minor == target_minor:
            continue
        receipt_creator = row.get("created_by") or receipt.get("creatorId")
        if require_receipt_permission and not user_has_permission(
            actor,
            "receipts",
            "edit",
            record_creator_id=str(receipt_creator or ""),
        ):
            raise HTTPException(status_code=403, detail="Forbidden")
        if str(receipt.get("customerId") or "") != customer_id:
            raise HTTPException(
                status_code=400,
                detail="The unpaid receipt must belong to the ad customer",
            )

        detail = receipt.get("statusDetail")
        if detail is None:
            detail = {}
        if not isinstance(detail, dict):
            raise HTTPException(status_code=409, detail="Stored receipt status is invalid")
        collection = str(detail.get("notPaidCollection") or "").strip().lower()
        delivery_status = str(receipt.get("deliveryStatus") or "").strip()
        receipt_type = str(receipt.get("receiptType") or "").strip().upper()
        if (
            str(receipt.get("status") or "") != "Not Paid"
            or receipt.get("isPaid") is not False
            or collection not in {"office", "in_shop", "shop"}
            or delivery_status != "Office"
            or receipt_type in {"DELIVERY_TEMP", "TRANSFER_IN"}
            or bool(str(receipt.get("tempReceiptNo") or "").strip())
        ):
            raise HTTPException(
                status_code=400,
                detail="The selected receipt is not a Not Paid In-Shop receipt",
            )
        payments = receipt.get("payments")
        transfers = receipt.get("transfers")
        if payments is not None and (not isinstance(payments, list) or payments):
            raise HTTPException(
                status_code=409,
                detail="The unpaid receipt already contains payment information",
            )
        if transfers is not None and (not isinstance(transfers, list) or transfers):
            raise HTTPException(
                status_code=409,
                detail="The unpaid receipt already contains transfer information",
            )
        if any(
            str(receipt.get(field) or "").strip()
            for field in receipt_transfer_fields - {"transfers", "receiptType"}
        ) or _financial_outgoing(receipt) != 0:
            raise HTTPException(
                status_code=409,
                detail="A transferred receipt cannot carry ad debt",
            )

        rate = financial_valid_rate(receipt.get("exchangeRate"))
        if rate is None:
            raise HTTPException(
                status_code=409,
                detail="The unpaid receipt needs a valid exchange rate",
            )
        old_local_minor = _financial_minor(
            receipt.get("amountLocal"), "stored receipt amountLocal"
        )
        new_local_minor = int(
            (Decimal(target_minor) * rate).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        expanded = dict(receipt)
        expanded["amountUSD"] = _financial_usd(target_minor)
        expanded["amountLocal"] = _financial_usd(new_local_minor)
        for field, value in (("debtAmountUSD", target_minor), ("debtAmountLocal", new_local_minor)):
            if field in expanded:
                expanded[field] = _financial_usd(value)
        # This path only handles uncollected Office debt (validated above).
        # Stored coverage summaries must follow BOTH growth and release;
        # otherwise collection/coverage keeps offering the former liability.
        covered_minor = _financial_minor(receipt.get("companyCoveredUSD"), "stored company coverage")
        if covered_minor > 0 or receipt.get("customerOutstandingUSD") is not None:
            expanded["customerOutstandingUSD"] = _financial_usd(max(target_minor - covered_minor, 0))
        expanded["updatedAt"] = iso_utc()
        history = (
            list(expanded.get("editHistory"))
            if isinstance(expanded.get("editHistory"), list)
            else []
        )
        history.append(
            {
                "editedAt": iso_utc(),
                "editedBy": sanitize_str(
                    str(actor.get("name") or actor.get("username") or "System"), 120
                ),
                "changes": [
                    {
                        "field": "Amount (USD)",
                        "from": f"${_financial_usd(current_minor):.2f}",
                        "to": f"${_financial_usd(target_minor):.2f}",
                    },
                    {
                        "field": "Amount (LYD)",
                        "from": f"{_financial_usd(old_local_minor):.2f} LYD",
                        "to": f"{_financial_usd(new_local_minor):.2f} LYD",
                    },
                    {"field": "Funding Ad", "from": "-", "to": ad_id},
                ],
            }
        )
        expanded["editHistory"] = history
        expanded["editCount"] = len(history)
        assert_financial_period_open("receipts", receipt, conn=conn)
        assert_financial_period_open("receipts", expanded, conn=conn)
        validation_row = dict(row)
        validation_row["data_json"] = json_dumps(expanded)
        prepared.append((receipt_id, row, expanded, validation_row))
    return prepared


def reconcile_stopped_unpaid_receipt_debt(
    conn: Any,
    actor: dict[str, Any],
    stopped_ad: dict[str, Any],
    existing_ad: dict[str, Any],
    *,
    locked_receipts: dict[str, Any],
    ad_rows: list[Any],
    ad_id: str,
    ctx: dict[str, Any],
) -> list[str]:
    """Persist the exact managed receipt debt produced by a stop/re-stop.

    ``stopAd`` already authorizes the operation.  The receipt adjustment is a
    server-derived consequence of the immutable funding baseline and confirmed
    final spend, not a free-form receipt edit.  Controlled re-growth is allowed
    only when a later re-stop raises that same ad's due slice; genuine manual
    debt remains protected by ``_manual_debt_base_minor``.
    """
    prepared = reconcile_unpaid_receipt_debt(
        conn,
        actor,
        None,
        stopped_ad,
        existing_ad,
        locked_receipts=locked_receipts,
        ad_rows=ad_rows,
        ad_id=ad_id,
        ctx=ctx,
        allow_derived_growth=True,
        require_receipt_permission=False,
    )
    updated_ids: list[str] = []
    for receipt_id, row, expanded, validation_row in prepared:
        ctx["write_row"](conn, row, expanded)
        locked_receipts[receipt_id] = validation_row
        updated_ids.append(receipt_id)
    return updated_ids
