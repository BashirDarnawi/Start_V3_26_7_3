"""/api/studio: the Albayan Studio v2 API (plan tasks P0-03, P0-04, P0-05a/b; PLAN.md §7.3).

Routes in this first part:

* ``GET /api/studio/me`` (any signed-in user): which layout and services this user gets.
* ``GET /api/studio/admin/settings/{key}`` and ``PUT`` the same (admin only): the switches in
  studio_settings.py. A PUT checks the origin, the admin role, a rate limit and the version,
  then saves and writes an audit entry with the value before and after.
* ``GET /api/studio/admin/diagnostics`` (admin only): counts and baselines, no personal data.

main.py hands helpers over through ``ctx`` (late-binding lambdas): ``user_has_permission``,
``audit`` and ``validate_entity_id``. Errors are ``{"detail": {"code", "message"}}``
(studio_errors.py).
"""

import math
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from ...rate_limiter import check_rate_limit
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_diagnostics import read_diagnostics
from .studio_errors import studio_error
from .studio_settings import env_switch, me_view, read_all_settings, read_setting, require_known_key, save_setting
from .studio_types import STUDIO_SETTINGS_TYPE

SETTINGS_WRITES_PER_MINUTE = 30
DIAGNOSTICS_READS_PER_MINUTE = 20


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def is_admin(user: dict[str, Any]) -> bool:
    return str(user.get("role") or "").lower() == "admin"


def create_studio_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/studio", tags=["studio"])

    def is_staff(user: dict[str, Any]) -> bool:
        return is_admin(user) or bool(ctx["user_has_permission"](user, AD_CAMPAIGN_COLLECTION, "review"))

    def require_admin(user: dict[str, Any]) -> None:
        if not is_admin(user):
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    def rate_limit(user: dict[str, Any], bucket: str, per_minute: int) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
        if not allowed:
            studio_error(
                429,
                "RATE_LIMITED",
                "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def public_setting(record: dict[str, Any]) -> dict[str, Any]:
        out = {key: record[key] for key in ("key", "value", "version", "updatedAt")}
        if record["key"] == "rollout":
            out["envSwitch"] = env_switch()  # so the admin sees why v2 may still be hidden
        return out

    @router.get("/me")
    def studio_me(user: dict[str, Any] = Depends(current_user_dependency)):
        return me_view(read_all_settings(), str(user.get("id") or ""), is_admin(user), is_staff(user))

    @router.get("/admin/settings/{key}")
    def get_studio_setting(key: str, user: dict[str, Any] = Depends(current_user_dependency)):
        require_admin(user)
        return public_setting(read_setting(key))

    @router.put("/admin/settings/{key}")
    def put_studio_setting(
        key: str,
        request: Request,
        body: Any = Body(None),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        same_origin(request)
        require_admin(user)
        require_known_key(key)
        rate_limit(user, "settings", SETTINGS_WRITES_PER_MINUTE)
        if not isinstance(body, dict):
            studio_error(400, "INVALID_REQUEST", "Send {expectedVersion, value}")
        extra = sorted(set(body) - {"expectedVersion", "value"})
        if extra:
            studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{str(extra[0])[:40]}'. Send {{expectedVersion, value}}")
        expected = body.get("expectedVersion")
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            studio_error(400, "INVALID_REQUEST", "expectedVersion (the version you loaded, 0 for never saved) is required")
        actor_id = str(user.get("id") or "")
        before, after = save_setting(
            key, body.get("value"), expected, actor_id, _iso_now(),
            id_validator=lambda value: ctx["validate_entity_id"](value),
        )
        ctx["audit"](
            actor_id,
            "update",
            STUDIO_SETTINGS_TYPE,
            after["id"],
            f"Saved studio setting '{key}' as version {after['version']}",
            {"key": key, "version": after["version"], "before": before["value"], "after": after["value"]},
        )
        return public_setting(after)

    @router.get("/admin/diagnostics")
    def get_studio_diagnostics(user: dict[str, Any] = Depends(current_user_dependency)):
        require_admin(user)
        rate_limit(user, "diagnostics", DIAGNOSTICS_READS_PER_MINUTE)
        report = read_diagnostics()
        report["switches"] = {"envStudioV2": env_switch()}
        report["generatedAt"] = _iso_now()
        return report

    return router
