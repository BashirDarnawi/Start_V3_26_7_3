"""Studio health: the admin's fact reads and Meta check buttons (plan tasks P0-05c, P0-05d, P0-05e).

Routes (admin only; mounted under /api/studio by studio_api.create_studio_router):

* ``GET /api/studio/admin/facts``: the P0-01 facts (b, c, d, f, g, i, n1, s) as counts, flags,
  currencies, Meta error codes and ad-account LAST 4 DIGITS; never an id, a name or a text.
  (f) and (i) are Meta reads kept 24 hours (metaHealthState/"studioFacts", platform code in
  meta_ads.py): a plain GET shows the kept values with their age; ``?refresh=1`` (same-origin,
  2 per 10 minutes per admin, audited ``studio_facts_refresh``) asks Meta again. (m), the
  core/studio collision report, is built elsewhere. (s) reads Albayan Manager's ``ads`` rows,
  so it is computed by the platform helper meta_ads.core_spend_drift_facts (D36).
* ``POST /api/studio/admin/pages/{page_id}/subscribe-test`` (P0-05d): subscribes Albayan's app
  to the webhook fields Social Studio answers from (``POST /{page-id}/subscribed_apps`` with the
  page's token) for one linked studio page (``page_id`` = the socialPages row id). Once per
  Meta page per Tripoli day (409 ``ALREADY_TESTED_TODAY``); audited ``subscribe_smoke_test``;
  answers ok / error code only.
* ``POST /api/studio/admin/instagram/{page_id}/read-test`` (P0-05e): reads the recent comments
  of the Instagram professional account linked as that studio page, with Albayan's system
  token (P0-01 w). Once per Instagram account per Tripoli day; audited ``ig_read_test``;
  answers counts / error codes only. An optional body ``{replyToCommentId, text}`` (or
  ``{replyToCommentContaining, text}``: the newest comment read that contains a short code the
  helper wrote) sends ONE public reply with the page's token, like the auto-replies do. The
  reply is keyed by a derived id of account + comment and claimed before it is sent, so a
  second call never sends it again, not even on another day.

The once-a-day claims and the reply claims live in metaHealthState/"studioFactTests" (through
the platform door meta_ads.save_meta_health_state, one transaction with a version check, so
two presses at the same moment cannot both win). Their keys are derived ids (hashes), never
Meta ids. A claim is taken before Meta is called: a test that failed at Meta still used the day.

Facts (b) and (g) read socialReplyLog rows of the last 30 days (by the row's created_at):

* (b) Facebook private-reply failures: each ``dm: <message> (<Meta code>)`` part of a row's
  ``error`` counts once, by error class (meta_ads.meta_error_class) and by Meta code.
* (g) evidence: Facebook rows with a public reply and an empty ``error``. Albayan cannot tell a
  staff or test commenter from a customer (Meta sends page-scoped ids; Albayan keeps no Facebook
  id for its staff), so every commenter is counted and ``note`` says so; ``distinctCommenters``
  counts the different people (a count, never an id).
"""

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy import text

from ... import meta_ads as _meta
from ... import meta_collisions as _collisions
from ...db import db_conn, json_fields_select_sql, json_loads_or_raw
from ...rate_limiter import check_rate_limit
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .social_studio import LOG_TYPE, PAGES_TYPE, normalize_text
from .studio_diagnostics import CAMPAIGN_STATUSES, libya_today
from .studio_errors import studio_error
from .studio_types import derived_id

FACT_WINDOW_DAYS = 30
FACT_READS_PER_MINUTE = 20
FACT_REFRESHES = 2
FACT_REFRESH_WINDOW_MS = 10 * 60_000
TEST_PRESSES_PER_MINUTE = 10
IG_MEDIA_READ = 10           # recent media asked for
IG_MEDIA_WITH_COMMENTS = 5   # media whose comments are read (newest first)
IG_COMMENTS_PER_MEDIA = 50
REPLY_TEXT_MAX = 300
MATCH_TEXT_MIN, MATCH_TEXT_MAX = 3, 40
_TESTS_STATE_ID = "studioFactTests"
_TEST_DAYS_KEPT = 3
_REPLIES_KEPT = 500
_ROW_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
_META_ID_RE = re.compile(r"[0-9]{1,40}")
_ERROR_PART_RE = re.compile(r"(?:^|; )(dm|public|like): ")
_CODE_SUFFIX_RE = re.compile(r"\s*\(([0-9]{1,12}(?:\.[0-9]{1,12})?)\)\s*$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_REPLY_BODY_FIELDS = {"replyToCommentId", "replyToCommentContaining", "text"}
G_NOTE = (
    "Staff and test commenters cannot be told apart: Meta sends a page-scoped id per commenter and "
    "Albayan keeps no Facebook id for its staff, so every commenter is counted."
)
S_NOTE = "Hours run from the ad set's planned end time (metaEndTime); an ad stopped early looks later."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def tripoli_day(moment: datetime) -> str:
    return libya_today(moment).isoformat()


def _is_admin(user: dict[str, Any]) -> bool:
    return str(user.get("role") or "").lower() == "admin"


# ---------------------------------------------------------------------------
# Facts from Albayan Studio's own rows (b, c, g)
# ---------------------------------------------------------------------------


def _as_list(value: Any) -> list[Any]:
    value = json_loads_or_raw(value)
    return value if isinstance(value, list) else []


def load_reply_log_rows(conn: Any, since_ms: int) -> list[dict[str, Any]]:
    """socialReplyLog rows created since ``since_ms``: the four fields (b) and (g) need."""
    sql = json_fields_select_sql(
        ("platform", "actions", "error", "fromId"), (),
        "type = :type AND deleted = false AND created_at >= :since",
    )
    rows = conn.execute(text(sql), {"type": LOG_TYPE, "since": int(since_ms)}).mappings().all()
    return [
        {"platform": str(r.get("f_platform") or ""), "actions": [str(a) for a in _as_list(r.get("f_actions"))],
         "error": str(r.get("f_error") or ""), "fromId": str(r.get("f_fromid") or "")}
        for r in rows
    ]


def private_reply_failures(error: str) -> list[tuple[str, str]]:
    """(error class, Meta code or "none") for each ``dm: ...`` part of a reply-log error."""
    starts = list(_ERROR_PART_RE.finditer(error or ""))
    found = []
    for index, match in enumerate(starts):
        if match.group(1) != "dm":
            continue
        end = starts[index + 1].start() if index + 1 < len(starts) else len(error)
        part = error[match.end():end]
        code = _CODE_SUFFIX_RE.search(part)
        message = part[: code.start()] if code else part
        found.append((_meta.meta_error_class(message), code.group(1) if code else "none"))
    return found


def reply_facts(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(b) Facebook private-reply failures by class and code; (g) public replies without an error."""
    failed_rows = failures = dm_sent = public_ok = 0
    by_class: dict[str, int] = {}
    by_code: dict[str, int] = {}
    commenters: set[str] = set()
    for row in rows:
        if row["platform"] != "fb":
            continue
        dm_sent += "dm" in row["actions"]
        found = private_reply_failures(row["error"])
        failed_rows += bool(found)
        for error_class, code in found:
            failures += 1
            by_class[error_class] = by_class.get(error_class, 0) + 1
            by_code[code] = by_code.get(code, 0) + 1
        if "public" in row["actions"] and not row["error"].strip():
            public_ok += 1
            if row["fromId"]:
                commenters.add(row["fromId"])
    b = {"windowDays": FACT_WINDOW_DAYS, "rowsWithFailure": failed_rows, "failures": failures,
         "privateRepliesSent": dm_sent, "byClass": by_class, "byCode": by_code}
    g = {"windowDays": FACT_WINDOW_DAYS, "publicRepliesWithoutError": public_ok,
         "distinctCommenters": len(commenters), "staffExcluded": False, "note": G_NOTE}
    return b, g


def daily_budget_facts(conn: Any) -> dict[str, Any]:
    """(c) ad requests with a daily budget, by status (archived rows counted apart)."""
    sql = json_fields_select_sql(("status", "budgetType"), ("deleted",), "type = :type")
    rows = conn.execute(text(sql), {"type": AD_CAMPAIGN_COLLECTION}).mappings().all()
    by_status = {status: 0 for status in CAMPAIGN_STATUSES}
    by_status["other"] = 0
    live = archived = 0
    for row in rows:
        if str(row.get("f_budgettype") or "").strip().lower() != "daily":
            continue
        if row.get("deleted"):
            archived += 1
            continue
        live += 1
        status = str(row.get("f_status") or "Draft")
        by_status[status if status in by_status else "other"] += 1
    return {"total": live, "archived": archived, "byStatus": by_status}


def linked_pages(conn: Any, page_id: str = "") -> list[dict[str, str]]:
    """Linked (not unlinked) studio pages: row id, platform and the Meta ids (server use only)."""
    where = "type = :type AND deleted = false" + (" AND id = :id" if page_id else "")
    sql = json_fields_select_sql(("platform", "metaPageId", "igUserId"), ("id",), where)
    params = {"type": PAGES_TYPE, **({"id": page_id} if page_id else {})}
    return [
        {"id": str(r.get("id") or ""), "platform": str(r.get("f_platform") or ""),
         "metaPageId": re.sub(r"\D", "", str(r.get("f_metapageid") or "")),
         "igUserId": re.sub(r"\D", "", str(r.get("f_iguserid") or ""))}
        for r in conn.execute(text(sql), params).mappings().all()
    ]


def read_facts(*, refresh: bool = False, now: datetime | None = None) -> dict[str, Any]:
    """The whole facts payload. Meta is read only when ``refresh`` is set."""
    now = now or _now()
    since_ms = int((now - timedelta(days=FACT_WINDOW_DAYS)).timestamp() * 1000)
    with db_conn() as conn:
        log_rows = load_reply_log_rows(conn, since_ms)
        daily = daily_budget_facts(conn)
        pages = linked_pages(conn)
        collisions = _collisions.collision_report(conn)["counts"]  # (m): counts only, never the rows
    b, g = reply_facts(log_rows)
    meta_page_ids = sorted({page["metaPageId"] for page in pages if page["metaPageId"]})
    meta = _meta.studio_meta_facts(meta_page_ids, refresh=refresh)
    subscriptions = {**meta["pageSubscriptions"], "linkedPages": len(meta_page_ids)}
    return {
        "generatedAt": _iso(now),
        "windowDays": FACT_WINDOW_DAYS,
        "meta": {"configured": meta["configured"], "refreshed": meta["refreshed"], "busy": meta["busy"],
                 "maxAgeSeconds": _meta.STUDIO_FACTS_MAX_AGE_SECONDS},
        "facts": {
            "b": b,
            "c": daily,
            "d": {"allowlistConfigured": _meta.ad_account_allowlist_configured()},
            "f": meta["minDailyBudget"],
            "g": g,
            "i": subscriptions,
            "m": collisions,
            "n1": _meta.studio_funds_flags(),
            "s": {**_meta.core_spend_drift_facts(), "note": S_NOTE},
        },
    }


# ---------------------------------------------------------------------------
# Once-a-day and once-ever claims (metaHealthState/"studioFactTests")
# ---------------------------------------------------------------------------


class _Taken(Exception):
    """The key already holds a claim (today's test, or a reply that was already sent)."""


def _pruned(current: dict[str, Any], today: str) -> dict[str, Any]:
    oldest = (datetime.fromisoformat(today) - timedelta(days=_TEST_DAYS_KEPT - 1)).date().isoformat()
    out: dict[str, Any] = {}
    for section in ("subscribe", "igRead"):
        table = current.get(section) if isinstance(current.get(section), dict) else {}
        out[section] = {k: v for k, v in table.items() if isinstance(v, dict) and str(v.get("day") or "") >= oldest}
    replies = current.get("igReplies") if isinstance(current.get("igReplies"), dict) else {}
    newest = sorted((item for item in replies.items() if isinstance(item[1], dict)),
                    key=lambda item: str(item[1].get("at") or ""), reverse=True)[:_REPLIES_KEPT]
    out["igReplies"] = dict(newest)
    return out


def _write_claims(change: Callable[[dict[str, Any]], None], today: str) -> None:
    """Apply ``change`` to the claims record in one transaction (retried on a write race)."""
    def update(current: dict[str, Any]) -> dict[str, Any]:
        state = _pruned(current, today)
        change(state)
        return state

    for attempt in range(3):
        try:
            _meta.save_meta_health_state(_TESTS_STATE_ID, update)
            return
        except _Taken:
            raise
        except Exception:  # another press wrote the record first: read it again and re-check
            if attempt == 2:
                raise


def claim(section: str, key: str, entry: dict[str, Any], today: str, *, per_day: bool) -> None:
    """Take ``key`` (raises _Taken when it is taken: today's claim, or any claim if not per_day)."""
    def change(state: dict[str, Any]) -> None:
        existing = state[section].get(key)
        if isinstance(existing, dict) and (not per_day or existing.get("day") == today):
            raise _Taken()
        state[section][key] = entry

    _write_claims(change, today)


def record(section: str, key: str, result: dict[str, Any], today: str) -> None:
    """Add a test's result to its claim (best effort: the audit entry has it too)."""
    def change(state: dict[str, Any]) -> None:
        state[section][key] = {**(state[section].get(key) or {}), **result}

    try:
        _write_claims(change, today)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Instagram read test (P0-05e)
# ---------------------------------------------------------------------------


def read_recent_ig_comments(client: Any, ig_user_id: str, *, with_text: bool) -> dict[str, Any]:
    """Recent media of the account, then the comments of the newest media that have any.

    Returns counts, and the comments (id, time, text when asked) for this request only.
    A Meta refusal stops the read: ``errorCode``/``providerCode`` say why.
    """
    out: dict[str, Any] = {"mediaRead": 0, "mediaWithComments": 0, "commentsRead": 0, "comments": [],
                           "errorCode": "", "providerCode": ""}
    try:
        media = client._get(f"{ig_user_id}/media", {"fields": "id,comments_count,timestamp", "limit": IG_MEDIA_READ})
        rows = [row for row in (media.get("data") or []) if isinstance(row, dict)][:IG_MEDIA_READ]
        out["mediaRead"] = len(rows)
        commented = [row for row in rows if _meta._metric_int(row.get("comments_count")) > 0
                     and _META_ID_RE.fullmatch(str(row.get("id") or ""))]
        out["mediaWithComments"] = len(commented)
        fields = "id,timestamp,text" if with_text else "id,timestamp"
        for row in commented[:IG_MEDIA_WITH_COMMENTS]:
            payload = client._get(f"{row['id']}/comments", {"fields": fields, "limit": IG_COMMENTS_PER_MEDIA})
            for item in payload.get("data") or []:
                comment_id = str(item.get("id") or "") if isinstance(item, dict) else ""
                if _META_ID_RE.fullmatch(comment_id):
                    out["comments"].append({"id": comment_id, "at": str(item.get("timestamp") or ""),
                                            "text": str(item.get("text") or "") if with_text else ""})
    except _meta.MetaAdsError as error:
        out["errorCode"], out["providerCode"] = error.code, error.provider_code
    out["commentsRead"] = len(out["comments"])
    return out


def reply_target(comments: list[dict[str, Any]], comment_id: str, containing: str) -> str:
    """The comment to answer: the given id if it was read, else the newest one holding the code."""
    if comment_id:
        return comment_id if any(c["id"] == comment_id for c in comments) else ""
    wanted = normalize_text(containing)
    matches = [c for c in comments if wanted and wanted in normalize_text(c["text"])]
    return max(matches, key=lambda c: c["at"])["id"] if matches else ""


def _reply_request(body: Any) -> tuple[str, str, str]:
    """(comment id, code to look for, reply text); all empty when no reply is asked for."""
    if body is None:
        return "", "", ""
    if not isinstance(body, dict):
        studio_error(400, "INVALID_REQUEST", "Send {replyToCommentId, text} or {replyToCommentContaining, text}, or no body")
    extra = sorted(set(body) - _REPLY_BODY_FIELDS)
    if extra:
        studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{str(extra[0])[:40]}'")
    comment_id = str(body.get("replyToCommentId") or "").strip()
    containing = _CONTROL_RE.sub("", str(body.get("replyToCommentContaining") or "")).strip()
    reply = _CONTROL_RE.sub("", str(body.get("text") or "")).strip()
    if not (comment_id or containing or reply):
        return "", "", ""
    if bool(comment_id) == bool(containing):
        studio_error(400, "INVALID_REQUEST", "Name the comment by replyToCommentId or by replyToCommentContaining (one of them)")
    if comment_id and not _META_ID_RE.fullmatch(comment_id):
        studio_error(400, "INVALID_VALUE", "replyToCommentId must be the numeric Instagram comment id")
    if containing and not MATCH_TEXT_MIN <= len(containing) <= MATCH_TEXT_MAX:
        studio_error(400, "INVALID_VALUE", f"replyToCommentContaining must be {MATCH_TEXT_MIN}-{MATCH_TEXT_MAX} characters")
    if not reply or len(reply) > REPLY_TEXT_MAX:
        studio_error(400, "INVALID_VALUE", f"text (the reply, 1-{REPLY_TEXT_MAX} characters) is required with a comment")
    return comment_id, containing, reply


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def create_studio_checks_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """The admin checks, under the studio router's /api/studio prefix."""
    router = APIRouter(prefix="/admin")

    def require_admin(user: dict[str, Any]) -> None:
        if not _is_admin(user):
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    def rate_limit(user: dict[str, Any], bucket: str, allowed_count: int, window_ms: int = 60_000) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", allowed_count, window_ms)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def load_page(page_id: str) -> dict[str, str]:
        if not _ROW_ID_RE.fullmatch(str(page_id or "")):
            studio_error(404, "UNKNOWN_PAGE", "No linked page has this id")
        with db_conn() as conn:
            found = linked_pages(conn, page_id)
        if not found or not found[0]["metaPageId"]:
            studio_error(404, "UNKNOWN_PAGE", "No linked page has this id")
        return found[0]

    def require_meta() -> Any:
        try:
            return _meta.get_meta_ads_client()
        except _meta.MetaAdsError:
            studio_error(409, "META_NOT_CONFIGURED", "Albayan's Meta connection is not set up, so nothing was tested")

    def claim_today(section: str, key: str, today: str, now: datetime) -> None:
        try:
            claim(section, key, {"day": today, "state": "running", "at": _iso(now)}, today, per_day=True)
        except _Taken:
            studio_error(409, "ALREADY_TESTED_TODAY", "This was already tested today (Tripoli time). Try again tomorrow.")

    @router.get("/facts")
    def get_studio_facts(
        request: Request,
        refresh: bool = Query(default=False),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        require_admin(user)
        rate_limit(user, "facts", FACT_READS_PER_MINUTE)
        if refresh:
            same_origin(request)
            rate_limit(user, "facts-refresh", FACT_REFRESHES, FACT_REFRESH_WINDOW_MS)
        report = read_facts(refresh=refresh)
        if refresh:
            facts = report["facts"]
            ctx["audit"](
                str(user.get("id") or "") or None, "studio_facts_refresh", "studioFacts", "meta",
                "Admin re-read the studio Meta facts",
                {"configured": report["meta"]["configured"], "refreshed": report["meta"]["refreshed"],
                 "accountsRead": len(facts["f"].get("accounts") or []), "pagesChecked": facts["i"].get("pagesChecked", 0)},
            )
        return report

    @router.post("/pages/{page_id}/subscribe-test")
    def subscribe_test(page_id: str, request: Request, user: dict[str, Any] = Depends(current_user_dependency)):
        same_origin(request)
        require_admin(user)
        rate_limit(user, "fact-tests", TEST_PRESSES_PER_MINUTE)
        page = load_page(page_id)
        client = require_meta()
        now = _now()
        today = tripoli_day(now)
        key = derived_id("sft", "subscribe", page["metaPageId"])
        claim_today("subscribe", key, today, now)
        fields = ",".join(_meta.STUDIO_PAGE_WEBHOOK_FIELDS)
        ok, code, provider = False, "", ""
        try:
            token = client.page_access_token(page["metaPageId"])
            answer = client._post(f"{page['metaPageId']}/subscribed_apps", {"subscribed_fields": fields}, access_token=token)
            ok = answer.get("success") is True
            code = "" if ok else "not_confirmed"
        except _meta.MetaAdsError as error:
            code, provider = error.code, error.provider_code
        record("subscribe", key, {"state": "done", "ok": ok, "errorCode": code}, today)
        ctx["audit"](
            str(user.get("id") or "") or None, "subscribe_smoke_test", PAGES_TYPE, page["id"],
            f"Webhook subscribe test on a linked page: {'ok' if ok else code}",
            {"ok": ok, "errorCode": code, "providerCode": provider, "day": today, "fields": fields},
        )
        return {"ok": ok, "errorCode": code, "providerCode": provider, "testedOn": today, "fields": fields.split(",")}

    @router.post("/instagram/{page_id}/read-test")
    def instagram_read_test(
        page_id: str,
        request: Request,
        body: Any = Body(None),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        same_origin(request)
        require_admin(user)
        rate_limit(user, "fact-tests", TEST_PRESSES_PER_MINUTE)
        page = load_page(page_id)
        if page["platform"] != "ig" or not page["igUserId"]:
            studio_error(409, "NOT_INSTAGRAM", "This linked page is not an Instagram account")
        comment_id, containing, reply = _reply_request(body)
        client = require_meta()
        now = _now()
        today = tripoli_day(now)
        key = derived_id("sft", "igread", page["igUserId"])
        claim_today("igRead", key, today, now)
        read = read_recent_ig_comments(client, page["igUserId"], with_text=bool(containing))
        result: dict[str, Any] = {
            "testedOn": today, "mediaRead": read["mediaRead"], "mediaWithComments": read["mediaWithComments"],
            "commentsRead": read["commentsRead"], "errorCode": read["errorCode"], "providerCode": read["providerCode"],
            "replyRequested": bool(reply), "replyTargetFound": None, "replySent": False, "alreadyReplied": False,
            "replyErrorCode": "",
        }
        if reply:
            target = reply_target(read["comments"], comment_id, containing)
            result["replyTargetFound"] = bool(target)
            if not target:
                result["replyErrorCode"] = "comment_not_found" if not read["errorCode"] else "comments_not_read"
            else:
                reply_key = derived_id("sfr", page["igUserId"], target)
                try:
                    claim("igReplies", reply_key, {"state": "sending", "at": _iso(now)}, today, per_day=False)
                except _Taken:
                    result["alreadyReplied"] = True
                else:
                    state = "failed"
                    try:
                        token = client.page_access_token(page["metaPageId"])
                        client._post(f"{target}/replies", {"message": reply}, access_token=token)
                        state, result["replySent"] = "sent", True
                    except _meta.MetaAdsError as error:
                        result["replyErrorCode"] = error.code
                        state = "unknown" if error.code == "timeout" else "failed"  # a timed-out send may have landed
                    record("igReplies", reply_key, {"state": state, "errorCode": result["replyErrorCode"]}, today)
        record("igRead", key, {"state": "done", "errorCode": read["errorCode"], "commentsRead": read["commentsRead"]}, today)
        read["comments"].clear()  # ids and texts never leave this request
        ctx["audit"](
            str(user.get("id") or "") or None, "ig_read_test", PAGES_TYPE, page["id"],
            f"Instagram read test: {read['commentsRead']} comments read" + (", reply sent" if result["replySent"] else ""),
            {key_name: result[key_name] for key_name in (
                "testedOn", "mediaRead", "mediaWithComments", "commentsRead", "errorCode", "providerCode",
                "replyRequested", "replyTargetFound", "replySent", "alreadyReplied", "replyErrorCode")},
        )
        return result

    return router
