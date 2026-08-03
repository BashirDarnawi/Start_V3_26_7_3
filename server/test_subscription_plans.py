"""Money and catalog tests for subscription plans and bundles."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import SERVICE_SUBSCRIPTION_CATALOG, app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "plans-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "PlansAdmin123!"
CUSTOMER_EMAIL = "plans-customer@tests.albayanhub.com"
CUSTOMER_PASSWORD = "PlansCustomer123!"


def _ensure_admin() -> str:
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        existing = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": ADMIN_EMAIL},
        ).mappings().first()
        if existing:
            return str(existing["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Plans Admin',:email,'Admin',:permissions,:hash,:salt,"
                ":algo,:iterations,false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "permissions": json_dumps({}),
                "hash": password.hash_hex,
                "salt": password.salt_hex,
                "algo": password.algo,
                "iterations": password.iterations,
                "now": now,
            },
        )
    return uid


def _login(email: str, password: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    token = response.cookies.get("albayan_session")
    client.cookies.clear()
    return {"albayan_session": token}


def _fund(admin, user_id: str, amount_minor: int, currency: str, tag: str):
    response = client.post(
        "/api/wallet/top-ups",
        json={
            "userId": user_id,
            "amountMinor": amount_minor,
            "currency": currency,
            "idempotencyKey": f"plans-fund-{tag}",
        },
        cookies=admin,
    )
    assert response.status_code == 200, response.text


def _balance(admin, user_id: str, currency: str) -> int:
    payload = client.get("/api/collections/walletTransactions", cookies=admin).json()
    rows = payload if isinstance(payload, list) else payload.get("items") or []
    total = 0
    for row in rows:
        data = (row.get("data") or {}) if isinstance(row, dict) else {}
        if str(data.get("currency") or "").upper() != currency:
            continue
        amount = int(data.get("amountMinor") or 0)
        if str(data.get("toUserId") or "") == user_id:
            total += amount
        if str(data.get("fromUserId") or "") == user_id:
            total -= amount
    return total


def _subs_for(admin, user_id: str) -> list[dict]:
    payload = client.get("/api/collections/serviceSubscriptions", cookies=admin).json()
    rows = payload if isinstance(payload, list) else payload.get("items") or []
    return [
        (r.get("data") or {}) for r in rows
        if isinstance(r, dict) and str((r.get("data") or {}).get("userId") or "") == user_id
    ]


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin_id = _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    created = client.post(
        "/api/users",
        json={
            "name": "Plans Customer",
            "email": CUSTOMER_EMAIL,
            "password": CUSTOMER_PASSWORD,
            "role": "Employee",
            "permissions": {},
        },
        cookies=admin,
    )
    assert created.status_code == 200, created.text
    customer = _login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD)
    return {
        "admin": admin,
        "admin_id": admin_id,
        "customer": customer,
        "customer_id": created.json()["id"],
    }


def _save_plans(admin, plans: list[dict], exact: bool = False):
    """Save a catalog the way the manager UI does: the FULL current catalog
    with these plans overlaid. ``exact`` sends only what is given (used to
    test that dropping a priced plan is refused)."""
    if not exact:
        current = client.get("/api/admin/subscription-plans", cookies=admin)
        if current.status_code == 200:
            merged = {p["id"]: p for p in current.json()["plans"]}
            for plan in plans:
                merged[plan["id"]] = plan
            plans = list(merged.values())
    return client.put(
        "/api/admin/subscription-plans", json={"plans": plans}, cookies=admin
    )


def _paid_bundle(price_minor: int = 5000) -> dict:
    return {
        "id": "test_bundle",
        "serviceIds": ["clothes_system", "ad_maker"],
        "name": "Test Bundle",
        "nameAr": "باقة الاختبار",
        "priceMinor": price_minor,
        "currency": "LYD",
        "durationDays": 30,
        "badge": "best_value",
        "savingsPct": 20,
        "active": True,
        "sortOrder": 1,
    }


class TestPlanCatalog:
    def test_plans_endpoint_serves_defaults_with_implicit_service_plans(self, actors):
        response = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        assert response.status_code == 200, response.text
        plans = {p["id"]: p for p in response.json()["plans"]}
        for sid in SERVICE_SUBSCRIPTION_CATALOG:
            assert f"svc:{sid}" in plans, f"missing implicit plan for {sid}"
        assert all(p["currency"] == "LYD" for p in plans.values())

    def test_admin_catalog_save_is_validated_and_versioned(self, actors):
        refused = _save_plans(actors["customer"], [_paid_bundle()])
        assert refused.status_code == 403, refused.text

        bad = dict(_paid_bundle())
        bad["serviceIds"] = ["not_a_real_service"]
        rejected = _save_plans(actors["admin"], [bad])
        assert rejected.status_code == 400
        assert "unknown service" in rejected.json()["detail"]

        saved = _save_plans(actors["admin"], [_paid_bundle()])
        assert saved.status_code == 200, saved.text
        assert saved.json()["version"] >= 1

        # Shipped plan ids can never change their service composition.
        mutated = dict(_paid_bundle())
        mutated["serviceIds"] = ["clothes_system"]
        immutable = _save_plans(actors["admin"], [mutated])
        assert immutable.status_code == 400
        assert "cannot change" in immutable.json()["detail"]

        listed = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        plans = {p["id"]: p for p in listed.json()["plans"]}
        assert plans["test_bundle"]["priceMinor"] == 5000
        # The implicit service plans survive an overlay that omits them.
        assert "svc:ad_maker" in plans

    def test_admin_full_catalog_endpoint_is_admin_only_and_includes_archived(self, actors):
        refused = client.get("/api/admin/subscription-plans", cookies=actors["customer"])
        assert refused.status_code == 403, refused.text
        archived = dict(_paid_bundle(5000))
        archived["id"] = "archived_probe"
        archived["active"] = False
        assert _save_plans(actors["admin"], [archived]).status_code == 200
        full = client.get("/api/admin/subscription-plans", cookies=actors["admin"])
        assert full.status_code == 200, full.text
        plans = {p["id"]: p for p in full.json()["plans"]}
        assert plans["archived_probe"]["active"] is False  # manager sees it
        public = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        assert all(p["id"] != "archived_probe" for p in public.json()["plans"])

    def test_concurrent_admin_save_cannot_silently_erase_the_other(self, actors):
        """Two admins editing prices: the stale one is refused, not applied."""
        current = client.get("/api/admin/subscription-plans", cookies=actors["admin"]).json()
        stale_version = int(current["version"])
        plans = [dict(p) for p in current["plans"]]
        # Admin A publishes.
        first = client.put(
            "/api/admin/subscription-plans",
            json={"plans": plans, "expectedVersion": stale_version},
            cookies=actors["admin"],
        )
        assert first.status_code == 200, first.text
        new_version = int(first.json()["version"])
        assert new_version == stale_version + 1
        # Admin B saves from the version they loaded BEFORE A published.
        second = client.put(
            "/api/admin/subscription-plans",
            json={"plans": plans, "expectedVersion": stale_version},
            cookies=actors["admin"],
        )
        assert second.status_code == 409, second.text
        assert "changed" in second.json()["detail"]
        # Reloading and re-saving works.
        retry = client.put(
            "/api/admin/subscription-plans",
            json={"plans": plans, "expectedVersion": new_version},
            cookies=actors["admin"],
        )
        assert retry.status_code == 200, retry.text
        # Omitting the guard stays allowed (older clients keep working).
        legacy = client.put(
            "/api/admin/subscription-plans", json={"plans": plans}, cookies=actors["admin"]
        )
        assert legacy.status_code == 200, legacy.text

    def test_shipped_bundle_is_inactive_until_the_owner_prices_it(self, actors):
        """A zero-priced ACTIVE bundle would give away every service in it."""
        full = client.get("/api/admin/subscription-plans", cookies=actors["admin"]).json()
        shipped = {p["id"]: p for p in full["plans"]}.get("smart_bundle")
        assert shipped is not None, "smart_bundle default disappeared"
        if shipped["priceMinor"] == 0:
            assert shipped["active"] is False, "free bundle must not ship sellable"
        public = client.get("/api/subscriptions/plans", cookies=actors["customer"]).json()
        assert all(p["id"] != "smart_bundle" for p in public["plans"])
        blocked = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "smart_bundle", "idempotencyKey": "plans-freebundle-01"},
            cookies=actors["customer"],
        )
        assert blocked.status_code == 409, blocked.text

    def test_plan_catalog_cannot_be_forged_through_the_generic_route(self, actors):
        """The audited endpoint enforces immutability, versioning and audit."""
        forged = client.post(
            "/api/collections/appSettings",
            json={
                "id": "forged_plan_catalog",
                "data": {
                    "settingKey": "subscriptionPlans",
                    "version": 9_999_999,
                    "plans": [{
                        "id": "svc:ad_maker", "serviceIds": ["ad_maker", "clothes_system"],
                        "name": "Widened", "nameAr": "موسّع", "priceMinor": 1,
                        "currency": "LYD", "durationDays": 30, "active": True, "sortOrder": 1,
                    }],
                },
            },
            cookies=actors["admin"],
        )
        assert forged.status_code == 405, forged.text
        listed = client.get("/api/subscriptions/plans", cookies=actors["customer"]).json()
        ad_maker = {p["id"]: p for p in listed["plans"]}["svc:ad_maker"]
        assert ad_maker["serviceIds"] == ["ad_maker"], "shipped plan composition was widened"

    def test_corrupt_generic_appsettings_record_never_bricks_purchasing(self, actors):
        with db_conn() as conn:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('appSettings',:id,:d,false,:now,:uid,:now)"
                ),
                {
                    "id": new_id("appSet"),
                    "d": json_dumps({
                        "settingKey": "subscriptionPlans",
                        "version": 999_999,
                        "plans": [{"id": "evil", "serviceIds": ["ad_maker"], "priceMinor": "free"}],
                    }),
                    "now": now_ms(),
                    "uid": actors["admin_id"],
                },
            )
        listed = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        assert listed.status_code == 200
        plans = {p["id"]: p for p in listed.json()["plans"]}
        assert "evil" not in plans
        assert "svc:ad_maker" in plans  # fell back, never partially applied


class TestPlanPurchase:
    def test_bundle_mints_one_row_per_service_and_one_payment(self, actors):
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200
        _fund(actors["admin"], actors["customer_id"], 20_000, "LYD", "bundle")
        purchased = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-bundle-001"},
            cookies=actors["customer"],
        )
        assert purchased.status_code == 200, purchased.text
        payload = purchased.json()
        assert len(payload["subscriptions"]) == 2
        services = sorted(s["data"]["serviceId"] for s in payload["subscriptions"])
        assert services == ["ad_maker", "clothes_system"]
        assert payload["payment"]["data"]["amountMinor"] == 5000
        assert payload["payment"]["data"]["currency"] == "LYD"
        for sub in payload["subscriptions"]:
            assert sub["data"]["planId"] == "test_bundle"
            assert sub["data"]["planPriceMinor"] == 5000
            assert sub["data"]["priceMinor"] == 0  # ledger is money truth
            assert sub["data"]["paymentTxId"] == payload["payment"]["id"]
        assert _balance(actors["admin"], actors["customer_id"], "LYD") == 15_000

        replay = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-bundle-001"},
            cookies=actors["customer"],
        )
        assert replay.status_code == 200
        assert len(replay.json()["subscriptions"]) == 2
        assert _balance(actors["admin"], actors["customer_id"], "LYD") == 15_000

        stolen = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-bundle-001"},
            cookies=actors["admin"],
        )
        assert stolen.status_code == 409, stolen.text

    def test_repurchase_extends_from_current_expiry(self, actors):
        renewed = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-bundle-002"},
            cookies=actors["customer"],
        )
        assert renewed.status_code == 200, renewed.text
        assert _balance(actors["admin"], actors["customer_id"], "LYD") == 10_000
        subs = [
            s for s in _subs_for(actors["admin"], actors["customer_id"])
            if s.get("serviceId") == "ad_maker" and s.get("status") == "active"
        ]
        assert len(subs) == 2
        expiries = sorted(str(s.get("expiresAt") or "") for s in subs)
        starts = sorted(str(s.get("startedAt") or "") for s in subs)
        # The renewal row STARTS where the first row expires — no lost days.
        assert starts[1] == expiries[0]

    def test_insufficient_lyd_balance_refuses_before_any_row(self, actors):
        assert _save_plans(
            actors["admin"], [_paid_bundle(5000), {
                "id": "pricey", "serviceIds": ["warehouse"],
                "name": "Pricey", "nameAr": "غالي",
                "priceMinor": 1_000_000, "currency": "LYD", "durationDays": 30,
                "active": True, "sortOrder": 2,
            }]
        ).status_code == 200
        poor = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "pricey", "idempotencyKey": "plans-poor-001"},
            cookies=actors["customer"],
        )
        assert poor.status_code == 409, poor.text
        assert "wallet" in poor.json()["detail"].lower()
        assert all(
            s.get("serviceId") != "warehouse"
            for s in _subs_for(actors["admin"], actors["customer_id"])
        )

    def test_unknown_and_archived_plans_refuse(self, actors):
        unknown = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "nope_plan", "idempotencyKey": "plans-unknown-01"},
            cookies=actors["customer"],
        )
        assert unknown.status_code == 400
        archived = dict(_paid_bundle(5000))
        archived["active"] = False
        assert _save_plans(actors["admin"], [archived]).status_code == 200
        refused = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-archived-01"},
            cookies=actors["customer"],
        )
        assert refused.status_code == 409
        # Restore for later tests.
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200

    def test_legacy_purchase_route_still_works_and_now_renews(self, actors):
        first = client.post(
            "/api/subscriptions/purchase",
            json={"serviceId": "smart_systems", "idempotencyKey": "plans-legacy-001"},
            cookies=actors["customer"],
        )
        assert first.status_code == 200, first.text
        assert first.json()["data"]["serviceId"] == "smart_systems"
        again = client.post(
            "/api/subscriptions/purchase",
            json={"serviceId": "smart_systems", "idempotencyKey": "plans-legacy-002"},
            cookies=actors["customer"],
        )
        assert again.status_code == 200, again.text  # renewal, not 409
        rows = [
            s for s in _subs_for(actors["admin"], actors["customer_id"])
            if s.get("serviceId") == "smart_systems"
        ]
        assert len(rows) == 2

    def test_replay_still_works_after_the_plan_is_archived(self, actors):
        """A committed purchase must stay confirmable even if the plan is
        retired before the client's retry arrives (lost-response window)."""
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200
        _fund(actors["admin"], actors["customer_id"], 6000, "LYD", "replayarchive")
        before = _balance(actors["admin"], actors["customer_id"], "LYD")
        bought = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-archive-replay-01"},
            cookies=actors["customer"],
        )
        assert bought.status_code == 200, bought.text
        archived = dict(_paid_bundle(5000))
        archived["active"] = False
        assert _save_plans(actors["admin"], [archived]).status_code == 200
        replay = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-archive-replay-01"},
            cookies=actors["customer"],
        )
        assert replay.status_code == 200, replay.text
        assert len(replay.json()["subscriptions"]) == 2
        # Replay charges nothing extra; the archive still blocks NEW sales.
        assert _balance(actors["admin"], actors["customer_id"], "LYD") == before - 5000
        fresh = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-archive-fresh-01"},
            cookies=actors["customer"],
        )
        assert fresh.status_code == 409, fresh.text
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200

    def test_corrupt_newest_record_keeps_the_last_valid_prices(self, actors):
        """A forged/broken newest record must never silently make paid plans
        free — the newest VALID catalog keeps selling."""
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200
        with db_conn() as conn:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('appSettings',:id,:d,false,:now,:uid,:now)"
                ),
                {
                    "id": new_id("appSet"),
                    "d": json_dumps({
                        "settingKey": "subscriptionPlans",
                        "version": 10_000_000,
                        "plans": [{"id": "test_bundle", "serviceIds": ["ad_maker"], "priceMinor": "free"}],
                    }),
                    "now": now_ms(),
                    "uid": actors["admin_id"],
                },
            )
        listed = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        plans = {p["id"]: p for p in listed.json()["plans"]}
        assert plans["test_bundle"]["priceMinor"] == 5000, "corrupt record reverted prices to free"
        _fund(actors["admin"], actors["customer_id"], 5000, "LYD", "corruptprice")
        before = _balance(actors["admin"], actors["customer_id"], "LYD")
        bought = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-corrupt-price-01"},
            cookies=actors["customer"],
        )
        assert bought.status_code == 200, bought.text
        assert _balance(actors["admin"], actors["customer_id"], "LYD") == before - 5000

    def test_dropping_a_priced_plan_from_a_save_is_refused(self, actors):
        """Omitting a priced plan would resurrect its free default."""
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200
        other = {
            "id": "other_bundle", "serviceIds": ["warehouse"],
            "name": "Other", "nameAr": "أخرى",
            "priceMinor": 2500, "currency": "LYD", "durationDays": 30,
            "active": True, "sortOrder": 3,
        }
        refused = _save_plans(actors["admin"], [other], exact=True)
        assert refused.status_code == 400, refused.text
        assert "missing" in refused.json()["detail"]
        # Retiring explicitly is fine, and keeps the plan out of the store.
        archived = dict(_paid_bundle(5000))
        archived["active"] = False
        assert _save_plans(actors["admin"], [archived, other]).status_code == 200
        public = client.get("/api/subscriptions/plans", cookies=actors["customer"])
        ids = [p["id"] for p in public.json()["plans"]]
        assert "test_bundle" not in ids and "other_bundle" in ids
        assert _save_plans(actors["admin"], [_paid_bundle(5000), other]).status_code == 200

    def test_member_key_cannot_replay_a_partial_bundle(self, actors):
        """"{idem}:{serviceId}" must not look like a whole purchase group."""
        assert _save_plans(actors["admin"], [_paid_bundle(5000)]).status_code == 200
        _fund(actors["admin"], actors["customer_id"], 10_000, "LYD", "memberkey")
        first = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-memberkey-001"},
            cookies=actors["customer"],
        )
        assert first.status_code == 200, first.text
        crafted = client.post(
            "/api/subscriptions/purchase-plan",
            json={"planId": "test_bundle", "idempotencyKey": "plans-memberkey-001:ad_maker"},
            cookies=actors["customer"],
        )
        # A real, separate purchase (2 rows) — never a 1-row partial replay.
        assert crafted.status_code == 200, crafted.text
        assert len(crafted.json()["subscriptions"]) == 2

    def test_lyd_wallet_charge_requests_are_now_accepted(self, actors):
        created = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 7000,
                "currency": "LYD",
                "method": "adfali",
                "idempotencyKey": "plans-lyd-charge-01",
            },
            cookies=actors["customer"],
        )
        assert created.status_code == 200, created.text
        data = created.json()["data"]
        assert data["currency"] == "LYD"
        # No USD->LYD conversion stamp: the amount already is the LYD cash.
        assert data.get("amountMinorLYD") == 7000
        confirmed = client.post(
            f"/api/wallet/payment-requests/{created.json()['id']}/confirm",
            json={},
            cookies=actors["admin"],
        )
        assert confirmed.status_code == 200, confirmed.text
        euro = client.post(
            "/api/wallet/payment-requests",
            json={
                "amountMinor": 7000,
                "currency": "EUR",
                "method": "adfali",
                "idempotencyKey": "plans-eur-charge-01",
            },
            cookies=actors["customer"],
        )
        assert euro.status_code == 400, euro.text
