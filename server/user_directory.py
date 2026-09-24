"""Platform door to the ``users`` table for Smart Systems (owner decision D36, docs/SMART_SYSTEMS.md).

A system package never runs SQL on ``users``; it asks here. Everything is read only, and every
function takes the caller's connection, so the answer belongs to the caller's transaction.

* ``user_exists(conn, user_id)``: True for a user that exists and is not deleted.
* ``account_created_at(conn, user_ids)``: ``{id: created_at (ms)}`` for the ids that exist
  (deleted accounts included: their history still happened).
* ``access_row(conn, user_id)``: ``{"id", "role", "permissions_json"}`` of a user that is not
  deleted (the internal auth identity shape the permission helpers read), else None.
"""

from typing import Any, Iterable

from sqlalchemy import bindparam, text

_ID_CHUNK = 500  # ids per IN (...) query


def user_exists(conn: Any, user_id: Any) -> bool:
    raw = str(user_id or "")
    if not raw:
        return False
    row = conn.execute(
        text("SELECT id FROM users WHERE id = :id AND deleted = false LIMIT 1"), {"id": raw}
    ).first()
    return row is not None


def account_created_at(conn: Any, user_ids: Iterable[Any]) -> dict[str, Any]:
    ids = sorted({str(i) for i in user_ids if i})
    found: dict[str, Any] = {}
    query = text("SELECT id, created_at FROM users WHERE id IN :ids").bindparams(bindparam("ids", expanding=True))
    for start in range(0, len(ids), _ID_CHUNK):
        for row in conn.execute(query, {"ids": ids[start:start + _ID_CHUNK]}).mappings().all():
            found[str(row["id"])] = row["created_at"]
    return found


def access_row(conn: Any, user_id: Any) -> dict[str, Any] | None:
    raw = str(user_id or "")
    if not raw:
        return None
    row = conn.execute(
        text("SELECT id, role, permissions_json FROM users WHERE id = :id AND deleted = false LIMIT 1"),
        {"id": raw},
    ).mappings().first()
    return dict(row) if row else None
