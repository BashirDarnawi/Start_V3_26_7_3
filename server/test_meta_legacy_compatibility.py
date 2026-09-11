"""Old Meta rows heal in place without touching uploaded photos or finances.

Each test owns a disposable database. All Meta/CDN answers are mocked, and
the old rows are inserted directly to bypass today's creation defaults.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from server import db, meta_ads as meta, operations


META_ID = "771234567890123"
CDN_URL = "https://scontent.xx.fbcdn.net/old-image.jpg?signature=old"
PHOTO = "data:image/png;base64,YXJjaGl2ZWQ="
UPLOAD = "data:image/png;base64,dXBsb2FkZWQ="


@pytest.fixture(autouse=True)
def private_database(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:", poolclass=StaticPool)
    for module in (db, meta, operations):
        monkeypatch.setattr(module, "get_engine", lambda: engine)
    db.init_db()
    monkeypatch.setattr(meta, "_META_MEDIA_FAILURES", {})
    monkeypatch.setattr(meta, "_PAGE_NAME_FAILURE_UNTIL", {})
    monkeypatch.setattr(meta, "load_meta_ads_config", lambda: SimpleNamespace(configured=False))

    def no_network(*args, **kwargs):
        raise AssertionError("Legacy compatibility tests must never use the network")

    monkeypatch.setattr(meta, "_archive_meta_image", no_network)
    monkeypatch.setattr(meta, "get_meta_ads_client", no_network)
    yield
    engine.dispose()


def insert_old(kind, entity_id, data, *, deleted=False):
    """An actual pre-upgrade row: no constructor fills in current fields."""
    with db.db_conn() as conn:
        conn.execute(text(
            "INSERT INTO entities(type,id,data_json,deleted,created_at,created_by,last_modified) "
            "VALUES (:kind,:id,:data,:deleted,1000,NULL,1000)"
        ), {"kind": kind, "id": entity_id, "data": db.json_dumps(data), "deleted": deleted})


def read(kind, entity_id):
    with db.db_conn() as conn:
        row = conn.execute(text(
            "SELECT data_json,last_modified FROM entities WHERE type=:kind AND id=:id"
        ), {"kind": kind, "id": entity_id}).mappings().one()
    return db.json_loads(row["data_json"]), row["last_modified"]


def media_fields(kind):
    if kind == "ads":
        return "metaAdId", "metaThumbnailUrl", "metaThumbnailData", "metaThumbnailArchivedFrom"
    return "metaPageId", "metaPagePictureUrl", "metaPagePictureData", "metaPagePictureArchivedFrom"


@pytest.mark.parametrize("kind", ["ads", "pages"])
@pytest.mark.parametrize("missing", ["absent", None, "", "   "])
def test_failed_legacy_archive_is_repaired_once_without_recreating_record(monkeypatch, kind, missing):
    identity, url_key, data_key, from_key = media_fields(kind)
    old = {
        identity: META_ID, url_key: CDN_URL, from_key: CDN_URL,
        "adPhotos": [UPLOAD], "mainPhotoIndex": 0,
        "amountUSD": 30.14, "paymentStatus": "not_paid",
        "receiptId": "historic-receipt", "customerIds": ["original-owner"],
        "notes": "Keep the original human notes",
    }
    if missing != "absent":
        old[data_key] = missing
    insert_old(kind, "old-row", old)
    downloads = []
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: downloads.append(url) or PHOTO)

    assert meta.archive_meta_media() == 1
    repaired, version = read(kind, "old-row")
    assert repaired[data_key] == PHOTO
    assert repaired[from_key] == CDN_URL
    for field in old.keys() - {data_key}:
        assert repaired[field] == old[field], field
    assert version > 1000
    assert repaired["_created"] == 1000
    assert meta.archive_meta_media() == 0
    assert downloads == [CDN_URL]
    assert read(kind, "old-row") == (repaired, version)


@pytest.mark.parametrize("kind", ["ads", "pages"])
def test_existing_archived_photo_and_manual_uploads_are_never_replaced(kind):
    identity, url_key, data_key, from_key = media_fields(kind)
    old = {identity: META_ID, url_key: CDN_URL, from_key: CDN_URL,
           data_key: PHOTO, "adPhotos": [UPLOAD], "mainPhotoIndex": 0}
    insert_old(kind, "already-good", old)
    assert meta.archive_meta_media() == 0  # Default mock rejects any download.
    assert read(kind, "already-good") == (old, 1000)
    # The same guard holds if another worker saved the copy after selection.
    meta._store_archived_image(kind, "already-good", CDN_URL, data_key, from_key, UPLOAD)
    assert read(kind, "already-good") == (old, 1000)


@pytest.mark.parametrize("kind", ["ads", "pages"])
def test_old_failed_stamp_still_uses_retry_backoff_without_changing_row(monkeypatch, kind):
    identity, url_key, data_key, from_key = media_fields(kind)
    old = {identity: META_ID, url_key: CDN_URL, from_key: CDN_URL}
    insert_old(kind, "failed-old", old)
    clock = SimpleNamespace(now=100.0)
    calls = []
    monkeypatch.setattr(meta.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: calls.append(url) or "")
    assert meta.archive_meta_media() == 0
    assert meta.archive_meta_media() == 0
    assert calls == [CDN_URL]
    assert read(kind, "failed-old") == (old, 1000)
    clock.now += 61
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: calls.append(url) or PHOTO)
    assert meta.archive_meta_media() == 1
    assert calls == [CDN_URL, CDN_URL]
    assert read(kind, "failed-old")[0][data_key] == PHOTO


@pytest.mark.parametrize("kind", ["ads", "pages"])
def test_deleted_old_media_is_not_resurrected(kind):
    identity, url_key, _data_key, from_key = media_fields(kind)
    old = {identity: META_ID, url_key: CDN_URL, from_key: CDN_URL}
    insert_old(kind, "deleted", old, deleted=True)
    assert meta.archive_meta_media() == 0
    assert read(kind, "deleted") == (old, 1000)


@pytest.mark.parametrize("placeholder", [
    None, "", META_ID, "Facebook Page", f"Page {META_ID}", f"FACEBOOK PAGE {META_ID}",
])
def test_all_legacy_page_placeholders_heal_from_local_ad_even_during_cooldown(placeholder):
    old = {"name": placeholder, "metaPageId": META_ID,
           "customerIds": ["historic-customer"], "notes": "Keep owner and notes"}
    insert_old("pages", "existing-page", old)
    insert_old("ads", "existing-ad", {
        "metaAdId": "991234567890123", "metaPageId": META_ID,
        "metaPageName": "متجر الاختبار الحقيقي", "pageId": "existing-page",
        "amountUSD": 12, "receiptId": "historic-receipt",
    })
    old_ad = read("ads", "existing-ad")
    meta._remember_page_name_failure(META_ID)
    assert meta.backfill_placeholder_page_names() == 1
    repaired, version = read("pages", "existing-page")
    assert repaired["name"] == "متجر الاختبار الحقيقي"
    assert repaired["customerIds"] == old["customerIds"]
    assert repaired["notes"] == old["notes"]
    assert read("ads", "existing-ad") == old_ad
    assert not meta._page_name_failure_active(META_ID)
    assert meta.backfill_placeholder_page_names() == 0
    assert read("pages", "existing-page") == (repaired, version)
    with db.db_conn() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM entities WHERE type='pages'")).scalar() == 1


def test_old_manual_page_name_is_not_overwritten_by_resolved_meta_name():
    old = {"name": "Owner chose this display name", "metaPageId": META_ID,
           "metaPageName": "Facebook knows this different name", "customerIds": ["owner"]}
    insert_old("pages", "manual", old)
    assert meta.backfill_placeholder_page_names() == 0
    assert read("pages", "manual") == (old, 1000)


@pytest.mark.parametrize("placeholder", [META_ID, "Facebook Page", f"Page {META_ID}"])
def test_later_placeholder_snapshot_does_not_erase_known_page_identity(placeholder):
    old = {"name": "Manual display name", "metaPageId": META_ID,
           "metaPageName": "Real Meta name", "customerIds": ["owner"]}
    insert_old("pages", "known", old)
    with db.db_conn() as conn:
        page_id, name, created = meta._ensure_import_page(
            conn, {"metaPageId": META_ID, "metaPageName": placeholder})
    stored, _ = read("pages", "known")
    assert (page_id, name, created) == ("known", "Manual display name", False)
    assert stored["metaPageName"] == "Real Meta name"


def test_missing_old_page_copy_accepts_fresh_signature_and_then_stops_rewriting(monkeypatch):
    new_url = CDN_URL.replace("signature=old", "signature=fresh")
    insert_old("pages", "missing", {
        "name": "Shop", "metaPageId": META_ID,
        "metaPagePictureUrl": CDN_URL, "metaPagePictureArchivedFrom": CDN_URL,
    })
    with db.db_conn() as conn:
        meta._ensure_import_page(conn, {"metaPageId": META_ID, "metaPagePictureUrl": new_url})
    assert read("pages", "missing")[0]["metaPagePictureUrl"] == new_url
    downloads = []
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: downloads.append(url) or PHOTO)
    assert meta.archive_meta_media() == 1
    archived = read("pages", "missing")
    assert downloads == [new_url]
    with db.db_conn() as conn:
        meta._ensure_import_page(conn, {
            "metaPageId": META_ID,
            "metaPagePictureUrl": CDN_URL.replace("signature=old", "signature=next"),
        })
    assert read("pages", "missing") == archived


def test_copy_of_an_older_page_photo_does_not_freeze_new_failed_photo_signature(monkeypatch):
    new_asset = "https://scontent.xx.fbcdn.net/new-image.jpg?signature=expired"
    fresh_asset = new_asset.replace("signature=expired", "signature=fresh")
    insert_old("pages", "changed-avatar", {
        "name": "Shop", "metaPageId": META_ID,
        "metaPagePictureUrl": new_asset,
        "metaPagePictureArchivedFrom": CDN_URL, "metaPagePictureData": PHOTO,
    })
    with db.db_conn() as conn:
        meta._ensure_import_page(conn, {"metaPageId": META_ID, "metaPagePictureUrl": fresh_asset})
    waiting, _ = read("pages", "changed-avatar")
    assert waiting["metaPagePictureUrl"] == fresh_asset
    assert waiting["metaPagePictureData"] == PHOTO
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: UPLOAD)
    assert meta.archive_meta_media() == 1
    assert read("pages", "changed-avatar")[0]["metaPagePictureData"] == UPLOAD


def test_legacy_media_repair_keeps_closed_accounting_period_protection(monkeypatch):
    insert_old("ads", "closed-ad", {
        "startDate": "2026-01-05", "amountUSD": 30.14,
        "metaAdId": META_ID, "metaThumbnailUrl": CDN_URL,
        "metaThumbnailArchivedFrom": CDN_URL,
    })
    insert_old(operations.FINANCIAL_CLOSE_COLLECTION, "financial-close-2026-01", {"status": "closed"})
    insert_old("pages", "open-page", {"metaPageId": META_ID, "metaPagePictureUrl": CDN_URL,
                                       "metaPagePictureArchivedFrom": CDN_URL})
    before = read("ads", "closed-ad")
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: PHOTO)
    assert meta.archive_meta_media() == 1
    assert read("ads", "closed-ad") == before
    assert read("pages", "open-page")[0]["metaPagePictureData"] == PHOTO
