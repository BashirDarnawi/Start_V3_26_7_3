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

Which token a reading belongs to
--------------------------------
A stored reading also carries ``tokenFingerprint``: the first 16 hex of an HMAC-SHA256
of the system token keyed with the app secret, computed in memory. When the token is
replaced in Jelastic, the old reading no longer matches and is reported as stale
instead of as the new token's health. The fingerprint stays in the database (and so in full backups);
it is never in an API response or a log, and the generic collections API refuses metaHealthState.

P3-18a adds the jobs loop's side: ``daily_token_check()`` (the saved reading while it is less than a
day old, else check_token_now()), ``token_verdict()`` (valid / invalid / unknown: only an answer
from Meta can say invalid) and ``expiry_warnings()`` (the 14/7/2-day warnings, pure). What the studio
does with them (the connection state, parked replies, alerts) lives in
server/systems/ads_studio/studio_alerts_meta.py.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import re
import threading
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
_CHECK_MAX_AGE_SECONDS = 600  # PLAN §7.2/§7.4: check_token_now() runs at most once per 10 min
_FINGERPRINT_SALT = b"albayan-meta-token-health-fingerprint-v1"  # only when there is no app secret
# What check_token_now may hand back from the store (never the fingerprint):
_READING_KEYS = (
    "isValid", "type", "application", "appMatches", "expiresAt", "expiresNever",
    "dataAccessExpiresAt", "dataAccessExpiresNever", "issuedAt", "scopes", "missingScopes",
    "pagesCoveredByScope", "errorCode", "checkedAt", "lastCheckError", "lastCheckErrorAt",
)
# One Graph check at a time per process, and when (monotonic) and for which token the last one ran.
_CHECK_LOCK = threading.Lock()
_LAST_CHECK: dict[str, Any] = {"fingerprint": "", "at": 0.0}

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


def _token_fingerprint(config: meta_ads.MetaAdsConfig) -> str:
    """A one-way tag of the system token, so a stored reading is tied to the token it checked.

    Keyed with the app secret: the stored tag cannot be tested against a guessed token
    without it. Stored only; never in an API response or a log.
    """
    token = config.access_token.encode("utf-8")
    if config.app_secret:
        return hmac.new(config.app_secret.encode("utf-8"), token, hashlib.sha256).hexdigest()[:16]
    return hashlib.sha256(_FINGERPRINT_SALT + token).hexdigest()[:16]


def _same_token(stored: dict[str, Any], fingerprint: str) -> bool:
    """True when the stored reading checked this token (a reading without a fingerprint never does)."""
    saved = stored.get("tokenFingerprint")
    return isinstance(saved, str) and hmac.compare_digest(saved.encode("utf-8"), fingerprint.encode("utf-8"))


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
    return _read_checked(config, app_id)


def _read_checked(config: meta_ads.MetaAdsConfig, app_id: str) -> dict[str, Any]:
    return _scrub(_parse_debug_token(_graph_debug_token(config, app_id), app_id), _secrets(config))


def _saved_reading(config: meta_ads.MetaAdsConfig, fingerprint: str) -> dict[str, Any] | None:
    """The stored reading of this same token, shaped like a fresh one (None for another token)."""
    stored = meta_ads.load_meta_health_state(_STATE_ID)
    if not _same_token(stored, fingerprint):
        return None
    reading = {key: stored[key] for key in _READING_KEYS if key in stored}
    return _scrub({"configured": True, **reading}, _secrets(config))


def _with_failure(current: dict[str, Any], failure: dict[str, Any], fingerprint: str) -> dict[str, Any]:
    """A failed check keeps the last good reading of the same token, never another token's."""
    if _same_token(current, fingerprint):
        return {**current, **failure}
    return {**failure, "tokenFingerprint": fingerprint}


def check_token_now(max_age_seconds: float = _CHECK_MAX_AGE_SECONDS) -> dict[str, Any]:
    """Read the token now and store the result in metaHealthState/"token" (the store is best effort).

    Self-limiting, as it also runs on authorization failures: when this process checked
    the SAME token less than max_age_seconds ago (successfully or not), the saved reading
    is returned without calling Meta; after a failed check it carries lastCheckError.
    A changed token is always checked, and max_age_seconds=0 always checks. The lock
    lets one caller at a time reach Meta, so a burst of callers costs one call.
    A reading without checkedAt has no validity (isValid is present only after a successful
    check): callers must read that as "unknown", never as an invalid token.
    """
    config, app_id, unconfigured = _configuration()
    if unconfigured is not None:
        return unconfigured
    fingerprint = _token_fingerprint(config)
    with _CHECK_LOCK:
        age = time.monotonic() - float(_LAST_CHECK["at"])
        if max_age_seconds > 0 and _LAST_CHECK["fingerprint"] == fingerprint and 0 <= age < max_age_seconds:
            saved = _saved_reading(config, fingerprint)
            if saved is not None:
                return saved
        _LAST_CHECK.update(fingerprint=fingerprint, at=time.monotonic())
        try:
            result = _read_checked(config, app_id)
        except MetaAdsError as error:
            failure = {
                "lastCheckError": meta_ads._clean_text(f"{error.code}:{error.provider_code}" if error.provider_code else error.code, 60),
                "lastCheckErrorAt": meta_ads._iso_now(),
            }
            try:
                meta_ads.save_meta_health_state(_STATE_ID, lambda current: _with_failure(current, failure, fingerprint))
            except Exception:
                pass
            raise
        try:
            meta_ads.save_meta_health_state(_STATE_ID, lambda _current: {**result, "tokenFingerprint": fingerprint})
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


# ------------------------------------------------------------------ P3-18a: the daily check, its verdict, expiry warnings

DAILY_CHECK_SECONDS = 24 * 60 * 60
_FAILED_DAILY_RETRY_SECONDS = 60 * 60  # a daily check Meta did not answer is tried again after an hour
EXPIRY_WARN_DAYS = (14, 7, 2)  # PLAN §7.4 / §7.7; the studio's thresholds setting may change them
EXPIRY_FIELDS = ("expiresAt", "dataAccessExpiresAt")


def _unix_time(iso_value: Any) -> float | None:
    clean = meta_ads._clean_time(iso_value)
    return datetime.fromisoformat(clean.replace("Z", "+00:00")).timestamp() if clean else None


def _seconds_since(iso_value: Any, now: float) -> float | None:
    moment = _unix_time(iso_value)
    return None if moment is None else now - moment


def daily_token_check(now: float | None = None) -> dict[str, Any]:
    """The jobs loop's daily read of the system token (P3-18a); never raises for a Meta failure.

    Returns the saved reading of the CURRENT token while it is less than a day old, or less than an
    hour after a check Meta did not answer (no Meta call); otherwise check_token_now(), which itself
    reaches Meta at most once per 10 minutes. After a failure the reading carries lastCheckError
    (and no checkedAt when this token was never read). Unconfigured: {"configured": False, ...}.
    """
    config, _app_id, unconfigured = _configuration()
    if unconfigured is not None:
        return unconfigured
    now = time.time() if now is None else now
    fingerprint = _token_fingerprint(config)
    saved = _saved_reading(config, fingerprint)
    if saved is not None:
        checked = _seconds_since(saved.get("checkedAt"), now)
        failed = _seconds_since(saved.get("lastCheckErrorAt"), now)
        if (checked is not None and 0 <= checked < DAILY_CHECK_SECONDS) or (
            failed is not None and 0 <= failed < _FAILED_DAILY_RETRY_SECONDS
        ):
            return saved
    try:
        return check_token_now()
    except MetaAdsError as error:
        after = _saved_reading(config, fingerprint)  # check_token_now stored the failure beside the last good reading
        if after is not None:
            return after
        code = f"{error.code}:{error.provider_code}" if error.provider_code else error.code
        return {"configured": True, "lastCheckError": meta_ads._clean_text(code, 60), "lastCheckErrorAt": meta_ads._iso_now()}


def token_verdict(reading: Any) -> str:
    """'valid', 'invalid' or 'unknown' for a reading of check_token_now() / daily_token_check().

    'invalid' only when Meta ANSWERED that the token does not work: ``is_valid`` false, or a 190
    error on the token itself (debug_token's data.error). No reading, no app id, or a latest check
    that failed (lastCheckErrorAt after checkedAt: Meta unreachable) is 'unknown', never 'invalid':
    a network problem must not look like a dead token (PLAN §7.4).
    """
    if not isinstance(reading, dict) or reading.get("configured") is False:
        return "unknown"
    checked_at = _unix_time(reading.get("checkedAt"))
    if checked_at is None:
        return "unknown"
    failed_at = _unix_time(reading.get("lastCheckErrorAt"))
    if failed_at is not None and failed_at > checked_at:
        return "unknown"
    if reading.get("isValid") is False or str(reading.get("errorCode") or "").split(".")[0] == "190":
        return "invalid"
    return "valid" if reading.get("isValid") is True else "unknown"


def expiry_warnings(reading: Any, warn_days: Any = EXPIRY_WARN_DAYS, now: float | None = None) -> list[dict[str, Any]]:
    """The expiry warning due for each expiry of a reading (P3-18a): ``[{field, expiresAt, daysLeft,
    thresholdDays}]``, where thresholdDays is the SMALLEST warning day count the days left have
    reached (14 -> 7 -> 2 by default), so each threshold is one warning. "Never expires" and a
    reading without a successful check give none. Pure: the caller raises the alerts."""
    if not isinstance(reading, dict) or not meta_ads._clean_time(reading.get("checkedAt")):
        return []
    days = sorted({int(day) for day in (warn_days or ()) if isinstance(day, int) and not isinstance(day, bool) and day > 0})
    now = time.time() if now is None else now
    out: list[dict[str, Any]] = []
    for field in EXPIRY_FIELDS:
        expires_at = meta_ads._clean_time(reading.get(field))
        left = _days_left(expires_at, now)
        reached = [day for day in days if left is not None and left <= day]
        if reached:
            out.append({"field": field, "expiresAt": expires_at, "daysLeft": left, "thresholdDays": reached[0]})
    return out


def token_health_report() -> dict[str, Any]:
    """What the admin route returns: the stored reading, days left, missing permissions, webhook counts.

    A reading stored for another token (or before readings carried a fingerprint) is
    reported as stale: checked=False and none of its validity, expiry or scopes.
    """
    config, _app_id, unconfigured = _configuration()
    report: dict[str, Any] = {
        "expectedScopes": list(EXPECTED_SCOPES),
        "webhookCounts": meta_ads.webhook_counts_report(),
    }
    if unconfigured is not None:
        report.update(unconfigured)
        return _scrub(report, _secrets(config))
    stored = meta_ads.load_meta_health_state(_STATE_ID)
    if stored and not _same_token(stored, _token_fingerprint(config)):
        # The saved reading checked another token (it was replaced since): none of it is shown.
        report.update({
            "configured": True,
            "checked": False,
            "stale": True,
            "message": "The saved reading is for an earlier token. Re-check to read the current one.",
        })
        return _scrub(report, _secrets(config))
    now = time.time()
    scopes = _scopes(stored.get("scopes"))
    expires_at = meta_ads._clean_time(stored.get("expiresAt"))
    data_expires_at = meta_ads._clean_time(stored.get("dataAccessExpiresAt"))
    report.update({
        "configured": True,
        "checked": bool(meta_ads._clean_time(stored.get("checkedAt"))),
        "stale": False,
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
