"""Startup data backfills extracted from main.py (which sits at its size cap).

The passes are idempotent, report their changes, and must never fail the boot; main
injects its process-wide SQLite financial lock so single-process ordering is
identical to when this code lived inline.
"""

import threading
from contextlib import nullcontext
from typing import Any

from sqlalchemy import text

from .db import db_conn, get_engine, json_dumps, json_loads, now_ms
from .operations import financial_period_is_closed
from .startup_financial_scan import active_row_batches

_FALLBACK_LOCK = threading.Lock()
_BACKFILL_SCAN_BATCH_SIZE = 128


def _row_batches(conn: Any, collection: str):
    yield from active_row_batches(
        conn,
        collection,
        dialect=str(conn.engine.dialect.name or ""),
        batch_size=_BACKFILL_SCAN_BATCH_SIZE,
        include_deleted=True,
    )


def _lock_full_row(conn: Any, collection: str, entity_id: str) -> Any | None:
    postgres = str(conn.engine.dialect.name or "") == "postgresql"
    return conn.execute(
        text(
            "SELECT id,data_json,deleted,last_modified FROM entities WHERE type=:type AND id=:id"
            + (" FOR UPDATE" if postgres else "")
        ),
        {"type": collection, "id": entity_id},
    ).mappings().first()


def _save_backfill_row(conn: Any, collection: str, row: Any, data: dict[str, Any]) -> None:
    """Publish a locked repair to delta sync without altering creation history."""
    baseline = int(row["last_modified"])
    modified = max(now_ms(), baseline + 1)
    updated = {**data, "_lastModified": modified}
    result = conn.execute(
        text(
            "UPDATE entities SET data_json=:data,last_modified=:modified "
            "WHERE type=:type AND id=:id AND last_modified=:baseline"
        ),
        {"data": json_dumps(updated), "modified": modified, "type": collection,
         "id": str(row["id"]), "baseline": baseline},
    )
    if result.rowcount != 1:
        raise RuntimeError("Backfill row changed concurrently; retry on next startup")


def sanitize_str(value, max_length: int = 10000) -> str:
    """Faithful copy of main.sanitize_str (importing it would be circular)."""
    s = str(value or "").replace("\x00", "").strip()
    if len(s) > max_length:
        s = s[:max_length]
    s = s.replace("<", "").replace(">", "")
    s_low = s.lower()
    if s_low.startswith("javascript:") or s_low.startswith("vbscript:"):
        return ""
    return s


def backfill_customer_names(sqlite_financial_lock=None) -> int:
    """Stamp customerName on legacy receipts/ads that predate the denormalization.

    Records created before customerName existed still render as "Unknown" for a
    role that can view receipts/ads but not load the customers collection. This
    one-time-safe pass fills that gap from the authoritative customers table.

    Idempotent — it only touches a record that (a) is a receipt/ad, (b) has a
    customerId, (c) lacks a usable customerName, and (d) whose customer resolves
    to a name — so it is a no-op on every startup after the first and safe to run
    unconditionally. Only the NAME is copied; phone/contact are never read. The
    record's modification cursor advances only when it changes, so already-open
    clients receive the corrected old record through ordinary delta sync.

    Returns the number of records stamped.
    """
    stamped = 0
    try:
        with (nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else (sqlite_financial_lock or _FALLBACK_LOCK)), db_conn() as conn:
            customer_names: dict[str, str] = {}
            for batch in _row_batches(conn, "customers"):
                for row in batch:
                    cdata = json_loads(row.get("data_json") or "{}") or {}
                    if isinstance(cdata, dict):
                        nm = cdata.get("name")
                        if isinstance(nm, str) and nm.strip():
                            customer_names[str(row["id"])] = sanitize_str(nm)[:120]
            if not customer_names:
                return 0
            for etype in ("receipts", "ads"):
                for batch in _row_batches(conn, etype):
                    for discovery_row in batch:
                        discovery = json_loads(discovery_row.get("data_json") or "{}") or {}
                        if not isinstance(discovery, dict):
                            continue
                        existing_name = discovery.get("customerName")
                        if isinstance(existing_name, str) and existing_name.strip():
                            continue
                        cid = sanitize_str(str(discovery.get("customerId") or ""))[:80]
                        if not cid or cid not in customer_names:
                            continue

                        # The discovery row has inline media stripped. Re-read
                        # only a genuine candidate under the original lock and
                        # recheck it before writing, so photos are never erased.
                        row = _lock_full_row(conn, etype, str(discovery_row["id"]))
                        if not row:
                            continue
                        data = json_loads(row.get("data_json") or "{}") or {}
                        if not isinstance(data, dict):
                            continue
                        existing_name = data.get("customerName")
                        if isinstance(existing_name, str) and existing_name.strip():
                            continue
                        cid = sanitize_str(str(data.get("customerId") or ""))[:80]
                        name = customer_names.get(cid)
                        if not name or financial_period_is_closed(etype, data, conn=conn):
                            continue
                        data["customerName"] = name
                        _save_backfill_row(conn, etype, row, data)
                        stamped += 1
        if stamped:
            print(f"[albayan] Backfilled customerName on {stamped} receipts/ads")
    except Exception as e:
        print(f"[albayan] customerName backfill skipped/failed: {type(e).__name__}: {e}")
    return stamped


def backfill_covered_settled_receipts(sqlite_financial_lock=None) -> int:
    """Normalize covered receipts settled BEFORE the coverage-aware settle.

    The old settle path left a company-covered receipt's amountUSD at the
    GROSS debt. Under the new capacity rule (paid capacity = amountUSD +
    companyCoveredUSD) that shape double-counts the covered dollars as
    spendable credit, and customer "Paid" totals overstate by the same
    amount. Exactly that legacy shape — and only it — is detectable:
    a Paid receipt whose customerOutstandingUSD is still positive (every
    coverage write sets it; every NEW settle zeroes it).

    Idempotent: the write zeroes customerOutstandingUSD, so a record can
    never qualify twice. Returns the number of receipts normalized.
    """
    fixed = 0
    try:
        with (nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else (sqlite_financial_lock or _FALLBACK_LOCK)), db_conn() as conn:
            for batch in _row_batches(conn, "receipts"):
                for discovery_row in batch:
                    discovery = json_loads(discovery_row.get("data_json") or "{}") or {}
                    if not isinstance(discovery, dict):
                        continue
                    if not (
                        bool(discovery.get("isPaid"))
                        or str(discovery.get("status") or "") == "Paid"
                    ):
                        continue
                    try:
                        covered = float(discovery.get("companyCoveredUSD") or 0)
                        outstanding = float(discovery.get("customerOutstandingUSD") or 0)
                    except (TypeError, ValueError):
                        continue
                    if covered <= 0.005 or outstanding <= 0.005:
                        continue

                    row = _lock_full_row(conn, "receipts", str(discovery_row["id"]))
                    if not row:
                        continue
                    data = json_loads(row.get("data_json") or "{}") or {}
                    if not isinstance(data, dict):
                        continue
                    if not (
                        bool(data.get("isPaid"))
                        or str(data.get("status") or "") == "Paid"
                    ):
                        continue
                    try:
                        covered = float(data.get("companyCoveredUSD") or 0)
                        outstanding = float(data.get("customerOutstandingUSD") or 0)
                        amount_usd = float(data.get("amountUSD") or 0)
                        amount_local = float(data.get("amountLocal") or 0)
                    except (TypeError, ValueError):
                        continue
                    if covered <= 0.005 or outstanding <= 0.005:
                        continue
                    if financial_period_is_closed("receipts", data, conn=conn):
                        continue

                    new_amount = max(round((amount_usd - covered) * 100) / 100, 0.0)
                    if amount_usd > 0 and amount_local > 0:
                        data["amountLocal"] = round(
                            amount_local * (new_amount / amount_usd) * 100
                        ) / 100
                    data["amountUSD"] = new_amount
                    data["customerOutstandingUSD"] = 0.0
                    _save_backfill_row(conn, "receipts", row, data)
                    fixed += 1
        if fixed:
            print(f"[albayan] Normalized {fixed} covered receipt(s) settled before the coverage-aware settle")
    except Exception as e:
        print(f"[albayan] covered-settled backfill skipped/failed: {type(e).__name__}: {e}")
    return fixed


def _retarget_relink_data(data: dict[str, Any]) -> bool:
    refund_type = str(data.get("refundType") or "")
    if refund_type and refund_type != "None":
        return False
    live_ids = {
        str(entry.get("receiptId") or "")
        for field in ("receiptAllocations", "dueAllocations", "mergedPaidAllocations")
        for entry in (data.get(field) or [])
        if isinstance(entry, dict) and entry.get("receiptId")
    }
    live_ids.discard("")
    if len(live_ids) != 1:
        return False
    replacement = next(iter(live_ids))
    changed = False

    def retarget(rows_value: Any) -> Any:
        nonlocal changed
        if not isinstance(rows_value, list):
            return rows_value
        result = []
        for entry in rows_value:
            if (
                isinstance(entry, dict)
                and entry.get("receiptId")
                and str(entry["receiptId"]) != replacement
            ):
                changed = True
                result.append({**entry, "receiptId": replacement})
            else:
                result.append(entry)
        return result

    for baseline_name in ("refundAllocationBaseline", "refundDueBaseline"):
        baseline = data.get(baseline_name)
        if isinstance(baseline, list):
            data[baseline_name] = retarget(baseline)
        elif isinstance(baseline, dict):
            data[baseline_name] = {
                key: retarget(value) for key, value in baseline.items()
            }
    stop_baseline = data.get("stopAllocationBaseline")
    if isinstance(stop_baseline, dict):
        next_baseline = dict(stop_baseline)
        for key, value in stop_baseline.items():
            if isinstance(value, list):
                next_baseline[key] = retarget(value)
        legacy_id = str(next_baseline.get("dueLegacyReceiptId") or "")
        if legacy_id and legacy_id != replacement:
            next_baseline["dueLegacyReceiptId"] = replacement
            changed = True
        data["stopAllocationBaseline"] = next_baseline
    return changed


def backfill_relink_baselines(sqlite_financial_lock=None) -> int:
    """Retarget stale stop/refund baselines left by pre-retarget relinks.

    Ads settled/relinked before the baseline-retarget shipped still carry
    stop/refund baselines naming the VACATED receipt. _financial_receipt_ids
    counts baselines as live links, so those fully-freed receipts could never
    be deleted ("linked to ad funding"). Repair rule — deliberately narrow and
    unambiguous, mirroring _financial_apply_relink's own retarget:
      (a) the ad has no active refund (refundType empty/None — refund undo
          restores from baselines, so refunded ads keep theirs untouched), and
      (b) its LIVE allocations reference exactly ONE receipt R, and
      (c) a baseline names some other receipt X != R  ->  rewrite X to R.
    Amounts are never changed; modification cursors advance so open clients
    receive repaired linkage metadata. Idempotent: after
    the first pass no baseline names a non-live receipt, so it is a no-op on
    every later startup.

    Returns the number of ads repaired.
    """
    repaired = 0
    try:
        with (nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else (sqlite_financial_lock or _FALLBACK_LOCK)), db_conn() as conn:
            for batch in _row_batches(conn, "ads"):
                for discovery_row in batch:
                    discovery = json_loads(discovery_row.get("data_json") or "{}") or {}
                    if not isinstance(discovery, dict) or not _retarget_relink_data(discovery):
                        continue

                    # Discovery is media-free. Lock and recompute against the
                    # one authoritative full row before persisting a change.
                    row = _lock_full_row(conn, "ads", str(discovery_row["id"]))
                    if not row or bool(row.get("deleted")):
                        continue
                    data = json_loads(row.get("data_json") or "{}") or {}
                    if not isinstance(data, dict):
                        continue
                    if not _retarget_relink_data(data):
                        continue
                    if financial_period_is_closed("ads", data, conn=conn):
                        continue
                    _save_backfill_row(conn, "ads", row, data)
                    repaired += 1
        if repaired:
            print(f"[albayan] Retargeted stale relink baselines on {repaired} ads")
    except Exception as e:
        print(f"[albayan] relink-baseline backfill skipped/failed: {type(e).__name__}: {e}")
    return repaired
