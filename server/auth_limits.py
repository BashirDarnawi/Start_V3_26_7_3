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
from .startup_support import read_env_int
import os

from fastapi import Request

# Only enable where the API is reachable ONLY through a trusted proxy that
# overwrites these headers. See server/README.md.
TRUST_PROXY_HEADERS = os.getenv("ALBAYAN_TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes"}

_LOGIN_WINDOW_MS = read_env_int("ALBAYAN_LOGIN_WINDOW_MS", 15 * 60 * 1000)
_LOGIN_MAX_ATTEMPTS = read_env_int("ALBAYAN_LOGIN_MAX_ATTEMPTS", 20)
# IP-independent per-account cap (defense against IP rotation). Higher than the
# per-IP cap so a shared office IP with a few users' honest mistakes never trips
# it, but far below what brute-forcing a password would need.
_LOGIN_EMAIL_MAX_ATTEMPTS = read_env_int("ALBAYAN_LOGIN_EMAIL_MAX_ATTEMPTS", 60)
# Global per-IP ceiling across ALL emails. The (ip,email) bucket above does not
# stop one IP from spreading a password guess across many distinct accounts
# (horizontal credential stuffing). Set well above a shared office's honest
# traffic but far below a stuffing run.
_LOGIN_IP_MAX_ATTEMPTS = read_env_int("ALBAYAN_LOGIN_IP_MAX_ATTEMPTS", 120)
# While the per-account bucket is full, an address this account signed in from
# within this window may still try (see _login_address_known).
_LOGIN_KNOWN_ADDRESS_MS = read_env_int("ALBAYAN_LOGIN_KNOWN_ADDRESS_MS", 30 * 24 * 60 * 60 * 1000)

_RESET_WINDOW_MS = read_env_int("ALBAYAN_RESET_WINDOW_MS", 15 * 60 * 1000)
_RESET_MAX_ATTEMPTS = read_env_int("ALBAYAN_RESET_MAX_ATTEMPTS", 5)
_RESET_EMAIL_MAX_ATTEMPTS = read_env_int("ALBAYAN_RESET_EMAIL_MAX_ATTEMPTS", 15)
# Ceiling on reset requests from ONE source address, whatever email they name.
# Deliberately roomy so a whole office behind a single NAT/Cloudflare address
# is never locked out of a legitimate reset, while still bounding the limiter
# keys and audit rows an unauthenticated stranger can create.
_RESET_IP_MAX_ATTEMPTS = read_env_int("ALBAYAN_RESET_IP_MAX_ATTEMPTS", 60)

_SETUP_WINDOW_MS = read_env_int("ALBAYAN_SETUP_WINDOW_MS", 15 * 60 * 1000)
_SETUP_IP_MAX_ATTEMPTS = read_env_int("ALBAYAN_SETUP_IP_MAX_ATTEMPTS", 10)
_SETUP_GLOBAL_MAX_ATTEMPTS = read_env_int("ALBAYAN_SETUP_GLOBAL_MAX_ATTEMPTS", 100)

# System-browser app-login limiter knobs. Handoff is authenticated (per-user
# and per-IP buckets); exchange is anonymous (per-IP bucket). Codes carry
# 256 bits of entropy, so these limits exist to bound abuse noise, not as the
# security boundary.
_APP_LOGIN_WINDOW_MS = read_env_int("ALBAYAN_APP_LOGIN_WINDOW_MS", 15 * 60 * 1000)
_APP_LOGIN_HANDOFF_MAX_ATTEMPTS = read_env_int("ALBAYAN_APP_LOGIN_HANDOFF_MAX_ATTEMPTS", 10)
# Per shared address (an office behind one NAT): matches the exchange cap, so
# the two per-IP ceilings of the same 1:1 flow agree.
_APP_LOGIN_HANDOFF_IP_MAX_ATTEMPTS = read_env_int("ALBAYAN_APP_LOGIN_HANDOFF_IP_MAX_ATTEMPTS", 30)
_APP_LOGIN_EXCHANGE_MAX_ATTEMPTS = read_env_int("ALBAYAN_APP_LOGIN_EXCHANGE_MAX_ATTEMPTS", 30)


def _header_ip(value) -> str | None:
    """A forwarded address, only when it really is one. The sessions,
    password_resets and app_logins ip columns are VARCHAR(80): an unchecked
    header of any length made those inserts fail on PostgreSQL (HTTP 500)."""
    candidate = str(value or "").strip()
    if not candidate or len(candidate) > 64:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _is_loopback_peer(value: str) -> bool:
    try:
        return ipaddress.ip_address(str(value or "").strip()).is_loopback
    except ValueError:
        return False


_UNTRUSTED_PROXY_WARNED = False


def _warn_untrusted_proxy_once(request: Request) -> None:
    """Log once when proxy headers arrive but are (by configuration) ignored."""
    global _UNTRUSTED_PROXY_WARNED
    if _UNTRUSTED_PROXY_WARNED:
        return
    try:
        seen = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
    except Exception:
        seen = None
    if not seen:
        return
    _UNTRUSTED_PROXY_WARNED = True
    print(
        "[albayan] WARNING: requests carry CF-Connecting-IP / X-Forwarded-For but "
        "ALBAYAN_TRUST_PROXY_HEADERS is off, so every visitor shares one per-address "
        "login/reset allowance and one bad actor can exhaust it for everybody. If this "
        "server is reachable only through Cloudflare or the platform load balancer, set "
        "ALBAYAN_TRUST_PROXY_HEADERS=true."
    )


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
            # Header values that are not an IP address are ignored (_header_ip).
            cf = _header_ip(request.headers.get("cf-connecting-ip"))
            # A request that reached the load balancer WITHOUT passing Cloudflare
            # can carry any CF-Connecting-IP. When an origin secret is configured
            # only requests that presented it (the Cloudflare edge) may name the
            # client; the rest fall back to the unforgeable rightmost hop.
            secret_configured = bool((os.getenv("ALBAYAN_ORIGIN_SECRET") or "").strip())
            cf_trusted = bool(cf) and (
                not secret_configured or bool(getattr(getattr(request, "state", None), "origin_secret_ok", False))
            )
            if cf_trusted:
                return cf
            xff = request.headers.get("x-forwarded-for")
            if xff:
                parts = [p.strip() for p in xff.split(",") if p.strip()]
                if parts and _header_ip(parts[-1]):
                    return _header_ip(parts[-1])
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
                if parts and _header_ip(parts[-1]):
                    return _header_ip(parts[-1])
        except Exception:
            pass
    if not TRUST_PROXY_HEADERS:
        _warn_untrusted_proxy_once(request)
    return str(peer)[:80]  # the ip columns are VARCHAR(80)


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
    from .rate_limiter import check_rate_limit, get_rate_limit_status

    # An address already over its ceiling is refused BEFORE a new
    # (ip,email) bucket exists: otherwise each made-up email still minted a
    # key and the flood filled the limiter store. Read-only, so a blocked
    # account's retries still never spend the office's shared allowance.
    ip_key = f"login:ip:{_client_ip(request)}"
    if get_rate_limit_status(ip_key, _LOGIN_WINDOW_MS) >= _LOGIN_IP_MAX_ATTEMPTS:
        ok_ip, _left_ip, retry_ip = check_rate_limit(ip_key, _LOGIN_IP_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)
        if not ok_ip:
            return False, int(retry_ip or 0)

    key = f"login:{_rate_key(request, email)}"
    is_allowed, attempts_left, retry_after_ms = check_rate_limit(key, _LOGIN_MAX_ATTEMPTS, _LOGIN_WINDOW_MS)

    if not is_allowed:
        return False, int(retry_after_ms or 0)

    # Global per-IP ceiling across all emails: stops one IP from spreading a
    # single password guess over many accounts (horizontal credential stuffing),
    # which the per-(ip,email) bucket alone does not cover.
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
    if not ok2 and not _login_address_known(email, _client_ip(request)):
        return False, int(retry2 or 0)

    return True, 0


def _login_address_known(email: str, ip: str) -> bool:
    """Did this account sign in from this address within the last 30 days?

    Anyone who knows an email can fill its per-account bucket from a few
    addresses and keep the real person out, correct password or not. Past
    that bucket, an address the account already signed in from may still try:
    a wrong password from it still gets 401 and its own (ip,email) bucket still
    caps it, while new addresses stay blocked (the IP-rotation defence). An
    unknown email and an unknown address get the same 429.
    """
    try:
        from sqlalchemy import text

        from .db import db_conn, json_loads, now_ms

        since = now_ms() - _LOGIN_KNOWN_ADDRESS_MS
        with db_conn() as conn:
            user_id = conn.execute(
                text("SELECT id FROM users WHERE lower(email)=lower(:email) AND deleted = false LIMIT 1"),
                {"email": email},
            ).scalar()
            if not user_id or not ip:
                return False
            if conn.execute(
                text("SELECT 1 FROM sessions WHERE user_id=:uid AND ip=:ip AND created_at>=:since LIMIT 1"),
                {"uid": user_id, "ip": ip, "since": since},
            ).first():
                return True
            # Expired sessions are deleted, so a daily sign-in is also known
            # from the address its login audit row recorded.
            rows = conn.execute(
                text(
                    "SELECT metadata_json FROM audit_logs WHERE user_id=:uid AND action='login' "
                    "AND ts>=:since ORDER BY ts DESC LIMIT 50"
                ),
                {"uid": user_id, "since": since},
            ).scalars().all()
        for raw in rows:
            try:
                meta = json_loads(raw or "")
            except ValueError:
                continue
            if isinstance(meta, dict) and meta.get("ip") == ip:
                return True
        return False
    except Exception:
        return False


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
        _APP_LOGIN_HANDOFF_IP_MAX_ATTEMPTS,
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
