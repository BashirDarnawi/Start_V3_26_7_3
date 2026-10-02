import argparse
import json
from getpass import getpass

from server.db import db_conn, get_engine, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id, normalize_signin_email
from sqlalchemy import text


def main():
    parser = argparse.ArgumentParser(description="Create or update an Admin user for Albayan Server")
    parser.add_argument("--email", required=True, help="Admin email")
    parser.add_argument("--name", default="Admin", help="Admin name")
    parser.add_argument("--password", default=None, help="Admin password (if omitted, will prompt)")
    args = parser.parse_args()

    # The API's own rule, before anything is written: sign-in and the Users
    # screen refuse any other address (owner@albayan, admin@localhost).
    try:
        email = normalize_signin_email(args.email)
    except ValueError:
        raise SystemExit(f"Not a valid sign-in email: {args.email!r}") from None

    init_db()

    name = args.name.strip() or "Admin"
    password = args.password or getpass("Admin password: ")
    if len(password) < 8:
        raise SystemExit("Password must be at least 8 characters")

    pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()

    # Lock the row (PostgreSQL) so a login that verified the OLD password at this
    # moment fails its password-snapshot check instead of minting a new session.
    lock = " FOR UPDATE" if str(get_engine().dialect.name or "") == "postgresql" else ""
    with db_conn() as conn:
        row = (
            conn.execute(
                text(f"SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1{lock}"),
                {"email": email},
            )
            .mappings()
            .first()
        )
        if row:
            user_id = row["id"]
            conn.execute(
                text(
                    """
                    UPDATE users
                    SET
                      name = :name,
                      role = 'Admin',
                      permissions_json = :permissions_json,
                      password_hash = :password_hash,
                      password_salt = :password_salt,
                      password_algo = :password_algo,
                      password_iterations = :password_iterations,
                      deleted = false,
                      last_modified = :last_modified
                    WHERE id = :id
                    """
                ),
                {
                    "name": name,
                    "permissions_json": json_dumps({}),  # Admin gets all permissions server-side
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "last_modified": now,
                    "id": user_id,
                },
            )
            # A password reset here is the recovery path after a leak or takeover:
            # every proof of access made with the old password must stop working,
            # exactly like the in-app paths (main._revoke_user_credentials_conn).
            for table in ("sessions", "app_logins", "password_resets"):
                conn.execute(text(f"DELETE FROM {table} WHERE user_id=:uid"), {"uid": user_id})
            print(f"Updated existing admin: {email} (id={user_id})")
            print("All existing sessions and app sign-ins for this user were signed out.")
        else:
            user_id = new_id("user")
            conn.execute(
                text(
                    """
                    INSERT INTO users (
                      id, name, email, role, permissions_json,
                      password_hash, password_salt, password_algo, password_iterations,
                      deleted, created_at, created_by, last_modified
                    )
                    VALUES (
                      :id, :name, :email, 'Admin', :permissions_json,
                      :password_hash, :password_salt, :password_algo, :password_iterations,
                      false, :created_at, :created_by, :last_modified
                    )
                    """
                ),
                {
                    "id": user_id,
                    "name": name,
                    "email": email,
                    "permissions_json": json_dumps({}),
                    "password_hash": pw.hash_hex,
                    "password_salt": pw.salt_hex,
                    "password_algo": pw.algo,
                    "password_iterations": pw.iterations,
                    "created_at": now,
                    "created_by": user_id,
                    "last_modified": now,
                },
            )
            print(f"Created admin: {email} (id={user_id})")


if __name__ == "__main__":
    main()


