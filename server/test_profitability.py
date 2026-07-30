from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from server.profitability import validate_dollar_purchase


def test_dollar_purchase_is_normalized_and_total_is_authoritative():
    result = validate_dollar_purchase(
        {
            "purchaseDate": date.today().isoformat(),
            "amountUSD": "100.126",
            "rateLYD": "9.71234",
            "totalLYD": 1,
            "source": "  Market   account  ",
            "note": " first   lot ",
            "ignored": "never stored",
        }
    )
    assert result == {
        "purchaseDate": date.today().isoformat(),
        "amountUSD": 100.13,
        "rateLYD": 9.7123,
        "totalLYD": 972.49,
        "source": "Market account",
        "note": "first lot",
    }


@pytest.mark.parametrize(
    "field,value",
    [("amountUSD", 0), ("amountUSD", -1), ("amountUSD", "no"), ("rateLYD", 0), ("rateLYD", "NaN")],
)
def test_dollar_purchase_rejects_invalid_money(field, value):
    payload = {"purchaseDate": date.today().isoformat(), "amountUSD": 10, "rateLYD": 9.5}
    payload[field] = value
    with pytest.raises(HTTPException) as error:
        validate_dollar_purchase(payload)
    assert error.value.status_code == 400


def test_dollar_purchase_rejects_future_date():
    with pytest.raises(HTTPException) as error:
        validate_dollar_purchase(
            {
                "purchaseDate": (date.today() + timedelta(days=1)).isoformat(),
                "amountUSD": 10,
                "rateLYD": 9.5,
            }
        )
    assert error.value.status_code == 400
