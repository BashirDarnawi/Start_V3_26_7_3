"""Albayan Studio campaigns found in Albayan Manager's books (plan task P0-10, owner decision D26).

Before P0-09, Manager's automatic Meta import could take in a campaign that Albayan Studio runs and
turn it into an unpaid "needs setup" core ad. This platform module finds those core ``ads`` rows and
changes them only with the owner's written choice:

* ``collision_report(conn)``: read-only. Counts, and one row of flags per colliding core ad: its id,
  why it collides, whether it has receipts / collections / wallet / company-funding records, a
  Manager payment state or a customer, its spend numbers and its ``decisionFingerprint`` (a hash of
  what the owner's choice rests on). Never names, phones or campaign names.
* ``plan_repair`` (dry run) and ``apply_repair``: the owner's signed choices file says, per row,
  ``keep_in_manager`` or ``remove_from_manager``; a removal must carry the row's decisionFingerprint
  and is refused when the row's decision facts changed since the report (Meta's own spend/schedule
  sync does not count). Removal is a soft delete, in ONE transaction, of rows with no money records;
  a row with money or in a closed financial month is refused and never deleted. ``keep_in_manager``
  is remembered in a server-only metaHealthState row, so the check stops counting that row as open.
  Both are audited as ``collision_repair``; the result includes a reversal record.
* ``reverse_repair``: undoes one apply from its reversal record (all rows or none); a row whose
  financial month was closed since refuses the whole reversal.
* ``create_meta_collisions_router``: ``GET /api/meta-ads/collisions``, the report for admins.

Platform code (D36): it may read Manager's ``ads`` and money rows and Ads Studio's
``adCampaignRequests``; systems reach them only through platform doors. The SQL runs on PostgreSQL
(production) and SQLite (tests). scripts/studio_collision_repair.py is the command line for it.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import bindparam, text

from .db import db_conn, json_dumps, json_fields_select_sql, json_loads, now_ms
from .meta_ads import is_studio_campaign_name
from .operations import financial_period_is_closed
from .rate_limiter import check_rate_limit
from .security import new_id

ADS_TYPE = "ads"
STUDIO_REQUEST_TYPE = "adCampaignRequests"
# Server-only platform state (never served by /api/collections): the owner's keep decisions.
DECISIONS_STATE_TYPE = "metaHealthState"
DECISIONS_STATE_ID = "studio-collision-decisions"
AUDIT_ACTION = "collision_repair"
KEEP = "keep_in_manager"
REMOVE = "remove_from_manager"
REVERSAL_KIND = "albayan-studio-collision-reversal"
MAX_CHOICES = 5000
REPORT_READS_PER_MINUTE = 6

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")  # main.SAFE_ENTITY_ID_RE; no LIKE wildcard but "_"
_REPAIR_ID_RE = re.compile(r"^collision_repair_[0-9a-f]{32}$")
_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
# What the owner's choice rests on. Meta's sync rewrites spend, schedule, status, history and
# last_modified every few minutes; none of those is here, so a sync alone never voids a choice.
_DECISION_FIELDS = (
    "customerId", "amountUSD", "amountLocal", "paymentStatus", "isPaid", "editCount",
    "metaImportState", "metaCampaignName", "metaCampaignId",
)
_UNSET_PAYMENT_STATUS = "pending_setup"  # what Meta's automatic import writes; nobody chose it
_RECEIPT_ID_FIELDS = (
    "receiptId", "mergedReceiptId", "dueReceiptId", "fundingReceiptId", "linkedDeliveryReceiptId", "linkedReceiptId",
)
_RECEIPT_LIST_FIELDS = ("receiptIds", "adReceiptIds", "receiptAllocations", "dueAllocations", "mergedPaidAllocations")
_DUE_AMOUNT_FIELDS = ("dueAmountToUseUSD", "dueAmountToUseLYD")
_COLLECTION_AMOUNT_FIELDS = ("collectedAmount", "amountCollectedFromCustomer", "deliveryFeeCollected", "actualDeliveryFeeCollected")
_COMPANY_AMOUNT_FIELDS = ("companyFundedUSD", "companyDirectCoverageUSD", "customerDueUSD")
# Records that point back at a core ad and mean money moved for it (ad -> receipt links are read from
# the ad itself). Deleted markers count too: this tool never removes an ad with money history.
_MONEY_REFERENCES = {
    "walletTransactions": "wallet",
    "walletPaymentRequests": "wallet",
    "receiptCompanyCoverages": "companyFunding",
    "receiptCompanyCoverageMutations": "companyFunding",
    "adFundingMutations": "receipts",
    "adStopMutations": "receipts",
    "receiptSettlementMutations": "receipts",
    "receiptTransferMutations": "receipts",
}
MONEY_FLAGS = ("receipts", "collections", "wallet", "companyFunding", "paymentState")


class CollisionRepairError(ValueError):
    """A choices or reversal file that cannot be used, or a repair or reversal refused as a whole."""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _postgres(conn: Any) -> bool:
    return str(conn.dialect.name or "") == "postgresql"


def _sha256(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _data(row: Mapping[str, Any]) -> dict[str, Any]:
    try:
        data = json_loads(row.get("data_json") or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _amount(value: Any) -> bool:
    """True when a money field holds anything but zero (an unreadable value counts as money)."""
    if value in (None, "", False):
        return False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return True
    return not math.isfinite(number) or number != 0


def _listed(value: Any) -> bool:
    return isinstance(value, list) and any(item not in (None, "", {}, []) for item in value)


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _int(value: Any) -> int:
    return int(_number(value))


def _usd(value: Any) -> float:
    return round(_number(value), 2)


def _money_flags(data: Mapping[str, Any], references: Iterable[str] = ()) -> dict[str, bool]:
    refs = set(references)
    return {
        "receipts": (
            "receipts" in refs
            or any(str(data.get(field) or "").strip() for field in _RECEIPT_ID_FIELDS)
            or any(_listed(data.get(field)) for field in _RECEIPT_LIST_FIELDS)
            or any(_amount(data.get(field)) for field in _DUE_AMOUNT_FIELDS)
            or bool(data.get("hasMergedPaidFunds"))
        ),
        "collections": (
            _listed(data.get("collectionPayments"))
            or any(_amount(data.get(field)) for field in _COLLECTION_AMOUNT_FIELDS)
            or bool(str(data.get("collectionMethod") or "").strip())
            or bool(str(data.get("deliveryPersonId") or "").strip())
            or str(data.get("deliveryStatus") or "Office").strip() not in {"", "Office"}
        ),
        "wallet": "wallet" in refs,
        "companyFunding": (
            "companyFunding" in refs
            or _listed(data.get("companyFundingAllocations"))
            or any(_amount(data.get(field)) for field in _COMPANY_AMOUNT_FIELDS)
        ),
        # Any payment state but the import's own counts: Manager's books read a blank one as "paid".
        "paymentState": (
            str(data.get("paymentStatus") or "").strip().lower() != _UNSET_PAYMENT_STATUS
            or isinstance(data.get("isPaid"), bool)
        ),
    }


def _decision_fingerprint(data: Mapping[str, Any], references: Iterable[str]) -> str:
    """sha256 of the canonical JSON of the row's decision fields, money flags and money-record kinds."""
    refs = sorted(set(references))
    decision = {
        "fields": {field: data.get(field) for field in _DECISION_FIELDS},
        "money": _money_flags(data, refs),
        "references": refs,
    }
    return _sha256(json.dumps(decision, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def _reasons(campaign_name: Any, campaign_id: Any, studio: Mapping[str, list[str]]) -> list[str]:
    reasons = []
    if is_studio_campaign_name(campaign_name):
        reasons.append("studio_name")
    if str(campaign_id or "").strip() in studio:
        reasons.append("studio_campaign_id")
    return reasons


def _studio_campaigns(conn: Any) -> dict[str, list[str]]:
    """{Meta campaign id: [Studio request ids]} for every request linked to a Meta campaign (archived too)."""
    sql = json_fields_select_sql(("metaCampaignId",), ("id",), "type = :type")
    found: dict[str, list[str]] = {}
    for row in conn.execute(text(sql), {"type": STUDIO_REQUEST_TYPE}).mappings():
        campaign = str(row.get("f_metacampaignid") or "").strip()
        if campaign:
            found.setdefault(campaign, []).append(str(row["id"]))
    return found


def _colliding(conn: Any, studio: Mapping[str, list[str]]) -> dict[str, str]:
    """{live core ad id: its Meta campaign id} for core ads that belong to Albayan Studio."""
    sql = json_fields_select_sql(("metaCampaignName", "metaCampaignId"), ("id",), "type = :type AND deleted = false")
    found: dict[str, str] = {}
    for row in conn.execute(text(sql), {"type": ADS_TYPE}).mappings():
        if _reasons(row.get("f_metacampaignname"), row.get("f_metacampaignid"), studio):
            found[str(row["id"])] = str(row.get("f_metacampaignid") or "").strip()
    return found


def _load_ads(conn: Any, ad_ids: Iterable[str], *, lock: bool) -> dict[str, dict[str, Any]]:
    ids = sorted(set(ad_ids))
    columns = "SELECT id, data_json, deleted, created_at, created_by, last_modified FROM entities "
    rows: dict[str, dict[str, Any]] = {}
    if lock:
        # One row at a time in id order: two repairs can never lock the same rows in opposite orders.
        suffix = " FOR UPDATE" if _postgres(conn) else ""
        for ad_id in ids:
            row = conn.execute(
                text(columns + "WHERE type = :type AND id = :id" + suffix), {"type": ADS_TYPE, "id": ad_id}
            ).mappings().first()
            if row:
                rows[ad_id] = dict(row)
        return rows
    for start in range(0, len(ids), 200):
        query = text(columns + "WHERE type = :type AND id IN :ids").bindparams(bindparam("ids", expanding=True))
        for row in conn.execute(query, {"type": ADS_TYPE, "ids": ids[start:start + 200]}).mappings():
            rows[str(row["id"])] = dict(row)
    return rows


def _like_literal(value: str) -> str:
    return re.sub(r"([!%_])", r"!\1", value)


def _money_references(conn: Any, ad_ids: Iterable[str]) -> dict[str, set[str]]:
    """{ad id: {"wallet", "receipts", ...}} from money records that name the ad anywhere in their data."""
    query = text(
        "SELECT DISTINCT type FROM entities WHERE type IN :types AND data_json LIKE :pattern ESCAPE '!'"
    ).bindparams(bindparam("types", expanding=True))
    found: dict[str, set[str]] = {}
    for ad_id in sorted(set(ad_ids)):
        pattern = f"%{_like_literal(json_dumps(ad_id))}%"
        types = conn.execute(query, {"types": sorted(_MONEY_REFERENCES), "pattern": pattern}).scalars().all()
        if types:
            found[ad_id] = {_MONEY_REFERENCES[str(kind)] for kind in types if str(kind) in _MONEY_REFERENCES}
    return found


def _load_decisions(conn: Any, *, lock: bool) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    suffix = " FOR UPDATE" if lock and _postgres(conn) else ""
    row = conn.execute(
        text("SELECT id, data_json, deleted, last_modified FROM entities WHERE type = :type AND id = :id" + suffix),
        {"type": DECISIONS_STATE_TYPE, "id": DECISIONS_STATE_ID},
    ).mappings().first()
    if not row:
        return None, {"kept": {}}
    data = {} if bool(row["deleted"]) else _data(row)
    if not isinstance(data.get("kept"), dict):
        data["kept"] = {}
    return dict(row), data


def _write_decisions(conn: Any, row: Mapping[str, Any] | None, data: dict[str, Any]) -> None:
    clean = {**data, "recordType": DECISIONS_STATE_TYPE, "updatedAt": _iso_now()}
    if row is None:
        stamp = now_ms()
        conn.execute(
            text(
                "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                "VALUES (:type, :id, :data, false, :stamp, NULL, :stamp)"
            ),
            {"type": DECISIONS_STATE_TYPE, "id": DECISIONS_STATE_ID, "data": json_dumps(clean), "stamp": stamp},
        )
        return
    conn.execute(
        text(
            "UPDATE entities SET data_json = :data, deleted = false, last_modified = :stamp "
            "WHERE type = :type AND id = :id"
        ),
        {
            "type": DECISIONS_STATE_TYPE, "id": DECISIONS_STATE_ID, "data": json_dumps(clean),
            "stamp": max(now_ms(), int(row["last_modified"] or 0) + 1),
        },
    )


def _audit(conn: Any, actor_id: str | None, resource_type: str, resource_id: str, message: str, metadata: dict[str, Any]) -> None:
    """The same audit_logs row as main.audit(), written in the repair's own transaction."""
    conn.execute(
        text(
            "INSERT INTO audit_logs (id, ts, user_id, action, resource_type, resource_id, message, metadata_json) "
            "VALUES (:id, :ts, :user_id, :action, :resource_type, :resource_id, :message, :metadata)"
        ),
        {
            "id": new_id("audit"), "ts": now_ms(), "user_id": actor_id, "action": AUDIT_ACTION,
            "resource_type": resource_type, "resource_id": resource_id, "message": message,
            "metadata": json_dumps(metadata),
        },
    )


def _serialize(conn: Any) -> None:
    if _postgres(conn):  # one repair or reversal at a time, across every app process
        conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('albayan_collision_repair'))"))


def _row_facts(ad_id: str, row: Mapping[str, Any], campaign_id: str, studio: Mapping[str, list[str]],
               references: Iterable[str], kept: bool) -> dict[str, Any]:
    data = _data(row)
    refs = set(references)
    flags = _money_flags(data, refs)
    has_money = any(flags.values())
    has_customer = bool(str(data.get("customerId") or "").strip())
    import_state = str(data.get("metaImportState") or "")[:40]
    return {
        "adId": ad_id,
        # Copied into the choices file; apply refuses the row if these facts changed since the report.
        "decisionFingerprint": _decision_fingerprint(data, refs),
        "reasons": _reasons(data.get("metaCampaignName"), campaign_id, studio),
        "studioRequestIds": sorted(studio.get(campaign_id, [])),
        "kept": kept,
        "hasReceipts": flags["receipts"],
        "hasCollections": flags["collections"],
        "hasWallet": flags["wallet"],
        "hasCompanyFunding": flags["companyFunding"],
        "hasPaymentState": flags["paymentState"],
        "hasCustomer": has_customer,
        "hasMoney": has_money,
        "removable": not has_money,
        # D26: an imported copy nobody completed or edited is the expected, safe-to-remove case.
        "untouched": (
            import_state == "needs_completion" and not _int(data.get("editCount")) and not has_money and not has_customer
        ),
        "importState": import_state,
        "spend": {
            "metaSpendMinor": _int(data.get("metaSpendMinor")),
            "metaCurrency": str(data.get("metaCurrency") or "")[:12].upper(),
            "amountUSD": _usd(data.get("amountUSD")),
        },
    }


def collision_report(conn: Any) -> dict[str, Any]:
    """Counts and per-row flags for live core ads that belong to Albayan Studio (read-only)."""
    studio = _studio_campaigns(conn)
    colliding = _colliding(conn, studio)
    rows = _load_ads(conn, colliding, lock=False)
    references = _money_references(conn, colliding)
    kept = _load_decisions(conn, lock=False)[1].get("kept") or {}
    items = [
        _row_facts(ad_id, rows[ad_id], colliding[ad_id], studio, references.get(ad_id, set()), ad_id in kept)
        for ad_id in sorted(colliding)
        if ad_id in rows
    ]

    def count(flag: str) -> int:
        return sum(1 for item in items if item[flag])

    return {
        "generatedAt": _iso_now(),
        "counts": {
            "total": len(items),
            "open": sum(1 for item in items if not item["kept"]),
            "kept": count("kept"),
            "byReason": {
                reason: sum(1 for item in items if reason in item["reasons"])
                for reason in ("studio_name", "studio_campaign_id")
            },
            "withReceipts": count("hasReceipts"),
            "withCollections": count("hasCollections"),
            "withWallet": count("hasWallet"),
            "withCompanyFunding": count("hasCompanyFunding"),
            "withPaymentState": count("hasPaymentState"),
            "withCustomer": count("hasCustomer"),
            "withMoney": count("hasMoney"),
            "removable": sum(1 for item in items if item["removable"] and not item["kept"]),
            "untouched": count("untouched"),
        },
        "rows": items,
    }


def parse_choices(document: Any) -> dict[str, Any]:
    """Validate the owner's signed choices file; raises CollisionRepairError with a plain reason."""
    if not isinstance(document, dict):
        raise CollisionRepairError("The choices file must be a JSON object.")
    signed_by = str(document.get("signedBy") or "").strip()
    signed_at = str(document.get("signedAt") or "").strip()
    if not signed_by or not signed_at:
        raise CollisionRepairError("The choices file must say who signed it (signedBy) and when (signedAt).")
    raw = document.get("choices")
    if not isinstance(raw, list) or not raw:
        raise CollisionRepairError("The choices file has no choices.")
    if len(raw) > MAX_CHOICES:
        raise CollisionRepairError(f"The choices file has more than {MAX_CHOICES} choices.")
    seen: set[str] = set()
    choices = []
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise CollisionRepairError(f"Choice {index} is not an object.")
        ad_id = str(item.get("adId") or "").strip()
        if not _ID_RE.fullmatch(ad_id):
            raise CollisionRepairError(f"Choice {index}: adId is missing or is not a record id.")
        if ad_id in seen:
            raise CollisionRepairError(f"Choice {index}: {ad_id} is listed twice.")
        seen.add(ad_id)
        if item.get("choice") not in (KEEP, REMOVE):
            raise CollisionRepairError(f"Choice {index}: choice must be {KEEP!r} or {REMOVE!r}.")
        fingerprint = item.get("decisionFingerprint")
        if fingerprint is None and item["choice"] == REMOVE:
            raise CollisionRepairError(
                f"Choice {index}: {REMOVE} needs decisionFingerprint, copied from the report row for {ad_id}."
            )
        if fingerprint is not None and not (isinstance(fingerprint, str) and _FINGERPRINT_RE.fullmatch(fingerprint)):
            raise CollisionRepairError(f"Choice {index}: decisionFingerprint must be the value from the report.")
        choices.append({"adId": ad_id, "choice": item["choice"], "fingerprint": fingerprint})
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {"signedBy": signed_by[:120], "signedAt": signed_at[:40], "choices": choices, "sha256": _sha256(canonical)}


def _plan(conn: Any, parsed: Mapping[str, Any], *, lock: bool) -> dict[str, Any]:
    studio = _studio_campaigns(conn)
    rows = _load_ads(conn, (choice["adId"] for choice in parsed["choices"]), lock=lock)
    live = {ad_id for ad_id, row in rows.items() if not bool(row["deleted"])}
    references = _money_references(conn, live)
    remove: list[dict[str, Any]] = []
    keep: list[str] = []
    refused: list[dict[str, Any]] = []
    for choice in parsed["choices"]:
        ad_id, row = choice["adId"], rows.get(choice["adId"])
        refusal: dict[str, Any] = {"adId": ad_id, "choice": choice["choice"]}
        data = _data(row) if row else {}
        flags = _money_flags(data, references.get(ad_id, set()))
        if row is None:
            refused.append({**refusal, "reason": "not_found"})
        elif bool(row["deleted"]):
            refused.append({**refusal, "reason": "already_removed"})
        elif not _reasons(data.get("metaCampaignName"), data.get("metaCampaignId"), studio):
            refused.append({**refusal, "reason": "not_a_collision"})
        elif choice["fingerprint"] is not None and (
            _decision_fingerprint(data, references.get(ad_id, set())) != choice["fingerprint"]
        ):
            refused.append({**refusal, "reason": "changed_since_report"})
        elif choice["choice"] == KEEP:
            keep.append(ad_id)
        elif any(flags.values()):
            refused.append({**refusal, "reason": "has_money", "money": [name for name in MONEY_FLAGS if flags[name]]})
        elif financial_period_is_closed(ADS_TYPE, data, conn=conn):
            refused.append({**refusal, "reason": "closed_period"})
        else:
            remove.append(row)
    return {"remove": remove, "keep": keep, "refused": refused}


def plan_repair(conn: Any, document: Any) -> dict[str, Any]:
    """Dry run: what apply_repair would do with these choices now. Writes nothing."""
    parsed = parse_choices(document)
    plan = _plan(conn, parsed, lock=False)
    return {
        "dryRun": True,
        "signedBy": parsed["signedBy"],
        "choicesSha256": parsed["sha256"],
        "wouldRemove": [str(row["id"]) for row in plan["remove"]],
        "wouldKeep": plan["keep"],
        "refused": plan["refused"],
    }


def apply_repair(
    conn: Any, document: Any, *, actor_id: str | None = None, database: str = ""
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Soft-delete the chosen money-free rows and remember the kept ones, in the caller's transaction.

    Returns (result, reversal); reversal is None when nothing changed. Any row that changed while the
    repair ran raises CollisionRepairError, so the caller's transaction rolls back as a whole.
    """
    parsed = parse_choices(document)
    _serialize(conn)
    plan = _plan(conn, parsed, lock=True)
    repair_id = new_id("collision_repair")
    applied_at = _iso_now()
    removed = []
    for row in plan["remove"]:
        before = int(row["last_modified"] or 0)
        after = max(now_ms(), before + 1)
        result = conn.execute(
            text(
                "UPDATE entities SET deleted = true, last_modified = :after "
                "WHERE type = :type AND id = :id AND deleted = false AND last_modified = :before"
            ),
            {"type": ADS_TYPE, "id": row["id"], "before": before, "after": after},
        )
        if result.rowcount != 1:
            raise CollisionRepairError(f"{row['id']} changed while the repair ran.")
        removed.append({
            "adId": str(row["id"]), "lastModifiedBefore": before, "lastModifiedAfter": after,
            "dataSha256": _sha256(row["data_json"]),
        })
    kept = []
    if plan["keep"]:
        state_row, state = _load_decisions(conn, lock=True)
        for ad_id in plan["keep"]:
            kept.append({"adId": ad_id, "previous": state["kept"].get(ad_id)})
            state["kept"][ad_id] = {"decidedAt": applied_at, "repairId": repair_id}
        _write_decisions(conn, state_row, state)
    result_summary = {
        "repairId": repair_id,
        "removed": [item["adId"] for item in removed],
        "kept": [item["adId"] for item in kept],
        "refused": plan["refused"],
    }
    if not removed and not kept:
        return result_summary, None
    reversal = {
        "kind": REVERSAL_KIND, "version": 1, "repairId": repair_id, "appliedAt": applied_at,
        "database": str(database or "")[:120], "signedBy": parsed["signedBy"], "signedAt": parsed["signedAt"],
        "choicesSha256": parsed["sha256"], "removed": removed, "kept": kept,
    }
    _audit(
        conn, actor_id, ADS_TYPE, repair_id,
        f"Studio collision repair: removed {len(removed)} and kept {len(kept)} core ads by the owner's signed choices",
        {**reversal, "refused": plan["refused"]},
    )
    for item in removed:
        _audit(conn, actor_id, ADS_TYPE, item["adId"], "Removed from Albayan Manager: an Albayan Studio campaign copy",
               {"repairId": repair_id, "lastModifiedBefore": item["lastModifiedBefore"]})
    return result_summary, reversal


def reverse_repair(conn: Any, reversal: Any, *, actor_id: str | None = None) -> dict[str, Any]:
    """Undo one apply_repair exactly: every removed row comes back unchanged, every keep decision is undone.

    All or nothing: if any row or decision changed after the repair, or a removed row's financial month
    was closed since, nothing is changed. A month being closed or unlocked right now raises 409.
    """
    if not isinstance(reversal, dict) or reversal.get("kind") != REVERSAL_KIND or reversal.get("version") != 1:
        raise CollisionRepairError("This is not a collision repair reversal file.")
    repair_id = str(reversal.get("repairId") or "")
    removed, kept = reversal.get("removed"), reversal.get("kept")
    if not _REPAIR_ID_RE.fullmatch(repair_id) or not isinstance(removed, list) or not isinstance(kept, list):
        raise CollisionRepairError("The reversal file is damaged (repairId, removed or kept).")
    for item in [*removed, *kept]:
        if not isinstance(item, dict) or not _ID_RE.fullmatch(str(item.get("adId") or "")):
            raise CollisionRepairError("The reversal file is damaged (a row without a valid adId).")
    for item in removed:
        stamp = item.get("lastModifiedAfter")
        if isinstance(stamp, bool) or not isinstance(stamp, int) or not isinstance(item.get("dataSha256"), str):
            raise CollisionRepairError(f"The reversal file is damaged ({item['adId']} without its stamp or hash).")
    _serialize(conn)
    rows = _load_ads(conn, (str(item["adId"]) for item in removed), lock=True)
    problems = []
    for item in removed:
        row = rows.get(str(item["adId"]))
        if row is None:
            problems.append(f"{item['adId']} no longer exists")
            continue
        if not bool(row["deleted"]):
            problems.append(f"{item['adId']} is not removed any more")
        elif int(row["last_modified"] or 0) != item.get("lastModifiedAfter") or _sha256(row["data_json"]) != item.get("dataSha256"):
            problems.append(f"{item['adId']} changed after the repair")
        # A restored ad is back in Manager's books: the same check and shared period lock as apply_repair,
        # taken before any write (a month being closed right now raises 409).
        if financial_period_is_closed(ADS_TYPE, _data(row), conn=conn):
            problems.append(f"{item['adId']} belongs to a closed financial month")
    state_row, state = _load_decisions(conn, lock=True) if kept else (None, {"kept": {}})
    for item in kept:
        current = state["kept"].get(str(item["adId"]))
        if not isinstance(current, dict) or current.get("repairId") != repair_id:
            problems.append(f"the keep decision for {item['adId']} changed after the repair")
    if problems:
        raise CollisionRepairError("The reversal was refused: " + "; ".join(problems) + ".")
    for item in removed:
        after = int(item["lastModifiedAfter"])
        result = conn.execute(
            text(
                "UPDATE entities SET deleted = false, last_modified = :stamp "
                "WHERE type = :type AND id = :id AND deleted = true AND last_modified = :after"
            ),
            {"type": ADS_TYPE, "id": str(item["adId"]), "after": after, "stamp": max(now_ms(), after + 1)},
        )
        if result.rowcount != 1:
            raise CollisionRepairError(f"{item['adId']} changed while the reversal ran.")
    if kept:
        for item in kept:
            if isinstance(item.get("previous"), dict):
                state["kept"][str(item["adId"])] = item["previous"]
            else:
                state["kept"].pop(str(item["adId"]), None)
        _write_decisions(conn, state_row, state)
    summary = {
        "repairId": repair_id,
        "restored": [str(item["adId"]) for item in removed],
        "keepDecisionsUndone": [str(item["adId"]) for item in kept],
    }
    _audit(conn, actor_id, ADS_TYPE, repair_id,
           f"Studio collision repair reversed: restored {len(removed)} core ads, undid {len(kept)} keep decisions",
           {**summary, "reversed": True})
    for ad_id in summary["restored"]:
        _audit(conn, actor_id, ADS_TYPE, ad_id, "Restored to Albayan Manager (collision repair reversed)",
               {"repairId": repair_id, "reversed": True})
    return summary


def create_meta_collisions_router(*, current_user_dependency: Callable[..., Any]) -> APIRouter:
    """GET /api/meta-ads/collisions: the P0-10 report for admins (counts, flags and row ids only)."""
    router = APIRouter(prefix="/api/meta-ads", tags=["meta-ads"])

    @router.get("/collisions")
    def meta_collisions(user: dict[str, Any] = Depends(current_user_dependency)):
        if str(user.get("role") or "").strip().lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        allowed, _left, retry_after_ms = check_rate_limit(
            f"meta-collisions:{user.get('id')}", REPORT_READS_PER_MINUTE, 60_000
        )
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="Too many collision report requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )
        with db_conn() as conn:
            return collision_report(conn)

    return router
