"""Clothes-product photo route.

Product lists are served lean (``include_media=false`` strips the single
``photo`` data URL, see entity_projection.INLINE_MEDIA_FIELDS); the product
cards load their thumbnail from this route instead, which the browser lazy-
loads and caches. Permissions mirror reading the product by id: the clothes
subscription gate, then view or view-own on the record.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException

from .ad_media import data_url_image_response


def create_clothes_media_router(
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    get_entity_fn: Callable[[str, str], Optional[dict[str, Any]]],
    user_has_permission_fn: Callable[..., bool],
    require_clothes_subscription_fn: Callable[[dict[str, Any]], None],
    max_data_url_length: int,
) -> APIRouter:
    """Build the clothes-media router without importing the main application."""
    router = APIRouter()

    @router.get("/api/collections/clothesProducts/{entity_id}/photo")
    def get_clothes_product_photo(
        entity_id: str,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        """Return one product's photo without carrying it in every list row."""
        require_clothes_subscription_fn(user)
        item = get_entity_fn("clothesProducts", entity_id)
        if not item or item.get("deleted"):
            raise HTTPException(status_code=404, detail="Not found")
        data = item.get("data") or {}
        creator = item.get("createdBy") or data.get("createdBy") or data.get("creatorId")
        if not user_has_permission_fn(user, "clothesProducts", "view") and not user_has_permission_fn(
            user, "clothesProducts", "view", record_creator_id=str(creator or "")
        ):
            raise HTTPException(status_code=403, detail="Forbidden")
        source = str(data.get("photo") or "").strip()
        if not source:
            raise HTTPException(status_code=404, detail="Photo not found")
        return data_url_image_response(source, max_data_url_length)

    return router
