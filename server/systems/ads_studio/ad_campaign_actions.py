"""Ads Studio campaign actions: boost-field validation, submit, review, stop-with-refund, launch marker.

The campaign lifecycle's money doors, in order:

* submit                      — holds the budget (a Submitted request counts in the owner's holds)
* ``cpay:{id}:{cycle}``       — approval captures the held budget (wallet_payments)
* ``rel:{cpay-key}``          — a rejected cycle releases a crashed-approval capture
* ``stoprefund:{cpay-key}``   — a stopped APPROVED cycle refunds unspent budget

Submit and review were moved here word for word from main.py (P1-01, P1-10):
same status codes, texts, audit rows, ledger rows, operation-id replay and
version checks. Main's helpers reach them through late-bound ``ctx`` lambdas,
so a monkeypatched main helper (tests, fault injection) still takes effect.

The stop endpoint runs ONE locked transaction: the refund ledger row and the
``Stopped`` status write commit or roll back together, so there is no orphan
state at all. Lock order matches ``_soft_delete_ad_campaign_atomic`` in main:
entity-patch lock first, wallet lock second — never the other way around.
A stop records ``closeReason`` (P1-04): ``customer_stop`` for the owner's own
stop, ``staff_stop`` or ``completed`` (a finished ad) chosen by staff only.

Everything main-owned (permissions, rate limits, media projection, patching)
is injected through ``ctx`` so no logic is duplicated and main.py stays under
its architecture line cap.
"""

import re
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from ...db import db_conn, json_dumps, now_ms
from ...schemas import (
    AdCampaignPublishStatusRequest,
    AdCampaignReviewRequest,
    AdCampaignStopRequest,
    AdCampaignSubmitRequest,
    EntityResponse,
)
from ...wallet_payments import (
    _campaign_payment_key,
    capture_campaign_budget,
    refund_stopped_campaign_budget,
    release_orphan_campaign_payment,
)

AD_CAMPAIGN_COLLECTION = "adCampaignRequests"
AD_CAMPAIGN_EDITABLE_STATUSES = frozenset({"Draft", "Changes Requested"})
AD_CAMPAIGN_REVIEW_DECISIONS = frozenset({"Approved", "Changes Requested", "Rejected"})
MAX_AD_CAMPAIGN_REVIEW_HISTORY = 100
_OPERATION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,119}")
# Reviewer-visible workflow states; anything else is a customer's private
# draft whose very existence must not leak through error-code differences.
REVIEWER_VISIBLE_STATUSES = frozenset({"Submitted", "Approved", "Rejected", "Stopped"})


class AdCampaignStopBody(AdCampaignStopRequest):
    """The stop request plus ``closeReason`` (P1-04): why the request reached Stopped.

    Staff choose it (default ``staff_stop``; ``completed`` = a finished ad). The
    owner's own stop is always ``customer_stop``; asking for anything else is 403."""

    closeReason: Optional[Literal["", "customer_stop", "staff_stop", "completed"]] = None
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
    # The start DAY itself counts as "not yet": approval bumps a passed start to
    # the approval day, and the callers already treat any publish marker or spend
    # as started - a same-day self-stop of an unlaunched campaign refunds in full.
    try:
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo("Africa/Tripoli")).date()  # the business day, not the UTC day
    except Exception:
        today = datetime.now(timezone.utc).date()
    return today <= start


def _is_reviewer(ctx: dict[str, Any], user: dict[str, Any]) -> bool:
    return (
        str(user.get("role") or "").lower() == "admin"
        or ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review")
    )


def _ad_campaign_review_history(ctx: dict[str, Any], value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    history: list[dict[str, str]] = []
    for raw in value[-MAX_AD_CAMPAIGN_REVIEW_HISTORY:]:
        if not isinstance(raw, dict):
            continue
        decision = ctx["sanitize_str"](str(raw.get("decision") or ""), 40)
        if decision not in AD_CAMPAIGN_REVIEW_DECISIONS:
            continue
        history.append(
            {
                "decision": decision,
                "note": ctx["sanitize_str"](str(raw.get("note") or ""), 2000),
                "reviewedAt": ctx["sanitize_str"](str(raw.get("reviewedAt") or ""), 80),
                "reviewedBy": ctx["sanitize_str"](str(raw.get("reviewedBy") or ""), 80),
            }
        )
    return history


def _redacted_ad_campaign_tombstone(entity: dict[str, Any]) -> dict[str, Any]:
    """Tell a reviewer to remove an out-of-scope campaign without leaking it."""
    entity_id = str(entity.get("id") or "")
    last_modified = int(entity.get("lastModified") or 0)
    return {
        "id": entity_id,
        "type": AD_CAMPAIGN_COLLECTION,
        "deleted": True,
        "createdAt": int(entity.get("createdAt") or last_modified),
        "createdBy": None,
        "lastModified": last_modified,
        "data": {
            "id": entity_id,
            "_lastModified": last_modified,
            "_deleted": True,
        },
    }


def create_ad_campaign_actions_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/ad-studio/campaigns", tags=["ad-studio"])

    @router.post("/{campaign_id}/submit", response_model=EntityResponse)
    def submit_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignSubmitRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Submit a complete request for human review; never publish a live ad."""
        require_same_origin(request)
        ctx["require_ad_maker_subscription"](user)
        campaign = ctx["get_entity"](AD_CAMPAIGN_COLLECTION, campaign_id)
        if not campaign or campaign.get("deleted"):
            raise HTTPException(status_code=404, detail="Campaign request not found")
        creator = campaign.get("createdBy") or (campaign.get("data") or {}).get("createdBy")
        if not ctx["user_has_permission"](
            user,
            AD_CAMPAIGN_COLLECTION,
            "submit",
            record_creator_id=str(creator or ""),
        ):
            raise HTTPException(status_code=403, detail="Forbidden")

        current = campaign.get("data") or {}
        operation_id = ctx["sanitize_str"](str(body.operationId or ""), 120)
        if operation_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,119}", operation_id):
            raise HTTPException(status_code=400, detail="Invalid operationId")
        if operation_id and str(current.get("lastSubmitOperationId") or "") == operation_id:
            # The first response may have been lost after commit. Replaying the
            # same operation returns authoritative current state instead of a
            # misleading 409/failure notification.
            return EntityResponse(
                **ctx["project_entity_media_for_user"](campaign, user, False)
            )
        ctx["enforce_ad_campaign_rate"](user)
        current_status = str(current.get("status") or "Draft")
        if current_status not in AD_CAMPAIGN_EDITABLE_STATUSES:
            raise HTTPException(
                status_code=409,
                detail="Only Draft or Changes Requested campaigns can be submitted",
            )
        with ctx["media_validation_slot"](user):
            ctx["prepare_ad_campaign_fields"](current, strict=True)

        # Money gate: the requested budget must be AVAILABLE in the owner's USD
        # wallet — a Submitted campaign holds it, approval captures it. The
        # capture re-checks under its own lock, so this is the UX gate and that
        # one is the hard guarantee.
        try:
            _budget_minor = max(int(current.get("budgetMinorUSD") or 0), 0)
        except (TypeError, ValueError, OverflowError):
            _budget_minor = 0
        if _budget_minor <= 0:
            raise HTTPException(status_code=400, detail="A campaign needs a budget greater than zero before submission")
        with db_conn() as conn:
            if ctx["wallet_available_after_holds"](conn, str(creator or ""), "USD") < _budget_minor:
                raise HTTPException(
                    status_code=409,
                    detail="Insufficient wallet balance for this budget — charge the wallet first",
                )

        actor_id = str(user.get("id") or "system")
        # A capture left by a crashed approval of the PREVIOUS cycle would be
        # charged twice on approval of this one (new key): return it first.
        with (nullcontext() if ctx["is_postgres"]() else ctx["sqlite_wallet_lock"]()), db_conn() as conn:
            released_tx = release_orphan_campaign_payment(conn, ctx, {**current, "id": campaign_id}, actor_id)
        if released_tx:
            ctx["audit"](actor_id, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id, f"Returned an orphan capture for {campaign_id}", {"transactionId": released_tx})
        replayed_after_conflict = False
        try:
            saved = ctx["patch_entity"](
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                {
                    "status": "Submitted",
                    "submittedAt": ctx["iso_utc"](),
                    "submittedBy": actor_id,
                    "reviewedAt": None,
                    "reviewedBy": None,
                    "reviewNote": "",
                    "reviewDecision": "",
                    "lastSubmitOperationId": operation_id,
                },
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
                or str(latest_data.get("lastSubmitOperationId") or "") != operation_id
            ):
                raise
            # A matching operation won the row-lock race while this identical
            # request was waiting. Treat the optimistic conflict as the same
            # committed success and do not duplicate its audit entry.
            saved = latest
            replayed_after_conflict = True
        if not replayed_after_conflict:
            ctx["audit"](
                actor_id,
                "submit",
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                f"Submitted campaign request {campaign_id} for review",
                {"operationId": operation_id},
            )
        return EntityResponse(**ctx["project_entity_media_for_user"](saved, user, False))

    @router.post("/{campaign_id}/review", response_model=EntityResponse)
    def review_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignReviewRequest,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Record a human decision without creating an internal or Meta ad."""
        require_same_origin(request)
        ctx["require_ad_maker_subscription"](user)
        if not ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review"):
            raise HTTPException(status_code=403, detail="Forbidden")
        campaign = ctx["get_entity"](AD_CAMPAIGN_COLLECTION, campaign_id)
        if not campaign or campaign.get("deleted"):
            raise HTTPException(status_code=404, detail="Campaign request not found")
        if str(user.get("role") or "").lower() != "admin" and str(campaign.get("createdBy") or "") == str(user.get("id") or ""):
            raise HTTPException(status_code=403, detail="You cannot review your own campaign")
        decision = str(body.decision)
        if decision not in AD_CAMPAIGN_REVIEW_DECISIONS:
            # Pydantic rejects this first; keep a defense-in-depth check if the
            # schema is ever widened independently.
            raise HTTPException(status_code=400, detail="Invalid review decision")
        current = campaign.get("data") or {}
        operation_id = ctx["sanitize_str"](str(body.operationId or ""), 120)
        if operation_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,119}", operation_id):
            raise HTTPException(status_code=400, detail="Invalid operationId")
        note = ctx["sanitize_str"](str(body.note or ""), 2000)
        if operation_id and str(current.get("lastReviewOperationId") or "") == operation_id:
            if (
                str(current.get("reviewDecision") or "") != decision
                or str(current.get("reviewNote") or "") != note
            ):
                raise HTTPException(status_code=409, detail="operationId was already used for another review")
            if str(current.get("reviewDecision") or "") in {"Rejected", "Changes Requested"}:
                # A crash may have parted the non-approval status write from its
                # orphan-capture release; rel: is idempotent, so replay it too.
                _rg = nullcontext() if ctx["is_postgres"]() else ctx["sqlite_wallet_lock"]()
                with _rg, db_conn() as conn:
                    release_orphan_campaign_payment(
                        conn, ctx, {**current, "id": campaign_id},
                        str(user.get("id") or "system"),
                    )
            if str(current.get("status") or "Draft") not in {"Submitted", "Approved", "Rejected", "Stopped"}:
                # A repeated review request may arrive after the customer has
                # already edited a Changes Requested draft. Never return those
                # newer private revisions to the reviewer through idempotency.
                return EntityResponse(**_redacted_ad_campaign_tombstone(campaign))
            return EntityResponse(
                **ctx["project_entity_media_for_user"](campaign, user, False)
            )
        ctx["enforce_ad_campaign_rate"](user)
        current_status = str(current.get("status") or "Draft")
        if current_status != "Submitted":
            raise HTTPException(status_code=409, detail="Only Submitted campaigns can be reviewed")
        bumped_start = ""
        if decision == "Approved":
            # A start date that passed while the request waited is not the
            # customer's fault: it starts on approval day (written below).
            _today_iso = ctx["business_today"]().strftime("%Y-%m-%d")  # the Libya day: approval at 00:30 local is already "today"
            if str(current.get("startDate") or "")[:10] < _today_iso <= str(current.get("endDate") or "9999")[:10]:
                bumped_start = _today_iso
                current = {**current, "startDate": bumped_start}
            elif str(current.get("endDate") or "9999")[:10] < _today_iso:
                raise HTTPException(status_code=409, detail="The campaign dates have passed; request changes so the customer can re-date it")
            # Approval means launch-ready. Revalidate server-side so older clients
            # and legacy drafts cannot bypass today's targeting/link rules.
            with ctx["media_validation_slot"](user):
                ctx["prepare_ad_campaign_fields"](current, strict=True)
        actor_id = str(user.get("id") or "system")
        if decision in {"Changes Requested", "Rejected"} and not note:
            raise HTTPException(
                status_code=400,
                detail="A review note is required when requesting changes or rejecting a campaign",
            )
        # An approval CAPTURES the held budget before its status write, with a
        # fresh locked status check inside the capture (at most one payment per
        # submission cycle). Refunds of crashed-approval captures run only AFTER
        # a successful non-approval status write — a reject can never refund a
        # live approval that is still winning the version race.
        campaign_owner = str(campaign.get("createdBy") or current.get("createdBy") or "")
        wallet_payment_tx = ""
        _wallet_guard = (
            nullcontext()
            if ctx["is_postgres"]()
            else ctx["sqlite_wallet_lock"]()
        )
        if decision == "Approved":
            with _wallet_guard, db_conn() as conn:
                wallet_payment_tx = capture_campaign_budget(
                    conn,
                    ctx,
                    {**current, "id": campaign_id, "createdBy": campaign_owner},
                    actor_id,
                )

        reviewed_at = ctx["iso_utc"]()
        history = _ad_campaign_review_history(ctx, current.get("reviewHistory"))
        history.append(
            {
                "decision": decision,
                "note": note,
                "reviewedAt": reviewed_at,
                "reviewedBy": actor_id,
            }
        )
        history = history[-MAX_AD_CAMPAIGN_REVIEW_HISTORY:]
        transition_fields: dict[str, Any] = {
            "status": decision,
            "reviewDecision": decision,
            "reviewedAt": reviewed_at,
            "reviewedBy": actor_id,
            "reviewNote": note,
            "reviewHistory": history,
            "lastReviewOperationId": operation_id,
        }
        if decision == "Approved":
            transition_fields.update(
                {
                    "approvedAt": reviewed_at,
                    "approvedBy": actor_id,
                    "paidMinorUSD": int(current.get("budgetMinorUSD") or 0),
                    "paymentTransactionId": wallet_payment_tx,
                    "paidAt": reviewed_at,
                }
            )
        elif decision == "Rejected":
            transition_fields.update({"rejectedAt": reviewed_at, "rejectedBy": actor_id})
        if bumped_start:
            transition_fields["startDate"] = bumped_start
        replayed_after_conflict = False
        try:
            saved = ctx["patch_entity"](
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                transition_fields,
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
                or str(latest_data.get("lastReviewOperationId") or "") != operation_id
                or str(latest_data.get("reviewDecision") or "") != decision
                or str(latest_data.get("reviewNote") or "") != note
            ):
                raise
            saved = latest
            replayed_after_conflict = True
        if decision != "Approved":
            # The campaign has now LEFT Submitted, so no new capture can happen
            # for this cycle (the capture verifies live status under lock): any
            # capture found here is a crashed approval's orphan — refund it.
            with _wallet_guard, db_conn() as conn:
                released_tx = release_orphan_campaign_payment(conn, ctx, {**current, "id": campaign_id}, actor_id)
            if released_tx:
                ctx["audit"](actor_id, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id, f"Returned an orphan capture for {campaign_id}", {"transactionId": released_tx})
        if not replayed_after_conflict:
            ctx["audit"](
                actor_id,
                "review",
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                f"Reviewed campaign request {campaign_id}: {decision}",
                {"decision": decision, "note": note, "operationId": operation_id, "walletPaymentTx": wallet_payment_tx,
                 "budgetMinorUSD": int(current.get("budgetMinorUSD") or 0)},
            )
        if replayed_after_conflict and str((saved.get("data") or {}).get("status") or "Draft") not in {
            "Submitted", "Approved", "Rejected", "Stopped"
        }:
            return EntityResponse(**_redacted_ad_campaign_tombstone(saved))
        return EntityResponse(**ctx["project_entity_media_for_user"](saved, user, False))

    @router.post("/{campaign_id}/stop")
    def stop_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignStopBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Stop an Approved campaign; refund the unspent budget atomically."""
        require_same_origin(request)
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        close_reason = str(body.closeReason or "")
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
                    launched = bool(
                        str(data.get("publishStatus") or "").strip() or str(data.get("metaCampaignId") or "").strip()
                    )
                    if body.refundMinorUSD is None and launched:
                        # A launched campaign has (almost surely) spent on Meta and nothing
                        # records that spend: defaulting to the whole budget refunded it.
                        raise HTTPException(
                            status_code=400,
                            detail="refundMinorUSD is required for a launched campaign (0 closes it without a refund)",
                        )
                    refund = int(body.refundMinorUSD) if body.refundMinorUSD is not None else captured - spent
                    if refund < 0 or refund > captured - spent:
                        raise HTTPException(
                            status_code=400,
                            detail="refundMinorUSD must be between 0 and the unspent captured budget",
                        )
                    # Staff may record a customer's ask-to-stop as customer_stop;
                    # a finished ad closes as completed (stage 11, PLAN §5.4).
                    close_reason = close_reason or "staff_stop"
                else:
                    if body.refundMinorUSD is not None:
                        raise HTTPException(
                            status_code=403,
                            detail="Only staff can choose a partial refund amount",
                        )
                    if close_reason not in {"", "customer_stop"}:
                        # "completed" / "staff_stop" are staff statements about the ad.
                        raise HTTPException(
                            status_code=403,
                            detail="Only staff can choose how a campaign closed",
                        )
                    close_reason = "customer_stop"
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
                        "publishStatus": "",  # a stopped campaign is not live (publishedAt/metaCampaignId stay as history)
                        "refundMinorUSD": refund,
                        "refundTransactionId": tx_id,
                        "spendMinorUSD": max(captured - refund, 0),
                        "closeReason": close_reason,
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
            {"operationId": operation_id, "refundMinorUSD": refund, "selfStop": actor_id == creator, "closeReason": close_reason},
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
