"""Deep-scan round 13: Clothes money edits, Social Studio reply claims and publish carry-forward."""

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

import server.social_studio as studio
from server.db import db_conn, init_db, json_loads
from server.test_clothes_transactions import _create_product, _mutate, _order_data, client as clothes_client  # noqa: F401
from server.test_clothes_transactions import _ensure_admin as _clothes_ensure_admin, ADMIN_EMAIL as CLOTHES_ADMIN_EMAIL, ADMIN_PASSWORD as CLOTHES_ADMIN_PASSWORD  # noqa: F401


def _clothes_login(email: str, password: str) -> dict[str, str]:
    r = clothes_client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    clothes_client.cookies.clear()
    return cookies
from server.test_social_studio import (  # noqa: F401  (graph/_fresh are fixtures)
    API as SOCIAL_API,
    APP_SECRET,
    _fb_comment,
    _fresh,
    _insert_user,
    _link,
    _log_rows,
    _login as _social_login,
    _post,
    _rule,
    _subscribe,
    _webhook,
    client as social_client,
    graph,
)

TAG = secrets.token_hex(3)


# ---------------------------------------------------------------- Clothes

@pytest.fixture(scope="module")
def clothes_admin():
    init_db()
    admin_id = _clothes_ensure_admin()
    return {"id": admin_id, "cookies": _clothes_login(CLOTHES_ADMIN_EMAIL, CLOTHES_ADMIN_PASSWORD)}


def _order(actor, order_id: str, product_id: str, qty: int, **overrides):
    data = _order_data(product_id, qty)
    data.update(overrides)
    r = _mutate(actor, {"action": "create", "orderId": order_id, "idempotencyKey": f"{order_id}-create", "data": data})
    assert r.status_code == 200, r.text
    return r.json()


def _order_row(order_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type='clothesOrders' AND id=:id"), {"id": order_id}).mappings().first()
    data = json_loads(row["data_json"]) or {}
    data["_lastModified"] = int(row["last_modified"])
    return data


def test_a_paid_order_whose_total_shrinks_keeps_the_money_recorded(clothes_admin):
    pid, oid = f"r13_prod_{TAG}", f"r13_order_{TAG}"
    _create_product(clothes_admin, pid, 10)
    _order(clothes_admin, oid, pid, 2, paymentStatus="Paid", amountPaidLYD=45)
    before = _order_row(oid)
    assert round(float(before["amountPaidLYD"]), 2) == 45.0          # 2 x 20 + 5 delivery
    data = _order_data(pid, 1); data.update({"paymentStatus": "Paid", "amountPaidLYD": 25})
    r = _mutate(clothes_admin, {"action": "update", "orderId": oid, "idempotencyKey": f"{oid}-shrink", "expectedLastModified": before["_lastModified"], "data": data})
    assert r.status_code == 200, r.text
    after = _order_row(oid)
    assert after["paymentStatus"] == "Paid"
    assert round(float(after["amountPaidLYD"]), 2) == 45.0, after       # before: silently rewritten to 25
    assert round(float(after.get("refundDueLYD") or 0), 2) == 20.0, after


def test_marking_an_order_not_paid_clears_its_paid_date(clothes_admin):
    pid, oid = f"r13_prod2_{TAG}", f"r13_order2_{TAG}"
    _create_product(clothes_admin, pid, 10)
    _order(clothes_admin, oid, pid, 1, paymentStatus="Paid", amountPaidLYD=25)
    before = _order_row(oid)
    assert before.get("paidAt")
    r = _mutate(clothes_admin, {"action": "payment", "orderId": oid, "idempotencyKey": f"{oid}-unpay", "expectedLastModified": before["_lastModified"],
                                "paymentStatus": "Not Paid", "data": {}})
    assert r.status_code == 200, r.text
    after = _order_row(oid)
    assert after["paymentStatus"] == "Not Paid" and after.get("paidAt") is None, after


# ---------------------------------------------------------------- Social Studio

@pytest.fixture(scope="module")
def actors():  # the shape test_social_studio's autouse _fresh fixture expects
    init_db()
    out = {}
    admin_email = f"r13-sadmin-{TAG}@tests.albayanhub.com"
    out["admin"] = {"id": _insert_user("R13 Admin", admin_email, "Admin"), "cookies": _social_login(admin_email)}
    email = f"r13-a-{TAG}@tests.albayanhub.com"
    uid = _insert_user("R13 a", email, "Employee")
    _subscribe(uid)
    out["a"] = {"id": uid, "cookies": _social_login(email)}
    return out


def test_a_non_meta_failure_mid_reply_releases_the_claim(actors, graph, monkeypatch):
    owner = actors["a"]["id"]
    page = _link(actors, "a", f"56{secrets.randbelow(10**11):011d}")
    _rule(actors["a"]["cookies"], oncePerPerson=True)
    meta_page_id = str(page["metaPageId"] if "metaPageId" in page else page["data"]["metaPageId"]) if isinstance(page, dict) else str(page)
    original_execute = studio._execute_rule_actions
    boom = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("database hiccup"))
    monkeypatch.setattr(studio, "_execute_rule_actions", boom)
    _webhook(_fb_comment(meta_page_id, f"c1_{TAG}", f"person_{TAG}", "hello"))
    rows = [r for r in _log_rows(owner) if str(r.get("commentId") or "") == f"c1_{TAG}"] or _log_rows(owner)
    assert rows, "the reservation row must exist"
    first = rows[-1]
    assert first.get("processing") is False and first.get("retryAfter"), first   # released for the retry pass, not parked forever
    monkeypatch.setattr(studio, "_execute_rule_actions", original_execute)  # keep the fake graph installed by the fixture
    monkeypatch.setattr(studio, "_owner_can_automate", lambda owner_id: True)
    handled = studio._retry_pending_replies(datetime.now(timezone.utc) + timedelta(hours=5), 20)  # past the retry delay cap
    assert handled >= 1
    replayed = [r for r in _log_rows(owner) if str(r.get("commentId") or "") == f"c1_{TAG}"]
    assert replayed and replayed[-1].get("actions"), replayed


def test_an_unticked_live_page_survives_an_interrupted_republish(actors, graph, monkeypatch):
    cookies = actors["a"]["cookies"]
    p1 = _link(actors, "a", f"57{secrets.randbelow(10**11):011d}")
    p2 = _link(actors, "a", f"58{secrets.randbelow(10**11):011d}")
    p3 = _link(actors, "a", f"59{secrets.randbelow(10**11):011d}")
    import server.meta_ads as meta_ads
    post = _post(cookies, [p1["id"], p2["id"]], caption="Carry").json()
    first_calls: list[int] = []

    def live_then_temporary(client_, page_data, post_id, data):
        first_calls.append(1)
        if len(first_calls) == 1:
            return "fbpost_live_first"
        raise meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True)

    monkeypatch.setattr(studio, "_publish_to_page", live_then_temporary)
    published = social_client.post(f"{SOCIAL_API}/posts/{post['id']}/publish", cookies=cookies).json()
    assert published["status"] == "failed", published
    live_id = next(r["metaPostId"] for r in published["results"] if r["pageId"] == p1["id"])
    assert live_id
    untick = social_client.patch(f"{SOCIAL_API}/posts/{post['id']}", json={"pageIds": [p2["id"], p3["id"]]}, cookies=cookies)
    assert untick.status_code == 200, untick.text
    calls: list[int] = []
    seen: dict = {}

    def crash_on_second_page(client_, page_data, post_id, data):
        calls.append(1)
        if len(calls) == 1:
            return "fbpost_second_page"
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": post_id}).mappings().first()
        seen["results"] = (json_loads(row["data_json"]) or {}).get("results") or []
        raise RuntimeError("simulated crash")

    monkeypatch.setattr(studio, "_publish_to_page", crash_on_second_page)
    try:
        social_client.post(f"{SOCIAL_API}/posts/{post['id']}/publish", cookies=cookies)
    except RuntimeError:
        pass
    kept = {r["pageId"]: r for r in seen["results"]}
    assert p1["id"] in kept and kept[p1["id"]]["metaPostId"] == live_id and kept[p1["id"]].get("removed") is True, seen


# ---------------------------------------------------------------- deliveries

def test_shared_delivery_rules_cover_the_money_routes():
    from fastapi import HTTPException
    from server import delivery_workflow as dw
    active = lambda uid: uid == "driver_live"
    assert "Canceled" in dw.TRANSITIONS["Office"]
    # an editor cannot hand a delivered job back to a driver through /settle
    with pytest.raises(HTTPException) as exc:
        dw.refuse_regression({"deliveryStatus": "Delivered", "deliveryPersonId": "driver_live"}, {"deliveryStatus": "In Progress"}, "employee", active_driver=active)
    assert exc.value.status_code == 400
    # an admin may, but a finished job keeps its driver
    dw.refuse_regression({"deliveryStatus": "Delivered", "deliveryPersonId": "driver_live"}, {"deliveryStatus": "Office"}, "admin", active_driver=active)
    with pytest.raises(HTTPException) as exc:
        dw.refuse_regression({"deliveryStatus": "Delivered", "deliveryPersonId": "driver_live"}, {"deliveryPersonId": "driver_other"}, "admin", active_driver=active)
    assert exc.value.status_code == 409
    # a new driver must be an active delivery user
    with pytest.raises(HTTPException) as exc:
        dw.refuse_regression({"deliveryStatus": "Needs Delivery", "deliveryPersonId": ""}, {"deliveryPersonId": "employee_id"}, "admin", active_driver=active)
    assert exc.value.status_code == 400
    dw.refuse_regression({"deliveryStatus": "Needs Delivery", "deliveryPersonId": ""}, {"deliveryPersonId": "driver_live"}, "admin", active_driver=active)


def test_only_invalid_webhook_signatures_are_rate_limited():
    from server.rate_limiter import reset_rate_limit
    raw = json.dumps({"object": "page", "entry": []}).encode("utf-8")
    good = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    reset_rate_limit("meta-webhook-bad:testclient")
    try:
        codes = {social_client.post("/api/meta-ads/webhook", content=raw, headers={"Content-Type": "application/json", "X-Hub-Signature-256": good}).status_code for _ in range(70)}
        assert codes == {200}, codes
        bad = [social_client.post("/api/meta-ads/webhook", content=raw, headers={"Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef"}).status_code for _ in range(65)]
        assert 403 in bad and bad[-1] == 429, bad[-5:]
    finally:
        reset_rate_limit("meta-webhook-bad:testclient")  # the limiter store is shared by the whole pytest session
