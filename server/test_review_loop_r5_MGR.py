"""Review loop round 5, batch MGR: Manager money screens and Arabic texts.

The MGR fixes are client-side (see scripts/test-review-regressions.js, "r5 MGR").
These tests pin the server facts those fixes rely on, so a server change that
would silently break them fails here:

* n=11 the delivery completion keeps the EXACT collection target: a debt of
       107.25 LYD paid with 107 is UNDERPAID by 0.25 and stays Not Paid. The
       client must therefore show 2 decimals (it used to show "107" and
       "remaining 0 LYD").
* n=13/14/17 every server refusal text the Manager's bilingual refusal map
       translates still matches one of its rules (closed month 423, duplicate
       receipt numbers, ad stop company funding).

No database rows are created.
"""

import re
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from server.settlement_truth import apply_delivery_completion_truth

ROOT = Path(__file__).parent.parent


def _complete(target_local_minor: int, target_usd_minor: int, collected_lyd: float) -> dict:
    old = {"deliveryStatus": "In Progress", "status": "Not Paid", "isPaid": False, "exchangeRate": 7.15}
    merged = dict(old, deliveryStatus="Delivered", amountCollectedFromCustomer=collected_lyd)
    apply_delivery_completion_truth(
        "r5mgr-receipt",
        old,
        merged,
        [],
        delivery_collection_target=lambda receipt_id, row, ads: {
            "usdMinor": target_usd_minor,
            "localMinor": target_local_minor,
            "source": "receipt_amount",
        },
        valid_rate=lambda value: Decimal(str(value)) if value else None,
        overpay_abs_local=50.0,
        overpay_ratio=1.5,
    )
    return merged


def test_n11_a_quarter_dinar_short_is_underpaid_and_keeps_its_exact_remaining():
    merged = _complete(10725, 1500, 107)  # $15 x 7.15 = 107.25 LYD, driver typed the rounded 107
    assert merged["paymentResult"] == "UNDERPAID"
    assert merged["remainingDue"] == 0.25
    assert merged["status"] == "Not Paid" and merged["isPaid"] is False
    assert 0 < merged["customerOutstandingUSD"] < 0.1


def test_n11_the_exact_fractional_amount_settles_the_delivery():
    merged = _complete(10725, 1500, 107.25)
    assert merged["paymentResult"] == "PAID_EXACT"
    assert merged["remainingDue"] == 0
    assert merged["status"] == "Paid" and merged["isPaid"] is True


def _client_refusal_rules() -> list[tuple[str, str]]:
    """(kind, pattern) for every rule in the Manager map _SERVER_REFUSAL_AR."""
    source = (ROOT / "src" / "08-data-audit.js").read_text(encoding="utf-8")
    block = source.split("const _SERVER_REFUSAL_AR = [", 1)[1].split("\n];", 1)[0]
    rules = []
    for line in block.splitlines():
        line = line.strip()
        regex = re.match(r"^\[/(.+?)/, '", line)
        if regex:
            rules.append(("regex", regex.group(1)))
            continue
        prefix = re.match(r"""^\[(['"])(.+?)\1, '""", line)
        if prefix:
            rules.append(("prefix", prefix.group(2)))
    return rules


def _translated(detail: str, rules: list[tuple[str, str]]) -> bool:
    for kind, pattern in rules:
        if kind == "prefix" and detail.startswith(pattern):
            return True
        if kind == "regex" and re.search(pattern, detail):
            return True
    return False


def test_n13_n14_n17_server_refusals_the_manager_translates_still_match_its_rules():
    rules = _client_refusal_rules()
    assert len(rules) >= 17, rules
    operations_src = (ROOT / "server" / "operations.py").read_text(encoding="utf-8")
    main_src = (ROOT / "server" / "main.py").read_text(encoding="utf-8")
    period = "2026-08"
    closed = re.search(r'detail=f"(Financial period \{period\} is closed[^"]*)"', operations_src)
    busy = re.search(r'detail=f"(Financial period \{period\} is being closed[^"]*)"', operations_src)
    assert closed and busy, "the closed-month refusal texts moved; update _SERVER_REFUSAL_AR"
    details = [closed.group(1).replace("{period}", period), busy.group(1).replace("{period}", period)]
    for text in ("serialNumber already exists", "finalReceiptNo already exists", "tempReceiptNo already exists",
                 "Receipt number already exists",
                 "Final spend cannot be less than recorded company funding; reconcile company coverage separately first",
                 "Spent amount exceeds the ad's funding baseline"):
        assert f'"{text}"' in main_src, f"server text changed: {text}"
        details.append(text)
    missing = [detail for detail in details if not _translated(detail, rules)]
    assert not missing, missing
    # The two closed-month texts must hit DIFFERENT rules (closed vs. busy retry).
    closed_rule = [p for k, p in rules if k == "regex" and re.search(p, details[0])]
    busy_rule = [p for k, p in rules if k == "regex" and re.search(p, details[1])]
    assert closed_rule and busy_rule and closed_rule != busy_rule
