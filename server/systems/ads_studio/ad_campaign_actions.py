"""Ads Studio campaign actions: boost-field validation, submit, withdraw, review, stop-with-refund, launch marker.

The campaign lifecycle's money doors, in order:

* submit                      — holds the budget (a Submitted request counts in the owner's holds)
* withdraw                    — the owner takes a Submitted request back to Draft: the hold ends
* ``cpay:{id}:{cycle}``       — approval captures the held budget (wallet_payments)
* ``rel:{cpay-key}``          — a cycle the request left (rejected, sent back, withdrawn, archived,
  or an approval that lost its status write) returns a capture it already had
* ``stoprefund:{cpay-key}``   — a stopped APPROVED cycle refunds unspent budget

Submit and review were moved here word for word from main.py (P1-01, P1-10):
same status codes, texts, audit rows, ledger rows, operation-id replay and
version checks. Main's helpers reach them through late-bound ``ctx`` lambdas,
so a monkeypatched main helper (tests, fault injection) still takes effect.
Exception: ``db_conn`` and the wallet ledger functions are imported directly;
fault-inject them on this module (server.systems.ads_studio.ad_campaign_actions),
never on main, or the patch silently misses submit and review.

Races (PLAN.md §7.8, the lock table; proven on PostgreSQL in
test_postgres_financial_review.py). Every door takes its locks in the one global
order: user row -> ``cpay:`` key -> campaign row -> ``rel:``/``stoprefund:`` key.
On SQLite the same doors take the entity-patch lock, then the wallet lock.

* Submit (P1-02) validates first, then runs ONE transaction: the owner's user row,
  the campaign row, the previous cycle's ``rel:`` key; the money check and the
  Submitted write happen under those locks. Two sends of one owner queue on the
  owner's row, so the second counts the first one's hold: together they can never
  reserve more than Available (the loser gets the usual 409 "Insufficient wallet
  balance").
* Withdraw (P1-03) runs ONE transaction: campaign row, then ``rel:`` key. Submitted
  -> Draft, keeping ``submittedAt`` and ``lastSubmitOperationId`` (the orphan key)
  and stamping ``withdrawnAt`` and ``lastWithdrawOperationId``; a capture this cycle
  already had returns in the same transaction. Whoever locks the row first wins: a
  withdraw that finds the request Approved gets 409 REFUSE_WITHDRAW_APPROVED.
* An approval whose status write lost (409) after its capture re-reads the row
  (P1-03b). If the request LEFT the captured cycle (studio_wallet.cycle_state says
  "being returned"), it returns that capture itself (campaign row, then ``rel:``
  key) and still answers 409. An identical approval that won (same operationId)
  is adopted and never released; a request still Submitted, Approved or Stopped in
  that cycle keeps its capture.

The stop endpoint runs ONE locked transaction: the refund ledger row and the
``Stopped`` status write commit or roll back together, so there is no orphan
state at all. Lock order matches ``_soft_delete_ad_campaign_atomic`` in main:
entity-patch lock first, wallet lock second — never the other way around.
A stop records ``closeReason`` (P1-04): ``customer_stop`` for the owner's own
stop, ``staff_stop`` or ``completed`` (a finished ad) chosen by staff only.

Everything main-owned (permissions, rate limits, media projection, patching)
is injected through ``ctx`` so no logic is duplicated and main.py stays under
its architecture line cap.

Budgets, limits, intake and review reasons (P1-06 as changed by the owner,
P1-11, P1-12, P1-15, P1-18(a), P1-22; DECISIONS D4 + D5, D33):

* The customer picks a DAILY or a LIFETIME budget. ``budgetMinorUSD`` is the
  daily amount or the lifetime total; ``durationDays`` (1..limits.maxDays) is
  how many days the ad runs, both ends included (end = start + days - 1).
  Without it the days come from the dates, counted the same way.
* Submit computes ``totalBudgetMinorUSD`` (lifetime = budgetMinorUSD; daily =
  budgetMinorUSD x days), stamps ``schemaVersion`` 2, and the request HOLDS that
  total (wallet_payments.campaign_hold_minor). Approval recomputes it and
  captures exactly the held amount; stop reads the captured ledger row.
* The studio ``limits`` setting (studio_settings) bounds NEW requests at submit
  and again at approval: total within min..max, the per-day floor (the daily
  amount, or total / days) and maxDays. Never hard-coded here.
* Legacy rows (P1-18(a)): a request without ``schemaVersion`` >= 2, or submitted
  before ``limits.p1CutoverAt``, keeps the rules it was submitted under: no new
  limit refusal, the hold it was submitted with is what approval captures, and
  a row from before P1 keeps the old date rule. It is flagged ``legacyRules``.
  While p1CutoverAt is null (nobody stamped it), every row WITHOUT schemaVersion
  >= 2 is legacy and every row submitted by this code is not.
* Intake (P1-22): submit is refused while the ``intake`` setting is paused, or
  once today's (Tripoli day) submits reach ``maxSubmissionsPerDay``. Every send
  counts, a resubmit after Changes Requested too. Drafts still save. The count
  is read before the write, so two sends racing at the last free place can both
  pass (a staffing guard, not money).
* Review (P1-12): Changes Requested and Rejected need a ``reviewReasonCode``
  from REVIEW_REASON_LABELS (the note is optional); approval needs none. The
  code is stored on the request and in its review history for the owner.
"""

import re
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from ...db import db_conn, json_dumps, json_fields_select_sql, json_loads, now_ms
from ...schemas import (
    AdCampaignPublishStatusRequest,
    AdCampaignReviewRequest,
    AdCampaignStopRequest,
    AdCampaignSubmitRequest,
    EntityResponse,
)
from ...wallet_payments import (
    _campaign_payment_key,
    campaign_hold_minor,
    capture_campaign_budget,
    refund_stopped_campaign_budget,
    release_open_campaign_capture,
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


class AdCampaignReviewBody(AdCampaignReviewRequest):
    """The review request plus ``reviewReasonCode`` (P1-12), checked by the route
    (T7 missing, T8 unknown) so a bad value gets its stable refusal, never a 422."""

    reviewReasonCode: Optional[Any] = None


class AdCampaignWithdrawBody(AdCampaignSubmitRequest):
    """Withdraw (P1-03): the owner's version baseline and an ``operationId`` per (action,
    version), so a retried withdraw replays its committed result."""


# Refusal texts shared with the client's Arabic map: each ``detail`` STARTS with one of these
# (a dynamic part may follow). Never reword one; add a new text instead.
REFUSE_TOTAL_MIN = "The total budget must be at least "                   # T1
REFUSE_TOTAL_MAX = "The total budget must be at most "                    # T2
REFUSE_PER_DAY = "Budget per day is below the minimum"                    # T3
REFUSE_MAX_DAYS = "The ad can run for at most "                           # T4
REFUSE_INTAKE_PAUSED = "New ad requests are paused"                       # T5
REFUSE_DAILY_CAP = "Today's limit of new ad requests is reached"          # T6
REFUSE_REASON_MISSING = "Choose a reason for this decision"               # T7
REFUSE_REASON_UNKNOWN = "Unknown reason code"                             # T8
REFUSE_DURATION = "durationDays must be a whole number of days"           # T14
REFUSE_WITHDRAW_NOT_SUBMITTED = "Only Submitted campaigns can be withdrawn"                # P1-03
REFUSE_WITHDRAW_APPROVED = "This request was already approved — ask to stop it instead"  # P1-03

# P1-12: why staff sent a request back or rejected it (stored as reviewReasonCode). The client
# shows these labels verbatim; keep the codes stable (D33 sends legacy daily rows back with
# budget_dates).
REVIEW_REASON_LABELS: dict[str, dict[str, str]] = {
    "budget_dates": {"en": "Budget or dates", "ar": "الميزانية أو التواريخ"},
    "creative_quality": {"en": "Photo or video quality", "ar": "جودة الصورة أو الفيديو"},
    "text_policy": {"en": "Text breaks ad rules", "ar": "النص يخالف قواعد الإعلانات"},
    "targeting": {"en": "Audience or location", "ar": "الجمهور أو الموقع"},
    "page_access": {"en": "Page access", "ar": "صلاحية الصفحة"},
    "payment": {"en": "Payment", "ar": "الدفع"},
    "other": {"en": "Other", "ar": "أخرى"},
}
BUDGET_SCHEMA_VERSION = 2  # stamped by submit from P1 on: the request holds its total
# A Tripoli day began less than 26 hours ago, so a submit today touched its row within them.
_SUBMIT_DAY_WINDOW_MS = 26 * 60 * 60 * 1000


def _studio_setting(key: str) -> dict[str, Any]:
    """The current value of one studio setting (defaults until an admin saves it)."""
    from . import studio_settings  # late: studio_settings imports ad_campaign_fields, which imports this module

    return studio_settings.read_setting(key)["value"]


def _whole(value: Any) -> int:
    try:
        return max(int(float(value or 0)), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _usd(minor: int) -> str:
    minor = int(minor)
    return f"${minor // 100:,}.{minor % 100:02d}"


def _iso_day(value: Any) -> Optional[date]:
    try:
        return date.fromisoformat(str(value or "").strip()[:10])
    except ValueError:
        return None


def campaign_days(data: dict[str, Any]) -> int:
    """Days the request runs, both ends included: ``durationDays`` when set, else endDate -
    startDate + 1 (the classic form's count). 0 when neither tells."""
    days = data.get("durationDays")
    if isinstance(days, int) and not isinstance(days, bool) and days >= 1:
        return days
    start, end = _iso_day(data.get("startDate")), _iso_day(data.get("endDate"))
    if start is None or end is None or end < start:
        return 0
    return (end - start).days + 1


def campaign_total_minor(data: dict[str, Any], days: int) -> int:
    """What the request costs in USD cents: the lifetime amount, or the daily amount x days."""
    budget = _whole(data.get("budgetMinorUSD"))
    return budget * max(int(days), 0) if str(data.get("budgetType") or "").lower() == "daily" else budget


def enforce_budget_limits(days: int, total: int, limits: dict[str, Any]) -> None:
    """P1-15 (D4 + D5): the studio ``limits`` for a NEW request, in the client's order: days
    (T4), minimum total (T1), maximum total (T2), per-day floor (T3). The floor is the daily
    amount, or total / days; compared as total < floor x days, so no rounding decides."""
    max_days = int(limits["maxDays"])
    if days > max_days:
        raise HTTPException(status_code=400, detail=f"{REFUSE_MAX_DAYS}{max_days} days (this request: {days} days)")
    low, high = int(limits["minTotalMinorUSD"]), int(limits["maxTotalMinorUSD"])
    if total < low:
        raise HTTPException(status_code=400, detail=f"{REFUSE_TOTAL_MIN}{_usd(low)} (this request: {_usd(total)})")
    if total > high:
        raise HTTPException(status_code=400, detail=f"{REFUSE_TOTAL_MAX}{_usd(high)} (this request: {_usd(total)})")
    floor = int(limits["minPerDayMinorUSD"])
    if total < floor * max(days, 1):
        raise HTTPException(
            status_code=400,
            detail=f"{REFUSE_PER_DAY} of {_usd(floor)} (this request: {_usd(total // max(days, 1))} per day)",
        )


def _schema_version(data: dict[str, Any]) -> int:
    try:
        return int(data.get("schemaVersion") or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _instant(value: Any) -> Optional[datetime]:
    try:
        moment = datetime.fromisoformat(str(value or "").strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def legacy_budget_rules(data: dict[str, Any], limits: dict[str, Any]) -> bool:
    """P1-18(a): True when the request keeps the rules it was submitted under: it has no
    ``schemaVersion`` >= 2 (submitted before P1), or it was submitted before
    ``limits.p1CutoverAt``. While p1CutoverAt is null only the schemaVersion decides. A
    submitted time that cannot be read, with a cutover set, counts as legacy (never refuse
    on a guess)."""
    if _schema_version(data) < BUDGET_SCHEMA_VERSION:
        return True
    cutover = _instant(limits.get("p1CutoverAt")) if limits.get("p1CutoverAt") else None
    if cutover is None:
        return False
    submitted = _instant(data.get("submittedAt"))
    return submitted is None or submitted < cutover


def count_submissions_today(day: str) -> int:
    """How many sends (first submits and resubmits, all customers) the studio took on the
    Tripoli day ``day`` (YYYY-MM-DD). Each submit stamps ``submitDay`` and ``submitDayCount``
    on its row, so a request sent twice today counts twice; archived rows count too (the send
    happened). Only rows touched in the last 26 hours are read, and only two fields (never
    the images)."""
    with db_conn() as conn:
        rows = conn.execute(
            text(json_fields_select_sql(("submitDay", "submitDayCount"), (), "type = :type AND last_modified >= :since")),
            {"type": AD_CAMPAIGN_COLLECTION, "since": now_ms() - _SUBMIT_DAY_WINDOW_MS},
        ).mappings().all()
    return sum(max(_whole(row.get("f_submitdaycount")), 1) for row in rows if str(row.get("f_submitday") or "") == day)


def _review_reason_code(ctx: dict[str, Any], decision: str, raw: Any) -> str:
    """The reason code as sent ('' for an approval, which needs none): compared on replay,
    checked by _require_review_reason once the request is known to be reviewable."""
    if decision == "Approved" or raw is None:
        return ""
    return ctx["sanitize_str"](raw if isinstance(raw, str) else repr(raw), 60).strip()


def _require_review_reason(decision: str, code: str) -> None:
    if decision == "Approved":
        return
    if not code:
        raise HTTPException(
            status_code=400,
            detail=f"{REFUSE_REASON_MISSING} (reviewReasonCode: {', '.join(REVIEW_REASON_LABELS)})",
        )
    if code not in REVIEW_REASON_LABELS:
        raise HTTPException(
            status_code=400,
            detail=f"{REFUSE_REASON_UNKNOWN} '{code[:40]}'. Use one of: {', '.join(REVIEW_REASON_LABELS)}",
        )


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


def _money_guards(ctx: dict[str, Any]) -> tuple[Any, Any]:
    """The process locks one money transaction takes on SQLite, in the documented order: the
    entity-patch lock, then the wallet lock. PostgreSQL takes row and advisory locks inside the
    transaction instead (PLAN.md §7.8), so there both are no-ops."""
    if ctx["is_postgres"]():
        return nullcontext(), nullcontext()
    return ctx["sqlite_patch_lock"](), ctx["sqlite_wallet_lock"]()


def _lock_campaign_row(conn: Any, ctx: dict[str, Any], campaign_id: str) -> Any:
    """The live (not archived) request row, locked FOR UPDATE on PostgreSQL; None when missing."""
    suffix = " FOR UPDATE" if ctx["is_postgres"]() else ""
    return conn.execute(
        text(f"SELECT * FROM entities WHERE type = :type AND id = :id AND deleted = false LIMIT 1{suffix}"),
        {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
    ).mappings().first()


def release_capture_if_cycle_left(
    ctx: dict[str, Any], campaign_id: str, cycle: dict[str, Any], actor_id: str
) -> str:
    """P1-03b: an approval captured the budget of ``cycle`` (the request as that approval read
    it) and then lost its status write (409). If the request has LEFT that cycle since, nothing
    else will spend the capture, so the approval returns it itself (``rel:``, idempotent with
    every other door) and the ledger is back to its pre-submit state.

    "Left" is the rule of the wallet summary's "Being returned" (studio_wallet.cycle_state):
    sent back, rejected, withdrawn, resubmitted or archived while Submitted. A request still
    Submitted in that cycle (approving), Approved in it (a concurrent approval won: never
    released) or Stopped in it (the stop settled it) keeps its capture. One transaction in the
    lock order of PLAN.md §7.8: campaign row, then ``rel:`` key. Returns the NEW return row's
    id, or '' when nothing was returned.
    """
    from .studio_wallet import cycle_state  # late: studio_wallet -> studio_results imports this module

    cycle = {**cycle, "id": campaign_id}
    patch_guard, wallet_guard = _money_guards(ctx)
    suffix = " FOR UPDATE" if ctx["is_postgres"]() else ""
    with patch_guard, wallet_guard:
        with db_conn() as conn:
            # Archived rows too: an archived request keeps its status and cycle in its tombstone.
            row = conn.execute(
                text(f"SELECT data_json, deleted FROM entities WHERE type = :type AND id = :id LIMIT 1{suffix}"),
                {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
            ).mappings().first()
            live = None
            if row:
                live = {**(json_loads(row["data_json"] or "{}") or {}), "id": campaign_id, "archived": bool(row["deleted"])}
            if cycle_state(live, _campaign_payment_key(cycle)) != "being_returned":
                return ""
            return release_open_campaign_capture(conn, ctx, cycle, actor_id)


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
        entry = {
            "decision": decision,
            "note": ctx["sanitize_str"](str(raw.get("note") or ""), 2000),
            "reviewedAt": ctx["sanitize_str"](str(raw.get("reviewedAt") or ""), 80),
            "reviewedBy": ctx["sanitize_str"](str(raw.get("reviewedBy") or ""), 80),
        }
        reason = ctx["sanitize_str"](str(raw.get("reasonCode") or ""), 60)
        if reason in REVIEW_REASON_LABELS:  # P1-12; entries from before it have none
            entry["reasonCode"] = reason
        history.append(entry)
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
        submitted_at = ctx["iso_utc"]()
        limits = _studio_setting("limits")
        # From P1 every send is a new row (schemaVersion 2); only a p1CutoverAt still in the
        # future keeps this send under the old limit rules (P1-18(a)).
        legacy = legacy_budget_rules(
            {**current, "schemaVersion": BUDGET_SCHEMA_VERSION, "submittedAt": submitted_at}, limits
        )
        from .studio_posts import source_post_checked_first  # late: studio_posts imports this module

        # The picked post (T13, and its Meta read) is checked BEFORE main's process-wide media slot
        # (2 places) is taken: an Instagram read inside it would give other users' saves, submits
        # and approvals a 503. Inside the slot the strict validation then reads no Meta.
        with source_post_checked_first(current), ctx["media_validation_slot"](user):
            prepared = ctx["prepare_ad_campaign_fields"](
                {k: v for k, v in current.items() if k != "durationDays"} if legacy else current, strict=True
            )

        # P1-22: the intake switch and the daily cap, after validation (PLAN.md §7.8 order).
        today = ctx["business_today"]().isoformat()
        intake = _studio_setting("intake")
        if not intake.get("open"):
            raise HTTPException(
                status_code=409,
                detail=f"{REFUSE_INTAKE_PAUSED}. Your draft is saved; send it when requests open again.",
            )
        if count_submissions_today(today) >= int(intake.get("maxSubmissionsPerDay") or 0):
            raise HTTPException(
                status_code=409,
                detail=f"{REFUSE_DAILY_CAP}. Your draft is saved; send it tomorrow.",
            )

        # What the request costs and holds: the lifetime amount, or daily x days.
        days = campaign_days(prepared)
        total = campaign_total_minor(prepared, days)
        if total <= 0:
            raise HTTPException(status_code=400, detail="A campaign needs a budget greater than zero before submission")
        if not legacy:
            enforce_budget_limits(days, total, limits)

        actor_id = str(user.get("id") or "system")
        owner_id = str(creator or "")
        if not owner_id:
            raise HTTPException(status_code=409, detail="Campaign is missing its owner")
        released_tx = ""
        replayed_after_conflict = False
        # P1-02: ONE transaction in the lock order of PLAN.md §7.8: the owner's user row, the
        # campaign row, then the previous cycle's rel: key. A second send of the same owner
        # waits for the owner's row and then counts this one's hold, so two sends can never
        # reserve more than Available together.
        patch_guard, wallet_guard = _money_guards(ctx)
        with patch_guard, wallet_guard:
            with db_conn() as conn:
                try:
                    ctx["lock_and_validate_wallet_users"](conn, [owner_id], postgres=ctx["is_postgres"]())
                except HTTPException:
                    raise HTTPException(status_code=409, detail="Campaign is missing its owner")
                row = _lock_campaign_row(conn, ctx, campaign_id)
                if not row:
                    raise HTTPException(status_code=404, detail="Campaign request not found")
                entity = ctx["entity_from_db_row"](row)
                data = dict(entity.get("data") or {})
                if operation_id and str(data.get("lastSubmitOperationId") or "") == operation_id:
                    # An identical request committed while this one validated or waited for the
                    # lock: return its committed result and do not duplicate its audit entry.
                    saved = entity
                    replayed_after_conflict = True
                else:
                    baseline = int(entity.get("lastModified") or 0)
                    if baseline != int(body.expectedLastModified) or baseline != int(campaign.get("lastModified") or 0):
                        # Edited, sent, withdrawn or reviewed since the checks above read it.
                        raise HTTPException(status_code=409, detail="Conflict: record has changed")
                    # A capture left by a crashed approval of the PREVIOUS cycle would be
                    # charged twice on approval of this one (new key): return it first, so
                    # its money counts in the check below.
                    released_tx = release_open_campaign_capture(conn, ctx, {**data, "id": campaign_id}, actor_id)
                    # Money gate: the TOTAL must be AVAILABLE in the owner's USD wallet — a
                    # Submitted campaign holds it, approval captures it.
                    if ctx["wallet_available_after_holds"](conn, owner_id, "USD") < total:
                        raise HTTPException(
                            status_code=409,
                            detail="Insufficient wallet balance for this budget — charge the wallet first",
                        )
                    modified = max(now_ms(), baseline + 1)
                    data.update(
                        {
                            "status": "Submitted",
                            "submittedAt": submitted_at,
                            "submittedBy": actor_id,
                            "reviewedAt": None,
                            "reviewedBy": None,
                            "reviewNote": "",
                            "reviewDecision": "",
                            "reviewReasonCode": "",
                            "lastSubmitOperationId": operation_id,
                            "schemaVersion": BUDGET_SCHEMA_VERSION,
                            "totalBudgetMinorUSD": total,
                            "legacyRules": legacy,
                            "submitDay": today,
                            "submitDayCount": (
                                _whole(current.get("submitDayCount")) + 1 if str(current.get("submitDay") or "") == today else 1
                            ),
                            "_lastModified": modified,
                        }
                    )
                    result = conn.execute(
                        text(
                            "UPDATE entities SET data_json = :d, last_modified = :m "
                            "WHERE type = :t AND id = :id AND deleted = false AND last_modified = :baseline"
                        ),
                        {"d": json_dumps(data), "m": modified, "t": AD_CAMPAIGN_COLLECTION, "id": campaign_id, "baseline": baseline},
                    )
                    if int(result.rowcount or 0) != 1:
                        raise HTTPException(status_code=409, detail="Conflict: record has changed")  # rolls the release back too
                    saved = {**entity, "data": data, "lastModified": modified}
        if released_tx:
            ctx["audit"](actor_id, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id, f"Returned an orphan capture for {campaign_id}", {"transactionId": released_tx})
        if not replayed_after_conflict:
            ctx["audit"](
                actor_id,
                "submit",
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                f"Submitted campaign request {campaign_id} for review",
                {"operationId": operation_id, "totalBudgetMinorUSD": total, "legacyRules": legacy},
            )
        return EntityResponse(**ctx["project_entity_media_for_user"](saved, user, False))

    @router.post("/{campaign_id}/review", response_model=EntityResponse)
    def review_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignReviewBody,
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
        reason_code = _review_reason_code(ctx, decision, body.reviewReasonCode)
        if operation_id and str(current.get("lastReviewOperationId") or "") == operation_id:
            if (
                str(current.get("reviewDecision") or "") != decision
                or str(current.get("reviewNote") or "") != note
                or str(current.get("reviewReasonCode") or "") != reason_code
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
        _require_review_reason(decision, reason_code)
        limits = _studio_setting("limits")
        # P1-18(a): a request keeps the rules it was submitted under. From P1 (schemaVersion
        # 2) it holds its total and keeps its duration; before P1 it keeps the old date rule.
        p1_row = _schema_version(current) >= BUDGET_SCHEMA_VERSION
        legacy = legacy_budget_rules(current, limits)
        held_minor = campaign_hold_minor(current)
        bumped_dates: dict[str, str] = {}
        if decision == "Approved":
            today = ctx["business_today"]()  # the Libya day: approval at 00:30 local is already "today"
            _today_iso = today.strftime("%Y-%m-%d")
            if p1_row:
                # P1-11: a start that passed while the request waited is not the customer's
                # fault. It starts on approval day and still runs all its days.
                days = campaign_days(current)
                start = _iso_day(current.get("startDate"))
                if start is not None and days > 0 and start < today:
                    bumped_dates = {"startDate": _today_iso, "endDate": (today + timedelta(days=days - 1)).isoformat()}
            elif str(current.get("startDate") or "")[:10] < _today_iso <= str(current.get("endDate") or "9999")[:10]:
                bumped_dates = {"startDate": _today_iso}  # before P1: starts today, ends as asked
            elif str(current.get("endDate") or "9999")[:10] < _today_iso:
                raise HTTPException(status_code=409, detail="The campaign dates have passed; request changes so the customer can re-date it")
            current = {**current, **bumped_dates}
            # Approval means launch-ready. Revalidate server-side so older clients
            # and legacy drafts cannot bypass today's targeting/link rules (a legacy
            # row is checked without today's day limit, as it was submitted).
            with ctx["media_validation_slot"](user):
                ctx["prepare_ad_campaign_fields"](
                    {k: v for k, v in current.items() if k != "durationDays"} if legacy else current, strict=True
                )
            if p1_row:
                # P1-06/P1-15: the total again, under today's limits for a new row; it
                # must still be what the request holds (the capture takes the hold).
                days = campaign_days(current)
                total = campaign_total_minor(current, days)
                if not legacy:
                    enforce_budget_limits(days, total, limits)
                if total != held_minor:
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")
        actor_id = str(user.get("id") or "system")
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
        entry = {"decision": decision, "note": note, "reviewedAt": reviewed_at, "reviewedBy": actor_id}
        if reason_code:
            entry["reasonCode"] = reason_code
        history.append(entry)
        history = history[-MAX_AD_CAMPAIGN_REVIEW_HISTORY:]
        transition_fields: dict[str, Any] = {
            "status": decision,
            "reviewDecision": decision,
            "reviewedAt": reviewed_at,
            "reviewedBy": actor_id,
            "reviewNote": note,
            "reviewReasonCode": reason_code,
            "reviewHistory": history,
            "lastReviewOperationId": operation_id,
            "legacyRules": legacy,
        }
        if decision == "Approved":
            transition_fields.update(
                {
                    "approvedAt": reviewed_at,
                    "approvedBy": actor_id,
                    "paidMinorUSD": held_minor,  # = the capture (the hold); stop reads the ledger row itself
                    "paymentTransactionId": wallet_payment_tx,
                    "paidAt": reviewed_at,
                }
            )
            if p1_row:
                transition_fields["totalBudgetMinorUSD"] = held_minor
        elif decision == "Rejected":
            transition_fields.update({"rejectedAt": reviewed_at, "rejectedBy": actor_id})
        transition_fields.update(bumped_dates)
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
                or str(latest_data.get("reviewReasonCode") or "") != reason_code
            ):
                if decision == "Approved" and wallet_payment_tx:
                    # P1-03b: this approval lost after its capture. If the request left the
                    # captured cycle (withdrawn, sent back, rejected, archived), return the
                    # capture now instead of leaving it for a sweep; then answer the 409.
                    returned_tx = release_capture_if_cycle_left(ctx, campaign_id, current, actor_id)
                    if returned_tx:
                        ctx["audit"](actor_id, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id,
                                     f"Returned the capture of an interrupted approval of {campaign_id}",
                                     {"transactionId": returned_tx, "operationId": operation_id})
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
                 "budgetMinorUSD": int(current.get("budgetMinorUSD") or 0), "reviewReasonCode": reason_code,
                 "heldMinorUSD": held_minor, "legacyRules": legacy},
            )
        if replayed_after_conflict and str((saved.get("data") or {}).get("status") or "Draft") not in {
            "Submitted", "Approved", "Rejected", "Stopped"
        }:
            return EntityResponse(**_redacted_ad_campaign_tombstone(saved))
        return EntityResponse(**ctx["project_entity_media_for_user"](saved, user, False))

    @router.post("/{campaign_id}/withdraw", response_model=EntityResponse)
    def withdraw_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignWithdrawBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """P1-03: the owner takes a Submitted request back to Draft; its hold ends at once.

        Owner only (anyone else gets 404, a lapsed plan is fine: it only returns the owner's
        own money). ONE locked transaction, campaign row then ``rel:`` key (PLAN.md §7.8):
        Draft + ``withdrawnAt`` + ``lastWithdrawOperationId``, keeping ``submittedAt`` and
        ``lastSubmitOperationId`` (the cycle's payment key), and a capture this cycle already
        had (an approval between its capture and its status write) returns in the same
        transaction. A replay with the same operationId returns the committed result."""
        require_same_origin(request)
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        actor_id = str(user.get("id") or "")
        released_tx = ""
        patch_guard, wallet_guard = _money_guards(ctx)
        with patch_guard, wallet_guard:
            with db_conn() as conn:
                row = _lock_campaign_row(conn, ctx, campaign_id)
                if not row:
                    raise HTTPException(status_code=404, detail="Campaign request not found")
                entity = ctx["entity_from_db_row"](row)
                data = dict(entity.get("data") or {})
                creator = str(entity.get("createdBy") or data.get("createdBy") or "")
                if not actor_id or actor_id != creator:
                    # Owner only: staff send a request back instead, and nobody else learns it exists.
                    raise HTTPException(status_code=404, detail="Campaign request not found")
                if not ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "submit", record_creator_id=creator):
                    raise HTTPException(status_code=403, detail="Forbidden")
                if str(data.get("lastWithdrawOperationId") or "") == operation_id:
                    # The first response was lost after commit — replay it.
                    return EntityResponse(**ctx["project_entity_media_for_user"](entity, user, False))
                ctx["enforce_ad_campaign_rate"](user)
                status = str(data.get("status") or "Draft")
                if status == "Approved":
                    # The approval locked the row first: the money is in the ad now.
                    raise HTTPException(status_code=409, detail=REFUSE_WITHDRAW_APPROVED)
                if status != "Submitted":
                    raise HTTPException(status_code=409, detail=REFUSE_WITHDRAW_NOT_SUBMITTED)
                baseline = int(entity.get("lastModified") or 0)
                if baseline != int(body.expectedLastModified):
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")
                released_tx = release_open_campaign_capture(conn, ctx, {**data, "id": campaign_id}, actor_id)
                modified = max(now_ms(), baseline + 1)
                data.update(
                    {
                        "status": "Draft",
                        "withdrawnAt": ctx["iso_utc"](),
                        "lastWithdrawOperationId": operation_id,
                        "_lastModified": modified,
                    }
                )
                result = conn.execute(
                    text(
                        "UPDATE entities SET data_json = :d, last_modified = :m "
                        "WHERE type = :t AND id = :id AND deleted = false AND last_modified = :baseline"
                    ),
                    {"d": json_dumps(data), "m": modified, "t": AD_CAMPAIGN_COLLECTION, "id": campaign_id, "baseline": baseline},
                )
                if int(result.rowcount or 0) != 1:
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")  # rolls the return back too
                entity = {**entity, "data": data, "lastModified": modified}
        if released_tx:
            ctx["audit"](actor_id, "wallet_release", AD_CAMPAIGN_COLLECTION, campaign_id,
                         f"Returned the capture of withdrawn request {campaign_id}", {"transactionId": released_tx})
        ctx["audit"](
            actor_id,
            "withdraw",
            AD_CAMPAIGN_COLLECTION,
            campaign_id,
            f"Withdrew campaign request {campaign_id} to Draft",
            {"operationId": operation_id, "submittedAt": str(data.get("submittedAt") or ""), "releasedTransactionId": released_tx},
        )
        return EntityResponse(**ctx["project_entity_media_for_user"](entity, user, False))

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
