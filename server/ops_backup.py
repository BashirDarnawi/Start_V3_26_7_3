"""Create and verify consistent Albayan database backups.

Examples:
    python -m server.ops_backup backup --output-dir backups --retention-days 30
    python -m server.ops_backup verify backups/albayan-20260726T120000Z.dump

The command reads the same database environment variables as the application.
It never restores over a database; production restore remains a deliberate,
offline operator action.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

from sqlalchemy.engine import make_url

from .db import get_database_url


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run(command: Sequence[str], env: dict[str, str] | None = None) -> None:
    try:
        result = subprocess.run(
            list(command),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Required database tool '{command[0]}' was not found. Install PostgreSQL client tools first."
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "database tool failed").strip()[-800:]
        raise RuntimeError(detail)


def _postgres_args(tool: str, url) -> tuple[list[str], dict[str, str]]:
    command = [tool]
    if url.host:
        command.extend(["--host", str(url.host)])
    if url.port:
        command.extend(["--port", str(url.port)])
    if url.username:
        command.extend(["--username", str(url.username)])
    command.extend(["--dbname", str(url.database)])
    env = os.environ.copy()
    if url.password is not None:
        env["PGPASSWORD"] = str(url.password)
    return command, env


def verify_backup(path: Path) -> dict[str, object]:
    path = path.expanduser().resolve()
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError("Backup file is missing or empty")
    if path.suffix == ".sqlite3":
        uri = f"file:{path.as_posix()}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as conn:
            result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {result}")
        kind = "sqlite"
    elif path.suffix == ".dump":
        _run(["pg_restore", "--list", str(path)])
        kind = "postgresql"
    else:
        raise RuntimeError("Unknown backup type; expected .sqlite3 or .dump")
    return {
        "ok": True,
        "kind": kind,
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
    }


def _write_metadata(path: Path, result: dict[str, object]) -> None:
    path.with_suffix(path.suffix + ".sha256").write_text(
        f"{result['sha256']}  {path.name}\n", encoding="ascii"
    )
    path.with_suffix(path.suffix + ".json").write_text(
        json.dumps(result, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )


def _prune(output_dir: Path, retention_days: int, now: datetime) -> list[str]:
    if retention_days <= 0:
        return []
    cutoff = now - timedelta(days=retention_days)
    removed: list[str] = []
    for backup in list(output_dir.glob("albayan-*.dump")) + list(output_dir.glob("albayan-*.sqlite3")):
        modified = datetime.fromtimestamp(backup.stat().st_mtime, tz=timezone.utc)
        if modified >= cutoff:
            continue
        for candidate in (
            backup,
            backup.with_suffix(backup.suffix + ".sha256"),
            backup.with_suffix(backup.suffix + ".json"),
        ):
            if candidate.exists():
                candidate.unlink()
        removed.append(backup.name)
    return removed


def create_backup(output_dir: Path, retention_days: int = 30) -> dict[str, object]:
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    url = make_url(get_database_url())
    backend = url.get_backend_name()

    if backend == "sqlite":
        if not url.database or url.database == ":memory:":
            raise RuntimeError("An in-memory SQLite database cannot be backed up")
        source = Path(url.database).expanduser().resolve()
        if not source.is_file():
            raise RuntimeError(f"SQLite database was not found: {source}")
        final = output_dir / f"albayan-{stamp}.sqlite3"
        partial = final.with_suffix(final.suffix + ".partial")
        with closing(sqlite3.connect(str(source))) as source_conn:
            with closing(sqlite3.connect(str(partial))) as target_conn:
                source_conn.backup(target_conn)
    elif backend == "postgresql":
        final = output_dir / f"albayan-{stamp}.dump"
        partial = final.with_suffix(final.suffix + ".partial")
        command, env = _postgres_args("pg_dump", url)
        command.extend(["--format", "custom", "--compress", "6", "--no-owner", "--no-acl", "--file", str(partial)])
        _run(command, env)
    else:
        raise RuntimeError(f"Unsupported database backend: {backend}")

    try:
        partial.replace(final)
        result = verify_backup(final)
        result.update({"created_at": now.isoformat(), "retention_days": retention_days})
        _write_metadata(final, result)
        result["pruned"] = _prune(output_dir, retention_days, now)
        return result
    except Exception:
        partial.unlink(missing_ok=True)
        final.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or verify Albayan database backups")
    subparsers = parser.add_subparsers(dest="command", required=True)
    backup_parser = subparsers.add_parser("backup", help="Create, checksum, verify, and rotate a backup")
    backup_parser.add_argument("--output-dir", type=Path, default=Path("backups"))
    backup_parser.add_argument("--retention-days", type=int, default=30)
    verify_parser = subparsers.add_parser("verify", help="Verify a backup without restoring it")
    verify_parser.add_argument("path", type=Path)
    args = parser.parse_args()
    result = (
        create_backup(args.output_dir, args.retention_days)
        if args.command == "backup"
        else verify_backup(args.path)
    )
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
