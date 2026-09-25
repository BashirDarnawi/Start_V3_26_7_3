"""Studio diagnostics: counts and baselines only (plan tasks P0-05a, P0-05b; PLAN.md §4.1).

Nothing here returns a name, email, phone, id or message text: only counts, medians and shares.
The baselines describe the classic studio before the pilot, from the timestamps the classic
workflow already writes on ``adCampaignRequests`` (main.py submit/review routes).

Customers archive requests (DELETE -> main._soft_delete_ad_campaign_atomic keeps every
timestamp and ``reviewHistory``), and an archived request still happened. So the history
baselines B1, B2, B5 and B6 read ALL rows, archived included; the "now" numbers (``byStatus``,
``campaigns.total``, holds, B3, B4) read only live rows; ``campaigns.archived`` counts the rest.

* **B1** median hours from submit (``submittedAt``) to the decision (``reviewedAt``). A resubmit
  clears ``reviewedAt`` and overwrites ``submittedAt``, so each request counts its latest cycle.
* **B2** share (%) of review decisions that sent the request back ("Changes Requested"), over
  every decision in ``reviewHistory``.
* **B3** number of holds (Submitted requests with a budget, whose money is held) submitted more
  than 14 days ago.
* **B4** number of Approved requests more than 7 days past their ``endDate`` (Libya calendar)
  and never settled (a settled request is ``Stopped``).
* **B5** median hours from creating the draft (the row's ``created_at``) to its FIRST submit;
  a request that was already reviewed before its latest submit is left out (its first submit
  time is not stored).
* **B6** median hours from a customer's account creation (``users.created_at``, read through
  the platform door server/user_directory.py) to their first approval (earliest ``approvedAt``).

A median or share with no usable rows is ``None`` (null in JSON), never a crash or a fake 0.
Counts (B3, B4) are real zeros when nothing matches; ``sample`` says how many rows could be judged.
Only the few fields above are read (never the creative images), each row's JSON parsed once
(db.json_fields_select_sql: on PostgreSQL one jsonb cast per row, not one per field).

**Top-up presets** (P0-05b, D25): the 5 most common confirmed USD wallet top-up amounts with
their counts, from Albayan's own payment history (wallet_payments.confirmed_top_up_amounts):
amounts and counts only, no ids, names or users.
"""

import statistics
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from ... import meta_ads as _meta
from ...db import db_conn, json_fields_select_sql, json_loads_or_raw
from ...user_directory import account_created_at
from ...wallet_payments import confirmed_top_up_amounts
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION

CAMPAIGN_STATUSES = ("Draft", "Submitted", "Changes Requested", "Approved", "Rejected", "Stopped")
REVIEW_DECISIONS = ("Approved", "Changes Requested", "Rejected")
HOLD_AGE_DAYS = 14
UNSETTLED_GRACE_DAYS = 7
TOP_UP_PRESETS = 5
TOP_UP_CURRENCY = "USD"
_FIELDS = ("status", "submittedAt", "reviewedAt", "approvedAt", "endDate", "budgetMinorUSD", "reviewHistory")


def parse_time(value: Any) -> datetime | None:
    """An ISO time as written by main._iso_utc ('...Z'); a time without a zone counts as UTC."""
    raw = str(value or "").strip()
    if not raw or len(raw) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_day(value: Any) -> date | None:
    try:
        return datetime.strptime(str(value or "").strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _from_ms(value: Any) -> datetime | None:
    try:
        stamp = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if stamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(stamp / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _minor(value: Any) -> int:
    try:
        return max(int(float(value or 0)), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _hours(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 3600


def libya_today(now: datetime) -> date:
    try:
        from zoneinfo import ZoneInfo

        return now.astimezone(ZoneInfo("Africa/Tripoli")).date()
    except Exception:
        return now.astimezone(timezone.utc).date()


def campaign_rows_sql(dialect: str | None = None) -> str:
    """Every request row, archived ones included (the ``deleted`` column says which)."""
    return json_fields_select_sql(_FIELDS, ("created_at", "created_by", "deleted"), "type = :type", dialect)


def load_campaign_rows(conn: Any) -> list[dict[str, Any]]:
    """The fields the baselines need, projected in SQL (no creative images are read)."""
    rows = conn.execute(text(campaign_rows_sql()), {"type": AD_CAMPAIGN_COLLECTION}).mappings().all()
    out = []
    for row in rows:
        item = {field: row.get(f"f_{field.lower()}") for field in _FIELDS}
        item["reviewHistory"] = json_loads_or_raw(item.get("reviewHistory"))
        item["createdAtMs"] = row.get("created_at")
        item["ownerId"] = str(row.get("created_by") or "")
        item["archived"] = bool(row.get("deleted"))
        out.append(item)
    return out


def _median_hours(values: list[float]) -> dict[str, Any] | None:
    if not values:
        return None
    return {"value": round(statistics.median(values), 2), "unit": "hours", "sample": len(values)}


def compute_diagnostics(
    rows: list[dict[str, Any]],
    account_created: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Counts by status, holds and B1-B6 from rows shaped like ``load_campaign_rows``.

    A row with ``archived`` true counts only in the history baselines (B1, B2, B5, B6).
    """
    now = now or datetime.now(timezone.utc)
    today = libya_today(now)
    by_status = {status: 0 for status in CAMPAIGN_STATUSES}
    by_status["other"] = 0
    live = archived = 0
    holds = 0
    b1: list[float] = []
    decisions = 0
    sent_back = 0
    b3_count = b3_sample = 0
    b4_count = b4_sample = 0
    b5: list[float] = []
    first_approval: dict[str, datetime] = {}

    for row in rows:
        status = str(row.get("status") or "Draft")
        is_live = not row.get("archived")
        if is_live:
            live += 1
            by_status[status if status in by_status else "other"] += 1
        else:
            archived += 1
        submitted = parse_time(row.get("submittedAt"))
        reviewed = parse_time(row.get("reviewedAt"))
        history = row.get("reviewHistory") if isinstance(row.get("reviewHistory"), list) else []
        review_times = []
        for entry in history:
            if not isinstance(entry, dict) or entry.get("decision") not in REVIEW_DECISIONS:
                continue
            decisions += 1
            sent_back += entry.get("decision") == "Changes Requested"
            review_times.append(parse_time(entry.get("reviewedAt")))

        if status != "Submitted" and submitted and reviewed and reviewed >= submitted:
            b1.append(_hours(reviewed, submitted))

        if is_live and status == "Submitted" and _minor(row.get("budgetMinorUSD")) > 0:
            holds += 1
            if submitted:
                b3_sample += 1
                b3_count += now - submitted > timedelta(days=HOLD_AGE_DAYS)

        if is_live and status == "Approved":
            end = parse_day(row.get("endDate"))
            if end:
                b4_sample += 1
                b4_count += today > end + timedelta(days=UNSETTLED_GRACE_DAYS)

        created = _from_ms(row.get("createdAtMs"))
        # The latest submit is the first one only when no review happened before it.
        if submitted and created and submitted >= created and not any(t is None or t < submitted for t in review_times):
            b5.append(_hours(submitted, created))

        approved = parse_time(row.get("approvedAt"))
        owner = str(row.get("ownerId") or "")
        if approved and owner and (owner not in first_approval or approved < first_approval[owner]):
            first_approval[owner] = approved

    b6 = []
    for owner, approved in first_approval.items():
        joined = _from_ms(account_created.get(owner))
        if joined and approved >= joined:
            b6.append(_hours(approved, joined))

    return {
        "campaigns": {"total": live, "archived": archived, "byStatus": by_status},
        "holds": {"count": holds},
        "baselines": {
            "B1": _median_hours(b1),
            "B2": (
                {"value": round(100 * sent_back / decisions, 1), "unit": "percent", "sample": decisions}
                if decisions else None
            ),
            "B3": {"value": b3_count, "unit": "count", "sample": b3_sample},
            "B4": {"value": b4_count, "unit": "count", "sample": b4_sample},
            "B5": _median_hours(b5),
            "B6": _median_hours(b6),
        },
    }


def read_diagnostics(now: datetime | None = None) -> dict[str, Any]:
    with db_conn() as conn:
        rows = load_campaign_rows(conn)
        created = account_created_at(conn, (r["ownerId"] for r in rows if r.get("approvedAt")))
        top_ups = confirmed_top_up_amounts(conn, TOP_UP_CURRENCY, TOP_UP_PRESETS)
    report = compute_diagnostics(rows, created, now)
    report["topUpPresets"] = {"currency": TOP_UP_CURRENCY, **top_ups}
    report["metaLanes"] = _meta.lane_state_report(refresh=True)  # P3-00c: pauses, counts and parks (last 4 digits) only
    return report
