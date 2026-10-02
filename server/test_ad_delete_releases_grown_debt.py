"""F-addelete: deleting an ad releases its grown receipt debt at once (real routes)."""
import pytest
from sqlalchemy import event, text

from server import main
from server.db import db_conn, get_engine
from server.test_receipt_company_coverages import (  # noqa: F401  (fixtures + helpers)
    actors, client, _customer, _unpaid_receipt, _paid_receipt, _entity, _cover, _stop,
)
from server.test_company_coverage_customer import _cover_customer, _debt_ad

DETAIL = "An ad paid from company funds cannot be deleted; stop it instead"
LINKED = "Receipt {} cannot be deleted while linked to ad funding"


def _grow_ad(ad_id, cid, rid, due, grow, actors, extra=None):
    receipt = _entity("receipts", rid, actors["admin"])
    data = {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5,
            "receiptId": rid, "receiptAllocations": [], "dueAllocations": [{"receiptId": rid, "amountUSD": due}]}
    if grow:
        data["unpaidReceiptDebtIncrease"] = {"receiptId": rid, "amountUSD": grow, "expectedLastModified": receipt["lastModified"]}
    data.update(extra or {})
    r = client.post("/api/ads/mutate", json={"action": "create", "adId": ad_id, "idempotencyKey": ad_id + "-create-key", "data": data}, cookies=actors["admin"])
    assert r.status_code == 200, r.text
    return r.json()["ad"]


def _r(rid, actors):
    d = _entity("receipts", rid, actors["admin"])["data"]
    return d["amountUSD"], d["amountLocal"], d.get("debtAmountUSD"), d.get("companyCoveredUSD"), d.get("customerOutstandingUSD")


def _delete(aid, actors, who="admin"):
    return client.delete(f"/api/collections/ads/{aid}", cookies=actors[who])


def _batch(items, actors):
    return client.post("/api/batch/delete", json={"items": [{"collection": c, "id": i} for c, i in items]}, cookies=actors["admin"])


def test_01_zero_base_released_at_once_and_replay(actors):
    _customer("d01_c", actors); _unpaid_receipt("d01_r", "d01_c", 0, actors)
    _grow_ad("d01_a", "d01_c", "d01_r", 50, 50, actors)
    assert _r("d01_r", actors)[0] == 50
    assert _delete("d01_a", actors).status_code == 200
    assert _r("d01_r", actors)[:3] == (0, 0, 0)
    before = _entity("receipts", "d01_r", actors["admin"])["lastModified"]
    assert _delete("d01_a", actors).status_code == 200
    assert _entity("receipts", "d01_r", actors["admin"])["lastModified"] == before
    main.backfill_repair_legacy_unpaid_receipt_overgrowth()
    assert _entity("receipts", "d01_r", actors["admin"])["lastModified"] == before


def test_02_manual_base_kept(actors):
    _customer("d02_c", actors); _unpaid_receipt("d02_r", "d02_c", 10, actors)
    _grow_ad("d02_a", "d02_c", "d02_r", 50, 40, actors)
    assert _delete("d02_a", actors).status_code == 200
    assert _r("d02_r", actors)[:3] == (10, 50, 10)


def test_03_staff_raise_kept(actors):
    _customer("d03_c", actors); _unpaid_receipt("d03_r", "d03_c", 0, actors)
    _grow_ad("d03_a", "d03_c", "d03_r", 50, 50, actors)
    rec = _entity("receipts", "d03_r", actors["admin"])
    p = client.patch("/api/collections/receipts/d03_r", json={"data": {"amountUSD": 60, "amountLocal": 300, "debtAmountUSD": 60, "debtAmountLocal": 300}, "expectedLastModified": rec["lastModified"]}, cookies=actors["admin"])
    assert p.status_code == 200, p.text
    assert _delete("d03_a", actors).status_code == 200
    assert _r("d03_r", actors)[0] == 10


def test_04_two_ads(actors):
    _customer("d04_c", actors); _unpaid_receipt("d04_r", "d04_c", 0, actors)
    _grow_ad("d04_a", "d04_c", "d04_r", 50, 50, actors); _grow_ad("d04_b", "d04_c", "d04_r", 30, 30, actors)
    assert _delete("d04_a", actors).status_code == 200
    assert _r("d04_r", actors)[0] == 30
    assert _delete("d04_b", actors).status_code == 200
    assert _r("d04_r", actors)[0] == 0


def test_05_stopped_ad(actors):
    _customer("d05_c", actors); _unpaid_receipt("d05_r", "d05_c", 0, actors)
    ad = _grow_ad("d05_a", "d05_c", "d05_r", 50, 50, actors)
    assert _stop("d05_a", 2000, "d05_stop_key", ad["lastModified"], actors["admin"]).status_code == 200
    assert _r("d05_r", actors)[0] == 20
    assert _delete("d05_a", actors).status_code == 200
    assert _r("d05_r", actors)[0] == 0


def test_06_company_rows_refused_sibling_released(actors):
    _customer("d06_c", actors); _unpaid_receipt("d06_r", "d06_c", 0, actors)
    _grow_ad("d06_a", "d06_c", "d06_r", 50, 50, actors); _grow_ad("d06_b", "d06_c", "d06_r", 30, 30, actors)
    rec = _entity("receipts", "d06_r", actors["admin"])
    assert _cover("d06_r", 5000, "d06_cover_key", rec["lastModified"], actors["admin"]).status_code == 200
    before = _entity("receipts", "d06_r", actors["admin"])
    d = _delete("d06_a", actors)
    assert d.status_code == 409 and d.json()["detail"] == DETAIL
    assert _entity("ads", "d06_a", actors["admin"])["deleted"] is False
    assert _entity("receipts", "d06_r", actors["admin"]) == before
    assert _delete("d06_b", actors).status_code == 200
    assert _r("d06_r", actors) == (50, 250, 50, 50, 0)


def test_07_direct_coverage_refused(actors):
    _customer("d07_c", actors)
    _debt_ad("d07_a", "d07_c", 50, actors["admin"])
    c = _cover_customer("d07_c", 2000, 5000, "d07_cover_key", actors["admin"])
    assert c.status_code == 200, c.text
    assert _entity("ads", "d07_a", actors["admin"])["data"]["companyDirectCoverageUSD"] == 20
    d = _delete("d07_a", actors)
    assert d.status_code == 409 and d.json()["detail"] == DETAIL
    b = _batch([("ads", "d07_a")], actors)
    assert b.status_code == 409 and b.json()["detail"] == DETAIL


def test_08_covered_floor(actors):
    _customer("d08_c", actors); _unpaid_receipt("d08_r", "d08_c", 0, actors)
    _grow_ad("d08_a", "d08_c", "d08_r", 50, 50, actors)
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted=true WHERE type='ads' AND id='d08_a'"))
    rec = _entity("receipts", "d08_r", actors["admin"])
    assert _cover("d08_r", 5000, "d08_cover_key", rec["lastModified"], actors["admin"]).status_code == 200
    _grow_ad("d08_b", "d08_c", "d08_r", 20, 0, actors)
    before = _entity("receipts", "d08_r", actors["admin"])
    assert _delete("d08_b", actors).status_code == 200
    assert _entity("receipts", "d08_r", actors["admin"]) == before


def test_09_batch(actors):
    _customer("d09_c", actors); _unpaid_receipt("d09_r", "d09_c", 10, actors)
    _grow_ad("d09_a", "d09_c", "d09_r", 50, 40, actors)
    assert _batch([("ads", "d09_a")], actors).status_code == 200
    assert _r("d09_r", actors)[:3] == (10, 50, 10)
    # two ads of one receipt in one batch
    _unpaid_receipt("d09_r2", "d09_c", 0, actors)
    _grow_ad("d09_b", "d09_c", "d09_r2", 50, 50, actors); _grow_ad("d09_d", "d09_c", "d09_r2", 30, 30, actors)
    assert _batch([("ads", "d09_d"), ("ads", "d09_b")], actors).status_code == 200
    assert _r("d09_r2", actors)[:3] == (0, 0, 0)
    hist = _entity("receipts", "d09_r2", actors["admin"])["data"]["editHistory"]
    assert [(h["changes"][0]["from"], h["changes"][0]["to"]) for h in hist][-2:] == [("$50.00", "$80.00"), ("$80.00", "$0.00")]  # ONE release entry
    # replay of the batch
    lm = _entity("receipts", "d09_r2", actors["admin"])["lastModified"]
    assert _batch([("ads", "d09_d"), ("ads", "d09_b")], actors).status_code == 200
    assert _entity("receipts", "d09_r2", actors["admin"])["lastModified"] == lm
    # covered ad + other ad -> 409, neither deleted, receipt untouched
    _unpaid_receipt("d09_r3", "d09_c", 0, actors)
    _grow_ad("d09_e", "d09_c", "d09_r3", 50, 50, actors); _grow_ad("d09_f", "d09_c", "d09_r3", 30, 30, actors)
    rec = _entity("receipts", "d09_r3", actors["admin"])
    assert _cover("d09_r3", 5000, "d09_cover_key", rec["lastModified"], actors["admin"]).status_code == 200
    before = _entity("receipts", "d09_r3", actors["admin"])
    b = _batch([("ads", "d09_f"), ("ads", "d09_e")], actors)
    assert b.status_code == 409 and b.json()["detail"] == DETAIL
    assert _entity("receipts", "d09_r3", actors["admin"]) == before
    assert not _entity("ads", "d09_e", actors["admin"])["deleted"] and not _entity("ads", "d09_f", actors["admin"])["deleted"]
    # only the uncovered one, sibling of a covered one, in a batch
    assert _batch([("ads", "d09_f")], actors).status_code == 200
    assert _r("d09_r3", actors) == (50, 250, 50, 50, 0)


def test_09b_batch_ad_only_does_not_reference_check_its_receipt(actors):
    """The ad's receipt is locked but must not be treated as a receipt being deleted."""
    _customer("d9b_c", actors); _unpaid_receipt("d9b_r", "d9b_c", 0, actors)
    _grow_ad("d9b_a", "d9b_c", "d9b_r", 50, 50, actors); _grow_ad("d9b_b", "d9b_c", "d9b_r", 30, 30, actors)
    b = _batch([("ads", "d9b_a")], actors)
    assert b.status_code == 200, b.text
    assert _r("d9b_r", actors)[0] == 30
    assert _entity("receipts", "d9b_r", actors["admin"])["deleted"] is False


def test_09c_batch_ad_and_its_receipt_together(actors):
    _customer("d9c_c", actors); _unpaid_receipt("d9c_r", "d9c_c", 0, actors)
    _grow_ad("d9c_a", "d9c_c", "d9c_r", 50, 50, actors)
    b = _batch([("ads", "d9c_a"), ("receipts", "d9c_r")], actors)
    assert b.status_code == 409 and b.json()["detail"] == LINKED.format("d9c_r")
    rec = _entity("receipts", "d9c_r", actors["admin"])
    assert rec["deleted"] is False and rec["data"]["amountUSD"] == 50  # refused whole: not shrunk
    assert _entity("ads", "d9c_a", actors["admin"])["deleted"] is False


def test_09d_batch_customer_cascade(actors):
    _customer("d9d_c", actors); _unpaid_receipt("d9d_r", "d9d_c", 0, actors)
    _grow_ad("d9d_a", "d9d_c", "d9d_r", 50, 50, actors)
    b = _batch([("ads", "d9d_a"), ("receipts", "d9d_r"), ("customers", "d9d_c")], actors)
    assert b.status_code == 409 and b.json()["detail"] == LINKED.format("d9d_r")
    rec = _entity("receipts", "d9d_r", actors["admin"])
    assert rec["deleted"] is False and rec["data"]["amountUSD"] == 50
    # covered cascade
    _customer("d9e_c", actors); _unpaid_receipt("d9e_r", "d9e_c", 0, actors)
    _grow_ad("d9e_a", "d9e_c", "d9e_r", 50, 50, actors)
    rec = _entity("receipts", "d9e_r", actors["admin"])
    assert _cover("d9e_r", 5000, "d9e_cover_key", rec["lastModified"], actors["admin"]).status_code == 200
    b = _batch([("ads", "d9e_a"), ("receipts", "d9e_r"), ("customers", "d9e_c")], actors)
    assert b.status_code == 409
    b = _batch([("receipts", "d9e_r"), ("ads", "d9e_a")], actors)
    assert b.status_code == 409


def test_10_unchanged_paths(actors):
    _customer("d10_c", actors); _paid_receipt("d10_r", "d10_c", 100, actors)
    r = client.post("/api/ads/mutate", json={"action": "create", "adId": "d10_a", "idempotencyKey": "d10_a-create-key", "data": {
        "customerId": "d10_c", "paymentStatus": "paid", "receiptAllocations": [{"receiptId": "d10_r", "amountUSD": 60}]}}, cookies=actors["admin"])
    assert r.status_code == 200, r.text
    before = _entity("receipts", "d10_r", actors["admin"])
    assert _delete("d10_a", actors).status_code == 200
    assert _entity("receipts", "d10_r", actors["admin"]) == before
    # receipt deleted
    _unpaid_receipt("d10_r2", "d10_c", 0, actors); _grow_ad("d10_b", "d10_c", "d10_r2", 50, 50, actors)
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted=true WHERE type='receipts' AND id='d10_r2'"))
    assert _delete("d10_b", actors).status_code == 200
    # junk ads
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) VALUES ('ads','d10_junk','{\"title\":\"Ad\",\"receiptId\":\"bad id!!\"}',false,1,NULL,1)"))
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) VALUES ('ads','d10 odd!id','{\"title\":\"Ad\"}',false,1,NULL,1)"))
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) VALUES ('ads','d10_junk2','{\"paymentStatus\":\"not_paid\",\"collectionMethod\":\"in_shop\",\"receiptId\":\"d10_r\",\"dueAllocations\":\"x\"}',false,1,NULL,1)"))
    assert _delete("d10_junk", actors).status_code == 200
    assert _delete("d10_junk2", actors).status_code == 200
    assert client.delete("/api/collections/ads/d10%20odd!id", cookies=actors["admin"]).status_code == 200
    assert _delete("d10_missing", actors).status_code == 404
    # hand-written receipt with no growth history keeps its amount
    _unpaid_receipt("d10_r3", "d10_c", 50, actors); _grow_ad("d10_d", "d10_c", "d10_r3", 50, 0, actors)
    before = _entity("receipts", "d10_r3", actors["admin"])
    assert _delete("d10_d", actors).status_code == 200
    assert _entity("receipts", "d10_r3", actors["admin"]) == before


def test_10b_settled_receipt_untouched(actors):
    _customer("d10b_c", actors); _unpaid_receipt("d10b_r", "d10b_c", 0, actors)
    _grow_ad("d10b_a", "d10b_c", "d10b_r", 50, 50, actors)
    rec = _entity("receipts", "d10b_r", actors["admin"])
    s = client.post("/api/receipts/d10b_r/settle", json={"idempotencyKey": "d10b_settle_key", "expectedLastModified": rec["lastModified"],
        "payments": [{"method": "Cash (LYD)", "amount": 250}], "exchangeRate": 5}, cookies=actors["admin"])
    assert s.status_code == 200, s.text
    before = _entity("receipts", "d10b_r", actors["admin"])
    assert _delete("d10b_a", actors).status_code == 200
    assert _entity("receipts", "d10b_r", actors["admin"]) == before


def test_11_closed_month(actors):
    period = "2019-06"
    _customer("d11_c", actors); _unpaid_receipt("d11_r", "d11_c", 0, actors, date=f"{period}-15")
    _grow_ad("d11_a", "d11_c", "d11_r", 50, 50, actors)
    closed = client.post("/api/admin/operations/financial-periods/close", json={"period": period, "forceReason": "Test ad delete period protection"}, cookies=actors["admin"])
    assert closed.status_code == 200, closed.text
    try:
        before = _entity("receipts", "d11_r", actors["admin"])
        d = _delete("d11_a", actors)
        assert d.status_code == 423
        assert _entity("ads", "d11_a", actors["admin"])["deleted"] is False
        assert _entity("receipts", "d11_r", actors["admin"]) == before
        b = _batch([("ads", "d11_a")], actors)
        assert b.status_code == 423
    finally:
        r = client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "Test cleanup of ad delete period"}, cookies=actors["admin"])
        assert r.status_code == 200, r.text
    assert _delete("d11_a", actors).status_code == 200
    assert _r("d11_r", actors)[0] == 0


def test_12_lock_order(actors):
    _customer("d12_c", actors); _unpaid_receipt("d12_r", "d12_c", 0, actors)
    _grow_ad("d12_a", "d12_c", "d12_r", 50, 50, actors)
    seen = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        if "FROM entities WHERE type=" in statement and "LIMIT 1" in statement:
            seen.append(tuple(parameters)[:2] if not isinstance(parameters, dict) else (parameters.get("type"), parameters.get("id")))

    event.listen(get_engine(), "before_cursor_execute", listener)
    try:
        assert _delete("d12_a", actors).status_code == 200
    finally:
        event.remove(get_engine(), "before_cursor_execute", listener)
    order = [s for s in seen if s in {("receipts", "d12_r"), ("ads", "d12_a")}]
    assert order[:3] == [("ads", "d12_a"), ("receipts", "d12_r"), ("ads", "d12_a")]


def test_13_restore_refused(actors):
    r = client.put("/api/admin/collections/ads/d01_a/restore", json={"data": {"recordType": "ad"}, "deleted": False, "createdAt": 1}, cookies=actors["admin"])
    assert r.status_code == 405


def test_14_employee_without_ads_delete_permission(actors):
    _customer("d14_c", actors); _unpaid_receipt("d14_r", "d14_c", 0, actors)
    _grow_ad("d14_a", "d14_c", "d14_r", 50, 50, actors)
    d = _delete("d14_a", actors, who="employee")
    assert d.status_code == 403
    assert _r("d14_r", actors)[0] == 50 and _entity("ads", "d14_a", actors["admin"])["deleted"] is False


def test_15_legacy_scalar_due(actors):
    """Ad with no due rows, only the scalar mirror, on a grown receipt."""
    _customer("d15_c", actors); _unpaid_receipt("d15_r", "d15_c", 0, actors)
    _grow_ad("d15_a", "d15_c", "d15_r", 50, 50, actors)
    with db_conn() as conn:  # rewrite as a legacy scalar row
        import json
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id='d15_a'")).first()
        data = json.loads(row[0]); data.pop("dueAllocations", None); data["dueAmountToUseUSD"] = 50; data["dueAmountToUseLYD"] = 250
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type='ads' AND id='d15_a'"), {"d": json.dumps(data)})
    assert _delete("d15_a", actors).status_code == 200
    assert _r("d15_r", actors)[0] == 0


def test_16_cover_after_delete_finds_nothing(actors):
    _customer("d16_c", actors); _unpaid_receipt("d16_r", "d16_c", 0, actors)
    _grow_ad("d16_a", "d16_c", "d16_r", 50, 50, actors)
    assert _delete("d16_a", actors).status_code == 200
    rec = _entity("receipts", "d16_r", actors["admin"])
    c = _cover("d16_r", 5000, "d16_cover_key", rec["lastModified"], actors["admin"])
    assert c.status_code == 409 and c.json()["detail"] == "Receipt outstanding liability is smaller than requested amount"
