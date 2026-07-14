import json
from typing import Any


# This is the server-side source of truth for grantable permissions.  Keep it
# in sync with PERMISSION_MODULES in src/04-permissions.js.  Unknown strings
# must never be stored: accepting an arbitrary permission today can turn into
# a privilege escalation later if a feature starts honoring that same name.
PERMISSION_ALLOWLIST: dict[str, frozenset[str]] = {
    "analytics": frozenset({"view", "export", "viewFinancials", "viewSensitive"}),
    "ads": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete",
        "changeStatus", "stopAd", "assignDelivery", "viewPhotos", "uploadPhotos",
    }),
    "receipts": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete",
        "markCollected", "transfer", "viewHistory", "export",
    }),
    "customers": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete",
        "viewBalance", "viewContacts", "export",
    }),
    "pages": frozenset({"view", "add", "edit", "delete", "linkCustomers"}),
    "deliveries": frozenset({
        "view", "viewOwn", "accept", "complete", "markCollected",
        "assign", "reassign", "viewStats",
    }),
    "users": frozenset({
        "view", "add", "edit", "delete", "managePermissions",
        "changeRole", "resetPassword", "viewActivity",
    }),
    "settings": frozenset({"view", "edit", "manageExchangeRate"}),
    "auditLogs": frozenset({"view", "viewOwn", "export", "clear"}),
    "clothesProducts": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn",
    }),
    "clothesShipments": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn",
    }),
    "clothesOrders": frozenset({
        "view", "viewOwn", "add", "edit", "editOwn", "delete", "deleteOwn",
    }),
    "clothesSettings": frozenset({"viewOwn", "add", "editOwn"}),
}

VALID_USER_ROLES = frozenset({"Admin", "Employee", "Delivery"})


def normalize_permissions(permissions: Any) -> dict[str, list[str]]:
    """Validate and deterministically normalize a permission payload.

    Raises ValueError for an unknown module/action or malformed value rather
    than silently storing inert, potentially future-dangerous capabilities.
    """
    if permissions is None:
        return {}
    if not isinstance(permissions, dict):
        raise ValueError("permissions must be an object")

    normalized: dict[str, list[str]] = {}
    for module, raw_actions in permissions.items():
        if module not in PERMISSION_ALLOWLIST:
            raise ValueError(f"Unknown permission module: {module}")
        if not isinstance(raw_actions, list):
            raise ValueError(f"Permissions for {module} must be a list")
        actions: list[str] = []
        for raw_action in raw_actions:
            if not isinstance(raw_action, str) or raw_action not in PERMISSION_ALLOWLIST[module]:
                raise ValueError(f"Unknown permission: {module}.{raw_action}")
            if raw_action not in actions:
                actions.append(raw_action)
        if actions:
            normalized[module] = actions
    return normalized


def _load_permissions(permissions_json: str | None) -> dict[str, list[str]]:
    if not permissions_json:
        return {}
    try:
        data = json.loads(permissions_json)
        if isinstance(data, dict):
            # Legacy rows may contain retired/unknown names.  They are ignored
            # at authorization time; new writes are rejected by
            # normalize_permissions().
            out: dict[str, list[str]] = {}
            for k, v in data.items():
                if k not in PERMISSION_ALLOWLIST or not isinstance(v, list):
                    continue
                actions = [str(x) for x in v if str(x) in PERMISSION_ALLOWLIST[k]]
                if actions:
                    out[k] = actions
            return out
    except Exception:
        return {}
    return {}


def user_has_permission(user: dict[str, Any], module: str, action: str, *, record_creator_id: str | None = None) -> bool:
    role = str(user.get("role") or "")
    if role.lower() == "admin":
        return True

    perms = _load_permissions(user.get("permissions_json"))
    module_perms = perms.get(module, [])
    if action in module_perms:
        return True

    # "Own" logic (e.g., editOwn/viewOwn)
    own_action = f"{action}Own"
    if own_action in module_perms and record_creator_id and str(user.get("id")) == str(record_creator_id):
        return True

    return False

