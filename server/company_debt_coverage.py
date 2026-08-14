"""Pure planning helpers for company-funded customer-debt coverage.

This module only moves explicit debt allocations into a separate company
funding pool.  It never marks a receipt paid/collected and never changes a
customer-paid allocation.  Database locking, authorization, periods and audit
are enforced by the transactional API in ``main.py``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .financial_core import (
    _financial_ad_due_usage,
    _financial_allocation_map,
    _financial_rows_from_allocation_map,
    _financial_usd,
)


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
