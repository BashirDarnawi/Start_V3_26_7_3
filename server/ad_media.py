"""Permission-scoped delivery of one Albayan ad photo at a time."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Response


def enforce_ad_photo_mutation_permissions(
    requested: dict[str, Any],
    existing: dict[str, Any] | None,
    *,
    can_upload: bool,
    can_view: bool,
) -> None:
    """Authorize actual uploaded-photo changes, including the legacy alias.

    Old clients may echo empty/unchanged fields on a text edit. Omitted photos
    must stay untouched; equality must be checked against the locked row for
    updates so a stale empty array cannot erase a concurrent upload.
    """
    previous = existing or {}
    for field in ("adPhotos", "photos"):
        if field not in requested:
            continue
        before, after = previous.get(field), requested[field]
        if before == after or (before in (None, "", []) and after in (None, "", [])):
            continue
        if not can_upload or (existing is not None and not can_view):
            raise HTTPException(status_code=403, detail="Photo changes require Upload Photos and, for existing ads, View Photos permission")
    if (
        existing is not None
        and "primaryAdPhotoIndex" in requested
        and requested["primaryAdPhotoIndex"] != previous.get("primaryAdPhotoIndex", 0)
        and not can_view
    ):
        raise HTTPException(status_code=403, detail="View Photos permission is required to choose the main photo")


# The only photo source the app stores: a PNG/JPEG/GIF/WebP data URL. The read
# routes refuse anything else; the generic write path must refuse it too, or an
# insider could store an https:// tracking pixel that every viewer's browser
# fetches, or an SVG/HTML "image" that some viewers would execute.
INLINE_IMAGE_DATA_URL_RE = re.compile(r"data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})", re.IGNORECASE)


def require_data_url_media(fields, requested, existing=None) -> None:
    """Refuse a write whose photo fields hold anything but image data URLs.

    Only string entries are judged (objects are left to the field's own
    sanitizer); empty values and values equal to what is already stored pass,
    so a legacy record echoed back unchanged is still accepted.
    """
    if not isinstance(requested, dict):
        return
    current = existing if isinstance(existing, dict) else {}
    for field in fields or ():
        if field not in requested:
            continue
        value = requested.get(field)
        stored = current.get(field)
        stored_values = stored if isinstance(stored, list) else [stored]
        candidates = value if isinstance(value, list) else [value]
        for item in candidates:
            if not isinstance(item, str) or not item.strip():
                continue
            if item in stored_values:
                continue
            if not INLINE_IMAGE_DATA_URL_RE.fullmatch(item):
                raise HTTPException(status_code=400, detail="Photos must be PNG, JPEG, GIF or WebP images uploaded from the device")


def data_url_image_response(source: str, max_data_url_length: int) -> Response:
    """Decode one stored data-URL photo into an image response (shared by the
    ad and clothes-product photo routes). Refuses remote/unknown values so the
    route can never act as an open proxy."""
    if len(source) > max_data_url_length:
        raise HTTPException(status_code=413, detail="Photo is too large")
    match = INLINE_IMAGE_DATA_URL_RE.fullmatch(source)
    if not match:
        # Uploaded photos are stored as data URLs. Refuse remote/unknown
        # values instead of turning this route into an open proxy.
        raise HTTPException(status_code=404, detail="Photo source unavailable")
    try:
        content = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="Invalid photo data")
    if not content:
        raise HTTPException(status_code=422, detail="Invalid photo data")

    subtype = match.group(1).lower()
    if subtype in {"jpg", "jpeg"}:
        subtype = "jpeg"
    return Response(
        content=content,
        media_type=f"image/{subtype}",
        headers={
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Vary": "Cookie, Origin",
        },
    )


def create_ad_media_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    get_entity_fn: Callable[[str, str], Optional[dict[str, Any]]],
    user_has_permission_fn: Callable[..., bool],
    max_data_url_length: int,
) -> APIRouter:
    """Build the ad-media router without importing the main application."""
    router = APIRouter()

    @router.get("/api/collections/ads/{entity_id}/primary-photo")
    def get_ad_primary_photo(
        entity_id: str,
        index: Optional[int] = None,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Return one authorized thumbnail without hydrating every photo."""
        item = get_entity_fn("ads", entity_id)
        if not item or item.get("deleted"):
            raise HTTPException(status_code=404, detail="Not found")

        data = item.get("data") or {}
        creator = item.get("createdBy") or data.get("createdBy") or data.get("creatorId")
        role_lower = str(user.get("role") or "").lower()
        if role_lower == "delivery":
            if str(data.get("deliveryPersonId") or "") != str(user.get("id") or ""):
                raise HTTPException(status_code=403, detail="Forbidden")
        elif not user_has_permission_fn(
            user,
            "ads",
            "view",
            record_creator_id=str(creator or ""),
        ):
            raise HTTPException(status_code=403, detail="Forbidden")
        if not user_has_permission_fn(user, "ads", "viewPhotos"):
            raise HTTPException(status_code=403, detail="View Photos permission required")

        sources: list[str] = []
        seen: set[str] = set()
        for field in ("adPhotos", "photos"):
            values = data.get(field)
            # A single string counts as one photo in the lists: serve it too.
            values = values if isinstance(values, list) else [values]
            for value in values:
                source = str(value or "").strip()
                if not source or source in seen:
                    continue
                seen.add(source)
                sources.append(source)
        if not sources:
            raise HTTPException(status_code=404, detail="Photo not found")

        selected = index
        if selected is None:
            try:
                selected = int(data.get("primaryAdPhotoIndex") or 0)
            except (TypeError, ValueError):
                selected = 0
        if selected is None or selected < 0 or selected >= len(sources):
            selected = 0

        return data_url_image_response(sources[selected], max_data_url_length)

    return router
