"""Company-funded customer-debt coverage planning and transactional route.

Coverage moves explicit debt allocations into a separate company funding pool.
It never marks a receipt paid/collected and never changes a customer-paid
allocation. Main-owned locking, validation, and entity helpers are injected
into the focused router so its behavior remains part of the same API contract.
"""

from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from fastapi import APIRouter, Depends, HTTPException, Request

from .db import db_conn, get_engine

from .financial_core import (
    _financial_ad_due_usage,
    _financial_allocation_map,
    _financial_minor,
    _financial_outgoing,
    _financial_rows_from_allocation_map,
    _financial_usd,
)
from .operations import assert_financial_period_open
from .schemas import (
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
    if existing is None or any(
        requested.get(field) != existing.get(field) for field in submitted
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
) -> tuple[int, int, int, int]:
    """Return ``(grossDebt, coveredBefore, outstandingBefore, source)``."""
    gross_minor = financial_due_total(data)
    covered_minor = (
        _financial_minor(data.get("companyCoveredUSD"), "stored companyCoveredUSD")
        if data.get("companyCoveredUSD") is not None
        else 0
    )
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
        outstanding_minor = max(gross_minor - covered_minor, 0)
    source = 1 if data.get("customerOutstandingUSD") is None else 0
    return gross_minor, covered_minor, outstanding_minor, source


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
                if not_paid_collection not in {"", "office", "in_shop", "shop"}:
                    raise HTTPException(
                        status_code=400,
                        detail="Only in-shop office receipts can be covered by company funds",
                    )
                if str(existing.get("deliveryStatus") or "").strip() != "Office":
                    raise HTTPException(
                        status_code=400,
                        detail="Company coverage is only valid for Office delivery status",
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
                (
                    gross_minor,
                    covered_before_minor,
                    outstanding_before_minor,
                    _source,
                ) = _read_company_coverage_state(
                    existing, ctx["financial_due_total"]
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
                    if _financial_ad_due_usage(ad_data, receipt_id) <= 0:
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
                outstanding_after_minor = max(gross_minor - covered_after_minor, 0)
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

    return router
