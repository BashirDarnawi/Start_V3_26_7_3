#!/usr/bin/env python3
"""Decrypt an Albayan backup into a separate file for a controlled restore.

This helper intentionally never writes to the live database. An operator must
inspect the decrypted dump and explicitly run pg_restore or open the SQLite
copy, which prevents an accidental production overwrite.
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.operations import decrypt_backup_file  # noqa: E402


def decode_key(value: str) -> bytes:
    try:
        key = base64.urlsafe_b64decode(value.strip() + "=" * (-len(value.strip()) % 4))
    except Exception as exc:
        raise ValueError("The backup key is not valid URL-safe base64") from exc
    if len(key) != 32:
        raise ValueError("The backup key must decode to exactly 32 bytes")
    return key


def live_database_paths() -> set[Path]:
    paths: set[Path] = set()
    configured = (os.getenv("ALBAYAN_DB_PATH") or "").strip()
    if configured:
        paths.add(Path(configured).expanduser().resolve())
    database_url = (os.getenv("DATABASE_URL") or "").strip()
    if database_url.startswith("sqlite"):
        parsed = urlsplit(database_url)
        raw = unquote(parsed.path or "")
        if raw:
            paths.add(Path(raw).expanduser().resolve())
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely decrypt an Albayan database backup")
    parser.add_argument("input", type=Path, help="Encrypted .backup.aesgcm file")
    parser.add_argument("output", type=Path, help="New separate decrypted dump file")
    parser.add_argument("--key-env", default="ALBAYAN_BACKUP_KEY", help="Environment variable containing the backup key")
    parser.add_argument("--force", action="store_true", help="Allow replacing the output file (never the input)")
    args = parser.parse_args()

    source = args.input.expanduser().resolve()
    target = Path(os.path.abspath(args.output.expanduser()))
    if not source.is_file():
        parser.error(f"Backup file does not exist: {source}")
    if source == target:
        parser.error("Input and output must be different files")
    if target.is_symlink():
        parser.error("Output cannot be a symbolic link")
    if target.exists() and not target.is_file():
        parser.error("Output must be a regular file")
    if target.exists() and not args.force:
        parser.error("Output already exists; choose another path or add --force")
    if target.resolve() in live_database_paths():
        parser.error("Output cannot be the configured live database")
    raw_key = (os.getenv(args.key_env) or "").strip()
    if not raw_key:
        parser.error(f"{args.key_env} is not set")

    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix=".albayan-restore-", dir=target.parent, delete=False)
    temporary = Path(handle.name)
    handle.close()
    try:
        decrypt_backup_file(source, temporary, decode_key(raw_key))
        temporary.chmod(0o600)
        os.replace(temporary, target)
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        parser.error(f"Backup could not be decrypted: {exc}")
    print(f"Decrypted backup written safely to: {target}")
    print("The live database was not changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
