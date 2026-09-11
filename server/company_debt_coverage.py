"""Company-funded customer-debt coverage planning and transactional route.

Coverage moves explicit debt allocations into a separate company funding pool.
It never marks a receipt paid/collected and never changes a customer-paid
allocation. Main-owned locking, validation, and entity helpers are injected
into the focused router so its behavior remains part of the same API contract.
"""

from __future__ import annotations

import re
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, get_engine, json_loads
from .financial_compatibility import (
    project_financial_data,
    receipt_customer_outstanding_minor,
)

from .financial_core import (
    _financial_ad_direct_coverage,
    _financial_ad_due_usage,
    _financial_ad_general_usage,
    _financial_ad_payment_status,
    _financial_allocation_map,
    _financial_legacy_due_receipt_id,
    _financial_minor,
    _financial_outgoing,
    _financial_rowless_driver_gap,
    _financial_rows_from_allocation_map,
    _financial_usd,
)
from .meta_ads import _rate_limit_or_429
from .operations import assert_financial_period_open
from .schemas import (
    CustomerCompanyCoverageRequest,
    CustomerCompanyCoverageResponse,
    EntityResponse,
    ReceiptCompanyCoverageRequest,
    ReceiptCompanyCoverageResponse,
)
from .security import new_id


RECEIPT_COMPANY_COVERAGE_COLLECTION = "receiptCompanyCoverages"
RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION = "receiptCompanyCoverageMutations"
RECEIPT_COMPANY_COVERAGE_FIELDS = frozenset(
    {
        "companyCoveredUSD",
        "customerOutstandingUSD",
        "companyCoverageCount",
        "lastCompanyCoverageAt",
        "lastCompanyCoverageId",
    }
)
AD_COMPANY_COVERAGE_FIELDS = frozenset(
    {
        "companyFundingAllocations",
        "customerDueUSD",
        "companyFundedUSD",
        "companyDirectCoverageUSD",
    }
)


def protect_company_coverage_fields(
    collection: str,
    requested: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> None:
    """Reject forged coverage state and remove harmless unchanged echoes.

    Generic clients sometimes resend a full record while changing an unrelated
    field.  An unchanged server-owned value is therefore accepted but removed
    before persistence.  A create or any changed value must use the dedicated
    company-coverage transaction instead.
    """
    fields = (
        RECEIPT_COMPANY_COVERAGE_FIELDS
        if collection == "receipts"
        else AD_COMPANY_COVERAGE_FIELDS
        if collection == "ads"
        else frozenset()
    )
    submitted = fields.intersection(requested)
    if not submitted:
        return
    # Old records can now return corrected read-side summaries without a
    # database write. Accept an exact echo of that server-derived view as well
    # as the raw stored value, but remove either before applying the patch.
    # Derive from EXISTING data only: submitted amounts must not authorize a
    # client-forged coverage field.
    readable = project_financial_data(collection, existing) if existing is not None else {}
    if existing is None or any(
        requested.get(field) != existing.get(field)
        and requested.get(field) != readable.get(field)
        for field in submitted
    ):
        raise HTTPException(
            status_code=405,
            detail="Company coverage fields are server-controlled",
        )
    for field in submitted:
        requested.pop(field, None)


@dataclass(frozen=True)
class CompanyCoverageAdPlan:
    ad_id: str
    data: dict[str, Any]
    moved_minor: int


@dataclass(frozen=True)
class CompanyCoveragePlan:
    ads: tuple[CompanyCoverageAdPlan, ...]
    allocated_minor: int
    unassigned_minor: int


def _move_coverage_baselines(
    source: dict[str, Any], updated: dict[str, Any], receipt_id: str, moved_minor: int,
) -> None:
    """Keep reversible customer funding in step with irreversible coverage.

    A refund undo or spend correction may restore its saved customer pools.
    Once company funds replace a due slice, restoring that slice would charge
    the customer again. Move the same cents out of every applicable baseline;
    company funding remains in its existing, server-owned ledger.
    """
    if str(source.get("refundType") or "None") in {"Full", "Partial"} and isinstance(source.get("refundDueBaseline"), list):
        due = _financial_allocation_map(source["refundDueBaseline"])
        available = due.get(receipt_id, 0)
        if available > 0:
            if available < moved_minor:
                raise HTTPException(status_code=409, detail="Refund baseline changed; review the ad before covering its debt")
            due[receipt_id] = available - moved_minor
            updated["refundDueBaseline"] = _financial_rows_from_allocation_map(due)
    baseline = source.get("stopAllocationBaseline")
    if isinstance(baseline, dict):
        due = _financial_allocation_map(baseline.get("due"))
        available = due.get(receipt_id, 0)
        legacy_id = str(baseline.get("dueLegacyReceiptId") or _financial_legacy_due_receipt_id(source) or "")
        legacy = _financial_minor(baseline.get("dueLegacy"), "stop baseline due") if legacy_id == receipt_id else 0
        if available + legacy > 0:
            if available + legacy < moved_minor:
                raise HTTPException(status_code=409, detail="Stop baseline changed; review the ad before covering its debt")
            from_rows = min(available, moved_minor)
            due[receipt_id] = available - from_rows
            next_baseline = dict(baseline)
            next_baseline["due"] = _financial_rows_from_allocation_map(due)
            if legacy_id == receipt_id:
                next_baseline["dueLegacy"] = _financial_usd(legacy - (moved_minor - from_rows))
            updated["stopAllocationBaseline"] = next_baseline


def plan_company_debt_coverage(
    receipt_id: str,
    amount_minor: int,
    ads: Iterable[tuple[str, dict[str, Any]]],
) -> CompanyCoveragePlan:
    """Move up to ``amount_minor`` from receipt debt into company funding.

    Ads are processed by stable id order so a replay produces the same plan.
    Legacy scalar debt is normalized into modern allocation rows when touched.
    Any receipt liability not currently assigned to an ad is returned as
    ``unassigned_minor`` and is still valid company coverage of the receipt.
    """

    remaining = int(amount_minor)
    planned: list[CompanyCoverageAdPlan] = []
    for ad_id, source in sorted(ads, key=lambda item: item[0]):
        if remaining <= 0:
            break
        due = _financial_allocation_map(source.get("dueAllocations"))
        target_due = due.get(receipt_id, 0)
        if target_due <= 0:
            target_due = _financial_ad_due_usage(source, receipt_id)
            if target_due > 0:
                due[receipt_id] = target_due
        if target_due <= 0:
            # The live Meta-import driver shape carries NO due row: its money is
            # the customer's cash the driver collects through this receipt.
            # Coverage must still land on the ad as COMPANY funding — never as
            # a minted due row, which would freeze a live amount into a
            # commitment. Skipping the ad instead left the coverage
            # "unassigned", so the settle cascade later wrote the company's
            # dollars as customer receiptAllocations and the customer card
            # showed phantom debt equal to the covered amount.
            rowless_gap = _financial_rowless_driver_gap(source, receipt_id)
            moved = min(rowless_gap, remaining)
            if moved <= 0:
                continue
            company = _financial_allocation_map(source.get("companyFundingAllocations"))
            company[receipt_id] = company.get(receipt_id, 0) + moved
            updated = dict(source)
            updated["companyFundingAllocations"] = _financial_rows_from_allocation_map(company)
            updated["companyFundedUSD"] = _financial_usd(sum(company.values()))
            _move_coverage_baselines(source, updated, receipt_id, moved)
            planned.append(
                CompanyCoverageAdPlan(ad_id=ad_id, data=updated, moved_minor=moved)
            )
            remaining -= moved
            continue
        moved = min(target_due, remaining)
        if moved <= 0:
            continue

        company = _financial_allocation_map(source.get("companyFundingAllocations"))
        next_due = target_due - moved
        if next_due:
            due[receipt_id] = next_due
        else:
            due.pop(receipt_id, None)
        company[receipt_id] = company.get(receipt_id, 0) + moved

        updated = dict(source)
        updated["dueAllocations"] = _financial_rows_from_allocation_map(due)
        updated["companyFundingAllocations"] = _financial_rows_from_allocation_map(company)
        updated["dueAmountToUseUSD"] = _financial_usd(sum(due.values()))
        updated["dueAmountToUseLYD"] = 0.0
        updated["customerDueUSD"] = _financial_usd(sum(due.values()))
        updated["companyFundedUSD"] = _financial_usd(sum(company.values()))
        _move_coverage_baselines(source, updated, receipt_id, moved)
        planned.append(
            CompanyCoverageAdPlan(ad_id=ad_id, data=updated, moved_minor=moved)
        )
        remaining -= moved

    return CompanyCoveragePlan(
        ads=tuple(planned),
        allocated_minor=int(amount_minor) - remaining,
        unassigned_minor=remaining,
    )


def _read_company_coverage_state(
    data: dict[str, Any],
    financial_due_total: Callable[[dict[str, Any]], int],
    *,
    collected_minor: int = 0,
) -> tuple[int, int, int, int]:
    """Return ``(grossDebt, coveredBefore, outstandingBefore, source)``.

    ``collected_minor`` is customer cash already collected against this debt
    (a Delivered-but-UNDERPAID receipt). The same canonical read used for old
    entity responses takes priority over a stale cached outstanding summary.
    """
    gross_minor = financial_due_total(data)
    covered_minor = (
        _financial_minor(data.get("companyCoveredUSD"), "stored companyCoveredUSD")
        if data.get("companyCoveredUSD") is not None
        else 0
    )
    canonical_outstanding = receipt_customer_outstanding_minor(
        data, financial_due_total, collected_minor=collected_minor
    )
    if canonical_outstanding is not None:
        return gross_minor, covered_minor, canonical_outstanding, 1
    outstanding_stored_minor = (
        _financial_minor(
            data.get("customerOutstandingUSD"),
            "stored customerOutstandingUSD",
        )
        if data.get("customerOutstandingUSD") is not None
        else None
    )
    if outstanding_stored_minor is not None:
        outstanding_minor = outstanding_stored_minor
        # Keep the two stored summaries internally consistent so a later
        # coverage run cannot mint a negative or over-reported liability.
        covered_minor = max(min(covered_minor, gross_minor), 0)
        outstanding_minor = max(
            min(outstanding_minor, gross_minor - covered_minor), 0
        )
    else:
        covered_minor = max(min(covered_minor, gross_minor), 0)
        outstanding_minor = max(
            gross_minor - covered_minor - max(int(collected_minor), 0), 0
        )
    source = 1 if data.get("customerOutstandingUSD") is None else 0
    return gross_minor, covered_minor, outstanding_minor, source


def ad_effective_spend_minor(ad: dict[str, Any]) -> int:
    """STATUS-AWARE spend, mirroring the client's getAdSpendUSD to the cent —
    the customer card's "Spent" and every coverage figure must be the same
    number. A pending/paused ad has spent nothing: covering its un-spent
    budget would absorb debt that does not exist (and may never exist).

    Branches on KEY PRESENCE, not ``is not None``: the client tests
    ``!== undefined``, so a stored ``spentUSD: null`` is present-and-zero
    there. Testing ``is not None`` here instead fell through to amountUSD and
    invented a whole ad's worth of debt for any row storing an explicit null.
    """
    status = str(ad.get("status") or "").strip().lower()
    if status in {"pending", "paused"}:
        return 0
    if status == "stopped" and "spentUSD" in ad:
        return _financial_minor(ad.get("spentUSD") or 0, "stored ad spend")
    if status in {"completed", "canceled", "lost"}:
        return (
            _financial_minor(ad.get("spentUSD") or 0, "stored ad spend")
            if "spentUSD" in ad
            else _financial_minor(ad.get("amountUSD"), "stored ad amount")
        )
    return _financial_minor(ad.get("amountUSD"), "stored ad amount")


def ad_funded_minor(ad: dict[str, Any]) -> int:
    """Every dollar already provided for this ad, read through the SAME rules
    the money model uses — not just the modern allocation arrays.

    A pre-allocation ad records its funding nowhere but (a) the whole-ad
    fallback, where ``_financial_ad_general_usage`` charges its ENTIRE spend
    to the receipt it references, or (b) the scalar mirror
    ``dueAmountToUseUSD/LYD``, which ``_financial_ad_due_usage`` still honours
    whenever no due row exists. Counting only the arrays reported every such
    ad as 100% unfunded — the same phantom-debt class as the per-field double
    count — and, worse, let the customer-level button offer company money for
    dollars already committed against a receipt, which the receipt-level
    button could then be asked to cover a second time.
    """
    due_rows = _financial_allocation_map(ad.get("dueAllocations"))
    has_arrays = (
        isinstance(ad.get("receiptAllocations"), list)
        or isinstance(ad.get("dueAllocations"), list)
        or isinstance(ad.get("companyFundingAllocations"), list)
    )
    references_receipt = bool(
        str(ad.get("fundingReceiptId") or "").strip()
        or str(ad.get("receiptId") or "").strip()
        or str(ad.get("linkedDeliveryReceiptId") or "").strip()
    )
    if not has_arrays and references_receipt:
        # Whole-ad fallback: the money model already charges this ad's entire
        # spend to the receipt it references, so nothing is outstanding here.
        return ad_effective_spend_minor(ad)

    legacy_due = 0
    if not due_rows:
        mirror_receipt_id = _financial_legacy_due_receipt_id(ad)
        if mirror_receipt_id:
            legacy_due = _financial_ad_due_usage(ad, mirror_receipt_id)

    return (
        sum(_financial_allocation_map(ad.get("receiptAllocations")).values())
        + sum(due_rows.values())
        + sum(_financial_allocation_map(ad.get("companyFundingAllocations")).values())
        + _financial_ad_direct_coverage(ad)
        + legacy_due
    )


def company_pool_total_minor(ad: dict[str, Any]) -> int:
    """Company money already applied to this ad: covered rows + direct coverage.

    A stop/reconciliation must count it as SPEND CAPACITY — it is real money
    that paid for the ad — but never re-plan it: the coverage ledger already
    recorded it as an expense, so only the CUSTOMER's pools shrink when an ad
    stops below its budget. Ignoring it refused every stop above the
    customer's remaining share (409 "exceeds the ad's funding baseline"),
    forcing under-reported spend and a wrong customer balance.
    """
    return (
        sum(_financial_allocation_map(ad.get("companyFundingAllocations")).values())
        + _financial_ad_direct_coverage(ad)
    )


def coverable_ad_debt_detail(
    ad: dict[str, Any],
    *,
    receipt_lookup: Callable[[str], dict[str, Any] | None] | None = None,
) -> tuple[str, int]:
    """``(reason, coverable_minor)`` for one ad — the single source of truth.

    ``coverable_ad_debt_minor`` is the amount half of this, and the admin
    "why is there no button" diagnostic is the reason half, so the two can
    never drift apart into contradicting each other.

    ``receipt_lookup`` resolves a receipt id to its stored data. Without one
    every driver ad stays excluded, which is the conservative reading.
    """
    if str(ad.get("recordType") or "") == "receipt":
        return ("not_an_ad", 0)
    payment_status = _financial_ad_payment_status(ad)
    if payment_status != "not_paid":
        return (f"ad_marked_{payment_status}", 0)
    if str(ad.get("collectionMethod") or "") == "driver":
        # While the delivery is still live this money is the customer's own
        # cash, which the driver collects at the door and the delivery receipt
        # accounts for — never ours to cover. Once that receipt has been
        # COLLECTED AND SETTLED (Paid), the collection path is closed for
        # good, and whatever the settlement did not fund is simply debt that
        # was never collected. Deliberately keyed on Paid rather than
        # "no longer tracks debt": a canceled or lost delivery RELEASED its
        # debt, so there is nothing left to owe, let alone to cover.
        delivery_receipt_id = str(
            ad.get("linkedDeliveryReceiptId") or ad.get("receiptId") or ""
        ).strip()
        linked_receipt = (
            receipt_lookup(delivery_receipt_id)
            if receipt_lookup and delivery_receipt_id
            else None
        )
        if not linked_receipt or _receipt_payment_state(linked_receipt) != "paid":
            return ("driver_debt_belongs_to_its_delivery_receipt", 0)
    has_arrays = (
        isinstance(ad.get("receiptAllocations"), list)
        or isinstance(ad.get("dueAllocations"), list)
        or isinstance(ad.get("companyFundingAllocations"), list)
    )
    if not has_arrays and (
        str(ad.get("fundingReceiptId") or "").strip()
        or str(ad.get("receiptId") or "").strip()
        or str(ad.get("linkedDeliveryReceiptId") or "").strip()
    ):
        return ("rowless_legacy_ad_charged_to_its_linked_receipt", 0)
    status = str(ad.get("status") or "").strip().lower()
    if status in {"pending", "paused"}:
        return (f"ad_{status}_has_not_spent_yet", 0)
    gap = max(ad_effective_spend_minor(ad) - ad_funded_minor(ad), 0)
    if gap <= 0:
        return ("fully_funded_nothing_left_to_cover", 0)
    return ("coverable", gap)


def coverable_ad_debt_minor(
    ad: dict[str, Any],
    *,
    receipt_lookup: Callable[[str], dict[str, Any] | None] | None = None,
) -> int:
    """Ad debt that customer-level company coverage may absorb.

    Only a Not Paid ad qualifies. A driver ad's debt belongs to its delivery
    receipt while that delivery is live, and a rowless legacy ad that
    references any receipt is charged against that receipt by the usage
    fallback. What remains is spend backed by nothing:
    ``effective − paid rows − due rows − company rows − direct coverage
    − legacy due mirror``.
    """
    return coverable_ad_debt_detail(ad, receipt_lookup=receipt_lookup)[1]


def make_receipt_lookup(conn: Any) -> Callable[[str], dict[str, Any] | None]:
    """Cached id -> receipt data reader for the coverage rules."""
    cache: dict[str, dict[str, Any] | None] = {}

    def lookup(receipt_id: str) -> dict[str, Any] | None:
        key = str(receipt_id or "")
        if key not in cache:
            row = conn.execute(
                text(
                    "SELECT data_json FROM entities WHERE type='receipts' "
                    "AND id=:id AND deleted=false"
                ),
                {"id": key},
            ).mappings().first()
            data = json_loads(row["data_json"]) if row and row["data_json"] else None
            cache[key] = data if isinstance(data, dict) else None
        return cache[key]

    return lookup


def _receipt_payment_state(receipt: dict[str, Any] | None) -> str:
    """Python mirror of the client's getReceiptPaymentState (08-data-audit.js)."""
    if not receipt:
        return "unknown"
    status = re.sub(r"[\s_-]+", "", str(receipt.get("status") or "").strip().lower())
    if status in {"canceled", "cancelled"}:
        return "canceled"
    if status == "destroyed":
        return "canceled"
    if status == "lost":
        return "lost"
    if status == "paid":
        return "paid"
    if status in {"notpaid", "unpaid", "pending"}:
        return "not_paid"
    if receipt.get("isPaid") is True:
        return "paid"
    if receipt.get("isPaid") is False:
        return "not_paid"
    return "unknown"


def _receipt_still_tracks_debt(receipt: dict[str, Any] | None) -> bool:
    """Python mirror of the client's getReceiptDebtType(...) !== 'none'.

    True only while a receipt is itself still an active, unpaid debt (the
    state the "Unpaid receipt debt" figure and the receipt-level coverage
    button both key off). False for Paid/Canceled/Lost/Destroyed/TRANSFER_IN
    receipts and canceled deliveries — i.e. once a receipt reaches this
    state, nothing else will surface its remaining shortfall as debt.
    """
    if not receipt:
        return False
    if str(receipt.get("receiptType") or "").strip().upper() == "TRANSFER_IN":
        return False
    if _receipt_payment_state(receipt) != "not_paid":
        return False
    delivery_status = str(receipt.get("deliveryStatus") or "").strip().lower()
    if delivery_status in {"canceled", "cancelled"}:
        return False
    return True


def scan_legacy_link_coverage_gap(
    conn: Any,
    *,
    financial_due_total: Callable[[dict[str, Any]], int],
) -> dict[str, Any]:
    """READ-ONLY headcount, using the SAME one-pot rule the rest of the money
    model already enforces (``committed(receipt) <= capacity(receipt)``):
    real customer debt currently invisible to both company-fund coverage
    paths.

    A legacy rowless ad (no receiptAllocations/dueAllocations/
    companyFundingAllocations arrays) that references a receipt is counted
    as fully COMMITTED against that receipt's capacity via the whole-ad
    fallback (``_financial_ad_general_usage``, the same reader every other
    capacity guard trusts) — never per-dollar, since a rowless ad carries no
    record of how much of the receipt it actually used. That is fine while
    the receipt is still an active not-paid debt: ``coverable_ad_debt_minor``
    correctly leaves the ad alone because the receipt side is still tracking
    it (via the client's own committed-vs-capacity reads). Once the receipt
    reaches Paid/Canceled/Lost/Destroyed/TRANSFER_IN (``_receipt_still_tracks_debt``
    false), that tracking stops — but the ad's commitment against it does
    not disappear. If the committed total from every ad referencing that
    receipt exceeds the receipt's own capacity, the difference is real,
    uncollectable debt that today shows in no "Unpaid receipt debt" line and
    passes ``coverable_ad_debt_minor``'s legacy-link exclusion untouched.

    Judged per RECEIPT (not per ad) because several rowless ads can share one
    receipt's pot — judging one ad in isolation could over- or under-state
    the shared shortfall. Driver-collection ads are excluded: their money is
    the customer's own cash collected at the door, tracked through the
    delivery flow, never receipt-pot committed via this fallback.

    Changes nothing — it only counts. This is the sizing step before any
    change to ``coverable_ad_debt_minor`` itself.
    """
    ad_rows = conn.execute(
        text("SELECT id, data_json FROM entities WHERE type='ads' AND deleted=false")
    ).mappings().all()

    # An ad routinely carries the SAME receipt id in more than one link field
    # (fundingReceiptId AND receiptId are both written by the normal funding
    # flow). Keying by ad id makes each receipt's list a genuine SET: appending
    # per-field instead counted such an ad once per field, reporting committed
    # totals at exactly 2x capacity and turning ordinary, correctly-funded
    # receipts into phantom debt. _financial_ad_general_usage already tests all
    # three fields itself, so one entry per ad is both correct and sufficient.
    referencing_ads: dict[str, dict[str, dict[str, Any]]] = {}
    for row in ad_rows:
        ad = json_loads(row["data_json"]) or {}
        if not isinstance(ad, dict):
            continue
        if str(ad.get("recordType") or "") == "receipt":
            continue
        if str(ad.get("collectionMethod") or "") == "driver":
            continue
        ad_id = str(row["id"])
        for field in ("fundingReceiptId", "receiptId", "linkedDeliveryReceiptId"):
            receipt_id = str(ad.get(field) or "").strip()
            if receipt_id:
                referencing_ads.setdefault(receipt_id, {})[ad_id] = ad

    affected_customers: set[str] = set()
    total_overage_minor = 0
    all_examples: list[dict[str, Any]] = []

    for receipt_id, ads_by_id in referencing_ads.items():
        ads = list(ads_by_id.values())
        row = conn.execute(
            text(
                "SELECT data_json FROM entities "
                "WHERE type='receipts' AND id=:id AND deleted=false"
            ),
            {"id": receipt_id},
        ).mappings().first()
        if not row or not row["data_json"]:
            continue
        receipt = json_loads(row["data_json"])
        if not isinstance(receipt, dict):
            continue
        if _receipt_still_tracks_debt(receipt):
            continue  # correctly excluded today — receipt path still owns this

        capacity_minor = financial_due_total(receipt)
        committed_minor = sum(
            _financial_ad_general_usage(ad, receipt_id) for ad in ads
        )
        overage_minor = max(committed_minor - capacity_minor, 0)
        if overage_minor <= 0:
            continue

        customer_id = str(receipt.get("customerId") or "")
        affected_customers.add(customer_id)
        total_overage_minor += overage_minor
        all_examples.append(
            {
                "receiptId": receipt_id,
                "customerId": customer_id,
                "receiptStatus": str(receipt.get("status") or ""),
                "receiptCapacityUSD": _financial_usd(capacity_minor),
                "committedByAdsUSD": _financial_usd(committed_minor),
                "overageUSD": _financial_usd(overage_minor),
                "adCount": len(ads),
            }
        )

    # Largest gaps first — the biggest-dollar cases are what an admin needs
    # to see, not an arbitrary database scan order.
    all_examples.sort(key=lambda item: item["overageUSD"], reverse=True)
    example_limit = 50
    return {
        "affectedCustomerCount": len(affected_customers),
        "affectedReceiptCount": len(all_examples),
        "totalGapUSD": _financial_usd(total_overage_minor),
        "examples": all_examples[:example_limit],
        "examplesTruncated": len(all_examples) > example_limit,
    }


def scan_unfunded_ad_spend(conn: Any) -> dict[str, Any]:
    """READ-ONLY: EVERY ad whose real spend exceeds the money provided for it,
    grouped by the rule that currently decides whether company funds may
    cover it.

    This is the direct measurement of "how much real customer debt does the
    button not offer, and why". Unlike the legacy-link scan it makes no
    assumption about which shape the debt takes: it starts from
    ``spend − funded > 0`` (the definition of somebody still owing) and lets
    ``coverable_ad_debt_detail`` name the rule. ``coverable`` in the output is
    the healthy bucket — debt the button already offers — and doubles as a
    sanity check that the reader agrees with the live feature.

    Changes nothing; counts only.
    """
    customer_names = {
        str(row["id"]): str((json_loads(row["data_json"]) or {}).get("name") or "")
        for row in conn.execute(
            text(
                "SELECT id, data_json FROM entities "
                "WHERE type='customers' AND deleted=false"
            )
        ).mappings().all()
    }
    receipts_by_id: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        text(
            "SELECT id, data_json FROM entities "
            "WHERE type='receipts' AND deleted=false"
        )
    ).mappings().all():
        receipt = json_loads(row["data_json"]) or {}
        if isinstance(receipt, dict):
            receipts_by_id[str(row["id"])] = receipt
    receipt_states = {
        rid: str(receipt.get("status") or "")
        for rid, receipt in receipts_by_id.items()
    }
    receipt_lookup = receipts_by_id.get

    # A reason only counts as debt the button fails to offer when the money is
    # genuinely still owed AND nothing else already accounts for it. Everything
    # else is reported for completeness but kept OUT of the headline, because a
    # single inflated number is exactly how the previous iteration misled.
    not_real_debt = {
        # The driver collects this cash at the door; the delivery receipt
        # tracks it, and settlement converts it into an explicit allocation.
        "driver_debt_belongs_to_its_delivery_receipt": (
            "customer cash still to be collected through the delivery receipt"
        ),
        # A deliberate business write-off, not debt awaiting a payment method.
        "ad_marked_wont_pay": "deliberately written off",
        # Debt the button ALREADY offers — the healthy bucket, and a live
        # cross-check that this reader agrees with the real feature.
        "coverable": "already offered by the button today",
    }

    totals_minor: dict[str, int] = {}
    counts: dict[str, int] = {}
    customers_by_reason: dict[str, set[str]] = {}
    all_customers: set[str] = set()
    examples: list[dict[str, Any]] = []
    unreadable: list[str] = []
    ads_with_no_customer_id = 0

    for row in conn.execute(
        text("SELECT id, data_json FROM entities WHERE type='ads' AND deleted=false")
    ).mappings().all():
        ad = json_loads(row["data_json"]) or {}
        if not isinstance(ad, dict):
            continue
        if str(ad.get("recordType") or "") == "receipt":
            continue
        # A single corrupt legacy row must not abort the whole survey — those
        # are precisely the rows this scan exists to find. _financial_minor
        # raises on negative/non-numeric/over-cap stored values.
        try:
            spend_minor = ad_effective_spend_minor(ad)
            funded_minor = ad_funded_minor(ad)
            reason = coverable_ad_debt_detail(ad, receipt_lookup=receipt_lookup)[0]
        except HTTPException:
            unreadable.append(str(row["id"]))
            continue
        unfunded_minor = spend_minor - funded_minor
        if unfunded_minor <= 0:
            continue

        # customerId only — the live route selects and re-verifies on that
        # field alone, so anything else could never actually be offered.
        customer_id = str(ad.get("customerId") or "")
        if customer_id:
            customers_by_reason.setdefault(reason, set()).add(customer_id)
            all_customers.add(customer_id)
        else:
            ads_with_no_customer_id += 1

        totals_minor[reason] = totals_minor.get(reason, 0) + unfunded_minor
        counts[reason] = counts.get(reason, 0) + 1

        linked = [
            value
            for value in {
                str(ad.get("fundingReceiptId") or "").strip(),
                str(ad.get("receiptId") or "").strip(),
                str(ad.get("linkedDeliveryReceiptId") or "").strip(),
            }
            if value
        ]
        examples.append(
            {
                "adId": str(row["id"]),
                "customerId": customer_id,
                "customerName": customer_names.get(customer_id, ""),
                "reason": reason,
                "countsAsUnofferedDebt": reason not in not_real_debt,
                "adStatus": str(ad.get("status") or ""),
                "hasAllocationRows": bool(
                    _financial_allocation_map(ad.get("receiptAllocations"))
                    or _financial_allocation_map(ad.get("dueAllocations"))
                    or _financial_allocation_map(ad.get("companyFundingAllocations"))
                ),
                "spentUSD": _financial_usd(spend_minor),
                "fundedUSD": _financial_usd(funded_minor),
                "unfundedUSD": _financial_usd(unfunded_minor),
                "linkedReceipts": [
                    {"receiptId": rid, "status": receipt_states.get(rid, "DELETED_OR_MISSING")}
                    for rid in linked
                ],
            }
        )

    totals = {
        reason: {
            "adCount": counts[reason],
            "customerCount": len(customers_by_reason.get(reason, set())),
            "unfundedUSD": _financial_usd(minor),
            "countsAsUnofferedDebt": reason not in not_real_debt,
            "note": not_real_debt.get(reason, "real debt the button does not offer"),
        }
        for reason, minor in totals_minor.items()
    }
    real_debt_minor = sum(
        minor for reason, minor in totals_minor.items() if reason not in not_real_debt
    )

    examples.sort(key=lambda item: item["unfundedUSD"], reverse=True)
    example_limit = 40
    return {
        # THE number to scope a fix against: only buckets that are genuinely
        # owed and genuinely not offered anywhere.
        "notOfferedButRealDebtUSD": _financial_usd(real_debt_minor),
        "distinctCustomerCount": len(all_customers),
        "totalsByReason": totals,
        "adsWithNoCustomerId": ads_with_no_customer_id,
        "unreadableAdIds": unreadable[:20],
        "unreadableAdCount": len(unreadable),
        "examples": examples[:example_limit],
        "examplesTruncated": len(examples) > example_limit,
    }


def explain_customer_company_coverage(
    conn: Any,
    customer_id: str,
    *,
    financial_due_total: Callable[[dict[str, Any]], int],
) -> dict[str, Any]:
    """READ-ONLY: why ONE customer's debt is or is not offered to company funds.

    The headcount answers "how widespread"; this answers "why not this
    customer", which is the question a missing button actually raises. Every
    ad reports the exact rule that decided it, straight from
    ``coverable_ad_debt_detail`` — never a re-implementation that could
    disagree with the real eligibility check.
    """
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    customer_expr = (
        "(data_json::jsonb ->> 'customerId')"
        if postgres
        else "json_extract(data_json, '$.customerId')"
    )

    ad_rows = conn.execute(
        text(
            "SELECT id, data_json FROM entities WHERE type='ads' AND deleted=false "
            f"AND {customer_expr} = :customer_id ORDER BY id"
        ),
        {"customer_id": customer_id},
    ).mappings().all()
    receipt_rows = conn.execute(
        text(
            "SELECT id, data_json FROM entities WHERE type='receipts' "
            f"AND deleted=false AND {customer_expr} = :customer_id ORDER BY id"
        ),
        {"customer_id": customer_id},
    ).mappings().all()

    receipt_lookup = make_receipt_lookup(conn)
    ads: list[dict[str, Any]] = []
    coverable_total_minor = 0
    for row in ad_rows:
        ad = json_loads(row["data_json"]) or {}
        if not isinstance(ad, dict):
            continue
        reason, gap_minor = coverable_ad_debt_detail(ad, receipt_lookup=receipt_lookup)
        coverable_total_minor += gap_minor
        ads.append(
            {
                "adId": str(row["id"]),
                "status": str(ad.get("status") or ""),
                "paymentStatus": _financial_ad_payment_status(ad),
                "collectionMethod": str(ad.get("collectionMethod") or ""),
                "amountUSD": ad.get("amountUSD"),
                "spentUSD": ad.get("spentUSD"),
                "hasAllocationArrays": (
                    isinstance(ad.get("receiptAllocations"), list)
                    or isinstance(ad.get("dueAllocations"), list)
                    or isinstance(ad.get("companyFundingAllocations"), list)
                ),
                "linkedReceiptIds": [
                    value
                    for value in {
                        str(ad.get("fundingReceiptId") or "").strip(),
                        str(ad.get("receiptId") or "").strip(),
                        str(ad.get("linkedDeliveryReceiptId") or "").strip(),
                    }
                    if value
                ],
                "paidRowsUSD": _financial_usd(
                    sum(_financial_allocation_map(ad.get("receiptAllocations")).values())
                ),
                "dueRowsUSD": _financial_usd(
                    sum(_financial_allocation_map(ad.get("dueAllocations")).values())
                ),
                "companyRowsUSD": _financial_usd(
                    sum(
                        _financial_allocation_map(
                            ad.get("companyFundingAllocations")
                        ).values()
                    )
                ),
                "companyDirectCoverageUSD": _financial_usd(
                    _financial_ad_direct_coverage(ad)
                ),
                "reason": reason,
                "coverableUSD": _financial_usd(gap_minor),
            }
        )

    receipts: list[dict[str, Any]] = []
    for row in receipt_rows:
        receipt = json_loads(row["data_json"]) or {}
        if not isinstance(receipt, dict):
            continue
        tracks_debt = _receipt_still_tracks_debt(receipt)
        receipts.append(
            {
                "receiptId": str(row["id"]),
                "status": str(receipt.get("status") or ""),
                "isPaid": receipt.get("isPaid"),
                "paymentState": _receipt_payment_state(receipt),
                "receiptType": str(receipt.get("receiptType") or ""),
                "deliveryStatus": str(receipt.get("deliveryStatus") or ""),
                "capacityUSD": _financial_usd(financial_due_total(receipt)),
                "companyCoveredUSD": receipt.get("companyCoveredUSD"),
                "customerOutstandingUSD": receipt.get("customerOutstandingUSD"),
                # A receipt only offers the receipt-level button while it is
                # still an active unpaid debt of its own.
                "stillTracksDebtSoCoverable": tracks_debt,
            }
        )

    return {
        "customerId": customer_id,
        "coverableAdDebtUSD": _financial_usd(coverable_total_minor),
        "coverableReceiptCount": sum(
            1 for item in receipts if item["stillTracksDebtSoCoverable"]
        ),
        "ads": ads,
        "receipts": receipts,
    }


def release_company_rows_for_receipt_delete(
    conn: Any,
    receipt_id: str,
    *,
    ad_rows: list[Any],
    lock_row: Callable[..., Any],
    row_data: Callable[[Any], dict[str, Any]],
    write_row: Callable[..., Any],
    postgres: bool,
) -> int:
    """Release server-owned company rows from ads before a receipt delete.

    The client cleans due/paid rows itself but is refused any edit to the
    company pool, so the delete transaction must strip those rows here. The
    coverage audit record keeps the history; a dangling row would keep
    counting in capacity/funded sums against a receipt that no longer exists.
    """
    released = 0
    for ad_row in ad_rows:
        ad_data = row_data(ad_row)
        if str(ad_data.get("recordType") or "") == "receipt":
            continue
        if receipt_id not in _financial_allocation_map(
            ad_data.get("companyFundingAllocations")
        ):
            continue
        locked_ad = lock_row(conn, "ads", str(ad_row["id"]), postgres=postgres)
        if not locked_ad or bool(locked_ad["deleted"]):
            continue
        locked_data = row_data(locked_ad)
        locked_map = _financial_allocation_map(
            locked_data.get("companyFundingAllocations")
        )
        if locked_map.pop(receipt_id, 0) <= 0:
            continue
        next_ad = dict(locked_data)
        next_ad["companyFundingAllocations"] = _financial_rows_from_allocation_map(
            locked_map
        )
        next_ad["companyFundedUSD"] = _financial_usd(sum(locked_map.values()))
        write_row(conn, locked_ad, next_ad)
        released += 1
    return released


def create_company_debt_coverage_router(
    *,
    require_admin_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """Create the transactional Admin-only company-debt coverage route."""
    router = APIRouter()

    @router.post(
        "/api/receipts/{receipt_id}/company-coverages",
        response_model=ReceiptCompanyCoverageResponse,
    )
    def cover_receipt_with_company_funds(
        receipt_id: str,
        body: ReceiptCompanyCoverageRequest,
        request: Request,
        include_media: bool = True,
        admin: dict[str, Any] = Depends(require_admin_dependency),
    ):
        """Reduce unpaid in-shop/office receipt liability from internal funds.

        This endpoint never marks a customer payment. It only moves commitment
        from ``dueAllocations`` to ``companyFundingAllocations`` on linked ads
        and keeps the remaining customer debt in sync.
        """
        require_same_origin(request)
        receipt_id = ctx["validate_entity_id"](receipt_id)
        idem = ctx["sanitize_str"](body.idempotencyKey, 120)
        reason = ctx["sanitize_str"](body.reason, 500)
        if not reason:
            raise HTTPException(
                status_code=400,
                detail="A business reason is required for company coverage",
            )
        request_hash = ctx["financial_request_hash"](
            {
                "receiptId": receipt_id,
                "amountMinorUSD": int(body.amountMinorUSD),
                "expectedLastModified": int(body.expectedLastModified),
                "reason": reason,
            }
        )
        actor_id = ctx["validate_entity_id"](admin.get("id"))
        postgres = str(get_engine().dialect.name or "") == "postgresql"
        guard = nullcontext() if postgres else ctx["sqlite_financial_lock"]()
        with guard:
            with db_conn() as conn:
                ctx["lock_idempotency_key"](
                    conn,
                    idem,
                    postgres=postgres,
                    namespace="receiptCompanyCoverage",
                )
                prior = ctx["financial_check_marker"](
                    ctx["financial_get_marker"](
                        conn,
                        RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION,
                        "receiptCompanyCoverage",
                        idem,
                    ),
                    actor_id,
                    request_hash,
                )
                if prior:
                    coverage = ctx["financial_entity_result"](
                        conn,
                        RECEIPT_COMPANY_COVERAGE_COLLECTION,
                        str(prior.get("coverageId") or ""),
                    )
                    updated_receipts = [
                        ctx["financial_entity_result"](
                            conn, "receipts", str(updated_receipt_id)
                        )
                        for updated_receipt_id in (
                            prior.get("updatedReceiptIds") or []
                        )
                    ]
                    updated_ads = [
                        ctx["financial_entity_result"](
                            conn, "ads", str(ad_id)
                        )
                        for ad_id in (prior.get("updatedAdIds") or [])
                    ]
                    return ReceiptCompanyCoverageResponse(
                        coverage=EntityResponse(**coverage),
                        updatedReceipts=[
                            EntityResponse(**item) for item in updated_receipts
                        ],
                        updatedAds=[EntityResponse(**item) for item in updated_ads],
                        replayed=True,
                    )

                row = ctx["clothes_lock_row"](
                    conn, "receipts", receipt_id, postgres=postgres
                )
                if not row or bool(row["deleted"]):
                    raise HTTPException(status_code=404, detail="Receipt not found")

                existing = ctx["financial_row_data"](row)
                if (
                    str(existing.get("status") or "") != "Not Paid"
                    or existing.get("isPaid") is not False
                ):
                    raise HTTPException(
                        status_code=400,
                        detail="Receipt must be unpaid (Not Paid) to apply company coverage",
                    )
                status_detail = (
                    existing.get("statusDetail")
                    if isinstance(existing.get("statusDetail"), dict)
                    else {}
                )
                not_paid_collection = str(
                    status_detail.get("notPaidCollection") or ""
                ).strip().lower()
                if not_paid_collection not in {"", "office", "in_shop", "shop", "delivery"}:
                    raise HTTPException(
                        status_code=400,
                        detail="This receipt's debt type cannot be covered by company funds",
                    )
                delivery_status = str(existing.get("deliveryStatus") or "").strip().lower()
                # A canceled delivery released its debt — there is nothing left
                # to cover. Every other state is coverable: the completion
                # truth collects only the customer's remaining share, so
                # covering before, during, or after (UNDERPAID) a delivery can
                # never let the same dollars be recovered twice.
                if delivery_status in {"canceled", "cancelled"}:
                    raise HTTPException(
                        status_code=400,
                        detail="A canceled delivery has no debt left to cover",
                    )
                if str(existing.get("receiptType") or "").upper() == "TRANSFER_IN":
                    raise HTTPException(
                        status_code=400,
                        detail="Transfer-in receipts cannot be covered by company funds",
                    )
                if _financial_outgoing(existing):
                    raise HTTPException(
                        status_code=400,
                        detail="Receipts with outgoing transfers cannot be company-covered",
                    )
                if int(row["last_modified"]) != int(body.expectedLastModified):
                    raise HTTPException(
                        status_code=409, detail="Conflict: receipt has changed"
                    )

                customer_id = ctx["validate_entity_id"](existing.get("customerId"))
                if not customer_id:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt must belong to a customer",
                    )

                assert_financial_period_open("receipts", existing, conn=conn)
                # After a Delivered completion, amountUSD is exactly the
                # customer cash the driver collected; the frozen debt fields
                # stay gross. Net that cash out so an UNDERPAID receipt only
                # offers its true shortfall for coverage.
                already_collected_minor = (
                    _financial_minor(existing.get("amountUSD"), "collected receipt amount")
                    if delivery_status == "delivered"
                    else 0
                )
                (
                    gross_minor,
                    covered_before_minor,
                    outstanding_before_minor,
                    _source,
                ) = _read_company_coverage_state(
                    existing,
                    ctx["financial_due_total"],
                    collected_minor=already_collected_minor,
                )
                if int(body.amountMinorUSD) > outstanding_before_minor:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt outstanding liability is smaller than requested amount",
                    )

                ad_rows = ctx["financial_active_rows_for_receipt_bounded"](
                    conn, receipt_id
                )
                candidates = []
                for ad_row in ad_rows:
                    if bool(ad_row.get("deleted")):
                        continue
                    ad_data = ctx["financial_row_data"](ad_row)
                    if str(ad_data.get("recordType") or "") == "receipt":
                        continue
                    # A rowless driver ad (no due row) is still a candidate:
                    # the planner lands coverage on it as company funding.
                    if (
                        _financial_ad_due_usage(ad_data, receipt_id) <= 0
                        and _financial_rowless_driver_gap(ad_data, receipt_id) <= 0
                    ):
                        continue
                    candidates.append((str(ad_row["id"]), ad_data))

                locked_ads = {}
                locked_ad_rows = []
                for ad_id, _ in sorted(candidates, key=lambda item: item[0]):
                    ad_row = ctx["clothes_lock_row"](
                        conn, "ads", ad_id, postgres=postgres
                    )
                    if not ad_row or bool(ad_row["deleted"]):
                        raise HTTPException(
                            status_code=409,
                            detail="Linked ad is no longer available",
                        )
                    locked_ad_rows.append(
                        (ad_id, ctx["financial_row_data"](ad_row))
                    )
                    locked_ads[ad_id] = ad_row

                plan = plan_company_debt_coverage(
                    receipt_id,
                    amount_minor=int(body.amountMinorUSD),
                    ads=[
                        (ad_id, ad_data)
                        for ad_id, ad_data in sorted(
                            locked_ad_rows, key=lambda item: item[0]
                        )
                    ],
                )
                updated_ads = []
                for item in plan.ads:
                    ad_row = locked_ads[str(item.ad_id)]
                    ad_data = ctx["financial_row_data"](ad_row)
                    assert_financial_period_open(
                        "ads", ad_data if ad_data else {}, conn=conn
                    )
                    assert_financial_period_open("ads", item.data, conn=conn)
                    updated_ads.append(
                        ctx["clothes_write_row"](conn, ad_row, item.data)
                    )

                requested_amount_minor = int(body.amountMinorUSD)
                covered_after_minor = covered_before_minor + requested_amount_minor
                covered_after_minor = min(covered_after_minor, gross_minor)
                # Mirror the BEFORE read: cash a driver already collected
                # (Delivered receipt) is not outstanding either.
                outstanding_after_minor = max(
                    gross_minor - covered_after_minor - already_collected_minor, 0
                )
                saved_receipt = ctx["financial_row_data"](row)
                saved_receipt.update(existing)
                saved_receipt["companyCoverageCount"] = (
                    int(saved_receipt.get("companyCoverageCount") or 0) + 1
                )
                coverage_timestamp = ctx["iso_utc"]()
                saved_receipt["lastCompanyCoverageAt"] = coverage_timestamp

                coverage_id = new_id("receiptCompanyCoverage")
                coverage_data = {
                    "recordType": "companyDebtCoverage",
                    "receiptId": receipt_id,
                    "customerId": customer_id,
                    "amountMinorUSD": requested_amount_minor,
                    "amountUSD": _financial_usd(requested_amount_minor),
                    "reason": reason,
                    "actorId": actor_id,
                    "grossDebtMinorUSD": gross_minor,
                    "grossDebtUSD": _financial_usd(gross_minor),
                    "companyCoveredBeforeMinorUSD": covered_before_minor,
                    "companyCoveredBeforeUSD": _financial_usd(covered_before_minor),
                    "companyCoveredAfterMinorUSD": covered_after_minor,
                    "companyCoveredAfterUSD": _financial_usd(covered_after_minor),
                    "customerOutstandingBeforeMinorUSD": outstanding_before_minor,
                    "customerOutstandingBeforeUSD": _financial_usd(
                        outstanding_before_minor
                    ),
                    "customerOutstandingAfterMinorUSD": outstanding_after_minor,
                    "customerOutstandingAfterUSD": _financial_usd(
                        outstanding_after_minor
                    ),
                    "coveredAt": coverage_timestamp,
                    "unassignedAmountMinorUSD": plan.unassigned_minor,
                    "unassignedAmountUSD": _financial_usd(plan.unassigned_minor),
                    "allocations": [
                        {
                            "adId": item.ad_id,
                            "amountMinorUSD": int(item.moved_minor),
                            "amountUSD": _financial_usd(item.moved_minor),
                        }
                        for item in plan.ads
                    ],
                    "customerPayment": False,
                    "countsAsCustomerRevenue": False,
                    "source": "company_funds",
                }

                saved_receipt["companyCoveredUSD"] = _financial_usd(
                    covered_after_minor
                )
                saved_receipt["customerOutstandingUSD"] = _financial_usd(
                    outstanding_after_minor
                )
                saved_receipt["lastCompanyCoverageId"] = coverage_id
                saved_receipt_row = ctx["clothes_write_row"](
                    conn, row, saved_receipt
                )
                ctx["insert_entity_in_transaction"](
                    conn,
                    RECEIPT_COMPANY_COVERAGE_COLLECTION,
                    coverage_id,
                    coverage_data,
                    actor_id,
                )
                coverage = ctx["financial_entity_result"](
                    conn, RECEIPT_COMPANY_COVERAGE_COLLECTION, coverage_id
                )
                ctx["financial_insert_marker"](
                    conn,
                    RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION,
                    "receiptCompanyCoverage",
                    idem,
                    actor_id,
                    request_hash,
                    {
                        "coverageId": coverage_id,
                        "updatedReceiptIds": [saved_receipt_row["id"]],
                        "updatedAdIds": [item["id"] for item in updated_ads],
                    },
                )
                return ReceiptCompanyCoverageResponse(
                    coverage=EntityResponse(
                        **ctx["project_entity_media_for_user"](
                            coverage, admin, include_media
                        )
                    ),
                    updatedReceipts=[
                        EntityResponse(
                            **ctx["project_entity_media_for_user"](
                                saved_receipt_row, admin, include_media
                            )
                        )
                    ],
                    updatedAds=[
                        EntityResponse(
                            **ctx["project_entity_media_for_user"](
                                item, admin, include_media
                            )
                        )
                        for item in updated_ads
                    ],
                    replayed=False,
                )

    @router.post(
        "/api/customers/{customer_id}/company-coverages",
        response_model=CustomerCompanyCoverageResponse,
    )
    def cover_customer_ad_debt_with_company_funds(
        customer_id: str,
        body: CustomerCompanyCoverageRequest,
        request: Request,
        include_media: bool = True,
        admin: dict[str, Any] = Depends(require_admin_dependency),
    ):
        """Absorb a customer's RECEIPT-LESS ad-spend debt from company funds.

        Never a customer payment and never revenue: each covered dollar lands
        in ``companyDirectCoverageUSD`` on the ad it relieves, with a full
        audit record. Ads funded by receipts are untouched — their debt is
        covered through the receipt flow instead.
        """
        require_same_origin(request)
        customer_id = ctx["validate_entity_id"](customer_id)
        idem = ctx["sanitize_str"](body.idempotencyKey, 120)
        reason = ctx["sanitize_str"](body.reason, 500)
        if not reason:
            raise HTTPException(
                status_code=400,
                detail="A business reason is required for company coverage",
            )
        request_hash = ctx["financial_request_hash"](
            {
                "customerId": customer_id,
                "amountMinorUSD": int(body.amountMinorUSD),
                "expectedOutstandingMinorUSD": int(body.expectedOutstandingMinorUSD),
                "reason": reason,
            }
        )
        actor_id = ctx["validate_entity_id"](admin.get("id"))
        postgres = str(get_engine().dialect.name or "") == "postgresql"
        guard = nullcontext() if postgres else ctx["sqlite_financial_lock"]()
        with guard:
            with db_conn() as conn:
                ctx["lock_idempotency_key"](
                    conn,
                    idem,
                    postgres=postgres,
                    namespace="customerCompanyCoverage",
                )
                prior = ctx["financial_check_marker"](
                    ctx["financial_get_marker"](
                        conn,
                        RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION,
                        "customerCompanyCoverage",
                        idem,
                    ),
                    actor_id,
                    request_hash,
                )
                if prior:
                    coverage = ctx["financial_entity_result"](
                        conn,
                        RECEIPT_COMPANY_COVERAGE_COLLECTION,
                        str(prior.get("coverageId") or ""),
                    )
                    updated_ads = [
                        ctx["financial_entity_result"](conn, "ads", str(ad_id))
                        for ad_id in (prior.get("updatedAdIds") or [])
                    ]
                    return CustomerCompanyCoverageResponse(
                        coverage=EntityResponse(**coverage),
                        updatedAds=[EntityResponse(**item) for item in updated_ads],
                        replayed=True,
                    )

                # Money mutations lock receipts -> sorted ads -> customers.
                # Reading the customer here is only discovery: locking it
                # before ads deadlocked with ordinary ad edits holding an ad
                # while waiting for this same customer row.
                customer_row = ctx["clothes_lock_row"](
                    conn, "customers", customer_id, postgres=False
                )
                if not customer_row or bool(customer_row["deleted"]):
                    raise HTTPException(status_code=404, detail="Customer not found")

                if postgres:
                    customer_expr = "(data_json::jsonb ->> 'customerId')"
                else:
                    customer_expr = "json_extract(data_json, '$.customerId')"
                ad_id_rows = conn.execute(
                    text(
                        "SELECT id FROM entities WHERE type='ads' AND deleted=false "
                        f"AND {customer_expr} = :customer_id ORDER BY id"
                    ),
                    {"customer_id": customer_id},
                ).mappings().all()

                receipt_lookup = make_receipt_lookup(conn)
                plans: list[tuple[str, Any, dict[str, Any], int]] = []
                total_gap_minor = 0
                for ad_id_row in ad_id_rows:
                    ad_row = ctx["clothes_lock_row"](
                        conn, "ads", str(ad_id_row["id"]), postgres=postgres
                    )
                    if not ad_row or bool(ad_row["deleted"]):
                        continue
                    ad_data = ctx["financial_row_data"](ad_row)
                    # Re-verify ownership from the LOCKED row — the id list
                    # was gathered before the lock, and coverage must never
                    # land on an ad that was just reassigned elsewhere.
                    if str(ad_data.get("customerId") or "") != customer_id:
                        continue
                    gap_minor = coverable_ad_debt_minor(
                        ad_data, receipt_lookup=receipt_lookup
                    )
                    if gap_minor <= 0:
                        continue
                    plans.append((str(ad_id_row["id"]), ad_row, ad_data, gap_minor))
                    total_gap_minor += gap_minor

                customer_row = ctx["clothes_lock_row"](
                    conn, "customers", customer_id, postgres=postgres
                )
                if not customer_row or bool(customer_row["deleted"]):
                    raise HTTPException(status_code=404, detail="Customer not found")
                # Creation/reassignment may complete while we wait for locks.
                # Never cover a stale subset or acquire a new ad lock after
                # the customer lock: return a retryable conflict instead.
                current_ad_ids = conn.execute(
                    text(
                        "SELECT id FROM entities WHERE type='ads' AND deleted=false "
                        f"AND {customer_expr} = :customer_id ORDER BY id"
                    ), {"customer_id": customer_id},
                ).scalars().all()
                if current_ad_ids != [row["id"] for row in ad_id_rows]:
                    raise HTTPException(status_code=409, detail="Customer ads changed; refresh and review the current debt")

                if int(body.expectedOutstandingMinorUSD) != total_gap_minor:
                    raise HTTPException(
                        status_code=409,
                        detail="Customer ad debt changed; refresh and review the current amount",
                    )
                if int(body.amountMinorUSD) > total_gap_minor:
                    raise HTTPException(
                        status_code=409,
                        detail="Customer ad debt is smaller than the requested amount",
                    )

                remaining_minor = int(body.amountMinorUSD)
                updated_ads = []
                allocations: list[dict[str, Any]] = []
                for ad_id, ad_row, ad_data, gap_minor in plans:
                    if remaining_minor <= 0:
                        break
                    applied_minor = min(gap_minor, remaining_minor)
                    assert_financial_period_open("ads", ad_data, conn=conn)
                    next_ad = dict(ad_data)
                    next_ad["companyDirectCoverageUSD"] = _financial_usd(
                        _financial_ad_direct_coverage(ad_data) + applied_minor
                    )
                    updated_ads.append(ctx["clothes_write_row"](conn, ad_row, next_ad))
                    allocations.append(
                        {
                            "adId": ad_id,
                            "amountMinorUSD": applied_minor,
                            "amountUSD": _financial_usd(applied_minor),
                        }
                    )
                    remaining_minor -= applied_minor

                requested_amount_minor = int(body.amountMinorUSD)
                coverage_timestamp = ctx["iso_utc"]()
                coverage_id = new_id("receiptCompanyCoverage")
                coverage_data = {
                    "recordType": "companyDebtCoverage",
                    "coverageScope": "customer_ads",
                    "customerId": customer_id,
                    "amountMinorUSD": requested_amount_minor,
                    "amountUSD": _financial_usd(requested_amount_minor),
                    "reason": reason,
                    "actorId": actor_id,
                    "adDebtBeforeMinorUSD": total_gap_minor,
                    "adDebtBeforeUSD": _financial_usd(total_gap_minor),
                    "adDebtAfterMinorUSD": total_gap_minor - requested_amount_minor,
                    "adDebtAfterUSD": _financial_usd(
                        total_gap_minor - requested_amount_minor
                    ),
                    "coveredAt": coverage_timestamp,
                    "allocations": allocations,
                    "customerPayment": False,
                    "countsAsCustomerRevenue": False,
                    "source": "company_funds",
                }
                ctx["insert_entity_in_transaction"](
                    conn,
                    RECEIPT_COMPANY_COVERAGE_COLLECTION,
                    coverage_id,
                    coverage_data,
                    actor_id,
                )
                coverage = ctx["financial_entity_result"](
                    conn, RECEIPT_COMPANY_COVERAGE_COLLECTION, coverage_id
                )
                ctx["financial_insert_marker"](
                    conn,
                    RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION,
                    "customerCompanyCoverage",
                    idem,
                    actor_id,
                    request_hash,
                    {
                        "coverageId": coverage_id,
                        "updatedAdIds": [item["id"] for item in updated_ads],
                    },
                )
                return CustomerCompanyCoverageResponse(
                    coverage=EntityResponse(
                        **ctx["project_entity_media_for_user"](
                            coverage, admin, include_media
                        )
                    ),
                    updatedAds=[
                        EntityResponse(
                            **ctx["project_entity_media_for_user"](
                                item, admin, include_media
                            )
                        )
                        for item in updated_ads
                    ],
                    replayed=False,
                )

    @router.get("/api/admin/company-coverage/legacy-link-gap-scan")
    def admin_company_coverage_legacy_link_gap_scan(
        admin: dict[str, Any] = Depends(require_admin_dependency),
    ):
        """Read-only headcount of real customer debt currently invisible to
        both company-fund coverage paths (a legacy-linked ad whose funding
        receipt has itself stopped tracking debt). Changes nothing; sizes
        the gap before any change to coverable_ad_debt_minor itself."""
        _rate_limit_or_429(f"coverage-scan:{admin.get('id')}", 30, 60_000)
        with db_conn() as conn:
            return scan_legacy_link_coverage_gap(
                conn, financial_due_total=ctx["financial_due_total"]
            )

    @router.get("/api/admin/company-coverage/unfunded-ad-spend-scan")
    def admin_company_coverage_unfunded_ad_spend_scan(
        admin: dict[str, Any] = Depends(require_admin_dependency),
    ):
        """Read-only: every ad whose spend exceeds its funding, grouped by the
        rule that decides whether company funds may cover it. The direct
        measure of how much real debt the button does not offer, and why."""
        _rate_limit_or_429(f"coverage-scan:{admin.get('id')}", 30, 60_000)
        with db_conn() as conn:
            return scan_unfunded_ad_spend(conn)

    @router.get("/api/admin/company-coverage/customer-explain/{customer_id}")
    def admin_company_coverage_customer_explain(
        customer_id: str,
        admin: dict[str, Any] = Depends(require_admin_dependency),
    ):
        """Read-only: the exact rule that decided each of one customer's ads,
        for diagnosing a missing "pay debt from company funds" button."""
        _rate_limit_or_429(f"coverage-scan:{admin.get('id')}", 30, 60_000)
        customer_id = ctx["validate_entity_id"](customer_id)
        with db_conn() as conn:
            return explain_customer_company_coverage(
                conn, customer_id, financial_due_total=ctx["financial_due_total"]
            )

    return router
