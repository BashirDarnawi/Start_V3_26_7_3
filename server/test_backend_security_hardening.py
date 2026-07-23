"""Adversarial tests for server-authoritative grants, delivery and money flows."""

import json
import hashlib
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


def _customer_test_phone(customer_id: str) -> str:
    """Stable valid phone for fixtures that are not testing contact details."""
    suffix = int.from_bytes(
        hashlib.sha256(customer_id.encode("utf-8")).digest()[:8], "big"
    ) % 100_000_000
    return f"09{suffix:08d}"


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


class TestCustomerContactProjection:
    @staticmethod
    def _assert_secrets_absent(payload, secrets):
        encoded = json.dumps(payload, ensure_ascii=False)
        for secret in secrets:
            assert secret not in encoded, f"contact detail leaked: {secret}"

    @staticmethod
    def _assert_secrets_present(payload, secrets):
        encoded = json.dumps(payload, ensure_ascii=False)
        for secret in secrets:
            assert secret in encoded, f"authorized contact detail missing: {secret}"

    def test_contact_projection_covers_lists_direct_reads_bootstrap_and_mutations(self, actors):
        base_permissions = {
            "customers": ["view", "add", "edit"],
            "receipts": ["view", "add", "edit"],
            "ads": ["view", "add", "edit"],
        }
        denied_user, denied_cookies = _create_user(
            actors["admin"],
            email="hardening-contacts-denied@tests.albayanhub.com",
            permissions=base_permissions,
        )
        _allowed_user, allowed_cookies = _create_user(
            actors["admin"],
            email="hardening-contacts-allowed@tests.albayanhub.com",
            permissions={
                **base_permissions,
                "customers": ["view", "add", "edit", "viewContacts"],
            },
        )

        phone = "+218910001122"
        profile = "https://example.test/private-profile"
        address = "Private Street 42"
        contact = "private-contact-handle"
        email = "private-customer@example.test"
        delivery_place = "Private delivery landmark"
        secrets = {phone, profile, address, contact, email, delivery_place}
        records = {
            "customers": {
                "id": "contact_projection_customer",
                "data": {
                    "name": "Projection Customer",
                    "phones": [phone],
                    "profileLinks": [profile],
                    "address": address,
                    "email": email,
                    "metadata": {"contactHandle": contact, "safeLabel": "customer-safe"},
                },
            },
            "receipts": {
                "id": "contact_projection_receipt",
                "data": {
                    "recordType": "receipt",
                    "customerId": "contact_projection_customer",
                    "status": "Paid",
                    "isPaid": True,
                    "amountUSD": 1,
                    "amountLocal": 5,
                    "exchangeRate": 5,
                    "deliveryStatus": "Office",
                    "phoneNumber": phone,
                    "customerProfileUrl": profile,
                    "deliveryAddress": address,
                    "deliveryPlaceName": delivery_place,
                    "metadata": {"contactHandle": contact, "safeLabel": "receipt-safe"},
                },
            },
            "ads": {
                "id": "contact_projection_ad",
                "data": {
                    "customerId": "contact_projection_customer",
                    "status": "Active",
                    "phoneNumber": phone,
                    "customerProfileUrl": profile,
                    "customerAddress": address,
                    "contactEmail": email,
                    "metadata": {"contactHandle": contact, "safeLabel": "ad-safe"},
                },
            },
        }

        versions = {}
        for collection, record in records.items():
            created = client.post(
                f"/api/collections/{collection}",
                json=record,
                cookies=denied_cookies,
            )
            assert created.status_code == 200, created.text
            versions[collection] = created.json()["lastModified"]
            self._assert_secrets_absent(created.json(), secrets)
            assert f"{collection[:-1]}-safe" in json.dumps(created.json())

        # Mutation responses are projected too, while the hidden stored fields
        # survive an unrelated edit.
        for collection, record in records.items():
            patched = client.patch(
                f"/api/collections/{collection}/{record['id']}",
                json={
                    "data": {"note": f"updated-{collection}"},
                    "expectedLastModified": versions[collection],
                },
                cookies=denied_cookies,
            )
            assert patched.status_code == 200, patched.text
            versions[collection] = patched.json()["lastModified"]
            self._assert_secrets_absent(patched.json(), secrets)

        for collection, record in records.items():
            listed = client.get(
                f"/api/collections/{collection}", cookies=denied_cookies
            )
            direct = client.get(
                f"/api/collections/{collection}/{record['id']}",
                cookies=denied_cookies,
            )
            assert listed.status_code == direct.status_code == 200
            listed_record = next(
                item for item in listed.json() if item["id"] == record["id"]
            )
            self._assert_secrets_absent(listed_record, secrets)
            self._assert_secrets_absent(direct.json(), secrets)
            assert direct.json()["data"]["metadata"]["safeLabel"]

        denied_bootstrap = client.get("/api/bootstrap", cookies=denied_cookies)
        assert denied_bootstrap.status_code == 200, denied_bootstrap.text
        self._assert_secrets_absent(denied_bootstrap.json(), secrets)

        # Permission-bearing employees and Admins receive the original values.
        for cookies in (allowed_cookies, actors["admin"]):
            for collection, record in records.items():
                direct = client.get(
                    f"/api/collections/{collection}/{record['id']}", cookies=cookies
                )
                listed = client.get(
                    f"/api/collections/{collection}", cookies=cookies
                )
                assert direct.status_code == listed.status_code == 200
                listed_record = next(
                    item for item in listed.json() if item["id"] == record["id"]
                )
                record_json = json.dumps(record["data"], ensure_ascii=False)
                record_secrets = {secret for secret in secrets if secret in record_json}
                self._assert_secrets_present(direct.json(), record_secrets)
                self._assert_secrets_present(listed_record, record_secrets)

        allowed_patch = client.patch(
            "/api/collections/customers/contact_projection_customer",
            json={
                "data": {"note": "allowed mutation response"},
                "expectedLastModified": versions["customers"],
            },
            cookies=allowed_cookies,
        )
        assert allowed_patch.status_code == 200, allowed_patch.text
        self._assert_secrets_present(
            allowed_patch.json(), {phone, profile, address, contact, email}
        )

        allowed_bootstrap = client.get("/api/bootstrap", cookies=allowed_cookies)
        assert allowed_bootstrap.status_code == 200, allowed_bootstrap.text
        self._assert_secrets_present(allowed_bootstrap.json(), secrets)
        assert "viewContacts" not in denied_user["permissions"].get("customers", [])


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
            json={
                "id": "hardening_driver_customer",
                "data": {
                    "name": "Assigned",
                    "phones": [_customer_test_phone("hardening_driver_customer")],
                },
            },
            cookies=actors["admin"],
        )
        guessed_customer = client.post(
            "/api/collections/customers",
            json={
                "id": "hardening_other_customer",
                "data": {
                    "name": "Other",
                    "phones": [_customer_test_phone("hardening_other_customer")],
                },
            },
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

        repeated_accept = client.patch(
            "/api/collections/receipts/hardening_delivery_receipt",
            json={"data": {"deliveryStatus": "In Progress"}},
            cookies=actors["delivery_manager_cookies"],
        )
        assert repeated_accept.status_code == 409, repeated_accept.text

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


class TestReceiptNumberIntegrity:
    def test_canonical_cross_field_namespace_and_same_row_alias(self, actors):
        first = client.post(
            "/api/collections/receipts",
            json={
                "id": "receipt_number_canonical_a",
                "data": {"serialNumber": "s١٢٣٤٥"},
            },
            cookies=actors["admin"],
        )
        assert first.status_code == 200, first.text
        assert first.json()["data"]["serialNumber"] == "S12345"

        cross_field = client.post(
            "/api/collections/receipts",
            json={
                "id": "receipt_number_canonical_b",
                "data": {"finalReceiptNo": "S12345"},
            },
            cookies=actors["admin"],
        )
        assert cross_field.status_code == 409, cross_field.text

        same_row = client.post(
            "/api/collections/receipts",
            json={
                "id": "receipt_number_same_row",
                "data": {"serialNumber": "b٧٧", "finalReceiptNo": "B77"},
            },
            cookies=actors["admin"],
        )
        assert same_row.status_code == 200, same_row.text
        assert same_row.json()["data"]["serialNumber"] == "B77"
        assert same_row.json()["data"]["finalReceiptNo"] == "B77"

    def test_legacy_duplicate_is_grandfathered_for_unrelated_edit(self, actors):
        now = now_ms()
        with db_conn() as conn:
            for receipt_id, data in (
                ("receipt_legacy_dirty_a", {"serialNumber": "s٩٩١", "notes": "old"}),
                ("receipt_legacy_dirty_b", {"finalReceiptNo": "S991"}),
            ):
                conn.execute(
                    text(
                        "INSERT INTO entities "
                        "(type,id,data_json,deleted,created_at,created_by,last_modified) "
                        "VALUES ('receipts',:id,:data,false,:now,:actor,:now)"
                    ),
                    {
                        "id": receipt_id,
                        "data": json_dumps({"id": receipt_id, **data}),
                        "now": now,
                        "actor": actors["admin_user"]["id"],
                    },
                )

        unrelated = client.patch(
            "/api/collections/receipts/receipt_legacy_dirty_a",
            json={"data": {"notes": "safe unrelated edit"}},
            cookies=actors["admin"],
        )
        assert unrelated.status_code == 200, unrelated.text

        introduced = client.post(
            "/api/collections/receipts",
            json={"id": "receipt_legacy_dirty_new", "data": {"serialNumber": "S991"}},
            cookies=actors["admin"],
        )
        assert introduced.status_code == 409, introduced.text

    def test_concurrent_serial_and_final_create_only_one_owner(self, actors):
        def create(receipt_id, field):
            try:
                main_module.upsert_entity(
                    "receipts",
                    receipt_id,
                    {field: "o٨٨٠٠٩"},
                    actors["admin_user"]["id"],
                    reject_existing=True,
                )
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda args: create(*args),
                    (
                        ("receipt_number_race_serial", "serialNumber"),
                        ("receipt_number_race_final", "finalReceiptNo"),
                    ),
                )
            )
        assert sorted(responses) == [200, 409]


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
            "customers",
            customer_id,
            {"name": customer_id, "phones": [_customer_test_phone(customer_id)]},
            actors["admin"],
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

    def test_zero_due_legacy_reference_does_not_block_paid_funding_or_transfer(self, actors):
        self._customer("fin_provenance_source_customer", actors)
        self._customer("fin_provenance_target_customer", actors)
        receipt = self._receipt(
            "fin_provenance_source_receipt",
            "fin_provenance_source_customer",
            10,
            actors,
        )
        seed = self._mutate_ad(
            "fin_provenance_legacy_ad",
            "fin-provenance-legacy-create-001",
            {
                "customerId": "fin_provenance_source_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_provenance_source_receipt", "amountUSD": 1}
                ],
            },
            actors,
        )
        assert seed.status_code == 200, seed.text

        # Simulate an old row with no allocation ledgers: it references this
        # receipt for In-Shop collection provenance, but its explicit due
        # mirrors are zero.  Its large ad budget is not money from the receipt.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_provenance_legacy_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("receiptAllocations", None)
            legacy.pop("dueAllocations", None)
            legacy.update(
                {
                    "paymentStatus": "not_paid",
                    "isPaid": False,
                    "collectionMethod": "in_shop",
                    "receiptId": "fin_provenance_source_receipt",
                    "fundingReceiptId": "",
                    "linkedDeliveryReceiptId": "",
                    "amountUSD": 100,
                    "spentUSD": 100,
                    "dueAmountToUseUSD": 0,
                    "dueAmountToUseLYD": 0,
                }
            )
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_provenance_legacy_ad'"
                ),
                {"data": json_dumps(legacy), "modified": modified},
            )

        funded = self._mutate_ad(
            "fin_provenance_funded_ad",
            "fin-provenance-funded-create-001",
            {
                "customerId": "fin_provenance_source_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_provenance_source_receipt", "amountUSD": 5}
                ],
            },
            actors,
        )
        assert funded.status_code == 200, funded.text

        transferred = client.post(
            "/api/receipts/transfers",
            json={
                "sourceReceiptId": "fin_provenance_source_receipt",
                "targetCustomerId": "fin_provenance_target_customer",
                "targetReceiptId": "fin_provenance_transfer_in",
                "amountMinorUSD": 500,
                "idempotencyKey": "fin-provenance-transfer-001",
                "expectedSourceLastModified": receipt["lastModified"],
                "note": "remaining real balance",
            },
            cookies=actors["admin"],
        )
        assert transferred.status_code == 200, transferred.text
        assert transferred.json()["transfer"]["amountUSD"] == 5

        untouched = client.get(
            "/api/collections/ads/fin_provenance_legacy_ad",
            cookies=actors["admin"],
        )
        assert untouched.status_code == 200
        assert untouched.json()["lastModified"] == modified
        assert untouched.json()["data"]["paymentStatus"] == "not_paid"

    def test_mixed_legacy_in_shop_due_cannot_be_reserved_twice(self, actors):
        self._customer("fin_legacy_mixed_customer", actors)
        self._customer("fin_legacy_mixed_other_customer", actors)
        self._receipt(
            "fin_legacy_mixed_paid_receipt",
            "fin_legacy_mixed_customer",
            5,
            actors,
        )
        due_receipt = self._receipt(
            "fin_legacy_mixed_due_receipt",
            "fin_legacy_mixed_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        mixed = self._mutate_ad(
            "fin_legacy_mixed_ad",
            "fin-legacy-mixed-create-001",
            {
                "customerId": "fin_legacy_mixed_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_legacy_mixed_due_receipt",
                "receiptAllocations": [
                    {
                        "receiptId": "fin_legacy_mixed_paid_receipt",
                        "amountUSD": 5,
                    }
                ],
                "dueAllocations": [
                    {
                        "receiptId": "fin_legacy_mixed_due_receipt",
                        "amountUSD": 10,
                    }
                ],
            },
            actors,
        )
        assert mixed.status_code == 200, mixed.text

        # Historical mixed-funding rows retained the paid ledger but stored
        # the In-Shop debt only in a mirror.  The presence of one allocation
        # array must not make the other receipt's real debt disappear.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_legacy_mixed_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("dueAllocations", None)
            legacy["dueAmountToUseUSD"] = 10
            legacy["dueAmountToUseLYD"] = 0
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_legacy_mixed_ad'"
                ),
                {"data": json_dumps(legacy), "modified": modified},
            )

        double_reserved = self._mutate_ad(
            "fin_legacy_mixed_competing_ad",
            "fin-legacy-mixed-competing-001",
            {
                "customerId": "fin_legacy_mixed_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_legacy_mixed_due_receipt",
                "dueAllocations": [
                    {
                        "receiptId": "fin_legacy_mixed_due_receipt",
                        "amountUSD": 1,
                    }
                ],
            },
            actors,
        )
        assert double_reserved.status_code == 409, double_reserved.text

        customer_changed = client.patch(
            "/api/collections/receipts/fin_legacy_mixed_due_receipt",
            json={
                "expectedLastModified": due_receipt["lastModified"],
                "data": {"customerId": "fin_legacy_mixed_other_customer"},
            },
            cookies=actors["admin"],
        )
        assert customer_changed.status_code == 409, customer_changed.text
        stored = client.get(
            "/api/collections/ads/fin_legacy_mixed_ad",
            cookies=actors["admin"],
        )
        assert stored.status_code == 200
        assert stored.json()["lastModified"] == modified
        assert stored.json()["data"]["dueAmountToUseUSD"] == 10

    def test_legacy_in_shop_lyd_due_survives_stop_and_restop(self, actors):
        self._customer("fin_legacy_shop_stop_customer", actors)
        self._receipt(
            "fin_legacy_shop_stop_receipt",
            "fin_legacy_shop_stop_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self._mutate_ad(
            "fin_legacy_shop_stop_ad",
            "fin-legacy-shop-stop-create-001",
            {
                "customerId": "fin_legacy_shop_stop_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "fin_legacy_shop_stop_receipt",
                "dueAllocations": [
                    {
                        "receiptId": "fin_legacy_shop_stop_receipt",
                        "amountUSD": 10,
                    }
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_legacy_shop_stop_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("dueAllocations", None)
            legacy["dueAmountToUseUSD"] = 0
            legacy["dueAmountToUseLYD"] = 50
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_legacy_shop_stop_ad'"
                ),
                {"data": json_dumps(legacy), "modified": modified},
            )

        first = client.post(
            "/api/ads/fin_legacy_shop_stop_ad/stop",
            json={
                "spentMinorUSD": 600,
                "customerInformed": False,
                "idempotencyKey": "fin-legacy-shop-stop-six-001",
                "expectedLastModified": modified,
            },
            cookies=actors["admin"],
        )
        assert first.status_code == 200, first.text
        first_data = first.json()["ad"]["data"]
        assert first_data["spentUSD"] == 6
        assert first_data["dueAmountToUseUSD"] == 6
        assert first_data["dueAmountToUseLYD"] == 0
        assert first_data["dueAllocations"] == []
        assert first_data["stopAllocationBaseline"]["dueLegacy"] == 10
        assert first_data["stopAllocationBaseline"]["dueLegacyReceiptId"] == (
            "fin_legacy_shop_stop_receipt"
        )

        zero = client.post(
            "/api/ads/fin_legacy_shop_stop_ad/stop",
            json={
                "spentMinorUSD": 0,
                "customerInformed": False,
                "idempotencyKey": "fin-legacy-shop-stop-zero-001",
                "expectedLastModified": first.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert zero.status_code == 200, zero.text
        zero_data = zero.json()["ad"]["data"]
        assert zero_data["dueAmountToUseUSD"] == 0
        assert zero_data["dueAmountToUseLYD"] == 0
        assert zero_data["stopAllocationBaseline"]["dueLegacy"] == 10
        assert zero_data["stopAllocationBaseline"]["dueLegacyReceiptId"] == (
            "fin_legacy_shop_stop_receipt"
        )

        restored = client.post(
            "/api/ads/fin_legacy_shop_stop_ad/stop",
            json={
                "spentMinorUSD": 400,
                "customerInformed": False,
                "idempotencyKey": "fin-legacy-shop-stop-four-001",
                "expectedLastModified": zero.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert restored.status_code == 200, restored.text
        restored_data = restored.json()["ad"]["data"]
        assert restored_data["spentUSD"] == 4
        assert restored_data["dueAmountToUseUSD"] == 4
        assert restored_data["receiptId"] == "fin_legacy_shop_stop_receipt"

    def test_legacy_in_shop_due_refund_undo_restores_receipt_identity(self, actors):
        self._customer("fin_legacy_shop_refund_customer", actors)
        self._receipt(
            "fin_legacy_shop_refund_receipt",
            "fin_legacy_shop_refund_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self._mutate_ad(
            "fin_legacy_shop_refund_ad",
            "fin-legacy-shop-refund-create-001",
            {
                "customerId": "fin_legacy_shop_refund_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "fin_legacy_shop_refund_receipt",
                "dueAllocations": [
                    {
                        "receiptId": "fin_legacy_shop_refund_receipt",
                        "amountUSD": 10,
                    }
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_legacy_shop_refund_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("dueAllocations", None)
            legacy["dueAmountToUseUSD"] = 10
            legacy["dueAmountToUseLYD"] = 0
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_legacy_shop_refund_ad'"
                ),
                {"data": json_dumps(legacy), "modified": modified},
            )

        refunded = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_legacy_shop_refund_ad",
                "idempotencyKey": "fin-legacy-shop-refund-partial-001",
                "expectedLastModified": modified,
                "data": {
                    "refundType": "Partial",
                    "refundAmount": 4,
                    "refundStatus": "Refunded",
                },
            },
            cookies=actors["admin"],
        )
        assert refunded.status_code == 200, refunded.text
        refunded_data = refunded.json()["ad"]["data"]
        assert refunded_data["dueAllocations"] == [
            {"receiptId": "fin_legacy_shop_refund_receipt", "amountUSD": 6.0}
        ]
        assert refunded_data["refundDueBaseline"] == [
            {"receiptId": "fin_legacy_shop_refund_receipt", "amountUSD": 10.0}
        ]
        assert refunded_data["dueAmountToUseUSD"] == 6
        assert refunded_data["dueAmountToUseLYD"] == 0

        undone = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_legacy_shop_refund_ad",
                "idempotencyKey": "fin-legacy-shop-refund-undo-001",
                "expectedLastModified": refunded.json()["ad"]["lastModified"],
                "data": {"refundType": "None"},
            },
            cookies=actors["admin"],
        )
        assert undone.status_code == 200, undone.text
        undone_data = undone.json()["ad"]["data"]
        assert undone_data["refundType"] == "None"
        assert undone_data["dueAllocations"] == [
            {"receiptId": "fin_legacy_shop_refund_receipt", "amountUSD": 10.0}
        ]
        assert undone_data["dueAmountToUseUSD"] == 10
        assert undone_data["dueAmountToUseLYD"] == 0
        assert undone_data["receiptId"] == "fin_legacy_shop_refund_receipt"

    def test_client_cannot_inject_refund_baseline_to_release_paid_credit(self, actors):
        self._customer("fin_refund_baseline_guard_customer", actors)
        self._receipt(
            "fin_refund_baseline_guard_receipt",
            "fin_refund_baseline_guard_customer",
            10,
            actors,
        )
        created = self._mutate_ad(
            "fin_refund_baseline_guard_ad",
            "fin-refund-baseline-guard-create-001",
            {
                "customerId": "fin_refund_baseline_guard_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {
                        "receiptId": "fin_refund_baseline_guard_receipt",
                        "amountUSD": 10,
                    }
                ],
                # All four are server-authored history.  Persisting these
                # forged empty baselines would let a later refund undo restore
                # no allocation and make the same $10 spendable again.
                "refundAllocationBaseline": [],
                "refundDueBaseline": [],
                "refundBaselinePaymentStatus": "not_paid",
                "preRefundStatus": "Canceled",
            },
            actors,
        )
        assert created.status_code == 200, created.text
        created_data = created.json()["ad"]["data"]
        assert created_data["receiptAllocations"] == [
            {"receiptId": "fin_refund_baseline_guard_receipt", "amountUSD": 10.0}
        ]
        assert "refundAllocationBaseline" not in created_data
        assert "refundDueBaseline" not in created_data
        assert "refundBaselinePaymentStatus" not in created_data
        assert "preRefundStatus" not in created_data

        undone = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_refund_baseline_guard_ad",
                "idempotencyKey": "fin-refund-baseline-guard-undo-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
                "data": {
                    "refundType": "None",
                    "refundAllocationBaseline": [],
                    "refundDueBaseline": [],
                    "refundBaselinePaymentStatus": "not_paid",
                    "preRefundStatus": "Canceled",
                },
            },
            cookies=actors["admin"],
        )
        assert undone.status_code == 200, undone.text
        assert undone.json()["ad"]["data"]["receiptAllocations"] == [
            {"receiptId": "fin_refund_baseline_guard_receipt", "amountUSD": 10.0}
        ]

        competing = self._mutate_ad(
            "fin_refund_baseline_guard_competing_ad",
            "fin-refund-baseline-guard-competing-001",
            {
                "customerId": "fin_refund_baseline_guard_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {
                        "receiptId": "fin_refund_baseline_guard_receipt",
                        "amountUSD": 1,
                    }
                ],
            },
            actors,
        )
        assert competing.status_code == 409, competing.text

    def test_stale_refund_baseline_on_inactive_legacy_row_is_ignored(self, actors):
        self._customer("fin_stale_refund_baseline_customer", actors)
        self._receipt(
            "fin_stale_refund_baseline_receipt",
            "fin_stale_refund_baseline_customer",
            10,
            actors,
        )
        created = self._mutate_ad(
            "fin_stale_refund_baseline_ad",
            "fin-stale-refund-baseline-create-001",
            {
                "customerId": "fin_stale_refund_baseline_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {
                        "receiptId": "fin_stale_refund_baseline_receipt",
                        "amountUSD": 10,
                    }
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        # Seed the exact historical/corrupt shape that existed before refund
        # baselines became server-controlled: current funding is valid, but an
        # inactive row carries empty stale baselines and forged history.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_stale_refund_baseline_ad'"
                )
            ).mappings().first()
            stale = json.loads(row["data_json"])
            stale["refundType"] = "None"
            stale["refundAllocationBaseline"] = []
            stale["refundDueBaseline"] = []
            stale["refundBaselinePaymentStatus"] = "not_paid"
            stale["preRefundStatus"] = "Canceled"
            modified = int(row["last_modified"]) + 1
            stale["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_stale_refund_baseline_ad'"
                ),
                {"data": json_dumps(stale), "modified": modified},
            )

        undone = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_stale_refund_baseline_ad",
                "idempotencyKey": "fin-stale-refund-baseline-undo-001",
                "expectedLastModified": modified,
                "data": {"refundType": "None"},
            },
            cookies=actors["admin"],
        )
        assert undone.status_code == 200, undone.text
        data = undone.json()["ad"]["data"]
        assert data["receiptAllocations"] == [
            {"receiptId": "fin_stale_refund_baseline_receipt", "amountUSD": 10.0}
        ]
        assert data["status"] == "Active"
        assert data["refundAllocationBaseline"] is None
        assert data["refundDueBaseline"] is None
        assert "refundBaselinePaymentStatus" not in data
        assert "preRefundStatus" not in data

        competing = self._mutate_ad(
            "fin_stale_refund_baseline_competing_ad",
            "fin-stale-refund-baseline-competing-001",
            {
                "customerId": "fin_stale_refund_baseline_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {
                        "receiptId": "fin_stale_refund_baseline_receipt",
                        "amountUSD": 1,
                    }
                ],
            },
            actors,
        )
        assert competing.status_code == 409, competing.text

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

    def test_finished_ad_reconciliation_records_customer_notification_once(self, actors):
        self._customer("fin_reconcile_customer", actors)
        self._receipt(
            "fin_reconcile_receipt", "fin_reconcile_customer", 25, actors
        )
        created = self._mutate_ad(
            "fin_reconcile_ad",
            "fin-reconcile-create-001",
            {
                "customerId": "fin_reconcile_customer",
                "paymentStatus": "paid",
                "exchangeRate": 5,
                "startDate": "1999-12-20T00:00:00Z",
                "endDate": "2000-01-01T00:00:00Z",
                "receiptAllocations": [
                    {"receiptId": "fin_reconcile_receipt", "amountUSD": 25}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        # "Completed" can mean the driver's payment collection was finished.
        # A past-end-date ad must still be reconcilable without losing its paid flag.
        completed = client.patch(
            "/api/collections/ads/fin_reconcile_ad",
            json={
                "data": {
                    "isPaid": True,
                    "status": "Completed",
                    "collectionDate": "2000-01-02T00:00:00Z",
                    "deliveryStatus": "Delivered",
                }
            },
            cookies=actors["admin"],
        )
        assert completed.status_code == 200, completed.text

        first = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json={
                "spentMinorUSD": 2000,
                "customerInformed": False,
                "idempotencyKey": "fin-reconcile-stop-001",
                "expectedLastModified": completed.json()["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert first.status_code == 200, first.text
        first_data = first.json()["ad"]["data"]
        assert first_data["status"] == "Stopped"
        assert first_data["isPaid"] is True
        assert first_data["spentUSD"] == 20.0
        assert first_data["receiptAllocations"] == [
            {"receiptId": "fin_reconcile_receipt", "amountUSD": 20.0}
        ]
        assert first_data["remainingCustomerInformed"] is False
        assert "remainingCustomerInformedAt" not in first_data

        informed = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json={
                "spentMinorUSD": 2000,
                "customerInformed": True,
                "idempotencyKey": "fin-reconcile-stop-002",
                "expectedLastModified": first.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert informed.status_code == 200, informed.text
        informed_data = informed.json()["ad"]["data"]
        assert informed_data["remainingCustomerInformed"] is True
        assert informed_data["remainingCustomerInformedBy"] == actors["admin_user"]["id"]
        first_informed_at = informed_data["remainingCustomerInformedAt"]
        assert first_informed_at

        cannot_erase = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json={
                "spentMinorUSD": 2000,
                "customerInformed": False,
                "idempotencyKey": "fin-reconcile-stop-003",
                "expectedLastModified": informed.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert cannot_erase.status_code == 200, cannot_erase.text
        final_data = cannot_erase.json()["ad"]["data"]
        assert final_data["remainingCustomerInformed"] is True
        assert final_data["remainingCustomerInformedAt"] == first_informed_at

        changed_and_reconfirmed = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json={
                "spentMinorUSD": 2100,
                "customerInformed": True,
                "idempotencyKey": "fin-reconcile-stop-004",
                "expectedLastModified": cannot_erase.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert changed_and_reconfirmed.status_code == 200, changed_and_reconfirmed.text
        reconfirmed_data = changed_and_reconfirmed.json()["ad"]["data"]
        assert reconfirmed_data["remainingCustomerInformed"] is True
        assert reconfirmed_data["remainingCustomerInformedAt"] != first_informed_at
        assert reconfirmed_data["remainingCustomerInformedBy"] == actors["admin_user"]["id"]

        changed_without_confirmation_payload = {
            "spentMinorUSD": 2200,
            "customerInformed": False,
            "idempotencyKey": "fin-reconcile-stop-005",
            "expectedLastModified": changed_and_reconfirmed.json()["ad"]["lastModified"],
        }
        changed_without_confirmation = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json=changed_without_confirmation_payload,
            cookies=actors["admin"],
        )
        changed_without_confirmation_replay = client.post(
            "/api/ads/fin_reconcile_ad/stop",
            json=changed_without_confirmation_payload,
            cookies=actors["admin"],
        )
        assert changed_without_confirmation.status_code == 200, changed_without_confirmation.text
        assert changed_without_confirmation_replay.status_code == 200
        assert changed_without_confirmation_replay.json()["replayed"] is True
        changed_data = changed_without_confirmation.json()["ad"]["data"]
        assert changed_data["remainingCustomerInformed"] is False
        assert "remainingCustomerInformedAt" not in changed_data
        assert "remainingCustomerInformedBy" not in changed_data

        forged = client.patch(
            "/api/collections/ads/fin_reconcile_ad",
            json={"data": {"remainingCustomerInformed": False}},
            cookies=actors["admin"],
        )
        assert forged.status_code == 405

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

    def test_cancel_releases_legacy_in_shop_due_mirror(self, actors):
        self._customer("fin_legacy_shop_cancel_customer", actors)
        receipt = self._receipt(
            "fin_legacy_shop_cancel_receipt",
            "fin_legacy_shop_cancel_customer",
            25,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self._mutate_ad(
            "fin_legacy_shop_cancel_ad",
            "fin-legacy-shop-cancel-create-001",
            {
                "customerId": "fin_legacy_shop_cancel_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "fin_legacy_shop_cancel_receipt",
                "dueAllocations": [
                    {
                        "receiptId": "fin_legacy_shop_cancel_receipt",
                        "amountUSD": 25,
                    }
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        # Old In-Shop rows stored debt only in the LYD mirror and receiptId;
        # they had neither a due-allocation row nor linkedDeliveryReceiptId.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_legacy_shop_cancel_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("dueAllocations", None)
            legacy["dueAmountToUseUSD"] = 0
            legacy["dueAmountToUseLYD"] = 125
            legacy["linkedDeliveryReceiptId"] = ""
            legacy_modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = legacy_modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_legacy_shop_cancel_ad'"
                ),
                {"data": json_dumps(legacy), "modified": legacy_modified},
            )

        canceled = client.patch(
            "/api/collections/receipts/fin_legacy_shop_cancel_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Canceled", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert canceled.status_code == 200, canceled.text
        assert canceled.json()["data"]["status"] == "Canceled"

        saved_ad = client.get(
            "/api/collections/ads/fin_legacy_shop_cancel_ad",
            cookies=actors["admin"],
        )
        assert saved_ad.status_code == 200
        saved_data = saved_ad.json()["data"]
        assert saved_ad.json()["lastModified"] > legacy_modified
        assert saved_data["dueAllocations"] == []
        assert saved_data["dueAmountToUseUSD"] == 0
        assert saved_data["dueAmountToUseLYD"] == 0
        assert saved_data["receiptId"] == ""

    def test_unfunded_driver_budget_is_debt_until_exact_paid_settlement(self, actors):
        self._customer("fin_driver_debt_customer", actors)
        self._receipt(
            "fin_driver_debt_delivery",
            "fin_driver_debt_customer",
            200,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=1000,
            debtAmountLocal=1000,
            debtAmountUSD=200,
            tempReceiptNo="D71001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        self._receipt(
            "fin_driver_debt_paid", "fin_driver_debt_customer", 100, actors
        )

        # Allocations are optional funding sources for a Driver ad; they can
        # never be larger than the independently entered ad budget.
        over_budget = self._mutate_ad(
            "fin_driver_debt_over_budget",
            "fin-driver-debt-over-budget-001",
            {
                "customerId": "fin_driver_debt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 50,
                "linkedDeliveryReceiptId": "fin_driver_debt_delivery",
                "receiptId": "fin_driver_debt_delivery",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [
                    {
                        "receiptId": "fin_driver_debt_delivery",
                        "amountUSD": 60,
                    }
                ],
            },
            actors,
        )
        assert over_budget.status_code == 400, over_budget.text

        # This is a real $100 ad even though no receipt balance funds it yet.
        created = self._mutate_ad(
            "fin_driver_debt_ad",
            "fin-driver-debt-create-001",
            {
                "customerId": "fin_driver_debt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 100,
                "linkedDeliveryReceiptId": "fin_driver_debt_delivery",
                "receiptId": "fin_driver_debt_delivery",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        created_data = created.json()["ad"]["data"]
        assert created_data["amountUSD"] == 100
        assert created_data["amountLocal"] == 500
        assert created_data["paymentStatus"] == "not_paid"
        assert created_data["isPaid"] is False
        assert created_data["receiptAllocations"] == []
        assert created_data["dueAllocations"] == []
        assert created_data["linkedDeliveryReceiptId"] == "fin_driver_debt_delivery"
        assert "driverBudgetUSD" not in created_data

        # Older clients do not echo the transient budget on unrelated edits;
        # the server must preserve the stored debt amount.
        preserved = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_driver_debt_ad",
                "idempotencyKey": "fin-driver-debt-preserve-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
                "data": {"note": "budget stays independent"},
            },
            cookies=actors["admin"],
        )
        assert preserved.status_code == 200, preserved.text
        preserved_data = preserved.json()["ad"]["data"]
        assert preserved_data["amountUSD"] == 100
        assert "driverBudgetUSD" not in preserved_data
        version = preserved.json()["ad"]["lastModified"]

        # Marking the debt Paid with only $60 would otherwise erase the unpaid
        # $40 by shrinking the ad amount to the allocation total.
        underpaid = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_driver_debt_ad",
                "idempotencyKey": "fin-driver-debt-underpay-001",
                "expectedLastModified": version,
                "data": {
                    "paymentStatus": "paid",
                    "receiptAllocations": [
                        {"receiptId": "fin_driver_debt_paid", "amountUSD": 60}
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert underpaid.status_code == 400, underpaid.text
        still_debt = client.get(
            "/api/collections/ads/fin_driver_debt_ad", cookies=actors["admin"]
        )
        assert still_debt.status_code == 200
        assert still_debt.json()["data"]["amountUSD"] == 100
        assert still_debt.json()["data"]["paymentStatus"] == "not_paid"

        settled = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_driver_debt_ad",
                "idempotencyKey": "fin-driver-debt-settle-001",
                "expectedLastModified": version,
                "data": {
                    "paymentStatus": "paid",
                    "receiptAllocations": [
                        {"receiptId": "fin_driver_debt_paid", "amountUSD": 100}
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        settled_data = settled.json()["ad"]["data"]
        assert settled_data["amountUSD"] == 100
        assert settled_data["amountLocal"] == 500
        assert settled_data["paymentStatus"] == "paid"
        assert settled_data["isPaid"] is True
        assert settled_data["collectionMethod"] == ""
        assert settled_data["linkedDeliveryReceiptId"] == ""
        assert settled_data["receiptAllocations"] == [
            {"receiptId": "fin_driver_debt_paid", "amountUSD": 100.0}
        ]
        assert "driverBudgetUSD" not in settled_data

    def test_driver_due_ad_can_settle_from_same_receipt_after_delivery(self, actors):
        self._customer("fin_driver_same_receipt_customer", actors)
        self._receipt(
            "fin_driver_same_receipt",
            "fin_driver_same_receipt_customer",
            100,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=500,
            debtAmountLocal=500,
            debtAmountUSD=100,
            tempReceiptNo="D72001",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        created = self._mutate_ad(
            "fin_driver_same_receipt_ad",
            "fin-driver-same-receipt-create-001",
            {
                "customerId": "fin_driver_same_receipt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 100,
                "linkedDeliveryReceiptId": "fin_driver_same_receipt",
                "receiptId": "fin_driver_same_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [
                    {"receiptId": "fin_driver_same_receipt", "amountUSD": 100}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        accepted = client.patch(
            "/api/collections/receipts/fin_driver_same_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        )
        assert accepted.status_code == 200, accepted.text
        completed = client.patch(
            "/api/collections/receipts/fin_driver_same_receipt",
            json={
                "data": {
                    "deliveryStatus": "Delivered",
                    "finalReceiptNo": "772001",
                    "receiptImage": "data:image/png;base64,AAAA",
                    "amountCollectedFromCustomer": 500,
                    "actualDeliveryFeeCollected": 0,
                }
            },
            cookies=actors["driver_cookies"],
        )
        assert completed.status_code == 200, completed.text
        completed_data = completed.json()["data"]
        assert completed_data["deliveryStatus"] == "Delivered"
        assert completed_data["status"] == "Paid"
        assert completed_data["isPaid"] is True
        assert completed_data["paymentResult"] == "PAID_EXACT"
        assert completed_data["finalReceiptNo"] == "772001"
        assert completed_data["amountUSD"] == 100

        # Receipt completion and the ad funding conversion are one transaction.
        current = client.get(
            "/api/collections/ads/fin_driver_same_receipt_ad",
            cookies=actors["admin"],
        )
        assert current.status_code == 200, current.text
        settled_data = current.json()["data"]
        assert settled_data["paymentStatus"] == "paid"
        assert settled_data["isPaid"] is True
        assert settled_data["receiptAllocations"] == [
            {"receiptId": "fin_driver_same_receipt", "amountUSD": 100.0}
        ]
        assert settled_data["dueAllocations"] == []
        assert settled_data["mergedPaidAllocations"] == []
        assert settled_data["dueAmountToUseUSD"] == 0
        assert settled_data["linkedDeliveryReceiptId"] == ""
        assert settled_data["receiptId"] == "fin_driver_same_receipt"

    def test_in_shop_ad_can_mix_paid_credit_with_unpaid_receipt_debt(self, actors):
        self._customer("fin_mixed_shop_customer", actors)
        self._receipt(
            "fin_mixed_shop_paid",
            "fin_mixed_shop_customer",
            4.63,
            actors,
            exchangeRate=9.7,
            amountLocal=44.91,
        )
        unpaid = self._receipt(
            "fin_mixed_shop_unpaid",
            "fin_mixed_shop_customer",
            0.37,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=3.59,
            exchangeRate=9.7,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )

        created = self._mutate_ad(
            "fin_mixed_shop_ad",
            "fin-mixed-shop-create-001",
            {
                "customerId": "fin_mixed_shop_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 1,
                "receiptId": "fin_mixed_shop_unpaid",
                "receiptAllocations": [
                    {"receiptId": "fin_mixed_shop_paid", "amountUSD": 4.63}
                ],
                "mergedPaidAllocations": [],
                "dueAllocations": [
                    {"receiptId": "fin_mixed_shop_unpaid", "amountUSD": 0.37}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        data = created.json()["ad"]["data"]
        assert data["amountUSD"] == 5.0
        assert data["amountLocal"] == 48.5
        assert data["paymentStatus"] == "not_paid"
        assert data["isPaid"] is False
        assert data["collectionMethod"] == "in_shop"
        assert data["receiptId"] == "fin_mixed_shop_unpaid"
        assert data["fundingReceiptId"] == "fin_mixed_shop_paid"
        assert data["receiptIds"] == ["fin_mixed_shop_paid"]
        assert data["receiptAllocations"] == [
            {"receiptId": "fin_mixed_shop_paid", "amountUSD": 4.63}
        ]
        assert data["dueAllocations"] == [
            {"receiptId": "fin_mixed_shop_unpaid", "amountUSD": 0.37}
        ]
        assert data["dueAmountToUseUSD"] == 0.37
        assert data["mergedPaidAllocations"] == []

        # Neither half may be handed to another ad a second time.
        reused_paid = self._mutate_ad(
            "fin_mixed_shop_reuse_paid",
            "fin-mixed-shop-reuse-paid-001",
            {
                "customerId": "fin_mixed_shop_customer",
                "paymentStatus": "paid",
                "receiptAllocations": [
                    {"receiptId": "fin_mixed_shop_paid", "amountUSD": 0.01}
                ],
            },
            actors,
        )
        assert reused_paid.status_code == 409, reused_paid.text
        reused_due = self._mutate_ad(
            "fin_mixed_shop_reuse_due",
            "fin-mixed-shop-reuse-due-001",
            {
                "customerId": "fin_mixed_shop_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_mixed_shop_unpaid",
                "dueAllocations": [
                    {"receiptId": "fin_mixed_shop_unpaid", "amountUSD": 0.01}
                ],
            },
            actors,
        )
        assert reused_due.status_code == 409, reused_due.text

        # A malicious/stale request cannot call an ad Paid while retaining a
        # hidden unpaid allocation.
        disguised_debt = self._mutate_ad(
            "fin_mixed_shop_disguised",
            "fin-mixed-shop-disguised-001",
            {
                "customerId": "fin_mixed_shop_customer",
                "paymentStatus": "paid",
                "receiptAllocations": [
                    {"receiptId": "fin_mixed_shop_paid", "amountUSD": 0.01}
                ],
                "dueAllocations": [
                    {"receiptId": "fin_mixed_shop_unpaid", "amountUSD": 0.01}
                ],
            },
            actors,
        )
        assert disguised_debt.status_code == 400, disguised_debt.text

        paid_unpaid_receipt = client.patch(
            "/api/collections/receipts/fin_mixed_shop_unpaid",
            json={
                "expectedLastModified": unpaid["lastModified"],
                "data": {"status": "Paid", "isPaid": True},
            },
            cookies=actors["admin"],
        )
        assert paid_unpaid_receipt.status_code == 200, paid_unpaid_receipt.text

        settled = client.get(
            "/api/collections/ads/fin_mixed_shop_ad", cookies=actors["admin"]
        )
        assert settled.status_code == 200, settled.text
        settled_data = settled.json()["data"]
        assert settled_data["amountUSD"] == 5.0
        assert settled_data["paymentStatus"] == "paid"
        assert settled_data["isPaid"] is True
        assert settled_data["collectionMethod"] == ""
        assert settled_data["dueAllocations"] == []
        assert settled_data["dueAmountToUseUSD"] == 0

    def test_mixed_in_shop_reconciliation_releases_debt_before_paid_credit(self, actors):
        self._customer("fin_mixed_stop_customer", actors)
        self._receipt(
            "fin_mixed_stop_paid", "fin_mixed_stop_customer", 4.63, actors
        )
        self._receipt(
            "fin_mixed_stop_unpaid",
            "fin_mixed_stop_customer",
            0.37,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self._mutate_ad(
            "fin_mixed_stop_ad",
            "fin-mixed-stop-create-001",
            {
                "customerId": "fin_mixed_stop_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "receiptId": "fin_mixed_stop_unpaid",
                "receiptAllocations": [
                    {"receiptId": "fin_mixed_stop_paid", "amountUSD": 4.63}
                ],
                "dueAllocations": [
                    {"receiptId": "fin_mixed_stop_unpaid", "amountUSD": 0.37}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        stopped = client.post(
            "/api/ads/fin_mixed_stop_ad/stop",
            json={
                "spentMinorUSD": 450,
                "customerInformed": True,
                "idempotencyKey": "fin-mixed-stop-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert stopped.status_code == 200, stopped.text
        stopped_data = stopped.json()["ad"]["data"]
        assert stopped_data["amountUSD"] == 5.0
        assert stopped_data["spentUSD"] == 4.5
        assert stopped_data["receiptAllocations"] == [
            {"receiptId": "fin_mixed_stop_paid", "amountUSD": 4.5}
        ]
        assert stopped_data["dueAllocations"] == []
        assert stopped_data["dueAmountToUseUSD"] == 0
        assert stopped_data["remainingCustomerInformed"] is True

    def test_unpaid_in_shop_receipt_is_debt_until_exact_paid_settlement(self, actors):
        self._customer("fin_shop_debt_customer", actors)
        receipt = self._receipt(
            "fin_shop_debt_receipt",
            "fin_shop_debt_customer",
            30,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=291,
            exchangeRate=9.7,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )

        overdrawn = self._mutate_ad(
            "fin_shop_debt_overdrawn",
            "fin-shop-debt-overdrawn-001",
            {
                "customerId": "fin_shop_debt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 1,
                "receiptId": "fin_shop_debt_receipt",
                "receiptAllocations": [],
                "dueAllocations": [
                    {"receiptId": "fin_shop_debt_receipt", "amountUSD": 30.01}
                ],
            },
            actors,
        )
        assert overdrawn.status_code == 409, overdrawn.text

        created = self._mutate_ad(
            "fin_shop_debt_ad",
            "fin-shop-debt-create-001",
            {
                "customerId": "fin_shop_debt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                # The server must use the linked receipt's rate, not this value.
                "exchangeRate": 1,
                "receiptId": "fin_shop_debt_receipt",
                "receiptAllocations": [],
                "mergedPaidAllocations": [],
                "dueAllocations": [
                    {"receiptId": "fin_shop_debt_receipt", "amountUSD": 30}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        created_data = created.json()["ad"]["data"]
        assert created_data["amountUSD"] == 30
        assert created_data["exchangeRate"] == 9.7
        assert created_data["amountLocal"] == 291
        assert created_data["paymentStatus"] == "not_paid"
        assert created_data["collectionMethod"] == "in_shop"
        assert created_data["isPaid"] is False
        assert created_data["receiptId"] == "fin_shop_debt_receipt"
        assert created_data["linkedDeliveryReceiptId"] == ""
        assert created_data["receiptAllocations"] == []
        assert created_data["dueAllocations"] == [
            {"receiptId": "fin_shop_debt_receipt", "amountUSD": 30.0}
        ]
        assert created_data["dueAmountToUseUSD"] == 30

        second_draw = self._mutate_ad(
            "fin_shop_debt_second_ad",
            "fin-shop-debt-second-001",
            {
                "customerId": "fin_shop_debt_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_shop_debt_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_shop_debt_receipt", "amountUSD": 0.01}
                ],
            },
            actors,
        )
        assert second_draw.status_code == 409, second_draw.text

        paid_receipt = client.patch(
            "/api/collections/receipts/fin_shop_debt_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Paid", "isPaid": True},
            },
            cookies=actors["admin"],
        )
        assert paid_receipt.status_code == 200, paid_receipt.text
        assert paid_receipt.json()["data"]["status"] == "Paid"
        assert paid_receipt.json()["data"]["isPaid"] is True

        settled = client.get(
            "/api/collections/ads/fin_shop_debt_ad", cookies=actors["admin"]
        )
        assert settled.status_code == 200, settled.text
        settled_data = settled.json()["data"]
        assert settled_data["amountUSD"] == 30
        assert settled_data["amountLocal"] == 291
        assert settled_data["paymentStatus"] == "paid"
        assert settled_data["isPaid"] is True
        assert settled_data["collectionMethod"] == ""
        assert settled_data["receiptId"] == "fin_shop_debt_receipt"
        assert settled_data["linkedDeliveryReceiptId"] == ""
        assert settled_data["dueAllocations"] == []
        assert settled_data["dueAmountToUseUSD"] == 0
        assert settled_data["receiptAllocations"] == [
            {"receiptId": "fin_shop_debt_receipt", "amountUSD": 30.0}
        ]

    def test_canceling_shop_receipt_preserves_ad_debt_on_later_edit(self, actors):
        self._customer("fin_shop_cancel_customer", actors)
        receipt = self._receipt(
            "fin_shop_cancel_receipt",
            "fin_shop_cancel_customer",
            30,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=291,
            exchangeRate=9.7,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self._mutate_ad(
            "fin_shop_cancel_ad",
            "fin-shop-cancel-create-001",
            {
                "customerId": "fin_shop_cancel_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_shop_cancel_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_shop_cancel_receipt", "amountUSD": 30}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        canceled = client.patch(
            "/api/collections/receipts/fin_shop_cancel_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Canceled"},
            },
            cookies=actors["admin"],
        )
        assert canceled.status_code == 200, canceled.text

        released = client.get(
            "/api/collections/ads/fin_shop_cancel_ad", cookies=actors["admin"]
        )
        assert released.status_code == 200, released.text
        released_data = released.json()["data"]
        assert released_data["amountUSD"] == 30
        assert released_data["amountLocal"] == 291
        assert released_data["receiptId"] == ""
        assert released_data["dueAllocations"] == []

        # A normal form save echoes an empty manual-payment list after the
        # canceled receipt link disappears. That must not erase the $30 debt.
        preserved = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_shop_cancel_ad",
                "idempotencyKey": "fin-shop-cancel-preserve-001",
                "expectedLastModified": released.json()["lastModified"],
                "data": {
                    "note": "receipt canceled; debt remains",
                    "collectionPayments": [],
                },
            },
            cookies=actors["admin"],
        )
        assert preserved.status_code == 200, preserved.text
        preserved_data = preserved.json()["ad"]["data"]
        assert preserved_data["amountUSD"] == 30
        assert preserved_data["amountLocal"] == 291
        assert preserved_data["paymentStatus"] == "not_paid"
        assert preserved_data["collectionMethod"] == "in_shop"
        assert preserved_data["receiptId"] == ""
        assert preserved_data["dueAllocations"] == []

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


class TestReceiptPaidCascade:
    """Receipt payment and every linked money move are one atomic operation."""

    tx = TestReceiptAndAdTransactions

    def test_settlement_cannot_bypass_temp_delivery_proof_workflow(self, actors):
        self.tx._customer("fin_settle_guard_customer", actors)
        delivery_user, delivery_cookies = _create_user(
            actors["admin"],
            email="hardening-settlement-driver@tests.albayanhub.com",
            role="Delivery",
            permissions={
                "receipts": ["view", "edit"],
                "deliveries": ["view", "viewOwn", "accept", "complete"],
            },
        )
        receipt = self.tx._receipt(
            "fin_settle_guard_receipt",
            "fin_settle_guard_customer",
            20,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=100,
            debtAmountLocal=100,
            debtAmountUSD=20,
            tempReceiptNo="D79991",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=delivery_user["id"],
        )
        created = self.tx._mutate_ad(
            "fin_settle_guard_ad",
            "fin-settle-guard-create-001",
            {
                "customerId": "fin_settle_guard_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 20,
                "linkedDeliveryReceiptId": "fin_settle_guard_receipt",
                "receiptId": "fin_settle_guard_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_guard_receipt", "amountUSD": 20}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        # Even an accidentally over-granted assigned driver must use the
        # strict generic Delivered flow, which verifies proof and collection.
        driver_rejected = client.post(
            "/api/receipts/fin_settle_guard_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-guard-driver-001",
                "data": {"collectionDate": "2026-07-22T01:00:00Z"},
            },
            cookies=delivery_cookies,
        )
        assert driver_rejected.status_code == 403, driver_rejected.text

        # An office/admin settlement must not combine "mark paid" with a
        # first-time delivery completion.  That transition belongs to the
        # assigned driver's verified proof workflow too.
        admin_rejected = client.post(
            "/api/receipts/fin_settle_guard_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-guard-admin-001",
                "data": {
                    "deliveryStatus": "Delivered",
                    "finalReceiptNo": "79991",
                    "serialNumber": "79991",
                    "receiptImage": "data:image/jpeg;base64,YQ==",
                    "amountCollectedFromCustomer": 100,
                    "actualDeliveryFeeCollected": 0,
                },
            },
            cookies=actors["admin"],
        )
        assert admin_rejected.status_code == 403, admin_rejected.text

        stored_receipt = client.get(
            "/api/collections/receipts/fin_settle_guard_receipt",
            cookies=actors["admin"],
        )
        stored_ad = client.get(
            "/api/collections/ads/fin_settle_guard_ad",
            cookies=actors["admin"],
        )
        assert stored_receipt.status_code == 200
        assert stored_ad.status_code == 200
        assert stored_receipt.json()["lastModified"] == receipt["lastModified"]
        receipt_data = stored_receipt.json()["data"]
        assert receipt_data["status"] == "Not Paid"
        assert receipt_data["isPaid"] is False
        assert receipt_data["deliveryStatus"] == "Needs Delivery"
        assert not receipt_data.get("finalReceiptNo")
        assert not receipt_data.get("receiptImage")
        assert stored_ad.json()["lastModified"] == created.json()["ad"]["lastModified"]
        assert stored_ad.json()["data"]["paymentStatus"] == "not_paid"
        assert stored_ad.json()["data"]["dueAllocations"] == [
            {"receiptId": "fin_settle_guard_receipt", "amountUSD": 20.0}
        ]

    def test_settlement_updates_hidden_ads_without_disclosing_them(self, actors):
        self.tx._customer("fin_settle_hidden_customer", actors)
        editor, editor_cookies = _create_user(
            actors["admin"],
            email="hardening-settlement-editor@tests.albayanhub.com",
            permissions={"receipts": ["view", "edit"]},
        )
        receipt = self.tx._receipt(
            "fin_settle_hidden_receipt",
            "fin_settle_hidden_customer",
            20,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self.tx._mutate_ad(
            "fin_settle_hidden_ad",
            "fin-settle-hidden-create-001",
            {
                "customerId": "fin_settle_hidden_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_settle_hidden_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_hidden_receipt", "amountUSD": 20}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        settled = client.post(
            "/api/receipts/fin_settle_hidden_receipt/settle?include_media=false",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-hidden-paid-001",
            },
            cookies=editor_cookies,
        )
        assert settled.status_code == 200, settled.text
        assert settled.json()["receipt"]["data"]["status"] == "Paid"
        assert settled.json()["updatedAds"] == []
        forbidden = client.get(
            "/api/collections/ads/fin_settle_hidden_ad", cookies=editor_cookies
        )
        assert forbidden.status_code == 403

        # The response is filtered, not the transaction: the hidden linked ad
        # was still converted atomically on the server.
        stored_ad = client.get(
            "/api/collections/ads/fin_settle_hidden_ad", cookies=actors["admin"]
        )
        assert stored_ad.status_code == 200
        assert stored_ad.json()["data"]["paymentStatus"] == "paid"
        assert stored_ad.json()["data"]["dueAllocations"] == []
        assert editor["id"]

    def test_settlement_response_honors_ads_view_own_scope(self, actors):
        self.tx._customer("fin_settle_view_own_customer", actors)
        viewer, viewer_cookies = _create_user(
            actors["admin"],
            email="hardening-settlement-view-own@tests.albayanhub.com",
            permissions={
                "receipts": ["view", "edit"],
                "ads": ["viewOwn"],
            },
        )
        receipt = self.tx._receipt(
            "fin_settle_view_own_receipt",
            "fin_settle_view_own_customer",
            40,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created_ads = {}
        for suffix in ("own", "other"):
            response = self.tx._mutate_ad(
                f"fin_settle_view_own_ad_{suffix}",
                f"fin-settle-view-own-create-{suffix}-001",
                {
                    "customerId": "fin_settle_view_own_customer",
                    "paymentStatus": "not_paid",
                    "collectionMethod": "in_shop",
                    "receiptId": "fin_settle_view_own_receipt",
                    "dueAllocations": [
                        {
                            "receiptId": "fin_settle_view_own_receipt",
                            "amountUSD": 20,
                        }
                    ],
                },
                actors,
            )
            assert response.status_code == 200, response.text
            created_ads[suffix] = response.json()["ad"]

        with db_conn() as conn:
            conn.execute(
                text(
                    "UPDATE entities SET created_by=:creator "
                    "WHERE type='ads' AND id='fin_settle_view_own_ad_own'"
                ),
                {"creator": viewer["id"]},
            )

        settled = client.post(
            "/api/receipts/fin_settle_view_own_receipt/settle?include_media=false",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-view-own-paid-001",
            },
            cookies=viewer_cookies,
        )
        assert settled.status_code == 200, settled.text
        assert [item["id"] for item in settled.json()["updatedAds"]] == [
            "fin_settle_view_own_ad_own"
        ]
        own = client.get(
            "/api/collections/ads/fin_settle_view_own_ad_own",
            cookies=viewer_cookies,
        )
        other = client.get(
            "/api/collections/ads/fin_settle_view_own_ad_other",
            cookies=viewer_cookies,
        )
        assert own.status_code == 200
        assert other.status_code == 403

        # Both ads changed; only the creator-owned one crossed the response
        # authorization boundary.
        for suffix in ("own", "other"):
            stored = client.get(
                f"/api/collections/ads/fin_settle_view_own_ad_{suffix}",
                cookies=actors["admin"],
            )
            assert stored.status_code == 200
            assert stored.json()["data"]["paymentStatus"] == "paid"
            assert stored.json()["data"]["dueAllocations"] == []
        assert set(created_ads) == {"own", "other"}

    def test_settlement_updates_multiple_ads_and_replays_exactly_once(self, actors):
        self.tx._customer("fin_settle_many_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_many_receipt",
            "fin_settle_many_customer",
            100,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        for suffix, amount in (("one", 30), ("two", 20)):
            created = self.tx._mutate_ad(
                f"fin_settle_many_ad_{suffix}",
                f"fin-settle-many-create-{suffix}-001",
                {
                    "customerId": "fin_settle_many_customer",
                    "paymentStatus": "not_paid",
                    "collectionMethod": "in_shop",
                    "receiptId": "fin_settle_many_receipt",
                    "dueAllocations": [
                        {
                            "receiptId": "fin_settle_many_receipt",
                            "amountUSD": amount,
                        }
                    ],
                },
                actors,
            )
            assert created.status_code == 200, created.text

        payload = {
            "expectedLastModified": receipt["lastModified"],
            "idempotencyKey": "fin-settle-many-paid-001",
            "data": {"collectionDate": "2026-07-22T00:00:00Z"},
        }
        settled = client.post(
            "/api/receipts/fin_settle_many_receipt/settle",
            json=payload,
            cookies=actors["admin"],
        )
        replay = client.post(
            "/api/receipts/fin_settle_many_receipt/settle",
            json=payload,
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        assert replay.status_code == 200, replay.text
        assert settled.json()["replayed"] is False
        assert replay.json()["replayed"] is True
        assert settled.json()["receipt"]["data"]["status"] == "Paid"
        assert settled.json()["receipt"]["data"]["isPaid"] is True
        assert {item["id"] for item in settled.json()["updatedAds"]} == {
            "fin_settle_many_ad_one",
            "fin_settle_many_ad_two",
        }
        assert {item["id"] for item in replay.json()["updatedAds"]} == {
            "fin_settle_many_ad_one",
            "fin_settle_many_ad_two",
        }
        for item in settled.json()["updatedAds"]:
            data = item["data"]
            assert data["paymentStatus"] == "paid"
            assert data["isPaid"] is True
            assert data["dueAllocations"] == []
            assert data["receiptAllocations"][0]["receiptId"] == "fin_settle_many_receipt"

    def test_partial_due_converts_but_zero_due_link_does_not_mint_money(self, actors):
        self.tx._customer("fin_settle_partial_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_partial_receipt",
            "fin_settle_partial_customer",
            30,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=150,
            debtAmountLocal=150,
            debtAmountUSD=30,
            tempReceiptNo="D79901",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        partial = self.tx._mutate_ad(
            "fin_settle_partial_ad",
            "fin-settle-partial-create-001",
            {
                "customerId": "fin_settle_partial_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 30,
                "linkedDeliveryReceiptId": "fin_settle_partial_receipt",
                "receiptId": "fin_settle_partial_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_partial_receipt", "amountUSD": 20}
                ],
            },
            actors,
        )
        assert partial.status_code == 200, partial.text
        link_only = self.tx._mutate_ad(
            "fin_settle_link_only_ad",
            "fin-settle-link-only-create-001",
            {
                "customerId": "fin_settle_partial_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 30,
                "linkedDeliveryReceiptId": "fin_settle_partial_receipt",
                "receiptId": "fin_settle_partial_receipt",
                "receiptAllocations": [],
                "dueAllocations": [],
            },
            actors,
        )
        assert link_only.status_code == 200, link_only.text

        # Reproduce the pre-allocation legacy shape: no ledger keys at all, a
        # collection/provenance link, and a budget much larger than the linked
        # receipt.  Zero explicit due must neither mint money nor falsely
        # consume the whole legacy ad budget during the settlement precheck.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_settle_link_only_ad'"
                )
            ).mappings().first()
            legacy_link = json.loads(row["data_json"])
            legacy_link.pop("receiptAllocations", None)
            legacy_link.pop("dueAllocations", None)
            legacy_link["amountUSD"] = 300
            legacy_link["spentUSD"] = 300
            legacy_link["dueAmountToUseUSD"] = 0
            legacy_link["dueAmountToUseLYD"] = 0
            legacy_link_modified = int(row["last_modified"]) + 1
            legacy_link["_lastModified"] = legacy_link_modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_settle_link_only_ad'"
                ),
                {
                    "data": json_dumps(legacy_link),
                    "modified": legacy_link_modified,
                },
            )

        settled = client.post(
            "/api/receipts/fin_settle_partial_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-partial-paid-001",
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        assert [item["id"] for item in settled.json()["updatedAds"]] == [
            "fin_settle_partial_ad"
        ]
        partial_data = settled.json()["updatedAds"][0]["data"]
        assert partial_data["paymentStatus"] == "not_paid"
        assert partial_data["receiptAllocations"] == [
            {"receiptId": "fin_settle_partial_receipt", "amountUSD": 20.0}
        ]
        assert partial_data["dueAllocations"] == []
        untouched = client.get(
            "/api/collections/ads/fin_settle_link_only_ad",
            cookies=actors["admin"],
        )
        assert untouched.status_code == 200
        assert untouched.json()["lastModified"] == legacy_link_modified
        assert untouched.json()["data"]["paymentStatus"] == "not_paid"
        assert untouched.json()["data"].get("receiptAllocations", []) == []

    def test_insufficient_paid_amount_rolls_back_receipt_and_ad(self, actors):
        self.tx._customer("fin_settle_rollback_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_rollback_receipt",
            "fin_settle_rollback_customer",
            80,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self.tx._mutate_ad(
            "fin_settle_rollback_ad",
            "fin-settle-rollback-create-001",
            {
                "customerId": "fin_settle_rollback_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_settle_rollback_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_rollback_receipt", "amountUSD": 80}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        rejected = client.post(
            "/api/receipts/fin_settle_rollback_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-rollback-paid-001",
                "data": {"amountUSD": 50},
            },
            cookies=actors["admin"],
        )
        assert rejected.status_code == 409, rejected.text
        stored_receipt = client.get(
            "/api/collections/receipts/fin_settle_rollback_receipt",
            cookies=actors["admin"],
        )
        stored_ad = client.get(
            "/api/collections/ads/fin_settle_rollback_ad",
            cookies=actors["admin"],
        )
        assert stored_receipt.json()["lastModified"] == receipt["lastModified"]
        assert stored_receipt.json()["data"]["status"] == "Not Paid"
        assert stored_receipt.json()["data"]["amountUSD"] == 80
        assert stored_ad.json()["lastModified"] == created.json()["ad"]["lastModified"]
        assert stored_ad.json()["data"]["dueAllocations"] == [
            {"receiptId": "fin_settle_rollback_receipt", "amountUSD": 80.0}
        ]

    def test_generic_paid_patch_cascades_legacy_shop_due_and_normalizes_pair(self, actors):
        self.tx._customer("fin_settle_legacy_shop_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_legacy_shop_receipt",
            "fin_settle_legacy_shop_customer",
            25,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self.tx._mutate_ad(
            "fin_settle_legacy_shop_ad",
            "fin-settle-legacy-shop-create-001",
            {
                "customerId": "fin_settle_legacy_shop_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_settle_legacy_shop_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_legacy_shop_receipt", "amountUSD": 25}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text

        # Production rows from before allocation arrays kept the same explicit
        # debt in dueAmountToUseUSD. Rebuild that historical representation.
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id='fin_settle_legacy_shop_ad'"
                )
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy["dueAllocations"] = []
            legacy["dueAmountToUseUSD"] = 25
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id='fin_settle_legacy_shop_ad'"
                ),
                {"data": json_dumps(legacy), "modified": modified},
            )

        paid = client.patch(
            "/api/collections/receipts/fin_settle_legacy_shop_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Paid"},
            },
            cookies=actors["admin"],
        )
        assert paid.status_code == 200, paid.text
        assert paid.json()["data"]["status"] == "Paid"
        assert paid.json()["data"]["isPaid"] is True
        updated_ad = client.get(
            "/api/collections/ads/fin_settle_legacy_shop_ad",
            cookies=actors["admin"],
        )
        assert updated_ad.status_code == 200
        data = updated_ad.json()["data"]
        assert data["paymentStatus"] == "paid"
        assert data["receiptAllocations"] == [
            {"receiptId": "fin_settle_legacy_shop_receipt", "amountUSD": 25.0}
        ]
        assert data["dueAllocations"] == []

    def test_contradictory_receipt_paid_pair_is_rejected_without_writes(self, actors):
        self.tx._customer("fin_settle_pair_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_pair_receipt",
            "fin_settle_pair_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
        )
        rejected = client.patch(
            "/api/collections/receipts/fin_settle_pair_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Paid", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert rejected.status_code == 400, rejected.text
        stored = client.get(
            "/api/collections/receipts/fin_settle_pair_receipt",
            cookies=actors["admin"],
        )
        assert stored.json()["lastModified"] == receipt["lastModified"]
        assert stored.json()["data"]["status"] == "Not Paid"
        assert stored.json()["data"]["isPaid"] is False

        malformed_relationship = client.post(
            "/api/receipts/fin_settle_pair_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-pair-malformed-001",
                "data": {"customerId": "../another-customer"},
            },
            cookies=actors["admin"],
        )
        assert malformed_relationship.status_code == 400, malformed_relationship.text
        still_unchanged = client.get(
            "/api/collections/receipts/fin_settle_pair_receipt",
            cookies=actors["admin"],
        )
        assert still_unchanged.json()["lastModified"] == receipt["lastModified"]

        terminal = self.tx._receipt(
            "fin_settle_terminal_paid_receipt",
            "fin_settle_pair_customer",
            10,
            actors,
            status="Canceled",
            isPaid=True,
        )
        preserved = client.patch(
            "/api/collections/receipts/fin_settle_terminal_paid_receipt",
            json={
                "expectedLastModified": terminal["lastModified"],
                "data": {"status": "Canceled", "isPaid": True, "note": "history"},
            },
            cookies=actors["admin"],
        )
        assert preserved.status_code == 200, preserved.text
        assert preserved.json()["data"]["status"] == "Canceled"
        assert preserved.json()["data"]["isPaid"] is True

    def test_stopped_zero_baseline_becomes_paid_without_resurrecting_due(self, actors):
        self.tx._customer("fin_settle_stop_baseline_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_stop_baseline_receipt",
            "fin_settle_stop_baseline_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self.tx._mutate_ad(
            "fin_settle_stop_baseline_ad",
            "fin-settle-stop-baseline-create-001",
            {
                "customerId": "fin_settle_stop_baseline_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_settle_stop_baseline_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_stop_baseline_receipt", "amountUSD": 10}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        stopped = client.post(
            "/api/ads/fin_settle_stop_baseline_ad/stop",
            json={
                "spentMinorUSD": 0,
                "customerInformed": True,
                "idempotencyKey": "fin-settle-stop-baseline-zero-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["ad"]["data"]["dueAllocations"] == []
        assert stopped.json()["ad"]["data"]["stopAllocationBaseline"]["due"] == [
            {"receiptId": "fin_settle_stop_baseline_receipt", "amountUSD": 10.0}
        ]

        settled = client.post(
            "/api/receipts/fin_settle_stop_baseline_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-stop-baseline-paid-001",
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        baseline_only = settled.json()["updatedAds"][0]
        assert baseline_only["data"]["dueAllocations"] == []
        assert baseline_only["data"]["receiptAllocations"] == []
        assert baseline_only["data"]["paymentStatus"] == "paid"
        assert baseline_only["data"]["isPaid"] is True
        assert baseline_only["data"]["settledReceiptId"] == "fin_settle_stop_baseline_receipt"
        assert baseline_only["data"]["stopAllocationBaseline"]["due"] == []
        assert baseline_only["data"]["stopAllocationBaseline"]["receipt"] == [
            {"receiptId": "fin_settle_stop_baseline_receipt", "amountUSD": 10.0}
        ]

        restopped = client.post(
            "/api/ads/fin_settle_stop_baseline_ad/stop",
            json={
                "spentMinorUSD": 500,
                "customerInformed": True,
                "idempotencyKey": "fin-settle-stop-baseline-five-001",
                "expectedLastModified": baseline_only["lastModified"],
            },
            cookies=actors["admin"],
        )
        assert restopped.status_code == 200, restopped.text
        assert restopped.json()["ad"]["data"]["dueAllocations"] == []
        assert restopped.json()["ad"]["data"]["receiptAllocations"] == [
            {"receiptId": "fin_settle_stop_baseline_receipt", "amountUSD": 5.0}
        ]
        assert restopped.json()["ad"]["data"]["paymentStatus"] == "paid"
        assert restopped.json()["ad"]["data"]["isPaid"] is True

    def test_refund_undo_uses_paid_baseline_after_receipt_settlement(self, actors):
        self.tx._customer("fin_settle_refund_baseline_customer", actors)
        receipt = self.tx._receipt(
            "fin_settle_refund_baseline_receipt",
            "fin_settle_refund_baseline_customer",
            10,
            actors,
            status="Not Paid",
            isPaid=False,
            deliveryStatus="Office",
            statusDetail={"notPaidCollection": "office"},
        )
        created = self.tx._mutate_ad(
            "fin_settle_refund_baseline_ad",
            "fin-settle-refund-baseline-create-001",
            {
                "customerId": "fin_settle_refund_baseline_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_settle_refund_baseline_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_settle_refund_baseline_receipt", "amountUSD": 10}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        refunded = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_settle_refund_baseline_ad",
                "idempotencyKey": "fin-settle-refund-baseline-full-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
                "data": {
                    "refundType": "Full",
                    "refundStatus": "Refunded",
                    "refundAmount": 10,
                },
            },
            cookies=actors["admin"],
        )
        assert refunded.status_code == 200, refunded.text
        assert refunded.json()["ad"]["data"]["dueAllocations"] == []
        assert refunded.json()["ad"]["data"]["refundDueBaseline"] == [
            {"receiptId": "fin_settle_refund_baseline_receipt", "amountUSD": 10.0}
        ]

        settled = client.post(
            "/api/receipts/fin_settle_refund_baseline_receipt/settle",
            json={
                "expectedLastModified": receipt["lastModified"],
                "idempotencyKey": "fin-settle-refund-baseline-paid-001",
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        baseline_only = settled.json()["updatedAds"][0]
        assert baseline_only["data"]["dueAllocations"] == []
        assert baseline_only["data"]["paymentStatus"] == "paid"
        assert baseline_only["data"]["isPaid"] is True
        assert baseline_only["data"]["refundDueBaseline"] == []
        assert baseline_only["data"]["refundAllocationBaseline"] == [
            {"receiptId": "fin_settle_refund_baseline_receipt", "amountUSD": 10.0}
        ]

        undone = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_settle_refund_baseline_ad",
                "idempotencyKey": "fin-settle-refund-baseline-undo-001",
                "expectedLastModified": baseline_only["lastModified"],
                "data": {"refundType": "None"},
            },
            cookies=actors["admin"],
        )
        assert undone.status_code == 200, undone.text
        assert undone.json()["ad"]["data"]["dueAllocations"] == []
        assert undone.json()["ad"]["data"]["receiptAllocations"] == [
            {"receiptId": "fin_settle_refund_baseline_receipt", "amountUSD": 10.0}
        ]
        assert undone.json()["ad"]["data"]["paymentStatus"] == "paid"
        assert undone.json()["ad"]["data"]["isPaid"] is True

    def test_ad_update_can_replace_linked_due_receipt_without_double_use(self, actors):
        self.tx._customer("fin_relink_customer", actors)
        for receipt_id in ("fin_relink_receipt_a", "fin_relink_receipt_b"):
            self.tx._receipt(
                receipt_id,
                "fin_relink_customer",
                25,
                actors,
                status="Not Paid",
                isPaid=False,
                deliveryStatus="Office",
                statusDetail={"notPaidCollection": "office"},
            )
        created = self.tx._mutate_ad(
            "fin_relink_ad",
            "fin-relink-create-001",
            {
                "customerId": "fin_relink_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_relink_receipt_a",
                "dueAllocations": [
                    {"receiptId": "fin_relink_receipt_a", "amountUSD": 25}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        replaced = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_relink_ad",
                "idempotencyKey": "fin-relink-replace-001",
                "expectedLastModified": created.json()["ad"]["lastModified"],
                "data": {
                    "receiptId": "fin_relink_receipt_b",
                    "dueAllocations": [
                        {"receiptId": "fin_relink_receipt_b", "amountUSD": 25}
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert replaced.status_code == 200, replaced.text
        data = replaced.json()["ad"]["data"]
        assert data["receiptId"] == "fin_relink_receipt_b"
        assert data["dueAllocations"] == [
            {"receiptId": "fin_relink_receipt_b", "amountUSD": 25.0}
        ]
        reuse_old = self.tx._mutate_ad(
            "fin_relink_reuse_old",
            "fin-relink-reuse-old-001",
            {
                "customerId": "fin_relink_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "receiptId": "fin_relink_receipt_a",
                "dueAllocations": [
                    {"receiptId": "fin_relink_receipt_a", "amountUSD": 25}
                ],
            },
            actors,
        )
        assert reuse_old.status_code == 200, reuse_old.text

        for receipt_id, temp_no in (
            ("fin_relink_driver_receipt_a", "D79801"),
            ("fin_relink_driver_receipt_b", "D79802"),
        ):
            self.tx._receipt(
                receipt_id,
                "fin_relink_customer",
                25,
                actors,
                status="Not Paid",
                isPaid=False,
                amountLocal=125,
                debtAmountLocal=125,
                debtAmountUSD=25,
                tempReceiptNo=temp_no,
                deliveryStatus="Needs Delivery",
                deliveryPersonId=actors["driver"]["id"],
            )
        driver_ad = self.tx._mutate_ad(
            "fin_relink_driver_ad",
            "fin-relink-driver-create-001",
            {
                "customerId": "fin_relink_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 25,
                "linkedDeliveryReceiptId": "fin_relink_driver_receipt_a",
                "receiptId": "fin_relink_driver_receipt_a",
                "dueAllocations": [
                    {"receiptId": "fin_relink_driver_receipt_a", "amountUSD": 25}
                ],
            },
            actors,
        )
        assert driver_ad.status_code == 200, driver_ad.text
        driver_replaced = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_relink_driver_ad",
                "idempotencyKey": "fin-relink-driver-replace-001",
                "expectedLastModified": driver_ad.json()["ad"]["lastModified"],
                "data": {
                    "linkedDeliveryReceiptId": "fin_relink_driver_receipt_b",
                    "receiptId": "fin_relink_driver_receipt_b",
                    "dueAllocations": [
                        {"receiptId": "fin_relink_driver_receipt_b", "amountUSD": 25}
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert driver_replaced.status_code == 200, driver_replaced.text
        driver_data = driver_replaced.json()["ad"]["data"]
        assert driver_data["linkedDeliveryReceiptId"] == "fin_relink_driver_receipt_b"
        assert driver_data["receiptId"] == "fin_relink_driver_receipt_b"
        assert driver_data["dueAllocations"] == [
            {"receiptId": "fin_relink_driver_receipt_b", "amountUSD": 25.0}
        ]

    @staticmethod
    def _rewrite_ad_to_receipt_id_only_driver_mirror(
        ad_id: str,
        receipt_id: str,
        *,
        due_usd: float,
        due_lyd: float = 0.0,
        linked_receipt_id: str = "",
        payment_status: str = "not_paid",
        due_rows: list | None = None,
    ) -> int:
        """Reproduce the OLDEST driver debt shape: the delivery receipt lives in
        receiptId (linkedDeliveryReceiptId did not exist yet), the promise lives
        only in the dueAmountToUse* mirror, and there are no allocation arrays.
        Optional knobs build the gate-boundary variants: a linked id pointing at
        a DIFFERENT receipt, a paid ad with a stale mirror, or surviving due
        rows the mirror merely mirrors."""
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id=:ad_id"
                ),
                {"ad_id": ad_id},
            ).mappings().first()
            legacy = json.loads(row["data_json"])
            legacy.pop("receiptAllocations", None)
            legacy.pop("dueAllocations", None)
            if due_rows is not None:
                legacy["dueAllocations"] = due_rows
            if payment_status == "paid":
                legacy["paymentStatus"] = "paid"
                legacy["isPaid"] = True
                legacy["receiptAllocations"] = []
            legacy["linkedDeliveryReceiptId"] = linked_receipt_id
            legacy["receiptId"] = receipt_id
            legacy["amountUSD"] = 40
            legacy["spentUSD"] = 40
            legacy["dueAmountToUseUSD"] = due_usd
            legacy["dueAmountToUseLYD"] = due_lyd
            modified = int(row["last_modified"]) + 1
            legacy["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id=:ad_id"
                ),
                {"data": json_dumps(legacy), "modified": modified, "ad_id": ad_id},
            )
        return modified

    def test_settlement_converts_receipt_id_only_driver_mirror_exactly_once(self, actors):
        self.tx._customer("fin_legacy_driver_settle_customer", actors)
        receipt = self.tx._receipt(
            "fin_legacy_driver_settle_receipt",
            "fin_legacy_driver_settle_customer",
            40,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=200,
            debtAmountLocal=200,
            debtAmountUSD=40,
            tempReceiptNo="D79911",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        created = self.tx._mutate_ad(
            "fin_legacy_driver_settle_ad",
            "fin-legacy-driver-settle-create-001",
            {
                "customerId": "fin_legacy_driver_settle_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 40,
                "linkedDeliveryReceiptId": "fin_legacy_driver_settle_receipt",
                "receiptId": "fin_legacy_driver_settle_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_legacy_driver_settle_receipt", "amountUSD": 40}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        self._rewrite_ad_to_receipt_id_only_driver_mirror(
            "fin_legacy_driver_settle_ad",
            "fin_legacy_driver_settle_receipt",
            due_usd=40,
        )

        payload = {
            "expectedLastModified": receipt["lastModified"],
            "idempotencyKey": "fin-legacy-driver-settle-paid-001",
        }
        settled = client.post(
            "/api/receipts/fin_legacy_driver_settle_receipt/settle",
            json=payload,
            cookies=actors["admin"],
        )
        replay = client.post(
            "/api/receipts/fin_legacy_driver_settle_receipt/settle",
            json=payload,
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        assert replay.status_code == 200, replay.text
        assert settled.json()["replayed"] is False
        assert replay.json()["replayed"] is True
        assert settled.json()["receipt"]["data"]["status"] == "Paid"
        assert [item["id"] for item in settled.json()["updatedAds"]] == [
            "fin_legacy_driver_settle_ad"
        ]
        data = settled.json()["updatedAds"][0]["data"]
        assert data["paymentStatus"] == "paid"
        assert data["isPaid"] is True
        assert data["receiptAllocations"] == [
            {"receiptId": "fin_legacy_driver_settle_receipt", "amountUSD": 40.0}
        ]
        assert data["dueAllocations"] == []
        assert data["dueAmountToUseUSD"] == 0
        assert data["dueAmountToUseLYD"] == 0
        replay_data = replay.json()["updatedAds"][0]["data"]
        assert replay_data["receiptAllocations"] == [
            {"receiptId": "fin_legacy_driver_settle_receipt", "amountUSD": 40.0}
        ]

    def test_receipt_id_only_driver_mirror_reserves_due_capacity(self, actors):
        self.tx._customer("fin_legacy_driver_cap_customer", actors)
        self.tx._receipt(
            "fin_legacy_driver_cap_receipt",
            "fin_legacy_driver_cap_customer",
            50,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=250,
            debtAmountLocal=250,
            debtAmountUSD=50,
            tempReceiptNo="D79912",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        created = self.tx._mutate_ad(
            "fin_legacy_driver_cap_ad",
            "fin-legacy-driver-cap-create-001",
            {
                "customerId": "fin_legacy_driver_cap_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 40,
                "linkedDeliveryReceiptId": "fin_legacy_driver_cap_receipt",
                "receiptId": "fin_legacy_driver_cap_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_legacy_driver_cap_receipt", "amountUSD": 40}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        self._rewrite_ad_to_receipt_id_only_driver_mirror(
            "fin_legacy_driver_cap_ad",
            "fin_legacy_driver_cap_receipt",
            due_usd=40,
        )

        # The $40 mirror leaves only $10 of the $50 debt: $20 must be refused,
        # $10 must still be grantable.
        over = self.tx._mutate_ad(
            "fin_legacy_driver_cap_over_ad",
            "fin-legacy-driver-cap-over-001",
            {
                "customerId": "fin_legacy_driver_cap_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 20,
                "linkedDeliveryReceiptId": "fin_legacy_driver_cap_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_legacy_driver_cap_receipt", "amountUSD": 20}
                ],
            },
            actors,
        )
        assert over.status_code == 409, over.text
        fits = self.tx._mutate_ad(
            "fin_legacy_driver_cap_fit_ad",
            "fin-legacy-driver-cap-fit-001",
            {
                "customerId": "fin_legacy_driver_cap_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 10,
                "linkedDeliveryReceiptId": "fin_legacy_driver_cap_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_legacy_driver_cap_receipt", "amountUSD": 10}
                ],
            },
            actors,
        )
        assert fits.status_code == 200, fits.text

    def test_cancel_releases_receipt_id_only_driver_mirror(self, actors):
        self.tx._customer("fin_legacy_driver_cancel_customer", actors)
        receipt = self.tx._receipt(
            "fin_legacy_driver_cancel_receipt",
            "fin_legacy_driver_cancel_customer",
            40,
            actors,
            status="Not Paid",
            isPaid=False,
            amountLocal=200,
            debtAmountLocal=200,
            debtAmountUSD=40,
            tempReceiptNo="D79913",
            deliveryStatus="Needs Delivery",
            deliveryPersonId=actors["driver"]["id"],
        )
        created = self.tx._mutate_ad(
            "fin_legacy_driver_cancel_ad",
            "fin-legacy-driver-cancel-create-001",
            {
                "customerId": "fin_legacy_driver_cancel_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": 40,
                "linkedDeliveryReceiptId": "fin_legacy_driver_cancel_receipt",
                "receiptId": "fin_legacy_driver_cancel_receipt",
                "dueAllocations": [
                    {"receiptId": "fin_legacy_driver_cancel_receipt", "amountUSD": 40}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        legacy_modified = self._rewrite_ad_to_receipt_id_only_driver_mirror(
            "fin_legacy_driver_cancel_ad",
            "fin_legacy_driver_cancel_receipt",
            due_usd=0,
            due_lyd=200,  # 200 LYD at the ad rate of 5 = $40
        )

        canceled = client.patch(
            "/api/collections/receipts/fin_legacy_driver_cancel_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"status": "Canceled", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert canceled.status_code == 200, canceled.text

        saved_ad = client.get(
            "/api/collections/ads/fin_legacy_driver_cancel_ad",
            cookies=actors["admin"],
        )
        assert saved_ad.status_code == 200
        saved_data = saved_ad.json()["data"]
        assert saved_ad.json()["lastModified"] > legacy_modified
        assert saved_data["dueAmountToUseUSD"] == 0
        assert saved_data["dueAmountToUseLYD"] == 0
        # A driver row keeps its receiptId as provenance; the zeroed mirror
        # alone guarantees the canceled money no longer backs the budget.
        assert saved_data["receiptId"] == "fin_legacy_driver_cancel_receipt"

    def _seed_two_delivery_receipts(self, prefix: str, actors, temp_no_base: int) -> tuple[dict, dict]:
        self.tx._customer(f"{prefix}_customer", actors)
        receipts = []
        for suffix, temp_no in (("a", f"D{temp_no_base}"), ("b", f"D{temp_no_base + 1}")):
            receipts.append(
                self.tx._receipt(
                    f"{prefix}_receipt_{suffix}",
                    f"{prefix}_customer",
                    40,
                    actors,
                    status="Not Paid",
                    isPaid=False,
                    amountLocal=200,
                    debtAmountLocal=200,
                    debtAmountUSD=40,
                    tempReceiptNo=temp_no,
                    deliveryStatus="Needs Delivery",
                    deliveryPersonId=actors["driver"]["id"],
                )
            )
        return receipts[0], receipts[1]

    def _driver_due_ad(self, ad_id: str, key: str, customer: str, receipt: str, amount: float, actors):
        return self.tx._mutate_ad(
            ad_id,
            key,
            {
                "customerId": customer,
                "paymentStatus": "not_paid",
                "collectionMethod": "driver",
                "exchangeRate": 5,
                "driverBudgetUSD": amount,
                "linkedDeliveryReceiptId": receipt,
                "dueAllocations": [{"receiptId": receipt, "amountUSD": amount}],
            },
            actors,
        )

    def test_divergent_driver_link_charges_only_the_linked_receipt(self, actors):
        """linkedDeliveryReceiptId=B with receiptId=A must reserve B, never A."""
        prefix = "fin_legacy_diverge"
        receipt_a, receipt_b = self._seed_two_delivery_receipts(prefix, actors, 79914)
        created = self._driver_due_ad(
            f"{prefix}_ad", f"{prefix}-create-001", f"{prefix}_customer",
            f"{prefix}_receipt_b", 40, actors,
        )
        assert created.status_code == 200, created.text
        self._rewrite_ad_to_receipt_id_only_driver_mirror(
            f"{prefix}_ad",
            f"{prefix}_receipt_a",
            due_usd=40,
            linked_receipt_id=f"{prefix}_receipt_b",
        )

        # A's whole $40 debt must still be grantable — the mirror belongs to B.
        fits_a = self._driver_due_ad(
            f"{prefix}_fit_ad", f"{prefix}-fit-001", f"{prefix}_customer",
            f"{prefix}_receipt_a", 40, actors,
        )
        assert fits_a.status_code == 200, fits_a.text
        # B is fully reserved by the mirror: even $20 more must be refused.
        over_b = self._driver_due_ad(
            f"{prefix}_over_ad", f"{prefix}-over-001", f"{prefix}_customer",
            f"{prefix}_receipt_b", 20, actors,
        )
        assert over_b.status_code == 409, over_b.text

        # Canceling A must NOT release B's promise.
        canceled_a = client.patch(
            f"/api/collections/receipts/{prefix}_receipt_a",
            json={
                "expectedLastModified": receipt_a["lastModified"],
                "data": {"status": "Canceled", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert canceled_a.status_code == 200, canceled_a.text
        after_cancel = client.get(
            f"/api/collections/ads/{prefix}_ad", cookies=actors["admin"]
        )
        assert after_cancel.json()["data"]["dueAmountToUseUSD"] == 40

        # Settling B converts the mirror into a B allocation exactly once.
        settled = client.post(
            f"/api/receipts/{prefix}_receipt_b/settle",
            json={
                "expectedLastModified": receipt_b["lastModified"],
                "idempotencyKey": f"{prefix}-paid-001",
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        assert [item["id"] for item in settled.json()["updatedAds"]] == [f"{prefix}_ad"]
        data = settled.json()["updatedAds"][0]["data"]
        assert data["paymentStatus"] == "paid"
        assert data["receiptAllocations"] == [
            {"receiptId": f"{prefix}_receipt_b", "amountUSD": 40.0}
        ]
        assert data["dueAmountToUseUSD"] == 0

    def test_paid_driver_ad_stale_mirror_reserves_nothing(self, actors):
        """A PAID ad's leftover mirror is history: it must not eat due capacity
        and cancel must leave it untouched."""
        prefix = "fin_legacy_paidgate"
        receipt_a, _receipt_b = self._seed_two_delivery_receipts(prefix, actors, 79916)
        created = self._driver_due_ad(
            f"{prefix}_ad", f"{prefix}-create-001", f"{prefix}_customer",
            f"{prefix}_receipt_a", 40, actors,
        )
        assert created.status_code == 200, created.text
        self._rewrite_ad_to_receipt_id_only_driver_mirror(
            f"{prefix}_ad",
            f"{prefix}_receipt_a",
            due_usd=40,
            payment_status="paid",
        )

        # The stale mirror must reserve nothing: A's full debt stays grantable.
        fits = self._driver_due_ad(
            f"{prefix}_fit_ad", f"{prefix}-fit-001", f"{prefix}_customer",
            f"{prefix}_receipt_a", 40, actors,
        )
        assert fits.status_code == 200, fits.text

        canceled = client.patch(
            f"/api/collections/receipts/{prefix}_receipt_a",
            json={
                "expectedLastModified": receipt_a["lastModified"],
                "data": {"status": "Canceled", "isPaid": False},
            },
            cookies=actors["admin"],
        )
        assert canceled.status_code == 200, canceled.text
        stored = client.get(
            f"/api/collections/ads/{prefix}_ad", cookies=actors["admin"]
        )
        assert stored.json()["data"]["dueAmountToUseUSD"] == 40
        assert stored.json()["data"]["isPaid"] is True

    def test_mirror_of_surviving_rows_is_not_charged_twice(self, actors):
        """A scalar mirror equal to surviving due rows on ANOTHER receipt is a
        mirror, not extra money: it must not block or convert on receiptId."""
        prefix = "fin_legacy_mixedrows"
        receipt_a, _receipt_b = self._seed_two_delivery_receipts(prefix, actors, 79918)
        created = self._driver_due_ad(
            f"{prefix}_ad", f"{prefix}-create-001", f"{prefix}_customer",
            f"{prefix}_receipt_b", 30, actors,
        )
        assert created.status_code == 200, created.text
        self._rewrite_ad_to_receipt_id_only_driver_mirror(
            f"{prefix}_ad",
            f"{prefix}_receipt_a",
            due_usd=30,
            due_rows=[{"receiptId": f"{prefix}_receipt_b", "amountUSD": 30}],
        )

        # A's whole debt stays grantable — the mirror mirrors B's row.
        fits = self._driver_due_ad(
            f"{prefix}_fit_ad", f"{prefix}-fit-001", f"{prefix}_customer",
            f"{prefix}_receipt_a", 40, actors,
        )
        assert fits.status_code == 200, fits.text

        # Settling A must convert ONLY the competing ad's own row; the mixed
        # legacy ad keeps its B row and mirror. Pre-guard, the phantom $30
        # would overflow A's $40 capacity and 409 this settle.
        settled = client.post(
            f"/api/receipts/{prefix}_receipt_a/settle",
            json={
                "expectedLastModified": receipt_a["lastModified"],
                "idempotencyKey": f"{prefix}-paid-001",
            },
            cookies=actors["admin"],
        )
        assert settled.status_code == 200, settled.text
        assert [item["id"] for item in settled.json()["updatedAds"]] == [
            f"{prefix}_fit_ad"
        ]
        untouched = client.get(
            f"/api/collections/ads/{prefix}_ad", cookies=actors["admin"]
        )
        assert untouched.json()["data"]["dueAllocations"] == [
            {"receiptId": f"{prefix}_receipt_b", "amountUSD": 30}
        ]
        assert untouched.json()["data"]["dueAmountToUseUSD"] == 30
        assert untouched.json()["data"]["paymentStatus"] == "not_paid"


class TestLegacyAdPaymentNormalization:
    @pytest.mark.parametrize(
        ("stored", "expected"),
        [
            ({"paymentStatus": " paid ", "isPaid": False}, "paid"),
            ({"paymentStatus": "Not Paid", "isPaid": True}, "not_paid"),
            ({"paymentStatus": "not-paid", "isPaid": True}, "not_paid"),
            ({"paymentStatus": "unpaid", "isPaid": True}, "not_paid"),
            ({"paymentStatus": "won't pay", "isPaid": True}, "wont_pay"),
            ({"paymentStatus": "Won\u2019t-Pay", "isPaid": True}, "wont_pay"),
            ({"paymentStatus": "", "isPaid": False}, "not_paid"),
            ({"paymentStatus": "", "isPaid": True}, "paid"),
            ({}, "paid"),
        ],
    )
    def test_canonical_status_mirrors_historical_frontend_rules(
        self, stored, expected
    ):
        assert main_module._financial_ad_payment_status(stored) == expected

    @staticmethod
    def _rewrite_payment_state(ad_id: str, payment_status: str, is_paid: bool) -> int:
        with db_conn() as conn:
            row = conn.execute(
                text(
                    "SELECT data_json,last_modified FROM entities "
                    "WHERE type='ads' AND id=:id"
                ),
                {"id": ad_id},
            ).mappings().first()
            assert row is not None
            data = json.loads(row["data_json"])
            modified = max(now_ms(), int(row["last_modified"]) + 1)
            data["paymentStatus"] = payment_status
            data["isPaid"] = is_paid
            data["_lastModified"] = modified
            conn.execute(
                text(
                    "UPDATE entities SET data_json=:data,last_modified=:modified "
                    "WHERE type='ads' AND id=:id"
                ),
                {
                    "id": ad_id,
                    "data": json_dumps(data),
                    "modified": modified,
                },
            )
            return modified

    def test_incoming_aliases_are_persisted_canonically(self, actors):
        tx = TestReceiptAndAdTransactions
        tx._customer("fin_legacy_status_customer", actors)

        not_paid = tx._mutate_ad(
            "fin_legacy_status_debt",
            "fin-legacy-status-debt-001",
            {
                "customerId": "fin_legacy_status_customer",
                "paymentStatus": " Not-Paid ",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "collectionPayments": [
                    {"method": "Cash (LYD)", "amount": 100, "rate": 1, "rate2": 5}
                ],
            },
            actors,
        )
        assert not_paid.status_code == 200, not_paid.text
        not_paid_data = not_paid.json()["ad"]["data"]
        assert not_paid_data["paymentStatus"] == "not_paid"
        assert not_paid_data["isPaid"] is False

        wont_pay = tx._mutate_ad(
            "fin_legacy_status_wont",
            "fin-legacy-status-wont-001",
            {
                "customerId": "fin_legacy_status_customer",
                "paymentStatus": " Won\u2019t Pay ",
                "exchangeRate": 5,
                "collectionPayments": [
                    {"method": "Cash (LYD)", "amount": 50, "rate": 1, "rate2": 5}
                ],
            },
            actors,
        )
        assert wont_pay.status_code == 200, wont_pay.text
        wont_pay_data = wont_pay.json()["ad"]["data"]
        assert wont_pay_data["paymentStatus"] == "wont_pay"
        assert wont_pay_data["isPaid"] is False

    def test_stored_alias_precedence_is_repaired_by_edit_and_topup(self, actors):
        tx = TestReceiptAndAdTransactions
        tx._customer("fin_legacy_status_topup_customer", actors)
        tx._receipt(
            "fin_legacy_status_topup_receipt",
            "fin_legacy_status_topup_customer",
            100,
            actors,
        )
        created = tx._mutate_ad(
            "fin_legacy_status_topup_ad",
            "fin-legacy-status-topup-create-001",
            {
                "customerId": "fin_legacy_status_topup_customer",
                "paymentStatus": " PAID ",
                "exchangeRate": 5,
                "receiptAllocations": [
                    {"receiptId": "fin_legacy_status_topup_receipt", "amountUSD": 30}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        assert created.json()["ad"]["data"]["paymentStatus"] == "paid"

        modified = self._rewrite_payment_state(
            "fin_legacy_status_topup_ad", " PAID ", False
        )
        topped_up = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_legacy_status_topup_ad",
                "idempotencyKey": "fin-legacy-status-topup-update-001",
                "expectedLastModified": modified,
                "data": {
                    "topUps": [{"amount": 5, "extendDays": 0, "note": "legacy"}],
                    "receiptAllocations": [
                        {
                            "receiptId": "fin_legacy_status_topup_receipt",
                            "amountUSD": 35,
                        }
                    ],
                },
            },
            cookies=actors["admin"],
        )
        assert topped_up.status_code == 200, topped_up.text
        topped_up_data = topped_up.json()["ad"]["data"]
        assert topped_up_data["paymentStatus"] == "paid"
        assert topped_up_data["isPaid"] is True
        assert topped_up_data["amountUSD"] == 35

        debt_created = tx._mutate_ad(
            "fin_legacy_status_edit_debt",
            "fin-legacy-status-edit-debt-create-001",
            {
                "customerId": "fin_legacy_status_topup_customer",
                "paymentStatus": "not_paid",
                "collectionMethod": "in_shop",
                "exchangeRate": 5,
                "collectionPayments": [
                    {"method": "Cash (LYD)", "amount": 100, "rate": 1, "rate2": 5}
                ],
            },
            actors,
        )
        assert debt_created.status_code == 200, debt_created.text
        modified = self._rewrite_payment_state(
            "fin_legacy_status_edit_debt", " Not Paid ", True
        )
        edited = client.post(
            "/api/ads/mutate",
            json={
                "action": "update",
                "adId": "fin_legacy_status_edit_debt",
                "idempotencyKey": "fin-legacy-status-debt-edit-001",
                "expectedLastModified": modified,
                "data": {"note": "canonicalized by ordinary edit"},
            },
            cookies=actors["admin"],
        )
        assert edited.status_code == 200, edited.text
        edited_data = edited.json()["ad"]["data"]
        assert edited_data["paymentStatus"] == "not_paid"
        assert edited_data["isPaid"] is False


class TestSecurityAuditRegression:
    """Regression tests for the 2026-07 security audit fixes.

    Each fails against the pre-fix code and passes after the fix, pinning a
    concrete money-theft / money-mint / auth vector closed by the audit.
    """

    tx = TestReceiptAndAdTransactions

    @staticmethod
    def _receipts_editor(actors, email):
        # A trusted insider with receipts.edit but NOT receipts.transfer.
        return _create_user(
            actors["admin"],
            email=email,
            permissions={"receipts": ["view", "edit"], "customers": ["view", "add"]},
        )

    def test_paid_receipt_cannot_be_reassigned_to_another_customer(self, actors):
        # HIGH: a plain edit must not move a paid receipt's stored credit to an
        # accomplice customer (that bypasses the guarded transfer endpoint).
        self.tx._customer("sec_reassign_victim", actors)
        self.tx._customer("sec_reassign_accomplice", actors)
        _editor, editor_cookies = self._receipts_editor(
            actors, "hardening-reassign@tests.albayanhub.com"
        )
        receipt = self.tx._receipt(
            "sec_reassign_receipt", "sec_reassign_victim", 100, actors,
            status="Paid", isPaid=True,
        )
        moved = client.patch(
            "/api/collections/receipts/sec_reassign_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"customerId": "sec_reassign_accomplice"},
            },
            cookies=editor_cookies,
        )
        assert moved.status_code == 409, moved.text
        stored = client.get(
            "/api/collections/receipts/sec_reassign_receipt", cookies=actors["admin"]
        )
        assert stored.json()["data"]["customerId"] == "sec_reassign_victim"

    def test_unpaid_receipt_customer_can_still_be_corrected(self, actors):
        # The fix must NOT block a benign correction on an uncommitted receipt.
        self.tx._customer("sec_correct_a", actors)
        self.tx._customer("sec_correct_b", actors)
        receipt = self.tx._receipt(
            "sec_correct_receipt", "sec_correct_a", 50, actors,
            status="Not Paid", isPaid=False,
        )
        fixed = client.patch(
            "/api/collections/receipts/sec_correct_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"customerId": "sec_correct_b"},
            },
            cookies=actors["admin"],
        )
        assert fixed.status_code == 200, fixed.text
        assert fixed.json()["data"]["customerId"] == "sec_correct_b"

    def test_paid_receipt_amount_cannot_be_inflated_by_edit(self, actors):
        # MEDIUM: raising a settled receipt's amountUSD mints spendable credit.
        self.tx._customer("sec_inflate_customer", actors)
        _editor, editor_cookies = self._receipts_editor(
            actors, "hardening-inflate@tests.albayanhub.com"
        )
        receipt = self.tx._receipt(
            "sec_inflate_receipt", "sec_inflate_customer", 100, actors,
            status="Paid", isPaid=True,
        )
        inflated = client.patch(
            "/api/collections/receipts/sec_inflate_receipt",
            json={
                "expectedLastModified": receipt["lastModified"],
                "data": {"amountUSD": 100000, "amountLocal": 500000},
            },
            cookies=editor_cookies,
        )
        assert inflated.status_code == 409, inflated.text
        stored = client.get(
            "/api/collections/receipts/sec_inflate_receipt", cookies=actors["admin"]
        )
        assert stored.json()["data"]["amountUSD"] == 100

    def test_generic_ad_patch_cannot_change_payment_classification(self, actors):
        # HIGH: rewriting paymentStatus/collectionMethod on a funded ad via the
        # generic PATCH skips the transactional capacity re-check (double-spend).
        self.tx._customer("sec_adclass_customer", actors)
        self.tx._receipt(
            "sec_adclass_receipt", "sec_adclass_customer", 100, actors,
            status="Paid", isPaid=True,
        )
        created = self.tx._mutate_ad(
            "sec_adclass_ad", "sec-adclass-create-001",
            {
                "customerId": "sec_adclass_customer",
                "paymentStatus": "paid",
                "receiptAllocations": [
                    {"receiptId": "sec_adclass_receipt", "amountUSD": 100}
                ],
            },
            actors,
        )
        assert created.status_code == 200, created.text
        stored = client.get("/api/collections/ads/sec_adclass_ad", cookies=actors["admin"])
        lm = stored.json()["lastModified"]
        blocked = client.patch(
            "/api/collections/ads/sec_adclass_ad",
            json={
                "expectedLastModified": lm,
                "data": {"paymentStatus": "not_paid", "collectionMethod": "driver"},
            },
            cookies=actors["admin"],
        )
        assert blocked.status_code == 405, blocked.text
        # An ordinary edit echoing the UNCHANGED classification still works.
        ok = client.patch(
            "/api/collections/ads/sec_adclass_ad",
            json={
                "expectedLastModified": lm,
                "data": {"paymentStatus": "paid", "note": "ordinary edit"},
            },
            cookies=actors["admin"],
        )
        assert ok.status_code == 200, ok.text

    def test_driver_cannot_over_collect_to_mint_credit(self, actors):
        # MEDIUM: an implausibly large collected amount would convert to a huge
        # spendable USD credit. Bound it; keep normal collection working.
        self.tx._customer("sec_overpay_customer", actors)
        self.tx._receipt(
            "sec_overpay_receipt", "sec_overpay_customer", 100, actors,
            status="Not Paid", isPaid=False,
            amountLocal=950, debtAmountLocal=950, debtAmountUSD=100, exchangeRate=9.5,
            quotedDeliveryFee=10, tempReceiptNo="D70099001",
            deliveryStatus="Needs Delivery", deliveryPersonId=actors["driver"]["id"],
        )
        assert client.patch(
            "/api/collections/receipts/sec_overpay_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        ).status_code == 200
        attack = client.patch(
            "/api/collections/receipts/sec_overpay_receipt",
            json={"data": {
                "deliveryStatus": "Delivered",
                "finalReceiptNo": "70099001",
                "receiptImage": "data:image/png;base64,AAAA",
                "amountCollectedFromCustomer": 5000000,
                "actualDeliveryFeeCollected": 0,
                "paymentMethod": "Cash (LYD)",
            }},
            cookies=actors["driver_cookies"],
        )
        assert attack.status_code == 400, attack.text
        stored = client.get(
            "/api/collections/receipts/sec_overpay_receipt", cookies=actors["admin"]
        )
        assert str(stored.json()["data"].get("deliveryStatus")) != "Delivered"

    def test_driver_normal_collection_still_completes(self, actors):
        # The overpay bound must leave an ordinary delivery (and a small tip) intact.
        self.tx._customer("sec_normalpay_customer", actors)
        self.tx._receipt(
            "sec_normalpay_receipt", "sec_normalpay_customer", 100, actors,
            status="Not Paid", isPaid=False,
            amountLocal=950, debtAmountLocal=950, debtAmountUSD=100, exchangeRate=9.5,
            quotedDeliveryFee=10, tempReceiptNo="D70099002",
            deliveryStatus="Needs Delivery", deliveryPersonId=actors["driver"]["id"],
        )
        assert client.patch(
            "/api/collections/receipts/sec_normalpay_receipt",
            json={"data": {"deliveryStatus": "In Progress", "acceptedDate": "x"}},
            cookies=actors["driver_cookies"],
        ).status_code == 200
        done = client.patch(
            "/api/collections/receipts/sec_normalpay_receipt",
            json={"data": {
                "deliveryStatus": "Delivered",
                "finalReceiptNo": "70099002",
                "receiptImage": "data:image/png;base64,AAAA",
                "amountCollectedFromCustomer": 1000,
                "actualDeliveryFeeCollected": 10,
                "paymentMethod": "Cash (LYD)",
            }},
            cookies=actors["driver_cookies"],
        )
        assert done.status_code == 200, done.text
        assert str(done.json()["data"]["deliveryStatus"]) == "Delivered"

    def test_per_ip_login_throttle_blocks_credential_stuffing(self, actors):
        # LOW: one IP spreading a guess across many distinct emails must hit a
        # global per-IP ceiling. Distinct emails keep the (ip,email) and per-email
        # buckets fresh, so only the per-IP bucket accumulates. A unique source IP
        # avoids colliding with other tests' buckets.
        ip = "198.51.100.77"
        blocked_at = None
        for i in range(200):
            allowed, _wait = main_module._rate_check(
                _request(ip), f"sec-stuffing-{i}@example.com"
            )
            if not allowed:
                blocked_at = i
                break
        assert blocked_at is not None, (
            "a single IP could try unlimited distinct emails — no per-IP ceiling"
        )
        assert blocked_at >= 100, (
            f"per-IP ceiling tripped too early at {blocked_at} (locks out shared offices)"
        )

    def test_login_timing_does_not_leak_whether_email_exists(self, actors, monkeypatch):
        # LOW: the unknown-email path must burn the same PBKDF2 cost as the
        # known-email path, or response time reveals which emails have accounts.
        monkeypatch.setattr(main_module, "_rate_check", lambda *a, **k: (True, 0))
        import time

        def best_time(email, password):
            best = None
            for _ in range(3):
                start = time.perf_counter()
                resp = client.post(
                    "/api/auth/login", json={"email": email, "password": password}
                )
                elapsed = time.perf_counter() - start
                assert resp.status_code == 401, resp.text
                best = elapsed if best is None else min(best, elapsed)
            return best

        known = best_time("hardening-wallet@tests.albayanhub.com", "wrong-password-xyz")
        unknown = best_time("no-such-user-xyz@tests.albayanhub.com", "wrong-password-xyz")
        # Both run 310k-iteration PBKDF2 now; the unknown path must not be an order
        # of magnitude faster (pre-fix it returned essentially instantly).
        assert unknown >= known * 0.4, (
            f"unknown-email login too fast (unknown={unknown:.4f}s known={known:.4f}s) "
            "— timing leaks email existence"
        )

    def test_generic_routes_refuse_module_only_collection_names(self, actors):
        # LOW/defense-in-depth: a caller holding users.add must not be able to
        # create isolated shadow entities in the generic store under names that
        # are permission modules but not real store collections.
        for name in ("users", "deliveries", "settings", "analytics", "auditLogs"):
            created = client.post(
                f"/api/collections/{name}",
                json={"id": f"shadow_{name}", "data": {"x": 1}},
                cookies=actors["grant_cookies"],
            )
            assert created.status_code == 404, f"{name} create: {created.status_code} {created.text}"
            got = client.get(f"/api/collections/{name}", cookies=actors["grant_cookies"])
            assert got.status_code == 404, f"{name} list: {got.status_code}"
        # A real store collection is still reachable.
        ok = client.get("/api/collections/customers", cookies=actors["admin"])
        assert ok.status_code == 200, ok.text

    def test_batch_delete_cannot_orphan_a_customers_records(self, actors):
        # INTEGRITY: batch delete must enforce the same guard as single delete —
        # a customer with live receipts/ads may not be deleted alone.
        self.tx._customer("sec_batch_customer", actors)
        self.tx._receipt("sec_batch_receipt", "sec_batch_customer", 40, actors, status="Paid", isPaid=True)
        orphan = client.post(
            "/api/batch/delete",
            json={"items": [{"collection": "customers", "id": "sec_batch_customer"}]},
            cookies=actors["admin"],
        )
        assert orphan.status_code == 409, orphan.text
        still = client.get("/api/collections/customers/sec_batch_customer", cookies=actors["admin"])
        assert still.status_code == 200, "the customer must survive the refused batch delete"
        # Deleting the customer together with their receipt in one batch is allowed.
        together = client.post(
            "/api/batch/delete",
            json={"items": [
                {"collection": "receipts", "id": "sec_batch_receipt"},
                {"collection": "customers", "id": "sec_batch_customer"},
            ]},
            cookies=actors["admin"],
        )
        assert together.status_code == 200, together.text
        assert together.json()["deleted"] == 2
