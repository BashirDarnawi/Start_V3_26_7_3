"""Bug hunt r2 (R2-clothes-operations-4): a new delivery job only goes to an active driver.

PATCH, /settle and /unsettle refuse to hand a job to a deleted or non-driver
account. The generic create did not, so a colleague whose user list was a few
seconds old could still create a D-receipt (or a driver-collected ad) for a
driver an admin had just removed. Nobody could see or finish that job, and a
dispatcher could not easily move it.

Disposable local records only; the suite shares one in-memory database, so
records carry a per-run tag.
"""

import re
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.95", 50000))
PW = "CreateDriverCheck123!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
ADS = "/api/collections/ads"
REFUSAL = "deliveryPersonId must be an active delivery user"


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name: str, role: str, permissions: dict, *, login: bool = True) -> dict:
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    email = f"cdv-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()},
        )
    return {"id": uid, "cookies": _login(email) if login else None}


@pytest.fixture(scope="module")
def actors():
    init_db()
    driver_grants = {"deliveries": ["viewOwn", "accept", "complete"]}
    out = {
        "admin": _user("admin", "Admin", {}),
        "staff": _user("staff", "Employee", {"receipts": ["view", "add", "edit"], "customers": ["view"]}),
        "driver": _user("driver", "Delivery", driver_grants, login=False),
        "gone": _user("gone", "Delivery", driver_grants, login=False),
        "employee": _user("employee", "Employee", {"receipts": ["view"]}, login=False),
    }
    # The admin removes a driver with no open jobs (the users route lets that through).
    removed = client.patch(f"/api/users/{out['gone']['id']}", json={"deleted": True}, cookies=out["admin"]["cookies"])
    assert removed.status_code == 200, removed.text
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"CDV Cust {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=out["admin"]["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    return out


def _temp_receipt(actors, driver_id: str) -> dict:
    """What the receipt form sends for a Not Paid receipt collected by a driver."""
    return {"recordType": "receipt", "customerId": actors["customer_id"], "status": "Not Paid", "isPaid": False,
            "amountUSD": 50, "amountLocal": 250, "exchangeRate": 5, "deliveryStatus": "Needs Delivery",
            "deliveryPersonId": driver_id, "statusDetail": {"notPaidCollection": "delivery"}}


def _driver_ad(actors, payment_status: str, driver_id: str) -> dict:
    return {"recordType": "ad", "customerId": actors["customer_id"], "paymentStatus": payment_status,
            "collectionMethod": "driver", "status": "Active", "deliveryStatus": "Needs Delivery",
            "deliveryPersonId": driver_id}


def _absent(actors, path: str, entity_id: str) -> bool:
    return client.get(f"{path}/{entity_id}", cookies=actors["admin"]["cookies"]).status_code == 404


@pytest.mark.parametrize("who", ["gone", "employee"])
def test_temp_receipt_create_refuses_a_deleted_driver_or_a_non_driver(actors, who):
    rid = new_id("cdvrcpt")
    created = client.post(RECEIPTS, json={"id": rid, "data": _temp_receipt(actors, actors[who]["id"])},
                          cookies=actors["staff"]["cookies"])
    assert created.status_code == 400, created.text  # before the fix: 200 with a D number nobody could finish
    assert created.json()["detail"] == REFUSAL
    assert _absent(actors, RECEIPTS, rid)


def test_temp_receipt_create_for_an_active_driver_still_works(actors):
    created = client.post(RECEIPTS, json={"data": _temp_receipt(actors, actors["driver"]["id"])},
                          cookies=actors["staff"]["cookies"])
    assert created.status_code == 200, created.text
    data = created.json()["data"]
    assert re.fullmatch(r"D[0-9]+", data["tempReceiptNo"]), data
    assert data["deliveryPersonId"] == actors["driver"]["id"] and data["deliveryStatus"] == "Needs Delivery"


def test_paid_driver_ad_create_refuses_a_deleted_driver(actors):
    ad_id = new_id("cdvad")
    created = client.post(ADS, json={"id": ad_id, "data": _driver_ad(actors, "paid", actors["gone"]["id"])},
                          cookies=actors["admin"]["cookies"])
    assert created.status_code == 400, created.text  # before the fix: 200
    assert created.json()["detail"] == REFUSAL
    assert _absent(actors, ADS, ad_id)
    fine = client.post(ADS, json={"data": _driver_ad(actors, "paid", actors["driver"]["id"])}, cookies=actors["admin"]["cookies"])
    assert fine.status_code == 200, fine.text
    assert fine.json()["data"]["deliveryPersonId"] == actors["driver"]["id"]


def test_not_paid_driver_ad_whose_driver_the_server_clears_still_saves(actors):
    # Not Paid + Driver: the delivery lives on the receipt, so the server clears the ad's driver
    # before the check, and a stale id in the form does not matter.
    created = client.post(ADS, json={"data": _driver_ad(actors, "not_paid", actors["gone"]["id"])},
                          cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    data = created.json()["data"]
    assert data["deliveryPersonId"] == "" and data["deliveryStatus"] == "Office"
