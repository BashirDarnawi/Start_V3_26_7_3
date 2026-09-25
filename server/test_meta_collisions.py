"""Studio campaigns in Manager's books: report, owner-signed repair and its reversal (plan task P0-10, D26).

Every test writes rows whose ids carry this run's TAG, removes them afterwards and restores the
shared keep-decisions record, so counts left by other modules never matter.
"""

import json
import os
import secrets
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from server import meta_collisions as mc
from server.db import METADATA, db_conn, define_schema, init_db, json_dumps, json_loads, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

ROOT = Path(__file__).resolve().parent.parent
TAG = secrets.token_hex(4)
PASSWORD = "CollisionReportPassword123!"
NO_ROW_FINGERPRINT = "0" * 64  # for a choice whose row is not in the report (refused before the check)
client = TestClient(app, headers={"Origin": "http://testserver"})


def _insert(conn, entity_type: str, entity_id: str, data: dict, *, deleted: bool = False) -> None:
    stamp = now_ms()
    conn.execute(
        text(
            "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
            "VALUES (:type,:id,:data,:deleted,:stamp,NULL,:stamp)"
        ),
        {"type": entity_type, "id": entity_id, "data": json_dumps(data), "deleted": deleted, "stamp": stamp},
    )


def _draft(name: str = "ALB-S-K7M2P9QX · Shoes for Salma", campaign: str = "", **extra) -> dict:
    """A core ad exactly as Meta's automatic import writes it (meta_ads.import_meta_ad_draft)."""
    data = {
        "recordType": "ad", "customerId": "", "customerName": "", "pageId": "", "pageName": "",
        "amountUSD": 0.0, "amountLocal": 0.0, "exchangeRate": 0.0, "paymentStatus": "pending_setup",
        "collectionMethod": "", "collectionPayments": [], "receiptAllocations": [], "dueAllocations": [],
        "mergedPaidAllocations": [], "receiptIds": [], "fundingReceiptId": "", "receiptId": "",
        "linkedDeliveryReceiptId": "", "dueAmountToUseUSD": 0.0, "hasMergedPaidFunds": False, "status": "Active",
        "deliveryStatus": "Office", "deliveryPersonId": "", "startDate": "2026-09-20", "creatorId": "system",
        "metaImportState": "needs_completion", "editHistory": [], "editCount": 0,
        "metaCampaignName": name, "metaCampaignId": campaign, "metaSpendMinor": 1234, "metaCurrency": "USD",
    }
    data.update(extra)
    return data


def _ad(label: str, *, deleted: bool = False, **data) -> str:
    ad_id = f"ad_col_{TAG}_{label}"
    with db_conn() as conn:
        _insert(conn, "ads", ad_id, _draft(**data), deleted=deleted)
    return ad_id


def _row(ad_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(text("SELECT * FROM entities WHERE type='ads' AND id=:id"), {"id": ad_id}).mappings().first()
    return dict(row) if row else {}


def _choices(*pairs, **extra) -> dict:
    """A signed choices file; each pair is (adId, choice) or (adId, choice, decisionFingerprint)."""
    return {"signedBy": "Owner", "signedAt": "2026-09-25", **extra,
            "choices": [{"adId": ad_id, "choice": choice, **({"decisionFingerprint": rest[0]} if rest else {})}
                        for ad_id, choice, *rest in pairs]}


def _report_rows() -> dict:
    with db_conn() as conn:
        report = mc.collision_report(conn)
    return {row["adId"]: row for row in report["rows"] if TAG in row["adId"]}


def _from_report(*pairs) -> dict:
    """Choices as the owner writes them: each row's decisionFingerprint copied from the report."""
    report = _report_rows()
    return _choices(*[(ad_id, choice, report.get(ad_id, {}).get("decisionFingerprint", NO_ROW_FINGERPRINT))
                      for ad_id, choice in pairs])


def _write_data(ad_id: str, **changes) -> None:
    """Rewrite a stored ad the way a later save does: new data_json fields and a newer last_modified."""
    with db_conn() as conn:
        row = conn.execute(text("SELECT data_json, last_modified FROM entities WHERE type='ads' AND id=:id"),
                           {"id": ad_id}).mappings().first()
        stamp = max(now_ms(), int(row["last_modified"]) + 1)
        data = {**json_loads(row["data_json"]), **changes, "_lastModified": stamp}
        conn.execute(text("UPDATE entities SET data_json=:data, last_modified=:stamp WHERE type='ads' AND id=:id"),
                     {"id": ad_id, "data": json_dumps(data), "stamp": stamp})


@contextmanager
def _financial_month(period: str):
    """The month starts open; close() closes it. The shared closure record is restored afterwards."""
    close_id = f"financial-close-{period}"
    with db_conn() as conn:
        saved = conn.execute(text("SELECT * FROM entities WHERE type='financialClosures' AND id=:id"),
                             {"id": close_id}).mappings().first()
        saved = dict(saved) if saved else None
        conn.execute(text("DELETE FROM entities WHERE type='financialClosures' AND id=:id"), {"id": close_id})

    def close() -> None:
        with db_conn() as conn:
            _insert(conn, "financialClosures", close_id, {"status": "closed", "period": period})

    try:
        yield close
    finally:
        with db_conn() as conn:
            conn.execute(text("DELETE FROM entities WHERE type='financialClosures' AND id=:id"), {"id": close_id})
            if saved:
                conn.execute(
                    text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                         "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                    saved,
                )


def _audit_count() -> int:
    with db_conn() as conn:
        return int(conn.execute(text("SELECT COUNT(*) FROM audit_logs WHERE action=:action"),
                                {"action": mc.AUDIT_ACTION}).scalar_one())


def _decisions_row() -> dict | None:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT * FROM entities WHERE type=:type AND id=:id"),
            {"type": mc.DECISIONS_STATE_TYPE, "id": mc.DECISIONS_STATE_ID},
        ).mappings().first()
    return dict(row) if row else None


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()  # idempotent; the module may run alone on a fresh in-memory database


@pytest.fixture(autouse=True)
def _clean():
    saved = _decisions_row()
    yield
    with db_conn() as conn:
        conn.execute(text("DELETE FROM entities WHERE id LIKE :tag"), {"tag": f"%{TAG}%"})
        conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"),
                     {"type": mc.DECISIONS_STATE_TYPE, "id": mc.DECISIONS_STATE_ID})
        if saved:
            conn.execute(
                text(
                    "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                    "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"
                ),
                saved,
            )
        conn.execute(
            text("DELETE FROM audit_logs WHERE action=:action AND (resource_id LIKE :tag OR metadata_json LIKE :tag)"),
            {"action": mc.AUDIT_ACTION, "tag": f"%{TAG}%"},
        )


def test_report_finds_studio_rows_by_name_and_linked_campaign_id():
    campaign = f"2385{TAG}"
    with db_conn() as conn:
        _insert(conn, "adCampaignRequests", f"camp_col_{TAG}", {"status": "Approved", "metaCampaignId": campaign})
    named = _ad("named")
    lower = _ad("lower", name="alb-s-k7m2p9qx · lower case typed by staff")
    linked = _ad("linked", name="Summer sale", campaign=campaign)
    plain = _ad("plain", name="Agency ad for a shop", campaign="999")
    gone = _ad("gone", deleted=True)

    rows = _report_rows()
    assert set(rows) == {named, lower, linked}
    assert plain not in rows and gone not in rows
    assert rows[named]["reasons"] == ["studio_name"]
    assert rows[linked]["reasons"] == ["studio_campaign_id"]
    assert rows[linked]["studioRequestIds"] == [f"camp_col_{TAG}"]
    assert rows[named]["untouched"] and rows[named]["removable"] and not rows[named]["hasMoney"]
    assert rows[named]["spend"] == {"metaSpendMinor": 1234, "metaCurrency": "USD", "amountUSD": 0.0}
    assert len(rows[named]["decisionFingerprint"]) == 64 and "lastModified" not in rows[named]
    assert rows[named]["decisionFingerprint"] != rows[linked]["decisionFingerprint"]  # the campaign is a decision fact

    with db_conn() as conn:
        report = mc.collision_report(conn)
    counts = report["counts"]
    assert counts["total"] == len(report["rows"]) >= 3
    assert counts["open"] + counts["kept"] == counts["total"]
    # Ids, flags, counts and numbers only: never a campaign name, a customer name or a phone.
    text_out = json.dumps(report, ensure_ascii=False)
    assert "Salma" not in text_out and "Summer sale" not in text_out and "ALB-S-" not in text_out


def test_rows_with_money_are_refused_never_deleted():
    receipts = _ad("receipts", paymentStatus="paid", receiptAllocations=[{"receiptId": "r_1", "amountUSD": 20}])
    collections = _ad("collections", collectionPayments=[{"amountLocal": 50}], collectionMethod="in_shop")
    wallet = _ad("wallet")
    company = _ad("company", companyFundingAllocations=[{"receiptId": "r_2", "amountUSD": 5}])
    payment = _ad("payment", paymentStatus="not_paid")
    marker = _ad("marker")
    customer_only = _ad("customer", customerId="cust_1")
    clean = _ad("clean")
    with db_conn() as conn:
        _insert(conn, "walletTransactions", f"wtx_col_{TAG}", {"type": "transfer", "referenceId": wallet})
        _insert(conn, "adFundingMutations", f"afm_col_{TAG}", {"adId": marker, "updatedReceiptIds": []})

    rows = _report_rows()
    assert rows[receipts]["hasReceipts"] and rows[collections]["hasCollections"]
    assert rows[wallet]["hasWallet"] and rows[company]["hasCompanyFunding"]
    assert rows[payment]["hasPaymentState"] and rows[marker]["hasReceipts"]
    assert rows[customer_only]["hasCustomer"] and not rows[customer_only]["hasMoney"]

    money_rows = [receipts, collections, wallet, company, payment, marker]
    document = _from_report(*[(ad_id, mc.REMOVE) for ad_id in money_rows + [customer_only, clean]])
    with db_conn() as conn:
        result, reversal = mc.apply_repair(conn, document)
    refused = {item["adId"]: item for item in result["refused"]}
    assert set(refused) == set(money_rows)
    assert {item["reason"] for item in refused.values()} == {"has_money"}
    assert refused[receipts]["money"] == ["receipts", "paymentState"]
    assert refused[wallet]["money"] == ["wallet"]
    assert refused[company]["money"] == ["companyFunding"]
    assert refused[collections]["money"] == ["collections"]
    assert sorted(result["removed"]) == sorted([customer_only, clean])
    assert reversal and {item["adId"] for item in reversal["removed"]} == {customer_only, clean}
    for ad_id in money_rows:
        assert not _row(ad_id)["deleted"], ad_id
    assert _row(clean)["deleted"] and _row(customer_only)["deleted"]


def test_collision_repair_reversible():
    remove_a, remove_b, keep = _ad("remove_a"), _ad("remove_b"), _ad("keep")
    before = {ad_id: _row(ad_id) for ad_id in (remove_a, remove_b, keep)}
    decisions_before = _decisions_row()
    document = _from_report((remove_a, mc.REMOVE), (remove_b, mc.REMOVE), (keep, mc.KEEP))

    with db_conn() as conn:
        result, reversal = mc.apply_repair(conn, document, actor_id="admin_tester", database="test")
    assert sorted(result["removed"]) == sorted([remove_a, remove_b]) and result["kept"] == [keep]
    assert result["refused"] == []
    for ad_id in (remove_a, remove_b):
        after = _row(ad_id)
        assert after["deleted"] and after["data_json"] == before[ad_id]["data_json"]
        assert after["last_modified"] > before[ad_id]["last_modified"]  # clients sync the removal
    rows = _report_rows()
    assert set(rows) == {keep} and rows[keep]["kept"]  # the daily check counts only open rows
    with db_conn() as conn:
        audits = conn.execute(
            text("SELECT user_id, resource_id, metadata_json FROM audit_logs WHERE action=:action AND "
                 "(resource_id=:repair OR resource_id IN (:a, :b))"),
            {"action": mc.AUDIT_ACTION, "repair": result["repairId"], "a": remove_a, "b": remove_b},
        ).mappings().all()
    assert {row["resource_id"] for row in audits} == {result["repairId"], remove_a, remove_b}
    assert {row["user_id"] for row in audits} == {"admin_tester"}
    summary = next(json_loads(row["metadata_json"]) for row in audits if row["resource_id"] == result["repairId"])
    assert summary["choicesSha256"] == reversal["choicesSha256"] and summary["signedBy"] == "Owner"

    with db_conn() as conn:
        undone = mc.reverse_repair(conn, json.loads(json.dumps(reversal)), actor_id="admin_tester")
    assert sorted(undone["restored"]) == sorted([remove_a, remove_b]) and undone["keepDecisionsUndone"] == [keep]
    for ad_id, old in before.items():
        now = _row(ad_id)
        assert not now["deleted"]
        assert (now["data_json"], now["created_at"], now["created_by"]) == (
            old["data_json"], old["created_at"], old["created_by"])
    kept_now = json_loads(_decisions_row()["data_json"])["kept"] if _decisions_row() else {}
    kept_before = json_loads(decisions_before["data_json"])["kept"] if decisions_before else {}
    assert kept_now == kept_before
    assert set(_report_rows()) == {remove_a, remove_b, keep}

    with db_conn() as conn, pytest.raises(mc.CollisionRepairError, match="refused: .*not removed any more"):
        mc.reverse_repair(conn, reversal)  # a reversal is used once


def test_reverse_refuses_when_a_row_changed_after_the_repair():
    removed, kept = _ad("changed"), _ad("kept_changed")
    with db_conn() as conn:
        _, reversal = mc.apply_repair(conn, _from_report((removed, mc.REMOVE), (kept, mc.KEEP)))
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET last_modified = last_modified + 5 WHERE type='ads' AND id=:id"),
                     {"id": removed})
    with db_conn() as conn, pytest.raises(mc.CollisionRepairError, match="changed after the repair"):
        mc.reverse_repair(conn, reversal)
    assert _row(removed)["deleted"]  # all or nothing: the keep decision was not undone either
    assert kept in json_loads(_decisions_row()["data_json"])["kept"]


def test_dry_run_and_report_change_nothing():
    first, second = _ad("dry_a"), _ad("dry_b", paymentStatus="paid")

    def snapshot():
        with db_conn() as conn:
            entities = conn.execute(text("SELECT type,id,data_json,deleted,last_modified FROM entities "
                                         "ORDER BY type,id")).all()
            audits = conn.execute(text("SELECT id FROM audit_logs ORDER BY id")).all()
        return entities, audits

    document = _from_report((first, mc.REMOVE), (second, mc.REMOVE))
    before = snapshot()
    with db_conn() as conn:
        plan = mc.plan_repair(conn, document)
        mc.collision_report(conn)
    assert plan["dryRun"] and plan["wouldRemove"] == [first] and plan["wouldKeep"] == []
    assert [(item["adId"], item["reason"]) for item in plan["refused"]] == [(second, "has_money")]
    assert snapshot() == before


def test_missing_changed_foreign_and_closed_month_rows_are_refused():
    changed, plain, removed_before = _ad("stale"), _ad("plain", name="Agency ad"), _ad("old", deleted=True)
    closed = _ad("closed", startDate="2019-03-15")
    document = _from_report((changed, mc.REMOVE), (plain, mc.REMOVE), (removed_before, mc.REMOVE),
                            (f"ad_col_{TAG}_missing", mc.KEEP), (closed, mc.REMOVE))
    _write_data(changed, customerId="cust_after_report")  # staff completed it after the report
    with _financial_month("2019-03") as close_month:
        close_month()
        with db_conn() as conn:
            result, reversal = mc.apply_repair(conn, document)
    assert reversal is None and result["removed"] == [] and result["kept"] == []
    assert {item["adId"]: item["reason"] for item in result["refused"]} == {
        changed: "changed_since_report", plain: "not_a_collision", removed_before: "already_removed",
        f"ad_col_{TAG}_missing": "not_found", closed: "closed_period",
    }
    assert not _row(changed)["deleted"] and not _row(closed)["deleted"]


def test_decision_fingerprint_survives_meta_sync_but_not_a_customer_or_amount_change():
    synced, customer, amount, kept = _ad("synced"), _ad("customer_late"), _ad("amount_late"), _ad("kept_late")
    document = _from_report((synced, mc.REMOVE), (customer, mc.REMOVE), (amount, mc.REMOVE), (kept, mc.KEEP))
    # Meta's sync every ~15 minutes: new spend, schedule, status, history and last_modified.
    _write_data(synced, metaSpendMinor=98765, metaCurrency="EUR", metaEffectiveStatus="PAUSED",
                metaConfiguredStatus="PAUSED", metaStopTime="2026-10-01T00:00:00+0000",
                metaLastSyncedAt="2026-09-25T10:15:00Z", metaChangeHistory=[{"editedBy": "Meta"}], metaChangeCount=1)
    _write_data(customer, customerId="cust_late", customerName="Late customer")
    _write_data(amount, amountUSD=25.0, amountLocal=150.0)
    _write_data(kept, paymentStatus="paid")  # an optional fingerprint on a keep is checked too
    assert _report_rows()[synced]["decisionFingerprint"] == document["choices"][0]["decisionFingerprint"]

    with db_conn() as conn:
        result, _ = mc.apply_repair(conn, document)
    assert result["removed"] == [synced] and result["kept"] == []
    assert {item["adId"]: item["reason"] for item in result["refused"]} == {
        customer: "changed_since_report", amount: "changed_since_report", kept: "changed_since_report",
    }
    assert _row(synced)["deleted"] and not _row(customer)["deleted"] and not _row(amount)["deleted"]


def test_reverse_is_refused_when_the_month_was_closed_after_the_repair():
    removed, kept = _ad("month_closed", startDate="2019-05-15"), _ad("month_kept")
    with _financial_month("2019-05") as close_month:
        with db_conn() as conn:
            result, reversal = mc.apply_repair(conn, _from_report((removed, mc.REMOVE), (kept, mc.KEEP)))
        assert result["removed"] == [removed] and reversal
        close_month()
        before, audits = _row(removed), _audit_count()
        with db_conn() as conn, pytest.raises(mc.CollisionRepairError,
                                              match=f"{removed} belongs to a closed financial month"):
            mc.reverse_repair(conn, reversal, actor_id="admin_tester")
    assert _row(removed) == before and before["deleted"]  # nothing changed, all or nothing
    assert kept in json_loads(_decisions_row()["data_json"])["kept"]
    assert _audit_count() == audits


def test_reverse_takes_the_period_lock_before_any_write(monkeypatch):
    removed = _ad("period_lock")
    with db_conn() as conn:
        _, reversal = mc.apply_repair(conn, _from_report((removed, mc.REMOVE)))
    before, audits, checked = _row(removed), _audit_count(), []

    def closing_now(collection, data, *, conn):  # PostgreSQL's answer while a month close runs
        checked.append((collection, data.get("startDate")))
        raise HTTPException(status_code=409, detail="Financial period 2026-09 is being closed or unlocked")

    monkeypatch.setattr(mc, "financial_period_is_closed", closing_now)
    with db_conn() as conn, pytest.raises(HTTPException) as error:
        mc.reverse_repair(conn, reversal)
    assert error.value.status_code == 409 and checked == [(mc.ADS_TYPE, "2026-09-20")]
    assert _row(removed) == before and _audit_count() == audits


FINGERPRINT = "a" * 64


@pytest.mark.parametrize("document, message", [
    ([], "JSON object"),
    ({"choices": [{"adId": "ad_1", "choice": mc.REMOVE, "decisionFingerprint": FINGERPRINT}]}, "signedBy"),
    ({"signedBy": "Owner", "signedAt": "2026-09-25", "choices": []}, "no choices"),
    (_choices(("ad_1", "delete")), "choice must be"),
    (_choices(("ad_1", mc.REMOVE, FINGERPRINT), ("ad_1", mc.KEEP)), "listed twice"),
    (_choices(("bad id!", mc.REMOVE)), "not a record id"),
    (_choices(("ad_1", mc.REMOVE)), "remove_from_manager needs decisionFingerprint, copied from the report row"),
    ({**_choices(("ad_1", mc.KEEP)), "choices": [{"adId": "ad_1", "choice": mc.REMOVE, "lastModified": 5}]},
     "needs decisionFingerprint"),  # the old lastModified guard is gone
    (_choices(("ad_1", mc.REMOVE, "")), "decisionFingerprint must be the value from the report"),
    (_choices(("ad_1", mc.KEEP, "x" * 64)), "decisionFingerprint must be the value from the report"),
])
def test_choices_file_must_be_signed_and_valid(document, message):
    with pytest.raises(mc.CollisionRepairError, match=message):
        mc.parse_choices(document)


def test_keep_needs_no_fingerprint():
    parsed = mc.parse_choices(_choices(("ad_1", mc.KEEP), ("ad_2", mc.REMOVE, FINGERPRINT)))
    assert [(item["choice"], item["fingerprint"]) for item in parsed["choices"]] == [
        (mc.KEEP, None), (mc.REMOVE, FINGERPRINT)]


@pytest.mark.parametrize("reversal, message", [
    ({"kind": "something-else", "version": 1}, "not a collision repair reversal"),
    ({"kind": mc.REVERSAL_KIND, "version": 1, "repairId": "x", "removed": [], "kept": []}, "damaged"),
    ({"kind": mc.REVERSAL_KIND, "version": 1, "repairId": "collision_repair_" + "0" * 32,
      "removed": [{"adId": "ad_1", "lastModifiedAfter": "5", "dataSha256": "x"}], "kept": []}, "stamp or hash"),
])
def test_damaged_reversal_files_are_refused(reversal, message):
    with db_conn() as conn, pytest.raises(mc.CollisionRepairError, match=message):
        mc.reverse_repair(conn, reversal)


def _user(role: str) -> dict:
    password = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    user = {"id": new_id(f"col_{TAG}"), "email": f"collisions-{role.lower()}-{TAG}@tests.albayanhub.com"}
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,"
                "'{}',:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user["id"], "name": f"Collisions {role}", "email": user["email"], "role": role,
             "hash": password.hash_hex, "salt": password.salt_hex, "algo": password.algo,
             "iterations": password.iterations, "stamp": now_ms()},
        )
    response = client.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert response.status_code == 200, response.text
    user["cookies"] = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    return user


def test_collisions_route_is_admin_only_rate_limited_and_counts_only():
    ad_id = _ad("route", customerId="cust_route", customerName="Customer Salma", phone="0912345678")
    admin, staff = _user("Admin"), _user("Employee")
    try:
        assert client.get("/api/meta-ads/collisions").status_code == 401
        assert client.get("/api/meta-ads/collisions", cookies=staff["cookies"]).status_code == 403
        response = client.get("/api/meta-ads/collisions", cookies=admin["cookies"])
        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"generatedAt", "counts", "rows"}
        row = next(item for item in body["rows"] if item["adId"] == ad_id)
        assert row["hasCustomer"] and not row["hasMoney"]
        assert "Salma" not in response.text and "0912345678" not in response.text and "cust_route" not in response.text
        statuses = [client.get("/api/meta-ads/collisions", cookies=admin["cookies"]).status_code
                    for _ in range(mc.REPORT_READS_PER_MINUTE)]
        assert statuses[-1] == 429 and set(statuses[:-1]) == {200}
    finally:
        reset_rate_limit(f"meta-collisions:{admin['id']}")
        with db_conn() as conn:
            conn.execute(text("DELETE FROM sessions WHERE user_id IN (:a, :s)"), {"a": admin["id"], "s": staff["id"]})
            conn.execute(text("DELETE FROM users WHERE id IN (:a, :s)"), {"a": admin["id"], "s": staff["id"]})


@pytest.fixture
def outside_home():
    """A home folder outside the repository (npm run test:backend puts pytest's --basetemp inside it)."""
    with tempfile.TemporaryDirectory(prefix="albayan-collision-home-") as folder:
        home = Path(folder).resolve()
        assert home != ROOT and ROOT not in home.parents
        yield home


def test_command_line_dry_run_apply_and_reverse(tmp_path, outside_home):
    database = tmp_path / "collisions.db"
    engine = create_engine(f"sqlite+pysqlite:///{database.as_posix()}")
    define_schema()
    METADATA.create_all(engine)
    ad_id, paid_id = f"ad_cli_{TAG}", f"ad_cli_paid_{TAG}"
    with engine.begin() as conn:
        _insert(conn, "ads", ad_id, _draft())
        _insert(conn, "ads", paid_id, _draft(paymentStatus="paid"))
    engine.dispose()
    env = {key: value for key, value in os.environ.items() if not key.startswith(("ALBAYAN_", "DATABASE_URL", "PG"))}
    home = outside_home  # the default reversal folder is ~/albayan-repairs: never the real home in a test
    env.update({"DATABASE_URL": f"sqlite+pysqlite:///{database.as_posix()}", "ALBAYAN_ALLOW_SQLITE": "true",
                "ALBAYAN_META_BACKGROUND_SYNC": "false", "PYTHONIOENCODING": "utf-8",
                "HOME": str(home), "USERPROFILE": str(home)})

    def cli(*args):
        return subprocess.run([sys.executable, str(ROOT / "scripts" / "studio_collision_repair.py"), *args],
                              cwd=tmp_path, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)

    def deleted(entity_id):
        check = create_engine(f"sqlite+pysqlite:///{database.as_posix()}")
        with check.connect() as conn:
            value = conn.execute(text("SELECT deleted FROM entities WHERE id=:id"), {"id": entity_id}).scalar_one()
        check.dispose()
        return bool(value)

    report = cli("--report")
    assert report.returncode == 0, report.stderr
    fingerprints = {row["adId"]: row["decisionFingerprint"] for row in json.loads(report.stdout)["rows"]}
    assert set(fingerprints) == {ad_id, paid_id}
    choices = tmp_path / "choices.json"
    choices.write_text(json.dumps(_choices((ad_id, mc.REMOVE, fingerprints[ad_id]),
                                           (paid_id, mc.REMOVE, fingerprints[paid_id]))), encoding="utf-8")

    dry = cli("--choices", str(choices))
    assert dry.returncode == 0, dry.stderr
    assert json.loads(dry.stdout)["wouldRemove"] == [ad_id] and not deleted(ad_id)
    refused = cli("--choices", str(choices), "--apply")  # no --confirm-database: nothing happens
    assert refused.returncode == 2 and "--confirm-database collisions.db" in refused.stderr and not deleted(ad_id)
    in_repo = ROOT / f".collision-reversal-test-{TAG}"  # a reversal file there would block release:image:push
    inside = cli("--choices", str(choices), "--apply", "--confirm-database", "collisions.db",
                 "--reversal-dir", str(in_repo))
    assert inside.returncode == 2 and "outside the repository" in inside.stderr
    assert not in_repo.exists() and not deleted(ad_id)

    applied = cli("--choices", str(choices), "--apply", "--confirm-database", "collisions.db", "--actor", "admin_cli")
    assert applied.returncode == 0, applied.stderr
    result = json.loads(applied.stdout)
    assert result["removed"] == [ad_id] and result["refused"][0]["reason"] == "has_money"
    assert deleted(ad_id) and not deleted(paid_id)
    reversal_file = Path(result["reversalFile"])
    assert reversal_file.parent == home / "albayan-repairs"  # the default, created on first use
    assert reversal_file.exists() and "Salma" not in reversal_file.read_text(encoding="utf-8")

    undone = cli("--reverse", str(reversal_file), "--confirm-database", "collisions.db")
    assert undone.returncode == 0, undone.stderr
    assert json.loads(undone.stdout)["restored"] == [ad_id] and not deleted(ad_id)
    again = cli("--reverse", str(reversal_file), "--confirm-database", "collisions.db")
    assert again.returncode == 1 and "Nothing was changed" in again.stderr
