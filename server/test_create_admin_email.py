"""Bug-hunt R1 (server-auth-security-2): an admin is only created under an address the API accepts.

``python -m server.create_admin`` and ALBAYAN_BOOTSTRAP_ADMIN_EMAIL stored the operator's email
with no check, while sign-in (LoginRequest) and every user listing (UserPublic) use EmailStr. An
admin created as owner@albayan could never sign in, and its row made GET /api/users answer 500
for every user manager. Both paths now apply the API's own rule before writing anything.

Stage A (F-email): the rule is applied to the address in the form it is STORED. The API checked
the address and lower-cased it afterwards, and "\u0130" (a dotted capital I) lower-cases to two
characters: any signed-in account could PATCH its own e-mail to 33 of them (valid, 33 characters),
have 66 stored, and from then on GET /api/users answered 500 for every user manager and
/api/auth/me for that account; a single one stored an address the account could never sign in
with again. Such an address is now a 400 on every write path (self-edit, create, first-admin
setup, the CLI), sign-in looks an address up the way it was stored, and one old bad row can no
longer break a reply that lists users.

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
from server.db import db_conn, init_db, json_dumps, now_ms
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id, normalize_signin_email

TAG = secrets.token_hex(4)
PASSWORD = "CliAdminEmail123!"
REFUSED = (f"owner-{TAG}@albayan", f"admin-{TAG}@localhost")
DOTTED_I = "\u0130"  # lower-cases to "i" + U+0307: one character becomes two
STORED_FORM_REFUSED = ("66 characters once stored", "one dotted capital I")


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


# ---------------------------------------------------------------- F-email: the STORED form is the one checked

client = TestClient(main.app, headers={"Origin": "http://testserver"}, raise_server_exceptions=False)
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
_counter = [0]


def _refused_address(kind):
    """A fresh address of each refused kind (a repeat would answer 409, not show the rule)."""
    _counter[0] += 1
    if kind == "66 characters once stored":  # valid as typed: 33 characters and a short tail before the @
        return DOTTED_I * 33 + f"-{TAG}-{_counter[0]}@example.com"
    # Valid as typed AND once lower-cased, but stored as "i" + U+0307: nobody types that at sign-in.
    return f"{DOTTED_I}brahim-{TAG}-{_counter[0]}@example.com"


def _seed_user(label, role="Employee", permissions=None, email=None):
    _counter[0] += 1
    uid = new_id("user")
    email = email or f"f-email-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perms,"
                 ":hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": uid, "name": f"F-email {label}", "email": email, "role": role, "perms": json_dumps(permissions or {}),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iter": _HASH.iterations, "now": now_ms()},
        )
    return {"id": uid, "email": email}


def _sign_in(email, password=PASSWORD):
    reply = client.post("/api/auth/login", json={"email": email, "password": password})
    cookies = {"albayan_session": reply.cookies.get("albayan_session")}
    client.cookies.clear()
    return reply, cookies


def _signed_in(label, role="Employee", permissions=None):
    user = _seed_user(label, role, permissions)
    reply, cookies = _sign_in(user["email"])
    assert reply.status_code == 200, reply.text
    return {**user, "cookies": cookies}


def _stored_email(user_id):
    with db_conn() as conn:
        return conn.execute(text("SELECT email FROM users WHERE id=:id"), {"id": user_id}).scalar()


def _tagged_users():
    with db_conn() as conn:
        return int(conn.execute(text("SELECT COUNT(*) FROM users WHERE email LIKE :tag"), {"tag": f"%{TAG}%"}).scalar() or 0)


@pytest.fixture(scope="module")
def admin():
    return _signed_in("admin", "Admin")


@pytest.mark.parametrize("typed, stored", [
    (f"Owner-{TAG}@Example.COM", f"owner-{TAG}@example.com"),
    (f"  spaced-{TAG}@example.com ", f"spaced-{TAG}@example.com"),
    ("\u00d1AND\u00da@example.com", "\u00f1and\u00fa@example.com"),
    ("\u0645\u062d\u0645\u062f@example.com", "\u0645\u062d\u0645\u062f@example.com"),
])
def test_an_ordinary_address_is_normalized_to_its_stored_form(typed, stored):
    assert normalize_signin_email(typed) == stored
    assert normalize_signin_email(stored) == stored  # what is stored stays put


@pytest.mark.parametrize("bad", [
    DOTTED_I * 33 + "@example.com",  # before: returned with 66 characters before the @
    f"{DOTTED_I}brahim@example.com",  # before: returned as "i" + U+0307 + "brahim@..."
    "I\u0307brahim@example.com",  # the same letter typed as I + a combining dot
    # 201 bytes as typed, 265 once lower-cased (each of these letters grows by a byte): over the 254 limit
    "\u023a" * 64 + "@" + "a" * 60 + ".example.com",
    # Valid as typed; lower-cased it is no longer the form the address rule itself produces
    "J\u030cx@example.com",
], ids=["66-once-stored", "dotted-capital-i", "i-plus-combining-dot", "longer-in-bytes-once-stored", "recomposes-once-stored"])
def test_an_address_whose_stored_form_is_not_a_valid_sign_in_address_is_refused(bad):
    with pytest.raises(ValueError):
        normalize_signin_email(bad)


@pytest.mark.parametrize("kind", STORED_FORM_REFUSED)
def test_cli_refuses_an_address_whose_stored_form_is_not_valid(monkeypatch, kind):
    bad = _refused_address(kind)
    before = _tagged_users()
    monkeypatch.setattr(sys, "argv", ["create_admin", "--email", bad, "--password", PASSWORD])
    with pytest.raises(SystemExit) as refused:
        create_admin.main()  # before: "Created admin: ..." under the two-character spelling
    assert "Not a valid sign-in email" in str(refused.value)
    assert _tagged_users() == before


@pytest.mark.parametrize("kind", STORED_FORM_REFUSED)
def test_bootstrap_skips_an_address_whose_stored_form_is_not_valid(monkeypatch, capsys, kind):
    monkeypatch.setenv("ALBAYAN_BOOTSTRAP_ADMIN_EMAIL", _refused_address(kind))
    monkeypatch.setenv("ALBAYAN_BOOTSTRAP_ADMIN_PASSWORD", PASSWORD)
    before = _tagged_users()
    with db_conn() as conn:  # the bootstrap only acts on a server with no active users (see above)
        active = conn.execute(text("SELECT id FROM users WHERE deleted = false")).scalars().all()
        conn.execute(text("UPDATE users SET deleted = true WHERE deleted = false"))
    try:
        main._bootstrap_first_admin_if_empty()
        with db_conn() as conn:
            created = conn.execute(text("SELECT email FROM users WHERE deleted = false")).scalars().all()
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM users WHERE deleted = false"))
            for uid in active:
                conn.execute(text("UPDATE users SET deleted = false WHERE id=:id"), {"id": uid})
    assert created == []  # before (one letter): bootstrapped under the two-character spelling
    assert _tagged_users() == before
    assert "not a valid sign-in email" in capsys.readouterr().out


@pytest.mark.parametrize("kind", STORED_FORM_REFUSED)
def test_self_edit_cannot_store_an_address_that_breaks_the_users_list(admin, kind):
    # Self-edit needs no users.* grant: an Ads Studio customer, a driver or an employee all qualify.
    account = _signed_in("self")
    reply = client.patch(f"/api/users/{account['id']}", json={"email": _refused_address(kind)}, cookies=account["cookies"])
    assert reply.status_code == 400, reply.text  # before: 500 AFTER the write (66 characters) / 200 (one letter)
    assert reply.json() == {"detail": "Not a valid sign-in email"}
    assert _stored_email(account["id"]) == account["email"]
    listing = client.get("/api/users", cookies=admin["cookies"])
    assert listing.status_code == 200, listing.text  # before: 500 for every user manager
    assert account["email"] in [row["email"] for row in listing.json()]
    me = client.get("/api/auth/me", cookies=account["cookies"])
    assert me.status_code == 200 and me.json()["email"] == account["email"]
    assert _sign_in(account["email"])[0].status_code == 200  # before: locked out


@pytest.mark.parametrize("kind", STORED_FORM_REFUSED)
def test_a_user_manager_cannot_store_such_an_address_either(admin, kind):
    before = _tagged_users()
    created = client.post(
        "/api/users",
        json={"name": "F-email new", "email": _refused_address(kind), "password": PASSWORD, "role": "Employee"},
        cookies=admin["cookies"],
    )
    assert created.status_code == 400, created.text  # before: 500 with the row already inserted / 200
    assert created.json() == {"detail": "Not a valid sign-in email"}
    assert _tagged_users() == before
    other = _seed_user("edited")
    edited = client.patch(f"/api/users/{other['id']}", json={"email": _refused_address(kind)}, cookies=admin["cookies"])
    assert edited.status_code == 400, edited.text
    assert _stored_email(other["id"]) == other["email"]
    assert client.get("/api/users", cookies=admin["cookies"]).status_code == 200


@pytest.mark.parametrize("kind", STORED_FORM_REFUSED)
def test_first_admin_setup_refuses_such_an_address(monkeypatch, kind):
    token = f"f-email-setup-token-{TAG}-0123456789"
    monkeypatch.setattr(main, "SETUP_TOKEN", token)
    sentinel = "SELECT COUNT(*) FROM entities WHERE type='_bootstrap' AND id='singleton'"
    # Browser setup only acts on a server with no active users: hide this shared
    # database's users for the call, then put every one of them back.
    with db_conn() as conn:
        active = conn.execute(text("SELECT id FROM users WHERE deleted = false")).scalars().all()
        conn.execute(text("UPDATE users SET deleted = true WHERE deleted = false"))
        had_sentinel = int(conn.execute(text(sentinel)).scalar() or 0)
    try:
        reply = client.post(
            "/api/auth/setup-admin",
            json={"name": "Owner", "email": _refused_address(kind), "password": PASSWORD, "setupToken": token},
        )
        client.cookies.clear()
        with db_conn() as conn:
            created = conn.execute(text("SELECT id FROM users WHERE deleted = false")).scalars().all()
            sentinel_now = int(conn.execute(text(sentinel)).scalar() or 0)
    finally:
        with db_conn() as conn:
            for uid in conn.execute(text("SELECT id FROM users WHERE deleted = false")).scalars().all():
                for table in ("sessions", "audit_logs"):
                    conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": uid})
                conn.execute(text("DELETE FROM users WHERE id=:uid"), {"uid": uid})
            for uid in active:
                conn.execute(text("UPDATE users SET deleted = false WHERE id=:id"), {"id": uid})
            if not had_sentinel:
                conn.execute(text("DELETE FROM entities WHERE type='_bootstrap' AND id='singleton'"))
        for key in ("setup:ip:testclient", "setup:global"):
            reset_rate_limit(key)
    assert reply.status_code == 400, reply.text  # before: 500 with the admin already stored / 200
    assert reply.json() == {"detail": "Not a valid sign-in email"}
    assert created == [] and sentinel_now == had_sentinel  # nothing was written


def test_one_bad_stored_address_never_breaks_a_reply_that_lists_users(admin):
    # Rows the old code could store (and anything a restore or a manual fix leaves behind).
    victim = _signed_in("victim")
    long_stored = ("i\u0307" * 33) + f"-stored-{TAG}@example.com"  # 66 characters before the @
    no_dot = _seed_user("nodot", email=f"owner-nodot-{TAG}@albayan")
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET email=:e WHERE id=:id"), {"e": long_stored, "id": victim["id"]})
    listing = client.get("/api/users", cookies=admin["cookies"])
    assert listing.status_code == 200, listing.text  # before: 500 for every user manager
    listed = {row["id"]: row["email"] for row in listing.json()}
    assert listed[victim["id"]] == long_stored and listed[no_dot["id"]] == no_dot["email"]
    me = client.get("/api/auth/me", cookies=victim["cookies"])
    assert me.status_code == 200 and me.json()["email"] == long_stored  # before: 500
    start = client.get("/api/bootstrap", cookies=victim["cookies"])
    assert start.status_code == 200 and start.json()["user"]["email"] == long_stored  # before: 500
    # A manager can open and repair the row from the Users screen again.
    renamed = client.patch(f"/api/users/{victim['id']}", json={"name": "F-email renamed"}, cookies=admin["cookies"])
    assert renamed.status_code == 200 and renamed.json()["email"] == long_stored  # before: 500
    repaired_address = f"f-email-repaired-{TAG}@tests.albayanhub.com"
    repaired = client.patch(f"/api/users/{victim['id']}", json={"email": repaired_address}, cookies=admin["cookies"])
    assert repaired.status_code == 200 and repaired.json()["email"] == repaired_address
    assert _sign_in(repaired_address)[0].status_code == 200


def test_ordinary_and_mixed_case_addresses_still_work(admin):
    typed = f"Mixed.Case-{TAG}@Example.COM"
    created = client.post(
        "/api/users", json={"name": "F-email mixed", "email": typed, "password": PASSWORD, "role": "Employee"},
        cookies=admin["cookies"],
    )
    assert created.status_code == 200, created.text
    assert created.json()["email"] == typed.lower() == _stored_email(created.json()["id"])
    reply, cookies = _sign_in(typed)
    assert reply.status_code == 200, reply.text
    moved = f"Moved.Case-{TAG}@Example.COM"
    edited = client.patch(f"/api/users/{created.json()['id']}", json={"email": moved}, cookies=cookies)
    assert edited.status_code == 200 and edited.json()["email"] == moved.lower()
    assert _sign_in(moved.upper())[0].status_code == 200
    assert _sign_in(typed)[0].status_code == 401  # the old address is gone


def test_sign_in_finds_a_non_ascii_address_in_any_letter_case(admin):
    # The address is lower-cased by Python when stored; the database's own lower() only
    # handles ASCII on SQLite, so a capital typed at sign-in never matched.
    typed = f"\u00d1and\u00fa-{TAG}@example.com"
    created = client.post(
        "/api/users", json={"name": "F-email accent", "email": typed, "password": PASSWORD, "role": "Employee"},
        cookies=admin["cookies"],
    )
    assert created.status_code == 200, created.text
    assert created.json()["email"] == f"\u00f1and\u00fa-{TAG}@example.com"
    assert _sign_in(typed.upper())[0].status_code == 200  # before: 401
    assert _sign_in(typed.lower())[0].status_code == 200


def test_an_account_stored_under_the_two_character_spelling_can_sign_in_again(admin):
    # The old code stored "\u0130brahim@..." as "i" + U+0307 + "brahim@...", and sign-in then
    # compared the typed capital with it through the database's lower(): never a match.
    legacy = _seed_user("legacy", email=f"i\u0307brahim-legacy-{TAG}@example.com")
    reply, cookies = _sign_in(f"{DOTTED_I}brahim-legacy-{TAG}@example.com")
    assert reply.status_code == 200, reply.text  # before: 401
    assert reply.json()["user"]["id"] == legacy["id"]
    # Saving the profile with the address the server itself reported keeps working.
    saved = client.patch(
        f"/api/users/{legacy['id']}", json={"name": "F-email legacy", "email": reply.json()["user"]["email"]}, cookies=cookies,
    )
    assert saved.status_code == 200, saved.text
    assert _stored_email(legacy["id"]) == f"i\u0307brahim-legacy-{TAG}@example.com"
