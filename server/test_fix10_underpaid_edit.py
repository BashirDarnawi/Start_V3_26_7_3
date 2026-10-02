"""F-underpaid: an ordinary edit of a delivered, still Not Paid receipt keeps the money the driver collected.

Job 500 LYD = $50 at rate 10; the driver completes with 300 LYD. The receipt form of every app build
re-sends the PLAN (500 / 50, payments []) on any edit; before this fix that replaced the collected
300 / 30 and the customer's $20 debt vanished. Real routes only (no helper is called directly, except
in the last unit test)."""
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.71", 50000))
PW = "UnderpaidEditCheck123!"
TAG = secrets.token_hex(4)
RECEIPTS = "/api/collections/receipts"
PROOF = "data:image/jpeg;base64,YQ=="
ROW500 = {"method": "Cash (LYD)", "amount": 500, "rate": 1, "rate2": 10, "collectionType": "delivery"}
# What the receipt form of an app build made before this fix sends for a phone-only edit.
OLDFORM = {
    "status": "Not Paid", "isPaid": False, "amountUSD": 50, "amountLocal": 500, "exchangeRate": 10,
    "paymentMethod": "Cash (LYD)", "payments": [], "phoneNumber": "0923456789",
    "debtAmountLocal": 500, "debtAmountUSD": 50, "deliveryStatus": "Delivered",
}


def _login(email):
    r = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _user(name, role, permissions):
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    email = f"f10ue-{name}-{TAG}@tests.albayanhub.com"
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
        "editor": _user("editor", "Employee", {"receipts": ["view", "edit"], "customers": ["view", "viewContacts"]}),
    }
    c = client.post("/api/collections/customers", json={"data": {
        "name": f"F10 UE {TAG}", "phone": "092" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=out["admin"]["cookies"])
    assert c.status_code == 200, c.text
    out["customer_id"] = c.json()["id"]
    return out


def _patch(actors, who, rid, data, expected=None):
    body = {"data": data}
    if expected is not None:
        body["expectedLastModified"] = expected
    return client.patch(f"{RECEIPTS}/{rid}", json=body, cookies=actors[who]["cookies"])


def _get(actors, rid):
    r = client.get(f"{RECEIPTS}/{rid}", cookies=actors["admin"]["cookies"])
    assert r.status_code == 200, r.text
    return r.json()


def _data(actors, rid):
    return _get(actors, rid)["data"]


def _make(actors, complete=300):
    """A 500 LYD / $50 delivery-collection receipt; `complete` LYD collected by the driver (None: not delivered)."""
    created = client.post(RECEIPTS, json={"data": {
        "recordType": "receipt", "customerId": actors["customer_id"], "status": "Not Paid", "isPaid": False,
        "amountUSD": 50, "amountLocal": 500, "exchangeRate": 10, "debtAmountLocal": 500, "debtAmountUSD": 50,
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": actors["driver"]["id"], "isReceivedInOffice": False,
        "deliveryPlaceName": "Hay Andalus", "quotedDeliveryFee": 10, "phoneNumber": "0912345678",
        "statusDetail": {"notPaidCollection": "delivery", "paidCollection": "office"},
        "plannedPayments": [dict(ROW500, deliveryPersonId=actors["driver"]["id"])], "payments": [],
    }}, cookies=actors["admin"]["cookies"])
    assert created.status_code == 200, created.text
    rid = created.json()["id"]
    if complete is None:
        return rid, created.json()
    assert _patch(actors, "driver", rid, {"deliveryStatus": "In Progress"}).status_code == 200
    done = _patch(actors, "driver", rid, {
        "deliveryStatus": "Delivered", "finalReceiptNo": str(secrets.randbelow(9 * 10**8) + 10**8), "receiptImage": PROOF,
        "amountCollectedFromCustomer": complete, "actualDeliveryFeeCollected": 10,
        "payments": [dict(ROW500, amount=complete)],
    })
    assert done.status_code == 200, done.text
    return rid, done.json()


def _settle(actors, rid, data):
    cur = _get(actors, rid)
    return client.post(f"/api/receipts/{rid}/settle", json={
        "data": data, "expectedLastModified": cur["lastModified"], "idempotencyKey": "k-" + secrets.token_hex(8),
    }, cookies=actors["admin"]["cookies"])


def _unsettle(actors, rid, data):
    cur = _get(actors, rid)
    return client.post(f"/api/receipts/{rid}/unsettle", json={
        "data": data, "expectedLastModified": cur["lastModified"], "idempotencyKey": "k-" + secrets.token_hex(8),
    }, cookies=actors["admin"]["cookies"])


def _assert_underpaid_300(d, before):
    """The stored collected money of the 300-of-500 completion, exactly as the driver left it."""
    assert (d["status"], d["deliveryStatus"]) == ("Not Paid", "Delivered")
    assert (d["amountLocal"], d["amountUSD"], d["exchangeRate"]) == (300, 30, 10)
    assert d["payments"] == before["payments"]
    assert len(d["payments"]) == 1 and d["payments"][0]["method"] == "Cash (LYD)" and d["payments"][0]["amount"] == 300
    assert d.get("paymentMethod") == before.get("paymentMethod")
    assert (d["amountCollectedFromCustomer"], d["remainingDue"], d["customerOutstandingUSD"]) == (300, 200, 20)


def test_01_admin_old_form_phone_edit_keeps_collected_money(actors):
    rid, done = _make(actors)
    before = done["data"]
    _assert_underpaid_300(before, before)
    r = _patch(actors, "admin", rid, dict(OLDFORM, plannedPayments=[dict(ROW500, deliveryPersonId=actors["driver"]["id"])]),
               expected=done["lastModified"])
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    _assert_underpaid_300(d, before)
    assert d["phoneNumber"] == "0923456789"
    # conservation: debt = collected + company covered + still owed
    assert d["debtAmountUSD"] == d["amountUSD"] + float(d.get("companyCoveredUSD") or 0) + d["customerOutstandingUSD"] == 50


def test_02_employee_with_receipts_edit_keeps_collected_money(actors):
    rid, done = _make(actors)
    r = _patch(actors, "editor", rid, dict(OLDFORM, phoneNumber="0911111111"), expected=done["lastModified"])
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    _assert_underpaid_300(d, done["data"])
    assert d["phoneNumber"] == "0911111111"


def test_03_split_editor_shaped_patch_keeps_collected_money(actors):
    rid, done = _make(actors)
    r = _patch(actors, "admin", rid, {"payments": [dict(ROW500, amount=350)], "paymentMethod": "Cash (LYD)",
                                      "amountLocal": 350, "amountUSD": 35, "exchangeRate": 10})
    assert r.status_code == 200, r.text
    _assert_underpaid_300(_data(actors, rid), done["data"])


def test_04_completion_record_cannot_be_rewritten_by_an_ordinary_edit(actors):
    rid, done = _make(actors)
    before = done["data"]
    assert before["paymentResult"] == "UNDERPAID"
    r = _patch(actors, "admin", rid, {"amountCollectedFromCustomer": 450, "remainingDue": 50, "paymentResult": "PAID_EXACT",
                                      "overpaidAmount": 7, "amountLocal": 450, "amountUSD": 45})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    _assert_underpaid_300(d, before)
    assert d["paymentResult"] == "UNDERPAID"
    assert (d.get("overpaidAmount") or 0) == 0 and d.get("overpaidAmount") == before.get("overpaidAmount")


def test_05_nulls_do_not_erase_collected_money(actors):
    rid, done = _make(actors)
    r = _patch(actors, "admin", rid, {"status": "Not Paid", "payments": None, "amountUSD": None, "exchangeRate": None})
    assert r.status_code == 200, r.text
    _assert_underpaid_300(_data(actors, rid), done["data"])


def _plan_edit_600(actors, rid):
    return _patch(actors, "admin", rid, {
        "status": "Not Paid", "amountUSD": 60, "amountLocal": 600, "payments": [], "debtAmountLocal": 600, "debtAmountUSD": 60,
        "plannedPayments": [dict(ROW500, amount=600)]})


def test_06_plan_edit_moves_the_debt_not_the_collected_money(actors):
    rid, done = _make(actors)
    r = _plan_edit_600(actors, rid)
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["amountLocal"], d["amountUSD"]) == (300, 30)
    assert d["payments"] == done["data"]["payments"]
    assert (d["debtAmountLocal"], d["debtAmountUSD"], d["customerOutstandingUSD"]) == (600, 60, 30)
    assert d["plannedPayments"][0]["amount"] == 600


def test_07_settle_after_the_plan_edit_marks_it_paid_in_full(actors):
    rid, _done = _make(actors)
    assert _plan_edit_600(actors, rid).status_code == 200
    d = _data(actors, rid)
    assert (d["amountLocal"], d["amountUSD"]) == (300, 30)  # still the collected cash until the office settles
    s = _settle(actors, rid, {"status": "Paid", "isPaid": True, "amountUSD": 60, "amountLocal": 600, "exchangeRate": 10,
                              "paymentMethod": "Cash (LYD)", "payments": [dict(ROW500, amount=600)], "plannedPayments": []})
    assert s.status_code == 200, s.text
    d = _data(actors, rid)
    assert (d["status"], d["isPaid"], d["amountLocal"], d["amountUSD"]) == ("Paid", True, 600, 60)


def test_08_zero_collected_stays_zero(actors):
    rid, done = _make(actors, complete=0)
    assert (done["data"]["amountLocal"], done["data"]["amountUSD"], done["data"]["status"]) == (0, 0, "Not Paid")
    r = _patch(actors, "admin", rid, dict(OLDFORM))
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["amountLocal"], d["amountUSD"], d["customerOutstandingUSD"]) == (0, 0, 50)
    assert d["payments"] == done["data"]["payments"]
    assert d["phoneNumber"] == "0923456789"


def test_09_not_delivered_receipt_still_follows_the_form(actors):
    rid, _created = _make(actors, complete=None)
    r = _patch(actors, "admin", rid, {"status": "Not Paid", "amountUSD": 60, "amountLocal": 600, "debtAmountLocal": 600,
                                      "debtAmountUSD": 60, "payments": [], "plannedPayments": [dict(ROW500, amount=600)]})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["deliveryStatus"], d["amountLocal"], d["amountUSD"]) == ("Needs Delivery", 600, 60)


def test_10_status_changing_patches_keep_their_own_rules(actors):
    # Paid through the generic PATCH: the sent rows are stored (as before this fix).
    rid, _ = _make(actors)
    r = _patch(actors, "admin", rid, {"status": "Paid", "isPaid": True, "amountUSD": 50, "amountLocal": 500, "exchangeRate": 10,
                                      "payments": [ROW500], "paymentMethod": "Cash (LYD)"})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["status"], d["isPaid"], d["amountLocal"], d["amountUSD"]) == ("Paid", True, 500, 50)
    assert len(d["payments"]) == 1 and d["payments"][0]["amount"] == 500
    # Canceled
    rid, _ = _make(actors)
    r = _patch(actors, "admin", rid, {"status": "Canceled", "isPaid": False, "amountUSD": 50, "amountLocal": 500, "payments": [],
                                      "statusDetail": {"notPaidCollection": "delivery", "refundAction": "none"}})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["status"], d["amountLocal"], d["amountUSD"], d["payments"]) == ("Canceled", 500, 50, [])
    # Lost (write-off)
    rid, _ = _make(actors)
    r = _patch(actors, "admin", rid, {"status": "Lost", "amountUSD": 50, "amountLocal": 500, "payments": []})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["status"], d["amountLocal"], d["amountUSD"], d["payments"]) == ("Lost", 500, 50, [])
    # only isPaid: true (the pair is normalised to Paid before the guard looks at it)
    rid, _ = _make(actors)
    r = _patch(actors, "admin", rid, {"isPaid": True, "amountUSD": 50, "amountLocal": 500, "payments": [ROW500]})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["status"], d["isPaid"], d["amountLocal"], d["amountUSD"]) == ("Paid", True, 500, 50)
    assert len(d["payments"]) == 1 and d["payments"][0]["amount"] == 500


def test_11_company_coverage_survives_the_old_form_edit(actors):
    rid, _done = _make(actors)
    cur = _get(actors, rid)
    c = client.post(f"/api/receipts/{rid}/company-coverages", json={
        "amountMinorUSD": 1000, "idempotencyKey": "cov-" + secrets.token_hex(8),
        "expectedLastModified": cur["lastModified"], "reason": "fix10 underpaid test"}, cookies=actors["admin"]["cookies"])
    assert c.status_code == 200, c.text
    d = _data(actors, rid)
    assert (d["amountUSD"], d["companyCoveredUSD"], d["customerOutstandingUSD"]) == (30, 10, 10)
    r = _patch(actors, "admin", rid, dict(OLDFORM, plannedPayments=[ROW500]))
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["amountLocal"], d["amountUSD"], d["companyCoveredUSD"], d["customerOutstandingUSD"]) == (300, 30, 10, 10)
    assert d["debtAmountUSD"] == d["amountUSD"] + d["companyCoveredUSD"] + d["customerOutstandingUSD"] == 50
    assert d["phoneNumber"] == "0923456789"
    low = _patch(actors, "admin", rid, dict(OLDFORM, debtAmountLocal=50, debtAmountUSD=5, amountLocal=50, amountUSD=5,
                                            plannedPayments=[dict(ROW500, amount=50)]))
    assert low.status_code == 409, low.text
    assert "The company already covered $10.00 of this receipt; its amount cannot go below that" in low.text
    d = _data(actors, rid)
    assert (d["amountUSD"], d["companyCoveredUSD"], d["customerOutstandingUSD"], d["debtAmountUSD"]) == (30, 10, 10, 50)


def test_12_same_old_form_patch_twice_gives_the_same_money(actors):
    rid, done = _make(actors)
    r1 = _patch(actors, "admin", rid, dict(OLDFORM))
    r2 = _patch(actors, "admin", rid, dict(OLDFORM))
    assert (r1.status_code, r2.status_code) == (200, 200), (r1.text, r2.text)
    _assert_underpaid_300(_data(actors, rid), done["data"])


def test_13_converted_receipt_keeps_its_stored_amount_and_moves_only_the_debt(actors):
    rid, _done = _make(actors)
    s = _settle(actors, rid, {"status": "Paid", "isPaid": True, "amountUSD": 50, "amountLocal": 500, "exchangeRate": 10,
                              "payments": [ROW500], "plannedPayments": []})
    assert s.status_code == 200, s.text
    u = _unsettle(actors, rid, {"status": "Not Paid", "isPaid": False, "amountUSD": 50, "amountLocal": 500, "exchangeRate": 10,
                                "payments": [], "plannedPayments": [ROW500], "deliveryStatus": "Delivered"})
    assert u.status_code == 200, u.text
    d = _data(actors, rid)
    assert (d["status"], d["amountLocal"], d["amountUSD"], d["payments"]) == ("Not Paid", 500, 50, [])
    r = _patch(actors, "admin", rid, {"status": "Not Paid", "isPaid": False, "amountUSD": 60, "amountLocal": 600,
                                      "debtAmountLocal": 600, "debtAmountUSD": 60, "exchangeRate": 10, "payments": [],
                                      "plannedPayments": [dict(ROW500, amount=600)]})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert (d["amountLocal"], d["amountUSD"]) == (500, 50)
    assert (d["debtAmountLocal"], d["debtAmountUSD"]) == (600, 60)


def test_14_requeue_to_needs_delivery_keeps_collected_money(actors):
    rid, done = _make(actors)
    r = _patch(actors, "admin", rid, {"deliveryStatus": "Needs Delivery", "amountUSD": 50, "amountLocal": 500, "payments": []})
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    assert d["deliveryStatus"] == "Needs Delivery"
    assert (d["amountLocal"], d["amountUSD"]) == (300, 30)
    assert d["payments"] == done["data"]["payments"]


def test_15_unit_guard_only_ever_removes_the_nine_names():
    from server.settlement_truth import _DELIVERED_UNPAID_KEPT_FIELDS, keep_delivered_collected_money

    nine = {"amountLocal", "amountUSD", "exchangeRate", "payments", "paymentMethod",
            "amountCollectedFromCustomer", "paymentResult", "overpaidAmount", "remainingDue"}
    assert set(_DELIVERED_UNPAID_KEPT_FIELDS) == nine and len(_DELIVERED_UNPAID_KEPT_FIELDS) == 9

    def full():
        return {**{k: 1 for k in nine}, "payments": [], "phoneNumber": "09", "plannedPayments": [1], "debtAmountUSD": 5}

    other = {"phoneNumber": "09", "plannedPayments": [1], "debtAmountUSD": 5}
    delivered = {"status": "Not Paid", "isPaid": False, "deliveryStatus": "Delivered"}
    # (stored row, extra keys of the update, guard acts?)
    cases = [
        (delivered, {}, True),
        (delivered, {"status": "Not Paid", "isPaid": False}, True),
        (delivered, {"status": "", "isPaid": None}, True),  # a blank status in the update reads as Not Paid
        ({"status": "Not Paid", "deliveredAt": "2026-09-02T10:00:00Z"}, {}, True),  # deliveredAt only
        ({"status": "Not Paid", "deliveryStatus": " Delivered "}, {}, True),
        ({"status": "Not Paid", "deliveryStatus": "Office", "deliveredAt": 1759400000000}, {}, True),
        (delivered, {"status": "Paid"}, False),
        (delivered, {"isPaid": True}, False),
        (delivered, {"status": "Canceled"}, False),
        (delivered, {"status": "Lost"}, False),
        ({"status": "Not Paid", "isPaid": True, "deliveryStatus": "Delivered"}, {}, False),  # isPaid True with Not Paid
        ({"status": "", "deliveryStatus": "Delivered"}, {}, False),  # blank stored status
        ({"deliveryStatus": "Delivered"}, {}, False),  # missing status
        ({"status": "Paid", "isPaid": True, "deliveryStatus": "Delivered"}, {}, False),
        ({"status": "Not Paid", "deliveryStatus": "Needs Delivery"}, {}, False),
        ({"status": "Not Paid"}, {}, False),
        ({"status": "Not Paid", "deliveryStatus": None, "deliveredAt": None}, {}, False),
        ({}, {}, False),
    ]
    for old, extra, acts in cases:
        old_copy = dict(old)
        clean = {**full(), **extra}
        sent = dict(clean)
        assert keep_delivered_collected_money(old, clean) is None
        assert old == old_copy, (old, extra)  # the stored row is never touched
        assert set(clean) <= set(sent), (old, extra)  # never adds a key
        assert all(clean[k] == sent[k] for k in clean), (old, extra)  # never rewrites a value
        removed = set(sent) - set(clean)
        assert removed == (nine if acts else set()), (old, extra, removed)
        assert {k: clean[k] for k in other} == other
    # missing fields: nothing to drop, nothing raised, nothing added
    clean = {"phoneNumber": "09"}
    keep_delivered_collected_money(delivered, clean)
    assert clean == {"phoneNumber": "09"}
    clean = {}
    keep_delivered_collected_money(delivered, clean)
    assert clean == {}


def test_16_receipt_without_a_stored_plan_keeps_its_debt_on_a_phone_edit(actors):
    """Older delivered receipts have no plannedPayments: the form seeds its rows from the collected row and,
    for an untouched row, now sends neither the debt nor a plan (it sent debt 300 / 30: the $20 vanished)."""
    import json

    rid, done = _make(actors)
    legacy = {k: v for k, v in done["data"].items() if k != "plannedPayments"}
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type='receipts' AND id=:id"), {"d": json.dumps(legacy), "id": rid})
    before = _data(actors, rid)
    assert "plannedPayments" not in before and (before["debtAmountLocal"], before["debtAmountUSD"]) == (500, 50)
    # What the repaired form sends: the stored collected money echoed, the phone, no debt field and no plan.
    r = _patch(actors, "admin", rid, {
        "status": "Not Paid", "isPaid": False, "amountUSD": 30, "amountLocal": 300, "exchangeRate": 10,
        "payments": before["payments"], "phoneNumber": "0923456789", "deliveryStatus": "Delivered",
    })
    assert r.status_code == 200, r.text
    d = _data(actors, rid)
    _assert_underpaid_300(d, before)
    assert (d["debtAmountLocal"], d["debtAmountUSD"], d["customerOutstandingUSD"]) == (500, 50, 20)
    assert "plannedPayments" not in d and d["phoneNumber"] == "0923456789"
