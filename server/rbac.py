import json
from typing import Any


def _load_permissions(permissions_json: str | None) -> dict[str, list[str]]:
    if not permissions_json:
        return {}
    try:
        data = json.loads(permissions_json)
        if isinstance(data, dict):
            out: dict[str, list[str]] = {}
            for k, v in data.items():
                if isinstance(k, str) and isinstance(v, list):
                    out[k] = [str(x) for x in v]
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


