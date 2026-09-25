"""Albayan Studio wallet summary: the four numbers, from the ledger (plan task P1-07; PLAN.md §7.8).

``GET /api/studio/wallet/summary`` (any signed-in user, lapsed customers too; always the caller's
own wallet: the route takes no user parameter). The ledger is read only through the platform door
wallet_payments (wallet_ledger_rows, wallet_campaign_holds_minor, pending_payment_requests); the
requests and Meta results through studio_results. Amounts are USD minor units. LYD rows (plans)
are never mixed into them: ``lyd.balanceMinor`` stands apart, other currencies are left out.

The four numbers, plus one that the screen shows only when it is not zero:

* **Available** = USD ledger balance - Reserved: the same number every debit checks
  (wallet_payments.wallet_available_minor).
* **Reserved** = the budgets of the owner's Submitted requests
  (wallet_payments.wallet_campaign_holds_minor), listed per request in ``reserved``. Each item's
  ``budgetMinor`` is what that request holds (campaign_hold_minor: a daily request from P1 on
  holds daily x days, shown also as ``dailyMinor`` and ``days``), so the items add up to
  ``reservedMinor``.
* **In your ads** = for each paid cycle (one ``cpay:`` ledger row) whose request is Approved in
  that cycle: paid - returned. ``metaUsedInAdsMinor`` adds Meta's confirmed spend of the linked
  and checked ones (null when there is none: an unlinked ad never shows a Meta-used value);
  ``metaCheckedAt`` is the oldest of their checks. A cycle whose request is still Submitted in it
  (an approval between its capture and its status write, state ``approving``) counts here too;
  its budget then also sits in Reserved, which only understates Available (PLAN.md §7.8).
* **Being returned** = paid - returned for a cycle its request left (sent back, rejected,
  withdrawn, resubmitted or archived) before the return was written: normally minutes.
* **Spent** = paid - returned for a cycle its request closed (Stopped), archived requests
  included, so archiving never changes it. A payment whose request cannot be found at all counts
  here (nothing would ever return it) with ``requestMissing`` in its chain.
* **Added** = charges (``payreq:`` credits), admin credits and transfers received.
  **Adjustments** = every other row that is not campaign money: transfers sent (-), admin
  reversals of non-campaign rows (+/-), legacy USD plan payments, a return that joins no payment.

A cycle's returns are the rows that point at its ``cpay`` row (``referenceType`` 'reversalOf' and
``referenceId`` = the cpay row id; also found by their keys ``rel:{cpay key}``,
``stoprefund:{cpay key}`` and an old admin ``rev:{cpay row id}``). So every ledger row is counted
exactly once, and (tested, PLAN.md §7.8):

    added + adjustments - in ads - being returned - spent = available + reserved

``chains`` shows each paid cycle as its money steps with the plain ledger labels (EN/AR);
``inAds`` lists the requests behind In your ads. ``pendingPayments`` lists charges waiting for
confirmation (``dueAt`` stays null until the service-hours helper, P3-16). Nothing here names
who confirmed, credited or reviewed anything, and the route passes its answer through
studio_privacy.redact_staff_identity (P1-05) so a field added later cannot either.
"""

from collections import defaultdict
from datetime import datetime
from typing import Any, Callable

from fastapi import APIRouter, Depends, Request

from sqlalchemy import text

from ...db import db_conn
from ...wallet_payments import (
    _campaign_payment_key,
    campaign_hold_minor,
    pending_payment_requests,
    wallet_campaign_holds_minor,
    wallet_ledger_rows,
)
from . import studio_results
from .studio_privacy import redact_staff_identity
from .studio_results import (
    create_studio_results_router,
    derive_display_stage,
    load_owner_requests,
    load_owner_results,
    minor,
    summary_rate_limit,
)

USD = "USD"
LYD = "LYD"
CAMPAIGN_PAYMENT = "campaign_payment"
NAME_MAX = 200

# Ledger labels (PLAN.md §7.8); {name} is the request's own name.
STEP_LABELS: dict[str, dict[str, str]] = {
    "cpay": {"en": "Ad budget paid: {name}", "ar": "دفع ميزانية إعلان: {name}"},
    "rel": {"en": "Ad budget returned (not approved)", "ar": "استرجاع ميزانية إعلان لم يُعتمد"},
    "stoprefund": {"en": "Unused budget returned from: {name}", "ar": "استرجاع ما لم تصرفه ميتا من: {name}"},
    "rev": {"en": "Correction by Albayan", "ar": "تصحيح من الإدارة"},
}
_UNNAMED = {"en": "your ad", "ar": "إعلانك"}
# chain state -> the number it counts in
BUCKETS = {"in_ads": "inAds", "approving": "inAds", "being_returned": "beingReturned", "spent": "spent"}


def _signed(row: dict[str, Any], uid: str) -> int:
    amount = int(row["amountMinor"])
    return (amount if row["toUserId"] == uid else 0) - (amount if row["fromUserId"] == uid else 0)


def cycle_state(request: dict[str, Any] | None, pay_key: str) -> str:
    """Which number one paid cycle counts in: 'in_ads', 'approving', 'being_returned' or 'spent'.

    The request's status decides only while the request is still in that cycle (its own payment
    key, from ``submittedAt``, is this one); a request that moved on left the cycle.
    """
    if request is None:
        return "spent"
    in_cycle = _campaign_payment_key(request) == pay_key
    status = str(request.get("status") or "Draft")
    if in_cycle and status == "Approved":
        return "in_ads"
    if in_cycle and status == "Stopped":
        return "spent"
    if in_cycle and status == "Submitted" and not request.get("archived"):
        return "approving"
    return "being_returned"


def _return_kind(row: dict[str, Any], pay: dict[str, Any]) -> str:
    key = row["idempotencyKey"]
    if key == f"rel:{pay['idempotencyKey']}":
        return "rel"
    if key == f"stoprefund:{pay['idempotencyKey']}":
        return "stoprefund"
    if key.startswith("rev:"):
        return "rev"
    return {"campaign_payment_release": "rel", "campaign_refund": "stoprefund"}.get(row["type"], "rev")


def _name(request: dict[str, Any] | None) -> str:
    return str((request or {}).get("name") or "").strip()[:NAME_MAX]


def _step(kind: str, row: dict[str, Any], name: str) -> dict[str, Any]:
    labels = STEP_LABELS[kind]
    return {
        "kind": "payment" if kind == "cpay" else "return",
        "ref": kind,
        "transactionId": row["id"],
        "amountMinor": int(row["amountMinor"]),
        "at": row["createdAt"] or None,
        "labels": {
            "en": labels["en"].format(name=name or _UNNAMED["en"]),
            "ar": labels["ar"].format(name=name or _UNNAMED["ar"]),
        },
    }


def _reserved_amounts(request: dict[str, Any]) -> dict[str, Any]:
    """One Reserved item's amounts. ``budgetMinor`` is what the request holds
    (wallet_payments.campaign_hold_minor: its total from P1 on, the same number ``reservedMinor``
    adds up), never one day of a daily budget. A daily request that holds its total also shows
    ``dailyMinor`` and ``days`` (daily x days = budgetMinor); any other request shows them null."""
    held = campaign_hold_minor(request)
    daily, total = minor(request.get("budgetMinorUSD")), minor(request.get("totalBudgetMinorUSD"))
    if str(request.get("budgetType") or "").lower() == "daily" and 0 < daily <= total and total % daily == 0:
        return {"budgetMinor": held, "dailyMinor": daily, "days": total // daily}
    return {"budgetMinor": held, "dailyMinor": None, "days": None}


def compute_wallet_summary(
    owner_id: str,
    ledger: list[dict[str, Any]],
    requests: list[dict[str, Any]],
    results: dict[str, dict[str, Any]],
    reserved_minor: int,
    pending: list[dict[str, Any]],
    now: datetime,
) -> dict[str, Any]:
    """The summary from rows already read (pure; see the module docstring for every rule)."""
    uid = str(owner_id or "")
    usd_rows = [row for row in ledger if row["currency"] == USD]
    by_request = {request["id"]: request for request in requests}
    payments = [
        row for row in usd_rows
        if row["type"] == CAMPAIGN_PAYMENT and row["fromUserId"] == uid and row["toUserId"] != uid
        and row["idempotencyKey"].startswith("cpay:")
    ]
    pay_by_id = {pay["id"]: pay for pay in payments}
    pay_by_key = {pay["idempotencyKey"]: pay for pay in payments}

    returns: dict[str, list[dict[str, Any]]] = defaultdict(list)
    joined: set[str] = set()
    for row in usd_rows:
        if row["id"] in pay_by_id or row["toUserId"] != uid or row["fromUserId"] == uid:
            continue
        key = row["idempotencyKey"]
        target = row["referenceId"] if row["referenceType"] == "reversalOf" and row["referenceId"] in pay_by_id else ""
        for prefix in ("rel:", "stoprefund:"):
            if not target and key.startswith(prefix) and key[len(prefix):] in pay_by_key:
                target = pay_by_key[key[len(prefix):]]["id"]
        if not target and key.startswith("rev:") and key[4:] in pay_by_id:
            target = key[4:]
        if target:
            returns[target].append(row)
            joined.add(row["id"])

    added = adjustments = 0
    for row in usd_rows:
        if row["id"] in pay_by_id or row["id"] in joined:
            continue
        if row["type"] in ("credit", "transfer") and row["toUserId"] == uid and row["fromUserId"] != uid:
            added += int(row["amountMinor"])
        else:
            adjustments += _signed(row, uid)

    totals = {"inAds": 0, "beingReturned": 0, "spent": 0}
    chains: list[dict[str, Any]] = []
    in_ads: list[dict[str, Any]] = []
    meta_used_total: int | None = None
    meta_checked: list[str] = []
    for pay in payments:
        request = by_request.get(pay["referenceId"])
        name = _name(request)
        pay_returns = sorted(returns.get(pay["id"], []), key=lambda row: row["createdAt"])
        returned = sum(int(row["amountMinor"]) for row in pay_returns)
        net = int(pay["amountMinor"]) - returned
        state = cycle_state(request, pay["idempotencyKey"])
        totals[BUCKETS[state]] += net
        meta_used = checked_at = None
        stale = False
        if state == "in_ads" and request is not None:
            stage = derive_display_stage(request, results.get(request["id"]), now)
            meta_used, checked_at, stale = stage["metaUsedMinor"], stage["checkedAt"], stage["stale"]
            if meta_used is not None:
                meta_used_total = (meta_used_total or 0) + meta_used
                if checked_at:
                    meta_checked.append(checked_at)
        if BUCKETS[state] == "inAds" and net:
            in_ads.append({
                "campaignId": pay["referenceId"], "name": name, "paidMinor": int(pay["amountMinor"]),
                "returnedMinor": returned, "inAdsMinor": net, "approving": state == "approving",
                "metaUsedMinor": meta_used, "checkedAt": checked_at, "stale": stale,
            })
        chains.append({
            "campaignId": pay["referenceId"],
            "name": name,
            "archived": bool((request or {}).get("archived")),
            "requestMissing": request is None,
            "state": "returned" if pay_returns and net == 0 else state,
            "bucket": BUCKETS[state],
            "paidMinor": int(pay["amountMinor"]),
            "returnedMinor": returned,
            "netMinor": net,
            "paidAt": pay["createdAt"] or None,
            "metaUsedMinor": meta_used,
            "checkedAt": checked_at,
            "steps": [_step("cpay", pay, name)] + [_step(_return_kind(row, pay), row, name) for row in pay_returns],
        })
    chains.sort(key=lambda chain: str(chain["paidAt"] or ""), reverse=True)

    balance = sum(_signed(row, uid) for row in usd_rows)
    reserved_list = [
        {"campaignId": request["id"], "name": _name(request), "submittedAt": str(request.get("submittedAt") or "") or None,
         **_reserved_amounts(request)}
        for request in requests
        if not request.get("archived") and str(request.get("status") or "") == "Submitted"
        and campaign_hold_minor(request) > 0
    ]
    reserved_list.sort(key=lambda item: str(item["submittedAt"] or ""), reverse=True)
    return {
        "usd": {
            "addedMinor": added,
            "adjustmentsMinor": adjustments,
            "reservedMinor": int(reserved_minor),
            "inAdsMinor": totals["inAds"],
            "metaUsedInAdsMinor": meta_used_total,
            "metaCheckedAt": min(meta_checked) if meta_checked else None,
            "beingReturnedMinor": totals["beingReturned"],
            "spentMinor": totals["spent"],
            "availableMinor": balance - int(reserved_minor),
        },
        "reserved": reserved_list,
        "inAds": in_ads,
        "chains": chains,
        "lyd": {"balanceMinor": sum(_signed(row, uid) for row in ledger if row["currency"] == LYD)},
        "pendingPayments": [{**item, "dueAt": None} for item in pending],
    }


def wallet_summary(conn: Any, owner_id: str, now: datetime) -> dict[str, Any]:
    """Read everything on one connection, then compute (see compute_wallet_summary)."""
    uid = str(owner_id or "")
    if conn.dialect.name == "postgresql":
        # The five reads below must describe one instant: an approval or stop committing between
        # two READ COMMITTED snapshots would give wrong numbers that still satisfy the identity.
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
    ledger = wallet_ledger_rows(conn, uid)
    requests = load_owner_requests(conn, uid, include_archived=True)
    results = load_owner_results(conn, uid, (request["id"] for request in requests))
    reserved = wallet_campaign_holds_minor(conn, uid)
    pending = pending_payment_requests(conn, uid)
    return compute_wallet_summary(uid, ledger, requests, results, reserved, pending, now)


def create_studio_summaries_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """The read-only customer summaries under /api/studio: ``GET /wallet/summary`` (here) and
    ``GET /campaigns/summary`` (studio_results). Each is rate limited per user (studio_errors
    ``RATE_LIMITED``) and answers for the signed-in user only."""
    router = APIRouter()

    @router.get("/wallet/summary")
    def get_wallet_summary(user: dict[str, Any] = Depends(current_user_dependency)):
        summary_rate_limit(user, "wallet-summary")
        with db_conn() as conn:
            summary = wallet_summary(conn, str(user.get("id") or ""), studio_results.utc_now())
        return redact_staff_identity(summary, user)  # P1-05: never a staff id, even from a future field

    router.include_router(create_studio_results_router(
        current_user_dependency=current_user_dependency, require_same_origin=require_same_origin, ctx=ctx,
    ))
    return router
