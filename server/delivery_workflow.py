"""Delivery-workflow PATCH rules for the deliveries.* permission group.

Office staff holding deliveries.assign / reassign / accept / markCollected
(but not ads.edit / receipts.edit) may change ONLY the delivery-workflow
fields of an ad or receipt. The server writes the evidence itself - action
timestamps, actor ids, the delivery-history entry and every field a "Delete
mission" clears - so nothing the client sends for those is trusted.

Kept out of main.py, which sits at its line cap.
"""

from __future__ import annotations

from typing import Any, Callable

from fastapi import HTTPException

WORKFLOW_FIELDS = {
    "deliveryPersonId", "deliveryStatus", "acceptedDate", "deliveredAt",
    "isReceivedInOffice", "receivedInOfficeAt", "officeHandover", "officeHandoverAt",
    "deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy",
    "deliveryNotes", "_lastModified",
}

TRANSITIONS: dict[str, set[str]] = {
    "": {"Needs Delivery", "In Progress", "Office"},
    "Office": {"Needs Delivery", "In Progress", "Canceled"},  # editors may cancel an Office row; so may the assign grant
    "Needs Delivery": {"In Progress", "Canceled", "Office"},
    "In Progress": {"Canceled"},  # Delivered uses assigned-driver proof flow.
    "Delivered": set(),
    "Canceled": set(),
}

_TERMINAL = {"Delivered", "Canceled"}
_CANCEL_FIELDS = {"deliveryCancelReason", "deliveryCancelledAt", "deliveryCancelledBy"}
_OFFICE_FIELDS = {"isReceivedInOffice", "receivedInOfficeAt", "officeHandover", "officeHandoverAt"}

# History entries keep the client's shape ({ts, userId, action, reason?}) and
# labels (src/12-views.js submitDeliveryCancel / removeDeliveryMission), so a
# trail written here reads the same as one an admin's browser wrote.
CANCEL_ACTION = "CANCELLED_BY_DRIVER"
REMOVE_ACTION = "MISSION_REMOVED"

# "Delete mission" (-> Office) takes the job out of delivery tracking. Every
# one of these is cleared by the server whatever the client sent.
OFFICE_CLEARS: dict[str, Any] = {
    "deliveryPersonId": "", "acceptedDate": "",
    "deliveryCancelReason": "", "deliveryCancelledAt": "", "deliveryCancelledBy": "",
    "isReceivedInOffice": False, "receivedInOfficeAt": "", "officeHandover": False, "officeHandoverAt": "",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def patch_allowed(
    existing: dict[str, Any],
    updates: dict[str, Any],
    *,
    has: Callable[[str], bool],
    active_driver: Callable[[Any], bool],
) -> bool:
    """May this deliveries.* holder apply ``updates``? (``has`` = holds deliveries.<action>.)"""
    keys = set(updates.keys())
    data = existing.get("data") or {}
    current_status = _text(data.get("deliveryStatus"))
    target_status = _text(updates.get("deliveryStatus"))

    # The client sends its own history list with cancel / "Delete mission"
    # (the server rewrites it) and statusDetail with "Delete mission" (only
    # notPaidCollection is flipped). Neither key is accepted anywhere else.
    extra: set[str] = set()
    if target_status in {"Canceled", "Office"}:
        extra.add("deliveryHistory")
    if target_status == "Office":
        extra.add("statusDetail")
    if not keys or not keys.issubset(WORKFLOW_FIELDS | extra):
        return False
    if "deliveredAt" in keys:
        return False

    if target_status == "Office":
        # "Delete mission": the transition and the grant are the only
        # questions - normalize_grant_updates() clears the driver and every
        # workflow stamp itself, so the client's values for them do not matter.
        if target_status != current_status and "Office" not in TRANSITIONS.get(current_status, set()):
            return False
        return has("assign") or has("reassign")

    if "deliveryPersonId" in keys:
        if current_status in _TERMINAL:
            return False
        already = bool(_text(data.get("deliveryPersonId")))
        if not (has("reassign") if already else has("assign")):
            return False
        target_driver = _text(updates.get("deliveryPersonId"))
        if target_driver and not active_driver(target_driver):
            return False

    if target_status:
        if target_status == "Delivered":
            # Completion is handled only by the assigned-driver branch, which
            # verifies final receipt number, photo and collected amounts.
            return False
        if target_status != current_status:
            if target_status not in TRANSITIONS.get(current_status, set()):
                return False
            if target_status == "In Progress":
                if not has("accept"):
                    return False
            elif not (has("assign") or has("reassign")):
                return False

    if "acceptedDate" in keys and not (target_status == "In Progress" and has("accept")):
        return False

    if keys & _CANCEL_FIELDS:
        if current_status in _TERMINAL:
            return False
        if target_status != "Canceled" or not (has("assign") or has("reassign")):
            return False
        if not _text(updates.get("deliveryCancelReason")):
            return False

    if keys & _OFFICE_FIELDS:
        if not has("markCollected") or current_status != "Delivered":
            return False
        if "receivedInOfficeAt" in keys and "isReceivedInOffice" not in keys:
            return False
        if "officeHandoverAt" in keys and "officeHandover" not in keys:
            return False

    if "deliveryNotes" in keys and not (has("accept") or has("assign") or has("reassign")):
        return False
    return has("accept") or has("assign") or has("reassign") or has("markCollected")


def normalize_grant_updates(
    user: dict[str, Any],
    existing: dict[str, Any],
    updates: dict[str, Any],
    *,
    collection: str,
    now_iso: str,
    sanitize: Callable[[str], str],
) -> dict[str, Any]:
    """Client clocks, identities and history are not workflow evidence.

    Rewrites the action metadata of an authorized deliveries.* PATCH after
    authorization and before persistence; returns the fields to save.
    """
    out = dict(updates)
    out.pop("_lastModified", None)
    data = existing.get("data") or {}
    target_status = _text(out.get("deliveryStatus"))
    current_status = _text(data.get("deliveryStatus"))
    if target_status and target_status == current_status:
        raise HTTPException(status_code=409, detail=f"Delivery is already '{current_status}'")
    actor = str(user.get("id") or "")

    if target_status == "In Progress":
        out["acceptedDate"] = now_iso
    if target_status == "Canceled":
        out["deliveryCancelReason"] = sanitize(str(out.get("deliveryCancelReason") or ""))[:500]
        out["deliveryCancelledAt"] = now_iso
        out["deliveryCancelledBy"] = actor
    if "isReceivedInOffice" in out or "officeHandover" in out:
        received = bool(out.get("isReceivedInOffice", out.get("officeHandover")))
        out["isReceivedInOffice"] = received
        out["receivedInOfficeAt"] = now_iso if received else ""
        if "officeHandover" in out:
            out["officeHandover"] = received
            out["officeHandoverAt"] = now_iso if received else ""

    # The trail is the STORED one plus one entry written here - never the
    # client's list, which could drop or forge earlier entries.
    out.pop("deliveryHistory", None)
    if target_status in {"Canceled", "Office"}:
        stored = data.get("deliveryHistory")
        trail = [e for e in stored if isinstance(e, dict)] if isinstance(stored, list) else []
        entry: dict[str, Any] = {"ts": now_iso, "userId": actor, "action": CANCEL_ACTION if target_status == "Canceled" else REMOVE_ACTION}
        if target_status == "Canceled":
            entry["reason"] = out["deliveryCancelReason"]
        out["deliveryHistory"] = trail + [entry]

    if target_status == "Office":
        out.update(OFFICE_CLEARS)
        # A Not Paid receipt collected by the driver goes back to office
        # collection; nothing else in statusDetail changes.
        out.pop("statusDetail", None)
        if collection == "receipts":
            detail = data.get("statusDetail") if isinstance(data.get("statusDetail"), dict) else {}
            if _text(data.get("status")) == "Not Paid" and _text(detail.get("notPaidCollection")) == "delivery":
                out["statusDetail"] = {**detail, "notPaidCollection": "office"}
    return out


# The staff reopen table (receipts.edit without a delivery grant): a finished job is never
# handed back to a driver and an accepted job never moves backwards.
STAFF_ALLOWED_NEXT: dict[str, set[str]] = {
    "Delivered": {"Delivered", "Canceled", "Office"},
    "Canceled": {"Canceled", "Delivered", "Office"},
    "In Progress": {"In Progress", "Delivered", "Canceled", "Office"},
}


def refuse_regression(
    existing: dict[str, Any],
    updates: dict[str, Any],
    role_lower: str,
    *,
    active_driver: Callable[[str], bool],
) -> None:
    """Shared by /settle, /unsettle and the generic PATCH (the money routes used to skip both rules):
    the staff reopen table, "a finished job keeps its driver", and "a new driver must be active"."""
    current = str(existing.get("deliveryStatus") or "").strip()
    nxt = str(updates.get("deliveryStatus") or "").strip() if "deliveryStatus" in updates else ""
    if role_lower != "delivery" and current == "In Progress" and nxt == "Needs Delivery":
        # Nobody re-queues an accepted job under the driver's feet: cancel it or delete the mission.
        raise HTTPException(status_code=400, detail="An accepted delivery job cannot move back to Needs Delivery; cancel it or delete the mission")
    if role_lower not in {"delivery", "admin"} and "deliveryStatus" in updates:
        allowed = STAFF_ALLOWED_NEXT.get(current)
        if allowed is not None and nxt not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot change status from '{current}' to '{nxt}' - a delivery job cannot be reopened or moved backwards",
            )
    new_driver = str(updates.get("deliveryPersonId") or "").strip()
    old_driver = str(existing.get("deliveryPersonId") or "").strip()
    if new_driver and new_driver != old_driver and role_lower != "delivery":
        if str(existing.get("deliveryStatus") or "").strip() in {"Delivered", "Canceled"}:
            raise HTTPException(status_code=409, detail="A finished delivery job keeps its driver")
        if not active_driver(new_driver):
            raise HTTPException(status_code=400, detail="Assign an active delivery user")
