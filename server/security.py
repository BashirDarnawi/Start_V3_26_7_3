import hashlib
import hmac
import secrets
from dataclasses import dataclass


# OWASP's current PBKDF2-HMAC-SHA256 baseline. Existing lower-work-factor
# hashes remain valid and are upgraded transparently after a successful login.
PBKDF2_ITERATIONS_DEFAULT = 600_000


def new_id(prefix: str) -> str:
    """Generate secure random ID with 128 bits of entropy (improved from 96 bits)"""
    return f"{prefix}_{secrets.token_hex(16)}"  # 16 bytes = 128 bits (was 12 = 96 bits)


def _bytes_to_hex(b: bytes) -> str:
    return b.hex()


def _hex_to_bytes(s: str) -> bytes:
    return bytes.fromhex(s)


@dataclass(frozen=True)
class PasswordHash:
    hash_hex: str
    salt_hex: str
    algo: str
    iterations: int


def hash_password(
    password: str,
    *,
    salt_hex: str | None = None,
    iterations: int = PBKDF2_ITERATIONS_DEFAULT,
) -> PasswordHash:
    # PBKDF2-SHA256 (recommended)
    iterations = int(iterations)
    if not 1 <= iterations <= 10_000_000:
        raise ValueError("PBKDF2 iterations are outside the supported range")
    salt = _hex_to_bytes(salt_hex) if salt_hex else secrets.token_bytes(16)
    if not 8 <= len(salt) <= 128:
        raise ValueError("Password salt is outside the supported range")
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
    return PasswordHash(hash_hex=_bytes_to_hex(dk), salt_hex=_bytes_to_hex(salt), algo="pbkdf2-sha256", iterations=iterations)


def verify_password(password: str, stored_hash_hex: str, salt_hex: str, algo: str, iterations: int) -> bool:
    if algo != "pbkdf2-sha256":
        # Fail closed (don’t accept unknown algorithms)
        return False
    try:
        if len(stored_hash_hex) != 64:
            return False
        bytes.fromhex(stored_hash_hex)
        calc = hash_password(password, salt_hex=salt_hex, iterations=iterations)
        return hmac.compare_digest(calc.hash_hex, stored_hash_hex.lower())
    except (TypeError, ValueError, OverflowError):
        # Corrupt database values must fail authentication instead of causing
        # a 500 response or an excessive PBKDF2 workload.
        return False


def password_hash_needs_upgrade(algo: str, iterations: int) -> bool:
    """Return True when a verified password should be re-hashed on login."""
    try:
        return algo != "pbkdf2-sha256" or int(iterations) < PBKDF2_ITERATIONS_DEFAULT
    except (TypeError, ValueError):
        return True


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_cookie_value(session_id: str, token: str) -> str:
    return f"{session_id}.{token}"


def parse_session_cookie_value(value: str) -> tuple[str, str] | None:
    if not value or "." not in value:
        return None
    session_id, token = value.split(".", 1)
    if not session_id or not token:
        return None
    return session_id, token
