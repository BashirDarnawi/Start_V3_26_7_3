"""Deep-scan round 11: HTTP layer, profitability inputs, data-model cascades, subscriptions."""

import json
import os
import secrets
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import auth_limits, main, operations
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.db import db_conn, init_db, json_dumps, now_ms
from server.rate_limiter import reset_rate_limit

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r11-admin-{TAG}@tests.albayanhub.com"
DRIVER_EMAIL = f"r11-driver-{TAG}@tests.albayanhub.com"
PASSWORD = "Round11Pass123!"


def _seed_user(email: str, role: str, permissions: dict) -> str:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": email.split("@")[0], "email": email, "role": role, "perms": json_dumps(permissions),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )
    return uid


def _login(email: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def staff():
    init_db()
    admin_id = _seed_user(ADMIN_EMAIL, "Admin", {})
    driver_id = _seed_user(DRIVER_EMAIL, "Delivery", {})
    return {"admin": _login(ADMIN_EMAIL), "admin_id": admin_id, "driver_id": driver_id}


def _create(collection: str, entity_id: str, data: dict, cookies) -> dict:
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _entity(collection: str, entity_id: str, cookies) -> dict:
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _customer(cid: str, cookies) -> dict:
    return _create("customers", cid, {"name": cid, "phones": [f"09{secrets.randbelow(10**8):08d}"]}, cookies)


def _unpaid_receipt(rid: str, cid: str, amount: float, cookies, **extra) -> dict:
    data = {"recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5,
            "debtAmountUSD": amount, "debtAmountLocal": amount * 5, "exchangeRate": 5, "status": "Not Paid",
            "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}
    data.update(extra)
    return _create("receipts", rid, data, cookies)


def _ad_due(aid: str, cid: str, rid: str, due: float, cookies) -> dict:
    r = client.post("/api/ads/mutate", json={"action": "create", "adId": aid, "idempotencyKey": f"{aid}-create",
                                             "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop",
                                                      "exchangeRate": 5, "receiptId": rid,
                                                      "dueAllocations": [{"receiptId": rid, "amountUSD": due}], "receiptAllocations": []}},
                    cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()["ad"]


# ---------------------------------------------------------------- HTTP layer

def test_a_bogus_cookie_does_not_unlock_large_request_bodies(staff):
    big = json.dumps({"id": f"r11_big_{TAG}", "data": {"name": "big", "notes": "a" * (300 * 1024)}})
    r = client.post("/api/collections/customers", content=big,
                    headers={"Content-Type": "application/json", "Cookie": "albayan_session=bogus.bogus"})
    assert r.status_code == 401 and "Sign in before" in r.text, (r.status_code, r.text[:120])
    r2 = client.post("/api/collections/customers", content=big, headers={"Content-Type": "application/json"}, cookies=staff["admin"])
    assert not (r2.status_code == 401 and "Sign in before" in r2.text), r2.text[:120]  # a real session passes the gate


def test_webhook_body_is_capped_at_one_megabyte():
    r = client.post("/api/meta-ads/webhook", content=b"x" * (2 * 1024 * 1024), headers={"Content-Type": "application/json"})
    assert r.status_code == 413, (r.status_code, r.text[:120])


def test_cf_connecting_ip_is_trusted_only_behind_the_validated_edge(monkeypatch):
    monkeypatch.setattr(auth_limits, "TRUST_PROXY_HEADERS", True)
    monkeypatch.setenv("ALBAYAN_ORIGIN_SECRET", "round-eleven-secret-value")
    req = SimpleNamespace(headers={"cf-connecting-ip": "10.0.0.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8"},
                          client=SimpleNamespace(host="127.0.0.1"), state=SimpleNamespace())
    assert auth_limits._client_ip(req) == "5.6.7.8"          # bypassed Cloudflare: the header is not believed
    req.state.origin_secret_ok = True
    assert auth_limits._client_ip(req) == "10.0.0.9"         # came through the edge that knows the secret
    monkeypatch.delenv("ALBAYAN_ORIGIN_SECRET")
    req2 = SimpleNamespace(headers={"cf-connecting-ip": "10.0.0.9"}, client=SimpleNamespace(host="127.0.0.1"), state=SimpleNamespace())
    assert auth_limits._client_ip(req2) == "10.0.0.9"        # no secret configured: today's behaviour


def test_reset_request_429_carries_retry_after():
    email = f"r11-reset-{TAG}@tests.albayanhub.com"
    last = None
    for _ in range(25):
        last = client.post("/api/auth/password-reset/request", json={"email": email})
        if last.status_code == 429:
            break
    assert last is not None and last.status_code == 429, last.status_code
    assert last.headers.get("retry-after"), dict(last.headers)


def test_manual_backup_is_rate_limited_and_never_leaks_the_error(staff, monkeypatch):
    def _boom():
        raise RuntimeError("pg_dump failed: host=db-internal-secret user=albayan")
    monkeypatch.setattr(operations, "create_encrypted_backup", _boom)
    reset_rate_limit(f"backup-run:{staff['admin_id']}")
    responses = [client.post("/api/admin/operations/backups/run", cookies=staff["admin"]) for _ in range(7)]
    codes = [r.status_code for r in responses]
    assert codes[:6] == [503] * 6 and codes[6] == 429, codes
    assert all("db-internal-secret" not in r.text for r in responses[:6])
    reset_rate_limit(f"backup-run:{staff['admin_id']}")


# ---------------------------------------------------------------- month close and imports

def test_period_snapshot_ignores_receipts_the_company_fully_absorbed(monkeypatch):
    rows = {"receipts": [
        {"id": "c1", "date": "2026-09-02", "status": "Not Paid", "amountUSD": 100, "companyCoveredUSD": 100, "customerOutstandingUSD": 0},
        {"id": "c2", "date": "2026-09-03", "status": "Not Paid", "amountUSD": 100, "companyCoveredUSD": 40},
        {"id": "c3", "date": "2026-09-04", "status": "Not Paid", "amountUSD": 50},
        # delivered, nothing collected: amountUSD is the driver's cash (0), the debt is still owed
        {"id": "d1", "date": "2026-09-05", "status": "Not Paid", "amountUSD": 0, "debtAmountUSD": 100, "customerOutstandingUSD": 100},
        {"id": "d2", "date": "2026-09-06", "status": "Not Paid", "amountUSD": 0, "debtAmountUSD": 80},
    ], "ads": [], "dollarPurchases": []}
    monkeypatch.setattr(operations, "_entity_rows", lambda collection, conn=None: [dict(r) for r in rows.get(collection, [])])
    snap = operations._period_snapshot("2026-09")
    assert snap["counts"]["unpaidReceipts"] == 4, snap["counts"]
    assert any(b["code"] == "unpaid_receipts" and b["count"] == 4 for b in snap["blockers"]), snap["blockers"]


def test_online_import_validates_dollar_lots(staff, monkeypatch):
    monkeypatch.setattr(main, "ENABLE_ONLINE_IMPORT", True, raising=False)
    r = client.post("/api/admin/import",
                    json={"collections": {"dollarPurchases": [{"id": f"r11_lot_{TAG}", "purchaseDate": "2026/02/03", "amountUSD": 100, "rateLYD": 5}]}},
                    cookies=staff["admin"])
    assert r.status_code == 400, (r.status_code, r.text[:160])
    assert "purchaseDate" in r.text


# ---------------------------------------------------------------- data-model cascades

def test_both_delete_routes_refuse_a_receipt_with_company_rows(staff):
    admin = staff["admin"]
    cid, rid, aid = f"r11_bcust_{TAG}", f"r11_brcpt_{TAG}", f"r11_bad_{TAG}"
    _customer(cid, admin); _unpaid_receipt(rid, cid, 100, admin); _ad_due(aid, cid, rid, 100, admin)
    receipt = _entity("receipts", rid, admin)
    cover = client.post(f"/api/receipts/{rid}/company-coverages",
                        json={"amountMinorUSD": 10000, "idempotencyKey": f"r11-cover-{TAG}", "expectedLastModified": receipt["lastModified"],
                              "reason": "Round eleven batch delete"}, cookies=admin)
    assert cover.status_code == 200, cover.text
    assert _entity("ads", aid, admin)["data"].get("companyFundingAllocations"), "coverage should leave company rows on the ad"
    # Both delete routes agree: a receipt carrying company rows is refused (409), never half-deleted.
    batch = client.post("/api/batch/delete", json={"items": [{"collection": "receipts", "id": rid}]}, cookies=admin)
    single = client.delete(f"/api/collections/receipts/{rid}", cookies=admin)
    assert batch.status_code == 409 and single.status_code == 409, (batch.text, single.text)
    ad_after = _entity("ads", aid, admin)["data"]
    assert ad_after.get("companyFundingAllocations"), ad_after
    assert _entity("receipts", rid, admin)["deleted"] is False


def test_merge_survives_a_deleted_receipt_in_a_closed_month(staff):
    admin = staff["admin"]
    keep, dup, rid, period = f"r11_keep_{TAG}", f"r11_dup_{TAG}", f"r11_mrcpt_{TAG}", "2017-05"
    shared_phone = f"09{secrets.randbelow(10**8):08d}"  # merge requires a shared phone number
    _create("customers", keep, {"name": keep, "phones": [shared_phone]}, admin)
    with db_conn() as conn:  # the create route refuses a duplicate phone: seed the duplicate like the merge tests do
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('customers',:id,:d,false,:t,:o,:t)"),
                     {"id": dup, "t": now_ms(), "o": staff["admin_id"], "d": json_dumps({"id": dup, "name": dup, "phones": [shared_phone]})})
    _unpaid_receipt(rid, dup, 30, admin, date=f"{period}-10")
    deleted = client.delete(f"/api/collections/receipts/{rid}", cookies=admin)
    assert deleted.status_code == 200, deleted.text
    closed = client.post("/api/admin/operations/financial-periods/close", json={"period": period, "forceReason": "round eleven merge"}, cookies=admin)
    assert closed.status_code == 200, closed.text
    try:
        k, d = _entity("customers", keep, admin), _entity("customers", dup, admin)
        op = {"keepCustomerId": keep, "duplicateCustomerId": dup, "expectedKeepLastModified": k["lastModified"],
              "expectedDuplicateLastModified": d["lastModified"], "idempotencyKey": f"merge-r11-{TAG}"}
        merged = client.post("/api/customers/merge", json=op, cookies=admin)
        assert merged.status_code == 200, merged.text
    finally:
        client.post(f"/api/admin/operations/financial-periods/{period}/unlock", json={"reason": "round eleven cleanup"}, cookies=admin)


def test_a_receipt_for_a_deleted_customer_is_refused(staff):
    admin = staff["admin"]
    cid = f"r11_gone_{TAG}"
    _customer(cid, admin)
    gone = client.delete(f"/api/collections/customers/{cid}", cookies=admin)
    assert gone.status_code == 200, gone.text
    r = client.post("/api/collections/receipts", json={"id": f"r11_ghost_{TAG}", "data": {
        "recordType": "receipt", "customerId": cid, "amountUSD": 10, "amountLocal": 50, "exchangeRate": 5,
        "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office", "statusDetail": {"notPaidCollection": "office"}}}, cookies=admin)
    assert r.status_code == 409 and "deleted" in r.text, r.text


def test_a_receipt_cannot_be_repointed_to_a_deleted_customer(staff):
    admin = staff["admin"]
    live, gone, rid = f"r11_live_{TAG}", f"r11_gone2_{TAG}", f"r11_rrcpt_{TAG}"
    _customer(live, admin); _customer(gone, admin); _unpaid_receipt(rid, live, 10, admin)
    assert client.delete(f"/api/collections/customers/{gone}", cookies=admin).status_code == 200
    receipt = _entity("receipts", rid, admin)
    r = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"customerId": gone}, "expectedLastModified": receipt["lastModified"]}, cookies=admin)
    assert r.status_code == 409 and "deleted" in r.text, r.text


def test_a_funded_ad_cannot_be_repointed_by_a_plain_patch(staff):
    admin = staff["admin"]
    a, b, rid, aid = f"r11_a_{TAG}", f"r11_b_{TAG}", f"r11_frcpt_{TAG}", f"r11_fad_{TAG}"
    _customer(a, admin); _customer(b, admin); _unpaid_receipt(rid, a, 100, admin); _ad_due(aid, a, rid, 100, admin)
    ad = _entity("ads", aid, admin)
    r = client.patch(f"/api/collections/ads/{aid}", json={"data": {"customerId": b}, "expectedLastModified": ad["lastModified"]}, cookies=admin)
    assert r.status_code == 405, r.text
    assert _entity("ads", aid, admin)["data"]["customerId"] == a


def test_a_driver_with_open_jobs_cannot_be_deleted(staff):
    admin = staff["admin"]
    cid, rid = f"r11_dcust_{TAG}", f"r11_drcpt_{TAG}"
    _customer(cid, admin)
    _create("receipts", rid, {"recordType": "receipt", "customerId": cid, "amountUSD": 20, "amountLocal": 100, "exchangeRate": 5,
                              "status": "Not Paid", "isPaid": False, "deliveryStatus": "Needs Delivery",
                              "deliveryPersonId": staff["driver_id"], "deliveryFee": 5,
                              "statusDetail": {"notPaidCollection": "delivery"}}, admin)
    r = client.patch(f"/api/users/{staff['driver_id']}", json={"deleted": True}, cookies=admin)
    assert r.status_code == 409 and "open delivery jobs" in r.text, r.text


# ---------------------------------------------------------------- subscriptions

def test_purchase_refuses_a_price_the_customer_did_not_see(staff):
    listing = client.get("/api/subscriptions/plans", cookies=staff["admin"])
    assert listing.status_code == 200, listing.text
    body = listing.json()
    catalog = body if isinstance(body, list) else (body.get("plans") or [])
    priced = [p for p in catalog if int(p.get("priceMinor") or 0) > 0]
    if not priced:
        pytest.skip("no priced plan in the catalog")
    plan = priced[0]
    r = client.post("/api/subscriptions/purchase",
                    json={"planId": plan["id"], "idempotencyKey": f"r11-price-{TAG}", "expectedPriceMinor": int(plan["priceMinor"]) + 1},
                    cookies=staff["admin"])
    assert r.status_code == 409 and "price changed" in r.text.lower(), r.text
