import hashlib
import hmac
import re
import secrets
import unicodedata
from dataclasses import dataclass

from fastapi import HTTPException
from pydantic import EmailStr, TypeAdapter


# OWASP's current PBKDF2-HMAC-SHA256 baseline. Existing lower-work-factor
# hashes remain valid and are upgraded transparently after a successful login.
PBKDF2_ITERATIONS_DEFAULT = 600_000

_SIGNIN_EMAIL = TypeAdapter(EmailStr)


def normalize_signin_email(raw: object) -> str:
    """The address as the API's own EmailStr rule stores it (lower-cased).

    Raises ValueError (pydantic's ValidationError) for an address the API
    refuses: an admin stored as e.g. owner@albayan could never sign in, and
    its row made GET /api/users answer 500 for every user manager.

    The STORED form is the one that must be valid, and lower-casing can break
    it: "\u0130" (a dotted capital I) becomes two characters, so 33 of them pass
    the 64-character rule, were stored as 66 and broke that same list; a single
    one was stored as an address its owner could never sign in with again.
    """
    value = str(_SIGNIN_EMAIL.validate_python(str(raw or "").strip()))
    stored = value.lower()
    if any(len(char.lower()) != 1 for char in value) or str(_SIGNIN_EMAIL.validate_python(stored)) != stored:
        raise ValueError("Not a valid sign-in email")
    return stored


def signin_email_or_400(raw: object) -> str:
    """normalize_signin_email for a request: a refused address answers HTTP 400."""
    try:
        return normalize_signin_email(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Not a valid sign-in email") from None


# Passwords an attacker tries first. Online guessing is throttled, so what matters is the short
# list everybody knows: this is that list plus the patterns below, not a strength meter.
_COMMON_PASSWORDS = frozenset("""
password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword p@ssw0rd1 pass1234 pass12345
12345678 123456789 1234567890 0123456789 87654321 987654321 11111111 00000000 12341234 11223344 12344321 123123123
1q2w3e4r 1q2w3e4r5t 1qaz2wsx 1qazxsw2 qwerty123 qwerty12 qwertyui qwertyuiop asdfghjk asdfghjkl zxcvbnm1 q1w2e3r4
abcd1234 abc12345 abcdefgh a1b2c3d4 aa123456 a1234567 a12345678 123456a 123456aa 123456ab 123456abc 1234qwer qwer1234
iloveyou iloveyou1 sunshine princess football baseball superman starwars whatever trustno1 welcome1 welcome123
letmein1 letmein123 changeme changeme1 changeme123 default1 secret123 secret12 master123 monkey123 dragon123
admin123 admin1234 admin12345 admin@123 admin2024 admin2025 admin2026 administrator root1234 toor1234 test1234
testtest test12345 user1234 guest1234 login123 temp1234 demo1234 hello123 hello1234 internet computer mustang1
michael1 jennifer jordan23 liverpool chelsea1 arsenal1 barcelona realmadrid juventus manchester ronaldo7 messi10
mohamed123 mohammed123 ahmed123 ahmed1234 ali123456 mahmoud123 mustafa123 abdullah123 libya123 libya2011 libya2024
libya2025 libya2026 tripoli123 benghazi123 misrata123 bismillah allah123 allahakbar albayan albayan1 albayan123
albayan2024 albayan2025 albayan2026 albayanhub
""".split())
_GUESSABLE_WORDS = frozenset({"albayan", "albayanhub", "admin", "administrator", "password", "welcome", "qwerty", "letmein", "login"})
WEAK_PASSWORD_DETAIL = (
    "This password is too easy to guess. Use at least 8 characters that are not a common password, "
    "a simple sequence, only a few digits, or your own name or e-mail. "
    "كلمة المرور سهلة التخمين. استخدم 8 أحرف على الأقل، وليست كلمة شائعة أو تسلسلاً بسيطاً أو أرقاماً قليلة أو اسمك أو بريدك."
)


def weak_password_reason(password: object, *identity: object) -> str | None:
    """Why a NEW password is refused, or None. ``identity``: the account's e-mail and name.

    Refused: under 8 characters, a well-known password, one or two repeated characters, a straight
    run ("12345678", "abcdefgh"), fewer than 10 digits and nothing else, or a known word, the
    e-mail name or a part of the person's name followed only by digits and symbols ("albayan2026").
    Passwords already stored are not touched; this is asked when one is set or changed.
    """
    text = unicodedata.normalize("NFKC", str(password or ""))
    folded = text.casefold().strip()
    if len(text) < 8:
        return "short"
    if folded in _COMMON_PASSWORDS:
        return "common"
    if len(set(folded)) <= 2:
        return "repeated"
    if folded.isdigit() and len(folded) < 10:
        return "digits"
    steps = {ord(b) - ord(a) for a, b in zip(folded, folded[1:])}
    if steps in ({1}, {-1}):
        return "sequence"
    words = set(_GUESSABLE_WORDS)
    for item in identity:
        own = unicodedata.normalize("NFKC", str(item or "")).casefold().strip()
        if own:
            words.add(own)
            words.add(own.split("@")[0])
            words.update(part for part in re.split(r"[\s@._+-]+", own) if len(part) >= 4)
    base = folded.rstrip("0123456789!@#$%^&*()._-+=?~ ")
    if len(base) >= 3 and base in words:
        return "guessable"
    return None


def require_strong_password(password: object, *identity: object) -> None:
    """HTTP 400 with one bilingual sentence for a password weak_password_reason refuses."""
    if weak_password_reason(password, *identity):
        raise HTTPException(status_code=400, detail=WEAK_PASSWORD_DETAIL)


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


# Real parts are new_id() values ("sess_<hex>", "tok_<hex>"). Anything else (a NUL from a quoted
# "\000" cookie, which PostgreSQL cannot bind: HTTP 500 on every signed-in route) is no session.
_SESSION_PART_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")


def parse_session_cookie_value(value: str) -> tuple[str, str] | None:
    if not value or "." not in value:
        return None
    session_id, token = value.split(".", 1)
    if not _SESSION_PART_RE.fullmatch(session_id) or not _SESSION_PART_RE.fullmatch(token):
        return None
    return session_id, token


def constant_time_equal(provided: str | None, expected: str | None) -> bool:
    """Constant-time equality for secrets that never raises on odd input.

    ``hmac.compare_digest`` refuses str operands containing non-ASCII
    characters (TypeError), so a garbage signature, verify token or origin
    header sent by an anonymous caller became an unhandled 500 instead of a
    clean refusal. Comparing the UTF-8 bytes keeps the timing guarantee for
    every input (a lone surrogate from JSON too: surrogatepass). An empty expected value never
    matches anything.
    """
    left = str(provided or "").encode("utf-8", "surrogatepass")
    right = str(expected or "").encode("utf-8", "surrogatepass")
    if not left or not right:
        return False
    return hmac.compare_digest(left, right)
