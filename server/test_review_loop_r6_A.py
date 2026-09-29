"""Review loop r6, batch A: Manager ad screens.

The client fixes (n=14 top-ups version, n=15 company-aware settle target,
n=16 Stop dialog version, n=17 reconciliation drafts, n=23 analytics
breakdowns) are pinned in scripts/test-review-regressions.js ("r6 A").

Here:
* n=17 an unfinished Meta-import draft (no customer, no budget) cannot be
       stopped/reconciled: the stop route names the missing setup with a 409
       instead of failing with the raw 400 "Invalid entity id".
* n=14/16 the server facts the two client fixes rely on: an ad save or stop
       sent with the version the dialog opened with is refused with
       "Conflict: ad has changed" once a colleague changed the ad.
* the new/used refusal texts are translated by the Manager's Arabic map.

Disposable records with a unique TAG only; everything created is soft-deleted
again at the end. No stop markers are written (every stop here is refused).
"""

import json
import re
import secrets
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

ROOT = Path(__file__).parent.parent
client = TestClient(app, headers={"Origin": "http://testserver"})
TAG = secrets.token_hex(3)
ADMIN_EMAIL = f"r6-a-admin-{TAG}@tests.albayanhub.com"
ADMIN_PASSWORD = "R6BatchAdmin123!"
SETUP_REFUSAL = "Complete this imported Meta ad (customer and payment) before stopping it"
_created_ids: list[tuple[str, str]] = []


def _insert_entity(collection, entity_id, data, creator_id):
    stamp = now_ms()
    payload = dict(data)
    payload.update({"id": entity_id, "_created": stamp, "_lastModified": stamp,
                    "_deleted": False, "createdBy": creator_id})
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:created,:creator,:modified)"),
            {"type": collection, "id": entity_id, "data": json_dumps(payload),
             "created": stamp, "creator": creator_id, "modified": stamp},
        )
    _created_ids.append((collection, entity_id))
    return stamp


def _bump(collection, entity_id, **changes):
    """A colleague's committed change: new data and a newer version."""
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type=:t AND id=:id"),
                           {"t": collection, "id": entity_id}).mappings().first()
        data = json.loads(row["data_json"])
        data.update(changes)
        stamp = int(row["last_modified"]) + 1000
        data["_lastModified"] = stamp
        conn.execute(text("UPDATE entities SET data_json=:data, last_modified=:stamp WHERE type=:t AND id=:id"),
                     {"data": json_dumps(data), "stamp": stamp, "t": collection, "id": entity_id})
    return stamp


@pytest.fixture(scope="module")
def actors():
    init_db()
    password = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    stamp = now_ms()
    admin_id = new_id("r6a_admin")
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,'R6 A Admin',:email,'Admin',:permissions,:password_hash,:password_salt,"
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
    yield {"admin": admin, "admin_id": admin_id}
    with db_conn() as conn:
        for collection, entity_id in _created_ids:
            conn.execute(text("UPDATE entities SET deleted=true WHERE type=:type AND id=:id"),
                         {"type": collection, "id": entity_id})
        conn.execute(text("UPDATE users SET deleted=true WHERE id=:id"), {"id": admin_id})


def _recent(days_ago: int) -> str:
    return (date.today() - timedelta(days=days_ago)).isoformat()


def _draft(**extra) -> dict:
    """A core ad exactly as Meta's automatic import writes it (import_meta_ad_draft)."""
    data = {
        "recordType": "ad", "customerId": "", "customerName": "", "pageId": "", "pageName": "",
        "amountUSD": 0.0, "amountLocal": 0.0, "exchangeRate": 0.0, "paymentStatus": "pending_setup",
        "collectionMethod": "", "collectionPayments": [], "receiptAllocations": [], "dueAllocations": [],
        "mergedPaidAllocations": [], "receiptIds": [], "fundingReceiptId": "", "receiptId": "",
        "linkedDeliveryReceiptId": "", "dueAmountToUseUSD": 0.0, "hasMergedPaidFunds": False, "status": "Active",
        "deliveryStatus": "Office", "deliveryPersonId": "", "startDate": _recent(3), "endDate": _recent(3),
        "creatorId": "system", "metaImportState": "needs_completion", "editHistory": [], "editCount": 0,
        "metaAdId": str(10 ** 14 + secrets.randbelow(10 ** 14)), "metaSpendMinor": 1234, "metaCurrency": "USD",
    }
    data.update(extra)
    return data


def _stop(actors, ad_id, version, spent_minor=0):
    return client.post(f"/api/ads/{ad_id}/stop", cookies=actors["admin"], json={
        "spentMinorUSD": spent_minor, "customerInformed": False,
        "idempotencyKey": f"r6a-stop-{new_id('k')}", "expectedLastModified": version,
    })


def test_n17_stopping_an_unfinished_meta_import_names_the_missing_setup(actors):
    ad_id = new_id(f"r6a_{TAG}_draft")
    version = _insert_entity("ads", ad_id, _draft(), actors["admin_id"])
    response = _stop(actors, ad_id, version)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == SETUP_REFUSAL
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type='ads' AND id=:id"),
                           {"id": ad_id}).mappings().first()
    assert int(row["last_modified"]) == version, "a refused stop must not touch the draft"
    assert '"Stopped"' not in row["data_json"]


def test_n17_a_draft_that_only_lost_its_import_marker_is_still_refused(actors):
    # paymentStatus pending_setup alone (the client's isMetaAdSetupPending rule) is enough.
    ad_id = new_id(f"r6a_{TAG}_pending")
    version = _insert_entity("ads", ad_id, _draft(metaImportState=""), actors["admin_id"])
    response = _stop(actors, ad_id, version)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == SETUP_REFUSAL


def test_n16_a_stop_sent_with_the_version_the_dialog_opened_with_is_a_conflict_after_a_colleague_stop(actors):
    customer_id = new_id(f"r6a_{TAG}_cust")
    _insert_entity("customers", customer_id, {"name": "R6 A Customer", "phones": []}, actors["admin_id"])
    ad_id = new_id(f"r6a_{TAG}_ad")
    opened = _insert_entity("ads", ad_id, {
        "recordType": "ad", "customerId": customer_id, "status": "Active", "paymentStatus": "not_paid",
        "collectionMethod": "in_shop", "amountUSD": 0.0, "exchangeRate": 5, "receiptAllocations": [],
        "dueAllocations": [], "startDate": _recent(5), "endDate": _recent(2),
    }, actors["admin_id"])
    _bump("ads", ad_id, status="Stopped", spentUSD=0.0, remainingCustomerInformed=True)  # the colleague's stop
    response = _stop(actors, ad_id, opened)
    assert response.status_code == 409, response.text
    assert response.json()["detail"].startswith("Conflict:"), response.text


def test_n14_a_top_up_save_with_the_open_time_version_is_a_conflict_after_a_colleague_top_up(actors):
    customer_id = new_id(f"r6a_{TAG}_cust2")
    _insert_entity("customers", customer_id, {"name": "R6 A Customer 2", "phones": []}, actors["admin_id"])
    ad_id = new_id(f"r6a_{TAG}_topup")
    t1 = {"date": _recent(4), "amount": 10, "extendDays": 0, "note": "T1"}
    opened = _insert_entity("ads", ad_id, {
        "recordType": "ad", "customerId": customer_id, "status": "Active", "paymentStatus": "not_paid",
        "collectionMethod": "in_shop", "amountUSD": 0.0, "exchangeRate": 5, "topUps": [t1],
        "receiptAllocations": [], "dueAllocations": [], "startDate": _recent(5), "endDate": _recent(1),
    }, actors["admin_id"])
    t2 = {"date": _recent(3), "amount": 20, "extendDays": 5, "note": "T2"}
    _bump("ads", ad_id, topUps=[t1, t2])  # the colleague's committed top-up
    response = client.post("/api/ads/mutate", cookies=actors["admin"], json={
        "action": "update", "adId": ad_id, "idempotencyKey": f"r6a-topup-{new_id('k')}",
        "expectedLastModified": opened,
        "data": {"topUps": [t1, {"date": _recent(1), "amount": 15, "extendDays": 0, "note": "T3"}]},
    })
    assert response.status_code == 409, response.text
    assert response.json()["detail"].startswith("Conflict:"), response.text
    with db_conn() as conn:
        stored = conn.execute(text("SELECT data_json FROM entities WHERE type='ads' AND id=:id"),
                              {"id": ad_id}).scalar()
    assert '"T2"' in stored and '"T3"' not in stored, "the colleague's top-up was erased"


def _client_refusal_rules() -> list[tuple[str, str]]:
    source = (ROOT / "src" / "08-data-audit.js").read_text(encoding="utf-8")
    block = source.split("const _SERVER_REFUSAL_AR = [", 1)[1].split("\n];", 1)[0]
    rules = []
    for line in block.splitlines():
        line = line.strip()
        regex = re.match(r"^\[/(.+?)/, '", line)
        if regex:
            rules.append(("regex", regex.group(1)))
            continue
        prefix = re.match(r"""^\[(['"])(.+?)\1, '""", line)
        if prefix:
            rules.append(("prefix", prefix.group(2)))
    return rules


def test_n15_n17_the_manager_translates_the_ad_settle_and_draft_stop_refusals():
    rules = _client_refusal_rules()
    main_src = (ROOT / "server" / "main.py").read_text(encoding="utf-8")
    for detail in (SETUP_REFUSAL,
                   "Paid receipt funding must exactly settle the customer's share of the unpaid ad amount"):
        assert f'"{detail}"' in main_src, f"server text changed: {detail}"
        assert any(kind == "prefix" and detail.startswith(pattern) for kind, pattern in rules), detail
