"""The campaign-field validators were moved out of server/main.py (which sat
at its enforced line cap) into server/ad_campaign_fields.py, with main.py
keeping thin bindings under the historical private names. These checks pin
that wiring so a future edit cannot silently re-create a second copy in
main.py or break the ctx contract.

Run with: PYTHONPATH=. pytest server/test_ad_campaign_fields_wiring.py -v
"""

import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from server import ad_campaign_fields, main


def test_main_binds_the_moved_validators_not_copies():
    assert main._validate_ad_campaign_image_source is ad_campaign_fields.validate_ad_campaign_image_source
    ctx = main._AD_CAMPAIGN_FIELDS_CTX
    assert ctx["sanitize_str"] is main.sanitize_str
    assert ctx["sanitize_json"] is main.sanitize_json
    assert ctx["validate_entity_id"] is main.validate_entity_id
    assert ctx["max_data_url_length"] == main.MAX_DATA_URL_LENGTH
    assert ctx["allowed_fields"] is main.AD_CAMPAIGN_ALLOWED_FIELDS
    # The moved names must not exist in main.py any more (no second copy).
    for name in ("_ad_campaign_string", "_ad_campaign_string_list", "_ad_campaign_date",
                 "_ad_campaign_image_dimensions", "AD_CAMPAIGN_CALL_TO_ACTIONS",
                 "MAX_AD_CAMPAIGN_BUDGET_MINOR_USD"):
        assert not hasattr(main, name), name


def test_binding_threads_every_keyword_through():
    clean = main._prepare_ad_campaign_fields(
        {"name": "  Spring Sale  ", "callToAction": "shop_now", "budgetType": "Daily",
         "platforms": ["Facebook", "facebook", "instagram"], "budgetMinorUSD": 500},
        strict=False,
    )
    assert clean["name"] == "Spring Sale"
    assert clean["callToAction"] == "Shop Now"
    assert clean["budgetType"] == "daily"
    assert clean["platforms"] == ["facebook", "instagram"]
    assert clean["budgetMinorUSD"] == 500

    with pytest.raises(HTTPException) as unknown:
        main._prepare_ad_campaign_fields({"bogus": 1}, strict=False, reject_unknown=True)
    assert unknown.value.status_code == 400
    assert "Unsupported campaign field: bogus" in unknown.value.detail

    # trusted_media skips the decoder but still enforces the data-URL length.
    too_long = "data:image/png;base64," + ("A" * (main.MAX_DATA_URL_LENGTH + 1))
    with pytest.raises(HTTPException) as big:
        main._prepare_ad_campaign_fields({"creativeImages": [too_long]}, strict=False, trusted_media=True)
    assert big.value.status_code == 413


def test_module_functions_reject_bad_input_the_same_way():
    ctx = main._AD_CAMPAIGN_FIELDS_CTX
    with pytest.raises(HTTPException) as err:
        ad_campaign_fields.ad_campaign_string(123, "headline", 10, ctx)
    assert err.value.detail == "headline must be text"
    assert ad_campaign_fields.ad_campaign_string_list(
        ["A", "a", " b "], "interests", ctx, max_items=5, lower=True
    ) == ["a", "b"]
    assert ad_campaign_fields.ad_campaign_date(None, "startDate", ctx) is None
    with pytest.raises(HTTPException) as bad_date:
        ad_campaign_fields.ad_campaign_date("not-a-date", "startDate", ctx)
    assert bad_date.value.detail == "startDate must be a valid ISO date"
