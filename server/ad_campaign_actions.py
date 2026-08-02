"""Ads Studio campaign actions: boost-field validation, stop-with-refund, launch marker.

Stop is the third and last money door of the campaign lifecycle:

* ``cpay:{id}:{cycle}``       — approval captures the held budget (wallet_payments)
* ``rel:{cpay-key}``          — a rejected cycle releases a crashed-approval capture
* ``stoprefund:{cpay-key}``   — a stopped APPROVED cycle refunds unspent budget

The stop endpoint runs ONE locked transaction: the refund ledger row and the
``Stopped`` status write commit or roll back together, so there is no orphan
state at all. Lock order matches ``_soft_delete_ad_campaign_atomic`` in main:
entity-patch lock first, wallet lock second — never the other way around.

Everything main-owned (permissions, rate limits, media projection, patching)
is injected through ``ctx`` so no logic is duplicated and main.py stays under
its architecture line cap.
"""

import re
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from .db import db_conn, json_dumps, now_ms
from .schemas import AdCampaignPublishStatusRequest, AdCampaignStopRequest
from .wallet_payments import _campaign_payment_key, refund_stopped_campaign_budget

AD_CAMPAIGN_COLLECTION = "adCampaignRequests"
_OPERATION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,119}")
# Reviewer-visible workflow states; anything else is a customer's private
# draft whose very existence must not leak through error-code differences.
REVIEWER_VISIBLE_STATUSES = frozenset({"Submitted", "Approved", "Rejected", "Stopped"})
# Suffix-matched: covers www./m./web. subdomains without accepting look-alike
# registrable domains (evil-facebook.com fails, m.facebook.com passes).
_BOOST_REF_HOSTS = ("facebook.com", "fb.watch", "instagram.com")
_HOSTNAME_RE = re.compile(r"[A-Za-z0-9.-]+")


def normalize_ad_campaign_destination(value: Any, string_fn: Callable[..., str]) -> str:
    """HTTPS link or international phone number a finished ad may open."""
    raw = string_fn(value, "destination", 2048)
    if not raw:
        return ""
    compact_phone = re.sub(r"[\s().-]", "", raw)
    if re.fullmatch(r"\+?[1-9][0-9]{7,14}", compact_phone):
        return compact_phone if compact_phone.startswith("+") else f"+{compact_phone}"
    try:
        parsed = urlparse(raw)
    except ValueError:
        parsed = None
    if (
        parsed is None
        or parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or any(ch.isspace() for ch in raw)
        or not _HOSTNAME_RE.fullmatch(parsed.hostname)
        or "." not in parsed.hostname
    ):
        raise HTTPException(
            status_code=400,
            detail="destination must be an HTTPS website, WhatsApp/Messenger link, or international phone number",
        )
    return raw


def normalize_ad_campaign_source_post_ref(value: Any, string_fn: Callable[..., str]) -> str:
    """The customer's existing post to boost — a Meta-family HTTPS link only."""
    raw = string_fn(value, "sourcePostRef", 500)
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
    except ValueError:
        parsed = None
    host = (parsed.hostname or "").lower() if parsed else ""
    if (
        parsed is None
        or parsed.scheme.lower() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or any(ch.isspace() for ch in raw)
        # Same host hygiene as the destination validator: percent-encoded or
        # control characters in the host must fail, not sneak past the
        # suffix match (facebook.com%2f.instagram.com style differentials).
        or not _HOSTNAME_RE.fullmatch(host)
        or "." not in host
        or not any(host == h or host.endswith("." + h) for h in _BOOST_REF_HOSTS)
    ):
        raise HTTPException(
            status_code=400,
            detail="sourcePostRef must be an HTTPS link to a Facebook or Instagram post",
        )
    return raw


def apply_boost_campaign_fields(
    data: dict[str, Any],
    clean: dict[str, Any],
    string_fn: Callable[..., str],
    validate_entity_id_fn: Callable[[Any], str],
) -> None:
    """Boost-flow customer fields, called from _prepare_ad_campaign_fields."""
    if "boostType" in data:
        boost = string_fn(data.get("boostType"), "boostType", 20).lower()
        if boost and boost not in {"boost_post", "boost_page"}:
            raise HTTPException(status_code=400, detail="boostType must be boost_post or boost_page")
        clean["boostType"] = boost
    if "sourcePostRef" in data:
        clean["sourcePostRef"] = normalize_ad_campaign_source_post_ref(data.get("sourcePostRef"), string_fn)
    if "autoReply" in data:
        if not isinstance(data.get("autoReply"), bool):
            raise HTTPException(status_code=400, detail="autoReply must be true or false")
        clean["autoReply"] = data["autoReply"]
    if "extendsCampaignId" in data:
        ref = string_fn(data.get("extendsCampaignId"), "extendsCampaignId", 80)
        if ref:
            try:
                ref = validate_entity_id_fn(ref)
            except HTTPException:
                raise HTTPException(status_code=400, detail="extendsCampaignId is invalid")
        clean["extendsCampaignId"] = ref


def enforce_boost_submission_rules(clean: dict[str, Any]) -> None:
    """Strict (submission-time) boost requirements."""
    if clean.get("boostType") == "boost_post" and not str(clean.get("sourcePostRef") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="sourcePostRef is required for a Boost Post request",
        )


def _clean_operation_id(ctx: dict[str, Any], value: Any) -> str:
    operation_id = ctx["sanitize_str"](str(value or ""))[:120]
    if not operation_id or not _OPERATION_ID_RE.fullmatch(operation_id):
        raise HTTPException(status_code=400, detail="Invalid operationId")
    return operation_id


def _campaign_start_is_in_future(data: dict[str, Any]) -> bool:
    raw = str(data.get("startDate") or "").strip()[:10]
    try:
        start = datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return False  # unparseable start = never provably "not started yet"
    return datetime.now(timezone.utc).date() < start


def _is_reviewer(ctx: dict[str, Any], user: dict[str, Any]) -> bool:
    return (
        str(user.get("role") or "").lower() == "admin"
        or ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review")
    )


def create_ad_campaign_actions_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/ad-studio/campaigns", tags=["ad-studio"])

    @router.post("/{campaign_id}/stop")
    def stop_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignStopRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Stop an Approved campaign; refund the unspent budget atomically."""
        require_same_origin(request)
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        actor_id = str(user.get("id") or "system")
        postgres = ctx["is_postgres"]()
        patch_guard = nullcontext() if postgres else ctx["sqlite_patch_lock"]()
        wallet_guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        refund = 0
        with patch_guard, wallet_guard:
            with db_conn() as conn:
                suffix = " FOR UPDATE" if postgres else ""
                row = conn.execute(
                    text(
                        "SELECT * FROM entities WHERE type = :type AND id = :id "
                        f"AND deleted = false LIMIT 1{suffix}"
                    ),
                    {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
                ).mappings().first()
                if not row:
                    raise HTTPException(status_code=404, detail="Campaign request not found")
                entity = ctx["entity_from_db_row"](row)
                data = dict(entity.get("data") or {})
                creator = str(entity.get("createdBy") or data.get("createdBy") or "")
                # A reviewer stopping their OWN campaign follows the customer
                # rules — the staff branch may choose refund amounts, and
                # nobody chooses their own.
                staff = _is_reviewer(ctx, user) and actor_id != creator
                if not staff and not ctx["user_has_permission"](
                    user, AD_CAMPAIGN_COLLECTION, "stop", record_creator_id=creator
                ):
                    raise HTTPException(status_code=403, detail="Forbidden")
                if actor_id != creator:
                    # Stopping your own campaign only returns your own money;
                    # a lapsed subscription must never hold a refund hostage.
                    ctx["require_ad_maker_subscription"](user)
                    if str(data.get("status") or "Draft") not in REVIEWER_VISIBLE_STATUSES:
                        # Same rule as the single-GET guard: never confirm a
                        # private draft's existence through a status 409.
                        raise HTTPException(status_code=404, detail="Campaign request not found")
                if str(data.get("lastStopOperationId") or "") == operation_id:
                    # The first response was lost after commit — replay it.
                    return ctx["project_entity_media_for_user"](entity, user, False)
                ctx["enforce_ad_campaign_rate"](user)
                if str(data.get("status") or "Draft") != "Approved":
                    raise HTTPException(status_code=409, detail="Only Approved campaigns can be stopped")
                baseline = int(entity.get("lastModified") or 0)
                if baseline != int(body.expectedLastModified):
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")

                # Captured money is read from the ORIGINAL cpay ledger row —
                # never from the campaign's own numbers.
                paid_row = ctx["find_entity_by_idempotency"](
                    conn,
                    "walletTransactions",
                    _campaign_payment_key({**data, "id": campaign_id}),
                )
                captured = int(((paid_row or {}).get("data") or {}).get("amountMinor") or 0)
                spent = min(max(int(data.get("spendMinorUSD") or 0), 0), max(captured, 0))
                if staff:
                    refund = (
                        int(body.refundMinorUSD)
                        if body.refundMinorUSD is not None
                        else captured - spent
                    )
                    if refund < 0 or refund > captured - spent:
                        raise HTTPException(
                            status_code=400,
                            detail="refundMinorUSD must be between 0 and the unspent captured budget",
                        )
                else:
                    if body.refundMinorUSD is not None:
                        raise HTTPException(
                            status_code=403,
                            detail="Only staff can choose a partial refund amount",
                        )
                    started = (
                        str(data.get("publishStatus") or "").strip()
                        or str(data.get("metaCampaignId") or "").strip()
                        or spent > 0
                        or not _campaign_start_is_in_future(data)
                    )
                    if started:
                        raise HTTPException(
                            status_code=409,
                            detail="This ad has already started — ask us to stop it and refund the unspent part",
                        )
                    refund = captured
                tx_id = ""
                if refund > 0:
                    tx_id = refund_stopped_campaign_budget(
                        conn, ctx, {**data, "id": campaign_id}, actor_id, refund
                    )
                stopped_at = ctx["iso_utc"]()
                modified = max(now_ms(), baseline + 1)
                data.update(
                    {
                        "status": "Stopped",
                        "stoppedAt": stopped_at,
                        "stoppedBy": actor_id,
                        "stopReason": ctx["sanitize_str"](str(body.reason or ""))[:1000],
                        "refundMinorUSD": refund,
                        "refundTransactionId": tx_id,
                        "spendMinorUSD": max(captured - refund, 0),
                        "lastStopOperationId": operation_id,
                        "_lastModified": modified,
                    }
                )
                result = conn.execute(
                    text(
                        "UPDATE entities SET data_json = :d, last_modified = :m "
                        "WHERE type = :t AND id = :id AND deleted = false "
                        "AND last_modified = :baseline"
                    ),
                    {
                        "d": json_dumps(data),
                        "m": modified,
                        "t": AD_CAMPAIGN_COLLECTION,
                        "id": campaign_id,
                        "baseline": baseline,
                    },
                )
                if int(result.rowcount or 0) != 1:
                    # Rolls the refund row back with it — that is the point.
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")
                entity = {**entity, "data": data, "lastModified": modified}
        ctx["audit"](
            actor_id,
            "stop",
            AD_CAMPAIGN_COLLECTION,
            campaign_id,
            f"Stopped campaign request {campaign_id}, refunded {refund}",
            {"operationId": operation_id, "refundMinorUSD": refund, "selfStop": actor_id == creator},
        )
        return ctx["project_entity_media_for_user"](entity, user, False)

    @router.post("/{campaign_id}/publish-status")
    def set_ad_campaign_publish_status(
        campaign_id: str,
        body: AdCampaignPublishStatusRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Staff marker that the Approved ad was launched/paused on Meta by hand."""
        require_same_origin(request)
        if not _is_reviewer(ctx, user):
            raise HTTPException(status_code=403, detail="Forbidden")
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        value = str(body.publishStatus)
        campaign = ctx["get_entity"](AD_CAMPAIGN_COLLECTION, campaign_id)
        if not campaign or campaign.get("deleted"):
            raise HTTPException(status_code=404, detail="Campaign request not found")
        data = campaign.get("data") or {}
        creator = str(campaign.get("createdBy") or data.get("createdBy") or "")
        if (
            str(user.get("id") or "") != creator
            and str(data.get("status") or "Draft") not in REVIEWER_VISIBLE_STATUSES
        ):
            # Never confirm a private draft's existence through a status 409.
            raise HTTPException(status_code=404, detail="Campaign request not found")
        if str(data.get("lastPublishOperationId") or "") == operation_id:
            same_meta = body.metaCampaignId is None or (
                ctx["sanitize_str"](str(body.metaCampaignId or ""))[:120]
                == str(data.get("metaCampaignId") or "")
            )
            if str(data.get("publishStatus") or "") != value or not same_meta:
                raise HTTPException(status_code=409, detail="operationId was already used for another update")
            return ctx["project_entity_media_for_user"](campaign, user, False)
        ctx["enforce_ad_campaign_rate"](user)
        if str(data.get("status") or "Draft") != "Approved":
            raise HTTPException(status_code=409, detail="Only Approved campaigns can be marked launched")
        actor_id = str(user.get("id") or "system")
        fields: dict[str, Any] = {
            "publishStatus": value,
            "lastPublishOperationId": operation_id,
        }
        if value:
            fields["publishedAt"] = ctx["iso_utc"]()
            fields["publishedBy"] = actor_id
            if body.metaCampaignId is not None:
                fields["metaCampaignId"] = ctx["sanitize_str"](str(body.metaCampaignId or ""))[:120]
        else:
            fields.update({"publishedAt": None, "publishedBy": None, "metaCampaignId": ""})
        try:
            saved = ctx["patch_entity"](
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                fields,
                actor_id,
                expected_last_modified=body.expectedLastModified,
                enforce_ad_campaign_quota=False,
            )
        except HTTPException as error:
            if error.status_code != 409:
                raise
            latest = ctx["get_entity"](AD_CAMPAIGN_COLLECTION, campaign_id)
            latest_data = (latest or {}).get("data") or {}
            if (
                not latest
                or latest.get("deleted")
                or str(latest_data.get("lastPublishOperationId") or "") != operation_id
                or str(latest_data.get("publishStatus") or "") != value
            ):
                raise
            return ctx["project_entity_media_for_user"](latest, user, False)
        ctx["audit"](
            actor_id,
            "publish_status",
            AD_CAMPAIGN_COLLECTION,
            campaign_id,
            f"Marked campaign {campaign_id} publish status: {value or 'cleared'}",
            {"operationId": operation_id, "publishStatus": value},
        )
        return ctx["project_entity_media_for_user"](saved, user, False)

    return router
