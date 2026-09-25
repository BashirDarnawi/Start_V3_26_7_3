"""Studio health: admin facts and Meta check buttons (Albayan Studio plan tasks P0-05c, P0-05d, P0-05e).

Every Meta call is faked (MetaAdsClient._request is replaced); nothing here reaches the network.
Each test starts from empty tables for the record types it counts and puts back what was there,
so the counts never depend on rows left by other modules.
"""

import json
import os
import re
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
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_facts
from server.systems.ads_studio.studio_facts import private_reply_failures, reply_facts, tripoli_day

ROOT = Path(__file__).resolve().parent.parent
TAG = secrets.token_hex(4)
PASSWORD = "StudioFactsPassword123!"
client = TestClient(app, headers={"Origin": "http://testserver"})
API = "/api/studio/admin"
CAMPAIGNS = "adCampaignRequests"
# Record types these tests count or write: emptied before each test, restored after it
# (metaProviderState: a Meta pause stored by another process).
TYPES = ("socialPages", "socialReplyLog", CAMPAIGNS, "ads", "metaHealthState", "metaFundsState", "metaProviderState")
ACCOUNT_A, ACCOUNT_B = "111111111234", "222222225678"
APP_ID = "999000111"
FB_PAGE, FB_PAGE_2, FB_PAGE_3, IG_PAGE_FB = "5100000000001", "5100000000002", "5100000000003", "5100000000004"
IG_USER = "17841400000000001"
SECRET_NAME = f"Secret Page Name {TAG}"
SECRET_TEXT = f"secret comment text {TAG}"
DAY_1 = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
DAY_2 = datetime(2026, 9, 26, 10, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    password_hash = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    user_id = new_id("facts_user")
    email = f"studio-facts-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {
                "id": user_id, "name": f"Facts {label}", "email": email, "role": role,
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


@pytest.fixture(scope="module")
def actors():
    init_db()
    return {
        "admin": _insert_user("admin", "Admin", {}),
        "staff": _insert_user("staff", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "customer": _insert_user("customer", "Employee", {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
    }


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
        body = dict(params or {}) if method == "GET" else dict(data or {})
        self.calls.append((method, path, body, access_token))
        answer = self.routes.get((method, path))
        if answer is None:
            raise AssertionError(f"unexpected Graph {method} {path}")
        if isinstance(answer, Exception):
            raise answer
        return answer(body) if callable(answer) else answer

    def paths(self, method=None):
        return [path for m, path, _body, _token in self.calls if method is None or m == method]


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request", lambda self, method, path, **kw: fake.request(method, path, **kw))
    for page in (FB_PAGE, FB_PAGE_2, FB_PAGE_3, IG_PAGE_FB):
        fake.routes[("GET", page)] = {"id": page, "access_token": f"PAGE-TOKEN-{page}"}
    return fake


@pytest.fixture(autouse=True)
def _clean(actors, monkeypatch):
    saved = {entity_type: _rows_of(entity_type) for entity_type in TYPES}
    for entity_type in TYPES:
        _replace_rows(entity_type, [])
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "app-secret-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT_A},{ACCOUNT_B}")
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    for name in ("_META_REMOTE_BACKOFF_REASON", "_META_REMOTE_USAGE_PERCENT"):
        monkeypatch.setattr(meta_ads, name, getattr(meta_ads, name))  # put back after the test
    monkeypatch.setattr(meta_ads, "_META_PROVIDER_STATE_REFRESHED_AT", 0.0)
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_1)
    meta_ads._PAGE_TOKEN_CACHE.clear()
    for user in actors.values():
        for bucket in ("facts", "facts-refresh", "fact-tests"):
            reset_rate_limit(f"studio:{bucket}:{user['id']}")
    yield
    meta_ads._PAGE_TOKEN_CACHE.clear()
    for entity_type, rows in saved.items():
        _replace_rows(entity_type, rows)


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


def _page(actors, page_id: str, meta_page_id: str, platform: str = "fb", ig_user_id: str = "", *, deleted=False) -> str:
    owner = actors["customer"]["id"]
    _insert("socialPages", page_id, {
        "ownerId": owner, "metaPageId": meta_page_id, "platform": platform, "igUserId": ig_user_id,
        "name": SECRET_NAME, "healthy": True,
    }, owner=owner, deleted=deleted)
    return page_id


def _log(actors, log_id: str, *, platform="fb", actions=(), error="", from_id="", days_ago=0.0) -> None:
    owner = actors["customer"]["id"]
    created = now_ms() - int(days_ago * 86_400_000)
    _insert("socialReplyLog", log_id, {
        "ownerId": owner, "pageId": "spg_x", "metaPageId": FB_PAGE, "platform": platform, "ruleId": "srule_x",
        "commentId": f"c_{log_id}", "postId": "post_1", "fromId": from_id, "actions": list(actions),
        "processing": False, "at": "2026-09-20T10:00:00Z", "error": error, "text": SECRET_TEXT,
    }, owner=owner, created_at=created)


def _error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code and detail["message"]
    return detail


def _audit_rows(user_id: str, action: str, started: int) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text(
                "SELECT action, resource_type, resource_id, metadata_json FROM audit_logs "
                "WHERE user_id=:u AND action=:a AND ts >= :started ORDER BY ts"
            ),
            {"u": user_id, "a": action, "started": started},
        ).mappings().all()
    return [{**dict(r), "metadata": json_loads(r["metadata_json"] or "{}")} for r in rows]


def _facts(actors, *, refresh=False, **kwargs):
    suffix = "?refresh=1" if refresh else ""
    return client.get(f"{API}/facts{suffix}", cookies=actors["admin"]["cookies"], **kwargs)


def _seed_facts(actors) -> None:
    # (b) and (g): Facebook reply log rows of the last 30 days, one older row, one Instagram row.
    _log(actors, "srl_1", actions=["public"], from_id="person_a")
    _log(actors, "srl_2", actions=["public", "like"], from_id="person_b")
    _log(actors, "srl_3", actions=["public"], from_id="person_a")
    _log(actors, "srl_4", actions=["public"], error="dm: Meta authorization failed. Reconnect the access token. (190.460)",
         from_id="person_c")
    _log(actors, "srl_5", actions=[],
         error="dm: This person isn't available right now; try later (551); public: Meta is temporarily unavailable. Albayan will retry. (2)",
         from_id="person_d")
    _log(actors, "srl_6", actions=["dm"], from_id="person_e")
    _log(actors, "srl_7", actions=[], error="dm: Meta is temporarily limiting synchronization. Albayan will retry.", from_id="person_f")
    _log(actors, "srl_old", actions=["public"], error="dm: Meta could not be reached. Albayan will retry.", days_ago=40,
         from_id="person_g")
    _log(actors, "srl_ig", platform="ig", actions=["public"], error="dm: Meta did not answer in time. Albayan will retry.",
         from_id="person_h")
    # (c): daily-budget requests by status; archived and lifetime ones apart.
    owner = actors["customer"]["id"]
    for index, (status, budget, deleted) in enumerate((
        ("Submitted", "daily", False), ("Submitted", "Daily", False), ("Draft", "daily", False),
        ("Approved", "daily", False), ("Approved", "lifetime", False), ("Stopped", "daily", True), ("Weird", "daily", False),
    )):
        _insert(CAMPAIGNS, f"campaign_facts_{TAG}_{index}", {"status": status, "budgetType": budget, "name": SECRET_NAME},
                owner=owner, deleted=deleted)
    # (s): Manager's core ads with a confirmed final spend.
    def ad(ad_id, **data):
        _insert("ads", ad_id, {"customerName": SECRET_NAME, **data})

    ad("ad_up", finalSpendConfirmedAt="2026-09-10T12:00:00Z", finalSpendMetaMinorAtConfirmation=1000,
       finalSpendMetaCurrencyAtConfirmation="USD", metaSpendMinor=1150, metaCurrency="USD",
       metaSyncedAt="2026-09-12T12:00:00Z", metaEndTime="2026-09-10T00:00:00Z")
    ad("ad_same", finalSpendConfirmedAt="2026-09-10T12:00:00Z", finalSpendMetaMinorAtConfirmation=2000,
       finalSpendMetaCurrencyAtConfirmation="USD", metaSpendMinor=2000, metaCurrency="USD",
       metaSyncedAt="2026-09-11T12:00:00Z", metaEndTime="2026-09-09T12:00:00Z")
    ad("ad_down", finalSpendConfirmedAt="2026-09-10T12:00:00Z", finalSpendMetaMinorAtConfirmation=500,
       finalSpendMetaCurrencyAtConfirmation="USD", metaSpendMinor=450, metaCurrency="USD",
       metaSyncedAt="2026-09-15T12:00:00Z", metaEndTime="2026-09-12T12:00:00Z")  # confirmed before the planned end
    ad("ad_not_resynced", finalSpendConfirmedAt="2026-09-10T12:00:00Z", finalSpendMetaMinorAtConfirmation=700,
       metaSpendMinor=900, metaCurrency="USD", metaSyncedAt="2026-09-10T11:00:00Z")
    ad("ad_other_currency", finalSpendConfirmedAt="2026-09-10T12:00:00Z", finalSpendMetaMinorAtConfirmation=700,
       finalSpendMetaCurrencyAtConfirmation="EUR", metaSpendMinor=800, metaCurrency="USD", metaSyncedAt="2026-09-12T12:00:00Z")
    ad("ad_no_evidence", finalSpendConfirmedAt="2026-09-10T12:00:00Z", metaSpendMinor=800, metaSyncedAt="2026-09-12T12:00:00Z")
    ad("ad_never_confirmed", metaSpendMinor=800, metaSyncedAt="2026-09-12T12:00:00Z")
    # (n1): the last stored funds reading; a third account is not allowlisted and is left out.
    _insert("metaFundsState", "accounts", {"updatedAt": "2026-09-25T08:00:00Z", "accounts": [
        {"id": ACCOUNT_A, "name": SECRET_NAME, "currency": "USD", "isPrepay": True, "fundsText": "Available Balance ($200.00 USD)",
         "fundsMinor": 20000, "fundsHidden": False},
        {"id": ACCOUNT_B, "name": SECRET_NAME, "error": "Meta authorization failed. Reconnect the access token."},
        {"id": "333333339999", "name": SECRET_NAME, "currency": "LYD", "isPrepay": False, "fundsText": "", "fundsHidden": True},
    ]})


def _assert_no_personal_data(payload, actors, *extra: str) -> None:
    dumped = json.dumps(payload, ensure_ascii=False)
    forbidden = [SECRET_NAME, SECRET_TEXT, ACCOUNT_A, ACCOUNT_B, "333333339999", FB_PAGE, FB_PAGE_2, FB_PAGE_3, IG_PAGE_FB,
                 IG_USER, "person_a", "spg_", "srl_", "campaign_facts", "ad_up", actors["customer"]["id"], "PAGE-TOKEN",
                 "system-token", "app-secret", *extra]
    leaks = [value for value in forbidden if value in dumped]
    assert not leaks, f"personal data or ids in the payload: {leaks}"


# ---------------------------------------------------------------------------
# P0-05c facts
# ---------------------------------------------------------------------------


def test_facts_and_checks_are_admin_only(actors, graph):
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    for who in ("staff", "customer"):
        cookies = actors[who]["cookies"]
        _error(client.get(f"{API}/facts", cookies=cookies), 403, "ADMIN_ONLY")
        _error(client.get(f"{API}/facts?refresh=1", cookies=cookies), 403, "ADMIN_ONLY")
        _error(client.post(f"{API}/pages/spg_fb_1/subscribe-test", cookies=cookies), 403, "ADMIN_ONLY")
        _error(client.post(f"{API}/instagram/spg_ig_1/read-test", cookies=cookies), 403, "ADMIN_ONLY")
    client.cookies.clear()
    assert client.get(f"{API}/facts").status_code == 401
    assert client.post(f"{API}/pages/spg_fb_1/subscribe-test").status_code == 401
    # Writes and the Meta refresh must come from the Albayan site itself.
    evil = {"Origin": "https://evil.example"}
    _error(client.post(f"{API}/pages/spg_fb_1/subscribe-test", cookies=actors["admin"]["cookies"], headers=evil), 403, "CROSS_SITE")
    _error(client.post(f"{API}/instagram/spg_ig_1/read-test", cookies=actors["admin"]["cookies"], headers=evil), 403, "CROSS_SITE")
    _error(_facts(actors, refresh=True, headers=evil), 403, "CROSS_SITE")
    assert graph.calls == []  # nothing refused reached Meta


def test_fact_reads_counts_only(actors, graph):
    _seed_facts(actors)
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_ig_1", FB_PAGE, "ig", IG_USER)  # the same Meta page as Instagram: one page to check
    _page(actors, "spg_gone", FB_PAGE_2, deleted=True)
    response = _facts(actors)
    assert response.status_code == 200, response.text
    payload = response.json()
    facts = payload["facts"]
    assert graph.calls == []  # a plain read never calls Meta
    assert facts["b"] == {
        "windowDays": 30, "rowsWithFailure": 3, "failures": 3, "privateRepliesSent": 1,
        "byClass": {"authorization": 1, "request_failed": 1, "rate_limited": 1},
        "byCode": {"190.460": 1, "551": 1, "none": 1},
    }
    assert facts["g"]["publicRepliesWithoutError"] == 3 and facts["g"]["distinctCommenters"] == 2
    assert facts["g"]["staffExcluded"] is False and "cannot be told apart" in facts["g"]["note"]
    assert facts["c"]["total"] == 5 and facts["c"]["archived"] == 1
    assert facts["c"]["byStatus"] == {"Draft": 1, "Submitted": 2, "Changes Requested": 0, "Approved": 1, "Rejected": 0,
                                      "Stopped": 0, "other": 1}
    assert facts["d"] == {"allowlistConfigured": True}
    assert facts["n1"]["allowlistConfigured"] is True and facts["n1"]["readAt"] == "2026-09-25T08:00:00Z"
    assert facts["n1"]["accounts"] == [
        {"account": "…1234", "isPrepay": True, "fundsTextPresent": True, "currency": "USD", "fundsHidden": False, "readError": False},
        {"account": "…5678", "isPrepay": None, "fundsTextPresent": False, "currency": "", "fundsHidden": False, "readError": True},
    ]
    s = facts["s"]
    assert (s["confirmed"], s["withMetaEvidence"], s["resyncedAfterConfirmation"], s["compared"], s["currencyMismatch"]) == (6, 5, 4, 3, 1)
    assert (s["unchanged"], s["higher"], s["lower"], s["confirmedBeforeEnd"]) == (1, 1, 1, 1)
    assert s["driftMinor"] == {"sample": 3, "p50": 50, "p90": 150, "p95": 150, "max": 150}
    assert s["driftPercent"]["sample"] == 3 and s["driftPercent"]["max"] == 15.0
    assert s["hoursEndToConfirmation"] == {"sample": 2, "p50": 12.0, "p90": 24.0, "p95": 24.0, "max": 24.0}
    assert facts["i"]["linkedPages"] == 1 and facts["i"]["checked"] is False and facts["i"]["stale"] is True
    assert facts["f"]["checked"] is False and payload["meta"]["configured"] is True
    assert facts["m"]["total"] == 0 and "rows" not in facts["m"]  # (m) is counts only
    _assert_no_personal_data(payload, actors)


def test_allowlist_flag_and_unconfigured_meta(actors, graph, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    payload = _facts(actors, refresh=True).json()
    assert payload["facts"]["d"] == {"allowlistConfigured": False}
    assert payload["meta"] == {"configured": False, "refreshed": False, "busy": False, "paused": False,
                               "retryAfterSeconds": 0, "valuesRead": 0, "maxAgeSeconds": 86400}
    assert graph.calls == []  # no Meta connection: nothing is read, and nothing fails


def test_meta_facts_cache_vs_refresh(actors, graph):
    started = now_ms()
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_fb_2", FB_PAGE_2)
    _page(actors, "spg_fb_3", FB_PAGE_3)
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = {"currency": "USD", "min_daily_budget": 100}
    graph.routes[("GET", f"act_{ACCOUNT_B}")] = meta_ads.MetaAdsError("request_failed", "Not allowed", provider_code="200")
    graph.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = {"data": [
        {"id": APP_ID, "name": SECRET_NAME, "subscribed_fields": ["feed", "messages"]}]}
    graph.routes[("GET", f"{FB_PAGE_2}/subscribed_apps")] = {"data": [
        {"id": "123", "name": "Another app", "subscribed_fields": ["feed"]}]}  # another app is not Albayan's
    graph.routes[("GET", f"{FB_PAGE_3}/subscribed_apps")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190")

    before = _facts(actors).json()["facts"]
    assert before["f"]["checked"] is False and before["i"]["checked"] is False and graph.calls == []

    refreshed = _facts(actors, refresh=True)
    assert refreshed.status_code == 200, refreshed.text
    payload = refreshed.json()
    assert payload["meta"]["refreshed"] is True and payload["meta"]["paused"] is False
    assert payload["meta"]["valuesRead"] == 3  # account A and two pages; B and page 3 were refused
    f, i = payload["facts"]["f"], payload["facts"]["i"]
    assert f["checked"] is True and f["stale"] is False and f["ageSeconds"] <= 5
    read_at = f["accounts"][0]["readAt"]
    assert read_at == f["checkedAt"] and f["triedAt"] == f["checkedAt"]
    assert f["accounts"] == [
        {"account": "…1234", "currency": "USD", "minDailyBudget": 100, "unit": "minor", "errorCode": "", "providerCode": "",
         "readAt": read_at, "kept": False},
        {"account": "…5678", "currency": "", "minDailyBudget": None, "unit": "minor", "errorCode": "request_failed",
         "providerCode": "200", "readAt": "", "kept": False},
    ]
    assert (i["subscribed"], i["notSubscribed"], i["error"], i["errorCodes"], i["kept"]) == (1, 1, 1, {"authorization": 1}, 0)
    assert i["pagesChecked"] == 3 and i["notChecked"] == 0 and i["appIdConfigured"] is True and i["linkedPages"] == 3
    assert "pages" not in i  # the per-page rows (hashed keys) stay on the server
    # The subscribed_apps reads used each page's own token.
    tokens = {path: token for method, path, _body, token in graph.calls if path.endswith("/subscribed_apps")}
    assert tokens == {f"{page}/subscribed_apps": f"PAGE-TOKEN-{page}" for page in (FB_PAGE, FB_PAGE_2, FB_PAGE_3)}
    _assert_no_personal_data(payload, actors)
    audits = _audit_rows(actors["admin"]["id"], "studio_facts_refresh", started)
    assert len(audits) == 1 and audits[0]["metadata"]["accountsRead"] == 2 and audits[0]["metadata"]["pagesChecked"] == 3

    # A plain read answers from the 24-hour store, with its age, and never calls Meta.
    calls = len(graph.calls)
    cached = _facts(actors).json()["facts"]
    assert len(graph.calls) == calls
    assert cached["f"]["accounts"] == f["accounts"] and cached["i"]["subscribed"] == 1 and cached["f"]["stale"] is False
    # Two refreshes per 10 minutes per admin.
    assert _facts(actors, refresh=True).status_code == 200
    limited = _facts(actors, refresh=True)
    _error(limited, 429, "RATE_LIMITED")
    assert int(limited.headers["Retry-After"]) > 60
    # Older than 24 hours: shown, but marked stale.
    old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat().replace("+00:00", "Z")
    meta_ads.save_meta_health_state("studioFacts", lambda current: {
        **current, "minDailyBudget": {**current["minDailyBudget"], "checkedAt": old}})
    aged = _facts(actors).json()["facts"]["f"]
    assert aged["checked"] is True and aged["stale"] is True and aged["ageSeconds"] >= 25 * 3600


def test_page_subscription_read_uses_page_tokens(actors, graph):
    _page(actors, "spg_fb_3", FB_PAGE_3)
    graph.routes[("GET", FB_PAGE_3)] = meta_ads.MetaAdsError("authorization", "x", provider_code="190")
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = {"currency": "USD", "min_daily_budget": "100"}
    graph.routes[("GET", f"act_{ACCOUNT_B}")] = meta_ads.MetaAdsError("rate_limited", "wait", retryable=True, provider_code="80004")
    payload = _facts(actors, refresh=True).json()["facts"]
    assert payload["i"]["error"] == 1 and payload["i"]["errorCodes"] == {"authorization": 1}
    assert f"{FB_PAGE_3}/subscribed_apps" not in graph.paths()  # no page token, no read with the system token
    assert payload["f"]["accounts"][1]["errorCode"] == "rate_limited"


LOCAL_PAUSE_TEXT = "Meta synchronization is paused safely and will resume automatically."


def _local_pause():
    """The refusal MetaAdsClient._request raises itself while the Meta pause runs (no Meta code)."""
    return meta_ads.MetaAdsError("rate_limited", LOCAL_PAUSE_TEXT, retryable=True)


def _seed_good_reading(actors, graph) -> dict:
    """A first refresh: A 100 USD, B 200 EUR; page 1 subscribed, page 2 not, page 3 refused (no page token)."""
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_fb_2", FB_PAGE_2)
    _page(actors, "spg_fb_3", FB_PAGE_3)
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = {"currency": "USD", "min_daily_budget": 100}
    graph.routes[("GET", f"act_{ACCOUNT_B}")] = {"currency": "EUR", "min_daily_budget": 200}
    graph.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = {"data": [{"id": APP_ID, "subscribed_fields": ["feed"]}]}
    graph.routes[("GET", f"{FB_PAGE_2}/subscribed_apps")] = {"data": []}
    graph.routes[("GET", FB_PAGE_3)] = meta_ads.MetaAdsError("authorization", "x", provider_code="190")
    first = _facts(actors, refresh=True).json()
    assert first["meta"]["refreshed"] is True and first["meta"]["valuesRead"] == 4
    assert (first["facts"]["i"]["subscribed"], first["facts"]["i"]["notSubscribed"], first["facts"]["i"]["error"]) == (1, 1, 1)
    return first


def _refresh_again(actors) -> dict:
    reset_rate_limit(f"studio:facts-refresh:{actors['admin']['id']}")  # 2 refreshes per 10 minutes
    response = _facts(actors, refresh=True)
    assert response.status_code == 200, response.text
    return response.json()


def test_refresh_while_meta_is_paused_keeps_the_stored_reading(actors, graph, monkeypatch):
    started = now_ms()
    first = _seed_good_reading(actors, graph)
    stored = meta_ads.load_meta_health_state("studioFacts")
    calls = len(graph.calls)
    meta_ads._set_meta_remote_backoff(600, reason="meta_80004")
    paused = _refresh_again(actors)
    assert len(graph.calls) == calls  # Meta was not asked at all
    meta = paused["meta"]
    assert meta["paused"] is True and meta["refreshed"] is False and meta["busy"] is False and meta["valuesRead"] == 0
    assert 500 < meta["retryAfterSeconds"] <= 600
    # The saved 24-hour reading is shown as it was: no error rows, not marked as read now.
    assert paused["facts"]["f"] == {**first["facts"]["f"], "ageSeconds": paused["facts"]["f"]["ageSeconds"]}
    assert paused["facts"]["i"]["checkedAt"] == first["facts"]["i"]["checkedAt"]
    assert meta_ads.load_meta_health_state("studioFacts") == stored
    audit = _audit_rows(actors["admin"]["id"], "studio_facts_refresh", started)[-1]["metadata"]
    assert audit["paused"] is True and audit["refreshed"] is False and audit["valuesRead"] == 0
    # A pause another process stored (metaProviderState) counts too.
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    _insert("metaProviderState", "global", {"recordType": "metaProviderState", "backoffUntilMs": now_ms() + 300_000,
                                            "backoffReason": "meta_4"})
    monkeypatch.setattr(meta_ads, "_META_PROVIDER_STATE_REFRESHED_AT", 0.0)
    other = _refresh_again(actors)["meta"]
    assert other["paused"] is True and 200 < other["retryAfterSeconds"] <= 300 and len(graph.calls) == calls


def test_refresh_keeps_the_last_good_values_per_row(actors, graph):
    first = _seed_good_reading(actors, graph)
    first_f, first_i = first["facts"]["f"], first["facts"]["i"]
    # Second refresh: A is read again; B times out; page 1 gets a 5xx, so pages 2 and 3 wait.
    calls = len(graph.calls)
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = {"currency": "USD", "min_daily_budget": 150}
    graph.routes[("GET", f"act_{ACCOUNT_B}")] = meta_ads.MetaAdsError("timeout", "late", retryable=True)
    graph.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError("temporary", "x", retryable=True, provider_code="2")
    second = _refresh_again(actors)
    meta, f, i = second["meta"], second["facts"]["f"], second["facts"]["i"]
    assert meta["refreshed"] is True and meta["valuesRead"] == 1 and meta["paused"] is False
    a, b = f["accounts"]
    assert (a["currency"], a["minDailyBudget"], a["errorCode"], a["kept"]) == ("USD", 150, "", False)
    assert a["readAt"] == f["checkedAt"] and f["checkedAt"] >= first_f["checkedAt"]
    # B keeps its earlier values (and their time), with the new error beside them.
    assert b == {**first_f["accounts"][1], "errorCode": "timeout", "providerCode": "", "kept": True}
    assert b["currency"] == "EUR" and b["minDailyBudget"] == 200
    # Pages: 1 and 2 keep their last good state; 3 never had one, so it stays an error.
    assert (i["subscribed"], i["notSubscribed"], i["error"], i["kept"]) == (1, 1, 1, 2)
    assert i["errorCodes"] == {"temporary": 3}
    assert i["checkedAt"] == first_i["checkedAt"]  # no page answered: the block's time did not move
    assert f"{FB_PAGE_2}/subscribed_apps" not in graph.paths()[calls:]  # after a retryable error the rest wait
    assert all("key" not in row for row in f["accounts"]) and "pages" not in i
    _assert_no_personal_data(second, actors)
    stored = json.dumps(meta_ads.load_meta_health_state("studioFacts"))
    assert not any(value in stored for value in (ACCOUNT_A, ACCOUNT_B, FB_PAGE, FB_PAGE_2, FB_PAGE_3))  # keys are hashes

    # Third refresh: nothing answers (Meta limit on A, so B waits; a local pause on the pages).
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = meta_ads.MetaAdsError("rate_limited", "x", retryable=True, provider_code="80004")
    graph.routes[("GET", f"{FB_PAGE}/subscribed_apps")] = _local_pause()  # (the page token is cached)
    third = _refresh_again(actors)
    assert third["meta"]["refreshed"] is False and third["meta"]["valuesRead"] == 0
    a3, b3 = third["facts"]["f"]["accounts"]
    assert (a3["minDailyBudget"], a3["errorCode"], a3["providerCode"], a3["kept"]) == (150, "rate_limited", "80004", True)
    assert (b3["minDailyBudget"], b3["errorCode"], b3["kept"]) == (200, "rate_limited", True)
    assert third["facts"]["f"]["checkedAt"] == f["checkedAt"]
    assert (third["facts"]["i"]["subscribed"], third["facts"]["i"]["notSubscribed"]) == (1, 1)
    assert third["facts"]["i"]["errorCodes"] == {"rate_limited": 3}

    # Fourth refresh: an answer that is not retryable replaces the row (the old values are gone).
    graph.routes[("GET", f"act_{ACCOUNT_A}")] = meta_ads.MetaAdsError("authorization", "x", provider_code="190")
    graph.routes[("GET", f"act_{ACCOUNT_B}")] = {"currency": "EUR", "min_daily_budget": 250}
    fourth = _refresh_again(actors)["facts"]["f"]["accounts"]
    assert fourth[0] == {"account": "…1234", "currency": "", "minDailyBudget": None, "unit": "minor",
                         "errorCode": "authorization", "providerCode": "190", "readAt": "", "kept": False}
    assert (fourth[1]["minDailyBudget"], fourth[1]["errorCode"], fourth[1]["kept"]) == (250, "", False)


def test_private_reply_failure_parsing():
    assert private_reply_failures("") == []
    assert private_reply_failures("public: Meta is temporarily unavailable. Albayan will retry. (2)") == []
    assert private_reply_failures("dm: Meta authorization failed. Reconnect the access token. (190.460)") == [("authorization", "190.460")]
    # Meta's own text may hold "; " and brackets: only the trailing (code) is the code.
    mixed = "dm: Sorry; this (odd) text (10.2018278); public: Meta did not answer in time. Albayan will retry.; like: x (4)"
    assert private_reply_failures(mixed) == [("request_failed", "10.2018278")]
    assert private_reply_failures("Albayan's Meta token cannot manage this page. Reconnect the access token.") == []
    b, g = reply_facts([
        {"platform": "fb", "actions": ["dm", "public"], "error": "", "fromId": "x"},
        {"platform": "fb", "actions": ["public"], "error": " ", "fromId": "y"},
        {"platform": "ig", "actions": ["public"], "error": "", "fromId": "z"},
    ])
    assert b["privateRepliesSent"] == 1 and b["failures"] == 0
    assert g["publicRepliesWithoutError"] == 2 and g["distinctCommenters"] == 2  # a blank error is no error; IG is left out


def test_error_classes_match_the_client_texts():
    """The (b) class map reads MetaAdsError texts: every text in it must still exist in meta_ads.py."""
    source = (ROOT / "server" / "meta_ads.py").read_text(encoding="utf-8")
    body = source.split("_PUBLIC_MESSAGE_CLASSES = {", 1)[1].split("}", 1)[0]
    for message in re.findall(r'^\s+"(.+?)": "[a-z_]+",$', body, re.MULTILINE):
        assert f'"{message}"' in source.replace(body, ""), f"'{message}' is no longer a MetaAdsError text"


# ---------------------------------------------------------------------------
# P0-05d subscribe test
# ---------------------------------------------------------------------------


def test_subscribe_test_admin_audited(actors, graph, monkeypatch):
    started = now_ms()
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_ig_same", FB_PAGE, "ig", IG_USER)
    graph.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    admin = actors["admin"]["cookies"]
    first = client.post(f"{API}/pages/spg_fb_1/subscribe-test", cookies=admin)
    assert first.status_code == 200, first.text
    assert first.json() == {"ok": True, "errorCode": "", "providerCode": "", "testedOn": tripoli_day(DAY_1), "fields": ["feed"]}
    posts = [(path, body, token) for method, path, body, token in graph.calls if method == "POST"]
    assert posts == [(f"{FB_PAGE}/subscribed_apps", {"subscribed_fields": "feed"}, f"PAGE-TOKEN-{FB_PAGE}")]
    audits = _audit_rows(actors["admin"]["id"], "subscribe_smoke_test", started)
    assert len(audits) == 1 and audits[0]["resource_type"] == "socialPages" and audits[0]["resource_id"] == "spg_fb_1"
    assert audits[0]["metadata"]["ok"] is True and audits[0]["metadata"]["day"] == tripoli_day(DAY_1)
    # Same Meta page, same Tripoli day (also through its Instagram row): refused, Meta not called.
    for page_id in ("spg_fb_1", "spg_ig_same"):
        _error(client.post(f"{API}/pages/{page_id}/subscribe-test", cookies=admin), 409, "ALREADY_TESTED_TODAY")
    assert len([m for m, *_ in graph.calls if m == "POST"]) == 1
    assert len(_audit_rows(actors["admin"]["id"], "subscribe_smoke_test", started)) == 1
    # The next Tripoli day it may run again; a Meta refusal is reported as a code and still uses the day.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    graph.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError(
        "request_failed", "(#200) Permissions error", provider_code="200")
    failed = client.post(f"{API}/pages/spg_fb_1/subscribe-test", cookies=admin)
    assert failed.status_code == 200 and failed.json()["ok"] is False
    assert failed.json()["errorCode"] == "request_failed" and failed.json()["providerCode"] == "200"
    assert "Permissions" not in failed.text  # Meta's own text is never returned
    _error(client.post(f"{API}/pages/spg_fb_1/subscribe-test", cookies=admin), 409, "ALREADY_TESTED_TODAY")
    _assert_no_personal_data(first.json(), actors)


def test_subscribe_test_refusals(actors, graph, monkeypatch):
    _page(actors, "spg_gone", FB_PAGE, deleted=True)
    _page(actors, "spg_fb_2", FB_PAGE_2)
    admin = actors["admin"]["cookies"]
    for page_id in ("spg_gone", "spg_missing", "bad%20id"):
        _error(client.post(f"{API}/pages/{page_id}/subscribe-test", cookies=admin), 404, "UNKNOWN_PAGE")
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    _error(client.post(f"{API}/pages/spg_fb_2/subscribe-test", cookies=admin), 409, "META_NOT_CONFIGURED")
    # Nothing ran, so the day is still free.
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "system-token-never-leaks")
    graph.routes[("POST", f"{FB_PAGE_2}/subscribed_apps")] = {"success": True}
    assert client.post(f"{API}/pages/spg_fb_2/subscribe-test", cookies=admin).json()["ok"] is True
    assert graph.calls and all(path in (FB_PAGE_2, f"{FB_PAGE_2}/subscribed_apps") for path in graph.paths())


def test_two_presses_at_once_claim_once(actors):
    today = tripoli_day(DAY_1)
    studio_facts.claim("subscribe", "sft_key", {"day": today, "state": "running"}, today, per_day=True)
    with pytest.raises(studio_facts._Taken):
        studio_facts.claim("subscribe", "sft_key", {"day": today, "state": "running"}, today, per_day=True)
    # A write race (another press saved first) is retried against the fresh record, then refused.
    real_save = meta_ads.save_meta_health_state
    raced = []

    def racing_save(state_id, update):
        if not raced:
            raced.append(True)
            real_save(state_id, lambda current: {**current, "igRead": {"sft_other": {"day": today, "state": "running"}}})
            raise RuntimeError("conflict: the record changed")
        return real_save(state_id, update)

    meta_ads.save_meta_health_state = racing_save
    try:
        with pytest.raises(studio_facts._Taken):
            studio_facts.claim("igRead", "sft_other", {"day": today, "state": "running"}, today, per_day=True)
    finally:
        meta_ads.save_meta_health_state = real_save
    stored = meta_ads.load_meta_health_state("studioFactTests")
    assert set(stored["subscribe"]) == {"sft_key"} and set(stored["igRead"]) == {"sft_other"}
    # Old days are dropped from the record.
    later = (DAY_1 + timedelta(days=5)).date().isoformat()
    studio_facts.claim("subscribe", "sft_new", {"day": later, "state": "running"}, later, per_day=True)
    assert set(meta_ads.load_meta_health_state("studioFactTests")["subscribe"]) == {"sft_new"}
    # A claim is given back only while it still holds the named state.
    studio_facts.release("subscribe", "sft_new", later, state="done")
    assert set(meta_ads.load_meta_health_state("studioFactTests")["subscribe"]) == {"sft_new"}
    studio_facts.release("subscribe", "sft_new", later, state="running")
    assert meta_ads.load_meta_health_state("studioFactTests")["subscribe"] == {}


def test_checks_refused_while_meta_is_paused_keep_the_day(actors, graph, monkeypatch):
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph)
    graph.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = {"success": True}
    admin = actors["admin"]["cookies"]
    subscribe_url, ig_url = f"{API}/pages/spg_fb_1/subscribe-test", f"{API}/instagram/spg_ig_1/read-test"
    meta_ads._set_meta_remote_backoff(120, reason="meta_4")
    for url in (subscribe_url, ig_url):
        refused = client.post(url, cookies=admin)
        _error(refused, 409, "META_PAUSED")
        assert 60 < int(refused.headers["Retry-After"]) <= 120
    assert graph.calls == [] and meta_ads.load_meta_health_state("studioFactTests") == {}  # no claim was taken
    # The pause ends: both tests run the same Tripoli day.
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    assert client.post(subscribe_url, cookies=admin).json()["ok"] is True
    assert client.post(ig_url, cookies=admin).json()["commentsRead"] == 3


def test_a_pause_that_begins_during_a_test_gives_the_day_back(actors, graph):
    _page(actors, "spg_fb_1", FB_PAGE)
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    admin = actors["admin"]["cookies"]
    subscribe_url, ig_url = f"{API}/pages/spg_fb_1/subscribe-test", f"{API}/instagram/spg_ig_1/read-test"
    graph.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = _local_pause()
    graph.routes[("GET", f"{IG_USER}/media")] = _local_pause()
    _error(client.post(subscribe_url, cookies=admin), 409, "META_PAUSED")
    _error(client.post(ig_url, cookies=admin), 409, "META_PAUSED")
    claims = meta_ads.load_meta_health_state("studioFactTests")
    assert claims["subscribe"] == {} and claims["igRead"] == {}
    # Meta's own limit carries Meta's code: the call reached Meta, so that test used the day.
    graph.routes[("POST", f"{FB_PAGE}/subscribed_apps")] = meta_ads.MetaAdsError(
        "rate_limited", "Meta is temporarily limiting synchronization. Albayan will retry.", retryable=True, provider_code="80004")
    limited = client.post(subscribe_url, cookies=admin).json()
    assert limited["ok"] is False and limited["errorCode"] == "rate_limited" and limited["providerCode"] == "80004"
    _error(client.post(subscribe_url, cookies=admin), 409, "ALREADY_TESTED_TODAY")
    # The pause is over: the Instagram test runs the same day.
    _ig_graph(graph)
    assert client.post(ig_url, cookies=admin).json()["commentsRead"] == 3


# ---------------------------------------------------------------------------
# P0-05e Instagram read test
# ---------------------------------------------------------------------------


def _ig_graph(graph, comments_by_media=None):
    comments_by_media = comments_by_media or {
        "9001": [{"id": "18000000000000001", "timestamp": "2026-09-24T08:00:00+0000", "text": f"hello {SECRET_TEXT}"},
                 {"id": "18000000000000002", "timestamp": "2026-09-24T09:00:00+0000", "text": "test ALB-7731 please"}],
        "9002": [{"id": "18000000000000003", "timestamp": "2026-09-23T09:00:00+0000", "text": "old ALB-5500"}],
    }
    graph.routes[("GET", f"{IG_USER}/media")] = {"data": [
        {"id": "9001", "comments_count": 2, "timestamp": "2026-09-24T07:00:00+0000"},
        {"id": "9002", "comments_count": 1, "timestamp": "2026-09-23T07:00:00+0000"},
        {"id": "9003", "comments_count": 0, "timestamp": "2026-09-22T07:00:00+0000"},
    ]}
    for media_id, rows in comments_by_media.items():
        graph.routes[("GET", f"{media_id}/comments")] = (
            lambda body, rows=rows: {"data": [{k: v for k, v in r.items() if k in body["fields"].split(",")} for r in rows]})
    return graph


def test_ig_read_test_admin_audited_once(actors, graph, monkeypatch):
    started = now_ms()
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _page(actors, "spg_fb_1", FB_PAGE)
    _ig_graph(graph)
    admin = actors["admin"]["cookies"]
    _error(client.post(f"{API}/instagram/spg_fb_1/read-test", cookies=admin), 409, "NOT_INSTAGRAM")
    _error(client.post(f"{API}/instagram/spg_nope/read-test", cookies=admin), 404, "UNKNOWN_PAGE")
    response = client.post(f"{API}/instagram/spg_ig_1/read-test", cookies=admin)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result == {
        "testedOn": tripoli_day(DAY_1), "mediaRead": 3, "mediaWithComments": 2, "commentsRead": 3, "errorCode": "",
        "providerCode": "", "replyRequested": False, "replyTargetFound": None, "replyMatchCount": None, "replySent": False,
        "alreadyReplied": False, "replyState": "", "replyErrorCode": "",
    }
    # Read with the system token; texts were not even asked for without a code to match.
    reads = [(path, body, token) for method, path, body, token in graph.calls if method == "GET"]
    assert all(token is None for _path, _body, token in reads)
    assert all("text" not in body.get("fields", "") for path, body, _token in reads if path.endswith("/comments"))
    assert [m for m, *_ in graph.calls if m == "POST"] == []
    _assert_no_personal_data(result, actors, "18000000000000001", "9001")
    audits = _audit_rows(actors["admin"]["id"], "ig_read_test", started)
    assert len(audits) == 1 and audits[0]["resource_id"] == "spg_ig_1" and audits[0]["metadata"]["commentsRead"] == 3
    assert SECRET_TEXT not in audits[0]["metadata_json"] and "18000000000000001" not in audits[0]["metadata_json"]
    _error(client.post(f"{API}/instagram/spg_ig_1/read-test", cookies=admin), 409, "ALREADY_TESTED_TODAY")
    assert len(_audit_rows(actors["admin"]["id"], "ig_read_test", started)) == 1
    # A Meta refusal on the next day is a code, never Meta's text.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    graph.routes[("GET", f"{IG_USER}/media")] = meta_ads.MetaAdsError("request_failed", "(#10) secret", provider_code="10")
    failed = client.post(f"{API}/instagram/spg_ig_1/read-test", cookies=admin).json()
    assert failed["errorCode"] == "request_failed" and failed["providerCode"] == "10" and failed["commentsRead"] == 0


def test_ig_reply_is_sent_at_most_once(actors, graph, monkeypatch):
    started = now_ms()
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph)
    graph.routes[("POST", "18000000000000002/replies")] = {"id": "18000000000000099"}
    admin = actors["admin"]["cookies"]
    body = {"replyToCommentId": "18000000000000002", "text": "Thank you from Albayan"}
    first = client.post(f"{API}/instagram/spg_ig_1/read-test", json=body, cookies=admin).json()
    assert first["replyRequested"] is True and first["replyTargetFound"] is True and first["replySent"] is True
    assert first["replyState"] == "sent" and first["replyMatchCount"] == 1
    posts = [(path, b, token) for method, path, b, token in graph.calls if method == "POST"]
    assert posts == [("18000000000000002/replies", {"message": "Thank you from Albayan"}, f"PAGE-TOKEN-{IG_PAGE_FB}")]
    _assert_no_personal_data(first, actors, "18000000000000002", "Thank you from Albayan")
    audit = _audit_rows(actors["admin"]["id"], "ig_read_test", started)[0]
    assert audit["metadata"]["replySent"] is True and "Thank you" not in audit["metadata_json"]
    # Another day, the same comment (named by id or found by its code): never sent again.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    again = client.post(f"{API}/instagram/spg_ig_1/read-test", json={"replyToCommentContaining": "alb-7731", "text": "Again"},
                        cookies=admin).json()
    assert again["replyTargetFound"] is True and again["alreadyReplied"] is True and again["replySent"] is False
    assert again["replyMatchCount"] == 1 and again["replyState"] == ""
    assert len([m for m, *_ in graph.calls if m == "POST"]) == 1
    # The code search asked Meta for the texts and found the one comment holding the code.
    assert any("text" in b.get("fields", "") for m, path, b, _t in graph.calls if path.endswith("/comments"))


def test_ig_reply_target_and_body_checks(actors, graph, monkeypatch):
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph)
    admin = actors["admin"]["cookies"]
    url = f"{API}/instagram/spg_ig_1/read-test"
    for bad, code in (
        ({"text": "no target"}, "INVALID_REQUEST"),
        ({"replyToCommentId": "18000000000000002"}, "INVALID_VALUE"),
        ({"replyToCommentId": "abc", "text": "x"}, "INVALID_VALUE"),
        ({"replyToCommentId": "1", "replyToCommentContaining": "abc", "text": "x"}, "INVALID_REQUEST"),
        ({"replyToCommentContaining": "ab", "text": "x"}, "INVALID_VALUE"),
        ({"replyToCommentContaining": "7731", "text": "x"}, "INVALID_VALUE"),       # shorter than 6
        ({"replyToCommentContaining": "thanks!", "text": "x"}, "INVALID_VALUE"),    # no digit: not distinctive
        ({"replyToCommentContaining": "a" * 40 + "1", "text": "x"}, "INVALID_VALUE"),  # longer than 40
        ({"replyToCommentId": "1", "text": "x" * 301}, "INVALID_VALUE"),
        ({"replyToCommentId": "1", "text": "x", "extra": 1}, "UNKNOWN_FIELD"),
        ([1, 2], "INVALID_REQUEST"),
    ):
        reset_rate_limit(f"studio:fact-tests:{actors['admin']['id']}")  # 10 presses a minute, refused ones included
        _error(client.post(url, json=bad, cookies=admin), 400, code)
    assert graph.calls == []  # refused before the day was used or Meta was asked
    reset_rate_limit(f"studio:fact-tests:{actors['admin']['id']}")
    # A comment that is not among the ones read is never answered (only this account's recent comments).
    missing = client.post(url, json={"replyToCommentId": "18000000000000777", "text": "Hi"}, cookies=admin).json()
    assert missing["replyTargetFound"] is False and missing["replySent"] is False and missing["replyErrorCode"] == "comment_not_found"
    assert [m for m, *_ in graph.calls if m == "POST"] == []
    # A reply that timed out may have landed: it is kept as sent-or-unknown and never retried.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    graph.routes[("POST", "18000000000000001/replies")] = meta_ads.MetaAdsError("timeout", "late", retryable=True)
    timed_out = client.post(url, json={"replyToCommentId": "18000000000000001", "text": "Hi"}, cookies=admin).json()
    assert timed_out["replySent"] is False and timed_out["replyErrorCode"] == "timeout"
    assert timed_out["replyState"] == "unknown"  # the screen says it may have been sent
    replies = meta_ads.load_meta_health_state("studioFactTests")["igReplies"]
    assert [entry["state"] for entry in replies.values()] == ["unknown"]
    assert not any(IG_USER in key or "18000000000000001" in key for key in replies)  # keys are hashes
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2 + timedelta(days=1))
    third = client.post(url, json={"replyToCommentId": "18000000000000001", "text": "Hi"}, cookies=admin).json()
    assert third["alreadyReplied"] is True and len([m for m, *_ in graph.calls if m == "POST"]) == 1


def test_ig_reply_needs_exactly_one_matching_comment(actors, graph, monkeypatch):
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph, {
        "9001": [{"id": "18000000000000001", "timestamp": "2026-09-24T08:00:00+0000", "text": "first ALB-8842"},
                 {"id": "18000000000000002", "timestamp": "2026-09-24T09:00:00+0000", "text": "second alb-8842 too"}],
        "9002": [{"id": "18000000000000003", "timestamp": "2026-09-23T09:00:00+0000", "text": "ALB-9911 here"}],
    })
    for comment in ("18000000000000001", "18000000000000002", "18000000000000003"):
        graph.routes[("POST", f"{comment}/replies")] = {"id": "18000000000000099"}
    admin = actors["admin"]["cookies"]
    url = f"{API}/instagram/spg_ig_1/read-test"
    # Two recent comments hold the code: nothing is sent, and the count says why.
    ambiguous = client.post(url, json={"replyToCommentContaining": "ALB-8842", "text": "Hi"}, cookies=admin).json()
    assert ambiguous["replyTargetFound"] is False and ambiguous["replySent"] is False and ambiguous["replyState"] == ""
    assert ambiguous["replyErrorCode"] == "ambiguous_match" and ambiguous["replyMatchCount"] == 2
    assert graph.paths("POST") == [] and meta_ads.load_meta_health_state("studioFactTests")["igReplies"] == {}
    # One match, but a read that stopped early: the unread comments may hold the code too.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    graph.routes[("GET", "9002/comments")] = meta_ads.MetaAdsError("temporary", "x", retryable=True, provider_code="2")
    partial = client.post(url, json={"replyToCommentContaining": "first alb-8842", "text": "Hi"}, cookies=admin).json()
    assert partial["errorCode"] == "temporary" and partial["replyMatchCount"] == 1
    assert partial["replyTargetFound"] is False and partial["replyErrorCode"] == "comments_not_read"
    assert graph.paths("POST") == []
    # Exactly one match in a complete read: that comment is answered.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2 + timedelta(days=1))
    _ig_graph(graph, {"9001": [{"id": "18000000000000001", "timestamp": "2026-09-24T08:00:00+0000", "text": "x"}],
                      "9002": [{"id": "18000000000000003", "timestamp": "2026-09-23T09:00:00+0000", "text": "ALB-9911 here"}]})
    one = client.post(url, json={"replyToCommentContaining": "alb-9911", "text": "Hi"}, cookies=admin).json()
    assert one["replySent"] is True and one["replyState"] == "sent" and one["replyMatchCount"] == 1
    assert graph.paths("POST") == ["18000000000000003/replies"]


@pytest.mark.parametrize("error, state, given_back", [
    (meta_ads.MetaAdsError("authorization", "x", provider_code="190"), "failed", True),
    (meta_ads.MetaAdsError("rate_limited", "x", retryable=True, provider_code="80004"), "failed", True),
    (meta_ads.MetaAdsError("rate_limited", LOCAL_PAUSE_TEXT, retryable=True), "failed", True),
    (meta_ads.MetaAdsError("timeout", "x", retryable=True), "unknown", False),
    (meta_ads.MetaAdsError("network", "x", retryable=True), "unknown", False),
    (meta_ads.MetaAdsError("temporary", "x", retryable=True, provider_code="500"), "unknown", False),
    (meta_ads.MetaAdsError("invalid_response", "x"), "unknown", False),
    (meta_ads.MetaAdsError("request_failed", "x", provider_code="100"), "failed", False),
])
def test_ig_reply_claim_is_given_back_only_when_meta_applied_nothing(actors, graph, monkeypatch, error, state, given_back):
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph)
    graph.routes[("POST", "18000000000000002/replies")] = error
    admin = actors["admin"]["cookies"]
    url = f"{API}/instagram/spg_ig_1/read-test"
    body = {"replyToCommentId": "18000000000000002", "text": "Hi"}
    first = client.post(url, json=body, cookies=admin).json()
    assert first["replySent"] is False and first["replyState"] == state and first["replyErrorCode"] == error.code
    replies = meta_ads.load_meta_health_state("studioFactTests")["igReplies"]
    assert [entry["state"] for entry in replies.values()] == ([] if given_back else [state])
    # Another day, the same comment: answered only when the claim was given back.
    monkeypatch.setattr(studio_facts, "_now", lambda: DAY_2)
    graph.routes[("POST", "18000000000000002/replies")] = {"id": "18000000000000099"}
    second = client.post(url, json=body, cookies=admin).json()
    assert second["replySent"] is given_back and second["alreadyReplied"] is (not given_back)
    assert len(graph.paths("POST")) == (2 if given_back else 1)


def test_ig_reply_without_a_page_token_is_never_sent_and_given_back(actors, graph):
    _page(actors, "spg_ig_1", IG_PAGE_FB, "ig", IG_USER)
    _ig_graph(graph)
    graph.routes[("GET", IG_PAGE_FB)] = meta_ads.MetaAdsError("timeout", "late", retryable=True)
    result = client.post(f"{API}/instagram/spg_ig_1/read-test", json={"replyToCommentId": "18000000000000002", "text": "Hi"},
                         cookies=actors["admin"]["cookies"]).json()
    assert result["replySent"] is False and result["replyState"] == "failed" and result["replyErrorCode"] == "timeout"
    assert graph.paths("POST") == [] and meta_ads.load_meta_health_state("studioFactTests")["igReplies"] == {}


# ---------------------------------------------------------------------------
# Screens (src/systems/ads_studio/15i-studio-health.js)
# ---------------------------------------------------------------------------


def test_health_screen_is_admin_only_bilingual_and_lazy():
    source = (ROOT / "src" / "systems" / "ads_studio" / "15i-studio-health.js").read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "src" / "manifest.json").read_text(encoding="utf-8"))
    studio_files = manifest["lazy"]["studio.js"]
    assert studio_files.index("systems/ads_studio/15i-studio-health.js") > studio_files.index("systems/ads_studio/15f-social-studio.js")
    assert "systems/ads_studio/15i-studio-health.js" not in manifest["files"]
    assert "function renderStudioHealthSection()" in source and "if (!isCurrentUserAdmin()) return '';" in source
    assert "'/api/studio/admin/facts" in source and "'/api/meta-ads/token-health'" in source
    assert "/subscribe-test" in source and "/read-test" in source
    assert "apiJson(" in source and "fetch(" not in source
    assert not re.search(r"\b(confirm|prompt|alert)\(", source)  # no native dialogs
    assert not re.search(r"accessToken|access_token|appSecret|app_secret|password", source, re.IGNORECASE)
    assert len(re.findall(r"studioHealthText\(", source)) >= 40  # every label in English and Arabic
    review = (ROOT / "src" / "systems" / "ads_studio" / "15c-ads-studio.js").read_text(encoding="utf-8")
    assert "typeof renderStudioHealthSection === 'function'" in review
    assert b"\r\n" not in (ROOT / "src" / "systems" / "ads_studio" / "15i-studio-health.js").read_bytes()


def _js_function(source: str, name: str) -> str:
    start = source.index(f"function {name}(")
    return source[start:source.index("\n}\n", start)]


def test_health_screen_session_reset_pause_reply_states_and_labels():
    source = (ROOT / "src" / "systems" / "ads_studio" / "15i-studio-health.js").read_text(encoding="utf-8")
    review = (ROOT / "src" / "systems" / "ads_studio" / "15c-ads-studio.js").read_text(encoding="utf-8")
    # A session change for the same admin resets the health screen (like Social Studio's reset) ...
    reset = _js_function(review, "resetAdsStudioSessionState")
    assert "if (typeof resetStudioHealthState === 'function') resetStudioHealthState();" in reset
    # ... and every request clears its own flags whenever its generation is still current.
    for name in ("studioHealthEnsureLoaded", "studioHealthRefreshFacts", "studioHealthSubscribeTest", "studioHealthIgReadTest"):
        after_finally = _js_function(source, name).split("} finally {", 1)[1]
        assert after_finally.lstrip().startswith("if (studioHealthGenerationIsCurrent(context))"), name
    # The refresh note: paused, nothing new read, rows kept from an earlier reading.
    note = _js_function(source, "studioHealthRefreshNote")
    assert "meta.paused" in note and "showing the last reading" in note and "Nothing new was read from Meta" in note
    assert "META_PAUSED:" in source
    # The reply target: only a 15+ digit number is a comment id; a timed-out reply "may have been sent".
    assert "/^\\d{15,40}$/.test(target)" in source and "\\d{5," not in source
    result = _js_function(source, "studioHealthIgResultText")
    assert "result.replyState === 'unknown'" in result and "The reply may have been sent." in result
    assert "ambiguous_match" in result and "replyMatchCount" in result
    # Arabic view: classes, statuses and codes go through bilingual tables, never the raw key.
    assert "studioHealthCounts(b.byClass, studioHealthCodeLabel)" in source
    assert "studioHealthCounts(b.byCode, studioHealthProviderCodeLabel)" in source
    assert "studioHealthCounts(c.byStatus, studioHealthStatusLabel)" in source
    assert "studioHealthCounts(i.errorCodes, studioHealthCodeLabel)" in source
    assert "typeof adsStudioStatusMeta === 'function'" in _js_function(source, "studioHealthStatusLabel")
    fallback = _js_function(source, "studioHealthCodeLabel")
    assert "Object.prototype.hasOwnProperty.call(STUDIO_HEALTH_META_CODES" in fallback and '<span dir="ltr">' in fallback
    table = source.split("const STUDIO_HEALTH_META_CODES = {", 1)[1].split("\n};", 1)[0]
    labelled = set(re.findall(r"^  ([a-z_]+): \[", table, re.MULTILINE))
    assert all(re.search(r"[؀-ۿ]", line) for line in table.strip().splitlines())  # every label has Arabic
    meta_source = (ROOT / "server" / "meta_ads.py").read_text(encoding="utf-8")
    client_codes = set(re.findall(r'MetaAdsError\(\s*"([a-z_]+)"', meta_source))
    class_map = meta_source.split("_PUBLIC_MESSAGE_CLASSES = {", 1)[1].split("}", 1)[0]
    classes = set(re.findall(r'": "([a-z_]+)",$', class_map, re.MULTILINE))
    own = {"not_confirmed", "comment_not_found", "comments_not_read", "ambiguous_match"}
    # Albayan Manager's import/link flows, never a studio check (the generic label covers them anyway).
    manager_only = {"campaign_name_unknown", "discovery_failed", "duplicate_link", "no_accounts", "pending_enrichment",
                    "studio_campaign"}
    assert client_codes and classes
    assert not (client_codes - manager_only) - labelled and not classes - labelled and not own - labelled
    assert {"invalid_path", "response_too_large", "not_configured", "account_not_allowed"} <= labelled
    assert b"\r\n" not in (ROOT / "src" / "systems" / "ads_studio" / "15c-ads-studio.js").read_bytes()
