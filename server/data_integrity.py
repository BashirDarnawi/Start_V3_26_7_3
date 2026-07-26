"""Read-only production data integrity audit for Albayan's core relationships."""

from __future__ import annotations

import argparse
import json
import math
import unicodedata
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

from sqlalchemy import text

from .db import db_conn, json_loads, now_ms


def _digits(value: Any) -> str:
    result: list[str] = []
    for char in str(value or ""):
        try:
            result.append(str(unicodedata.digit(char)))
        except (TypeError, ValueError):
            continue
    return "".join(result)


def _phone_values(data: Mapping[str, Any]) -> set[str]:
    raw: list[Any] = []
    for field in ("phone", "phoneNumber"):
        if data.get(field) is not None:
            raw.append(data.get(field))
    phones = data.get("phones")
    if isinstance(phones, list):
        for phone in phones:
            if isinstance(phone, dict):
                raw.append(phone.get("value") or phone.get("number") or phone.get("phone"))
            else:
                raw.append(phone)
    normalized = {_digits(item) for item in raw}
    return {item for item in normalized if len(item) >= 7}


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
        records[entity_type][entity_id] = data
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


def scan_database(issue_limit: int = 200) -> dict[str, Any]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT type, id, data_json, deleted FROM entities")
        ).mappings().all()
    return scan_entity_rows(rows, issue_limit=issue_limit)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Albayan production data audit")
    parser.add_argument("--issue-limit", type=int, default=200)
    args = parser.parse_args()
    result = scan_database(issue_limit=max(1, min(args.issue_limit, 1000)))
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
