"""Permission drift fixes (2026-09-18, round 9): the deliveries.assign grant.

The Deliveries screen offers "Cancel" and "Delete mission" to staff holding
only ``deliveries.assign``; the browser's PATCH payloads for those buttons
(copied verbatim from src/12-views.js submitDeliveryCancel and
removeDeliveryMission) must be accepted by the delivery-grant path, with the
server writing the evidence (history entry, actor id, cleared fields)
itself and money fields staying out of reach.

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


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.98", 50000))
PW = "DriftFixPassword123!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _login(email: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _seed_admin(name: str) -> dict:
    init_db()
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    uid = new_id("user")
    email = f"drift-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"),
            {"id": uid, "name": name, "email": email, "perm": json_dumps({}),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "now": now},
        )
    return {"id": uid, "email": email, "cookies": _login(email)}


def _create_user(admin: dict, name: str, role: str, permissions: dict) -> dict:
    email = f"drift-{name}-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={"name": name, "email": email, "password": PW, "role": role,
                                              "permissions": permissions}, cookies=admin["cookies"])
    assert created.status_code == 200, created.text
    return {"id": created.json()["id"], "email": email, "cookies": _login(email)}


@pytest.fixture(scope="module")
def actors():
    admin = _seed_admin("admin")
    out = {
        "admin": admin,
        # The user under test: assigns deliveries, reads receipts and ads, edits nothing.
        "assigner": _create_user(admin, "assigner", "Employee", {"deliveries": ["assign"], "receipts": ["view"], "ads": ["view"]}),
        "editor": _create_user(admin, "editor", "Employee", {"receipts": ["view", "edit"]}),
        "driver": _create_user(admin, "driver", "Delivery", {"deliveries": ["viewOwn", "accept", "complete"]}),
    }
    customer = client.post("/api/collections/customers", json={"data": {
        "name": f"Drift Cust {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=admin["cookies"])
    assert customer.status_code == 200, customer.text
    out["customer_id"] = customer.json()["id"]
    return out


def _receipt(actors, delivery_status: str, **extra) -> dict:
    """A driver-collected Not Paid delivery receipt with one stored history entry."""
    data = {
        "customerId": actors["customer_id"], "status": "Not Paid", "isPaid": False,
        "amountUSD": 20, "amountLocal": 100, "exchangeRate": 5,
        "deliveryStatus": delivery_status, "deliveryPersonId": actors["driver"]["id"],
        "statusDetail": {"notPaidCollection": "delivery"},
        "deliveryHistory": [{"ts": _now_iso(), "userId": actors["admin"]["id"], "action": "ASSIGNED"}],
    }
    if delivery_status == "In Progress":
        data["acceptedDate"] = _now_iso()
    data.update(extra)
    created = client.post(RECEIPTS, json={"data": data}, cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    return created.json()["data"]


# ---- the browser's payloads, copied from src/12-views.js -------------------

def _cancel_payload(receipt: dict, uid: str, reason: str = "Customer changed their mind") -> dict:
    now_iso = _now_iso()
    next_history = list(receipt.get("deliveryHistory") or [])
    next_history.append({"ts": now_iso, "userId": uid, "action": "CANCELLED_BY_DRIVER", "reason": reason})
    return {
        "deliveryStatus": "Canceled",
        "deliveryCancelReason": reason,
        "deliveryCancelledAt": now_iso,
        "deliveryCancelledBy": uid,
        "deliveryHistory": next_history,
    }


def _delete_mission_payload(receipt: dict, uid: str) -> dict:
    now_iso = _now_iso()
    next_history = list(receipt.get("deliveryHistory") or [])
    next_history.append({"ts": now_iso, "userId": uid, "action": "MISSION_REMOVED"})
    sd0 = receipt.get("statusDetail") if isinstance(receipt.get("statusDetail"), dict) else {}
    next_status_detail = dict(sd0)
    if str(receipt.get("status") or "").strip() == "Not Paid" and str(next_status_detail.get("notPaidCollection") or "").strip() == "delivery":
        next_status_detail["notPaidCollection"] = "office"
    return {
        "deliveryStatus": "Office",
        "deliveryPersonId": "",
        "acceptedDate": "",
        "deliveryCancelReason": "",
        "deliveryCancelledAt": "",
        "deliveryCancelledBy": "",
        "isReceivedInOffice": False,
        "receivedInOfficeAt": "",
        "officeHandover": False,
        "officeHandoverAt": "",
        "deliveryHistory": next_history,
        "statusDetail": next_status_detail,
    }


def _patch(actors, who: str, receipt_id: str, data: dict):
    return client.patch(f"{RECEIPTS}/{receipt_id}", json={"data": data}, cookies=actors[who]["cookies"])


# ---- Cancel ----------------------------------------------------------------

def test_assign_holder_cancels_an_in_progress_delivery_with_the_client_payload(actors):
    receipt = _receipt(actors, "In Progress")
    uid = actors["assigner"]["id"]
    saved = _patch(actors, "assigner", receipt["id"], _cancel_payload(receipt, uid))
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["deliveryStatus"] == "Canceled"
    assert data["deliveryCancelReason"] == "Customer changed their mind"
    assert data["deliveryCancelledBy"] == uid
    trail = data["deliveryHistory"]
    assert [e["action"] for e in trail] == ["ASSIGNED", "CANCELLED_BY_DRIVER"]  # stored entry kept, one appended
    assert trail[-1]["userId"] == uid and trail[-1]["reason"] == "Customer changed their mind" and trail[-1]["ts"]
    assert set(trail[-1]) == {"ts", "userId", "action", "reason"}         # the client's entry shape
    # Money is untouched by a cancel.
    assert data["status"] == "Not Paid" and data["isPaid"] is False


def test_the_server_writes_the_cancel_evidence_not_the_client(actors):
    receipt = _receipt(actors, "Needs Delivery")
    uid = actors["assigner"]["id"]
    forged = _cancel_payload(receipt, "someone-else", reason="  Forged   ")
    forged["deliveryHistory"] = [{"ts": "1999-01-01T00:00:00Z", "userId": "someone-else", "action": "DELIVERED"}]  # drops the stored entry
    forged["deliveryCancelledAt"] = "1999-01-01T00:00:00Z"
    saved = _patch(actors, "assigner", receipt["id"], forged)
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["deliveryCancelledBy"] == uid
    assert data["deliveryCancelledAt"].startswith(str(datetime.now(timezone.utc).year))
    assert [e["action"] for e in data["deliveryHistory"]] == ["ASSIGNED", "CANCELLED_BY_DRIVER"]
    assert data["deliveryHistory"][-1]["userId"] == uid
    assert data["deliveryHistory"][-1]["reason"] == "Forged"


def test_assign_holder_cancels_a_paid_delivery_receipt_too(actors):
    # The browser now routes this through the generic PATCH (not /settle,
    # which demands receipts.edit); the server must take it.
    receipt = _receipt(actors, "In Progress", status="Paid", isPaid=True, statusDetail={})
    saved = _patch(actors, "assigner", receipt["id"], _cancel_payload(receipt, actors["assigner"]["id"]))
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["deliveryStatus"] == "Canceled" and data["status"] == "Paid" and data["isPaid"] is True


# ---- Delete mission --------------------------------------------------------

def test_assign_holder_deletes_a_needs_delivery_mission_with_the_client_payload(actors):
    receipt = _receipt(actors, "Needs Delivery")
    assert receipt["deliveryPersonId"] == actors["driver"]["id"]
    uid = actors["assigner"]["id"]
    saved = _patch(actors, "assigner", receipt["id"], _delete_mission_payload(receipt, uid))
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["deliveryStatus"] == "Office"
    assert data["deliveryPersonId"] == ""
    assert data["statusDetail"]["notPaidCollection"] == "office"
    assert data["acceptedDate"] == "" and data["isReceivedInOffice"] is False and data["officeHandover"] is False
    assert [e["action"] for e in data["deliveryHistory"]] == ["ASSIGNED", "MISSION_REMOVED"]
    assert data["deliveryHistory"][-1]["userId"] == uid
    assert data["status"] == "Not Paid" and data["isPaid"] is False
    assert data["tempReceiptNo"] == receipt["tempReceiptNo"]           # the receipt itself stays


def test_delete_mission_only_flips_the_collection_channel_in_status_detail(actors):
    receipt = _receipt(actors, "Needs Delivery", statusDetail={"notPaidCollection": "delivery", "note": "keep me"})
    uid = actors["assigner"]["id"]
    payload = _delete_mission_payload(receipt, uid)
    payload["statusDetail"] = {"notPaidCollection": "office", "note": "rewritten", "extra": True}  # a tampered client
    payload["isReceivedInOffice"] = True                                                              # ignored: server clears
    payload["deliveryPersonId"] = actors["admin"]["id"]                                              # ignored: server clears
    saved = _patch(actors, "assigner", receipt["id"], payload)
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["statusDetail"] == {"notPaidCollection": "office", "note": "keep me"}
    assert data["isReceivedInOffice"] is False and data["receivedInOfficeAt"] == ""
    assert data["deliveryPersonId"] == ""


# ---- what the grant still cannot do ----------------------------------------

def test_assign_holder_cannot_set_money_fields_through_the_delivery_path(actors):
    receipt = _receipt(actors, "Needs Delivery")
    uid = actors["assigner"]["id"]
    with_money = {**_delete_mission_payload(receipt, uid), "isPaid": True, "status": "Paid"}
    refused = _patch(actors, "assigner", receipt["id"], with_money)
    assert refused.status_code in (400, 403), refused.text
    refused = _patch(actors, "assigner", receipt["id"], {**_cancel_payload(receipt, uid), "amountUSD": 0})
    assert refused.status_code in (400, 403), refused.text
    refused = _patch(actors, "assigner", receipt["id"], {"isPaid": True})
    assert refused.status_code in (400, 403), refused.text
    unchanged = client.get(f"{RECEIPTS}/{receipt['id']}", cookies=actors["admin"]["cookies"]).json()["data"]
    assert unchanged["isPaid"] is False and unchanged["status"] == "Not Paid" and unchanged["deliveryStatus"] == "Needs Delivery"


def test_the_delivery_history_key_travels_only_with_cancel_or_delete_mission(actors):
    receipt = _receipt(actors, "Office", deliveryPersonId="", statusDetail={"notPaidCollection": "office"})
    uid = actors["assigner"]["id"]
    refused = _patch(actors, "assigner", receipt["id"], {
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["driver"]["id"],
        "deliveryHistory": [{"ts": _now_iso(), "userId": uid, "action": "ASSIGNED"}],
    })
    assert refused.status_code in (400, 403), refused.text
    allowed = _patch(actors, "assigner", receipt["id"], {"deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["driver"]["id"]})
    assert allowed.status_code == 200, allowed.text


def test_reopen_and_backwards_moves_stay_refused_for_the_assign_grant(actors):
    uid = actors["assigner"]["id"]
    in_progress = _receipt(actors, "In Progress")
    assert _patch(actors, "assigner", in_progress["id"], {"deliveryStatus": "Needs Delivery"}).status_code in (400, 403)
    canceled = _receipt(actors, "Needs Delivery")
    assert _patch(actors, "assigner", canceled["id"], _cancel_payload(canceled, uid)).status_code == 200
    canceled = client.get(f"{RECEIPTS}/{canceled['id']}", cookies=actors["admin"]["cookies"]).json()["data"]
    for reopen in ({"deliveryStatus": "In Progress"}, {"deliveryStatus": "Needs Delivery"}, _delete_mission_payload(canceled, uid)):
        assert _patch(actors, "assigner", canceled["id"], reopen).status_code in (400, 403)
    delivered = _receipt(actors, "Delivered", status="Paid", isPaid=True, statusDetail={})
    for reopen in ({"deliveryStatus": "In Progress"}, _delete_mission_payload(delivered, uid), _cancel_payload(delivered, uid)):
        assert _patch(actors, "assigner", delivered["id"], reopen).status_code in (400, 403)


def test_round3_reopen_guard_still_holds_for_receipt_editors(actors):
    delivered = _receipt(actors, "Delivered", status="Paid", isPaid=True, statusDetail={})
    reopen = _patch(actors, "editor", delivered["id"], {"deliveryStatus": "In Progress"})
    assert reopen.status_code == 400 and "reopened" in reopen.text
    in_progress = _receipt(actors, "In Progress")
    backwards = _patch(actors, "editor", in_progress["id"], {"deliveryStatus": "Needs Delivery"})
    assert backwards.status_code == 400 and "reopened" in backwards.text
    # The editor's own "Delete mission" keeps working (generic path, client-written history).
    office = _patch(actors, "editor", in_progress["id"], _delete_mission_payload(in_progress, actors["editor"]["id"]))
    assert office.status_code == 200, office.text


# ---- ads -------------------------------------------------------------------

def test_assign_holder_cancels_an_ad_delivery_with_the_client_payload(actors):
    # Funded ads are born through /api/ads/mutate; the delivery rules do not
    # care how the row got there, so seed it directly.
    ad = {
        "id": f"ad_drift_{TAG}", "customerId": actors["customer_id"], "amountUSD": 30, "isPaid": True,
        "paymentStatus": "paid", "status": "Active", "deliveryStatus": "Needs Delivery",
        "deliveryPersonId": actors["driver"]["id"],
        "deliveryHistory": [{"ts": _now_iso(), "userId": actors["admin"]["id"], "action": "ASSIGNED"}],
    }
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:id,:d,false,:t,:o,:t)"),
                     {"id": ad["id"], "d": json_dumps(ad), "t": now_ms(), "o": actors["admin"]["id"]})
    uid = actors["assigner"]["id"]
    # src/12-views.js submitDeliveryCancel, ad branch: the same five keys.
    saved = client.patch(f"/api/collections/ads/{ad['id']}", json={"data": _cancel_payload(ad, uid)}, cookies=actors["assigner"]["cookies"])
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["deliveryStatus"] == "Canceled" and data["deliveryCancelledBy"] == uid
    assert [e["action"] for e in data["deliveryHistory"]] == ["ASSIGNED", "CANCELLED_BY_DRIVER"]
    assert data["isPaid"] is True and data["status"] == "Active"
