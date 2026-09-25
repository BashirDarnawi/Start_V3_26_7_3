"""Albayan Studio record types and id helpers (plan task P0-03, PLAN.md §7.1).

* ``derived_id(prefix, *parts)``: the same inputs always give the same id, so a retried
  request finds the row it already wrote instead of creating a second one. The id is
  ``<prefix>_`` + the first 40 hex characters of sha256, at most 57 characters, and always
  passes main.validate_entity_id (``^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$``).
* ``created_by_or_none(conn, user_id)``: the ``entities.created_by`` column is a foreign key to
  ``users.id`` (server/db.py). A new row gets the id of a real, not deleted user or NULL (a
  system row), never a made-up value such as ``"system"``. The users table is read through the
  platform door server/user_directory.py (D36).
* ``studio_ref(campaign_id)``: the studio code ``ALB-S-XXXXXXXX`` that goes into a studio
  campaign's Meta name (PLAN.md §6, D26).
* ``studio_campaign_name(ref, request_name)``: the name a studio campaign carries in Meta,
  ``"<studio code> · <request name>"`` (D26: assigned at approval, set in Meta on link).
"""

import hashlib
import re
from typing import Any

from ...meta_ads import STUDIO_CAMPAIGN_NAME_MAX
from ...user_directory import user_exists

# Record types this module family writes (all listed in the package OWNED_TYPES).
STUDIO_SETTINGS_TYPE = "studioSettings"
# One per owner (optional WhatsApp number with consent; PLAN.md §7.1). Its route arrives with
# P2-07; the anonymisation scrub (studio_privacy.py, P1-16) already clears its personal fields.
STUDIO_PROFILES_TYPE = "studioProfiles"
# Help desk (studio_support.py, P3-07): a customer's ticket, its append-only messages (both with
# created_by = the ticket's owner, so the anonymisation scrub finds them) and the one counter row
# that hands out the T-000123 numbers (created_by NULL, a system row).
SUPPORT_TICKETS_TYPE = "supportTickets"
SUPPORT_TICKET_MESSAGES_TYPE = "supportTicketMessages"
STUDIO_COUNTERS_TYPE = "studioCounters"
# Types that only the /api/studio router may read or write: the generic /api/collections API
# refuses them (joined into social_studio.SOCIAL_STUDIO_COLLECTIONS, which main.py blocks).
STUDIO_ROUTER_ONLY_TYPES = frozenset({
    STUDIO_SETTINGS_TYPE, STUDIO_PROFILES_TYPE, SUPPORT_TICKETS_TYPE, SUPPORT_TICKET_MESSAGES_TYPE, STUDIO_COUNTERS_TYPE,
})

_PREFIX_RE = re.compile(r"[a-z][a-z0-9]{1,15}")
_ID_HASH_CHARS = 40
_PART_SEPARATOR = "|"
_ENTITY_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")  # the same rule as main.validate_entity_id
_NOT_A_USER = {"system", "team", "none", "null", "undefined"}  # placeholders, never real ids (ids are user_<hex>)

# Studio code alphabet: the PAY- reference alphabet (wallet_payments._new_payment_reference).
# 32 characters, upper case only, without 0/O and 1/I, the pairs people confuse most when they
# read a code aloud or retype it. The remaining look-alike pairs (S/5, Z/2, B/8) are accepted:
# staff copy the code with a button, and a code is always compared after upper-casing.
STUDIO_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
STUDIO_REF_PREFIX = "ALB-S-"
STUDIO_REF_LENGTH = 8
STUDIO_REF_RE = re.compile(r"ALB-S-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}")

# Phase 3 service types, router-only too: the owner's inbox (P3-05, studio_activity.py), the staff
# queue of urgent stop requests (P3-10, studio_stop.py) and the help tickets a stop request opens
# (P3-07, studio_support.py; listed here so a stop request's ticket is router-only in any case).
STUDIO_ACTIVITY_TYPE = "studioActivity"
STUDIO_STOP_REQUESTS_TYPE = "studioStopRequests"
SUPPORT_TICKETS_TYPE = "supportTickets"
SUPPORT_TICKET_MESSAGES_TYPE = "supportTicketMessages"
STUDIO_ROUTER_ONLY_TYPES = STUDIO_ROUTER_ONLY_TYPES | {
    STUDIO_ACTIVITY_TYPE, STUDIO_STOP_REQUESTS_TYPE, SUPPORT_TICKETS_TYPE, SUPPORT_TICKET_MESSAGES_TYPE,
}


def derived_id(prefix: str, *parts: Any) -> str:
    """``prefix_`` + sha256(part1|part2|...)[:40]. Raises ValueError on a bad prefix or part.

    A part may not contain the separator ``|``, so two different part lists can never hash the
    same text ("a|b" + "c" versus "a" + "b|c").
    """
    if not isinstance(prefix, str) or not _PREFIX_RE.fullmatch(prefix):
        raise ValueError("derived_id prefix must be 2-16 lower-case letters or digits, starting with a letter")
    if not parts:
        raise ValueError("derived_id needs at least one part")
    clean: list[str] = []
    for part in parts:
        value = str(part if part is not None else "")
        if not value or _PART_SEPARATOR in value:
            raise ValueError("derived_id parts must be non-empty and must not contain '|'")
        clean.append(value)
    digest = hashlib.sha256(_PART_SEPARATOR.join(clean).encode("utf-8")).hexdigest()
    return f"{prefix}_{digest[:_ID_HASH_CHARS]}"


def looks_like_user_id(value: Any) -> bool:
    """A value that could be a users.id (format only; placeholders such as 'system' are not)."""
    raw = str(value or "")
    return bool(_ENTITY_ID_RE.fullmatch(raw)) and raw.lower() not in _NOT_A_USER


def created_by_or_none(conn: Any, user_id: Any) -> str | None:
    """The value for ``entities.created_by``: the id of a user that exists and is not deleted,
    else None.

    Pass the connection of the transaction that will insert the row, so the check and the
    insert see the same users table.
    """
    raw = str(user_id or "")
    if not looks_like_user_id(raw):
        return None
    return raw if user_exists(conn, raw) else None


def studio_ref(campaign_id: Any, attempt: int = 0) -> str:
    """``ALB-S-`` + 8 characters, always the same for the same campaign id.

    The 8 characters are the first 40 bits of sha256(campaign id), 5 bits per character, so
    there are 32**8 (about 1.1 million million) codes. Two campaigns can still share a code by
    chance (about 1 in 22,000 among 10,000 campaigns), so whoever assigns a code must check it
    is unused and, if it is taken, ask again with ``attempt=1, 2, ...`` (a different, equally
    stable code).
    """
    raw = str(campaign_id or "")
    if not raw:
        raise ValueError("studio_ref needs a campaign id")
    if not isinstance(attempt, int) or attempt < 0:
        raise ValueError("studio_ref attempt must be a whole number >= 0")
    source = raw if attempt == 0 else f"{raw}{_PART_SEPARATOR}{attempt}"
    number = int.from_bytes(hashlib.sha256(source.encode("utf-8")).digest()[:5], "big")
    chars = []
    for _ in range(STUDIO_REF_LENGTH):
        chars.append(STUDIO_REF_ALPHABET[number & 31])
        number >>= 5
    return STUDIO_REF_PREFIX + "".join(reversed(chars))


def is_studio_ref(value: Any) -> bool:
    return bool(STUDIO_REF_RE.fullmatch(str(value or "").strip().upper()))


STUDIO_NAME_SEPARATOR = " · "
_NAME_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def studio_campaign_name(ref: str, request_name: Any) -> str:
    """``"<ref> · <request name>"``: the Meta campaign name of a studio request (D26).

    The request name loses angle brackets (as every stored text does), control characters become
    spaces, spaces are collapsed, and it is cut so the whole name stays within
    meta_ads.STUDIO_CAMPAIGN_NAME_MAX characters; the code itself is never cut. A request without a
    name gets the code alone.
    """
    code = str(ref or "").strip().upper()
    if not is_studio_ref(code):
        raise ValueError("studio_campaign_name needs a studio code ALB-S-XXXXXXXX")
    raw = str(request_name or "").replace("<", "").replace(">", "")
    name = " ".join(_NAME_CONTROL_RE.sub(" ", raw).split())
    room = STUDIO_CAMPAIGN_NAME_MAX - len(code) - len(STUDIO_NAME_SEPARATOR)
    name = name[:room].rstrip()
    return f"{code}{STUDIO_NAME_SEPARATOR}{name}" if name else code
