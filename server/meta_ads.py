"""Read-only Meta Marketing API integration for Albayan ads.

The integration deliberately keeps Meta's live delivery facts in dedicated
``meta*`` fields.  It never rewrites Albayan's customer, receipt, payment,
exchange-rate, or accounting status fields.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import threading
import time
import unicodedata
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
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
_META_DISCOVERY_LOCK = threading.Lock()
_META_REMOTE_BACKOFF_LOCK = threading.Lock()
_META_REMOTE_BACKOFF_UNTIL = 0.0
_META_IMPORT_STATE_TYPE = "metaImportState"
_META_IMPORT_STATE_ID = "automatic"
_META_IMPORT_MAX_KNOWN_IDS = 100_000
_META_MEDIA_VERSION = 4
_META_DISCOVERABLE_EFFECTIVE_STATUSES = (
    "ACTIVE",
    "PAUSED",
    "ADSET_PAUSED",
    "CAMPAIGN_PAUSED",
    "PENDING_REVIEW",
    "PREAPPROVED",
    "PENDING_BILLING_INFO",
    "IN_PROCESS",
    "WITH_ISSUES",
    "DISAPPROVED",
)


def _meta_remote_backoff_remaining() -> int:
    with _META_REMOTE_BACKOFF_LOCK:
        remaining = _META_REMOTE_BACKOFF_UNTIL - time.monotonic()
    return max(0, int(math.ceil(remaining)))


def _set_meta_remote_backoff(seconds: Any = 60) -> None:
    global _META_REMOTE_BACKOFF_UNTIL
    try:
        delay = min(max(int(float(seconds or 60)), 30), 15 * 60)
    except (TypeError, ValueError, OverflowError):
        delay = 60
    with _META_REMOTE_BACKOFF_LOCK:
        _META_REMOTE_BACKOFF_UNTIL = max(
            _META_REMOTE_BACKOFF_UNTIL, time.monotonic() + delay
        )


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
        "metaCreativeId",
        "metaThumbnailUrl",
        "metaThumbnailSource",
        "metaMediaVersion",
        "metaMediaResolvedAt",
        "metaPageId",
        "metaPageName",
        "metaPageCategory",
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
        "metaTotalBudgetMinor",
        "metaTotalBudgetKind",
        "metaBudgetRemainingMinor",
        "metaTotalRemainingBudgetMinor",
        "metaStartTime",
        "metaEndTime",
        "metaDurationDays",
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
    | {
        "metaLastOperationId",
        "metaLastOperationHash",
        "metaImportState",
        "metaImportedAt",
        "metaImportCompletedAt",
        "metaImportSource",
        "metaChangeHistory",
        "metaChangeCount",
        "metaActivityCursorAt",
        "metaActivityLastCheckedAt",
    }
)

# A page identity learned from Meta is server-controlled for the same reason as
# a linked ad ID: allowing an ordinary browser request to forge it would defeat
# duplicate protection and could silently attach future ads to the wrong page.
META_PAGE_SERVER_FIELDS = frozenset(
    {
        "metaPageId",
        "metaPageName",
        "metaPageCategory",
        "metaImportState",
        "metaImportedAt",
        "metaImportSource",
    }
)

_HISTORY_FIELDS: tuple[tuple[str, str], ...] = (
    ("metaAdName", "Meta ad name"),
    ("metaCreativeId", "Meta creative"),
    ("metaCampaignName", "Meta campaign"),
    ("metaAdSetName", "Meta ad set"),
    ("metaAdAccountName", "Meta ad account"),
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


def _clean_https_url(value: Any) -> str:
    """Return a bounded public HTTPS URL suitable for a browser image source."""
    candidate = _clean_text(value, 2048)
    if not candidate:
        return ""
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    hostname = str(parsed.hostname or "").strip().lower()
    if parsed.scheme.lower() != "https" or not hostname or parsed.username or parsed.password:
        return ""
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return ""
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        return ""
    return candidate


def _cdn_asset_key(value: Any) -> str:
    """Stable media-file key of an fbcdn URL, ignoring signing/size params.

    Two signed fbcdn URLs for the same underlying photo keep the same file
    name in the path while every query parameter differs. Comparing this key
    is how the sync detects that Meta's generic creative thumbnail is really
    the Page profile picture (the wrong-photo problem) without ever
    downloading either image.
    """
    url = _clean_https_url(value)
    if not url:
        return ""
    try:
        path = urlsplit(url).path
    except ValueError:
        return ""
    name = path.rsplit("/", 1)[-1].strip().lower()
    # Very short names ("picture", "image.php") are not unique assets.
    return name if len(name) >= 12 and "_" in name else ""


def _duration_days(start_value: Any, end_value: Any) -> int:
    start = _clean_time(start_value)
    end = _clean_time(end_value)
    if not start or not end:
        return 0
    try:
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return 0
    seconds = (end_dt - start_dt).total_seconds()
    if seconds <= 0:
        return 0
    return min(max(1, int(math.ceil(seconds / 86400))), 36500)


def _planned_budget(daily_minor: Any, lifetime_minor: Any, duration_days: Any) -> tuple[int, str]:
    lifetime = _minor_units(lifetime_minor)
    if lifetime:
        return lifetime, "lifetime"
    daily = _minor_units(daily_minor)
    try:
        days = min(max(int(duration_days or 0), 0), 36500)
    except (TypeError, ValueError, OverflowError):
        days = 0
    if daily and days:
        return min(daily * days, 100_000_000_000), "estimated_daily"
    return 0, "open_ended" if daily else ""


def _total_remaining_budget(total_minor: Any, spend_minor: Any) -> int:
    """Return remaining money for the whole planned run, never a daily remainder."""
    total = _minor_units(total_minor)
    if not total:
        return 0
    return max(total - _minor_units(spend_minor), 0)


def _story_object_id(creative: dict[str, Any]) -> str:
    for key in ("effective_object_story_id", "object_story_id"):
        candidate = _clean_text(creative.get(key), 100)
        if re.fullmatch(r"[0-9]{1,40}_[0-9]{1,40}", candidate):
            return candidate
    return ""


def _creative_thumbnail_url(
    creative: dict[str, Any],
    story_spec: dict[str, Any],
    *,
    include_generic_thumbnail: bool = True,
) -> str:
    """Choose advertiser media before Meta's generic creative thumbnail.

    ``thumbnail_url`` is not reliable for an existing Page post: Meta can
    return the Page/profile image there. The explicit story and asset-feed
    media are closer to the picture/video/carousel the customer actually sees,
    so the generic thumbnail is deliberately the final fallback only.
    """
    candidates: list[Any] = []
    for key in ("link_data", "video_data", "photo_data", "template_data"):
        block = story_spec.get(key) if isinstance(story_spec.get(key), dict) else {}
        child_rows = (
            block.get("child_attachments")
            if isinstance(block.get("child_attachments"), list)
            else []
        )
        for child in child_rows:
            if isinstance(child, dict):
                candidates.extend(
                    [
                        child.get("image_url"),
                        child.get("picture"),
                        child.get("thumbnail_url"),
                    ]
                )
        candidates.extend(
            [
                block.get("image_url"),
                block.get("picture"),
                block.get("thumbnail_url"),
            ]
        )
    asset_feed = (
        creative.get("asset_feed_spec")
        if isinstance(creative.get("asset_feed_spec"), dict)
        else {}
    )
    for key in ("images", "videos"):
        rows = asset_feed.get(key) if isinstance(asset_feed.get(key), list) else []
        for row in rows:
            if isinstance(row, dict):
                candidates.extend(
                    [
                        row.get("url"),
                        row.get("image_url"),
                        row.get("picture"),
                        row.get("thumbnail_url"),
                    ]
                )
    candidates.append(creative.get("image_url"))
    if include_generic_thumbnail:
        candidates.append(creative.get("thumbnail_url"))
    for value in candidates:
        safe = _clean_https_url(value)
        if safe:
            return safe
    return ""


def _creative_image_hashes(
    creative: dict[str, Any], story_spec: dict[str, Any]
) -> list[str]:
    """Collect advertiser image hashes that can be resolved via the ad account."""
    candidates: list[Any] = [creative.get("image_hash")]
    for key in ("link_data", "video_data", "photo_data", "template_data"):
        block = story_spec.get(key) if isinstance(story_spec.get(key), dict) else {}
        candidates.append(block.get("image_hash"))
        child_rows = (
            block.get("child_attachments")
            if isinstance(block.get("child_attachments"), list)
            else []
        )
        for child in child_rows:
            if isinstance(child, dict):
                candidates.append(child.get("image_hash"))
    asset_feed = (
        creative.get("asset_feed_spec")
        if isinstance(creative.get("asset_feed_spec"), dict)
        else {}
    )
    for row in asset_feed.get("images") or []:
        if isinstance(row, dict):
            candidates.append(row.get("hash") or row.get("image_hash"))
    result: list[str] = []
    for value in candidates:
        candidate = _clean_text(value, 128)
        if re.fullmatch(r"[A-Fa-f0-9]{16,128}", candidate) and candidate not in result:
            result.append(candidate)
    return result[:20]


def _creative_video_ids(
    creative: dict[str, Any], story_spec: dict[str, Any]
) -> list[str]:
    candidates: list[Any] = [creative.get("video_id")]
    video_data = (
        story_spec.get("video_data")
        if isinstance(story_spec.get("video_data"), dict)
        else {}
    )
    candidates.append(video_data.get("video_id"))
    asset_feed = (
        creative.get("asset_feed_spec")
        if isinstance(creative.get("asset_feed_spec"), dict)
        else {}
    )
    for row in asset_feed.get("videos") or []:
        if isinstance(row, dict):
            candidates.append(row.get("video_id"))
    result: list[str] = []
    for value in candidates:
        candidate = _clean_text(value, 40)
        if _META_ID_RE.fullmatch(candidate) and candidate not in result:
            result.append(candidate)
    return result[:10]


def _story_media_url(post: dict[str, Any]) -> str:
    """Extract the first real media attachment from a resolved Page post."""
    candidates: list[Any] = [post.get("full_picture")]
    attachments = (
        post.get("attachments") if isinstance(post.get("attachments"), dict) else {}
    )

    def add_attachment(row: Any) -> None:
        if not isinstance(row, dict):
            return
        media = row.get("media") if isinstance(row.get("media"), dict) else {}
        image = media.get("image") if isinstance(media.get("image"), dict) else {}
        candidates.extend(
            [
                image.get("src"),
                row.get("image_url"),
                row.get("picture"),
            ]
        )
        subattachments = (
            row.get("subattachments")
            if isinstance(row.get("subattachments"), dict)
            else {}
        )
        for child in subattachments.get("data") or []:
            add_attachment(child)

    for attachment in attachments.get("data") or []:
        add_attachment(attachment)
    for value in candidates:
        safe = _clean_https_url(value)
        if safe:
            return safe
    return ""


def _story_page_identity(post: dict[str, Any]) -> tuple[str, str]:
    """Read the Page ID/name supplied with a resolved promoted Page post."""
    actor = post.get("from") if isinstance(post.get("from"), dict) else {}
    page_id = _clean_text(actor.get("id"), 40)
    if not _META_ID_RE.fullmatch(page_id):
        page_id = ""
    return page_id, _clean_text(actor.get("name"), 240)


def _video_thumbnail_url(video: dict[str, Any]) -> str:
    candidates: list[tuple[int, Any]] = []
    thumbnails = (
        video.get("thumbnails")
        if isinstance(video.get("thumbnails"), dict)
        else {}
    )
    for row in thumbnails.get("data") or []:
        if not isinstance(row, dict):
            continue
        try:
            area = int(row.get("width") or 0) * int(row.get("height") or 0)
        except (TypeError, ValueError, OverflowError):
            area = 0
        if row.get("is_preferred"):
            area += 1_000_000_000
        candidates.append((area, row.get("uri") or row.get("url")))
    candidates.append((0, video.get("picture")))
    for _, value in sorted(candidates, key=lambda item: item[0], reverse=True):
        safe = _clean_https_url(value)
        if safe:
            return safe
    return ""


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
    auto_import: bool = True
    discovery_interval_seconds: int = 60
    discovery_fast_pages: int = 1
    discovery_baseline_pages: int = 25
    worker_sync_interval_seconds: int = 10
    webhook_verify_token: str = field(default="", repr=False)

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
    auto_import_raw = os.getenv("ALBAYAN_META_AUTO_IMPORT")
    auto_import = True if auto_import_raw is None else auto_import_raw.strip().lower() in _TRUE_VALUES
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
            # A snapshot can require several Graph reads. Small, paced batches
            # keep automatic refresh from starving the lightweight new-ad
            # discovery pass or tripping Meta's business-use-case limit.
            os.getenv("ALBAYAN_META_SYNC_BATCH_SIZE"), 2, 1, 20
        ),
        request_timeout_seconds=_bounded_int(
            os.getenv("ALBAYAN_META_REQUEST_TIMEOUT_SECONDS"), 15, 5, 60
        ),
        auto_import=auto_import,
        discovery_interval_seconds=_bounded_int(
            os.getenv("ALBAYAN_META_DISCOVERY_INTERVAL_SECONDS"), 60, 30, 3600
        ),
        discovery_fast_pages=_bounded_int(
            os.getenv("ALBAYAN_META_DISCOVERY_FAST_PAGES"), 1, 1, 3
        ),
        discovery_baseline_pages=_bounded_int(
            os.getenv("ALBAYAN_META_DISCOVERY_BASELINE_PAGES"), 25, 5, 100
        ),
        worker_sync_interval_seconds=_bounded_int(
            os.getenv("ALBAYAN_META_WORKER_SYNC_INTERVAL_SECONDS"), 10, 5, 60
        ),
        webhook_verify_token=(
            os.getenv("ALBAYAN_META_WEBHOOK_VERIFY_TOKEN") or ""
        ).strip(),
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
        self._account_page_cache: dict[str, dict[str, dict[str, str]]] = {}
        self._page_avatar_key_cache: dict[str, str] = {}

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
            _set_meta_remote_backoff(response.headers.get("Retry-After") or 60)
            return MetaAdsError("rate_limited", "Meta is temporarily limiting synchronization. Albayan will retry.", retryable=True)
        # Graph codes 1 ("unknown"/"please reduce the amount of data") and 2
        # ("service temporarily unavailable") are transient in practice. They
        # must keep the short retry clock, otherwise one hiccup parks an ad's
        # photos and page name behind a multi-hour backoff.
        if (
            status >= 500
            or code in {"1", "2"}
            or (isinstance(error, dict) and error.get("is_transient") is True)
        ):
            return MetaAdsError("temporary", "Meta is temporarily unavailable. Albayan will retry.", retryable=True)
        return MetaAdsError("request_failed", "Meta could not return the requested ad information.")

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if _meta_remote_backoff_remaining():
            raise MetaAdsError(
                "rate_limited",
                "Meta is temporarily limiting synchronization. Albayan will retry.",
                retryable=True,
            )
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

    def _get_account_page_identity(
        self, account_id: Any, page_id: Any
    ) -> dict[str, str]:
        """Resolve Page names through the ad account without needing Page assets.

        A read-only system user can often read an ad's Page through the ad
        account's ``promote_pages`` edge even when reading the Page node or
        Page post directly is denied. The result is cached per account so a
        batch of ads costs at most one optional Graph request.
        """

        normalized_account = self._ensure_allowed_account(account_id)
        normalized_page = _clean_text(page_id, 40)
        if not _META_ID_RE.fullmatch(normalized_page):
            return {}
        if normalized_account not in self._account_page_cache:
            identities: dict[str, dict[str, str]] = {}
            try:
                rows = self._paged(
                    f"act_{normalized_account}/promote_pages",
                    {"fields": "id,name,category", "limit": 100},
                    max_pages=10,
                )
            except MetaAdsError:
                rows = []
            for row in rows:
                candidate_id = _clean_text(row.get("id"), 40)
                if not _META_ID_RE.fullmatch(candidate_id):
                    continue
                identities[candidate_id] = {
                    "id": candidate_id,
                    "name": _clean_text(row.get("name"), 240),
                    "category": _clean_text(row.get("category"), 160),
                }
            self._account_page_cache[normalized_account] = identities
        return dict(self._account_page_cache[normalized_account].get(normalized_page) or {})

    def list_ads(
        self, account_id: Any, search: str = "", *, max_pages: int = 5
    ) -> list[dict[str, Any]]:
        normalized_account = self._ensure_allowed_account(account_id)
        pages = min(max(int(max_pages or 5), 1), 100)
        base_params = {
            # Meta can omit ads that are still being reviewed when an ads
            # edge is read without an explicit effective-status filter.
            # Albayan must discover those new objects too, but should not
            # resurrect deleted or archived history.
            "effective_status": json.dumps(
                list(_META_DISCOVERABLE_EFFECTIVE_STATUSES),
                separators=(",", ":"),
            ),
            "limit": 100,
        }
        try:
            rows = self._paged(
                f"act_{normalized_account}/ads",
                {
                    **base_params,
                    # Field expansion keeps the fast discovery pass to one request
                    # per account while still carrying enough information to make
                    # a useful, accounting-neutral Albayan draft immediately.
                    "fields": (
                        "id,name,status,effective_status,configured_status,account_id,"
                        "adset_id,campaign_id,created_time,updated_time,"
                        "adset{id,name,status,effective_status,daily_budget,lifetime_budget,"
                        "budget_remaining,start_time,end_time},"
                        "campaign{id,name,status,effective_status,daily_budget,lifetime_budget,"
                        "budget_remaining,start_time,stop_time,objective,buying_type},"
                        "creative{id,name,thumbnail_url,image_url,image_hash,video_id,object_id,"
                        "object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec}"
                    ),
                },
                max_pages=pages,
            )
        except MetaAdsError as error:
            if error.code not in {"request_failed", "response_too_large", "temporary"}:
                raise
            # Meta sometimes rejects the heavy expansion outright ("please
            # reduce the amount of data you're asking for"). Finding every ad
            # matters more than inline details, so fall back to the slim ad
            # list with smaller pages; the paced enrichment pass fills in
            # budgets, media and page names shortly afterwards.
            rows = self._paged(
                f"act_{normalized_account}/ads",
                {
                    **base_params,
                    "limit": 50,
                    "fields": (
                        "id,name,status,effective_status,configured_status,account_id,"
                        "adset_id,campaign_id,created_time,updated_time"
                    ),
                },
                max_pages=pages,
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
            creative = row.get("creative") if isinstance(row.get("creative"), dict) else {}
            story_spec = (
                creative.get("object_story_spec")
                if isinstance(creative.get("object_story_spec"), dict)
                else {}
            )
            story_object_id = _story_object_id(creative)
            page_id = _clean_text(story_spec.get("page_id"), 40)
            if not _META_ID_RE.fullmatch(page_id):
                page_id = ""
            if not page_id:
                for story_key in ("effective_object_story_id", "object_story_id"):
                    story_id = _clean_text(creative.get(story_key), 100)
                    candidate = story_id.split("_", 1)[0] if "_" in story_id else ""
                    if _META_ID_RE.fullmatch(candidate):
                        page_id = candidate
                        break
            # The ad account's promoted-pages directory is one cached request
            # per account and usually knows the real Page name immediately, so
            # a brand-new import never has to show "Facebook Page 123…".
            page_name = ""
            page_category = ""
            if page_id:
                identity = self._get_account_page_identity(normalized_account, page_id)
                page_name = _clean_text(identity.get("name"), 240)
                page_category = _clean_text(identity.get("category"), 160)
            daily_budget = _minor_units(
                adset.get("daily_budget") or campaign.get("daily_budget")
            )
            lifetime_budget = _minor_units(
                adset.get("lifetime_budget") or campaign.get("lifetime_budget")
            )
            start_time = _clean_time(
                adset.get("start_time") or campaign.get("start_time")
            )
            end_time = _clean_time(
                adset.get("end_time") or campaign.get("stop_time")
            )
            duration_days = _duration_days(start_time, end_time)
            total_budget, total_budget_kind = _planned_budget(
                daily_budget, lifetime_budget, duration_days
            )
            item = {
                "id": ad_id,
                "name": _clean_text(row.get("name"), 240) or f"Meta ad {ad_id}",
                "status": _clean_text(row.get("configured_status") or row.get("status"), 40),
                "effectiveStatus": _clean_text(row.get("effective_status"), 40),
                "adSetId": _clean_text(row.get("adset_id") or adset.get("id"), 40),
                "adSetName": _clean_text(adset.get("name"), 240),
                "campaignId": _clean_text(row.get("campaign_id") or campaign.get("id"), 40),
                "campaignName": _clean_text(campaign.get("name"), 240),
                "creativeId": _clean_text(creative.get("id"), 40),
                # Existing-post thumbnails need the post attachment lookup in
                # the paced enrichment pass. Showing nothing for a few seconds
                # is safer than displaying Meta's generic Page/profile logo.
                "thumbnailUrl": _creative_thumbnail_url(
                    creative,
                    story_spec,
                    include_generic_thumbnail=not bool(story_object_id),
                ),
                "pageId": page_id,
                "pageName": page_name,
                "pageCategory": page_category,
                "accountId": normalized_account,
                "adSetStatus": _clean_text(
                    adset.get("effective_status") or adset.get("status"), 40
                ),
                "campaignStatus": _clean_text(
                    campaign.get("effective_status") or campaign.get("status"), 40
                ),
                "dailyBudgetMinor": daily_budget,
                "lifetimeBudgetMinor": lifetime_budget,
                "totalBudgetMinor": total_budget,
                "totalBudgetKind": total_budget_kind,
                "budgetRemainingMinor": _minor_units(
                    adset.get("budget_remaining")
                    or campaign.get("budget_remaining")
                ),
                "budgetSource": (
                    "adset"
                    if any(
                        adset.get(key) not in (None, "")
                        for key in ("daily_budget", "lifetime_budget")
                    )
                    else "campaign"
                ),
                "startTime": start_time,
                "endTime": end_time,
                "durationDays": duration_days,
                "createdTime": _clean_time(row.get("created_time")),
                "updatedTime": _clean_time(row.get("updated_time")),
            }
            haystack = " ".join(str(item.get(key) or "") for key in ("id", "name", "adSetName", "campaignName")).casefold()
            if needle and needle not in haystack:
                continue
            result.append(item)
        return result[: min(max(int(max_pages or 5), 1), 100) * 100]

    def list_account_activities(
        self,
        account_id: Any,
        *,
        object_ids: list[str] | tuple[str, ...] = (),
        since: Any = "",
        until: Any = "",
        max_pages: int = 5,
    ) -> list[dict[str, Any]]:
        """Read Meta's own edit activity log once for a group of related ads."""
        normalized_account = self._ensure_allowed_account(account_id)
        params: dict[str, Any] = {
            "fields": (
                "actor_id,actor_name,application_id,application_name,"
                "date_time_in_timezone,event_time,event_type,extra_data,"
                "object_id,object_name,object_type,tool,translated_event_type"
            ),
            "limit": 100,
        }
        safe_ids = []
        for value in object_ids:
            candidate = _clean_text(value, 40)
            if _META_ID_RE.fullmatch(candidate) and candidate not in safe_ids:
                safe_ids.append(candidate)
        if safe_ids:
            params["extra_oids"] = json.dumps(safe_ids[:100], separators=(",", ":"))
        for key, raw_value in (("since", since), ("until", until)):
            cleaned = _clean_time(raw_value)
            if not cleaned:
                continue
            try:
                parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
            except ValueError:
                continue
            params[key] = int(parsed.timestamp())
        rows = self._paged(
            f"act_{normalized_account}/activities",
            params,
            max_pages=min(max(int(max_pages or 5), 1), 10),
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            event_type = _clean_text(row.get("event_type"), 120)
            event_time = _clean_time(
                row.get("event_time") or row.get("date_time_in_timezone")
            )
            object_id = _clean_text(row.get("object_id"), 40)
            if not event_type or not event_time or not _META_ID_RE.fullmatch(object_id):
                continue
            extra_data = _clean_text(row.get("extra_data"), 2000)
            fingerprint = "\0".join(
                (
                    normalized_account,
                    object_id,
                    event_time,
                    event_type,
                    _clean_text(row.get("actor_id"), 80),
                    extra_data,
                )
            )
            result.append(
                {
                    "eventId": hashlib.sha256(fingerprint.encode("utf-8")).hexdigest(),
                    "eventTime": event_time,
                    "eventType": event_type,
                    "eventLabel": _clean_text(row.get("translated_event_type"), 240),
                    "actorId": _clean_text(row.get("actor_id"), 80),
                    "actorName": _clean_text(row.get("actor_name"), 160),
                    "applicationName": _clean_text(row.get("application_name"), 160),
                    "objectId": object_id,
                    "objectName": _clean_text(row.get("object_name"), 240),
                    "objectType": _clean_text(row.get("object_type"), 80),
                    "tool": _clean_text(row.get("tool"), 120),
                    "extraData": extra_data,
                }
            )
        result.sort(key=lambda item: (item["eventTime"], item["eventId"]))
        return result

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

    def _get_ad_image_url(
        self, account_id: str, image_hashes: list[str]
    ) -> str:
        """Resolve the original advertiser image through the allowed ad account."""
        wanted = [
            value
            for value in image_hashes[:20]
            if re.fullmatch(r"[A-Fa-f0-9]{16,128}", value)
        ]
        if not wanted:
            return ""
        payload = self._get(
            f"act_{self._ensure_allowed_account(account_id)}/adimages",
            {
                "fields": "hash,url,url_128,width,height,name",
                "hashes": json.dumps(wanted, separators=(",", ":")),
                "limit": min(len(wanted), 20),
            },
        )
        rows = payload.get("data") if isinstance(payload.get("data"), list) else []
        by_hash = {
            _clean_text(row.get("hash"), 128): row
            for row in rows
            if isinstance(row, dict)
        }
        for image_hash in wanted:
            row = by_hash.get(image_hash) or {}
            for key in ("url", "url_128"):
                safe = _clean_https_url(row.get(key))
                if safe:
                    return safe
        return ""

    def _get_video_thumbnail_url(self, video_ids: list[str]) -> str:
        for video_id in video_ids[:10]:
            try:
                video = self._get(
                    _meta_id(video_id, "Meta video"),
                    {
                        "fields": (
                            "id,picture,"
                            "thumbnails.limit(20){uri,is_preferred,width,height}"
                        )
                    },
                )
            except MetaAdsError:
                continue
            media_url = _video_thumbnail_url(video)
            if media_url:
                return media_url
        return ""

    def _get_object_media_url(self, object_id: Any) -> str:
        """Resolve the promoted photo node when the Page post is unreadable.

        For a boosted photo post, ``creative.object_id`` is the photo itself
        and is sometimes readable even when the post edge is denied. Best
        effort only: any failure simply falls through to the next source.
        """
        candidate = _clean_text(object_id, 40)
        if not _META_ID_RE.fullmatch(candidate):
            return ""
        try:
            node = self._get(candidate, {"fields": "id,images,picture"})
        except MetaAdsError:
            return ""
        best = ""
        best_area = -1
        images = node.get("images") if isinstance(node.get("images"), list) else []
        for row in images[:25]:
            if not isinstance(row, dict):
                continue
            safe = _clean_https_url(row.get("source"))
            if not safe:
                continue
            try:
                area = int(row.get("width") or 0) * int(row.get("height") or 0)
            except (TypeError, ValueError, OverflowError):
                area = 0
            if area > best_area:
                best, best_area = safe, area
        return best or _clean_https_url(node.get("picture"))

    def _get_page_avatar_key(self, page_id: Any) -> str | None:
        """CDN asset key of the Page profile picture, cached per page.

        Returns ``None`` when the avatar could not be read. Failures are
        deliberately NOT cached: one transient Meta limit must not poison the
        avatar check for every other ad of the same page in this batch.
        """
        candidate = _clean_text(page_id, 40)
        if not _META_ID_RE.fullmatch(candidate):
            return None
        if candidate in self._page_avatar_key_cache:
            return self._page_avatar_key_cache[candidate]
        try:
            payload = self._get(
                f"{candidate}/picture", {"redirect": "0", "type": "normal"}
            )
        except MetaAdsError:
            return None
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        key = _cdn_asset_key(data.get("url"))
        if not key:
            return None
        self._page_avatar_key_cache[candidate] = key
        return key

    def get_ad_snapshot(self, ad_id: Any) -> dict[str, Any]:
        ad_id = _meta_id(ad_id, "Meta ad")
        try:
            ad = self._get(
                ad_id,
                {
                    "fields": (
                        "id,name,status,effective_status,configured_status,adset_id,"
                        "campaign_id,account_id,created_time,updated_time,"
                        "adset{id,name,status,effective_status,daily_budget,lifetime_budget,"
                        "budget_remaining,start_time,end_time,optimization_goal,billing_event},"
                        "campaign{id,name,status,effective_status,daily_budget,lifetime_budget,"
                        "budget_remaining,start_time,stop_time,objective,buying_type},"
                        "creative{id,name,thumbnail_url,image_url,image_hash,video_id,object_id,"
                        "object_story_id,effective_object_story_id,object_story_spec,asset_feed_spec},"
                        "insights.date_preset(maximum){spend,reach,impressions,clicks,actions}"
                    )
                },
            )
        except MetaAdsError as error:
            if error.code not in {"request_failed", "response_too_large", "temporary"}:
                raise
            # Meta occasionally rejects the combined expansion for one ad
            # ("please reduce the amount of data"). The photos, page name and
            # budgets of that ad must not be lost to that: fall back to the
            # slim core read and let the dedicated adset/campaign/creative/
            # insights lookups below fill in every remaining detail.
            ad = self._get(
                ad_id,
                {
                    "fields": (
                        "id,name,status,effective_status,configured_status,adset_id,"
                        "campaign_id,account_id,created_time,updated_time,creative{id}"
                    )
                },
            )
        account_id = self._ensure_allowed_account(ad.get("account_id"))
        account = self._get_account(account_id)
        embedded_adset = ad.get("adset") if isinstance(ad.get("adset"), dict) else {}
        embedded_campaign = (
            ad.get("campaign") if isinstance(ad.get("campaign"), dict) else {}
        )
        adset_id = _meta_id(
            ad.get("adset_id") or embedded_adset.get("id"), "Meta ad set"
        )
        campaign_id = _meta_id(
            ad.get("campaign_id") or embedded_campaign.get("id"), "Meta campaign"
        )
        adset = embedded_adset
        if not adset.get("name"):
            adset = self._get(
                adset_id,
                {
                    "fields": "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,optimization_goal,billing_event"
                },
            )
        campaign = embedded_campaign
        if not campaign.get("name"):
            campaign = self._get(
                campaign_id,
                {
                    "fields": "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,objective,buying_type"
                },
            )
        creative = ad.get("creative") if isinstance(ad.get("creative"), dict) else {}
        creative_id = ""
        try:
            if creative.get("id"):
                creative_id = _meta_id(creative.get("id"), "Meta creative")
        except MetaAdsError:
            creative_id = ""
        inline_story_spec = (
            creative.get("object_story_spec")
            if isinstance(creative.get("object_story_spec"), dict)
            else {}
        )
        creative_details_attempted = False
        if creative_id and (
            not (creative.get("thumbnail_url") or creative.get("image_url"))
            or not inline_story_spec
        ):
            # Meta's creative node exposes the same thumbnail used in Ads
            # Manager. It is optional and must never make core ad sync fail.
            creative_details_attempted = True
            try:
                creative_details = self._get(
                    creative_id,
                    {
                        "fields": (
                            "id,name,thumbnail_url,image_url,image_hash,video_id,object_id,"
                            "object_story_id,effective_object_story_id,object_story_spec,"
                            "asset_feed_spec"
                        ),
                        "thumbnail_width": 512,
                        "thumbnail_height": 512,
                    },
                )
                creative = {**creative, **creative_details}
            except MetaAdsError:
                pass
        story_spec = (
            creative.get("object_story_spec")
            if isinstance(creative.get("object_story_spec"), dict)
            else {}
        )
        story_object_id = _story_object_id(creative)
        story_media_url = ""
        story_page_id = ""
        story_page_name = ""
        if story_object_id:
            # For an existing Page post this is the authoritative displayed
            # media. Meta's creative.thumbnail_url can instead be the Page
            # avatar, which is exactly the wrong-photo problem reported by the
            # user. This lookup is best-effort and paced by the sync worker.
            try:
                post = self._get(
                    story_object_id,
                    {
                        "fields": (
                            "id,full_picture,from{id,name},"
                            "attachments.limit(1){media,subattachments.limit(10){media}}"
                        )
                    },
                )
                story_media_url = _story_media_url(post)
                story_page_id, story_page_name = _story_page_identity(post)
            except MetaAdsError:
                pass
        page_id = _clean_text(story_spec.get("page_id"), 40)
        if not _META_ID_RE.fullmatch(page_id):
            page_id = ""
        if not page_id:
            for story_key in ("effective_object_story_id", "object_story_id"):
                story_id = _clean_text(creative.get(story_key), 100)
                candidate = story_id.split("_", 1)[0] if "_" in story_id else ""
                if _META_ID_RE.fullmatch(candidate):
                    page_id = candidate
                    break
        if not page_id and story_page_id:
            page_id = story_page_id
        page_name = story_page_name
        page_category = ""
        if page_id:
            account_page = self._get_account_page_identity(account_id, page_id)
            if not page_name:
                page_name = _clean_text(account_page.get("name"), 240)
            page_category = _clean_text(account_page.get("category"), 160)
            # Page metadata is best-effort. ads_read commonly exposes the page
            # identity through the creative, while the Page name itself may
            # require separate Page access. A failure here must never prevent
            # importing or refreshing the ad.
            if not page_name or not page_category:
                try:
                    page = self._get(page_id, {"fields": "id,name,category"})
                    direct_page_name = _clean_text(page.get("name"), 240)
                    if direct_page_name:
                        page_name = direct_page_name
                    direct_page_category = _clean_text(page.get("category"), 160)
                    if direct_page_category:
                        page_category = direct_page_category
                except MetaAdsError:
                    pass

        thumbnail_url = story_media_url
        thumbnail_source = "story" if thumbnail_url else ""
        if not thumbnail_url:
            thumbnail_url = _creative_thumbnail_url(
                creative, story_spec, include_generic_thumbnail=False
            )
            if thumbnail_url:
                thumbnail_source = "creative"
        if not thumbnail_url:
            try:
                thumbnail_url = self._get_ad_image_url(
                    account_id, _creative_image_hashes(creative, story_spec)
                )
            except MetaAdsError:
                thumbnail_url = ""
            if thumbnail_url:
                thumbnail_source = "ad_image"
        if not thumbnail_url:
            # A boosted photo post exposes its photo as creative.object_id and
            # the photo node is sometimes readable even when the post is not.
            thumbnail_url = self._get_object_media_url(creative.get("object_id"))
            if thumbnail_url:
                thumbnail_source = "object_media"
        if not thumbnail_url:
            thumbnail_url = self._get_video_thumbnail_url(
                _creative_video_ids(creative, story_spec)
            )
            if thumbnail_url:
                thumbnail_source = "video"
        if not thumbnail_url:
            # Some existing-post ads expose no post/image edge to an ads_read
            # system user. Keep Meta's rendered creative thumbnail as the last
            # fallback so the UI does not become permanently blank — unless it
            # is the Page profile picture, which is exactly the wrong photo:
            # showing nothing (with a clear "loading" tile in the UI) is more
            # honest than showing the page logo as if it were the ad.
            if creative_id and not creative_details_attempted:
                # The inline expansion carries Meta's tiny 64px default
                # thumbnail. Before accepting it as the displayed photo, ask
                # once for a display-quality rendition.
                try:
                    larger = self._get(
                        creative_id,
                        {
                            "fields": "id,thumbnail_url",
                            "thumbnail_width": 512,
                            "thumbnail_height": 512,
                        },
                    )
                    if _clean_https_url(larger.get("thumbnail_url")):
                        creative = {**creative, "thumbnail_url": larger.get("thumbnail_url")}
                except MetaAdsError:
                    pass
            candidate = _creative_thumbnail_url(
                creative, story_spec, include_generic_thumbnail=True
            )
            if candidate and story_object_id and page_id:
                # For a boosted Page post the generic thumbnail is only
                # trustworthy when it is verifiably NOT the page avatar. If
                # the avatar cannot be checked right now, fail closed: the UI
                # shows its loading tile and the next sync retries.
                candidate_key = _cdn_asset_key(candidate)
                avatar_key = self._get_page_avatar_key(page_id)
                if not candidate_key or not avatar_key or candidate_key == avatar_key:
                    candidate = ""
            thumbnail_url = candidate
            if thumbnail_url:
                thumbnail_source = "meta_fallback"
        # Insights are optional during import. A newly published ad can be
        # visible on the Ads edge while Meta is still reviewing it and before
        # an Insights row exists. That normal delay must never block creation
        # of the safe Albayan draft; later background syncs will fill it in.
        insights_payload = (
            ad.get("insights") if isinstance(ad.get("insights"), dict) else {}
        )
        if not isinstance(insights_payload.get("data"), list):
            try:
                insights_payload = self._get(
                    f"{ad_id}/insights",
                    {
                        "fields": "spend,reach,impressions,clicks,actions",
                        "date_preset": "maximum",
                        "limit": 1,
                    },
                )
            except MetaAdsError:
                insights_payload = {}
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
        start_time = _clean_time(adset.get("start_time") or campaign.get("start_time"))
        end_time = _clean_time(adset.get("end_time") or campaign.get("stop_time"))
        duration_days = _duration_days(start_time, end_time)
        total_budget, total_budget_kind = _planned_budget(
            daily_budget, lifetime_budget, duration_days
        )
        total_remaining_budget = _total_remaining_budget(total_budget, spend_minor)
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
            "metaCreativeId": creative_id,
            "metaThumbnailUrl": thumbnail_url,
            "metaThumbnailSource": thumbnail_source,
            # Version this resolver so a deployment can safely repair already
            # imported rows that were populated from Meta's unreliable generic
            # thumbnail (which can be the Facebook Page/profile picture).
            "metaMediaVersion": _META_MEDIA_VERSION,
            "metaMediaResolvedAt": synced_at,
            "metaPageId": page_id,
            "metaPageName": page_name,
            "metaPageCategory": page_category,
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
            "metaTotalBudgetMinor": total_budget,
            "metaTotalBudgetKind": total_budget_kind,
            "metaBudgetRemainingMinor": budget_remaining,
            "metaTotalRemainingBudgetMinor": total_remaining_budget,
            "metaStartTime": start_time,
            "metaEndTime": end_time,
            "metaDurationDays": duration_days,
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
    if field_name in {"metaDailyBudgetMinor", "metaLifetimeBudgetMinor", "metaTotalBudgetMinor"}:
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


def _append_meta_history(
    data: dict[str, Any],
    changes: list[dict[str, str]],
    actor_name: str,
    *,
    edited_at: Any = "",
    source: str = "snapshot",
    event_id: str = "",
    event_type: str = "",
    object_id: str = "",
    object_type: str = "",
    tool: str = "",
) -> bool:
    if not changes:
        return False
    history = data.get("metaChangeHistory") if isinstance(data.get("metaChangeHistory"), list) else []
    safe_history = [row for row in history if isinstance(row, dict)][-499:]
    safe_event_id = _clean_text(event_id, 80)
    if safe_event_id and any(str(row.get("eventId") or "") == safe_event_id for row in safe_history):
        data["metaChangeHistory"] = safe_history
        data["metaChangeCount"] = len(safe_history)
        return False
    safe_history.append(
        {
            "editedAt": _clean_time(edited_at) or _iso_now(),
            "editedBy": _clean_text(actor_name, 160) or "Meta",
            "changes": changes[:20],
            "source": _clean_text(source, 40) or "snapshot",
            "eventId": safe_event_id,
            "eventType": _clean_text(event_type, 120),
            "objectId": _clean_text(object_id, 40),
            "objectType": _clean_text(object_type, 80),
            "tool": _clean_text(tool, 120),
        }
    )
    data["metaChangeHistory"] = safe_history
    data["metaChangeCount"] = len(safe_history)
    return True


def _activity_change_rows(activity: dict[str, Any]) -> list[dict[str, str]]:
    event_type = _clean_text(activity.get("eventType"), 120)
    readable = _clean_text(activity.get("eventLabel"), 240)
    if not readable:
        readable = " ".join(part for part in event_type.replace("_", " ").split() if part).title()
    object_type = _clean_text(activity.get("objectType"), 80).replace("_", " ").title()
    object_name = _clean_text(activity.get("objectName"), 240)
    object_label = ": ".join(part for part in (object_type, object_name) if part) or "Meta ad"
    changes = [{"field": "Meta activity", "from": object_label, "to": readable or "Updated"}]

    # Some activity rows include structured before/after values. Only expose
    # those specific values instead of copying Meta's complete raw payload.
    extra = _clean_text(activity.get("extraData"), 2000)
    try:
        parsed = json.loads(extra) if extra else {}
    except (TypeError, ValueError, json.JSONDecodeError):
        parsed = {}
    if isinstance(parsed, dict):
        before = parsed.get("old_value", parsed.get("oldValue", parsed.get("before")))
        after = parsed.get("new_value", parsed.get("newValue", parsed.get("after")))
        field_name = _clean_text(
            parsed.get("field") or parsed.get("field_name") or parsed.get("name"), 120
        )
        if before not in (None, "") or after not in (None, ""):
            changes.append(
                {
                    "field": field_name or "Meta value",
                    "from": _clean_text(before, 500) or "—",
                    "to": _clean_text(after, 500) or "—",
                }
            )
    return changes


def _relevant_meta_activities(
    snapshot: dict[str, Any], activities: list[dict[str, Any]] | None
) -> list[dict[str, Any]]:
    relevant_ids = {
        str(snapshot.get(key) or "")
        for key in ("metaAdId", "metaAdSetId", "metaCampaignId", "metaCreativeId")
        if str(snapshot.get(key) or "")
    }
    return [
        row
        for row in (activities or [])
        if isinstance(row, dict) and str(row.get("objectId") or "") in relevant_ids
    ]


def _append_meta_activities(data: dict[str, Any], activities: list[dict[str, Any]]) -> int:
    appended = 0
    for activity in activities:
        actor = _clean_text(activity.get("actorName"), 160)
        if not actor:
            actor = _clean_text(activity.get("applicationName"), 160) or "Meta"
        if _append_meta_history(
            data,
            _activity_change_rows(activity),
            actor,
            edited_at=activity.get("eventTime"),
            source="meta_activity",
            event_id=str(activity.get("eventId") or ""),
            event_type=str(activity.get("eventType") or ""),
            object_id=str(activity.get("objectId") or ""),
            object_type=str(activity.get("objectType") or ""),
            tool=str(activity.get("tool") or ""),
        ):
            appended += 1
    return appended


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


def _audit(
    actor_id: str | None,
    action: str,
    resource_id: str,
    message: str,
    metadata: dict[str, Any],
    *,
    resource_type: str = "ads",
) -> None:
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO audit_logs (id,ts,user_id,action,resource_type,resource_id,message,metadata_json) "
                "VALUES (:id,:ts,:uid,:action,:resource_type,:resource_id,:message,:metadata)"
            ),
            {
                "id": new_id("audit"),
                "ts": now_ms(),
                "uid": actor_id or None,
                "action": action,
                "resource_type": resource_type,
                "resource_id": resource_id,
                "message": message,
                "metadata": json_dumps(metadata or {}),
            },
        )


def _canonical_page_name(value: Any) -> str:
    """Stable human-name key used only after an external-ID match fails."""
    normalized = unicodedata.normalize("NFKC", _clean_text(value, 240))
    normalized = normalized.replace("\u0640", "")  # Arabic tatweel
    normalized = " ".join(normalized.split()).casefold()
    return normalized


def _entity_rows(conn: Any, entity_type: str) -> list[Any]:
    return conn.execute(
        text(
            "SELECT type,id,data_json,deleted,created_at,created_by,last_modified "
            "FROM entities WHERE type=:type AND deleted=false"
        ),
        {"type": entity_type},
    ).mappings().all()


def _write_entity_data(conn: Any, row: Any, data: dict[str, Any]) -> dict[str, Any]:
    baseline = int(row["last_modified"])
    modified = max(now_ms(), baseline + 1)
    clean = dict(data)
    clean["id"] = str(row["id"])
    clean["_created"] = clean.get("_created") or int(row["created_at"])
    clean["_lastModified"] = modified
    clean["_deleted"] = False
    if row.get("created_by") is not None:
        clean["createdBy"] = str(row["created_by"])
    result = conn.execute(
        text(
            "UPDATE entities SET data_json=:data,last_modified=:modified "
            "WHERE type=:type AND id=:id AND last_modified=:baseline"
        ),
        {
            "data": json_dumps(clean),
            "modified": modified,
            "type": str(row["type"]),
            "id": str(row["id"]),
            "baseline": baseline,
        },
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="Conflict: imported entity has changed")
    next_row = dict(row)
    next_row["last_modified"] = modified
    return _entity_from_row(next_row, clean)


def _insert_internal_entity(
    conn: Any,
    entity_type: str,
    entity_id: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    stamp = now_ms()
    clean = dict(data)
    clean.update(
        {
            "id": entity_id,
            "_created": stamp,
            "_lastModified": stamp,
            "_deleted": False,
        }
    )
    conn.execute(
        text(
            "INSERT INTO entities "
            "(type,id,data_json,deleted,created_at,created_by,last_modified) "
            "VALUES (:type,:id,:data,false,:stamp,NULL,:stamp)"
        ),
        {
            "type": entity_type,
            "id": entity_id,
            "data": json_dumps(clean),
            "stamp": stamp,
        },
    )
    return {
        "id": entity_id,
        "type": entity_type,
        "deleted": False,
        "createdAt": stamp,
        "createdBy": None,
        "lastModified": stamp,
        "data": clean,
    }


def _find_entity_by_meta_id(
    rows: list[Any], field_name: str, meta_id: str
) -> tuple[Any | None, dict[str, Any] | None]:
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if isinstance(data, dict) and str(data.get(field_name) or "") == meta_id:
            return row, data
    return None, None


def _ensure_import_page(
    conn: Any, snapshot: dict[str, Any]
) -> tuple[str, str, bool]:
    meta_page_id = _clean_text(snapshot.get("metaPageId"), 40)
    if not _META_ID_RE.fullmatch(meta_page_id):
        return "", "", False
    meta_name = _clean_text(snapshot.get("metaPageName"), 240)
    meta_category = _clean_text(snapshot.get("metaPageCategory"), 160)
    rows = _entity_rows(conn, "pages")
    matched_row, matched_data = _find_entity_by_meta_id(
        rows, "metaPageId", meta_page_id
    )
    if matched_row is None and meta_name:
        wanted = _canonical_page_name(meta_name)
        for row in rows:
            candidate = json_loads(row.get("data_json") or "{}") or {}
            if not isinstance(candidate, dict):
                continue
            existing_meta_id = str(candidate.get("metaPageId") or "")
            if existing_meta_id and existing_meta_id != meta_page_id:
                continue
            if _canonical_page_name(candidate.get("name")) == wanted:
                matched_row, matched_data = row, candidate
                break
    if matched_row is not None and isinstance(matched_data, dict):
        updated = dict(matched_data)
        existing_name = _clean_text(updated.get("name"), 240)
        placeholder_name = f"Facebook Page {meta_page_id}"
        if meta_name and (
            not existing_name
            or _canonical_page_name(existing_name)
            == _canonical_page_name(placeholder_name)
        ):
            updated["name"] = meta_name
        existing_category = _clean_text(updated.get("category"), 160)
        if meta_category and (
            not existing_category
            or existing_category.casefold() == "facebook page"
        ):
            updated["category"] = meta_category
        updated["metaPageId"] = meta_page_id
        updated["metaPageName"] = meta_name
        updated["metaPageCategory"] = meta_category
        updated["metaImportSource"] = "meta_ads"
        updated.setdefault("metaImportedAt", _iso_now())
        if not updated.get("customerIds"):
            updated["metaImportState"] = "needs_owner"
        else:
            updated["metaImportState"] = "complete"
        if updated == matched_data:
            # Nothing actually changed. Skip the write so the routine
            # 15-minute sync of every linked ad does not bump the page's
            # version (which would re-download it to every client and race
            # concurrent human edits with spurious conflicts).
            return (
                str(matched_row["id"]),
                _clean_text(updated.get("name"), 240),
                False,
            )
        entity = _write_entity_data(conn, matched_row, updated)
        local_name = _clean_text(entity["data"].get("name"), 240)
        return str(entity["id"]), local_name, False

    local_id = new_id("page")
    local_name = meta_name or f"Facebook Page {meta_page_id}"
    data = {
        "name": local_name,
        "category": meta_category or "Facebook Page",
        "customerIds": [],
        "createdAt": _iso_now(),
        "metaPageId": meta_page_id,
        "metaPageName": meta_name,
        "metaPageCategory": meta_category,
        "metaImportState": "needs_owner",
        "metaImportedAt": _iso_now(),
        "metaImportSource": "meta_ads",
    }
    _insert_internal_entity(conn, "pages", local_id, data)
    return local_id, local_name, True


def _imported_ad_dates(snapshot: dict[str, Any]) -> tuple[str, str, int]:
    start = _clean_time(
        snapshot.get("metaStartTime") or snapshot.get("metaAdCreatedTime")
    ) or _iso_now()
    end = _clean_time(snapshot.get("metaEndTime")) or start
    days = _duration_days(start, end)
    return start, end, days


def import_meta_ad_draft(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Create one neutral Albayan draft, or return its existing linked row."""
    meta_ad_id = _meta_id(snapshot.get("metaAdId"), "Meta ad")
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    with _META_WRITE_LOCK, db_conn() as conn:
        if postgres:
            # Cross-process guard for a scaled deployment. The transaction
            # releases it automatically and the external Meta calls have
            # already completed before this short critical section.
            conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('albayan_meta_import'))"))
        ad_rows = _entity_rows(conn, "ads")
        existing_row, existing_data = _find_entity_by_meta_id(
            ad_rows, "metaAdId", meta_ad_id
        )
        if existing_row is not None and isinstance(existing_data, dict):
            return _thin_ad_entity(_entity_from_row(existing_row, existing_data))
        # The fast account edge normally gives us the Page ID before Meta lets
        # us read its real name. Wait for the paced enrichment snapshot before
        # creating/linking the local page; otherwise a temporary
        # "Facebook Page 123" record could duplicate a page the user already
        # created manually under its proper name.
        if snapshot.get("metaPageName"):
            page_id, page_name, page_created = _ensure_import_page(conn, snapshot)
        else:
            page_id, page_name, page_created = "", "", False
        start_date, end_date, days = _imported_ad_dates(snapshot)
        local_id = new_id("ad")
        imported_at = _iso_now()
        data: dict[str, Any] = {
            "recordType": "ad",
            "customerId": "",
            "customerName": "",
            "pageId": page_id,
            "pageName": page_name,
            "amountUSD": 0.0,
            "amountLocal": 0.0,
            "exchangeRate": 0.0,
            "paymentStatus": "pending_setup",
            "collectionMethod": "",
            "collectionPayments": [],
            "receiptAllocations": [],
            "dueAllocations": [],
            "mergedPaidAllocations": [],
            "receiptIds": [],
            "fundingReceiptId": "",
            "receiptId": "",
            "linkedDeliveryReceiptId": "",
            "dueAmountToUseUSD": 0.0,
            "hasMergedPaidFunds": False,
            "status": "Active",
            "deliveryStatus": "Office",
            "deliveryPersonId": "",
            "serialNumber": "",
            "adLinks": [],
            "adLink": "",
            "adPhotos": [],
            "startDate": start_date,
            "endDate": end_date,
            "days": days,
            "creatorId": "system",
            "createdByName": "Meta automatic import",
            "metaImportState": "needs_completion",
            "metaImportedAt": imported_at,
            "metaImportSource": "meta_ads",
            "editHistory": [],
            "editCount": 0,
            "metaChangeHistory": [
                {
                    "editedAt": imported_at,
                    "editedBy": "Meta automatic import",
                    "source": "meta_import",
                    "eventId": f"import:{meta_ad_id}",
                    "eventType": "create_ad",
                    "objectId": meta_ad_id,
                    "objectType": "AD",
                    "tool": "Albayan Meta Sync",
                    "changes": [
                        {
                            "field": "Meta ad imported",
                            "from": "Not in Albayan",
                            "to": "Needs completion",
                        }
                    ],
                }
            ],
            "metaChangeCount": 1,
        }
        for key in META_AD_LINK_FIELDS:
            if key in snapshot:
                data[key] = snapshot[key]
        entity = _insert_internal_entity(conn, "ads", local_id, data)
    if page_created:
        _audit(
            None,
            "meta_import",
            page_id,
            "Automatically imported Meta page",
            {"metaPageId": snapshot.get("metaPageId")},
            resource_type="pages",
        )
    _audit(
        None,
        "meta_import",
        local_id,
        "Automatically imported Meta ad as a neutral draft",
        {"metaAdId": meta_ad_id, "pageId": page_id},
    )
    return _thin_ad_entity(entity)


def _load_import_state() -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            text(
                "SELECT data_json FROM entities "
                "WHERE type=:type AND id=:id AND deleted=false LIMIT 1"
            ),
            {"type": _META_IMPORT_STATE_TYPE, "id": _META_IMPORT_STATE_ID},
        ).mappings().first()
    data = json_loads(row.get("data_json") or "{}") if row else {}
    return data if isinstance(data, dict) else {}


def _save_import_state(data: dict[str, Any]) -> dict[str, Any]:
    clean = dict(data)
    clean["recordType"] = _META_IMPORT_STATE_TYPE
    clean["updatedAt"] = _iso_now()
    with db_conn() as conn:
        row = conn.execute(
            text(
                "SELECT id,type,data_json,deleted,created_at,created_by,last_modified "
                "FROM entities WHERE type=:type AND id=:id AND deleted=false LIMIT 1"
            ),
            {"type": _META_IMPORT_STATE_TYPE, "id": _META_IMPORT_STATE_ID},
        ).mappings().first()
        if row:
            _write_entity_data(conn, row, clean)
        else:
            _insert_internal_entity(
                conn, _META_IMPORT_STATE_TYPE, _META_IMPORT_STATE_ID, clean
            )
    return clean


def _public_import_state(state: dict[str, Any] | None = None) -> dict[str, Any]:
    source = state if isinstance(state, dict) else _load_import_state()
    return {
        "baselineComplete": bool(source.get("baselineComplete")),
        "baselineAt": _clean_time(source.get("baselineAt")),
        "lastDiscoveryAt": _clean_time(source.get("lastDiscoveryAt")),
        "lastSuccessAt": _clean_time(source.get("lastSuccessAt")),
        "lastError": _clean_text(source.get("lastError"), 240),
        "lastImportedCount": _metric_int(source.get("lastImportedCount")),
        "totalImported": _metric_int(source.get("totalImported")),
        "knownAdCount": _metric_int(source.get("knownAdCount")),
        "accountCount": _metric_int(source.get("accountCount")),
    }


def _existing_meta_ad_ids() -> set[str]:
    result: set[str] = set()
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT data_json FROM entities WHERE type='ads' AND deleted=false")
        ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        meta_id = str(data.get("metaAdId") or "") if isinstance(data, dict) else ""
        if _META_ID_RE.fullmatch(meta_id):
            result.add(meta_id)
    return result


def _created_after_cutoff(value: Any, cutoff: str | None) -> bool:
    if not cutoff:
        return False
    candidate = _clean_time(value)
    cutoff_clean = _clean_time(cutoff)
    if not candidate or not cutoff_clean:
        return False
    try:
        created_at = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        cutoff_at = datetime.fromisoformat(cutoff_clean.replace("Z", "+00:00"))
    except ValueError:
        return False
    return created_at >= cutoff_at


def _pending_meta_snapshot(
    row: dict[str, Any], account_id: str, error: MetaAdsError
) -> dict[str, Any]:
    """Build a retryable, accounting-neutral snapshot from the Ads edge.

    Meta publishes the lightweight ad row before every related object (creative,
    ad set, campaign and insights) is guaranteed to be readable. Keeping this
    fallback server-side makes the new ad visible immediately without trusting
    webhook data or inventing customer/payment information.
    """
    meta_ad_id = _meta_id(row.get("id"), "Meta ad")
    attempted_at = _iso_now()
    return {
        "metaLinkState": "linked",
        "metaLinkVersion": 1,
        "metaAdId": meta_ad_id,
        "metaAdName": _clean_text(row.get("name"), 240) or f"Meta ad {meta_ad_id}",
        "metaAdSetId": _clean_text(row.get("adSetId"), 40),
        "metaAdSetName": _clean_text(row.get("adSetName"), 240),
        "metaCampaignId": _clean_text(row.get("campaignId"), 40),
        "metaCampaignName": _clean_text(row.get("campaignName"), 240),
        "metaCreativeId": _clean_text(row.get("creativeId"), 40),
        "metaThumbnailUrl": _clean_https_url(row.get("thumbnailUrl")),
        "metaThumbnailSource": "discovery" if row.get("thumbnailUrl") else "",
        # Discovery is intentionally cheap. The paced detail worker upgrades
        # this draft to the authoritative post/creative media within seconds.
        "metaMediaVersion": 0,
        "metaMediaResolvedAt": "",
        "metaPageId": _clean_text(row.get("pageId"), 40),
        # Discovery resolves the real Page name through the ad account's
        # promoted-pages directory whenever Meta allows it, so the local page
        # can be created under its proper name immediately instead of the
        # "Facebook Page 123…" placeholder.
        "metaPageName": _clean_text(row.get("pageName"), 240),
        "metaPageCategory": _clean_text(row.get("pageCategory"), 160),
        "metaAdAccountId": _account_id(account_id),
        "metaConfiguredStatus": _clean_text(row.get("status"), 40),
        "metaEffectiveStatus": _clean_text(row.get("effectiveStatus"), 40),
        "metaAdSetStatus": _clean_text(row.get("adSetStatus"), 40),
        "metaCampaignStatus": _clean_text(row.get("campaignStatus"), 40),
        "metaBudgetSource": _clean_text(row.get("budgetSource"), 20),
        "metaDailyBudgetMinor": _minor_units(row.get("dailyBudgetMinor")),
        "metaLifetimeBudgetMinor": _minor_units(row.get("lifetimeBudgetMinor")),
        "metaTotalBudgetMinor": _minor_units(row.get("totalBudgetMinor")),
        "metaTotalBudgetKind": _clean_text(row.get("totalBudgetKind"), 40),
        "metaBudgetRemainingMinor": _minor_units(row.get("budgetRemainingMinor")),
        "metaTotalRemainingBudgetMinor": _total_remaining_budget(
            row.get("totalBudgetMinor"), 0
        ),
        "metaStartTime": _clean_time(row.get("startTime")),
        "metaEndTime": _clean_time(row.get("endTime")),
        "metaDurationDays": _metric_int(row.get("durationDays")),
        "metaAdCreatedTime": _clean_time(row.get("createdTime")),
        "metaAdUpdatedTime": _clean_time(row.get("updatedTime")),
        "metaSpend": 0.0,
        "metaSpendMinor": 0,
        "metaReach": 0,
        "metaImpressions": 0,
        "metaClicks": 0,
        "metaActions": [],
        "metaLastAttemptAt": attempted_at,
        "metaSyncError": (
            "The new ad is already in Albayan. Remaining Meta details are loading "
            "automatically."
        ),
        "metaSyncErrorCode": "pending_enrichment",
        "metaSyncFailureCount": 0,
        # The lightweight draft costs one shared account-list request. Its more
        # expensive details are deliberately queued a few seconds later so a
        # burst of new ads cannot block discovery of the rest.
        "metaNextSyncAt": now_ms() + 5_000,
        "metaUnlinkedAt": "",
    }


def discover_meta_ads(
    account_ids: list[str] | tuple[str, ...] | None = None,
    *,
    startup_cutoff: str | None = None,
    include_existing: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """Discover new Meta ads and create idempotent, accounting-neutral drafts.

    The first normal pass records a baseline instead of importing an account's
    full history. Ads created after this process started are the only exception,
    which closes the startup race without flooding Albayan with old campaigns.
    """
    config = load_meta_ads_config()
    if not config.configured:
        raise MetaAdsError("not_configured", "Meta Ads connection is not configured")
    if not config.auto_import and not force:
        return {"imported": [], "busy": False, "disabled": True, "state": _public_import_state()}
    if not _META_DISCOVERY_LOCK.acquire(blocking=False):
        return {"imported": [], "busy": True, "disabled": False, "state": _public_import_state()}
    try:
        allowed = set(config.allowed_account_ids)
        requested: list[str] = []
        for raw_id in account_ids or config.allowed_account_ids:
            try:
                normalized = _account_id(raw_id)
            except MetaAdsError:
                continue
            if normalized in allowed and normalized not in requested:
                requested.append(normalized)
        if not requested:
            raise MetaAdsError(
                "no_accounts", "No allowed Meta ad accounts are configured"
            )

        client = get_meta_ads_client()
        state = _load_import_state()
        baseline_complete = bool(state.get("baselineComplete"))
        scan_pages = (
            config.discovery_baseline_pages
            if include_existing or not baseline_complete
            else config.discovery_fast_pages
        )
        known = {
            str(value)
            for value in (state.get("knownMetaAdIds") or [])
            if _META_ID_RE.fullmatch(str(value))
        }
        already_linked = _existing_meta_ad_ids()
        found: dict[str, tuple[str, dict[str, Any]]] = {}
        account_errors: list[str] = []
        for account_id in requested:
            try:
                for row in client.list_ads(account_id, max_pages=scan_pages):
                    if not isinstance(row, dict):
                        continue
                    meta_id = str(row.get("id") or "")
                    if _META_ID_RE.fullmatch(meta_id):
                        found[meta_id] = (account_id, row)
            except MetaAdsError as error:
                account_errors.append(error.public_message)
                # Once Meta has limited this token, more account requests in
                # the same pass only extend the problem. Preserve partial
                # results and let the paced worker retry the remaining account.
                if error.code == "rate_limited":
                    break

        if not found and account_errors and len(account_errors) == len(requested):
            raise MetaAdsError("discovery_failed", account_errors[0], retryable=True)

        if include_existing:
            candidate_ids = sorted(set(found) - already_linked)
        elif baseline_complete:
            candidate_ids = sorted(set(found) - known - already_linked)
        else:
            candidate_ids = sorted(
                meta_id
                for meta_id, (_, row) in found.items()
                if meta_id not in already_linked
                and _created_after_cutoff(row.get("createdTime"), startup_cutoff)
            )

        imported: list[dict[str, Any]] = []
        failed: set[str] = set()
        last_error = ""
        for meta_id in candidate_ids:
            account_id, discovery_row = found[meta_id]
            # Never perform the expensive per-ad enrichment inside discovery.
            # Import every new ad from the authoritative account edge first;
            # the paced details queue fills in spend, account/page names and
            # history shortly afterwards. This is the key to reliable fast
            # visibility when several ads are published together.
            snapshot = _pending_meta_snapshot(
                discovery_row,
                account_id,
                MetaAdsError(
                    "pending_enrichment",
                    "Albayan is loading the remaining Meta details.",
                    retryable=True,
                ),
            )
            try:
                imported.append(import_meta_ad_draft(snapshot))
            except MetaAdsError as error:
                failed.add(meta_id)
                last_error = error.public_message
            except Exception:
                failed.add(meta_id)
                last_error = "One Meta ad could not be imported. Albayan will retry."

        # IDs that failed remain unknown so a later pass retries them. The set
        # also includes any manually linked rows, preventing a later unlink or
        # duplicate webhook delivery from creating a second Albayan ad.
        known.update(found)
        known.update(already_linked)
        known.difference_update(failed)
        if len(known) > _META_IMPORT_MAX_KNOWN_IDS:
            # Meta returns newest ads first. Retaining the current account view
            # is safer than growing one database row without limit.
            current_ids = list(found)
            known = set(current_ids[:_META_IMPORT_MAX_KNOWN_IDS]) | already_linked
        stamp = _iso_now()
        next_state = {
            **state,
            # Never declare the initial safety baseline complete when Meta
            # limited or failed one of the configured accounts. Otherwise an
            # old ad from that account could be mistaken for a new one later.
            "baselineComplete": baseline_complete or not account_errors,
            "baselineAt": state.get("baselineAt") or stamp,
            "lastDiscoveryAt": stamp,
            "lastSuccessAt": stamp if not account_errors and not failed else state.get("lastSuccessAt"),
            "lastError": last_error or (account_errors[0] if account_errors else ""),
            "lastImportedCount": len(imported),
            "totalImported": _metric_int(state.get("totalImported")) + len(imported),
            "knownAdCount": len(known),
            "knownMetaAdIds": sorted(known),
            "accountCount": len(requested),
            "lastScanPagesPerAccount": scan_pages,
        }
        _save_import_state(next_state)
        return {
            "imported": imported,
            "busy": False,
            "disabled": False,
            "state": _public_import_state(next_state),
        }
    finally:
        _META_DISCOVERY_LOCK.release()


def apply_meta_snapshot(
    ad_id: str,
    snapshot: dict[str, Any],
    *,
    actor_id: str | None,
    actor_name: str,
    expected_last_modified: int | None,
    operation_id: str | None,
    action: str,
    meta_activities: list[dict[str, Any]] | None = None,
    activity_cursor_at: str | None = None,
) -> tuple[dict[str, Any], bool, list[dict[str, str]]]:
    ad_id = _local_id(ad_id)
    meta_ad_id = _meta_id(snapshot.get("metaAdId"), "Meta ad")
    operation_id = _clean_text(operation_id, 120)
    op_hash = _operation_hash(action, ad_id, operation_id, meta_ad_id) if operation_id else ""
    postgres = str(get_engine().dialect.name or "") == "postgresql"
    guard = nullcontext() if postgres else _META_WRITE_LOCK
    changes: list[dict[str, str]] = []
    replayed = False
    imported_page_id = ""
    imported_page_created = False
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
        if previous_meta_ad_id == meta_ad_id:
            # Re-syncing the same Meta ad: a pass that could not resolve the
            # photo or page identity this time must not erase values an
            # earlier pass already learned. Weak thumbnails (the generic
            # fallback that can be the Page avatar, or the cheap discovery
            # preview) may still be replaced by empty so the repaired
            # resolver can retire wrong photos.
            merged = dict(snapshot)
            if (
                not merged.get("metaThumbnailUrl")
                and data.get("metaThumbnailUrl")
                and str(data.get("metaThumbnailSource") or "")
                in {"story", "creative", "ad_image", "object_media", "video"}
            ):
                merged["metaThumbnailUrl"] = data["metaThumbnailUrl"]
                merged["metaThumbnailSource"] = data["metaThumbnailSource"]
            for preserved_key in ("metaPageId", "metaPageName", "metaPageCategory"):
                if not merged.get(preserved_key) and data.get(preserved_key):
                    merged[preserved_key] = data[preserved_key]
            snapshot = merged
        if (
            data.get("metaImportSource") == "meta_ads"
            and snapshot.get("metaPageId")
            and (not data.get("pageId") or snapshot.get("metaPageName"))
        ):
            page_id, page_name, page_created = _ensure_import_page(conn, snapshot)
            if page_id:
                imported_page_id = page_id
                imported_page_created = page_created
            # Attach the Meta-derived page only when the ad has no page yet
            # or still points at that same page (keeping its name fresh). An
            # administrator's manual reassignment to another Albayan page
            # must never be silently reverted by the next automatic sync.
            if page_id and (
                not data.get("pageId") or str(data.get("pageId")) == page_id
            ):
                data["pageId"] = page_id
                data["pageName"] = page_name
        for key in META_AD_LINK_FIELDS:
            if key in snapshot:
                data[key] = snapshot[key]
        link_changes: list[dict[str, str]] = []
        if previous_meta_ad_id != meta_ad_id:
            link_changes.append(
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
        provider_changes = _meaningful_changes(previous, data)
        # Do not duplicate the name row immediately after the initial link row
        # returned to the caller. The dedicated Meta history still receives all
        # provider fields when no exact Meta activity event is available.
        if previous_meta_ad_id != meta_ad_id:
            provider_changes = [
                row for row in provider_changes if row.get("field") != "Meta ad name"
            ]
        changes = [*link_changes, *provider_changes]
        if changes:
            data["metaLastChangedAt"] = _iso_now()
        if link_changes:
            _append_history(data, link_changes, actor_name)
        relevant_activities = _relevant_meta_activities(snapshot, meta_activities)
        appended_activities = _append_meta_activities(data, relevant_activities)
        if provider_changes and appended_activities == 0:
            _append_meta_history(
                data,
                provider_changes,
                "Meta automatic sync",
                source="snapshot",
            )
        if activity_cursor_at:
            clean_cursor = _clean_time(activity_cursor_at)
            if clean_cursor:
                data["metaActivityCursorAt"] = clean_cursor
                data["metaActivityLastCheckedAt"] = clean_cursor
        if operation_id:
            data["metaLastOperationId"] = operation_id
            data["metaLastOperationHash"] = op_hash
        entity = _write_ad_data(conn, row, data)
    if imported_page_created:
        _audit(
            None,
            "meta_import",
            imported_page_id,
            "Automatically imported Meta page during ad enrichment",
            {"metaPageId": snapshot.get("metaPageId")},
            resource_type="pages",
        )
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


def _sync_failure_delay_ms(
    config: MetaAdsConfig, failure_count: int, error: MetaAdsError
) -> int:
    if error.retryable:
        # A transient Meta limit must not make a new draft wait the normal
        # 15-minute refresh period after its very first enrichment attempt.
        # Retry gently, with a capped backoff that still recovers automatically.
        base = 60_000
        return min(
            base * (2 ** min(max(failure_count - 1, 0), 4)),
            15 * 60_000,
        )
    base = config.sync_interval_minutes * 60_000
    return min(
        base * (2 ** min(max(failure_count - 1, 0), 4)), 6 * 60 * 60_000
    )


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
                "metaNextSyncAt": now_ms()
                + _sync_failure_delay_ms(config, failures, error),
            }
        )
        return _thin_ad_entity(_write_ad_data(conn, row, data))


def _due_meta_ads(limit: int) -> list[dict[str, Any]]:
    current = now_ms()
    candidates: list[tuple[int, int, str, dict[str, Any]]] = []
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "SELECT id,data_json,created_at,last_modified FROM entities "
                "WHERE type='ads' AND deleted=false"
            )
        ).mappings().all()
    for row in rows:
        data = json_loads(row.get("data_json") or "{}") or {}
        if not isinstance(data, dict):
            continue
        meta_ad_id = str(data.get("metaAdId") or "")
        if not _META_ID_RE.fullmatch(meta_ad_id):
            continue
        next_sync = int(data.get("metaNextSyncAt") or 0)
        try:
            media_version = int(data.get("metaMediaVersion") or 0)
        except (TypeError, ValueError, OverflowError):
            media_version = 0
        try:
            failure_count = int(data.get("metaSyncFailureCount") or 0)
        except (TypeError, ValueError, OverflowError):
            failure_count = 0
        needs_media_repair = media_version < _META_MEDIA_VERSION and failure_count == 0
        if next_sync > current and not needs_media_repair:
            continue
        priority = 0 if needs_media_repair else 1
        # Repair newest visible ads first while the normal queue remains oldest
        # due first. A failed repair leaves this priority lane and respects the
        # existing retry/backoff fields, preventing repeated Meta API pressure.
        sort_time = -int(row.get("created_at") or 0) if needs_media_repair else next_sync
        candidates.append(
            (
                priority,
                sort_time,
                str(row["id"]),
                {
                    "adId": str(row["id"]),
                    "version": int(row["last_modified"]),
                    "metaAdId": meta_ad_id,
                    "metaAdAccountId": _clean_text(data.get("metaAdAccountId"), 40),
                    "metaAdSetId": _clean_text(data.get("metaAdSetId"), 40),
                    "metaCampaignId": _clean_text(data.get("metaCampaignId"), 40),
                    "metaCreativeId": _clean_text(data.get("metaCreativeId"), 40),
                    "metaActivityCursorAt": _clean_time(data.get("metaActivityCursorAt")),
                    "metaSyncedAt": _clean_time(data.get("metaSyncedAt")),
                    "metaAdCreatedTime": _clean_time(data.get("metaAdCreatedTime")),
                },
            )
        )
    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return [candidate for _, _, _, candidate in candidates[: max(1, limit)]]


def _activity_since(rows: list[dict[str, Any]], fetched_at: str) -> str:
    try:
        fetched_dt = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError:
        fetched_dt = datetime.now(timezone.utc)
    floor = fetched_dt - timedelta(days=7)
    candidates: list[datetime] = []
    for row in rows:
        cleaned = _clean_time(
            row.get("metaActivityCursorAt")
            or row.get("metaSyncedAt")
            or row.get("metaAdCreatedTime")
        )
        if not cleaned:
            continue
        try:
            parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        except ValueError:
            continue
        candidates.append(max(parsed - timedelta(minutes=2), floor))
    selected = min(candidates) if candidates else floor
    return selected.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _account_activity_batches(
    client: MetaAdsClient, rows: list[dict[str, Any]]
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        # A freshly imported draft has no previous Meta state to compare. Do
        # not spend an activities request before its first details snapshot.
        if not (row.get("metaSyncedAt") or row.get("metaActivityCursorAt")):
            continue
        account_id = _clean_text(row.get("metaAdAccountId"), 40)
        if _META_ID_RE.fullmatch(account_id):
            grouped.setdefault(account_id, []).append(row)
    activities: dict[str, list[dict[str, Any]]] = {}
    cursors: dict[str, str] = {}
    if not hasattr(client, "list_account_activities"):
        return activities, cursors
    fetched_at = _iso_now()
    for account_id, account_rows in grouped.items():
        object_ids = {
            str(row.get(key) or "")
            for row in account_rows
            for key in ("metaAdId", "metaAdSetId", "metaCampaignId", "metaCreativeId")
            if _META_ID_RE.fullmatch(str(row.get(key) or ""))
        }
        try:
            activities[account_id] = client.list_account_activities(
                account_id,
                object_ids=sorted(object_ids),
                since=_activity_since(account_rows, fetched_at),
                until=fetched_at,
                max_pages=5,
            )
            cursors[account_id] = fetched_at
        except MetaAdsError:
            # The activity edge can require more access than core ads_read in
            # some Meta configurations. Snapshot history remains the fallback.
            continue
    return activities, cursors


def _snapshot_activity_context(
    client: MetaAdsClient,
    snapshot: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Best-effort activity lookup for a manual link or refresh operation."""
    context = dict(existing or {})
    for key in (
        "metaAdId",
        "metaAdSetId",
        "metaCampaignId",
        "metaCreativeId",
        "metaAdAccountId",
        "metaAdCreatedTime",
        "metaSyncedAt",
    ):
        if snapshot.get(key) not in (None, ""):
            context[key] = snapshot[key]
    account_id = _clean_text(context.get("metaAdAccountId"), 40)
    if not _META_ID_RE.fullmatch(account_id):
        return [], None
    activities, cursors = _account_activity_batches(client, [context])
    return activities.get(account_id, []), cursors.get(account_id)


def sync_due_meta_ads(limit: int | None = None) -> list[dict[str, Any]]:
    config = load_meta_ads_config()
    if not config.configured:
        return []
    client = get_meta_ads_client()
    updated: list[dict[str, Any]] = []
    due_rows = _due_meta_ads(limit or config.sync_batch_size)
    activities_by_account, activity_cursors = _account_activity_batches(client, due_rows)
    for candidate in due_rows:
        ad_id = str(candidate["adId"])
        version = int(candidate["version"])
        meta_ad_id = str(candidate["metaAdId"])
        account_id = str(candidate.get("metaAdAccountId") or "")
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
                meta_activities=activities_by_account.get(account_id, []),
                activity_cursor_at=activity_cursors.get(account_id),
            )
            updated.append(entity)
        except HTTPException as error:
            if error.status_code != 409:
                continue
        except MetaAdsError as error:
            failed = record_meta_sync_failure(ad_id, error, expected_last_modified=version)
            if failed:
                updated.append(failed)
            if error.code == "rate_limited":
                break
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
_WORKER_STARTED_AT = ""


def _worker_loop() -> None:
    # Give startup/migrations time to settle before the first external call.
    if _WORKER_STOP.wait(5):
        return
    last_discovery_monotonic = 0.0
    last_sync_monotonic = 0.0
    while not _WORKER_STOP.is_set():
        try:
            config = load_meta_ads_config()
            current = time.monotonic()
            if config.auto_import and (
                not last_discovery_monotonic
                or current - last_discovery_monotonic
                >= config.discovery_interval_seconds
            ):
                discover_meta_ads(startup_cutoff=_WORKER_STARTED_AT)
                last_discovery_monotonic = current
            if (
                not last_sync_monotonic
                or current - last_sync_monotonic
                >= config.worker_sync_interval_seconds
            ):
                sync_due_meta_ads()
                last_sync_monotonic = current
        except Exception:
            print("[albayan] Meta Ads background pass failed; it will retry.")
        _WORKER_STOP.wait(2)


def start_meta_ads_worker() -> None:
    global _WORKER_THREAD, _WORKER_STARTED_AT
    config = load_meta_ads_config()
    if not config.configured or not config.background_sync:
        return
    with _WORKER_CONTROL_LOCK:
        if _WORKER_THREAD and _WORKER_THREAD.is_alive():
            return
        _WORKER_STOP.clear()
        _WORKER_STARTED_AT = _iso_now()
        _WORKER_THREAD = threading.Thread(
            target=_worker_loop,
            name="albayan-meta-ads-sync",
            daemon=True,
        )
        _WORKER_THREAD.start()
    print("[albayan] Meta Ads read-only synchronization and safe draft import enabled.")


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
    # A detail snapshot may fan out to several Meta reads. Keep a manual click
    # paced too, otherwise it can undo the worker's protection and trigger the
    # same account-wide limit the user was trying to recover from.
    limit: int = Field(default=4, ge=1, le=20)


class MetaAutoImportRequest(BaseModel):
    includeExisting: bool = False


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
            "syncBatchSize": config.sync_batch_size,
            "workerSyncIntervalSeconds": config.worker_sync_interval_seconds,
            "autoImport": config.auto_import and config.configured,
            "discoveryIntervalSeconds": config.discovery_interval_seconds,
            "discoveryFastPages": config.discovery_fast_pages,
            "remoteBackoffSeconds": _meta_remote_backoff_remaining(),
            "webhookConfigured": bool(
                config.webhook_verify_token and config.app_secret
            ),
            "importState": _public_import_state(),
            "message": "Meta Ads read-only synchronization is ready" if config.configured else "Add the Meta server credentials in Jelastic to enable synchronization",
        }

    @router.get("/webhook")
    def verify_webhook(
        mode: str = Query(default="", alias="hub.mode"),
        verify_token: str = Query(default="", alias="hub.verify_token"),
        challenge: str = Query(default="", alias="hub.challenge"),
    ):
        config = load_meta_ads_config()
        if (
            mode != "subscribe"
            or not config.webhook_verify_token
            or not hmac.compare_digest(verify_token, config.webhook_verify_token)
        ):
            raise HTTPException(status_code=403, detail="Webhook verification failed")
        return Response(content=_clean_text(challenge, 500), media_type="text/plain")

    @router.post("/webhook")
    async def receive_webhook(request: Request, background_tasks: BackgroundTasks):
        config = load_meta_ads_config()
        if not config.app_secret:
            raise HTTPException(status_code=503, detail="Meta webhook signing is not configured")
        raw_body = await request.body()
        supplied = str(request.headers.get("X-Hub-Signature-256") or "")
        expected = "sha256=" + hmac.new(
            config.app_secret.encode("utf-8"), raw_body, hashlib.sha256
        ).hexdigest()
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=403, detail="Invalid Meta webhook signature")
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HTTPException(status_code=400, detail="Invalid webhook payload")
        account_ids: list[str] = []
        if isinstance(payload, dict) and payload.get("object") == "ad_account":
            for entry in payload.get("entry") or []:
                if not isinstance(entry, dict):
                    continue
                try:
                    account_id = _account_id(entry.get("id"))
                except MetaAdsError:
                    continue
                if account_id in config.allowed_account_ids and account_id not in account_ids:
                    account_ids.append(account_id)
        # Treat the webhook only as a signed wake-up signal. Albayan reads the
        # authoritative ad from Meta and never trusts webhook field values.
        background_tasks.add_task(
            discover_meta_ads,
            account_ids or list(config.allowed_account_ids),
            startup_cutoff=_WORKER_STARTED_AT or None,
        )
        return {"received": True}

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
            provider = configured_client()
            snapshot = provider.get_ad_snapshot(body.metaAdId)
            activities, activity_cursor = _snapshot_activity_context(provider, snapshot)
            entity, replayed, changes = apply_meta_snapshot(
                ad_id,
                snapshot,
                actor_id=str(admin.get("id") or ""),
                actor_name=_clean_text(admin.get("name"), 120) or "Admin",
                expected_last_modified=body.expectedLastModified,
                operation_id=body.operationId,
                action="link",
                meta_activities=activities,
                activity_cursor_at=activity_cursor,
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
            provider = configured_client()
            snapshot = provider.get_ad_snapshot(data.get("metaAdId"))
            activities, activity_cursor = _snapshot_activity_context(provider, snapshot, data)
            entity, replayed, changes = apply_meta_snapshot(
                local_id,
                snapshot,
                actor_id=str(admin.get("id") or ""),
                actor_name=_clean_text(admin.get("name"), 120) or "Admin",
                expected_last_modified=body.expectedLastModified,
                operation_id=body.operationId,
                action="sync",
                meta_activities=activities,
                activity_cursor_at=activity_cursor,
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
        discovery = discover_meta_ads(
            startup_cutoff=_WORKER_STARTED_AT or None, force=True
        )
        config = load_meta_ads_config()
        safe_limit = min(body.limit, max(1, config.sync_batch_size * 2))
        return {
            "ads": sync_due_meta_ads(safe_limit),
            "imported": discovery.get("imported", []),
            "importState": discovery.get("state", {}),
        }

    @router.post("/auto-import/run")
    def run_auto_import(
        body: MetaAutoImportRequest,
        request: Request,
        admin: dict[str, Any] = Depends(require_meta_admin),
    ):
        require_same_origin(request)
        _rate_limit_or_429(f"meta-auto-import:{admin.get('id')}", 6, 60_000)
        try:
            return discover_meta_ads(
                startup_cutoff=_WORKER_STARTED_AT or None,
                include_existing=bool(body.includeExisting),
                force=True,
            )
        except MetaAdsError as error:
            raise HTTPException(
                status_code=502 if error.retryable else 400,
                detail=error.public_message,
            )

    return router
