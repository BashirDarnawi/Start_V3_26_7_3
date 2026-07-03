#!/usr/bin/env python3
"""
Performance optimization: Create GIN indexes on JSONB data for faster queries.
Run this once after upgrading to improve query performance on Postgres.

For SQLite (dev mode), this script is safe to run but won't create the indexes.
"""

from .db import db_conn, get_engine
from sqlalchemy import text


def create_performance_indexes():
    """
    Create indexes on commonly-queried JSONB fields (Postgres only).
    
    These indexes speed up queries like:
    - Finding receipts by deliveryPersonId
    - Finding ads by customerId
    - Finding entities by status/deliveryStatus
    """
    engine = get_engine()
    dialect = str(engine.dialect.name or "")
    
    if dialect != "postgresql":
        print("⚠️  Not Postgres - skipping JSONB indexes (only needed for production)")
        return
    
    indexes_to_create = [
        # Receipts: delivery queries
        ("entities_receipts_delivery_person", 
         "CREATE INDEX IF NOT EXISTS entities_receipts_delivery_person ON entities USING gin ((data_json->'deliveryPersonId')) WHERE type = 'receipts' AND deleted = false"),
        
        ("entities_receipts_delivery_status",
         "CREATE INDEX IF NOT EXISTS entities_receipts_delivery_status ON entities USING gin ((data_json->'deliveryStatus')) WHERE type = 'receipts' AND deleted = false"),
        
        ("entities_receipts_customer",
         "CREATE INDEX IF NOT EXISTS entities_receipts_customer ON entities USING gin ((data_json->'customerId')) WHERE type = 'receipts' AND deleted = false"),
        
        # Ads: common queries
        ("entities_ads_customer",
         "CREATE INDEX IF NOT EXISTS entities_ads_customer ON entities USING gin ((data_json->'customerId')) WHERE type = 'ads' AND deleted = false"),
        
        ("entities_ads_page",
         "CREATE INDEX IF NOT EXISTS entities_ads_page ON entities USING gin ((data_json->'pageId')) WHERE type = 'ads' AND deleted = false"),
        
        ("entities_ads_status",
         "CREATE INDEX IF NOT EXISTS entities_ads_status ON entities USING gin ((data_json->'status')) WHERE type = 'ads' AND deleted = false"),
        
        # General: created_by queries (for viewOwn permissions)
        ("entities_type_created_by_composite",
         "CREATE INDEX IF NOT EXISTS entities_type_created_by_composite ON entities (type, created_by) WHERE deleted = false"),
    ]
    
    with db_conn() as conn:
        created = 0
        for name, sql in indexes_to_create:
            try:
                conn.execute(text(sql))
                print(f"✅ Created index: {name}")
                created += 1
            except Exception as e:
                # Index might already exist, that's fine
                print(f"⚠️  Index {name}: {str(e)[:80]}")
    
    print(f"\n✅ Performance optimization complete! ({created} indexes created)")
    print("   Queries on deliveryPersonId, customerId, status will now be faster.")


if __name__ == "__main__":
    print("🚀 Creating performance indexes...")
    print()
    create_performance_indexes()

