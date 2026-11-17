"""Round 3 (2026-11-17): the text cleaner changed its answer on a second pass.

``sanitize_str`` stripped the edges BEFORE it removed "<" and ">", so "< cpay:x" became " cpay:x"
the first time and "cpay:x" the second. Checks ran on the first result; the writers cleaned again
and stored the second. A read-only reviewer reproduced three ways through that gap:

* a wallet transfer whose idempotency key became a reserved ``cpay:`` key: a campaign withdrawal
  then "released" that transfer and wallet money was created without any staff action;
* a receipt body whose key became ``companyCoveredUSD`` / ``customerOutstandingUSD``: the debt read
  zero and a delivery completed as Paid with nothing collected;
* an ad PATCH whose keys became company-funding and Meta link fields at the next ordinary save.

Run with:
  PYTHONPATH=. pytest server/test_round3_sanitizer_2026_11_17.py -v
"""
import os
import random
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main_module
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(main_module.app, headers={"Origin": "http://testserver"}, client=("192.0.2.94", 50000))
TAG = secrets.token_hex(4)
PASSWORD = "Round3-Cleaner-Password-5519!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)


def _account(label: str, role: str, permissions: dict) -> dict:
    uid, email = new_id("user"), f"r3clean-{label}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": f"R3 {label}", "email": email, "role": role, "perm": json_dumps(permissions), "h": _HASH.hash_hex,
             "s": _HASH.salt_hex, "a": _HASH.algo, "i": _HASH.iterations, "t": now_ms()},
        )
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    return {"id": uid, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    out = {
        "admin": _account("admin", "Admin", {}),
        "staff": _account("staff", "Employee", {"customers": ["view", "add"], "receipts": ["view", "add", "edit"], "ads": ["view", "add", "edit"]}),
        "payer": _account("payer", "Employee", {}),
        "friend": _account("friend", "Employee", {}),
    }
    admin = out["admin"]["cookies"]
    funded = client.post("/api/wallet/top-ups", json={"userId": out["payer"]["id"], "amountMinor": 10000, "currency": "USD",
                                                     "idempotencyKey": f"r3clean-fund-{TAG}", "memo": "test funding"}, cookies=admin)
    assert funded.status_code == 200, funded.text
    customer = client.post("/api/collections/customers", json={"data": {"name": f"R3 Cleaner {TAG}", "phone": "095" + str(secrets.randbelow(10**7)).zfill(7)}}, cookies=admin)
    assert customer.status_code == 200, customer.text
    out["customer"] = customer.json()["id"]
    yield out
    with db_conn() as conn:
        for who in ("admin", "staff", "payer", "friend"):
            conn.execute(text("DELETE FROM sessions WHERE user_id = :u"), {"u": out[who]["id"]})
            conn.execute(text("UPDATE entities SET deleted = true WHERE created_by = :u AND type NOT IN ('walletTransactions')"), {"u": out[who]["id"]})
            conn.execute(text("UPDATE users SET deleted = true WHERE id = :u"), {"u": out[who]["id"]})


def _stored(collection: str, entity_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE type = :t AND id = :i"), {"t": collection, "i": entity_id}).mappings().first()
    return json_loads(row["data_json"])


def _balance(user_id: str) -> int:
    with db_conn() as conn:
        return int(main_module._wallet_balance_minor(conn, user_id, "USD"))


def test_cleaning_twice_gives_the_same_text_as_cleaning_once():
    rng = random.Random(20261117)
    pieces = ["<", ">", " ", "\t", "\n", "\x00", "\ud800", "a", "b", "javascript:", "vbscript:", "cpay:", "x" * 40, "١", "ة", "‏", " ", ":", "_"]
    for _ in range(40000):
        raw = "".join(rng.choice(pieces) for _ in range(rng.randint(0, 9)))
        for limit in (main_module.MAX_INPUT_LENGTH, 100, 12, 3):
            once = main_module.sanitize_str(raw, limit)
            assert main_module.sanitize_str(once, limit) == once, (raw, limit, once)
            assert len(once) <= limit and once == once.strip() and not set(once) & {"<", ">", "\x00"}, (raw, limit, once)
    # The exact shapes that were used.
    assert main_module.sanitize_str("< cpay:camp:2026") == "cpay:camp:2026"
    assert main_module.sanitize_str("x <") == "x" and main_module.sanitize_str("<  <<a") == "a"
    assert main_module.sanitize_str("< javascript:alert(1)") == "" and main_module.sanitize_str("  مرحبا <b> ") == "مرحبا b"


def test_a_field_name_is_stored_exactly_as_sent_or_not_at_all():
    long_name = "companyCoveredUSD" + " " * 83 + "x"  # cut to 100 characters, then stripped, it was the field itself
    cleaned = main_module.sanitize_json({"< companyCoveredUSD": 100, long_name: 5, " metaAdId": "1", "customerDueUSD ": 0,
                                         "notes": "kept", " اللون ": "أحمر", "Red M ": 1, "nested": {"> spentUSD": 9, "ok": 1}})
    assert cleaned == {"notes": "kept", "اللون": "أحمر", "Red M": 1, "nested": {"ok": 1}}
    assert main_module.sanitize_json(cleaned) == cleaned


@pytest.mark.parametrize("prefix", ["cpay", "rel", "stoprefund", "rev", "payreq", "subpay"])
def test_a_reserved_wallet_key_cannot_be_reached_through_the_cleaner(people, prefix):
    """Before: "< cpay:<campaign>:<submittedAt>" passed the reserved-prefix check as " cpay:..." and was
    stored as "cpay:...". The campaign withdrawal then released that transfer as if it were the hold:
    two accounts turned 10,000 into 18,500 and the daily money check reported nothing."""
    payer, friend = people["payer"], people["friend"]
    before = (_balance(payer["id"]), _balance(friend["id"]))
    reserved = main_module._RESERVED_IDEMPOTENCY_PREFIXES
    if f"{prefix}:" not in reserved:
        pytest.skip(f"{prefix}: is not a reserved prefix in this build")
    for key in (f"< {prefix}:campaign-{TAG}:2026-11-17T00:00:00Z", f"> {prefix}:tx-{TAG}-00000001", f" \t<<  {prefix}:x-{TAG}-00000002",
                f"{prefix}:plain-{TAG}-00000003", f"<{prefix}:tight-{TAG}-00000004"):
        refused = client.post("/api/wallet/transfers", json={"toUserId": friend["id"], "amountMinor": 100, "currency": "USD", "idempotencyKey": key},
                              cookies=payer["cookies"])
        assert refused.status_code == 400 and "reserved prefix" in refused.text, (key, refused.status_code, refused.text[:160])
    assert (_balance(payer["id"]), _balance(friend["id"])) == before
    with db_conn() as conn:
        rows = conn.execute(text("SELECT data_json FROM entities WHERE type = 'walletTransactions'")).mappings().all()
    assert not [1 for row in rows if str(json_loads(row["data_json"]).get("idempotencyKey") or "").strip().startswith(f"{prefix}:")
                and json_loads(row["data_json"]).get("type") == "transfer"]


def test_an_ordinary_transfer_still_works_and_replays_once(people):
    payer, friend = people["payer"], people["friend"]
    before = (_balance(payer["id"]), _balance(friend["id"]))
    body = {"toUserId": friend["id"], "amountMinor": 250, "currency": "USD", "idempotencyKey": f"r3clean-ordinary <{TAG}> "}
    first = client.post("/api/wallet/transfers", json=body, cookies=payer["cookies"])
    again = client.post("/api/wallet/transfers", json=body, cookies=payer["cookies"])
    assert first.status_code == 200 and again.status_code == 200, (first.text, again.text)
    assert first.json()["id"] == again.json()["id"]  # before: a key ending in " <" was not recognised on the retry (charged twice)
    assert (_balance(payer["id"]), _balance(friend["id"])) == (before[0] - 250, before[1] + 250)


def test_company_coverage_cannot_be_forged_on_a_receipt_through_a_decorated_key(people):
    """Before: {"< companyCoveredUSD": 100, "< customerOutstandingUSD": 0} was stored as the real fields
    (no coverage record behind them): the debt read zero and the driver completed the job as Paid with
    nothing collected. The plain names were, and are, refused with 405."""
    staff = people["staff"]["cookies"]
    base = {"recordType": "receipt", "customerId": people["customer"], "status": "Not Paid", "isPaid": False, "amountUSD": 100, "amountLocal": 500,
            "exchangeRate": 5, "debtAmountLocal": 500, "debtAmountUSD": 100, "statusDetail": {"notPaidCollection": "office"}}
    long_name = "companyCoveredUSD" + " " * 83 + "x"
    forged = {"< companyCoveredUSD": 100, "< customerOutstandingUSD": 0, long_name: 100}  # the two shapes that got through
    made = client.post("/api/collections/receipts", json={"data": {**base, **forged}}, cookies=staff)
    assert made.status_code in (200, 405), made.text
    receipt = made.json() if made.status_code == 200 else client.post("/api/collections/receipts", json={"data": base}, cookies=staff).json()
    for attempt in (forged, {" companyCoveredUSD": 100}, {"customerOutstandingUSD\t": 0}, {"> companyCoveredUSD ": 100}):
        patched = client.patch(f"/api/collections/receipts/{receipt['id']}", json={"data": {**attempt, "notes": "edited"}}, cookies=staff)
        assert patched.status_code in (200, 405), patched.text
    stored = _stored("receipts", receipt["id"])
    assert not [key for key in stored if "ompanyCovered" in key or "customerOutstanding" in key], sorted(stored)
    assert all(key == key.strip() and "<" not in key for key in stored)
    plain = client.patch(f"/api/collections/receipts/{receipt['id']}", json={"data": {"companyCoveredUSD": 100}}, cookies=staff)
    assert plain.status_code == 405, plain.text


def test_a_key_planted_before_the_fix_is_dropped_by_the_next_save_never_promoted(people):
    """A row may already hold " companyCoveredUSD" from before this fix. The next ordinary save used to
    clean it into the real field; now such a key is dropped."""
    staff = people["staff"]["cookies"]
    made = client.post("/api/collections/receipts", json={"data": {
        "recordType": "receipt", "customerId": people["customer"], "status": "Not Paid", "isPaid": False, "amountUSD": 40, "amountLocal": 200,
        "exchangeRate": 5, "debtAmountLocal": 200, "debtAmountUSD": 40, "statusDetail": {"notPaidCollection": "office"}}}, cookies=staff)
    assert made.status_code == 200, made.text
    receipt_id = made.json()["id"]
    planted = {**_stored("receipts", receipt_id), " companyCoveredUSD": 40, " customerOutstandingUSD": 0}
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = 'receipts' AND id = :i"), {"d": json_dumps(planted), "i": receipt_id})
    edited = client.patch(f"/api/collections/receipts/{receipt_id}", json={"data": {"notes": "an ordinary edit"}}, cookies=staff)
    assert edited.status_code == 200, edited.text
    stored = _stored("receipts", receipt_id)
    assert stored.get("notes") == "an ordinary edit"
    assert "companyCoveredUSD" not in stored and "customerOutstandingUSD" not in stored, sorted(stored)


def test_charge_requests_have_a_daily_cap_per_account(people, monkeypatch):
    """Create, attach a 5 MB photo, cancel, repeat: only OPEN requests were counted (5), cancelled ones
    kept their photo, and every new request loaded all of them. A daily cap now bounds it."""
    import server.wallet_payments as wallet_payments

    monkeypatch.setattr(wallet_payments, "MAX_PAYMENT_REQUESTS_PER_DAY", 3)
    monkeypatch.setattr(wallet_payments, "_rate_limit", lambda *args, **kwargs: None)
    friend = people["friend"]["cookies"]
    methods = client.get("/api/wallet/payment-requests/methods", cookies=friend).json()
    rows = methods.get("methods") if isinstance(methods, dict) else methods
    method = str(rows[0].get("id") or rows[0].get("code"))
    statuses = []
    for index in range(5):
        made = client.post("/api/wallet/payment-requests", json={"amountMinor": 500, "currency": "USD", "method": method,
                                                                 "idempotencyKey": f"r3clean-cap-{TAG}-{index:04d}"}, cookies=friend)
        statuses.append(made.status_code)
        if made.status_code == 200:
            assert client.post(f"/api/wallet/payment-requests/{made.json()['id']}/cancel", cookies=friend).status_code == 200
    assert statuses == [200, 200, 200, 429, 429], statuses
    # A retry of an accepted request is still answered (a replay is not a new request).
    again = client.post("/api/wallet/payment-requests", json={"amountMinor": 500, "currency": "USD", "method": method,
                                                              "idempotencyKey": f"r3clean-cap-{TAG}-0000"}, cookies=friend)
    assert again.status_code == 200, again.text


def test_the_admin_data_scan_reports_traces_of_the_old_gap():
    """The existing read-only scan (GET /api/admin/data-integrity) now names rows that the old gap
    may have left behind, so the owner can see on the live system whether it was ever used."""
    from server.data_integrity import scan_entity_rows

    def row(entity_type: str, entity_id: str, data: dict) -> dict:
        return {"type": entity_type, "id": entity_id, "data_json": json_dumps(data), "deleted": False}

    report = scan_entity_rows([
        row("ads", "ad-planted", {"customerId": "", " companyFundedUSD": 60, "notes": "x"}),
        row("receipts", "receipt-clean", {"customerId": "", "notes": "x", "اللون": "أحمر"}),
        row("walletTransactions", "wt-forged", {"type": "transfer", "idempotencyKey": "cpay:campaign_1:2026-11-01T00:00:00Z", "amountMinor": 8500}),
        row("walletTransactions", "wt-real-hold", {"type": "campaign_payment", "idempotencyKey": "cpay:campaign_1:2026-11-01T00:00:00Z", "amountMinor": 1500}),
        row("walletTransactions", "wt-ordinary", {"type": "transfer", "idempotencyKey": "wallet-transfer-123456", "amountMinor": 100}),
    ])
    found = {(issue["code"], issue["entityId"]) for issue in report["issues"]}
    assert ("decorated_field_name", "ad-planted") in found and ("forged_reserved_wallet_key", "wt-forged") in found
    assert not {entity for _code, entity in found} & {"receipt-clean", "wt-real-hold", "wt-ordinary"}


def test_server_owned_ad_fields_cannot_be_planted_through_the_generic_edit(people):
    """Before: PATCH /api/collections/ads/{id} with "< companyFundedUSD", "< metaAdId" ... stored the keys
    with a leading space, and the next ordinary /api/ads/mutate update rewrote them as the real fields."""
    admin, staff = people["admin"]["cookies"], people["staff"]["cookies"]
    created = client.post("/api/collections/ads", json={"data": {"customerId": people["customer"], "status": "Active", "startDate": "2026-11-01", "notes": "n"}}, cookies=admin)
    assert created.status_code == 200, created.text
    ad_id, version = created.json()["id"], created.json()["lastModified"]
    names = ("companyFundingAllocations", "companyFundedUSD", "customerDueUSD", "metaAdId", "metaCampaignId", "metaSpendMinor")
    forged = {"< companyFundingAllocations": [{"receiptId": "receipt-x", "amountUSD": 60}], "< companyFundedUSD": 60, "< customerDueUSD": 0,
              "< metaAdId": "123456", "< metaCampaignId": "99887766", "< metaSpendMinor": 1, "notes": "x"}
    planted = client.patch(f"/api/collections/ads/{ad_id}", json={"data": forged, "expectedLastModified": version}, cookies=staff)
    assert planted.status_code in (200, 403, 405, 409), planted.text
    stored = _stored("ads", ad_id)
    assert all(key == key.strip() and "<" not in key for key in stored), sorted(stored)
    assert not [name for name in names if name in stored], sorted(stored)
    # A row that already holds such keys from before the fix: the next ordinary save drops them.
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET data_json = :d WHERE type = 'ads' AND id = :i"),
                     {"d": json_dumps({**stored, " metaAdId": "123456", " companyFundedUSD": 60, " customerDueUSD": 0}), "i": ad_id})
    current = client.get(f"/api/collections/ads/{ad_id}", cookies=admin).json()
    edited = client.patch(f"/api/collections/ads/{ad_id}", json={"data": {"notes": "an ordinary edit"}, "expectedLastModified": current["lastModified"]}, cookies=admin)
    assert edited.status_code == 200, edited.text
    after = _stored("ads", ad_id)
    assert after.get("notes") == "an ordinary edit" and not [name for name in names if name in after], sorted(after)
