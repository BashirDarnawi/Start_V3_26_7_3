import argparse
import json
from getpass import getpass

from server.db import db_conn, init_db, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from sqlalchemy import text


def main():
    parser = argparse.ArgumentParser(description="Create or update an Admin user for Albayan Server")
    parser.add_argument("--email", required=True, help="Admin email")
    parser.add_argument("--name", default="Admin", help="Admin name")
    parser.add_argument("--password", default=None, help="Admin password (if omitted, will prompt)")
    args = parser.parse_args()

    init_db()

    email = args.email.strip().lower()
    name = args.name.strip() or "Admin"
    password = args.password or getpass("Admin password: ")
    if len(password) < 8:
        raise SystemExit("Password must be at least 8 characters")

    pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()

    with db_conn() as conn:
        row = (
            conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1"),
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
            print(f"Updated existing admin: {email} (id={user_id})")
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


