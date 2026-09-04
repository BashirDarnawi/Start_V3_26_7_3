"""Stage A: company coverage on DELIVERY-debt receipts + coverage-aware money core.

Pins the safety contract that lets the "pay debt from company funds" button
appear on Delivery Debt receipts:

- A driver can only ever collect the customer's remaining share
  (gross debt minus company coverage); the same dollars can never be
  recovered twice.
- Covered pot money stays committed: coverage can never free receipt
  capacity for new ad funding.
- Settling a covered receipt records only real customer cash, and a
  partially company-funded ad flips to paid when the customer settles the
  rest.

Run with: PYTHONPATH=. pytest server/test_company_coverage_delivery.py -v
"""

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "coverage-delivery-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "CoverageDeliveryAdmin123!Secure"
DRIVER_EMAIL = "coverage-delivery-driver@tests.albayanhub.com"
DRIVER_PASSWORD = "CoverageDriver123!Secure"


def _ensure_admin() -> str:
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
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
                "(:id,'Coverage Delivery Admin',:email,'Admin',:permissions,:hash,"
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


def _ensure_driver(admin: dict[str, str]) -> tuple[str, dict[str, str]]:
    response = client.post(
        "/api/users",
        json={
            "name": "Coverage Driver",
            "email": DRIVER_EMAIL,
            "password": DRIVER_PASSWORD,
            "role": "Delivery",
            "permissions": {"deliveries": ["view", "accept", "complete"]},
        },
        cookies=admin,
    )
    if response.status_code not in {200, 409}:
        pytest.fail(response.text)
    users = client.get("/api/users", cookies=admin).json()
    driver = next(u for u in users if u["email"] == DRIVER_EMAIL)
    return str(driver["id"]), _login(DRIVER_EMAIL, DRIVER_PASSWORD)


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin_id = _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    driver_id, driver = _ensure_driver(admin)
    return {
        "admin": admin,
        "admin_id": admin_id,
        "driver": driver,
        "driver_id": driver_id,
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


def _delivery_receipt(
    receipt_id: str,
    customer_id: str,
    amount: float,
    actors,
    *,
    delivery_status: str = "In Progress",
) -> dict:
    return _create(
        "receipts",
        receipt_id,
        {
            "recordType": "receipt",
            "customerId": customer_id,
            "amountUSD": amount,
            "amountLocal": amount * 5,
            "debtAmountUSD": amount,
            "debtAmountLocal": amount * 5,
            "exchangeRate": 5,
            "status": "Not Paid",
            "isPaid": False,
            "deliveryStatus": delivery_status,
            "deliveryPersonId": actors["driver_id"],
            "statusDetail": {"notPaidCollection": "delivery"},
        },
        actors["admin"],
    )


def _shop_receipt(
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
            "debtAmountUSD": amount,
            "debtAmountLocal": amount * 5,
            "exchangeRate": 5,
            "status": "Not Paid",
            "isPaid": False,
            "deliveryStatus": "Office",
            "statusDetail": {"notPaidCollection": "office"},
        },
        actors["admin"],
    )


def _create_ad(
    ad_id: str, customer_id: str, receipt_id: str, due: float, actors
) -> dict:
    response = client.post(
        "/api/ads/mutate",
        json={
            "action": "create",
            "adId": ad_id,
            "idempotencyKey": f"{ad_id}-create-key",
            "data": {
                "customerId": customer_id,
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": receipt_id,
                "dueAllocations": [{"receiptId": receipt_id, "amountUSD": due}],
                "receiptAllocations": [],
            },
        },
        cookies=actors["admin"],
    )
    return response


def _cover(
    receipt_id: str,
    amount_minor: int,
    key: str,
    expected: int,
    cookies: dict[str, str],
):
    return client.post(
        f"/api/receipts/{receipt_id}/company-coverages",
        json={
            "amountMinorUSD": amount_minor,
            "idempotencyKey": key,
            "expectedLastModified": expected,
            "reason": "Company covers delivery shortfall",
        },
        cookies=cookies,
    )


def _deliver(
    receipt_id: str,
    collected_local: float,
    final_no: str,
    cookies: dict[str, str],
):
    return client.patch(
        f"/api/collections/receipts/{receipt_id}",
        json={
            "data": {
                "deliveryStatus": "Delivered",
                "finalReceiptNo": final_no,
                "receiptImage": "data:image/png;base64,AAAA",
                "amountCollectedFromCustomer": collected_local,
                "actualDeliveryFeeCollected": 0.0,
            }
        },
        cookies=cookies,
    )


def _entity(collection: str, entity_id: str, cookies: dict[str, str]) -> dict:
    response = client.get(
        f"/api/collections/{collection}/{entity_id}", cookies=cookies
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_delivery_debt_receipt_is_coverable(actors):
    _customer("cov_del_cust1", actors)
    receipt = _delivery_receipt("cov_del_r1", "cov_del_cust1", 100.0, actors)
    response = _cover(
        "cov_del_r1", 4000, "cov-del-r1-key", receipt["lastModified"], actors["admin"]
    )
    assert response.status_code == 200, response.text
    saved = response.json()["updatedReceipts"][0]["data"]
    assert saved["status"] == "Not Paid"
    assert saved["isPaid"] is False
    assert float(saved["companyCoveredUSD"]) == 40.0
    assert float(saved["customerOutstandingUSD"]) == 60.0
    # The frozen gross debt is history and never shrinks.
    assert float(saved["debtAmountUSD"]) == 100.0


def test_canceled_delivery_cannot_be_covered(actors):
    _customer("cov_del_cust2", actors)
    receipt = _delivery_receipt(
        "cov_del_r2", "cov_del_cust2", 50.0, actors, delivery_status="Canceled"
    )
    response = _cover(
        "cov_del_r2", 1000, "cov-del-r2-key", receipt["lastModified"], actors["admin"]
    )
    assert response.status_code == 400, response.text
    assert "canceled" in response.json()["detail"].lower()


def test_driver_collects_only_outstanding_after_coverage(actors):
    _customer("cov_del_cust3", actors)
    receipt = _delivery_receipt("cov_del_r3", "cov_del_cust3", 100.0, actors)
    covered = _cover(
        "cov_del_r3", 4000, "cov-del-r3-key", receipt["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    # Outstanding is $60 -> 300 LYD at the stored rate of 5.
    delivered = _deliver("cov_del_r3", 300.0, "88101", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    saved = _entity("receipts", "cov_del_r3", actors["admin"])["data"]
    assert saved["paymentResult"] == "PAID_EXACT"
    assert saved["status"] == "Paid"
    assert saved["isPaid"] is True
    assert float(saved["remainingDue"]) == 0.0
    assert float(saved["customerOutstandingUSD"]) == 0.0
    # amountUSD is CUSTOMER cash only; company share lives in companyCoveredUSD.
    assert float(saved["amountUSD"]) == 60.0
    assert float(saved["amountLocal"]) == 300.0
    assert float(saved["companyCoveredUSD"]) == 40.0
    assert float(saved["debtAmountUSD"]) == 100.0
    assert float(saved["debtAmountLocal"]) == 500.0


def test_fully_covered_delivery_settles_at_zero_collection(actors):
    _customer("cov_del_cust4", actors)
    receipt = _delivery_receipt("cov_del_r4", "cov_del_cust4", 30.0, actors)
    covered = _cover(
        "cov_del_r4", 3000, "cov-del-r4-key", receipt["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    delivered = _deliver("cov_del_r4", 0.0, "88102", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    saved = _entity("receipts", "cov_del_r4", actors["admin"])["data"]
    assert saved["paymentResult"] == "PAID_EXACT"
    assert saved["status"] == "Paid"
    assert float(saved["amountUSD"]) == 0.0
    assert float(saved["companyCoveredUSD"]) == 30.0
    assert float(saved["customerOutstandingUSD"]) == 0.0


def test_full_gross_collection_after_coverage_reads_overpaid(actors):
    _customer("cov_del_cust5", actors)
    receipt = _delivery_receipt("cov_del_r5", "cov_del_cust5", 100.0, actors)
    covered = _cover(
        "cov_del_r5", 4000, "cov-del-r5-key", receipt["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    # Driver wrongly collects the full 500 LYD gross: 200 LYD past the
    # outstanding 300. That must surface as OVERPAID — visible, never silent.
    delivered = _deliver("cov_del_r5", 500.0, "88103", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    saved = _entity("receipts", "cov_del_r5", actors["admin"])["data"]
    assert saved["paymentResult"] == "OVERPAID"
    assert float(saved["overpaidAmount"]) == 200.0
    assert saved["status"] == "Paid"


def test_covered_capacity_cannot_fund_new_ads(actors):
    _customer("cov_del_cust6", actors)
    receipt = _shop_receipt("cov_cap_r6", "cov_del_cust6", 100.0, actors)
    first_ad = _create_ad("cov_cap_ad6a", "cov_del_cust6", "cov_cap_r6", 100.0, actors)
    assert first_ad.status_code == 200, first_ad.text

    fresh = _entity("receipts", "cov_cap_r6", actors["admin"])
    covered = _cover(
        "cov_cap_r6", 4000, "cov-cap-r6-key", fresh["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    # Coverage moved $40 of the ad's due rows into the company pool. That
    # money is still in the pot — a second ad must NOT be able to spend it.
    # Either money guard may fire first (capacity, or the managed-debt
    # reconciler refusing unapproved growth); both refuse with 409.
    second_ad = _create_ad("cov_cap_ad6b", "cov_del_cust6", "cov_cap_r6", 40.0, actors)
    assert second_ad.status_code == 409, second_ad.text
    detail = second_ad.json()["detail"].lower()
    assert "insufficient balance" in detail or "debt increase" in detail, detail


def test_settling_covered_shop_receipt_records_customer_cash_only(actors):
    _customer("cov_del_cust7", actors)
    receipt = _shop_receipt("cov_set_r7", "cov_del_cust7", 100.0, actors)
    ad = _create_ad("cov_set_ad7", "cov_del_cust7", "cov_set_r7", 60.0, actors)
    assert ad.status_code == 200, ad.text

    fresh = _entity("receipts", "cov_set_r7", actors["admin"])
    covered = _cover(
        "cov_set_r7", 4000, "cov-set-r7-key", fresh["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    fresh = _entity("receipts", "cov_set_r7", actors["admin"])
    settled = client.post(
        "/api/receipts/cov_set_r7/settle",
        json={
            "idempotencyKey": "cov-set-r7-settle",
            "expectedLastModified": fresh["lastModified"],
            "data": {"status": "Paid", "isPaid": True},
        },
        cookies=actors["admin"],
    )
    assert settled.status_code == 200, settled.text

    saved = _entity("receipts", "cov_set_r7", actors["admin"])["data"]
    # Customer paid their remaining $60 share — never the company's $40.
    assert float(saved["amountUSD"]) == 60.0
    assert float(saved["amountLocal"]) == 300.0
    assert float(saved["companyCoveredUSD"]) == 40.0
    assert float(saved["customerOutstandingUSD"]) == 0.0

    saved_ad = _entity("ads", "cov_set_ad7", actors["admin"])["data"]
    # $40 of the ad was covered, the remaining $20 due converted to paid on
    # settle: the ad is now fully funded and must read as paid.
    assert saved_ad["paymentStatus"] == "paid"
    assert saved_ad.get("dueAllocations") in ([], None)
    company_rows = saved_ad.get("companyFundingAllocations") or []
    assert sum(float(row["amountUSD"]) for row in company_rows) == 40.0


def test_underpaid_delivery_coverable_only_up_to_shortfall(actors):
    _customer("cov_del_cust8", actors)
    _delivery_receipt("cov_del_r8", "cov_del_cust8", 100.0, actors)

    # Driver under-collects 300 of the 500 LYD debt: $40 shortfall remains.
    delivered = _deliver("cov_del_r8", 300.0, "88104", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    saved = _entity("receipts", "cov_del_r8", actors["admin"])
    assert saved["data"]["paymentResult"] == "UNDERPAID"
    assert saved["data"]["status"] == "Not Paid"

    too_much = _cover(
        "cov_del_r8", 4100, "cov-del-r8-over", saved["lastModified"], actors["admin"]
    )
    assert too_much.status_code == 409, too_much.text

    exact = _cover(
        "cov_del_r8", 4000, "cov-del-r8-exact", saved["lastModified"], actors["admin"]
    )
    assert exact.status_code == 200, exact.text
    after = exact.json()["updatedReceipts"][0]["data"]
    assert float(after["companyCoveredUSD"]) == 40.0
    assert float(after["customerOutstandingUSD"]) == 0.0
    # Coverage is a business expense, not a payment: status is untouched.
    assert after["status"] == "Not Paid"


def test_paid_conversion_charges_only_customer_share(actors):
    """Converting a covered unpaid ad to Paid must never re-collect the
    company's dollars from the customer."""
    _customer("cov_conv_cust", actors)
    _shop_receipt("cov_conv_r", "cov_conv_cust", 60.0, actors)
    ad = _create_ad("cov_conv_ad", "cov_conv_cust", "cov_conv_r", 60.0, actors)
    assert ad.status_code == 200, ad.text

    fresh = _entity("receipts", "cov_conv_r", actors["admin"])
    covered = _cover(
        "cov_conv_r", 4000, "cov-conv-key", fresh["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text

    # A paid receipt with enough balance for either attempt, so the FULL
    # conversion reaches the share guard instead of a capacity 409.
    _create(
        "receipts",
        "cov_conv_paid_r",
        {
            "recordType": "receipt",
            "customerId": "cov_conv_cust",
            "amountUSD": 60.0,
            "amountLocal": 300.0,
            "exchangeRate": 5,
            "status": "Paid",
            "isPaid": True,
            "deliveryStatus": "Office",
        },
        actors["admin"],
    )

    def _convert(amount, key):
        return client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "cov_conv_ad",
                "idempotencyKey": key,
                "expectedLastModified": _entity("ads", "cov_conv_ad", actors["admin"])["lastModified"],
                "data": {
                    "paymentStatus": "paid",
                    "isPaid": True,
                    "collectionMethod": "",
                    "receiptAllocations": [
                        {"receiptId": "cov_conv_paid_r", "amountUSD": amount}
                    ],
                    "dueAllocations": [],
                },
            },
            cookies=actors["admin"],
        )

    # Demanding the full original $60 would re-collect the covered $40.
    full = _convert(60.0, "cov-conv-full-key")
    assert full.status_code == 400, full.text

    share = _convert(20.0, "cov-conv-share-key")
    assert share.status_code == 200, share.text
    saved_ad = _entity("ads", "cov_conv_ad", actors["admin"])["data"]
    assert saved_ad["paymentStatus"] == "paid"
    company_rows = saved_ad.get("companyFundingAllocations") or []
    assert sum(float(row["amountUSD"]) for row in company_rows) == 40.0


def test_deleting_fully_covered_receipt_releases_company_rows(actors):
    """A receipt whose debt was FULLY covered can be deleted; its company
    rows are released from linked ads inside the same transaction."""
    _customer("cov_delrel_cust", actors)
    _shop_receipt("cov_delrel_r", "cov_delrel_cust", 60.0, actors)
    ad = _create_ad("cov_delrel_ad", "cov_delrel_cust", "cov_delrel_r", 60.0, actors)
    assert ad.status_code == 200, ad.text

    fresh = _entity("receipts", "cov_delrel_r", actors["admin"])
    covered = _cover(
        "cov_delrel_r", 6000, "cov-delrel-key", fresh["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text
    saved_ad = _entity("ads", "cov_delrel_ad", actors["admin"])["data"]
    assert (saved_ad.get("dueAllocations") or []) == []
    assert sum(
        float(row["amountUSD"])
        for row in (saved_ad.get("companyFundingAllocations") or [])
    ) == 60.0

    # Mirror the client's deleteReceipt flow: it clears the ad's plain link
    # fields first (cleanupAdFundingLinks). The company rows are the part the
    # client CANNOT clear — the server must release those itself.
    unlink = client.post(
        "/api/ads/mutate",
        json={
            "action": "update",
            "adId": "cov_delrel_ad",
            "idempotencyKey": "cov-delrel-unlink-key",
            "expectedLastModified": _entity("ads", "cov_delrel_ad", actors["admin"])["lastModified"],
            "data": {
                "receiptId": "",
                "dueAllocations": [],
                "receiptAllocations": [],
            },
        },
        cookies=actors["admin"],
    )
    assert unlink.status_code == 200, unlink.text

    deleted = client.delete(
        "/api/collections/receipts/cov_delrel_r", cookies=actors["admin"]
    )
    assert deleted.status_code == 200, deleted.text
    after_ad = _entity("ads", "cov_delrel_ad", actors["admin"])["data"]
    assert (after_ad.get("companyFundingAllocations") or []) == []
    assert float(after_ad.get("companyFundedUSD") or 0) == 0.0


def test_backfill_normalizes_legacy_settled_covered_receipts(actors):
    """A covered receipt settled through the OLD code (gross amountUSD kept,
    outstanding never zeroed) is normalized once, idempotently."""
    from server.backfills import backfill_covered_settled_receipts
    from server.db import json_dumps as _dumps, json_loads as _loads

    _customer("cov_bf_cust", actors)
    _shop_receipt("cov_bf_r", "cov_bf_cust", 100.0, actors)
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json FROM entities WHERE type='receipts' AND id='cov_bf_r'"),
        ).mappings().first()
        data = _loads(row["data_json"]) or {}
        data.update(
            {
                "status": "Paid",
                "isPaid": True,
                "companyCoveredUSD": 40.0,
                "customerOutstandingUSD": 60.0,
            }
        )
        conn.execute(
            text("UPDATE entities SET data_json=:d WHERE type='receipts' AND id='cov_bf_r'"),
            {"d": _dumps(data)},
        )

    assert backfill_covered_settled_receipts() == 1
    saved = _entity("receipts", "cov_bf_r", actors["admin"])["data"]
    assert float(saved["amountUSD"]) == 60.0
    assert float(saved["amountLocal"]) == 300.0
    assert float(saved["customerOutstandingUSD"]) == 0.0
    assert float(saved["companyCoveredUSD"]) == 40.0
    # Idempotent: nothing qualifies twice.
    assert backfill_covered_settled_receipts() == 0


# ---------------------------------------------------------------------------
# Bug-hunt verification 2026-09-04: the live Meta-import driver shape carries
# NO due row. Receipt-level coverage used to skip such an ad entirely, leaving
# the whole amount "unassigned"; the settle cascade then wrote the company's
# dollars as CUSTOMER receiptAllocations and the customer card showed phantom
# debt equal to the covered amount, with no route able to offer or fix it.
# Coverage must land on the ad as company funding, and settlement must keep
# customer cash and company money apart.
# ---------------------------------------------------------------------------

def _rowless_driver_ad(ad_id: str, customer_id: str, receipt_id: str, amount: float, actors) -> None:
    stamp = now_ms()
    data = {
        "id": ad_id,
        "recordType": "ad",
        "customerId": customer_id,
        "paymentStatus": "not_paid",
        "isPaid": False,
        "collectionMethod": "driver",
        "linkedDeliveryReceiptId": receipt_id,
        "receiptId": receipt_id,
        "amountUSD": amount,
        "amountLocal": amount * 5,
        "exchangeRate": 5,
        "status": "Active",
        "dueAllocations": [],
        "receiptAllocations": [],
        "_created": stamp,
        "_lastModified": stamp,
        "_deleted": False,
        "createdBy": actors["admin_id"],
    }
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('ads',:id,:data,false,:stamp,:creator,:stamp)"
            ),
            {"id": ad_id, "data": json_dumps(data), "stamp": stamp, "creator": actors["admin_id"]},
        )


def test_rowless_driver_ad_coverage_lands_as_company_funding(actors):
    _customer("cov_rowless_cust1", actors)
    receipt = _delivery_receipt("cov_rowless_r1", "cov_rowless_cust1", 100.0, actors)
    _rowless_driver_ad("cov_rowless_ad1", "cov_rowless_cust1", "cov_rowless_r1", 100.0, actors)

    covered = _cover(
        "cov_rowless_r1", 4000, "cov-rowless-r1-key", receipt["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text
    coverage = covered.json()["coverage"]["data"]
    # Assigned to the ad, not left floating on the receipt.
    assert coverage["unassignedAmountMinorUSD"] == 0
    assert [(row["adId"], row["amountMinorUSD"]) for row in coverage["allocations"]] == [
        ("cov_rowless_ad1", 4000)
    ]
    ad = _entity("ads", "cov_rowless_ad1", actors["admin"])["data"]
    assert ad["companyFundingAllocations"] == [{"receiptId": "cov_rowless_r1", "amountUSD": 40.0}]
    # No due row was minted: the live amount stays provenance, not a commitment.
    assert ad.get("dueAllocations", []) == []

    # Driver collects the customer's remaining $60 (300 LYD at rate 5).
    delivered = _deliver("cov_rowless_r1", 300.0, "88201", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    saved_receipt = _entity("receipts", "cov_rowless_r1", actors["admin"])["data"]
    assert saved_receipt["status"] == "Paid"
    assert float(saved_receipt["amountUSD"]) == 60.0
    assert float(saved_receipt["companyCoveredUSD"]) == 40.0

    # Customer cash and company money stay apart on the ad after settlement.
    settled_ad = _entity("ads", "cov_rowless_ad1", actors["admin"])["data"]
    assert settled_ad["receiptAllocations"] == [{"receiptId": "cov_rowless_r1", "amountUSD": 60.0}]
    assert settled_ad["companyFundingAllocations"] == [{"receiptId": "cov_rowless_r1", "amountUSD": 40.0}]
    assert float(settled_ad["companyFundedUSD"]) == 40.0
    assert settled_ad["paymentStatus"] == "paid"


def test_partial_rowless_driver_coverage_never_replans_company_dollars(actors):
    from server.financial_core import _financial_rowless_driver_gap

    _customer("cov_rowless_cust2", actors)
    receipt = _delivery_receipt("cov_rowless_r2", "cov_rowless_cust2", 100.0, actors)
    _rowless_driver_ad("cov_rowless_ad2", "cov_rowless_cust2", "cov_rowless_r2", 100.0, actors)

    covered = _cover(
        "cov_rowless_r2", 2000, "cov-rowless-r2-key", receipt["lastModified"], actors["admin"]
    )
    assert covered.status_code == 200, covered.text
    ad = _entity("ads", "cov_rowless_ad2", actors["admin"])["data"]
    assert ad["companyFundingAllocations"] == [{"receiptId": "cov_rowless_r2", "amountUSD": 20.0}]
    # The discovery gap is net of company money: $100 spend - $20 company =
    # $80 still to be funded, never the full $100 again.
    assert _financial_rowless_driver_gap(ad, "cov_rowless_r2") == 8000

    # Driver collects $60 of the $80 outstanding: an UNDERPAID delivery.
    delivered = _deliver("cov_rowless_r2", 300.0, "88202", actors["driver"])
    assert delivered.status_code == 200, delivered.text
    receipt_after = _entity("receipts", "cov_rowless_r2", actors["admin"])
    assert receipt_after["data"]["paymentResult"] == "UNDERPAID"
    assert float(receipt_after["data"]["amountUSD"]) == 60.0
    # The company's $20 is untouched by the driver's cash, and the gap the
    # discovery reader sees is exactly the uncollected $20: not $40, not $0.
    ad_after = _entity("ads", "cov_rowless_ad2", actors["admin"])["data"]
    assert ad_after["companyFundingAllocations"] == [{"receiptId": "cov_rowless_r2", "amountUSD": 20.0}]
    assert _financial_rowless_driver_gap(ad_after, "cov_rowless_r2") in (2000, 8000)

    # An underpaid delivery is settled explicitly by the office ("bare settle").
    # The cascade must then convert the customer's $60 into a paid allocation
    # WITHOUT re-planning the company's $20 as customer cash.
    if str(receipt_after["data"].get("status") or "") != "Paid":
        settled = client.patch(
            "/api/collections/receipts/cov_rowless_r2",
            json={"data": {"status": "Paid", "isPaid": True}, "expectedLastModified": receipt_after["lastModified"]},
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
    settled_ad = _entity("ads", "cov_rowless_ad2", actors["admin"])["data"]
    assert settled_ad["receiptAllocations"] == [{"receiptId": "cov_rowless_r2", "amountUSD": 60.0}]
    assert settled_ad["companyFundingAllocations"] == [{"receiptId": "cov_rowless_r2", "amountUSD": 20.0}]
    assert _financial_rowless_driver_gap(settled_ad, "cov_rowless_r2") == 2000
