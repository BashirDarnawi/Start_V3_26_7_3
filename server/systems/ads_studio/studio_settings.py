"""Albayan Studio switches (plan task P0-04, PLAN.md §7.1 studioSettings, §12.2 switches).

Each setting is one ``studioSettings`` record in the entities table, found by a fixed id
(``derived_id("sts", key)``). A record keeps the current value and a version number; every save
must name the version it read (``expectedVersion``), so two admins can never overwrite each
other without seeing it (409). Every save writes its audit entry (action ``studio_setting``,
the value before and after) in the SAME transaction: both are kept or neither is. A record
that was soft-deleted (an admin restore, a batch delete) reads as never saved (version 0), and
the next save with ``expectedVersion`` 0 brings the same row back.

Keys (anything else is refused):

* ``rollout``: ``ui`` (customer layout ``off|pilot|on`` + ``uiAllowlist`` of user ids),
  ``services`` (``help``, ``stopRequest``, ``tiktok``: each ``off|pilot|on``, shown in BOTH
  layouts; ``pilot`` = only the users in ``uiAllowlist``; a stored or sent true/false from the
  first shape reads as on/off), ``staffDesk`` (``off|pilot|on`` + ``staffAllowlist``; its own
  switch, independent of the customer layout and of the env kill switch).
* ``intake``: ``open`` (new submissions allowed) and ``maxSubmissionsPerDay`` (1-500).
* ``capabilities``: the PLAN.md §7.1 labels ``fbPublicReply``, ``fbPrivateReply``,
  ``igPublicReply``, ``igPrivateReply``, ``tiktokService``, each ``on|gated|off|unavailable``;
  ``poll`` (Instagram road 1) is allowed only for ``igPublicReply``.

Safe defaults (used until an admin saves, and for any stored field that is unreadable):
everything off / classic, intake open with a cap of 5, capabilities as in ``DEFAULTS`` below.

Env kill switch ``ALBAYAN_STUDIO_V2`` (read on every request): ``off`` (also when unset or
misspelt) forces the classic customer layout whatever the record says; ``pilot`` allows the new
layout only for the allowlist; ``on`` follows the record. It never touches services or the
staff desk, so switching the layout back to classic never hides a ticket or the staff queue
(PLAN.md §12.2(b)).
"""

import copy
import os
from typing import Any, Callable

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ...db import db_conn, json_dumps, json_loads, now_ms
from .studio_errors import studio_error
from .studio_types import STUDIO_SETTINGS_TYPE, derived_id, looks_like_user_id

ENV_SWITCH = "ALBAYAN_STUDIO_V2"
MODES = ("off", "pilot", "on")
SETTING_KEYS = ("rollout", "intake", "capabilities")
SERVICE_NAMES = ("help", "stopRequest", "tiktok")
CAPABILITY_STATES = ("on", "gated", "off", "unavailable")
# channel -> the states it may take (poll = "checked every few minutes", Instagram road 1 only)
CAPABILITY_CHANNELS: dict[str, tuple[str, ...]] = {
    "fbPublicReply": CAPABILITY_STATES,
    "fbPrivateReply": CAPABILITY_STATES,
    "igPublicReply": ("on", "poll", "gated", "off", "unavailable"),
    "igPrivateReply": CAPABILITY_STATES,
    "tiktokService": CAPABILITY_STATES,
}
MAX_ALLOWLIST = 200
MIN_SUBMISSIONS_PER_DAY = 1
MAX_SUBMISSIONS_PER_DAY = 500

DEFAULTS: dict[str, dict[str, Any]] = {
    "rollout": {
        "ui": "off",
        "uiAllowlist": [],
        "services": {"help": "off", "stopRequest": "off", "tiktok": "off"},
        "staffDesk": "off",
        "staffAllowlist": [],
    },
    "intake": {"open": True, "maxSubmissionsPerDay": 5},
    # Honest labels until the facts are in (PLAN.md §8.2, DECISIONS D8a, D24b, D34):
    # * fbPublicReply gated ("waiting for Meta"): it works only after fact P0-01(g) proves
    #   delivery to commenters without an app role and the page is subscribed; if (g) fails,
    #   D24b (a) keeps this label.
    # * fbPrivateReply, igPrivateReply unavailable: Business Verification is postponed (D8a),
    #   so nothing is waiting at Meta and private messages are "not available now", not gated.
    # * igPublicReply unavailable: no approval is pending (D8a, D34 (a)); an admin sets poll
    #   only after the road 1 test P0-01(w) passes.
    # * tiktokService off: a manual service run by the team (§8.4), not blocked by any platform,
    #   so neither gated nor unavailable fits; it stays off until the owner opens it (TikTok is
    #   hidden in Preview A, §12.3).
    "capabilities": {
        "fbPublicReply": "gated",
        "fbPrivateReply": "unavailable",
        "igPublicReply": "unavailable",
        "igPrivateReply": "unavailable",
        "tiktokService": "off",
    },
}


def env_switch() -> str:
    """The kill switch value now: off, pilot or on (unset or unknown = off, the safe side)."""
    value = str(os.environ.get(ENV_SWITCH) or "").strip().lower()
    return value if value in MODES else "off"


def setting_id(key: str) -> str:
    return derived_id("sts", key)


def default_value(key: str) -> dict[str, Any]:
    return copy.deepcopy(DEFAULTS[key])


def require_known_key(key: str) -> str:
    if key not in DEFAULTS:
        studio_error(404, "UNKNOWN_SETTING", f"Unknown studio setting '{str(key)[:40]}'. Known: {', '.join(SETTING_KEYS)}")
    return key


# ---------------------------------------------------------------- validation

def _bad(field: str, rule: str) -> None:
    studio_error(400, "INVALID_VALUE", f"{field} {rule}")


def _unknown(field: str, allowed: Any) -> None:
    studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{str(field)[:40]}'. Allowed: {', '.join(allowed)}")


def _mode(field: str, value: Any) -> str:
    if not isinstance(value, str) or value not in MODES:
        _bad(field, "must be one of: off, pilot, on")
    return value


def _flag(field: str, value: Any) -> bool:
    if not isinstance(value, bool):
        _bad(field, "must be true or false")
    return value


def _service_mode(field: str, value: Any) -> str:
    if isinstance(value, bool):  # the first shape stored true/false
        return "on" if value else "off"
    return _mode(field, value)


def _allowlist(field: str, value: Any, id_validator: Callable[[Any], str] | None) -> list[str]:
    if not isinstance(value, list):
        _bad(field, "must be a list of user ids")
    if len(value) > MAX_ALLOWLIST:
        _bad(field, f"may hold at most {MAX_ALLOWLIST} user ids")
    clean: list[str] = []
    for item in value:
        ok = isinstance(item, str) and looks_like_user_id(item)
        if ok and id_validator is not None:
            try:
                id_validator(item)
            except Exception:
                ok = False
        if not ok:
            _bad(field, "must hold user ids only (letters, numbers, dot, underscore, colon or hyphen)")
        if item not in clean:
            clean.append(item)
    return clean


def _apply_rollout(current: dict[str, Any], raw: dict[str, Any], id_validator: Callable[[Any], str] | None) -> None:
    for field, value in raw.items():
        if field in ("ui", "staffDesk"):
            current[field] = _mode(field, value)
        elif field in ("uiAllowlist", "staffAllowlist"):
            current[field] = _allowlist(field, value, id_validator)
        elif field == "services":
            if not isinstance(value, dict):
                _bad("services", "must be an object")
            services = dict(current.get("services") or {})
            for name, flag in value.items():
                if name not in SERVICE_NAMES:
                    _unknown(f"services.{name}", SERVICE_NAMES)
                services[name] = _service_mode(f"services.{name}", flag)
            current["services"] = services
        else:
            _unknown(field, DEFAULTS["rollout"])


def _apply_intake(current: dict[str, Any], raw: dict[str, Any], _id_validator: Any) -> None:
    for field, value in raw.items():
        if field == "open":
            current["open"] = _flag("open", value)
        elif field == "maxSubmissionsPerDay":
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not MIN_SUBMISSIONS_PER_DAY <= value <= MAX_SUBMISSIONS_PER_DAY
            ):
                _bad("maxSubmissionsPerDay", f"must be a whole number from {MIN_SUBMISSIONS_PER_DAY} to {MAX_SUBMISSIONS_PER_DAY}")
            current["maxSubmissionsPerDay"] = value
        else:
            _unknown(field, DEFAULTS["intake"])


def _apply_capabilities(current: dict[str, Any], raw: dict[str, Any], _id_validator: Any) -> None:
    for field, value in raw.items():
        allowed = CAPABILITY_CHANNELS.get(field)
        if allowed is None:
            _unknown(field, CAPABILITY_CHANNELS)
        if not isinstance(value, str) or value not in allowed:
            _bad(field, "must be one of: " + ", ".join(allowed))
        current[field] = value


_APPLY = {"rollout": _apply_rollout, "intake": _apply_intake, "capabilities": _apply_capabilities}


def validate_setting(
    key: str,
    raw: Any,
    current: dict[str, Any] | None = None,
    id_validator: Callable[[Any], str] | None = None,
) -> dict[str, Any]:
    """``current`` changed by the fields in ``raw`` (a partial object is fine). Every field is
    checked; one bad or unknown field refuses the whole change (HTTP 400, nothing is saved)."""
    require_known_key(key)
    if not isinstance(raw, dict):
        studio_error(400, "INVALID_REQUEST", "value must be an object")
    merged = copy.deepcopy(current if isinstance(current, dict) else default_value(key))
    _APPLY[key](merged, raw, id_validator)
    return merged


def normalise_stored(key: str, stored: Any) -> dict[str, Any]:
    """A stored value read back safely: each field that fails today's rules keeps its safe
    default instead of breaking /api/studio/me."""
    value = default_value(key)
    if not isinstance(stored, dict):
        return value
    for field, field_value in stored.items():
        if field == "services" and isinstance(field_value, dict):
            for name, flag in field_value.items():
                try:
                    value = validate_setting(key, {"services": {name: flag}}, value)
                except Exception:
                    continue
            continue
        try:
            value = validate_setting(key, {field: field_value}, value)
        except Exception:
            continue
    return value


# ------------------------------------------------------------------ storage

def _select_row(conn: Any, key: str) -> Any:
    """The key's row whatever its deleted flag: a soft-deleted row must never block a save."""
    return conn.execute(
        text(
            "SELECT id, data_json, deleted, created_at, last_modified FROM entities "
            "WHERE type = :type AND id = :id LIMIT 1"
        ),
        {"type": STUDIO_SETTINGS_TYPE, "id": setting_id(key)},
    ).mappings().first()


def _live_data(row: Any) -> Any:
    """The stored data of a live row; None for no row or a soft-deleted one (= never saved)."""
    return json_loads(row["data_json"]) if row and not bool(row["deleted"]) else None


def _record(key: str, data: Any) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    try:
        version = max(int(data.get("version") or 0), 0)
    except (TypeError, ValueError, OverflowError):
        version = 0
    return {
        "key": key,
        "id": setting_id(key),
        "value": normalise_stored(key, data.get("value")) if version else default_value(key),
        "version": version,
        "updatedAt": str(data.get("updatedAt") or "") or None,
    }


def read_setting(key: str) -> dict[str, Any]:
    """``{key, id, value, version, updatedAt}``; version 0 = never saved (the defaults)."""
    require_known_key(key)
    with db_conn() as conn:
        row = _select_row(conn, key)
    return _record(key, _live_data(row))


def read_all_settings() -> dict[str, dict[str, Any]]:
    """Every key's current value (defaults for keys never saved), in one query."""
    ids = {setting_id(key): key for key in SETTING_KEYS}
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id, data_json FROM entities WHERE type = :type AND deleted = false"),
            {"type": STUDIO_SETTINGS_TYPE},
        ).mappings().all()
    found = {ids[str(r["id"])]: json_loads(r["data_json"]) for r in rows if str(r["id"]) in ids}
    return {key: _record(key, found.get(key))["value"] for key in SETTING_KEYS}


_SAVED_FIRST = "This setting was saved by someone else just now. Reload it, then save again."


def save_setting(
    key: str,
    raw_value: Any,
    expected_version: int,
    actor_id: str,
    iso_now: str,
    *,
    audit: Callable[[Any, dict[str, Any], dict[str, Any]], None],
    id_validator: Callable[[Any], str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate and save; returns (record before, record after). 409 when someone saved first.

    ``audit(conn, before, after)`` writes the audit entry on the same connection before the
    commit, so when it fails the save is rolled back too (a switch never changes unrecorded).
    """
    require_known_key(key)
    with db_conn() as conn:
        row = _select_row(conn, key)
        before = _record(key, _live_data(row))
        if int(expected_version) != before["version"]:
            studio_error(
                409,
                "VERSION_CONFLICT",
                f"This setting changed (now version {before['version']}). Reload it, then save again.",
            )
        value = validate_setting(key, raw_value, before["value"], id_validator)
        stamp = now_ms()
        data = {
            "id": setting_id(key),
            "recordType": STUDIO_SETTINGS_TYPE,
            "settingKey": key,
            "version": before["version"] + 1,
            "value": value,
            "updatedAt": iso_now,
            "updatedBy": str(actor_id or ""),
            "_deleted": False,
        }
        if row:
            # A live row is updated; a soft-deleted one is brought back (deleted = false), both
            # only if nobody touched the row since it was read.
            baseline = int(row["last_modified"])
            modified = max(stamp, baseline + 1)
            data["_created"] = int(row["created_at"])
            data["_lastModified"] = modified
            result = conn.execute(
                text(
                    "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                    "WHERE type = :type AND id = :id AND deleted = :was_deleted AND last_modified = :baseline"
                ),
                {"data": json_dumps(data), "modified": modified, "type": STUDIO_SETTINGS_TYPE,
                 "id": setting_id(key), "was_deleted": bool(row["deleted"]), "baseline": baseline},
            )
            if int(result.rowcount or 0) != 1:
                studio_error(409, "VERSION_CONFLICT", _SAVED_FIRST)
        else:
            data["_created"] = stamp
            data["_lastModified"] = stamp
            try:
                # A system row: created_by stays NULL (the acting admin is in updatedBy and the audit log).
                conn.execute(
                    text(
                        "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                        "VALUES (:type, :id, :data, false, :stamp, NULL, :stamp)"
                    ),
                    {"type": STUDIO_SETTINGS_TYPE, "id": setting_id(key), "data": json_dumps(data), "stamp": stamp},
                )
            except IntegrityError:
                # Two first saves at the same moment: the fixed id lets only one insert win.
                studio_error(409, "VERSION_CONFLICT", _SAVED_FIRST)
        after = _record(key, data)
        audit(conn, before, after)
    return before, after


# ------------------------------------------------------- what a user gets

def _rank(mode: str) -> int:
    return MODES.index(mode) if mode in MODES else 0


def customer_layout(rollout: dict[str, Any], user_id: str, env: str | None = None) -> str:
    """'v2' or 'classic'. The stricter of the env switch and the record wins."""
    mode = MODES[min(_rank(env_switch() if env is None else env), _rank(str(rollout.get("ui") or "off")))]
    if mode == "on":
        return "v2"
    if mode == "pilot" and user_id and user_id in (rollout.get("uiAllowlist") or []):
        return "v2"
    return "classic"


def staff_desk_layout(rollout: dict[str, Any], user_id: str, is_staff: bool) -> str:
    """'v2' or 'classic' for the Team desk; only the staffDesk switch decides (never the env)."""
    if not is_staff:
        return "classic"
    mode = str(rollout.get("staffDesk") or "off")
    if mode == "on":
        return "v2"
    if mode == "pilot" and user_id and user_id in (rollout.get("staffAllowlist") or []):
        return "v2"
    return "classic"


def service_access(rollout: dict[str, Any], user_id: str) -> dict[str, bool]:
    """Each service for this user: on = everyone, pilot = only the customer allowlist
    (``uiAllowlist``), off = nobody. Neither the env kill switch nor the customer layout is
    consulted: switching the layout off never hides a service (PLAN.md §12.2(b))."""
    services = rollout.get("services") or {}
    allowed = bool(user_id) and user_id in (rollout.get("uiAllowlist") or [])
    return {
        name: services.get(name) == "on" or (services.get(name) == "pilot" and allowed)
        for name in SERVICE_NAMES
    }


def me_view(settings: dict[str, dict[str, Any]], user_id: str, is_admin: bool, is_staff: bool) -> dict[str, Any]:
    rollout = settings["rollout"]
    return {
        "ui": customer_layout(rollout, user_id),
        "services": service_access(rollout, user_id),
        "staffDesk": staff_desk_layout(rollout, user_id, is_staff),
        "capabilities": dict(settings["capabilities"]),
        "intake": {"open": bool(settings["intake"].get("open"))},
        "isAdmin": bool(is_admin),
        "isStaff": bool(is_staff),
    }
