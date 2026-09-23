"""Meta Insights: the money Meta reports in each connected ad account.

The owner adds prepaid funds to an ad account ("available funds") and needs to see
them next to the remaining budget of the active ads. These tests fake Meta's Graph
API; nothing here reaches the network.
"""

import secrets

import httpx
import pytest
from fastapi.testclient import TestClient

import server.meta_ads as meta_ads
from server.db import init_db
from server.main import app
from server.test_meta_ads import _insert_user, _login, _real_client

TAG = secrets.token_hex(3)
client = TestClient(app, headers={"Origin": "http://testserver"})
PASSWORD = "MetaFundsPassword123!"


def _account_payload(account_id: str, **fields) -> dict:
    payload = {"id": f"act_{account_id}", "account_id": account_id, "name": "Prepaid Balance 2", "currency": "USD", "account_status": 1}
    payload.update(fields)
    return payload


@pytest.fixture(autouse=True)
def _no_provider_pause(monkeypatch):
    # A throttling answer pauses every Meta caller in this process; never leak that pause.
    monkeypatch.setattr(meta_ads, "_META_REMOTE_BACKOFF_UNTIL", 0.0)
    yield
    meta_ads._META_REMOTE_BACKOFF_UNTIL = 0.0


# ---------------------------------------------------------------- the amount parser

@pytest.mark.parametrize("text_value,expected", [
    ("Available Balance ($200.00 USD)", 20000),
    ("Available balance: $1,234.56", 123456),
    ("Balance 300 LYD", 30000),
    ("USD 75.5", 7550),
    ("Saldo disponible (200,50 USD)", None),       # a decimal comma is never read as 20,050
    ("Saldo (€ 1.234,56)", None),
    ("Available Balance (-$12.00 USD)", None),     # a negative is never shown as +$12.00
    ("(-5.00 USD)", None),
    ("Visa *1234", None),
    ("", None),
])
def test_funds_text_amounts_are_read_only_when_unambiguous(text_value, expected):
    assert meta_ads._funds_text_minor(text_value) == expected


# ---------------------------------------------------------------- the client call

@pytest.mark.parametrize("prepay,funding_type", [(True, 20), (False, 20), (True, None)])
def test_prepaid_account_reports_its_available_funds(monkeypatch, prepay, funding_type):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        details = {"id": "1", "display_string": "Available Balance ($200.00 USD)"}
        if funding_type is not None:
            details["type"] = funding_type
        return httpx.Response(200, json=_account_payload(
            "444444444444444", is_prepay_account=prepay, amount_spent="5000", spend_cap="0", balance="0",
            funding_source_details=details))

    funds = _real_client(monkeypatch, handler).get_account_funds("444444444444444")
    assert "funding_source_details" in seen[0]["fields"] and seen[0].get("locale") == "en_US"
    assert funds["fundsMinor"] == 20000 and funds["fundsText"] == "Available Balance ($200.00 USD)"
    assert funds["fundsHidden"] is False and funds["capRemainingMinor"] is None and funds["amountDueMinor"] == 0
    assert funds["name"] == "Prepaid Balance 2" and funds["currency"] == "USD" and funds["readAt"]


def test_a_refused_funding_field_is_retried_view_only_and_flagged(monkeypatch):
    seen = []

    def handler(request):
        fields = str(request.url.params.get("fields") or "")
        seen.append(fields)
        if "funding_source_details" in fields:
            return httpx.Response(400, json={"error": {"code": 200, "message": "Requires MANAGE on the ad account"}})
        return httpx.Response(200, json=_account_payload("444444444444444", spend_cap="50000", amount_spent="12345", balance="700"))

    funds = _real_client(monkeypatch, handler).get_account_funds("444444444444444")
    assert len(seen) == 2
    assert "funding_source_details" not in seen[1] and "is_prepay_account" not in seen[1]   # a view-only token can read it
    assert funds["fundsMinor"] is None and funds["fundsText"] == "" and funds["fundsHidden"] is True
    assert funds["capRemainingMinor"] == 37655      # a $500 spend limit with $123.45 spent
    assert funds["amountDueMinor"] == 700


def test_a_card_funding_source_is_never_read_as_money(monkeypatch):
    def handler(request):
        return httpx.Response(200, json=_account_payload(
            "444444444444444", is_prepay_account=False, amount_spent="0", spend_cap="0", balance="0",
            funding_source_details={"id": "2", "display_string": "Visa *1234 (limit $50.00 USD)", "type": 1}))

    funds = _real_client(monkeypatch, handler).get_account_funds("444444444444444")
    assert funds["fundsMinor"] is None and funds["fundsText"] == "Visa *1234 (limit $50.00 USD)"
    assert funds["fundsHidden"] is False


@pytest.mark.parametrize("status,body", [
    (400, {"error": {"code": 80004, "message": "Too many calls"}}),              # throttled (sets a pause)
    (500, {"error": {"code": 2, "message": "Service temporarily unavailable"}}),  # transient (no pause)
    (401, {"error": {"code": 190, "message": "Invalid token"}}),                 # dead token
])
def test_errors_a_second_read_cannot_fix_are_not_retried(monkeypatch, status, body):
    seen = []

    def handler(request):
        seen.append(1)
        return httpx.Response(status, json=body)

    with pytest.raises(meta_ads.MetaAdsError):
        _real_client(monkeypatch, handler).get_account_funds("444444444444444")
    assert len(seen) == 1


# ---------------------------------------------------------------- the scan and the route

def _row(account_id, amount=20000):
    return {"id": account_id, "name": f"Account {account_id[-3:]}", "currency": "USD", "status": 1, "isPrepay": True,
            "fundsText": f"Available Balance (${amount / 100:.2f} USD)", "fundsMinor": amount, "fundsHidden": False,
            "spendCapMinor": 0, "amountSpentMinor": 0, "capRemainingMinor": None, "amountDueMinor": 0,
            "readAt": "2026-09-23T09:00:00Z", "error": ""}


class _FundsFake:
    def __init__(self):
        self.calls: list[str] = []
        self.fail: dict[str, BaseException] = {}
        self.listed: list[dict] = []

    def list_accounts(self):
        return self.listed

    def get_account_funds(self, account_id):
        self.calls.append(account_id)
        if account_id in self.fail:
            raise self.fail[account_id]
        return _row(account_id)


@pytest.fixture()
def funds_env(monkeypatch):
    fake = _FundsFake()
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "secret-token-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_APP_SECRET", "secret-app-value-must-never-leak")
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "444444444444444,555555555555555")
    monkeypatch.setenv("ALBAYAN_META_BACKGROUND_SYNC", "false")
    monkeypatch.setattr(meta_ads, "get_meta_ads_client", lambda: fake)
    meta_ads._META_FUNDS_CACHE.clear()
    yield fake
    meta_ads._META_FUNDS_CACHE.clear()


@pytest.fixture(scope="module")
def people():
    init_db()
    admin_email, staff_email = f"funds-admin-{TAG}@tests.albayanhub.com", f"funds-staff-{TAG}@tests.albayanhub.com"
    _insert_user("Funds Admin", admin_email, PASSWORD, "Admin", {})
    _insert_user("Funds Staff", staff_email, PASSWORD, "Employee", {"ads": ["view", "edit"]})
    return {"admin": _login(admin_email, PASSWORD), "staff": _login(staff_email, PASSWORD)}


def test_admin_sees_every_account_and_one_bad_account_does_not_hide_the_others(people, funds_env):
    funds_env.fail["555555555555555"] = meta_ads.MetaAdsError("request_failed", "Meta could not return the requested ad information.")
    response = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert response.status_code == 200, response.text
    body = response.json()
    rows = {row["id"]: row for row in body["accounts"]}
    assert rows["444444444444444"]["fundsMinor"] == 20000
    assert rows["555555555555555"]["error"] and "fundsMinor" not in rows["555555555555555"]
    assert body["cached"] is False and body["truncated"] is False
    assert "secret-token" not in response.text and "secret-app" not in response.text


def test_an_unreadable_answer_becomes_an_error_row_not_a_500(people, funds_env):
    funds_env.fail["444444444444444"] = httpx.DecodingError("bad gzip")
    response = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["accounts"]}
    assert "unreadable" in rows["444444444444444"]["error"] and rows["555555555555555"]["fundsMinor"] == 20000


def test_cache_lifetimes_and_refresh(people, funds_env):
    funds_env.fail["555555555555555"] = meta_ads.MetaAdsError("request_failed", "Meta could not return the requested ad information.")
    first = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert first.status_code == 200 and len(funds_env.calls) == 2
    assert meta_ads._META_FUNDS_CACHE["ttl"] == meta_ads._META_FUNDS_ERROR_TTL_MS      # an account failed: retry soon
    again = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert again.json()["cached"] is True and len(funds_env.calls) == 2
    meta_ads._META_FUNDS_CACHE["at"] -= meta_ads._META_FUNDS_CACHE["ttl"] + 1          # expire it
    funds_env.fail.clear()
    expired = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert expired.json()["cached"] is False and len(funds_env.calls) == 4
    assert meta_ads._META_FUNDS_CACHE["ttl"] == meta_ads._META_FUNDS_TTL_MS            # all clean: five minutes
    fresh = client.post("/api/meta-ads/account-funds/refresh", json={}, cookies=people["admin"])
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["cached"] is False and len(funds_env.calls) == 6


def test_a_meta_pause_keeps_the_last_good_reading_and_stops_the_scan(people, funds_env):
    assert client.get("/api/meta-ads/account-funds", cookies=people["admin"]).status_code == 200
    funds_env.calls.clear()
    pause = meta_ads.MetaAdsError("rate_limited", "Meta is temporarily limiting synchronization. Albayan will retry.", retryable=True)
    funds_env.fail["444444444444444"] = pause
    funds_env.fail["555555555555555"] = pause
    body = client.post("/api/meta-ads/account-funds/refresh", json={}, cookies=people["admin"]).json()
    assert funds_env.calls == ["444444444444444"]            # the second account is not queued behind the pause
    rows = {row["id"]: row for row in body["accounts"]}
    for account_id in ("444444444444444", "555555555555555"):
        assert rows[account_id]["stale"] is True and rows[account_id]["fundsMinor"] == 20000
        assert "temporarily limiting" in rows[account_id]["staleReason"]
    assert meta_ads._META_FUNDS_CACHE["ttl"] == meta_ads._META_FUNDS_ERROR_TTL_MS


def test_without_configured_ids_the_connected_accounts_are_listed_and_capped(people, funds_env, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_AD_ACCOUNT_IDS", "")
    funds_env.listed = [{"id": f"7000000000{i:05d}", "name": f"Listed {i}"} for i in range(27)]
    funds_env.fail["700000000000003"] = meta_ads.MetaAdsError("request_failed", "Meta could not return the requested ad information.")
    body = client.get("/api/meta-ads/account-funds", cookies=people["admin"]).json()
    assert len(body["accounts"]) == meta_ads._META_FUNDS_MAX_ACCOUNTS == 25 and body["truncated"] is True
    failed = next(row for row in body["accounts"] if row["id"] == "700000000000003")
    assert failed["name"] == "Listed 3" and failed["error"]


def test_account_funds_are_admin_only_and_refresh_is_same_origin(people, funds_env):
    assert client.get("/api/meta-ads/account-funds", cookies=people["staff"]).status_code == 403
    assert client.post("/api/meta-ads/account-funds/refresh", json={}, cookies=people["staff"]).status_code == 403
    cross_site = TestClient(app, headers={"Origin": "https://evil.example"})
    assert cross_site.post("/api/meta-ads/account-funds/refresh", json={}, cookies=people["admin"]).status_code == 403
    assert funds_env.calls == []


def test_not_configured_is_a_clear_503(people, funds_env, monkeypatch):
    monkeypatch.setenv("ALBAYAN_META_ACCESS_TOKEN", "")
    response = client.get("/api/meta-ads/account-funds", cookies=people["admin"])
    assert response.status_code == 503 and funds_env.calls == []
