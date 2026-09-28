"""Review loop round 1, batch A2: Meta results, the results sync and the staff alerts.

Behaviour tests for the verified findings of this batch (each fails before its fix):

* #3/#28 a desk link removed since (``everLinked``) is "launched" for the stage too: no
  "Stop & full refund" offer (the stop route refuses it) and no "full amount back" promise after
  the end date (the settle step judges it on the last-linked campaign's Meta spend).
* #10 an all-zero insights read after Meta confirmed this campaign's delivery is unknown, never a
  $0 final read or "never delivered" (a full refund).
* #11 a signed ad-account webhook during Albayan's Meta pause is not a server error.
* #12 an in-memory park of ONE ad account on the studio_results lane parks that account; the pass
  goes on with the others (it is not the lane's app-wide pause).
* #13 a paused or throttled page lookup of the partner-pages refresh is not a definitive miss.
* #14 a second Meta outage on the same Tripoli day raises its own, unacknowledged, unsent alert.
* #15 a failed POST to the staff channel starts no per-kind cooldown.

Every test builds its own users, requests and Meta ids (unique per run) and removes what it wrote.
"""

import copy
import hashlib
import hmac
import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.meta_ads as meta_ads
import server.operations as operations
from server import monitoring
from server.db import db_conn, init_db, json_dumps, json_field_sql, json_loads, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_alerts_meta as watch
from server.systems.ads_studio import studio_alert_out, studio_jobs, studio_results
from server.systems.ads_studio import studio_results_sync as sync
from server.systems.ads_studio.ad_campaign_actions import ever_launched, settle_plan
from server.systems.ads_studio.studio_diagnostics import libya_today
from server.systems.ads_studio.studio_results import RESULTS_TYPE, derive_display_stage, results_id
from server.systems.ads_studio.studio_settings import DEFAULTS

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR1A2Password123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
PREFIX = f"rlr1a2_{TAG}_"
UTC = timezone.utc
SETTINGS = copy.deepcopy(DEFAULTS)
ACCOUNT_A = "7781" + f"{int(TAG, 16) % 10**8:08d}"
ACCOUNT_B = "7782" + f"{int(TAG, 16) % 10**8:08d}"
_counter = [0]


def _uid(label: str) -> str:
    _counter[0] += 1
    return f"{PREFIX}{_counter[0]:04d}_{label}"


def _meta_id() -> str:
    _counter[0] += 1
    return f"1209{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ people and requests

def _insert_user(label: str) -> dict:
    stamp = now_ms()
    user_id = new_id("rlr1a2_user")
    email = f"review-loop-r1-a2-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,'Employee',:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Review loop {label}", "email": email,
             "permissions": json_dumps({CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
             "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


@pytest.fixture(scope="module")
def owner():
    init_db()
    return _insert_user("owner")


@pytest.fixture
def seeded():
    """The request ids a test wrote: deleted with their results rows and alerts afterwards."""
    written: list[str] = []
    yield written
    with db_conn() as conn:
        for campaign_id in written:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": CAMPAIGNS, "id": campaign_id})
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": RESULTS_TYPE, "id": results_id(campaign_id)})
        conn.execute(text("DELETE FROM entities WHERE type = 'studioAlerts' AND (data_json LIKE :a OR data_json LIKE :b "
                          "OR data_json LIKE :c)"),
                     {"a": f"%{PREFIX}%", "b": f"%{ACCOUNT_A}%", "c": f"%{ACCOUNT_B}%"})


def _request(seeded: list, owner_id: str, **data) -> str:
    campaign_id = _uid("cmp")
    stamp = now_ms()
    body = {
        "id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
        "status": "Approved", "name": f"Spring offer {campaign_id[-4:]}", "budgetMinorUSD": 3000,
        "budgetType": "lifetime", "totalBudgetMinorUSD": 3000, "paidMinorUSD": 3000,
        "submittedAt": "2027-02-27T08:00:00Z", **data,
    }
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    seeded.append(campaign_id)
    return campaign_id


# ------------------------------------------------------------------ #3 / #28: a link removed since

def _unlinked_after_link(start: str, end: str) -> dict:
    """What the desk's unlink leaves (ad_campaign_actions._unlink_meta_campaign + _link_history)."""
    return {"status": "Approved", "startDate": start, "endDate": end, "metaCampaignId": "", "publishStatus": "",
            "metaAdAccountId": "", "spendMinorUSD": 0, "paidMinorUSD": 3000, "everLinked": True,
            "lastLinkedMetaCampaignId": "120212345", "lastLinkedMetaAdAccountId": "act_123"}


def test_unlinked_after_a_link_is_never_offered_the_full_refund_stop():
    now = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
    request = _unlinked_after_link("2026-10-16", "2026-10-25")
    assert ever_launched(request)  # the stop route refuses the owner's full-refund stop of it (409)
    stage = derive_display_stage(request, None, now)
    assert stage["stage"] == 4 and "stop_refund" not in stage["actions"]
    assert stage["actions"] == ["ask_to_stop", "ask"]
    # Never linked at all: the full-refund stop is still offered (unchanged).
    never = {**request, "everLinked": None, "lastLinkedMetaCampaignId": "", "lastLinkedMetaAdAccountId": ""}
    assert "stop_refund" in derive_display_stage(never, None, now)["actions"]


def test_unlinked_after_a_link_past_its_end_promises_no_full_return():
    now = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
    request = _unlinked_after_link("2026-10-01", "2026-10-10")
    stage = derive_display_stage(request, None, now)
    assert stage["stage"] == 10 and stage["variant"] != "never_linked" and stage["moneyKey"] != "full_return"
    never = {**request, "everLinked": None}
    got = derive_display_stage(never, None, now)
    assert (got["variant"], got["moneyKey"]) == ("never_linked", "full_return")  # unchanged for a never-linked one


def test_summary_route_reads_every_linked_from_the_database(owner, seeded, monkeypatch):
    now = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
    monkeypatch.setattr(studio_results, "utc_now", lambda: now)
    future = _request(seeded, owner["id"], **_unlinked_after_link("2026-10-16", "2026-10-25"))
    ended = _request(seeded, owner["id"], **_unlinked_after_link("2026-10-01", "2026-10-10"))
    fresh = _request(seeded, owner["id"], status="Approved", startDate="2026-10-16", endDate="2026-10-25")
    response = client.get("/api/studio/campaigns/summary", cookies=owner["cookies"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert "stop_refund" not in body[future]["actions"] and body[future]["stage"] == 4
    assert body[ended]["stage"] == 10 and body[ended]["variant"] != "never_linked"
    assert body[ended]["moneyKey"] != "full_return"
    assert "stop_refund" in body[fresh]["actions"]  # a request never linked keeps the offer


# ------------------------------------------------------------------ #10: an empty insights read after spend

META_X = "120200000000777"


def _empty_read() -> dict:
    """What meta_ads.get_campaign_results returns when Meta's insights edge answers ``data: []``."""
    return {"campaignId": META_X, "accountId": "123", "name": "ALB-S-TEST · offer", "effectiveStatus": "PAUSED",
            "stopTime": None, "adStatusCounts": {"PAUSED": 1}, "anyAdDelivering": False, "adsetEndTime": "",
            "reviewFeedback": "", "currency": "", "insightsState": "ok", "spendMinor": 0, "impressions": 0,
            "reach": 0, "clicks": 0, "resultType": "", "resultCount": 0}


def _stopped_request(now: datetime) -> dict:
    return {"id": "cmp_x", "ownerId": "", "status": "Approved", "startDate": "2027-03-01", "endDate": "2027-04-30",
            "metaCampaignId": META_X, "metaAdAccountId": "act_123", "stopRequestedAt": _iso(now - timedelta(hours=60)),
            "metaLinkResult": {"metaCurrency": "USD"}, "paidMinorUSD": 5000, "spendMinorUSD": 0}


def _confirmed_row(now: datetime, **extra) -> dict:
    return {"campaignId": "cmp_x", "metaCampaignId": META_X, "metaAdAccountId": "act_123", "currency": "USD",
            "spendMinorUSD": 4000, "lifetimeImpressions": 5000, "impressions": 5000, "insightsState": "ok",
            "spendConfirmedAt": _iso(now - timedelta(hours=55)), "lastSyncedAt": _iso(now - timedelta(minutes=15)),
            "syncState": "ok", "neverDelivered": False, "adStatusCounts": {"PAUSED": 1},
            "deliveryEndedAt": _iso(now - timedelta(hours=58)), "settleReadDueAt": _iso(now - timedelta(hours=10)),
            "driftWatchUntil": _iso(now + timedelta(days=20)), "stopEffectiveAt": _iso(now - timedelta(hours=58)),
            **extra}


def test_empty_insights_after_confirmed_spend_never_become_a_full_refund():
    now = datetime(2027, 3, 20, 10, 0, tzinfo=UTC)
    request = _stopped_request(now)
    # The final read already happened ($40 of $50): a later empty answer (drift watch).
    previous = _confirmed_row(now, settleReadAt=_iso(now - timedelta(hours=9)))
    fields, facts = sync.fields_after_read(previous, request, _empty_read(), now, SETTINGS)
    assert fields["insightsState"] == "unavailable"
    assert "spendMinorUSD" not in fields and "spendConfirmedAt" not in fields
    assert fields.get("neverDelivered") is not True and facts["drift"] is None
    plan = settle_plan(request, {**previous, **fields}, 5000, None, now, SETTINGS["settlement"])
    assert plan["settleBasis"] == "final_read" and plan["capMinorUSD"] == 1000 and plan["refund"] == 1000


def test_empty_insights_after_confirmed_spend_are_never_the_final_read():
    now = datetime(2027, 3, 20, 10, 0, tzinfo=UTC)
    request = _stopped_request(now)
    previous = _confirmed_row(now)  # the final read is due, not taken yet
    fields, _facts = sync.fields_after_read(previous, request, _empty_read(), now, SETTINGS)
    assert fields["insightsState"] == "unavailable" and fields["settleReadAt"] is None
    assert fields.get("neverDelivered") is not True and "spendMinorUSD" not in fields
    with pytest.raises(HTTPException) as refused:
        settle_plan(request, {**previous, **fields}, 5000, None, now, SETTINGS["settlement"])
    assert refused.value.status_code == 409  # waits for a real final read, never "never delivered"


def test_a_campaign_that_never_delivered_still_reads_never_delivered():
    """D28 stays: zeros with no earlier confirmed delivery are a real "nothing delivered"."""
    now = datetime(2027, 3, 20, 10, 0, tzinfo=UTC)
    request = _stopped_request(now)
    previous = _confirmed_row(now, spendMinorUSD=0, lifetimeImpressions=0, impressions=0)
    fields, _facts = sync.fields_after_read(previous, request, _empty_read(), now, SETTINGS)
    assert fields["insightsState"] == "ok" and fields["spendMinorUSD"] == 0 and fields["neverDelivered"] is True


# ------------------------------------------------------------------ #11: the webhook during a Meta pause

def test_ad_account_webhook_during_a_meta_pause_is_not_a_server_error(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"webhook-token-{TAG}")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "review-loop-secret")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "444444444444444")
    monkeypatch.setattr(meta_ads, "count_webhook_delivery", lambda payload, **kwargs: False)
    calls = []

    def paused(*args, **kwargs):
        calls.append((args, kwargs))
        raise meta_ads.MetaAdsError("rate_limited", "Meta synchronization is paused safely and will resume automatically.",
                                    retryable=True)

    monkeypatch.setattr(meta_ads, "discover_meta_ads", paused)
    raw = json.dumps({"object": "ad_account", "entry": [{"id": "444444444444444", "time": 1}]}).encode("utf-8")
    signature = "sha256=" + hmac.new(b"review-loop-secret", raw, hashlib.sha256).hexdigest()
    headers = {"X-Hub-Signature-256": signature, "Content-Type": "application/json", "Origin": "http://testserver"}
    errors_before = monitoring.monitor.error_count
    quiet = TestClient(app, raise_server_exceptions=False)
    response = quiet.post("/api/meta-ads/webhook", content=raw, headers=headers)
    assert response.status_code == 200 and response.json() == {"received": True}
    assert len(calls) == 1 and calls[0][0][0] == ["444444444444444"]  # the discovery was still asked for
    assert monitoring.monitor.error_count == errors_before  # no 500 counted for the pause
    strict = TestClient(app)  # re-raises any server exception
    assert strict.post("/api/meta-ads/webhook", content=raw, headers=headers).status_code == 200
    assert len(calls) == 2


# ------------------------------------------------------------------ #12: one ad account parked on the lane

T0 = datetime(2027, 3, 10, 10, 0, tzinfo=UTC)


def _read_for(meta_id: str, account: str) -> dict:
    return {"campaignId": meta_id, "accountId": account, "name": "ALB-S-TEST · offer", "effectiveStatus": "ACTIVE",
            "stopTime": None, "adStatusCounts": {"ACTIVE": 1}, "anyAdDelivering": True, "adsetEndTime": "",
            "reviewFeedback": "", "currency": "USD", "insightsState": "ok", "spendMinor": 1234, "impressions": 100,
            "reach": 90, "clicks": 5, "resultType": "", "resultCount": 0}


def _clear_parks() -> None:
    studio_jobs.update_job_state(lambda state: {sync.PARKS_FIELD: {}} if state.get(sync.PARKS_FIELD) else None)


def test_an_account_park_skips_that_account_and_the_pass_goes_on(owner, seeded, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"results-token-{TAG}")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT_A},{ACCOUNT_B}")
    linked = {}
    for label, account in (("a1", ACCOUNT_A), ("b1", ACCOUNT_B), ("a2", ACCOUNT_A)):
        meta_id = _meta_id()
        linked[label] = (_request(seeded, owner["id"], startDate="2027-03-01", endDate="2027-03-20",
                                  metaCampaignId=meta_id, metaAdAccountId=f"act_{account}", publishStatus="meta_review"),
                         meta_id, account)
    calls: list[str] = []

    def results(account_id, campaign_id, *, request_id=""):
        calls.append(campaign_id)
        if account_id == ACCOUNT_A:  # Albayan's own refusal: account A is parked in memory, nothing reached Meta
            raise meta_ads.MetaAdsError("rate_limited", "Meta synchronization is paused safely and will resume automatically.",
                                        retryable=True)
        return _read_for(campaign_id, account_id)

    monkeypatch.setattr(meta_ads, "get_campaign_results", results)
    # The lane itself is not paused; only account A is parked, for 10 minutes.
    monkeypatch.setattr(meta_ads, "meta_lane_pause_seconds",
                        lambda lane="admin", subject="": 600 if str(subject) == ACCOUNT_A else 0)
    order = [linked["a1"], linked["b1"], linked["a2"]]
    monkeypatch.setattr(sync, "due_candidates", lambda now: [
        {"campaignId": campaign_id, "account": account, "dueAt": sync._EPOCH} for campaign_id, _meta, account in order])
    _clear_parks()
    try:
        report = sync.run_results_sync(T0, settings=SETTINGS)
        assert report["skipped"] != "stopped"
        assert report["synced"] == [linked["b1"][0]] and report["parked"] == [ACCOUNT_A]
        assert calls == [linked["a1"][1], linked["b1"][1]]  # the parked account's second request waits
        until = sync.active_parks(T0 + timedelta(minutes=1)).get(ACCOUNT_A)
        assert until is not None and until >= T0 + timedelta(minutes=10)
        with db_conn() as conn:
            raw = conn.execute(text("SELECT data_json FROM entities WHERE type = 'studioAlerts' AND id = :id"),
                               {"id": studio_jobs.alert_id("results_parked", f"act_{ACCOUNT_A}",
                                                           libya_today(T0).isoformat())}).scalar()
        assert raw and json_loads(raw)["kind"] == "results_parked"
    finally:
        _clear_parks()


# ------------------------------------------------------------------ #13: partner pages during a pause

class _PartnerClient:
    """The two partner-refresh reads, with the REAL get_ad_page_identity on top of a scripted _get."""

    def __init__(self, rows: list[dict], page_id: str):
        self.rows, self.page_id, self.fail = rows, page_id, None

    def get_ad_spend_rows_90d(self, account_id, *, max_pages=8):
        return [dict(row) for row in self.rows]

    def _get(self, path, params=None):
        if self.fail is not None:
            raise self.fail
        return {"id": path, "creative": {"object_story_spec": {"page_id": self.page_id}}}

    def get_ad_page_identity(self, meta_ad_id):
        return meta_ads.MetaAdsClient.get_ad_page_identity(self, meta_ad_id)


def test_a_paused_page_lookup_is_not_remembered_as_a_miss(monkeypatch):
    init_db()
    original = meta_ads._load_partner_state()
    base = int(TAG, 16) % 10**6
    ads = [f"93{base:06d}{n:05d}" for n in range(3)]
    page_id = f"77{base:06d}00009"
    fake = _PartnerClient([{"adId": ads[0], "spendMinor": 6_000}, {"adId": ads[1], "spendMinor": 5_000},
                           {"adId": ads[2], "spendMinor": 1_000}], page_id)
    fake.fail = meta_ads.MetaAdsError("rate_limited", "Meta synchronization is paused safely and will resume automatically.",
                                      retryable=True)
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    config = SimpleNamespace(allowed_account_ids=("444444444444444",))
    try:
        paused = meta_ads._compute_partner_page_stats(config, refresh=True)
        misses = meta_ads._load_partner_state().get("adPageMisses") or {}
        assert not any(ad in misses for ad in ads)  # nothing is known about these ads yet
        assert paused["accountErrors"]
        fake.fail = None  # Meta answers again: the next refresh resolves them at once, not a day later
        fresh = meta_ads._compute_partner_page_stats(config, refresh=True)
        pages = {row["pageId"]: row for row in fresh["pages"]}
        assert page_id in pages and pages[page_id]["spendMinor"] == 12_000 and pages[page_id]["qualified"] is True
    finally:
        if original:
            meta_ads._save_partner_state(original)
        else:
            with db_conn() as conn:
                conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                             {"t": meta_ads._META_PARTNER_STATE_TYPE, "id": meta_ads._META_PARTNER_STATE_ID})


# ------------------------------------------------------------------ #14: a second outage the same day

def _wipe_connection() -> None:
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = 'connection'"),
                     {"t": meta_ads._META_HEALTH_STATE_TYPE})
        conn.execute(text(f"DELETE FROM entities WHERE type = :t AND {json_field_sql('kind')} = 'meta_connection_down'"),
                     {"t": studio_jobs.ALERTS_TYPE})


def _connection_alerts() -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text(f"SELECT id, data_json FROM entities WHERE type = :t AND {json_field_sql('kind')} = 'meta_connection_down'"),
            {"t": studio_jobs.ALERTS_TYPE},
        ).mappings().all()
    return [{**json_loads(row["data_json"]), "_id": str(row["id"])} for row in rows]


def test_a_second_outage_the_same_day_raises_a_fresh_alert():
    init_db()
    t0 = datetime(2027, 3, 10, 7, 0, tzinfo=UTC)  # 09:00 in Tripoli
    dead = {"configured": True, "isValid": False, "errorCode": "190.460"}
    _wipe_connection()
    try:
        assert watch.apply_token_reading({**dead, "checkedAt": _iso(t0)}, t0) == "down"
        [first] = _connection_alerts()
        # The channel sent it and an admin acknowledged it.
        assert studio_alert_out._stamp_sent(studio_jobs.ALERTS_TYPE, first["_id"], _iso(t0 + timedelta(minutes=5)))
        studio_jobs.acknowledge_alert(first["_id"], "", lambda *args, **kwargs: None, now=t0 + timedelta(minutes=10))
        # The watch's re-raise during the SAME outage refreshes that one alert, no new one.
        watch._raise_connection_alert(t0 + timedelta(minutes=20))
        assert len(_connection_alerts()) == 1
        # Recovery at 10:00, a new outage at 14:00 (same Tripoli day).
        valid = {"configured": True, "isValid": True, "checkedAt": _iso(t0 + timedelta(hours=1))}
        assert watch.apply_token_reading(valid, t0 + timedelta(hours=1)) == "ok"
        later = t0 + timedelta(hours=5)
        assert libya_today(later) == libya_today(t0)
        assert watch.apply_token_reading({**dead, "checkedAt": _iso(later)}, later) == "down"
        fresh = [alert for alert in _connection_alerts() if alert["_id"] != first["_id"]]
        assert len(fresh) == 1, _connection_alerts()
        second = fresh[0]
        assert not second.get("acknowledgedAt") and not second.get("channelSentAt")  # send_pending picks it up
        assert second["details"]["since"] == _iso(later)
        with db_conn() as conn:
            listed = studio_jobs.list_alerts_page(conn, limit=50, status="open")["alerts"]
        assert second["_id"] in [alert["id"] for alert in listed]  # it is in the admin's open list
    finally:
        _wipe_connection()


# ------------------------------------------------------------------ #15: a failed channel POST

class _Accepted:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_a_failed_channel_post_starts_no_cooldown(monkeypatch):
    monkeypatch.setenv("ALBAYAN_ALERT_WEBHOOK_URL", "https://alerts.example.invalid/hook")
    monkeypatch.setenv("ALBAYAN_ALERT_COOLDOWN_SECONDS", "1800")
    posts: list[int] = []

    def urlopen(request, timeout=10):
        posts.append(1)
        if len(posts) == 1:
            raise TimeoutError("the webhook timed out")
        return _Accepted()

    monkeypatch.setattr(operations, "urlopen", urlopen)
    kind = f"studio_stop:T-{TAG}"
    try:
        assert operations._send_alert(kind, "high", "message") is False  # the POST failed
        assert operations._send_alert(kind, "high", "message") is True  # tried again at once, not 30 minutes later
        assert len(posts) == 2
        assert operations._send_alert(kind, "high", "message") is False and len(posts) == 2  # a success keeps its cooldown
    finally:
        with operations._state_lock:
            operations._last_alert_at.pop(kind, None)
