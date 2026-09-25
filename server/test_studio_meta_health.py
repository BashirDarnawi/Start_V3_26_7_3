"""P3-18a/b/c: the studio's Meta watch (server/systems/ads_studio/studio_alerts_meta.py).

* P3-18a: the daily token check from the jobs loop, the 14/7/2-day expiry alerts, and the global
  ``meta_connection_down`` state, set only when the token check says invalid (190.492 and the
  permission codes stay per-page), shown to customers as a neutral /api/studio/me flag.
* P3-18b: Social Studio replies Meta refused for authorization while the connection is down are
  parked (parkedReason, retryAfter, giveUpAt) and resent after the recovery; past giveUpAt they are
  missed_during_outage.
* P3-18c: the funds/status alerts of the ad accounts that carry studio campaigns.

Meta is always faked: Graph debug_token through httpx.MockTransport (as test_meta_token_health.py),
the reply calls through test_social_studio's FakeGraph, the funds through the stored metaFundsState.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.meta_token_health as token_health
from server.db import db_conn, json_dumps, json_field_sql, json_loads, now_ms
from server.systems.ads_studio import social_studio as studio
from server.systems.ads_studio import studio_alerts_meta as watch
from server.systems.ads_studio import studio_jobs
from server.systems.ads_studio.studio_results import write_results_row
from server.test_social_studio import (  # noqa: F401  (graph/_fresh are fixtures)
    APP_SECRET,
    SYSTEM_TOKEN,
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
    graph,
)

UTC = timezone.utc
TAG = secrets.token_hex(3)
APP_ID = "123456789012345"
MY_KINDS = ("meta_connection_down", "meta_token_expiring", "studio_funds_low", "studio_account_inactive",
            "studio_funds_unreadable")
AUTH_TOKEN_DEAD = ("authorization", "Meta authorization failed. Reconnect the access token.")


@pytest.fixture(scope="module")
def actors():  # the shape test_social_studio's autouse _fresh fixture expects
    from server.db import init_db

    init_db()
    out = {}
    for key, role, subscribed in (("admin", "Admin", False), ("a", "Employee", True)):
        email = f"meta-watch-{key}-{TAG}@tests.albayanhub.com"
        uid = _insert_user(f"Meta watch {key}", email, role)
        if subscribed:
            _subscribe(uid)
        out[key] = {"id": uid, "cookies": _login(email)}
    yield out
    _wipe_social_rows()  # no parked reply of this module reaches another module's retry pass
    _wipe_watch_state()


def _wipe_watch_state() -> None:
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id IN ('token', 'connection')"),
                     {"t": meta_ads._META_HEALTH_STATE_TYPE})
        for kind in MY_KINDS:
            conn.execute(text(f"DELETE FROM entities WHERE type = :t AND {json_field_sql('kind')} = :kind"),
                         {"t": studio_jobs.ALERTS_TYPE, "kind": kind})


@pytest.fixture()
def token(monkeypatch):
    """ALBAYAN_META_APP_ID set and a fake Graph debug_token: valid by default, never expiring."""
    monkeypatch.setenv("ALBAYAN_META_APP_ID", APP_ID)
    fake = {"requests": [], "valid": True, "code": None, "unreachable": False, "expires_at": 0, "data_expires_at": 0}

    def handler(request):
        assert request.url.path.endswith("/debug_token"), f"unexpected Graph call {request.url.path}"
        fake["requests"].append(request)
        if fake["unreachable"]:
            raise httpx.ConnectError("Meta is away", request=request)
        data = {"app_id": APP_ID, "type": "SYSTEM_USER", "application": "Albayan", "is_valid": fake["valid"],
                "expires_at": fake["expires_at"], "data_access_expires_at": fake["data_expires_at"],
                "scopes": ["pages_manage_engagement", "pages_messaging"]}
        if fake["code"]:
            code, _dot, sub = fake["code"].partition(".")
            data["error"] = {"code": int(code), "subcode": int(sub or 0), "message": "Error validating access token"}
        return httpx.Response(200, json={"data": data})

    real_client_class = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(token_health.httpx, "Client", lambda **kwargs: real_client_class(transport=transport, **kwargs))
    monkeypatch.setattr(token_health, "_LAST_CHECK", {"fingerprint": "", "at": 0.0})
    _wipe_watch_state()
    yield fake
    _wipe_watch_state()


def _ten_minutes_pass() -> None:
    """check_token_now reaches Meta at most once per 10 minutes (monotonic clock): let that pass."""
    token_health._LAST_CHECK["at"] = 0.0


def _alerts(kind: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text(f"SELECT data_json, created_by FROM entities WHERE type = :t AND {json_field_sql('kind')} = :kind"),
            {"t": studio_jobs.ALERTS_TYPE, "kind": kind},
        ).mappings().all()
    return [{**json_loads(row["data_json"]), "_createdBy": row["created_by"]} for row in rows]


def _stored_connection() -> tuple[dict, str]:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = 'connection'"),
                           {"t": meta_ads._META_HEALTH_STATE_TYPE}).mappings().first()
    return (json_loads(row["data_json"]) if row else {}), (row["data_json"] if row else "")


def _me(actors) -> dict:
    response = client.get("/api/studio/me", cookies=actors["a"]["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _meta_page_id() -> str:
    return f"59{secrets.randbelow(10**11):011d}"


def _row(log_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = 'socialReplyLog' AND id = :id"),
                           {"id": log_id}).mappings().first()
    return json_loads(row["data_json"])


def _dead_token_everywhere(graph) -> None:
    """Every reply call answers Meta's dead-token refusal (190.460: the password was changed)."""
    for suffix in ("/messages", "/comments", "/likes"):
        graph.fail[suffix] = meta_ads.MetaAdsError(*AUTH_TOKEN_DEAD, provider_code="190.460")


# ------------------------------------------------------------------ P3-18a: the connection state

def test_page_role_lost_is_not_global(actors, graph, token):
    """Two pages failing with 190.492 (the page role was lost): the token check runs ONCE (at most one
    per 10 minutes), says valid, so there is no global state; both stay per-page failures."""
    for meta_page_id in (_meta_page_id(), _meta_page_id()):
        _link(actors, "a", meta_page_id)
    _rule(actors["a"]["cookies"], name="Thanks", publicReply="Thanks!")
    graph.fail["/comments"] = meta_ads.MetaAdsError(*AUTH_TOKEN_DEAD, provider_code="190.492")
    pages = [row["data"]["metaPageId"] for row in studio._rows(studio.PAGES_TYPE, actors["a"]["id"])]
    for index, meta_page_id in enumerate(pages):
        _webhook(_fb_comment(meta_page_id, f"{meta_page_id}_{index}", f"90{index}", "hello"))
    assert len(token["requests"]) == 1  # two failures, one Meta check
    assert watch.connection_state()["state"] == "ok" and not watch.connection_down()
    assert _stored_connection()[0] == {}  # nothing written at all
    assert _me(actors)["metaConnection"] == {"down": False}
    logs = _log_rows(actors["a"]["id"])
    assert len(logs) == 2
    for log in logs:
        assert log["actions"] == [] and not log.get("retryAfter") and not log.get("parkedReason")
        assert "190.492" in log["error"]
    assert _alerts("meta_connection_down") == []
    assert watch.is_per_page_auth_code("190.492") and watch.is_per_page_auth_code("10") and watch.is_per_page_auth_code("200")
    assert watch.is_per_page_auth_code("") and not watch.is_per_page_auth_code("190.460")
    assert not watch.is_per_page_auth_code("190") and not watch.is_per_page_auth_code("102")


def test_invalid_token_sets_global_state(actors, token, caplog):
    token.update(valid=False, code="190.460")
    assert watch.after_authorization_failure() is True
    state = watch.connection_state()
    assert state["state"] == "down" and state["errorCode"] == "190.460" and state["since"]
    stored, raw = _stored_connection()
    assert stored["state"] == "down" and stored["lastDirectCheckAt"] == state["since"]
    # The customer sees a neutral flag only: no code, time or token fact.
    me = _me(actors)["metaConnection"]
    assert me["down"] is True and set(me) == {"down", "labels"} and me["labels"]["en"] and me["labels"]["ar"]
    assert "190" not in json.dumps(me) and "token" not in json.dumps(me).lower()
    [alert] = _alerts("meta_connection_down")
    assert alert["_createdBy"] is None and alert["relatedId"] == "token"  # a system alert (created_by NULL)
    assert alert["details"]["errorCode"] == "190.460" and alert["details"]["since"] == state["since"]
    listed = client.get("/api/studio/admin/alerts", cookies=actors["admin"]["cookies"]).json()["alerts"]
    shown = [row for row in listed if row["kind"] == "meta_connection_down"]
    assert shown and shown[0]["labels"]["en"] and shown[0]["labels"]["ar"]

    # A second failure within 10 minutes: no new Meta check, still down, no second alert.
    assert watch.after_authorization_failure() is True and len(token["requests"]) == 1
    # Meta unreachable is not a verdict: the state stays as it was.
    _ten_minutes_pass()
    token["unreachable"] = True
    assert watch.after_authorization_failure() is True and watch.connection_down()
    # A valid reading from BEFORE the outage never clears it.
    before = {"configured": True, "isValid": True, "checkedAt": "2020-01-01T00:00:00Z"}
    assert watch.apply_token_reading(before) == "down"
    # Recovery: the next check that says valid clears it.
    _ten_minutes_pass()
    token.update(unreachable=False, valid=True, code=None)
    assert watch.after_authorization_failure() is False
    state = watch.connection_state()
    assert state["state"] == "ok" and state["recoveredAt"] and state["since"] is None
    assert _me(actors)["metaConnection"] == {"down": False}
    # The token and the app secret appear nowhere.
    _stored, raw = _stored_connection()
    for secret in (SYSTEM_TOKEN, APP_SECRET):
        assert secret not in raw and secret not in json.dumps(_alerts("meta_connection_down")) and secret not in caplog.text


def test_unknown_check_never_sets_the_state(actors, token, monkeypatch):
    """No app id, or Meta unreachable: no verdict, so no outage is declared."""
    token["unreachable"] = True
    assert watch.after_authorization_failure() is False and not watch.connection_down()
    monkeypatch.delenv("ALBAYAN_META_APP_ID")
    _ten_minutes_pass()
    assert watch.after_authorization_failure() is False and not watch.connection_down()
    assert token_health.token_verdict({"configured": False}) == "unknown"
    assert token_health.token_verdict({"configured": True, "lastCheckError": "network"}) == "unknown"
    assert token_health.token_verdict(
        {"configured": True, "isValid": False, "checkedAt": "2026-09-01T00:00:00Z", "lastCheckErrorAt": "2026-09-02T00:00:00Z"}
    ) == "unknown"  # the latest check failed: the old answer is not today's
    assert token_health.token_verdict({"configured": True, "isValid": True, "errorCode": "190.463",
                                       "checkedAt": "2026-09-01T00:00:00Z"}) == "invalid"


def test_expiry_warnings_14_7_2(actors, token, monkeypatch):
    monkeypatch.setattr(watch, "_claim_funds_check", lambda now: False)
    now = datetime.now(UTC)
    token["expires_at"] = int((now + timedelta(days=7, hours=1)).timestamp())
    first = watch.run_meta_watch(now)
    assert first["token"] == "valid" and first["connection"] == "ok" and len(token["requests"]) == 1
    [related] = first["expiryAlerts"]
    assert related.startswith("expiresAt:") and related.endswith(":7d")
    [alert] = _alerts("meta_token_expiring")
    assert alert["details"]["thresholdDays"] == 7 and alert["details"]["daysLeft"] == 7 and alert["_createdBy"] is None
    # Once per threshold: the next turns (and the next day) raise nothing new for 7 days.
    assert watch.run_meta_watch(now + timedelta(minutes=10))["expiryAlerts"] == []
    assert len(token["requests"]) == 1  # the daily check did not call Meta again
    assert watch.run_meta_watch(now + timedelta(days=1))["expiryAlerts"] == []
    assert len(_alerts("meta_token_expiring")) == 1
    # 2 days left: the 2-day warning.
    _ten_minutes_pass()
    reading = token_health.check_token_now(max_age_seconds=0)
    assert watch.raise_expiry_alerts(reading, now + timedelta(days=5, hours=12)) == [related.replace(":7d", ":2d")]
    # A refreshed token (a new expiry) starts its warnings again.
    token["expires_at"] = int((now + timedelta(days=13)).timestamp())
    fresh = token_health.check_token_now(max_age_seconds=0)
    assert [item.endswith(":14d") for item in watch.raise_expiry_alerts(fresh, now)] == [True]
    # The pure computation: the smallest threshold reached, per expiry; never-expiring gives none.
    stamp = now.timestamp()

    def at(days: float) -> str:
        return (now + timedelta(days=days)).isoformat().replace("+00:00", "Z")

    def warned(days: float) -> list:
        reading = {"checkedAt": at(0), "expiresAt": at(days)}
        return [item["thresholdDays"] for item in token_health.expiry_warnings(reading, [14, 7, 2], stamp)]

    assert warned(20) == [] and warned(14.5) == [14] and warned(13) == [14] and warned(7.5) == [7]
    assert warned(6) == [7] and warned(2.5) == [2] and warned(1) == [2] and warned(-1) == [2]
    both = {"checkedAt": at(0), "expiresAt": at(30), "dataAccessExpiresAt": at(1), "expiresNever": False}
    assert [(w["field"], w["thresholdDays"]) for w in token_health.expiry_warnings(both, (14, 7, 2), stamp)] == [
        ("dataAccessExpiresAt", 2)]
    assert token_health.expiry_warnings({"checkedAt": at(0), "expiresAt": ""}, (14, 7, 2), stamp) == []
    assert token_health.expiry_warnings({"expiresAt": at(1)}, (14, 7, 2), stamp) == []  # never checked


def test_daily_check_runs_from_the_jobs_loop(actors, token, monkeypatch):
    """The jobs loop claims the Meta watch every 10 minutes, only while Meta is configured; the token
    check inside it reaches Meta once a day."""
    ran: list[str] = []
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: ran.append("sweep") or {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: ran.append("waiting") or {})
    monkeypatch.setattr(studio_jobs, "run_daily_money_check", lambda ctx, now: ran.append("daily") or {})
    monkeypatch.setattr(watch, "_claim_funds_check", lambda now: False)
    provider = lambda: studio_jobs.resolve_jobs_ctx({})  # noqa: E731
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                     {"t": studio_jobs.JOB_STATE_TYPE, "id": studio_jobs.JOB_STATE_ID})
    base = datetime.now(UTC)
    try:
        first = studio_jobs.run_tick(provider, base)
        assert "meta_watch" in first["claimed"] and first["meta_watch"]["token"] == "valid"
        assert len(token["requests"]) == 1
        assert "meta_watch" not in studio_jobs.run_tick(provider, base + timedelta(seconds=30))["claimed"]
        again = studio_jobs.run_tick(provider, base + timedelta(minutes=10))
        assert "meta_watch" in again["claimed"] and len(token["requests"]) == 1  # once a day
        # A day later the daily check reads Meta again (the 10-minute limit has long passed by then).
        _ten_minutes_pass()
        assert watch.run_meta_watch(base + timedelta(days=1, minutes=1))["token"] == "valid"
        assert len(token["requests"]) == 2
        # Without a Meta token the watch is never claimed (the money jobs do not need Meta).
        monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
        assert "meta_watch" not in studio_jobs.run_tick(provider, base + timedelta(minutes=20))["claimed"]
        assert watch.run_meta_watch(base) == {"skipped": "meta_not_configured"}
        # An expired token found by the daily check sets the state too.
        monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", SYSTEM_TOKEN)
        token.update(valid=False, code="190.463")
        _ten_minutes_pass()
        down = watch.run_meta_watch(base + timedelta(days=2, minutes=2))
        assert down["connection"] == "down" and down["parkedReplies"] == 0 and watch.connection_down()
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": studio_jobs.JOB_STATE_TYPE, "id": studio_jobs.JOB_STATE_ID})


# ------------------------------------------------------------------ P3-18b: parked replies

def test_auth_failure_parked_while_token_invalid(actors, graph, token):
    dm_page, public_page = _meta_page_id(), _meta_page_id()
    _link(actors, "a", dm_page)
    _rule(actors["a"]["cookies"], name="DM", publicReply="Thanks!", dmEnabled=True, dmText="Details sent")
    _dead_token_everywhere(graph)
    token.update(valid=False, code="190.460")
    before = datetime.now(UTC)
    _webhook(_fb_comment(dm_page, f"{dm_page}_1", "9101", "hello"))
    [log] = _log_rows(actors["a"]["id"])
    assert log["actions"] == [] and log["parkedReason"] == "meta_connection_down"
    commented = studio._parse_iso(log["commentAt"])
    assert studio._parse_iso(log["giveUpAt"]) - commented == timedelta(days=7)  # a private reply is owed
    retry_after = studio._parse_iso(log["retryAfter"])
    assert before + timedelta(minutes=9) < retry_after <= datetime.now(UTC) + timedelta(minutes=10)  # the next check
    assert "190.460" in log["error"] and watch.connection_down()
    assert watch.parked_reply_count() == 1

    # A public-only rule on another page: 24 hours.
    _link(actors, "a", public_page)
    with db_conn() as conn:  # only the public-only rule answers this page's comments
        conn.execute(text("DELETE FROM entities WHERE type = 'socialReplyRules' AND created_by = :o"), {"o": actors["a"]["id"]})
    _rule(actors["a"]["cookies"], name="Public", publicReply="Thanks!")
    _webhook(_fb_comment(public_page, f"{public_page}_1", "9102", "hello"))
    public_log = next(row for row in _log_rows(actors["a"]["id"]) if row["commentId"] == f"{public_page}_1")
    assert public_log["parkedReason"] == "meta_connection_down"
    assert studio._parse_iso(public_log["giveUpAt"]) - studio._parse_iso(public_log["commentAt"]) == timedelta(hours=24)
    assert len(token["requests"]) == 1  # both failures, one Meta check


def _insert_parked(actors, page_id: str, rule_id: str, comment_id: str, *, written_ago: timedelta, give_up_in: timedelta) -> str:
    now = datetime.now(UTC)
    owner = actors["a"]["id"]
    log_id = f"srl_park_{comment_id}"
    data = {"id": log_id, "ownerId": owner, "pageId": page_id, "platform": "fb", "ruleId": rule_id,
            "commentId": comment_id, "postId": "post_1", "fromId": f"from_{comment_id}", "actions": [],
            "processing": False, "error": "public: Meta authorization failed. (190.460)", "attempts": 1,
            "at": studio._iso_at(now - written_ago), "commentAt": studio._iso_at(now - written_ago),
            "retryAfter": studio._iso_at(now - timedelta(minutes=1)), "parkedReason": "meta_connection_down",
            "giveUpAt": studio._iso_at(now + give_up_in), "source": "webhook"}
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('socialReplyLog',:id,:data,false,:t,:owner,:t)"),
                     {"id": log_id, "data": json_dumps(data), "t": now_ms(), "owner": owner})
    return log_id


def test_parked_reply_resent_after_recovery_within_window(actors, graph, token):
    meta_page = _meta_page_id()
    page = _link(actors, "a", meta_page)
    both = _rule(actors["a"]["cookies"], name="Both", publicReply="Thanks!", dmEnabled=True, dmText="Details sent")
    public_only = _rule(actors["a"]["cookies"], name="Public", publicReply="Thanks!")
    _dead_token_everywhere(graph)
    token.update(valid=False, code="190.460")
    _webhook(_fb_comment(meta_page, f"{meta_page}_new", "9201", "hello"))  # parked now: DM + public, fresh
    [fresh] = _log_rows(actors["a"]["id"])
    assert fresh["parkedReason"] == "meta_connection_down"
    fresh_id = studio._log_id(actors["a"]["id"], "fb", f"{meta_page}_new")
    old_dm = _insert_parked(actors, page["id"], both["id"], f"{meta_page}_old", written_ago=timedelta(days=2),
                            give_up_in=timedelta(days=5))
    missed = _insert_parked(actors, page["id"], public_only["id"], f"{meta_page}_late", written_ago=timedelta(hours=30),
                            give_up_in=-timedelta(hours=6))
    week_old = _insert_parked(actors, page["id"], both["id"], f"{meta_page}_week", written_ago=timedelta(days=7, hours=2),
                              give_up_in=-timedelta(hours=2))  # Meta's 7-day private-reply window has passed
    calls = len(graph.calls)

    # Still down: the pass sends nothing, never calls Meta for a parked reply, and makes no new token
    # check within 10 minutes; a reply past its giveUpAt is finished as missed_during_outage.
    later = datetime.now(UTC) + timedelta(minutes=11)
    studio._retry_pending_replies(later)
    assert len(graph.calls) == calls and len(token["requests"]) == 1
    assert _row(fresh_id)["parkedReason"] == "meta_connection_down" and _row(old_dm)["parkedReason"] == "meta_connection_down"
    late = _row(missed)
    assert late["problemCode"] == "missed_during_outage" and late["retryAfter"] == "" and late["parkedReason"] == ""
    assert late["error"].startswith("missed_during_outage") and late["actions"] == []
    assert _row(week_old)["problemCode"] == "missed_during_outage" and _row(week_old)["retryAfter"] == ""

    # Recovery: the token check says valid again, and the existing retry pass resends.
    graph.fail.clear()
    token.update(valid=True, code=None)
    _ten_minutes_pass()
    studio._retry_pending_replies(later)
    assert not watch.connection_down() and len(token["requests"]) == 2
    resent = _row(fresh_id)
    assert resent["actions"] == ["dm", "public"] and resent["retryAfter"] == "" and resent["parkedReason"] == ""
    assert resent["error"] == "" and resent["attempts"] == 2
    two_days = _row(old_dm)  # past 24 hours: only the private reply (7-day window) still goes out
    assert two_days["actions"] == ["dm"] and two_days["retryAfter"] == "" and two_days["parkedReason"] == ""
    sent_to = [path for path, _data in graph.paths()]
    assert f"{meta_page}_old/comments" not in sent_to and f"{meta_page}_new/comments" in sent_to
    assert not any(path.startswith(f"{meta_page}_late") for path in sent_to)  # no reply after the window
    private_to = [json.loads(data["recipient"])["comment_id"] for path, data in graph.paths() if path.endswith("/messages")]
    assert f"{meta_page}_week" not in private_to and f"{meta_page}_old" in private_to  # no private message after 7 days
    assert _row(week_old)["actions"] == []
    assert _me(actors)["metaConnection"] == {"down": False} and watch.parked_reply_count() == 0


def test_page_role_lost_not_parked(actors, graph, token):
    """Per-page refusals are never parked, even while the connection is down."""
    meta_page = _meta_page_id()
    _link(actors, "a", meta_page)
    _rule(actors["a"]["cookies"], name="DM", publicReply="Thanks!", dmEnabled=True, dmText="Details sent")
    token.update(valid=False, code="190.460")
    assert watch.after_authorization_failure() is True  # the connection is down
    for suffix in ("/messages", "/comments"):
        graph.fail[suffix] = meta_ads.MetaAdsError(*AUTH_TOKEN_DEAD, provider_code="190.492")
    _webhook(_fb_comment(meta_page, f"{meta_page}_1", "9301", "hello"))
    graph.fail["/messages"] = meta_ads.MetaAdsError("authorization", "Meta refused the permission.", provider_code="10")
    graph.fail["/comments"] = meta_ads.MetaAdsError("authorization", "Meta refused the permission.", provider_code="200")
    _webhook(_fb_comment(meta_page, f"{meta_page}_2", "9302", "hello"))
    logs = _log_rows(actors["a"]["id"])
    assert len(logs) == 2
    for log in logs:
        assert log["actions"] == [] and not log.get("parkedReason") and not log.get("retryAfter") and not log.get("giveUpAt")
    assert watch.parked_reply_count() == 0


def test_a_comment_already_past_its_window_is_missed_not_parked(actors, graph, token, monkeypatch):
    """A manual check read a comment two days late during the outage: public-only, so it is missed."""
    meta_page = _meta_page_id()
    _link(actors, "a", meta_page)
    rule = _rule(actors["a"]["cookies"], name="Public", publicReply="Thanks!")
    made = now_ms() - 3 * 86_400_000
    with db_conn() as conn:  # the rule is older than the comment
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='socialReplyRules' AND id=:id"),
                           {"id": rule["id"]}).mappings().first()
        data = {k: v for k, v in json_loads(row["data_json"]).items() if k != "activeSince"}
        conn.execute(text("UPDATE entities SET data_json=:d, created_at=:c WHERE type='socialReplyRules' AND id=:id"),
                     {"d": json_dumps({**data, "_created": made}), "c": made, "id": rule["id"]})
    _dead_token_everywhere(graph)
    token.update(valid=False, code="190.460")
    handled = studio.process_comment(platform="fb", entry_id=meta_page, comment_id=f"{meta_page}_x", post_ref="post_1",
                                     from_id="9401", text="hi", source="manual_check",
                                     comment_at=(datetime.now(UTC) - timedelta(days=2)).isoformat())
    assert handled and handled["problemCode"] == "missed_during_outage" and handled["retryAfter"] == ""
    assert handled["parkedReason"] == "" and watch.connection_down()


# ------------------------------------------------------------------ P3-18c: ad-account funds and status

@pytest.fixture()
def accounts(actors, monkeypatch):
    """Approved studio requests on fresh ad accounts, and a restorable metaFundsState."""
    with db_conn() as conn:
        saved = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"),
                             {"t": meta_ads._META_FUNDS_STATE_TYPE, "id": meta_ads._META_FUNDS_STATE_ID}).mappings().first()

    def no_meta(*_args, **_kwargs):
        raise AssertionError("a fresh stored funds reading must be used without a Meta call")

    monkeypatch.setattr(meta_ads, "get_meta_account_funds", no_meta)
    made: list[str] = []
    ids = {name: str(10**14 + secrets.randbelow(10**14)) for name in ("a", "b", "c", "d", "e")}

    def request(account: str, meta_campaign: str, paid: int, **extra) -> str:
        campaign_id = f"req_watch_{secrets.token_hex(6)}"
        data = {"id": campaign_id, "status": "Approved", "name": "Watch", "paidMinorUSD": paid,
                "totalBudgetMinorUSD": paid, "metaAdAccountId": f"act_{account}" if account else "",
                "metaCampaignId": meta_campaign, "recordType": "adCampaignRequests", **extra}
        with db_conn() as conn:
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES ('adCampaignRequests',:id,:data,false,:t,:owner,:t)"),
                         {"id": campaign_id, "data": json_dumps(data), "t": now_ms(), "owner": actors["a"]["id"]})
        made.append(campaign_id)
        return campaign_id

    def funds(rows: list[dict]) -> None:
        meta_ads._save_funds_state({"accounts": rows})

    yield {"ids": ids, "request": request, "funds": funds, "owner": actors["a"]["id"]}
    with db_conn() as conn:
        for campaign_id in made:
            conn.execute(text("DELETE FROM entities WHERE type = 'adCampaignRequests' AND id = :id"), {"id": campaign_id})
            conn.execute(text("DELETE FROM entities WHERE type = 'adCampaignResults' AND created_by = :o "
                              f"AND {json_field_sql('campaignId')} = :c"), {"o": actors["a"]["id"], "c": campaign_id})
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                     {"t": meta_ads._META_FUNDS_STATE_TYPE, "id": meta_ads._META_FUNDS_STATE_ID})
        if saved:
            conn.execute(text("INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES (:t,:id,:data,false,:s,NULL,:s)"),
                         {"t": meta_ads._META_FUNDS_STATE_TYPE, "id": meta_ads._META_FUNDS_STATE_ID,
                          "data": saved["data_json"], "s": now_ms()})
    _wipe_watch_state()


def _funds_row(account: str, **fields) -> dict:
    row = {"id": account, "name": f"Ad account {account}", "currency": "USD", "status": 1, "isPrepay": True,
           "fundsText": "", "fundsMinor": None, "fundsHidden": False, "readAt": meta_ads._iso_now(),
           "spendCapMinor": 0, "amountSpentMinor": 0, "capRemainingMinor": None, "amountDueMinor": 0, "error": ""}
    row.update(fields)
    return row


def _account_alerts(kind: str, account: str) -> list[dict]:
    return [alert for alert in _alerts(kind) if alert["relatedId"] == f"act_{account}"]


def test_studio_funds_low_alert(accounts):
    ids, request = accounts["ids"], accounts["request"]
    running = request(ids["a"], "700000000000001", 10_000)
    with db_conn() as conn:  # Meta confirmed $30 used: $70 of it can still be spent
        write_results_row(conn, running, accounts["owner"], {"metaCampaignId": "700000000000001", "spendMinorUSD": 3_000})
    request(ids["a"], "700000000000002", 50_000, settleBasis="final_read")  # settled: no longer exposure
    request(ids["b"], "700000000000003", 4_000)
    request("", "", 2_000)  # approved, not linked yet: no account
    accounts["funds"]([
        _funds_row(ids["a"], fundsMinor=5_000, fundsText="$50.00"),
        _funds_row(ids["b"], fundsMinor=20_000, fundsText="$200.00"),
    ])
    with db_conn() as conn:
        exposure, not_linked = watch.studio_account_exposure(conn)
    assert exposure[ids["a"]] == {"exposureMinorUSD": 7_000, "campaigns": 1}
    assert exposure[ids["b"]] == {"exposureMinorUSD": 4_000, "campaigns": 1} and not_linked >= 2_000
    result = watch.check_studio_accounts()
    mine = [item for item in result["alerts"] if item["account"] in {f"act_{ids['a']}", f"act_{ids['b']}"}]
    assert mine == [{"kind": "studio_funds_low", "account": f"act_{ids['a']}"}]
    [alert] = _account_alerts("studio_funds_low", ids["a"])
    assert alert["_createdBy"] is None and alert["count"] == 1
    details = alert["details"]
    assert details["basis"] == "prepaid_funds" and details["availableMinor"] == 5_000
    assert details["exposureMinorUSD"] == 7_000 and details["neededMinorUSD"] == 7_000 and details["account"] == f"act_{ids['a']}"
    assert _account_alerts("studio_funds_low", ids["b"]) == []
    # A spend cap lower than the funds is the real room.
    accounts["funds"]([_funds_row(ids["b"], fundsMinor=20_000, capRemainingMinor=1_000)])
    watch.check_studio_accounts()
    [capped] = _account_alerts("studio_funds_low", ids["b"])
    assert capped["details"]["basis"] == "spend_cap" and capped["details"]["availableMinor"] == 1_000
    # Pure rules.
    assert watch.account_findings(7_000, _funds_row("1", fundsMinor=7_000)) == []
    assert [kind for kind, _ in watch.account_findings(7_001, _funds_row("1", fundsMinor=7_000))] == ["studio_funds_low"]
    assert watch.account_findings(1, _funds_row("1", error="busy", waiting=True)) == []  # Meta busy: later
    assert watch.account_findings(1, _funds_row("1", error="Meta refused")) == [("studio_funds_unreadable", {"reason": "read_error"})]
    assert watch.account_findings(1, None) == [("studio_funds_unreadable", {"reason": "not_read"})]
    assert watch.account_findings(1, _funds_row("1", currency="EUR", fundsMinor=10)) == [
        ("studio_funds_unreadable", {"reason": "currency_not_usd", "currency": "EUR"})]


def test_card_funded_inactive_alert(accounts):
    ids, request = accounts["ids"], accounts["request"]
    request(ids["c"], "700000000000011", 9_000)
    request(ids["d"], "700000000000012", 9_000)
    request(ids["e"], "700000000000013", 9_000)
    accounts["funds"]([
        _funds_row(ids["c"], isPrepay=False, status=2, fundsText="Visa *1234"),  # card-funded, disabled
        _funds_row(ids["d"], isPrepay=None, fundsHidden=True),  # no Full control: funds hidden
        _funds_row(ids["e"], isPrepay=False),  # card-funded, active, no cap: nothing to compare
    ])
    watch.check_studio_accounts()
    [inactive] = _account_alerts("studio_account_inactive", ids["c"])
    assert inactive["details"]["accountStatus"] == 2 and inactive["details"]["exposureMinorUSD"] == 9_000
    assert _account_alerts("studio_funds_low", ids["c"]) == [] and _account_alerts("studio_funds_unreadable", ids["c"]) == []
    [hidden] = _account_alerts("studio_funds_unreadable", ids["d"])
    assert hidden["details"]["reason"] == "funds_hidden"
    assert _account_alerts("studio_account_inactive", ids["d"]) == []
    for kind in ("studio_account_inactive", "studio_funds_low", "studio_funds_unreadable"):
        assert _account_alerts(kind, ids["e"]) == []
    # The admin list names each kind in English and Arabic.
    for kind in ("studio_account_inactive", "studio_funds_unreadable", "studio_funds_low", "meta_token_expiring",
                 "meta_connection_down"):
        labels = studio_jobs.ALERT_LABELS[kind]
        assert labels["en"] and labels["ar"] and kind in studio_jobs.ALERT_KINDS


def test_funds_check_runs_every_six_hours_and_reads_meta_only_when_stale(accounts, token, monkeypatch):
    ids = accounts["ids"]
    accounts["request"](ids["a"], "700000000000021", 9_000)
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                     {"t": studio_jobs.JOB_STATE_TYPE, "id": studio_jobs.JOB_STATE_ID})
    reads: list[int] = []

    def fresh_read(*, refresh=False, interactive=True):
        reads.append(1)
        assert refresh is False and interactive is False
        return {"accounts": [_funds_row(ids["a"], fundsMinor=100)], "fetchedAt": meta_ads._iso_now()}

    monkeypatch.setattr(meta_ads, "get_meta_account_funds", fresh_read)
    now = datetime.now(UTC)
    try:
        with db_conn() as conn:  # no stored reading at all: one read through meta_ads
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": meta_ads._META_FUNDS_STATE_TYPE, "id": meta_ads._META_FUNDS_STATE_ID})
        first = watch.run_meta_watch(now)
        assert {"kind": "studio_funds_low", "account": f"act_{ids['a']}"} in first["funds"]["alerts"] and reads == [1]
        assert "funds" not in watch.run_meta_watch(now + timedelta(hours=5))  # every 6 hours
        assert watch._claim_funds_check(now + timedelta(hours=6, minutes=1)) is True
        assert watch._claim_funds_check(now + timedelta(hours=6, minutes=2)) is False  # claimed once
        accounts["funds"]([_funds_row(ids["a"], fundsMinor=1_000_000)])  # the Meta worker's fresh reading
        later = watch.check_studio_accounts(datetime.now(UTC))
        assert later["accounts"] >= 1 and reads == [1]  # a fresh stored reading: no Meta call
        assert not [item for item in later["alerts"] if item["account"] == f"act_{ids['a']}"]
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": studio_jobs.JOB_STATE_TYPE, "id": studio_jobs.JOB_STATE_ID})


def test_the_watch_never_handles_the_token(actors, token):
    """The watch reads only readings and states: no token or secret in its code paths or its rows."""
    with open(watch.__file__, encoding="utf-8") as handle:
        code = handle.read()
    assert "access_token" not in code and "input_token" not in code and "app_secret" not in code
    token.update(valid=False, code="190.460")
    watch.after_authorization_failure()
    stored, raw = _stored_connection()
    assert SYSTEM_TOKEN not in raw and APP_SECRET not in raw and "tokenFingerprint" not in stored
