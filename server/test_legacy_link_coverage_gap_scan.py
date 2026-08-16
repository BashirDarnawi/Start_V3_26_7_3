"""Read-only headcount: real customer debt invisible to BOTH company-fund
coverage paths because it sits on a legacy rowless ad whose linked receipt
has itself stopped tracking debt (Paid/Canceled/Lost/Destroyed/TRANSFER_IN).

This pins GET /api/admin/company-coverage/legacy-link-gap-scan, which
changes nothing — it only sizes the gap using the same one-pot invariant
(committed <= capacity) the rest of the money model already enforces.

Run with: PYTHONPATH=. pytest server/test_legacy_link_coverage_gap_scan.py -v
"""

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
ADMIN_EMAIL = "legacy-gap-scan-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "LegacyGapScanAdmin123!Secure"
SCAN_URL = "/api/admin/company-coverage/legacy-link-gap-scan"


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
                "(:id,'Legacy Gap Scan Admin',:email,'Admin',:permissions,:hash,"
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


def _row(collection: str, entity_id: str, data: dict) -> None:
    now = now_ms()
    data = dict(data)
    data["id"] = entity_id
    data["_created"] = now
    data["_lastModified"] = now
    data["_deleted"] = False
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,"
                "created_by,last_modified) VALUES "
                f"('{collection}',:id,:data,false,:now,NULL,:now)"
            ),
            {"id": entity_id, "data": json_dumps(data), "now": now},
        )


def _customer(customer_id: str) -> None:
    _row("customers", customer_id, {"name": customer_id, "phones": []})


def _paid_receipt(receipt_id: str, customer_id: str, amount_usd: float, **overrides) -> None:
    data = {
        "recordType": "receipt",
        "customerId": customer_id,
        "status": "Paid",
        "isPaid": True,
        "amountUSD": amount_usd,
        "amountLocal": amount_usd * 5,
        "exchangeRate": 5,
    }
    data.update(overrides)
    _row("receipts", receipt_id, data)


def _not_paid_receipt(receipt_id: str, customer_id: str, debt_usd: float, **overrides) -> None:
    data = {
        "recordType": "receipt",
        "customerId": customer_id,
        "status": "Not Paid",
        "isPaid": False,
        "debtAmountUSD": debt_usd,
        "debtAmountLocal": debt_usd * 5,
        "exchangeRate": 5,
        "statusDetail": {"notPaidCollection": "office"},
    }
    data.update(overrides)
    _row("receipts", receipt_id, data)


def _rowless_ad(ad_id: str, customer_id: str, amount_usd: float, **overrides) -> None:
    # Legacy shape: a scalar receipt-link field, no allocation arrays at all
    # (the arrays' absence is exactly what makes the ad "rowless").
    data = {
        "recordType": "ad",
        "customerId": customer_id,
        "amountUSD": amount_usd,
        "amountLocal": amount_usd * 5,
        "exchangeRate": 5,
        "status": "Active",
        "paymentStatus": "not_paid",
        "isPaid": False,
    }
    data.update(overrides)
    _row("ads", ad_id, data)


def _scan(admin_cookies: dict[str, str]):
    response = client.get(SCAN_URL, cookies=admin_cookies)
    assert response.status_code == 200, response.text
    return response.json()


def test_scan_is_admin_only():
    anonymous = client.get(SCAN_URL)
    assert anonymous.status_code in (401, 403), anonymous.text


def _delta(before: dict, after: dict) -> tuple[int, float]:
    """(new affected receipts, new total-gap dollars) between two scans.

    Other test modules in this suite share the same in-memory database and
    may themselves create legacy-linked ads that trip this scan (the fixture
    count observed in practice: 32 pre-existing matches from unrelated test
    files, confirming the gap this diagnostic targets is a real, already-
    exercised shape in the codebase's own test data, not a hypothetical
    edge case). Asserting on the DELTA a single test introduces, rather than
    on absolute counts or the (size-capped, sorted) examples list, keeps
    each test correct regardless of everything else in the shared database.
    """
    return (
        after["affectedReceiptCount"] - before["affectedReceiptCount"],
        round(after["totalGapUSD"] - before["totalGapUSD"], 2),
    )


def test_scan_finds_overage_on_paid_receipt_with_rowless_ad(admin):
    before = _scan(admin)
    _customer("gap_cust1")
    _paid_receipt("gap_rcpt1", "gap_cust1", 90.0)
    _rowless_ad("gap_ad1", "gap_cust1", 167.70, fundingReceiptId="gap_rcpt1")
    after = _scan(admin)

    receipt_delta, gap_delta = _delta(before, after)
    assert receipt_delta == 1
    assert gap_delta == 77.70


def test_scan_excludes_receipt_still_tracking_its_own_debt(admin):
    before = _scan(admin)
    _customer("gap_cust2")
    # Still Not Paid: the receipt-level coverage path already owns this
    # ad's shortfall, even though the rowless ad's spend exceeds the debt.
    _not_paid_receipt("gap_rcpt2", "gap_cust2", 40.0)
    _rowless_ad("gap_ad2", "gap_cust2", 999.0, fundingReceiptId="gap_rcpt2")
    after = _scan(admin)

    assert _delta(before, after) == (0, 0.0)


def test_scan_excludes_driver_collected_ads(admin):
    before = _scan(admin)
    _customer("gap_cust3")
    _paid_receipt("gap_rcpt3", "gap_cust3", 10.0)
    _rowless_ad(
        "gap_ad3",
        "gap_cust3",
        500.0,
        linkedDeliveryReceiptId="gap_rcpt3",
        collectionMethod="driver",
    )
    after = _scan(admin)

    assert _delta(before, after) == (0, 0.0)


def test_scan_excludes_ads_with_allocation_arrays(admin):
    before = _scan(admin)
    _customer("gap_cust4")
    _paid_receipt("gap_rcpt4", "gap_cust4", 5.0)
    # Modern shape: an (empty) allocation array is present, so this ad
    # already accounts for itself explicitly — not the whole-ad fallback.
    _rowless_ad(
        "gap_ad4",
        "gap_cust4",
        200.0,
        fundingReceiptId="gap_rcpt4",
        receiptAllocations=[],
    )
    after = _scan(admin)

    assert _delta(before, after) == (0, 0.0)


def test_scan_excludes_within_capacity_ads(admin):
    before = _scan(admin)
    _customer("gap_cust5")
    _paid_receipt("gap_rcpt5", "gap_cust5", 100.0)
    _rowless_ad("gap_ad5", "gap_cust5", 60.0, fundingReceiptId="gap_rcpt5")
    after = _scan(admin)

    assert _delta(before, after) == (0, 0.0)


def test_scan_shares_overage_across_ads_referencing_the_same_receipt(admin):
    before = _scan(admin)
    _customer("gap_cust6")
    _paid_receipt("gap_rcpt6", "gap_cust6", 50.0)
    _rowless_ad("gap_ad6a", "gap_cust6", 30.0, fundingReceiptId="gap_rcpt6")
    _rowless_ad("gap_ad6b", "gap_cust6", 40.0, fundingReceiptId="gap_rcpt6")
    after = _scan(admin)

    # One shared receipt, judged once: committed 30+40=70 vs capacity 50.
    receipt_delta, gap_delta = _delta(before, after)
    assert receipt_delta == 1
    assert gap_delta == 20.0
