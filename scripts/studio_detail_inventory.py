#!/usr/bin/env python3
"""Report-only inventory of the refusal texts in Albayan Ads Studio (plan task P0-08).

Prints every ``HTTPException(... detail=...)`` and every ``studio_error(status, code, message)``
found in server/systems/ads_studio/*.py, with its file, line and HTTP status. The list is the
input for the Arabic refusal map (P1-08c) and the v2 error codes (P2-11).

It never fails a build: it always exits 0, even when a file cannot be read or parsed.

Usage:  python scripts/studio_detail_inventory.py
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "server" / "systems" / "ads_studio"


def _callee(func: ast.AST) -> str:
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ""


def _text(node: ast.AST | None) -> str:
    """A readable form of a detail value: literal text, an f-string with {…} holes, or code."""
    if node is None:
        return "(none)"
    if isinstance(node, ast.Constant):
        return repr(node.value) if not isinstance(node.value, str) else node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                out.append(str(part.value))
            else:
                out.append("{…}")
        return "".join(out)
    if isinstance(node, ast.Dict):
        pairs = []
        for key, value in zip(node.keys, node.values):
            pairs.append(f"{_text(key)}={_text(value)}")
        return "{" + ", ".join(pairs) + "}"
    try:
        return "<code> " + ast.unparse(node)
    except Exception:
        return "<code>"


def _keyword(call: ast.Call, name: str, position: int) -> ast.AST | None:
    for keyword in call.keywords:
        if keyword.arg == name:
            return keyword.value
    return call.args[position] if len(call.args) > position else None


def inventory(path: Path) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _callee(node.func)
        if name == "HTTPException":
            status = _text(_keyword(node, "status_code", 0))
            found.append((node.lineno, status, _text(_keyword(node, "detail", 1))))
        elif name == "studio_error":
            status = _text(_keyword(node, "status", 0))
            code = _text(_keyword(node, "code", 1))
            found.append((node.lineno, status, f"[{code}] {_text(_keyword(node, 'message', 2))}"))
    return sorted(found)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    total = 0
    files = sorted(FOLDER.glob("*.py")) if FOLDER.is_dir() else []
    for path in files:
        try:
            rows = inventory(path)
        except Exception as error:  # report-only: never fail
            print(f"{path.relative_to(ROOT).as_posix()}: could not be read ({type(error).__name__})")
            continue
        if not rows:
            continue
        print(f"{path.relative_to(ROOT).as_posix()} ({len(rows)})")
        for line, status, detail in rows:
            print(f"  {line:>5}  {status:>4}  {detail}")
        total += len(rows)
    print(f"Total: {total} refusal texts in {len(files)} files (report only).")
    return 0


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # report-only: never fail
        print(f"studio_detail_inventory: {type(error).__name__}: {error}")
    sys.exit(0)
