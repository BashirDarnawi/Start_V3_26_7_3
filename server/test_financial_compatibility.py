"""Pre-upgrade financial JSON remains usable without a data rewrite.

Fixtures intentionally bypass new-record defaults. Pure tests cover old shapes;
API fixtures modify only the isolated test database and verify byte-for-byte
read immutability as well as subsequent server-validated operations.
"""

from copy import deepcopy

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from server.company_debt_coverage import (
    _read_company_coverage_state,
    protect_company_coverage_fields,
)
from server.financial_compatibility import (
    project_financial_data,
    project_financial_entity,
    receipt_customer_outstanding_minor,
)
from server.financial_core import _financial_due_total


@pytest.mark.parametrize("cached", [None, 0, 10, 60, 999])
@pytest.mark.parametrize("delivered", [False, True])
@pytest.mark.parametrize("collection", ["office", "driver"])
def test_old_receipt_derived_summary_ignores_stale_cache(cached, delivered, collection):
    data = {
        "status": "Not Paid", "isPaid": False,
        "amountUSD": 30 if delivered else 150,
        "amountLocal": 150 if delivered else 750,
        "debtAmountUSD": 150, "debtAmountLocal": 750, "exchangeRate": 5,
        "companyCoveredUSD": 40, "customerOutstandingUSD": cached,
        "statusDetail": {"notPaidCollection": collection},
        "deliveryStatus": "Delivered" if delivered else "Not Delivered",
        "notes": "Keep original note", "photos": ["saved-photo"],
    }
    original = deepcopy(data)
    expected = 80 if delivered else 110
    projected = project_financial_data("receipts", data)
    assert projected["customerOutstandingUSD"] == expected
    assert data == original
    assert {k: v for k, v in projected.items() if k != "customerOutstandingUSD"} == {
        k: v for k, v in data.items() if k != "customerOutstandingUSD"
    }
    assert project_financial_data("receipts", projected) == projected
    assert _read_company_coverage_state(
        data, _financial_due_total, collected_minor=30_00 if delivered else 0
    )[:3] == (150_00, 40_00, expected * 100)


@pytest.mark.parametrize("status", ["Paid", "Canceled", "Lost", "Destroyed"])
def test_closed_or_paid_old_receipt_summary_does_not_rewrite_cash(status):
    data = {"status": status, "amountUSD": 100, "amountLocal": 500,
            "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
            "debtAmountUSD": 100, "exchangeRate": 5}
    projected = project_financial_data("receipts", data)
    assert projected["customerOutstandingUSD"] == 0
    # A Paid 100 might be gross from old code or real collected cash. A read
    # must never guess which and subtract company funding from it.
    assert projected["amountUSD"] == 100
    assert projected["amountLocal"] == 500
    assert data["customerOutstandingUSD"] == 60


@pytest.mark.parametrize("status,expected", [
    ("paid", 0), (" PAID ", 0), ("Not_Paid", 80), ("not-paid", 80),
    ("unpaid", 80), ("pending", 80), ("cancelled", 0), ("Destroyed", 0),
])
def test_old_status_aliases_without_ispaid_follow_documented_read_rules(status, expected):
    data = {"status": status, "deliveryStatus": "delivered", "amountUSD": 30,
            "debtAmountUSD": 150, "debtAmountLocal": 750,
            "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
            "statusDetail": {"notPaidCollection": "office"}}
    projected = project_financial_data("receipts", data)
    assert projected["customerOutstandingUSD"] == expected
    assert projected["status"] == status
    assert projected["amountUSD"] == 30
    assert "isPaid" not in projected


@pytest.mark.parametrize("ispaid", [True, False, None])
def test_unknown_explicit_status_is_not_overridden_by_summary_projection(ispaid):
    data = {"status": "unknown imported state", "isPaid": ispaid, "amountUSD": 100,
            "companyCoveredUSD": 40, "customerOutstandingUSD": 12}
    assert project_financial_data("receipts", data) == data


@pytest.mark.parametrize("status", ["Not Paid", "unpaid", "pending"])
def test_contradictory_old_paid_flag_does_not_invent_new_debt(status):
    data = {"status": status, "isPaid": True, "amountUSD": 150,
            "companyCoveredUSD": 40, "customerOutstandingUSD": 0}
    assert receipt_customer_outstanding_minor(data) is None
    assert project_financial_data("receipts", data) == data


@pytest.mark.parametrize("patch", [
    {"debtAmountUSD": None, "deliveryStatus": "Delivered"},
    {"amountUSD": None, "debtAmountUSD": None},
    {"companyCoveredUSD": 101},
    {"amountUSD": "NaN"},
    {"companyCoveredUSD": "bad"},
    {"isPaid": None, "status": "unknown"},
])
def test_ambiguous_or_invalid_old_money_is_not_guessed(patch):
    data = {"status": "Not Paid", "amountUSD": 100, "debtAmountUSD": 100,
            "companyCoveredUSD": 40, "customerOutstandingUSD": 60,
            "statusDetail": {"notPaidCollection": "office"}, **patch}
    assert receipt_customer_outstanding_minor(data) is None
    assert project_financial_data("receipts", data) == data


def test_zero_driver_receipt_without_summary_keeps_ad_derived_debt_path():
    data = {"status": "Not Paid", "amountUSD": 0, "debtAmountUSD": 0,
            "statusDetail": {"notPaidCollection": "driver"}}
    assert "customerOutstandingUSD" not in project_financial_data("receipts", data)


@pytest.mark.parametrize("legacy", [False, True])
def test_old_ad_summaries_use_rows_without_changing_funding(legacy):
    data = {
        "paymentStatus": "not_paid", "collectionMethod": "in_shop",
        "receiptId": "r1", "dueAmountToUseUSD": 35,
        "dueAllocations": [] if legacy else [{"receiptId": "r1", "amountUSD": 35}],
        "companyFundingAllocations": [{"receiptId": "r1", "amountUSD": 25}],
        "customerDueUSD": 60, "companyFundedUSD": 0,
        "companyDirectCoverageUSD": 9, "receiptAllocations": [],
        "refundDueBaseline": [{"receiptId": "r1", "amountUSD": 60}],
    }
    original = deepcopy(data)
    projected = project_financial_data("ads", data)
    assert projected["customerDueUSD"] == 35
    assert projected["companyFundedUSD"] == 25
    assert projected["companyDirectCoverageUSD"] == 9
    assert projected["refundDueBaseline"] == original["refundDueBaseline"]
    assert data == original
    assert project_financial_data("ads", projected) == projected


@pytest.mark.parametrize("rows", [None, "bad", [{}], [{"receiptId": "r", "amountUSD": "NaN"}], [{"receiptId": "r"}]])
def test_invalid_old_allocations_do_not_become_zero_money(rows):
    data = {"companyFundingAllocations": rows, "companyFundedUSD": 42,
            "dueAllocations": rows, "customerDueUSD": 13}
    assert project_financial_data("ads", data) == data


def test_missing_old_ad_allocations_do_not_invent_history():
    data = {"companyFundedUSD": 42, "customerDueUSD": 13}
    assert project_financial_data("ads", data) == data


def test_exact_corrected_echo_is_accepted_but_forged_summary_is_not():
    old = {"status": "Not Paid", "amountUSD": 150, "companyCoveredUSD": 40,
           "customerOutstandingUSD": 60, "statusDetail": {"notPaidCollection": "office"}}
    request = {"customerOutstandingUSD": 110, "notes": "safe full-record edit"}
    protect_company_coverage_fields("receipts", request, old)
    assert request == {"notes": "safe full-record edit"}
    for value in [0, 1, 109, 111, 999]:
        with pytest.raises(HTTPException) as error:
            protect_company_coverage_fields("receipts", {"customerOutstandingUSD": value}, old)
        assert error.value.status_code == 405
    with pytest.raises(HTTPException):
        protect_company_coverage_fields("receipts", {"companyCoveredUSD": 70}, old)
    with pytest.raises(HTTPException):
        protect_company_coverage_fields("receipts", {"customerOutstandingUSD": 110}, None)


def test_old_ad_derived_summary_echoes_do_not_mutate_coverage_rows():
    old = {"companyFundingAllocations": [{"receiptId": "r", "amountUSD": 25}],
           "companyFundedUSD": 0, "customerDueUSD": 60,
           "dueAllocations": [{"receiptId": "r", "amountUSD": 35}]}
    requested = {"companyFundedUSD": 25, "customerDueUSD": 35, "notes": "updated"}
    protect_company_coverage_fields("ads", requested, old)
    assert requested == {"notes": "updated"}
    assert old["companyFundedUSD"] == 0
    assert old["companyFundingAllocations"] == [{"receiptId": "r", "amountUSD": 25}]
    for forged in [{"companyFundedUSD": 999}, {"customerDueUSD": 999},
                   {"companyFundingAllocations": []}, {"companyDirectCoverageUSD": 20}]:
        with pytest.raises(HTTPException) as rejected:
            protect_company_coverage_fields("ads", forged, old)
        assert rejected.value.status_code == 405


def test_deleted_or_nonfinancial_entities_are_preserved():
    for entity in [
        {"type": "customers", "data": {"customerOutstandingUSD": 12}},
        {"type": "receipts", "deleted": True, "data": {"status": "Paid", "customerOutstandingUSD": 12}},
        {"type": "receipts", "data": None},
    ]:
        assert project_financial_entity(entity) is entity


def test_projection_preserves_record_identity_and_audit_timestamps():
    entity = {"type": "receipts", "id": "old_receipt", "lastModified": 1,
              "createdAt": 1, "createdBy": "old_actor", "deleted": False,
              "data": {"status": "Not Paid", "amountUSD": 150,
                       "companyCoveredUSD": 40, "customerOutstandingUSD": 60}}
    original = deepcopy(entity)
    projected = project_financial_entity(entity)
    assert projected["data"]["customerOutstandingUSD"] == 110
    assert {k: v for k, v in projected.items() if k != "data"} == {
        k: v for k, v in entity.items() if k != "data"
    }
    assert entity == original


@pytest.fixture(scope="module")
def actors():
    from server import test_receipt_company_coverages as helpers
    return helpers.actors.__wrapped__()


def _store_old_receipt(receipt_id, actors):
    from server import test_receipt_company_coverages as helpers
    from server.db import db_conn, json_dumps

    customer_id = receipt_id + "_customer"
    helpers._customer(customer_id, actors)
    receipt = helpers._unpaid_receipt(receipt_id, customer_id, 150, actors, date="2024-01-10")
    # This is deliberately old stored JSON: the former edit changed the gross
    # promise to 150 but left the cached outstanding from its 100-dollar past.
    data = {**receipt["data"], "companyCoveredUSD": 40, "customerOutstandingUSD": 60}
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json=:data WHERE type='receipts' AND id=:id"),
                     {"data": json_dumps(data), "id": receipt_id})
    return receipt


def _raw_receipt(receipt_id):
    from server.db import db_conn
    with db_conn() as conn:
        return dict(conn.execute(text("SELECT data_json,last_modified FROM entities WHERE type='receipts' AND id=:id"),
                                 {"id": receipt_id}).mappings().one())


def test_old_receipt_api_list_and_detail_project_without_writing(actors):
    from server import test_receipt_company_coverages as helpers
    receipt_id = "compatibility_read_old_receipt"
    _store_old_receipt(receipt_id, actors)
    before = _raw_receipt(receipt_id)
    detail = helpers._entity("receipts", receipt_id, actors["admin"])
    assert detail["data"]["customerOutstandingUSD"] == 110
    for media in ["true", "false"]:
        response = helpers.client.get(f"/api/collections/receipts?include_media={media}", cookies=actors["admin"])
        assert response.status_code == 200, response.text
        payload = response.json()
        rows = payload if isinstance(payload, list) else payload["items"]
        old = next(row for row in rows if row["id"] == receipt_id)
        assert old["data"]["customerOutstandingUSD"] == 110
    assert _raw_receipt(receipt_id) == before


def test_old_receipt_corrected_response_can_be_edited_without_405(actors):
    from server import test_receipt_company_coverages as helpers
    receipt_id = "compatibility_edit_old_receipt"
    _store_old_receipt(receipt_id, actors)
    receipt = helpers._entity("receipts", receipt_id, actors["admin"])
    result = helpers.client.patch(f"/api/collections/receipts/{receipt_id}",
        json={"expectedLastModified": receipt["lastModified"],
              "data": {"notes": "After upgrade", "customerOutstandingUSD": 110}}, cookies=actors["admin"])
    assert result.status_code == 200, result.text
    assert result.json()["data"]["customerOutstandingUSD"] == 110
    assert result.json()["data"]["amountUSD"] == 150


def test_old_receipt_can_cover_corrected_outstanding_not_stale_cache(actors):
    from server import test_receipt_company_coverages as helpers
    receipt_id = "compatibility_cover_old_receipt"
    receipt = _store_old_receipt(receipt_id, actors)
    covered = helpers._cover(receipt_id, 110_00, "compatibility-cover-old", receipt["lastModified"], actors["admin"])
    assert covered.status_code == 200, covered.text
    data = covered.json()["updatedReceipts"][0]["data"]
    assert data["companyCoveredUSD"] == 150
    assert data["customerOutstandingUSD"] == 0
    assert data["status"] == "Not Paid"


def test_closed_period_old_receipt_is_readable_but_not_rewritten(actors, monkeypatch):
    from server import operations, test_receipt_company_coverages as helpers

    receipt_id = "compatibility_closed_old_receipt"
    receipt = _store_old_receipt(receipt_id, actors)
    before = _raw_receipt(receipt_id)
    monkeypatch.setattr(operations, "_close_record", lambda period, conn=None: {
        "period": period, "status": "closed", "snapshot": {"customerOutstandingUSD": 60},
    })
    detail = helpers._entity("receipts", receipt_id, actors["admin"])
    assert detail["data"]["customerOutstandingUSD"] == 110
    rejected = helpers._cover(receipt_id, 110_00, "compatibility-cover-closed", receipt["lastModified"], actors["admin"])
    assert rejected.status_code == 423, rejected.text
    assert _raw_receipt(receipt_id) == before
