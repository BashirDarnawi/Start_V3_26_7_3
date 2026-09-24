#!/usr/bin/env python3
"""Report-only inventory of the refusal texts behind the Albayan Studio screens (plan task P0-08).

Prints every ``HTTPException(... detail=...)`` and every ``studio_error(status, code, message)``,
with its file, line and HTTP status, from:

* server/systems/ads_studio/*.py (/api/ad-studio, /api/social-studio, /api/studio);
* server/wallet_payments.py and server/subscription_plans.py (/api/wallet, plans);
* the route functions in server/main.py whose path starts with /api/ad-studio,
  /api/social-studio or /api/wallet (only the decorated function's own body; helpers it calls
  are not followed).

The list is the input for the Arabic refusal map (P1-08c) and the v2 error codes (P2-11).
It never fails a build: it always exits 0, even when a file cannot be read or parsed.

Usage:  python scripts/studio_detail_inventory.py
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
FOLDER = SERVER / "systems" / "ads_studio"
PLATFORM_FILES = (SERVER / "wallet_payments.py", SERVER / "subscription_plans.py")
MAIN = SERVER / "main.py"
MAIN_ROUTE_PREFIXES = ("/api/ad-studio", "/api/social-studio", "/api/wallet")
ROUTE_METHODS = {"get", "post", "put", "patch", "delete", "api_route"}


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


def refusals(tree: ast.AST) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
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


def inventory(path: Path) -> list[tuple[int, str, str]]:
    return refusals(ast.parse(path.read_text(encoding="utf-8")))


def route_path(function: ast.AST) -> str:
    """The path of an ``@app.post("/api/...")``-style decorator ('' when there is none)."""
    for decorator in getattr(function, "decorator_list", []):
        if (
            isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr in ROUTE_METHODS
            and decorator.args
            and isinstance(decorator.args[0], ast.Constant)
            and isinstance(decorator.args[0].value, str)
        ):
            return decorator.args[0].value
    return ""


def main_route_inventory(path: Path) -> list[tuple[int, str, str]]:
    """Refusals inside main.py route functions whose path starts with a studio prefix."""
    found: list[tuple[int, str, str]] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and route_path(node).startswith(MAIN_ROUTE_PREFIXES):
            found.extend(refusals(node))
    return sorted(found)


def _print(label: str, rows: list[tuple[int, str, str]]) -> int:
    if not rows:
        return 0
    print(f"{label} ({len(rows)})")
    for line, status, detail in rows:
        print(f"  {line:>5}  {status:>4}  {detail}")
    return len(rows)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    total = 0
    sources = (sorted(FOLDER.glob("*.py")) if FOLDER.is_dir() else []) + [p for p in PLATFORM_FILES if p.is_file()]
    jobs = [(path, path.relative_to(ROOT).as_posix(), inventory) for path in sources]
    if MAIN.is_file():
        label = f"{MAIN.relative_to(ROOT).as_posix()} routes under {', '.join(MAIN_ROUTE_PREFIXES)}"
        jobs.append((MAIN, label, main_route_inventory))
    for path, label, read in jobs:
        try:
            rows = read(path)
        except Exception as error:  # report-only: never fail
            print(f"{label}: could not be read ({type(error).__name__})")
            continue
        total += _print(label, rows)
    print(f"Total: {total} refusal texts in {len(jobs)} sources (report only).")
    return 0


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # report-only: never fail
        print(f"studio_detail_inventory: {type(error).__name__}: {error}")
    sys.exit(0)
