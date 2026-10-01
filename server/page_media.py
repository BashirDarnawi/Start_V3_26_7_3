"""Facebook Page picture route.

Page lists are served lean (``include_media=false`` strips our archived copy
of the page picture, see entity_projection.INLINE_MEDIA_FIELDS); ad rows show
the avatar from this route instead. Permissions mirror reading the page by
id: view, or view-own on the record.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException

from .ad_media import data_url_image_response


def create_page_media_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    get_entity_fn: Callable[[str, str], Optional[dict[str, Any]]],
    user_has_permission_fn: Callable[..., bool],
    max_data_url_length: int,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/collections/pages/{entity_id}/picture")
    def get_page_picture(entity_id: str, user: dict[str, Any] = Depends(current_user_dependency)):
        item = get_entity_fn("pages", entity_id)
        if not item or item.get("deleted"):
            raise HTTPException(status_code=404, detail="Not found")
        data = item.get("data") or {}
        creator = item.get("createdBy") or data.get("createdBy") or data.get("creatorId")
        if not user_has_permission_fn(user, "pages", "view") and not user_has_permission_fn(
            user, "pages", "view", record_creator_id=str(creator or "")
        ):
            raise HTTPException(status_code=403, detail="Forbidden")
        source = str(data.get("metaPagePictureData") or "").strip()
        if not source:
            raise HTTPException(status_code=404, detail="Picture not found")
        return data_url_image_response(source, max_data_url_length)

    return router
