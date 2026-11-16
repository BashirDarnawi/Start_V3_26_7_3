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
