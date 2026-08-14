"""Receipt UNSETTLE tests: convert a funded PAID receipt back into customer
debt — the exact REVERSE of the settle cascade (_financial_reclassify_ad_for_
paid_receipt). Production case: receipt "Maj Al" — $100 / 970 LYD (one
Transfer Office payment @ rate2 9.7), PAID, funding one $100 active ad. The
money is still with the customer, so the owner edits the receipt to Not Paid
with Delivery collection (driver + place + quoted fee). That edit must WORK
and, in the SAME atomic commit, migrate each linked ad's funding for THIS
receipt from the paid pool (receiptAllocations) into the due pool
(dueAllocations), conserved to the cent.

Money invariants under test:
  * Per linked ad only THIS receipt's paid rows move to due rows (same
    cents); other receipts' rows are untouched.
  * The ad becomes not_paid with the collection shape matching the receipt's
    new collection type: DRIVER (linkedDeliveryReceiptId + mergedPaid mirror)
    or IN-SHOP (receiptId).
  * spentUSD / amountUSD / status / refund fields untouched.
  * Honest 409 refusals leave ad AND receipt untouched: terminal/refunded
    linked ad, outgoing transfers, TRANSFER_IN receipts, an ad already owing
    debt on another receipt.
  * Optimistic locking still catches a stale expectedLastModified (409
    "Conflict: ...").
  * Idempotent replay returns the committed result (same D-number).
  * Round trip: convert then settle back restores the paid shape — money
    identical.
  * The generic receipts PATCH (no conversion consent) still refuses with
    "A funded or transferred receipt must remain paid" (regression guard).

Run with: PYTHONPATH=. pytest server/test_receipt_unsettle.py -v
"""

import hashlib
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, now_ms, json_dumps
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "unsettle-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "UnsettleAdmin123!Secure"
DRIVER_ID = "unsettle_driver_shreif"


def _ensure_admin() -> str:
    pw = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
            {"e": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,"
                "password_salt,password_algo,password_iterations,deleted,created_at,"
                "created_by,last_modified) VALUES "
                "(:id,'Unsettle Admin',:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "perm": json_dumps({}),
                "h": pw.hash_hex,
                "s": pw.salt_hex,
                "a": pw.algo,
                "i": pw.iterations,
                "now": now,
            },
        )
        return uid


@pytest.fixture(scope="module")
def admin():
    init_db()
    _ensure_admin()
    r = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    try:
        client.cookies.clear()
    except Exception:
        pass
    return cookies


def _customer_phone(cid):
    suffix = int.from_bytes(
        hashlib.sha256(cid.encode("utf-8")).digest()[:8], "big"
    ) % 100_000_000
    return f"09{suffix:08d}"


def _customer(cid, admin):
    r = client.post(
        "/api/collections/customers",
        json={"id": cid, "data": {"name": cid, "phones": [_customer_phone(cid)]}},
        cookies=admin,
    )
    assert r.status_code == 200, r.text


def _paid_receipt(rid, cid, amount, admin, *, rate=5, payments=None):
    r = client.post(
        "/api/collections/receipts",
        json={
            "id": rid,
            "data": {
                "recordType": "receipt",
                "customerId": cid,
                "amountUSD": amount,
                "amountLocal": amount * rate,
                "exchangeRate": rate,
                "status": "Paid",
                "isPaid": True,
                "deliveryStatus": "Office",
                "payments": payments or [],
            },
        },
        cookies=admin,
    )
    assert r.status_code == 200, r.text


def _pending_delivery_receipt(rid, cid, amount, admin, *, rate=5):
    r = client.post(
        "/api/collections/receipts",
        json={
            "id": rid,
            "data": {
                "recordType": "receipt",
                "customerId": cid,
                "amountUSD": amount,
                "amountLocal": amount * rate,
                "exchangeRate": rate,
                "status": "Not Paid",
                "isPaid": False,
                "deliveryStatus": "Needs Delivery",
                "deliveryPersonId": DRIVER_ID,
                "statusDetail": {"notPaidCollection": "delivery"},
                "deliveryPlaceName": "test place",
                "quotedDeliveryFee": 5,
            },
        },
        cookies=admin,
    )
    assert r.status_code == 200, r.text


def _create_ad(ad_id, key, data, admin):
    return client.post(
        "/api/ads/mutate",
        json={"action": "create", "adId": ad_id, "idempotencyKey": key, "data": data},
        cookies=admin,
    )


def _stop_ad(ad_id, key, spent_minor, expected, admin):
    return client.post(
        f"/api/ads/{ad_id}/stop",
        json={
            "spentMinorUSD": spent_minor,
            "idempotencyKey": key,
            "expectedLastModified": expected,
        },
        cookies=admin,
    )


def _receipt(rid, admin):
    r = client.get(f"/api/collections/receipts/{rid}", cookies=admin)
    assert r.status_code == 200, r.text
    return r.json()


def _ad(ad_id, admin):
    r = client.get(f"/api/collections/ads/{ad_id}", cookies=admin)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _unsettle(rid, key, data, expected, admin):
    return client.post(
        f"/api/receipts/{rid}/unsettle",
        json={"idempotencyKey": key, "expectedLastModified": expected, "data": data},
        cookies=admin,
    )


def _driver_edit(amount_usd, amount_local, rate, *, driver=DRIVER_ID):
    """The receipt edit the production client sends: Status -> Not Paid,
    collection -> Delivery, payment breakdown kept, serial cleared (the
    server assigns the D-number in server mode)."""
    return {
        "status": "Not Paid",
        "isPaid": False,
        "statusDetail": {
            "paidCollection": "office",
            "paidDeliveryPersonId": "",
            "notPaidCollection": "delivery",
            "allowSerialOverride": False,
            "refundAction": "",
            "refundStatus": "",
            "lostResolution": "",
        },
        "deliveryStatus": "Needs Delivery",
        "deliveryPersonId": driver,
        "isReceivedInOffice": False,
        "deliveryPlaceName": "شركة الغزالة",
        "quotedDeliveryFee": 20,
        "deliveryInstructions": "",
        "amountUSD": amount_usd,
        "amountLocal": amount_local,
        "exchangeRate": rate,
        "debtAmountLocal": amount_local,
        "debtAmountUSD": amount_usd,
        "serialNumber": "",
        "tempReceiptNo": "",
    }


def _shop_edit(amount_usd, amount_local, rate):
    """The in-shop debt variant: the customer will pay at the shop."""
    return {
        "status": "Not Paid",
        "isPaid": False,
        "statusDetail": {
            "paidCollection": "office",
            "paidDeliveryPersonId": "",
            "notPaidCollection": "office",
            "allowSerialOverride": False,
            "refundAction": "",
            "refundStatus": "",
            "lostResolution": "",
        },
        "deliveryStatus": "Office",
        "deliveryPersonId": "",
        "isReceivedInOffice": False,
        "amountUSD": amount_usd,
        "amountLocal": amount_local,
        "exchangeRate": rate,
        "serialNumber": "",
        "tempReceiptNo": "",
    }


class TestUnsettleDriverDebt:
    def test_production_shape_paid_receipt_to_driver_debt(self, admin):
        """$100/970 LYD paid receipt funding one $100 active ad becomes a
        pending delivery debt; the ad's paid rows become due rows, to the
        cent, with spend/amount/status untouched."""
        cid = "unsettle_cust_prod"
        rid = "unsettle_rcpt_prod"
        ad_id = "unsettle_ad_prod"
        _customer(cid, admin)
        _paid_receipt(
            rid,
            cid,
            100,
            admin,
            rate=9.7,
            payments=[{"method": "Transfer Office", "amount": 970, "rate": 1, "rate2": 9.7}],
        )
        created = _create_ad(
            ad_id,
            "unsettle-prod-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 9.7,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 100}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        version = _receipt(rid, admin)["lastModified"]
        payload = _driver_edit(100, 970, 9.7)
        converted = _unsettle(rid, "unsettle-prod-move", payload, version, admin)
        assert converted.status_code == 200, converted.text
        body = converted.json()

        receipt = body["receipt"]["data"]
        assert receipt["status"] == "Not Paid"
        assert receipt["isPaid"] is False
        assert receipt["deliveryStatus"] == "Needs Delivery"
        assert receipt["statusDetail"]["notPaidCollection"] == "delivery"
        assert receipt["deliveryPersonId"] == DRIVER_ID
        assert receipt["deliveryPlaceName"] == "شركة الغزالة"
        assert receipt["quotedDeliveryFee"] == 20
        # The server assigned the temporary delivery number.
        assert re.fullmatch(r"D[0-9]+", str(receipt["tempReceiptNo"])), receipt
        assert receipt["amountUSD"] == 100
        assert receipt["debtAmountLocal"] == 970
        assert receipt["debtAmountUSD"] == 100
        # The payment breakdown was kept (recorded evidence, not credit).
        assert receipt["payments"] == [
            {"method": "Transfer Office", "amount": 970, "rate": 1, "rate2": 9.7}
        ]

        assert len(body["updatedAds"]) == 1
        ad = body["updatedAds"][0]["data"]
        # Driver-debt shape, conserved to the cent.
        assert ad["paymentStatus"] == "not_paid"
        assert ad["isPaid"] is False
        assert ad["collectionMethod"] == "driver"
        assert ad["dueAllocations"] == [{"receiptId": rid, "amountUSD": 100.0}]
        assert ad["receiptAllocations"] == []
        assert ad["mergedPaidAllocations"] == []
        assert ad["hasMergedPaidFunds"] is False
        assert ad["linkedDeliveryReceiptId"] == rid
        assert ad["receiptId"] == rid
        assert ad["dueAmountToUseUSD"] == 100.0
        assert ad["dueAmountToUseLYD"] == 0.0
        assert ad["receiptIds"] == []
        assert ad["fundingReceiptId"] == ""
        # Money identity untouched.
        assert ad["amountUSD"] == 100.0
        assert ad["status"] == "Active"
        assert str(ad.get("refundType") or "None") in {"", "None"}
        assert "spentUSD" not in ad or ad["spentUSD"] in (None, "")

        # Conservation: the receipt's debt credit is fully committed — one
        # cent more must 409.
        over = _create_ad(
            "unsettle_prod_over",
            "unsettle-prod-over",
            {
                "customerId": cid,
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 9.7,
                "linkedDeliveryReceiptId": rid,
                "dueAllocations": [{"receiptId": rid, "amountUSD": 0.01}],
            },
            admin,
        )
        assert over.status_code == 409, over.text

        # Idempotent replay: the SAME key + body returns the committed result
        # (same D-number, no second migration).
        replay = _unsettle(rid, "unsettle-prod-move", payload, version, admin)
        assert replay.status_code == 200, replay.text
        assert replay.json()["replayed"] is True
        assert (
            replay.json()["receipt"]["data"]["tempReceiptNo"]
            == receipt["tempReceiptNo"]
        )

    def test_round_trip_convert_then_settle_restores_paid_shape(self, admin):
        """Reverse trip: unsettle then settle back — money identical."""
        cid = "unsettle_cust_trip"
        rid = "unsettle_rcpt_trip"
        ad_id = "unsettle_ad_trip"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 100, admin, rate=9.7)
        created = _create_ad(
            ad_id,
            "unsettle-trip-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 9.7,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 100}],
            },
            admin,
        )
        assert created.status_code == 200, created.text
        before = _ad(ad_id, admin)

        converted = _unsettle(
            rid,
            "unsettle-trip-move",
            _driver_edit(100, 970, 9.7),
            _receipt(rid, admin)["lastModified"],
            admin,
        )
        assert converted.status_code == 200, converted.text

        settled = client.post(
            f"/api/receipts/{rid}/settle",
            json={
                "idempotencyKey": "unsettle-trip-settle",
                "expectedLastModified": _receipt(rid, admin)["lastModified"],
                "data": {
                    "status": "Paid",
                    "isPaid": True,
                    "deliveryStatus": "Office",
                    "statusDetail": {"notPaidCollection": "office"},
                    "isReceivedInOffice": True,
                },
            },
            cookies=admin,
        )
        assert settled.status_code == 200, settled.text
        assert settled.json()["receipt"]["data"]["status"] == "Paid"
        assert len(settled.json()["updatedAds"]) == 1

        after = _ad(ad_id, admin)
        assert after["paymentStatus"] == "paid"
        assert after["isPaid"] is True
        assert after["receiptAllocations"] == [{"receiptId": rid, "amountUSD": 100.0}]
        assert after["dueAllocations"] == []
        assert after["dueAmountToUseUSD"] == 0.0
        assert after["dueAmountToUseLYD"] == 0.0
        assert after["collectionMethod"] == ""
        assert after["collectionPayments"] == []
        assert after["paymentMethod"] == ""
        assert after["linkedDeliveryReceiptId"] == ""
        assert after["mergedPaidAllocations"] == []
        assert after["hasMergedPaidFunds"] is False
        assert after["receiptId"] == rid
        assert after["fundingReceiptId"] == rid
        assert after["receiptIds"] == [rid]
        # Money identity is exactly what it was before the round trip.
        assert after["amountUSD"] == before["amountUSD"] == 100.0
        assert after["status"] == before["status"]
        assert after.get("spentUSD") == before.get("spentUSD")
        assert after["receiptAllocations"] == before["receiptAllocations"]


class TestUnsettleInShopDebt:
    def test_in_shop_variant(self, admin):
        """The customer will pay at the shop: IN-SHOP debt shape (receiptId
        link, no delivery fields, no temp number)."""
        cid = "unsettle_cust_shop"
        rid = "unsettle_rcpt_shop"
        ad_id = "unsettle_ad_shop"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 100, admin, rate=9.7)
        created = _create_ad(
            ad_id,
            "unsettle-shop-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 9.7,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 100}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        converted = _unsettle(
            rid,
            "unsettle-shop-move",
            _shop_edit(100, 970, 9.7),
            _receipt(rid, admin)["lastModified"],
            admin,
        )
        assert converted.status_code == 200, converted.text
        receipt = converted.json()["receipt"]["data"]
        assert receipt["status"] == "Not Paid"
        assert receipt["isPaid"] is False
        assert receipt["deliveryStatus"] == "Office"
        assert receipt["statusDetail"]["notPaidCollection"] == "office"
        assert not str(receipt.get("tempReceiptNo") or "")

        ad = converted.json()["updatedAds"][0]["data"]
        assert ad["paymentStatus"] == "not_paid"
        assert ad["isPaid"] is False
        assert ad["collectionMethod"] == "in_shop"
        assert ad["dueAllocations"] == [{"receiptId": rid, "amountUSD": 100.0}]
        assert ad["receiptAllocations"] == []
        assert ad["mergedPaidAllocations"] == []
        assert ad["hasMergedPaidFunds"] is False
        assert ad["linkedDeliveryReceiptId"] == ""
        assert ad["receiptId"] == rid
        assert ad["dueAmountToUseUSD"] == 100.0
        assert ad["dueAmountToUseLYD"] == 0.0
        assert ad["amountUSD"] == 100.0
        assert ad["status"] == "Active"

    def test_multi_ad_receipt_migrates_every_linked_ad(self, admin):
        """A receipt funding TWO ads migrates both — each keeps its own cents."""
        cid = "unsettle_cust_multi"
        rid = "unsettle_rcpt_multi"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 100, admin)
        for ad_id, key, amount in (
            ("unsettle_ad_multi_a", "unsettle-multi-a", 60),
            ("unsettle_ad_multi_b", "unsettle-multi-b", 40),
        ):
            created = _create_ad(
                ad_id,
                key,
                {
                    "customerId": cid,
                    "paymentStatus": "paid",
                    "exchangeRate": 5,
                    "receiptAllocations": [{"receiptId": rid, "amountUSD": amount}],
                },
                admin,
            )
            assert created.status_code == 200, created.text

        converted = _unsettle(
            rid,
            "unsettle-multi-move",
            _shop_edit(100, 500, 5),
            _receipt(rid, admin)["lastModified"],
            admin,
        )
        assert converted.status_code == 200, converted.text
        updated = {
            entity["id"]: entity["data"] for entity in converted.json()["updatedAds"]
        }
        assert set(updated) == {"unsettle_ad_multi_a", "unsettle_ad_multi_b"}
        assert updated["unsettle_ad_multi_a"]["dueAllocations"] == [
            {"receiptId": rid, "amountUSD": 60.0}
        ]
        assert updated["unsettle_ad_multi_b"]["dueAllocations"] == [
            {"receiptId": rid, "amountUSD": 40.0}
        ]
        for data in updated.values():
            assert data["paymentStatus"] == "not_paid"
            assert data["collectionMethod"] == "in_shop"
            assert data["receiptAllocations"] == []
            assert data["receiptId"] == rid

    def test_mixed_funding_keeps_other_receipts_rows(self, admin):
        """An ad funded by THIS receipt AND another paid receipt keeps the
        other receipt's rows — in receiptAllocations and (driver shape) the
        mergedPaidAllocations mirror."""
        cid = "unsettle_cust_mixed"
        rid_a = "unsettle_rcpt_mixed_a"
        rid_b = "unsettle_rcpt_mixed_b"
        ad_id = "unsettle_ad_mixed"
        _customer(cid, admin)
        _paid_receipt(rid_a, cid, 70, admin)
        _paid_receipt(rid_b, cid, 30, admin)
        created = _create_ad(
            ad_id,
            "unsettle-mixed-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": rid_a, "amountUSD": 70},
                    {"receiptId": rid_b, "amountUSD": 30},
                ],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        converted = _unsettle(
            rid_a,
            "unsettle-mixed-move",
            _driver_edit(70, 350, 5),
            _receipt(rid_a, admin)["lastModified"],
            admin,
        )
        assert converted.status_code == 200, converted.text
        ad = converted.json()["updatedAds"][0]["data"]
        assert ad["paymentStatus"] == "not_paid"
        assert ad["collectionMethod"] == "driver"
        assert ad["dueAllocations"] == [{"receiptId": rid_a, "amountUSD": 70.0}]
        assert ad["receiptAllocations"] == [{"receiptId": rid_b, "amountUSD": 30.0}]
        assert ad["mergedPaidAllocations"] == [{"receiptId": rid_b, "amountUSD": 30.0}]
        assert ad["hasMergedPaidFunds"] is True
        assert ad["linkedDeliveryReceiptId"] == rid_a
        assert ad["receiptId"] == rid_a
        assert ad["dueAmountToUseUSD"] == 70.0
        assert ad["receiptIds"] == [rid_b]
        assert ad["fundingReceiptId"] == rid_b
        assert ad["amountUSD"] == 100.0
        # Receipt B is untouched and still paid.
        other = _receipt(rid_b, admin)["data"]
        assert other["status"] == "Paid"


class TestUnsettleRefusals:
    def test_terminal_linked_ad_refuses_and_leaves_everything_untouched(self, admin):
        """A Stopped ad's money history must not be rewritten."""
        cid = "unsettle_cust_term"
        rid = "unsettle_rcpt_term"
        ad_id = "unsettle_ad_term"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 50, admin)
        created = _create_ad(
            ad_id,
            "unsettle-term-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 40}],
            },
            admin,
        )
        assert created.status_code == 200, created.text
        stopped = _stop_ad(
            ad_id,
            "unsettle-term-stop",
            3000,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text

        version = _receipt(rid, admin)["lastModified"]
        refused = _unsettle(
            rid, "unsettle-term-move", _driver_edit(50, 250, 5), version, admin
        )
        assert refused.status_code == 409, refused.text
        assert "finished or refunded ad" in refused.text

        # Untouched: ad still holds its stopped paid shape, receipt still Paid.
        ad = _ad(ad_id, admin)
        assert ad["status"] == "Stopped"
        assert ad["spentUSD"] == 30.0
        assert ad["receiptAllocations"] == [{"receiptId": rid, "amountUSD": 30.0}]
        assert ad["dueAllocations"] == []
        receipt = _receipt(rid, admin)
        assert receipt["data"]["status"] == "Paid"
        assert receipt["lastModified"] == version

    def test_outgoing_transfer_refuses(self, admin):
        """Transfer chains must stay paid-backed: a source receipt with an
        outgoing transfer refuses, and so does the TRANSFER_IN target."""
        cid = "unsettle_cust_xfer"
        cid_other = "unsettle_cust_xfer_target"
        rid = "unsettle_rcpt_xfer"
        tin = "unsettle_rcpt_xfer_in"
        ad_id = "unsettle_ad_xfer"
        _customer(cid, admin)
        _customer(cid_other, admin)
        _paid_receipt(rid, cid, 100, admin)
        created = _create_ad(
            ad_id,
            "unsettle-xfer-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 50}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        transferred = client.post(
            "/api/receipts/transfers",
            json={
                "sourceReceiptId": rid,
                "targetCustomerId": cid_other,
                "targetReceiptId": tin,
                "amountMinorUSD": 2000,
                "expectedSourceLastModified": _receipt(rid, admin)["lastModified"],
                "idempotencyKey": "unsettle-xfer-transfer",
            },
            cookies=admin,
        )
        assert transferred.status_code == 200, transferred.text

        refused = _unsettle(
            rid,
            "unsettle-xfer-move",
            _driver_edit(100, 500, 5),
            _receipt(rid, admin)["lastModified"],
            admin,
        )
        assert refused.status_code == 409, refused.text
        assert "outgoing transfers must remain paid" in refused.text
        assert _receipt(rid, admin)["data"]["status"] == "Paid"

        refused_in = _unsettle(
            tin,
            "unsettle-xfer-in-move",
            _shop_edit(20, 100, 5),
            _receipt(tin, admin)["lastModified"],
            admin,
        )
        assert refused_in.status_code == 409, refused_in.text
        assert "transferred-in receipt must remain paid" in refused_in.text
        assert _receipt(tin, admin)["data"]["status"] == "Paid"

    def test_ad_owing_another_receipt_refuses(self, admin):
        """A driver-debt ad part-funded by this paid receipt but owing its
        debt on ANOTHER receipt cannot take a second debt receipt."""
        cid = "unsettle_cust_owes"
        rid_paid = "unsettle_rcpt_owes_paid"
        rid_due = "unsettle_rcpt_owes_due"
        ad_id = "unsettle_ad_owes"
        _customer(cid, admin)
        _paid_receipt(rid_paid, cid, 50, admin)
        _pending_delivery_receipt(rid_due, cid, 20, admin)
        created = _create_ad(
            ad_id,
            "unsettle-owes-create",
            {
                "customerId": cid,
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": rid_due,
                "dueAllocations": [{"receiptId": rid_due, "amountUSD": 20}],
                "mergedPaidAllocations": [{"receiptId": rid_paid, "amountUSD": 30}],
                "driverBudgetUSD": 50,
            },
            admin,
        )
        assert created.status_code == 200, created.text

        version = _receipt(rid_paid, admin)["lastModified"]
        refused = _unsettle(
            rid_paid, "unsettle-owes-move", _shop_edit(50, 250, 5), version, admin
        )
        assert refused.status_code == 409, refused.text
        assert "owes another receipt must remain paid" in refused.text
        ad = _ad(ad_id, admin)
        assert ad["dueAllocations"] == [{"receiptId": rid_due, "amountUSD": 20.0}]
        assert ad["mergedPaidAllocations"] == [
            {"receiptId": rid_paid, "amountUSD": 30.0}
        ]
        assert _receipt(rid_paid, admin)["data"]["status"] == "Paid"

    def test_stale_expected_last_modified_conflicts(self, admin):
        cid = "unsettle_cust_stale"
        rid = "unsettle_rcpt_stale"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 60, admin)
        created = _create_ad(
            "unsettle_ad_stale",
            "unsettle-stale-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 60}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        version = _receipt(rid, admin)["lastModified"]
        stale = _unsettle(
            rid, "unsettle-stale-move", _shop_edit(60, 300, 5), version - 1, admin
        )
        assert stale.status_code == 409, stale.text
        assert "Conflict" in stale.text
        assert _receipt(rid, admin)["data"]["status"] == "Paid"

    def test_generic_patch_still_refuses_funded_paid_to_not_paid(self, admin):
        """Regression guard: without the conversion consent, the plain PATCH
        keeps its honest refusal."""
        cid = "unsettle_cust_patch"
        rid = "unsettle_rcpt_patch"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 40, admin)
        created = _create_ad(
            "unsettle_ad_patch",
            "unsettle-patch-create",
            {
                "customerId": cid,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": rid, "amountUSD": 40}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        version = _receipt(rid, admin)["lastModified"]
        patched = client.patch(
            f"/api/collections/receipts/{rid}",
            json={
                "data": {
                    "status": "Not Paid",
                    "isPaid": False,
                    "statusDetail": {"notPaidCollection": "office"},
                },
                "expectedLastModified": version,
            },
            cookies=admin,
        )
        assert patched.status_code == 409, patched.text
        assert "dedicated receipt debt-conversion action" in patched.text
        assert _receipt(rid, admin)["data"]["status"] == "Paid"

    def test_unfunded_paid_receipt_converts_with_no_ads(self, admin):
        """No linked funding: the conversion is just an honest status edit."""
        cid = "unsettle_cust_plain"
        rid = "unsettle_rcpt_plain"
        _customer(cid, admin)
        _paid_receipt(rid, cid, 25, admin)
        converted = _unsettle(
            rid,
            "unsettle-plain-move",
            _shop_edit(25, 125, 5),
            _receipt(rid, admin)["lastModified"],
            admin,
        )
        assert converted.status_code == 200, converted.text
        assert converted.json()["updatedAds"] == []
        assert converted.json()["receipt"]["data"]["status"] == "Not Paid"
