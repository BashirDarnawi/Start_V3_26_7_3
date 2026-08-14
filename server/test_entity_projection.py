import json
import sqlite3

from server.entity_projection import (
    _inline_media_sql_projection,
    _project_entity_media,
    _without_customer_contacts,
    _without_inline_media,
    can_include_entity_media,
    project_entity_contacts,
)


def _sqlite_inline_media_projection(entity_type, data):
    projection = _inline_media_sql_projection(entity_type, "sqlite")
    assert projection is not None
    data_expression, count_expression = projection
    with sqlite3.connect(":memory:") as conn:
        conn.execute("CREATE TABLE probe (data_json TEXT NOT NULL)")
        conn.execute("INSERT INTO probe (data_json) VALUES (?)", (json.dumps(data),))
        row = conn.execute(
            f"SELECT {data_expression}, {count_expression} FROM probe"
        ).fetchone()
    assert row is not None
    return json.loads(row[0]), int(row[1])


def test_media_projection_counts_unique_sources_without_mutating_input():
    data = {"photos": [" a ", "a", "b"], "receiptImage": "c", "amount": 10}
    projected = _without_inline_media("receipts", data)
    assert projected == {"amount": 10, "_mediaOmitted": True, "_photoCount": 3}
    assert "photos" in data


def test_sql_projection_strips_inline_receipt_media_and_matches_python_count():
    data = {
        "photos": [" a ", "a", "b", 9, None],
        "receiptImage": " c ",
        "amount": 10,
    }
    projected, count = _sqlite_inline_media_projection("receipts", data)
    assert projected == {"amount": 10}
    assert count == _without_inline_media("receipts", data)["_photoCount"] == 3


def test_sql_projection_strips_meta_archives_without_counting_them_as_uploads():
    data = {
        "adPhotos": ["same", "other"],
        "photos": ["same"],
        "metaThumbnailData": "data:image/png;base64,archive",
        "amountUSD": 5,
    }
    projected, count = _sqlite_inline_media_projection("ads", data)
    assert projected == {"amountUSD": 5}
    assert count == 2

    page, page_count = _sqlite_inline_media_projection(
        "pages", {"name": "Page", "metaPagePictureData": "data:image/png;base64,page"}
    )
    assert page == {"name": "Page"}
    assert page_count == 0


def test_sql_projection_rejects_dynamic_column_names_and_unknown_dialects():
    assert _inline_media_sql_projection("receipts", "oracle") is None
    try:
        _inline_media_sql_projection(
            "receipts", "sqlite", json_column="data_json); DROP TABLE entities;--"
        )
    except ValueError as exc:
        assert "Unsafe JSON column" in str(exc)
    else:  # pragma: no cover - makes an accidental weakening explicit
        raise AssertionError("unsafe SQL identifier was accepted")


def test_contact_projection_redacts_nested_historical_contact_copies():
    entity = {
        "type": "receipts",
        "data": {
            "customerName": "Safe name",
            "customerPhone": "0910000000",
            "delivery": {"address": "Secret", "note": "Keep"},
        },
    }
    projected = project_entity_contacts(entity, can_view_contacts=False)
    assert projected["data"] == {"customerName": "Safe name", "delivery": {"note": "Keep"}}
    assert entity["data"]["customerPhone"] == "0910000000"


def test_ad_photo_permission_is_separate_from_record_visibility():
    assert can_include_entity_media("ads", True, False) is False
    assert can_include_entity_media("ads", True, True) is True
    assert can_include_entity_media("receipts", True, False) is True
    assert _project_entity_media({"type": "customers", "data": {"name": "A"}}, False)["data"]["name"] == "A"
    assert _without_customer_contacts([{"email": "x", "value": 1}]) == [{"value": 1}]
