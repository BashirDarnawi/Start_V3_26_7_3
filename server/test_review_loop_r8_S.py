"""Review loop round 8, batch S: Social Studio server (social_studio.py).

Behaviour tests for the verified findings of the batch; each one failed before its fix:

* 8   a private reply that hit a temporary Meta error (1200) is retried even when the like or the
      public reply went out: the row waits (retryAfter) and the retry sends ONLY the private reply;
      a retry where one action lands and another hits a temporary error is re-armed, not closed;
* 9   the once-per-person check (run inside the comment lock every owner shares) parses only the
      reply-log rows whose text holds the person's id, each once, and stops after a short page,
      with the same answer as before (pages, other people, legacy rows, LIKE wildcards, >100 rows);
* 10  a reply Meta accepted while the database dropped (every save and the final write lost) is
      never sent again by the stuck-claim sweep; when the database is down before the first send,
      nothing is sent and the sweep re-arms the reply, which then goes out exactly once; a retry
      whose per-action save was lost records what went out when it is released.

Users are made here with unique emails; every Meta call is faked (nothing reaches the network).
Run: python -m pytest server/test_review_loop_r8_S.py -q
"""

import os
import secrets
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.exc import OperationalError

import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/social-studio"
TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR8S!Secure"
SOCIAL_TYPES = ("socialPages", "socialReplyRules", "socialPosts", "socialReplyLog")


def _insert_user(name, email, role):
    password = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    uid = new_id("user")
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"
            ),
            {
                "id": uid, "name": name, "email": email, "role": role, "perm": json_dumps({}),
                "h": password.hash_hex, "s": password.salt_hex, "a": password.algo,
                "i": password.iterations, "t": stamp,
            },
        )
    return uid


def _subscribe(uid):
    stamp = now_ms()
    sid = new_id("sub")
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
    data = {"id": sid, "userId": uid, "serviceId": "ad_maker", "status": "active", "expiresAt": expires}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('serviceSubscriptions',:id,:d,false,:t,:uid,:t)"
            ),
            {"id": sid, "d": json_dumps(data), "t": stamp, "uid": uid},
        )


def _login(email):
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


@pytest.fixture(scope="module")
def actors():
    init_db()
    out = {}
    for key, role, subscribed in (("admin", "Admin", False), ("a", "Employee", True), ("b", "Employee", True)):
        email = f"review-r8-s-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Review R8 S {key}", email, role)
        if subscribed:
            _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    return out


def _wipe(actors):
    """Only this module's owners' Social Studio rows (other modules' rows are left alone)."""
    with db_conn() as conn:
        for who in actors.values():
            for kind in SOCIAL_TYPES:
                conn.execute(text("DELETE FROM entities WHERE type = :type AND created_by = :owner"),
                             {"type": kind, "owner": who["id"]})


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, actors):
    for who in actors.values():
        reset_rate_limit(f"social-studio:mutations:{who['id']}")
        reset_rate_limit(f"social-studio:log:{who['id']}")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-review-r8-s")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-review-r8-s")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe(actors)
    yield
    _wipe(actors)


class FakeGraph:
    """Records every Graph POST (a failing one too); a path suffix can be told to fail."""

    def __init__(self):
        self.calls = []
        self.fail = {}

    def post(self, path, data, token):
        self.calls.append(path)
        for suffix, error in self.fail.items():
            if path.endswith(suffix):
                raise error
        return {"id": f"{path.replace('/', '_')}_id"}

    def mine(self, meta_page_id):
        """This test's calls only (a pass may also retry rows other modules left behind)."""
        return [path for path in self.calls if path.startswith(meta_page_id)]


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()

    def forbidden_get(self, path, params=None):
        raise AssertionError(f"unexpected Graph GET {path}")

    monkeypatch.setattr(meta_ads.MetaAdsClient, "_post",
                        lambda self, path, data=None, *, access_token=None: fake.post(path, data, access_token))
    monkeypatch.setattr(meta_ads.MetaAdsClient, "page_access_token", lambda self, page_id: f"PAGE-TOKEN-{page_id}")
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_get", forbidden_get)
    return fake


def _meta_id():
    """A numeric Meta page id no other module links (link_page refuses a page linked to anyone)."""
    return f"78{secrets.randbelow(10 ** 12):012d}"


def _link(actors, owner_key, meta_page_id):
    response = client.post(f"{API}/pages/link", json={"ownerId": actors[owner_key]["id"], "metaPageId": meta_page_id,
                                                      "platform": "fb", "name": "R8 S page"},
                           cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _rule(cookies, **overrides):
    body = {"name": "Price", "platform": "fb", "trigger": "every", "publicReply": "Thanks!"}
    body.update(overrides)
    response = client.post(f"{API}/rules", json=body, cookies=cookies)
    assert response.status_code == 200, response.text
    time.sleep(0.01)  # rules are tried oldest first: never two in the same millisecond
    return response.json()


def _comment(meta_page_id, comment_id, from_id="9201"):
    return studio.process_comment(platform="fb", entry_id=meta_page_id, comment_id=comment_id, post_ref="post_1",
                                  from_id=from_id, text="price?", source="webhook")


def _log_row(owner, comment_id):
    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = :type AND id = :id"),
                           {"type": studio.LOG_TYPE, "id": studio._log_id(owner, "fb", comment_id)}).scalar()
    return json_loads(raw)


def _retry(at):
    return studio._retry_pending_replies(at, limit=500)


def _temporary():
    return meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable. Albayan will retry.", retryable=True,
                                 provider_code="1200")


@contextmanager
def _statements():
    """Every SQL statement (text + parameters) the application sends while the block runs."""
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append((str(statement), repr(parameters)))

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", record)


# ---------------------------------------------------------------------------
# 8: a private reply hit by a temporary Meta error is retried when the rest went out
# ---------------------------------------------------------------------------


def test_private_reply_hit_by_a_temporary_error_is_retried_when_the_like_and_public_reply_landed(actors, graph):
    a, owner = actors["a"]["cookies"], actors["a"]["id"]
    meta = _meta_id()
    _link(actors, "a", meta)
    _rule(a, publicReply="Thanks", dmEnabled=True, dmText="The price is 20 LYD", likeComment=True)
    graph.fail["/messages"] = _temporary()  # Meta 1200: "Temporary send message failure"
    comment_id = f"{meta}_1"
    assert _comment(meta, comment_id) is not None
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public", "like"] and "dm:" in row["error"] and row["processing"] is False
    assert row["retryAfter"] and row["attempts"] == 1  # it was closed as "partial": the DM never went out
    assert not row.get("inFlight")
    first_answer = row["sentAt"]
    graph.fail.clear()
    _retry(datetime.now(timezone.utc) + timedelta(hours=1))
    # Only the private reply went out again: no second public reply, no second like.
    assert graph.mine(meta) == [f"{meta}/messages", f"{comment_id}/comments", f"{comment_id}/likes", f"{meta}/messages"]
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public", "like", "dm"] and row["retryAfter"] == "" and row["error"] == ""
    assert row["processing"] is False and row["sentAt"] == first_answer
    shown = {r["commentId"]: r for r in client.get(f"{API}/log", cookies=a).json()["rows"]}
    assert shown[comment_id]["outcome"] == "sent"


def test_a_retry_where_one_action_lands_and_another_hits_a_temporary_error_waits_again(actors, graph):
    a, owner = actors["a"]["cookies"], actors["a"]["id"]
    meta = _meta_id()
    _link(actors, "a", meta)
    _rule(a, publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)
    graph.fail["/messages"] = _temporary()
    graph.fail["/likes"] = _temporary()
    comment_id = f"{meta}_2"
    _comment(meta, comment_id)
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public"] and row["retryAfter"] and row["attempts"] == 1
    shown = {r["commentId"]: r for r in client.get(f"{API}/log", cookies=a).json()["rows"]}
    assert shown[comment_id]["outcome"] == "waiting"
    # The retry: the like lands, the private reply hits Meta's temporary error again -> it waits again.
    del graph.fail["/likes"]
    later = datetime.now(timezone.utc) + timedelta(hours=1)
    _retry(later)
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public", "like"] and row["retryAfter"] and row["attempts"] == 2 and "dm:" in row["error"]
    # The next retry sends only the private reply.
    graph.fail.clear()
    _retry(later + timedelta(hours=5))
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public", "like", "dm"] and row["retryAfter"] == "" and row["error"] == ""
    sent = graph.mine(meta)
    assert sent.count(f"{comment_id}/comments") == 1 and sent.count(f"{comment_id}/likes") == 2  # the failed try + the one that landed
    assert sent.count(f"{meta}/messages") == 3 and sent[-1] == f"{meta}/messages"


# ---------------------------------------------------------------------------
# 9: the once-per-person check reads only the person's rows
# ---------------------------------------------------------------------------


def _log(owner, row_id, **data):
    """A reply-log row of ``owner`` written straight to the table (id, data)."""
    return {"id": row_id, "data": json_dumps({"id": row_id, "ownerId": owner, **data}), "owner": owner}


def _insert_log_rows(rows):
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                     [{**row, "t": stamp} for row in rows])


def test_once_per_person_check_parses_only_the_rows_that_hold_the_person_id(actors):
    owner = actors["a"]["id"]
    page = f"spg_r8s_{TAG}"
    person = "person-r8s-9301"  # never inside a hex user id
    _insert_log_rows([_log(owner, f"srl_r8s_{TAG}_ok", pageId=page, fromId=person, ruleId="rule_a", actions=["dm"])])
    broken = f"srl_r8s_{TAG}_broken"
    with db_conn() as conn:  # another person's row the database cannot parse as JSON
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                     {"id": broken, "data": '{"ownerId":"' + owner + '","fromId":"5550001","pageId":', "t": now_ms(),
                      "owner": owner})
    try:
        # Before the fix every row of the owner went through the JSON parser (SQLite: "malformed JSON").
        assert studio._person_replied_rule_ids(owner, page, person) == {"rule_a"}
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type = 'socialReplyLog' AND id = :id"), {"id": broken})


def test_once_per_person_check_is_one_query_with_the_same_answer(actors):
    owner, other_owner = actors["a"]["id"], actors["b"]["id"]
    page, other_page = f"spg_r8s_{TAG}_p", f"spg_r8s_{TAG}_q"
    person = "u_1.2-3"  # "_" is a LIKE wildcard, "." and "-" plain
    rows = [_log(owner, f"srl_r8s_{TAG}_a{i:03d}", pageId=page, fromId=person, ruleId=f"rule_like_{i}", actions=["like"])
            for i in range(120)]  # a bare like is no answer; more than one page of the person's rows
    rows += [
        _log(owner, f"srl_r8s_{TAG}_z1", pageId=page, fromId=person, ruleId="rule_late", actions=["dm"]),  # after page one
        _log(owner, f"srl_r8s_{TAG}_z2", pageId=page, fromId=person, actions=["public"]),  # legacy: no rule id
        _log(owner, f"srl_r8s_{TAG}_z3", pageId=page, fromId=person, ruleId="rule_busy", actions=[], processing=True),
        _log(owner, f"srl_r8s_{TAG}_z4", pageId=page, fromId=person, ruleId="rule_wait", actions=[],
             retryAfter="2099-01-01T00:00:00Z"),
        _log(owner, f"srl_r8s_{TAG}_z5", pageId=page, fromId=person + "4", ruleId="rule_longer_id", actions=["dm"]),
        _log(owner, f"srl_r8s_{TAG}_z6", pageId=page, fromId="ux1.2-3", ruleId="rule_wildcard", actions=["dm"]),
        _log(owner, f"srl_r8s_{TAG}_z7", pageId=other_page, fromId=person, ruleId="rule_other_page", actions=["dm"]),
        _log(owner, f"srl_r8s_{TAG}_z8", pageId=page, fromId="someone", commentId=f"x_{person}", ruleId="rule_text_only",
             actions=["dm"]),
        _log(other_owner, f"srl_r8s_{TAG}_z9", pageId=page, fromId=person, ruleId="rule_other_owner", actions=["dm"]),
    ]
    odd = 'شخص "9"'  # not a plain Meta id: every row of the owner is read, the answer stays exact
    rows.append(_log(owner, f"srl_r8s_{TAG}_y1", pageId=page, fromId=odd, ruleId="rule_odd", actions=["public"]))
    solo = "solo-r8s-9302"
    rows.append(_log(owner, f"srl_r8s_{TAG}_y2", pageId=page, fromId=solo, ruleId="rule_solo", actions=["public"]))
    _insert_log_rows(rows)
    assert studio._person_replied_rule_ids(owner, page, person) == {"rule_late", "*", "rule_busy", "rule_wait"}
    assert studio._person_replied_rule_ids(owner, page, odd) == {"rule_odd"}
    assert studio._person_replied_rule_ids(owner, other_page, person) == {"rule_other_page"}
    assert studio._has_person_reply(owner, page, "nobody-r8s") is False
    with _statements() as seen:
        assert studio._person_replied_rule_ids(owner, page, solo) == {"rule_solo"}
    reads = [sql for sql, params in seen if studio.LOG_TYPE in params]
    assert len(reads) == 1, reads  # a short page is the last one: no second query that finds nothing
    assert "LIKE" in reads[0] and "json_extract(data_json, '$.fromId')" in reads[0]


def test_once_per_person_sql_parses_each_row_once_on_postgresql():
    sql = studio._person_history_sql("postgresql")
    assert sql.count("data_json::jsonb") == 1, sql  # the old query cast each row up to seven times
    inner = sql.split("FROM entities WHERE ", 1)[1]
    assert inner.startswith("type = :type AND deleted = false AND created_by = :owner AND data_json LIKE :needle ESCAPE '!'")
    assert sql.endswith("ORDER BY id ASC LIMIT 100")


# ---------------------------------------------------------------------------
# 10: the stuck-claim sweep never resends a reply Meta may have accepted
# ---------------------------------------------------------------------------


def _flaky_log_writes(monkeypatch, down):
    """Every reply-log patch fails while ``down()`` is true (the database dropped); other writes pass."""
    real = studio._ctx()["patch_entity"]

    def flaky(entity_type, entity_id, updates, user_id, **kwargs):
        if entity_type == studio.LOG_TYPE and down():
            raise OperationalError("UPDATE entities", {}, Exception("server closed the connection unexpectedly"))
        return real(entity_type, entity_id, updates, user_id, **kwargs)

    monkeypatch.setitem(studio._ctx(), "patch_entity", flaky)


def test_a_reply_meta_accepted_while_the_database_dropped_is_never_sent_again(actors, graph, monkeypatch):
    a, owner = actors["a"]["cookies"], actors["a"]["id"]
    meta = _meta_id()
    _link(actors, "a", meta)
    _rule(a, publicReply="Thanks for your comment")
    state = {"db": "up"}
    # The database drops once the first Meta call went out: the per-action save and the final write are lost.
    _flaky_log_writes(monkeypatch, lambda: state["db"] == "up" and bool(graph.calls))
    comment_id = f"{meta}_3"
    with pytest.raises(OperationalError):
        _comment(meta, comment_id)
    assert graph.mine(meta) == [f"{comment_id}/comments"]  # Meta accepted the public reply
    row = _log_row(owner, comment_id)
    assert row["processing"] is True and row["actions"] == [] and row["inFlight"] == ["public"]
    state["db"] = "back"
    now = datetime.now(timezone.utc)
    _retry(now + timedelta(minutes=16))  # the stuck-claim sweep
    _retry(now + timedelta(hours=2))  # a retry pass after it
    assert graph.mine(meta) == [f"{comment_id}/comments"]  # it was re-armed and posted a second time
    row = _log_row(owner, comment_id)
    assert row["processing"] is False and not row.get("retryAfter") and row["error"] == "interrupted"
    assert row["skipActions"] == ["public"]


def test_database_down_before_the_first_send_sends_nothing_and_the_sweep_answers_once(actors, graph, monkeypatch):
    a, owner = actors["a"]["cookies"], actors["a"]["id"]
    meta = _meta_id()
    _link(actors, "a", meta)
    _rule(a, publicReply="Thanks for your comment")
    state = {"db": "down"}
    _flaky_log_writes(monkeypatch, lambda: state["db"] == "down")  # the claim went in, then the database dropped
    comment_id = f"{meta}_4"
    with pytest.raises(OperationalError):
        _comment(meta, comment_id)
    assert graph.mine(meta) == []  # the in-flight mark could not be written: nothing was sent
    row = _log_row(owner, comment_id)
    assert row["processing"] is True and row["actions"] == [] and not row.get("inFlight")
    state["db"] = "back"
    now = datetime.now(timezone.utc)
    _retry(now + timedelta(minutes=16))  # nothing was sent and no send began: re-armed
    assert _log_row(owner, comment_id)["retryAfter"]
    _retry(now + timedelta(hours=2))
    assert graph.mine(meta) == [f"{comment_id}/comments"]  # exactly once
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["public"] and row["retryAfter"] == "" and row["processing"] is False
    assert row["inFlight"] == [] and row["error"] == ""


def test_a_released_retry_keeps_what_went_out_when_its_save_was_lost(actors, graph, monkeypatch):
    a, owner = actors["a"]["cookies"], actors["a"]["id"]
    meta = _meta_id()
    _link(actors, "a", meta)
    _rule(a, publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)
    for suffix in ("/messages", "/comments", "/likes"):
        graph.fail[suffix] = _temporary()
    comment_id = f"{meta}_5"
    _comment(meta, comment_id)
    assert _log_row(owner, comment_id)["retryAfter"]  # every action hit a temporary problem
    graph.fail.clear()
    graph.fail["/comments"] = RuntimeError("the connection broke in the middle of the public reply")
    state = {"lose_save": True}

    def save_lost():  # only the DM's per-action save is lost (the DB blinked right after Meta accepted it)
        return state["lose_save"] and graph.calls[-1:] == [f"{meta}/messages"]

    _flaky_log_writes(monkeypatch, save_lost)
    later = datetime.now(timezone.utc) + timedelta(hours=1)
    with pytest.raises(RuntimeError):
        _retry(later)
    row = _log_row(owner, comment_id)
    assert row["processing"] is False and row["error"] == "interrupted" and row["retryAfter"]
    assert row["actions"] == ["dm"]  # released from memory: the lost save no longer hides the DM
    state["lose_save"] = False
    graph.fail.clear()
    _retry(later + timedelta(hours=2))
    sent = graph.mine(meta)
    assert sent.count(f"{meta}/messages") == 2  # the failed first try and the one that landed: never a third
    row = _log_row(owner, comment_id)
    assert row["actions"] == ["dm", "public", "like"] and row["retryAfter"] == ""
