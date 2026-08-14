import base64
import secrets
from pathlib import Path

import pytest
from fastapi import HTTPException

import server.operations as operations


def test_encrypted_backup_round_trip_across_multiple_chunks(tmp_path):
    pytest.importorskip("cryptography")
    source = tmp_path / "database.dump"
    encrypted = tmp_path / "database.backup.aesgcm"
    restored = tmp_path / "restored.dump"
    payload = secrets.token_bytes(operations._BACKUP_CHUNK_SIZE * 2 + 12345)
    source.write_bytes(payload)
    key = secrets.token_bytes(32)

    operations._encrypt_backup(source, encrypted, key)
    operations.decrypt_backup_file(encrypted, restored, key)

    assert restored.read_bytes() == payload
    assert encrypted.read_bytes().startswith(operations._BACKUP_MAGIC_V2)
    assert payload[: operations._BACKUP_CHUNK_SIZE] not in encrypted.read_bytes()


def test_decrypt_backup_keeps_v1_compatibility(tmp_path):
    pytest.importorskip("cryptography")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    source = tmp_path / "legacy.backup.aesgcm"
    restored = tmp_path / "legacy-restored.dump"
    payload = secrets.token_bytes(operations._BACKUP_CHUNK_SIZE + 117)
    key = secrets.token_bytes(32)
    nonce = secrets.token_bytes(operations._BACKUP_NONCE_SIZE)
    source.write_bytes(
        operations._BACKUP_MAGIC
        + nonce
        + AESGCM(key).encrypt(nonce, payload, operations._BACKUP_MAGIC)
    )

    operations.decrypt_backup_file(source, restored, key)

    assert restored.read_bytes() == payload


def test_backup_streaming_does_not_use_path_read_bytes(tmp_path, monkeypatch):
    pytest.importorskip("cryptography")
    source = tmp_path / "database.dump"
    encrypted = tmp_path / "database.backup.aesgcm"
    restored = tmp_path / "restored.dump"
    source.write_bytes(b"streamed backup" * 1000)
    key = secrets.token_bytes(32)

    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda self: (_ for _ in ()).throw(AssertionError("read_bytes must not be used")),
    )
    operations._encrypt_backup(source, encrypted, key)
    operations.decrypt_backup_file(encrypted, restored, key)

    with restored.open("rb") as restored_stream:
        assert restored_stream.read() == b"streamed backup" * 1000


def test_tampered_backup_does_not_replace_target_or_leave_temp_file(tmp_path):
    pytest.importorskip("cryptography")
    source = tmp_path / "database.dump"
    encrypted = tmp_path / "database.backup.aesgcm"
    restored = tmp_path / "restored.dump"
    source.write_bytes(secrets.token_bytes(operations._BACKUP_CHUNK_SIZE + 53))
    restored.write_bytes(b"existing safe restore")
    key = secrets.token_bytes(32)
    operations._encrypt_backup(source, encrypted, key)

    with encrypted.open("r+b") as encrypted_stream:
        encrypted_stream.seek(-1, 2)
        final_byte = encrypted_stream.read(1)
        encrypted_stream.seek(-1, 2)
        encrypted_stream.write(bytes([final_byte[0] ^ 1]))

    with pytest.raises(ValueError, match="authentication failed"):
        operations.decrypt_backup_file(encrypted, restored, key)

    assert restored.read_bytes() == b"existing safe restore"
    assert list(tmp_path.glob(f".{restored.name}.*.tmp")) == []


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
