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

Studio code and the LINK step (P1-09, P3-02, P0-09b; owner decision D26: the
studio runs on the same ad accounts as the agency):

* Approval stamps ``studioRef`` (``ALB-S-`` + 8 characters, unique among all
  requests, archived ones too; assign_studio_ref) and ``studioName``
  ("<studioRef> · <request name>", studio_types.studio_campaign_name).
* ``publish-status`` with ``metaAdAccountId`` + ``metaCampaignId`` links the
  Approved request to the Meta campaign staff made (any name): the account must
  be on the allowlist, the campaign must exist in it and be claimed by no other
  request; the Meta name is renamed to ``studioName`` when it lacks the code and
  the stored token reading shows ``ads_management``, else staff get 409
  NEEDS_MANUAL_RENAME with the name to copy. The link claims the campaign
  (meta_collisions: discovery and import skip it) and removes Manager's
  untouched copies of it in the same transaction (_claim_and_write).
* ``unlink-meta`` (staff, with a reason) undoes a link made by mistake while the
  request is Approved: the claim is released and the removed copies restored in
  one transaction, then the campaign gets its previous Meta name back (best
  effort; _unlink_meta_campaign).

Inbox and stop requests (P3-05, P3-10): a review, the link or "live" marker and
a staff stop add an item to the owner's inbox after their commit (studio_activity.py;
never failing the action). ``POST /{id}/stop-request`` is built in studio_stop.py and
registered on this router; it sets ``stopRequestedAt`` (kept as history), and a stop
through /stop resolves the ad's open stop request and its ticket.

Settle gates and the admin override (P3-06a, P3-06d; PLAN.md §7.8 rule 5; D27, D28).
The staff branch of /stop is the SETTLE step of a request linked by the desk, judged
on Meta's numbers (its ``adCampaignResults`` row, read on the stop's own transaction,
never locked): refused while Meta still delivers, while the sync has not seen delivery
end, while the final read is pending (``settleReadAt`` missing and no spend confirmed
after ``deliveryEndedAt`` + ``settlement.spendDelayHours``, 48 h by default) and when
the ad account does not bill in USD; a never-delivered ad (0 impressions, $0 once
delivery ended) returns the whole payment at once. The refund is capped at paid minus
Meta's confirmed spend (the default when staff give no amount; above it 400). Every
gate and the cap can be lifted only by an admin through ``POST /{id}/settle-override``
with a written reason (10-300 characters), audited ``settle_override`` (kept forever)
with the row before and after; what comes back above the cap, and Meta spend above the
payment, is absorbed by Albayan (D27) and raises the ``meta_overspend`` alert. A settle
stores ``settleBasis`` (final_read | never_delivered | override | never_linked),
``metaSpendAtSettleMinorUSD`` (Meta's confirmed spend at that moment, or null),
``settledSpendMinorUSD`` (what the drift watch compares Meta's later spend with) and
``settledAt``; see settle_plan (pure, tested in test_studio_settle.py).
"""

import math
import re
import unicodedata
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from sqlalchemy import text

from ... import meta_ads as _meta
from ... import meta_collisions as _collisions
from ...db import db_conn, json_dumps, json_fields_select_sql, json_loads, now_ms
from ...rate_limiter import check_rate_limit
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
from . import studio_types
from .studio_types import is_studio_ref, studio_campaign_name

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


class AdCampaignPublishStatusBody(AdCampaignPublishStatusRequest):
    """publish-status: the LINK step or the launch marker (staff only).

    * Link (P1-09, P3-02, P0-09b): ``metaAdAccountId`` + ``metaCampaignId`` (``publishStatus``
      left out or ``meta_review``, which the link sets).
    * Marker: ``publishStatus`` live / paused / '' (cleared), optionally with a Meta campaign id.

    The version baseline is ``expectedVersion`` or ``expectedLastModified`` (the same number: the
    request's lastModified); one of them is required.
    """

    expectedLastModified: Optional[int] = Field(default=None, ge=0)
    expectedVersion: Optional[int] = Field(default=None, ge=0)
    publishStatus: Optional[Literal["live", "paused", "meta_review", ""]] = None
    metaAdAccountId: Optional[str] = Field(default=None, max_length=40)


class AdCampaignUnlinkBody(AdCampaignSubmitRequest):
    """unlink-meta (staff only): the version baseline, an ``operationId`` (a replay answers the first
    result) and ``reason``, checked by the route (3-300 characters) so a bad one gets its refusal text."""

    reason: Optional[Any] = None


class AdCampaignSettleOverrideBody(AdCampaignSubmitRequest):
    """settle-override (P3-06d, admin only): the version baseline, an ``operationId`` (a replay
    answers the first result), ``refundMinorUSD`` (required; may exceed the cap, never the payment)
    and ``reason`` (10-300 characters, audited), both checked by the route for stable refusals."""

    refundMinorUSD: Optional[Any] = None
    reason: Optional[Any] = None
    closeReason: Optional[Literal["", "staff_stop", "completed"]] = None


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
# The staff desk's LINK step (P1-09, P3-02, P0-09b; owner decision D26).
REFUSE_LINK_NOT_APPROVED = "Only Approved requests can be linked to a Meta campaign"
REFUSE_LINK_BAD_ACCOUNT_ID = "Invalid Meta ad account id"
REFUSE_LINK_BAD_CAMPAIGN_ID = "Invalid Meta campaign id"
REFUSE_LINK_ACCOUNT = "This Meta ad account is not one of Albayan's ad accounts"
REFUSE_LINK_NOT_FOUND = "The Meta campaign was not found"
REFUSE_LINK_WRONG_ACCOUNT = "This Meta campaign is not in the chosen ad account"
REFUSE_LINK_TAKEN = "This Meta campaign is already linked to another request"
REFUSE_LINK_OTHER_CODE = "This Meta campaign carries another request's studio code"
REFUSE_LINK_RELINK = "This request is already linked to another Meta campaign"
REFUSE_LINK_META_BUSY = "Meta is busy right now, so the campaign could not be linked"
REFUSE_LINK_META_FAILED = "Meta could not return this campaign"
REFUSE_LINK_NOT_CONFIGURED = "The Meta connection is not configured"
REFUSE_LINK_RATE = "Too many Meta links"
REFUSE_STUDIO_REF = "Could not assign a studio code"
# 409 with detail {code, message, studioRef, studioName}: the token lacks ads_management (or Meta
# refused the rename), so staff rename the campaign by hand ("Copy name") and link again.
NEEDS_MANUAL_RENAME = "NEEDS_MANUAL_RENAME"
REFUSE_NEEDS_MANUAL_RENAME = "Rename the campaign in Meta to the name shown, then link again"
# Link warnings (codes in the response's ``warnings``; the link still happens).
LINK_WARNING_BUDGET_ABOVE_PAID = "meta_budget_above_paid"  # Meta's budget is above what the customer paid
LINK_RATE_PER_MINUTE = 20
# The staff UNLINK (undoes a link made by mistake). A closed month refuses it with the platform's
# closed-month 423 ("Financial period YYYY-MM is closed. An Admin must unlock it before editing.").
REFUSE_UNLINK_REASON = "Write why the link is removed (3 to 300 characters)"
REFUSE_UNLINK_NOT_APPROVED = "Only an Approved request can be unlinked from its Meta campaign"
REFUSE_UNLINK_NOT_LINKED = "This request is not linked to a Meta campaign"
UNLINK_REASON_CHARS = (3, 300)
LAUNCHED_MARKERS = frozenset({"live", "paused"})  # a link keeps these (a legacy request marked by hand)
# P3-06a settle gates of the staff stop (PLAN.md §7.8 rule 5; D28) and the P3-06d admin override.
# Each ``detail`` starts with one of these; SETTLE_NOT_READY is a 409 with a dict detail
# {code, message, messageAr, readyAt} (the NEEDS_MANUAL_RENAME shape), so the desk can show a countdown.
REFUSE_SETTLE_DELIVERING = "Meta is still delivering this ad"
REFUSE_SETTLE_NOT_ENDED = "Meta has not confirmed that this ad ended"
REFUSE_SETTLE_NOT_READY = "The final amount is not ready"
REFUSE_SETTLE_NOT_USD = "This ad account does not bill in USD"
REFUSE_REFUND_ABOVE_CAP = "refundMinorUSD is above paid minus Meta spend"
REFUSE_REFUND_ABOVE_PAID = "refundMinorUSD must be between 0 and the paid budget"
REFUSE_REFUND_LAUNCHED = "refundMinorUSD is required for a launched campaign (0 closes it without a refund)"
REFUSE_REFUND_RANGE = "refundMinorUSD must be between 0 and the unspent captured budget"
REFUSE_OVERRIDE_ADMIN = "Only an admin can override the settlement rules"
REFUSE_OVERRIDE_OWN = "Nobody can override the settlement of their own request"
REFUSE_OVERRIDE_REASON = "Write why the settlement rules are lifted (10 to 300 characters)"
REFUSE_OVERRIDE_REFUND = "refundMinorUSD is required for an override (0 closes the ad without a refund)"
SETTLE_NOT_READY = "SETTLE_NOT_READY"
SETTLE_NOT_READY_AR = "المبلغ النهائي غير جاهز"
OVERRIDE_REASON_CHARS = (10, 300)
SETTLE_BASES = ("final_read", "never_delivered", "override", "never_linked")
AUDIT_SETTLE_OVERRIDE = "settle_override"  # in main's permanent keep list (P1-04)
# The row before and after an override, in its audit entry (money and lifecycle fields only).
_SETTLE_AUDIT_FIELDS = (
    "status", "publishStatus", "closeReason", "refundMinorUSD", "spendMinorUSD", "settleBasis",
    "settledSpendMinorUSD", "metaSpendAtSettleMinorUSD", "settleOverrideReason", "settledAt",
)
META_OVERSPEND_ALERT = "meta_overspend"  # studio_jobs.ALERT_KINDS (label: agent B / studio_jobs.ALERT_LABELS)
_STUDIO_REF_ATTEMPTS = 8

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


_REVIEW_ACTIVITY = {"Approved": "request_approved", "Changes Requested": "request_sent_back", "Rejected": "request_rejected"}


def _tell_owner(owner_id: str, kind: str, campaign_id: str, key: Any, **params: Any) -> None:
    """P3-05: an item in the owner's inbox after a committed change (studio_activity.py). The same
    event key never writes twice, and a failure never fails the action."""
    from .studio_activity import record_activity_safe  # late: studio_activity imports this module

    record_activity_safe(owner_id=owner_id, kind=kind, related_type="campaign", related_id=campaign_id, key=key,
                         params=params)


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


def utc_now() -> datetime:
    """The settle gates' clock (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _iso_utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _settle_not_ready(now: datetime, ready_at: datetime) -> HTTPException:
    """409 SETTLE_NOT_READY: the final Meta read is due at ``ready_at`` (bilingual, with the time)."""
    when = _iso_utc(ready_at)
    if now < ready_at:
        message = f"{REFUSE_SETTLE_NOT_READY} until {when}"
        message_ar = f"{SETTLE_NOT_READY_AR} قبل {when}"
    else:
        message = f"{REFUSE_SETTLE_NOT_READY}: Meta's final read is still pending (due {when})"
        message_ar = f"{SETTLE_NOT_READY_AR}: قراءة ميتا النهائية لم تصل بعد (موعدها {when})"
    return HTTPException(
        status_code=409,
        detail={"code": SETTLE_NOT_READY, "message": message, "messageAr": message_ar, "readyAt": when},
    )


def settle_plan(
    data: dict[str, Any],
    results: dict[str, Any] | None,
    captured: int,
    refund: Any,
    now: datetime,
    settlement: dict[str, Any] | None,
    *,
    override_reason: str = "",
) -> dict[str, Any]:
    """P3-06a: what the staff stop of one Approved request may return (PURE; PLAN.md §7.8 rule 5).

    ``data``: the request's fields; ``results``: its adCampaignResults row (any shape) or None;
    ``captured``: what its cycle's ``cpay:`` row paid; ``refund``: the amount staff asked for, or
    None; ``settlement``: the settlement setting (``spendDelayHours``). Returns ``{"refund",
    "capMinorUSD", "metaSpendMinorUSD", "settleBasis", "absorbedMinorUSD"}`` or raises the refusal.

    A request LINKED by the desk (metaAdAccountId + metaCampaignId, studio_results.linked_meta_ids)
    is judged on Meta's numbers:

    * never delivered (the results row says so: 0 impressions and $0 once delivery ended, D28) ->
      the whole payment may return at once, ``settleBasis`` never_delivered;
    * else refused while Meta still delivers (409), while the sync has not seen delivery end
      (409), while the final read is pending: ``settleReadAt`` missing and no spend confirmed at or
      after ``deliveryEndedAt`` + ``spendDelayHours`` (409 SETTLE_NOT_READY with ``readyAt``), and
      when the ad account does not bill in USD (409): each of these needs the admin override;
    * else the refund is capped at paid minus Meta's confirmed spend (the default when no amount
      is given; above it 400), ``settleBasis`` final_read.

    The admin override (P3-06d, ``override_reason``) lifts every gate and the cap: the refund may
    reach the whole payment, never more (400), ``settleBasis`` override. ``absorbedMinorUSD`` is
    what Albayan pays out of its own pocket (D27): Meta's spend plus the refund above the payment.

    A request never linked by the desk keeps the older rule: a launched one (a publish marker or a
    Meta id set by hand) needs an explicit amount, bounded by what the request itself recorded as
    spent; ``settleBasis`` is never_linked when it carries no launch marker at all, else '' (a
    legacy hand-marked row: nothing is known about its Meta spend).
    """
    from .studio_diagnostics import parse_time  # late: the studio modules import this one
    from .studio_results import linked_meta_ids, meta_delivery, normalize_results

    captured = max(int(captured or 0), 0)
    override = bool(str(override_reason or "").strip())
    link = linked_meta_ids(data)
    if link is None:
        spent = min(_whole(data.get("spendMinorUSD")), captured)
        launched = bool(str(data.get("publishStatus") or "").strip() or str(data.get("metaCampaignId") or "").strip())
        if refund is None and launched and not override:
            # A launched campaign has (almost surely) spent on Meta and nothing
            # records that spend: defaulting to the whole budget refunded it.
            raise HTTPException(status_code=400, detail=REFUSE_REFUND_LAUNCHED)
        cap = captured - spent
        amount = int(refund) if refund is not None else cap
        if amount < 0 or amount > (captured if override else cap):
            raise HTTPException(status_code=400, detail=REFUSE_REFUND_ABOVE_PAID if override else REFUSE_REFUND_RANGE)
        return {
            "refund": amount, "capMinorUSD": cap, "metaSpendMinorUSD": None,
            "settleBasis": "override" if override else ("" if launched else "never_linked"),
            "absorbedMinorUSD": max(amount - cap, 0),
        }
    row = normalize_results(results) if results else None
    if row is not None and row["metaCampaignId"] != link[1]:
        row = None  # the row of an earlier link: nothing is known about this campaign
    meta_spend: int | None = None
    if row is not None and row["currency"] == "USD" and row["spendConfirmedAt"]:
        meta_spend = int(row["spendMinorUSD"])
    never = bool(row is not None and row["neverDelivered"] and row["spendMinorUSD"] == 0 and not row["lifetimeImpressions"])
    if override:
        cap, basis = max(captured - (meta_spend or 0), 0), "override"
    elif never:
        cap, basis, meta_spend = captured, "never_delivered", 0
    else:
        if row is not None and meta_delivery(data, row, now)["delivering"]:
            raise HTTPException(status_code=409, detail=REFUSE_SETTLE_DELIVERING)
        if row is not None and row["currency"] and row["currency"] != "USD":
            raise HTTPException(status_code=409, detail=REFUSE_SETTLE_NOT_USD)
        ended = parse_time(row["deliveryEndedAt"]) if row is not None else None
        if ended is None:
            raise HTTPException(status_code=409, detail=REFUSE_SETTLE_NOT_ENDED)
        hours = int((settlement or {}).get("spendDelayHours", 48))
        ready_at = ended + timedelta(hours=hours)
        confirmed = parse_time(row["spendConfirmedAt"])
        final = row["settleReadAt"] is not None or (confirmed is not None and confirmed >= ready_at)
        if not final or meta_spend is None:
            raise _settle_not_ready(now, ready_at)
        cap, basis = max(captured - meta_spend, 0), "final_read"
    amount = int(refund) if refund is not None else cap
    if amount < 0 or amount > (captured if override else cap):
        raise HTTPException(status_code=400, detail=REFUSE_REFUND_ABOVE_PAID if override else REFUSE_REFUND_ABOVE_CAP)
    return {
        "refund": amount, "capMinorUSD": cap, "metaSpendMinorUSD": meta_spend, "settleBasis": basis,
        "absorbedMinorUSD": max((meta_spend or 0) + amount - captured, 0),
    }


def _raise_overspend_alert(conn: Any, campaign_id: str, owner_id: str, plan: dict[str, Any], captured: int, now: datetime) -> None:
    """D27: Albayan absorbs Meta spend above the payment (and an override above the cap): one
    ``meta_overspend`` alert per request and day, on the settle's own transaction. An alert kind
    the jobs module does not know yet is skipped, never a failed settle."""
    from .studio_jobs import raise_alert  # late: studio_jobs imports this module

    try:
        raise_alert(
            conn, META_OVERSPEND_ALERT, related_type=AD_CAMPAIGN_COLLECTION, related_id=campaign_id, owner_id=owner_id,
            details={"campaignId": campaign_id, "paidMinorUSD": captured, "metaSpendMinorUSD": plan["metaSpendMinorUSD"],
                     "refundMinorUSD": plan["refund"], "capMinorUSD": plan["capMinorUSD"],
                     "absorbedMinorUSD": plan["absorbedMinorUSD"], "settleBasis": plan["settleBasis"]},
            now=now,
        )
    except ValueError:
        pass


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


# ---------------------------------------------------------------- studio code (P1-09, D26)


def _studio_ref_taken(conn: Any, ref: str, campaign_id: str) -> bool:
    """True when ANOTHER request (archived ones too) already carries this studio code. Only rows
    whose text holds the code are parsed (a request carries its photos inline)."""
    rows = conn.execute(
        text(json_fields_select_sql(("studioRef",), ("id",), "type = :type AND id <> :id AND data_json LIKE :pattern")),
        {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id, "pattern": f"%{ref}%"},
    ).mappings().all()
    return any(str(row.get("f_studioref") or "").strip().upper() == ref for row in rows)


def assign_studio_ref(conn: Any, campaign_id: str, data: dict[str, Any]) -> str:
    """The request's studio code: the one it has, else the first free ``studio_ref(id, attempt)``.

    The code of attempt 0 is fixed by the campaign id, so a retry finds the same code; another
    request already holding it moves this one to attempt 1, 2, ... Two approvals racing can only
    collide when two campaign ids share their first 40 hash bits (about one pair in a million
    million), so the check runs outside the approval's write.
    """
    own = str(data.get("studioRef") or "").strip().upper()
    if is_studio_ref(own):
        return own
    for attempt in range(_STUDIO_REF_ATTEMPTS):
        ref = studio_types.studio_ref(campaign_id, attempt)
        if not _studio_ref_taken(conn, ref, campaign_id):
            return ref
    raise HTTPException(status_code=503, detail=f"{REFUSE_STUDIO_REF}. Try again.")


def _studio_fields(campaign_id: str, data: dict[str, Any]) -> dict[str, str]:
    """``studioRef`` + ``studioName`` ("<code> · <request name>") for an approval."""
    with db_conn() as conn:
        ref = assign_studio_ref(conn, campaign_id, data)
    return {"studioRef": ref, "studioName": studio_campaign_name(ref, data.get("name"))}


# ---------------------------------------------------------------- the LINK step (P1-09, P3-02, P0-09b)


def _expected_version(body: AdCampaignPublishStatusBody) -> int:
    value = body.expectedVersion if body.expectedVersion is not None else body.expectedLastModified
    if value is None:
        raise HTTPException(status_code=400, detail="expectedVersion is required")
    return int(value)


def _clean_meta_number(value: Any, refusal: str) -> str:
    raw = str(value or "").strip()
    digits = raw[4:] if raw.lower().startswith("act_") and refusal == REFUSE_LINK_BAD_ACCOUNT_ID else raw
    if not (digits.isascii() and digits.isdigit() and 1 <= len(digits) <= 40):
        raise HTTPException(status_code=400, detail=refusal)
    return digits


def _account_digits(value: Any) -> str:
    raw = str(value or "").strip()
    return raw[4:] if raw.startswith("act_") else raw


def _name_carries(name: Any, ref: str) -> bool:
    """The Meta name holds this request's studio code (any case; typed by hand in Ads Manager)."""
    return bool(ref) and ref in unicodedata.normalize("NFKC", str(name or "")).upper()


def _meta_budget_minor(data: dict[str, Any], meta: dict[str, Any]) -> int:
    """What Meta may spend on the campaign, in the account's minor units (0 = no budget read):
    the campaign's lifetime budget, else its daily budget x the request's days, else the ad sets'
    lifetime budgets plus their daily budgets x days."""
    days = max(campaign_days(data), 1)
    if _whole(meta.get("lifetimeBudgetMinor")):
        return _whole(meta.get("lifetimeBudgetMinor"))
    if _whole(meta.get("dailyBudgetMinor")):
        return _whole(meta.get("dailyBudgetMinor")) * days
    return _whole(meta.get("adSetLifetimeBudgetMinor")) + _whole(meta.get("adSetDailyBudgetMinor")) * days


def _link_warnings(data: dict[str, Any], meta: dict[str, Any]) -> tuple[list[str], int]:
    """P3-02: (warning codes, Meta budget in minor units). The budget is compared only for a USD
    account, with what the customer paid (the approval's capture)."""
    budget = _meta_budget_minor(data, meta)
    paid = _whole(data.get("paidMinorUSD")) or campaign_hold_minor(data)
    warnings = []
    if str(meta.get("currency") or "").upper() == "USD" and budget and paid and budget > paid:
        warnings.append(LINK_WARNING_BUDGET_ABOVE_PAID)
    return warnings, budget


def _meta_link_error(error: Any) -> HTTPException:
    """A MetaAdsError of the link's Meta read, as the desk's refusal."""
    code = str(getattr(error, "code", "") or "")
    provider = str(getattr(error, "provider_code", "") or "")
    if code == "not_configured":
        return HTTPException(status_code=503, detail=REFUSE_LINK_NOT_CONFIGURED)
    if getattr(error, "retryable", False):
        wait = max(_meta.studio_meta_pause_seconds(), 60)
        return HTTPException(status_code=503, detail=f"{REFUSE_LINK_META_BUSY}. Try again in a minute.",
                             headers={"Retry-After": str(wait)})
    if code in {"not_found", "invalid_id"} or provider.split(".")[0] == "100":
        return HTTPException(status_code=400, detail=REFUSE_LINK_NOT_FOUND)
    if code == "account_not_allowed":
        return HTTPException(status_code=400, detail=REFUSE_LINK_ACCOUNT)
    return HTTPException(status_code=502, detail=f"{REFUSE_LINK_META_FAILED}" + (f" (Meta code {provider})" if provider else ""))


def _check_meta_connection(error: Any) -> None:
    """A link read or rename Meta refused for authorization runs the studio's token check, as Social
    Studio's replies do (studio_ig_poll.after_meta_authorization_failure; never raises)."""
    if getattr(error, "code", "") == "authorization":
        from .studio_ig_poll import after_meta_authorization_failure  # late: its neighbours import this module

        after_meta_authorization_failure()


def _needs_manual_rename(ref: str, name: str) -> HTTPException:
    return HTTPException(status_code=409, detail={
        "code": NEEDS_MANUAL_RENAME, "message": REFUSE_NEEDS_MANUAL_RENAME, "studioRef": ref, "studioName": name,
    })


def _enforce_link_rate(user: dict[str, Any]) -> None:
    """At most LINK_RATE_PER_MINUTE links per staff account a minute (each one reads Meta)."""
    allowed, _left, retry_after_ms = check_rate_limit(
        f"ad-studio:link:{user.get('id')}", LINK_RATE_PER_MINUTE, 60_000
    )
    if not allowed:
        raise HTTPException(
            status_code=429, detail=f"{REFUSE_LINK_RATE}. Please wait a minute.",
            headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
        )


def _link_view(data: dict[str, Any]) -> dict[str, Any]:
    """What a link answers next to the request: {renamed, removedManagerCopies, keptManagerCopies,
    warnings, studioRef, studioName}, from the result the link stored (a replay answers the same)."""
    stored = data.get("metaLinkResult") if isinstance(data.get("metaLinkResult"), dict) else {}
    return {
        "renamed": stored.get("renamed") is True,
        "removedManagerCopies": _whole(stored.get("removedManagerCopies")),
        "keptManagerCopies": _whole(stored.get("keptManagerCopies")),
        "warnings": [str(item) for item in stored.get("warnings") or [] if isinstance(item, str)][:10],
        "studioRef": str(data.get("studioRef") or ""),
        "studioName": str(data.get("studioName") or ""),
    }


def _claim_and_write(
    ctx: dict[str, Any],
    campaign_id: str,
    *,
    operation_id: str,
    baseline: int,
    meta_campaign_id: str,
    actor_id: str,
    fields_for: Callable[[dict[str, Any]], dict[str, Any]],
    not_approved: str,
    before_write: Optional[Callable[[], None]] = None,
    complete_marker: bool = False,
) -> tuple[dict[str, Any], Optional[dict[str, Any]]]:
    """Claim one Meta campaign for this request: ONE transaction.

    Locks (PLAN.md §7.8 order, then the claim): the request row, the campaign's claim
    (meta_collisions.claim_campaign: exactly one of two links racing for a campaign wins), then
    ``before_write`` (the Meta rename, if any, so a Meta call runs while these locks are held; a
    failure rolls everything back), the removal of Manager's untouched copies
    (meta_collisions.remove_untouched_copies, which takes the import's lock), and the request's
    write. On SQLite the Meta import's process lock and the entity-patch lock are taken first.
    Returns (entity, copies); copies is None when an identical request (same operationId) or a
    link to the same campaign committed first: nothing was written. With ``complete_marker`` a
    request the classic marker tied to this same campaign (no ``linkedAt``) is linked for real.
    """
    patch_guard = nullcontext() if ctx["is_postgres"]() else ctx["sqlite_patch_lock"]()
    with _collisions.claim_guard(), patch_guard:
        with db_conn() as conn:
            row = _lock_campaign_row(conn, ctx, campaign_id)
            if not row:
                raise HTTPException(status_code=404, detail="Campaign request not found")
            entity = ctx["entity_from_db_row"](row)
            data = dict(entity.get("data") or {})
            linked = str(data.get("metaCampaignId") or "").strip()
            if str(data.get("lastPublishOperationId") or "") == operation_id:
                return entity, None
            if linked == meta_campaign_id and (data.get("linkedAt") or not complete_marker):
                return entity, None
            if str(data.get("status") or "Draft") != "Approved":
                raise HTTPException(status_code=409, detail=not_approved)
            if int(entity.get("lastModified") or 0) != int(baseline):
                raise HTTPException(status_code=409, detail="Conflict: record has changed")
            if linked and linked != meta_campaign_id:
                raise HTTPException(status_code=409, detail=REFUSE_LINK_RELINK)
            try:
                _collisions.claim_campaign(conn, meta_campaign_id, campaign_id)
            except _collisions.CampaignClaimedError:
                raise HTTPException(status_code=409, detail=REFUSE_LINK_TAKEN)
            if before_write is not None:
                before_write()
            copies = _collisions.remove_untouched_copies(conn, meta_campaign_id, actor_id or None, request_id=campaign_id)
            modified = max(now_ms(), int(baseline) + 1)
            data.update(fields_for(copies))
            data["_lastModified"] = modified
            result = conn.execute(
                text(
                    "UPDATE entities SET data_json = :d, last_modified = :m "
                    "WHERE type = :t AND id = :id AND deleted = false AND last_modified = :baseline"
                ),
                {"d": json_dumps(data), "m": modified, "t": AD_CAMPAIGN_COLLECTION, "id": campaign_id, "baseline": int(baseline)},
            )
            if int(result.rowcount or 0) != 1:
                raise HTTPException(status_code=409, detail="Conflict: record has changed")  # rolls the removal back too
            return {**entity, "data": data, "lastModified": modified}, copies


def _link_meta_campaign(
    ctx: dict[str, Any],
    user: dict[str, Any],
    campaign_id: str,
    operation_id: str,
    baseline: int,
    body: AdCampaignPublishStatusBody,
) -> dict[str, Any]:
    """The LINK step (owner decision D26; P1-09, P3-02, P0-09b). Staff made the ad in Meta with any
    name; this links the Approved request to that Meta campaign and claims it.

    Checks, in order: the ids; the request (404 for a private draft); an operationId replay (the
    first result again); Approved; the version; not linked elsewhere; Meta configured and the account
    on the allowlist; the campaign not claimed by another request (409); ONE Meta read (the campaign
    exists and is in that account; its budget -> warning ``meta_budget_above_paid`` above what the
    customer paid). Then the name: it already carries this request's studio code -> link; it carries
    ANOTHER request's code -> 409; the stored token reading (never a debug_token call) shows
    ``ads_management`` -> rename it in Meta to the request's studio name inside the link's
    transaction, then link; otherwise -> 409 NEEDS_MANUAL_RENAME with the studio name (staff rename
    it by hand and link again). A rename Meta refuses (not a busy answer) falls back to the same 409.

    The link writes publishStatus ``meta_review`` (a legacy request already marked ``live`` or
    ``paused`` keeps its marker), ``metaCampaignId`` (unique), ``metaAdAccountId`` (``act_<id>``),
    ``metaCampaignName``, ``linkedAt``/``linkedBy``, the studio code and name, and ``metaLinkResult``
    (with what the UNLINK undoes: ``previousMetaName``, the name read before any rename, and
    ``collisionRepairId``); Manager's untouched copies of the campaign are removed in the same
    transaction. Audited ``publish_status`` (with ``renamed`` and ``previousMetaName``). The answer is
    the request plus {renamed, removedManagerCopies, keptManagerCopies, warnings, studioRef, studioName}.
    """
    account = _clean_meta_number(body.metaAdAccountId, REFUSE_LINK_BAD_ACCOUNT_ID)
    meta_id = _clean_meta_number(body.metaCampaignId, REFUSE_LINK_BAD_CAMPAIGN_ID)
    if body.publishStatus not in (None, "meta_review"):
        raise HTTPException(status_code=400, detail="A link sets publishStatus meta_review; leave publishStatus out")
    campaign = ctx["get_entity"](AD_CAMPAIGN_COLLECTION, campaign_id)
    if not campaign or campaign.get("deleted"):
        raise HTTPException(status_code=404, detail="Campaign request not found")
    data = campaign.get("data") or {}
    creator = str(campaign.get("createdBy") or data.get("createdBy") or "")
    actor_id = str(user.get("id") or "system")
    if actor_id != creator and str(data.get("status") or "Draft") not in REVIEWER_VISIBLE_STATUSES:
        raise HTTPException(status_code=404, detail="Campaign request not found")  # never confirm a private draft

    def answer(entity: dict[str, Any]) -> dict[str, Any]:
        return {**ctx["project_entity_media_for_user"](entity, user, False), **_link_view(entity.get("data") or {})}

    if str(data.get("lastPublishOperationId") or "") == operation_id:
        if str(data.get("metaCampaignId") or "") != meta_id or _account_digits(data.get("metaAdAccountId")) != account:
            raise HTTPException(status_code=409, detail="operationId was already used for another update")
        return answer(campaign)  # the first response was lost after commit: the same result again
    ctx["enforce_ad_campaign_rate"](user)
    _enforce_link_rate(user)
    if str(data.get("status") or "Draft") != "Approved":
        raise HTTPException(status_code=409, detail=REFUSE_LINK_NOT_APPROVED)
    if int(campaign.get("lastModified") or 0) != baseline:
        raise HTTPException(status_code=409, detail="Conflict: record has changed")
    linked = str(data.get("metaCampaignId") or "").strip()
    if linked == meta_id and data.get("linkedAt"):
        return answer(campaign)  # already linked to this campaign (a second press): nothing to change
    if linked and linked != meta_id:
        raise HTTPException(status_code=409, detail=REFUSE_LINK_RELINK)
    config = _meta.load_meta_ads_config()
    if not config.configured:
        raise HTTPException(status_code=503, detail=REFUSE_LINK_NOT_CONFIGURED)
    if account not in set(config.allowed_account_ids):
        raise HTTPException(status_code=400, detail=REFUSE_LINK_ACCOUNT)  # empty allowlist: fail closed
    with db_conn() as conn:
        if [rid for rid in _collisions.campaign_claimed_by(conn, meta_id) if rid != campaign_id]:
            raise HTTPException(status_code=409, detail=REFUSE_LINK_TAKEN)
        ref = assign_studio_ref(conn, campaign_id, data)
    stored_name = str(data.get("studioName") or "")  # the approval's name; built now for older approvals
    name = stored_name if stored_name.startswith(ref) else studio_campaign_name(ref, data.get("name"))
    try:
        meta = _meta.read_studio_campaign(meta_id)
    except _meta.MetaAdsError as error:
        _check_meta_connection(error)
        raise _meta_link_error(error)
    if str(meta.get("accountId") or "") != account:
        raise HTTPException(status_code=400, detail=REFUSE_LINK_WRONG_ACCOUNT)
    warnings, budget = _link_warnings(data, meta)
    meta_name = str(meta.get("name") or "")
    rename = not _name_carries(meta_name, ref)
    if rename:
        if _meta.is_studio_campaign_name(meta_name):
            raise HTTPException(status_code=409, detail=REFUSE_LINK_OTHER_CODE)
        if not _meta.studio_token_can_manage_ads(account):
            raise _needs_manual_rename(ref, name)

    def rename_in_meta() -> None:
        try:
            _meta.rename_studio_campaign(meta_id, name)
        except _meta.MetaAdsError as error:
            _check_meta_connection(error)
            if error.retryable or error.code == "not_configured":
                raise _meta_link_error(error)
            raise _needs_manual_rename(ref, name)  # Meta refused the rename: staff rename it by hand

    linked_at = ctx["iso_utc"]()
    # A legacy request staff already marked launched keeps its marker (the version check makes this
    # the same row _claim_and_write locks).
    marker = str(data.get("publishStatus") or "")
    publish_status = marker if marker in LAUNCHED_MARKERS else "meta_review"

    def link_fields(copies: dict[str, Any]) -> dict[str, Any]:
        return {
            "publishStatus": publish_status,
            "metaCampaignId": meta_id,
            "metaAdAccountId": f"act_{account}",
            "metaCampaignName": name if rename else meta_name,
            "linkedAt": linked_at,
            "linkedBy": actor_id,
            "publishedAt": linked_at,
            "publishedBy": actor_id,
            "lastPublishOperationId": operation_id,
            "studioRef": ref,
            "studioName": name,
            "metaLinkResult": {
                "renamed": rename,
                "removedManagerCopies": len(copies.get("removed") or []),
                "keptManagerCopies": len(copies.get("kept") or []),
                "warnings": warnings,
                "metaBudgetMinor": budget,
                "metaCurrency": str(meta.get("currency") or "")[:12],
                # What the UNLINK undoes: this campaign's name before any rename, and the removal.
                "metaCampaignId": meta_id,
                "previousMetaName": meta_name,
                "collisionRepairId": str(copies.get("repairId") or ""),
            },
        }

    saved, copies = _claim_and_write(
        ctx, campaign_id, operation_id=operation_id, baseline=baseline, meta_campaign_id=meta_id,
        actor_id=actor_id, fields_for=link_fields, not_approved=REFUSE_LINK_NOT_APPROVED,
        before_write=rename_in_meta if rename else None, complete_marker=True,
    )
    if copies is not None:
        view = _link_view(saved.get("data") or {})
        ctx["audit"](
            actor_id,
            "publish_status",
            AD_CAMPAIGN_COLLECTION,
            campaign_id,
            f"Linked campaign {campaign_id} to Meta campaign {meta_id}" + (" and renamed it in Meta" if rename else ""),
            {"operationId": operation_id, "publishStatus": publish_status, "metaCampaignId": meta_id,
             "metaAdAccountId": f"act_{account}", "studioRef": ref, "renamed": rename, "previousMetaName": meta_name,
             "removedManagerCopies": view["removedManagerCopies"], "keptManagerCopies": view["keptManagerCopies"],
             "collisionRepairId": str(copies.get("repairId") or ""), "warnings": warnings, "metaBudgetMinor": budget},
        )
        _tell_owner(creator, "request_live", campaign_id, "live", studioRef=ref)
    return answer(saved)


# ---------------------------------------------------------------- the UNLINK step (staff)


def _unlink_reason(ctx: dict[str, Any], raw: Any) -> str:
    low, high = UNLINK_REASON_CHARS
    reason = " ".join(ctx["sanitize_str"](raw, 4 * high).split()) if isinstance(raw, str) else ""
    if not low <= len(reason) <= high:
        raise HTTPException(status_code=400, detail=REFUSE_UNLINK_REASON)
    return reason


def _unlink_view(data: dict[str, Any]) -> dict[str, Any]:
    """What an unlink answers next to the request, from the result it stored (a replay answers the same)."""
    stored = data.get("metaUnlinkResult") if isinstance(data.get("metaUnlinkResult"), dict) else {}
    return {
        "unlinkedMetaCampaignId": str(stored.get("metaCampaignId") or ""),
        "previousMetaName": str(stored.get("previousMetaName") or ""),
        "restoredCopies": _whole(stored.get("restoredCopies")),
        "restoreProblem": str(stored.get("restoreProblem") or ""),
        "renamedBack": stored.get("renamedBack") is True,
        "renameBack": str(stored.get("renameBack") or ""),
    }


def _rename_back(meta_id: str, account: str, ref: str, previous: str) -> str:
    """Best effort, after the unlink committed: the Meta campaign gets back ``previous``, the name the
    link read before it renamed it. Only while the stored token reading shows ``ads_management`` for
    the account, no request claimed the campaign again and Meta's name still carries this request's
    studio code (a name staff changed since is left alone). The client's rename_campaign sends studio
    names only, so this goes through the same paced system-token lane (MetaAdsClient._post, as Social
    Studio's replies do). Returns done, no_permission, linked_again, name_changed or failed; never raises.
    """
    try:
        if not _meta.studio_token_can_manage_ads(account):
            return "no_permission"
        with db_conn() as conn:
            if _collisions.campaign_claimed_by(conn, meta_id):
                return "linked_again"
        if not _name_carries(_meta.read_studio_campaign(meta_id).get("name"), ref):
            return "name_changed"
        answer = _meta.get_meta_ads_client()._post(meta_id, {"name": previous})
    except Exception:  # Meta busy or refusing, Albayan's Meta pause, a lost connection: the unlink stands
        return "failed"
    return "done" if isinstance(answer, dict) and answer.get("success") is True else "failed"


def _write_campaign(conn: Any, campaign_id: str, data: dict[str, Any], baseline: int) -> int:
    """Version-checked write of the request's data; the new lastModified, or 0 when the row changed."""
    modified = max(now_ms(), int(baseline) + 1)
    result = conn.execute(
        text(
            "UPDATE entities SET data_json = :d, last_modified = :m "
            "WHERE type = :t AND id = :id AND deleted = false AND last_modified = :baseline"
        ),
        {"d": json_dumps({**data, "_lastModified": modified}), "m": modified, "t": AD_CAMPAIGN_COLLECTION,
         "id": campaign_id, "baseline": int(baseline)},
    )
    return modified if int(result.rowcount or 0) == 1 else 0


def _unlink_meta_campaign(
    ctx: dict[str, Any], user: dict[str, Any], campaign_id: str, operation_id: str, body: AdCampaignUnlinkBody
) -> dict[str, Any]:
    """The UNLINK step (staff): undo a link made by mistake, so the Meta campaign is Manager's again.

    Checks: the reason (3-300 characters); the request (404 for a private draft); an operationId replay
    (the first result again); Approved (not Stopped or finished); the version; linked. Then ONE
    transaction under the link's own locks (_claim_and_write: the import's process lock on SQLite, the
    request row, the campaign's claim): publishStatus '', metaCampaignId, metaAdAccountId,
    metaCampaignName, linkedAt/linkedBy and publishedAt/publishedBy cleared (the claim is released),
    and the Manager copies that link removed restored (meta_collisions.reverse_link_removal with the
    stored collisionRepairId; a closed month refuses the whole unlink with the closed-month 423). A
    restore the reversal refuses otherwise (a copy changed or is gone) is flagged in
    ``restoreProblem``, never a refusal. The result is kept in ``metaUnlinkResult``.

    After commit, when the link renamed the campaign, _rename_back gives it its previous Meta name
    (best effort; ``renamedBack``). Audited ``publish_status`` with {unlink: true, reason,
    previousMetaName, restoredCopies, renamedBack}. The answer is the request plus _unlink_view.
    Discovery keeps every Meta ad id it saw (knownMetaAdIds holds no reason), so ads it skipped while
    the campaign was claimed come back through Manager's "import existing ads" pass or by hand.
    """
    reason = _unlink_reason(ctx, body.reason)
    actor_id = str(user.get("id") or "system")

    def answer(entity: dict[str, Any]) -> dict[str, Any]:
        return {**ctx["project_entity_media_for_user"](entity, user, False), **_unlink_view(entity.get("data") or {})}

    patch_guard = nullcontext() if ctx["is_postgres"]() else ctx["sqlite_patch_lock"]()
    with _collisions.claim_guard(), patch_guard:
        with db_conn() as conn:
            row = _lock_campaign_row(conn, ctx, campaign_id)
            if not row:
                raise HTTPException(status_code=404, detail="Campaign request not found")
            entity = ctx["entity_from_db_row"](row)
            data = dict(entity.get("data") or {})
            status = str(data.get("status") or "Draft")
            if actor_id != str(entity.get("createdBy") or data.get("createdBy") or "") and status not in REVIEWER_VISIBLE_STATUSES:
                raise HTTPException(status_code=404, detail="Campaign request not found")  # never confirm a private draft
            if str(data.get("lastUnlinkOperationId") or "") == operation_id:
                return answer(entity)  # the first response was lost after commit: the same result again
            ctx["enforce_ad_campaign_rate"](user)
            if status != "Approved":
                raise HTTPException(status_code=409, detail=REFUSE_UNLINK_NOT_APPROVED)
            baseline = int(entity.get("lastModified") or 0)
            if baseline != int(body.expectedLastModified):
                raise HTTPException(status_code=409, detail="Conflict: record has changed")
            meta_id = str(data.get("metaCampaignId") or "").strip()
            if not meta_id:
                raise HTTPException(status_code=409, detail=REFUSE_UNLINK_NOT_LINKED)
            try:
                _collisions.claim_campaign(conn, meta_id, campaign_id)  # the claim's lock, to the end of this transaction
            except _collisions.CampaignClaimedError:
                pass  # another request's claim is not this unlink's to release
            stored = data.get("metaLinkResult") if isinstance(data.get("metaLinkResult"), dict) else {}
            link = stored if str(stored.get("metaCampaignId") or "") == meta_id else {}  # this campaign's link only
            repair_id = str(link.get("collisionRepairId") or "")
            restored: list[str] = []
            problem = ""
            try:
                restored = _collisions.reverse_link_removal(conn, repair_id, actor_id or None)
            except _collisions.CollisionRepairError as error:
                problem = str(error)[:500]  # flagged, not refused: the claim is still released
            previous = str(link.get("previousMetaName") or "")
            rename_back = link.get("renamed") is True and bool(previous) and not _meta.is_studio_campaign_name(previous)
            account = _account_digits(data.get("metaAdAccountId"))
            result = {
                "metaCampaignId": meta_id, "metaAdAccountId": str(data.get("metaAdAccountId") or ""),
                "previousMetaName": previous, "collisionRepairId": repair_id, "restoredCopies": len(restored),
                "restoreProblem": problem, "renamedBack": False, "renameBack": "pending" if rename_back else "",
            }
            data.update({
                "publishStatus": "", "metaCampaignId": "", "metaAdAccountId": "", "metaCampaignName": "",
                "linkedAt": None, "linkedBy": None, "publishedAt": None, "publishedBy": None, "metaLinkResult": None,
                "unlinkedAt": ctx["iso_utc"](), "unlinkedBy": actor_id, "lastUnlinkOperationId": operation_id,
                "metaUnlinkResult": result,
            })
            modified = _write_campaign(conn, campaign_id, data, baseline)
            if not modified:
                raise HTTPException(status_code=409, detail="Conflict: record has changed")  # rolls the restore back too
    entity = {**entity, "data": {**data, "_lastModified": modified}, "lastModified": modified}
    if rename_back:
        outcome = _rename_back(meta_id, account, str(data.get("studioRef") or ""), previous)
        result = {**result, "renamedBack": outcome == "done", "renameBack": outcome}
        later_data = {**data, "metaUnlinkResult": result}
        with (nullcontext() if ctx["is_postgres"]() else ctx["sqlite_patch_lock"]()), db_conn() as conn:
            later = _write_campaign(conn, campaign_id, later_data, modified)
        if later:  # else the request changed meanwhile: the answer still says what happened in Meta
            entity = {**entity, "data": {**later_data, "_lastModified": later}, "lastModified": later}
    ctx["audit"](
        actor_id,
        "publish_status",
        AD_CAMPAIGN_COLLECTION,
        campaign_id,
        f"Unlinked campaign {campaign_id} from Meta campaign {meta_id}",
        {"unlink": True, "operationId": operation_id, "reason": reason, "metaCampaignId": meta_id,
         "metaAdAccountId": result["metaAdAccountId"], "previousMetaName": previous, "restoredCopies": len(restored),
         "collisionRepairId": repair_id, "restoreProblem": problem, "renamedBack": result["renamedBack"],
         "renameBack": result["renameBack"]},
    )
    return {**answer(entity), **_unlink_view({"metaUnlinkResult": result})}


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
        studio_fields: dict[str, str] = {}
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
            # P1-09 (D26): the request's unique studio code and its Meta campaign name, read before
            # the capture so a failure here never leaves one behind.
            studio_fields = _studio_fields(campaign_id, current)
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
                # A stale page (the request changed since the reviewer loaded it, e.g. withdrawn and sent
                # again) never captures: its status write would lose after the capture, and a capture of
                # the cycle the request still waits in is kept (P1-03b), holding the budget twice.
                live_modified = conn.execute(
                    text("SELECT last_modified FROM entities WHERE type = :type AND id = :id AND deleted = false LIMIT 1"),
                    {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
                ).scalar()
                if live_modified is None or int(live_modified) != int(body.expectedLastModified):
                    raise HTTPException(status_code=409, detail="Conflict: record has changed")
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
                    **studio_fields,
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
                 "heldMinorUSD": held_minor, "legacyRules": legacy,
                 **({"studioRef": studio_fields["studioRef"]} if studio_fields else {})},
            )
        _tell_owner(campaign_owner, _REVIEW_ACTIVITY[decision], campaign_id,
                    str((saved.get("data") or {}).get("reviewedAt") or reviewed_at), reasonCode=reason_code,
                    amountMinor=held_minor if decision == "Approved" else None)
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

    def _stop_or_settle(
        campaign_id: str,
        body: AdCampaignStopBody,
        user: dict[str, Any],
        *,
        override_reason: str = "",
    ) -> dict[str, Any]:
        """The one locked transaction of /stop and /settle-override: the refund ledger row and the
        Stopped status write commit or roll back together. Staff settle through settle_plan (the
        P3-06a gates, lifted by ``override_reason`` for an admin, P3-06d); the owner's own stop
        keeps the customer rules (see the module docstring)."""
        from .studio_results import load_results_row  # late: studio_results imports this module

        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        close_reason = str(body.closeReason or "")
        actor_id = str(user.get("id") or "system")
        # The settlement rules are read before the transaction (like the stop request's settings).
        settlement = _studio_setting("settlement") if _is_reviewer(ctx, user) else None
        now = utc_now()
        postgres = ctx["is_postgres"]()
        patch_guard = nullcontext() if postgres else ctx["sqlite_patch_lock"]()
        wallet_guard = nullcontext() if postgres else ctx["sqlite_wallet_lock"]()
        refund = 0
        plan: dict[str, Any] | None = None
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
                if staff:
                    # P3-06a: the settle gates and the cap (settle_plan); the results row is read on this
                    # transaction, never locked (PLAN.md §7.8 lock table, "Stop / settle").
                    results, _results_modified = load_results_row(conn, campaign_id)
                    plan = settle_plan(data, results, captured, body.refundMinorUSD, now, settlement,
                                       override_reason=override_reason)
                    refund = plan["refund"]
                    # Staff may record a customer's ask-to-stop as customer_stop;
                    # a finished ad closes as completed (stage 11, PLAN §5.4).
                    close_reason = close_reason or "staff_stop"
                    if plan["absorbedMinorUSD"] > 0:  # D27: Albayan absorbs; the alert rides this transaction
                        _raise_overspend_alert(conn, campaign_id, creator, plan, captured, now)
                else:
                    if override_reason:
                        # Nobody chooses their own refund, an admin included (the staff rule above).
                        raise HTTPException(status_code=403, detail=REFUSE_OVERRIDE_OWN)
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
                    spent = min(max(int(data.get("spendMinorUSD") or 0), 0), max(captured, 0))
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
                before = {key: data.get(key) for key in _SETTLE_AUDIT_FIELDS}
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
                if plan is not None:  # P3-06a: what the settle was based on (studio_results, studio_results_sync read these)
                    meta_spend = plan["metaSpendMinorUSD"]
                    data.update({
                        "settleBasis": plan["settleBasis"],
                        "metaSpendAtSettleMinorUSD": meta_spend,
                        "settledSpendMinorUSD": meta_spend if meta_spend is not None else max(captured - refund, 0),
                        "settledAt": stopped_at,
                        "settleOverrideReason": override_reason,
                    })
                    if override_reason:  # P3-06d: audited on the same transaction, kept forever
                        ctx["audit"](
                            actor_id, AUDIT_SETTLE_OVERRIDE, AD_CAMPAIGN_COLLECTION, campaign_id,
                            f"Admin override settled campaign request {campaign_id}: refunded {refund} (cap {plan['capMinorUSD']})",
                            {"operationId": operation_id, "reason": override_reason, "refundMinorUSD": refund,
                             "capMinorUSD": plan["capMinorUSD"], "paidMinorUSD": captured,
                             "metaSpendAtSettleMinorUSD": meta_spend, "absorbedMinorUSD": plan["absorbedMinorUSD"],
                             "before": before, "after": {key: data.get(key) for key in _SETTLE_AUDIT_FIELDS}},
                            conn=conn,
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
        if actor_id != creator:
            _tell_owner(creator, "settled", campaign_id, "settled", refundMinor=refund)
        from .studio_stop import on_campaign_stopped  # late: studio_stop imports this module (P3-10)

        on_campaign_stopped(campaign_id)  # its stop request (if any) is handled now
        return ctx["project_entity_media_for_user"](entity, user, False)

    @router.post("/{campaign_id}/stop")
    def stop_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignStopBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Stop an Approved campaign; refund the unspent budget atomically (staff: the settle gates, P3-06a)."""
        require_same_origin(request)
        return _stop_or_settle(campaign_id, body, user)

    @router.post("/{campaign_id}/settle-override")
    def settle_override_ad_campaign_request(
        campaign_id: str,
        body: AdCampaignSettleOverrideBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """P3-06d: an admin settles past the gates and above the cap with a written reason (audited
        ``settle_override``, kept forever; D27: Albayan absorbs what comes back above the cap).
        Admin only (a reviewer gets 403); the refund is required and never above the payment."""
        require_same_origin(request)
        if str(user.get("role") or "").lower() != "admin":
            raise HTTPException(status_code=403, detail=REFUSE_OVERRIDE_ADMIN)
        reason = ctx["sanitize_str"](body.reason).strip() if isinstance(body.reason, str) else ""
        if not OVERRIDE_REASON_CHARS[0] <= len(reason) <= OVERRIDE_REASON_CHARS[1]:
            raise HTTPException(status_code=400, detail=REFUSE_OVERRIDE_REASON)
        refund = body.refundMinorUSD
        if isinstance(refund, bool) or not isinstance(refund, int) or refund < 0:
            raise HTTPException(status_code=400, detail=REFUSE_OVERRIDE_REFUND)
        stop_body = AdCampaignStopBody(
            expectedLastModified=body.expectedLastModified, operationId=body.operationId, reason=None,
            refundMinorUSD=refund, closeReason=body.closeReason or "staff_stop",
        )
        return _stop_or_settle(campaign_id, stop_body, user, override_reason=reason)

    @router.post("/{campaign_id}/publish-status")
    def set_ad_campaign_publish_status(
        campaign_id: str,
        body: AdCampaignPublishStatusBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Staff only. With ``metaAdAccountId`` + ``metaCampaignId``: the LINK step (P1-09, P3-02,
        P0-09b; see _link_meta_campaign).

        Otherwise the marker that the Approved ad was launched/paused on Meta by hand (live /
        paused / '' = cleared, which clears the link too). A marker that brings a NEW Meta campaign
        id claims it like a link (unique among requests; Manager's untouched copies removed) but
        checks nothing in Meta, so the team desk links instead; a request already linked to another
        campaign is refused.
        """
        require_same_origin(request)
        if not _is_reviewer(ctx, user):
            raise HTTPException(status_code=403, detail="Forbidden")
        campaign_id = ctx["validate_entity_id"](campaign_id)
        operation_id = _clean_operation_id(ctx, body.operationId)
        expected = _expected_version(body)
        if str(body.metaAdAccountId or "").strip():
            return _link_meta_campaign(ctx, user, campaign_id, operation_id, expected, body)
        if body.publishStatus is None:
            raise HTTPException(
                status_code=400,
                detail="publishStatus is required (or metaAdAccountId and metaCampaignId to link a Meta campaign)",
            )
        if body.publishStatus == "meta_review":
            raise HTTPException(
                status_code=400,
                detail="meta_review is set by linking a Meta campaign (metaAdAccountId and metaCampaignId)",
            )
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
        if fields.get("metaCampaignId") == "":
            # No Meta campaign any more: the link's own fields go with it (its result stays as history).
            fields.update({"metaAdAccountId": "", "metaCampaignName": "", "linkedAt": None, "linkedBy": None})
        linked = str(data.get("metaCampaignId") or "").strip()
        new_meta = str(fields.get("metaCampaignId") or "")
        if new_meta and new_meta != linked:
            if linked:
                raise HTTPException(status_code=409, detail=REFUSE_LINK_RELINK)
            saved, copies = _claim_and_write(
                ctx, campaign_id, operation_id=operation_id, baseline=expected, meta_campaign_id=new_meta,
                actor_id=actor_id, fields_for=lambda _copies: fields,
                not_approved="Only Approved campaigns can be marked launched",
            )
            if copies is not None:
                ctx["audit"](
                    actor_id,
                    "publish_status",
                    AD_CAMPAIGN_COLLECTION,
                    campaign_id,
                    f"Marked campaign {campaign_id} publish status: {value}",
                    {"operationId": operation_id, "publishStatus": value, "metaCampaignId": new_meta,
                     "removedManagerCopies": len(copies.get("removed") or []),
                     "keptManagerCopies": len(copies.get("kept") or []),
                     "collisionRepairId": str(copies.get("repairId") or "")},
                )
                if value == "live":
                    _tell_owner(creator, "request_live", campaign_id, "live")
            return ctx["project_entity_media_for_user"](saved, user, False)
        try:
            saved = ctx["patch_entity"](
                AD_CAMPAIGN_COLLECTION,
                campaign_id,
                fields,
                actor_id,
                expected_last_modified=expected,
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
        if value == "live":
            _tell_owner(creator, "request_live", campaign_id, "live")
        return ctx["project_entity_media_for_user"](saved, user, False)

    @router.post("/{campaign_id}/unlink-meta")
    def unlink_ad_campaign_meta(
        campaign_id: str,
        body: AdCampaignUnlinkBody,
        request: Request,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Staff only: undo the LINK of an Approved request (see _unlink_meta_campaign)."""
        require_same_origin(request)
        if not _is_reviewer(ctx, user):
            raise HTTPException(status_code=403, detail="Forbidden")
        campaign_id = ctx["validate_entity_id"](campaign_id)
        return _unlink_meta_campaign(ctx, user, campaign_id, _clean_operation_id(ctx, body.operationId), body)

    from .studio_stop import add_stop_request_route  # late: studio_stop imports this module

    # POST /{campaign_id}/stop-request: the owner's urgent "ask to stop" (P3-10, studio_stop.py)
    add_stop_request_route(router, current_user_dependency=current_user_dependency,
                           require_same_origin=require_same_origin, ctx=ctx)
    return router
