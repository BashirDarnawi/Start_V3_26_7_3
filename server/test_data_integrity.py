import json

from server.data_integrity import scan_entity_rows


def _row(kind, entity_id, data, deleted=False):
    return {"type": kind, "id": entity_id, "data_json": json.dumps(data), "deleted": deleted}


def test_clean_customer_receipt_and_ad_relationships_pass():
    result = scan_entity_rows(
        [
            _row("customers", "c1", {"name": "One", "phones": ["091-000-0000"]}),
            _row("receipts", "r1", {"customerId": "c1", "serialNumber": "١٢٣", "exchangeRate": "9.7"}),
            _row("ads", "a1", {"customerId": "c1", "receiptAllocations": [{"receiptId": "r1", "amountUSD": 10}]}),
        ]
    )
    assert result["ok"] is True
    assert result["recordsChecked"] == 3


def test_duplicate_identities_and_broken_links_are_reported_without_pii():
    result = scan_entity_rows(
        [
            _row("customers", "c1", {"phone": "0910000000"}),
            _row("customers", "c2", {"phones": [{"value": "٠٩١٠٠٠٠٠٠٠"}]}),
            _row("receipts", "r1", {"customerId": "missing", "serialNumber": "55", "exchangeRate": 0}),
            _row("receipts", "r2", {"customerId": "c1", "finalReceiptNo": "٥٥"}),
            _row("ads", "a1", {"customerId": "missing", "receiptId": "gone"}),
        ]
    )
    codes = [item["code"] for item in result["issues"]]
    assert result["ok"] is False
    assert codes.count("duplicate_customer_phone") == 2
    assert codes.count("duplicate_receipt_number") == 2
    assert "missing_customer" in codes
    assert "missing_receipt" in codes
    assert "invalid_exchange_rate" in codes
    assert "0910000000" not in json.dumps(result)


def test_deleted_records_do_not_create_false_duplicate_or_link_targets():
    result = scan_entity_rows(
        [
            _row("customers", "old", {"phone": "0910000000"}, deleted=True),
            _row("customers", "active", {"phone": "0910000000"}),
        ]
    )
    assert result["ok"] is True


def test_receipt_prefixes_remain_part_of_the_unique_number():
    result = scan_entity_rows(
        [
            _row("receipts", "bank", {"serialNumber": "B٥٥"}),
            _row("receipts", "service", {"serialNumber": "S55"}),
        ]
    )
    assert result["ok"] is True
