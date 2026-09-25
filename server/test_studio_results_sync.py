"""Albayan Studio results sync and results card (plan tasks P3-01, P3-03, P3-04a/b/c; PLAN.md §7.1,
§7.3, §7.4; DECISIONS D26, D27, D28).

* meta_ads.get_campaign_results: a linked request only (allowlisted account, campaign claimed by
  THAT request; otherwise ``not_allowed`` and no call), one combined read, lifetime numbers,
  unreadable insights are "unknown", never 0.
* studio_results_sync: claims (one worker per request), the per-pass budget (<= 5 reads, <= 10 s),
  per-account parking, the 15-minute cadence, the final read at deliveryEndedAt + 48 h, daily drift
  reads until day 28, the post-settle drift and running-past-end alerts, the jobs-loop job; a Meta
  end time ends a campaign whose ads still say ACTIVE, a relink after an unlink is read again, a
  non-USD account never writes USD spend, and a steady due check parses no request.
* GET /api/studio/campaigns/{id}/results and POST .../results/refresh ("Check Meta now").

Meta is always faked: MetaAdsClient._request is replaced by FakeGraph (no network), so
get_campaign_results runs for real on top of it. Every test creates its own users, requests and
Meta ids (unique per run) and removes the rows it wrote.
"""

import copy
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
from sqlalchemy import event, text

import server.meta_ads as meta_ads
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_jobs, studio_results
from server.systems.ads_studio import studio_results_sync as sync
from server.systems.ads_studio.studio_results import RESULTS_TYPE, derive_display_stage, results_id, write_results_row
from server.systems.ads_studio.studio_settings import DEFAULTS

TAG = secrets.token_hex(4)
PASSWORD = "StudioResultsSyncPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
PREFIX = f"rsync_{TAG}_"
ACCOUNT = "7771" + f"{int(TAG, 16) % 10**8:08d}"
OTHER_ACCOUNT = "7772" + f"{int(TAG, 16) % 10**8:08d}"
UNLISTED_ACCOUNT = "7773" + f"{int(TAG, 16) % 10**8:08d}"
PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC"
UTC = timezone.utc
T0 = datetime(2027, 3, 10, 10, 0, tzinfo=UTC)  # Wednesday, 12:00 in Tripoli
SETTINGS = copy.deepcopy(DEFAULTS)
REAL_DUE = sync.due_candidates
_counter = [0]


def _uid(label: str = "cmp") -> str:
    _counter[0] += 1
    return f"{PREFIX}{_counter[0]:04d}_{label}"


def _meta_id() -> str:
    _counter[0] += 1
    return f"1208{int(TAG, 16) % 10**6:06d}{_counter[0]:05d}"


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _mine(now: datetime) -> list[dict]:
    """The due requests of THIS module (the database is shared with the whole suite)."""
    return [item for item in REAL_DUE(now) if item["campaignId"].startswith(PREFIX)]


# ------------------------------------------------------------------ fake Meta

class FakeGraph:
    """Meta's Graph API as MetaAdsClient._request sees it: campaigns, their ads, ad sets and insights."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.campaigns: dict[str, dict] = {}
        self.fail: dict[str, Exception] = {}  # a path, or "<id>?combined" for the combined read only
        self.during_read = None  # run once inside the next call (a claim race, a write in between)

    def add(self, meta_id: str, **fields) -> str:
        self.campaigns[meta_id] = {
            "account": ACCOUNT, "status": "ACTIVE", "ads": ("ACTIVE",), "adset_ends": ("",), "stop_time": "",
            "spend": "12.34", "impressions": 4321, "reach": 3000, "clicks": 77, "currency": "USD", "insights": True,
            "feedback": None, "name": f"ALB-S-TEST{meta_id[-4:]} · Spring offer", **fields,
        }
        return meta_id

    def set(self, meta_id: str, **fields) -> None:
        self.campaigns[meta_id].update(fields)

    def calls_for(self, meta_id: str) -> list[tuple[str, str, dict]]:
        return [call for call in self.calls if call[1].split("/")[0] == meta_id]

    def request(self, method, path, *, params=None, data=None, access_token=None, use_headroom=False):
        params = dict(params or {})
        self.calls.append((method, path, params))
        if self.during_read is not None:
            hook, self.during_read = self.during_read, None
            hook()
        combined = "ads.limit" in str(params.get("fields") or "")
        for key, error in self.fail.items():
            if key == path or (combined and key == f"{path}?combined"):
                raise error
        meta_id, _, edge = path.partition("/")
        campaign = self.campaigns.get(meta_id)
        if campaign is None:
            raise meta_ads.MetaAdsError("not_found", "not found", provider_code="100.33")
        ads = []
        for status in campaign["ads"]:
            ad = {"effective_status": status}
            if campaign["feedback"] and status == "DISAPPROVED":
                ad["ad_review_feedback"] = campaign["feedback"]
            ads.append(ad)
        adsets = [{"effective_status": "ACTIVE", **({"end_time": end} if end else {})} for end in campaign["adset_ends"]]
        row = {
            "spend": campaign["spend"], "impressions": str(campaign["impressions"]), "reach": str(campaign["reach"]),
            "clicks": str(campaign["clicks"]), "account_currency": campaign["currency"],
            "actions": [{"action_type": "link_click", "value": "9"},
                        {"action_type": "onsite_conversion.messaging_conversation_started_7d", "value": "25"}],
        }
        insights = {"data": [row]} if campaign["insights"] is True else {"data": []}
        if edge == "ads":
            return {"data": ads}
        if edge == "adsets":
            return {"data": adsets}
        if edge == "insights":
            if campaign["insights"] is False:
                raise meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True, provider_code="2")
            return insights
        status = campaign["status"]
        core = {
            "id": meta_id, "name": campaign["name"], "account_id": campaign["account"],
            "status": status if status in ("ACTIVE", "PAUSED", "DELETED", "ARCHIVED") else "ACTIVE",
            "effective_status": status, "start_time": "2027-03-01T08:00:00+0000",
            **({"stop_time": campaign["stop_time"]} if campaign["stop_time"] else {}),
        }
        if combined:
            core["ads"] = {"data": ads}
            core["adsets"] = {"data": adsets}
            if campaign["insights"] is not False:
                core["insights"] = insights  # Meta leaves an unreadable edge out of the expansion
        return core


# ------------------------------------------------------------------ people, requests, cleanup

def _insert_user(label: str, role: str, permissions: dict) -> dict:
    stamp = now_ms()
    user_id = new_id("rsync_user")
    email = f"studio-rsync-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Results {label}", "email": email, "role": role,
             "permissions": json_dumps(permissions), "hash": _HASH.hash_hex, "salt": _HASH.salt_hex,
             "algo": _HASH.algo, "iterations": _HASH.iterations, "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": user_id, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    customer = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "submitOwn"]}
    return {
        "owner": _insert_user("owner", "Employee", customer),
        "other": _insert_user("other", "Employee", customer),
        "reviewer": _insert_user("reviewer", "Employee", {CAMPAIGNS: ["view", "review"]}),
        "admin": _insert_user("admin", "Admin", {}),
    }


def _clear_parks() -> None:
    studio_jobs.update_job_state(lambda state: {sync.PARKS_FIELD: {}} if state.get(sync.PARKS_FIELD) else None)


@pytest.fixture
def seeded():
    """Collects the request ids a test wrote; deletes them, their results rows and their alerts."""
    written: list[str] = []
    yield written
    with db_conn() as conn:
        for campaign_id in written:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": CAMPAIGNS, "id": campaign_id})
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                         {"t": RESULTS_TYPE, "id": results_id(campaign_id)})
        conn.execute(text("DELETE FROM entities WHERE type = 'studioAlerts' AND (data_json LIKE :a OR data_json LIKE :b)"),
                     {"a": f"%{PREFIX}%", "b": f"%{ACCOUNT}%"})


@pytest.fixture
def meta(monkeypatch, people):
    fake = FakeGraph()
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"results-token-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", f"results-secret-{TAG}-never-leaks")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT},{OTHER_ACCOUNT}")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads.MetaAdsClient, "_request",
                        lambda self, method, path, **kwargs: fake.request(method, path, **kwargs))
    monkeypatch.setattr(meta_ads, "studio_meta_pause_seconds", lambda: 0)
    monkeypatch.setattr(sync, "due_candidates", _mine)
    for who in people.values():
        for bucket in ("campaign-results", "results-check"):
            reset_rate_limit(f"studio:{bucket}:{who['id']}")
    _clear_parks()
    yield fake
    _clear_parks()


def _request(seeded: list, owner: dict, *, meta_id: str = "", account: str = ACCOUNT, status: str = "Approved",
             start: str = "2027-03-01", end: str = "2027-03-20", archived: bool = False, linked_by: str = "",
             **data) -> str:
    campaign_id = _uid()
    stamp = now_ms()
    body = {
        "id": campaign_id, "createdBy": owner["id"], "_created": stamp, "_lastModified": stamp, "_deleted": archived,
        "status": status, "name": f"Spring offer {campaign_id[-4:]}", "startDate": start, "endDate": end,
        "budgetMinorUSD": 3000, "budgetType": "lifetime", "totalBudgetMinorUSD": 3000, "creativeImages": [PNG],
        "submittedAt": "2027-02-27T08:00:00Z",
    }
    if status in ("Approved", "Stopped"):
        body.update({"paidMinorUSD": 3000, "approvedBy": linked_by or "staff_x", "reviewedBy": linked_by or "staff_x"})
    if meta_id:
        body.update({
            "metaCampaignId": meta_id, "metaAdAccountId": f"act_{account}", "publishStatus": "meta_review",
            "linkedAt": "2027-03-01T09:00:00Z", "linkedBy": linked_by or "staff_x", "studioRef": "ALB-S-TESTTEST",
            "metaLinkResult": {"metaCurrency": "USD", "previousMetaName": f"PRIVATE-{TAG}", "warnings": []},
        })
    body.update(data)
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:stamp,:owner,:stamp)"
            ),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "deleted": archived, "stamp": stamp,
             "owner": owner["id"]},
        )
    seeded.append(campaign_id)
    return campaign_id


def _patch_request(campaign_id: str, **fields) -> None:
    """A staff-side write of the request: like the app's writes, it always moves last_modified on."""
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type = :t AND id = :id"),
                           {"t": CAMPAIGNS, "id": campaign_id}).mappings().first()
        data = {**(json_loads(row["data_json"]) or {}), **fields}
        conn.execute(text("UPDATE entities SET data_json = :d, last_modified = :m WHERE type = :t AND id = :id"),
                     {"d": json_dumps(data), "m": max(now_ms(), int(row["last_modified"]) + 1), "t": CAMPAIGNS,
                      "id": campaign_id})


def _row(campaign_id: str) -> dict:
    with db_conn() as conn:
        found = conn.execute(text("SELECT data_json, created_by FROM entities WHERE type = :t AND id = :id"),
                             {"t": RESULTS_TYPE, "id": results_id(campaign_id)}).mappings().first()
    if not found:
        return {}
    return {**(json_loads(found["data_json"]) or {}), "_createdBy": found["created_by"]}


def _alert(kind: str, related_id: str, now: datetime) -> dict | None:
    with db_conn() as conn:
        raw = conn.execute(text("SELECT data_json FROM entities WHERE type = 'studioAlerts' AND id = :id"),
                           {"id": studio_jobs.alert_id(kind, related_id, studio_jobs.libya_today(now).isoformat())}).scalar()
    return json_loads(raw) if raw else None


def _sync(campaign_id: str, now: datetime, settings: dict | None = None) -> dict:
    return sync.sync_campaign(campaign_id, now, settings=settings or SETTINGS)


def _linked(seeded, people, fake, **meta_fields) -> tuple[str, str]:
    meta_id = fake.add(_meta_id(), **meta_fields)
    return _request(seeded, people["owner"], meta_id=meta_id, linked_by=people["reviewer"]["id"]), meta_id


# ------------------------------------------------------------------ P3-01 get_campaign_results

def test_results_not_allowed_without_the_claim_or_an_allowed_account(meta, people, seeded, monkeypatch):
    meta_id = meta.add(_meta_id())
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        meta_ads.get_campaign_results(ACCOUNT, meta_id)  # no studio request claimed it
    assert refused.value.code == "not_allowed" and meta.calls == []
    campaign_id = _request(seeded, people["owner"], meta_id=meta_id)
    other_request = _request(seeded, people["owner"])
    for account, campaign, request_id in (
        (ACCOUNT, meta_id, other_request),  # claimed, but by another request
        (UNLISTED_ACCOUNT, meta_id, campaign_id),  # an account off the allowlist
        ("act_12x", meta_id, campaign_id), (ACCOUNT, "12ab", campaign_id), ("", "", campaign_id),
    ):
        with pytest.raises(meta_ads.MetaAdsError) as refused:
            meta_ads.get_campaign_results(account, campaign, request_id=request_id)
        assert refused.value.code == "not_allowed", (account, campaign)
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "")  # an empty allowlist refuses everything
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert refused.value.code == "not_allowed"
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT)
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert refused.value.code == "not_configured"
    assert meta.calls == []  # not one refused read reached Meta
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"results-token-{TAG}")
    assert meta_ads.get_campaign_results(f"act_{ACCOUNT}", meta_id, request_id=campaign_id)["campaignId"] == meta_id
    assert len(meta.calls) == 1


def test_results_one_combined_read_with_lifetime_numbers(meta, people, seeded):
    campaign_id, meta_id = _linked(
        seeded, people, meta, ads=("ACTIVE", "PAUSED", "DISAPPROVED"),
        adset_ends=("2027-03-20T21:59:00+0000", "2027-03-18T10:00:00+0000"),
        feedback={"global": {"Text policy": "Too much text in the image"}},
    )
    got = meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert len(meta.calls) == 1
    method, path, params = meta.calls[0]
    assert (method, path) == ("GET", meta_id)
    for part in ("effective_status", "ads.limit(", "adsets.limit(", "insights.date_preset(maximum)", "impressions", "reach"):
        assert part in params["fields"], part
    assert got["adStatusCounts"] == {"ACTIVE": 1, "PAUSED": 1, "DISAPPROVED": 1} and got["adsTotal"] == 3
    assert got["anyAdDelivering"] is True and got["effectiveStatus"] == "ACTIVE" and got["accountId"] == ACCOUNT
    assert (got["spendMinor"], got["impressions"], got["reach"], got["clicks"]) == (1234, 4321, 3000, 77)
    assert got["resultType"] == "onsite_conversion.messaging_conversation_started_7d" and got["resultCount"] == 25
    assert got["currency"] == "USD" and got["insightsState"] == "ok"
    assert got["adsetEndTime"] == "2027-03-20T21:59:00Z" and got["startTime"] == "2027-03-01T08:00:00Z"
    assert "Too much text in the image" in got["reviewFeedback"]
    meta.set(meta_id, adset_ends=("", "2027-03-18T10:00:00+0000"))  # one ad set runs until stopped
    assert meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)["adsetEndTime"] == ""
    meta.set(meta_id, insights="empty")  # nothing delivered yet: real zeros
    empty = meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert empty["insightsState"] == "ok" and empty["spendMinor"] == 0 and empty["impressions"] == 0


def test_results_slim_fallback_and_campaign_in_another_account(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta)
    meta.fail[f"{meta_id}?combined"] = meta_ads.MetaAdsError("request_failed", "Please reduce the amount of data")
    got = meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert [call[1] for call in meta.calls] == [meta_id, meta_id, f"{meta_id}/ads", f"{meta_id}/adsets", f"{meta_id}/insights"]
    assert got["spendMinor"] == 1234 and got["adStatusCounts"] == {"ACTIVE": 1}
    # An ad sets read Meta refuses: the end time is unknown (None), and the sync keeps the one it knew.
    meta.fail.clear()
    meta.set(meta_id, adset_ends=("2027-03-20T21:59:00+0000",))
    _sync(campaign_id, T0)
    assert _row(campaign_id)["adsetEndTime"] == "2027-03-20T21:59:00Z"
    meta.fail[f"{meta_id}?combined"] = meta_ads.MetaAdsError("request_failed", "Please reduce the amount of data")
    meta.fail[f"{meta_id}/adsets"] = meta_ads.MetaAdsError("request_failed", "Unsupported get request", provider_code="100")
    assert meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)["adsetEndTime"] is None
    _sync(campaign_id, T0 + timedelta(minutes=15))
    assert _row(campaign_id)["adsetEndTime"] == "2027-03-20T21:59:00Z"
    assert _row(campaign_id)["lastSyncedAt"] == _iso(T0 + timedelta(minutes=15))
    meta.fail.clear()
    meta.set(meta_id, account=OTHER_ACCOUNT)  # Meta says the campaign lives in another account
    with pytest.raises(meta_ads.MetaAdsError) as refused:
        meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert refused.value.code == "not_allowed"


def test_results_unreadable_insights_keep_the_last_good_spend(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta)
    assert _sync(campaign_id, T0)["outcome"] == "synced"
    first = _row(campaign_id)
    assert first["spendMinorUSD"] == 1234 and first["spendConfirmedAt"] == _iso(T0) and first["insightsState"] == "ok"
    meta.set(meta_id, insights=False, spend="0.00")
    got = meta_ads.get_campaign_results(ACCOUNT, meta_id, request_id=campaign_id)
    assert got["insightsState"] == "unavailable" and got["spendMinor"] is None and got["impressions"] is None
    later = T0 + timedelta(minutes=15)
    assert _sync(campaign_id, later)["outcome"] == "synced"
    row = _row(campaign_id)
    assert row["spendMinorUSD"] == 1234 and row["spendConfirmedAt"] == _iso(T0)  # never overwritten with 0
    assert row["lifetimeImpressions"] == 4321 and row["insightsState"] == "unavailable"
    assert row["lastSyncedAt"] == _iso(later)  # the statuses were read


# ------------------------------------------------------------------ P3-03 the sync

def test_sync_writes_the_row_and_reads_every_15_minutes(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta)
    assert [item["campaignId"] for item in _mine(T0)] == [campaign_id]  # a first read is due at once
    outcome = _sync(campaign_id, T0)
    assert outcome["outcome"] == "synced" and outcome["stage"] == 8 and outcome["alerts"] == []
    row = _row(campaign_id)
    assert row["_createdBy"] == people["owner"]["id"] and row["ownerId"] == people["owner"]["id"]
    assert row["metaCampaignId"] == meta_id and row["metaAdAccountId"] == f"act_{ACCOUNT}"
    assert row["syncState"] == "ok" and row["lastSyncedAt"] == _iso(T0) and row["syncClaimedUntil"] is None
    assert row["nextSyncAt"] == _iso(T0 + timedelta(minutes=15)) and row["metaStage"] == "running"
    assert row["costPerResultMinorUSD"] == 1234 // 25 and row["currency"] == "USD"
    assert row["deliveryEndedAt"] is None and row["settleReadDueAt"] is None
    assert _mine(T0 + timedelta(minutes=14)) == []
    assert [item["campaignId"] for item in _mine(T0 + timedelta(minutes=15))] == [campaign_id]


def test_sync_claims_and_budget(meta, people, seeded):
    # One worker per request: a claimed row is never read by a second sync.
    held, _meta_held = _linked(seeded, people, meta)
    with db_conn() as conn:
        write_results_row(conn, held, people["owner"]["id"], {"syncClaimedUntil": _iso(T0 + timedelta(minutes=1))})
    assert _sync(held, T0)["outcome"] == "claimed" and meta.calls == []
    assert held not in [item["campaignId"] for item in _mine(T0)]
    assert _sync(held, T0 + timedelta(minutes=2))["outcome"] == "synced"  # a crashed claim runs out
    # A second sync starting while the first one reads Meta finds the claim.
    racing, _meta_racing = _linked(seeded, people, meta)
    seen = []
    meta.during_read = lambda: seen.append(_sync(racing, T0))
    calls_before = len(meta.calls)
    assert _sync(racing, T0)["outcome"] == "synced"
    assert [item["outcome"] for item in seen] == ["claimed"] and len(meta.calls) == calls_before + 1
    # A write in between (another process) wins: the late result is dropped.
    lost, _meta_lost = _linked(seeded, people, meta)

    def someone_writes():
        with db_conn() as conn:
            write_results_row(conn, lost, people["owner"]["id"], {"lastErrorCode": "someone_else"})

    meta.during_read = someone_writes
    assert _sync(lost, T0)["outcome"] == "lost_claim"
    assert _row(lost)["lastSyncedAt"] is None and _row(lost)["lastErrorCode"] == "someone_else"
    assert lost not in [item["campaignId"] for item in _mine(T0 + timedelta(minutes=1))]  # its claim still runs
    assert lost in [item["campaignId"] for item in _mine(T0 + sync.CLAIM_FOR)]  # then it is read again
    # The budget: at most 5 reads a pass, and none started after 10 seconds.
    fresh = [_linked(seeded, people, meta)[0] for _ in range(8)]
    meta.calls.clear()
    report = sync.run_results_sync(T0, settings=SETTINGS)
    assert report["reads"] == 5 and len(meta.calls) == 5 and len(report["synced"]) == 5
    ticks = iter([0.0, 3.0, 6.0, 9.0, 12.0, 15.0])
    meta.calls.clear()
    slow = sync.run_results_sync(T0, settings=SETTINGS, clock=lambda: next(ticks))
    assert slow["reads"] == 3 and len(meta.calls) == 3  # 0, 3, 6 s started; at 12 s the pass stops
    done = set(report["synced"]) | set(slow["synced"])
    assert done <= set(fresh + [lost]) and len(done) == 8


def test_per_account_parking(meta, people, seeded):
    first, meta_first = _linked(seeded, people, meta)
    second, meta_second = _linked(seeded, people, meta)
    elsewhere, meta_elsewhere = _linked(seeded, people, meta, account=OTHER_ACCOUNT)
    _patch_request(elsewhere, metaAdAccountId=f"act_{OTHER_ACCOUNT}")
    meta.fail[meta_first] = meta_ads.MetaAdsError("rate_limited", "Meta is temporarily limiting synchronization.",
                                                  retryable=True, provider_code="80004")
    report = sync.run_results_sync(T0, settings=SETTINGS)
    assert report["parked"] == [ACCOUNT] and report["synced"] == [elsewhere]
    assert report["errors"] == [{"campaignId": first, "code": "rate_limited"}]
    assert meta.calls_for(meta_second) == []  # the parked account's other request waits
    row = _row(first)
    assert row["syncState"] == "throttled" and row["lastErrorCode"] == "rate_limited:80004"
    assert row["nextSyncAt"] == _iso(T0 + sync.PARK_FOR) and row["syncClaimedUntil"] is None
    assert sync.active_parks(T0 + timedelta(minutes=1)) == {ACCOUNT: T0 + sync.PARK_FOR}
    parked = _alert("results_parked", f"act_{ACCOUNT}", T0)
    assert parked and parked["ownerId"] is None and parked["details"] == {"until": _iso(T0 + sync.PARK_FOR)}
    meta.calls.clear()
    assert sync.run_results_sync(T0 + timedelta(minutes=5), settings=SETTINGS)["reads"] == 0 and meta.calls == []
    meta.fail.clear()
    later = sync.run_results_sync(T0 + timedelta(minutes=16), settings=SETTINGS)
    assert sorted(later["synced"]) == sorted([first, second, elsewhere]) and later["parked"] == []
    assert sync.active_parks(T0 + timedelta(minutes=16)) == {}


def test_meta_pause_and_missing_configuration_skip_the_pass(meta, people, seeded, monkeypatch):
    first, _meta_first = _linked(seeded, people, meta)
    second, _meta_second = _linked(seeded, people, meta)
    monkeypatch.setattr(meta_ads, "studio_meta_pause_seconds", lambda: 120)
    assert sync.run_results_sync(T0, settings=SETTINGS)["skipped"] == "meta_paused" and meta.calls == []
    monkeypatch.setattr(meta_ads, "studio_meta_pause_seconds", lambda: 0)
    # Albayan's own pause starting mid-pass: nothing reached Meta, the pass stops, the row waits.
    meta.fail[_meta_first] = meta_ads.MetaAdsError(
        "rate_limited", "Meta synchronization is paused safely and will resume automatically.", retryable=True)
    report = sync.run_results_sync(T0, settings=SETTINGS)
    assert report["skipped"] == "stopped" and report["reads"] == 0 and report["parked"] == []
    assert _row(first)["syncState"] == "throttled" and _row(second) == {}
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    assert sync.run_results_sync(T0, settings=SETTINGS)["skipped"] == "not_configured"


def test_unlinked_or_closed_requests_are_never_read(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta)
    assert _sync(campaign_id, T0)["outcome"] == "synced"
    _patch_request(campaign_id, metaCampaignId="", metaAdAccountId="", publishStatus="")  # the staff unlink
    meta.calls.clear()
    due = T0 + timedelta(minutes=15)
    assert [item["campaignId"] for item in _mine(due)] == [campaign_id]  # the row was due
    assert _sync(campaign_id, due)["outcome"] == "not_linked" and meta.calls == []
    row = _row(campaign_id)
    assert row["syncState"] == "not_allowed" and row["nextSyncAt"] is None and row["spendMinorUSD"] == 1234
    assert _mine(due + timedelta(days=1)) == []
    draft = _request(seeded, people["owner"], meta_id=meta.add(_meta_id()), status="Rejected")
    assert _sync(draft, T0)["outcome"] == "not_linked" and meta.calls == [] and _row(draft) == {}


def test_relink_starts_the_row_again(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta, spend="25.00")
    assert _sync(campaign_id, T0)["outcome"] == "synced" and _row(campaign_id)["spendMinorUSD"] == 2500
    new_meta = meta.add(_meta_id(), ads=("PENDING_REVIEW",), insights="empty")
    _patch_request(campaign_id, metaCampaignId=new_meta)
    assert [item["campaignId"] for item in _mine(T0 + timedelta(minutes=1))] == [campaign_id]
    assert _sync(campaign_id, T0 + timedelta(minutes=1))["stage"] == 5
    row = _row(campaign_id)
    assert row["metaCampaignId"] == new_meta and row["spendMinorUSD"] == 0 and row["adStatusCounts"] == {"PENDING_REVIEW": 1}


@pytest.mark.parametrize("campaign_status, ads, end, stage", [
    ("ACTIVE", ("PENDING_REVIEW",), "2027-03-20", 5),
    ("ACTIVE", ("IN_PROCESS", "PAUSED"), "2027-03-20", 5),
    ("ACTIVE", ("DISAPPROVED", "DISAPPROVED"), "2027-03-20", 6),
    ("ACTIVE", ("WITH_ISSUES",), "2027-03-20", 7),
    ("ACTIVE", ("PENDING_BILLING_INFO",), "2027-03-20", 7),
    ("WITH_ISSUES", ("PAUSED",), "2027-03-20", 7),
    ("ACTIVE", ("ACTIVE",), "2027-03-05", 8),
    ("PAUSED", ("CAMPAIGN_PAUSED",), "2027-03-20", 9),
    ("ACTIVE", ("PAUSED", "ADSET_PAUSED"), "2027-03-20", 9),
    ("ACTIVE", ("PAUSED",), "2027-03-05", 10),
    ("DELETED", ("PAUSED",), "2027-03-20", 10),
    ("ACTIVE", (), "2027-03-20", 4),
], ids=["pending_review", "in_process", "disapproved", "with_issues", "billing", "campaign_with_issues",
        "active_after_end", "campaign_paused", "ads_paused", "ended", "deleted", "no_ads_yet"])
def test_stage_mapping_meta_statuses(meta, people, seeded, campaign_status, ads, end, stage):
    """P3-04a: Meta's statuses, read through the sync, give the stage (and the stage stays PURE)."""
    campaign_id, _meta_id_ = _linked(seeded, people, meta, status=campaign_status, ads=ads)
    _patch_request(campaign_id, endDate=end)
    outcome = _sync(campaign_id, T0)
    assert outcome["stage"] == stage
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    assert derive_display_stage(request, _row(campaign_id), T0)["stage"] == stage
    assert outcome["alerts"] == (["running_past_end"] if stage == 8 else [])


def test_running_past_end_alert(meta, people, seeded):
    campaign_id, _meta_id_ = _linked(seeded, people, meta)
    _patch_request(campaign_id, endDate="2027-03-05")
    assert _sync(campaign_id, T0)["alerts"] == ["running_past_end"]
    alert = _alert("running_past_end", campaign_id, T0)
    assert alert and alert["ownerId"] == people["owner"]["id"] and alert["details"]["stage"] == 8
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    assert derive_display_stage(request, _row(campaign_id), T0)["runningPastEnd"] is True
    # A stop request is not "past the end" (it has its own chip); a Stopped request still ACTIVE is.
    asked, _meta_asked = _linked(seeded, people, meta)
    _patch_request(asked, stopRequestedAt=_iso(T0 - timedelta(minutes=5)))
    assert _sync(asked, T0)["alerts"] == [] and _row(asked)["stopEffectiveAt"] is None
    stopped, _meta_stopped = _linked(seeded, people, meta)
    _patch_request(stopped, status="Stopped", closeReason="staff_stop", spendMinorUSD=1234)
    assert _sync(stopped, T0)["alerts"] == ["running_past_end"]


def test_stop_effective_and_never_delivered(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta, insights="empty")
    _patch_request(campaign_id, stopRequestedAt=_iso(T0 - timedelta(hours=1)))
    meta.set(meta_id, ads=("PAUSED",))
    assert _sync(campaign_id, T0)["stage"] == 10
    row = _row(campaign_id)
    assert row["stopEffectiveAt"] == _iso(T0) and row["deliveryEndedAt"] == _iso(T0)
    assert row["neverDelivered"] is True  # 0 impressions and $0: settled at once (neverDeliveredImmediate)
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    shown = derive_display_stage(request, row, T0)
    assert shown["variant"] == "never_delivered" and shown["moneyKey"] == "full_return"
    later = dict(SETTINGS, settlement={**SETTINGS["settlement"], "neverDeliveredImmediate": False})
    waiting, _meta_waiting = _linked(seeded, people, meta, insights="empty", ads=("PAUSED",))
    _patch_request(waiting, endDate="2027-03-05")
    _sync(waiting, T0, later)
    assert _row(waiting)["neverDelivered"] is False  # only the final read decides then
    _sync(waiting, T0 + timedelta(hours=48), later)
    assert _row(waiting)["neverDelivered"] is True


def test_settle_read_scheduled_at_48h(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta, spend="20.00")
    _patch_request(campaign_id, endDate="2027-03-12")
    assert _sync(campaign_id, T0)["stage"] == 8
    ended = datetime(2027, 3, 13, 8, 0, tzinfo=UTC)  # 10:00 in Tripoli, the day after the end date
    meta.set(meta_id, ads=("PAUSED",))
    assert _sync(campaign_id, ended)["stage"] == 10
    row = _row(campaign_id)
    settle_due = ended + timedelta(hours=48)
    assert row["deliveryEndedAt"] == _iso(ended) and row["settleReadDueAt"] == _iso(settle_due)
    assert row["driftWatchUntil"] == _iso(ended + timedelta(days=28)) and row["settleReadAt"] is None
    assert row["nextSyncAt"] == _iso(settle_due)  # one read, AT settleReadDueAt
    assert _mine(settle_due - timedelta(hours=1)) == []
    assert [item["campaignId"] for item in _mine(settle_due)] == [campaign_id]
    meta.set(meta_id, spend="20.40")
    assert _sync(campaign_id, settle_due)["stage"] == 10
    final = _row(campaign_id)
    assert final["settleReadAt"] == _iso(settle_due) and final["spendMinorUSD"] == 2040
    assert final["deliveryEndedAt"] == _iso(ended) and final["nextSyncAt"] == _iso(settle_due + timedelta(days=1))
    # The final read needs Meta's insights: an unreadable one is tried again in 30 minutes.
    other, meta_other = _linked(seeded, people, meta, ads=("PAUSED",))
    _patch_request(other, endDate="2027-03-05")
    _sync(other, T0)
    meta.set(meta_other, insights=False)
    _sync(other, T0 + timedelta(hours=48))
    assert _row(other)["settleReadAt"] is None
    assert _row(other)["nextSyncAt"] == _iso(T0 + timedelta(hours=48) + sync.RETRY_AFTER_ERROR)
    # The wait follows settlement.spendDelayHours; delivery that starts again clears the times.
    quick = dict(SETTINGS, settlement={**SETTINGS["settlement"], "spendDelayHours": 24})
    third, meta_third = _linked(seeded, people, meta, ads=("PAUSED",))
    _patch_request(third, stopRequestedAt=_iso(T0 - timedelta(hours=1)))
    _sync(third, T0, quick)
    assert _row(third)["settleReadDueAt"] == _iso(T0 + timedelta(hours=24))
    meta.set(meta_third, ads=("ACTIVE",))
    _sync(third, T0 + timedelta(hours=1), quick)
    again = _row(third)
    assert again["deliveryEndedAt"] is None and again["settleReadDueAt"] is None and again["driftWatchUntil"] is None
    assert again["nextSyncAt"] == _iso(T0 + timedelta(hours=1) + sync.ACTIVE_EVERY)


def test_drift_watch_until_day_28(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta, ads=("PAUSED",), spend="20.00")
    _patch_request(campaign_id, endDate="2027-03-05")
    ended = T0
    _sync(campaign_id, ended)
    _sync(campaign_id, ended + timedelta(hours=48))  # the final read
    assert _row(campaign_id)["settleReadAt"] == _iso(ended + timedelta(hours=48))
    # Staff settle at the final read's $20.00 (the stop records what was spent).
    _patch_request(campaign_id, status="Stopped", closeReason="completed", spendMinorUSD=2000, refundMinorUSD=1000)
    day = ended + timedelta(days=3)
    assert _sync(campaign_id, day)["alerts"] == []
    assert _row(campaign_id)["nextSyncAt"] == _iso(day + timedelta(days=1))  # daily drift reads
    day20 = ended + timedelta(days=20)
    meta.set(meta_id, spend="20.50")  # exactly $0.50 more: within the tolerance
    assert _sync(campaign_id, day20)["alerts"] == [] and _alert(sync.DRIFT_ALERT, campaign_id, day20) is None
    meta.set(meta_id, spend="20.51")
    assert _sync(campaign_id, day20 + timedelta(hours=1))["alerts"] == [sync.DRIFT_ALERT]
    drift = _alert(sync.DRIFT_ALERT, campaign_id, day20)
    assert drift["details"]["driftMinorUSD"] == 51 and drift["details"]["settledSpendMinorUSD"] == 2000
    assert drift["ownerId"] == people["owner"]["id"] and drift["relatedType"] == CAMPAIGNS
    # A settle step's own figure wins over the stop's.
    _patch_request(campaign_id, settledSpendMinorUSD=2051, settleBasis="final_read")
    assert _sync(campaign_id, day20 + timedelta(hours=2))["alerts"] == []
    day27 = ended + timedelta(days=27, hours=12)
    _sync(campaign_id, day27)
    assert _row(campaign_id)["nextSyncAt"] == _iso(ended + timedelta(days=28))  # the last read is on day 28
    _sync(campaign_id, ended + timedelta(days=28))
    assert _row(campaign_id)["nextSyncAt"] is None and _mine(ended + timedelta(days=40)) == []


def test_currency_mismatch_hides_meta_used(meta, people, seeded):
    campaign_id, _meta_id_ = _linked(seeded, people, meta, currency="EUR")
    assert _sync(campaign_id, T0)["outcome"] == "synced"
    row = _row(campaign_id)
    assert row["currency"] == "EUR" and row["syncState"] == "error" and row["lastErrorCode"] == "currency_mismatch"
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    shown = derive_display_stage(request, row, T0)
    assert shown["stage"] == 8 and shown["metaUsedMinor"] is None


def test_a_non_usd_ad_account_never_writes_usd_spend(meta, people, seeded):
    """EUR 12.34 is never stored as $12.34: no spendMinorUSD, spendConfirmedAt or final read; the raw
    amount and its currency are kept apart for staff."""
    campaign_id, meta_id = _linked(seeded, people, meta, currency="EUR", spend="12.34", ads=("PAUSED",))
    _patch_request(campaign_id, endDate="2027-03-05")  # delivery has ended
    assert _sync(campaign_id, T0)["stage"] == 10
    row = _row(campaign_id)
    assert row["spendMinorUSD"] == 0 and row["spendConfirmedAt"] is None and row["costPerResultMinorUSD"] is None
    assert row["rawSpendMinor"] == 1234 and row["rawSpendCurrency"] == "EUR" and row["currency"] == "EUR"
    assert row["syncState"] == "error" and row["lastErrorCode"] == "currency_mismatch"
    assert row["impressions"] == 4321 and row["neverDelivered"] is False  # counts are not money: kept
    settle_due = T0 + timedelta(hours=48)
    assert row["nextSyncAt"] == _iso(settle_due)
    # The final read never lands in another currency: no settleReadAt, then one read a day (not every
    # 30 minutes), and none after the drift watch.
    _sync(campaign_id, settle_due)
    final = _row(campaign_id)
    assert final["settleReadAt"] is None and final["spendConfirmedAt"] is None and final["spendMinorUSD"] == 0
    assert final["nextSyncAt"] == _iso(settle_due + timedelta(days=1))
    _sync(campaign_id, T0 + timedelta(days=28))
    assert _row(campaign_id)["nextSyncAt"] is None
    # Staff see the raw amount; the customer sees the counts but no "Meta used" value.
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    view = studio_results.results_view(request, _row(campaign_id), T0, staff=True)
    assert view["results"]["metaUsedMinor"] is None and view["results"]["costPerResultMinor"] is None
    assert view["results"]["impressions"] == 4321 and "rawSpendMinor" not in json.dumps(view["results"])
    assert (view["staff"]["rawSpendMinor"], view["staff"]["rawSpendCurrency"]) == (1234, "EUR")
    # Settled: the drift check never compares EUR with USD.
    _patch_request(campaign_id, status="Stopped", closeReason="completed", spendMinorUSD=0)
    meta.set(meta_id, spend="99.00")
    assert _sync(campaign_id, T0 + timedelta(days=3))["alerts"] == []
    assert _row(campaign_id)["rawSpendMinor"] == 9900 and _row(campaign_id)["spendMinorUSD"] == 0


# ------------------------------------------------------------------ Meta end times, relinks, the due check

def test_a_campaign_ended_on_its_meta_end_time_is_not_running(meta, people, seeded):
    """Reproduction: Meta keeps the ads ACTIVE after the ad set end_time, and the request stayed
    Running forever (no deliveryEndedAt, no 48 h final read, a running_past_end alert every day)."""
    campaign_id, meta_id = _linked(seeded, people, meta, adset_ends=("2027-03-09T22:00:00+0000",))
    outcome = _sync(campaign_id, T0)
    assert outcome["stage"] == 10 and outcome["alerts"] == []
    row = _row(campaign_id)
    assert row["adStatusCounts"] == {"ACTIVE": 1} and row["metaStage"] == "ended_settling"
    assert row["deliveryEndedAt"] == "2027-03-09T22:00:00Z"  # when Meta stopped, not when Albayan looked
    settle_due = datetime(2027, 3, 11, 22, 0, tzinfo=UTC)
    assert row["settleReadDueAt"] == _iso(settle_due) and row["nextSyncAt"] == _iso(settle_due)
    assert _alert("running_past_end", campaign_id, T0) is None
    with db_conn() as conn:
        request = studio_results.load_request(conn, campaign_id)
    assert studio_results.meta_delivery(request, row, T0) == {
        "delivering": False, "reviewing": False, "pastEnd": True, "ended": True}
    shown = derive_display_stage(request, row, T0)
    assert shown["stage"] == 10 and shown["runningPastEnd"] is False and shown["metaUsedMinor"] == 1234
    day2 = T0 + timedelta(days=1)
    assert _sync(campaign_id, day2)["alerts"] == [] and _alert("running_past_end", campaign_id, day2) is None
    _sync(campaign_id, settle_due)  # the final read, 48 h after Meta's end
    final = _row(campaign_id)
    assert final["settleReadAt"] == _iso(settle_due) and final["nextSyncAt"] == _iso(settle_due + timedelta(days=1))
    # The campaign's stop_time ends it the same way; with both passed the earlier one is the end.
    stopped, _meta_stopped = _linked(seeded, people, meta, stop_time="2027-03-10T06:00:00+0000")
    assert _sync(stopped, T0)["stage"] == 10 and _row(stopped)["deliveryEndedAt"] == "2027-03-10T06:00:00Z"
    both, _meta_both = _linked(seeded, people, meta, stop_time="2027-03-10T06:00:00+0000",
                               adset_ends=("2027-03-09T20:00:00+0000",))
    assert _sync(both, T0)["stage"] == 10 and _row(both)["deliveryEndedAt"] == "2027-03-09T20:00:00Z"
    # An end time still ahead keeps it Running (and a later extension starts delivery again).
    meta.set(meta_id, adset_ends=("2027-03-20T21:59:00+0000",))
    extended = settle_due + timedelta(hours=1)
    assert _sync(campaign_id, extended)["stage"] == 8
    assert _row(campaign_id)["deliveryEndedAt"] is None and _row(campaign_id)["nextSyncAt"] == _iso(extended + sync.ACTIVE_EVERY)
    # The pure helper.
    ends = studio_results.normalize_results({"adsetEndTime": "2027-03-10T12:00:00Z", "campaignStopTime": "2027-03-10T09:00:00Z"})
    assert studio_results.meta_time_ended_at(ends, T0) == datetime(2027, 3, 10, 9, 0, tzinfo=UTC)
    assert studio_results.meta_time_ended_at(ends, T0 - timedelta(hours=2)) is None
    assert studio_results._meta_time_ended(ends, T0 + timedelta(hours=2)) is True
    assert studio_results._meta_time_ended(studio_results.normalize_results({}), T0) is False


def test_relink_of_the_same_campaign_after_an_unlink_is_read_again(meta, people, seeded):
    """Reproduction: the sync saw the unlink (not_allowed, no nextSyncAt, the Meta id kept); staff then
    linked the SAME campaign again and it was never read again."""
    campaign_id, meta_id = _linked(seeded, people, meta)
    assert _sync(campaign_id, T0)["outcome"] == "synced"
    _patch_request(campaign_id, metaCampaignId="", metaAdAccountId="", publishStatus="")
    later = T0 + timedelta(minutes=15)
    assert _sync(campaign_id, later)["outcome"] == "not_linked"
    stranded = _row(campaign_id)
    assert stranded["syncState"] == "not_allowed" and stranded["nextSyncAt"] is None
    assert stranded["metaCampaignId"] == meta_id
    assert _mine(later + timedelta(minutes=1)) == []  # not linked: nothing to read
    _patch_request(campaign_id, metaCampaignId=meta_id, metaAdAccountId=f"act_{ACCOUNT}", publishStatus="meta_review")
    relinked = later + timedelta(minutes=2)
    assert [(item["campaignId"], item["dueAt"]) for item in _mine(relinked)] == [(campaign_id, sync._EPOCH)]
    meta.set(meta_id, spend="30.00")
    assert sync.run_results_sync(relinked, settings=SETTINGS)["synced"] == [campaign_id]
    row = _row(campaign_id)
    assert row["syncState"] == "ok" and row["spendMinorUSD"] == 3000
    assert row["nextSyncAt"] == _iso(relinked + sync.ACTIVE_EVERY)
    assert _mine(relinked + timedelta(minutes=1)) == []  # read: its nextSyncAt decides again
    # A Meta refusal (not_allowed with a retry time) is not stranded: it waits its 6 hours.
    meta.set(meta_id, account=OTHER_ACCOUNT)
    assert _sync(campaign_id, relinked + timedelta(minutes=15))["outcome"] == "error"
    assert _row(campaign_id)["syncState"] == "not_allowed" and _mine(relinked + timedelta(minutes=16)) == []


def _sql_spy(statements: list):
    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append((statement, parameters))

    return record


def test_a_steady_due_check_parses_no_request(meta, people, seeded, monkeypatch):
    """The 30-second tick reads the live Approved requests' ids and versions only (the status index);
    a request's JSON (images included) is parsed again only after it changed, and the answers stay
    the same as a fresh process's."""
    monkeypatch.setattr(sync, "_LINK_MEMO", {})
    campaign_id, _meta_first = _linked(seeded, people, meta)
    waiting = _request(seeded, people["owner"])  # Approved, not linked yet
    _sync(campaign_id, T0)
    REAL_DUE(T0)  # a first look reads each Approved request once
    engine = get_engine()
    statements: list = []
    spy = _sql_spy(statements)
    event.listen(engine, "before_cursor_execute", spy)
    try:
        REAL_DUE(T0 + timedelta(minutes=1))
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    reads = [statement for statement, _params in statements if CAMPAIGNS in statement]
    assert reads == [sync.approved_requests_sql()], reads
    assert reads[0].startswith("SELECT id, last_modified FROM entities WHERE ")
    # Literal type and status: the partial index idx_ad_campaign_requests_status (add_jsonb_indexes.py) matches it.
    assert f"type = '{CAMPAIGNS}' AND deleted = false AND " in reads[0] and reads[0].endswith("= 'Approved'")
    # The staff link changes one request: that one alone is read again, at once.
    _patch_request(waiting, metaCampaignId=meta.add(_meta_id()), metaAdAccountId=f"act_{ACCOUNT}")
    statements.clear()
    event.listen(engine, "before_cursor_execute", spy)
    try:
        due = [item["campaignId"] for item in REAL_DUE(T0 + timedelta(minutes=2)) if item["campaignId"].startswith(PREFIX)]
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    parsed = [params for statement, params in statements if CAMPAIGNS in statement and statement != reads[0]]
    assert len(parsed) == 1 and waiting in (list(parsed[0].values()) if isinstance(parsed[0], dict) else list(parsed[0]))
    assert len(parsed[0]) == 1 and due == [waiting]  # its first read; the other waits for its nextSyncAt
    # The memo changes nothing: a fresh process gives the same answer.
    monkeypatch.setattr(sync, "_LINK_MEMO", {})
    assert [item["campaignId"] for item in REAL_DUE(T0 + timedelta(minutes=2)) if item["campaignId"].startswith(PREFIX)] == due
    # An unchanged request is still read again after LINK_MEMO_FOR (a write that kept its last_modified).
    statements.clear()
    event.listen(engine, "before_cursor_execute", spy)
    try:
        REAL_DUE(T0 + timedelta(minutes=2) + sync.LINK_MEMO_FOR)
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    assert any(CAMPAIGNS in statement and statement != reads[0] for statement, _params in statements)


def test_meta_errors_keep_the_last_good_values(meta, people, seeded):
    campaign_id, meta_id = _linked(seeded, people, meta)
    _sync(campaign_id, T0)
    for error, state, retry in (
        (meta_ads.MetaAdsError("not_found", "gone", provider_code="100.33"), "not_found", sync.RETRY_NOT_FOUND),
        (meta_ads.MetaAdsError("request_failed", "Invalid parameter", provider_code="100"), "error", sync.RETRY_AFTER_ERROR),
        (meta_ads.MetaAdsError("authorization", "Meta authorization failed.", provider_code="190"), "error", sync.PARK_FOR),
    ):
        meta.fail[meta_id] = error
        meta.fail[f"{meta_id}?combined"] = error
        at = T0 + timedelta(hours=1)
        outcome = _sync(campaign_id, at)
        assert outcome["outcome"] == "error" and outcome["park"] == (ACCOUNT if error.code == "authorization" else "")
        row = _row(campaign_id)
        assert row["syncState"] == state and row["nextSyncAt"] == _iso(at + retry)
        assert row["lastErrorCode"] == f"{error.code}:{error.provider_code}"
        assert row["spendMinorUSD"] == 1234 and row["lastSyncedAt"] == _iso(T0) and row["adStatusCounts"] == {"ACTIVE": 1}
        assert f"results-token-{TAG}" not in json.dumps(row)


def test_the_jobs_loop_claims_the_results_job_only_with_a_token(meta, monkeypatch):
    runs = []
    monkeypatch.setattr(studio_jobs, "sweep_orphans", lambda ctx, now, full=False: {})
    monkeypatch.setattr(studio_jobs, "check_waiting_requests", lambda now: {})
    monkeypatch.setattr(sync, "run_results_sync", lambda now: runs.append(now) or {"reads": 0})
    monkeypatch.setattr(studio_jobs, "meta_watch_configured", lambda: False)  # the Meta watch (P3-18) has its own tests
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"),
                     {"t": studio_jobs.JOB_STATE_TYPE, "id": studio_jobs.JOB_STATE_ID})
    base = datetime(2027, 3, 20, 0, 30, tzinfo=UTC)  # 02:30 in Tripoli: before the daily check
    ran = studio_jobs.run_tick(lambda: {}, base)
    assert ran["claimed"] == ["sweep", "waiting", "results"] and ran["results"] == {"reads": 0} and runs == [base]
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(seconds=10))["claimed"] == []
    assert studio_jobs.run_tick(lambda: {}, base + timedelta(seconds=30))["claimed"] == ["results"]
    assert studio_jobs.jobs_heartbeat(base + timedelta(seconds=31))["lastResultsSyncAt"] == _iso(base + timedelta(seconds=30))
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    assert "results" not in studio_jobs.run_tick(lambda: {}, base + timedelta(minutes=5))["claimed"]
    assert len(runs) == 2


# ------------------------------------------------------------------ P3-04b the results route

def _get(campaign_id: str, who: dict):
    return client.get(f"/api/studio/campaigns/{campaign_id}/results", cookies=who["cookies"])


def test_results_route_owner_staff_and_404s(meta, people, seeded, monkeypatch):
    monkeypatch.setattr(studio_results, "utc_now", lambda: T0 + timedelta(minutes=5))
    campaign_id, meta_id = _linked(seeded, people, meta)
    _sync(campaign_id, T0)
    owner = _get(campaign_id, people["owner"])
    assert owner.status_code == 200, owner.text
    body = owner.json()
    assert body["stage"]["stage"] == 8 and body["linked"] is True and "staff" not in body
    results = body["results"]
    assert results["metaUsedMinor"] == 1234 and results["paidMinor"] == 3000 and results["currency"] == "USD"
    assert (results["impressions"], results["reach"], results["resultCount"]) == (4321, 3000, 25)
    assert results["checkedAt"] == _iso(T0) and results["checkedAgo"]["en"] == "checked 5 minutes ago"
    assert results["checkedAgo"]["ar"] == "فُحص قبل 5 دقائق" and results["stale"] is False
    for secret in (people["reviewer"]["id"], "staff_x", f"PRIVATE-{TAG}", "reviewFeedbackStaff", "lastErrorCode", meta_id,
                   "creativeImages"):
        assert secret not in owner.text, secret
    staff = _get(campaign_id, people["reviewer"])
    assert staff.status_code == 200 and staff.json()["staff"]["syncState"] == "ok"
    assert staff.json()["staff"]["metaCampaignId"] == meta_id and staff.json()["staff"]["nextManualCheckAt"] is None
    assert _get(campaign_id, people["admin"]).status_code == 200
    for who in ("other",):
        refused = _get(campaign_id, people[who])
        assert refused.status_code == 404 and refused.json()["detail"]["code"] == "UNKNOWN_CAMPAIGN"
    draft = _request(seeded, people["owner"], status="Draft")
    archived = _request(seeded, people["owner"], meta_id=meta.add(_meta_id()), archived=True)
    assert _get(draft, people["owner"]).status_code == 200  # the owner's own draft: stage 1, no numbers
    assert _get(draft, people["owner"]).json()["results"]["metaUsedMinor"] is None
    assert _get(draft, people["reviewer"]).status_code == 404  # a private draft is never confirmed to staff
    for unknown in (archived, f"{PREFIX}missing", "bad id!"):
        assert _get(unknown, people["owner"]).status_code == 404
    client.cookies.clear()
    assert client.get(f"/api/studio/campaigns/{campaign_id}/results").status_code == 401
    # An Approved request not linked yet: stage 4, no "Meta used" line and no numbers.
    unlinked = _request(seeded, people["owner"])
    shown = _get(unlinked, people["owner"]).json()
    assert shown["stage"]["stage"] == 4 and shown["linked"] is False
    assert shown["results"]["metaUsedMinor"] is None and shown["results"]["impressions"] is None
    assert shown["results"]["paidMinor"] == 3000


def test_results_route_keeps_last_good_values_on_errors(meta, people, seeded, monkeypatch):
    monkeypatch.setattr(studio_results, "utc_now", lambda: T0 + timedelta(hours=2))
    campaign_id, meta_id = _linked(seeded, people, meta)
    _sync(campaign_id, T0)
    meta.fail[f"{meta_id}?combined"] = meta_ads.MetaAdsError("timeout", "Meta did not answer in time.", retryable=True)
    assert _sync(campaign_id, T0 + timedelta(hours=1))["outcome"] == "error"
    body = _get(campaign_id, people["owner"]).json()
    assert body["results"]["metaUsedMinor"] == 1234 and body["results"]["impressions"] == 4321
    assert body["results"]["checkedAt"] == _iso(T0) and body["stage"]["stage"] == 8
    staff = _get(campaign_id, people["reviewer"]).json()["staff"]
    assert staff["syncState"] == "error" and staff["lastErrorCode"] == "timeout"


# ------------------------------------------------------------------ P3-04c "Check Meta now"

def _refresh(campaign_id: str, who: dict, **kwargs):
    return client.post(f"/api/studio/campaigns/{campaign_id}/results/refresh", cookies=who["cookies"], **kwargs)


def test_check_now_cached(meta, people, seeded, monkeypatch):
    clock = [T0]
    monkeypatch.setattr(studio_results, "utc_now", lambda: clock[0])
    campaign_id, meta_id = _linked(seeded, people, meta)
    first = _refresh(campaign_id, people["reviewer"])
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["cached"] is False and body["checkError"] is None and len(meta.calls) == 1
    assert body["nextAllowedAt"] == _iso(T0 + timedelta(minutes=10)) and body["stage"]["stage"] == 8
    assert body["results"]["metaUsedMinor"] == 1234 and body["staff"]["manualCheckAt"] == _iso(T0)
    clock[0] = T0 + timedelta(minutes=9)
    meta.set(meta_id, spend="15.00")
    second = _refresh(campaign_id, people["reviewer"]).json()
    assert second["cached"] is True and len(meta.calls) == 1  # within 10 minutes: the stored reading
    assert second["nextAllowedAt"] == _iso(T0 + timedelta(minutes=10)) and second["results"]["metaUsedMinor"] == 1234
    clock[0] = T0 + timedelta(minutes=10)
    third = _refresh(campaign_id, people["admin"]).json()
    assert third["cached"] is False and third["results"]["metaUsedMinor"] == 1500 and len(meta.calls) == 2
    with db_conn() as conn:
        audits = conn.execute(text("SELECT user_id FROM audit_logs WHERE action = 'results_check' AND resource_id = :id"),
                              {"id": campaign_id}).scalars().all()
    assert sorted(audits) == sorted([people["reviewer"]["id"], people["admin"]["id"]])  # cached presses are not audited
    # A failed read answers 200 with the last good values, and the next press waits its 10 minutes.
    clock[0] = T0 + timedelta(minutes=30)
    meta.fail[f"{meta_id}?combined"] = meta_ads.MetaAdsError("network", "Meta could not be reached.", retryable=True)
    failed = _refresh(campaign_id, people["reviewer"])
    assert failed.status_code == 200 and failed.json()["cached"] is True
    assert failed.json()["checkError"]["code"] == "META_ERROR" and failed.json()["checkError"]["ar"]
    assert failed.json()["results"]["metaUsedMinor"] == 1500
    calls = len(meta.calls)
    assert _refresh(campaign_id, people["reviewer"]).json()["cached"] is True and len(meta.calls) == calls
    with db_conn() as conn:
        audited = conn.execute(text("SELECT metadata_json FROM audit_logs WHERE action = 'results_check' AND resource_id = :id"),
                               {"id": campaign_id}).scalars().all()
    assert len(audited) == 3 and json.loads(audited[-1])["outcome"] in ("synced", "error")  # the failed read too
    # Refusals: customers, other origins, requests not linked, unknown requests.
    refused = _refresh(campaign_id, people["owner"])
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "STAFF_ONLY"
    cross = _refresh(campaign_id, people["reviewer"], headers={"Origin": "https://evil.example"})
    assert cross.status_code == 403 and cross.json()["detail"]["code"] == "CROSS_SITE"
    unlinked = _request(seeded, people["owner"])
    assert _refresh(unlinked, people["reviewer"]).json()["detail"]["code"] == "NOT_LINKED"
    assert _refresh(f"{PREFIX}missing", people["reviewer"]).status_code == 404


def test_check_now_while_meta_is_paused_or_busy(meta, people, seeded, monkeypatch):
    monkeypatch.setattr(studio_results, "utc_now", lambda: T0)
    campaign_id, _meta_id_ = _linked(seeded, people, meta)
    monkeypatch.setattr(meta_ads, "studio_meta_pause_seconds", lambda: 300)
    paused = _refresh(campaign_id, people["reviewer"]).json()
    assert paused["cached"] is True and paused["checkError"]["code"] == "META_PAUSED" and meta.calls == []
    monkeypatch.setattr(meta_ads, "studio_meta_pause_seconds", lambda: 0)
    with db_conn() as conn:
        write_results_row(conn, campaign_id, people["owner"]["id"], {"syncClaimedUntil": _iso(T0 + timedelta(minutes=1))})
    busy = _refresh(campaign_id, people["reviewer"]).json()
    assert busy["cached"] is True and busy["checkError"]["code"] == "SYNC_RUNNING" and meta.calls == []
