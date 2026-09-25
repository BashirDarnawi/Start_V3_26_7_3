"""Instagram "Check recent comments now" (Albayan Studio plan task P1-23).

Every Meta call is faked (MetaAdsClient._request is replaced); nothing here reaches the network.
Each test starts from empty tables for the record types it reads or writes and puts back what was
there. Comment times are real times relative to now, because rules carry their real creation time.
"""

import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_alerts_meta, studio_ig_poll
from server.systems.ads_studio.studio_ig_poll import account_bucket

TAG = secrets.token_hex(4)
PASSWORD = "StudioIgPollPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/studio/admin"
CAMPAIGNS = "adCampaignRequests"
TYPES = ("socialPages", "socialReplyRules", "socialReplyLog", "metaHealthState", "metaProviderState")
IG_PAGE_FB, FB_PAGE = "5200000000001", "5200000000002"
IG_USER = "17841400000000077"
MEDIA_1, MEDIA_2 = "17900000000000001", "17900000000000002"
SECRET_TEXT = f"secret comment {TAG}"
THANKS = "Thanks from Albayan"


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("igpoll_user")
    email = f"studio-igpoll-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"IG poll {label}", "email": email, "role": role,
                "permissions": json_dumps(permissions), "hash": password_hash.hash_hex,
                "salt": password_hash.salt_hex, "algo": password_hash.algo,
                "iterations": password_hash.iterations, "stamp": stamp,
            },
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


def _subscribe(user_id: str) -> None:
    """An active ad_maker subscription: Social Studio answers only for an owner who has one."""
    stamp = now_ms()
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
    data = {"id": new_id("sub"), "userId": user_id, "serviceId": "ad_maker", "status": "active", "expiresAt": expires}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('serviceSubscriptions',:id,:data,false,:stamp,:uid,:stamp)"
            ),
            {"id": data["id"], "data": json_dumps(data), "stamp": stamp, "uid": user_id},
        )


@pytest.fixture(scope="module")
def actors():
    init_db()
    out = {
        "admin": _insert_user("admin", "Admin", {}),
        "admin2": _insert_user("admin2", "Admin", {}),
        "staff": _insert_user("staff", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "customer": _insert_user("customer", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
    }
    _subscribe(out["customer"]["id"])
    return out


def _rows_of(entity_type: str) -> list[dict]:
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(text("SELECT * FROM entities WHERE type=:t"), {"t": entity_type}).mappings().all()]


def _replace_rows(entity_type: str, rows: list[dict]) -> None:
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type=:t"), {"t": entity_type})
        for row in rows:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"
                ),
                row,
            )


class FakeGraph:
    """Answers MetaAdsClient._request by (method, path); records every call (and the meta_call_lane
    block it was made in). Replies always land."""

    def __init__(self):
        self.calls = []
        self.lanes = []
        self.routes = {}

    def request(self, method, path, *, params=None, data=None, access_token=None, use_headroom=False):
        body = dict(params or {}) if method == "GET" else dict(data or {})
        self.calls.append((method, path, body, access_token))
        self.lanes.append((method, path, meta_ads._META_LANE_CONTEXT.get()))
        answer = self.routes.get((method, path))
        if answer is None and method == "POST" and path.endswith("/replies"):
            return {"id": "18999999999999999"}
        if answer is None:
            raise AssertionError(f"unexpected Graph {method} {path}")
        if isinstance(answer, Exception):
            raise answer
        return answer(body) if callable(answer) else answer

    def posts(self):
        return [(path, body, token) for method, path, body, token in self.calls if method == "POST"]

    def reads(self, suffix):
        return [path for method, path, _body, _token in self.calls if method == "GET" and path.endswith(suffix)]


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request", lambda self, method, path, **kw: fake.request(method, path, **kw))
    fake.routes[("GET", IG_PAGE_FB)] = {"id": IG_PAGE_FB, "access_token": f"PAGE-TOKEN-{IG_PAGE_FB}"}
    return fake


@pytest.fixture
def token_checks(monkeypatch):
    """The studio's token check (studio_alerts_meta.after_authorization_failure), counted, never run:
    the real one asks Meta's debug_token."""
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
    # Meta call lanes (PLAN P3-00): no app-wide pause and no parked page.
    monkeypatch.setattr(meta_ads, "_META_APP_WIDE_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_META_APP_WIDE_REASON", "")
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())
    monkeypatch.setattr(meta_ads, "_META_LANE_STATE_REFRESHED_AT", 0.0)
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _next_minute()
    for user in actors.values():
        reset_rate_limit(f"studio:check-comments:{user['id']}")
    yield
    meta_ads._PAGE_TOKEN_CACHE.clear()
    for entity_type, rows in saved.items():
        _replace_rows(entity_type, rows)


def _next_minute() -> None:
    """The account's once-a-minute check is free again (as if a minute passed)."""
    reset_rate_limit(account_bucket(IG_USER))


def _insert(entity_type: str, entity_id: str, data: dict, *, owner: str | None = None, created_at: int | None = None,
            deleted: bool = False) -> None:
    stamp = created_at or now_ms()
    body = {"id": entity_id, "_created": stamp, "_lastModified": stamp, "_deleted": deleted, **data}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:created,:owner,:created)"
            ),
            {"type": entity_type, "id": entity_id, "data": json_dumps(body), "deleted": deleted,
             "created": stamp, "owner": owner},
        )


def _ig_page(actors, page_id: str = "spg_ig_1", *, platform: str = "ig", deleted: bool = False,
             linked_ago: timedelta = timedelta(days=30)) -> str:
    owner = actors["customer"]["id"]
    _insert("socialPages", page_id, {
        "ownerId": owner, "metaPageId": IG_PAGE_FB if platform == "ig" else FB_PAGE, "platform": platform,
        "igUserId": IG_USER if platform == "ig" else "", "name": "Shop", "healthy": True,
    }, owner=owner, deleted=deleted, created_at=now_ms() - int(linked_ago.total_seconds() * 1000))
    return page_id


def _rule(actors, rule_id: str, *, created_ago: timedelta, trigger: str = "every", keywords=(), reply: str = THANKS,
          platform: str = "ig", enabled: bool = True, active_ago: timedelta | None = None) -> str:
    """A rule made ``created_ago``; with ``active_ago`` it was switched on or changed then (activeSince)."""
    owner = actors["customer"]["id"]
    extra = {} if active_ago is None else {"activeSince": now_ms() - int(active_ago.total_seconds() * 1000)}
    _insert("socialReplyRules", rule_id, {
        "ownerId": owner, "name": rule_id, "platform": platform, "enabled": enabled, "scope": "all", "postIds": [],
        "trigger": trigger, "keywords": list(keywords), "publicReply": reply, "dmEnabled": False, "dmText": "",
        "likeComment": False, "oncePerPerson": False, "skipPublicAfterDm": False, "pauseDms": False, "quietHours": False,
        **extra,
    }, owner=owner, created_at=now_ms() - int(created_ago.total_seconds() * 1000))
    return rule_id


def _meta_time(ago: timedelta) -> str:
    """A time as Meta writes it (+0000, whole seconds)."""
    return (datetime.now(timezone.utc) - ago).strftime("%Y-%m-%dT%H:%M:%S+0000")


def _comment(comment_id: str, ago: timedelta, words: str = "hello", author: str | None = "7001") -> dict:
    row = {"id": comment_id, "timestamp": _meta_time(ago), "text": words}
    if author is not None:
        row["from"] = {"id": author, "username": f"buyer_{author}"}
    return row


class Account:
    """The Instagram account's recent media as the fake Graph shows them; change them between checks."""

    def __init__(self, graph, media: dict[str, list[dict]]):
        self.media = media
        self.extra_count: dict[str, int] = {}  # our own replies count too (Meta's comments_count includes replies)
        graph.routes[("GET", f"{IG_USER}/media")] = lambda body: {"data": [
            {"id": media_id, "comments_count": len(rows) + self.extra_count.get(media_id, 0), "timestamp": _meta_time(timedelta(days=1))}
            for media_id, rows in self.media.items()
        ]}
        for media_id in media:
            self.route(graph, media_id)

    def route(self, graph, media_id: str) -> None:
        def answer(body, media_id=media_id):
            fields = body["fields"].split(",")
            rows = sorted(self.media[media_id], key=lambda row: row["timestamp"], reverse=True)  # newest first, as Meta
            return {"data": [{key: value for key, value in row.items() if key in fields} for row in rows]}
        graph.routes[("GET", f"{media_id}/comments")] = answer


def _press(actors, page_id: str = "spg_ig_1", who: str = "admin", **kwargs):
    return client.post(f"{API}/pages/{page_id}/check-comments", cookies=actors[who]["cookies"], **kwargs)


def _check(actors, **expected) -> dict:
    response = _press(actors)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"read", "new", "replied", "skipped", "errorCode"}
    for key, value in expected.items():
        assert body[key] == value, (key, body)
    return body


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code and detail["message"]
    return detail


def _logs() -> list[dict]:
    return [json_loads(row["data_json"]) for row in _rows_of("socialReplyLog")]


def _audit_rows(user_id: str, started: int) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "SELECT action, resource_type, resource_id, metadata_json FROM audit_logs "
                "WHERE user_id=:u AND action='check_comments' AND ts >= :started ORDER BY ts"
            ),
            {"u": user_id, "started": started},
        ).mappings().all()
    return [{**dict(r), "metadata": json_loads(r["metadata_json"] or "{}")} for r in rows]


def _ig_webhook(comment_id: str, media_id: str, author: str, words: str) -> dict:
    return {"object": "instagram", "entry": [{"id": IG_USER, "changes": [{"field": "comments", "value": {
        "id": comment_id, "media": {"id": media_id}, "from": {"id": author, "username": "buyer"}, "text": words,
    }}]}]}


# ---------------------------------------------------------------------------
# P1-23 acceptance
# ---------------------------------------------------------------------------


def test_manual_check_feeds_process_comment_once(actors, graph):
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    account = Account(graph, {MEDIA_1: [_comment("18100000000000001", timedelta(minutes=5), SECRET_TEXT)]})
    _check(actors, read=1, new=1, replied=1, skipped=0, errorCode="")
    # One public reply, with the page's token, through the same auto-reply path as the webhook.
    assert graph.posts() == [("18100000000000001/replies", {"message": THANKS}, f"PAGE-TOKEN-{IG_PAGE_FB}")]
    [log] = _logs()
    assert log["source"] == "manual_check" and log["actions"] == ["public"] and log["postId"] == MEDIA_1
    assert log["commentId"] == "18100000000000001" and log["fromId"] == "7001"
    # Meta delivers the same comment by webhook later: never answered a second time.
    assert studio.handle_meta_webhook(_ig_webhook("18100000000000001", MEDIA_1, "7001", SECRET_TEXT)) == 0
    assert len(graph.posts()) == 1 and len(_logs()) == 1
    # The next check: the count did not change, so the comments are not even read again.
    _next_minute()
    _check(actors, read=0, new=0, replied=0, skipped=0)
    assert graph.reads("/comments") == [f"{MEDIA_1}/comments"]
    # Our reply raises Meta's count: the media is read again, but the comment is behind the cursor.
    account.extra_count[MEDIA_1] = 1
    _next_minute()
    _check(actors, read=1, new=0, replied=0, skipped=1)
    assert len(graph.posts()) == 1
    # The other way round: the webhook answers first, then a check reads the comment: still one reply.
    account.media[MEDIA_1].append(_comment("18100000000000002", timedelta(minutes=1), "second"))
    assert studio.handle_meta_webhook(_ig_webhook("18100000000000002", MEDIA_1, "7001", "second")) == 1
    _next_minute()
    _check(actors, read=2, new=1, replied=0, skipped=1)
    assert [path for path, _body, _token in graph.posts()] == ["18100000000000001/replies", "18100000000000002/replies"]
    assert sorted(log["source"] for log in _logs()) == ["manual_check", "webhook"]


def test_old_comments_ignored(actors, graph):
    _ig_page(actors)
    _rule(actors, "srule_price", created_ago=timedelta(hours=3), trigger="keywords", keywords=["price"], reply="Price sent")
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    account = Account(graph, {MEDIA_1: [
        _comment("18200000000000001", timedelta(hours=4), "price please"),  # before every rule
        _comment("18200000000000002", timedelta(hours=2), "hello"),         # only the newer rule matches it
        _comment("18200000000000003", timedelta(hours=2), "price?"),        # the older rule answers it
        _comment("18200000000000004", timedelta(minutes=10), "hello"),      # after both rules
    ]})
    _check(actors, read=4, new=3, replied=2, skipped=1)
    # A rule never answers a comment written before the rule existed.
    assert graph.posts() == [("18200000000000003/replies", {"message": "Price sent"}, f"PAGE-TOKEN-{IG_PAGE_FB}"),
                             ("18200000000000004/replies", {"message": THANKS}, f"PAGE-TOKEN-{IG_PAGE_FB}")]
    # The older rule now answers every comment: a comment an earlier check already saw is never answered.
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='socialReplyRules' AND id='srule_price'")).mappings().first()
        data = {**json_loads(row["data_json"]), "trigger": "every", "keywords": []}
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type='socialReplyRules' AND id='srule_price'"), {"d": json_dumps(data)})
    account.media[MEDIA_1].append(_comment("18200000000000005", timedelta(minutes=1), "new one"))
    _next_minute()
    _check(actors, read=5, new=1, replied=1, skipped=4)
    assert [path for path, _body, _token in graph.posts()][2:] == ["18200000000000005/replies"]
    # A comment that shows up late with an old time (behind the cursor) is never answered either.
    account.media[MEDIA_1].append(_comment("18200000000000006", timedelta(minutes=30), "late"))
    _next_minute()
    _check(actors, read=6, new=0, replied=0, skipped=6)
    assert len(graph.posts()) == 3


def test_comments_older_than_seven_days_or_without_an_author_are_skipped(actors, graph):
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(days=10))
    Account(graph, {
        MEDIA_1: [_comment("18300000000000001", timedelta(days=8), "too old"),
                  _comment("18300000000000002", timedelta(days=6), "recent enough"),
                  _comment("18300000000000003", timedelta(minutes=3), "no author", author=None),
                  _comment("18300000000000004", timedelta(minutes=2), "by the account", author=IG_USER)],
        MEDIA_2: [{**_comment("18300000000000005", timedelta(minutes=1)), "timestamp": "not a time"},
                  _comment("18300000000000006", timedelta(minutes=1), "second media")],
    })
    _check(actors, read=6, new=2, replied=2, skipped=4)
    assert sorted(path for path, _body, _token in graph.posts()) == ["18300000000000002/replies", "18300000000000006/replies"]


def test_comments_written_before_the_account_was_linked_are_skipped(actors, graph):
    _ig_page(actors, linked_ago=timedelta(hours=1))  # the owner's rule is older than the link
    _rule(actors, "srule_all", created_ago=timedelta(days=2))
    Account(graph, {MEDIA_1: [_comment("18310000000000001", timedelta(hours=2), "before the link"),
                              _comment("18310000000000002", timedelta(minutes=10), "after the link")]})
    _check(actors, read=2, new=1, replied=1, skipped=1)
    assert [path for path, _body, _token in graph.posts()] == ["18310000000000002/replies"]


def test_comments_written_while_the_account_was_unlinked_are_skipped_after_a_relink(actors, graph):
    """Linking the same account to the same owner again revives the OLD row (P4-01: an old created_at)
    with a fresh linkedAt: the floor is the relink, so a comment the owner answered by hand while
    Albayan was not managing the account is never auto-replied."""
    owner = actors["customer"]["id"]
    relinked = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1)
    _insert("socialPages", "spg_ig_1", {
        "ownerId": owner, "metaPageId": IG_PAGE_FB, "platform": "ig", "igUserId": IG_USER, "name": "Shop", "healthy": True,
        "linkedAt": relinked.isoformat().replace("+00:00", "Z"),
    }, owner=owner, created_at=now_ms() - 30 * 86_400_000)
    assert studio_ig_poll.load_instagram_page("spg_ig_1")["linkedSecond"] == int(relinked.timestamp())
    _rule(actors, "srule_all", created_ago=timedelta(days=2))
    Account(graph, {MEDIA_1: [_comment("18320000000000001", timedelta(hours=2), "while it was unlinked"),
                              _comment("18320000000000002", timedelta(minutes=10), "after the relink")]})
    _check(actors, read=2, new=1, replied=1, skipped=1)
    assert [path for path, _body, _token in graph.posts()] == ["18320000000000002/replies"]


def test_no_enabled_instagram_rule_answers_nothing_and_moves_the_cursor(actors, graph):
    _ig_page(actors)
    _rule(actors, "srule_off", created_ago=timedelta(hours=2), enabled=False)
    _rule(actors, "srule_fb", created_ago=timedelta(hours=2), platform="fb")
    account = Account(graph, {MEDIA_1: [_comment("18400000000000001", timedelta(minutes=5))]})
    _check(actors, read=1, new=0, replied=0, skipped=1)
    # A rule made afterwards never answers the comment seen before it.
    _rule(actors, "srule_all", created_ago=timedelta(seconds=1))
    account.extra_count[MEDIA_1] = 1
    _next_minute()
    _check(actors, read=1, new=0, replied=0, skipped=1)
    assert graph.posts() == []


def test_a_rule_switched_on_later_never_answers_comments_from_while_it_was_off(actors, graph):
    _ig_page(actors)
    # Made three hours ago, off until 30 minutes ago (activeSince): the check's floor is its activeSince.
    owner = actors["customer"]["id"]
    _rule(actors, "srule_back_on", created_ago=timedelta(hours=3), active_ago=timedelta(minutes=30))
    later = _comment("18500000000000002", timedelta(minutes=10), "after it came back")
    Account(graph, {MEDIA_1: [_comment("18500000000000001", timedelta(hours=1), "while it was off"), later]})
    _check(actors, read=2, new=1, replied=1, skipped=1)
    assert [path for path, _body, _token in graph.posts()] == ["18500000000000002/replies"]
    [log] = _logs()
    assert log["commentAt"] == later["timestamp"].replace("+0000", "Z") != log["at"]  # the retry window starts here
    with db_conn() as conn:
        floor = studio_ig_poll.rule_floor_second(conn, owner)
    assert abs(floor - (now_ms() // 1000 - 30 * 60)) <= 2  # its activeSince, not its creation three hours ago
    _rule(actors, "srule_legacy", created_ago=timedelta(hours=2))  # a rule from before activeSince: its creation
    with db_conn() as conn:
        floor = studio_ig_poll.rule_floor_second(conn, owner)
    assert abs(floor - (now_ms() // 1000 - 2 * 3600)) <= 2


def test_a_rule_pointed_at_instagram_later_never_answers_older_comments(actors, graph):
    """The floor comes from an older rule, so the comment is fed; process_comment still keeps the rule
    moved from Facebook to Instagram 20 minutes ago away from a comment written an hour ago."""
    _ig_page(actors)
    _rule(actors, "srule_price", created_ago=timedelta(hours=3), trigger="keywords", keywords=["price"], reply="Price sent")
    _rule(actors, "srule_moved", created_ago=timedelta(hours=3), active_ago=timedelta(minutes=20))
    Account(graph, {MEDIA_1: [_comment("18510000000000001", timedelta(hours=1), "hello"),
                              _comment("18510000000000002", timedelta(minutes=5), "hello again")]})
    _check(actors, read=2, new=2, replied=1)
    assert [path for path, _body, _token in graph.posts()] == ["18510000000000002/replies"]
    assert [log["ruleId"] for log in _logs()] == ["srule_moved"]


# ---------------------------------------------------------------------------
# Access, limits, audit, privacy
# ---------------------------------------------------------------------------


def test_check_comments_admin_only_same_origin_and_page_checks(actors, graph, monkeypatch):
    _ig_page(actors)
    _ig_page(actors, "spg_fb_1", platform="fb")
    _ig_page(actors, "spg_gone", deleted=True)
    for who in ("staff", "customer"):
        _error(_press(actors, who=who), 403, "ADMIN_ONLY")
    client.cookies.clear()
    assert client.post(f"{API}/pages/spg_ig_1/check-comments").status_code == 401
    _error(_press(actors, headers={"Origin": "https://evil.example"}), 403, "CROSS_SITE")
    for page_id in ("spg_gone", "spg_missing", "bad%20id"):
        _error(_press(actors, page_id), 404, "UNKNOWN_PAGE")
    _error(_press(actors, "spg_fb_1"), 409, "NOT_INSTAGRAM")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    _error(_press(actors), 409, "META_NOT_CONFIGURED")
    assert graph.calls == []  # nothing refused reached Meta
    # None of the refusals used the account's minute.
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-never-leaks")
    Account(graph, {MEDIA_1: []})
    _check(actors, read=0, new=0, replied=0, skipped=0)


def test_one_check_a_minute_per_account_and_ten_presses_per_admin(actors, graph):
    _ig_page(actors)
    Account(graph, {MEDIA_1: [_comment("18500000000000001", timedelta(minutes=5))]})
    _check(actors, read=1)
    refused = _error(_press(actors), 429, "RATE_LIMITED")
    assert "less than a minute" in refused["message"]
    retry = _press(actors, who="admin2")  # another admin: the same account is still refused
    _error(retry, 429, "RATE_LIMITED")
    assert 1 <= int(retry.headers["Retry-After"]) <= 60
    assert len(graph.reads("/media")) == 1
    for _ in range(9):  # 10 presses a minute per admin, refused ones included (the 429 above was the first)
        _error(_press(actors, "spg_missing", who="admin2"), 404, "UNKNOWN_PAGE")
    _error(_press(actors, "spg_missing", who="admin2"), 429, "RATE_LIMITED")


def test_counts_only_audited_and_the_cursor_keeps_no_meta_ids(actors, graph):
    started = now_ms()
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    Account(graph, {MEDIA_1: [_comment("18600000000000001", timedelta(minutes=5), SECRET_TEXT, author="17061706170617061")]})
    body = _check(actors, read=1, new=1, replied=1, skipped=0)
    [audit] = _audit_rows(actors["admin"]["id"], started)
    assert audit["resource_type"] == "socialPages" and audit["resource_id"] == "spg_ig_1"
    assert audit["metadata"] == {"read": 1, "new": 1, "replied": 1, "skipped": 0, "source": "manual_check",
                                 "mediaRead": 1, "errorCode": "", "providerCode": ""}
    state = meta_ads.load_meta_health_state(studio_ig_poll.CHECK_STATE_ID)
    [account] = state["accounts"].values()
    [entry] = account["media"].values()
    assert entry["count"] == 1 and entry["lastAt"].endswith("Z") and len(entry["lastIds"]) == 1
    for dumped in (json.dumps(body), audit["metadata_json"], json.dumps(state)):
        for secret in (IG_USER, IG_PAGE_FB, MEDIA_1, "18600000000000001", "17061706170617061", SECRET_TEXT, "PAGE-TOKEN", "system-token"):
            assert secret not in dumped


def test_meta_errors_are_codes_and_unread_media_are_read_next_time(actors, graph, token_checks):
    started = now_ms()
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    account = Account(graph, {MEDIA_1: [_comment("18700000000000001", timedelta(minutes=5))],
                              MEDIA_2: [_comment("18700000000000002", timedelta(minutes=4))]})
    graph.routes[("GET", f"{MEDIA_2}/comments")] = meta_ads.MetaAdsError("temporary", "secret text", retryable=True, provider_code="2")
    _check(actors, read=1, new=1, replied=1, skipped=0, errorCode="temporary")
    assert _audit_rows(actors["admin"]["id"], started)[0]["metadata"]["providerCode"] == "2"
    # The media Meta did not answer is read on the next check, and its comment answered then.
    account.route(graph, MEDIA_2)
    _next_minute()
    _check(actors, read=1, new=1, replied=1, errorCode="")
    assert [path for path, _body, _token in graph.posts()] == ["18700000000000001/replies", "18700000000000002/replies"]
    assert token_checks == []  # a temporary error is not an authorization problem
    # A refused media list is a code, never Meta's text; an authorization refusal runs the studio's
    # token check, as Social Studio's replies do.
    graph.routes[("GET", f"{IG_USER}/media")] = meta_ads.MetaAdsError("authorization", "secret text", provider_code="190")
    _next_minute()
    body = _check(actors, read=0, new=0, replied=0, skipped=0, errorCode="authorization")
    assert "secret" not in json.dumps(body)
    assert token_checks == [True]


def test_meta_pause_reads_nothing_and_keeps_the_minute(actors, graph, monkeypatch):
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    account = Account(graph, {MEDIA_1: [_comment("18800000000000001", timedelta(minutes=5))]})
    meta_ads._mark_app_wide(120, reason="meta_4")  # Meta's app-wide limit (code 4): every lane waits
    meta_ads._set_meta_remote_backoff(120, reason="meta_4")
    refused = _press(actors)
    _error(refused, 409, "META_PAUSED")
    assert 60 < int(refused.headers["Retry-After"]) <= 120
    assert graph.calls == []
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    # The pause begins during the check: nothing reached Meta, so the minute is given back.
    graph.routes[("GET", f"{IG_USER}/media")] = meta_ads.MetaAdsError(
        "rate_limited", "Meta synchronization is paused safely and will resume automatically.", retryable=True)
    _error(_press(actors), 409, "META_PAUSED")
    Account(graph, account.media)
    _check(actors, read=1, new=1, replied=1)


def test_the_check_reads_on_the_linked_page_lane(actors, graph):
    """PLAN P3-00: the reads run in meta_call_lane("page", subject=<the linked metaPageId>), and the
    press waits only for what that lane waits for (an app-wide pause, a park of that page)."""
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    account = Account(graph, {MEDIA_1: [_comment("18810000000000001", timedelta(minutes=5))]})
    # Meta's ads limit paused the admin lane (Albayan Manager's sync): the check still reads.
    meta_ads._set_meta_remote_backoff(600, reason="meta_80004")
    _check(actors, read=1, new=1, replied=1)
    reads = [lane for method, path, lane in graph.lanes if method == "GET" and path.startswith((IG_USER, MEDIA_1))]
    assert reads == [("page", IG_PAGE_FB), ("page", IG_PAGE_FB)]  # the media list and the one media's comments
    # A park of another page does not hold it up either.
    meta_ads._park_lane_objects("page", (FB_PAGE,), 300, reason="meta_80001")
    account.media[MEDIA_1].append(_comment("18810000000000002", timedelta(minutes=1)))
    _next_minute()
    _check(actors, read=2, new=1, replied=1)
    # A park of the linked page: refused before anything is read, and the account's minute stays free.
    meta_ads._park_lane_objects("page", (IG_PAGE_FB,), 300, reason="meta_80001")
    _next_minute()
    calls = len(graph.calls)
    refused = _press(actors)
    _error(refused, 409, "META_PAUSED")
    assert 240 < int(refused.headers["Retry-After"]) <= 300
    assert len(graph.calls) == calls


def test_a_capped_or_crashed_comment_waits_for_the_next_check(actors, graph, monkeypatch):
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    Account(graph, {MEDIA_1: [_comment(f"1890000000000000{n}", timedelta(minutes=10 - n)) for n in range(1, 5)]})
    monkeypatch.setattr(studio_ig_poll, "MAX_FED_PER_CHECK", 2)
    original = studio.process_comment
    crashed = []

    def flaky(**kwargs):
        if kwargs["comment_id"] == "18900000000000002" and not crashed:
            crashed.append(kwargs["comment_id"])
            raise RuntimeError("database hiccup")
        return original(**kwargs)

    monkeypatch.setattr(studio, "process_comment", flaky)
    _check(actors, read=4, new=4, replied=1, skipped=0)  # oldest first: 1 answered, 2 crashed, 3 and 4 wait
    _next_minute()
    _check(actors, read=4, new=3, replied=2, skipped=1)  # 2 and 3 now
    _next_minute()
    _check(actors, read=4, new=1, replied=1, skipped=3)  # 4
    assert [path for path, _body, _token in graph.posts()] == [
        f"1890000000000000{n}/replies" for n in (1, 2, 3, 4)]
    _next_minute()
    _check(actors, read=0, new=0, replied=0)  # settled: the count is kept, nothing is read again


# ---------------------------------------------------------------------------
# process_comment sources (social_studio.py)
# ---------------------------------------------------------------------------


def test_process_comment_sources(actors, graph):
    _ig_page(actors)
    _rule(actors, "srule_all", created_ago=timedelta(hours=1))
    base = {"platform": "ig", "entry_id": IG_USER, "post_ref": MEDIA_1, "from_id": "7091", "text": "hi"}
    with pytest.raises(ValueError):
        studio.process_comment(comment_id="18990000000000001", source="elsewhere", **base)
    # A comment Albayan read without its time, or written before every rule, is never answered.
    assert studio.process_comment(comment_id="18990000000000002", source="manual_check", **base) is None
    before = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    assert studio.process_comment(comment_id="18990000000000003", source="poll", comment_at=before, **base) is None
    assert graph.posts() == [] and _logs() == []
    recent = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    log = studio.process_comment(comment_id="18990000000000004", source="manual_check", comment_at=recent, **base)
    assert log["source"] == "manual_check" and log["actions"] == ["public"]
    # The webhook keeps its behaviour (no time needed) and says where the comment came from.
    assert studio.handle_meta_webhook(_ig_webhook("18990000000000005", MEDIA_1, "7092", "hello")) == 1
    assert {log["commentId"]: log["source"] for log in _logs()} == {
        "18990000000000004": "manual_check", "18990000000000005": "webhook"}
    # The same comment from any source is answered once.
    assert studio.process_comment(comment_id="18990000000000005", source="manual_check", comment_at=recent, **base) is None
    assert len(graph.posts()) == 2


def test_comment_times_as_meta_writes_them():
    assert studio_ig_poll.comment_second("2026-09-24T08:00:00+0000") == int(datetime(2026, 9, 24, 8, tzinfo=timezone.utc).timestamp())
    assert studio_ig_poll.comment_second("2026-09-24T10:00:00+0200") == studio_ig_poll.comment_second("2026-09-24T08:00:00Z")
    assert studio_ig_poll.comment_second("") is None and studio_ig_poll.comment_second("yesterday") is None
