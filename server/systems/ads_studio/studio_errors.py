"""Error model of the /api/studio/* routes (plan task P0-08, PLAN.md §7.3).

Every refusal from /api/studio/* is ``{"detail": {"code": "...", "message": "..."}}``. The screens
read ``err.payload.detail.code`` and show their own (Arabic) text for it; ``message`` is plain
English for logs and developers. Codes are stable: add new ones, never rename or reuse one.

Two refusals are answered before a studio route runs and keep the platform's plain text:
401 (the login door, ``current_user``) and FastAPI's own 422 for a body that is not JSON.
Clients map both by HTTP status.

The older prefixes (/api/ad-studio, /api/social-studio, /api/wallet) keep their plain-text
``detail`` strings; scripts/studio_detail_inventory.py lists them for the Arabic map.
"""

from typing import Any, NoReturn

from fastapi import HTTPException

# code -> the HTTP status it is always sent with
STUDIO_ERROR_CODES: dict[str, int] = {
    "INVALID_REQUEST": 400,      # the body is not the expected shape
    "UNKNOWN_FIELD": 400,        # a field this setting does not have
    "INVALID_VALUE": 400,        # a field with a value outside its allowed list or range
    "CROSS_SITE": 403,           # a change sent from another website (same-origin check)
    "ADMIN_ONLY": 403,           # a route only an admin may use
    "UNKNOWN_SETTING": 404,      # a settings key that does not exist
    "VERSION_CONFLICT": 409,     # someone saved a newer version first; reload and retry
    "RATE_LIMITED": 429,         # too many changes in a short time
    "STAFF_DESK_IN_USE": 409,    # rollout: the team desk cannot go off while open tickets or stop requests wait (P3-20)
    "UNKNOWN_CUSTOMER": 404,     # staff contact link: no such customer for this staff member (P3-11)
    "NO_CONSENT": 409,           # staff contact link: the customer gave no WhatsApp number with consent (P3-11)
    "UNKNOWN_PAGE": 404,         # admin checks: no linked studio page with this id
    "NOT_INSTAGRAM": 409,        # admin checks: the Instagram read test needs a linked Instagram account
    "ALREADY_TESTED_TODAY": 409,  # admin checks: one test per page/account per Tripoli day
    "META_NOT_CONFIGURED": 409,  # admin checks: Albayan's Meta connection is not set up, so nothing ran
    "META_PAUSED": 409,          # admin checks: Albayan's Meta pause runs, so nothing ran and the day is still free
    "UNKNOWN_CAMPAIGN": 404,     # results: no such request for this user (another owner's, a private draft, archived)
    "STAFF_ONLY": 403,           # results: "Check Meta now" is for the Albayan team only
    "NOT_LINKED": 409,           # results: the request has no Meta campaign linked yet
    "SERVICE_OFF": 403,          # help: the Help service (rollout.services.help) is not open for this account yet
    "UNKNOWN_TICKET": 404,       # help: no such ticket for this user (another owner's, or an admin-only one for a reviewer)
    "UNKNOWN_PAYMENT": 404,      # help: the payment a ticket is about is not one of this user's
    "IDEMPOTENCY_MISMATCH": 409,  # an operationId already used for a different request
    "TICKET_OPEN_LIMIT": 409,    # help: too many tickets still open; resolve one first
    "TICKET_MESSAGE_LIMIT": 409,  # help: the ticket holds the most messages it may; open a new one
    "TICKET_CLOSED": 409,        # help: resolved more than 7 days ago; it can no longer be reopened
}


class StudioErrorCodeUnknown(ValueError):
    """A programming mistake: a code that is not in STUDIO_ERROR_CODES."""


def studio_error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> NoReturn:
    """Raise the /api/studio error ``{code, message}`` with this HTTP status."""
    if STUDIO_ERROR_CODES.get(code) != int(status):
        raise StudioErrorCodeUnknown(f"{code} is not a studio error code for HTTP {status}")
    raise HTTPException(status_code=int(status), detail={"code": code, "message": str(message)}, headers=headers)


def error_code(detail: Any) -> str:
    """The code inside an HTTPException detail ('' for a plain-text detail)."""
    return str(detail.get("code") or "") if isinstance(detail, dict) else ""
