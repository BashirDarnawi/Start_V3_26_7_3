"""Stage B: customer-level company coverage of RECEIPT-LESS ad-spend debt.

The customer card's "Pay debt from company funds" must also work for
customers whose debt comes purely from ad spending (Spent > Paid with no
unpaid receipt). Pins:

- only receipt-less, non-driver, Not Paid ads are coverable;
- the stale-books guard (expectedOutstandingMinorUSD) refuses blind writes;
- covered dollars land in server-owned ``companyDirectCoverageUSD`` with a
  full audit record, replayed idempotently, and can never exceed the debt.

Run with: PYTHONPATH=. pytest server/test_company_coverage_customer.py -v
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
ADMIN_EMAIL = "coverage-customer-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "CoverageCustomerAdmin123!Secure"


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
                "(:id,'Coverage Customer Admin',:email,'Admin',:permissions,:hash,"
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


def _login() -> dict[str, str]:
    response = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def admin():
    init_db()
    _ensure_admin()
    return _login()


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


def _customer(customer_id: str, admin) -> dict:
    return _create(
        "customers",
        customer_id,
        {"name": customer_id, "phones": [_phone(customer_id)]},
        admin,
    )


def _debt_ad(ad_id: str, customer_id: str, amount: float, admin, **overrides) -> dict:
    # Receipt-less ad debt is real SPEND (Meta-synced spentUSD) the customer
    # never funded. spentUSD is server-owned telemetry — the ads/mutate API
    # strips it from client payloads — so model the Meta sync's write with a
    # direct row insert, exactly the shape meta_ads.py persists.
    data = {
        "id": ad_id,
        "recordType": "ad",
        "customerId": customer_id,
        "customerName": customer_id,
        "paymentStatus": "not_paid",
        "isPaid": False,
        "collectionMethod": "in_shop",
        "exchangeRate": 5,
        "spentUSD": amount,
        "amountUSD": 0.0,
        "amountLocal": 0.0,
        "dueAllocations": [],
        "receiptAllocations": [],
        # Completed = the terminal Meta shape whose spentUSD is the real,
        # final spend. Coverable debt is STATUS-AWARE (mirrors the customer
        # card's "Spent"): an Active/pending ad with no booked amount shows
        # no debt yet, so it must offer nothing to cover either.
        "status": "Completed",
    }
    data.update(overrides)
    now = now_ms()
    data["_created"] = now
    data["_lastModified"] = now
    data["_deleted"] = False
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,"
                "created_by,last_modified) VALUES ('ads',:id,:data,false,:now,"
                "NULL,:now)"
            ),
            {"id": ad_id, "data": json_dumps(data), "now": now},
        )
    return {"id": ad_id, "data": data}


def _cover_customer(
    customer_id: str,
    amount_minor: int,
    expected_minor: int,
    key: str,
    cookies: dict[str, str],
):
    return client.post(
        f"/api/customers/{customer_id}/company-coverages",
        json={
            "amountMinorUSD": amount_minor,
            "idempotencyKey": key,
            "expectedOutstandingMinorUSD": expected_minor,
            "reason": "Company absorbs unrecoverable ad debt",
        },
        cookies=cookies,
    )


def _entity(collection: str, entity_id: str, cookies: dict[str, str]) -> dict:
    response = client.get(
        f"/api/collections/{collection}/{entity_id}", cookies=cookies
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_partial_ad_debt_coverage_lands_on_the_ad(admin):
    _customer("cust_ad_cov1", admin)
    _debt_ad("cust_ad_cov1_ad", "cust_ad_cov1", 50.0, admin)

    response = _cover_customer("cust_ad_cov1", 2000, 5000, "cust-cov1-key", admin)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["replayed"] is False
    saved_ad = payload["updatedAds"][0]["data"]
    assert float(saved_ad["companyDirectCoverageUSD"]) == 20.0
    # Coverage is a business expense: the ad stays an unpaid customer record.
    assert saved_ad["paymentStatus"] == "not_paid"

    coverage = payload["coverage"]["data"]
    assert coverage["coverageScope"] == "customer_ads"
    assert coverage["customerPayment"] is False
    assert coverage["countsAsCustomerRevenue"] is False
    assert float(coverage["adDebtBeforeUSD"]) == 50.0
    assert float(coverage["adDebtAfterUSD"]) == 30.0
    assert coverage["allocations"] == [
        {"adId": "cust_ad_cov1_ad", "amountMinorUSD": 2000, "amountUSD": 20.0}
    ]

    replay = _cover_customer("cust_ad_cov1", 2000, 5000, "cust-cov1-key", admin)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    saved = _entity("ads", "cust_ad_cov1_ad", admin)["data"]
    assert float(saved["companyDirectCoverageUSD"]) == 20.0


def test_stale_expected_outstanding_is_refused(admin):
    _customer("cust_ad_cov2", admin)
    _debt_ad("cust_ad_cov2_ad", "cust_ad_cov2", 40.0, admin)

    stale = _cover_customer("cust_ad_cov2", 1000, 9999, "cust-cov2-key", admin)
    assert stale.status_code == 409, stale.text
    assert "changed" in stale.json()["detail"].lower()

    too_much = _cover_customer("cust_ad_cov2", 4100, 4000, "cust-cov2-b-key", admin)
    assert too_much.status_code == 409, too_much.text


def test_driver_and_receipt_funded_ads_are_not_coverable(admin):
    _customer("cust_ad_cov3", admin)
    # Driver-collected debt belongs to its delivery receipt, not this flow.
    _debt_ad(
        "cust_ad_cov3_drv",
        "cust_ad_cov3",
        30.0,
        admin,
        collectionMethod="driver",
    )

    response = _cover_customer("cust_ad_cov3", 1000, 3000, "cust-cov3-key", admin)
    assert response.status_code == 409, response.text
    # The true coverable total is zero, so the admin's expected 3000 is stale.
    zero = _cover_customer("cust_ad_cov3", 1000, 0, "cust-cov3-b-key", admin)
    assert zero.status_code == 409, zero.text


def test_full_coverage_then_more_is_refused(admin):
    _customer("cust_ad_cov4", admin)
    _debt_ad("cust_ad_cov4_ad", "cust_ad_cov4", 25.0, admin)

    full = _cover_customer("cust_ad_cov4", 2500, 2500, "cust-cov4-key", admin)
    assert full.status_code == 200, full.text
    saved = _entity("ads", "cust_ad_cov4_ad", admin)["data"]
    assert float(saved["companyDirectCoverageUSD"]) == 25.0

    again = _cover_customer("cust_ad_cov4", 100, 0, "cust-cov4-b-key", admin)
    assert again.status_code == 409, again.text


def test_greedy_split_across_multiple_ads(admin):
    _customer("cust_ad_cov5", admin)
    _debt_ad("cust_ad_cov5_a", "cust_ad_cov5", 10.0, admin)
    _debt_ad("cust_ad_cov5_b", "cust_ad_cov5", 15.0, admin)

    response = _cover_customer("cust_ad_cov5", 1800, 2500, "cust-cov5-key", admin)
    assert response.status_code == 200, response.text
    allocations = response.json()["coverage"]["data"]["allocations"]
    # Deterministic id order: ad _a first (fully), remainder onto _b.
    assert allocations == [
        {"adId": "cust_ad_cov5_a", "amountMinorUSD": 1000, "amountUSD": 10.0},
        {"adId": "cust_ad_cov5_b", "amountMinorUSD": 800, "amountUSD": 8.0},
    ]
    saved_b = _entity("ads", "cust_ad_cov5_b", admin)["data"]
    assert float(saved_b["companyDirectCoverageUSD"]) == 8.0
