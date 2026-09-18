"""Stop/relink financial regressions; isolated local fixtures, never live data."""

import pytest
from sqlalchemy import text

from server import test_receipt_relink as relink
from server import test_receipt_company_coverages as coverage
from server.db import db_conn, json_dumps, json_loads
from server.financial_relink_baseline import settled_relink_stop_baseline
from server.main import _financial_apply_stop
from fastapi import HTTPException


@pytest.fixture(scope="module")
def admin():
    return relink.admin.__wrapped__()


@pytest.fixture(scope="module")
def actors():
    return coverage.actors.__wrapped__()


def _settled_stop(tag, admin):
    helper = relink.TestReceiptSettleTerminal()
    aid, cid, old, paid, version = helper._stopped_unpaid_shop_ad(tag, admin)
    result = relink._update_ad(aid, tag + "_relink", {
        "relinkReceiptOnly": True, "paymentStatus": "paid",
        "receiptAllocations": [{"receiptId": paid, "amountUSD": 1.24}],
        "dueAllocations": [],
    }, version, admin)
    assert result.status_code == 200, result.text
    return aid, old, paid, result.json()["ad"]


@pytest.mark.parametrize("spent", [0, 100, 124, 200, 900])
def test_settled_relink_can_correct_final_spend_without_resurrecting_debt(admin, spent):
    tag = f"relinkstop_current_{spent}"
    aid, old, paid, ad = _settled_stop(tag, admin)
    baseline = ad["data"]["stopAllocationBaseline"]
    assert baseline["paymentStatus"] == "paid"
    assert baseline["due"] == []
    assert baseline["receipt"] == [{"receiptId": paid, "amountUSD": 9.0}]
    result = relink._stop_ad(aid, tag + "_restop", spent, ad["lastModified"], admin)
    assert result.status_code == 200, result.text
    saved = result.json()["ad"]["data"]
    assert saved["amountUSD"] == 9
    assert saved["spentUSD"] == spent / 100
    assert saved["isPaid"] is True and saved["paymentStatus"] == "paid"
    assert saved["dueAllocations"] == []
    assert saved["receiptAllocations"] == ([{"receiptId": paid, "amountUSD": spent / 100}] if spent else [])
    retry = relink._stop_ad(aid, tag + "_restop", spent, ad["lastModified"], admin)
    assert retry.status_code == 200, retry.text
    assert retry.json()["ad"]["data"] == saved
    assert relink.client.delete(f"/api/collections/receipts/{old}", cookies=admin).status_code == 200


def test_raw_old_settled_relink_is_normalized_only_during_authorized_stop(admin):
    tag = "relinkstop_legacy"
    aid, old, paid, ad = _settled_stop(tag, admin)
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"), {"id": aid}).mappings().one()
        data = json_loads(row["data_json"])
        data["stopAllocationBaseline"] = {
            "receipt": [], "due": [{"receiptId": paid, "amountUSD": 9}],
            "merged": [], "dueLegacy": 0, "dueLegacyReceiptId": "",
            "paymentStatus": "not_paid",
        }
        raw = json_dumps(data)
        conn.execute(text("UPDATE entities SET data_json=:data WHERE type='ads' AND id=:id"), {"data": raw, "id": aid})
    assert relink.client.get(f"/api/collections/ads/{aid}", cookies=admin).status_code == 200
    with db_conn() as conn:
        assert conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"), {"id": aid}).scalar_one() == raw
    result = relink._stop_ad(aid, tag + "_correct", 100, ad["lastModified"], admin)
    assert result.status_code == 200, result.text
    saved = result.json()["ad"]["data"]
    assert saved["paymentStatus"] == "paid"
    assert saved["receiptAllocations"] == [{"receiptId": paid, "amountUSD": 1}]
    assert saved["dueAllocations"] == []
    assert saved["stopAllocationBaseline"]["receipt"] == [{"receiptId": paid, "amountUSD": 9}]


@pytest.mark.parametrize("spent", [0, 1000, 3999, 4000, 8000])
def test_stop_cannot_leave_more_company_funding_than_real_spend(actors, spent):
    tag = f"relinkstop_company_{spent}"
    cid, rid, aid = tag + "_c", tag + "_r", tag + "_a"
    coverage._customer(cid, actors)
    receipt = coverage._unpaid_receipt(rid, cid, 100, actors)
    coverage._create_ad(aid, cid, rid, 100, actors)
    result = coverage._cover(rid, 4000, tag + "_cover", receipt["lastModified"], actors["admin"])
    assert result.status_code == 200, result.text
    ad = result.json()["updatedAds"][0]
    result = coverage._stop(aid, spent, tag + "_stop", ad["lastModified"], actors["admin"])
    if spent < 4000:
        assert result.status_code == 409, result.text
        assert "company" in result.text.lower()
        assert coverage._entity("ads", aid, actors["admin"])["data"] == ad["data"]
    else:
        assert result.status_code == 200, result.text
        saved = result.json()["ad"]["data"]
        funded = sum(round(row["amountUSD"] * 100) for field in ("receiptAllocations", "dueAllocations", "companyFundingAllocations") for row in saved[field])
        assert funded == spent
        assert saved["companyFundingAllocations"] == [{"receiptId": rid, "amountUSD": 40}]


def test_restop_insufficient_paid_receipt_rolls_back_all_fields(admin):
    tag = "relinkstop_insufficient"
    aid, old, paid, ad = _settled_stop(tag, admin)
    # Use the remaining cash in a separate ad; the existing final spend can
    # still be corrected downward, but a larger charge needs real capacity.
    result = relink._create_ad(tag + "_other", tag + "_other_create", {
        "customerId": ad["data"]["customerId"], "paymentStatus": "paid",
        "receiptAllocations": [{"receiptId": paid, "amountUSD": 58.76}],
    }, admin)
    assert result.status_code == 200, result.text
    before = relink.client.get(f"/api/collections/ads/{aid}", cookies=admin).json()
    result = relink._stop_ad(aid, tag + "_too_much", 200, ad["lastModified"], admin)
    assert result.status_code == 409, result.text
    assert relink.client.get(f"/api/collections/ads/{aid}", cookies=admin).json() == before
    result = relink._stop_ad(aid, tag + "_less", 100, ad["lastModified"], admin)
    assert result.status_code == 200, result.text


@pytest.mark.parametrize("partial", [False, True])
def test_multiple_receipt_settlement_keeps_rates_and_refuses_ambiguous_original_split(admin, partial):
    tag = f"relinkstop_multi_{int(partial)}"
    cid, unpaid, paid1, paid2, aid = (tag + suffix for suffix in ("_c", "_due", "_p1", "_p2", "_ad"))
    relink._customer(cid, admin)
    relink._office_receipt(unpaid, cid, 20, admin)
    relink._paid_receipt(paid1, cid, 30, admin)
    result = relink.client.post("/api/collections/receipts", json={
        "id": paid2, "data": {"recordType": "receipt", "customerId": cid,
        "amountUSD": 30, "amountLocal": 291, "exchangeRate": 9.7,
        "status": "Paid", "isPaid": True},
    }, cookies=admin)
    assert result.status_code == 200, result.text
    created = relink._create_ad(aid, tag + "_create", {
        "customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
        "receiptId": unpaid, "exchangeRate": 5,
        "receiptAllocations": [{"receiptId": paid1, "amountUSD": 10}],
        "dueAllocations": [{"receiptId": unpaid, "amountUSD": 20}],
    }, admin)
    assert created.status_code == 200, created.text
    spent = 2000 if partial else 3000
    stopped = relink._stop_ad(aid, tag + "_stop", spent, created.json()["ad"]["lastModified"], admin)
    assert stopped.status_code == 200, stopped.text
    settled = relink._update_ad(aid, tag + "_settle", {
        "relinkReceiptOnly": True, "paymentStatus": "paid",
        "receiptAllocations": [{"receiptId": paid1, "amountUSD": 10}, {"receiptId": paid2, "amountUSD": spent / 100 - 10}],
        "dueAllocations": [],
    }, stopped.json()["ad"]["lastModified"], admin)
    assert settled.status_code == 200, settled.text
    ad = settled.json()["ad"]
    receipt_before = [relink.client.get(f"/api/collections/receipts/{rid}", cookies=admin).json() for rid in (paid1, paid2)]
    corrected = relink._stop_ad(aid, tag + "_correct", 1500, ad["lastModified"], admin)
    if partial:
        # The original $30 split between the new paid destinations was never
        # chosen. Keep the valid settlement, but never guess a historical rate.
        assert corrected.status_code == 409, corrected.text
        assert "needs review" in corrected.text
        assert relink.client.get(f"/api/collections/ads/{aid}", cookies=admin).json()["data"] == ad["data"]
    else:
        assert corrected.status_code == 200, corrected.text
        data = corrected.json()["ad"]["data"]
        assert data["receiptAllocations"] == [{"receiptId": paid1, "amountUSD": 5}, {"receiptId": paid2, "amountUSD": 10}]
        assert data["dueAllocations"] == []
        assert data["paymentStatus"] == "paid"
    assert [relink.client.get(f"/api/collections/receipts/{rid}", cookies=admin).json() for rid in (paid1, paid2)] == receipt_before
    assert receipt_before[0]["data"]["exchangeRate"] == 5
    assert receipt_before[1]["data"]["exchangeRate"] == 9.7


def test_mixed_legacy_baseline_settled_on_one_receipt_preserves_all_original_cents():
    baseline = {"receipt": [{"receiptId": "old_paid", "amountUSD": 10.03}],
                "due": [{"receiptId": "old_due", "amountUSD": 19.97}],
                "merged": [], "dueLegacy": 0, "paymentStatus": "not_paid",
                "extensionEvidence": {"preserve": True}}
    ad = {"status": "Stopped", "amountUSD": 30, "spentUSD": 20, "paymentStatus": "paid",
          "receiptAllocations": [{"receiptId": "new_paid", "amountUSD": 20}], "dueAllocations": []}
    fixed = settled_relink_stop_baseline(ad, baseline)
    assert fixed["receipt"] == [{"receiptId": "new_paid", "amountUSD": 30}]
    assert fixed["extensionEvidence"] == baseline["extensionEvidence"]
    assert baseline["paymentStatus"] == "not_paid"  # pure, no caller mutation
    ad["stopAllocationBaseline"] = fixed
    for spent in (1999, 0, 2501, 3000, 2501):
        ad = _financial_apply_stop(ad, spent)
        assert ad["paymentStatus"] == "paid"
        assert ad["dueAllocations"] == []
        assert sum(round(row["amountUSD"] * 100) for row in ad["receiptAllocations"]) == spent
        assert ad["stopAllocationBaseline"]["receipt"] == [{"receiptId": "new_paid", "amountUSD": 30}]


def test_inconsistent_old_settlement_cannot_manufacture_paid_funding():
    baseline = {"receipt": [], "due": [{"receiptId": "due", "amountUSD": 100}], "paymentStatus": "not_paid"}
    ad = {"status": "Stopped", "paymentStatus": "paid", "spentUSD": 50,
          "receiptAllocations": [{"receiptId": "paid", "amountUSD": 10}], "dueAllocations": []}
    assert settled_relink_stop_baseline(ad, baseline, strict=False) == baseline
    with pytest.raises(HTTPException) as error:
        settled_relink_stop_baseline(ad, baseline)
    assert error.value.status_code == 409


@pytest.mark.parametrize("company_field", ["companyFundingAllocations", "companyDirectCoverageUSD"])
def test_raw_old_company_funding_is_preserved_when_stop_is_refused(company_field):
    ad = {"status": "Active", "paymentStatus": "not_paid", "collectionMethod": "in_shop",
          "receiptId": "due", "amountUSD": 100, "exchangeRate": 5,
          "receiptAllocations": [], "dueAllocations": [{"receiptId": "due", "amountUSD": 60}]}
    ad[company_field] = ([{"receiptId": "due", "amountUSD": 40}] if company_field == "companyFundingAllocations" else 40)
    raw = json_dumps(ad)
    with pytest.raises(HTTPException) as error:
        _financial_apply_stop(ad, 3999)
    assert error.value.status_code == 409
    assert json_dumps(ad) == raw
