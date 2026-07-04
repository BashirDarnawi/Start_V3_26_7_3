"""
Add GIN indexes for JSONB columns in Postgres (performance optimization).

Run this once after upgrading to add indexes for commonly-queried JSON fields.
This significantly speeds up queries that filter by deliveryStatus, customerId, etc.

Usage:
    python3 -m server.add_jsonb_indexes
"""
from .db import db_conn, get_engine
from sqlalchemy import text


def add_jsonb_indexes():
    """
    Add GIN indexes for Postgres JSONB queries.
    Safe to run multiple times (uses IF NOT EXISTS).
    """
    engine = get_engine()
    dialect = str(engine.dialect.name or "")
    
    if dialect != "postgresql":
        print(f"⚠️  Skipping: JSONB indexes are Postgres-only (current: {dialect})")
        return
    
    indexes = [
        # Receipts: commonly filtered by deliveryStatus, customerId, deliveryPersonId
        # NOTE: Use ->> operator (returns TEXT) instead of -> (returns JSONB)
        ("idx_receipts_delivery_status", "receipts", "((data_json::jsonb->>'deliveryStatus'))"),
        ("idx_receipts_customer_id", "receipts", "((data_json::jsonb->>'customerId'))"),
        ("idx_receipts_delivery_person", "receipts", "((data_json::jsonb->>'deliveryPersonId'))"),
        ("idx_receipts_temp_no", "receipts", "((data_json::jsonb->>'tempReceiptNo'))"),
        ("idx_receipts_serial_no", "receipts", "((data_json::jsonb->>'serialNumber'))"),
        
        # Ads: commonly filtered by customerId, pageId, status
        ("idx_ads_customer_id", "ads", "((data_json::jsonb->>'customerId'))"),
        ("idx_ads_page_id", "ads", "((data_json::jsonb->>'pageId'))"),
        ("idx_ads_status", "ads", "((data_json::jsonb->>'status'))"),
        ("idx_ads_delivery_person", "ads", "((data_json::jsonb->>'deliveryPersonId'))"),
        
        # Customers: commonly searched by name (using jsonb_path_ops for GIN)
        ("idx_customers_name", "customers", "((data_json::jsonb->>'name'))"),  # B-tree index for exact/prefix matches
        ("idx_customers_phone", "customers", "((data_json::jsonb->>'phones'))"),  # Phone search
    ]
    
    # FINANCIAL-INTEGRITY GUARANTEE: receipt numbers must be unique.
    # The application already checks before writing, but two simultaneous
    # requests can both pass that check (race window). These partial UNIQUE
    # indexes turn that race into a database-level impossibility; the API
    # translates the violation into the same 409 the normal check produces.
    # NOTE: creation FAILS if existing duplicate receipt numbers are present —
    # in that case a clear warning is printed and the app keeps running with
    # the old (check-only) behavior until the duplicates are cleaned up.
    unique_indexes = [
        ("uq_receipts_serial_no", "((data_json::jsonb->>'serialNumber'))",
         "type = 'receipts' AND deleted = false AND COALESCE(data_json::jsonb->>'serialNumber', '') <> ''"),
        ("uq_receipts_final_no", "((data_json::jsonb->>'finalReceiptNo'))",
         "type = 'receipts' AND deleted = false AND COALESCE(data_json::jsonb->>'finalReceiptNo', '') <> ''"),
        ("uq_receipts_temp_no", "((data_json::jsonb->>'tempReceiptNo'))",
         "type = 'receipts' AND deleted = false AND COALESCE(data_json::jsonb->>'tempReceiptNo', '') <> ''"),
    ]

    print("Adding JSONB indexes for Postgres...")

    with db_conn() as conn:
        for index_info in indexes:
            # All indexes are now expression-based (B-tree on JSONB fields)
            index_name, entity_type, expression = index_info
            sql = f"""
            CREATE INDEX IF NOT EXISTS {index_name}
            ON entities ({expression})
            WHERE type = '{entity_type}' AND deleted = false
            """

            try:
                conn.execute(text(sql))
                print(f"✅ Created index: {index_name}")
            except Exception as e:
                print(f"⚠️  Skipped {index_name}: {e}")

    for index_name, expression, where in unique_indexes:
        sql = f"""
        CREATE UNIQUE INDEX IF NOT EXISTS {index_name}
        ON entities ({expression})
        WHERE {where}
        """
        try:
            # Separate connection per unique index: a duplicate-data failure
            # aborts the transaction, and we don't want it to poison the rest.
            with db_conn() as conn:
                conn.execute(text(sql))
            print(f"✅ Created unique index: {index_name}")
        except Exception as e:
            print(f"⚠️  Could not create UNIQUE index {index_name} — most likely because "
                  f"duplicate receipt numbers already exist in the database. Duplicate "
                  f"protection stays application-level until this is resolved. Error: {e}")
    
    print("\n🎉 JSONB indexes added successfully!")
    print("Query performance should be significantly improved for:")
    print("  - Delivery filtering (by status, driver, customer)")
    print("  - Receipt searches (by number, customer)")
    print("  - Ad filtering (by status, page, customer)")


if __name__ == "__main__":
    add_jsonb_indexes()

