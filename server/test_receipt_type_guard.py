"""The receiptType edit contract that broke employee saves on 2026-08-20.

receiptType is server-controlled on EDIT: an unchanged echo of the stored
value is tolerated (generic clients resend whole records), but any CHANGE is
refused with 405 "Receipt type is server-controlled". Legacy temp-delivery
receipts predate the DELIVERY_TEMP stamp and store NO receiptType at all, so
a client that recomputes the tag from tempReceiptNo on edit (as the receipt
form did) turned every edit of such a receipt into a forbidden
''->DELIVERY_TEMP change and the save failed outright. The form now echoes
the stored type verbatim; these tests pin both halves of the contract so
neither side can drift again.

Run with: PYTHONPATH=. pytest server/test_receipt_type_guard.py -v
"""

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, now_ms, json_dumps
from server.main import app
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id


client = TestClient(app, headers={"Origin": "http://testserver"})
ADMIN_EMAIL = "receipt-type-admin@tests.albayanhub.com"
ADMIN_PASSWORD = "ReceiptTypeAdmin123!Secure"


def _ensure_admin() -> str:
    pw = hash_password(ADMIN_PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    now = now_ms()
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE lower(email)=lower(:e) LIMIT 1"),
            {"e": ADMIN_EMAIL},
        ).mappings().first()
        if row:
            return str(row["id"])
        uid = new_id("user")
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,"
                "password_salt,password_algo,password_iterations,deleted,created_at,"
                "created_by,last_modified) VALUES "
                "(:id,'Receipt Type Admin',:email,'Admin',:perm,:h,:s,:a,:i,false,:now,NULL,:now)"
            ),
            {
                "id": uid,
                "email": ADMIN_EMAIL,
                "perm": json_dumps({}),
                "h": pw.hash_hex,
                "s": pw.salt_hex,
                "a": pw.algo,
                "i": pw.iterations,
                "now": now,
            },
        )
        return uid


@pytest.fixture(scope="module")
def admin():
    init_db()
    _ensure_admin()
    r = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert r.status_code == 200, r.text
    cookies = {"albayan_session": r.cookies.get("albayan_session")}
    try:
        client.cookies.clear()
    except Exception:
        pass
    return cookies


def _customer(cid, admin):
    suffix = int.from_bytes(
        hashlib.sha256(cid.encode("utf-8")).digest()[:8], "big"
    ) % 100_000_000
    r = client.post(
        "/api/collections/customers",
        json={"id": cid, "data": {"name": cid, "phones": [f"09{suffix:08d}"]}},
        cookies=admin,
    )
    assert r.status_code == 200, r.text


def _receipt(rid, cid, admin, **extra):
    data = {
        "recordType": "receipt",
        "customerId": cid,
        "amountUSD": 100,
        "amountLocal": 970,
        "exchangeRate": 9.7,
        "status": "Not Paid",
        "isPaid": False,
    }
    data.update(extra)
    r = client.post(
        "/api/collections/receipts",
        json={"id": rid, "data": data},
        cookies=admin,
    )
    assert r.status_code == 200, r.text
    return r.json()["lastModified"]


def _patch(rid, data, expected, admin):
    return client.patch(
        f"/api/collections/receipts/{rid}",
        json={"data": data, "expectedLastModified": expected},
        cookies=admin,
    )


def _stored(rid):
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json,last_modified FROM entities WHERE type='receipts' AND id=:id"),
            {"id": rid},
        ).mappings().first()
    assert row
    import json
    return json.loads(row["data_json"]), int(row["last_modified"])


def test_legacy_temp_receipt_edit_with_recomputed_type_is_the_405_incident(admin):
    """The exact production failure: a legacy temp receipt stores NO
    receiptType, the old form recomputed 'DELIVERY_TEMP' from tempReceiptNo
    on every edit, and the guard read ''->DELIVERY_TEMP as a forbidden
    change — so the employee's save died with 405."""
    _customer("rtype_cust1", admin)
    version = _receipt(
        "rtype_legacy1", "rtype_cust1", admin,
        tempReceiptNo="D77",
        deliveryStatus="Office",
        # No receiptType key at all — the legacy shape.
    )
    refused = _patch(
        "rtype_legacy1",
        {"notes": "collected in office", "receiptType": "DELIVERY_TEMP"},
        version,
        admin,
    )
    assert refused.status_code == 405, refused.text
    assert "Receipt type is server-controlled" in refused.text
    stored, unchanged = _stored("rtype_legacy1")
    assert "receiptType" not in stored or stored["receiptType"] == ""
    assert unchanged == version


def test_echoing_the_stored_empty_type_saves_fine(admin):
    """What the FIXED form sends for a legacy record: receiptType '' —
    key present, value equal to stored — must be tolerated and popped."""
    _customer("rtype_cust2", admin)
    version = _receipt(
        "rtype_legacy2", "rtype_cust2", admin,
        tempReceiptNo="D78",
        deliveryStatus="Office",
    )
    saved = _patch(
        "rtype_legacy2",
        {"notes": "edited by employee", "receiptType": ""},
        version,
        admin,
    )
    assert saved.status_code == 200, saved.text
    stored, _ = _stored("rtype_legacy2")
    assert stored["notes"] == "edited by employee"


def test_omitting_the_type_key_saves_and_keeps_the_stored_stamp(admin):
    _customer("rtype_cust3", admin)
    version = _receipt(
        "rtype_stamped3", "rtype_cust3", admin,
        tempReceiptNo="D79",
        deliveryStatus="Office",
        receiptType="DELIVERY_TEMP",
    )
    saved = _patch("rtype_stamped3", {"notes": "no type key at all"}, version, admin)
    assert saved.status_code == 200, saved.text
    stored, _ = _stored("rtype_stamped3")
    assert stored["receiptType"] == "DELIVERY_TEMP"
    assert stored["notes"] == "no type key at all"


def test_echoing_a_stored_stamp_passes_but_stripping_it_is_refused(admin):
    _customer("rtype_cust4", admin)
    version = _receipt(
        "rtype_stamped4", "rtype_cust4", admin,
        tempReceiptNo="D80",
        deliveryStatus="Office",
        receiptType="DELIVERY_TEMP",
    )
    echoed = _patch(
        "rtype_stamped4",
        {"notes": "same stamp echoed", "receiptType": "DELIVERY_TEMP"},
        version,
        admin,
    )
    assert echoed.status_code == 200, echoed.text
    stored, version = _stored("rtype_stamped4")
    assert stored["receiptType"] == "DELIVERY_TEMP"

    stripped = _patch(
        "rtype_stamped4",
        {"notes": "trying to clear the stamp", "receiptType": ""},
        version,
        admin,
    )
    assert stripped.status_code == 405, stripped.text
    stored, _ = _stored("rtype_stamped4")
    assert stored["receiptType"] == "DELIVERY_TEMP"
