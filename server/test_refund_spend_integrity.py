"""Refunding a STOPPED ad must work from what it spent, not its budget.

Both bugs pinned here inflate recorded spend, and recorded spend is what
settlement draws from the funding receipt and what FIFO consumes dollar lots
against — so an inflated number spends money that never existed.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server.main import _financial_apply_refund

ACTOR = {"id": "user_test_admin", "role": "Admin"}


def _stopped_ad():
    """$100 budget, stopped after spending $10 of receipt R."""
    return {
        "id": "ad_refund_probe",
        "amountUSD": 100.0,
        "status": "Stopped",
        "spentUSD": 10.0,
        "paymentStatus": "paid",
        "isPaid": True,
        "receiptAllocations": [{"receiptId": "receipt_R", "amountUSD": 10.0}],
        "dueAllocations": [],
        "exchangeRate": 5.0,
    }


def test_partial_refund_of_a_stopped_ad_cannot_inflate_spend():
    existing = _stopped_ad()
    # Refunding $8 of the $10 actually spent leaves $2 of spend.
    result = _financial_apply_refund(ACTOR, {"refundType": "Partial", "refundAmount": 8}, existing)
    assert float(result["spentUSD"]) == 2.0, (
        f"spend was recomputed from the budget, not the real spend: {result['spentUSD']}"
    )


def test_refund_cannot_exceed_what_the_stopped_ad_actually_spent():
    existing = _stopped_ad()
    try:
        _financial_apply_refund(ACTOR, {"refundType": "Partial", "refundAmount": 20}, existing)
    except Exception as error:  # HTTPException
        assert "exceeds" in str(getattr(error, "detail", error)).lower()
    else:
        raise AssertionError("a refund larger than the ad's real spend was accepted")


def test_full_refund_of_a_stopped_ad_returns_only_the_spend():
    existing = _stopped_ad()
    result = _financial_apply_refund(ACTOR, {"refundType": "Full"}, existing)
    assert float(result["refundAmount"]) == 10.0, "Full refund returned the budget, not the spend"
    assert float(result["spentUSD"]) == 0.0


def test_undo_restores_the_pre_refund_spend_instead_of_deleting_it():
    existing = _stopped_ad()
    refunded = _financial_apply_refund(ACTOR, {"refundType": "Partial", "refundAmount": 5}, existing)
    assert refunded.get("preRefundSpentUSD") is not None, "pre-refund spend was not remembered"

    undone = _financial_apply_refund(ACTOR, {"refundType": "None"}, refunded)
    assert undone["status"] == "Stopped", "undo lost the stopped status"
    assert float(undone.get("spentUSD") or 0) == 10.0, (
        "undo dropped the stop's spend, so the ad reads as having spent its whole budget"
    )


def test_a_never_stopped_ad_still_refunds_against_its_full_amount():
    """The common case must be unchanged."""
    active = {
        "id": "ad_active_probe",
        "amountUSD": 100.0,
        "status": "Active",
        "paymentStatus": "paid",
        "isPaid": True,
        "receiptAllocations": [{"receiptId": "receipt_R", "amountUSD": 100.0}],
        "dueAllocations": [],
        "exchangeRate": 5.0,
    }
    result = _financial_apply_refund(ACTOR, {"refundType": "Full"}, active)
    assert float(result["refundAmount"]) == 100.0
    assert float(result["spentUSD"]) == 0.0
