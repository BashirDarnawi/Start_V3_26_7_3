"""Receipt payment rows must hold plain values (defence in depth against stored XSS).

The receipt forms put each payment row's amount, rates, method and collection
type inside HTML attributes. ``sanitize_str`` already drops ``<`` and ``>``, but
a quote still closes the attribute, so a staff account with only "Create
receipts" could plant an event handler that ran in an admin's session when the
receipt was opened for editing. Older app builds on phones render these values
unescaped, so the server refuses them.

This only validates: values are never coerced, rounded or clamped, so no stored
amount or rate changes.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

PAYMENT_ROW_FIELDS = ("payments", "plannedPayments", "collectedPayments", "deliveryFeePayments")
_NUMERIC_TEXT = re.compile(r"-?[0-9]+(?:[.][0-9]+)?")
_QUOTES = frozenset("\"'`\\")


def _plain_number(value: Any) -> bool:
    if value is None or value == "":
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    return isinstance(value, str) and _NUMERIC_TEXT.fullmatch(value) is not None


def _plain_label(value: Any) -> bool:
    return not isinstance(value, str) or not _QUOTES.intersection(value)


def validate_receipt_payment_rows(data: Any) -> None:
    """Answer 400 when a payment row value could break out of an HTML attribute."""
    if not isinstance(data, dict):
        return
    plain = _plain_label(data.get("paymentMethod"))
    for field in PAYMENT_ROW_FIELDS:
        rows = data.get(field)
        for row in rows if isinstance(rows, list) else ():
            if isinstance(row, dict):
                plain = plain and all(_plain_number(row.get(key)) for key in ("amount", "rate", "rate2"))
                plain = plain and all(_plain_label(row.get(key)) for key in ("method", "collectionType"))
    if not plain:
        raise HTTPException(status_code=400, detail="Invalid payment row")
