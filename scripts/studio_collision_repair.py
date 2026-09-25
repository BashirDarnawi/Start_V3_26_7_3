#!/usr/bin/env python3
"""Studio collision repair (Albayan Studio plan task P0-10, owner decision D26). Only with the owner.

Before P0-09, Albayan Manager could import an Albayan Studio campaign as a core ad. The report lists
those core ads; each one leaves Manager only by the owner's signed choice:

  1. Back up the database and prove the backup restores (docs/RELEASE_AND_SAFETY.md).
  2. Report (read-only):       python scripts/studio_collision_repair.py --report > report.json
  3. The owner writes choices.json (below) and signs it with a name and a date.
  4. Dry run (the default):    python scripts/studio_collision_repair.py --choices choices.json
  5. Apply (one transaction):  python scripts/studio_collision_repair.py --choices choices.json --apply
                                   --confirm-database <database name> [--actor <admin user id>]
     The reversal file (collision-reversal-<repair id>.json) is written BEFORE the change commits.
  6. Undo, if needed:          python scripts/studio_collision_repair.py --reverse <reversal file>
                                   --confirm-database <database name> [--actor <admin user id>]

Choices file:
  {"signedBy": "<owner name>", "signedAt": "2026-10-01",
   "choices": [{"adId": "<id from the report>", "choice": "remove_from_manager", "lastModified": <from the report>},
               {"adId": "<id from the report>", "choice": "keep_in_manager"}]}

A row with receipts, collections, wallet or company-funding records, or a Manager payment state, is
refused and never deleted; so is a row that changed since the report (lastModified). Removal is a
soft delete; keep_in_manager is remembered so the check stops counting the row. Everything is
audited as 'collision_repair'. The database is the one the server uses (DATABASE_URL or the
ALBAYAN_DB_* settings) and must be set explicitly. The output has ids, flags and counts only.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TARGET_SETTINGS = ("DATABASE_URL", "ALBAYAN_DATABASE_URL", "ALBAYAN_DB_HOST", "ALBAYAN_DB_PATH")
ACTOR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")


def _target() -> tuple[str, str]:
    """(database name, a description without the password) of the server's configured database."""
    from sqlalchemy.engine import make_url

    from server.db import get_database_url

    url = get_database_url()
    url = make_url(url) if isinstance(url, str) else url
    if url.drivername.startswith("sqlite"):
        name = Path(url.database or "").name or ":memory:"
        return name, f"SQLite file {url.database}"
    return str(url.database or ""), f"{url.drivername} database {url.database} on {url.host}:{url.port or 5432}"


def _read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_new(path: Path, document: dict) -> None:
    """Write a file that must not exist yet, and make sure it reached the disk."""
    with open(path, "x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Albayan Studio collision report and owner-signed repair (P0-10).")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--report", action="store_true", help="print the read-only report")
    action.add_argument("--choices", type=Path, help="the owner's signed choices file (dry run unless --apply)")
    action.add_argument("--reverse", type=Path, metavar="REVERSAL_FILE", help="undo one applied repair")
    parser.add_argument("--apply", action="store_true", help="change the data (with --choices)")
    parser.add_argument("--confirm-database", default="", help="the database name; required to change data")
    parser.add_argument("--actor", default=None, help="the admin user id recorded in the audit log")
    parser.add_argument("--reversal-dir", type=Path, default=Path.cwd(), help="where the reversal file is written")
    args = parser.parse_args(argv)
    if args.apply and args.choices is None:
        parser.error("--apply goes with --choices")
    if args.actor is not None and not ACTOR_RE.fullmatch(args.actor):
        parser.error("--actor must be a user id")

    if not any(os.getenv(name) for name in TARGET_SETTINGS):
        print("Set DATABASE_URL (or the ALBAYAN_DB_* settings) to the database to use; nothing was done.", file=sys.stderr)
        return 2
    from fastapi import HTTPException

    from server import meta_collisions
    from server.db import db_conn

    name, description = _target()
    print(f"Database: {description}", file=sys.stderr)  # stderr, so --report output stays plain JSON
    if (args.apply or args.reverse is not None) and args.confirm_database != name:
        print(f"Changing data needs --confirm-database {name} (the database above); nothing was done.", file=sys.stderr)
        return 2
    try:
        if args.report:
            with db_conn() as conn:
                result = meta_collisions.collision_report(conn)
        elif args.choices is not None and not args.apply:
            document = _read_json(args.choices)
            with db_conn() as conn:
                result = meta_collisions.plan_repair(conn, document)
        elif args.choices is not None:
            document = _read_json(args.choices)
            with db_conn() as conn:
                result, reversal = meta_collisions.apply_repair(conn, document, actor_id=args.actor, database=name)
                if reversal is not None:
                    path = args.reversal_dir / f"collision-reversal-{reversal['repairId']}.json"
                    _write_new(path, reversal)  # a failed write rolls the whole change back
                    result["reversalFile"] = str(path)
        else:
            reversal = _read_json(args.reverse)
            with db_conn() as conn:
                result = meta_collisions.reverse_repair(conn, reversal, actor_id=args.actor)
    except (meta_collisions.CollisionRepairError, ValueError, OSError) as error:
        print(f"Nothing was changed. {error}", file=sys.stderr)
        return 1
    except HTTPException as error:  # e.g. a financial month being closed at this moment
        print(f"Nothing was changed. {error.detail}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
