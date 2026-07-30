"""HTTP response hardening kept separate from the application routes."""

from __future__ import annotations

import os
import secrets
from collections.abc import Awaitable, Callable, Collection, Sequence

from fastapi import Request, Response
from fastapi.responses import JSONResponse


async def apply_security_headers(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
    *,
    origin_secrets: Sequence[str],
    origin_bypass_paths: Collection[str],
    origin_secret_header: str,
) -> Response:
    """Enforce the optional origin secret and apply browser defenses."""
    if origin_secrets and request.url.path not in origin_bypass_paths:
        provided = request.headers.get(origin_secret_header)
        valid = bool(provided) and any(
            secrets.compare_digest(provided, value) for value in origin_secrets
        )
        response = (
            await call_next(request)
            if valid
            else JSONResponse({"detail": "Forbidden"}, status_code=403)
        )
    else:
        response = await call_next(request)

    response.headers.update(
        {
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "X-XSS-Protection": "0",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
            "X-Permitted-Cross-Domain-Policies": "none",
            "Content-Security-Policy": (
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
                "img-src 'self' data: blob: https:; connect-src 'self' https:; "
                "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; "
                "form-action 'self'; base-uri 'self'; manifest-src 'self';"
            ),
        }
    )
    if request.url.path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    if os.getenv("ALBAYAN_CROSS_ORIGIN_ISOLATION", "").strip().lower() in {"1", "true", "yes"}:
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    return response
