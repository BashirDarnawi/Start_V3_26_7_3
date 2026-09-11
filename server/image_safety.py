"""Fail image builds containing runtime databases, backups, or private files.

Run against the copied application directory, before any service starts. This
is a packaging guard, not a secret scanner and never deletes a discovered file.
"""
from __future__ import annotations

import argparse
from fnmatch import fnmatchcase
from pathlib import Path


PRIVATE_FILE_PATTERNS = (
    ".env", ".env.*", "*.db", "*.db-*", "*.sqlite", "*.sqlite-*",
    "*.sqlite3", "*.sqlite3-*", "*.dump", "*.sql.gz", "*.ndjson.gz",
    "*.backup*", "*.aesgcm", "*.key", "*.pem", "*.p8", "*.p12", "*.pfx",
    "*.jks", "*.keystore",
)
PRIVATE_DIRECTORIES = {".git", ".venv", "backups", "node_modules"}


def forbidden_image_paths(root: Path) -> list[str]:
    if not root.is_dir():
        raise ValueError("The application directory does not exist")
    rejected: list[str] = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        parts = tuple(part.lower() for part in relative.parts)
        private_directory = any(part in PRIVATE_DIRECTORIES for part in parts)
        runtime_data = parts[:2] == ("server", "data")
        private_name = any(fnmatchcase(parts[-1], pattern) for pattern in PRIVATE_FILE_PATTERNS)
        # Application source/assets do not need symlinks. A copied symlink must
        # not hide sensitive content from this path-based check.
        if private_directory or runtime_data or private_name or path.is_symlink():
            rejected.append(relative.as_posix())
    return sorted(rejected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("application_root", type=Path)
    args = parser.parse_args()
    rejected = forbidden_image_paths(args.application_root)
    if rejected:
        print("Unsafe image contents found. Fix the build exclusions; do not delete live data:")
        for name in rejected[:30]:
            print(f"  {name}")
        print(f"Build blocked: {len(rejected)} forbidden path(s). No file contents were read.")
        return 1
    print("Image packaging check passed: no runtime databases, backups, or private-key files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
