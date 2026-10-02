"""Bug hunt r2 (R2-clothes-operations-3): the generic PATCH keeps the delivery rules /settle enforces.

The Deliveries board's status select sends a bare {"deliveryStatus": ...} through
the generic PATCH. An admin could push an accepted (In Progress) job back to
Needs Delivery there, although /settle refuses that move for every role: the job
could then go to a second driver while the first still carried the goods and the
cash, with no history written. An ads.edit holder could also blank, misspell or
reopen an ad's delivery status. The recorded Cancel and Delete-mission actions
stay the ways out of an accepted job.

Disposable local records only; the suite shares one in-memory database, so
records carry a per-run tag.
"""

import secrets
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.94", 50000))
PW = "GenericPatchRegress123!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
ADS = "/api/collections/ads"
REQUEUE = "An accepted delivery job cannot move back to Needs Delivery; cancel it or delete the mission"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name: str, role: str, permissions: dict) -> dict:
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    email = f"gpr-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()},
        )
    return {"id": uid, "cookies": _login(email)}


@pytest.fixture(scope="module")
def actors():
    init_db()
    out = {
        "admin": _user("admin", "Admin", {}),
        "driver": _user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
        "driver2": _user("driver2", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
        # Office staff with the edit grants and no deliveries.* grant: the generic path.
        "editor": _user("editor", "Employee", {"receipts": ["view", "edit"], "ads": ["view", "edit"], "customers": ["view"]}),
    }
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"GPR Cust {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=out["admin"]["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    return out


def _accepted_receipt(actors) -> dict:
    """A Not Paid delivery receipt the assigned driver has accepted (In Progress)."""
    created = client.post(RECEIPTS, json={"data": {
        "recordType": "receipt", "customerId": actors["customer_id"], "status": "Not Paid", "isPaid": False,
        "amountUSD": 20, "amountLocal": 100, "exchangeRate": 5, "deliveryStatus": "Needs Delivery",
        "deliveryPersonId": actors["driver"]["id"], "statusDetail": {"notPaidCollection": "delivery"},
    }}, cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    accepted = client.patch(f"{RECEIPTS}/{created.json()['id']}", json={"data": {"deliveryStatus": "In Progress"}},
                            cookies=actors["driver"]["cookies"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["data"]["deliveryStatus"] == "In Progress" and accepted.json()["data"]["acceptedDate"]
    return accepted.json()


def _ad(actors, delivery_status, **extra) -> str:
    """Funded ads are born through /api/ads/mutate; the delivery rules do not care, so seed the row."""
    ad_id = new_id("gprad")
    data = {"recordType": "ad", "customerId": actors["customer_id"], "amountUSD": 30, "isPaid": True,
            "paymentStatus": "paid", "collectionMethod": "driver", "status": "Active",
            "deliveryStatus": delivery_status, "deliveryPersonId": actors["driver"]["id"], **extra}
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:id,:d,false,:t,:by,:t)"),
                     {"id": ad_id, "d": json_dumps(data), "t": now_ms(), "by": actors["admin"]["id"]})
    return ad_id


def _stored(actors, path: str, entity_id: str) -> dict:
    response = client.get(f"{path}/{entity_id}", cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_admin_cannot_requeue_an_accepted_receipt_from_the_board(actors):
    receipt = _accepted_receipt(actors)
    rid, accepted_at = receipt["id"], receipt["data"]["acceptedDate"]
    # What the board's status select sends (updateDeliveryStatus -> updateRecord).
    back = client.patch(f"{RECEIPTS}/{rid}", json={"data": {"deliveryStatus": "Needs Delivery"}},
                        cookies=actors["admin"]["cookies"])
    assert back.status_code == 400, back.text  # before the fix: 200, the job back in the queue
    assert back.json()["detail"] == REQUEUE
    stored = _stored(actors, RECEIPTS, rid)
    assert stored["deliveryStatus"] == "In Progress"
    assert stored["acceptedDate"] == accepted_at
    assert stored["deliveryPersonId"] == actors["driver"]["id"]
    # Handing it to another driver on the way back is refused as well.
    repoint = client.patch(f"{RECEIPTS}/{rid}", json={"data": {"deliveryStatus": "Needs Delivery",
                                                               "deliveryPersonId": actors["driver2"]["id"]}},
                           cookies=actors["admin"]["cookies"])
    assert repoint.status_code == 400, repoint.text
    assert _stored(actors, RECEIPTS, rid)["deliveryPersonId"] == actors["driver"]["id"]
    # The editor keeps the staff table's refusal and its text.
    staff = client.patch(f"{RECEIPTS}/{rid}", json={"data": {"deliveryStatus": "Needs Delivery"}},
                         cookies=actors["editor"]["cookies"])
    assert staff.status_code == 400 and "reopened" in staff.text, staff.text


def test_admin_cannot_requeue_an_accepted_ad(actors):
    accepted_at = _now_iso()
    ad_id = _ad(actors, "In Progress", acceptedDate=accepted_at)
    back = client.patch(f"{ADS}/{ad_id}", json={"data": {"deliveryStatus": "Needs Delivery"}},
                        cookies=actors["admin"]["cookies"])
    assert back.status_code == 400, back.text  # before the fix: 200
    assert back.json()["detail"] == REQUEUE
    stored = _stored(actors, ADS, ad_id)
    assert stored["deliveryStatus"] == "In Progress" and stored["acceptedDate"] == accepted_at
    # An older build's mixed edit (re-derived status, no re-pointing) keeps the accepted status and saves the rest.
    mixed = client.patch(f"{ADS}/{ad_id}", json={"data": {"deliveryStatus": "Needs Delivery", "notes": f"call first {TAG}"}},
                         cookies=actors["admin"]["cookies"])
    assert mixed.status_code == 200, mixed.text
    assert mixed.json()["data"]["deliveryStatus"] == "In Progress"
    assert mixed.json()["data"]["notes"] == f"call first {TAG}"
    # The recorded ways out stay open to the admin.
    canceled = client.patch(f"{ADS}/{ad_id}", json={"data": {"deliveryStatus": "Canceled", "deliveryCancelReason": "Customer away"}},
                            cookies=actors["admin"]["cookies"])
    assert canceled.status_code == 200, canceled.text
    assert canceled.json()["data"]["deliveryStatus"] == "Canceled"


@pytest.mark.parametrize("bad", ["", None, "Bogus", "delivered"])
def test_ads_editor_cannot_blank_or_misspell_an_ad_delivery_status(actors, bad):
    ad_id = _ad(actors, "Delivered", deliveredAt=_now_iso())
    response = client.patch(f"{ADS}/{ad_id}", json={"data": {"deliveryStatus": bad}}, cookies=actors["editor"]["cookies"])
    assert response.status_code == 400, response.text  # before the fix: 200 (a blank status reads as Needs Delivery)
    assert response.json()["detail"] == "Invalid deliveryStatus"
    assert _stored(actors, ADS, ad_id)["deliveryStatus"] == "Delivered"


def test_ads_editor_cannot_reopen_or_move_an_ad_delivery_backwards(actors):
    delivered = _ad(actors, "Delivered", deliveredAt=_now_iso())
    reopen = client.patch(f"{ADS}/{delivered}", json={"data": {"deliveryStatus": "In Progress"}}, cookies=actors["editor"]["cookies"])
    assert reopen.status_code == 400 and "reopened" in reopen.text, reopen.text  # before the fix: 200
    assert _stored(actors, ADS, delivered)["deliveryStatus"] == "Delivered"
    canceled = _ad(actors, "Canceled", deliveryCancelReason="Customer away")
    requeue = client.patch(f"{ADS}/{canceled}", json={"data": {"deliveryStatus": "Needs Delivery"}}, cookies=actors["editor"]["cookies"])
    assert requeue.status_code == 400 and "reopened" in requeue.text, requeue.text
    accepted = _ad(actors, "In Progress", acceptedDate=_now_iso())
    back = client.patch(f"{ADS}/{accepted}", json={"data": {"deliveryStatus": "Needs Delivery"}}, cookies=actors["editor"]["cookies"])
    assert back.status_code == 400 and "reopened" in back.text, back.text
    # A move the staff table allows still works.
    office = client.patch(f"{ADS}/{delivered}", json={"data": {"deliveryStatus": "Office"}}, cookies=actors["editor"]["cookies"])
    assert office.status_code == 200, office.text
    assert office.json()["data"]["deliveryStatus"] == "Office"


def test_admin_moves_the_rules_allow_stay_allowed(actors):
    delivered = client.post(RECEIPTS, json={"data": {
        "recordType": "receipt", "customerId": actors["customer_id"], "status": "Paid", "isPaid": True,
        "amountUSD": 20, "amountLocal": 100, "exchangeRate": 5, "deliveryStatus": "Delivered",
        "deliveryPersonId": actors["driver"]["id"], "statusDetail": {"paidCollection": "delivery"},
    }}, cookies=actors["admin"]["cookies"])
    assert delivered.status_code == 200, delivered.text
    office = client.patch(f"{RECEIPTS}/{delivered.json()['id']}", json={"data": {"deliveryStatus": "Office"}},
                          cookies=actors["admin"]["cookies"])
    assert office.status_code == 200, office.text
    assert office.json()["data"]["deliveryStatus"] == "Office"


@pytest.mark.parametrize("stored_status", ["Delivered", "", "Out for Delivery"])
def test_an_ad_edit_resending_its_unchanged_status_still_saves(actors, stored_status):
    ad_id = _ad(actors, stored_status)
    note = f"new note {TAG} {stored_status or 'blank'}"
    saved = client.patch(f"{ADS}/{ad_id}", json={"data": {"deliveryStatus": stored_status, "notes": note}},
                         cookies=actors["editor"]["cookies"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["data"]["notes"] == note
    assert saved.json()["data"]["deliveryStatus"] == stored_status
