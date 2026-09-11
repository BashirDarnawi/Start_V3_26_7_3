"""Albayan Social Studio: auto-reply rules, scheduled posts, signed media.

Every Meta call is faked (MetaAdsClient._post / page_access_token are
monkeypatched, or httpx gets a MockTransport); nothing here touches the
network. Run with: PYTHONPATH=. python -m pytest server/test_social_studio.py -q
"""

import base64
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
import server.meta_ads as meta_ads
import server.social_studio as studio


client = TestClient(app, headers={"Origin": "http://testserver"})
PASSWORD = "SocialStudio123!Secure"
APP_SECRET = "app-secret-must-never-leak"
SYSTEM_TOKEN = "system-token-must-never-leak"
VALID_PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
)
API = "/api/social-studio"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
    for key, role, subscribed in (
        ("admin", "Admin", False), ("a", "Employee", True), ("b", "Employee", True), ("c", "Employee", False),
    ):
        email = f"social-studio-{key}@tests.albayanhub.com"
        uid = _insert_user(f"Social {key}", email, role)
        if subscribed:
            _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    return out


def _wipe_social_rows():
    with db_conn() as conn:
        conn.execute(
            text(
                "DELETE FROM entities WHERE type IN "
                "('socialPages','socialReplyRules','socialPosts','socialReplyLog')"
            )
        )


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, actors):
    for who in actors.values():
        reset_rate_limit(f"social-studio:mutations:{who['id']}")
        reset_rate_limit(f"social-studio:available:{who['id']}")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.delenv("ALBAYAN_META_WEBHOOK_VERIFY_TOKEN", raising=False)
    monkeypatch.setenv("ALBAYAN_PUBLIC_BASE_URL", "https://studio.example.test/")
    # The ad-account discovery wake-up would otherwise try to reach Meta.
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe_social_rows()
    yield


class FakeGraph:
    """Records every Graph POST; a path suffix can be told to fail."""

    def __init__(self):
        self.calls = []
        self.fail = {}

    def post(self, path, data, token):
        self.calls.append((path, dict(data or {}), token))
        for suffix, error in self.fail.items():
            if path.endswith(suffix):
                raise error
        return {"id": f"{path.replace('/', '_')}_id"}

    def paths(self):
        return [(path, data) for path, data, _token in self.calls]


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()

    def forbidden_get(self, path, params=None):
        raise AssertionError(f"unexpected Graph GET {path}")

    monkeypatch.setattr(
        meta_ads.MetaAdsClient, "_post",
        lambda self, path, data=None, *, access_token=None: fake.post(path, data, access_token),
    )
    monkeypatch.setattr(meta_ads.MetaAdsClient, "page_access_token", lambda self, page_id: f"PAGE-TOKEN-{page_id}")
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_get", forbidden_get)
    return fake


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _link(actors, owner_key, meta_page_id, platform="fb", ig_user_id="", name=""):
    response = client.post(
        f"{API}/pages/link",
        json={
            "ownerId": actors[owner_key]["id"], "metaPageId": meta_page_id,
            "platform": platform, "igUserId": ig_user_id, "name": name,
        },
        cookies=actors["admin"]["cookies"],
    )
    assert response.status_code == 200, response.text
    return response.json()


def _rule(cookies, **overrides):
    body = {"name": "Thanks", "platform": "fb", "trigger": "every", "publicReply": "Thanks!"}
    body.update(overrides)
    response = client.post(f"{API}/rules", json=body, cookies=cookies)
    assert response.status_code == 200, response.text
    return response.json()


def _post(cookies, page_ids, **overrides):
    body = {"pageIds": page_ids, "caption": "Hello Tripoli"}
    body.update(overrides)
    return client.post(f"{API}/posts", json=body, cookies=cookies)


def _webhook(payload):
    raw = json.dumps(payload).encode("utf-8")
    signature = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    response = client.post(
        "/api/meta-ads/webhook",
        content=raw,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"received": True}


def _fb_comment(page_id, comment_id, from_id, message, post_id="post_1"):
    return {
        "object": "page",
        "entry": [{
            "id": page_id,
            "changes": [{
                "field": "feed",
                "value": {
                    "item": "comment", "verb": "add", "comment_id": comment_id,
                    "post_id": post_id, "from": {"id": from_id, "name": "Someone"}, "message": message,
                },
            }],
        }],
    }


def _log_rows(owner_id):
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT data_json FROM entities WHERE type='socialReplyLog' AND deleted=false AND created_by=:o"),
            {"o": owner_id},
        ).mappings().all()
    return [json_loads(r["data_json"]) for r in rows]


def _future(minutes=10):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Settings + rules
# ---------------------------------------------------------------------------


def test_settings_default_update_and_validation(actors):
    cookies = actors["a"]["cookies"]
    first = client.get(f"{API}/settings", cookies=cookies)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["id"] == f"sst_{actors['a']['id']}"
    assert body["masterEnabled"] is True
    assert body["quietHours"] == {"from": "22:00", "to": "08:00"}
    assert body["timezone"] == "Africa/Tripoli"
    assert body["ownerId"] == actors["a"]["id"]

    updated = client.put(
        f"{API}/settings",
        json={"masterEnabled": False, "quietHours": {"from": "23:30", "to": "07:15"}},
        cookies=cookies,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["masterEnabled"] is False
    assert updated.json()["quietHours"] == {"from": "23:30", "to": "07:15"}
    again = client.get(f"{API}/settings", cookies=cookies).json()
    assert again["masterEnabled"] is False and again["quietHours"]["from"] == "23:30"

    bad = client.put(f"{API}/settings", json={"quietHours": {"from": "25:00", "to": "08:00"}}, cookies=cookies)
    assert bad.status_code == 400
    assert "HH:MM" in bad.json()["detail"]
    bad_shape = client.put(f"{API}/settings", json={"quietHours": "night"}, cookies=cookies)
    assert bad_shape.status_code == 400
    # Customer B has their own, untouched settings.
    assert client.get(f"{API}/settings", cookies=actors["b"]["cookies"]).json()["masterEnabled"] is True
    client.put(f"{API}/settings", json={"masterEnabled": True}, cookies=cookies)


def test_rule_create_normalizes_keywords_and_lists_in_creation_order(actors):
    cookies = actors["a"]["cookies"]
    rule = _rule(
        cookies, name="Price", trigger="keywords", keywords=["  السِّعر ", "PRICE", "price"],
        publicReply="Sent you a DM", dmEnabled=True, dmText="50 LYD", likeComment=True,
    )
    assert rule["id"].startswith("srule_")
    assert rule["keywords"] == ["السعر", "price"]
    assert rule["enabled"] is True and rule["scope"] == "all" and rule["likeComment"] is True
    assert rule["ownerId"] == actors["a"]["id"]
    assert "createdBy" not in rule and "_created" not in rule
    second = _rule(cookies, name="Second")
    listed = client.get(f"{API}/rules", cookies=cookies).json()["rules"]
    assert [r["id"] for r in listed] == [rule["id"], second["id"]]


@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"name": "   "}, "name is required"),
        ({"trigger": "keywords", "keywords": []}, "keyword"),
        ({"publicReply": "", "dmEnabled": True, "dmText": ""}, "public reply or a private message"),
        ({"scope": "chosen", "postIds": []}, "Choose at least one post"),
        ({"platform": "tiktok"}, "platform must be fb or ig"),
        ({"name": "x" * 81}, "80 characters"),
        ({"keywords": ["k"] * 31 + ["z"], "trigger": "keywords"}, "at most 30"),
    ],
)
def test_rule_validation_failures(actors, overrides, fragment):
    body = {"name": "Rule", "platform": "fb", "trigger": "every", "publicReply": "Thanks!"}
    body.update(overrides)
    if "keywords" in overrides and len(overrides["keywords"]) > 30:
        body["keywords"] = [f"k{i}" for i in range(31)]
    response = client.post(f"{API}/rules", json=body, cookies=actors["a"]["cookies"])
    assert response.status_code == 400, response.text
    assert fragment in response.json()["detail"]


def test_rule_owner_scoping_and_admin_visibility(actors):
    a_rule = _rule(actors["a"]["cookies"], name="A rule")
    b_rule = _rule(actors["b"]["cookies"], name="B rule")
    # B cannot see or touch A's rule (404 hides existence).
    assert [r["id"] for r in client.get(f"{API}/rules", cookies=actors["b"]["cookies"]).json()["rules"]] == [b_rule["id"]]
    assert client.patch(f"{API}/rules/{a_rule['id']}", json={"name": "Hijack"}, cookies=actors["b"]["cookies"]).status_code == 404
    assert client.delete(f"{API}/rules/{a_rule['id']}", cookies=actors["b"]["cookies"]).status_code == 404
    # B cannot act on behalf of A through ?ownerId=.
    denied = client.get(f"{API}/rules", params={"ownerId": actors["a"]["id"]}, cookies=actors["b"]["cookies"])
    assert denied.status_code == 403
    # Admin sees both, or only A's when scoped.
    all_ids = {r["id"] for r in client.get(f"{API}/rules", cookies=actors["admin"]["cookies"]).json()["rules"]}
    assert {a_rule["id"], b_rule["id"]} <= all_ids
    scoped = client.get(f"{API}/rules", params={"ownerId": actors["a"]["id"]}, cookies=actors["admin"]["cookies"]).json()["rules"]
    assert [r["id"] for r in scoped] == [a_rule["id"]]
    # Admin edits on behalf of A; the row stays A's.
    edited = client.patch(f"{API}/rules/{a_rule['id']}", json={"enabled": False}, cookies=actors["admin"]["cookies"])
    assert edited.status_code == 200, edited.text
    assert edited.json()["enabled"] is False and edited.json()["ownerId"] == actors["a"]["id"]
    # A deletes their rule; it disappears from the list.
    assert client.delete(f"{API}/rules/{a_rule['id']}", cookies=actors["a"]["cookies"]).status_code == 200
    assert client.get(f"{API}/rules", cookies=actors["a"]["cookies"]).json()["rules"] == []


def test_unsubscribed_customer_is_forbidden_everywhere(actors):
    cookies = actors["c"]["cookies"]
    assert client.get(f"{API}/rules", cookies=cookies).status_code == 403
    assert client.get(f"{API}/settings", cookies=cookies).status_code == 403
    assert client.get(f"{API}/posts", cookies=cookies).status_code == 403
    assert client.post(f"{API}/rules", json={"name": "x", "publicReply": "y"}, cookies=cookies).status_code == 403
    assert client.get(f"{API}/stats", cookies=cookies).status_code == 403


def test_generic_collection_api_refuses_social_studio_types(actors):
    for collection in ("socialReplyRules", "socialPosts", "socialPages", "socialStudioSettings", "socialReplyLog"):
        created = client.post(
            f"/api/collections/{collection}",
            json={"data": {"ownerId": actors["a"]["id"], "name": "shadow"}},
            cookies=actors["a"]["cookies"],
        )
        assert created.status_code == 404, (collection, created.text)
        assert client.get(f"/api/collections/{collection}", cookies=actors["admin"]["cookies"]).status_code == 404


# ---------------------------------------------------------------------------
# evaluate_rules (pure)
# ---------------------------------------------------------------------------

NOON = datetime(2026, 9, 11, 12, 0)
MIDNIGHT_PLUS = datetime(2026, 9, 11, 0, 30)


def _ev(rules, settings=None, **kwargs):
    params = {
        "platform": "fb", "post_ref": "post_1", "text": "hello", "from_id": "u1",
        "already_replied_from_ids": set(), "now_local": NOON,
    }
    params.update(kwargs)
    return studio.evaluate_rules(rules, settings if settings is not None else {"masterEnabled": True}, **params)


def _r(**overrides):
    rule = {"id": "r1", "enabled": True, "platform": "fb", "scope": "all", "postIds": [], "trigger": "every", "keywords": []}
    rule.update(overrides)
    return rule


def test_evaluate_master_switch_off_and_disabled_rules():
    assert _ev([_r()], {"masterEnabled": False}) is None
    assert _ev([_r(enabled=False)]) is None
    assert _ev([_r()])["id"] == "r1"


def test_evaluate_keyword_match_with_arabic_normalization():
    rule = _r(trigger="keywords", keywords=["السعر"])
    assert _ev([rule], text="السِّعر") is rule
    assert _ev([rule], text="إيش السعر؟") is rule
    assert _ev([rule], text="كم السِّعْر لو سمحت") is rule
    assert _ev([rule], text="متى التوصيل") is None
    latin = _r(trigger="keywords", keywords=["price"])
    assert _ev([latin], text="What's the PRICE?") is latin
    assert studio.normalize_text("أإآ ة ى") == "ااا ه ي"


def test_evaluate_every_comment_respects_platform():
    rule = _r(platform="ig")
    assert _ev([rule], platform="fb") is None
    assert _ev([rule], platform="ig", text="anything at all") is rule


def test_evaluate_chosen_scope_accepts_meta_or_studio_post_ids():
    rule = _r(scope="chosen", postIds=["spost_abc"])
    assert _ev([rule], post_ref="post_9") is None
    assert _ev([rule], post_ref={"post_9", "spost_abc"}) is rule
    assert _ev([_r(scope="chosen", postIds=["post_9"])], post_ref="post_9") is not None


def test_evaluate_once_per_person():
    rule = _r(oncePerPerson=True)
    assert _ev([rule], from_id="u1", already_replied_from_ids={"u1"}) is None
    assert _ev([rule], from_id="u2", already_replied_from_ids={"u1"}) is rule
    assert _ev([_r()], from_id="u1", already_replied_from_ids={"u1"}) is not None


def test_evaluate_quiet_hours_wrapping_midnight():
    settings = {"masterEnabled": True, "quietHours": {"from": "22:00", "to": "08:00"}}
    quiet_rule = _r(quietHours=True)
    assert _ev([quiet_rule], settings, now_local=MIDNIGHT_PLUS) is None
    assert _ev([quiet_rule], settings, now_local=datetime(2026, 9, 11, 22, 0)) is None
    assert _ev([quiet_rule], settings, now_local=datetime(2026, 9, 11, 7, 59)) is None
    assert _ev([quiet_rule], settings, now_local=datetime(2026, 9, 11, 8, 0)) is quiet_rule
    assert _ev([quiet_rule], settings, now_local=NOON) is quiet_rule
    # A rule that ignores quiet hours still fires at night.
    assert _ev([_r(quietHours=False)], settings, now_local=MIDNIGHT_PLUS) is not None
    # Same-day window.
    day = {"masterEnabled": True, "quietHours": {"from": "13:00", "to": "15:00"}}
    assert _ev([quiet_rule], day, now_local=datetime(2026, 9, 11, 14, 0)) is None
    assert _ev([quiet_rule], day, now_local=NOON) is quiet_rule


def test_evaluate_first_match_wins_in_given_order():
    first = _r(id="first", trigger="keywords", keywords=["delivery"])
    second = _r(id="second")
    assert _ev([first, second], text="delivery?")["id"] == "first"
    assert _ev([first, second], text="price?")["id"] == "second"
    assert _ev([second, first], text="delivery?")["id"] == "second"


# ---------------------------------------------------------------------------
# Webhook -> process_comment
# ---------------------------------------------------------------------------


def test_webhook_fb_comment_gets_dm_public_reply_and_like(actors, graph):
    page = _link(actors, "a", "5100000000001")
    rule = _rule(
        actors["a"]["cookies"], name="Price", trigger="keywords", keywords=["السعر"],
        publicReply="Check your inbox", dmEnabled=True, dmText="Price is 50 LYD", likeComment=True,
    )
    _webhook(_fb_comment("5100000000001", "5100000000001_777", "9001", "إيش السِّعر؟"))
    assert graph.paths() == [
        ("5100000000001_777/private_replies", {"message": "Price is 50 LYD"}),
        ("5100000000001_777/comments", {"message": "Check your inbox"}),
        ("5100000000001_777/likes", {}),
    ]
    assert {token for _p, _d, token in graph.calls} == {"PAGE-TOKEN-5100000000001"}
    logs = _log_rows(actors["a"]["id"])
    assert len(logs) == 1
    assert logs[0]["actions"] == ["dm", "public", "like"]
    assert logs[0]["ruleId"] == rule["id"] and logs[0]["pageId"] == page["id"]
    assert logs[0]["commentId"] == "5100000000001_777" and logs[0]["fromId"] == "9001"
    assert logs[0]["error"] == ""
    # A non-matching comment is ignored (no rule fired, no log row).
    _webhook(_fb_comment("5100000000001", "5100000000001_778", "9002", "متى التوصيل؟"))
    assert len(graph.calls) == 3
    assert len(_log_rows(actors["a"]["id"])) == 1


def test_webhook_skip_public_after_dm(actors, graph):
    _link(actors, "a", "5100000000002")
    _rule(
        actors["a"]["cookies"], name="DM first", publicReply="Public fallback",
        dmEnabled=True, dmText="Private answer", skipPublicAfterDm=True,
    )
    _webhook(_fb_comment("5100000000002", "5100000000002_1", "9003", "hello"))
    assert graph.paths() == [("5100000000002_1/private_replies", {"message": "Private answer"})]
    assert _log_rows(actors["a"]["id"])[0]["actions"] == ["dm"]


def test_webhook_pause_dms_keeps_public_reply(actors, graph):
    _link(actors, "a", "5100000000003")
    _rule(
        actors["a"]["cookies"], name="Paused", publicReply="Public only",
        dmEnabled=True, dmText="Never sent", pauseDms=True, skipPublicAfterDm=True,
    )
    _webhook(_fb_comment("5100000000003", "5100000000003_1", "9004", "hi"))
    assert graph.paths() == [("5100000000003_1/comments", {"message": "Public only"})]
    assert _log_rows(actors["a"]["id"])[0]["actions"] == ["public"]


def test_webhook_instagram_variant(actors, graph):
    _link(actors, "a", "5100000000004", platform="ig", ig_user_id="17800000000004")
    _rule(
        actors["a"]["cookies"], name="IG", platform="ig", publicReply="Replied on IG",
        dmEnabled=True, dmText="IG private", likeComment=True,  # likes are FB-only
    )
    _webhook({
        "object": "instagram",
        "entry": [{
            "id": "17800000000004",
            "changes": [{
                "field": "comments",
                "value": {
                    "id": "17900000000001", "media": {"id": "17950000000001"},
                    "from": {"id": "9005", "username": "buyer"}, "text": "price?",
                },
            }],
        }],
    })
    assert graph.paths() == [
        ("17800000000004/messages", {
            "recipient": json.dumps({"comment_id": "17900000000001"}, separators=(",", ":")),
            "message": json.dumps({"text": "IG private"}, separators=(",", ":")),
        }),
        ("17900000000001/replies", {"message": "Replied on IG"}),
    ]
    assert {token for _p, _d, token in graph.calls} == {"PAGE-TOKEN-5100000000004"}
    log = _log_rows(actors["a"]["id"])[0]
    assert log["platform"] == "ig" and log["actions"] == ["dm", "public"] and log["postId"] == "17950000000001"


def test_webhook_ignores_comments_by_the_page_itself(actors, graph):
    _link(actors, "a", "5100000000005")
    _link(actors, "a", "5100000000006", platform="ig", ig_user_id="17800000000006")
    _rule(actors["a"]["cookies"], name="All", publicReply="Thanks")
    _rule(actors["a"]["cookies"], name="All IG", platform="ig", publicReply="Thanks")
    _webhook(_fb_comment("5100000000005", "5100000000005_1", "5100000000005", "our own reply"))
    _webhook({
        "object": "instagram",
        "entry": [{"id": "17800000000006", "changes": [{"field": "comments", "value": {
            "id": "17900000000006", "media": {"id": "m"}, "from": {"id": "17800000000006"}, "text": "self",
        }}]}],
    })
    # Unknown page / non-comment events are ignored too.
    _webhook(_fb_comment("5100009999999", "x_1", "9006", "hello"))
    _webhook({"object": "page", "entry": [{"id": "5100000000005", "changes": [{"field": "feed", "value": {
        "item": "comment", "verb": "remove", "comment_id": "5100000000005_2", "from": {"id": "9007"}, "message": "bye",
    }}]}]})
    assert graph.calls == []
    assert _log_rows(actors["a"]["id"]) == []


def test_webhook_duplicate_delivery_is_handled_once(actors, graph):
    _link(actors, "a", "5100000000007")
    _rule(actors["a"]["cookies"], name="All", publicReply="Thanks", dmEnabled=True, dmText="DM")
    payload = _fb_comment("5100000000007", "5100000000007_1", "9008", "hello")
    _webhook(payload)
    _webhook(payload)
    assert studio.handle_meta_webhook(payload) == 0
    assert len(graph.calls) == 2
    assert len(_log_rows(actors["a"]["id"])) == 1


def test_process_comment_records_meta_errors_without_raising(actors, graph):
    _link(actors, "a", "5100000000008")
    _rule(actors["a"]["cookies"], name="All", publicReply="Thanks", dmEnabled=True, dmText="DM")
    graph.fail["/private_replies"] = meta_ads.MetaAdsError("request_failed", "Meta refused the message.")
    _webhook(_fb_comment("5100000000008", "5100000000008_1", "9009", "hello"))
    log = _log_rows(actors["a"]["id"])[0]
    assert log["actions"] == ["public"]
    assert "Meta refused the message." in log["error"]
    assert "PAGE-TOKEN" not in json_dumps(log)


# ---------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------


def test_post_create_draft_and_schedule_requires_future(actors):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000011")
    draft = _post(cookies, [page["id"]])
    assert draft.status_code == 200, draft.text
    body = draft.json()
    assert body["status"] == "draft" and body["ownerId"] == actors["a"]["id"]
    assert body["results"] == [] and body["scheduledAt"] == "" and body["media"] == []

    past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    assert _post(cookies, [page["id"]], status="scheduled", scheduledAt=past).status_code == 400
    soon = (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
    assert _post(cookies, [page["id"]], status="scheduled", scheduledAt=soon).status_code == 400
    assert _post(cookies, [page["id"]], status="scheduled").status_code == 400
    scheduled = _post(cookies, [page["id"]], status="scheduled", scheduledAt=_future())
    assert scheduled.status_code == 200, scheduled.text
    assert scheduled.json()["status"] == "scheduled"

    other_page = _link(actors, "b", "5100000000012")
    assert _post(cookies, [other_page["id"]]).status_code == 400
    assert _post(cookies, []).status_code == 400
    assert _post(cookies, [page["id"]], caption="").status_code == 400
    assert _post(cookies, [page["id"]], caption="x" * 2201).status_code == 400
    assert _post(cookies, [page["id"]], media=[VALID_PNG_DATA_URL] * 5).status_code == 400
    assert _post(cookies, [page["id"]], media=["data:image/png;base64,AAAA"]).status_code == 400
    assert _post(cookies, [page["id"]], media=["https://example.com/x.png"]).status_code == 400
    assert _post(cookies, [page["id"]], autoReplyRuleId="srule_missing").status_code == 400
    with_media = _post(cookies, [page["id"]], caption="", media=[VALID_PNG_DATA_URL])
    assert with_media.status_code == 200, with_media.text

    listed = client.get(f"{API}/posts", cookies=cookies).json()["posts"]
    assert [p["id"] for p in listed][:1] == [with_media.json()["id"]]  # newest first
    lean = listed[0]
    assert "media" not in lean and lean["mediaCount"] == 1 and lean["thumbnail"] == VALID_PNG_DATA_URL
    full = client.get(f"{API}/posts/{with_media.json()['id']}", cookies=cookies).json()
    assert full["media"] == [VALID_PNG_DATA_URL]
    only_scheduled = client.get(f"{API}/posts", params={"status": "scheduled"}, cookies=cookies).json()["posts"]
    assert [p["id"] for p in only_scheduled] == [scheduled.json()["id"]]


def test_post_edit_delete_rules_by_status_and_cancel(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000013")
    scheduled = _post(cookies, [page["id"]], status="scheduled", scheduledAt=_future()).json()
    draft_again = client.post(f"{API}/posts/{scheduled['id']}/cancel", cookies=cookies)
    assert draft_again.status_code == 200, draft_again.text
    assert draft_again.json()["status"] == "draft"
    assert client.post(f"{API}/posts/{scheduled['id']}/cancel", cookies=cookies).status_code == 409

    edited = client.patch(f"{API}/posts/{scheduled['id']}", json={"caption": "Edited"}, cookies=cookies)
    assert edited.status_code == 200, edited.text
    assert edited.json()["caption"] == "Edited" and edited.json()["status"] == "draft"
    rescheduled = client.patch(
        f"{API}/posts/{scheduled['id']}", json={"status": "scheduled", "scheduledAt": _future(30)}, cookies=cookies
    )
    assert rescheduled.status_code == 200 and rescheduled.json()["status"] == "scheduled"
    assert client.patch(f"{API}/posts/{scheduled['id']}", json={"status": "published"}, cookies=cookies).status_code == 400

    published = client.post(f"{API}/posts/{scheduled['id']}/publish", cookies=cookies)
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"
    assert client.patch(f"{API}/posts/{scheduled['id']}", json={"caption": "Too late"}, cookies=cookies).status_code == 409
    assert client.delete(f"{API}/posts/{scheduled['id']}", cookies=cookies).status_code == 409
    assert client.post(f"{API}/posts/{scheduled['id']}/publish", cookies=cookies).status_code == 409

    draft = _post(cookies, [page["id"]]).json()
    assert client.delete(f"{API}/posts/{draft['id']}", cookies=cookies).status_code == 200
    assert client.get(f"{API}/posts/{draft['id']}", cookies=cookies).status_code == 404


def test_publish_now_fb_text_only(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000014")
    post = _post(cookies, [page["id"]], caption="Text only").json()
    published = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies)
    assert published.status_code == 200, published.text
    body = published.json()
    assert graph.paths() == [("5100000000014/feed", {"message": "Text only"})]
    assert graph.calls[0][2] == "PAGE-TOKEN-5100000000014"
    assert body["status"] == "published" and body["lastError"] == ""
    assert body["results"] == [{"pageId": page["id"], "metaPostId": "5100000000014_feed_id", "error": ""}]
    assert body["publishedAt"]


def test_publish_now_fb_photos_use_signed_media_urls(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000015")
    post = _post(cookies, [page["id"]], caption="Two photos", media=[VALID_PNG_DATA_URL, VALID_PNG_DATA_URL]).json()
    published = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies)
    assert published.status_code == 200, published.text
    paths = graph.paths()
    assert len(paths) == 3
    for index in (0, 1):
        path, data = paths[index]
        assert path == "5100000000015/photos"
        assert data["published"] == "false"
        expected = f"https://studio.example.test/api/social-studio/media/{post['id']}/{index}?sig={studio.media_signature(post['id'], index)}"
        assert data["url"] == expected
    assert paths[2] == ("5100000000015/feed", {
        "message": "Two photos",
        "attached_media[0]": json.dumps({"media_fbid": "5100000000015_photos_id"}, separators=(",", ":")),
        "attached_media[1]": json.dumps({"media_fbid": "5100000000015_photos_id"}, separators=(",", ":")),
    })
    assert published.json()["status"] == "published"


def test_publish_now_instagram_single_and_carousel(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000016", platform="ig", ig_user_id="17800000000016")
    single = _post(cookies, [page["id"]], caption="IG one", media=[VALID_PNG_DATA_URL]).json()
    published = client.post(f"{API}/posts/{single['id']}/publish", cookies=cookies)
    assert published.status_code == 200, published.text
    assert graph.paths() == [
        ("17800000000016/media", {"image_url": studio.media_public_url(single["id"], 0), "caption": "IG one"}),
        ("17800000000016/media_publish", {"creation_id": "17800000000016_media_id"}),
    ]
    assert graph.calls[0][2] == "PAGE-TOKEN-5100000000016"  # page token of the linked FB page
    assert published.json()["results"][0]["metaPostId"] == "17800000000016_media_publish_id"

    graph.calls.clear()
    carousel = _post(cookies, [page["id"]], caption="IG many", media=[VALID_PNG_DATA_URL] * 3).json()
    assert client.post(f"{API}/posts/{carousel['id']}/publish", cookies=cookies).status_code == 200
    paths = graph.paths()
    assert [p for p, _d in paths] == ["17800000000016/media"] * 4 + ["17800000000016/media_publish"]
    assert all(d["is_carousel_item"] == "true" for _p, d in paths[:3])
    assert paths[3][1] == {"media_type": "CAROUSEL", "children": ",".join(["17800000000016_media_id"] * 3), "caption": "IG many"}

    # Instagram without a photo fails cleanly.
    text_only = _post(cookies, [page["id"]], caption="No photo").json()
    failed = client.post(f"{API}/posts/{text_only['id']}/publish", cookies=cookies).json()
    assert failed["status"] == "failed" and "photo" in failed["lastError"]


def test_publish_failure_sets_failed_and_retry_skips_succeeded_pages(actors, graph):
    cookies = actors["a"]["cookies"]
    fb_page = _link(actors, "a", "5100000000017")
    ig_page = _link(actors, "a", "5100000000018", platform="ig", ig_user_id="17800000000018")
    post = _post(cookies, [fb_page["id"], ig_page["id"]], caption="Both", media=[VALID_PNG_DATA_URL]).json()
    graph.fail["/media_publish"] = meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True)
    failed = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies)
    assert failed.status_code == 200, failed.text
    body = failed.json()
    assert body["status"] == "failed"
    assert body["lastError"] == "Meta is temporarily unavailable."
    assert body["results"][0]["metaPostId"] == "5100000000017_feed_id" and body["results"][0]["error"] == ""
    assert body["results"][1]["metaPostId"] == "" and body["results"][1]["error"] == "Meta is temporarily unavailable."
    assert body["publishedAt"] == ""

    graph.fail.clear()
    fb_calls_before = len([p for p, _d in graph.paths() if p.startswith("5100000000017/")])
    retried = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies).json()
    assert retried["status"] == "published" and retried["lastError"] == ""
    assert retried["results"][0]["metaPostId"] == "5100000000017_feed_id"
    assert retried["results"][1]["metaPostId"] == "17800000000018_media_publish_id"
    assert len([p for p, _d in graph.paths() if p.startswith("5100000000017/")]) == fb_calls_before

    # An unhealthy token marks the page; a later success clears it.
    other = _post(cookies, [fb_page["id"]], caption="Auth check").json()
    graph.fail["/feed"] = meta_ads.MetaAdsError("authorization", "Meta authorization failed.")
    client.post(f"{API}/posts/{other['id']}/publish", cookies=cookies)
    assert client.get(f"{API}/pages", cookies=cookies).json()["pages"][0]["healthy"] is False
    graph.fail.clear()
    client.post(f"{API}/posts/{other['id']}/publish", cookies=cookies)
    assert client.get(f"{API}/pages", cookies=cookies).json()["pages"][0]["healthy"] is True


def test_post_owner_scoping(actors):
    a_page = _link(actors, "a", "5100000000019")
    b_page = _link(actors, "b", "5100000000020")
    a_post = _post(actors["a"]["cookies"], [a_page["id"]]).json()
    b_post = _post(actors["b"]["cookies"], [b_page["id"]]).json()
    b = actors["b"]["cookies"]
    assert client.get(f"{API}/posts/{a_post['id']}", cookies=b).status_code == 404
    assert client.patch(f"{API}/posts/{a_post['id']}", json={"caption": "x"}, cookies=b).status_code == 404
    assert client.delete(f"{API}/posts/{a_post['id']}", cookies=b).status_code == 404
    assert client.post(f"{API}/posts/{a_post['id']}/publish", cookies=b).status_code == 404
    assert [p["id"] for p in client.get(f"{API}/posts", cookies=b).json()["posts"]] == [b_post["id"]]
    assert [p["id"] for p in client.get(f"{API}/pages", cookies=b).json()["pages"]] == [b_page["id"]]
    admin = actors["admin"]["cookies"]
    assert client.get(f"{API}/posts/{a_post['id']}", cookies=admin).status_code == 200
    scoped = client.get(f"{API}/posts", params={"ownerId": actors["a"]["id"]}, cookies=admin).json()["posts"]
    assert [p["id"] for p in scoped] == [a_post["id"]]
    on_behalf = client.post(
        f"{API}/posts", params={"ownerId": actors["a"]["id"]},
        json={"pageIds": [a_page["id"]], "caption": "By admin for A"}, cookies=admin,
    )
    assert on_behalf.status_code == 200, on_behalf.text
    assert on_behalf.json()["ownerId"] == actors["a"]["id"]
    assert client.get(f"{API}/posts/{on_behalf.json()['id']}", cookies=actors["a"]["cookies"]).status_code == 200


# ---------------------------------------------------------------------------
# Signed public media
# ---------------------------------------------------------------------------


def test_media_route_requires_valid_signature_and_no_login(actors):
    page = _link(actors, "a", "5100000000021")
    post = _post(actors["a"]["cookies"], [page["id"]], media=[VALID_PNG_DATA_URL]).json()
    anonymous = TestClient(app)
    good = anonymous.get(f"{API}/media/{post['id']}/0", params={"sig": studio.media_signature(post["id"], 0)})
    assert good.status_code == 200, good.text
    assert good.headers["content-type"].startswith("image/png")
    assert good.headers["cache-control"] == "private, max-age=3600"
    assert good.content == base64.b64decode(VALID_PNG_DATA_URL.split(",", 1)[1])
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"sig": "0" * 64}).status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/0").status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/1", params={"sig": studio.media_signature(post["id"], 1)}).status_code == 404
    assert anonymous.get(f"{API}/media/spost_missing/0", params={"sig": studio.media_signature("spost_missing", 0)}).status_code == 404
    # The signature is bound to the app secret.
    with_other_secret = hmac.new(b"other", f"{post['id']}:0".encode(), hashlib.sha256).hexdigest()
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"sig": with_other_secret}).status_code == 404


# ---------------------------------------------------------------------------
# Pages (admin only)
# ---------------------------------------------------------------------------


def test_admin_links_and_unlinks_pages_customers_cannot(actors):
    admin = actors["admin"]["cookies"]
    body = {"ownerId": actors["a"]["id"], "metaPageId": "5100000000022", "platform": "fb", "name": "Shop <b>A</b>"}
    assert client.post(f"{API}/pages/link", json=body, cookies=actors["a"]["cookies"]).status_code == 403
    linked = client.post(f"{API}/pages/link", json=body, cookies=admin)
    assert linked.status_code == 200, linked.text
    page = linked.json()
    assert page["name"] == "Shop bA/b" and page["healthy"] is True and page["linkedBy"] == actors["admin"]["id"]
    assert page["ownerId"] == actors["a"]["id"] and page["igUserId"] == ""
    # Same page for another owner -> 409; same page as Instagram is a different link.
    assert client.post(f"{API}/pages/link", json={**body, "ownerId": actors["b"]["id"]}, cookies=admin).status_code == 409
    assert client.post(f"{API}/pages/link", json={**body, "platform": "ig"}, cookies=admin).status_code == 400
    ig = client.post(f"{API}/pages/link", json={**body, "platform": "ig", "igUserId": "17800000000022"}, cookies=admin)
    assert ig.status_code == 200, ig.text
    assert client.post(f"{API}/pages/link", json={**body, "metaPageId": "abc"}, cookies=admin).status_code == 400
    assert client.post(f"{API}/pages/link", json={**body, "ownerId": "user_nobody"}, cookies=admin).status_code == 404

    assert [p["id"] for p in client.get(f"{API}/pages", cookies=actors["a"]["cookies"]).json()["pages"]] == [page["id"], ig.json()["id"]]
    assert client.post(f"{API}/pages/{page['id']}/unlink", cookies=actors["a"]["cookies"]).status_code == 403
    assert client.post(f"{API}/pages/{page['id']}/unlink", cookies=admin).status_code == 200
    assert [p["id"] for p in client.get(f"{API}/pages", cookies=actors["a"]["cookies"]).json()["pages"]] == [ig.json()["id"]]
    # An unlinked page can be linked again (to anyone).
    assert client.post(f"{API}/pages/link", json={**body, "ownerId": actors["b"]["id"]}, cookies=admin).status_code == 200


def test_available_pages_come_from_meta_and_mark_linked_ones(actors, monkeypatch):
    rows = [
        {"id": "5100000000023", "name": "Linked <shop>", "instagram_business_account": {"id": "17800000000023", "username": "linked.shop"}},
        {"id": "5100000000024", "name": "Free page"},
    ]
    seen = []

    def fake_paged(self, path, params, *, max_pages=5):
        seen.append((path, params))
        return rows

    monkeypatch.setattr(meta_ads.MetaAdsClient, "_paged", fake_paged)
    _link(actors, "a", "5100000000023")
    assert client.get(f"{API}/pages/available", cookies=actors["a"]["cookies"]).status_code == 403
    response = client.get(f"{API}/pages/available", cookies=actors["admin"]["cookies"])
    assert response.status_code == 200, response.text
    assert seen == [("me/accounts", {"fields": "id,name,instagram_business_account{id,username}", "limit": 100})]
    assert response.json()["pages"] == [
        {"metaPageId": "5100000000023", "name": "Linked shop", "platform": "fb", "alreadyLinked": True, "ownerId": actors["a"]["id"]},
        {"metaPageId": "5100000000023", "name": "linked.shop", "platform": "ig", "igUserId": "17800000000023", "alreadyLinked": False, "ownerId": ""},
        {"metaPageId": "5100000000024", "name": "Free page", "platform": "fb", "alreadyLinked": False, "ownerId": ""},
    ]
    monkeypatch.delenv("ALBAYAN_META_ACCESS_TOKEN")
    not_configured = client.get(f"{API}/pages/available", cookies=actors["admin"]["cookies"])
    assert not_configured.status_code == 503
    assert "not connected" in not_configured.json()["detail"]


# ---------------------------------------------------------------------------
# Scheduler, stats and the real Graph POST helper
# ---------------------------------------------------------------------------


def test_scheduler_tick_publishes_due_posts_once(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000025")
    due = _post(cookies, [page["id"]], caption="Scheduled", status="scheduled", scheduledAt=_future(2)).json()
    later = _post(cookies, [page["id"]], caption="Later", status="scheduled", scheduledAt=_future(120)).json()
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc)) == 0
    assert graph.calls == []
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
    assert graph.paths() == [("5100000000025/feed", {"message": "Scheduled"})]
    assert client.get(f"{API}/posts/{due['id']}", cookies=cookies).json()["status"] == "published"
    assert client.get(f"{API}/posts/{later['id']}", cookies=cookies).json()["status"] == "scheduled"
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 0
    assert len(graph.calls) == 1
    # The worker only starts when Meta is configured, and stops cleanly.
    studio.stop_social_studio_worker()
    assert studio._WORKER_THREAD is None


def test_stats_last_24h_and_platform_shares(actors, graph):
    cookies = actors["a"]["cookies"]
    empty = client.get(f"{API}/stats", cookies=cookies).json()
    assert empty["last24h"] == {"commentsAnswered": 0, "dmsSent": 0, "postsPublished": 0, "scheduledInQueue": 0, "fbShare": 50, "igShare": 50}
    assert empty["connected"] is True and empty["webhookConfigured"] is False and empty["updatedAt"]

    fb_page = _link(actors, "a", "5100000000026")
    _link(actors, "a", "5100000000027", platform="ig", ig_user_id="17800000000027")
    _rule(cookies, name="FB", publicReply="Thanks", dmEnabled=True, dmText="DM")
    _rule(cookies, name="IG", platform="ig", publicReply="Thanks")
    _webhook(_fb_comment("5100000000026", "5100000000026_1", "9010", "hi"))
    _webhook(_fb_comment("5100000000026", "5100000000026_2", "9011", "hi"))
    _webhook({"object": "instagram", "entry": [{"id": "17800000000027", "changes": [{"field": "comments", "value": {
        "id": "17900000000027", "media": {"id": "m"}, "from": {"id": "9012"}, "text": "hi",
    }}]}]})
    post = _post(cookies, [fb_page["id"]], caption="Now").json()
    assert client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies).json()["status"] == "published"
    _post(cookies, [fb_page["id"]], caption="Queued", status="scheduled", scheduledAt=_future())
    stats = client.get(f"{API}/stats", cookies=cookies).json()["last24h"]
    assert stats == {"commentsAnswered": 3, "dmsSent": 2, "postsPublished": 1, "scheduledInQueue": 1, "fbShare": 67, "igShare": 33}
    # Customer B's dashboard is not polluted by A's activity.
    assert client.get(f"{API}/stats", cookies=actors["b"]["cookies"]).json()["last24h"]["commentsAnswered"] == 0


def test_real_post_helper_sends_form_data_with_page_token_proof(monkeypatch):
    page_token = "page-token-must-never-leak"
    expected_proof = hmac.new(APP_SECRET.encode(), page_token.encode(), hashlib.sha256).hexdigest()
    real_client_class = httpx.Client
    seen = []

    def handler(request):
        seen.append(request)
        if request.method == "GET":
            assert request.url.path.endswith("/5100000000030")
            assert request.headers.get("Authorization") == f"Bearer {SYSTEM_TOKEN}"
            return httpx.Response(200, json={"id": "5100000000030", "access_token": page_token})
        assert request.method == "POST"
        assert request.headers.get("Authorization") == f"Bearer {page_token}"
        assert "access_token" not in request.url.params and "appsecret_proof" not in request.url.params
        body = dict(httpx.QueryParams(request.content.decode("utf-8")))
        assert body["appsecret_proof"] == expected_proof
        assert body["message"] == "Hello من ليبيا"
        assert body["published"] == "false"
        assert body["attached_media[0]"] == '{"media_fbid":"1"}'
        return httpx.Response(200, json={"id": "5100000000030_1"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(meta_ads.httpx, "Client", lambda **kwargs: real_client_class(transport=transport, **kwargs))
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_meta_request_interval_seconds", lambda: 0.0)
    meta_ads._PAGE_TOKEN_CACHE.clear()
    client_obj = meta_ads.get_meta_ads_client()
    token = client_obj.page_access_token("5100000000030")
    assert token == page_token
    assert client_obj.page_access_token("5100000000030") == page_token  # cached: no second GET
    payload = client_obj._post(
        "5100000000030/feed",
        {"message": "Hello من ليبيا", "published": False, "attached_media[0]": {"media_fbid": "1"}, "skip": None},
        access_token=token,
    )
    assert payload == {"id": "5100000000030_1"}
    assert [r.method for r in seen] == ["GET", "POST"]
    with pytest.raises(meta_ads.MetaAdsError):
        client_obj._post("../evil", {})
