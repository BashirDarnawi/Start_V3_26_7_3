"""Independent second-pass response authorization checks with disposable rows."""

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, now_ms
from server.security import hash_password, new_id


PHOTO = "data:image/png;base64,cHJpdmF0ZS1zZWNvbmQtcGFzcy1waG90bw=="
PASSWORD = "SecondMediaAudit123!"


def _request(method, path, cookie=None, body=None):
    headers = {"Origin": "http://testserver"}
    if cookie:
        headers["Cookie"] = f"albayan_session={cookie}"
    return TestClient(main.app, headers=headers).request(method, path, json=body)


def _permissions(uid, permissions):
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET permissions_json=:p WHERE id=:id"),
                     {"id": uid, "p": json.dumps(permissions)})


@pytest.fixture
def context(monkeypatch):
    init_db()
    monkeypatch.setattr(main, "_rate_check", lambda *args, **kwargs: (True, 0))
    uid = new_id("secondMedia")
    password = hash_password(PASSWORD)
    with db_conn() as conn:
        conn.execute(text(
            "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,last_modified) "
            "VALUES (:id,'Second media audit',:email,'Employee','{}',:h,:s,:a,:i,false,:n,:n)"
        ), {"id": uid, "email": f"{uid}@tests.albayanhub.com", "h": password.hash_hex,
            "s": password.salt_hex, "a": password.algo, "i": password.iterations, "n": now_ms()})
    permissions = {"ads": ["view", "add", "edit", "stopAd", "viewPhotos", "uploadPhotos"],
                   "receipts": ["view", "edit"]}
    _permissions(uid, permissions)
    login = _request("POST", "/api/auth/login", body={
        "email": f"{uid}@tests.albayanhub.com", "password": PASSWORD,
    })
    assert login.status_code == 200, login.text
    customer_id, receipt_id, ad_id = (new_id(prefix) for prefix in ("secondCustomer", "secondReceipt", "secondAd"))
    main.upsert_entity("customers", customer_id, {
        "name": "Second audit", "phone": "09" + str(secrets.randbelow(100_000_000)).zfill(8),
    }, uid, create_if_missing=True)
    main.upsert_entity("receipts", receipt_id, {
        "customerId": customer_id, "status": "Not Paid", "amountUSD": 0, "amountLocal": 0,
        "debtAmountUSD": 10, "debtAmountLocal": 100, "exchangeRate": 10,
        "tempReceiptNo": "D" + str(secrets.randbelow(10**14)),
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": "second-driver",
        "photos": [PHOTO],
    }, uid, create_if_missing=True)
    funding = {"customerId": customer_id, "paymentStatus": "not_paid", "collectionMethod": "driver",
               "driverBudgetUSD": 10, "exchangeRate": 10, "linkedDeliveryReceiptId": receipt_id,
               "receiptId": receipt_id, "adPhotos": [PHOTO]}
    ctx = {"uid": uid, "cookie": login.cookies.get("albayan_session"), "permissions": permissions,
           "customer_id": customer_id, "receipt_id": receipt_id, "ad_id": ad_id, "funding": funding}
    yield ctx
    # Avoid polluting whole-collection backup and record-number tests later.
    with db_conn() as conn:
        for collection, eid in (("ads", ad_id), ("receipts", receipt_id), ("customers", customer_id)):
            conn.execute(text("DELETE FROM entities WHERE type=:t AND id=:id"), {"t": collection, "id": eid})


def _create(context):
    body = {"action": "create", "adId": context["ad_id"], "idempotencyKey": new_id("secondMutation"),
            "data": context["funding"]}
    response = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert response.status_code == 200, response.text
    return body, response.json()["ad"]


def test_replayed_create_rechecks_revoked_ad_permission(context):
    body, ad = _create(context)
    _permissions(context["uid"], {"ads": ["viewPhotos"], "receipts": ["view"]})
    assert _request("GET", f"/api/collections/ads/{ad['id']}", context["cookie"]).status_code == 403
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 403, replay.text


def test_replayed_update_rechecks_revoked_ad_permission(context):
    _, ad = _create(context)
    body = {"action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondUpdate"),
            "expectedLastModified": ad["lastModified"], "data": {"notes": "Safe text edit"}}
    first = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert first.status_code == 200, first.text
    _permissions(context["uid"], {"ads": ["viewPhotos"], "receipts": ["view"]})
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 403, replay.text


def test_authorized_replay_uses_current_photo_permission(context):
    body, _ = _create(context)
    _permissions(context["uid"], {"ads": ["view", "add", "edit"], "receipts": ["view"]})
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    assert "adPhotos" not in replay.json()["ad"]["data"]
    assert main.get_entity("ads", context["ad_id"])["data"]["adPhotos"] == [PHOTO]


@pytest.mark.parametrize("action", ["create", "update"])
def test_read_only_staff_can_confirm_but_cannot_repeat_mutation(context, action):
    body, ad = _create(context)
    if action == "update":
        body = {"action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondUpdate"),
                "expectedLastModified": ad["lastModified"], "data": {"notes": "Read-only confirmation"}}
        first = _request("POST", "/api/ads/mutate", context["cookie"], body)
        assert first.status_code == 200, first.text
    before = main.get_entity("ads", ad["id"])
    _permissions(context["uid"], {"ads": ["viewOwn", "viewPhotos"]})
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    assert replay.json()["ad"]["data"]["adPhotos"] == [PHOTO]
    attempt = {"action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondDenied"),
               "expectedLastModified": before["lastModified"], "data": {"notes": "Must not save"}}
    assert _request("POST", "/api/ads/mutate", context["cookie"], attempt).status_code == 403
    assert main.get_entity("ads", ad["id"]) == before


@pytest.mark.parametrize("action,grant", [("create", "add"), ("update", "editOwn")])
def test_action_only_confirmation_requires_current_ownership(context, action, grant):
    body, ad = _create(context)
    if action == "update":
        body = {"action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondUpdate"),
                "expectedLastModified": ad["lastModified"], "data": {"notes": "Owned edit"}}
        assert _request("POST", "/api/ads/mutate", context["cookie"], body).status_code == 200
    _permissions(context["uid"], {"ads": [grant, "viewPhotos"]})
    assert _request("POST", "/api/ads/mutate", context["cookie"], body).status_code == 200
    # Simulate an authorized legacy import/reassignment using the authoritative
    # column. The older nested creator stamp deliberately remains unchanged.
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET created_by='other-owner' WHERE type='ads' AND id=:id"),
                     {"id": ad["id"]})
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 403, replay.text


@pytest.mark.parametrize("action", ["create", "update"])
def test_replay_cannot_hydrate_deleted_ads(context, action):
    body, ad = _create(context)
    if action == "update":
        body = {"action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondUpdate"),
                "expectedLastModified": ad["lastModified"], "data": {"notes": "Before deletion"}}
        assert _request("POST", "/api/ads/mutate", context["cookie"], body).status_code == 200
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted=true WHERE type='ads' AND id=:id"), {"id": ad["id"]})
    replay = _request("POST", "/api/ads/mutate", context["cookie"], body)
    assert replay.status_code == 404, replay.text


@pytest.mark.parametrize("grants,owner_matches,visible", [([], True, False), (["view"], False, True),
                                                          (["viewOwn"], True, True), (["viewOwn"], False, False)])
def test_ad_stop_does_not_return_receipt_outside_read_scope(context, grants, owner_matches, visible):
    # Historical managed In-Shop debt: stopping the ad should reduce it, but
    # stopping permissions are not permission to open the linked receipt.
    main.upsert_entity("receipts", context["receipt_id"], {
        "customerId": context["customer_id"], "status": "Not Paid", "isPaid": False,
        "amountUSD": 10, "amountLocal": 100, "debtAmountUSD": 10, "debtAmountLocal": 100,
        "exchangeRate": 10, "statusDetail": {"notPaidCollection": "office"},
        "deliveryStatus": "Office", "tempReceiptNo": "", "photos": [PHOTO],
        "editHistory": [{"changes": [{"field": "Funding Ad", "from": "-", "to": context["ad_id"]},
                                     {"field": "Amount (USD)", "from": "$0.00", "to": "$10.00"}]}],
    }, context["uid"], create_if_missing=True)
    context["funding"] = {
        "customerId": context["customer_id"], "paymentStatus": "not_paid", "collectionMethod": "in_shop",
        "exchangeRate": 10, "receiptId": context["receipt_id"],
        "dueAllocations": [{"receiptId": context["receipt_id"], "amountUSD": 10}],
    }
    _, ad = _create(context)
    if not owner_matches:
        with db_conn() as conn:
            conn.execute(text("UPDATE entities SET created_by='other-owner' WHERE type='receipts' AND id=:id"),
                         {"id": context["receipt_id"]})
    _permissions(context["uid"], {"ads": ["view", "stopAd"], "receipts": grants})
    assert _request("GET", f"/api/collections/receipts/{context['receipt_id']}", context["cookie"]).status_code == (200 if visible else 403)
    body = {
        "spentMinorUSD": 500, "expectedLastModified": ad["lastModified"], "idempotencyKey": new_id("secondStop"),
    }
    for replayed in (False, True):
        response = _request("POST", f"/api/ads/{ad['id']}/stop", context["cookie"], body)
        assert response.status_code == 200, response.text
        assert response.json()["replayed"] is replayed
        assert main.get_entity("receipts", context["receipt_id"])["data"]["amountUSD"] == 5
        if visible:
            receipt = response.json()["updatedReceipts"][0]
            assert receipt["data"]["amountUSD"] == 5
            assert receipt["data"]["photos"] == [PHOTO]
        else:
            assert response.json()["updatedReceipts"] == [], response.text


@pytest.mark.parametrize("grants,visible", [(["edit"], False), (["edit", "view"], True), (["edit", "viewOwn"], True)])
def test_ad_debt_growth_projects_related_receipts_on_mutation_and_replay(context, grants, visible):
    receipt = main.upsert_entity("receipts", context["receipt_id"], {
        "customerId": context["customer_id"], "status": "Not Paid", "isPaid": False,
        "amountUSD": 0, "amountLocal": 0, "debtAmountUSD": 0, "debtAmountLocal": 0,
        "exchangeRate": 10, "statusDetail": {"notPaidCollection": "office"},
        "deliveryStatus": "Office", "tempReceiptNo": "", "photos": [PHOTO],
        "customerPhone": "private-receipt-phone", "receiptImage": PHOTO,
    }, context["uid"], create_if_missing=True)
    _permissions(context["uid"], {"ads": ["view", "add"], "receipts": grants})
    body = {"action": "create", "adId": context["ad_id"], "idempotencyKey": new_id("secondGrow"), "data": {
        "customerId": context["customer_id"], "paymentStatus": "not_paid", "collectionMethod": "in_shop",
        "exchangeRate": 10, "receiptId": context["receipt_id"],
        "dueAllocations": [{"receiptId": context["receipt_id"], "amountUSD": 10}],
        "unpaidReceiptDebtIncrease": {"receiptId": context["receipt_id"], "amountUSD": 10,
                                      "expectedLastModified": receipt["lastModified"]},
    }}
    for replayed in (False, True):
        response = _request("POST", "/api/ads/mutate", context["cookie"], body)
        assert response.status_code == 200, response.text
        assert response.json()["replayed"] is replayed
        assert main.get_entity("receipts", context["receipt_id"])["data"]["amountUSD"] == 10
        if visible:
            saved = response.json()["updatedReceipts"][0]["data"]
            assert saved["photos"] == [PHOTO] and saved["receiptImage"] == PHOTO
            assert "customerPhone" not in saved
        else:
            assert response.json()["updatedReceipts"] == []


@pytest.mark.parametrize("assigned,grants,visible", [(True, [], True), (False, ["view"], False), (False, [], False)])
def test_related_receipt_visibility_preserves_driver_assignment_scope(assigned, grants, visible):
    from server.entity_projection import can_read_related_receipt
    from server.rbac import user_has_permission

    user = {"id": "driver", "role": "Delivery", "permissions_json": json.dumps({"receipts": grants})}
    receipt = {"type": "receipts", "createdBy": "driver", "data": {
        "deliveryPersonId": "driver" if assigned else "other-driver",
    }}
    assert can_read_related_receipt(receipt, user, user_has_permission) is visible
    receipt["deleted"] = True
    assert can_read_related_receipt(receipt, user, user_has_permission) is False


@pytest.mark.parametrize("operation", ["create", "update", "stop", "replay-create", "replay-update", "replay-stop"])
@pytest.mark.parametrize("assigned", [False, True], ids=["other-driver", "assigned-driver"])
def test_delivery_financial_actions_cannot_bypass_assigned_ad_scope(context, operation, assigned):
    main.upsert_entity("receipts", context["receipt_id"], {
        "customerId": context["customer_id"], "status": "Paid", "isPaid": True,
        "amountUSD": 10, "amountLocal": 100, "exchangeRate": 10,
    }, context["uid"], create_if_missing=True)
    context["funding"] = {"customerId": context["customer_id"], "paymentStatus": "paid", "exchangeRate": 10,
                          "receiptAllocations": [{"receiptId": context["receipt_id"], "amountUSD": 10}],
                          "deliveryPersonId": context["uid"] if assigned else "other-driver",
                          "deliveryStatus": "Needs Delivery", "adPhotos": [PHOTO]}
    body = {"action": "create", "adId": context["ad_id"], "idempotencyKey": new_id("secondDriverCreate"),
            "data": context["funding"]}
    path = "/api/ads/mutate"
    before = None
    if operation != "create":
        created = _request("POST", path, context["cookie"], body)
        assert created.status_code == 200, created.text
        before = created.json()["ad"]
        if operation.endswith("update"):
            body = {"action": "update", "adId": before["id"], "idempotencyKey": new_id("secondDriverUpdate"),
                    "expectedLastModified": before["lastModified"], "data": {"notes": "Assigned action"}}
        elif operation.endswith("stop"):
            path = f"/api/ads/{before['id']}/stop"
            body = {"spentMinorUSD": 500, "expectedLastModified": before["lastModified"],
                    "idempotencyKey": new_id("secondDriverStop")}
        if operation.startswith("replay-") and operation != "replay-create":
            result = _request("POST", path, context["cookie"], body)
            assert result.status_code == 200, result.text
        before = main.get_entity("ads", context["ad_id"])
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET role='Delivery' WHERE id=:id"), {"id": context["uid"]})
    if before:
        direct = _request("GET", f"/api/collections/ads/{context['ad_id']}", context["cookie"])
        assert direct.status_code == (200 if assigned else 403)
    result = _request("POST", path, context["cookie"], body)
    assert result.status_code == (200 if assigned else 403), result.text
    if not assigned:
        assert main.get_entity("ads", context["ad_id"]) == before


@pytest.mark.parametrize("initially_assigned", [False, True], ids=["cannot-claim", "cannot-reassign"])
def test_driver_cannot_change_assignment_through_financial_update(context, initially_assigned):
    main.upsert_entity("receipts", context["receipt_id"], {
        "customerId": context["customer_id"], "status": "Paid", "isPaid": True,
        "amountUSD": 10, "amountLocal": 100, "exchangeRate": 10,
    }, context["uid"], create_if_missing=True)
    context["funding"] = {"customerId": context["customer_id"], "paymentStatus": "paid", "exchangeRate": 10,
                          "receiptAllocations": [{"receiptId": context["receipt_id"], "amountUSD": 10}],
                          "deliveryPersonId": context["uid"] if initially_assigned else "other-driver",
                          "deliveryStatus": "Needs Delivery"}
    _, ad = _create(context)
    before = main.get_entity("ads", ad["id"])
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET role='Delivery' WHERE id=:id"), {"id": context["uid"]})
    response = _request("POST", "/api/ads/mutate", context["cookie"], {
        "action": "update", "adId": ad["id"], "idempotencyKey": new_id("secondDriverMove"),
        "expectedLastModified": ad["lastModified"],
        "data": {"deliveryPersonId": "other-driver" if initially_assigned else context["uid"]},
    })
    assert response.status_code == 403, response.text
    assert main.get_entity("ads", ad["id"]) == before
