"""Focused tests for Admin-funded unpaid-receipt company coverage.

Company coverage is not a customer payment.  It reduces the customer's
outstanding liability and moves linked ad debt from ``dueAllocations`` into
``companyFundingAllocations`` while preserving the receipt's original unpaid
provenance and every customer-paid allocation.

Run with: PYTHONPATH=. pytest server/test_receipt_company_coverages.py -v
"""

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server import company_debt_coverage as coverage_module
import server.main as main_module
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "company-coverage-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "CompanyCoverageAdmin123!Secure"
EMPLOYEE_EMAIL = "company-coverage-employee@tests.albayanhub.com"
EMPLOYEE_PASSWORD = "CompanyCoverageEmployee123!Secure"


def _ensure_admin() -> str:
    password = hash_password(
        ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT
    )
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        user_id = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users "
                "(id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,"
                "last_modified) VALUES "
                "(:id,'Company Coverage Admin',:email,'Admin',:permissions,:hash,"
                ":salt,:algo,:iterations,false,:now,NULL,:now)"
            ),
            {
                "id": user_id,
                "email": ADMIN_EMAIL,
                "permissions": json_dumps({}),
                "hash": password.hash_hex,
                "salt": password.salt_hex,
                "algo": password.algo,
                "iterations": password.iterations,
                "now": now,
            },
        )
        return user_id


def _login(email: str, password: str) -> dict[str, str]:
    response = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _ensure_employee(admin: dict[str, str]) -> dict[str, str]:
    response = client.post(
        "/api/users",
        json={
            "name": "Company Coverage Employee",
            "email": EMPLOYEE_EMAIL,
            "password": EMPLOYEE_PASSWORD,
            "role": "Employee",
            # Deliberately grant every existing receipt-money permission.  A
            # 403 then proves this route is role-gated, not merely edit-gated.
            "permissions": {
                "receipts": [
                    "view",
                    "edit",
                    "markCollected",
                    "transfer",
                ],
                "ads": ["view"],
            },
        },
        cookies=admin,
    )
    if response.status_code not in {200, 409}:
        pytest.fail(response.text)
    return _login(EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD)


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin_id = _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    return {
        "admin": admin,
        "admin_id": admin_id,
        "employee": _ensure_employee(admin),
    }


def _phone(value: str) -> str:
    suffix = int.from_bytes(
        hashlib.sha256(value.encode("utf-8")).digest()[:8], "big"
    ) % 100_000_000
    return f"09{suffix:08d}"


def _create(collection: str, entity_id: str, data: dict, cookies: dict[str, str]):
    response = client.post(
        f"/api/collections/{collection}",
        json={"id": entity_id, "data": data},
        cookies=cookies,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _customer(customer_id: str, actors) -> dict:
    return _create(
        "customers",
        customer_id,
        {"name": customer_id, "phones": [_phone(customer_id)]},
        actors["admin"],
    )


def _unpaid_receipt(
    receipt_id: str,
    customer_id: str,
    amount: float,
    actors,
    *,
    date: str | None = None,
) -> dict:
    data = {
        "recordType": "receipt",
        "customerId": customer_id,
        "amountUSD": amount,
        "amountLocal": amount * 5,
        "debtAmountUSD": amount,
        "debtAmountLocal": amount * 5,
        "exchangeRate": 5,
        "status": "Not Paid",
        "isPaid": False,
        "deliveryStatus": "Office",
        "statusDetail": {"notPaidCollection": "office"},
    }
    if date:
        data["date"] = date
    return _create("receipts", receipt_id, data, actors["admin"])


def _paid_receipt(
    receipt_id: str, customer_id: str, amount: float, actors
) -> dict:
    return _create(
        "receipts",
        receipt_id,
        {
            "recordType": "receipt",
            "customerId": customer_id,
            "amountUSD": amount,
            "amountLocal": amount * 5,
            "exchangeRate": 5,
            "status": "Paid",
            "isPaid": True,
            "deliveryStatus": "Office",
        },
        actors["admin"],
    )


def _create_ad(
    ad_id: str,
    customer_id: str,
    receipt_id: str,
    due: float,
    actors,
    *,
    paid_allocations: list[dict] | None = None,
    start_date: str | None = None,
) -> dict:
    data = {
        "customerId": customer_id,
        "paymentStatus": "not_paid",
        "collectionMethod": "in_shop",
        "exchangeRate": 5,
        "receiptId": receipt_id,
        "dueAllocations": [{"receiptId": receipt_id, "amountUSD": due}],
        "receiptAllocations": list(paid_allocations or []),
    }
    if start_date:
        data["startDate"] = start_date
    response = client.post(
        "/api/ads/mutate",
        json={
            "action": "create",
            "adId": ad_id,
            "idempotencyKey": f"{ad_id}-create-key",
            "data": data,
        },
        cookies=actors["admin"],
    )
    assert response.status_code == 200, response.text
    return response.json()["ad"]


def _entity(collection: str, entity_id: str, cookies: dict[str, str]) -> dict:
    response = client.get(
        f"/api/collections/{collection}/{entity_id}", cookies=cookies
    )
    assert response.status_code == 200, response.text
    return response.json()


def _cover(
    receipt_id: str,
    amount_minor: int,
    key: str,
    expected: int,
    cookies: dict[str, str],
    *,
    reason: str = "Company-funded customer debt correction",
):
    return client.post(
        f"/api/receipts/{receipt_id}/company-coverages",
        json={
            "amountMinorUSD": amount_minor,
            "idempotencyKey": key,
            "expectedLastModified": expected,
            "reason": reason,
        },
        cookies=cookies,
    )


def _minor(value) -> int:
    return round(float(value or 0) * 100)


def _coverage_minor(data: dict) -> int:
    if data.get("amountMinorUSD") is not None:
        return int(data["amountMinorUSD"])
    return _minor(data.get("amountUSD"))


def _summary_minor(data: dict, key: str) -> int:
    assert data.get(key) is not None, f"Receipt is missing {key}"
    return _minor(data[key])


def _rows_containing(value: str) -> list[dict]:
    with db_conn() as conn:
        return [
            dict(row)
            for row in conn.execute(
                text(
                    "SELECT type,id,data_json,last_modified FROM entities "
                    "WHERE data_json LIKE :value"
                ),
                {"value": f"%{value}%"},
            ).mappings().all()
        ]


def _typed_rows_containing(collection: str, value: str) -> list[dict]:
    with db_conn() as conn:
        return [
            dict(row)
            for row in conn.execute(
                text(
                    "SELECT type,id,data_json,last_modified FROM entities "
                    "WHERE type=:type AND data_json LIKE :value"
                ),
                {"type": collection, "value": f"%{value}%"},
            ).mappings().all()
        ]


def _assert_no_coverage_side_effects(receipt_id: str, key: str) -> None:
    assert _rows_containing(key) == []
    assert _typed_rows_containing(
        main_module.RECEIPT_COMPANY_COVERAGE_COLLECTION, receipt_id
    ) == []
    assert _typed_rows_containing(
        main_module.RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION, key
    ) == []


def _assert_unpaid_provenance(receipt: dict, amount: float) -> None:
    data = receipt["data"]
    assert data["status"] == "Not Paid"
    assert data["isPaid"] is False
    assert _minor(data["amountUSD"]) == _minor(amount)
    assert _minor(data["amountLocal"]) == _minor(amount * 5)


def test_partial_coverage_is_admin_only_and_preserves_unpaid_provenance(actors):
    customer_id = "company_cover_partial_customer"
    receipt_id = "company_cover_partial_receipt"
    ad_id = "company_cover_partial_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 100, actors)
    ad = _create_ad(ad_id, customer_id, receipt_id, 100, actors)
    key = "company-cover-partial-001"

    denied = _cover(
        receipt_id,
        4_000,
        key,
        receipt["lastModified"],
        actors["employee"],
    )
    assert denied.status_code == 403, denied.text
    assert _entity("receipts", receipt_id, actors["admin"]) == receipt
    assert _entity("ads", ad_id, actors["admin"]) == ad
    _assert_no_coverage_side_effects(receipt_id, key)

    covered = _cover(
        receipt_id,
        4_000,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert covered.status_code == 200, covered.text
    body = covered.json()
    assert body["replayed"] is False
    coverage = body["coverage"]
    coverage_data = coverage["data"]
    assert _coverage_minor(coverage_data) == 4_000
    assert coverage_data["recordType"] == "companyDebtCoverage"
    assert coverage_data["receiptId"] == receipt_id
    assert coverage_data["customerId"] == customer_id
    assert coverage_data["amountMinorUSD"] == 4_000
    assert coverage_data["amountUSD"] == 40.0
    assert coverage_data["reason"] == "Company-funded customer debt correction"
    assert coverage_data["actorId"] == actors["admin_id"]
    assert coverage_data["coveredAt"]
    assert coverage_data["grossDebtUSD"] == 100.0
    assert coverage_data["companyCoveredBeforeUSD"] == 0.0
    assert coverage_data["companyCoveredAfterUSD"] == 40.0
    assert coverage_data["customerOutstandingBeforeUSD"] == 100.0
    assert coverage_data["customerOutstandingAfterUSD"] == 60.0
    assert coverage_data["unassignedAmountUSD"] == 0.0
    assert isinstance(coverage_data["allocations"], list)
    assert sum(
        _coverage_minor(allocation)
        for allocation in coverage_data["allocations"]
    ) == 4_000
    assert coverage_data["customerPayment"] is False
    assert coverage_data["countsAsCustomerRevenue"] is False
    assert coverage_data["source"] == "company_funds"
    assert [item["id"] for item in body["updatedReceipts"]] == [receipt_id]
    assert [item["id"] for item in body["updatedAds"]] == [ad_id]

    saved_receipt = body["updatedReceipts"][0]
    _assert_unpaid_provenance(saved_receipt, 100)
    assert _summary_minor(saved_receipt["data"], "companyCoveredUSD") == 4_000
    assert _summary_minor(saved_receipt["data"], "customerOutstandingUSD") == 6_000
    assert saved_receipt["data"]["companyCoverageCount"] == 1
    assert saved_receipt["data"]["lastCompanyCoverageId"] == coverage["id"]
    assert (
        saved_receipt["data"]["lastCompanyCoverageAt"]
        == coverage_data["coveredAt"]
    )
    saved_ad = body["updatedAds"][0]["data"]
    assert saved_ad["dueAllocations"] == [
        {"receiptId": receipt_id, "amountUSD": 60.0}
    ]
    assert saved_ad["companyFundingAllocations"] == [
        {"receiptId": receipt_id, "amountUSD": 40.0}
    ]


def test_full_coverage_clears_customer_liability_but_not_gross_receipt(actors):
    customer_id = "company_cover_full_customer"
    receipt_id = "company_cover_full_receipt"
    ad_id = "company_cover_full_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 100, actors)
    _create_ad(ad_id, customer_id, receipt_id, 100, actors)

    response = _cover(
        receipt_id,
        10_000,
        "company-cover-full-001",
        receipt["lastModified"],
        actors["admin"],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    saved_receipt = body["updatedReceipts"][0]
    _assert_unpaid_provenance(saved_receipt, 100)
    assert _summary_minor(saved_receipt["data"], "companyCoveredUSD") == 10_000
    assert _summary_minor(saved_receipt["data"], "customerOutstandingUSD") == 0
    saved_ad = body["updatedAds"][0]["data"]
    assert saved_ad["paymentStatus"] == "not_paid"
    assert saved_ad["dueAllocations"] == []
    assert saved_ad["companyFundingAllocations"] == [
        {"receiptId": receipt_id, "amountUSD": 100.0}
    ]


def test_idempotent_replay_and_changed_payload_conflict(actors):
    customer_id = "company_cover_replay_customer"
    receipt_id = "company_cover_replay_receipt"
    ad_id = "company_cover_replay_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 30, actors)
    _create_ad(ad_id, customer_id, receipt_id, 30, actors)
    key = "company-cover-replay-001"
    reason = "Approved company debt coverage"

    first = _cover(
        receipt_id,
        1_000,
        key,
        receipt["lastModified"],
        actors["admin"],
        reason=reason,
    )
    replay = _cover(
        receipt_id,
        1_000,
        key,
        receipt["lastModified"],
        actors["admin"],
        reason=reason,
    )
    assert first.status_code == replay.status_code == 200
    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert replay.json()["coverage"] == first.json()["coverage"]
    assert replay.json()["updatedReceipts"] == first.json()["updatedReceipts"]
    assert replay.json()["updatedAds"] == first.json()["updatedAds"]

    stored_receipt = _entity("receipts", receipt_id, actors["admin"])
    stored_ad = _entity("ads", ad_id, actors["admin"])
    for changed in (
        _cover(
            receipt_id,
            1_001,
            key,
            receipt["lastModified"],
            actors["admin"],
            reason=reason,
        ),
        _cover(
            receipt_id,
            1_000,
            key,
            receipt["lastModified"],
            actors["admin"],
            reason="A different reason",
        ),
    ):
        assert changed.status_code == 409, changed.text
        assert "Idempotency key" in changed.text
    assert _entity("receipts", receipt_id, actors["admin"]) == stored_receipt
    assert _entity("ads", ad_id, actors["admin"]) == stored_ad


def test_stale_version_conflicts_without_consuming_idempotency_key(actors):
    customer_id = "company_cover_stale_customer"
    receipt_id = "company_cover_stale_receipt"
    ad_id = "company_cover_stale_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 25, actors)
    ad = _create_ad(ad_id, customer_id, receipt_id, 25, actors)
    key = "company-cover-stale-001"

    stale = _cover(
        receipt_id,
        500,
        key,
        receipt["lastModified"] - 1,
        actors["admin"],
    )
    assert stale.status_code == 409, stale.text
    assert "Conflict" in stale.text
    assert _entity("receipts", receipt_id, actors["admin"]) == receipt
    assert _entity("ads", ad_id, actors["admin"]) == ad
    _assert_no_coverage_side_effects(receipt_id, key)

    corrected = _cover(
        receipt_id,
        500,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["replayed"] is False


def test_overpay_is_bounded_by_outstanding_liability_and_rolls_back(actors):
    customer_id = "company_cover_overpay_customer"
    receipt_id = "company_cover_overpay_receipt"
    ad_id = "company_cover_overpay_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 20, actors)
    ad = _create_ad(ad_id, customer_id, receipt_id, 15, actors)
    key = "company-cover-overpay-001"

    rejected = _cover(
        receipt_id,
        2_001,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert rejected.status_code == 409, rejected.text
    assert _entity("receipts", receipt_id, actors["admin"]) == receipt
    assert _entity("ads", ad_id, actors["admin"]) == ad
    _assert_no_coverage_side_effects(receipt_id, key)

    exact = _cover(
        receipt_id,
        2_000,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert exact.status_code == 200, exact.text
    exact_body = exact.json()
    assert _coverage_minor(exact_body["coverage"]["data"]) == 2_000
    assert exact_body["coverage"]["data"]["unassignedAmountUSD"] == 5.0
    assert _summary_minor(
        exact_body["updatedReceipts"][0]["data"], "customerOutstandingUSD"
    ) == 0
    assert exact_body["updatedAds"][0]["data"]["dueAllocations"] == []
    assert exact_body["updatedAds"][0]["data"][
        "companyFundingAllocations"
    ] == [{"receiptId": receipt_id, "amountUSD": 15.0}]


def test_closed_financial_period_rejects_without_side_effects(actors):
    customer_id = "company_cover_closed_customer"
    receipt_id = "company_cover_closed_receipt"
    ad_id = "company_cover_closed_ad"
    period = "2019-04"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(
        receipt_id, customer_id, 40, actors, date=f"{period}-15"
    )
    ad = _create_ad(
        ad_id,
        customer_id,
        receipt_id,
        40,
        actors,
        start_date=f"{period}-15",
    )
    closed = client.post(
        "/api/admin/operations/financial-periods/close",
        json={
            "period": period,
            "forceReason": "Test company coverage period protection",
        },
        cookies=actors["admin"],
    )
    assert closed.status_code == 200, closed.text
    key = "company-cover-closed-001"
    try:
        rejected = _cover(
            receipt_id,
            1_000,
            key,
            receipt["lastModified"],
            actors["admin"],
        )
        assert rejected.status_code == 423, rejected.text
        assert period in rejected.text
        assert _entity("receipts", receipt_id, actors["admin"]) == receipt
        assert _entity("ads", ad_id, actors["admin"]) == ad
        _assert_no_coverage_side_effects(receipt_id, key)
    finally:
        unlocked = client.post(
            f"/api/admin/operations/financial-periods/{period}/unlock",
            json={"reason": "Restore period after company coverage test"},
            cookies=actors["admin"],
        )
        assert unlocked.status_code == 200, unlocked.text


def test_mixed_paid_and_due_funding_preserves_customer_paid_rows(actors):
    customer_id = "company_cover_mixed_customer"
    paid_receipt_id = "company_cover_mixed_paid_receipt"
    due_receipt_id = "company_cover_mixed_due_receipt"
    ad_id = "company_cover_mixed_ad"
    _customer(customer_id, actors)
    paid_receipt = _paid_receipt(paid_receipt_id, customer_id, 40, actors)
    due_receipt = _unpaid_receipt(due_receipt_id, customer_id, 60, actors)
    ad = _create_ad(
        ad_id,
        customer_id,
        due_receipt_id,
        60,
        actors,
        paid_allocations=[
            {"receiptId": paid_receipt_id, "amountUSD": 40}
        ],
    )
    original_paid_rows = ad["data"]["receiptAllocations"]

    covered = _cover(
        due_receipt_id,
        2_500,
        "company-cover-mixed-001",
        due_receipt["lastModified"],
        actors["admin"],
    )
    assert covered.status_code == 200, covered.text
    body = covered.json()
    assert [item["id"] for item in body["updatedReceipts"]] == [due_receipt_id]
    assert [item["id"] for item in body["updatedAds"]] == [ad_id]
    saved = body["updatedAds"][0]["data"]
    assert saved["receiptAllocations"] == original_paid_rows
    assert saved["dueAllocations"] == [
        {"receiptId": due_receipt_id, "amountUSD": 35.0}
    ]
    assert saved["companyFundingAllocations"] == [
        {"receiptId": due_receipt_id, "amountUSD": 25.0}
    ]
    assert saved["customerDueUSD"] == 35.0
    assert saved["companyFundedUSD"] == 25.0
    assert _minor(saved["amountUSD"]) == _minor(ad["data"]["amountUSD"])
    assert saved["paymentStatus"] == "not_paid"
    assert _summary_minor(
        body["updatedReceipts"][0]["data"], "companyCoveredUSD"
    ) == 2_500
    assert _summary_minor(
        body["updatedReceipts"][0]["data"], "customerOutstandingUSD"
    ) == 3_500
    assert _entity("receipts", paid_receipt_id, actors["admin"]) == paid_receipt
    assert 4_000 + 3_500 + 2_500 == 10_000


def test_marker_write_failure_rolls_back_coverage_receipt_and_ads(
    actors, monkeypatch
):
    customer_id = "company_cover_rollback_customer"
    receipt_id = "company_cover_rollback_receipt"
    ad_id = "company_cover_rollback_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 50, actors)
    ad = _create_ad(ad_id, customer_id, receipt_id, 50, actors)
    key = "company-cover-rollback-001"
    original_marker = main_module._financial_insert_marker
    marker_collection = main_module.RECEIPT_COMPANY_COVERAGE_MUTATION_COLLECTION

    def fail_marker(
        conn,
        collection,
        namespace,
        idempotency_key,
        actor_id,
        request_hash,
        result,
    ):
        if collection == marker_collection:
            raise HTTPException(status_code=500, detail="forced marker failure")
        return original_marker(
            conn,
            collection,
            namespace,
            idempotency_key,
            actor_id,
            request_hash,
            result,
        )

    monkeypatch.setattr(main_module, "_financial_insert_marker", fail_marker)
    failed = _cover(
        receipt_id,
        2_000,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert failed.status_code == 500, failed.text
    assert _entity("receipts", receipt_id, actors["admin"]) == receipt
    assert _entity("ads", ad_id, actors["admin"]) == ad
    _assert_no_coverage_side_effects(receipt_id, key)

    monkeypatch.setattr(main_module, "_financial_insert_marker", original_marker)
    retry = _cover(
        receipt_id,
        2_000,
        key,
        receipt["lastModified"],
        actors["admin"],
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["replayed"] is False


def test_sanitized_blank_reason_is_rejected_without_side_effects(actors):
    customer_id = "company_cover_blank_reason_customer"
    receipt_id = "company_cover_blank_reason_receipt"
    ad_id = "company_cover_blank_reason_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 20, actors)
    ad = _create_ad(ad_id, customer_id, receipt_id, 20, actors)

    for index, reason in enumerate(("        ", "javascript:alert(1)"), start=1):
        key = f"company-cover-blank-reason-{index:03d}"
        rejected = _cover(
            receipt_id,
            500,
            key,
            receipt["lastModified"],
            actors["admin"],
            reason=reason,
        )
        assert rejected.status_code == 400, rejected.text
        assert "reason" in rejected.json()["detail"].lower()
        _assert_no_coverage_side_effects(receipt_id, key)

    assert _entity("receipts", receipt_id, actors["admin"]) == receipt
    assert _entity("ads", ad_id, actors["admin"]) == ad


def test_coverage_ledger_is_immutable_across_generic_admin_paths(
    actors, monkeypatch
):
    customer_id = "company_cover_immutable_customer"
    receipt_id = "company_cover_immutable_receipt"
    ad_id = "company_cover_immutable_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 30, actors)
    _create_ad(ad_id, customer_id, receipt_id, 30, actors)
    covered = _cover(
        receipt_id,
        500,
        "company-cover-immutable-001",
        receipt["lastModified"],
        actors["admin"],
    )
    assert covered.status_code == 200, covered.text
    coverage = covered.json()["coverage"]
    coverage_id = coverage["id"]
    collection = main_module.RECEIPT_COMPANY_COVERAGE_COLLECTION
    fake_id = "forged_company_coverage_record"

    attempts = (
        client.post(
            f"/api/collections/{collection}",
            json={
                "id": fake_id,
                "data": {"recordType": "companyDebtCoverage", "amountUSD": 999},
            },
            cookies=actors["admin"],
        ),
        client.patch(
            f"/api/collections/{collection}/{coverage_id}",
            json={"data": {"amountUSD": 999}},
            cookies=actors["admin"],
        ),
        client.delete(
            f"/api/collections/{collection}/{coverage_id}",
            cookies=actors["admin"],
        ),
        client.post(
            "/api/batch/delete",
            json={"items": [{"collection": collection, "id": coverage_id}]},
            cookies=actors["admin"],
        ),
        client.put(
            f"/api/admin/collections/{collection}/{fake_id}/restore",
            json={
                "data": {"id": fake_id, "recordType": "companyDebtCoverage"},
                "deleted": False,
            },
            cookies=actors["admin"],
        ),
    )
    for response in attempts:
        assert response.status_code == 405, response.text

    monkeypatch.setattr(main_module, "ENABLE_ONLINE_IMPORT", True)
    imported = client.post(
        "/api/admin/import",
        json={
            "collections": {
                collection: [
                    {"id": fake_id, "recordType": "companyDebtCoverage"}
                ]
            }
        },
        cookies=actors["admin"],
    )
    assert imported.status_code == 405, imported.text
    assert _entity(collection, coverage_id, actors["admin"]) == coverage
    assert _typed_rows_containing(collection, fake_id) == []


def test_coverage_owned_fields_reject_forgery_and_allow_unchanged_echoes(
    actors, monkeypatch
):
    customer_id = "company_cover_fields_customer"
    receipt_id = "company_cover_fields_receipt"
    ad_id = "company_cover_fields_ad"
    _customer(customer_id, actors)
    receipt = _unpaid_receipt(receipt_id, customer_id, 50, actors)
    _create_ad(ad_id, customer_id, receipt_id, 50, actors)
    covered = _cover(
        receipt_id,
        1_000,
        "company-cover-fields-001",
        receipt["lastModified"],
        actors["admin"],
    )
    assert covered.status_code == 200, covered.text
    receipt_before = covered.json()["updatedReceipts"][0]
    ad_before = covered.json()["updatedAds"][0]

    forged_receipt_values = {
        "companyCoveredUSD": 999.0,
        "customerOutstandingUSD": 0.0,
        "companyCoverageCount": 999,
        "lastCompanyCoverageAt": "2099-01-01T00:00:00Z",
        "lastCompanyCoverageId": "forged_company_coverage_id",
    }
    for field in coverage_module.RECEIPT_COMPANY_COVERAGE_FIELDS:
        rejected = client.patch(
            f"/api/collections/receipts/{receipt_id}",
            json={
                "data": {field: forged_receipt_values[field]},
                "expectedLastModified": receipt_before["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert rejected.status_code == 405, (field, rejected.text)

    forged_ad_values = {
        "companyFundingAllocations": [],
        "customerDueUSD": 999.0,
        "companyFundedUSD": 999.0,
        "companyDirectCoverageUSD": 999.0,
    }
    for field in coverage_module.AD_COMPANY_COVERAGE_FIELDS:
        rejected = client.patch(
            f"/api/collections/ads/{ad_id}",
            json={
                "data": {field: forged_ad_values[field]},
                "expectedLastModified": ad_before["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert rejected.status_code == 405, (field, rejected.text)

    assert _entity("receipts", receipt_id, actors["admin"]) == receipt_before
    assert _entity("ads", ad_id, actors["admin"]) == ad_before

    for collection, entity_id, data in (
        (
            "receipts",
            "company_cover_forged_create_receipt",
            {"companyCoveredUSD": 500.0},
        ),
        (
            "ads",
            "company_cover_forged_create_ad",
            {"companyFundingAllocations": []},
        ),
    ):
        rejected = client.post(
            f"/api/collections/{collection}",
            json={"id": entity_id, "data": data},
            cookies=actors["admin"],
        )
        assert rejected.status_code == 405, rejected.text

    receipt_echo = {
        field: receipt_before["data"][field]
        for field in coverage_module.RECEIPT_COMPANY_COVERAGE_FIELDS
    }
    receipt_echo["note"] = "Unrelated receipt edit"
    receipt_edit = client.patch(
        f"/api/collections/receipts/{receipt_id}",
        json={
            "data": receipt_echo,
            "expectedLastModified": receipt_before["lastModified"],
        },
        cookies=actors["admin"],
    )
    assert receipt_edit.status_code == 200, receipt_edit.text
    receipt_after = receipt_edit.json()
    assert receipt_after["data"]["note"] == "Unrelated receipt edit"
    for field, value in receipt_echo.items():
        if field != "note":
            assert receipt_after["data"][field] == value

    ad_echo = {
        field: ad_before["data"][field]
        for field in coverage_module.AD_COMPANY_COVERAGE_FIELDS
        if field in ad_before["data"]
    }
    ad_echo["title"] = "Unrelated ad edit"
    ad_edit = client.patch(
        f"/api/collections/ads/{ad_id}",
        json={
            "data": ad_echo,
            "expectedLastModified": ad_before["lastModified"],
        },
        cookies=actors["admin"],
    )
    assert ad_edit.status_code == 200, ad_edit.text
    ad_after = ad_edit.json()
    assert ad_after["data"]["title"] == "Unrelated ad edit"
    for field, value in ad_echo.items():
        if field != "title":
            assert ad_after["data"][field] == value

    settle_smuggle = client.post(
        f"/api/receipts/{receipt_id}/settle",
        json={
            "idempotencyKey": "company-cover-fields-settle-smuggle",
            "expectedLastModified": receipt_after["lastModified"],
            "data": {"companyCoveredUSD": 0},
        },
        cookies=actors["admin"],
    )
    assert settle_smuggle.status_code == 405, settle_smuggle.text

    forged_ad_data = dict(ad_after["data"])
    forged_ad_data["companyFundedUSD"] = 999.0
    ad_smuggle = client.post(
        "/api/ads/mutate",
        json={
            "action": "update",
            "adId": ad_id,
            "idempotencyKey": "company-cover-fields-ad-smuggle",
            "expectedLastModified": ad_after["lastModified"],
            "data": forged_ad_data,
        },
        cookies=actors["admin"],
    )
    assert ad_smuggle.status_code == 405, ad_smuggle.text

    monkeypatch.setattr(main_module, "ENABLE_ONLINE_IMPORT", True)
    for collection, entity_id, data in (
        (
            "receipts",
            "company_cover_forged_import_receipt",
            {"companyCoveredUSD": 500.0},
        ),
        (
            "ads",
            "company_cover_forged_import_ad",
            {"companyFundingAllocations": []},
        ),
    ):
        imported = client.post(
            "/api/admin/import",
            json={"collections": {collection: [{"id": entity_id, **data}]}},
            cookies=actors["admin"],
        )
        assert imported.status_code == 405, imported.text

    assert _entity("receipts", receipt_id, actors["admin"]) == receipt_after
    assert _entity("ads", ad_id, actors["admin"]) == ad_after


# ---------------------------------------------------------------------------
# Bug-hunt 2026-08-22: a partially company-covered ad must still stop /
# reconcile at its REAL spend. _financial_apply_stop built its spend ceiling
# from the customer's pools only, so after coverage moved $40 of a $100 due
# row into companyFundingAllocations any stop above the remaining $60 was
# refused with 409 — forcing under-reported spend and a wrong balance.
# ---------------------------------------------------------------------------

def _stop(ad_id: str, spent_minor: int, key: str, expected: int, cookies):
    return client.post(
        f"/api/ads/{ad_id}/stop",
        json={
            "spentMinorUSD": spent_minor,
            "customerInformed": True,
            "idempotencyKey": key,
            "expectedLastModified": expected,
        },
        cookies=cookies,
    )


def test_partially_covered_ad_stops_at_its_real_spend(actors):
    _create("customers", "stopcov_cust1", {"name": "Stop Cov", "phones": ["0911111001"]}, actors["admin"])
    _create("receipts", "stopcov_r1", {
        "recordType": "receipt", "customerId": "stopcov_cust1",
        "amountUSD": 100, "amountLocal": 500, "debtAmountUSD": 100, "debtAmountLocal": 500,
        "exchangeRate": 5, "status": "Not Paid", "isPaid": False,
        "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"},
    }, actors["admin"])
    ad = _create_ad("stopcov_ad1", "stopcov_cust1", "stopcov_r1", 100, actors)
    assert float(ad["data"]["amountUSD"]) == 100.0

    receipt = _entity("receipts", "stopcov_r1", actors["admin"])
    covered = _cover("stopcov_r1", 4000, "stopcov-cover-1", receipt["lastModified"], actors["admin"])
    assert covered.status_code == 200, covered.text
    ad_after_cover = _entity("ads", "stopcov_ad1", actors["admin"])
    assert ad_after_cover["data"]["dueAllocations"] == [{"receiptId": "stopcov_r1", "amountUSD": 60.0}]
    assert ad_after_cover["data"]["companyFundingAllocations"] == [{"receiptId": "stopcov_r1", "amountUSD": 40.0}]

    # The incident: $80 of real spend against $60 customer + $40 company.
    stopped = _stop("stopcov_ad1", 8000, "stopcov-stop-80", ad_after_cover["lastModified"], actors["admin"])
    assert stopped.status_code == 200, stopped.text
    saved = stopped.json()["ad"]["data"]
    assert float(saved["spentUSD"]) == 80.0
    assert saved["status"] == "Stopped"
    # Company money is consumed FIRST and never re-planned; only the customer's
    # pool shrinks: 80 spent − 40 company = 40 still promised by the customer,
    # and the unspent $20 of their debt is released back to the receipt.
    assert saved["dueAllocations"] == [{"receiptId": "stopcov_r1", "amountUSD": 40.0}]
    assert saved["companyFundingAllocations"] == [{"receiptId": "stopcov_r1", "amountUSD": 40.0}]


def test_partially_covered_ad_can_stop_at_full_budget_but_not_above(actors):
    _create("customers", "stopcov_cust2", {"name": "Stop Cov 2", "phones": ["0911111002"]}, actors["admin"])
    _create("receipts", "stopcov_r2", {
        "recordType": "receipt", "customerId": "stopcov_cust2",
        "amountUSD": 100, "amountLocal": 500, "debtAmountUSD": 100, "debtAmountLocal": 500,
        "exchangeRate": 5, "status": "Not Paid", "isPaid": False,
        "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"},
    }, actors["admin"])
    _create_ad("stopcov_ad2", "stopcov_cust2", "stopcov_r2", 100, actors)
    receipt = _entity("receipts", "stopcov_r2", actors["admin"])
    assert _cover("stopcov_r2", 4000, "stopcov-cover-2", receipt["lastModified"], actors["admin"]).status_code == 200
    ad = _entity("ads", "stopcov_ad2", actors["admin"])

    # Above the ad's own budget is still a plain 400, unchanged.
    too_much = _stop("stopcov_ad2", 10100, "stopcov-stop-101", ad["lastModified"], actors["admin"])
    assert too_much.status_code == 400, too_much.text

    # Exactly the budget: customer keeps their full $60 share, company its $40.
    full = _stop("stopcov_ad2", 10000, "stopcov-stop-100", ad["lastModified"], actors["admin"])
    assert full.status_code == 200, full.text
    saved = full.json()["ad"]["data"]
    assert float(saved["spentUSD"]) == 100.0
    assert saved["dueAllocations"] == [{"receiptId": "stopcov_r2", "amountUSD": 60.0}]
    assert saved["companyFundingAllocations"] == [{"receiptId": "stopcov_r2", "amountUSD": 40.0}]
