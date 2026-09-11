"""Financial lifecycle regressions from the September deep review.

Uses only the existing test fixtures. Run via scripts/test-backend.js (isolated
SQLite), or the explicitly guarded PostgreSQL scenario runner.
"""
import pytest
from fastapi import HTTPException

from server import test_receipt_company_coverages as t
from server.main import _financial_apply_refund, _financial_apply_stop, _financial_apply_relink
from server.company_debt_coverage import plan_company_debt_coverage
from server.settlement_truth import apply_coverage_settlement_truth
from server.main import _financial_due_total


@pytest.fixture(scope="module")
def actors():
    return t.actors.__wrapped__()


def _update(ad, data, key, actors):
    return t.client.post("/api/ads/mutate", json={
        "action": "update", "adId": ad["id"], "idempotencyKey": key,
        "expectedLastModified": ad["lastModified"], "data": data,
    }, cookies=actors["admin"])


def _setup(tag, actors, amount=200):
    cid, rid, aid = tag + "_c", tag + "_r", tag + "_a"
    t._customer(cid, actors)
    receipt = t._unpaid_receipt(rid, cid, amount, actors)
    ad = t._create_ad(aid, cid, rid, 100, actors)
    return cid, rid, aid, receipt, ad


def _funded_minor(ad):
    return sum(round(row["amountUSD"] * 100) for key in (
        "receiptAllocations", "dueAllocations", "companyFundingAllocations"
    ) for row in ad.get(key, []))


@pytest.mark.parametrize("covered", [20, 40, 60])
@pytest.mark.parametrize("stop_first", [False, True])
@pytest.mark.parametrize("settle_before_undo", [False, True])
def test_refund_cover_undo_conserves_funding(actors, covered, stop_first, settle_before_undo):
    tag = f"lifecycle_undo_{covered}_{int(stop_first)}_{int(settle_before_undo)}"
    cid, rid, aid, receipt, ad = _setup(tag, actors)
    spend = 80 if stop_first else 100
    if stop_first:
        result = t._stop(aid, spend * 100, tag + "_stop", ad["lastModified"], actors["admin"])
        assert result.status_code == 200, result.text
        ad = result.json()["ad"]
    result = _update(ad, {"refundType": "Partial", "refundAmount": 20}, tag + "_refund", actors)
    assert result.status_code == 200, result.text
    result = t._cover(rid, covered * 100, tag + "_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    ad = result.json()["updatedAds"][0]
    receipt = result.json()["updatedReceipts"][0]
    assert _funded_minor(ad["data"]) == (spend - 20) * 100
    assert sum(round(row["amountUSD"] * 100) for row in ad["data"]["refundDueBaseline"]) == (spend - covered) * 100
    if settle_before_undo:
        result = t.client.post(f"/api/receipts/{rid}/settle", json={
            "expectedLastModified": receipt["lastModified"], "idempotencyKey": tag + "_settle",
        }, cookies=actors["admin"])
        assert result.status_code == 200, result.text
        ad = result.json()["updatedAds"][0]
    result = _update(ad, {"refundType": "None"}, tag + "_undo", actors)
    assert result.status_code == 200, result.text
    ad = result.json()["ad"]
    assert _funded_minor(ad["data"]) == spend * 100
    assert ad["data"]["companyFundingAllocations"] == [{"receiptId": rid, "amountUSD": covered}]
    assert ad["data"]["status"] == ("Stopped" if stop_first else "Active")
    if settle_before_undo:
        assert ad["data"]["paymentStatus"] == "paid"
        assert not ad["data"]["dueAllocations"]
    if stop_first:
        result = t._stop(aid, 10_000, tag + "_correct_spend", ad["lastModified"], actors["admin"])
        assert result.status_code == 200, result.text
        assert _funded_minor(result.json()["ad"]["data"]) == 10_000
        if settle_before_undo:
            assert result.json()["ad"]["data"]["paymentStatus"] == "paid"


@pytest.mark.parametrize("operation", ["ad", "transfer"])
@pytest.mark.parametrize("covered", [40, 100])
def test_settled_coverage_leaves_real_customer_cash_available(actors, operation, covered):
    tag = f"lifecycle_cash_{operation}_{covered}"
    cid, rid, aid, receipt, ad = _setup(tag, actors)
    result = t._cover(rid, covered * 100, tag + "_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    receipt = result.json()["updatedReceipts"][0]
    result = t.client.post(f"/api/receipts/{rid}/settle", json={
        "expectedLastModified": receipt["lastModified"], "idempotencyKey": tag + "_settle",
    }, cookies=actors["admin"])
    assert result.status_code == 200, result.text
    receipt = result.json()["receipt"]
    assert receipt["data"]["amountUSD"] == 200 - covered
    if operation == "ad":
        payload = {"action": "create", "adId": tag + "_new", "idempotencyKey": tag + "_fund",
                   "data": {"customerId": cid, "paymentStatus": "paid",
                            "receiptAllocations": [{"receiptId": rid, "amountUSD": 100}]}}
        result = t.client.post("/api/ads/mutate", json=payload, cookies=actors["admin"])
        assert result.status_code == 200, result.text
        payload.update(adId=tag + "_overspend", idempotencyKey=tag + "_overspend")
        payload["data"]["receiptAllocations"][0]["amountUSD"] = 0.01
        result = t.client.post("/api/ads/mutate", json=payload, cookies=actors["admin"])
    else:
        target = tag + "_target"
        t._customer(target, actors)
        payload = {"sourceReceiptId": rid, "targetCustomerId": target, "targetReceiptId": tag + "_incoming",
                   "amountMinorUSD": 10000, "expectedSourceLastModified": receipt["lastModified"],
                   "idempotencyKey": tag + "_transfer"}
        result = t.client.post("/api/receipts/transfers", json=payload, cookies=actors["admin"])
        assert result.status_code == 200, result.text
        payload.update(targetReceiptId=tag + "_over", amountMinorUSD=1,
                       expectedSourceLastModified=result.json()["sourceReceipt"]["lastModified"],
                       idempotencyKey=tag + "_overspend")
        result = t.client.post("/api/receipts/transfers", json=payload, cookies=actors["admin"])
    assert result.status_code == 409, result.text


def test_direct_receipt_debt_edits_refresh_outstanding_and_next_coverage(actors):
    cid, rid, aid, receipt, ad = _setup("lifecycle_edit", actors, amount=100)
    result = t._cover(rid, 4000, "lifecycle_edit_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    receipt = result.json()["updatedReceipts"][0]
    for gross in (150, 125):
        result = t.client.patch(f"/api/collections/receipts/{rid}", json={
            "expectedLastModified": receipt["lastModified"],
            "data": {"amountUSD": gross, "amountLocal": gross * 5,
                     "debtAmountUSD": gross, "debtAmountLocal": gross * 5},
        }, cookies=actors["admin"])
        assert result.status_code == 200, result.text
        receipt = result.json()
        assert receipt["data"]["customerOutstandingUSD"] == gross - 40
    result = t._cover(rid, 8500, "lifecycle_edit_cover_rest", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    assert result.json()["updatedReceipts"][0]["data"]["customerOutstandingUSD"] == 0


def test_coverage_still_reserves_unpaid_capacity(actors):
    cid, rid, aid, receipt, ad = _setup("lifecycle_unpaid", actors, amount=100)
    result = t._cover(rid, 4000, "lifecycle_unpaid_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    result = t.client.post("/api/ads/mutate", json={
        "action": "create", "adId": "lifecycle_unpaid_again", "idempotencyKey": "lifecycle_unpaid_again",
        "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                 "receiptId": rid, "receiptAllocations": [],
                 "dueAllocations": [{"receiptId": rid, "amountUSD": 0.01}]},
    }, cookies=actors["admin"])
    assert result.status_code == 409, result.text


@pytest.mark.parametrize("refund_type,amount", [("Full", 100), ("Partial", 61)])
def test_refund_cannot_erase_committed_company_money(actors, refund_type, amount):
    tag = "lifecycle_company_refund_" + refund_type
    cid, rid, aid, receipt, ad = _setup(tag, actors)
    result = t._cover(rid, 4000, tag + "_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    ad = result.json()["updatedAds"][0]
    result = _update(ad, {"refundType": refund_type, "refundAmount": amount}, tag + "_refund", actors)
    assert result.status_code == 409, result.text
    assert t._entity("ads", aid, actors["admin"])["data"] == ad["data"]


@pytest.mark.parametrize("settle", [False, True])
def test_mixed_paid_due_refund_coverage_and_undo(actors, settle):
    tag = f"lifecycle_mixed_{int(settle)}"
    cid, rid, paid_rid, aid = tag + "_c", tag + "_due", tag + "_paid", tag + "_a"
    t._customer(cid, actors)
    receipt = t._unpaid_receipt(rid, cid, 100, actors)
    t._paid_receipt(paid_rid, cid, 50, actors)
    result = t.client.post("/api/ads/mutate", json={
        "action": "create", "adId": aid, "idempotencyKey": tag + "_create",
        "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                 "receiptId": rid, "exchangeRate": 5,
                 "receiptAllocations": [{"receiptId": paid_rid, "amountUSD": 50}],
                 "dueAllocations": [{"receiptId": rid, "amountUSD": 50}]},
    }, cookies=actors["admin"])
    assert result.status_code == 200, result.text
    result = _update(result.json()["ad"], {"refundType": "Partial", "refundAmount": 20}, tag + "_refund", actors)
    assert result.status_code == 200, result.text
    for index, covered in enumerate((10, 20)):
        result = t._cover(rid, covered * 100, tag + f"_cover_{index}", receipt["lastModified"], actors["admin"])
        assert result.status_code == 200, result.text
        receipt = result.json()["updatedReceipts"][0]
        ad = result.json()["updatedAds"][0]
    if settle:
        result = t.client.post(f"/api/receipts/{rid}/settle", json={
            "expectedLastModified": receipt["lastModified"], "idempotencyKey": tag + "_settle",
        }, cookies=actors["admin"])
        assert result.status_code == 200, result.text
        ad = result.json()["updatedAds"][0]
    result = _update(ad, {"refundType": "None"}, tag + "_undo", actors)
    assert result.status_code == 200, result.text
    saved = result.json()["ad"]["data"]
    assert _funded_minor(saved) == 10000
    assert saved["companyFundingAllocations"] == [{"receiptId": rid, "amountUSD": 30}]
    assert {row["receiptId"]: row["amountUSD"] for row in saved["receiptAllocations"]}[paid_rid] == 50
    assert sum(row["amountUSD"] for row in saved["dueAllocations"]) == (0 if settle else 20)


@pytest.mark.parametrize("delivered,paid", [(False, False), (True, False), (True, True)])
def test_direct_covered_receipt_edit_respects_collected_cash(delivered, paid):
    old = {"status": "Paid" if paid else "Not Paid", "isPaid": paid,
           "deliveryStatus": "Delivered" if delivered else "Needs Delivery",
           "amountUSD": 30 if delivered else 100, "debtAmountUSD": 100,
           "amountLocal": 150 if delivered else 500, "debtAmountLocal": 500,
           "exchangeRate": 5, "companyCoveredUSD": 40, "customerOutstandingUSD": 0 if paid else 30 if delivered else 60}
    merged = {**old, "debtAmountUSD": 150, "debtAmountLocal": 750}
    apply_coverage_settlement_truth(old, merged, due_total=_financial_due_total)
    assert merged["customerOutstandingUSD"] == (0 if paid else 80 if delivered else 110)
    assert merged["amountUSD"] == old["amountUSD"]


def test_note_edit_does_not_silently_repair_historical_coverage_summary():
    old = {"status": "Not Paid", "isPaid": False, "amountUSD": 100,
           "companyCoveredUSD": 40, "customerOutstandingUSD": 999}
    merged = {**old, "notes": "No financial change"}
    apply_coverage_settlement_truth(old, merged, due_total=_financial_due_total)
    assert merged["customerOutstandingUSD"] == 999


def test_inconsistent_historical_refund_baseline_fails_without_writing():
    source = {"refundType": "Partial", "refundAmount": 20, "amountUSD": 100,
              "dueAllocations": [{"receiptId": "r", "amountUSD": 80}],
              "refundDueBaseline": [{"receiptId": "r", "amountUSD": 10}]}
    with pytest.raises(HTTPException) as rejected:
        plan_company_debt_coverage("r", 4000, [("ad", source)])
    assert rejected.value.status_code == 409
    assert source["dueAllocations"][0]["amountUSD"] == 80


@pytest.mark.parametrize("cents", range(1, 201))
def test_refund_stop_and_relink_exact_cent_conservation(cents):
    actor = {"id": "lifecycle_property", "role": "Admin"}
    paid = cents // 3
    due = cents - paid
    ad = {"status": "Active", "paymentStatus": "not_paid", "isPaid": False,
          "collectionMethod": "in_shop", "receiptId": "property_due", "amountUSD": cents / 100,
          "receiptAllocations": [{"receiptId": "property_paid", "amountUSD": paid / 100}] if paid else [],
          "dueAllocations": [{"receiptId": "property_due", "amountUSD": due / 100}]}
    stopped = _financial_apply_stop(ad, cents - cents // 4)
    spent = round(stopped["spentUSD"] * 100)
    refund = spent // 2
    saved = stopped
    for _ in range(4):
        saved = _financial_apply_refund(actor, {"refundType": "Partial", "refundAmount": refund / 100}, saved)
        assert round(saved["spentUSD"] * 100) == spent - refund
        assert _funded_minor(saved) == spent - refund
    restored = _financial_apply_refund(actor, {"refundType": "None"}, saved)
    assert restored["spentUSD"] == stopped["spentUSD"]
    assert restored["receiptAllocations"] == stopped["receiptAllocations"]
    assert restored["dueAllocations"] == stopped["dueAllocations"]
    relinked = _financial_apply_relink(restored, {
        "receiptAllocations": [{**row, "receiptId": "new_paid"} for row in restored["receiptAllocations"]],
        "dueAllocations": [{**row, "receiptId": "new_due"} for row in restored["dueAllocations"]],
    })
    assert relinked["spentUSD"] == restored["spentUSD"]
    assert relinked["amountUSD"] == restored["amountUSD"]
