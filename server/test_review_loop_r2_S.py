"""Review loop round 2, batch S: Social Studio server load and storage (social_studio.py).

Behaviour tests for the verified findings of the batch; each one failed before its fix:

* 17/34  a comment's post match reads ONE projection of status, results and rule id (each row parsed
         once, no photos, no lean copy, no thumbnail) instead of five lean scans, with the same answer:
         a published post's rule first, then failed, scheduled, publishing and draft, newest first;
* 18     the scheduler's two 20-second reads name the type and status as literals (so PostgreSQL can
         use the new partial index idx_social_posts_status, which the startup index pass creates);
* 33     a new post photo (and a wallet transfer receipt) is decoded only through main's 2-slot guard:
         503 while both slots are busy; an edit that keeps the stored photos needs no slot;
* 35     a deleted draft / scheduled / failed post keeps its row but not its photos; one owner keeps at
         most MAX_UNPUBLISHED_POSTS_PER_OWNER unpublished posts (409) and MAX_POSTS_OWNER_STORAGE_BYTES
         of stored unpublished posts (413); an edit that adds no photo bytes always passes.

Review of the batch (second commit): the comment's post lookup runs BEFORE the lock every owner shares
and parses only the posts whose text holds the post id; scheduling an unchanged draft is not growth
(only photo bytes are); the classic receipt upload's refusal is in test-mobile-ui.js.

Users are made here with unique emails; every Meta call is faked (nothing reaches the network).
Run: python -m pytest server/test_review_loop_r2_S.py -q
"""

import base64
import io
import os
import secrets
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import event, text

import server.main as main_module
import server.meta_ads as meta_ads
import server.systems.ads_studio.social_studio as studio
from server import add_jsonb_indexes
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/social-studio"
TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR2S!Secure"
SOCIAL_TYPES = ("socialPages", "socialReplyRules", "socialPosts", "socialReplyLog")


def _png_data_url(color=(10, 120, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


PHOTO = _png_data_url()
OTHER_PHOTO = _png_data_url((200, 30, 30))


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
        email = f"review-r2-s-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Review S {key}", email, role)
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
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-review-r2-s")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-review-r2-s")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe(actors)
    yield
    _wipe(actors)


class FakeGraph:
    def __init__(self):
        self.calls = []

    def post(self, path, data, token):
        self.calls.append((path, dict(data or {})))
        return {"id": f"{path.replace('/', '_')}_id"}


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
    return f"74{secrets.randbelow(10 ** 12):012d}"


def _link(actors, owner_key, meta_page_id):
    response = client.post(f"{API}/pages/link", json={"ownerId": actors[owner_key]["id"], "metaPageId": meta_page_id,
                                                      "platform": "fb", "name": "S page"},
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


def _post(cookies, page_id, **overrides):
    body = {"pageIds": [page_id], "caption": "A post"}
    body.update(overrides)
    return client.post(f"{API}/posts", json=body, cookies=cookies)


def _set_post(owner, post_id, **data):
    return studio._ctx()["patch_entity"](studio.POSTS_TYPE, post_id, data, owner)


def _raw_post(post_id):
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, deleted FROM entities WHERE type = 'socialPosts' AND id = :id"),
                           {"id": post_id}).mappings().first()
    return (json_loads(row["data_json"]), bool(row["deleted"])) if row else (None, None)


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


def _comment(meta_page_id, comment_id, post_ref, message="nice"):
    return studio.process_comment(platform="fb", entry_id=meta_page_id, comment_id=comment_id, post_ref=post_ref,
                                  from_id="9191", text=message, source="webhook")


# ---------------------------------------------------------------------------
# 17 / 34: the comment's post match
# ---------------------------------------------------------------------------


def test_comment_post_match_is_one_projection_query_not_five_lean_scans(actors, graph, monkeypatch):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    rule = _rule(a, name="This post", scope="chosen", postIds=["some_other_post"], publicReply="On this post")
    post = _post(a, page["id"], media=[PHOTO], autoReplyRuleId=rule["id"])
    assert post.status_code == 200, post.text
    live_ref = f"{meta_page_id}_81"
    _set_post(owner, post.json()["id"], status="published",
              results=[{"pageId": page["id"], "metaPostId": live_ref, "error": ""}])

    def no_lean_scan(*args, **kwargs):
        raise AssertionError("the comment match must not run the lean list scan (photos parsed per status)")

    monkeypatch.setattr(studio, "_lean_posts", no_lean_scan)
    with _statements() as seen:
        logged = _comment(meta_page_id, f"{meta_page_id}_1", live_ref)
    assert logged is not None and logged["ruleId"] == rule["id"]
    post_reads = [sql for sql, params in seen if "socialPosts" in sql or "socialPosts" in params]
    assert len(post_reads) == 1, post_reads  # it was one lean scan per status: five
    assert "json_extract(data_json, '$.results')" in post_reads[0] and "json_remove" not in post_reads[0]


def test_comment_post_match_sql_parses_each_row_once_on_postgresql():
    sql = studio._comment_post_refs_sql("postgresql")
    assert sql.count("data_json::jsonb") == 1, sql  # _lean_posts cast each matching row about six times
    assert "'media'" not in sql and "thumb" not in sql
    assert "(doc ->> 'status') AS f_status" in sql and "(doc ->> 'results') AS f_results" in sql
    assert sql.endswith("ORDER BY created_at DESC, id DESC")


def test_comment_post_match_keeps_its_preference_order(actors, graph):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    first = _rule(a, name="Published", scope="chosen", postIds=["x1"], publicReply="From the published post")
    second = _rule(a, name="Failed", scope="chosen", postIds=["x2"], publicReply="From the failed post")
    third = _rule(a, name="Newer published", scope="chosen", postIds=["x3"], publicReply="From the newer one")
    live_ref = f"{meta_page_id}_82"
    result = [{"pageId": page["id"], "metaPostId": live_ref, "error": ""}]
    published = _post(a, page["id"], autoReplyRuleId=first["id"]).json()
    time.sleep(0.01)
    failed = _post(a, page["id"], autoReplyRuleId=second["id"]).json()
    _set_post(owner, published["id"], status="published", results=result)
    _set_post(owner, failed["id"], status="failed", results=result)
    # A published post's rule wins over a NEWER failed post's rule.
    logged = _comment(meta_page_id, f"{meta_page_id}_2", live_ref)
    assert logged is not None and logged["ruleId"] == first["id"]
    refs, preferred = studio._comment_post_refs(owner, live_ref)
    assert refs == {live_ref, published["id"], failed["id"]} and preferred == first["id"]
    # Within one status the newest post wins.
    time.sleep(0.01)
    newer = _post(a, page["id"], autoReplyRuleId=third["id"]).json()
    _set_post(owner, newer["id"], status="published", results=result)
    logged = _comment(meta_page_id, f"{meta_page_id}_3", live_ref)
    assert logged is not None and logged["ruleId"] == third["id"]
    # No post id: no post matches.
    assert studio._comment_post_refs(owner, "") == ({""}, "")


def test_comment_post_lookup_runs_before_the_shared_lock(actors, graph, monkeypatch):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    live_ref = f"{meta_page_id}_83"
    real_lookup = studio._comment_post_refs
    lock_held = []

    def recording_lookup(owner_id, post_ref):
        lock_held.append(studio._COMMENT_LOCK.locked())
        return real_lookup(owner_id, post_ref)

    monkeypatch.setattr(studio, "_comment_post_refs", recording_lookup)
    # No enabled rule: nothing can answer, so there is no post lookup at all.
    assert _comment(meta_page_id, f"{meta_page_id}_4", live_ref) is None and lock_held == []
    rule = _rule(a, name="This post", scope="chosen", postIds=["x4"], publicReply="On this post")
    post = _post(a, page["id"], autoReplyRuleId=rule["id"]).json()
    _set_post(owner, post["id"], status="published", results=[{"pageId": page["id"], "metaPostId": live_ref, "error": ""}])
    logged = _comment(meta_page_id, f"{meta_page_id}_5", live_ref)
    assert logged is not None and logged["ruleId"] == rule["id"]
    # The read-only lookup ran once and NOT inside the lock every owner's comments wait on.
    assert lock_held == [False]


def test_comment_post_lookup_parses_only_posts_that_hold_the_post_id(actors):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    meta_page_id = _meta_id()
    page = _link(actors, "a", meta_page_id)
    rule = _rule(a, name="Mine", scope="chosen", postIds=["x5"], publicReply="Mine")
    live_ref = f"{meta_page_id}_84"
    made = [_post(a, page["id"], caption=f"Post {i}", media=[PHOTO], autoReplyRuleId=rule["id"] if i == 0 else "").json()
            for i in range(5)]

    def result(ref):
        return [{"pageId": page["id"], "metaPostId": ref, "error": ""}]

    _set_post(owner, made[0]["id"], status="published", results=result(live_ref))
    _set_post(owner, made[1]["id"], status="published", results=result(f"{meta_page_id}x84"))  # "_" is no wildcard
    _set_post(owner, made[2]["id"], status="published", results=result(live_ref + "9"))  # a longer id
    _set_post(owner, made[3]["id"], status="failed", results=result(f"{meta_page_id}%84"))  # "%" is no wildcard
    # made[4] stays a draft without results.
    parsed = []
    real_json_list = studio._json_list

    def counting_json_list(value):
        parsed.append(value)
        return real_json_list(value)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(studio, "_json_list", counting_json_list)
        refs, preferred = studio._comment_post_refs(owner, live_ref)
    assert refs == {live_ref, made[0]["id"]} and preferred == rule["id"]
    assert len(parsed) == 1, parsed  # every post of the owner was parsed (five rows) before the text pre-filter
    # The pre-filter keeps the answer for an id that needs escaping in a LIKE pattern.
    odd_ref = f"{meta_page_id}_8!5%"
    _set_post(owner, made[4]["id"], status="failed", results=result(odd_ref))
    assert studio._comment_post_refs(owner, odd_ref) == ({odd_ref, made[4]["id"]}, "")


# ---------------------------------------------------------------------------
# 18: the scheduler's 20-second reads
# ---------------------------------------------------------------------------


class _Dialect:
    name = "postgresql"


class _Engine:
    dialect = _Dialect()


def test_startup_index_pass_creates_the_social_posts_status_index(monkeypatch):
    connections = []

    @contextmanager
    def recording_db_conn():
        statements = []
        connections.append(statements)

        class _Conn:
            def execute(self, stmt, params=None):
                statements.append(str(stmt))

        yield _Conn()

    monkeypatch.setattr(add_jsonb_indexes, "get_engine", lambda: _Engine())
    monkeypatch.setattr(add_jsonb_indexes, "db_conn", recording_db_conn)
    add_jsonb_indexes.add_jsonb_indexes()
    found = [s for s in connections if any("idx_social_posts_status" in stmt for stmt in s)]
    assert len(found) == 1 and len(found[0]) == 3, connections  # its own connection: 2 SET LOCAL + the DDL
    assert " ".join(found[0][-1].split()) == (
        "CREATE INDEX IF NOT EXISTS idx_social_posts_status "
        "ON entities (((data_json::jsonb->>'status'))) "
        "WHERE type = 'socialPosts' AND deleted = false"
    )


def test_scheduler_reads_name_type_and_status_as_literals(actors):
    owner = actors["a"]["id"]
    now = datetime.now(timezone.utc)
    stamp = now_ms()
    rows = []
    for key, status, extra in (
        ("due", "scheduled", {"scheduledAt": studio._iso_at(now - timedelta(minutes=1))}),
        ("later", "scheduled", {"scheduledAt": studio._iso_at(now + timedelta(days=1))}),
        ("draft", "draft", {"scheduledAt": studio._iso_at(now - timedelta(minutes=1))}),
        ("stuck", "publishing", {"publishingSince": studio._iso_at(now - timedelta(hours=1))}),
    ):
        post_id = f"spost_r2s_{key}_{TAG}"
        data = {"id": post_id, "ownerId": owner, "status": status, "caption": key, "media": [PHOTO], **extra}
        rows.append({"id": post_id, "data": json_dumps(data), "stamp": stamp, "owner": owner})
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialPosts',:id,:data,false,:stamp,:owner,:stamp)"), rows)
    with _statements() as seen:
        due = studio._due_scheduled_posts(now, 20)
        recovered = studio._recover_stuck_publishing(now)
    assert [entity["id"] for entity in due if entity["id"].endswith(TAG)] == [f"spost_r2s_due_{TAG}"]
    assert recovered >= 1 and _raw_post(f"spost_r2s_stuck_{TAG}")[0]["status"] == "failed"
    scans = [sql for sql, _params in seen if "FROM entities WHERE type=" in sql and "status" in sql and sql.lstrip().startswith("SELECT")]
    assert len(scans) >= 2, seen
    for sql in scans:
        assert "type='socialPosts'" in sql, sql  # a bound type cannot prove the partial index under a generic plan
    assert any("'$.status')='scheduled'" in sql for sql in scans) and any("'$.status')='publishing'" in sql for sql in scans)


# ---------------------------------------------------------------------------
# 33: every full photo decode goes through main's 2-slot guard
# ---------------------------------------------------------------------------


@pytest.fixture
def busy_slots(monkeypatch):
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(main_module, "_AD_CAMPAIGN_MEDIA_VALIDATION_SLOTS", slots)
    assert slots.acquire(blocking=False)
    yield slots
    slots.release()


def test_new_post_photo_waits_for_a_free_decode_slot(actors, busy_slots):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    busy_slots.release()
    stored = _post(a, page["id"], media=[PHOTO])
    assert stored.status_code == 200, stored.text
    assert busy_slots.acquire(blocking=False)  # both "slots" busy again
    refused = _post(a, page["id"], media=[PHOTO])
    assert refused.status_code == 503 and refused.headers.get("Retry-After") == "2", refused.text
    assert refused.json()["detail"] == "Campaign images are being checked. Please try again in a moment."
    post_id = stored.json()["id"]
    # An edit that keeps the stored photo decodes nothing: no slot needed.
    kept = client.patch(f"{API}/posts/{post_id}", json={"caption": "New words", "media": [PHOTO]}, cookies=a)
    assert kept.status_code == 200 and kept.json()["caption"] == "New words", kept.text
    added = client.patch(f"{API}/posts/{post_id}", json={"media": [PHOTO, OTHER_PHOTO]}, cookies=a)
    assert added.status_code == 503, added.text
    # A post without photos never needs a slot.
    assert _post(a, page["id"], caption="Words only").status_code == 200


def test_wallet_receipt_photo_waits_for_a_free_decode_slot(actors, busy_slots):
    cookies = actors["b"]["cookies"]
    body = {"photo": PHOTO}
    refused = client.post(f"/api/wallet/payment-requests/payreq_missing_{TAG}/receipt", json=body, cookies=cookies)
    assert refused.status_code == 503, refused.text  # it decoded first and only then answered 404
    busy_slots.release()
    try:
        answered = client.post(f"/api/wallet/payment-requests/payreq_missing_{TAG}/receipt", json=body, cookies=cookies)
        assert answered.status_code == 404, answered.text
    finally:
        assert busy_slots.acquire(blocking=False)


# ---------------------------------------------------------------------------
# 35: quota and tombstones
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["draft", "scheduled", "failed"])
def test_deleting_a_post_keeps_its_row_but_not_its_photos(actors, status):
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a", _meta_id())
    post = _post(a, page["id"], caption="Keep my words", media=[PHOTO, OTHER_PHOTO])
    assert post.status_code == 200, post.text
    post_id = post.json()["id"]
    if status != "draft":
        _set_post(owner, post_id, status=status, results=[{"pageId": page["id"], "metaPostId": "", "error": "x"}])
    deleted = client.delete(f"{API}/posts/{post_id}", cookies=a)
    assert deleted.status_code == 200 and deleted.json()["ok"] is True, deleted.text
    data, is_deleted = _raw_post(post_id)
    assert is_deleted is True and data["media"] == [] and "data:image/" not in json_dumps(data)
    assert data["caption"] == "Keep my words" and data["status"] == status and data["pageIds"] == [page["id"]]
    assert client.get(f"{API}/posts/{post_id}", cookies=a).status_code == 404


def test_a_stale_delete_changes_nothing(actors):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    post = _post(a, page["id"], media=[PHOTO]).json()
    with pytest.raises(Exception) as refused:
        studio._delete_post_dropping_media(post["id"], int(post["lastModified"]) - 1)
    assert getattr(refused.value, "status_code", None) == 409
    data, is_deleted = _raw_post(post["id"])
    assert is_deleted is False and data["media"] == [PHOTO]
    # A published post stays undeletable (as before).
    _set_post(actors["a"]["id"], post["id"], status="published")
    assert client.delete(f"{API}/posts/{post['id']}", cookies=a).status_code == 409
    assert _raw_post(post["id"])[0]["media"] == [PHOTO]


def test_unpublished_post_count_cap(actors, monkeypatch):
    assert studio.MAX_UNPUBLISHED_POSTS_PER_OWNER == 100
    monkeypatch.setattr(studio, "MAX_UNPUBLISHED_POSTS_PER_OWNER", 3)
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a", _meta_id())
    made = [_post(a, page["id"], caption=f"Draft {i}") for i in range(3)]
    assert [r.status_code for r in made] == [200, 200, 200]
    refused = _post(a, page["id"], caption="One too many")
    assert refused.status_code == 409
    assert refused.json()["detail"] == ("Social Studio keeps at most 3 unpublished posts (drafts, scheduled and failed "
                                        "posts) per account. Delete an old draft or a failed post first.")
    # Another owner is not affected; an edit of an existing post is not a new post.
    page_b = _link(actors, "b", _meta_id())
    assert _post(actors["b"]["cookies"], page_b["id"]).status_code == 200
    assert client.patch(f"{API}/posts/{made[0].json()['id']}", json={"caption": "Edited"}, cookies=a).status_code == 200
    # A published post does not count; neither does a deleted one.
    _set_post(owner, made[0].json()["id"], status="published")
    assert _post(a, page["id"], caption="Room again").status_code == 200
    assert _post(a, page["id"], caption="Full again").status_code == 409
    assert client.delete(f"{API}/posts/{made[1].json()['id']}", cookies=a).status_code == 200
    assert _post(a, page["id"], caption="After a delete").status_code == 200


def test_unpublished_post_storage_cap(actors, monkeypatch):
    assert studio.MAX_POSTS_OWNER_STORAGE_BYTES == 48 * 1024 * 1024
    monkeypatch.setattr(studio, "MAX_POSTS_OWNER_STORAGE_BYTES", 6000)
    a = actors["a"]["cookies"]
    owner = actors["a"]["id"]
    page = _link(actors, "a", _meta_id())
    long_words = "w" * 2000
    first = _post(a, page["id"], caption=long_words)
    second = _post(a, page["id"], caption=long_words)
    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    refused = _post(a, page["id"], caption=long_words)
    assert refused.status_code == 413
    assert refused.json()["detail"] == ("Social Studio storage for unpublished posts is full. Delete old drafts or "
                                        "failed posts, or use fewer or smaller photos.")
    # Over the bytes (the cap was lowered below what is stored): an edit that adds photo bytes is refused,
    # an edit that shrinks its post or keeps its photos still works, so the owner can always trim.
    monkeypatch.setattr(studio, "MAX_POSTS_OWNER_STORAGE_BYTES", 2000)
    post_id = first.json()["id"]
    grow = client.patch(f"{API}/posts/{post_id}", json={"media": [PHOTO]}, cookies=a)
    assert grow.status_code == 413, grow.text
    shrink = client.patch(f"{API}/posts/{post_id}", json={"caption": "short"}, cookies=a)
    assert shrink.status_code == 200 and shrink.json()["caption"] == "short", shrink.text
    same = client.patch(f"{API}/posts/{second.json()['id']}", json={"caption": long_words}, cookies=a)
    assert same.status_code == 200, same.text
    assert _post(a, page["id"], caption="m" * 1000).status_code == 413
    # Published posts do not count (they cannot be deleted; their photos are on Meta).
    _set_post(owner, second.json()["id"], status="published")
    assert _post(a, page["id"], caption="m" * 1000).status_code == 200


def test_a_full_store_still_lets_a_draft_be_scheduled_or_reworded(actors, monkeypatch):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    draft = _post(a, page["id"], caption="w" * 2000, media=[PHOTO])
    other = _post(a, page["id"], caption="w" * 2000)
    assert draft.status_code == 200 and other.status_code == 200, (draft.text, other.text)
    draft_id = draft.json()["id"]
    # The store is full (the cap is below what the owner keeps, as for an owner already over it).
    monkeypatch.setattr(studio, "MAX_POSTS_OWNER_STORAGE_BYTES", 2000)
    when = studio._iso_at(datetime.now(timezone.utc) + timedelta(days=1))
    # Scheduling the unchanged draft adds only "scheduled" and a date: not growth (it was a 413 while
    # "publish now" of the same draft was allowed).
    scheduled = client.patch(f"{API}/posts/{draft_id}", json={"status": "scheduled", "scheduledAt": when}, cookies=a)
    assert scheduled.status_code == 200 and scheduled.json()["status"] == "scheduled", scheduled.text
    # The composer resends the same caption and photo with the status: still fine; so is a longer caption.
    back = client.patch(f"{API}/posts/{draft_id}", json={"caption": "w" * 2000, "media": [PHOTO], "status": "draft"}, cookies=a)
    assert back.status_code == 200 and back.json()["status"] == "draft", back.text
    longer = client.patch(f"{API}/posts/{draft_id}", json={"caption": "w" * 2100}, cookies=a)
    assert longer.status_code == 200, longer.text
    # A photo that adds bytes is growth: refused while the store is full; a smaller set of photos is not.
    more = client.patch(f"{API}/posts/{draft_id}", json={"media": [PHOTO, OTHER_PHOTO]}, cookies=a)
    assert more.status_code == 413, more.text
    fewer = client.patch(f"{API}/posts/{draft_id}", json={"media": []}, cookies=a)
    assert fewer.status_code == 200 and fewer.json()["media"] == [], fewer.text


def test_two_posts_at_once_never_pass_the_count_cap_together(actors, monkeypatch):
    monkeypatch.setattr(studio, "MAX_UNPUBLISHED_POSTS_PER_OWNER", 2)
    a = actors["a"]["cookies"]
    page = _link(actors, "a", _meta_id())
    assert _post(a, page["id"], caption="Existing").status_code == 200
    real_enforce = studio._enforce_post_quota
    barrier = threading.Barrier(2, timeout=1)

    def enforce_then_wait(*args, **kwargs):
        real_enforce(*args, **kwargs)
        # Without the guard both requests counted one post before either wrote; with it the second
        # one counts only after the first has written, so the barrier just times out.
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            pass

    monkeypatch.setattr(studio, "_enforce_post_quota", enforce_then_wait)
    statuses = []

    def create():
        own_client = TestClient(app, headers={"Origin": "http://testserver"})
        statuses.append(own_client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "Race"}, cookies=a).status_code)

    threads = [threading.Thread(target=create) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(statuses) == [200, 409], statuses
