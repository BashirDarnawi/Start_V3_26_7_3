"""Permission-scoped delivery of one Albayan ad photo at a time."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Response


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
            if not isinstance(values, list):
                continue
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

        source = sources[selected]
        if len(source) > max_data_url_length:
            raise HTTPException(status_code=413, detail="Photo is too large")
        match = re.fullmatch(
            r"data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})",
            source,
            flags=re.IGNORECASE,
        )
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

    return router
