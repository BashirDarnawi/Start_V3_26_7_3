"""Focused read-only sync regressions; run only with an isolated test database."""

from contextlib import contextmanager

import pytest
from sqlalchemy import event, text

from server import main
from server.db import db_conn, get_engine, init_db, json_dumps


PREFIX = "third_sync_"
VERSION = 100_000


def _user(uid="owner", *, role="Employee", permissions=None):
    return {
        "id": PREFIX + uid,
        "role": role,
        "permissions_json": json_dumps(permissions or {}),
    }


@pytest.fixture(scope="module", autouse=True)
def schema():
    init_db()


@pytest.fixture
def records():
    inserted = []

    def insert(collection, suffix, data, *, creator="owner", deleted=False, version=VERSION):
        row = {
            "type": collection,
            "id": PREFIX + suffix,
            "data": json_dumps(data),
            "creator": PREFIX + creator,
            "deleted": deleted,
            "version": version,
        }
        inserted.append(row)
        return row["id"]

    def save():
        with db_conn() as conn:
            conn.execute(text(
                "INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                "VALUES (:type,:id,:data,:deleted,7,:creator,:version)"
            ), inserted)

    yield insert, save
    with db_conn() as conn:
        for row in inserted:
            # These tests never alter raw JSON or modification metadata.
            stored = conn.execute(text(
                "SELECT data_json,deleted,created_at,created_by,last_modified "
                "FROM entities WHERE type=:type AND id=:id"
            ), row).mappings().one()
            assert stored["data_json"] == row["data"]
            assert bool(stored["deleted"]) == row["deleted"]
            assert stored["created_at"] == 7
            assert stored["created_by"] == row["creator"]
            assert stored["last_modified"] == row["version"]
        if inserted:
            conn.execute(text("DELETE FROM entities WHERE type=:type AND id=:id"), inserted)


@contextmanager
def _entity_reads():
    queries = []

    def capture(_conn, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT") and "FROM entities" in statement:
            queries.append((statement, parameters))

    event.listen(get_engine(), "before_cursor_execute", capture)
    try:
        yield queries
    finally:
        event.remove(get_engine(), "before_cursor_execute", capture)


def test_driver_bootstrap_keeps_more_than_one_thousand_referenced_customers(records):
    insert, save = records
    expected = set()
    for n in range(1005):
        cid = insert("customers", f"customer_{n:04d}", {"name": f"Legacy {n}", "extension": n})
        expected.add(cid)
        insert("ads" if n % 2 else "receipts", f"delivery_{n:04d}", {
            "customerId": cid, "deliveryPersonId": PREFIX + "driver",
        })
    save()
    with _entity_reads() as queries:
        rows = main._bootstrap_fetch_scoped("customers", _user("driver", role="Delivery"))
    assert {row["id"] for row in rows} == expected
    assert len(queries) == 2, "only two customer pages, without reloading delivery bodies"
    assert all(row["data"]["extension"] >= 0 for row in rows)


def test_driver_customer_membership_is_single_scan_and_keeps_scope(records):
    insert, save = records
    expected = set()
    for suffix, driver, deleted in (
        ("mine", "driver", False), ("other", "another", False),
        ("deleted_delivery", "driver", True),
    ):
        cid = insert("customers", suffix, {"name": suffix, "phone": "private contact"})
        insert("ads", "ad_" + suffix, {
            "customerId": cid, "deliveryPersonId": PREFIX + driver,
            "adPhotos": ["data:image/png;base64," + "A" * 50_000],
            "oldExtension": {"kept": True},
        }, deleted=deleted)
        if suffix == "mine":
            expected.add(cid)
            insert("receipts", "duplicate_ref", {
                "customerId": cid, "deliveryPersonId": PREFIX + driver,
            })
    insert("customers", "unreferenced", {"name": "Hidden"})
    deleted_customer = insert("customers", "deleted_customer", {"name": "Deleted"}, deleted=True)
    insert("receipts", "to_deleted", {
        "customerId": deleted_customer, "deliveryPersonId": PREFIX + "driver",
    })
    save()
    user = _user("driver", role="Delivery")
    with _entity_reads() as queries:
        rows = main._bootstrap_fetch_scoped("customers", user)
    assert {row["id"] for row in rows} == expected
    assert len(queries) == 1, "customer discovery must not deserialize ad/receipt bodies"

    # Match the existing collection endpoint, including contact redaction.
    listed = main.get_collection("customers", user=user)
    assert {row.id for row in listed} == expected
    assert all("phone" not in row.data for row in listed)
    # In delta mode a deleted customer still supplies its minimal tombstone.
    delta = main.get_collection("customers", user=user, updated_since=VERSION)
    tombstone = next(row for row in delta if row.id == deleted_customer)
    assert tombstone.deleted is True
    assert "name" not in tombstone.data


@pytest.mark.parametrize("read_kind", ["list", "watermark"])
def test_driver_customer_scope_does_not_correlate_delivery_scan(read_kind):
    if get_engine().dialect.name != "sqlite":
        pytest.skip("SQLite EXPLAIN QUERY PLAN assertion")
    with _entity_reads() as queries:
        if read_kind == "list":
            main.list_entities("customers", referenced_customer_by=PREFIX + "driver")
        else:
            with db_conn() as conn:
                main._sync_watermark_max(conn, "customers", referenced_customer_by=PREFIX + "driver")
    assert len(queries) == 1
    statement, parameters = queries[0]
    with db_conn() as conn:
        plan = conn.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters).all()
    details = "\n".join(str(row[-1]) for row in plan)
    assert "CORRELATED" not in details, details


def test_driver_membership_matches_previous_predicate_with_legacy_values(records):
    insert, save = records
    cid = insert("customers", "legacy_customer", {"name": "Legacy customer"}, version=VERSION + 1)
    for n, value in enumerate((cid, None, "", "missing", 7, [cid], {"id": cid})):
        insert("ads", f"legacy_ref_{n}", {
            "customerId": value, "deliveryPersonId": PREFIX + "driver",
        })
    insert("customers", "legacy_hidden", {"name": "Hidden"}, version=VERSION + 100)
    save()
    dialect = get_engine().dialect.name
    customer_expr = "d.data_json::jsonb ->> 'customerId'" if dialect == "postgresql" else "json_extract(d.data_json, '$.customerId')"
    assigned_expr = "d.data_json::jsonb ->> 'deliveryPersonId'" if dialect == "postgresql" else "json_extract(d.data_json, '$.deliveryPersonId')"
    with db_conn() as conn:
        previous = conn.execute(text(
            "SELECT e.id FROM entities e WHERE e.type='customers' AND e.deleted=false "
            "AND EXISTS (SELECT 1 FROM entities d WHERE d.type IN ('ads','receipts') "
            f"AND d.deleted=false AND ({customer_expr})=e.id AND ({assigned_expr})=:uid)"
        ), {"uid": PREFIX + "driver"}).scalars().all()
        watermark = main._sync_watermark_max(conn, "customers", referenced_customer_by=PREFIX + "driver")
    current = main.list_entities("customers", referenced_customer_by=PREFIX + "driver")
    assert {row["id"] for row in current} == set(previous) == {cid}
    assert watermark == VERSION + 1, "unassigned customers must not move this driver's cursor"


@pytest.mark.parametrize("status", [None, "Draft", "Changes Requested", "Submitted"])
@pytest.mark.parametrize("grant", ["viewOwn", "view"])
def test_campaign_owner_delta_keeps_own_private_records(records, status, grant):
    insert, save = records
    data = {"name": "Private legacy draft", "creativeImages": ["old-photo"], "extension": {"kept": True}}
    if status is not None:
        data["status"] = status
    cid = insert("adCampaignRequests", "campaign", data)
    save()
    user = _user(permissions={"adCampaignRequests": [grant]})
    full = next(row for row in main.get_collection("adCampaignRequests", user=user) if row.id == cid)
    delta = next(row for row in main.get_collection(
        "adCampaignRequests", user=user, updated_since=VERSION
    ) if row.id == cid)
    assert delta.deleted is False, "the owner's draft must not disappear during live sync"
    assert delta.model_dump() == full.model_dump()
    assert delta.data["extension"] == {"kept": True}
    assert delta.lastModified == delta.data["_lastModified"] == VERSION
    assert delta.data["_photoCount"] == 1
    assert "creativeImages" not in delta.data


@pytest.mark.parametrize("role,grant", [("Employee", "view"), ("Admin", "view")])
def test_campaign_delta_privacy_tombstones_and_tied_keyset(records, role, grant):
    insert, save = records
    ids = {}
    for suffix, status, deleted, creator in (
        ("a_own_draft", "Draft", False, "owner"),
        ("b_other_draft", "Draft", False, "other"),
        ("c_other_changes", "Changes Requested", False, "other"),
        ("d_other_submitted", "Submitted", False, "other"),
        ("e_own_deleted", "Draft", True, "owner"),
    ):
        ids[suffix] = insert("adCampaignRequests", suffix, {
            "name": "Secret " + suffix, "status": status, "creativeImages": ["old-photo"],
        }, creator=creator, deleted=deleted)
    save()
    user = _user(role=role, permissions={"adCampaignRequests": [grant]})
    rows = []
    cursor = {}
    pages = 0
    own = set(ids.values())
    while True:
        page = main.get_collection("adCampaignRequests", user=user, updated_since=VERSION, limit=1, **cursor)
        if not page:
            break
        rows.extend(row for row in page if row.id in own)  # the shared test DB also holds other modules' campaigns
        cursor = {"after_last_modified": page[-1].lastModified, "after_id": page[-1].id}
        pages += 1
        assert pages <= 2000, "tied modification versions must still advance"
    by_id = {row.id: row for row in rows}
    expected = set(ids.values())
    if role != "Admin":
        expected.remove(ids["b_other_draft"])
    assert set(by_id) == expected
    assert len(rows) == len(expected)
    assert by_id[ids["a_own_draft"]].deleted is False
    assert by_id[ids["d_other_submitted"]].deleted is False
    assert by_id[ids["e_own_deleted"]].deleted is True
    assert "name" not in by_id[ids["e_own_deleted"]].data
    changes = by_id[ids["c_other_changes"]]
    assert changes.deleted is (role != "Admin")
    if role != "Admin":
        assert "name" not in changes.data
        assert "creativeImages" not in changes.data


def test_compatibility_version_publishes_fix_and_full_read_recovers_unchanged_campaign(records):
    insert, save = records
    cid = insert("adCampaignRequests", "old_cached_draft", {"name": "Unchanged old draft"})
    save()
    user = _user(permissions={"adCampaignRequests": ["viewOwn"]})
    from server.data_compatibility import DATA_COMPATIBILITY_VERSION

    published = main.get_sync_watermarks(user=user)
    assert published["dataCompatibilityVersion"] == DATA_COMPATIBILITY_VERSION
    assert DATA_COMPATIBILITY_VERSION >= 2  # version 1 clients may have removed their own drafts
    # An authoritative full read includes rows older than the cursor; no
    # synthetic write/version increment is needed or allowed. The client must
    # use its normal full reload if it already cached an equal-version deletion.
    assert not main.get_collection("adCampaignRequests", user=user, updated_since=VERSION + 20_000)
    restored = next(row for row in main.get_collection("adCampaignRequests", user=user) if row.id == cid)
    assert restored.deleted is False and restored.lastModified == VERSION
