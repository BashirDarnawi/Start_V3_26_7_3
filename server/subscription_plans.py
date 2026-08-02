"""Subscription plans and bundles: the platform's monetization catalog.

One PLAN sells access to one or more services for a duration:

* Single-service plans keep implicit ``svc:{serviceId}`` ids generated live
  from ``SERVICE_SUBSCRIPTION_CATALOG`` — every legacy purchase path maps to
  them unchanged.
* A BUNDLE lists several serviceIds. Purchasing it mints ONE
  ``serviceSubscriptions`` row per service inside a single transaction, so
  every entitlement checker in the platform (six sites, two languages) keeps
  keying on ``(userId, serviceId, status, expiresAt)`` byte-for-byte
  unchanged. Money truth stays the wallet ledger: exactly one
  ``service_payment`` row per purchase; bundle member rows carry
  ``priceMinor: 0`` and only stamp the informational ``planPriceMinor``.
* Renewal = repurchase: each service extends from ``max(now, its current
  expiry)`` — no lost days, capped by ``MAX_PLAN_STACK_DAYS``.

Prices are server-authoritative: hardcoded defaults overlaid by an
admin-saved, fully validated ``appSettings`` record (append-only history,
``settingKey: subscriptionPlans``). Non-admins only ever see the public
projection endpoint. All main-owned helpers arrive through ``ctx``.
"""

import re
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, json_loads
from .schemas import PlanCatalogUpdateRequest, PlanPurchaseRequest

PLAN_SETTINGS_KEY = "subscriptionPlans"
MAX_PLAN_STACK_DAYS = 3700  # renewal stacking cap (~10 years prepaid)
MAX_PLAN_PRICE_MINOR = 1_000_000_000_000
_PLAN_ID_RE = re.compile(r"^[a-z0-9_:]{2,40}$")

# Extra plans shipped beside the implicit svc:* ones. Zero-priced until the
# owner sets real prices through the admin endpoint.
EXTRA_PLAN_DEFAULTS: dict[str, dict[str, Any]] = {
    "smart_bundle": {
        "id": "smart_bundle",
        "serviceIds": ["clothes_system", "ad_maker"],
        "name": "Smart Business Bundle",
        "nameAr": "باقة الأعمال الذكية",
        "priceMinor": 0,
        "currency": "LYD",
        "durationDays": 30,
        "badge": "best_value",
        "savingsPct": 20,
        "active": True,
        "sortOrder": 5,
    },
}

_SERVICE_PLAN_NAMES: dict[str, tuple[str, str]] = {
    "international_shipping": ("International Shipping", "الشحن الدولي"),
    "local_shipping": ("Local Shipping", "الشحن المحلي"),
    "warehouse": ("Warehouse", "المخزن"),
    "smart_systems": ("Smart Systems", "الأنظمة الذكية"),
    "clothes_system": ("Clothes System", "نظام الملابس"),
    "ad_maker": ("Ads Studio", "استوديو الإعلانات"),
}


def known_service_ids(ctx: dict[str, Any]) -> frozenset[str]:
    return frozenset(ctx["service_subscription_catalog"]().keys())


def default_subscription_plans(ctx: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Implicit svc:* plans generated LIVE from the service catalog (so a
    catalog price change — or a test monkeypatch — flows through) plus the
    shipped extra plans."""
    plans: dict[str, dict[str, Any]] = {}
    order = 10
    for sid, offer in ctx["service_subscription_catalog"]().items():
        names = _SERVICE_PLAN_NAMES.get(sid, (sid, sid))
        plans[f"svc:{sid}"] = {
            "id": f"svc:{sid}",
            "serviceIds": [sid],
            "name": names[0],
            "nameAr": names[1],
            "priceMinor": max(0, int(offer.get("priceMinor") or 0)),
            "currency": str(offer.get("currency") or "LYD"),
            "durationDays": int(offer.get("durationDays") or 30),
            "active": True,
            "sortOrder": order,
        }
        order += 10
    for plan_id, plan in EXTRA_PLAN_DEFAULTS.items():
        plans[plan_id] = dict(plan)
    return plans


def validate_plan_catalog(
    raw: Any,
    previous: dict[str, dict[str, Any]] | None,
    ctx: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Full-catalog validation; raises 400 with the first offending field.

    ``previous`` enforces immutability: a shipped plan id can never change
    its serviceIds (silently widening a cheap plan is an entitlement hole).
    """
    if not isinstance(raw, list) or not raw or len(raw) > 50:
        raise HTTPException(status_code=400, detail="plans must be a list of 1-50 plans")
    known = known_service_ids(ctx)
    clean: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        where = f"plans[{index}]"
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"{where} must be an object")
        plan_id = str(item.get("id") or "")
        if not _PLAN_ID_RE.fullmatch(plan_id):
            raise HTTPException(status_code=400, detail=f"{where}.id must match [a-z0-9_:]{{2,40}}")
        if plan_id in clean:
            raise HTTPException(status_code=400, detail=f"{where}.id is duplicated")
        service_ids = item.get("serviceIds")
        if not isinstance(service_ids, list) or not service_ids or len(service_ids) > 12:
            raise HTTPException(status_code=400, detail=f"{where}.serviceIds must list 1-12 services")
        service_ids = [str(s) for s in service_ids]
        if len(set(service_ids)) != len(service_ids):
            raise HTTPException(status_code=400, detail=f"{where}.serviceIds has duplicates")
        unknown = [s for s in service_ids if s not in known]
        if unknown:
            raise HTTPException(status_code=400, detail=f"{where}.serviceIds contains unknown service: {unknown[0]}")
        if previous and plan_id in previous and sorted(previous[plan_id].get("serviceIds") or []) != sorted(service_ids):
            raise HTTPException(
                status_code=400,
                detail=f"{where}.serviceIds cannot change for a shipped plan — archive it and create a new plan id",
            )
        name = str(item.get("name") or "").strip()
        name_ar = str(item.get("nameAr") or "").strip()
        if not name or len(name) > 80 or not name_ar or len(name_ar) > 80:
            raise HTTPException(status_code=400, detail=f"{where}.name/nameAr must be 1-80 characters")
        price = item.get("priceMinor")
        if isinstance(price, bool) or not isinstance(price, int) or price < 0 or price > MAX_PLAN_PRICE_MINOR:
            raise HTTPException(status_code=400, detail=f"{where}.priceMinor must be a non-negative integer")
        if str(item.get("currency") or "") != "LYD":
            raise HTTPException(status_code=400, detail=f"{where}.currency must be LYD")
        duration = item.get("durationDays")
        if isinstance(duration, bool) or not isinstance(duration, int) or duration < 1 or duration > 3660:
            raise HTTPException(status_code=400, detail=f"{where}.durationDays must be 1-3660")
        savings = item.get("savingsPct")
        if savings is not None and (isinstance(savings, bool) or not isinstance(savings, int) or savings < 0 or savings > 95):
            raise HTTPException(status_code=400, detail=f"{where}.savingsPct must be 0-95")
        clean[plan_id] = {
            "id": plan_id,
            "serviceIds": service_ids,
            "name": name,
            "nameAr": name_ar,
            "priceMinor": price,
            "currency": "LYD",
            "durationDays": duration,
            "badge": str(item.get("badge") or "")[:40] or None,
            "savingsPct": savings,
            "active": item.get("active") is not False,
            "sortOrder": int(item.get("sortOrder") or 0) if not isinstance(item.get("sortOrder"), bool) else 0,
        }
    return clean


def _newest_plan_record(conn: Any) -> dict[str, Any] | None:
    rows = conn.execute(
        text("SELECT data_json FROM entities WHERE type='appSettings' AND deleted=false")
    ).mappings().all()
    best: dict[str, Any] | None = None
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("settingKey") or "") != PLAN_SETTINGS_KEY:
            continue
        try:
            version = int(data.get("version") or 0)
        except (TypeError, ValueError):
            continue
        if best is None or version > int(best.get("version") or 0):
            best = data
    return best


def load_subscription_plans(ctx: dict[str, Any], conn: Any | None = None) -> dict[str, dict[str, Any]]:
    """Defaults overlaid by the newest VALID admin catalog record.

    A corrupt overlay (e.g. written through the generic route) is skipped
    entirely — plans are never partially applied. Implicit svc:* plans stay
    available unless the overlay explicitly redefines them.
    """
    if conn is not None:
        record = _newest_plan_record(conn)
    else:
        with db_conn() as own_conn:
            record = _newest_plan_record(own_conn)
    defaults = default_subscription_plans(ctx)
    if not record:
        return defaults
    try:
        overlay = validate_plan_catalog(record.get("plans"), None, ctx)
    except HTTPException:
        return defaults
    return {**defaults, **overlay}


def _max_active_expiry(
    conn: Any, ctx: dict[str, Any], user_id: str, service_id: str, now_dt: datetime
) -> datetime | None:
    """Latest future expiry of the user's active rows for one service.

    An active row WITHOUT an expiry (unlimited/legacy grant) refuses the
    purchase — extending forever is meaningless and hides a data problem.
    """
    rows = conn.execute(
        text("SELECT data_json FROM entities WHERE type='serviceSubscriptions' AND deleted=false")
    ).mappings().all()
    best: datetime | None = None
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("userId") or "") != user_id or str(data.get("serviceId") or "") != service_id:
            continue
        if str(data.get("status") or "").lower() != "active":
            continue
        expiry = ctx["parse_subscription_expiry"](data.get("expiresAt"))
        if expiry is None:
            raise HTTPException(status_code=409, detail="Service is already active without expiry")
        if expiry > now_dt and (best is None or expiry > best):
            best = expiry
    return best


def _find_purchase_group(conn: Any, idem: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        text("SELECT * FROM entities WHERE type='serviceSubscriptions' AND deleted=false")
    ).mappings().all()
    out: list[dict[str, Any]] = []
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if str(data.get("purchaseGroupId") or "") == idem or str(data.get("idempotencyKey") or "") == idem:
            out.append(dict(row))
    return out


def plan_purchase_atomic(
    actor: dict[str, Any],
    ctx: dict[str, Any],
    *,
    plan_id: str,
    idempotency_key: str,
    user_id: str | None = None,
    requested_id: str | None = None,
) -> tuple[list[dict[str, Any]], bool, dict[str, Any] | None]:
    """Mint every serviceId row of one plan + at most one payment, atomically.

    Returns (subscription_rows, created, payment). Modeled line-by-line on
    the legacy single-service atomic; the legacy path now IS this path via
    the implicit ``svc:{serviceId}`` plan (and gains renewal-extension).
    """
    sanitize = ctx["sanitize_str"]
    actor_uid = sanitize(str(actor.get("id") or ""))[:80]
    target_uid = sanitize(str(user_id or actor_uid))[:80]
    if not actor_uid or not target_uid:
        raise HTTPException(status_code=400, detail="Missing subscription user")
    if target_uid != actor_uid and str(actor.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Cannot subscribe another user")
    wanted_plan = sanitize(str(plan_id or ""))[:40]
    idem = sanitize(str(idempotency_key or ""))[:120]
    if len(idem) < 8:
        raise HTTPException(status_code=400, detail="idempotencyKey is required (minimum 8 characters)")

    postgres = ctx["is_postgres"]()
    guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
    with guard:
        with db_conn() as conn:
            plan = load_subscription_plans(ctx, conn).get(wanted_plan)
            if not plan:
                raise HTTPException(status_code=400, detail="Plan is not available for subscription")
            if plan.get("active") is False:
                raise HTTPException(status_code=409, detail="Plan is no longer sold")
            # Currency/idempotency validation with the zero-price restore trick.
            amount, cur, _ = ctx["validate_wallet_values"](
                max(1, int(plan.get("priceMinor") or 0)), plan.get("currency"), idem
            )
            price_minor = int(plan.get("priceMinor") or 0)
            if price_minor < 0:
                raise HTTPException(status_code=500, detail="Invalid server plan price")
            if price_minor == 0:
                amount = 0
            duration_days = int(plan.get("durationDays") or 0)
            if duration_days < 1 or duration_days > 3660:
                raise HTTPException(status_code=500, detail="Invalid server plan duration")
            service_ids = [str(s) for s in (plan.get("serviceIds") or [])]
            if not service_ids:
                raise HTTPException(status_code=500, detail="Plan has no services")

            ctx["lock_and_validate_wallet_users"](conn, [target_uid], postgres=postgres)
            ctx["lock_idempotency_key"](conn, idem, postgres=postgres, namespace="subscription")

            # Whole-group replay: all inserts commit in one transaction, so a
            # replay can never observe a partial bundle.
            prior_rows = _find_purchase_group(conn, idem)
            if prior_rows:
                entities = [ctx["entity_from_db_row"](r) for r in prior_rows]
                for entity in entities:
                    d = entity.get("data") or {}
                    if str(d.get("userId") or "") != target_uid or str(
                        d.get("planId") or f"svc:{d.get('serviceId')}"
                    ) != wanted_plan:
                        raise HTTPException(
                            status_code=409,
                            detail="Idempotency key was already used for another operation",
                        )
                payment = None
                payment_id = str((entities[0].get("data") or {}).get("paymentTxId") or "")
                if payment_id:
                    prow = conn.execute(
                        text("SELECT * FROM entities WHERE type='walletTransactions' AND id=:id LIMIT 1"),
                        {"id": payment_id},
                    ).mappings().first()
                    payment = ctx["entity_from_db_row"](prow) if prow else None
                return entities, False, payment

            now_dt = datetime.now(timezone.utc)
            # Renewal math per service BEFORE any money moves.
            schedule: list[tuple[str, datetime, datetime]] = []
            stack_limit = now_dt + timedelta(days=MAX_PLAN_STACK_DAYS)
            for sid in service_ids:
                current_max = _max_active_expiry(conn, ctx, target_uid, sid, now_dt)
                start = max(now_dt, current_max or now_dt)
                expires = start + timedelta(days=duration_days)
                if expires > stack_limit:
                    raise HTTPException(status_code=409, detail="Subscription is prepaid too far ahead")
                schedule.append((sid, start, expires))

            payment: dict[str, Any] | None = None
            legacy_single = wanted_plan.startswith("svc:") and len(service_ids) == 1
            if amount > 0:
                if ctx["wallet_available_after_holds"](conn, target_uid, cur) < amount:
                    raise HTTPException(status_code=409, detail="Insufficient wallet balance")
                payment_idempotency = f"subpay:{idem}"
                ctx["lock_idempotency_key"](conn, payment_idempotency, postgres=postgres)
                if ctx["find_entity_by_idempotency"](conn, "walletTransactions", payment_idempotency):
                    # A committed purchase would have replayed above; a lone
                    # row with this key is a conflicting legacy/manual
                    # operation and must never be charged again.
                    raise HTTPException(
                        status_code=409,
                        detail="Subscription payment idempotency key is already in use",
                    )
                payment_data = {
                    "type": "service_payment",
                    "schemaVersion": 2,
                    "amountMinor": amount,
                    "amount": amount / 100,
                    "currency": cur,
                    "fromUserId": target_uid,
                    "toUserId": "system",
                    "memo": f"Subscription: {service_ids[0]}" if legacy_single else f"Plan: {wanted_plan}",
                    "idempotencyKey": payment_idempotency,
                    "status": "posted",
                    "referenceType": "subscription" if legacy_single else "subscriptionPlan",
                    "referenceId": service_ids[0] if legacy_single else wanted_plan,
                    "createdAt": ctx["iso_utc"](now_dt),
                }
                payment = ctx["insert_entity_in_transaction"](
                    conn, "walletTransactions", None, payment_data, actor_uid
                )

            minted: list[dict[str, Any]] = []
            for index, (sid, start, expires) in enumerate(schedule):
                row_data = {
                    "userId": target_uid,
                    "serviceId": sid,
                    "status": "active",
                    "startedAt": ctx["iso_utc"](start),
                    "expiresAt": ctx["iso_utc"](expires),
                    "planId": wanted_plan,
                    "planPriceMinor": price_minor,
                    # The wallet ledger is money truth: only single-service
                    # rows repeat the price; bundle members carry 0 so a sum
                    # over subscription rows can never double-count revenue.
                    "priceMinor": amount if len(schedule) == 1 else 0,
                    "price": (amount if len(schedule) == 1 else 0) / 100,
                    "currency": cur,
                    "purchaseGroupId": idem,
                    "paymentTxId": payment.get("id") if payment else None,
                    "idempotencyKey": idem if len(schedule) == 1 else f"{idem}:{sid}",
                    "createdAt": ctx["iso_utc"](now_dt),
                }
                minted.append(
                    ctx["insert_entity_in_transaction"](
                        conn,
                        "serviceSubscriptions",
                        requested_id if (requested_id and index == 0 and len(schedule) == 1) else None,
                        row_data,
                        actor_uid,
                    )
                )
            return minted, True, payment


def _public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": plan["id"],
        "serviceIds": list(plan.get("serviceIds") or []),
        "name": plan.get("name") or "",
        "nameAr": plan.get("nameAr") or "",
        "priceMinor": int(plan.get("priceMinor") or 0),
        "currency": "LYD",
        "durationDays": int(plan.get("durationDays") or 30),
        "badge": plan.get("badge"),
        "savingsPct": plan.get("savingsPct"),
        "sortOrder": int(plan.get("sortOrder") or 0),
    }


def create_subscription_plans_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["subscription-plans"])

    @router.get("/subscriptions/plans")
    def list_subscription_plans(
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Public projection — the only way non-admins ever see prices."""
        plans = [p for p in load_subscription_plans(ctx).values() if p.get("active") is not False]
        plans.sort(key=lambda p: (int(p.get("sortOrder") or 0), str(p.get("id"))))
        return {"plans": [_public_plan(p) for p in plans]}

    @router.post("/subscriptions/purchase-plan")
    def purchase_subscription_plan(
        body: PlanPurchaseRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        require_same_origin(request)
        rows, created, payment = plan_purchase_atomic(
            user,
            ctx,
            plan_id=body.planId,
            idempotency_key=body.idempotencyKey,
            user_id=body.userId,
        )
        if created:
            ctx["audit"](
                str(user.get("id") or ""),
                "create",
                "serviceSubscriptions",
                str(rows[0].get("id") or ""),
                f"Purchased plan {body.planId} ({len(rows)} services)",
                {
                    "purchaseGroupId": body.idempotencyKey,
                    "paymentTxId": payment.get("id") if payment else None,
                },
            )
        return {"subscriptions": rows, "payment": payment}

    @router.get("/admin/subscription-plans")
    def get_admin_subscription_plans(
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Full merged catalog INCLUDING archived plans, for the manager UI."""
        if str(user.get("role") or "").lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        with db_conn() as conn:
            record = _newest_plan_record(conn)
            plans = load_subscription_plans(ctx, conn)
        ordered = sorted(plans.values(), key=lambda p: (int(p.get("sortOrder") or 0), str(p.get("id"))))
        return {
            "version": int((record or {}).get("version") or 0),
            "plans": [{**_public_plan(p), "active": p.get("active") is not False} for p in ordered],
        }

    @router.put("/admin/subscription-plans")
    def save_subscription_plans(
        body: PlanCatalogUpdateRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        require_same_origin(request)
        if str(user.get("role") or "").lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        postgres = ctx["is_postgres"]()
        guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        with guard:
            with db_conn() as conn:
                previous_record = _newest_plan_record(conn)
                previous = load_subscription_plans(ctx, conn)
                raw_plans = [p.model_dump() for p in body.plans]
                catalog = validate_plan_catalog(raw_plans, previous, ctx)
                version = int((previous_record or {}).get("version") or 0) + 1
                record = {
                    "settingKey": PLAN_SETTINGS_KEY,
                    "version": version,
                    "plans": list(catalog.values()),
                    "setBy": str(user.get("id") or ""),
                    "date": ctx["iso_utc"](),
                }
                saved = ctx["insert_entity_in_transaction"](
                    conn, "appSettings", None, record, str(user.get("id") or "")
                )
        ctx["audit"](
            str(user.get("id") or ""),
            "update",
            "appSettings",
            str(saved.get("id") or ""),
            f"Saved subscription plan catalog v{version} ({len(catalog)} plans)",
            {"version": version},
        )
        return {"version": version, "plans": [_public_plan(p) for p in catalog.values()]}

    return router
