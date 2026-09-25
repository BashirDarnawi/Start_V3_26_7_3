"""Linked pages, their recent posts, and the post a request boosts (plan tasks P1-13 as changed by D19, P1-14).

Owner decision D19: the customer either picks one of their linked page's posts from a list and
boosts it, or makes an ad without a post (their own photo and text). Pasting a post link stays
as the fallback when the page is not linked yet.

Routes (mounted under /api/studio by studio_api.create_studio_router; any signed-in user, who
only ever sees their own pages):

* ``GET /api/studio/pages``: the customer's linked pages (their socialPages rows), one entry per
  Meta page: ``id`` (a socialPages row id, the wizard's ``connectedAssetId``), ``name``,
  ``hasFacebook``, ``hasInstagram``, ``healthy``.
* ``GET /api/studio/pages/{pageId}/recent-posts[?refresh=1]``: ``{pageId, posts, checkedAt,
  platforms}``. ``posts`` are the page's newest Facebook posts and Instagram media, newest first,
  each only ``{id, platform ('fb'|'ig'), excerpt (<= 140 characters), imageUrl, permalink,
  createdAt}``. Another customer's page, or an id that is no linked page, is 404
  ``UNKNOWN_PAGE`` "This page is not linked to your account" (T12). Meta is read through the
  platform door (meta_ads.read_page_recent_posts / read_instagram_recent_media, with the page's
  token, paced on the page's lane, PLAN P3-00: refused while an app-wide Meta pause or a park of
  that page runs; the admin lane's own pause does not hold it up) at most once per 10 minutes per
  page and platform; ``refresh=1`` reads again when the list is older than a minute. ``platforms`` says per
  platform ``state`` (``ok``, ``paused`` = try again after ``retryAfterSeconds``, ``error`` with
  ``errorCode`` ``page_access`` or ``meta_error``) and when it was read; a platform Meta did not
  answer keeps its last list (up to a day old). Nothing to show because Meta is busy: 409
  ``META_PAUSED`` with Retry-After; Albayan's Meta connection not set up: 409
  ``META_NOT_CONFIGURED``. Never a 500 for a Meta problem. 10 reads a minute per user. A read
  Meta refuses for authorization runs the studio's token check (after_meta_authorization_failure).
* ``GET /api/studio/ad-options``: the goals (``goalDetail`` keys with their objective and main
  result) and the Libya location keys, with English and Arabic labels, for the wizard's chips.

The lists are kept in this process's memory only (the app runs one server process): they are
public page content, and PLAN §7.1 keeps metaHealthState to counts and flags. A restart forgets
them and the next read asks Meta again.

Submit rules (``enforce_source_post_rules``, called by ad_campaign_fields.prepare_ad_campaign_fields
in strict mode, i.e. at submit and again at approval):

* ``sourcePostId`` + ``sourcePostPlatform`` must be a post of one of the request owner's linked
  pages, else 400 "This post is not from your linked page" (T13). A Facebook post id is
  ``{page id}_{post id}``: its page part must be a linked Facebook page, checked without Meta, so
  a post of any age passes. An Instagram media id is looked up in the lists kept for the owner's
  Instagram accounts; at submit, when it is not there (a post older than the newest 10: an Extend
  or a Duplicate of an Instagram boost), Meta is asked ONCE about that media
  (meta_ads.read_instagram_media_owner, with the page's token) and it passes when its owner is a
  linked Instagram account (Meta busy or paused: 503 with Retry-After; another page's token is
  tried only when this one cannot see the media, at most MAX_IG_ACCOUNTS_CHECKED). At approval
  (the request is Submitted) Meta is not asked again: the post was checked at submit, so only the
  link to the account is re-checked.
* Submit checks the post FIRST (source_post_checked_first), before it takes one of main's two
  process-wide media validation places, and runs its strict validation inside that place with Meta
  reads off: an Instagram read never holds a place, so no other user's save, submit or approval
  gets a 503 because of it.
* A ``boost_post`` request needs a post: ``sourcePostId`` or the post link ``sourcePostRef``
  (normalize_ad_campaign_source_post_ref, unchanged). With either, it needs no objective, text,
  button, destination or photo of its own. A ``boost_page`` request needs its own text and
  photo. A boost with neither is 400 "Choose a post or add your own photo and text" (T11).
"""

import math
import re
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import text

from ... import meta_ads as _meta
from ...db import db_conn, json_fields_select_sql
from ...rate_limiter import check_rate_limit
from .ad_campaign_actions import normalize_ad_campaign_source_post_ref
from .ad_campaign_fields import (
    AD_CAMPAIGN_GOAL_DETAILS,
    LIBYA_LOCATIONS,
    SOURCE_POST_PLATFORMS,
    is_source_post_id,
)
from .social_studio import PAGES_TYPE
from .studio_errors import studio_error
from .studio_ig_poll import after_meta_authorization_failure

POSTS_PER_PLATFORM = 10
EXCERPT_MAX = 140
CACHE_FRESH_SECONDS = 10 * 60        # a list younger than this is shown without asking Meta
REFRESH_MIN_SECONDS = 60             # ?refresh=1 asks Meta only for a list older than this
CACHE_KEEP_SECONDS = 24 * 60 * 60    # an older list is kept (shown while Meta is busy, and for T13)
CACHE_MAX_ENTRIES = 500
DEFAULT_RETRY_SECONDS = 60
READ_WAIT_SECONDS = 30               # a second reader of the same list waits at most this long
MAX_IG_ACCOUNTS_CHECKED = 3
PAGES_READS_PER_MINUTE = 60
POSTS_READS_PER_MINUTE = 10
# Shared refusal prefixes (the Arabic map of the screens matches these exact texts).
PAGE_NOT_LINKED = "This page is not linked to your account"
POST_NOT_FROM_LINKED_PAGE = "This post is not from your linked page"
CHOOSE_POST_OR_OWN_CREATIVE = "Choose a post or add your own photo and text"
GOAL_LABELS: dict[str, tuple[str, str]] = {
    "messages": ("Messages", "رسائل"),
    "page_likes": ("Page likes", "إعجابات الصفحة"),
    "post_engagement": ("Post engagement", "التفاعل مع المنشور"),
    "video_views": ("Video views", "مشاهدات الفيديو"),
    "website_visits": ("Website visits", "زيارات الموقع"),
    "leads": ("Leads", "عملاء محتملون"),
    "sales": ("Sales", "مبيعات"),
}
_ROW_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
_NAME_MAX = 120

# (platform, Meta id) -> {"posts": [...], "readAt": monotonic seconds, "checkedAt": ISO time}
_CACHE: "OrderedDict[tuple[str, str], dict[str, Any]]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
# One reader per list at a time (a second one waits, then finds the first one's list).
_READ_LOCKS = tuple(threading.Lock() for _ in range(32))
_clock: Callable[[], float] = time.monotonic
# False while submit's strict validation runs inside main's media validation slot: the picked post
# was checked (with its Meta read) just before the slot was taken (source_post_checked_first).
_META_READS_ALLOWED: ContextVar[bool] = ContextVar("studio_posts_meta_reads_allowed", default=True)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clear_cache() -> None:
    """Forget every kept list (tests; an admin who unlinks a page does not need it)."""
    with _CACHE_LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# The owner's linked pages (socialPages rows, grouped per Meta page)
# ---------------------------------------------------------------------------


def _truthy(value: Any, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def owner_page_groups(owner_id: str) -> list[dict[str, Any]]:
    """The owner's linked (not unlinked) pages, one entry per Meta page, oldest link first.

    Server use only: the entries carry the Meta ids (``metaPageId``, ``igUserId``) and every row
    id of the page (``rowIds``); public_page() is what a browser gets.
    """
    owner_id = str(owner_id or "")
    if not _ROW_ID_RE.fullmatch(owner_id):
        return []
    sql = json_fields_select_sql(
        ("ownerId", "platform", "metaPageId", "igUserId", "name", "healthy"),
        ("id", "created_at"),
        "type = :type AND deleted = false AND created_by = :owner",
    )
    with db_conn() as conn:
        rows = conn.execute(text(sql), {"type": PAGES_TYPE, "owner": owner_id}).mappings().all()
    groups: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda r: (int(r.get("created_at") or 0), str(r.get("id") or ""))):
        if str(row.get("f_ownerid") or "") != owner_id:
            continue  # the row's owner field must agree with its created_by column
        platform = str(row.get("f_platform") or "")
        meta_page_id = re.sub(r"\D", "", str(row.get("f_metapageid") or ""))
        if platform not in SOURCE_POST_PLATFORMS or not meta_page_id:
            continue
        group = groups.setdefault(meta_page_id, {
            "metaPageId": meta_page_id, "rowIds": [], "fbRowId": "", "igRowId": "", "igUserId": "",
            "fbName": "", "igName": "", "healthy": True,
        })
        row_id = str(row.get("id") or "")
        group["rowIds"].append(row_id)
        name = _meta._clean_text(row.get("f_name"), _NAME_MAX)
        if platform == "fb" and not group["fbRowId"]:
            group.update({"fbRowId": row_id, "fbName": name})
        elif platform == "ig" and not group["igRowId"]:
            group.update({"igRowId": row_id, "igName": name,
                          "igUserId": re.sub(r"\D", "", str(row.get("f_iguserid") or ""))})
        group["healthy"] = group["healthy"] and _truthy(row.get("f_healthy"))
    return list(groups.values())


def public_page(group: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": group["fbRowId"] or group["igRowId"],
        "name": group["fbName"] or group["igName"] or "Page",
        "hasFacebook": bool(group["fbRowId"]),
        "hasInstagram": bool(group["igRowId"] and group["igUserId"]),
        "healthy": bool(group["healthy"]),
    }


def find_owner_page(owner_id: str, page_id: str) -> dict[str, Any]:
    """The owner's page that has this row id, else 404 UNKNOWN_PAGE (T12; also for another customer's page)."""
    page_id = str(page_id or "")
    if _ROW_ID_RE.fullmatch(page_id):
        for group in owner_page_groups(owner_id):
            if page_id in group["rowIds"]:
                return group
    studio_error(404, "UNKNOWN_PAGE", PAGE_NOT_LINKED)


# ---------------------------------------------------------------------------
# Recent posts: Meta through the platform door, kept in memory
# ---------------------------------------------------------------------------


def _excerpt(value: Any) -> str:
    words = " ".join(str(value or "").split())
    return words if len(words) <= EXCERPT_MAX else words[: EXCERPT_MAX - 1].rstrip() + "…"


def _boostable_link(value: Any) -> str:
    """The post link when it is one the ad wizard may send as ``sourcePostRef``, else ''."""
    try:
        return normalize_ad_campaign_source_post_ref(value, lambda raw, _field, maximum: str(raw or "").strip()[:maximum])
    except HTTPException:
        return ""


def _public_post(platform: str, row: Any) -> dict[str, str] | None:
    post_id = str(row.get("id") or "") if isinstance(row, dict) else ""
    if not is_source_post_id(post_id, platform):
        return None
    return {
        "id": post_id,
        "platform": platform,
        "excerpt": _excerpt(row.get("text")),
        "imageUrl": str(row.get("imageUrl") or ""),
        "permalink": _boostable_link(row.get("permalink")),
        "createdAt": str(row.get("createdAt") or ""),
    }


def _cache_get(key: tuple[str, str], max_age: float) -> dict[str, Any] | None:
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
    if entry and _clock() - entry["readAt"] <= max_age:
        return entry
    return None


def _cache_put(key: tuple[str, str], posts: list[dict[str, str]]) -> dict[str, Any]:
    entry = {"posts": posts, "readAt": _clock(), "checkedAt": _iso_now()}
    with _CACHE_LOCK:
        _CACHE[key] = entry
        _CACHE.move_to_end(key)
        now = _clock()
        for old in [k for k, v in _CACHE.items() if now - v["readAt"] > CACHE_KEEP_SECONDS]:
            del _CACHE[old]
        while len(_CACHE) > CACHE_MAX_ENTRIES:
            _CACHE.popitem(last=False)
    return entry


def _part(entry: dict[str, Any] | None, state: str, error_code: str = "", retry_after: int = 0) -> dict[str, Any]:
    return {
        "posts": list(entry["posts"]) if entry else [],
        "checkedAt": entry["checkedAt"] if entry else "",
        "state": state,
        "errorCode": error_code,
        "retryAfterSeconds": int(retry_after),
    }


def _pause_seconds(meta_page_id: str) -> int:
    """Seconds before the page's lane may read this page (PLAN P3-00): an app-wide Meta pause or a
    park of the page. The admin lane's own pause never holds these reads up."""
    return _meta.meta_lane_pause_seconds("page", meta_page_id)


def _retry_seconds(meta_page_id: str) -> int:
    return _pause_seconds(meta_page_id) or DEFAULT_RETRY_SECONDS


def read_platform_posts(platform: str, meta_page_id: str, ig_user_id: str, *, refresh: bool,
                        pause_seconds: int) -> dict[str, Any]:
    """One platform's list of a page: kept, or read from Meta now. Never raises for a Meta problem."""
    key = (platform, ig_user_id if platform == "ig" else meta_page_id)
    fresh_for = REFRESH_MIN_SECONDS if refresh else CACHE_FRESH_SECONDS
    entry = _cache_get(key, fresh_for)
    if entry:
        return _part(entry, "ok")
    if pause_seconds > 0:  # Albayan's Meta pause runs: nothing is asked, the last list is shown
        return _part(_cache_get(key, CACHE_KEEP_SECONDS), "paused", retry_after=pause_seconds)
    lock = _READ_LOCKS[hash(key) % len(_READ_LOCKS)]
    if not lock.acquire(timeout=READ_WAIT_SECONDS):
        return _part(_cache_get(key, CACHE_KEEP_SECONDS), "paused", retry_after=5)
    try:
        entry = _cache_get(key, fresh_for)  # another request read it while this one waited
        if entry:
            return _part(entry, "ok")
        try:
            if platform == "fb":
                rows = _meta.read_page_recent_posts(meta_page_id, limit=POSTS_PER_PLATFORM)
            else:
                rows = _meta.read_instagram_recent_media(meta_page_id, ig_user_id, limit=POSTS_PER_PLATFORM)
        except _meta.MetaAdsError as error:
            stale = _cache_get(key, CACHE_KEEP_SECONDS)
            if error.retryable:
                return _part(stale, "paused", retry_after=_retry_seconds(meta_page_id))
            if error.code == "authorization":
                after_meta_authorization_failure()
            return _part(stale, "error", "page_access" if error.code == "authorization" else "meta_error")
        posts = [post for post in (_public_post(platform, row) for row in rows) if post]
        return _part(_cache_put(key, posts[:POSTS_PER_PLATFORM]), "ok")
    finally:
        lock.release()


def read_recent_posts(group: dict[str, Any], *, refresh: bool = False) -> dict[str, Any]:
    """The recent-posts answer for one of the owner's pages (see the module docstring)."""
    if not _meta.load_meta_ads_config().configured:
        studio_error(409, "META_NOT_CONFIGURED",
                     "Albayan's Meta connection is not set up yet, so your posts cannot be listed. Paste the post link instead.")
    pause = _pause_seconds(group["metaPageId"])
    parts: dict[str, dict[str, Any]] = {}
    if group["fbRowId"]:
        parts["fb"] = read_platform_posts("fb", group["metaPageId"], "", refresh=refresh, pause_seconds=pause)
    if group["igRowId"] and group["igUserId"]:
        parts["ig"] = read_platform_posts("ig", group["metaPageId"], group["igUserId"], refresh=refresh,
                                          pause_seconds=pause)
    if parts and all(part["state"] == "paused" and not part["posts"] for part in parts.values()):
        retry = max(part["retryAfterSeconds"] for part in parts.values()) or DEFAULT_RETRY_SECONDS
        studio_error(409, "META_PAUSED", "Meta is busy right now, so your posts cannot be read. Try again in a minute.",
                     headers={"Retry-After": str(retry)})
    posts = sorted((post for part in parts.values() for post in part["posts"]),
                   key=lambda post: post["createdAt"], reverse=True)
    checked = [part["checkedAt"] for part in parts.values() if part["checkedAt"]]
    return {
        "pageId": public_page(group)["id"],
        "posts": posts,
        "checkedAt": min(checked) if checked else "",
        "platforms": {
            name: {key: part[key] for key in ("state", "checkedAt", "errorCode", "retryAfterSeconds")}
            for name, part in parts.items()
        },
    }


# ---------------------------------------------------------------------------
# Submit rules for the post a request boosts (T11, T13)
# ---------------------------------------------------------------------------


def _not_from_linked_page(reason: str = "") -> NoReturn:
    raise HTTPException(status_code=400, detail=POST_NOT_FROM_LINKED_PAGE + reason)


def _kept_list_has(key: tuple[str, str], post_id: str) -> bool:
    entry = _cache_get(key, CACHE_KEEP_SECONDS)
    return bool(entry) and any(post["id"] == post_id for post in entry["posts"])


def _meta_busy(retry_after: int) -> NoReturn:
    raise HTTPException(
        status_code=503,
        detail="Meta is busy right now, so the chosen post could not be checked. Try again in a minute.",
        headers={"Retry-After": str(max(int(retry_after or 0), 1))},
    )


def verify_source_post(owner_id: str, platform: str, post_id: str, *, may_read_meta: bool) -> None:
    """Raise T13 unless the post is from one of the owner's linked pages (see the module docstring)."""
    groups = owner_page_groups(owner_id)
    if platform == "fb":
        page_id = post_id.split("_", 1)[0]
        if any(group["fbRowId"] and group["metaPageId"] == page_id for group in groups):
            return
        _not_from_linked_page()
    accounts = [group for group in groups if group["igRowId"] and group["igUserId"]]
    if not accounts:
        _not_from_linked_page()
    if any(_kept_list_has(("ig", group["igUserId"]), post_id) for group in accounts):
        return
    if not may_read_meta or not _META_READS_ALLOWED.get():
        return  # approval: checked at submit; inside submit's media slot: checked just before it
    if not _meta.load_meta_ads_config().configured:
        _not_from_linked_page(" (Albayan's Meta connection is not set up, so the post cannot be checked; paste the post link instead)")
    checked = accounts[:MAX_IG_ACCOUNTS_CHECKED]
    pause = max(_pause_seconds(group["metaPageId"]) for group in checked)
    if pause > 0:  # an app-wide Meta pause, or a park of a page it would read with: nothing is asked
        _meta_busy(pause)
    linked = {group["igUserId"] for group in accounts}
    for group in checked:
        try:
            media = _meta.read_instagram_media_owner(group["metaPageId"], post_id)
        except _meta.MetaAdsError as error:
            if error.retryable:
                _meta_busy(_retry_seconds(group["metaPageId"]))
            if error.code == "authorization":
                after_meta_authorization_failure()
            continue  # this page's token cannot see the media (another account's, or deleted)
        if media["ownerId"]:
            if media["ownerId"] in linked:
                return
            break  # Meta named its owner: an account the customer has not linked
    _not_from_linked_page()


@contextmanager
def source_post_checked_first(stored: dict[str, Any]) -> Iterator[None]:
    """Submit: check the stored request's picked post (T13, with its one Meta read when needed)
    NOW, before the caller takes main's process-wide media validation slot, then run the block
    (the strict validation, inside the slot) with Meta reads off. A post id or platform of the
    wrong shape is left to that validation, which refuses it with its own message."""
    post_id = str(stored.get("sourcePostId") or "")
    platform = str(stored.get("sourcePostPlatform") or "")
    if post_id and platform in SOURCE_POST_PLATFORMS and is_source_post_id(post_id, platform):
        verify_source_post(str(stored.get("createdBy") or ""), platform, post_id, may_read_meta=True)
    token = _META_READS_ALLOWED.set(False)
    try:
        yield
    finally:
        _META_READS_ALLOWED.reset(token)


def enforce_source_post_rules(clean: dict[str, Any], raw_data: dict[str, Any]) -> bool:
    """Strict (submit and approval) rules for the post a request boosts.

    ``clean`` is the validated request, ``raw_data`` the stored one (its ``createdBy`` is the
    owner whose pages count; its ``status`` tells submit from approval). Returns True when the
    request boosts an existing post, which then needs no text, button, link or photo of its own.
    """
    post_id = str(clean.get("sourcePostId") or "")
    if post_id:
        platform = str(clean.get("sourcePostPlatform") or "")
        if platform not in SOURCE_POST_PLATFORMS or not is_source_post_id(post_id, platform):
            raise HTTPException(status_code=400, detail="sourcePostPlatform (fb or ig) must match sourcePostId before submission")
        at_submit = str(raw_data.get("status") or "Draft") != "Submitted"
        verify_source_post(str(raw_data.get("createdBy") or ""), platform, post_id, may_read_meta=at_submit)
    boost = str(clean.get("boostType") or "")
    if boost == "boost_post":
        if not (post_id or str(clean.get("sourcePostRef") or "").strip()):
            raise HTTPException(
                status_code=400,
                detail=f"{CHOOSE_POST_OR_OWN_CREATIVE}: a Boost Post request needs sourcePostId "
                       "(a post of your linked page) or sourcePostRef (the post link)",
            )
        return True
    if boost == "boost_page" and not (str(clean.get("primaryText") or "").strip() and clean.get("creativeImages")):
        raise HTTPException(
            status_code=400,
            detail=f"{CHOOSE_POST_OR_OWN_CREATIVE}: a Grow my page request needs primaryText and at least one photo",
        )
    return False


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def ad_options() -> dict[str, Any]:
    return {
        "goals": [
            {"key": key, "objective": objective, "resultType": result_type,
             "labelEn": GOAL_LABELS[key][0], "labelAr": GOAL_LABELS[key][1]}
            for key, (objective, result_type) in AD_CAMPAIGN_GOAL_DETAILS.items()
        ],
        "locations": [
            {"key": key, "labelEn": label_en, "labelAr": label_ar}
            for key, (label_en, label_ar) in LIBYA_LOCATIONS.items()
        ],
    }


def create_studio_posts_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """The page and post-picker reads, under the studio router's /api/studio prefix (reads only:
    no same-origin check, no audit)."""
    router = APIRouter()

    def rate_limit(user: dict[str, Any], bucket: str, per_minute: int) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    @router.get("/pages")
    def list_my_pages(user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "linked-pages", PAGES_READS_PER_MINUTE)
        return {"pages": [public_page(group) for group in owner_page_groups(str(user.get("id") or ""))]}

    @router.get("/pages/{page_id}/recent-posts")
    def recent_posts(page_id: str, refresh: bool = Query(False), user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "recent-posts", POSTS_READS_PER_MINUTE)
        group = find_owner_page(str(user.get("id") or ""), page_id)
        return read_recent_posts(group, refresh=refresh)

    @router.get("/ad-options")
    def get_ad_options(user: dict[str, Any] = Depends(current_user_dependency)):
        return ad_options()

    return router
