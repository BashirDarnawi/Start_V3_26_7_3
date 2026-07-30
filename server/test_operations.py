import base64
import secrets

import pytest
from fastapi import HTTPException

import server.operations as operations


def test_encrypted_backup_round_trip(tmp_path):
    pytest.importorskip("cryptography")
    source = tmp_path / "database.dump"
    encrypted = tmp_path / "database.backup.aesgcm"
    restored = tmp_path / "restored.dump"
    source.write_bytes(b"Albayan backup test\x00\x01" * 100)
    key = secrets.token_bytes(32)

    operations._encrypt_backup(source, encrypted, key)
    operations.decrypt_backup_file(encrypted, restored, key)

    assert restored.read_bytes() == source.read_bytes()
    assert source.read_bytes() not in encrypted.read_bytes()


def test_backup_key_requires_exactly_32_bytes(monkeypatch):
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"short").decode())
    assert operations._backup_key() is None
    monkeypatch.setenv("ALBAYAN_BACKUP_KEY", base64.urlsafe_b64encode(b"x" * 32).decode().rstrip("="))
    assert operations._backup_key() == b"x" * 32


def test_closed_month_rejects_financial_change(monkeypatch):
    monkeypatch.setattr(operations, "_close_record", lambda period, conn=None: {"status": "closed", "period": period})
    with pytest.raises(HTTPException) as error:
        operations.assert_financial_period_open("receipts", {"date": "2026-06-15"})
    assert error.value.status_code == 423
    assert "2026-06" in str(error.value.detail)


def test_non_financial_or_open_month_is_allowed(monkeypatch):
    monkeypatch.setattr(operations, "_close_record", lambda period, conn=None: {"status": "open", "period": period})
    operations.assert_financial_period_open("receipts", {"date": "2026-06-15"})
    operations.assert_financial_period_open("customers", {"date": "2026-06-15"})


def test_maintenance_skips_closed_financial_rows_under_period_lock(monkeypatch):
    locked = []
    monkeypatch.setattr(operations, "_lock_financial_period", lambda conn, period: locked.append(period))
    monkeypatch.setattr(operations, "_close_record", lambda period, conn=None: {"status": "closed"})
    assert operations.financial_period_is_closed("ads", {"startDate": "2026-06-15"}, conn=object()) is True
    assert locked == ["2026-06"]


def test_privacy_redaction_locks_period_without_reopening_money(monkeypatch):
    locked = []
    monkeypatch.setattr(operations, "_lock_financial_period", lambda conn, period: locked.append(period))
    operations.lock_financial_period_for_redaction("receipts", {"date": "2026-06-15"}, conn=object())
    assert locked == ["2026-06"]
