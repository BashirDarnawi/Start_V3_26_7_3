"""Receipt-relink tests: fully release an ad's old funding receipt and move the
already-spent amount onto a new receipt — including for terminal (Stopped/
Canceled/Completed/Lost) ads, which every other edit path refuses.

Money invariants under test:
  * The relink frees the OLD receipt (usage is derived from allocation arrays,
    so dropping it returns its money) and commits the SAME amount on the NEW one.
  * spentUSD / amountUSD / status are preserved — a relink only moves receipts.
  * The new receipt must have capacity, else a 409 leaves the ad untouched.
  * A relink can never smuggle in an amount/spend/status/refund change (400).
  * Optimistic locking still catches a stale expectedLastModified (409).
  * A NORMAL edit of a terminal ad stays blocked (regression guard).

Run with: PYTHONPATH=. pytest server/test_receipt_relink.py -v
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

from server.db import db_conn, init_db, now_ms, json_dumps
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "relink-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "RelinkAdmin123!Secure"


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
                "(:id,'Relink Admin',:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
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


def _paid_receipt(rid, cid, amount, admin):
    r = client.post(
        "/api/collections/receipts",
        json={
            "id": rid,
            "data": {
                "recordType": "receipt",
                "customerId": cid,
                "amountUSD": amount,
                "amountLocal": amount * 5,
                "exchangeRate": 5,
                "status": "Paid",
                "isPaid": True,
            },
        },
        cookies=admin,
    )
    assert r.status_code == 200, r.text


def _office_receipt(rid, cid, amount, admin):
    r = client.post(
        "/api/collections/receipts",
        json={
            "id": rid,
            "data": {
                "recordType": "receipt",
                "customerId": cid,
                "amountUSD": amount,
                "amountLocal": amount * 5,
                "exchangeRate": 5,
                "status": "Not Paid",
                "isPaid": False,
                "deliveryStatus": "Office",
                "statusDetail": {"notPaidCollection": "office"},
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


def _update_ad(ad_id, key, data, expected, admin):
    return client.post(
        "/api/ads/mutate",
        json={
            "action": "update",
            "adId": ad_id,
            "idempotencyKey": key,
            "expectedLastModified": expected,
            "data": data,
        },
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


class TestReceiptRelinkPaidPath:
    def test_relink_stopped_paid_ad_frees_old_and_moves_spend(self, admin):
        _customer("relink_paid_cust", admin)
        _paid_receipt("relink_paid_a", "relink_paid_cust", 60, admin)
        _paid_receipt("relink_paid_b", "relink_paid_cust", 60, admin)

        created = _create_ad(
            "relink_paid_ad",
            "relink-paid-create-1",
            {
                "customerId": "relink_paid_cust",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": "relink_paid_a", "amountUSD": 50}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        stopped = _stop_ad(
            "relink_paid_ad",
            "relink-paid-stop-1",
            3000,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text
        stop_data = stopped.json()["ad"]["data"]
        assert stop_data["status"] == "Stopped"
        assert stop_data["spentUSD"] == 30.0
        assert stop_data["amountUSD"] == 50.0
        assert stop_data["receiptAllocations"] == [
            {"receiptId": "relink_paid_a", "amountUSD": 30.0}
        ]

        relinked = _update_ad(
            "relink_paid_ad",
            "relink-paid-move-1",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": "relink_paid_b", "amountUSD": 30}],
                "dueAllocations": [],
            },
            stopped.json()["ad"]["lastModified"],
            admin,
        )
        assert relinked.status_code == 200, relinked.text
        data = relinked.json()["ad"]["data"]
        # Only the receipt moved. Everything about the money is preserved.
        assert data["status"] == "Stopped"
        assert data["spentUSD"] == 30.0
        assert data["amountUSD"] == 50.0
        assert data["receiptAllocations"] == [
            {"receiptId": "relink_paid_b", "amountUSD": 30.0}
        ]
        assert data["receiptId"] == "relink_paid_b"
        assert data["fundingReceiptId"] == "relink_paid_b"
        # The marker never persists onto the stored row.
        assert "relinkReceiptOnly" not in data

        # OLD receipt A is fully freed: a fresh ad can take its whole $60 again.
        free_a = _create_ad(
            "relink_paid_free_a",
            "relink-paid-free-a-1",
            {
                "customerId": "relink_paid_cust",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": "relink_paid_a", "amountUSD": 60}],
            },
            admin,
        )
        assert free_a.status_code == 200, free_a.text

        # NEW receipt B now carries the moved $30: only $30 of its $60 is left.
        over_b = _create_ad(
            "relink_paid_over_b",
            "relink-paid-over-b-1",
            {
                "customerId": "relink_paid_cust",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": "relink_paid_b", "amountUSD": 31}],
            },
            admin,
        )
        assert over_b.status_code == 409, over_b.text

        exact_b = _create_ad(
            "relink_paid_exact_b",
            "relink-paid-exact-b-1",
            {
                "customerId": "relink_paid_cust",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": "relink_paid_b", "amountUSD": 30}],
            },
            admin,
        )
        assert exact_b.status_code == 200, exact_b.text


class TestReceiptRelinkUnpaidDuePath:
    def test_relink_stopped_inshop_ad_frees_old_due_and_moves_it(self, admin):
        _customer("relink_due_cust", admin)
        _office_receipt("relink_due_a", "relink_due_cust", 20, admin)
        _office_receipt("relink_due_b", "relink_due_cust", 20, admin)

        created = _create_ad(
            "relink_due_ad",
            "relink-due-create-1",
            {
                "customerId": "relink_due_cust",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "relink_due_a",
                "dueAllocations": [{"receiptId": "relink_due_a", "amountUSD": 20}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        stopped = _stop_ad(
            "relink_due_ad",
            "relink-due-stop-1",
            1200,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text
        stop_data = stopped.json()["ad"]["data"]
        assert stop_data["status"] == "Stopped"
        assert stop_data["spentUSD"] == 12.0
        assert stop_data["dueAllocations"] == [
            {"receiptId": "relink_due_a", "amountUSD": 12.0}
        ]

        relinked = _update_ad(
            "relink_due_ad",
            "relink-due-move-1",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [],
                "dueAllocations": [{"receiptId": "relink_due_b", "amountUSD": 12}],
            },
            stopped.json()["ad"]["lastModified"],
            admin,
        )
        assert relinked.status_code == 200, relinked.text
        data = relinked.json()["ad"]["data"]
        assert data["status"] == "Stopped"
        assert data["spentUSD"] == 12.0
        assert data["amountUSD"] == 20.0
        assert data["dueAllocations"] == [
            {"receiptId": "relink_due_b", "amountUSD": 12.0}
        ]
        assert data["receiptId"] == "relink_due_b"
        assert data["dueAmountToUseUSD"] == 12.0

        # OLD unpaid receipt A is freed: a fresh In-Shop ad can reserve its whole $20.
        free_a = _create_ad(
            "relink_due_free_a",
            "relink-due-free-a-1",
            {
                "customerId": "relink_due_cust",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "relink_due_a",
                "dueAllocations": [{"receiptId": "relink_due_a", "amountUSD": 20}],
            },
            admin,
        )
        assert free_a.status_code == 200, free_a.text


class TestReceiptRelinkGuards:
    def _stopped_paid_ad(self, tag, admin, receipt_amount=50):
        cust = f"relink_g_cust_{tag}"
        ra = f"relink_g_a_{tag}"
        rb = f"relink_g_b_{tag}"
        _customer(cust, admin)
        _paid_receipt(ra, cust, receipt_amount, admin)
        created = _create_ad(
            f"relink_g_ad_{tag}",
            f"relink-g-create-{tag}",
            {
                "customerId": cust,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": ra, "amountUSD": 40}],
            },
            admin,
        )
        assert created.status_code == 200, created.text
        stopped = _stop_ad(
            f"relink_g_ad_{tag}",
            f"relink-g-stop-{tag}",
            3000,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text
        return (
            f"relink_g_ad_{tag}",
            cust,
            ra,
            rb,
            stopped.json()["ad"]["lastModified"],
        )

    def test_relink_to_short_receipt_is_rejected_and_ad_untouched(self, admin):
        ad_id, cust, ra, rb, version = self._stopped_paid_ad("short", admin)
        _paid_receipt(rb, cust, 10, admin)  # too small for the $30 spend

        rejected = _update_ad(
            ad_id,
            "relink-g-short-move",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
                "dueAllocations": [],
            },
            version,
            admin,
        )
        assert rejected.status_code == 409, rejected.text
        assert "Insufficient balance" in rejected.text

        current = client.get(f"/api/collections/ads/{ad_id}", cookies=admin)
        assert current.status_code == 200
        cdata = current.json()["data"]
        assert cdata["receiptAllocations"] == [{"receiptId": ra, "amountUSD": 30.0}]
        assert cdata["spentUSD"] == 30.0
        assert cdata["status"] == "Stopped"

    def test_relink_cannot_change_amount_spend_or_status(self, admin):
        ad_id, cust, ra, rb, version = self._stopped_paid_ad("locked", admin)
        _paid_receipt(rb, cust, 60, admin)

        amount = _update_ad(
            ad_id,
            "relink-g-amount",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
                "amountUSD": 999,
            },
            version,
            admin,
        )
        assert amount.status_code == 400, amount.text

        spent = _update_ad(
            ad_id,
            "relink-g-spent",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
                "spentUSD": 5,
            },
            version,
            admin,
        )
        assert spent.status_code == 400, spent.text

        status = _update_ad(
            ad_id,
            "relink-g-status",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
                "status": "Active",
            },
            version,
            admin,
        )
        assert status.status_code == 400, status.text

        # Moving a DIFFERENT amount than the committed spend is not a relink —
        # money must be conserved, only the receipt may move.
        grow = _update_ad(
            ad_id,
            "relink-g-grow",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 45}],
                "dueAllocations": [],
            },
            version,
            admin,
        )
        assert grow.status_code == 400, grow.text

        # After every rejection the ad is still on its original receipt.
        current = client.get(f"/api/collections/ads/{ad_id}", cookies=admin)
        assert current.json()["data"]["receiptAllocations"] == [
            {"receiptId": ra, "amountUSD": 30.0}
        ]

    def test_relink_and_refund_in_one_request_is_rejected(self, admin):
        ad_id, cust, ra, rb, version = self._stopped_paid_ad("both", admin)
        _paid_receipt(rb, cust, 60, admin)

        both = _update_ad(
            ad_id,
            "relink-g-both-move",
            {
                "relinkReceiptOnly": True,
                "refundType": "Full",
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
            },
            version,
            admin,
        )
        assert both.status_code == 400, both.text

    def test_relink_with_stale_version_conflicts(self, admin):
        ad_id, cust, ra, rb, version = self._stopped_paid_ad("stale", admin)
        _paid_receipt(rb, cust, 60, admin)

        stale = _update_ad(
            ad_id,
            "relink-g-stale-move",
            {
                "relinkReceiptOnly": True,
                "receiptAllocations": [{"receiptId": rb, "amountUSD": 30}],
                "dueAllocations": [],
            },
            version - 1,
            admin,
        )
        assert stale.status_code == 409, stale.text
        assert "Conflict" in stale.text

    def test_normal_edit_of_terminal_ad_is_still_blocked(self, admin):
        ad_id, cust, ra, rb, version = self._stopped_paid_ad("regress", admin)

        blocked = _update_ad(
            ad_id,
            "relink-g-normal-edit",
            {"pageId": "some_other_page"},
            version,
            admin,
        )
        assert blocked.status_code == 409, blocked.text
        assert "terminal or refunded ad" in blocked.text
