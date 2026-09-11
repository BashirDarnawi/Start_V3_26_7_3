"""Packaging checks only create synthetic files under pytest's temporary path."""
from pathlib import Path

import pytest

from server.image_safety import forbidden_image_paths


@pytest.mark.parametrize("name", [
    "server/data/albayan.db", "server/albayan.db", "server/ALBAYAN.DB-WAL",
    "server/cache.sqlite3", "server/cache.sqlite3-shm", "server/backup.dump",
    "server/albayan-full-backup.ndjson.gz", "server/albayan.backup.aesgcm",
    "server/backups/manifest.json", "server/.env", "server/nested/.env.production",
    "server/cert/private.pem", "server/private.key", "server/signing.p12",
    "server/mobile.keystore", "server/.venv/config", "server/.git/config",
])
def test_runtime_or_private_files_block_image(name, tmp_path):
    candidate = tmp_path / name
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text("synthetic packaging test; no real secrets", encoding="utf-8")
    assert name in forbidden_image_paths(tmp_path)
    assert candidate.exists(), "The guard must never delete anything"


def test_runtime_data_directory_is_rejected_even_when_empty(tmp_path):
    (tmp_path / "server" / "data").mkdir(parents=True)
    assert forbidden_image_paths(tmp_path) == ["server/data"]


def test_normal_application_assets_and_migrations_remain_allowed(tmp_path):
    for name in ["server/main.py", "server/db.py", "server/test_backup_crypto_compatibility.py",
                 "server/migrations/versions/001.py", "assets/logo.png", "assets/tailwind.css",
                 "script.js", "studio.js", "clothes.js", "index.html", "alembic.ini"]:
        candidate = tmp_path / name
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text("synthetic app fixture", encoding="utf-8")
    assert forbidden_image_paths(tmp_path) == []


def test_packaging_guard_requires_an_existing_directory(tmp_path):
    with pytest.raises(ValueError):
        forbidden_image_paths(tmp_path / "missing")


def test_build_checks_copied_files_before_running_service():
    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "server/Dockerfile").read_text(encoding="utf-8")
    check = "RUN python /app/server/image_safety.py /app"
    assert dockerfile.index("COPY server /app/server") < dockerfile.index(check)
    assert dockerfile.index(check) < dockerfile.index("USER albayan")
