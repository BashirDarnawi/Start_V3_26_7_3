"""Read-only measurement of ad spend that exceeds the money provided for it,
grouped by the rule that decides whether company funds may cover it.

This is the diagnostic that answers "why does this customer's debt get no
'pay debt from company funds' button". It starts from the definition of
somebody still owing (spend > funded) and makes no assumption about the
shape of the debt, so it catches every exclusion rule at once.

Run with: PYTHONPATH=. pytest server/test_unfunded_ad_spend_scan.py -v
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
ADMIN_EMAIL = "unfunded-scan-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "UnfundedScanAdmin123!Secure"
SCAN_URL = "/api/admin/company-coverage/unfunded-ad-spend-scan"


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
                "(:id,'Unfunded Scan Admin',:email,'Admin',:permissions,:hash,"
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


def _customer(customer_id: str, name: str) -> None:
    _row("customers", customer_id, {"name": name, "phones": []})


def _paid_receipt(receipt_id: str, customer_id: str, amount_usd: float) -> None:
    _row(
        "receipts",
        receipt_id,
        {
            "recordType": "receipt",
            "customerId": customer_id,
            "status": "Paid",
            "isPaid": True,
            "amountUSD": amount_usd,
            "amountLocal": amount_usd * 5,
            "exchangeRate": 5,
        },
    )


def _ad(ad_id: str, customer_id: str, amount_usd: float, **overrides) -> None:
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


def _bucket(result: dict, reason: str) -> dict:
    return result["totalsByReason"].get(
        reason, {"adCount": 0, "customerCount": 0, "unfundedUSD": 0.0}
    )


def test_scan_is_admin_only():
    anonymous = client.get(SCAN_URL)
    assert anonymous.status_code in (401, 403), anonymous.text


def test_underfunded_ad_marked_paid_is_reported_as_such(admin):
    """The reported production shape: an ad linked to a receipt is stamped
    'paid' and leaves the coverage check for good, even though the receipt
    funded only part of its spend. Modeled on Lole Loleta's real figures —
    $167.70 spent against a $90.00 receipt."""
    before = _bucket(_scan(admin), "ad_marked_paid")
    _customer("unf_cust1", "Underfunded Paid Ad")
    _paid_receipt("unf_rcpt1", "unf_cust1", 90.0)
    _ad(
        "unf_ad1",
        "unf_cust1",
        167.70,
        paymentStatus="paid",
        isPaid=True,
        fundingReceiptId="unf_rcpt1",
        receiptAllocations=[{"receiptId": "unf_rcpt1", "amountUSD": 90.0}],
    )
    after = _bucket(_scan(admin), "ad_marked_paid")

    assert after["adCount"] - before["adCount"] == 1
    assert round(after["unfundedUSD"] - before["unfundedUSD"], 2) == 77.70


def test_a_fully_funded_ad_is_never_reported(admin):
    before = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust2", "Fully Funded")
    _paid_receipt("unf_rcpt2", "unf_cust2", 200.0)
    _ad(
        "unf_ad2",
        "unf_cust2",
        200.0,
        paymentStatus="paid",
        isPaid=True,
        fundingReceiptId="unf_rcpt2",
        receiptAllocations=[{"receiptId": "unf_rcpt2", "amountUSD": 200.0}],
    )
    after = _scan(admin)["notOfferedButRealDebtUSD"]

    assert round(after - before, 2) == 0.0


def test_rowless_legacy_ad_charged_to_its_receipt_reports_no_debt(admin):
    """A pre-allocation ad records its funding ONLY through the whole-ad
    fallback, which charges its entire spend to the receipt it references.
    Reading just the modern arrays reported 100% of every such ad as debt —
    the same phantom-debt class as the earlier double count."""
    before = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust7", "Rowless Legacy")
    _paid_receipt("unf_rcpt7", "unf_cust7", 100.0)
    # No receiptAllocations/dueAllocations/companyFundingAllocations keys.
    _ad(
        "unf_ad7",
        "unf_cust7",
        100.0,
        paymentStatus="paid",
        isPaid=True,
        fundingReceiptId="unf_rcpt7",
        receiptId="unf_rcpt7",
    )
    after = _scan(admin)["notOfferedButRealDebtUSD"]

    assert round(after - before, 2) == 0.0


def test_legacy_scalar_due_mirror_counts_as_provided_funding(admin):
    """Stopping a legacy ad leaves dueAllocations == [] with the surviving
    amount in dueAmountToUseUSD. _financial_ad_due_usage treats that scalar
    as committed against the receipt, so company funds must not be offered
    for it — otherwise the receipt-level button could cover it a second
    time."""
    before = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust8", "Legacy Due Mirror")
    _paid_receipt("unf_rcpt8", "unf_cust8", 100.0)
    _ad(
        "unf_ad8",
        "unf_cust8",
        100.0,
        collectionMethod="in_shop",
        receiptId="unf_rcpt8",
        dueAllocations=[],
        dueAmountToUseUSD=100.0,
    )
    after = _scan(admin)["notOfferedButRealDebtUSD"]

    assert round(after - before, 2) == 0.0


def test_legacy_scalar_due_mirror_is_not_offered_by_the_live_feature_either(admin):
    """The same money, checked through the REAL eligibility function rather
    than the diagnostic — a $60 scalar against $100 of spend leaves $40
    coverable, never the full $100."""
    from server.company_debt_coverage import coverable_ad_debt_detail

    reason, minor = coverable_ad_debt_detail(
        {
            "recordType": "ad",
            "status": "Active",
            "paymentStatus": "not_paid",
            "isPaid": False,
            "collectionMethod": "in_shop",
            "receiptId": "some_receipt",
            "amountUSD": 100.0,
            "dueAllocations": [],
            "dueAmountToUseUSD": 60.0,
        }
    )
    assert reason == "coverable"
    assert minor == 4000


def test_explicit_null_spent_usd_matches_the_client_reading(admin):
    """The client tests `!== undefined`, so a stored null is present-and-zero.
    Testing `is not None` fell through to amountUSD and invented a whole ad's
    worth of debt for any row storing an explicit null."""
    from server.company_debt_coverage import ad_effective_spend_minor

    assert ad_effective_spend_minor(
        {"status": "Stopped", "amountUSD": 400.0, "spentUSD": None}
    ) == 0


def test_one_malformed_row_does_not_abort_the_whole_scan(admin):
    """These are exactly the rows the scan exists to survey, so a corrupt
    amount must be reported, not allowed to 400 the entire response."""
    _customer("unf_cust9", "Malformed Row")
    _ad("unf_ad9", "unf_cust9", 0.0, amountUSD="N/A", receiptAllocations=[])
    result = _scan(admin)

    assert "unf_ad9" in result["unreadableAdIds"]
    assert result["unreadableAdCount"] >= 1
    # And the rest of the survey still came back.
    assert isinstance(result["totalsByReason"], dict)


def test_debt_the_button_already_offers_lands_in_the_coverable_bucket(admin):
    """The healthy bucket, and a live cross-check that this reader agrees
    with the real eligibility rule rather than drifting from it. Excluded
    from the headline because the button already handles it."""
    before_bucket = _bucket(_scan(admin), "coverable")
    before_real = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust3", "Plain Ad Debt")
    _ad("unf_ad3", "unf_cust3", 25.0, receiptAllocations=[])
    result = _scan(admin)
    after_bucket = _bucket(result, "coverable")

    assert after_bucket["adCount"] - before_bucket["adCount"] == 1
    assert round(after_bucket["unfundedUSD"] - before_bucket["unfundedUSD"], 2) == 25.0
    assert after_bucket["countsAsUnofferedDebt"] is False
    assert round(result["notOfferedButRealDebtUSD"] - before_real, 2) == 0.0


def _driver_ad_detail(receipt: dict | None, spend: float, funded: float):
    """Run the REAL eligibility rule for a driver ad against a linked receipt."""
    from server.company_debt_coverage import coverable_ad_debt_detail

    ad = {
        "recordType": "ad",
        "status": "Active",
        "paymentStatus": "not_paid",
        "isPaid": False,
        "collectionMethod": "driver",
        "linkedDeliveryReceiptId": "drv_receipt",
        "amountUSD": spend,
        "receiptAllocations": (
            [{"receiptId": "drv_receipt", "amountUSD": funded}] if funded else []
        ),
    }
    return coverable_ad_debt_detail(
        ad, receipt_lookup=lambda rid: receipt if rid == "drv_receipt" else None
    )


def test_driver_debt_becomes_coverable_once_its_delivery_is_settled(admin):
    """Lole Loleta's real production shape: a driver ad for $77.70 whose
    delivery receipt is already Paid and closed. The driver will never
    collect it now, so it is simply uncollected debt."""
    reason, minor = _driver_ad_detail(
        {"status": "Paid", "isPaid": True}, 77.70, 0.0
    )
    assert reason == "coverable"
    assert minor == 7770


def test_driver_debt_on_a_live_delivery_is_still_excluded(admin):
    """محمد عون's shape: $40 unfunded on a delivery that has NOT been
    collected. The driver is still going to collect this at the door, so
    company funds must not touch it."""
    reason, minor = _driver_ad_detail(
        {"status": "Not Paid", "isPaid": False}, 50.0, 10.0
    )
    assert reason == "driver_debt_belongs_to_its_delivery_receipt"
    assert minor == 0


def test_canceled_delivery_never_becomes_coverable(admin):
    """A canceled delivery RELEASED its debt — nothing is owed, so there is
    nothing to cover. This is why the rule keys on Paid and not merely on
    'the receipt stopped tracking debt'."""
    for status in ("Canceled", "Lost", "Destroyed"):
        reason, minor = _driver_ad_detail({"status": status}, 77.70, 0.0)
        assert reason == "driver_debt_belongs_to_its_delivery_receipt", status
        assert minor == 0, status


def test_driver_ad_with_an_unresolvable_receipt_stays_excluded(admin):
    """No lookup, a missing receipt, or a deleted one all read the same:
    stay conservative and offer nothing."""
    assert _driver_ad_detail(None, 77.70, 0.0)[1] == 0

    from server.company_debt_coverage import coverable_ad_debt_detail

    ad = {
        "recordType": "ad",
        "status": "Active",
        "paymentStatus": "not_paid",
        "isPaid": False,
        "collectionMethod": "driver",
        "linkedDeliveryReceiptId": "drv_receipt",
        "amountUSD": 77.70,
        "receiptAllocations": [],
    }
    # No receipt_lookup supplied at all.
    assert coverable_ad_debt_detail(ad)[0] == (
        "driver_debt_belongs_to_its_delivery_receipt"
    )


def test_settled_driver_debt_is_offered_end_to_end_on_the_customer_card(admin):
    """The whole path: a Paid delivery receipt leaves $77.70 unfunded, the
    customer-level route offers exactly that, and covering it records a
    company expense without touching the receipt."""
    _customer("unf_cust11", "Settled Driver Debt")
    _row(
        "receipts",
        "unf_rcpt11",
        {
            "recordType": "receipt",
            "customerId": "unf_cust11",
            "status": "Paid",
            "isPaid": True,
            "amountUSD": 90.0,
            "amountLocal": 450.0,
            "exchangeRate": 5,
            "deliveryStatus": "Delivered",
        },
    )
    _ad(
        "unf_ad11",
        "unf_cust11",
        77.70,
        collectionMethod="driver",
        linkedDeliveryReceiptId="unf_rcpt11",
        receiptAllocations=[],
    )

    response = client.post(
        "/api/customers/unf_cust11/company-coverages",
        json={
            "amountMinorUSD": 7770,
            "idempotencyKey": "unf-settled-driver-key",
            "expectedOutstandingMinorUSD": 7770,
            "reason": "Company absorbs debt the driver never collected",
        },
        cookies=admin,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    saved_ad = payload["updatedAds"][0]["data"]
    assert float(saved_ad["companyDirectCoverageUSD"]) == 77.70
    # Still the customer's unpaid ad record; coverage is an expense, not a payment.
    assert saved_ad["paymentStatus"] == "not_paid"
    assert payload["coverage"]["data"]["customerPayment"] is False
    assert payload["coverage"]["data"]["countsAsCustomerRevenue"] is False

    # And the debt is now gone, so nothing further is offered.
    again = client.post(
        "/api/customers/unf_cust11/company-coverages",
        json={
            "amountMinorUSD": 100,
            "idempotencyKey": "unf-settled-driver-key-2",
            "expectedOutstandingMinorUSD": 0,
            "reason": "second attempt",
        },
        cookies=admin,
    )
    assert again.status_code == 409, again.text


def test_driver_ad_debt_is_bucketed_out_of_the_headline(admin):
    """Driver cash is collected at the door and tracked by the delivery
    receipt, so it is reported but must never inflate the figure a fix is
    scoped against."""
    before_bucket = _bucket(_scan(admin), "driver_debt_belongs_to_its_delivery_receipt")
    before_real = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust4", "Driver Debt")
    _ad("unf_ad4", "unf_cust4", 30.0, collectionMethod="driver", receiptAllocations=[])
    result = _scan(admin)
    after_bucket = _bucket(result, "driver_debt_belongs_to_its_delivery_receipt")

    assert after_bucket["adCount"] - before_bucket["adCount"] == 1
    assert round(after_bucket["unfundedUSD"] - before_bucket["unfundedUSD"], 2) == 30.0
    assert after_bucket["countsAsUnofferedDebt"] is False
    assert round(result["notOfferedButRealDebtUSD"] - before_real, 2) == 0.0


def test_written_off_debt_is_reported_but_never_in_the_headline(admin):
    before_real = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust10", "Written Off")
    _ad("unf_ad10", "unf_cust10", 80.0, paymentStatus="wont_pay", receiptAllocations=[])
    result = _scan(admin)

    bucket = _bucket(result, "ad_marked_wont_pay")
    assert bucket["adCount"] >= 1
    assert bucket["countsAsUnofferedDebt"] is False
    assert round(result["notOfferedButRealDebtUSD"] - before_real, 2) == 0.0


def test_pending_ad_has_no_unfunded_spend_yet(admin):
    before = _scan(admin)["notOfferedButRealDebtUSD"]
    _customer("unf_cust5", "Not Started")
    _ad("unf_ad5", "unf_cust5", 500.0, status="Pending", receiptAllocations=[])
    after = _scan(admin)["notOfferedButRealDebtUSD"]

    # Budget is not spend: an ad that has not run owes nothing.
    assert round(after - before, 2) == 0.0


def test_examples_carry_the_customer_name_and_linked_receipt_status(admin):
    _customer("unf_cust6", "Named Example Customer")
    _paid_receipt("unf_rcpt6", "unf_cust6", 10.0)
    _ad(
        "unf_ad6",
        "unf_cust6",
        900.0,
        paymentStatus="paid",
        isPaid=True,
        fundingReceiptId="unf_rcpt6",
        receiptAllocations=[{"receiptId": "unf_rcpt6", "amountUSD": 10.0}],
    )
    result = _scan(admin)

    match = next((e for e in result["examples"] if e["adId"] == "unf_ad6"), None)
    assert match is not None, result
    assert match["customerName"] == "Named Example Customer"
    assert match["reason"] == "ad_marked_paid"
    assert match["spentUSD"] == 900.0
    assert match["fundedUSD"] == 10.0
    assert match["unfundedUSD"] == 890.0
    assert match["linkedReceipts"] == [
        {"receiptId": "unf_rcpt6", "status": "Paid"}
    ]
