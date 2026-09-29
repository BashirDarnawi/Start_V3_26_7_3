"""Review loop round 4, batch SC: Social Studio screens, the server side (social_studio.py).

Behaviour tests for the verified findings of the batch that the server answers; each failed before its fix:

* 31  POST /posts takes the composer's ``operationId``: every try of one create names the same post, so a
      retry after a lost answer (the first try saved it) saves that post again as an edit instead of a
      second copy (two scheduled copies both published); a malformed operationId is refused; another
      owner's same operationId is a different post; a post of that name deleted since gives way to a new
      one; the second of two tries racing each other lands on the first one's post;
* 38  a caption, public reply, private message or rule name that starts with javascript: / vbscript: is
      refused with the reason (400) instead of being saved (and published) empty without a word.

The screens' side of the batch (32-37, 39) is in scripts/test-review-regressions.js and test-mobile-ui.js.
Users are made here with unique emails; every Meta call is faked (nothing reaches the network).
Run: python -m pytest server/test_review_loop_r4_SC.py -q
"""

import base64
import io
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
from PIL import Image
from sqlalchemy import text

import server.main as main_module
import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/social-studio"
TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR4SC!Secure"
SOCIAL_TYPES = ("socialPages", "socialReplyRules", "socialPosts", "socialReplyLog", "socialStudioSettings")


def _png_data_url(color=(10, 120, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


PHOTO = _png_data_url()


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
        email = f"review-r4-sc-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Review SC {key}", email, role)
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
        reset_rate_limit(f"ad-studio:media:{who['id']}")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-review-r4-sc")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-review-r4-sc")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe(actors)
    yield
    _wipe(actors)


@pytest.fixture
def graph(monkeypatch):
    calls = []

    def fake_post(self, path, data=None, *, access_token=None):
        calls.append((path, dict(data or {})))
        return {"id": f"{path.replace('/', '_')}_id"}

    def forbidden_get(self, path, params=None):
        raise AssertionError(f"unexpected Graph GET {path}")

    monkeypatch.setattr(meta_ads.MetaAdsClient, "_post", fake_post)
    monkeypatch.setattr(meta_ads.MetaAdsClient, "page_access_token", lambda self, page_id: f"PAGE-TOKEN-{page_id}")
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_get", forbidden_get)
    return calls


def _meta_id():
    """A numeric Meta page id no other module links (link_page refuses a page linked to anyone)."""
    return f"75{secrets.randbelow(10 ** 12):012d}"


def _link(actors, owner_key):
    response = client.post(f"{API}/pages/link", json={"ownerId": actors[owner_key]["id"], "metaPageId": _meta_id(),
                                                      "platform": "fb", "name": "SC page"},
                           cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _later(hours=3):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


def _post(cookies, page_id, **overrides):
    body = {"pageIds": [page_id], "caption": "A post", "status": "scheduled", "scheduledAt": _later()}
    body.update(overrides)
    return client.post(f"{API}/posts", json=body, cookies=cookies)


def _posts_of(owner):
    """This owner's live post rows: (id, data)."""
    with db_conn() as conn:
        rows = conn.execute(text("SELECT id, data_json FROM entities WHERE type = 'socialPosts' AND created_by = :owner "
                                 "AND deleted = false ORDER BY id"), {"owner": owner}).mappings().all()
    return [(row["id"], json_loads(row["data_json"])) for row in rows]


def _op_id():
    return f"spost_{now_ms()}_{secrets.token_hex(6)}"


# ---------------------------------------------------------------------------
# 31: a create retried after a lost answer saves one post
# ---------------------------------------------------------------------------


def test_create_retried_with_its_operation_id_saves_one_scheduled_post(actors, graph):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a")
    op = _op_id()
    first = _post(a, page["id"], media=[PHOTO], operationId=op)
    assert first.status_code == 200, first.text
    # The answer was lost on the way (the client timed out after the row was saved): the composer sends again.
    again = _post(a, page["id"], media=[PHOTO], operationId=op)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]
    rows = _posts_of(owner)
    assert len(rows) == 1, rows  # before the fix: two scheduled copies, and the scheduler published both
    assert rows[0][1]["status"] == "scheduled" and "operationId" not in rows[0][1]


def test_create_retried_after_an_edit_saves_the_newer_text_on_the_same_post(actors, graph):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a")
    op = _op_id()
    first = _post(a, page["id"], caption="Evening course", status="draft", scheduledAt="", operationId=op)
    assert first.status_code == 200, first.text
    again = _post(a, page["id"], caption="Evening course (fixed typo)", status="draft", scheduledAt="", operationId=op)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"] and again.json()["caption"] == "Evening course (fixed typo)"
    rows = _posts_of(owner)
    assert [data["caption"] for _, data in rows] == ["Evening course (fixed typo)"]


def test_create_without_operation_id_still_makes_a_new_post_each_time(actors, graph):
    a = actors["a"]["cookies"]
    page = _link(actors, "a")
    one = _post(a, page["id"], status="draft", scheduledAt="")
    two = _post(a, page["id"], status="draft", scheduledAt="")
    assert one.status_code == two.status_code == 200
    assert one.json()["id"] != two.json()["id"] and len(_posts_of(actors["a"]["id"])) == 2


@pytest.mark.parametrize("bad", ["short", "../../etc", "x" * 200, 12345678])
def test_a_malformed_operation_id_is_refused(actors, graph, bad):
    a = actors["a"]["cookies"]
    page = _link(actors, "a")
    response = _post(a, page["id"], status="draft", scheduledAt="", operationId=bad)
    assert response.status_code == 400, response.text  # before the fix: ignored, and a post was made
    assert response.json()["detail"] == "Invalid operationId"
    assert _posts_of(actors["a"]["id"]) == []


def test_the_same_operation_id_of_another_owner_is_another_post(actors, graph):
    page_a = _link(actors, "a")
    page_b = _link(actors, "b")
    op = _op_id()
    mine = _post(actors["a"]["cookies"], page_a["id"], status="draft", scheduledAt="", operationId=op)
    theirs = _post(actors["b"]["cookies"], page_b["id"], status="draft", scheduledAt="", operationId=op)
    assert mine.status_code == theirs.status_code == 200
    assert mine.json()["id"] != theirs.json()["id"]
    assert len(_posts_of(actors["a"]["id"])) == 1 and len(_posts_of(actors["b"]["id"])) == 1
    # B's copy never touched A's post.
    assert _posts_of(actors["a"]["id"])[0][1]["ownerId"] == actors["a"]["id"]


def test_a_post_deleted_since_gives_way_to_a_new_one(actors, graph):
    a = actors["a"]["cookies"]
    page = _link(actors, "a")
    op = _op_id()
    first = _post(a, page["id"], status="draft", scheduledAt="", operationId=op)
    assert first.status_code == 200, first.text
    deleted = client.delete(f"{API}/posts/{first.json()['id']}", cookies=a)
    assert deleted.status_code == 200, deleted.text
    again = _post(a, page["id"], status="draft", scheduledAt="", operationId=op)
    assert again.status_code == 200, again.text
    assert again.json()["id"] != first.json()["id"] and len(_posts_of(actors["a"]["id"])) == 1


def test_two_racing_tries_of_one_create_land_on_one_post(actors, graph, monkeypatch):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a")
    op = _op_id()
    post_id = studio._client_post_id(owner, op)
    real_quota = studio._enforce_post_quota
    raced = []

    def first_try_lands_meanwhile(conn, owner_id, proposed, **kwargs):
        # The first try of this create wrote its row after this (second) try looked for it.
        if kwargs.get("creating") and not raced:
            raced.append(True)
            main_module.upsert_entity(studio.POSTS_TYPE, post_id, {**proposed, "caption": "First try"}, owner_id,
                                      reject_existing=True)
        return real_quota(conn, owner_id, proposed, **kwargs)

    monkeypatch.setattr(studio, "_enforce_post_quota", first_try_lands_meanwhile)
    second = _post(a, page["id"], status="draft", scheduledAt="", caption="Second try", operationId=op)
    assert raced == [True]
    assert second.status_code == 200, second.text  # not the 409 "Record with this ID already exists"
    assert second.json()["id"] == post_id
    rows = _posts_of(owner)
    assert [(pid, data["caption"]) for pid, data in rows] == [(post_id, "Second try")]


# ---------------------------------------------------------------------------
# 38: a text that starts with javascript: / vbscript: is refused, never emptied
# ---------------------------------------------------------------------------


def test_a_caption_starting_with_javascript_is_refused_not_published_empty(actors, graph):
    a = actors["a"]["cookies"]
    page = _link(actors, "a")
    response = _post(a, page["id"], caption="JavaScript: new evening course", media=[PHOTO])
    assert response.status_code == 400, response.text  # before the fix: 200 with caption "" (a photo alone)
    assert response.json()["detail"] == "caption cannot start with javascript: or vbscript: (add a word before it)"
    assert _posts_of(actors["a"]["id"]) == []
    # An edit is held to the same rule, and the word inside a sentence is kept as it is.
    kept = _post(a, page["id"], caption="Learn JavaScript: evening course", media=[PHOTO])
    assert kept.status_code == 200, kept.text
    assert kept.json()["caption"] == "Learn JavaScript: evening course"
    edit = client.patch(f"{API}/posts/{kept.json()['id']}", json={"caption": "  vbscript: basics"}, cookies=a)
    assert edit.status_code == 400, edit.text
    assert [data["caption"] for _, data in _posts_of(actors["a"]["id"])] == ["Learn JavaScript: evening course"]


@pytest.mark.parametrize("field,label", [("publicReply", "publicReply"), ("dmText", "dmText"), ("name", "Rule name")])
def test_a_rule_text_starting_with_vbscript_is_refused_with_its_field(actors, graph, field, label):
    body = {"name": "Thanks", "platform": "fb", "trigger": "every", "publicReply": "Thanks!", "dmEnabled": True, "dmText": "Hello"}
    body[field] = "VBScript: hi"
    response = client.post(f"{API}/rules", json=body, cookies=actors["a"]["cookies"])
    # Before the fix: the text was emptied (a public reply alone: the unrelated "A rule needs a public
    # reply or a private message"; a private message or a name: saved empty without a word).
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == f"{label} cannot start with javascript: or vbscript: (add a word before it)"
