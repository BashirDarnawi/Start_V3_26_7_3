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

SETTLE variant (TestReceiptSettleTerminal): a terminal ad whose debt the
customer has now paid may flip not_paid -> paid while moving its COMMITTED
total from the due pool onto paid receipt(s):
  * Cross-pool conservation to the cent (old paid + old due == new paid).
  * The old unpaid receipt ends at ZERO use; the new one must have capacity
    (409 leaves the ad untouched).
  * spentUSD / amountUSD / status stay untouched; mirrors are rebuilt.
  * paid -> not_paid stays forbidden (400); a settle on a non-terminal ad
    stays forbidden (400) — live debts settle through the ordinary edit path.

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


class TestReceiptSettleTerminal:
    """Terminal-ad SETTLE: the customer paid a stopped ad's remaining debt, so
    its committed due funding moves onto a paid receipt and the ad becomes
    paid — amount/spend/status untouched, old unpaid receipt fully freed.

    Production shape under test: ad $9.00, Stopped, spentUSD $1.24, not_paid,
    dueAllocations [{old unpaid In-Shop receipt: 1.24}] (stop already released
    the unspent $7.76). Settling must move exactly $1.24 to a paid receipt."""

    def _stopped_unpaid_shop_ad(self, tag, admin, *, paid_receipt_amount=60):
        cust = f"settle_cust_{tag}"
        old_rid = f"settle_due_{tag}"
        new_rid = f"settle_paid_{tag}"
        ad_id = f"settle_ad_{tag}"
        _customer(cust, admin)
        _office_receipt(old_rid, cust, 9, admin)
        _paid_receipt(new_rid, cust, paid_receipt_amount, admin)
        created = _create_ad(
            ad_id,
            f"settle-create-{tag}",
            {
                "customerId": cust,
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": old_rid,
                "dueAllocations": [{"receiptId": old_rid, "amountUSD": 9}],
            },
            admin,
        )
        assert created.status_code == 200, created.text
        stopped = _stop_ad(
            ad_id,
            f"settle-stop-{tag}",
            124,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text
        data = stopped.json()["ad"]["data"]
        assert data["status"] == "Stopped"
        assert data["spentUSD"] == 1.24
        assert data["amountUSD"] == 9.0
        assert data["dueAllocations"] == [
            {"receiptId": old_rid, "amountUSD": 1.24}
        ]
        return ad_id, cust, old_rid, new_rid, stopped.json()["ad"]["lastModified"]

    def _current(self, ad_id, admin):
        response = client.get(f"/api/collections/ads/{ad_id}", cookies=admin)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_settle_moves_committed_due_to_paid_receipt(self, admin):
        ad_id, cust, old_rid, new_rid, version = self._stopped_unpaid_shop_ad(
            "happy", admin
        )

        settled = _update_ad(
            ad_id,
            "settle-happy-move",
            {
                "relinkReceiptOnly": True,
                "paymentStatus": "paid",
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 1.24}],
                "dueAllocations": [],
            },
            version,
            admin,
        )
        assert settled.status_code == 200, settled.text
        data = settled.json()["ad"]["data"]
        # Payment flipped, pools moved, money identity untouched.
        assert data["paymentStatus"] == "paid"
        assert data["isPaid"] is True
        assert data["status"] == "Stopped"
        assert data["spentUSD"] == 1.24
        assert data["amountUSD"] == 9.0
        assert data["receiptAllocations"] == [
            {"receiptId": new_rid, "amountUSD": 1.24}
        ]
        assert data["dueAllocations"] == []
        # Derived mirrors are rebuilt exactly like a plain relink would.
        assert data["dueAmountToUseUSD"] == 0.0
        assert data["dueAmountToUseLYD"] == 0.0
        assert data["receiptIds"] == [new_rid]
        assert data["fundingReceiptId"] == new_rid
        assert data["receiptId"] == new_rid
        assert data["linkedDeliveryReceiptId"] == ""
        assert data["collectionMethod"] == ""
        assert data["collectionPayments"] == []
        assert data["paymentMethod"] == ""
        assert data["mergedPaidAllocations"] == []
        assert data["hasMergedPaidFunds"] is False
        # The marker never persists onto the stored row.
        assert "relinkReceiptOnly" not in data

        # OLD unpaid receipt ends at ZERO use (the owner's standing
        # requirement): a fresh In-Shop ad can reserve its whole $9 again.
        freed = _create_ad(
            "settle_happy_free_a",
            "settle-happy-free-a",
            {
                "customerId": cust,
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": old_rid,
                "dueAllocations": [{"receiptId": old_rid, "amountUSD": 9}],
            },
            admin,
        )
        assert freed.status_code == 200, freed.text

        # NEW receipt now carries the moved $1.24 of its $60: one cent more
        # than the remaining $58.76 must 409, the exact remainder must fit.
        over = _create_ad(
            "settle_happy_over_b",
            "settle-happy-over-b",
            {
                "customerId": cust,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 58.77}],
            },
            admin,
        )
        assert over.status_code == 409, over.text
        exact = _create_ad(
            "settle_happy_exact_b",
            "settle-happy-exact-b",
            {
                "customerId": cust,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 58.76}],
            },
            admin,
        )
        assert exact.status_code == 200, exact.text

    def test_settle_rejected_unless_paid_total_equals_committed_total(self, admin):
        ad_id, cust, old_rid, new_rid, version = self._stopped_unpaid_shop_ad(
            "total", admin
        )

        # The dead $9.00 budget is NOT the settle amount — only the committed
        # $1.24 is. Too much, too little and one-cent-off all fail closed.
        for index, wrong in enumerate((9.0, 1.23, 1.25)):
            rejected = _update_ad(
                ad_id,
                f"settle-total-wrong-{index}",
                {
                    "relinkReceiptOnly": True,
                    "paymentStatus": "paid",
                    "receiptAllocations": [
                        {"receiptId": new_rid, "amountUSD": wrong}
                    ],
                    "dueAllocations": [],
                },
                version,
                admin,
            )
            assert rejected.status_code == 400, rejected.text
            assert "preserve the ad's committed amount" in rejected.text

        # A settle may not leave part of the money behind in the due pool.
        split = _update_ad(
            ad_id,
            "settle-total-split",
            {
                "relinkReceiptOnly": True,
                "paymentStatus": "paid",
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 1.00}],
                "dueAllocations": [{"receiptId": old_rid, "amountUSD": 0.24}],
            },
            version,
            admin,
        )
        assert split.status_code == 400, split.text

        # After every rejection the ad still holds its original debt shape.
        cdata = self._current(ad_id, admin)
        assert cdata["paymentStatus"] == "not_paid"
        assert cdata["status"] == "Stopped"
        assert cdata["receiptAllocations"] == []
        assert cdata["dueAllocations"] == [
            {"receiptId": old_rid, "amountUSD": 1.24}
        ]

    def test_settle_insufficient_new_receipt_balance_leaves_ad_untouched(self, admin):
        ad_id, cust, old_rid, new_rid, version = self._stopped_unpaid_shop_ad(
            "short", admin, paid_receipt_amount=1
        )

        rejected = _update_ad(
            ad_id,
            "settle-short-move",
            {
                "relinkReceiptOnly": True,
                "paymentStatus": "paid",
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 1.24}],
                "dueAllocations": [],
            },
            version,
            admin,
        )
        assert rejected.status_code == 409, rejected.text
        assert "Insufficient balance" in rejected.text

        cdata = self._current(ad_id, admin)
        assert cdata["paymentStatus"] == "not_paid"
        assert cdata["status"] == "Stopped"
        assert cdata["spentUSD"] == 1.24
        assert cdata["amountUSD"] == 9.0
        assert cdata["receiptAllocations"] == []
        assert cdata["dueAllocations"] == [
            {"receiptId": old_rid, "amountUSD": 1.24}
        ]
        assert cdata["collectionMethod"] == "in_shop"

    def test_settle_reverse_paid_to_not_paid_is_rejected(self, admin):
        cust = "settle_cust_reverse"
        paid_rid = "settle_paid_reverse_a"
        due_rid = "settle_due_reverse_b"
        _customer(cust, admin)
        _paid_receipt(paid_rid, cust, 50, admin)
        _office_receipt(due_rid, cust, 40, admin)
        created = _create_ad(
            "settle_ad_reverse",
            "settle-reverse-create",
            {
                "customerId": cust,
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [{"receiptId": paid_rid, "amountUSD": 40}],
            },
            admin,
        )
        assert created.status_code == 200, created.text
        stopped = _stop_ad(
            "settle_ad_reverse",
            "settle-reverse-stop",
            3000,
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert stopped.status_code == 200, stopped.text

        rejected = _update_ad(
            "settle_ad_reverse",
            "settle-reverse-move",
            {
                "relinkReceiptOnly": True,
                "paymentStatus": "not_paid",
                "receiptAllocations": [],
                "dueAllocations": [{"receiptId": due_rid, "amountUSD": 30}],
            },
            stopped.json()["ad"]["lastModified"],
            admin,
        )
        assert rejected.status_code == 400, rejected.text
        assert "cannot change the ad payment status" in rejected.text

        cdata = self._current("settle_ad_reverse", admin)
        assert cdata["paymentStatus"] == "paid"
        assert cdata["receiptAllocations"] == [
            {"receiptId": paid_rid, "amountUSD": 30.0}
        ]

    def test_settle_requires_a_terminal_ad(self, admin):
        cust = "settle_cust_active"
        old_rid = "settle_due_active_a"
        new_rid = "settle_paid_active_b"
        _customer(cust, admin)
        _office_receipt(old_rid, cust, 9, admin)
        _paid_receipt(new_rid, cust, 60, admin)
        created = _create_ad(
            "settle_ad_active",
            "settle-active-create",
            {
                "customerId": cust,
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": old_rid,
                "dueAllocations": [{"receiptId": old_rid, "amountUSD": 9}],
            },
            admin,
        )
        assert created.status_code == 200, created.text

        # Even with perfect cross-pool conservation, a LIVE unpaid ad must
        # settle through the ordinary edit path (which funds the full budget
        # and rewrites the money identity) — never through the relink flag.
        rejected = _update_ad(
            "settle_ad_active",
            "settle-active-move",
            {
                "relinkReceiptOnly": True,
                "paymentStatus": "paid",
                "receiptAllocations": [{"receiptId": new_rid, "amountUSD": 9}],
                "dueAllocations": [],
            },
            created.json()["ad"]["lastModified"],
            admin,
        )
        assert rejected.status_code == 400, rejected.text
        assert "cannot change the ad payment status" in rejected.text

        cdata = self._current("settle_ad_active", admin)
        assert cdata["paymentStatus"] == "not_paid"
        assert cdata["dueAllocations"] == [
            {"receiptId": old_rid, "amountUSD": 9.0}
        ]
