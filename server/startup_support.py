"""Small startup helpers kept out of main.py (which sits at its line cap)."""

from __future__ import annotations

import time
from typing import Callable


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
