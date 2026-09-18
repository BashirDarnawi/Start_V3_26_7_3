"""Customer merge locks in the canonical money order and never loads unlinked photos.

Before 2026-09-18 the merge locked the two customers FIRST and then updated
receipts/ads late, the mirror image of every money path (receipts -> ads ->
customers) - a deadlock on PostgreSQL - and it parsed every receipt/ad row
including base64 photos. Disposable local records only.
"""

import secrets
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event, text

import server.main as main_module
from server.db import db_conn, get_engine, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.schemas import CustomerMergeRequest
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

client = TestClient(app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"merge-order-admin-{TAG}@tests.albayanhub.com"
ADMIN_PASSWORD = "MergeOrderAdmin123!"


def _insert_entity(collection, entity_id, data, creator_id, *, deleted=False):
    stamp = now_ms()
    payload = dict(data)
    payload.update({"id": entity_id, "_created": stamp, "_lastModified": stamp,
                    "_deleted": bool(deleted), "createdBy": creator_id})
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,:deleted,:created,:creator,:modified)"),
            {"type": collection, "id": entity_id, "data": json_dumps(payload), "deleted": bool(deleted),
             "created": stamp, "creator": creator_id, "modified": stamp},
        )
    return stamp


@pytest.fixture(scope="module")
def actors():
    init_db()
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    admin_id = new_id("mo_admin")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,'Merge Order Admin',:email,'Admin',:permissions,:password_hash,:password_salt,"
                 ":password_algo,:password_iterations,false,:created_at,NULL,:last_modified)"),
            {"id": admin_id, "email": ADMIN_EMAIL, "permissions": json_dumps({}),
             "password_hash": password.hash_hex, "password_salt": password.salt_hex,
             "password_algo": password.algo, "password_iterations": password.iterations,
             "created_at": stamp, "last_modified": stamp},
        )
    login = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert login.status_code == 200, login.text
    admin = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()
    yield {"admin": admin, "admin_id": admin_id, "actor": {"id": admin_id, "role": "Admin"}}


def _seed_pair(actors, tag, *, shared):
    keep_id, dup_id = new_id(f"{tag}_keep"), new_id(f"{tag}_dup")
    keep_v = _insert_entity("customers", keep_id, {"name": "Keep", "phones": [shared]}, actors["admin_id"])
    dup_v = _insert_entity("customers", dup_id, {"name": "Dup", "phones": [shared, "0921112233"]}, actors["admin_id"])
    return keep_id, dup_id, keep_v, dup_v


def _operation(keep_id, dup_id, keep_v, dup_v):
    return {"keepCustomerId": keep_id, "duplicateCustomerId": dup_id,
            "expectedKeepLastModified": keep_v, "expectedDuplicateLastModified": dup_v,
            "idempotencyKey": f"merge-{new_id('op')}"}


def _rows_referencing(customer_id):
    with db_conn() as conn:
        rows = conn.execute(text("SELECT type,id,data_json,deleted FROM entities "
                                 "WHERE type IN ('pages','receipts','ads')")).mappings().all()
    hits = []
    for row in rows:
        data = json_loads(row["data_json"]) or {}
        _r, changed = main_module._rewrite_customer_references(data, customer_id, "__probe__")
        if changed:
            hits.append((row["type"], row["id"]))
    return hits


LOCK_SHAPE = "SELECT type, id, data_json, deleted, created_at, created_by, last_modified FROM entities WHERE type=:type AND id=:id LIMIT 1"
RANK = {"receipts": 0, "ads": 1, "pages": 2, "customers": 3}


def _record_locks(engine):
    """Record the row-lock-shaped reads (FOR UPDATE on PostgreSQL) in order."""
    locks: list[tuple[str, str]] = []

    def record(conn, clauseelement, multiparams, params, execution_options):
        statement = str(clauseelement)
        p = (multiparams[0] if multiparams else params) or {}
        if statement.strip().startswith(LOCK_SHAPE) and isinstance(p, dict) and p.get("type") in RANK:
            locks.append((p["type"], p["id"]))

    event.listen(engine, "before_execute", record)
    return locks, lambda: event.remove(engine, "before_execute", record)


def test_merge_moves_links_conserves_money_and_replays(actors):
    keep_id, dup_id, keep_v, dup_v = _seed_pair(actors, "mo_i", shared="0918887766")
    other_id = new_id("mo_other")
    _insert_entity("customers", other_id, {"name": "Other", "phones": ["0930000000"]}, actors["admin_id"])
    page_id, r1, r2, r3, ad1, ad2, dead_ad = (new_id(x) for x in ("mo_page", "mo_r1", "mo_r2", "mo_r3", "mo_ad1", "mo_ad2", "mo_deadad"))
    _insert_entity("pages", page_id, {"name": "P", "customerIds": [keep_id, dup_id], "linkedCustomerIds": [dup_id]}, actors["admin_id"])
    _insert_entity("receipts", r1, {"customerId": dup_id, "amountUSD": 100, "status": "Paid"}, actors["admin_id"])
    _insert_entity("receipts", r2, {"customerId": keep_id, "amountUSD": 40, "status": "Paid"}, actors["admin_id"])
    _insert_entity("receipts", r3, {"customerId": other_id, "amountUSD": 7, "status": "Paid",
                                    "transfers": [{"toCustomerId": dup_id, "amountUSD": 3}]}, actors["admin_id"])
    _insert_entity("ads", ad1, {"customerId": dup_id, "customer": dup_id, "amountUSD": 25}, actors["admin_id"])
    _insert_entity("ads", ad2, {"customerId": other_id, "amountUSD": 5}, actors["admin_id"])
    _insert_entity("ads", dead_ad, {"customerId": dup_id, "adPhotos": ["data:image/png;base64,SktM"]}, actors["admin_id"], deleted=True)

    def money_by_customer():
        with db_conn() as conn:
            rows = conn.execute(text("SELECT type,data_json FROM entities WHERE type IN ('receipts','ads') AND deleted=false "
                                     "AND id IN (:a,:b,:c,:d,:e)"),
                                {"a": r1, "b": r2, "c": r3, "d": ad1, "e": ad2}).mappings().all()
        totals: dict[str, int] = {}
        for row in rows:
            d = json_loads(row["data_json"]) or {}
            totals[d.get("customerId")] = totals.get(d.get("customerId"), 0) + int(d.get("amountUSD") or 0)
        return totals

    before = money_by_customer()
    assert before[dup_id] == 125 and before[keep_id] == 40 and before[other_id] == 12

    op = _operation(keep_id, dup_id, keep_v, dup_v)
    merged = client.post("/api/customers/merge", cookies=actors["admin"], json=op)
    assert merged.status_code == 200, merged.text
    body = merged.json()
    assert body["replayed"] is False
    assert body["customer"]["data"]["phones"] == ["0918887766", "0921112233"]
    assert body["duplicate"]["deleted"] is True
    assert body["duplicate"]["data"]["mergedIntoCustomerId"] == keep_id
    assert {p["id"] for p in body["updatedPages"]} == {page_id}
    assert body["updatedPages"][0]["data"]["customerIds"] == [keep_id]
    assert {r["id"] for r in body["updatedReceipts"]} == {r1, r3}
    assert {a["id"] for a in body["updatedAds"]} == {ad1, dead_ad}
    r3_after = next(r for r in body["updatedReceipts"] if r["id"] == r3)
    assert r3_after["data"]["customerId"] == other_id
    assert r3_after["data"]["transfers"][0]["toCustomerId"] == keep_id

    after = money_by_customer()
    assert dup_id not in after
    assert after[keep_id] == 165 and after[other_id] == 12
    assert _rows_referencing(dup_id) == []

    replay = client.post("/api/customers/merge", cookies=actors["admin"], json=op)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert {r["id"] for r in replay.json()["updatedReceipts"]} == {r1, r3}

    again = client.post("/api/customers/merge", cookies=actors["admin"], json=_operation(keep_id, dup_id, keep_v, dup_v))
    assert again.status_code == 404 and "Customer not found" in again.text

    # A stale version still fails fast, before any row lock.
    k2, d2, kv2, dv2 = _seed_pair(actors, "mo_stale", shared="0919990000")
    locks, stop = _record_locks(get_engine())
    try:
        stale = client.post("/api/customers/merge", cookies=actors["admin"],
                            json={**_operation(k2, d2, kv2, dv2), "expectedKeepLastModified": kv2 + 1})
    finally:
        stop()
    assert stale.status_code == 409 and "customer to keep has changed" in stale.text
    assert locks == []


UNLINKED_MARK = "UNLINKEDPHOTO" * 64
LINKED_MARK = "LINKEDPHOTO" * 64


def test_merge_loads_no_unlinked_photos_and_keeps_linked_ones(actors, monkeypatch):
    keep_id, dup_id, keep_v, dup_v = _seed_pair(actors, "mo_photo", shared="0917770000")
    stranger = new_id("mo_stranger")
    _insert_entity("customers", stranger, {"name": "S", "phones": ["0940000000"]}, actors["admin_id"])
    _insert_entity("receipts", new_id("mo_unlinked"), {"customerId": stranger, "amountUSD": 1,
                   "photos": ["data:image/png;base64," + UNLINKED_MARK]}, actors["admin_id"])
    _insert_entity("ads", new_id("mo_unlinked_ad"), {"customerId": stranger,
                   "adPhotos": ["data:image/png;base64," + UNLINKED_MARK]}, actors["admin_id"])
    linked = new_id("mo_linked")
    _insert_entity("receipts", linked, {"customerId": dup_id, "amountUSD": 2,
                   "photos": ["data:image/png;base64," + LINKED_MARK]}, actors["admin_id"])

    seen: list[str] = []
    real_loads = main_module.json_loads

    def spy(value):
        if isinstance(value, str):
            seen.append(value)
        return real_loads(value)

    monkeypatch.setattr(main_module, "json_loads", spy)
    statements: list[str] = []
    engine = get_engine()

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        result = main_module._merge_customers_atomic(actors["actor"], CustomerMergeRequest(**_operation(keep_id, dup_id, keep_v, dup_v)))
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert not any(UNLINKED_MARK in s for s in seen), "unlinked photo bytes reached Python"
    assert any(LINKED_MARK in s for s in seen), "the linked row must be loaded in full (it is written back)"
    assert not any("type IN ('pages','receipts','ads')" in s for s in statements), "old full scan still present"
    assert any("json_remove(data_json" in s and "'$.photos'" in s for s in statements), "discovery not media-stripped"
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json FROM entities WHERE id=:id"), {"id": linked}).mappings().first()
    data = json_loads(row["data_json"])
    assert data["customerId"] == keep_id
    assert LINKED_MARK in data["photos"][0], "photo erased by writing back a stripped row"
    assert {r["id"] for r in result["updatedReceipts"]} == {linked}


def test_merge_locks_receipts_then_ads_then_pages_then_customers(actors):
    keep_id, dup_id, keep_v, dup_v = _seed_pair(actors, "mo_lk", shared="0915550000")
    ids = {"receipts": sorted(new_id("mo_lk_r") for _ in range(3)),
           "ads": sorted(new_id("mo_lk_a") for _ in range(2)),
           "pages": [new_id("mo_lk_p")]}
    for rid in ids["receipts"]:
        _insert_entity("receipts", rid, {"customerId": dup_id, "amountUSD": 1}, actors["admin_id"])
    for aid in ids["ads"]:
        _insert_entity("ads", aid, {"customerId": dup_id}, actors["admin_id"])
    _insert_entity("pages", ids["pages"][0], {"customerIds": [dup_id]}, actors["admin_id"])

    locks, stop = _record_locks(get_engine())
    try:
        main_module._merge_customers_atomic(actors["actor"], CustomerMergeRequest(**_operation(keep_id, dup_id, keep_v, dup_v)))
    finally:
        stop()

    expected = ([("receipts", r) for r in ids["receipts"]] + [("ads", a) for a in ids["ads"]]
                + [("pages", p) for p in ids["pages"]] + [("customers", c) for c in sorted((keep_id, dup_id))])
    assert locks == expected, locks
    ranks = [RANK[t] for t, _ in locks]
    assert ranks == sorted(ranks)
    import inspect
    assert 'suffix = " FOR UPDATE" if postgres else ""' in inspect.getsource(main_module._clothes_lock_row)


def test_merge_conflicts_when_a_link_appears_after_the_locks(actors, monkeypatch):
    keep_id, dup_id, keep_v, dup_v = _seed_pair(actors, "mo_race", shared="0916660000")
    first = new_id("mo_race_r1")
    _insert_entity("receipts", first, {"customerId": dup_id, "amountUSD": 1}, actors["admin_id"])
    late = new_id("mo_race_late")
    calls = {"n": 0}
    real = main_module._customer_merge_linked_ids

    def racy(conn, duplicate_id, keep_id_):
        calls["n"] += 1
        if calls["n"] == 2:  # between discovery and verification a new linked receipt lands
            stamp = now_ms()
            conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                              "VALUES ('receipts',:id,:data,false,:t,:c,:t)"),
                         {"id": late, "data": json_dumps({"id": late, "customerId": duplicate_id, "amountUSD": 9}),
                          "t": stamp, "c": actors["admin_id"]})
        return real(conn, duplicate_id, keep_id_)

    monkeypatch.setattr(main_module, "_customer_merge_linked_ids", racy)
    with pytest.raises(HTTPException) as err:
        main_module._merge_customers_atomic(actors["actor"], CustomerMergeRequest(**_operation(keep_id, dup_id, keep_v, dup_v)))
    assert err.value.status_code == 409 and "linked records changed" in err.value.detail
    assert calls["n"] == 2
    with db_conn() as conn:
        dup = conn.execute(text("SELECT deleted FROM entities WHERE id=:id"), {"id": dup_id}).scalar()
        late_row = conn.execute(text("SELECT id FROM entities WHERE id=:id"), {"id": late}).scalar()
    assert not dup and late_row is None
