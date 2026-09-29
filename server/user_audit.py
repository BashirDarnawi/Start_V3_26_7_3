"""What an account change did, for the shared audit log (review loop r8 #18).

``PATCH /api/users/{id}`` and ``POST /api/users`` used to write "Updated user <id>" with empty
metadata for a rename, a role change, a permission grant, a password reset and a delete alike,
so the owner could not tell afterwards who changed what. These helpers describe the change.

Never a password, hash, salt or algorithm: a password reset is recorded only as
``passwordReset: true``.
"""

import json
from typing import Any

# Stored with the change but never copied into the audit metadata.
_NOT_AUDITED = frozenset(
    {"password_hash", "password_salt", "password_algo", "password_iterations", "last_modified"}
)


def permission_names(permissions: Any) -> list[str]:
    """``{"receipts": ["export"]}`` (or its stored JSON text) -> ``["receipts.export"]``."""
    if isinstance(permissions, (str, bytes)):
        try:
            permissions = json.loads(permissions or "{}")
        except ValueError:
            return []
    if not isinstance(permissions, dict):
        return []
    return sorted(
        {
            f"{module}.{action}"
            for module, actions in permissions.items()
            if isinstance(actions, list)
            for action in actions
            if isinstance(action, str)
        }
    )


def _changed(key: str, new: Any, old: Any) -> bool:
    if key == "permissions_json":
        return permission_names(new) != permission_names(old)
    if key == "deleted":
        return bool(new) != bool(old)
    return str(new if new is not None else "") != str(old if old is not None else "")


def user_update_audit(
    existing: dict[str, Any], update_fields: dict[str, Any]
) -> tuple[str, str, dict[str, Any]]:
    """(action, message, metadata) for the audit row of one applied user update."""
    user_id = str(existing.get("id") or "")
    fields = sorted(
        key
        for key in update_fields
        if key not in _NOT_AUDITED and _changed(key, update_fields[key], existing.get(key))
    )
    meta: dict[str, Any] = {"fields": fields}
    parts: list[str] = []
    if "role" in fields:
        meta["roleBefore"] = str(existing.get("role") or "")
        meta["roleAfter"] = str(update_fields["role"] or "")
        parts.append(f"role {meta['roleBefore']} -> {meta['roleAfter']}")
    if "permissions_json" in fields:
        before = set(permission_names(existing.get("permissions_json")))
        after = set(permission_names(update_fields["permissions_json"]))
        meta["permissionsAdded"] = sorted(after - before)
        meta["permissionsRemoved"] = sorted(before - after)
        parts.append("permissions")
    if "email" in fields:
        meta["emailBefore"] = str(existing.get("email") or "")
        meta["emailAfter"] = str(update_fields["email"] or "")
        parts.append("sign-in email")
    if "name" in fields:
        parts.append("name")
    if "password_hash" in update_fields:
        meta["passwordReset"] = True
        parts.append("password reset")
    if "deleted" in update_fields:
        meta["deleted"] = bool(update_fields["deleted"])
    if update_fields.get("deleted") is True and "deleted" in fields:
        return "delete", f"Deleted user {user_id}", meta
    if "deleted" in fields:
        parts.append("restored")
    suffix = f": {', '.join(parts)}" if parts else ""
    return "update", f"Updated user {user_id}{suffix}", meta


def user_create_audit_metadata(role: Any, permissions: Any) -> dict[str, Any]:
    """The role and the permissions a new account starts with."""
    return {"role": str(role or ""), "permissions": permission_names(permissions)}
