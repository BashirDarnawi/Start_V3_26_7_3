"""Albayan Studio money integrity scan (plan task P1-07b; PLAN.md §7.8 "Integrity checks", §6 D26).

``scan_studio_money(conn, now=None, *, owner_ids=None, stranded_minutes=None, balance_minor=None)``
reads the studio's money and returns a list of violations, one entry per kind found (an empty list =
nothing wrong):

    {"code", "count", "requestIds", "userIds", "moreIds", "labels": {"en", "ar"}}

``count`` is how many times the kind was found; the ids (studio request ids, customer user ids, at
most MAX_IDS of each, ``moreIds`` says how many were left out) are for admins only. No names,
amounts, e-mails or ledger memos. It is READ ONLY and never repairs anything (PLAN.md §7.8: "never
silently repair"): the studio jobs loop runs it daily and turns a finding into one
``integrity_violation`` admin alert (studio_jobs.py).

The checks (``VIOLATION_LABELS`` lists them in output order). Each one compares two INDEPENDENT
sources, never a number with itself:

* **wallet_identity_break** — per customer, the wallet summary (studio_wallet.compute_wallet_summary,
  the same code as ``/api/studio/wallet/summary``, over the rows wallet_payments.wallet_ledger_rows
  reads) against main.py's own SQL ledger balance, the number every debit gate reads
  (``balance_minor``: ``ctx["wallet_balance_minor"]`` of the jobs ctx; None = resolved from it).
  Both ``added + adjustments - in ads - being returned - spent`` (the summary's buckets) and
  ``available + reserved`` must equal that balance.
* **wallet_negative_available** — Available below zero.
* **hold_without_submitted_request** — what every debit gate holds back for the customer
  (wallet_payments.wallet_campaign_holds_minor: an SQL projection of the live requests) is not
  Reserved recomputed from those request rows themselves: each row's whole JSON (images left out)
  parsed here, the way capture_campaign_budget reads the row it captures, and campaign_hold_minor of
  the Submitted ones.
* **submitted_request_without_hold** — a live Submitted request that holds nothing (budget <= 0) or
  has no ``submittedAt`` (its approval could never be tied to a payment cycle).
* **capture_without_approval** — a paid cycle (``cpay:`` ledger row) not fully returned whose request
  is still Submitted in that cycle more than CAPTURE_GRACE_MINUTES after the capture (an approval
  that stopped between its capture and its status write), or whose request no longer exists.
* **stranded_capture** — a paid cycle not fully returned whose request LEFT the cycle (sent back,
  rejected, withdrawn, archived while waiting) for longer than ``strandedCaptureMaxMinutes``
  (the ``thresholds`` setting, 60 by default): "Being returned" must end within the hour.
* **duplicate_return** — more than one return for one paid cycle (``rel:``, ``stoprefund:`` and an
  old admin ``rev:`` are three doors; exactly one may ever be used, wallet_payments.py).
* **return_above_paid** — the returns of one paid cycle add up to more than it paid.
* **request_payment_mismatch** — an Approved or Stopped request (archived included) whose own
  ``paidMinorUSD`` / ``paymentTransactionId`` are not the amount / id of its cycle's ``cpay:`` row,
  or that claims a payment its cycle never made. A request from before the wallet (August 2026: no
  ``schemaVersion`` 2, no payment field and no ``cpay:`` row) is not judged: it never paid.
* **request_refund_mismatch** — a Stopped request whose ``refundMinorUSD`` / ``refundTransactionId``
  are not the amount / id of its cycle's ``stoprefund:`` row (0 and '' when there is none).
* **refund_above_unspent** — a Stopped request returned more than paid minus Meta's confirmed spend
  (its ``adCampaignResults`` row, when one exists for the same Meta campaign) without an admin
  ``settleOverrideReason``.
* **studio_in_core_books** — a live Albayan Manager ``ads`` row that belongs to Albayan Studio (an
  ``ALB-S-`` campaign name, or a Meta campaign id a studio request claimed), read through the
  platform door meta_collisions.collision_report; rows the owner chose to keep are not counted.
  Only request ids go into the finding; the core rows are listed by ``GET /api/meta-ads/collisions``.
* **linked_name_without_code** — a request linked to a Meta campaign whose known campaign name lacks
  the studio code: the request's own ``studioRef`` when it has one, else any ``ALB-S-`` code. A
  name that is not known yet (no results row with a name) is not judged.
* **check_failed** — a check could not run (the error type only): a failed check is a finding too.

D26 (2026-09-24) keeps studio ads on the SAME ad accounts as the agency, so there is no Studio
account list and no ``studioSince`` rule; the name code and the claimed campaign ids are the
separation.

``owner_ids`` limits the scan to those customers (their wallets and requests, and only the core
rows that claim one of their requests); the daily scan passes None (everyone). The customers are the
owners of Ads Studio requests (``created_by``), archived requests included. The ledger is read only
through the platform door wallet_payments and main's balance helper in the router ctx (D36: never an
import of main.py). Run it on a connection whose transaction reads one snapshot (studio_jobs sets
REPEATABLE READ READ ONLY on PostgreSQL), or a commit between two reads can look like a violation.
"""

import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from sqlalchemy import bindparam, text

from ...db import json_fields_select_sql, json_loads, json_loads_or_raw
from ...meta_ads import is_studio_campaign_name
from ...meta_collisions import collision_report
from ...wallet_payments import (
    _campaign_payment_key,
    campaign_hold_minor,
    wallet_campaign_holds_minor,
    wallet_ledger_rows,
)
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION, BUDGET_SCHEMA_VERSION
from .studio_diagnostics import parse_time
from .studio_results import REQUEST_FIELDS, load_owner_results, minor
from .studio_types import is_studio_ref
from .studio_wallet import CAMPAIGN_PAYMENT, USD, compute_wallet_summary, cycle_state

CAPTURE_GRACE_MINUTES = 15  # PLAN.md §7.4: an approval's capture older than this without its status write
DEFAULT_STRANDED_MINUTES = 60  # studio_settings thresholds.strandedCaptureMaxMinutes default
MAX_IDS = 50
_EXTRA_FIELDS = (
    "studioRef", "settleOverrideReason", "metaCampaignName", "paymentTransactionId", "refundTransactionId",
    "schemaVersion",
)
# main.py's SQL ledger balance, (conn, user id, currency) -> minor units (ctx["wallet_balance_minor"]).
BalanceReader = Callable[[Any, str, str], int]

# code -> labels (EN / AR); the order here is the order of the findings.
VIOLATION_LABELS: dict[str, dict[str, str]] = {
    "wallet_identity_break": {"en": "Wallet numbers do not add up", "ar": "أرقام المحفظة لا تتطابق"},
    "wallet_negative_available": {"en": "Available balance is below zero", "ar": "الرصيد المتاح أقل من صفر"},
    "hold_without_submitted_request": {
        "en": "Money held without a request waiting for review", "ar": "مبلغ محجوز دون طلب بانتظار المراجعة"},
    "submitted_request_without_hold": {
        "en": "A request waiting for review holds no money", "ar": "طلب بانتظار المراجعة دون مبلغ محجوز"},
    "capture_without_approval": {
        "en": "Budget paid but the ad was never approved", "ar": "دُفعت الميزانية والإعلان لم يُعتمد"},
    "stranded_capture": {
        "en": "Money on its way back for more than an hour", "ar": "مبلغ في طريقه للعودة منذ أكثر من ساعة"},
    "duplicate_return": {"en": "More than one return for one payment", "ar": "أكثر من استرجاع لدفعة واحدة"},
    "return_above_paid": {"en": "More was returned than was paid", "ar": "استُرجع أكثر مما دُفع"},
    "request_payment_mismatch": {
        "en": "An ad's payment does not match the wallet ledger", "ar": "دفعة الإعلان لا تطابق سجل المحفظة"},
    "request_refund_mismatch": {
        "en": "A stopped ad's refund does not match the wallet ledger", "ar": "استرجاع الإعلان المتوقف لا يطابق سجل المحفظة"},
    "refund_above_unspent": {
        "en": "Refund above paid minus Meta spend", "ar": "استرجاع أكبر من المدفوع ناقص ما صرفته ميتا"},
    "studio_in_core_books": {
        "en": "A studio ad is in Albayan Manager's books", "ar": "إعلان من الاستوديو في دفاتر مدير البيان"},
    "linked_name_without_code": {
        "en": "The linked Meta campaign name lacks the studio code", "ar": "اسم حملة ميتا المربوطة لا يحمل رمز الاستوديو"},
    "check_failed": {"en": "A money check could not run", "ar": "تعذّر تشغيل أحد فحوص الأموال"},
}


class _Findings:
    """Counts and ids per violation code, in VIOLATION_LABELS order."""

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}

    def add(self, code: str, *, request_ids: Iterable[str] = (), user_id: str = "", check: str = "") -> None:
        entry = self._items.setdefault(code, {"count": 0, "requestIds": [], "userIds": [], "checks": [], "more": 0})
        entry["count"] += 1
        for value, bucket in [*((rid, "requestIds") for rid in request_ids), (user_id, "userIds"), (check, "checks")]:
            value = str(value or "")
            if not value or value in entry[bucket]:
                continue
            if len(entry[bucket]) < MAX_IDS:
                entry[bucket].append(value)
            else:
                entry["more"] += 1

    def result(self) -> list[dict[str, Any]]:
        out = []
        for code in VIOLATION_LABELS:
            entry = self._items.get(code)
            if not entry:
                continue
            item = {
                "code": code,
                "count": entry["count"],
                "requestIds": sorted(entry["requestIds"]),
                "userIds": sorted(entry["userIds"]),
                "moreIds": entry["more"],
                "labels": dict(VIOLATION_LABELS[code]),
            }
            if entry["checks"]:
                item["checks"] = sorted(entry["checks"])
            out.append(item)
        return out


def failed_check(check: str, error: BaseException) -> dict[str, Any]:
    """A ``check_failed`` finding for a scan that could not run at all (the error type only)."""
    findings = _Findings()
    findings.add("check_failed", check=f"{check}:{type(error).__name__}")
    return findings.result()[0]


def violation_counts(violations: list[dict[str, Any]]) -> dict[str, Any]:
    """Counts only (no ids), for studioJobState.lastIntegrityResult and diagnostics."""
    by_code = {item["code"]: int(item["count"]) for item in violations}
    return {"total": sum(by_code.values()), "byCode": by_code}


# ------------------------------------------------------------------ ledger helpers (also used by studio_jobs)

def campaign_payments(ledger: list[dict[str, Any]], owner_id: str) -> list[dict[str, Any]]:
    """The owner's USD ``cpay:`` rows (wallet_payments.capture_campaign_budget), as the summary finds them."""
    uid = str(owner_id or "")
    return [
        row for row in ledger
        if row["currency"] == USD and row["type"] == CAMPAIGN_PAYMENT and row["fromUserId"] == uid
        and row["toUserId"] != uid and row["idempotencyKey"].startswith("cpay:")
    ]


def payment_returns(ledger: list[dict[str, Any]], pay: dict[str, Any], owner_id: str) -> list[dict[str, Any]]:
    """The rows that returned one paid cycle: joined like studio_wallet.compute_wallet_summary joins them
    (``reversalOf`` the cpay row id, or the keys ``rel:``/``stoprefund:`` + cpay key, ``rev:`` + cpay row id)."""
    uid = str(owner_id or "")
    key = pay["idempotencyKey"]
    keys = {f"rel:{key}", f"stoprefund:{key}", f"rev:{pay['id']}"}
    return [
        row for row in ledger
        if row["id"] != pay["id"] and row["currency"] == USD and row["toUserId"] == uid and row["fromUserId"] != uid
        and ((row["referenceType"] == "reversalOf" and row["referenceId"] == pay["id"]) or row["idempotencyKey"] in keys)
    ]


def open_captures(ledger: list[dict[str, Any]], owner_id: str) -> dict[str, dict[str, Any]]:
    """{cpay key: cpay row} for the owner's paid cycles with no return at all (read only)."""
    return {
        pay["idempotencyKey"]: pay
        for pay in campaign_payments(ledger, owner_id)
        if not payment_returns(ledger, pay, owner_id)
    }


def _meta_campaign_id(value: Any) -> str:
    raw = str(value or "").strip()
    return raw if raw.isascii() and raw.isdigit() and len(raw) <= 40 else ""


def _minutes_since(moment: Any, now: datetime) -> float | None:
    parsed = parse_time(moment)
    return None if parsed is None else (now - parsed).total_seconds() / 60


# ------------------------------------------------------------------ reads

def _load_requests(conn: Any, owner_ids: list[str] | None) -> dict[str, list[dict[str, Any]]]:
    """{owner id: requests shaped like studio_results.load_owner_requests, plus _EXTRA_FIELDS}, archived included."""
    fields = tuple(dict.fromkeys((*REQUEST_FIELDS, *_EXTRA_FIELDS)))
    params: dict[str, Any] = {"type": AD_CAMPAIGN_COLLECTION}
    if owner_ids is None:
        query = text(json_fields_select_sql(fields, ("id", "deleted", "created_by"), "type = :type AND created_by IS NOT NULL"))
    else:
        query = text(json_fields_select_sql(
            fields, ("id", "deleted", "created_by"), "type = :type AND created_by IN :owners",
        )).bindparams(bindparam("owners", expanding=True))
        params["owners"] = sorted(set(owner_ids)) or [""]
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in conn.execute(query, params).mappings().all():
        item = {field: row.get(f"f_{field.lower()}") for field in fields}
        item["changeReasons"] = json_loads_or_raw(item.get("changeReasons"))
        item["id"] = str(row["id"])
        item["archived"] = bool(row.get("deleted"))
        grouped[str(row["created_by"])].append(item)
    return grouped


def _rows_hold_minor(conn: Any, uid: str) -> int:
    """Reserved recomputed from the owner's live request rows themselves: each row's whole JSON parsed
    here (the database leaves the images out), the way capture_campaign_budget reads the row it
    captures, then campaign_hold_minor of the Submitted ones. Never wallet_campaign_holds_minor's SQL
    projection, so the holds check compares two readers of the same rows."""
    if conn.dialect.name == "postgresql":
        lean = "(data_json::jsonb - 'creativeImages')::text"
    else:
        lean = "json_remove(data_json, '$.creativeImages')"
    total = 0
    for raw in conn.execute(
        text(f"SELECT {lean} AS doc FROM entities WHERE type = :type AND deleted = false AND created_by = :uid"),
        {"type": AD_CAMPAIGN_COLLECTION, "uid": uid},
    ).scalars():
        data = json_loads(raw or "{}")
        if isinstance(data, dict) and str(data.get("status") or "") == "Submitted":
            total += campaign_hold_minor(data)
    return total


def _jobs_balance_reader() -> BalanceReader:
    """main's SQL balance helper from the jobs ctx (studio_jobs.resolve_jobs_ctx; D36: never an import of main.py)."""
    from .studio_jobs import resolve_jobs_ctx  # late: studio_jobs imports this module

    return resolve_jobs_ctx(None)["wallet_balance_minor"]


# ------------------------------------------------------------------ the checks

def _check_owner(
    conn: Any, findings: _Findings, uid: str, requests: list[dict[str, Any]], now: datetime, stranded_minutes: int,
    balance_of: BalanceReader | None,
) -> None:
    ledger = wallet_ledger_rows(conn, uid)
    results = load_owner_results(conn, uid, (request["id"] for request in requests))
    reserved = wallet_campaign_holds_minor(conn, uid)
    by_id = {request["id"]: request for request in requests}

    # The identity: the customer's wallet screen (the same code) against main's own SQL balance, the
    # number every debit gate reads (None: that helper could not be reached, already a check_failed).
    usd = compute_wallet_summary(uid, ledger, requests, results, reserved, [], now)["usd"]
    if balance_of is not None:
        balance = int(balance_of(conn, uid, USD))
        buckets = usd["addedMinor"] + usd["adjustmentsMinor"] - usd["inAdsMinor"] - usd["beingReturnedMinor"]
        if buckets - usd["spentMinor"] != balance or usd["availableMinor"] + usd["reservedMinor"] != balance:
            findings.add("wallet_identity_break", user_id=uid)
    if usd["availableMinor"] < 0:
        findings.add("wallet_negative_available", user_id=uid)

    # Holds: what the debit gates hold back = what the Submitted rows themselves hold (the capture's read).
    if reserved != _rows_hold_minor(conn, uid):
        findings.add("hold_without_submitted_request", user_id=uid)
    waiting = [r for r in requests if not r["archived"] and str(r.get("status") or "") == "Submitted"]
    for request in waiting:
        if campaign_hold_minor(request) <= 0 or not str(request.get("submittedAt") or "").strip():
            findings.add("submitted_request_without_hold", request_ids=[request["id"]], user_id=uid)

    # Captures and their returns, one paid cycle at a time.
    for pay in campaign_payments(ledger, uid):
        request_id = pay["referenceId"]
        returns = payment_returns(ledger, pay, uid)
        paid = int(pay["amountMinor"])
        returned = sum(int(row["amountMinor"]) for row in returns)
        if len(returns) > 1:
            findings.add("duplicate_return", request_ids=[request_id], user_id=uid)
        if returned > paid:
            findings.add("return_above_paid", request_ids=[request_id], user_id=uid)
        request = by_id.get(request_id)
        state = cycle_state(request, pay["idempotencyKey"])
        age = _minutes_since(pay["createdAt"], now)
        if paid - returned > 0:
            if request is None or (state == "approving" and (age is None or age > CAPTURE_GRACE_MINUTES)):
                findings.add("capture_without_approval", request_ids=[request_id], user_id=uid)
            elif state == "being_returned" and (age is None or age > stranded_minutes):
                findings.add("stranded_capture", request_ids=[request_id], user_id=uid)
        if request is not None and state == "spent" and returned > 0:
            meta_id = _meta_campaign_id(request.get("metaCampaignId"))
            row = results.get(request_id)
            override = str(request.get("settleOverrideReason") or "").strip()
            if (
                row and meta_id and row["metaCampaignId"] == meta_id and row["currency"] == USD
                and row["spendConfirmedAt"] and not override and returned > max(paid - int(row["spendMinorUSD"]), 0)
            ):
                findings.add("refund_above_unspent", request_ids=[request_id], user_id=uid)

    # Each Approved or Stopped request (archived included) against its own cycle's ledger rows.
    pays = {pay["idempotencyKey"]: pay for pay in campaign_payments(ledger, uid)}
    refunds = {
        row["idempotencyKey"]: row for row in ledger
        if row["currency"] == USD and row["toUserId"] == uid and row["fromUserId"] != uid
        and row["idempotencyKey"].startswith("stoprefund:")
    }
    for request in requests:
        status = str(request.get("status") or "")
        if status not in ("Approved", "Stopped"):
            continue
        key = _campaign_payment_key(request)
        pay = pays.get(key)
        paid, pay_tx = minor(request.get("paidMinorUSD")), str(request.get("paymentTransactionId") or "").strip()
        if pay is not None:
            wrong = paid != int(pay["amountMinor"]) or pay_tx != pay["id"]
        else:  # only a request from before the wallet may have no payment, and then it claims none
            wrong = bool(paid or pay_tx) or minor(request.get("schemaVersion")) >= BUDGET_SCHEMA_VERSION
        if wrong:
            findings.add("request_payment_mismatch", request_ids=[request["id"]], user_id=uid)
        if status == "Stopped":
            refund = refunds.get(f"stoprefund:{key}")
            expected = (int(refund["amountMinor"]), refund["id"]) if refund else (0, "")
            if (minor(request.get("refundMinorUSD")), str(request.get("refundTransactionId") or "").strip()) != expected:
                findings.add("request_refund_mismatch", request_ids=[request["id"]], user_id=uid)

    # Linked requests carry the studio code in their Meta campaign name (D26).
    for request in requests:
        meta_id = _meta_campaign_id(request.get("metaCampaignId"))
        if not meta_id:
            continue
        row = results.get(request["id"])
        name = row["metaCampaignName"] if row and row["metaCampaignId"] == meta_id and row["metaCampaignName"] else ""
        name = name or str(request.get("metaCampaignName") or "").strip()
        if not name:
            continue  # not known yet: nothing to judge
        ref = str(request.get("studioRef") or "").strip().upper()
        if is_studio_ref(ref):
            carries = ref in unicodedata.normalize("NFKC", name).upper()
        else:
            carries = is_studio_campaign_name(name)
        if not carries:
            findings.add("linked_name_without_code", request_ids=[request["id"]], user_id=uid)


def _check_core_books(conn: Any, findings: _Findings, scanned_request_ids: set[str] | None) -> None:
    report = collision_report(conn)
    for row in report.get("rows") or []:
        if row.get("kept"):
            continue  # the owner chose to keep it in Manager (scripts/studio_collision_repair.py)
        request_ids = [str(rid) for rid in row.get("studioRequestIds") or []]
        if scanned_request_ids is not None and not scanned_request_ids.intersection(request_ids):
            continue  # a scoped scan counts only the core rows that claim one of its requests
        findings.add("studio_in_core_books", request_ids=request_ids)


def scan_studio_money_report(
    conn: Any,
    now: datetime | None = None,
    *,
    owner_ids: Iterable[str] | None = None,
    stranded_minutes: int | None = None,
    balance_minor: BalanceReader | None = None,
) -> dict[str, Any]:
    """``{"violations": [...], "checked": {"customers", "requests"}}`` (see the module docstring)."""
    now = now or datetime.now(timezone.utc)
    now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    stranded = int(stranded_minutes or DEFAULT_STRANDED_MINUTES)
    scoped = None if owner_ids is None else [str(uid) for uid in owner_ids if str(uid or "")]
    findings = _Findings()
    balance_of = balance_minor
    if balance_of is None:
        try:
            balance_of = _jobs_balance_reader()
        except Exception as error:  # the other checks still run; this one is a finding, never silence
            findings.add("check_failed", check=f"wallet_balance:{type(error).__name__}")
    grouped = _load_requests(conn, scoped)
    for uid in sorted(grouped):
        try:
            _check_owner(conn, findings, uid, grouped[uid], now, stranded, balance_of)
        except Exception as error:  # one customer's unreadable rows must not hide everyone else's
            findings.add("check_failed", user_id=uid, check=f"wallet:{type(error).__name__}")
    scanned = None if scoped is None else {request["id"] for items in grouped.values() for request in items}
    try:
        _check_core_books(conn, findings, scanned)
    except Exception as error:
        findings.add("check_failed", check=f"studio_in_core_books:{type(error).__name__}")
    return {
        "violations": findings.result(),
        "checked": {"customers": len(grouped), "requests": sum(len(items) for items in grouped.values())},
    }


def scan_studio_money(
    conn: Any,
    now: datetime | None = None,
    *,
    owner_ids: Iterable[str] | None = None,
    stranded_minutes: int | None = None,
    balance_minor: BalanceReader | None = None,
) -> list[dict[str, Any]]:
    """The violations list of scan_studio_money_report (empty when nothing is wrong)."""
    return scan_studio_money_report(
        conn, now, owner_ids=owner_ids, stranded_minutes=stranded_minutes, balance_minor=balance_minor,
    )["violations"]
