"""Connect with Facebook: the sign-in routes under /api/meta-ads/connection.

Mounted INSIDE meta_ads.create_meta_ads_router (so server/main.py gets no new lines). The flow:

  1. POST /start (admin, same origin, rate limited) stores a one-time state (only its SHA-256, bound
     to the admin and the session, 10 minutes) and answers the Facebook Login for Business URL.
  2. Facebook sends the admin's browser back to GET /callback. The state is checked and consumed,
     the code is exchanged for a short-lived USER token, debug_token checks it, the server lists the
     admin's businesses and their system users. One candidate -> finish now; several -> an encrypted
     "metaConnectChoice" for POST /finish; none -> "no_system_user". Always 303 to GET /done, whose
     Location never carries the code, the state or a token.
  3. Finishing makes sure the app is installed for the system user, generates a NEW system-user
     token (never expires) with scope = WANTED and the user token's scopes, checks it with
     debug_token (valid, this app, type SYSTEM_USER), reads the ad accounts it can see, and stores
     only that token, encrypted (meta_connection). The user token is thrown away.

Albayan never creates a system user and never assigns an asset: the owner does that in Meta
Business Settings. Generating a new system-user token does not revoke the hosting key.

Meta failures become fixed English texts plus Meta's numeric code only (never Meta's message text,
never a URL). No response, result page, audit row or log line carries a token, the code or the app
secret.
"""

from __future__ import annotations

import dataclasses
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import meta_ads
from . import meta_connection as mc
from .rate_limiter import check_rate_limit

DONE_PATH = "/api/meta-ads/connection/done"
CALLBACK_PATH = mc.CALLBACK_PATH
DEFAULT_BASE_URL = "https://albayanhub.com"
PENDING_TTL_MS = 10 * 60 * 1000
CHOICE_TTL_MS = 15 * 60 * 1000
ACCOUNT_CAP = 500
PAGE_SIZE = 100
BUSINESS_CAP = 25
SYSTEM_USER_CAP = 50
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_LOGIN_CONFIG_RE = re.compile(r"^[0-9]{5,25}$")
_META_ID_RE = re.compile(r"^[0-9]{1,40}$")

RESULT_CODES = (
    "connected", "choose_system_user", "cancelled", "no_system_user", "state_invalid", "state_expired",
    "not_admin", "exchange_failed", "meta_error", "missing_permissions", "not_system_user",
    "app_mismatch", "token_invalid", "disconnected", "app_not_ready", "config_missing", "base_url_invalid",
)


def wanted_scopes() -> tuple[str, ...]:
    from . import meta_token_health

    extra = ("pages_manage_posts", "instagram_content_publish")
    return tuple(meta_token_health.EXPECTED_SCOPES) + tuple(s for s in extra if s not in meta_token_health.EXPECTED_SCOPES)


class ConnectError(Exception):
    """A refusal with a stable code and a fixed English text (never Meta's own words)."""

    def __init__(self, code: str, message: str, *, status: int = 400, meta_code: str = "", missing: tuple[str, ...] = ()):
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status
        self.meta_code = meta_code
        self.missing = tuple(missing)


def _refusal(error: ConnectError) -> JSONResponse:
    body: dict[str, Any] = {"detail": error.message, "code": error.code}
    if error.meta_code:
        body["metaCode"] = error.meta_code
    if error.missing:
        body["missingScopes"] = list(error.missing)
    return JSONResponse(body, status_code=error.status, headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------- settings and URLs


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_from_ms(value: Any) -> str:
    try:
        seconds = int(value) / 1000
    except (TypeError, ValueError):
        return ""
    from datetime import datetime, timezone

    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def login_config() -> tuple[str, str]:
    """(config id, source): the environment variable wins over the saved setting."""
    env_value = (os.getenv(mc.LOGIN_CONFIG_ENV) or "").strip()
    if env_value:
        return (env_value, "env") if _LOGIN_CONFIG_RE.fullmatch(env_value) else ("", "env")
    saved = str(mc.load_record(mc.SETTINGS_ID).get("loginConfigId") or "").strip()
    return (saved, "saved") if _LOGIN_CONFIG_RE.fullmatch(saved) else ("", "")


def _debug_mode() -> bool:
    return (os.getenv("ALBAYAN_DEBUG_MODE") or "").strip().lower() in {"1", "true", "yes"}


def redirect_uri() -> str:
    """ALBAYAN_PUBLIC_BASE_URL + the callback path, or '' when the base URL is not usable. Built only
    from the setting, never from the Host header. http is allowed only on localhost or in debug mode."""
    raw = (os.getenv("ALBAYAN_PUBLIC_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").lower()
    except ValueError:
        return ""
    if not host or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        return ""
    if parts.scheme == "https" or (parts.scheme == "http" and (_debug_mode() or host in {"localhost", "127.0.0.1"})):
        return f"{parts.scheme}://{parts.netloc}{CALLBACK_PATH}"
    return ""


def _graph_settings() -> tuple[str, float, str]:
    """(graph version, timeout seconds, app secret), environment only."""
    config = meta_ads.load_meta_ads_config()
    return config.graph_version, float(config.request_timeout_seconds), str(config.app_secret or "")


def _proof(token: str, app_secret: str) -> str:
    return hmac.new(app_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- Graph calls


def _meta_code(payload: Any, status: int) -> str:
    error = payload.get("error") if isinstance(payload, dict) and isinstance(payload.get("error"), dict) else {}
    return re.sub(r"\D", "", str(error.get("code") or status))[:10]


def _graph(
    method: str,
    path: str,
    *,
    token: str = "",
    params: dict[str, Any] | None = None,
    form: dict[str, Any] | None = None,
    fail_code: str = "meta_error",
    fail_text: str = "Meta refused the request",
) -> dict[str, Any]:
    """One Graph call. A token goes in the Authorization header (GET) or the form body (POST), always
    with appsecret_proof. Failures raise ConnectError with a fixed text plus Meta's numeric code."""
    version, timeout, app_secret = _graph_settings()
    url = f"https://graph.facebook.com/{version}/{path.lstrip('/')}"
    query = dict(params or {})
    body = dict(form) if form is not None else None
    headers = {"Accept": "application/json", "User-Agent": "Albayan-Meta-Connect/1.0"}
    if token:
        if body is not None:
            body["access_token"] = token
            body["appsecret_proof"] = _proof(token, app_secret)
        else:
            headers["Authorization"] = f"Bearer {token}"
            query["appsecret_proof"] = _proof(token, app_secret)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False, headers=headers) as client:
            with client.stream(method, url, params=query or None, data=body) as response:
                status = int(response.status_code or 0)
                raw = meta_ads._read_capped_response_body(response, MAX_RESPONSE_BYTES)
    except Exception:
        # Fixed text only: an httpx error carries the request and its URL.
        raise ConnectError(fail_code, "Meta could not be reached. Try again later.", status=502) from None
    if raw is None:
        raise ConnectError(fail_code, "Meta returned too much data.", status=502)
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
    if not isinstance(payload, dict) or "error" in payload or not 200 <= status < 300:
        code = _meta_code(payload, status)
        raise ConnectError(fail_code, f"{fail_text} (code {code}).", status=502, meta_code=code)
    return payload


def _paged(path: str, token: str, fields: str, cap: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    after = ""
    while len(rows) < cap:
        params = {"fields": fields, "limit": PAGE_SIZE}
        if after:
            params["after"] = after
        payload = _graph("GET", path, token=token, params=params, fail_text="Meta refused the list request")
        data = payload.get("data") if isinstance(payload.get("data"), list) else []
        rows.extend(item for item in data if isinstance(item, dict))
        paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
        cursors = paging.get("cursors") if isinstance(paging.get("cursors"), dict) else {}
        after = str(cursors.get("after") or "")
        if not data or not after or not paging.get("next"):
            break
    return rows[:cap]


def exchange_code(code: str) -> str:
    """Step 2: the code -> a short-lived user token (redirect_uri byte-identical to the dialog)."""
    payload = _graph(
        "GET",
        "oauth/access_token",
        params={
            "client_id": mc.app_id(),
            "client_secret": _graph_settings()[2],
            "redirect_uri": redirect_uri(),
            "code": code,
        },
        fail_code="exchange_failed",
        fail_text="Facebook did not accept the sign-in code",
    )
    token = str(payload.get("access_token") or "").strip()
    if not token:
        raise ConnectError("exchange_failed", "Facebook returned no key for the sign-in.", status=502)
    return token


def inspect_token(token: str) -> dict[str, Any]:
    """debug_token through meta_token_health (app token in the Authorization header): a sanitised
    reading {isValid, appMatches, type, scopes, expiresAt, expiresNever, pagesCoveredByScope}."""
    from . import meta_token_health

    try:
        config = dataclasses.replace(meta_ads.load_meta_ads_config(), access_token=token)
        app = mc.app_id()
        payload = meta_token_health._graph_debug_token(config, app)
        return meta_token_health._parse_debug_token(payload, app)
    except meta_ads.MetaAdsError as error:
        code = re.sub(r"\D", "", str(getattr(error, "provider_code", "") or ""))[:10]
        suffix = f" (code {code})" if code else ""
        raise ConnectError("meta_error", f"Meta could not check the key{suffix}.", status=502, meta_code=code) from None


def _scope_plan(user_scopes: list[str]) -> tuple[list[str], list[str]]:
    """(scope to ask for, wanted names the user token lacks)."""
    granted = set(user_scopes)
    wanted = wanted_scopes()
    return [s for s in wanted if s in granted], [s for s in wanted if s not in granted]


# Without business_management Meta refuses the business, system-user and key calls; say so up front.
REQUIRED_SCOPES = ("ads_read", "business_management")


def _require_scopes(scope: list[str], missing: list[str]) -> None:
    if any(name not in scope for name in REQUIRED_SCOPES):
        raise ConnectError("missing_permissions", "Facebook did not grant the permissions Albayan needs.", missing=tuple(missing))


def system_user_candidates(user_token: str) -> list[dict[str, str]]:
    businesses = _paged("me/businesses", user_token, "id,name", BUSINESS_CAP)
    candidates: list[dict[str, str]] = []
    for business in businesses:
        business_id = str(business.get("id") or "")
        if not _META_ID_RE.fullmatch(business_id):
            continue
        users = _paged(f"{business_id}/system_users", user_token, "id,name,role", SYSTEM_USER_CAP)
        for user in users:
            user_id = str(user.get("id") or "")
            if not _META_ID_RE.fullmatch(user_id):
                continue
            candidates.append({
                "businessId": business_id,
                "businessName": meta_ads._clean_text(business.get("name"), 120),
                "systemUserId": user_id,
                "systemUserName": meta_ads._clean_text(user.get("name"), 120),
                "role": meta_ads._clean_text(user.get("role"), 40),
            })
    return candidates


def read_assets(token: str) -> tuple[list[dict[str, str]], int | None]:
    """(ad accounts the token can read, unfiltered by any allowlist; Pages count or None)."""
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in _paged("me/adaccounts", token, "account_id,name", ACCOUNT_CAP):
        account = str(row.get("account_id") or row.get("id") or "").strip()
        if account.startswith("act_"):
            account = account[4:]
        if _META_ID_RE.fullmatch(account) and account not in seen:
            seen.add(account)
            accounts.append({"id": account, "name": meta_ads._clean_text(row.get("name"), 160)})
    try:
        pages: int | None = len(_paged("me/accounts", token, "id", ACCOUNT_CAP))
    except ConnectError:
        pages = None
    return accounts, pages


def revoke(token: str) -> bool:
    """Best effort: ask Meta to revoke the stored key. Failures are ignored."""
    try:
        _graph(
            "GET",
            "oauth/revoke",
            params={
                "client_id": mc.app_id(),
                "client_secret": _graph_settings()[2],
                "revoke_token": token,
                "access_token": token,
            },
        )
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- flow


def _session_hash(user: dict[str, Any]) -> str:
    session = str(user.get("session_id") or "")
    return mc.sha256_hex(session) if session else ""


def _is_admin(user: dict[str, Any] | None) -> bool:
    return bool(user) and str(user.get("role") or "").strip().lower() == "admin"


def _audit(admin: dict[str, Any], action: str, message: str, metadata: dict[str, Any]) -> None:
    try:
        meta_ads._audit(
            str(admin.get("id") or "") or None, action, mc.CONNECTION_ID, message, metadata,
            resource_type=mc.RECORD_TYPE,
        )
    except Exception:
        mc._quiet("an audit row could not be written")


def _save_result(code: str, admin: dict[str, Any] | None, *, missing: tuple[str, ...] = (), meta_code: str = "") -> None:
    data: dict[str, Any] = {
        "ok": code in ("connected", "choose_system_user", "disconnected"),
        "code": code,
        "at": mc.iso_now(),
        "adminId": str((admin or {}).get("id") or ""),
    }
    if missing:
        data["missingScopes"] = list(missing)
    if meta_code:
        data["metaCode"] = meta_code
    mc.save_record(mc.RESULT_ID, data)


def _initial_selection(available: list[dict[str, str]]) -> list[str]:
    """Keep the previous connection's ticks when possible, else the hosting allowlist, else none."""
    ids = {row["id"] for row in available}
    previous = mc.load_record(mc.CONNECTION_ID).get("selectedAccountIds")
    if isinstance(previous, list) and previous:
        return [str(v) for v in previous if str(v) in ids]
    picked: list[str] = []
    for value in (os.getenv("ALBAYAN_META_AD_ACCOUNT_IDS") or "").split(","):
        value = value.strip()
        if value.startswith("act_"):
            value = value[4:]
        if value in ids and value not in picked:
            picked.append(value)
    return picked


def finish_connection(user_token: str, candidate: dict[str, str], user_scopes: list[str], admin: dict[str, Any]) -> dict[str, Any]:
    """Install the app for the system user, generate its NEW token, check it, store it encrypted."""
    scope, missing = _scope_plan(user_scopes)
    _require_scopes(scope, missing)
    system_user = candidate["systemUserId"]
    app = mc.app_id()
    try:
        _graph("POST", f"{system_user}/applications", token=user_token, form={"business_app": app})
    except ConnectError:
        pass  # usually "already installed"; the token step below says whether it really works
    payload = _graph(
        "POST",
        f"{system_user}/access_tokens",
        token=user_token,
        form={"business_app": app, "scope": ",".join(scope)},
        fail_text="Meta did not create the system-user key",
    )
    new_token = str(payload.get("access_token") or "").strip()
    if not new_token:
        raise ConnectError("meta_error", "Meta returned no system-user key.", status=502)
    previous_token = ""
    try:
        reading = inspect_token(new_token)
        if not reading.get("isValid"):
            raise ConnectError("token_invalid", "Meta says the new key is not valid.")
        if not reading.get("appMatches"):
            raise ConnectError("app_mismatch", "The new key belongs to a different Meta app.")
        if reading.get("type") != "SYSTEM_USER":
            raise ConnectError("not_system_user", "Meta returned a key that is not a system-user key.")
        available, pages = read_assets(new_token)
        sealed = mc.encrypt_secret(new_token, mc.CONNECTION_ID)
        if sealed is None:
            raise ConnectError("app_not_ready", "The key could not be stored safely.", status=409)
        token_scopes = list(reading.get("scopes") or [])
        record = {
            **sealed,
            "appId": app,
            "businessId": candidate["businessId"],
            "businessName": candidate.get("businessName", ""),
            "systemUserId": system_user,
            "systemUserName": candidate.get("systemUserName", ""),
            "connectedAt": mc.iso_now(),
            "connectedBy": str(admin.get("id") or ""),
            "connectedByName": meta_ads._clean_text(admin.get("name"), 120),
            "scopes": token_scopes,
            "missingScopes": [s for s in wanted_scopes() if s not in token_scopes],
            "expiresNever": bool(reading.get("expiresNever")),
            "expiresAt": str(reading.get("expiresAt") or ""),
            "pagesCoveredByScope": reading.get("pagesCoveredByScope") or {},
            "availableAccounts": available,
            "selectedAccountIds": _initial_selection(available),
            "pagesCount": pages,
        }
        # The key this one replaces (Reconnect), read uncached right before the save; revoked once saved.
        previous_token = mc.decrypt_secret(mc.load_record(mc.CONNECTION_ID), mc.CONNECTION_ID) or ""
        if mc.save_record(mc.CONNECTION_ID, record) is None:
            raise ConnectError("meta_error", "The key could not be saved. Try again.", status=503)
    except BaseException:
        revoke(new_token)  # a never-expiring key Albayan will not keep must not stay valid at Meta
        raise
    previous_revoked = None
    if previous_token and previous_token != new_token:
        previous_revoked = revoke(previous_token)
    mc.delete_record(mc.CHOICE_ID)
    meta_ads.meta_connection_changed()
    try:
        from . import meta_token_health

        meta_token_health.check_token_now(max_age_seconds=0)
    except Exception:
        pass  # the token card re-checks on its own; Connect has already succeeded
    _audit(admin, "meta_connection.connect", "Connected Facebook (system-user key stored encrypted)", {
        "businessId": candidate["businessId"],
        "systemUserId": system_user,
        "scopes": token_scopes,
        "availableAccounts": len(available),
        "selectedAccounts": len(record["selectedAccountIds"]),
        "previousKeyRevoked": previous_revoked,
    })
    return record


def _check_pending(state: str, admin: dict[str, Any]) -> None:
    """Consume the one-time state, or raise state_invalid / state_expired."""
    if not state or len(state) > 200:
        raise ConnectError("state_invalid", "The sign-in link is not valid.")
    verdict = {"reason": "state_invalid"}
    state_hash = mc.sha256_hex(state)
    session_hash = _session_hash(admin)

    def accept(row: dict[str, Any]) -> bool:
        if not hmac.compare_digest(str(row.get("stateHash") or ""), state_hash):
            return False
        if not hmac.compare_digest(str(row.get("adminId") or ""), str(admin.get("id") or "")):
            return False
        if not session_hash or not hmac.compare_digest(str(row.get("sessionHash") or ""), session_hash):
            return False
        if int(row.get("expiresAt") or 0) <= _now_ms():
            verdict["reason"] = "state_expired"
            return True  # consumed, so an expired state can never be used later
        verdict["reason"] = ""
        return True

    if mc.consume_record(mc.PENDING_ID, accept) is None or verdict["reason"]:
        reason = verdict["reason"] or "state_invalid"
        text_value = "The sign-in took too long." if reason == "state_expired" else "The sign-in link is not valid."
        raise ConnectError(reason, text_value)


def run_callback(admin: dict[str, Any], params: dict[str, str]) -> str:
    """The callback's work for a signed-in admin. Returns the result code (already saved)."""
    try:
        _check_pending(params.get("state", ""), admin)
        mc.delete_record(mc.CHOICE_ID)  # a new sign-in replaces any earlier, unfinished choice (and its user key)
        if params.get("error") or params.get("error_reason"):
            raise ConnectError("cancelled", "The Facebook sign-in was cancelled.")
        if not mc.app_ready():
            raise ConnectError("app_not_ready", "Connect is not set up on the server.")
        code = params.get("code", "")
        if not code or len(code) > 2048:
            raise ConnectError("exchange_failed", "Facebook sent no sign-in code.")
        user_token = exchange_code(code)
        reading = inspect_token(user_token)
        if not reading.get("isValid"):
            raise ConnectError("token_invalid", "Meta says the sign-in key is not valid.")
        if not reading.get("appMatches"):
            raise ConnectError("app_mismatch", "The sign-in key belongs to a different Meta app.")
        user_scopes = list(reading.get("scopes") or [])
        scope, missing = _scope_plan(user_scopes)
        _require_scopes(scope, missing)
        candidates = system_user_candidates(user_token)
        if not candidates:
            raise ConnectError("no_system_user", "No system user was found in the Meta business.")
        if len(candidates) == 1:
            finish_connection(user_token, candidates[0], user_scopes, admin)
            _save_result("connected", admin)
            return "connected"
        sealed = mc.encrypt_secret(user_token, mc.CHOICE_ID)
        if sealed is None:
            raise ConnectError("app_not_ready", "The sign-in could not be kept safely.")
        saved = mc.save_record(mc.CHOICE_ID, {
            **sealed,
            "candidates": candidates[:SYSTEM_USER_CAP],
            "userScopes": user_scopes,
            "adminId": str(admin.get("id") or ""),
            "sessionHash": _session_hash(admin),
            "expiresAt": _now_ms() + CHOICE_TTL_MS,
            "createdAt": mc.iso_now(),
        })
        if saved is None:
            raise ConnectError("meta_error", "The choice could not be saved. Try again.")
        _save_result("choose_system_user", admin)
        return "choose_system_user"
    except ConnectError as error:
        _save_result(error.code, admin, missing=error.missing, meta_code=error.meta_code)
        return error.code
    except Exception:
        mc._quiet("the Connect callback failed")
        _save_result("meta_error", admin)
        return "meta_error"


# --------------------------------------------------------------------------- result page

_TITLE = ("Connect with Facebook", "الربط مع فيسبوك")
_TEXTS: dict[str, tuple[str, str]] = {
    "connected": ("Facebook is connected. Albayan now uses the new key.",
                  "تم ربط فيسبوك. يستخدم البيان المفتاح الجديد الآن."),
    "choose_system_user": ("Almost done: go back to Albayan and choose which robot account (system user) to use.",
                           "اقتربنا: ارجع إلى البيان واختر حساب الروبوت (مستخدم النظام) الذي تريد استخدامه."),
    "cancelled": ("The Facebook sign-in was cancelled. Nothing changed.",
                  "تم إلغاء تسجيل الدخول إلى فيسبوك. لم يتغير شيء."),
    "no_system_user": ("No system user was found in your Meta business. Create one in Meta Business Settings, give it the ad accounts and Pages, then press Connect again.",
                       "لم يُعثر على مستخدم نظام في نشاطك التجاري على ميتا. أنشئ واحدًا في إعدادات الأعمال على ميتا وامنحه الحسابات الإعلانية والصفحات، ثم اضغط ربط مرة أخرى."),
    "state_invalid": ("This sign-in link is not valid any more. Press Connect with Facebook again.",
                      "رابط تسجيل الدخول هذا لم يعد صالحًا. اضغط الربط مع فيسبوك مرة أخرى."),
    "state_expired": ("The sign-in took too long and expired. Press Connect with Facebook again.",
                      "استغرق تسجيل الدخول وقتًا طويلًا وانتهت صلاحيته. اضغط الربط مع فيسبوك مرة أخرى."),
    "not_admin": ("Only an Albayan admin can connect Facebook.",
                  "يمكن لمدير البيان فقط ربط فيسبوك."),
    "exchange_failed": ("Facebook did not accept the sign-in. Press Connect with Facebook again.",
                        "لم يقبل فيسبوك تسجيل الدخول. اضغط الربط مع فيسبوك مرة أخرى."),
    "meta_error": ("Meta did not answer as expected. Try again in a few minutes.",
                   "لم تستجب ميتا كما هو متوقع. حاول مرة أخرى بعد بضع دقائق."),
    "missing_permissions": ("Some required permissions were not granted. Press Connect again and allow every permission.",
                            "لم تُمنح بعض الأذونات المطلوبة. اضغط الربط مرة أخرى واسمح بكل الأذونات."),
    "not_system_user": ("Meta returned a key that is not a system-user key. Nothing was saved.",
                        "أعادت ميتا مفتاحًا ليس مفتاح مستخدم نظام. لم يُحفظ شيء."),
    "app_mismatch": ("The key belongs to a different Meta app. Check ALBAYAN_META_APP_ID. Nothing was saved.",
                     "المفتاح يخص تطبيق ميتا آخر. تحقق من ALBAYAN_META_APP_ID. لم يُحفظ شيء."),
    "token_invalid": ("Meta says the key is not valid. Press Connect with Facebook again.",
                      "تقول ميتا إن المفتاح غير صالح. اضغط الربط مع فيسبوك مرة أخرى."),
    "disconnected": ("Facebook was disconnected. Albayan uses the hosting key again, if one is set.",
                     "تم فصل فيسبوك. يعود البيان إلى استخدام مفتاح الاستضافة إن وُجد."),
    "app_not_ready": ("Connect is not set up on the server yet (Meta app id, app secret and encryption key).",
                      "الربط غير مُعد على الخادم بعد (معرّف تطبيق ميتا والسر ومفتاح التشفير)."),
    "config_missing": ("The Facebook Login configuration id is missing. Add it in Meta Sync first.",
                       "معرّف إعداد تسجيل الدخول إلى فيسبوك غير موجود. أضفه في مزامنة ميتا أولًا."),
    "base_url_invalid": ("The public address of Albayan (ALBAYAN_PUBLIC_BASE_URL) must start with https://.",
                         "يجب أن يبدأ العنوان العام للبيان (ALBAYAN_PUBLIC_BASE_URL) بـ https://."),
    "signed_out": ("Please sign in to Albayan as an admin, then press Connect with Facebook again.",
                   "سجّل الدخول إلى البيان كمدير، ثم اضغط الربط مع فيسبوك مرة أخرى."),
    "none": ("There is no recent Connect result. Open Meta Sync in Albayan.",
             "لا توجد نتيجة ربط حديثة. افتح مزامنة ميتا في البيان."),
}


def result_page(code: str) -> HTMLResponse:
    english, arabic = _TEXTS.get(code) or _TEXTS["meta_error"]
    esc = html.escape
    body = (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<meta name=\"robots\" content=\"noindex\">"
        f"<title>{esc(_TITLE[0])} | {esc(_TITLE[1])}</title>"
        "<style>body{font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;max-width:36rem;"
        "margin:3rem auto;padding:0 1rem;line-height:1.6;color:#1f2937;background:#f9fafb}"
        "section{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.25rem;margin-bottom:1rem}"
        "a{color:#1d4ed8;font-weight:600}</style></head><body>"
        f"<section><h1>{esc(_TITLE[0])}</h1><p data-code=\"{esc(code)}\">{esc(english)}</p>"
        "<p><a href=\"/ads\">Back to Albayan</a></p></section>"
        f"<section dir=\"rtl\" lang=\"ar\"><h1>{esc(_TITLE[1])}</h1><p>{esc(arabic)}</p>"
        "<p><a href=\"/ads\">العودة إلى البيان</a></p></section>"
        "</body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"})


# --------------------------------------------------------------------------- status


def _public_accounts(record: dict[str, Any]) -> dict[str, Any]:
    available = []
    for row in record.get("availableAccounts") if isinstance(record.get("availableAccounts"), list) else []:
        if isinstance(row, dict) and _META_ID_RE.fullmatch(str(row.get("id") or "")):
            available.append({"id": str(row["id"]), "name": meta_ads._clean_text(row.get("name"), 160)})
    selected = [str(v) for v in (record.get("selectedAccountIds") or []) if _META_ID_RE.fullmatch(str(v))]
    return {"available": available, "selected": selected}


def connection_status(admin: dict[str, Any]) -> dict[str, Any]:
    config_id, config_source = login_config()
    view = mc.active_connection()
    record = mc.load_record(mc.CONNECTION_ID) if view is not None else {}
    connected = None
    if view is not None:
        connected = {
            "connectedAt": str(record.get("connectedAt") or ""),
            "connectedByName": str(record.get("connectedByName") or ""),
            "businessName": str(record.get("businessName") or ""),
            "systemUserName": str(record.get("systemUserName") or ""),
            "expiresNever": bool(record.get("expiresNever")),
            "expiresAt": str(record.get("expiresAt") or ""),
            "scopes": [str(s) for s in record.get("scopes") or []],
            "missingScopes": [str(s) for s in record.get("missingScopes") or []],
            "pagesCount": record.get("pagesCount") if isinstance(record.get("pagesCount"), int) else None,
        }
    choice = None
    choice_row = mc.load_record(mc.CHOICE_ID)
    if choice_row and int(choice_row.get("expiresAt") or 0) <= _now_ms():
        mc.delete_record(mc.CHOICE_ID)  # an expired choice never keeps its encrypted user key around
        choice_row = {}
    if (
        choice_row
        and int(choice_row.get("expiresAt") or 0) > _now_ms()
        and str(choice_row.get("adminId") or "") == str(admin.get("id") or "")
        and hmac.compare_digest(str(choice_row.get("sessionHash") or ""), _session_hash(admin))
    ):
        choice = {
            "candidates": [
                {k: str(c.get(k) or "") for k in ("businessId", "businessName", "systemUserId", "systemUserName", "role")}
                for c in choice_row.get("candidates") or [] if isinstance(c, dict)
            ],
            "expiresAt": _iso_from_ms(choice_row.get("expiresAt")),
        }
    result_row = mc.load_record(mc.RESULT_ID)
    last = None
    if result_row.get("code") in RESULT_CODES:
        last = {"ok": bool(result_row.get("ok")), "code": result_row["code"], "at": str(result_row.get("at") or "")}
        if isinstance(result_row.get("missingScopes"), list):
            last["missingScopes"] = [str(s) for s in result_row["missingScopes"]]
        if result_row.get("metaCode"):
            last["metaCode"] = re.sub(r"\D", "", str(result_row["metaCode"]))[:10]
    return {
        "appReady": mc.app_ready(),
        "loginConfigId": config_id,
        "loginConfigSource": config_source if config_id else "",
        "redirectUri": redirect_uri(),
        "tokenSource": meta_ads.meta_token_source(),
        "reconnectNeeded": mc.reconnect_needed(),
        "connected": connected,
        "choice": choice,
        "accounts": _public_accounts(record) if view is not None else {"available": [], "selected": []},
        "lastResult": last,
    }


# --------------------------------------------------------------------------- router

UNREADABLE_DISCONNECT_TEXT = (
    "The stored key could not be read, so Meta was not asked to cancel it. In Meta Business Settings, "
    "open System users, choose the system user and remove its keys."
)


class ConnectionSettingsRequest(BaseModel):
    loginConfigId: str = Field("", max_length=40)


class ConnectionFinishRequest(BaseModel):
    systemUserId: str = Field(..., max_length=40)


class ConnectionAccountsRequest(BaseModel):
    accountIds: list[str] = Field(default_factory=list, max_length=ACCOUNT_CAP)


def _client_key(request: Request) -> str:
    try:
        return str(request.client.host if request.client else "") or "unknown"
    except Exception:
        return "unknown"


def create_connection_router(
    *,
    require_meta_admin: Callable[..., dict[str, Any]],
    current_user_dependency: Callable[..., dict[str, Any]],
    require_same_origin: Callable[[Request], None],
) -> APIRouter:
    router = APIRouter(prefix="/connection")

    def optional_user(request: Request) -> dict[str, Any] | None:
        try:
            return current_user_dependency(request)
        except HTTPException:
            return None
        except Exception:
            return None

    def limit(name: str, admin: dict[str, Any], attempts: int, window_ms: int) -> None:
        meta_ads._rate_limit_or_429(f"meta-connection-{name}:{admin.get('id')}", attempts, window_ms)

    @router.get("")
    def connection_get(admin: dict[str, Any] = Depends(require_meta_admin)):
        return JSONResponse(connection_status(admin), headers={"Cache-Control": "no-store"})

    @router.post("/settings")
    def connection_settings(
        payload: ConnectionSettingsRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        limit("settings", admin, 20, 10 * 60_000)
        if (os.getenv(mc.LOGIN_CONFIG_ENV) or "").strip():
            return _refusal(ConnectError("config_missing", "The login configuration id is set in the hosting settings.", status=409))
        value = payload.loginConfigId.strip()
        if value and not _LOGIN_CONFIG_RE.fullmatch(value):
            return _refusal(ConnectError("config_missing", "The login configuration id must be 5 to 25 digits."))
        saved = mc.save_record(mc.SETTINGS_ID, {"loginConfigId": value, "updatedBy": str(admin.get("id") or "")})
        if saved is None:
            return _refusal(ConnectError("meta_error", "The setting could not be saved. Try again.", status=503))
        _audit(admin, "meta_connection.settings", "Saved the Facebook Login configuration id", {"loginConfigId": value})
        return connection_status(admin)

    @router.post("/start")
    def connection_start(request: Request, admin: dict[str, Any] = Depends(require_meta_admin)):
        require_same_origin(request)
        limit("start", admin, 10, 10 * 60_000)
        try:
            if not mc.app_ready():
                raise ConnectError("app_not_ready", "Connect needs ALBAYAN_META_APP_ID, ALBAYAN_META_APP_SECRET and an encryption key.", status=409)
            config_id, _source = login_config()
            if not config_id:
                raise ConnectError("config_missing", "Add the Facebook Login configuration id first.", status=409)
            callback = redirect_uri()
            if not callback:
                raise ConnectError("base_url_invalid", "ALBAYAN_PUBLIC_BASE_URL must be an https address.", status=409)
            session_hash = _session_hash(admin)
            if not session_hash:
                raise ConnectError("not_admin", "Sign in again, then press Connect.", status=403)
            state = secrets.token_urlsafe(32)
            saved = mc.save_record(mc.PENDING_ID, {
                "stateHash": mc.sha256_hex(state),
                "adminId": str(admin.get("id") or ""),
                "sessionHash": session_hash,
                "expiresAt": _now_ms() + PENDING_TTL_MS,
                "createdAt": mc.iso_now(),
            })
            if saved is None:
                raise ConnectError("meta_error", "Connect could not start. Try again.", status=503)
            mc.delete_record(mc.CHOICE_ID)  # an earlier, unfinished choice (and its user key) is dropped
        except ConnectError as error:
            return _refusal(error)
        version = _graph_settings()[0]
        query = urlencode([
            ("client_id", mc.app_id()),
            ("redirect_uri", callback),
            ("state", state),
            ("config_id", config_id),
            ("response_type", "code"),
            ("override_default_response_type", "true"),
        ])
        url = f"https://www.facebook.com/{version}/dialog/oauth?{query}"
        return JSONResponse({"authorizeUrl": url}, headers={"Cache-Control": "no-store"})

    @router.get("/callback")
    def connection_callback(request: Request):
        done = RedirectResponse(DONE_PATH, status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
        user = optional_user(request)
        if not _is_admin(user):
            return done  # nothing is consumed or written; the result page explains what to do
        allowed, _left, _retry = check_rate_limit(f"meta-connection-callback:{user.get('id')}", 20, 10 * 60_000)
        if not allowed:
            return done
        params = {key: str(request.query_params.get(key) or "") for key in ("state", "code", "error", "error_reason")}
        run_callback(user, params)
        return done

    @router.get("/done")
    def connection_done(request: Request):
        user = optional_user(request)
        if not user:
            return result_page("signed_out")
        if not _is_admin(user):
            return result_page("not_admin")
        row = mc.load_record(mc.RESULT_ID)
        code = str(row.get("code") or "")
        return result_page(code if code in RESULT_CODES else "none")

    @router.post("/finish")
    def connection_finish(
        payload: ConnectionFinishRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        limit("finish", admin, 10, 10 * 60_000)
        try:
            choice = mc.load_record(mc.CHOICE_ID)
            if not choice:
                raise ConnectError("state_expired", "The choice has expired. Press Connect with Facebook again.", status=409)
            if int(choice.get("expiresAt") or 0) <= _now_ms():
                mc.delete_record(mc.CHOICE_ID)
                raise ConnectError("state_expired", "The choice has expired. Press Connect with Facebook again.", status=409)
            if str(choice.get("adminId") or "") != str(admin.get("id") or "") or not hmac.compare_digest(
                str(choice.get("sessionHash") or ""), _session_hash(admin)
            ):
                raise ConnectError("state_invalid", "This choice belongs to another sign-in.", status=409)
            wanted = payload.systemUserId.strip()
            candidate = next(
                (c for c in choice.get("candidates") or [] if isinstance(c, dict) and str(c.get("systemUserId") or "") == wanted),
                None,
            )
            if candidate is None or not _META_ID_RE.fullmatch(wanted):
                raise ConnectError("choose_system_user", "Choose one of the listed system users.")
            user_token = mc.decrypt_secret(choice, mc.CHOICE_ID)
            if not user_token:
                mc.delete_record(mc.CHOICE_ID)
                raise ConnectError("state_expired", "The sign-in can no longer be read. Press Connect with Facebook again.", status=409)
            finish_connection(user_token, {k: str(candidate.get(k) or "") for k in candidate}, list(choice.get("userScopes") or []), admin)
        except ConnectError as error:
            if error.code not in ("choose_system_user", "state_invalid"):
                _save_result(error.code, admin, missing=error.missing, meta_code=error.meta_code)
            return _refusal(error)
        _save_result("connected", admin)
        return {"ok": True, "code": "connected", "status": connection_status(admin)}

    @router.post("/accounts")
    def connection_accounts(
        payload: ConnectionAccountsRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        limit("accounts", admin, 30, 10 * 60_000)
        if mc.active_connection() is None:
            return _refusal(ConnectError("disconnected", "Facebook is not connected.", status=409))
        picked: list[str] = []
        for value in payload.accountIds:
            account = str(value or "").strip()
            if account.startswith("act_"):
                account = account[4:]
            if account and account not in picked:
                picked.append(account)
        state = {"unknown": False}

        def change(current: dict[str, Any]) -> dict[str, Any] | None:
            if not current:
                return None
            known = {str(row.get("id")) for row in current.get("availableAccounts") or [] if isinstance(row, dict)}
            if any(account not in known for account in picked):
                state["unknown"] = True
                return None
            return {**current, "selectedAccountIds": picked}

        saved = mc.update_record(mc.CONNECTION_ID, change)
        if state["unknown"]:
            return _refusal(ConnectError("meta_error", "Choose only ad accounts that the connected key can see."))
        if saved is None:
            return _refusal(ConnectError("meta_error", "The selection could not be saved. Try again.", status=503))
        meta_ads.meta_connection_changed()
        _audit(admin, "meta_connection.accounts", "Changed the ad accounts Albayan reads", {"selectedAccountIds": picked})
        return connection_status(admin)

    @router.post("/refresh")
    def connection_refresh(request: Request, admin: dict[str, Any] = Depends(require_meta_admin)):
        require_same_origin(request)
        limit("refresh", admin, 10, 10 * 60_000)
        view = mc.active_connection()
        if view is None:
            return _refusal(ConnectError("disconnected", "Facebook is not connected.", status=409))
        try:
            available, pages = read_assets(view.token)
        except ConnectError as error:
            return _refusal(error)
        ids = {row["id"] for row in available}

        def change(current: dict[str, Any]) -> dict[str, Any] | None:
            if not current:
                return None
            kept = [str(v) for v in current.get("selectedAccountIds") or [] if str(v) in ids]
            return {**current, "availableAccounts": available, "selectedAccountIds": kept, "pagesCount": pages}

        if mc.update_record(mc.CONNECTION_ID, change) is None:
            return _refusal(ConnectError("meta_error", "The account list could not be saved. Try again.", status=503))
        meta_ads.meta_connection_changed()
        _audit(admin, "meta_connection.refresh", "Re-read the ad accounts of the connected key", {"availableAccounts": len(available)})
        return connection_status(admin)

    @router.post("/disconnect")
    def connection_disconnect(request: Request, admin: dict[str, Any] = Depends(require_meta_admin)):
        require_same_origin(request)
        limit("disconnect", admin, 10, 10 * 60_000)
        record = mc.load_record(mc.CONNECTION_ID)  # uncached: the key stored right now
        token = mc.decrypt_secret(record, mc.CONNECTION_ID) if record else None
        revoked = revoke(token) if token else False
        removed = mc.delete_record(mc.CONNECTION_ID)
        mc.delete_record(mc.CHOICE_ID)
        mc.delete_record(mc.PENDING_ID)
        meta_ads.meta_connection_changed()
        _save_result("disconnected", admin)
        unreadable = bool(record) and not token
        _audit(admin, "meta_connection.disconnect", "Disconnected Facebook (stored copy removed)",
               {"removed": removed, "revoked": revoked, "unreadable": unreadable})
        answer: dict[str, Any] = {"ok": True, "code": "disconnected", "revoked": revoked, "status": connection_status(admin)}
        if unreadable:  # the stored key could not be opened, so Meta was not asked to revoke it
            answer["manualStep"] = UNREADABLE_DISCONNECT_TEXT
        return answer

    return router
