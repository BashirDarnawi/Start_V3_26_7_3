// ==========================================
// SECURITY MODULE - XSS Protection, Sanitization, Hashing
// ==========================================

const RECORD_IDENTIFIER_FIELDS = new Set([
  'adId', 'customerId', 'creatorId', 'deliveryPersonId', 'driverId',
  'fromUserId', 'fundingReceiptId', 'linkedDeliveryReceiptId', 'linkedReceiptId',
  'orderId', 'pageId', 'paymentTxId', 'productId', 'receiptId', 'referenceId',
  'resourceId', 'serviceId', 'shipmentId', 'targetCustomerId', 'targetUserId',
  'toCustomerId', 'toReceiptId', 'toUserId', 'transactionId',
  'transferFromCustomerId', 'transferFromReceiptId', 'userId'
]);
const RECORD_IDENTIFIER_LIST_FIELDS = new Set(['adReceiptIds', 'customerIds', 'linkedCustomerIds', 'receiptIds']);

// ==========================================
// PURE-JS CRYPTO FALLBACK (insecure contexts)
// ==========================================
// crypto.subtle only exists in secure contexts (https:// or localhost). On a
// plain-HTTP LAN origin (e.g. a phone opening http://192.168.x.x:8000) it is
// undefined in both iOS Safari and Android Chrome, which used to make every
// local-mode password flow throw. These pure-JS SHA-256 / PBKDF2-HMAC-SHA256
// implementations produce byte-identical output to the Web Crypto API and are
// used only when crypto.subtle is unavailable.

// New hashes created on the pure-JS path use fewer iterations (still recorded
// in the stored `iterations` field, so they verify anywhere) because 310k
// PBKDF2 iterations in plain JS would block the UI for many seconds.
const _ALB_FALLBACK_PBKDF2_ITERATIONS = 60000;

// SHA-256 round constants (FIPS 180-4)
const _ALB_SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

// Pure-JS SHA-256. Takes a Uint8Array, returns a 32-byte Uint8Array digest
// identical to crypto.subtle.digest('SHA-256', bytes).
function _albFallbackSha256(bytes) {
  const len = bytes.length;
  // Pad to: message + 0x80 + zeros + 64-bit big-endian bit length, multiple of 64 bytes.
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000)); // high 32 bits of len*8
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);             // low 32 bits of len*8

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
      const s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + _ALB_SHA256_K[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, h[i]);
  return out;
}

// Pure-JS PBKDF2-HMAC-SHA256. Takes Uint8Arrays, returns a byteLen-byte
// Uint8Array identical to crypto.subtle.deriveBits({ name: 'PBKDF2', ... }).
function _albFallbackPbkdf2Sha256(passwordBytes, saltBytes, iterations, byteLen) {
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error('Invalid PBKDF2 iterations');

  // HMAC key: keys longer than the 64-byte SHA-256 block are hashed first.
  let key = passwordBytes;
  if (key.length > 64) key = _albFallbackSha256(key);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const k = i < key.length ? key[i] : 0;
    ipad[i] = k ^ 0x36;
    opad[i] = k ^ 0x5c;
  }
  const hmac = (msg) => {
    const innerBuf = new Uint8Array(64 + msg.length);
    innerBuf.set(ipad);
    innerBuf.set(msg, 64);
    const inner = _albFallbackSha256(innerBuf);
    const outerBuf = new Uint8Array(96);
    outerBuf.set(opad);
    outerBuf.set(inner, 64);
    return _albFallbackSha256(outerBuf);
  };

  const out = new Uint8Array(byteLen);
  const blocks = Math.ceil(byteLen / 32);
  for (let block = 1; block <= blocks; block++) {
    // U1 = HMAC(password, salt || INT_32_BE(block))
    const msg = new Uint8Array(saltBytes.length + 4);
    msg.set(saltBytes);
    msg[saltBytes.length] = (block >>> 24) & 0xff;
    msg[saltBytes.length + 1] = (block >>> 16) & 0xff;
    msg[saltBytes.length + 2] = (block >>> 8) & 0xff;
    msg[saltBytes.length + 3] = block & 0xff;
    let u = hmac(msg);
    const t = u.slice();
    for (let iter = 1; iter < iterations; iter++) {
      u = hmac(u);
      for (let i = 0; i < 32; i++) t[i] ^= u[i];
    }
    const offset = (block - 1) * 32;
    out.set(t.subarray(0, Math.min(32, byteLen - offset)), offset);
  }
  return out;
}

const Security = {
  // XSS Protection - Escape HTML entities
  escapeHtml: (str) => {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    // textContent -> innerHTML escapes <, >, & (but NOT quotes). We also escape quotes for attribute safety.
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
  
  // Unescape HTML (for display in input fields)
  // XSS-SAFE: Uses textContent extraction (no script execution)
  unescapeHtml: (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.innerHTML = str;  // Safe: immediately extract as text
    return div.textContent || div.innerText || '';
  },

  // Return a URL safe to put in an href/src, or '#' for an unsafe scheme.
  // escapeHtml alone does NOT neutralize javascript:/data:/vbscript: URLs, so
  // any user-supplied link (e.g. a customer profile link stored raw) must pass
  // through here before rendering. Allows http/https/mailto/tel and
  // relative / protocol-relative URLs.
  safeUrl: (url) => {
    const s = String(url == null ? '' : url).trim();
    if (!s) return '#';
    // Collapse control chars / whitespace that could hide a scheme like
    // "java\tscript:alert(1)".
    const cleaned = s.replace(/[\u0000-\u0020\u007f]+/g, '');
    if (/^(?:https?:|mailto:|tel:)/i.test(cleaned)) return s;   // known-safe scheme
    if (/^[a-z][a-z0-9+.\-]*:/i.test(cleaned)) return '#';       // any other explicit scheme -> block
    return s;                                                    // no scheme (relative/anchor) -> ok
  },

  // Sanitize input - remove dangerous characters and patterns
  sanitizeInput: (input, options = {}) => {
    if (input === null || input === undefined) return '';
    let str = String(input);
    
    // Remove null bytes
    str = str.replace(/\0/g, '');
    
    // Remove script tags and event handlers if not allowed
    if (!options.allowHtml) {
      str = str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      str = str.replace(/on\w+\s*=/gi, '');
      str = str.replace(/javascript:/gi, '');
      if (!options.allowDataUrl) {
        str = str.replace(/data:/gi, '');
      } else {
        // Only allow safe image data URLs; strip any other data: usage
        const trimmed = str.trim();
        if (/^data:/i.test(trimmed)) {
          const isSafeImageDataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(trimmed);
          if (!isSafeImageDataUrl) {
            str = '';
          }
        } else {
          str = str.replace(/data:/gi, '');
        }
      }
      str = str.replace(/vbscript:/gi, '');
      // Remove any remaining angle brackets to prevent HTML/attribute injection
      str = str.replace(/[<>]/g, '');
    }
    
    // Trim whitespace
    str = str.trim();
    
    // Limit length if specified
    if (options.maxLength && str.length > options.maxLength) {
      str = str.substring(0, options.maxLength);
    }
    
    return str;
  },

  // Sanitize object recursively
  sanitizeObject: (obj, depth = 0) => {
    if (depth > 10) return obj; // Prevent infinite recursion
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return Security.sanitizeInput(obj);
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => {
        if (typeof item === 'string' && item.trim().toLowerCase().startsWith('data:image/')) {
          return Security.sanitizeInput(item, { allowDataUrl: true });
        }
        return Security.sanitizeObject(item, depth + 1);
      });
    }
    // Prevent prototype pollution by using null-prototype objects and blocking dangerous keys
    const sanitized = Object.create(null);
    const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
    for (const key of Object.keys(obj)) {
      if (blockedKeys.has(key)) continue;
      const sanitizedKey = Security.sanitizeInput(key, { maxLength: 100 });
      if (!sanitizedKey || blockedKeys.has(sanitizedKey)) continue;
      const value = obj[key];
      const looksLikeImageKey = /photo|photos|image|images|screenshot/i.test(String(key));
      if (typeof value === 'string') {
        sanitized[sanitizedKey] = looksLikeImageKey
          ? Security.sanitizeInput(value, { allowDataUrl: true })
          : Security.sanitizeInput(value);
      } else if (Array.isArray(value) && looksLikeImageKey) {
        sanitized[sanitizedKey] = value.map(v => {
          if (typeof v === 'string') return Security.sanitizeInput(v, { allowDataUrl: true });
          return Security.sanitizeObject(v, depth + 1);
        });
      } else {
        sanitized[sanitizedKey] = Security.sanitizeObject(value, depth + 1);
      }
    }
    return sanitized;
  },

  // Internal: bytes <-> hex helpers
  _bytesToHex: (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
  _hexToBytes: (hex) => {
    const clean = String(hex || '').trim();
    if (!clean || clean.length % 2 !== 0) throw new Error('Invalid hex salt');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) throw new Error('Invalid hex salt');
      bytes[i] = byte;
    }
    return bytes;
  },

  // Password hashing using Web Crypto API (PBKDF2 by default; legacy SHA-256 supported)
  // Falls back to pure-JS SHA-256/PBKDF2 when crypto.subtle is unavailable
  // (insecure http:// origins) — output is byte-identical either way.
  // Returns: { hash, salt, algo, iterations? }
  hashPassword: async (password, salt = null, options = {}) => {
    const algo = options.algo || 'pbkdf2-sha256';
    const pwd = String(password ?? '');
    const encoder = new TextEncoder();
    // crypto.getRandomValues still works in insecure contexts; only subtle.* is gone.
    const subtle = (globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto.subtle : null;

    if (algo === 'sha256') {
      const saltHex = salt
        ? String(salt)
        : Security._bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      const data = encoder.encode(saltHex + pwd);
      const digest = subtle
        ? new Uint8Array(await subtle.digest('SHA-256', data))
        : _albFallbackSha256(data);
      const hash = Security._bytesToHex(digest);
      return { hash, salt: saltHex, algo: 'sha256' };
    }

    // PBKDF2-SHA256 (recommended). New hashes made on the pure-JS path use a
    // lower default iteration count (recorded in `iterations`, which every
    // call site round-trips through user.passwordIterations, so the hash
    // verifies everywhere — including later under HTTPS with native crypto).
    // Verification always passes the stored count explicitly, so it is never
    // affected by this default.
    const iterations = Number.isFinite(options.iterations)
      ? options.iterations
      : (subtle ? 310000 : _ALB_FALLBACK_PBKDF2_ITERATIONS);
    const saltBytes = salt
      ? Security._hexToBytes(salt)
      : crypto.getRandomValues(new Uint8Array(16));
    const saltHex = typeof salt === 'string' ? String(salt) : Security._bytesToHex(saltBytes);

    let derived;
    if (subtle) {
      const keyMaterial = await subtle.importKey(
        'raw',
        encoder.encode(pwd),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );

      const bits = await subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations,
          hash: 'SHA-256'
        },
        keyMaterial,
        256
      );
      derived = new Uint8Array(bits);
    } else {
      derived = _albFallbackPbkdf2Sha256(encoder.encode(pwd), saltBytes, iterations, 32);
    }

    const hash = Security._bytesToHex(derived);
    return { hash, salt: saltHex, algo: 'pbkdf2-sha256', iterations };
  },

  // Verify password against stored hash (supports legacy + PBKDF2)
  verifyPassword: async (password, storedHash, salt, algo = 'sha256', iterations = null) => {
    // Backwards compatibility: some backups may store iterations as a numeric string.
    // Example: "310000" instead of 310000. Treat digit-only strings as numbers.
    let iters = iterations;
    if (typeof iters === 'string') {
      const trimmed = iters.trim();
      if (/^[0-9]{1,10}$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) iters = n;
      }
    }
    const opts = algo === 'pbkdf2-sha256'
      ? { algo: 'pbkdf2-sha256', iterations: Number.isFinite(iters) ? iters : 310000 }
      : { algo: 'sha256' };
    const { hash } = await Security.hashPassword(password, salt, opts);
    return hash === storedHash;
  },

  // Generate secure random ID
  generateSecureId: (prefix = 'id') => {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    const random = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}_${Date.now()}_${random.substring(0, 12)}`;
  },

  // Record identifiers are used in URLs, data-* attributes and (for legacy
  // screens) inline handlers. Keep them deliberately boring so an imported or
  // server-provided id can never break out of one of those contexts. This also
  // matches the backend's 80-character id limit.
  isValidRecordId: (value) => {
    const id = String(value == null ? '' : value).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id);
  },

  // Validate record ids and relationship ids without rewriting them. Rewriting
  // would silently break links between customers, receipts, ads and users, so
  // callers must reject the whole import/server payload when this fails.
  validateRecordIdentifiers: (value, path = 'record', depth = 0, validateOwnId = depth === 0) => {
    if (depth > 12 || value === null || value === undefined) return { valid: true };
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        // A top-level array is a collection of records, so each direct child's
        // `id` is a record id. Nested arrays are data inside a record (for
        // example passkeys[].id is an opaque WebAuthn credential and can be
        // much longer than 80 characters), so their generic `id` fields must
        // not be treated as entity identifiers.
        const childOwnId = depth === 0 && validateOwnId;
        const result = Security.validateRecordIdentifiers(value[i], `${path}[${i}]`, depth + 1, childOwnId);
        if (!result.valid) return result;
      }
      return { valid: true };
    }
    if (typeof value !== 'object') return { valid: true };

    for (const [key, child] of Object.entries(value)) {
      const isSingleId = RECORD_IDENTIFIER_FIELDS.has(key) || (key === 'id' && validateOwnId);
      const isIdList = RECORD_IDENTIFIER_LIST_FIELDS.has(key);
      if (isSingleId) {
        const blank = child === null || child === undefined || String(child).trim() === '';
        if (blank && key === 'id') {
          return { valid: false, error: `Missing identifier at ${path}.${key}` };
        }
        if (!blank && (typeof child !== 'string' || !Security.isValidRecordId(child))) {
          return { valid: false, error: `Unsafe identifier at ${path}.${key}` };
        }
      } else if (isIdList && child !== null && child !== undefined) {
        if (!Array.isArray(child)) return { valid: false, error: `Invalid identifier list at ${path}.${key}` };
        for (let i = 0; i < child.length; i++) {
          if (typeof child[i] !== 'string' || !Security.isValidRecordId(child[i])) {
            return { valid: false, error: `Unsafe identifier at ${path}.${key}[${i}]` };
          }
        }
      }

      if (child && typeof child === 'object') {
        const result = Security.validateRecordIdentifiers(child, `${path}.${key}`, depth + 1, false);
        if (!result.valid) return result;
      }
    }
    return { valid: true };
  },

  // Validate email format
  isValidEmail: (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  // Validate phone format (basic)
  isValidPhone: (phone) => {
    const cleaned = phone.replace(/[\s\-\(\)]/g, '');
    return /^\+?[\d]{7,15}$/.test(cleaned);
  },

  // Rate limiting for login attempts
  loginAttempts: new Map(),
  
  checkRateLimit: (identifier, maxAttempts = LIMIT_CONSTANTS.MAX_RATE_LIMIT_ATTEMPTS, windowMs = TIME_CONSTANTS.RATE_LIMIT_WINDOW_MINUTES * TIME_CONSTANTS.MILLISECONDS_PER_MINUTE) => {
    const now = Date.now();
    const attempts = Security.loginAttempts.get(identifier) || [];
    
    // Filter out old attempts
    const recentAttempts = attempts.filter(time => now - time < windowMs);
    
    if (recentAttempts.length >= maxAttempts) {
      const oldestAttempt = Math.min(...recentAttempts);
      const waitTime = Math.ceil((windowMs - (now - oldestAttempt)) / 1000 / 60);
      return { allowed: false, waitMinutes: waitTime };
    }
    
    return { allowed: true };
  },

  recordLoginAttempt: (identifier) => {
    const now = Date.now();
    const windowMs = TIME_CONSTANTS.RATE_LIMIT_WINDOW_MINUTES * TIME_CONSTANTS.MILLISECONDS_PER_MINUTE;
    const attempts = Security.loginAttempts.get(identifier) || [];
    // Filter out old attempts before adding new one (prevents unbounded growth)
    const recentAttempts = attempts.filter(time => now - time < windowMs);
    recentAttempts.push(now);
    Security.loginAttempts.set(identifier, recentAttempts);

    // Periodically clean up old entries from the map (every 100 attempts)
    if (Math.random() < 0.01) {
      Security._cleanupOldAttempts(windowMs);
    }
  },

  clearLoginAttempts: (identifier) => {
    Security.loginAttempts.delete(identifier);
  },

  // Clean up old entries from the login attempts map to prevent memory leaks
  _cleanupOldAttempts: (windowMs) => {
    const now = Date.now();
    for (const [identifier, attempts] of Security.loginAttempts.entries()) {
      const recentAttempts = attempts.filter(time => now - time < windowMs);
      if (recentAttempts.length === 0) {
        Security.loginAttempts.delete(identifier);
      } else {
        Security.loginAttempts.set(identifier, recentAttempts);
      }
    }
  },

  // Safe HTML builder - prevents XSS by escaping all dynamic content
  safeHTML: (strings, ...values) => {
    return strings.reduce((result, str, i) => {
      const value = values[i - 1];
      const escapedValue = value !== undefined ? Security.escapeHtml(String(value)) : '';
      return result + escapedValue + str;
    });
  },

  // Create safe element with escaped text content
  createSafeElement: (tag, textContent, attributes = {}) => {
    const element = document.createElement(tag);
    element.textContent = textContent; // textContent is automatically escaped
    for (const [key, value] of Object.entries(attributes)) {
      // Only allow safe attributes
      const safeAttrs = ['id', 'class', 'style', 'type', 'name', 'value', 'placeholder', 'disabled', 'readonly', 'data-id'];
      if (safeAttrs.includes(key) || key.startsWith('data-')) {
        element.setAttribute(key, Security.sanitizeInput(value));
      }
    }
    return element;
  },

  // Validate that data hasn't been tampered with
  validateDataIntegrity: (data, expectedChecksum) => {
    const currentChecksum = DataIntegrity.calculateChecksum(data);
    return currentChecksum === expectedChecksum;
  }
};

// ==========================================
// DEBUG MODE: Conditional debug telemetry (disabled in production)
// ==========================================
// Debug mode is controlled by the server returning a debug flag, or by URL parameter ?debug=1
// In production (ALBAYAN_DEBUG_MODE=false), debug endpoints return 404 and this code is a no-op.

const ALBAYAN_DEBUG_MODE = (() => {
  try {
    // Check URL param for explicit debug mode
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === '1') return true;
    // Default: debug mode is off in production
    return false;
  } catch (_) {
    return false;
  }
})();

// No-op debug emit function (used throughout codebase)
window.__albayanDebugEmit = ALBAYAN_DEBUG_MODE 
  ? (hypothesisId, location, message, data) => {
      try {
        const payload = {
          sessionId: 'debug-session',
          runId: 'audit-pre',
          hypothesisId: String(hypothesisId || '').slice(0, 32),
          location: String(location || '').slice(0, 180),
          message: String(message || '').slice(0, 240),
          data: (data && typeof data === 'object') ? data : {},
          timestamp: Date.now(),
        };
        fetch('/api/_debug/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch (_) {}
    }
  : () => {}; // No-op in production

// ==========================================
// DATA ISOLATION - Prevent cross-feature data corruption
// ==========================================

const DataIsolation = {
  // Wrap data operations in isolated context
  isolatedOperation: (collectionName, operation) => {
    try {
      // Create a copy of the collection for isolated operation
      const collection = state[collectionName];
      if (!Array.isArray(collection)) {
        throw new Error(`Invalid collection: ${collectionName}`);
      }
      
      // Perform operation on copy first
      const result = operation([...collection]);
      
      // Validate result before applying
      if (result !== undefined && Array.isArray(result)) {
        // Verify no invalid data was introduced
        for (const item of result) {
          if (typeof item !== 'object' || item === null) {
            throw new Error('Invalid item in result');
          }
        }
        return result;
      }
      return collection;
    } catch (error) {
      console.error(`Isolated operation failed for ${collectionName}:`, error);
      addSecurityLog('data_isolation_error', `${collectionName}: ${error.message}`);
      throw error;
    }
  },

  // Safe record access with bounds checking
  safeGetRecord: (collection, id) => {
    if (!Array.isArray(collection)) return null;
    const record = collection.find(item => item && item.id === id);
    return record ? { ...record } : null; // Return copy, not reference
  },

  // Safe record update with validation
  safeUpdateRecord: (collectionName, id, updates) => {
    const collection = state[collectionName];
    if (!Array.isArray(collection)) return false;
    
    const index = collection.findIndex(item => item && item.id === id);
    if (index === -1) return false;
    
    // Sanitize updates
    const sanitizedUpdates = Security.sanitizeObject(updates);
    
    // Preserve critical fields
    const protectedFields = ['id', '_created', 'createdBy'];
    for (const field of protectedFields) {
      if (sanitizedUpdates[field] !== undefined && 
          collection[index][field] !== undefined &&
          sanitizedUpdates[field] !== collection[index][field]) {
        delete sanitizedUpdates[field]; // Don't allow changing protected fields
      }
    }
    
    collection[index] = { 
      ...collection[index], 
      ...sanitizedUpdates, 
      _lastModified: Date.now() 
    };
    
    return true;
  },

  // Validate collection integrity
  validateCollection: (collectionName) => {
    const collection = state[collectionName];
    if (!Array.isArray(collection)) return { valid: false, errors: ['Not an array'] };
    
    const errors = [];
    const ids = new Set();
    
    collection.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`Invalid item at index ${index}`);
        return;
      }
      
      if (!item.id) {
        errors.push(`Missing ID at index ${index}`);
      } else if (ids.has(item.id)) {
        errors.push(`Duplicate ID: ${item.id}`);
      } else {
        ids.add(item.id);
      }
    });
    
    return { valid: errors.length === 0, errors };
  }
};

// ==========================================
// SESSION MANAGEMENT - Secure session handling
// ==========================================

// iOS Safari with "Block All Cookies" (and Chrome/Android with cookies
// blocked for the site) makes ANY window.sessionStorage access throw a
// SecurityError. Local-mode login calls createSession AFTER the password is
// already verified, so an unguarded throw made login impossible with a
// misleading generic error. Fall back to a page-lifetime in-memory session.
let _memorySession = null;

const SessionManager = {
  SESSION_DURATION: 8 * 60 * 60 * 1000, // 8 hours
  SESSION_KEY: 'albayan_session',

  createSession: (userId) => {
    const session = {
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + SessionManager.SESSION_DURATION,
      token: Security.generateSecureId('session')
    };
    try {
      sessionStorage.setItem(SessionManager.SESSION_KEY, JSON.stringify(session));
    } catch (_) {
      _memorySession = session;
    }
    return session;
  },

  getSession: () => {
    try {
      const sessionStr = sessionStorage.getItem(SessionManager.SESSION_KEY);
      const session = sessionStr ? JSON.parse(sessionStr) : _memorySession;
      if (!session) return null;

      // Check if session is expired
      if (Date.now() > session.expiresAt) {
        SessionManager.destroySession();
        return null;
      }

      return session;
    } catch (e) {
      // Storage blocked (throw-on-read): honor the in-memory fallback.
      return _memorySession && Date.now() <= _memorySession.expiresAt ? _memorySession : null;
    }
  },

  refreshSession: () => {
    const session = SessionManager.getSession();
    if (session) {
      session.expiresAt = Date.now() + SessionManager.SESSION_DURATION;
      try {
        sessionStorage.setItem(SessionManager.SESSION_KEY, JSON.stringify(session));
      } catch (_) {
        _memorySession = session;
      }
    }
  },

  destroySession: () => {
    _memorySession = null;
    try { sessionStorage.removeItem(SessionManager.SESSION_KEY); } catch (_) {}
  },

  isAuthenticated: () => {
    return SessionManager.getSession() !== null;
  }
};

// ==========================================
// DATA INTEGRITY - Checksum and validation
// ==========================================

const DataIntegrity = {
  // Calculate simple checksum for data integrity
  calculateChecksum: (data) => {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  },

  // Validate data structure
  validateDataStructure: (data, schema) => {
    const errors = [];
    
    for (const [key, rules] of Object.entries(schema)) {
      const value = data[key];
      
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${key} is required`);
        continue;
      }
      
      if (value !== undefined && value !== null) {
        if (rules.type === 'string' && typeof value !== 'string') {
          errors.push(`${key} must be a string`);
        }
        if (rules.type === 'number' && typeof value !== 'number') {
          errors.push(`${key} must be a number`);
        }
        if (rules.type === 'array' && !Array.isArray(value)) {
          errors.push(`${key} must be an array`);
        }
        if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
          errors.push(`${key} exceeds maximum length of ${rules.maxLength}`);
        }
        if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
          errors.push(`${key} must be at least ${rules.min}`);
        }
        if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
          errors.push(`${key} must be at most ${rules.max}`);
        }
      }
    }
    
    return { valid: errors.length === 0, errors };
  },

  // Freeze object to prevent modification
  freezeData: (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj;
    Object.freeze(obj);
    Object.keys(obj).forEach(key => {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        DataIntegrity.freezeData(obj[key]);
      }
    });
    return obj;
  }
};

// ==========================================
// NUMBER PARSING UTILITIES - Strict validation
// ==========================================

/**
 * Parse a value to a number with strict validation.
 * Unlike parseFloat("123abc") which returns 123, this returns NaN for invalid input.
 * 
 * @param {any} value - Value to parse
 * @param {object} options - Optional configuration
 * @param {number} options.min - Minimum allowed value (returns NaN if below)
 * @param {number} options.max - Maximum allowed value (returns NaN if above)
 * @param {number} options.defaultValue - Value to return if parsing fails (default: NaN)
 * @returns {number} Parsed number or defaultValue if invalid
 */
function strictParseNumber(value, options = {}) {
  const { min, max, defaultValue = NaN } = options;
  
  // Handle null/undefined
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  
  // If already a number
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return defaultValue;
    if (min !== undefined && value < min) return defaultValue;
    if (max !== undefined && value > max) return defaultValue;
    return value;
  }
  
  // Strict string parsing - the entire string must be a valid number
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return defaultValue;
    
    // Check if string is a valid number format (including scientific notation)
    // This is stricter than parseFloat - it rejects "123abc"
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      return defaultValue;
    }
    
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return defaultValue;
    if (min !== undefined && num < min) return defaultValue;
    if (max !== undefined && num > max) return defaultValue;
    return num;
  }
  
  return defaultValue;
}
