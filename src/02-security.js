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
  // Returns: { hash, salt, algo, iterations? }
  hashPassword: async (password, salt = null, options = {}) => {
    const algo = options.algo || 'pbkdf2-sha256';
    const pwd = String(password ?? '');
    const encoder = new TextEncoder();

    if (algo === 'sha256') {
      const saltHex = salt
        ? String(salt)
        : Security._bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      const data = encoder.encode(saltHex + pwd);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hash = Security._bytesToHex(new Uint8Array(hashBuffer));
      return { hash, salt: saltHex, algo: 'sha256' };
    }

    // PBKDF2-SHA256 (recommended)
    const iterations = Number.isFinite(options.iterations) ? options.iterations : 310000;
    const saltBytes = salt
      ? Security._hexToBytes(salt)
      : crypto.getRandomValues(new Uint8Array(16));
    const saltHex = typeof salt === 'string' ? String(salt) : Security._bytesToHex(saltBytes);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(pwd),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );

    const hash = Security._bytesToHex(new Uint8Array(bits));
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
    sessionStorage.setItem(SessionManager.SESSION_KEY, JSON.stringify(session));
    return session;
  },

  getSession: () => {
    try {
      const sessionStr = sessionStorage.getItem(SessionManager.SESSION_KEY);
      if (!sessionStr) return null;
      
      const session = JSON.parse(sessionStr);
      
      // Check if session is expired
      if (Date.now() > session.expiresAt) {
        SessionManager.destroySession();
        return null;
      }
      
      return session;
    } catch (e) {
      return null;
    }
  },

  refreshSession: () => {
    const session = SessionManager.getSession();
    if (session) {
      session.expiresAt = Date.now() + SessionManager.SESSION_DURATION;
      sessionStorage.setItem(SessionManager.SESSION_KEY, JSON.stringify(session));
    }
  },

  destroySession: () => {
    sessionStorage.removeItem(SessionManager.SESSION_KEY);
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
