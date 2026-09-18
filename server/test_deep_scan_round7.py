"""Round 7 (2026-09-18): Clothes daily operations, Meta mapping, auto-import route."""

import secrets
from types import SimpleNamespace

import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
from server.db import db_conn, json_dumps, json_loads, now_ms
from server.test_clothes_transactions import (  # noqa: F401  (actor is a module fixture)
    _create_product,
    _mutate,
    _order_data,
    _product_qty,
    actor,
    client,
    subscriber_actor,
)

TAG = secrets.token_hex(3)


def _order(actor, product_id, qty, order_id, **data_overrides):
    data = {**_order_data(product_id, qty), **data_overrides}
    created = _mutate(actor, {"action": "create", "idempotencyKey": f"r7-create-{order_id}", "orderId": order_id, "data": data})
    assert created.status_code == 200, created.text
    return created.json()["order"]


def _status(actor, order, new_status, key):
    return _mutate(actor, {"action": "status", "orderId": order["id"], "idempotencyKey": key,
                           "expectedLastModified": order["lastModified"], "status": new_status})


def test_adding_items_to_a_paid_order_does_not_invent_collected_money(actor):
    pid, oid = f"r7_paid_{TAG}", f"r7_paid_order_{TAG}"
    _create_product(actor, pid, 10)
    order = _order(actor, pid, 2, oid, paymentStatus="Paid", amountPaidLYD=45)
    assert order["data"]["amountPaidLYD"] == 45
    more = _mutate(actor, {"action": "update", "orderId": oid, "idempotencyKey": f"r7-paid-update-{TAG}",
                           "expectedLastModified": order["lastModified"],
                           "data": {**_order_data(pid, 3), "paymentStatus": "Paid", "amountPaidLYD": 65}})
    assert more.status_code == 200, more.text
    data = more.json()["order"]["data"]
    assert data["paymentStatus"] == "Partially Paid" and data["amountPaidLYD"] == 45   # 20 LYD is still owed


def test_a_renamed_variant_gets_its_pieces_back_on_cancel(actor):
    pid, oid = f"r7_renamed_{TAG}", f"r7_renamed_order_{TAG}"
    _create_product(actor, pid, 5)
    order = _order(actor, pid, 2, oid)                       # Red/M: 5 -> 3
    with db_conn() as conn:                                  # staff renamed the variant while the order held 2 pieces
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": pid}).mappings().one()
        data = json_loads(row["data_json"]); data["variants"] = [{"color": "Crimson", "size": "M", "qty": 3}]
        conn.execute(text("UPDATE entities SET data_json=:d WHERE id=:id"), {"d": json_dumps(data), "id": pid})
    canceled = _status(actor, order, "Canceled", f"r7-renamed-cancel-{TAG}")
    assert canceled.status_code == 200, canceled.text
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": pid}).mappings().one()
    variants = {(v["color"], v["size"]): v["qty"] for v in json_loads(row["data_json"])["variants"]}
    assert variants == {("Crimson", "M"): 3, ("Red", "M"): 2}   # nothing vanished


def test_an_order_whose_product_was_deleted_can_still_be_canceled(actor):
    pid, oid = f"r7_gone_{TAG}", f"r7_gone_order_{TAG}"
    _create_product(actor, pid, 5)
    order = _order(actor, pid, 2, oid)
    with db_conn() as conn:  # the product row vanished (legacy batch delete)
        conn.execute(text("UPDATE entities SET deleted=true WHERE type='clothesProducts' AND id=:id"), {"id": pid})
    canceled = _status(actor, order, "Canceled", f"r7-gone-cancel-{TAG}")
    assert canceled.status_code == 200, canceled.text
    assert canceled.json()["order"]["data"]["status"] == "Canceled"


def test_moving_a_delivered_order_back_clears_its_delivery_stamp(actor):
    pid, oid = f"r7_deliv_{TAG}", f"r7_deliv_order_{TAG}"
    _create_product(actor, pid, 5)
    order = _order(actor, pid, 1, oid)
    delivered = _status(actor, order, "Delivered", f"r7-deliv-1-{TAG}")
    assert delivered.status_code == 200, delivered.text
    first_stamp = delivered.json()["order"]["data"]["deliveredAt"]
    assert first_stamp
    back = _status(actor, delivered.json()["order"], "On the way", f"r7-deliv-back-{TAG}")
    assert back.status_code == 200, back.text
    assert not back.json()["order"]["data"].get("deliveredAt")
    again = _status(actor, back.json()["order"], "Delivered", f"r7-deliv-2-{TAG}")
    assert again.status_code == 200, again.text
    assert again.json()["order"]["data"]["deliveredAt"] >= first_stamp


def test_a_phone_only_edit_does_not_rewrite_the_products(actor):
    pid, oid = f"r7_phone_{TAG}", f"r7_phone_order_{TAG}"
    _create_product(actor, pid, 5)
    order = _order(actor, pid, 2, oid)
    fixed = _mutate(actor, {"action": "update", "orderId": oid, "idempotencyKey": f"r7-phone-fix-{TAG}",
                            "expectedLastModified": order["lastModified"],
                            "data": {**_order_data(pid, 2), "customerPhone": "0919999999"}})
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["updatedProducts"] == []
    assert _product_qty(pid) == 3


def test_payment_action_records_a_partial_amount(actor):
    pid, oid = f"r7_partial_{TAG}", f"r7_partial_order_{TAG}"
    _create_product(actor, pid, 5)
    order = _order(actor, pid, 2, oid)                      # total 45
    partial = _mutate(actor, {"action": "payment", "orderId": oid, "idempotencyKey": f"r7-partial-{TAG}",
                              "expectedLastModified": order["lastModified"], "paymentStatus": "Partially Paid",
                              "data": {"amountPaidLYD": 30}})
    assert partial.status_code == 200, partial.text
    assert partial.json()["order"]["data"]["amountPaidLYD"] == 30
    too_much = _mutate(actor, {"action": "payment", "orderId": oid, "idempotencyKey": f"r7-partial-over-{TAG}",
                               "expectedLastModified": partial.json()["order"]["lastModified"], "paymentStatus": "Partially Paid",
                               "data": {"amountPaidLYD": 99}})
    assert too_much.status_code == 400, too_much.text


def test_imported_ad_never_starts_before_it_was_created():
    start, end, _days = meta_ads._imported_ad_dates({"metaStartTime": "2026-06-01T00:00:00+0200", "metaAdCreatedTime": "2026-09-18T10:00:00+0000"})
    assert start.startswith("2026-09-18")
    start2, _e, _d = meta_ads._imported_ad_dates({"metaStartTime": "2026-09-20T00:00:00+0000", "metaAdCreatedTime": "2026-09-18T10:00:00+0000"})
    assert start2.startswith("2026-09-20")                 # a scheduled future start stays


def test_graph_code_100_is_not_a_permanent_not_found():
    fake_client = meta_ads.MetaAdsClient.__new__(meta_ads.MetaAdsClient)
    response = SimpleNamespace(status_code=400)
    invalid_param = fake_client._safe_error(response, {"error": {"code": 100, "message": "(#100) Tried accessing nonexisting field"}})
    assert invalid_param.code != "not_found"
    gone = fake_client._safe_error(response, {"error": {"code": 100, "error_subcode": 33, "message": "Unsupported get request"}})
    assert gone.code == "not_found"


def test_import_existing_skips_drafts_the_office_deleted():
    meta_id = f"90{secrets.randbelow(10**10):010d}"
    row_id = f"ad_r7_deleted_{TAG}"
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:id,:d,true,:t,'system',:t)"),
                     {"id": row_id, "d": json_dumps({"id": row_id, "metaAdId": meta_id, "status": "Active"}), "t": now_ms()})
    try:
        assert meta_id in meta_ads._existing_meta_ad_ids(deleted=True)
        assert meta_id not in meta_ads._existing_meta_ad_ids()
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": row_id})


def test_auto_import_run_is_admin_only_and_forces_discovery(actor, subscriber_actor, monkeypatch):
    calls = []
    refused = client.post("/api/meta-ads/auto-import/run", json={"includeExisting": True}, cookies=subscriber_actor["cookies"])
    assert refused.status_code == 403, refused.text
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *a, **kw: calls.append(kw) or {"imported": 0})
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", lambda: SimpleNamespace(configured=True, access_token="t", app_secret="s",
                                                                                   account_ids=("1",), webhook_verify_token=""))
    response = client.post("/api/meta-ads/auto-import/run", json={"includeExisting": True}, cookies=actor["cookies"])
    assert response.status_code == 200, response.text
    assert calls and calls[-1].get("force") is True and calls[-1].get("include_existing") is True
