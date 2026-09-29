"""Review loop round 6, batch U: user management.

* n=33 a driver with open delivery jobs keeps the Delivery role for EVERY editor: the Admin's role
       change is refused too (before: only non-admin editors were checked, the Admin got 200 and the
       board showed the driver's jobs as unassigned).
* n=37 the password-reset takeover guard covers a Delivery account that holds unscoped power
       (users.*, auditLogs.view, ...); an ordinary template driver can still be reset by a
       users.resetPassword holder.
* n=34 the server side of delegated user creation: a users.add holder creates an Employee when the
       create sends no permission map (the client now leaves it out), and is refused when a map is sent.

Every test builds its own users (unique e-mails per run) and removes the entity rows it adds.
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR6UserPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(main_module.app, headers={"Origin": "http://testserver"})
_counter = [0]

DRIVER_TEMPLATE = {
    "deliveries": ["viewOwn", "accept", "complete", "markCollected"],
    "ads": ["viewOwn"],
    "customers": ["viewOwn", "viewContacts"],
}


def _seed_user(label: str, role: str = "Employee", permissions: dict | None = None) -> dict:
    _counter[0] += 1
    uid = new_id("user")
    email = f"r6u-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": f"R6U {label}", "email": email, "role": role, "perms": json_dumps(permissions or {}),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iter": _HASH.iterations, "now": now_ms()},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "email": email, "cookies": cookies}


def _user_row(user_id: str) -> dict:
    with db_conn() as conn:
        return dict(conn.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_id}).mappings().first())


@pytest.fixture(scope="module")
def admin():
    init_db()
    return _seed_user("admin", "Admin")


@pytest.fixture
def entity_rows():
    added: list[tuple[str, str]] = []

    def _add(entity_type: str, data: dict) -> str:
        entity_id = f"r6u_{entity_type}_{TAG}_{secrets.token_hex(3)}"
        stamp = now_ms()
        with db_conn() as conn:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data,false,:stamp,NULL,:stamp)"),
                {"type": entity_type, "id": entity_id, "data": json_dumps({"id": entity_id, **data}), "stamp": stamp},
            )
        added.append((entity_type, entity_id))
        return entity_id

    yield _add
    with db_conn() as conn:
        for entity_type, entity_id in added:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": entity_type, "id": entity_id})


def _set_delivery_status(entity_type: str, entity_id: str, status: str) -> None:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type=:t AND id=:id"), {"t": entity_type, "id": entity_id}).mappings().first()
        data = json_loads(row["data_json"]) or {}
        data["deliveryStatus"] = status
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type=:t AND id=:id"), {"d": json_dumps(data), "t": entity_type, "id": entity_id})


# ---------------------------------------------------------------- n=33

@pytest.mark.parametrize("entity_type", ["receipts", "ads"])
def test_admin_cannot_take_the_delivery_role_from_a_driver_with_open_jobs(admin, entity_rows, entity_type):
    driver = _seed_user(f"driver-{entity_type}", "Delivery", DRIVER_TEMPLATE)
    job = entity_rows(entity_type, {"deliveryPersonId": driver["id"], "deliveryStatus": "In Progress", "customerId": "c"})
    refused = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee"}, cookies=admin["cookies"])
    assert refused.status_code == 409, refused.text          # before: 200 for the Admin
    assert "open delivery jobs" in refused.text
    assert _user_row(driver["id"])["role"] == "Delivery"
    # Once the job is finished, the Admin may change the role.
    _set_delivery_status(entity_type, job, "Delivered")
    ok = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee"}, cookies=admin["cookies"])
    assert ok.status_code == 200, ok.text
    assert _user_row(driver["id"])["role"] == "Employee"


def test_change_role_holder_is_refused_too_and_a_waiting_job_counts(admin, entity_rows):
    office = _seed_user("office", "Employee", {"users": ["view", "changeRole"]})
    driver = _seed_user("driver-plain", "Delivery", {})
    entity_rows("receipts", {"deliveryPersonId": driver["id"], "deliveryStatus": "Needs Delivery", "customerId": "c"})
    refused = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee"}, cookies=office["cookies"])
    assert refused.status_code == 409 and "open delivery jobs" in refused.text, refused.text
    assert _user_row(driver["id"])["role"] == "Delivery"
    # Deleting the driver in the same request is the delete rule (also refused while the job is open).
    deleted = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee", "deleted": True}, cookies=admin["cookies"])
    assert deleted.status_code == 409 and "open delivery jobs" in deleted.text, deleted.text
    assert not _user_row(driver["id"])["deleted"]


# ---------------------------------------------------------------- n=37

def test_password_reset_guard_covers_a_driver_with_unscoped_grants(admin):
    manager = _seed_user("resetter", "Employee", {"users": ["view", "resetPassword"]})
    template_driver = _seed_user("tpl-driver", "Delivery", {**DRIVER_TEMPLATE, "receipts": ["viewOwn"]})
    powerful_driver = _seed_user("pwr-driver", "Delivery", {**DRIVER_TEMPLATE, "users": ["managePermissions"]})
    auditing_driver = _seed_user("audit-driver", "Delivery", {**DRIVER_TEMPLATE, "auditLogs": ["view"]})

    everyday = client.patch(f"/api/users/{template_driver['id']}", json={"password": "AnotherPassword123!"}, cookies=manager["cookies"])
    assert everyday.status_code == 200, everyday.text        # the everyday driver reset keeps working
    for target in (powerful_driver, auditing_driver):
        before = _user_row(target["id"])["password_hash"]
        refused = client.patch(f"/api/users/{target['id']}", json={"password": "AnotherPassword123!"}, cookies=manager["cookies"])
        assert refused.status_code == 403, refused.text      # before: 200 - an account takeover
        assert "Cannot reset the password" in refused.text
        assert _user_row(target["id"])["password_hash"] == before

    # A holder of the extra grant may still reset that driver.
    peer = _seed_user("peer", "Employee", {"users": ["view", "resetPassword", "managePermissions"]})
    allowed = client.patch(f"/api/users/{powerful_driver['id']}", json={"password": "AnotherPassword123!"}, cookies=peer["cookies"])
    assert allowed.status_code == 200, allowed.text


def test_role_change_keeps_the_narrow_driver_skip(admin):
    # The wider template skip is for password resets only: re-roling a template driver to Employee
    # still needs the grants that stop being job-scoped (ads.viewOwn, customers.viewContacts, ...).
    changer = _seed_user("changer", "Employee", {"users": ["view", "changeRole"]})
    driver = _seed_user("tpl-driver2", "Delivery", DRIVER_TEMPLATE)
    refused = client.patch(f"/api/users/{driver['id']}", json={"role": "Employee"}, cookies=changer["cookies"])
    assert refused.status_code == 403 and "Cannot change the role" in refused.text, refused.text


# ---------------------------------------------------------------- n=34 (server side)

def test_users_add_holder_creates_an_employee_without_a_permission_map(admin):
    adder = _seed_user("adder", "Employee", {"users": ["view", "add"]})
    email = f"r6u-new-{TAG}@tests.albayanhub.com"
    created = client.post("/api/users", json={"name": "R6U New", "email": email, "password": PASSWORD, "role": "Employee"},
                          cookies=adder["cookies"])
    assert created.status_code == 200, created.text
    assert json_loads(_user_row(created.json()["id"])["permissions_json"]) == {}
    # The old client always sent the preset map: refused, which is why the client now leaves it out.
    refused = client.post("/api/users", json={"name": "R6U New2", "email": f"r6u-new2-{TAG}@tests.albayanhub.com", "password": PASSWORD,
                                              "role": "Employee", "permissions": {"customers": ["view"]}}, cookies=adder["cookies"])
    assert refused.status_code == 403 and "managePermissions" in refused.text, refused.text
