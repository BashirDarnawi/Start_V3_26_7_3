from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from server import operations
from server.profitability import validate_dollar_purchase


# The rule compares with the Libya business day (operations._business_today), never the machine's
# day: a UTC runner is a day behind Tripoli from 22:00 to 24:00 UTC (review loop r3 n25).
def _today() -> date:
    return operations._business_today()


def test_dollar_purchase_is_normalized_and_total_is_authoritative():
    day = _today().isoformat()
    result = validate_dollar_purchase(
        {
            "purchaseDate": day,
            "amountUSD": "100.126",
            "rateLYD": "9.71234",
            "totalLYD": 1,
            "source": "  Market   account  ",
            "note": " first   lot ",
            "ignored": "never stored",
        }
    )
    assert result == {
        "purchaseDate": day,
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
    payload = {"purchaseDate": _today().isoformat(), "amountUSD": 10, "rateLYD": 9.5}
    payload[field] = value
    with pytest.raises(HTTPException) as error:
        validate_dollar_purchase(payload)
    assert error.value.status_code == 400


def test_dollar_purchase_rejects_future_date(monkeypatch):
    # Pinned to the Tripoli day of 22:30 UTC on 2026-09-29: the UTC day is still the 29th there.
    monkeypatch.setattr(operations, "_business_today", lambda: date(2026, 9, 30))
    assert validate_dollar_purchase({"purchaseDate": "2026-09-30", "amountUSD": 10, "rateLYD": 9.5})["purchaseDate"] == "2026-09-30"
    with pytest.raises(HTTPException) as error:
        validate_dollar_purchase(
            {
                "purchaseDate": (date(2026, 9, 30) + timedelta(days=1)).isoformat(),
                "amountUSD": 10,
                "rateLYD": 9.5,
            }
        )
    assert error.value.status_code == 400
    assert error.value.detail == "purchaseDate cannot be in the future"


def test_dollar_purchase_future_check_follows_the_business_clock():
    # The real clock, counted the way the code counts it: tomorrow in Tripoli is refused at any hour.
    with pytest.raises(HTTPException) as error:
        validate_dollar_purchase(
            {"purchaseDate": (_today() + timedelta(days=1)).isoformat(), "amountUSD": 10, "rateLYD": 9.5}
        )
    assert error.value.status_code == 400
