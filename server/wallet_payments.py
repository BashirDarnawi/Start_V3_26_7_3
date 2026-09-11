"""Ads Studio wallet payments: gateway-ready top-ups and campaign budget money.

The customer charges a USD wallet and spends it on ad campaign requests:

* A TOP-UP starts as a PENDING payment request with a reference code
  (``PAY-XXXXXXXX``). Confirming it credits the wallet through the existing
  idempotent top-up atomic. Today confirmation is an admin action; when a
  Libyan payment gateway (card / bank transfer / QR) is connected, its
  signed callback will call the same confirm path — the flow is designed so
  NOTHING else changes on that day.
* A SUBMITTED campaign implicitly HOLDS its requested budget: available
  balance = ledger balance − Σ budgets of the user's Submitted campaigns.
  Every wallet debit (transfers, subscription purchases, new submissions)
  must respect that available number — one pot, counted once.
* APPROVING a campaign captures the hold: one ``campaign_payment`` ledger
  row (idempotency key ``cpay:{campaignId}`` — a campaign can never pay
  twice) moves the budget to the system account inside the review
  transaction.

This module never talks to Meta and never touches receipts money. All
helpers that already guard the wallet ledger are injected from main via
``ctx`` so no money logic is duplicated.
"""

import math
import secrets
import threading
import time
from contextlib import nullcontext
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, json_dumps, json_loads, now_ms
from .payment_methods import (
    enabled_payment_method_ids,
    get_payment_method,
    latest_usd_lyd_rate,
    public_payment_methods,
)
from .schemas import (
    WalletPaymentReceiptAttach,
    WalletPaymentRequestCreate,
    WalletPaymentRequestDecision,
)

WALLET_PAYMENT_COLLECTION = "walletPaymentRequests"
# Kept only as documentation of the first release's ids (see payment_methods.py).
LEGACY_PAYMENT_METHODS = ("card", "bank_transfer", "qr")


def _lean_payment_entity(entity: dict[str, Any]) -> dict[str, Any]:
    """List rows never carry the receipt photo — flag it instead."""
    data = dict(entity.get("data") or {})
    if data.get("receiptPhoto"):
        data.pop("receiptPhoto", None)
        data["_mediaOmitted"] = True
        data["_photoCount"] = 1
    lean = dict(entity)
    lean["data"] = data
    return lean
MAX_OPEN_PAYMENT_REQUESTS = 5
MIN_PAYMENT_REQUEST_MINOR = 100  # kept for backward references ($1.00)
# currency -> minimum charge in minor units (1.00 of each).
WALLET_PAYMENT_CURRENCIES = {"USD": 100, "LYD": 100}

_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, list[float]] = {}


def _rate_limit(key: str, limit: int, window_seconds: float) -> None:
    now = time.monotonic()
    with _RATE_LOCK:
        bucket = [t for t in _RATE_BUCKETS.get(key, []) if now - t < window_seconds]
        if len(bucket) >= limit:
            raise HTTPException(status_code=429, detail="Too many wallet payment requests")
        bucket.append(now)
        _RATE_BUCKETS[key] = bucket


def _new_payment_reference() -> str:
    # No 0/O/1/I: the customer reads this code to a bank teller or QR app.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "PAY-" + "".join(secrets.choice(alphabet) for _ in range(8))


def wallet_campaign_holds_minor(conn: Any, user_id: str) -> int:
    """USD cents promised to the user's SUBMITTED (not yet decided) campaigns.

    A submitted campaign is a promise to spend: the money must stay in the
    wallet until the reviewer decides. Approval converts the hold into a
    ``campaign_payment`` ledger row in the same transaction, so there is
    never a moment where the budget is both 'available' and 'promised'.
    """
    total = 0
    rows = conn.execute(
        text(
            "SELECT data_json FROM entities WHERE type = 'adCampaignRequests' "
            "AND deleted = false AND created_by = :uid"
        ),
        {"uid": str(user_id or "")},
    ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("status") or "") != "Submitted":
            continue
        try:
            total += max(int(data.get("budgetMinorUSD") or 0), 0)
        except (TypeError, ValueError, OverflowError):
            continue
    return total


def wallet_available_minor(conn: Any, ctx: dict[str, Any], user_id: str, currency: str) -> int:
    """Spendable balance: the ledger minus everything promised to campaigns."""
    balance = ctx["wallet_balance_minor"](conn, user_id, currency)
    if str(currency or "").upper() == "USD":
        balance -= wallet_campaign_holds_minor(conn, user_id)
    return balance


def _campaign_payment_key(campaign: dict[str, Any]) -> str:
    """One payment per SUBMISSION CYCLE: budgets are frozen while Submitted
    (edits are only allowed in Draft/Changes Requested), so scoping the key
    by submittedAt makes replays always consistent — a crashed approval that
    retries pays once, while a later resubmission with a new budget gets a
    fresh key (its predecessor was released on the reject that unlocked it)."""
    campaign_id = str(campaign.get("id") or "")
    cycle = str(campaign.get("submittedAt") or "").strip()
    return f"cpay:{campaign_id}:{cycle}" if cycle else f"cpay:{campaign_id}"


def capture_campaign_budget(
    conn: Any, ctx: dict[str, Any], campaign: dict[str, Any], actor_id: str
) -> str:
    """Turn an approved campaign's hold into a real ledger payment.

    Called by the review endpoint BEFORE the Approved status write, with the
    campaign still ``Submitted``. The cycle-scoped idempotency key makes a
    double approval (or a crash retry) pay at most once. Raises 409 when the
    wallet can no longer cover the budget (money left through another path
    after submission): the approval then fails as a whole.
    """
    campaign_id = str(campaign.get("id") or "")
    owner_id = str(campaign.get("createdBy") or "")
    try:
        budget = max(int(campaign.get("budgetMinorUSD") or 0), 0)
    except (TypeError, ValueError, OverflowError):
        budget = 0
    if not campaign_id or not owner_id:
        raise HTTPException(status_code=409, detail="Campaign is missing its owner")
    if budget <= 0:
        raise HTTPException(status_code=400, detail="An approved campaign needs a budget greater than zero")
    idem = _campaign_payment_key(campaign)
    ctx["lock_idempotency_key"](conn, idem, postgres=ctx["is_postgres"]())
    prior = ctx["find_entity_by_idempotency"](conn, "walletTransactions", idem)
    if prior:
        return str(prior.get("id") or "")
    # FRESH, LOCKED status check: a concurrent reject may have already moved
    # the campaign out of Submitted (and released this cycle). Capturing on a
    # stale snapshot would pay for a campaign that is not being approved.
    suffix = " FOR UPDATE" if ctx["is_postgres"]() else ""
    row = conn.execute(
        text(
            "SELECT data_json FROM entities WHERE type = 'adCampaignRequests' "
            f"AND id = :id AND deleted = false LIMIT 1{suffix}"
        ),
        {"id": campaign_id},
    ).mappings().first()
    live = json_loads((row or {}).get("data_json") or "{}") or {}
    if (
        not row
        or str(live.get("status") or "") != "Submitted"
        or str(live.get("submittedAt") or "") != str(campaign.get("submittedAt") or "")
    ):
        raise HTTPException(
            status_code=409,
            detail="Campaign is no longer awaiting review — refresh and try again",
        )
    # The campaign is still Submitted here, so its own budget sits inside the
    # holds sum: the ledger must simply cover ALL holds for this capture.
    balance = ctx["wallet_balance_minor"](conn, owner_id, "USD")
    if balance < wallet_campaign_holds_minor(conn, owner_id):
        raise HTTPException(
            status_code=409,
            detail="Customer wallet can no longer cover this campaign budget",
        )
    data = {
        "type": "campaign_payment",
        "schemaVersion": 2,
        "amountMinor": budget,
        "amount": budget / 100,
        "currency": "USD",
        "fromUserId": owner_id,
        "toUserId": "system",
        "memo": f"Ad campaign budget {campaign_id}",
        "idempotencyKey": idem,
        "status": "posted",
        "referenceType": "adCampaignRequest",
        "referenceId": campaign_id,
        "createdAt": ctx["iso_utc"](),
    }
    saved = ctx["insert_entity_in_transaction"](
        conn, "walletTransactions", None, data, actor_id
    )
    return str(saved.get("id") or "")


def release_orphan_campaign_payment(
    conn: Any, ctx: dict[str, Any], campaign: dict[str, Any], actor_id: str
) -> str:
    """Refund a campaign payment left behind by a crashed approval.

    Runs on Reject/Changes Requested. Normally there is NOTHING to do — the
    payment for this submission cycle only exists if a previous Approved
    attempt crashed between its capture and its status write. Deterministic
    key: at most one release per cycle, replay-safe.
    """
    pay_key = _campaign_payment_key(campaign)
    prior = ctx["find_entity_by_idempotency"](conn, "walletTransactions", pay_key)
    if not prior:
        return ""
    if ctx["find_entity_by_idempotency"](
        conn, "walletTransactions", f"rev:{str(prior.get('id') or '')}"
    ):
        # An admin already returned this capture with the raw reversal tool
        # (legacy door, now closed for campaign rows) — never pay twice.
        return ""
    paid = prior.get("data") or {}
    idem = f"rel:{pay_key}"
    ctx["lock_idempotency_key"](conn, idem, postgres=ctx["is_postgres"]())
    existing = ctx["find_entity_by_idempotency"](conn, "walletTransactions", idem)
    if existing:
        return str(existing.get("id") or "")
    amount = int(paid.get("amountMinor") or 0)
    owner_id = str(paid.get("fromUserId") or "")
    if amount <= 0 or not owner_id:
        return ""
    data = {
        "type": "campaign_payment_release",
        "schemaVersion": 2,
        "amountMinor": amount,
        "amount": amount / 100,
        "currency": "USD",
        "fromUserId": "system",
        "toUserId": owner_id,
        "memo": f"Release of unapproved campaign payment {str(campaign.get('id') or '')}",
        "idempotencyKey": idem,
        "status": "posted",
        "referenceType": "reversalOf",
        "referenceId": str(prior.get("id") or ""),
        "createdAt": ctx["iso_utc"](),
    }
    saved = ctx["insert_entity_in_transaction"](
        conn, "walletTransactions", None, data, actor_id
    )
    return str(saved.get("id") or "")


def campaign_capture_open_minor(conn: Any, ctx: dict[str, Any], campaign: dict[str, Any]) -> int:
    """Captured money for this campaign's paid cycle that never went back.

    0 when nothing was captured, or when the money already returned through
    ANY door: ``stoprefund:`` (stop), ``rel:`` (crashed-approval release) or
    an admin ``rev:{cpay-row-id}`` reversal made before that tool was closed
    for campaign rows. Used by delete to refuse forfeiting a live capture.
    """
    pay_key = _campaign_payment_key(campaign)
    prior = ctx["find_entity_by_idempotency"](conn, "walletTransactions", pay_key)
    if not prior:
        return 0
    for returned_key in (
        f"rel:{pay_key}",
        f"stoprefund:{pay_key}",
        f"rev:{str(prior.get('id') or '')}",
    ):
        if ctx["find_entity_by_idempotency"](conn, "walletTransactions", returned_key):
            return 0
    return max(int((prior.get("data") or {}).get("amountMinor") or 0), 0)


def refund_stopped_campaign_budget(
    conn: Any, ctx: dict[str, Any], campaign: dict[str, Any], actor_id: str, refund_minor: int
) -> str:
    """At-most-once refund row for a stopping Approved campaign.

    Key ``stoprefund:{cpay-key}``: the paid cycle can refund once, ever.
    The captured amount is read from the ORIGINAL ``cpay`` ledger row (never
    the campaign's own numbers) and the refund may not exceed it, so the
    system account can never pay out more than it took. A ``rel:`` release
    for the same cycle (crashed-approval money already returned) makes this
    refuse — captured money returns through exactly one door.
    Runs inside the caller's locked stop transaction; a failed status write
    rolls this row back with it. Replay returns the prior row's id.
    """
    pay_key = _campaign_payment_key(campaign)
    prior = ctx["find_entity_by_idempotency"](conn, "walletTransactions", pay_key)
    if not prior:
        raise HTTPException(
            status_code=409,
            detail="No captured payment exists for this campaign cycle",
        )
    paid = prior.get("data") or {}
    captured = int(paid.get("amountMinor") or 0)
    owner_id = str(paid.get("fromUserId") or "")
    if not owner_id or captured <= 0:
        raise HTTPException(status_code=409, detail="The captured payment row is not refundable")
    if refund_minor <= 0 or refund_minor > captured:
        raise HTTPException(
            status_code=400,
            detail="Refund must be between 1 cent and the captured budget",
        )
    if ctx["find_entity_by_idempotency"](conn, "walletTransactions", f"rel:{pay_key}"):
        raise HTTPException(
            status_code=409,
            detail="This campaign cycle's payment was already returned",
        )
    if ctx["find_entity_by_idempotency"](
        conn, "walletTransactions", f"rev:{str(prior.get('id') or '')}"
    ):
        raise HTTPException(
            status_code=409,
            detail="This campaign's payment was already reversed by an admin",
        )
    idem = f"stoprefund:{pay_key}"
    ctx["lock_idempotency_key"](conn, idem, postgres=ctx["is_postgres"]())
    existing = ctx["find_entity_by_idempotency"](conn, "walletTransactions", idem)
    if existing:
        return str(existing.get("id") or "")
    data = {
        "type": "campaign_refund",
        "schemaVersion": 2,
        "amountMinor": int(refund_minor),
        "amount": int(refund_minor) / 100,
        "currency": "USD",
        "fromUserId": "system",
        "toUserId": owner_id,
        "memo": f"Refund of stopped campaign {str(campaign.get('id') or '')}",
        "idempotencyKey": idem,
        "status": "posted",
        "referenceType": "reversalOf",
        "referenceId": str(prior.get("id") or ""),
        "createdAt": ctx["iso_utc"](),
    }
    saved = ctx["insert_entity_in_transaction"](
        conn, "walletTransactions", None, data, actor_id
    )
    return str(saved.get("id") or "")


def _update_payment_row(conn: Any, request_id: str, data: dict[str, Any]) -> None:
    data = dict(data)
    data["_lastModified"] = now_ms()
    conn.execute(
        text(
            "UPDATE entities SET data_json = :d, last_modified = :m "
            "WHERE type = :t AND id = :id AND deleted = false"
        ),
        {
            "d": json_dumps(data),
            "m": int(data["_lastModified"]),
            "t": WALLET_PAYMENT_COLLECTION,
            "id": request_id,
        },
    )


def _load_payment_request(conn: Any, ctx: dict[str, Any], request_id: str, *, lock: bool) -> dict[str, Any]:
    suffix = " FOR UPDATE" if (lock and ctx["is_postgres"]()) else ""
    row = conn.execute(
        text(
            "SELECT * FROM entities WHERE type = :type AND id = :id "
            f"AND deleted = false LIMIT 1{suffix}"
        ),
        {"type": WALLET_PAYMENT_COLLECTION, "id": request_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Payment request not found")
    return ctx["entity_from_db_row"](row)


def create_wallet_payments_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/wallet/payment-requests", tags=["wallet-payments"])

    def _is_admin(user: dict[str, Any]) -> bool:
        return str(user.get("role") or "").lower() == "admin"

    @router.post("")
    def create_payment_request(
        body: WalletPaymentRequestCreate,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        require_same_origin(request)
        uid = str(user.get("id") or "")
        _rate_limit(f"create:{uid}", 10, 60.0)
        amount, cur, idem = ctx["validate_wallet_values"](
            body.amountMinor, body.currency, body.idempotencyKey
        )
        # USD funds ad budgets; LYD funds subscription plans. Same reference
        # flow, same admin/gateway confirm path, independent ledgers.
        if cur not in WALLET_PAYMENT_CURRENCIES:
            raise HTTPException(status_code=400, detail="The wallet is charged in USD or LYD")
        if amount < WALLET_PAYMENT_CURRENCIES[cur]:
            raise HTTPException(status_code=400, detail="Minimum wallet charge is 1.00 of the currency")
        method = str(body.method or "").strip().lower()
        if method not in enabled_payment_method_ids():
            raise HTTPException(status_code=400, detail="Unknown payment method")
        postgres = ctx["is_postgres"]()
        guard = ctx["sqlite_wallet_lock"]() if not postgres else None
        try:
            if guard is not None:
                guard.acquire()
            with db_conn() as conn:
                ctx["lock_idempotency_key"](conn, idem, postgres=postgres, namespace="walletPayment")
                prior = ctx["find_entity_by_idempotency"](conn, WALLET_PAYMENT_COLLECTION, idem)
                if prior:
                    prior_data = prior.get("data") or {}
                    same = (
                        str(prior_data.get("userId") or "") == uid
                        and int(prior_data.get("amountMinor") or 0) == amount
                        # Older requests without a currency were USD-only,
                        # matching the confirmation path's legacy default.
                        and str(prior_data.get("currency") or "USD").strip().upper() == cur
                        and str(prior_data.get("method") or "") == method
                    )
                    if not same:
                        raise HTTPException(status_code=409, detail="Idempotency key was already used for another operation")
                    return prior
                open_count = 0
                for row in conn.execute(
                    text(
                        "SELECT data_json FROM entities WHERE type = :type "
                        "AND deleted = false AND created_by = :uid"
                    ),
                    {"type": WALLET_PAYMENT_COLLECTION, "uid": uid},
                ).mappings().all():
                    data = json_loads(row.get("data_json") or "{}") or {}
                    if str(data.get("status") or "") == "pending":
                        open_count += 1
                if open_count >= MAX_OPEN_PAYMENT_REQUESTS:
                    raise HTTPException(
                        status_code=409,
                        detail="Too many unpaid charge requests — pay or cancel one first",
                    )
                data = {
                    "recordType": "walletPaymentRequest",
                    "userId": uid,
                    "amountMinor": amount,
                    "amount": amount / 100,
                    "currency": cur,
                    "method": method,
                    "note": str(body.note or "").strip()[:500],
                    "reference": _new_payment_reference(),
                    "status": "pending",
                    "idempotencyKey": idem,
                    "createdAt": ctx["iso_utc"](),
                }
                # Permanent LYD stamp: what the customer was told to pay at
                # creation time. Presentation + cash guidance only — the
                # wallet credit stays the USD amountMinor, never restamped.
                # An LYD charge needs no conversion: it already IS the cash.
                rate = latest_usd_lyd_rate() if cur == "USD" else None
                if cur == "LYD":
                    data["amountMinorLYD"] = amount
                if rate:
                    data["lydRate"] = rate[0]
                    data["lydRateDate"] = rate[1]
                    # ceil: never tell an LYD figure that under-covers the USD.
                    data["amountMinorLYD"] = int(math.ceil(amount * rate[0]))
                saved = ctx["insert_entity_in_transaction"](
                    conn, WALLET_PAYMENT_COLLECTION, None, data, uid
                )
            ctx["audit"](str(user.get("id") or ""), "create", WALLET_PAYMENT_COLLECTION, str(saved.get("id") or ""), f"charge {data['reference']}")
            return saved
        finally:
            if guard is not None:
                guard.release()

    @router.get("/methods")
    def list_payment_methods(
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """The Libyan payment channels + today's USD→LYD rate for display."""
        rate = latest_usd_lyd_rate()
        return {
            "methods": public_payment_methods(),
            "rate": {"usdToLyd": rate[0], "date": rate[1]} if rate else None,
        }

    @router.get("")
    def list_payment_requests(
        scope: str = "mine",
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        want_all_pending = str(scope or "").lower() == "pending"
        if want_all_pending and not _is_admin(user):
            raise HTTPException(status_code=403, detail="Admin only")
        uid = str(user.get("id") or "")
        results: list[dict[str, Any]] = []
        with db_conn() as conn:
            # 'mine' scopes in SQL by the real created_by column so only the
            # caller's rows are JSON-decoded (photos make rows heavy). The
            # admin 'pending' scope still scans — pending rows are capped at
            # 5 per user and this endpoint is admin-rare.
            if want_all_pending:
                rows = conn.execute(
                    text("SELECT * FROM entities WHERE type = :type AND deleted = false"),
                    {"type": WALLET_PAYMENT_COLLECTION},
                ).mappings().all()
            else:
                rows = conn.execute(
                    text(
                        "SELECT * FROM entities WHERE type = :type AND deleted = false "
                        "AND created_by = :uid"
                    ),
                    {"type": WALLET_PAYMENT_COLLECTION, "uid": uid},
                ).mappings().all()
        for row in rows:
            entity = ctx["entity_from_db_row"](row)
            data = entity.get("data") or {}
            if want_all_pending:
                if str(data.get("status") or "") == "pending":
                    results.append(_lean_payment_entity(entity))
            elif str(data.get("userId") or "") == uid:
                results.append(_lean_payment_entity(entity))
        results.sort(key=lambda e: str((e.get("data") or {}).get("createdAt") or ""), reverse=True)
        return {"requests": results[:200]}

    @router.get("/{request_id}")
    def get_payment_request(
        request_id: str,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Full row incl. the receipt photo — owner or admin only, 404 others."""
        rid = str(request_id or "").strip()[:80]
        with db_conn() as conn:
            entity = _load_payment_request(conn, ctx, rid, lock=False)
        data = entity.get("data") or {}
        if str(data.get("userId") or "") != str(user.get("id") or "") and not _is_admin(user):
            raise HTTPException(status_code=404, detail="Payment request not found")
        return entity

    @router.post("/{request_id}/receipt")
    def attach_payment_receipt(
        request_id: str,
        body: WalletPaymentReceiptAttach,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """The customer's transfer-receipt photo (bank-transfer methods).

        Owner-only, pending-only, inside the same locked transaction shape as
        confirm/cancel so a racing decision cannot interleave. Re-attaching
        replaces the photo (a blurry shot gets fixed) with a fresh stamp.
        """
        require_same_origin(request)
        uid = str(user.get("id") or "")
        _rate_limit(f"receipt:{uid}", 10, 60.0)
        rid = str(request_id or "").strip()[:80]
        try:
            clean_photo = ctx["validate_receipt_image"](body.photo)
        except HTTPException:
            raise HTTPException(status_code=400, detail="The receipt photo is invalid or too large — use a clear JPG/PNG under 4 MB")
        postgres = ctx["is_postgres"]()
        guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        with guard, db_conn() as conn:
            entity = _load_payment_request(conn, ctx, rid, lock=True)
            data = dict(entity.get("data") or {})
            if str(data.get("userId") or "") != uid:
                # Same 404 as the dedicated GET: no existence oracle.
                raise HTTPException(status_code=404, detail="Payment request not found")
            if str(data.get("status") or "") != "pending":
                raise HTTPException(status_code=409, detail="Only a pending request can take a receipt")
            data.update(
                {
                    "receiptPhoto": clean_photo,
                    "receiptPhotoAt": ctx["iso_utc"](),
                    "receiptNote": str(body.note or "").strip()[:500],
                }
            )
            _update_payment_row(conn, rid, data)
            entity["data"] = data
        ctx["audit"](uid, "attach_receipt", WALLET_PAYMENT_COLLECTION, rid, "")
        return _lean_payment_entity(entity)

    @router.post("/{request_id}/confirm")
    def confirm_payment_request(
        request_id: str,
        body: WalletPaymentRequestDecision,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Credit the wallet for a received payment.

        Admin-only today. When a payment gateway is connected, its signed
        server-to-server callback will drive this same path — the top-up
        idempotency key is derived from the REQUEST id, so a double callback
        (or an admin clicking twice) can never credit twice.
        """
        require_same_origin(request)
        if not _is_admin(user):
            raise HTTPException(status_code=403, detail="Admin only")
        rid = str(request_id or "").strip()[:80]
        provider_ref = str(body.providerRef or "").strip()[:120]
        postgres = ctx["is_postgres"]()
        guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        # ONE locked transaction: the pending check, the wallet credit and the
        # confirmed stamp commit together, so a racing cancel can never leave
        # a credited-but-canceled request (or vice versa).
        with guard, db_conn() as conn:
            fresh = _load_payment_request(conn, ctx, rid, lock=True)
            data = dict(fresh.get("data") or {})
            status = str(data.get("status") or "")
            if status == "confirmed":
                return fresh
            if status != "pending":
                raise HTTPException(status_code=409, detail=f"Payment request is {status or 'invalid'}")
            method_entry = get_payment_method(str(data.get("method") or ""))
            receipt_missing = bool(
                method_entry
                and method_entry.get("requiresReceiptPhoto")
                and not str(data.get("receiptPhoto") or "").strip()
            )
            if receipt_missing and not body.overrideMissingReceipt:
                raise HTTPException(status_code=409, detail="The customer has not attached the transfer receipt yet")
            if receipt_missing:
                # The exception path must stay visible after the fact.
                data["receiptOverriddenBy"] = str(user.get("id") or "")
                data["receiptOverriddenAt"] = ctx["iso_utc"]()
            owner = str(data.get("userId") or "")
            amount = int(data.get("amountMinor") or 0)
            currency = str(data.get("currency") or "USD").upper()
            if not owner or amount <= 0:
                raise HTTPException(status_code=409, detail="Payment request is invalid")
            credit_key = f"payreq:{rid}"
            ctx["lock_idempotency_key"](conn, credit_key, postgres=postgres)
            credit = ctx["find_entity_by_idempotency"](conn, "walletTransactions", credit_key)
            if not credit:
                credit = ctx["insert_entity_in_transaction"](
                    conn,
                    "walletTransactions",
                    None,
                    {
                        "type": "credit",
                        "schemaVersion": 2,
                        "amountMinor": amount,
                        "amount": amount / 100,
                        "currency": currency,
                        "fromUserId": None,
                        "toUserId": owner,
                        "memo": f"Wallet charge {str(data.get('reference') or rid)} ({str(data.get('method') or '')})",
                        "idempotencyKey": credit_key,
                        "status": "posted",
                        "referenceType": WALLET_PAYMENT_COLLECTION,
                        "referenceId": rid,
                        "createdAt": ctx["iso_utc"](),
                    },
                    str(user.get("id") or "system"),
                )
            data.update(
                {
                    "status": "confirmed",
                    "confirmedAt": ctx["iso_utc"](),
                    "confirmedBy": str(user.get("id") or ""),
                    "providerRef": provider_ref,
                    "walletTransactionId": str(credit.get("id") or ""),
                }
            )
            _update_payment_row(conn, rid, data)
            fresh["data"] = data
        ctx["audit"](
            str(user.get("id") or ""), "confirm", WALLET_PAYMENT_COLLECTION, rid,
            f"credited {amount} {currency}" + (" override-missing-receipt" if data.get("receiptOverriddenBy") else ""),
        )
        return fresh

    @router.post("/{request_id}/cancel")
    def cancel_payment_request(
        request_id: str,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        require_same_origin(request)
        rid = str(request_id or "").strip()[:80]
        postgres = ctx["is_postgres"]()
        guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        with guard, db_conn() as conn:
            entity = _load_payment_request(conn, ctx, rid, lock=True)
            data = dict(entity.get("data") or {})
            if str(data.get("userId") or "") != str(user.get("id") or "") and not _is_admin(user):
                # Same 404 as a missing row: another customer must not be able
                # to learn that this request id exists (matches GET/receipt).
                raise HTTPException(status_code=404, detail="Payment request not found")
            status = str(data.get("status") or "")
            if status == "canceled":
                return entity
            if status != "pending":
                raise HTTPException(status_code=409, detail=f"Payment request is {status or 'invalid'}")
            # A credit that already posted for this request means the money is
            # real: the request must be confirmed, never canceled.
            if ctx["find_entity_by_idempotency"](conn, "walletTransactions", f"payreq:{rid}"):
                raise HTTPException(status_code=409, detail="Payment was already received — confirm it instead")
            data.update(
                {
                    "status": "canceled",
                    "canceledAt": ctx["iso_utc"](),
                    "canceledBy": str(user.get("id") or ""),
                }
            )
            _update_payment_row(conn, rid, data)
            entity["data"] = data
        ctx["audit"](str(user.get("id") or ""), "cancel", WALLET_PAYMENT_COLLECTION, rid, "")
        return entity

    return router
