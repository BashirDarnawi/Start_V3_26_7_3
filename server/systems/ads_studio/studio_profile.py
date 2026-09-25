"""Albayan Studio profile: the customer's optional WhatsApp number (plan task P2-07; PLAN.md §7.1,
§7.3, §7.5, M15).

Routes under the studio router's /api/studio prefix:

* ``GET /api/studio/profile`` (any signed-in user, lapsed customers too): the caller's own profile
  ``{whatsappNumber, whatsappConsentAt, updatedAt}``; nulls when nothing is saved.
* ``PUT /api/studio/profile`` (same, from the Albayan site itself): body ``{whatsappNumber,
  whatsappConsent}``. A number is stored only with ``whatsappConsent: true`` and only in the
  international form (E.164), read with the same rules as the screens' ``studioParsePhone``
  (15g-studio-core.js): Arabic digits, spaces, dots, dashes and brackets are allowed, 00 means +,
  and the Libyan forms 091…, 91… and 218… become +218…. The shared table phone_cases.json keeps
  the two readers equal (server/test_studio_profile.py and scripts/test-mobile-ui.js). A null or
  empty number removes the number and its consent time. Saving what is already stored changes
  nothing and writes no audit entry, so the PUT can be repeated safely.

**Only the owner.** Neither route takes a user id (``userId`` or ``ownerId`` in the body is an
unknown field), so an admin or a reviewer reads and writes only their own profile here; the team
reaches a customer's number only through the audited per-item contact link, with consent (P3-11).

**The number stays in this row.** The audit entry (``studio_profile``) records what changed
("set", "changed" or "removed") and never the number; the anonymisation scrub
(studio_privacy.scrub_studio_personal_data_conn, P1-16) removes the number and its consent time.

One row per owner: type ``studioProfiles``, id ``stp_`` + sha256(owner)[:40]
(studio_types.derived_id, the id the scrub looks for), ``created_by`` = the owner. Fields that
other features keep on the same row (``activitySeenAt``, P3-05) are left as they are.

Refusals use the existing studio codes (studio_errors.py): ``INVALID_VALUE`` for a number that is not
a phone number and for a number sent without consent (PLAN.md §7.3 names them PHONE_INVALID and
CONSENT_REQUIRED; PHONE_REFUSAL_CODE and CONSENT_REFUSAL_CODE below switch to them once the screens'
error map carries their words).
"""

import math
import re
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text

from ...db import db_conn, json_dumps, json_loads, now_ms
from ...rate_limiter import check_rate_limit
from .studio_errors import studio_error
from .studio_types import STUDIO_PROFILES_TYPE, created_by_or_none, derived_id

PROFILE_ID_PREFIX = "stp"  # the same id studio_privacy's scrub looks for
BODY_FIELDS = ("whatsappNumber", "whatsappConsent")
PROFILE_READS_PER_MINUTE = 60
PROFILE_WRITES_PER_MINUTE = 20
AUDIT_ACTION = "studio_profile"
PHONE_REFUSAL_CODE = "INVALID_VALUE"
CONSENT_REFUSAL_CODE = "INVALID_VALUE"

# ------------------------------------------------------------------ the phone rule (= studioParsePhone)

PHONE_MAX_TYPED = 32
# JavaScript's \s and String.prototype.trim() (WhiteSpace + LineTerminator), written out: Python's
# own \s is a different set.
_JS_SPACE = "\t\n\u000b\u000c\r    -     　﻿"
_JS_TRIM_RE = re.compile(f"^[{_JS_SPACE}]+|[{_JS_SPACE}]+$")
# What studioParsePhone removes: spaces, brackets, dots, dashes and the direction marks a phone may
# paste around a number.
_PHONE_SEPARATORS_RE = re.compile(f"[{_JS_SPACE}().\\- ‎‏‪-‮⁦-⁩]")
# normalizeDigitsAscii (src/14-forms.js): Arabic-Indic and Extended (Persian) digits.
_DIGITS = str.maketrans(
    "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "01234567890123456789",
)
_TYPED_RE = re.compile(r"\+?[0-9]{6,20}")
_LY_INTERNATIONAL_RE = re.compile(r"218[0-9]{8,10}")
_LY_LOCAL_RE = re.compile(r"0[0-9]{8,9}")
_LY_MOBILE_RE = re.compile(r"9[0-9]{8}")
_LY_E164_RE = re.compile(r"\+218(?:9[0-9]{8}|[1-8][0-9]{7,8})")  # mobiles (9x) need all 9 national digits
_E164_RE = re.compile(r"\+[1-9][0-9]{7,14}")


def normalize_phone(raw: Any) -> str:
    """A typed phone number as E.164 ("+218912345678"), or '' when it is not one.

    The same steps, in the same order, as studioParsePhone in 15g-studio-core.js.
    """
    if raw is None or not isinstance(raw, str):
        return ""
    typed = _JS_TRIM_RE.sub("", raw.translate(_DIGITS))
    if not typed or len(typed.encode("utf-16-le")) // 2 > PHONE_MAX_TYPED:
        return ""
    typed = _PHONE_SEPARATORS_RE.sub("", typed)
    if typed.startswith("00"):
        typed = "+" + typed[2:]
    if not _TYPED_RE.fullmatch(typed):
        return ""
    if typed.startswith("+"):
        number = typed
    elif _LY_INTERNATIONAL_RE.fullmatch(typed):
        number = "+" + typed
    elif _LY_LOCAL_RE.fullmatch(typed):
        number = "+218" + typed[1:]
    elif _LY_MOBILE_RE.fullmatch(typed):
        number = "+218" + typed
    else:
        return ""
    if number.startswith("+2180"):
        number = "+218" + number[5:]
    if number.startswith("+218"):
        return number if _LY_E164_RE.fullmatch(number) else ""
    return number if _E164_RE.fullmatch(number) else ""


# ------------------------------------------------------------------ the row


def profile_id(owner_id: str) -> str:
    return derived_id(PROFILE_ID_PREFIX, owner_id)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text_or_none(value: Any, max_length: int = 64) -> str | None:
    return value if isinstance(value, str) and value and len(value) <= max_length else None


def profile_view(data: Any) -> dict[str, Any]:
    """What the owner sees. A stored value is read back through today's rule: a number that is not
    E.164 any more (a hand-edited row) reads as no number."""
    data = data if isinstance(data, dict) else {}
    stored = data.get("whatsappNumber")
    number = stored if isinstance(stored, str) and normalize_phone(stored) == stored else None
    return {
        "whatsappNumber": number,
        "whatsappConsentAt": _text_or_none(data.get("whatsappConsentAt")) if number else None,
        "updatedAt": _text_or_none(data.get("updatedAt")),
    }


def _select_row(conn: Any, row_id: str) -> Any:
    lock = " FOR UPDATE" if conn.dialect.name == "postgresql" else ""
    return conn.execute(
        text(
            "SELECT id, data_json, deleted, created_at, last_modified FROM entities "
            f"WHERE type = :type AND id = :id LIMIT 1{lock}"
        ),
        {"type": STUDIO_PROFILES_TYPE, "id": row_id},
    ).mappings().first()


def _live_data(row: Any) -> dict[str, Any]:
    if not row or bool(row["deleted"]):
        return {}
    data = json_loads(row["data_json"] or "{}")
    return data if isinstance(data, dict) else {}


def read_profile(owner_id: str) -> dict[str, Any]:
    with db_conn() as conn:
        row = conn.execute(
            text("SELECT data_json, deleted FROM entities WHERE type = :type AND id = :id LIMIT 1"),
            {"type": STUDIO_PROFILES_TYPE, "id": profile_id(owner_id)},
        ).mappings().first()
        return profile_view(_live_data(row))


def clean_profile_body(body: Any) -> str | None:
    """The number to store (E.164) or None to remove it; refuses anything else."""
    if not isinstance(body, dict):
        studio_error(400, "INVALID_REQUEST", "Send {whatsappNumber, whatsappConsent}")
    extra = sorted(str(key) for key in set(body) - set(BODY_FIELDS))
    if extra:
        studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{extra[0][:40]}'. Send {{whatsappNumber, whatsappConsent}}")
    consent = body.get("whatsappConsent", False)
    if not isinstance(consent, bool):
        studio_error(400, "INVALID_VALUE", "whatsappConsent must be true or false")
    raw = body.get("whatsappNumber")
    if raw is None or raw == "":
        return None
    number = normalize_phone(raw)
    if not number:
        studio_error(400, PHONE_REFUSAL_CODE, "whatsappNumber is not a phone number. Use a number such as +218912345678 or 0912345678")
    if consent is not True:
        studio_error(400, CONSENT_REFUSAL_CODE, "A WhatsApp number is kept only with the owner's consent (whatsappConsent: true)")
    return number


def save_profile(
    owner_id: str,
    number: str | None,
    *,
    audit: Callable[[Any, str, str], None],
    iso_now: str | None = None,
) -> dict[str, Any]:
    """Store (or remove) the owner's number in one transaction; returns the new view.

    ``audit(conn, row_id, change)`` writes the audit entry on the same connection before the commit
    (change: "set", "changed" or "removed"), so a failed audit rolls the save back too. Nothing is
    written, and nothing audited, when the number is already the stored one.
    """
    uid = str(owner_id or "")
    row_id = profile_id(uid)
    stamp_iso = iso_now or _iso_now()
    with db_conn() as conn:
        row = _select_row(conn, row_id)
        data = _live_data(row)
        before = profile_view(data)
        if number == before["whatsappNumber"]:
            return before
        change = "removed" if number is None else ("changed" if before["whatsappNumber"] else "set")
        stamp = now_ms()
        new = dict(data)
        new.update({"id": row_id, "recordType": STUDIO_PROFILES_TYPE, "ownerId": uid, "updatedAt": stamp_iso, "_deleted": False})
        if number is None:
            new.pop("whatsappNumber", None)
            new.pop("whatsappConsentAt", None)
        else:
            new["whatsappNumber"] = number
            new["whatsappConsentAt"] = stamp_iso  # a new number is a new consent
        if row:
            baseline = int(row["last_modified"] or 0)
            modified = max(stamp, baseline + 1)
            new["_created"] = int(new.get("_created") or row["created_at"] or modified)
            new["_lastModified"] = modified
            result = conn.execute(
                text(
                    "UPDATE entities SET data_json = :data, deleted = false, last_modified = :modified "
                    "WHERE type = :type AND id = :id AND last_modified = :baseline"
                ),
                {"data": json_dumps(new), "modified": modified, "type": STUDIO_PROFILES_TYPE, "id": row_id, "baseline": baseline},
            )
        else:
            new["_created"] = stamp
            new["_lastModified"] = stamp
            result = conn.execute(
                text(
                    "INSERT INTO entities (type, id, data_json, deleted, created_at, created_by, last_modified) "
                    "VALUES (:type, :id, :data, false, :stamp, :owner, :stamp) ON CONFLICT (type, id) DO NOTHING"
                ),
                {"type": STUDIO_PROFILES_TYPE, "id": row_id, "data": json_dumps(new), "stamp": stamp,
                 "owner": created_by_or_none(conn, uid)},
            )
        if int(result.rowcount or 0) != 1:
            # Another save of the same profile committed between our read and our write.
            studio_error(409, "VERSION_CONFLICT", "Your profile was saved from another screen. Reload it, then save again.")
        audit(conn, row_id, change)
    return profile_view(new)


# ------------------------------------------------------------------ routes


def create_studio_profile_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter:
    """``GET`` and ``PUT /profile`` under the studio router's /api/studio prefix (see the module
    docstring). ``ctx["audit"]`` is main.audit (it joins the caller's transaction with ``conn=``)."""
    router = APIRouter()

    def rate_limit(user: dict[str, Any], bucket: str, per_minute: int) -> None:
        allowed, _left, retry_after_ms = check_rate_limit(f"studio:{bucket}:{user.get('id')}", per_minute, 60_000)
        if not allowed:
            studio_error(
                429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, math.ceil(int(retry_after_ms or 0) / 1000)))},
            )

    def same_origin(request: Request) -> None:
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")

    @router.get("/profile")
    def get_studio_profile(user: dict[str, Any] = Depends(current_user_dependency)):
        rate_limit(user, "profile-read", PROFILE_READS_PER_MINUTE)
        return read_profile(str(user.get("id") or ""))

    @router.put("/profile")
    def put_studio_profile(
        request: Request,
        body: Any = Body(None),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        same_origin(request)
        rate_limit(user, "profile-write", PROFILE_WRITES_PER_MINUTE)
        number = clean_profile_body(body)
        actor_id = str(user.get("id") or "")

        def audit_save(conn: Any, row_id: str, change: str) -> None:
            # Never the number: only what changed (PLAN.md §7.5).
            ctx["audit"](
                actor_id, AUDIT_ACTION, STUDIO_PROFILES_TYPE, row_id,
                f"WhatsApp number {change}", {"whatsapp": change}, conn=conn,
            )

        return save_profile(actor_id, number, audit=audit_save)

    return router
