"""Round-3 deep-scan regressions (2026-09-18): reporting, Social Studio logic, Clothes, deliveries.

Disposable local records only; the suite shares one in-memory database, so
records carry a per-run tag.
"""

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
import server.systems.ads_studio.social_studio as studio
from server import operations
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.99", 50000))
PW = "RoundThreePassword123!"
TAG = secrets.token_hex(4)


@pytest.fixture(autouse=True, scope="module")
def _schema():
    init_db()


# ---------------------------------------------------------------- reporting

def _snapshot_with(monkeypatch, receipts=(), ads=(), purchases=()):
    rows = {"receipts": list(receipts), "ads": list(ads), "dollarPurchases": list(purchases)}
    monkeypatch.setattr(operations, "_entity_rows", lambda collection, conn=None: [dict(r) for r in rows.get(collection, [])])
    return operations._period_snapshot("2026-09")


def test_month_snapshot_uses_the_same_money_rules_as_the_analytics_screen(monkeypatch):
    receipts = [
        {"id": "r1", "date": "2026-09-02", "status": "Paid", "amountUSD": 100},
        {"id": "r2", "date": "2026-09-03", "isPaid": True, "amountUSD": 1000},
        {"id": "r3", "date": "2026-09-04", "status": "Canceled", "isPaid": True, "amountUSD": 400},
        {"id": "r4", "date": "2026-09-05", "status": "Canceled", "amountUSD": 250},
        {"id": "r5", "date": "2026-09-06", "status": "Destroyed", "amountUSD": 0},
        {"id": "r6", "date": "2026-09-07", "status": "Not Paid", "amountUSD": 60},
        {"id": "r7", "date": "2026-09-08", "status": "Paid", "receiptType": "TRANSFER_IN", "amountUSD": 500},
    ]
    ads = [
        {"id": "a1", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "paid", "customerId": "c", "amountUSD": 200},
        {"id": "a2", "startDate": "2026-09-02", "status": "Stopped", "paymentStatus": "paid", "customerId": "c", "amountUSD": 500, "spentUSD": 100, "metaAdId": "911", "metaSpendMinor": 12000, "metaCurrency": "USD"},
        {"id": "a3", "startDate": "2026-09-02", "status": "Canceled", "paymentStatus": "paid", "customerId": "c", "amountUSD": 300, "spentUSD": 100},
        {"id": "a4", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "wont_pay", "customerId": "c", "amountUSD": 200},
        {"id": "a5", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "pending_setup", "amountUSD": 0, "metaAdId": "955", "metaSpendMinor": 5000, "metaCurrency": "USD"},
        {"id": "a6", "startDate": "2026-09-02", "recordType": "receipt", "status": "Paid", "amountUSD": 150},
        {"id": "a7", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "paid", "customerId": "c", "amountUSD": 80},
        {"id": "a8", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "paid", "customerId": "c", "amountUSD": 10, "metaAdId": "988", "metaSpendMinor": 30000, "metaCurrency": "EUR"},
        {"id": "a9", "startDate": "2026-09-02", "status": "Active", "paymentStatus": "not_paid", "customerId": "c", "amountUSD": 70},
    ]
    snapshot = _snapshot_with(monkeypatch, receipts=receipts, ads=ads)
    totals, counts = snapshot["totals"], snapshot["counts"]
    assert totals["receiptVolumeUSD"] == 1160          # canceled, destroyed and transfer-in excluded
    assert totals["paidReceiptsUSD"] == 1100            # a canceled receipt is never "paid"
    assert counts["unpaidReceipts"] == 1
    assert totals["adSalesUSD"] == 490                  # 200 + 100 (stopped: spent) + 100 (canceled: spent) + 80 + 10
    assert totals["adSalesPendingUSD"] == 70
    assert totals["adSpendUSD"] == 250                  # 100 frozen + 100 frozen + 50 Meta; EUR and plain budgets excluded
    assert totals["metaSpendUSD"] == totals["adSpendUSD"]
    assert counts["ads"] == 8                           # the legacy receipt row is not an ad
    blockers = {b["code"]: b["count"] for b in snapshot["blockers"]}
    assert blockers == {"ads_need_setup": 1, "unpaid_receipts": 1}


def test_record_date_uses_the_business_day_in_libya(monkeypatch):
    monkeypatch.delenv("ALBAYAN_BUSINESS_TIMEZONE", raising=False)
    assert operations._period_for_record("receipts", {"createdAt": "2026-03-31T22:30:00Z"}) == "2026-04"
    assert operations._period_for_record("receipts", {"createdAt": "2026-03-31T21:59:59Z"}) == "2026-03"
    assert operations._period_for_record("receipts", {"date": "2026-03-31"}) == "2026-03"
    midnight_tripoli = int(datetime(2026, 3, 31, 22, 30, tzinfo=timezone.utc).timestamp() * 1000)
    assert operations._period_for_record("ads", {"_created": midnight_tripoli}) == "2026-04"


# ---------------------------------------------------------------- Social Studio rule engine

def _rules(*specs):
    out = []
    for index, spec in enumerate(specs):
        rule = {"id": f"rule_{index}", "enabled": True, "platform": "fb", "scope": "all", "trigger": "every", "_created": index}
        rule.update(spec)
        out.append(rule)
    return out


def _pick(rules, text_value, **kwargs):
    params = {"platform": "fb", "post_ref": "post_1", "text": text_value, "from_id": "9001",
              "already_replied_from_ids": set(), "now_local": datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)}
    params.update(kwargs)
    return studio.evaluate_rules(rules, {"masterEnabled": True}, **params)


def test_short_latin_keywords_need_word_boundaries_but_arabic_prefixes_still_match():
    rules = _rules({"trigger": "keywords", "keywords": ["hi"]})
    assert _pick(rules, "Do you ship to Benghazi?") is None
    assert _pick(rules, "hi there") is not None
    arabic = _rules({"trigger": "keywords", "keywords": ["سعر"]})
    assert _pick(arabic, "كم السعر؟") is not None


def test_once_per_person_is_per_rule_and_legacy_history_stays_page_wide():
    price = {"id": "rule_price", "trigger": "keywords", "keywords": ["price"], "oncePerPerson": True}
    thanks = {"id": "rule_thanks"}
    rules = _rules(price, thanks)
    # The thank-you rule answered before; the price rule may still answer once.
    picked = _pick(rules, "what is the price?", already_replied_rule_ids={"rule_thanks"})
    assert picked and picked["id"] == "rule_price"
    assert _pick(rules, "what is the price?", already_replied_rule_ids={"rule_price"})["id"] == "rule_thanks"
    # A history row without a rule id (written before ids were stored) blocks every once-per-person rule.
    assert _pick(rules, "what is the price?", already_replied_rule_ids={"*"})["id"] == "rule_thanks"


def test_person_history_counts_only_sent_replies_per_rule():
    owner = f"owner_{TAG}"
    page = f"spg_{TAG}"
    stamp = now_ms()
    rows = [
        (f"srl_{TAG}_1", {"ownerId": owner, "pageId": page, "fromId": "77", "ruleId": "rule_a", "actions": ["public"]}),
        (f"srl_{TAG}_2", {"ownerId": owner, "pageId": page, "fromId": "77", "ruleId": "rule_b", "actions": ["like"]}),
        (f"srl_{TAG}_3", {"ownerId": owner, "pageId": page, "fromId": "77", "actions": ["dm"]}),
        (f"srl_{TAG}_4", {"ownerId": owner, "pageId": page, "fromId": "78", "ruleId": "rule_c", "actions": ["public"]}),
        # A reply parked for retry counts as answered: the retry pass will send it.
        (f"srl_{TAG}_5", {"ownerId": owner, "pageId": page, "fromId": "77", "ruleId": "rule_d", "actions": [], "retryAfter": "2099-01-01T00:00:00Z"}),
    ]
    with db_conn() as conn:
        for row_id, data in rows:
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                         {"id": row_id, "data": json_dumps({"id": row_id, **data}), "t": stamp, "owner": owner})
    assert studio._person_replied_rule_ids(owner, page, "77") == {"rule_a", "rule_d", "*"}
    assert studio._has_person_reply(owner, page, "78") is True
    assert studio._has_person_reply(owner, page, "79") is False


def test_nested_replies_are_not_answered(monkeypatch):
    seen = []
    monkeypatch.setattr(studio, "process_comment", lambda **kwargs: seen.append(kwargs) or {"actions": ["public"]})
    payload = {"object": "page", "entry": [{"id": "5100000000099", "changes": [
        {"field": "feed", "value": {"item": "comment", "verb": "add", "comment_id": "5100000000099_2", "post_id": "5100000000099_1",
                                    "parent_id": "5100000000099_9", "message": "thanks!", "from": {"id": "9009"}}},
        {"field": "feed", "value": {"item": "comment", "verb": "add", "comment_id": "5100000000099_3", "post_id": "5100000000099_1",
                                    "parent_id": "5100000000099_1", "message": "top-level", "from": {"id": "9010"}}},
    ]}]}
    studio.handle_meta_webhook(payload)
    assert [k["comment_id"] for k in seen] == ["5100000000099_3"]


def test_temporary_reply_failures_are_retried_by_the_scheduler(monkeypatch):
    owner = f"owner_retry_{TAG}"
    page_id = f"spg_retry_{TAG}"
    rule_id = f"srule_retry_{TAG}"
    log_id = f"srl_retry_{TAG}"
    stamp = now_ms()
    past = studio._iso_at(datetime.now(timezone.utc) - timedelta(minutes=1))
    with db_conn() as conn:
        for entity_type, entity_id, data in (
            ("socialPages", page_id, {"ownerId": owner, "metaPageId": "5100000000077", "platform": "fb", "name": "P"}),
            ("socialReplyRules", rule_id, {"ownerId": owner, "enabled": True, "platform": "fb", "publicReply": "Thanks"}),
            ("socialReplyLog", log_id, {"ownerId": owner, "pageId": page_id, "platform": "fb", "ruleId": rule_id,
                                        "commentId": "5100000000077_5", "fromId": "9077", "actions": [], "processing": False,
                                        "error": "Meta paused", "retryAfter": past, "attempts": 1, "at": studio._iso_now()}),
        ):
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES (:type,:id,:data,false,:t,:owner,:t)"),
                         {"type": entity_type, "id": entity_id, "data": json_dumps({"id": entity_id, **data}), "t": stamp, "owner": owner})
    monkeypatch.setattr(studio, "_owner_can_automate", lambda owner_id: owner_id == owner)
    calls = []

    def fake_execute(page, rule, platform, comment_id):
        calls.append((page.get("metaPageId"), rule.get("publicReply"), platform, comment_id))
        return ["public"], [], False

    monkeypatch.setattr(studio, "_execute_rule_actions", fake_execute)
    try:
        assert studio._retry_pending_replies(datetime.now(timezone.utc)) >= 1
        assert calls == [("5100000000077", "Thanks", "fb", "5100000000077_5")]
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": log_id}).mappings().first()
        data = json_loads(row["data_json"])
        assert data["actions"] == ["public"] and data["retryAfter"] == "" and data["attempts"] == 2
    finally:
        with db_conn() as conn:
            for entity_id in (page_id, rule_id, log_id):
                conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": entity_id})


def test_reply_retries_continue_past_six_attempts_within_the_window(monkeypatch):
    owner = f"owner_retry7_{TAG}"
    page_id = f"spg_retry7_{TAG}"
    rule_id = f"srule_retry7_{TAG}"
    log_id = f"srl_retry7_{TAG}"
    stamp = now_ms()
    past = studio._iso_at(datetime.now(timezone.utc) - timedelta(minutes=1))
    with db_conn() as conn:
        for entity_type, entity_id, data in (
            ("socialPages", page_id, {"ownerId": owner, "metaPageId": "5100000000078", "platform": "fb", "name": "P"}),
            ("socialReplyRules", rule_id, {"ownerId": owner, "enabled": True, "platform": "fb", "publicReply": "Thanks"}),
            ("socialReplyLog", log_id, {"ownerId": owner, "pageId": page_id, "platform": "fb", "ruleId": rule_id,
                                        "commentId": "5100000000078_5", "fromId": "9078", "actions": [], "processing": False,
                                        "error": "Meta paused", "retryAfter": past, "attempts": 7, "at": studio._iso_now()}),
        ):
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES (:type,:id,:data,false,:t,:owner,:t)"),
                         {"type": entity_type, "id": entity_id, "data": json_dumps({"id": entity_id, **data}), "t": stamp, "owner": owner})
    monkeypatch.setattr(studio, "_owner_can_automate", lambda owner_id: owner_id == owner)
    monkeypatch.setattr(studio, "_execute_rule_actions", lambda page, rule, platform, comment_id: ([], ["Meta still paused"], True))
    try:
        assert studio._retry_pending_replies(datetime.now(timezone.utc)) >= 1
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": log_id}).mappings().first()
        data = json_loads(row["data_json"])
        assert data["attempts"] == 8 and data["retryAfter"] != ""      # still parked, not abandoned after ~8 hours
        assert data["retryAfter"] > studio._iso_at(datetime.now(timezone.utc) + timedelta(hours=3, minutes=50))
    finally:
        with db_conn() as conn:
            for entity_id in (page_id, rule_id, log_id):
                conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": entity_id})


def test_retry_pass_runs_every_sixth_tick(monkeypatch):
    calls = []
    monkeypatch.setattr(studio, "_RETRY_TICK", 0)
    monkeypatch.setattr(studio, "_retry_pending_replies", lambda now, limit=20: calls.append(now) or 0)
    for _ in range(7):
        studio.run_scheduler_tick(now=datetime.now(timezone.utc))
    assert len(calls) == 2                                            # ticks 1 and 7


def test_expired_reply_retries_are_released(monkeypatch):
    owner = f"owner_expired_{TAG}"
    page_id = f"spg_expired_{TAG}"
    log_id = f"srl_expired_{TAG}"
    stamp = now_ms()
    past = studio._iso_at(datetime.now(timezone.utc) - timedelta(minutes=1))
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                     {"id": log_id, "data": json_dumps({"id": log_id, "ownerId": owner, "pageId": page_id, "platform": "fb",
                                                        "ruleId": "rule_x", "commentId": "5100000000079_5", "fromId": "9079",
                                                        "actions": [], "processing": False, "error": "Meta paused",
                                                        "retryAfter": past, "attempts": 3,
                                                        "at": studio._iso_at(datetime.now(timezone.utc) - timedelta(days=8))}),
                      "t": stamp, "owner": owner})
    monkeypatch.setattr(studio, "_execute_rule_actions", lambda *a: (_ for _ in ()).throw(AssertionError("must not retry")))
    try:
        assert "rule_x" in studio._person_replied_rule_ids(owner, page_id, "9079")     # parked = answered ...
        studio._retry_pending_replies(datetime.now(timezone.utc))
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": log_id}).mappings().first()
        data = json_loads(row["data_json"])
        assert data["retryAfter"] == "" and "expired" in data["error"]
        assert "rule_x" not in studio._person_replied_rule_ids(owner, page_id, "9079")  # ... until the window passes
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": log_id})


def test_null_recorded_spend_matches_the_client():
    # The client reads Number(ad.spentUSD): a null/empty value that IS stored means "spent 0".
    stopped_null = {"status": "stopped", "amountUSD": 500, "spentUSD": None}
    stopped_missing = {"status": "stopped", "amountUSD": 500}
    assert operations._ad_sale_usd(stopped_null) == 0.0
    assert operations._ad_actual_spend_usd(stopped_null) == 0.0
    assert operations._ad_sale_usd(stopped_missing) == 500.0
    assert operations._ad_actual_spend_usd({"status": "active", "amountUSD": 300, "spentUSD": ""}) == 0.0
    assert operations._ad_actual_spend_usd({"status": "active", "amountUSD": 300, "spentUSD": "abc"}) == 0.0
    assert operations._ad_actual_spend_usd({"status": "active", "amountUSD": 300, "spentUSD": "12.5"}) == 12.5
    # A garbage value never freezes a finished ad at $0 when Meta reported real spend.
    assert operations._ad_actual_spend_usd({"status": "stopped", "spentUSD": "abc", "metaAdId": "1", "metaSpendMinor": 1250}) == 12.5


# ---------------------------------------------------------------- Clothes: order numbers per business

def _seed_admin(name):
    init_db()
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    uid = new_id("user")
    email = f"r3-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"),
            {"id": uid, "name": name, "email": email, "perm": json_dumps({}),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "now": now},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "email": email, "cookies": cookies}


def _clothes_order(actor, product_id, qty):
    created = client.post("/api/collections/clothesProducts", json={"id": product_id, "data": {
        "name": product_id, "costUSD": 3.25, "priceLYD": 20, "variants": [{"color": "Red", "size": "M", "qty": 10}],
    }}, cookies=actor["cookies"])
    assert created.status_code == 200, created.text
    response = client.post("/api/clothes/orders/mutate", json={
        "action": "create", "idempotencyKey": f"r3-order-{new_id('k')}",
        "data": {"customerName": "R3 Customer", "customerPhone": "0910000000", "note": "", "paymentMethod": "Cash",
                 "lines": [{"productId": product_id, "color": "Red", "size": "M", "qty": qty, "priceLYD": 20}],
                 "deliveryFeeLYD": 0, "paymentStatus": "Not Paid", "amountPaidLYD": 0},
    }, cookies=actor["cookies"])
    assert response.status_code == 200, response.text
    return response.json()["order"]["data"]


def test_order_numbers_follow_what_the_user_can_see(monkeypatch):
    staff = _seed_admin("shop-staff")
    staff_two = _seed_admin("shop-staff-two")
    one_a = _clothes_order(staff, f"cp_one_a_{TAG}", 1)
    one_b = _clothes_order(staff_two, f"cp_one_b_{TAG}", 1)
    assert one_b["orderNo"] == one_a["orderNo"] + 1      # staff who see every order share one sequence
    # A subscriber who sees only their own orders starts their own sequence at 1.
    monkeypatch.setattr(main, "_require_clothes_subscription", lambda user: None)
    email = f"r3-subscriber-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={"name": "Subscriber", "email": email, "password": PW, "role": "Employee",
                                              "permissions": {"clothesProducts": ["viewOwn", "add", "editOwn"], "clothesOrders": ["viewOwn", "add", "editOwn"]}},
                          cookies=staff["cookies"])
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": PW})
    subscriber = {"cookies": {"albayan_session": login.cookies.get("albayan_session")}}
    client.cookies.clear()
    two_a = _clothes_order(subscriber, f"cp_two_a_{TAG}", 1)
    assert two_a["orderNo"] == 1


# ---------------------------------------------------------------- deliveries: staff edits follow the state machine

def test_staff_edit_grant_cannot_reopen_a_delivered_job():
    admin = _seed_admin("delivery-office")
    editor_email = f"r3-editor-{TAG}@tests.albayanhub.com"
    editor = client.post("/api/users", json={"name": "Editor", "email": editor_email, "password": PW, "role": "Employee",
                                             "permissions": {"receipts": ["view", "edit"]}}, cookies=admin["cookies"])
    assert editor.status_code == 200, editor.text
    login = client.post("/api/auth/login", json={"email": editor_email, "password": PW})
    editor_cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    customer = client.post("/api/collections/customers", json={"data": {"name": f"R3 Delivery Cust {TAG}", "phone": "091" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=admin["cookies"])
    assert customer.status_code == 200, customer.text
    driver = client.post("/api/users", json={"name": "R3 Driver", "email": f"r3-driver-{TAG}@tests.albayanhub.com", "password": PW,
                                             "role": "Delivery", "permissions": {"deliveries": ["viewOwn", "accept", "complete"]}}, cookies=admin["cookies"])
    assert driver.status_code == 200, driver.text
    driver_id = driver.json()["id"]
    delivered = client.post("/api/collections/receipts", json={"data": {
        "customerId": customer.json()["id"], "status": "Paid", "isPaid": True, "amountUSD": 20, "amountLocal": 100,
        "exchangeRate": 5, "deliveryStatus": "Delivered", "deliveryPersonId": driver_id, "statusDetail": {"notPaidCollection": "delivery"},
    }}, cookies=admin["cookies"])
    assert delivered.status_code == 200, delivered.text
    rid = delivered.json()["id"]
    reopen = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"deliveryStatus": "In Progress"}}, cookies=editor_cookies)
    assert reopen.status_code == 400, reopen.text
    assert "reopened" in reopen.text
    # A legal move is still allowed for the same grant.
    pending = client.post("/api/collections/receipts", json={"data": {
        "customerId": customer.json()["id"], "status": "Not Paid", "amountUSD": 20, "amountLocal": 100, "exchangeRate": 5,
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": driver_id, "statusDetail": {"notPaidCollection": "delivery"},
    }}, cookies=admin["cookies"])
    assert pending.status_code == 200, pending.text
    accept = client.patch(f"/api/collections/receipts/{pending.json()['id']}", json={"data": {"deliveryStatus": "In Progress"}}, cookies=editor_cookies)
    assert accept.status_code == 200, accept.text
    backwards = client.patch(f"/api/collections/receipts/{pending.json()['id']}", json={"data": {"deliveryStatus": "Needs Delivery"}}, cookies=editor_cookies)
    assert backwards.status_code == 400, backwards.text
    # Ending the workflow from the office ("Delete mission", paid in office) stays allowed.
    office = client.patch(f"/api/collections/receipts/{pending.json()['id']}", json={"data": {"deliveryStatus": "Office", "deliveryPersonId": ""}}, cookies=editor_cookies)
    assert office.status_code == 200, office.text
    refund = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"deliveryStatus": "Office", "status": "Canceled"}}, cookies=editor_cookies)
    assert refund.status_code in (200, 409), refund.text  # 409 only if a money rule objects; never the reopen refusal
    assert "reopened" not in refund.text
