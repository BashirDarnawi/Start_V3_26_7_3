"""Bug-hunt R1 (server-auth-security-2): an admin is only created under an address the API accepts.

``python -m server.create_admin`` and ALBAYAN_BOOTSTRAP_ADMIN_EMAIL stored the operator's email
with no check, while sign-in (LoginRequest) and every user listing (UserPublic) use EmailStr. An
admin created as owner@albayan could never sign in, and its row made GET /api/users answer 500
for every user manager. Both paths now apply the API's own rule before writing anything.

Rows this module creates carry a per-run tag and are removed afterwards.
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.create_admin as create_admin
import server.main as main
from server.db import db_conn, init_db

TAG = secrets.token_hex(4)
PASSWORD = "CliAdminEmail123!"
REFUSED = (f"owner-{TAG}@albayan", f"admin-{TAG}@localhost")


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()
    yield
    with db_conn() as conn:
        ids = conn.execute(text("SELECT id FROM users WHERE email LIKE :tag"), {"tag": f"%{TAG}%"}).scalars().all()
        for uid in ids:
            for table in ("sessions", "audit_logs"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
            conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})


def _users_with_email(email):
    with db_conn() as conn:
        return conn.execute(
            text("SELECT COUNT(*) FROM users WHERE lower(email)=lower(:e)"), {"e": email}
        ).scalar()


@pytest.mark.parametrize("bad", REFUSED)
def test_cli_refuses_an_address_the_api_would_reject(monkeypatch, bad):
    monkeypatch.setattr(sys, "argv", ["create_admin", "--email", bad, "--password", PASSWORD])
    with pytest.raises(SystemExit) as refused:
        create_admin.main()  # before: "Created admin: owner-...@albayan"
    assert "Not a valid sign-in email" in str(refused.value)
    assert _users_with_email(bad) == 0


def test_cli_admin_with_a_valid_address_is_stored_as_the_api_stores_it_and_can_sign_in(monkeypatch):
    email = f"Cli-Admin-{TAG}@Example.com"
    monkeypatch.setattr(sys, "argv", ["create_admin", "--email", f"  {email} ", "--password", PASSWORD])
    create_admin.main()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT email, role FROM users WHERE lower(email)=lower(:e)"), {"e": email}
        ).mappings().first()
    assert row is not None and row["role"] == "Admin"
    assert row["email"] == email.lower()
    login = TestClient(main.app, headers={"Origin": "http://testserver"}).post(
        "/api/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text


def test_bootstrap_skips_an_address_the_api_would_reject(monkeypatch, capsys):
    bad = f"boot-{TAG}@localhost"
    monkeypatch.setenv("ALBAYAN_BOOTSTRAP_ADMIN_EMAIL", bad)
    monkeypatch.setenv("ALBAYAN_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD)
    # The bootstrap only acts on a server with no active users: hide this shared
    # database's users for the one call, then put every one of them back.
    with db_conn() as conn:
        active = conn.execute(text("SELECT id FROM users WHERE deleted = false")).scalars().all()
        conn.execute(text("UPDATE users SET deleted = true WHERE deleted = false"))
    try:
        main._bootstrap_first_admin_if_empty()
    finally:
        with db_conn() as conn:
            for uid in active:
                conn.execute(text("UPDATE users SET deleted = false WHERE id=:id"), {"id": uid})
    assert _users_with_email(bad) == 0  # before: "Bootstrapped first admin user: admin-...@localhost"
    assert "not a valid sign-in email" in capsys.readouterr().out
