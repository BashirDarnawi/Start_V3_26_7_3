"""Review loop round 2, batch M1: Meta worker load and scheduling (server/meta_ads.py).

* n=1     a closed-month ad below the current media version is asked of Meta ONCE and then parked:
          the 30-day park also stamps metaMediaRepairVersion, and the repair lane skips rows already
          stamped for this version. Before, the repair lane (which ignores metaNextSyncAt) picked the
          same frozen ad and fully re-snapshotted it on every worker pass, forever.
* n=2/14  the unique-link check that every sync, link and Sync-now runs under the ad's row lock
          compares metaAdId in SQL and reads only an id. It used to load and JSON-parse every other
          live ad (inline photos included). A partial expression index serves the lookup.
* n=15    on PostgreSQL the worker scans (_due_meta_ads every 20 s, the media archive every minute)
          cast each row's JSON to jsonb once per query instead of once per field read.

Disposable rows only, tagged per run and deleted afterwards; Meta is faked.
"""

import os
import secrets
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from sqlalchemy import event, text

import server.db as db_module
import server.meta_ads as meta_ads
from server import add_jsonb_indexes
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms

TAG = secrets.token_hex(4)
_DIGITS = f"{int(TAG, 16) % 10**10:010d}"
ACCOUNT = "95" + _DIGITS + "001"
PAGE_META_ID = "96" + _DIGITS + "001"
CLOSED_META_ID = "97" + _DIGITS + "001"
LINKED_META_ID = "97" + _DIGITS + "002"
DELETED_META_ID = "97" + _DIGITS + "003"
FREE_META_ID = "97" + _DIGITS + "004"
CLOSED_PERIOD = "2017-08"
CLOSURE_ID = f"financial-close-{CLOSED_PERIOD}"


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()
    yield


def _insert_entity(entity_type, entity_id, data, *, deleted=False, last_modified=None):
    stamp = now_ms()
    payload = {"id": entity_id, "_created": stamp, "_lastModified": stamp, "_deleted": deleted, **data}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,:stamp,NULL,:modified)"
            ),
            {"type": entity_type, "id": entity_id, "data": json_dumps(payload), "deleted": deleted, "stamp": stamp,
             "modified": stamp if last_modified is None else last_modified},
        )


def _read_entity(entity_type, entity_id):
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json,last_modified FROM entities WHERE type=:t AND id=:i"),
            {"t": entity_type, "i": entity_id},
        ).mappings().first()
    return json_loads(row["data_json"]), int(row["last_modified"])


def _delete_entities(*ids):
    with db_conn() as conn:
        for entity_id in ids:
            conn.execute(text("DELETE FROM entities WHERE id=:i"), {"i": entity_id})


def _snapshot(meta_ad_id):
    return {
        "metaLinkState": "linked", "metaLinkVersion": 1, "metaAdId": meta_ad_id,
        "metaAdName": f"Ad {meta_ad_id}", "metaAdSetId": "555555555555555", "metaAdSetName": "Set",
        "metaCampaignId": "666666666666666", "metaCampaignName": "Camp", "metaCreativeId": "",
        "metaThumbnailUrl": "", "metaThumbnailSource": "", "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
        "metaMediaResolvedAt": "2026-09-18T10:00:00Z", "metaMediaTrace": "",
        "metaPageId": PAGE_META_ID, "metaPageName": "M1 Client Page", "metaPageCategory": "Shop",
        "metaPagePictureUrl": "", "metaAdAccountId": ACCOUNT, "metaAdAccountName": "Albayan Business",
        "metaCurrency": "USD", "metaConfiguredStatus": "PAUSED", "metaEffectiveStatus": "PAUSED",
        "metaAdSetStatus": "PAUSED", "metaCampaignStatus": "PAUSED", "metaObjective": "MESSAGES",
        "metaBudgetSource": "adset", "metaDailyBudgetMinor": 500, "metaLifetimeBudgetMinor": 0,
        "metaTotalBudgetMinor": 5000, "metaTotalBudgetKind": "estimated_daily", "metaBudgetRemainingMinor": 0,
        "metaTotalRemainingBudgetMinor": 5000, "metaStartTime": "2017-08-10T00:00:00Z",
        "metaEndTime": "2017-08-20T00:00:00Z", "metaDurationDays": 10, "metaAdCreatedTime": "2017-08-10T00:00:00Z",
        "metaAdUpdatedTime": "2017-08-10T00:00:00Z", "metaSpend": 0.0, "metaSpendMinor": 0, "metaReach": 0,
        "metaImpressions": 0, "metaClicks": 0, "metaPrimaryResultType": "", "metaPrimaryResultValue": 0.0,
        "metaActions": [], "metaSyncedAt": "2026-09-18T10:00:00Z", "metaLastAttemptAt": "2026-09-18T10:00:00Z",
        "metaSyncError": "", "metaSyncErrorCode": "", "metaSyncFailureCount": 0,
        "metaNextSyncAt": now_ms() + 900_000, "metaUnlinkedAt": "",
    }


class _FakeMetaClient:
    def __init__(self):
        self.calls = []

    def get_ad_snapshot(self, meta_ad_id):
        self.calls.append(str(meta_ad_id))
        return _snapshot(str(meta_ad_id))


def _meta_config(batch):
    return meta_ads.MetaAdsConfig(
        access_token="t", app_secret="", graph_version="v25.0",
        allowed_account_ids=(ACCOUNT,), background_sync=False,
        sync_interval_minutes=15, sync_batch_size=batch, request_timeout_seconds=15,
    )


def _delete_tagged_pages():
    with db_conn() as conn:
        rows = conn.execute(text("SELECT id,data_json FROM entities WHERE type='pages'")).mappings().all()
        for row in rows:
            data = json_loads(row["data_json"] or "{}") or {}
            if isinstance(data, dict) and str(data.get("metaPageId") or "") == PAGE_META_ID:
                conn.execute(text("DELETE FROM entities WHERE type='pages' AND id=:i"), {"i": row["id"]})


# ---------------------------------------------------------------- n=1


@pytest.fixture
def closed_month_ad_below_media_version(monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "test-token")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_refresh_meta_provider_state", lambda *a, **k: None)
    monkeypatch.setattr(meta_ads, "load_meta_ads_config", lambda: _meta_config(1))
    ad_id = f"ad_m1_closed_{TAG}"
    with db_conn() as conn:
        existing = conn.execute(
            text("SELECT 1 FROM entities WHERE type='financialClosures' AND id=:i"), {"i": CLOSURE_ID}
        ).first()
    own_closure = existing is None
    if own_closure:
        _insert_entity("financialClosures", CLOSURE_ID, {"period": CLOSED_PERIOD, "status": "closed"})
    # An ad of a closed month that never reached the current media resolver version, with no
    # failure count and no repair stamp: exactly what every closed-month ad becomes on the next
    # _META_MEDIA_VERSION bump.
    _insert_entity("ads", ad_id, {
        "recordType": "ad", "status": "Stopped", "startDate": f"{CLOSED_PERIOD}-15", "amountUSD": 50,
        "spentUSD": 50, "metaAdId": CLOSED_META_ID, "metaAdAccountId": ACCOUNT, "metaNextSyncAt": 0,
        "metaMediaVersion": 0, "metaSyncedAt": "2017-08-16T00:00:00Z",
    })
    try:
        yield ad_id
    finally:
        _delete_entities(ad_id)
        if own_closure:
            _delete_entities(CLOSURE_ID)
        _delete_tagged_pages()


def test_closed_month_ad_needing_media_repair_is_fetched_once_then_parked(
    closed_month_ad_below_media_version, monkeypatch
):
    ad_id = closed_month_ad_below_media_version
    fake = _FakeMetaClient()
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    _before, version_before = _read_entity("ads", ad_id)

    for _ in range(3):
        meta_ads._sync_due_meta_ads_unlocked()

    after, version_after = _read_entity("ads", ad_id)
    # Before the fix: 3 (the repair lane re-picked the frozen ad on every pass).
    assert fake.calls.count(CLOSED_META_ID) == 1, fake.calls
    assert version_after == version_before                       # parked without a version bump
    assert int(after["metaNextSyncAt"]) > now_ms() + 29 * 86_400_000
    assert after["metaMediaRepairVersion"] == meta_ads._META_MEDIA_VERSION
    assert int(after.get("metaMediaVersion") or 0) == 0          # its frozen figures were not touched
    assert ad_id not in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}


def test_open_ad_that_failed_under_an_older_resolver_still_gets_its_one_repair(monkeypatch):
    """The repair lane keeps its purpose: a row with an OLD repair stamp (or none) is first in line
    even while its failure backoff runs; a row stamped for this version waits for metaNextSyncAt."""
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    ad_id = f"ad_m1_repair_{TAG}"
    _insert_entity("ads", ad_id, {
        "recordType": "ad", "status": "Active", "metaAdId": LINKED_META_ID, "metaAdAccountId": ACCOUNT,
        "metaNextSyncAt": now_ms() + 3_600_000, "metaMediaVersion": 0, "metaSyncFailureCount": 3,
        "metaMediaRepairVersion": meta_ads._META_MEDIA_VERSION - 1,
    })
    try:
        due = {row["adId"]: row for row in meta_ads._due_meta_ads(limit=1000)}
        assert ad_id in due and due[ad_id]["needsMediaRepair"] is True
        with db_conn() as conn:
            row = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:i"), {"i": ad_id}).first()
            data = json_loads(row[0])
            data["metaMediaRepairVersion"] = meta_ads._META_MEDIA_VERSION
            data["metaSyncFailureCount"] = 0
            conn.execute(text("UPDATE entities SET data_json=:d WHERE type='ads' AND id=:i"),
                         {"d": json_dumps(data), "i": ad_id})
        assert ad_id not in {row["adId"] for row in meta_ads._due_meta_ads(limit=1000)}
    finally:
        _delete_entities(ad_id)


# ---------------------------------------------------------------- n=2 / n=14


def test_unique_link_check_filters_in_sql_and_never_parses_other_ads(monkeypatch):
    linked = f"ad_m1_linked_{TAG}"
    unlinked = f"ad_m1_free_{TAG}"
    removed = f"ad_m1_removed_{TAG}"
    bulky = [f"ad_m1_bulk_{TAG}_{i}" for i in range(12)]
    photo = "data:image/jpeg;base64," + ("A" * 60_000)
    _insert_entity("ads", linked, {"recordType": "ad", "metaAdId": LINKED_META_ID, "adPhotos": [photo]})
    _insert_entity("ads", unlinked, {"recordType": "ad", "adPhotos": [photo]})
    _insert_entity("ads", removed, {"recordType": "ad", "metaAdId": DELETED_META_ID}, deleted=True)
    for entity_id in bulky:
        _insert_entity("ads", entity_id, {"recordType": "ad", "adPhotos": [photo], "metaThumbnailData": photo})

    def _forbid_blob_decode(*_args, **_kwargs):
        raise AssertionError("the unique-link check parsed another ad's data_json")

    statements = []

    def _record(_conn, _cursor, statement, _params, _context, _many):
        statements.append(" ".join(str(statement).split()))

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", _record)
    monkeypatch.setattr(meta_ads, "json_loads", _forbid_blob_decode)
    try:
        with db_conn() as conn:
            with pytest.raises(HTTPException) as refused:
                meta_ads._ensure_unique_link(conn, unlinked, LINKED_META_ID)
            assert refused.value.status_code == 409
            assert refused.value.detail == "This Meta ad is already linked to another Albayan ad"
            meta_ads._ensure_unique_link(conn, linked, LINKED_META_ID)      # its own link is no clash
            meta_ads._ensure_unique_link(conn, unlinked, DELETED_META_ID)   # a deleted ad does not block
            meta_ads._ensure_unique_link(conn, unlinked, FREE_META_ID)      # nobody holds it
    finally:
        event.remove(engine, "before_cursor_execute", _record)
        _delete_entities(linked, unlinked, removed, *bulky)
    link_checks = [statement for statement in statements if "metaAdId" in statement]
    assert len(link_checks) == 4, statements
    for statement in link_checks:
        assert statement.startswith("SELECT id FROM entities WHERE type='ads' AND deleted=false"), statement
        assert "data_json FROM" not in statement and statement.endswith("LIMIT 1"), statement


class _PgDialect:
    name = "postgresql"


class _PgEngine:
    dialect = _PgDialect()


class _EmptyResult:
    def mappings(self):
        return self

    def all(self):
        return []

    def first(self):
        return None


@pytest.fixture
def postgres_sql(monkeypatch):
    """Build each statement as PostgreSQL would receive it, without a PostgreSQL server."""
    captured = []

    @contextmanager
    def _fake_conn():
        yield SimpleNamespace(execute=lambda statement, params=None: captured.append(str(statement)) or _EmptyResult())

    monkeypatch.setattr(db_module, "get_engine", lambda: _PgEngine())
    monkeypatch.setattr(meta_ads, "get_engine", lambda: _PgEngine())
    monkeypatch.setattr(meta_ads, "db_conn", _fake_conn)
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta_ads, "_META_MEDIA_FAILURES", {})
    return captured


def test_unique_link_check_matches_the_startup_index_on_postgresql(postgres_sql, monkeypatch):
    with meta_ads.db_conn() as conn:
        meta_ads._ensure_unique_link(conn, "ad_local", FREE_META_ID)
    (statement,) = postgres_sql
    statement = " ".join(statement.split())
    # Literal type/deleted and the bare expression: what the partial index can serve.
    assert statement == (
        "SELECT id FROM entities WHERE type='ads' AND deleted=false AND id<>:id "
        "AND (data_json::jsonb ->> 'metaAdId')=:meta LIMIT 1"
    )

    connections = []

    @contextmanager
    def _recording_db_conn():
        statements = []
        connections.append(statements)
        yield SimpleNamespace(execute=lambda stmt, params=None: statements.append(str(stmt)))

    monkeypatch.setattr(add_jsonb_indexes, "get_engine", lambda: _PgEngine())
    monkeypatch.setattr(add_jsonb_indexes, "db_conn", _recording_db_conn)
    add_jsonb_indexes.add_jsonb_indexes()
    found = [s for s in connections if any("idx_ads_meta_ad_id" in one for one in s)]
    assert len(found) == 1 and len(found[0]) == 3, connections  # its own connection: 2 SET LOCAL + the DDL
    assert " ".join(found[0][-1].split()) == (
        "CREATE INDEX IF NOT EXISTS idx_ads_meta_ad_id "
        "ON entities (((data_json::jsonb->>'metaAdId'))) "
        "WHERE type = 'ads' AND deleted = false"
    )


# ---------------------------------------------------------------- n=15


def test_worker_scans_parse_each_row_once_on_postgresql(postgres_sql):
    meta_ads._due_meta_ads(5)
    assert len(postgres_sql) == 2, postgres_sql                 # the repair lane and the due lane
    for statement in postgres_sql:
        assert statement.count("::jsonb") == 1, statement     # before the fix: one per field read
        assert "OFFSET 0" in statement and "data_json::jsonb AS doc" in statement
    postgres_sql.clear()

    meta_ads._archive_meta_media_batch(5)
    assert len(postgres_sql) == 2, postgres_sql                 # ads, then pages
    assert "metaThumbnailUrl" in postgres_sql[0] and "metaPagePictureUrl" in postgres_sql[1]
    for statement in postgres_sql:
        assert statement.count("::jsonb") == 1, statement


def test_worker_scans_still_select_the_right_rows_on_sqlite(monkeypatch):
    """parsed_once keeps SQLite on json_extract: the same due/repair and archive choices."""
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta_ads, "_META_MEDIA_FAILURES", {})
    due_id = f"ad_m1_due_{TAG}"
    later_id = f"ad_m1_later_{TAG}"
    thumb_id = f"ad_m1_thumb_{TAG}"
    stamp = now_ms()
    _insert_entity("ads", due_id, {
        "recordType": "ad", "metaAdId": "98" + _DIGITS + "001", "metaNextSyncAt": 1,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION, "metaAdAccountId": ACCOUNT,
    })
    _insert_entity("ads", later_id, {
        "recordType": "ad", "metaAdId": "98" + _DIGITS + "002", "metaNextSyncAt": stamp + 3_600_000,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
    })
    _insert_entity("ads", thumb_id, {
        "recordType": "ad", "metaAdId": "98" + _DIGITS + "003", "metaNextSyncAt": stamp + 3_600_000,
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
        "metaThumbnailUrl": f"https://scontent.xx.fbcdn.net/m1-{TAG}.jpg",
    }, last_modified=1)  # oldest first in the archive queue, whatever other modules left behind
    try:
        due = {row["adId"]: row for row in meta_ads._due_meta_ads(limit=10_000)}
        assert due_id in due and due[due_id]["metaAdAccountId"] == ACCOUNT
        assert due[due_id]["needsMediaRepair"] is False
        assert later_id not in due and thumb_id not in due

        seen = []
        monkeypatch.setattr(meta_ads, "_archive_meta_image", lambda url: seen.append(url) or "")
        meta_ads._archive_meta_media_batch(20)
        assert f"https://scontent.xx.fbcdn.net/m1-{TAG}.jpg" in seen
    finally:
        _delete_entities(due_id, later_id, thumb_id)
