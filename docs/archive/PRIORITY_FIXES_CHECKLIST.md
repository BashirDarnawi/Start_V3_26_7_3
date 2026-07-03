# 🚀 PRIORITY FIXES CHECKLIST

Quick reference for implementing the most important fixes from the audit report.

## ⚡ CRITICAL FIXES (Do These First!)

### 1. Fix CORS Configuration [HIGH - H2]
**File:** `server/main.py:1078-1085`

**Current (INSECURE):**
```python
allow_origins=CORS_ORIGINS if CORS_ORIGINS else ["*"],  # ⚠️ DANGEROUS!
```

**Fix:**
```python
# Get CORS origins from env (required in production)
CORS_ORIGINS = os.getenv("ALBAYAN_CORS_ORIGINS", "").strip()
if not CORS_ORIGINS:
    if not DEBUG_MODE:
        raise RuntimeError("❌ ALBAYAN_CORS_ORIGINS must be set in production")
    CORS_ORIGINS = "http://localhost:8000,http://127.0.0.1:8000"

CORS_ORIGINS_LIST = [origin.strip() for origin in CORS_ORIGINS.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS_LIST,  # ✅ Never use ["*"]
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["X-Request-ID"],
)
```

---

### 2. Remove Default Database Password [HIGH - H3]
**File:** `docker-compose.yml:13`

**Current:**
```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-changeme}  # ⚠️ Default password!
```

**Fix:**
```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Error: POSTGRES_PASSWORD must be set in .env file}
```

**Also Create:** `.env.example`
```bash
# Copy this to .env and set a strong password
POSTGRES_PASSWORD=your_strong_password_here_min_16_chars
ALBAYAN_COOKIE_SECURE=true
ALBAYAN_CORS_ORIGINS=https://yourdomain.com
```

---

### 3. Audit All innerHTML Usage [HIGH - H1]
**Files:** `script.js` (62 occurrences)

**Action:** Search for all `innerHTML` uses and verify escaping:

```bash
grep -n "innerHTML" script.js
```

**Fix Pattern:**
```javascript
// ❌ BAD: Direct interpolation
element.innerHTML = `<div>${userInput}</div>`;

// ✅ GOOD: Escaped
element.innerHTML = `<div>${Security.escapeHtml(userInput)}</div>`;

// ✅ BETTER: Use textContent when possible
element.textContent = userInput;
```

---

## 🔥 HIGH PRIORITY FIXES (This Week)

### 4. Add Password Change Rate Limiting [MEDIUM - M2]
**File:** `server/main.py:1547`

**Add after line 1549:**
```python
@app.post("/api/auth/password-change")
def change_password(body: ChangePasswordRequest, request: Request, user: dict[str, Any] = Depends(current_user)):
    require_same_origin(request)
    
    # ✅ ADD THIS: Rate limit password changes
    key = f"pwchange:{user['id']}"
    from .rate_limiter import check_rate_limit
    allowed, _ = check_rate_limit(key, max_attempts=5, window_ms=15*60*1000)
    if not allowed:
        raise HTTPException(status_code=429, detail="Too many password change attempts")
    
    # ... rest of function
```

---

### 5. Enhance CSRF Protection [MEDIUM - M3]
**File:** `server/main.py:424-430`

**Replace function:**
```python
def require_same_origin(request: Request):
    """Enhanced CSRF protection with origin + referer checks."""
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")
    host = request.headers.get("host")
    
    # ✅ Must have at least one of origin/referer
    if not origin and not referer:
        raise HTTPException(status_code=403, detail="Missing origin/referer header")
    
    # ✅ Check origin if present
    if origin and host:
        # Extract hostname from origin (handles ports)
        try:
            from urllib.parse import urlparse
            origin_host = urlparse(origin).netloc or origin.replace("https://", "").replace("http://", "").split("/")[0]
            if host != origin_host:
                raise HTTPException(status_code=403, detail="Origin mismatch")
        except Exception:
            raise HTTPException(status_code=403, detail="Invalid origin")
    
    # ✅ Check referer as fallback
    if not origin and referer and host:
        try:
            from urllib.parse import urlparse
            referer_host = urlparse(referer).netloc or referer.replace("https://", "").replace("http://", "").split("/")[0]
            if host not in referer_host:
                raise HTTPException(status_code=403, detail="Referer mismatch")
        except Exception:
            raise HTTPException(status_code=403, detail="Invalid referer")
```

---

### 6. Add Request Size Limits [MEDIUM - M4]
**File:** `server/main.py` (after line 942)

**Add middleware:**
```python
# ✅ ADD THIS: Request size limiting
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    """Prevent DoS via large payloads"""
    if request.method in ["POST", "PUT", "PATCH"]:
        content_length = request.headers.get("content-length")
        if content_length:
            size = int(content_length)
            max_size = 10 * 1024 * 1024  # 10 MB
            if size > max_size:
                return JSONResponse(
                    {"detail": f"Request too large (max {max_size/1024/1024:.0f} MB)"},
                    status_code=413
                )
    return await call_next(request)
```

---

### 7. Fix Session Fixation [MEDIUM - M5]
**File:** `server/main.py:1589-1596`

**Replace:**
```python
# ❌ OLD: Keep current session
if current_session_id:
    conn.execute(
        text("DELETE FROM sessions WHERE user_id = :user_id AND id != :session_id"),
        {"user_id": user_id, "session_id": str(current_session_id)},
    )
else:
    conn.execute(text("DELETE FROM sessions WHERE user_id = :user_id"), {"user_id": user_id})
```

**With:**
```python
# ✅ NEW: Delete ALL sessions (force re-login)
conn.execute(
    text("DELETE FROM sessions WHERE user_id = :user_id"),
    {"user_id": user_id}
)
```

**And change response:**
```python
audit(user_id, "password_change", "auth", user_id, "User changed password", {})

# ✅ Delete session cookie to force re-login
resp = JSONResponse(content={"ok": True, "requires_reauth": True})
resp.delete_cookie(COOKIE_NAME, path="/")
return resp
```

---

### 8. Add Missing Security Headers [MEDIUM - M10]
**File:** `server/main.py:1101-1107`

**Add to security_headers middleware:**
```python
resp.headers["X-Content-Type-Options"] = "nosniff"
resp.headers["X-Frame-Options"] = "SAMEORIGIN"
resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"

# ✅ ADD THESE:
resp.headers["X-Permitted-Cross-Domain-Policies"] = "none"
resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
```

---

## 📝 QUICK WINS (Easy Fixes)

### 9. Session Cleanup on Startup
**File:** `server/main.py` (after line 1059)

```python
@app.on_event("startup")
def _startup():
    _ensure_minified_script()
    init_db()
    _bootstrap_first_admin_if_empty()
    
    # ✅ ADD THIS: Clean expired sessions
    try:
        with db_conn() as conn:
            result = conn.execute(
                text("DELETE FROM sessions WHERE expires_at <= :now"),
                {"now": now_ms()}
            )
            if result.rowcount > 0:
                print(f"[albayan] Cleaned up {result.rowcount} expired sessions")
    except Exception as e:
        print(f"[albayan] Session cleanup failed: {e}")
```

---

### 10. Add Graceful Shutdown
**File:** `server/main.py` (after startup)

```python
@app.on_event("shutdown")
def _shutdown():
    """✅ Gracefully close database connections"""
    try:
        engine = get_engine()
        engine.dispose()
        print("[albayan] Database connections closed gracefully")
    except Exception as e:
        print(f"[albayan] Shutdown error: {e}")
```

---

### 11. Increase Session Token Entropy
**File:** `server/security.py:10-11`

```python
def new_id(prefix: str) -> str:
    # ✅ Changed from 12 to 16 (96 bits -> 128 bits)
    return f"{prefix}_{secrets.token_hex(16)}"
```

---

### 12. Add Image Size Validation (Frontend)
**File:** `script.js` (find image upload handlers)

**Add validation:**
```javascript
function validateImage(dataUrl) {
    // ✅ Check size (base64 is ~33% larger than binary)
    const sizeInBytes = (dataUrl.length * 3) / 4;
    const maxSize = 5 * 1024 * 1024;  // 5 MB
    
    if (sizeInBytes > maxSize) {
        throw new Error(`Image too large (${(sizeInBytes/1024/1024).toFixed(1)} MB). Maximum: 5 MB`);
    }
    
    // ✅ Check format
    if (!dataUrl.startsWith('data:image/')) {
        throw new Error('Invalid image format');
    }
    
    return true;
}
```

---

## 🧪 TESTING YOUR FIXES

### Test 1: CORS Fix
```bash
# Should FAIL (different origin)
curl -X POST http://localhost:8000/api/auth/login \
  -H "Origin: https://evil.com" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}' \
  --include

# Should WORK (same origin)
curl -X POST http://localhost:8000/api/auth/login \
  -H "Origin: http://localhost:8000" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}' \
  --include
```

### Test 2: Request Size Limit
```bash
# Should FAIL with 413
dd if=/dev/zero bs=1M count=15 | base64 > large_payload.txt
curl -X POST http://localhost:8000/api/collections/receipts \
  -H "Content-Type: application/json" \
  -d @large_payload.txt \
  --include
```

### Test 3: Password Change Rate Limit
```bash
# Make 6+ requests rapidly - should get 429 on 6th
for i in {1..7}; do
  curl -X POST http://localhost:8000/api/auth/password-change \
    -b "session_cookie" \
    -H "Content-Type: application/json" \
    -d '{"currentPassword":"wrong","newPassword":"newpass123"}' \
    --include
  sleep 1
done
```

---

## ✅ VERIFICATION CHECKLIST

After implementing fixes, verify:

- [ ] `.env` file created with strong password
- [ ] `docker-compose up` fails without `.env`
- [ ] CORS rejects requests from different origins
- [ ] Large request payloads (>10MB) rejected with 413
- [ ] Password change requires re-login
- [ ] All innerHTML uses are escaped
- [ ] Rate limiting works on password change
- [ ] CSRF protection checks origin AND referer
- [ ] Sessions cleaned on startup
- [ ] Security headers present in responses

---

## 🎯 COMPLETION ESTIMATE

- **Critical Fixes (1-3):** 2-4 hours
- **High Priority (4-8):** 4-6 hours
- **Quick Wins (9-12):** 1-2 hours

**Total:** ~8-12 hours of focused work

---

## 📚 ADDITIONAL RESOURCES

- Full audit report: `🔍_COMPREHENSIVE_AUDIT_REPORT.md`
- Security headers test: https://securityheaders.com
- OWASP guidelines: https://owasp.org/Top10/
- FastAPI security: https://fastapi.tiangolo.com/tutorial/security/


