"""Adversarial tests for server-authoritative grants, delivery and money flows."""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.requests import Request

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server.db import db_conn, init_db, json_dumps, now_ms
import server.main as main_module
from server.main import (
    SERVICE_SUBSCRIPTION_CATALOG,
    _apply_user_update_atomic,
    _client_ip,
    _reset_confirm_rate_check,
    _wallet_top_up_atomic,
    _wallet_transfer_atomic,
    _ad_mutation_atomic,
    app,
    patch_entity,
)
from server.schemas import AdMutationRequest
from server import rate_limiter
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, hash_token, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "hardening-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "HardeningAdmin123!"


def _ensure_admin() -> str:
    pw = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
            {"email": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Hardening Admin',:email,'Admin',:perms,:hash,:salt,:algo,:iterations,"
                "false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "perms": json_dumps({}),
                "hash": pw.hash_hex,
                "salt": pw.salt_hex,
                "algo": pw.algo,
                "iterations": pw.iterations,
                "now": now,
            },
        )
        return uid


def _login(email: str, password: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _create_user(admin: dict[str, str], *, email: str, role: str = "Employee", permissions=None):
    response = client.post(
        "/api/users",
        json={
            "name": email.split("@")[0],
            "email": email,
            "password": "SecurityUser123!",
            "role": role,
            "permissions": permissions or {},
        },
        cookies=admin,
    )
    assert response.status_code == 200, response.text
    return response.json(), _login(email, "SecurityUser123!")


def _request(peer: str, headers: dict[str, str] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [
                (key.lower().encode("latin1"), value.encode("latin1"))
                for key, value in (headers or {}).items()
            ],
            "client": (peer, 12345),
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin_id = _ensure_admin()
    admin = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    grant_manager, grant_cookies = _create_user(
        admin,
        email="hardening-grants@tests.albayanhub.com",
        permissions={
            "analytics": ["view"],
            "users": ["view", "add", "managePermissions"],
        },
    )
    delivery_manager, delivery_manager_cookies = _create_user(
        admin,
        email="hardening-delivery-manager@tests.albayanhub.com",
        permissions={
            "deliveries": ["view", "assign", "reassign", "accept", "complete", "markCollected"],
        },
    )
    driver, driver_cookies = _create_user(
        admin,
        email="hardening-driver@tests.albayanhub.com",
        role="Delivery",
        permissions={"deliveries": ["view", "viewOwn", "accept", "complete"]},
    )
    wallet_user, wallet_cookies = _create_user(
        admin,
        email="hardening-wallet@tests.albayanhub.com",
    )
    recipient, recipient_cookies = _create_user(
        admin,
        email="hardening-recipient@tests.albayanhub.com",
    )
    concurrent_user, concurrent_cookies = _create_user(
        admin,
        email="hardening-concurrent@tests.albayanhub.com",
    )
    return {
        "admin": admin,
        "admin_user": {"id": admin_id, "role": "Admin"},
        "grant_manager": grant_manager,
        "grant_cookies": grant_cookies,
        "delivery_manager": delivery_manager,
        "delivery_manager_cookies": delivery_manager_cookies,
        "driver": driver,
        "driver_cookies": driver_cookies,
        "wallet_user": wallet_user,
        "wallet_cookies": wallet_cookies,
        "recipient": recipient,
        "recipient_cookies": recipient_cookies,
        "concurrent_user": concurrent_user,
        "concurrent_cookies": concurrent_cookies,
    }


class TestPermissionGrantBoundary:
    @pytest.mark.parametrize(
        "permissions",
        [
            {"futureSuperuser": ["all"]},
            {"analytics": ["view", "becomeAdmin"]},
        ],
    )
    def test_unknown_permissions_are_rejected(self, actors, permissions):
        response = client.post(
            "/api/users",
            json={
                "name": "Unknown Permission",
                "email": f"unknown-{len(json.dumps(permissions))}@tests.albayanhub.com",
                "password": "SecurityUser123!",
                "role": "Employee",
                "permissions": permissions,
            },
            cookies=actors["admin"],
        )
        assert response.status_code == 400

    def test_delegated_manager_cannot_grant_permission_they_lack(self, actors):
        response = client.post(
            "/api/users",
            json={
                "name": "Escalated User",
                "email": "hardening-escalated@tests.albayanhub.com",
                "password": "SecurityUser123!",
                "role": "Employee",
                "permissions": {"auditLogs": ["clear"]},
            },
            cookies=actors["grant_cookies"],
        )
        assert response.status_code == 403
        assert "do not hold" in response.json()["detail"]

    def test_users_add_alone_cannot_create_special_delivery_role(self, actors):
        response = client.post(
            "/api/users",
            json={
                "name": "Unauthorized Driver",
                "email": "hardening-unauthorized-driver@tests.albayanhub.com",
                "password": "SecurityUser123!",
                "role": "Delivery",
                "permissions": {},
            },
            cookies=actors["grant_cookies"],
        )
        assert response.status_code == 403
        assert "changerole" in response.json()["detail"].lower()

    def test_delegated_manager_can_only_grant_held_subset(self, actors):
        response = client.post(
            "/api/users",
            json={
                "name": "Limited User",
                "email": "hardening-limited@tests.albayanhub.com",
                "password": "SecurityUser123!",
                "role": "Employee",
                "permissions": {"analytics": ["view"]},
            },
            cookies=actors["grant_cookies"],
        )
        assert response.status_code == 200, response.text
        assert response.json()["permissions"] == {"analytics": ["view"]}

        escalated_update = client.patch(
            f"/api/users/{response.json()['id']}",
            json={"permissions": {"auditLogs": ["clear"]}},
            cookies=actors["grant_cookies"],
        )
        assert escalated_update.status_code == 403


class TestAuthenticationRateLimitReset:
    def test_success_resets_ip_and_account_login_buckets(self, actors, monkeypatch):
        reset_keys: list[str] = []
        monkeypatch.setattr(rate_limiter, "reset_rate_limit", reset_keys.append)
        monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)

        response = client.post(
            "/api/auth/login",
            json={"email": ADMIN_EMAIL.upper(), "password": ADMIN_PASSWORD},
            headers={"X-Forwarded-For": "198.51.100.7"},
        )
        assert response.status_code == 200, response.text
        assert set(reset_keys) == {
            f"login:198.51.100.7|{ADMIN_EMAIL}",
            f"login:email:{ADMIN_EMAIL}",
        }

    def test_forwarded_ip_is_ignored_unless_proxy_trust_is_explicit(self, monkeypatch):
        request = _request(
            "203.0.113.10",
            {"X-Forwarded-For": "198.51.100.1, 198.51.100.2"},
        )
        monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", False)
        assert _client_ip(request) == "203.0.113.10"
        monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)
        assert _client_ip(request) == "198.51.100.2"

    def test_reset_confirm_uses_per_ip_and_one_way_token_buckets(self, monkeypatch):
        keys: list[str] = []

        def check(key, _maximum, _window):
            keys.append(key)
            return True, 1, 0

        monkeypatch.setattr(rate_limiter, "check_rate_limit", check)
        token = "A-valid-reset-token-that-is-never-a-rate-key"
        token_hash = hash_token(token)
        allowed, wait = _reset_confirm_rate_check(_request("203.0.113.20"), token_hash)
        assert allowed is True and wait == 0
        assert keys == [
            "reset-confirm:ip:203.0.113.20",
            f"reset-confirm:token:{token_hash}",
        ]
        assert all(token not in key for key in keys)

    def test_dev_reset_code_requires_both_flags(self, actors, monkeypatch):
        reset_user_email = "hardening-reset-code@tests.albayanhub.com"
        response = client.post(
            "/api/users",
            json={
                "name": "Reset Code User",
                "email": reset_user_email,
                "password": "SecurityUser123!",
                "role": "Employee",
                "permissions": {},
            },
            cookies=actors["admin"],
        )
        assert response.status_code in {200, 409}
        monkeypatch.setattr(main_module, "_reset_rate_check", lambda *_: (True, 0))
        monkeypatch.setattr(main_module, "PASSWORD_RESET_DEV_RETURN_CODE", True)
        monkeypatch.setattr(main_module, "DEBUG_MODE", False)
        hidden = client.post(
            "/api/auth/password-reset/request", json={"email": reset_user_email}
        )
        assert hidden.status_code == 200
        assert "resetCode" not in hidden.json()
        monkeypatch.setattr(main_module, "DEBUG_MODE", True)
        shown = client.post(
            "/api/auth/password-reset/request", json={"email": reset_user_email}
        )
        assert shown.status_code == 200
        assert len(shown.json().get("resetCode") or "") >= 20

    def test_reset_code_has_exactly_one_concurrent_winner(self, actors, monkeypatch):
        reset_user_email = "hardening-reset-race@tests.albayanhub.com"
        created = client.post(
            "/api/users",
            json={
                "name": "Reset Race User",
                "email": reset_user_email,
                "password": "SecurityUser123!",
                "role": "Employee",
                "permissions": {},
            },
            cookies=actors["admin"],
        )
        assert created.status_code in {200, 409}
        monkeypatch.setattr(main_module, "_reset_rate_check", lambda *_: (True, 0))
        monkeypatch.setattr(main_module, "_reset_confirm_rate_check", lambda *_: (True, 0))
        monkeypatch.setattr(main_module, "PASSWORD_RESET_DEV_RETURN_CODE", True)
        monkeypatch.setattr(main_module, "DEBUG_MODE", True)
        issued = client.post(
            "/api/auth/password-reset/request", json={"email": reset_user_email}
        )
        token = issued.json()["resetCode"]

        def confirm(password: str) -> int:
            return client.post(
                "/api/auth/password-reset/confirm",
                json={"token": token, "newPassword": password},
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(
                executor.map(confirm, ["ResetWinnerOne123!", "ResetWinnerTwo123!"])
            )
        assert sorted(statuses) == [200, 400]

    def test_random_reset_token_is_rejected_before_password_hashing(self, actors, monkeypatch):
        monkeypatch.setattr(main_module, "_reset_confirm_rate_check", lambda *_: (True, 0))
        called = False

        def expensive_hash_must_not_run(*_args, **_kwargs):
            nonlocal called
            called = True
            raise AssertionError("hash_password was called for an unknown token")

        monkeypatch.setattr(main_module, "hash_password", expensive_hash_must_not_run)
        response = client.post(
            "/api/auth/password-reset/confirm",
            json={
                "token": "UnknownButWellFormedResetToken_1234567890",
                "newPassword": "NeverHashed123!",
            },
        )
        assert response.status_code == 400
        assert called is False


class TestAtomicAdminMembership:
    def test_two_concurrent_demotions_leave_one_active_admin(self):
        first_id = "hardening_atomic_admin_one"
        second_id = "hardening_atomic_admin_two"
        now = now_ms()
        password = hash_password("AtomicAdmin123!", iterations=PBKDF2_ITERATIONS_DEFAULT)
        with db_conn() as conn:
            originals = [dict(row) for row in conn.execute(text("SELECT id, role, deleted FROM users")).mappings().all()]
            conn.execute(text("UPDATE users SET role='Employee' WHERE lower(role)='admin' AND deleted=false"))
            conn.execute(
                text("DELETE FROM users WHERE id IN (:first_id,:second_id)"),
                {"first_id": first_id, "second_id": second_id},
            )
            for uid, email in [
                (first_id, "atomic-admin-one@tests.albayanhub.com"),
                (second_id, "atomic-admin-two@tests.albayanhub.com"),
            ]:
                conn.execute(
                    text(
                        "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                        "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                        "VALUES (:id,'Atomic Admin',:email,'Admin','{}',:hash,:salt,:algo,:iterations,"
                        "false,:now,NULL,:now)"
                    ),
                    {
                        "id": uid,
                        "email": email,
                        "hash": password.hash_hex,
                        "salt": password.salt_hex,
                        "algo": password.algo,
                        "iterations": password.iterations,
                        "now": now,
                    },
                )
        try:
            actor = {"id": first_id, "role": "Admin", "permissions_json": "{}"}

            def demote(uid: str) -> int:
                try:
                    _apply_user_update_atomic(
                        uid,
                        {"role": "Employee", "last_modified": now_ms()},
                        actor,
                    )
                    return 200
                except HTTPException as exc:
                    return exc.status_code

            with ThreadPoolExecutor(max_workers=2) as executor:
                statuses = list(executor.map(demote, [first_id, second_id]))
            assert sorted(statuses) == [200, 400]
            with db_conn() as conn:
                active = conn.execute(
                    text(
                        "SELECT COUNT(*) FROM users WHERE id IN (:first_id,:second_id) "
                        "AND lower(role)='admin' AND deleted=false"
                    ),
                    {"first_id": first_id, "second_id": second_id},
                ).scalar()
            assert int(active or 0) == 1
        finally:
            with db_conn() as conn:
                conn.execute(
                    text("DELETE FROM users WHERE id IN (:first_id,:second_id)"),
                    {"first_id": first_id, "second_id": second_id},
                )
                for original in originals:
                    conn.execute(
                        text("UPDATE users SET role=:role, deleted=:deleted WHERE id=:id"),
                        original,
                    )


class TestSafeEntityIds:
    def test_quote_bearing_generic_id_is_rejected_and_not_rewritten(self, actors):
        unsafe_id = "receipt');alert(1)//"
        response = client.post(
            "/api/collections/receipts",
            json={"id": unsafe_id, "data": {"customerName": "Unsafe"}},
            cookies=actors["admin"],
        )
        assert response.status_code == 400
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT id FROM entities WHERE type='receipts' AND id=:id"),
                {"id": unsafe_id},
            ).first()
        assert row is None

    def test_restore_and_bulk_import_reject_unsafe_ids(self, actors, monkeypatch):
        unsafe = "bad'id"
        restored = client.put(
            f"/api/admin/collections/customers/{quote(unsafe, safe='')}/restore",
            json={"data": {"name": "Unsafe"}, "createdAt": now_ms()},
            cookies=actors["admin"],
        )
        assert restored.status_code == 400

        monkeypatch.setattr(main_module, "ENABLE_ONLINE_IMPORT", True)
        imported = client.post(
            "/api/admin/import",
            json={"collections": {"customers": [{"id": unsafe, "name": "Unsafe"}]}},
            cookies=actors["admin"],
        )
        assert imported.status_code == 400

    def test_known_relationship_ids_are_rejected_without_rewriting(self, actors, monkeypatch):
        unsafe = "bad'id"
        created = client.post(
            "/api/collections/securityFixtures",
            json={
                "id": "hardening_unsafe_relationship_create",
                "data": {"nested": {"customerId": unsafe}},
            },
            cookies=actors["admin"],
        )
        assert created.status_code == 400

        safe = client.post(
            "/api/collections/securityFixtures",
            json={
                "id": "hardening_safe_relationship_record",
                "data": {
                    "name": "Relationship baseline",
                    # Opaque nested IDs such as WebAuthn credentials are not
                    # database relationships and must remain accepted.
                    "passkeys": [{"id": "opaque/+credential=" * 10}],
                },
            },
            cookies=actors["admin"],
        )
        assert safe.status_code == 200, safe.text

        patched = client.patch(
            "/api/collections/securityFixtures/hardening_safe_relationship_record",
            json={"data": {"allocations": [{"receiptId": unsafe}]}},
            cookies=actors["admin"],
        )
        restored = client.put(
            "/api/admin/collections/securityFixtures/hardening_unsafe_relationship_restore/restore",
            json={
                "data": {"nested": {"deliveryPersonId": unsafe}},
                "createdAt": now_ms(),
            },
            cookies=actors["admin"],
        )
        monkeypatch.setattr(main_module, "ENABLE_ONLINE_IMPORT", True)
        imported = client.post(
            "/api/admin/import",
            json={
                "collections": {
                    "securityImportFixtures": [
                        {
                            "id": "hardening_unsafe_relationship_import",
                            "customerIds": ["safe_customer", unsafe],
                        }
                    ]
                }
            },
            cookies=actors["admin"],
        )
        assert patched.status_code == restored.status_code == imported.status_code == 400

        unchanged = client.get(
            "/api/collections/securityFixtures/hardening_safe_relationship_record",
            cookies=actors["admin"],
        )
        assert unchanged.status_code == 200
        assert unchanged.json()["data"]["name"] == "Relationship baseline"
        with db_conn() as conn:
            forbidden_rows = conn.execute(
                text(
                    "SELECT id FROM entities WHERE id IN "
                    "('hardening_unsafe_relationship_create', "
                    "'hardening_unsafe_relationship_restore', "
                    "'hardening_unsafe_relationship_import')"
                )
            ).all()
        assert forbidden_rows == []


class TestDeliveryFieldAndTransitionBoundary:
    def test_direct_get_is_assignment_scoped_and_hides_tombstones(self, actors):
        assigned_customer = client.post(
            "/api/collections/customers",
            json={"id": "hardening_driver_customer", "data": {"name": "Assigned"}},
            cookies=actors["admin"],
        )
        guessed_customer = client.post(
            "/api/collections/customers",
            json={"id": "hardening_other_customer", "data": {"name": "Other"}},
            cookies=actors["admin"],
        )
        assigned_receipt = client.post(
            "/api/collections/receipts",
            json={
                "id": "hardening_driver_get_receipt",
                "data": {
                    "customerId": "hardening_driver_customer",
                    "deliveryPersonId": actors["driver"]["id"],
                    "deliveryStatus": "Needs Delivery",
                    "status": "Not Paid",
                },
            },
            cookies=actors["admin"],
        )
        assert assigned_customer.status_code == guessed_customer.status_code == assigned_receipt.status_code == 200

        own_customer = client.get(
            "/api/collections/customers/hardening_driver_customer",
            cookies=actors["driver_cookies"],
        )
        guessed = client.get(
            "/api/collections/customers/hardening_other_customer",
            cookies=actors["driver_cookies"],
        )
        unrelated = client.get(
            "/api/collections/pages/hardening_guessed_page",
            cookies=actors["driver_cookies"],
        )
        assert own_customer.status_code == 200
        assert guessed.status_code == unrelated.status_code == 403

        deleted = client.delete(
            "/api/collections/receipts/hardening_driver_get_receipt",
            cookies=actors["admin"],
        )
        assert deleted.status_code == 200
        driver_tombstone = client.get(
            "/api/collections/receipts/hardening_driver_get_receipt",
            cookies=actors["driver_cookies"],
        )
        admin_tombstone = client.get(
            "/api/collections/receipts/hardening_driver_get_receipt",
            cookies=actors["admin"],
        )
        assert driver_tombstone.status_code == admin_tombstone.status_code == 404

    def test_same_delivery_baseline_allows_exactly_one_concurrent_patch(self, actors):
        created = client.post(
            "/api/collections/receipts",
            json={
                "id": "hardening_concurrent_delivery",
                "data": {"deliveryStatus": "Office", "status": "Not Paid", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert created.status_code == 200, created.text
        assigned = client.patch(
            "/api/collections/receipts/hardening_concurrent_delivery",
            json={
                "data": {
                    "deliveryPersonId": actors["driver"]["id"],
                    "deliveryStatus": "Needs Delivery",
                }
            },
            cookies=actors["delivery_manager_cookies"],
        )
        assert assigned.status_code == 200, assigned.text
        baseline = assigned.json()["lastModified"]

        def accept_delivery():
            try:
                patch_entity(
                    "receipts",
                    "hardening_concurrent_delivery",
                    {"deliveryStatus": "In Progress"},
                    actors["driver"]["id"],
                    expected_last_modified=baseline,
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: accept_delivery(), range(2)))
        assert sorted(responses) == [200, 409]

    def test_delivery_permissions_cannot_set_paid_or_bypass_proof(self, actors):
        created = client.post(
            "/api/collections/receipts",
            json={
                "id": "hardening_delivery_receipt",
                "data": {
                    "deliveryStatus": "Office",
                    "status": "Not Paid",
                    "isPaid": False,
                    "amountLocal": 100,
                    "amountUSD": 20,
                    "debtAmountLocal": 100,
                    "debtAmountUSD": 20,
                },
            },
            cookies=actors["admin"],
        )
        assert created.status_code == 200, created.text

        assigned = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {
                "deliveryPersonId": actors["driver"]["id"],
                "deliveryStatus": "Needs Delivery",
            }},
            cookies=actors["delivery_manager_cookies"],
        )
        assert assigned.status_code == 200, assigned.text

        paid = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"isPaid": True, "status": "Paid"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert paid.status_code == 403

        proofless = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"deliveryStatus": "Delivered"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert proofless.status_code == 403

        accepted = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "client-value"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert accepted.status_code == 200, accepted.text

        forged = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"isPaid": True, "amountUSD": 999999}},
            cookies=actors["driver_cookies"],
        )
        assert forged.status_code == 403

        completed = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={
                "data": {
                    "deliveryStatus": "Delivered",
                    "finalReceiptNo": "880001",
                    "receiptImage": "data:image/png;base64,AAAA",
                    "amountCollectedFromCustomer": 100,
                    "actualDeliveryFeeCollected": 0,
                }
            },
            cookies=actors["driver_cookies"],
        )
        assert completed.status_code == 200, completed.text
        assert completed.json()["data"]["isPaid"] is True

        driver_handover = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"isReceivedInOffice": True}},
            cookies=actors["driver_cookies"],
        )
        assert driver_handover.status_code == 403

        office_handover = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"isReceivedInOffice": True, "receivedInOfficeAt": "now"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert office_handover.status_code == 200, office_handover.text


class TestSyncKeysetAndWatermarks:
    def test_full_keyset_does_not_skip_after_a_mid_load_delete(self, actors):
        collection = "hardeningPagingFixtures"
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type=:type"), {"type": collection})
            for index, created_at in enumerate([500, 400, 300, 200, 100], start=1):
                entity_id = f"hardening_page_{index}"
                conn.execute(
                    text(
                        "INSERT INTO entities "
                        "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                        "VALUES (:type,:id,:data,false,:created_at,:created_by,:last_modified)"
                    ),
                    {
                        "type": collection,
                        "id": entity_id,
                        "data": json_dumps({"id": entity_id, "value": index}),
                        "created_at": created_at,
                        "created_by": actors["admin_user"]["id"],
                        "last_modified": created_at,
                    },
                )

        first = client.get(
            f"/api/collections/{collection}?limit=2", cookies=actors["admin"]
        )
        assert first.status_code == 200, first.text
        assert [item["createdAt"] for item in first.json()] == [500, 400]
        with db_conn() as conn:
            conn.execute(
                text(
                    "UPDATE entities SET deleted=true,last_modified=800 "
                    "WHERE type=:type AND id='hardening_page_1'"
                ),
                {"type": collection},
            )

        seen = [item["id"] for item in first.json()]
        last = first.json()[-1]
        while True:
            page = client.get(
                f"/api/collections/{collection}",
                params={
                    "limit": 2,
                    "before_created_at": last["createdAt"],
                    "before_id": last["id"],
                },
                cookies=actors["admin"],
            )
            assert page.status_code == 200, page.text
            rows = page.json()
            if not rows:
                break
            seen.extend(item["id"] for item in rows)
            last = rows[-1]
        assert seen == [
            "hardening_page_1",
            "hardening_page_2",
            "hardening_page_3",
            "hardening_page_4",
            "hardening_page_5",
        ]

    def test_delta_keyset_is_ascending_and_includes_tombstones(self, actors):
        collection = "hardeningDeltaFixtures"
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type=:type"), {"type": collection})
            for entity_id, modified, deleted in [
                ("hardening_delta_b", 6000, False),
                ("hardening_delta_a", 6000, True),
                ("hardening_delta_c", 7000, False),
            ]:
                conn.execute(
                    text(
                        "INSERT INTO entities "
                        "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                        "VALUES (:type,:id,:data,:deleted,1,:created_by,:modified)"
                    ),
                    {
                        "type": collection,
                        "id": entity_id,
                        "data": json_dumps({"id": entity_id}),
                        "deleted": deleted,
                        "created_by": actors["admin_user"]["id"],
                        "modified": modified,
                    },
                )
        first = client.get(
            f"/api/collections/{collection}",
            params={"updated_since": 6000, "limit": 2},
            cookies=actors["admin"],
        )
        assert first.status_code == 200, first.text
        assert [(row["lastModified"], row["id"]) for row in first.json()] == [
            (6000, "hardening_delta_a"),
            (6000, "hardening_delta_b"),
        ]
        assert first.json()[0]["deleted"] is True
        last = first.json()[-1]
        second = client.get(
            f"/api/collections/{collection}",
            params={
                "updated_since": 6000,
                "limit": 2,
                "after_last_modified": last["lastModified"],
                "after_id": last["id"],
            },
            cookies=actors["admin"],
        )
        assert [(row["lastModified"], row["id"]) for row in second.json()] == [
            (7000, "hardening_delta_c")
        ]

    def test_driver_watermarks_are_visibility_scoped(self, actors):
        response = client.get("/api/sync/watermarks", cookies=actors["driver_cookies"])
        assert response.status_code == 200, response.text
        watermarks = response.json()["watermarks"]
        assert "pages" not in watermarks
        assert "clothesProducts" not in watermarks
        assert "exchangeRateHistory" in watermarks
        with db_conn() as conn:
            rows = conn.execute(
                text("SELECT data_json,last_modified FROM entities WHERE type='receipts'")
            ).mappings().all()
        expected = max(
            [
                int(row["last_modified"])
                for row in rows
                if str((json.loads(row["data_json"]) or {}).get("deliveryPersonId") or "")
                == actors["driver"]["id"]
            ]
            or [0]
        )
        assert watermarks["receipts"] == expected


class TestAtomicWalletOperations:
    def test_top_up_transfer_idempotency_balance_and_immutability(self, actors):
        top_up_payload = {
            "userId": actors["wallet_user"]["id"],
            "amountMinor": 2_000,
            "currency": "LYD",
            "idempotencyKey": "hardening-topup-001",
        }
        first = client.post("/api/wallet/top-ups", json=top_up_payload, cookies=actors["admin"])
        retry = client.post("/api/wallet/top-ups", json=top_up_payload, cookies=actors["admin"])
        assert first.status_code == retry.status_code == 200
        assert first.json()["id"] == retry.json()["id"]

        transfer_payload = {
            "toUserId": actors["recipient"]["id"],
            "amountMinor": 300,
            "currency": "LYD",
            "idempotencyKey": "hardening-transfer-001",
        }
        transfer = client.post(
            "/api/wallet/transfers", json=transfer_payload, cookies=actors["wallet_cookies"]
        )
        assert transfer.status_code == 200, transfer.text

        retry_transfer = client.post(
            "/api/wallet/transfers", json=transfer_payload, cookies=actors["wallet_cookies"]
        )
        assert retry_transfer.status_code == 200
        assert retry_transfer.json()["id"] == transfer.json()["id"]

        reused_key = client.post(
            "/api/wallet/transfers",
            json={**transfer_payload, "amountMinor": 301},
            cookies=actors["wallet_cookies"],
        )
        assert reused_key.status_code == 409

        insufficient = client.post(
            "/api/wallet/transfers",
            json={**transfer_payload, "amountMinor": 999_999, "idempotencyKey": "hardening-transfer-002"},
            cookies=actors["wallet_cookies"],
        )
        assert insufficient.status_code == 409

        system_burn = client.post(
            "/api/wallet/transfers",
            json={**transfer_payload, "toUserId": "system", "idempotencyKey": "hardening-transfer-003"},
            cookies=actors["wallet_cookies"],
        )
        assert system_burn.status_code == 403

        forged_payment = client.post(
            "/api/collections/walletTransactions",
            json={
                "data": {
                    "type": "service_payment",
                    "fromUserId": actors["wallet_user"]["id"],
                    "toUserId": "system",
                    "amountMinor": 1,
                    "currency": "LYD",
                    "idempotencyKey": "hardening-forged-payment",
                }
            },
            cookies=actors["wallet_cookies"],
        )
        assert forged_payment.status_code == 403

        tx_id = transfer.json()["id"]
        patched = client.patch(
            f"/api/collections/walletTransactions/{tx_id}",
            json={"data": {"amountMinor": 1}},
            cookies=actors["admin"],
        )
        deleted = client.delete(
            f"/api/collections/walletTransactions/{tx_id}", cookies=actors["admin"]
        )
        batch = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "walletTransactions", "id": tx_id}]},
            cookies=actors["admin"],
        )
        assert patched.status_code == deleted.status_code == batch.status_code == 405

        with db_conn() as conn:
            original_wallet_row = conn.execute(
                text(
                    "SELECT data_json, deleted, created_at, created_by "
                    "FROM entities WHERE type='walletTransactions' AND id=:id"
                ),
                {"id": tx_id},
            ).mappings().one()

        restored_wallet = client.put(
            f"/api/admin/collections/walletTransactions/{tx_id}/restore",
            json={
                "data": {"amountMinor": 1, "fromUserId": "system", "toUserId": "system"},
                "createdAt": now_ms(),
            },
            cookies=actors["admin"],
        )
        restored_subscription = client.put(
            "/api/admin/collections/serviceSubscriptions/forged_subscription/restore",
            json={"data": {"status": "active", "priceMinor": 0}, "createdAt": now_ms()},
            cookies=actors["admin"],
        )
        imported_wallet = client.post(
            "/api/admin/import",
            json={"collections": {"walletTransactions": []}},
            cookies=actors["admin"],
        )
        imported_subscription = client.post(
            "/api/admin/import",
            json={
                "collections": {
                    "serviceSubscriptions": [
                        {"id": "forged_subscription", "status": "active", "priceMinor": 0}
                    ]
                }
            },
            cookies=actors["admin"],
        )
        assert restored_wallet.status_code == restored_subscription.status_code == 405
        assert imported_wallet.status_code == imported_subscription.status_code == 405

        with db_conn() as conn:
            current_wallet_row = conn.execute(
                text(
                    "SELECT data_json, deleted, created_at, created_by "
                    "FROM entities WHERE type='walletTransactions' AND id=:id"
                ),
                {"id": tx_id},
            ).mappings().one()
            forged_subscription_row = conn.execute(
                text(
                    "SELECT id FROM entities "
                    "WHERE type='serviceSubscriptions' AND id='forged_subscription'"
                )
            ).first()
        assert dict(current_wallet_row) == dict(original_wallet_row)
        assert forged_subscription_row is None

        reversal = client.post(
            "/api/wallet/reversals",
            json={"transactionId": tx_id, "memo": "Correct mistaken transfer"},
            cookies=actors["admin"],
        )
        assert reversal.status_code == 200, reversal.text
        assert reversal.json()["data"]["referenceId"] == tx_id
        duplicate_reversal = client.post(
            "/api/wallet/reversals", json={"transactionId": tx_id}, cookies=actors["admin"]
        )
        assert duplicate_reversal.status_code == 200
        assert duplicate_reversal.json()["id"] == reversal.json()["id"]

    def test_concurrent_spends_cannot_overdraw(self, actors):
        topped = client.post(
            "/api/wallet/top-ups",
            json={
                "userId": actors["concurrent_user"]["id"],
                "amountMinor": 1_000,
                "currency": "LYD",
                "idempotencyKey": "hardening-concurrent-topup",
            },
            cookies=actors["admin"],
        )
        assert topped.status_code == 200, topped.text

        def spend(key: str):
            try:
                _wallet_transfer_atomic(
                    actors["concurrent_user"],
                    to_user_id=actors["recipient"]["id"],
                    amount_minor=700,
                    currency="LYD",
                    idempotency_key=key,
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(spend, ["hardening-concurrent-a", "hardening-concurrent-b"]))
        assert sorted(responses) == [200, 409]

        rows = client.get(
            "/api/collections/walletTransactions", cookies=actors["concurrent_cookies"]
        ).json()
        balance = 0
        uid = actors["concurrent_user"]["id"]
        for row in rows:
            data = row.get("data") or {}
            if data.get("currency") != "LYD":
                continue
            amount = int(data.get("amountMinor") or 0)
            if data.get("toUserId") == uid:
                balance += amount
            if data.get("fromUserId") == uid:
                balance -= amount
        assert balance == 300

    def test_same_idempotency_key_is_global_across_users(self, actors):
        def top_up(user_id: str):
            try:
                _wallet_top_up_atomic(
                    actors["admin_user"],
                    user_id=user_id,
                    amount_minor=25,
                    currency="EUR",
                    idempotency_key="hardening-global-idempotency",
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    top_up,
                    [actors["wallet_user"]["id"], actors["recipient"]["id"]],
                )
            )
        assert sorted(responses) == [200, 409]


class TestAtomicSubscriptions:
    def test_paid_subscription_uses_catalog_and_is_atomic(self, actors, monkeypatch):
        monkeypatch.setitem(
            SERVICE_SUBSCRIPTION_CATALOG,
            "clothes_system",
            {"priceMinor": 500, "currency": "LYD", "durationDays": 30},
        )
        payload = {
            "serviceId": "clothes_system",
            "idempotencyKey": "hardening-subscription-001",
        }
        purchased = client.post(
            "/api/subscriptions/purchase", json=payload, cookies=actors["wallet_cookies"]
        )
        assert purchased.status_code == 200, purchased.text
        subscription = purchased.json()["data"]
        assert subscription["priceMinor"] == 500
        assert subscription["currency"] == "LYD"
        assert subscription["paymentTxId"]

        retry = client.post(
            "/api/subscriptions/purchase", json=payload, cookies=actors["wallet_cookies"]
        )
        assert retry.status_code == 200
        assert retry.json()["id"] == purchased.json()["id"]

        with db_conn() as conn:
            payment_rows = conn.execute(
                text("SELECT data_json FROM entities WHERE type='walletTransactions' AND deleted=false")
            ).mappings().all()
        matching = [
            json.loads(row["data_json"])
            for row in payment_rows
            if json.loads(row["data_json"]).get("idempotencyKey") == "subpay:hardening-subscription-001"
        ]
        assert len(matching) == 1
        assert matching[0]["amountMinor"] == 500

    def test_insufficient_balance_creates_neither_payment_nor_subscription(self, actors, monkeypatch):
        monkeypatch.setitem(
            SERVICE_SUBSCRIPTION_CATALOG,
            "warehouse",
            {"priceMinor": 900_000, "currency": "LYD", "durationDays": 30},
        )
        response = client.post(
            "/api/subscriptions/purchase",
            json={"serviceId": "warehouse", "idempotencyKey": "hardening-subscription-poor"},
            cookies=actors["recipient_cookies"],
        )
        assert response.status_code == 409
        with db_conn() as conn:
            rows = conn.execute(
                text("SELECT type, data_json FROM entities WHERE type IN ('walletTransactions','serviceSubscriptions')")
            ).mappings().all()
        payloads = [json.loads(row["data_json"]) for row in rows]
        assert not any(p.get("idempotencyKey") == "hardening-subscription-poor" for p in payloads)
        assert not any(p.get("idempotencyKey") == "subpay:hardening-subscription-poor" for p in payloads)

    def test_subscription_history_is_cancel_only_and_undeletable(self, actors):
        rows = client.get(
            "/api/collections/serviceSubscriptions", cookies=actors["wallet_cookies"]
        ).json()
        subscription = next(
            row for row in rows if (row.get("data") or {}).get("serviceId") == "clothes_system"
        )
        sub_id = subscription["id"]

        rewrite = client.patch(
            f"/api/collections/serviceSubscriptions/{sub_id}",
            json={"data": {"userId": actors["recipient"]["id"], "priceMinor": 0}},
            cookies=actors["admin"],
        )
        assert rewrite.status_code == 403

        canceled = client.patch(
            f"/api/collections/serviceSubscriptions/{sub_id}",
            json={
                "data": {
                    "status": "canceled",
                    "canceledAt": "2099-01-01T00:00:00Z",
                    "expiresAt": "2099-01-01T00:00:00Z",
                }
            },
            cookies=actors["wallet_cookies"],
        )
        assert canceled.status_code == 200, canceled.text
        data = canceled.json()["data"]
        assert data["status"] == "canceled"
        assert not data["canceledAt"].startswith("2099-")
        assert data["canceledBy"] == actors["wallet_user"]["id"]

        repeated = client.patch(
            f"/api/collections/serviceSubscriptions/{sub_id}",
            json={"data": {"status": "canceled"}},
            cookies=actors["wallet_cookies"],
        )
        assert repeated.status_code == 409

        deleted = client.delete(
            f"/api/collections/serviceSubscriptions/{sub_id}", cookies=actors["admin"]
        )
        batch = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "serviceSubscriptions", "id": sub_id}]},
            cookies=actors["admin"],
        )
        assert deleted.status_code == batch.status_code == 405


class TestReceiptAndAdTransactions:
    @staticmethod
    def _create(collection, entity_id, data, cookies):
        response = client.post(
            f"/api/collections/{collection}",
            json={"id": entity_id, "data": data},
            cookies=cookies,
        )
        assert response.status_code == 200, response.text
        return response.json()

    @classmethod
    def _customer(cls, customer_id, actors):
        return cls._create(
            "customers", customer_id, {"name": customer_id}, actors["admin"]
        )

    @classmethod
    def _receipt(cls, receipt_id, customer_id, amount, actors, **extra):
        return cls._create(
            "receipts",
            receipt_id,
            {
                "recordType": "receipt",
                "customerId": customer_id,
                "amountUSD": amount,
                "amountLocal": amount * 5,
                "exchangeRate": 5,
                "status": "Paid",
                "isPaid": True,
                **extra,
            },
            actors["admin"],
        )

    @staticmethod
    def _mutate_ad(ad_id, key, data, actors, **extra):
        payload = {
            "action": "create",
            "adId": ad_id,
            "idempotencyKey": key,
            "data": data,
            **extra,
        }
        return client.post("/api/ads/mutate", json=payload, cookies=actors["admin"])

    def test_transfer_capacity_replay_and_generic_bypasses(self, actors):
        self._customer("fin_transfer_source", actors)
        self._customer("fin_transfer_target", actors)
        receipt = self._receipt(
            "fin_transfer_receipt", "fin_transfer_source", 100, actors
        )
        funded = self._mutate_ad(
            "fin_transfer_ad",
            "fin-transfer-ad-create-001",
            {
                "customerId": "fin_transfer_source",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_transfer_receipt", "amountUSD": 70}
                ],
            },
            actors,
        )
        assert funded.status_code == 200, funded.text

        base = {
            "sourceReceiptId": "fin_transfer_receipt",
            "targetCustomerId": "fin_transfer_target",
            "targetReceiptId": "fin_transfer_in",
            "idempotencyKey": "fin-receipt-transfer-001",
            "expectedSourceLastModified": receipt["lastModified"],
            "note": "test",
        }
        insufficient = client.post(
            "/api/receipts/transfers",
            json={**base, "amountMinorUSD": 3001},
            cookies=actors["admin"],
        )
        assert insufficient.status_code == 409
        assert client.get(
            "/api/collections/receipts/fin_transfer_in", cookies=actors["admin"]
        ).status_code == 404

        # A failed request does not consume the key; its canonical request may
        # be corrected and retried because no marker/side effect was committed.
        ok_payload = {
            **base,
            "idempotencyKey": "fin-receipt-transfer-002",
            "amountMinorUSD": 3000,
        }
        ok = client.post(
            "/api/receipts/transfers", json=ok_payload, cookies=actors["admin"]
        )
        replay = client.post(
            "/api/receipts/transfers", json=ok_payload, cookies=actors["admin"]
        )
        assert ok.status_code == replay.status_code == 200
        assert replay.json()["replayed"] is True
        assert replay.json()["targetReceipt"]["id"] == "fin_transfer_in"
        assert replay.json()["transfer"]["amountUSD"] == 30

        reused = client.post(
            "/api/receipts/transfers",
            json={**ok_payload, "amountMinorUSD": 2999},
            cookies=actors["admin"],
        )
        assert reused.status_code == 409
        forged = client.post(
            "/api/collections/receipts",
            json={
                "id": "forged_transfer_in",
                "data": {
                    "receiptType": "TRANSFER_IN",
                    "customerId": "fin_transfer_target",
                    "amountUSD": 999,
                },
            },
            cookies=actors["admin"],
        )
        patched = client.patch(
            "/api/collections/receipts/fin_transfer_receipt",
            json={"data": {"transfers": []}},
            cookies=actors["admin"],
        )
        deleted = client.delete(
            "/api/collections/receipts/fin_transfer_receipt",
            cookies=actors["admin"],
        )
        assert forged.status_code == patched.status_code == 405
        assert deleted.status_code == 409

    def test_concurrent_ad_allocations_have_one_winner(self, actors):
        self._customer("fin_concurrent_customer", actors)
        self._receipt(
            "fin_concurrent_receipt", "fin_concurrent_customer", 100, actors
        )
        actor = {"id": actors["admin_user"]["id"], "role": "Admin", "permissions_json": "{}"}

        def spend(index):
            try:
                ad, replayed = _ad_mutation_atomic(
                    actor,
                    AdMutationRequest(
                        action="create",
                        adId=f"fin_concurrent_ad_{index}",
                        idempotencyKey=f"fin-concurrent-ad-key-{index}",
                        data={
                            "customerId": "fin_concurrent_customer",
                            "paymentStatus": "paid",
                            "exchangeRate": 5,
                            "receiptAllocations": [
                                {
                                    "receiptId": "fin_concurrent_receipt",
                                    "amountUSD": 60,
                                }
                            ],
                        },
                    ),
                )
                return ad["id"] if not replayed else "replay"
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(spend, (1, 2)))
        assert sum(isinstance(value, str) for value in results) == 1
        assert 409 in results

    def test_stop_uses_exact_proportional_cents_and_retake_is_checked(self, actors):
        self._customer("fin_stop_customer", actors)
        self._receipt("fin_stop_r1", "fin_stop_customer", 60, actors)
        self._receipt("fin_stop_r2", "fin_stop_customer", 40, actors)
        created = self._mutate_ad(
            "fin_stop_ad",
            "fin-stop-create-001",
            {
                "customerId": "fin_stop_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_stop_r1", "amountUSD": 60},
                    {"receiptId": "fin_stop_r2", "amountUSD": 40},
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        version = created.json()["ad"]["lastModified"]
        stop_payload = {
            "spentMinorUSD": 3333,
            "idempotencyKey": "fin-stop-operation-001",
            "expectedLastModified": version,
        }
        stopped = client.post(
            "/api/ads/fin_stop_ad/stop", json=stop_payload, cookies=actors["admin"]
        )
        replay = client.post(
            "/api/ads/fin_stop_ad/stop", json=stop_payload, cookies=actors["admin"]
        )
        assert stopped.status_code == replay.status_code == 200
        assert replay.json()["replayed"] is True
        allocations = stopped.json()["ad"]["data"]["receiptAllocations"]
        assert allocations == [
            {"receiptId": "fin_stop_r1", "amountUSD": 20.0},
            {"receiptId": "fin_stop_r2", "amountUSD": 13.33},
        ]
        assert sum(round(row["amountUSD"] * 100) for row in allocations) == 3333

        competing = self._mutate_ad(
            "fin_stop_competing",
            "fin-stop-competing-001",
            {
                "customerId": "fin_stop_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_stop_r1", "amountUSD": 40}
                ],
            },
            actors,
        )
        assert competing.status_code == 200, competing.text
        retake = client.post(
            "/api/ads/fin_stop_ad/stop",
            json={
                "spentMinorUSD": 10000,
                "idempotencyKey": "fin-stop-operation-002",
                "expectedLastModified": stopped.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert retake.status_code == 409

        generic = client.patch(
            "/api/collections/ads/fin_stop_ad",
            json={"data": {"status": "Stopped", "spentUSD": 0}},
            cookies=actors["admin"],
        )
        assert generic.status_code == 405

    def test_delivery_cancel_releases_due_in_same_transaction_and_delete_stays_blocked(self, actors):
        self._customer("fin_due_customer", actors)
        receipt = self._receipt(
            "fin_due_receipt",
            "fin_due_customer",
            100,
            actors,
            status="Not Paid",
            isPaid=False,
            debtAmountLocal=500,
            tempReceiptNo="D99001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        ad = self._mutate_ad(
            "fin_due_ad",
            "fin-due-ad-create-001",
            {
                "customerId": "fin_due_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_due_receipt",
                "receiptId": "fin_due_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [
                    {"receiptId": "fin_due_receipt", "amountUSD": 80}
                ],
            },
            actors,
        )
        assert ad.status_code == 200, ad.text
        canceled = client.patch(
            "/api/collections/receipts/fin_due_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"deliveryStatus": "Canceled"},
            },
            cookies=actors["admin"],
        )
        assert canceled.status_code == 200, canceled.text
        saved_ad = client.get(
            "/api/collections/ads/fin_due_ad", cookies=actors["admin"]
        )
        assert saved_ad.status_code == 200
        assert saved_ad.json()["data"]["dueAllocations"] == []
        assert saved_ad.json()["data"]["dueAmountToUseUSD"] == 0
        blocked_delete = client.post(
            "/api/batch/delete",
            json={
                "items": [
                    {"collection": "receipts", "id": "fin_due_receipt"},
                    {"collection": "customers", "id": "fin_due_customer"},
                ]
            },
            cookies=actors["admin"],
        )
        assert blocked_delete.status_code == 409

    def test_edit_own_is_enforced_and_stop_needs_stop_permission(self, actors):
        self._customer("fin_own_customer", actors)
        self._receipt("fin_own_receipt", "fin_own_customer", 100, actors)
        owner, owner_cookies = _create_user(
            actors["admin"],
            email="fin-ad-owner@tests.albayanhub.com",
            permissions={"ads": ["add", "editOwn"]},
        )
        _other, other_cookies = _create_user(
            actors["admin"],
            email="fin-ad-other@tests.albayanhub.com",
            permissions={"ads": ["editOwn"]},
        )
        created = client.post(
            "/api/ads/mutate",
            json={
                "action": "create",
                "adId": "fin_owned_ad",
                "idempotencyKey": "fin-owned-create-001",
                "data": {
                    "customerId": "fin_own_customer",
                    "paymentStatus": "paid",
                    "exchangeRate": 5,
                    "receiptAllocations": [
                        {"receiptId": "fin_own_receipt", "amountUSD": 25}
                    ],
                },
            },
            cookies=owner_cookies,
        )
        assert created.status_code == 200, created.text
        update_payload = {
            "action": "update",
            "adId": "fin_owned_ad",
            "idempotencyKey": "fin-owned-update-001",
            "expectedLastModified": created.json()["ad"]["lastModified"],
            "data": {"pageId": "page_owned_update"},
        }
        denied = client.post("/api/ads/mutate", json=update_payload, cookies=other_cookies)
        allowed = client.post("/api/ads/mutate", json=update_payload, cookies=owner_cookies)
        assert denied.status_code == 403
        assert allowed.status_code == 200, allowed.text
        stop_denied = client.post(
            "/api/ads/fin_owned_ad/stop",
            json={
                "spentMinorUSD": 1000,
                "idempotencyKey": "fin-owned-stop-001",
                "expectedLastModified": allowed.json()["ad"]["lastModified"],
            },
            cookies=owner_cookies,
        )
        assert stop_denied.status_code == 403
        assert owner["id"] == allowed.json()["ad"]["createdBy"]

    def test_topup_and_refund_are_server_derived_and_undo_rechecks_capacity(self, actors):
        self._customer("fin_adjust_customer", actors)
        self._receipt("fin_adjust_receipt", "fin_adjust_customer", 100, actors)
        created = self._mutate_ad(
            "fin_adjust_ad",
            "fin-adjust-create-001",
            {
                "customerId": "fin_adjust_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_adjust_receipt", "amountUSD": 50}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        topup = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_adjust_ad",
                "idempotencyKey": "fin-adjust-topup-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
                "data": {
                    "topUps": [{"amount": 20, "extendDays": 2}],
                    "receiptAllocations": [
                        {"receiptId": "fin_adjust_receipt", "amountUSD": 70}
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert topup.status_code == 200, topup.text
        topup_data = topup.json()["ad"]["data"]
        assert topup_data["amountUSD"] == 70
        assert topup_data["initialAmountUSD"] == 50

        refund = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_adjust_ad",
                "idempotencyKey": "fin-adjust-refund-001",
                "expectedLastModified": topup.json()["ad"]["lastModified"],
                "data": {
                    "refundType": "Partial",
                    "refundAmount": 30,
                    "refundStatus": "Refunded",
                    # Forged arrays are ignored; the frozen server baseline is
                    # reduced by exactly the authoritative refund amount.
                    "receiptAllocations": [],
                },
            },
            cookies=actors["admin"],
        )
        assert refund.status_code == 200, refund.text
        refund_data = refund.json()["ad"]["data"]
        assert refund_data["amountUSD"] == 70
        assert refund_data["spentUSD"] == 40
        assert refund_data["receiptAllocations"][0]["amountUSD"] == 40

        competing = self._mutate_ad(
            "fin_adjust_competing",
            "fin-adjust-competing-001",
            {
                "customerId": "fin_adjust_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_adjust_receipt", "amountUSD": 60}
                ],
            },
            actors,
        )
        assert competing.status_code == 200, competing.text
        undo = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_adjust_ad",
                "idempotencyKey": "fin-adjust-refund-undo-001",
                "expectedLastModified": refund.json()["ad"]["lastModified"],
                "data": {"refundType": "None", "refundAmount": 0},
            },
            cookies=actors["admin"],
        )
        assert undo.status_code == 409

    def test_receipt_capacity_patch_rolls_back_on_committed_floor(self, actors):
        self._customer("fin_floor_customer", actors)
        receipt = self._receipt("fin_floor_receipt", "fin_floor_customer", 100, actors)
        ad = self._mutate_ad(
            "fin_floor_ad",
            "fin-floor-create-001",
            {
                "customerId": "fin_floor_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_floor_receipt", "amountUSD": 70}
                ],
            },
            actors,
        )
        assert ad.status_code == 200, ad.text
        reduced = client.patch(
            "/api/collections/receipts/fin_floor_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"amountUSD": 60},
            },
            cookies=actors["admin"],
        )
        invalidated = client.patch(
            "/api/collections/receipts/fin_floor_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Canceled", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert reduced.status_code == invalidated.status_code == 409
        stored = client.get(
            "/api/collections/receipts/fin_floor_receipt", cookies=actors["admin"]
        )
        assert stored.status_code == 200
        assert stored.json()["data"]["amountUSD"] == 100
        assert stored.json()["data"]["status"] == "Paid"

    def test_underpaid_delivery_completes_and_leaves_no_spendable_credit(self, actors):
        # A driver who collects LESS than the debt must still be able to CLOSE the
        # delivery (never stranded at the customer's door), and the shortfall must
        # not become spendable credit. debt 1000 LYD @ 5 = $200 committed to an ad.
        self._customer("fin_under_customer", actors)
        self._receipt(
            "fin_under_receipt",
            "fin_under_customer",
            200,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=1000,
            debtAmountLocal=1000,
            debtAmountUSD=200,
            tempReceiptNo="D70001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        ad = self._mutate_ad(
            "fin_under_ad",
            "fin-under-ad-001",
            {
                "customerId": "fin_under_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_under_receipt",
                "receiptId": "fin_under_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [{"receiptId": "fin_under_receipt", "amountUSD": 200}],
            },
            actors,
        )
        assert ad.status_code == 200, ad.text

        accepted = client.patch(
            "/api/collections/receipts/fin_under_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        )
        assert accepted.status_code == 200, accepted.text

        # Collect only 900 of the 1000 owed -> UNDERPAID, amountUSD becomes $180 < $200.
        completed = client.patch(
            "/api/collections/receipts/fin_under_receipt",
            json={
                "data": {
                    "deliveryStatus": "Delivered",
                    "finalReceiptNo": "770001",
                    "receiptImage": "data:image/png;base64,AAAA",
                    "amountCollectedFromCustomer": 900,
                    "actualDeliveryFeeCollected": 0,
                }
            },
            cookies=actors["driver_cookies"],
        )
        # Must NOT 409 - the physical collection cannot be blocked.
        assert completed.status_code == 200, completed.text
        body = completed.json()["data"]
        assert str(body.get("deliveryStatus")) == "Delivered"
        assert body.get("paymentResult") == "UNDERPAID"

        # A Delivered + underpaid receipt is eligible for NEITHER pool, so no new ad
        # can be funded from it - the shortfall never becomes spendable credit.
        new_due = self._mutate_ad(
            "fin_under_ad2",
            "fin-under-ad2-001",
            {
                "customerId": "fin_under_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_under_receipt",
                "receiptId": "fin_under_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [{"receiptId": "fin_under_receipt", "amountUSD": 1}],
            },
            actors,
        )
        assert new_due.status_code in (400, 409), new_due.text

    def test_one_ad_cannot_double_draw_paid_and_due_from_same_receipt(self, actors):
        # Self-exclusion hole: each pool validator excludes the current ad and checks
        # only its own request, so one ad could take $150 paid AND $150 due from the
        # same $200 receipt. Reachable when a receipt is BOTH Paid and a pending D#
        # delivery (an admin edit produces this).
        self._customer("fin_dd_customer", actors)
        self._receipt(
            "fin_dd_receipt",
            "fin_dd_customer",
            200,
            actors,
            status="Paid",
            isPaid=True,
            amountLocal=1000,
            debtAmountLocal=1000,
            debtAmountUSD=200,
            tempReceiptNo="D80001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        double = self._mutate_ad(
            "fin_dd_ad",
            "fin-dd-ad-001",
            {
                "customerId": "fin_dd_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_dd_receipt",
                "receiptId": "fin_dd_receipt",
                "receiptAllocations": [{"receiptId": "fin_dd_receipt", "amountUSD": 150}],
                "mergedPaidAllocations": [{"receiptId": "fin_dd_receipt", "amountUSD": 150}],
                "dueAllocations": [{"receiptId": "fin_dd_receipt", "amountUSD": 150}],
            },
            actors,
        )
        # $300 drawn from a $200 receipt must be rejected.
        assert double.status_code == 409, double.text

    def test_office_handover_after_underpaid_delivery_is_not_blocked(self, actors):
        # Regression: FIX-1 must not merely unblock the completion and then trap the
        # receipt. An underpaid delivered receipt still needs its office-handover PATCH,
        # and every guard must measure commitments against the receipt's CAPACITY (the
        # debt while Not Paid), not the freshly-lowered collected amountUSD.
        self._customer("fin_oh_customer", actors)
        self._receipt(
            "fin_oh_receipt",
            "fin_oh_customer",
            100,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=500,
            debtAmountLocal=500,
            debtAmountUSD=100,
            tempReceiptNo="D90001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        ad = self._mutate_ad(
            "fin_oh_ad",
            "fin-oh-ad-001",
            {
                "customerId": "fin_oh_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_oh_receipt",
                "receiptId": "fin_oh_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [{"receiptId": "fin_oh_receipt", "amountUSD": 100}],
            },
            actors,
        )
        assert ad.status_code == 200, ad.text
        assert client.patch(
            "/api/collections/receipts/fin_oh_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        ).status_code == 200
        # Collect only 300 of 500 owed -> UNDERPAID, amountUSD becomes $60 < committed $100.
        assert client.patch(
            "/api/collections/receipts/fin_oh_receipt",
            json={"data": {
                "deliveryStatus": "Delivered",
                "finalReceiptNo": "990001",
                "receiptImage": "data:image/png;base64,AAAA",
                "amountCollectedFromCustomer": 300,
                "actualDeliveryFeeCollected": 0,
            }},
            cookies=actors["driver_cookies"],
        ).status_code == 200
        # The office-handover step must succeed - the driver-held receipt cannot be trapped.
        handover = client.patch(
            "/api/collections/receipts/fin_oh_receipt",
            json={"data": {"isReceivedInOffice": True, "receivedInOfficeAt": "now"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert handover.status_code == 200, handover.text

    def test_combined_capacity_counts_legacy_rowless_paid_ads(self, actors):
        # Regression: the combined cross-pool check must count a legacy PAID ad that
        # holds its funding in the whole-ad fallback (no allocation arrays), or the
        # same money is spent twice. Seed such an ad directly (only old prod data / a
        # raw import can produce the rowless shape).
        self._customer("fin_leg_customer", actors)
        self._receipt(
            "fin_leg_receipt",
            "fin_leg_customer",
            200,
            actors,
            status="Paid",
            isPaid=True,
            amountLocal=1000,
            debtAmountLocal=1000,
            debtAmountUSD=200,
            tempReceiptNo="D95001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        # Legacy paid ad L: $100 funded from R, no allocation arrays at all.
        with db_conn() as conn:
            conn.execute(
                text(
                    "INSERT INTO entities "
                    "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES ('ads',:id,:data,false,:ts,:by,:ts)"
                ),
                {
                    "id": "fin_leg_legacy_ad",
                    "data": json_dumps({
                        "id": "fin_leg_legacy_ad",
                        "recordType": "ad",
                        "customerId": "fin_leg_customer",
                        "paymentStatus": "paid",
                        "fundingReceiptId": "fin_leg_receipt",
                        "receiptId": "fin_leg_receipt",
                        "amountUSD": 100,
                        "spentUSD": 100,
                        "exchangeRate": 5,
                        "status": "Active",
                    }),
                    "ts": now_ms(),
                    "by": actors["admin_user"]["id"],
                },
            )
        # New ad drawing $100 paid + $100 due from the same $200 receipt. With L already
        # holding $100, only $100 is left, so this $200 draw must be rejected.
        double = self._mutate_ad(
            "fin_leg_new_ad",
            "fin-leg-new-001",
            {
                "customerId": "fin_leg_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "linkedDeliveryReceiptId": "fin_leg_receipt",
                "receiptId": "fin_leg_receipt",
                "receiptAllocations": [{"receiptId": "fin_leg_receipt", "amountUSD": 100}],
                "mergedPaidAllocations": [{"receiptId": "fin_leg_receipt", "amountUSD": 100}],
                "dueAllocations": [{"receiptId": "fin_leg_receipt", "amountUSD": 100}],
            },
            actors,
        )
        assert double.status_code == 409, double.text

    def test_delivery_completion_stores_split_payment_rows(self, actors):
        # The driver now records collected money + fee as split-payment rows (same shape
        # a receipt stores). The server must persist payments + deliveryFeePayments, and
        # still compute the money authoritatively from amountCollectedFromCustomer.
        self._customer("fin_split_customer", actors)
        self._receipt(
            "fin_split_receipt",
            "fin_split_customer",
            100,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=950,
            debtAmountLocal=950,
            debtAmountUSD=100,
            exchangeRate=9.5,
            quotedDeliveryFee=10,
            tempReceiptNo="D60001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        assert client.patch(
            "/api/collections/receipts/fin_split_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        ).status_code == 200
        # Collect 150 LYD (underpaid on a 950 debt), recorded as one Cash (LYD) row,
        # fee 10 LYD as its own method row.
        done = client.patch(
            "/api/collections/receipts/fin_split_receipt",
            json={"data": {
                "deliveryStatus": "Delivered",
                "finalReceiptNo": "660001",
                "receiptImage": "data:image/png;base64,AAAA",
                "amountCollectedFromCustomer": 150,
                "actualDeliveryFeeCollected": 10,
                "payments": [{"method": "Cash (LYD)", "amount": 150, "rate": 1, "rate2": 9.5, "collectionType": "delivery"}],
                "deliveryFeePayments": [{"method": "Cash (LYD)", "amount": 10, "rate": 1, "rate2": 9.5, "collectionType": "delivery"}],
                "paymentMethod": "Cash (LYD)",
            }},
            cookies=actors["driver_cookies"],
        )
        assert done.status_code == 200, done.text
        body = done.json()["data"]
        # Money is server-authoritative from amountCollectedFromCustomer.
        assert str(body.get("deliveryStatus")) == "Delivered"
        assert body.get("paymentResult") == "UNDERPAID"
        assert abs(float(body.get("amountLocal") or 0) - 150) < 0.01
        # The split-payment record persisted.
        assert isinstance(body.get("payments"), list) and len(body["payments"]) == 1
        assert body["payments"][0]["method"] == "Cash (LYD)"
        assert isinstance(body.get("deliveryFeePayments"), list) and len(body["deliveryFeePayments"]) == 1
        assert body["deliveryFeePayments"][0]["method"] == "Cash (LYD)"
