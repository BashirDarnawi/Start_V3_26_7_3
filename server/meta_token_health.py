"""Albayan's Meta token health (task P0-14): is the system token valid, when does it
expire, and which permissions does it hold, per page?

Platform module (not a Smart System). It asks Graph ``debug_token`` about the system
token (ALBAYAN_META_ACCESS_TOKEN), authenticated with the APP access token
"{ALBAYAN_META_APP_ID}|{ALBAYAN_META_APP_SECRET}", which is built in memory for that
one call. The result is sanitised and stored in the platform record
metaHealthState/"token". The system token and the app secret are never stored,
logged, returned or put in an exception text.

Why the token cannot reach the logs
-----------------------------------
Meta documents debug_token as a GET only, with the token to inspect in the query
string: ``GET /debug_token?input_token=...``; creating/updating/deleting is not
supported (https://developers.facebook.com/docs/graph-api/reference/debug_token/,
read 2026-09-24; callable with "an app access token"). A POST body is therefore not
an option, and httpx writes every request URL at INFO level
("HTTP Request: GET https://...?input_token=..."). So:

1. A filter on the "httpx" logger replaces the values of ``input_token``,
   ``access_token``, ``client_secret`` and ``appsecret_proof`` in every record
   before any handler sees it. It is installed on import and re-checked right
   before each call, so a logging reconfiguration cannot silently remove it.
   (httpcore's DEBUG trace lines carry no URL: only "<Request [b'GET']>", host, port.)
2. The app access token travels in the Authorization header, never in the URL.
3. Network errors are replaced by fixed texts (``raise ... from None``); Meta's own
   error messages are never kept, only its numeric error code.
4. Every text that is stored or returned is scrubbed of both secrets as a last guard.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from . import meta_ads
from .meta_ads import MetaAdsError

_STATE_ID = "token"
_MAX_RESPONSE_BYTES = 256 * 1024
_SCOPE_RE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_TYPE_RE = re.compile(r"[A-Z][A-Z_]{0,39}")
_LAST_UNIX_SECOND = 4_102_444_800  # 2100-01-01; anything later is not a real expiry

# The permissions Albayan's system token is expected to hold (PLAN.md §7.7, P0-01 k/l):
EXPECTED_SCOPES = (
    "pages_manage_metadata",      # subscribe pages to webhooks (subscribed_apps)
    "pages_messaging",            # Social Studio private replies
    "pages_manage_engagement",    # public comment replies
    "pages_read_engagement",      # read page posts and comments
    "pages_show_list",            # list the pages the token can reach
    "ads_read",                   # Manager's read-only ads sync
    "ads_management",             # D26 automatic rename on link; staff pause (R2)
    "business_management",        # business assets, ad account funds
    "instagram_basic",            # Instagram account and media
    "instagram_manage_comments",  # Instagram comment replies
    "instagram_manage_messages",  # Instagram private replies
)

_SECRET_QUERY_RE = re.compile(
    r"((?:input_token|access_token|client_secret|appsecret_proof)=)[^&\s\"'#]*", re.IGNORECASE
)


def _redact_text(value: str) -> str:
    return _SECRET_QUERY_RE.sub(r"\1[redacted]", value)


class _SecretQueryRedactor(logging.Filter):
    """Keeps httpx's request log line, but never the token values in its URL."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple) and record.args:
                record.args = tuple(
                    _redact_text(str(arg)) if isinstance(arg, (str, httpx.URL)) and _SECRET_QUERY_RE.search(str(arg)) else arg
                    for arg in record.args
                )
            elif not record.args and isinstance(record.msg, str):
                record.msg = _redact_text(record.msg)
        except Exception:
            pass
        return True


def install_log_guard() -> None:
    """Idempotent: one redacting filter on the "httpx" logger."""
    logger = logging.getLogger("httpx")
    if not any(type(item).__name__ == _SecretQueryRedactor.__name__ for item in logger.filters):
        logger.addFilter(_SecretQueryRedactor())


install_log_guard()


def _secrets(config: meta_ads.MetaAdsConfig) -> list[str]:
    return [value for value in (config.access_token, config.app_secret) if value and len(value) >= 8]


def _scrub(value: Any, secrets: list[str]) -> Any:
    """Last guard: no stored or returned text may contain a secret."""
    if isinstance(value, str):
        for secret in secrets:
            if secret in value:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, dict):
        return {_scrub(key, secrets): _scrub(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item, secrets) for item in value]
    return value


def _configuration() -> tuple[meta_ads.MetaAdsConfig, str, dict[str, Any] | None]:
    """(config, app id, None) when a check can run, else the "unconfigured" answer."""
    config = meta_ads.load_meta_ads_config()
    app_id = (os.getenv("ALBAYAN_META_APP_ID") or "").strip()
    problem: tuple[str, str] | None = None
    if not config.access_token:
        problem = ("no_access_token", "ALBAYAN_META_ACCESS_TOKEN is not set, so there is no token to check.")
    elif not app_id:
        problem = ("no_app_id", "Add ALBAYAN_META_APP_ID (the Meta app's numeric id) in Jelastic to read the token's health.")
    elif not meta_ads._META_ID_RE.fullmatch(app_id):
        problem = ("invalid_app_id", "ALBAYAN_META_APP_ID must be the Meta app's numeric id.")
    elif not config.app_secret:
        problem = ("no_app_secret", "ALBAYAN_META_APP_SECRET is not set, so the token check cannot sign in as the app.")
    if problem:
        return config, app_id, {"configured": False, "reason": problem[0], "message": problem[1]}
    return config, app_id, None


def _unix_to_iso(value: Any) -> tuple[str, bool]:
    """(ISO time, never) for Meta's unix seconds; 0 means "never expires"."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "", False
    seconds = int(value)
    if seconds == 0:
        return "", True
    if not 0 < seconds < _LAST_UNIX_SECOND:
        return "", False
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z"), False


def _scopes(value: Any) -> list[str]:
    names = {item for item in (value if isinstance(value, list) else []) if isinstance(item, str) and _SCOPE_RE.fullmatch(item)}
    return sorted(names)[:200]


def _page_coverage(value: Any) -> dict[str, dict[str, Any]]:
    """granular_scopes -> {scope: {allTargets, targetIds}}: which pages/accounts each permission covers."""
    coverage: dict[str, dict[str, Any]] = {}
    for row in (value if isinstance(value, list) else [])[:100]:
        if not isinstance(row, dict) or not isinstance(row.get("scope"), str) or not _SCOPE_RE.fullmatch(row["scope"]):
            continue
        raw_ids = row.get("target_ids")
        ids = sorted({str(item) for item in (raw_ids if isinstance(raw_ids, list) else []) if meta_ads._META_ID_RE.fullmatch(str(item))})
        coverage[row["scope"]] = {"allTargets": not isinstance(raw_ids, list), "targetIds": ids[:1000]}
    return coverage


def _clean_coverage(value: Any) -> dict[str, dict[str, Any]]:
    """The stored {scope: {allTargets, targetIds}} map, re-checked before it is returned."""
    coverage: dict[str, dict[str, Any]] = {}
    for scope, row in (value.items() if isinstance(value, dict) else []):
        if len(coverage) >= 100:
            break
        if isinstance(scope, str) and _SCOPE_RE.fullmatch(scope) and isinstance(row, dict):
            raw_ids = row.get("targetIds") if isinstance(row.get("targetIds"), list) else []
            ids = sorted({str(item) for item in raw_ids if meta_ads._META_ID_RE.fullmatch(str(item))})
            coverage[scope] = {"allTargets": row.get("allTargets") is True, "targetIds": ids[:1000]}
    return coverage


def _parse_debug_token(payload: dict[str, Any], app_id: str) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else None
    if data is None:
        raise MetaAdsError("invalid_response", "Meta returned an unreadable token check.")
    expires_at, expires_never = _unix_to_iso(data.get("expires_at"))
    data_expires_at, data_never = _unix_to_iso(data.get("data_access_expires_at"))
    issued_at, _ = _unix_to_iso(data.get("issued_at"))
    token_type = str(data.get("type") or "").strip().upper()
    scopes = _scopes(data.get("scopes"))
    error = data.get("error") if isinstance(data.get("error"), dict) else {}
    code = re.sub(r"\D", "", str(error.get("code") or ""))[:10]
    subcode = re.sub(r"\D", "", str(error.get("subcode") or error.get("error_subcode") or ""))[:10]
    return {
        "configured": True,
        "isValid": data.get("is_valid") is True,
        "type": token_type if _TYPE_RE.fullmatch(token_type) else "",
        "application": meta_ads._clean_text(data.get("application"), 120),
        "appMatches": str(data.get("app_id") or "") == app_id,
        "expiresAt": expires_at,
        "expiresNever": expires_never,
        "dataAccessExpiresAt": data_expires_at,
        "dataAccessExpiresNever": data_never,
        "issuedAt": issued_at,
        "scopes": scopes,
        "missingScopes": [scope for scope in EXPECTED_SCOPES if scope not in scopes],
        "pagesCoveredByScope": _page_coverage(data.get("granular_scopes")),
        "errorCode": f"{code}.{subcode}" if code and subcode else code,
        "checkedAt": meta_ads._iso_now(),
    }


def _graph_debug_token(config: meta_ads.MetaAdsConfig, app_id: str) -> dict[str, Any]:
    install_log_guard()
    url = f"https://graph.facebook.com/{config.graph_version}/debug_token"
    try:
        with httpx.Client(
            timeout=float(config.request_timeout_seconds),
            follow_redirects=False,
            headers={
                "Authorization": f"Bearer {app_id}|{config.app_secret}",
                "Accept": "application/json",
                "User-Agent": "Albayan-Meta-Token-Health/1.0",
            },
        ) as client:
            with client.stream("GET", url, params={"input_token": config.access_token}) as response:
                status = int(response.status_code or 0)
                body = meta_ads._read_capped_response_body(response, _MAX_RESPONSE_BYTES)
    except Exception:
        # Fixed text only: an httpx error object carries the request (and its URL).
        raise MetaAdsError("network", "Meta could not be reached to check the token. Try again later.", retryable=True) from None
    if body is None:
        raise MetaAdsError("response_too_large", "Meta returned too much data for the token check.")
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise MetaAdsError("invalid_response", "Meta returned an unreadable token check.")
    error = payload.get("error") if isinstance(payload.get("error"), dict) else None
    if error is not None or not 200 <= status < 300:
        code = re.sub(r"\D", "", str((error or {}).get("code") or status))[:10]
        raise MetaAdsError(
            "check_failed",
            f"Meta refused the token check (code {code}). Check ALBAYAN_META_APP_ID and ALBAYAN_META_APP_SECRET.",
            retryable=status >= 500,
            provider_code=code,
        )
    return payload


def read_token_debug() -> dict[str, Any]:
    """Ask Meta about the system token; a sanitised result (never the token or the secret).

    Missing app id or secret -> {"configured": False, "reason": ...} with no Graph call.
    Raises MetaAdsError (fixed texts only) when Meta cannot answer.
    """
    config, app_id, unconfigured = _configuration()
    if unconfigured is not None:
        return unconfigured
    return _scrub(_parse_debug_token(_graph_debug_token(config, app_id), app_id), _secrets(config))


def check_token_now() -> dict[str, Any]:
    """Read the token now and store the result in metaHealthState/"token" (the store is best effort)."""
    try:
        result = read_token_debug()
    except MetaAdsError as error:
        failure = {
            "lastCheckError": meta_ads._clean_text(f"{error.code}:{error.provider_code}" if error.provider_code else error.code, 60),
            "lastCheckErrorAt": meta_ads._iso_now(),
        }
        try:
            meta_ads.save_meta_health_state(_STATE_ID, lambda current: {**current, **failure})
        except Exception:
            pass
        raise
    if result.get("configured"):
        try:
            meta_ads.save_meta_health_state(_STATE_ID, lambda _current: dict(result))
        except Exception:
            pass
    return result


def _days_left(iso_value: str, now: float) -> int | None:
    if not iso_value:
        return None
    try:
        moment = datetime.fromisoformat(iso_value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return math.floor((moment - now) / 86400)


def token_health_report() -> dict[str, Any]:
    """What the admin route returns: the stored reading, days left, missing permissions, webhook counts."""
    config, _app_id, unconfigured = _configuration()
    report: dict[str, Any] = {
        "expectedScopes": list(EXPECTED_SCOPES),
        "webhookCounts": meta_ads.webhook_counts_report(),
    }
    if unconfigured is not None:
        report.update(unconfigured)
        return _scrub(report, _secrets(config))
    stored = meta_ads.load_meta_health_state(_STATE_ID)
    now = time.time()
    scopes = _scopes(stored.get("scopes"))
    expires_at = meta_ads._clean_time(stored.get("expiresAt"))
    data_expires_at = meta_ads._clean_time(stored.get("dataAccessExpiresAt"))
    report.update({
        "configured": True,
        "checked": bool(meta_ads._clean_time(stored.get("checkedAt"))),
        "checkedAt": meta_ads._clean_time(stored.get("checkedAt")),
        "isValid": stored.get("isValid") is True,
        "type": str(stored.get("type") or "") if _TYPE_RE.fullmatch(str(stored.get("type") or "")) else "",
        "application": meta_ads._clean_text(stored.get("application"), 120),
        "appMatches": stored.get("appMatches") is True,
        "expiresAt": expires_at,
        "expiresNever": stored.get("expiresNever") is True,
        "daysLeft": _days_left(expires_at, now),
        "dataAccessExpiresAt": data_expires_at,
        "dataAccessExpiresNever": stored.get("dataAccessExpiresNever") is True,
        "dataAccessDaysLeft": _days_left(data_expires_at, now),
        "scopes": scopes,
        "missingScopes": [scope for scope in EXPECTED_SCOPES if scope not in scopes],
        "pagesCoveredByScope": _clean_coverage(stored.get("pagesCoveredByScope")),
        "errorCode": meta_ads._clean_text(stored.get("errorCode"), 24),
        "lastCheckError": meta_ads._clean_text(stored.get("lastCheckError"), 60),
        "lastCheckErrorAt": meta_ads._clean_time(stored.get("lastCheckErrorAt")),
    })
    return _scrub(report, _secrets(config))
