"""Automatic receipt numbers (S/B/O/E): the server issues the next free one when the app's is taken.

The app proposes the next number from the receipts it can SEE (getNextAutoSerialNumber in
src/14-forms.js), and the number box is read-only for these methods. An account that sees only its
own receipts proposes S1 while S1..S3 exist, so its save was refused (409) every time. When EVERY
payment method of the receipt is auto-numbered and the number it asks for, from one of its groups,
is taken, the server writes that group's next free number instead. Paper numbers (digits), Cash or
mixed receipts and destroyed receipts keep the 409. Kept out of main.py, which sits near its line cap.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from sqlalchemy import text

from .db import json_loads_or_raw

# Must mirror AUTO_SERIAL_GROUPS in src/14-forms.js.
AUTO_SERIAL_GROUPS: dict[str, tuple[str, ...]] = {
    "S": ("LTT", "Libyana", "Madar"),
    "B": ("Bank Transfer (LYD)", "Bank Transfer (USD)", "Bank Transfer"),
    "O": ("Transfer Office",),
    "E": ("Sadad", "USDT"),
}
_GROUP_OF = {method: prefix for prefix, methods in AUTO_SERIAL_GROUPS.items() for method in methods}
_NUMBER_FIELDS = ("serialNumber", "finalReceiptNo", "tempReceiptNo")
SCAN_FIELDS = ("paymentMethod", "payments", "status")  # read with the number fields, never the photos


def payment_methods(data: Any) -> list[str]:
    """The methods as the form reads them: the payments[] rows, else paymentMethod."""
    source = data if isinstance(data, dict) else {}
    rows = json_loads_or_raw(source.get("payments"))
    if isinstance(rows, list) and rows:
        return [str(row.get("method")).strip() for row in rows if isinstance(row, dict) and row.get("method")]
    method = str(source.get("paymentMethod") or "").strip()
    return [method] if method and method != "Split Payment" else []


def reissuable_prefix(data: Any, serial: str) -> str:
    """The group of ``serial`` (canonical) when the server may re-issue it for this receipt: every
    payment method is auto-numbered and the number belongs to one of their groups. Else ''."""
    source = data if isinstance(data, dict) else {}
    methods = payment_methods(source)
    groups = {_GROUP_OF.get(method) for method in methods}
    match = re.fullmatch(r"([SBOE])[1-9][0-9]*", serial or "")
    if not methods or None in groups or not match or match.group(1) not in groups:
        return ""
    return "" if str(source.get("status") or "").strip().lower() == "destroyed" else match.group(1)


def _legacy_s_digits(row: dict[str, Any]) -> bool:
    """getNextAutoSerialNumber's legacy branch: bare digits on a live receipt paid by an S method and no
    manual one (the S group used plain numbers before the prefix existed)."""
    if str(row.get("f_status") or "") == "Destroyed":
        return False
    methods = payment_methods({"paymentMethod": row.get("f_paymentmethod"), "payments": row.get("f_payments")})
    groups = {_GROUP_OF.get(method) for method in methods}
    used = groups | {_GROUP_OF.get(str(row.get("f_paymentmethod") or "").strip())}
    return bool(methods) and None not in groups and "S" in used


def issue_free_auto_serial(
    conn: Any,
    receipt_id: str,
    data: dict[str, Any],
    old_keys: set[str],
    canonical: Callable[[Any], str],
    *,
    scan_sql: str,
    lock: Callable[[str], None],
) -> None:
    """When ``data`` asks for a taken number it may re-issue (above), write that group's next free
    number to serialNumber, and to finalReceiptNo when that was the same number or empty.

    Runs in the caller's transaction, before its authoritative uniqueness check. ``scan_sql`` reads
    every other live receipt's number fields and SCAN_FIELDS (bound :receipt_id). ``lock`` takes the
    group's PostgreSQL advisory lock, so two devices never get the same number; SQLite callers hold
    the process-wide receipt-number guard. A number this receipt already had is never re-issued.
    """
    serial = canonical(data.get("serialNumber"))
    prefix = reissuable_prefix(data, serial)
    if not prefix or serial in old_keys:
        return
    lock(f"{prefix}*")
    taken, highest = False, 0
    for row in conn.execute(text(scan_sql), {"receipt_id": receipt_id}).mappings().all():
        keys = {canonical(row.get(f"f_{field.lower()}")) for field in _NUMBER_FIELDS} - {""}
        taken = taken or serial in keys
        numbers = [int(key[1:]) for key in keys if re.fullmatch(prefix + r"[0-9]+", key)]
        own_serial = canonical(row.get("f_serialnumber"))
        if prefix == "S" and re.fullmatch(r"[0-9]+", own_serial) and _legacy_s_digits(row):
            numbers.append(int(own_serial))
        highest = max([highest, *numbers])
    if not taken:
        return
    issued = f"{prefix}{highest + 1}"
    if canonical(data.get("finalReceiptNo")) in {"", serial}:
        data["finalReceiptNo"] = issued
    data["serialNumber"] = issued
