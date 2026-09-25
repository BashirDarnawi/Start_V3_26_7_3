"""Albayan Studio staff alert channel (plan task P3-21; PLAN.md §7.4 "Staff alert channel", §7.5, §7.6).

The webhook is never called: operations._send_alert is replaced by a recorder (the payload it would
post) or urlopen by a fake endpoint. Every test creates its own users (unique e-mails per run); the
desk rows it writes (tickets, stop requests) are removed when the module ends, as the other desk
modules do (P3-20 asserts an empty desk).
"""

import json
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
from sqlalchemy import text

from server import operations
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_alert_out, studio_jobs, studio_settings, studio_stop
from server.systems.ads_studio.studio_alert_out import (
    AUDIT_ALERT_TEST,
    HEARTBEAT_ALERT,
    STOP_TYPE,
    TEST_RATE_KEY,
    WEBHOOK_ENV,
    notify_staff,
    operations_watch,
    report_heartbeat,
    reset_channel_state,
    send_pending,
)
from server.systems.ads_studio.studio_jobs import ALERTS_TYPE, JOB_STATE_TYPE, alert_id, raise_alert
from server.systems.ads_studio.studio_stop import stop_row_id

NOTIFY_CHANNEL_SOON = studio_stop.notify_channel_soon  # the real hook, bound before the fixture below switches it off
TAG = secrets.token_hex(4)
PASSWORD = "StudioAlertPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
REVIEWER_PERMISSIONS = {CAMPAIGNS: ["view", "review"]}
WEBHOOK = "https://hooks.example.test/albayan"
OWNER_NAME = f"Fatima Secret {TAG}"
UTC = timezone.utc
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict, name: str | None = None) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("alert_user")
    email = f"studio-alert-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": name or f"Alert {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
             "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    _USERS.append(user_id)
    return {"id": user_id, "email": email, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    return {
        "owner": _insert_user("owner", "Employee", CUSTOMER_PERMISSIONS, name=OWNER_NAME),
        "reviewer": _insert_user("reviewer", "Employee", REVIEWER_PERMISSIONS),
        "admin": _insert_user("admin", "Admin", {}),
    }


@pytest.fixture(autouse=True)
def _isolated(people, monkeypatch):
    """Settings rows put back exactly, the channel's memory cleared, the webhook unset unless a test sets it.
    The stop request's own send-at-once thread is switched off (one test switches it back on), so each
    test's send_pending is the only sender and the counts below stay exact."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    monkeypatch.delenv(WEBHOOK_ENV, raising=False)
    monkeypatch.setattr(studio_stop, "notify_channel_soon", lambda: None)
    reset_channel_state()
    reset_rate_limit(TEST_RATE_KEY)
    for uid in _USERS:
        reset_rate_limit(f"ad-studio:mutations:{uid}")
    yield
    reset_channel_state()
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = 'studioSettings'"))
        for row in saved:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                row,
            )


@pytest.fixture(scope="module", autouse=True)
def _desk_rows_cleanup():
    yield
    with db_conn() as conn:
        for chunk in (_USERS[i:i + 50] for i in range(0, len(_USERS), 50)):
            params = {f"u{i}": uid for i, uid in enumerate(chunk)}
            names = ", ".join(f":u{i}" for i in range(len(chunk)))
            conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names})"), params)
        for row_type in ("supportTickets", "supportTicketMessages", "studioStopRequests", "studioCounters"):
            conn.execute(text("DELETE FROM entities WHERE type = :t"), {"t": row_type})
        conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"), {"t": ALERTS_TYPE, "like": f"%{TAG}%"})


# ------------------------------------------------------------------ helpers

def _recorder(monkeypatch, *, answer: bool = True) -> list[dict]:
    """The channel as the tests see it: every payload operations._send_alert would post."""
    calls: list[dict] = []

    def fake(kind, severity, message, details=None, line=None):
        calls.append({"kind": kind, "severity": severity, "message": message, "details": details or {}, "line": line})
        return answer

    monkeypatch.setattr(operations, "_send_alert", fake)
    monkeypatch.setenv(WEBHOOK_ENV, WEBHOOK)
    return calls


def _services_on() -> None:
    record = studio_settings.read_setting("rollout")
    studio_settings.save_setting("rollout", {"services": {"help": "on", "stopRequest": "on", "tiktok": "off"}},
                                 record["version"], "", "2026-09-25T00:00:00Z", audit=lambda *args: None)


def _campaign(owner_id: str, label: str) -> str:
    campaign_id = f"alert_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"Private ad name {label}", "status": "Approved", "creativeImages": ["data:image/png;base64,AAAA"],
            "studioRef": "ALB-S-QRSTUVWX"}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    return campaign_id


def _ask(user: dict, campaign_id: str, note: str) -> dict:
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                           json={"operationId": f"stop-{secrets.token_hex(6)}", "note": note}, cookies=user["cookies"])
    assert response.status_code == 200, response.text
    return response.json()


def _row(row_type: str, row_id: str) -> dict:
    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :id"), {"t": row_type, "id": row_id}).scalar()
    return json_loads(raw) if raw else {}


def _audits(action: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(text("SELECT user_id, metadata_json FROM audit_logs WHERE action = :action ORDER BY ts"),
                            {"action": action}).mappings().all()
    return [dict(row) for row in rows]


# ------------------------------------------------------------------ the one door

def test_notify_staff_needs_the_webhook_and_dedupes_per_key(monkeypatch):
    assert notify_staff("studio_probe", "Probe", "فحص", "body", f"k-{TAG}", wait=2) is False  # not configured
    calls = _recorder(monkeypatch)
    assert notify_staff("studio_probe", "Probe  title", "فحص\nالقناة", " body \t line ", f"k-{TAG}", wait=5) is True
    assert notify_staff("studio_probe", "Probe title", "فحص القناة", "body line", f"k-{TAG}", wait=5) is False  # same key
    assert notify_staff("studio_probe", "Probe title", "فحص القناة", "body line", f"k2-{TAG}", wait=5) is True  # another key
    assert [call["kind"] for call in calls] == [f"studio_probe:k-{TAG}", f"studio_probe:k2-{TAG}"]
    first = calls[0]
    assert first["message"] == "Probe title" and first["line"] == "Probe title | فحص القناة\nbody line"
    assert first["details"] == {"titleEn": "Probe title", "titleAr": "فحص القناة", "body": "body line",
                                "dedupeKey": f"k-{TAG}", "system": "ads_studio"}
    with pytest.raises(ValueError):
        notify_staff("Bad Kind", "x", "y")


def test_a_refused_send_may_be_tried_again(monkeypatch):
    calls = _recorder(monkeypatch, answer=False)
    assert notify_staff("studio_probe", "Probe", "فحص", "", f"retry-{TAG}", wait=5) is False
    assert notify_staff("studio_probe", "Probe", "فحص", "", f"retry-{TAG}", wait=5) is False
    assert len(calls) == 2  # the key was not kept as sent


def test_send_alert_payload_has_text_and_answers_true(monkeypatch):
    posted: list[dict] = []

    class _Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(request, timeout=None):
        posted.append({"url": request.full_url, "body": json.loads(request.data.decode("utf-8")), "timeout": timeout})
        return _Response()

    monkeypatch.setattr(operations, "urlopen", fake_urlopen)
    kind = f"probe_{TAG}"
    monkeypatch.delenv("ALBAYAN_ALERT_WEBHOOK_URL", raising=False)
    assert operations._send_alert(kind, "high", "message", {"a": 1}, line="the line") is False and posted == []
    monkeypatch.setenv("ALBAYAN_ALERT_WEBHOOK_URL", WEBHOOK)
    assert operations._send_alert(kind, "high", "message", {"a": 1}, line="the line") is True
    assert posted[0]["url"] == WEBHOOK and posted[0]["timeout"] == 10
    body = posted[0]["body"]
    assert body["kind"] == kind and body["message"] == "message" and body["text"] == "the line" and body["details"] == {"a": 1}
    assert operations._send_alert(kind, "high", "message") is False and len(posted) == 1  # the per-kind cooldown
    assert operations._send_alert(f"{kind}-2", "high", "message") is True
    assert posted[1]["body"]["text"] == "message"  # text defaults to the message


# ------------------------------------------------------------------ stop requests

def test_stop_request_notifies_once(people, monkeypatch):
    _services_on()
    owner = people["owner"]
    first = _campaign(owner["id"], "first")
    second = _campaign(owner["id"], "second")
    ticket = _ask(owner, first, "Please stop it, my phone is 0912345678")["ticket"]

    # Not configured: nothing is sent, nothing is stamped (the on-duty rule is the fallback).
    quiet = send_pending()
    assert quiet["configured"] is False and quiet["stopRequests"] == []
    assert _row(STOP_TYPE, stop_row_id(first)).get("channelSentAt") is None

    calls = _recorder(monkeypatch)
    sent = send_pending()
    assert sent["stopRequests"] == [ticket["number"]] and sent["alerts"] == []
    assert len(calls) == 1
    call = calls[0]
    assert call["kind"] == f"studio_stop:{ticket['number']}" and call["severity"] == "high"
    assert ticket["number"] in call["line"] and "ALB-S-QRSTUVWX" in call["line"] and "due " in call["line"]
    assert call["details"]["titleAr"] and call["details"]["dedupeKey"] == ticket["number"]
    payload = json.dumps(call, ensure_ascii=False)
    for secret in (OWNER_NAME, owner["email"], owner["id"], "0912345678", "Please stop", "Private ad name"):
        assert secret not in payload, secret
    stamped = _row(STOP_TYPE, stop_row_id(first))
    assert stamped["channelSentAt"] and stamped["state"] == "open"

    # A second pass, and a fresh process (the in-memory dedupe forgotten): the row's stamp holds.
    assert send_pending()["stopRequests"] == [] and len(calls) == 1
    reset_channel_state()
    assert send_pending()["stopRequests"] == [] and len(calls) == 1

    # A second stop request within the cooldown is its own kind: it is sent too (PLAN.md §7.4).
    other = _ask(owner, second, "")["ticket"]
    assert send_pending()["stopRequests"] == [other["number"]]
    assert [c["kind"] for c in calls] == [f"studio_stop:{ticket['number']}", f"studio_stop:{other['number']}"]


def test_a_refused_stop_notification_is_tried_on_a_later_pass(people, monkeypatch):
    _services_on()
    campaign_id = _campaign(people["owner"]["id"], "refused")
    ticket = _ask(people["owner"], campaign_id, "")["ticket"]
    calls = _recorder(monkeypatch, answer=False)
    assert send_pending()["stopRequests"] == [] and len(calls) == 1
    assert _row(STOP_TYPE, stop_row_id(campaign_id)).get("channelSentAt") is None
    calls.clear()
    monkeypatch.setattr(operations, "_send_alert", lambda *a, **k: calls.append(a) or True)
    assert send_pending()["stopRequests"] == [ticket["number"]] and len(calls) == 1
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["channelSentAt"]


def test_a_new_stop_request_reaches_the_channel_at_once(people, monkeypatch):
    """The stop request's commit sends its notification itself (studio_stop.notify_channel_soon), without
    waiting for the operations worker's 300-second turn; the worker's pass then finds the row stamped."""
    _services_on()
    calls = _recorder(monkeypatch)
    threads: list = []
    monkeypatch.setattr(studio_stop, "notify_channel_soon", lambda: threads.append(NOTIFY_CHANNEL_SOON()))
    campaign_id = _campaign(people["owner"]["id"], "atonce")
    ticket = _ask(people["owner"], campaign_id, "")["ticket"]
    assert len(threads) == 1 and threads[0] is not None
    threads[0].join(15)
    assert not threads[0].is_alive()
    assert [call["kind"] for call in calls] == [f"studio_stop:{ticket['number']}"]
    assert _row(STOP_TYPE, stop_row_id(campaign_id))["channelSentAt"]
    assert send_pending()["stopRequests"] == [] and len(calls) == 1  # the worker's pass: already sent


def test_channel_alerts_are_sent_once_and_others_never(people, monkeypatch):
    calls = _recorder(monkeypatch)
    now = datetime.now(UTC)
    with db_conn() as conn:
        urgent, _new = raise_alert(conn, "integrity_violation", related_type=JOB_STATE_TYPE, related_id=f"scan-{TAG}",
                                   count=2, details={"violations": [{"code": "duplicate_return", "userId": people["owner"]["id"]}]}, now=now)
        quiet, _new = raise_alert(conn, "review_overdue", related_type=CAMPAIGNS, related_id=f"alert_quiet_{TAG}",
                                  owner_id=people["owner"]["id"], now=now)
    sent = send_pending(now)
    assert sent["alerts"] == [urgent["id"]]
    assert len(calls) == 1 and calls[0]["kind"] == f"integrity_violation:{urgent['id']}"
    assert calls[0]["message"] == studio_jobs.ALERT_LABELS["integrity_violation"]["en"]
    assert studio_jobs.ALERT_LABELS["integrity_violation"]["ar"] in calls[0]["line"]
    assert "count 2" in calls[0]["line"] and people["owner"]["id"] not in json.dumps(calls[0])  # counts, never the findings
    assert _row(ALERTS_TYPE, urgent["id"])["channelSentAt"] and _row(ALERTS_TYPE, quiet["id"])["channelSentAt"] is None
    assert send_pending(now)["alerts"] == [] and len(calls) == 1


# ------------------------------------------------------------------ the heartbeat watch

def _beat(**fields) -> dict:
    return {"enabled": True, "runningHere": False, "lastTickAt": "2026-09-25T10:00:00Z", "ageSeconds": 900, "late": True, **fields}


def test_heartbeat_watch_alerts(monkeypatch):
    calls = _recorder(monkeypatch)
    now = datetime(2026, 9, 25, 10, 15, tzinfo=UTC)
    assert report_heartbeat(_beat(enabled=False), now) is False and calls == []  # switched off on purpose
    assert report_heartbeat(_beat(late=False, ageSeconds=20), now) is False and calls == []
    assert report_heartbeat(_beat(), now) is True
    assert len(calls) == 1 and calls[0]["kind"].startswith(f"{HEARTBEAT_ALERT}:2026-09-25T10:00:00Z:")
    assert calls[0]["severity"] == "critical" and "900 s ago" in calls[0]["line"] and "restart" in calls[0]["line"]
    row = _row(ALERTS_TYPE, alert_id(HEARTBEAT_ALERT, "studio-jobs:2026-09-25T10:00:00Z", "2026-09-25"))
    assert row["details"] == {"lastTickAt": "2026-09-25T10:00:00Z", "ageSeconds": 900}
    assert report_heartbeat(_beat(ageSeconds=1200), now) is False and len(calls) == 1  # the same stale episode
    assert report_heartbeat(_beat(late=False, lastTickAt="2026-09-25T10:30:00Z", ageSeconds=10), now) is False  # recovered
    assert report_heartbeat(_beat(lastTickAt="2026-09-25T10:30:00Z", ageSeconds=700), now) is True  # a new episode
    assert len(calls) == 2
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"),
                     {"t": ALERTS_TYPE, "like": "%studio-jobs:2026-09-25T10:%"})


def test_a_refused_heartbeat_notification_is_tried_at_the_next_watch(monkeypatch):
    """The most critical alert must not vanish for six hours because one POST was refused or timed out:
    the episode is stamped as reported only once the webhook accepted it."""
    calls = _recorder(monkeypatch, answer=False)
    now = datetime(2026, 9, 25, 12, 15, tzinfo=UTC)
    beat = _beat(lastTickAt="2026-09-25T12:00:00Z")
    assert report_heartbeat(beat, now) is False  # refused (or timed out)
    assert report_heartbeat({**beat, "ageSeconds": 1200}, now) is False
    assert len(calls) == 2  # both watches reached the sender: the episode was not stamped as reported
    monkeypatch.setattr(operations, "_send_alert", lambda *a, **k: calls.append(a) or True)
    assert report_heartbeat({**beat, "ageSeconds": 1500}, now) is True and len(calls) == 3
    assert report_heartbeat({**beat, "ageSeconds": 1800}, now) is False and len(calls) == 3  # stamped once accepted
    # Not configured: the episode is stamped all the same (the admin-list alert once per reminder period, not every watch).
    reset_channel_state()
    monkeypatch.delenv(WEBHOOK_ENV, raising=False)
    assert report_heartbeat(beat, now) is False and studio_alert_out._HEARTBEAT["key"] == "2026-09-25T12:00:00Z"
    assert report_heartbeat({**beat, "ageSeconds": 1200}, now) is False and studio_alert_out._HEARTBEAT["key"] == "2026-09-25T12:00:00Z"
    assert len(calls) == 3
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"),
                     {"t": ALERTS_TYPE, "like": "%studio-jobs:2026-09-25T12:%"})


def test_a_loop_that_never_ticked_is_reported_after_the_grace(monkeypatch):
    calls = _recorder(monkeypatch)
    now = datetime(2026, 9, 25, 10, 15, tzinfo=UTC)
    never = _beat(lastTickAt=None, ageSeconds=None, runningHere=True)
    assert report_heartbeat(never, now) is False and calls == []  # the first sight starts the grace
    assert report_heartbeat(never, now) is False and calls == []
    studio_alert_out._HEARTBEAT["neverSince"] -= 600  # the grace is over
    assert report_heartbeat(never, now) is True and len(calls) == 1
    assert calls[0]["kind"].startswith(f"{HEARTBEAT_ALERT}:never:") and "last tick never" in calls[0]["line"]
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"),
                     {"t": ALERTS_TYPE, "like": "%studio-jobs:never%"})


def test_operations_worker_watch_is_guarded(monkeypatch):
    calls = _recorder(monkeypatch)
    monkeypatch.setattr(studio_jobs, "jobs_heartbeat", lambda now=None: (_ for _ in ()).throw(RuntimeError("db away")))
    operations._watch_studio_jobs()  # never raises
    assert calls == []
    monkeypatch.setattr(studio_jobs, "jobs_heartbeat", lambda now=None: _beat(lastTickAt="2026-09-25T11:00:00Z"))
    operations._watch_studio_jobs()
    assert len(calls) == 1 and calls[0]["kind"].startswith(HEARTBEAT_ALERT)
    monkeypatch.setattr(studio_alert_out, "send_pending", lambda now=None: (_ for _ in ()).throw(RuntimeError("boom")))
    watched = operations_watch(_beat(late=False))
    assert watched == {"heartbeat": False, "pending": None}
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND data_json LIKE :like"),
                     {"t": ALERTS_TYPE, "like": "%studio-jobs:2026-09-25T11:%"})


def test_the_worker_loop_calls_the_watch_once_per_turn():
    source = Path(operations.__file__).read_text(encoding="utf-8")
    loop = source[source.index("def _backup_worker"):source.index("def start_operations_worker")]
    assert loop.count("_watch_studio_jobs()") == 1 and loop.index("_watch_studio_jobs()") < loop.index("_worker_stop.wait(300)")


# ------------------------------------------------------------------ the admin test button

def _press(user: dict, **kwargs):
    return client.post("/api/studio/admin/alert-channel/test", cookies=user["cookies"], **kwargs)


def test_alert_channel_test_route(people, monkeypatch):
    before = len(_audits(AUDIT_ALERT_TEST))
    denied = _press(people["reviewer"])
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "ADMIN_ONLY", denied.text
    cross = _press(people["admin"], headers={"Origin": "https://evil.example"})
    assert cross.status_code == 403 and cross.json()["detail"]["code"] == "CROSS_SITE", cross.text
    client.cookies.clear()
    assert client.post("/api/studio/admin/alert-channel/test").status_code == 401

    unset = _press(people["admin"])
    assert unset.status_code == 200 and unset.json() == {"sent": False, "configured": False}, unset.text
    audits = _audits(AUDIT_ALERT_TEST)
    assert len(audits) == before + 1 and audits[-1]["user_id"] == people["admin"]["id"]
    assert json.loads(audits[-1]["metadata_json"]) == {"configured": False, "sent": False}

    limited = _press(people["admin"])
    assert limited.status_code == 429 and limited.json()["detail"]["code"] == "RATE_LIMITED", limited.text
    assert int(limited.headers["Retry-After"]) >= 1

    reset_rate_limit(TEST_RATE_KEY)
    calls = _recorder(monkeypatch)
    pressed = _press(people["admin"])
    assert pressed.status_code == 200 and pressed.json() == {"sent": True, "configured": True}, pressed.text
    assert len(calls) == 1 and calls[0]["kind"].startswith("studio_alert_test:") and calls[0]["severity"] == "low"
    assert "القناة تعمل" in calls[0]["line"] and people["admin"]["id"] not in json.dumps(calls[0])
    assert json.loads(_audits(AUDIT_ALERT_TEST)[-1]["metadata_json"]) == {"configured": True, "sent": True}

    reset_rate_limit(TEST_RATE_KEY)
    monkeypatch.setattr(operations, "_send_alert", lambda *a, **k: False)  # the endpoint refused it
    refused = _press(people["admin"])
    assert refused.status_code == 200 and refused.json() == {"sent": False, "configured": True}, refused.text
