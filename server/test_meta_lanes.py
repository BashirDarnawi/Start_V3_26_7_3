"""P3-00a-c: Meta call lanes (admin, studio_results, page).

Each lane has its own request lock, pacing clock and back-off record. Graph is faked with
httpx.MockTransport; nothing here reaches the network. Replies go through Social Studio's own
reply code (social_studio._execute_rule_actions), which sends with a Page token. The system
token, the Page tokens and the full page and ad account ids never appear in the lane report or
in the stored lane row.
"""

import json
import secrets
import threading
import time

import httpx
import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
from server.db import db_conn, init_db
from server.main import app  # noqa: F401  (the app sets up the test database)
from server.systems.ads_studio import social_studio

TAG = secrets.token_hex(4)
SYSTEM_TOKEN = f"lanes-system-token-{TAG}-never-leaks"
APP_SECRET = f"lanes-app-secret-{TAG}-never-leaks"
ACCOUNT = "444444444444461"
ACCOUNT_2 = "444444444444472"
CAMPAIGN = "120900000000061"
CAMPAIGN_2 = "120900000000072"
PAGE_A = "5100000000061"
PAGE_B = "5100000000072"
COMMENTS = {PAGE_A: "7100000000061_1", PAGE_B: "7100000000072_1"}
ADMIN_PATH = f"act_{ACCOUNT}/campaigns"
RESULTS = {ACCOUNT: f"{CAMPAIGN}/insights", ACCOUNT_2: f"{CAMPAIGN_2}/insights"}
PROVIDER_TYPE = "metaProviderState"


def _page_token(page_id):
    return f"PAGE-TOKEN-{page_id}-{TAG}"


def _ok(body, headers=None):
    return lambda request: httpx.Response(200, json=body, headers=headers or {})


def _refused(code, headers=None):
    return lambda request: httpx.Response(
        400, json={"error": {"code": code, "message": "Too many calls"}}, headers=headers or {}
    )


def _buc(object_id, kind, call_count, regain_minutes=0):
    entry = {"type": kind, "call_count": call_count, "total_cputime": 10, "total_time": 10}
    if regain_minutes:
        entry["estimated_time_to_regain_access"] = regain_minutes
    return {"x-business-use-case-usage": json.dumps({object_id: [entry]})}


class Graph:
    """A fake Graph API behind httpx.MockTransport: answers by (method, path), records each call."""

    def __init__(self):
        self.routes = {}
        self.seen = []
        self._lock = threading.Lock()

    def handle(self, request):
        path = request.url.path.split("/", 2)[2]  # "/v25.0/<path>"
        with self._lock:
            self.seen.append((request.method, path))
        answer = self.routes.get((request.method, path))
        if answer is None:
            raise AssertionError(f"unexpected Graph {request.method} {path}")
        return answer(request)

    def count(self, method, path):
        with self._lock:
            return self.seen.count((method, path))

    def route_page(self, page_id, reply=None):
        """The Page token read and the public reply to that page's comment."""
        self.routes[("GET", page_id)] = _ok({"id": page_id, "access_token": _page_token(page_id)})
        self.routes[("POST", f"{COMMENTS[page_id]}/comments")] = reply or _ok({"id": f"{COMMENTS[page_id]}_9"})


def _fresh_lanes():
    return {"studio_results": meta_ads._MetaLaneState(), "page": meta_ads._MetaLaneState()}


def _provider_rows():
    with db_conn() as conn:
        return [dict(row) for row in conn.execute(
            text("SELECT * FROM entities WHERE type=:type"), {"type": PROVIDER_TYPE}
        ).mappings().all()]


def _put_provider_rows(rows):
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type=:type"), {"type": PROVIDER_TYPE})
        for row in rows:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"
                ),
                row,
            )


def _stored_lane_row():
    with db_conn() as conn:
        return conn.execute(
            text("SELECT data_json, created_by FROM entities WHERE type=:type AND id='lanes'"),
            {"type": PROVIDER_TYPE},
        ).mappings().first()


@pytest.fixture
def graph(monkeypatch):
    """Albayan's Meta connection configured, every lane clean (memory and stored rows), Graph faked."""
    init_db()
    saved = _provider_rows()
    _put_provider_rows([])
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT},{ACCOUNT_2}")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setenv("ALBAYAN_META_MIN_REQUEST_INTERVAL_MS", "100")
    monkeypatch.delenv("ALBAYAN_META_USAGE_PAUSE_PERCENT", raising=False)
    monkeypatch.delenv("ALBAYAN_META_GRAPH_API_VERSION", raising=False)
    for name, value in (
        ("_META_REMOTE_BACKOFF_UNTIL", 0.0), ("_META_REMOTE_BACKOFF_REASON", ""), ("_META_REMOTE_USAGE_PERCENT", 0),
        ("_META_LAST_REMOTE_REQUEST_MONOTONIC", 0.0), ("_META_LAST_REMOTE_REQUEST_AT", ""),
        ("_META_PROVIDER_STATE_REFRESHED_AT", 0.0), ("_META_LANE_STATE_REFRESHED_AT", 0.0),
        ("_META_APP_WIDE_UNTIL", 0.0), ("_META_APP_WIDE_REASON", ""),
    ):
        monkeypatch.setattr(meta_ads, name, value)
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())
    meta_ads._PAGE_TOKEN_CACHE.clear()
    fake = Graph()
    real_client_class = httpx.Client
    transport = httpx.MockTransport(fake.handle)
    monkeypatch.setattr(meta_ads.httpx, "Client", lambda **kwargs: real_client_class(transport=transport, **kwargs))
    try:
        yield fake
    finally:
        meta_ads._PAGE_TOKEN_CACHE.clear()
        _put_provider_rows(saved)


def _client():
    return meta_ads.get_meta_ads_client()


def _reply(page_id):
    """Social Studio's public reply to the page's comment: (actions, errors, retryable)."""
    return social_studio._execute_rule_actions(
        {"metaPageId": page_id}, {"publicReply": "Thanks!"}, "fb", COMMENTS[page_id]
    )


def _admin_read():
    return _client()._get(ADMIN_PATH, {"fields": "id"})


def _results_read(account_id):
    with meta_ads.meta_call_lane("studio_results", subject=account_id):
        return _client()._get(RESULTS[account_id], {"fields": "spend"})


def _refused_locally(call):
    """The call is refused by Albayan's own pause or park: nothing reaches Meta."""
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        call()
    assert meta_ads.is_meta_pause_refusal(refused.value), refused.value.code
    return refused.value


def _no_ids_or_tokens(value):
    dumped = json.dumps(value, ensure_ascii=False)
    for secret in (SYSTEM_TOKEN, APP_SECRET, _page_token(PAGE_A), _page_token(PAGE_B), "PAGE-TOKEN",
                   PAGE_A, PAGE_B, ACCOUNT, ACCOUNT_2, CAMPAIGN, CAMPAIGN_2):
        assert secret not in dumped, secret


# ---------------------------------------------------------------------------
# P3-00a: one lock and pacing clock per lane
# ---------------------------------------------------------------------------


def test_admin_timeout_does_not_delay_page_lane(graph):
    stuck, release = threading.Event(), threading.Event()

    def stuck_admin(request):
        stuck.set()
        release.wait(15)  # Meta hangs for the whole 15-second request timeout
        raise httpx.ReadTimeout("Meta did not answer", request=request)

    graph.routes[("GET", ADMIN_PATH)] = stuck_admin
    graph.route_page(PAGE_A)
    outcome = {}

    def admin_call():
        try:
            _admin_read()
        except meta_ads.MetaAdsError as error:
            outcome["error"] = error

    worker = threading.Thread(target=admin_call, daemon=True)
    worker.start()
    try:
        assert stuck.wait(5)
        started = time.monotonic()
        actions, errors, _retryable = _reply(PAGE_A)  # the Page token read and the reply, on the page lane
        elapsed = time.monotonic() - started
        assert actions == ["public"] and errors == []
        assert elapsed <= 1.0, elapsed
        assert worker.is_alive()  # the admin call was stuck the whole time
        held = not meta_ads._META_REMOTE_REQUEST_LOCK.acquire(blocking=False)
        if not held:
            meta_ads._META_REMOTE_REQUEST_LOCK.release()
        assert held  # the admin lane still waits its turn behind its own stuck call
    finally:
        release.set()
        worker.join(5)
    assert outcome["error"].code == "timeout"
    assert graph.count("POST", f"{COMMENTS[PAGE_A]}/comments") == 1


def test_each_lane_has_its_own_pacing_clock(graph, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_MIN_REQUEST_INTERVAL_MS", "750")
    slept = []
    monkeypatch.setattr(meta_ads.time, "sleep", lambda seconds: slept.append(seconds))
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    graph.routes[("GET", RESULTS[ACCOUNT])] = _ok({"data": []})
    graph.route_page(PAGE_A)
    _admin_read()
    _client().page_access_token(PAGE_A)
    _results_read(ACCOUNT)
    assert slept == []  # neither lane waited for the admin lane's clock
    _admin_read()
    assert len(slept) == 1 and 0 < slept[0] <= 0.75  # the admin lane still paces its own calls


def _lanes_used(monkeypatch, call):
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())
    monkeypatch.setattr(meta_ads, "_META_LAST_REMOTE_REQUEST_AT", "")
    call()
    return {name for name, lane in meta_ads.lane_state_report()["lanes"].items() if lane["lastRequestAt"]}


def test_every_caller_keeps_its_lane(graph, monkeypatch):
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    graph.routes[("GET", RESULTS[ACCOUNT])] = _ok({"data": []})
    graph.routes[("POST", CAMPAIGN)] = _ok({"success": True})
    graph.routes[("GET", f"{PAGE_A}/posts")] = _ok({"data": []})
    graph.routes[("POST", f"{PAGE_A}/feed")] = _ok({"id": f"{PAGE_A}_5"})
    graph.route_page(PAGE_A)
    client = _client()
    # Admin by default: every caller from before the lanes, the system-token POST too (rename, unlink).
    assert _lanes_used(monkeypatch, _admin_read) == {"admin"}
    assert _lanes_used(monkeypatch, lambda: client._post(CAMPAIGN, {"name": "ALB-S-K7M2P9QX · Offer"})) == {"admin"}
    assert _lanes_used(monkeypatch, lambda: client._request("GET", ADMIN_PATH, params={})) == {"admin"}
    # The page lane: the Page token read, Page-token posts and replies, the studio post readers.
    assert _lanes_used(monkeypatch, lambda: client.page_access_token(PAGE_A)) == {"page"}
    token = client.page_access_token(PAGE_A)
    assert _lanes_used(monkeypatch, lambda: client._post(f"{PAGE_A}/feed", {"message": "Hi"}, access_token=token)) == {"page"}
    assert _lanes_used(monkeypatch, lambda: meta_ads.read_page_recent_posts(PAGE_A)) == {"page"}
    assert _lanes_used(monkeypatch, lambda: _reply(PAGE_A)) == {"page"}
    # The studio_results lane: a meta_call_lane block, or the request's own lane=.
    assert _lanes_used(monkeypatch, lambda: _results_read(ACCOUNT)) == {"studio_results"}
    assert _lanes_used(
        monkeypatch, lambda: client._request("GET", RESULTS[ACCOUNT], params={}, lane="studio_results")
    ) == {"studio_results"}
    with pytest.raises(meta_ads.MetaAdsError) as unknown:
        client._request("GET", ADMIN_PATH, params={}, lane="fast")
    assert unknown.value.code == "invalid_request"
    with pytest.raises(meta_ads.MetaAdsError):
        with meta_ads.meta_call_lane("fast"):
            pass


# ---------------------------------------------------------------------------
# P3-00b: per-lane back-off, classified by Meta's documented codes and usage types
# ---------------------------------------------------------------------------


def test_usage_high_ads_header_does_not_block_reply(graph):
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []}, _buc(ACCOUNT, "ads_management", 93))
    graph.routes[("GET", f"act_{ACCOUNT}")] = _ok({"id": f"act_{ACCOUNT}"})
    graph.route_page(PAGE_A)
    _admin_read()
    # The admin lane pauses itself as before the lanes (usage_high, 8 minutes at 93%).
    assert meta_ads._meta_remote_backoff_remaining() >= 400
    assert meta_ads.studio_meta_pause_seconds() >= 400
    assert meta_ads._public_meta_provider_state()["reason"] == "usage_high"
    _refused_locally(_admin_read)
    assert graph.count("GET", ADMIN_PATH) == 1
    # The headroom exception still lets the owner's small reads through.
    assert _client()._get(f"act_{ACCOUNT}", {"fields": "id"}, use_headroom=True)["id"] == f"act_{ACCOUNT}"
    # A reply still sends: the page lane is not paused by an ads allowance.
    actions, errors, _retryable = _reply(PAGE_A)
    assert actions == ["public"] and errors == []
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_A) == 0
    report = meta_ads.lane_state_report()
    assert report["lanes"]["admin"]["paused"] is True and report["lanes"]["admin"]["reason"] == "usage_high"
    assert report["lanes"]["page"]["paused"] is False and report["appWide"]["paused"] is False
    assert report["lanes"]["page"]["parkCount"] == 0


def test_admin_ads_throttle_code_does_not_block_reply(graph):
    """The admin 80004 pause of test_meta_ads.py (regain time respected) while a reply sends."""
    graph.routes[("GET", ADMIN_PATH)] = _refused(80004, _buc(ACCOUNT, "ads_management", 100, regain_minutes=4))
    graph.route_page(PAGE_A)
    with pytest.raises(meta_ads.MetaAdsError) as limited:
        _admin_read()
    assert limited.value.code == "rate_limited" and limited.value.provider_code == "80004"
    assert meta_ads._meta_remote_backoff_remaining() >= 200
    assert meta_ads._public_meta_provider_state()["reason"] == "meta_80004"
    _refused_locally(_admin_read)
    actions, errors, _retryable = _reply(PAGE_A)
    assert actions == ["public"] and errors == []
    assert meta_ads.lane_state_report()["appWide"]["paused"] is False


@pytest.mark.parametrize("lane,code", [("page", 17), ("admin", 4), ("studio_results", 613)])
def test_app_wide_code_pauses_all_lanes(graph, lane, code):
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    for account_id, path in RESULTS.items():
        graph.routes[("GET", path)] = _ok({"data": []})
    graph.route_page(PAGE_A)
    graph.route_page(PAGE_B)
    if lane == "page":
        graph.route_page(PAGE_A, reply=_refused(code))
        actions, errors, retryable = _reply(PAGE_A)
        assert actions == [] and retryable is True and f"({code})" in errors[0]
    elif lane == "admin":
        graph.routes[("GET", ADMIN_PATH)] = _refused(code)
        with pytest.raises(meta_ads.MetaAdsError) as limited:
            _admin_read()
        assert limited.value.provider_code == str(code)
    else:
        graph.routes[("GET", RESULTS[ACCOUNT])] = _refused(code)
        with pytest.raises(meta_ads.MetaAdsError) as limited:
            _results_read(ACCOUNT)
        assert limited.value.provider_code == str(code)
    seen = len(graph.seen)
    # Every lane now waits, and nothing more reaches Meta.
    _refused_locally(_admin_read)
    _refused_locally(lambda: _results_read(ACCOUNT_2))
    actions, errors, retryable = _reply(PAGE_B)
    assert actions == [] and retryable is True
    assert len(graph.seen) == seen
    report = meta_ads.lane_state_report()
    assert report["appWide"]["paused"] is True and report["appWide"]["reason"] == f"meta_{code}"
    assert 30 <= report["appWide"]["retryAfterSeconds"] <= 60
    assert all(report["lanes"][name]["paused"] for name in meta_ads.META_LANES)
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_B) > 0
    assert meta_ads.meta_lane_pause_seconds("studio_results", ACCOUNT_2) > 0
    assert meta_ads.studio_meta_pause_seconds() > 0


def test_buc_keyed_by_object_parks_one_page(graph):
    graph.route_page(PAGE_A, reply=_ok({"id": "c1"}, _buc(PAGE_A, "pages", 96, regain_minutes=5)))
    graph.route_page(PAGE_B)
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    graph.routes[("GET", RESULTS[ACCOUNT])] = _ok({"data": []})
    actions, _errors, _retryable = _reply(PAGE_A)
    assert actions == ["public"]  # sent; Meta says page A is close to its limit
    seen = len(graph.seen)
    actions, _errors, retryable = _reply(PAGE_A)
    assert actions == [] and retryable is True and len(graph.seen) == seen  # page A waits, nothing sent
    actions, errors, _retryable = _reply(PAGE_B)
    assert actions == ["public"] and errors == []  # page B keeps replying
    # Nothing else waits: not the admin lane, not the results lane, not the page lane as a whole.
    assert meta_ads._meta_remote_backoff_remaining() == 0
    _admin_read()
    _results_read(ACCOUNT)
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_A) > 240
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_B) == 0
    report = meta_ads.lane_state_report()
    page = report["lanes"]["page"]
    assert page["paused"] is False and page["parkCount"] == 1 and report["appWide"]["paused"] is False
    assert page["parks"][0]["object"] == f"…{PAGE_A[-4:]}" and page["parks"][0]["reason"] == "usage_high"
    assert 240 < page["parks"][0]["retryAfterSeconds"] <= 300
    assert page["parks"][0]["usagePercent"] == 96
    _no_ids_or_tokens(report)


@pytest.mark.parametrize("code", [32, 80001, 80002, 80006])
def test_page_throttle_code_parks_only_that_page(graph, code):
    graph.route_page(PAGE_A, reply=_refused(code))
    graph.route_page(PAGE_B)
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    actions, errors, retryable = _reply(PAGE_A)
    assert actions == [] and retryable is True and f"({code})" in errors[0]
    seen = len(graph.seen)
    assert _reply(PAGE_A)[0] == [] and len(graph.seen) == seen
    assert _reply(PAGE_B)[0] == ["public"]
    _admin_read()
    report = meta_ads.lane_state_report()
    assert report["lanes"]["admin"]["paused"] is False and report["appWide"]["paused"] is False
    parks = report["lanes"]["page"]["parks"]
    assert [(park["object"], park["reason"]) for park in parks] == [(f"…{PAGE_A[-4:]}", f"meta_{code}")]


def test_admin_page_code_keeps_the_admin_pause_and_parks_the_page(graph):
    graph.routes[("GET", PAGE_A)] = _refused(32)  # Manager's page-name read
    graph.route_page(PAGE_B)
    with pytest.raises(meta_ads.MetaAdsError):
        _client()._get(PAGE_A, {"fields": "id,name,category"})
    assert meta_ads._meta_remote_backoff_remaining() > 0  # the admin lane, as before the lanes
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_A) > 0  # the same page waits on the page lane
    assert _reply(PAGE_B)[0] == ["public"]
    assert meta_ads.lane_state_report()["appWide"]["paused"] is False


@pytest.mark.parametrize("headers", [
    _buc(PAGE_A, "some_future_use_case", 90),
    {"x-business-use-case-usage": json.dumps({PAGE_A: [{"call_count": 90, "total_time": 5}]})},
    {"x-business-use-case-usage": json.dumps([{"type": "pages", "call_count": 90}])},
    {"x-app-usage": json.dumps({"call_count": 90, "total_cputime": 20, "total_time": 20})},
], ids=["unknown-type", "missing-type", "unknown-shape", "x-app-usage"])
def test_unknown_usage_type_is_app_wide(graph, headers):
    graph.route_page(PAGE_A, reply=_ok({"id": "c1"}, headers))
    graph.route_page(PAGE_B)
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    assert _reply(PAGE_A)[0] == ["public"]
    seen = len(graph.seen)
    _refused_locally(_admin_read)
    _refused_locally(lambda: _results_read(ACCOUNT))
    assert _reply(PAGE_B)[0] == []
    assert len(graph.seen) == seen
    report = meta_ads.lane_state_report()
    assert report["appWide"]["paused"] is True and report["appWide"]["reason"] == "usage_high"
    assert report["lanes"]["admin"]["reason"] == "usage_high" and report["lanes"]["page"]["paused"] is True
    assert 150 <= report["appWide"]["retryAfterSeconds"] <= 180  # 90%: three minutes


def test_usage_below_the_threshold_pauses_nothing(graph):
    graph.route_page(PAGE_A, reply=_ok({"id": "c1"}, _buc(PAGE_A, "some_future_use_case", 70)))
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []}, _buc(ACCOUNT, "ads_insights", 80))
    assert _reply(PAGE_A)[0] == ["public"]
    _admin_read()
    _admin_read()
    report = meta_ads.lane_state_report()
    assert not any(lane["paused"] or lane["parkCount"] for lane in report["lanes"].values())
    assert report["lanes"]["page"]["usagePercent"] == 70 and report["lanes"]["admin"]["usagePercent"] == 80


def test_ads_usage_on_the_page_lane_pauses_only_the_admin_lane(graph):
    graph.route_page(PAGE_A, reply=_ok({"id": "c1"}, _buc(ACCOUNT, "ads_insights", 95)))
    graph.route_page(PAGE_B)
    assert _reply(PAGE_A)[0] == ["public"]
    assert meta_ads._meta_remote_backoff_remaining() > 0
    assert _reply(PAGE_B)[0] == ["public"]
    assert meta_ads.meta_lane_pause_seconds("studio_results", ACCOUNT) == 0
    assert meta_ads.lane_state_report()["appWide"]["paused"] is False


def test_studio_results_ads_limit_parks_one_account(graph):
    graph.routes[("GET", RESULTS[ACCOUNT])] = _refused(80000, _buc(ACCOUNT, "ads_insights", 100, regain_minutes=7))
    graph.routes[("GET", RESULTS[ACCOUNT_2])] = _ok({"data": []})
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    graph.route_page(PAGE_A)
    with pytest.raises(meta_ads.MetaAdsError) as limited:
        _results_read(ACCOUNT)
    assert limited.value.provider_code == "80000"
    seen = len(graph.seen)
    _refused_locally(lambda: _results_read(ACCOUNT))
    assert len(graph.seen) == seen
    _results_read(ACCOUNT_2)  # another account keeps going on the same lane
    _admin_read()  # the admin lane is not paused by the studio lane's limit
    assert _reply(PAGE_A)[0] == ["public"]
    assert meta_ads.meta_lane_pause_seconds("studio_results", ACCOUNT) > 360
    assert meta_ads.meta_lane_pause_seconds("studio_results", ACCOUNT_2) == 0
    assert meta_ads.meta_lane_pause_seconds("admin") == 0
    results = meta_ads.lane_state_report()["lanes"]["studio_results"]
    assert results["paused"] is False and results["parkCount"] == 1
    assert results["parks"][0]["object"] == f"…{ACCOUNT[-4:]}" and results["parks"][0]["reason"] == "meta_80000"


def test_studio_results_usage_header_parks_the_named_account(graph):
    graph.routes[("GET", RESULTS[ACCOUNT])] = _ok({"data": []}, _buc(ACCOUNT, "ads_insights", 93))
    graph.routes[("GET", RESULTS[ACCOUNT_2])] = _ok({"data": []}, {"x-ad-account-usage": json.dumps({"acc_id_util_pct": 91})})
    graph.routes[("GET", ADMIN_PATH)] = _ok({"data": []})
    _results_read(ACCOUNT)
    _results_read(ACCOUNT_2)  # X-Ad-Account-Usage names no object: the account the call was for
    _refused_locally(lambda: _results_read(ACCOUNT))
    _refused_locally(lambda: _results_read(ACCOUNT_2))
    _admin_read()
    parks = meta_ads.lane_state_report()["lanes"]["studio_results"]["parks"]
    assert sorted(park["object"] for park in parks) == sorted(f"…{a[-4:]}" for a in (ACCOUNT, ACCOUNT_2))


# ---------------------------------------------------------------------------
# P3-00c: lane state persisted like metaProviderState and shown for diagnostics
# ---------------------------------------------------------------------------


def _restart(monkeypatch):
    """A new process: everything held in memory is gone; only the stored rows remain."""
    for name, value in (
        ("_META_REMOTE_BACKOFF_UNTIL", 0.0), ("_META_REMOTE_BACKOFF_REASON", ""), ("_META_REMOTE_USAGE_PERCENT", 0),
        ("_META_PROVIDER_STATE_REFRESHED_AT", 0.0), ("_META_LANE_STATE_REFRESHED_AT", 0.0),
        ("_META_APP_WIDE_UNTIL", 0.0), ("_META_APP_WIDE_REASON", ""),
    ):
        monkeypatch.setattr(meta_ads, name, value)
    monkeypatch.setattr(meta_ads, "_META_LANE_STATES", _fresh_lanes())
    meta_ads._PAGE_TOKEN_CACHE.clear()


def test_lane_state_persists(graph, monkeypatch):
    graph.route_page(PAGE_A, reply=_refused(80001))
    graph.route_page(PAGE_B)
    graph.routes[("GET", RESULTS[ACCOUNT])] = _refused(80000)
    assert _reply(PAGE_A)[0] == []
    with pytest.raises(meta_ads.MetaAdsError):
        _results_read(ACCOUNT)
    stored = _stored_lane_row()
    assert stored is not None and stored["created_by"] is None  # a system row
    _no_ids_or_tokens(json.loads(stored["data_json"]))
    before = meta_ads.lane_state_report()

    _restart(monkeypatch)
    assert meta_ads.lane_state_report()["lanes"]["page"]["parkCount"] == 0  # nothing in memory yet
    report = meta_ads.lane_state_report(refresh=True)
    for lane in ("page", "studio_results"):
        assert report["lanes"][lane]["parkCount"] == 1
        assert report["lanes"][lane]["parks"][0]["object"] == before["lanes"][lane]["parks"][0]["object"]
        assert report["lanes"][lane]["parks"][0]["reason"] == before["lanes"][lane]["parks"][0]["reason"]
        assert 0 < report["lanes"][lane]["parks"][0]["retryAfterSeconds"] <= 60
    assert report["lanes"]["page"]["parks"][0]["object"] == f"…{PAGE_A[-4:]}"
    assert report["lanes"]["studio_results"]["parks"][0]["object"] == f"…{ACCOUNT[-4:]}"
    _no_ids_or_tokens(report)
    # The restored parks still hold, before anything reaches Meta; the rest keeps going.
    _restart(monkeypatch)
    seen = len(graph.seen)
    assert _reply(PAGE_A)[0] == []
    _refused_locally(lambda: _results_read(ACCOUNT))
    assert len(graph.seen) == seen
    assert _reply(PAGE_B)[0] == ["public"]


def test_app_wide_pause_survives_a_restart(graph, monkeypatch):
    graph.route_page(PAGE_A, reply=_refused(4))
    graph.route_page(PAGE_B)
    assert _reply(PAGE_A)[0] == []
    _restart(monkeypatch)
    report = meta_ads.lane_state_report(refresh=True)
    assert report["appWide"]["paused"] is True and report["appWide"]["reason"] == "meta_4"
    assert report["lanes"]["admin"]["paused"] is True
    seen = len(graph.seen)
    _restart(monkeypatch)
    assert _reply(PAGE_B)[0] == [] and len(graph.seen) == seen


def test_stored_parks_merge_across_processes(graph, monkeypatch):
    graph.route_page(PAGE_A, reply=_refused(80001))
    graph.route_page(PAGE_B, reply=_refused(80001))
    assert _reply(PAGE_A)[0] == []
    # Another process that has not read the stored row yet parks page B: page A's park is kept.
    _restart(monkeypatch)
    monkeypatch.setattr(meta_ads, "_META_LANE_STATE_REFRESHED_AT", time.monotonic())
    assert _reply(PAGE_B)[0] == []
    parks = json.loads(_stored_lane_row()["data_json"])["lanes"]["page"]["parks"]
    assert sorted(park["object"] for park in parks) == sorted(f"…{p[-4:]}" for p in (PAGE_A, PAGE_B))
    assert all(set(park) == {"key", "object", "untilMs", "reason", "usagePercent"} for park in parks)


def test_ended_parks_are_forgotten(graph, monkeypatch):
    graph.route_page(PAGE_A, reply=_refused(80001))
    assert _reply(PAGE_A)[0] == []
    assert meta_ads.lane_state_report()["lanes"]["page"]["parkCount"] == 1
    clock = time.monotonic() + 61  # Meta's default wait (60 s) has passed
    monkeypatch.setattr(meta_ads.time, "monotonic", lambda: clock)
    monkeypatch.setattr(meta_ads, "now_ms", lambda: int(time.time() * 1000) + 61_000)
    assert meta_ads.meta_lane_pause_seconds("page", PAGE_A) == 0
    report = meta_ads.lane_state_report(refresh=True)
    assert report["lanes"]["page"]["parkCount"] == 0
