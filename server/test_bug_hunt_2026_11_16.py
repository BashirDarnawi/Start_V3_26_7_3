"""Bug hunt of 2026-11-16: small verified crashes (stored shapes and inputs the code did not expect).

Run with:
  PYTHONPATH=. pytest server/test_bug_hunt_2026_11_16.py -v
"""
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

import server.operations as operations
from server.unpaid_receipt_growth import _server_amount_change
from server.wallet_payments import _stored_text


def test_an_edit_history_field_that_is_a_list_or_object_is_ignored_not_a_crash():
    # Before: a set of the field names raised TypeError (unhashable), so every In-Shop ad save
    # on a receipt holding such a history row answered 500.
    for odd in (["Amount (USD)"], {"name": "Amount (USD)"}, None, 7):
        event = {"changes": [{"field": odd, "from": "$1.00", "to": "$2.00"}]}
        assert _server_amount_change(event, growth_seen=True) is None
    # A genuine server write next to an odd row is still recognised.
    event = {"changes": [
        {"field": ["junk"]},
        {"field": "Funding Ad", "from": "-", "to": "ad_1"},
        {"field": "Amount (USD)", "from": "10", "to": "25"},
    ]}
    assert _server_amount_change(event, growth_seen=False) == (1000, 2500)


def test_a_date_time_at_the_edge_of_the_calendar_keeps_its_written_day():
    # Before: converting year 1 or 9999 into the business time zone raised OverflowError (a 500).
    assert operations._record_date("receipts", {"date": "9999-12-31T23:59:59"}) == date(9999, 12, 31)
    assert operations._record_date("receipts", {"date": "9999-12-31T23:30:00-05:00"}) == date(9999, 12, 31)
    assert operations._record_date("ads", {"startDate": "0001-01-01T00:30:00+05:00"}) == date(1, 1, 1)
    assert operations._record_date("receipts", {"date": "2026-10-01T10:00:00Z"}) == date(2026, 10, 1)


def test_payment_notes_drop_characters_postgresql_cannot_store():
    # A NUL or a lone surrogate is valid JSON; PostgreSQL refuses both (the request answered 500).
    assert _stored_text("paid\x00 at the office \ud800 ") == "paid at the office"
    assert _stored_text(None) == "" and _stored_text("  ملاحظة  ") == "ملاحظة"


def test_a_tab_from_before_the_release_gets_the_reload_notice_instead_of_a_new_lazy_bundle():
    """A tab opened before a deploy asks with the OLD main bundle's version. The new bundle could stop
    half-way inside the old page (a dead menu until a manual reload); it now gets a small script that
    says a new version is available. The right version and no version still get the bundle."""
    from fastapi.testclient import TestClient

    import server.main as main_module

    client = TestClient(main_module.app)
    version = main_module._asset_version(main_module._select_script_source())
    for name in ("studio.js", "studio-staff.js", "studio-pages.js", "clothes.js", "admin-tools.js", "meta-tools.js"):
        stale = client.get(f"/{name}", params={"v": "0ld" + version[:-3]})
        assert stale.status_code == 200, name
        assert stale.headers["content-type"].startswith("application/javascript"), name
        assert "no-store" in stale.headers.get("cache-control", ""), name  # never cached under the old address
        assert stale.text == main_module._STALE_BUILD_SCRIPT, name
        current = client.get(f"/{name}", params={"v": version})
        assert current.status_code == 200 and "__albayanStaleBuild" not in current.text[:2000], name
        assert len(current.text) > 10 * len(stale.text), name
        assert len(client.get(f"/{name}").text) == len(current.text), name
    notice = main_module._STALE_BUILD_SCRIPT
    assert "window.__albayanStaleBuild = true" in notice and "window.location.reload()" in notice
    assert "innerHTML" not in notice and "يتوفر إصدار جديد" in notice


def test_new_passwords_everyone_tries_first_are_refused():
    """The public repository's old documents name "123456" / "12345678" as the login, and the server
    accepted any 8 characters. A NEW password that is a well-known one, a straight run, one or two
    repeated characters, a few digits, or the account's own name is refused in every place one is set."""
    from server.security import WEAK_PASSWORD_DETAIL, weak_password_reason

    weak = {"12345678": "common", "password123": "common", "Qwerty123": "common", "aaaaaaaa": "repeated", "12121212": "repeated",
            "abcdefgh": "common", "23456789": "digits", "hgfedcba": "sequence", "bcdefghij": "sequence", "01011990": "digits", "091234567": "digits",
            "Albayan2026!": "guessable", "admin@123": "common", "Admin#2027": "guessable", "short1!": "short", "١٢٣٤٥٦٧٨": "digits"}
    for password, reason in weak.items():
        assert weak_password_reason(password) == reason, (password, weak_password_reason(password))
    # The account's own name or e-mail name followed by digits is a first guess too.
    assert weak_password_reason("bashir1999", "bashir@example.com", "Someone Else") == "guessable"
    assert weak_password_reason("Mahmoud2026", "x@example.com", "Mahmoud Ali") == "guessable"
    for strong in ("TestPassword123!Secure", "E2eAdminPassword123!", "correct horse battery", "0912345678901", "Tr1poli-Harbour", "مرحبا-بالعالم-٢٠٢٦"):
        assert weak_password_reason(strong, "owner@example.com", "Owner Name") is None, strong
    assert "كلمة المرور" in WEAK_PASSWORD_DETAIL and "too easy to guess" in WEAK_PASSWORD_DETAIL


def test_weak_passwords_are_refused_by_the_routes_that_set_one():
    import secrets as _secrets

    from fastapi.testclient import TestClient
    from sqlalchemy import text

    import server.main as main_module
    from server.db import db_conn, init_db, json_dumps, now_ms
    from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

    init_db()
    client = TestClient(main_module.app, headers={"Origin": "http://testserver"}, client=("192.0.2.91", 50000))
    tag = _secrets.token_hex(4)
    old_password = "Hunt2026-Start-Password!"
    pw = hash_password(old_password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    admin_id, email = new_id("user"), f"weakpw-admin-{tag}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) "
                 "VALUES (:id,'Weak Admin',:email,'Admin',:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": admin_id, "email": email, "perm": json_dumps({}), "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo,
             "i": pw.iterations, "t": now_ms()},
        )
    login = client.post("/api/auth/login", json={"email": email, "password": old_password})
    assert login.status_code == 200, login.text
    cookies = {"albayan_session": login.cookies.get("albayan_session")}
    client.cookies.clear()

    new_email = f"weakpw-staff-{tag}@tests.albayanhub.com"
    for password in ("12345678", "password123", "weakpw2026"):  # the last one: the e-mail's own first word
        made = client.post("/api/users", json={"name": "Weakpw Staff", "email": new_email, "password": password, "role": "Employee"}, cookies=cookies)
        assert made.status_code == 400 and "too easy to guess" in made.text and "كلمة المرور" in made.text, (password, made.text)
    made = client.post("/api/users", json={"name": "Weakpw Staff", "email": new_email, "password": "Harbour-Lamp-4471", "role": "Employee"}, cookies=cookies)
    assert made.status_code == 200, made.text
    staff_id = made.json()["id"]
    assert client.patch(f"/api/users/{staff_id}", json={"password": "11111111"}, cookies=cookies).status_code == 400
    assert client.patch(f"/api/users/{staff_id}", json={"password": "Harbour-Lamp-4472"}, cookies=cookies).status_code == 200
    refused = client.post("/api/auth/password-change", json={"currentPassword": old_password, "newPassword": "qwerty123"}, cookies=cookies)
    assert refused.status_code == 400 and "too easy to guess" in refused.text, refused.text
    # Nothing changed: the old password still signs in.
    assert client.post("/api/auth/login", json={"email": email, "password": old_password}).status_code == 200
    client.cookies.clear()
    with db_conn() as conn:
        for uid in (admin_id, staff_id):
            conn.execute(text("DELETE FROM sessions WHERE user_id = :u"), {"u": uid})
            conn.execute(text("UPDATE users SET deleted = true WHERE id = :u"), {"u": uid})


def test_an_own_customers_only_account_cannot_hang_records_on_a_customer_it_cannot_see():
    """Round 3 sweep: customers.viewOwn plus receipts.add / ads.add was enough to put a receipt or an ad
    on ANY customer whose id the account knew (pages list customer ids), and the answer came back with
    that customer's name on it. The customer record itself was already refused (403)."""
    import secrets as _secrets

    from fastapi.testclient import TestClient
    from sqlalchemy import text

    import server.main as main_module
    from server.db import db_conn, init_db, json_dumps, now_ms
    from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

    init_db()
    client = TestClient(main_module.app, headers={"Origin": "http://testserver"}, client=("192.0.2.92", 50000))
    tag = _secrets.token_hex(4)
    password = "Hunt2026-Own-Only-Password!"
    pw = hash_password(password, iterations=PBKDF2_ITERATIONS_DEFAULT)
    own = {"customers": ["viewOwn", "add", "editOwn"], "receipts": ["viewOwn", "add", "editOwn"], "ads": ["viewOwn", "add", "editOwn"]}

    def account(label: str, role: str, permissions: dict) -> dict:
        uid, email = new_id("user"), f"ownonly-{label}-{tag}@tests.albayanhub.com"
        with db_conn() as conn:
            conn.execute(
                text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                     "password_iterations,deleted,created_at,created_by,last_modified) "
                     "VALUES (:id,:name,:email,:role,:perm,:h,:s,:a,:i,false,:t,NULL,:t)"),
                {"id": uid, "name": f"Own {label}", "email": email, "role": role, "perm": json_dumps(permissions), "h": pw.hash_hex,
                 "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()},
            )
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200, login.text
        cookies = {"albayan_session": login.cookies.get("albayan_session")}
        client.cookies.clear()
        return {"id": uid, "cookies": cookies}

    admin, agent, viewer = account("admin", "Admin", {}), account("agent", "Employee", own), account("viewer", "Employee", {**own, "customers": ["view", "add"]})
    phone = lambda: "092" + str(_secrets.randbelow(10**7)).zfill(7)  # noqa: E731

    def customer(who: dict, name: str) -> str:
        made = client.post("/api/collections/customers", json={"data": {"name": name, "phone": phone()}}, cookies=who["cookies"])
        assert made.status_code == 200, made.text
        return made.json()["id"]

    def receipt(who: dict, customer_id: str):
        return client.post("/api/collections/receipts", json={"data": {
            "recordType": "receipt", "customerId": customer_id, "status": "Paid", "isPaid": True, "amountUSD": 5, "amountLocal": 25,
            "exchangeRate": 5, "serialNumber": str(810000 + _secrets.randbelow(99999))}}, cookies=who["cookies"])

    def ad(who: dict, customer_id: str):
        return client.post("/api/ads/mutate", json={"action": "create", "adId": new_id("ads"), "idempotencyKey": f"ownonly-{_secrets.token_hex(6)}",
                                                    "data": {"customerId": customer_id, "amountUSD": 0, "status": "Active", "startDate": "2026-11-01"}},
                           cookies=who["cookies"])

    office_customer = customer(admin, f"Office Secret {tag}")
    own_customer = customer(agent, f"Agent Own {tag}")
    for attempt in (receipt(agent, office_customer), ad(agent, office_customer)):
        assert attempt.status_code == 403 and "do not have access" in attempt.text, attempt.text
        assert f"Office Secret {tag}" not in attempt.text
    # Its own customer, an account that sees every customer, and the Admin are not affected.
    mine = receipt(agent, own_customer)
    assert mine.status_code == 200, mine.text
    assert ad(agent, own_customer).status_code == 200
    assert receipt(viewer, office_customer).status_code == 200
    assert receipt(admin, office_customer).status_code == 200
    # Moving its own receipt onto the unseen customer is refused too; an edit that keeps the customer is not.
    moved = client.patch(f"/api/collections/receipts/{mine.json()['id']}", json={"data": {"customerId": office_customer},
                         "expectedLastModified": mine.json()["lastModified"]}, cookies=agent["cookies"])
    assert moved.status_code == 403, moved.text
    kept = client.patch(f"/api/collections/receipts/{mine.json()['id']}", json={"data": {"customerId": own_customer, "notes": "kept"},
                        "expectedLastModified": mine.json()["lastModified"]}, cookies=agent["cookies"])
    assert kept.status_code == 200, kept.text
    # A malformed customer id is an ordinary refusal, never a crash (found by fuzzing this very check).
    for odd in ("\ud800", "a b", "x" * 300, 5, ["c"], {"id": 1}):
        raw = __import__("json").dumps({"action": "create", "adId": new_id("ads"), "idempotencyKey": f"ownonly-{_secrets.token_hex(6)}",
                                        "data": {"customerId": odd, "amountUSD": 0, "status": "Active"}}).encode("utf-8")
        answer = client.post("/api/ads/mutate", content=raw, headers={"Content-Type": "application/json"}, cookies=agent["cookies"])
        assert answer.status_code in (400, 403, 404, 409, 422), (odd if not isinstance(odd, str) else odd[:8], answer.status_code, answer.text[:160])
    with db_conn() as conn:
        for who in (admin, agent, viewer):
            conn.execute(text("DELETE FROM sessions WHERE user_id = :u"), {"u": who["id"]})
            conn.execute(text("UPDATE users SET deleted = true WHERE id = :u"), {"u": who["id"]})
            conn.execute(text("UPDATE entities SET deleted = true WHERE created_by = :u"), {"u": who["id"]})
