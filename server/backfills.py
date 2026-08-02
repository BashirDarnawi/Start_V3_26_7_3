"""Startup data backfills extracted from main.py (which sits at its size cap).

Both passes are idempotent, print-only, and must never fail the boot; main
injects its process-wide SQLite financial lock so single-process ordering is
identical to when this code lived inline.
"""

import threading
from contextlib import nullcontext
from typing import Any

from sqlalchemy import text

from .db import db_conn, get_engine, json_dumps, json_loads
from .operations import financial_period_is_closed

_FALLBACK_LOCK = threading.Lock()


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
    record's last_modified/_lastModified are deliberately left untouched: the
    client fetches every collection in full on load, so a limited-permission
    role picks up the stamp on its next login/refresh without a resync storm.

    Returns the number of records stamped.
    """
    stamped = 0
    try:
        with (nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else (sqlite_financial_lock or _FALLBACK_LOCK)), db_conn() as conn:
            customer_names: dict[str, str] = {}
            for row in conn.execute(
                text("SELECT id, data_json FROM entities WHERE type = 'customers'")
            ).mappings().all():
                cdata = json_loads(row.get("data_json") or "{}") or {}
                if isinstance(cdata, dict):
                    nm = cdata.get("name")
                    if isinstance(nm, str) and nm.strip():
                        customer_names[str(row["id"])] = sanitize_str(nm)[:120]
            if not customer_names:
                return 0
            for etype in ("receipts", "ads"):
                rows = conn.execute(
                    text("SELECT id, data_json FROM entities WHERE type = :t" + (" FOR UPDATE" if str(conn.engine.dialect.name or "") == "postgresql" else "")),
                    {"t": etype},
                ).mappings().all()
                for row in rows:
                    data = json_loads(row.get("data_json") or "{}") or {}
                    if not isinstance(data, dict):
                        continue
                    existing_name = data.get("customerName")
                    if isinstance(existing_name, str) and existing_name.strip():
                        continue
                    cid = sanitize_str(str(data.get("customerId") or ""))[:80]
                    if not cid:
                        continue
                    name = customer_names.get(cid)
                    if not name:
                        continue
                    if financial_period_is_closed(etype, data, conn=conn): continue
                    data["customerName"] = name
                    conn.execute(
                        text("UPDATE entities SET data_json = :d WHERE type = :t AND id = :id"),
                        {"d": json_dumps(data), "t": etype, "id": str(row["id"])},
                    )
                    stamped += 1
        if stamped:
            print(f"[albayan] Backfilled customerName on {stamped} receipts/ads")
    except Exception as e:
        print(f"[albayan] customerName backfill skipped/failed: {type(e).__name__}: {e}")
    return stamped


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
    Amounts are never changed; last_modified is left untouched (display-only
    linkage data — the delete guard re-reads rows directly). Idempotent: after
    the first pass no baseline names a non-live receipt, so it is a no-op on
    every later startup.

    Returns the number of ads repaired.
    """
    repaired = 0
    try:
        with (nullcontext() if str(get_engine().dialect.name or "") == "postgresql" else (sqlite_financial_lock or _FALLBACK_LOCK)), db_conn() as conn:
            rows = conn.execute(
                text("SELECT id, data_json FROM entities WHERE type = 'ads' AND deleted = false" + (" FOR UPDATE" if str(conn.engine.dialect.name or "") == "postgresql" else ""))
            ).mappings().all()
            for row in rows:
                data = json_loads(row.get("data_json") or "{}") or {}
                if not isinstance(data, dict):
                    continue
                if financial_period_is_closed("ads", data, conn=conn): continue
                refund_type = str(data.get("refundType") or "")
                if refund_type and refund_type != "None":
                    continue
                live_ids = {
                    str(entry.get("receiptId") or "")
                    for field in ("receiptAllocations", "dueAllocations", "mergedPaidAllocations")
                    for entry in (data.get(field) or [])
                    if isinstance(entry, dict) and entry.get("receiptId")
                }
                live_ids.discard("")
                if len(live_ids) != 1:
                    continue
                replacement = next(iter(live_ids))

                changed = False

                def _retarget(rows_value: Any) -> Any:
                    nonlocal changed
                    if not isinstance(rows_value, list):
                        return rows_value
                    out = []
                    for entry in rows_value:
                        if (
                            isinstance(entry, dict)
                            and entry.get("receiptId")
                            and str(entry["receiptId"]) != replacement
                        ):
                            changed = True
                            out.append({**entry, "receiptId": replacement})
                        else:
                            out.append(entry)
                    return out

                for baseline_name in ("refundAllocationBaseline", "refundDueBaseline"):
                    baseline = data.get(baseline_name)
                    if isinstance(baseline, list):
                        data[baseline_name] = _retarget(baseline)
                    elif isinstance(baseline, dict):
                        data[baseline_name] = {
                            key: _retarget(value) for key, value in baseline.items()
                        }
                stop_baseline = data.get("stopAllocationBaseline")
                if isinstance(stop_baseline, dict):
                    next_baseline = dict(stop_baseline)
                    for key, value in stop_baseline.items():
                        if isinstance(value, list):
                            next_baseline[key] = _retarget(value)
                    legacy_id = str(next_baseline.get("dueLegacyReceiptId") or "")
                    if legacy_id and legacy_id != replacement:
                        next_baseline["dueLegacyReceiptId"] = replacement
                        changed = True
                    data["stopAllocationBaseline"] = next_baseline
                if not changed:
                    continue
                conn.execute(
                    text("UPDATE entities SET data_json = :d WHERE type = 'ads' AND id = :id"),
                    {"d": json_dumps(data), "id": str(row["id"])},
                )
                repaired += 1
        if repaired:
            print(f"[albayan] Retargeted stale relink baselines on {repaired} ads")
    except Exception as e:
        print(f"[albayan] relink-baseline backfill skipped/failed: {type(e).__name__}: {e}")
    return repaired

