"""Small startup helpers kept out of main.py (which sits at its line cap)."""

from __future__ import annotations

import time
from typing import Any, Callable


def safe_exception_text(exc: BaseException, limit: int = 300) -> str:
    """Exception text for the log without bound SQL parameters.

    SQLAlchemy statement errors embed ``[parameters: {...}]`` - the values of
    the failing statement, which on the users table are password hashes and
    salts. The message stays useful; the parameters never reach the log.
    """
    text_value = str(exc)
    cut = text_value.find("[parameters:")
    if cut >= 0:
        text_value = text_value[:cut] + "[parameters: redacted]"
    return text_value[:limit]


def install_validation_handler(app: Any) -> None:
    """FastAPI's default 422 body repeats the offending input (a ~1 MB wrong-typed
    field comes straight back; a password sent as a list is echoed). Keep the
    location, message and type - enough for the client's field hints."""
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Any, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": list(e.get("loc") or ()), "msg": str(e.get("msg") or ""), "type": str(e.get("type") or "")}
            for e in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})


def request_size_refusal(request: Any) -> Any:
    """The body-size gate for POST/PUT/PATCH (returns a JSONResponse or None).

    Every write body is capped at 10 MB. The body is parsed BEFORE the session
    is checked, so an anonymous caller could otherwise make the server build
    10 MB of JSON objects per request; every sign-in-free route (login, setup,
    reset, app-login exchange, webhook) carries a small body, so anything over
    256 KB without a session cookie is refused unread. An API write without a
    Content-Length (chunked body) is refused too: the check above needs it and
    every legitimate client sends it."""
    from fastapi.responses import JSONResponse

    if request.method not in ("POST", "PUT", "PATCH"):
        return None
    path = str(request.url.path)
    content_length = request.headers.get("content-length")
    max_size = 10 * 1024 * 1024
    anonymous = path.startswith("/api/") and "albayan_session" not in request.cookies and not path.startswith("/api/meta-ads/webhook")
    if anonymous:
        max_size = 256 * 1024
    if content_length:
        try:
            size = int(content_length)
        except (ValueError, TypeError):
            return None  # invalid header: the framework rejects it later
        if size > max_size:
            if anonymous:
                return JSONResponse({"detail": "Sign in before sending a request this large"}, status_code=401)
            return JSONResponse({"detail": f"Request too large (max {max_size / 1024 / 1024:.0f} MB)"}, status_code=413)
        return None
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Length Required: Content-Length header is required for this request"}, status_code=411)
    return None


def init_db_with_retry(init_db: Callable[[], object], *, attempts: int = 10, delay_seconds: float = 3.0) -> None:
    """A database that is briefly unreachable at boot must not kill the container.

    Every other startup step is wrapped; this one used to raise straight out
    of uvicorn's startup, and the platform does not restart an exited container."""
    for attempt in range(1, attempts + 1):
        try:
            init_db()
            return
        except Exception as error:
            if attempt >= attempts:
                raise
            print(
                f"[albayan] Database not ready at startup ({type(error).__name__}); "
                f"retry {attempt}/{attempts - 1} in {delay_seconds:g}s"
            )
            time.sleep(delay_seconds)
