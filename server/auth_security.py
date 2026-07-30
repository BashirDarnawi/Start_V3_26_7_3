"""Database-backed authentication hardening helpers."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from .db import db_conn
from .security import (
    PBKDF2_ITERATIONS_DEFAULT,
    hash_password,
    password_hash_needs_upgrade,
)


def upgrade_password_hash_after_login(user: dict[str, Any], password: str) -> bool:
    """Upgrade a verified legacy hash without overwriting a concurrent reset."""
    old_algo = str(user.get("password_algo") or "")
    try:
        old_iterations = int(user.get("password_iterations") or 0)
    except (TypeError, ValueError):
        return False
    if not password_hash_needs_upgrade(old_algo, old_iterations):
        return True

    upgraded = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        result = conn.execute(
            text(
                "UPDATE users SET password_hash=:new_hash, password_salt=:new_salt, "
                "password_algo=:new_algo, password_iterations=:new_iterations "
                "WHERE id=:id AND deleted=false AND password_hash=:old_hash "
                "AND password_salt=:old_salt AND password_algo=:old_algo "
                "AND password_iterations=:old_iterations"
            ),
            {
                "id": str(user.get("id") or ""),
                "new_hash": upgraded.hash_hex,
                "new_salt": upgraded.salt_hex,
                "new_algo": upgraded.algo,
                "new_iterations": upgraded.iterations,
                "old_hash": str(user.get("password_hash") or ""),
                "old_salt": str(user.get("password_salt") or ""),
                "old_algo": old_algo,
                "old_iterations": old_iterations,
            },
        )
    return int(result.rowcount or 0) == 1
