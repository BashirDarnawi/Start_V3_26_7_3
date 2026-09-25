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
import time
from contextlib import contextmanager
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
import server.systems.ads_studio.social_studio as studio
from server.systems.ads_studio import studio_settings
from server.systems.ads_studio.studio_types import STUDIO_SETTINGS_TYPE


client = TestClient(app, headers={"Origin": "http://testserver"})
# P4-05: every reply channel open (the capability gates arm with the first save of the setting).
ALL_ON = {"fbPublicReply": "on", "fbPrivateReply": "on", "igPublicReply": "on", "igPrivateReply": "on"}
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


def _arm(capabilities):
    """Save the ``capabilities`` setting (partial: the rest keeps its default): the gates are armed."""
    record = studio_settings.read_setting("capabilities")
    studio_settings.save_setting("capabilities", capabilities, record["version"], "test", studio._iso_now(),
                                 audit=lambda conn, before, after: None)


def _disarm():
    """Remove the ``capabilities`` setting row: the gates are not armed (classic behaviour)."""
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :type AND id = :id"),
                     {"type": STUDIO_SETTINGS_TYPE, "id": studio_settings.setting_id("capabilities")})


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, actors):
    for who in actors.values():
        reset_rate_limit(f"social-studio:mutations:{who['id']}")
        reset_rate_limit(f"social-studio:available:{who['id']}")
        reset_rate_limit(f"social-studio:log:{who['id']}")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.delenv("ALBAYAN_META_WEBHOOK_VERIFY_TOKEN", raising=False)
    monkeypatch.setenv("ALBAYAN_PUBLIC_BASE_URL", "https://studio.example.test/")
    # The ad-account discovery wake-up would otherwise try to reach Meta.
    monkeypatch.setattr(meta_ads, "discover_meta_ads", lambda *args, **kwargs: {})
    meta_ads._PAGE_TOKEN_CACHE.clear()
    _wipe_social_rows()
    _disarm()
    yield
    _disarm()


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


def _assert_signed_media_url(url, post_id, index):
    """A media URL carries an unexpired exp and a signature over post, index and exp."""
    prefix = f"https://studio.example.test/api/social-studio/media/{post_id}/{index}?exp="
    assert url.startswith(prefix), url
    query = dict(part.split("=", 1) for part in url.split("?", 1)[1].split("&"))
    exp = int(query["exp"])
    assert exp > int(time.time())
    assert query["sig"] == studio.media_signature(post_id, index, exp)
    return exp


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


def test_rule_active_since_moves_only_when_the_rule_starts_answering_other_comments(actors, monkeypatch):
    """activeSince (P1-23 follow-up): a comment Albayan reads later is answered only by rules that already
    applied to it when it was written, so switching a rule on or pointing it elsewhere moves it to now."""
    cookies = actors["a"]["cookies"]
    clock = [1_800_000_000_000]
    monkeypatch.setattr(studio, "now_ms", lambda: clock[0])
    rule = _rule(cookies, activeSince=5)  # a client's value is never taken
    assert rule["activeSince"] == clock[0]

    def patch(body):
        clock[0] += 1000
        response = client.patch(f"{API}/rules/{rule['id']}", json=body, cookies=cookies)
        assert response.status_code == 200, response.text
        return response.json()["activeSince"]

    start = clock[0]
    assert patch({"publicReply": "Thanks again", "name": "Renamed", "oncePerPerson": True, "quietHours": True}) == start
    assert patch({"activeSince": 7, "dmEnabled": True, "dmText": "Hi"}) == start
    assert patch({"enabled": False}) == start  # switched off: nothing new is answered
    assert patch({"enabled": False, "likeComment": True}) == start
    assert patch({"enabled": True}) == clock[0]  # switched on again
    for body in ({"platform": "ig"}, {"scope": "chosen", "postIds": ["p1"]}, {"postIds": ["p1", "p2"]},
                 {"trigger": "keywords", "keywords": ["price"]}, {"keywords": ["price", "cost"]}):
        assert patch(body) == clock[0], body
    assert patch({"keywords": ["PRICE", "cost"]}) == clock[0] - 1000  # the same keywords once normalized


def test_reply_log_keeps_the_comment_time(actors, graph):
    _link(actors, "a", "5100000000031")
    _rule(actors["a"]["cookies"])
    _webhook(_fb_comment("5100000000031", "5100000000031_1", "9031", "hello"))
    [log] = _log_rows(actors["a"]["id"])
    assert log["source"] == "webhook" and log["commentAt"] == log["at"]  # a webhook comes as it is written
    written = datetime.now(timezone.utc) - timedelta(days=2, hours=3)
    handled = studio.process_comment(platform="fb", entry_id="5100000000031", comment_id="5100000000031_2",
                                     post_ref="post_1", from_id="9032", text="hi", source="manual_check",
                                     comment_at=written.isoformat())
    assert handled is None  # the rule is younger than the comment: never answered, nothing claimed
    old_rule = next(iter(studio._rows(studio.RULES_TYPE, actors["a"]["id"])))
    made = now_ms() - 3 * 86_400_000  # the rule is older than the comment now (list_entities reads created_at)
    data = {**old_rule["data"], "_created": made}
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json=:d, created_at=:c WHERE type='socialReplyRules' AND id=:id"),
                     {"d": json_dumps(data), "c": made, "id": old_rule["id"]})
    handled = studio.process_comment(platform="fb", entry_id="5100000000031", comment_id="5100000000031_3",
                                     post_ref="post_1", from_id="9033", text="hi", source="manual_check",
                                     comment_at=written.isoformat())
    assert handled is None  # activeSince (set when the rule was made) is still after the comment
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json=:d WHERE type='socialReplyRules' AND id=:id"),
                     {"d": json_dumps({k: v for k, v in data.items() if k != "activeSince"}), "id": old_rule["id"]})
    handled = studio.process_comment(platform="fb", entry_id="5100000000031", comment_id="5100000000031_4",
                                     post_ref="post_1", from_id="9034", text="hi", source="manual_check",
                                     comment_at=written.isoformat())
    assert handled and handled["commentAt"] == studio._iso_at(written) != handled["at"]  # a rule from before activeSince


def _parked_reply(owner, page_id, rule_id, comment_id, *, claimed_ago, written_ago=None):
    """A reply-log row a temporary Meta problem parked for the retry pass."""
    now = datetime.now(timezone.utc)
    data = {"id": f"srl_{comment_id}", "ownerId": owner, "pageId": page_id, "platform": "fb", "ruleId": rule_id,
            "commentId": comment_id, "fromId": f"from_{comment_id}", "actions": [], "processing": False,
            "error": "Meta paused", "attempts": 1, "retryAfter": studio._iso_at(now - timedelta(minutes=1)),
            "at": studio._iso_at(now - claimed_ago)}
    if written_ago is not None:
        data["commentAt"] = studio._iso_at(now - written_ago)
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                     {"id": data["id"], "data": json_dumps(data), "t": now_ms(), "owner": owner})
    return data["id"]


def test_retry_window_is_measured_from_the_comment(monkeypatch):
    """Meta's 7-day private-reply window starts when the comment was written: a comment a manual check
    read six days late has one day of retries left, not seven."""
    owner, page_id, rule_id = new_id("owner_window"), new_id("spg_window"), new_id("srule_window")
    with db_conn() as conn:
        for entity_type, entity_id, data in (
            ("socialPages", page_id, {"ownerId": owner, "metaPageId": "5100000000041", "platform": "fb", "name": "P"}),
            ("socialReplyRules", rule_id, {"ownerId": owner, "enabled": True, "platform": "fb", "publicReply": "Thanks"}),
        ):
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES (:type,:id,:data,false,:t,:owner,:t)"),
                         {"type": entity_type, "id": entity_id, "data": json_dumps({"id": entity_id, **data}),
                          "t": now_ms(), "owner": owner})
    late = _parked_reply(owner, page_id, rule_id, "c_late", claimed_ago=timedelta(minutes=5), written_ago=timedelta(days=8))
    within = _parked_reply(owner, page_id, rule_id, "c_within", claimed_ago=timedelta(minutes=5), written_ago=timedelta(days=6))
    legacy = _parked_reply(owner, page_id, rule_id, "c_legacy", claimed_ago=timedelta(minutes=5))  # no commentAt: the claim time
    monkeypatch.setattr(studio, "_owner_can_automate", lambda owner_id: owner_id == owner)
    sent = []
    monkeypatch.setattr(studio, "_execute_rule_actions",
                        lambda page, rule, platform, comment_id: sent.append(comment_id) or (["public"], [], False))
    try:
        studio._retry_pending_replies(datetime.now(timezone.utc))
        assert sorted(sent) == ["c_legacy", "c_within"]
        with db_conn() as conn:
            rows = {row["id"]: json_loads(row["data_json"]) for row in conn.execute(
                text("SELECT id, data_json FROM entities WHERE id IN (:a, :b, :c)"), {"a": late, "b": within, "c": legacy},
            ).mappings()}
        assert rows[late]["retryAfter"] == "" and "expired" in rows[late]["error"] and rows[late]["actions"] == []
        assert rows[within]["actions"] == ["public"] and rows[legacy]["actions"] == ["public"]
    finally:
        with db_conn() as conn:
            for entity_id in (page_id, rule_id, late, within, legacy):
                conn.execute(text("DELETE FROM entities WHERE id=:id"), {"id": entity_id})


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
        ("5100000000001/messages", {"recipient": '{"comment_id":"5100000000001_777"}', "message": '{"text":"Price is 50 LYD"}'}),
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


def test_fb_private_reply_uses_page_messages(actors, graph):
    """Meta removed /{comment-id}/private_replies after Graph API v3.2; the current path is
    POST /{page-id}/messages with recipient.comment_id, sent with that Page's token."""
    _link(actors, "a", "5100000000031")
    _rule(actors["a"]["cookies"], name="DM", dmEnabled=True, dmText="مرحباً، أرسلنا لك التفاصيل")
    _webhook(_fb_comment("5100000000031", "5100000000031_5", "9031", "hello"))
    path, data, token = graph.calls[0]
    assert path == "5100000000031/messages" and token == "PAGE-TOKEN-5100000000031"
    assert json.loads(data["recipient"]) == {"comment_id": "5100000000031_5"}
    assert json.loads(data["message"]) == {"text": "مرحباً، أرسلنا لك التفاصيل"}
    assert _log_rows(actors["a"]["id"])[0]["actions"][0] == "dm"  # the helper rule also carries a default public reply


def test_reply_retries_once_with_a_fresh_page_token(actors, graph, monkeypatch):
    """A Page token revoked since it was cached: the reply is sent with a fresh token, not lost."""
    _link(actors, "a", "5100000000032")
    _rule(actors["a"]["cookies"], name="Thanks", publicReply="Thanks!")
    tokens = iter(["STALE", "FRESH"])
    monkeypatch.setattr(meta_ads.MetaAdsClient, "page_access_token", lambda self, page_id: next(tokens))
    original = graph.post

    def post(path, data, token):
        if token == "STALE":
            graph.calls.append((path, dict(data or {}), token))
            raise meta_ads.MetaAdsError("authorization", "Meta authorization failed. Reconnect the access token.", provider_code="190.460")
        return original(path, data, token)

    monkeypatch.setattr(graph, "post", post)
    _webhook(_fb_comment("5100000000032", "5100000000032_1", "9032", "hello"))
    assert [token for _p, _d, token in graph.calls] == ["STALE", "FRESH"]
    log = _log_rows(actors["a"]["id"])[0]
    assert log["actions"] == ["public"] and log["error"] == ""


def test_private_replies_endpoint_never_called():
    source = Path(studio.__file__).read_text(encoding="utf-8")
    code = "\n".join(line.split("#", 1)[0] for line in source.splitlines())
    assert "private_replies" not in code


def test_webhook_skip_public_after_dm(actors, graph):
    _link(actors, "a", "5100000000002")
    _rule(
        actors["a"]["cookies"], name="DM first", publicReply="Public fallback",
        dmEnabled=True, dmText="Private answer", skipPublicAfterDm=True,
    )
    _webhook(_fb_comment("5100000000002", "5100000000002_1", "9003", "hello"))
    assert graph.paths() == [("5100000000002/messages", {"recipient": '{"comment_id":"5100000000002_1"}', "message": '{"text":"Private answer"}'})]
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
    graph.fail["/messages"] = meta_ads.MetaAdsError("request_failed", "Meta refused the message.")
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
        _assert_signed_media_url(data["url"], post["id"], index)
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
    ig_paths = graph.paths()
    assert [p for p, _d in ig_paths] == ["17800000000016/media", "17800000000016/media_publish"]
    assert ig_paths[0][1]["caption"] == "IG one"
    _assert_signed_media_url(ig_paths[0][1]["image_url"], single["id"], 0)
    assert ig_paths[1][1] == {"creation_id": "17800000000016_media_id"}
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
    exp = _assert_signed_media_url(studio.media_public_url(post["id"], 0), post["id"], 0)
    signed = {"exp": str(exp), "sig": studio.media_signature(post["id"], 0, exp)}
    good = anonymous.get(f"{API}/media/{post['id']}/0", params=signed)
    assert good.status_code == 200, good.text
    assert good.headers["content-type"].startswith("image/png")
    assert good.headers["cache-control"] == "private, max-age=3600"
    assert good.content == base64.b64decode(VALID_PNG_DATA_URL.split(",", 1)[1])
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"exp": str(exp), "sig": "0" * 64}).status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"sig": signed["sig"]}).status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/0").status_code == 404
    # A link is bound to its expiry: once past, a genuine signature over the
    # old expiry is dead, and moving exp forward breaks the signature.
    stale = exp - studio.MEDIA_URL_TTL_SECONDS - 3600
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"exp": str(stale), "sig": studio.media_signature(post["id"], 0, stale)}).status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"exp": str(exp + 1), "sig": signed["sig"]}).status_code == 404
    assert anonymous.get(f"{API}/media/{post['id']}/1", params={"exp": str(exp), "sig": studio.media_signature(post["id"], 1, exp)}).status_code == 404
    assert anonymous.get(f"{API}/media/spost_missing/0", params={"exp": str(exp), "sig": studio.media_signature("spost_missing", 0, exp)}).status_code == 404
    # Garbage that is not even ASCII is refused, never a crash into a 500.
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"exp": str(exp), "sig": "\u00e9" * 8}).status_code == 404
    # The key is derived from the app secret; the raw secret itself signs nothing.
    with_raw_secret = hmac.new(APP_SECRET.encode(), f"{post['id']}:0:{exp}".encode(), hashlib.sha256).hexdigest()
    assert anonymous.get(f"{API}/media/{post['id']}/0", params={"exp": str(exp), "sig": with_raw_secret}).status_code == 404


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


def test_manual_publish_and_edits_reset_the_scheduler_retry_budget(actors, graph):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000026")
    post = _post(cookies, [page["id"]], caption="Budget", status="scheduled", scheduledAt=_future(2)).json()
    owner = str(post["ownerId"]) if post.get("ownerId") else actors["a"]["id"]

    def attempts():
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": post["id"]}).mappings().first()
        return json_loads(row["data_json"])

    studio._ctx()["patch_entity"](studio.POSTS_TYPE, post["id"], {"publishAttempts": 5}, owner)
    graph.fail["/feed"] = meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True)
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
    assert attempts()["status"] == "failed" and attempts()["publishAttempts"] == 6   # budget exhausted
    # "Publish now" starts fresh: the failure is recorded as attempt 1, not 7.
    manual = client.post(f"{API}/posts/{post['id']}/publish", cookies=cookies)
    assert manual.status_code == 200, manual.text
    assert manual.json()["status"] == "failed" and attempts()["publishAttempts"] == 1
    # Editing (rescheduling) resets it too, so the scheduler can retry again.
    edited = client.patch(f"{API}/posts/{post['id']}", json={"status": "scheduled", "scheduledAt": _future(2)}, cookies=cookies)
    assert edited.status_code == 200, edited.text
    assert attempts()["publishAttempts"] == 0
    assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
    after = attempts()
    assert after["status"] == "scheduled" and after["publishAttempts"] == 1 and after["lastError"]


@pytest.mark.parametrize("action", ["edit", "cancel", "delete"])
def test_post_mutation_cannot_overwrite_a_concurrent_publish_claim(actors, monkeypatch, action):
    cookies = actors["a"]["cookies"]
    page = _link(actors, "a", "5100000000031")
    post = _post(cookies, [page["id"]], status="scheduled", scheduledAt=_future()).json()
    original_load = studio._load_owned
    claimed = []

    def load_then_claim(*args, **kwargs):
        entity = original_load(*args, **kwargs)
        if entity["id"] == post["id"] and not claimed:
            claimed.append(studio._claim_post(studio._ctx(), entity, actors["a"]["id"]))
        return entity

    monkeypatch.setattr(studio, "_load_owned", load_then_claim)
    path = f"{API}/posts/{post['id']}"
    if action == "edit":
        response = client.patch(path, json={"caption": "Late edit", "status": "draft"}, cookies=cookies)
    elif action == "cancel":
        response = client.post(path + "/cancel", cookies=cookies)
    else:
        response = client.delete(path, cookies=cookies)
    assert claimed == [True]
    assert response.status_code == 409, response.text
    saved = studio._ctx()["get_entity"](studio.POSTS_TYPE, post["id"])
    assert saved["deleted"] is False
    assert saved["data"]["status"] == "publishing"
    assert saved["data"]["caption"] == post["caption"]


def test_scheduler_finds_due_posts_beyond_500_future_posts(actors):
    now = datetime.now(timezone.utc)
    stamp = now_ms()
    rows = []
    for i in range(502):
        due = i >= 500
        post_id = f"spost_scheduler_regression_{i}"
        data = {"id": post_id, "ownerId": actors["a"]["id"], "status": "scheduled",
                "scheduledAt": (now + timedelta(days=-1 if due else 30)).isoformat(),
                "media": [VALID_PNG_DATA_URL]}
        rows.append({"id": post_id, "data": json_dumps(data), "stamp": stamp + i,
                     "owner": actors["a"]["id"], "type": studio.POSTS_TYPE})
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"), rows)
    due = studio._due_scheduled_posts(now, 1)
    assert [entity["id"] for entity in due] == ["spost_scheduler_regression_500"]
    assert len(studio._due_scheduled_posts(now, 20)) == 2
    assert studio._due_scheduled_posts(now, 0) == []


@contextmanager
def _suspend_social_owner(owner_id, reason):
    """Temporarily change real stored access, restoring shared fixture rows."""
    with db_conn() as conn:
        subscriptions = conn.execute(text(
            "SELECT id,data_json FROM entities WHERE type='serviceSubscriptions' AND created_by=:uid"
        ), {"uid": owner_id}).mappings().all()
        if reason == "deleted":
            conn.execute(text("UPDATE users SET deleted=true WHERE id=:uid"), {"uid": owner_id})
        else:
            for row in subscriptions:
                data = json_loads(row["data_json"])
                if reason == "expired":
                    data["expiresAt"] = "2001-01-01T00:00:00Z"
                else:
                    data["status"] = "canceled"
                conn.execute(text("UPDATE entities SET data_json=:data WHERE type='serviceSubscriptions' AND id=:id"),
                             {"id": row["id"], "data": json_dumps(data)})
    try:
        yield
    finally:
        with db_conn() as conn:
            conn.execute(text("UPDATE users SET deleted=false WHERE id=:uid"), {"uid": owner_id})
            for row in subscriptions:
                conn.execute(text("UPDATE entities SET data_json=:data WHERE type='serviceSubscriptions' AND id=:id"),
                             {"id": row["id"], "data": row["data_json"]})


@pytest.mark.parametrize("reason", ["expired", "canceled", "deleted"])
def test_scheduled_post_rechecks_owner_access_and_can_be_retried_after_renewal(actors, graph, reason):
    owner = actors["a"]
    page = _link(actors, "a", "5100000000038")
    post = _post(owner["cookies"], [page["id"]], status="scheduled", scheduledAt=_future(2)).json()
    with _suspend_social_owner(owner["id"], reason):
        assert studio.run_scheduler_tick(now=datetime.now(timezone.utc) + timedelta(minutes=5)) == 1
        assert graph.calls == [], "A disabled or unsubscribed owner must not publish in the background"
        saved = studio._ctx()["get_entity"](studio.POSTS_TYPE, post["id"])["data"]
        assert saved["status"] == "failed"
        assert saved["lastError"]
        assert saved["caption"] == post["caption"]
    retry = client.post(f"{API}/posts/{post['id']}/publish", cookies=owner["cookies"])
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "published"
    assert len(graph.calls) == 1


@pytest.mark.parametrize("reason", ["expired", "canceled", "deleted"])
def test_comment_automation_rechecks_owner_access_without_losing_rules(actors, graph, reason):
    owner = actors["a"]
    _link(actors, "a", "5100000000039")
    _rule(owner["cookies"], publicReply="Thanks for your comment")
    payload = _fb_comment("5100000000039", "5100000000039_1", "9019", "hello")
    with _suspend_social_owner(owner["id"], reason):
        assert studio.handle_meta_webhook(payload) == 0
        assert graph.calls == []
        assert _log_rows(owner["id"]) == []
    assert studio.handle_meta_webhook(payload) == 1
    assert graph.paths() == [("5100000000039_1/comments", {"message": "Thanks for your comment"})]


def test_once_per_person_skips_a_second_comment_while_first_reply_is_in_flight(actors, graph, monkeypatch):
    _link(actors, "a", "5100000000040")
    _rule(actors["a"]["cookies"], oncePerPerson=True)
    original_post = graph.post
    nested = []

    def during_reply(path, data, token):
        if not nested:
            nested.append("entered")
            nested.append(studio.handle_meta_webhook(
                _fb_comment("5100000000040", "5100000000040_2", "9020", "second comment")
            ))
        return original_post(path, data, token)

    monkeypatch.setattr(graph, "post", during_reply)
    assert studio.handle_meta_webhook(
        _fb_comment("5100000000040", "5100000000040_1", "9020", "first comment")
    ) == 1
    assert nested == ["entered", 0]
    assert len(graph.calls) == 1


def test_once_per_person_keeps_old_reply_history_beyond_the_display_limit(actors, graph):
    page = _link(actors, "a", "5100000000041")
    _rule(actors["a"]["cookies"], oncePerPerson=True)
    owner = actors["a"]["id"]
    stamp = now_ms()
    rows = []
    for i in range(1002):
        data = {"id": f"srl_old_history_{i}", "ownerId": owner, "pageId": page["id"],
                "fromId": "9021" if i == 0 else f"new_person_{i}", "actions": ["public"]}
        rows.append({"id": data["id"], "data": json_dumps(data), "owner": owner, "stamp": stamp + i})
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:stamp,:owner,:stamp)"), rows)
    assert studio.handle_meta_webhook(
        _fb_comment("5100000000041", "5100000000041_1", "9021", "returning person")
    ) == 0
    assert graph.calls == []


def test_once_per_person_releases_definite_failure_but_remembers_success(actors, graph):
    _link(actors, "a", "5100000000042")
    _rule(actors["a"]["cookies"], oncePerPerson=True)
    graph.fail["/comments"] = meta_ads.MetaAdsError("request_failed", "Reply refused")
    first = _fb_comment("5100000000042", "5100000000042_1", "9022", "hello")
    assert studio.handle_meta_webhook(first) == 1
    assert _log_rows(actors["a"]["id"])[0]["processing"] is False
    graph.fail.clear()
    assert studio.handle_meta_webhook(
        _fb_comment("5100000000042", "5100000000042_2", "9022", "try again")
    ) == 1
    assert studio.handle_meta_webhook(
        _fb_comment("5100000000042", "5100000000042_3", "9022", "already answered")
    ) == 0
    assert len(graph.calls) == 2


def test_once_per_person_stays_page_scoped_and_other_rules_can_reply_repeatedly(actors, graph):
    for page_id in ["5100000000043", "5100000000044"]:
        _link(actors, "a", page_id)
    rule = _rule(actors["a"]["cookies"], oncePerPerson=True)
    for page_id, from_id in [("5100000000043", "9023"), ("5100000000044", "9023"),
                             ("5100000000043", "9024")]:
        assert studio.handle_meta_webhook(_fb_comment(page_id, f"{page_id}_{from_id}", from_id, "hello")) == 1
    response = client.patch(f"{API}/rules/{rule['id']}", json={"oncePerPerson": False}, cookies=actors["a"]["cookies"])
    assert response.status_code == 200
    assert studio.handle_meta_webhook(_fb_comment("5100000000043", "5100000000043_2", "9023", "hello again")) == 1
    assert len(graph.calls) == 4


def test_background_access_preserves_admin_and_current_staff_review_exemptions(actors):
    assert studio._owner_can_automate(actors["admin"]["id"])
    uid = actors["c"]["id"]
    assert not studio._owner_can_automate(uid)
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET permissions_json=:permissions WHERE id=:uid"), {
            "uid": uid, "permissions": json_dumps({"adCampaignRequests": ["review"]}),
        })
    try:
        assert studio._owner_can_automate(uid)
    finally:
        with db_conn() as conn:
            conn.execute(text("UPDATE users SET permissions_json='{}' WHERE id=:uid"), {"uid": uid})
    assert not studio._owner_can_automate(uid)


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
    monkeypatch.setattr(meta_ads, "_META_LAST_REMOTE_REQUEST_MONOTONIC", 0.0)  # restored after the test
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


def test_webhook_signature_and_verify_token_reject_non_ascii_cleanly(monkeypatch):
    raw = json.dumps({"object": "page", "entry": []}).encode("utf-8")
    response = client.post(
        "/api/meta-ads/webhook", content=raw,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": b"sha256=\xc3\xa9"},
    )
    assert response.status_code == 403
    monkeypatch.setenv("ALBAYAN_META_WEBHOOK_VERIFY_TOKEN", "verify-me-please")
    verify = client.get("/api/meta-ads/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "\u00e9", "hub.challenge": "x"})
    assert verify.status_code == 403
    ok = client.get("/api/meta-ads/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "verify-me-please", "hub.challenge": "x"})
    assert ok.status_code == 200 and ok.text == "x"


# ---------------------------------------------------------------------------
# P4-01: rules scoped to pages (pageRefs)
# ---------------------------------------------------------------------------


def test_page_refs_must_be_the_owners_live_pages(actors):
    a, admin = actors["a"]["cookies"], actors["admin"]["cookies"]
    a_page = _link(actors, "a", "5100000000055", name="Shop A")
    b_page = _link(actors, "b", "5100000000056")
    ig_page = _link(actors, "a", "5100000000057", platform="ig", ig_user_id="17800000000057")
    body = {"name": "Scoped", "platform": "fb", "publicReply": "Thanks"}
    refused = client.post(f"{API}/rules", json={**body, "pageRefs": [b_page["id"]]}, cookies=a)
    assert refused.status_code == 400 and "is not linked to this account" in refused.json()["detail"]
    assert client.post(f"{API}/rules", json={**body, "pageRefs": ["spg_nobody"]}, cookies=a).status_code == 400
    wrong = client.post(f"{API}/rules", json={**body, "pageRefs": [ig_page["id"]]}, cookies=a)
    assert wrong.status_code == 400 and "not on this rule's platform" in wrong.json()["detail"]
    rule = _rule(a, **body, pageRefs=[a_page["id"]])
    assert rule["pageRefs"] == [a_page["id"]] and rule["pageRemoved"] is False and rule["pageRemovedLabel"] is None
    assert rule["pages"] == [{"id": a_page["id"], "removed": False, "name": "Shop A", "platform": "fb"}]
    assert client.patch(f"{API}/rules/{rule['id']}", json={"pageRefs": [b_page["id"]]}, cookies=a).status_code == 400
    widened = client.patch(f"{API}/rules/{rule['id']}", json={"pageRefs": []}, cookies=a)
    assert widened.status_code == 200 and widened.json()["pageRefs"] == [] and widened.json()["pages"] == []
    # An admin editing on the owner's behalf is held to the owner's pages too.
    assert client.patch(f"{API}/rules/{rule['id']}", json={"pageRefs": [b_page["id"]]}, cookies=admin).status_code == 400
    listed = client.get(f"{API}/rules", cookies=a).json()
    assert listed["rules"][0]["pageRefs"] == [] and listed["channels"]["labels"]["gated"]["ar"] == "بانتظار موافقة ميتا"


def test_page_refs_scope_which_page_answers(actors, graph):
    a = actors["a"]["cookies"]
    first = _link(actors, "a", "5100000000058")
    _link(actors, "a", "5100000000059")
    _rule(a, name="Only the first page", publicReply="Thanks", pageRefs=[first["id"]])
    _webhook(_fb_comment("5100000000059", "5100000000059_1", "9059", "hi"))
    assert graph.calls == [] and _log_rows(actors["a"]["id"]) == []  # the other page: the rule does not apply
    _webhook(_fb_comment("5100000000058", "5100000000058_1", "9058", "hi"))
    assert graph.paths() == [("5100000000058_1/comments", {"message": "Thanks"})]
    assert _log_rows(actors["a"]["id"])[0]["pageId"] == first["id"]


def test_page_refs_unlink_shows_page_removed_and_relink_keeps_the_rule_firing(actors, graph):
    a, admin = actors["a"]["cookies"], actors["admin"]["cookies"]
    page = _link(actors, "a", "5100000000060", name="Shop")
    rule = _rule(a, name="Shop rule", publicReply="Thanks", pageRefs=[page["id"]])
    _webhook(_fb_comment("5100000000060", "5100000000060_1", "9060", "hi"))
    assert len(graph.calls) == 1
    assert client.post(f"{API}/pages/{page['id']}/unlink", cookies=admin).status_code == 200
    shown = client.get(f"{API}/rules", cookies=a).json()["rules"][0]
    assert shown["pageRemoved"] is True and shown["pages"] == [{"id": page["id"], "removed": True, "name": "Shop", "platform": "fb"}]
    assert shown["pageRemovedLabel"] == {"en": "Page removed", "ar": "الصفحة أُزيلت"}
    _webhook(_fb_comment("5100000000060", "5100000000060_2", "9061", "hi"))
    assert len(graph.calls) == 1  # unlinked: nothing fires
    # The same Meta page linked again to the same owner: the same row id, so the rule fires again.
    relinked = client.post(f"{API}/pages/link", json={"ownerId": actors["a"]["id"], "metaPageId": "5100000000060",
                                                       "platform": "fb", "name": "Shop again"}, cookies=admin)
    assert relinked.status_code == 200, relinked.text
    assert relinked.json()["id"] == page["id"] and relinked.json()["name"] == "Shop again"
    assert relinked.json()["healthy"] is True and relinked.json()["health"]["state"] == "ok"
    listed = client.get(f"{API}/pages", cookies=a).json()["pages"]
    assert [p["id"] for p in listed] == [page["id"]]
    shown = client.get(f"{API}/rules", cookies=a).json()["rules"][0]
    assert shown["pageRemoved"] is False and shown["pages"][0]["name"] == "Shop again"
    _webhook(_fb_comment("5100000000060", "5100000000060_3", "9062", "hi"))
    assert len(graph.calls) == 2 and _log_rows(actors["a"]["id"])[-1]["pageId"] == page["id"]
    with db_conn() as conn:
        actions = [row["action"] for row in conn.execute(
            text("SELECT action FROM audit_logs WHERE resource_type = 'socialPages' AND resource_id = :id"),
            {"id": page["id"]}).mappings().all()]
    assert sorted(actions) == ["link", "relink", "unlink"]
    # Linked to ANOTHER owner after an unlink: a new row; the first owner's rule stays "page removed".
    assert client.post(f"{API}/pages/{page['id']}/unlink", cookies=admin).status_code == 200
    moved = client.post(f"{API}/pages/link", json={"ownerId": actors["b"]["id"], "metaPageId": "5100000000060", "platform": "fb"}, cookies=admin)
    assert moved.status_code == 200 and moved.json()["id"] != page["id"]
    assert client.get(f"{API}/rules", cookies=a).json()["rules"][0]["pageRemoved"] is True
    assert rule["id"] == shown["id"]


# ---------------------------------------------------------------------------
# P4-02: the reply log, its counters and the latency fields
# ---------------------------------------------------------------------------


def test_reply_log_owner_only(actors, graph):
    a, b, admin = actors["a"]["cookies"], actors["b"]["cookies"], actors["admin"]["cookies"]
    a_page = _link(actors, "a", "5100000000062", name="Page A")
    _link(actors, "b", "5100000000063", name="Page B")
    a_rule = _rule(a, name="Rule A", publicReply="Thanks A")
    _rule(b, name="Rule B", publicReply="Thanks B", dmEnabled=True, dmText="DM B")
    _webhook(_fb_comment("5100000000062", "5100000000062_1", "9062", "hi"))
    _webhook(_fb_comment("5100000000063", "5100000000063_1", "9063", "hi"))
    graph.fail["/comments"] = meta_ads.MetaAdsError("request_failed", "Meta refused the reply.", provider_code="100")
    _webhook(_fb_comment("5100000000062", "5100000000062_2", "9064", "again"))
    log = client.get(f"{API}/log", cookies=a).json()
    assert [r["commentId"] for r in log["rows"]] == ["5100000000062_2", "5100000000062_1"]  # newest first
    sent, failed = log["rows"][1], log["rows"][0]
    assert sent["outcome"] == "sent" and sent["actions"] == ["public"] and sent["pageName"] == "Page A" and sent["ruleName"] == "Rule A"
    assert sent["pageId"] == a_page["id"] and sent["ruleId"] == a_rule["id"] and sent["source"] == "webhook"
    assert sent["receivedAt"] and sent["sentAt"] and isinstance(sent["latencySeconds"], int) and sent["latencySeconds"] >= 0
    assert failed["outcome"] == "failed" and failed["actions"] == [] and "Meta refused the reply. (100)" in failed["error"]
    assert failed["sentAt"] is None and failed["latencySeconds"] is None
    for row in log["rows"]:
        assert "fromId" not in row and "ownerId" not in row  # the commenter's id never leaves the row
    assert log["counters"]["total"] == 2 and log["counters"]["byAction"] == {"dm": 0, "public": 1, "like": 0}
    assert log["counters"]["byOutcome"]["sent"] == 1 and log["counters"]["byOutcome"]["failed"] == 1
    assert log["counters"]["latency"]["webhook"]["count"] == 1 and log["counters"]["latency"]["poll"] == {"count": 0, "p50Seconds": None, "p95Seconds": None}
    assert log["labels"]["outcome"]["failed"] == {"en": "Failed", "ar": "فشل"} and log["windowDays"] == 30
    # Owner B sees only B's row; a customer without the subscription gets 403; the admin sees everyone
    # (or one owner by ?ownerId=); an owner cannot read another owner.
    b_log = client.get(f"{API}/log", cookies=b).json()
    assert [r["commentId"] for r in b_log["rows"]] == ["5100000000063_1"] and b_log["rows"][0]["actions"] == ["dm", "public"]
    assert b_log["counters"]["byAction"]["dm"] == 1
    assert client.get(f"{API}/log", cookies=actors["c"]["cookies"]).status_code == 403
    assert len(client.get(f"{API}/log", cookies=admin).json()["rows"]) == 3
    assert [r["pageName"] for r in client.get(f"{API}/log?ownerId={actors['b']['id']}", cookies=admin).json()["rows"]] == ["Page B"]
    assert client.get(f"{API}/log?ownerId={actors['b']['id']}", cookies=a).status_code == 403
    # Filters and paging.
    assert [r["outcome"] for r in client.get(f"{API}/log?status=failed", cookies=a).json()["rows"]] == ["failed"]
    assert client.get(f"{API}/log?status=bogus", cookies=a).status_code == 400
    assert client.get(f"{API}/log?before=bogus", cookies=a).status_code == 400
    first = client.get(f"{API}/log?limit=1", cookies=a).json()
    assert len(first["rows"]) == 1 and first["nextBefore"]
    second = client.get(f"{API}/log?limit=1&before={first['nextBefore']}", cookies=a).json()
    assert [r["commentId"] for r in second["rows"]] == ["5100000000062_1"] and second["nextBefore"] is None
    assert second["counters"]["total"] == 2  # the counters cover the window, not the page


def test_reply_latency_recorded(actors, graph):
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000064")
    _rule(a, name="All", publicReply="Thanks")
    _webhook(_fb_comment("5100000000064", "5100000000064_1", "9065", "hi"))
    soon = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
    handled = studio.process_comment(platform="fb", entry_id="5100000000064", comment_id="5100000000064_2", post_ref="post_1",
                                     from_id="9066", text="hi", source="poll", comment_at=soon)
    assert handled["source"] == "poll" and handled["receivedAt"] and handled["sentAt"] and handled["actions"] == ["public"]
    rows = {r["commentId"]: r for r in client.get(f"{API}/log", cookies=a).json()["rows"]}
    assert rows["5100000000064_1"]["source"] == "webhook" and rows["5100000000064_2"]["source"] == "poll"
    assert all(isinstance(r["latencySeconds"], int) for r in rows.values())
    latency = studio.reply_latency_by_source(days=1)
    assert set(latency) == set(studio.COMMENT_SOURCES)
    assert latency["webhook"]["count"] == 1 and latency["poll"]["count"] == 1 and latency["manual_check"]["count"] == 0
    assert isinstance(latency["poll"]["p95Seconds"], int) and isinstance(latency["webhook"]["p50Seconds"], int)
    assert studio.reply_latency_by_source(days=1, owner_id=actors["b"]["id"])["webhook"]["count"] == 0
    assert studio._percentile([5, 1, 9, 3], 0.95) == 9 and studio._percentile([5, 1, 9, 3], 0.5) == 3 and studio._percentile([], 0.95) is None


def test_reply_actions_saved_as_they_succeed(actors, graph):
    """P4-02: each action lands on the log row when Meta accepts it, so a server killed mid-reply
    leaves the exact list behind and the rest of the rule is never replayed in full."""
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000065")
    _rule(a, name="All", publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)
    seen = []
    real_post = graph.post

    def watching_post(path, data, token):
        rows = _log_rows(actors["a"]["id"])
        seen.append((path.rsplit("/", 1)[-1], list(rows[0]["actions"]), bool(rows[0].get("sentAt"))))
        if path.endswith("/likes"):
            raise RuntimeError("the process died here")  # a non-Meta failure in the middle of the rule
        return real_post(path, data, token)

    graph.post = watching_post
    with pytest.raises(RuntimeError):
        studio.process_comment(platform="fb", entry_id="5100000000065", comment_id="5100000000065_1", post_ref="post_1",
                               from_id="9067", text="hi")
    # At the public reply the DM was already on the row; at the like both were.
    assert seen == [("messages", [], False), ("comments", ["dm"], True), ("likes", ["dm", "public"], True)]
    row = _log_rows(actors["a"]["id"])[0]
    assert row["actions"] == ["dm", "public"] and row["processing"] is False and row["error"] == "interrupted"
    assert not row.get("retryAfter") and row["sentAt"]
    graph.post = real_post
    studio._retry_pending_replies(datetime.now(timezone.utc) + timedelta(hours=1))
    assert [p for p, _d in graph.paths() if p.endswith("/messages")] == ["5100000000065/messages"]  # never resent


# ---------------------------------------------------------------------------
# P4-05: capability gates in the executor and the editor
# ---------------------------------------------------------------------------


def test_capability_gate_unarmed_sends_everything(actors, graph):
    """Before an admin saves the capabilities setting the gates are not armed: the classic Social
    Studio keeps sending every action a rule asks for (a dark deploy switches nothing off)."""
    assert studio.capability_gates() is None
    assert studio.channel_state(None, "fb", "dm") is None and studio.webhook_wanted("fb", None) is False
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000066")
    _rule(a, name="All", publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)
    _webhook(_fb_comment("5100000000066", "5100000000066_1", "9068", "hi"))
    assert [p for p, _d in graph.paths()] == ["5100000000066/messages", "5100000000066_1/comments", "5100000000066_1/likes"]
    assert "skipped" not in _log_rows(actors["a"]["id"])[0]


def test_capability_gate_holds_gated_actions_and_logs_the_reason(actors, graph):
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000067")
    _rule(a, name="All", publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)
    _arm({**ALL_ON, "fbPrivateReply": "gated"})
    assert studio.capability_gates()["fbPrivateReply"] == "gated"
    _webhook(_fb_comment("5100000000067", "5100000000067_1", "9069", "hi"))
    assert [p for p, _d in graph.paths()] == ["5100000000067_1/comments", "5100000000067_1/likes"]  # no private message
    row = _log_rows(actors["a"]["id"])[0]
    assert row["actions"] == ["public", "like"] and row["error"] == "" and "problemCode" not in row
    assert row["skipped"] == [{"action": "dm", "channel": "fbPrivateReply", "state": "gated"}]
    shown = client.get(f"{API}/log", cookies=a).json()
    assert shown["rows"][0]["outcome"] == "sent" and shown["rows"][0]["skipped"] == row["skipped"]
    assert shown["labels"]["channelState"]["gated"] == {"en": "Waiting for Meta approval", "ar": "بانتظار موافقة ميتا"}


def test_capability_gate_all_closed_never_reaches_meta(actors, graph):
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000068")
    _rule(a, name="All", publicReply="Thanks", dmEnabled=True, dmText="DM", likeComment=True)  # saved while open
    _arm({"fbPublicReply": "off", "fbPrivateReply": "unavailable", "igPublicReply": "off", "igPrivateReply": "off"})
    _webhook(_fb_comment("5100000000068", "5100000000068_1", "9070", "hi"))
    assert graph.calls == []  # not even a page token read
    row = _log_rows(actors["a"]["id"])[0]
    assert row["actions"] == [] and row["error"] == "" and row["processing"] is False and not row.get("retryAfter")
    assert [s["state"] for s in row["skipped"]] == ["unavailable", "off", "off"] and row["problemCode"] == "channel_unavailable"
    shown = client.get(f"{API}/log", cookies=a).json()
    assert shown["rows"][0]["outcome"] == "skipped" and shown["counters"]["byOutcome"]["skipped"] == 1
    assert shown["labels"]["problem"]["channel_off"] == {"en": "Switched off", "ar": "متوقف"}
    # The person is not "answered": a once-per-person rule may still reach them once the channel opens.
    assert studio._person_replied_rule_ids(actors["a"]["id"], _log_rows(actors["a"]["id"])[0]["pageId"], "9070") == set()


def test_capability_gate_poll_only_for_instagram_public(actors, graph):
    a = actors["a"]["cookies"]
    _link(actors, "a", "5100000000069", platform="ig", ig_user_id="17800000000069")
    _rule(a, name="IG", platform="ig", publicReply="Replied on IG", dmEnabled=True, dmText="IG private")
    _arm({"igPublicReply": "poll", "igPrivateReply": "gated", "fbPublicReply": "on", "fbPrivateReply": "on"})
    _webhook({"object": "instagram", "entry": [{"id": "17800000000069", "changes": [{"field": "comments", "value": {
        "id": "17900000000069", "media": {"id": "17950000000069"}, "from": {"id": "9071", "username": "buyer"}, "text": "price?",
    }}]}]})
    assert graph.paths() == [("17900000000069/replies", {"message": "Replied on IG"})]
    row = _log_rows(actors["a"]["id"])[0]
    assert row["actions"] == ["public"] and row["skipped"] == [{"action": "dm", "channel": "igPrivateReply", "state": "gated"}]
    # poll never opens a Facebook channel (studio_settings refuses it there anyway).
    assert studio.channel_state({"fbPublicReply": "poll"}, "fb", "public") == "gated"
    assert studio.channel_state({"igPublicReply": "poll"}, "ig", "public") is None
    assert studio.channel_state({"igPublicReply": "on"}, "ig", "like") is None  # no such action on Instagram
    assert studio.channel_state({}, "fb", "dm") == "unavailable"  # armed but unknown: closed


def test_capability_gate_editor_refuses_actions_the_channel_cannot_do(actors):
    a = actors["a"]["cookies"]
    _arm({"fbPrivateReply": "unavailable", "fbPublicReply": "off", "igPublicReply": "gated", "igPrivateReply": "on"})
    refused = client.post(f"{API}/rules", json={"name": "DM", "platform": "fb", "dmEnabled": True, "dmText": "hi"}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Private messages are not available for Facebook pages right now"
    refused = client.post(f"{API}/rules", json={"name": "Public", "platform": "fb", "publicReply": "hi"}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Public replies are not available for Facebook pages right now"
    # Gated (waiting for Meta) is saved and shown as waiting; an open channel is saved.
    waiting = _rule(a, name="IG public", platform="ig", publicReply="hi")
    assert waiting["publicReply"] == "hi"
    open_dm = _rule(a, name="IG dm", platform="ig", dmEnabled=True, dmText="hi")
    assert open_dm["dmEnabled"] is True
    # A like follows the public-reply switch.
    _arm({"fbPrivateReply": "on", "fbPublicReply": "off"})
    refused = client.post(f"{API}/rules", json={"name": "Like", "platform": "fb", "dmEnabled": True, "dmText": "hi", "likeComment": True}, cookies=a)
    assert refused.status_code == 400 and refused.json()["detail"] == "Likes are not available for Facebook pages right now"
    saved = _rule(a, name="DM only", platform="fb", publicReply="", dmEnabled=True, dmText="hi")
    refused = client.patch(f"{API}/rules/{saved['id']}", json={"publicReply": "now public"}, cookies=a)
    assert refused.status_code == 400 and "Public replies are not available" in refused.json()["detail"]
    # Unarmed again: everything may be saved.
    _disarm()
    assert _rule(a, name="Any", platform="fb", publicReply="hi", dmEnabled=True, dmText="x", likeComment=True)["likeComment"] is True
    assert client.get(f"{API}/rules", cookies=a).json()["channels"]["states"] == {}
