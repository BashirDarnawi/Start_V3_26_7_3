"""Albayan Studio stage model (plan task P1-20; PLAN.md §5.4, §7.1).

The pure ``derive_display_stage`` is checked against every case of the shared fixture
server/systems/ads_studio/stage_cases.json (the client fallback reuses it), and
``GET /api/studio/campaigns/summary`` against seeded rows. Every test creates its own users
(unique e-mails per run) and removes the rows it wrote.
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

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app, validate_entity_id
from server.rate_limiter import check_rate_limit, reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import OWNED_TYPES, studio_results
from server.systems.ads_studio.social_studio import SOCIAL_STUDIO_COLLECTIONS
from server.systems.ads_studio.studio_results import (
    MONEY_MEANINGS,
    NEXT_ACTORS,
    RESULTS_TYPE,
    STAGES,
    VARIANTS,
    ResultsRowChanged,
    checked_ago,
    derive_display_stage,
    normalize_results,
    results_id,
    stage_tables,
    write_results_row,
)

TAG = secrets.token_hex(4)
PASSWORD = "StudioResultsPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
FIXTURE = Path(__file__).parent / "systems" / "ads_studio" / "stage_cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))
ARABIC = re.compile(r"[؀-ۿ]")


def _time(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


# ------------------------------------------------------------------ the shared fixture

def test_fixture_file_is_lf_utf8_without_bom():
    raw = FIXTURE.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" not in raw and raw.endswith(b"\n")


def test_fixture_tables_match_server():
    """The client reads its labels from the fixture: it must say exactly what the server says.

    When a label changes in studio_results.py, update the "tables" part of stage_cases.json.
    """
    assert CASES["tables"] == json.loads(json.dumps(stage_tables(), ensure_ascii=False))


def test_fixture_covers_every_stage_and_variant():
    stages = {case["expect"]["stage"] for case in CASES["cases"]}
    assert stages == set(STAGES)
    variants = {case["expect"].get("variant") for case in CASES["cases"]} - {None, ""}
    assert variants == set(VARIANTS)
    names = [case["name"] for case in CASES["cases"]]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("case", CASES["cases"], ids=[case["name"] for case in CASES["cases"]])
def test_stage_mapping_seeded_cases(case):
    got = derive_display_stage(case["request"], case["results"], _time(case["now"]))
    picked = {key: got[key] for key in case["expect"]}
    assert picked == case["expect"], case.get("note", "")
    entry = STAGES[got["stage"]]
    assert got["stageKey"] == entry["key"] and got["labels"] == {"en": entry["en"], "ar": entry["ar"]}
    assert got["money"] == MONEY_MEANINGS[got["moneyKey"]] and got["nextActorLabels"] == NEXT_ACTORS[got["nextActor"]]


def test_unlinked_approved_is_stage_4():
    now = datetime(2026, 10, 15, 10, 0, tzinfo=timezone.utc)
    request = {"status": "Approved", "startDate": "2026-10-10", "endDate": "2026-10-20", "budgetMinorUSD": 3000}
    # Even a results row (left from an old link, or seeded early) never gives an unlinked request a Meta value.
    stray = {"campaignId": "cmp_x", "metaCampaignId": "120200000000001", "lastSyncedAt": "2026-10-15T09:00:00Z",
             "adStatusCounts": {"ACTIVE": 1}, "spendMinorUSD": 999, "spendConfirmedAt": "2026-10-15T09:00:00Z",
             "currency": "USD"}
    for results in (None, stray):
        got = derive_display_stage(request, results, now)
        assert (got["stage"], got["stageKey"], got["linked"], got["checking"]) == (4, "approved_setup", False, False)
        assert got["metaUsedMinor"] is None and got["checkedAt"] is None and got["stale"] is False


def test_derive_is_pure():
    case = next(c for c in CASES["cases"] if c["name"] == "running")
    request, results = json.loads(json.dumps(case["request"])), json.loads(json.dumps(case["results"]))
    first = derive_display_stage(request, results, _time(case["now"]))
    assert request == case["request"] and results == case["results"]  # inputs untouched
    assert derive_display_stage(request, results, _time(case["now"])) == first
    naive = derive_display_stage(request, results, _time(case["now"]).replace(tzinfo=None))
    assert naive == first  # a time without a zone is UTC


def test_labels_are_bilingual_and_never_say_billing():
    tables = [*STAGES.values(), *MONEY_MEANINGS.values(), *NEXT_ACTORS.values(), *VARIANTS.values(),
              *studio_results.FLAG_LABELS.values()]
    for entry in tables:
        assert entry["en"].strip() and ARABIC.search(entry["ar"]), entry
        assert "billing" not in entry["en"].lower() and "فوترة" not in entry["ar"]
    assert {entry["key"] for entry in STAGES.values()} == {c["expect"]["stageKey"] for c in CASES["cases"]}


def test_checked_ago_bilingual():
    now = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
    ago = lambda **delta: checked_ago((now - timedelta(**delta)).isoformat(), now)  # noqa: E731
    assert checked_ago(None, now) is None and checked_ago("not a time", now) is None
    assert ago(seconds=20) == {"seconds": 20, "en": "checked just now", "ar": "فُحص الآن"}
    assert checked_ago((now + timedelta(minutes=3)).isoformat(), now)["en"] == "checked just now"
    assert ago(minutes=1)["en"] == "checked 1 minute ago" and ago(minutes=1)["ar"] == "فُحص قبل دقيقة"
    assert ago(minutes=2)["ar"] == "فُحص قبل دقيقتين"
    assert ago(minutes=5)["ar"] == "فُحص قبل 5 دقائق" and ago(minutes=5)["en"] == "checked 5 minutes ago"
    assert ago(minutes=25)["ar"] == "فُحص قبل 25 دقيقة"
    assert ago(hours=3)["en"] == "checked 3 hours ago" and ago(hours=3)["ar"] == "فُحص قبل 3 ساعات"
    assert ago(hours=13)["ar"] == "فُحص قبل 13 ساعة"
    assert ago(days=2)["en"] == "checked 2 days ago" and ago(days=2)["ar"] == "فُحص قبل يومين"
    assert ago(days=12)["ar"] == "فُحص قبل 12 يوماً"


# ------------------------------------------------------------------ adCampaignResults rows

def test_results_type_is_owned_and_router_only():
    assert RESULTS_TYPE == "adCampaignResults"
    assert RESULTS_TYPE in OWNED_TYPES and RESULTS_TYPE in SOCIAL_STUDIO_COLLECTIONS


def test_results_id_fits_entity_id_rule():
    long_id = "c" * 80
    for campaign_id in ("cmp_1", long_id):
        row_id = results_id(campaign_id)
        assert row_id.startswith("acr_") and len(row_id) == 44 and validate_entity_id(row_id) == row_id
    assert results_id("cmp_1") == results_id("cmp_1") != results_id("cmp_2")


def test_normalize_results_reads_bad_values_as_safe_defaults():
    clean = normalize_results(None)
    assert clean["adStatusCounts"] == {} and clean["spendMinorUSD"] == 0 and clean["syncState"] == "never"
    assert clean["insightsState"] == "never" and clean["lastSyncedAt"] is None and clean["currency"] == ""
    dirty = normalize_results({
        "metaCampaignId": "12 34", "metaAdAccountId": "act_123", "campaignEffectiveStatus": "running",
        "adStatusCounts": {"active": 2, "BOGUS": 3, "PAUSED": -1, "DISAPPROVED": 1.5, "PENDING_REVIEW": True},
        "anyAdDelivering": "yes", "neverDelivered": 1, "spendMinorUSD": -5, "reach": "12", "clicks": 1e30,
        "lastSyncedAt": "yesterday", "adsetEndTime": "2026-10-15T10:00:00+02:00", "syncState": "maybe",
        "reviewFeedbackStaff": "x" * 5000, "currency": "usd", "lastErrorCode": "a\x00b",
    })
    assert dirty["metaCampaignId"] == "" and dirty["metaAdAccountId"] == "act_123"
    assert dirty["campaignEffectiveStatus"] == "" and dirty["adStatusCounts"] == {"ACTIVE": 2}
    assert dirty["anyAdDelivering"] is False and dirty["neverDelivered"] is False
    assert dirty["spendMinorUSD"] == 0 and dirty["reach"] == 12 and dirty["clicks"] is None
    assert dirty["lastSyncedAt"] is None and dirty["adsetEndTime"] == "2026-10-15T08:00:00Z"
    assert dirty["syncState"] == "never" and len(dirty["reviewFeedbackStaff"]) == 2000
    assert dirty["currency"] == "USD" and dirty["lastErrorCode"] == "ab"


# ------------------------------------------------------------------ rows in the database

def _insert_user(label: str) -> dict:
    stamp = now_ms()
    user_id = new_id("results_user")
    email = f"studio-results-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,'Employee',:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"Results {label}", "email": email,
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
def people():
    init_db()
    return {"owner": _insert_user("owner"), "other": _insert_user("other"), "staff": _insert_user("staff")}


@pytest.fixture
def seeded():
    """Collects the (type, id) rows a test wrote and deletes them afterwards."""
    written: list[tuple[str, str]] = []
    yield written
    with db_conn() as conn:
        for row_type, row_id in written:
            conn.execute(text("DELETE FROM entities WHERE type = :t AND id = :id"), {"t": row_type, "id": row_id})


def _campaign(seeded: list, owner_id: str, campaign_id: str, *, archived: bool = False, **data) -> str:
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": archived,
            "name": f"Ad {campaign_id}", "creativeImages": ["data:image/png;base64,AAAA"], **data}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:stamp,:owner,:stamp)"
            ),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "deleted": archived, "stamp": stamp,
             "owner": owner_id},
        )
    seeded.append((CAMPAIGNS, campaign_id))
    return campaign_id


def _results(seeded: list, campaign_id: str, owner_id: str, **fields) -> dict:
    with db_conn() as conn:
        data = write_results_row(conn, campaign_id, owner_id, fields)
    seeded.append((RESULTS_TYPE, results_id(campaign_id)))
    return data


def test_write_results_row_inserts_merges_and_guards(people, seeded):
    owner = people["owner"]["id"]
    campaign_id = f"cmp_write_{TAG}"
    first = _results(seeded, campaign_id, owner, metaCampaignId="120200000000001", spendMinorUSD=100,
                     bogusField="dropped")
    assert first["campaignId"] == campaign_id and first["ownerId"] == owner and "bogusField" not in first
    with db_conn() as conn:
        row = conn.execute(text("SELECT created_by, last_modified, data_json FROM entities WHERE type = :t AND id = :id"),
                           {"t": RESULTS_TYPE, "id": results_id(campaign_id)}).mappings().first()
        assert row["created_by"] == owner  # the owner, so the owner-scoped read finds it
        baseline = int(row["last_modified"])
        merged = write_results_row(conn, campaign_id, owner, {"spendMinorUSD": 250})
        assert merged["metaCampaignId"] == "120200000000001" and merged["spendMinorUSD"] == 250  # merged, not replaced
        with pytest.raises(ResultsRowChanged):
            write_results_row(conn, campaign_id, owner, {"spendMinorUSD": 1}, expected_last_modified=baseline)
        with pytest.raises(ResultsRowChanged):
            write_results_row(conn, f"cmp_none_{TAG}", owner, {}, expected_last_modified=1)
    # A made-up owner is never written into the users foreign key column.
    ghost_campaign = f"cmp_ghost_{TAG}"
    _results(seeded, ghost_campaign, "system", metaCampaignId="1")
    with db_conn() as conn:
        created_by = conn.execute(text("SELECT created_by FROM entities WHERE type = :t AND id = :id"),
                                  {"t": RESULTS_TYPE, "id": results_id(ghost_campaign)}).scalar()
    assert created_by is None


def test_generic_api_refuses_results_rows(people, seeded):
    owner = people["owner"]
    _results(seeded, f"cmp_generic_{TAG}", owner["id"], metaCampaignId="1")
    assert client.get(f"/api/collections/{RESULTS_TYPE}", cookies=owner["cookies"]).status_code == 404
    created = client.post(f"/api/collections/{RESULTS_TYPE}", json={"id": "acr_x", "data": {"spendMinorUSD": 1}},
                          cookies=owner["cookies"])
    assert created.status_code == 404, created.text


# ------------------------------------------------------------------ GET /api/studio/campaigns/summary

def test_campaigns_summary_requires_login():
    client.cookies.clear()
    assert client.get("/api/studio/campaigns/summary").status_code == 401


def test_stage_mapping_seeded_summary(people, seeded, monkeypatch):
    now = datetime(2026, 10, 15, 10, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(studio_results, "utc_now", lambda: now)
    owner, other, staff = people["owner"], people["other"], people["staff"]
    meta = "120200000000001"
    ids = {name: f"sum_{name}_{TAG}" for name in (
        "draft", "submitted", "changes", "unlinked", "checking", "running", "ended", "stopped", "archived", "foreign")}
    _campaign(seeded, owner["id"], ids["draft"], status="Draft")
    _campaign(seeded, owner["id"], ids["submitted"], status="Submitted", submittedAt="2026-10-14T08:00:00Z",
              budgetMinorUSD=2000)
    _campaign(seeded, owner["id"], ids["changes"], status="Changes Requested", changeReasons=["photo"],
              reviewedBy=staff["id"], reviewHistory=[{"decision": "Changes Requested", "reviewedBy": staff["id"]}])
    _campaign(seeded, owner["id"], ids["unlinked"], status="Approved", startDate="2026-10-10", endDate="2026-10-20",
              approvedBy=staff["id"], paidMinorUSD=3000)
    _campaign(seeded, owner["id"], ids["checking"], status="Approved", startDate="2026-10-10", endDate="2026-10-20",
              metaCampaignId="120200000000002", publishStatus="live", publishedBy=staff["id"])
    _campaign(seeded, owner["id"], ids["running"], status="Approved", startDate="2026-10-10", endDate="2026-10-20",
              metaCampaignId=meta, stopRequestedAt="2026-10-15T09:00:00Z")
    _campaign(seeded, owner["id"], ids["ended"], status="Approved", startDate="2026-10-01", endDate="2026-10-14",
              metaCampaignId="120200000000003")
    _campaign(seeded, owner["id"], ids["stopped"], status="Stopped", closeReason="staff_stop", stoppedBy=staff["id"])
    _campaign(seeded, owner["id"], ids["archived"], archived=True, status="Stopped", closeReason="completed")
    _campaign(seeded, other["id"], ids["foreign"], status="Approved", metaCampaignId=meta)
    _results(seeded, ids["running"], owner["id"], metaCampaignId=meta, syncState="ok",
             lastSyncedAt="2026-10-15T09:55:00Z", adStatusCounts={"ACTIVE": 1}, spendMinorUSD=300,
             spendConfirmedAt="2026-10-15T09:55:00Z", insightsState="ok", currency="USD",
             reviewFeedbackStaff=f"STAFF-ONLY-{TAG}", lastErrorCode=f"ERR-{TAG}")
    _results(seeded, ids["ended"], owner["id"], metaCampaignId="120200000000003", syncState="ok",
             lastSyncedAt="2026-10-15T02:00:00Z", adStatusCounts={"PAUSED": 1}, spendMinorUSD=2700,
             spendConfirmedAt="2026-10-15T02:00:00Z", currency="USD", settleReadDueAt="2026-10-17T02:00:00Z")
    # The other customer's results row for the same Meta campaign never reaches this owner.
    _results(seeded, ids["foreign"], other["id"], metaCampaignId=meta, lastSyncedAt="2026-10-15T09:55:00Z",
             adStatusCounts={"ACTIVE": 1})

    response = client.get("/api/studio/campaigns/summary", cookies=owner["cookies"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {ids[n] for n in ("draft", "submitted", "changes", "unlinked", "checking", "running", "ended",
                                          "stopped")}  # own live requests only: no archived, no foreign
    stages = {name: body[ids[name]]["stage"] for name in ids if ids[name] in body}
    assert stages == {"draft": 1, "submitted": 2, "changes": 3, "unlinked": 4, "checking": 4, "running": 8,
                      "ended": 10, "stopped": 12}
    unlinked = body[ids["unlinked"]]
    assert unlinked["metaUsedMinor"] is None and unlinked["checkedAt"] is None and unlinked["checkedAgo"] is None
    assert body[ids["checking"]]["checking"] is True and body[ids["checking"]]["variantLabels"]["en"] == "Checking Meta…"
    running = body[ids["running"]]
    assert running["metaUsedMinor"] == 300 and running["checkedAt"] == "2026-10-15T09:55:00Z"
    assert running["checkedAgo"] == {"seconds": 300, "en": "checked 5 minutes ago", "ar": "فُحص قبل 5 دقائق"}
    assert running["stopRequested"] is True and running["stopRequestedAt"] == "2026-10-15T09:00:00Z"
    assert running["labels"] == {"en": "Running", "ar": "يعمل الآن"} and running["nextActor"] == "none"
    assert running["dueAt"] is None and running["settleExpectedAt"] is None
    ended = body[ids["ended"]]
    assert ended["stale"] is True and ended["metaUsedMinor"] == 2700
    assert ended["settleExpectedAt"] == "2026-10-17T02:00:00Z" and ended["moneyKey"] == "paid_settling"
    assert body[ids["changes"]]["reasons"] == ["photo"]
    # No staff id, and none of the staff-only Meta details, anywhere in the answer.
    assert staff["id"] not in response.text and f"STAFF-ONLY-{TAG}" not in response.text
    assert f"ERR-{TAG}" not in response.text and "creativeImages" not in response.text

    other_view = client.get("/api/studio/campaigns/summary", cookies=other["cookies"]).json()
    assert set(other_view) == {ids["foreign"]} and other_view[ids["foreign"]]["stage"] == 8


def test_campaigns_summary_rate_limited(people):
    owner = people["owner"]
    key = f"studio:campaigns-summary:{owner['id']}"
    reset_rate_limit(key)
    try:
        for _ in range(studio_results.SUMMARY_READS_PER_MINUTE):
            check_rate_limit(key, studio_results.SUMMARY_READS_PER_MINUTE, 60_000)
        response = client.get("/api/studio/campaigns/summary", cookies=owner["cookies"])
        assert response.status_code == 429 and response.json()["detail"]["code"] == "RATE_LIMITED"
        assert int(response.headers["Retry-After"]) >= 1
    finally:
        reset_rate_limit(key)
    assert client.get("/api/studio/campaigns/summary", cookies=owner["cookies"]).status_code == 200


def test_summary_reads_only_projected_request_fields(people, seeded):
    """Request rows carry base64 images: the summary reads named fields of them, never data_json whole."""
    from sqlalchemy import event

    from server.db import get_engine

    _campaign(seeded, people["owner"]["id"], f"sum_projection_{TAG}", status="Draft")
    statements: list[str] = []

    def spy(_conn, _cursor, statement, *_args):
        statements.append(statement)

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", spy)
    try:
        with db_conn() as conn:
            assert studio_results.campaigns_summary(conn, people["owner"]["id"], datetime.now(timezone.utc))
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    request_reads = [s for s in statements if "budgetMinorUSD" in s]  # SQLite json_extract / PostgreSQL ->>
    assert request_reads
    for statement in request_reads:
        columns = statement.split(" FROM ", 1)[0]  # what comes back to Python
        assert "data_json" not in re.sub(r"json_extract\(data_json, '\$\.\w+'\)", "", columns), statement
