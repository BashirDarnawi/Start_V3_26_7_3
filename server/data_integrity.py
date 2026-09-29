"""Read-only production data integrity audit for Albayan's core relationships."""

from __future__ import annotations

import argparse
import json
import math
import unicodedata
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Iterator, Mapping

from sqlalchemy import text

from .db import db_conn, json_loads, now_ms
from .entity_projection import _inline_media_sql_projection

# Live rows are read in bounded keyset pages with inline photos stripped by the
# database, and only the fields the relationship checks read are kept: the
# scan never holds every record (or a single base64 photo) in memory.
_SCAN_PAGE_SIZE = 200
_CHECKED_FIELDS: dict[str, tuple[str, ...]] = {
    "customers": ("phone", "phoneNumber", "phones"),
    "receipts": ("customerId", "serialNumber", "finalReceiptNo", "tempReceiptNo", "exchangeRate", "rate"),
    "ads": (
        "customerId", "receiptId", "mergedReceiptId", "dueReceiptId", "receiptAllocations",
        "dueAllocations", "mergedPaidAllocations", "exchangeRate", "rate",
    ),
}


def _phone_values(data: Mapping[str, Any]) -> set[str]:
    # The server's own identity key: 0912345678 and +218 91 234 5678 are one
    # customer here too, as for the create route and the merge tool.
    from .main import _customer_phone_keys

    return _customer_phone_keys(dict(data))


def _receipt_numbers(data: Mapping[str, Any]) -> set[str]:
    def canonical(value: Any) -> str:
        normalized = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
        converted: list[str] = []
        for char in normalized:
            try:
                converted.append(str(unicodedata.digit(char)))
            except (TypeError, ValueError):
                converted.append(char)
        return "".join(converted)[:80]

    return {
        normalized
        for field in ("serialNumber", "finalReceiptNo", "tempReceiptNo")
        if (normalized := canonical(data.get(field)))
    }


def _live_ad_receipt_ids(data: Mapping[str, Any]) -> set[str]:
    ids = {
        str(data.get(field) or "").strip()
        for field in ("receiptId", "mergedReceiptId", "dueReceiptId")
    }
    for field in ("receiptAllocations", "dueAllocations", "mergedPaidAllocations"):
        values = data.get(field)
        if not isinstance(values, list):
            continue
        for item in values:
            if isinstance(item, dict):
                ids.add(str(item.get("receiptId") or "").strip())
    ids.discard("")
    return ids


def _has_non_finite_number(value: Any) -> bool:
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(_has_non_finite_number(child) for child in value.values())
    if isinstance(value, list):
        return any(_has_non_finite_number(child) for child in value)
    return False


def _positive_decimal_if_present(data: Mapping[str, Any], field: str) -> bool:
    value = data.get(field)
    if value in (None, ""):
        return True
    try:
        return Decimal(str(value)).is_finite() and Decimal(str(value)) > 0
    except (InvalidOperation, ValueError):
        return False


def scan_entity_rows(rows: Iterable[Mapping[str, Any]], issue_limit: int = 200) -> dict[str, Any]:
    records: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    type_counts: Counter[str] = Counter()
    issues: list[dict[str, Any]] = []
    severity_counts: Counter[str] = Counter()
    total_issues = 0

    def issue(severity: str, code: str, entity_type: str, entity_id: str, message: str) -> None:
        nonlocal total_issues
        total_issues += 1
        severity_counts[severity] += 1
        if len(issues) < issue_limit:
            issues.append(
                {
                    "severity": severity,
                    "code": code,
                    "entityType": entity_type,
                    "entityId": entity_id,
                    "message": message,
                }
            )

    for row in rows:
        entity_type = str(row.get("type") or "")
        entity_id = str(row.get("id") or "")
        if bool(row.get("deleted")):
            continue
        type_counts[entity_type] += 1
        try:
            data = json_loads(row.get("data_json") or "{}") or {}
        except Exception:
            issue("error", "invalid_json", entity_type, entity_id, "Record data is not valid JSON")
            continue
        if not isinstance(data, dict):
            issue("error", "invalid_shape", entity_type, entity_id, "Record data must be a JSON object")
            continue
        kept = _CHECKED_FIELDS.get(entity_type)
        if kept is not None:
            records[entity_type][entity_id] = {field: data[field] for field in kept if field in data}
        if _has_non_finite_number(data):
            issue("error", "non_finite_number", entity_type, entity_id, "Record contains NaN or an infinite number")

    phone_owners: dict[str, set[str]] = defaultdict(set)
    for customer_id, data in records.get("customers", {}).items():
        for phone in _phone_values(data):
            phone_owners[phone].add(customer_id)
    for owners in phone_owners.values():
        if len(owners) > 1:
            for customer_id in sorted(owners):
                issue(
                    "error",
                    "duplicate_customer_phone",
                    "customers",
                    customer_id,
                    f"Phone is shared by {len(owners)} active customer records",
                )

    receipt_number_owners: dict[str, set[str]] = defaultdict(set)
    receipts = records.get("receipts", {})
    customers = records.get("customers", {})
    for receipt_id, data in receipts.items():
        for number in _receipt_numbers(data):
            receipt_number_owners[number].add(receipt_id)
        customer_id = str(data.get("customerId") or "").strip()
        if customer_id and customer_id not in customers:
            issue("error", "missing_customer", "receipts", receipt_id, "Receipt references a missing active customer")
        for rate_field in ("exchangeRate", "rate"):
            if not _positive_decimal_if_present(data, rate_field):
                issue("error", "invalid_exchange_rate", "receipts", receipt_id, f"{rate_field} must be greater than zero")
    for owners in receipt_number_owners.values():
        if len(owners) > 1:
            for receipt_id in sorted(owners):
                issue(
                    "error",
                    "duplicate_receipt_number",
                    "receipts",
                    receipt_id,
                    f"Receipt number is shared by {len(owners)} active receipts",
                )

    for ad_id, data in records.get("ads", {}).items():
        customer_id = str(data.get("customerId") or "").strip()
        if customer_id and customer_id not in customers:
            issue("error", "missing_customer", "ads", ad_id, "Ad references a missing active customer")
        for receipt_id in _live_ad_receipt_ids(data):
            if receipt_id not in receipts:
                issue("error", "missing_receipt", "ads", ad_id, "Ad funding references a missing active receipt")
        for rate_field in ("exchangeRate", "rate"):
            if not _positive_decimal_if_present(data, rate_field):
                issue("error", "invalid_exchange_rate", "ads", ad_id, f"{rate_field} must be greater than zero")

    # Account for issues beyond the returned detail limit.
    hidden_count = max(0, total_issues - len(issues))
    return {
        "ok": total_issues == 0,
        "checkedAt": now_ms(),
        "recordsChecked": sum(type_counts.values()),
        "recordCounts": dict(sorted(type_counts.items())),
        "issueCount": total_issues,
        "returnedIssueCount": len(issues),
        "hiddenIssueCount": hidden_count,
        "severityCounts": dict(severity_counts),
        "issues": issues,
    }


def _live_entity_rows(page_size: int = _SCAN_PAGE_SIZE) -> Iterator[dict[str, Any]]:
    """Yield live rows type by type, one keyset page per short transaction.

    A row the database cannot strip (text that is not valid JSON, or a NaN a
    PostgreSQL jsonb cast refuses) fails its page; the scan then steps one
    row at a time and reads only that row unstripped, so it is still reported
    as invalid_json / non_finite_number instead of failing the whole scan.
    """
    with db_conn() as conn:
        dialect = str(conn.engine.dialect.name or "")
        types = sorted(str(row[0]) for row in conn.execute(text("SELECT DISTINCT type FROM entities WHERE deleted=false")))
    for entity_type in types:
        projection = _inline_media_sql_projection(entity_type, dialect)
        stripped = projection[0] if projection else "data_json"
        after_id, mode = "", "page"  # page -> one (stripped) -> raw after a failed read
        while True:
            expression = "data_json" if mode == "raw" else stripped
            limit = page_size if mode == "page" else 1
            try:
                with db_conn() as conn:
                    page = conn.execute(
                        text(
                            f"SELECT id, {expression} AS data_json FROM entities "
                            "WHERE type=:type AND deleted=false AND id>:after_id ORDER BY id LIMIT :limit"
                        ),
                        {"type": entity_type, "after_id": after_id, "limit": limit},
                    ).mappings().all()
            except Exception:
                if expression == "data_json":
                    raise
                mode = "one" if mode == "page" else "raw"
                continue
            for row in page:
                yield {"type": entity_type, "id": row["id"], "data_json": row["data_json"], "deleted": False}
            if not page or (mode == "page" and len(page) < limit):
                break
            after_id, mode = str(page[-1]["id"]), "page"


def scan_database(issue_limit: int = 200) -> dict[str, Any]:
    return scan_entity_rows(_live_entity_rows(), issue_limit=issue_limit)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Albayan production data audit")
    parser.add_argument("--issue-limit", type=int, default=200)
    args = parser.parse_args()
    result = scan_database(issue_limit=max(1, min(args.issue_limit, 1000)))
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
