"""Review loop round 7, batch K: Clothes System.

* n=21 an order whose collected amount covers the whole total is Paid, not "Partially Paid":
       - an edit that lowers the total under what was collected (item returned) stores Paid with the
         collected amount kept and the difference owed back (refundDueLYD);
       - the payment action recording the full total as a "partial" amount stores Paid with paidAt;
       - a real partial amount (less than the total) still stays Partially Paid.

n=20 (stock stepper) and n=22 (translated refusals) are client fixes; their behaviour tests are in
scripts/test-review-regressions.js.

The user is made here with a unique e-mail (soft-deleted at the end); every order, product and
order-mutation marker made here is removed at the end.
Run: python -m pytest server/test_review_loop_r7_K.py -q
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"})
PW = "ReviewLoopR7ClothesPassword1!"
TAG = secrets.token_hex(4)
_ORDERS: list[str] = []


@pytest.fixture(scope="module")
def admin():
    init_db()
    uid = new_id("user")
    email = f"r7k-admin-{TAG}@tests.albayanhub.com"
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,'R7K Admin',:email,'Admin',:perms,:hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "email": email, "perms": json_dumps({}), "hash": pw.hash_hex, "salt": pw.salt_hex,
             "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    yield {"id": uid, "cookies": cookies}
    with db_conn() as conn:
        for order_id in _ORDERS:
            for row in conn.execute(
                text(f"SELECT id,data_json FROM entities WHERE type='{main.CLOTHES_ORDER_MUTATION_COLLECTION}'")
            ).mappings().all():
                if (json_loads(row["data_json"]) or {}).get("orderId") == order_id:
                    conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": row["id"]})
        conn.execute(text("DELETE FROM entities WHERE id LIKE :tag"), {"tag": f"%r7k%{TAG}%"})
        conn.execute(text("DELETE FROM sessions WHERE user_id=:id"), {"id": uid})
        conn.execute(text("UPDATE users SET deleted=true WHERE id=:id"), {"id": uid})


def _product(admin, name: str, qty: int = 10) -> str:
    pid = f"r7k_{name}_{TAG}"
    response = client.post(
        "/api/collections/clothesProducts",
        json={"id": pid, "data": {"name": name, "costUSD": 3, "priceLYD": 20,
                                  "variants": [{"color": "Red", "size": "M", "qty": qty}]}},
        cookies=admin["cookies"],
    )
    assert response.status_code == 200, response.text
    return pid


def _data(pid: str, qty: int, status: str, paid: float) -> dict:
    # qty x 20 LYD + 5 LYD delivery
    return {"customerName": "R7K Customer", "customerPhone": "0910000000", "note": "",
            "lines": [{"productId": pid, "color": "Red", "size": "M", "qty": qty, "priceLYD": 20}],
            "deliveryFeeLYD": 5, "paymentStatus": status, "amountPaidLYD": paid, "paymentMethod": "Cash"}


def _mutate(admin, payload: dict):
    return client.post("/api/clothes/orders/mutate", json=payload, cookies=admin["cookies"])


def _create(admin, pid: str, qty: int, status: str, paid: float) -> dict:
    oid = f"r7k_order_{secrets.token_hex(3)}_{TAG}"
    _ORDERS.append(oid)
    response = _mutate(admin, {"action": "create", "orderId": oid, "idempotencyKey": f"r7k-create-{oid}",
                               "data": _data(pid, qty, status, paid)})
    assert response.status_code == 200, response.text
    return response.json()["order"]


def test_an_edit_that_lowers_the_total_under_the_collected_money_makes_the_order_paid(admin):
    pid = _product(admin, "returned")
    order = _create(admin, pid, 2, "Partially Paid", 30)          # total 45, 30 collected
    assert order["data"]["paymentStatus"] == "Partially Paid" and order["data"]["paidAt"] is None
    edited = _mutate(admin, {"action": "update", "orderId": order["id"], "idempotencyKey": f"r7k-edit-{order['id']}",
                             "expectedLastModified": order["lastModified"],
                             "data": _data(pid, 1, "Partially Paid", 30)})   # one piece returned: total 25
    assert edited.status_code == 200, edited.text
    data = edited.json()["order"]["data"]
    assert data["paymentStatus"] == "Paid"          # before: stayed "Partially Paid" with nothing left to collect
    assert data["amountPaidLYD"] == 30               # the collected money is kept
    assert data["refundDueLYD"] == 5                 # and the difference is owed back
    assert data["paidAt"]


def test_a_new_order_whose_partial_amount_is_the_whole_total_is_paid(admin):
    pid = _product(admin, "exact")
    order = _create(admin, pid, 2, "Partially Paid", 45)
    assert order["data"]["paymentStatus"] == "Paid"
    assert order["data"]["amountPaidLYD"] == 45 and order["data"]["refundDueLYD"] == 0
    assert order["data"]["paidAt"]


def test_the_payment_action_recording_the_full_total_as_partial_makes_the_order_paid(admin):
    pid = _product(admin, "paynow")
    order = _create(admin, pid, 2, "Not Paid", 0)                  # total 45
    paid = _mutate(admin, {"action": "payment", "orderId": order["id"], "idempotencyKey": f"r7k-pay-{order['id']}",
                           "expectedLastModified": order["lastModified"], "paymentStatus": "Partially Paid",
                           "data": {"amountPaidLYD": 45}})
    assert paid.status_code == 200, paid.text
    data = paid.json()["order"]["data"]
    assert data["paymentStatus"] == "Paid"          # before: "Partially Paid" with remaining 0
    assert data["amountPaidLYD"] == 45 and data["refundDueLYD"] == 0
    assert data["paidAt"]


def test_a_real_partial_payment_stays_partially_paid(admin):
    pid = _product(admin, "partial")
    order = _create(admin, pid, 2, "Partially Paid", 44.99)
    assert order["data"]["paymentStatus"] == "Partially Paid" and order["data"]["paidAt"] is None
    paid = _mutate(admin, {"action": "payment", "orderId": order["id"], "idempotencyKey": f"r7k-part-{order['id']}",
                           "expectedLastModified": order["lastModified"], "paymentStatus": "Partially Paid",
                           "data": {"amountPaidLYD": 20}})
    assert paid.status_code == 200, paid.text
    data = paid.json()["order"]["data"]
    assert data["paymentStatus"] == "Partially Paid" and data["amountPaidLYD"] == 20 and data["paidAt"] is None
