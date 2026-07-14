"""
Rate limiting for authentication endpoints.

Supports both in-memory (single-instance) and Redis (multi-instance) backends.
Set REDIS_URL environment variable to enable Redis-based rate limiting.

Security notes:
- Default: Login attempts are limited by `ALBAYAN_LOGIN_MAX_ATTEMPTS` / `ALBAYAN_LOGIN_WINDOW_MS` in `server/main.py`
- Call reset_rate_limit() on successful login to clear the user's failed attempts
- In-memory store is cleaned up periodically to prevent memory leaks
"""
import os
import secrets
import threading
import time
from typing import Any, Optional

# In-memory storage (fallback for single-instance deployments)
_MEMORY_STORE: dict[str, list[int]] = {}
_MEMORY_LOCK = threading.Lock()
_LAST_CLEANUP = 0
_CLEANUP_INTERVAL_MS = 5 * 60 * 1000  # Run cleanup every 5 minutes
_MAX_MEMORY_STORE_KEYS = 10000  # Maximum keys to prevent memory exhaustion

# Redis client (optional, for multi-instance deployments)
_REDIS_CLIENT: Optional[Any] = None
_REDIS_ENABLED = False

# One Redis command performs cleanup, admission, insertion, and expiry. Redis
# executes Lua scripts atomically, so parallel application instances cannot all
# observe the same pre-insert count and exceed the configured limit.
_REDIS_SLIDING_WINDOW_LUA = """
local key = KEYS[1]
local cutoff = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local max_attempts = tonumber(ARGV[3])
local member = ARGV[4]
local window_ms = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local current_count = redis.call('ZCARD', key)

if current_count >= max_attempts then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after_ms = window_ms
    if oldest[2] then
        retry_after_ms = math.max(0, (tonumber(oldest[2]) + window_ms) - now)
    end
    return {0, 0, retry_after_ms}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms + 60000)
local new_count = current_count + 1
return {1, math.max(0, max_attempts - new_count), 0}
"""


def _warn_in_memory_fallback(operation: str, error: BaseException) -> None:
    """Warn without rendering exception text, which may contain credentials."""
    print(
        f"[rate_limiter] WARNING: Redis {operation} failed "
        f"({type(error).__name__}); using single-process in-memory fallback."
    )


def _init_redis():
    """Initialize Redis client if REDIS_URL is configured."""
    global _REDIS_CLIENT, _REDIS_ENABLED

    # Make explicit re-initialization deterministic.
    _REDIS_CLIENT = None
    _REDIS_ENABLED = False

    redis_url = os.getenv("REDIS_URL", "").strip()
    if not redis_url:
        return
    
    try:
        import redis
        _REDIS_CLIENT = redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2
        )
        # Test connection
        _REDIS_CLIENT.ping()
        _REDIS_ENABLED = True
        # REDIS_URL and connection exceptions can contain credentials or access
        # tokens. Neither is safe to include in application logs.
        print("[rate_limiter] Redis rate limiting enabled.")
    except ImportError as error:
        _warn_in_memory_fallback("initialization", error)
    except Exception as e:
        _warn_in_memory_fallback("connection", e)


def now_ms() -> int:
    """Current timestamp in milliseconds"""
    return int(time.time() * 1000)


def _cleanup_memory_store(window_ms: int = 15 * 60 * 1000, force: bool = False):
    """
    Remove expired entries from in-memory store to prevent memory leaks.
    
    This runs periodically (every 5 minutes) during normal rate limit checks.
    Only cleans entries that have no attempts within the given window.
    
    Args:
        window_ms: Time window for considering attempts valid
        force: If True, run cleanup even if interval hasn't passed (used when size limit reached)
    """
    global _LAST_CLEANUP
    
    now = now_ms()
    
    # Skip if we cleaned up recently (unless forced)
    if not force and now - _LAST_CLEANUP < _CLEANUP_INTERVAL_MS:
        return
    
    _LAST_CLEANUP = now
    cutoff = now - window_ms
    
    with _MEMORY_LOCK:
        # Find keys to delete (can't modify dict during iteration)
        keys_to_delete = []
        for key, attempts in _MEMORY_STORE.items():
            # Filter out old attempts
            valid_attempts = [ts for ts in attempts if ts > cutoff]
            if not valid_attempts:
                keys_to_delete.append(key)
            else:
                _MEMORY_STORE[key] = valid_attempts
        
        # Delete empty keys
        for key in keys_to_delete:
            del _MEMORY_STORE[key]
        
        # SECURITY: If store is still too large after cleanup, remove oldest entries
        if len(_MEMORY_STORE) > _MAX_MEMORY_STORE_KEYS:
            # Sort by oldest attempt time and remove excess
            sorted_keys = sorted(
                _MEMORY_STORE.keys(),
                key=lambda k: min(_MEMORY_STORE[k]) if _MEMORY_STORE[k] else 0
            )
            excess_count = len(_MEMORY_STORE) - _MAX_MEMORY_STORE_KEYS
            for k in sorted_keys[:excess_count]:
                del _MEMORY_STORE[k]
            print(f"[rate_limiter] Memory store exceeded limit, removed {excess_count} oldest entries")
        
        if keys_to_delete:
            print(f"[rate_limiter] Cleaned up {len(keys_to_delete)} expired rate limit entries")


def check_rate_limit(key: str, max_attempts: int, window_ms: int) -> tuple[bool, int, int]:
    """
    Check whether `key` is allowed under a sliding window rate limit.

    IMPORTANT UX/SECURITY BEHAVIOR:
    - When the key is already rate-limited, we DO NOT record additional blocked attempts.
      This prevents a "stuck forever" lockout when users keep retrying while blocked.

    Args:
        key: Unique identifier (e.g., "login:192.168.1.1|user@example.com")
        max_attempts: Maximum allowed attempts within the window.
        window_ms: Time window in milliseconds.

    Returns:
        (is_allowed, attempts_remaining, retry_after_ms)
        - is_allowed: True if request should proceed
        - attempts_remaining: Attempts remaining AFTER recording this attempt (0 when blocked)
        - retry_after_ms: How long to wait until the oldest attempt exits the window (0 when allowed)
    """
    now = now_ms()
    cutoff = now - window_ms
    
    # Periodically clean up old entries (prevents memory leak)
    # Force cleanup if store is getting too large
    force_cleanup = len(_MEMORY_STORE) > _MAX_MEMORY_STORE_KEYS * 0.9  # 90% threshold
    _cleanup_memory_store(window_ms, force=force_cleanup)
    
    if _REDIS_ENABLED and _REDIS_CLIENT:
        try:
            # A timestamp alone is not a unique sorted-set member: simultaneous
            # requests in the same millisecond would overwrite one another and
            # evade the limit. The random suffix preserves every attempt.
            member = f"{now}:{secrets.token_hex(12)}"
            result = _REDIS_CLIENT.eval(
                _REDIS_SLIDING_WINDOW_LUA,
                1,
                key,
                cutoff,
                now,
                max_attempts,
                member,
                window_ms,
            )
            is_allowed = bool(int(result[0]))
            attempts_left = max(0, int(result[1]))
            retry_after_ms = max(0, int(result[2]))
            return is_allowed, attempts_left, retry_after_ms
        except Exception as e:
            _warn_in_memory_fallback("rate-limit check", e)
            # Fall through to in-memory
    
    # In-memory implementation (single-instance only)
    with _MEMORY_LOCK:
        if key not in _MEMORY_STORE:
            _MEMORY_STORE[key] = []
        
        attempts = _MEMORY_STORE[key]
        
        # Remove old attempts
        attempts[:] = [ts for ts in attempts if ts > cutoff]

        # If already rate-limited, do NOT record blocked attempts.
        if len(attempts) >= max_attempts:
            oldest_ts = min(attempts) if attempts else 0
            retry_after_ms = max(0, (oldest_ts + window_ms) - now) if oldest_ts else window_ms
            return False, 0, int(retry_after_ms)

        # Record this allowed attempt
        attempts.append(now)

        attempts_left = max(0, max_attempts - len(attempts))
        return True, attempts_left, 0


def reset_rate_limit(key: str):
    """
    Reset rate limit for a key (call after successful login).
    
    This clears all failed attempts for the given key, allowing the user
    to immediately retry if they get locked out and then remember their password.
    
    Args:
        key: Same key used in check_rate_limit (e.g., "login:192.168.1.1|user@example.com")
    
    Example:
        # After successful login:
        reset_rate_limit(f"login:{ip}|{email}")
    """
    if _REDIS_ENABLED and _REDIS_CLIENT:
        try:
            _REDIS_CLIENT.delete(key)
        except Exception as error:
            _warn_in_memory_fallback("reset", error)
    
    # Always clear fallback state too. It may contain attempts recorded during a
    # prior Redis outage even when Redis has recovered by the time reset runs.
    with _MEMORY_LOCK:
        if key in _MEMORY_STORE:
            del _MEMORY_STORE[key]


def get_rate_limit_status(key: str, window_ms: int) -> int:
    """
    Get current attempt count for a key within the window (read-only).
    
    Use this to display "X attempts remaining" to users without recording a new attempt.
    
    Args:
        key: Rate limit key
        window_ms: Time window in milliseconds
    
    Returns:
        Number of attempts in the current window
    """
    now = now_ms()
    cutoff = now - window_ms
    
    if _REDIS_ENABLED and _REDIS_CLIENT:
        try:
            # Remove old attempts
            _REDIS_CLIENT.zremrangebyscore(key, 0, cutoff)
            # Count remaining
            return _REDIS_CLIENT.zcard(key)
        except Exception as error:
            _warn_in_memory_fallback("status check", error)
    
    # In-memory
    with _MEMORY_LOCK:
        if key not in _MEMORY_STORE:
            return 0
        
        attempts = _MEMORY_STORE[key]
        attempts[:] = [ts for ts in attempts if ts > cutoff]
        return len(attempts)


def get_memory_store_size() -> int:
    """Get the number of keys in the in-memory store (for monitoring)."""
    with _MEMORY_LOCK:
        return len(_MEMORY_STORE)


# Initialize on module import
_init_redis()
