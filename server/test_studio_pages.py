"""Page health (Albayan Studio plan task P4-03) and the Social Studio anonymisation scrub (P5-04).

Every Meta call is faked (MetaAdsClient._request and page_access_token are replaced; the studio's
token check is stubbed); nothing here reaches the network. The fixtures of test_social_studio.py
(actors, the autouse _fresh: env, wiped rows, gates not armed) are reused; each test arms the
capability gates it needs. Run with: PYTHONPATH=. python -m pytest server/test_studio_pages.py -q
"""

import os
import secrets
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
from server.db import db_conn, init_db, json_field_sql, json_loads
from server.systems.ads_studio import studio_alerts_meta, studio_jobs
from server.systems.ads_studio.studio_privacy import scrub_studio_personal_data_conn
from server.systems.ads_studio.studio_settings import DEFAULTS
from server.test_social_studio import (  # noqa: F401  (_fresh is a fixture)
    ALL_ON,
    API,
    VALID_PNG_DATA_URL,
    _arm,
    _fb_comment,
    _fresh,
    _insert_user,
    _link,
    _log_rows,
    _login,
    _rule,
    _subscribe,
    _webhook,
    _wipe_social_rows,
    client,
)

UTC = timezone.utc
TAG = secrets.token_hex(3)
APP_ID = "123456789012345"
FB_PAGE, FB_PAGE_2, FB_PAGE_3 = "5300000000001", "5300000000002", "5300000000003"
IG_PAGE_FB, IG_USER = "5300000000011", "17800000000011"
PAGE_ALERT_KINDS = ("page_health_drop", "instagram_comments_not_arriving")


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def actors():  # the shape test_social_studio's autouse _fresh fixture expects; own e-mails per run
    init_db()
    out = {}
    for key, role, subscribed in (("admin", "Admin", False), ("a", "Employee", True), ("b", "Employee", True)):
        email = f"studio-pages-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Studio pages {key}", email, role)
        if subscribed:
            _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    yield out
    _wipe_social_rows()


class FakeMeta:
    """Answers MetaAdsClient._request by (method, path); records every call and its lane block."""

    def __init__(self):
        self.calls = []
        self.lanes = []
        self.routes = {}

    def request(self, method, path, *, params=None, data=None, access_token=None, use_headroom=False):
        body = dict(params or {}) if method == "GET" else dict(data or {})
        self.calls.append((method, path, body, access_token))
        self.lanes.append((method, path, meta_ads._META_LANE_CONTEXT.get()))
        answer = self.routes.get((method, path))
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
def meta(monkeypatch):
    fake = FakeMeta()
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request", lambda self, method, path, **kw: fake.request(method, path, **kw))
    monkeypatch.setattr(meta_ads.MetaAdsClient, "page_access_token", lambda self, page_id: f"PAGE-TOKEN-{page_id}")
    # Albayan's own token check (P3-18a) never runs here: a per-page refusal is the page's own.
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda *args, **kwargs: "ok_fresh")
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    return fake


def _wipe_page_alerts():
    with db_conn() as conn:
        for kind in PAGE_ALERT_KINDS:
            conn.execute(text(f"DELETE FROM entities WHERE type = :t AND {json_field_sql('kind')} = :kind"),
                         {"t": studio_jobs.ALERTS_TYPE, "kind": kind})


@pytest.fixture(autouse=True)
def _clean_alerts():
    _wipe_page_alerts()  # other modules' reply tests raise page alerts too (a refused reply marks its page)
    yield
    _wipe_page_alerts()


def _alerts(kind):
    with db_conn() as conn:
        rows = conn.execute(
            text(f"SELECT data_json, created_by FROM entities WHERE type = :t AND {json_field_sql('kind')} = :kind"),
            {"t": studio_jobs.ALERTS_TYPE, "kind": kind},
        ).mappings().all()
    return [{**json_loads(row["data_json"]), "_createdBy": row["created_by"]} for row in rows]


def _entity(page_id):
    return studio._ctx()["get_entity"](studio.PAGES_TYPE, page_id)


def _listed(cookies, page_id):
    return next(p for p in client.get(f"{API}/pages", cookies=cookies).json()["pages"] if p["id"] == page_id)


def _audits(page_id):
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT action, metadata_json FROM audit_logs WHERE resource_type = 'socialPages' AND resource_id = :id"),
            {"id": page_id},
        ).mappings().all()
    return [(row["action"], json_loads(row["metadata_json"] or "{}")) for row in rows]


def _ig_comment(comment_id, from_id="9011"):
    return {"object": "instagram", "entry": [{"id": IG_USER, "changes": [{"field": "comments", "value": {
        "id": comment_id, "media": {"id": "17950000000011"}, "from": {"id": from_id, "username": "buyer"}, "text": "price?",
    }}]}]}


def _subscribed(app_id=APP_ID, fields=("feed",)):
    return {"data": [{"id": app_id, "subscribed_fields": list(fields)}]}


# ---------------------------------------------------------------------------
# The one writer and the customer's view
# ---------------------------------------------------------------------------


def test_page_health_view_and_classic_dot_agree(actors):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", FB_PAGE, name="Shop")
    assert page["healthy"] is True
    assert page["health"] == {"state": "ok", "reason": "", "label": {"en": "Working", "ar": "يعمل"}, "fix": None,
                              "teamAction": False, "checkedAt": None, "since": None}
    marked = studio._set_page_health(page["id"], "attention", "token_revoked")
    assert marked["healthy"] is False and marked["healthState"] == "attention" and marked["healthReason"] == "token_revoked"
    listed = _listed(a, page["id"])
    assert listed["healthy"] is False and listed["health"]["state"] == "attention" and listed["health"]["reason"] == "token_revoked"
    assert listed["health"]["label"] == {"en": "Albayan's access to this page stopped working", "ar": "توقف وصول البيان إلى هذه الصفحة"}
    assert listed["health"]["fix"]["en"].startswith("Share the page with Albayan again") and listed["health"]["teamAction"] is False
    assert listed["health"]["since"] and listed["health"]["checkedAt"]
    assert "linkedBy" in listed and listed["linkedBy"] == "team"  # P1-05 still applies to the page row
    # The drop raised the owner's alert for the day; a repeat the same day refreshes it, never doubles it.
    alerts = _alerts("page_health_drop")
    assert len(alerts) == 1 and alerts[0]["_createdBy"] == actors["a"]["id"] and alerts[0]["relatedId"] == page["id"]
    assert alerts[0]["details"] == {"reason": "token_revoked", "platform": "fb"}
    studio._set_page_health(page["id"], "ok")
    studio._set_page_health(page["id"], "attention", "token_revoked")
    assert len(_alerts("page_health_drop")) == 1
    # Back to ok: both the dot and the chip agree again; a same-state write without ``touch`` is a no-op.
    cleared = studio._set_page_health(page["id"], "ok")
    assert cleared["healthy"] is True and _listed(a, page["id"])["health"]["state"] == "ok"
    before = _entity(page["id"])["lastModified"]
    studio._set_page_health(page["id"], "ok")
    assert _entity(page["id"])["lastModified"] == before
    studio._set_page_health(page["id"], "ok", touch=True)
    assert _entity(page["id"])["lastModified"] > before
    with pytest.raises(ValueError):
        studio._set_page_health(page["id"], "attention", "bogus")
    with pytest.raises(ValueError):
        studio._set_page_health(page["id"], "broken")
    assert studio._set_page_health("spg_nobody", "ok") is None
    # A row from before P4-03 (only the classic flag) reads as "needs attention" with the generic words.
    legacy = studio.page_health_view({"healthy": False})
    assert legacy["state"] == "attention" and legacy["reason"] == "" and legacy["label"] == {"en": "Needs attention", "ar": "يحتاج انتباهاً"}
    assert studio.page_health_view({"healthy": True})["state"] == "ok"
    team = studio.page_health_view({"healthState": "attention", "healthReason": "webhook_not_subscribed"})
    assert team["teamAction"] is True and team["fix"]["ar"] == "فريق البيان يفعّلها؛ لا شيء مطلوب منك"
    for reason in studio.PAGE_HEALTH_REASONS:
        entry = studio.PAGE_HEALTH_LABELS[reason]
        assert entry["label"]["en"] and entry["label"]["ar"] and entry["fix"]["en"] and entry["fix"]["ar"]


def test_page_health_suppressed_while_the_connection_is_down(actors, monkeypatch):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", FB_PAGE)
    studio._set_page_health(page["id"], "attention", "page_role_lost")
    monkeypatch.setattr(studio_alerts_meta, "connection_down", lambda: True)
    listed = _listed(a, page["id"])
    assert listed["health"]["state"] == "connection" and listed["health"]["reason"] == ""
    assert listed["health"]["label"] == studio.PAGE_HEALTH_CONNECTION_LABEL and listed["health"]["teamAction"] is True
    assert listed["healthy"] is False  # the classic dot keeps the stored truth
    view = studio.page_health_view({"healthState": "ok"}, connection_down=True)
    assert view["state"] == "ok"  # a working page stays working


# ---------------------------------------------------------------------------
# Webhook subscription: on link, the check, the backfill
# ---------------------------------------------------------------------------


def test_page_health_webhook_subscribe_on_link_and_backfill(actors, meta):
    a, admin = actors["a"]["cookies"], actors["admin"]["cookies"]
    # Not armed: linking makes no Meta call at all.
    idle = _link(actors, "a", FB_PAGE_3)
    assert meta.calls == [] and "webhookSubscribedAt" not in idle
    _arm(ALL_ON)
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    page = _link(actors, "a", FB_PAGE)
    assert meta.posts() == [(f"{FB_PAGE}/subscribed_apps", {"subscribed_fields": "feed"}, f"PAGE-TOKEN-{FB_PAGE}")]
    assert meta.lanes[-1] == ("POST", f"{FB_PAGE}/subscribed_apps", ("page", FB_PAGE))  # the page lane, that page
    assert page["webhookSubscribedAt"] and page["health"]["state"] == "ok"
    assert ("subscribe", {"ok": True, "errorCode": "", "providerCode": ""}) in _audits(page["id"])
    # A definite refusal on link: the page waits for the team (webhook_not_subscribed).
    meta.routes[("POST", f"{FB_PAGE_2}/subscribed_apps")] = meta_ads.MetaAdsError("request_failed", "Meta refused.", provider_code="100")
    page2 = _link(actors, "a", FB_PAGE_2)
    assert page2["healthy"] is False and page2["health"]["reason"] == "webhook_not_subscribed" and page2["health"]["teamAction"] is True
    assert _alerts("page_health_drop")[0]["details"]["reason"] == "webhook_not_subscribed"
    # The admin's check: subscribed_apps lists Albayan's app with feed -> ok again.
    meta.routes[("GET", f"{FB_PAGE_2}/subscribed_apps")] = _subscribed()
    assert client.post(f"{API}/pages/{page2['id']}/check", cookies=a).status_code == 403
    checked = client.post(f"{API}/pages/{page2['id']}/check", cookies=admin)
    assert checked.status_code == 200, checked.text
    assert checked.json()["webhook"] == "subscribed" and checked.json()["reason"] == "" and checked.json()["health"]["state"] == "ok"
    assert meta.lanes[-1] == ("GET", f"{FB_PAGE_2}/subscribed_apps", ("page", FB_PAGE_2))
    assert client.post(f"{API}/pages/{page2['id']}/check", cookies=admin).status_code == 429  # once a minute per page
    assert ("page_health_check", {"checked": True, "webhook": "subscribed", "reason": "", "errorCode": ""}) in _audits(page2["id"])
    assert _listed(a, page2["id"])["health"]["checkedAt"]
    # Another app, or Albayan's app without feed, is not a subscription: the backfill subscribes;
    # when Meta does not confirm, the page waits for the team.
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed(app_id="999")
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": False}
    result = studio.check_page_health(_entity(page["id"]))
    assert result["webhook"] == "not_subscribed" and result["reason"] == "webhook_not_subscribed"
    assert meta.posts()[-1][0] == f"{FB_PAGE}/subscribed_apps"
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed(fields=("messages",))
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    result = studio.check_page_health(_entity(page["id"]))
    assert result["webhook"] == "subscribed" and result["reason"] == "" and result["health"]["state"] == "ok"
    # A temporary refusal of the backfill changes nothing (the next check tries again).
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed(app_id="999")
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("temporary", "Meta is busy.", retryable=True, provider_code="2")
    result = studio.check_page_health(_entity(page["id"]))
    assert result["webhook"] == "not_subscribed" and result["reason"] == "" and result["health"]["state"] == "ok"
    # A Facebook feed event proves the subscription: it clears webhook_not_subscribed on its own.
    studio._set_page_health(page["id"], "attention", "webhook_not_subscribed")
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_1", "9001", "hello"))  # no rule: nothing is sent
    assert _listed(a, page["id"])["health"]["state"] == "ok"
    # The meta_ads doors answer with codes only, never a token.
    read = meta_ads.read_page_webhook_subscription(FB_PAGE_2)
    assert read == {"state": "subscribed", "errorCode": "", "providerCode": "", "retryable": False, "pageReason": ""}
    meta.routes[("GET", f"{FB_PAGE_2}/subscribed_apps")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190.492")
    read = meta_ads.read_page_webhook_subscription(FB_PAGE_2)
    assert read["state"] == "error" and read["providerCode"] == "190.492" and read["pageReason"] == "page_role_lost"
    assert meta_ads.subscribe_page_webhook("not-a-page")["errorCode"] == "invalid_id"
    assert "PAGE-TOKEN" not in repr(read)


def test_page_health_check_maps_meta_refusals_to_page_reasons(actors, meta):
    _arm(ALL_ON)
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    page = _link(actors, "a", FB_PAGE)
    for provider, reason in (("190.460", "token_revoked"), ("10", "permission_missing"), ("200", "permission_missing")):
        meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("authorization", "x", provider_code=provider)
        result = studio.check_page_health(_entity(page["id"]))
        assert result["reason"] == reason and result["providerCode"] == provider, provider
        assert _entity(page["id"])["data"]["healthReason"] == reason
        studio._set_page_health(page["id"], "ok")
    # A global refusal (Albayan's own token) leaves the page alone: P3-18a decides.
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190.463")
    result = studio.check_page_health(_entity(page["id"]))
    assert result["reason"] == "" and result["errorCode"] == "authorization" and _entity(page["id"])["data"]["healthState"] == "ok"
    # A throttle Meta names is "throttled"; a check that could not read keeps a standing reason.
    studio._set_page_health(page["id"], "attention", "webhook_not_subscribed")
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("rate_limited", "x", retryable=True, provider_code="32")
    assert studio.check_page_health(_entity(page["id"]))["reason"] == "throttled"
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("network", "x", retryable=True)
    studio._set_page_health(page["id"], "attention", "webhook_not_subscribed")
    result = studio.check_page_health(_entity(page["id"]))
    assert result["reason"] == "webhook_not_subscribed" and result["errorCode"] == "network"


# ---------------------------------------------------------------------------
# Replies mark and clear the page
# ---------------------------------------------------------------------------


def test_page_health_token_revoked_from_190_460(actors, meta):
    a = actors["a"]["cookies"]
    _arm(ALL_ON)
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    page = _link(actors, "a", FB_PAGE)
    _rule(a, name="All", publicReply="Thanks")
    dead = meta_ads.MetaAdsError("authorization", "Meta authorization failed. Reconnect the access token.", provider_code="190.460")
    meta.routes[("POST", f"{FB_PAGE}_1/comments")] = dead
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_1", "9001", "hello"))
    listed = _listed(a, page["id"])
    assert listed["healthy"] is False and listed["health"]["reason"] == "token_revoked"
    assert _alerts("page_health_drop")[0]["_createdBy"] == actors["a"]["id"]
    assert "190.460" in _log_rows(actors["a"]["id"])[0]["error"]
    # 190.492: the page role was lost; a permission code: permission missing.
    meta.routes[("POST", f"{FB_PAGE}_2/comments")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190.492")
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_2", "9002", "hello"))
    assert _listed(a, page["id"])["health"]["reason"] == "page_role_lost"
    meta.routes[("POST", f"{FB_PAGE}_3/comments")] = meta_ads.MetaAdsError("authorization", "x", provider_code="10")
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_3", "9003", "hello"))
    assert _listed(a, page["id"])["health"]["reason"] == "permission_missing"
    # A global 190 (the token itself) is not the page's problem.
    studio._set_page_health(page["id"], "ok")
    meta.routes[("POST", f"{FB_PAGE}_4/comments")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190.463")
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_4", "9004", "hello"))
    assert _listed(a, page["id"])["health"]["state"] == "ok"
    # A reply Meta accepts clears what a reply can clear, never a staff-set reason.
    studio._set_page_health(page["id"], "attention", "permission_missing")
    meta.routes[("POST", f"{FB_PAGE}_5/comments")] = {"id": f"{FB_PAGE}_5_reply"}
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_5", "9005", "hello"))
    assert _listed(a, page["id"])["health"]["state"] == "ok"
    studio._set_page_health(page["id"], "attention", "instagram_private")
    meta.routes[("POST", f"{FB_PAGE}_6/comments")] = {"id": f"{FB_PAGE}_6_reply"}
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_6", "9006", "hello"))
    assert _listed(a, page["id"])["health"]["reason"] == "instagram_private"
    assert studio.page_problem_reason(meta_ads.MetaAdsError("authorization", "no page token")) == "page_role_lost"
    assert studio.page_problem_reason(meta_ads.MetaAdsError("request_failed", "x", provider_code="100")) == ""
    assert studio.page_problem_reason(meta_ads.MetaAdsError("rate_limited", "x", retryable=True)) == ""  # Albayan's own pause


# ---------------------------------------------------------------------------
# Instagram: staff-set "private" and the "comments not arriving" heuristic
# ---------------------------------------------------------------------------


def test_page_health_staff_sets_instagram_private_audited(actors):
    a, admin = actors["a"]["cookies"], actors["admin"]["cookies"]
    ig = _link(actors, "a", IG_PAGE_FB, platform="ig", ig_user_id=IG_USER)
    fb = _link(actors, "a", FB_PAGE)
    url = f"{API}/pages/{ig['id']}/health"
    assert client.post(url, json={"reason": "instagram_private"}, cookies=a).status_code == 403
    assert client.post(url, json={"reason": "token_revoked"}, cookies=admin).status_code == 400
    assert client.post(f"{API}/pages/{fb['id']}/health", json={"reason": "instagram_private"}, cookies=admin).status_code == 409
    marked = client.post(url, json={"reason": "instagram_private"}, cookies=admin)
    assert marked.status_code == 200, marked.text
    assert marked.json()["health"]["reason"] == "instagram_private"
    assert marked.json()["health"]["fix"]["ar"] == "اجعل حسابك عاماً من إعدادات إنستغرام ثم أبلغ الفريق"
    assert _listed(a, ig["id"])["healthy"] is False
    assert ("page_health", {"before": "ok", "after": "instagram_private"}) in _audits(ig["id"])
    assert _alerts("page_health_drop")[0]["details"] == {"reason": "instagram_private", "platform": "ig"}
    # An Instagram comment that reaches Albayan proves the account is public: cleared, and stamped.
    _webhook(_ig_comment("17900000000011"))
    after = _entity(ig["id"])["data"]
    assert after["healthState"] == "ok" and after["igLastCommentEventAt"]
    # Staff clear it themselves too.
    assert client.post(url, json={"reason": "instagram_private"}, cookies=admin).status_code == 200
    cleared = client.post(url, json={"reason": ""}, cookies=admin)
    assert cleared.status_code == 200 and cleared.json()["health"]["state"] == "ok"
    assert ("page_health", {"before": "instagram_private", "after": "ok"}) in _audits(ig["id"])
    assert client.post(f"{API}/pages/spg_nobody/health", json={"reason": ""}, cookies=admin).status_code == 404


def test_ig_comments_not_arriving_heuristic(actors, meta):
    a = actors["a"]["cookies"]
    _arm(ALL_ON)  # igPublicReply on = webhook delivery expected
    meta.routes[("POST", f"{IG_PAGE_FB}/subscribed_apps")] = {"success": True}
    meta.routes[("GET", f"{IG_PAGE_FB}/subscribed_apps")] = _subscribed()
    ig = _link(actors, "a", IG_PAGE_FB, platform="ig", ig_user_id=IG_USER)
    counts = {"n": 3}
    meta.routes[("GET", f"{IG_USER}/media")] = lambda body: {"data": [
        {"id": "17950000000011", "comments_count": counts["n"]}, {"id": "17950000000012", "comments_count": 0},
    ]}
    t0 = datetime.now(UTC)
    first = studio.check_page_health(_entity(ig["id"]), now=t0)
    assert first["igCommentTotal"] == 3 and first["reason"] == "" and first["health"]["state"] == "ok"
    assert meta.lanes[-1] == ("GET", f"{IG_USER}/media", ("page", IG_PAGE_FB))
    assert meta.calls[-1][2] == {"fields": "id,comments_count", "limit": studio.IG_MEDIA_COUNTED}
    data = _entity(ig["id"])["data"]
    assert data["igCommentCounts"] == {"total": 3, "at": studio._iso_at(t0)} and data["lastHealthCheckAt"] == studio._iso_at(t0)
    # Six hours later the count grew: too early to judge, and the day-old snapshot stays.
    counts["n"] = 5
    mid = studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=6))
    assert mid["reason"] == "" and _entity(ig["id"])["data"]["igCommentCounts"]["total"] == 3
    # A day later, still growing and no comment event since: not arriving (customer-first fix step).
    late = studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=25))
    assert late["reason"] == "instagram_comments_not_arriving"
    assert late["health"]["fix"]["en"] == "First make sure the account is public in Instagram settings, then tell the team"
    alerts = _alerts("instagram_comments_not_arriving")
    assert len(alerts) == 1 and alerts[0]["_createdBy"] == actors["a"]["id"] and _alerts("page_health_drop") == []
    assert _entity(ig["id"])["data"]["igCommentCounts"]["total"] == 5
    assert _listed(a, ig["id"])["healthy"] is False
    # A comment event arriving clears it; growth with an event inside the window is fine.
    _webhook(_ig_comment("17900000000012"))
    assert _entity(ig["id"])["data"]["healthState"] == "ok"
    studio._ctx()["patch_entity"](studio.PAGES_TYPE, ig["id"], {"igLastCommentEventAt": studio._iso_at(t0 + timedelta(hours=30))}, actors["a"]["id"])
    counts["n"] = 9
    again = studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=50))
    assert again["reason"] == "" and again["igCommentTotal"] == 9 and _entity(ig["id"])["data"]["igCommentCounts"]["total"] == 9
    # Polling reads Instagram itself: the heuristic is off, no media read.
    _arm({**ALL_ON, "igPublicReply": "poll"})
    reads = len(meta.reads("/media"))
    polled = studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=75))
    assert polled["igCommentTotal"] is None and len(meta.reads("/media")) == reads and polled["webhook"] == ""


# ---------------------------------------------------------------------------
# The daily pass (budgeted) and its worker turn
# ---------------------------------------------------------------------------


def test_page_health_daily_pass_is_budgeted(actors, meta):
    first = _link(actors, "a", FB_PAGE)
    assert studio.run_page_health_pass() == {"due": 0, "checked": 0, "attention": 0, "errors": 0}  # not armed: nothing to do
    assert meta.calls == []
    _arm(ALL_ON)
    meta.routes[("POST", f"{FB_PAGE_2}/subscribed_apps")] = {"success": True}
    second = _link(actors, "a", FB_PAGE_2)
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed()
    meta.routes[("GET", f"{FB_PAGE_2}/subscribed_apps")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190.492")
    now = datetime.now(UTC)
    one = studio.run_page_health_pass(now=now, limit=1)
    assert (one["due"], one["checked"], one["errors"]) == (2, 1, 0)  # the budget: one page this pass
    checked = [p for p in (first, second) if _entity(p["id"])["data"].get("lastHealthCheckAt") == studio._iso_at(now)]
    assert len(checked) == 1
    rest = studio.run_page_health_pass(now=now)
    assert (rest["due"], rest["checked"], rest["errors"]) == (1, 1, 0) and one["attention"] + rest["attention"] == 1
    assert _entity(second["id"])["data"]["healthReason"] == "page_role_lost"
    assert _entity(first["id"])["data"]["healthState"] == "ok"
    assert studio.run_page_health_pass(now=now + timedelta(hours=6)) == {"due": 0, "checked": 0, "attention": 0, "errors": 0}
    later = now + timedelta(hours=25)
    assert studio.run_page_health_pass(now=later)["due"] == 2  # a day later both are due again
    assert _entity(first["id"])["data"]["lastHealthCheckAt"] == studio._iso_at(later)


def test_page_health_pass_runs_from_the_worker_tick(monkeypatch):
    calls = []
    monkeypatch.setattr(studio, "run_page_health_pass", lambda now=None, limit=studio.PAGE_HEALTH_PASS_LIMIT: calls.append(now))
    monkeypatch.setattr(studio, "_RETRY_TICK", 1)
    studio.run_scheduler_tick()  # tick 2: the pass's turn
    assert len(calls) == 1 and calls[0] is not None
    studio.run_scheduler_tick()
    assert len(calls) == 1
    monkeypatch.setattr(studio, "_RETRY_TICK", studio.PAGE_HEALTH_PASS_EVERY_TICKS + 1)
    studio.run_scheduler_tick()
    assert len(calls) == 2


def test_page_check_clears_a_standing_reason_only_after_a_read_proved_it_wrong(actors, meta):
    """With the default capabilities (fbPublicReply gated) a check makes no Meta call: a standing
    reason then stays, and the daily pass neither clears it nor raises a fresh alert the next day.
    A page-token read that answers clears a token/role/permission reason; only the subscription
    read as subscribed (or backfilled) clears webhook_not_subscribed."""
    a = actors["a"]["cookies"]
    _arm(dict(DEFAULTS["capabilities"]))  # the realistic first save: fbPublicReply gated, the rest unavailable
    page = _link(actors, "a", FB_PAGE)
    assert meta.calls == []  # gated: nothing to subscribe on link
    studio._set_page_health(page["id"], "attention", "page_role_lost")
    assert len(_alerts("page_health_drop")) == 1
    result = studio.check_page_health(_entity(page["id"]))
    assert meta.calls == [] and result["reason"] == "page_role_lost" and result["health"]["state"] == "attention"
    data = _entity(page["id"])["data"]
    assert data["healthReason"] == "page_role_lost" and data["lastHealthCheckAt"]  # stamped: the daily budget is unchanged
    tomorrow = datetime.now(UTC) + timedelta(hours=25)
    passed = studio.run_page_health_pass(now=tomorrow)
    assert (passed["checked"], passed["attention"]) == (1, 1) and meta.calls == []
    assert _entity(page["id"])["data"]["healthReason"] == "page_role_lost" and len(_alerts("page_health_drop")) == 1
    assert _listed(a, page["id"])["health"]["fix"]["en"] == "Give Albayan access to the page again in Meta Business Suite"
    # An Instagram account read by polling: no media read either, the reason stays.
    _arm({**ALL_ON, "igPublicReply": "poll"})
    meta.routes[("POST", f"{IG_PAGE_FB}/subscribed_apps")] = {"success": True}
    ig = _link(actors, "a", IG_PAGE_FB, platform="ig", ig_user_id=IG_USER)
    studio._set_page_health(ig["id"], "attention", "permission_missing")
    reads = len(meta.calls)
    assert studio.check_page_health(_entity(ig["id"]))["reason"] == "permission_missing" and len(meta.calls) == reads
    # A standing webhook_not_subscribed survives a backfill Meta refused temporarily (nothing was proved)...
    _arm(ALL_ON)
    studio._set_page_health(page["id"], "attention", "webhook_not_subscribed")
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed(app_id="999")
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("temporary", "Meta is busy.", retryable=True, provider_code="2")
    result = studio.check_page_health(_entity(page["id"]))
    assert result["webhook"] == "not_subscribed" and result["reason"] == "webhook_not_subscribed"
    # ... and goes once the backfill is confirmed; a token reason goes once the page token answered.
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    result = studio.check_page_health(_entity(page["id"]))
    assert result["webhook"] == "subscribed" and result["reason"] == "" and result["health"]["state"] == "ok"
    studio._set_page_health(page["id"], "attention", "token_revoked")
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _subscribed()
    assert studio.check_page_health(_entity(page["id"]))["reason"] == "" and _entity(page["id"])["data"]["healthState"] == "ok"


def test_190_460_from_albayans_own_token_is_the_global_outage_not_the_pages(actors, meta, monkeypatch):
    """Meta's subcode 460 names the session behind a token, and every page is reached through ONE
    system token: unless the token check says that token is fine (ok_fresh), the refusal is Albayan's
    own outage (P3-18a state, P3-18b parked reply), the page is not marked and no owner is told to
    reshare the page."""
    a = actors["a"]["cookies"]
    _arm(ALL_ON)
    meta.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    page = _link(actors, "a", FB_PAGE)
    _rule(a, name="All", publicReply="Thanks")
    checks = []
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda *args, **kwargs: checks.append(args) or "down")
    dead = meta_ads.MetaAdsError("authorization", "Meta authorization failed. Reconnect the access token.", provider_code="190.460")
    meta.routes[("POST", f"{FB_PAGE}_1/comments")] = dead
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_1", "9001", "hello"))
    assert checks  # the token check decided (P3-18a)
    listed = _listed(a, page["id"])
    assert listed["healthy"] is True and listed["health"]["state"] == "ok" and _alerts("page_health_drop") == []
    [log] = _log_rows(actors["a"]["id"])
    assert log["parkedReason"] == studio.PARKED_REASON and log["retryAfter"]  # parked for the recovery, not lost
    # The check: the same refusal on the subscription read goes to the token check; the page keeps its state.
    meta.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = dead
    result = studio.check_page_health(_entity(page["id"]))
    assert result["reason"] == "" and result["errorCode"] == "authorization" and result["providerCode"] == "190.460"
    assert _entity(page["id"])["data"]["healthState"] == "ok" and _alerts("page_health_drop") == []
    # No verdict about the refusal yet (pending): still not the page's.
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda *args, **kwargs: "pending")
    meta.routes[("POST", f"{FB_PAGE}_2/comments")] = dead
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_2", "9002", "hello"))
    assert _listed(a, page["id"])["health"]["state"] == "ok" and _alerts("page_health_drop") == []
    # Albayan's token checked fine after the refusal: then it IS this page's token (the owner's fix step).
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda *args, **kwargs: "ok_fresh")
    meta.routes[("POST", f"{FB_PAGE}_3/comments")] = dead
    _webhook(_fb_comment(FB_PAGE, f"{FB_PAGE}_3", "9003", "hello"))
    assert _listed(a, page["id"])["health"]["reason"] == "token_revoked" and len(_alerts("page_health_drop")) == 1
    # A page linked during the outage (its subscribe refused the same way) is not marked either.
    monkeypatch.setattr(studio_alerts_meta, "after_authorization_failure", lambda *args, **kwargs: "down")
    meta.routes[("POST", f"{FB_PAGE_2}/subscribed_apps")] = dead
    page2 = _link(actors, "a", FB_PAGE_2)
    assert page2["healthy"] is True and page2["health"]["state"] == "ok" and len(_alerts("page_health_drop")) == 1


def test_ig_heuristic_trusts_a_comment_that_arrived_right_after_the_snapshot(actors, meta):
    """A stamp written 5 minutes before the snapshot, one comment delivered 3 minutes after it (inside
    the 10-minute stamp throttle) and a quiet day: the comment did arrive, so nothing is marked and
    no owner is told to make the account public. Real silence is still found."""
    a = actors["a"]["cookies"]
    _arm(ALL_ON)
    meta.routes[("POST", f"{IG_PAGE_FB}/subscribed_apps")] = {"success": True}
    meta.routes[("GET", f"{IG_PAGE_FB}/subscribed_apps")] = _subscribed()
    ig = _link(actors, "a", IG_PAGE_FB, platform="ig", ig_user_id=IG_USER)
    counts = {"n": 3}
    meta.routes[("GET", f"{IG_USER}/media")] = lambda body: {"data": [{"id": "17950000000011", "comments_count": counts["n"]}]}
    t0 = datetime.now(UTC)
    studio._ctx()["patch_entity"](studio.PAGES_TYPE, ig["id"], {"igLastCommentEventAt": studio._iso_at(t0 - timedelta(minutes=5))}, actors["a"]["id"])
    assert studio.check_page_health(_entity(ig["id"]), now=t0)["reason"] == ""
    assert _entity(ig["id"])["data"]["igCommentCounts"] == {"total": 3, "at": studio._iso_at(t0)}
    _webhook(_ig_comment("17900000000021"))  # the one comment of a quiet day, right after the snapshot
    stamped = studio._parse_iso(_entity(ig["id"])["data"]["igLastCommentEventAt"])
    assert stamped >= t0  # rewritten although the last stamp is younger than 10 minutes: it predates the snapshot
    counts["n"] = 4
    late = studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=25))
    assert late["reason"] == "" and late["health"]["state"] == "ok" and _alerts("instagram_comments_not_arriving") == []
    assert _listed(a, ig["id"])["healthy"] is True
    # Real silence: a stamp from well before the snapshot and nothing since still marks the page.
    studio._ctx()["patch_entity"](studio.PAGES_TYPE, ig["id"], {"igLastCommentEventAt": studio._iso_at(t0 + timedelta(hours=24, minutes=30))}, actors["a"]["id"])
    counts["n"] = 6
    assert studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=50))["reason"] == "instagram_comments_not_arriving"
    assert len(_alerts("instagram_comments_not_arriving")) == 1
    # A stamp throttled just before the snapshot never counts as silence on its own.
    studio._set_page_health(ig["id"], "ok")
    studio._ctx()["patch_entity"](studio.PAGES_TYPE, ig["id"], {"igLastCommentEventAt": studio._iso_at(t0 + timedelta(hours=50) - timedelta(minutes=5))}, actors["a"]["id"])
    counts["n"] = 7
    assert studio.check_page_health(_entity(ig["id"]), now=t0 + timedelta(hours=75))["reason"] == ""


# ---------------------------------------------------------------------------
# P5-04: anonymisation scrubs the Social Studio rows
# ---------------------------------------------------------------------------


def test_anonymisation_scrubs_social_studio_rows(actors):
    a = actors["a"]["cookies"]
    page = _link(actors, "a", FB_PAGE, name="Secret Shop")
    other = _link(actors, "b", FB_PAGE_2, name="Other Shop")
    rule = _rule(a, name="Price rule", trigger="keywords", keywords=["السعر"], publicReply="Secret reply", dmEnabled=True,
                 dmText="Secret message", pageRefs=[page["id"]])
    post = client.post(f"{API}/posts", json={"pageIds": [page["id"]], "caption": "Secret caption", "media": [VALID_PNG_DATA_URL]}, cookies=a)
    assert post.status_code == 200, post.text
    with db_conn() as conn:
        assert scrub_studio_personal_data_conn(conn, actors["a"]["id"]) == {"profiles": 0, "replyLog": 0, "tickets": 0, "social": 3}
    with db_conn() as conn:
        rows = {row["id"]: (json_loads(row["data_json"]), row["data_json"]) for row in conn.execute(
            text("SELECT id, data_json FROM entities WHERE id IN (:page, :rule, :post, :other)"),
            {"page": page["id"], "rule": rule["id"], "post": post.json()["id"], "other": other["id"]},
        ).mappings().all()}
    rule_data, rule_raw = rows[rule["id"]]
    assert not {"name", "keywords", "publicReply", "dmText"} & set(rule_data)
    assert rule_data["pageRefs"] == [page["id"]] and rule_data["platform"] == "fb" and rule_data["ownerId"] == actors["a"]["id"]
    page_data, page_raw = rows[page["id"]]
    assert "name" not in page_data and page_data["metaPageId"] == FB_PAGE and page_data["platform"] == "fb"
    post_data, post_raw = rows[post.json()["id"]]
    assert not {"caption", "media"} & set(post_data) and post_data["pageIds"] == [page["id"]] and post_data["status"] == "draft"
    for raw in (rule_raw, page_raw, post_raw):
        assert "Secret" not in raw and "السعر" not in raw and "base64" not in raw
    assert rows[other["id"]][0]["name"] == "Other Shop"  # another owner's page is untouched
    with db_conn() as conn:  # a second run changes nothing (and reports no social rows)
        assert scrub_studio_personal_data_conn(conn, actors["a"]["id"]) == {"profiles": 0, "replyLog": 0, "tickets": 0, "social": 0}
