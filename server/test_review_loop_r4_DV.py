"""Review loop round 4, batch DV: deliveries (main.py delivery branches, delivery_workflow, rbac, delivery_ops).

Behaviour tests for the verified findings of the batch; each one failed before its fix:

* 1  a present but empty / null / unknown deliveryStatus is refused (driver branch for receipts and
     ads, the deliveries.* grant path, and the atomic receipt patch), so a finished job can no longer
     be blanked, reopened and settled again with less cash;
* 2  the office can save a receipt-form edit of a driver-delivered D-receipt (the form echoes the
     stored "Delivered"): phone fix, Canceled, Lost, and the /unsettle debt conversion. A real
     transition to Delivered and an admin re-settlement are still refused;
* 3  a driver completion of a job the office already settled stores 0 collected (not "missing",
     which the screens read as the whole receipt held by the driver) and keeps the office's
     payment rows;
* 4  POST /api/deliveries/check-stuck with {"hours_threshold": 1e400} is a 200, not a 500.

Users are made here with unique emails; every record made here is soft-deleted at the end.
Run: python -m pytest server/test_review_loop_r4_DV.py -q
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
from server import delivery_workflow
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.74", 50000))
PW = "ReviewLoopR4DvPassword1!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
PROOF = "data:image/jpeg;base64,YQ=="
_MADE: list[str] = []


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name: str, role: str, permissions: dict) -> dict:
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    uid = new_id("user")
    email = f"r4dv-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": stamp},
        )
    return {"id": uid, "email": email, "cookies": _login(email)}


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin = _user("admin", "Admin", {})
    out = {
        "admin": admin,
        "driver": _user("driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
        "editor": _user("editor", "Employee", {"receipts": ["view", "edit"], "customers": ["view"]}),
        "acceptor": _user("acceptor", "Employee", {"deliveries": ["accept"], "receipts": ["view"]}),
    }
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"R4 DV Customer {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}},
        cookies=admin["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    _MADE.append(out["customer_id"])
    yield out
    # Soft-delete everything made here so later modules never see these jobs.
    with db_conn() as conn:
        for rid in _MADE:
            conn.execute(text("UPDATE entities SET deleted = true WHERE id = :id"), {"id": rid})


def _final_no() -> str:
    return str(secrets.randbelow(9 * 10**8) + 10**8)


def _d_receipt(actors, delivery_status: str = "Needs Delivery", **extra) -> dict:
    data = {
        "recordType": "receipt", "customerId": actors["customer_id"],
        "status": "Not Paid", "isPaid": False,
        "amountUSD": 100, "amountLocal": 500, "exchangeRate": 5,
        "debtAmountLocal": 500, "debtAmountUSD": 100,
        "tempReceiptNo": "D" + _final_no(), "deliveryStatus": delivery_status,
        "deliveryPersonId": actors["driver"]["id"], "isReceivedInOffice": False,
        "statusDetail": {"notPaidCollection": "delivery"},
    }
    data.update(extra)
    created = client.post(RECEIPTS, json={"data": data}, cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    _MADE.append(created.json()["id"])
    return created.json()


def _patch(actors, who: str, receipt_id: str, data: dict):
    return client.patch(f"{RECEIPTS}/{receipt_id}", json={"data": data}, cookies=actors[who]["cookies"])


def _get(actors, receipt_id: str) -> dict:
    response = client.get(f"{RECEIPTS}/{receipt_id}", cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _delivered(actors, collected: float) -> dict:
    """A D-receipt the assigned driver accepted and completed with ``collected`` LYD of a 500 LYD debt."""
    receipt = _d_receipt(actors)
    accepted = _patch(actors, "driver", receipt["id"], {"deliveryStatus": "In Progress"})
    assert accepted.status_code == 200, accepted.text
    done = _patch(actors, "driver", receipt["id"], {
        "deliveryStatus": "Delivered", "finalReceiptNo": _final_no(), "receiptImage": PROOF,
        "amountCollectedFromCustomer": collected, "actualDeliveryFeeCollected": 0,
    })
    assert done.status_code == 200, done.text
    assert done.json()["data"]["deliveryStatus"] == "Delivered"
    return done.json()


def _form_payload(stored: dict, **overrides) -> dict:
    """What src/14-forms.js saveReceipt sends for a driver-owned job: the stored status, driver and handover flag echoed."""
    data = {
        "customerId": stored["customerId"], "status": "Not Paid", "isPaid": False,
        "statusDetail": {"notPaidCollection": "delivery"},
        "deliveryStatus": stored["deliveryStatus"], "deliveryPersonId": stored["deliveryPersonId"],
        "isReceivedInOffice": stored.get("isReceivedInOffice") is True,
        "tempReceiptNo": stored["tempReceiptNo"], "finalReceiptNo": stored.get("finalReceiptNo") or "",
        "serialNumber": "",  # a Not Paid + delivery form is in temp-receipt mode: it never sends the serial
        "phoneNumber": "0912345678",
    }
    data.update(overrides)
    return data


# ---------------------------------------------------------------- finding 1: blank / unknown status

def test_driver_cannot_blank_a_delivered_receipt_and_settle_it_again(actors):
    receipt = _delivered(actors, 250)
    rid = receipt["id"]
    assert receipt["data"]["paymentResult"] == "UNDERPAID"
    for blank in ("", None, "delivered", "Pending"):
        refused = _patch(actors, "driver", rid, {"deliveryStatus": blank})
        assert refused.status_code == 400, (blank, refused.text)      # before: 200 and "" stored
    stored = _get(actors, rid)["data"]
    assert stored["deliveryStatus"] == "Delivered"
    assert float(stored["amountCollectedFromCustomer"]) == 250.0
    # The rest of the chain ("" -> In Progress -> Delivered with 0 collected) never starts.
    reopened = _patch(actors, "driver", rid, {"deliveryStatus": "In Progress"})
    assert reopened.status_code == 400, reopened.text
    assert float(_get(actors, rid)["data"]["amountCollectedFromCustomer"]) == 250.0


def test_driver_cannot_blank_a_delivered_ad(actors):
    ad_id = new_id("ad")
    stamp = now_ms()
    data = {"id": ad_id, "customerId": actors["customer_id"], "deliveryStatus": "Delivered",
            "deliveryPersonId": actors["driver"]["id"], "isPaid": True, "status": "Completed"}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:d,false,:t,:uid,:t)"),
            {"id": ad_id, "d": json_dumps(data), "t": stamp, "uid": actors["admin"]["id"]},
        )
    _MADE.append(ad_id)
    refused = client.patch(f"/api/collections/ads/{ad_id}", json={"data": {"deliveryStatus": ""}},
                           cookies=actors["driver"]["cookies"])
    assert refused.status_code == 400, refused.text                    # before: 200 and "" stored
    stored = client.get(f"/api/collections/ads/{ad_id}", cookies=actors["admin"]["cookies"])
    assert stored.json()["data"]["deliveryStatus"] == "Delivered"


def test_a_delivery_grant_cannot_blank_a_finished_job(actors):
    receipt = _delivered(actors, 500)
    for blank in (None, ""):
        refused = _patch(actors, "acceptor", receipt["id"], {"deliveryStatus": blank})
        assert refused.status_code == 403, (blank, refused.text)      # before: 200 (patch_allowed said yes)
    assert _get(actors, receipt["id"])["data"]["deliveryStatus"] == "Delivered"
    # The grant's normal move still works.
    fresh = _d_receipt(actors)
    accepted = _patch(actors, "acceptor", fresh["id"], {"deliveryStatus": "In Progress"})
    assert accepted.status_code == 200, accepted.text


def test_patch_allowed_refuses_a_blank_or_unknown_status():
    existing = {"data": {"deliveryStatus": "Delivered", "deliveryPersonId": "u1"}}
    for value in ("", None, "delivered", 5):
        assert delivery_workflow.patch_allowed(
            existing, {"deliveryStatus": value}, has=lambda a: True, active_driver=lambda x: True
        ) is False, value
    open_job = {"data": {"deliveryStatus": "Needs Delivery", "deliveryPersonId": "u1"}}
    assert delivery_workflow.patch_allowed(
        open_job, {"deliveryStatus": "In Progress"}, has=lambda a: True, active_driver=lambda x: True
    ) is True


def test_every_receipt_writer_refuses_a_blank_status(actors):
    receipt = _delivered(actors, 500)
    refused = _patch(actors, "admin", receipt["id"], {"deliveryStatus": ""})
    assert refused.status_code == 400, refused.text                    # before: 200 and "" stored
    assert _get(actors, receipt["id"])["data"]["deliveryStatus"] == "Delivered"


# ---------------------------------------------------------------- finding 2: the form edit of a delivered D-receipt

def test_office_saves_a_form_edit_of_an_underpaid_delivered_d_receipt(actors):
    for who in ("admin", "editor"):
        receipt = _delivered(actors, 250)
        stored = receipt["data"]
        saved = client.patch(f"{RECEIPTS}/{receipt['id']}", json={
            "data": _form_payload(stored), "expectedLastModified": receipt["lastModified"],
        }, cookies=actors[who]["cookies"])
        # before: admin 403 "Drivers cannot mark office handover",
        #         editor 403 "Only the assigned delivery user or an admin can mark this receipt delivered"
        assert saved.status_code == 200, (who, saved.text)
        after = _get(actors, receipt["id"])["data"]                    # the admin reads the phone back
        assert after["deliveryStatus"] == "Delivered" and after["phoneNumber"] == "0912345678"
        assert float(after["amountCollectedFromCustomer"]) == 250.0
        assert after["finalReceiptNo"] == stored["finalReceiptNo"]
        assert after["deliveryPersonId"] == actors["driver"]["id"]


def test_office_cancels_or_writes_off_a_delivered_d_receipt(actors):
    for status in ("Canceled", "Lost"):
        receipt = _delivered(actors, 250)
        saved = _patch(actors, "admin", receipt["id"], _form_payload(receipt["data"], status=status, isPaid=False))
        assert saved.status_code == 200, (status, saved.text)
        assert saved.json()["data"]["status"] == status
        assert saved.json()["data"]["deliveryStatus"] == "Delivered"


def test_office_converts_a_paid_delivered_d_receipt_back_to_debt(actors):
    receipt = _delivered(actors, 500)
    assert receipt["data"]["status"] == "Paid"
    converted = client.post(f"/api/receipts/{receipt['id']}/unsettle", json={
        "idempotencyKey": f"r4dv-unsettle-{TAG}",
        "expectedLastModified": receipt["lastModified"],
        "data": _form_payload(receipt["data"]),
    }, cookies=actors["admin"]["cookies"])
    # before: 400 "Receipt debt conversion cannot mark a delivery completed"
    assert converted.status_code == 200, converted.text
    after = converted.json()["receipt"]["data"]
    assert after["status"] == "Not Paid" and after["isPaid"] is False
    assert after["deliveryStatus"] == "Delivered"                        # not re-queued
    assert after["tempReceiptNo"] == receipt["data"]["tempReceiptNo"]


def test_a_real_transition_to_delivered_is_still_refused(actors):
    receipt = _d_receipt(actors)
    accepted = _patch(actors, "driver", receipt["id"], {"deliveryStatus": "In Progress"})
    assert accepted.status_code == 200, accepted.text
    staff = _patch(actors, "editor", receipt["id"], {"deliveryStatus": "Delivered", "phoneNumber": "0911111111"})
    assert staff.status_code == 403, staff.text
    # /unsettle cannot complete a job either (the receipt is not paid, but the delivery rule answers first).
    paid = _d_receipt(actors, "In Progress", status="Paid", isPaid=True)
    unsettle = client.post(f"/api/receipts/{paid['id']}/unsettle", json={
        "idempotencyKey": f"r4dv-unsettle-open-{TAG}", "expectedLastModified": paid["lastModified"],
        "data": {"status": "Not Paid", "isPaid": False, "deliveryStatus": "Delivered"},
    }, cookies=actors["admin"]["cookies"])
    assert unsettle.status_code == 400, unsettle.text
    assert _get(actors, paid["id"])["data"]["deliveryStatus"] == "In Progress"
    # A canceled D-receipt cannot be flipped to Delivered by the admin's plain edit.
    canceled = _d_receipt(actors, "Canceled")
    flip = _patch(actors, "admin", canceled["id"], {"deliveryStatus": "Delivered", "phoneNumber": "0911111111"})
    assert flip.status_code in (400, 403), flip.text
    assert _get(actors, canceled["id"])["data"]["deliveryStatus"] == "Canceled"


def test_admin_still_cannot_resettle_a_delivered_d_receipt(actors):
    receipt = _delivered(actors, 250)
    again = _patch(actors, "admin", receipt["id"], {
        "deliveryStatus": "Delivered", "finalReceiptNo": _final_no(), "receiptImage": PROOF,
        "amountCollectedFromCustomer": 0, "actualDeliveryFeeCollected": 0,
    })
    assert again.status_code in (400, 409), again.text
    stored = _get(actors, receipt["id"])["data"]
    assert float(stored["amountCollectedFromCustomer"]) == 250.0
    assert stored["finalReceiptNo"] == receipt["data"]["finalReceiptNo"]


# ---------------------------------------------------------------- finding 3: the office already settled the job

def test_driver_completion_of_an_office_settled_job_keeps_the_office_payment(actors):
    office_rows = [{"method": "Cash (USD)", "amount": 100, "rate": 5}]
    receipt = _d_receipt(actors, "In Progress", status="Paid", isPaid=True,
                         payments=office_rows, paymentMethod="Cash (USD)",
                         statusDetail={"paidCollection": "office"})
    done = _patch(actors, "driver", receipt["id"], {
        "deliveryStatus": "Delivered", "finalReceiptNo": _final_no(), "receiptImage": PROOF,
        "amountCollectedFromCustomer": 0, "actualDeliveryFeeCollected": 0,
        "payments": [], "paymentMethod": "Cash (LYD)",
    })
    assert done.status_code == 200, done.text
    saved = done.json()["data"]
    assert saved["deliveryStatus"] == "Delivered"
    # before: missing, so the Deliveries screen showed the 500 LYD as cash the driver holds
    assert float(saved["amountCollectedFromCustomer"]) == 0.0
    # before: [] and "Cash (LYD)" (the driver's rows replaced the office's breakdown)
    assert saved["payments"] == office_rows and saved["paymentMethod"] == "Cash (USD)"
    assert saved["status"] == "Paid" and saved["isPaid"] is True
    assert float(saved["amountUSD"]) == 100.0 and float(saved["amountLocal"]) == 500.0


# ---------------------------------------------------------------- finding 4: check-stuck overflow

def test_check_stuck_with_an_infinite_threshold_is_not_a_500(actors):
    for body in ('{"hours_threshold": 1e400}', '{"hours_threshold": Infinity}'):
        response = client.post("/api/deliveries/check-stuck", content=body,
                               headers={"Content-Type": "application/json"},
                               cookies=actors["admin"]["cookies"])
        assert response.status_code == 200, (body, response.text)      # before: OverflowError -> 500
