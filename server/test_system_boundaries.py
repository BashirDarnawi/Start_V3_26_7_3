"""Smart Systems boundary guard (owner decision D36, docs/SMART_SYSTEMS.md).

A system package under server/systems/<name>/ may use its own record types (OWNED_TYPES) and the
platform doors (PLATFORM_DOORS). It must never import main.py (it gets helpers through its router's
ctx), another system's package or a module that is not a platform door, and it must never name
another system's record type: not as a value (call argument, including ctx["get_entity"](...)
calls, SQL bound parameter, assignment, comparison, collection element) and not inside SQL text.
Its SQL may read and write only the ``entities`` table: users, sessions, audit_logs and every
other platform table are reached through a platform door (e.g. user_directory, ctx["audit"]).
"""

import ast
import importlib
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parent
SYSTEMS = SERVER / "systems"

# Record types of systems that still live outside server/systems/ (they move in later tasks).
NOT_YET_MOVED = {
    "manager": {
        "ads", "receipts", "customers", "pages", "exchangeRateHistory", "dollarPurchases", "financialClosures",
        "receiptTransferMutations", "receiptSettlementMutations", "adFundingMutations", "adStopMutations",
        "customerMergeMutations", "receiptCompanyCoverages", "receiptCompanyCoverageMutations",
    },
    "clothes": {"clothesProducts", "clothesShipments", "clothesOrders", "clothesSettings", "clothesOrderMutations", "clothesShipmentMutations"},
}
# Shared record types behind platform doors (wallet, subscriptions, settings, users, Meta state).
PLATFORM_TYPES = {
    "walletTransactions", "walletPaymentRequests", "serviceSubscriptions", "appSettings", "users",
    "metaImportState", "metaProviderState", "metaPartnerState", "metaFundsState", "metaHealthState",
}
# Platform modules a system may import. Adding a door is a reviewed, one-line change here.
PLATFORM_DOORS = {
    "db", "schemas", "wallet_payments", "payment_methods", "subscription_plans", "operations", "meta_ads",
    "startup_support", "rate_limiter", "auth_limits", "security", "rbac", "entity_projection", "http_security",
    "user_directory",
}
# Dictionary access by key is not a use of a record type ("pages" as a JSON key, row.get("ads")).
KEY_ACCESS = {"get", "pop", "setdefault"}
# SQL text: a string inside one of these calls, or any string holding an upper-case SQL keyword
# (prose such as "must come from the site" is not SQL). Then FROM/JOIN/UPDATE/INTO <table>, in
# any case, must name "entities"; "FOR UPDATE SKIP ...", "DO UPDATE SET" and functions such as
# "JOIN LATERAL jsonb_to_record(...)" are not tables. An f-string part {...} becomes DYNAMIC_TABLE.
SQL_CALLS = {"text", "execute", "exec_driver_sql"}
SQL_KEYWORD = re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO)\b")
SQL_TABLE = re.compile(r"\b(?:from|join|update|into)\s+(?:(?:lateral|only)\s+)?\"?([A-Za-z_][\w.]*)(?![\w.])\"?(?!\s*\()", re.IGNORECASE)
NOT_TABLES = {"set", "skip", "nowait", "of", "select", "values", "lateral", "only"}
DYNAMIC_TABLE = "__dynamic__"


def _system_folders() -> list[Path]:
    return [p for p in sorted(SYSTEMS.iterdir()) if p.is_dir() and not p.name.startswith(("_", "."))]


def _systems() -> dict[str, Path]:
    return {p.name: p for p in _system_folders()}


def _owned(name: str) -> set[str]:
    return set(importlib.import_module(f"server.systems.{name}").OWNED_TYPES)


def _foreign_types(name: str) -> set[str]:
    foreign = set().union(*NOT_YET_MOVED.values())
    for other in _systems():
        if other != name:
            foreign |= _owned(other)
    return foreign


def _resolve(module: str | None, level: int, package: str) -> str:
    if level == 0:
        return module or ""
    base = package.split(".")
    base = base[: len(base) - (level - 1)] if level > 1 else base
    return ".".join(base + ([module] if module else []))


def _callee(func: ast.AST) -> str:
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Subscript) and isinstance(func.slice, ast.Constant) and isinstance(func.slice.value, str):
        return func.slice.value  # ctx["get_entity"](...)
    return ""


def _docstrings(tree: ast.AST) -> set[int]:
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                found.add(id(first.value))
    return found


def _sql_table_problems(tree: ast.AST, docstrings: set[int]) -> list[str]:
    in_sql_call: set[int] = set()
    fstring_parts: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _callee(node.func) in SQL_CALLS:
            for arg in [*node.args, *(k.value for k in node.keywords)]:
                in_sql_call.update(id(n) for n in ast.walk(arg))
        elif isinstance(node, ast.JoinedStr):
            fstring_parts.update(id(v) for v in node.values)
    not_sql = docstrings | fstring_parts  # an f-string is read whole, below
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            sql = "".join(v.value if isinstance(v, ast.Constant) else DYNAMIC_TABLE for v in node.values)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in not_sql:
            sql = node.value
        else:
            continue
        if id(node) not in in_sql_call and not SQL_KEYWORD.search(sql):
            continue
        for match in SQL_TABLE.finditer(sql):
            table = match.group(1).split(".")[-1].lower()
            if table == DYNAMIC_TABLE:
                problems.append(f"line {node.lineno}: SQL on a table named at run time (only 'entities' is allowed)")
            elif table != "entities" and table not in NOT_TABLES:
                problems.append(f"line {node.lineno}: SQL on the {table!r} table (only 'entities'; use a platform door)")
    return problems


def boundary_violations(source: str, package: str, system: str, foreign: set[str], other_systems: set[str]) -> list[str]:
    """Pure checker (also used by the self-test below)."""
    problems: list[str] = []
    tree = ast.parse(source)
    skip = _docstrings(tree)
    problems.extend(_sql_table_problems(tree, set(skip)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            skip.update(id(k) for k in node.keys if isinstance(k, ast.Constant))
        elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            skip.add(id(node.slice))
        elif isinstance(node, ast.Call) and _callee(node.func) in KEY_ACCESS and node.args and isinstance(node.args[0], ast.Constant):
            skip.add(id(node.args[0]))

    for node in ast.walk(tree):
        targets: list[str] = []
        if isinstance(node, ast.Import):
            targets = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = _resolve(node.module, node.level, package)
            targets = [base] + [f"{base}.{alias.name}" for alias in node.names]
        for target in targets:
            parts = target.split(".")
            if parts[0] != "server" or len(parts) < 2:
                continue  # stdlib / third-party, or the bare "server" package in "from ... import x"
            if parts[1] == "main":
                problems.append(f"line {node.lineno}: imports main.py (use the router ctx instead)")
            elif parts[1] == "systems":
                if len(parts) >= 3 and parts[2] != system and parts[2] in other_systems | {parts[2]}:
                    problems.append(f"line {node.lineno}: imports another system ({parts[2]})")
            elif parts[1] not in PLATFORM_DOORS:
                problems.append(f"line {node.lineno}: imports server.{parts[1]}, which is not a platform door")
        if isinstance(node, ast.Call) and _callee(node.func) in {"import_module", "__import__"}:
            problems.append(f"line {node.lineno}: dynamic import (not allowed in a system package)")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            text = node.value
            if text in foreign:
                problems.append(f"line {node.lineno}: uses another system's record type {text!r}")
            elif ("entities" in text or "type=" in text.replace(" ", "")) and any(f"'{t}'" in text or f'"{t}"' in text for t in foreign):
                problems.append(f"line {node.lineno}: SQL names another system's record type")
    return list(dict.fromkeys(problems))  # each problem once


def test_every_system_folder_is_a_declared_package():
    folders = _system_folders()
    assert any(p.name == "ads_studio" for p in folders)
    for folder in folders:
        init = folder / "__init__.py"
        assert init.exists(), f"{folder.name}: a system folder needs __init__.py with OWNED_TYPES"
        owned = _owned(folder.name)
        assert owned and not (owned & PLATFORM_TYPES), folder.name
        for other in _systems():
            if other != folder.name:
                assert not (owned & _owned(other)), f"{folder.name} and {other} claim the same record type"


def test_systems_stay_inside_their_boundaries():
    systems = _systems()
    failures = []
    for name, folder in systems.items():
        foreign = _foreign_types(name)
        others = set(systems) - {name}
        for path in sorted(folder.rglob("*.py")):
            rel = path.relative_to(SERVER.parent).with_suffix("")
            package = ".".join(rel.parts[:-1])
            for problem in boundary_violations(path.read_text(encoding="utf-8"), package, name, foreign, others):
                failures.append(f"{path.relative_to(SERVER)}: {problem}")
    assert not failures, "\n".join(failures)


def test_every_record_type_name_is_classified():
    """A new record type must be given an owner (a system's OWNED_TYPES, the platform, or a not-yet-moved system)."""
    classified = PLATFORM_TYPES | set().union(*NOT_YET_MOVED.values())
    for name in _systems():
        classified |= _owned(name)
    unknown = []
    for path in sorted(SERVER.rglob("*.py")):
        if path.name.startswith("test_") or "__pycache__" in path.parts:
            continue
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if not isinstance(node, ast.Assign):
                continue
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            values = []
            if any(re.search(r"(_COLLECTION|_TYPE)$", n) for n in names) and isinstance(node.value, ast.Constant):
                values = [node.value.value]
            elif any(re.search(r"COLLECTIONS$", n) for n in names):  # (*_TYPES sets hold kinds such as budget types)
                container = node.value.args[0] if isinstance(node.value, ast.Call) and node.value.args else node.value
                if isinstance(container, (ast.Tuple, ast.List, ast.Set)):
                    values = [e.value for e in container.elts if isinstance(e, ast.Constant)]
            for value in values:
                if isinstance(value, str) and re.fullmatch(r"[a-z][A-Za-z]{2,}", value) and value not in classified:
                    unknown.append(f"{path.relative_to(SERVER)}: {names[0]} = {value!r}")
    assert not unknown, "unclassified record types:\n" + "\n".join(unknown)


def test_the_guard_catches_violations():
    bad = (
        "from ... import main\n"
        "from ...systems.clothes import rules\n"
        "from ... import full_backup\n"
        "ORDERS_COLLECTION = 'clothesOrders'\n"
        "SQL = \"SELECT * FROM entities WHERE type='receipts'\"\n"
        "get_entity('ads', 'x')\n"
        "ctx['get_entity']('customers', 'x')\n"
        "conn.execute(text('SELECT 1 FROM entities WHERE type=:t'), {'t': 'pages'})\n"
        "rows = [r for r in rows if r['type'] == 'dollarPurchases']\n"
        "importlib.import_module('server.main')\n"
        "sql = f\"SELECT * FROM entities WHERE type='clothesShipments' AND id='{x}'\"\n"
        "USER_SQL = 'SELECT id, role FROM users WHERE id = :id'\n"
        "conn.execute(text('select e.id from entities e join audit_logs a on a.resource_id = e.id'))\n"
    )
    foreign = set().union(*NOT_YET_MOVED.values())
    found = boundary_violations(bad, "server.systems.ads_studio", "ads_studio", foreign, {"clothes"})
    assert len(found) == 13, "\n".join(found)
    assert any("'users' table" in p for p in found) and any("'audit_logs' table" in p for p in found)
    clean = (
        '"""Mentions ads and pages in prose."""\n'
        "from ...db import db_conn\nfrom ... import meta_ads\nfrom .social_studio import x\n"
        "LOG_TYPE = 'socialReplyLog'\n"
        "payload = {'pages': [], 'ads': 1}\nrow.get('pages')\nrow['ads']\n"
        'def f():\n    """Never runs SELECT id FROM users itself."""\n'
        "conn.execute(text('SELECT id FROM entities WHERE type = :t LIMIT 1 FOR UPDATE SKIP LOCKED'))\n"
        "rows = conn.execute(text(f'SELECT {cols} FROM entities WHERE {where} OFFSET 0'))\n"
        "studio_error(403, 'CROSS_SITE', 'This change must come from the Albayan site itself')\n"
    )
    assert boundary_violations(clean, "server.systems.ads_studio", "ads_studio", foreign, {"clothes"}) == []
