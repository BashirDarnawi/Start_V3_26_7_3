"""Instagram comments that Albayan reads itself (plan task P1-23; the P4-09 poll pass reuses it).

Instagram sends comment webhooks only after Meta's approval (Advanced Access, the app Live, a
public account; PLAN.md §0 findings 19 and 25). Until then, and for the App Review recording, an
admin presses "Check recent comments now" and the owner's rules answer as if the webhook had
delivered the comments.

Route (admin only; mounted under /api/studio by studio_api.create_studio_router):

* ``POST /api/studio/admin/pages/{page_id}/check-comments`` (``page_id`` = the socialPages row id
  of a linked Instagram account): reads the account's recent comments with Albayan's system token
  (as the P0-05e read test does) and feeds each NEW one into Social Studio's
  ``process_comment(source='manual_check')``. Same-origin; 10 presses a minute per admin and ONE
  check a minute per Instagram account (429 ``RATE_LIMITED`` with Retry-After); audited
  ``check_comments`` (counts and codes only; a kept audit action). Refusals: 403 ``CROSS_SITE`` /
  ``ADMIN_ONLY``, 404 ``UNKNOWN_PAGE``, 409 ``NOT_INSTAGRAM``, 409 ``META_NOT_CONFIGURED``, 409
  ``META_PAUSED`` with Retry-After (an app-wide Meta pause or a park of the linked page on the page
  lane, PLAN P3-00: nothing was read; when the pause began during the check the account's minute is
  given back). A read Meta refuses for authorization runs the studio's token check
  (after_meta_authorization_failure).

  The answer is counts only, ``{read, new, replied, skipped, errorCode}``:

  - ``read``: the comments Meta returned (media whose comment count did not change since the last
    check are not read again);
  - ``new``: the comments newer than the cursor, the owner's rules and the age limit (below). At
    most MAX_FED_PER_CHECK are fed per check, oldest first; the rest stay new for the next check;
  - ``replied``: new comments answered now (a public reply or a private message sent);
  - ``skipped`` = read - new: seen by an earlier check, older than 7 days, than the link or than
    every enabled Instagram rule of the owner, written by the account itself, or read without an
    author or a time;
  - ``errorCode``: Meta's error class when a read stopped early ('' otherwise), never Meta's text.

What is new (old comments are never answered):

* newer than the stored cursor: per recent media, the time of the newest comment already settled
  (and the ids settled in that same second), plus the media's comment count, so a media whose count
  did not change is not read again. A comment is settled when it was not new, or was fed without a
  crash; the cursor stops before a comment that crashed or waits for the next check, so it is fed
  again (the reply log keeps it from being answered twice);
* written in the last MAX_COMMENT_AGE (Meta's 7-day private-reply window);
* written after the account was linked to Albayan (its socialPages row was created; a webhook never
  delivers older comments either);
* not older than the earliest time one of the owner's enabled Instagram rules applied as it is now
  (its creation, or its ``activeSince``: switched on, or its platform, posts or trigger changed);
  process_comment then lets only rules active since before the comment answer it.

Dedupe: process_comment keeps ONE reply-log row per owner, platform and comment, whatever the
source, inserted as the claim before anything is sent. A comment answered by a check is never
answered again when the webhook delivers it later, nor the other way round.

The cursor lives in metaHealthState/"studioIgChecks" (through the platform door
meta_ads.save_meta_health_state, version-checked). Its keys and the comment ids it keeps are
derived ids (hashes), never Meta ids; otherwise it holds times and counts. Limits: at most IG_MEDIA_READ recent media and the newest
IG_COMMENTS_PER_MEDIA top-level comments of each (Meta's maximum per query); a comment deleted while
another is added between two checks leaves the count unchanged, so that media is not read again
until its count changes.
"""

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text

from ... import meta_ads as _meta
from ...db import db_conn, json_fields_select_sql
from ...rate_limiter import check_rate_limit, reset_rate_limit
from . import social_studio as _social
from .social_studio import PAGES_TYPE, RULES_TYPE
from .studio_errors import studio_error
from .studio_types import derived_id

IG_MEDIA_READ = 10           # recent media asked for
IG_MEDIA_WITH_COMMENTS = 5   # media whose comments the P0-05e read test reads (newest first)
IG_COMMENTS_PER_MEDIA = 50   # Meta's maximum per query; newest first since Graph API v3.2
CHECK_PRESSES_PER_MINUTE = 10   # per admin
CHECKS_PER_ACCOUNT_MINUTE = 1   # per Instagram account
MAX_COMMENT_AGE = timedelta(days=7)
MAX_FED_PER_CHECK = 20       # each may send a private message and a public reply, paced: a check stays short
CHECK_SOURCES = ("manual_check", "poll")
CHECK_STATE_ID = "studioIgChecks"
_ACCOUNTS_KEPT = 200
_MEDIA_KEPT = 20
_IDS_KEPT = 50
_ROW_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
_META_ID_RE = re.compile(r"[0-9]{1,40}")
_OFFSET_RE = re.compile(r"([+-]\d{2})(\d{2})$")
_REPLY_ACTIONS = frozenset({"dm", "public"})
_TRUE_TEXT = frozenset({"1", "true", "yes", "on"})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_second(second: int) -> str:
    return _iso(datetime.fromtimestamp(second, tz=timezone.utc))


def comment_second(value: Any) -> int | None:
    """Whole seconds since 1970 of an ISO time (Meta writes ``+0000``); None when unreadable."""
    raw = _OFFSET_RE.sub(r"\1:\2", str(value or "").strip().replace("Z", "+00:00"))
    if not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def account_bucket(ig_user_id: str) -> str:
    """The once-a-minute rate-limit key of one Instagram account (a hash, never the Meta id)."""
    return f"studio:check-comments-account:{derived_id('igc', ig_user_id)}"


def _media_key(ig_user_id: str, media_id: str) -> str:
    return derived_id("igm", ig_user_id, media_id)


def _comment_key(comment_id: str) -> str:
    return derived_id("igx", comment_id)


# ---------------------------------------------------------------------------
# Reading Meta (Albayan's system token, on the linked page's lane)
# ---------------------------------------------------------------------------


def read_recent_ig_comments(
    client: Any,
    ig_user_id: str,
    *,
    meta_page_id: str,
    with_text: bool,
    with_author: bool = False,
    media_limit: int = IG_MEDIA_WITH_COMMENTS,
    skip_media: Callable[[str, int], bool] | None = None,
) -> dict[str, Any]:
    """Recent media of the account, then the comments of the newest media that have any.

    Every read goes on the page lane for the linked Facebook page ``meta_page_id`` (PLAN P3-00a):
    a page limit parks that page only, and the admin lane's pause never holds these reads up.
    Returns counts, and the comments (id, time, media id; text and author id when asked) for this
    request only. ``media`` lists each media read with its comment count; ``mediaDone`` the media
    whose comments were read (``skip_media(media id, count)`` leaves one out: the check's cursor
    says nothing changed there). A Meta refusal stops the read: ``errorCode``/``providerCode`` say
    why (``pausedLocally``: Albayan's own Meta pause refused the call, so it never reached Meta).
    """
    out: dict[str, Any] = {"mediaRead": 0, "mediaWithComments": 0, "commentsRead": 0, "comments": [], "media": [],
                           "mediaDone": [], "errorCode": "", "providerCode": "", "pausedLocally": False}
    try:
        with _meta.meta_call_lane("page", subject=meta_page_id):
            media = client._get(f"{ig_user_id}/media", {"fields": "id,comments_count,timestamp", "limit": IG_MEDIA_READ})
            rows = [row for row in (media.get("data") or []) if isinstance(row, dict)][:IG_MEDIA_READ]
            out["mediaRead"] = len(rows)
            out["media"] = [{"id": str(row["id"]), "count": _meta._metric_int(row.get("comments_count"))}
                            for row in rows if _META_ID_RE.fullmatch(str(row.get("id") or ""))]
            commented = [row for row in rows if _meta._metric_int(row.get("comments_count")) > 0
                         and _META_ID_RE.fullmatch(str(row.get("id") or ""))]
            out["mediaWithComments"] = len(commented)
            fields = ("id,timestamp,text" if with_text else "id,timestamp") + (",from" if with_author else "")
            for row in commented[:media_limit]:
                media_id = str(row["id"])
                if skip_media is not None and skip_media(media_id, _meta._metric_int(row.get("comments_count"))):
                    continue
                payload = client._get(f"{media_id}/comments", {"fields": fields, "limit": IG_COMMENTS_PER_MEDIA})
                for item in payload.get("data") or []:
                    comment_id = str(item.get("id") or "") if isinstance(item, dict) else ""
                    if not _META_ID_RE.fullmatch(comment_id):
                        continue
                    comment = {"id": comment_id, "at": str(item.get("timestamp") or ""),
                               "text": str(item.get("text") or "") if with_text else "", "mediaId": media_id}
                    if with_author:
                        author = item.get("from") if isinstance(item.get("from"), dict) else {}
                        comment["fromId"] = str(author.get("id") or "")
                    out["comments"].append(comment)
                out["mediaDone"].append(media_id)
    except _meta.MetaAdsError as error:
        out["errorCode"], out["providerCode"] = error.code, error.provider_code
        out["pausedLocally"] = _meta.is_meta_pause_refusal(error)
    out["commentsRead"] = len(out["comments"])
    return out


# ---------------------------------------------------------------------------
# Albayan's own rows: the linked account, the owner's rules, the cursor
# ---------------------------------------------------------------------------


def _enabled(value: Any) -> bool:
    """A rule's ``enabled`` as SQLite (1/0) or PostgreSQL ('true'/'false') return it; missing = on."""
    return True if value is None else str(value).strip().lower() in _TRUE_TEXT


def load_instagram_page(page_id: str) -> dict[str, Any]:
    """The linked (not unlinked) studio page with this row id, which must be an Instagram account."""
    if not _ROW_ID_RE.fullmatch(str(page_id or "")):
        studio_error(404, "UNKNOWN_PAGE", "No linked page has this id")
    sql = json_fields_select_sql(("platform", "metaPageId", "igUserId", "ownerId"), ("id", "created_at"),
                                 "type = :type AND deleted = false AND id = :id")
    with db_conn() as conn:
        row = conn.execute(text(sql), {"type": PAGES_TYPE, "id": page_id}).mappings().first()
    meta_page_id = re.sub(r"\D", "", str((row or {}).get("f_metapageid") or ""))
    if not row or not meta_page_id:
        studio_error(404, "UNKNOWN_PAGE", "No linked page has this id")
    ig_user_id = re.sub(r"\D", "", str(row.get("f_iguserid") or ""))
    if str(row.get("f_platform") or "") != "ig" or not ig_user_id:
        studio_error(409, "NOT_INSTAGRAM", "This linked page is not an Instagram account")
    return {"id": str(row.get("id") or ""), "metaPageId": meta_page_id, "igUserId": ig_user_id,
            "ownerId": str(row.get("f_ownerid") or ""), "linkedSecond": int(row.get("created_at") or 0) // 1000}


def rule_floor_second(conn: Any, owner_id: str) -> int | None:
    """The earliest second from which one of the owner's enabled Instagram rules has applied as it is:
    per rule max(creation, ``activeSince``) as process_comment counts it (rule_active_since_ms; a rule
    from before activeSince has only its creation). None: no such rule."""
    if not owner_id:
        return None
    sql = json_fields_select_sql(("platform", "enabled", "ownerId", "activeSince"), ("created_at",),
                                 "type = :type AND deleted = false AND created_by = :owner")
    rows = conn.execute(text(sql), {"type": RULES_TYPE, "owner": owner_id}).mappings().all()
    seconds = [_social.rule_active_since_ms({"_created": row.get("created_at"), "activeSince": row.get("f_activesince")}) // 1000
               for row in rows
               if str(row.get("f_platform") or "") == "ig" and str(row.get("f_ownerid") or "") == owner_id
               and _enabled(row.get("f_enabled"))]
    return min(seconds) if seconds else None


def load_cursor(ig_user_id: str) -> dict[str, dict[str, Any]]:
    """The account's per-media cursor entries ({} before its first check)."""
    state = _meta.load_meta_health_state(CHECK_STATE_ID)
    accounts = state.get("accounts") if isinstance(state.get("accounts"), dict) else {}
    entry = accounts.get(derived_id("igc", ig_user_id))
    media = entry.get("media") if isinstance(entry, dict) and isinstance(entry.get("media"), dict) else {}
    return {key: value for key, value in media.items() if isinstance(value, dict)}


def _after_cursor(entry: dict[str, Any] | None, second: int, comment_key: str) -> bool:
    last = comment_second(entry.get("lastAt")) if entry else None
    if last is None or second != last:
        return last is None or second > last
    return comment_key not in set(entry.get("lastIds") or [])


def _advanced(entry: dict[str, Any] | None, comments: list[dict[str, Any]], unsettled: set[str], count: int,
              now_iso: str) -> dict[str, Any]:
    """The media's next cursor entry: past every settled comment in time order, up to the first
    one that crashed or waits for the next check. The count is kept only for a fully settled read."""
    last = comment_second(entry.get("lastAt")) if entry else None
    ids = [str(key) for key in (entry.get("lastIds") or [])] if entry and last is not None else []
    complete = True
    for comment in sorted(comments, key=lambda c: (c["second"], c["id"])):
        if comment["id"] in unsettled:
            complete = False
            break
        if last is not None and comment["second"] < last:
            continue
        if last is None or comment["second"] > last:
            last, ids = comment["second"], []
        key = _comment_key(comment["id"])
        if key not in ids:
            ids.append(key)
    return {"lastAt": _iso_second(last) if last is not None else "", "lastIds": ids[-_IDS_KEPT:],
            "count": count if complete else None, "seenAt": now_iso}


def _later(stored: Any, incoming: dict[str, Any]) -> dict[str, Any]:
    """A cursor never moves back (a slower check that started earlier cannot undo a newer one)."""
    if not isinstance(stored, dict):
        return incoming
    old, new = comment_second(stored.get("lastAt")), comment_second(incoming.get("lastAt"))
    if old is None or (new is not None and new > old):
        return incoming
    if new == old:
        ids = [str(key) for key in (stored.get("lastIds") or [])]
        ids += [key for key in incoming["lastIds"] if key not in ids]
        return {**incoming, "lastIds": ids[-_IDS_KEPT:]}
    return stored


def save_cursor(ig_user_id: str, updates: dict[str, dict[str, Any]], now_iso: str) -> bool:
    """Merge this check's media entries into the account's cursor (retried on a write race)."""
    account = derived_id("igc", ig_user_id)

    def update(current: dict[str, Any]) -> dict[str, Any]:
        stored = current.get("accounts") if isinstance(current.get("accounts"), dict) else {}
        accounts = {key: value for key, value in stored.items() if isinstance(value, dict)}
        media = accounts.get(account, {}).get("media")
        media = {k: v for k, v in media.items() if isinstance(v, dict)} if isinstance(media, dict) else {}
        for key, incoming in updates.items():
            media[key] = _later(media.get(key), incoming)
        newest = sorted(media.items(), key=lambda item: str(item[1].get("seenAt") or ""), reverse=True)[:_MEDIA_KEPT]
        accounts[account] = {"checkedAt": now_iso, "media": dict(newest)}
        kept = sorted(accounts.items(), key=lambda item: str(item[1].get("checkedAt") or ""), reverse=True)
        return {"accounts": dict(kept[:_ACCOUNTS_KEPT])}

    for _attempt in range(3):
        try:
            _meta.save_meta_health_state(CHECK_STATE_ID, update)
            return True
        except Exception:  # another check wrote the row first: read it again and merge
            continue
    return False


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def after_meta_authorization_failure() -> None:
    """Meta refused a studio read for authorization: the studio's token check runs, as it does for
    Social Studio's replies (studio_alerts_meta.after_authorization_failure: at most one Meta call
    per 10 minutes; only a token that is really invalid marks the connection down). Never raises."""
    from . import studio_alerts_meta  # late: it imports modules that are loaded with this one

    try:
        studio_alerts_meta.after_authorization_failure()
    except Exception as error:
        print(f"[albayan] Studio Meta connection check failed ({type(error).__name__}).")


def check_recent_comments(client: Any, page: dict[str, Any], *, source: str = "manual_check",
                          now: datetime | None = None) -> dict[str, Any]:
    """Read the account's recent comments and feed the new ones to process_comment (module docstring).

    Returns ``read``, ``new``, ``replied``, ``skipped`` plus ``errorCode``, ``providerCode``,
    ``mediaRead`` and ``pausedLocally`` (Albayan's Meta pause refused the read: nothing reached Meta).
    """
    if source not in CHECK_SOURCES:
        raise ValueError(f"Unknown check source {str(source)[:40]!r}")
    now = now or _now()
    now_iso = _iso(now)
    ig_user_id = page["igUserId"]
    cursor = load_cursor(ig_user_id)

    def unchanged(media_id: str, count: int) -> bool:
        entry = cursor.get(_media_key(ig_user_id, media_id))
        return bool(entry) and entry.get("count") == count

    read = read_recent_ig_comments(client, ig_user_id, meta_page_id=page["metaPageId"], with_text=True,
                                   with_author=True, media_limit=IG_MEDIA_READ, skip_media=unchanged)
    if read["errorCode"] == "authorization":
        after_meta_authorization_failure()
    with db_conn() as conn:
        floor = rule_floor_second(conn, page["ownerId"])
    if floor is not None:
        floor = max(floor, int(page.get("linkedSecond") or 0))  # the webhook never delivers comments from before the link
    oldest = int((now - MAX_COMMENT_AGE).timestamp())
    own_ids = {ig_user_id, page["metaPageId"]}
    comments: list[dict[str, Any]] = []
    fresh: list[dict[str, Any]] = []
    seen: set[str] = set()
    for comment in read["comments"]:
        if comment["id"] in seen:
            continue
        seen.add(comment["id"])
        second = comment_second(comment["at"])
        if second is None:
            continue  # never new, and it cannot move the cursor either
        comment["second"] = second
        comments.append(comment)
        author = comment.get("fromId") or ""
        if (_META_ID_RE.fullmatch(author) and author not in own_ids and second >= oldest
                and floor is not None and second >= floor
                and _after_cursor(cursor.get(_media_key(ig_user_id, comment["mediaId"])), second,
                                  _comment_key(comment["id"]))):
            fresh.append(comment)
    fresh.sort(key=lambda c: (c["second"], c["id"]))
    unsettled = {comment["id"] for comment in fresh[MAX_FED_PER_CHECK:]}  # left for the next check
    replied = 0
    for comment in fresh[:MAX_FED_PER_CHECK]:
        try:
            log = _social.process_comment(
                platform="ig", entry_id=ig_user_id, comment_id=comment["id"], post_ref=comment["mediaId"],
                from_id=comment["fromId"], text=comment["text"], source=source,
                comment_at=_iso_second(comment["second"]),
            )
        except Exception as error:  # fed again next time; the reply log keeps it from being answered twice
            unsettled.add(comment["id"])
            print(f"[albayan] Instagram comment check could not handle a comment ({type(error).__name__}).")
            continue
        actions = log.get("actions") if isinstance(log, dict) else None
        replied += bool(isinstance(actions, list) and _REPLY_ACTIONS & {str(action) for action in actions})
    counts = {m["id"]: m["count"] for m in read["media"]}
    updates = {
        _media_key(ig_user_id, media_id): _advanced(
            cursor.get(_media_key(ig_user_id, media_id)), [c for c in comments if c["mediaId"] == media_id],
            unsettled, counts.get(media_id, 0), now_iso)
        for media_id in read["mediaDone"]
    }
    if updates:
        save_cursor(ig_user_id, updates, now_iso)
    total = len(seen)
    read["comments"].clear()  # ids and texts never leave this request
    comments.clear()
    return {"read": total, "new": len(fresh), "replied": replied, "skipped": total - len(fresh),
            "errorCode": read["errorCode"], "providerCode": read["providerCode"], "mediaRead": read["mediaRead"],
            "pausedLocally": read["pausedLocally"]}


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def create_studio_ig_poll_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """The admin's "Check recent comments now", under the studio router's /api/studio prefix."""
    router = APIRouter(prefix="/admin")

    def require_admin(user: dict[str, Any]) -> None:
        if str(user.get("role") or "").lower() != "admin":
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    def rate_limit(key: str, allowed_count: int, message: str) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(key, allowed_count, 60_000)
        if not allowed:
            studio_error(429, "RATE_LIMITED", message,
                         headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))})

    def meta_paused(page: dict[str, Any], seconds: int = 0) -> NoReturn:
        wait = max(1, int(seconds or _meta.meta_lane_pause_seconds("page", page["metaPageId"]) or 60))
        studio_error(409, "META_PAUSED", "Meta asked Albayan to wait, so no comment was read. Try again in a few minutes.",
                     headers={"Retry-After": str(wait)})

    @router.post("/pages/{page_id}/check-comments")
    def check_comments(page_id: str, request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        require_admin(user)
        rate_limit(f"studio:check-comments:{user.get('id')}", CHECK_PRESSES_PER_MINUTE,
                   "Too many requests. Please wait and try again.")
        page = load_instagram_page(page_id)
        try:
            client = _meta.get_meta_ads_client()
        except _meta.MetaAdsError:
            studio_error(409, "META_NOT_CONFIGURED", "Albayan's Meta connection is not set up, so no comment was read")
        # The page lane of the linked page: an app-wide pause or a park of that page (never the admin
        # lane's own pause, which these reads do not wait for).
        pause = _meta.meta_lane_pause_seconds("page", page["metaPageId"])
        if pause:
            meta_paused(page, pause)  # before the account's minute is used
        bucket = account_bucket(page["igUserId"])
        rate_limit(bucket, CHECKS_PER_ACCOUNT_MINUTE,
                   "This Instagram account was checked less than a minute ago. Try again in a minute.")
        result = check_recent_comments(client, page)
        if result["pausedLocally"] and not result["mediaRead"]:
            reset_rate_limit(bucket)  # the pause began just now: nothing reached Meta, the minute is still free
            meta_paused(page)
        counts = {key: result[key] for key in ("read", "new", "replied", "skipped")}
        ctx["audit"](
            str(user.get("id") or "") or None, "check_comments", PAGES_TYPE, page["id"],
            f"Instagram comments checked: {counts['read']} read, {counts['new']} new, {counts['replied']} replied",
            {**counts, "source": "manual_check", "mediaRead": result["mediaRead"], "errorCode": result["errorCode"],
             "providerCode": result["providerCode"]},
        )
        return {**counts, "errorCode": result["errorCode"]}

    return router
