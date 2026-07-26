from server.entity_projection import (
    _project_entity_media,
    _without_customer_contacts,
    _without_inline_media,
    can_include_entity_media,
    project_entity_contacts,
)


def test_media_projection_counts_unique_sources_without_mutating_input():
    data = {"photos": [" a ", "a", "b"], "receiptImage": "c", "amount": 10}
    projected = _without_inline_media("receipts", data)
    assert projected == {"amount": 10, "_mediaOmitted": True, "_photoCount": 3}
    assert "photos" in data


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
