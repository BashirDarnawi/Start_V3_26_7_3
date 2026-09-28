"""Review loop round 2, batch M2: Meta discovery, the snapshot merge and the Manager link.

Behaviour tests for the verified findings of this batch (each fails before its fix):

* #4 an ad account added to the allowlist after the baseline gets its OWN baseline pass: its
  history is not drafted, only ads created after the cutoff are. A state saved before the
  per-account baseline existed keeps every account allowed now as baselined. A new ad whose
  month is closed (HTTP 423 on insert) is remembered, not retried every pass as a failure.
* #5 a HEALTHY read of an ad set switched to "run continuously" (no end date, no planned total)
  is stored as it is; only a degraded pass (no ad set/campaign name) keeps the old budget block.
* #6 on PostgreSQL a Manager LINK takes the import lock before the ad row lock, so it cannot race
  an automatic import of the same Meta ad into two linked rows.

(#3 and #7 are client fixes, tested in scripts/test-review-regressions.js.)

Every test uses its own Meta ids and ad ids (unique per run) and removes what it wrote; the shared
discovery state row is saved first and put back afterwards.
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
from sqlalchemy import text

import server.meta_ads as meta_ads
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms

TAG = secrets.token_hex(4)
_SEED = int(TAG, 16) % 10**6
ACCOUNT_A = f"77{_SEED:06d}0001"
ACCOUNT_B = f"77{_SEED:06d}0002"
_counter = [0]


def _meta_id() -> str:
    _counter[0] += 1
    return f"1307{_SEED:06d}{_counter[0]:05d}"


def _row(meta_id: str, created: str, **extra) -> dict:
    return {
        "id": meta_id,
        "name": f"Review M2 {meta_id}",
        "effectiveStatus": "ACTIVE",
        "campaignName": "Review M2 campaign",
        "createdTime": created,
        **extra,
    }


class _FakeClient:
    def __init__(self):
        self.rows: dict[str, list[dict]] = {ACCOUNT_A: [], ACCOUNT_B: []}
        self.list_calls: list[tuple[str, int]] = []

    def list_ads(self, account_id, search="", *, max_pages=5):
        self.list_calls.append((str(account_id), int(max_pages)))
        return [dict(row) for row in self.rows.get(str(account_id), [])]

    def _get_account(self, account_id):
        return {"id": str(account_id), "name": "Review M2 account", "currency": "USD"}


@pytest.fixture(scope="module", autouse=True)
def _db():
    init_db()
    yield


@pytest.fixture()
def discovery(monkeypatch):
    """A configured Meta connection over a fake client; the shared discovery state is put back after."""
    fake = _FakeClient()
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", f"review-m2-token-{TAG}")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", ACCOUNT_A)
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    for name in ("ALBAYAN_META_DISCOVERY_FAST_PAGES", "ALBAYAN_META_DISCOVERY_BASELINE_PAGES"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    monkeypatch.setattr(meta_ads, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta_ads, "_refresh_meta_provider_state", lambda *a, **k: None)
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    saved_state = meta_ads._load_import_state()
    _drop_import_state()
    try:
        yield fake
    finally:
        _drop_ads_for([str(row["id"]) for rows in fake.rows.values() for row in rows])
        _drop_import_state()
        if saved_state:
            meta_ads._save_import_state(saved_state)


def _drop_import_state():
    with db_conn() as conn:
        conn.execute(
            text("DELETE FROM entities WHERE type=:type AND id=:id"),
            {"type": meta_ads._META_IMPORT_STATE_TYPE, "id": meta_ads._META_IMPORT_STATE_ID},
        )


def _ads_for(meta_ids) -> list[dict]:
    wanted = {str(value) for value in meta_ids}
    with db_conn() as conn:
        rows = conn.execute(text("SELECT id,data_json FROM entities WHERE type='ads'")).mappings().all()
    out = []
    for row in rows:
        data = json_loads(row["data_json"] or "{}") or {}
        if isinstance(data, dict) and str(data.get("metaAdId") or "") in wanted:
            out.append({"id": row["id"], **data})
    return out


def _drop_ads_for(meta_ids):
    rows = _ads_for(meta_ids)
    with db_conn() as conn:
        for row in rows:
            conn.execute(text("DELETE FROM entities WHERE type='ads' AND id=:id"), {"id": row["id"]})
            conn.execute(text("DELETE FROM audit_logs WHERE resource_id=:id"), {"id": row["id"]})


# ------------------------------------------------------------------ #4: an ad account added after the baseline

def test_an_account_added_after_the_baseline_gets_its_own_baseline(discovery, monkeypatch):
    old_a = _meta_id()
    discovery.rows[ACCOUNT_A] = [_row(old_a, "2026-01-05T10:00:00Z")]
    first = meta_ads.discover_meta_ads(force=True)
    assert first["imported"] == [] and first["state"]["baselineComplete"] is True
    assert discovery.list_calls == [(ACCOUNT_A, 25)]

    # The owner adds account B, which already has history (ACTIVE and PAUSED ads from months ago).
    history_b = [_meta_id() for _ in range(3)]
    discovery.rows[ACCOUNT_B] = [_row(meta_id, "2026-02-10T10:00:00Z") for meta_id in history_b]
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT_A},{ACCOUNT_B}")
    cutoff = "2026-09-29T08:00:00Z"
    second = meta_ads.discover_meta_ads(force=True, startup_cutoff=cutoff)
    assert second["imported"] == [], "account B's history was drafted as new ads"
    assert _ads_for(history_b) == []
    assert discovery.list_calls[-2:] == [(ACCOUNT_A, 1), (ACCOUNT_B, 25)]  # B gets the baseline scan
    assert meta_ads._load_import_state()["baselineAccounts"] == sorted([ACCOUNT_A, ACCOUNT_B])

    # From now on B is a normal account: a genuinely new ad is imported, its history never.
    new_b = _meta_id()
    discovery.rows[ACCOUNT_B].insert(0, _row(new_b, "2026-09-29T09:00:00Z"))
    third = meta_ads.discover_meta_ads(force=True, startup_cutoff=cutoff)
    assert [row["data"]["metaAdId"] for row in third["imported"]] == [new_b]
    assert _ads_for(history_b) == []
    assert discovery.list_calls[-2:] == [(ACCOUNT_A, 1), (ACCOUNT_B, 1)]


def test_an_account_whose_scan_failed_is_not_marked_baselined(discovery, monkeypatch):
    discovery.rows[ACCOUNT_A] = [_row(_meta_id(), "2026-01-05T10:00:00Z")]
    meta_ads.discover_meta_ads(force=True)
    history_b = [_meta_id() for _ in range(2)]
    discovery.rows[ACCOUNT_B] = [_row(meta_id, "2026-02-10T10:00:00Z") for meta_id in history_b]
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", f"{ACCOUNT_A},{ACCOUNT_B}")
    real_list = discovery.list_ads

    def failing_for_b(account_id, search="", *, max_pages=5):
        if str(account_id) == ACCOUNT_B:
            discovery.list_calls.append((str(account_id), int(max_pages)))
            raise meta_ads.MetaAdsError("temporary", "Meta is temporarily unavailable.", retryable=True)
        return real_list(account_id, search, max_pages=max_pages)

    monkeypatch.setattr(discovery, "list_ads", failing_for_b)
    meta_ads.discover_meta_ads(force=True)
    assert meta_ads._load_import_state()["baselineAccounts"] == [ACCOUNT_A]
    monkeypatch.setattr(discovery, "list_ads", real_list)
    again = meta_ads.discover_meta_ads(force=True)
    assert again["imported"] == [] and _ads_for(history_b) == []
    assert discovery.list_calls[-1] == (ACCOUNT_B, 25)
    assert meta_ads._load_import_state()["baselineAccounts"] == sorted([ACCOUNT_A, ACCOUNT_B])


def test_a_state_saved_before_the_per_account_baseline_keeps_todays_accounts(discovery):
    known = _meta_id()
    meta_ads._save_import_state({"baselineComplete": True, "baselineAt": "2026-05-01T00:00:00Z",
                                 "knownMetaAdIds": [known]})
    fresh = _meta_id()
    discovery.rows[ACCOUNT_A] = [_row(fresh, "2026-04-01T10:00:00Z"), _row(known, "2026-04-01T10:00:00Z")]
    result = meta_ads.discover_meta_ads(force=True)
    # Account A counted as baselined (fast scan, the known-ids rule): the unseen ad is new.
    assert [row["data"]["metaAdId"] for row in result["imported"]] == [fresh]
    assert discovery.list_calls == [(ACCOUNT_A, 1)]
    assert meta_ads._load_import_state()["baselineAccounts"] == [ACCOUNT_A]


def test_a_new_ad_in_a_closed_month_is_remembered_not_retried(discovery, monkeypatch):
    period = "2019-07"
    close_id = f"financial-close-{period}"
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE type='financialClosures' AND id=:id"), {"id": close_id})
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('financialClosures',:id,:data,false,:stamp,NULL,:stamp)"),
            {"id": close_id, "data": json_dumps({"period": period, "status": "closed"}), "stamp": stamp},
        )
    try:
        discovery.rows[ACCOUNT_A] = [_row(_meta_id(), "2026-01-05T10:00:00Z")]
        meta_ads.discover_meta_ads(force=True)  # baseline
        closed = _meta_id()
        discovery.rows[ACCOUNT_A].insert(0, _row(closed, "2019-07-15T10:00:00Z", startTime="2019-07-15T10:00:00Z"))
        attempts = []
        real_import = meta_ads.import_meta_ad_draft

        def counting_import(snapshot):
            attempts.append(str(snapshot.get("metaAdId")))
            return real_import(snapshot)

        monkeypatch.setattr(meta_ads, "import_meta_ad_draft", counting_import)
        first = meta_ads.discover_meta_ads(force=True)
        assert first["imported"] == [] and attempts == [closed]
        state = meta_ads._load_import_state()
        assert closed in state["knownMetaAdIds"], "a closed-month ad stayed unknown, so every pass retries it"
        assert state["lastError"] == ""
        assert state["lastSuccessAt"] == state["lastDiscoveryAt"]
        second = meta_ads.discover_meta_ads(force=True)
        assert second["imported"] == [] and attempts == [closed]  # never tried again
        assert _ads_for([closed]) == []
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='financialClosures' AND id=:id"), {"id": close_id})


# ------------------------------------------------------------------ #5: a healthy open-ended read is taken as it is

def _insert_linked_ad(ad_id: str) -> None:
    stamp = now_ms()
    data = {"id": ad_id, "recordType": "ad", "status": "Active", "amountUSD": 100, "customerId": f"review_m2_{TAG}",
            "startDate": "2026-09-20", "_created": stamp, "_lastModified": stamp, "_deleted": False}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES ('ads',:id,:data,false,:stamp,NULL,:stamp)"),
            {"id": ad_id, "data": json_dumps(data), "stamp": stamp},
        )


def _stored(ad_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"), {"id": ad_id}).mappings().first()
    return json_loads(row["data_json"])


def _snapshot(meta_id: str, **overrides) -> dict:
    stamp = "2026-09-20T12:00:00Z"
    snap = {
        "metaLinkState": "linked", "metaLinkVersion": 1, "metaAdId": meta_id, "metaAdName": f"Review M2 {meta_id}",
        "metaAdSetId": "222222222222222", "metaAdSetName": "Review M2 ad set",
        "metaCampaignId": "333333333333333", "metaCampaignName": "Review M2 campaign",
        "metaAdAccountId": ACCOUNT_A, "metaCurrency": "USD", "metaConfiguredStatus": "ACTIVE",
        "metaEffectiveStatus": "ACTIVE", "metaBudgetSource": "adset", "metaDailyBudgetMinor": 1000,
        "metaLifetimeBudgetMinor": 0, "metaTotalBudgetMinor": 10000, "metaTotalBudgetKind": "estimated_daily",
        "metaBudgetRemainingMinor": 800, "metaTotalRemainingBudgetMinor": 9500,
        "metaStartTime": "2026-09-20T00:00:00Z", "metaEndTime": "2026-09-30T00:00:00Z", "metaDurationDays": 10,
        "metaSpend": 5.0, "metaSpendMinor": 500, "metaReach": 10, "metaImpressions": 20, "metaClicks": 1,
        "metaActions": [], "metaSyncedAt": stamp, "metaLastAttemptAt": stamp, "metaSyncError": "",
        "metaSyncErrorCode": "", "metaSyncFailureCount": 0, "metaNextSyncAt": now_ms() + 900_000, "metaUnlinkedAt": "",
        "metaMediaVersion": meta_ads._META_MEDIA_VERSION,
    }
    snap.update(overrides)
    return snap


def _apply(ad_id: str, snapshot: dict) -> None:
    meta_ads.apply_meta_snapshot(ad_id, snapshot, actor_id=None, actor_name="Meta automatic sync",
                                 expected_last_modified=None, operation_id=None, action="automatic_sync")


def test_a_healthy_open_ended_read_replaces_the_old_end_date_and_total():
    ad_id = f"ad_review_m2_open_{TAG}"
    meta_id = _meta_id()
    _insert_linked_ad(ad_id)
    try:
        _apply(ad_id, _snapshot(meta_id))
        assert _stored(ad_id)["metaTotalBudgetMinor"] == 10000
        # Staff switch the ad set to "run continuously": Meta reads fine (names present), no end, no total.
        open_ended = _snapshot(meta_id, metaEndTime="", metaDurationDays=0, metaTotalBudgetMinor=0,
                               metaTotalBudgetKind="open_ended", metaTotalRemainingBudgetMinor=0)
        for _ in range(2):
            _apply(ad_id, dict(open_ended))
            stored = _stored(ad_id)
            assert stored["metaEndTime"] == "", "the old end date came back"
            assert stored["metaTotalBudgetMinor"] == 0 and stored["metaTotalBudgetKind"] == "open_ended"
            assert stored["metaDurationDays"] == 0 and stored["metaTotalRemainingBudgetMinor"] == 0
            assert stored["metaDailyBudgetMinor"] == 1000

        # A degraded pass (the ad set/campaign could not be read) still keeps what is known.
        _apply(ad_id, _snapshot(meta_id))
        degraded = _snapshot(meta_id, metaAdSetName="", metaCampaignName="", metaStartTime="", metaEndTime="",
                             metaDailyBudgetMinor=0, metaTotalBudgetMinor=0, metaTotalBudgetKind="",
                             metaDurationDays=0, metaBudgetSource="", metaTotalRemainingBudgetMinor=0)
        _apply(ad_id, degraded)
        stored = _stored(ad_id)
        assert stored["metaEndTime"] == "2026-09-30T00:00:00Z" and stored["metaStartTime"] == "2026-09-20T00:00:00Z"
        assert stored["metaTotalBudgetMinor"] == 10000 and stored["metaTotalBudgetKind"] == "estimated_daily"
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='ads' AND id=:id"), {"id": ad_id})
            conn.execute(text("DELETE FROM audit_logs WHERE resource_id=:id"), {"id": ad_id})


# ------------------------------------------------------------------ #6: a link takes the import lock first (PostgreSQL)

class _RowLockReached(Exception):
    pass


def _spy_postgres(monkeypatch) -> list[str]:
    statements: list[str] = []

    class _Conn:
        def execute(self, statement, params=None):
            sql = str(statement)
            statements.append(sql)
            if "FOR UPDATE" in sql:
                raise _RowLockReached()
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: None, all=lambda: []))

    @contextmanager
    def fake_conn():
        yield _Conn()

    monkeypatch.setattr(meta_ads, "get_engine", lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
    monkeypatch.setattr(meta_ads, "db_conn", fake_conn)
    return statements


def test_a_postgres_link_takes_the_import_lock_before_the_row_lock(monkeypatch):
    statements = _spy_postgres(monkeypatch)
    with pytest.raises(_RowLockReached):
        meta_ads.apply_meta_snapshot(f"ad_review_m2_link_{TAG}", _snapshot(_meta_id()), actor_id="admin",
                                     actor_name="Admin", expected_last_modified=1, operation_id=None, action="link")
    assert len(statements) == 2
    assert "pg_advisory_xact_lock(hashtext('albayan_meta_import'))" in statements[0], statements
    assert "FOR UPDATE" in statements[1]


def test_a_postgres_sync_of_the_same_meta_ad_does_not_wait_for_imports(monkeypatch):
    statements = _spy_postgres(monkeypatch)
    with pytest.raises(_RowLockReached):
        meta_ads.apply_meta_snapshot(f"ad_review_m2_sync_{TAG}", _snapshot(_meta_id()), actor_id=None,
                                     actor_name="Meta automatic sync", expected_last_modified=None,
                                     operation_id=None, action="automatic_sync")
    assert len(statements) == 1 and "FOR UPDATE" in statements[0]
