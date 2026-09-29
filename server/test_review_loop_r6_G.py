"""Review loop round 6, batch G: money repairs that run at EVERY server start.

26/29. The startup debt repair counted only an ad's due rows, not its
       company-covered rows. Company coverage MOVES due rows into
       companyFundingAllocations, so every restart shrank a covered, ad-grown
       In-Shop receipt and the covered share came off the customer's debt a
       second time (or the gross dropped below what the company covered).
27/31. The manual base was frozen at the first "Funding Ad" growth, so a
       later staff raise of the receipt was erased at the next restart and by
       any later save of the ad. Follow-up: a staff change is an ADDED delta,
       not a new absolute base, so a 1-cent form re-save no longer locks the
       ad's growth and a stop still releases the ad's unspent money.
28.    The relink-baseline backfill read a normal mixed paid+debt In-Shop stop
       (live rows on the paid receipt only) as a stale relink and moved the
       debt baseline onto the paid receipt; a later spend correction was a 400.
30.    An anonymous login flood made the limiter evict every non-login bucket
       (ticket and Meta-button quotas, image checks) on every call.
32.    A "NaN" amount in a Funding Ad history row crashed debt reconciliation
       (HTTP 500) and aborted the whole startup repair.

Every repair here runs on each deploy, so each test runs it TWICE and checks
the second run changes nothing.
"""

import json
import os
import secrets
from copy import deepcopy

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.requests import Request

from server import auth_limits
from server import backfills
from server import rate_limiter as _rl
from server import main
from server.db import db_conn, init_db, json_dumps, now_ms
from server.financial_core import _financial_due_total
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.unpaid_receipt_growth import (
    _history_money_minor,
    _manual_debt_target_minor,
    _proven_manual_debt_split_minor,
    repair_legacy_unpaid_receipt_overgrowth,
)

client = TestClient(main.app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r6g-admin-{TAG}@tests.albayanhub.com"
PASSWORD = "ReviewLoopR6g123!Secure"


# ------------------------------------------------------------ history rows

def _growth(frm, to, ad_id="legacy-ad"):
    """The event the SERVER writes when an ad grows/releases the receipt."""
    return {"editedAt": "2026-08-01T00:00:00Z", "editedBy": "System", "changes": [
        {"field": "Amount (USD)", "from": f"${frm:.2f}", "to": f"${to:.2f}"},
        {"field": "Amount (LYD)", "from": f"{frm * 2:.2f} LYD", "to": f"{to * 2:.2f} LYD"},
        {"field": "Funding Ad", "from": "-", "to": ad_id},
    ]}


def _staff_edit(frm, to):
    """The event the receipt form writes when staff change the amount."""
    return {"editedAt": "2026-08-02T00:00:00Z", "editedBy": "Staff", "changes": [
        {"field": "Amount (USD)", "from": f"${frm:.2f}", "to": f"${to:.2f}"},
    ]}


# ------------------------------------------------------------ in-memory startup run

def _receipt_row(rid, amount, history, **extra):
    data = {
        "recordType": "receipt", "status": "Not Paid", "isPaid": False,
        "statusDetail": {"notPaidCollection": "office"}, "deliveryStatus": "Office",
        "receiptType": "", "amountUSD": amount, "amountLocal": amount * 2, "exchangeRate": 2,
        "payments": [], "transfers": [], "editHistory": history, "editCount": len(history),
        "date": "2026-08-01",
    }
    data.update(extra)
    return {"type": "receipts", "id": rid, "data_json": json.dumps(data), "deleted": False,
            "created_at": 1, "created_by": "system", "last_modified": 10}


def _ad_row(ad_id, **data):
    return {"type": "ads", "id": ad_id, "data_json": json.dumps({"recordType": "ad", **data}),
            "deleted": False, "created_at": 1, "created_by": "system", "last_modified": 10}


class _Store:
    """Just enough of the database for repair_legacy_unpaid_receipt_overgrowth."""

    def __init__(self, receipts, ads, closed_periods=()):
        self.rows = {"receipts": {r["id"]: r for r in receipts}, "ads": {a["id"]: a for a in ads}}
        self.closed = set(closed_periods)
        self.writes = 0

    def data(self, rid):
        return json.loads(self.rows["receipts"][rid]["data_json"])

    def run(self):
        def batches(_conn, collection):
            yield list(self.rows[collection].values())

        def lock_row(_conn, collection, entity_id, *, postgres):
            return self.rows[collection].get(entity_id)

        def write_row(_conn, row, data):
            self.writes += 1
            self.rows["receipts"][row["id"]] = {
                **row, "data_json": json.dumps(deepcopy(data)), "last_modified": row["last_modified"] + 1,
            }

        def period_open(collection, data, *, conn):
            if str(data.get("date") or "")[:7] in self.closed:
                raise HTTPException(status_code=423, detail="Financial period is closed")

        ctx = {
            "financial_active_rows": None,
            "financial_active_row_batches": batches,
            "financial_due_total": _financial_due_total,
            "financial_valid_rate": main._financial_valid_rate,
            "financial_row_data": lambda row: json.loads(row.get("data_json") or "{}"),
            "receipt_transfer_fields": main.RECEIPT_TRANSFER_FIELDS,
            "iso_utc": lambda: "2026-09-29T12:00:00Z",
            "sanitize_str": lambda value, limit: str(value)[:limit],
            "assert_financial_period_open": period_open,
            "lock_row": lock_row,
            "write_row": write_row,
            "postgres": False,
        }
        return repair_legacy_unpaid_receipt_overgrowth(object(), ctx=ctx)

    def run_twice(self):
        first = self.run()
        snapshot = json.dumps(self.rows["receipts"], sort_keys=True)
        writes = self.writes
        second = self.run()
        assert second["repaired"] == 0, second
        assert self.writes == writes, "the second startup run rewrote a receipt"
        assert json.dumps(self.rows["receipts"], sort_keys=True) == snapshot
        return first


def _in_shop_ad(ad_id, rid, due=0.0, company=0.0):
    ad = {"paymentStatus": "not_paid", "collectionMethod": "in_shop", "receiptId": rid,
          "receiptAllocations": [], "dueAllocations": [], "companyFundingAllocations": []}
    if due:
        ad["dueAllocations"] = [{"receiptId": rid, "amountUSD": due}]
    if company:
        ad["companyFundingAllocations"] = [{"receiptId": rid, "amountUSD": company}]
    return _ad_row(ad_id, **ad)


# ------------------------------------------------------------ 26 / 29: covered receipts

def test_restart_keeps_a_partly_covered_grown_receipt():
    # $20 manual, grown to $100 by the ad, then the company covered $60:
    # the ad now owes $40 due + $60 company. Before: repaired to $40.
    store = _Store(
        [_receipt_row("cov-part", 100, [_growth(20, 100)], companyCoveredUSD=60, customerOutstandingUSD=40,
                      debtAmountUSD=100, debtAmountLocal=200)],
        [_in_shop_ad("cov-part-ad", "cov-part", due=40, company=60)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 0 and stats["failed"] == 0, stats
    data = store.data("cov-part")
    assert (data["amountUSD"], data["companyCoveredUSD"], data["customerOutstandingUSD"]) == (100, 60, 40)
    assert store.writes == 0


def test_restart_keeps_a_fully_covered_grown_receipt():
    # Everything covered: no due row left. Before: gross $0 next to $100 covered.
    store = _Store(
        [_receipt_row("cov-full", 100, [_growth(0, 100)], companyCoveredUSD=100, customerOutstandingUSD=0)],
        [_in_shop_ad("cov-full-ad", "cov-full", company=100)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 0 and stats["failed"] == 0, stats
    assert store.data("cov-full")["amountUSD"] == 100
    assert store.writes == 0


def test_restart_heals_real_overgrowth_on_a_covered_receipt_once_and_restamps_the_summaries():
    # Legacy overgrowth to $130 while the ad only commits $40 due + $60
    # company. The repair goes to $100 (never below the covered $60) and the
    # customer's outstanding follows the new gross: 100 - 60 = 40.
    store = _Store(
        [_receipt_row("cov-over", 130, [_growth(20, 130)], companyCoveredUSD=60, customerOutstandingUSD=70,
                      debtAmountUSD=130, debtAmountLocal=260)],
        [_in_shop_ad("cov-over-ad", "cov-over", due=40, company=60)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 1 and stats["failed"] == 0, stats
    data = store.data("cov-over")
    assert data["amountUSD"] == 100 and data["amountLocal"] == 200
    assert data["debtAmountUSD"] == 100 and data["debtAmountLocal"] == 200
    assert data["customerOutstandingUSD"] == 40 and data["companyCoveredUSD"] == 60


def test_restart_never_shrinks_below_the_covered_amount_even_without_company_rows():
    # A covered receipt whose company rows are gone (e.g. the covered ad was
    # removed): the gross must still not drop under what the company paid.
    store = _Store(
        [_receipt_row("cov-floor", 100, [_growth(0, 100)], companyCoveredUSD=80, customerOutstandingUSD=20)],
        [_in_shop_ad("cov-floor-ad", "cov-floor", due=10)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 1, stats
    data = store.data("cov-floor")
    assert data["amountUSD"] == 80 and data["customerOutstandingUSD"] == 0


# ------------------------------------------------------------ 27 / 31: staff raise after growth

def test_restart_keeps_a_staff_raise_made_after_growth():
    # $20 -> grown to $100 by the ad -> staff raise to $150 for a new service.
    store = _Store(
        [_receipt_row("raise-hist", 150, [_growth(20, 100), _staff_edit(100, 150)])],
        [_in_shop_ad("raise-hist-ad", "raise-hist", due=100)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 0 and stats["failed"] == 0, stats
    assert store.data("raise-hist")["amountUSD"] == 150


def test_restart_keeps_a_staff_raise_that_wrote_no_history_row():
    # The raise is visible from the server's own chain alone ($100 written,
    # $150 stored), so a client that sent no history row is covered too.
    store = _Store(
        [_receipt_row("raise-bare", 150, [_growth(20, 100)])],
        [_in_shop_ad("raise-bare-ad", "raise-bare", due=100)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 0, stats
    assert store.data("raise-bare")["amountUSD"] == 150


def test_restart_heals_growth_above_a_staff_raise_keeping_the_raise_on_top():
    # Staff raise $100 -> $150 (+$50), then the ad grew it to $200; the ad now
    # needs only $120. The ad's unneeded $80 goes; the staff's +$50 stays on
    # top of what the ad needs: $170.
    store = _Store(
        [_receipt_row("raise-grow", 200, [_growth(20, 100), _staff_edit(100, 150), _growth(150, 200)])],
        [_in_shop_ad("raise-grow-ad", "raise-grow", due=120)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 1, stats
    assert store.data("raise-grow")["amountUSD"] == 170


def test_a_one_cent_resave_locks_only_that_cent():
    # Grown $0 -> $50.52 by the ad; a form re-save stored $50.53; the ad now
    # needs $10. Before: the whole $50.53 became manual debt and stayed.
    store = _Store(
        [_receipt_row("cent", 50.53, [_growth(0, 50.52)])],
        [_in_shop_ad("cent-ad", "cent", due=10)],
    )
    stats = store.run_twice()
    assert stats["repaired"] == 1, stats
    assert store.data("cent")["amountUSD"] == 10.01


def test_manual_split_unit_readings():
    grown = {"editHistory": [_growth(20, 100)]}
    assert _proven_manual_debt_split_minor(grown) == (2000, 0)
    assert _proven_manual_debt_split_minor(grown, 10000) == (2000, 0)
    assert _proven_manual_debt_split_minor(grown, 15000) == (2000, 5000)
    assert _proven_manual_debt_split_minor({"editHistory": [_growth(0, 50.52)]}, 5053) == (0, 1)
    raised = {"editHistory": [_growth(20, 100), _staff_edit(100, 150), _growth(150, 200)]}
    assert _proven_manual_debt_split_minor(raised, 20000) == (2000, 5000)
    # An older release's write below the manual floor erased the raise: the
    # split follows it down instead of re-growing the receipt later.
    erased = {"editHistory": [_growth(20, 100), _growth(150, 20)]}
    assert _proven_manual_debt_split_minor(erased, 2000) == (2000, 0)
    assert _proven_manual_debt_split_minor({"editHistory": [_staff_edit(10, 20)]}, 2000) is None
    # The target: max(first base, ad needs) + staff delta, never above what
    # is stored unless the ads need more, never below what the ads need.
    assert _manual_debt_target_minor(grown, 15000, 6000) == 11000
    assert _manual_debt_target_minor(grown, 15000, 13000) == 15000
    assert _manual_debt_target_minor(grown, 15000, 20000) == 20000
    assert _manual_debt_target_minor({"editHistory": [_growth(20, 20)]}, 1500, 1000) == 1500
    assert _manual_debt_target_minor({"editHistory": []}, 1500, 1000) == 1500


# ------------------------------------------------------------ 32: NaN history amount

@pytest.mark.parametrize("raw", ["NaN", "nan", "-NaN", "$NaN", "$nan", "sNaN", "Infinity", "1e999999"])
def test_non_finite_history_amounts_read_as_unknown(raw):
    assert _history_money_minor(raw) is None


def test_history_amount_parsing_is_unchanged_for_real_amounts():
    assert _history_money_minor("$20.00") == 2000
    assert _history_money_minor("1,234.565") == 123457
    assert _history_money_minor("-$1.00") is None


def test_a_nan_history_row_skips_only_its_own_receipt():
    nan_event = _growth(0, 40)
    nan_event["changes"][0]["from"] = "NaN"
    store = _Store(
        [_receipt_row("nan-good", 50, [_growth(10, 50)]), _receipt_row("nan-bad", 40, [nan_event])],
        [_in_shop_ad("nan-good-ad", "nan-good", due=30), _in_shop_ad("nan-bad-ad", "nan-bad", due=5)],
    )
    stats = store.run_twice()   # before: ValueError -> "discovery failed", nothing repaired
    assert stats["repaired"] == 1 and stats["failed"] == 0, stats
    assert store.data("nan-good")["amountUSD"] == 30
    assert store.data("nan-bad")["amountUSD"] == 40


def test_a_settled_grown_receipt_is_skipped_not_failed_on_every_boot():
    store = _Store(
        [_receipt_row("settled-grown", 40, [_growth(20, 100)], status="Paid", isPaid=True,
                      companyCoveredUSD=60, customerOutstandingUSD=0)],
        [_in_shop_ad("settled-grown-ad", "settled-grown", company=60)],
    )
    stats = store.run_twice()
    assert stats["failed"] == 0 and stats["repaired"] == 0 and stats["skipped"] == 1, stats


# ------------------------------------------------------------ closed month

def test_restart_never_rewrites_a_receipt_in_a_closed_month():
    store = _Store(
        [_receipt_row("closed-over", 130, [_growth(20, 130)], date="2026-07-15")],
        [_in_shop_ad("closed-over-ad", "closed-over", due=40)],
        closed_periods={"2026-07"},
    )
    first = store.run()
    second = store.run()
    assert first["repaired"] == second["repaired"] == 0
    assert store.writes == 0
    assert store.data("closed-over")["amountUSD"] == 130


# ------------------------------------------------------------ API fixtures

def _seed_admin() -> None:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,'Admin',"
                 ":perms,:hash,:salt,:algo,:iter,false,:now,NULL,:now)"),
            {"id": new_id("user"), "name": "r6g admin", "email": ADMIN_EMAIL, "perms": json_dumps({}),
             "hash": pw.hash_hex, "salt": pw.salt_hex, "algo": pw.algo, "iter": pw.iterations, "now": now_ms()},
        )


@pytest.fixture(scope="module")
def admin():
    init_db()
    _seed_admin()
    r = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    client.cookies.clear()
    return cookies


def _create(collection, entity_id, data, cookies):
    r = client.post(f"/api/collections/{collection}", json={"id": entity_id, "data": data}, cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _entity(collection, entity_id, cookies):
    r = client.get(f"/api/collections/{collection}/{entity_id}", cookies=cookies)
    assert r.status_code == 200, r.text
    return r.json()


def _customer(cid, cookies):
    return _create("customers", cid, {"name": cid, "phones": [f"09{secrets.randbelow(10**8):08d}"]}, cookies)


def _unpaid(rid, cid, amount, cookies):
    return _create("receipts", rid, {
        "recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5,
        "exchangeRate": 5, "status": "Not Paid", "isPaid": False, "deliveryStatus": "Office",
        "statusDetail": {"notPaidCollection": "office"},
    }, cookies)


def _paid(rid, cid, amount, cookies):
    return _create("receipts", rid, {
        "recordType": "receipt", "customerId": cid, "amountUSD": amount, "amountLocal": amount * 5,
        "exchangeRate": 5, "status": "Paid", "isPaid": True,
    }, cookies)


def _mutate(ad_id, key, data, cookies, **extra):
    return client.post("/api/ads/mutate", json={
        "action": "create", "adId": ad_id, "idempotencyKey": key, "data": data, **extra,
    }, cookies=cookies)


def _in_shop_data(cid, rid, due, *, paid_rid=None, paid=0, growth=None, expected=None):
    data = {
        "customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5,
        "receiptId": rid, "receiptAllocations": [], "mergedPaidAllocations": [],
        "dueAllocations": [{"receiptId": rid, "amountUSD": due}],
    }
    if paid_rid:
        data["receiptAllocations"] = [{"receiptId": paid_rid, "amountUSD": paid}]
    if growth is not None:
        data["unpaidReceiptDebtIncrease"] = {"receiptId": rid, "amountUSD": growth, "expectedLastModified": expected}
    return data


def _grow_to_100(tag, cookies):
    """Customer + $20 unpaid office receipt grown to $100 by an In-Shop ad."""
    cid, rid, aid = f"r6g_c_{tag}_{TAG}", f"r6g_r_{tag}_{TAG}", f"r6g_a_{tag}_{TAG}"
    _customer(cid, cookies)
    receipt = _unpaid(rid, cid, 20, cookies)
    r = _mutate(aid, f"r6g-{tag}-create-{TAG}",
                _in_shop_data(cid, rid, 100, growth=80, expected=receipt["lastModified"]), cookies)
    assert r.status_code == 200, r.text
    grown = _entity("receipts", rid, cookies)["data"]
    assert grown["amountUSD"] == 100
    assert any(c.get("field") == "Funding Ad" for e in grown["editHistory"] for c in e["changes"])
    return cid, rid, aid, r.json()["ad"]


def _stored_receipt(rid):
    with db_conn() as conn:
        return conn.execute(
            text("SELECT data_json,last_modified FROM entities WHERE type='receipts' AND id=:id"), {"id": rid},
        ).mappings().first()


def _run_startup_repair_twice(rid):
    first = main.backfill_repair_legacy_unpaid_receipt_overgrowth()
    before = _stored_receipt(rid)
    second = main.backfill_repair_legacy_unpaid_receipt_overgrowth()
    after = _stored_receipt(rid)
    assert after["last_modified"] == before["last_modified"]
    assert after["data_json"] == before["data_json"]
    return first, second


# ------------------------------------------------------------ API: 26 / 29

def test_api_restart_keeps_a_covered_grown_receipt_settleable(admin):
    _cid, rid, _aid, _ad = _grow_to_100("cover", admin)
    receipt = _entity("receipts", rid, admin)
    cover = client.post(f"/api/receipts/{rid}/company-coverages", json={
        "amountMinorUSD": 6000, "idempotencyKey": f"r6g-cover-{TAG}",
        "expectedLastModified": receipt["lastModified"], "reason": "Review loop r6 coverage",
    }, cookies=admin)
    assert cover.status_code == 200, cover.text
    covered = _stored_receipt(rid)

    _run_startup_repair_twice(rid)

    after = _stored_receipt(rid)
    assert after["last_modified"] == covered["last_modified"], "startup rewrote the covered receipt"
    data = json.loads(after["data_json"])
    assert data["amountUSD"] == 100 and data["companyCoveredUSD"] == 60   # before: amountUSD 40
    assert data["customerOutstandingUSD"] == 40

    # The customer's $40 settles the receipt (before: 409, capacity below committed).
    settled = client.post(f"/api/receipts/{rid}/settle", json={
        "idempotencyKey": f"r6g-cover-settle-{TAG}", "expectedLastModified": after["last_modified"],
        "data": {"isPaid": True, "status": "Paid", "deliveryStatus": "Office", "amountUSD": 40,
                 "amountLocal": 200, "collectionDate": "2026-09-29T10:00:00Z"},
    }, cookies=admin)
    assert settled.status_code == 200, settled.text


# ------------------------------------------------------------ API: 27 / 31

@pytest.mark.parametrize("with_history", [True, False], ids=["form-history", "no-history"])
def test_api_staff_raise_after_growth_survives_restart_and_ad_saves(admin, with_history):
    tag = "raise" + ("h" if with_history else "n")
    _cid, rid, aid, ad = _grow_to_100(tag, admin)
    receipt = _entity("receipts", rid, admin)
    data = dict(receipt["data"])
    data.update({"amountUSD": 150, "amountLocal": 750})
    if with_history:
        history = list(data.get("editHistory") or []) + [_staff_edit(100, 150)]
        data.update({"editHistory": history, "editCount": len(history)})
    patched = client.patch(f"/api/collections/receipts/{rid}", json={
        "data": data, "expectedLastModified": receipt["lastModified"],
    }, cookies=admin)
    assert patched.status_code == 200, patched.text
    raised = _stored_receipt(rid)

    _run_startup_repair_twice(rid)
    after = _stored_receipt(rid)
    assert after["last_modified"] == raised["last_modified"]
    assert json.loads(after["data_json"])["amountUSD"] == 150   # before: shrunk to $100

    # An unrelated save of the ad must not release the staff's $50 either.
    ad_data = {k: v for k, v in ad["data"].items() if not k.startswith("_")}
    ad_data["notes"] = "renamed by staff"
    saved = _mutate(aid, f"r6g-{tag}-update-{TAG}", ad_data, admin,
                    action="update", expectedLastModified=ad["lastModified"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["updatedReceipts"] == []
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 150


def _staff_set_amount(rid, amount, cookies):
    receipt = _entity("receipts", rid, cookies)
    data = dict(receipt["data"])
    data.update({"amountUSD": amount, "amountLocal": round(amount * 5, 2)})
    patched = client.patch(f"/api/collections/receipts/{rid}", json={
        "data": data, "expectedLastModified": receipt["lastModified"],
    }, cookies=cookies)
    assert patched.status_code == 200, patched.text
    return patched.json()


def _stop(aid, spent_minor, ad_last_modified, key, cookies):
    stopped = client.post(f"/api/ads/{aid}/stop", json={
        "spentMinorUSD": spent_minor, "customerInformed": True, "idempotencyKey": key,
        "expectedLastModified": ad_last_modified,
    }, cookies=cookies)
    assert stopped.status_code == 200, stopped.text
    return stopped.json()["ad"]


def test_api_a_one_cent_resave_then_stop_releases_the_unspent_ad_money(admin):
    # Grown $0 -> $50.52; the receipt form's rounding re-saves it as $50.53.
    # Stopping the ad at $10 must release the ad's unspent money: the
    # customer owes $10 + the stray cent, not $50.53.
    cid, rid, aid = f"r6g_c_cent_{TAG}", f"r6g_r_cent_{TAG}", f"r6g_a_cent_{TAG}"
    _customer(cid, admin)
    receipt = _unpaid(rid, cid, 0, admin)
    created = _mutate(aid, f"r6g-cent-create-{TAG}",
                      _in_shop_data(cid, rid, 50.52, growth=50.52, expected=receipt["lastModified"]), admin)
    assert created.status_code == 200, created.text
    _staff_set_amount(rid, 50.53, admin)

    _stop(aid, 1000, created.json()["ad"]["lastModified"], f"r6g-cent-stop-{TAG}", admin)
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 10.01   # before: 50.53

    stopped = _stored_receipt(rid)
    _run_startup_repair_twice(rid)
    assert _stored_receipt(rid)["last_modified"] == stopped["last_modified"]


def test_api_staff_raise_then_stop_keeps_only_the_staff_raise(admin):
    # $20 grown to $100 by the ad, staff +$50 for another service -> $150.
    # A stop at $60 releases the ad's unspent $40 and keeps the staff's $50.
    _cid, rid, aid, ad = _grow_to_100("raisestop", admin)
    _staff_set_amount(rid, 150, admin)

    _stop(aid, 6000, ad["lastModified"], f"r6g-raisestop-stop-{TAG}", admin)
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 110   # before: 150

    stopped = _stored_receipt(rid)
    _run_startup_repair_twice(rid)
    assert _stored_receipt(rid)["last_modified"] == stopped["last_modified"]


def test_api_ad_growth_after_a_staff_raise_still_matches_the_form_instruction(admin):
    # The ad form treats the staff's +$50 as free room on the receipt: using
    # it needs no growth, and growing past it asks for exactly the shortfall.
    _cid, rid, aid, ad = _grow_to_100("raisegrow", admin)
    _staff_set_amount(rid, 150, admin)
    ad_data = {k: v for k, v in ad["data"].items() if not k.startswith("_")}

    ad_data["dueAllocations"] = [{"receiptId": rid, "amountUSD": 130}]
    saved = _mutate(aid, f"r6g-raisegrow-130-{TAG}", ad_data, admin,
                    action="update", expectedLastModified=ad["lastModified"])
    assert saved.status_code == 200, saved.text
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 150

    receipt = _entity("receipts", rid, admin)
    ad_data = {k: v for k, v in saved.json()["ad"]["data"].items() if not k.startswith("_")}
    ad_data["dueAllocations"] = [{"receiptId": rid, "amountUSD": 200}]
    ad_data["unpaidReceiptDebtIncrease"] = {
        "receiptId": rid, "amountUSD": 50, "expectedLastModified": receipt["lastModified"],
    }
    grown = _mutate(aid, f"r6g-raisegrow-200-{TAG}", ad_data, admin,
                    action="update", expectedLastModified=saved.json()["ad"]["lastModified"])
    assert grown.status_code == 200, grown.text
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 200

    # The ad then spends only $60: its unspent money goes, the staff's $50 stays.
    _stop(aid, 6000, grown.json()["ad"]["lastModified"], f"r6g-raisegrow-stop-{TAG}", admin)
    assert _entity("receipts", rid, admin)["data"]["amountUSD"] == 110   # before: 150


# ------------------------------------------------------------ API: 32

def test_api_ad_save_with_a_nan_history_receipt_is_not_a_500(admin):
    _cid, rid, aid, ad = _grow_to_100("nan", admin)
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json,last_modified FROM entities WHERE type='receipts' AND id=:id"),
                           {"id": rid}).mappings().first()
        stored = json.loads(row["data_json"])
        stored["editHistory"][0]["changes"][0]["from"] = "NaN"
        modified = int(row["last_modified"]) + 1
        stored["_lastModified"] = modified
        conn.execute(text("UPDATE entities SET data_json=:d,last_modified=:m WHERE type='receipts' AND id=:id"),
                     {"d": json_dumps(stored), "m": modified, "id": rid})
    ad_data = {k: v for k, v in ad["data"].items() if not k.startswith("_")}
    ad_data["dueAllocations"] = [{"receiptId": rid, "amountUSD": 60}]
    saved = _mutate(aid, f"r6g-nan-update-{TAG}", ad_data, admin,
                    action="update", expectedLastModified=ad["lastModified"])
    assert saved.status_code == 200, saved.text   # before: 500 ValueError
    stats = main.backfill_repair_legacy_unpaid_receipt_overgrowth()
    assert stats["failed"] == 0, stats


# ------------------------------------------------------------ API: closed month

def test_api_restart_never_rewrites_a_receipt_in_a_closed_month(admin):
    rid, aid, period = f"r6g_closed_r_{TAG}", f"r6g_closed_a_{TAG}", "2011-07"
    close_id = f"financial-close-{period}"
    now = now_ms()
    receipt = {
        "id": rid, "recordType": "receipt", "customerId": f"r6g_closed_c_{TAG}", "status": "Not Paid",
        "isPaid": False, "statusDetail": {"notPaidCollection": "office"}, "deliveryStatus": "Office",
        "amountUSD": 130, "amountLocal": 650, "exchangeRate": 5, "date": f"{period}-15",
        "editHistory": [_growth(20, 130)], "editCount": 1, "_created": now, "_lastModified": now,
    }
    ad = {"id": aid, "recordType": "ad", "customerId": receipt["customerId"], "paymentStatus": "not_paid",
          "collectionMethod": "in_shop", "receiptId": rid, "startDate": f"{period}-15",
          "dueAllocations": [{"receiptId": rid, "amountUSD": 40}], "_created": now, "_lastModified": now}
    insert = text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                  "VALUES (:type,:id,:data,false,:now,NULL,:now)")
    try:
        with db_conn() as conn:
            conn.execute(insert, {"type": "receipts", "id": rid, "data": json_dumps(receipt), "now": now})
            conn.execute(insert, {"type": "ads", "id": aid, "data": json_dumps(ad), "now": now})
            conn.execute(insert, {"type": "financialClosures", "id": close_id,
                                  "data": json_dumps({"id": close_id, "period": period, "status": "closed"}),
                                  "now": now})
        before = _stored_receipt(rid)
        main.backfill_repair_legacy_unpaid_receipt_overgrowth()
        main.backfill_repair_legacy_unpaid_receipt_overgrowth()
        after = _stored_receipt(rid)
        assert after["last_modified"] == before["last_modified"]
        assert after["data_json"] == before["data_json"]
    finally:
        with db_conn() as conn:
            for kind, entity_id in (("receipts", rid), ("ads", aid), ("financialClosures", close_id)):
                conn.execute(text("DELETE FROM entities WHERE type=:t AND id=:id"), {"t": kind, "id": entity_id})


# ------------------------------------------------------------ 28: relink-baseline backfill

def test_api_mixed_paid_and_debt_stop_keeps_its_debt_baseline_across_restarts(admin):
    cid, pid, uid, aid = (f"r6g_mx_{x}_{TAG}" for x in ("c", "p", "u", "a"))
    _customer(cid, admin)
    _paid(pid, cid, 50, admin)
    unpaid = _unpaid(uid, cid, 0, admin)
    created = _mutate(aid, f"r6g-mixed-create-{TAG}", _in_shop_data(
        cid, uid, 50, paid_rid=pid, paid=50, growth=50, expected=unpaid["lastModified"]), admin)
    assert created.status_code == 200, created.text

    stopped = client.post(f"/api/ads/{aid}/stop", json={
        "spentMinorUSD": 4500, "customerInformed": True, "idempotencyKey": f"r6g-mixed-stop-{TAG}",
        "expectedLastModified": created.json()["ad"]["lastModified"],
    }, cookies=admin)
    assert stopped.status_code == 200, stopped.text
    stopped_ad = stopped.json()["ad"]
    assert stopped_ad["data"]["receiptAllocations"] == [{"receiptId": pid, "amountUSD": 45}]
    assert stopped_ad["data"]["dueAllocations"] == []
    assert stopped_ad["data"]["stopAllocationBaseline"]["due"] == [{"receiptId": uid, "amountUSD": 50}]

    backfills.backfill_relink_baselines()
    backfills.backfill_relink_baselines()
    after = _entity("ads", aid, admin)
    assert after["lastModified"] == stopped_ad["lastModified"], "the backfill rewrote a live mixed stop"
    assert after["data"]["stopAllocationBaseline"]["due"] == [{"receiptId": uid, "amountUSD": 50}]

    # Meta's final spend is $55: the extra $5 is debt on U (before: 400,
    # "In Shop debt must use one linked unpaid receipt").
    restopped = client.post(f"/api/ads/{aid}/stop", json={
        "spentMinorUSD": 5500, "customerInformed": True, "idempotencyKey": f"r6g-mixed-restop-{TAG}",
        "expectedLastModified": after["lastModified"],
    }, cookies=admin)
    assert restopped.status_code == 200, restopped.text
    assert restopped.json()["ad"]["data"]["dueAllocations"] == [{"receiptId": uid, "amountUSD": 5}]
    assert _entity("receipts", uid, admin)["data"]["amountUSD"] == 5


def test_relink_backfill_still_retargets_a_truly_vacated_receipt_once():
    ad = {"receiptAllocations": [{"receiptId": "R", "amountUSD": 50}], "dueAllocations": [],
          "receiptId": "R", "fundingReceiptId": "R", "paymentStatus": "paid",
          "stopAllocationBaseline": {"receipt": [{"receiptId": "X", "amountUSD": 50}], "due": []}}
    assert backfills._retarget_relink_data(ad) is True
    assert ad["stopAllocationBaseline"]["receipt"] == [{"receiptId": "R", "amountUSD": 50}]
    assert backfills._retarget_relink_data(ad) is False


def test_relink_backfill_keeps_baselines_on_linked_and_covered_receipts():
    base = {"receipt": [{"receiptId": "P", "amountUSD": 50}], "due": [{"receiptId": "U", "amountUSD": 50}]}
    covered = {"receiptAllocations": [{"receiptId": "P", "amountUSD": 45}], "dueAllocations": [],
               "companyFundingAllocations": [{"receiptId": "U", "amountUSD": 10}], "receiptId": "",
               "stopAllocationBaseline": deepcopy(base)}
    assert backfills._retarget_relink_data(covered) is False
    driver = {"receiptAllocations": [], "mergedPaidAllocations": [{"receiptId": "P", "amountUSD": 45}],
              "dueAllocations": [], "linkedDeliveryReceiptId": "D", "receiptId": "D",
              "stopAllocationBaseline": {"receipt": [{"receiptId": "P", "amountUSD": 50}],
                                         "due": [{"receiptId": "D", "amountUSD": 50}],
                                         "dueLegacyReceiptId": "D"}}
    assert backfills._retarget_relink_data(driver) is False
    assert driver["stopAllocationBaseline"]["due"] == [{"receiptId": "D", "amountUSD": 50}]


# ------------------------------------------------------------ 30: limiter flood

@pytest.fixture
def small_store(monkeypatch):
    monkeypatch.setattr(_rl, "_REDIS_ENABLED", False)
    monkeypatch.setattr(_rl, "_MEMORY_STORE", {})
    monkeypatch.setattr(_rl, "_MEMORY_WINDOWS", {})
    monkeypatch.setattr(_rl, "_MEMORY_LIMITS", {}, raising=False)
    monkeypatch.setattr(_rl, "_MAX_MEMORY_STORE_KEYS", 200)
    monkeypatch.setattr(_rl, "_LAST_CLEANUP", 0)
    yield


HOUR, FIFTEEN = 3_600_000, 15 * 60 * 1000


def test_a_login_flood_does_not_switch_off_other_quotas(small_store):
    for _ in range(3):
        assert _rl.check_rate_limit("studio:ticket-create:u1", 3, HOUR)[0]
    assert not _rl.check_rate_limit("studio:ticket-create:u1", 3, HOUR)[0]
    assert _rl.check_rate_limit("studio:tiktok-request:u1", 3, HOUR)[0]   # 1 of 3 used

    for i in range(_rl._MAX_MEMORY_STORE_KEYS + 150):
        _rl.check_rate_limit(f"login:9.9.9.9|junk{i}@x.tld", 20, FIFTEEN)

    assert not _rl.check_rate_limit("studio:ticket-create:u1", 3, HOUR)[0], "the flood reopened a spent quota"
    assert _rl.get_rate_limit_status("studio:tiktok-request:u1", HOUR) == 1, "the flood dropped a live quota"
    assert len(_rl._MEMORY_STORE) <= _rl._MAX_MEMORY_STORE_KEYS + 1


def test_a_flood_still_cannot_wash_out_a_login_lockout(small_store):
    victim = "login:1.2.3.4|owner@albayanhub.com"
    for _ in range(20):
        _rl.check_rate_limit(victim, 20, FIFTEEN)
    for i in range(_rl._MAX_MEMORY_STORE_KEYS + 150):
        _rl.check_rate_limit(f"studio:image-check:u{i}", 24, 60_000)
    assert not _rl.check_rate_limit(victim, 20, FIFTEEN)[0]


def _request(peer):
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [],
                    "client": (peer, 12345), "server": ("testserver", 80), "scheme": "http"})


def test_a_blocked_address_mints_no_new_login_buckets(small_store, monkeypatch):
    monkeypatch.setattr(_rl, "_MAX_MEMORY_STORE_KEYS", 10_000)   # no eviction noise in the count
    ip = "203.0.113.66"
    for i in range(auth_limits._LOGIN_IP_MAX_ATTEMPTS):
        assert auth_limits._rate_check(_request(ip), f"r6g-flood-{i}@x.tld")[0]
    size = len(_rl._MEMORY_STORE)
    for i in range(40):
        allowed, wait = auth_limits._rate_check(_request(ip), f"r6g-flood-more-{i}@x.tld")
        assert allowed is False and wait > 0
    assert len(_rl._MEMORY_STORE) == size   # before: +2 keys per blocked request
    assert not any("flood-more" in key for key in _rl._MEMORY_STORE)


def test_a_locked_account_retry_does_not_spend_the_address_allowance(small_store):
    ip, email = "203.0.113.67", "r6g-locked@x.tld"
    for _ in range(auth_limits._LOGIN_MAX_ATTEMPTS):
        assert auth_limits._rate_check(_request(ip), email)[0]
    spent = _rl.get_rate_limit_status(f"login:ip:{ip}", auth_limits._LOGIN_WINDOW_MS)
    for _ in range(10):
        assert auth_limits._rate_check(_request(ip), email)[0] is False
    assert _rl.get_rate_limit_status(f"login:ip:{ip}", auth_limits._LOGIN_WINDOW_MS) == spent
