import hashlib
import sqlite3

from server.ops_backup import create_backup, verify_backup


def test_sqlite_backup_is_consistent_checksummed_and_verifiable(tmp_path, monkeypatch):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as conn:
        conn.execute("CREATE TABLE receipts (id TEXT PRIMARY KEY, amount INTEGER NOT NULL)")
        conn.execute("INSERT INTO receipts VALUES ('r1', 950)")
    monkeypatch.setenv("ALBAYAN_DB_PATH", str(source))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ALBAYAN_DATABASE_URL", raising=False)
    for name in (
        "ALBAYAN_DB_HOST", "ALBAYAN_DB_PORT", "ALBAYAN_DB_NAME",
        "ALBAYAN_DB_USER", "ALBAYAN_DB_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)

    result = create_backup(tmp_path / "backups", retention_days=30)
    backup = next((tmp_path / "backups").glob("*.sqlite3"))
    assert result["ok"] is True
    assert verify_backup(backup)["ok"] is True
    assert backup.with_suffix(".sqlite3.sha256").exists()
    assert result["sha256"] == hashlib.sha256(backup.read_bytes()).hexdigest()
    with sqlite3.connect(backup) as conn:
        assert conn.execute("SELECT amount FROM receipts WHERE id='r1'").fetchone()[0] == 950


def test_verify_rejects_empty_or_unknown_backup(tmp_path):
    empty = tmp_path / "empty.dump"
    empty.touch()
    try:
        verify_backup(empty)
    except RuntimeError as exc:
        assert "empty" in str(exc)
    else:
        raise AssertionError("empty backup was accepted")
