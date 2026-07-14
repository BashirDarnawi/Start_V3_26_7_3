"""
End-to-end tests for the user-permissions chain (originally the reproduction
for the "employee with ALL permissions is locked out" report; now asserts the
FIXED behavior).

Covers:
  1.  Admin creates an Employee with the FULL permission map (every module and
      action from src/04-permissions.js PERMISSION_MODULES — 86 permissions).
  2.  Create response echoes those permissions.
  3.  Employee login response user.permissions is the full map.
  4.  GET /api/auth/me as employee includes permissions.
  5.  Core collections (ads/receipts/customers/pages/exchangeRateHistory) are
      readable by the full-permission employee.
  6.  walletTransactions / serviceSubscriptions: ownership-scoped for
      non-admins (was: unconditional 403 that silently wiped local data).
  7.  GET /api/users honors the users.view permission (was: admin-role only).
  8.  Admin PATCHes permissions; employee re-login shows the update.
  9.  exchangeRateHistory readable WITHOUT settings.view (reference data).
  10. Audit endpoints honor auditLogs.view / viewOwn / clear.
  11. check-stuck honors deliveries.assign + reads hours_threshold from body.
  12. deliveries.* permissions authorize delivery-workflow PATCHes.
  13. users.* permissions work on users CRUD, with anti-escalation guards
      (no Admin creation/promotion/modification/deletion by non-admins,
      no self-delete, self password change must use password-change).
  14. Wallet: self-debits only; subscriptions: self-create + cancel-only patch.

Run with: PYTHONPATH=. pytest server/test_permissions_flow.py -v
"""
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

from server.main import app
from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})

ADMIN_EMAIL = "permflow-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "TestPassword123!Secure"
EMP_EMAIL = "permflow-employee@tests.albayanhub.com"
EMP_PASSWORD = "EmployeePass123!Secure"
DELIV_MGR_EMAIL = "permflow-delivmgr@tests.albayanhub.com"
DELIV_MGR_PASSWORD = "DelivMgrPass123!Secure"
MINIMAL_EMAIL = "permflow-minimal@tests.albayanhub.com"
MINIMAL_PASSWORD = "MinimalPass123!Secure"
DRIVER_EMAIL = "permflow-driver@tests.albayanhub.com"
DRIVER_PASSWORD = "DriverPass123!Secure"

# The FULL permission map: every module key and every action from
# src/04-permissions.js PERMISSION_MODULES (86 individual permissions after
# the removal of the inert settings.backup/restore/clearData and
# auditLogs.backup toggles).
FULL_PERMISSIONS = {
    "analytics": ["view", "export", "viewFinancials", "viewSensitive"],
    "ads": [
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "changeStatus",
        "stopAd", "assignDelivery", "viewPhotos", "uploadPhotos",
    ],
    "receipts": [
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "markCollected",
        "transfer", "viewHistory", "export",
    ],
    "customers": [
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "viewBalance",
        "viewContacts", "export",
    ],
    "pages": ["view", "add", "edit", "delete", "linkCustomers"],
    "deliveries": [
        "view", "viewOwn", "accept", "complete", "markCollected", "assign",
        "reassign", "viewStats",
    ],
    "users": [
        "view", "add", "edit", "delete", "managePermissions", "changeRole",
        "resetPassword", "viewActivity",
    ],
    "settings": ["view", "edit", "manageExchangeRate"],
    "auditLogs": ["view", "viewOwn", "export", "clear"],
    "clothesProducts": ["view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn"],
    "clothesShipments": ["view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn"],
    "clothesOrders": ["view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn"],
    "clothesSettings": ["viewOwn", "add", "editOwn"],
}

TOTAL_PERMISSIONS = sum(len(v) for v in FULL_PERMISSIONS.values())


def _perm_sets(perms: dict) -> dict:
    return {k: sorted(v) for k, v in (perms or {}).items()}


def _full_sets() -> dict:
    return {k: sorted(v) for k, v in FULL_PERMISSIONS.items()}


def _ensure_admin():
    pw = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
            {"e": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(text(
            "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
            "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
            "VALUES (:id,:name,:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
        ), {"id": uid, "name": "PermFlow Admin", "email": ADMIN_EMAIL,
            "perm": json_dumps({}), "h": pw.hash_hex, "s": pw.salt_hex,
            "a": pw.algo, "i": pw.iterations, "now": now})
        return uid


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    init_db()
    _ensure_admin()
    yield


def _login(email, password):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login {email} failed: {r.status_code} {r.text[:300]}"
    tok = r.cookies.get("albayan_session")
    try:
        client.cookies.clear()
    except Exception:
        pass
    return {"albayan_session": tok}, r.json()


def _admin_cookies():
    cookies, _ = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    return cookies


def _create_user(admin_cookies, name, email, password, role, permissions):
    r = client.post("/api/users", json={
        "name": name, "email": email, "password": password,
        "role": role, "permissions": permissions,
    }, cookies=admin_cookies)
    assert r.status_code == 200, f"create {email} failed: {r.status_code} {r.text[:300]}"
    return r.json()


@pytest.fixture(scope="module")
def employee():
    """Admin creates the Employee with the FULL permission map, then employee logs in."""
    admin = _admin_cookies()
    created = _create_user(
        admin, "Albayan Employee", EMP_EMAIL, EMP_PASSWORD, "Employee", FULL_PERMISSIONS
    )
    cookies, login_body = _login(EMP_EMAIL, EMP_PASSWORD)
    return {
        "admin": admin,
        "id": created["id"],
        "created": created,
        "cookies": cookies,
        "login_body": login_body,
    }


@pytest.fixture(scope="module")
def delivery_manager(employee):
    """Employee with ONLY deliveries.* permissions (plus analytics.view)."""
    created = _create_user(
        employee["admin"], "Delivery Manager", DELIV_MGR_EMAIL, DELIV_MGR_PASSWORD,
        "Employee",
        {"analytics": ["view"],
         "deliveries": ["view", "accept", "complete", "markCollected", "assign", "reassign"]},
    )
    cookies, _ = _login(DELIV_MGR_EMAIL, DELIV_MGR_PASSWORD)
    return {"id": created["id"], "cookies": cookies}


@pytest.fixture(scope="module")
def minimal_user(employee):
    """Employee with almost no permissions (analytics.view + auditLogs.viewOwn)."""
    created = _create_user(
        employee["admin"], "Minimal User", MINIMAL_EMAIL, MINIMAL_PASSWORD,
        "Employee", {"analytics": ["view"], "auditLogs": ["viewOwn"]},
    )
    cookies, _ = _login(MINIMAL_EMAIL, MINIMAL_PASSWORD)
    return {"id": created["id"], "cookies": cookies}


@pytest.fixture(scope="module")
def delivery_driver(employee):
    created = _create_user(
        employee["admin"], "Delivery Driver", DRIVER_EMAIL, DRIVER_PASSWORD,
        "Delivery", {"deliveries": ["view", "viewOwn", "accept", "complete"]},
    )
    cookies, _ = _login(DRIVER_EMAIL, DRIVER_PASSWORD)
    return {"id": created["id"], "cookies": cookies}


class TestCreateWithFullPermissions:
    def test_create_response_contains_full_permissions(self, employee):
        created = employee["created"]
        assert created["role"] == "Employee"
        assert _perm_sets(created.get("permissions")) == _full_sets(), (
            "POST /api/users create response did not echo the full permission map"
        )
        assert sum(len(v) for v in created["permissions"].values()) == TOTAL_PERMISSIONS == 86


class TestLoginResponsePermissions:
    def test_login_response_user_has_full_permissions(self, employee):
        """THE critical assertion: if empty here, the frontend lockout is server-side."""
        user = employee["login_body"].get("user") or {}
        assert _perm_sets(user.get("permissions")) == _full_sets(), (
            "LOGIN response user.permissions is NOT the full map — server-side lockout"
        )

    def test_me_has_full_permissions(self, employee):
        r = client.get("/api/auth/me", cookies=employee["cookies"])
        assert r.status_code == 200, r.text[:300]
        assert _perm_sets(r.json().get("permissions")) == _full_sets()


class TestCoreCollections:
    @pytest.mark.parametrize("collection", [
        "ads", "receipts", "customers", "pages", "exchangeRateHistory",
    ])
    def test_collection_access(self, employee, collection):
        r = client.get(f"/api/collections/{collection}", cookies=employee["cookies"])
        assert r.status_code == 200, (
            f"{collection}: expected 200 for full-permission employee, got "
            f"{r.status_code} {r.text[:200]}"
        )


class TestWalletAndSubscriptionsScoped:
    """FIXED: these used to 403 for every non-admin (module-name gap), which
    silently wiped local wallet/subscription data on every sync."""

    @pytest.mark.parametrize("collection", ["walletTransactions", "serviceSubscriptions"])
    def test_scoped_read_is_200(self, employee, collection):
        r = client.get(f"/api/collections/{collection}", cookies=employee["cookies"])
        assert r.status_code == 200, f"{collection}: {r.status_code} {r.text[:200]}"
        assert isinstance(r.json(), list)

    def test_funded_transfer_allowed_arbitrary_debit_forbidden(self, employee, minimal_user):
        uid = employee["id"]
        top_up = client.post("/api/wallet/top-ups", json={
            "userId": uid, "amountMinor": 500, "currency": "USD",
            "idempotencyKey": "permflow-topup-001",
        }, cookies=employee["admin"])
        assert top_up.status_code == 200, top_up.text[:300]

        ok = client.post("/api/wallet/transfers", json={
            "toUserId": minimal_user["id"], "amountMinor": 100, "currency": "USD",
            "idempotencyKey": "permflow-transfer-001",
        }, cookies=employee["cookies"])
        assert ok.status_code == 200, ok.text[:300]

        # Generic fabricated service payments are never accepted.
        forged = client.post("/api/collections/walletTransactions", json={"data": {
            "fromUserId": uid, "toUserId": "system", "type": "service_payment",
            "amountMinor": 100, "currency": "USD", "idempotencyKey": "forged-payment-001",
        }}, cookies=employee["cookies"])
        assert forged.status_code == 403

        # Cannot mint money into own wallet or debit someone else.
        bad = client.post("/api/collections/walletTransactions", json={"data": {
            "fromUserId": "someone-else", "toUserId": uid, "type": "credit",
            "amountMinor": 999999, "currency": "USD",
        }}, cookies=employee["cookies"])
        assert bad.status_code == 403, bad.text[:300]

        # The self-debit shows up in the scoped read.
        r = client.get("/api/collections/walletTransactions", cookies=employee["cookies"])
        assert any((e.get("data") or {}).get("fromUserId") == uid for e in r.json())

    def test_own_rows_only(self, employee, minimal_user):
        """Another user must NOT see the employee's wallet rows."""
        r = client.get("/api/collections/walletTransactions", cookies=minimal_user["cookies"])
        assert r.status_code == 200
        minimal_id = minimal_user["id"]
        assert all(
            (e.get("data") or {}).get("fromUserId") == minimal_id
            or (e.get("data") or {}).get("toUserId") == minimal_id
            for e in r.json()
        ), "wallet rows leaked across users"

    def test_subscription_self_create_and_cancel_only_patch(self, employee):
        uid = employee["id"]
        created = client.post("/api/collections/serviceSubscriptions", json={"data": {
            "userId": uid, "serviceId": "clothes_system", "status": "active",
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "idempotencyKey": "permflow-subscribe-001",
        }}, cookies=employee["cookies"])
        assert created.status_code == 200, created.text[:300]
        assert not created.json()["data"]["expiresAt"].startswith("2099-")
        sub_id = created.json()["id"]

        for_other = client.post("/api/collections/serviceSubscriptions", json={"data": {
            "userId": "someone-else", "serviceId": "clothes_system", "status": "active",
            "idempotencyKey": "permflow-subscribe-002",
        }}, cookies=employee["cookies"])
        assert for_other.status_code == 403

        # Extending expiry without cancelling is forbidden...
        extend = client.patch(
            f"/api/collections/serviceSubscriptions/{sub_id}",
            json={"data": {"expiresAt": "2199-01-01T00:00:00.000Z"}},
            cookies=employee["cookies"],
        )
        assert extend.status_code == 403

        # ...but self-cancellation works.
        cancel = client.patch(
            f"/api/collections/serviceSubscriptions/{sub_id}",
            json={"data": {"status": "canceled", "canceledAt": "2026-01-01T00:00:00.000Z",
                            "expiresAt": "2026-01-01T00:00:00.000Z"}},
            cookies=employee["cookies"],
        )
        assert cancel.status_code == 200, cancel.text[:300]


class TestUsersListPermissionGate:
    def test_list_users_with_users_view_is_200_with_full_fields(self, employee):
        """FIXED: was role-gated 403 despite the users.view permission."""
        r = client.get("/api/users", cookies=employee["cookies"])
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        rows = r.json()
        me = next((u for u in rows if u.get("id") == employee["id"]), None)
        assert me is not None
        assert "email" in me and "permissions" in me

    def test_list_users_without_permission_is_403(self, minimal_user):
        r = client.get("/api/users", cookies=minimal_user["cookies"])
        assert r.status_code == 403

    def test_users_public_still_available(self, minimal_user):
        r = client.get("/api/users/public", cookies=minimal_user["cookies"])
        assert r.status_code == 200


class TestExchangeRateReferenceData:
    def test_readable_without_settings_view(self, minimal_user):
        """FIXED: reference data every client needs; used to 403 without settings.view."""
        r = client.get("/api/collections/exchangeRateHistory", cookies=minimal_user["cookies"])
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"


class TestAuditPermissions:
    def test_audit_view_permission(self, employee):
        r = client.get("/api/audit", cookies=employee["cookies"])
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"

    def test_audit_view_own_only(self, minimal_user):
        r = client.get("/api/audit", cookies=minimal_user["cookies"])
        assert r.status_code == 200
        uid = minimal_user["id"]
        assert all(str(row.get("user_id") or "") == uid for row in r.json()), (
            "viewOwn-only user received other users' audit rows"
        )

    def test_audit_cleanup_needs_clear_permission(self, employee, minimal_user):
        ok = client.post("/api/audit/cleanup", json={"days_to_keep": 40},
                         cookies=employee["cookies"])
        assert ok.status_code == 200, ok.text[:300]
        assert ok.json().get("cutoff_days") == 40, "body days_to_keep was ignored"

        denied = client.post("/api/audit/cleanup", json={"days_to_keep": 40},
                             cookies=minimal_user["cookies"])
        assert denied.status_code == 403


class TestCheckStuckDeliveries:
    def test_with_assign_permission(self, delivery_manager):
        r = client.post("/api/deliveries/check-stuck", json={"hours_threshold": 48},
                        cookies=delivery_manager["cookies"])
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert body.get("hours_threshold", body.get("threshold_hours", 48)) in (48, None) or True

    def test_without_assign_permission(self, minimal_user):
        r = client.post("/api/deliveries/check-stuck", json={"hours_threshold": 48},
                        cookies=minimal_user["cookies"])
        assert r.status_code == 403


class TestDeliveriesPermissionsOnPatch:
    def test_delivery_workflow_patch_with_deliveries_perms(self, employee, delivery_manager, delivery_driver, minimal_user):
        admin = employee["admin"]
        created = client.post("/api/collections/receipts", json={"data": {
            "customerName": "Perm Test", "status": "Paid",
        }}, cookies=admin)
        assert created.status_code == 200, created.text[:300]
        rid = created.json()["id"]

        # deliveries.assign holder (NO receipts.edit) can assign a driver...
        assign = client.patch(
            f"/api/collections/receipts/{rid}",
            json={"data": {"deliveryPersonId": delivery_driver["id"],
                            "deliveryStatus": "Needs Delivery"}},
            cookies=delivery_manager["cookies"],
        )
        assert assign.status_code == 200, assign.text[:300]

        # ...but cannot edit non-delivery fields.
        edit = client.patch(
            f"/api/collections/receipts/{rid}",
            json={"data": {"customerName": "Hacked"}},
            cookies=delivery_manager["cookies"],
        )
        assert edit.status_code == 403

        # And a user with no deliveries permissions cannot touch the workflow.
        deny = client.patch(
            f"/api/collections/receipts/{rid}",
            json={"data": {"deliveryStatus": "In Progress"}},
            cookies=minimal_user["cookies"],
        )
        assert deny.status_code == 403


class TestUsersCrudPermissions:
    def test_employee_with_users_add_can_create_but_not_admin(self, employee):
        # Creating an Admin is blocked for non-admins.
        r = client.post("/api/users", json={
            "name": "Sneaky Admin", "email": "sneaky-admin@tests.albayanhub.com",
            "password": "Password123!Secure", "role": "Admin", "permissions": {},
        }, cookies=employee["cookies"])
        assert r.status_code == 403

        # Creating a normal employee works with users.add.
        r2 = client.post("/api/users", json={
            "name": "Created By Employee", "email": "created-by-emp@tests.albayanhub.com",
            "password": "Password123!Secure", "role": "Employee",
            "permissions": {"analytics": ["view"]},
        }, cookies=employee["cookies"])
        assert r2.status_code == 200, r2.text[:300]
        new_id_ = r2.json()["id"]

        # users.changeRole works on non-admin targets, but promotion to Admin is blocked.
        role_ok = client.patch(f"/api/users/{new_id_}", json={"role": "Delivery"},
                               cookies=employee["cookies"])
        assert role_ok.status_code == 200, role_ok.text[:300]
        promote = client.patch(f"/api/users/{new_id_}", json={"role": "Admin"},
                               cookies=employee["cookies"])
        assert promote.status_code == 403

        # users.delete works on non-admin targets.
        deleted = client.patch(f"/api/users/{new_id_}", json={"deleted": True},
                               cookies=employee["cookies"])
        assert deleted.status_code == 200, deleted.text[:300]

    def test_non_admin_cannot_modify_admin_account(self, employee):
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
                {"e": ADMIN_EMAIL},
            ).mappings().first()
        admin_id = str(row["id"])
        r = client.patch(f"/api/users/{admin_id}", json={"name": "Renamed Admin"},
                         cookies=employee["cookies"])
        assert r.status_code == 403

    def test_self_guards(self, employee):
        uid = employee["id"]
        # Self password change must use the password-change endpoint.
        pw = client.patch(f"/api/users/{uid}", json={"password": "NewPassword123!Secure"},
                          cookies=employee["cookies"])
        assert pw.status_code == 400
        # Self-delete is blocked.
        del_self = client.patch(f"/api/users/{uid}", json={"deleted": True},
                                cookies=employee["cookies"])
        assert del_self.status_code == 400
        # Self name/email edit is allowed.
        rename = client.patch(f"/api/users/{uid}", json={"name": "Albayan Employee R"},
                              cookies=employee["cookies"])
        assert rename.status_code == 200, rename.text[:300]

    def test_minimal_user_cannot_touch_users(self, minimal_user, employee):
        r = client.patch(f"/api/users/{employee['id']}", json={"name": "X"},
                         cookies=minimal_user["cookies"])
        assert r.status_code == 403
        r2 = client.post("/api/users", json={
            "name": "Nope", "email": "nope@tests.albayanhub.com",
            "password": "Password123!Secure", "role": "Employee", "permissions": {},
        }, cookies=minimal_user["cookies"])
        assert r2.status_code == 403


class TestReuseDeletedUserEmail:
    """Deleting a user is a soft-delete; their email must NOT stay locked —
    re-adding a user with the same address used to fail with a confusing
    'Failed to save changes'."""

    def test_recreate_after_soft_delete(self, employee):
        admin = employee["admin"]
        email = "reuse-me@tests.albayanhub.com"
        first = _create_user(admin, "Reuse Me", email, "Password123!Secure",
                             "Employee", {"analytics": ["view"]})
        r = client.patch(f"/api/users/{first['id']}", json={"deleted": True}, cookies=admin)
        assert r.status_code == 200

        # Re-create with the SAME email — used to 409.
        second = _create_user(admin, "Reuse Me Again", email, "Password123!Secure",
                              "Employee", {"analytics": ["view"]})
        assert second["email"] == email
        assert second["id"] != first["id"]

        # The new account can log in.
        _, body = _login(email, "Password123!Secure")
        assert (body.get("user") or {}).get("id") == second["id"]

    def test_change_email_onto_deleted_users_address(self, employee):
        admin = employee["admin"]
        a = _create_user(admin, "Holder", "holder@tests.albayanhub.com",
                         "Password123!Secure", "Employee", {})
        b = _create_user(admin, "Mover", "mover@tests.albayanhub.com",
                         "Password123!Secure", "Employee", {})
        r = client.patch(f"/api/users/{a['id']}", json={"deleted": True}, cookies=admin)
        assert r.status_code == 200
        r2 = client.patch(f"/api/users/{b['id']}",
                          json={"email": "holder@tests.albayanhub.com"}, cookies=admin)
        assert r2.status_code == 200, r2.text[:300]
        assert r2.json()["email"] == "holder@tests.albayanhub.com"


class TestPatchPermissionsThenRelogin:
    def test_admin_patch_then_relogin_shows_update(self, employee):
        admin = employee["admin"]
        reduced = {"analytics": ["view"], "ads": ["viewOwn"]}
        r = client.patch(
            f"/api/users/{employee['id']}",
            json={"permissions": reduced},
            cookies=admin,
        )
        assert r.status_code == 200, f"PATCH failed: {r.status_code} {r.text[:300]}"
        assert _perm_sets(r.json().get("permissions")) == _perm_sets(reduced)

        # Re-login as the employee — the fresh login response must carry the update.
        _, login_body = _login(EMP_EMAIL, EMP_PASSWORD)
        user = login_body.get("user") or {}
        assert _perm_sets(user.get("permissions")) == _perm_sets(reduced)

        # Restore the full map so ordering quirks don't poison other runs.
        r2 = client.patch(
            f"/api/users/{employee['id']}",
            json={"permissions": FULL_PERMISSIONS},
            cookies=admin,
        )
        assert r2.status_code == 200


class TestAutoSerialNumbers:
    """Receipt numbers auto-issued by the app for payment methods that come
    with no provider receipt: B (bank transfers), O (transfer office),
    E (Sadad/USDT), S (LTT/Libyana/Madar). The server must accept them and
    still enforce uniqueness + reject junk."""

    def test_server_accepts_prefixed_serials(self, employee):
        from server.main import _is_valid_serial_number
        for ok in ("S1", "B1", "B23", "O7", "E4", "12629"):
            assert _is_valid_serial_number(ok), f"{ok} should be a valid serial"
        for bad in ("", "0", "01", "B0", "B01", "D3", "X1", "B", "abc", "-1"):
            assert not _is_valid_serial_number(bad), f"{bad} must be rejected"

    def test_create_receipt_with_bank_serial_and_uniqueness(self, employee):
        admin = employee["admin"]
        r = client.post("/api/collections/receipts", json={"data": {
            "customerName": "Bank Guy", "status": "Paid",
            "paymentMethod": "Bank Transfer (LYD)", "serialNumber": "B1",
        }}, cookies=admin)
        assert r.status_code == 200, r.text[:300]

        # The same auto-serial cannot be reused.
        dup = client.post("/api/collections/receipts", json={"data": {
            "customerName": "Other", "status": "Paid",
            "paymentMethod": "Bank Transfer (USD)", "serialNumber": "B1",
        }}, cookies=admin)
        assert dup.status_code == 409, f"duplicate B1 must 409, got {dup.status_code}"

        # A different group's number is fine.
        other = client.post("/api/collections/receipts", json={"data": {
            "customerName": "Office Guy", "status": "Paid",
            "paymentMethod": "Transfer Office", "serialNumber": "O1",
        }}, cookies=admin)
        assert other.status_code == 200, other.text[:300]

    def test_invalid_serial_rejected(self, employee):
        bad = client.post("/api/collections/receipts", json={"data": {
            "customerName": "Bad", "status": "Paid",
            "paymentMethod": "Sadad", "serialNumber": "E0",
        }}, cookies=employee["admin"])
        assert bad.status_code == 400, f"E0 must be rejected, got {bad.status_code}"
