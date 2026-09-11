"""Frozen cryptography-47 backups must remain usable after security upgrades.

All keys, plaintext, and nonces here are deliberately public synthetic test
data. Never use these deterministic values for a real backup.
"""

import pytest

from server import operations


FIXTURE_KEY = bytes(range(32))
FIXTURE_PAYLOAD = b"Albayan backup compatibility fixture: v47 to v50."
# Generated with cryptography 47.0.0 before upgrading to 50.0.1. Keeping fixed
# ciphertext (rather than encrypting it with the version under test) detects
# accidental changes to the format, AAD, nonce, tag, and key interpretation.
V1_FROM_CRYPTOGRAPHY_47 = bytes.fromhex(
    "414c424159414e424b31000102030405060708090a0b"
    "066eb47abc84ac3bef20f4e0c499580eecbbf75584123d15540e91fc3d0f69ca"
    "7565dc9995e164ac43840b82a8f11d08c0970a99f5aa5ae072d71e67c990c16db8"
)
V2_FROM_CRYPTOGRAPHY_47 = bytes.fromhex(
    "414c424159414e424b32616263646566676800000010"
    "00000010fc7ed3c6f8e1f5f6a7d7b7b94c085f118392ba969aacc18ec3a476112a513769"
    "00000010d9151c4501fec69df9ec2e69737ad8422c66c5596d32b4ab72218fadf7d07c5c"
    "00000010a8fafabdf65ce6d6a90ac7e0fa75d497b84fc9b5fafe60619ed52e4c3e086d6a"
    "0000000172e5b99c3081b8cd8676a626df23004684"
    "000000003a05b670f9788294177f184628ff1bd9"
)


@pytest.mark.parametrize("ciphertext", [V1_FROM_CRYPTOGRAPHY_47, V2_FROM_CRYPTOGRAPHY_47], ids=["v1", "v2"])
def test_frozen_old_backup_restores_with_the_same_key(tmp_path, ciphertext):
    source = tmp_path / "old.backup.aesgcm"
    target = tmp_path / "restored.dump"
    source.write_bytes(ciphertext)
    operations.decrypt_backup_file(source, target, FIXTURE_KEY)
    assert target.read_bytes() == FIXTURE_PAYLOAD


@pytest.mark.parametrize("ciphertext", [V1_FROM_CRYPTOGRAPHY_47, V2_FROM_CRYPTOGRAPHY_47], ids=["v1", "v2"])
@pytest.mark.parametrize("failure", ["wrong-key", "tampered-tag"])
def test_old_backup_authentication_still_fails_closed(tmp_path, ciphertext, failure):
    source = tmp_path / "old.backup.aesgcm"
    target = tmp_path / "restored.dump"
    target.write_bytes(b"Do not replace this valid prior restore")
    key = FIXTURE_KEY
    if failure == "wrong-key":
        key = bytes(reversed(key))
    else:
        ciphertext = ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
    source.write_bytes(ciphertext)
    with pytest.raises(ValueError, match="authentication failed"):
        operations.decrypt_backup_file(source, target, key)
    assert target.read_bytes() == b"Do not replace this valid prior restore"
    assert not list(tmp_path.glob(".*.tmp"))


def test_new_writer_preserves_v2_wire_format(tmp_path, monkeypatch):
    source = tmp_path / "database.dump"
    target = tmp_path / "new.backup.aesgcm"
    source.write_bytes(FIXTURE_PAYLOAD)
    monkeypatch.setattr(operations, "_BACKUP_CHUNK_SIZE", 16)
    monkeypatch.setattr(operations.secrets, "token_bytes", lambda size: b"abcdefgh")
    operations._encrypt_backup(source, target, FIXTURE_KEY)
    assert target.read_bytes() == V2_FROM_CRYPTOGRAPHY_47
