"""Instagram polling source (Albayan Studio plan task P4-09; studio_ig_source.py).

Every Meta call is faked (MetaAdsClient._request is replaced); nothing here reaches the network. The
passes run on a FIXED clock (T0 = tomorrow, so seeded comment times are after the rules, which carry
their real creation time). Each test starts from empty tables for the record types it reads or
writes and puts back what was there. The reader itself (cursor, ages, the link, Meta's answers) has
its own tests in test_studio_ig_poll.py; here: which accounts, when, the budget and the intervals,
the parks and pauses, the dedupe with the webhook, the loop's claim and the seeded latency run.
"""

import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server.db import db_conn, init_db, json_loads, now_ms
from server.rate_limiter import reset_rate_limit
from server.systems.ads_studio import studio_alerts_meta, studio_ig_poll, studio_ig_source as source, studio_jobs
from server.systems.ads_studio.studio_ig_source import account_key, run_ig_poll
from server.systems.ads_studio.studio_settings import DEFAULTS
from server.test_studio_ig_poll import (
    CAMPAIGNS,
    FakeGraph,
    _insert,
    _insert_user,
    _logs,
    _replace_rows,
    _rows_of,
    _subscribe,
    client,
)

UTC = timezone.utc
TYPES = ("socialPages", "socialReplyRules", "socialReplyLog", "metaHealthState", "metaProviderState", "studioSettings",
         "studioJobState")
T0 = (datetime.now(UTC) + timedelta(days=1)).replace(second=0, microsecond=0)
IG_A, IG_B, IG_C = "17841400000000101", "17841400000000102", "17841400000000103"
PAGE_A, PAGE_B, PAGE_C = "5300000000000101", "5300000000000102", "5300000000000103"
MEDIA_A1, MEDIA_A2, MEDIA_B1, MEDIA_C1 = "17910000000000101", "17910000000000102", "17910000000000201", "17910000000000301"
THANKS = "Thanks from Albayan"
CUSTOMER = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def actors():
    init_db()
    out = {
        "admin": _insert_user("src-admin", "Admin", {}),
        "owner": _insert_user("src-owner", "Employee", CUSTOMER),
        "owner2": _insert_user("src-owner2", "Employee", CUSTOMER),
        "lapsed": _insert_user("src-lapsed", "Employee", CUSTOMER),  # no subscription: rules cannot answer
    }
    _subscribe(out["owner"]["id"])
    _subscribe(out["owner2"]["id"])
    return out


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request", lambda self, method, path, **kw: fake.request(method, path, **kw))
    return fake


@pytest.fixture
def token_checks(monkeypatch):
    """The studio's token check, counted, never run (the real one asks Meta's debug_token)."""
    checks = []
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda: checks.append(True) or False)
    return checks


def _fresh_lanes() -> dict:
    return {"studio_results": meta_ads._MetaLaneState(), "page": meta_ads._MetaLaneState()}


@pytest.fixture(autouse=True)
def _clean(actors, monkeypatch, token_checks):
    saved = {entity_type: _rows_of(entity_type) for entity_type in TYPES}
    for entity_type in TYPES:
        _replace_rows(entity_type, [])
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "111111111234")
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    for name in ("_META_REMOTE_BACKOFF_REASON", "_META_REMOTE_USAGE_PERCENT"):
        monkeypatch.setattr(meta_ads, name, getattr(meta_ads, name))  # put back after the test
    monkeypatch.setattr(meta_ads, "_META_PROVIDER_STATE_REFRESHED_AT", 0.0)
    monkeypatch.setattr(meta_ads, "_META_APP_WIDE_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_META_APP_WIDE_REASON", "")
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())
    monkeypatch.setattr(meta_ads, "_META_LANE_STATE_REFRESHED_AT", 0.0)
    meta_ads._PAGE_TOKEN_CACHE.clear()
    reset_rate_limit(f"studio:settings:{actors['admin']['id']}")
    yield
    meta_ads._PAGE_TOKEN_CACHE.clear()
    for entity_type, rows in saved.items():
        _replace_rows(entity_type, rows)


def _capability(actors, state: str) -> None:
    """An admin sets capabilities.igPublicReply (the studioSettings rows start empty in every test)."""
    current = client.get("/api/studio/admin/settings/capabilities", cookies=actors["admin"]["cookies"]).json()
    value = {**DEFAULTS["capabilities"], **current["value"], "igPublicReply": state}
    saved = client.put("/api/studio/admin/settings/capabilities", cookies=actors["admin"]["cookies"],
                       json={"expectedVersion": current["version"], "value": value})
    assert saved.status_code == 200, saved.text


def _meta_time(moment: datetime) -> str:
    """A time as Meta writes it (+0000, whole seconds)."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


class Instagram:
    """Several Instagram accounts as the fake Graph shows them: media per account, comments per media
    (added at fixed-clock times), our own replies raising Meta's comment count (``extra``)."""

    def __init__(self, graph):
        self.graph = graph
        self.media: dict[str, dict[str, list[dict]]] = {}  # ig user id -> media id -> comments
        self.owner_of_media: dict[str, str] = {}
        self.extra: dict[str, int] = {}

    def add_account(self, ig_user_id: str, meta_page_id: str, media_ids) -> None:
        self.graph.routes[("GET", meta_page_id)] = {"id": meta_page_id, "access_token": f"PAGE-TOKEN-{meta_page_id}"}
        self.media[ig_user_id] = {media_id: [] for media_id in media_ids}
        for media_id in media_ids:
            self.owner_of_media[media_id] = ig_user_id
            self._route_media(media_id)
        self.route_account(ig_user_id)

    def route_account(self, ig_user_id: str) -> None:
        """Meta answers the account's media list (again, after a test routed an error there)."""
        self.graph.routes[("GET", f"{ig_user_id}/media")] = lambda body, ig=ig_user_id: {"data": [
            {"id": media_id, "comments_count": len(rows) + self.extra.get(media_id, 0), "timestamp": _meta_time(T0 - timedelta(days=1))}
            for media_id, rows in self.media[ig].items()
        ]}

    def _route_media(self, media_id: str) -> None:
        def answer(body):
            fields = body["fields"].split(",")
            rows = sorted(self.media[self.owner_of_media[media_id]][media_id], key=lambda row: row["timestamp"], reverse=True)
            return {"data": [{key: value for key, value in row.items() if key in fields} for row in rows]}
        self.graph.routes[("GET", f"{media_id}/comments")] = answer

    def comment(self, ig_user_id: str, media_id: str, comment_id: str, at: datetime, words: str = "hello",
                author: str = "7001") -> dict:
        row = {"id": comment_id, "timestamp": _meta_time(at), "text": words, "from": {"id": author, "username": f"buyer_{author}"}}
        self.media[ig_user_id][media_id].append(row)
        return row


def _page(actors, page_id: str, ig_user_id: str, meta_page_id: str, who: str = "owner", *, platform: str = "ig",
          deleted: bool = False, linked_ago: timedelta = timedelta(days=30)) -> str:
    owner = actors[who]["id"]
    _insert("socialPages", page_id, {
        "ownerId": owner, "metaPageId": meta_page_id, "platform": platform, "igUserId": ig_user_id if platform == "ig" else "",
        "name": "Shop", "healthy": True,
    }, owner=owner, deleted=deleted, created_at=now_ms() - int(linked_ago.total_seconds() * 1000))
    return page_id


def _rule(actors, rule_id: str, who: str = "owner", *, created_ago: timedelta = timedelta(hours=1), trigger: str = "every",
          keywords=(), reply: str = THANKS, platform: str = "ig", enabled: bool = True, active_ago: timedelta | None = None) -> str:
    owner = actors[who]["id"]
    extra = {} if active_ago is None else {"activeSince": now_ms() - int(active_ago.total_seconds() * 1000)}
    _insert("socialReplyRules", rule_id, {
        "ownerId": owner, "name": rule_id, "platform": platform, "enabled": enabled, "scope": "all", "postIds": [],
        "trigger": trigger, "keywords": list(keywords), "publicReply": reply, "dmEnabled": False, "dmText": "",
        "likeComment": False, "oncePerPerson": False, "skipPublicAfterDm": False, "pauseDms": False, "quietHours": False,
        **extra,
    }, owner=owner, created_at=now_ms() - int(created_ago.total_seconds() * 1000))
    return rule_id


def _entry(ig_user_id: str) -> dict:
    return source.load_poll_state()["accounts"].get(account_key(ig_user_id)) or {}


def _reads_of(graph, ig_user_id: str, *media_ids: str) -> list[str]:
    heads = (ig_user_id,) + tuple(media_ids)
    return [path for method, path, _body, _token in graph.calls if method == "GET" and path.startswith(heads)]


def _posts(graph) -> list[str]:
    return [path for path, _body, _token in graph.posts()]


def _webhook(ig_user_id: str, comment_id: str, media_id: str, author: str, words: str) -> dict:
    """An Instagram comment as Meta's webhook delivers it for this account."""
    return {"object": "instagram", "entry": [{"id": ig_user_id, "changes": [{"field": "comments", "value": {
        "id": comment_id, "media": {"id": media_id}, "from": {"id": author, "username": "buyer"}, "text": words,
    }}]}]}


# ---------------------------------------------------------------------------
# P4-09 acceptance
# ---------------------------------------------------------------------------


def test_poll_and_webhook_answer_once(actors, graph):
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")
    _rule(actors, "srule_src_a", "owner")
    _rule(actors, "srule_src_b", "owner2")
    _capability(actors, "poll")
    ig.comment(IG_A, MEDIA_A1, "18110000000000001", T0 - timedelta(minutes=5), "first")
    ig.comment(IG_B, MEDIA_B1, "18110000000000002", T0 - timedelta(minutes=4), "second")
    report = run_ig_poll(T0)
    assert report["skipped"] == "" and report["polled"] == ["spg_src_a", "spg_src_b"] and report["due"] == 2
    assert report["reads"] == 4 and report["new"] == 2 and report["replied"] == 2  # per account: the media list + one media
    assert report["overrun"] is False and report["left"] == 0 and report["parked"] == [] and report["errors"] == []
    # One public reply each, with the linked page's token, through the same path as the webhook.
    assert graph.posts() == [("18110000000000001/replies", {"message": THANKS}, f"PAGE-TOKEN-{PAGE_A}"),
                             ("18110000000000002/replies", {"message": THANKS}, f"PAGE-TOKEN-{PAGE_B}")]
    assert sorted((log["source"], log["commentId"]) for log in _logs()) == [
        ("poll", "18110000000000001"), ("poll", "18110000000000002")]
    # Every read went on the page lane of the linked Facebook page (PLAN P3-00).
    lanes = {path.split("/")[0]: lane for method, path, lane in graph.lanes if method == "GET" and path.startswith((IG_A, IG_B, MEDIA_A1, MEDIA_B1))}
    assert lanes == {IG_A: ("page", PAGE_A), MEDIA_A1: ("page", PAGE_A), IG_B: ("page", PAGE_B), MEDIA_B1: ("page", PAGE_B)}
    # Meta delivers the first comment by webhook later: never answered a second time.
    assert studio.handle_meta_webhook(_webhook(IG_A, "18110000000000001", MEDIA_A1, "7001", "first")) == 0
    assert len(graph.posts()) == 2 and len(_logs()) == 2
    # The other way round: the webhook answers a new comment first, then the poll reads it.
    ig.comment(IG_A, MEDIA_A1, "18110000000000003", T0 + timedelta(minutes=4), "third")
    assert studio.handle_meta_webhook(_webhook(IG_A, "18110000000000003", MEDIA_A1, "7001", "third")) == 1
    assert run_ig_poll(T0 + timedelta(seconds=30))["due"] == 0  # not due yet: every 5 minutes
    later = run_ig_poll(T0 + timedelta(minutes=5))
    assert later["polled"] == ["spg_src_a", "spg_src_b"] and later["reads"] == 3  # B's count did not change: its list only
    assert later["new"] == 1 and later["replied"] == 0 and len(graph.posts()) == 3
    assert sorted(log["source"] for log in _logs()) == ["poll", "poll", "webhook"]
    # The state: hashes, times and counts only.
    entry = _entry(IG_A)
    assert entry["lastOutcome"] == "polled" and entry["everySeconds"] == 300 and entry["lastReads"] == 2
    assert entry["nextAt"] == _iso(T0 + timedelta(minutes=10)) and entry["lastAt"] == _iso(T0 + timedelta(minutes=5))
    state = meta_ads.load_meta_health_state(source.POLL_STATE_ID)
    assert set(state["accounts"]) == {account_key(IG_A), account_key(IG_B)} and state["lastPass"]["polled"] == 2
    for secret in (IG_A, IG_B, PAGE_A, PAGE_B, MEDIA_A1, MEDIA_B1, "1811000000000000", "first", "PAGE-TOKEN", "system-token"):
        assert secret not in json.dumps(state)


def test_poll_respects_cursor_and_rule_creation(actors, graph):
    real = datetime.now(UTC)
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")
    _rule(actors, "srule_price", "owner", created_ago=timedelta(hours=3), trigger="keywords", keywords=["price"], reply="Price sent")
    _rule(actors, "srule_all", "owner", created_ago=timedelta(hours=1))
    # Owner 2's only rule was made three hours ago but switched on 30 minutes ago (activeSince).
    _rule(actors, "srule_back_on", "owner2", created_ago=timedelta(hours=3), active_ago=timedelta(minutes=30))
    _capability(actors, "poll")
    ig.comment(IG_A, MEDIA_A1, "18120000000000001", real - timedelta(hours=4), "price please")  # before every rule
    ig.comment(IG_A, MEDIA_A1, "18120000000000002", real - timedelta(hours=2), "price?")  # the older rule answers
    ig.comment(IG_A, MEDIA_A1, "18120000000000003", real - timedelta(hours=2), "hello")  # only the newer rule matches
    ig.comment(IG_A, MEDIA_A1, "18120000000000004", T0 - timedelta(minutes=10), "hello")  # after both rules
    ig.comment(IG_B, MEDIA_B1, "18120000000000005", real - timedelta(hours=1), "while it was off")
    ig.comment(IG_B, MEDIA_B1, "18120000000000006", T0 - timedelta(minutes=1), "after it came back")
    report = run_ig_poll(T0)
    assert report["polled"] == ["spg_src_a", "spg_src_b"] and report["new"] == 4 and report["replied"] == 3
    assert graph.posts() == [("18120000000000002/replies", {"message": "Price sent"}, f"PAGE-TOKEN-{PAGE_A}"),
                             ("18120000000000004/replies", {"message": THANKS}, f"PAGE-TOKEN-{PAGE_A}"),
                             ("18120000000000006/replies", {"message": THANKS}, f"PAGE-TOKEN-{PAGE_B}")]
    # The next poll: nothing changed, so only the media lists are read (the cursor's counts).
    graph.calls.clear()
    again = run_ig_poll(T0 + timedelta(minutes=5))
    assert again["polled"] == ["spg_src_a", "spg_src_b"] and again["reads"] == 2 and again["new"] == 0
    assert _reads_of(graph, IG_A, MEDIA_A1) == [f"{IG_A}/media"]
    # Our reply raised Meta's count and a comment shows up late with an old time (behind the cursor):
    # the media is read again, nothing is answered.
    ig.extra[MEDIA_A1] = 2
    ig.comment(IG_A, MEDIA_A1, "18120000000000007", T0 - timedelta(minutes=30), "late")
    late = run_ig_poll(T0 + timedelta(minutes=10))
    assert late["reads"] == 3 and late["new"] == 0 and graph.posts() == []  # (the calls were cleared above)
    # A rule made afterwards never answers a comment an earlier poll saw.
    _rule(actors, "srule_new", "owner", created_ago=timedelta(seconds=1))
    ig.extra[MEDIA_A1] = 3
    assert run_ig_poll(T0 + timedelta(minutes=15))["new"] == 0 and graph.posts() == []
    # A comment written after the cursor is answered on the next poll.
    ig.comment(IG_A, MEDIA_A1, "18120000000000008", T0 + timedelta(minutes=16), "new one")
    fresh = run_ig_poll(T0 + timedelta(minutes=20))
    assert fresh["new"] == 1 and fresh["replied"] == 1 and _posts(graph)[-1] == "18120000000000008/replies"


def test_poll_budget_extends_interval(actors, graph):
    """The budget (20 reads or 10 s per pass) never skips an account: the accounts it did not reach are
    polled next tick, and the busiest accounts of an overrun pass are polled less often until the
    load drops."""
    ig = Instagram(graph)
    pages = {}
    for letter in "abcdefg":
        ig_user, page = f"178414000000001{ord(letter)}", f"53000000000001{ord(letter)}"
        busy = letter in "ab"  # 8 media with a comment each: 9 reads a poll; the others: the media list only
        media = [f"179100000000{ord(letter)}{n:02d}" for n in range(8 if busy else 1)]
        ig.add_account(ig_user, page, media)
        for n, media_id in enumerate(media if busy else []):
            ig.comment(ig_user, media_id, f"18130000000000{ord(letter)}{n:02d}", T0 - timedelta(minutes=5 + n))
        pages[letter] = (_page(actors, f"spg_bud_{letter}", ig_user, page, "owner"), ig_user)
    _rule(actors, "srule_bud", "owner")
    _capability(actors, "poll")
    ids = {letter: pages[letter][0] for letter in pages}
    first = run_ig_poll(T0)
    assert first["polled"] == [ids[l] for l in "abcd"] and first["reads"] == 20  # a 9, b 18, c 19, d 20: the budget
    assert first["overrun"] is True and first["left"] == 3 and first["new"] == 16 and first["replied"] == 16
    assert first["extended"] == [ids["a"], ids["b"]]  # the busiest of the pass, not the ones that cost one read
    for letter in "ab":
        assert _entry(pages[letter][1])["everySeconds"] == 450 and _entry(pages[letter][1])["nextAt"] == _iso(T0 + timedelta(seconds=450))
    for letter in "cd":
        assert _entry(pages[letter][1])["everySeconds"] == 300 and _entry(pages[letter][1])["nextAt"] == _iso(T0 + timedelta(seconds=300))
    # The three the budget did not reach are polled on the next tick, not skipped.
    second = run_ig_poll(T0 + timedelta(seconds=30))
    assert second["polled"] == [ids[l] for l in "efg"] and second["reads"] == 3 and second["overrun"] is False
    assert second["extended"] == [] and all(_entry(pages[l][1])["everySeconds"] == 300 for l in "efg")
    assert run_ig_poll(T0 + timedelta(seconds=60))["due"] == 0
    # Five minutes on: the quiet accounts come back; the busy ones wait for their longer interval.
    third = run_ig_poll(T0 + timedelta(seconds=300))
    assert third["polled"] == [ids["c"], ids["d"]] and third["reads"] == 2
    assert run_ig_poll(T0 + timedelta(seconds=330))["polled"] == [ids[l] for l in "efg"]
    graph.calls.clear()
    fourth = run_ig_poll(T0 + timedelta(seconds=450))
    assert fourth["polled"] == [ids["a"], ids["b"]] and fourth["reads"] == 2  # their counts did not change: the lists only
    # A light pass shrinks a lengthened interval back towards five minutes.
    assert fourth["extended"] == [] and all(_entry(pages[l][1])["everySeconds"] == 300 for l in "ab")
    assert _entry(pages["a"][1])["nextAt"] == _iso(T0 + timedelta(seconds=750))
    # The wall-time budget: no account is started after 10 seconds (a fixed clock). Two hours on every
    # account is due; the longest waiting (c, d since T0+600, then e, f, g, then a, b) come first.
    ticks = iter([0.0, 3.0, 6.0, 9.0, 12.0, 15.0, 18.0, 21.0, 24.0])  # the first tick starts the pass
    slow = run_ig_poll(T0 + timedelta(hours=2), clock=lambda: next(ticks))
    assert slow["polled"] == [ids[l] for l in "cde"] and slow["overrun"] is True and slow["left"] == 4  # 3, 6, 9 s started; 12 s stops
    # The pure rule: an overrun lengthens at least the median and never past 30 minutes; a light pass shrinks.
    grow = source.adjust_intervals([("k1", 9, 300), ("k2", 9, 1518), ("k3", 1, 300), ("k4", 1, 300)], overrun=True, reads=20)
    assert grow == {"k1": 450, "k2": 1800}
    assert source.adjust_intervals([("k1", 1, 300), ("k2", 1, 300)], overrun=True, reads=20) == {"k1": 450, "k2": 450}
    assert source.adjust_intervals([("k1", 3, 450), ("k2", 1, 300)], overrun=False, reads=4) == {"k1": 300}
    assert source.adjust_intervals([("k1", 3, 450)], overrun=False, reads=15) == {}  # neither light nor overrun
    assert source.adjust_intervals([], overrun=True, reads=20) == {}


# ---------------------------------------------------------------------------
# Which accounts, the switch, parks and pauses
# ---------------------------------------------------------------------------


def test_poll_only_accounts_that_can_answer_and_only_with_the_poll_capability(actors, graph, monkeypatch):
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    ig.add_account(IG_C, PAGE_C, [MEDIA_C1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")  # owner: an enabled Instagram rule
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")  # owner 2: a disabled Instagram rule and a Facebook rule only
    _page(actors, "spg_src_c", IG_C, PAGE_C, "lapsed")  # a rule, but no subscription
    _page(actors, "spg_src_fb", "", PAGE_B, "owner", platform="fb")
    _page(actors, "spg_src_gone", IG_A, PAGE_A, "owner", deleted=True)
    _rule(actors, "srule_src_a", "owner")
    _rule(actors, "srule_src_off", "owner2", enabled=False)
    _rule(actors, "srule_src_fb", "owner2", platform="fb")
    _rule(actors, "srule_src_lapsed", "lapsed")
    ig.comment(IG_A, MEDIA_A1, "18140000000000001", T0 - timedelta(minutes=3))
    ig.comment(IG_B, MEDIA_B1, "18140000000000002", T0 - timedelta(minutes=3))
    ig.comment(IG_C, MEDIA_C1, "18140000000000003", T0 - timedelta(minutes=3))
    # Off, on, gated, unavailable: the loop never claims the job and a pass reads nothing.
    for state in ("unavailable", "on", "gated", "off"):
        _capability(actors, state)
        assert source.ig_poll_configured() is False
        report = run_ig_poll(T0)
        assert report["skipped"] == "capability_off" and report["polled"] == [] and report["due"] == 0, state
    assert graph.calls == []
    _capability(actors, "poll")
    assert source.ig_poll_configured() is True and source.poll_capability() == "poll"
    report = run_ig_poll(T0)
    assert report["due"] == 2 and report["polled"] == ["spg_src_a"] and report["replied"] == 1
    assert _reads_of(graph, IG_B, MEDIA_B1) == [] and _reads_of(graph, IG_C, MEDIA_C1) == []
    assert _entry(IG_C)["lastOutcome"] == "owner_inactive" and _entry(IG_C)["nextAt"] == _iso(T0 + timedelta(minutes=5))
    assert _entry(IG_B) == {}  # never a candidate: no enabled Instagram rule
    with db_conn() as conn:
        assert source.owners_with_instagram_rules(conn) == {actors["owner"]["id"], actors["lapsed"]["id"]}
        assert [page["id"] for page in source.linked_instagram_accounts(conn)] == ["spg_src_a", "spg_src_b", "spg_src_c"]
    # Without a Meta token nothing is claimed or read, whatever the capability says.
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    assert source.ig_poll_configured() is False
    assert run_ig_poll(T0 + timedelta(minutes=5))["skipped"] == "not_configured"
    summary = source.poll_report()
    assert summary["capability"] == "poll" and summary["claimed"] is False and summary["accounts"] == 2
    assert summary["byOutcome"] == {"polled": 1, "parked": 0, "error": 0, "owner_inactive": 1}
    assert summary["longestIntervalSeconds"] == 300 and summary["lastPass"]["polled"] == 1


def test_linked_second_is_the_relink_time_of_a_revived_row(actors):
    """The poll's floor of a revived row (P4-01) is its fresh linkedAt, not the old created_at; a row
    without linkedAt (from before it) keeps its creation."""
    owner = actors["owner"]["id"]
    relinked = (T0 - timedelta(hours=1)).replace(microsecond=0)
    _insert("socialPages", "spg_src_a", {
        "ownerId": owner, "metaPageId": PAGE_A, "platform": "ig", "igUserId": IG_A, "name": "Shop", "healthy": True,
        "linkedAt": _iso(relinked),
    }, owner=owner, created_at=now_ms() - 30 * 86_400_000)
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2", linked_ago=timedelta(days=3))
    with db_conn() as conn:
        floors = {page["id"]: page["linkedSecond"] for page in source.linked_instagram_accounts(conn)}
    assert floors["spg_src_a"] == int(relinked.timestamp()) == studio_ig_poll.load_instagram_page("spg_src_a")["linkedSecond"]
    assert abs(floors["spg_src_b"] - (now_ms() // 1000 - 3 * 86_400)) <= 2


def test_poll_respects_page_parks_and_pauses(actors, graph, monkeypatch):
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")
    _rule(actors, "srule_src_a", "owner")
    _rule(actors, "srule_src_b", "owner2")
    _capability(actors, "poll")
    ig.comment(IG_A, MEDIA_A1, "18150000000000001", T0 - timedelta(minutes=3))
    ig.comment(IG_B, MEDIA_B1, "18150000000000002", T0 - timedelta(minutes=3))
    # Meta's ads limit paused the admin lane (Albayan Manager's sync): the poll still reads.
    meta_ads._set_meta_remote_backoff(600, reason="meta_80004")
    # A park of page A (a page throttle) holds only account A; B is polled; A waits for the park.
    meta_ads._park_lane_objects("page", (PAGE_A,), 300, reason="meta_80001")
    report = run_ig_poll(T0)
    assert report["parked"] == ["spg_src_a"] and report["polled"] == ["spg_src_b"] and report["reads"] == 2
    assert _reads_of(graph, IG_A, MEDIA_A1) == [] and _posts(graph) == ["18150000000000002/replies"]
    parked = _entry(IG_A)
    assert parked["lastOutcome"] == "parked" and parked["lastReads"] == 0
    wait = (datetime.fromisoformat(parked["nextAt"].replace("Z", "+00:00")) - T0).total_seconds()
    assert 240 < wait <= 300
    assert run_ig_poll(T0 + timedelta(minutes=4))["due"] == 0  # still parked, still not due
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())  # the park ended
    after = run_ig_poll(T0 + timedelta(minutes=5))
    assert after["polled"] == ["spg_src_a", "spg_src_b"] and _posts(graph)[-1] == "18150000000000001/replies"
    # An app-wide pause: nothing is read at all.
    calls = len(graph.calls)
    meta_ads._mark_app_wide(120, reason="meta_4")
    assert run_ig_poll(T0 + timedelta(minutes=10))["skipped"] == "meta_paused" and len(graph.calls) == calls
    monkeypatch.setattr(meta_ads, "_META_APP_WIDE_UNTIL", 0.0)
    # The connection is down (the token check failed, P3-18a): nothing is read either.
    monkeypatch.setattr(source, "connection_down", lambda: True)
    assert run_ig_poll(T0 + timedelta(minutes=10))["skipped"] == "meta_connection_down" and len(graph.calls) == calls
    monkeypatch.setattr(source, "connection_down", lambda: False)
    # A pause that begins during the pass (Albayan's own refusal, nothing reached Meta): the account is
    # parked for a minute at least, and the pass goes on with the others.
    graph.routes[("GET", f"{IG_A}/media")] = meta_ads.MetaAdsError(
        "rate_limited", "Meta synchronization is paused safely and will resume automatically.", retryable=True)
    ig.comment(IG_B, MEDIA_B1, "18150000000000003", T0 + timedelta(minutes=9))
    mid = run_ig_poll(T0 + timedelta(minutes=10))
    assert mid["parked"] == ["spg_src_a"] and mid["polled"] == ["spg_src_b"] and mid["reads"] == 2 and mid["skipped"] == ""
    assert _entry(IG_A)["lastOutcome"] == "parked" and _entry(IG_A)["nextAt"] >= _iso(T0 + timedelta(minutes=10, seconds=30))
    assert _posts(graph)[-1] == "18150000000000003/replies"


def test_poll_errors_are_codes_and_the_state_keeps_no_meta_ids(actors, graph, token_checks, monkeypatch):
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")
    _rule(actors, "srule_src_a", "owner")
    _rule(actors, "srule_src_b", "owner2")
    _capability(actors, "poll")
    ig.comment(IG_A, MEDIA_A1, "18160000000000001", T0 - timedelta(minutes=3), "secret words")
    ig.comment(IG_B, MEDIA_B1, "18160000000000002", T0 - timedelta(minutes=3))
    graph.routes[("GET", f"{IG_A}/media")] = meta_ads.MetaAdsError("temporary", "secret text", retryable=True, provider_code="2")
    report = run_ig_poll(T0)
    assert report["errors"] == [{"pageId": "spg_src_a", "code": "temporary"}] and report["polled"] == ["spg_src_a", "spg_src_b"]
    assert report["reads"] == 3  # the refused list reached Meta and counts; B's list and media
    failed = _entry(IG_A)
    assert failed["lastOutcome"] == "error" and failed["lastErrorCode"] == "temporary:2"
    assert failed["nextAt"] == _iso(T0 + source.ERROR_RETRY) and token_checks == []
    # The account is read again after the retry wait (B keeps its five minutes), and its comment answered then.
    ig.route_account(IG_A)
    assert run_ig_poll(T0 + timedelta(minutes=14))["polled"] == ["spg_src_b"]
    retried = run_ig_poll(T0 + timedelta(minutes=15))
    assert retried["polled"] == ["spg_src_a"] and retried["replied"] == 1 and "18160000000000001/replies" in _posts(graph)
    # An authorization refusal runs the studio's token check; the check says the token is fine, so the
    # account waits its 15 minutes and the pass goes on with the others.
    graph.routes[("GET", f"{IG_A}/media")] = meta_ads.MetaAdsError("authorization", "secret text", provider_code="190")
    denied = run_ig_poll(T0 + timedelta(minutes=30))
    assert denied["errors"] == [{"pageId": "spg_src_a", "code": "authorization"}] and sorted(denied["polled"]) == ["spg_src_a", "spg_src_b"]
    assert token_checks == [True] and _entry(IG_A)["lastErrorCode"] == "authorization:190"
    assert _entry(IG_A)["nextAt"] == _iso(T0 + timedelta(minutes=45))
    # A fault of ours on one account never stops the others.
    monkeypatch.setattr(studio_ig_poll, "check_recent_comments", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret")))
    broken = run_ig_poll(T0 + timedelta(minutes=60))
    assert sorted(broken["errors"], key=lambda item: item["pageId"]) == [
        {"pageId": "spg_src_a", "code": "internal"}, {"pageId": "spg_src_b", "code": "internal"}]
    assert _entry(IG_B)["lastErrorCode"] == "internal" and _entry(IG_B)["nextAt"] == _iso(T0 + timedelta(minutes=75))
    dumped = json.dumps(meta_ads.load_meta_health_state(source.POLL_STATE_ID)) + json.dumps(source.poll_report())
    for secret in (IG_A, IG_B, PAGE_A, PAGE_B, MEDIA_A1, MEDIA_B1, "1816000000000000", "secret", "PAGE-TOKEN", "system-token"):
        assert secret not in dumped


def test_poll_stops_once_the_token_check_says_the_connection_is_down(actors, graph, token_checks, monkeypatch):
    """An authorization refusal runs the studio's token check (P3-18a); when that check marks the
    connection down, the pass stops before the next account (every read would be refused)."""
    ig = Instagram(graph)
    ig.add_account(IG_A, PAGE_A, [MEDIA_A1])
    ig.add_account(IG_B, PAGE_B, [MEDIA_B1])
    _page(actors, "spg_src_a", IG_A, PAGE_A, "owner")
    _page(actors, "spg_src_b", IG_B, PAGE_B, "owner2")
    _rule(actors, "srule_src_a", "owner")
    _rule(actors, "srule_src_b", "owner2")
    _capability(actors, "poll")
    ig.comment(IG_B, MEDIA_B1, "18170000000000002", T0 - timedelta(minutes=3))
    graph.routes[("GET", f"{IG_A}/media")] = meta_ads.MetaAdsError("authorization", "secret text", provider_code="190")
    monkeypatch.setattr(source, "connection_down", lambda: bool(token_checks))  # down as soon as the check ran
    stopped = run_ig_poll(T0)
    assert stopped["skipped"] == "meta_connection_down" and stopped["polled"] == ["spg_src_a"] and token_checks == [True]
    assert _reads_of(graph, IG_B, MEDIA_B1) == [] and graph.posts() == [] and _entry(IG_B) == {}
    assert _entry(IG_A)["lastErrorCode"] == "authorization:190"
    # While the connection stays down nothing is read; once it is back, B's comment is answered.
    assert run_ig_poll(T0 + timedelta(seconds=30))["skipped"] == "meta_connection_down"
    monkeypatch.setattr(source, "connection_down", lambda: False)
    ig.route_account(IG_A)
    back = run_ig_poll(T0 + timedelta(minutes=1))
    assert back["polled"] == ["spg_src_b"] and _posts(graph) == ["18170000000000002/replies"]


# ---------------------------------------------------------------------------
# The jobs loop and the seeded latency run
# ---------------------------------------------------------------------------


def test_the_jobs_loop_claims_the_poll_only_with_a_token_and_the_poll_capability(actors, graph, monkeypatch):
    runs = []
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: {})
    monkeypatch.setattr(studio_jobs, "meta_watch_configured", lambda: False)
    monkeypatch.setattr(studio_jobs, "_run_results_sync", lambda now: {"reads": 0})
    monkeypatch.setattr(studio_jobs, "_run_stop_check", lambda now: {})
    monkeypatch.setattr(studio_jobs, "run_ig_poll", lambda now: runs.append(now) or {"skipped": "", "polled": []})
    base = datetime(2027, 3, 21, 0, 30, tzinfo=UTC)  # 02:30 in Tripoli: before the daily check
    _capability(actors, "poll")
    ran = studio_jobs.run_tick(lambda: {}, base)
    assert ran["claimed"] == ["sweep", "waiting", "results", "ig_poll"] and ran["ig_poll"]["polled"] == [] and runs == [base]
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(seconds=10))["claimed"] == []
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(seconds=30))["claimed"] == ["results", "ig_poll"]
    heartbeat = studio_jobs.jobs_heartbeat(base + timedelta(seconds=31))
    assert heartbeat["lastIgPollAt"] == _iso(base + timedelta(seconds=30)) and len(runs) == 2
    _capability(actors, "unavailable")  # the road is switched off: the job is not claimed any more
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(minutes=5))["claimed"] == ["sweep", "waiting", "results"]
    _capability(actors, "poll")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(minutes=10))["claimed"] == ["sweep", "waiting"]
    assert len(runs) == 2
    # The new alert kinds of this stage carry their labels in both languages.
    for kind in ("meta_overspend", "replies_parked"):
        assert kind in studio_jobs.ALERT_KINDS
        assert set(studio_jobs.ALERT_LABELS[kind]) == {"en", "ar"} and all(studio_jobs.ALERT_LABELS[kind].values())


def test_poll_p95_latency_within_ten_minutes_on_a_seeded_run(actors, graph, monkeypatch):
    """Twelve accounts, six comments each over two hours, the loop ticking every 30 seconds on a fixed
    clock: every comment is fed once, and 95% of them within 10 minutes of being written."""
    ig = Instagram(graph)
    accounts = []
    for n in range(12):
        ig_user, page = f"1784140000000012{n:02d}", f"53000000000012{n:02d}"
        media = [f"1791000000012{n:02d}{m}" for m in range(3)]
        ig.add_account(ig_user, page, media)
        _page(actors, f"spg_seed_{n:02d}", ig_user, page, "owner" if n % 2 else "owner2")
        accounts.append((ig_user, media))
    _rule(actors, "srule_seed_1", "owner")
    _rule(actors, "srule_seed_2", "owner2")
    _capability(actors, "poll")
    seed = random.Random(4)
    planned = []  # (written at, ig user, media, comment id)
    for index, (ig_user, media) in enumerate(accounts):
        for n in range(6):
            planned.append((T0 + timedelta(seconds=seed.randint(0, 120 * 60)), ig_user, seed.choice(media), f"1817{index:02d}{n:02d}000000000"))
    planned.sort()
    fed: dict[str, list[datetime]] = {}
    clock = {"now": T0}

    def record(**kwargs):
        fed.setdefault(kwargs["comment_id"], []).append(clock["now"])
        return {"actions": ["public"]}

    monkeypatch.setattr(studio, "process_comment", record)
    pending = list(planned)
    for tick in range(0, 150 * 60, 30):
        clock["now"] = T0 + timedelta(seconds=tick)
        while pending and pending[0][0] <= clock["now"]:
            _at, ig_user, media_id, comment_id = pending.pop(0)
            ig.comment(ig_user, media_id, comment_id, _at)
        report = run_ig_poll(clock["now"])
        assert report["skipped"] == "" and report["errors"] == []
    written = {comment_id: at for at, _ig, _media, comment_id in planned}
    assert sorted(fed) == sorted(written) and all(len(times) == 1 for times in fed.values())  # each once
    latencies = sorted((fed[comment_id][0] - at).total_seconds() for comment_id, at in written.items())
    p95 = latencies[max(int(len(latencies) * 0.95) - 1, 0)]
    assert 0 <= latencies[0] and p95 <= 10 * 60, (p95, latencies[-5:])
    assert max(source.interval_of(entry) for entry in source.load_poll_state()["accounts"].values()) <= source.POLL_MAX_SECONDS
