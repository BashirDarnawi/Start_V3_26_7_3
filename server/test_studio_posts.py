"""Goal, Libya locations and the linked-page post picker (Albayan Studio plan tasks P1-14, P1-13 as changed by D19).

* P1-14: goalDetail sets or must match the objective (T9), resultType map, locationKeys are Libya
  chips (T10).
* D19 / P1-13: GET /api/studio/pages and /pages/{id}/recent-posts are owner-scoped (T12), read
  Meta through the platform door once per 10 minutes, and turn a Meta pause or error into a
  retry code, never a 500. Submit accepts a picked post of the owner's linked page, the post
  link fallback, or the customer's own photo and text; T11 and T13 otherwise.

Every Meta call is faked (MetaAdsClient._request is replaced); nothing here reaches the network.
"""

import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.meta_ads as meta_ads
from server import main
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import ad_campaign_fields, studio_posts
from server.systems.ads_studio.ad_campaign_fields import (
    AD_CAMPAIGN_GOAL_DETAILS,
    AD_CAMPAIGN_OBJECTIVES,
    LIBYA_LOCATIONS,
    ad_campaign_result_type,
)

TAG = secrets.token_hex(4)
PASSWORD = "StudioPostsPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
TYPES = ("socialPages", "metaProviderState")
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
# The shared refusal prefixes (the screens' Arabic map matches these exact texts).
T9 = "The goal detail does not match the objective"
T10 = "Unknown location"
T11 = "Choose a post or add your own photo and text"
T12 = "This page is not linked to your account"
T13 = "This post is not from your linked page"
PAGE_A, PAGE_A2, PAGE_B = "6100000000001", "6100000000002", "6100000000003"
IG_A = "17841400000000077"
POST_FIELDS = {"id", "platform", "excerpt", "imageUrl", "permalink", "createdAt"}


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def _login(email: str) -> dict:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _insert_admin() -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("posts_admin")
    email = f"studio-posts-admin-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,'Posts Admin',:email,'Admin',:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "email": email, "permissions": json_dumps({}), "hash": password_hash.hash_hex,
             "salt": password_hash.salt_hex, "algo": password_hash.algo, "iterations": password_hash.iterations,
             "stamp": stamp},
        )
    return {"id": user_id, "cookies": _login(email)}


def _create_user(admin: dict, label: str, permissions: dict, *, subscribe: bool, fund_minor: int = 0) -> dict:
    email = f"studio-posts-{label}-{TAG}@tests.albayanhub.com"
    created = client.post(
        "/api/users",
        json={"name": f"Posts {label}", "email": email, "password": PASSWORD, "role": "Employee",
              "permissions": permissions},
        cookies=admin["cookies"],
    )
    assert created.status_code == 200, created.text
    user = {"id": created.json()["id"], "cookies": _login(email)}
    if subscribe:
        bought = client.post(
            "/api/subscriptions/purchase",
            json={"serviceId": "ad_maker", "idempotencyKey": f"studio-posts-sub-{label}-{TAG}"},
            cookies=user["cookies"],
        )
        assert bought.status_code == 200, bought.text
    if fund_minor:
        funded = client.post(
            "/api/wallet/top-ups",
            json={"userId": user["id"], "amountMinor": fund_minor, "currency": "USD",
                  "idempotencyKey": f"studio-posts-fund-{label}-{TAG}", "memo": "Studio posts test funding"},
            cookies=admin["cookies"],
        )
        assert funded.status_code == 200, funded.text
    return user


def _set_intake_cap(admin: dict, cap: int) -> int:
    """Raise the daily submission cap (P1-22) for this module; returns the value it had."""
    current = client.get("/api/studio/admin/settings/intake", cookies=admin["cookies"])
    assert current.status_code == 200, current.text
    record = current.json()
    saved = client.put(
        "/api/studio/admin/settings/intake",
        json={"expectedVersion": record["version"], "value": {**record["value"], "maxSubmissionsPerDay": cap}},
        cookies=admin["cookies"],
    )
    assert saved.status_code == 200, saved.text
    return int(record["value"]["maxSubmissionsPerDay"])


@pytest.fixture(scope="module")
def actors():
    init_db()
    admin = _insert_admin()
    actors = {
        "admin": admin,
        "owner": _create_user(admin, "owner", CUSTOMER_PERMISSIONS, subscribe=True, fund_minor=1_000_000),
        "other": _create_user(admin, "other", CUSTOMER_PERMISSIONS, subscribe=True, fund_minor=1_000_000),
        "reviewer": _create_user(admin, "reviewer", {CAMPAIGNS: ["view", "review"]}, subscribe=False),
    }
    previous_cap = _set_intake_cap(admin, 500)
    yield actors
    _set_intake_cap(admin, previous_cap)


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
    """Answers MetaAdsClient._request by (method, path); records every call."""

    def __init__(self):
        self.calls = []
        self.routes = {}

    def request(self, method, path, *, params=None, data=None, access_token=None, use_headroom=False):
        self.calls.append((method, path, dict(params or {}), access_token))
        answer = self.routes.get((method, path))
        if answer is None:
            raise AssertionError(f"unexpected Graph {method} {path}")
        if isinstance(answer, Exception):
            raise answer
        return answer(params) if callable(answer) else answer

    def paths(self):
        return [path for _method, path, _params, _token in self.calls]


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request", lambda self, method, path, **kw: fake.request(method, path, **kw))
    for page in (PAGE_A, PAGE_A2, PAGE_B):
        fake.routes[("GET", page)] = {"id": page, "access_token": f"PAGE-TOKEN-{page}"}
    return fake


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(studio_posts, "_clock", fake)
    return fake


@pytest.fixture(autouse=True)
def _clean(actors, monkeypatch):
    saved = {entity_type: _rows_of(entity_type) for entity_type in TYPES}
    for entity_type in TYPES:
        _replace_rows(entity_type, [])
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-never-leaks")
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    for name in ("_META_REMOTE_BACKOFF_REASON", "_META_REMOTE_USAGE_PERCENT"):
        monkeypatch.setattr(meta_ads, name, getattr(meta_ads, name))
    monkeypatch.setattr(meta_ads, "_META_PROVIDER_STATE_REFRESHED_AT", 0.0)
    meta_ads._PAGE_TOKEN_CACHE.clear()
    studio_posts.clear_cache()
    for user in actors.values():
        for bucket in ("linked-pages", "recent-posts"):
            reset_rate_limit(f"studio:{bucket}:{user['id']}")
        reset_rate_limit(f"ad-studio:mutations:{user['id']}")
    yield
    meta_ads._PAGE_TOKEN_CACHE.clear()
    studio_posts.clear_cache()
    for entity_type, rows in saved.items():
        _replace_rows(entity_type, rows)


def _page(owner: dict, row_id: str, meta_page_id: str, platform: str = "fb", ig_user_id: str = "", *,
          name: str = "", deleted: bool = False, owner_field: str | None = None, created_at: int | None = None) -> str:
    stamp = created_at or now_ms()
    data = {
        "id": row_id, "_created": stamp, "_lastModified": stamp, "_deleted": deleted,
        "ownerId": owner_field if owner_field is not None else owner["id"], "metaPageId": meta_page_id,
        "platform": platform, "igUserId": ig_user_id, "name": name or f"Page {meta_page_id}", "healthy": True,
    }
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES ('socialPages',:id,:data,:deleted,:stamp,:owner,:stamp)"
            ),
            {"id": row_id, "data": json_dumps(data), "deleted": deleted, "stamp": stamp, "owner": owner["id"]},
        )
    return row_id


def _link_owner_pages(actors) -> dict:
    """Owner: page A on Facebook and Instagram, page A2 on Facebook. Other: page B on Facebook."""
    base = now_ms()
    return {
        "a_fb": _page(actors["owner"], f"spg_a_fb_{TAG}", PAGE_A, name="Owner Shop", created_at=base),
        "a_ig": _page(actors["owner"], f"spg_a_ig_{TAG}", PAGE_A, "ig", IG_A, name="ownershop", created_at=base + 1),
        "a2_fb": _page(actors["owner"], f"spg_a2_fb_{TAG}", PAGE_A2, name="Owner Second", created_at=base + 2),
        "b_fb": _page(actors["other"], f"spg_b_fb_{TAG}", PAGE_B, name="Other Shop", created_at=base + 3),
    }


def _fb_posts(count: int = 3, page: str = PAGE_A):
    rows = []
    for index in range(count):
        rows.append({
            "id": f"{page}_{900 + index}",
            "message": f"Offer number {index} " + ("very long text " * 20 if index == 0 else ""),
            "created_time": f"2026-09-2{index % 5}T10:00:00+0000",
            "permalink_url": f"https://www.facebook.com/ownershop/posts/{900 + index}",
            "full_picture": f"https://scontent.xx.fbcdn.net/v/p{index}.jpg",
        })
    return {"data": rows}


def _ig_media():
    return {"data": [
        {"id": "18000000000000001", "caption": "New arrivals", "media_type": "IMAGE",
         "media_url": "https://scontent.cdninstagram.com/i1.jpg", "permalink": "https://www.instagram.com/p/AAA1/",
         "timestamp": "2026-09-24T09:00:00+0000"},
        {"id": "18000000000000002", "caption": "A short video", "media_type": "VIDEO",
         "media_url": "https://video.cdninstagram.com/v2.mp4", "thumbnail_url": "https://scontent.cdninstagram.com/t2.jpg",
         "permalink": "https://www.instagram.com/reel/BBB2/", "timestamp": "2026-09-25T09:00:00+0000"},
    ]}


def _route_page_a(graph) -> None:
    graph.routes[("GET", f"{PAGE_A}/posts")] = _fb_posts()
    graph.routes[("GET", f"{IG_A}/media")] = _ig_media()


def _recent(actors, who: str, page_id: str, *, refresh: bool = False):
    suffix = "?refresh=1" if refresh else ""
    return client.get(f"/api/studio/pages/{page_id}/recent-posts{suffix}", cookies=actors[who]["cookies"])


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code and detail["message"], detail
    return detail


def _prepare(data: dict, **kwargs) -> dict:
    return main._prepare_ad_campaign_fields(data, **kwargs)


def _boost(name: str, **extra) -> dict:
    """A quick-boost request: no objective, text, button, link or photo of its own."""
    return {
        "name": name, "boostType": "boost_post", "platforms": ["facebook"], "pageName": "Owner Shop",
        "locationKeys": ["tripoli", "benghazi"], "startDate": "2027-01-10", "endDate": "2027-01-20",
        "durationDays": 11, "budgetMinorUSD": 2500, "budgetType": "lifetime", **extra,
    }


def _create(user: dict, data: dict) -> dict:
    campaign_id = new_id("campaign")
    created = client.post("/api/collections/adCampaignRequests", json={"id": campaign_id, "data": data},
                          cookies=user["cookies"])
    assert created.status_code == 200, created.text
    return created.json()


def _patch(user: dict, entity: dict, data: dict):
    return client.patch(
        f"/api/collections/{CAMPAIGNS}/{entity['id']}",
        json={"data": data, "expectedLastModified": entity["lastModified"]},
        cookies=user["cookies"],
    )


def _submit(user: dict, entity: dict):
    return client.post(
        f"/api/ad-studio/campaigns/{entity['id']}/submit",
        json={"expectedLastModified": entity["lastModified"], "operationId": f"posts-submit-{new_id('op')}"},
        cookies=user["cookies"],
    )


def _approve(actors, entity: dict):
    return client.post(
        f"/api/ad-studio/campaigns/{entity['id']}/review",
        json={"expectedLastModified": entity["lastModified"], "decision": "Approved", "note": "",
              "operationId": f"posts-approve-{new_id('op')}"},
        cookies=actors["reviewer"]["cookies"],
    )


# ---------------------------------------------------------------------------
# P1-14: goalDetail, objective consistency (T9), resultType map, Libya locations (T10)
# ---------------------------------------------------------------------------


def test_goal_detail_objective_consistency():
    assert _prepare({"goalDetail": "page_likes"}, strict=False) == {"goalDetail": "page_likes", "objective": "engagement"}
    assert _prepare({"goalDetail": "Website Visits"}, strict=False)["objective"] == "traffic"
    assert _prepare({"goalDetail": "leads", "objective": "leads"}, strict=False)["objective"] == "leads"
    assert _prepare({"goalDetail": "", "objective": "sales"}, strict=False) == {"goalDetail": "", "objective": "sales"}
    with pytest.raises(HTTPException) as mismatch:
        _prepare({"goalDetail": "page_likes", "objective": "messages"}, strict=False)
    assert mismatch.value.status_code == 400 and mismatch.value.detail.startswith(T9)
    with pytest.raises(HTTPException) as unknown:
        _prepare({"goalDetail": "followers"}, strict=False)
    assert unknown.value.status_code == 400 and "goalDetail must be one of" in unknown.value.detail
    # Every goal runs under one of the 7 objectives and has a main result; objectives map too.
    for goal, (objective, result_type) in AD_CAMPAIGN_GOAL_DETAILS.items():
        assert objective in AD_CAMPAIGN_OBJECTIVES and result_type
        assert ad_campaign_result_type(goal, "awareness") == result_type  # the goal wins over the objective
    assert set(ad_campaign_fields.AD_CAMPAIGN_OBJECTIVE_RESULT_TYPES) == set(AD_CAMPAIGN_OBJECTIVES)
    assert ad_campaign_result_type("", "traffic") == "link_clicks"
    assert ad_campaign_result_type("video_views") == "video_views"
    assert ad_campaign_result_type("", "") == ""


def test_goal_detail_mismatch_refused_at_submit_too(actors):
    # A classic client can change the objective without knowing the goal; submit catches it.
    entity = _create(actors["owner"], {**_boost("Goal mismatch"), "boostType": "", "goalDetail": "messages",
                                       "sourcePostRef": "", "primaryText": "Write to us", "callToAction": "Send Message",
                                       "destination": "https://m.me/ownershop", "creativeImages": [main_png()]})
    changed = _patch(actors["owner"], entity, {"objective": "sales"})
    assert changed.status_code == 200, changed.text
    refused = _submit(actors["owner"], changed.json())
    assert refused.status_code == 400 and refused.json()["detail"].startswith(T9), refused.text


def test_location_keys_are_libya_chips():
    clean = _prepare({"locationKeys": ["Tripoli", "طرابلس", "Misurata", "Al-Bayda", "بني وليد", "zawiya"]}, strict=False)
    assert clean["locationKeys"] == ["tripoli", "misrata", "bayda", "bani_walid", "zawiya"]
    assert _prepare({"locationKeys": None}, strict=False)["locationKeys"] == []
    for bad, needle in (
        (["tripoli", "Paris"], T10),
        ("tripoli", "must be a list"),
        (["tripoli", 5], "must contain only text"),
        ([f"city{i}" for i in range(26)], "at most 25"),
        (["libya", "tripoli"], "cannot combine all of Libya"),
    ):
        with pytest.raises(HTTPException) as refused:
            _prepare({"locationKeys": bad}, strict=False)
        assert refused.value.status_code == 400 and needle in refused.value.detail, (bad, refused.value.detail)
    with pytest.raises(HTTPException) as unknown:
        _prepare({"locationKeys": ["Atlantis"]}, strict=False)
    assert unknown.value.detail == f"{T10}: Atlantis"
    assert all(key == key.lower() and " " not in key for key in LIBYA_LOCATIONS)


def test_source_post_fields_are_shape_checked():
    fb_post = f"{PAGE_A}_901"
    assert _prepare({"sourcePostId": fb_post, "sourcePostPlatform": "FB"}, strict=False) == {
        "sourcePostId": fb_post, "sourcePostPlatform": "fb"}
    assert _prepare({"sourcePostId": "18000000000000001", "sourcePostPlatform": "ig"}, strict=False)["sourcePostId"]
    assert _prepare({"sourcePostId": fb_post}, strict=False) == {"sourcePostId": fb_post}  # platform saved earlier
    for bad in (
        {"sourcePostId": fb_post, "sourcePostPlatform": "ig"},
        {"sourcePostId": "18000000000000001", "sourcePostPlatform": "fb"},
        {"sourcePostId": "../../x"},
        {"sourcePostPlatform": "tiktok"},
    ):
        with pytest.raises(HTTPException) as refused:
            _prepare(bad, strict=False)
        assert refused.value.status_code == 400, bad


def test_patch_accepts_the_new_fields_and_still_refuses_unknown_ones(actors):
    entity = _create(actors["owner"], {"name": "Patch new fields"})
    patched = _patch(actors["owner"], entity, {
        "goalDetail": "post_engagement", "locationKeys": ["Tripoli", "بنغازي"],
        "sourcePostId": f"{PAGE_A}_901", "sourcePostPlatform": "fb",
    })
    assert patched.status_code == 200, patched.text
    data = patched.json()["data"]
    assert data["goalDetail"] == "post_engagement" and data["objective"] == "engagement"
    assert data["locationKeys"] == ["tripoli", "benghazi"]
    assert data["sourcePostId"] == f"{PAGE_A}_901" and data["sourcePostPlatform"] == "fb"
    # A later edit of another field keeps them (PATCH merges).
    renamed = _patch(actors["owner"], patched.json(), {"name": "Patch new fields, renamed"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["data"]["locationKeys"] == ["tripoli", "benghazi"]
    assert renamed.json()["data"]["goalDetail"] == "post_engagement"
    for bad in ({"resultType": "reach"}, {"locationKeys": ["Cairo"]}, {"goalDetail": "sales", "objective": "leads"}):
        refused = _patch(actors["owner"], renamed.json(), bad)
        assert refused.status_code == 400, (bad, refused.text)


# ---------------------------------------------------------------------------
# GET /api/studio/pages and /pages/{id}/recent-posts (D19)
# ---------------------------------------------------------------------------


def test_pages_are_owner_scoped_and_grouped_per_meta_page(actors):
    pages = _link_owner_pages(actors)
    _page(actors["owner"], f"spg_gone_{TAG}", "6100000000009", deleted=True)  # unlinked
    _page(actors["owner"], f"spg_forged_{TAG}", "6100000000008", owner_field=actors["other"]["id"])  # fields disagree
    mine = client.get("/api/studio/pages", cookies=actors["owner"]["cookies"])
    assert mine.status_code == 200, mine.text
    assert mine.json() == {"pages": [
        {"id": pages["a_fb"], "name": "Owner Shop", "hasFacebook": True, "hasInstagram": True, "healthy": True},
        {"id": pages["a2_fb"], "name": "Owner Second", "hasFacebook": True, "hasInstagram": False, "healthy": True},
    ]}
    theirs = client.get("/api/studio/pages", cookies=actors["other"]["cookies"]).json()["pages"]
    assert [page["id"] for page in theirs] == [pages["b_fb"]]
    assert client.get("/api/studio/pages", cookies=actors["reviewer"]["cookies"]).json() == {"pages": []}
    assert client.get("/api/studio/pages").status_code == 401


def test_recent_posts_of_another_customers_page_is_404(actors, graph):
    pages = _link_owner_pages(actors)
    for page_id in (pages["b_fb"], "spg_does_not_exist", "bad id!", f"spg_gone_{TAG}"):
        detail = _error(_recent(actors, "owner", page_id), 404, "UNKNOWN_PAGE")
        assert detail["message"] == T12
    _error(_recent(actors, "other", pages["a_ig"]), 404, "UNKNOWN_PAGE")
    assert graph.calls == []  # nothing is read from Meta for a page that is not the caller's


def test_recent_posts_shapes_rows_and_reads_meta_once_per_ten_minutes(actors, graph, clock):
    pages = _link_owner_pages(actors)
    graph.routes[("GET", f"{PAGE_A}/posts")] = lambda params: {"data": _fb_posts(12)["data"] + [
        {"id": f"{PAGE_B}_1", "message": "someone else's page"},
        {"id": "not-a-post", "message": "broken"},
    ]}
    graph.routes[("GET", f"{IG_A}/media")] = _ig_media()
    first = _recent(actors, "owner", pages["a_ig"])  # any row of the page reads both platforms
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["pageId"] == pages["a_fb"]
    assert body["platforms"]["fb"]["state"] == "ok" and body["platforms"]["ig"]["state"] == "ok"
    posts = body["posts"]
    fb = [post for post in posts if post["platform"] == "fb"]
    ig = [post for post in posts if post["platform"] == "ig"]
    assert len(fb) == studio_posts.POSTS_PER_PLATFORM and len(ig) == 2
    assert all(set(post) == POST_FIELDS for post in posts)
    assert all(post["id"].startswith(f"{PAGE_A}_") for post in fb)
    assert all(len(post["excerpt"]) <= 140 for post in posts)
    assert fb[0]["excerpt"].endswith("…") or any(post["excerpt"].endswith("…") for post in fb)
    assert [post["createdAt"] for post in posts] == sorted((post["createdAt"] for post in posts), reverse=True)
    video = next(post for post in ig if post["id"] == "18000000000000002")
    assert video["imageUrl"] == "https://scontent.cdninstagram.com/t2.jpg"
    assert video["permalink"] == "https://www.instagram.com/reel/BBB2/" and video["createdAt"] == "2026-09-25T09:00:00Z"
    assert body["checkedAt"]
    # Graph: the page token once, then posts and media with the PAGE token (never the system token).
    assert graph.paths() == [PAGE_A, f"{PAGE_A}/posts", f"{IG_A}/media"]
    assert {token for _m, path, _p, token in graph.calls if path != PAGE_A} == {f"PAGE-TOKEN-{PAGE_A}"}
    assert "system-token-never-leaks" not in first.text and "PAGE-TOKEN" not in first.text

    assert _recent(actors, "owner", pages["a_fb"]).json()["posts"] == posts
    clock.now += 30
    assert _recent(actors, "owner", pages["a_fb"], refresh=True).status_code == 200  # refresh inside a minute: kept list
    assert len(graph.calls) == 3
    clock.now += 31
    assert _recent(actors, "owner", pages["a_fb"], refresh=True).status_code == 200  # refresh after a minute: read again
    assert graph.paths()[3:] == [f"{PAGE_A}/posts", f"{IG_A}/media"]  # the page token is still in memory
    clock.now += 9 * 60
    _recent(actors, "owner", pages["a_fb"])
    assert len(graph.calls) == 5  # still inside ten minutes of the last read
    clock.now += 61
    _recent(actors, "owner", pages["a_fb"])
    assert len(graph.calls) == 7  # ten minutes passed: read again


def test_facebook_only_page_reads_only_facebook(actors, graph):
    pages = _link_owner_pages(actors)
    graph.routes[("GET", f"{PAGE_A2}/posts")] = _fb_posts(2, PAGE_A2)
    body = _recent(actors, "owner", pages["a2_fb"]).json()
    assert set(body["platforms"]) == {"fb"} and len(body["posts"]) == 2
    assert graph.paths() == [PAGE_A2, f"{PAGE_A2}/posts"]


def test_meta_pause_gives_a_retry_code_or_the_kept_list(actors, graph, clock, monkeypatch):
    pages = _link_owner_pages(actors)
    _route_page_a(graph)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", time.monotonic() + 120)
    paused = _recent(actors, "owner", pages["a_fb"])
    _error(paused, 409, "META_PAUSED")
    assert 100 <= int(paused.headers["Retry-After"]) <= 121
    assert graph.calls == []  # nothing reached Meta while Albayan's pause runs

    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    fresh = _recent(actors, "owner", pages["a_fb"]).json()
    clock.now += 11 * 60  # the kept list is now too old to be shown as fresh
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", time.monotonic() + 90)
    kept = _recent(actors, "owner", pages["a_fb"])
    assert kept.status_code == 200, kept.text
    body = kept.json()
    assert body["posts"] == fresh["posts"] and body["checkedAt"] == fresh["checkedAt"]
    assert {part["state"] for part in body["platforms"].values()} == {"paused"}
    assert all(part["retryAfterSeconds"] > 0 for part in body["platforms"].values())


def test_meta_errors_never_give_a_500(actors, graph, monkeypatch):
    pages = _link_owner_pages(actors)
    graph.routes[("GET", f"{PAGE_A}/posts")] = meta_ads.MetaAdsError(
        "authorization", "Meta authorization failed. Reconnect the access token.", provider_code="190")
    graph.routes[("GET", f"{IG_A}/media")] = meta_ads.MetaAdsError(
        "temporary", "Meta is temporarily unavailable. Albayan will retry.", retryable=True, provider_code="2")
    mixed = _recent(actors, "owner", pages["a_fb"])
    assert mixed.status_code == 200, mixed.text
    body = mixed.json()
    assert body["posts"] == [] and body["checkedAt"] == ""
    assert body["platforms"]["fb"] == {"state": "error", "checkedAt": "", "errorCode": "page_access", "retryAfterSeconds": 0}
    assert body["platforms"]["ig"]["state"] == "paused" and body["platforms"]["ig"]["retryAfterSeconds"] > 0

    graph.routes[("GET", f"{PAGE_A}/posts")] = meta_ads.MetaAdsError(
        "rate_limited", "Meta is temporarily limiting synchronization. Albayan will retry.", retryable=True,
        provider_code="80001")
    all_busy = _recent(actors, "owner", pages["a_fb"])
    _error(all_busy, 409, "META_PAUSED")
    assert int(all_busy.headers["Retry-After"]) > 0

    graph.routes[("GET", f"{PAGE_A}/posts")] = RuntimeError("never raised by the platform door")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    _error(_recent(actors, "owner", pages["a_fb"]), 409, "META_NOT_CONFIGURED")


def test_recent_posts_are_rate_limited_per_user(actors, graph):
    pages = _link_owner_pages(actors)
    _route_page_a(graph)
    for _ in range(studio_posts.POSTS_READS_PER_MINUTE):
        assert _recent(actors, "owner", pages["a_fb"]).status_code == 200
    limited = _recent(actors, "owner", pages["a_fb"])
    _error(limited, 429, "RATE_LIMITED")
    assert int(limited.headers["Retry-After"]) >= 1
    assert len(graph.calls) == 3  # one Meta read; the rest came from the kept list


def test_ad_options_lists_goals_and_locations(actors):
    body = client.get("/api/studio/ad-options", cookies=actors["owner"]["cookies"]).json()
    assert [goal["key"] for goal in body["goals"]] == list(AD_CAMPAIGN_GOAL_DETAILS)
    assert all(goal["labelEn"] and goal["labelAr"] and goal["objective"] in AD_CAMPAIGN_OBJECTIVES for goal in body["goals"])
    assert {location["key"] for location in body["locations"]} == set(LIBYA_LOCATIONS)
    assert next(loc for loc in body["locations"] if loc["key"] == "tripoli")["labelAr"] == "طرابلس"


def test_platform_door_readers_clean_meta_rows(actors, graph):
    graph.routes[("GET", f"{PAGE_A}/posts")] = {"data": [
        {"id": f"{PAGE_A}_1", "message": "  hello \n  world <b>", "full_picture": "http://insecure.example/x.jpg",
         "permalink_url": "https://www.facebook.com/p/1", "created_time": "2026-09-20T10:00:00+0000"},
        {"id": f"{PAGE_B}_2", "message": "other page"},
    ]}
    rows = meta_ads.read_page_recent_posts(PAGE_A, limit=500)
    assert rows == [{"id": f"{PAGE_A}_1", "text": "hello world b", "imageUrl": "",
                     "permalink": "https://www.facebook.com/p/1", "createdAt": "2026-09-20T10:00:00Z"}]
    assert graph.calls[-1][2]["limit"] == meta_ads.PAGE_RECENT_POSTS_MAX
    with pytest.raises(meta_ads.MetaAdsError):
        meta_ads.read_instagram_recent_media(PAGE_A, "not-digits")


# ---------------------------------------------------------------------------
# Submit rules for the post a request boosts (P1-13 as changed by D19; T11, T13)
# ---------------------------------------------------------------------------


def main_png() -> str:
    return (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
    )


def test_boost_post_link_only_submits(actors):
    entity = _create(actors["owner"], _boost("Link only boost", sourcePostRef="https://www.facebook.com/ownershop/posts/1"))
    submitted = _submit(actors["owner"], entity)
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["data"]["status"] == "Submitted"


def test_boost_without_a_post_or_own_creative_is_t11(actors):
    no_post = _create(actors["owner"], _boost("Boost without post"))
    refused = _submit(actors["owner"], no_post)
    assert refused.status_code == 400 and refused.json()["detail"].startswith(T11), refused.text
    assert "sourcePostRef" in refused.json()["detail"]
    grow = _create(actors["owner"], _boost("Grow page without photo", boostType="boost_page", primaryText="Visit us"))
    refused = _submit(actors["owner"], grow)
    assert refused.status_code == 400 and refused.json()["detail"].startswith(T11), refused.text
    own = _create(actors["owner"], _boost("Grow page with photo", boostType="boost_page", primaryText="Visit us",
                                          objective="engagement", callToAction="Learn More",
                                          destination="https://www.facebook.com/ownershop", creativeImages=[main_png()]))
    assert _submit(actors["owner"], own).status_code == 200


def test_picked_facebook_post_must_be_from_a_linked_page(actors, graph):
    pages = _link_owner_pages(actors)
    mine = _create(actors["owner"], _boost("Picked FB post", connectedAssetId=pages["a_fb"],
                                           sourcePostId=f"{PAGE_A2}_901", sourcePostPlatform="fb"))
    submitted = _submit(actors["owner"], mine)
    assert submitted.status_code == 200, submitted.text
    approved = _approve(actors, submitted.json())
    assert approved.status_code == 200, approved.text
    assert graph.calls == []  # a Facebook post id carries its page id: no Meta read needed

    theirs = _create(actors["owner"], _boost("Other customer's post", sourcePostId=f"{PAGE_B}_5", sourcePostPlatform="fb"))
    refused = _submit(actors["owner"], theirs)
    assert refused.status_code == 400 and refused.json()["detail"] == T13, refused.text
    # The other customer cannot boost the owner's post either.
    stolen = _create(actors["other"], _boost("Stolen post", sourcePostId=f"{PAGE_A}_901", sourcePostPlatform="fb"))
    refused = _submit(actors["other"], stolen)
    assert refused.status_code == 400 and refused.json()["detail"] == T13, refused.text


def test_page_unlinked_before_approval_refuses_the_approval(actors, graph):
    pages = _link_owner_pages(actors)
    entity = _create(actors["owner"], _boost("Unlinked before approval", sourcePostId=f"{PAGE_A2}_7", sourcePostPlatform="fb"))
    submitted = _submit(actors["owner"], entity)
    assert submitted.status_code == 200, submitted.text
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted=true WHERE type='socialPages' AND id=:id"), {"id": pages["a2_fb"]})
    refused = _approve(actors, submitted.json())
    assert refused.status_code == 400 and refused.json()["detail"] == T13, refused.text


def test_picked_instagram_media_is_checked_against_the_lists(actors, graph, monkeypatch):
    pages = _link_owner_pages(actors)
    _route_page_a(graph)
    assert _recent(actors, "owner", pages["a_ig"]).status_code == 200
    calls_after_list = len(graph.calls)
    listed = _create(actors["owner"], _boost("Picked IG media", platforms=["instagram"],
                                             sourcePostId="18000000000000002", sourcePostPlatform="ig"))
    submitted = _submit(actors["owner"], listed)
    assert submitted.status_code == 200, submitted.text
    assert len(graph.calls) == calls_after_list  # found in the kept list: Meta is not asked again

    # Not in any kept list: submit reads the account's list once more (found -> accepted).
    studio_posts.clear_cache()
    fresh = _create(actors["owner"], _boost("IG media read at submit", platforms=["instagram"],
                                            sourcePostId="18000000000000001", sourcePostPlatform="ig"))
    ok = _submit(actors["owner"], fresh)
    assert ok.status_code == 200, ok.text
    assert graph.paths()[calls_after_list:] == [f"{IG_A}/media"]

    # Approval does not ask Meta again (the post was checked at submit).
    studio_posts.clear_cache()
    before = len(graph.calls)
    assert _approve(actors, ok.json()).status_code == 200
    assert len(graph.calls) == before

    unknown = _create(actors["owner"], _boost("Unknown IG media", platforms=["instagram"],
                                              sourcePostId="18999999999999999", sourcePostPlatform="ig"))
    studio_posts.clear_cache()
    refused = _submit(actors["owner"], unknown)
    assert refused.status_code == 400 and refused.json()["detail"] == T13, refused.text

    studio_posts.clear_cache()
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", time.monotonic() + 60)
    busy = _submit(actors["owner"], unknown)
    assert busy.status_code == 503 and int(busy.headers["Retry-After"]) > 0, busy.text

    # A customer without a linked Instagram account cannot name Instagram media at all.
    other_media = _create(actors["other"], _boost("IG without account", platforms=["instagram"],
                                                  sourcePostId="18000000000000001", sourcePostPlatform="ig"))
    refused = _submit(actors["other"], other_media)
    assert refused.status_code == 400 and refused.json()["detail"] == T13, refused.text


def test_stored_row_createdby_decides_the_owner(actors, graph):
    """The strict check uses the stored request's owner, so a staff approval checks the customer's pages."""
    _link_owner_pages(actors)
    clean = {"boostType": "boost_post", "sourcePostId": f"{PAGE_A}_1", "sourcePostPlatform": "fb"}
    assert studio_posts.enforce_source_post_rules(clean, {"createdBy": actors["owner"]["id"], "status": "Submitted"}) is True
    for owner in (actors["other"]["id"], "", "system"):
        with pytest.raises(HTTPException) as refused:
            studio_posts.enforce_source_post_rules(clean, {"createdBy": owner, "status": "Draft"})
        assert refused.value.detail == T13
    assert studio_posts.enforce_source_post_rules({"boostType": ""}, {}) is False
