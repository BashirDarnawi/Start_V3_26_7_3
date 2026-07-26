"""Read-only Meta Marketing API integration for Albayan ads.

The integration deliberately keeps Meta's live delivery facts in dedicated
``meta*`` fields.  It never rewrites Albayan's customer, receipt, payment,
exchange-rate, or accounting status fields.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import os
import re
import threading
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Callable

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text

from .db import db_conn, get_engine, json_dumps, json_loads, now_ms
from .entity_projection import _without_inline_media
from .rate_limiter import check_rate_limit
from .security import new_id


_META_ID_RE = re.compile(r"^[0-9]{1,40}$")
_LOCAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
_GRAPH_VERSION_RE = re.compile(r"^v[0-9]{1,2}\.[0-9]{1,2}$")
_TRUE_VALUES = {"1", "true", "yes", "on"}
_META_WRITE_LOCK = threading.RLock()


META_AD_LINK_FIELDS = frozenset(
    {
        "metaLinkState",
        "metaLinkVersion",
        "metaAdId",
        "metaAdName",
        "metaAdSetId",
        "metaAdSetName",
        "metaCampaignId",
        "metaCampaignName",
        "metaAdAccountId",
        "metaAdAccountName",
        "metaCurrency",
        "metaConfiguredStatus",
        "metaEffectiveStatus",
        "metaAdSetStatus",
        "metaCampaignStatus",
        "metaObjective",
        "metaBudgetSource",
        "metaDailyBudgetMinor",
        "metaLifetimeBudgetMinor",
        "metaBudgetRemainingMinor",
        "metaStartTime",
        "metaEndTime",
        "metaAdCreatedTime",
        "metaAdUpdatedTime",
        "metaSpend",
        "metaSpendMinor",
        "metaReach",
        "metaImpressions",
        "metaClicks",
        "metaPrimaryResultType",
        "metaPrimaryResultValue",
        "metaActions",
        "metaSyncedAt",
        "metaLastAttemptAt",
        "metaLastChangedAt",
        "metaSyncError",
        "metaSyncErrorCode",
        "metaSyncFailureCount",
        "metaNextSyncAt",
        "metaUnlinkedAt",
    }
)

# These fields may only be written by the dedicated endpoints below.  Exported
# for the ordinary ad mutation endpoints to reject forged live-Meta state.
META_AD_SERVER_FIELDS = frozenset(
    set(META_AD_LINK_FIELDS)
    | {"metaLastOperationId", "metaLastOperationHash"}
)

_HISTORY_FIELDS: tuple[tuple[str, str], ...] = (
    ("metaAdName", "Meta ad name"),
    ("metaCampaignName", "Meta campaign"),
    ("metaAdSetName", "Meta ad set"),
    ("metaConfiguredStatus", "Meta configured status"),
    ("metaEffectiveStatus", "Meta live status"),
    ("metaDailyBudgetMinor", "Meta daily budget"),
    ("metaLifetimeBudgetMinor", "Meta lifetime budget"),
    ("metaStartTime", "Meta start time"),
    ("metaEndTime", "Meta end time"),
)


def _bounded_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError, OverflowError):
        return default
    return min(max(parsed, minimum), maximum)


def _account_id(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized.startswith("act_"):
        normalized = normalized[4:]
    if not _META_ID_RE.fullmatch(normalized):
        raise MetaAdsError("invalid_id", "Invalid Meta ad-account ID")
    return normalized


def _meta_id(value: Any, label: str = "Meta object") -> str:
    normalized = str(value or "").strip()
    if not _META_ID_RE.fullmatch(normalized):
        raise MetaAdsError("invalid_id", f"Invalid {label} ID")
    return normalized


def _local_id(value: Any) -> str:
    normalized = str(value or "").strip()
    if not _LOCAL_ID_RE.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="Invalid Albayan ad ID")
    return normalized


def _clean_text(value: Any, maximum: int = 240) -> str:
    text_value = str(value or "").replace("\x00", "").strip()
    return text_value[:maximum]


def _clean_time(value: Any) -> str:
    candidate = _clean_text(value, 64)
    if not candidate:
        return ""
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _minor_units(value: Any) -> int:
    try:
        parsed = int(str(value or "0").strip())
    except (TypeError, ValueError, OverflowError):
        return 0
    return min(max(parsed, 0), 100_000_000_000)


def _decimal_amount(value: Any) -> tuple[float, int]:
    try:
        parsed = Decimal(str(value or "0"))
    except (InvalidOperation, ValueError, TypeError):
        parsed = Decimal(0)
    if not parsed.is_finite() or parsed < 0:
        parsed = Decimal(0)
    parsed = min(parsed, Decimal("1000000000"))
    rounded = parsed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(rounded), int((rounded * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _metric_int(value: Any) -> int:
    try:
        parsed = int(Decimal(str(value or "0")))
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        return 0
    return min(max(parsed, 0), 10_000_000_000_000)


@dataclass(frozen=True)
class MetaAdsConfig:
    access_token: str = field(repr=False)
    app_secret: str = field(repr=False)
    graph_version: str
    allowed_account_ids: tuple[str, ...]
    background_sync: bool
    sync_interval_minutes: int
    sync_batch_size: int
    request_timeout_seconds: int

    @property
    def configured(self) -> bool:
        return bool(self.access_token)


def load_meta_ads_config() -> MetaAdsConfig:
    version = (os.getenv("ALBAYAN_META_GRAPH_API_VERSION") or "v25.0").strip()
    if not _GRAPH_VERSION_RE.fullmatch(version):
        version = "v25.0"
    allowed: list[str] = []
    for value in (os.getenv("ALBAYAN_META_AD_ACCOUNT_IDS") or "").split(","):
        value = value.strip()
        if not value:
            continue
        try:
            normalized = _account_id(value)
        except MetaAdsError:
            continue
        if normalized not in allowed:
            allowed.append(normalized)
    background_raw = os.getenv("ALBAYAN_META_BACKGROUND_SYNC")
    background_sync = True if background_raw is None else background_raw.strip().lower() in _TRUE_VALUES
    return MetaAdsConfig(
        access_token=(os.getenv("ALBAYAN_META_ACCESS_TOKEN") or "").strip(),
        app_secret=(os.getenv("ALBAYAN_META_APP_SECRET") or "").strip(),
        graph_version=version,
        allowed_account_ids=tuple(allowed),
        background_sync=background_sync,
        sync_interval_minutes=_bounded_int(
            os.getenv("ALBAYAN_META_SYNC_INTERVAL_MINUTES"), 15, 5, 1440
        ),
        sync_batch_size=_bounded_int(
            os.getenv("ALBAYAN_META_SYNC_BATCH_SIZE"), 20, 1, 100
        ),
        request_timeout_seconds=_bounded_int(
            os.getenv("ALBAYAN_META_REQUEST_TIMEOUT_SECONDS"), 15, 5, 60
        ),
    )


class MetaAdsError(RuntimeError):
    def __init__(self, code: str, public_message: str, *, retryable: bool = False):
        super().__init__(public_message)
        self.code = _clean_text(code, 40) or "meta_error"
        self.public_message = _clean_text(public_message, 240) or "Meta synchronization failed"
        self.retryable = bool(retryable)


class MetaAdsClient:
    """Small fixed-host client; access tokens are sent only in an auth header."""

    def __init__(self, config: MetaAdsConfig):
        if not config.configured:
            raise MetaAdsError("not_configured", "Meta Ads connection is not configured")
        self.config = config
        self._account_cache: dict[str, dict[str, Any]] = {}

    def _ensure_allowed_account(self, account_id: Any) -> str:
        normalized = _account_id(account_id)
        allowed = set(self.config.allowed_account_ids)
        if allowed and normalized not in allowed:
            raise MetaAdsError("account_not_allowed", "This Meta ad account is not allowed")
        return normalized

    def _safe_error(self, response: httpx.Response, payload: Any) -> MetaAdsError:
        status = int(response.status_code or 0)
        error = payload.get("error") if isinstance(payload, dict) else {}
        code = str(error.get("code") or status or "meta_error") if isinstance(error, dict) else str(status)
        if status in {401, 403} or code == "190":
            return MetaAdsError("authorization", "Meta authorization failed. Reconnect the access token.")
        if status == 404 or code in {"100", "803"}:
            return MetaAdsError("not_found", "The selected Meta ad was not found or is no longer accessible.")
        if status == 429 or code in {"4", "17", "32", "613"}:
            return MetaAdsError("rate_limited", "Meta is temporarily limiting synchronization. Albayan will retry.", retryable=True)
        if status >= 500 or (isinstance(error, dict) and error.get("is_transient") is True):
            return MetaAdsError("temporary", "Meta is temporarily unavailable. Albayan will retry.", retryable=True)
        return MetaAdsError("request_failed", "Meta could not return the requested ad information.")

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        safe_path = str(path or "").strip("/")
        if not safe_path or ".." in safe_path or not re.fullmatch(r"[A-Za-z0-9_/-]+", safe_path):
            raise MetaAdsError("invalid_path", "Invalid Meta API request")
        query = dict(params or {})
        if self.config.app_secret:
            query["appsecret_proof"] = hmac.new(
                self.config.app_secret.encode("utf-8"),
                self.config.access_token.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
        url = f"https://graph.facebook.com/{self.config.graph_version}/{safe_path}"
        try:
            with httpx.Client(
                timeout=float(self.config.request_timeout_seconds),
                follow_redirects=False,
                headers={
                    "Authorization": f"Bearer {self.config.access_token}",
                    "Accept": "application/json",
                    "User-Agent": "Albayan-Meta-Read-Sync/1.0",
                },
            ) as client:
                response = client.get(url, params=query)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.TransportError):
            raise MetaAdsError("network", "Meta could not be reached. Albayan will retry.", retryable=True)
        if len(response.content or b"") > 6 * 1024 * 1024:
            raise MetaAdsError("response_too_large", "Meta returned too much data for one synchronization.")
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not 200 <= response.status_code < 300 or (isinstance(payload, dict) and payload.get("error")):
            raise self._safe_error(response, payload)
        if not isinstance(payload, dict):
            raise MetaAdsError("invalid_response", "Meta returned an invalid response.")
        return payload

    def _paged(self, path: str, params: dict[str, Any], *, max_pages: int = 5) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        cursor = ""
        for _ in range(max_pages):
            page_params = dict(params)
            if cursor:
                page_params["after"] = cursor
            payload = self._get(path, page_params)
            data = payload.get("data")
            if isinstance(data, list):
                rows.extend(row for row in data if isinstance(row, dict))
            paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
            cursors = paging.get("cursors") if isinstance(paging.get("cursors"), dict) else {}
            next_cursor = _clean_text(cursors.get("after"), 300)
            if not paging.get("next") or not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor
        return rows

    def list_accounts(self) -> list[dict[str, Any]]:
        rows = self._paged(
            "me/adaccounts",
            {
                "fields": "id,account_id,name,account_status,currency,timezone_name",
                "limit": 100,
            },
            max_pages=5,
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                account_id = self._ensure_allowed_account(row.get("account_id") or row.get("id"))
            except MetaAdsError:
                continue
            normalized = {
                "id": account_id,
                "name": _clean_text(row.get("name"), 160) or f"Ad account {account_id}",
                "currency": _clean_text(row.get("currency"), 12).upper(),
                "timezone": _clean_text(row.get("timezone_name"), 80),
                "status": _metric_int(row.get("account_status")),
            }
            self._account_cache[account_id] = normalized
            result.append(normalized)
        return result

    def list_ads(self, account_id: Any, search: str = "") -> list[dict[str, Any]]:
        normalized_account = self._ensure_allowed_account(account_id)
        rows = self._paged(
            f"act_{normalized_account}/ads",
            {
                "fields": "id,name,status,effective_status,configured_status,adset_id,campaign_id,created_time,updated_time,adset{id,name},campaign{id,name}",
                "limit": 100,
            },
            max_pages=5,
        )
        needle = _clean_text(search, 100).casefold()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                ad_id = _meta_id(row.get("id"), "Meta ad")
            except MetaAdsError:
                continue
            adset = row.get("adset") if isinstance(row.get("adset"), dict) else {}
            campaign = row.get("campaign") if isinstance(row.get("campaign"), dict) else {}
            item = {
                "id": ad_id,
                "name": _clean_text(row.get("name"), 240) or f"Meta ad {ad_id}",
                "status": _clean_text(row.get("configured_status") or row.get("status"), 40),
                "effectiveStatus": _clean_text(row.get("effective_status"), 40),
                "adSetId": _clean_text(row.get("adset_id") or adset.get("id"), 40),
                "adSetName": _clean_text(adset.get("name"), 240),
                "campaignId": _clean_text(row.get("campaign_id") or campaign.get("id"), 40),
                "campaignName": _clean_text(campaign.get("name"), 240),
                "createdTime": _clean_time(row.get("created_time")),
                "updatedTime": _clean_time(row.get("updated_time")),
            }
            haystack = " ".join(str(item.get(key) or "") for key in ("id", "name", "adSetName", "campaignName")).casefold()
            if needle and needle not in haystack:
                continue
            result.append(item)
        return result[:500]

    def _get_account(self, account_id: str) -> dict[str, Any]:
        account_id = self._ensure_allowed_account(account_id)
        cached = self._account_cache.get(account_id)
        if cached:
            return cached
        row = self._get(
            f"act_{account_id}",
            {"fields": "id,account_id,name,account_status,currency,timezone_name"},
        )
        normalized = {
            "id": account_id,
            "name": _clean_text(row.get("name"), 160) or f"Ad account {account_id}",
            "currency": _clean_text(row.get("currency"), 12).upper(),
            "timezone": _clean_text(row.get("timezone_name"), 80),
            "status": _metric_int(row.get("account_status")),
        }
        self._account_cache[account_id] = normalized
        return normalized

    def get_ad_snapshot(self, ad_id: Any) -> dict[str, Any]:
        ad_id = _meta_id(ad_id, "Meta ad")
        ad = self._get(
            ad_id,
            {
                "fields": "id,name,status,effective_status,configured_status,adset_id,campaign_id,account_id,created_time,updated_time"
            },
        )
        account_id = self._ensure_allowed_account(ad.get("account_id"))
        account = self._get_account(account_id)
        adset_id = _meta_id(ad.get("adset_id"), "Meta ad set")
        campaign_id = _meta_id(ad.get("campaign_id"), "Meta campaign")
        adset = self._get(
            adset_id,
            {
                "fields": "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,optimization_goal,billing_event"
            },
        )
        campaign = self._get(
            campaign_id,
            {
                "fields": "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,objective,buying_type"
            },
        )
        insights_payload = self._get(
            f"{ad_id}/insights",
            {
                "fields": "spend,reach,impressions,clicks,actions",
                "date_preset": "maximum",
                "limit": 1,
            },
        )
        insights_rows = insights_payload.get("data") if isinstance(insights_payload.get("data"), list) else []
        insights = insights_rows[0] if insights_rows and isinstance(insights_rows[0], dict) else {}
        spend, spend_minor = _decimal_amount(insights.get("spend"))
        raw_actions = insights.get("actions") if isinstance(insights.get("actions"), list) else []
        actions: list[dict[str, Any]] = []
        for row in raw_actions[:50]:
            if not isinstance(row, dict):
                continue
            action_type = _clean_text(row.get("action_type"), 120)
            if not action_type:
                continue
            amount, _ = _decimal_amount(row.get("value"))
            actions.append({"type": action_type, "value": amount})
        priorities = (
            "onsite_conversion.messaging_conversation_started_7d",
            "messaging_conversation_started_7d",
            "lead",
            "purchase",
            "link_click",
        )
        primary = next((row for wanted in priorities for row in actions if row["type"] == wanted), None)
        if primary is None and actions:
            primary = actions[0]
        daily_budget = _minor_units(adset.get("daily_budget") or campaign.get("daily_budget"))
        lifetime_budget = _minor_units(adset.get("lifetime_budget") or campaign.get("lifetime_budget"))
        budget_remaining = _minor_units(adset.get("budget_remaining") or campaign.get("budget_remaining"))
        budget_source = "adset" if any(adset.get(key) not in (None, "") for key in ("daily_budget", "lifetime_budget")) else "campaign"
        synced_at = _iso_now()
        next_sync = now_ms() + self.config.sync_interval_minutes * 60_000
        return {
            "metaLinkState": "linked",
            "metaLinkVersion": 1,
            "metaAdId": ad_id,
            "metaAdName": _clean_text(ad.get("name"), 240) or f"Meta ad {ad_id}",
            "metaAdSetId": adset_id,
            "metaAdSetName": _clean_text(adset.get("name"), 240),
            "metaCampaignId": campaign_id,
            "metaCampaignName": _clean_text(campaign.get("name"), 240),
            "metaAdAccountId": account_id,
            "metaAdAccountName": _clean_text(account.get("name"), 160),
            "metaCurrency": _clean_text(account.get("currency"), 12).upper(),
            "metaConfiguredStatus": _clean_text(ad.get("configured_status") or ad.get("status"), 40),
            "metaEffectiveStatus": _clean_text(ad.get("effective_status"), 40),
            "metaAdSetStatus": _clean_text(adset.get("effective_status") or adset.get("status"), 40),
            "metaCampaignStatus": _clean_text(campaign.get("effective_status") or campaign.get("status"), 40),
            "metaObjective": _clean_text(campaign.get("objective"), 80),
            "metaBudgetSource": budget_source,
            "metaDailyBudgetMinor": daily_budget,
            "metaLifetimeBudgetMinor": lifetime_budget,
            "metaBudgetRemainingMinor": budget_remaining,
            "metaStartTime": _clean_time(adset.get("start_time") or campaign.get("start_time")),
            "metaEndTime": _clean_time(adset.get("end_time") or campaign.get("stop_time")),
            "metaAdCreatedTime": _clean_time(ad.get("created_time")),
            "metaAdUpdatedTime": _clean_time(ad.get("updated_time")),
            "metaSpend": spend,
            "metaSpendMinor": spend_minor,
            "metaReach": _metric_int(insights.get("reach")),
            "metaImpressions": _metric_int(insights.get("impressions")),
            "metaClicks": _metric_int(insights.get("clicks")),
            "metaPrimaryResultType": str(primary.get("type") or "") if primary else "",
            "metaPrimaryResultValue": float(primary.get("value") or 0) if primary else 0.0,
            "metaActions": actions[:25],
            "metaSyncedAt": synced_at,
            "metaLastAttemptAt": synced_at,
            "metaSyncError": "",
            "metaSyncErrorCode": "",
            "metaSyncFailureCount": 0,
            "metaNextSyncAt": next_sync,
            "metaUnlinkedAt": "",
        }


def get_meta_ads_client() -> MetaAdsClient:
    return MetaAdsClient(load_meta_ads_config())


def _entity_from_row(row: Any, data: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(data) if isinstance(data, dict) else (json_loads(row.get("data_json") or "{}") or {})
    return {
        "id": str(row["id"]),
        "type": str(row["type"]),
        "deleted": bool(row["deleted"]),
        "createdAt": int(row["created_at"]),
        "createdBy": row.get("created_by"),
        "lastModified": int(row["last_modified"]),
        "data": payload,
    }


def _thin_ad_entity(entity: dict[str, Any]) -> dict[str, Any]:
    result = dict(entity)
    result["data"] = _without_inline_media("ads", dict(entity.get("data") or {}))
    return result


def _operation_hash(action: str, ad_id: str, operation_id: str, value: str = "") -> str:
    return hashlib.sha256(f"{action}\0{ad_id}\0{operation_id}\0{value}".encode("utf-8")).hexdigest()


def _history_value(field_name: str, value: Any, currency: str = "USD") -> str:
    if field_name in {"metaDailyBudgetMinor", "metaLifetimeBudgetMinor"}:
        return f"{_minor_units(value) / 100:.2f} {currency or 'USD'}"
    return _clean_text(value, 500) or "—"


def _meaningful_changes(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    currency = _clean_text(new.get("metaCurrency") or old.get("metaCurrency"), 12).upper() or "USD"
    for field_name, label in _HISTORY_FIELDS:
        if old.get(field_name) == new.get(field_name):
            continue
        changes.append(
            {
                "field": label,
                "from": _history_value(field_name, old.get(field_name), currency),
                "to": _history_value(field_name, new.get(field_name), currency),
            }
        )
    return changes


def _append_history(data: dict[str, Any], changes: list[dict[str, str]], actor_name: str) -> None:
    if not changes:
        return
    history = data.get("editHistory") if isinstance(data.get("editHistory"), list) else []
    safe_history = [row for row in history if isinstance(row, dict)][-499:]
    safe_history.append(
        {
            "editedAt": _iso_now(),
            "editedBy": _clean_text(actor_name, 120) or "Meta automatic sync",
            "changes": changes[:20],
        }
    )
    data["editHistory"] = safe_history
    data["editCount"] = len(safe_history)


def _ensure_unique_link(conn: Any, local_ad_id: str, meta_ad_id: str) -> None:
    rows = conn.execute(
        text("SELECT id,data_json FROM entities WHERE type='ads' AND deleted=false AND id<>:id"),
        {"id": local_ad_id},
    ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if isinstance(data, dict) and str(data.get("metaAdId") or "") == meta_ad_id:
            raise HTTPException(status_code=409, detail="This Meta ad is already linked to another Albayan ad")


def _write_ad_data(conn: Any, row: Any, data: dict[str, Any]) -> dict[str, Any]:
    baseline = int(row["last_modified"])
    modified = max(now_ms(), baseline + 1)
    clean = dict(data)
    clean["id"] = str(row["id"])
    clean["_created"] = clean.get("_created") or int(row["created_at"])
    clean["_lastModified"] = modified
    clean["_deleted"] = bool(row["deleted"])
    if row.get("created_by") is not None:
        clean["createdBy"] = str(row["created_by"])
    result = conn.execute(
        text(
            "UPDATE entities SET data_json=:data,last_modified=:modified "
            "WHERE type='ads' AND id=:id AND last_modified=:baseline"
        ),
        {
            "data": json_dumps(clean),
            "modified": modified,
            "id": str(row["id"]),
            "baseline": baseline,
        },
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="Conflict: ad has changed")
    next_row = dict(row)
    next_row["last_modified"] = modified
    return _entity_from_row(next_row, clean)


def _lock_ad_row(conn: Any, ad_id: str, *, postgres: bool) -> Any:
    suffix = " FOR UPDATE" if postgres else ""
    row = conn.execute(
        text(
            "SELECT type,id,data_json,deleted,created_at,created_by,last_modified "
            "FROM entities WHERE type='ads' AND id=:id LIMIT 1" + suffix
        ),
        {"id": ad_id},
    ).mappings().first()
    if not row or bool(row["deleted"]):
        raise HTTPException(status_code=404, detail="Albayan ad not found")
    return row


def _audit(actor_id: str | None, action: str, ad_id: str, message: str, metadata: dict[str, Any]) -> None:
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO audit_logs (id,ts,user_id,action,resource_type,resource_id,message,metadata_json) "
                "VALUES (:id,:ts,:uid,:action,'ads',:resource_id,:message,:metadata)"
            ),
            {
                "id": new_id("audit"),
                "ts": now_ms(),
                "uid": actor_id or None,
                "action": action,
                "resource_id": ad_id,
                "message": message,
                "metadata": json_dumps(metadata or {}),
            },
        )


def apply_meta_snapshot(
    ad_id: str,
    snapshot: dict[str, Any],
    *,
    actor_id: str | None,
    actor_name: str,
    expected_last_modified: int | None,
    operation_id: str | None,
    action: str,
) -> tuple[dict[str, Any], bool, list[dict[str, str]]]:
    ad_id = _local_id(ad_id)
    meta_ad_id = _meta_id(snapshot.get("metaAdId"), "Meta ad")
    operation_id = _clean_text(operation_id, 120)
    op_hash = _operation_hash(action, ad_id, operation_id, meta_ad_id) if operation_id else ""
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _META_WRITE_LOCK
    changes: list[dict[str, str]] = []
    replayed = False
    with guard, db_conn() as conn:
        row = _lock_ad_row(conn, ad_id, postgres=postgres)
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            raise HTTPException(status_code=409, detail="Stored ad data is invalid")
        if operation_id and data.get("metaLastOperationId") == operation_id:
            if data.get("metaLastOperationHash") != op_hash:
                raise HTTPException(status_code=409, detail="Meta operation ID was reused for a different request")
            return _thin_ad_entity(_entity_from_row(row, data)), True, []
        if expected_last_modified is not None and int(row["last_modified"]) != int(expected_last_modified):
            raise HTTPException(status_code=409, detail="Conflict: ad has changed")
        _ensure_unique_link(conn, ad_id, meta_ad_id)
        previous_meta_ad_id = str(data.get("metaAdId") or "")
        was_linked = bool(previous_meta_ad_id)
        previous = dict(data)
        for key in META_AD_LINK_FIELDS:
            if key in snapshot:
                data[key] = snapshot[key]
        if previous_meta_ad_id != meta_ad_id:
            changes.append(
                {
                    "field": "Meta ad link",
                    "from": (
                        f"{_clean_text(previous.get('metaAdName'), 180) or 'Meta ad'} "
                        f"(#{previous_meta_ad_id})"
                        if previous_meta_ad_id
                        else "Not linked"
                    ),
                    "to": f"{_clean_text(data.get('metaAdName'), 180)} (#{meta_ad_id})",
                }
            )
        changes.extend(_meaningful_changes(previous, data))
        # Do not duplicate the name row immediately after the initial link row.
        if previous_meta_ad_id != meta_ad_id:
            changes = [changes[0], *[row for row in changes[1:] if row.get("field") != "Meta ad name"]]
        if changes:
            data["metaLastChangedAt"] = _iso_now()
            _append_history(data, changes, actor_name)
        if operation_id:
            data["metaLastOperationId"] = operation_id
            data["metaLastOperationHash"] = op_hash
        entity = _write_ad_data(conn, row, data)
    # Automatic polling can run every few minutes. Only keep an audit row when
    # something meaningful changed; an administrator's manual action is always
    # audited even when Meta returned identical values.
    if actor_id or changes:
        _audit(
            actor_id,
            "meta_link" if not was_linked else "meta_sync",
            ad_id,
            "Linked Meta ad" if not was_linked else "Synchronized Meta ad",
            {"metaAdId": meta_ad_id, "changedFields": [row["field"] for row in changes]},
        )
    return _thin_ad_entity(entity), replayed, changes


def unlink_meta_ad(
    ad_id: str,
    *,
    actor_id: str,
    actor_name: str,
    expected_last_modified: int,
    operation_id: str,
) -> tuple[dict[str, Any], bool]:
    ad_id = _local_id(ad_id)
    operation_id = _clean_text(operation_id, 120)
    op_hash = _operation_hash("unlink", ad_id, operation_id)
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _META_WRITE_LOCK
    old_meta_id = ""
    with guard, db_conn() as conn:
        row = _lock_ad_row(conn, ad_id, postgres=postgres)
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            raise HTTPException(status_code=409, detail="Stored ad data is invalid")
        if data.get("metaLastOperationId") == operation_id:
            if data.get("metaLastOperationHash") != op_hash:
                raise HTTPException(status_code=409, detail="Meta operation ID was reused for a different request")
            return _thin_ad_entity(_entity_from_row(row, data)), True
        if int(row["last_modified"]) != int(expected_last_modified):
            raise HTTPException(status_code=409, detail="Conflict: ad has changed")
        old_meta_id = str(data.get("metaAdId") or "")
        if not old_meta_id:
            raise HTTPException(status_code=409, detail="This Albayan ad is not linked to Meta")
        old_name = _clean_text(data.get("metaAdName"), 180) or old_meta_id or "Meta ad"
        for key in META_AD_LINK_FIELDS:
            data.pop(key, None)
        data["metaLinkState"] = "unlinked"
        data["metaUnlinkedAt"] = _iso_now()
        data["metaLastOperationId"] = operation_id
        data["metaLastOperationHash"] = op_hash
        _append_history(
            data,
            [{"field": "Meta ad link", "from": f"{old_name} (#{old_meta_id})", "to": "Not linked"}],
            actor_name,
        )
        entity = _write_ad_data(conn, row, data)
    _audit(actor_id, "meta_unlink", ad_id, "Unlinked Meta ad", {"metaAdId": old_meta_id})
    return _thin_ad_entity(entity), False


def _sync_failure_delay_ms(config: MetaAdsConfig, failure_count: int) -> int:
    base = config.sync_interval_minutes * 60_000
    return min(base * (2 ** min(max(failure_count - 1, 0), 4)), 6 * 60 * 60_000)


def record_meta_sync_failure(
    ad_id: str,
    error: MetaAdsError,
    *,
    expected_last_modified: int | None,
) -> dict[str, Any] | None:
    ad_id = _local_id(ad_id)
    config = load_meta_ads_config()
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _META_WRITE_LOCK
    with guard, db_conn() as conn:
        row = _lock_ad_row(conn, ad_id, postgres=postgres)
        if expected_last_modified is not None and int(row["last_modified"]) != int(expected_last_modified):
            return None
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict) or not data.get("metaAdId"):
            return None
        failures = min(max(int(data.get("metaSyncFailureCount") or 0) + 1, 1), 100)
        attempted_at = _iso_now()
        data.update(
            {
                "metaLastAttemptAt": attempted_at,
                "metaSyncError": error.public_message,
                "metaSyncErrorCode": error.code,
                "metaSyncFailureCount": failures,
                "metaNextSyncAt": now_ms() + _sync_failure_delay_ms(config, failures),
            }
        )
        return _thin_ad_entity(_write_ad_data(conn, row, data))


def _due_meta_ads(limit: int) -> list[tuple[str, int, str]]:
    current = now_ms()
    candidates: list[tuple[int, str, int, str]] = []
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT id,data_json,last_modified FROM entities WHERE type='ads' AND deleted=false")
        ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            continue
        meta_ad_id = str(data.get("metaAdId") or "")
        if not _META_ID_RE.fullmatch(meta_ad_id):
            continue
        next_sync = int(data.get("metaNextSyncAt") or 0)
        if next_sync > current:
            continue
        candidates.append((next_sync, str(row["id"]), int(row["last_modified"]), meta_ad_id))
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [(ad_id, version, meta_id) for _, ad_id, version, meta_id in candidates[: max(1, limit)]]


def sync_due_meta_ads(limit: int | None = None) -> list[dict[str, Any]]:
    config = load_meta_ads_config()
    if not config.configured:
        return []
    client = get_meta_ads_client()
    updated: list[dict[str, Any]] = []
    for ad_id, version, meta_ad_id in _due_meta_ads(limit or config.sync_batch_size):
        try:
            snapshot = client.get_ad_snapshot(meta_ad_id)
            entity, _, _ = apply_meta_snapshot(
                ad_id,
                snapshot,
                actor_id=None,
                actor_name="Meta automatic sync",
                expected_last_modified=version,
                operation_id=None,
                action="automatic_sync",
            )
            updated.append(entity)
        except HTTPException as error:
            if error.status_code != 409:
                continue
        except MetaAdsError as error:
            failed = record_meta_sync_failure(ad_id, error, expected_last_modified=version)
            if failed:
                updated.append(failed)
        except Exception:
            # Never leak third-party exception text into logs or ad data.
            failed = record_meta_sync_failure(
                ad_id,
                MetaAdsError("unexpected", "Meta synchronization failed. Albayan will retry.", retryable=True),
                expected_last_modified=version,
            )
            if failed:
                updated.append(failed)
    return updated


_WORKER_STOP = threading.Event()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_CONTROL_LOCK = threading.Lock()


def _worker_loop() -> None:
    # Give startup/migrations time to settle before the first external call.
    if _WORKER_STOP.wait(30):
        return
    while not _WORKER_STOP.is_set():
        try:
            sync_due_meta_ads()
        except Exception:
            print("[albayan] Meta Ads background sync pass failed; it will retry.")
        _WORKER_STOP.wait(60)


def start_meta_ads_worker() -> None:
    global _WORKER_THREAD
    config = load_meta_ads_config()
    if not config.configured or not config.background_sync:
        return
    with _WORKER_CONTROL_LOCK:
        if _WORKER_THREAD and _WORKER_THREAD.is_alive():
            return
        _WORKER_STOP.clear()
        _WORKER_THREAD = threading.Thread(
            target=_worker_loop,
            name="albayan-meta-ads-sync",
            daemon=True,
        )
        _WORKER_THREAD.start()
    print("[albayan] Meta Ads read-only synchronization enabled.")


def stop_meta_ads_worker() -> None:
    global _WORKER_THREAD
    with _WORKER_CONTROL_LOCK:
        thread = _WORKER_THREAD
        _WORKER_STOP.set()
        _WORKER_THREAD = None
    if thread and thread.is_alive():
        thread.join(timeout=3)


class MetaAdLinkRequest(BaseModel):
    metaAdId: str = Field(min_length=1, max_length=40, pattern=r"^[0-9]+$")
    expectedLastModified: int = Field(ge=0)
    operationId: str = Field(min_length=8, max_length=120)


class MetaAdMutationRequest(BaseModel):
    expectedLastModified: int = Field(ge=0)
    operationId: str = Field(min_length=8, max_length=120)


class MetaSyncDueRequest(BaseModel):
    limit: int = Field(default=20, ge=1, le=100)


def _rate_limit_or_429(key: str, max_attempts: int, window_ms: int) -> None:
    allowed, _, retry_after = check_rate_limit(key, max_attempts, window_ms)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many Meta synchronization requests",
            headers={"Retry-After": str(max(1, math.ceil(retry_after / 1000)))},
        )


def create_meta_ads_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    require_same_origin: Callable[[Request], None],
) -> APIRouter:
    router = APIRouter(prefix="/api/meta-ads", tags=["meta-ads"])

    def require_meta_admin(
        user: dict[str, Any] = Depends(current_user_dependency),
    ) -> dict[str, Any]:
        if str(user.get("role") or "").strip().lower() != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        return user

    def configured_client() -> MetaAdsClient:
        try:
            return get_meta_ads_client()
        except MetaAdsError as error:
            raise HTTPException(status_code=503, detail=error.public_message)

    @router.on_event("startup")
    def _start_worker() -> None:
        start_meta_ads_worker()

    @router.on_event("shutdown")
    def _stop_worker() -> None:
        stop_meta_ads_worker()

    @router.get("/status")
    def meta_status(admin: dict[str, Any] = Depends(require_meta_admin)):
        config = load_meta_ads_config()
        return {
            "configured": config.configured,
            "readOnly": True,
            "graphApiVersion": config.graph_version,
            "allowedAccountCount": len(config.allowed_account_ids),
            "backgroundSync": config.background_sync and config.configured,
            "syncIntervalMinutes": config.sync_interval_minutes,
            "message": "Meta Ads read-only synchronization is ready" if config.configured else "Add the Meta server credentials in Jelastic to enable synchronization",
        }

    @router.get("/accounts")
    def meta_accounts(admin: dict[str, Any] = Depends(require_meta_admin)):
        _rate_limit_or_429(f"meta-accounts:{admin.get('id')}", 30, 60_000)
        try:
            return {"accounts": configured_client().list_accounts()}
        except MetaAdsError as error:
            raise HTTPException(status_code=502 if error.retryable else 400, detail=error.public_message)

    @router.get("/accounts/{account_id}/ads")
    def meta_account_ads(
        account_id: str,
        search: str = Query(default="", max_length=100),
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        _rate_limit_or_429(f"meta-list:{admin.get('id')}", 30, 60_000)
        try:
            return {"ads": configured_client().list_ads(account_id, search)}
        except MetaAdsError as error:
            raise HTTPException(status_code=502 if error.retryable else 400, detail=error.public_message)

    @router.post("/ads/{ad_id}/link")
    def link_ad(
        ad_id: str,
        body: MetaAdLinkRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        _rate_limit_or_429(f"meta-write:{admin.get('id')}", 60, 60_000)
        try:
            snapshot = configured_client().get_ad_snapshot(body.metaAdId)
            entity, replayed, changes = apply_meta_snapshot(
                ad_id,
                snapshot,
                actor_id=str(admin.get("id") or ""),
                actor_name=_clean_text(admin.get("name"), 120) or "Admin",
                expected_last_modified=body.expectedLastModified,
                operation_id=body.operationId,
                action="link",
            )
            return {"ad": entity, "replayed": replayed, "changes": changes}
        except MetaAdsError as error:
            raise HTTPException(status_code=502 if error.retryable else 400, detail=error.public_message)

    @router.post("/ads/{ad_id}/sync")
    def sync_ad(
        ad_id: str,
        body: MetaAdMutationRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        _rate_limit_or_429(f"meta-write:{admin.get('id')}", 60, 60_000)
        local_id = _local_id(ad_id)
        with db_conn() as conn:
            row = conn.execute(
                text("SELECT data_json FROM entities WHERE type='ads' AND id=:id AND deleted=false LIMIT 1"),
                {"id": local_id},
            ).mappings().first()
        data = json_loads(row.get("data_json") or "{}") if row else {}
        if not isinstance(data, dict) or not data.get("metaAdId"):
            raise HTTPException(status_code=409, detail="This Albayan ad is not linked to Meta")
        try:
            snapshot = configured_client().get_ad_snapshot(data.get("metaAdId"))
            entity, replayed, changes = apply_meta_snapshot(
                local_id,
                snapshot,
                actor_id=str(admin.get("id") or ""),
                actor_name=_clean_text(admin.get("name"), 120) or "Admin",
                expected_last_modified=body.expectedLastModified,
                operation_id=body.operationId,
                action="sync",
            )
            return {"ad": entity, "replayed": replayed, "changes": changes}
        except MetaAdsError as error:
            record_meta_sync_failure(local_id, error, expected_last_modified=body.expectedLastModified)
            raise HTTPException(status_code=502 if error.retryable else 400, detail=error.public_message)

    @router.post("/ads/{ad_id}/unlink")
    def unlink_ad(
        ad_id: str,
        body: MetaAdMutationRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        _rate_limit_or_429(f"meta-write:{admin.get('id')}", 60, 60_000)
        entity, replayed = unlink_meta_ad(
            ad_id,
            actor_id=str(admin.get("id") or ""),
            actor_name=_clean_text(admin.get("name"), 120) or "Admin",
            expected_last_modified=body.expectedLastModified,
            operation_id=body.operationId,
        )
        return {"ad": entity, "replayed": replayed}

    @router.post("/sync-due")
    def sync_due(
        body: MetaSyncDueRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        _rate_limit_or_429(f"meta-sync-due:{admin.get('id')}", 6, 60_000)
        if not load_meta_ads_config().configured:
            raise HTTPException(status_code=503, detail="Meta Ads connection is not configured")
        return {"ads": sync_due_meta_ads(body.limit)}

    return router
