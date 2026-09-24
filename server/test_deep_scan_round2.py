"""Round-2 deep-scan regressions (2026-09-18): permissions, Meta sync, pool use, ops.

Disposable local records only. The suite shares one in-memory database, so
every record here carries a per-run tag and the test month closure is removed
again afterwards.
"""

import hashlib
import hmac
import json
import secrets
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as social_studio
from server import monitoring, operations, wallet_payments
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(main.app, headers={"Origin": "http://testserver"}, client=("192.0.2.88", 50000))
PW = "RoundTwoPassword123!"
TAG = secrets.token_hex(4)


def _phone():
    return "091" + str(secrets.randbelow(10_000_000)).zfill(7)


def _seed_admin():
    init_db()
    pw = hash_password(PW, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    uid = new_id("user")
    email = f"r2-admin-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
            ),
            {"id": uid, "name": "R2 Admin", "email": email, "perm": json_dumps({}),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "now": now},
        )
    return uid, email


def _login(email, password=PW):
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, f"login {email}: {response.status_code} {response.text[:200]}"
    token = response.cookies.get("albayan_session")
    client.cookies.clear()
    return {"albayan_session": token}


def _mk_user(admin, name, role, perms):
    email = f"r2-{name.lower()}-{TAG}@tests.albayanhub.com"
    response = client.post(
        "/api/users",
        json={"name": name, "email": email, "password": PW, "role": role, "permissions": perms},
        cookies=admin,
    )
    assert response.status_code == 200, f"create {name}: {response.status_code} {response.text[:200]}"
    return {"id": response.json()["id"], "email": email, "cookies": _login(email)}


def _receipt(admin, customer_id, driver_id):
    response = client.post("/api/collections/receipts", json={"data": {
        "customerId": customer_id, "status": "Not Paid", "deliveryStatus": "Needs Delivery",
        "deliveryPersonId": driver_id, "amountLocal": 100, "amountUSD": 20, "exchangeRate": 5,
        "statusDetail": {"notPaidCollection": "delivery"},
    }}, cookies=admin)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def ctx():
    admin_id, admin_email = _seed_admin()
    admin = _login(admin_email)
    delivery_perms = {"deliveries": ["viewOwn", "accept", "complete", "markCollected"]}
    driver_a = _mk_user(admin, "DriverA", "Delivery", {
        **delivery_perms, "ads": ["viewOwn", "add"],
        "customers": ["viewOwn", "viewContacts", "edit"], "receipts": ["delete"],
    })
    driver_b = _mk_user(admin, "DriverB", "Delivery", {**delivery_perms, "ads": ["viewOwn"]})
    emp_reset = _mk_user(admin, "EmpReset", "Employee", {"users": ["resetPassword"]})
    emp_power = _mk_user(admin, "EmpPower", "Employee", {
        "receipts": ["view", "edit", "delete"], "auditLogs": ["view"], "users": ["view", "managePermissions"],
    })
    emp_plain = _mk_user(admin, "EmpPlain", "Employee", {})
    emp_rec = _mk_user(admin, "EmpRec", "Employee", {"receipts": ["view", "edit"]})
    emp_role = _mk_user(admin, "EmpRole", "Employee", {"users": ["changeRole", "edit"]})
    c1 = client.post("/api/collections/customers", json={"data": {"name": f"R2 Cust One {TAG}", "phone": _phone()}}, cookies=admin)
    c2 = client.post("/api/collections/customers", json={"data": {"name": f"R2 Cust Two {TAG}", "phone": _phone()}}, cookies=admin)
    assert c1.status_code == 200 and c2.status_code == 200, (c1.text, c2.text)
    r_b = _receipt(admin, c1.json()["id"], driver_b["id"])          # driver B's job for customer 1
    r_a = _receipt(admin, c1.json()["id"], driver_a["id"])          # driver A's job for customer 1
    r_edit = _receipt(admin, c2.json()["id"], driver_b["id"])
    return dict(admin=admin, admin_id=admin_id, driver_a=driver_a, driver_b=driver_b, emp_reset=emp_reset,
                emp_power=emp_power, emp_plain=emp_plain, emp_rec=emp_rec, emp_role=emp_role,
                c1=c1.json(), c2=c2.json(), r_b=r_b, r_a=r_a, r_edit=r_edit)


# ---------------------------------------------------------------- permissions

def test_driver_cannot_delete_another_drivers_receipt(ctx):
    driver = ctx["driver_a"]["cookies"]
    foreign = ctx["r_b"]["id"]
    assert client.get(f"/api/collections/receipts/{foreign}", cookies=driver).status_code == 403
    assert client.delete(f"/api/collections/receipts/{foreign}", cookies=driver).status_code == 403
    batch = client.post("/api/batch/delete", json={"items": [{"collection": "receipts", "id": foreign}]}, cookies=driver)
    assert batch.status_code == 403, batch.text
    assert client.get(f"/api/collections/receipts/{foreign}", cookies=ctx["admin"]).status_code == 200


def test_driver_generic_ad_create_stays_inside_assignment(ctx):
    driver = ctx["driver_a"]["cookies"]
    body = {"customerId": ctx["c1"]["id"], "adName": f"Rogue {TAG}", "status": "Active",
            "paymentStatus": "paid", "collectionMethod": "office",
            "deliveryStatus": "Needs Delivery", "deliveryPersonId": ctx["driver_b"]["id"]}
    rogue = client.post("/api/collections/ads", json={"id": f"ad_rogue_{TAG}", "data": body}, cookies=driver)
    assert rogue.status_code == 403, rogue.text
    own = client.post("/api/collections/ads", json={"id": f"ad_own_{TAG}", "data": {**body, "deliveryPersonId": ctx["driver_a"]["id"]}}, cookies=driver)
    assert own.status_code == 200, own.text


def test_driver_can_edit_only_customers_referenced_by_their_deliveries(ctx):
    driver = ctx["driver_a"]["cookies"]
    referenced = ctx["c1"]["id"]
    unreferenced = ctx["c2"]["id"]
    ok = client.patch(f"/api/collections/customers/{referenced}", json={"data": {"notes": f"seen by driver {TAG}"}}, cookies=driver)
    assert ok.status_code == 200, ok.text
    blocked = client.patch(f"/api/collections/customers/{unreferenced}", json={"data": {"name": "Hijacked"}}, cookies=driver)
    assert blocked.status_code == 403, blocked.text
    assert client.get(f"/api/collections/customers/{unreferenced}", cookies=ctx["admin"]).json()["data"]["name"] != "Hijacked"


def test_reset_password_cannot_take_over_a_more_powerful_colleague(ctx):
    actor = ctx["emp_reset"]["cookies"]
    powerful = ctx["emp_power"]
    blocked = client.patch(f"/api/users/{powerful['id']}", json={"password": "Taken0ver!Secure99"}, cookies=actor)
    assert blocked.status_code == 403, blocked.text
    assert client.post("/api/auth/login", json={"email": powerful["email"], "password": "Taken0ver!Secure99"}).status_code == 401
    # A colleague who holds nothing the actor lacks can still be helped.
    allowed = client.patch(f"/api/users/{ctx['emp_plain']['id']}", json={"password": "Helped0ut!Secure99"}, cookies=actor)
    assert allowed.status_code == 200, allowed.text
    assert client.post("/api/auth/login", json={"email": ctx["emp_plain"]["email"], "password": "Helped0ut!Secure99"}).status_code == 200
    client.cookies.clear()


def test_reset_password_tolerates_legacy_rows_and_allows_drivers(ctx):
    actor = ctx["emp_reset"]["cookies"]
    # A colleague whose stored permissions carry a retired module name must
    # not turn the check into a 500; with nothing the actor lacks it succeeds.
    legacy = _mk_user(ctx["admin"], "EmpLegacy", "Employee", {})
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET permissions_json=:p WHERE id=:id"),
                     {"p": json_dumps({"retiredModule": ["view"], "receipts": ["view"]}), "id": legacy["id"]})
    grant = client.patch(f"/api/users/{ctx['emp_reset']['id']}", json={"permissions": {"users": ["resetPassword"], "receipts": ["view"]}}, cookies=ctx["admin"])
    assert grant.status_code == 200, grant.text
    actor = _login(ctx["emp_reset"]["email"])
    response = client.patch(f"/api/users/{legacy['id']}", json={"password": "LegacyReset!Secure99"}, cookies=actor)
    assert response.status_code == 200, response.text
    # Delivery accounts are exempt: their grants are scoped to their own jobs.
    driver = client.patch(f"/api/users/{ctx['driver_b']['id']}", json={"password": "DriverReset!Secure99"}, cookies=actor)
    assert driver.status_code == 200, driver.text
    assert client.post("/api/auth/login", json={"email": ctx["driver_b"]["email"], "password": "DriverReset!Secure99"}).status_code == 200
    client.cookies.clear()


def test_driver_may_still_create_an_unassigned_receipt(ctx):
    driver = _mk_user(ctx["admin"], "DriverC", "Delivery", {"deliveries": ["viewOwn"], "receipts": ["add"]})
    response = client.post("/api/collections/receipts", json={"data": {
        "customerId": ctx["c1"]["id"], "status": "Paid", "isPaid": True, "amountUSD": 5, "amountLocal": 25,
        "exchangeRate": 5, "deliveryStatus": "Office",
    }}, cookies=driver["cookies"])
    assert response.status_code == 200, response.text
    foreign = client.post("/api/collections/receipts", json={"data": {
        "customerId": ctx["c1"]["id"], "status": "Not Paid", "deliveryStatus": "Needs Delivery",
        "deliveryPersonId": ctx["driver_b"]["id"], "amountUSD": 5, "amountLocal": 25, "exchangeRate": 5,
        "statusDetail": {"notPaidCollection": "delivery"},
    }}, cookies=driver["cookies"])
    assert foreign.status_code == 403, foreign.text


def test_nobody_changes_their_own_role(ctx):
    me = ctx["emp_role"]
    response = client.patch(f"/api/users/{me['id']}", json={"role": "Delivery"}, cookies=me["cookies"])
    assert response.status_code == 403, response.text
    assert client.get("/api/auth/me", cookies=me["cookies"]).json()["role"] == "Employee"


def test_plain_edit_grant_cannot_hand_a_delivery_to_a_non_driver(ctx):
    editor = ctx["emp_rec"]
    rid = ctx["r_edit"]["id"]
    bad = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"deliveryPersonId": editor["id"]}}, cookies=editor["cookies"])
    assert bad.status_code == 400, bad.text
    good = client.patch(f"/api/collections/receipts/{rid}", json={"data": {"deliveryPersonId": ctx["driver_a"]["id"]}}, cookies=editor["cookies"])
    assert good.status_code == 200, good.text
    assert good.json()["data"]["deliveryPersonId"] == ctx["driver_a"]["id"]


# ---------------------------------------------------------------- pool / DB hygiene

def test_temp_receipt_counter_never_opens_a_second_connection(ctx, monkeypatch):
    real = main.db_conn
    depth = {"now": 0, "max": 0}

    @contextmanager
    def counted():
        depth["now"] += 1
        depth["max"] = max(depth["max"], depth["now"])
        try:
            with real() as conn:
                yield conn
        finally:
            depth["now"] -= 1

    monkeypatch.setattr(main, "db_conn", counted)
    number = main._next_temp_delivery_receipt_no(ctx["admin_id"])
    assert number.startswith("D")
    assert depth["max"] == 1


def test_receipt_number_scan_reuses_the_open_transaction(ctx):
    serial = f"S{700000 + secrets.randbelow(200000)}"
    created = client.post("/api/collections/receipts", json={"data": {
        "customerId": ctx["c1"]["id"], "status": "Paid", "isPaid": True, "amountUSD": 10,
        "amountLocal": 50, "exchangeRate": 5, "serialNumber": serial, "deliveryStatus": "Office",
    }}, cookies=ctx["admin"])
    assert created.status_code == 200, created.text
    with db_conn() as conn:
        assert main._receipt_number_exists(serial, conn=conn) is True
        assert main._receipt_number_exists(serial, exclude_id=created.json()["id"], conn=conn) is False
        assert main._receipt_number_exists(f"{serial}X", conn=conn) is False
    assert main._receipt_number_exists(serial) is True


def test_latest_rate_accepts_the_callers_connection():
    with db_conn() as conn:
        inside = wallet_payments.latest_usd_lyd_rate(conn)
    outside = wallet_payments.latest_usd_lyd_rate()
    assert inside == outside


def test_campaign_holds_are_filtered_in_sql():
    uid = f"r2-holds-{TAG}"
    stamp = now_ms()
    with db_conn() as conn:
        for cid, status, budget in ((f"cr_sub_{TAG}", "Submitted", 5000), (f"cr_draft_{TAG}", "Draft", 9000), (f"cr_sub2_{TAG}", "Submitted", 250)):
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES ('adCampaignRequests',:id,:data,false,:t,:uid,:t)"),
                {"id": cid, "data": json_dumps({"id": cid, "status": status, "budgetMinorUSD": budget}), "t": stamp, "uid": uid},
            )
        assert wallet_payments.wallet_campaign_holds_minor(conn, uid) == 5250


def test_month_snapshot_rows_carry_no_inline_photos(ctx):
    photo = "data:image/png;base64," + "A" * 400
    created = client.post("/api/collections/receipts", json={"data": {
        "customerId": ctx["c1"]["id"], "status": "Paid", "isPaid": True, "amountUSD": 12,
        "amountLocal": 60, "exchangeRate": 5, "deliveryStatus": "Office", "photos": [photo],
    }}, cookies=ctx["admin"])
    assert created.status_code == 200, created.text
    rows = {row["id"]: row for row in operations._entity_rows("receipts")}
    row = rows[created.json()["id"]]
    assert row["amountUSD"] == 12
    assert "photos" not in row


# ---------------------------------------------------------------- startup / monitoring

def test_init_db_retries_a_briefly_unreachable_database(monkeypatch):
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("connection refused")

    monkeypatch.setattr(main, "init_db", flaky)
    main._init_db_with_retry(attempts=5, delay_seconds=0)
    assert calls["n"] == 3

    def always():
        raise RuntimeError("still down")

    monkeypatch.setattr(main, "init_db", always)
    with pytest.raises(RuntimeError):
        main._init_db_with_retry(attempts=2, delay_seconds=0)


def test_health_probes_are_not_counted_as_traffic():
    before = monitoring.get_metrics()["total_requests"]
    assert client.get("/api/health/live").status_code == 200
    assert client.get("/api/health/ready").status_code == 200
    assert monitoring.get_metrics()["total_requests"] == before
    ready = client.get("/api/health/ready").json()
    assert ready["dialect"] == "sqlite"


def test_recent_error_rate_forgets_old_incidents():
    monitor = monitoring.ApplicationMonitor(log_file="", sample_size=20)
    for _ in range(10):
        monitor.observe_request(500, 1.0)
    assert monitor.get_metrics()["recent_error_rate"] == 1.0
    for _ in range(20):
        monitor.observe_request(200, 1.0)
    metrics = monitor.get_metrics()
    assert metrics["recent_error_rate"] == 0.0
    assert metrics["recent_sample_size"] == 20
    assert metrics["error_rate"] > 0  # the cumulative figure still tells the history


# ---------------------------------------------------------------- Meta sync

def _insert_entity(entity_type, entity_id, data, created_by=None):
    stamp = now_ms()
    payload = {"id": entity_id, "_created": stamp, "_lastModified": stamp, "_deleted": False, **data}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:by,:stamp)"),
            {"type": entity_type, "id": entity_id, "data": json_dumps(payload), "stamp": stamp, "by": created_by},
        )
    return stamp


def _read_entity(entity_type, entity_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json,last_modified FROM entities WHERE type=:t AND id=:i"),
                           {"t": entity_type, "i": entity_id}).mappings().first()
    return json_loads(row["data_json"]), int(row["last_modified"])


def _delete_entities(*ids):
    with db_conn() as conn:
        for entity_id in ids:
            conn.execute(text("DELETE FROM entities WHERE id=:i"), {"i": entity_id})


def _meta_snapshot(meta_ad_id, **extra):
    base = {
        "metaLinkState": "linked", "metaLinkVersion": 1, "metaAdId": meta_ad_id,
        "metaAdName": f"Ad {meta_ad_id}", "metaAdSetId": "555555555555555", "metaAdSetName": "Set",
        "metaCampaignId": "666666666666666", "metaCampaignName": "Camp", "metaCreativeId": "",
        "metaThumbnailUrl": "", "metaThumbnailSource": "", "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
        "metaMediaResolvedAt": "2026-09-18T10:00:00Z", "metaMediaTrace": "",
        "metaPageId": "777777777777777", "metaPageName": "Client Page", "metaPageCategory": "Shop",
        "metaPagePictureUrl": "", "metaAdAccountId": "444444444444444", "metaAdAccountName": "Albayan Business",
        "metaCurrency": "USD", "metaConfiguredStatus": "ACTIVE", "metaEffectiveStatus": "ACTIVE",
        "metaAdSetStatus": "ACTIVE", "metaCampaignStatus": "ACTIVE", "metaObjective": "MESSAGES",
        "metaBudgetSource": "adset", "metaDailyBudgetMinor": 500, "metaLifetimeBudgetMinor": 0,
        "metaTotalBudgetMinor": 5000, "metaTotalBudgetKind": "estimated_daily", "metaBudgetRemainingMinor": 0,
        "metaTotalRemainingBudgetMinor": 5000, "metaStartTime": "2026-09-10T00:00:00Z",
        "metaEndTime": "2026-09-20T00:00:00Z", "metaDurationDays": 10, "metaAdCreatedTime": "2026-09-10T00:00:00Z",
        "metaAdUpdatedTime": "2026-09-10T00:00:00Z", "metaSpend": 0.0, "metaSpendMinor": 0, "metaReach": 0,
        "metaImpressions": 0, "metaClicks": 0, "metaPrimaryResultType": "", "metaPrimaryResultValue": 0.0,
        "metaActions": [], "metaSyncedAt": "2026-09-18T10:00:00Z", "metaLastAttemptAt": "2026-09-18T10:00:00Z",
        "metaSyncError": "", "metaSyncErrorCode": "", "metaSyncFailureCount": 0,
        "metaNextSyncAt": now_ms() + 900_000, "metaUnlinkedAt": "",
    }
    base.update(extra)
    return base


class _FakeMetaClient:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def get_ad_snapshot(self, meta_ad_id):
        self.calls.append(str(meta_ad_id))
        if self.error is not None:
            raise self.error
        return _meta_snapshot(str(meta_ad_id))


@pytest.fixture
def meta_env(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "test-token")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "444444444444444")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_refresh_meta_provider_state", lambda *a, **k: None)
    yield


def _meta_config(batch):
    return meta_ads.MetaAdsConfig(
        access_token="t", app_secret="", graph_version="v25.0",
        allowed_account_ids=("444444444444444",), background_sync=False,
        sync_interval_minutes=15, sync_batch_size=batch, request_timeout_seconds=15,
    )


@pytest.fixture
def closed_month_ads(meta_env):
    closed_id = f"ad_closed_{TAG}"
    open_id = f"ad_open_{TAG}"
    closure_id = f"financial-close-2026-06"
    _insert_entity("ads", closed_id, {
        "recordType": "ad", "status": "Stopped", "startDate": "2026-06-15", "amountUSD": 50, "spentUSD": 50,
        "metaAdId": "911111111111111", "metaAdAccountId": "444444444444444", "metaNextSyncAt": 0,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION, "metaSyncedAt": "2026-06-16T00:00:00Z",
    })
    _insert_entity("ads", open_id, {
        "recordType": "ad", "status": "Active", "startDate": "2026-09-10", "amountUSD": 50,
        "metaAdId": "922222222222222", "metaAdAccountId": "444444444444444", "metaNextSyncAt": 1,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION, "metaSyncedAt": "2026-09-17T00:00:00Z",
    })
    _insert_entity("financialClosures", closure_id, {"period": "2026-06", "status": "closed"})
    try:
        yield closed_id, open_id
    finally:
        _delete_entities(closed_id, open_id, closure_id)


def test_closed_month_ad_is_parked_and_the_queue_moves_on(closed_month_ads, monkeypatch):
    closed_id, _open_id = closed_month_ads
    fake = _FakeMetaClient()
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", lambda: _meta_config(50))
    _before, version_before = _read_entity("ads", closed_id)
    for _ in range(3):
        meta_ads._sync_due_meta_ads_unlocked()
    after, version_after = _read_entity("ads", closed_id)
    assert fake.calls.count("911111111111111") == 1          # asked once, then parked
    assert "922222222222222" in fake.calls                     # the live ad got its turn
    assert version_after == version_before                     # parked without a version bump
    assert int(after["metaNextSyncAt"]) > now_ms() + 29 * 86_400_000


def test_closed_month_ad_failure_does_not_abort_the_batch(closed_month_ads, monkeypatch):
    fake = _FakeMetaClient(error=meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True))
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", lambda: _meta_config(50))
    meta_ads._sync_due_meta_ads_unlocked()                     # used to raise HTTP 423
    assert "911111111111111" in fake.calls and "922222222222222" in fake.calls


def test_worker_respects_the_discovery_interval_when_discovery_fails(meta_env, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_DISCOVERY_INTERVAL_SECONDS", "60")
    monkeypatch.setenv("ALBAYAN_META_AUTO_IMPORT", "true")
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    discovery_calls = []
    sync_calls = []

    def failing_discovery(**kwargs):
        discovery_calls.append(kwargs)
        raise meta_ads.MetaAdsError("discovery_failed", "Meta authorization failed.", retryable=True)

    monkeypatch.setattr(meta_ads, "discover_meta_ads", failing_discovery)
    monkeypatch.setattr(meta_ads, "sync_due_meta_ads", lambda *a, **k: sync_calls.append(1))
    # The funds read (worker, since d7d627e) would call Meta; a stamp left by an earlier test plus the fake
    # clock below would make it wait for days. Neither belongs to this test.
    monkeypatch.setattr(meta_ads, "_maybe_refresh_meta_funds", lambda: None)
    monkeypatch.setattr(meta_ads, "_META_LAST_REMOTE_REQUEST_MONOTONIC", 0.0)
    clock = {"t": 1000.0, "ticks": 0}
    monkeypatch.setattr(meta_ads.time, "monotonic", lambda: clock["t"])

    class FakeStop:
        def is_set(self):
            return clock["ticks"] >= 10

        def wait(self, seconds):
            clock["t"] += float(seconds)
            clock["ticks"] += 1
            return self.is_set()

    meta_ads._worker_loop(FakeStop(), "2026-09-18T00:00:00Z")
    assert len(discovery_calls) == 1
    assert len(sync_calls) >= 1


def test_page_comment_webhook_does_not_trigger_ad_discovery(meta_env, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret")
    discovery_calls = []
    social_calls = []
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *a, **k: discovery_calls.append((a, k)) or {})
    monkeypatch.setattr(social_studio, "handle_meta_webhook", lambda payload: social_calls.append(payload) or 0)
    raw = json.dumps({"object": "page", "entry": [{"id": "777777777777777", "time": 1, "changes": [
        {"field": "feed", "value": {"item": "comment", "verb": "add", "comment_id": "1_2"}}]}]}).encode("utf-8")
    signature = "sha256=" + hmac.new(b"app-secret", raw, hashlib.sha256).hexdigest()
    response = client.post("/api/meta-ads/webhook", content=raw,
                           headers={"X-Hub-Signature-256": signature, "Content-Type": "application/json"})
    assert response.status_code == 200, response.text
    assert len(social_calls) == 1
    assert discovery_calls == []


def test_unreadable_results_are_not_recorded_as_a_zero_spend_sync(meta_env):
    row = {"id": "933333333333333", "name": "New client ad", "effectiveStatus": "ACTIVE",
           "pageId": "777777777777777", "pageName": "Client Page", "createdTime": "2026-09-18T09:00:00Z"}
    pending = meta_ads._pending_meta_snapshot(
        row, "444444444444444", meta_ads.MetaAdsError("pending_enrichment", "loading", retryable=True), "USD")
    draft = meta_ads.import_meta_ad_draft(pending)
    try:
        assert not draft["data"].get("metaSyncedAt")
        snap = _meta_snapshot("933333333333333", metaSyncedAt="2026-09-18T10:05:00Z",
                              metaSpend=0.0, metaSpendMinor=0, _insightsUnavailable=True)
        entity, _, _ = meta_ads.apply_meta_snapshot(
            draft["id"], snap, actor_id=None, actor_name="Meta automatic sync",
            expected_last_modified=None, operation_id=None, action="automatic_sync")
        data = entity["data"]
        assert data["metaSyncedAt"] == ""                      # still "never synced" for money purposes
        assert data["metaSyncErrorCode"] == "insights_unavailable"
        assert data["metaSpendMinor"] == 0
    finally:
        _delete_entities(draft["id"])


def test_month_totals_ignore_non_usd_meta_spend():
    period = "2031-01"
    usd_id, eur_id = f"ad_usd_{TAG}", f"ad_eur_{TAG}"
    _insert_entity("ads", usd_id, {"recordType": "ad", "status": "Active", "startDate": "2031-01-05", "amountUSD": 10, "metaAdId": "944444444444444", "metaSpendMinor": 1200, "metaCurrency": "USD", "customerId": "x", "paymentStatus": "paid"})
    _insert_entity("ads", eur_id, {"recordType": "ad", "status": "Active", "startDate": "2031-01-06", "amountUSD": 10, "metaAdId": "955555555555555", "metaSpendMinor": 30000, "metaCurrency": "EUR", "customerId": "x", "paymentStatus": "paid"})
    try:
        snapshot = operations._period_snapshot(period)
        assert snapshot["totals"]["metaSpendUSD"] == 12.0
        assert snapshot["totals"]["adSpendUSD"] == 12.0
    finally:
        _delete_entities(usd_id, eur_id)
