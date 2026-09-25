"""Instagram polling source (plan task P4-09; PLAN.md §7.4 "Instagram polling", §8.2 "IG comments by
polling (road 1)"; DECISIONS D8a, D24, D34).

Instagram sends comment webhooks only after Meta's approval. Until then Albayan reads the recent
comments of every linked Instagram account itself, with its system token, and the owner's rules
answer them as if the webhook had delivered them: the P1-23 reader of studio_ig_poll.py (the admin's
"Check recent comments now" keeps its route and its once-a-minute limit). ONE setting switches the
source on, ``capabilities.igPublicReply = 'poll'`` (studio_settings.py; an admin sets it only after
fact P0-01(w) passed). On, gated, off or unavailable: the jobs loop never claims the job and nothing
here reads Meta.

* **Where it runs.** One job of the studio jobs loop (studio_jobs.py, ``ig_poll``): one budgeted pass
  per tick, claimed in the tick's heartbeat write like the other jobs, only while a Meta token is
  set AND the capability says poll (``ig_poll_configured``). A pass (``run_ig_poll``) starts no
  account after PASS_MAX_READS Meta reads (20) or PASS_MAX_SECONDS (10 s), and none at all while the
  page lane is paused app-wide or Albayan's Meta connection is down (studio_alerts_meta: every read
  would be refused and the replies parked; the Meta watch rechecks the connection).
* **Which accounts.** Every linked Instagram account (a ``socialPages`` row with platform ``ig``,
  not unlinked) whose owner has an enabled Instagram rule with a known creation; an owner whose
  subscription lapsed is not read (their rules cannot answer, social_studio._owner_can_automate).
  Each read goes on the PAGE lane of the linked Facebook page (meta_call_lane('page',
  subject=<metaPageId>), PLAN P3-00): a park of that page (a page throttle) holds only that
  account, whose next poll waits for the park to end; the admin lane's pause never holds a poll up.
* **How often.** Every account is polled every POLL_EVERY_SECONDS (5 minutes, PLAN §7.4). The due
  accounts are polled in the order they came due (never polled first), and the ones the budget did
  not reach stay due for the next tick (30 s later) instead of being skipped. When a pass runs out
  of budget with accounts still due (an overrun), the interval of the BUSIEST accounts of that pass
  grows by GROWTH (x1.5) up to POLL_MAX_SECONDS (30 minutes): the accounts whose polls cost the most
  reads (the media list plus one read per media whose comment count changed): at least the pass's
  median, and more than the media list alone; when no poll cost more than the media list the number
  of accounts is the load, and every polled one grows. A pass that ends within half its budget
  shrinks every lengthened interval the same way, down to 5 minutes (``adjust_intervals``, pure).
  A Meta error (kept as the error class and Meta's code, never Meta's text) puts the account back
  in ERROR_RETRY (15 minutes); comments the reader left for the next check (its MAX_FED_PER_CHECK
  cap, a crash) bring the next poll forward to WAITING_RETRY (1 minute).
* **What is answered.** studio_ig_poll.check_recent_comments(source='poll'): only comments newer
  than the account's cursor, than the link and than the earliest enabled Instagram rule of the owner
  (its creation or ``activeSince``; process_comment then lets only rules active since before the
  comment answer it), written in the last 7 days, by someone else than the account. Each is fed to
  social_studio.process_comment, which keeps ONE reply-log row per owner, platform and comment
  whatever the source: a comment answered by a poll is never answered again when the webhook
  delivers it later, nor the other way round. The manual check and the poll share one cursor
  (metaHealthState/"studioIgChecks"), so neither reads again what the other settled.
* **State.** metaHealthState/"studioIgPoll", a platform record written through meta_ads' door like
  the cursor (version-checked, retried on a write race): per account, keyed by the cursor's account
  hash (never a Meta id), the next poll time, the interval, the last poll's time, outcome, reads and
  counts, and the last error code; plus the last pass's counts. At most ACCOUNTS_KEPT accounts (the
  most recently polled) are kept. The jobs heartbeat shows ``lastIgPollAt`` (studio_jobs.py).
"""

import os
import re
import statistics
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import text

from ... import meta_ads as _meta
from ...db import db_conn, json_fields_select_sql
from . import social_studio as _social
from . import studio_ig_poll as _reader
from .social_studio import PAGES_TYPE, RULES_TYPE
from .studio_alerts_meta import connection_down
from .studio_diagnostics import parse_time
from .studio_settings import read_all_settings
from .studio_types import derived_id

POLL_STATE_ID = "studioIgPoll"  # metaHealthState row (platform record, meta_ads door)
POLL_CAPABILITY = "poll"  # capabilities.igPublicReply (studio_settings.CAPABILITY_CHANNELS)
POLL_EVERY_SECONDS = 5 * 60  # PLAN.md §7.4: each account every 5 minutes
POLL_MAX_SECONDS = 30 * 60  # the interval of a busy account never grows past this
GROWTH = 1.5  # an overrun lengthens the busiest accounts' interval by this; a light pass shrinks it back
PASS_MAX_READS = 20  # a pass starts no account after this many Meta reads ...
PASS_MAX_SECONDS = 10.0  # ... or after this much wall time
ERROR_RETRY = timedelta(minutes=15)
WAITING_RETRY = timedelta(minutes=1)  # comments left for the next check (studio_ig_poll MAX_FED_PER_CHECK, a crash)
MIN_PARK_WAIT = 30  # a parked account is not looked at again before this
ACCOUNTS_KEPT = 200
STATE_WRITE_ATTEMPTS = 3
META_TOKEN_ENV = "ALBAYAN_META_ACCESS_TOKEN"
OUTCOMES = ("polled", "parked", "error", "owner_inactive")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_NOT_DIGITS_RE = re.compile(r"\D")


# ------------------------------------------------------------------ small helpers

def utc_now() -> datetime:
    """The pass's clock (looked up at call time, so tests can fix it)."""
    return datetime.now(timezone.utc)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def token_set() -> bool:
    """True while Albayan's Meta token is set, read from the environment only (the jobs loop asks on
    every tick and must not build the Meta config for it; studio_alerts_meta.meta_watch_configured's rule)."""
    return bool(str(os.environ.get(META_TOKEN_ENV) or "").strip())


def poll_capability(settings: dict[str, Any] | None = None) -> str:
    """The stored ``capabilities.igPublicReply`` state ('' when unreadable, or when the settings row
    cannot be read right now: a tick whose claim this decides goes on without the poll)."""
    try:
        settings = settings or read_all_settings()
    except Exception:
        return ""
    capabilities = settings.get("capabilities") if isinstance(settings.get("capabilities"), dict) else {}
    return str(capabilities.get("igPublicReply") or "")


def ig_poll_configured(settings: dict[str, Any] | None = None) -> bool:
    """True while a Meta token is set AND capabilities.igPublicReply is 'poll': the jobs loop's only
    condition for claiming the poll job. The environment is checked first: without a token no
    settings row is read."""
    return token_set() and poll_capability(settings) == POLL_CAPABILITY


def account_key(ig_user_id: Any) -> str:
    """The state and cursor key of one Instagram account: a hash, never the Meta id
    (studio_ig_poll.load_cursor keys its accounts the same way)."""
    return derived_id("igc", ig_user_id)


def _owner_active(owner_id: str) -> bool:
    """The owner's rules can answer today (an active ad_maker subscription; the same rule
    process_comment applies). A process without the Social Studio router leaves it to process_comment."""
    try:
        return bool(_social._owner_can_automate(owner_id))
    except RuntimeError:
        return True


# ------------------------------------------------------------------ Albayan's own rows

def linked_instagram_accounts(conn: Any) -> list[dict[str, Any]]:
    """Every linked Instagram account, by row id: ``{id, metaPageId, igUserId, ownerId, linkedSecond}``
    (the shape studio_ig_poll.load_instagram_page gives; ``linkedSecond`` is the reader's
    linked_second: the relink time of a revived row, P4-01). One query; the JSON is parsed once per row."""
    sql = json_fields_select_sql(_reader.PAGE_LINK_FIELDS, ("id", "created_at"), "type = :type AND deleted = false")
    out: list[dict[str, Any]] = []
    for row in conn.execute(text(sql), {"type": PAGES_TYPE}).mappings().all():
        if str(row.get("f_platform") or "") != "ig":
            continue
        meta_page_id = _NOT_DIGITS_RE.sub("", str(row.get("f_metapageid") or ""))
        ig_user_id = _NOT_DIGITS_RE.sub("", str(row.get("f_iguserid") or ""))
        owner_id = str(row.get("f_ownerid") or "")
        if not (meta_page_id and ig_user_id and owner_id):
            continue
        out.append({"id": str(row.get("id") or ""), "metaPageId": meta_page_id, "igUserId": ig_user_id,
                    "ownerId": owner_id, "linkedSecond": _reader.linked_second(row)})
    return sorted(out, key=lambda page: page["id"])


def owners_with_instagram_rules(conn: Any) -> set[str]:
    """The owners with at least one enabled Instagram rule that applies from a known time
    (studio_ig_poll.rule_floor_second's rule, over every owner in one query)."""
    sql = json_fields_select_sql(("platform", "enabled", "ownerId", "activeSince"), ("created_at", "created_by"),
                                 "type = :type AND deleted = false")
    owners: set[str] = set()
    for row in conn.execute(text(sql), {"type": RULES_TYPE}).mappings().all():
        owner = str(row.get("f_ownerid") or "")
        if (owner and owner == str(row.get("created_by") or "") and str(row.get("f_platform") or "") == "ig"
                and _reader._enabled(row.get("f_enabled"))
                and _social.rule_active_since_ms({"_created": row.get("created_at"), "activeSince": row.get("f_activesince")}) > 0):
            owners.add(owner)
    return owners


# ------------------------------------------------------------------ the state row

def load_poll_state() -> dict[str, Any]:
    """``{accounts: {key: entry}, lastPassAt, lastPass}`` from metaHealthState/"studioIgPoll" ({} entries
    before the first pass)."""
    stored = _meta.load_meta_health_state(POLL_STATE_ID)
    accounts = stored.get("accounts") if isinstance(stored.get("accounts"), dict) else {}
    last_pass = stored.get("lastPass") if isinstance(stored.get("lastPass"), dict) else {}
    return {"accounts": {key: value for key, value in accounts.items() if isinstance(value, dict)},
            "lastPassAt": str(stored.get("lastPassAt") or "") or None, "lastPass": dict(last_pass)}


def _save_poll_state(updates: dict[str, dict[str, Any]], last_pass: dict[str, Any], now_iso: str) -> bool:
    """Merge this pass's account entries into the row (retried on a write race); the most recently
    polled ACCOUNTS_KEPT accounts are kept."""
    def update(current: dict[str, Any]) -> dict[str, Any]:
        stored = current.get("accounts") if isinstance(current.get("accounts"), dict) else {}
        accounts = {key: value for key, value in stored.items() if isinstance(value, dict)}
        accounts.update(updates)
        kept = sorted(accounts.items(), key=lambda item: str(item[1].get("lastAt") or ""), reverse=True)[:ACCOUNTS_KEPT]
        return {"accounts": dict(kept), "lastPassAt": now_iso, "lastPass": last_pass}

    for _attempt in range(STATE_WRITE_ATTEMPTS):
        try:
            _meta.save_meta_health_state(POLL_STATE_ID, update)
            return True
        except Exception:  # another process wrote the row first, or the database is away: read again
            continue
    return False


def interval_of(entry: dict[str, Any] | None) -> int:
    """An account's poll interval in seconds, within [POLL_EVERY_SECONDS, POLL_MAX_SECONDS]."""
    try:
        value = int(float((entry or {}).get("everySeconds") or POLL_EVERY_SECONDS))
    except (TypeError, ValueError, OverflowError):
        value = POLL_EVERY_SECONDS
    return min(max(value, POLL_EVERY_SECONDS), POLL_MAX_SECONDS)


def due_accounts(pages: list[dict[str, Any]], state: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    """The accounts whose next poll has come (never polled: due now), the longest waiting first."""
    due: list[tuple[datetime, str, dict[str, Any]]] = []
    for page in pages:
        entry = state["accounts"].get(account_key(page["igUserId"])) or {}
        next_at = parse_time(entry.get("nextAt")) or _EPOCH
        if next_at <= now:
            due.append((next_at, page["id"], page))
    return [page for _next_at, _page_id, page in sorted(due, key=lambda item: (item[0], item[1]))]


def adjust_intervals(
    polled: list[tuple[str, int, int]], *, overrun: bool, reads: int, max_reads: int = PASS_MAX_READS,
) -> dict[str, int]:
    """(PURE) The new interval of the polled accounts that change: ``polled`` = (key, reads used,
    current interval) per account polled this pass.

    An overrun (accounts still due when the budget ran out) lengthens the busiest accounts by GROWTH
    up to POLL_MAX_SECONDS: reads at least the pass's median and more than the media list alone (1);
    when no poll cost more than the media list, every polled account (the number of accounts is the
    load). A pass within half its budget shrinks every lengthened interval by GROWTH, down to
    POLL_EVERY_SECONDS. Anything else keeps its interval.
    """
    changed: dict[str, int] = {}
    if not polled:
        return changed
    if overrun:
        median = statistics.median(used for _key, used, _every in polled)
        busy = [item for item in polled if item[1] >= median and item[1] > 1] or list(polled)
        for key, _used, every in busy:
            longer = min(int(every * GROWTH), POLL_MAX_SECONDS)
            if longer != every:
                changed[key] = longer
    elif reads * 2 <= max_reads:
        for key, _used, every in polled:
            shorter = max(int(every / GROWTH), POLL_EVERY_SECONDS)
            if shorter != every:
                changed[key] = shorter
    return changed


# ------------------------------------------------------------------ the pass (the jobs loop)

def _error_code(result: dict[str, Any]) -> str:
    code = str(result.get("errorCode") or "")
    provider = str(result.get("providerCode") or "")
    return (f"{code}:{provider}" if provider else code)[:60]


def run_ig_poll(
    now: datetime | None = None,
    *,
    settings: dict[str, Any] | None = None,
    max_reads: int = PASS_MAX_READS,
    max_seconds: float = PASS_MAX_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """One budgeted pass of the jobs loop (module docstring). Returns counts and Albayan row ids only:
    ``skipped`` ('' or why nothing ran: capability_off, not_configured, meta_paused,
    meta_connection_down; 'stopped' when an app-wide pause began mid-pass), ``due``, ``polled``,
    ``reads``, ``new``, ``replied``, ``parked``, ``errors`` (page id + error class), ``overrun``,
    ``left`` (due accounts the budget did not reach: polled next tick) and ``extended`` (page ids
    whose interval grew)."""
    now = _aware(now or utc_now())
    report: dict[str, Any] = {"skipped": "", "due": 0, "polled": [], "reads": 0, "new": 0, "replied": 0, "parked": [],
                              "errors": [], "overrun": False, "left": 0, "extended": []}
    settings = settings or read_all_settings()
    if poll_capability(settings) != POLL_CAPABILITY:
        return {**report, "skipped": "capability_off"}
    try:
        client = _meta.get_meta_ads_client()
    except _meta.MetaAdsError:
        return {**report, "skipped": "not_configured"}
    if _meta.meta_lane_pause_seconds("page"):  # an app-wide pause: every page waits
        return {**report, "skipped": "meta_paused"}
    if connection_down():  # P3-18a: the token is invalid, every read would be refused
        return {**report, "skipped": "meta_connection_down"}
    state = load_poll_state()
    with db_conn() as conn:
        owners = owners_with_instagram_rules(conn)
        pages = [page for page in linked_instagram_accounts(conn) if page["ownerId"] in owners]
    due = due_accounts(pages, state, now)
    report["due"] = len(due)
    at = _iso(now)
    started = clock()
    updates: dict[str, dict[str, Any]] = {}
    page_ids: dict[str, str] = {}  # account key -> Albayan row id
    polled: list[tuple[str, int, int]] = []
    on_interval: set[str] = set()  # the polled accounts whose next poll follows their interval
    for index, page in enumerate(due):
        if report["reads"] >= max_reads or clock() - started >= max_seconds:
            report["overrun"], report["left"] = True, len(due) - index  # they stay due: next tick
            break
        key = account_key(page["igUserId"])
        page_ids[key] = page["id"]
        every = interval_of(state["accounts"].get(key))
        entry: dict[str, Any] = {"everySeconds": every, "lastAt": at, "lastOutcome": "", "lastReads": 0, "lastNew": 0,
                                 "lastReplied": 0, "lastErrorCode": "", "nextAt": _iso(now + timedelta(seconds=every))}
        updates[key] = entry
        pause = _meta.meta_lane_pause_seconds("page", page["metaPageId"])
        if pause:  # a park of the linked page (a page throttle): only this account waits
            entry.update({"lastOutcome": "parked", "nextAt": _iso(now + timedelta(seconds=max(pause, MIN_PARK_WAIT)))})
            report["parked"].append(page["id"])
            continue
        if not _owner_active(page["ownerId"]):
            entry["lastOutcome"] = "owner_inactive"  # no read: the rules could not answer anyway
            continue
        try:
            result = _reader.check_recent_comments(client, page, source="poll", now=now)
        except Exception as error:  # a fault of ours on one account never stops the others
            print(f"[albayan] Instagram poll of one account failed ({type(error).__name__}).")
            entry.update({"lastOutcome": "error", "lastErrorCode": "internal", "nextAt": _iso(now + ERROR_RETRY)})
            report["errors"].append({"pageId": page["id"], "code": "internal"})
            continue
        reads = max(int(result.get("reads") or 0), 0)
        report["reads"] += reads
        report["new"] += int(result["new"])
        report["replied"] += int(result["replied"])
        entry.update({"lastReads": reads, "lastNew": int(result["new"]), "lastReplied": int(result["replied"])})
        if result["pausedLocally"]:
            # Albayan's own pause refused a read before it reached Meta: a park of this page that began
            # just now, or an app-wide pause (then the whole pass stops). Whatever was read before it
            # is kept (the reader settled it); the account waits for the pause.
            wide = _meta.meta_lane_pause_seconds("page")
            wait = wide or _meta.meta_lane_pause_seconds("page", page["metaPageId"]) or MIN_PARK_WAIT
            entry.update({"lastOutcome": "parked", "nextAt": _iso(now + timedelta(seconds=max(wait, MIN_PARK_WAIT)))})
            report["parked"].append(page["id"])
            if wide:
                report["skipped"] = "stopped"
                break
            continue
        report["polled"].append(page["id"])
        polled.append((key, reads, every))
        entry["lastOutcome"] = "polled"
        if result["errorCode"]:
            entry.update({"lastOutcome": "error", "lastErrorCode": _error_code(result), "nextAt": _iso(now + ERROR_RETRY)})
            report["errors"].append({"pageId": page["id"], "code": str(result["errorCode"])})
            if result["errorCode"] == "authorization" and connection_down():
                report["skipped"] = "meta_connection_down"  # the reader ran the token check: it failed
                break
        elif int(result.get("waiting") or 0) > 0:
            entry["nextAt"] = _iso(now + min(WAITING_RETRY, timedelta(seconds=every)))
        else:
            on_interval.add(key)
    for key, every in adjust_intervals(polled, overrun=report["overrun"], reads=report["reads"], max_reads=max_reads).items():
        entry = updates[key]
        if every > int(entry["everySeconds"]):
            report["extended"].append(page_ids[key])
        entry["everySeconds"] = every
        if key in on_interval:
            entry["nextAt"] = _iso(now + timedelta(seconds=every))
    report["extended"].sort()
    if updates:
        last_pass = {"due": report["due"], "polled": len(report["polled"]), "reads": report["reads"], "new": report["new"],
                     "replied": report["replied"], "parked": len(report["parked"]), "errors": len(report["errors"]),
                     "overrun": report["overrun"], "left": report["left"], "skipped": report["skipped"]}
        _save_poll_state(updates, last_pass, at)
    return report


def poll_report() -> dict[str, Any]:
    """The source's state for admins (counts and times only): the capability, whether the loop claims
    the job, the last pass, and the accounts by their last outcome and interval."""
    state = load_poll_state()
    by_outcome: dict[str, int] = {outcome: 0 for outcome in OUTCOMES}
    intervals: list[int] = []
    for entry in state["accounts"].values():
        outcome = str(entry.get("lastOutcome") or "")
        if outcome in by_outcome:
            by_outcome[outcome] += 1
        intervals.append(interval_of(entry))
    return {
        "capability": poll_capability(),
        "claimed": ig_poll_configured(),
        "lastPassAt": state["lastPassAt"],
        "lastPass": {key: value for key, value in state["lastPass"].items() if isinstance(value, (int, bool, str))},
        "accounts": len(state["accounts"]),
        "byOutcome": by_outcome,
        "longestIntervalSeconds": max(intervals) if intervals else None,
    }
