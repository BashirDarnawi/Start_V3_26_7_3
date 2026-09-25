"""Albayan Studio privacy: staff identity redaction (P1-05) and the anonymisation scrub (P1-16).

**Staff identity never reaches a customer (P1-05; PLAN.md §7.5).** ``redact_staff_identity(value,
user)`` is the one redaction step on every customer read path:

* main.py's entity projection (``_project_entity_contacts_for_user``): every /api/collections list,
  get and write response, and the /api/ad-studio campaign actions (they project through it);
* the /api/wallet/payment-requests routes (wallet_payments.py, through the same projection in ctx);
* the /api/studio summaries (studio_wallet.py wallet summary, studio_results.py campaigns summary).

Staff see every stamp: admins, and every account that may browse the user directory (the platform
door rbac.can_browse_user_directory, the rule of /api/users/public), because they can read every
staff name there anyway. For anyone else the response is a copy in which:

* a stamp naming a person (a key ending in ``By``, ``ById`` or ``ByUserId`` such as reviewedBy,
  approvedBy, rejectedBy, stoppedBy, publishedBy, submittedBy, confirmedBy, canceledBy,
  receiptOverriddenBy and the entity's own and data ``createdBy``; also creatorId, actorId,
  authorUserId, reviewerId, staffId, staffUserId), at any depth (``reviewHistory[].reviewedBy``),
  becomes ``"team"`` (TEAM_ID; the screens show TEAM_LABELS "Albayan team" / «فريق البيان»),
  unless it is the viewer's own id: a customer still sees their own createdBy, submittedBy,
  stoppedBy (their own stop) and canceledBy (their own cancel). ``system`` stays ``system``;
* a name stamp (a key ending in ``ByName``, e.g. createdByName) is left out unless its id stamp
  (createdBy for createdByName) is the viewer.

An entity (a dict with ``type`` and ``data``) is redacted only when its type is one a customer
reads with staff stamps (REDACTED_TYPES), so Manager records keep fields such as
``deliveryFeePaidBy``; any other value (a summary) is redacted as a whole. Nothing stored changes.

**Anonymisation scrub (P1-16).** ``scrub_studio_personal_data_conn(conn, user_id)`` runs inside
main.py's privacy-anonymisation transaction, after its own scrub of the account row and the
creator names, on the same connection. It removes the account's optional WhatsApp number and its
consent time from the studio profile (``studioProfiles``, PLAN.md §7.1; the profile route itself
arrives with P2-07) and the commenters' identifiers and texts from the account's comment-reply log
(``socialReplyLog``: today only ``fromId`` is stored; comment texts and names are removed too if a
later release stores them). Support tickets do not exist yet (P3-07); see the TODO below. It never
reads or writes the wallet ledger, payment requests or ad requests (money history stays exact),
and it only ever touches this system's own record types. It is idempotent: a second run changes
nothing. On PostgreSQL it locks the rows it rewrites (ORDER BY id, FOR UPDATE); main.py's creator-
name scrub already holds the account's rows in (type, id) order, so no new lock order appears.
"""

from functools import lru_cache
from typing import Any

from sqlalchemy import text

from ...db import json_dumps, json_loads, now_ms
from ...rbac import can_browse_user_directory
from .social_studio import LOG_TYPE as REPLY_LOG_TYPE
from .studio_types import STUDIO_PROFILES_TYPE, derived_id

TEAM_ID = "team"
TEAM_LABELS = {"en": "Albayan team", "ar": "فريق البيان"}

# The record types a customer reads that carry staff stamps: their ad requests (reviews, approvals,
# links, stops), their wallet ledger rows (credits, captures and returns written by staff), their
# charge requests (confirmed or cancelled by an admin) and their plan periods (an admin may buy one
# for them). The last three are platform types: this only shapes what a viewer sees of them.
REDACTED_TYPES = frozenset(
    {"adCampaignRequests", "walletTransactions", "walletPaymentRequests", "serviceSubscriptions"}
)

_ACTOR_SUFFIXES = ("By", "ById", "ByUserId")
_ACTOR_KEYS = frozenset({"creatorId", "actorId", "authorUserId", "reviewerId", "staffId", "staffUserId"})
_NAME_SUFFIX = "ByName"
_NOT_A_PERSON = frozenset({"system", TEAM_ID})

# ------------------------------------------------------------------ P1-05 redaction


@lru_cache(maxsize=256)
def _directory_access(role: str, permissions_json: str) -> bool:
    # A directory grant never depends on the user id (no "own" rule), so the role and the
    # permission text decide it: a list of 500 rows asks once, not 500 times.
    return can_browse_user_directory({"role": role, "permissions_json": permissions_json})


def is_staff_viewer(user: dict[str, Any] | None) -> bool:
    """Admins and every account that may browse the user directory (rbac.can_browse_user_directory)."""
    user = user or {}
    role = str(user.get("role") or "")
    if role.lower() == "admin":
        return True
    permissions = user.get("permissions_json")
    if permissions is None or isinstance(permissions, str):
        return _directory_access(role, permissions or "")
    return can_browse_user_directory(user)


def _is_actor_key(key: str) -> bool:
    return key in _ACTOR_KEYS or key.endswith(_ACTOR_SUFFIXES)


def _names_someone_else(value: Any, viewer_id: str) -> bool:
    """True when an actor stamp names a person other than the viewer."""
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, (dict, list)):
        return bool(value)
    raw = str(value).strip()
    return bool(raw) and raw != viewer_id and raw.lower() not in _NOT_A_PERSON


def _redact(value: Any, viewer_id: str) -> tuple[Any, bool]:
    """(the customer-safe copy, whether anything changed); an unchanged value is returned as is."""
    if isinstance(value, list):
        items = [_redact(item, viewer_id) for item in value]
        if any(changed for _item, changed in items):
            return [item for item, _changed in items], True
        return value, False
    if not isinstance(value, dict):
        return value, False
    out: dict[Any, Any] = {}
    changed = False
    for key, child in value.items():
        name = key if isinstance(key, str) else ""
        if name.endswith(_NAME_SUFFIX):
            own = bool(viewer_id) and str(value.get(name[: -len("Name")]) or "") == viewer_id
            if own or child is None or child == "":
                out[key] = child
            else:
                changed = True  # a staff member's name is left out
        elif _is_actor_key(name):
            if _names_someone_else(child, viewer_id):
                out[key], changed = TEAM_ID, True
            else:
                out[key] = child
        else:
            out[key], child_changed = _redact(child, viewer_id)
            changed = changed or child_changed
    return (out, True) if changed else (value, False)


def redact_staff_identity(value: Any, user: dict[str, Any] | None) -> Any:
    """What this viewer may see of one response (see the module docstring).

    ``value``: an entity (``{"id", "type", "createdBy", "data", ...}``) or any JSON value (a
    summary); ``user``: the signed-in account (``id``, ``role``, ``permissions_json``). Staff get
    ``value`` itself; a customer gets a redacted copy, or ``value`` itself when it holds no staff
    stamp.
    """
    if isinstance(value, dict) and "type" in value and isinstance(value.get("data"), dict):
        if value.get("type") not in REDACTED_TYPES:
            return value
    if str((user or {}).get("role") or "").lower() == "admin":
        return value
    redacted, changed = _redact(value, str((user or {}).get("id") or ""))
    if not changed or is_staff_viewer(user):
        return value
    return redacted


# ------------------------------------------------------------------ P1-16 anonymisation scrub

# The studio profile (studio_types.STUDIO_PROFILES_TYPE, PLAN.md §7.1): one row per owner, id
# "stp_" + sha256(owner)[:40]. The /api/studio/profile route that writes it arrives with P2-07;
# this scrub is ready for its rows.
PROFILE_ID_PREFIX = "stp"
PROFILE_PERSONAL_FIELDS = ("whatsappNumber", "whatsappConsentAt")
# What a reply-log row may hold about the commenter (today: fromId only).
REPLY_LOG_COMMENTER_FIELDS = (
    "fromId", "fromName", "fromUsername", "from", "commenterId", "commenterName", "commentText", "text", "message",
)
_SCRUB_BATCH = 500


def _scrub_fields(conn: Any, rows_sql: str, params: dict[str, Any], fields: tuple[str, ...], stamp: int) -> int:
    """Remove ``fields`` from every row ``rows_sql`` selects (keyset batches of _SCRUB_BATCH by id).
    Returns how many rows changed; a row without any of the fields is not rewritten."""
    lock = " FOR UPDATE" if conn.dialect.name == "postgresql" else ""
    changed = 0
    after = ""
    while True:
        rows = conn.execute(
            text(rows_sql + " AND id > :after ORDER BY id LIMIT :batch" + lock),
            {**params, "after": after, "batch": _SCRUB_BATCH},
        ).mappings().all()
        for row in rows:
            data = json_loads(row["data_json"] or "{}")
            if not isinstance(data, dict) or not any(field in data for field in fields):
                continue
            for field in fields:
                data.pop(field, None)
            modified = max(stamp, int(row["last_modified"] or 0) + 1)
            if "_lastModified" in data:
                data["_lastModified"] = modified
            conn.execute(
                text("UPDATE entities SET data_json = :data, last_modified = :modified WHERE type = :type AND id = :id"),
                {"data": json_dumps(data), "modified": modified, "type": params["type"], "id": row["id"]},
            )
            changed += 1
        if len(rows) < _SCRUB_BATCH:
            return changed
        after = str(rows[-1]["id"])


def scrub_studio_personal_data_conn(conn: Any, user_id: str) -> dict[str, int]:
    """Remove the studio's personal data of an account being anonymised (P1-16), on the caller's
    transaction. Returns how many rows changed per kind. Never touches the ledger."""
    uid = str(user_id or "")
    if not uid:
        return {"profiles": 0, "replyLog": 0, "tickets": 0}
    stamp = now_ms()
    profiles = _scrub_fields(
        conn,
        "SELECT id, data_json, last_modified FROM entities WHERE type = :type AND (created_by = :uid OR id = :profile_id)",
        {"type": STUDIO_PROFILES_TYPE, "uid": uid, "profile_id": derived_id(PROFILE_ID_PREFIX, uid)},
        PROFILE_PERSONAL_FIELDS,
        stamp,
    )
    reply_log = _scrub_fields(
        conn,
        "SELECT id, data_json, last_modified FROM entities WHERE type = :type AND created_by = :uid",
        {"type": REPLY_LOG_TYPE, "uid": uid},
        REPLY_LOG_COMMENTER_FIELDS,
        stamp,
    )
    # TODO(P3-07): support tickets do not exist yet. When supportTickets and supportTicketMessages
    # land, scrub here the account's ticket subjects and every message text (customer and team
    # messages alike), keeping ids, T- numbers, status and times; the ticket tests then extend
    # test_studio_privacy.py::test_anonymise_scrubs_studio_personal_data.
    return {"profiles": profiles, "replyLog": reply_log, "tickets": 0}
