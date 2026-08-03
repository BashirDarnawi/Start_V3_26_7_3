"""Who a request comes from, and how often each auth flow may be attempted.

Split out of main.py to keep it under its architecture line cap. Two jobs:

1. ``_client_ip`` — decide the address a request is attributed to. Every bucket
   below is keyed on its answer, so getting it wrong breaks rate limiting in
   both directions: trust a spoofable header and an attacker gets a fresh
   allowance per request; trust nothing behind a reverse proxy and the whole
   internet shares one bucket that anyone can deliberately burn to lock real
   staff out.
2. The per-flow checks — login, password reset, first-run setup, and the
   system-browser app-login handoff/exchange.

The limits are tuned to be roomy for a real office behind one NAT address and
still far below what guessing a password would need. Every one is env-tunable
so a deployment can tighten or loosen without a code change.
"""

import ipaddress
import os

from fastapi import Request

# Only enable where the API is reachable ONLY through a trusted proxy that
# overwrites these headers. See server/README.md.
TRUST_PROXY_HEADERS = os.getenv("ALBAYAN_TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes"}

_LOGIN_WINDOW_MS = int(os.getenv("ALBAYAN_LOGIN_WINDOW_MS", str(15 * 60 * 1000)))
_LOGIN_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_MAX_ATTEMPTS", "20"))
# IP-independent per-account cap (defense against IP rotation). Higher than the
# per-IP cap so a shared office IP with a few users' honest mistakes never trips
# it, but far below what brute-forcing a password would need.
_LOGIN_EMAIL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_EMAIL_MAX_ATTEMPTS", "60"))
# Global per-IP ceiling across ALL emails. The (ip,email) bucket above does not
# stop one IP from spreading a password guess across many distinct accounts
# (horizontal credential stuffing). Set well above a shared office's honest
# traffic but far below a stuffing run.
_LOGIN_IP_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_LOGIN_IP_MAX_ATTEMPTS", "120"))

_RESET_WINDOW_MS = int(os.getenv("ALBAYAN_RESET_WINDOW_MS", str(15 * 60 * 1000)))
_RESET_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_MAX_ATTEMPTS", "5"))
_RESET_EMAIL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_EMAIL_MAX_ATTEMPTS", "15"))
# Ceiling on reset requests from ONE source address, whatever email they name.
# Deliberately roomy so a whole office behind a single NAT/Cloudflare address
# is never locked out of a legitimate reset, while still bounding the limiter
# keys and audit rows an unauthenticated stranger can create.
_RESET_IP_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_RESET_IP_MAX_ATTEMPTS", "60"))

_SETUP_WINDOW_MS = int(os.getenv("ALBAYAN_SETUP_WINDOW_MS", str(15 * 60 * 1000)))
_SETUP_IP_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_SETUP_IP_MAX_ATTEMPTS", "10"))
_SETUP_GLOBAL_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_SETUP_GLOBAL_MAX_ATTEMPTS", "100"))

# System-browser app-login limiter knobs. Handoff is authenticated (per-user
# and per-IP buckets); exchange is anonymous (per-IP bucket). Codes carry
# 256 bits of entropy, so these limits exist to bound abuse noise, not as the
# security boundary.
_APP_LOGIN_WINDOW_MS = int(os.getenv("ALBAYAN_APP_LOGIN_WINDOW_MS", str(15 * 60 * 1000)))
_APP_LOGIN_HANDOFF_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_APP_LOGIN_HANDOFF_MAX_ATTEMPTS", "10"))
_APP_LOGIN_EXCHANGE_MAX_ATTEMPTS = int(os.getenv("ALBAYAN_APP_LOGIN_EXCHANGE_MAX_ATTEMPTS", "30"))


def _is_loopback_peer(value: str) -> bool:
    try:
        return ipaddress.ip_address(str(value or "").strip()).is_loopback
    except ValueError:
        return False


def _client_ip(request: Request) -> str:
    """Real client IP for rate limiting, behind Cloudflare + ALB.

    SECURITY: the old version returned the LEFTMOST X-Forwarded-For entry, which
    is fully client-controlled — proxies APPEND, so a client-supplied
    `X-Forwarded-For: <random>` survives as element [0]. An attacker could then
    rotate that value each request and get a fresh (ip,email) rate-limit bucket,
    bypassing brute-force protection entirely. We now prefer Cloudflare's
    CF-Connecting-IP (Cloudflare overwrites any client-supplied value at its
    edge), and for the XFF fallback we take the RIGHTMOST entry (added by the
    closest trusted proxy) which a client cannot forge, rather than the spoofable
    leftmost one.
    """
    if TRUST_PROXY_HEADERS:
        try:
            cf = request.headers.get("cf-connecting-ip")
            if cf and cf.strip():
                return cf.strip()
            xff = request.headers.get("x-forwarded-for")
            if xff:
                parts = [p.strip() for p in xff.split(",") if p.strip()]
                if parts:
                    return parts[-1]
        except Exception:
            pass
    peer = request.client.host if request.client else "unknown"
    if not TRUST_PROXY_HEADERS and _is_loopback_peer(peer):
        # The socket peer is THIS machine, so the request can only have come
        # through the local reverse proxy — an outside attacker cannot make
        # request.client.host loopback. Without this, every user on earth
        # shared one "login:ip:127.0.0.1" bucket: real customers collided with
        # each other, and anyone could deliberately burn the shared allowance
        # and lock the whole company out of logging in.
        try:
            xff = request.headers.get("x-forwarded-for")
            if xff:
                # RIGHTMOST entry: appended by the closest proxy, unforgeable
                # by the client (which can only control the leftmost values).
                parts = [p.strip() for p in xff.split(",") if p.strip()]
                if parts:
                    return parts[-1]
        except Exception:
            pass
    return peer


def _rate_key(request: Request, email: str) -> str:
    """Generate rate limit key from IP + email"""
    return f"{_client_ip(request)}|{email.lower()}"


def _rate_check(request: Request, email: str) -> tuple[bool, int]:
    """
    Check login rate limit using Redis (if configured) or in-memory.

    Returns:
        (is_allowed, wait_ms)
        - is_allowed: True if request should proceed
        - wait_ms: Milliseconds to wait if rate limited
    """
    from .rate_limiter import check_rate_limit

    key = f"login:{_rate_key(request, email)}"
    is_allowed, attempts_left, retry_after_ms = check_rate_limit(key, _LOGIN_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)

    if not is_allowed:
        return False, int(retry_after_ms or 0)

    # Global per-IP ceiling across all emails: stops one IP from spreading a
    # single password guess over many accounts (horizontal credential stuffing),
    # which the per-(ip,email) bucket alone does not cover.
    ip_key = f"login:ip:{_client_ip(request)}"
    ok_ip, _left_ip, retry_ip = check_rate_limit(ip_key, _LOGIN_IP_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)
    if not ok_ip:
        return False, int(retry_ip or 0)

    # Defense in depth: an IP-independent per-account bucket. Even if an
    # attacker rotates IPs (or a forged proxy header) to dodge the (ip,email)
    # bucket above, a single account still can't be guessed more than
    # _LOGIN_EMAIL_MAX_ATTEMPTS times per window. Set high enough not to lock
    # out a legitimate user's honest mistakes across a shared office IP.
    email_key = f"login:email:{email.lower()}"
    ok2, _left2, retry2 = check_rate_limit(email_key, _LOGIN_EMAIL_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)
    if not ok2:
        return False, int(retry2 or 0)

    return True, 0


def _reset_rate_check(request: Request, email: str) -> tuple[bool, int]:
    """
    Check password reset rate limit using Redis (if configured) or in-memory.

    Returns:
        (is_allowed, wait_ms)
        - is_allowed: True if request should proceed
        - wait_ms: Milliseconds to wait if rate limited
    """
    from .rate_limiter import check_rate_limit

    # Global per-IP ceiling FIRST. Without it this unauthenticated endpoint
    # mints two brand-new limiter keys per request from an attacker-chosen
    # email — unbounded noise that both floods the limiter store and writes an
    # audit row per attempt. Sized generously (a whole office behind one NAT
    # address stays well under it) but finite. Mirrors reset-confirm:ip:.
    ip_ceiling_key = f"reset:ip:{_client_ip(request)}"
    ip_ok, _ip_left, ip_retry = check_rate_limit(
        ip_ceiling_key, _RESET_IP_MAX_ATTEMPTS, _RESET_WINDOW_MS
    )
    if not ip_ok:
        return False, int(ip_retry or 0)

    key = f"reset:{_rate_key(request, email)}"
    is_allowed, attempts_left, retry_after_ms = check_rate_limit(key, _RESET_MAX_ATTEMPTS, _RESET_WINDOW_MS)

    if not is_allowed:
        return False, int(retry_after_ms or 0)

    # IP-independent per-account bucket (see _rate_check) so IP rotation can't
    # grant unlimited reset requests against one email.
    email_key = f"reset:email:{email.lower()}"
    ok2, _left2, retry2 = check_rate_limit(email_key, _RESET_EMAIL_MAX_ATTEMPTS, _RESET_WINDOW_MS)
    if not ok2:
        return False, int(retry2 or 0)

    return True, 0


def _reset_confirm_rate_check(request: Request, token_hash: str) -> tuple[bool, int]:
    """Limit confirms by peer IP and one-way token hash, never a global key."""
    from .rate_limiter import check_rate_limit

    ip_key = f"reset-confirm:ip:{_client_ip(request)}"
    allowed, _left, retry = check_rate_limit(
        ip_key, _RESET_EMAIL_MAX_ATTEMPTS, _RESET_WINDOW_MS
    )
    if not allowed:
        return False, int(retry or 0)
    token_key = f"reset-confirm:token:{token_hash}"
    allowed, _left, retry = check_rate_limit(
        token_key, _RESET_MAX_ATTEMPTS, _RESET_WINDOW_MS
    )
    return bool(allowed), 0 if allowed else int(retry or 0)


def _setup_rate_check(request: Request) -> tuple[bool, int]:
    """Dedicated bootstrap limiter; never consumes login/account buckets."""
    from .rate_limiter import check_rate_limit

    allowed, _left, retry = check_rate_limit(
        f"setup:ip:{_client_ip(request)}", _SETUP_IP_MAX_ATTEMPTS, _SETUP_WINDOW_MS
    )
    if not allowed:
        return False, int(retry or 0)
    allowed, _left, retry = check_rate_limit(
        "setup:global", _SETUP_GLOBAL_MAX_ATTEMPTS, _SETUP_WINDOW_MS
    )
    return bool(allowed), 0 if allowed else int(retry or 0)


def _app_handoff_rate_check(request: Request, user_id: str) -> tuple[bool, int]:
    """Limit app-login handoff-code minting per IP and per authenticated user."""
    from .rate_limiter import check_rate_limit

    allowed, _left, retry = check_rate_limit(
        f"applogin-handoff:ip:{_client_ip(request)}",
        _APP_LOGIN_HANDOFF_MAX_ATTEMPTS,
        _APP_LOGIN_WINDOW_MS,
    )
    if not allowed:
        return False, int(retry or 0)
    allowed, _left, retry = check_rate_limit(
        f"applogin-handoff:user:{user_id}",
        _APP_LOGIN_HANDOFF_MAX_ATTEMPTS,
        _APP_LOGIN_WINDOW_MS,
    )
    return bool(allowed), 0 if allowed else int(retry or 0)


def _app_exchange_rate_check(request: Request) -> tuple[bool, int]:
    """Limit anonymous app-login code exchanges per peer IP."""
    from .rate_limiter import check_rate_limit

    allowed, _left, retry = check_rate_limit(
        f"applogin-exchange:ip:{_client_ip(request)}",
        _APP_LOGIN_EXCHANGE_MAX_ATTEMPTS,
        _APP_LOGIN_WINDOW_MS,
    )
    return bool(allowed), 0 if allowed else int(retry or 0)
