"""Review loop round 1, batch B1: Social Studio (server/systems/ads_studio/social_studio.py).

Behaviour tests for the verified findings of the batch; each one failed before its fix:

* 7/21  a far-year ``scheduledAt`` with an offset, or a non-list ``media`` on PATCH, is a 400, not a 500;
* 8     two admins linking the same Meta page at the same moment make ONE socialPages row (one 409);
* 17    a customer can still switch a rule off/on (or rename it) once its channel is unavailable;
* 18    a rule whose every action waits for a closed channel does not take a comment a later rule answers;
* 19    a comment on a live post still in the scheduled / publishing / draft status gets the post's rule
        (and a comment without a post id matches no post through a failed page's empty metaPostId);
* 20    a post whose auto-reply rule was deleted can be saved again from the composer.

Users are made here with unique emails; every Meta call is faked (nothing reaches the network).
Run: python -m pytest server/test_review_loop_r1_B1.py -q
"""

import os
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server.systems.ads_studio import studio_settings
from server.systems.ads_studio.studio_types import STUDIO_SETTINGS_TYPE


client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/social-studio"
TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR1B1!Secure"
ALL_ON = {"fbPublicReply": "on", "fbPrivateReply": "on", "igPublicReply": "on", "igPrivateReply": "on"}
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
        email = f"review-r1-b1-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Review B1 {key}", email, role)
        if subscribed:
            _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    return out


def _wipe(actors):
    """Only this module's owners' Social Studio rows (other modules' rows are left alone)."""
    owners = [who["id"] for who in actors.values()]
    with db_conn() as conn:
        for owner in owners:
            for kind in SOCIAL_TYPES:
                conn.execute(text("DELETE FROM entities WHERE type = :type AND created_by = :owner"),
                             {"type": kind, "owner": owner})


def _arm(capabilities):
    record = studio_settings.read_setting("capabilities")
    studio_settings.save_setting("capabilities", capabilities, record["version"], "test", studio._iso_now(),
                                 audit=lambda conn, before, after: None)


def _disarm():
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :type AND id = :id"),
                     {"type": STUDIO_SETTINGS_TYPE, "id": studio_settings.setting_id("capabilities")})


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, actors):
    for who in actors.values():
        reset_rate_limit(f"social-studio:mutations:{who['id']}")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-review-b1")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-review-b1")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe(actors)
    _disarm()
    yield
    _disarm()
    _wipe(actors)


class FakeGraph:
    def __init__(self):
        self.calls = []

    def post(self, path, data, token):
        self.calls.append((path, dict(data or {})))
        return {"id": f"{path.replace('/', '_')}_id"}

    def paths(self):
        return [path for path, _data in self.calls]


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
    return f"73{secrets.randbelow(10 ** 12):012d}"


def _link(actors, owner_key, meta_page_id, platform="fb"):
    response = client.post(f"{API}/pages/link", json={"ownerId": actors[owner_key]["id"], "metaPageId": meta_page_id,
                                                      "platform": platform, "name": "B1 page"},
                           cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _rule(cookies, **overrides):
    body = {"name": "Thanks", "platform": "fb", "trigger": "every", "publicReply": "Thanks!"}
    body.update(overrides)
    response = client.post(f"{API}/rules", json=body, cookies=cookies)
    assert response.status_code == 200, response.text
    time.sleep(0.01)  # rules are tried oldest first: never two in the same millisecond
    return response.json()


def _log_rows(owner_id):
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT data_json FROM entities WHERE type='socialReplyLog' AND deleted=false AND created_by=:o"),
            {"o": owner_id},
        ).mappings().all()
    return [json_loads(r["data_json"]) for r in rows]


def _comment(meta_page_id, comment_id, message, post_ref="post_1", from_id="9090"):
    return studio.process_comment(platform="fb", entry_id=meta_page_id, comment_id=comment_id, post_ref=post_ref,
                                  from_id=from_id, text=message, source="webhook")


# ---------------------------------------------------------------------------
# 7 / 21: customer-reachable 500s on the post routes
# ---------------------------------------------------------------------------


def test_parse_iso_answers_none_for_a_date_its_zone_moves_past_the_calendar():
    assert studio._parse_iso("0001-01-01T00:00:00+14:00") is None
    assert studio._parse_iso("9999-12-31T23:59:59-14:00") is None
    assert studio._parse_iso("2026-09-29T10:00:00+02:00") == datetime(2026, 9, 29, 8, 0, tzinfo=timezone.utc)
    assert studio._parse_iso("2026-09-29T10:00:00") == datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("when", ["9999-12-31T23:59:59-05:00", "0001-01-01T00:00:00+05:00"])
def test_far_year_scheduled_at_is_a_400_not_a_500(actors, when):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    draft = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x", "scheduledAt": when}, cookies=a)
    assert draft.status_code == 400 and draft.json()["detail"] == "scheduledAt must be an ISO date-time"
    scheduled = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x", "status": "scheduled",
                                                  "scheduledAt": when}, cookies=a)
    assert scheduled.status_code == 400 and scheduled.json()["detail"] == "scheduledAt is required to schedule a post"
    saved = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x"}, cookies=a)
    assert saved.status_code == 200, saved.text
    patched = client.patch(f"{API}/posts/{saved.json()['id']}", json={"scheduledAt": when}, cookies=a)
    assert patched.status_code == 400 and patched.json()["detail"] == "scheduledAt must be an ISO date-time"


@pytest.mark.parametrize("media", [5, True, 2.5])
def test_patch_with_a_non_list_media_is_a_400_not_a_500(actors, media):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    saved = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x"}, cookies=a)
    assert saved.status_code == 200, saved.text
    patched = client.patch(f"{API}/posts/{saved.json()['id']}", json={"media": media}, cookies=a)
    assert patched.status_code == 400 and patched.json()["detail"] == "media must be a list of images"
    # A null media still means "no photos" as before.
    assert client.patch(f"{API}/posts/{saved.json()['id']}", json={"media": None}, cookies=a).status_code == 200


# ---------------------------------------------------------------------------
# 8: linking one Meta page twice at the same moment
# ---------------------------------------------------------------------------


def test_two_links_of_one_meta_page_at_once_make_one_row(actors, monkeypatch):
    real_revive = studio._revive_unlinked_page
    barrier = threading.Barrier(2, timeout=2)

    def revive_after_both_checked(*args, **kwargs):
        # Before the fix both requests passed the already-linked check before either inserted;
        # with the guard the second one waits for the first, so the barrier only times out.
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass
        return real_revive(*args, **kwargs)

    monkeypatch.setattr(studio, "_revive_unlinked_page", revive_after_both_checked)
    meta_page_id = _meta_id()
    statuses = []

    def link(owner_key):
        own_client = TestClient(app, headers={"Origin": "http://testserver"})
        response = own_client.post(f"{API}/pages/link", json={"ownerId": actors[owner_key]["id"], "metaPageId": meta_page_id,
                                                               "platform": "fb", "name": "Race"},
                                   cookies=actors["admin"]["cookies"])
        statuses.append((response.status_code, response.json().get("detail", "")))

    threads = [threading.Thread(target=link, args=(key,)) for key in ("a", "b")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(code for code, _detail in statuses) == [200, 409], statuses
    assert [d for c, d in statuses if c == 409] == ["This page is already linked to an account"]
    rows = [r for r in studio._rows_where_json(studio.PAGES_TYPE, "metaPageId", meta_page_id) if r["data"].get("platform") == "fb"]
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# 17: the rule switch while a channel is unavailable
# ---------------------------------------------------------------------------


def test_rule_switch_and_rename_work_while_its_channel_is_unavailable(actors):
    a = actors["a"]["cookies"]
    both = _rule(a, name="Both", publicReply="hi", dmEnabled=True, dmText="dm", likeComment=True)  # saved while unarmed
    dm_only = _rule(a, name="DM only", publicReply="", dmEnabled=True, dmText="dm")
    public_only = _rule(a, name="Public only", publicReply="hi")
    _arm({"fbPrivateReply": "unavailable", "fbPublicReply": "off", "igPublicReply": "on", "igPrivateReply": "unavailable"})
    for rule in (both, dm_only):
        off = client.patch(f"{API}/rules/{rule['id']}", json={"enabled": False}, cookies=a)
        assert off.status_code == 200, off.text
        assert off.json()["enabled"] is False
        on = client.patch(f"{API}/rules/{rule['id']}", json={"enabled": True}, cookies=a)
        assert on.status_code == 200 and on.json()["enabled"] is True
        renamed = client.patch(f"{API}/rules/{rule['id']}", json={"name": "Renamed"}, cookies=a)
        assert renamed.status_code == 200 and renamed.json()["name"] == "Renamed"
    assert client.patch(f"{API}/rules/{both['id']}", json={"dmText": "new words"}, cookies=a).status_code == 200
    # An action the rule newly asks for is still refused, with the reason.
    refused = client.patch(f"{API}/rules/{public_only['id']}", json={"dmEnabled": True, "dmText": "x"}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Private messages are not available for Facebook pages right now"
    refused = client.patch(f"{API}/rules/{dm_only['id']}", json={"publicReply": "now public"}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Public replies are not available for Facebook pages right now"
    # Moving a rule to another platform asks that platform's channel anew.
    refused = client.patch(f"{API}/rules/{dm_only['id']}", json={"platform": "ig"}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Private messages are not available for Instagram accounts right now"
    # A new rule is refused as before.
    created = client.post(f"{API}/rules", json={"name": "New DM", "platform": "fb", "dmEnabled": True, "dmText": "hi"}, cookies=a)
    assert created.status_code == 400


# ---------------------------------------------------------------------------
# 18: a rule that can only wait does not take the comment
# ---------------------------------------------------------------------------


def test_a_held_rule_leaves_the_comment_to_a_rule_that_can_send(actors, graph):
    a = actors["a"]["cookies"]
    meta_page_id = _meta_id()
    _link(actors, "a", meta_page_id)
    held = _rule(a, name="Price", trigger="keywords", keywords=["price"], publicReply="", dmEnabled=True, dmText="DM price")
    public = _rule(a, name="All", publicReply="Thanks, message us")
    _arm({**ALL_ON, "fbPrivateReply": "gated"})
    _comment(meta_page_id, f"{meta_page_id}_1", "price?")
    assert graph.paths() == [f"{meta_page_id}_1/comments"]
    row = _log_rows(actors["a"]["id"])[0]
    assert row["ruleId"] == public["id"] and row["actions"] == ["public"]
    assert held["id"] != public["id"]


def test_when_no_rule_can_send_the_first_held_rule_still_logs_the_skip(actors, graph):
    a = actors["a"]["cookies"]
    meta_page_id = _meta_id()
    _link(actors, "a", meta_page_id)
    held = _rule(a, name="Price", trigger="keywords", keywords=["price"], publicReply="", dmEnabled=True, dmText="DM price")
    _rule(a, name="All", publicReply="Thanks")
    _arm({**ALL_ON, "fbPrivateReply": "gated", "fbPublicReply": "off"})
    _comment(meta_page_id, f"{meta_page_id}_1", "price?")
    assert graph.calls == []
    row = _log_rows(actors["a"]["id"])[0]
    assert row["ruleId"] == held["id"] and row["actions"] == [] and row["problemCode"] == "channel_gated"


def test_a_held_preferred_rule_leaves_the_comment_to_a_rule_that_can_send(actors, graph):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    held = _rule(a, name="DM", publicReply="", dmEnabled=True, dmText="DM")
    public = _rule(a, name="All", publicReply="Thanks")
    post = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x", "autoReplyRuleId": held["id"]}, cookies=a)
    assert post.status_code == 200, post.text
    studio._ctx()["patch_entity"](studio.POSTS_TYPE, post.json()["id"], {
        "status": "published", "results": [{"pageId": page["id"], "metaPostId": f"{meta_page_id}_77", "error": ""}],
    }, owner)
    _arm({**ALL_ON, "fbPrivateReply": "gated"})
    _comment(meta_page_id, f"{meta_page_id}_2", "hello", post_ref=f"{meta_page_id}_77")
    row = _log_rows(owner)[0]
    assert row["ruleId"] == public["id"] and row["actions"] == ["public"]


# ---------------------------------------------------------------------------
# 19: a live post that is not (yet / any more) "published"
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["scheduled", "publishing", "draft"])
def test_comment_on_a_live_post_in_another_status_gets_the_posts_rule(actors, graph, status):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    rule = _rule(a, name="This post", scope="chosen", postIds=["some_other_post"], publicReply="On this post")
    post = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x", "autoReplyRuleId": rule["id"]}, cookies=a)
    assert post.status_code == 200, post.text
    live_ref = f"{meta_page_id}_55"
    studio._ctx()["patch_entity"](studio.POSTS_TYPE, post.json()["id"], {
        "status": status,
        "results": [{"pageId": page["id"], "metaPostId": live_ref, "error": ""},
                    {"pageId": "spg_other", "metaPostId": "", "error": "x", "retryable": True}],
    }, owner)
    logged = _comment(meta_page_id, f"{meta_page_id}_3", "nice", post_ref=live_ref)
    assert logged is not None and logged["ruleId"] == rule["id"]
    assert graph.paths() == [f"{meta_page_id}_3/comments"]


@pytest.mark.parametrize("status", ["scheduled", "failed", "draft"])
def test_comment_without_a_post_id_matches_no_post_by_its_failed_page(actors, graph, status):
    # A failed page result keeps metaPostId "": a comment Meta sent without a post id must not
    # match it, so neither the post's own auto-reply rule nor a rule chosen for the post answers.
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    post = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x"}, cookies=a)
    assert post.status_code == 200, post.text
    post_id = post.json()["id"]
    own = _rule(a, name="This post", scope="chosen", postIds=["some_other_post"], publicReply="On this post")
    chosen = _rule(a, name="Chosen", scope="chosen", postIds=[post_id], publicReply="Chosen post")
    general = _rule(a, name="All", publicReply="Thanks")
    studio._ctx()["patch_entity"](studio.POSTS_TYPE, post_id, {
        "status": status, "autoReplyRuleId": own["id"],
        "results": [{"pageId": page["id"], "metaPostId": "", "error": "x", "retryable": True}],
    }, owner)
    logged = _comment(meta_page_id, f"{meta_page_id}_4", "nice", post_ref="")
    assert logged is not None and logged["ruleId"] == general["id"], (logged, own["id"], chosen["id"])
    # The same comment ON the post (its real id) still gets the post's rule.
    studio._ctx()["patch_entity"](studio.POSTS_TYPE, post_id, {
        "results": [{"pageId": page["id"], "metaPostId": f"{meta_page_id}_66", "error": ""}],
    }, owner)
    logged = _comment(meta_page_id, f"{meta_page_id}_5", "nice", post_ref=f"{meta_page_id}_66")
    assert logged is not None and logged["ruleId"] == own["id"]


# ---------------------------------------------------------------------------
# 20: a post whose auto-reply rule was deleted
# ---------------------------------------------------------------------------


def test_post_whose_rule_was_deleted_can_be_saved_again(actors):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    rule = _rule(a, name="Gone")
    other_deleted = _rule(a, name="Also gone")
    foreign = _rule(actors["b"]["cookies"], name="Not yours")
    post = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "x", "autoReplyRuleId": rule["id"]}, cookies=a)
    assert post.status_code == 200, post.text
    post_id = post.json()["id"]
    assert client.delete(f"{API}/rules/{rule['id']}", cookies=a).status_code == 200
    assert client.delete(f"{API}/rules/{other_deleted['id']}", cookies=a).status_code == 200
    # The composer's body as it sends it: the stale id comes back with the rest.
    body = {"pageIds": [page["id"]], "caption": "changed", "media": [], "status": "draft", "scheduledAt": "",
            "autoReplyRuleId": rule["id"]}
    saved = client.patch(f"{API}/posts/{post_id}", json=body, cookies=a)
    assert saved.status_code == 200, saved.text
    assert saved.json()["autoReplyRuleId"] == "" and saved.json()["caption"] == "changed"
    # A newly chosen deleted rule, or another owner's rule, is still refused.
    for chosen in (rule["id"], other_deleted["id"], foreign["id"]):
        refused = client.patch(f"{API}/posts/{post_id}", json={**body, "autoReplyRuleId": chosen}, cookies=a)
        assert refused.status_code == 400 and refused.json()["detail"] == "autoReplyRuleId is not one of your rules"
