"""Review loop round 3, batch DL: data lifecycle and books.

* n=20 a privacy anonymisation replaces the person's name where receipts and ads copied it as text:
       every editHistory / metaChangeHistory entry by that name and the metaImportCompletedByName
       stamp (rows other people created, which the createdByName scrub never reads).
* n=21 anonymising a staff member keeps the metadata of their ``collision_repair`` audit rows (the
       reversal record), so a later studio Unlink still restores the Manager copies their link removed.
* n=22 a studio link also removes the owner-less "Needs owner" page Meta's automatic import made for
       the removed copy, and the Unlink brings it back; owned, edited or shared pages stay, and a page
       imported again meanwhile is not duplicated.

Every test makes its own users (unique names and e-mails per run) and removes its rows afterwards.
"""

import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from sqlalchemy import text

import server.meta_ads as meta_ads
from server import meta_collisions as mc
from server.db import db_conn, init_db, json_dumps, json_loads, now_ms
from server.main import _privacy_anonymize_deleted_user_atomic

TAG = secrets.token_hex(4)
_counter = [0]
_rows: list[tuple[str, str]] = []  # (entity type, id) this module wrote
_audit_ids: list[str] = []  # audit resource ids this module caused (repair ids included)


def _next() -> int:
    _counter[0] += 1
    return _counter[0]


def _digits() -> str:
    return f"1209{int(TAG, 16) % 10**8:08d}{_next():04d}"


@pytest.fixture(scope="module", autouse=True)
def _database():
    init_db()
    yield
    with db_conn() as conn:
        for entity_type, entity_id in _rows:
            conn.execute(text("DELETE FROM entities WHERE type=:t AND id=:i"), {"t": entity_type, "i": entity_id})
        for resource_id in {*_audit_ids, *(entity_id for _type, entity_id in _rows)}:
            conn.execute(text("DELETE FROM audit_logs WHERE resource_id=:i"), {"i": resource_id})


def _user(label: str, name: str) -> str:
    user_id = f"dl_{label}_{TAG}_{_next()}"
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,'Employee','{}','hash','salt','pbkdf2_sha256',1,false,:now,NULL,:now)"
            ),
            {"id": user_id, "name": name, "email": f"{user_id}@tests.albayanhub.com", "now": stamp},
        )
    return user_id


def _anonymise(user_id: str) -> None:
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET deleted=true, last_modified=:now WHERE id=:id"), {"id": user_id, "now": now_ms()})
    _privacy_anonymize_deleted_user_atomic(user_id)


def _insert(entity_type: str, entity_id: str, data: dict, *, created_by: str | None = None) -> None:
    stamp = now_ms()
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,false,:stamp,:by,:stamp)"
            ),
            {"type": entity_type, "id": entity_id, "data": json_dumps(data), "stamp": stamp, "by": created_by},
        )
    _rows.append((entity_type, entity_id))


def _entity(entity_type: str, entity_id: str) -> dict:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json, deleted, last_modified FROM entities WHERE type=:t AND id=:i"),
            {"t": entity_type, "i": entity_id},
        ).mappings().first()
    assert row is not None, (entity_type, entity_id)
    return {"data": json_loads(row["data_json"]) or {}, "raw": row["data_json"], "deleted": bool(row["deleted"]),
            "last_modified": int(row["last_modified"])}


def _import(campaign: str, meta_page_id: str, page_name: str) -> tuple[str, str]:
    """An ad Meta's automatic import took in as a neutral draft (and the page it made or matched)."""
    draft = meta_ads.import_meta_ad_draft({
        "metaAdId": _digits(), "metaCampaignName": f"Agency promo {TAG}", "metaCampaignId": campaign,
        "metaPageId": meta_page_id, "metaPageName": page_name,
    })
    ad_id = str(draft["id"])
    page_id = str(_entity("ads", ad_id)["data"].get("pageId") or "")
    _rows.extend([("ads", ad_id), ("pages", page_id)])
    return ad_id, page_id


def _remove(campaign: str, actor: str | None = None) -> dict:
    with db_conn() as conn:
        removal = mc.remove_untouched_copies(conn, campaign, actor, request_id=f"camp_dl_{TAG}")
    _audit_ids.append(removal["repairId"])
    return removal


def _audit_rows(user_id: str) -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            text("SELECT action, resource_id, message, metadata_json FROM audit_logs WHERE user_id=:u"), {"u": user_id}
        ).mappings().all()
    return [dict(row) for row in rows]


# ------------------------------------------------------------------ n=20 names copied into histories


def test_anonymisation_replaces_the_name_in_histories_and_the_completion_stamp():
    creator = _user("creator", f"Creator {TAG}")
    name = f"Staff_Person بشير {TAG}"  # "_" is a LIKE wildcard: the look-alike below must stay
    look_alike = f"StaffXPerson بشير {TAG}"
    staff = _user("staff", name)
    other = f"Other Person {TAG}"
    ad_id, receipt_id, look_id = f"ad_dl_{TAG}_hist", f"rcpt_dl_{TAG}_hist", f"ad_dl_{TAG}_look"
    _insert("ads", ad_id, {
        "recordType": "ad", "createdBy": creator, "createdByName": f"Creator {TAG}",
        "metaImportState": "complete", "metaImportCompletedBy": staff, "metaImportCompletedByName": name,
        "editHistory": [
            {"editedAt": "2026-09-01T10:00:00Z", "editedBy": name, "changes": [{"field": "Budget", "from": "5", "to": "6"}]},
            {"editedAt": "2026-09-02T10:00:00Z", "editedBy": other, "changes": []},
            {"editedAt": "2026-09-03T10:00:00Z", "editedBy": "Meta automatic sync", "changes": []},
        ],
        "metaChangeHistory": [{"editedAt": "2026-09-04T10:00:00Z", "editedBy": name, "source": "snapshot", "changes": []}],
    }, created_by=creator)
    _insert("receipts", receipt_id, {
        "createdBy": creator, "createdByName": f"Creator {TAG}",
        "editHistory": [{"editedAt": "2026-09-05T10:00:00Z", "editedBy": name, "changes": []}],
    }, created_by=creator)
    _insert("ads", look_id, {
        "recordType": "ad", "editHistory": [{"editedAt": "2026-09-06T10:00:00Z", "editedBy": look_alike, "changes": []}],
    }, created_by=creator)
    before = {key: _entity(kind, key)["last_modified"] for kind, key in (("ads", ad_id), ("receipts", receipt_id))}
    look_before = _entity("ads", look_id)

    _anonymise(staff)

    ad, receipt = _entity("ads", ad_id), _entity("receipts", receipt_id)
    assert name not in ad["raw"] and name not in receipt["raw"]
    assert ad["data"]["metaImportCompletedByName"] == "Deleted user"
    assert ad["data"]["metaImportCompletedBy"] == staff  # the id stays, as created_by does
    assert [entry["editedBy"] for entry in ad["data"]["editHistory"]] == ["Deleted user", other, "Meta automatic sync"]
    assert ad["data"]["editHistory"][0]["changes"] == [{"field": "Budget", "from": "5", "to": "6"}]
    assert ad["data"]["metaChangeHistory"][0]["editedBy"] == "Deleted user"
    assert ad["data"]["createdByName"] == f"Creator {TAG}"  # someone else's stamp is not touched
    assert receipt["data"]["editHistory"][0]["editedBy"] == "Deleted user"
    assert ad["last_modified"] > before[ad_id] and receipt["last_modified"] > before[receipt_id]  # clients re-sync
    assert _entity("ads", look_id) == look_before

    _privacy_anonymize_deleted_user_atomic(staff)  # a second run changes nothing more
    assert _entity("ads", ad_id) == ad and _entity("receipts", receipt_id) == receipt


# ------------------------------------------------------------------ n=21 the reversal record survives


def test_anonymising_the_linking_staff_keeps_the_unlink_reversal_record():
    linker = _user("linker", f"Linker {TAG}")
    campaign = _digits()
    ad_id, _page_id = _import(campaign, _digits(), f"Linker Shop {TAG}")
    removal = _remove(campaign, linker)
    assert removal["removed"] == [ad_id] and _entity("ads", ad_id)["deleted"]
    plain_id = f"audit_dl_{TAG}_{_next()}"
    with db_conn() as conn:  # an ordinary activity row of the same person: still scrubbed
        conn.execute(
            text(
                "INSERT INTO audit_logs (id,ts,user_id,action,resource_type,resource_id,message,metadata_json) "
                "VALUES (:id,:ts,:u,'update','ads',:r,:m,:meta)"
            ),
            {"id": plain_id, "ts": now_ms(), "u": linker, "r": ad_id, "m": f"Updated by Linker {TAG}",
             "meta": json_dumps({"ip": "203.0.113.9", "name": f"Linker {TAG}"})},
        )

    _anonymise(linker)

    rows = _audit_rows(linker)
    assert rows and all(row["message"] == "Activity retained after account privacy anonymization" for row in rows)
    summary = next(row for row in rows if row["action"] == "collision_repair" and row["resource_id"] == removal["repairId"])
    assert json_loads(summary["metadata_json"])["kind"] == mc.REVERSAL_KIND
    assert next(row for row in rows if row["action"] == "update")["metadata_json"] == "{}"

    unlinker = _user("unlinker", f"Unlinker {TAG}")
    with db_conn() as conn:
        assert mc.reverse_link_removal(conn, removal["repairId"], unlinker) == [ad_id]
    assert not _entity("ads", ad_id)["deleted"]


# ------------------------------------------------------------------ n=22 the import's page leaves with its copy


def test_link_removes_the_page_the_import_made_and_unlink_restores_it():
    campaign = _digits()
    ad_id, page_id = _import(campaign, _digits(), f"Studio Shop {TAG}")
    page = _entity("pages", page_id)["data"]
    assert page["metaImportState"] == "needs_owner" and page["customerIds"] == []

    removal = _remove(campaign)
    assert removal["removed"] == [ad_id]
    assert removal.get("removedPages") == [page_id]
    assert _entity("ads", ad_id)["deleted"] and _entity("pages", page_id)["deleted"]

    with db_conn() as conn:
        assert mc.reverse_link_removal(conn, removal["repairId"], None) == [ad_id]
    assert not _entity("ads", ad_id)["deleted"] and not _entity("pages", page_id)["deleted"]
    with db_conn() as conn:  # already reversed: nothing more to do
        assert mc.reverse_link_removal(conn, removal["repairId"], None) == []


def test_link_keeps_owned_edited_and_shared_pages():
    owned_meta, edited_meta, shared_meta = _digits(), _digits(), _digits()
    owned_id = f"page_dl_{TAG}_owned"
    _insert("pages", owned_id, {
        "name": f"Owned Shop {TAG}", "customerIds": [f"cust_dl_{TAG}"], "metaPageId": owned_meta,
        "metaImportSource": "meta_ads", "metaImportState": "complete",
    })
    campaigns = {"owned": _digits(), "edited": _digits(), "shared": _digits()}
    owned_ad, owned_page = _import(campaigns["owned"], owned_meta, f"Owned Shop {TAG}")
    edited_ad, edited_page = _import(campaigns["edited"], edited_meta, f"Edited Shop {TAG}")
    shared_ad, shared_page = _import(campaigns["shared"], shared_meta, f"Shared Shop {TAG}")
    _other_ad, other_page = _import(_digits(), shared_meta, f"Shared Shop {TAG}")  # the agency's own ad, same page
    assert owned_page == owned_id and other_page == shared_page
    with db_conn() as conn:  # a person edited this imported page afterwards
        conn.execute(
            text(
                "INSERT INTO audit_logs (id,ts,user_id,action,resource_type,resource_id,message,metadata_json) "
                "VALUES (:id,:ts,NULL,'update','pages',:r,'Updated pages','{}')"
            ),
            {"id": f"audit_dl_{TAG}_{_next()}", "ts": now_ms(), "r": edited_page},
        )

    for label, ad_id in (("owned", owned_ad), ("edited", edited_ad), ("shared", shared_ad)):
        removal = _remove(campaigns[label])
        assert removal["removed"] == [ad_id], label
        assert removal.get("removedPages", []) == [], label
    for page_id in (owned_page, edited_page, shared_page):
        assert not _entity("pages", page_id)["deleted"], page_id


def test_unlink_does_not_duplicate_a_page_imported_again_meanwhile():
    campaign, meta_page = _digits(), _digits()
    ad_id, page_id = _import(campaign, meta_page, f"Again Shop {TAG}")
    removal = _remove(campaign)
    assert removal.get("removedPages") == [page_id]
    _later_ad, fresh_page = _import(_digits(), meta_page, f"Again Shop {TAG}")  # the agency's own ad later
    assert fresh_page and fresh_page != page_id

    with db_conn() as conn:
        assert mc.reverse_link_removal(conn, removal["repairId"], None) == [ad_id]
    assert not _entity("ads", ad_id)["deleted"]
    assert _entity("pages", page_id)["deleted"] and not _entity("pages", fresh_page)["deleted"]
