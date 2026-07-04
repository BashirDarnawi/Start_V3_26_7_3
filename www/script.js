// ==========================================
// ALBAYAN MANAGER - VANILLA JS COMPLETE
// Full-featured conversion from React
// SECURITY ENHANCED VERSION
// ==========================================

// ==========================================
// ALBAYAN PLATFORM (FUTURE PLAN + RULES)
// ==========================================
// This codebase is intended to evolve into a **multi-service platform** (web now, mobile later).
// New services must plug in cleanly without breaking existing ones (especially Albayan Manager).
//
// Core platform primitives (do NOT break these):
// - Services catalog: `SERVICES` + `SMART_SYSTEMS_CHILDREN` (config-driven, stable IDs)
// - Wallet: `walletTransactions` is an **immutable ledger** (balance is computed, not stored)
// - Subscriptions: `serviceSubscriptions` is the source of truth for service access
// - Server mode (FastAPI/Postgres): server is authoritative for multi-user internet usage
//
// Non‑negotiable rules for future edits (human + AI):
// 1) NEVER store wallet balance as a mutable field; only append ledger transactions.
// 2) NEVER allow editing/deleting `walletTransactions` or subscription history (use reversals/cancel records).
// 3) NEVER change a service `id` after launch (it becomes part of URLs, mobile deep links, subscriptions).
// 4) Any new “large” collection must be persisted in IndexedDB: add to `state` + `PERSISTED_COLLECTIONS`.
// 5) Keep services isolated; reuse platform modules instead of copy/paste logic across services.
// 6) No plaintext secrets (passwords, tokens, recovery keys). Keep audit logs redacted.
//
// Docs to read before major changes:
// - `PLATFORM_FOUNDATION.md` (architecture + portability)
// - `CONTRIBUTING.md` (how to extend safely)
// - `MONEY_PLATFORM_ROADMAP.md` (payments/POS/cards roadmap + money safety rules)
//
// ==========================================
// PLATFORM DETECTION MODULE
// ==========================================
// Detects platform (web, iOS, Android, HarmonyOS) and capabilities

const Platform = {
  // Cache detection results for performance
  _cache: null,
  
  // Detect platform once and cache results
  detect: function() {
    if (this._cache) return this._cache;
    
    const ua = navigator.userAgent || '';
    const uaLower = ua.toLowerCase();
    
    // Check for Capacitor (mobile app)
    const isCapacitor = typeof window.Capacitor !== 'undefined' ||
                        document.URL.startsWith('capacitor://') ||
                        document.URL.startsWith('ionic://');
    
    // Detect specific platform
    let platform = 'web';
    if (isCapacitor) {
      if (/iphone|ipad|ipod/i.test(ua)) {
        platform = 'ios';
      } else if (/android/i.test(ua)) {
        platform = 'android';
      } else if (/harmonyos/i.test(ua) || /huawei/i.test(ua)) {
        platform = 'harmony';
      } else {
        platform = 'capacitor-unknown';
      }
    }
    
    // Detect touch capability
    const isTouch = ('ontouchstart' in window) ||
                    (navigator.maxTouchPoints > 0) ||
                    (navigator.msMaxTouchPoints > 0);
    
    // Detect if hover is supported (CSS media query approach)
    const supportsHover = window.matchMedia('(hover: hover)').matches;
    
    // Detect mobile browser (not Capacitor but mobile browser)
    const isMobileBrowser = !isCapacitor && (
      /iphone|ipad|ipod|android|blackberry|windows phone/i.test(ua) ||
      (isTouch && window.innerWidth < 768)
    );
    
    this._cache = {
      isCapacitor,
      platform,
      isTouch,
      supportsHover,
      isMobileBrowser,
      isMobile: isCapacitor || isMobileBrowser,
      isWeb: !isCapacitor,
      isIOS: platform === 'ios',
      isAndroid: platform === 'android',
      isHarmony: platform === 'harmony',
      userAgent: ua
    };
    
    // Log platform detection for debugging
    console.log('[Platform] Detected:', this._cache);
    
    return this._cache;
  },
  
  // Convenience getters
  get isCapacitor() { return this.detect().isCapacitor; },
  get platform() { return this.detect().platform; },
  get isTouch() { return this.detect().isTouch; },
  get supportsHover() { return this.detect().supportsHover; },
  get isMobile() { return this.detect().isMobile; },
  get isMobileBrowser() { return this.detect().isMobileBrowser; },
  get isWeb() { return this.detect().isWeb; },
  get isIOS() { return this.detect().isIOS; },
  get isAndroid() { return this.detect().isAndroid; },
  get isHarmony() { return this.detect().isHarmony; },
  
  // Apply platform-specific CSS classes to document
  applyBodyClasses: function() {
    const p = this.detect();
    const body = document.body;
    if (!body) return;
    
    // Remove old classes
    body.classList.remove('platform-web', 'platform-ios', 'platform-android', 'platform-harmony', 'platform-capacitor', 'is-touch', 'no-hover', 'is-mobile');
    
    // Add new classes
    if (p.isCapacitor) body.classList.add('platform-capacitor');
    body.classList.add(`platform-${p.platform}`);
    if (p.isTouch) body.classList.add('is-touch');
    if (!p.supportsHover) body.classList.add('no-hover');
    if (p.isMobile) body.classList.add('is-mobile');
  }
};

// Apply platform classes immediately when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Platform.applyBodyClasses());
} else {
  Platform.applyBodyClasses();
}

// ==========================================
// SECURITY MODULE - XSS Protection, Sanitization, Hashing
// ==========================================

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

/**
 * Parse a value to an integer with strict validation.
 * 
 * @param {any} value - Value to parse  
 * @param {object} options - Optional configuration
 * @param {number} options.min - Minimum allowed value
 * @param {number} options.max - Maximum allowed value
 * @param {number} options.defaultValue - Value to return if parsing fails (default: NaN)
 * @returns {number} Parsed integer or defaultValue if invalid
 */
function strictParseInt(value, options = {}) {
  const num = strictParseNumber(value, options);
  if (!Number.isFinite(num)) return options.defaultValue ?? NaN;
  return Math.trunc(num);
}

// ==========================================
// LARGE DATA STORAGE - IndexedDB for big datasets
// ==========================================

const DB_NAME = 'AlbayanDB';
/**
 * IndexedDB Schema Version History
 * ---------------------------------
 * v1: Initial schema (auditLogs, appData stores)
 * v2: Added backups store for auto-backup feature
 * 
 * IMPORTANT: Increment DB_VERSION when:
 * - Adding new object stores
 * - Adding new indexes
 * - Changing key paths
 * 
 * The onupgradeneeded handler MUST handle upgrading from any previous version.
 */
const DB_VERSION = 2;
const LOG_STORE_NAME = 'auditLogs';
const DATA_STORE_NAME = 'appData';
const BACKUP_STORE_NAME = 'backups';

// Storage quotas and limits
const STORAGE_CONFIG = {
  MAX_RECORDS_PER_COLLECTION: 100000, // 100k records per type
  MAX_LOCALSTORAGE_MB: 4,
  BACKUP_RETENTION_DAYS: 30,
  AUTO_BACKUP_INTERVAL: 24 * 60 * 60 * 1000, // Daily
  CHUNK_SIZE: 1000 // Records per chunk for large operations
};

// BEST PRACTICE: Extract magic numbers to named constants for better maintainability
const TIME_CONSTANTS = {
  MILLISECONDS_PER_SECOND: 1000,
  SECONDS_PER_MINUTE: 60,
  MINUTES_PER_HOUR: 60,
  HOURS_PER_DAY: 24,
  MILLISECONDS_PER_MINUTE: 60 * 1000,
  MILLISECONDS_PER_HOUR: 60 * 60 * 1000,
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
  SESSION_DURATION_HOURS: 8,
  RATE_LIMIT_WINDOW_MINUTES: 15,
  API_TIMEOUT_MS: 15000,
  API_TIMEOUT_LONG_MS: 20000,
  WEBAUTHN_TIMEOUT_MS: 60000
};

const LIMIT_CONSTANTS = {
  MAX_SECURITY_LOGS: 1000,
  MAX_RATE_LIMIT_ATTEMPTS: 5,
  MAX_PAYMENT_METHODS: 50, // Reasonable limit
  MAX_PHONE_NUMBERS: 10, // Per customer
  MAX_PROFILE_LINKS: 10 // Per customer
};

let db = null;

/**
 * Initialize IndexedDB for large data storage and caching.
 * Creates necessary object stores and handles version upgrades.
 * Falls back gracefully if IndexedDB is not supported.
 *
 * @returns {Promise<IDBDatabase|null>} Promise resolving to database instance or null if unsupported
 */
function initIndexedDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported, falling back to localStorage');
      resolve(null);
      return;
    }
    
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      resolve(null);
    };
    
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      
      // Create audit logs store with indexes for efficient querying
      if (!database.objectStoreNames.contains(LOG_STORE_NAME)) {
        const logStore = database.createObjectStore(LOG_STORE_NAME, { keyPath: 'id' });
        logStore.createIndex('date', 'date', { unique: false });
        logStore.createIndex('userId', 'userId', { unique: false });
        logStore.createIndex('action', 'action', { unique: false });
        logStore.createIndex('category', 'category', { unique: false });
        logStore.createIndex('severity', 'severity', { unique: false });
        logStore.createIndex('resourceType', 'resourceType', { unique: false });
      }
      
      // Create main data store for large datasets
      if (!database.objectStoreNames.contains(DATA_STORE_NAME)) {
        const dataStore = database.createObjectStore(DATA_STORE_NAME, { keyPath: 'key' });
        dataStore.createIndex('type', 'type', { unique: false });
        dataStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      
      // Create backup store
      if (!database.objectStoreNames.contains(BACKUP_STORE_NAME)) {
        const backupStore = database.createObjectStore(BACKUP_STORE_NAME, { keyPath: 'id' });
        backupStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });
}

// ==========================================
// LARGE DATA OPERATIONS - Store big datasets in IndexedDB
// ==========================================

// BEST PRACTICE: Transaction queue to prevent race conditions in IndexedDB
let idbTransactionQueue = [];
let idbTransactionInProgress = false;

async function processIdbQueue() {
  if (idbTransactionInProgress || idbTransactionQueue.length === 0) return;
  
  idbTransactionInProgress = true;
  while (idbTransactionQueue.length > 0) {
    const task = idbTransactionQueue.shift();
    try {
      await task();
    } catch (error) {
      console.error('IndexedDB queue task error:', error);
    }
  }
  idbTransactionInProgress = false;
}

/**
 * Retrieve a value from IndexedDB by key.
 *
 * @param {string} storeName - Name of the object store
 * @param {string} key - Key to retrieve
 * @returns {Promise<any>} Promise resolving to the stored value or null if not found
 */
function idbGet(storeName, key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Store a value in IndexedDB.
 * BEST PRACTICE: Queued to prevent race conditions from concurrent writes.
 *
 * @param {string} storeName - Name of the object store
 * @param {any} value - Value to store (must have an 'id' property)
 * @returns {Promise<void>} Promise resolving when storage is complete
 */
function idbPut(storeName, value) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const task = () => {
      return new Promise((innerResolve, innerReject) => {
        try {
          const tx = db.transaction([storeName], 'readwrite');
          const store = tx.objectStore(storeName);
          const req = store.put(value);
          req.onsuccess = () => innerResolve(true);
          req.onerror = () => innerReject(req.error);
        } catch (e) {
          innerReject(e);
        }
      });
    };
    
    // BEST PRACTICE: Queue write operations to prevent race conditions
    idbTransactionQueue.push(() => task().then(resolve).catch(reject));
    processIdbQueue();
  });
}

function idbDelete(storeName, key) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbClear(storeName) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function getCollectionMetaKey(collectionName) {
  return `collection:${collectionName}:meta`;
}

function getCollectionChunkKey(collectionName, index) {
  return `collection:${collectionName}:chunk:${index}`;
}

/**
 * Save a large collection to IndexedDB by chunking it into smaller pieces.
 * Uses metadata and chunked storage for efficient retrieval.
 *
 * @param {string} collectionName - Name of the collection (e.g., 'customers', 'ads')
 * @param {Array} data - Array of items to store
 * @returns {Promise<void>} Promise resolving when all chunks are saved
 */
async function saveCollectionToIndexedDB(collectionName, data) {
  if (!db) return false;
  const name = String(collectionName || '');
  if (!name) return false;

  try {
    const metaKey = getCollectionMetaKey(name);
    const prevMeta = await idbGet(DATA_STORE_NAME, metaKey);
    const prevChunkCount = prevMeta?.chunkCount || 0;

    // Small payload -> single record (backwards compatible)
    const isArray = Array.isArray(data);
    const recordCount = isArray ? data.length : 0;
    if (!isArray || recordCount <= STORAGE_CONFIG.CHUNK_SIZE) {
      const record = {
        key: name,
        type: 'collection',
        data,
        checksum: DataIntegrity.calculateChecksum(data),
        updatedAt: Date.now(),
        recordCount
      };

      await idbPut(DATA_STORE_NAME, record);

      // Clean up any old chunked layout
      if (prevChunkCount > 0) {
        for (let i = 0; i < prevChunkCount; i++) {
          await idbDelete(DATA_STORE_NAME, getCollectionChunkKey(name, i));
        }
        await idbDelete(DATA_STORE_NAME, metaKey);
      }

      return true;
    }

    // Large payload -> chunked
    const chunkSize = STORAGE_CONFIG.CHUNK_SIZE;
    const chunkCount = Math.ceil(recordCount / chunkSize);
    const updatedAt = Date.now();

    for (let i = 0; i < chunkCount; i++) {
      const chunk = data.slice(i * chunkSize, (i + 1) * chunkSize);
      await idbPut(DATA_STORE_NAME, {
        key: getCollectionChunkKey(name, i),
        type: 'collection_chunk',
        collection: name,
        index: i,
        updatedAt,
        data: chunk
      });
    }

    await idbPut(DATA_STORE_NAME, {
      key: metaKey,
      type: 'collection_meta',
      collection: name,
      chunkSize,
      chunkCount,
      recordCount,
      checksum: DataIntegrity.calculateChecksum(data),
      updatedAt
    });

    // Delete any leftover old chunks
    if (prevChunkCount > chunkCount) {
      for (let i = chunkCount; i < prevChunkCount; i++) {
        await idbDelete(DATA_STORE_NAME, getCollectionChunkKey(name, i));
      }
    }

    // Remove legacy single-record storage if it exists
    await idbDelete(DATA_STORE_NAME, name).catch(() => {});
    return true;
  } catch (error) {
    console.error('Error saving collection to IndexedDB:', error);
    return false;
  }
}

async function loadCollectionFromIndexedDB(collectionName) {
  if (!db) return null;
  const name = String(collectionName || '');
  if (!name) return null;

  try {
    const metaKey = getCollectionMetaKey(name);
    const meta = await idbGet(DATA_STORE_NAME, metaKey);

    // Chunked layout
    if (meta && meta.type === 'collection_meta' && Number.isFinite(meta.chunkCount)) {
      const chunks = [];
      for (let i = 0; i < meta.chunkCount; i++) {
        const chunk = await idbGet(DATA_STORE_NAME, getCollectionChunkKey(name, i));
        if (chunk && Array.isArray(chunk.data)) {
          chunks.push(...chunk.data);
        } else {
          console.warn(`Missing chunk for ${name} index ${i}`);
        }
      }

      if (meta.checksum) {
        const currentChecksum = DataIntegrity.calculateChecksum(chunks);
        if (currentChecksum !== meta.checksum) {
          console.warn(`Data integrity warning for ${name}: checksum mismatch`);
        }
      }

      return chunks;
    }

    // Legacy single-record layout
    const record = await idbGet(DATA_STORE_NAME, name);
    if (record) {
      const currentChecksum = DataIntegrity.calculateChecksum(record.data);
      if (record.checksum && currentChecksum !== record.checksum) {
        console.warn(`Data integrity warning for ${name}: checksum mismatch`);
      }
      return record.data ?? null;
    }

    return null;
  } catch (error) {
    console.error('Error loading collection from IndexedDB:', error);
    return null;
  }
}

async function createAutoBackup() {
  if (!db) return false;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([BACKUP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(BACKUP_STORE_NAME);
      
      const backup = {
        id: Security.generateSecureId('backup'),
        createdAt: Date.now(),
        state: {
          ads: state.ads,
          receipts: state.receipts,
          customers: state.customers,
          pages: state.pages,
          users: state.users.map(u => ({
            ...u,
            password: undefined,
            passwordHash: u.passwordHash,
            salt: u.salt,
            passwordAlgo: u.passwordAlgo,
            passwordIterations: u.passwordIterations
          })),
          settings: {
            defaultExchangeRate: state.defaultExchangeRate,
            exchangeRateHistory: state.exchangeRateHistory
          }
        },
        checksum: DataIntegrity.calculateChecksum(state)
      };
      
      const request = store.put(backup);
      request.onsuccess = () => {
        // Clean old backups
        cleanOldBackups();
        resolve(true);
      };
      request.onerror = () => resolve(false);
    } catch (error) {
      console.error('Error creating backup:', error);
      resolve(false);
    }
  });
}

async function cleanOldBackups() {
  if (!db) return;
  
  try {
    const cutoffDate = Date.now() - (STORAGE_CONFIG.BACKUP_RETENTION_DAYS * TIME_CONSTANTS.MILLISECONDS_PER_DAY);
    const transaction = db.transaction([BACKUP_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(BACKUP_STORE_NAME);
    const index = store.index('createdAt');
    const range = IDBKeyRange.upperBound(cutoffDate);
    
    index.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  } catch (error) {
    console.error('Error cleaning old backups:', error);
  }
}

async function getStorageEstimate() {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      usagePercentage: estimate.quota ? ((estimate.usage / estimate.quota) * 100).toFixed(2) : 0
    };
  }
  return { usage: 0, quota: 0, usagePercentage: 0 };
}

async function saveLogToIndexedDB(log) {
  if (!db) return false;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.put(log);
      
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => {
        console.error('Error saving log to IndexedDB:', e);
        resolve(false);
      };
    } catch (error) {
      console.error('IndexedDB transaction error:', error);
      resolve(false);
    }
  });
}

async function loadLogsFromIndexedDB() {
  if (!db) return [];
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readonly');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const logs = request.result || [];
        // Sort by date descending (handle invalid dates safely)
        logs.sort((a, b) => {
          const dateA = new Date(a.date || 0).getTime() || 0;
          const dateB = new Date(b.date || 0).getTime() || 0;
          return dateB - dateA;
        });
        resolve(logs);
      };
      
      request.onerror = (e) => {
        console.error('Error loading logs from IndexedDB:', e);
        resolve([]);
      };
    } catch (error) {
      console.error('IndexedDB load error:', error);
      resolve([]);
    }
  });
}

async function syncLogsToIndexedDB() {
  if (!db || !state.logs) return;
  
  const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(LOG_STORE_NAME);
  
  for (const log of state.logs) {
    try {
      store.put(log);
    } catch (e) {
      console.error('Error syncing log:', e);
    }
  }
}

async function clearIndexedDBLogs() {
  if (!db) return;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.clear();
      
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    } catch (error) {
      resolve(false);
    }
  });
}

// ==========================================
// CONSTANTS & ENUMS
// ==========================================

const PAYMENT_METHODS = [
  'Cash (LYD)', 'Cash (USD)', 'Libyana', 'Madar', 'LTT', 
  'Transfer Office', 'Bank Transfer', 'Bank Transfer (LYD)', 
  'Bank Transfer (USD)', 'Sadad', 'USDT'
];

const AD_STATUSES = ['Pending', 'Paused', 'Completed', 'Canceled', 'Lost', 'Stopped'];
const DELIVERY_STATUSES = ['Needs Delivery', 'In Progress', 'Delivered', 'Canceled', 'Office'];
const REFUND_TYPES = ['None', 'Full', 'Partial'];
const PLATFORMS = ['Facebook', 'WhatsApp', 'Instagram', 'Phone'];
const USER_ROLES = ['Admin', 'Employee', 'Delivery'];

// Business configuration constants (can be moved to settings in future)
const BUSINESS_CONFIG = {
  // Default processing fee for receipts (LYD)
  RECEIPT_PROCESSING_FEE_LYD: 0, // Set to 0 - was 2.00 as placeholder; make configurable in settings if needed
};

// ==========================================
// ADVANCED PERMISSIONS SYSTEM
// ==========================================

const PERMISSION_MODULES = {
  analytics: {
    name: 'Analytics',
    icon: 'bar-chart-3',
    color: 'indigo',
    description: 'Dashboard & reporting access',
    permissions: {
      view: { label: 'View Analytics', description: 'View dashboard and reports' },
      export: { label: 'Export Reports', description: 'Export analytics data to CSV/PDF' },
      viewFinancials: { label: 'View Financials', description: 'View revenue and financial metrics' },
      viewSensitive: { label: 'View Sensitive Data', description: 'View detailed financial breakdowns' }
    }
  },
  ads: {
    name: 'Ads',
    icon: 'megaphone',
    color: 'purple',
    description: 'Ad campaign management',
    permissions: {
      view: { label: 'View Ads', description: 'View all ad campaigns' },
      viewOwn: { label: 'View Own Ads', description: 'View only self-created ads' },
      add: { label: 'Create Ads', description: 'Create new ad campaigns' },
      edit: { label: 'Edit Ads', description: 'Edit any ad campaign' },
      editOwn: { label: 'Edit Own Ads', description: 'Edit only self-created ads' },
      delete: { label: 'Delete Ads', description: 'Delete ad campaigns' },
      changeStatus: { label: 'Change Status', description: 'Change ad status (pause, stop, complete)' },
      stopAd: { label: 'Stop Ads', description: 'Stop running ads and return funds' },
      assignDelivery: { label: 'Assign Delivery', description: 'Assign delivery personnel' },
      viewPhotos: { label: 'View Photos', description: 'View ad photos and screenshots' },
      uploadPhotos: { label: 'Upload Photos', description: 'Upload ad photos' }
    }
  },
  receipts: {
    name: 'Receipts',
    icon: 'receipt',
    color: 'emerald',
    description: 'Receipt & payment management',
    permissions: {
      view: { label: 'View Receipts', description: 'View all receipts' },
      viewOwn: { label: 'View Own Receipts', description: 'View only self-created receipts' },
      add: { label: 'Create Receipts', description: 'Create new receipts' },
      edit: { label: 'Edit Receipts', description: 'Edit any receipt' },
      editOwn: { label: 'Edit Own Receipts', description: 'Edit only self-created receipts' },
      delete: { label: 'Delete Receipts', description: 'Delete receipts' },
      markCollected: { label: 'Mark Collected', description: 'Mark receipts as collected' },
      transfer: { label: 'Transfer Balance', description: 'Transfer balance between accounts' },
      viewHistory: { label: 'View History', description: 'View receipt edit history' },
      export: { label: 'Export Receipts', description: 'Export receipt data' }
    }
  },
  customers: {
    name: 'Customers',
    icon: 'users',
    color: 'blue',
    description: 'Customer relationship management',
    permissions: {
      view: { label: 'View Customers', description: 'View all customers' },
      viewOwn: { label: 'View Own Customers', description: 'View only assigned customers' },
      add: { label: 'Add Customers', description: 'Add new customers' },
      edit: { label: 'Edit Customers', description: 'Edit customer information' },
      editOwn: { label: 'Edit Own Customers', description: 'Edit only assigned customers' },
      delete: { label: 'Delete Customers', description: 'Delete customers' },
      viewBalance: { label: 'View Balance', description: 'View customer financial balance' },
      viewContacts: { label: 'View Contacts', description: 'View customer phone numbers' },
      export: { label: 'Export Customers', description: 'Export customer data' }
    }
  },
  pages: {
    name: 'Pages',
    icon: 'file-text',
    color: 'amber',
    description: 'Page management',
    permissions: {
      view: { label: 'View Pages', description: 'View all pages' },
      add: { label: 'Add Pages', description: 'Add new pages' },
      edit: { label: 'Edit Pages', description: 'Edit page information' },
      delete: { label: 'Delete Pages', description: 'Delete pages' },
      linkCustomers: { label: 'Link Customers', description: 'Link customers to pages' }
    }
  },
  deliveries: {
    name: 'Deliveries',
    icon: 'truck',
    color: 'cyan',
    description: 'Delivery operations',
    permissions: {
      view: { label: 'View Deliveries', description: 'View all delivery operations' },
      viewOwn: { label: 'View Own Deliveries', description: 'View only assigned deliveries' },
      accept: { label: 'Accept Deliveries', description: 'Accept assigned deliveries' },
      complete: { label: 'Complete Deliveries', description: 'Mark deliveries as completed' },
      markCollected: { label: 'Mark Collected', description: 'Mark delivery payments as collected' },
      assign: { label: 'Assign Deliveries', description: 'Assign deliveries to personnel' },
      reassign: { label: 'Reassign Deliveries', description: 'Reassign deliveries to different personnel' },
      viewStats: { label: 'View Statistics', description: 'View delivery statistics' }
    }
  },
  users: {
    name: 'Users',
    icon: 'user-cog',
    color: 'rose',
    description: 'User management',
    permissions: {
      view: { label: 'View Users', description: 'View all users' },
      add: { label: 'Add Users', description: 'Add new users' },
      edit: { label: 'Edit Users', description: 'Edit user information' },
      delete: { label: 'Delete Users', description: 'Delete users' },
      managePermissions: { label: 'Manage Permissions', description: 'Manage user permissions' },
      changeRole: { label: 'Change Roles', description: 'Change user roles' },
      resetPassword: { label: 'Reset Password', description: 'Reset user passwords' },
      viewActivity: { label: 'View Activity', description: 'View user activity logs' }
    }
  },
  settings: {
    name: 'Settings',
    icon: 'settings',
    color: 'slate',
    description: 'System settings',
    permissions: {
      view: { label: 'View Settings', description: 'View system settings' },
      edit: { label: 'Edit Settings', description: 'Edit system settings' },
      manageExchangeRate: { label: 'Manage Exchange Rate', description: 'Change exchange rates' },
      backup: { label: 'Backup Data', description: 'Backup system data' },
      restore: { label: 'Restore Data', description: 'Restore from backup' },
      clearData: { label: 'Clear Data', description: 'Clear all system data' }
    }
  },
  auditLogs: {
    name: 'Audit Logs',
    icon: 'file-clock',
    color: 'violet',
    description: 'System audit trail',
    permissions: {
      view: { label: 'View Audit Logs', description: 'View all audit logs' },
      viewOwn: { label: 'View Own Logs', description: 'View only own activity' },
      export: { label: 'Export Logs', description: 'Export audit logs' },
      backup: { label: 'Backup Logs', description: 'Backup audit logs' },
      clear: { label: 'Clear Logs', description: 'Clear audit logs' }
    }
  }
};

// Permission Templates / Presets
const PERMISSION_TEMPLATES = {
  fullAdmin: {
    name: 'Full Administrator',
    description: 'Complete access to all features',
    icon: 'crown',
    color: 'amber',
    permissions: Object.fromEntries(
      Object.entries(PERMISSION_MODULES).map(([module, config]) => [
        module,
        Object.keys(config.permissions)
      ])
    )
  },
  manager: {
    name: 'Manager',
    description: 'Manage operations without system settings',
    icon: 'briefcase',
    color: 'blue',
    permissions: {
      analytics: ['view', 'export', 'viewFinancials'],
      ads: ['view', 'add', 'edit', 'delete', 'changeStatus', 'assignDelivery', 'viewPhotos', 'uploadPhotos'],
      receipts: ['view', 'add', 'edit', 'markCollected', 'viewHistory', 'export'],
      customers: ['view', 'add', 'edit', 'viewBalance', 'viewContacts', 'export'],
      pages: ['view', 'add', 'edit', 'linkCustomers'],
      deliveries: ['view', 'accept', 'complete', 'markCollected', 'assign', 'viewStats'],
      users: ['view', 'viewActivity'],
      auditLogs: ['view', 'viewOwn']
    }
  },
  salesAgent: {
    name: 'Sales Agent',
    description: 'Sales and customer management',
    icon: 'user-check',
    color: 'emerald',
    permissions: {
      analytics: ['view'],
      ads: ['view', 'viewOwn', 'add', 'editOwn', 'viewPhotos', 'uploadPhotos'],
      receipts: ['view', 'viewOwn', 'add', 'editOwn'],
      customers: ['view', 'add', 'edit', 'viewContacts'],
      pages: ['view', 'add'],
      auditLogs: ['viewOwn']
    }
  },
  deliveryDriver: {
    name: 'Delivery Driver',
    description: 'Delivery operations only',
    icon: 'truck',
    color: 'cyan',
    permissions: {
      deliveries: ['viewOwn', 'accept', 'complete', 'markCollected'],
      ads: ['viewOwn'],
      customers: ['viewOwn', 'viewContacts']
    }
  },
  accountant: {
    name: 'Accountant',
    description: 'Financial management access',
    icon: 'calculator',
    color: 'purple',
    permissions: {
      analytics: ['view', 'export', 'viewFinancials', 'viewSensitive'],
      receipts: ['view', 'add', 'edit', 'markCollected', 'transfer', 'viewHistory', 'export'],
      customers: ['view', 'viewBalance'],
      ads: ['view'],
      auditLogs: ['view', 'export']
    }
  },
  viewer: {
    name: 'Read Only',
    description: 'View access only, no modifications',
    icon: 'eye',
    color: 'slate',
    permissions: {
      analytics: ['view'],
      ads: ['view', 'viewPhotos'],
      receipts: ['view'],
      customers: ['view'],
      pages: ['view'],
      deliveries: ['view'],
      auditLogs: ['viewOwn']
    }
  }
};

// Helper function to check if user has permission
function hasPermission(userId, module, action) {
  // System/admin always has access
  if (!userId || userId === 'system') return true;
  
  const user = state.users.find(u => u.id === userId);
  if (!user) return false;
  
  // Admins have all permissions
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  
  // Check specific permission - ensure permissions object exists
  const permissions = user.permissions;
  if (!permissions || typeof permissions !== 'object') return false;
  
  // Get module permissions array
  const modulePerms = permissions[module];
  if (!Array.isArray(modulePerms)) return false;
  
  // Check if action is in the permissions array (case-insensitive check as fallback)
  return modulePerms.includes(action) || modulePerms.some(p => String(p).toLowerCase() === String(action).toLowerCase());
}

// Refresh current user's permissions from server
async function refreshCurrentUserPermissions() {
  if (!isServerModeEnabled() || !state.currentUser?.id) return;
  try {
    const me = await apiAuthMe();
    if (me && me.permissions) {
      state.currentUser.permissions = me.permissions;
      // Also update in users array
      const idx = state.users.findIndex(u => u.id === me.id);
      if (idx !== -1) {
        state.users[idx].permissions = me.permissions;
      }
      console.log('[Permissions] Refreshed current user permissions');
    }
  } catch (e) {
    console.warn('[Permissions] Failed to refresh:', e?.message || e);
  }
}

// Check if current user has permission
function currentUserHasPermission(module, action) {
  return hasPermission(state.currentUser?.id, module, action);
}

// Get all permissions for a user
function getUserPermissions(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return {};
  
  if (user.role === 'Admin') {
    // Admin gets all permissions
    return Object.fromEntries(
      Object.entries(PERMISSION_MODULES).map(([module, config]) => [
        module,
        Object.keys(config.permissions)
      ])
    );
  }
  
  return user.permissions || {};
}

// Get permission summary for display
function getPermissionSummary(permissions) {
  let total = 0;
  let granted = 0;
  
  Object.entries(PERMISSION_MODULES).forEach(([module, config]) => {
    const modulePerms = Object.keys(config.permissions).length;
    total += modulePerms;
    if (permissions[module]) {
      granted += permissions[module].length;
    }
  });
  
  return { total, granted, percentage: Math.round((granted / total) * 100) };
}

// Helper to render permission-controlled buttons
function renderPermissionButton(module, action, buttonHtml, fallbackHtml = '') {
  if (currentUserHasPermission(module, action)) {
    return buttonHtml;
  }
  return fallbackHtml;
}

// Check if user can perform action on specific record (own vs all)
function canActOnRecord(module, action, recordCreatorId) {
  // Admin always can
  if (state.currentUser?.role === 'Admin') return true;
  
  // Check full permission first
  if (currentUserHasPermission(module, action)) return true;
  
  // Check "own" permission
  const ownAction = action + 'Own';
  if (currentUserHasPermission(module, ownAction) && recordCreatorId === state.currentUser?.id) {
    return true;
  }
  
  return false;
}

// Get a permission-denied tooltip
function getPermissionDeniedTooltip(action) {
  return `You don't have permission to ${action}. Contact your administrator.`;
}

// ==========================================
// SUBSCRIPTION HELPERS (Services Hub)
// ==========================================

function hasSubscription(serviceId) {
  if (!state.currentUser) return false;
  if (state.currentUser.role === 'Admin') return true; // Admin gets all
  const uid = String(state.currentUser.id || '');
  if (uid && SUBSCRIPTIONS.isActive(uid, serviceId)) return true;
  const subs = state.currentUser.subscriptions || [];
  return subs.includes(serviceId);
}

function getServiceSubscriptionOffer(serviceId) {
  const svc = SERVICES[serviceId];
  const offer = svc && typeof svc === 'object' ? svc.subscription : null;
  const currency = walletNormalizeCurrency(offer?.currency || WALLET.currency);
  const priceMinor = Number.isFinite(Number(offer?.priceMinor))
    ? Math.trunc(Number(offer?.priceMinor))
    : walletToMinor(Number(offer?.price ?? 0), currency);
  const durationDays = Number(offer?.durationDays ?? 30);
  return {
    currency,
    priceMinor: Number.isFinite(priceMinor) && priceMinor >= 0 ? priceMinor : 0,
    durationDays: Number.isFinite(durationDays) && durationDays > 0 ? Math.round(durationDays) : 30
  };
}

function checkServiceAccess(serviceId) {
  const service = SERVICES[serviceId];
  if (service) {
    if (service.comingSoon) return { allowed: false, reason: 'coming_soon' };
    if (service.requiresSubscription && !hasSubscription(service.id)) {
      return { allowed: false, reason: 'not_subscribed', subscribeToId: service.id };
    }
    return { allowed: true };
  }

  const child = SMART_SYSTEMS_CHILDREN[serviceId];
  if (child) {
    if (child.comingSoon) return { allowed: false, reason: 'coming_soon' };
    const required = Array.isArray(child.requiredSubscriptions) && child.requiredSubscriptions.length
      ? child.requiredSubscriptions
      : [child.id];
    const ok = !child.requiresSubscription || required.some((sid) => hasSubscription(sid));
    if (!ok) {
      return { allowed: false, reason: 'not_subscribed', subscribeToId: required[0] || 'smart_systems', requiredSubscriptions: required };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'Service not found' };
}

function showSubscriptionModal(serviceId, subscribeToId = serviceId) {
  const service = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  if (!service) return;
  
  const serviceName = state.language === 'ar' ? service.nameAr : service.name;
  
  state.activeModal = 'subscription-lock';
  // Idempotency key prevents double-charging if user retries
  const idem = Security.generateSecureId('idem');
  state.modalData = { serviceId, serviceName, subscribeToId, idempotencyKey: idem };
  renderModal();
}

function openServiceById(id) {
  if (SERVICES[id]) return handleServiceClick(id);
  if (SMART_SYSTEMS_CHILDREN[id]) return handleSmartSystemClick(id);
}

function handleSubscribe(subscribeToId, navigateToId = subscribeToId) {
  if (!state.currentUser?.id) return;
  try {
    // If already active, just continue
    if (hasSubscription(subscribeToId)) {
      closeModal();
      openServiceById(navigateToId);
      return;
    }

    const offer = getServiceSubscriptionOffer(subscribeToId);
    const idem = String(state.modalData?.idempotencyKey || '').trim() || Security.generateSecureId('idem');
    SUBSCRIPTIONS.subscribe(state.currentUser.id, subscribeToId, { ...offer, idempotencyKey: idem });

    // Optional legacy mirror (keeps older UI logic compatible)
    if (!Array.isArray(state.currentUser.subscriptions)) state.currentUser.subscriptions = [];
    if (!state.currentUser.subscriptions.includes(subscribeToId)) {
      state.currentUser.subscriptions.push(subscribeToId);
      // persist into the actual user record too (not only session)
      updateRecord(state.users, state.currentUser.id, { subscriptions: state.currentUser.subscriptions });
    }

    closeModal();
    showNotification(
      state.language === 'ar' ? 'تم الاشتراك' : 'Subscribed',
      state.language === 'ar' ? 'تم تفعيل الخدمة بنجاح' : 'Service activated successfully',
      'success'
    );

    // Now navigate to the originally clicked card
    openServiceById(navigateToId);
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Failed to subscribe', 'error');
  }
}

// ==========================================
// PASSWORD RESET (Advanced, Safe)
// ==========================================

function generateRecoveryKeyPlain() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{1,4}/g) || [hex]).join('-');
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to legacy copy
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

async function setLocalRecoveryKeyFromPlain(plainKey) {
  const key = String(plainKey ?? '').trim();
  if (!key) throw new Error('Recovery key is required');
  const hashed = await Security.hashPassword(key, null, { algo: 'pbkdf2-sha256' });
  state.localRecovery = {
    hash: hashed.hash,
    salt: hashed.salt,
    algo: hashed.algo,
    iterations: hashed.iterations,
    createdAt: Date.now()
  };
  saveState();
}

function showRecoveryKeyModal(plainKey) {
  state.activeModal = 'recovery-key';
  state.modalData = { recoveryKey: String(plainKey ?? '') };
  renderModal();
}

async function generateAndShowRecoveryKey() {
  if (isServerModeEnabled()) {
    showNotification('Not Available', 'Recovery keys are for local mode only. Use email reset on the server.', 'info');
    return;
  }
  if (!state.currentUser || state.currentUser.role !== 'Admin') {
    showNotification('Access Denied', 'Only Admin can generate a recovery key.', 'error');
    return;
  }
  const key = generateRecoveryKeyPlain();
  await setLocalRecoveryKeyFromPlain(key);
  showRecoveryKeyModal(key);
}

function showPasswordResetModal() {
  state.activeModal = 'password-reset';
  state.modalData = {
    step: isServerModeEnabled() ? 'request' : 'local',
    email: '',
    token: ''
  };
  renderModal();
}

async function apiPasswordResetRequest(email) {
  const payload = { email };
  return await apiJson('/api/auth/password-reset/request', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_MS });
}

async function apiPasswordResetConfirm(token, newPassword) {
  const payload = { token, newPassword };
  return await apiJson('/api/auth/password-reset/confirm', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
}

async function passwordResetRequestServer() {
  try {
    const emailInput = document.getElementById('pwreset-email');
    const email = Security.sanitizeInput(String(emailInput?.value || '').toLowerCase().trim(), { maxLength: 120 });
    if (!Security.isValidEmail(email)) {
      showNotification('Validation', 'Please enter a valid email address', 'error');
      return;
    }
    const res = await apiPasswordResetRequest(email);
    state.modalData = { step: 'confirm', email, token: String(res?.resetCode || '') };
    renderModal();
    showNotification('Reset Code Sent', 'If this account exists, you will receive a reset code.', 'success');
  } catch (e) {
    showNotification('Error', e.message || 'Failed to request reset', 'error');
  }
}

async function passwordResetConfirmServer() {
  try {
    const token = Security.sanitizeInput(String(document.getElementById('pwreset-token')?.value || '').trim(), { maxLength: 256 });
    const newPassword = String(document.getElementById('pwreset-new')?.value || '');
    const confirm = String(document.getElementById('pwreset-confirm')?.value || '');

    if (!token) {
      showNotification('Validation', 'Reset code is required', 'error');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      showNotification('Validation', 'Password must be at least 8 characters', 'error');
      return;
    }
    if (newPassword !== confirm) {
      showNotification('Validation', 'Passwords do not match', 'error');
      return;
    }

    await apiPasswordResetConfirm(token, newPassword);
    closeModal();
    showNotification('Success', 'Password reset successfully. Please sign in.', 'success');
    render();
  } catch (e) {
    showNotification('Reset Failed', e.message || 'Invalid or expired reset code', 'error');
  }
}

async function passwordResetConfirmLocal() {
  try {
    if (isServerModeEnabled()) {
      showNotification('Server Mode', 'Use server password reset.', 'info');
      return;
    }
    const email = Security.sanitizeInput(String(document.getElementById('pwreset-email')?.value || '').toLowerCase().trim(), { maxLength: 120 });
    const recoveryKey = String(document.getElementById('pwreset-recovery')?.value || '').trim();
    const newPassword = String(document.getElementById('pwreset-new')?.value || '');
    const confirm = String(document.getElementById('pwreset-confirm')?.value || '');

    if (!Security.isValidEmail(email)) {
      showNotification('Validation', 'Please enter a valid email address', 'error');
      return;
    }
    if (!state.localRecovery?.hash || !state.localRecovery?.salt) {
      showNotification('Recovery Not Set', 'No recovery key is configured. Ask Admin to create one in Settings → Security.', 'error');
      return;
    }
    const ok = await Security.verifyPassword(
      recoveryKey,
      state.localRecovery.hash,
      state.localRecovery.salt,
      state.localRecovery.algo || 'pbkdf2-sha256',
      state.localRecovery.iterations || 310000
    );
    if (!ok) {
      showNotification('Invalid Recovery Key', 'The recovery key is incorrect.', 'error');
      addSecurityLog('password_reset_bad_recovery_key', email);
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      showNotification('Validation', 'Password must be at least 8 characters', 'error');
      return;
    }
    if (newPassword !== confirm) {
      showNotification('Validation', 'Passwords do not match', 'error');
      return;
    }

    const user = state.users.find(u => u && !u._deleted && String(u.email || '').toLowerCase() === email);
    if (!user) {
      showNotification('Not Found', 'No user found with this email (local).', 'error');
      return;
    }

    const hashed = await Security.hashPassword(newPassword, null, { algo: 'pbkdf2-sha256' });
    const updates = {
      passwordHash: hashed.hash,
      salt: hashed.salt,
      passwordAlgo: hashed.algo,
      passwordIterations: hashed.iterations
    };
    updateRecord(state.users, user.id, updates);
    markCollectionDirty('users');
    saveState();
    flushDirtyCollections().catch(() => {});

    closeModal();
    showNotification('Success', 'Password reset successfully. Please sign in.', 'success');
    render();
  } catch (e) {
    console.error('Local password reset error:', e);
    showNotification('Error', e.message || 'Failed to reset password', 'error');
  }
}

// ==========================================
// PASSKEYS (WebAuthn) - Local-first, Safe Verification
// ==========================================

function _bufToB64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return b64;
}

function _b64urlToBuf(b64url) {
  const s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function _sha256(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const h = await crypto.subtle.digest('SHA-256', ab);
  return new Uint8Array(h);
}

function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Minimal CBOR decoder for WebAuthn objects (maps/arrays/bytes/ints/strings)
function _cborDecode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let offset = 0;

  function read(n) {
    const end = offset + n;
    if (end > bytes.length) throw new Error('CBOR: out of range');
    const out = bytes.slice(offset, end);
    offset = end;
    return out;
  }

  function readUInt(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return read(1)[0];
    if (ai === 25) {
      const v = read(2);
      return (v[0] << 8) | v[1];
    }
    if (ai === 26) {
      const v = read(4);
      return (v[0] * 2 ** 24) + (v[1] << 16) + (v[2] << 8) + v[3];
    }
    throw new Error('CBOR: unsupported int size');
  }

  function decodeItem() {
    const first = read(1)[0];
    const major = first >> 5;
    const ai = first & 0x1f;

    if (major === 0) return readUInt(ai);
    if (major === 1) return -1 - readUInt(ai);
    if (major === 2) {
      const len = readUInt(ai);
      return read(len); // Uint8Array
    }
    if (major === 3) {
      const len = readUInt(ai);
      const s = read(len);
      return new TextDecoder().decode(s);
    }
    if (major === 4) {
      const len = readUInt(ai);
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(decodeItem());
      return arr;
    }
    if (major === 5) {
      const len = readUInt(ai);
      const m = new Map();
      for (let i = 0; i < len; i++) {
        const k = decodeItem();
        const v = decodeItem();
        m.set(k, v);
      }
      return m;
    }
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
    }
    throw new Error('CBOR: unsupported type');
  }

  const value = decodeItem();
  return { value, readBytes: offset };
}

function _getRpId() {
  const host = String(location.hostname || '').trim();
  return host || null;
}

function _isPasskeySupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

function _listAllStoredPasskeys() {
  const out = [];
  for (const u of (state.users || [])) {
    if (!u || u._deleted) continue;
    const keys = Array.isArray(u.passkeys) ? u.passkeys : [];
    for (const k of keys) {
      if (k && k.id && k.publicKeyJwk) out.push({ user: u, key: k });
    }
  }
  return out;
}

async function passkeyRegisterCurrentUser() {
  try {
    if (!_isPasskeySupported()) {
      showNotification('Not Supported', 'Passkeys require HTTPS or localhost.', 'error');
      return;
    }
    if (!state.currentUser?.id) {
      showNotification('Not Logged In', 'Please login first to add a passkey.', 'error');
      return;
    }

    const rpId = _getRpId();
    if (!rpId) {
      showNotification('Not Supported', 'Passkeys require a web origin (HTTPS/localhost).', 'error');
      return;
    }

    const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id) || state.currentUser;
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const publicKey = {
      challenge,
      rp: { name: t('appName') },
      user: {
        id: new TextEncoder().encode(String(user.id)),
        name: String(user.email || user.id),
        displayName: String(user.name || user.email || user.id)
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 } // ES256
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      },
      timeout: TIME_CONSTANTS.WEBAUTHN_TIMEOUT_MS,
      attestation: 'none'
    };

    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Passkey creation cancelled');

    const rawId = cred.rawId;
    const credentialId = _bufToB64url(rawId);

    // Parse attestationObject → authData → COSE key
    const attObj = new Uint8Array(cred.response.attestationObject);
    const { value: attMap } = _cborDecode(attObj);
    if (!(attMap instanceof Map)) throw new Error('Invalid attestation');
    const authData = attMap.get('authData');
    if (!(authData instanceof Uint8Array)) throw new Error('Invalid authData');

    const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
    const flags = authData[32];
    const hasAttestedCredData = (flags & 0x40) !== 0;
    if (!hasAttestedCredData) throw new Error('Authenticator did not return credential data');

    // authData layout: rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | coseKey
    let p = 37; // 32 + 1 + 4
    p += 16; // aaguid
    const credIdLen = (authData[p] << 8) | authData[p + 1];
    p += 2;
    const credIdBytes = authData.slice(p, p + credIdLen);
    p += credIdLen;
    const coseBytes = authData.slice(p);
    const { value: coseKey } = _cborDecode(coseBytes);
    if (!(coseKey instanceof Map)) throw new Error('Invalid COSE key');

    const kty = coseKey.get(1);
    const alg = coseKey.get(3);
    const crv = coseKey.get(-1);
    const x = coseKey.get(-2);
    const y = coseKey.get(-3);
    if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error('Unsupported passkey algorithm (only ES256/P-256 supported)');
    }

    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: _bufToB64url(x),
      y: _bufToB64url(y),
      ext: true
    };

    if (!Array.isArray(user.passkeys)) user.passkeys = [];
    const exists = user.passkeys.some(k => k && k.id === credentialId);
    if (!exists) {
      user.passkeys.push({
        id: credentialId,
        publicKeyJwk: jwk,
        alg: 'ES256',
        createdAt: Date.now()
      });
      updateRecord(state.users, user.id, { passkeys: user.passkeys });
    }

    showNotification('Success', 'Passkey added successfully', 'success');
    render(); // refresh settings UI
  } catch (e) {
    console.error('Passkey register error:', e);
    showNotification('Error', e.message || 'Failed to add passkey', 'error');
  }
}

async function passkeySignIn() {
  try {
    if (isServerModeEnabled()) {
      showNotification('Not Available', 'Passkey sign-in requires server WebAuthn endpoints (next step).', 'info');
      return;
    }
    if (!_isPasskeySupported()) {
      showNotification('Not Supported', 'Passkeys require HTTPS or localhost.', 'error');
      return;
    }

    const rpId = _getRpId();
    if (!rpId) {
      showNotification('Not Supported', 'Passkeys require a web origin (HTTPS/localhost).', 'error');
      return;
    }

    const stored = _listAllStoredPasskeys();
    if (stored.length === 0) {
      showNotification('No Passkeys', 'No passkeys found. Login with password then add one in Settings → Security.', 'info');
      return;
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = stored.map(({ key }) => ({
      type: 'public-key',
      id: _b64urlToBuf(key.id)
    }));

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 60000
      }
    });

    if (!assertion) throw new Error('Passkey sign-in cancelled');

    const credId = _bufToB64url(assertion.rawId);
    const match = stored.find(({ key }) => key.id === credId);
    if (!match) throw new Error('Unknown passkey');

    const { user, key } = match;
    const clientData = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
    if (clientData?.type !== 'webauthn.get') throw new Error('Invalid assertion type');
    if (clientData?.origin !== location.origin) throw new Error('Origin mismatch');

    const authData = new Uint8Array(assertion.response.authenticatorData);
    const rpIdHash = authData.slice(0, 32);
    const expectedRpIdHash = await _sha256(new TextEncoder().encode(rpId));
    for (let i = 0; i < 32; i++) {
      if (rpIdHash[i] !== expectedRpIdHash[i]) throw new Error('RP ID mismatch');
    }

    const clientDataHash = await _sha256(assertion.response.clientDataJSON);
    const signedData = _concatBytes(authData, clientDataHash);
    const signature = new Uint8Array(assertion.response.signature);

    const jwk = key.publicKeyJwk;
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signature,
      signedData
    );

    if (!ok) throw new Error('Passkey verification failed');

    // Login
    SessionManager.createSession(user.id);
    state.currentUser = user;
    if (!Array.isArray(state.currentUser.subscriptions)) {
      state.currentUser.subscriptions = [];
      if (state.currentUser.role === 'Admin') {
        state.currentUser.subscriptions = Object.keys(SERVICES);
      }
    }
    state.currentView = getPostLoginLandingViewForUser(user);
    saveState();
    showNotification('Welcome!', `Logged in as ${Security.escapeHtml(user.name || user.email || user.id)}`, 'success');
    render();
  } catch (e) {
    console.error('Passkey sign-in error:', e);
    showNotification('Passkey Login Failed', e.message || 'Failed to sign in with passkey', 'error');
  }
}

function removePasskey(credentialId) {
  try {
    if (!state.currentUser?.id) {
      showNotification('Error', 'Not logged in', 'error');
      return;
    }
    const id = String(credentialId || '').trim();
    if (!id) return;
    const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id);
    if (!user) return;
    const keys = Array.isArray(user.passkeys) ? user.passkeys : [];
    const next = keys.filter(k => k && k.id !== id);
    updateRecord(state.users, user.id, { passkeys: next });
    showNotification('Removed', 'Passkey removed', 'success');
    render();
  } catch (e) {
    console.error('removePasskey error:', e);
    showNotification('Error', e.message || 'Failed to remove passkey', 'error');
  }
}

function showChangePasswordModal() {
  state.activeModal = 'change-password';
  state.modalData = {};
  renderModal();
}

async function apiChangePassword(currentPassword, newPassword) {
  const payload = { currentPassword, newPassword };
  return await apiJson('/api/auth/password-change', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
}

// ==========================================
// APPLICATION STATE
// ==========================================

// ==========================================
// SERVICES CONFIGURATION (Multi-Service Hub)
// ==========================================

const SERVICES = {
  international_shipping: {
    id: 'international_shipping',
    order: 1,
    name: 'International Shipping',
    nameAr: 'الشحن الدولي',
    icon: 'plane',
    color: 'from-blue-500 to-cyan-500',
    description: 'Ship worldwide',
    descriptionAr: 'شحن عالمي',
    comingSoon: false,
    requiresSubscription: true,
    // Pricing offer (local demo). In server mode, pricing should come from the backend.
    subscription: { price: 0, durationDays: 30 }
  },
  local_shipping: {
    id: 'local_shipping',
    order: 2,
    name: 'Local Shipping',
    nameAr: 'الشحن المحلي',
    icon: 'truck',
    color: 'from-emerald-500 to-green-500',
    description: 'Local delivery',
    descriptionAr: 'توصيل محلي',
    comingSoon: false,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  warehouse: {
    id: 'warehouse',
    order: 3,
    name: 'Warehouse',
    nameAr: 'المستودع',
    icon: 'warehouse',
    color: 'from-orange-500 to-red-500',
    description: 'Storage solutions',
    descriptionAr: 'حلول التخزين',
    comingSoon: false,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  smart_systems: {
    id: 'smart_systems',
    order: 4, // Service #4 (Business Tools / Smart Systems)
    name: 'Smart Systems',
    nameAr: 'الأنظمة الذكية',
    icon: 'cpu',
    color: 'from-violet-500 to-fuchsia-500',
    description: 'Business tools & portals',
    descriptionAr: 'أدوات الأعمال والبوابات',
    comingSoon: false,
    requiresSubscription: true, // treat as a paid service (children inherit by default)
    subscription: { price: 0, durationDays: 30 },
    openView: 'smart-systems',
    hasChildren: true,
    children: ['albayan_manager', 'crm', 'store_system']
  },
  albayan_cards: {
    id: 'albayan_cards',
    order: 5,
    name: 'Albayan Cards',
    nameAr: 'بطاقات البيان',
    icon: 'credit-card',
    color: 'from-purple-500 to-pink-500',
    description: 'Payment cards',
    descriptionAr: 'بطاقات الدفع',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  ad_maker: {
    id: 'ad_maker',
    order: 6,
    name: 'Ad Maker',
    nameAr: 'صانع الإعلانات',
    icon: 'sparkles',
    color: 'from-indigo-500 to-purple-500',
    description: 'Create ads yourself',
    descriptionAr: 'اصنع إعلاناتك',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  ship_through_us: {
    id: 'ship_through_us',
    order: 7,
    name: 'Ship Through Us',
    nameAr: 'اشحن معنا',
    icon: 'package',
    color: 'from-sky-500 to-blue-500',
    description: 'Full service shipping',
    descriptionAr: 'شحن كامل الخدمة',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  managed_social_ads: {
    id: 'managed_social_ads',
    order: 8,
    name: 'Managed Social Ads',
    nameAr: 'إعلانات مُدارة',
    icon: 'zap',
    color: 'from-amber-500 to-yellow-500',
    description: 'We run your ads',
    descriptionAr: 'ندير إعلاناتك',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  placeholder_coming_soon: {
    id: 'placeholder_coming_soon',
    order: 9,
    name: 'Coming Soon',
    nameAr: 'قريباً',
    icon: 'rocket',
    color: 'from-slate-400 to-slate-500',
    description: 'More services soon',
    descriptionAr: 'المزيد قريباً',
    comingSoon: true,
    requiresSubscription: false
  }
};

// Child systems under Smart Systems
const SMART_SYSTEMS_CHILDREN = {
  albayan_manager: {
    id: 'albayan_manager',
    order: 1,
    name: 'Albayan Manager',
    nameAr: 'مدير البيان',
    icon: 'megaphone',
    color: 'from-indigo-600 to-purple-600',
    description: 'Ads Manager Portal',
    descriptionAr: 'بوابة إدارة الإعلانات',
    comingSoon: false,
    requiresSubscription: true,
    // Access via Smart Systems subscription (recommended default)
    requiredSubscriptions: ['smart_systems'],
    openView: 'analytics'
  },
  crm: {
    id: 'crm',
    order: 2,
    name: 'CRM',
    nameAr: 'إدارة العملاء',
    icon: 'users',
    color: 'from-blue-500 to-cyan-500',
    description: 'Customer management',
    descriptionAr: 'إدارة العملاء',
    comingSoon: true,
    requiresSubscription: true,
    requiredSubscriptions: ['smart_systems']
  },
  store_system: {
    id: 'store_system',
    order: 3,
    name: 'Store System',
    nameAr: 'نظام المتجر',
    icon: 'shopping-cart',
    color: 'from-green-500 to-emerald-500',
    description: 'E-commerce platform',
    descriptionAr: 'منصة التجارة الإلكترونية',
    comingSoon: true,
    requiresSubscription: true,
    requiredSubscriptions: ['smart_systems']
  }
};

// ==========================================
// PLATFORM FOUNDATION (Wallet + Subscriptions)
// ==========================================

// Money must be handled using **minor units integers** (no floats).
// NOTE: This is still local/demo friendly, but real money must be enforced in server mode.
const WALLET_SUPPORTED_CURRENCIES = ['LYD', 'USD', 'EUR'];
const WALLET_CURRENCY_META = {
  LYD: { decimals: 2, label: 'LYD' },
  USD: { decimals: 2, label: 'USD' },
  EUR: { decimals: 2, label: 'EUR' }
};

// UI safety guard to prevent accidental double-submits (double charging) in local demo mode.
// Server mode must still enforce idempotency authoritatively.
const WalletUiGuard = {
  windowMs: 1800,
  _last: new Map(),
  hit: (fingerprint) => {
    const key = String(fingerprint || '').trim();
    if (!key) return false;
    const now = Date.now();
    const last = Number(WalletUiGuard._last.get(key) || 0);
    if (now - last < WalletUiGuard.windowMs) return true;
    WalletUiGuard._last.set(key, now);
    return false;
  }
};

function walletNormalizeCurrency(input) {
  const c = String(input || '').trim().toUpperCase();
  if (WALLET_SUPPORTED_CURRENCIES.includes(c)) return c;
  return 'LYD';
}

function walletDecimals(currency) {
  const c = walletNormalizeCurrency(currency);
  return Number(WALLET_CURRENCY_META[c]?.decimals ?? 2);
}

function walletToMinor(amountMajor, currency) {
  const d = walletDecimals(currency);
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return NaN;
  const factor = 10 ** d;
  // Round to minor units (safe enough for UI input; server must validate precisely)
  return Math.round(n * factor);
}

function walletFromMinor(amountMinor, currency) {
  const d = walletDecimals(currency);
  const factor = 10 ** d;
  const n = Number(amountMinor);
  if (!Number.isFinite(n)) return NaN;
  return n / factor;
}

function walletTxCurrency(tx) {
  const c = tx && typeof tx === 'object' ? tx.currency : null;
  return walletNormalizeCurrency(c || WALLET.currency);
}

function walletTxAmountMinor(tx) {
  if (!tx || typeof tx !== 'object') return 0;
  const c = walletTxCurrency(tx);
  const minor = Number(tx.amountMinor);
  if (Number.isFinite(minor)) return Math.trunc(minor);
  const major = Number(tx.amount);
  if (Number.isFinite(major)) {
    const m = walletToMinor(major, c);
    return Number.isFinite(m) ? Math.trunc(m) : 0;
  }
  return 0;
}

function walletFormatMinor(amountMinor, currency) {
  const c = walletNormalizeCurrency(currency);
  const d = walletDecimals(c);
  const major = walletFromMinor(amountMinor, c);
  if (!Number.isFinite(major)) return `0 ${c}`;
  return `${major.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} ${c}`;
}

function walletFindByIdempotency(idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return null;
  const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  return txs.find(t => t && !t._deleted && String(t.idempotencyKey || '') === key) || null;
}

const WALLET = {
  currency: 'LYD',
  // Compute balance from immutable ledger
  getBalanceMinor: (userId, currency = WALLET.currency) => {
    const uid = String(userId || '');
    if (!uid) return 0;
    const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
    const c = walletNormalizeCurrency(currency || WALLET.currency);
    let balMinor = 0;
    for (const tx of txs) {
      if (!tx || tx._deleted) continue;
      if (walletTxCurrency(tx) !== c) continue;
      const amtMinor = walletTxAmountMinor(tx);
      if (tx.toUserId === uid) balMinor += amtMinor;
      if (tx.fromUserId === uid) balMinor -= amtMinor;
    }
    return balMinor;
  },
  getBalance: (userId, currency = WALLET.currency) => {
    const c = walletNormalizeCurrency(currency || WALLET.currency);
    const minor = WALLET.getBalanceMinor(userId, c);
    const major = walletFromMinor(minor, c);
    const d = walletDecimals(c);
    return Number.isFinite(major) ? Number(major.toFixed(d)) : 0;
  },
  getBalances: (userId) => {
    const uid = String(userId || '');
    const out = {};
    if (!uid) return out;
    for (const c of WALLET_SUPPORTED_CURRENCIES) {
      const major = WALLET.getBalance(uid, c);
      if (major !== 0) out[c] = major;
    }
    // Always include default currency for predictable UI
    if (out[WALLET.currency] === undefined) out[WALLET.currency] = WALLET.getBalance(uid, WALLET.currency);
    return out;
  },
  // Add credit (admin/top-up)
  credit: (toUserId, amount, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    // Bank-grade rule: in real deployments, "minting" money must come ONLY from external funding rails
    // (bank/processor settlement). Manual credit should be disabled in server mode.
    if (isServerModeEnabled()) throw new Error('Manual top-ups are disabled in server mode');
    if (state.currentUser.role !== 'Admin') throw new Error('Only Admin can top-up wallets');
    const currency = walletNormalizeCurrency(meta.currency || WALLET.currency);
    const amountMinor = Number.isFinite(Number(meta.amountMinor)) ? Math.trunc(Number(meta.amountMinor)) : walletToMinor(amount, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const idem = Security.sanitizeInput(String(meta.idempotencyKey || '').trim(), { maxLength: 120 });
    if (idem) {
      const existing = walletFindByIdempotency(idem);
      if (existing) return existing;
    }
    const tx = {
      id: generateId('wtx'),
      type: 'credit',
      schemaVersion: 2,
      amountMinor,
      currency,
      // Keep a major value for convenience/debugging (NOT source of truth)
      amount: walletFromMinor(amountMinor, currency),
      fromUserId: null,
      toUserId: String(toUserId || ''),
      memo: Security.sanitizeInput(meta.memo || 'Top-up', { maxLength: 180 }),
      idempotencyKey: idem || undefined,
      status: 'posted',
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.id || 'system',
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    if (!tx.toUserId) throw new Error('Missing recipient');
    if (tx.toUserId === 'system') throw new Error('Invalid recipient');
    const exists = Array.isArray(state.users) && state.users.some(u => u && !u._deleted && String(u.id) === tx.toUserId);
    if (!exists) throw new Error('Recipient not found');
    addRecord(state.walletTransactions, tx);
    addAuditLog('wallet', tx.id, `Wallet credit ${walletFormatMinor(amountMinor, currency)}`, { resourceType: 'walletTransactions', toUserId: tx.toUserId });
    return tx;
  },
  // Transfer between users
  transfer: (fromUserId, toUserId, amount, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const currency = walletNormalizeCurrency(meta.currency || WALLET.currency);
    const amountMinor = Number.isFinite(Number(meta.amountMinor)) ? Math.trunc(Number(meta.amountMinor)) : walletToMinor(amount, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fromId = String(fromUserId || '');
    const toId = String(toUserId || '');
    if (!fromId || !toId) throw new Error('Missing users');
    if (fromId === toId) throw new Error('Cannot transfer to self');
    const isAdmin = state.currentUser.role === 'Admin';
    if (!isAdmin && String(state.currentUser.id) !== fromId) throw new Error('Forbidden');
    if (!isAdmin && fromId === 'system') throw new Error('Forbidden');
    if (toId !== 'system') {
      const toExists = Array.isArray(state.users) && state.users.some(u => u && !u._deleted && String(u.id) === toId);
      if (!toExists) throw new Error('Recipient not found');
    }

    const idem = Security.sanitizeInput(String(meta.idempotencyKey || '').trim(), { maxLength: 120 });
    if (idem) {
      const existing = walletFindByIdempotency(idem);
      if (existing) return existing;
    }

    const balMinor = WALLET.getBalanceMinor(fromId, currency);
    if (balMinor + 0 < amountMinor) throw new Error('Insufficient balance');

    const tx = {
      id: generateId('wtx'),
      type: String(meta.type || 'transfer'),
      schemaVersion: 2,
      amountMinor,
      currency,
      amount: walletFromMinor(amountMinor, currency),
      fromUserId: fromId,
      toUserId: toId,
      memo: Security.sanitizeInput(meta.memo || 'Transfer', { maxLength: 180 }),
      idempotencyKey: idem || undefined,
      status: 'posted',
      referenceType: meta.referenceType ? Security.sanitizeInput(meta.referenceType, { maxLength: 60 }) : undefined,
      referenceId: meta.referenceId ? Security.sanitizeInput(meta.referenceId, { maxLength: 120 }) : undefined,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.id || fromId,
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    addRecord(state.walletTransactions, tx);
    addAuditLog('wallet', tx.id, `Wallet transfer ${walletFormatMinor(amountMinor, currency)}`, { resourceType: 'walletTransactions', fromUserId: tx.fromUserId, toUserId: tx.toUserId });
    return tx;
  },
  // Create a compensating transaction (Admin-only) instead of editing history
  reverse: (transactionId, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    if (state.currentUser.role !== 'Admin') throw new Error('Admin only');
    const id = String(transactionId || '').trim();
    if (!id) throw new Error('Missing transaction id');
    const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
    const original = txs.find(t => t && !t._deleted && String(t.id) === id);
    if (!original) throw new Error('Transaction not found');
    const currency = walletTxCurrency(original);
    const amountMinor = walletTxAmountMinor(original);
    if (!amountMinor || amountMinor <= 0) throw new Error('Invalid original amount');
    const fromId = String(original.toUserId || 'system');
    const toId = String(original.fromUserId || 'system');
    const idem = `rev:${id}`;
    return WALLET.transfer(fromId, toId, 0, {
      type: 'reversal',
      amountMinor,
      currency,
      idempotencyKey: idem,
      memo: Security.sanitizeInput(meta.memo || `Reversal of ${id}`, { maxLength: 180 }),
      referenceType: 'reversalOf',
      referenceId: id
    });
  }
};

const SUBSCRIPTIONS = {
  // Service subscription records: { id, userId, serviceId, status, startedAt, expiresAt, price, currency }
  getActiveServiceIds: (userId) => {
    const uid = String(userId || '');
    if (!uid) return [];
    const now = Date.now();
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    const active = subs.filter(s =>
      s && !s._deleted &&
      s.userId === uid &&
      s.status === 'active' &&
      (!s.expiresAt || new Date(s.expiresAt).getTime() > now)
    );
    return Array.from(new Set(active.map(s => s.serviceId))).filter(Boolean);
  },
  isActive: (userId, serviceId) => {
    const sid = String(serviceId || '');
    if (!sid) return false;
    return SUBSCRIPTIONS.getActiveServiceIds(userId).includes(sid);
  },
  // Subscribe by paying from wallet (default monthly)
  subscribe: (userId, serviceId, opts = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const uid = String(userId || '');
    const sid = String(serviceId || '');
    if (!uid || !sid) throw new Error('Missing subscription data');
    const isAdmin = state.currentUser.role === 'Admin';
    if (!isAdmin && String(state.currentUser.id) !== uid) throw new Error('Forbidden');
    if (SUBSCRIPTIONS.isActive(uid, sid)) throw new Error('Already subscribed');

    const currency = walletNormalizeCurrency(opts.currency || WALLET.currency);
    const priceMinor = Number.isFinite(Number(opts.priceMinor))
      ? Math.trunc(Number(opts.priceMinor))
      : walletToMinor(Number(opts.price ?? 0), currency);
    const durationDays = Number(opts.durationDays ?? 30);
    if (!Number.isFinite(durationDays) || durationDays <= 0) throw new Error('Invalid duration');
    if (!Number.isFinite(priceMinor) || priceMinor < 0) throw new Error('Invalid price');

    const idem = Security.sanitizeInput(String(opts.idempotencyKey || '').trim(), { maxLength: 120 });
    // Idempotent subscribe: retry with same key must return the same subscription record
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    if (idem) {
      const existing = subs.find(s => s && !s._deleted && s.userId === uid && s.serviceId === sid && String(s.idempotencyKey || '') === idem);
      if (existing) return existing;
    }

    let paymentTx = null;
    if (priceMinor > 0) {
      // charge wallet (debit) by transferring to system account
      paymentTx = WALLET.transfer(uid, 'system', 0, {
        type: 'service_payment',
        amountMinor: priceMinor,
        currency,
        memo: `Subscription: ${sid}`,
        idempotencyKey: idem ? `subpay:${idem}` : undefined,
        referenceType: 'subscription',
        referenceId: sid
      });
    }

    const now = new Date();
    const expires = new Date(now.getTime() + durationDays * TIME_CONSTANTS.MILLISECONDS_PER_DAY);
    const rec = {
      id: generateId('sub'),
      userId: uid,
      serviceId: sid,
      status: 'active',
      startedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      priceMinor,
      // Keep a major value for convenience/debugging (NOT source of truth)
      price: walletFromMinor(priceMinor, currency),
      currency,
      paymentTxId: paymentTx?.id || undefined,
      idempotencyKey: idem || undefined,
      createdAt: now.toISOString(),
      createdBy: state.currentUser?.id || uid,
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    addRecord(state.serviceSubscriptions, rec);
    addAuditLog('subscription', rec.id, `Subscribed to ${sid} (${walletFormatMinor(priceMinor, currency)})`, { resourceType: 'serviceSubscriptions', serviceId: sid, userId: uid });
    return rec;
  },
  cancel: (userId, serviceId) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const uid = String(userId || '');
    const sid = String(serviceId || '');
    if (!uid || !sid) throw new Error('Missing subscription data');
    const isAdmin = state.currentUser.role === 'Admin';
    if (!isAdmin && String(state.currentUser.id) !== uid) throw new Error('Forbidden');

    const now = Date.now();
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    const active = subs.find(s =>
      s && !s._deleted &&
      s.userId === uid &&
      s.serviceId === sid &&
      s.status === 'active' &&
      (!s.expiresAt || new Date(s.expiresAt).getTime() > now)
    );
    if (!active?.id) throw new Error('No active subscription');

    const ts = new Date().toISOString();
    updateRecord(state.serviceSubscriptions, active.id, { status: 'canceled', canceledAt: ts, expiresAt: ts });
    addAuditLog('subscription', active.id, `Canceled ${sid}`, { resourceType: 'serviceSubscriptions', serviceId: sid, userId: uid });

    // Keep legacy user.subscriptions in sync (optional compatibility)
    const user = Array.isArray(state.users) ? state.users.find(u => u && !u._deleted && String(u.id) === uid) : null;
    const legacy = Array.isArray(user?.subscriptions) ? user.subscriptions.slice() : null;
    if (legacy && legacy.includes(sid)) {
      const next = legacy.filter(x => x !== sid);
      updateRecord(state.users, uid, { subscriptions: next });
    }
    return true;
  }
};

/** @type {AlbayanState} */
const state = {
  // Auth
  currentUser: null,
  currentView: 'services-hub', // Start at Services Hub
  isMobileMenuOpen: false,
  // Server mode (for multi-user internet deployments)
  serverMode: false,
  serverDetected: false, // runtime: whether a backend was detected
  serverModeOverride: 'auto', // 'auto' | 'local' | 'server'
  serverBaseUrl: '', // same-origin by default
  serverLastSyncAt: null,

  // Local Password Recovery (LOCAL MODE ONLY)
  // Stores a hash of the recovery key (never plaintext). Used for "Forgot password" in local mode.
  // Shape: { hash, salt, algo, iterations, createdAt }
  localRecovery: null,
  
  // UI
  language: 'en',
  theme: 'light',
  
  // Data
  // IMPORTANT: do NOT ship hardcoded credentials in a public website.
  // In serverMode, users come from the backend. Offline mode can import users via backup.
  users: [],
  
  ads: [],
  receipts: [],
  customers: [],
  pages: [],
  logs: [],
  walletTransactions: [], // ledger entries (huge-data safe via IndexedDB)
  serviceSubscriptions: [], // structured subscriptions (huge-data safe via IndexedDB)
  
  // Settings
  defaultExchangeRate: 0,
  exchangeRateHistory: [],
  
  // Cloud Sync
  cloudConfig: {
    enabled: false,
    endpoint: '',
    apiKey: ''
  },
  cloudSyncStatus: 'idle',
  lastCloudSync: null,
  
  // UI State
  commandPaletteOpen: false,
  activeModal: null,
  modalData: null,
  viewData: null,
  
  // Customer Filters
  customerSearch: '',
  customerSort: 'newest',
  customerFinancialFilter: 'all',
  
  // Receipt Filters
  receiptSearch: '',
  receiptStatusFilter: 'all',
  receiptPaymentFilter: 'all',
  receiptDateFilter: 'all',
  receiptCollectedFilter: 'all',
  receiptSortBy: 'newest',
  
  // Audit Log Filters & Pagination
  auditSearch: '',
  auditActionFilter: 'all',
  auditCategoryFilter: 'all',
  auditSeverityFilter: 'all',
  auditUserFilter: 'all',
  auditDateFrom: '',
  auditDateTo: '',
  auditPage: 1,
  auditPageSize: 25,

  // Delivery dashboard (Delivery role)
  deliveryDashboardFilterStatus: 'all' // 'all' | 'Needs Delivery' | 'In Progress' | 'Delivered' | 'Collected'
};

// ==========================================
// LOCALSTORAGE PERSISTENCE
// ==========================================

// Maximum logs to store in localStorage (the rest stay in IndexedDB only)
const MAX_LOGS_IN_LOCALSTORAGE = 500;

// Large collections are stored in IndexedDB for huge data support
const PERSISTED_COLLECTIONS = [
  'ads',
  'receipts',
  'customers',
  'pages',
  'users',
  'exchangeRateHistory',
  // Platform foundation (future‑proof)
  'walletTransactions',
  'serviceSubscriptions'
];

// Debounced IndexedDB sync (avoid writing huge arrays on every keystroke)
const idbSync = {
  dirty: new Set(),
  timer: null,
  flushing: false,
  debounceMs: 800
};

function getCollectionNameFromArray(array) {
  if (array === state.ads) return 'ads';
  if (array === state.receipts) return 'receipts';
  if (array === state.customers) return 'customers';
  if (array === state.pages) return 'pages';
  if (array === state.users) return 'users';
  if (array === state.exchangeRateHistory) return 'exchangeRateHistory';
  if (array === state.walletTransactions) return 'walletTransactions';
  if (array === state.serviceSubscriptions) return 'serviceSubscriptions';
  return null;
}

function markCollectionDirty(collectionName) {
  if (!db) return;
  if (!collectionName || !PERSISTED_COLLECTIONS.includes(collectionName)) return;
  idbSync.dirty.add(collectionName);

  if (idbSync.timer) clearTimeout(idbSync.timer);
  idbSync.timer = setTimeout(() => {
    flushDirtyCollections().catch((e) => console.warn('IndexedDB flush error:', e));
  }, idbSync.debounceMs);
}

function markAllCollectionsDirty() {
  for (const name of PERSISTED_COLLECTIONS) markCollectionDirty(name);
}

async function flushDirtyCollections() {
  if (!db || idbSync.flushing) return;
  if (idbSync.dirty.size === 0) return;

  idbSync.flushing = true;
  const toFlush = Array.from(idbSync.dirty);
  idbSync.dirty.clear();

  try {
    for (const name of toFlush) {
      await saveCollectionToIndexedDB(name, state[name]);
    }
  } finally {
    idbSync.flushing = false;
  }
}

function saveState() {
  try {
    // Create a copy of state with optimized log storage
    // Keep only recent logs in localStorage, all logs are in IndexedDB
    const logsForStorage = db ? state.logs.slice(0, MAX_LOGS_IN_LOCALSTORAGE) : state.logs;
    
    const toSave = { ...state };
    toSave.logs = logsForStorage; // Only store recent logs in localStorage
    // Never persist full user object in localStorage (sessionStorage is the source of truth)
    delete toSave.currentUser;
    // Persist large collections in IndexedDB only
    for (const key of PERSISTED_COLLECTIONS) {
      delete toSave[key];
    }
    // Mark metadata for migration/debugging
    toSave._storageVersion = 2;
    toSave._persistedAt = new Date().toISOString();
    // Avoid persisting runtime-only UI fields
    delete toSave.isMobileMenuOpen;
    delete toSave.commandPaletteOpen;
    delete toSave.activeModal;
    delete toSave.modalData;
    delete toSave.tempAdFunding;
    delete toSave.tempAdPhotos;
    
    // Sanitize before persistence (defense-in-depth)
    const sanitizedToSave = Security.sanitizeObject(toSave);
    const dataString = JSON.stringify(sanitizedToSave);
    
    // Check if approaching localStorage limit (typically 5-10MB)
    const sizeInMB = new Blob([dataString]).size / (1024 * 1024);
    if (sizeInMB > 4) {
      console.warn(`LocalStorage data size: ${sizeInMB.toFixed(2)}MB - approaching limit`);
      // Further reduce logs if needed
      sanitizedToSave.logs = state.logs.slice(0, 100);
    }
    
    localStorage.setItem('albayan_complete_state', JSON.stringify(sanitizedToSave));
  } catch (error) {
    console.error('Error saving state:', error);
    
    // If quota exceeded, try with fewer logs
    if (error.name === 'QuotaExceededError' || error.message.includes('quota')) {
      try {
        const reducedSave = Security.sanitizeObject({
          language: state.language,
          theme: state.theme,
          currentView: state.currentView,
          logs: state.logs.slice(0, 50),
          defaultExchangeRate: state.defaultExchangeRate,
          cloudConfig: state.cloudConfig,
          _storageVersion: 2,
          _persistedAt: new Date().toISOString()
        });
        localStorage.setItem('albayan_complete_state', JSON.stringify(reducedSave));
      } catch (e) {
        // Suppress notification: quota exceeded is not critical (data is in IndexedDB + server)
      }
    } else {
      // Only show error for non-quota issues
    }
  }
}

// PERFORMANCE: Debounced saveState to avoid blocking UI during rapid navigation
let _saveStateTimer = null;
function debouncedSaveState() {
  if (_saveStateTimer) clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(() => {
    _saveStateTimer = null;
    saveState();
  }, 300); // Save after 300ms of inactivity
}

function loadState() {
  try {
    const saved = localStorage.getItem('albayan_complete_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      
      // Sanitize loaded data to prevent XSS from corrupted storage
      const sanitizedData = Security.sanitizeObject(parsed);

      // Extract legacy large collections (older versions stored everything in localStorage)
      const legacyCollections = {
        ads: Array.isArray(sanitizedData.ads) ? sanitizedData.ads : null,
        receipts: Array.isArray(sanitizedData.receipts) ? sanitizedData.receipts : null,
        customers: Array.isArray(sanitizedData.customers) ? sanitizedData.customers : null,
        pages: Array.isArray(sanitizedData.pages) ? sanitizedData.pages : null,
        users: Array.isArray(sanitizedData.users) ? sanitizedData.users : null,
        exchangeRateHistory: Array.isArray(sanitizedData.exchangeRateHistory) ? sanitizedData.exchangeRateHistory : null
      };
      // Do not merge large collections from localStorage into runtime state (they belong in IndexedDB)
      for (const key of PERSISTED_COLLECTIONS) delete sanitizedData[key];
      
      // Merge saved state but keep runtime-only properties
      Object.assign(state, sanitizedData, {
        isMobileMenuOpen: false,
        commandPaletteOpen: false,
        activeModal: null,
        modalData: null
      });
      
      // Ensure arrays exist (for backwards compatibility)
      if (!Array.isArray(state.receipts)) state.receipts = [];
      if (!Array.isArray(state.ads)) state.ads = [];
      if (!Array.isArray(state.customers)) state.customers = [];
      if (!Array.isArray(state.pages)) state.pages = [];
      if (!Array.isArray(state.logs)) state.logs = [];
      if (!Array.isArray(state.users)) state.users = [];
      if (!Array.isArray(state.exchangeRateHistory)) state.exchangeRateHistory = [];
      if (!Array.isArray(state.walletTransactions)) state.walletTransactions = [];
      if (!Array.isArray(state.serviceSubscriptions)) state.serviceSubscriptions = [];
      
      // Validate language (must be 'en' or 'ar')
      if (state.language !== 'en' && state.language !== 'ar') {
        state.language = 'en';
      }
      
      // Validate theme (must be 'light', 'dark', or 'system')
      if (state.theme !== 'light' && state.theme !== 'dark' && state.theme !== 'system') {
        state.theme = 'light';
      }
      
      // Migrate receipts from ads array to receipts array (backwards compatibility)
      const receiptsInAds = state.ads.filter(a => a.recordType === 'receipt');
      if (receiptsInAds.length > 0) {
        receiptsInAds.forEach(r => {
          if (!state.receipts.find(existing => existing.id === r.id)) {
            state.receipts.push(r);
          }
        });
        // Remove receipts from ads array
        state.ads = state.ads.filter(a => a.recordType !== 'receipt');
        saveState();
      }
      
      // Validate session if user is logged in
      if (state.currentUser && !SessionManager.isAuthenticated()) {
        state.currentUser = null; // Session expired, log out
      }

      return legacyCollections;
    }
  } catch (error) {
    console.error('Error loading state:', error);
    // Log security event for potential data tampering
    addSecurityLog('data_load_error', error.message);
  }
  return null;
}

// Security logging for suspicious activities
function addSecurityLog(type, details) {
  const log = {
    id: Security.generateSecureId('security'),
    type,
    details: Security.sanitizeInput(details),
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent
  };
  
  // Store in a separate security log
  try {
    const securityLogs = JSON.parse(localStorage.getItem('albayan_security_logs') || '[]');
    securityLogs.unshift(log);
    // BEST PRACTICE: Use constant for limit
    if (securityLogs.length > LIMIT_CONSTANTS.MAX_SECURITY_LOGS) securityLogs.length = LIMIT_CONSTANTS.MAX_SECURITY_LOGS;
    localStorage.setItem('albayan_security_logs', JSON.stringify(securityLogs));
  } catch (e) {
    console.error('Failed to log security event:', e);
  }
}

// ==========================================
// DATA LOADING, MIGRATION, SANITIZATION (IndexedDB-first)
// ==========================================

function normalizeReceiptsFromAds() {
  if (!Array.isArray(state.ads)) state.ads = [];
  if (!Array.isArray(state.receipts)) state.receipts = [];

  const receiptsInAds = state.ads.filter(a => a && a.recordType === 'receipt');
  if (receiptsInAds.length === 0) return false;

  for (const r of receiptsInAds) {
    if (!state.receipts.find(existing => existing.id === r.id)) {
      state.receipts.push(r);
    }
  }
  state.ads = state.ads.filter(a => !a || a.recordType !== 'receipt');
  return true;
}

async function loadCollectionsFromStorage(legacyCollections = null) {
  const legacy = legacyCollections || {};

  for (const name of PERSISTED_COLLECTIONS) {
    let loaded = null;

    if (db) {
      loaded = await loadCollectionFromIndexedDB(name);
    }

    if (loaded !== null && loaded !== undefined) {
      state[name] = loaded;
    } else if (Array.isArray(legacy[name])) {
      // Legacy migration path: seed IndexedDB from localStorage snapshot
      state[name] = legacy[name];
      if (db) {
        await saveCollectionToIndexedDB(name, state[name]);
      }
    } else {
      if (!Array.isArray(state[name])) state[name] = [];
    }
  }

  // Backwards compatibility: receipts used to be stored in ads[]
  const normalized = normalizeReceiptsFromAds();
  if (normalized && db) {
    await saveCollectionToIndexedDB('ads', state.ads);
    await saveCollectionToIndexedDB('receipts', state.receipts);
  }

  // Persist cleaned localStorage snapshot (drops large arrays)
  saveState();
}

async function sanitizeCollectionInPlace(collectionName) {
  const arr = state[collectionName];
  if (!Array.isArray(arr) || arr.length === 0) return;

  const chunk = 500;
  for (let i = 0; i < arr.length; i += chunk) {
    const end = Math.min(i + chunk, arr.length);
    for (let j = i; j < end; j++) {
      const item = arr[j];
      if (item && typeof item === 'object') {
        arr[j] = Security.sanitizeObject(item);
      } else if (typeof item === 'string') {
        arr[j] = Security.sanitizeInput(item);
      }
    }
    // Yield to keep UI responsive
    await new Promise(r => setTimeout(r, 0));
  }
}

async function sanitizeAllCollectionsForRendering() {
  for (const name of PERSISTED_COLLECTIONS) {
    await sanitizeCollectionInPlace(name);
  }
}

// ==========================================
// DATA MIGRATION: Normalize old records
// ==========================================
// Ensures old data has all required fields so new features work correctly
function migrateOldDataFormats() {
  let changed = false;

  // Migrate Receipts - ALWAYS process ALL receipts (including old data)
  if (Array.isArray(state.receipts)) {
    for (const receipt of state.receipts) {
      if (!receipt) continue;
      // Process even deleted records to ensure data consistency

      // Ensure receipt has isPaid boolean
      if (receipt.isPaid === undefined) {
        const status = String(receipt.status || '').toLowerCase();
        receipt.isPaid = (status === 'paid');
        changed = true;
      }

      // Ensure receipt has amountUSD/amountLocal
      if (receipt.amountUSD === undefined && receipt.amount !== undefined) {
        receipt.amountUSD = parseFloat(receipt.amount) || 0;
        changed = true;
      }
      if (receipt.amountLocal === undefined && receipt.amountLYD !== undefined) {
        receipt.amountLocal = parseFloat(receipt.amountLYD) || 0;
        changed = true;
      }

      // Ensure serialNumber is consistent with finalReceiptNo
      if (!receipt.serialNumber && receipt.finalReceiptNo) {
        receipt.serialNumber = receipt.finalReceiptNo;
        changed = true;
      }

      // Normalize createdAt
      if (!receipt.createdAt && receipt.startDate) {
        receipt.createdAt = receipt.startDate;
        changed = true;
      }

      // Fix delivery status - ensure it's a valid status
      if (receipt.deliveryStatus) {
        const validStatuses = ['Office', 'Needs Delivery', 'In Progress', 'Delivered', 'Canceled'];
        if (!validStatuses.includes(receipt.deliveryStatus)) {
          receipt.deliveryStatus = 'Office';
          changed = true;
        }
      }

      // Ensure exchangeRate is a number
      if (receipt.exchangeRate !== undefined && typeof receipt.exchangeRate !== 'number') {
        receipt.exchangeRate = parseFloat(receipt.exchangeRate) || state.defaultExchangeRate || 1;
        changed = true;
      }

      // Ensure editHistory is an array
      if (receipt.editHistory && !Array.isArray(receipt.editHistory)) {
        receipt.editHistory = [];
        changed = true;
      }
      if (typeof receipt.editCount !== 'number') {
        receipt.editCount = Array.isArray(receipt.editHistory) ? receipt.editHistory.length : 0;
        changed = true;
      }
    }
  }

  // Migrate Ads - ALWAYS process ALL ads (including old data)
  if (Array.isArray(state.ads)) {
    for (const ad of state.ads) {
      if (!ad) continue;

      // Ensure ad has receiptAllocations array
      if (!Array.isArray(ad.receiptAllocations)) {
        ad.receiptAllocations = [];

        // Migrate old single-receipt linking to receiptAllocations
        const linkedReceiptId = ad.fundingReceiptId || ad.receiptId;
        if (linkedReceiptId && (ad.amountUSD || ad.spentUSD)) {
          ad.receiptAllocations.push({
            receiptId: String(linkedReceiptId),
            amountUSD: ad.spentUSD || ad.amountUSD || 0
          });
          changed = true;
        }
      }

      // Normalize string IDs in receiptAllocations
      if (Array.isArray(ad.receiptAllocations)) {
        for (const alloc of ad.receiptAllocations) {
          if (alloc && alloc.receiptId) {
            alloc.receiptId = String(alloc.receiptId);
          }
        }
      }

      // Ensure dueAllocations array exists
      if (!Array.isArray(ad.dueAllocations)) {
        ad.dueAllocations = [];
        // Migrate from linkedDeliveryReceiptId if present
        if (ad.linkedDeliveryReceiptId && !ad.isPaid) {
          ad.dueAllocations.push({
            receiptId: String(ad.linkedDeliveryReceiptId),
            amountUSD: ad.amountUSD || 0
          });
          changed = true;
        }
      }

      // Ensure ad has customerId
      if (!ad.customerId && ad.customer) {
        ad.customerId = ad.customer;
        changed = true;
      }

      // Ensure ad has pageId
      if (!ad.pageId && ad.page) {
        ad.pageId = ad.page;
        changed = true;
      }

      // Normalize createdAt
      if (!ad.createdAt && ad.startDate) {
        ad.createdAt = ad.startDate;
        changed = true;
      }

      // Fix delivery status
      if (ad.deliveryStatus) {
        const validStatuses = ['Office', 'Needs Delivery', 'In Progress', 'Delivered', 'Canceled'];
        if (!validStatuses.includes(ad.deliveryStatus)) {
          ad.deliveryStatus = 'Office';
          changed = true;
        }
      }
    }
  }

  // Migrate Customers - ALWAYS process ALL customers
  if (Array.isArray(state.customers)) {
    for (const customer of state.customers) {
      if (!customer) continue;

      // Ensure phones is an array
      if (!Array.isArray(customer.phones)) {
        if (customer.phone) {
          customer.phones = [customer.phone];
        } else {
          customer.phones = [];
        }
        changed = true;
      }

      // Ensure name exists
      if (!customer.name) {
        customer.name = 'Unknown';
        changed = true;
      }
    }
  }

  // Migrate Pages - ALWAYS process ALL pages
  if (Array.isArray(state.pages)) {
    for (const page of state.pages) {
      if (!page) continue;

      // Ensure customerIds is an array
      if (!Array.isArray(page.customerIds)) {
        if (page.customerId) {
          page.customerIds = [page.customerId];
        } else {
          page.customerIds = [];
        }
        changed = true;
      }

      // Ensure name exists
      if (!page.name) {
        page.name = 'Unnamed Page';
        changed = true;
      }
    }
  }

  // Assign sequential numbers to all records
  assignSequentialNumbers();

  if (changed) {
    console.log('[Migration] Data formats updated for ALL records');
    markAllCollectionsDirty();
    // Save immediately to persist migrations
    saveState();
  }

  return changed;
}

// ==========================================
// SEQUENTIAL NUMBERING: Assign display numbers
// ==========================================
// Assigns sequential numbers (1, 2, 3...) to records based on creation order
// PERFORMANCE: Only assigns if missing, uses cached sort when possible
let _seqNoCache = {
  ads: null,
  receipts: null,
  customers: null,
  pages: null,
  lastUpdate: 0
};

function assignSequentialNumbers(force = false) {
  const now = Date.now();
  // Only recalculate if forced or cache is stale (>5 seconds old)
  if (!force && (now - _seqNoCache.lastUpdate) < 5000 && _seqNoCache.ads !== null) {
    return; // Use cached numbers
  }
  
  // Helper to sort by creation time (optimized - cache timestamps)
  const getTime = (item) => {
    if (item._cachedTime !== undefined) return item._cachedTime;
    const time = new Date(item.createdAt || item.startDate || item._created || 0).getTime();
    item._cachedTime = time; // Cache for next sort
    return time;
  };
  
  const sortByCreated = (a, b) => getTime(a) - getTime(b);
  
  // Assign numbers to Ads (only if missing or forced)
  if (Array.isArray(state.ads)) {
    const visible = getVisibleRecords(state.ads);
    const needsUpdate = force || visible.some(ad => !ad._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((ad, idx) => {
        ad._seqNo = idx + 1;
      });
      _seqNoCache.ads = sorted.length;
    }
  }
  
  // Assign numbers to Receipts
  if (Array.isArray(state.receipts)) {
    const visible = getVisibleRecords(state.receipts);
    const needsUpdate = force || visible.some(r => !r._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((receipt, idx) => {
        receipt._seqNo = idx + 1;
      });
      _seqNoCache.receipts = sorted.length;
    }
  }
  
  // Assign numbers to Customers
  if (Array.isArray(state.customers)) {
    const visible = getVisibleRecords(state.customers);
    const needsUpdate = force || visible.some(c => !c._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((customer, idx) => {
        customer._seqNo = idx + 1;
      });
      _seqNoCache.customers = sorted.length;
    }
  }
  
  // Assign numbers to Pages
  if (Array.isArray(state.pages)) {
    const visible = getVisibleRecords(state.pages);
    const needsUpdate = force || visible.some(p => !p._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((page, idx) => {
        page._seqNo = idx + 1;
      });
      _seqNoCache.pages = sorted.length;
    }
  }
  
  _seqNoCache.lastUpdate = now;
}

// Get display number for a record
function getRecordDisplayNumber(record) {
  if (!record) return '';
  return record._seqNo ? `#${record._seqNo}` : '';
}

async function ensureUsersHavePasswordHashes() {
  if (!Array.isArray(state.users)) return;

  let changed = false;
  for (const user of state.users) {
    if (!user || user._deleted) continue;

    // If user has a plaintext password (legacy), migrate immediately
    if (!user.passwordHash && user.password) {
      const hashed = await Security.hashPassword(user.password, null, { algo: 'pbkdf2-sha256' });
      user.passwordHash = hashed.hash;
      user.salt = hashed.salt;
      user.passwordAlgo = hashed.algo;
      user.passwordIterations = hashed.iterations;
      delete user.password;
      changed = true;
      continue;
    }

    // Normalize algorithm metadata for existing hashes
    if (user.passwordHash && user.salt && !user.passwordAlgo) {
      user.passwordAlgo = 'sha256'; // legacy default
      changed = true;
    }
    if (user.passwordAlgo === 'pbkdf2-sha256' && !user.passwordIterations) {
      user.passwordIterations = 310000;
      changed = true;
    }
  }

  if (changed) {
    markCollectionDirty('users');
    saveState();
    await flushDirtyCollections();
  }
}

// ==========================================
// TRANSLATIONS
// ==========================================

const translations = {
  en: {
    appName: 'Albayan',
    adManager: 'Albayan Manager',
    signInTitle: 'Sign In to Continue',
    email: 'Email Address',
    password: 'Password',
    loginButton: 'Sign In',
    forgotPassword: 'Forgot password?',
    resetPassword: 'Reset Password',
    resetCode: 'Reset Code',
    sendResetCode: 'Send Reset Code',
    recoveryKey: 'Recovery Key',
    newPassword: 'New Password',
    confirmPassword: 'Confirm Password',
    currentPassword: 'Current Password',
    changePassword: 'Change Password',
    security: 'Security',
    generateRecoveryKey: 'Generate Recovery Key',
    logout: 'Logout',
    analytics: 'Analytics',
    dashboard: 'Dashboard',
    ads: 'Ads',
    receipts: 'Receipts',
    users: 'Users',
    customers: 'Customers',
    pages: 'Pages',
    deliveries: 'Deliveries',
    auditLogs: 'Audit Logs',
    settings: 'Settings',
    jobReconciliation: 'Reconciliation',
    totalRevenue: 'Total Revenue',
    totalAds: 'Total Ads',
    pendingAds: 'Pending',
    completedAds: 'Completed',
    welcome: 'Welcome',
    addCustomer: 'Add Customer',
    addAd: 'Add Ad',
    addReceipt: 'Add Receipt',
    addUser: 'Add User',
    addPage: 'Add Page',
    name: 'Name',
    phone: 'Phone',
    platform: 'Platform',
    amount: 'Amount',
    exchangeRate: 'Exchange Rate',
    status: 'Status',
    actions: 'Actions',
    delete: 'Delete',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    search: 'Search',
    filter: 'Filter',
    export: 'Export',
    import: 'Import',
    print: 'Print',
    wallet: 'Wallet',
    balance: 'Balance',
    transfer: 'Transfer',
    topUp: 'Top Up',
    transactions: 'Transactions',
    note: 'Note',
    recipient: 'Recipient',
    send: 'Send',
  },
  ar: {
    appName: 'البيان',
    adManager: 'مدير البيان',
    signInTitle: 'تسجيل الدخول للمتابعة',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    loginButton: 'تسجيل الدخول',
    forgotPassword: 'نسيت كلمة المرور؟',
    resetPassword: 'إعادة تعيين كلمة المرور',
    resetCode: 'رمز الاستعادة',
    sendResetCode: 'إرسال رمز الاستعادة',
    recoveryKey: 'مفتاح الاستعادة',
    newPassword: 'كلمة مرور جديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    currentPassword: 'كلمة المرور الحالية',
    changePassword: 'تغيير كلمة المرور',
    security: 'الأمان',
    generateRecoveryKey: 'إنشاء مفتاح استعادة',
    logout: 'تسجيل خروج',
    analytics: 'التحليلات',
    dashboard: 'لوحة التحكم',
    ads: 'الإعلانات',
    receipts: 'الإيصالات',
    users: 'المستخدمين',
    customers: 'العملاء',
    pages: 'الصفحات',
    deliveries: 'التوصيل',
    auditLogs: 'سجل التدقيق',
    settings: 'الإعدادات',
    jobReconciliation: 'التسوية',
    totalRevenue: 'إجمالي الإيرادات',
    totalAds: 'إجمالي الإعلانات',
    pendingAds: 'المعلقة',
    completedAds: 'المكتملة',
    welcome: 'مرحبا',
    addCustomer: 'إضافة عميل',
    addAd: 'إضافة إعلان',
    addReceipt: 'إضافة إيصال',
    addUser: 'إضافة مستخدم',
    addPage: 'إضافة صفحة',
    name: 'الاسم',
    phone: 'الهاتف',
    platform: 'المنصة',
    amount: 'المبلغ',
    exchangeRate: 'سعر الصرف',
    status: 'الحالة',
    actions: 'الإجراءات',
    delete: 'حذف',
    edit: 'تعديل',
    save: 'حفظ',
    cancel: 'إلغاء',
    search: 'بحث',
    filter: 'تصفية',
    export: 'تصدير',
    import: 'استيراد',
    print: 'طباعة',
    wallet: 'المحفظة',
    balance: 'الرصيد',
    transfer: 'تحويل',
    topUp: 'شحن',
    transactions: 'المعاملات',
    note: 'ملاحظة',
    recipient: 'المستلم',
    send: 'إرسال',
  }
};

function getTodayDateString() {
  const d = new Date();
  return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
}

function t(key) {
  const lang = translations[state.language] || translations['en'];
  return lang[key] || key;
}

function getDir() {
  return state.language === 'ar' ? 'rtl' : 'ltr';
}

// ==========================================
// THEME MANAGEMENT
// ==========================================

function applyTheme() {
  const root = document.documentElement;
  const isDark = state.theme === 'dark' || 
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

function toggleTheme() {
  const themes = ['light', 'dark', 'system'];
  const currentIndex = themes.indexOf(state.theme);
  state.theme = themes[(currentIndex + 1) % themes.length];
  applyTheme();
  saveState();
  render();
}

function toggleLanguage() {
  state.language = state.language === 'en' ? 'ar' : 'en';
  document.documentElement.setAttribute('dir', getDir());
  saveState();
  render();
}

// ==========================================
// PERFORMANCE: Smooth Scrolling Mode + Optimized Rendering
// ==========================================
let _scrollPerfInit = false;
let _scrollRafId = null;
function setupScrollPerformanceMode() {
  if (_scrollPerfInit) return;
  _scrollPerfInit = true;
  let timer = null;
  const onScroll = () => {
    if (!document.body) return;
    // Use RAF for smoother class toggling
    if (_scrollRafId) cancelAnimationFrame(_scrollRafId);
    _scrollRafId = requestAnimationFrame(() => {
    document.body.classList.add('is-scrolling');
    });
    if (timer) clearTimeout(timer);
    // Longer debounce (250ms) prevents rapid on/off toggling during momentum scroll
    timer = setTimeout(() => {
      document.body.classList.remove('is-scrolling');
    }, 250);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
}

// ==========================================
// PERFORMANCE: Scoped Lucide Icon Creation
// ==========================================
// Instead of scanning entire DOM, only scan a specific container
function scopedCreateIcons(container) {
  if (!window.lucide) return;
  try {
    if (container && container instanceof Element) {
      // Scope to container only - much faster than full DOM scan
      lucide.createIcons({ nodes: container.querySelectorAll('[data-lucide]') });
    } else {
      // Fallback to full scan (use sparingly)
      lucide.createIcons();
    }
  } catch (e) {
    // Ignore lucide errors
  }
}

// Debounced icon refresh (batches multiple calls)
const IconQueue = {
  pending: new Set(),
  timer: null,
  flush() {
    if (!window.lucide) return;
    const containers = Array.from(IconQueue.pending);
    IconQueue.pending.clear();
    IconQueue.timer = null;
    requestAnimationFrame(() => {
      if (containers.length === 0 || containers.includes(null)) {
        // Full scan needed
        lucide.createIcons();
      } else {
        // Scoped scan - much faster
        for (const c of containers) {
          if (c instanceof Element) {
            lucide.createIcons({ nodes: c.querySelectorAll('[data-lucide]') });
          }
        }
      }
    });
  },
  schedule(container = null) {
    IconQueue.pending.add(container);
    if (IconQueue.timer) return;
    IconQueue.timer = setTimeout(() => IconQueue.flush(), 16); // ~1 frame
  }
};

// Debounced render to avoid "missing updates" without forcing hard refreshes.
const RenderQueue = {
  timer: null,
  rafId: null,
  lastRenderTime: 0,
  minIntervalMs: 50, // Reduced to 50ms for snappier UI (was 100ms)
  schedule(reason = '') {
    if (RenderQueue.timer) return;
    const now = Date.now();
    const elapsed = now - RenderQueue.lastRenderTime;
    const delay = Math.max(0, RenderQueue.minIntervalMs - elapsed);
    RenderQueue.timer = setTimeout(() => {
      RenderQueue.timer = null;
      // Skip render while scrolling (causes jank)
      if (document.body?.classList?.contains('is-scrolling')) {
        RenderQueue.schedule(reason);
        return;
      }
      // Skip render if another render is in progress
      if (_renderInProgress) {
        RenderQueue.schedule(reason);
        return;
      }
      // Use RAF for smoother visual updates
      if (RenderQueue.rafId) cancelAnimationFrame(RenderQueue.rafId);
      RenderQueue.rafId = requestAnimationFrame(() => {
        RenderQueue.rafId = null;
        RenderQueue.lastRenderTime = Date.now();
        try {
          render();
        } catch (e) {
          console.warn('RenderQueue failed:', reason, e);
        }
      });
    }, delay);
  }
};

// ==========================================
// NOTIFICATIONS
// ==========================================

function showNotification(title, message, type = 'info') {
  // #region agent log
  // Hypothesis H-NOLOG: user can reproduce issue but we see no NDJSON logs; capture error/warn toasts to pinpoint.
  try {
    if ((type === 'error' || type === 'warning') && typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-NOLOG', 'script.js:showNotification', 'toast', {
        type: String(type || '').slice(0, 16),
        title: String(title || '').slice(0, 120),
        message: String(message || '').slice(0, 240),
      });
    }
  } catch (_) {}
  // #endregion

  const container = document.getElementById('notification-container');
  const notification = document.createElement('div');
  notification.className = `notification-enter glass-panel px-4 py-3 rounded-xl shadow-lg flex items-start space-x-3 mb-2 ${
    type === 'success' ? 'border-l-4 border-green-500' :
    type === 'error' ? 'border-l-4 border-red-500' :
    type === 'warning' ? 'border-l-4 border-yellow-500' :
    'border-l-4 border-blue-500'
  }`;
  
  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };
  
  // Escape title and message to prevent XSS
  const safeTitle = Security.escapeHtml(title);
  const safeMessage = Security.escapeHtml(message);
  
  notification.innerHTML = `
    <div class="text-2xl">${icons[type]}</div>
    <div class="flex-1 min-w-0">
      <div class="font-bold text-sm truncate">${safeTitle}</div>
      <div class="text-xs opacity-80 break-words">${safeMessage}</div>
    </div>
    <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors">
      <i data-lucide="x" class="w-4 h-4"></i>
    </button>
  `;
  
  container.appendChild(notification);
  IconQueue.schedule(notification);
  
  setTimeout(() => {
    notification.classList.remove('notification-enter');
    notification.classList.add('notification-exit');
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

// ==========================================
// DATA HELPERS
// ==========================================

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getMonotonicTime() {
  return Date.now();
}

/**
 * Add a new record to a collection (receipts, ads, customers, etc.).
 * 
 * Features:
 *   - Automatic ID generation if not provided
 *   - Security sanitization of all data
 *   - Server write-through in online mode
 *   - Rollback on server failure
 *   - Audit logging
 * 
 * @param {Array} array - State collection array (e.g., state.receipts)
 * @param {Object} record - Record data to add
 * 
 * Flow:
 *   1. Sanitize input data (prevent XSS/injection)
 *   2. Generate secure ID if missing
 *   3. Set timestamps and metadata
 *   4. Add to local state (optimistic)
 *   5. Sync to server (if enabled)
 *   6. On success: keep local record
 *   7. On failure: rollback local record + show error
 * 
 * Thread Safety:
 *   - Optimistic updates for fast UI
 *   - Server-side validation catches conflicts
 *   - Automatic rollback prevents data loss
 */
function addRecord(array, record) {
  const collectionName = getCollectionNameFromArray(array);
  const cleanRecord = Security.sanitizeObject(record);
  if (!cleanRecord.id) cleanRecord.id = Security.generateSecureId(collectionName || 'id');

  cleanRecord._lastModified = getMonotonicTime();
  cleanRecord._deleted = false;
  if (!cleanRecord._created) cleanRecord._created = getMonotonicTime();
  if (!cleanRecord.createdBy && state.currentUser?.id) cleanRecord.createdBy = state.currentUser.id;

  array.unshift(cleanRecord);
  if (collectionName) markCollectionDirty(collectionName);
  saveState();
  addAuditLog('Create', cleanRecord.id || 'Unknown', `Created new ${getRecordType(cleanRecord)}`);
  RenderQueue.schedule('addRecord');

  // Server write-through (always-online multi-user mode)
  if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
    const id = cleanRecord.id;
    apiCreateEntity(collectionName, cleanRecord)
      .then((entity) => {
        if (entity?.data && entity?.id) {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) {
            array[idx] = Security.sanitizeObject(entity.data);
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
          }
        }
      })
      .catch((e) => {
        // Rollback on failure
        const idx = array.findIndex(x => x && x.id === id);
        if (idx !== -1) array.splice(idx, 1);
        if (collectionName) markCollectionDirty(collectionName);
        saveState();
        // Handle 401 - session expired, prompt re-login
        if (e?.status === 401) {
          showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
          // Clear cached session to force re-auth on next action
          _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
        } else {
          showNotification('Server Error', `Failed to create ${collectionName}: ${e.message || 'Error'}`, 'error');
        }
      });
  } else if (isServerModeEnabled() && collectionName === 'users') {
    // Creating users requires server-side password handling; this path should not be used.
    showNotification('Server Mode', 'Create users from the server-backed Users screen (Admin only).', 'warning');
  }
}

/**
 * Update an existing record in a collection (merge semantics).
 * 
 * Features:
 *   - Merge updates into existing record (partial updates supported)
 *   - Protected fields cannot be changed (id, timestamps, ownership)
 *   - Security sanitization
 *   - Server write-through with optimistic concurrency control
 *   - Automatic rollback on conflicts or errors
 *   - Permission checks (e.g., users can't edit other users unless admin)
 * 
 * @param {Array} array - State collection array
 * @param {string} id - Record ID to update
 * @param {Object} updates - Fields to update (merged with existing data)
 * 
 * Flow:
 *   1. Find record by ID
 *   2. Sanitize updates
 *   3. Remove protected fields
 *   4. Apply updates locally (optimistic)
 *   5. Sync to server with expectedLastModified (for conflict detection)
 *   6. On success: use server version (authoritative)
 *   7. On conflict (409): reload latest from server
 *   8. On error: rollback to old version
 * 
 * Immutability Rules:
 *   - walletTransactions: Cannot be edited (immutable for audit trail)
 *   - Users: Non-admin users cannot edit role/permissions
 * 
 * Concurrency:
 *   - Uses optimistic locking (expectedLastModified timestamp)
 *   - Prevents lost updates in multi-user scenarios
 */
function updateRecord(array, id, updates) {
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const old = { ...array[index] };
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions are immutable. Create a new transaction to correct mistakes.', 'error');
      return;
    }

    const sanitizedUpdates = Security.sanitizeObject(updates);
    // Never allow changing protected fields
    const protectedFields = ['id', '_created', 'createdBy', 'createdAt', 'creatorId'];
    for (const field of protectedFields) {
      if (sanitizedUpdates[field] !== undefined) delete sanitizedUpdates[field];
    }
    // Users: only Admin can change access-control fields (role/permissions/subscriptions).
    // Non-admin users may update their own profile fields (e.g., name/password/passkeys), but not privilege fields.
    if (collectionName === 'users' && state.currentUser && state.currentUser.role !== 'Admin') {
      const isSelf = String(state.currentUser.id || '') === String(id || '');
      if (!isSelf) {
        showNotification('Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
        return;
      }
      const blocked = ['role', 'permissions', 'subscriptions'];
      for (const k of blocked) {
        if (sanitizedUpdates[k] !== undefined) delete sanitizedUpdates[k];
      }
    }

    array[index] = { ...array[index], ...sanitizedUpdates, _lastModified: getMonotonicTime() };
    // Keep currentUser in sync when updating own user record (important for profile changes)
    if (collectionName === 'users' && state.currentUser?.id === id) {
      state.currentUser = array[index];
    }
    if (collectionName) markCollectionDirty(collectionName);
    saveState();
    addAuditLog('Update', id, `Updated ${getRecordType(array[index])}`, { old, new: array[index] });
    RenderQueue.schedule('updateRecord');

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      const expected = old._lastModified || 0;
      apiPatchEntity(collectionName, id, sanitizedUpdates, expected)
        .then((entity) => {
          if (entity?.data) {
            const idx = array.findIndex(x => x && x.id === id);
            if (idx !== -1) {
              array[idx] = Security.sanitizeObject(entity.data);
              if (collectionName) markCollectionDirty(collectionName);
              saveState();
              // Force full render to ensure list views update
              forceFullRender();
            }
          }
        })
        .catch(async (e) => {
          if (e?.status === 409) {
            try {
              const latest = await apiGetEntity(collectionName, id);
              const idx = array.findIndex(x => x && x.id === id);
              if (idx !== -1 && latest?.data) {
                array[idx] = Security.sanitizeObject(latest.data);
                if (collectionName) markCollectionDirty(collectionName);
                saveState();
              }
              showNotification('Conflict', 'This record was changed by another user. We loaded the latest version.', 'warning');
              render();
              return;
            } catch (err) {
              // fallthrough to rollback
            }
          }

          // Rollback on failure
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to save ${collectionName}: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
    } else if (isServerModeEnabled() && collectionName === 'users') {
      // Map to server user update API (Admin only)
      const payload = {};
      if (sanitizedUpdates.name !== undefined) payload.name = sanitizedUpdates.name;
      if (sanitizedUpdates.email !== undefined) payload.email = sanitizedUpdates.email;
      if (sanitizedUpdates.role !== undefined) payload.role = sanitizedUpdates.role;
      if (sanitizedUpdates.permissions !== undefined) payload.permissions = sanitizedUpdates.permissions;
      if (sanitizedUpdates._deleted !== undefined) payload.deleted = !!sanitizedUpdates._deleted;

      apiUpdateUser(id, payload)
        .then((updatedUser) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && updatedUser) {
            array[idx] = { ...array[idx], ...updatedUser, _lastModified: Date.now(), _deleted: false };
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
            render();
          }
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          showNotification('Server Error', `Failed to update user: ${e.message || 'Error'}`, 'error');
          render();
        });
    }
  }
}

function deleteRecord(array, id) {
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions cannot be deleted. Use a reversal transaction.', 'error');
      return;
    }
    if (collectionName === 'serviceSubscriptions') {
      showNotification('Not Allowed', 'Subscription history cannot be deleted.', 'error');
      return;
    }
    const old = { ...array[index] };
    array[index]._deleted = true;
    array[index]._lastModified = getMonotonicTime();
    if (collectionName) markCollectionDirty(collectionName);
    saveState();
    addAuditLog('Delete', id, `Deleted ${getRecordType(array[index])}`);
    RenderQueue.schedule('deleteRecord');

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      apiDeleteEntity(collectionName, id)
        .then(() => {
          // ok
          render();
        })
        .catch((e) => {
          // Rollback on failure
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to delete ${collectionName}: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
    } else if (isServerModeEnabled() && collectionName === 'users') {
      apiUpdateUser(id, { deleted: true })
        .then(() => {
          showNotification('Deleted', 'User deleted', 'success');
          render();
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to delete user: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
    }
  }
}

function getVisibleRecords(array) {
  if (!Array.isArray(array)) return [];
  return array.filter(item => item && !item._deleted);
}

function getRecordType(record) {
  if (record.email) return 'User';
  if (record.platform) return 'Customer';
  if (record.category) return 'Page';
  if (record.amountUSD !== undefined) return record.recordType === 'receipt' ? 'Receipt' : 'Ad';
  return 'Record';
}

// ==========================================
// AUDIT LOGGING
// ==========================================

function redactSensitive(obj, depth = 0) {
  if (depth > 12) return null;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(x => redactSensitive(x, depth + 1));

  const SENSITIVE_KEYS = new Set([
    'password',
    'passwordHash',
    'salt',
    'passwordAlgo',
    'passwordIterations',
    'token',
    'tokenHash',
    'recoveryKey',
    'localRecovery'
  ]);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    out[k] = redactSensitive(v, depth + 1);
  }
  return out;
}

function addAuditLog(action, resourceId, description, metadata = {}) {
  // Determine severity level based on action type
  const severityMap = {
    'create': 'info',
    'update': 'info',
    'delete': 'warning',
    'Login': 'info',
    'Logout': 'info',
    'transfer': 'warning',
    'stop': 'warning',
    'receipt': 'info',
    'error': 'error',
    'security': 'critical'
  };
  
  // Determine category based on action and metadata
  const categoryMap = {
    'create': 'data',
    'update': 'data',
    'delete': 'data',
    'Login': 'auth',
    'Logout': 'auth',
    'transfer': 'financial',
    'stop': 'financial',
    'receipt': 'financial'
  };
  
  const redacted = redactSensitive(metadata);
  const safeMetadata = (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) ? redacted : {};
  const log = {
    id: generateId('log'),
    date: new Date().toISOString(),
    userId: state.currentUser?.id || 'system',
    userName: state.currentUser?.name || 'System',
    action,
    resourceId,
    resourceType: metadata.resourceType || 'Mixed',
    category: categoryMap[action] || 'general',
    severity: severityMap[action] || 'info',
    description,
    metadata: {
      browser: navigator.userAgent,
      ip: 'local',
      sessionId: state.sessionId || generateId('session'),
      ...safeMetadata
    },
    _lastModified: getMonotonicTime(),
    _deleted: false,
    _archived: false
  };
  
  // Add to beginning of logs array (newest first)
  state.logs.unshift(log);
  
  // Initialize session ID if not exists
  if (!state.sessionId) {
    state.sessionId = generateId('session');
  }
  
  // Save to IndexedDB for persistent storage (async, fire-and-forget)
  if (db) {
    saveLogToIndexedDB(log).catch(e => console.warn('IndexedDB save failed:', e));
  }
  
  saveState();
}

// Lightweight logging helper used across feature codepaths
// action: 'create' | 'update' | 'delete' | etc.
// resourceType: e.g., 'receipt', 'page'
// resourceId: the id of the entity being logged
// description: human-readable description
function addLog(action, resourceType, resourceId, description, metadata = {}) {
  addAuditLog(action, resourceId, description, { resourceType, ...metadata });
}

function isCurrentUserAdmin() {
  return (state.currentUser?.role || '').toLowerCase() === 'admin';
}

// "Secret ideas" gating (UI only). Non-admin users are kept inside Albayan Manager for now.
const PLATFORM_ADMIN_ONLY_VIEWS = new Set(['services-hub', 'smart-systems', 'service-placeholder', 'wallet']);

// View -> permission module mapping (used for landing + access checks)
const VIEW_PERMISSION_MODULES = {
  analytics: 'analytics',
  customers: 'customers',
  receipts: 'receipts',
  pages: 'pages',
  ads: 'ads',
  deliveries: 'deliveries',
  reconciliation: 'analytics',
  users: 'users',
  audit: 'auditLogs',
  settings: 'settings'
};

const ALBAYAN_MANAGER_VIEW_ORDER = [
  'analytics',
  'customers',
  'receipts',
  'pages',
  'ads',
  'deliveries',
  'reconciliation',
  'audit',
  'settings',
  'users'
];

function userCanAccessView(user, view) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  const moduleKey = VIEW_PERMISSION_MODULES[String(view || '')];
  if (!moduleKey) return false;
  const perms = user.permissions || {};
  const actions = perms[moduleKey];
  if (!Array.isArray(actions)) return false;
  return actions.includes('view') || actions.includes('viewOwn');
}

function getAlbayanManagerLandingViewForUser(user) {
  const role = String(user?.role || '');
  if (role === 'Delivery') return 'delivery-dashboard';
  // Pick the first view they are allowed to open
  for (const view of ALBAYAN_MANAGER_VIEW_ORDER) {
    if (userCanAccessView(user, view)) return view;
  }
  return 'no-access';
}

function getPostLoginLandingViewForUser(user) {
  const roleLower = String(user?.role || '').toLowerCase();
  if (roleLower === 'admin') return 'services-hub';
  return getAlbayanManagerLandingViewForUser(user);
}

function enforceSecretFeaturesGate() {
  // If not logged in, no gating needed.
  if (!state.currentUser) return;
  // Admin can access everything.
  if (isCurrentUserAdmin()) return;
  // Non-admin: block secret platform views.
  if (PLATFORM_ADMIN_ONLY_VIEWS.has(String(state.currentView || ''))) {
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.viewData = null;
    saveState();
    return;
  }
  // Also check if user has permission for the current Albayan Manager view
  const view = String(state.currentView || '');
  if (view && view !== 'delivery-dashboard' && view !== 'no-access' && !userCanAccessView(state.currentUser, view)) {
    // User doesn't have permission for this view, find first allowed view
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.viewData = null;
    saveState();
  }
}

// ==========================================
// RECEIPT USAGE / TRANSFER HELPERS
// ==========================================

// Compute usage stats for a receipt based on ads funded by this receipt
function getReceiptUsageStats(receipt) {
  // Handle both receipt object and receipt ID
  const receiptObj = typeof receipt === 'string'
    ? (state.receipts || []).find(r => r.id === receipt)
    : receipt;

  if (!receiptObj) {
    return {
      usedUSD: 0,
      transferredUSD: 0,
      remainingUSD: 0,
      linkedAds: 0,
      fundedAds: [],
      lastUsedAt: null,
      usageStatus: 'Unknown'
    };
  }

  // Use consistent ID for all comparisons
  const receiptId = String(receiptObj.id || '');

  // Ads that reference this receipt as a funding source
  // Include both regular receiptAllocations AND dueAllocations (for delivery receipts that became Paid)
  const fundedAds = getVisibleRecords(state.ads || []).filter(
    ad => ad.recordType !== 'receipt' && (
      String(ad.fundingReceiptId || '') === receiptId ||
      String(ad.receiptId || '') === receiptId ||
      (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
      (Array.isArray(ad.dueAllocations) && ad.dueAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
      String(ad.linkedDeliveryReceiptId || '') === receiptId
    )
  );

  // Calculate used amount from both receiptAllocations and dueAllocations
  // When a delivery receipt is marked Delivered, ads that used its due amount via dueAllocations
  // should still count as using the receipt's funds
  const usedUSD = fundedAds.reduce((sum, ad) => {
    // Check receiptAllocations first (normal paid receipt usage)
    const receiptAllocSum = Array.isArray(ad.receiptAllocations)
      ? ad.receiptAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Check dueAllocations (delivery receipt due amount usage - critical for when receipt becomes Paid)
    const dueAllocSum = Array.isArray(ad.dueAllocations)
      ? ad.dueAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Legacy: check linkedDeliveryReceiptId with dueAmountToUseUSD
    let legacyDueUsage = 0;
    if (String(ad.linkedDeliveryReceiptId || '') === receiptId && dueAllocSum === 0) {
      legacyDueUsage = parseFloat(ad.dueAmountToUseUSD) || 0;
    }

    // Use explicit allocations if available, otherwise fall back to ad spend
    const explicitAllocations = receiptAllocSum + dueAllocSum + legacyDueUsage;
    if (explicitAllocations > 0) {
      return sum + explicitAllocations;
    }

    // Fall back to spentUSD or amountUSD only if no explicit allocations
    const spend = ad.spentUSD ?? ad.amountUSD ?? 0;
    return sum + spend;
  }, 0);

  const transfers = receiptObj.transfers || [];
  const transferredUSD = transfers.reduce((sum, t) => sum + (t.amountUSD || 0), 0);

  const totalUSD = receiptObj.amountUSD || 0;
  const remainingUSD = Math.max(totalUSD - usedUSD - transferredUSD, 0);

  const lastUsedAt = fundedAds.length > 0
    ? new Date(Math.max(...fundedAds.map(ad => new Date(ad.endDate || ad.startDate || ad.createdAt || 0).getTime())))
    : null;

  let usageStatus = 'Unused';
  if (usedUSD > 0 && remainingUSD > 0) usageStatus = 'Partially Used';
  if (remainingUSD <= 0 && totalUSD > 0) usageStatus = 'Fully Used';

  return {
    fundedAds,
    usedUSD,
    transferredUSD,
    remainingUSD,
    totalUSD,
    usageStatus,
    lastUsedAt
  };
}

// Compute usage stats for a DELIVERY receipt's due amount (Not Paid receipts)
// This tracks how much of the debt/due amount has been used by ads linking to this receipt
function getDeliveryReceiptDueUsage(receipt) {
  const receiptObj = typeof receipt === 'string'
    ? (state.receipts || []).find(r => r.id === receipt)
    : receipt;

  if (!receiptObj) {
    return { totalDueUSD: 0, usedDueUSD: 0, remainingDueUSD: 0, fundedAds: [] };
  }

  const receiptId = String(receiptObj.id || '');

  // Total due amount in USD (convert from LYD using receipt's exchange rate)
  const exchangeRate = receiptObj.exchangeRate || state.defaultExchangeRate || 1;
  const dueAmountLocal = Number(receiptObj.debtAmountLocal ?? receiptObj.amountLocal ?? 0) || 0;
  const totalDueUSD = exchangeRate > 0 ? dueAmountLocal / exchangeRate : 0;

  // Find all ads that use this delivery receipt's due amount
  const fundedAds = getVisibleRecords(state.ads || []).filter(ad => {
    if (ad._deleted || ad.recordType === 'receipt') return false;
    // Check if ad has dueAllocations pointing to this receipt
    if (Array.isArray(ad.dueAllocations)) {
      return ad.dueAllocations.some(a => String(a.receiptId || '') === receiptId);
    }
    // Legacy: check linkedDeliveryReceiptId
    return String(ad.linkedDeliveryReceiptId || '') === receiptId && (ad.dueAmountToUseUSD > 0 || ad.dueAmountToUseLYD > 0);
  });
  
  // Calculate total used from due
  const usedDueUSD = fundedAds.reduce((sum, ad) => {
    // First check dueAllocations (new system)
    if (Array.isArray(ad.dueAllocations)) {
      const allocSum = ad.dueAllocations
        .filter(a => String(a.receiptId || '') === receiptId)
        .reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0);
      if (allocSum > 0) return sum + allocSum;
    }
    // Legacy: check dueAmountToUseUSD or convert from LYD
    if (String(ad.linkedDeliveryReceiptId || '') === receiptId) {
      if (ad.dueAmountToUseUSD > 0) return sum + ad.dueAmountToUseUSD;
      if (ad.dueAmountToUseLYD > 0) {
        const adExRate = ad.exchangeRate || exchangeRate || 1;
        return sum + (ad.dueAmountToUseLYD / adExRate);
      }
    }
    return sum;
  }, 0);
  
  const remainingDueUSD = Math.max(totalDueUSD - usedDueUSD, 0);
  
  return {
    totalDueUSD,
    usedDueUSD,
    remainingDueUSD,
    fundedAds,
    exchangeRate
  };
}

function formatDateShort(date) {
  if (!date) return 'Never';
  try {
    return new Date(date).toLocaleString();
  } catch (e) {
    return 'Never';
  }
}

/**
 * Get the effective exchange rate for an ad.
 * Priority order:
 * 1. Linked delivery receipt's exchange rate (if ad is linked to delivery receipt)
 * 2. Weighted average from receipt allocations (if ad has multiple funding receipts)
 * 3. Single funding receipt's exchange rate
 * 4. Ad's own exchange rate
 * 5. Default exchange rate from state
 *
 * This ensures consistent exchange rate calculations across the application.
 */
function getEffectiveExchangeRate(ad) {
  if (!ad) return state.defaultExchangeRate || 1;

  // 1. For delivery-linked ads, use the linked receipt's rate
  if (ad.linkedDeliveryReceiptId) {
    const linkedReceipt = state.receipts.find(r => r.id === ad.linkedDeliveryReceiptId);
    if (linkedReceipt?.exchangeRate) {
      return linkedReceipt.exchangeRate;
    }
  }

  // 2. Weighted average from receipt allocations (based on amount allocated)
  if (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0) {
    let totalAmount = 0;
    let weightedSum = 0;

    for (const alloc of ad.receiptAllocations) {
      const receipt = state.receipts.find(r => r.id === alloc.receiptId);
      const amount = parseFloat(alloc.amountUSD) || 0;
      const rate = receipt?.exchangeRate;

      if (rate && amount > 0) {
        weightedSum += rate * amount;
        totalAmount += amount;
      }
    }

    if (totalAmount > 0) {
      return weightedSum / totalAmount;
    }
  }

  // 3. Also check dueAllocations for delivery receipt funding
  if (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0) {
    let totalAmount = 0;
    let weightedSum = 0;

    for (const alloc of ad.dueAllocations) {
      const receipt = state.receipts.find(r => r.id === alloc.receiptId);
      const amount = parseFloat(alloc.amountUSD) || 0;
      const rate = receipt?.exchangeRate;

      if (rate && amount > 0) {
        weightedSum += rate * amount;
        totalAmount += amount;
      }
    }

    if (totalAmount > 0) {
      return weightedSum / totalAmount;
    }
  }

  // 4. Single funding receipt
  if (ad.fundingReceiptId) {
    const receipt = state.receipts.find(r => r.id === ad.fundingReceiptId);
    if (receipt?.exchangeRate) return receipt.exchangeRate;
  }

  // 5. Legacy receiptId field
  if (ad.receiptId) {
    const receipt = state.receipts.find(r => r.id === ad.receiptId);
    if (receipt?.exchangeRate) return receipt.exchangeRate;
  }

  // 6. Ad's own exchange rate
  if (ad.exchangeRate) return ad.exchangeRate;

  // 7. Fall back to default
  return state.defaultExchangeRate || 1;
}

// ==========================================
// AUTHENTICATION
// ==========================================

// ==========================================
// SERVER API (Always‑Online Multi‑User Mode)
// ==========================================

// Production server used by the packaged Capacitor (iOS/Android) apps.
// The web app is unaffected: it always talks to the origin it was loaded from.
// For testing a different server on a device, set the override once from the
// WebView console/settings: localStorage.setItem('albayan_server_url', 'https://staging.example.com')
const MOBILE_SERVER_URL = 'https://albayanhub.com';

/** @type {AlbayanServerApiConfig} */
const SERVER_API = {
  // http/https covers the web + Android WebView (https://localhost); the
  // Platform check additionally covers iOS, whose WebView origin is
  // capacitor://localhost and would otherwise disable server mode entirely.
  enabledByDefault: window.location.protocol === 'http:' || window.location.protocol === 'https:' || Platform.isCapacitor,
  requestTimeoutMs: 15000, // 15s for better reliability on slow connections
  // Live sync: automatically refresh changes from other users in server mode (no manual refresh).
  liveSyncEnabled: true,
  liveSyncIntervalMs: 3000, // 3 seconds for faster real-time sync between devices
  usersSyncIntervalMs: 30000, // 30 seconds for users list
  // IMPORTANT: Keep this modest to avoid huge responses that can OOM-kill small ECS tasks.
  // Smaller page size = faster individual responses, better progress feedback.
  pageSize: 300, // Smaller batches for faster loading
  // Parallel loading for faster initial load
  initialLoadConcurrency: 3 // Load 3 collections at once during initial load
};

function isServerModeEnabled() {
  return !!state.serverMode;
}

function setServerModeOverride(mode) {
  // mode: 'auto' | 'local' | 'server'
  const m = (mode === 'auto' || mode === 'local' || mode === 'server') ? mode : 'auto';
  state.serverModeOverride = m;
  saveState();
  // Reload to re-run init() with correct mode + data sources
  window.location.reload();
}

function getServerBaseUrl() {
  const base = (state.serverBaseUrl || '').trim();
  if (base) return base.replace(/\/+$/, '');
  // Packaged mobile apps have no same-origin backend (their origin is the
  // app bundle itself), so they must target a real server URL.
  if (Platform.isCapacitor) {
    try {
      const override = (localStorage.getItem('albayan_server_url') || '').trim();
      if (/^https:\/\/[^\s]+$/i.test(override)) return override.replace(/\/+$/, '');
    } catch (_) { /* storage unavailable — fall through to default */ }
    return MOBILE_SERVER_URL;
  }
  return '';
}

// ==========================================
// REQUEST TRACING (Client → Server)
// ==========================================
// Generate a per-request ID so we can correlate client errors with CloudWatch logs on ECS.
const _clientTrace = (() => {
  const randHex = (nBytes) => {
    try {
      const b = new Uint8Array(nBytes);
      crypto.getRandomValues(b);
      return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    } catch {
      return Math.random().toString(16).slice(2);
    }
  };
  return {
    pageId: `${Date.now().toString(36)}-${randHex(4)}`.slice(0, 24),
    seq: 0
  };
})();

function newRequestId() {
  _clientTrace.seq += 1;
  // Format: <pageId>-<seq>
  return `${_clientTrace.pageId}-${_clientTrace.seq.toString(36)}`.slice(0, 64);
}

async function apiFetch(path, { method = 'GET', body, headers = {} } = {}, { timeoutMs } = {}) {
  const url = `${getServerBaseUrl()}${path}`;
  const controller = new AbortController();
  const effectiveTimeout = timeoutMs ?? SERVER_API.requestTimeoutMs;
  const t = setTimeout(() => controller.abort(), effectiveTimeout);
  // #region agent log
  const _fetchStart = Date.now();
  // #endregion
  try {
    const requestId = headers['X-Request-ID'] || headers['x-request-id'] || newRequestId();
    const opts = {
      method,
      credentials: 'include',
      headers: {
        ...headers,
        'X-Request-ID': requestId,
        'X-Client-Platform': (typeof Platform !== 'undefined' && Platform.platform) ? String(Platform.platform) : 'web'
      },
      signal: controller.signal
    };
    // Abort requests when user navigates to a different view
    try {
      const navSignal = (typeof getNavigationSignal === 'function') ? getNavigationSignal() : null;
      if (navSignal && navSignal.aborted) controller.abort();
      if (navSignal) navSignal.addEventListener('abort', () => controller.abort(), { once: true });
    } catch (_) {}
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    // #region agent log
    if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function' && path.includes('/collections/')) {
      window.__albayanDebugEmit('H2', 'script.js:apiFetch:response', 'API response received', {
        path: path.slice(0, 100),
        method,
        durationMs: Date.now() - _fetchStart,
        status: resp.status,
        ok: resp.ok,
        timeoutMs: effectiveTimeout,
        requestId: resp.headers.get('X-Request-ID') || requestId
      });
    }
    // #endregion
    return resp;
  } catch (e) {
    // #region agent log
    const isAbort = e?.name === 'AbortError';
    if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H3', 'script.js:apiFetch:error', 'API fetch error', {
        path: path.slice(0, 100),
        method,
        durationMs: Date.now() - _fetchStart,
        error: e?.message || 'unknown',
        name: e?.name || 'Error',
        isTimeout: isAbort,
        timeoutMs: effectiveTimeout
      });
    }
    // #endregion
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Retry helper with exponential backoff for transient failures.
 * Retries network errors, 500s, and timeouts (not 4xx client errors).
 */
async function withRetry(fn, maxRetries = 2, baseDelayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const status = e?.status;
      // Don't retry client errors (400, 401, 403, 404, 409) or successful responses
      if (status && status >= 400 && status < 500 && status !== 408) {
        throw e;
      }
      // Don't retry on last attempt
      if (attempt === maxRetries) {
        throw e;
      }
      // Exponential backoff: wait 500ms, 1000ms, 2000ms...
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// Global rate limit cooldown tracking
const _rateLimitCooldown = {
  login: { until: 0, retryAfter: 0 },
  general: { until: 0, retryAfter: 0 }
};

// Check if we're in a cooldown period
function isRateLimited(endpoint = 'general') {
  const cooldown = _rateLimitCooldown[endpoint] || _rateLimitCooldown.general;
  if (Date.now() < cooldown.until) {
    return { limited: true, retryAfter: Math.ceil((cooldown.until - Date.now()) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

// Set cooldown from server response
function setRateLimitCooldown(endpoint, retryAfterSeconds) {
  const key = endpoint.includes('login') ? 'login' : 'general';
  _rateLimitCooldown[key] = {
    until: Date.now() + (retryAfterSeconds * 1000),
    retryAfter: retryAfterSeconds
  };
}

async function apiJson(path, options = {}, timeout = {}) {
  // Check if we're in a cooldown period for this endpoint
  const endpointKey = path.includes('/auth/login') ? 'login' : 'general';
  const cooldownCheck = isRateLimited(endpointKey);
  if (cooldownCheck.limited && path.includes('/auth/login')) {
    const err = new Error(`Rate limited. Please wait ${cooldownCheck.retryAfter} seconds.`);
    err.status = 429;
    err.retryAfter = cooldownCheck.retryAfter;
    throw err;
  }
  
  const resp = await apiFetch(path, options, timeout);
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  
  // Handle 429 rate limit responses
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '60', 10);
    setRateLimitCooldown(path, retryAfter);
    const msg = (data && typeof data === 'object' && data.detail) ? data.detail : `Rate limited. Try again in ${retryAfter} seconds.`;
    const err = new Error(msg);
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
  
  if (!resp.ok) {
    const msg = (data && typeof data === 'object' && data.detail) ? data.detail : (resp.statusText || 'Request failed');
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function apiHealthCheck() {
  if (!SERVER_API.enabledByDefault) return false;
  try {
    // Fast health check (3 second timeout)
    const data = await apiJson('/api/health', { method: 'GET' }, { timeoutMs: 3000 });
    return !!data?.ok;
  } catch {
    return false;
  }
}

async function apiAuthMe() {
  const now = Date.now();
  
  // Return cached session if fresh (within 10 seconds) - prevents logout on rapid refresh
  if (_sessionCache.user && (now - _sessionCache.timestamp) < _sessionCache.cacheDurationMs) {
    return _sessionCache.user;
  }
  
  try {
    // Fast timeout with retry for resilience
    const user = await withRetry(
      () => apiJson('/api/auth/me', { method: 'GET' }, { timeoutMs: 5000 }),
      2, // 2 retries
      200 // 200ms delay between retries
    );
    
    // Cache successful session
    if (user) {
      _sessionCache = { user, timestamp: now, cacheDurationMs: 10000 };
    }
    
    return user;
  } catch (e) {
    if (e?.status === 401) {
      // Clear cache on explicit 401
      _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
      return null;
    }
    // On timeout/network error, return cached session if available
    if (e?.name === 'AbortError' || e?.message?.includes('timeout')) {
      console.warn('[apiAuthMe] Timeout - using cached session');
      if (_sessionCache.user) {
        return _sessionCache.user;
      }
      return null;
    }
    throw e;
  }
}

async function apiLogin(email, password) {
  // Check client-side rate limit cooldown first
  const cooldownCheck = isRateLimited('login');
  if (cooldownCheck.limited) {
    const minutes = Math.ceil(cooldownCheck.retryAfter / 60);
    const err = new Error(`Too many login attempts. Please wait ${minutes} minute(s) before trying again.`);
    err.status = 429;
    err.retryAfter = cooldownCheck.retryAfter;
    throw err;
  }
  
  const payload = { email, password };
  try {
  const res = await apiJson('/api/auth/login', { method: 'POST', body: payload }, { timeoutMs: 12000 });
  return res?.user || null;
  } catch (e) {
    // If rate limited, show a user-friendly message
    if (e?.status === 429) {
      const minutes = Math.ceil((e.retryAfter || 60) / 60);
      showNotification('Too Many Attempts', `Please wait ${minutes} minute(s) before trying again.`, 'error');
    }
    throw e;
  }
}

async function apiLogout() {
  try {
    await apiJson('/api/auth/logout', { method: 'POST', body: {} }, { timeoutMs: 12000 });
  } catch (e) {
    // Expected to fail sometimes (session already expired, network issues)
    if (ALBAYAN_DEBUG_MODE) console.warn('[apiLogout] Failed (expected if session expired):', e?.message || e);
  }
}

// Cache for users list to avoid repeated API calls
let _usersListCache = { data: null, timestamp: 0, cacheDurationMs: 30000 }; // 30 second cache

// Session cache to prevent logout on rapid refresh
let _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 }; // 10 second cache

async function apiListUsersForUi() {
  // Return cached data if fresh (within 30 seconds)
  const now = Date.now();
  if (_usersListCache.data && (now - _usersListCache.timestamp) < _usersListCache.cacheDurationMs) {
    return _usersListCache.data;
  }
  
  // Admins can access full list; others get minimal list
  try {
    const result = await withRetry(
      () => apiJson('/api/users', { method: 'GET' }, { timeoutMs: 10000 }), // Faster timeout
      2, 300 // Faster retry
    );
    _usersListCache = { data: result, timestamp: now, cacheDurationMs: 30000 };
    return result;
  } catch (e) {
    if (e?.status === 403) {
      const result = await withRetry(
        () => apiJson('/api/users/public', { method: 'GET' }, { timeoutMs: 10000 }),
        2, 300
      );
      _usersListCache = { data: result, timestamp: now, cacheDurationMs: 30000 };
      return result;
    }
    // On error, return cached data even if stale
    if (_usersListCache.data) {
      console.warn('[apiListUsersForUi] Using stale cache due to error');
      return _usersListCache.data;
    }
    throw e;
  }
}

async function apiCreateUser(user) {
  return await apiJson('/api/users', { method: 'POST', body: user }, { timeoutMs: 20000 });
}

async function apiUpdateUser(userId, updates) {
  return await apiJson(`/api/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: updates }, { timeoutMs: 20000 });
}

// Debounced server-side persistence for user permission changes.
// The permissions UI currently mutates local state for immediate UX; in server mode we must also persist
// those changes via /api/users/{id}. This avoids "permissions revert" after refresh and prevents 403
// errors on login when a user has no saved permissions.
const _serverUserUpdate = {
  timers: new Map(),
  pending: new Map(),
  debounceMs: 700
};

function scheduleServerUserUpdate(userId, updates, { quiet = false } = {}) {
  const uid = String(userId || '');
  if (!uid) return;
  if (!isServerModeEnabled()) return;
  if (!isCurrentUserAdmin()) return;

  const prev = _serverUserUpdate.pending.get(uid) || {};
  _serverUserUpdate.pending.set(uid, { ...prev, ...(updates && typeof updates === 'object' ? updates : {}) });

  const existingTimer = _serverUserUpdate.timers.get(uid);
  if (existingTimer) clearTimeout(existingTimer);

  const t = setTimeout(async () => {
    _serverUserUpdate.timers.delete(uid);
    const payload = _serverUserUpdate.pending.get(uid);
    _serverUserUpdate.pending.delete(uid);
    if (!payload || Object.keys(payload).length === 0) return;

    try {
      const updatedUser = await apiUpdateUser(uid, payload);
      const idx = Array.isArray(state.users) ? state.users.findIndex(u => u && String(u.id) === uid) : -1;
      if (idx !== -1 && updatedUser) {
        state.users[idx] = { ...state.users[idx], ...updatedUser, _lastModified: Date.now(), _deleted: false };
        if (String(state.currentUser?.id || '') === uid) state.currentUser = state.users[idx];
        markCollectionDirty('users');
        saveState();
      }
    } catch (e) {
      if (!quiet) {
        showNotification('Server Error', `Failed to save user changes: ${e?.message || 'Error'}`, 'error');
      }
    }
  }, _serverUserUpdate.debounceMs);

  _serverUserUpdate.timers.set(uid, t);
}

// Collection data cache for instant loading
const _collectionCache = {
  ads: { data: null, timestamp: 0 },
  receipts: { data: null, timestamp: 0 },
  customers: { data: null, timestamp: 0 },
  pages: { data: null, timestamp: 0 },
  exchangeRateHistory: { data: null, timestamp: 0 }
};
const CACHE_TTL_MS = 5000; // 5 seconds - show cached data instantly, then refresh

// Request deduplication - prevent multiple simultaneous requests for same collection
const _pendingRequests = new Map();

// Navigation abort controller - cancels in-flight requests when user navigates
let _navigationAbortController = null;

function getNavigationSignal() {
  if (!_navigationAbortController) {
    _navigationAbortController = new AbortController();
  }
  return _navigationAbortController.signal;
}

function cancelPendingRequests() {
  if (_navigationAbortController) {
    _navigationAbortController.abort();
    _navigationAbortController = null;
  }
  // Clear pending request cache
  _pendingRequests.clear();
}

// Refresh throttle - prevent too many refreshes (persists across reloads in the same tab)
let _lastRefreshTime = 0;
const REFRESH_THROTTLE_MS = 2000; // Minimum 2 seconds between refreshes
const _REFRESH_THROTTLE_KEY = 'albayan:lastRefreshAt';

function isRefreshThrottled() {
  const now = Date.now();
  try {
    const stored = Number(sessionStorage.getItem(_REFRESH_THROTTLE_KEY) || '0') || 0;
    _lastRefreshTime = Math.max(_lastRefreshTime || 0, stored || 0);
  } catch (_) {}
  if (now - _lastRefreshTime < REFRESH_THROTTLE_MS) {
    return true;
  }
  _lastRefreshTime = now;
  try { sessionStorage.setItem(_REFRESH_THROTTLE_KEY, String(now)); } catch (_) {}
  return false;
}

// Cancel pending requests when the page is being unloaded (refresh/back)
try {
  window.addEventListener('pagehide', () => cancelPendingRequests(), { passive: true });
} catch (_) {}

// Get timeout based on collection type (larger collections need more time)
function getCollectionTimeout(collection) {
  const timeouts = {
    receipts: 20000,    // Receipts often have more data - 20 seconds
    ads: 20000,         // Ads can be large - 20 seconds
    customers: 15000,   // Customers - 15 seconds
    pages: 10000,       // Pages - 10 seconds
    exchangeRateHistory: 8000,  // Small - 8 seconds
    default: 15000      // Default - 15 seconds
  };
  return timeouts[collection] || timeouts.default;
}

async function apiLoadCollectionAll(collection) {
  const now = Date.now();

  // Return cached data immediately if fresh (but only for non-critical refreshes)
  const cache = _collectionCache[collection];
  if (cache && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  // Request deduplication: if there's already a pending request for this collection, wait for it
  if (_pendingRequests.has(collection)) {
    try {
      return await _pendingRequests.get(collection);
    } catch (e) {
      // If the pending request failed, we'll try again below
      _pendingRequests.delete(collection);
    }
  }

  // Create the actual request with timeout protection
  const requestPromise = (async () => {
    const all = [];
    let offset = 0;
    const limit = SERVER_API.pageSize || 300;
    const timeoutMs = getCollectionTimeout(collection);
    let pageCount = 0;
    const maxPages = 50; // Safety limit to prevent infinite loops

    while (pageCount < maxPages) {
      pageCount++;
      try {
        // Use retry logic for resilience against transient server errors/timeouts
        const items = await withRetry(
          () => apiJson(
            `/api/collections/${encodeURIComponent(collection)}?limit=${limit}&offset=${offset}&include_deleted=true`,
            { method: 'GET' },
            { timeoutMs }
          ),
          2, // 2 retries (3 total attempts) - reduced for faster failure
          300 // 300ms base delay (faster retry)
        );

        if (!Array.isArray(items) || items.length === 0) break;

        for (const entity of items) {
          if (entity && entity.data) all.push(entity.data);
        }

        if (items.length < limit) break;
        offset += limit;
      } catch (pageError) {
        // If we already have some data, return what we have instead of failing completely
        if (all.length > 0) {
          console.warn(`[apiLoadCollectionAll] Partial load for ${collection}: got ${all.length} items before error`, pageError?.message);
          break;
        }
        throw pageError;
      }
    }

    // Update cache
    if (_collectionCache[collection]) {
      _collectionCache[collection] = { data: all, timestamp: Date.now() };
    }

    return all;
  })();

  // Store the pending request
  _pendingRequests.set(collection, requestPromise);

  try {
    const result = await requestPromise;
    return result;
  } finally {
    // Clean up pending request
    _pendingRequests.delete(collection);
  }
}

async function apiGetEntity(collection, id) {
  return await apiJson(`/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'GET' }, { timeoutMs: 15000 });
}

async function apiCreateEntity(collection, record) {
  return await withRetry(() => 
    apiJson(`/api/collections/${encodeURIComponent(collection)}`, { method: 'POST', body: { id: record.id, data: record } }, { timeoutMs: 20000 })
  , 2, 500);
}

async function apiPatchEntity(collection, id, updates, expectedLastModified) {
  return await withRetry(() =>
    apiJson(
      `/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: { data: updates, expectedLastModified } },
      { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
    )
  , 2, 500);
}

async function apiAdminRestoreEntity(collection, id, record) {
  const data = (record && typeof record === 'object') ? record : {};
  const createdAt = Number(data._created);
  const lastModified = Number(data._lastModified);
  const payload = {
    data,
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    createdBy: (data.createdBy !== undefined && data.createdBy !== null) ? String(data.createdBy) : undefined,
    lastModified: Number.isFinite(lastModified) ? lastModified : undefined,
    deleted: !!data._deleted
  };
  return await apiJson(
    `/api/admin/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/restore`,
    { method: 'PUT', body: payload },
    { timeoutMs: 60000 }
  );
}

async function apiDeleteEntity(collection, id) {
  return await apiJson(`/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }, { timeoutMs: 20000 });
}

async function serverLoadAllData() {
  // Load collections from server.
  // IMPORTANT: Do not fail the whole app if one collection fails. We'll load what we can and show one warning.
  const forbidden = [];
  const failed = [];
  // If a collection fails to refresh, NEVER wipe existing data (prevents "data disappears then comes back").
  const hadCounts = {
    ads: Array.isArray(state.ads) ? state.ads.length : 0,
    receipts: Array.isArray(state.receipts) ? state.receipts.length : 0,
    customers: Array.isArray(state.customers) ? state.customers.length : 0,
    pages: Array.isArray(state.pages) ? state.pages.length : 0,
    exchangeRateHistory: Array.isArray(state.exchangeRateHistory) ? state.exchangeRateHistory.length : 0,
    users: Array.isArray(state.users) ? state.users.length : 0,
  };
  // #region agent log
  const _loadStartTime = Date.now();
  const _timings = {};
  // #endregion
  const safeLoad = async (collection) => {
    // #region agent log
    const _start = Date.now();
    // #endregion
    try {
      const result = await apiLoadCollectionAll(collection);
      // #region agent log
      _timings[collection] = { durationMs: Date.now() - _start, count: Array.isArray(result) ? result.length : 0, ok: true };
      if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H4', 'script.js:safeLoad:success', `Collection ${collection} loaded`, {
          collection,
          durationMs: Date.now() - _start,
          count: Array.isArray(result) ? result.length : 0
        });
      }
      // #endregion
      return { ok: true, collection, data: Array.isArray(result) ? result : [], status: 200 };
    } catch (e) {
      const status = e?.status;
      // #region agent log
      _timings[collection] = { durationMs: Date.now() - _start, status: status || null, error: e?.message || 'unknown', ok: false };
      if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H1', 'script.js:safeLoad:error', `Collection ${collection} FAILED`, {
          collection,
          durationMs: Date.now() - _start,
          status: status || null,
          error: e?.message || 'unknown',
          name: e?.name || 'Error'
        });
      }
      // #endregion
      if (status === 403) {
        forbidden.push(String(collection || ''));
        // Forbidden is not a transient failure: do not keep previously cached data (avoid leaking data).
        return { ok: true, collection, data: [], status: 403 };
      }
      failed.push({ collection: String(collection || ''), status: status || null, message: e?.message || 'Request failed' });
      // Transient failure: keep existing data by returning null (do NOT wipe state)
      return { ok: false, collection, data: null, status: status || null, error: e };
    }
  };

  // Load collections in parallel for faster initial load
  // Use higher concurrency for initial load, but still limit to avoid overwhelming server
  const results = {};
  const collections = ['ads', 'receipts', 'customers', 'pages', 'exchangeRateHistory'];
  const CONCURRENCY = SERVER_API.initialLoadConcurrency || 3;

  // Show loading progress
  let loadedCount = 0;
  const updateProgress = (collection) => {
    loadedCount++;
    const pct = Math.round((loadedCount / collections.length) * 100);
    // Update any loading indicator if present
    const progressEl = document.getElementById('loading-progress');
    if (progressEl) progressEl.textContent = `Loading data... ${pct}%`;
  };

  for (let i = 0; i < collections.length; i += CONCURRENCY) {
    const batch = collections.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (c) => {
      const result = await safeLoad(c);
      updateProgress(c);
      return result;
    }));
    batchResults.forEach((r) => {
      if (r && r.collection) results[r.collection] = r;
    });

    // Apply data immediately after each batch for progressive rendering
    for (const r of batchResults) {
      if (r && r.collection && r.data !== null) {
        state[r.collection] = r.data;
        markCollectionDirty(r.collection);
      }
    }
  }

  // Only overwrite collections when we actually received new data.
  // If a collection failed (data === null), keep existing state collection.
  for (const c of collections) {
    const r = results[c];
    if (r && r.data !== null) {
      state[c] = r.data;
    } else {
      // Keep existing; ensure it's at least an array to avoid downstream crashes
      if (!Array.isArray(state[c])) state[c] = [];
    }
  }

  // Default exchange rate from latest history record
  if (Array.isArray(state.exchangeRateHistory) && state.exchangeRateHistory.length > 0) {
    const latest = state.exchangeRateHistory
      .slice()
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())[0];
    const rate = parseFloat(latest?.rate);
    if (!Number.isNaN(rate)) state.defaultExchangeRate = rate;
  }

  // Users list for UI (delivery assignment, etc.)
  try {
    const usersList = await apiListUsersForUi();
    if (Array.isArray(usersList)) {
      // Ensure current user is present and retains permissions
      const byId = new Map();
      for (const u of usersList) {
        if (u && u.id) byId.set(u.id, u);
      }
      if (state.currentUser?.id) byId.set(state.currentUser.id, { ...byId.get(state.currentUser.id), ...state.currentUser });
      state.users = Array.from(byId.values());
    }
  } catch (e) {
    failed.push({ collection: 'users', status: e?.status || null, message: e?.message || 'Failed to load users' });
  }

  state.serverLastSyncAt = new Date().toISOString();

  // Cache server data locally (IndexedDB) for performance (optional)
  if (db) {
    markAllCollectionsDirty();
    await flushDirtyCollections();
  }

  // One clean warning (avoid spam). These are user-specific and expected sometimes.
  if (forbidden.length) {
    // Do not show "limited access" details to non-admin users (avoid leaking internal permission structure).
    // Admins can still see this warning for troubleshooting.
    if (isCurrentUserAdmin()) {
      showNotification(
        'Limited Access',
        `Your account cannot access: ${forbidden.join(', ')}. Ask an Admin to grant permissions.`,
        'warning'
      );
    }
  }
  if (failed.length) {
    // Only warn if a collection is STILL empty (no cached data to show).
    const unique = Array.from(new Set(failed.map(x => x.collection))).filter(Boolean);
    const names = unique.filter((name) => {
      const n = String(name || '');
      if (n === 'users') {
        return !Array.isArray(state.users) || state.users.length === 0;
      }
      const arr = state[n];
      const hasNow = Array.isArray(arr) && arr.length > 0;
      const hadBefore = Number(hadCounts[n] || 0) > 0;
      // If we had data before or still have data now, do not show a scary warning toast.
      return !(hasNow || hadBefore);
    });
    if (names.length) {
    showNotification(
      'Server Warning',
      `Some data failed to load: ${names.join(', ')}. You can try Refresh.`,
      'warning'
    );
  }
  }
  // #region agent log
  if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
    window.__albayanDebugEmit('H4', 'script.js:serverLoadAllData:end', 'All collections load completed', {
      totalDurationMs: Date.now() - _loadStartTime,
      timings: _timings,
      failedCount: failed.length,
      forbiddenCount: forbidden.length,
      failed
    });
  }
  // #endregion
}

// ==========================================
// LIVE SERVER SYNC (Always‑Online Multi‑User Mode)
// ==========================================

const _serverLiveSync = {
  timer: null,
  inFlight: false,
  cursor: 0,
  lastUsersSyncAt: 0,
  startedForUserId: null
};

function _maxLastModifiedFromArray(arr) {
  if (!Array.isArray(arr)) return 0;
  let max = 0;
  for (const r of arr) {
    const v = Number(r?._lastModified);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function computeServerCursorFromState() {
  return Math.max(
    _maxLastModifiedFromArray(state.ads),
    _maxLastModifiedFromArray(state.receipts),
    _maxLastModifiedFromArray(state.customers),
    _maxLastModifiedFromArray(state.pages),
    _maxLastModifiedFromArray(state.exchangeRateHistory)
  );
}

async function apiLoadCollectionSince(collection, sinceMs) {
  const all = [];
  let offset = 0;
  const limit = Math.min(1000, SERVER_API.pageSize || 1000);
  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  while (true) {
    // Use retry logic for resilience against transient server errors/timeouts
    const items = await withRetry(
      () => apiJson(
      `/api/collections/${encodeURIComponent(collection)}?updated_since=${encodeURIComponent(String(since))}&limit=${limit}&offset=${offset}&include_deleted=true`,
      { method: 'GET' },
      { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
      ),
      2, // 2 retries for delta sync (less aggressive than full load)
      500 // 500ms base delay
    );
    if (!Array.isArray(items) || items.length === 0) break;
    for (const entity of items) {
      if (entity && entity.data) all.push(entity.data);
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

function applyServerDelta(collectionName, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  if (!Array.isArray(state[collectionName])) state[collectionName] = [];
  const arr = state[collectionName];
  let changed = false;

  for (const rec of records) {
    if (!rec || !rec.id) continue;
    const clean = Security.sanitizeObject(rec);
    const idx = arr.findIndex(x => x && x.id === clean.id);
    if (idx !== -1) {
      arr[idx] = clean;
    } else {
      arr.unshift(clean);
    }
    changed = true;
  }
  return changed;
}

async function serverLiveSyncOnce() {
  if (!isServerModeEnabled()) return;
  if (!state.currentUser) return;
  if (!SERVER_API.liveSyncEnabled) return;
  if (document.visibilityState === 'hidden') return;

  const roleLower = String(state.currentUser.role || '').toLowerCase();

  // Delivery users: do a small "replace" sync of only assigned deliveries + linked customers.
  // This guarantees removals (unassigned items) disappear without needing manual refresh.
  if (roleLower === 'delivery') {
    const safeAll = async (collection) => {
      try {
        return await apiLoadCollectionAll(collection);
      } catch (e) {
        // Network errors during sync - don't break the app, just return null
        if (ALBAYAN_DEBUG_MODE) console.warn(`[safeAll] Failed to load ${collection}:`, e?.message || e);
        return null;
      }
    };

    const [ads, receipts, customers] = await Promise.all([
      safeAll('ads'),
      safeAll('receipts'),
      safeAll('customers')
    ]);

    let changed = false;
    if (Array.isArray(ads)) { state.ads = ads; changed = true; }
    if (Array.isArray(receipts)) { state.receipts = receipts; changed = true; }
    if (Array.isArray(customers)) { state.customers = customers; changed = true; }
    
    // Ensure data migration on live sync (only if data changed, and debounced)
    if (changed) {
      // Run migration in background (don't block render)
      setTimeout(() => {
        migrateOldDataFormats();
        assignSequentialNumbers(false); // Use cache if available
      }, 100);
    }

    const nextCursor = computeServerCursorFromState();
    _serverLiveSync.cursor = Math.max(_serverLiveSync.cursor || 0, nextCursor);
    state.serverLastSyncAt = new Date().toISOString();
    // Always re-render when data changed (not just cursor) - ensures edits from admin show immediately
    if (changed) RenderQueue.schedule('liveSync(delivery)');
    return;
  }

  // Admin/Employee: delta sync by lastModified cursor (efficient for large datasets).
  const since = _serverLiveSync.cursor || computeServerCursorFromState() || 0;

  const safeSince = async (collection) => {
    try {
      return await apiLoadCollectionSince(collection, since);
    } catch (e) {
      if (e?.status === 403) return [];
      return [];
    }
  };

  const [adsDelta, receiptsDelta, customersDelta, pagesDelta, exhDelta] = await Promise.all([
    safeSince('ads'),
    safeSince('receipts'),
    safeSince('customers'),
    safeSince('pages'),
    safeSince('exchangeRateHistory')
  ]);

  let changed = false;
  changed = applyServerDelta('ads', adsDelta) || changed;
  changed = applyServerDelta('receipts', receiptsDelta) || changed;
  changed = applyServerDelta('customers', customersDelta) || changed;
  changed = applyServerDelta('pages', pagesDelta) || changed;
  changed = applyServerDelta('exchangeRateHistory', exhDelta) || changed;
  
  // Ensure data migration on live sync (only if data changed, debounced to not block render)
  if (changed) {
    setTimeout(() => {
      migrateOldDataFormats();
      assignSequentialNumbers(false); // Use cache if available
    }, 100);
  }

  // Cursor bumps to the newest record we saw.
  const maxDelta = Math.max(
    _maxLastModifiedFromArray(adsDelta),
    _maxLastModifiedFromArray(receiptsDelta),
    _maxLastModifiedFromArray(customersDelta),
    _maxLastModifiedFromArray(pagesDelta),
    _maxLastModifiedFromArray(exhDelta)
  );
  _serverLiveSync.cursor = Math.max(since, maxDelta);
  state.serverLastSyncAt = new Date().toISOString();

  // Refresh minimal users list occasionally (for assignment dropdowns)
  const now = Date.now();
  if ((now - (_serverLiveSync.lastUsersSyncAt || 0)) > (SERVER_API.usersSyncIntervalMs || 60000)) {
    _serverLiveSync.lastUsersSyncAt = now;
    try {
      const usersList = await apiListUsersForUi();
      if (Array.isArray(usersList)) {
        const byId = new Map();
        for (const u of usersList) {
          if (u && u.id) byId.set(u.id, u);
        }
        if (state.currentUser?.id) byId.set(state.currentUser.id, { ...byId.get(state.currentUser.id), ...state.currentUser });
        state.users = Array.from(byId.values());
      }
      // Also refresh current user's permissions (so they don't need to re-login for new permissions)
      await refreshCurrentUserPermissions();
    } catch (e) {
      // User list sync failure - non-critical, just log in debug mode
      if (ALBAYAN_DEBUG_MODE) console.warn('[serverLiveSyncOnce] Users sync failed:', e?.message || e);
    }
  }

  if (changed) RenderQueue.schedule('liveSync(delta)');
}

async function serverLiveSyncTick() {
  if (_serverLiveSync.inFlight) return;
  _serverLiveSync.inFlight = true;
  updateSyncIndicator('syncing');
  try {
    await serverLiveSyncOnce();
    updateSyncIndicator('synced');
  } catch (e) {
    console.warn('[serverLiveSyncTick] Sync failed:', e?.message || e);
    updateSyncIndicator('error');
  } finally {
    _serverLiveSync.inFlight = false;
  }
}

// Visual sync indicator
function updateSyncIndicator(status) {
  let indicator = document.getElementById('sync-status-indicator');
  if (!indicator) {
    // Create indicator if it doesn't exist
    indicator = document.createElement('div');
    indicator.id = 'sync-status-indicator';
    indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300';
    document.body.appendChild(indicator);
  }

  switch (status) {
    case 'syncing':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse mr-2"></span>Syncing...';
      indicator.style.opacity = '1';
      break;
    case 'synced':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-emerald-500 rounded-full mr-2"></span>Synced';
      // Fade out after 2 seconds
      setTimeout(() => {
        if (indicator) indicator.style.opacity = '0';
      }, 2000);
      break;
    case 'error':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300 cursor-pointer';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-rose-500 rounded-full mr-2"></span>Sync failed - Tap to retry';
      indicator.style.opacity = '1';
      indicator.onclick = () => manualSyncData();
      break;
  }
}

// Manual sync function for users
async function manualSyncData() {
  if (!isServerModeEnabled()) {
    showNotification('Offline Mode', 'Not connected to server', 'info');
    return;
  }

  updateSyncIndicator('syncing');
  showNotification('Syncing', 'Refreshing data from server...', 'info');

  try {
    // Clear cache to force fresh data
    for (const key of Object.keys(_collectionCache)) {
      _collectionCache[key] = { data: null, timestamp: 0 };
    }
    _pendingRequests.clear();

    await serverLoadAllData();
    updateSyncIndicator('synced');
    showNotification('Synced', 'Data refreshed successfully', 'success');
    forceFullRender();
  } catch (e) {
    console.error('[manualSyncData] Failed:', e);
    updateSyncIndicator('error');
    showNotification('Sync Failed', 'Could not refresh data. Check your connection.', 'error');
  }
}

// Expose to window for debugging and manual use
window.manualSyncData = manualSyncData;

function stopServerLiveSync() {
  if (_serverLiveSync.timer) {
    clearInterval(_serverLiveSync.timer);
    _serverLiveSync.timer = null;
  }
  _serverLiveSync.inFlight = false;
  _serverLiveSync.startedForUserId = null;

  // Clean up event listeners
  if (_serverLiveSync.visibilityHandler) {
    document.removeEventListener('visibilitychange', _serverLiveSync.visibilityHandler);
    _serverLiveSync.visibilityHandler = null;
  }
  if (_serverLiveSync.onlineHandler) {
    window.removeEventListener('online', _serverLiveSync.onlineHandler);
    _serverLiveSync.onlineHandler = null;
  }
}

function startServerLiveSync() {
  if (!isServerModeEnabled()) return;
  if (!state.currentUser) return;
  if (!SERVER_API.liveSyncEnabled) return;

  const uid = String(state.currentUser.id || '');
  if (_serverLiveSync.timer && _serverLiveSync.startedForUserId === uid) return;

  stopServerLiveSync();
  _serverLiveSync.startedForUserId = uid;
  _serverLiveSync.cursor = computeServerCursorFromState();
  _serverLiveSync.lastUsersSyncAt = 0;

  // Run one immediately, then poll.
  serverLiveSyncTick().catch(() => {});
  _serverLiveSync.timer = setInterval(() => {
    serverLiveSyncTick().catch(() => {});
  }, SERVER_API.liveSyncIntervalMs || 3000);

  // Resume sync when tab becomes visible again (after being backgrounded)
  if (!_serverLiveSync.visibilityHandler) {
    _serverLiveSync.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && state.currentUser) {
        // Tab is now visible - do an immediate sync to catch up
        console.log('[LiveSync] Tab visible - triggering immediate sync');
        serverLiveSyncTick().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', _serverLiveSync.visibilityHandler);
  }

  // Also sync when network comes back online
  if (!_serverLiveSync.onlineHandler) {
    _serverLiveSync.onlineHandler = () => {
      if (state.currentUser) {
        console.log('[LiveSync] Network online - triggering immediate sync');
        showNotification('Back Online', 'Reconnected to server, syncing...', 'info');
        serverLiveSyncTick().catch(() => {});
      }
    };
    window.addEventListener('online', _serverLiveSync.onlineHandler);
  }
}

async function handleLogin(email, password) {
  // #region agent log
  // Hypothesis H-LOGIN: Login failures are caused by one of:
  // (a) user not found due to stored email whitespace/case issues
  // (b) password verification mismatch due to iterations stored as string (PBKDF2)
  // (c) user has missing password data from old backups
  // Log only non-PII metadata (counts/booleans/types).
  try {
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'start', {
        protocol: String(window.location?.protocol || '').slice(0, 16),
        serverMode: !!isServerModeEnabled(),
        usersCount: Array.isArray(state.users) ? state.users.length : 0,
      });
    }
  } catch (_) {}
  // #endregion

  if (isServerModeEnabled()) {
    // IMPORTANT: Successful login should never be shown as "Login Failed" due to a later data-load error.
    // We'll render immediately after auth, then load data in a separate guarded step.
    try {
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_attempt', {
            emailLen: String(email || '').length,
            hasAt: String(email || '').includes('@'),
          });
        }
      } catch (_) {}
      // #endregion
      const user = await apiLogin(email, password);
      if (!user) {
        // #region agent log
        try {
          if (typeof window.__albayanDebugEmit === 'function') {
            window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_no_user', {});
          }
        } catch (_) {}
        // #endregion
        showNotification('Login Failed', 'Invalid email or password', 'error');
        return;
      }

      state.currentUser = user;
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_ok', {
            role: String(user?.role || '').slice(0, 32),
          });
        }
      } catch (_) {}
      // #endregion

      // Ensure user has subscriptions array
      if (!Array.isArray(state.currentUser.subscriptions)) {
        state.currentUser.subscriptions = [];
        if (state.currentUser.role === 'Admin') {
          state.currentUser.subscriptions = Object.keys(SERVICES);
        }
      }

      state.currentView = getPostLoginLandingViewForUser(user);
      saveState();

      showNotification('Welcome!', `Logged in as ${Security.escapeHtml(user.name)}. Loading data...`, 'success');
      render(); // immediately leave the login screen

      // Show loading indicator
      const loadingOverlay = document.createElement('div');
      loadingOverlay.id = 'data-loading-overlay';
      loadingOverlay.className = 'fixed inset-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center';
      loadingOverlay.innerHTML = `
        <div class="text-center">
          <div class="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p id="loading-progress" class="text-slate-600 dark:text-slate-300 font-medium">Loading data...</p>
          <p class="text-xs text-slate-400 mt-2">Please wait while we sync your data</p>
        </div>
      `;
      document.body.appendChild(loadingOverlay);

      try {
        await serverLoadAllData();
        showNotification('Data Loaded', 'All data synchronized successfully', 'success');
      } catch (e) {
        // serverLoadAllData should be tolerant, but keep a belt-and-suspenders guard.
        console.warn('Server data load failed after login:', e);
        showNotification('Server Warning', 'Logged in, but some data failed to load. Try Refresh.', 'warning');
      } finally {
        // Remove loading overlay
        document.getElementById('data-loading-overlay')?.remove();
      }

      // Start live sync so other users' changes appear without manual refresh.
      startServerLiveSync();
      render();
      return;
    } catch (e) {
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_error', {
            status: e?.status ?? null,
            name: String(e?.name || '').slice(0, 40),
            msg: String(e?.message || '').slice(0, 120),
          });
        }
      } catch (_) {}
      // #endregion
      if (e?.status === 401) {
        showNotification(
          'Login Failed',
          state.language === 'ar'
            ? 'بيانات الدخول غير صحيحة (حساب السيرفر). إذا كنت تريد حساب المتصفح المحلي، اضغط "استخدام المحلي".'
            : 'Invalid email or password (server account). If you meant your local browser account, click “Use Local”.',
          'error'
        );
        return;
      }
      showNotification('Login Failed', e?.message || 'Login failed', 'error');
      return;
    }
  }

  // Sanitize inputs
  const sanitizedEmail = Security.sanitizeInput(email.toLowerCase().trim(), { maxLength: 100 });
  const sanitizedPassword = password; // Don't modify password as it might contain special chars
  
  // Validate email format
  if (!Security.isValidEmail(sanitizedEmail)) {
    showNotification('Invalid Email', 'Please enter a valid email address', 'error');
    addSecurityLog('invalid_email_format', sanitizedEmail);
    return;
  }

  if (!Array.isArray(state.users) || state.users.length === 0) {
    showNotification('No Local Users', 'This deployment uses server login. Please run the backend and login there.', 'error');
    return;
  }
  
  // Check rate limiting
  const rateCheck = Security.checkRateLimit(sanitizedEmail, 5, 15 * 60 * 1000);
  if (!rateCheck.allowed) {
    showNotification('Too Many Attempts', `Please wait ${rateCheck.waitMinutes} minutes before trying again`, 'error');
    addSecurityLog('rate_limit_exceeded', sanitizedEmail);
    return;
  }
  
  // Record login attempt
  Security.recordLoginAttempt(sanitizedEmail);
  
  // Find user
  const _users = Array.isArray(state.users) ? state.users : [];
  // Debug-only: check whether trimming stored emails would change lookup result.
  let _exactFound = false;
  let _trimFound = false;
  try {
    _exactFound = !!_users.find(u => !u?._deleted && String(u?.email || '').toLowerCase() === sanitizedEmail);
    _trimFound = !!_users.find(u => !u?._deleted && String(u?.email || '').toLowerCase().trim() === sanitizedEmail);
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'user_lookup', {
        exactFound: _exactFound,
        trimFound: _trimFound,
        usersCount: _users.length,
      });
    }
  } catch (_) {}

  const user = _users.find(u => 
    !u._deleted &&
    u.email.toLowerCase() === sanitizedEmail
  );
  
  if (!user) {
    showNotification('Login Failed', 'Invalid email or password', 'error');
    addSecurityLog('failed_login_unknown_user', sanitizedEmail);
    return;
  }
  
  // If imported from very old backups, a user might have neither hash nor plaintext.
  // In that case, require password reset instead of silently failing.
  if (!user.passwordHash && !user.password) {
    showNotification(
      'Login Failed',
      state.language === 'ar'
        ? 'لا توجد بيانات كلمة مرور لهذا الحساب (ربما من نسخة احتياطية قديمة). استخدم "نسيت كلمة المرور؟" أو أنشئ مفتاح استعادة من الإعدادات.'
        : 'This account has no password data (likely from an old backup). Use “Forgot password?” or generate a Recovery Key in Settings.',
      'error'
    );
    addSecurityLog('login_missing_password_data', sanitizedEmail);
    return;
  }
  
  // Verify password
  let passwordValid = false;
  
  if (user.passwordHash && user.salt) {
    // Verify using stored algorithm (PBKDF2 recommended; legacy SHA-256 supported)
    const algo = user.passwordAlgo || 'sha256';
    const iterations = user.passwordIterations || null;
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        const iterRaw = iterations;
        const iterRawStr = String(iterRaw ?? '');
        const iterLooksNumeric = /^[0-9]{1,10}$/.test(iterRawStr);
        const iterParsed = iterLooksNumeric ? Number(iterRawStr) : null;
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'verify_password_before', {
          algo: String(algo || '').slice(0, 24),
          iterType: typeof iterRaw,
          iterRaw: iterLooksNumeric ? iterRawStr : null,
          iterParsed: Number.isFinite(iterParsed) ? iterParsed : null,
          hashLen: String(user.passwordHash || '').length,
          saltLen: String(user.salt || '').length,
        });
      }
    } catch (_) {}
    // #endregion
    passwordValid = await Security.verifyPassword(sanitizedPassword, user.passwordHash, user.salt, algo, iterations);
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'verify_password_after', {
          ok: !!passwordValid,
        });
      }
    } catch (_) {}
    // #endregion
    } else {
    // Legacy plain text password (migrate on successful login)
    passwordValid = user.password === sanitizedPassword;
    
    if (passwordValid) {
      // Migrate to PBKDF2 hashed password
      const { hash, salt, algo, iterations } = await Security.hashPassword(sanitizedPassword, null, { algo: 'pbkdf2-sha256' });
      user.passwordHash = hash;
      user.salt = salt;
      user.passwordAlgo = algo;
      user.passwordIterations = iterations;
      delete user.password; // Remove plain text password
      markCollectionDirty('users');
      saveState();
    }
  }
  
  if (passwordValid) {
    // Clear rate limiting on successful login
    Security.clearLoginAttempts(sanitizedEmail);
    
    // Create secure session
    SessionManager.createSession(user.id);
    
    state.currentUser = user;
    
    // Ensure user has subscriptions array (backwards compatibility)
    if (!Array.isArray(state.currentUser.subscriptions)) {
      state.currentUser.subscriptions = [];
      // Give Admin all services by default
      if (state.currentUser.role === 'Admin') {
        state.currentUser.subscriptions = Object.keys(SERVICES);
      }
    }
    
    state.currentView = getPostLoginLandingViewForUser(user);
    // Upgrade legacy hashes to PBKDF2 after successful login
    if ((user.passwordAlgo || 'sha256') !== 'pbkdf2-sha256') {
      try {
        const upgraded = await Security.hashPassword(sanitizedPassword, null, { algo: 'pbkdf2-sha256' });
        user.passwordHash = upgraded.hash;
        user.salt = upgraded.salt;
        user.passwordAlgo = upgraded.algo;
        user.passwordIterations = upgraded.iterations;
        markCollectionDirty('users');
      } catch (e) {
        console.warn('Password upgrade failed:', e);
      }
    }

    saveState();
    addAuditLog('Login', user.id, `User ${Security.escapeHtml(user.name)} logged in`);
    showNotification('Welcome!', `Logged in as ${Security.escapeHtml(user.name)}`, 'success');
    render();
  } else {
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'password_invalid', {
          serverMode: !!isServerModeEnabled(),
          exactFound: !!_exactFound,
          trimFound: !!_trimFound,
          hasHash: !!user?.passwordHash,
          hasSalt: !!user?.salt,
          algo: String(user?.passwordAlgo || '').slice(0, 24),
          iterType: typeof (user?.passwordIterations),
        });
      }
    } catch (_) {}
    // #endregion
    showNotification('Login Failed', 'Invalid email or password', 'error');
    addSecurityLog('failed_login_wrong_password', sanitizedEmail);
  }
}

function handleLogout() {
  if (state.currentUser) {
    addAuditLog('Logout', state.currentUser.id, `User ${Security.escapeHtml(state.currentUser.name)} logged out`);
  }
  
  if (isServerModeEnabled()) {
    apiLogout().catch(() => {});
  }

  stopServerLiveSync();

  // Destroy session
  SessionManager.destroySession();
  
  // Clear all caches
  _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
  _usersListCache = { data: null, timestamp: 0, cacheDurationMs: 30000 };
  
  state.currentUser = null;
  state.currentView = 'analytics';
  saveState();
  showNotification('Logged Out', 'See you soon!', 'info');
  render();
}

// ==========================================
// NAVIGATION & URL ROUTING
// ==========================================

// Map view names to URL paths
const VIEW_TO_PATH = {
  'services-hub': '/',
  'analytics': '/analytics',
  'ads': '/ads',
  'customers': '/customers',
  'receipts': '/receipts',
  'pages': '/pages',
  'users': '/users',
  'audit-logs': '/audit-logs',
  'delivery-dashboard': '/delivery',
  'receipt-balance': '/receipt-balance',
  'no-access': '/no-access',
  // Platform views (admin only)
  'smart-systems': '/smart-systems',
  'wallet': '/wallet',
  'account': '/account'
};

// Reverse map: path to view
const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_TO_PATH).map(([view, path]) => [path, view])
);

// Get current view from URL path
function getViewFromUrl() {
  const path = window.location.pathname || '/';
  // Try exact match first
  if (PATH_TO_VIEW[path]) {
    return PATH_TO_VIEW[path];
  }
  // Default to services-hub for root or unknown paths
  return 'services-hub';
}

// Get URL parameters (modal, filter, search, etc.)
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    modal: params.get('modal'),
    id: params.get('id'),
    filter: params.get('filter'),
    search: params.get('search'),
    tab: params.get('tab'),
    page: params.get('page')
  };
}

// Update URL with parameters (for modals, filters, etc.)
function updateUrlParams(newParams, replace = false) {
  const params = new URLSearchParams(window.location.search);
  
  // Update/add/remove params
  Object.entries(newParams).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  });
  
  const search = params.toString();
  const newUrl = window.location.pathname + (search ? '?' + search : '');
  
  try {
    if (replace) {
      window.history.replaceState({ view: state.currentView, params: newParams }, '', newUrl);
    } else {
      window.history.pushState({ view: state.currentView, params: newParams }, '', newUrl);
    }
  } catch (e) {
    console.warn('URL params update error:', e);
  }
}

// Clear all URL params (when closing modal, clearing filter, etc.)
function clearUrlParams(keys) {
  const params = new URLSearchParams(window.location.search);
  keys.forEach(key => params.delete(key));
  const search = params.toString();
  const newUrl = window.location.pathname + (search ? '?' + search : '');
  window.history.replaceState({ view: state.currentView }, '', newUrl);
}

// Update browser URL without reload
function updateUrlForView(view, replace = false) {
  const path = VIEW_TO_PATH[view] || '/';
  const newUrl = window.location.origin + path;
  
  // Don't update if already on this path
  if (window.location.pathname === path) return;
  
  try {
    if (replace) {
      window.history.replaceState({ view }, '', newUrl);
    } else {
      window.history.pushState({ view }, '', newUrl);
    }
  } catch (e) {
    // History API not available (rare)
    console.warn('History API error:', e);
  }
}

// Handle browser back/forward buttons
function setupUrlRouting() {
  window.addEventListener('popstate', (event) => {
    const view = event.state?.view || getViewFromUrl();
    // Navigate without pushing to history (already handled by popstate)
    navigateToInternal(view, false);
    
    // Also restore modal state from URL params
    restoreModalFromUrl();
  });
}

// Restore modal from URL params (e.g., ?modal=ad&id=123 or ?modal=ad&id=new)
function restoreModalFromUrl() {
  const params = getUrlParams();
  
  if (params.modal) {
    // Handle "new" modal (create new record)
    if (params.id === 'new') {
      setTimeout(() => {
        state.activeModal = params.modal;
        state.modalData = null;
        renderModal();
      }, 100);
      return;
    }
    
    // Find and open the modal for existing record
    if (params.id) {
      setTimeout(() => {
        let record = null;
        switch (params.modal) {
          case 'ad':
            record = state.ads.find(a => String(a.id) === String(params.id));
            break;
          case 'receipt':
            record = state.receipts.find(r => String(r.id) === String(params.id));
            break;
          case 'customer':
            record = state.customers.find(c => String(c.id) === String(params.id));
            break;
          case 'page':
            record = state.pages.find(p => String(p.id) === String(params.id));
            break;
          case 'user':
            record = state.users.find(u => String(u.id) === String(params.id));
            break;
          case 'split-payments':
            record = state.receipts.find(r => String(r.id) === String(params.id));
            break;
        }
        if (record) {
          state.activeModal = params.modal;
          state.modalData = record;
          renderModal();
        }
      }, 100);
    }
  } else {
    // No modal in URL, close any open modal
    if (state.activeModal) {
      state.activeModal = null;
      state.modalData = null;
      document.querySelectorAll('#app-modal').forEach(el => el.remove());
    }
  }
}

// Internal navigation (doesn't push to history if skipHistory=true)
function navigateToInternal(view, pushHistory = true) {
  // Cancel any in-flight requests from previous view
  cancelPendingRequests();
  
  // Secret ideas gating: only Admin can access the platform hub pages
  if (!isCurrentUserAdmin() && PLATFORM_ADMIN_ONLY_VIEWS.has(String(view || ''))) {
    showNotification('Restricted', state.language === 'ar' ? 'هذه الميزات مخفية حالياً' : 'These features are hidden for now', 'info');
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.isMobileMenuOpen = false;
    if (pushHistory) updateUrlForView(state.currentView);
    debouncedSaveState();
    render();
    return;
  }
  
  // Check permission (Admin always allowed)
  if (!isCurrentUserAdmin() && !userCanAccessView(state.currentUser, view)) {
    // Special views that don't need permissions
    if (view !== 'delivery-dashboard' && view !== 'no-access') {
      showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية' : `You don't have permission to access this page`, 'error');
      return;
    }
  }
  
  // PERFORMANCE: Update state and render immediately (don't wait for save)
  state.currentView = view;
  state.isMobileMenuOpen = false;
  
  // Update URL
  if (pushHistory) {
    updateUrlForView(view);
  }
  
  // Render immediately for instant feedback
  render();
  window.scrollTo(0, 0);
  
  // Save in background (debounced - doesn't block UI)
  debouncedSaveState();
}

function navigateTo(view) {
  navigateToInternal(view, true);
}

function toggleMobileMenu() {
  state.isMobileMenuOpen = !state.isMobileMenuOpen;
  render();
}

// ==========================================
// COMMAND PALETTE
// ==========================================

function toggleCommandPalette() {
  state.commandPaletteOpen = !state.commandPaletteOpen;
  renderCommandPalette();
  if (state.commandPaletteOpen) {
    setTimeout(() => {
      const input = document.getElementById('command-search');
      if (input) input.focus();
    }, 100);
  }
}

function renderCommandPalette() {
  const existing = document.getElementById('command-palette-modal');
  if (existing) existing.remove();
  
  if (!state.commandPaletteOpen) return;
  
  const commands = [
    { id: 'analytics', label: 'Analytics', icon: 'layout-dashboard', action: () => navigateTo('analytics') },
    { id: 'customers', label: 'Customers', icon: 'smile', action: () => navigateTo('customers') },
    { id: 'receipts', label: 'Receipts', icon: 'receipt', action: () => navigateTo('receipts') },
    { id: 'pages', label: 'Pages', icon: 'file-text', action: () => navigateTo('pages') },
    { id: 'ads', label: 'Ads', icon: 'megaphone', action: () => navigateTo('ads') },
    { id: 'deliveries', label: 'Deliveries', icon: 'truck', action: () => navigateTo('deliveries') },
    { id: 'users', label: 'Users', icon: 'users', action: () => navigateTo('users') },
    { id: 'settings', label: 'Settings', icon: 'settings', action: () => navigateTo('settings') },
    { id: 'add-customer', label: 'Add Customer', icon: 'user-plus', action: () => { toggleCommandPalette(); showCustomerModal(); } },
    { id: 'add-ad', label: 'Add Ad', icon: 'plus-circle', action: () => { toggleCommandPalette(); showAdModal(); } },
    { id: 'add-receipt', label: 'Add Receipt', icon: 'receipt', action: () => { toggleCommandPalette(); showReceiptModal(); } },
    { id: 'export', label: 'Export Data', icon: 'download', action: () => { toggleCommandPalette(); exportData(); } },
    { id: 'dark-mode', label: 'Toggle Dark Mode', icon: 'moon', action: () => { toggleCommandPalette(); toggleTheme(); } },
    { id: 'language', label: 'Toggle Language', icon: 'globe', action: () => { toggleCommandPalette(); toggleLanguage(); } },
    { id: 'logout', label: 'Logout', icon: 'log-out', action: () => { toggleCommandPalette(); handleLogout(); } },
  ];
  
  const modal = document.createElement('div');
  modal.id = 'command-palette-modal';
  modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center pt-32 p-4';
  modal.onclick = toggleCommandPalette;
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-4 w-full max-w-2xl" onclick="event.stopPropagation()">
      <div class="flex items-center space-x-3 mb-4 pb-3 border-b border-slate-200 dark:border-slate-700">
        <i data-lucide="command" class="w-5 h-5 text-indigo-600"></i>
        <input 
          type="text" 
          id="command-search" 
          placeholder="Type a command or search..."
          class="flex-1 bg-transparent outline-none text-slate-800 dark:text-white"
          oninput="filterCommands(this.value)"
        />
        <kbd class="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">ESC</kbd>
      </div>
      <div id="command-results" class="space-y-1 max-h-96 overflow-y-auto custom-scrollbar">
        ${commands.map(cmd => `
          <button onclick="executeCommand('${cmd.id}')" class="command-item w-full flex items-center space-x-3 px-4 py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left">
            <i data-lucide="${cmd.icon}" class="w-5 h-5 text-slate-400"></i>
            <span class="flex-1 text-slate-800 dark:text-white">${cmd.label}</span>
            <i data-lucide="arrow-right" class="w-4 h-4 text-slate-400"></i>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  
  // Store commands globally for execution
  window.commandPaletteCommands = commands;
}

function filterCommands(searchTerm) {
  const results = document.getElementById('command-results');
  const commands = window.commandPaletteCommands || [];
  
  const filtered = commands.filter(cmd => 
    cmd.label.toLowerCase().includes(searchTerm.toLowerCase())
  );
  
  // XSS-SAFE: Command palette (internal commands only, not user data)
  results.innerHTML = filtered.map(cmd => `
    <button onclick="executeCommand('${Security.escapeHtml(cmd.id)}')" class="command-item w-full flex items-center space-x-3 px-4 py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left">
      <i data-lucide="${Security.escapeHtml(cmd.icon)}" class="w-5 h-5 text-slate-400"></i>
      <span class="flex-1 text-slate-800 dark:text-white">${Security.escapeHtml(cmd.label)}</span>
      <i data-lucide="arrow-right" class="w-4 h-4 text-slate-400"></i>
    </button>
  `).join('');
  lucide.createIcons();
}

function executeCommand(commandId) {
  const commands = window.commandPaletteCommands || [];
  const command = commands.find(c => c.id === commandId);
  if (command && command.action) {
    command.action();
  }
}

// Keyboard shortcut handler
document.addEventListener('keydown', (e) => {
  // Ctrl+K or Cmd+K for command palette
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    toggleCommandPalette();
  }
  // Escape to close modals/palettes
  if (e.key === 'Escape') {
    if (state.commandPaletteOpen) {
      toggleCommandPalette();
    } else if (state.activeModal) {
      closeModal();
    }
  }
});

// ==========================================
// CLOUD SYNC (Simplified)
// ==========================================

let syncTimer = null;

function startCloudSync() {
  if (!state.cloudConfig.enabled || !state.cloudConfig.endpoint) return;
  
  // Pull every 5 seconds
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(pullFromCloud, 5000);
  
  // Initial pull
  pullFromCloud();
}

async function pullFromCloud() {
  if (!state.cloudConfig.enabled) return;
  
  try {
    state.cloudSyncStatus = 'syncing';
    renderSyncStatus();
    
    const headers = {
      'Content-Type': 'application/json',
      'X-Master-Key': state.cloudConfig.apiKey
    };
    
    const response = await fetch(state.cloudConfig.endpoint, {
      method: 'GET',
      headers
    });
    
    if (!response.ok) throw new Error('Sync failed');
    
    const data = await response.json();
    const remoteData = data.record || data;
    
    // Simple merge: take newer records
    mergeCloudData(remoteData);
    
    state.cloudSyncStatus = 'success';
    state.lastCloudSync = new Date().toISOString();
    saveState();
    renderSyncStatus();
    
  } catch (error) {
    console.error('Cloud sync error:', error);
    state.cloudSyncStatus = 'error';
    renderSyncStatus();
  }
}

async function pushToCloud() {
  if (!state.cloudConfig.enabled) return;
  
  try {
    state.cloudSyncStatus = 'syncing';
    renderSyncStatus();
    
    const payload = {
      ads: state.ads,
      receipts: state.receipts,
      customers: state.customers,
      pages: state.pages,
      users: state.users,
      logs: state.logs,
      defaultExchangeRate: state.defaultExchangeRate,
      exchangeRateHistory: state.exchangeRateHistory,
      updatedAt: Date.now()
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'X-Master-Key': state.cloudConfig.apiKey
    };
    
    const response = await fetch(state.cloudConfig.endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) throw new Error('Push failed');
    
    state.cloudSyncStatus = 'success';
    state.lastCloudSync = new Date().toISOString();
    saveState();
    renderSyncStatus();
    showNotification('Synced', 'Data pushed to cloud', 'success');
    
  } catch (error) {
    console.error('Cloud push error:', error);
    state.cloudSyncStatus = 'error';
    renderSyncStatus();
    showNotification('Sync Error', error.message, 'error');
  }
}

function mergeCloudData(remoteData) {
  // Simple last-write-wins merge
  const mergeArray = (local, remote) => {
    if (!Array.isArray(remote)) return;
    
    const remoteMap = new Map(remote.map(item => [item.id, item]));
    
    local.forEach((localItem, index) => {
      const remoteItem = remoteMap.get(localItem.id);
      if (remoteItem && (remoteItem._lastModified || 0) > (localItem._lastModified || 0)) {
        local[index] = remoteItem;
      }
      remoteMap.delete(localItem.id);
    });
    
    // Add new items from remote
    remoteMap.forEach(item => local.push(item));
  };
  
  mergeArray(state.ads, remoteData.ads);
  mergeArray(state.receipts, remoteData.receipts);
  mergeArray(state.customers, remoteData.customers);
  mergeArray(state.pages, remoteData.pages);
  mergeArray(state.users, remoteData.users);
  mergeArray(state.logs, remoteData.logs);
  
  if (remoteData.defaultExchangeRate !== undefined) {
    state.defaultExchangeRate = remoteData.defaultExchangeRate;
  }
  
  if (Array.isArray(remoteData.exchangeRateHistory)) {
    mergeArray(state.exchangeRateHistory, remoteData.exchangeRateHistory);
  }
  
  // Backwards compatibility: if receipts came in via ads[] (older cloud payloads)
  const normalized = normalizeReceiptsFromAds();
  if (normalized) {
    markCollectionDirty('ads');
    markCollectionDirty('receipts');
  }

  // Persist merged data to IndexedDB (huge-data safe)
  markAllCollectionsDirty();
  flushDirtyCollections().catch(() => {});
  
  saveState();
  render();
}

function renderSyncStatus() {
  const container = document.getElementById('sync-status-container');
  if (!container) return;
  
  if (!state.cloudConfig.enabled) {
    container.innerHTML = '';
    return;
  }
  
  const statusIcons = {
    idle: '<i data-lucide="cloud" class="w-3 h-3"></i>',
    syncing: '<i data-lucide="refresh-cw" class="w-3 h-3 animate-spin"></i>',
    success: '<i data-lucide="check-circle" class="w-3 h-3"></i>',
    error: '<i data-lucide="alert-circle" class="w-3 h-3"></i>'
  };
  
  const statusColors = {
    idle: 'bg-slate-500',
    syncing: 'bg-blue-500 animate-pulse',
    success: 'bg-green-500',
    error: 'bg-red-500'
  };
  
  container.innerHTML = `
    <div class="flex items-center space-x-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-full shadow-lg border border-white/20">
      <div class="${statusColors[state.cloudSyncStatus]} text-white rounded-full p-1">
        ${statusIcons[state.cloudSyncStatus]}
      </div>
      <span class="text-xs font-medium text-slate-700 dark:text-slate-300">
        ${state.cloudSyncStatus === 'syncing' ? 'Syncing...' : state.cloudSyncStatus === 'success' ? 'Synced' : state.cloudSyncStatus === 'error' ? 'Error' : 'Ready'}
      </span>
    </div>
  `;
  
  lucide.createIcons();
}

// ==========================================
// VIEW RENDERING FUNCTIONS  
// ==========================================

// All views and modals continue here...
// Due to file size, creating comprehensive vanilla_v1/COMPLETE_SCRIPT_CONTINUATION.txt
// with all remaining code that should be appended here.

// For now, here's a minimal working version:

// Track last rendered view to avoid unnecessary full re-renders
let _lastRenderedView = null;
let _lastRenderedUserId = null;
let _renderInProgress = false;
let _savedScrollPosition = { top: 0, left: 0 };

// Force a full re-render (bypasses partial update optimization)
function forceFullRender() {
  _lastRenderedView = null;
  _lastRenderedUserId = null;
  render();
}

// Helper: Lock layout during render to prevent jumps
function lockLayoutForRender(app) {
  if (!app) return;
  // Save current dimensions before render
  const currentHeight = app.offsetHeight;
  app.style.setProperty('--app-height', currentHeight + 'px');
  app.classList.add('is-rendering');
  document.documentElement.classList.add('is-rendering');
}

// Helper: Unlock layout after render
function unlockLayoutAfterRender(app) {
  if (!app) return;
  app.classList.remove('is-rendering');
  document.documentElement.classList.remove('is-rendering');
  app.style.removeProperty('--app-height');
}

function render() {
  // Prevent re-entrant rendering
  if (_renderInProgress) return;
  _renderInProgress = true;

  // IMPORTANT: Save scroll position BEFORE any DOM changes
  // Use multiple methods for reliability across browsers
  _savedScrollPosition = {
    top: window.pageYOffset || window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0,
    left: window.pageXOffset || window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0
  };

  const app = document.getElementById('app');

  try {
    if (!app) {
      _renderInProgress = false;
      return;
    }

    // Lock layout to prevent jumps during render
    lockLayoutForRender(app);

    // Hide loading screen on first render
    const loadingScreen = document.getElementById('app-loading-screen');
    if (loadingScreen) loadingScreen.style.display = 'none';

    // Determine what we're rendering
    const currentView = state.currentView;
    const currentUserId = state.currentUser?.id;
    const isLoggedIn = !!state.currentUser;

    // Check if we can do a partial update (same view, same user)
    const canPartialUpdate = _lastRenderedView === currentView &&
                             _lastRenderedUserId === currentUserId &&
                             isLoggedIn;

    if (!state.currentUser) {
      if (!isServerModeEnabled() && (!Array.isArray(state.users) || state.users.length === 0)) {
        app.innerHTML = renderFirstRunSetup();
        attachFirstRunHandlers();
      } else {
        app.innerHTML = renderLogin();
        attachLoginHandlers();
      }
      _lastRenderedView = null;
      _lastRenderedUserId = null;
    } else {
      // Enforce "secret ideas" gating for non-admin users
      enforceSecretFeaturesGate();

      // For main app, try to update only the content area if possible
      if (canPartialUpdate) {
        // Only update the view content, not the entire app
        const viewContainer = app.querySelector('.p-4.md\\:p-8');
        if (viewContainer) {
          viewContainer.innerHTML = renderView();
        } else {
          app.innerHTML = renderMainApp();
        }
      } else {
        app.innerHTML = renderMainApp();
      }

      _lastRenderedView = currentView;
      _lastRenderedUserId = currentUserId;
    }

    // Use scoped icon creation (faster than full DOM scan)
    IconQueue.schedule(app);
    renderSyncStatus();

    // IMPORTANT: Restore scroll position AFTER render using double-RAF for reliability
    // First RAF waits for layout, second ensures paint is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Restore scroll position
        window.scrollTo({
          left: _savedScrollPosition.left,
          top: _savedScrollPosition.top,
          behavior: 'instant' // Use instant to prevent smooth scroll animation
        });
        // Unlock layout after scroll is restored
        unlockLayoutAfterRender(app);
      });
    });
  } catch (e) {
    console.error('[render] Error:', e);
    unlockLayoutAfterRender(app);
  } finally {
    _renderInProgress = false;
  }
}

function renderFirstRunSetup() {
  const modeNote = isServerModeEnabled()
    ? 'Server mode detected. Please login with your server account.'
    : 'First time setup (local testing). Create an Admin account to start.';

  return `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="glass-panel w-full max-w-md p-8 rounded-3xl animate-fade-in-up">
        <div class="text-center mb-6">
          <div class="w-16 h-16 alb-mark rounded-2xl mx-auto mb-4 flex items-center justify-center text-white text-2xl font-bold">A</div>
          <h1 class="text-2xl font-bold text-slate-800 dark:text-white">${t('appName')}</h1>
          <p class="text-slate-500 mt-1">${modeNote}</p>
        </div>

        <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 mb-6">
          <div class="text-xs text-slate-600 dark:text-slate-300">
            <div class="font-bold mb-1">Why this setup?</div>
            <div>For local testing you need one admin user. For internet deployment, users must be created on the server.</div>
          </div>
        </div>

        <form id="first-run-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">Admin Name</label>
            <input type="text" id="first-name" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Your name" maxlength="100" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('email')}</label>
            <input type="email" id="first-email" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" maxlength="120" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('password')}</label>
            <input type="password" id="first-password" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">Confirm Password</label>
            <input type="password" id="first-password-confirm" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Repeat password" minlength="8" />
          </div>
          <button type="submit" class="w-full btn-shine alb-btn-primary text-white font-bold py-3 rounded-xl transition-all">
            Create Admin (Local)
          </button>
        </form>

        <button onclick="toggleLanguage()" class="mt-4 text-xs text-slate-400 alb-hover-brand mx-auto block">${state.language === 'en' ? 'العربية' : 'English'}</button>
      </div>
    </div>
  `;
}

function attachFirstRunHandlers() {
  const form = document.getElementById('first-run-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (isServerModeEnabled()) {
        showNotification('Server Mode', 'Server mode is enabled. Please login with your server account.', 'error');
        render();
        return;
      }

      const name = Security.sanitizeInput(document.getElementById('first-name').value, { maxLength: 100 });
      const email = Security.sanitizeInput(document.getElementById('first-email').value, { maxLength: 120 }).toLowerCase();
      const password = document.getElementById('first-password').value;
      const confirm = document.getElementById('first-password-confirm').value;

      if (!name) {
        showNotification('Validation Error', 'Name is required', 'error');
        return;
      }
      if (!Security.isValidEmail(email)) {
        showNotification('Validation Error', 'Please enter a valid email', 'error');
        return;
      }
      if (!password || String(password).length < 8) {
        showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
        return;
      }
      if (password !== confirm) {
        showNotification('Validation Error', 'Passwords do not match', 'error');
        return;
      }

      // Create local admin (hashed)
      const hashed = await Security.hashPassword(password, null, { algo: 'pbkdf2-sha256' });
      const admin = {
        id: generateId('user'),
        name,
        email,
        role: 'Admin',
        permissions: {},
        subscriptions: Object.keys(SERVICES), // Admin gets all services
        passwordHash: hashed.hash,
        salt: hashed.salt,
        passwordAlgo: hashed.algo,
        passwordIterations: hashed.iterations,
        _lastModified: Date.now(),
        _deleted: false
      };

      state.users = [admin];
      markCollectionDirty('users');
      saveState();

      SessionManager.createSession(admin.id);
      state.currentUser = admin;
      state.currentView = getPostLoginLandingViewForUser(admin);
      saveState();

      showNotification('Success', 'Admin account created (local)', 'success');
      render();

      // Generate a Recovery Key on first run (recommended for safe password resets in local mode)
      if (!state.localRecovery) {
        setTimeout(() => {
          generateAndShowRecoveryKey().catch(() => {});
        }, 300);
      }
    } catch (err) {
      console.error('First run setup error:', err);
      showNotification('Error', 'Failed to create admin', 'error');
    }
  });
}

function renderLogin() {
  const isRTL = state.language === 'ar';
  const passkeySupported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const passkeyHint = passkeySupported
    ? (isRTL ? 'يمكنك استخدام بصمة/Face ID (Passkey) إذا تم إعدادها مسبقاً.' : 'You can use a Passkey (Face ID / Touch ID) if you already set one up.')
    : (isRTL ? 'Passkey يتطلب HTTPS أو localhost. افتح التطبيق عبر localhost لاستخدامه.' : 'Passkeys require HTTPS or localhost. Open the app via localhost to use it.');

  return `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <div class="glass-panel w-full p-8 rounded-3xl animate-fade-in-up">
          <div class="text-center mb-8">
            <div class="w-16 h-16 rounded-3xl mx-auto mb-4 alb-mark alb-mark-dot flex items-center justify-center">
              <span class="text-white text-2xl font-extrabold">A</span>
            </div>
            <h1 class="text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">${t('appName')}</h1>
            <p class="text-slate-500 mt-2">${t('signInTitle')}</p>
          </div>

          <form id="login-form" class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${t('email')}</label>
              <div class="relative">
                <i data-lucide="mail" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input type="email" id="login-email" required class="w-full pl-10 pr-4 py-3 glass-input rounded-xl" placeholder="name@company.com" autocomplete="username" />
              </div>
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${t('password')}</label>
              <div class="relative">
                <i data-lucide="lock" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input type="password" id="login-password" required class="w-full pl-10 pr-4 py-3 glass-input rounded-xl" placeholder="••••••••" autocomplete="current-password" />
              </div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <button type="button" onclick="showPasswordResetModal()" class="text-sm font-medium alb-link">
                ${t('forgotPassword')}
              </button>
              <button type="button" onclick="toggleLanguage()" class="text-sm font-bold text-slate-500 alb-hover-brand">
                ${state.language === 'en' ? 'العربية' : 'English'}
              </button>
            </div>

            <button type="submit" class="w-full btn-shine alb-btn-primary text-white font-extrabold py-3 rounded-xl transition-all">
              ${t('loginButton')}
            </button>
          </form>

          <div class="my-6 flex items-center gap-3">
            <div class="flex-1 h-px bg-slate-200 dark:bg-slate-800"></div>
            <div class="text-[11px] font-bold text-slate-400 uppercase">${isRTL ? 'أو' : 'or'}</div>
            <div class="flex-1 h-px bg-slate-200 dark:bg-slate-800"></div>
          </div>

          <button type="button"
            onclick="passkeySignIn()"
            ${passkeySupported ? '' : 'disabled'}
            class="w-full glass-panel rounded-xl px-4 py-3 font-extrabold flex items-center justify-center gap-2 ${passkeySupported ? 'hover:shadow-xl' : 'opacity-60 cursor-not-allowed'}"
            title="${Security.escapeHtml(passkeyHint)}"
          >
            <i data-lucide="key-round" class="w-5 h-5"></i>
            <span>${isRTL ? 'تسجيل الدخول باستخدام Passkey' : 'Sign in with a Passkey'}</span>
          </button>
          <div class="mt-2 text-[11px] text-slate-400 text-center">
            ${passkeyHint}
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachLoginHandlers() {
  const form = document.getElementById('login-form');
  // #region agent log
  // Hypothesis H-LUI: User reports "login doesn't work" but we see no H-LOGIN logs.
  // Confirm whether the login handler is attached and whether submit fires (no PII).
  try {
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'attach', {
        formFound: !!form,
        protocol: String(window.location?.protocol || '').slice(0, 16),
        serverMode: !!state.serverMode,
        serverDetected: !!state.serverDetected,
        override: String(state.serverModeOverride || '').slice(0, 16),
      });
    }
  } catch (_) {}
  // #endregion
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'submit', {
            emailLen: String(email || '').length,
            passwordLen: String(password || '').length,
            hasAt: String(email || '').includes('@'),
            protocol: String(window.location?.protocol || '').slice(0, 16),
            serverMode: !!state.serverMode,
          });
        }
      } catch (_) {}
      // #endregion
      handleLogin(email, password);
    });

    // #region agent log
    // Some browsers won't fire submit if HTML5 validity fails. Capture click + validity state.
    try {
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.addEventListener('click', (e) => {
          const emailEl = document.getElementById('login-email');
          const pwEl = document.getElementById('login-password');
          const email = emailEl ? emailEl.value : '';
          const password = pwEl ? pwEl.value : '';
          const emailOk = emailEl && typeof emailEl.checkValidity === 'function' ? emailEl.checkValidity() : null;
          const pwOk = pwEl && typeof pwEl.checkValidity === 'function' ? pwEl.checkValidity() : null;
          const formOk = typeof form.checkValidity === 'function' ? form.checkValidity() : null;
          try {
            if (typeof window.__albayanDebugEmit === 'function') {
              window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'click', {
                emailLen: String(email || '').length,
                passwordLen: String(password || '').length,
                emailOk,
                pwOk,
                formOk,
                serverMode: !!state.serverMode,
              });
            }
          } catch (_) {}
          // If valid, force the login call here so we don't depend on submit firing.
          if (formOk === true) {
            e.preventDefault();
            handleLogin(email, password);
          }
        });
      }
    } catch (_) {}
    // #endregion
  }
}

function renderMainApp() {
  const dir = getDir();
  const showSidebar = !['services-hub', 'smart-systems', 'service-placeholder', 'wallet'].includes(state.currentView);
  
  return `
    <div class="flex min-h-screen" dir="${dir}">
      ${showSidebar ? renderSidebar() : ''}
      <!-- Sidebar is fixed on desktop (md), so main content must offset by sidebar width for ALL roles -->
      <main class="flex-1 ${showSidebar ? (dir === 'rtl' ? 'md:mr-72' : 'md:ml-72') : ''}">
        ${showSidebar ? `
        <header class="sticky top-0 z-20 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-6 py-4 md:hidden flex justify-between items-center">
          <div class="font-bold">${t('adManager')}</div>
          <button onclick="toggleMobileMenu()" class="text-slate-600 dark:text-slate-300"><i data-lucide="menu" class="w-6 h-6"></i></button>
        </header>
        ` : ''}
        <div class="p-4 md:p-8 max-w-7xl mx-auto">${renderView()}</div>
      </main>
    </div>
  `;
}

function renderSidebar() {
  // Map nav items to their permission modules
  const navItemPermissions = {
    'analytics': 'analytics',
    'customers': 'customers',
    'receipts': 'receipts',
    'pages': 'pages',
    'ads': 'ads',
    'deliveries': 'deliveries',
    'reconciliation': 'analytics', // Part of analytics
    'users': 'users',
    'audit': 'auditLogs',
    'settings': 'settings'
  };
  
  const allNavItems = [
    { id: 'analytics', icon: 'layout-dashboard', label: 'analytics' },
    { id: 'customers', icon: 'smile', label: 'customers' },
    { id: 'receipts', icon: 'receipt', label: 'receipts' },
    { id: 'pages', icon: 'file-text', label: 'pages' },
    { id: 'ads', icon: 'megaphone', label: 'ads' },
    { id: 'deliveries', icon: 'truck', label: 'deliveries' },
    { id: 'reconciliation', icon: 'clipboard-check', label: 'jobReconciliation' },
    { id: 'users', icon: 'users', label: 'users' },
    { id: 'audit', icon: 'file-clock', label: 'auditLogs' },
    { id: 'settings', icon: 'settings', label: 'settings' },
  ];

  // Delivery users have a special dashboard view (not permission-gated).
  if (state.currentUser?.role === 'Delivery') {
    allNavItems.unshift({ id: 'delivery-dashboard', icon: 'layout-dashboard', label: 'dashboard' });
  }
  
  // Filter nav items based on permissions (Admin sees all, others based on their permissions)
  const navItems = allNavItems.filter(item => {
    // Admin sees everything
    if (state.currentUser?.role === 'Admin') return true;
    
    // Delivery role - show delivery dashboard + deliveries
    if (state.currentUser?.role === 'Delivery') {
      return item.id === 'delivery-dashboard' || item.id === 'deliveries';
    }
    
    // Check if user has view permission for this module
    const permModule = navItemPermissions[item.id];
    return currentUserHasPermission(permModule, 'view') || 
           currentUserHasPermission(permModule, 'viewOwn');
  });
  
  // If no nav items visible, show minimal sidebar
  if (navItems.length === 0) {
    return `
      <aside class="fixed inset-y-0 left-0 z-50 w-72 bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl border-r border-white/20 shadow-lg transform transition-transform duration-500 ${state.isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 flex flex-col">
        <div class="p-6 border-b border-white/10">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 alb-mark rounded-xl flex items-center justify-center text-white font-bold">A</div>
            <span class="font-bold text-slate-800 dark:text-white">${t('adManager')}</span>
          </div>
        </div>
        <div class="flex-1 flex items-center justify-center p-6">
          <div class="text-center">
            <i data-lucide="lock" class="w-12 h-12 mx-auto text-slate-300 mb-3"></i>
            <p class="text-sm text-slate-500">No access granted</p>
            <p class="text-xs text-slate-400 mt-1">Contact admin for permissions</p>
          </div>
        </div>
        <div class="p-4 border-t border-white/10">
          <button onclick="handleLogout()" class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100">
            <i data-lucide="log-out" class="w-5 h-5"></i>
            <span>${t('logout')}</span>
          </button>
        </div>
      </aside>
    `;
  }
  
  const showServicesHubLink = isCurrentUserAdmin();
  return `
    ${state.isMobileMenuOpen ? '<div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 md:hidden" onclick="toggleMobileMenu()"></div>' : ''}
    <aside class="fixed inset-y-0 left-0 z-50 w-72 bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl border-r border-white/20 shadow-lg transform transition-transform duration-500 ${state.isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 flex flex-col">
      <div class="p-6 border-b border-white/10 flex items-center justify-between">
        <button type="button" onclick="navigateTo(getPostLoginLandingViewForUser(state.currentUser))" class="flex items-center space-x-3 text-left">
          <div class="w-10 h-10 alb-mark rounded-xl flex items-center justify-center text-white font-bold">A</div>
          <span class="font-bold text-slate-800 dark:text-white">${t('adManager')}</span>
        </button>
        <button onclick="toggleMobileMenu()" class="md:hidden"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <nav class="flex-1 p-4 space-y-2 overflow-y-auto">
        ${showServicesHubLink ? `
          <!-- Back to Services Hub (Admin only) -->
          <button onclick="navigateTo('services-hub')" class="flex items-center space-x-3 w-full px-4 py-3 rounded-xl font-medium text-slate-600 dark:text-slate-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 mb-3 border-b border-slate-200 dark:border-slate-700 pb-3">
            <i data-lucide="grid-3x3" class="w-5 h-5"></i>
            <span>${state.language === 'ar' ? 'الخدمات' : 'Services Hub'}</span>
          </button>
        ` : ''}
        
        ${navItems.map(item => `
          <button onclick="navigateTo('${item.id}')" class="flex items-center space-x-3 w-full px-4 py-3 rounded-xl font-medium ${state.currentView === item.id ? 'alb-nav-active' : 'text-slate-600 dark:text-slate-400 hover:bg-white/20'}">
            <i data-lucide="${item.icon}" class="w-5 h-5"></i>
            <span>${t(item.label)}</span>
          </button>
        `).join('')}
      </nav>
      <div class="p-4 space-y-3 border-t border-white/10">
        <!-- Current User Profile -->
        <div class="flex items-center space-x-3 p-3 bg-white/30 dark:bg-slate-800/30 rounded-xl">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
            ${state.currentUser?.name?.charAt(0) || 'U'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-slate-800 dark:text-white truncate">${Security.escapeHtml(state.currentUser?.name || 'User')}</div>
            <div class="text-xs text-slate-500 truncate">${Security.escapeHtml(state.currentUser?.role || 'Employee')}</div>
          </div>
          <button onclick="editUser('${state.currentUser?.id}')" class="p-2 rounded-lg hover:bg-white/50 dark:hover:bg-slate-700/50 transition-colors" title="Edit Your Profile">
            <i data-lucide="settings" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
          </button>
        </div>
        
        <div class="flex items-center justify-between bg-white/20 dark:bg-slate-800/20 rounded-xl p-2">
          <button onclick="toggleTheme()" class="flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-bold hover:bg-white/20">
            <i data-lucide="${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}" class="w-4 h-4"></i>
            <span>${state.theme}</span>
          </button>
          <button onclick="toggleLanguage()" class="flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-bold hover:bg-white/20">
            <i data-lucide="globe" class="w-4 h-4"></i>
            <span>${state.language.toUpperCase()}</span>
          </button>
        </div>
        <button onclick="handleLogout()" class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100">
          <i data-lucide="log-out" class="w-5 h-5"></i>
          <span>${t('logout')}</span>
        </button>
      </div>
    </aside>
  `;
}

function renderView() {
  switch (state.currentView) {
    case 'services-hub': return renderServicesHub();
    case 'smart-systems': return renderSmartSystems();
    case 'service-placeholder': return renderServicePlaceholder();
    case 'wallet': return renderWalletView();
    case 'analytics': return renderAnalyticsView();
    case 'customers': return renderCustomersView();
    case 'receipts': return renderReceiptsView();
    case 'pages': return renderPagesView();
    case 'ads': return renderAdsView();
    case 'deliveries': return renderDeliveriesView();
    case 'reconciliation': return renderReconciliationView();
    case 'users': return renderUsersView();
    case 'audit': return renderAuditView();
    case 'settings': return renderSettingsView();
    case 'delivery-dashboard': return renderDeliveryDashboard();
    case 'no-access': return renderNoAccessView();
    default: return `<div class="text-center py-12"><h2 class="text-2xl font-bold mb-4">${t('welcome')}</h2><p class="text-slate-500">Select a view from the sidebar</p></div>`;
  }
}

function renderNoAccessView() {
  const isRTL = state.language === 'ar';
  return `
    <div class="min-h-[70vh] flex items-center justify-center">
      <div class="text-center max-w-md mx-auto p-8">
        <div class="w-24 h-24 rounded-full alb-gradient-brand flex items-center justify-center mx-auto mb-6 shadow-2xl">
          <i data-lucide="lock" class="w-12 h-12 text-white"></i>
        </div>
        <h1 class="text-3xl font-bold text-slate-800 dark:text-white mb-4">
          ${isRTL ? 'لا توجد صلاحية' : 'No Access Granted'}
        </h1>
        <p class="text-slate-600 dark:text-slate-400 mb-8">
          ${isRTL 
            ? 'لم يتم منحك أي صلاحية بعد. يرجى التواصل مع المدير لتفعيل حسابك.'
            : 'You have not been granted any permissions yet. Please contact your administrator to activate your account.'}
        </p>
        <button onclick="handleLogout()" class="btn-shine alb-btn-secondary text-white px-6 py-3 rounded-xl font-bold">
          <i data-lucide="log-out" class="w-5 h-5 inline mr-2"></i>
          ${t('logout')}
        </button>
      </div>
    </div>
  `;
}

// ==========================================
// SERVICES HUB - Multi-Service Home Page
// ==========================================

function renderServicesHub() {
  const userName = state.currentUser?.name || 'User';
  const isRTL = state.language === 'ar';
  const walletBalanceMinor = state.currentUser?.id ? WALLET.getBalanceMinor(state.currentUser.id, WALLET.currency) : 0;
  const walletBalanceLabel = walletFormatMinor(walletBalanceMinor, WALLET.currency);

  const hubServices = Object.values(SERVICES)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const serviceCards = hubServices.map(service => {
    if (!service || !service.id) return '';

    const serviceName = isRTL ? service.nameAr : service.name;
    const serviceDesc = isRTL ? service.descriptionAr : service.description;
    const access = checkServiceAccess(service.id);
    const disabled = !!service.comingSoon;

    return `
      <button
        type="button"
        onclick="handleServiceClick('${service.id}')"
        class="group relative glass-panel p-6 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${disabled ? `
          <div class="absolute top-3 right-3 px-3 py-1 rounded-full text-[10px] font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}

        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-3 right-3">
            <i data-lucide="lock" class="w-4 h-4 text-amber-500"></i>
          </div>
        ` : ''}

        <div class="w-14 h-14 rounded-2xl bg-gradient-to-br ${service.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg">
          <i data-lucide="${service.icon}" class="w-7 h-7 text-white"></i>
        </div>

        <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">${serviceName}</h3>
        <p class="text-sm text-slate-500 dark:text-slate-400">${serviceDesc}</p>

        ${service.hasChildren ? `
          <div class="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold">
            <i data-lucide="layers" class="w-3.5 h-3.5"></i>
            <span>${(service.children?.length || 0)} ${isRTL ? 'أنظمة' : 'systems'}</span>
          </div>
        ` : ''}
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Header -->
      <div class="mb-8 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center text-white text-xl font-bold shadow-lg">
            ${userName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 class="text-2xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? `مرحبا، ${userName}!` : `Welcome, ${userName}!`}
            </h1>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL ? 'اختر خدمة للبدء' : 'Choose a service to get started'}
            </p>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <button onclick="navigateTo('wallet')" class="px-4 py-3 glass-panel rounded-xl hover:scale-105 transition-transform flex items-center gap-2">
            <i data-lucide="wallet" class="w-5 h-5 text-indigo-600"></i>
            <span class="text-sm font-bold text-slate-700 dark:text-slate-200">${walletBalanceLabel}</span>
          </button>
          <button onclick="toggleTheme()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform">
            <i data-lucide="sun" class="w-5 h-5"></i>
          </button>
          <button onclick="toggleLanguage()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-sm font-bold">
            ${isRTL ? 'EN' : 'عربي'}
          </button>
          <button onclick="handleLogout()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-rose-500">
            <i data-lucide="log-out" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
      
      <!-- Hero Banner (Optional) -->
      <div class="glass-panel p-8 rounded-3xl mb-8 alb-hero">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2 alb-gradient-text">
              ${isRTL ? 'فروع جديدة!' : 'New Services!'}
            </h2>
            <p class="text-slate-600 dark:text-slate-300">
              ${isRTL ? 'أهلاً بشركاء النجاح' : 'Welcome to our partner success platform'}
            </p>
          </div>
          <div class="hidden md:block">
            <i data-lucide="sparkles" class="w-16 h-16 text-indigo-400 opacity-50"></i>
          </div>
        </div>
      </div>
      
      <!-- Services Grid -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        ${serviceCards}
      </div>
    </div>
  `;
}

function renderSmartSystems() {
  const isRTL = state.language === 'ar';
  
  const children = Object.values(SMART_SYSTEMS_CHILDREN)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const childCards = children.map(child => {
    const childName = isRTL ? child.nameAr : child.name;
    const childDesc = isRTL ? child.descriptionAr : child.description;
    const access = checkServiceAccess(child.id);
    const disabled = child.comingSoon;
    
    return `
      <button 
        type="button"
        onclick="handleSmartSystemClick('${child.id}')"
        class="group relative glass-panel p-8 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-2xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${child.comingSoon ? `
          <div class="absolute top-4 right-4 px-3 py-1 rounded-full text-xs font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}
        
        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-4 right-4">
            <i data-lucide="lock" class="w-5 h-5 text-amber-500"></i>
          </div>
        ` : ''}
        
        <div class="w-20 h-20 rounded-3xl bg-gradient-to-br ${child.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform shadow-2xl">
          <i data-lucide="${child.icon}" class="w-10 h-10 text-white"></i>
        </div>
        
        <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${childName}</h3>
        <p class="text-slate-500 dark:text-slate-400">${childDesc}</p>
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Header -->
      <div class="mb-8">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-2xl">
            <i data-lucide="cpu" class="w-8 h-8 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? 'الأنظمة الذكية' : 'Smart Systems'}
            </h1>
            <p class="text-slate-500 dark:text-slate-400">
              ${isRTL ? 'أدوات الأعمال المتقدمة' : 'Advanced business tools'}
            </p>
          </div>
        </div>
      </div>
      
      <!-- Systems Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${childCards}
      </div>
    </div>
  `;
}

function renderServicePlaceholder() {
  const serviceId = state.viewData?.serviceId || state.modalData?.serviceId || '';
  const service = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  const isRTL = state.language === 'ar';
  
  if (!service) {
    return `<div class="text-center py-12"><p class="text-slate-500">Service not found</p></div>`;
  }
  
  const serviceName = isRTL ? service.nameAr : service.name;
  const serviceDesc = isRTL ? service.descriptionAr : service.description;
  
  return `
    <div class="max-w-4xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Placeholder Content -->
      <div class="glass-panel p-12 rounded-3xl text-center">
        <div class="w-24 h-24 rounded-3xl bg-gradient-to-br ${service.color} flex items-center justify-center mx-auto mb-6 shadow-2xl">
          <i data-lucide="${service.icon}" class="w-12 h-12 text-white"></i>
        </div>
        
        <h1 class="text-3xl font-bold text-slate-800 dark:text-white mb-3">${serviceName}</h1>
        <p class="text-lg text-slate-500 dark:text-slate-400 mb-8">${serviceDesc}</p>
        
        ${service.comingSoon ? `
          <div class="inline-flex items-center space-x-3 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-white font-bold shadow-lg">
            <i data-lucide="clock" class="w-5 h-5"></i>
            <span>${isRTL ? 'قريباً' : 'Coming Soon'}</span>
          </div>
        ` : `
          <p class="text-slate-600 dark:text-slate-300">${isRTL ? 'هذه الخدمة قيد الإنشاء' : 'This service is under construction'}</p>
        `}
      </div>
    </div>
  `;
}

function findUserByEmailOrId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const users = Array.isArray(state.users) ? state.users : [];
  // Prefer exact id match first
  let u = users.find(x => x && !x._deleted && String(x.id || '') === raw);
  if (u) return u;
  // Then email match
  u = users.find(x => x && !x._deleted && String(x.email || '').toLowerCase() === lower);
  return u || null;
}

function walletTransferFromUi() {
  try {
    if (!state.currentUser?.id) return;
    const toValue = document.getElementById('wallet-transfer-to')?.value || '';
    const amountValue = document.getElementById('wallet-transfer-amount')?.value || '';
    const memoValue = document.getElementById('wallet-transfer-memo')?.value || '';
    const currency = walletNormalizeCurrency(document.getElementById('wallet-transfer-currency')?.value || WALLET.currency);

    const toUser = findUserByEmailOrId(toValue);
    if (!toUser?.id) {
      showNotification('Validation', state.language === 'ar' ? 'المستلم غير موجود' : 'Recipient not found', 'error');
      return;
    }

    const amt = Number(amountValue);
    const amountMinor = walletToMinor(amt, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fingerprint = `${state.currentUser.id}|${toUser.id}|${currency}|${amountMinor}|${String(memoValue || '').trim()}`;
    if (WalletUiGuard.hit(fingerprint)) {
      showNotification('Please wait', state.language === 'ar' ? 'يرجى الانتظار... تم منع تكرار العملية' : 'Please wait... duplicate prevented', 'warning');
      return;
    }
    WALLET.transfer(state.currentUser.id, toUser.id, 0, { memo: memoValue, currency, amountMinor, idempotencyKey: `p2p:${Security.generateSecureId('idem')}` });

    const toEl = document.getElementById('wallet-transfer-to');
    const amtEl = document.getElementById('wallet-transfer-amount');
    const memoEl = document.getElementById('wallet-transfer-memo');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    if (memoEl) memoEl.value = '';

    showNotification('Success', state.language === 'ar' ? 'تم التحويل بنجاح' : 'Transfer completed', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Transfer failed', 'error');
  }
}

function walletTopUpFromUi() {
  try {
    if (!state.currentUser?.id) return;
    if (state.currentUser.role !== 'Admin') {
      showNotification('Not Allowed', state.language === 'ar' ? 'للأدمن فقط' : 'Admin only', 'error');
      return;
    }
    const toValue = document.getElementById('wallet-topup-to')?.value || '';
    const amountValue = document.getElementById('wallet-topup-amount')?.value || '';
    const memoValue = document.getElementById('wallet-topup-memo')?.value || '';
    const currency = walletNormalizeCurrency(document.getElementById('wallet-topup-currency')?.value || WALLET.currency);

    const toUser = findUserByEmailOrId(toValue);
    if (!toUser?.id) {
      showNotification('Validation', state.language === 'ar' ? 'المستلم غير موجود' : 'Recipient not found', 'error');
      return;
    }

    const amt = Number(amountValue);
    const amountMinor = walletToMinor(amt, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fingerprint = `${toUser.id}|${currency}|${amountMinor}|${String(memoValue || '').trim()}`;
    if (WalletUiGuard.hit(fingerprint)) {
      showNotification('Please wait', state.language === 'ar' ? 'يرجى الانتظار... تم منع تكرار العملية' : 'Please wait... duplicate prevented', 'warning');
      return;
    }
    WALLET.credit(toUser.id, 0, { memo: memoValue || 'Top-up', currency, amountMinor, idempotencyKey: `topup:${Security.generateSecureId('idem')}` });

    const toEl = document.getElementById('wallet-topup-to');
    const amtEl = document.getElementById('wallet-topup-amount');
    const memoEl = document.getElementById('wallet-topup-memo');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    if (memoEl) memoEl.value = '';

    showNotification('Success', state.language === 'ar' ? 'تم الشحن' : 'Top-up completed', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Top-up failed', 'error');
  }
}

function cancelSubscriptionFromUi(serviceId) {
  try {
    if (!state.currentUser?.id) return;
    const sid = String(serviceId || '').trim();
    if (!sid) return;
    const isRTL = state.language === 'ar';
    const ok = confirm(isRTL ? 'هل تريد إلغاء الاشتراك؟' : 'Cancel this subscription?');
    if (!ok) return;
    SUBSCRIPTIONS.cancel(state.currentUser.id, sid);
    showNotification('Success', isRTL ? 'تم إلغاء الاشتراك' : 'Subscription canceled', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Failed to cancel subscription', 'error');
  }
}

function renderWalletView() {
  const isRTL = state.language === 'ar';
  const uid = String(state.currentUser?.id || '');
  const isAdmin = state.currentUser?.role === 'Admin';

  const balances = [];
  if (uid) {
    for (const c of WALLET_SUPPORTED_CURRENCIES) {
      const m = WALLET.getBalanceMinor(uid, c);
      if (m !== 0 || c === WALLET.currency) balances.push({ c, m });
    }
  }
  const balancesHtml = balances.length
    ? balances.map(({ c, m }) => `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(m, c)}</div>`).join('')
    : `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(0, WALLET.currency)}</div>`;
  const currencyOptions = WALLET_SUPPORTED_CURRENCIES
    .map(c => `<option value="${c}" ${c === WALLET.currency ? 'selected' : ''}>${c}</option>`)
    .join('');
  const users = Array.isArray(state.users) ? state.users : [];
  const userById = new Map();
  for (const u of users) {
    if (!u || u._deleted || !u.id) continue;
    userById.set(String(u.id), u);
  }

  const allTx = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  const visibleTx = getVisibleRecords(allTx);
  const txs = (isAdmin ? visibleTx : visibleTx.filter(t => t && (t.fromUserId === uid || t.toUserId === uid))).slice(0, 50);

  const allSubs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
  const now = Date.now();
  const activeSubs = getVisibleRecords(allSubs)
    .filter(s => s && s.userId === uid && s.status === 'active' && (!s.expiresAt || new Date(s.expiresAt).getTime() > now))
    .slice(0, 50);

  const txRows = txs.map(tx => {
    const isIn = tx.toUserId === uid;
    const otherId = isIn ? tx.fromUserId : tx.toUserId;
    const other =
      !otherId || otherId === 'system'
        ? (isRTL ? 'النظام' : 'System')
        : (userById.get(String(otherId))?.name || userById.get(String(otherId))?.email || String(otherId || ''));

    const amountStr = walletFormatMinor(walletTxAmountMinor(tx), walletTxCurrency(tx));
    const when = tx.createdAt ? new Date(tx.createdAt).toLocaleString() : '';
    const memo = Security.escapeHtml(String(tx.memo || ''));

    return `
      <div class="flex items-start justify-between gap-4 py-3 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="min-w-0">
          <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(tx.type || 'tx')}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${Security.escapeHtml(other)} ${when ? `• ${Security.escapeHtml(when)}` : ''}</div>
          ${memo ? `<div class="text-[11px] text-slate-400 mt-1 break-words">${memo}</div>` : ''}
        </div>
        <div class="text-right font-black ${isIn ? 'text-emerald-600' : 'text-rose-600'}">
          ${isIn ? '+' : '-'}${Security.escapeHtml(amountStr)}
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">${isRTL ? 'لا توجد معاملات بعد' : 'No transactions yet'}</div>`;

  const subsRows = activeSubs.map(s => {
    const svc = SERVICES[s.serviceId];
    const name = svc ? (isRTL ? svc.nameAr : svc.name) : s.serviceId;
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '';
    return `
      <div class="flex items-center justify-between gap-4 py-2 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="font-bold text-slate-800 dark:text-white min-w-0 truncate">${Security.escapeHtml(name)}</div>
        <div class="flex items-center gap-3 shrink-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">
            ${exp ? (isRTL ? `ينتهي: ${Security.escapeHtml(exp)}` : `Expires: ${Security.escapeHtml(exp)}`) : ''}
          </div>
          <button onclick="cancelSubscriptionFromUi('${s.serviceId}')" class="text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-1.5 rounded-lg">
            ${isRTL ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">${isRTL ? 'لا توجد اشتراكات نشطة' : 'No active subscriptions'}</div>`;

  return `
    <div class="max-w-6xl mx-auto">
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>

      <div class="mb-8 flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-xl">
            <i data-lucide="wallet" class="w-7 h-7 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('wallet')}</h1>
            <p class="text-slate-500 dark:text-slate-400">${isRTL ? 'محفظتك واشتراكاتك' : 'Your balance and subscriptions'}</p>
          </div>
        </div>
        <div class="glass-panel px-5 py-3 rounded-2xl">
          <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">${t('balance')}</div>
          <div class="space-y-1 mt-1">${balancesHtml}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div class="glass-panel p-6 rounded-2xl">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('transfer')}</h3>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
              <input id="wallet-transfer-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستلم أو المعرّف' : 'Recipient email or ID'}" maxlength="140" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                <input id="wallet-transfer-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                <select id="wallet-transfer-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                  ${currencyOptions}
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('note')}</label>
                <input id="wallet-transfer-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
              </div>
            </div>
            <button onclick="walletTransferFromUi()" class="w-full btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="send" class="w-4 h-4 inline mr-2"></i>${t('send')}
            </button>
            <div class="text-[11px] text-slate-400">
              ${isRTL ? 'ملاحظة: في الوضع المحلي، هذا للعرض والتجربة فقط.' : 'Note: In local mode this is for testing/demo only.'}
            </div>
          </div>
        </div>

        ${isAdmin ? (isServerModeEnabled() ? `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-2">${t('topUp')}</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL
                ? 'في وضع السيرفر: شحن الرصيد يتم فقط عبر قنوات التمويل الخارجية (البنك/المعالج) وليس يدوياً.'
                : 'In server mode: top-ups must come from external funding rails (bank/processor), not manual admin credits.'}
            </p>
          </div>
        ` : `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('topUp')} (Admin)</h3>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
                <input id="wallet-topup-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستخدم أو المعرّف' : 'User email or ID'}" maxlength="140" />
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                  <input id="wallet-topup-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                  <select id="wallet-topup-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                    ${currencyOptions}
                  </select>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${t('note')}</label>
                  <input id="wallet-topup-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
                </div>
              </div>
              <button onclick="walletTopUpFromUi()" class="w-full btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700">
                <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>${t('topUp')}
              </button>
            </div>
          </div>
        `) : `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${isRTL ? 'الاشتراكات' : 'Subscriptions'}</h3>
            ${subsRows}
            <button onclick="navigateTo('services-hub')" class="mt-4 w-full bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إدارة الخدمات' : 'Manage services'}
            </button>
          </div>
        `}
      </div>

      <div class="glass-panel p-6 rounded-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white">${t('transactions')}</h3>
          <div class="text-xs text-slate-500 dark:text-slate-400">${isAdmin ? (isRTL ? 'آخر 50 (الكل)' : 'Latest 50 (all)') : (isRTL ? 'آخر 50 (لك فقط)' : 'Latest 50 (yours)')}</div>
        </div>
        ${txRows}
      </div>
    </div>
  `;
}

function handleServiceClick(serviceId) {
  const service = SERVICES[serviceId];
  if (!service) return;
  
  if (service.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذه الخدمة ستكون متاحة قريباً' : 'This service will be available soon',
      'info'
    );
    return;
  }
  
  const access = checkServiceAccess(serviceId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      showSubscriptionModal(serviceId, access.subscribeToId || serviceId);
      return;
    }
  }
  
  // Navigate to service
  const targetView = service.openView || (serviceId === 'smart_systems' ? 'smart-systems' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId } : null;
  
  saveState();
  render();
}

function handleSmartSystemClick(systemId) {
  const system = SMART_SYSTEMS_CHILDREN[systemId];
  if (!system) return;
  
  if (system.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذا النظام سيكون متاحاً قريباً' : 'This system will be available soon',
      'info'
    );
    return;
  }
  
  const access = checkServiceAccess(systemId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      showSubscriptionModal(systemId, access.subscribeToId || systemId);
      return;
    }
  }
  
  // Navigate to system
  const targetView = system.openView || (systemId === 'albayan_manager' ? 'analytics' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId: systemId } : null;
  saveState();
  render();
}

function renderAnalyticsView() {
  const ads = getVisibleRecords(state.ads).filter(ad => ad.recordType !== 'receipt');
  const receipts = getVisibleRecords(state.receipts);
  const users = getVisibleRecords(state.users);
  const now = Date.now();
  const last7 = now - 7 * 24 * 60 * 60 * 1000;

  // Calculate ad revenue - separate paid vs pending/unpaid for clarity
  const paidAds = ads.filter(ad => ad.isPaid === true || ad.paymentStatus === 'paid');
  const unpaidAds = ads.filter(ad => ad.isPaid !== true && ad.paymentStatus !== 'paid');
  const paidAdRevenue = paidAds.reduce((sum, ad) => sum + (ad.amountUSD || 0), 0);
  const unpaidAdRevenue = unpaidAds.reduce((sum, ad) => sum + (ad.amountUSD || 0), 0);
  const totalAdRevenue = paidAdRevenue + unpaidAdRevenue;  // Keep for backwards compatibility

  const totalReceiptsUSD = receipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const paidReceipts = receipts.filter(r => (r.status || '').toLowerCase() === 'paid');
  const pendingReceipts = receipts.filter(r => {
    const s = (r.status || '').toLowerCase();
    return s === 'pending' || s === 'not paid';
  });
  const paidUSD = paidReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const pendingUSD = pendingReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);

  // Calculate actual balance: paid receipts - used funds
  // This shows how much money from receipts is actually available
  const totalUsedFromReceipts = paidReceipts.reduce((sum, r) => {
    const stats = getReceiptUsageStats(r);
    return sum + (stats.usedUSD || 0);
  }, 0);
  const availableReceiptBalance = Math.max(paidUSD - totalUsedFromReceipts, 0);
  
  // Collection status (admin collected vs not collected)
  const collectedReceipts = receipts.filter(r => r.collected);
  const notCollectedReceipts = receipts.filter(r => !r.collected);
  const collectedUSD = collectedReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const notCollectedUSD = notCollectedReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const collectionRate = receipts.length > 0 ? ((collectedReceipts.length / receipts.length) * 100).toFixed(1) : 0;

  const deliveryAds = ads.filter(a => a.deliveryStatus && a.deliveryStatus !== 'Office');
  const activeDeliveries = deliveryAds.filter(a => (a.deliveryStatus || '').toLowerCase() !== 'completed').length;
  const completedDeliveries = deliveryAds.filter(a => (a.deliveryStatus || '').toLowerCase() === 'completed').length;

  const adsLast7 = ads.filter(a => new Date(a.createdAt || 0).getTime() >= last7).length;
  const receiptsLast7 = receipts.filter(r => new Date(r.createdAt || 0).getTime() >= last7).length;

  // Top customers by spend
  const spendByCustomer = {};
  ads.forEach(ad => {
    if (!ad.customerId) return;
    spendByCustomer[ad.customerId] = (spendByCustomer[ad.customerId] || 0) + (ad.amountUSD || 0);
  });
  const topCustomers = Object.entries(spendByCustomer)
    .map(([customerId, spend]) => ({
      customerId,
      name: state.customers.find(c => c.id === customerId)?.name || 'Unknown',
      spend
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);

  // Top pages by ad count
  const adsByPage = {};
  ads.forEach(ad => {
    if (!ad.pageId) return;
    adsByPage[ad.pageId] = (adsByPage[ad.pageId] || 0) + 1;
  });
  const topPages = Object.entries(adsByPage)
    .map(([pageId, count]) => ({
      pageId,
      name: state.pages.find(p => p.id === pageId)?.name || 'Unknown',
      count
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Recent activity (ads + receipts)
  const recentItems = [
    ...ads.map(ad => ({ type: 'Ad', name: state.customers.find(c => c.id === ad.customerId)?.name || 'Unknown', value: ad.amountUSD || 0, status: ad.status || 'Pending', at: ad.createdAt })),
    ...receipts.map(r => ({ type: 'Receipt', name: state.customers.find(c => c.id === r.customerId)?.name || 'Unknown', value: r.amountUSD || 0, status: r.status || 'Paid', at: r.createdAt }))
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 6);

  const renderProgress = (label, value, target, color) => {
    const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
    return `
      <div class="flex items-center justify-between text-xs font-medium mb-1">
        <span class="text-slate-500">${label}</span>
        <span class="text-slate-700 dark:text-slate-200">${value.toLocaleString()} / ${target.toLocaleString()}</span>
      </div>
      <div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div class="h-2 ${color} rounded-full" style="width:${pct}%"></div>
      </div>
    `;
  };

  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 class="text-3xl font-bold text-slate-900 dark:text-white">${t('analytics')}</h1>
          <p class="text-sm text-slate-500">Advanced tracking across revenue, receipts, delivery, and activity</p>
        </div>
        <div class="flex items-center gap-3">
          <div class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-200">Last 7 days: ${adsLast7} ads • ${receiptsLast7} receipts</div>
          <div class="px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-xs font-semibold text-emerald-700 dark:text-emerald-300">Users: ${users.length}</div>
        </div>
      </div>

      <!-- KPI Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <!-- Show paid ad revenue separately for clarity -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform">
          <div class="absolute inset-0 bg-gradient-to-br from-emerald-500 to-teal-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Ad Revenue (Paid)</p>
              <p class="text-2xl font-bold text-slate-800 dark:text-white">$${paidAdRevenue.toFixed(2)}</p>
              <p class="text-xs text-slate-500 mt-1">Pending: $${unpaidAdRevenue.toFixed(2)}</p>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg">
              <i data-lucide="dollar-sign" class="w-6 h-6 text-white"></i>
            </div>
          </div>
        </div>
        ${renderStatCard('Receipts Volume', '$' + totalReceiptsUSD.toFixed(2), 'file-text', 'from-indigo-500 to-purple-600')}
        <!-- Show available balance (paid receipts - used) -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform">
          <div class="absolute inset-0 bg-gradient-to-br from-blue-500 to-cyan-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Available Balance</p>
              <p class="text-2xl font-bold text-slate-800 dark:text-white">$${availableReceiptBalance.toFixed(2)}</p>
              <p class="text-xs text-slate-500 mt-1">Used: $${totalUsedFromReceipts.toFixed(2)} / Paid: $${paidUSD.toFixed(2)}</p>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center shadow-lg">
              <i data-lucide="piggy-bank" class="w-6 h-6 text-white"></i>
            </div>
          </div>
        </div>
        
        <!-- Collection Status Card -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform cursor-pointer" onclick="state.receiptCollectedFilter='not-collected';navigateTo('receipts');">
          <div class="absolute inset-0 bg-gradient-to-br from-amber-500 to-orange-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Collection Status</p>
              <div class="flex items-baseline space-x-2">
                <p class="text-2xl font-bold text-slate-800 dark:text-white">${collectedReceipts.length}/${receipts.length}</p>
                <span class="text-sm font-medium ${collectionRate >= 80 ? 'text-emerald-600' : collectionRate >= 50 ? 'text-amber-600' : 'text-rose-600'}">${collectionRate}%</span>
              </div>
              <div class="flex items-center space-x-3 mt-2 text-xs">
                <span class="text-emerald-600 font-medium">✓ $${collectedUSD.toFixed(0)}</span>
                <span class="text-amber-600 font-medium">○ $${notCollectedUSD.toFixed(0)}</span>
              </div>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
              <i data-lucide="wallet" class="w-6 h-6 text-white"></i>
            </div>
          </div>
          <!-- Progress bar -->
          <div class="mt-3 w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all duration-500" style="width: ${collectionRate}%"></div>
          </div>
        </div>
      </div>

      <!-- Tracking Panels -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Revenue & Collections</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40">Cashflow</span>
          </div>
          ${renderProgress('Collected (Receipts)', paidUSD, Math.max(paidUSD + pendingUSD, 1), 'bg-emerald-500')}
          ${renderProgress('Pending (Receipts)', pendingUSD, Math.max(paidUSD + pendingUSD, 1), 'bg-amber-500')}
          ${renderProgress('Ad Revenue (all time)', totalAdRevenue, Math.max(totalAdRevenue, 1), 'bg-indigo-500')}
        </div>

        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Receipts & Transfers</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40">Usage</span>
          </div>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <p class="text-slate-500 text-xs">Receipts</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${receipts.length}</p>
              <p class="text-[11px] text-slate-500">${receiptsLast7} created in last 7 days</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <p class="text-slate-500 text-xs">Transfers</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${receipts.filter(r => r.transfers?.length).length}</p>
              <p class="text-[11px] text-slate-500">With balance moves</p>
            </div>
          </div>
          ${renderProgress('Remaining (vs receipts)', Math.max(totalReceiptsUSD - paidUSD, 0), Math.max(totalReceiptsUSD, 1), 'bg-sky-500')}
        </div>

        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Delivery Tracking</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/40">Drivers</span>
          </div>
          <div class="grid grid-cols-3 gap-3 text-sm">
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Active</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${activeDeliveries}</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Completed</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${completedDeliveries}</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Total</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${deliveryAds.length}</p>
            </div>
          </div>
          ${renderProgress('Delivery completion', completedDeliveries, Math.max(deliveryAds.length, 1), 'bg-emerald-500')}
        </div>
      </div>

      <!-- Lists -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Top Customers (Spend)</h3>
            <i data-lucide="users" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${topCustomers.length === 0 ? '<p class="text-sm text-slate-500">No data</p>' : `
            <div class="space-y-2">
              ${topCustomers.map(c => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(c.name || '')}</p>
                    <p class="text-[11px] text-slate-500">${c.spend.toFixed(2)} USD</p>
                  </div>
                  <span class="text-xs px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40">Top</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Top Pages (Ads)</h3>
            <i data-lucide="layout-dashboard" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${topPages.length === 0 ? '<p class="text-sm text-slate-500">No data</p>' : `
            <div class="space-y-2">
              ${topPages.map(p => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(p.name || '')}</p>
                    <p class="text-[11px] text-slate-500">${p.count} ads</p>
                  </div>
                  <span class="text-xs px-2 py-1 rounded-full bg-sky-50 text-sky-700 dark:bg-sky-900/40">Active</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Recent Activity</h3>
            <i data-lucide="activity" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${recentItems.length === 0 ? '<p class="text-sm text-slate-500">No activity yet</p>' : `
            <div class="space-y-2">
              ${recentItems.map(item => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(item.type || '')}: ${Security.escapeHtml(item.name || '')}</p>
                    <p class="text-[11px] text-slate-500">$${item.value.toFixed(2)} • ${Security.escapeHtml(item.status || '')}</p>
                  </div>
                  <span class="text-[10px] text-slate-400">${item.at ? new Date(item.at).toLocaleDateString() : ''}</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderStatCard(title, value, icon, gradient, onClick = '', isActive = false) {
  const clickable = !!onClick;
  const activeClass = isActive ? ' ring-2 ring-indigo-400/70' : '';
  const clickClass = clickable ? ' cursor-pointer' : '';
  const clickAttr = clickable ? ` onclick="${onClick}"` : '';
  return `
    <div class="glass-panel rounded-xl md:rounded-2xl p-3 md:p-6 hover:scale-105 transition-transform${clickClass}${activeClass}"${clickAttr}>
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-[10px] md:text-sm text-slate-500 font-medium uppercase truncate">${title}</p>
          <p class="text-lg md:text-3xl font-bold mt-1 md:mt-2 truncate">${value}</p>
        </div>
        <div class="w-8 h-8 md:w-12 md:h-12 bg-gradient-to-br ${gradient} rounded-lg md:rounded-xl flex items-center justify-center text-white shadow-lg flex-shrink-0 ml-2">
          <i data-lucide="${icon}" class="w-4 h-4 md:w-6 md:h-6"></i>
        </div>
      </div>
    </div>
  `;
}

function renderProgress(label, value, max, colorClass) {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const displayValue = typeof value === 'number' ? (value >= 1000 ? '$' + value.toFixed(0) : '$' + value.toFixed(2)) : value;
  return `
    <div class="mt-3">
      <div class="flex justify-between text-xs mb-1">
        <span class="text-slate-600 dark:text-slate-400">${label}</span>
        <span class="font-medium text-slate-800 dark:text-white">${displayValue}</span>
      </div>
      <div class="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div class="${colorClass} h-full rounded-full transition-all duration-500" style="width: ${percentage}%"></div>
      </div>
    </div>
  `;
}

let _customerSearchTimer = null;
function onCustomerSearchInput(value) {
  const v = String(value || '');
  const clean = Security.sanitizeInput(v, { maxLength: 200 });
  // #region agent log
  // Hypothesis H2: Search strings can contain quotes; combined with innerHTML templates this can break rendering.
  if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
  try {
    const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
    const hasQuote = v.includes('"');
    const hasApos = v.includes("'");
    const hasAngle = v.includes('<') || v.includes('>');
    if (!dbg.customerSearchLogged && (hasQuote || hasApos || hasAngle)) {
      dbg.customerSearchLogged = true;
        window.__albayanDebugEmit('H2', 'script.js:onCustomerSearchInput', 'customerSearch contains special chars', {len:v.length,hasQuote,hasApos,hasAngle});
    }
  } catch (_) {}
  }
  // #endregion
  state.customerSearch = clean;
  if (_customerSearchTimer) clearTimeout(_customerSearchTimer);
  // Small debounce to keep typing smooth (customer cards can be heavy to compute).
  _customerSearchTimer = setTimeout(() => {
    _customerSearchTimer = null;
    updateCustomersViewFiltered();
  }, 60);
}

function updateCustomersViewFiltered() {
  if (state.currentView !== 'customers') return;
  const grid = document.getElementById('customers-grid');
  const countEl = document.getElementById('customers-count');
  if (!grid || !countEl) return;

  const allCustomers = getVisibleRecords(state.customers);
  const visibleCustomers = getFilteredCustomers();

  countEl.textContent = `${visibleCustomers.length} of ${allCustomers.length} customers`;
  grid.innerHTML = renderCustomersGrid(visibleCustomers);
  if (window.lucide) lucide.createIcons();
}

function renderCustomersGrid(customers) {
  if (!Array.isArray(customers) || customers.length === 0) {
    return '<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="users" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No customers found</p></div>';
  }

  const totalCustomers = customers.length;
  return customers.map((c, idx) => {
          const stats = getCustomerStats(c.id);
          const lastAdText = stats.lastAdDate 
            ? new Date(stats.lastAdDate).toLocaleDateString()
            : 'Never';
          
    const phones = Array.isArray(c.phones) ? c.phones : [];
    const profileLinks = Array.isArray(c.profileLinks) ? c.profileLinks : [];
          // Display number: total - index (so first item = highest number, matching newest-first sort)
          const displayNum = totalCustomers - idx;
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform" data-customer-id="${c.id}">
              <div class="flex justify-between items-start mb-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded-md bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 text-xs font-bold">#${displayNum}</span>
                  <h3 class="font-bold text-lg text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</h3>
                  </div>
                  <div class="flex items-center space-x-2 mt-1">
                    <span class="text-xs px-2 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full">${Security.escapeHtml(c.platform || '')}</span>
                    ${stats.linkedPagesCount > 0 ? `<span class="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">${stats.linkedPagesCount} pages</span>` : ''}
                  </div>
                </div>
                <div class="flex space-x-1">
                  <button onclick="editCustomer('${c.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="Edit">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  <button onclick="deleteCustomer('${c.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>

              <div class="space-y-2 text-sm border-t border-slate-200 dark:border-slate-700 pt-3">
                <div class="flex items-start space-x-2">
                  <i data-lucide="phone" class="w-4 h-4 text-slate-400 mt-0.5"></i>
                  <div class="flex-1">
              ${phones.length > 0 ? phones.map(phone => `<div class="text-slate-700 dark:text-slate-300">${Security.escapeHtml(phone || '')}</div>`).join('') : '<span class="text-slate-400">No phone</span>'}
                  </div>
                </div>

          ${profileLinks.length > 0 ? `
                  <div class="flex items-start space-x-2">
                    <i data-lucide="link" class="w-4 h-4 text-slate-400 mt-0.5"></i>
                    <div class="flex-1">
                ${profileLinks.map(link => `<a href="${Security.escapeHtml(link || '')}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-700 text-xs block truncate">${Security.escapeHtml(link || '')}</a>`).join('')}
                    </div>
                  </div>
                ` : ''}

                <!-- Last Ad -->
                <div class="flex items-center space-x-2 text-xs">
                  <i data-lucide="clock" class="w-3 h-3 text-slate-400"></i>
                  <span class="text-slate-600 dark:text-slate-400">Last ad: ${lastAdText}</span>
                </div>

                <!-- Financial Summary -->
                <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <!-- LYD Section - TOTAL PAID -->
                  <div class="mb-2">
                    <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">Total Paid (LYD)</div>
                    <div class="grid grid-cols-3 gap-1 text-xs">
                      <div class="text-center p-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                        <div class="text-[10px] text-slate-400">Spent</div>
                        <div class="font-bold text-slate-700 dark:text-slate-300">${stats.totalSpentLYD.toFixed(0)}</div>
                      </div>
                      <div class="text-center p-1.5 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                        <div class="text-[10px] text-emerald-600">Paid</div>
                        <div class="font-bold text-emerald-600">${stats.totalPaidLYD.toFixed(0)}</div>
                      </div>
                      <div class="text-center p-1.5 ${stats.balanceLYD >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-rose-50 dark:bg-rose-900/20'} rounded-lg">
                        <div class="text-[10px] ${stats.balanceLYD >= 0 ? 'text-blue-600' : 'text-rose-600'}">Balance</div>
                        <div class="font-bold ${stats.balanceLYD >= 0 ? 'text-blue-600' : 'text-rose-600'}">${stats.balanceLYD >= 0 ? '+' : ''}${stats.balanceLYD.toFixed(0)}</div>
                      </div>
                    </div>
                  </div>
                  <!-- USD Section - TOTAL ADS CREDIT -->
                  <div>
                    <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">Ads Credit (USD)</div>
                    <div class="grid grid-cols-3 gap-1 text-xs">
                      <div class="text-center p-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                        <div class="text-[10px] text-slate-400">Spent</div>
                        <div class="font-bold text-slate-700 dark:text-slate-300">$${stats.totalSpentUSD.toFixed(2)}</div>
                      </div>
                      <div class="text-center p-1.5 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                        <div class="text-[10px] text-emerald-600">Paid</div>
                        <div class="font-bold text-emerald-600">$${stats.totalPaidUSD.toFixed(2)}</div>
                      </div>
                      <div class="text-center p-1.5 ${stats.balanceUSD >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-rose-50 dark:bg-rose-900/20'} rounded-lg">
                        <div class="text-[10px] ${stats.balanceUSD >= 0 ? 'text-blue-600' : 'text-rose-600'}">Balance</div>
                        <div class="font-bold ${stats.balanceUSD >= 0 ? 'text-blue-600' : 'text-rose-600'}">${stats.balanceUSD >= 0 ? '+' : ''}$${stats.balanceUSD.toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
  }).join('');
}

function renderCustomersView() {
  const visibleCustomers = getFilteredCustomers();
  const allCustomers = getVisibleRecords(state.customers);
  
  // Calculate overall stats
  let totalRevenue = 0;
  let totalDebts = 0;
  
  allCustomers.forEach(c => {
    const stats = getCustomerStats(c.id);
    totalRevenue += stats.totalPaid;
    if (stats.balance < 0) {
      totalDebts += Math.abs(stats.balance);
    }
  });
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('customers')}</h1>
          <p id="customers-count" class="text-sm text-slate-500 mt-1">${visibleCustomers.length} of ${allCustomers.length} customers</p>
        </div>
        <button onclick="showCustomerModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="user-plus" class="w-4 h-4"></i>
          <span>${t('addCustomer')}</span>
        </button>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        ${renderStatCard('Total Customers', allCustomers.length, 'users', 'from-indigo-500 to-purple-600')}
        ${renderStatCard('Lifetime Revenue (Receipts)', totalRevenue.toFixed(0) + ' LYD', 'dollar-sign', 'from-emerald-500 to-teal-600')}
        ${renderStatCard('Outstanding Debts', totalDebts.toFixed(0) + ' LYD', 'alert-circle', 'from-rose-500 to-pink-600')}
      </div>

      <!-- Search and Filters -->
      <div class="glass-panel rounded-xl p-4">
        <div class="flex flex-col md:flex-row gap-4">
          <input type="text" id="customer-search" placeholder="Search customers..." value="${Security.escapeHtml(state.customerSearch || '')}" class="flex-1 glass-input px-4 py-2 rounded-lg" oninput="onCustomerSearchInput(this.value)" autocomplete="off" />
          
          <div class="flex gap-2">
            <!-- Sort Dropdown -->
            <div class="relative">
              <select id="customer-sort" onchange="state.customerSort = this.value; render();" class="glass-input px-4 py-2 pr-10 rounded-lg appearance-none cursor-pointer">
                <option value="newest" ${state.customerSort === 'newest' ? 'selected' : ''}>Newest First</option>
                <option value="oldest" ${state.customerSort === 'oldest' ? 'selected' : ''}>Oldest First</option>
                <option value="lastActive" ${state.customerSort === 'lastActive' ? 'selected' : ''}>Last Active (Recently)</option>
                <option value="highestPaid" ${state.customerSort === 'highestPaid' ? 'selected' : ''}>Highest Paid (Revenue)</option>
                <option value="lowestPaid" ${state.customerSort === 'lowestPaid' ? 'selected' : ''}>Lowest Paid</option>
                <option value="mostSpend" ${state.customerSort === 'mostSpend' ? 'selected' : ''}>Most Spend (Ads)</option>
                <option value="leastSpend" ${state.customerSort === 'leastSpend' ? 'selected' : ''}>Least Spend</option>
                <option value="biggestCredit" ${state.customerSort === 'biggestCredit' ? 'selected' : ''}>Biggest Credit Balance</option>
                <option value="highestDebt" ${state.customerSort === 'highestDebt' ? 'selected' : ''}>Highest Debt</option>
              </select>
              <i data-lucide="arrow-up-down" class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"></i>
            </div>
            
            <!-- Financial Filter -->
            <div class="relative">
              <select id="customer-financial-filter" onchange="state.customerFinancialFilter = this.value; render();" class="glass-input px-4 py-2 pr-10 rounded-lg appearance-none cursor-pointer">
                <option value="all" ${state.customerFinancialFilter === 'all' ? 'selected' : ''}>All Financials</option>
                <option value="hasCredit" ${state.customerFinancialFilter === 'hasCredit' ? 'selected' : ''}>Has Credit</option>
                <option value="hasDebt" ${state.customerFinancialFilter === 'hasDebt' ? 'selected' : ''}>Has Debt</option>
              </select>
              <i data-lucide="filter" class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"></i>
            </div>
          </div>
        </div>
      </div>

      <div id="customers-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${renderCustomersGrid(visibleCustomers)}
      </div>
    </div>
  `;
}

function renderReceiptsView() {
  const allReceipts = getVisibleRecords(state.receipts);
  
  // Apply filters
  let filteredReceipts = allReceipts.filter(receipt => {
    const customer = state.customers.find(c => c.id === receipt.customerId);
    const customerName = customer?.name?.toLowerCase() || '';
    const finalNo = (receipt.finalReceiptNo || receipt.serialNumber || '').toLowerCase();
    const tempNo = (receipt.tempReceiptNo || '').toLowerCase();
    const phoneNumber = (receipt.phoneNumber || '').toLowerCase();
    const searchTerm = (state.receiptSearch || '').toLowerCase();
    
    // Search filter
    if (searchTerm && !customerName.includes(searchTerm) && !finalNo.includes(searchTerm) && !tempNo.includes(searchTerm) && !phoneNumber.includes(searchTerm)) {
      return false;
    }
    
    // Status filter
    if (state.receiptStatusFilter !== 'all') {
      const status = (receipt.status || '').toLowerCase();
      if (status !== state.receiptStatusFilter.toLowerCase()) return false;
    }
    
    // Payment method filter
    if (state.receiptPaymentFilter !== 'all') {
      const paymentMethod = (receipt.paymentMethod || '').toLowerCase();
      if (!paymentMethod.includes(state.receiptPaymentFilter.toLowerCase())) return false;
    }
    
    // Date filter
    if (state.receiptDateFilter !== 'all') {
      const receiptDate = new Date(receipt.createdAt || receipt.startDate);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      if (state.receiptDateFilter === 'today' && receiptDate < today) return false;
      if (state.receiptDateFilter === 'week' && receiptDate < weekAgo) return false;
      if (state.receiptDateFilter === 'month' && receiptDate < monthAgo) return false;
    }
    
    // Collected filter
    if (state.receiptCollectedFilter !== 'all') {
      if (state.receiptCollectedFilter === 'collected' && !receipt.collected) return false;
      if (state.receiptCollectedFilter === 'not-collected' && receipt.collected) return false;
    }
    
    return true;
  });
  
  // Sort receipts
  filteredReceipts.sort((a, b) => {
    const dateA = new Date(a.createdAt || a.startDate);
    const dateB = new Date(b.createdAt || b.startDate);
    
    switch (state.receiptSortBy) {
      case 'oldest':
        return dateA - dateB;
      case 'amount-high':
        return (b.amountUSD || 0) - (a.amountUSD || 0);
      case 'amount-low':
        return (a.amountUSD || 0) - (b.amountUSD || 0);
      case 'newest':
      default:
        return dateB - dateA;
    }
  });
  
  const hasActiveFilters = state.receiptSearch || state.receiptStatusFilter !== 'all' || state.receiptPaymentFilter !== 'all' || state.receiptDateFilter !== 'all' || state.receiptCollectedFilter !== 'all';
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('receipts')}</h1>
          <p id="receipts-count" class="text-sm text-slate-500 mt-1">${filteredReceipts.length}${hasActiveFilters ? ` of ${allReceipts.length}` : ''} receipts</p>
        </div>
        <button onclick="showReceiptModal()" class="btn-shine bg-purple-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="receipt" class="w-4 h-4"></i>
          <span>New Receipt</span>
        </button>
      </div>

      <!-- Search & Filter Bar -->
      <div class="glass-panel rounded-2xl p-4">
        <div class="flex flex-col lg:flex-row gap-4">
          <!-- Search Input -->
          <div class="flex-1 relative">
            <i data-lucide="search" class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              id="receipt-search-input"
              placeholder="Search by customer, serial #, or phone..." 
              value="${Security.escapeHtml(state.receiptSearch || '')}"
              oninput="updateReceiptSearch(this.value)"
              class="w-full pl-12 pr-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20 transition-all placeholder:text-slate-400"
            />
            <span id="receipt-search-clear">${state.receiptSearch ? `<button onclick="clearReceiptSearch()" class="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>` : ''}</span>
          </div>
          
          <!-- Filter Dropdowns -->
          <div class="flex flex-wrap gap-2">
            <!-- Status Filter -->
            <select onchange="updateReceiptFilter('status', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptStatusFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptStatusFilter === 'all' ? 'selected' : ''}>All Status</option>
              <option value="paid" ${state.receiptStatusFilter === 'paid' ? 'selected' : ''}>✓ Paid</option>
              <option value="pending" ${state.receiptStatusFilter === 'pending' ? 'selected' : ''}>⏳ Pending</option>
              <option value="cancelled" ${state.receiptStatusFilter === 'cancelled' ? 'selected' : ''}>✕ Cancelled</option>
            </select>
            
            <!-- Payment Method Filter -->
            <select onchange="updateReceiptFilter('payment', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptPaymentFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptPaymentFilter === 'all' ? 'selected' : ''}>All Payments</option>
              <option value="cash" ${state.receiptPaymentFilter === 'cash' ? 'selected' : ''}>💵 Cash</option>
              <option value="usdt" ${state.receiptPaymentFilter === 'usdt' ? 'selected' : ''}>💎 USDT</option>
              <option value="bank" ${state.receiptPaymentFilter === 'bank' ? 'selected' : ''}>🏦 Bank Transfer</option>
              <option value="split" ${state.receiptPaymentFilter === 'split' ? 'selected' : ''}>📊 Split Payment</option>
            </select>
            
            <!-- Date Filter -->
            <select onchange="updateReceiptFilter('date', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptDateFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptDateFilter === 'all' ? 'selected' : ''}>All Time</option>
              <option value="today" ${state.receiptDateFilter === 'today' ? 'selected' : ''}>📅 Today</option>
              <option value="week" ${state.receiptDateFilter === 'week' ? 'selected' : ''}>📆 This Week</option>
              <option value="month" ${state.receiptDateFilter === 'month' ? 'selected' : ''}>🗓️ This Month</option>
            </select>
            
            <!-- Collected Filter -->
            <select onchange="updateReceiptFilter('collected', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptCollectedFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptCollectedFilter === 'all' ? 'selected' : ''}>All Collection</option>
              <option value="collected" ${state.receiptCollectedFilter === 'collected' ? 'selected' : ''}>✓ Collected</option>
              <option value="not-collected" ${state.receiptCollectedFilter === 'not-collected' ? 'selected' : ''}>○ Not Collected</option>
            </select>
            
            <!-- Sort By -->
            <select onchange="updateReceiptFilter('sort', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer">
              <option value="newest" ${state.receiptSortBy === 'newest' ? 'selected' : ''}>🕐 Newest First</option>
              <option value="oldest" ${state.receiptSortBy === 'oldest' ? 'selected' : ''}>🕐 Oldest First</option>
              <option value="amount-high" ${state.receiptSortBy === 'amount-high' ? 'selected' : ''}>💰 Highest Amount</option>
              <option value="amount-low" ${state.receiptSortBy === 'amount-low' ? 'selected' : ''}>💰 Lowest Amount</option>
            </select>
            
            <!-- Clear Filters Button (span uses display:contents so the button stays a direct flex item) -->
            <span id="receipt-clear-filters" class="contents">${hasActiveFilters ? `
              <button onclick="clearAllReceiptFilters()" class="px-4 py-3 bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-2 border-rose-200 dark:border-rose-800 rounded-xl text-sm font-bold hover:bg-rose-200 dark:hover:bg-rose-900/50 transition-all flex items-center space-x-2">
                <i data-lucide="x-circle" class="w-4 h-4"></i>
                <span>Clear</span>
              </button>
            ` : ''}</span>
          </div>
        </div>
        
        <!-- Active Filters Display -->
        <div id="receipt-active-filters">${hasActiveFilters ? `
          <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
            <span class="text-xs font-medium text-slate-500">Active filters:</span>
            ${state.receiptSearch ? `<span class="px-2 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full text-xs font-medium flex items-center"><i data-lucide="search" class="w-3 h-3 mr-1"></i>"${Security.escapeHtml(state.receiptSearch)}"</span>` : ''}
            ${state.receiptStatusFilter !== 'all' ? `<span class="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-xs font-medium">${state.receiptStatusFilter}</span>` : ''}
            ${state.receiptPaymentFilter !== 'all' ? `<span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded-full text-xs font-medium">${state.receiptPaymentFilter}</span>` : ''}
            ${state.receiptDateFilter !== 'all' ? `<span class="px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full text-xs font-medium">${state.receiptDateFilter}</span>` : ''}
            ${state.receiptCollectedFilter !== 'all' ? `<span class="px-2 py-1 ${state.receiptCollectedFilter === 'collected' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300'} rounded-full text-xs font-medium">${state.receiptCollectedFilter}</span>` : ''}
          </div>
        ` : ''}</div>
      </div>

      <div id="receipts-grid" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        ${filteredReceipts.length === 0 ? `<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="${hasActiveFilters ? 'search-x' : 'receipt'}" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">${hasActiveFilters ? 'No receipts match your filters' : 'No receipts yet'}</p>${hasActiveFilters ? '<button onclick="clearAllReceiptFilters()" class="mt-4 text-purple-600 hover:text-purple-700 font-medium">Clear all filters</button>' : ''}</div>` : filteredReceipts.map((receipt, idx) => {
          const customer = state.customers.find(c => c.id === receipt.customerId);
          const displayFinalNo = receipt.finalReceiptNo || receipt.serialNumber || '';
          const displayTempNo = receipt.tempReceiptNo || '';
          // Display number: total - index (so first item = highest number, matching newest-first sort)
          const receiptDisplayNum = filteredReceipts.length - idx;
          // Normalize payments
          const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
          const hasMultiplePayments = payments.length > 1;

          // Calculate total paid as sum of R1 values (amount × rate)
          const totalPaid = payments.reduce((sum, p) => sum + ((p.amount || 0) * (p.rate || 1)), 0) || receipt.amountLocal;
          const usage = getReceiptUsageStats(receipt);
          const hasTransfers = (receipt.transfers && receipt.transfers.length > 0);
          const lastTransfer = hasTransfers ? receipt.transfers[receipt.transfers.length - 1] : null;
          const lastTransferName = lastTransfer ? (state.customers.find(c => c.id === lastTransfer.toCustomerId)?.name || 'Unknown') : '';
          const lastTransferNameSafe = Security.escapeHtml(String(lastTransferName || ''));
          // Defensive: ensure exchange rate is always positive and reasonable
          const rawFxRate = (receipt.exchangeRate || state.defaultExchangeRate || 1);
          const fxRate = (typeof rawFxRate === 'number' && rawFxRate > 0 && rawFxRate < 1000) ? rawFxRate : 1;
          const remainingLYD = (usage.remainingUSD || 0) * fxRate;
          const spentLYD = (usage.usedUSD || 0) * fxRate;

          const creatorId = receipt.createdBy || receipt.creatorId || '';
          const creatorNameRaw = creatorId
            ? (state.users.find(u => String(u.id) === String(creatorId))?.name || (creatorId === 'system' ? 'System' : 'Unknown'))
            : 'Unknown';
          const creatorName = Security.escapeHtml(String(creatorNameRaw || 'Unknown'));
          
          return `
            <div class="glass-panel rounded-2xl p-6 hover:scale-[1.01] transition-transform">
              <div class="flex justify-between items-start mb-4">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-xs font-bold">#${receiptDisplayNum}</span>
                  <h3 class="text-lg font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                  </div>
                  ${(displayTempNo || displayFinalNo) ? `
                    <p class="text-sm text-indigo-600 font-medium">
                      Serial: ${displayTempNo && displayFinalNo ? `${displayTempNo} → ${displayFinalNo}` : (displayTempNo ? `${displayTempNo} (Temp)` : displayFinalNo)}
                    </p>
                  ` : ''}
                  <p class="text-xs text-slate-400 mt-1">${new Date(receipt.createdAt || receipt.startDate).toLocaleString()}</p>
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-slate-500">
                    <span class="inline-flex items-center gap-1" title="Created by">
                      <i data-lucide="user" class="w-3 h-3"></i>
                      <span>${state.language === 'ar' ? 'تم الإنشاء بواسطة' : 'Created by'}: <span class="font-medium text-slate-700 dark:text-slate-300">${creatorName}</span></span>
                    </span>
                    <span class="inline-flex items-center gap-1" title="Ads credit usage from this receipt">
                      <i data-lucide="trending-down" class="w-3 h-3"></i>
                      <span>${state.language === 'ar' ? 'رصيد الإعلانات' : 'Ads credit'}: <span class="font-semibold text-emerald-600">$${usage.usedUSD.toFixed(2)}</span> ${state.language === 'ar' ? 'مصروف' : 'spent'} • <span class="font-semibold text-blue-600">$${usage.remainingUSD.toFixed(2)}</span> ${state.language === 'ar' ? 'متبقي' : 'left'} <span class="text-slate-400">(${remainingLYD.toFixed(2)} LYD)</span></span>
                    </span>
                  </div>
                  ${receipt.updatedAt ? `
                    <div class="flex items-center mt-0.5 space-x-2">
                      <p class="text-[10px] text-amber-500 flex items-center"><i data-lucide="edit-3" class="w-2.5 h-2.5 mr-1"></i>Edited: ${new Date(receipt.updatedAt).toLocaleString()}</p>
                      ${receipt.editCount ? `<button onclick="showReceiptEditHistory('${receipt.id}')" class="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors font-medium">${receipt.editCount} edit${receipt.editCount > 1 ? 's' : ''}</button>` : ''}
                    </div>
                  ` : ''}
                </div>
                <div class="text-right">
                  <div class="text-2xl font-bold text-emerald-600">$${receipt.amountUSD?.toFixed(2)}</div>
                  <div class="text-sm text-slate-500">${receipt.amountLocal?.toFixed(2)} LYD</div>
                  ${receipt.isPaid ? '<div class="text-xs text-emerald-600 mt-1">✓ Paid</div>' : '<div class="text-xs text-amber-600 mt-1">⏳ Unpaid</div>'}
                  ${receipt.paymentResult ? `
                    <div class="text-[10px] mt-1 ${receipt.paymentResult === 'UNDERPAID' ? 'text-rose-600' : receipt.paymentResult === 'OVERPAID' ? 'text-blue-600' : 'text-emerald-600'} font-bold">
                      ${receipt.paymentResult === 'PAID_EXACT' ? 'Paid exact' : receipt.paymentResult === 'OVERPAID' ? `Overpaid +${Number(receipt.overpaidAmount || 0).toFixed(0)} LYD` : `Remaining ${Number(receipt.remainingDue || 0).toFixed(0)} LYD`}
                    </div>
                  ` : ''}
                  ${receipt.feeDifferenceStatus ? `
                    <div class="text-[10px] ${receipt.feeDifferenceStatus === 'SAME' ? 'text-slate-500' : receipt.feeDifferenceStatus === 'LOWER' ? 'text-amber-600' : 'text-purple-600'} font-bold">
                      Fee ${receipt.feeDifferenceStatus.toLowerCase()}
                    </div>
                  ` : ''}
                  ${hasTransfers ? `<div class="text-xs text-blue-600 mt-1 flex items-center justify-end space-x-1" title="Transferred${lastTransferNameSafe ? ' to ' + lastTransferNameSafe : ''}"><i data-lucide="swap" class="w-3 h-3"></i><span>Transferred</span></div>` : ''}
                </div>
              </div>

              <div class="space-y-2 mb-4 text-sm border-t border-b border-slate-200 dark:border-slate-700 py-3">
                <div class="flex justify-between"><span class="text-slate-500">Exchange Rate:</span><span class="font-medium">${receipt.exchangeRate?.toFixed(2)}</span></div>
                ${receipt.officeFee ? `<div class="flex justify-between"><span class="text-slate-500">Office Fee:</span><span class="font-medium text-amber-600">+${receipt.officeFee?.toFixed(2)} LYD</span></div>` : ''}
                ${receipt.discount ? `<div class="flex justify-between"><span class="text-slate-500">Discount:</span><span class="font-medium text-emerald-600">-${receipt.discount?.toFixed(2)} LYD</span></div>` : ''}
              </div>

              ${hasMultiplePayments ? `
                <div class="mb-4">
                  <h4 class="text-xs font-bold text-slate-500 uppercase mb-2 flex items-center">
                    <i data-lucide="credit-card" class="w-3 h-3 mr-1"></i>
                    Split Payments (${payments.length})
                  </h4>
                  <div class="space-y-2">
                    ${payments.map((payment, idx) => {
                      // Calculate R1 = amount × rate
                      const r1 = (payment.amount || 0) * (payment.rate || 1);
                      return `
                      <div class="split-payment-item flex justify-between items-center">
                        <div>
                          <span class="font-medium text-sm">${payment.method}</span>
                          ${payment.collectionType ? `<span class="text-xs text-slate-500 ml-2 px-2 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">${payment.collectionType}</span>` : ''}
                          ${payment.deliveryPersonId ? `<div class="text-xs text-slate-500">${Security.escapeHtml(state.users.find(u => u.id === payment.deliveryPersonId)?.name || 'Unknown')}</div>` : ''}
                        </div>
                        <div class="text-right">
                          <div class="font-bold text-indigo-600">${r1.toFixed(2)} LYD</div>
                          ${payment.rate ? `<div class="text-xs text-slate-500">@ ${payment.rate}</div>` : ''}
                        </div>
                      </div>
                    `}).join('')}
                  </div>
                  <div class="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between font-bold text-emerald-600">
                    <span>Total Paid:</span><span>${totalPaid.toFixed(2)} LYD</span>
                  </div>
                </div>
              ` : `
                <div class="mb-4">
                  <h4 class="text-xs font-bold text-slate-500 uppercase mb-2 flex items-center">
                    <i data-lucide="activity" class="w-3 h-3 mr-1"></i>
                    Usage & Balance
                  </h4>
                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="link-2" class="w-3 h-3"></i><span>Linked Ads</span>
                      </div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">${usage.fundedAds.length}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="dollar-sign" class="w-3 h-3"></i><span>Usage</span>
                      </div>
                      <div class="font-bold text-emerald-600">$${usage.usedUSD.toFixed(2)} used</div>
                      <div class="text-xs text-slate-500">Left: $${usage.remainingUSD.toFixed(2)} (${remainingLYD.toFixed(2)} LYD)</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="gauge" class="w-3 h-3"></i><span>Status</span>
                      </div>
                      <span class="status-badge status-${usage.usageStatus.toLowerCase().replace(' ', '-')}">${usage.usageStatus}</span>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="clock" class="w-3 h-3"></i><span>Last Used</span>
                      </div>
                      <div class="text-xs text-slate-600 dark:text-slate-400">${formatDateShort(usage.lastUsedAt)}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="check-circle" class="w-3 h-3"></i><span>Used?</span>
                      </div>
                      <div class="text-xs font-medium ${usage.usedUSD > 0 ? 'text-emerald-600' : 'text-amber-600'}">
                        ${usage.usedUSD === 0 ? 'Not used yet' : (usage.remainingUSD === 0 ? 'Fully used' : 'Partially used')}
                      </div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="calendar" class="w-3 h-3"></i><span>Total Allocated</span>
                      </div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">$${usage.totalUSD.toFixed(2)}</div>
                    </div>
                    <div class="col-span-2 flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40">
                      <div class="text-xs text-slate-600 dark:text-slate-300 flex items-center space-x-2">
                        <i data-lucide="swap" class="w-3 h-3"></i>
                        <span>Transferred: $${usage.transferredUSD.toFixed(2)}</span>
                        ${hasTransfers && lastTransferName ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-100">Last: ${lastTransferName}</span>` : ''}
                      </div>
                      <div class="flex items-center space-x-3">
                        ${hasTransfers ? `<button class="text-xs text-blue-600 hover:text-blue-700" title="View transfer history" onclick="showReceiptTransferHistory('${receipt.id}')">History</button>` : ''}
                        <button class="text-xs text-blue-600 hover:text-blue-700" title="Transfer balance" onclick="showReceiptTransferModal('${receipt.id}')">Transfer</button>
                      </div>
                    </div>
                  </div>
                </div>
              `}

              ${receipt.receiptImage ? `<div class="mb-4"><img src="${Security.escapeHtml(receipt.receiptImage)}" alt="Receipt" class="w-full h-32 object-cover rounded-lg border border-slate-200 dark:border-slate-700" /></div>` : ''}

              <!-- Collected Toggle -->
              <div class="flex items-center justify-between py-2 px-3 mb-3 rounded-xl ${receipt.collected ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800' : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'}">
                <div class="flex items-center space-x-2">
                  <i data-lucide="${receipt.collected ? 'check-circle-2' : 'circle'}" class="w-4 h-4 ${receipt.collected ? 'text-emerald-600' : 'text-amber-600'}"></i>
                  <span class="text-sm font-medium ${receipt.collected ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}">
                    ${receipt.collected ? 'Collected' : 'Not Collected'}
                  </span>
                  ${receipt.collectedAt ? `<span class="text-[10px] text-slate-500">${new Date(receipt.collectedAt).toLocaleDateString()}</span>` : ''}
                  ${receipt.collectedBy ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400">${Security.escapeHtml(state.users.find(u => u.id === receipt.collectedBy)?.name || 'Admin')}</span>` : ''}
                </div>
                <button onclick="toggleReceiptCollected('${receipt.id}')" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${receipt.collected ? 'bg-amber-100 hover:bg-amber-200 text-amber-700 dark:bg-amber-900/40 dark:hover:bg-amber-900/60 dark:text-amber-300' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700 dark:bg-emerald-900/40 dark:hover:bg-emerald-900/60 dark:text-emerald-300'}">
                  ${receipt.collected ? 'Mark Not Collected' : 'Mark Collected'}
                </button>
              </div>

              <div class="flex flex-col space-y-2 pt-3 border-t border-slate-200 dark:border-slate-700">
                <div class="flex justify-between items-center">
                  <span class="status-badge status-${(receipt.status || '').toLowerCase()}">${receipt.status || 'Unknown'}</span>
                  <div class="flex space-x-2">
                    <button onclick="showReceiptTransferModal('${receipt.id}')" class="text-blue-600 hover:text-blue-700" title="Transfer balance">
                      <i data-lucide="swap" class="w-4 h-4"></i>
                    </button>
                    <button onclick="editReceipt('${receipt.id}')" class="text-blue-600 hover:text-blue-700" title="Edit"><i data-lucide="edit" class="w-4 h-4"></i></button>
                    <button onclick="window.print()" class="text-slate-600 hover:text-slate-700" title="Print"><i data-lucide="printer" class="w-4 h-4"></i></button>
                    <button onclick="deleteReceipt('${receipt.id}')" class="text-rose-600 hover:text-rose-700" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderPagesView() {
  const visiblePages = getVisibleRecords(state.pages);
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('pages')}</h1>
          <p class="text-sm text-slate-500 mt-1">${visiblePages.length} Facebook pages</p>
        </div>
        <button onclick="showPageModal()" class="btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="file-plus" class="w-4 h-4"></i>
          <span>${t('addPage')}</span>
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${visiblePages.length === 0 ? '<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="file-text" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No pages yet</p></div>' : visiblePages.map((p, idx) => {
          const linkedCustomers = p.customerIds ? p.customerIds.map(cid => state.customers.find(c => c.id === cid)).filter(Boolean) : [];
          const pageAds = getVisibleRecords(state.ads).filter(ad => ad.pageId === p.id && ad.recordType === 'ad');
          
          // Calculate page statistics
          const totalSpent = pageAds.reduce((sum, ad) => sum + (ad.adSpent || 0), 0);
          const lastAdDate = pageAds.length > 0 
            ? Math.max(...pageAds.map(ad => new Date(ad.date || ad.createdAt).getTime()))
            : null;
          const lastAdText = lastAdDate 
            ? new Date(lastAdDate).toLocaleDateString()
            : 'Never';
          // Display number: total - index (so first item = highest number)
          const pageDisplayNum = visiblePages.length - idx;
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform">
              <div class="flex justify-between items-start mb-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400 text-xs font-bold">#${pageDisplayNum}</span>
                  </div>
                  <h3 class="font-bold text-lg text-slate-800 dark:text-white flex items-center">
                    <i data-lucide="facebook" class="w-4 h-4 mr-2 text-blue-600"></i>
                    ${Security.escapeHtml(p.name || '')}
                  </h3>
                  <p class="text-sm text-slate-500 mt-1">${Security.escapeHtml(p.category || '')}</p>
                </div>
                <div class="flex space-x-1">
                  <button onclick="editPage('${p.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="Edit">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  <button onclick="deletePage('${p.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>

              <div class="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-3">
                <!-- Owner(s) -->
                  <div>
                  <div class="text-xs font-medium text-slate-500 mb-1.5 flex items-center">
                    <i data-lucide="user" class="w-3 h-3 mr-1"></i>
                    Owner${linkedCustomers.length > 1 ? 's' : ''}
                    </div>
                  ${linkedCustomers.length > 0 ? `
                    <div class="space-y-1">
                      ${linkedCustomers.slice(0, 2).map(c => `
                        <div class="text-sm text-slate-700 dark:text-slate-300 flex items-center space-x-2">
                          <span class="w-1.5 h-1.5 bg-indigo-500 rounded-full"></span>
                          <span>${Security.escapeHtml(c.name || '')}</span>
                        </div>
                      `).join('')}
                      ${linkedCustomers.length > 2 ? `<div class="text-xs text-slate-500 ml-3.5">+${linkedCustomers.length - 2} more</div>` : ''}
                    </div>
                  ` : '<div class="text-sm text-slate-400 ml-4">No owner</div>'}
                  </div>

                <!-- Last Ad Time -->
                  <div class="flex items-center space-x-2 text-xs">
                  <i data-lucide="clock" class="w-3 h-3 text-slate-400"></i>
                  <span class="text-slate-600 dark:text-slate-400">Last ad: ${lastAdText}</span>
                  </div>

                <!-- Stats -->
                <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <div class="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div class="text-slate-500 mb-1">Total Ads</div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">${pageAds.length}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 mb-1">Total Spend</div>
                      <div class="font-bold text-emerald-600 dark:text-emerald-400">${totalSpent.toFixed(0)} LYD</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAdsView() {
  const allAds = getFilteredAds();
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('ads')}</h1>
          <p class="text-sm text-slate-500 mt-1">${allAds.length} total ads</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button onclick="showAdModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
            <i data-lucide="plus" class="w-4 h-4"></i>
            <span>${t('addAd')}</span>
          </button>
          <button onclick="window.print()" class="btn-shine bg-slate-600 text-white px-3 py-2 rounded-xl">
            <i data-lucide="printer" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <div class="glass-panel rounded-xl p-4">
        <input type="text" id="ad-search" placeholder="Search ads..." class="w-full glass-input px-4 py-2 rounded-lg" oninput="render()" />
      </div>

      <div class="glass-panel rounded-2xl p-6 overflow-x-auto">
        ${allAds.length === 0 ? '<div class="text-center py-12"><i data-lucide="inbox" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No ads yet</p></div>' : `
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b-2 border-indigo-200 dark:border-indigo-800">
                <th class="text-left py-3 px-2 w-12">#</th>
                <th class="text-left py-3 px-2">Customer</th>
                <th class="text-left py-3 px-2">Amount</th>
                <th class="text-left py-3 px-2">Rate</th>
                <th class="text-left py-3 px-2">Local</th>
                <th class="text-left py-3 px-2">Payment</th>
                <th class="text-left py-3 px-2">Status</th>
                <th class="text-left py-3 px-2">Delivery</th>
                <th class="text-left py-3 px-2">Serial</th>
                <th class="text-left py-3 px-2">Date</th>
                <th class="text-left py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${allAds.map((ad, idx) => {
                const customer = state.customers.find(c => c.id === ad.customerId);
                // For ads linked to delivery receipts, get delivery status from the receipt (source of truth)
                const linkedReceipt = ad.linkedDeliveryReceiptId ? state.receipts.find(r => r.id === ad.linkedDeliveryReceiptId) : null;
                const effectiveDeliveryStatus = linkedReceipt ? (linkedReceipt.deliveryStatus || 'Needs Delivery') : (ad.deliveryStatus || 'Office');
                const effectiveDeliveryPersonId = linkedReceipt ? linkedReceipt.deliveryPersonId : ad.deliveryPersonId;
                const deliveryPerson = effectiveDeliveryPersonId ? state.users.find(u => u.id === effectiveDeliveryPersonId) : null;
                const isLinkedToDeliveryReceipt = !!linkedReceipt;
                // Use consistent exchange rate calculation
                const receiptExchangeRate = getEffectiveExchangeRate(ad);
                // Display number: total - index (so first item = highest number)
                const adDisplayNum = allAds.length - idx;
                return `
                  <tr class="border-b border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td class="py-3 px-2" data-label="#">
                      <div class="font-medium">#${adDisplayNum} - ${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                      ${ad.phoneNumber ? `<div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber)}</div>` : ''}
                    </td>
                    <td class="py-3 px-2 hidden md:table-cell">
                      <div class="font-medium">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                      ${ad.phoneNumber ? `<div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber)}</div>` : ''}
                    </td>
                    <td class="py-3 px-2 font-bold text-emerald-600" data-label="Amount">$${ad.amountUSD?.toFixed(2) || '0.00'}</td>
                    <td class="py-3 px-2" data-label="Rate">${receiptExchangeRate?.toFixed(2) || ad.exchangeRate?.toFixed(2) || '0.00'}</td>
                    <td class="py-3 px-2" data-label="Local">${ad.amountLocal?.toFixed(2)} LYD</td>
                    <td class="py-3 px-2" data-label="Payment"><span class="payment-badge text-xs">${ad.paymentMethod}</span></td>
                    <td class="py-3 px-2" data-label="Status">
                      <select class="glass-input px-2 py-1 rounded-lg text-xs w-full md:w-auto" onchange="updateAdStatusFromList('${ad.id}', this.value)">
                        ${AD_STATUSES.map(s => `<option value="${s}" ${ad.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                      ${ad.isPaid ? '<div class="text-xs text-emerald-600 mt-1">✓ Paid</div>' : ''}
                      ${ad.status === 'Stopped' && ad.spentUSD !== undefined ? `
                        <div class="text-xs mt-1 space-y-0.5">
                          <div class="text-orange-600">Spent: $${ad.spentUSD.toFixed(2)}</div>
                          <div class="text-emerald-600">Remaining: $${((ad.amountUSD || 0) - ad.spentUSD).toFixed(2)}</div>
                        </div>
                      ` : ''}
                    </td>
                    <td class="py-3 px-2" data-label="Delivery">
                      ${isLinkedToDeliveryReceipt ? `
                        <div class="px-2 py-1 rounded-lg text-xs delivery-${effectiveDeliveryStatus.toLowerCase().replace(' ', '')} bg-slate-100 dark:bg-slate-700">
                          ${effectiveDeliveryStatus}
                          <div class="text-[10px] text-slate-400 mt-0.5">via Receipt</div>
                        </div>
                      ` : `
                        <select class="glass-input px-2 py-1 rounded-lg text-xs w-full md:w-auto delivery-${effectiveDeliveryStatus.toLowerCase().replace(' ', '')}" onchange="updateAdDeliveryStatus('${ad.id}', this.value)">
                          ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${effectiveDeliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                      `}
                      ${deliveryPerson ? `<div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(deliveryPerson.name || '')}</div>` : ''}
                    </td>
                    <td class="py-3 px-2" data-label="Serial">
                      ${ad.serialNumber ? `<span class="font-mono text-xs">${ad.serialNumber}</span>` : '-'}
                      ${ad.editCount ? `<button onclick="showAdEditHistory('${ad.id}')" class="block mt-1 text-[10px] px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors font-medium">${ad.editCount} edit${ad.editCount > 1 ? 's' : ''}</button>` : ''}
                    </td>
                    <td class="py-3 px-2 text-xs text-slate-500" data-label="Date">${new Date(ad.startDate).toLocaleDateString()}</td>
                    <td class="py-3 px-2" data-label="Actions">
                      <div class="flex flex-wrap gap-2 md:gap-1 justify-center md:justify-start">
                        <button onclick="manageTopUps('${ad.id}')" class="text-blue-600 hover:text-blue-700 p-2 md:p-0" title="Top-ups">
                          <i data-lucide="trending-up" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.topUps && ad.topUps.length > 0 ? `<span class="text-xs">${ad.topUps.length}</span>` : ''}
                        </button>
                        <button onclick="manageRefund('${ad.id}')" class="text-amber-600 hover:text-amber-700 p-2 md:p-0" title="Refund">
                          <i data-lucide="arrow-left-circle" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.refundType && ad.refundType !== 'None' ? `<span class="text-xs">!</span>` : ''}
                        </button>
                        <button onclick="stopAd('${ad.id}')" class="text-orange-600 hover:text-orange-700 p-2 md:p-0" title="${ad.status === 'Stopped' ? 'Edit Stop Details' : 'Stop Ad'}">
                          <i data-lucide="${ad.status === 'Stopped' ? 'edit' : 'square'}" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.status === 'Stopped' ? '<span class="text-xs">!</span>' : ''}
                        </button>
                        <button onclick="editAd('${ad.id}')" class="text-indigo-600 hover:text-indigo-700 p-2 md:p-0" title="Edit"><i data-lucide="edit" class="w-5 h-5 md:w-4 md:h-4"></i></button>
                        <button onclick="deleteAd('${ad.id}')" class="text-rose-600 hover:text-rose-700 p-2 md:p-0" title="Delete"><i data-lucide="trash-2" class="w-5 h-5 md:w-4 md:h-4"></i></button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;
}

function renderDeliveriesView() {
  // Deliveries are tracked ONLY on receipts (ads are not a delivery source of truth).
  const allReceipts = getVisibleRecords(state.receipts);
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');

  const deliveryReceipts = allReceipts
    .filter(r => {
      if (!r) return false;
      const ds = String(r.deliveryStatus || '').trim();
      if (ds && ds !== 'Office') return true;
      const sd = (r && typeof r.statusDetail === 'object' && r.statusDetail) ? r.statusDetail : {};
      const npc = String(sd.notPaidCollection || '').trim();
      return String(r.status || '').trim() === 'Not Paid' && npc === 'delivery';
    })
    .map(r => ({
      ...r,
      isReceipt: true,
      deliveryStatus: String(r.deliveryStatus || '').trim() || 'Needs Delivery',
      amountLocal: Number(r.amountLocal || 0) || 0,
      amountUSD: Number(r.amountUSD || 0) || 0
    }));

  const deliveredRows = deliveryReceipts.filter(d => d.deliveryStatus === 'Delivered');
  const heldRows = deliveredRows.filter(d => !_isReceivedInOffice(d) && _getCollectedCashLocal(d) > 0);

  const stats = {
    pendingDelivery: deliveryReceipts.filter(d => d.deliveryStatus === 'Needs Delivery').length,
    pendingAssignment: deliveryReceipts.filter(d => !d.deliveryPersonId && d.deliveryStatus !== 'Canceled' && d.deliveryStatus !== 'Delivered').length,
    inProgress: deliveryReceipts.filter(d => d.deliveryStatus === 'In Progress').length,
    delivered: deliveredRows.length,
    completed: deliveredRows.filter(d => _isReceivedInOffice(d) || _getCollectedCashLocal(d) <= 0).length,
    canceled: deliveryReceipts.filter(d => d.deliveryStatus === 'Canceled').length,
    uncollectedLYD: deliveryReceipts.reduce((sum, d) => sum + _getOutstandingDueLocal(d), 0),
    heldByDrivers: heldRows.length,
    driverCashLYD: heldRows.reduce((sum, d) => sum + _getCollectedCashLocal(d), 0),
  };

  const driverPerformance = deliveryUsers.map(driver => {
    const driverDeliveries = deliveryReceipts.filter(d => String(d.deliveryPersonId || '') === String(driver.id || ''));
    const delivered = driverDeliveries.filter(d => d.deliveryStatus === 'Delivered');
    const completed = delivered.filter(d => _isReceivedInOffice(d) || _getCollectedCashLocal(d) <= 0);
    const inProgress = driverDeliveries.filter(d => d.deliveryStatus === 'In Progress');
    const pending = driverDeliveries.filter(d => d.deliveryStatus === 'Needs Delivery');
    const heldCash = delivered.filter(d => !_isReceivedInOffice(d)).reduce((sum, d) => sum + _getCollectedCashLocal(d), 0);
    return {
      ...driver,
      totalAssigned: driverDeliveries.length,
      completed: completed.length,
      inProgress: inProgress.length,
      pending: pending.length,
      heldCash,
      successRate: driverDeliveries.length > 0 ? Math.round((delivered.length / driverDeliveries.length) * 100) : 0
    };
  }).sort((a, b) => b.completed - a.completed);

  const filterStatus = state.deliveryFilter?.status || 'all';
  const filterDriver = state.deliveryFilter?.driver || 'all';
  const searchTerm = state.deliveryFilter?.search || '';

  let filteredDeliveries = [...deliveryReceipts];
  if (filterStatus !== 'all') filteredDeliveries = filteredDeliveries.filter(d => d.deliveryStatus === filterStatus);
  if (filterDriver !== 'all') filteredDeliveries = filteredDeliveries.filter(d => String(d.deliveryPersonId || '') === String(filterDriver || ''));
  if (searchTerm) {
    const term = String(searchTerm).toLowerCase();
    filteredDeliveries = filteredDeliveries.filter(d => {
      const customer = state.customers.find(c => c.id === d.customerId);
      const name = String(customer?.name || '').toLowerCase();
      const phone = String(d.phoneNumber || customer?.phones?.[0] || '').toLowerCase();
      const receiptNo = String(d.tempReceiptNo || d.finalReceiptNo || d.serialNumber || '').toLowerCase();
      return name.includes(term) || phone.includes(term) || receiptNo.includes(term);
    });
  }
  filteredDeliveries.sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0));

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  const canAssign = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'assign') || isCurrentUserAdmin());
  const canOffice = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'markCollected') || isCurrentUserAdmin());

  const activeDeliveries = deliveryReceipts.filter(d => d.deliveryStatus === 'In Progress' || d.deliveryStatus === 'Needs Delivery');

  return `
    <div class="space-y-6 animate-fade-in-up">
      <!-- Header -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <i data-lucide="truck" class="w-5 h-5 text-white"></i>
            </span>
            <span>Delivery Operations</span>
          </h1>
          <p class="text-sm text-slate-500 mt-1">${deliveryReceipts.length} deliveries • Tracking receipts only</p>
        </div>
        <div class="flex items-center space-x-2">
          <button onclick="refreshDeliveries()" class="glass-panel px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
            <span>Refresh</span>
          </button>
          <button onclick="checkStuckDeliveries()" class="glass-panel px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2 hover:bg-amber-50 dark:hover:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 transition-all" title="Find deliveries stuck in progress for more than 3 days">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-600"></i>
            <span class="text-amber-700 dark:text-amber-400">Check Stuck</span>
          </button>
          <button onclick="exportDeliveryReport()" class="btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
            <i data-lucide="download" class="w-4 h-4"></i>
            <span>Export</span>
          </button>
        </div>
      </div>

      <!-- Primary Stats Row -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 text-white shadow-xl shadow-orange-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Pending Delivery</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="package" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.pendingDelivery}</div>
            <div class="text-xs text-white/70 mt-1">Receipts not yet delivered</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-emerald-400 via-teal-500 to-cyan-500 text-white shadow-xl shadow-emerald-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Uncollected Value</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="wallet" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.uncollectedLYD.toLocaleString()}<span class="text-lg ml-1">LYD</span></div>
            <div class="text-xs text-white/70 mt-1">To be collected from customers</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-violet-400 via-purple-500 to-fuchsia-500 text-white shadow-xl shadow-purple-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Held by Drivers</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="hand-coins" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.heldByDrivers}</div>
            <div class="text-xs text-white/70 mt-1">Delivered but not in office</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-blue-400 via-indigo-500 to-purple-500 text-white shadow-xl shadow-indigo-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Driver Cash Value</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="banknote" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.driverCashLYD.toLocaleString()}<span class="text-lg ml-1">LYD</span></div>
            <div class="text-xs text-white/70 mt-1">To be collected from drivers</div>
          </div>
        </div>
      </div>

      <!-- Status Pipeline -->
      <div class="glass-panel rounded-2xl p-5">
        <div class="flex items-center space-x-2 mb-4">
          <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="git-branch" class="w-4 h-4 text-white"></i>
          </span>
          <h2 class="text-lg font-bold text-slate-800 dark:text-white">Delivery Pipeline</h2>
        </div>
        <div class="flex items-center justify-between">
          ${renderPipelineStage('Pending Assignment', stats.pendingAssignment, 'clock', 'slate', 0)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-slate-300 to-amber-300 dark:from-slate-700 dark:to-amber-700 rounded"></div>
          ${renderPipelineStage('In Progress', stats.inProgress, 'truck', 'blue', 1)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-blue-300 to-emerald-300 dark:from-blue-700 dark:to-emerald-700 rounded"></div>
          ${renderPipelineStage('Completed', stats.completed, 'check-circle', 'emerald', 2)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-emerald-300 to-rose-300 dark:from-emerald-700 dark:to-rose-700 rounded"></div>
          ${renderPipelineStage('Canceled', stats.canceled, 'x-circle', 'rose', 3)}
        </div>
      </div>

      <!-- Driver Performance & Delivery Log Grid -->
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <!-- Driver Performance -->
        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center space-x-2">
              <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                <i data-lucide="users" class="w-4 h-4 text-white"></i>
              </span>
              <h2 class="text-lg font-bold text-slate-800 dark:text-white">Driver Performance</h2>
            </div>
          </div>
          <div class="space-y-3 max-h-80 overflow-y-auto">
            ${driverPerformance.length === 0 ? `
              <div class="text-center py-8 text-slate-500">
                <i data-lucide="user-x" class="w-12 h-12 mx-auto mb-2 opacity-50"></i>
                <p>No delivery drivers found</p>
              </div>
            ` : driverPerformance.map((driver, idx) => `
              <div class="relative p-4 rounded-xl border-2 ${idx === 0 ? 'border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'} transition-all hover:shadow-md">
                ${idx === 0 ? '<div class="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg"><i data-lucide="crown" class="w-4 h-4 text-white"></i></div>' : ''}
                <div class="flex items-center space-x-3 mb-3">
                  <div class="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
                    ${driver.name?.charAt(0) || '?'}
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-bold text-sm text-slate-800 dark:text-white truncate">${Security.escapeHtml(driver.name || '')}</h4>
                    <p class="text-xs text-slate-500">${driver.totalAssigned} assigned</p>
                  </div>
                  <div class="text-right">
                    <div class="text-lg font-black ${driver.successRate >= 80 ? 'text-emerald-600' : driver.successRate >= 50 ? 'text-amber-600' : 'text-slate-500'}">${driver.successRate}%</div>
                    <div class="text-[10px] text-slate-500">Success</div>
                  </div>
                </div>
                <div class="grid grid-cols-4 gap-2 text-center">
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-slate-700 dark:text-slate-300">${driver.pending}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Pending</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-blue-600">${driver.inProgress}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Active</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-emerald-600">${driver.completed}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Done</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-purple-600">${driver.heldCash.toLocaleString()}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Held LYD</div>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Delivery Log -->
        <div class="xl:col-span-2 glass-panel rounded-2xl p-5">
          <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-4">
            <div class="flex items-center space-x-2">
              <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                <i data-lucide="clipboard-list" class="w-4 h-4 text-white"></i>
              </span>
              <h2 class="text-lg font-bold text-slate-800 dark:text-white">Delivery Log</h2>
            </div>
            <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <div class="relative flex-1 md:flex-none">
                <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"></i>
                <input type="text" placeholder="Search..." value="${Security.escapeHtml(searchTerm)}" oninput="filterDeliveries('search', this.value)" class="glass-input w-full md:w-40 pl-9 pr-3 py-2 rounded-lg text-sm">
              </div>
              <select onchange="filterDeliveries('status', this.value)" class="glass-input px-3 py-2 rounded-lg text-sm">
                <option value="all" ${filterStatus === 'all' ? 'selected' : ''}>All Status</option>
                ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${filterStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <select onchange="filterDeliveries('driver', this.value)" class="glass-input px-3 py-2 rounded-lg text-sm">
                <option value="all" ${filterDriver === 'all' ? 'selected' : ''}>All Drivers</option>
                ${deliveryUsers.map(u => `<option value="${u.id}" ${filterDriver === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
              </select>
            </div>
          </div>

          <!-- Delivery Table -->
          <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-slate-50 dark:bg-slate-800/50">
                  <th class="text-left px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Customer</th>
                  <th class="text-left px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Delivery Person</th>
                  <th class="text-right px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Amount</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Status</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Office Handover</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Date</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
                ${filteredDeliveries.length === 0 ? `
                  <tr>
                    <td colspan="7" class="px-4 py-12 text-center">
                      <i data-lucide="inbox" class="w-12 h-12 mx-auto text-slate-300 mb-3"></i>
                      <p class="text-slate-500">No deliveries found</p>
                    </td>
                  </tr>
                ` : filteredDeliveries.slice(0, 20).map(ad => {
          const customer = state.customers.find(c => c.id === ad.customerId);
          const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
                  const collectedCash = _getCollectedCashLocal(ad);
                  const receivedInOffice = _isReceivedInOffice(ad);
                  const officeEligible = String(ad.deliveryStatus || '') === 'Delivered' && collectedCash > 0;
                  const debtLocal = Number(ad.debtAmountLocal ?? ad.amountLocal ?? 0) || 0;
                  const debtUSD = Number(ad.debtAmountUSD ?? ad.amountUSD ?? 0) || 0;
                  const statusColors = {
                    'Needs Delivery': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                    'In Progress': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                    'Delivered': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
                    'Canceled': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  };
                  const isReceipt = true;
                  return `
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td class="px-4 py-3">
                        <div class="flex items-center space-x-3">
                          <div class="w-9 h-9 rounded-full bg-gradient-to-br ${isReceipt ? 'from-purple-500 to-pink-600' : 'from-indigo-500 to-purple-600'} flex items-center justify-center text-white font-bold text-sm shadow-md">
                            ${isReceipt ? '<i data-lucide="receipt" class="w-4 h-4"></i>' : (customer?.name?.charAt(0) || '?')}
                          </div>
                          <div>
                            <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                            <div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</div>
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-medium">Receipt</span>
                          </div>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        ${deliveryPerson ? `
                          <div class="flex items-center space-x-2">
                            <div class="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold">
                              ${deliveryPerson.name?.charAt(0) || '?'}
                            </div>
                            <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(deliveryPerson.name || '')}</span>
                          </div>
                        ` : (canAssign ? `
                          <select onchange="assignDelivery('${ad.id}', this.value)" class="glass-input px-2 py-1 rounded-lg text-xs">
                            <option value="">Assign...</option>
                            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
                          </select>
                        ` : `<span class="text-xs text-slate-400">Unassigned</span>`)}
                      </td>
                      <td class="px-4 py-3 text-right">
                        <div class="font-bold text-emerald-600">${debtLocal.toLocaleString()} LYD</div>
                        <div class="text-xs text-slate-500">$${debtUSD.toFixed(2)}</div>
                        ${String(ad.deliveryStatus || '') === 'Delivered' ? `
                          <div class="text-[10px] text-slate-500 mt-1">Collected: <span class="font-bold text-slate-700 dark:text-slate-300">${collectedCash.toLocaleString()} LYD</span></div>
                        ` : ''}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <span class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[ad.deliveryStatus] || 'bg-slate-100 text-slate-700'}">
                          ${ad.deliveryStatus}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-center">
                        ${!officeEligible ? `
                          <span class="text-slate-400 text-xs">—</span>
                        ` : receivedInOffice ? `
                          <div class="inline-flex flex-col items-center gap-1">
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                              <i data-lucide="check" class="w-3 h-3 mr-1"></i>Received
                            </span>
                            ${canOffice ? `<button onclick="undoOfficeHandover('${ad.id}')" class="text-[10px] font-bold text-rose-600 hover:text-rose-700">Undo</button>` : ''}
                          </div>
                        ` : `
                          ${canOffice ? `
                            <button onclick="markOfficeHandover('${ad.id}')" class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 transition-colors">
                              <i data-lucide="hand" class="w-3 h-3 mr-1"></i>Receive
                            </button>
                          ` : `<span class="text-xs text-slate-500">Pending</span>`}
                        `}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <div class="text-xs text-slate-600 dark:text-slate-400">${formatDateShort(ad.createdAt || ad.date)}</div>
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center justify-center space-x-1">
                          <select onchange="updateDeliveryStatus('${ad.id}', this.value)" class="glass-input px-2 py-1 rounded-lg text-xs w-24">
                            ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${ad.deliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
                          </select>
                          <button onclick="showDeliveryDetails('${ad.id}')" class="p-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 transition-colors" title="View Details">
                            <i data-lucide="eye" class="w-4 h-4"></i>
                          </button>
                          ${canAssign && String(ad.deliveryStatus || '') !== 'Delivered' ? `
                            <button onclick="removeDeliveryMission('${ad.id}')" class="p-1.5 rounded-lg bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/30 dark:text-rose-300 transition-colors" title="Delete Mission">
                              <i data-lucide="trash-2" class="w-4 h-4"></i>
                            </button>
                          ` : ''}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          ${filteredDeliveries.length > 20 ? `
            <div class="mt-3 text-center text-sm text-slate-500">
              Showing 20 of ${filteredDeliveries.length} deliveries
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Active Deliveries Grid -->
      <div class="glass-panel rounded-2xl p-5">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-2">
            <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <i data-lucide="zap" class="w-4 h-4 text-white"></i>
            </span>
            <h2 class="text-lg font-bold text-slate-800 dark:text-white">Active Deliveries</h2>
            <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              ${activeDeliveries.length}
            </span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          ${activeDeliveries.length === 0 ? `
            <div class="col-span-full py-12 text-center">
              <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20 flex items-center justify-center">
                <i data-lucide="check-circle" class="w-10 h-10 text-emerald-500"></i>
              </div>
              <p class="text-slate-500 font-medium">All caught up!</p>
              <p class="text-sm text-slate-400">No pending deliveries at the moment</p>
            </div>
          ` : activeDeliveries.map(ad => {
            const customer = state.customers.find(c => c.id === ad.customerId);
            const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
            const isUrgent = ad.deliveryStatus === 'Needs Delivery' && !ad.deliveryPersonId;
          
          return `
              <div class="relative overflow-hidden rounded-xl border-2 ${isUrgent ? 'border-rose-300 dark:border-rose-700 bg-gradient-to-br from-rose-50 to-orange-50 dark:from-rose-900/20 dark:to-orange-900/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'} p-4 transition-all hover:shadow-lg">
                ${isUrgent ? '<div class="absolute top-0 right-0 px-2 py-1 bg-rose-500 text-white text-[10px] font-bold uppercase rounded-bl-lg">Urgent</div>' : ''}
                
                <div class="flex items-start justify-between mb-3">
                  <div class="flex items-center space-x-3">
                    <div class="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-lg">
                      ${customer?.name?.charAt(0) || '?'}
                </div>
                    <div>
                      <h3 class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                      <p class="text-xs text-slate-500 flex items-center space-x-1">
                        <i data-lucide="phone" class="w-3 h-3"></i>
                        <span>${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</span>
                      </p>
                    </div>
                  </div>
                  <span class="px-2 py-1 rounded-lg text-xs font-bold ${ad.deliveryStatus === 'In Progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}">
                    ${ad.deliveryStatus}
                  </span>
              </div>

                <div class="grid grid-cols-2 gap-3 mb-3 text-sm">
                  <div class="p-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                    <div class="text-[10px] text-slate-500 uppercase">Amount</div>
                    <div class="font-bold text-emerald-600">${(ad.amountLocal || 0).toLocaleString()} LYD</div>
                  </div>
                  <div class="p-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                    <div class="text-[10px] text-slate-500 uppercase">USD Value</div>
                    <div class="font-bold text-slate-700 dark:text-slate-300">$${(ad.amountUSD || 0).toFixed(2)}</div>
                  </div>
              </div>

                ${deliveryPerson ? `
                  <div class="mb-3 p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 flex items-center space-x-2">
                    <div class="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                      ${deliveryPerson.name?.charAt(0)}
                    </div>
                    <span class="text-xs font-medium text-indigo-700 dark:text-indigo-300">${Security.escapeHtml(deliveryPerson.name || '')}</span>
                  </div>
                ` : (canAssign ? `
                  <select onchange="assignDelivery('${ad.id}', this.value)" class="w-full glass-input px-3 py-2 rounded-lg text-sm mb-3">
                    <option value="">⚡ Assign driver...</option>
                    ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
                  </select>
                ` : `<div class="mb-3 text-xs text-slate-400">Unassigned</div>`)}

                <div class="flex space-x-2">
                  ${String(ad.deliveryStatus || '') !== 'Delivered' && String(ad.deliveryStatus || '') !== 'Canceled' ? `
                    <button onclick="openDeliveryCancelModal('${ad.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-3 py-2 rounded-lg text-sm font-bold flex items-center justify-center space-x-1">
                      <i data-lucide="x-circle" class="w-4 h-4"></i>
                      <span>Cancel</span>
                    </button>
                  ` : ''}
                  <button onclick="showDeliveryDetails('${ad.id}')" class="btn-shine bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-2 rounded-lg text-sm">
                    <i data-lucide="more-horizontal" class="w-4 h-4"></i>
                  </button>
                  ${canAssign && String(ad.deliveryStatus || '') !== 'Delivered' ? `
                    <button onclick="removeDeliveryMission('${ad.id}')" class="btn-shine bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 px-3 py-2 rounded-lg text-sm" title="Delete Mission">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
              </div>
            </div>
          `;
        }).join('')}
        </div>
      </div>
    </div>
  `;
}

// Helper function to render pipeline stages
function renderPipelineStage(label, count, icon, color, index) {
  const colors = {
    slate: 'from-slate-400 to-gray-500',
    amber: 'from-amber-400 to-orange-500',
    blue: 'from-blue-400 to-indigo-500',
    emerald: 'from-emerald-400 to-teal-500',
    rose: 'from-rose-400 to-red-500'
  };
  
  return `
    <div class="flex flex-col items-center">
      <div class="w-14 h-14 rounded-2xl bg-gradient-to-br ${colors[color]} flex items-center justify-center shadow-lg mb-2 animate-pulse-slow" style="animation-delay: ${index * 200}ms">
        <i data-lucide="${icon}" class="w-6 h-6 text-white"></i>
      </div>
      <div class="text-2xl font-black text-slate-800 dark:text-white">${count}</div>
      <div class="text-[10px] text-slate-500 text-center uppercase tracking-wide">${label}</div>
    </div>
  `;
}

// Filter deliveries
function filterDeliveries(type, value) {
  if (!state.deliveryFilter) state.deliveryFilter = {};
  state.deliveryFilter[type] = value;
  render();
  lucide.createIcons();
}

// Refresh deliveries
function refreshDeliveries() {
  showNotification('Refreshing', 'Delivery data updated', 'success');
  render();
  lucide.createIcons();
}

// Export delivery report
function exportDeliveryReport() {
  // Delivery Operations: receipts are the source of truth (ads must not create deliveries).
  const deliveryAds = getVisibleRecords(state.receipts).filter(r => {
    const ds = String(r?.deliveryStatus || '').trim();
    if (ds && ds !== 'Office') return true;
    const sd = (r && typeof r.statusDetail === 'object' && r.statusDetail) ? r.statusDetail : {};
    const npc = String(sd.notPaidCollection || '').trim();
    return String(r?.status || '').trim() === 'Not Paid' && npc === 'delivery';
  }).map(r => ({ ...r, isReceipt: true }));
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
  
  let csv = 'Customer,Phone,Debt LYD,Collected LYD,Remaining Due,Status,Driver,Office Received,Date\n';
  deliveryAds.forEach(r => {
    const customer = state.customers.find(c => c.id === r.customerId);
    const driver = r.deliveryPersonId ? deliveryUsers.find(u => u.id === r.deliveryPersonId) : null;
    const debt = Number(r.debtAmountLocal ?? r.amountLocal ?? 0) || 0;
    const collected = Number(r.amountCollectedFromCustomer ?? (String(r.deliveryStatus || '') === 'Delivered' ? (r.amountLocal || 0) : 0)) || 0;
    const remaining = Number(r.remainingDue ?? Math.max(0, debt - collected)) || 0;
    const received = (typeof r.isReceivedInOffice === 'boolean') ? r.isReceivedInOffice : !!r.officeHandover;
    csv += `"${customer?.name || 'Unknown'}","${r.phoneNumber || customer?.phones?.[0] || ''}",${debt},${collected},${remaining},"${r.deliveryStatus || ''}","${driver?.name || ''}",${received ? 'Yes' : 'No'},"${formatDateShort(r.createdAt || r.date)}"\n`;
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `delivery-report-${getTodayDateString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotification('Export Complete', 'Delivery report downloaded', 'success');
}

// Check for stuck deliveries (In Progress for more than X hours)
async function checkStuckDeliveries() {
  if (!isCurrentUserAdmin() && !currentUserHasPermission('deliveries', 'assign')) {
    showNotification('Access Denied', 'Admin or delivery manager only', 'error');
    return;
  }
  
  const hoursInput = prompt('Find deliveries stuck for more than how many hours? (default: 72 = 3 days)', '72');
  if (!hoursInput) return;
  
  const hours = parseInt(hoursInput);
  if (isNaN(hours) || hours < 1) {
    showNotification('Validation Error', 'Minimum 1 hour required', 'error');
    return;
  }
  
  try {
    const res = await fetch(`/api/deliveries/check-stuck`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session': getSessionToken()
      },
      body: JSON.stringify({ hours_threshold: hours })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Check failed' }));
      showNotification('Error', err.detail || 'Check failed', 'error');
      return;
    }
    
    const result = await res.json();
    
    if (result.stuck_count === 0) {
      showNotification('All Good!', `No deliveries stuck for more than ${hours} hours`, 'success');
      return;
    }
    
    // Show stuck deliveries in a modal
    const modal = document.getElementById('app-modal') || document.createElement('div');
    modal.id = 'app-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const stuckList = result.stuck_deliveries.map(d => {
      const customer = state.customers.find(c => c.id === d.customerId);
      const driver = state.users.find(u => u.id === d.deliveryPersonId);
      return `
        <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
          <div class="flex justify-between items-start mb-2">
            <div>
              <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
              <div class="text-xs text-slate-500">Receipt: ${Security.escapeHtml(d.tempReceiptNo || d.finalReceiptNo || d.id)}</div>
            </div>
            <div class="text-right">
              <div class="text-sm font-bold text-amber-700">${d.hoursStuck}h stuck</div>
              <div class="text-xs text-slate-500">${Security.escapeHtml(driver?.name || 'Unassigned')}</div>
            </div>
          </div>
          <div class="flex justify-between text-xs">
            <span class="text-slate-600 dark:text-slate-400">Amount: ${(d.amountLocal || 0).toLocaleString()} LYD</span>
            <button onclick="navigateTo('deliveries'); this.closest('#app-modal').remove();" class="text-indigo-600 hover:text-indigo-700 font-bold">View →</button>
          </div>
        </div>
      `;
    }).join('');
    
    modal.innerHTML = `
      <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <i data-lucide="alert-triangle" class="w-5 h-5 text-white"></i>
            </span>
            <div>
              <div class="text-lg font-bold text-slate-800 dark:text-white">⚠️ Stuck Deliveries</div>
              <div class="text-xs text-slate-500">${result.stuck_count} found (> ${hours} hours)</div>
            </div>
          </div>
          <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
          </button>
        </div>
        
        <div class="space-y-3 max-h-96 overflow-y-auto">
          ${stuckList}
        </div>
        
        <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 text-center text-xs text-slate-500">
          <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
          Consider following up with drivers or canceling stuck deliveries
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    IconQueue.schedule(modal);
  } catch (error) {
    showNotification('Error', 'Check failed: ' + error.message, 'error');
  }
}

function _isReceivedInOffice(item) {
  if (!item) return false;
  if (typeof item.isReceivedInOffice === 'boolean') return item.isReceivedInOffice;
  if (typeof item.officeHandover === 'boolean') return item.officeHandover;
  return false;
}

function _getCollectedCashLocal(item) {
  const v = Number(item?.amountCollectedFromCustomer);
  if (Number.isFinite(v)) return v;
  if (String(item?.deliveryStatus || '') === 'Delivered') {
    const a = Number(item?.amountLocal);
    if (Number.isFinite(a)) return a;
  }
  return 0;
}

function _getOutstandingDueLocal(item) {
  if (!item) return 0;
  const ds = String(item.deliveryStatus || '').trim();
  if (ds === 'Canceled') return 0;
  const rem = Number(item.remainingDue);
  if (Number.isFinite(rem)) return Math.max(0, rem);
  const debt = Number(item.debtAmountLocal);
  if (Number.isFinite(debt)) return Math.max(0, debt - _getCollectedCashLocal(item));
  if (item.isPaid) return 0;
  const amt = Number(item.amountLocal);
  if (Number.isFinite(amt)) return Math.max(0, amt);
  return 0;
}

function setOfficeHandover(itemId, received) {
  const id = String(itemId || '');
  if (!id) return;

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }
  // Office handover is an office/admin action (not a driver action).
  if (roleLower === 'delivery') {
    showNotification('Not Allowed', 'Office handover can only be done by office/admin.', 'warning');
    return;
  }
  if (!currentUserHasPermission('deliveries', 'markCollected') && !isCurrentUserAdmin()) {
    showNotification('Access Denied', 'You do not have permission to mark office handover', 'error');
    return;
  }

  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === id);
  const ad = receipt ? null : state.ads.find(a => a && !a._deleted && String(a.id) === id);
  const item = receipt || ad;
  if (!item) return;

  const next = !!received;
  const nowIso = new Date().toISOString();
  const updates = {
    // Canonical field name (server uses this)
    isReceivedInOffice: next,
    receivedInOfficeAt: next ? nowIso : '',
    // Back-compat (older UI field name)
    officeHandover: next,
    officeHandoverAt: next ? nowIso : ''
  };

  if (receipt) updateRecord(state.receipts, id, updates);
  else updateRecord(state.ads, id, updates);

  addAuditLog('update', id, next ? 'Office handover marked as received' : 'Office handover undone', { isReceipt: !!receipt });
  showNotification('Success', next ? 'Cash received at office' : 'Office handover undone', 'success');
  render();
  if (window.lucide) lucide.createIcons();
}

// Backwards-compatible wrapper (mark as received)
function markOfficeHandover(itemId) {
  setOfficeHandover(itemId, true);
}

function undoOfficeHandover(itemId) {
  setOfficeHandover(itemId, false);
}

// "Delete mission" (remove from delivery tracking) without deleting the receipt itself.
function removeDeliveryMission(itemId) {
  const id = String(itemId || '');
  if (!id) return;

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }
  if (roleLower === 'delivery') {
    showNotification('Not Allowed', 'Drivers cannot delete delivery missions.', 'warning');
    return;
  }
  if (!currentUserHasPermission('deliveries', 'assign') && !isCurrentUserAdmin()) {
    showNotification('Access Denied', 'You do not have permission to remove delivery missions', 'error');
    return;
  }

  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === id);
  if (!receipt) {
    showNotification('Error', 'Delivery receipt not found', 'error');
    return;
  }

  const ds = String(receipt.deliveryStatus || '').trim();
  if (ds === 'Delivered') {
    showNotification('Not Allowed', 'Delivered missions cannot be removed. Use Office Handover (Undo) or manage the receipt from the Receipts screen.', 'warning');
    return;
  }

  if (!confirm('Remove this delivery mission?\n\nThis will unassign the driver and remove it from Delivery Operations.\nThe receipt will remain in Receipts.')) return;

  const nowIso = new Date().toISOString();
  const uid = state.currentUser?.id || '';
  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({ ts: nowIso, userId: uid, action: 'MISSION_REMOVED' });

  const sd0 = (receipt.statusDetail && typeof receipt.statusDetail === 'object') ? receipt.statusDetail : {};
  const nextStatusDetail = { ...sd0 };
  if (String(receipt.status || '').trim() === 'Not Paid' && String(nextStatusDetail.notPaidCollection || '').trim() === 'delivery') {
    nextStatusDetail.notPaidCollection = 'office';
  }

  updateRecord(state.receipts, id, {
    deliveryStatus: 'Office',
    deliveryPersonId: '',
    acceptedDate: '',
    deliveryCancelReason: '',
    deliveryCancelledAt: '',
    deliveryCancelledBy: '',
    isReceivedInOffice: false,
    receivedInOfficeAt: '',
    officeHandover: false,
    officeHandoverAt: '',
    deliveryHistory: nextHistory,
    statusDetail: nextStatusDetail
  });

  showNotification('Removed', 'Delivery mission removed', 'success');
  render();
  if (window.lucide) lucide.createIcons();
}

// Show delivery details modal
function showDeliveryDetails(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const ad = isReceipt || state.ads.find(a => a.id === itemId);
  if (!ad) return;
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
  const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
  const receivedInOffice = _isReceivedInOffice(ad);
  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  const canOffice = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'markCollected') || isCurrentUserAdmin());
  const editHandler = isReceipt ? 'editReceipt' : 'editAd';
  
  const modal = document.getElementById('app-modal') || document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); } };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center space-x-2">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="truck" class="w-5 h-5 text-white"></i>
          </span>
          <span>Delivery Details</span>
        </h2>
        <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>
      
      <div class="space-y-4">
        <!-- Customer Info -->
        <div class="p-4 rounded-xl bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border border-indigo-100 dark:border-indigo-800">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
              ${customer?.name?.charAt(0) || '?'}
            </div>
            <div>
              <h3 class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
              <p class="text-sm text-slate-500 flex items-center space-x-1">
                <i data-lucide="phone" class="w-3 h-3"></i>
                <span>${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</span>
              </p>
            </div>
          </div>
        </div>
        
        <!-- Amount Details -->
        <div class="grid grid-cols-2 gap-3">
          <div class="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800">
            <div class="text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-1">Amount (LYD)</div>
            <div class="text-2xl font-black text-emerald-700 dark:text-emerald-300">${(ad.amountLocal || 0).toLocaleString()}</div>
          </div>
          <div class="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
            <div class="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">Amount (USD)</div>
            <div class="text-2xl font-black text-blue-700 dark:text-blue-300">$${(ad.amountUSD || 0).toFixed(2)}</div>
          </div>
        </div>
        
        <!-- Status & Driver -->
        <div class="grid grid-cols-2 gap-3">
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="text-xs text-slate-500 font-medium mb-2">Status</div>
            <select onchange="updateDeliveryStatus('${ad.id}', this.value); this.closest('#app-modal').remove();" class="w-full glass-input px-3 py-2 rounded-lg text-sm font-medium">
              ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${ad.deliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="text-xs text-slate-500 font-medium mb-2">Driver</div>
            <select onchange="assignDelivery('${ad.id}', this.value); this.closest('#app-modal').remove();" class="w-full glass-input px-3 py-2 rounded-lg text-sm font-medium">
              <option value="">Unassigned</option>
              ${deliveryUsers.map(u => `<option value="${u.id}" ${ad.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
            </select>
          </div>
        </div>
        
        <!-- Tracking Info -->
        <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-500 font-medium mb-3">Tracking Information</div>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-slate-500">Payment Method:</span>
              <span class="font-medium">${ad.paymentMethod || 'N/A'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Wasil Card:</span>
              <span class="font-mono">${ad.deliveryCardNumber || 'N/A'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Collected:</span>
              <span class="${ad.isPaid ? 'text-emerald-600 font-bold' : 'text-amber-600'}">${ad.isPaid ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Office Handover:</span>
              <span class="${receivedInOffice ? 'text-emerald-600 font-bold' : 'text-amber-600'}">${receivedInOffice ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Created:</span>
              <span>${formatDateShort(ad.createdAt || ad.date)}</span>
            </div>
          </div>
        </div>
        
        <!-- Actions -->
        <div class="flex space-x-3">
          ${!ad.isPaid ? `
            <button onclick="markAsCollected('${ad.id}'); this.closest('#app-modal').remove();" class="flex-1 btn-shine bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="dollar-sign" class="w-5 h-5"></i>
              <span>Mark Collected</span>
            </button>
          ` : !receivedInOffice ? `
            ${canOffice ? `
              <button onclick="markOfficeHandover('${ad.id}'); this.closest('#app-modal').remove();" class="flex-1 btn-shine bg-gradient-to-r from-purple-500 to-indigo-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
                <i data-lucide="hand" class="w-5 h-5"></i>
                <span>Office Handover</span>
              </button>
            ` : `
              <div class="flex-1 px-4 py-3 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-bold flex items-center justify-center space-x-2">
                <i data-lucide="clock" class="w-5 h-5"></i>
                <span>Pending Office</span>
              </div>
            `}
          ` : `
            <div class="flex-1 px-4 py-3 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-bold flex items-center justify-center space-x-2">
              <i data-lucide="check-circle" class="w-5 h-5"></i>
              <span>Received</span>
            </div>
          `}
          <button onclick="${editHandler}('${ad.id}'); this.closest('#app-modal').remove();" class="btn-shine bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
            <i data-lucide="edit" class="w-5 h-5"></i>
            <span>Edit</span>
          </button>
          ${canOffice && receivedInOffice ? `
            <button onclick="undoOfficeHandover('${ad.id}'); this.closest('#app-modal').remove();" class="btn-shine bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="rotate-ccw" class="w-5 h-5"></i>
              <span>Undo</span>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function renderDeliveryDashboard() {
  const filterStatus = String(state.deliveryDashboardFilterStatus || 'all');
  const uid = String(state.currentUser?.id || '');
  const receiptDeliveries = getVisibleRecords(state.receipts)
    .filter(r =>
      r &&
      String(r.deliveryPersonId || '') === uid &&
      (String(r.deliveryStatus || '') !== 'Office' || (
        String(r.status || '').trim() === 'Not Paid' &&
        String((r.statusDetail && typeof r.statusDetail === 'object' ? r.statusDetail.notPaidCollection : '') || '').trim() === 'delivery'
      ))
    )
    .map(r => ({
      ...r,
      isReceipt: true,
      deliveryStatus: String(r.deliveryStatus || '').trim() || 'Needs Delivery',
      amountLocal: r.amountLocal || 0,
      amountUSD: r.amountUSD || 0
    }));

  const myDeliveries = [...receiptDeliveries]
    .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0));
  const needsDelivery = myDeliveries.filter(ad => ad.deliveryStatus === 'Needs Delivery');
  const inProgress = myDeliveries.filter(ad => ad.deliveryStatus === 'In Progress');
  const delivered = myDeliveries.filter(ad => ad.deliveryStatus === 'Delivered');
  // Cash held by driver = delivered items that have NOT been handed over to the office yet
  const heldByDriver = delivered.filter(d => !_isReceivedInOffice(d) && _getCollectedCashLocal(d) > 0);
  const cashHeldByDriver = heldByDriver.reduce((sum, ad) => sum + _getCollectedCashLocal(ad), 0);

  let visibleDeliveries = myDeliveries;
  if (filterStatus === 'Needs Delivery') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'Needs Delivery');
  if (filterStatus === 'In Progress') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'In Progress');
  if (filterStatus === 'Delivered') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'Delivered');
  // "Held" filter shows items driver is holding (delivered but not handed to office)
  if (filterStatus === 'Held') visibleDeliveries = heldByDriver;
  
  return `
    <div class="space-y-4 md:space-y-6 animate-fade-in-up px-2 md:px-0 max-w-full overflow-x-hidden">
      <!-- Header with Logout -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 class="text-xl sm:text-2xl md:text-3xl font-bold text-slate-800 dark:text-white">Delivery Dashboard</h1>
          <p class="text-xs sm:text-sm text-slate-500 mt-1">Welcome, ${Security.escapeHtml(state.currentUser?.name || '')}!</p>
        </div>
        <div class="flex items-center gap-2 w-full sm:w-auto">
          <button onclick="refreshDeliveryDashboard()" class="btn-shine bg-blue-600 text-white px-3 py-2 rounded-xl font-bold flex items-center justify-center space-x-1 flex-1 sm:flex-none text-sm" title="Refresh to see latest updates">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
            <span>Refresh</span>
          </button>
          <button onclick="handleLogout()" class="btn-shine bg-rose-600 text-white px-3 py-2 rounded-xl font-bold flex items-center justify-center space-x-1 flex-1 sm:flex-none text-sm">
            <i data-lucide="log-out" class="w-4 h-4"></i>
            <span>Logout</span>
          </button>
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 gap-2 md:gap-4 md:grid-cols-4">
        ${renderStatCard('Needs Delivery', needsDelivery.length, 'clock', 'from-amber-500 to-orange-600', "setDeliveryDashboardFilter('Needs Delivery')", filterStatus === 'Needs Delivery')}
        ${renderStatCard('In Progress', inProgress.length, 'truck', 'from-blue-500 to-cyan-600', "setDeliveryDashboardFilter('In Progress')", filterStatus === 'In Progress')}
        ${renderStatCard('Delivered', delivered.length, 'check-circle', 'from-emerald-500 to-teal-600', "setDeliveryDashboardFilter('Delivered')", filterStatus === 'Delivered')}
        ${renderStatCard('Held', `${heldByDriver.length} (${cashHeldByDriver.toFixed(0)} LYD)`, 'wallet', 'from-purple-500 to-pink-600', "setDeliveryDashboardFilter('Held')", filterStatus === 'Held')}
      </div>

      <!-- My Deliveries -->
      <div class="glass-panel rounded-2xl p-3 md:p-6">
        <div class="flex items-center justify-between mb-3 md:mb-4">
          <h2 class="text-lg md:text-xl font-bold">My Deliveries ${filterStatus !== 'all' ? `<span class="ml-1 md:ml-2 text-xs md:text-sm font-bold text-indigo-600">(${Security.escapeHtml(filterStatus)})</span>` : ''}</h2>
          ${filterStatus !== 'all' ? `
            <button type="button" onclick="setDeliveryDashboardFilter('all')" class="text-xs font-bold text-slate-600 hover:text-slate-800">Show All</button>
          ` : ''}
        </div>
        ${visibleDeliveries.length === 0 ? '<p class="text-center text-slate-500 py-8">No deliveries for this filter</p>' : `
          <div class="space-y-3 w-full">
            ${visibleDeliveries.map(ad => {
              const customer = state.customers.find(c => c.id === ad.customerId);
              const phone = String(ad.phoneNumber || customer?.phones?.[0] || '').trim();
              const wa = phone ? buildWhatsAppLink(phone) : '';
              const displayFinalNo = ad.finalReceiptNo || ad.serialNumber || '';
              const displayTempNo = ad.tempReceiptNo || '';
              return `
                <div class="glass-panel rounded-xl p-3 md:p-4 w-full box-border">
                  <div class="flex flex-col gap-3 md:gap-4">
                    <div class="w-full min-w-0">
                      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                        <h3 class="font-bold text-base md:text-lg truncate">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                        ${phone ? `
                          <div class="flex items-center gap-2 flex-shrink-0">
                            <a href="tel:${encodeURIComponent(phone)}" class="text-xs font-bold text-blue-600 hover:text-blue-700 px-2 py-1 bg-blue-50 rounded-lg">Call</a>
                            ${wa ? `<a href="${wa}" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 bg-emerald-50 rounded-lg">WhatsApp</a>` : ''}
                            <button type="button" onclick='copyTextToClipboard(${JSON.stringify(phone)}).then(ok => showNotification(ok ? "Copied" : "Copy Failed", ok ? "Phone number copied" : "Could not copy phone number", ok ? "success" : "error"))' class="text-xs font-bold text-slate-600 hover:text-slate-700 px-2 py-1 bg-slate-100 rounded-lg">Copy</button>
                          </div>
                        ` : ''}
                      </div>
                      <p class="text-xs md:text-sm text-slate-500 mt-1">${Security.escapeHtml(phone || 'No phone')}</p>
                      ${ad.isReceipt && (displayTempNo || displayFinalNo) ? `
                        <div class="text-xs text-indigo-600 font-bold mt-1">
                          Receipt: ${displayTempNo && displayFinalNo ? `${displayTempNo} → ${displayFinalNo}` : (displayTempNo ? `${displayTempNo} (Temp)` : displayFinalNo)}
                        </div>
                      ` : ''}
                      ${ad.isReceipt && ad.deliveryPlaceName ? `
                        <div class="text-xs text-slate-600 dark:text-slate-300 mt-1">
                          <span class="font-bold">📍</span> ${Security.escapeHtml(String(ad.deliveryPlaceName || ''))}
                        </div>
                      ` : ''}
                      ${ad.isReceipt && (ad.quotedDeliveryFee !== undefined && ad.quotedDeliveryFee !== null) ? `
                        <div class="text-[11px] text-slate-500 mt-0.5">
                          Quoted fee: <span class="font-bold text-emerald-600">${Number(ad.quotedDeliveryFee || 0).toFixed(0)} LYD</span>
                        </div>
                      ` : ''}
                      ${ad.isReceipt && ad.deliveryInstructions ? `
                        <div class="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-lg p-2 mt-1 border border-amber-200 dark:border-amber-800">
                          <span class="font-bold">📝 Instructions:</span> ${Security.escapeHtml(String(ad.deliveryInstructions || ''))}
                        </div>
                      ` : ''}
                      <div class="flex flex-wrap items-center gap-1.5 md:gap-2 mt-2">
                        <span class="text-xs font-bold text-emerald-600">$${Number(ad.amountUSD || 0).toFixed(2)} (${Number(ad.amountLocal || 0).toFixed(0)} LYD)</span>
                        <span class="payment-badge text-[10px] md:text-xs">${Security.escapeHtml(ad.paymentMethod || '')}</span>
                        <span class="delivery-${(ad.deliveryStatus || '').toLowerCase().replace(' ', '')} px-2 py-0.5 md:py-1 rounded-full text-[10px] md:text-xs font-bold">${Security.escapeHtml(ad.deliveryStatus || '')}</span>
                        ${ad.editCount ? `<button onclick="showReceiptEditHistory('${ad.id}')" class="text-[10px] px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors font-medium flex items-center gap-1"><i data-lucide="history" class="w-3 h-3"></i>${ad.editCount}</button>` : ''}
                      </div>
                    </div>
                    <div class="flex flex-row md:flex-col gap-2 w-full md:w-auto">
                      ${ad.deliveryStatus === 'Needs Delivery' ? `
                        <button onclick="acceptDelivery('${ad.id}')" class="btn-shine bg-blue-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check" class="w-4 h-4 mr-1"></i>Accept
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && ad.isReceipt ? `
                        <button onclick="openReceiptDeliveryCompletionModal('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Delivered
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && !ad.isReceipt && !ad.isPaid ? `
                        <button onclick="markAsCollected('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="dollar-sign" class="w-4 h-4 mr-1"></i>Collected
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && !ad.isReceipt && ad.isPaid ? `
                        <button onclick="markAsDelivered('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Delivered
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'Delivered' ? `
                        <div class="text-emerald-600 font-bold text-sm flex items-center justify-center py-2">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Complete
                        </div>
                      ` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function setDeliveryDashboardFilter(status) {
  const next = String(status || 'all');
  // Don't toggle back to 'all' on double-click - stay on selected filter
  state.deliveryDashboardFilterStatus = next;
  render();
  if (window.lucide) lucide.createIcons();
}

// Manual refresh button for delivery dashboard - forces immediate sync from server
async function refreshDeliveryDashboard() {
  if (!isServerModeEnabled()) {
    render();
    showNotification('Refreshed', 'Dashboard refreshed', 'success');
    return;
  }

  updateSyncIndicator('syncing');
  showNotification('Syncing', 'Fetching latest data...', 'info');

  try {
    // Clear cache to force fresh data
    _collectionCache.receipts = { data: null, timestamp: 0 };
    _collectionCache.customers = { data: null, timestamp: 0 };

    // Force immediate sync from server
    const [receipts, customers] = await Promise.all([
      apiLoadCollectionAll('receipts'),
      apiLoadCollectionAll('customers')
    ]);

    if (Array.isArray(receipts)) state.receipts = receipts;
    if (Array.isArray(customers)) state.customers = customers;

    markCollectionDirty('receipts');
    markCollectionDirty('customers');
    saveState();

    render();
    if (window.lucide) lucide.createIcons();
    updateSyncIndicator('synced');
    showNotification('Refreshed', 'Dashboard updated with latest data', 'success');
  } catch (e) {
    console.error('Failed to refresh delivery dashboard:', e);
    updateSyncIndicator('error');
    showNotification('Refresh Failed', 'Could not fetch latest data. Please try again.', 'error');
    // Still render with current data
    render();
  }
}

function _findAdForDeliveryModal(adId) {
  const aid = String(adId || '');
  const ad = state.ads.find(a => a && !a._deleted && String(a.id) === aid);
  return ad || null;
}

function openDeliveryCancelModal(itemId) {
  const rid = String(itemId || '');
  const receipt = _findReceiptForDeliveryModal(rid);
  const ad = receipt ? null : _findAdForDeliveryModal(rid);
  const item = receipt || ad;
  const itemType = receipt ? 'receipt' : 'ad';

  if (!item) {
    showNotification('Error', 'Delivery not found', 'error');
    return;
  }

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (roleLower === 'delivery') {
    if (String(item.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
      showNotification('Access Denied', 'This delivery is not assigned to you', 'error');
      return;
    }
  } else if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }

  if (String(item.deliveryStatus || '') === 'Delivered') {
    showNotification('Not Allowed', 'Already delivered.', 'warning');
    return;
  }

  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(item.customerId || ''));
  const phone = String(item.phoneNumber || customer?.phones?.[0] || '').trim();
  const ref = receipt
    ? String(receipt.tempReceiptNo || receipt.finalReceiptNo || receipt.serialNumber || receipt.id)
    : String(ad?.id || '');

  document.getElementById('delivery-cancel-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'delivery-cancel-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-md animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center">
            <i data-lucide="x-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">Cancel Delivery</div>
            <div class="text-xs text-slate-500">
              ${Security.escapeHtml(customer?.name || 'Unknown')}
              ${ref ? ` • ${itemType === 'receipt' ? 'Receipt' : 'Delivery'} ${Security.escapeHtml(ref)}` : ''}
              ${phone ? ` • ${Security.escapeHtml(phone)}` : ''}
            </div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-cancel-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Reason *</label>
          <textarea id="delivery-cancel-reason" rows="3" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Why are you cancelling?"></textarea>
        </div>
        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="this.closest('#delivery-cancel-modal').remove()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">Close</button>
          <button type="button" onclick='submitDeliveryCancel(${JSON.stringify(itemType)}, ${JSON.stringify(String(item.id || ""))})' class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            Confirm Cancel
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function submitDeliveryCancel(itemType, itemId) {
  const type = String(itemType || '');
  const id = String(itemId || '');
  const reason = String(document.getElementById('delivery-cancel-reason')?.value || '').trim();
  if (!reason) {
    showNotification('Validation', 'Cancel reason is required.', 'error');
    return;
  }

  const nowIso = new Date().toISOString();
  const uid = state.currentUser?.id || '';

  if (type === 'receipt') {
    const receipt = _findReceiptForDeliveryModal(id);
    if (!receipt) return;
    const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
    nextHistory.push({ ts: nowIso, userId: uid, action: 'CANCELLED_BY_DRIVER', reason });
    updateRecord(state.receipts, receipt.id, {
      deliveryStatus: 'Canceled',
      deliveryCancelReason: reason,
      deliveryCancelledAt: nowIso,
      deliveryCancelledBy: uid,
      deliveryHistory: nextHistory
    });
  } else {
    const ad = _findAdForDeliveryModal(id);
    if (!ad) return;
    const nextHistory = Array.isArray(ad.deliveryHistory) ? [...ad.deliveryHistory] : [];
    nextHistory.push({ ts: nowIso, userId: uid, action: 'CANCELLED_BY_DRIVER', reason });
    updateRecord(state.ads, ad.id, {
      deliveryStatus: 'Canceled',
      deliveryCancelReason: reason,
      deliveryCancelledAt: nowIso,
      deliveryCancelledBy: uid,
      deliveryHistory: nextHistory
    });
  }

  document.getElementById('delivery-cancel-modal')?.remove();
  document.getElementById('delivery-complete-modal')?.remove();
  showNotification('Canceled', 'Delivery canceled', 'success');
  render();
}

function renderReconciliationView() {
  const visibleAds = getVisibleRecords(state.ads).filter(ad => ad.spentUSD);
  return `
    <div class="space-y-6">
      <h1 class="text-3xl font-bold">${t('jobReconciliation')}</h1>
      <div class="glass-panel rounded-2xl p-6">
        ${visibleAds.length === 0 ? '<p class="text-center text-slate-500 py-8">No reconciliation data</p>' : `
          <div class="space-y-3">
            ${visibleAds.map(ad => {
              const customer = state.customers.find(c => c.id === ad.customerId);
              const diff = (ad.spentUSD || 0) - (ad.amountUSD || 0);
              const reconClass = diff === 0 ? 'recon-match' : diff > 0 ? 'recon-overspent' : 'recon-underspent';
              return `<div class="${reconClass} p-4 rounded-lg">
                <div class="flex justify-between items-center">
                  <div>
                    <span class="font-medium">${Security.escapeHtml(customer?.name || 'Unknown')}</span>
                    <p class="text-sm">Collected: $${ad.amountUSD} | Spent: $${ad.spentUSD} | Diff: $${diff.toFixed(2)}</p>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function renderUsersView() {
  const visibleUsers = getVisibleRecords(state.users);
  const isAdmin = isCurrentUserAdmin();
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('users')}</h1>
          <p class="text-sm text-slate-500 mt-1">${visibleUsers.length} system users</p>
        </div>
        ${isAdmin ? `
        <button onclick="showUserModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="user-plus" class="w-4 h-4"></i>
          <span>${t('addUser')}</span>
        </button>
        ` : ''}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${visibleUsers.map(u => {
          const userAds = getVisibleRecords(state.ads).filter(ad => ad.creatorId === u.id);
          const deliveredAds = getVisibleRecords(state.ads).filter(ad => ad.deliveryPersonId === u.id && ad.isPaid);
          const deliveredReceipts = getVisibleRecords(state.receipts).filter(r => r.deliveryPersonId === u.id && r.deliveryStatus === 'Delivered');
          const deliveryFeesLYD = deliveredReceipts.reduce((sum, r) => sum + (Number(r.deliveryFeeCollected ?? r.actualDeliveryFeeCollected ?? 0) || 0), 0);
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform">
              <div class="flex items-start justify-between mb-4">
                <div class="flex items-center space-x-3 flex-1">
                  <div class="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold text-xl shadow-lg">
                    ${u.name.charAt(0)}
                  </div>
                  <div class="flex-1">
                    <h3 class="font-bold text-lg text-slate-800 dark:text-white">${Security.escapeHtml(u.name || '')}</h3>
                    <div class="flex items-center space-x-2 mt-1">
                      <span class="text-xs px-2 py-1 ${u.role === 'Admin' ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' : u.role === 'Delivery' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'} rounded-full font-medium">${u.role}</span>
                      ${u.id === state.currentUser?.id ? '<span class="text-xs text-indigo-600 font-medium">(You)</span>' : ''}
                    </div>
                  </div>
                </div>
                <div class="flex space-x-1">
                  ${isAdmin && u.id !== state.currentUser?.id && u.role !== 'Admin' ? `
                    <button onclick="showPermissionsModal('${u.id}')" class="text-purple-600 hover:text-purple-700 p-1" title="Manage Permissions">
                      <i data-lucide="shield" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
                  ${isAdmin || u.id === state.currentUser?.id ? `
                  <button onclick="editUser('${u.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="${u.id === state.currentUser?.id ? 'Edit Your Profile' : 'Edit'}">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  ` : ''}
                  ${isAdmin && u.id !== state.currentUser?.id ? `
                    <button onclick="deleteUser('${u.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
                </div>
              </div>

              <div class="space-y-2 text-sm border-t border-slate-200 dark:border-slate-700 pt-3">
                <div class="flex items-center space-x-2 text-slate-600 dark:text-slate-400">
                  <i data-lucide="mail" class="w-4 h-4 text-slate-400"></i>
                  <span class="truncate">${Security.escapeHtml(u.email || '')}</span>
                </div>

                ${u.role === 'Delivery' && u.stats ? `
                  <div class="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-1">
                    <div class="text-xs font-bold text-blue-700 dark:text-blue-300 uppercase mb-2">Delivery Stats</div>
                    <div class="flex justify-between text-xs"><span>Total Assigned:</span><span class="font-bold">${u.stats.totalAds || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Accepted:</span><span class="font-bold text-blue-600">${u.stats.accepted || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Collected:</span><span class="font-bold text-emerald-600">${u.stats.collected || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Fees Earned:</span><span class="font-bold text-purple-600">${deliveryFeesLYD.toFixed(0)} LYD</span></div>
                  </div>
                ` : ''}

                ${userAds.length > 0 ? `
                  <div class="flex items-center space-x-2 text-xs text-slate-500 mt-2">
                    <i data-lucide="megaphone" class="w-3 h-3"></i>
                    <span>Created ${userAds.length} ads</span>
                  </div>
                ` : ''}

                ${deliveredAds.length > 0 ? `
                  <div class="flex items-center space-x-2 text-xs text-emerald-600 mt-2">
                    <i data-lucide="truck" class="w-3 h-3"></i>
                    <span>Delivered ${deliveredAds.length} ads</span>
                  </div>
                ` : ''}
                
                <!-- Permission Summary -->
                ${u.role !== 'Admin' ? (() => {
                  const permSummary = getPermissionSummary(u.permissions || {});
                  return `
                    <div class="mt-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                      <div class="flex items-center justify-between mb-2">
                        <div class="flex items-center space-x-1">
                          <i data-lucide="shield" class="w-3 h-3 text-purple-600"></i>
                          <span class="text-[10px] font-bold text-purple-700 dark:text-purple-300 uppercase">Permissions</span>
                        </div>
                        <span class="text-xs font-bold ${permSummary.percentage > 50 ? 'text-emerald-600' : 'text-purple-600'}">${permSummary.granted}/${permSummary.total}</span>
                      </div>
                      <div class="w-full h-1.5 bg-purple-200 dark:bg-purple-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full transition-all" style="width: ${permSummary.percentage}%"></div>
                      </div>
                      ${isAdmin ? `
                      <button onclick="showPermissionsModal('${u.id}')" class="mt-2 w-full text-xs text-purple-600 hover:text-purple-700 font-medium flex items-center justify-center space-x-1">
                        <i data-lucide="settings" class="w-3 h-3"></i>
                        <span>Manage Access</span>
                      </button>
                      ` : `
                        <div class="mt-2 text-[11px] text-slate-500 text-center">
                          ${state.language === 'ar' ? 'التعديل للأدمن فقط' : 'Admin only'}
                        </div>
                      `}
                    </div>
                  `;
                })() : `
                  <div class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-center">
                    <div class="flex items-center justify-center space-x-1 text-amber-700 dark:text-amber-300">
                      <i data-lucide="crown" class="w-4 h-4"></i>
                      <span class="text-xs font-bold">Full Admin Access</span>
                    </div>
                  </div>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAuditView() {
  const allLogs = getVisibleRecords(state.logs);
  
  // Apply filters
  let filteredLogs = allLogs.filter(log => {
    // Search filter
    if (state.auditSearch) {
      const search = state.auditSearch.toLowerCase();
      const matchesSearch = 
        (log.description || '').toLowerCase().includes(search) ||
        (log.userName || '').toLowerCase().includes(search) ||
        (log.action || '').toLowerCase().includes(search) ||
        (log.resourceId || '').toLowerCase().includes(search);
      if (!matchesSearch) return false;
    }
    
    // Action filter
    if (state.auditActionFilter !== 'all' && log.action !== state.auditActionFilter) return false;
    
    // Category filter
    if (state.auditCategoryFilter !== 'all' && log.category !== state.auditCategoryFilter) return false;
    
    // Severity filter
    if (state.auditSeverityFilter !== 'all' && log.severity !== state.auditSeverityFilter) return false;
    
    // User filter
    if (state.auditUserFilter !== 'all' && log.userId !== state.auditUserFilter) return false;
    
    // Date range filter
    if (state.auditDateFrom) {
      const logDate = new Date(log.date);
      const fromDate = new Date(state.auditDateFrom);
      if (logDate < fromDate) return false;
    }
    if (state.auditDateTo) {
      const logDate = new Date(log.date);
      const toDate = new Date(state.auditDateTo);
      toDate.setHours(23, 59, 59, 999);
      if (logDate > toDate) return false;
    }
    
    return true;
  });
  
  // Sort by date (newest first)
  filteredLogs.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Pagination
  const totalLogs = filteredLogs.length;
  const totalPages = Math.ceil(totalLogs / state.auditPageSize);
  const currentPage = Math.min(state.auditPage, totalPages) || 1;
  const startIndex = (currentPage - 1) * state.auditPageSize;
  const paginatedLogs = filteredLogs.slice(startIndex, startIndex + state.auditPageSize);
  
  // Get unique values for filters
  const uniqueActions = [...new Set(allLogs.map(l => l.action).filter(Boolean))];
  const uniqueCategories = [...new Set(allLogs.map(l => l.category || 'general').filter(Boolean))];
  const uniqueUsers = [...new Set(allLogs.map(l => l.userId).filter(Boolean))];
  
  const hasActiveFilters = state.auditSearch || state.auditActionFilter !== 'all' || 
    state.auditCategoryFilter !== 'all' || state.auditSeverityFilter !== 'all' || 
    state.auditUserFilter !== 'all' || state.auditDateFrom || state.auditDateTo;
  
  // Severity badge colors
  const severityColors = {
    'info': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    'warning': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    'error': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    'critical': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  };
  
  // Category icons
  const categoryIcons = {
    'auth': 'shield',
    'data': 'database',
    'financial': 'dollar-sign',
    'general': 'file-text'
  };
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <!-- Header -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <i data-lucide="file-clock" class="w-5 h-5 text-white"></i>
            </span>
            <span>${t('auditLogs')}</span>
          </h1>
          <p class="text-sm text-slate-500 mt-1">${totalLogs.toLocaleString()} total entries ${hasActiveFilters ? `(filtered from ${allLogs.length.toLocaleString()})` : ''}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button onclick="backupAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-2 border-emerald-200 dark:border-emerald-800 transition-all" title="Create full backup of all logs">
            <i data-lucide="archive" class="w-4 h-4 text-emerald-600"></i>
            <span class="text-emerald-700 dark:text-emerald-400">Backup</span>
          </button>
          <button onclick="restoreAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800 transition-all" title="Restore logs from backup file">
            <i data-lucide="upload" class="w-4 h-4 text-blue-600"></i>
            <span class="text-blue-700 dark:text-blue-400">Restore</span>
          </button>
          <button onclick="cleanupAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-rose-50 dark:hover:bg-rose-900/20 border-2 border-rose-200 dark:border-rose-800 transition-all" title="Delete old audit logs (keeps last 1 year)">
            <i data-lucide="trash-2" class="w-4 h-4 text-rose-600"></i>
            <span class="text-rose-700 dark:text-rose-400">Cleanup</span>
          </button>
          <div class="w-px h-6 bg-slate-300 dark:bg-slate-600"></div>
          <button onclick="exportAuditLogs('csv')" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="download" class="w-4 h-4"></i>
            <span>CSV</span>
          </button>
          <button onclick="exportAuditLogs('json')" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="file-json" class="w-4 h-4"></i>
            <span>JSON</span>
          </button>
        </div>
      </div>
      
      <!-- Storage Status Banner -->
      <div class="glass-panel rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border border-indigo-200 dark:border-indigo-800">
        <div class="flex items-center space-x-3">
          <div class="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-800 flex items-center justify-center">
            <i data-lucide="database" class="w-4 h-4 text-indigo-600 dark:text-indigo-300"></i>
          </div>
          <div>
            <div class="text-xs font-bold text-indigo-700 dark:text-indigo-300">Persistent Storage Enabled</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">${db ? 'IndexedDB Active - Logs stored permanently' : 'LocalStorage Only - Consider backing up'}</div>
          </div>
        </div>
        <div class="flex items-center space-x-4 text-xs">
          <div class="text-center">
            <div class="font-bold text-indigo-700 dark:text-indigo-300">${allLogs.length.toLocaleString()}</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">Total Logs</div>
          </div>
          <div class="text-center">
            <div class="font-bold text-indigo-700 dark:text-indigo-300">${db ? '∞' : Math.min(allLogs.length, MAX_LOGS_IN_LOCALSTORAGE || 500)}</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">In Storage</div>
          </div>
          <div class="w-2 h-2 rounded-full ${db ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}"></div>
        </div>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <i data-lucide="activity" class="w-5 h-5 text-blue-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Total Logs</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <i data-lucide="plus-circle" class="w-5 h-5 text-emerald-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'create').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Creates</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <i data-lucide="edit-3" class="w-5 h-5 text-amber-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'update').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Updates</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
            <i data-lucide="trash-2" class="w-5 h-5 text-rose-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'delete' || l.action === 'Delete').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Deletes</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="glass-panel rounded-2xl p-4">
        <div class="flex flex-col lg:flex-row gap-4">
          <!-- Search -->
          <div class="flex-1 relative">
            <i data-lucide="search" class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              placeholder="Search logs by description, user, action..." 
              value="${Security.escapeHtml(state.auditSearch || '')}"
              oninput="updateAuditFilter('search', this.value)"
              class="w-full pl-12 pr-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20 transition-all"
            />
            ${state.auditSearch ? `<button onclick="updateAuditFilter('search', '')" class="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>` : ''}
          </div>
          
          <!-- Filter Dropdowns -->
          <div class="flex flex-wrap gap-2">
            <select onchange="updateAuditFilter('action', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditActionFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Actions</option>
              ${uniqueActions.map(a => `<option value="${Security.escapeHtml(a)}" ${state.auditActionFilter === a ? 'selected' : ''}>${Security.escapeHtml(a)}</option>`).join('')}
            </select>
            
            <select onchange="updateAuditFilter('category', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditCategoryFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Categories</option>
              <option value="auth" ${state.auditCategoryFilter === 'auth' ? 'selected' : ''}>🔐 Auth</option>
              <option value="data" ${state.auditCategoryFilter === 'data' ? 'selected' : ''}>💾 Data</option>
              <option value="financial" ${state.auditCategoryFilter === 'financial' ? 'selected' : ''}>💰 Financial</option>
              <option value="general" ${state.auditCategoryFilter === 'general' ? 'selected' : ''}>📄 General</option>
            </select>
            
            <select onchange="updateAuditFilter('severity', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditSeverityFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Severity</option>
              <option value="info" ${state.auditSeverityFilter === 'info' ? 'selected' : ''}>ℹ️ Info</option>
              <option value="warning" ${state.auditSeverityFilter === 'warning' ? 'selected' : ''}>⚠️ Warning</option>
              <option value="error" ${state.auditSeverityFilter === 'error' ? 'selected' : ''}>❌ Error</option>
              <option value="critical" ${state.auditSeverityFilter === 'critical' ? 'selected' : ''}>🚨 Critical</option>
            </select>
            
            <select onchange="updateAuditFilter('user', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditUserFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Users</option>
              ${uniqueUsers.map(userId => {
                const user = state.users.find(u => u.id === userId);
                return `<option value="${Security.escapeHtml(userId)}" ${state.auditUserFilter === userId ? 'selected' : ''}>${Security.escapeHtml(user?.name || userId)}</option>`;
              }).join('')}
            </select>
            
            <input type="date" value="${Security.escapeHtml(state.auditDateFrom || '')}" onchange="updateAuditFilter('dateFrom', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditDateFrom ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}" title="From Date" />
            
            <input type="date" value="${Security.escapeHtml(state.auditDateTo || '')}" onchange="updateAuditFilter('dateTo', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditDateTo ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}" title="To Date" />
            
            ${hasActiveFilters ? `
              <button onclick="clearAuditFilters()" class="px-3 py-2 bg-rose-100 dark:bg-rose-900/30 text-rose-600 border-2 border-rose-200 dark:border-rose-800 rounded-xl text-xs font-bold hover:bg-rose-200 transition-all flex items-center space-x-1">
                <i data-lucide="x-circle" class="w-3 h-3"></i>
                <span>Clear</span>
              </button>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- Logs Table -->
      <div class="glass-panel rounded-2xl overflow-hidden">
        ${paginatedLogs.length === 0 ? `
          <div class="p-12 text-center">
            <i data-lucide="${hasActiveFilters ? 'search-x' : 'file-clock'}" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i>
            <p class="text-slate-500 font-medium">${hasActiveFilters ? 'No logs match your filters' : 'No activity logs yet'}</p>
            ${hasActiveFilters ? '<button onclick="clearAuditFilters()" class="mt-4 text-purple-600 hover:text-purple-700 font-medium">Clear all filters</button>' : ''}
          </div>
        ` : `
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Timestamp</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">User</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Action</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Category</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Description</th>
                  <th class="text-center px-4 py-3 text-xs font-bold text-slate-500 uppercase">Severity</th>
                  <th class="text-center px-4 py-3 text-xs font-bold text-slate-500 uppercase">Details</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                ${paginatedLogs.map(log => {
                  const user = state.users.find(u => u.id === log.userId);
                  const severity = log.severity || 'info';
                  const category = log.category || 'general';
                  return `
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td class="px-4 py-3">
                        <div class="text-xs font-medium text-slate-700 dark:text-slate-300">${new Date(log.date).toLocaleDateString()}</div>
                        <div class="text-[10px] text-slate-500">${new Date(log.date).toLocaleTimeString()}</div>
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center space-x-2">
                          <div class="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                            ${(log.userName || user?.name || 'S').charAt(0).toUpperCase()}
                          </div>
                          <span class="text-xs font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.userName || user?.name || 'System')}</span>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        <span class="inline-flex px-2 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                          ${Security.escapeHtml(log.action)}
                        </span>
                      </td>
                      <td class="px-4 py-3">
                        <span class="inline-flex items-center space-x-1 text-xs text-slate-600 dark:text-slate-400">
                          <i data-lucide="${categoryIcons[category] || 'file-text'}" class="w-3 h-3"></i>
                          <span class="capitalize">${Security.escapeHtml(category)}</span>
                        </span>
                      </td>
                      <td class="px-4 py-3 max-w-md">
                        <p class="text-xs text-slate-600 dark:text-slate-400 truncate" title="${Security.escapeHtml(log.description || '')}">${Security.escapeHtml(log.description || '')}</p>
                        ${log.resourceId ? `<p class="text-[10px] text-slate-400 mt-0.5">ID: ${log.resourceId.substring(0, 12)}...</p>` : ''}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <span class="inline-flex px-2 py-1 rounded-full text-[10px] font-bold uppercase ${severityColors[severity] || severityColors['info']}">
                          ${severity}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-center">
                        <button onclick="showLogDetails('${log.id}')" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors" title="View Details">
                          <i data-lucide="eye" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          
          <!-- Pagination -->
          <div class="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex flex-col md:flex-row items-center justify-between gap-3">
            <div class="flex items-center space-x-2 text-xs text-slate-500">
              <span>Show</span>
              <select onchange="updateAuditPageSize(this.value)" class="px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs">
                <option value="25" ${state.auditPageSize === 25 ? 'selected' : ''}>25</option>
                <option value="50" ${state.auditPageSize === 50 ? 'selected' : ''}>50</option>
                <option value="100" ${state.auditPageSize === 100 ? 'selected' : ''}>100</option>
                <option value="250" ${state.auditPageSize === 250 ? 'selected' : ''}>250</option>
              </select>
              <span>entries</span>
              <span class="text-slate-400">|</span>
              <span>Showing ${startIndex + 1}-${Math.min(startIndex + state.auditPageSize, totalLogs)} of ${totalLogs}</span>
            </div>
            
            <div class="flex items-center space-x-1">
              <button onclick="updateAuditPage(1)" ${currentPage === 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage === 1 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevrons-left" class="w-3 h-3"></i>
              </button>
              <button onclick="updateAuditPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage === 1 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevron-left" class="w-3 h-3"></i>
              </button>
              
              <span class="px-3 py-1.5 text-xs font-bold text-slate-700 dark:text-slate-300">
                Page ${currentPage} of ${totalPages || 1}
              </span>
              
              <button onclick="updateAuditPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage >= totalPages ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevron-right" class="w-3 h-3"></i>
              </button>
              <button onclick="updateAuditPage(${totalPages})" ${currentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage >= totalPages ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevrons-right" class="w-3 h-3"></i>
              </button>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

// Audit log helper functions
function updateAuditFilter(filterType, value) {
  switch (filterType) {
    case 'search': {
      const v = String(value || '');
      const clean = Security.sanitizeInput(v, { maxLength: 200 });
      // #region agent log
      // Hypothesis H3: Audit search is injected into templates as an attribute value; quotes can break HTML.
      if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
      try {
        const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
        const hasQuote = v.includes('"');
        const hasApos = v.includes("'");
        const hasAngle = v.includes('<') || v.includes('>');
        if (!dbg.auditSearchLogged && (hasQuote || hasApos || hasAngle)) {
          dbg.auditSearchLogged = true;
            window.__albayanDebugEmit('H3', 'script.js:updateAuditFilter', 'auditSearch contains special chars', {len:v.length,hasQuote,hasApos,hasAngle});
        }
      } catch (_) {}
      }
      // #endregion
      state.auditSearch = clean;
      break;
    }
    case 'action': state.auditActionFilter = value; break;
    case 'category': state.auditCategoryFilter = value; break;
    case 'severity': state.auditSeverityFilter = value; break;
    case 'user': state.auditUserFilter = value; break;
    case 'dateFrom': state.auditDateFrom = value; break;
    case 'dateTo': state.auditDateTo = value; break;
  }
  state.auditPage = 1; // Reset to first page when filtering
  render();
  lucide.createIcons();
}

function clearAuditFilters() {
  state.auditSearch = '';
  state.auditActionFilter = 'all';
  state.auditCategoryFilter = 'all';
  state.auditSeverityFilter = 'all';
  state.auditUserFilter = 'all';
  state.auditDateFrom = '';
  state.auditDateTo = '';
  state.auditPage = 1;
  render();
  lucide.createIcons();
}

function updateAuditPage(page) {
  state.auditPage = Math.max(1, page);
  render();
  lucide.createIcons();
}

function updateAuditPageSize(size) {
  state.auditPageSize = parseInt(size) || 25;
  state.auditPage = 1;
  render();
  lucide.createIcons();
}

function showLogDetails(logId) {
  const log = state.logs.find(l => l.id === logId);
  if (!log) return;
  
  const user = state.users.find(u => u.id === log.userId);
  const modal = document.getElementById('app-modal') || document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center space-x-2">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="file-text" class="w-5 h-5 text-white"></i>
          </span>
          <span>Log Details</span>
        </h2>
        <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>
      
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Log ID</div>
            <div class="text-xs font-mono text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.id)}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Timestamp</div>
            <div class="text-xs text-slate-700 dark:text-slate-300">${new Date(log.date).toLocaleString()}</div>
          </div>
        </div>
        
        <div class="grid grid-cols-3 gap-4">
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">User</div>
            <div class="text-xs text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.userName || user?.name || 'System')}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Action</div>
            <div class="text-xs font-bold text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.action)}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Category</div>
            <div class="text-xs text-slate-700 dark:text-slate-300 capitalize">${Security.escapeHtml(log.category || 'general')}</div>
          </div>
        </div>
        
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
          <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Description</div>
          <div class="text-sm text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.description)}</div>
        </div>
        
        ${log.resourceId ? `
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Resource ID</div>
            <div class="text-xs font-mono text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.resourceId)}</div>
          </div>
        ` : ''}
        
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
          <div class="text-[10px] font-bold text-slate-400 uppercase mb-2">Metadata</div>
          <pre class="text-xs text-slate-600 dark:text-slate-400 overflow-x-auto whitespace-pre-wrap bg-slate-100 dark:bg-slate-900 p-3 rounded-lg">${Security.escapeHtml(JSON.stringify(log.metadata || {}, null, 2))}</pre>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function exportAuditLogs(format) {
  const allLogs = getVisibleRecords(state.logs);
  
  if (format === 'csv') {
    const headers = ['Date', 'Time', 'User', 'Action', 'Category', 'Severity', 'Description', 'Resource ID'];
    const rows = allLogs.map(log => {
      const user = state.users.find(u => u.id === log.userId);
      const date = new Date(log.date);
      return [
        date.toLocaleDateString(),
        date.toLocaleTimeString(),
        log.userName || user?.name || 'System',
        log.action,
        log.category || 'general',
        log.severity || 'info',
        `"${(log.description || '').replace(/"/g, '""')}"`,
        log.resourceId || ''
      ].join(',');
    });
    
    const csv = [headers.join(','), ...rows].join('\n');
    downloadFile(csv, `audit-logs-${new Date().toISOString().split('T')[0]}.csv`, 'text/csv');
  } else {
    const json = JSON.stringify(allLogs, null, 2);
    downloadFile(json, `audit-logs-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  }
  
  showNotification('Export Complete', `Audit logs exported as ${format.toUpperCase()}`, 'success');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Backup all audit logs for permanent storage
async function backupAuditLogs() {
  const allLogs = getVisibleRecords(state.logs);
  
  const backup = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    exportedBy: state.currentUser?.name || 'System',
    totalLogs: allLogs.length,
    logs: allLogs
  };
  
  const json = JSON.stringify(backup, null, 2);
  downloadFile(json, `audit-logs-backup-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  
  // Add backup log entry
  addAuditLog('backup', 'system', `Backed up ${allLogs.length} audit logs`, { backupSize: json.length });
  
  showNotification('Backup Complete', `${allLogs.length} logs backed up successfully`, 'success');
}

// Restore audit logs from backup file
function restoreAuditLogs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        
        if (!backup.logs || !Array.isArray(backup.logs)) {
          showNotification('Error', 'Invalid backup file format', 'error');
          return;
        }
        
        // Merge logs without duplicates
        const existingIds = new Set(state.logs.map(l => l.id));
        let imported = 0;
        
        for (const log of backup.logs) {
          if (!existingIds.has(log.id)) {
            state.logs.push(log);
            existingIds.add(log.id);
            imported++;
            
            // Also save to IndexedDB
            if (db) {
              await saveLogToIndexedDB(log);
            }
          }
        }
        
        // Sort by date (handle invalid dates safely)
        state.logs.sort((a, b) => {
          const dateA = new Date(a.date || 0).getTime() || 0;
          const dateB = new Date(b.date || 0).getTime() || 0;
          return dateB - dateA;
        });
        
        saveState();
        
        addAuditLog('restore', 'system', `Restored ${imported} audit logs from backup`, { 
          backupDate: backup.exportDate,
          totalInBackup: backup.totalLogs
        });
        
        showNotification('Restore Complete', `Imported ${imported} new logs (${backup.totalLogs - imported} duplicates skipped)`, 'success');
        render();
        lucide.createIcons();
      } catch (error) {
        console.error('Restore error:', error);
        showNotification('Error', 'Failed to restore backup: ' + error.message, 'error');
      }
    };
    
    reader.readAsText(file);
  };
  
  input.click();
}

// Cleanup old audit logs
async function cleanupAuditLogs() {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', 'Admin only', 'error');
    return;
  }
  
  const daysToKeep = prompt('Delete audit logs older than how many days? (default: 365)', '365');
  if (!daysToKeep) return;
  
  const days = parseInt(daysToKeep);
  if (isNaN(days) || days < 30) {
    showNotification('Validation Error', 'Minimum 30 days required', 'error');
    return;
  }
  
  if (!confirm(`⚠️ Delete all audit logs older than ${days} days?\n\nThis action cannot be undone.\nConsider backing up first.`)) {
    return;
  }
  
  try {
    const res = await fetch('/api/audit/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session': getSessionToken()
      },
      body: JSON.stringify({ days_to_keep: days })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Cleanup failed' }));
      showNotification('Error', err.detail || 'Cleanup failed', 'error');
      return;
    }
    
    const result = await res.json();
    showNotification(
      'Cleanup Complete',
      `Deleted ${result.deleted_count} old audit logs`,
      'success'
    );
    
    // Refresh audit logs from server
    if (isServerModeEnabled()) {
      await syncFromServer();
      render();
      lucide.createIcons();
    }
  } catch (error) {
    showNotification('Error', 'Cleanup failed: ' + error.message, 'error');
  }
}

// Get storage statistics
function getStorageStats() {
  const localStorageUsed = new Blob([localStorage.getItem('albayan_complete_state') || '']).size;
  const totalLogs = state.logs.length;
  
  return {
    localStorageUsedMB: (localStorageUsed / (1024 * 1024)).toFixed(2),
    totalLogs,
    logsInLocalStorage: Math.min(totalLogs, MAX_LOGS_IN_LOCALSTORAGE),
    hasIndexedDB: !!db
  };
}

function renderSettingsView() {
  const history = state.exchangeRateHistory || [];
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('settings')}</h1>

      <!-- Security -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="shield" class="w-5 h-5 mr-2 text-indigo-600"></i>
          ${t('security')}
        </h2>
        <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700 mb-4">
          <p class="text-sm text-slate-600 dark:text-slate-300">
            <i data-lucide="info" class="w-4 h-4 inline mr-1"></i>
            ${isServerModeEnabled()
              ? (state.language === 'ar'
                ? 'في وضع السيرفر: استخدم \"نسيت كلمة المرور\" للحصول على رمز استعادة (أو البريد الإلكتروني لاحقاً).'
                : 'Server mode: use \"Forgot password\" to get a reset code (email later).')
              : (state.language === 'ar'
                ? 'في الوضع المحلي: أنشئ مفتاح استعادة لاسترجاع كلمة المرور عند نسيانها.'
                : 'Local mode: create a Recovery Key to reset passwords if forgotten.')}
          </p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button onclick="showChangePasswordModal()" class="btn-shine bg-emerald-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-emerald-700">
            <i data-lucide="lock" class="w-5 h-5"></i>
            <span>${t('changePassword')}</span>
          </button>
          ${!isServerModeEnabled() ? `
            <button onclick="generateAndShowRecoveryKey()" class="btn-shine bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-indigo-700">
              <i data-lucide="key" class="w-5 h-5"></i>
              <span>${t('generateRecoveryKey')}</span>
            </button>
          ` : ''}
        </div>
        <div class="mt-3">
          <button onclick="passkeyRegisterCurrentUser()" class="w-full glass-panel rounded-xl px-4 py-3 font-bold flex items-center justify-center space-x-2 hover:shadow-xl">
            <i data-lucide="key-round" class="w-5 h-5"></i>
            <span>${state.language === 'ar' ? 'إضافة Passkey (Face ID / Touch ID)' : 'Add a Passkey (Face ID / Touch ID)'}</span>
          </button>
          <div class="mt-2 text-[11px] text-slate-400">
            ${state.language === 'ar'
              ? 'ملاحظة: Passkey يتطلب HTTPS أو localhost. لن يعمل عند فتح الملف مباشرة.'
              : 'Note: Passkeys require HTTPS or localhost. They won’t work when opening the file directly.'}
          </div>
          <div id="passkey-list" class="mt-3">
            ${(() => {
              const keys = Array.isArray(state.currentUser?.passkeys) ? state.currentUser.passkeys : [];
              if (!keys.length) {
                return `<div class="text-xs text-slate-400">${state.language === 'ar' ? 'لا يوجد Passkey مضاف بعد.' : 'No passkeys added yet.'}</div>`;
              }
              return `
                <div class="space-y-2">
                  ${keys.map((k, idx) => `
                    <div class="flex items-center justify-between p-3 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                      <div class="text-xs">
                        <div class="font-bold text-slate-700 dark:text-slate-200">${state.language === 'ar' ? 'Passkey' : 'Passkey'} #${idx + 1}</div>
                        <div class="font-mono text-[10px] text-slate-400 break-all">${Security.escapeHtml(String(k.id || '').slice(0, 20))}…</div>
                      </div>
                      <button type="button" onclick="removePasskey('${Security.escapeHtml(String(k.id || ''))}')" class="text-rose-600 hover:text-rose-700 text-xs font-bold">
                        <i data-lucide="trash-2" class="w-4 h-4 inline mr-1"></i>${state.language === 'ar' ? 'حذف' : 'Remove'}
                      </button>
                    </div>
                  `).join('')}
                </div>
              `;
            })()}
          </div>
        </div>
        ${!isServerModeEnabled() ? `
          <div class="mt-3 p-3 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs text-slate-500">
            ${state.localRecovery?.createdAt
              ? (state.language === 'ar'
                ? `مفتاح الاستعادة مُنشأ بتاريخ: ${new Date(state.localRecovery.createdAt).toLocaleString()}`
                : `Recovery key created: ${new Date(state.localRecovery.createdAt).toLocaleString()}`)
              : (state.language === 'ar'
                ? 'لم يتم إنشاء مفتاح استعادة بعد.'
                : 'No recovery key created yet.')}
          </div>
        ` : ''}
      </div>

      <!-- Exchange Rate -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="dollar-sign" class="w-5 h-5 mr-2 text-emerald-600"></i>
          Exchange Rate Management
        </h2>
        <div class="space-y-4">
          <div class="flex flex-col md:flex-row md:items-center space-y-2 md:space-y-0 md:space-x-4">
            <label class="text-sm font-medium text-slate-700 dark:text-slate-300">Current Rate (USD to LYD):</label>
            <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" onchange="updateExchangeRate(this.value)" class="glass-input px-4 py-2 rounded-xl w-32 font-bold text-emerald-600" />
            <button onclick="updateExchangeRate(document.querySelector('input[type=number]').value)" class="btn-shine bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm">Save Rate</button>
          </div>

          ${history.length > 0 ? `
            <div class="mt-6">
              <h3 class="text-sm font-bold text-slate-500 uppercase mb-3">Rate History (Last 10)</h3>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-slate-200 dark:border-slate-700">
                      <th class="text-left py-2">Date</th>
                      <th class="text-left py-2">Rate</th>
                      <th class="text-left py-2">Changed By</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${history.slice(0, 10).map(h => {
                      const user = state.users.find(u => u.id === h.userId);
                      return `
                        <tr class="border-b border-slate-100 dark:border-slate-800">
                          <td class="py-2 text-xs text-slate-500">${new Date(h.date).toLocaleString()}</td>
                          <td class="py-2 font-mono font-bold text-emerald-600">${h.rate.toFixed(2)}</td>
                          <td class="py-2 text-slate-600 dark:text-slate-400">${Security.escapeHtml(user?.name || 'System')}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Data Management -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="database" class="w-5 h-5 mr-2 text-blue-600"></i>
          Data Management
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick="exportData()" class="btn-shine bg-blue-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-blue-700">
            <i data-lucide="download" class="w-5 h-5"></i>
            <span>Export Backup</span>
          </button>
          <button onclick="importData()" class="btn-shine bg-green-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-green-700">
            <i data-lucide="upload" class="w-5 h-5"></i>
            <span>Import Backup</span>
          </button>
          <button onclick="clearAllData()" class="btn-shine bg-rose-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-rose-700">
            <i data-lucide="trash-2" class="w-5 h-5"></i>
            <span>Clear All Data</span>
          </button>
        </div>
        <div class="mt-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl">
          <p class="text-sm text-slate-600 dark:text-slate-400">
            <i data-lucide="info" class="w-4 h-4 inline mr-1"></i>
            Your data is stored locally in your browser. Export regularly to create backups.
          </p>
        </div>
      </div>

      <!-- Cloud Sync -->
      ${state.cloudConfig.enabled ? `
        <div class="glass-panel rounded-2xl p-6">
          <h2 class="text-xl font-bold mb-4 flex items-center">
            <i data-lucide="cloud" class="w-5 h-5 mr-2 text-indigo-600"></i>
            Cloud Sync
          </h2>
          <div class="space-y-4">
            <div class="flex items-center space-x-3 p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
              <i data-lucide="check-circle" class="w-5 h-5 text-emerald-600"></i>
              <div class="flex-1">
                <p class="font-medium text-emerald-700 dark:text-emerald-300">Cloud Sync Enabled</p>
                <p class="text-xs text-emerald-600 dark:text-emerald-400 mt-1">Last sync: ${state.lastCloudSync ? new Date(state.lastCloudSync).toLocaleString() : 'Never'}</p>
              </div>
            </div>
            <div class="flex space-x-3">
              <button onclick="pushToCloud()" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">
                <i data-lucide="upload-cloud" class="w-4 h-4 inline mr-2"></i>Push Now
              </button>
              <button onclick="pullFromCloud()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold">
                <i data-lucide="download-cloud" class="w-4 h-4 inline mr-2"></i>Pull Now
              </button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- App Info -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4">Application Info</h2>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between"><span class="text-slate-500">Version:</span><span class="font-mono">3.5.0 Vanilla</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Ads:</span><span class="font-bold">${getVisibleRecords(state.ads).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Customers:</span><span class="font-bold">${getVisibleRecords(state.customers).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Users:</span><span class="font-bold">${getVisibleRecords(state.users).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Audit Logs:</span><span class="font-bold">${getVisibleRecords(state.logs).length}</span></div>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// SEARCH & FILTER FUNCTIONS
// ==========================================

function filterAds() {
  // Search is handled by re-rendering with filtered data
  // This is called by oninput on search fields
  render();
}

function getFilteredAds() {
  let filtered = getVisibleRecords(state.ads).filter(ad => ad.recordType !== 'receipt');
  const searchTerm = document.getElementById('ad-search')?.value.toLowerCase() || '';
  
  if (searchTerm) {
    filtered = filtered.filter(ad => {
      const customer = state.customers.find(c => c.id === ad.customerId);
      return (
        customer?.name.toLowerCase().includes(searchTerm) ||
        ad.id.toLowerCase().includes(searchTerm) ||
        ad.phoneNumber?.toLowerCase().includes(searchTerm) ||
        ad.serialNumber?.toLowerCase().includes(searchTerm)
      );
    });
  }
  
  return filtered;
}

// ==========================================
// CUSTOMER VALIDATION FUNCTIONS
// ==========================================

// Check if any phone number is already used by another customer
function checkDuplicatePhone(phones, excludeCustomerId = null) {
  const allCustomers = getVisibleRecords(state.customers);
  
  for (const phone of phones) {
    if (!phone) continue;
    
    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
    
    for (const customer of allCustomers) {
      // Skip the current customer being edited
      if (excludeCustomerId && customer.id === excludeCustomerId) continue;
      
      // Check if this customer has the phone number
      if (customer.phones && Array.isArray(customer.phones)) {
        const hasPhone = customer.phones.some(p => {
          const normalizedCustomerPhone = (p || '').replace(/[\s\-\(\)]/g, '');
          return normalizedCustomerPhone === normalizedPhone;
        });
        
        if (hasPhone) {
          return {
            phone: phone,
            customerId: customer.id,
            customerName: customer.name || 'Unknown'
          };
        }
      }
    }
  }
  
  return null; // No duplicate found
}

// ==========================================
// CUSTOMER STATS CALCULATION FUNCTIONS
// ==========================================

function getCustomerStats(customerId) {
  const customerAds = getVisibleRecords(state.ads).filter(ad => ad.customerId === customerId && ad.recordType === 'ad');
  const customerReceipts = getVisibleRecords(state.receipts).filter(r => r.customerId === customerId);
  const linkedPages = getVisibleRecords(state.pages).filter(p => p.customerIds?.includes(customerId));
  
  // Calculate total paid from receipts (in LYD and USD)
  // IMPORTANT: Unpaid receipts (status "Not Paid") should NOT be counted as revenue.
  const paidReceipts = customerReceipts.filter(r => {
    const st = String(r.status || '');
    if (st === 'Canceled' || st === 'Lost') return false;
    return st === 'Paid' || r.isPaid === true;
  });
  const totalPaidLYD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountLocal || 0), 0);
  const totalPaidUSD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountUSD || 0), 0);
  
  // Calculate total spent USD from ads
  // For stopped ads, use spentUSD; for others, use amountUSD (the planned/active amount)
  const totalSpentUSD = customerAds.reduce((sum, ad) => {
    if (ad.status === 'Stopped' && ad.spentUSD !== undefined) {
      return sum + ad.spentUSD;
    }
    // For active/completed ads, count the full amount as spent
    if (['Completed', 'Canceled', 'Lost'].includes(ad.status)) {
      return sum + (ad.spentUSD !== undefined ? ad.spentUSD : (ad.amountUSD || 0));
    }
    // For pending/paused ads, don't count as spent yet
    if (['Pending', 'Paused'].includes(ad.status)) {
      return sum;
    }
    return sum + (ad.amountUSD || 0);
  }, 0);
  
  // Calculate spent LYD proportionally based on USD spent
  // This ensures spentLYD cannot exceed paidLYD
  let totalSpentLYD = 0;
  if (totalPaidUSD > 0) {
    // Proportional calculation: (spentUSD / paidUSD) * paidLYD
    totalSpentLYD = (totalSpentUSD / totalPaidUSD) * totalPaidLYD;
  }
  
  // Calculate balance (paid - spent)
  const balanceLYD = totalPaidLYD - totalSpentLYD;
  const balanceUSD = totalPaidUSD - totalSpentUSD;
  
  // Legacy balance (for backwards compatibility)
  const totalSpent = totalSpentLYD;
  const totalPaid = totalPaidLYD;
  const balance = balanceLYD;
  
  // Get last ad date
  const allCustomerAds = [...customerAds, ...customerReceipts];
  const lastAdDate = allCustomerAds.length > 0 
    ? Math.max(...allCustomerAds.map(ad => new Date(ad.date || ad.createdAt).getTime()))
    : null;
  
  return {
    totalSpent,
    totalPaid,
    balance,
    // LYD values (TOTAL PAID)
    totalSpentLYD,
    totalPaidLYD,
    balanceLYD,
    // USD values (TOTAL ADS CREDIT)
    totalSpentUSD,
    totalPaidUSD,
    balanceUSD,
    // Other stats
    lastAdDate,
    totalAds: customerAds.length,
    totalReceipts: customerReceipts.length,
    linkedPagesCount: linkedPages.length
  };
}

function getCustomerSortValue(customer, sortType) {
  const stats = getCustomerStats(customer.id);
  
  switch (sortType) {
    case 'newest':
      return new Date(customer.joinDate).getTime();
    case 'oldest':
      return -new Date(customer.joinDate).getTime();
    case 'lastActive':
      return stats.lastAdDate || 0;
    case 'highestPaid':
      return stats.totalPaid;
    case 'lowestPaid':
      return -stats.totalPaid;
    case 'mostSpend':
      return stats.totalSpent;
    case 'leastSpend':
      return -stats.totalSpent;
    case 'biggestCredit':
      return stats.balance > 0 ? stats.balance : -Infinity;
    case 'highestDebt':
      return stats.balance < 0 ? -stats.balance : -Infinity;
    default:
      return 0;
  }
}

function getFilteredCustomers() {
  let filtered = getVisibleRecords(state.customers);
  const searchTerm = String(state.customerSearch || '').toLowerCase().trim();
  
  if (searchTerm) {
    filtered = filtered.filter(c => 
      String(c.name || '').toLowerCase().includes(searchTerm) ||
      (Array.isArray(c.phones) ? c.phones : []).some(p => String(p || '').includes(searchTerm)) ||
      String(c.platform || '').toLowerCase().includes(searchTerm)
    );
  }
  
  // Apply financial filter
  if (state.customerFinancialFilter === 'hasCredit') {
    filtered = filtered.filter(c => {
      const stats = getCustomerStats(c.id);
      return stats.balance > 0;
    });
  } else if (state.customerFinancialFilter === 'hasDebt') {
    filtered = filtered.filter(c => {
      const stats = getCustomerStats(c.id);
      return stats.balance < 0;
    });
  }
  
  // Apply sorting
  filtered.sort((a, b) => {
    const aValue = getCustomerSortValue(a, state.customerSort);
    const bValue = getCustomerSortValue(b, state.customerSort);
    return bValue - aValue; // Descending order
  });
  
  return filtered;
}

// ==========================================
// HELPER FUNCTIONS FOR VIEWS
// ==========================================

function editAd(id) {
  // Permission check for editing ads
  const ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'edit', ad?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الإعلانات' : 'You do not have permission to edit this ad', 'error');
    return;
  }
  state.activeModal = 'ad';
  state.modalData = ad;
  updateUrlParams({ modal: 'ad', id }); // URL tracking
  renderModal();
}

function editReceipt(id) {
  // Permission check for editing receipts
  const receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'edit', receipt?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الوصولات' : 'You do not have permission to edit this receipt', 'error');
    return;
  }
  state.activeModal = 'receipt';
  state.modalData = receipt;
  updateUrlParams({ modal: 'receipt', id }); // URL tracking
  renderModal();
}

function editCustomer(id) {
  // Permission check for editing customers
  const customer = state.customers.find(c => c.id === id);
  if (!canActOnRecord('customers', 'edit', customer?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل العملاء' : 'You do not have permission to edit this customer', 'error');
    return;
  }
  state.activeModal = 'customer';
  state.modalData = customer;
  updateUrlParams({ modal: 'customer', id }); // URL tracking
  renderModal();
}

function editPage(id) {
  // Permission check for editing pages
  if (!currentUserHasPermission('pages', 'edit')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الصفحات' : 'You do not have permission to edit pages', 'error');
    return;
  }
  state.activeModal = 'page';
  state.modalData = state.pages.find(p => p.id === id);
  updateUrlParams({ modal: 'page', id }); // URL tracking
  renderModal();
}

function editUser(id) {
  if (!isCurrentUserAdmin() && String(id) !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
    return;
  }
  state.activeModal = 'user';
  state.modalData = state.users.find(u => u.id === id);
  updateUrlParams({ modal: 'user', id }); // URL tracking
  renderModal();
}

// ==========================================
// ADVANCED PERMISSIONS MANAGEMENT
// ==========================================

function showPermissionsModal(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Permissions Manager is Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) {
    showNotification('Error', 'User not found', 'error');
    return;
  }
  
  // Admins shouldn't have their permissions edited (they have all by default)
  if (user.role === 'Admin') {
    showNotification('Info', 'Administrators have full access by default', 'info');
    return;
  }
  
  const userPermissions = user.permissions || {};
  const permSummary = getPermissionSummary(userPermissions);
  
  // Preserve scroll position so toggling permissions doesn't jump to the top
  let prevScrollTop = 0;
  const existingModal = document.getElementById('app-modal');
  if (existingModal) {
    const scroller = existingModal.querySelector('#permissions-scroll');
    if (scroller) prevScrollTop = scroller.scrollTop || 0;
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.dataset.modalType = 'permissions';
  modal.dataset.userId = String(userId);
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden animate-slide-up" onclick="event.stopPropagation()">
      <!-- Header -->
      <div class="bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 p-6 text-white">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-4">
            <div class="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <span class="text-2xl font-bold">${user.name.charAt(0)}</span>
            </div>
            <div>
              <h2 class="text-2xl font-bold">Permissions Manager</h2>
              <div class="flex items-center space-x-2 mt-1">
                <span class="text-white/80">${Security.escapeHtml(user.name || '')}</span>
                <span class="px-2 py-0.5 rounded-full bg-white/20 text-xs font-medium">${Security.escapeHtml(user.role || '')}</span>
              </div>
            </div>
          </div>
          <button onclick="this.closest('#app-modal').remove()" class="w-10 h-10 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
        
        <!-- Permission Stats Bar -->
        <div class="mt-4 flex items-center space-x-4">
          <div class="flex-1 bg-white/20 rounded-full h-3 overflow-hidden">
            <div id="perm-summary-bar" class="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 rounded-full transition-all duration-300" style="width: ${permSummary.percentage}%"></div>
          </div>
          <span id="perm-summary-count" class="font-bold text-lg">${permSummary.granted}/${permSummary.total}</span>
        </div>
      </div>
      
      <div id="permissions-scroll" class="p-6 overflow-y-auto max-h-[calc(90vh-200px)] custom-scrollbar">
        <!-- Quick Templates -->
        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase flex items-center space-x-2">
              <i data-lucide="zap" class="w-4 h-4 text-amber-500"></i>
              <span>Quick Templates</span>
            </h3>
            <button onclick="clearAllPermissions('${userId}')" class="text-xs text-rose-600 hover:text-rose-700 font-medium flex items-center space-x-1">
              <i data-lucide="trash-2" class="w-3 h-3"></i>
              <span>Clear All</span>
            </button>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            ${Object.entries(PERMISSION_TEMPLATES).map(([key, template]) => `
              <button onclick="applyPermissionTemplate('${userId}', '${key}')" class="p-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 hover:border-${template.color}-500 hover:bg-${template.color}-50 dark:hover:bg-${template.color}-900/20 transition-all text-center group">
                <i data-lucide="${template.icon}" class="w-5 h-5 mx-auto mb-1 text-${template.color}-600 group-hover:scale-110 transition-transform"></i>
                <div class="text-xs font-bold text-slate-700 dark:text-slate-300">${template.name}</div>
                <div class="text-[10px] text-slate-500 line-clamp-1">${template.description}</div>
              </button>
            `).join('')}
          </div>
        </div>
        
        <!-- Granular Permissions -->
        <div class="space-y-4">
          ${Object.entries(PERMISSION_MODULES).map(([moduleKey, moduleConfig]) => {
            const modulePerms = userPermissions[moduleKey] || [];
            const modulePermCount = Object.keys(moduleConfig.permissions).length;
            const moduleGranted = modulePerms.length;
            const allSelected = moduleGranted === modulePermCount;
            
            return `
              <div class="border-2 border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden hover:border-${moduleConfig.color}-300 dark:hover:border-${moduleConfig.color}-700 transition-colors">
                <!-- Module Header -->
                <div class="p-4 bg-${moduleConfig.color}-50 dark:bg-${moduleConfig.color}-900/20 flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <div class="w-10 h-10 rounded-xl bg-${moduleConfig.color}-100 dark:bg-${moduleConfig.color}-800 flex items-center justify-center">
                      <i data-lucide="${moduleConfig.icon}" class="w-5 h-5 text-${moduleConfig.color}-600 dark:text-${moduleConfig.color}-400"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800 dark:text-white">${moduleConfig.name}</h4>
                      <p class="text-xs text-slate-500">${moduleConfig.description}</p>
                    </div>
                  </div>
                  <div class="flex items-center space-x-3">
                    <span id="perm-module-count-${moduleKey}" class="text-xs font-bold ${moduleGranted > 0 ? 'text-emerald-600' : 'text-slate-400'}">${moduleGranted}/${modulePermCount}</span>
                    <button id="perm-module-toggle-${moduleKey}" data-color="${moduleConfig.color}" onclick="toggleModulePermissions('${userId}', '${moduleKey}', ${!allSelected})" class="px-3 py-1.5 rounded-lg text-xs font-bold ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : 'bg-' + moduleConfig.color + '-600 text-white'} hover:opacity-80 transition-all">
                      ${allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                </div>
                
                <!-- Permissions Grid -->
                <div class="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  ${Object.entries(moduleConfig.permissions).map(([permKey, permConfig]) => {
                    const isEnabled = modulePerms.includes(permKey);
                    return `
                      <label class="flex items-start space-x-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group">
                        <input type="checkbox" 
                          ${isEnabled ? 'checked' : ''} 
                          onchange="togglePermission('${userId}', '${moduleKey}', '${permKey}', this.checked)"
                          data-module="${moduleKey}"
                          data-perm="${permKey}"
                          class="mt-0.5 w-4 h-4 rounded border-slate-300 text-${moduleConfig.color}-600 focus:ring-${moduleConfig.color}-500 cursor-pointer"
                        />
                        <div class="flex-1">
                          <div class="text-sm font-medium text-slate-700 dark:text-slate-300 group-hover:text-${moduleConfig.color}-600">${permConfig.label}</div>
                          <div class="text-[10px] text-slate-500">${permConfig.description}</div>
                        </div>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <!-- Footer -->
      <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
        <div class="text-xs text-slate-500">
          <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
          Changes are saved automatically
        </div>
        <div class="flex items-center space-x-3">
          <button onclick="exportUserPermissions('${userId}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center space-x-2 transition-colors">
            <i data-lucide="download" class="w-3 h-3"></i>
            <span>Export</span>
          </button>
          <button onclick="this.closest('#app-modal').remove()" class="px-6 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:opacity-90 transition-all">
            Done
          </button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  const scroller = document.getElementById('permissions-scroll');
  if (scroller) scroller.scrollTop = prevScrollTop;
}

function refreshPermissionsModalUi(userId, moduleKey = null) {
  const modal = document.getElementById('app-modal');
  if (!modal || modal.dataset?.modalType !== 'permissions') return;
  if (String(modal.dataset.userId || '') !== String(userId || '')) return;

  const user = state.users.find(u => u && !u._deleted && u.id === userId);
  if (!user) return;

  const perms = user.permissions || {};
  const summary = getPermissionSummary(perms);
  const bar = modal.querySelector('#perm-summary-bar');
  const count = modal.querySelector('#perm-summary-count');
  if (bar) bar.style.width = `${summary.percentage}%`;
  if (count) count.textContent = `${summary.granted}/${summary.total}`;

  const updateModule = (mk) => {
    const cfg = PERMISSION_MODULES[mk];
    if (!cfg) return;
    const modulePerms = perms[mk] || [];
    const modulePermCount = Object.keys(cfg.permissions).length;
    const moduleGranted = modulePerms.length;
    const allSelected = moduleGranted === modulePermCount;

    const countEl = modal.querySelector(`#perm-module-count-${mk}`);
    if (countEl) countEl.textContent = `${moduleGranted}/${modulePermCount}`;

    const btn = modal.querySelector(`#perm-module-toggle-${mk}`);
    if (btn) {
      btn.setAttribute('onclick', `toggleModulePermissions('${String(userId)}', '${String(mk)}', ${!allSelected})`);
      btn.textContent = allSelected ? 'Deselect All' : 'Select All';
      const base = 'px-3 py-1.5 rounded-lg text-xs font-bold hover:opacity-80 transition-all';
      const color = String(btn.dataset.color || cfg.color || 'indigo');
      btn.className = `${base} ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : `bg-${color}-600 text-white`}`;
    }
  };

  if (moduleKey) {
    updateModule(moduleKey);
  } else {
    for (const mk of Object.keys(PERMISSION_MODULES)) updateModule(mk);
  }
}

function togglePermission(userId, moduleKey, permKey, enabled) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!user.permissions) user.permissions = {};
  if (!user.permissions[moduleKey]) user.permissions[moduleKey] = [];
  
  if (enabled) {
    if (!user.permissions[moduleKey].includes(permKey)) {
      user.permissions[moduleKey].push(permKey);
    }
  } else {
    user.permissions[moduleKey] = user.permissions[moduleKey].filter(p => p !== permKey);
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  // Add audit log
  addAuditLog('update', userId, `${enabled ? 'Granted' : 'Revoked'} permission: ${moduleKey}.${permKey} for ${user.name}`, {
    resourceType: 'user',
    permission: `${moduleKey}.${permKey}`,
    action: enabled ? 'grant' : 'revoke'
  });
  
  // Update UI in-place (no blinking)
  refreshPermissionsModalUi(userId, moduleKey);
}

function toggleModulePermissions(userId, moduleKey, enableAll) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const moduleConfig = PERMISSION_MODULES[moduleKey];
  if (!moduleConfig) return;
  
  if (!user.permissions) user.permissions = {};
  
  if (enableAll) {
    user.permissions[moduleKey] = Object.keys(moduleConfig.permissions);
  } else {
    user.permissions[moduleKey] = [];
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `${enableAll ? 'Granted all' : 'Revoked all'} ${moduleKey} permissions for ${user.name}`, {
    resourceType: 'user',
    module: moduleKey,
    action: enableAll ? 'grant_all' : 'revoke_all'
  });
  
  // Update checkbox states in-place + refresh header counts
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll(`input[type="checkbox"][data-module="${moduleKey}"]`).forEach((el) => {
      el.checked = !!enableAll;
    });
  }
  refreshPermissionsModalUi(userId, moduleKey);
}

function applyPermissionTemplate(userId, templateKey) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const template = PERMISSION_TEMPLATES[templateKey];
  if (!template) return;
  
  user.permissions = JSON.parse(JSON.stringify(template.permissions));
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Applied permission template "${template.name}" to ${user.name}`, {
    resourceType: 'user',
    template: templateKey
  });
  
  showNotification('Template Applied', `${template.name} permissions applied to ${user.name}`, 'success');
  // Update UI in-place (no blinking)
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
      const mk = el.getAttribute('data-module');
      const pk = el.getAttribute('data-perm');
      const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
      el.checked = allowed;
    });
  }
  refreshPermissionsModalUi(userId);
}

function clearAllPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!confirm(`Clear all permissions for ${user.name}? They will lose access to most features.`)) return;
  
  user.permissions = {};
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Cleared all permissions for ${user.name}`, {
    resourceType: 'user',
    action: 'clear_all'
  });
  
  showNotification('Cleared', `All permissions cleared for ${user.name}`, 'success');
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => { el.checked = false; });
  }
  refreshPermissionsModalUi(userId);
}

function exportUserPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const exportData = {
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    exportDate: new Date().toISOString(),
    permissions: user.permissions || {}
  };
  
  const json = JSON.stringify(exportData, null, 2);
  downloadFile(json, `permissions-${user.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  
  showNotification('Exported', `Permissions exported for ${user.name}`, 'success');
}

function importUserPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        const user = state.users.find(u => u.id === userId);
        if (!user) return;
        
        if (data.permissions) {
          user.permissions = data.permissions;
          user._lastModified = getMonotonicTime();
          markCollectionDirty('users');
          saveState();
          flushDirtyCollections().catch(() => {});
          scheduleServerUserUpdate(userId, { permissions: user.permissions });
          
          addAuditLog('update', userId, `Imported permissions for ${user.name}`, {
            resourceType: 'user',
            action: 'import'
          });
          
          showNotification('Imported', `Permissions imported for ${user.name}`, 'success');
          const modal = document.getElementById('app-modal');
          if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
            modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
              const mk = el.getAttribute('data-module');
              const pk = el.getAttribute('data-perm');
              const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
              el.checked = allowed;
            });
          }
          refreshPermissionsModalUi(userId);
        }
      } catch (error) {
        showNotification('Error', 'Invalid permissions file', 'error');
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}

function assignDelivery(itemId, userId) {
  if (!userId) return;
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    updateRecord(state.receipts, itemId, { deliveryPersonId: userId });
  } else {
    updateRecord(state.ads, itemId, { deliveryPersonId: userId });
  }
  showNotification('Assigned', 'Delivery person assigned', 'success');
  render();
}

function updateDeliveryStatus(itemId, status) {
  const s = String(status || '').trim();
  if (!s) return;
  if (s === 'Canceled') {
    // Require a reason (handled by modal)
    openDeliveryCancelModal(itemId);
    return;
  }
  if (s === 'Office') {
    // Treat as "delete mission" (remove from delivery tracking)
    removeDeliveryMission(itemId);
    return;
  }
  if (s === 'Delivered' && String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Not Allowed', 'Only the assigned delivery driver can mark a delivery as Delivered.', 'warning');
    return;
  }
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    updateRecord(state.receipts, itemId, { deliveryStatus: s });
  } else {
    updateRecord(state.ads, itemId, { deliveryStatus: s });
  }
  showNotification('Updated', `Status changed to ${s}`, 'success');
  render();
}

function markAsCollected(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    // Temp delivery receipts require strict completion (final receipt # + photo + amounts).
    if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
      showNotification('Not Allowed', 'Use "Mark Delivered" to complete this delivery with receipt photo + final number.', 'warning');
      openReceiptDeliveryCompletionModal(itemId);
      return;
    }
    updateRecord(state.receipts, itemId, { 
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Paid',
      deliveryStatus: 'Delivered'
    });
  } else {
    updateRecord(state.ads, itemId, { 
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Completed'
    });
  }
  // Update delivery stats if delivery user
  if (state.currentUser?.role === 'Delivery' && state.currentUser.stats) {
    state.currentUser.stats.collected = (state.currentUser.stats.collected || 0) + 1;
    updateRecord(state.users, state.currentUser.id, { stats: state.currentUser.stats });
  }
  showNotification('Collected', 'Payment marked as collected', 'success');
  render();
}

function acceptDelivery(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const updateData = {
    deliveryStatus: 'In Progress',
    acceptedDate: new Date().toISOString()
  };
  
  if (isReceipt) {
    updateRecord(state.receipts, itemId, updateData);
  } else {
    updateRecord(state.ads, itemId, updateData);
  }
  // Update delivery stats
  if (state.currentUser?.role === 'Delivery' && state.currentUser.stats) {
    state.currentUser.stats.accepted = (state.currentUser.stats.accepted || 0) + 1;
    state.currentUser.stats.totalAds = (state.currentUser.stats.totalAds || 0) + 1;
    updateRecord(state.users, state.currentUser.id, { stats: state.currentUser.stats });
  }
  showNotification('Accepted', 'Delivery accepted', 'success');
  render();
}

// ==========================================
// TEMP DELIVERY RECEIPT: DRIVER CONFIRMATION FLOW
// ==========================================

function normalizePhoneToE164(phone) {
  let s = String(phone || '').trim();
  if (!s) return '';
  // Keep digits and leading +
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

function buildWhatsAppLink(phone) {
  const e164 = normalizePhoneToE164(phone);
  const digits = String(e164 || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}`;
}

function compareFees(quoted, actual) {
  const q = Number(quoted) || 0;
  const a = Number(actual) || 0;
  const diff = a - q;
  if (Math.abs(diff) < 0.000001) return { feeDifferenceStatus: 'SAME', feeDiff: 0 };
  if (diff < 0) return { feeDifferenceStatus: 'LOWER', feeDiff: diff };
  return { feeDifferenceStatus: 'HIGHER', feeDiff: diff };
}

function compareDebt(debtAmount, collectedAmount) {
  const d = Number(debtAmount) || 0;
  const c = Number(collectedAmount) || 0;
  const difference = c - d;
  if (Math.abs(difference) < 0.000001) return { paymentResult: 'PAID_EXACT', difference: 0, overpaidAmount: 0, remainingDue: 0 };
  if (difference > 0) return { paymentResult: 'OVERPAID', difference, overpaidAmount: difference, remainingDue: 0 };
  return { paymentResult: 'UNDERPAID', difference, overpaidAmount: 0, remainingDue: Math.abs(difference) };
}

function _findReceiptForDeliveryModal(receiptId) {
  const rid = String(receiptId || '');
  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === rid);
  return receipt || null;
}

function _receiptFinalNoExists(serial, excludeId) {
  const s = String(serial || '').trim();
  if (!s) return false;
  return !!state.receipts.find(r =>
    r && !r._deleted &&
    String(r.id) !== String(excludeId || '') &&
    (String(r.serialNumber || '').trim() === s || String(r.finalReceiptNo || '').trim() === s)
  );
}

function handleDeliveryReceiptPhotoUpload(fileList) {
  const file = fileList && fileList.length ? fileList[0] : null;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = String(e.target?.result || '');
    const hidden = document.getElementById('delivery-receipt-image-data');
    if (hidden) hidden.dataset.imageData = dataUrl;
    const img = document.getElementById('delivery-receipt-image-preview');
    if (img) img.src = dataUrl;
    updateReceiptDeliveryCompletionComputed();
  };
  reader.readAsDataURL(file);
}

function updateReceiptDeliveryCompletionComputed() {
  const modal = document.getElementById('delivery-complete-modal');
  if (!modal) return;
  const rid = modal.dataset.receiptId || '';
  const receipt = _findReceiptForDeliveryModal(rid);
  if (!receipt) return;

  const debt = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;

  const finalNo = String(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  const collected = parseFloat(String(document.getElementById('delivery-collected-amount')?.value || '').trim()) || 0;
  const actualFee = parseFloat(String(document.getElementById('delivery-actual-fee')?.value || '').trim()) || 0;
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();

  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Compute comparisons
  const feeCmp = compareFees(quoted, actualFee);
  const debtCmp = compareDebt(debt, collected);

  const feeEl = document.getElementById('delivery-fee-compare');
  const debtEl = document.getElementById('delivery-debt-compare');
  if (feeEl) {
    const diff = feeCmp.feeDiff;
    feeEl.textContent = feeCmp.feeDifferenceStatus === 'SAME'
      ? 'Fee: SAME'
      : (feeCmp.feeDifferenceStatus === 'LOWER'
        ? `Fee: LOWER (${Math.abs(diff).toFixed(0)} LYD)`
        : `Fee: HIGHER (${diff.toFixed(0)} LYD)`);
  }
  if (debtEl) {
    if (debtCmp.paymentResult === 'PAID_EXACT') debtEl.textContent = 'Payment: PAID EXACT';
    if (debtCmp.paymentResult === 'OVERPAID') debtEl.textContent = `Payment: OVERPAID (+${debtCmp.overpaidAmount.toFixed(0)} LYD)`;
    if (debtCmp.paymentResult === 'UNDERPAID') debtEl.textContent = `Payment: UNDERPAID (${debtCmp.remainingDue.toFixed(0)} LYD remaining)`;
  }

  // Validate (allow S-prefixed auto-serials for LTT/Libyana/Madar)
  const errEl = document.getElementById('delivery-final-receipt-error');
  const isAutoSerialValidation = isAutoSerialNumber(finalNo);
  let ok = true;
  if (!finalNo) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number is required.';
  } else if (!isAutoSerialValidation && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0'))) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number must be digits (no leading 0) or S-prefixed (S1, S2).';
  } else if (_receiptFinalNoExists(finalNo, receipt.id)) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number already exists.';
  } else {
    if (errEl) errEl.textContent = '';
  }

  if (!Number.isFinite(collected) || collected < 0) ok = false;
  if (!Number.isFinite(actualFee) || actualFee < 0) ok = false;
  if (!imgData) ok = false;

  const btn = document.getElementById('delivery-complete-submit');
  if (btn) btn.disabled = !ok;

  // Keep notes (no-op, but avoids unused var warnings in some linters)
  void notes;
}

function openReceiptDeliveryCompletionModal(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }
  if (String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Access Denied', 'Delivery users only', 'error');
    return;
  }
  if (String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', 'This receipt is not assigned to you', 'error');
    return;
  }

  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(receipt.customerId));
  const phone = String(receipt.phoneNumber || customer?.phones?.[0] || '').trim();
  const debt = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const tempNo = String(receipt.tempReceiptNo || '').trim();
  const finalNo = String(receipt.finalReceiptNo || receipt.serialNumber || '').trim();
  const place = String(receipt.deliveryPlaceName || '').trim();

  // Remove any existing modal
  document.getElementById('delivery-complete-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'delivery-complete-modal';
  modal.dataset.receiptId = String(receipt.id);
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <i data-lucide="check-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">Mark Delivered</div>
            <div class="text-xs text-slate-500">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-complete-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-500 mb-1">Receipt</div>
          <div class="font-bold text-indigo-600">${Security.escapeHtml(tempNo || 'D?')}${finalNo ? ` → ${Security.escapeHtml(finalNo)}` : ''}</div>
          ${place ? `<div class="text-xs text-slate-600 dark:text-slate-300 mt-1"><span class="font-bold">📍</span> ${Security.escapeHtml(place)}</div>` : ''}
          <div class="text-xs text-slate-500 mt-1">Debt due: <span class="font-bold text-slate-800 dark:text-slate-200">${debt.toFixed(0)} LYD</span> • Quoted fee: <span class="font-bold text-emerald-600">${quoted.toFixed(0)} LYD</span></div>
          ${phone ? `<div class="text-xs text-slate-500 mt-1">Phone: <span class="font-bold text-slate-700 dark:text-slate-300">${Security.escapeHtml(phone)}</span></div>` : ''}
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Final receipt number *</label>
          <input id="delivery-final-receipt-no" type="text" inputmode="numeric" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="e.g., 45873" value="${Security.escapeHtml(finalNo)}" oninput="this.value=this.value.replace(/[^0-9]/g,''); updateReceiptDeliveryCompletionComputed()" />
          <div id="delivery-final-receipt-error" class="mt-1 text-[11px] text-rose-600"></div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Amount collected (LYD) *</label>
            <input id="delivery-collected-amount" type="text" inputmode="decimal" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${Security.escapeHtml(String(receipt.amountCollectedFromCustomer ?? ''))}" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Actual delivery fee collected (LYD) *</label>
            <input id="delivery-actual-fee" type="text" inputmode="decimal" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${Security.escapeHtml(String(receipt.actualDeliveryFeeCollected ?? receipt.deliveryFeeCollected ?? ''))}" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between mb-2">
            <div class="text-xs font-bold text-slate-600 dark:text-slate-400">Receipt photo *</div>
            <label class="text-xs font-bold text-indigo-600 hover:text-indigo-700 cursor-pointer">
              Upload
              <input type="file" accept="image/*" class="hidden" onchange="handleDeliveryReceiptPhotoUpload(this.files)" />
            </label>
          </div>
          <input type="hidden" id="delivery-receipt-image-data" data-image-data="${Security.escapeHtml(String(receipt.receiptImage || receipt.photos?.[0] || ''))}" />
          <img id="delivery-receipt-image-preview" src="${Security.escapeHtml(String(receipt.receiptImage || receipt.photos?.[0] || ''))}" class="${(receipt.receiptImage || receipt.photos?.[0]) ? '' : 'hidden'} w-full h-36 object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
          ${(receipt.receiptImage || receipt.photos?.[0]) ? '' : '<div class="text-xs text-slate-400">No photo yet.</div>'}
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Driver notes (optional)</label>
          <textarea id="delivery-driver-notes" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Notes..." oninput="updateReceiptDeliveryCompletionComputed()">${Security.escapeHtml(String(receipt.driverNotes || ''))}</textarea>
        </div>

        <div class="grid grid-cols-2 gap-3 text-xs">
          <div id="delivery-debt-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
          <div id="delivery-fee-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
        </div>

        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="openReceiptDeliveryCancelModal('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            <i data-lucide="x-circle" class="w-4 h-4 inline mr-1"></i>Cancel Delivery
          </button>
          <button type="button" id="delivery-complete-submit" onclick="submitReceiptDeliveryCompletion('${receipt.id}')" class="flex-1 btn-shine bg-emerald-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed">
            <i data-lucide="check" class="w-4 h-4 inline mr-1"></i>Mark Delivered
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  // If we have an existing image, show it
  const img = document.getElementById('delivery-receipt-image-preview');
  if (img && img.getAttribute('src')) img.classList.remove('hidden');
  updateReceiptDeliveryCompletionComputed();
}

async function submitReceiptDeliveryCompletion(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }

  const finalNo = String(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  const collected = parseFloat(String(document.getElementById('delivery-collected-amount')?.value || '').trim()) || 0;
  const actualFee = parseFloat(String(document.getElementById('delivery-actual-fee')?.value || '').trim()) || 0;
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();
  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Allow S-prefixed auto-serial numbers (S1, S2, etc.) for LTT/Libyana/Madar
  const isAutoSerialFinal = isAutoSerialNumber(finalNo);
  if (!finalNo || (!isAutoSerialFinal && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0')))) {
    showNotification('Validation', 'Final receipt number is required (digits only, no leading 0, or S-prefix for LTT/Libyana/Madar).', 'error');
    return;
  }
  if (_receiptFinalNoExists(finalNo, receipt.id)) {
    showNotification('Validation', 'Final receipt number already exists.', 'error');
    return;
  }
  if (!imgData) {
    showNotification('Validation', 'Receipt photo is required.', 'error');
    return;
  }
  if (!Number.isFinite(collected) || collected < 0) {
    showNotification('Validation', 'Amount collected is required.', 'error');
    return;
  }
  if (!Number.isFinite(actualFee) || actualFee < 0) {
    showNotification('Validation', 'Actual delivery fee is required.', 'error');
    return;
  }

  const debtLocal = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const debtCmp = compareDebt(debtLocal, collected);
  const feeCmp = compareFees(quoted, actualFee);

  const rate = Number(receipt.exchangeRate || state.defaultExchangeRate || 1) || 1;
  const collectedUSD = rate > 0 ? (collected / rate) : 0;

  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({
    ts: new Date().toISOString(),
    userId: state.currentUser?.id || '',
    action: 'DELIVERED',
    tempReceiptNo: receipt.tempReceiptNo || '',
    finalReceiptNo: finalNo,
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee
  });

  const newStatus = (debtCmp.paymentResult === 'UNDERPAID') ? 'Not Paid' : 'Paid';
  const newIsPaid = debtCmp.paymentResult !== 'UNDERPAID';

  const updates = {
    deliveryStatus: 'Delivered',
    deliveredAt: new Date().toISOString(),
    finalReceiptNo: finalNo,
    serialNumber: finalNo,
    receiptImage: imgData,
    photos: [imgData, ...(Array.isArray(receipt.photos) ? receipt.photos.filter(Boolean) : [])].slice(0, 6),
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee,
    deliveryFeeCollected: actualFee,
    driverNotes: notes,
    debtAmountLocal: receipt.debtAmountLocal ?? debtLocal,
    debtAmountUSD: receipt.debtAmountUSD ?? (Number(receipt.amountUSD || 0) || 0),
    paymentResult: debtCmp.paymentResult,
    overpaidAmount: debtCmp.overpaidAmount,
    remainingDue: debtCmp.remainingDue,
    feeDifferenceStatus: feeCmp.feeDifferenceStatus,
    feeDiff: feeCmp.feeDiff,
    ownerCoveredExtraFee: receipt.ownerCoveredExtraFee ?? 0,
    status: newStatus,
    isPaid: newIsPaid,
    amountLocal: collected,
    amountUSD: collectedUSD,
    deliveryHistory: nextHistory
  };

  // Server-confirmed save for Delivery users: only show success when backend confirms.
  if (isServerModeEnabled()) {
    const btn = document.getElementById('delivery-complete-submit');
    if (btn) btn.disabled = true;
    try {
      const expected = receipt._lastModified || 0;
      const res = await apiPatchEntity('receipts', receipt.id, updates, expected);
      const saved = res?.data ? Security.sanitizeObject(res.data) : null;
      if (!saved || !saved.id) {
        showNotification('Server Error', 'Failed to save delivery: invalid server response', 'error');
        if (btn) btn.disabled = false;
        return;
      }
      const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
      if (idx !== -1) state.receipts[idx] = saved;
      markCollectionDirty('receipts');
      saveState();
      document.getElementById('delivery-complete-modal')?.remove();
      showNotification('Delivered', 'Delivery completed and saved', 'success');
      render();
    } catch (e) {
      // Idempotency / retries: if we hit a conflict, load latest and succeed if already delivered.
      if (e?.status === 409) {
        try {
          const latest = await apiGetEntity('receipts', receipt.id);
          const latestData = latest?.data ? Security.sanitizeObject(latest.data) : null;
          if (latestData && String(latestData.deliveryStatus || '') === 'Delivered') {
            const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
            if (idx !== -1) state.receipts[idx] = latestData;
            markCollectionDirty('receipts');
            saveState();
            document.getElementById('delivery-complete-modal')?.remove();
            showNotification('Delivered', 'Delivery completed and saved', 'success');
            render();
            return;
          }
        } catch (retryErr) {
          // Fall through to error toast - retry also failed
          if (ALBAYAN_DEBUG_MODE) console.warn('[handleDeliveryComplete] Retry fetch failed:', retryErr?.message || retryErr);
        }
      }
      const status = e?.status ? `HTTP ${e.status}` : '';
      const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
      showNotification('Server Error', `Failed to save delivery: ${status ? status + ' - ' : ''}${detail}`, 'error');
      if (btn) btn.disabled = false;
      return;
    }
  } else {
    // Local mode: optimistic update
    updateRecord(state.receipts, receipt.id, updates);
    document.getElementById('delivery-complete-modal')?.remove();
    showNotification('Delivered', 'Delivery completed and saved', 'success');
    render();
  }
}

function openReceiptDeliveryCancelModal(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }
  if (String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Access Denied', 'Delivery users only', 'error');
    return;
  }
  if (String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', 'This receipt is not assigned to you', 'error');
    return;
  }
  if (String(receipt.deliveryStatus || '') === 'Delivered') {
    showNotification('Not Allowed', 'Already delivered.', 'warning');
    return;
  }

  document.getElementById('delivery-cancel-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'delivery-cancel-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-md animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center">
            <i data-lucide="x-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">Cancel Delivery</div>
            <div class="text-xs text-slate-500">Receipt ${Security.escapeHtml(String(receipt.tempReceiptNo || receipt.serialNumber || receipt.id))}</div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-cancel-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Reason *</label>
          <textarea id="delivery-cancel-reason" rows="3" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Why are you cancelling?"></textarea>
        </div>
        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="this.closest('#delivery-cancel-modal').remove()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">Close</button>
          <button type="button" onclick="submitReceiptDeliveryCancel('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            Confirm Cancel
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function submitReceiptDeliveryCancel(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) return;
  const reason = String(document.getElementById('delivery-cancel-reason')?.value || '').trim();
  if (!reason) {
    showNotification('Validation', 'Cancel reason is required.', 'error');
    return;
  }
  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({
    ts: new Date().toISOString(),
    userId: state.currentUser?.id || '',
    action: 'CANCELLED_BY_DRIVER',
    reason
  });
  updateRecord(state.receipts, receipt.id, {
    deliveryStatus: 'Canceled',
    deliveryCancelReason: reason,
    deliveryCancelledAt: new Date().toISOString(),
    deliveryCancelledBy: state.currentUser?.id || '',
    deliveryHistory: nextHistory
  });
  document.getElementById('delivery-cancel-modal')?.remove();
  document.getElementById('delivery-complete-modal')?.remove();
  showNotification('Canceled', 'Delivery canceled', 'success');
  render();
}

function markAsDelivered(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    // Strict flow for temp delivery receipts: require final receipt # + photo + amounts
    if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
      openReceiptDeliveryCompletionModal(itemId);
      return;
    }
    // Delivered ≠ Office Handover. Office handover is a separate step (isReceivedInOffice).
    updateRecord(state.receipts, itemId, { deliveryStatus: 'Delivered' });
  } else {
    updateRecord(state.ads, itemId, {
      deliveryStatus: 'Delivered'
    });
  }
  showNotification('Delivered', 'Marked as delivered', 'success');
  render();
}

// ==========================================
// RECEIPT FILTER FUNCTIONS
// ==========================================

let _receiptSearchTimer = null;

function updateReceiptSearch(value) {
  const v = String(value || '');
  const clean = Security.sanitizeInput(v, { maxLength: 200 });
  state.receiptSearch = clean;
  if (_receiptSearchTimer) clearTimeout(_receiptSearchTimer);
  // Small debounce to keep typing smooth (same pattern as the customers view).
  // Only the results below the search box are re-rendered, so the input keeps
  // focus naturally — no full-page rebuild, no refocus hack.
  _receiptSearchTimer = setTimeout(() => {
    _receiptSearchTimer = null;
    updateReceiptsViewFiltered();
  }, 120);
}

function updateReceiptsViewFiltered() {
  if (state.currentView !== 'receipts') return;
  const grid = document.getElementById('receipts-grid');
  const countEl = document.getElementById('receipts-count');
  const chipsEl = document.getElementById('receipt-active-filters');
  const clearEl = document.getElementById('receipt-search-clear');
  const clearFiltersEl = document.getElementById('receipt-clear-filters');
  if (!grid || !countEl) {
    // View structure not on screen (e.g. mid-navigation): fall back to a full render.
    render();
    if (window.lucide) lucide.createIcons();
    return;
  }
  // Build the fresh view HTML off-screen, then swap in only the parts that
  // change while searching (results grid, count, filter chips, clear button).
  const tpl = document.createElement('template');
  tpl.innerHTML = renderReceiptsView();
  const src = tpl.content;
  const newGrid = src.querySelector('#receipts-grid');
  const newCount = src.querySelector('#receipts-count');
  const newChips = src.querySelector('#receipt-active-filters');
  const newClear = src.querySelector('#receipt-search-clear');
  const newClearFilters = src.querySelector('#receipt-clear-filters');
  if (newGrid) grid.innerHTML = newGrid.innerHTML;
  if (newCount) countEl.textContent = newCount.textContent;
  if (chipsEl && newChips) chipsEl.innerHTML = newChips.innerHTML;
  if (clearEl && newClear) clearEl.innerHTML = newClear.innerHTML;
  if (clearFiltersEl && newClearFilters) clearFiltersEl.innerHTML = newClearFilters.innerHTML;
  if (window.lucide) lucide.createIcons();
}

function clearReceiptSearch() {
  state.receiptSearch = '';
  render();
  lucide.createIcons();
}

function updateReceiptFilter(filterType, value) {
  switch (filterType) {
    case 'status':
      state.receiptStatusFilter = value;
      break;
    case 'payment':
      state.receiptPaymentFilter = value;
      break;
    case 'date':
      state.receiptDateFilter = value;
      break;
    case 'collected':
      state.receiptCollectedFilter = value;
      break;
    case 'sort':
      state.receiptSortBy = value;
      break;
  }
  render();
  lucide.createIcons();
}

function clearAllReceiptFilters() {
  state.receiptSearch = '';
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  render();
  lucide.createIcons();
}

// Toggle receipt collected status
function toggleReceiptCollected(receiptId) {
  // Permission check
  if (!currentUserHasPermission('receipts', 'markCollected')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل حالة التحصيل' : 'You do not have permission to mark receipts as collected', 'error');
    return;
  }
  
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  
  const wasCollected = receipt.collected;
  receipt.collected = !wasCollected;
  
  if (receipt.collected) {
    receipt.collectedAt = new Date().toISOString();
    receipt.collectedBy = state.currentUser?.id || 'admin';
  } else {
    receipt.collectedAt = null;
    receipt.collectedBy = null;
  }
  
  // Log the action
  state.logs.push({
    id: generateId(),
    type: 'receipt_collection',
    action: receipt.collected ? 'collected' : 'uncollected',
    receiptId: receiptId,
    userId: state.currentUser?.id,
    timestamp: new Date().toISOString(),
    details: {
      receiptSerial: receipt.serialNumber,
      amountUSD: receipt.amountUSD,
      amountLocal: receipt.amountLocal
    }
  });
  
  saveState();
  showNotification(
    receipt.collected ? 'Receipt Collected' : 'Collection Removed',
    receipt.collected ? `Receipt #${receipt.serialNumber || receiptId.slice(0,8)} marked as collected` : `Receipt #${receipt.serialNumber || receiptId.slice(0,8)} marked as not collected`,
    receipt.collected ? 'success' : 'info'
  );
  render();
  lucide.createIcons();
}

function showReceiptModal() {
  // Permission check for creating receipts
  if (!currentUserHasPermission('receipts', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء وصولات' : 'You do not have permission to create receipts', 'error');
    return;
  }
  state.activeModal = 'receipt';
  state.modalData = null;
  updateUrlParams({ modal: 'receipt', id: 'new' }); // URL tracking for new receipt
  renderModal();
}

function manageSplitPayments(receiptId) {
  const receipt = state.receipts.find(a => a.id === receiptId);
  if (!receipt) return;
  
  state.activeModal = 'split-payments';
  state.modalData = receipt;
  updateUrlParams({ modal: 'split-payments', id: receiptId }); // URL tracking
  renderModal();
}

function manageTopUps(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  
  state.activeModal = 'top-ups';
  state.modalData = ad;
  renderModal();
}

function manageRefund(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  
  state.activeModal = 'refund';
  state.modalData = ad;
  renderModal();
}

// Open transfer modal for a receipt
function showReceiptTransferModal(receiptId) {
  // Permission check
  if (!currentUserHasPermission('receipts', 'transfer')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتحويل الرصيد' : 'You do not have permission to transfer receipt balance', 'error');
    return;
  }
  state.activeModal = 'receipt-transfer';
  state.modalData = state.receipts.find(r => r.id === receiptId);
  renderModal();
}

// Quick inline history viewer for receipt transfers
function showReceiptTransferHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  const transfers = receipt?.transfers || [];
  if (!receipt) return;
  if (transfers.length === 0) {
    showNotification('Transfers', 'No transfers recorded for this receipt.', 'info');
    return;
  }
  const lines = transfers.map(t => {
    const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
    const name = targetCustomer ? targetCustomer.name : 'Unknown';
    return `${new Date(t.date).toLocaleString()}: $${(t.amountUSD || 0).toFixed(2)} to ${name}`;
  }).join('\n');
  showNotification('Transfer history', lines, 'info');
}

// Show receipt edit history modal
function showReceiptEditHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  
  const editHistory = receipt.editHistory || [];
  if (editHistory.length === 0) {
    showNotification('Edit History', 'No edit history recorded for this receipt.', 'info');
    return;
  }
  
  const customer = state.customers.find(c => c.id === receipt.customerId);
  
  const modalHTML = `
    <div id="edit-history-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-amber-500"></i>
                Edit History
              </h2>
              <p class="text-sm text-slate-500 mt-1">
                Receipt ${receipt.serialNumber ? '#' + receipt.serialNumber : ''} for ${Security.escapeHtml(customer?.name || 'Unknown')}
              </p>
            </div>
            <button onclick="document.getElementById('edit-history-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-bold text-white bg-amber-500 px-2 py-1 rounded-full">Edit #${editHistory.length - idx}</span>
                  <span class="text-xs text-slate-500">${edit.editedBy || 'Unknown'}</span>
                </div>
                <span class="text-xs text-slate-400">${new Date(edit.editedAt).toLocaleString()}</span>
              </div>
              
              <div class="space-y-2">
                ${edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${change.field}</span>
                      <div class="flex items-center mt-1 space-x-2 text-xs">
                        <span class="px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${change.from}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 text-slate-400"></i>
                        <span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${change.to}</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''} • 
            Created: ${new Date(receipt.createdAt).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal first
  document.getElementById('edit-history-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons in the new modal
  lucide.createIcons();
}

// Show ad edit history modal
function showAdEditHistory(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  
  const editHistory = ad.editHistory || [];
  if (editHistory.length === 0) {
    showNotification('Edit History', 'No edit history recorded for this ad.', 'info');
    return;
  }
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const page = state.pages.find(p => p.id === ad.pageId);
  
  const modalHTML = `
    <div id="edit-history-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-purple-500"></i>
                Edit History
              </h2>
              <p class="text-sm text-slate-500 mt-1">
                Ad for ${Security.escapeHtml(customer?.name || 'Unknown')} • ${Security.escapeHtml(page?.name || 'Unknown Page')}
              </p>
            </div>
            <button onclick="document.getElementById('edit-history-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-bold text-white bg-purple-500 px-2 py-1 rounded-full">Edit #${editHistory.length - idx}</span>
                  <span class="text-xs text-slate-500">${edit.editedBy || 'Unknown'}</span>
                </div>
                <span class="text-xs text-slate-400">${new Date(edit.editedAt).toLocaleString()}</span>
              </div>
              
              <div class="space-y-2">
                ${edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${change.field}</span>
                      <div class="flex items-center mt-1 space-x-2 text-xs">
                        <span class="px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${change.from}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 text-slate-400"></i>
                        <span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${change.to}</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''} • 
            Created: ${new Date(ad.createdAt).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal first
  document.getElementById('edit-history-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons in the new modal
  lucide.createIcons();
}

// Persist a transfer from receipt to another customer
function saveReceiptTransfer() {
  const receiptId = state.modalData?.id;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;

  const targetCustomerEl = document.getElementById('transfer-target-customer');
  const amountUSDElement = document.getElementById('transfer-amount-usd');
  const noteElement = document.getElementById('transfer-note');
  if (!targetCustomerEl || !amountUSDElement) {
    showNotification('Error', 'Transfer form elements not found', 'error');
    return;
  }
  const targetCustomerId = targetCustomerEl.value;
  const amountUSD = parseFloat(amountUSDElement.value) || 0;
  const note = noteElement?.value || '';

  if (!targetCustomerId) {
    showNotification('Validation', 'Please choose a customer to transfer to.', 'error');
    return;
  }
  if (amountUSD <= 0) {
    showNotification('Validation', 'Transfer amount must be greater than zero.', 'error');
    return;
  }

  const usage = getReceiptUsageStats(receipt);
  if (amountUSD > usage.remainingUSD) {
    showNotification('Validation', 'Amount exceeds available balance.', 'error');
    return;
  }

  const transfer = {
    id: generateId('transfer'),
    toCustomerId: targetCustomerId,
    amountUSD,
    amountLocal: amountUSD * (receipt.exchangeRate || state.defaultExchangeRate || 1),
    date: new Date().toISOString(),
    note
  };

  const updatedTransfers = [...(receipt.transfers || []), transfer];
  updateRecord(state.receipts, receipt.id, { transfers: updatedTransfers });
  addLog('transfer', 'receipt', receipt.id, `Transferred $${amountUSD.toFixed(2)} to customer`, { toCustomerId: targetCustomerId });
  showNotification('Transferred', 'Receipt balance transferred successfully', 'success');
  closeModal();
  render();
}

function addSplitPayment() {
  const container = document.getElementById('split-payments-container');
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
  
  const div = document.createElement('div');
  div.className = 'split-payment-item p-4 rounded-lg';
  div.innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="block text-xs font-medium mb-1">Payment Method</label>
        <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
          ${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Amount (LYD)</label>
        <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" oninput="sanitizeMoneyInput(this)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Exchange Rate</label>
        <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Collection Type</label>
        <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
          <option value="office">Office</option>
          <option value="delivery">Delivery</option>
          <option value="bank">Bank</option>
        </select>
      </div>
      ${deliveryUsers.length > 0 ? `
        <div class="col-span-2">
          <label class="block text-xs font-medium mb-1">Delivery Person (if delivery)</label>
          <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
            <option value="">None</option>
            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div class="col-span-2 flex justify-end">
        <button type="button" onclick="this.closest('.split-payment-item').remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700 text-sm font-medium flex items-center space-x-1">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
          <span>Remove</span>
        </button>
      </div>
    </div>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

function saveSplitPayments() {
  const receiptId = state.modalData.id;
  const paymentItems = document.querySelectorAll('.split-payment-item');
  const payments = [];
  
  paymentItems.forEach(item => {
    const method = item.querySelector('.split-method').value;
    const amount = parseFloat(item.querySelector('.split-amount').value) || 0;
    const rate = parseFloat(item.querySelector('.split-rate').value) || state.defaultExchangeRate;
    const collectionType = item.querySelector('.split-collection').value;
    const deliveryPersonId = item.querySelector('.split-delivery-person')?.value || '';
    
    if (amount > 0) {
      payments.push({
        method,
        amount,
        rate,
        collectionType,
        deliveryPersonId
      });
    }
  });
  
  updateRecord(state.receipts, receiptId, { payments });
  showNotification('Saved', 'Split payments saved successfully', 'success');
  closeModal();
  render();
}

// Top-ups management functions
let tempTopUps = [];

function addNewTopUp() {
  const amountEl = document.getElementById('topup-amount');
  const dateEl = document.getElementById('topup-date');
  const noteEl = document.getElementById('topup-note');
  if (!amountEl || !dateEl) {
    showNotification('Error', 'Top-up form elements not found', 'error');
    return;
  }
  const amount = parseFloat(amountEl.value);
  const date = dateEl.value;
  const note = noteEl?.value || '';
  
  if (!amount || amount <= 0) {
    showNotification('Error', 'Please enter a valid amount', 'error');
    return;
  }
  
  tempTopUps.push({
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    amount,
    note: note || 'Top-up'
  });
  
  // Re-render modal to show new top-up
  renderModal();
}

function removeTopUp(index) {
  tempTopUps.splice(index, 1);
  renderModal();
}

function saveTopUps() {
  const adId = state.modalData.id;
  const ad = state.ads.find(a => a.id === adId);
  
  const allTopUps = [...(ad.topUps || []), ...tempTopUps];
  const totalTopUps = tempTopUps.reduce((sum, t) => sum + t.amount, 0);
  const newAmountUSD = (ad.initialAmountUSD || ad.amountUSD) + totalTopUps;
  
  updateRecord(state.ads, adId, {
    topUps: allTopUps,
    initialAmountUSD: ad.initialAmountUSD || ad.amountUSD,
    amountUSD: newAmountUSD,
    amountLocal: newAmountUSD * ad.exchangeRate
  });
  
  tempTopUps = [];
  showNotification('Saved', `Top-ups saved. New amount: $${newAmountUSD.toFixed(2)}`, 'success');
  closeModal();
  render();
}

// Refund management functions
function toggleRefundAmount(refundType) {
  const amountSection = document.getElementById('refund-amount-section');
  const statusSection = document.getElementById('refund-status-section');
  
  if (refundType === 'None') {
    amountSection.classList.add('hidden');
    statusSection.classList.add('hidden');
  } else {
    amountSection.classList.remove('hidden');
    statusSection.classList.remove('hidden');
    
    // Auto-fill amount for Full refund
    if (refundType === 'Full' && state.modalData) {
      document.getElementById('refund-amount').value = state.modalData.amountUSD;
    }
  }
}

function saveRefund() {
  const adId = state.modalData.id;
  const refundType = document.getElementById('refund-type').value;
  const refundAmount = parseFloat(document.getElementById('refund-amount').value) || 0;
  const refundStatus = document.getElementById('refund-status').value;
  
  const updates = {
    refundType,
    refundAmount: refundType !== 'None' ? refundAmount : 0,
    refundStatus: refundType !== 'None' ? refundStatus : undefined,
    status: refundType !== 'None' ? 'Canceled' : state.modalData.status,
    canceledBy: refundType !== 'None' ? state.currentUser?.id : state.modalData.canceledBy
  };
  
  updateRecord(state.ads, adId, updates);
  showNotification('Saved', `Refund ${refundType} applied`, refundType !== 'None' ? 'warning' : 'success');
  closeModal();
  render();
}

// ==========================================
// CUSTOMER SEARCH COMPONENT
// ==========================================

let selectedCustomerId = null;
let selectedCustomerByPhone = null;

function renderCustomerSearchDropdown(fieldId, selectedId = null) {
  const customers = getVisibleRecords(state.customers);
  selectedCustomerId = selectedId;
  
  // Get selected customer data if editing
  const selectedCustomer = selectedId ? customers.find(c => c.id === selectedId) : null;
  const searchValue = selectedCustomer ? selectedCustomer.name : '';
  const showConfirmation = selectedCustomer !== null;
  
  return `
    <div class="relative">
      <div class="flex items-start space-x-3">
        <div class="flex-1 relative">
          <div class="relative">
            <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              id="${fieldId}-search" 
              value="${Security.escapeHtml(searchValue)}"
              placeholder="Search by name or phone..." 
              class="w-full glass-input px-4 py-2 pl-10 rounded-xl"
              autocomplete="off"
              oninput="filterCustomerDropdown('${fieldId}')"
              onfocus="showCustomerDropdown('${fieldId}')"
            />
          </div>
          <input type="hidden" id="${fieldId}-id" value="${selectedId || ''}" required />
          
          <!-- Dropdown Results -->
          <div id="${fieldId}-dropdown" class="absolute z-10 w-full mt-2 glass-panel rounded-xl shadow-xl max-h-60 overflow-y-auto hidden">
            <div id="${fieldId}-results" class="p-2">
              ${customers.map(c => `
                <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectCustomer('${fieldId}', '${c.id}')">
                  <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
                  <div class="text-sm text-slate-500 mt-1 flex items-center">
                    <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
                    ${Security.escapeHtml((c.phones || []).join(', '))}
                  </div>
                  <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
                    <i data-lucide="${c.platform === 'Facebook' ? 'facebook' : c.platform === 'WhatsApp' ? 'message-circle' : c.platform === 'Instagram' ? 'instagram' : 'phone'}" class="w-3 h-3 inline mr-1"></i>
                    ${Security.escapeHtml(c.platform || '')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        
        <!-- Selected Customer Confirmation (Right Side) -->
        <div id="${fieldId}-confirmation" class="w-72 p-4 glass-panel rounded-xl border-2 border-emerald-500 ${showConfirmation ? '' : 'hidden'}">
          <div class="flex items-start justify-between mb-2">
            <div class="flex items-center space-x-2">
              <i data-lucide="check-circle" class="w-5 h-5 text-emerald-600"></i>
              <span class="font-bold text-sm text-emerald-700 dark:text-emerald-400">Selected</span>
            </div>
            <button type="button" onclick="clearCustomerSelection('${fieldId}')" class="text-slate-400 hover:text-rose-600 transition-colors" title="Clear selection">
              <i data-lucide="x-circle" class="w-4 h-4"></i>
            </button>
          </div>
          <div class="flex items-start space-x-3">
            <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
              ${selectedCustomer ? selectedCustomer.name.charAt(0).toUpperCase() : 'C'}
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-bold text-slate-800 dark:text-white truncate" id="${fieldId}-selected-name">
                ${selectedCustomer ? Security.escapeHtml(selectedCustomer.name || '') : ''}
              </div>
              <div class="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center" id="${fieldId}-selected-phone">
                ${selectedCustomer ? `<i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>${Security.escapeHtml(selectedCustomer.phones?.[0] || 'No phone')}` : ''}
              </div>
              ${selectedCustomer && selectedCustomer.platform ? `
                <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
                  ${Security.escapeHtml(selectedCustomer.platform)}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function filterCustomerDropdown(fieldId) {
  const searchInput = document.getElementById(`${fieldId}-search`);
  const searchTerm = searchInput.value.toLowerCase();
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  const results = document.getElementById(`${fieldId}-results`);
  
  const customers = getVisibleRecords(state.customers);
  const filtered = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm) ||
    c.phones.some(p => p.includes(searchTerm)) ||
    c.platform.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    results.innerHTML = filtered.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors" onclick="selectCustomer('${fieldId}', '${c.id}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-sm text-slate-500 mt-1">
          <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
          ${Security.escapeHtml((c.phones || []).join(', '))}
        </div>
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">${Security.escapeHtml(c.platform || '')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    lucide.createIcons();
  } else if (!searchTerm) {
    results.innerHTML = customers.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors" onclick="selectCustomer('${fieldId}', '${c.id}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-sm text-slate-500 mt-1">
          <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
          ${Security.escapeHtml((c.phones || []).join(', '))}
        </div>
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">${Security.escapeHtml(c.platform || '')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    lucide.createIcons();
  } else {
    dropdown.classList.add('hidden');
  }
}

function showCustomerDropdown(fieldId) {
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  dropdown.classList.remove('hidden');
  filterCustomerDropdown(fieldId);
}

function selectCustomer(fieldId, customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  selectedCustomerId = customerId;
  
  // Update hidden field
  const idField = document.getElementById(`${fieldId}-id`);
  idField.value = customerId;
  
  // Update search input
  const searchInput = document.getElementById(`${fieldId}-search`);
  searchInput.value = customer.name;
  
  // Hide dropdown
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  dropdown.classList.add('hidden');
  
  // Show and update confirmation panel
  const confirmation = document.getElementById(`${fieldId}-confirmation`);
  confirmation.classList.remove('hidden');
  
  // Update confirmation content with full customer details
  const confirmationInner = confirmation.querySelector('div.flex.items-start.space-x-3') || confirmation;
  confirmationInner.innerHTML = `
    <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
      ${customer.name.charAt(0).toUpperCase()}
    </div>
    <div class="flex-1 min-w-0">
      <div class="font-bold text-slate-800 dark:text-white truncate">${Security.escapeHtml(customer.name || '')}</div>
      <div class="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center">
        <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
        ${Security.escapeHtml((Array.isArray(customer.phones) && customer.phones.length > 0) ? customer.phones[0] : 'No phone')}
      </div>
      ${customer.platform ? `
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
          ${Security.escapeHtml(customer.platform)}
        </div>
      ` : ''}
    </div>
  `;
  
  // Re-add close button
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'text-slate-400 hover:text-rose-600 transition-colors';
  closeBtn.setAttribute('onclick', `clearCustomerSelection('${fieldId}')`);
  closeBtn.title = 'Clear selection';
  closeBtn.innerHTML = '<i data-lucide="x-circle" class="w-4 h-4"></i>';
  
  const wrapper = confirmation.querySelector('div.flex.items-start.justify-between');
  if (wrapper) {
    wrapper.appendChild(closeBtn);
  }
  
  if (fieldId === 'ad-customer') {
    handleAdCustomerChange(customerId);
  }
  
  lucide.createIcons();
}

function clearCustomerSelection(fieldId) {
  selectedCustomerId = null;
  
  // Clear fields
  document.getElementById(`${fieldId}-search`).value = '';
  document.getElementById(`${fieldId}-id`).value = '';
  
  // Hide confirmation
  const confirmation = document.getElementById(`${fieldId}-confirmation`);
  confirmation.classList.add('hidden');
  
  // Show dropdown
  filterCustomerDropdown(fieldId);
}

// Click outside to close dropdown
document.addEventListener('click', function(e) {
  const dropdowns = document.querySelectorAll('[id$="-dropdown"]');
  dropdowns.forEach(dropdown => {
    if (!dropdown.contains(e.target) && !e.target.id.includes('-search')) {
      dropdown.classList.add('hidden');
    }
  });
});

// ==========================================
// RECEIPT MODAL HELPER FUNCTIONS
// ==========================================

function filterReceiptPhones() {
  const searchInput = document.getElementById('receipt-phone-search');
  const dropdown = document.getElementById('receipt-phone-dropdown');
  const searchTerm = searchInput.value.toLowerCase();
  
  const customers = getVisibleRecords(state.customers);
  const phoneCustomerMap = [];
  customers.forEach(c => {
    c.phones.forEach(phone => {
      phoneCustomerMap.push({ phone, customer: c });
    });
  });
  
  const filtered = phoneCustomerMap.filter(item => 
    item.phone.includes(searchTerm) ||
    item.customer.name.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    dropdown.innerHTML = filtered.map(item => `
      <div class="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer phone-option rounded transition-colors" data-phone="${Security.escapeHtml(item.phone)}" data-customer-id="${Security.escapeHtml(item.customer.id)}" onclick="selectReceiptPhone(this.dataset.phone, this.dataset.customerId)">
        <div class="text-sm font-medium">${Security.escapeHtml(item.phone)}</div>
        <div class="text-xs text-slate-500">${Security.escapeHtml(item.customer.name)} - ${Security.escapeHtml(item.customer.platform)}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  } else {
    dropdown.classList.add('hidden');
  }
}

function showReceiptPhoneDropdown() {
  filterReceiptPhones();
}

// ==========================================
// RECEIPT RENDER HELPERS
// ==========================================

function renderReceiptFinancials(payments, existingPayments, receiptDeliveryUsers) {
  // BUG FIX: Check if array exists and has elements before accessing
  if (!Array.isArray(existingPayments) || existingPayments.length === 0) {
    return '<div class="text-xs text-slate-400 p-4">No payments configured</div>';
  }
  
  const isSplit = existingPayments.length > 1;
  
  if (!isSplit) {
    const payment = existingPayments[0];
    // Single Payment Mode - Compact & Integrated
    return `
      <div id="receipt-payments-container" class="space-y-3">
        <div class="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm payment-split-item">
          <!-- Header -->
          <div class="flex items-center space-x-2 mb-4 pb-3 border-b border-slate-100 dark:border-slate-700">
            <i data-lucide="credit-card" class="w-4 h-4 text-slate-500"></i>
            <span class="text-xs font-bold text-slate-500 uppercase">PAYMENT #1</span>
          </div>

          <div class="space-y-4">
            <!-- Payment Method & Amount Row -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Payment Method</label>
                <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" onchange="onPaymentMethodChange(this)">
                  ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Amount</label>
                <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
              </div>
            </div>

            <!-- Rates Row -->
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">RATE 1</label>
                <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1.5 rounded text-xs font-medium text-center mb-2" value="${payment.rate || state.defaultExchangeRate}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
                <div class="text-center pt-2 border-t border-slate-200 dark:border-slate-700">
                  <div class="text-[10px] font-bold text-slate-400 mb-0.5">R1:</div>
                  <span class="payment-r1-display text-sm font-bold text-indigo-600">0.00 LYD</span>
                </div>
              </div>
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">RATE 2</label>
                <input type="text" inputmode="decimal" class="payment-rate2 w-full glass-input px-2 py-1.5 rounded text-xs font-medium text-center mb-2" value="${payment.rate2 !== undefined ? payment.rate2 : state.defaultExchangeRate}" placeholder="0" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
                <div class="text-center pt-2 border-t border-slate-200 dark:border-slate-700">
                  <div class="text-[10px] font-bold text-slate-400 mb-0.5">R2:</div>
                  <span class="payment-r2-display text-sm font-bold text-emerald-600">0.00 USD</span>
                </div>
              </div>
            </div>

            <!-- Hidden collection type for data consistency -->
            <input type="hidden" class="collection-type" value="${payment.collectionType || 'office'}" />

            <!-- Integrated Totals -->
            <div class="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 grid grid-cols-2 gap-4">
              <div>
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL PAID (LYD)</div>
                <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
                  <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
                </div>
              </div>
              <div>
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL ADS CREDIT (USD)</div>
                <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                  <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
                  <div class="text-[10px] text-emerald-600/70 mt-1 leading-tight">Sum of all converted payments (Excluding Amount 2)</div>
                </div>
              </div>
            </div>

            <!-- Footer Stats -->
            <div class="flex justify-between items-center pt-2 text-[10px] text-slate-400">
              <div>
                <div class="font-bold">Net Paid (After Fees):</div>
                <div id="receipt-net-paid" class="text-indigo-600 font-bold text-xs">0.00 LYD</div>
              </div>
              <div class="text-right">
                <div>Market Rate: <span id="receipt-market-rate" class="text-slate-600 dark:text-slate-300 font-bold">${state.defaultExchangeRate.toFixed(2)}</span></div>
                <div>Actual Avg Rate: <span id="receipt-avg-rate" class="text-emerald-600 font-bold">0.0000</span></div>
              </div>
            </div>
            
            <!-- Savings/Extra Display -->
            <div id="receipt-savings-display" class="mt-3 p-2 rounded-lg text-center text-sm font-bold hidden">
              <!-- Will be populated dynamically -->
            </div>

          </div>
        </div>
      </div>
    `;
  } else {
    // Split Payment Mode - All Payments First, Then Totals at Bottom
    const paymentCardsHTML = existingPayments.map((payment, idx) => `
      <div class="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm payment-split-item">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center space-x-2">
            <i data-lucide="credit-card" class="w-4 h-4 text-slate-400"></i>
            <span class="text-xs font-bold text-slate-500 uppercase">PAYMENT #${idx + 1}</span>
          </div>
          <button type="button" onclick="removeReceiptPaymentSplit(this)" class="text-rose-500 hover:text-rose-700 transition-colors">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Payment Method</label>
              <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600" onchange="onPaymentMethodChange(this)">
                ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Amount</label>
              <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">RATE 1</label>
              <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1 rounded text-xs mb-1" value="${payment.rate || state.defaultExchangeRate}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
              <div class="text-center pt-1 border-t border-slate-200 dark:border-slate-700">
                <span class="text-[9px] font-bold text-slate-400">R1: </span>
                <span class="payment-r1-display text-xs font-bold text-indigo-600">0.00 LYD</span>
              </div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">RATE 2</label>
              <input type="text" inputmode="decimal" class="payment-rate2 w-full glass-input px-2 py-1 rounded text-xs mb-1" value="${payment.rate2 !== undefined ? payment.rate2 : state.defaultExchangeRate}" placeholder="0" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
              <div class="text-center pt-1 border-t border-slate-200 dark:border-slate-700">
                <span class="text-[9px] font-bold text-slate-400">R2: </span>
                <span class="payment-r2-display text-xs font-bold text-emerald-600">0.00 USD</span>
              </div>
            </div>
          </div>

          <!-- Hidden collection type for data consistency -->
          <input type="hidden" class="collection-type" value="${payment.collectionType || 'office'}" />
        </div>
      </div>
    `).join('');

    return `
      <!-- All Payment Cards First -->
      <div id="receipt-payments-container" class="space-y-3">
        ${paymentCardsHTML}
      </div>

      <!-- Totals Section at Bottom (After All Payments) -->
      <div id="receipt-totals-section" class="mt-4 pt-4 border-t-2 border-slate-200 dark:border-slate-700">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL PAID (LYD)</div>
            <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
              <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
            </div>
          </div>
          <div>
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL ADS CREDIT (USD)</div>
            <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
              <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
              <div class="text-[10px] text-emerald-600/70 mt-1">Sum of all R2 values</div>
            </div>
          </div>
        </div>
        
        <div class="mt-3 px-4 py-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div class="flex justify-between items-center text-xs">
            <div>
              <span class="text-slate-500 font-bold">Net Paid:</span> 
              <span id="receipt-net-paid" class="text-indigo-600 font-bold ml-1">0.00 LYD</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">Market Rate:</span> 
              <span id="receipt-market-rate" class="text-slate-600 font-bold ml-1">${state.defaultExchangeRate.toFixed(2)}</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">Avg Rate:</span> 
              <span id="receipt-avg-rate" class="text-emerald-600 font-bold ml-1">0.0000</span>
            </div>
          </div>
          
          <!-- Savings/Extra Display -->
          <div id="receipt-savings-display" class="mt-2 p-2 rounded-lg text-center text-sm font-bold hidden">
            <!-- Will be populated dynamically -->
          </div>
        </div>
      </div>
    `;
  }
}

// Function to collect current payment data from DOM
function getReceiptPaymentData() {
  const container = document.getElementById('receipt-payments-container');
  if (!container) return [];
  
  const items = container.querySelectorAll('.payment-split-item');
  const payments = [];
  
  items.forEach(item => {
    const rate2Value = item.querySelector('.payment-rate2').value;
    payments.push({
      method: item.querySelector('.payment-method').value,
      amount: parseFloat(item.querySelector('.payment-amount').value) || 0,
      rate: parseFloat(item.querySelector('.payment-rate1').value) || state.defaultExchangeRate,
      rate2: rate2Value !== '' && rate2Value !== null ? parseFloat(rate2Value) : state.defaultExchangeRate,
      collectionType: item.querySelector('.collection-type').value,
      deliveryPersonId: item.querySelector('.delivery-person')?.value || ''
    });
  });
  
  return payments;
}

// Add new payment split
function addReceiptPaymentSplit() {
  const currentPayments = getReceiptPaymentData();
  // BUG FIX: Check if PAYMENT_METHODS array exists and has elements
  if (!Array.isArray(PAYMENT_METHODS) || PAYMENT_METHODS.length === 0) {
    showNotification('Error', 'Payment methods not configured', 'error');
    return;
  }
  const defaultRate1 = getDefaultRate1(PAYMENT_METHODS[0]);
  currentPayments.push({ 
    method: PAYMENT_METHODS[0], 
    amount: 0, 
    rate: defaultRate1, 
    rate2: state.defaultExchangeRate, 
    collectionType: 'office', 
    deliveryPersonId: '' 
  });
  
  // Re-render the financial section
  const financialSection = document.getElementById('receipt-financial-section');
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
  
  if (financialSection) {
    financialSection.innerHTML = renderReceiptFinancials(currentPayments, currentPayments, deliveryUsers);
    
    // Refresh icons and update totals
    if (window.lucide) lucide.createIcons();
    updateReceiptTotals();
    updateAutoSerialForReceipt();
  }
}

// Remove payment split
function removeReceiptPaymentSplit(btn) {
  const item = btn.closest('.payment-split-item');
  if (item) {
    // If it's the last one in a list of > 1, we need to re-render to switch back to compact mode
    const container = document.getElementById('receipt-payments-container');
    const count = container.querySelectorAll('.payment-split-item').length;
    
    if (count <= 2) { // Removing one will leave 1 => switch to compact
      item.remove();
      const currentPayments = getReceiptPaymentData(); // Get remaining data
      
      const financialSection = document.getElementById('receipt-financial-section');
      const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
      
      if (financialSection) {
        financialSection.innerHTML = renderReceiptFinancials(currentPayments, currentPayments, deliveryUsers);
        if (window.lucide) lucide.createIcons();
        updateReceiptTotals();
        updateAutoSerialForReceipt();
      }
    } else {
      // Just remove it normally
      item.remove();
      updateReceiptTotals();
      updateAutoSerialForReceipt();
    }
  }
}

function selectReceiptPhone(phone, customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  // Set customer ID
  document.getElementById('receipt-customer-id').value = customerId;
  
  // Update phone search
  document.getElementById('receipt-phone-search').value = phone;
  
  // Update customer name display
  document.getElementById('receipt-customer-name').value = customer.name;
  
  // Hide dropdown
  document.getElementById('receipt-phone-dropdown').classList.add('hidden');
}

// ==========================================
// PAGE CUSTOMER SELECTION HELPERS
// ==========================================

function filterPageCustomers() {
  const searchInput = document.getElementById('page-customer-search');
  const dropdown = document.getElementById('page-customer-dropdown');
  const searchTerm = searchInput?.value.toLowerCase() || '';
  
  const customers = getVisibleRecords(state.customers);
  
  const filtered = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm) ||
    c.phones.some(p => p.includes(searchTerm)) ||
    c.platform.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    dropdown.innerHTML = filtered.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${state.currentUser?.role === 'Admin'}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  } else {
    dropdown.classList.add('hidden');
  }
}

function showPageCustomerDropdown() {
  const dropdown = document.getElementById('page-customer-dropdown');
  const customers = getVisibleRecords(state.customers);
  
  if (customers.length > 0) {
    dropdown.innerHTML = customers.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${state.currentUser?.role === 'Admin'}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  }
}

function selectPageCustomer(customerId, isAdmin) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const dropdown = document.getElementById('page-customer-dropdown');
  const searchInput = document.getElementById('page-customer-search');
  
  // Check if already selected
  const existing = container.querySelector(`[data-customer-id="${customerId}"]`);
  if (existing) {
    showNotification('Already Selected', 'This customer is already linked to this page', 'info');
    dropdown.classList.add('hidden');
    return;
  }
  
  // Check if non-admin trying to add multiple
  const currentCount = container.querySelectorAll('.page-customer-item').length;
  if (isAdmin === 'false' && currentCount >= 1) {
    showNotification('Limit Reached', 'You can only link one customer. Remove the existing customer first.', 'error');
    dropdown.classList.add('hidden');
    return;
  }
  
  // Add customer item
  const customerItem = document.createElement('div');
  customerItem.className = 'flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-800 page-customer-item';
  customerItem.setAttribute('data-customer-id', customerId);
  customerItem.innerHTML = `
    <div>
      <div class="font-medium text-sm text-slate-800 dark:text-white">${Security.escapeHtml(customer.name || '')}</div>
      <div class="text-xs text-slate-500">${Security.escapeHtml(customer.platform || '')}</div>
    </div>
    <button type="button" onclick="removePageCustomer('${customerId}')" class="text-rose-500 hover:text-rose-700">
      <i data-lucide="x-circle" class="w-4 h-4"></i>
    </button>
  `;
  
  container.insertBefore(customerItem, noCustomersMsg);
  
  // Refresh icons
  if (window.lucide) {
    lucide.createIcons();
  }
  
  // Hide no customers message
  noCustomersMsg.classList.add('hidden');
  
  // Clear search
  searchInput.value = '';
  dropdown.classList.add('hidden');
  
  // Show multi-customer warning for admin
  const newCount = container.querySelectorAll('.page-customer-item').length;
  if (isAdmin === 'true' && newCount > 1) {
    const warning = document.getElementById('page-multi-customer-warning');
    if (warning) {
      warning.classList.remove('hidden');
    }
  }
}

function removePageCustomer(customerId) {
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const item = container.querySelector(`[data-customer-id="${customerId}"]`);
  
  if (item) {
    item.remove();
  }
  
  // Check if no customers left
  const remaining = container.querySelectorAll('.page-customer-item').length;
  if (remaining === 0) {
    noCustomersMsg.classList.remove('hidden');
  }
  
  // Hide multi-customer warning if down to 1 or less
  if (remaining <= 1) {
    const warning = document.getElementById('page-multi-customer-warning');
    if (warning) {
      warning.classList.add('hidden');
    }
  }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  const pageDropdown = document.getElementById('page-customer-dropdown');
  const pageSearch = document.getElementById('page-customer-search');
  
  if (pageDropdown && pageSearch && 
      !pageDropdown.contains(e.target) && 
      !pageSearch.contains(e.target)) {
    pageDropdown.classList.add('hidden');
  }
});

function setPaymentCollection(button, type) {
  const paymentItem = button.closest('.payment-split-item');
  const collectionInput = paymentItem.querySelector('.collection-type');
  collectionInput.value = type;
  
  // Update button styles
  const buttons = paymentItem.querySelectorAll('.collection-btn');
  buttons.forEach(btn => {
    const btnType = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
    if (btnType === type) {
      btn.className = 'collection-btn px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide transition-all bg-white border-2 border-indigo-600 text-indigo-700 shadow-sm';
    } else {
      btn.className = 'collection-btn px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide transition-all bg-slate-100 dark:bg-slate-700 text-slate-500 border-2 border-transparent';
    }
  });
  
  // Show/hide delivery person selector
  let deliverySelect = paymentItem.querySelector('.delivery-person');
  
  if (type === 'delivery') {
    // If delivery selected and no dropdown exists, create it
    if (!deliverySelect) {
  const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
      if (deliveryUsers.length > 0) {
        const selectHtml = `
          <select class="delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm mt-2 border border-slate-200 dark:border-slate-700">
            <option value="">Select delivery person...</option>
            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
          </select>
        `;
        const collectionDiv = paymentItem.querySelector('.collection-type').closest('div');
        collectionDiv.insertAdjacentHTML('beforeend', selectHtml);
      }
    } else {
      deliverySelect.style.display = 'block';
    }
  } else {
    // Hide delivery person selector if not delivery
    if (deliverySelect) {
      deliverySelect.style.display = 'none';
    }
  }
}

// REMOVED DUPLICATE addReceiptPaymentSplit - correct version is defined earlier at line ~2738
// This duplicate was causing layout issues by not restructuring the totals section

// Get default Rate 1 based on payment method
function getDefaultRate1(paymentMethod) {
  const zeroRateMethods = ['Bank Transfer', 'Bank Transfer (LYD)', 'Bank Transfer (USD)', 'Sadad', 'USDT', 'Cash (USD)', 'LTT'];
  const oneRateMethods = ['Cash (LYD)', 'Transfer Office'];
  
  if (zeroRateMethods.includes(paymentMethod)) return 0;
  if (oneRateMethods.includes(paymentMethod)) return 1;
  if (paymentMethod === 'Libyana') return 0.70;
  if (paymentMethod === 'Madar') return 0.75;
  
  return state.defaultExchangeRate; // Default for others
}

// Check if Rate 2 should be zero for this payment method
function shouldRate2BeZero(paymentMethod) {
  const zeroRate2Methods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  return zeroRate2Methods.includes(paymentMethod);
}

// Payment methods that get auto-serial numbers (S-prefix: S1, S2, S3...)
const AUTO_SERIAL_PAYMENT_METHODS = ['LTT', 'Libyana', 'Madar'];
const AUTO_SERIAL_PREFIX = 'S'; // Prefix for auto-generated serial numbers

// Get the next serial number for auto-serial payment methods (returns S1, S2, S3...)
function getNextAutoSerialNumber(paymentMethod) {
  if (!AUTO_SERIAL_PAYMENT_METHODS.includes(paymentMethod)) return null;
  
  // Find all receipts that use ANY of the auto-serial payment methods (LTT, Libyana, Madar share the same sequence)
  const receipts = getVisibleRecords(state.receipts);
  let maxSerialNumber = 0;
  
  receipts.forEach(receipt => {
    // Check if this receipt uses ANY of the auto-serial payment methods
    const receiptPaymentMethod = receipt.paymentMethod || '';
    const payments = receipt.payments || [];
    const usesAutoSerialMethod = AUTO_SERIAL_PAYMENT_METHODS.includes(receiptPaymentMethod) || 
                                  payments.some(p => AUTO_SERIAL_PAYMENT_METHODS.includes(p.method));
    
    if (usesAutoSerialMethod && receipt.serialNumber) {
      const serial = String(receipt.serialNumber).trim();
      // Extract number from S-prefixed serial (S1, S2, etc.) or plain number (legacy: 1, 2, etc.)
      let serialNum = 0;
      if (serial.toUpperCase().startsWith(AUTO_SERIAL_PREFIX)) {
        // New format: S1, S2, S3...
        serialNum = parseInt(serial.substring(AUTO_SERIAL_PREFIX.length), 10);
      } else {
        // Legacy format: plain number (1, 2, 3...)
        serialNum = parseInt(serial, 10);
      }
      if (!isNaN(serialNum) && serialNum > maxSerialNumber) {
        maxSerialNumber = serialNum;
      }
    }
  });
  
  // Return with S prefix: S1, S2, S3...
  return `${AUTO_SERIAL_PREFIX}${maxSerialNumber + 1}`;
}

// Check if a serial number is an auto-generated S-serial (S1, S2, etc.)
function isAutoSerialNumber(serial) {
  if (!serial) return false;
  const s = String(serial).trim().toUpperCase();
  return s.startsWith(AUTO_SERIAL_PREFIX) && /^S\d+$/.test(s);
}

// Handle payment method change
function onPaymentMethodChange(selectElement) {
  const paymentItem = selectElement.closest('.payment-split-item');
  const paymentMethod = selectElement.value;
  
  // Auto-set Rate 1 based on payment method
  const rate1Input = paymentItem.querySelector('.payment-rate1');
  const defaultRate1 = getDefaultRate1(paymentMethod);
  rate1Input.value = defaultRate1.toFixed(2);
  
  // Handle Rate 2
  const rate2Input = paymentItem.querySelector('.payment-rate2');
  const zeroR2Methods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  
  if (zeroR2Methods.includes(paymentMethod)) {
    // For USDT, Bank Transfer (USD), Cash (USD): R2 calculation is disabled
    // But we still allow the user to enter a rate (it just won't be used in R2 calculation)
    // Set to 0 to indicate no R2 will be calculated
    rate2Input.value = '0';
  } else if (parseFloat(rate2Input.value) === 0 || !rate2Input.value) {
    // If it was zero and now it's a normal method, set to default exchange rate
    rate2Input.value = state.defaultExchangeRate.toFixed(2);
  }
  
  // Auto-set serial number for LTT, Libyana, Madar payment methods
  const serialInput = document.getElementById('receipt-serial');
  if (AUTO_SERIAL_PAYMENT_METHODS.includes(paymentMethod)) {
    if (serialInput && !serialInput.value) {
      const nextSerial = getNextAutoSerialNumber(paymentMethod);
      if (nextSerial) {
        serialInput.value = nextSerial;
        // Make field read-only and style it
        serialInput.readOnly = true;
        serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
        serialInput.title = `Auto-generated for ${paymentMethod}`;
        // Show notification about auto-generated serial
        showNotification('Auto Serial', `Receipt number auto-set to ${nextSerial} for ${paymentMethod}`, 'info');
      }
    } else if (serialInput) {
      // If already has value and is auto-serial method, keep it locked
      serialInput.readOnly = true;
      serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
      serialInput.title = `Auto-generated for ${paymentMethod}`;
    }
  }
  
  // Check if we need to update the serial lock state based on all payment methods
  updateSerialLockState();
  
  // Update totals
  updateReceiptTotals();
}

// Helper function to always round UP to 2 decimal places
// This ensures any value with decimals beyond 2 places rounds up
// Example: 90.100143062 becomes 90.11, not 90.10
function ceilingRound(value) {
  if (value === 0 || !value || isNaN(value)) return 0;
  // Always round up: multiply by 100, use Math.ceil, then divide by 100
  // This ensures 90.10000001 becomes 90.11
  const result = Math.ceil(value * 100) / 100;
  return result;
}

// Auto-update serial number for receipts with LTT, Libyana, or Madar payment methods
function updateAutoSerialForReceipt() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;
  
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let autoSerialMethod = null;
  
  // Check if any payment method requires auto-serial
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    if (methodSelect && AUTO_SERIAL_PAYMENT_METHODS.includes(methodSelect.value)) {
      autoSerialMethod = methodSelect.value;
    }
  });
  
  if (autoSerialMethod && !serialInput.value) {
    const nextSerial = getNextAutoSerialNumber(autoSerialMethod);
    if (nextSerial) {
      serialInput.value = nextSerial;
      // Make field read-only
      serialInput.readOnly = true;
      serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
      serialInput.title = `Auto-generated for ${autoSerialMethod}`;
    }
  }
  
  // Update lock state
  updateSerialLockState();
}

// Update serial field lock state based on payment methods
function updateSerialLockState() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;
  
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let hasAutoSerialMethod = false;
  let autoSerialMethod = null;
  
  // Check if any payment method requires auto-serial
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    if (methodSelect && AUTO_SERIAL_PAYMENT_METHODS.includes(methodSelect.value)) {
      hasAutoSerialMethod = true;
      autoSerialMethod = methodSelect.value;
    }
  });
  
  if (hasAutoSerialMethod) {
    // Lock the serial field
    serialInput.readOnly = true;
    serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = `Auto-generated for ${autoSerialMethod}`;
  } else {
    // Unlock the serial field if no auto-serial methods are present
    serialInput.readOnly = false;
    serialInput.classList.remove('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = '';
  }
}

function updateReceiptTotals() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  
  let totalR1 = 0; // Total PAID (LYD) - sum of all R1 values
  let totalR2 = 0; // Total ADS CREDIT (USD) - sum of all R2 values
  
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    const amountInput = item.querySelector('.payment-amount');
    const rate1Input = item.querySelector('.payment-rate1');
    const rate2Input = item.querySelector('.payment-rate2');
    const r1Display = item.querySelector('.payment-r1-display');
    const r2Display = item.querySelector('.payment-r2-display');
    
    if (!methodSelect || !amountInput || !rate1Input || !rate2Input) return;
    
    const paymentMethod = methodSelect.value;
    const amount = parseFloat(amountInput.value) || 0;
    const rate1 = parseFloat(rate1Input.value) || 0;
    const rate2 = parseFloat(rate2Input.value) || 0;
    
    // Calculate R1 = Amount × Rate 1
    const r1 = amount * rate1;
    
    // Calculate R2 based on payment method:
    // - For USDT, Bank Transfer (USD), Cash (USD): R2 = R1 ÷ Rate 2
    // - For all other methods: R2 = Amount ÷ Rate 2
    let r2 = 0;
    const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
    
    if (rate2 > 0) {
      if (usdBasedMethods.includes(paymentMethod)) {
        // USD-based methods: R2 = R1 / Rate 2
        // BUG FIX: Prevent division by zero
        r2 = rate2 > 0 ? (r1 / rate2) : 0;
      } else {
        // Normal methods: R2 = Amount / Rate 2
        // BUG FIX: Prevent division by zero
        r2 = rate2 > 0 ? (amount / rate2) : 0;
      }
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    
    // Update displays
    if (r1Display) r1Display.textContent = r1.toFixed(2) + ' LYD';
    if (r2Display) r2Display.textContent = r2.toFixed(2) + ' USD';
    
    // Add to totals
    totalR1 += r1;
    totalR2 += r2;
  });
  
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  
  // Update total displays
  const totalLydEl = document.getElementById('receipt-total-lyd');
  const totalUsdEl = document.getElementById('receipt-total-usd');
  const avgRateEl = document.getElementById('receipt-avg-rate');
  const netPaidEl = document.getElementById('receipt-net-paid');
  const savingsEl = document.getElementById('receipt-savings-display');
  
  if (totalLydEl) totalLydEl.textContent = totalR1.toFixed(2);
  if (totalUsdEl) totalUsdEl.textContent = '$' + totalR2.toFixed(2);
  
  // Calculate average rate (Total LYD / Total USD)
  const avgRate = totalR2 > 0 ? (totalR1 / totalR2) : 0;
  if (avgRateEl) avgRateEl.textContent = avgRate.toFixed(4);
  
  // Calculate net paid (total - processing fee if any)
  const processingFee = BUSINESS_CONFIG.RECEIPT_PROCESSING_FEE_LYD || 0;
  const netPaid = totalR1 - processingFee;
  if (netPaidEl) netPaidEl.textContent = netPaid.toFixed(2) + ' LYD';
  
  // Calculate savings or extra paid compared to market rate
  const marketRate = state.defaultExchangeRate;
  
  if (savingsEl && totalR2 > 0) {
    // What customer would have paid at market rate
    const marketValue = totalR2 * marketRate;
    // Difference: positive = customer saved, negative = customer paid extra
    const difference = marketValue - totalR1;
    
    if (Math.abs(difference) < 0.01) {
      // No significant difference
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
      savingsEl.innerHTML = `<i data-lucide="equal" class="w-4 h-4 inline mr-1"></i> Paid at market rate`;
      savingsEl.classList.remove('hidden');
    } else if (difference > 0) {
      // Customer saved money (paid less than market rate)
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      savingsEl.innerHTML = `<i data-lucide="trending-down" class="w-4 h-4 inline mr-1"></i> Customer Saved: <span class="text-emerald-600 font-bold">${Security.escapeHtml(difference.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    } else {
      // Customer paid extra (paid more than market rate)
      const extra = Math.abs(difference);
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400';
      savingsEl.innerHTML = `<i data-lucide="trending-up" class="w-4 h-4 inline mr-1"></i> Paid Extra: <span class="text-rose-600 font-bold">${Security.escapeHtml(extra.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    }
    
    // Refresh icons
    if (window.lucide) lucide.createIcons();
  } else if (savingsEl) {
    savingsEl.classList.add('hidden');
  }
}

// Helper: compute totals from current payment rows (shared use)
function getPaymentTotalsFromDom() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let totalR1 = 0;
  let totalR2 = 0;
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    const amountInput = item.querySelector('.payment-amount');
    const rate1Input = item.querySelector('.payment-rate1');
    const rate2Input = item.querySelector('.payment-rate2');
    if (!methodSelect || !amountInput || !rate1Input || !rate2Input) return;
    const paymentMethod = methodSelect.value;
    const amount = parseFloat(amountInput.value) || 0;
    const rate1 = parseFloat(rate1Input.value) || 0;
    const rate2 = parseFloat(rate2Input.value) || 0;
    const r1 = amount * rate1;
    const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
    let r2 = 0;
    if (rate2 > 0) {
      r2 = usdBasedMethods.includes(paymentMethod) ? (r1 / rate2) : (amount / rate2);
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    totalR1 += r1;
    totalR2 += r2;
  });
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  return { totalR1, totalR2 };
}

/**
 * Save a receipt from the modal form (create new or update existing).
 * 
 * This is the MAIN RECEIPT SAVE LOGIC - handles all receipt types:
 *   - Regular receipts (Paid, Not Paid - Office collection)
 *   - Delivery receipts (Not Paid - Delivery collection)
 *   - Temp delivery receipts (D1, D2, etc. assigned to drivers)
 *   - Refund receipts
 *   - Lost/Canceled receipts
 * 
 * Critical Validations:
 *   1. Customer must be selected
 *   2. Receipt number required (except for Not Paid status)
 *   3. Receipt number must be unique and valid (digits only, no leading zeros)
 *   4. Temp delivery receipts (D#) must have a driver assigned
 *   5. Delivery fee required for delivery receipts
 *   6. Amounts must be positive numbers
 * 
 * Special Flows:
 *   - Not Paid + Delivery: Creates temp receipt (D#) assigned to driver
 *   - Server generates D# if not provided (multi-user safe)
 *   - Paid + Delivery: Normal receipt with driver info (already collected)
 * 
 * Server Sync:
 *   - Uses apiCreateEntity() for new receipts
 *   - Server returns authoritative data (including generated D# numbers)
 *   - Frontend shows success only after server confirmation
 * 
 * Error Handling:
 *   - Validation errors: Show toast + highlight field
 *   - Server errors: Show detailed message from server
 *   - Rollback not needed (optimistic update only after server confirms)
 */
async function saveReceiptFromModal() {
  try {
  const customerId = document.getElementById('receipt-customer-id').value;
  if (!customerId) {
    showNotification('Error', 'Please select a customer by phone', 'error');
    return;
  }
  
  // Collect all payment splits
  const paymentItems = document.querySelectorAll('.payment-split-item');
  const payments = [];
  
  paymentItems.forEach(item => {
    const method = item.querySelector('.payment-method').value;
    const amount = parseFloat(item.querySelector('.payment-amount').value) || 0;
    const rate = parseFloat(item.querySelector('.payment-rate1').value) || state.defaultExchangeRate;
    const rate2 = parseFloat(item.querySelector('.payment-rate2').value) || 0;
    const collectionType = item.querySelector('.collection-type').value;
    const deliveryPersonSelect = item.querySelector('.delivery-person');
    const deliveryPersonId = deliveryPersonSelect ? deliveryPersonSelect.value : '';
    
    if (amount > 0) {
      payments.push({
        method,
        amount,
        rate,
        rate2,
        collectionType,
        deliveryPersonId
      });
    }
  });
  
  // Calculate totals using the same logic as updateReceiptTotals
  // R1 = amount * rate1, R2 depends on payment method
  const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  
  let totalR1 = 0; // Total PAID (LYD)
  let totalR2 = 0; // Total ADS CREDIT (USD)
  
  payments.forEach(p => {
    const r1 = p.amount * p.rate;
    let r2 = 0;
    
    if (p.rate2 > 0) {
      if (usdBasedMethods.includes(p.method)) {
        // USD-based methods: R2 = R1 / Rate 2
        r2 = r1 / p.rate2;
      } else {
        // Normal methods: R2 = Amount / Rate 2
        r2 = p.amount / p.rate2;
      }
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    
    totalR1 += r1;
    totalR2 += r2;
  });
  
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  
  const totalLYD = totalR1;
  const totalUSD = totalR2;
  // BUG FIX: Prevent division by zero (defense in depth, already checked totalUSD > 0)
  const avgRate = (totalUSD > 0 && totalLYD > 0) ? (totalLYD / totalUSD) : state.defaultExchangeRate;
  const status = document.getElementById('receipt-status').value || 'Paid';
  const photos = state.tempReceiptPhotos || [];
  
  // Collect status detail fields
  const statusDetail = {
    paidCollection: document.getElementById('paid-collection-value')?.value || 'office',
    paidDeliveryPersonId: document.getElementById('paid-delivery-person')?.value || '',
    notPaidCollection: document.getElementById('notpaid-collection-value')?.value || 'office',
    allowSerialOverride: document.getElementById('status-not-paid-admin-override')?.checked || false,
    refundAction: document.getElementById('status-cancel-refund-action')?.value || '',
    refundStatus: document.getElementById('status-cancel-refund-status')?.value || '',
    lostResolution: document.getElementById('status-lost-resolution')?.value || ''
  };

  const notPaidCollection = String(statusDetail.notPaidCollection || '');
  const isTempDelivery = status === 'Not Paid' && notPaidCollection === 'delivery';
  
  // Enforce Not Paid rules
  if (status === 'Not Paid') {
    if (!statusDetail.notPaidCollection) {
      showNotification('Validation', 'Select how the customer will pay (shop or delivery).', 'error');
      return;
    }
    if (!isCurrentUserAdmin()) {
      statusDetail.allowSerialOverride = false;
      const serialInput = document.getElementById('receipt-serial');
      if (serialInput && !isTempDelivery) serialInput.value = '';
    }
  }
  
  // Enforce Cancel rules
  if (status === 'Canceled') {
    if (!statusDetail.refundAction) {
      showNotification('Validation', 'Select a cancellation outcome.', 'error');
      return;
    }
    if (statusDetail.refundAction === 'full' || statusDetail.refundAction === 'partial') {
      if (!statusDetail.refundStatus) {
        statusDetail.refundStatus = 'pending';
      }
    } else {
      statusDetail.refundStatus = '';
    }
  }
  
  // Lost rules
  if (status === 'Lost' && !statusDetail.lostResolution) {
    showNotification('Validation', 'Select lost resolution (empty or paid).', 'error');
    return;
  }
  
  // Validate receipt number
  const serialNumber = document.getElementById('receipt-serial').value.trim();
  const serialInputEl = document.getElementById('receipt-serial');
  const serialErrEl = document.getElementById('receipt-serial-error');

  // Temp delivery receipts must have a D{n} temporary number.
  if (isTempDelivery) {
    // In server mode, the backend generates tempReceiptNo safely, so it's OK to be empty before save.
    if (!serialNumber && !isServerModeEnabled()) {
      showNotification('Validation', 'Temporary delivery receipt number is missing. Please re-select Delivery or reopen the receipt form.', 'error');
      return;
    }
    if (serialNumber && !isTempDeliveryReceiptNo(serialNumber)) {
      showNotification('Validation', 'Temporary receipt number must look like D12, D13, ...', 'error');
      return;
    }
  }

  // Require receipt number for any status except "Not Paid"
  if (status !== 'Not Paid' && !serialNumber) {
    if (serialErrEl) {
      serialErrEl.innerHTML = '<i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>' +
        (state.language === 'ar' ? 'رقم الوصل مطلوب (إلا إذا كانت الحالة: غير مدفوع)' : 'Receipt number is required (unless status is Not Paid)');
      serialErrEl.classList.remove('hidden');
    }
    if (serialInputEl) {
      serialInputEl.classList.add('border-rose-500', 'focus:ring-rose-500/20', 'animate-shake');
      setTimeout(() => serialInputEl.classList.remove('animate-shake'), 300);
      serialInputEl.focus();
    }
    if (window.lucide) lucide.createIcons();
    showNotification('Validation', state.language === 'ar'
      ? 'لا يمكن حفظ الوصل بدون رقم عندما تكون الحالة (مدفوع/ملغي/ضائع).'
      : 'You cannot save without a receipt number when status is Paid/Canceled/Lost.', 'error');
    return;
  }
  
  if (serialNumber) {
    // Temp delivery receipt uniqueness + format
    if (isTempDelivery) {
      const existingTemp = state.receipts.find(r =>
        !r._deleted &&
        r.id !== (state.modalData ? state.modalData.id : null) &&
        (String(r.tempReceiptNo || '').trim() === serialNumber || String(r.serialNumber || '').trim() === serialNumber || String(r.finalReceiptNo || '').trim() === serialNumber)
      );
      if (existingTemp) {
        showNotification('Duplicate Temp Receipt', `Temporary receipt number "${serialNumber}" already exists. Please reopen the receipt form to generate a new one.`, 'error');
        return;
      }
    }

    // Check if it's a valid receipt number:
    // - Regular receipts: digits only, no leading zeros (123, 456, etc.)
    // - Auto-serial receipts (LTT/Libyana/Madar): S-prefix + digits (S1, S2, S3, etc.)
    const isAutoSerial = isAutoSerialNumber(serialNumber);
    if (!isTempDelivery && !isAutoSerial && !/^\d+$/.test(serialNumber)) {
      showNotification('Invalid Receipt Number', 'Receipt number must contain only digits (0-9) or be S-prefixed (S1, S2) for LTT/Libyana/Madar', 'error');
      return;
    }
    
    // Check if it starts with zero (only for non-auto-serial receipts)
    if (!isTempDelivery && !isAutoSerial && serialNumber.startsWith('0')) {
      showNotification('Invalid Receipt Number', 'Receipt number cannot start with zero', 'error');
      return;
    }
    
    // Check for duplicates (excluding current record if editing)
    const existingReceipt = isTempDelivery ? null : state.receipts.find(receipt => 
      receipt.serialNumber === serialNumber && 
      receipt.id !== (state.modalData ? state.modalData.id : null) &&
      !receipt._deleted
    );
    
    if (existingReceipt) {
      const customer = state.customers.find(c => c.id === existingReceipt.customerId);
      const customerName = customer ? customer.name : 'Unknown';
      
      // Show detailed duplicate warning
      showDuplicateReceiptWarning(serialNumber, customerName, existingReceipt.customerId);
      return;
    }
  }
  
  // Determine delivery status and delivery person based on status and collection method
  let receiptDeliveryStatus = 'Office';
  let receiptDeliveryPersonId = '';
  let receiptIsPaid = true;
  let receiptIsReceivedInOffice = true;
  
  if (status === 'Not Paid') {
    receiptIsPaid = false;
    receiptIsReceivedInOffice = false;
    
    if (statusDetail.notPaidCollection === 'delivery') {
      receiptDeliveryStatus = 'Needs Delivery';
      // Get delivery person from the first payment with a delivery person, or from a dedicated field
      const deliveryPayment = payments.find(p => p.deliveryPersonId);
      receiptDeliveryPersonId = deliveryPayment?.deliveryPersonId || 
                                document.getElementById('notpaid-delivery-person')?.value || '';
    } else {
      receiptDeliveryStatus = 'Office'; // Customer will come to shop
    }
  }

  // Paid rules: collected in office vs by delivery
  if (status === 'Paid') {
    const paidCollection = statusDetail.paidCollection || 'office';
    if (paidCollection === 'delivery') {
      // Payment already collected by driver; mark as delivered but not necessarily handed to office yet.
      receiptDeliveryStatus = 'Delivered';
      receiptIsReceivedInOffice = false;
      const deliveryPayment = payments.find(p => p.deliveryPersonId);
      receiptDeliveryPersonId = statusDetail.paidDeliveryPersonId || deliveryPayment?.deliveryPersonId || '';
    } else {
      receiptDeliveryStatus = 'Office';
      receiptDeliveryPersonId = '';
      receiptIsReceivedInOffice = true;
      statusDetail.paidDeliveryPersonId = '';
    }
  }

  // Temp delivery receipt: require assignment-time delivery info
  const deliveryPlaceName = String(document.getElementById('receipt-delivery-place')?.value || '').trim();
  const quotedDeliveryFee = parseFloat(String(document.getElementById('receipt-quoted-delivery-fee')?.value || '').trim()) || 0;
  const deliveryInstructions = String(document.getElementById('receipt-delivery-instructions')?.value || '').trim();
  if (isTempDelivery) {
    if (!receiptDeliveryPersonId) {
      showNotification('Validation', 'Please assign a delivery person.', 'error');
      return;
    }
    if (!deliveryPlaceName) {
      showNotification('Validation', 'Delivery place name is required.', 'error');
      return;
    }
    if (!(quotedDeliveryFee >= 0) || !Number.isFinite(quotedDeliveryFee)) {
      showNotification('Validation', 'Quoted delivery fee is required.', 'error');
      return;
    }
  }
  
  // Temp delivery receipts: send tempReceiptNo (D#) only; serialNumber stays empty until delivery completion.
  // Normal receipts: send serialNumber only.
  const tempReceiptNo = isTempDelivery ? serialNumber : (state.modalData?.tempReceiptNo || '');
  const serialFinal = isTempDelivery ? (state.modalData?.serialNumber || state.modalData?.finalReceiptNo || '') : serialNumber;
  const finalReceiptNo = (state.modalData?.finalReceiptNo || '') || (serialFinal || '');
  
  const receipt = {
    id: state.modalData ? state.modalData.id : generateId('receipt'),
    recordType: 'receipt',
    customerId: customerId,
    pageId: '',
    creatorId: state.currentUser?.id || '',
    amountUSD: totalUSD,
    exchangeRate: avgRate,
    amountLocal: totalLYD,
    paymentMethod: (Array.isArray(payments) && payments.length > 1) ? 'Split Payment' : (Array.isArray(payments) && payments.length > 0 ? payments[0]?.method : 'Cash (USD)'),
    status,
    statusDetail,
    isPaid: receiptIsPaid,
    deliveryStatus: receiptDeliveryStatus,
    deliveryPersonId: receiptDeliveryPersonId,
    isReceivedInOffice: receiptIsReceivedInOffice,
    startDate: new Date().toISOString(),
    endDate: new Date().toISOString(),
    createdAt: state.modalData ? state.modalData.createdAt : new Date().toISOString(),
    // CRITICAL: temp delivery receipts must NOT send serialNumber=D# (server rejects non-digit serial).
    // Only send serialNumber for normal receipts; temp receipts use tempReceiptNo.
    serialNumber: isTempDelivery ? '' : serialFinal,
    finalReceiptNo: finalReceiptNo,
    tempReceiptNo: tempReceiptNo,
    receiptType: tempReceiptNo ? 'DELIVERY_TEMP' : (state.modalData?.receiptType || ''),
    deliveryPlaceName: isTempDelivery ? deliveryPlaceName : (state.modalData?.deliveryPlaceName || deliveryPlaceName || ''),
    deliveryInstructions: isTempDelivery ? deliveryInstructions : (state.modalData?.deliveryInstructions || deliveryInstructions || ''),
    quotedDeliveryFee: isTempDelivery ? quotedDeliveryFee : (state.modalData?.quotedDeliveryFee ?? quotedDeliveryFee),
    debtAmountLocal: (state.modalData?.debtAmountLocal ?? (isTempDelivery ? totalLYD : undefined)),
    debtAmountUSD: (state.modalData?.debtAmountUSD ?? (isTempDelivery ? totalUSD : undefined)),
    officeFee: 0,
    discount: 0,
    phoneNumber: document.getElementById('receipt-phone-search').value || '',
    collectionDate: new Date().toISOString(),
    payments: payments,
    photos
  };
  
  // Get customer name for logging
  const linkedCustomer = state.customers.find(c => c.id === customerId);
  const customerName = linkedCustomer ? linkedCustomer.name : 'customer';
  
  if (state.modalData) {
    // Update existing - Track changes for edit history
    const oldReceipt = state.modalData;
    const changes = [];
    
    // Fields to track for changes
    const fieldsToTrack = [
      { key: 'customerId', label: 'Customer', format: (v) => state.customers.find(c => c.id === v)?.name || v },
      { key: 'amountUSD', label: 'Amount (USD)', format: (v) => `$${parseFloat(v || 0).toFixed(2)}` },
      { key: 'amountLocal', label: 'Amount (LYD)', format: (v) => `${parseFloat(v || 0).toFixed(2)} LYD` },
      { key: 'exchangeRate', label: 'Exchange Rate', format: (v) => parseFloat(v || 0).toFixed(2) },
      { key: 'paymentMethod', label: 'Payment Method', format: (v) => v },
      { key: 'status', label: 'Status', format: (v) => v },
      { key: 'serialNumber', label: 'Serial Number', format: (v) => v || 'None' },
      { key: 'phoneNumber', label: 'Phone Number', format: (v) => v || 'None' },
    ];
    
    fieldsToTrack.forEach(field => {
      const oldVal = oldReceipt[field.key];
      const newVal = receipt[field.key];
      if (String(oldVal || '') !== String(newVal || '')) {
        changes.push({
          field: field.label,
          from: field.format(oldVal),
          to: field.format(newVal)
        });
      }
    });
    
    // Track payment changes
    const oldPayments = oldReceipt.payments || [];
    const newPayments = receipt.payments || [];
    if (JSON.stringify(oldPayments) !== JSON.stringify(newPayments)) {
      changes.push({
        field: 'Payments',
        from: `${oldPayments.length} payment(s)`,
        to: `${newPayments.length} payment(s)`
      });
    }
    
    // Add to edit history if there are changes
    if (changes.length > 0) {
      const editHistory = oldReceipt.editHistory || [];
      editHistory.push({
        editedAt: new Date().toISOString(),
        editedBy: state.currentUser?.name || 'Unknown',
        changes: changes
      });
      receipt.editHistory = editHistory;
      receipt.editCount = editHistory.length;
    } else {
      receipt.editHistory = oldReceipt.editHistory || [];
      receipt.editCount = oldReceipt.editCount || 0;
    }
    
    receipt.updatedAt = new Date().toISOString();
    updateRecord(state.receipts, receipt.id, receipt);
    showNotification('Updated', 'Receipt updated successfully!', 'success');
    addLog('update', 'receipt', receipt.id, `Updated receipt${serialNumber ? ' #' + serialNumber : ''}`);
  } else {
    // Create new
    if (isServerModeEnabled()) {
      // Server-confirmed create: do NOT show success until the server confirms.
      try {
        const created = await apiCreateEntity('receipts', receipt);
        const saved = created?.data ? Security.sanitizeObject(created.data) : null;
        if (!saved || !saved.id) {
          showNotification('Server Error', 'Failed to create receipt: invalid server response', 'error');
          return;
        }
        // Insert into local state
        state.receipts.unshift(saved);
        markCollectionDirty('receipts');
        saveState();
        showNotification('Success', 'Receipt created successfully!', 'success');
        addLog('create', 'receipt', saved.id, `Created receipt${saved.tempReceiptNo ? ' #' + saved.tempReceiptNo : (serialNumber ? ' #' + serialNumber : '')} for ${customerName}`);
      } catch (e) {
        const status = e?.status ? `HTTP ${e.status}` : '';
        const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
        showNotification('Server Error', `Failed to create receipt: ${status ? status + ' - ' : ''}${detail}`, 'error');
        return; // keep modal open so user can retry
      }
    } else {
    addRecord(state.receipts, receipt);
    showNotification('Success', 'Receipt created successfully!', 'success');
    addLog('create', 'receipt', receipt.id, `Created receipt${serialNumber ? ' #' + serialNumber : ''} for ${customerName}`);
    }
  }
  
  // Reset modal state FIRST
  state.activeModal = null;
  state.modalData = null;
  
  // Force remove ALL modal elements directly
  document.querySelectorAll('#app-modal').forEach(el => el.remove());
  document.querySelectorAll('[class*="fixed inset-0"]').forEach(el => {
    if (el.id === 'app-modal' || el.querySelector('#app-modal')) {
      el.remove();
    }
  });
  
  // Also try the closeModal function
  const modalEl = document.getElementById('app-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.remove();
  }
  
  // Force full re-render to ensure data consistency
  // Reset partial render cache to force full DOM update
  _lastRenderedView = null;
  _lastRenderedUserId = null;
  
  // Render immediately (don't wait)
  render();
    lucide.createIcons();
  
  } catch (error) {
    console.error('Error saving receipt:', error);
    showNotification('Error', 'Failed to save receipt: ' + error.message, 'error');
    
    // Still try to close the modal even if there was an error
    state.activeModal = null;
    state.modalData = null;
    document.querySelectorAll('#app-modal').forEach(el => el.remove());
    setTimeout(() => {
      render();
      lucide.createIcons();
    }, 50);
  }
}

// Image upload handler
function handleReceiptImageUpload(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      // Store base64 image temporarily
      input.dataset.imageData = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
  }
}

// ==========================================
// RECEIPT NUMBER VALIDATION
// ==========================================

// Real-time validation for receipt number input
function validateReceiptNumberInput(input) {
  const errorDiv = document.getElementById('receipt-serial-error');
  const originalValue = input.value;
  
  // Remove any non-digit characters
  let value = input.value.replace(/[^0-9]/g, '');
  
  // Check if user tried to enter non-digit characters
  if (originalValue !== value && originalValue.length > 0) {
    input.classList.add('animate-shake');
    setTimeout(() => input.classList.remove('animate-shake'), 300);
  }
  
  // If the value starts with 0, remove it and show error
  if (value.length > 0 && value.startsWith('0')) {
    value = value.substring(1);
    input.classList.add('animate-shake');
    setTimeout(() => input.classList.remove('animate-shake'), 300);
    
    if (errorDiv) {
      errorDiv.innerHTML = '<i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>Receipt number cannot start with zero';
      errorDiv.classList.remove('hidden');
      input.classList.add('border-rose-500', 'focus:ring-rose-500/20');
      if (window.lucide) lucide.createIcons();
      setTimeout(() => {
        errorDiv.classList.add('hidden');
        input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
      }, 3000);
    }
  }
  
  // Update the input value
  input.value = value;
  
  // Clear error if valid
  if (value.length > 0 && !value.startsWith('0')) {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
  }
}

// Check for duplicate receipt number on blur
function checkReceiptNumberDuplicate(input) {
  const serialNumber = input.value.trim();
  const errorDiv = document.getElementById('receipt-serial-error');
  
  if (!serialNumber) {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
    return;
  }
  
  // Check for duplicates (excluding current record if editing)
  const existingReceipt = state.ads.find(ad => 
    ad.recordType === 'receipt' && 
    ad.serialNumber === serialNumber && 
    ad.id !== (state.modalData ? state.modalData.id : null) &&
    !ad._deleted
  );
  
  if (existingReceipt) {
    const customer = state.customers.find(c => c.id === existingReceipt.customerId);
    const customerName = customer ? customer.name : 'Unknown';
    
    // Show error message with link to customer
    if (errorDiv) {
      errorDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <i data-lucide="alert-circle" class="w-3 h-3"></i>
          <span>Already exists! Linked to: <strong>${customerName}</strong></span>
          <button type="button" onclick="goToCustomerFromWarning('${existingReceipt.customerId}')" 
            class="ml-1 text-indigo-600 hover:text-indigo-700 underline font-bold">
            View Customer →
          </button>
        </div>
      `;
      errorDiv.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }
    input.classList.add('border-rose-500', 'focus:ring-rose-500/20');
  } else {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
  }
}

// Duplicate receipt warning
function showDuplicateReceiptWarning(receiptNumber, customerName, customerId) {
  const warningModal = document.createElement('div');
  warningModal.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm';
  warningModal.id = 'duplicate-receipt-warning';
  
  warningModal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 max-w-md w-full animate-fade-in-up shadow-2xl">
      <div class="flex items-start space-x-4 mb-4">
        <div class="w-12 h-12 bg-rose-100 dark:bg-rose-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
          <i data-lucide="alert-triangle" class="w-6 h-6 text-rose-600"></i>
        </div>
        <div>
          <h3 class="text-xl font-bold text-slate-800 dark:text-white mb-2">Receipt Number Already Exists</h3>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            Receipt number <span class="font-mono font-bold text-rose-600">#${receiptNumber}</span> is already saved.
          </p>
        </div>
      </div>
      
      <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl mb-4">
        <div class="flex items-center space-x-2 mb-2">
          <i data-lucide="user" class="w-4 h-4 text-slate-500"></i>
          <span class="text-xs font-medium text-slate-500 uppercase">Linked to Customer</span>
        </div>
        <p class="text-lg font-bold text-slate-800 dark:text-white">${customerName}</p>
      </div>
      
      <div class="flex space-x-3">
        <button onclick="closeDuplicateWarning()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">
          Close
        </button>
        <button onclick="goToCustomerFromWarning('${customerId}')" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
          <i data-lucide="arrow-right" class="w-4 h-4"></i>
          <span>View Customer</span>
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(warningModal);
  
  // Refresh icons
  if (window.lucide) {
    lucide.createIcons();
  }
}

function closeDuplicateWarning() {
  const warning = document.getElementById('duplicate-receipt-warning');
  if (warning) {
    warning.remove();
  }
}

function goToCustomerFromWarning(customerId) {
  closeDuplicateWarning();
  closeModal();
  navigateTo('customers');
  
  // Scroll to customer after a short delay
  setTimeout(() => {
    const customerCard = document.querySelector(`[data-customer-id="${customerId}"]`);
    if (customerCard) {
      customerCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      customerCard.classList.add('animate-shake');
      setTimeout(() => customerCard.classList.remove('animate-shake'), 500);
    }
  }, 300);
}

// ==========================================
// RECEIPT MODAL HELPERS
// ==========================================

function isTempDeliveryReceiptNo(value) {
  const s = String(value || '').trim();
  return /^D\d+$/.test(s);
}

function getNextTempDeliveryReceiptNo() {
  const receipts = getVisibleRecords(state.receipts);
  let maxN = 0;
  const used = new Set();
  for (const r of receipts) {
    const t = String(r?.tempReceiptNo || '').trim();
    const f = String(r?.finalReceiptNo || r?.serialNumber || '').trim();
    if (t) used.add(t);
    if (f) used.add(f);
    const m = /^D(\d+)$/.exec(t);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  let next = maxN + 1;
  // Safety: if somehow a number is missing, still ensure uniqueness.
  while (used.has(`D${next}`)) next += 1;
  return `D${next}`;
}

function ensureTempDeliveryReceiptNoInReceiptForm() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return '';
  const existing = String(serialInput.value || '').trim();
  if (isTempDeliveryReceiptNo(existing)) return existing;
  const v = getNextTempDeliveryReceiptNo();
  serialInput.value = v;
  return v;
}

function setReceiptStatus(btn, status) {
  // Update hidden input
  document.getElementById('receipt-status').value = status;
  
  // Update visual state
  const container = btn.parentElement;
  const buttons = container.querySelectorAll('button');
  buttons.forEach(b => {
    b.className = 'flex-1 py-1.5 text-sm font-medium rounded-lg transition-all text-slate-500 hover:text-slate-700';
  });
  
  btn.className = 'flex-1 py-1.5 text-sm font-medium rounded-lg transition-all bg-white shadow-sm text-indigo-600 font-bold';
  
  updateReceiptStatusUI(status);
}

function updateReceiptStatusUI(status) {
  const serialInput = document.getElementById('receipt-serial');
  const paidBlock = document.getElementById('status-paid');
  const notPaidBlock = document.getElementById('status-not-paid');
  const cancelBlock = document.getElementById('status-canceled');
  const lostBlock = document.getElementById('status-lost');
  const refundActionSelect = document.getElementById('status-cancel-refund-action');
  const refundStatusSelect = document.getElementById('status-cancel-refund-status');
  const adminOverride = document.getElementById('status-not-paid-admin-override');
  const notPaidCollection = document.getElementById('notpaid-collection-value')?.value || '';
  const tempHint = document.getElementById('receipt-temp-hint');
  const deliveryInfo = document.getElementById('receipt-delivery-info');

  const currentStatus = status || document.getElementById('receipt-status')?.value || 'Paid';
  const isAdmin = isCurrentUserAdmin();
  const isTempDelivery = currentStatus === 'Not Paid' && notPaidCollection === 'delivery';

  const show = (el, shouldShow) => {
    if (!el) return;
    el.classList.toggle('hidden', !shouldShow);
  };

  // Default visibility
  show(paidBlock, currentStatus === 'Paid');
  show(notPaidBlock, currentStatus === 'Not Paid');
  show(cancelBlock, currentStatus === 'Canceled');
  show(lostBlock, currentStatus === 'Lost');

  // Serial rules
  if (serialInput) {
    // Temp delivery receipt: auto-generate D{n} and lock editing.
    if (isTempDelivery) {
      serialInput.disabled = true;
      serialInput.readOnly = true;
      const existing = String(serialInput.value || '').trim();
      if (isServerModeEnabled()) {
        // In server mode, the backend generates a unique D{n} safely (no collisions across users/devices).
        // Keep existing value when editing; otherwise let server fill it on save.
        if (!isTempDeliveryReceiptNo(existing)) {
          serialInput.value = '';
        }
        serialInput.placeholder = 'Temporary number (server-generated)';
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = isTempDeliveryReceiptNo(existing)
            ? `Temporary number: ${existing} (Pending Delivery)`
            : 'Temporary number will be assigned when saved (Pending Delivery)';
        }
      } else {
        // Local mode fallback: generate a best-effort D{n}.
        serialInput.placeholder = 'Temporary number (auto)';
        const tempNo = ensureTempDeliveryReceiptNoInReceiptForm();
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = `Temporary number: ${tempNo} (Pending Delivery)`;
        }
      }
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.add('hidden');
      show(deliveryInfo, true);
    } else if (currentStatus === 'Not Paid') {
      const allow = isAdmin && adminOverride?.checked;
      serialInput.disabled = !allow;
      serialInput.readOnly = false;
      serialInput.placeholder = allow ? 'Admin entering receipt number' : 'Locked until paid';
      if (!allow) serialInput.value = '';
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
    } else {
      serialInput.disabled = false;
      serialInput.readOnly = false;
      serialInput.placeholder = 'e.g., 12345';
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
    }
  }

  // Refund sub-status
  if (refundActionSelect) {
    const action = refundActionSelect.value;
    const needsRefundStatus = currentStatus === 'Canceled' && (action === 'full' || action === 'partial');
    const refundStatusSection = document.getElementById('cancel-refund-status-section');
    show(refundStatusSection, needsRefundStatus);
  }
}

// Beautiful button selection for Cancel options
function selectCancelOption(value) {
  // Update hidden input
  const input = document.getElementById('status-cancel-refund-action');
  if (input) input.value = value;
  
  // Update button styles
  document.querySelectorAll('.cancel-option-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    // Reset all buttons first
    btn.className = 'cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300';
    
    if (isSelected) {
      // Apply selected gradient based on option
      const gradients = {
        'full': 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 scale-[1.02]',
        'partial': 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 scale-[1.02]',
        'forgiven': 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-violet-500/30 scale-[1.02]',
        'undecided': 'bg-gradient-to-r from-slate-500 to-slate-600 text-white shadow-lg shadow-slate-500/30 scale-[1.02]'
      };
      btn.className += ' ' + (gradients[btnValue] || gradients['undecided']);
      
      // Update icon and text colors
      const iconBg = btn.querySelector('span.flex-shrink-0');
      if (iconBg) iconBg.className = 'flex-shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center';
      btn.querySelectorAll('i').forEach(i => i.className = i.className.replace(/text-\w+-\d+/g, '') + ' text-white');
      btn.querySelectorAll('.font-bold').forEach(el => el.className = el.className.replace(/text-slate-\d+/g, '') + ' text-white');
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => el.className = el.className.replace(/text-slate-\d+/g, '') + ' text-white/80');
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:shadow-md';
    }
  });
  
  // Show/hide refund status section
  const needsRefundStatus = value === 'full' || value === 'partial';
  const refundStatusSection = document.getElementById('cancel-refund-status-section');
  if (refundStatusSection) {
    refundStatusSection.classList.toggle('hidden', !needsRefundStatus);
  }
  
  // Set default refund status if needed
  if (needsRefundStatus) {
    const refundStatusInput = document.getElementById('status-cancel-refund-status');
    if (refundStatusInput && !refundStatusInput.value) {
      refundStatusInput.value = 'pending';
      selectRefundStatus('pending');
    }
  }
  
  if (window.lucide) lucide.createIcons();
}

// ================================
// AD FUNDING & LINKING HELPERS
// ================================

function getPagesForCustomer(customerId) {
  if (!customerId) return [];
  return getVisibleRecords(state.pages).filter(p => Array.isArray(p.customerIds) && p.customerIds.includes(customerId));
}

function getReceiptsForAd(customerId, pageId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts || []).filter(r => {
    if (!r || r._deleted) return false;
    if (r.customerId !== customerId) return false;
    if (pageId && r.pageId && r.pageId !== pageId) return false;
    const statusLower = String(r.status || '').toLowerCase();
    const isPaid = (r.isPaid === true) || statusLower === 'paid';
    if (!isPaid) return false;

    // Funding receipts must be real paid receipts.
    // Temp delivery receipts (D#) are allowed ONLY after they are finalized:
    // - deliveryStatus === Delivered
    // - final receipt number exists (digits or S-prefixed) (finalReceiptNo/serialNumber)
    const looksTemp = (String(r.receiptType || '').toUpperCase() === 'DELIVERY_TEMP') || isTempDeliveryReceiptNo(r.tempReceiptNo);
    if (looksTemp) {
      const dsLower = String(r.deliveryStatus || '').toLowerCase();
      const finalNo = String(r.finalReceiptNo || r.serialNumber || '').trim();
      // Accept either digits (123) or S-prefixed (S1, S2) for LTT/Libyana/Madar
      const hasFinalNo = (/^\d+$/.test(finalNo) && !finalNo.startsWith('0')) || isAutoSerialNumber(finalNo);
      if (!(dsLower === 'delivered' && hasFinalNo)) return false;
    }

    return true;
  });
}

function getReceiptRemainingUSD(receipt) {
  const usage = getReceiptUsageStats(receipt);
  return usage.remainingUSD || 0;
}

function initAdFunding(adData = {}) {
  state.tempAdFunding = {
    allocations: Array.isArray(adData.receiptAllocations) ? [...adData.receiptAllocations] : []
  };
}

function handleAdCustomerChange(customerId, preserveFunding = false) {
  // Reset page and funding when customer changes
  const pageSelect = document.getElementById('ad-page');
  if (pageSelect) {
    const pages = getPagesForCustomer(customerId);
    pageSelect.innerHTML = `<option value="">Select page</option>${pages.map(p => `<option value="${Security.escapeHtml(p.id)}">${Security.escapeHtml(p.name)}</option>`).join('')}`;
    if (preserveFunding && state.modalData?.pageId && pages.some(p => p.id === state.modalData.pageId)) {
      pageSelect.value = state.modalData.pageId;
    } else {
      pageSelect.value = '';
    }
  }
  
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
    state.tempAdFunding.allocations = [];
  }
  
  renderAdFundingList();
}

function handleAdPageChange(preserveFunding = false) {
  // Clear funding when page changes (unless we're initializing an edit modal and want to keep existing allocations)
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
  state.tempAdFunding.allocations = [];
  }
  renderAdFundingList();
}

// Select a page in the Add Ad modal (Page-first workflow)
function selectAdPage(pageId, preserveFunding = false) {
  const pageInput = document.getElementById('ad-page');
  const pageSearch = document.getElementById('ad-page-search');
  const customerSection = document.getElementById('ad-customer-section');
  const customerDisplay = document.getElementById('ad-customer-display');
  const customerIdInput = document.getElementById('ad-customer-id');
  const customerHint = document.getElementById('ad-customer-hint');
  
  // Hide dropdown after selection
  hideAdPageDropdown();
  
  if (!pageId) {
    if (customerSection) customerSection.classList.add('hidden');
    if (customerIdInput) customerIdInput.value = '';
    return;
  }
  
  // Update page input
  if (pageInput) pageInput.value = pageId;
  const page = state.pages.find(p => p.id === pageId);
  if (pageSearch && page) pageSearch.value = page.name;
  
  // Update page button visuals
  document.querySelectorAll('.ad-page-btn').forEach(btn => {
    const btnPageId = btn.dataset.pageId;
    const isSelected = btnPageId === pageId;
    
    btn.className = `ad-page-btn group p-2.5 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white shadow-md' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-500'}`;
    
    const icon = btn.querySelector('i[data-lucide="facebook"]');
    const iconContainer = btn.querySelector('span:first-child');
    const title = btn.querySelector('.font-medium');
    const subtitle = btn.querySelector('.text-\\[10px\\]');
    
    if (iconContainer) {
      iconContainer.className = `w-7 h-7 rounded-lg ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center`;
    }
    if (icon) {
      icon.className = `w-3.5 h-3.5 ${isSelected ? 'text-white' : 'text-slate-500 dark:text-slate-400'}`;
    }
    if (title) {
      title.className = `font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}`;
    }
    if (subtitle) {
      subtitle.className = `text-[10px] ${isSelected ? 'text-indigo-200' : 'text-slate-400'}`;
    }
  });
  
  // Get page and find linked customers
  if (!page) return;
  
  const linkedCustomerIds = page.customerIds || [];
  const linkedCustomers = state.customers.filter(c => linkedCustomerIds.includes(c.id));
  
  // Show customer section
  if (customerSection) customerSection.classList.remove('hidden');
  
  if (linkedCustomers.length === 0) {
    // No customers linked to this page
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-center">
          <i data-lucide="alert-triangle" class="w-5 h-5 mx-auto mb-1 text-amber-500"></i>
          <p class="text-xs text-amber-700 dark:text-amber-300">No customers linked.</p>
          <button type="button" onclick="closeModal(); navigateTo('pages')" class="mt-1 text-xs text-amber-600 hover:text-amber-700 font-medium">Link →</button>
        </div>
      `;
    }
    if (customerIdInput) customerIdInput.value = '';
    if (customerHint) customerHint.textContent = '(no customers)';
  } else if (linkedCustomers.length === 1) {
    // Single customer - auto-select
    const customer = linkedCustomers[0];
    if (customerIdInput) customerIdInput.value = customer.id;
    if (customerHint) customerHint.textContent = '(auto-selected)';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="flex items-center space-x-3 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium text-sm">
            ${customer.name?.charAt(0) || 'C'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-slate-700 dark:text-slate-200 truncate">${Security.escapeHtml(customer.name || '')}</div>
            <div class="text-[10px] text-slate-400">${Security.escapeHtml(customer.platform || '')} • ${Security.escapeHtml(customer.phones?.[0] || 'No phone')}</div>
          </div>
          <span class="text-[10px] text-indigo-600 dark:text-indigo-400">✓</span>
        </div>
      `;
    }
  } else {
    // Multiple customers - show selection cards
    if (customerHint) customerHint.textContent = '(select one)';
    const currentCustomerId = customerIdInput?.value || '';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="relative mb-2">
          <i data-lucide="search" class="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
          <input type="text" placeholder="Search..." class="w-full glass-input pl-8 pr-3 py-1.5 rounded-lg text-xs" oninput="filterAdCustomers(this.value)" />
        </div>
        <div id="ad-customer-cards" class="grid grid-cols-2 gap-2 max-h-28 overflow-y-auto">
          ${linkedCustomers.map(c => {
            const isSelected = c.id === currentCustomerId;
            return `
              <button type="button" onclick="selectAdCustomer('${c.id}')" class="ad-customer-btn group p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'}" data-customer-id="${c.id}" data-customer-name="${Security.escapeHtml((c.name || '').toLowerCase())}">
                <div class="flex items-center space-x-2">
                  <div class="w-6 h-6 rounded-full ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center text-[10px] font-medium ${isSelected ? 'text-white' : 'text-slate-500'}">
                    ${c.name?.charAt(0) || 'C'}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}">${Security.escapeHtml(c.name || '')}</div>
                  </div>
                </div>
              </button>
            `;
          }).join('')}
        </div>
      `;
    }
  }
  
  // Refresh icons and funding
  lucide.createIcons();
  handleAdPageChange(!!preserveFunding);
}

// Select customer in multi-customer scenario
function selectAdCustomer(customerId, preserveFunding = false) {
  const customerIdInput = document.getElementById('ad-customer-id');
  const prevCustomerId = customerIdInput?.value || '';
  if (customerIdInput) customerIdInput.value = customerId;
  
  // Update button visuals
  document.querySelectorAll('.ad-customer-btn').forEach(btn => {
    const btnCustomerId = btn.dataset.customerId;
    const isSelected = btnCustomerId === customerId;
    
    btn.className = `ad-customer-btn group p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'}`;
    
    const avatar = btn.querySelector('.rounded-full');
    const title = btn.querySelector('.font-medium');
    
    if (avatar) {
      avatar.className = `w-6 h-6 rounded-full ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center text-[10px] font-medium ${isSelected ? 'text-white' : 'text-slate-500'}`;
    }
    if (title) {
      title.className = `font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}`;
    }
  });
  
  lucide.createIcons();
  // If the user changes customer while creating a new ad, clear funding allocations
  // (receipts are customer-scoped). Preserve allocations only when initializing an edit modal.
  const changedCustomer = prevCustomerId && String(prevCustomerId) !== String(customerId || '');
  if (!preserveFunding && changedCustomer) {
    state.tempAdFunding = state.tempAdFunding || { allocations: [] };
    state.tempAdFunding.allocations = [];
  }
  // Refresh Receipt Funding UI after choosing customer (critical for multi-customer pages)
  renderAdFundingList();
  refreshAdTempReceiptOptions();
}

function getPendingTempDeliveryReceiptsForCustomer(customerId) {
  const cid = String(customerId || '');
  if (!cid) return [];
  return getVisibleRecords(state.receipts)
    .filter(r => {
      if (!r || r._deleted) return false;
      if (String(r.customerId || '') !== cid) return false;
      if (!isTempDeliveryReceiptNo(r.tempReceiptNo)) return false;
      const ds = String(r.deliveryStatus || '');
      if (!ds) return false;
      // Pending delivery receipts only
      if (ds === 'Delivered' || ds === 'Office' || ds === 'Canceled') return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt || b.startDate || 0) - new Date(a.createdAt || a.startDate || 0));
}

function refreshAdTempReceiptOptions() {
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const section = document.getElementById('ad-temp-receipt-link');
  const select = document.getElementById('ad-temp-receipt-id');
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  if (!section || !select || !hidden) return;

  const shouldShow = paymentStatus === 'not_paid' && collectionMethod === 'driver' && !!customerId;
  section.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    hidden.value = '';
    if (hint) hint.textContent = '';
    select.innerHTML = '<option value="">Select pending receipt...</option>';
    return;
  }

  const receipts = getPendingTempDeliveryReceiptsForCustomer(customerId);
  const current = String(hidden.value || '').trim() || String(state.modalData?.receiptId || '').trim();

  select.innerHTML = [
    '<option value="">Select pending receipt...</option>',
    ...receipts.map(r => {
      // Calculate available credit in USD
      const dueUsage = getDeliveryReceiptDueUsage(r);
      const availableUSD = dueUsage.remainingDueUSD;
      const place = String(r.deliveryPlaceName || '').trim();
      const label = `${r.tempReceiptNo}${place ? ' • ' + place : ''} • $${availableUSD.toFixed(2)} available`;
      const selected = String(r.id) === current ? 'selected' : '';
      return `<option value="${r.id}" ${selected}>${Security.escapeHtml(label)}</option>`;
    })
  ].join('');

  // Auto-suggest: if nothing selected yet and there is a pending receipt, pick the newest.
  let selectedId = String(select.value || '').trim();
  if (!selectedId && receipts.length > 0) {
    selectedId = String(receipts[0].id);
    select.value = selectedId;
  }
  onAdTempReceiptChange(selectedId);
}

function onAdTempReceiptChange(receiptId) {
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  const driverSelect = document.getElementById('ad-delivery-person');
  const dueSection = document.getElementById('ad-due-amount-section');
  const mergeToggle = document.getElementById('ad-merge-funds-toggle');
  const dueAvailable = document.getElementById('ad-due-available');
  const dueInput = document.getElementById('ad-due-amount-to-use');
  
  if (!hidden) return;
  hidden.value = String(receiptId || '');

  const rid = String(receiptId || '').trim();
  if (!rid) {
    if (hint) hint.textContent = '';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    return;
  }

  const r = state.receipts.find(x => x && !x._deleted && String(x.id) === rid);
  if (!r) {
    if (hint) hint.textContent = 'Selected receipt not found. Try Refresh.';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    return;
  }

  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (customerId && String(r.customerId || '') !== String(customerId)) {
    if (hint) hint.textContent = 'Receipt customer mismatch. Please select the correct customer.';
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
  } else {
    const place = String(r.deliveryPlaceName || '').trim();
    const fee = Number(r.quotedDeliveryFee ?? 0) || 0;
    const dueLYD = Number(r.debtAmountLocal ?? r.amountLocal ?? 0) || 0;
    
    // Calculate available credit in USD using the new tracking function
    const dueUsage = getDeliveryReceiptDueUsage(r);
    const availableUSD = dueUsage.remainingDueUSD;
    const exchangeRate = dueUsage.exchangeRate || state.defaultExchangeRate || 1;
    
    const txt = `${r.tempReceiptNo}${r.finalReceiptNo || r.serialNumber ? ` → ${r.finalReceiptNo || r.serialNumber}` : ''}${place ? ` • ${place}` : ''} • Quoted fee ${fee.toFixed(0)} LYD`;
    if (hint) hint.textContent = txt;
    
    // Show due amount section if there's available credit
    if (availableUSD > 0.01) {
      if (dueSection) dueSection.classList.remove('hidden');
      if (dueAvailable) dueAvailable.textContent = `Available: $${availableUSD.toFixed(2)} (${(availableUSD * exchangeRate).toFixed(0)} LYD)`;
      if (dueInput) {
        // Store the max due amount in USD for validation
        dueInput.dataset.maxDue = availableUSD.toString();
        dueInput.dataset.exchangeRate = exchangeRate.toString();
        
        // Check if editing - load existing dueAmountToUseUSD from modalData
        let prefillValue = null;
        if (state.modalData?.linkedDeliveryReceiptId === rid) {
          // Check dueAllocations first (new format)
          if (Array.isArray(state.modalData.dueAllocations)) {
            const existingAlloc = state.modalData.dueAllocations.find(a => String(a.receiptId) === rid);
            if (existingAlloc) prefillValue = existingAlloc.amountUSD;
          }
          // Fallback to dueAmountToUseUSD
          if (prefillValue === null && state.modalData.dueAmountToUseUSD > 0) {
            prefillValue = state.modalData.dueAmountToUseUSD;
          }
        }
        
        // Default to existing value, or full available amount for new ads
        if (prefillValue !== null) {
          dueInput.value = prefillValue.toFixed(2);
        } else if (!dueInput.value) {
          dueInput.value = availableUSD.toFixed(2);
        }
      }
      // Show merge toggle to allow combining with paid receipts
      if (mergeToggle) mergeToggle.classList.remove('hidden');
      // Initialize merge funding state
      initMergeFunding();
    } else {
      // No credit available - all used up
      if (dueSection) dueSection.classList.add('hidden');
      if (mergeToggle) mergeToggle.classList.remove('hidden'); // Still allow merging paid receipts
      initMergeFunding();
      // Update hint to show that credit is fully used
      if (hint) hint.textContent += ' • ⚠️ Credit fully used';
    }
    
    updateAdDueSummary();
  }

  // Keep driver selection consistent with the receipt assignment.
  if (driverSelect) {
    const assigned = String(r.deliveryPersonId || '').trim();
    if (assigned) {
      driverSelect.value = assigned;
      driverSelect.disabled = true;
    } else {
      driverSelect.disabled = false;
    }
  }
}

// Initialize merge funding state
function initMergeFunding() {
  if (!state.tempMergeFunding) {
    state.tempMergeFunding = { allocations: [], enabled: false };
  }
}

// Handle due amount input change (USD)
function onAdDueAmountChange() {
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  let value = parseFloat(dueInput.value) || 0;
  
  // Cap at max available
  if (value > maxDue) {
    value = maxDue;
    dueInput.value = value.toFixed(2);
  }
  
  updateAdDueSummary();
}

// Use all available due amount (USD)
function useAllDueAmount() {
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  dueInput.value = maxDue.toFixed(2);
  updateAdDueSummary();
}

// Update the due amount summary (USD)
function updateAdDueSummary() {
  const summary = document.getElementById('ad-due-summary');
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!summary || !dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  const exchangeRate = parseFloat(dueInput.dataset.exchangeRate) || state.defaultExchangeRate || 1;
  const usingUSD = parseFloat(dueInput.value) || 0;
  const remainingUSD = maxDue - usingUSD;
  const usingLYD = usingUSD * exchangeRate;
  const remainingLYD = remainingUSD * exchangeRate;
  
  if (usingUSD > 0) {
    summary.innerHTML = `Using <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> (${usingLYD.toFixed(0)} LYD) from due. ${remainingUSD > 0 ? `<span class="text-slate-400">$${remainingUSD.toFixed(2)} (${remainingLYD.toFixed(0)} LYD) will remain.</span>` : '<span class="text-emerald-600">Full credit will be used.</span>'}`;
  } else {
    summary.innerHTML = '<span class="text-amber-600">Enter amount to use from due receipt.</span>';
  }
}

// Toggle merge with paid funds
function toggleMergePaidFunds() {
  initMergeFunding();
  state.tempMergeFunding.enabled = !state.tempMergeFunding.enabled;
  
  const mergedSection = document.getElementById('ad-merged-paid-funds');
  const mergeIcon = document.getElementById('ad-merge-icon');
  const mergeText = document.getElementById('ad-merge-text');
  
  if (state.tempMergeFunding.enabled) {
    if (mergedSection) mergedSection.classList.remove('hidden');
    if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'minus-circle');
    if (mergeText) mergeText.textContent = 'Remove Paid Receipt Funds';
    renderAdMergedFundingList();
  } else {
    if (mergedSection) mergedSection.classList.add('hidden');
    if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'plus-circle');
    if (mergeText) mergeText.textContent = 'Add Paid Receipt Funds';
    // Clear allocations when disabled
    state.tempMergeFunding.allocations = [];
  }
  
  if (window.lucide) lucide.createIcons();
}

// Add funding allocation for merge mode
function addAdFundingAllocationForMerge() {
  initMergeFunding();
  state.tempMergeFunding.allocations.push({ receiptId: '', amountUSD: '' });
  renderAdMergedFundingList();
}

// Remove funding allocation from merge mode
function removeAdMergeFundingAllocation(idx) {
  if (!state.tempMergeFunding?.allocations) return;
  state.tempMergeFunding.allocations.splice(idx, 1);
  renderAdMergedFundingList();
}

// Update funding receipt in merge mode
function updateAdMergeFundingReceipt(idx, receiptId) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.receiptId = receiptId;
  renderAdMergedFundingList();
}

// Update funding amount in merge mode
function updateAdMergeFundingAmount(idx, value) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.amountUSD = value;
  refreshAdMergedFundingSummary();
}

// Get paid receipts available for the current customer (for merge mode)
function getPaidReceiptsForMerge(customerId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts).filter(r => {
    if (String(r.customerId || '') !== String(customerId)) return false;
    if (r.isPaid === false) return false;
    // Exclude temp delivery receipts that aren't finalized
    const looksTemp = (String(r.receiptType || '').toUpperCase() === 'DELIVERY_TEMP') || isTempDeliveryReceiptNo(r.tempReceiptNo);
    if (looksTemp) {
      const dsLower = String(r.deliveryStatus || '').toLowerCase();
      const finalNo = String(r.finalReceiptNo || r.serialNumber || '').trim();
      const hasFinalNo = (/^\d+$/.test(finalNo) && !finalNo.startsWith('0')) || isAutoSerialNumber(finalNo);
      if (!(dsLower === 'delivered' && hasFinalNo)) return false;
    }
    return true;
  });
}

// Render the merged funding list (for Not Paid + Driver + Merge)
function renderAdMergedFundingList() {
  const list = document.getElementById('ad-merged-funding-list');
  if (!list) return;
  
  initMergeFunding();
  const allocations = state.tempMergeFunding.allocations || [];
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const receipts = getPaidReceiptsForMerge(customerId);
  
  if (allocations.length === 0) {
    list.innerHTML = `<div class="py-2 text-center text-xs text-slate-400">Click "+ Add Receipt" to use paid funds</div>`;
    refreshAdMergedFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    const optionsHtml = receipts.map(r => {
      const usage = getReceiptUsageStats(r);
      const serial = r.serialNumber || r.finalReceiptNo || (r.id ? String(r.id).slice(0,6) : '???');
      const label = `#${serial} • $${(usage.remainingUSD || 0).toFixed(2)} avail`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');
    
    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
    }

    const plannedSpend = parseFloat(alloc.amountUSD) || 0;

    return `
      <div class="p-2 bg-slate-50 rounded-lg space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500">Paid Receipt #${idx + 1}</span>
          <button type="button" onclick="removeAdMergeFundingAllocation(${idx})" class="text-xs text-rose-500 hover:text-rose-600">Remove</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Receipt</label>
            <select class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" onchange="updateAdMergeFundingReceipt(${idx}, this.value)">
              <option value="">Select...</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Use Amount (USD)</label>
            <input type="text" inputmode="decimal" class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdMergeFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400">
            Available: <span class="text-emerald-600 font-medium">$${receiptRemaining.toFixed(2)}</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  refreshAdMergedFundingSummary();
  if (window.lucide) lucide.createIcons();
}

// Refresh the merged funding summary
function refreshAdMergedFundingSummary() {
  const summary = document.getElementById('ad-merged-funding-summary');
  if (!summary) return;
  
  initMergeFunding();
  const allocations = state.tempMergeFunding.allocations || [];
  
  if (allocations.length === 0) {
    summary.innerHTML = '';
    return;
  }
  
  const totalUSD = allocations.reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
  summary.innerHTML = `<div class="flex items-center justify-between py-1">
    <span class="text-xs text-blue-600">Total from Paid Receipts</span>
    <span class="text-sm font-semibold text-blue-700">$${totalUSD.toFixed(2)}</span>
  </div>`;
}

function openTempDeliveryReceiptFromAd() {
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (!customerId) {
    showNotification('Validation', 'Select a customer first.', 'error');
    return;
  }
  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(customerId));
  const phone = customer?.phones?.[0] || '';
  const driverId = document.getElementById('ad-delivery-person')?.value || '';

  closeModal();
  state.activeModal = 'receipt';
  state.modalData = null;
  renderModal();

  setTimeout(() => {
    try {
      if (phone) selectReceiptPhone(phone, customerId);
      const btn = document.querySelector('#receipt-status-tabs button[data-status="Not Paid"]');
      if (btn) setReceiptStatus(btn, 'Not Paid');
      selectNotPaidCollection('delivery');
      const dp = document.getElementById('notpaid-delivery-person');
      if (dp && driverId) dp.value = driverId;
      updateReceiptStatusUI('Not Paid');
    } catch (e) {
      console.warn('openTempDeliveryReceiptFromAd failed:', e);
    }
  }, 160);
}

// Filter customers in multi-customer selection
function filterAdCustomers(searchTerm) {
  const term = searchTerm.toLowerCase();
  document.querySelectorAll('.ad-customer-btn').forEach(btn => {
    const customerName = btn.dataset.customerName || '';
    btn.style.display = customerName.includes(term) ? '' : 'none';
  });
}

// Filter pages dropdown
function filterAdPages() {
  const input = document.getElementById('ad-page-search');
  const term = (input?.value || '').toLowerCase();
  document.querySelectorAll('#ad-page-dropdown .page-option').forEach(opt => {
    const name = opt.dataset.name || '';
    opt.style.display = name.includes(term) ? '' : 'none';
  });
  showAdPageDropdown();
}

function showAdPageDropdown() {
  const dropdown = document.getElementById('ad-page-dropdown');
  if (dropdown) dropdown.classList.remove('hidden');
}

function hideAdPageDropdown() {
  const dropdown = document.getElementById('ad-page-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

// Hide dropdown when clicking outside
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('ad-page-dropdown');
  const search = document.getElementById('ad-page-search');
  if (dropdown && search && !dropdown.contains(e.target) && e.target !== search) {
    dropdown.classList.add('hidden');
  }
});

function toggleAdDriver() {
  const deliverySelect = document.getElementById('ad-delivery');
  const driverContainer = document.getElementById('ad-driver-container');
  if (!deliverySelect || !driverContainer) return;
  driverContainer.classList.toggle('hidden', !deliverySelect.value);
}

// Add ad link input dynamically
function addAdLinkInput(value = '') {
  const list = document.getElementById('ad-links-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'ad-link-row flex space-x-2 items-center';
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://...';
  input.className = 'ad-link-input flex-1 glass-input px-3 py-2 rounded-lg text-sm';
  input.value = value || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-xs text-rose-600 hover:text-rose-700 px-2 py-1';
  btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
  btn.onclick = () => { row.remove(); lucide.createIcons(); };
  row.appendChild(input);
  row.appendChild(btn);
  list.appendChild(row);
  lucide.createIcons();
}

// Set Ad Payment Status (Paid / Not Paid)
function setAdPaymentStatus(status) {
  const paidBtn = document.getElementById('ad-pay-status-paid');
  const notPaidBtn = document.getElementById('ad-pay-status-not-paid');
  const wontPayBtn = document.getElementById('ad-pay-status-wont');
  const hiddenInput = document.getElementById('ad-payment-status');
  const notPaidOptions = document.getElementById('ad-not-paid-options');
  const receiptFunding = document.getElementById('ad-receipt-funding-section');
  const unpaidFinancial = document.getElementById('ad-unpaid-financial');
  
  if (!paidBtn || !notPaidBtn || !wontPayBtn || !hiddenInput) {
    console.error('Payment status buttons not found');
    return;
  }
  
  // Update hidden input
  hiddenInput.value = status;
  
  // Paid button
  if (status === 'paid') {
    paidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30';
    const paidIcon = paidBtn.querySelector('i');
    const paidSpan = paidBtn.querySelector('span');
    if (paidIcon) paidIcon.className = 'w-4 h-4 text-emerald-600';
    if (paidSpan) paidSpan.className = 'font-semibold text-sm text-emerald-700 dark:text-emerald-400';
  } else {
    paidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-emerald-300';
    const paidIcon = paidBtn.querySelector('i');
    const paidSpan = paidBtn.querySelector('span');
    if (paidIcon) paidIcon.className = 'w-4 h-4 text-slate-400';
    if (paidSpan) paidSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Not Paid button
  if (status === 'not_paid') {
    notPaidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-amber-500 bg-amber-50 dark:bg-amber-900/30';
    const notPaidIcon = notPaidBtn.querySelector('i');
    const notPaidSpan = notPaidBtn.querySelector('span');
    if (notPaidIcon) notPaidIcon.className = 'w-4 h-4 text-amber-600';
    if (notPaidSpan) notPaidSpan.className = 'font-semibold text-sm text-amber-700 dark:text-amber-400';
  } else {
    notPaidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-amber-300';
    const notPaidIcon = notPaidBtn.querySelector('i');
    const notPaidSpan = notPaidBtn.querySelector('span');
    if (notPaidIcon) notPaidIcon.className = 'w-4 h-4 text-slate-400';
    if (notPaidSpan) notPaidSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Won't Pay button
  if (status === 'wont_pay') {
    wontPayBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-rose-500 bg-rose-50 dark:bg-rose-900/30';
    const wontIcon = wontPayBtn.querySelector('i');
    const wontSpan = wontPayBtn.querySelector('span');
    if (wontIcon) wontIcon.className = 'w-4 h-4 text-rose-600';
    if (wontSpan) wontSpan.className = 'font-semibold text-sm text-rose-700 dark:text-rose-400';
  } else {
    wontPayBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-rose-300';
    const wontIcon = wontPayBtn.querySelector('i');
    const wontSpan = wontPayBtn.querySelector('span');
    if (wontIcon) wontIcon.className = 'w-4 h-4 text-slate-400';
    if (wontSpan) wontSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Toggle sections
  const wontPaySection = document.getElementById('ad-wont-pay-section');
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  
  if (status === 'paid') {
    if (notPaidOptions) notPaidOptions.classList.add('hidden');
    if (receiptFunding) receiptFunding.classList.remove('hidden');
    if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
    if (wontPaySection) wontPaySection.classList.add('hidden');
    setAdCollectionMethod('');
    // Ensure Receipt Funding list renders immediately (prevents "blank" feeling)
    renderAdFundingList();
    // UX: when creating a new Ad, jump straight to Receipt Funding so users don't think it's missing.
    if (!state.modalData) {
      setTimeout(() => {
        try {
          // Scroll the whole modal panel (header + form) to avoid confusion about where to scroll.
          const scroller = document.getElementById('app-modal')?.firstElementChild || document.getElementById('modal-form');
          const target = document.getElementById('ad-receipt-funding-section');
          if (!scroller || !target) return;
          const scrollerRect = scroller.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const delta = targetRect.top - scrollerRect.top;
          scroller.scrollBy({ top: Math.max(delta - 8, 0), behavior: 'smooth' });
        } catch (e) {
          // no-op
        }
      }, 0);
    }
  } else if (status === 'not_paid') {
    if (notPaidOptions) notPaidOptions.classList.remove('hidden');
    if (receiptFunding) receiptFunding.classList.add('hidden');
    // Hide financial details if driver (receipt already has them)
    if (collectionMethod === 'driver') {
      if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
    } else {
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    }
    if (wontPaySection) wontPaySection.classList.add('hidden');
  } else {
    // wont_pay
    if (notPaidOptions) notPaidOptions.classList.add('hidden');
    if (receiptFunding) receiptFunding.classList.add('hidden');
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    if (wontPaySection) wontPaySection.classList.remove('hidden');
    setAdCollectionMethod('');
  }
  
  lucide.createIcons();
  refreshAdTempReceiptOptions();
}

// Set Ad Collection Method (In Shop / Driver)
function setAdCollectionMethod(method) {
  const shopBtn = document.getElementById('ad-collect-shop');
  const driverBtn = document.getElementById('ad-collect-driver');
  const hiddenInput = document.getElementById('ad-collection-method');
  const collectionDetails = document.getElementById('ad-collection-details');
  const driverSelect = document.getElementById('ad-driver-select');
  
  if (!shopBtn || !driverBtn || !hiddenInput) return;
  
  // Update hidden input
  hiddenInput.value = method;
  
  // Reset all buttons
  const resetBtn = (btn, hoverBorder) => {
    if (!btn) return;
    btn.className = `p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-slate-200 dark:border-slate-600 hover:${hoverBorder} bg-white dark:bg-slate-800`;
    const icon = btn.querySelector('i');
    const span = btn.querySelector('span');
    if (icon) icon.className = 'w-4 h-4 text-slate-400';
    if (span) span.className = 'text-[10px] font-medium text-slate-500';
  };
  
  resetBtn(shopBtn, 'border-blue-300');
  resetBtn(driverBtn, 'border-violet-300');
  
  // If cleared, hide collection details and stop
  if (!method) {
    if (collectionDetails) collectionDetails.classList.add('hidden');
    if (driverSelect) driverSelect.classList.add('hidden');
    lucide.createIcons();
    refreshAdTempReceiptOptions();
    return;
  }
  
  // Show collection details section
  if (collectionDetails) collectionDetails.classList.remove('hidden');
  
  // Activate selected button
  const unpaidFinancial = document.getElementById('ad-unpaid-financial');
  if (method === 'in_shop') {
    shopBtn.className = 'p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-blue-500 bg-blue-50 dark:bg-blue-900/30';
    const shopIcon = shopBtn.querySelector('i');
    const shopSpan = shopBtn.querySelector('span');
    if (shopIcon) shopIcon.className = 'w-4 h-4 text-blue-600';
    if (shopSpan) shopSpan.className = 'text-[10px] font-medium text-blue-700 dark:text-blue-400';
    // Hide driver select for in shop
    if (driverSelect) driverSelect.classList.add('hidden');
    // Show financial details for in shop
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
  } else if (method === 'driver') {
    driverBtn.className = 'p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-violet-500 bg-violet-50 dark:bg-violet-900/30';
    const driverIcon = driverBtn.querySelector('i');
    const driverSpan = driverBtn.querySelector('span');
    if (driverIcon) driverIcon.className = 'w-4 h-4 text-violet-600';
    if (driverSpan) driverSpan.className = 'text-[10px] font-medium text-violet-700 dark:text-violet-400';
    // Driver select is HIDDEN (driver is assigned in the receipt)
    if (driverSelect) driverSelect.classList.add('hidden');
    // Hide financial details for driver (receipt already has them)
    if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
  }
  
  lucide.createIcons();
  refreshAdTempReceiptOptions();
}

// Update number of days based on start/end dates
function parseDateInputAsUTC(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('-').map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUTCDateForInput(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function updateAdDays() {
  const startInput = document.getElementById('ad-start-date');
  const endInput = document.getElementById('ad-end-date');
  const daysInput = document.getElementById('ad-days');
  if (!startInput || !endInput || !daysInput) return;
  const start = parseDateInputAsUTC(startInput.value);
  const end = parseDateInputAsUTC(endInput.value);
  if (!start || !end) {
    daysInput.value = '';
    return;
  }
  const diffMs = end.getTime() - start.getTime();
  const diffDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  daysInput.value = diffDays;

  // Refresh photo previews if present (helps after re-render)
  renderReceiptPhotoPreviews();
}

// Update end date based on start date + days (editable Days field)
function updateAdEndDateFromDays() {
  const startInput = document.getElementById('ad-start-date');
  const endInput = document.getElementById('ad-end-date');
  const daysInput = document.getElementById('ad-days');
  if (!startInput || !endInput || !daysInput) return;

  // Ensure start date exists
  if (!startInput.value) startInput.value = getTodayDateString();

  const start = parseDateInputAsUTC(startInput.value);
  if (!start) return;

  const raw = String(daysInput.value ?? '').trim();
  if (!raw) return;

  let days = parseInt(raw, 10);
  if (!Number.isFinite(days)) return;
  if (days < 0) days = 0;

  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  endInput.value = formatUTCDateForInput(end);
}

// Upload and preview ad photos
function uploadAdPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  state.tempAdPhotos = state.tempAdPhotos || [];
  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.tempAdPhotos.push(e.target.result);
      renderAdPhotoPreviews();
    };
    reader.readAsDataURL(file);
  });
}

function renderAdPhotoPreviews() {
  const container = document.getElementById('ad-photo-previews');
  if (!container) return;
  const photos = state.tempAdPhotos || [];
  if (!photos.length) {
    container.innerHTML = `<div class="text-xs text-slate-400 col-span-4">No photos yet. Click "Add Photo" to upload.</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <img src="${Security.escapeHtml(src)}" class="w-full h-20 object-cover" />
      <button type="button" onclick="removeAdPhoto(${idx})" class="absolute top-1 right-1 bg-white/80 dark:bg-slate-900/80 rounded-full p-1 shadow hover:bg-rose-100">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeAdPhoto(idx) {
  if (!state.tempAdPhotos) return;
  state.tempAdPhotos.splice(idx, 1);
  renderAdPhotoPreviews();
}

// Update totals for ad unpaid financial details (reuses receipt totals calculation)
function updateAdUnpaidTotals() {
  updateReceiptTotals();
}

// Update ad status directly from list view
function updateAdStatusFromList(adId, status) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  updateRecord(state.ads, adId, { status: status });
  addLog('status_change', 'ad', adId, `Changed status to: ${status}`);
  render();
}

function updateAdDeliveryStatus(adId, deliveryStatus) {
  // Permission check
  if (!currentUserHasPermission('deliveries', 'assign') && !currentUserHasPermission('ads', 'edit')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتغيير حالة التوصيل' : 'You do not have permission to change delivery status', 'error');
    return;
  }
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  updateRecord(state.ads, adId, { deliveryStatus: deliveryStatus });
  addLog('delivery_status_change', 'ad', adId, `Changed delivery status to: ${deliveryStatus}`);
  showNotification('Updated', `Delivery status changed to ${deliveryStatus}`, 'success');
  render();
}

// Receipt photos helpers
function uploadReceiptPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  state.tempReceiptPhotos = state.tempReceiptPhotos || [];
  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.tempReceiptPhotos.push(e.target.result);
      renderReceiptPhotoPreviews();
    };
    reader.readAsDataURL(file);
  });
}

function renderReceiptPhotoPreviews() {
  const container = document.getElementById('receipt-photo-previews');
  if (!container) return;
  const photos = state.tempReceiptPhotos || [];
  if (!photos.length) {
    container.innerHTML = `<div class="text-xs text-slate-400 col-span-4">No photos yet. Click "Add Photo" to upload.</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <img src="${Security.escapeHtml(src)}" class="w-full h-20 object-cover" />
      <button type="button" onclick="removeReceiptPhoto(${idx})" class="absolute top-1 right-1 bg-white/80 dark:bg-slate-900/80 rounded-full p-1 shadow hover:bg-rose-100">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeReceiptPhoto(idx) {
  if (!state.tempReceiptPhotos) return;
  state.tempReceiptPhotos.splice(idx, 1);
  renderReceiptPhotoPreviews();
}

// Update local amount display
function updateAdLocalAmount() {
  const amountInput = document.getElementById('ad-amount');
  const rateInput = document.getElementById('ad-rate');
  const displayEl = document.getElementById('ad-local-amount');
  
  if (!amountInput || !rateInput || !displayEl) return;
  
  const amount = parseFloat(amountInput.value) || 0;
  const rate = parseFloat(rateInput.value) || 1;
  const localAmount = amount * rate;
  
  displayEl.innerHTML = `Local: <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(localAmount.toLocaleString())} LYD</span>`;
}

function addAdFundingAllocation() {
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  state.tempAdFunding.allocations.push({ receiptId: '', amountUSD: 0 });
  renderAdFundingList();
}

function removeAdFundingAllocation(idx) {
  if (!state.tempAdFunding?.allocations) return;
  state.tempAdFunding.allocations.splice(idx, 1);
  renderAdFundingList();
}

function updateAdFundingReceipt(idx, receiptId) {
  if (!state.tempAdFunding?.allocations) return;
  const allocation = state.tempAdFunding.allocations[idx];
  if (!allocation) return;
  allocation.receiptId = receiptId;
  
  // Default to 0, but cap existing values at remaining if receipt is selected
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (receipt) {
    const remaining = getReceiptRemainingUSD(receipt);
    // If user already entered a value, cap it at remaining; otherwise default to 0
    if (allocation.amountUSD && parseFloat(allocation.amountUSD) > 0) {
      allocation.amountUSD = Math.min(remaining, parseFloat(allocation.amountUSD) || 0);
    } else {
      allocation.amountUSD = 0;
    }
  } else {
    allocation.amountUSD = 0;
  }
  renderAdFundingList();
  refreshAdFundingSummary();
}

// Money input validator (prevents multiple decimals, limits to 2 decimal places)
function sanitizeMoneyInput(input, maxDecimals = 2) {
  if (!input) return;
  let val = String(input.value || '');
  
  // Preserve cursor position
  const cursorPos = input.selectionStart || 0;
  
  // Remove everything except digits and first decimal point
  let clean = '';
  let hasDecimal = false;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c >= '0' && c <= '9') {
      clean += c;
    } else if (c === '.' && !hasDecimal) {
      clean += c;
      hasDecimal = true;
    }
  }
  
  // Limit decimal places
  if (hasDecimal && maxDecimals >= 0) {
    const parts = clean.split('.');
    if (parts[1] && parts[1].length > maxDecimals) {
      parts[1] = parts[1].substring(0, maxDecimals);
    }
    clean = parts.join('.');
  }
  
  // Only update if value changed
  if (input.value !== clean) {
    input.value = clean;
    // Restore cursor position (adjust for removed characters)
    const newCursorPos = Math.min(cursorPos, clean.length);
    input.setSelectionRange(newCursorPos, newCursorPos);
  }
}

function updateAdFundingAmount(idx, value) {
  if (!state.tempAdFunding?.allocations) return;
  const allocation = state.tempAdFunding.allocations[idx];
  if (!allocation) return;
  // Preserve raw string value to allow typing decimals (e.g., "4." -> "4.1")
  // Only store empty string if truly empty, otherwise keep the raw input
  const trimmed = String(value || '').trim();
  if (trimmed === '' || trimmed === '.') {
    allocation.amountUSD = '';
  } else {
    // Store as string to preserve decimal point during typing
    allocation.amountUSD = trimmed;
  }
  // Do NOT re-render the list here; it would replace the input element and break typing focus/caret.
  refreshAdFundingRow(idx);
  refreshAdFundingSummary();
}

function refreshAdFundingRow(idx) {
  const allocation = state.tempAdFunding?.allocations?.[idx];
  if (!allocation) return;

  const receiptId = allocation.receiptId;
  if (!receiptId) return;

  const receipt = state.receipts?.find(r => r.id === receiptId);
  if (!receipt) return;

  const remainingEl = document.getElementById(`ad-funding-remaining-${idx}`);
  const balanceEl = document.getElementById(`ad-funding-balance-${idx}`);
  const rateEl = document.getElementById(`ad-funding-rate-${idx}`);

  // If the details block isn't rendered yet (no receipt selected when list was rendered), skip.
  if (!remainingEl && !balanceEl && !rateEl) return;

  const usage = getReceiptUsageStats(receipt);
  const receiptRemaining = usage?.remainingUSD ?? 0;
  const plannedSpend = parseFloat(allocation.amountUSD) || 0;
  const balance = Math.max(receiptRemaining - plannedSpend, 0);
  const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';

  if (remainingEl) remainingEl.textContent = `$${Number(receiptRemaining || 0).toFixed(2)}`;
  if (balanceEl) balanceEl.textContent = `$${Number(balance || 0).toFixed(2)}`;
  if (rateEl) rateEl.textContent = String(receiptRate);
}

function renderAdFundingList() {
  const list = document.getElementById('ad-funding-list');
  if (!list) return;

  try {
    const customerId = document.getElementById('ad-customer-id')?.value || '';
    const pageId = document.getElementById('ad-page')?.value || '';
    const paymentStatus = document.getElementById('ad-payment-status')?.value || 'paid';
    const allocations = state.tempAdFunding?.allocations || [];
    const selectedReceiptIds = new Set(allocations.map(a => String(a.receiptId || '')).filter(Boolean));

    // Only show receipts for this customer that still have remaining balance.
    // When editing an existing ad, keep currently-selected receipts visible even if their remaining is now 0.
    let receipts = [];
    try {
      receipts = getReceiptsForAd(customerId, pageId).filter(r => {
        if (!r) return false;
        if (selectedReceiptIds.has(String(r.id))) return true;
        const usage = getReceiptUsageStats(r);
        const remaining = usage?.remainingUSD ?? 0;
        return remaining > 0.0001;
      });
    } catch (filterErr) {
      console.error('Error filtering receipts for ad:', filterErr);
      receipts = [];
    }

  // Prefer latest receipts first (serialNumber desc if numeric, otherwise createdAt desc)
  receipts.sort((a, b) => {
    const aSerial = parseInt(String(a.serialNumber || ''), 10);
    const bSerial = parseInt(String(b.serialNumber || ''), 10);
    if (Number.isFinite(aSerial) && Number.isFinite(bSerial)) return bSerial - aSerial;
    const aTime = new Date(a.createdAt || a.startDate || 0).getTime();
    const bTime = new Date(b.createdAt || b.startDate || 0).getTime();
    return bTime - aTime;
  });
  
  if (!customerId) {
    // In the Ad modal, customer selection depends on picking a Page first.
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">Select a page & customer first</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  if (receipts.length === 0) {
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">No receipts with remaining balance</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  if (allocations.length === 0) {
    // In Paid mode, show the first allocation row automatically (old behavior),
    // so the user can immediately choose a receipt and amount without extra clicks.
    if (String(paymentStatus || '').toLowerCase() === 'paid') {
      state.tempAdFunding = state.tempAdFunding || { allocations: [] };
      state.tempAdFunding.allocations = [{ receiptId: '', amountUSD: '' }];
      renderAdFundingList();
      return;
    }
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">Click "+ Add" to link a receipt</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    const optionsHtml = receipts.map(r => {
      const serial = r.serialNumber || r.finalReceiptNo || (r.id ? String(r.id).slice(0,6) : '???');
      const label = `#${serial} • $${(r.amountUSD || 0).toFixed(2)}`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');
    
    const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';
    
    // Calculate remaining balance BEFORE any planned spend (full receipt remaining)
    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
    }

    // Calculate balance = Remaining - Planned Spend
    const plannedSpend = parseFloat(alloc.amountUSD) || 0;
    const balance = Math.max(receiptRemaining - plannedSpend, 0);
    
    return `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500 flex items-center gap-1"><i data-lucide="receipt" class="w-3 h-3"></i>Receipt Allocation #${idx + 1}</span>
          <button type="button" onclick="removeAdFundingAllocation(${idx})" class="text-xs text-rose-500 hover:text-rose-600">Remove</button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Receipt</label>
            <select class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" onchange="updateAdFundingReceipt(${idx}, this.value)">
              <option value="">Select...</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Planned Spend (USD)</label>
            <input type="text" inputmode="decimal" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400 space-y-0.5">
            <div>Remaining: <span id="ad-funding-remaining-${idx}" class="text-emerald-600 dark:text-emerald-400 font-medium">$${receiptRemaining.toFixed(2)}</span></div>
            <div>Balance: <span id="ad-funding-balance-${idx}" class="text-blue-600 dark:text-blue-400 font-medium">$${balance.toFixed(2)}</span></div>
            <div>Rate: <span id="ad-funding-rate-${idx}" class="text-slate-600 dark:text-slate-300">${receiptRate}</span></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  refreshAdFundingSummary();
  if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error rendering ad funding list:', err);
    list.innerHTML = `<div class="py-3 text-center text-xs text-rose-500">Error loading receipts. Please refresh.</div>`;
  }
}

function refreshAdFundingSummary() {
  const summary = document.getElementById('ad-funding-summary');
  if (!summary) return;
  
  const allocations = state.tempAdFunding?.allocations || [];
  
  if (allocations.length === 0) {
    summary.innerHTML = '';
    return;
  }
  
  // Calculate total balance (sum of all balances: Remaining - Planned Spend per allocation)
  let totalBalance = 0;
  allocations.forEach(a => {
    if (a.receiptId) {
      const receipt = state.receipts.find(r => r.id === a.receiptId);
      if (receipt) {
        const usage = getReceiptUsageStats(receipt);
        const receiptRemaining = usage.remainingUSD;
        const plannedSpend = parseFloat(a.amountUSD) || 0;
        const balance = Math.max(receiptRemaining - plannedSpend, 0);
        totalBalance += balance;
      }
    }
  });
  
  summary.innerHTML = `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-xs text-slate-500">Total Balance</span>
      <span class="text-sm font-semibold ${totalBalance > 0 ? 'text-emerald-600' : 'text-slate-500'}">$${totalBalance.toFixed(2)}</span>
    </div>
  `;
}

// Beautiful button selection for Refund Status
function selectRefundStatus(value) {
  const input = document.getElementById('status-cancel-refund-status');
  if (input) input.value = value;
  
  document.querySelectorAll('.refund-status-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'pending') {
        btn.className += ' bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30';
      } else {
        btn.className += ' bg-gradient-to-r from-emerald-400 to-green-500 text-white shadow-lg shadow-emerald-500/30';
      }
    } else {
      btn.className += ' bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300';
    }
  });
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Not Paid collection method
function selectNotPaidCollection(value) {
  const input = document.getElementById('notpaid-collection-value');
  if (input) input.value = value;
  
  document.querySelectorAll('.notpaid-collection-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'office') {
        btn.className += ' bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }
      
      // Update inner elements
      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-blue-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });
  
  // Show/hide delivery person selector based on selection
  const deliveryPersonSection = document.getElementById('notpaid-delivery-person-section');
  if (deliveryPersonSection) {
    if (value === 'delivery') {
      deliveryPersonSection.classList.remove('hidden');
    } else {
      deliveryPersonSection.classList.add('hidden');
    }
  }

  // Temp delivery receipt UX: show required delivery info + auto temp number.
  const status = document.getElementById('receipt-status')?.value || 'Paid';
  if (status === 'Not Paid') {
    updateReceiptStatusUI(status);
  }
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Paid collection method
function selectPaidCollection(value) {
  const input = document.getElementById('paid-collection-value');
  if (input) input.value = value;

  document.querySelectorAll('.paid-collection-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;

    btn.className = 'paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';

    if (isSelected) {
      if (btnValue === 'office') {
        btn.className += ' bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }

      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-blue-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });

  // Show/hide delivery person selector based on selection
  const deliveryPersonSection = document.getElementById('paid-delivery-person-section');
  if (deliveryPersonSection) {
    if (value === 'delivery') {
      deliveryPersonSection.classList.remove('hidden');
    } else {
      deliveryPersonSection.classList.add('hidden');
      const sel = document.getElementById('paid-delivery-person');
      if (sel) sel.value = '';
    }
  }
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Lost options
function selectLostOption(value) {
  const input = document.getElementById('status-lost-resolution');
  if (input) input.value = value;
  
  document.querySelectorAll('.lost-option-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'empty') {
        btn.className += ' bg-gradient-to-br from-slate-600 to-slate-700 text-white shadow-xl shadow-slate-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }
      
      // Update inner elements
      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-slate-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });
  
  if (window.lucide) lucide.createIcons();
}

function addInlineSplit(data = null) {
  const container = document.getElementById('inline-splits-container');
  const index = container.children.length;
  
  const div = document.createElement('div');
  div.className = 'split-card bg-white border border-slate-200 rounded-xl p-4 relative shadow-sm transition-all hover:shadow-md';
  
  const method = data?.method || 'Cash (LYD)';
  const amount = data?.amount || '';
  const rate1 = data?.rate || 1;
  const rate2 = data?.rate2 !== undefined ? data.rate2 : state.defaultExchangeRate;
  const collection = data?.collectionType || 'office';
  
  div.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <div class="flex items-center space-x-2">
        <i data-lucide="credit-card" class="w-4 h-4 text-slate-400"></i>
        <span class="text-xs font-bold text-slate-500 uppercase tracking-wider">PAYMENT #${index + 1}</span>
      </div>
      <button type="button" onclick="this.closest('.split-card').remove(); updateReceiptTotals();" class="text-slate-300 hover:text-rose-500 transition-colors">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>

    <div class="grid grid-cols-12 gap-4 mb-4">
      <div class="col-span-5">
        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Payment Method</label>
        <select class="split-method w-full bg-slate-50 border-none text-sm font-medium rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500/20" onchange="updateReceiptTotals()">
          ${PAYMENT_METHODS.map(m => `<option value="${m}" ${method === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="col-span-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Amount</label>
        <input type="text" inputmode="decimal" class="split-amount w-full bg-slate-50 border-none text-lg font-bold text-slate-800 rounded-lg px-3 py-1 focus:ring-2 focus:ring-indigo-500/20" oninput="sanitizeMoneyInput(this)" 
          value="${amount}" placeholder="0" oninput="updateReceiptTotals()" />
      </div>
      <div class="col-span-3 space-y-2">
        <div class="flex items-center">
          <label class="text-[10px] font-bold text-slate-400 w-12">RATE 1:</label>
          <input type="text" inputmode="decimal" class="split-rate1 w-full bg-slate-50 border-none text-xs font-mono rounded px-2 py-1 text-right" oninput="sanitizeMoneyInput(this, 4)" 
            value="${rate1}" oninput="updateReceiptTotals()" />
        </div>
        <div class="flex items-center">
          <label class="text-[10px] font-bold text-slate-400 w-12">RATE 2:</label>
          <input type="text" inputmode="decimal" class="split-rate2 w-full bg-slate-50 border-none text-xs font-mono rounded px-2 py-1 text-right" oninput="sanitizeMoneyInput(this, 4)" 
            value="${rate2}" oninput="updateReceiptTotals()" />
        </div>
      </div>
    </div>

    <div class="flex justify-between items-end border-t border-slate-100 pt-3">
      <div class="space-y-1">
        <div class="text-[10px] text-slate-400 font-mono">R1: <span class="split-r1-display font-bold text-slate-600">0.00 LYD</span></div>
        <div class="text-[10px] text-slate-400 font-mono">R2: <span class="split-r2-display font-bold text-slate-600">0.00 USD</span></div>
      </div>
      
      <div>
        <div class="flex bg-slate-100 p-0.5 rounded-lg">
          <button type="button" onclick="toggleCollection(this, 'office')" 
            class="px-3 py-1 text-[10px] font-bold rounded-md transition-all ${collection === 'office' ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}">
            In Shop
          </button>
          <button type="button" onclick="toggleCollection(this, 'delivery')" 
            class="px-3 py-1 text-[10px] font-bold rounded-md transition-all ${collection === 'delivery' ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}">
            Delivery
          </button>
          <input type="hidden" class="split-collection" value="${collection}">
        </div>
      </div>
    </div>
  `;
  
  container.appendChild(div);
  lucide.createIcons();
  updateReceiptTotals();
}

function toggleCollection(btn, type) {
  const wrapper = btn.parentElement;
  const input = wrapper.querySelector('input');
  input.value = type;
  
  const buttons = wrapper.querySelectorAll('button');
  buttons.forEach(b => {
    b.className = 'px-3 py-1 text-[10px] font-bold rounded-md transition-all text-slate-400 hover:text-slate-600';
  });
  
  btn.className = 'px-3 py-1 text-[10px] font-bold rounded-md transition-all bg-white shadow text-indigo-600';
}

// REMOVED DUPLICATE updateReceiptTotals() - the correct version is defined earlier in the file

// Dynamic field management for modals
function addPhoneField() {
  const container = document.getElementById('phone-fields-container');
  const div = document.createElement('div');
  div.className = 'flex items-center space-x-2 phone-field-group';
  div.innerHTML = `
    <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" placeholder="Phone number" />
    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
    </button>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

function addProfileLinkField() {
  const container = document.getElementById('profile-links-container');
  // Remove "no links" message if it exists
  const emptyMsg = container.querySelector('div.text-center');
  if (emptyMsg) emptyMsg.remove();
  
  const div = document.createElement('div');
  div.className = 'flex items-center space-x-2 link-field-group';
  div.innerHTML = `
    <input type="url" class="customer-link flex-1 glass-input px-4 py-2 rounded-xl" placeholder="https://facebook.com/..." />
    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
    </button>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

// CRUD Operations
function showCustomerModal() {
  // Permission check for creating customers
  if (!currentUserHasPermission('customers', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة عملاء' : 'You do not have permission to add customers', 'error');
    return;
  }
  state.activeModal = 'customer';
  state.modalData = null;
  updateUrlParams({ modal: 'customer', id: 'new' }); // URL tracking
  renderModal();
}

function showPageModal() {
  // Permission check for creating pages
  if (!currentUserHasPermission('pages', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة صفحات' : 'You do not have permission to add pages', 'error');
    return;
  }
  state.activeModal = 'page';
  state.modalData = null;
  updateUrlParams({ modal: 'page', id: 'new' }); // URL tracking
  renderModal();
}

function showAdModal() {
  // Permission check for creating ads
  if (!currentUserHasPermission('ads', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء إعلانات' : 'You do not have permission to create ads', 'error');
    return;
  }
  if (getVisibleRecords(state.customers).length === 0) {
    showNotification('No Customers', 'Please add a customer first', 'warning');
    return;
  }
  state.activeModal = 'ad';
  state.modalData = null;
  updateUrlParams({ modal: 'ad', id: 'new' }); // URL tracking for new ad
  renderModal();
}

function showUserModal() {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'هذه الميزة للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  state.activeModal = 'user';
  state.modalData = null;
  updateUrlParams({ modal: 'user', id: 'new' }); // URL tracking
  renderModal();
}

// Update role info display in user modal
function updateUserRoleInfo(role) {
  const roleIcon = document.getElementById('role-icon');
  const roleTitle = document.getElementById('role-title');
  const roleDesc = document.getElementById('role-desc');
  const roleInfo = document.getElementById('role-info');
  
  if (!roleIcon || !roleTitle || !roleDesc) return;
  
  const roleConfig = {
    'Admin': {
      icon: 'crown',
      title: 'Full Administrator',
      desc: 'Complete access to all features. No restrictions.',
      bgColor: 'bg-amber-100 dark:bg-amber-900/30',
      iconColor: 'text-amber-600',
      badge: '<span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">ALL ACCESS</span>'
    },
    'Delivery': {
      icon: 'truck',
      title: 'Delivery Driver',
      desc: 'Access to delivery operations only.',
      bgColor: 'bg-cyan-100 dark:bg-cyan-900/30',
      iconColor: 'text-cyan-600',
      badge: ''
    },
    'Employee': {
      icon: 'user-check',
      title: 'Employee',
      desc: 'Standard employee access. Customize permissions after creation.',
      bgColor: 'bg-emerald-100 dark:bg-emerald-900/30',
      iconColor: 'text-emerald-600',
      badge: ''
    }
  };
  
  const config = roleConfig[role] || roleConfig['Employee'];
  
  roleIcon.className = `w-10 h-10 rounded-xl flex items-center justify-center ${config.bgColor}`;
  roleIcon.innerHTML = `<i data-lucide="${config.icon}" class="w-5 h-5 ${config.iconColor}"></i>`;
  roleTitle.textContent = config.title;
  roleDesc.textContent = config.desc;
  
  // Update badge if exists
  const existingBadge = roleInfo.querySelector('span.rounded-lg');
  if (existingBadge) existingBadge.remove();
  
  if (config.badge) {
    const badgeDiv = document.createElement('div');
    badgeDiv.innerHTML = config.badge;
    roleInfo.querySelector('.flex').appendChild(badgeDiv.firstChild);
  }
  
  if (window.lucide) lucide.createIcons();
}

function renderModal() {
  const existingModal = document.getElementById('app-modal');
  if (existingModal) existingModal.remove();
  
  if (!state.activeModal) return;
  
  const isEdit = state.modalData !== null;
  let modalContent = '';
  switch (state.activeModal) {
    case 'customer':
      const custData = state.modalData || {};
      const phones = custData.phones || [''];
      const profileLinks = custData.profileLinks || [];
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="user" class="w-6 h-6 mr-2 text-indigo-600"></i>
          ${isEdit ? 'Edit' : 'Add'} Customer
        </h2>
        <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <!-- Name -->
          <div>
            <label class="block text-sm font-medium mb-2">Name *</label>
            <input type="text" id="customer-name" value="${Security.escapeHtml(custData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="Customer name" />
          </div>

          <!-- Platform -->
          <div>
            <label class="block text-sm font-medium mb-2">Platform *</label>
            <select id="customer-platform" class="w-full glass-input px-4 py-2 rounded-xl">
              ${PLATFORMS.map(p => `<option value="${p}" ${custData.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>

          <!-- Join Date -->
          <div>
            <label class="block text-sm font-medium mb-2">Join Date</label>
            <input type="date" id="customer-joindate" value="${Security.escapeHtml(custData.joinDate ? custData.joinDate.split('T')[0] : getTodayDateString())}" class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>

          <!-- Phone Numbers -->
          <div>
            <div class="flex justify-between items-center mb-2">
              <label class="block text-sm font-medium">Phone Numbers *</label>
              <button type="button" onclick="addPhoneField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>Add Phone</span>
              </button>
            </div>
            <div id="phone-fields-container" class="space-y-2">
              ${phones.map((phone, index) => `
                <div class="flex items-center space-x-2 phone-field-group">
                  <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" value="${Security.escapeHtml(phone || '')}" placeholder="Phone number" ${index === 0 ? 'required' : ''} />
                  ${index > 0 ? `
                    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : `<div class="w-8"></div>`}
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Profile Links -->
          <div>
            <div class="flex justify-between items-center mb-2">
              <label class="block text-sm font-medium">Profile Links</label>
              <button type="button" onclick="addProfileLinkField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>Add Link</span>
              </button>
            </div>
            <div id="profile-links-container" class="space-y-2">
              ${profileLinks.length > 0 ? profileLinks.map((link, index) => `
                <div class="flex items-center space-x-2 link-field-group">
                  <input type="url" class="customer-link flex-1 glass-input px-4 py-2 rounded-xl" value="${Security.escapeHtml(link || '')}" placeholder="https://facebook.com/..." />
                  <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              `).join('') : `
                <div class="text-center py-4 text-sm text-slate-400">
                  <i data-lucide="link" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
                  <p>No profile links yet. Click "Add Link" to add one.</p>
                </div>
              `}
            </div>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isEdit ? 'Save Changes' : 'Create Customer'}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300">Cancel</button>
          </div>
        </form>
      `;
      break;
    case 'ad':
      const visibleCustomers = getVisibleRecords(state.customers);
      const visiblePages = getVisibleRecords(state.pages);
      const deliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
      const adData = state.modalData || {};
      state.tempAdPhotos = adData.adPhotos || adData.photos || state.tempAdPhotos || [];
      const durationDaysDefault = (adData.days !== undefined ? adData.days : (adData.startDate && adData.endDate ? Math.max(0, Math.round((new Date(adData.endDate) - new Date(adData.startDate)) / (1000 * 60 * 60 * 24))) : ''));
      const isAdminUser = isCurrentUserAdmin();
      const adCreator = isEdit && adData.creatorId ? state.users.find(u => u.id === adData.creatorId) : state.currentUser;
      
      if (visiblePages.length === 0) {
        modalContent = `
          <div class="text-center py-8">
            <div class="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-xl">
              <i data-lucide="file-text" class="w-10 h-10 text-white"></i>
            </div>
            <h2 class="text-xl font-bold text-slate-800 dark:text-white mb-2">No Pages Found</h2>
            <p class="text-slate-500 mb-4">Please add a Facebook Page first before creating an ad.</p>
            <button onclick="closeModal(); navigateTo('pages')" class="btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-3 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>Add Page
            </button>
          </div>
        `;
        break;
      }
      
      // NEW DESIGN: Full-height scrollable modal with clear sections
      modalContent = `
        <div class="flex flex-col h-full max-h-[85vh]">
          <!-- FIXED HEADER -->
          <div class="flex-shrink-0 flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-700">
            <div class="flex items-center space-x-3">
              <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
                <i data-lucide="megaphone" class="w-5 h-5 text-white"></i>
              </span>
              <div>
                <h2 class="text-lg font-bold text-slate-800 dark:text-white">${isEdit ? 'Edit' : 'New'} Ad</h2>
                <p class="text-slate-400 text-xs">Fill all sections below</p>
              </div>
            </div>
            <button type="button" onclick="closeModal()" class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-rose-100 hover:text-rose-600 transition-colors">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <!-- SCROLLABLE FORM BODY -->
          <form id="modal-form" class="flex-1 overflow-y-auto py-4 space-y-4" style="max-height: calc(85vh - 140px);">
            
            <!-- SECTION 1: Basic Info -->
            <div class="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800/50 dark:to-slate-800/30 rounded-xl p-4 space-y-3 border border-slate-200 dark:border-slate-700">
              <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">1</span>
                Basic Info
              </div>
              
              <!-- Creator -->
              <div class="flex items-center justify-between p-2 bg-white dark:bg-slate-900 rounded-lg">
                <div class="flex items-center space-x-2">
                  <div class="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 font-bold text-xs">
                    ${adCreator?.name?.charAt(0) || 'U'}
                  </div>
                  <span class="text-sm text-slate-600 dark:text-slate-300">${Security.escapeHtml(adCreator?.name || 'Unknown')}</span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold ${isAdminUser ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'}">
                  ${isAdminUser ? 'ADMIN' : 'USER'}
                </span>
              </div>
              <input type="hidden" id="ad-creator-id" value="${adCreator?.id || state.currentUser?.id || ''}" />
              
              <!-- Page Selection -->
              <div>
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Page *</label>
                <div class="relative">
                  <input type="text" id="ad-page-search" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-3 py-2 rounded-lg text-sm" placeholder="Search pages..." oninput="filterAdPages()" onfocus="showAdPageDropdown()" value="${Security.escapeHtml((state.pages.find(p => p.id === adData.pageId)?.name) || '')}" autocomplete="off" />
                  <div id="ad-page-dropdown" class="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 rounded-lg shadow-xl max-h-48 overflow-y-auto hidden border border-slate-200 dark:border-slate-600">
                    ${visiblePages.map(p => `
                      <div class="page-option px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer text-sm" data-name="${Security.escapeHtml((p.name || '').toLowerCase())}" onclick="selectAdPage('${p.id}')">
                        ${Security.escapeHtml(p.name || '')}
                      </div>
                    `).join('')}
                  </div>
                  <input type="hidden" id="ad-page" value="${adData.pageId || ''}" required />
                </div>
              </div>
              
              <!-- Customer -->
              <div id="ad-customer-section" class="${adData.pageId ? '' : 'hidden'}">
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Customer <span class="text-slate-400" id="ad-customer-hint">(auto-selected)</span></label>
                <div id="ad-customer-display" class="bg-white dark:bg-slate-900 rounded-lg p-2"></div>
                <input type="hidden" id="ad-customer-id" value="${adData.customerId || ''}" required />
              </div>
            </div>

            <!-- SECTION 2: Payment Status -->
            <div class="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-emerald-200 dark:border-emerald-800">
              <div class="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[10px]">2</span>
                Payment Status
              </div>
              <div class="grid grid-cols-3 gap-2">
                <button type="button" onclick="setAdPaymentStatus('paid')" id="ad-pay-status-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'border-emerald-500 bg-emerald-100 dark:bg-emerald-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="check-circle" class="w-5 h-5 ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'text-emerald-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'text-emerald-700' : 'text-slate-500'}">Paid</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('not_paid')" id="ad-pay-status-not-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'not_paid' ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="clock" class="w-5 h-5 ${adData.paymentStatus === 'not_paid' ? 'text-amber-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'not_paid' ? 'text-amber-700' : 'text-slate-500'}">Not Paid</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('wont_pay')" id="ad-pay-status-wont"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'wont_pay' ? 'border-rose-500 bg-rose-100 dark:bg-rose-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="x-octagon" class="w-5 h-5 ${adData.paymentStatus === 'wont_pay' ? 'text-rose-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'wont_pay' ? 'text-rose-700' : 'text-slate-500'}">Won't Pay</span>
                </button>
              </div>
              <input type="hidden" id="ad-payment-status" value="${adData.paymentStatus || 'paid'}" />
            </div>

            <!-- NOT PAID OPTIONS -->
            <div id="ad-not-paid-options" class="${adData.paymentStatus === 'not_paid' ? '' : 'hidden'}">
              <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3">
                <label class="block text-xs font-bold text-amber-700">How will payment be collected?</label>
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" onclick="setAdCollectionMethod('in_shop')" id="ad-collect-shop"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'in_shop' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="store" class="w-5 h-5 ${adData.collectionMethod === 'in_shop' ? 'text-blue-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">In Shop</span>
                  </button>
                  <button type="button" onclick="setAdCollectionMethod('driver')" id="ad-collect-driver"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'driver' ? 'border-violet-500 bg-violet-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="truck" class="w-5 h-5 ${adData.collectionMethod === 'driver' ? 'text-violet-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">Driver</span>
                  </button>
                </div>
                <input type="hidden" id="ad-collection-method" value="${adData.collectionMethod || ''}" />
                <div id="ad-collection-details" class="${adData.collectionMethod ? '' : 'hidden'} pt-2 border-t border-amber-200">
                  <div id="ad-driver-select" class="hidden"></div>
                  <div id="ad-temp-receipt-link" class="hidden mt-2 p-3 bg-white rounded-lg border border-violet-200 space-y-3">
                    <label class="block text-xs font-bold text-violet-700">Link Delivery Receipt (D#)</label>
                    <select id="ad-temp-receipt-id" class="w-full border border-slate-200 px-3 py-2 rounded-lg text-sm" onchange="onAdTempReceiptChange(this.value)">
                      <option value="">Select pending receipt...</option>
                    </select>
                    <div id="ad-temp-receipt-hint" class="text-xs text-slate-500"></div>
                    <input type="hidden" id="ad-linked-receipt-id" value="${adData.receiptId || ''}" />
                    
                    <!-- Due Amount Usage Section -->
                    <div id="ad-due-amount-section" class="hidden p-3 bg-violet-50 rounded-lg border border-violet-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-semibold text-violet-700">Use Credit from Due Receipt</span>
                        <span id="ad-due-available" class="text-xs text-violet-600 font-medium">Available: $0.00</span>
                  </div>
                      <div class="grid grid-cols-2 gap-2">
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-1">Planned Spend (USD)</label>
                          <input type="text" id="ad-due-amount-to-use" inputmode="decimal" class="w-full border border-violet-300 px-3 py-2 rounded-lg text-sm bg-white" placeholder="0.00" oninput="sanitizeMoneyInput(this); onAdDueAmountChange()" onfocus="this.select()" />
                </div>
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-1">Use All</label>
                          <button type="button" onclick="useAllDueAmount()" class="w-full bg-violet-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-violet-700">
                            Use Full Credit
                          </button>
                        </div>
                      </div>
                      <div id="ad-due-summary" class="text-[10px] text-slate-500"></div>
                    </div>
                    
                    <!-- Merge with Paid Funds Toggle -->
                    <div id="ad-merge-funds-toggle" class="hidden">
                      <button type="button" onclick="toggleMergePaidFunds()" class="flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700 font-medium">
                        <i data-lucide="plus-circle" class="w-4 h-4" id="ad-merge-icon"></i>
                        <span id="ad-merge-text">Add Paid Receipt Funds</span>
                      </button>
                    </div>
                    
                    <!-- Merged Paid Funds Section (hidden by default) -->
                    <div id="ad-merged-paid-funds" class="hidden mt-2 p-3 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-blue-700">Also Use Paid Receipt Funds</span>
                        <button type="button" onclick="addAdFundingAllocationForMerge()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                          + Add Receipt
                        </button>
                      </div>
                      <div id="ad-merged-funding-list" class="space-y-2 bg-white rounded-lg p-2 min-h-[40px]">
                        <div class="text-xs text-slate-400 text-center py-1">Click "+ Add Receipt" to use paid funds</div>
                      </div>
                      <div id="ad-merged-funding-summary" class="text-xs text-blue-600 font-medium"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- UNPAID FINANCIAL -->
            <div id="ad-unpaid-financial" class="${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'hidden' : (adData.paymentStatus === 'not_paid' && adData.collectionMethod === 'driver' ? 'hidden' : '')}">
              <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex justify-between items-center">
                  <span class="text-xs font-bold text-slate-600">Financial Details</span>
                  <button type="button" onclick="addReceiptPaymentSplit()" class="text-xs text-emerald-600 font-medium">+ Add Split</button>
                </div>
                <div id="receipt-financial-section">
                  ${renderReceiptFinancials(
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountUSD || 0,
                      rate: adData.exchangeRate || getDefaultRate1(adData.paymentMethod || PAYMENT_METHODS[0]),
                      rate2: state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountUSD || 0,
                      rate: adData.exchangeRate || getDefaultRate1(adData.paymentMethod || PAYMENT_METHODS[0]),
                      rate2: state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    deliveryUsers
                  )}
                </div>
              </div>
            </div>

            <!-- SECTION 3: Receipt Funding (PAID ONLY) -->
            <div id="ad-receipt-funding-section" class="${adData.paymentStatus === 'paid' || !adData.paymentStatus ? '' : 'hidden'} bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-4 space-y-3 border border-blue-200 dark:border-blue-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px]">3</span>
                  Receipt Funding
                </div>
                <button type="button" onclick="addAdFundingAllocation()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                  + Add Receipt
                </button>
              </div>
              <div id="ad-funding-list" class="space-y-2 bg-white dark:bg-slate-900 rounded-lg p-2 min-h-[60px]">
                <div class="text-xs text-slate-400 text-center py-2">Select a page & customer first</div>
              </div>
              <div id="ad-funding-summary" class="text-xs text-blue-600 font-medium"></div>
            </div>

            <!-- SECTION 4: Dates -->
            <div class="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-xl p-4 space-y-3 border border-purple-200 dark:border-purple-800">
              <div class="text-xs font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center text-[10px]">4</span>
                Ad Duration
              </div>
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <label class="block text-xs text-slate-500 mb-1">Start</label>
                  <input type="date" id="ad-start-date" value="${Security.escapeHtml(adData.startDate ? adData.startDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">End</label>
                  <input type="date" id="ad-end-date" value="${Security.escapeHtml(adData.endDate ? adData.endDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">Days</label>
                  <input type="number" id="ad-days" min="0" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(durationDaysDefault || ''))}" oninput="updateAdEndDateFromDays()" />
                </div>
              </div>
            </div>

            <!-- SECTION 5: Photos -->
            <div class="bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/20 rounded-xl p-4 space-y-3 border border-orange-200 dark:border-orange-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-orange-600 text-white flex items-center justify-center text-[10px]">5</span>
                  Photos
                </div>
                <label class="text-xs bg-orange-600 text-white px-2 py-1 rounded-lg font-medium cursor-pointer hover:bg-orange-700">
                  + Upload
                  <input type="file" accept="image/*" multiple class="hidden" onchange="uploadAdPhotos(this.files)" />
                </label>
              </div>
              <div id="ad-photo-previews" class="grid grid-cols-4 gap-2 min-h-[40px] bg-white dark:bg-slate-900 rounded-lg p-2">
                <div class="text-xs text-slate-400 col-span-4 text-center py-2">No photos yet</div>
              </div>
            </div>

            <!-- SECTION 6: Links -->
            <div class="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-cyan-200 dark:border-cyan-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-cyan-600 text-white flex items-center justify-center text-[10px]">6</span>
                  Ad Links
                </div>
                <button type="button" onclick="addAdLinkInput('')" class="text-xs bg-cyan-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-cyan-700">
                  + Add Link
                </button>
              </div>
              <div id="ad-links-list" class="space-y-2">
                ${(adData.adLinks || (adData.adLink ? [adData.adLink] : [''])).map(link => `
                  <div class="ad-link-row flex space-x-2 items-center">
                    <input type="url" class="ad-link-input flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-3 py-2 rounded-lg text-sm" placeholder="https://..." value="${Security.escapeHtml(link || '')}" />
                    <button type="button" class="text-rose-500 hover:text-rose-700 p-1" onclick="this.closest('.ad-link-row').remove()">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  </div>
                `).join('')}
              </div>
            </div>

          </form>

          <!-- FIXED FOOTER -->
          <div class="flex-shrink-0 pt-4 border-t border-slate-200 dark:border-slate-700 flex gap-3">
            <button type="submit" form="modal-form" class="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-4 py-3 rounded-xl font-bold text-sm shadow-lg">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isEdit ? 'Save Changes' : 'Create Ad'}
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 rounded-xl font-medium text-sm bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200">
              Cancel
            </button>
          </div>
        </div>
      `;
      break;
    case 'user':
      const userData = state.modalData || {};
      const isAdminEditor = isCurrentUserAdmin();
      const isSelfEdit = isEdit && String(userData.id || '') === String(state.currentUser?.id || '');
      const userPermSummary = isEdit && userData.role !== 'Admin' ? getPermissionSummary(userData.permissions || {}) : null;
      modalContent = `
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg">
              ${userData.name ? userData.name.charAt(0) : '<i data-lucide="user-plus" class="w-6 h-6"></i>'}
            </div>
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white">${isEdit ? (isSelfEdit ? 'Edit Profile' : 'Edit User') : 'Add New User'}</h2>
              <p class="text-xs text-slate-500">${isEdit ? (isSelfEdit ? 'Update your profile details' : 'Update user details and access') : 'Create account with permissions'}</p>
            </div>
          </div>
          <button type="button" onclick="closeModal()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <i data-lucide="x" class="w-4 h-4 text-slate-500"></i>
          </button>
        </div>
        
        <form id="modal-form" class="space-y-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Full Name *</label>
              <input type="text" id="user-name" value="${Security.escapeHtml(userData.name || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="John Doe" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Email Address *</label>
              <input type="email" id="user-email" value="${Security.escapeHtml(userData.email || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="john@company.com" />
            </div>
          </div>
          
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Password ${isEdit ? '(leave blank to keep)' : '*'}</label>
              <input type="password" id="user-password" ${!isEdit ? 'required' : ''} class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="${isEdit ? '••••••••' : 'Min. 8 characters'}" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Role *</label>
              <select id="user-role" onchange="updateUserRoleInfo(this.value)" class="w-full glass-input px-4 py-2.5 rounded-xl" ${isAdminEditor ? '' : 'disabled'}>
                ${USER_ROLES.map(r => `<option value="${r}" ${userData.role === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
              ${!isAdminEditor ? `
                <div class="mt-1 text-[11px] text-slate-400">
                  ${state.language === 'ar' ? 'تغيير الدور والصلاحيات للأدمن فقط' : 'Role & permissions can be changed by Admin only'}
                </div>
              ` : ''}
            </div>
          </div>
          
          <!-- Role Info -->
          <div id="role-info" class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="flex items-center space-x-3">
              <div id="role-icon" class="w-10 h-10 rounded-xl flex items-center justify-center ${userData.role === 'Admin' ? 'bg-amber-100 dark:bg-amber-900/30' : userData.role === 'Delivery' ? 'bg-cyan-100 dark:bg-cyan-900/30' : 'bg-emerald-100 dark:bg-emerald-900/30'}">
                <i data-lucide="${userData.role === 'Admin' ? 'crown' : userData.role === 'Delivery' ? 'truck' : 'user-check'}" class="w-5 h-5 ${userData.role === 'Admin' ? 'text-amber-600' : userData.role === 'Delivery' ? 'text-cyan-600' : 'text-emerald-600'}"></i>
              </div>
              <div class="flex-1">
                <div id="role-title" class="font-bold text-sm text-slate-700 dark:text-slate-300">
                  ${userData.role === 'Admin' ? 'Full Administrator' : userData.role === 'Delivery' ? 'Delivery Driver' : 'Employee'}
                </div>
                <div id="role-desc" class="text-xs text-slate-500">
                  ${userData.role === 'Admin' ? 'Complete access to all features. No restrictions.' : userData.role === 'Delivery' ? 'Access to delivery operations only.' : 'Standard employee access. Customize permissions after creation.'}
                </div>
              </div>
              ${userData.role === 'Admin' ? `
                <span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">ALL ACCESS</span>
              ` : ''}
            </div>
          </div>
          
          ${isEdit && userData.role !== 'Admin' && userPermSummary ? `
            <!-- Current Permissions Summary -->
            <div class="p-4 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <i data-lucide="shield" class="w-4 h-4 text-purple-600"></i>
                  <span class="text-sm font-bold text-purple-700 dark:text-purple-300">Current Permissions</span>
                </div>
                <span class="text-xs font-bold text-purple-600">${userPermSummary.granted}/${userPermSummary.total} granted</span>
              </div>
              <div class="w-full h-2 bg-purple-200 dark:bg-purple-800 rounded-full overflow-hidden mb-3">
                <div class="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full" style="width: ${userPermSummary.percentage}%"></div>
              </div>
              ${isAdminEditor ? `
              <button type="button" onclick="closeModal(); setTimeout(() => showPermissionsModal('${userData.id}'), 200)" class="w-full py-2 rounded-lg text-xs font-bold text-purple-600 hover:bg-purple-100 dark:hover:bg-purple-800/30 transition-colors flex items-center justify-center space-x-2">
                <i data-lucide="settings" class="w-3 h-3"></i>
                <span>Manage Detailed Permissions</span>
              </button>
              ` : `
                <div class="text-[11px] text-slate-500 text-center">
                  ${state.language === 'ar' ? 'الصلاحيات لا يمكن تعديلها إلا بواسطة الأدمن' : 'Permissions can only be changed by Admin'}
                </div>
              `}
            </div>
          ` : !isEdit ? `
            <!-- New User Permission Info -->
            <div class="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <div class="flex items-start space-x-3">
                <i data-lucide="info" class="w-5 h-5 text-blue-600 mt-0.5"></i>
                <div>
                  <div class="text-sm font-bold text-blue-700 dark:text-blue-300">Permissions Setup</div>
                  <p class="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    After creating this user, you'll be able to configure their detailed permissions. 
                    Default permissions will be assigned based on their role.
                  </p>
                </div>
              </div>
            </div>
          ` : ''}
          
          <div class="flex space-x-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="${isEdit ? 'save' : 'user-plus'}" class="w-4 h-4"></i>
              <span>${isEdit ? 'Save Changes' : 'Create User'}</span>
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 bg-slate-200 dark:bg-slate-700 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">Cancel</button>
          </div>
        </form>
      `;
      break;
    case 'page':
      const pageData = state.modalData || {};
      const pageCustomers = getVisibleRecords(state.customers);
      const existingCustomerIds = pageData.customerIds || [];
      const isAdminPage = state.currentUser?.role === 'Admin';
      
      if (pageCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">Add Page</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">No customers found. Please add a customer first.</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">Go to Customers</button>
          </div>
        `;
      } else {
      modalContent = `
        <h2 class="text-2xl font-bold mb-4">${isEdit ? 'Edit' : 'Add'} Page</h2>
        <form id="modal-form" class="space-y-4">
          <div>
              <label class="block text-sm font-medium mb-2">Page Name *</label>
            <input type="text" id="page-name" value="${Security.escapeHtml(pageData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>
          <div>
              <label class="block text-sm font-medium mb-2">Category *</label>
            <input type="text" id="page-category" value="${Security.escapeHtml(pageData.category || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>
            
            <!-- Customer Linking Section -->
            <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div class="flex items-center space-x-2 mb-3">
                <i data-lucide="users" class="w-4 h-4 text-blue-600"></i>
                <label class="text-sm font-bold text-blue-900 dark:text-blue-100">Link to Customer(s) *</label>
              </div>
              
              ${!isAdminPage ? `
                <div class="mb-3 p-2 bg-amber-100 dark:bg-amber-900/20 rounded-lg">
                  <p class="text-xs text-amber-800 dark:text-amber-200">
                    <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
                    You can only link a page to one customer
                  </p>
                </div>
              ` : ''}
              
              <div class="relative mb-3">
                <input 
                  type="text" 
                  id="page-customer-search" 
                  placeholder="Search for customer..."
                  class="w-full glass-input px-4 py-2 rounded-xl"
                  oninput="filterPageCustomers()"
                  onfocus="showPageCustomerDropdown()"
                />
                <div id="page-customer-dropdown" class="absolute z-20 mt-1 w-full glass-panel rounded-lg shadow-xl max-h-60 overflow-y-auto hidden">
                  ${pageCustomers.map(c => `
                    <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${isAdminPage}')">
                      <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
                      <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              
              <div id="page-selected-customers" class="space-y-2">
                ${existingCustomerIds.map(cid => {
                  const customer = state.customers.find(c => c.id === cid);
                  return customer ? `
                    <div class="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-800 page-customer-item" data-customer-id="${cid}">
                      <div>
                        <div class="font-medium text-sm text-slate-800 dark:text-white">${Security.escapeHtml(customer.name || '')}</div>
                        <div class="text-xs text-slate-500">${Security.escapeHtml(customer.platform || '')}</div>
                      </div>
                      <button type="button" onclick="removePageCustomer('${cid}')" class="text-rose-500 hover:text-rose-700">
                        <i data-lucide="x-circle" class="w-4 h-4"></i>
                      </button>
                    </div>
                  ` : '';
                }).join('')}
                <div id="page-no-customers" class="${existingCustomerIds.length > 0 ? 'hidden' : ''} text-sm text-slate-400 text-center py-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                  No customers selected yet. Please search and select at least one customer above.
                </div>
              </div>
              
                ${isAdminPage ? `
                <div id="page-multi-customer-warning" class="hidden mt-3 p-3 bg-rose-50 dark:bg-rose-900/20 rounded-lg border border-rose-200 dark:border-rose-800">
                  <div class="flex items-start space-x-2">
                    <i data-lucide="alert-triangle" class="w-4 h-4 text-rose-600 mt-0.5"></i>
                    <div>
                      <p class="text-xs font-bold text-rose-900 dark:text-rose-100">Warning: Multiple Customers</p>
                      <p class="text-xs text-rose-700 dark:text-rose-300 mt-1">This page is linked to multiple customers. This is uncommon and may cause confusion. Are you sure this is what you want?</p>
                    </div>
                  </div>
                </div>
              ` : ''}
            </div>
            
          <div class="flex space-x-3">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">${isEdit ? 'Save Changes' : 'Create Page'}</button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">Cancel</button>
          </div>
        </form>
      `;
      }
      break;
    case 'receipt':
      const receiptCustomers = getVisibleRecords(state.customers);
      const receiptData = state.modalData || {};
      const isAdminReceipt = isCurrentUserAdmin();
      const defaultRate1 = getDefaultRate1(PAYMENT_METHODS[0]);
      const existingPayments = receiptData.payments || [{ method: PAYMENT_METHODS[0], amount: 0, rate: defaultRate1, rate2: state.defaultExchangeRate, collectionType: 'office', deliveryPersonId: '' }];
      const receiptDeliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
      state.tempReceiptPhotos = receiptData.photos || [];
      
      if (receiptCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">Add Receipt</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">No customers found. Please add a customer first.</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">Go to Customers</button>
          </div>
        `;
      } else {
        // Build phone list for search
        const phoneCustomerMap = [];
        receiptCustomers.forEach(c => {
          c.phones.forEach(phone => {
            phoneCustomerMap.push({ phone, customer: c });
          });
        });
        
        modalContent = `
          <div class="space-y-3 max-h-[75vh] overflow-y-auto custom-scrollbar pr-1">
            <!-- Phone Search Section -->
            <div class="grid grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2 flex items-center">
                  <i data-lucide="phone" class="w-3 h-3 mr-1"></i>
                  Search phone...
                </label>
                <input 
                  type="text" 
                  id="receipt-phone-search" 
                  placeholder="Type phone number..."
                  class="w-full glass-input px-3 py-2 rounded-lg text-sm"
                  oninput="filterReceiptPhones()"
                  onfocus="showReceiptPhoneDropdown()"
                />
                <div id="receipt-phone-dropdown" class="absolute z-20 mt-1 w-80 glass-panel rounded-lg shadow-xl max-h-40 overflow-y-auto hidden">
                  ${phoneCustomerMap.map(item => `
                    <div class="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer phone-option" data-phone="${Security.escapeHtml(item.phone)}" data-customer-id="${Security.escapeHtml(item.customer.id)}" onclick="selectReceiptPhone(this.dataset.phone, this.dataset.customerId)">
                      <div class="text-sm font-medium">${Security.escapeHtml(item.phone)}</div>
                      <div class="text-xs text-slate-500">${Security.escapeHtml(item.customer.name)} - ${Security.escapeHtml(item.customer.platform)}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2">Select phone first...</label>
                <input type="text" id="receipt-customer-name" readonly class="w-full glass-input px-3 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-800" placeholder="Customer will appear here" />
                <input type="hidden" id="receipt-customer-id" value="${receiptData.customerId || ''}" />
              </div>
            </div>

            <!-- Receipt Number -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">Receipt Number</label>
              <input type="text" id="receipt-serial" value="${receiptData.serialNumber || receiptData.finalReceiptNo || receiptData.tempReceiptNo || ''}" 
                class="w-full glass-input px-3 py-2 rounded-lg text-sm" 
                placeholder="e.g., 12345" 
                oninput="validateReceiptNumberInput(this)"
                onblur="checkReceiptNumberDuplicate(this)" />
              <div id="receipt-serial-error" class="hidden mt-1 text-xs text-rose-500 font-medium"></div>
              <div id="receipt-temp-hint" class="hidden mt-1 text-xs text-indigo-600 font-medium"></div>
            </div>

            <!-- Status Tabs -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">Status</label>
              <div class="grid grid-cols-4 gap-1.5" id="receipt-status-tabs">
                <button type="button" onclick="setReceiptStatus(this, 'Paid')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${!receiptData.status || receiptData.status === 'Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Paid">Paid</button>
                <button type="button" onclick="setReceiptStatus(this, 'Not Paid')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Not Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Not Paid">Not Paid</button>
                <button type="button" onclick="setReceiptStatus(this, 'Canceled')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Canceled' ? 'bg-rose-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Canceled">Canceled</button>
                <button type="button" onclick="setReceiptStatus(this, 'Lost')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Lost' ? 'bg-slate-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Lost">Lost</button>
              </div>
              <input type="hidden" id="receipt-status" value="${receiptData.status || 'Paid'}" />

              <!-- Paid controls -->
              <div id="status-paid" class="${(!receiptData.status || receiptData.status === 'Paid') ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50 via-indigo-50 to-cyan-50 dark:from-blue-900/40 dark:via-indigo-900/30 dark:to-cyan-900/20 shadow-lg space-y-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30">
                      <i data-lucide="check-circle-2" class="w-5 h-5 text-white"></i>
                    </span>
                    <div>
                      <div class="text-sm font-bold text-blue-900 dark:text-blue-100">Payment Collected</div>
                      <div class="text-xs text-blue-600/80 dark:text-blue-300/80">Choose how the payment was collected</div>
                    </div>
                  </div>
                </div>

                <input type="hidden" id="paid-collection-value" value="${receiptData.statusDetail?.paidCollection || 'office'}" />

                <div class="grid grid-cols-2 gap-3">
                  <button type="button" onclick="selectPaidCollection('office')" class="paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg'}" data-value="office">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'bg-white/20' : 'bg-gradient-to-br from-blue-100 to-indigo-200 dark:from-blue-900/50 dark:to-indigo-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="store" class="w-6 h-6 ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white' : 'text-blue-600 dark:text-blue-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">In Office</div>
                        <div class="text-[10px] ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Paid in shop/office</div>
                      </div>
                    </div>
                  </button>

                  <button type="button" onclick="selectPaidCollection('delivery')" class="paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">By Delivery</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Driver collected payment</div>
                      </div>
                    </div>
                  </button>
                </div>

                <div id="paid-delivery-person-section" class="${receiptData.statusDetail?.paidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                  <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                    <i data-lucide="user-check" class="w-4 h-4"></i>
                    <span>Delivery Person (optional)</span>
                  </label>
                  <select id="paid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                    <option value="">Select delivery person...</option>
                    ${getVisibleRecords(state.users).filter(u => u.role === 'Delivery').map(u =>
                      `<option value="${u.id}" ${receiptData.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`
                    ).join('')}
                  </select>
                </div>
              </div>

              <!-- Not Paid controls -->
              <div id="status-not-paid" class="${receiptData.status === 'Not Paid' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-amber-200 dark:border-amber-700 bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50 dark:from-amber-900/40 dark:via-yellow-900/30 dark:to-orange-900/20 shadow-lg space-y-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/30">
                      <i data-lucide="clock" class="w-5 h-5 text-white"></i>
                    </span>
                    <div>
                      <div class="text-sm font-bold text-amber-900 dark:text-amber-100">Payment Pending</div>
                      <div class="text-xs text-amber-600/80 dark:text-amber-300/80 flex items-center space-x-1">
                        <i data-lucide="lock" class="w-3 h-3"></i>
                        <span>Receipt # locked until paid</span>
              </div>
                </div>
                  </div>
                  ${isAdminReceipt ? `
                    <label class="flex items-center space-x-2 px-3 py-2 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-amber-200 dark:border-amber-700 cursor-pointer hover:bg-white dark:hover:bg-slate-800 transition-all">
                      <input type="checkbox" id="status-not-paid-admin-override" class="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500" onchange="updateReceiptStatusUI('Not Paid')" ${receiptData.statusDetail?.allowSerialOverride ? 'checked' : ''}/>
                      <span class="text-xs font-bold text-amber-800 dark:text-amber-200">Admin Override</span>
                    </label>
                  ` : ''}
                      </div>

                <div class="pt-3 border-t border-amber-200/60 dark:border-amber-700/40">
                  <div class="text-xs font-bold text-amber-800 dark:text-amber-200 mb-3 flex items-center space-x-2">
                    <i data-lucide="map-pin" class="w-3 h-3"></i>
                    <span>How will customer pay?</span>
                  </div>
                  <input type="hidden" id="notpaid-collection-value" value="${receiptData.statusDetail?.notPaidCollection || 'office'}" />
                        <div class="grid grid-cols-2 gap-3">
                    <button type="button" onclick="selectNotPaidCollection('office')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg'}" data-value="office">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-white/20' : 'bg-gradient-to-br from-blue-100 to-indigo-200 dark:from-blue-900/50 dark:to-indigo-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="store" class="w-6 h-6 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-blue-600 dark:text-blue-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">In Shop</div>
                          <div class="text-[10px] ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Customer visits office</div>
                          </div>
                      </div>
                    </button>
                    <button type="button" onclick="selectNotPaidCollection('delivery')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Delivery</div>
                          <div class="text-[10px] ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Driver collects payment</div>
                        </div>
                      </div>
                    </button>
                  </div>
                  
                  <!-- Delivery Person Selection (shown when Delivery is selected) -->
                  <div id="notpaid-delivery-person-section" class="${receiptData.statusDetail?.notPaidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                    <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                      <i data-lucide="user-check" class="w-4 h-4"></i>
                      <span>Assign Delivery Person</span>
                    </label>
                    <select id="notpaid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                      <option value="">Select delivery person...</option>
                      ${getVisibleRecords(state.users).filter(u => u.role === 'Delivery').map(u => 
                        `<option value="${u.id}" ${receiptData.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`
                      ).join('')}
                    </select>
                  </div>

                  <!-- Delivery Info (Required for Temp Delivery Receipts) -->
                  <div id="receipt-delivery-info" class="hidden mt-3 p-3 rounded-xl bg-white/70 dark:bg-slate-800/60 border border-emerald-200 dark:border-emerald-800 space-y-3">
                    <div class="text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
                      <i data-lucide="map-pin" class="w-4 h-4"></i>
                      <span>Delivery Info (Required)</span>
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Place name *</label>
                      <input type="text" id="receipt-delivery-place" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Neighborhood / address / destination" value="${Security.escapeHtml(receiptData.deliveryPlaceName || '')}" maxlength="200" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Quoted delivery fee (LYD) *</label>
                      <input type="text" inputmode="decimal" id="receipt-quoted-delivery-fee" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${(receiptData.quotedDeliveryFee ?? '')}" oninput="sanitizeMoneyInput(this)" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Instructions (optional)</label>
                      <textarea id="receipt-delivery-instructions" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Landmarks, notes...">${Security.escapeHtml(receiptData.deliveryInstructions || '')}</textarea>
                    </div>
                  </div>
                          </div>
                        </div>

              <!-- Canceled controls -->
              <div id="status-canceled" class="${receiptData.status === 'Canceled' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-rose-200 dark:border-rose-800 bg-gradient-to-br from-rose-50 via-pink-50 to-orange-50 dark:from-rose-900/40 dark:via-pink-900/30 dark:to-orange-900/20 shadow-lg space-y-4">
                <div class="flex items-center space-x-3">
                  <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 shadow-lg shadow-rose-500/30">
                    <i data-lucide="rotate-ccw" class="w-5 h-5 text-white"></i>
                  </span>
                          <div>
                    <div class="text-sm font-bold text-rose-900 dark:text-rose-100">What happened?</div>
                    <div class="text-xs text-rose-600/80 dark:text-rose-300/80">Choose the cancellation outcome</div>
                          </div>
                          </div>
                <input type="hidden" id="status-cancel-refund-action" value="${receiptData.statusDetail?.refundAction || ''}" />
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" onclick="selectCancelOption('full')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'full' ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700 hover:shadow-md'}" data-value="full">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'full' ? 'bg-white/20' : 'bg-emerald-100 dark:bg-emerald-900/40'} flex items-center justify-center">
                        <i data-lucide="banknote" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                          <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Full Refund</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white/80' : 'text-slate-500'}">Return all money</div>
                          </div>
                          </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('partial')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-amber-300 dark:hover:border-amber-700 hover:shadow-md'}" data-value="partial">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-white/20' : 'bg-amber-100 dark:bg-amber-900/40'} flex items-center justify-center">
                        <i data-lucide="pie-chart" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-amber-600 dark:text-amber-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Partial Refund</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white/80' : 'text-slate-500'}">Return some money</div>
                        </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('forgiven')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-violet-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md'}" data-value="forgiven">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-white/20' : 'bg-violet-100 dark:bg-violet-900/40'} flex items-center justify-center">
                        <i data-lucide="heart-handshake" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-violet-600 dark:text-violet-400'}"></i>
                      </span>
                        <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Forgiven</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white/80' : 'text-slate-500'}">No refund needed</div>
                          </div>
                        </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('undecided')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-gradient-to-r from-slate-500 to-slate-600 text-white shadow-lg shadow-slate-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 hover:shadow-md'}" data-value="undecided">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center">
                        <i data-lucide="clock" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-600 dark:text-slate-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Undecided</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white/80' : 'text-slate-500'}">Decide later</div>
                      </div>
                    </div>
                  </button>
                </div>
                <div id="cancel-refund-status-section" class="${(receiptData.status === 'Canceled' && (receiptData.statusDetail?.refundAction === 'full' || receiptData.statusDetail?.refundAction === 'partial')) ? '' : 'hidden'} pt-3 border-t border-rose-200 dark:border-rose-800/50 space-y-2">
                  <div class="text-xs font-bold text-rose-800 dark:text-rose-200 flex items-center space-x-2">
                    <i data-lucide="loader" class="w-3 h-3"></i>
                    <span>Refund Progress</span>
              </div>
                  <input type="hidden" id="status-cancel-refund-status" value="${receiptData.statusDetail?.refundStatus || 'pending'}" />
                  <div class="flex space-x-2">
                    <button type="button" onclick="selectRefundStatus('pending')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus !== 'refunded' ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300'}" data-value="pending">
                      <i data-lucide="hourglass" class="w-4 h-4 inline mr-1.5"></i>Pending
                    </button>
                    <button type="button" onclick="selectRefundStatus('refunded')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus === 'refunded' ? 'bg-gradient-to-r from-emerald-400 to-green-500 text-white shadow-lg shadow-emerald-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-emerald-300'}" data-value="refunded">
                      <i data-lucide="check-circle" class="w-4 h-4 inline mr-1.5"></i>Refunded
                    </button>
                  </div>
                </div>
              </div>

              <!-- Lost controls -->
              <div id="status-lost" class="${receiptData.status === 'Lost' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 bg-gradient-to-br from-indigo-50 via-blue-50 to-cyan-50 dark:from-indigo-900/40 dark:via-blue-900/30 dark:to-cyan-900/20 shadow-lg space-y-4">
                <div class="flex items-center space-x-3">
                  <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
                    <i data-lucide="help-circle" class="w-5 h-5 text-white"></i>
                  </span>
                  <div>
                    <div class="text-sm font-bold text-indigo-900 dark:text-indigo-100">What's the situation?</div>
                    <div class="text-xs text-indigo-600/80 dark:text-indigo-300/80">Was this receipt paid or empty?</div>
                  </div>
                </div>
                <input type="hidden" id="status-lost-resolution" value="${receiptData.statusDetail?.lostResolution || ''}" />
                <div class="grid grid-cols-2 gap-3">
                  <button type="button" onclick="selectLostOption('empty')" class="lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.lostResolution === 'empty' ? 'bg-gradient-to-br from-slate-600 to-slate-700 text-white shadow-xl shadow-slate-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 hover:shadow-lg'}" data-value="empty">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.lostResolution === 'empty' ? 'bg-white/20' : 'bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-800'} flex items-center justify-center shadow-inner">
                        <i data-lucide="inbox" class="w-6 h-6 ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white' : 'text-slate-500 dark:text-slate-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Empty</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">No payment received</div>
                      </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectLostOption('paid')" class="lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="paid">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="wallet" class="w-6 h-6 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Paid</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Receipt was lost</div>
                      </div>
                    </div>
                  </button>
                </div>
                </div>
                </div>

            <!-- Financial Details Section -->
            <div class="px-1">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center space-x-2">
                  <i data-lucide="wallet" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
                  <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">Financial Details</h3>
                </div>
                <button type="button" onclick="addReceiptPaymentSplit()" class="text-emerald-600 hover:text-emerald-700 text-xs font-bold flex items-center space-x-1">
                  <i data-lucide="plus-circle" class="w-3 h-3"></i>
                  <span>Add Split</span>
                </button>
              </div>

              <!-- Payment Methods Label -->
              <div class="mb-2">
                <label class="text-[10px] font-bold text-slate-500 uppercase">Payment Methods</label>
                </div>

              <!-- Dynamic Financial Content -->
              <div id="receipt-financial-section">
                ${renderReceiptFinancials(existingPayments, existingPayments, receiptDeliveryUsers)}
                </div>
            </div>

            <!-- Photos -->
            <div class="px-1">
              <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center space-x-1">
                    <i data-lucide="image" class="w-3 h-3"></i>
                    <span>Photos</span>
                  </label>
                  <label class="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center space-x-1 cursor-pointer">
                    <i data-lucide="upload" class="w-3 h-3"></i><span>Add Photo</span>
                    <input type="file" accept="image/*" multiple class="hidden" onchange="uploadReceiptPhotos(this.files)" />
                  </label>
                </div>
                <div id="receipt-photo-previews" class="grid grid-cols-4 gap-2"></div>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="flex space-x-2 px-1 pt-3 border-t border-slate-200 dark:border-slate-700">
              <button type="button" onclick="saveReceiptFromModal()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700">
                <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>${isEdit ? 'Save' : 'Create'}
              </button>
              <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">Cancel</button>
            </div>
          </div>
        `;
      }
      break;
    case 'receipt-transfer':
      const transferReceipt = state.modalData;
      const transferCustomers = getVisibleRecords(state.customers).filter(c => c.id !== transferReceipt.customerId);
      const transferUsage = getReceiptUsageStats(transferReceipt);
      const availableUSD = transferUsage.remainingUSD;
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="swap" class="w-6 h-6 mr-2 text-blue-600"></i>
          Transfer Receipt Balance
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
            <div class="text-xs text-slate-500 mb-1">Available Balance</div>
            <div class="text-lg font-bold text-blue-700 dark:text-blue-200">$${availableUSD.toFixed(2)} USD</div>
            <div class="text-xs text-slate-500">~ ${(availableUSD * (transferReceipt.exchangeRate || state.defaultExchangeRate || 1)).toFixed(2)} LYD</div>
          </div>

          ${transferCustomers.length === 0 ? `
            <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-200 text-sm">
              No other customers available to transfer to. Please add another customer first.
                </div>
          ` : `
            <div>
              <label class="block text-sm font-medium mb-2">Transfer to Customer *</label>
              <select id="transfer-target-customer" class="w-full glass-input px-4 py-2 rounded-xl">
                <option value="">Select customer</option>
                ${transferCustomers.map(c => `<option value="${c.id}">${Security.escapeHtml(c.name || '')}</option>`).join('')}
              </select>
                </div>
            <div>
              <label class="block text-sm font-medium mb-2">Amount (USD) *</label>
              <input type="text" inputmode="decimal" id="transfer-amount-usd" value="${availableUSD.toFixed(2)}" class="w-full glass-input px-4 py-2 rounded-xl" min="0" max="${availableUSD.toFixed(2)}" oninput="sanitizeMoneyInput(this)" />
              <p class="text-xs text-slate-500 mt-1">Available: $${availableUSD.toFixed(2)}</p>
              </div>
            <div>
              <label class="block text-sm font-medium mb-2">Note (optional)</label>
              <textarea id="transfer-note" class="w-full glass-input px-4 py-2 rounded-xl" rows="3" placeholder="Why are you transferring?"></textarea>
            </div>
          `}

          ${transferReceipt.transfers && transferReceipt.transfers.length > 0 ? `
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
              <div class="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 flex items-center space-x-1">
                <i data-lucide="history" class="w-3 h-3"></i><span>Transfer History</span>
              </div>
              <div class="space-y-1 text-xs text-slate-600 dark:text-slate-300 max-h-24 overflow-y-auto custom-scrollbar pr-1">
                ${transferReceipt.transfers.map(t => {
                  const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
                  const name = targetCustomer ? targetCustomer.name : 'Unknown';
                  return `<div class="flex justify-between">
                    <span>${new Date(t.date).toLocaleString()}</span>
                    <span class="font-medium">$${(t.amountUSD || 0).toFixed(2)} → ${name}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}

          <div class="flex space-x-3 pt-2 border-t border-slate-200 dark:border-slate-700 mt-2">
            <button type="button" onclick="saveReceiptTransfer()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold" ${transferCustomers.length === 0 ? 'disabled' : ''}>
              <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>Transfer
              </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">Cancel</button>
            </div>
          </div>
        `;
      break;
    case 'split-payments':
      const splitReceipt = state.modalData;
      const splitExistingPayments = splitReceipt.payments || [];
      const splitDeliveryUsers = getVisibleRecords(state.users).filter(u => u.role === 'Delivery');
      
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="credit-card" class="w-6 h-6 mr-2 text-purple-600"></i>
          Manage Split Payments
        </h2>
        <div class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <div class="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl">
            <div class="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-2">Receipt Total</div>
            <div class="text-2xl font-bold text-indigo-600">$${splitReceipt.amountUSD?.toFixed(2)} = ${splitReceipt.amountLocal?.toFixed(2)} LYD</div>
            <div class="text-xs text-slate-500 mt-1">Exchange Rate: ${splitReceipt.exchangeRate}</div>
          </div>

          <div id="split-payments-container" class="space-y-3">
            ${splitExistingPayments.map((payment, idx) => `
              <div class="split-payment-item p-4 rounded-lg">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs font-medium mb-1">Payment Method</label>
                    <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
                      ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Amount (LYD)</label>
                    <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.amount}" oninput="sanitizeMoneyInput(this)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Exchange Rate</label>
                    <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.rate || state.defaultExchangeRate}" oninput="sanitizeMoneyInput(this, 4)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Collection Type</label>
                    <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
                      <option value="office" ${payment.collectionType === 'office' ? 'selected' : ''}>Office</option>
                      <option value="delivery" ${payment.collectionType === 'delivery' ? 'selected' : ''}>Delivery</option>
                      <option value="bank" ${payment.collectionType === 'bank' ? 'selected' : ''}>Bank</option>
                    </select>
                  </div>
                  ${splitDeliveryUsers.length > 0 ? `
                    <div class="col-span-2">
                      <label class="block text-xs font-medium mb-1">Delivery Person</label>
                      <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
                        <option value="">None</option>
                        ${splitDeliveryUsers.map(u => `<option value="${u.id}" ${payment.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
                      </select>
                    </div>
                  ` : ''}
                  <div class="col-span-2 flex justify-end">
                    <button type="button" onclick="this.closest('.split-payment-item').remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700 text-sm font-medium flex items-center space-x-1">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                      <span>Remove</span>
                    </button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <button type="button" onclick="addSplitPayment()" class="w-full btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
            <i data-lucide="plus-circle" class="w-4 h-4"></i>
            <span>Add Payment Split</span>
          </button>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveSplitPayments()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Split Payments
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
          </div>
        </div>
      `;
      break;
    case 'top-ups':
      const topUpAd = state.modalData;
      const existingTopUps = topUpAd.topUps || [];
      
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="trending-up" class="w-6 h-6 mr-2 text-blue-600"></i>
          Manage Top-ups
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
            <div class="text-sm font-medium text-blue-700 dark:text-blue-300">Ad Details</div>
            <div class="text-lg font-bold text-blue-600 mt-1">Original: $${topUpAd.initialAmountUSD || topUpAd.amountUSD} → Current: $${topUpAd.amountUSD}</div>
            ${existingTopUps.length > 0 ? `<div class="text-xs text-slate-500 mt-1">Total top-ups: $${existingTopUps.reduce((sum, t) => sum + t.amount, 0).toFixed(2)}</div>` : ''}
          </div>

          <div id="topups-container" class="space-y-2">
            ${existingTopUps.map((topup, idx) => `
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <div class="font-medium">$${topup.amount}</div>
                  <div class="text-xs text-slate-500">${new Date(topup.date).toLocaleDateString()} - ${Security.escapeHtml(topup.note || '')}</div>
                </div>
                <button type="button" onclick="removeTopUp(${idx})" class="text-rose-500 hover:text-rose-700">
                  <i data-lucide="x-circle" class="w-4 h-4"></i>
                </button>
              </div>
            `).join('')}
          </div>

          <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl space-y-3">
            <h4 class="text-sm font-medium">Add New Top-up</h4>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs mb-1">Amount (USD)</label>
                <input type="text" inputmode="decimal" id="topup-amount" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="0.00" oninput="sanitizeMoneyInput(this)" />
              </div>
              <div>
                <label class="block text-xs mb-1">Date</label>
                <input type="date" id="topup-date" value="${getTodayDateString()}" class="w-full glass-input px-3 py-2 rounded-lg" />
              </div>
            </div>
            <div>
              <label class="block text-xs mb-1">Note</label>
              <input type="text" id="topup-note" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="Reason for top-up..." />
            </div>
            <button type="button" onclick="addNewTopUp()" class="w-full btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>Add Top-up
            </button>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveTopUps()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Top-ups
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
          </div>
        </div>
      `;
      break;
    case 'refund':
      const refundAd = state.modalData;
      
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="arrow-left-circle" class="w-6 h-6 mr-2 text-rose-600"></i>
          Manage Refund
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-rose-50 dark:bg-rose-900/20 rounded-xl">
            <div class="text-sm font-medium text-rose-700 dark:text-rose-300">Ad Amount</div>
            <div class="text-2xl font-bold text-rose-600">$${refundAd.amountUSD} (${refundAd.amountLocal} LYD)</div>
            ${refundAd.refundType && refundAd.refundType !== 'None' ? `
              <div class="text-xs text-slate-500 mt-2">Current Refund: ${refundAd.refundType} - $${refundAd.refundAmount || 0} (${refundAd.refundStatus || 'Pending'})</div>
            ` : ''}
          </div>

          <div>
            <label class="block text-sm font-medium mb-2">Refund Type</label>
            <select id="refund-type" class="w-full glass-input px-4 py-2 rounded-xl" onchange="toggleRefundAmount(this.value)">
              ${REFUND_TYPES.map(t => `<option value="${t}" ${refundAd.refundType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>

          <div id="refund-amount-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">Refund Amount (USD)</label>
            <input type="text" inputmode="decimal" id="refund-amount" value="${refundAd.refundAmount || (refundAd.refundType === 'Full' ? refundAd.amountUSD : 0)}" class="w-full glass-input px-4 py-2 rounded-xl" oninput="sanitizeMoneyInput(this)" />
          </div>

          <div id="refund-status-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">Refund Status</label>
            <select id="refund-status" class="w-full glass-input px-4 py-2 rounded-xl">
              <option value="Pending" ${refundAd.refundStatus === 'Pending' ? 'selected' : ''}>Pending</option>
              <option value="Refunded" ${refundAd.refundStatus === 'Refunded' ? 'selected' : ''}>Refunded</option>
            </select>
          </div>

          <div class="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-start space-x-2">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-600 mt-0.5"></i>
            <p class="text-xs text-amber-700 dark:text-amber-300">Refunds will mark the ad status as Canceled and track the refund amount.</p>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveRefund()" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Refund
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
          </div>
        </div>
      `;
      break;
    case 'recovery-key': {
      const rtl = state.language === 'ar';
      const key = String(state.modalData?.recoveryKey || '');
      modalContent = `
        <div class="text-center">
          <div class="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-4">
            <i data-lucide="key" class="w-8 h-8 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${rtl ? 'مفتاح الاستعادة' : 'Recovery Key'}</h2>
          <p class="text-slate-600 dark:text-slate-300 mb-4 text-sm">
            ${rtl
              ? 'احفظ هذا المفتاح في مكان آمن. يمكنك استخدامه لإعادة تعيين كلمة المرور في الوضع المحلي.'
              : 'Save this key in a safe place. It can reset passwords in local mode.'}
          </p>
          <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 mb-4">
            <div class="text-xs text-slate-400 mb-2">${rtl ? 'المفتاح' : 'Key'}</div>
            <div class="font-mono text-sm break-all select-all text-slate-800 dark:text-slate-200">${Security.escapeHtml(key)}</div>
          </div>
          <div class="flex space-x-3">
            <button type="button" onclick="copyTextToClipboard('${key}').then(ok => showNotification(ok ? 'Copied' : 'Copy Failed', ok ? 'Recovery key copied' : 'Please copy manually', ok ? 'success' : 'error'))" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="copy" class="w-4 h-4 inline mr-2"></i>${rtl ? 'نسخ' : 'Copy'}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${rtl ? 'تم' : 'Done'}
            </button>
          </div>
        </div>
      `;
      break;
    }
    case 'password-reset': {
      const rtl = state.language === 'ar';
      const step = String(state.modalData?.step || (isServerModeEnabled() ? 'request' : 'local'));
      const emailVal = String(state.modalData?.email || '');
      const tokenVal = String(state.modalData?.token || '');

      if (isServerModeEnabled()) {
        if (step === 'confirm') {
          modalContent = `
            <div class="text-center mb-4">
              <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="shield-check" class="w-7 h-7 text-white"></i>
              </div>
              <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
              <p class="text-sm text-slate-500">${rtl ? 'أدخل رمز الاستعادة وكلمة المرور الجديدة' : 'Enter your reset code and new password'}</p>
            </div>

            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('resetCode')}</label>
                <input type="text" id="pwreset-token" value="${Security.escapeHtml(tokenVal)}" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? 'أدخل الرمز' : 'Enter code'}" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
                <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
                <input type="password" id="pwreset-confirm" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" minlength="8" />
              </div>
              <div class="flex space-x-3 pt-2">
                <button type="button" onclick="passwordResetConfirmServer()" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
                  <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('resetPassword')}
                </button>
                <button type="button" onclick="state.modalData.step='request'; state.modalData.token=''; renderModal();" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                  ${rtl ? 'رجوع' : 'Back'}
                </button>
              </div>
            </div>
          `;
        } else {
          modalContent = `
            <div class="text-center mb-4">
              <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="mail" class="w-7 h-7 text-white"></i>
              </div>
              <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
              <p class="text-sm text-slate-500">${rtl ? 'سنرسل رمز استعادة إلى بريدك' : 'We will send a reset code to your email'}</p>
            </div>

            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('email')}</label>
                <input type="email" id="pwreset-email" value="${Security.escapeHtml(emailVal)}" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" />
              </div>
              <div class="flex space-x-3 pt-2">
                <button type="button" onclick="passwordResetRequestServer()" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
                  <i data-lucide="send" class="w-4 h-4 inline mr-2"></i>${t('sendResetCode')}
                </button>
                <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                  ${t('cancel')}
                </button>
              </div>
              <div class="text-[11px] text-slate-400">
                ${rtl ? 'لن نخبرك إن كان البريد موجوداً أم لا.' : 'We do not reveal whether an email exists.'}
              </div>
            </div>
          `;
        }
      } else {
        // Local mode reset: requires Recovery Key
        const hasRecovery = !!(state.localRecovery?.hash && state.localRecovery?.salt);
        modalContent = `
          <div class="text-center mb-4">
            <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center mx-auto mb-3">
              <i data-lucide="key" class="w-7 h-7 text-white"></i>
            </div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
            <p class="text-sm text-slate-500">${rtl ? 'وضع محلي: استخدم مفتاح الاستعادة' : 'Local mode: use the Recovery Key'}</p>
          </div>

          ${!hasRecovery ? `
            <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200 mb-4">
              <div class="font-bold mb-1">${rtl ? 'لا يوجد مفتاح استعادة' : 'No Recovery Key set'}</div>
              <div>${rtl ? 'اطلب من الأدمن إنشاء مفتاح: الإعدادات → الأمان.' : 'Ask Admin to create one: Settings → Security.'}</div>
            </div>
          ` : ''}

          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">${t('email')}</label>
              <input type="email" id="pwreset-email" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('recoveryKey')}</label>
              <input type="text" id="pwreset-recovery" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? 'ألصق مفتاح الاستعادة' : 'Paste recovery key'}" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
              <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
              <input type="password" id="pwreset-confirm" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" minlength="8" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div class="flex space-x-3 pt-2">
              <button type="button" onclick="passwordResetConfirmLocal()" class="flex-1 btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 ${hasRecovery ? '' : 'opacity-50 cursor-not-allowed'}" ${hasRecovery ? '' : 'disabled'}>
                <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('resetPassword')}
              </button>
              <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                ${t('cancel')}
              </button>
            </div>
          </div>
        `;
      }
      break;
    }
    case 'change-password': {
      const rtl = state.language === 'ar';
      modalContent = `
        <div class="text-center mb-4">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center mx-auto mb-3">
            <i data-lucide="lock" class="w-7 h-7 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('changePassword')}</h2>
          <p class="text-sm text-slate-500">
            ${rtl ? 'أدخل كلمة المرور الحالية ثم كلمة المرور الجديدة' : 'Enter your current password and your new password'}
          </p>
        </div>

        <form id="modal-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">${t('currentPassword')}</label>
            <input type="password" id="cp-current" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
            <input type="password" id="cp-new" required minlength="8" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
            <input type="password" id="cp-confirm" required minlength="8" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" />
          </div>
          <div class="flex space-x-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('save')}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${t('cancel')}
            </button>
          </div>
          <div class="text-[11px] text-slate-400">
            ${isServerModeEnabled()
              ? (rtl ? 'في وضع السيرفر: سيتم تسجيل الخروج من الجلسات الأخرى.' : 'Server mode: other sessions will be logged out.')
              : (rtl ? 'في الوضع المحلي: التغيير ينطبق على هذا المتصفح.' : 'Local mode: applies to this browser data.')}
          </div>
        </form>
      `;
      break;
    }
    case 'subscription-lock':
      const lockServiceId = state.modalData?.serviceId || '';
      const lockSubscribeToId = state.modalData?.subscribeToId || lockServiceId;
      const lockServiceName = state.modalData?.serviceName || 'Service';
      const isRTL = state.language === 'ar';
      const subscribeTarget = SERVICES[lockSubscribeToId];
      const subscribeTargetName = subscribeTarget ? (isRTL ? subscribeTarget.nameAr : subscribeTarget.name) : '';
      const offer = getServiceSubscriptionOffer(lockSubscribeToId);
      const walletBalanceMinor = state.currentUser?.id ? WALLET.getBalanceMinor(state.currentUser.id, offer.currency) : 0;
      const walletBalanceLabel = walletFormatMinor(walletBalanceMinor, offer.currency);
      const offerLabel = offer.priceMinor > 0
        ? `${walletFormatMinor(offer.priceMinor, offer.currency)} / ${offer.durationDays}d`
        : (isRTL ? 'مجاني' : 'Free');
      modalContent = `
        <div class="text-center">
          <div class="w-16 h-16 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4">
            <i data-lucide="lock" class="w-8 h-8 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">
            ${isRTL ? 'غير مشترك' : 'Not Subscribed'}
          </h2>
          <p class="text-slate-600 dark:text-slate-300 mb-6">
            ${isRTL 
              ? `أنت غير مشترك في <strong>${lockServiceName}</strong>. هل تريد الاشتراك؟`
              : `You are not subscribed to <strong>${lockServiceName}</strong>. Would you like to subscribe?`
            }
          </p>
          ${lockSubscribeToId !== lockServiceId && subscribeTargetName ? `
            <div class="mb-5 text-xs text-slate-500 dark:text-slate-400">
              ${isRTL ? `سيتم الاشتراك في: <strong>${subscribeTargetName}</strong>` : `You will subscribe to: <strong>${subscribeTargetName}</strong>`}
            </div>
          ` : ''}
          <div class="mb-6 p-4 rounded-2xl bg-white/40 dark:bg-slate-800/30 border border-white/30">
            <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>${isRTL ? 'رصيد المحفظة' : 'Wallet balance'}</span>
              <span class="font-bold">${walletBalanceLabel}</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>${isRTL ? 'سعر الاشتراك' : 'Subscription price'}</span>
              <span class="font-bold">${offerLabel}</span>
            </div>
          </div>
          <div class="flex space-x-3">
            <button onclick="handleSubscribe('${lockSubscribeToId}', '${lockServiceId}')" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>
              ${isRTL ? 'اشترك' : 'Subscribe'}
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </div>
      `;
      break;
  }
  
  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  // Smaller, more compact modal sizes
  let modalSize = 'max-w-md';
  if (state.activeModal === 'split-payments' || state.activeModal === 'top-ups' || state.activeModal === 'refund') {
    modalSize = 'max-w-4xl';
  } else if (state.activeModal === 'ad') {
    modalSize = 'max-w-xl'; // Wider modal for new Ad design with sections
  } else if (state.activeModal === 'receipt') {
    modalSize = 'max-w-lg'; // Compact size for receipts
  }
  // Make Ad/Receipt modals scroll on the whole panel (header + content) to avoid "nothing shows" confusion.
  const modalScrollable = (state.activeModal === 'receipt' || state.activeModal === 'ad')
    ? ' max-h-[90vh] overflow-y-auto custom-scrollbar'
    : '';
  modal.innerHTML = `<div class="glass-panel rounded-2xl p-6 w-full ${modalSize}${modalScrollable}" onclick="event.stopPropagation()">${modalContent}</div>`;
  modal.onclick = closeModal;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  
  // Initialize receipt totals if it's a receipt modal
  if (state.activeModal === 'receipt') {
    setTimeout(() => {
      updateReceiptTotals();
      updateReceiptStatusUI(document.getElementById('receipt-status')?.value || 'Paid');
      // Pre-populate customer if editing
      if (state.modalData && state.modalData.customerId) {
        const customer = state.customers.find(c => c.id === state.modalData.customerId);
        if (customer && Array.isArray(customer.phones) && customer.phones.length > 0) {
          selectReceiptPhone(customer.phones[0], customer.id);
        }
      }
      renderReceiptPhotoPreviews();
    }, 100);
  } else if (state.activeModal === 'ad') {
    setTimeout(() => {
      initAdFunding(state.modalData || {});
      // If editing, select the page to populate customer
      const adData = state.modalData || {};
      if (adData.pageId) {
        const preserveFunding = state.modalData !== null; // keep existing allocations during edit init
        selectAdPage(adData.pageId, preserveFunding);
        // If there's already a customer, select it
        if (adData.customerId) {
          selectAdCustomer(adData.customerId, true);
        }
      }
      // Initialize payment status UI (default to 'paid' for new ads)
      const initialPaymentStatus = adData.paymentStatus || 'paid';
      setAdPaymentStatus(initialPaymentStatus);
      // Render funding list right away so the user always sees guidance / first allocation row
      renderAdFundingList();
      updateAdLocalAmount();
      refreshAdFundingSummary();
      renderAdPhotoPreviews();
      // Initialize financial details for unpaid flows
      if (initialPaymentStatus !== 'paid') {
        updateAdUnpaidTotals();
      }
    }, 100);
  }
  
  const form = document.getElementById('modal-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await handleModalSubmit();
      } catch (err) {
        console.error('Modal submit error:', err);
        showNotification('Error', 'Failed to save changes', 'error');
      }
    });
  }
}

async function handleModalSubmit() {
  const isEdit = state.modalData !== null;
  
  switch (state.activeModal) {
    case 'change-password': {
      if (!state.currentUser?.id) {
        showNotification('Error', 'Not logged in', 'error');
        return;
      }

      const currentPw = String(document.getElementById('cp-current')?.value || '');
      const newPw = String(document.getElementById('cp-new')?.value || '');
      const confirmPw = String(document.getElementById('cp-confirm')?.value || '');

      if (!currentPw) {
        showNotification('Validation', 'Current password is required', 'error');
        return;
      }
      if (!newPw || newPw.length < 8) {
        showNotification('Validation', 'Password must be at least 8 characters', 'error');
        return;
      }
      if (newPw !== confirmPw) {
        showNotification('Validation', 'Passwords do not match', 'error');
        return;
      }

      if (isServerModeEnabled()) {
        try {
          await apiChangePassword(currentPw, newPw);
          showNotification('Success', 'Password changed successfully', 'success');
        } catch (e) {
          showNotification('Error', e.message || 'Failed to change password', 'error');
          return;
        }
        break;
      }

      // Local mode
      const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id) || state.currentUser;
      if (!user) {
        showNotification('Error', 'User not found', 'error');
        return;
      }

      let ok = false;
      if (user.passwordHash && user.salt) {
        const algo = user.passwordAlgo || 'sha256';
        const iterations = user.passwordIterations || null;
        ok = await Security.verifyPassword(currentPw, user.passwordHash, user.salt, algo, iterations);
      } else if (user.password) {
        ok = user.password === currentPw;
      }

      if (!ok) {
        showNotification('Error', 'Current password is incorrect', 'error');
        addSecurityLog('password_change_bad_current', user.email || user.id);
        return;
      }

      const hashed = await Security.hashPassword(newPw, null, { algo: 'pbkdf2-sha256' });
      updateRecord(state.users, user.id, {
        passwordHash: hashed.hash,
        salt: hashed.salt,
        passwordAlgo: hashed.algo,
        passwordIterations: hashed.iterations
      });
      addSecurityLog('password_changed', user.email || user.id);
      showNotification('Success', 'Password changed successfully', 'success');
      break;
    }
    case 'customer':
      // Collect all phone numbers
      const phoneInputs = document.querySelectorAll('.customer-phone');
      const phones = Array.from(phoneInputs).map(input => input.value.trim()).filter(p => p);
      
      // Check for duplicate phone numbers with other customers
      const currentCustomerId = isEdit ? state.modalData.id : null;
      const duplicatePhone = checkDuplicatePhone(phones, currentCustomerId);
      if (duplicatePhone) {
        showNotification('Duplicate Phone Number', `The phone number "${duplicatePhone.phone}" is already linked to customer "${duplicatePhone.customerName}". Please use a different phone number.`, 'error');
        return; // Stop here, don't close modal
      }
      
      // Collect all profile links
      const linkInputs = document.querySelectorAll('.customer-link');
      const profileLinks = Array.from(linkInputs).map(input => input.value.trim()).filter(l => l);
      
      // Get join date
      const joinDateValue = document.getElementById('customer-joindate').value;
      const joinDate = joinDateValue ? new Date(joinDateValue).toISOString() : new Date().toISOString();
      
      if (isEdit) {
        updateRecord(state.customers, state.modalData.id, {
          name: document.getElementById('customer-name').value,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        });
        showNotification('Updated', 'Customer updated successfully', 'success');
      } else {
        const customer = {
          id: generateId('cust'),
          name: document.getElementById('customer-name').value,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        };
        addRecord(state.customers, customer);
        showNotification('Success', 'Customer added successfully', 'success');
      }
      break;
    case 'ad':
      try {
      const paymentStatus = document.getElementById('ad-payment-status')?.value || 'paid';
      const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
      const adLinkInputs = Array.from(document.querySelectorAll('.ad-link-input')).map(i => (i.value || '').trim()).filter(Boolean);
      
      // Get amount based on payment status
      let amountUSD = 0;
      let collectionPayments = [];
      if (paymentStatus === 'paid') {
        // For paid ads, calculate amount from receipt allocations planned spend
        const allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0);
        amountUSD = allocations.reduce((sum, a) => sum + parseFloat(a.amountUSD), 0);
      } else {
        // Use financial details (R2 totals) for Not Paid / Won't Pay
        collectionPayments = getReceiptPaymentData();
        const totals = getPaymentTotalsFromDom();
        amountUSD = totals.totalR2;
      }
      
      let exchangeRate = parseFloat(document.getElementById('ad-rate')?.value || state.defaultExchangeRate);
      const isPaid = paymentStatus === 'paid';
      const isReceived = document.getElementById('ad-received')?.checked || false;
      const spentUSD = parseFloat(document.getElementById('ad-spent')?.value) || undefined;
      const extraTime = parseInt(document.getElementById('ad-extra-time')?.value) || undefined;
      const startDate = document.getElementById('ad-start-date')?.value;
      const endDate = document.getElementById('ad-end-date')?.value;
      const days = parseInt(document.getElementById('ad-days')?.value) || undefined;
      
      // Get page ID
      const pageId = document.getElementById('ad-page')?.value || '';
      if (!pageId) {
        showNotification('Error', 'Please select a page', 'error');
        return;
      }
      
      // Get customer ID from searchable dropdown hidden field
      const customerId = document.getElementById('ad-customer-id')?.value;
      if (!customerId) {
        showNotification('Error', 'Please select a customer', 'error');
        return;
      }

      // Normalize amount for unpaid flows; paid flows rely on receipt allocations
      if (paymentStatus !== 'paid' && !Number.isFinite(amountUSD)) {
        amountUSD = 0;
      }

      // Validate funding allocations (only required when paid)
      let allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0)
        .map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) }));

      if (isPaid && allocations.length === 0) {
        showNotification('Validation', 'Please link at least one receipt to fund this ad.', 'error');
        return;
      }

      // Planned spend vs receipt remaining check (only when paid)
      if (isPaid) {
        // Sum allocations per receipt (prevents over-allocation if the same receipt is selected twice).
        const totalsByReceipt = new Map();
        let totalAllocated = 0;
        for (const alloc of allocations) {
          const rid = String(alloc.receiptId || '');
          if (!rid) continue;
          const allocAmount = parseFloat(alloc.amountUSD) || 0;
          totalsByReceipt.set(rid, (totalsByReceipt.get(rid) || 0) + allocAmount);
          totalAllocated += allocAmount;
        }

        // Validate total allocations make sense (should be > 0)
        if (totalAllocated <= 0) {
          showNotification('Validation', 'Total allocation amount must be greater than zero.', 'error');
          return;
        }

        // Set amountUSD from allocations total for paid ads (ensures consistency)
        amountUSD = totalAllocated;

        for (const [receiptId, plannedTotal] of totalsByReceipt.entries()) {
          const receipt = state.receipts.find(r => String(r.id) === String(receiptId));
          if (!receipt) {
            showNotification('Validation', 'One of the selected receipts is missing.', 'error');
            return;
          }
          // Calculate remaining balance (total - used - transferred)
          const usageStats = getReceiptUsageStats(receipt);
          let remaining = usageStats.remainingUSD || 0;

          // If editing, add back what this ad already allocated from this receipt
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            if (existingAd?.receiptAllocations) {
              const existingAlloc = existingAd.receiptAllocations
                .filter(a => String(a.receiptId) === String(receiptId))
                .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
              remaining += existingAlloc;
            }
          }

          if (plannedTotal > remaining + 0.0001) {
            showNotification(
              'Validation',
              `Planned spend ($${plannedTotal.toFixed(2)}) exceeds available balance ($${remaining.toFixed(2)}) for receipt ${receipt.serialNumber || receipt.id}.`,
              'error'
            );
            return;
          }
        }
      } else {
        // Not paid / won't pay → no allocations are applied
        allocations = [];
      }

      // Additional validation when not paid
      if (paymentStatus === 'not_paid') {
        if (!collectionMethod) {
          showNotification('Validation', 'Please choose how payment will be collected.', 'error');
          return;
        }
        if (collectionMethod === 'driver') {
          const linkedReceiptId = document.getElementById('ad-linked-receipt-id')?.value || '';
          if (!linkedReceiptId) {
            showNotification('Validation', 'Select a pending Temporary Delivery Receipt (D#) or create one first.', 'error');
            return;
          }
          const linkedReceipt = state.receipts.find(r => r && !r._deleted && String(r.id) === String(linkedReceiptId));
          if (!linkedReceipt || !isTempDeliveryReceiptNo(linkedReceipt.tempReceiptNo)) {
            showNotification('Validation', 'Selected receipt is not a valid pending Temporary Delivery Receipt.', 'error');
            return;
          }
          if (String(linkedReceipt.customerId || '') !== String(customerId || '')) {
            showNotification('Validation', 'Selected receipt belongs to a different customer.', 'error');
            return;
          }
          const ds = String(linkedReceipt.deliveryStatus || '');
          if (ds === 'Delivered' || ds === 'Office' || ds === 'Canceled') {
            showNotification('Validation', 'Selected receipt is not pending delivery anymore. Please choose another one.', 'error');
            return;
          }
          const assignedDriver = String(linkedReceipt.deliveryPersonId || '').trim();
          // Delivery assignment must come from the receipt (single source of truth).
          if (!assignedDriver) {
            showNotification('Validation', 'This receipt has no assigned driver. Please assign a driver in the Receipt first.', 'error');
            return;
          }

          // Receipt is the source of truth for money details in this flow.
          // Do NOT use Ad financial splits; derive totals from the linked receipt.
          const debtUsd = Number(linkedReceipt.debtAmountUSD ?? linkedReceipt.amountUSD ?? 0) || 0;
          amountUSD = Number.isFinite(debtUsd) ? debtUsd : 0;
          const rRate = Number(linkedReceipt.exchangeRate || 0) || 0;
          if (rRate > 0) exchangeRate = rRate;
          collectionPayments = [];
        }
      }
      
      // Capture due amount to use from delivery receipt (Not Paid + Driver mode)
      let dueAmountToUseUSD = 0;
      let linkedDeliveryReceiptId = '';
      let dueAllocations = [];
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver') {
        linkedDeliveryReceiptId = document.getElementById('ad-linked-receipt-id')?.value || '';
        const dueInput = document.getElementById('ad-due-amount-to-use');
        if (dueInput && linkedDeliveryReceiptId) {
          dueAmountToUseUSD = parseFloat(dueInput.value) || 0;
          
          // Validate: check if the amount exceeds available credit
          const dueUsage = getDeliveryReceiptDueUsage(linkedDeliveryReceiptId);
          const availableUSD = dueUsage.remainingDueUSD;
          
          // If editing an existing ad, add back what this ad already used
          let currentAdUsage = 0;
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            if (existingAd) {
              if (Array.isArray(existingAd.dueAllocations)) {
                currentAdUsage = existingAd.dueAllocations
                  .filter(a => String(a.receiptId) === String(linkedDeliveryReceiptId))
                  .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
              } else if (existingAd.dueAmountToUseUSD > 0 && String(existingAd.linkedDeliveryReceiptId) === String(linkedDeliveryReceiptId)) {
                currentAdUsage = existingAd.dueAmountToUseUSD;
              }
            }
          }
          
          const effectiveAvailable = availableUSD + currentAdUsage;
          
          if (dueAmountToUseUSD > effectiveAvailable + 0.01) {
            showNotification(
              'Validation',
              `Due credit spend ($${dueAmountToUseUSD.toFixed(2)}) exceeds available ($${effectiveAvailable.toFixed(2)}).`,
              'error'
            );
            return;
          }
          
          // Create due allocation
          if (dueAmountToUseUSD > 0) {
            dueAllocations.push({
              receiptId: linkedDeliveryReceiptId,
              amountUSD: dueAmountToUseUSD
            });
          }
        }
      }
      
      // Capture merged paid receipt allocations (if enabled in Not Paid + Driver mode)
      let mergedAllocations = [];
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver' && state.tempMergeFunding?.enabled) {
        mergedAllocations = (state.tempMergeFunding.allocations || [])
          .filter(a => a.receiptId && parseFloat(a.amountUSD) > 0)
          .map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) }));
        
        // Validate merged allocations don't exceed receipt remaining
        for (const alloc of mergedAllocations) {
          const receipt = state.receipts.find(r => String(r.id) === String(alloc.receiptId));
          if (!receipt) {
            showNotification('Validation', 'One of the merged receipts is missing.', 'error');
            return;
          }
          const usageStats = getReceiptUsageStats(receipt);
          const remaining = usageStats.remainingUSD || 0;
          if (alloc.amountUSD > remaining + 0.0001) {
            showNotification(
              'Validation',
              `Merged spend ($${alloc.amountUSD.toFixed(2)}) exceeds available balance ($${remaining.toFixed(2)}) for receipt ${receipt.serialNumber || receipt.id}.`,
              'error'
            );
            return;
          }
        }
      }
      
      // Combine allocations: merged paid receipts for Not Paid + Driver mode
      // For paid mode, use regular allocations
      const finalAllocations = isPaid ? allocations : mergedAllocations;
      
      // For Not Paid + Driver mode, update amountUSD to reflect total from due + merged allocations
      // This ensures the ad credit shows the correct amount, not the full receipt amount
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver') {
        const mergedTotal = mergedAllocations.reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
        amountUSD = dueAmountToUseUSD + mergedTotal;
      }
      
      const adUpdates = {
        customerId: customerId,
        pageId: pageId,
        amountUSD,
        exchangeRate,
        amountLocal: amountUSD * exchangeRate,
        paymentMethod: (isPaid ? '' : (collectionPayments[0]?.method || '')) || '',
        status: state.modalData?.status || 'Active',
        // If Not Paid + Driver AND linked to a temp delivery receipt, the delivery is tracked on the receipt (not on the ad),
        // so we keep the ad out of the Delivery dashboard to avoid duplicates.
        deliveryStatus: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? 'Office' : (state.modalData?.deliveryStatus || 'Office'),
        deliveryPersonId: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? '' : (state.modalData?.deliveryPersonId || ''),
        receiptId: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? linkedDeliveryReceiptId : (state.modalData?.receiptId || ''),
        paymentStatus,
        collectionMethod,
        adLinks: adLinkInputs,
        adLink: adLinkInputs[0] || '',
        adPhotos: state.tempAdPhotos || [],
        collectionPayments: (paymentStatus === 'paid') ? [] : collectionPayments,
        days,
        isPaid,
        isReceivedInOffice: isReceived,
        spentUSD,
        extraTimeMinutes: extraTime,
        startDate: startDate ? new Date(startDate).toISOString() : new Date().toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : new Date().toISOString(),
        receiptAllocations: finalAllocations,
        receiptIds: finalAllocations.map(a => a.receiptId),
        fundingReceiptId: finalAllocations[0]?.receiptId || '',
        // Due amount fields for Not Paid + Driver mode (stored in USD like paid allocations)
        dueAmountToUseUSD: dueAmountToUseUSD,
        dueAllocations: dueAllocations,
        linkedDeliveryReceiptId: linkedDeliveryReceiptId,
        hasMergedPaidFunds: mergedAllocations.length > 0,
        mergedPaidAllocations: mergedAllocations
      };
      
      if (isPaid && (!state.modalData || !state.modalData.collectionDate)) {
        adUpdates.collectionDate = new Date().toISOString();
      }
      
      if (isEdit) {
        // Track changes for edit history
        const oldAd = state.modalData;
        const changes = [];
        
        // Fields to track for changes
        const fieldsToTrack = [
          { key: 'customerId', label: 'Customer', format: (v) => state.customers.find(c => c.id === v)?.name || v },
          { key: 'pageId', label: 'Page', format: (v) => state.pages.find(p => p.id === v)?.name || v },
          { key: 'amountUSD', label: 'Amount (USD)', format: (v) => `$${parseFloat(v || 0).toFixed(2)}` },
          { key: 'amountLocal', label: 'Amount (LYD)', format: (v) => `${parseFloat(v || 0).toFixed(2)} LYD` },
          { key: 'exchangeRate', label: 'Exchange Rate', format: (v) => parseFloat(v || 0).toFixed(2) },
          { key: 'paymentStatus', label: 'Payment Status', format: (v) => v || 'paid' },
          { key: 'deliveryStatus', label: 'Delivery Status', format: (v) => v || 'Office' },
          { key: 'status', label: 'Ad Status', format: (v) => v || 'Active' },
          { key: 'startDate', label: 'Start Date', format: (v) => v ? new Date(v).toLocaleDateString() : 'N/A' },
          { key: 'endDate', label: 'End Date', format: (v) => v ? new Date(v).toLocaleDateString() : 'N/A' }
        ];
        
        fieldsToTrack.forEach(field => {
          const oldVal = oldAd[field.key];
          const newVal = adUpdates[field.key];
          if (String(oldVal || '') !== String(newVal || '')) {
            changes.push({
              field: field.label,
              from: field.format(oldVal),
              to: field.format(newVal)
            });
          }
        });
        
        // Track receipt allocations changes
        const oldAllocations = oldAd.receiptAllocations || [];
        const newAllocations = allocations || [];
        if (JSON.stringify(oldAllocations) !== JSON.stringify(newAllocations)) {
          changes.push({
            field: 'Receipt Funding',
            from: `${oldAllocations.length} allocation(s) • $${oldAllocations.reduce((s, a) => s + parseFloat(a.amountUSD || 0), 0).toFixed(2)}`,
            to: `${newAllocations.length} allocation(s) • $${newAllocations.reduce((s, a) => s + parseFloat(a.amountUSD || 0), 0).toFixed(2)}`
          });
        }
        
        // Track ad links changes
        const oldLinks = oldAd.adLinks || (oldAd.adLink ? [oldAd.adLink] : []);
        const newLinks = adLinkInputs || [];
        if (JSON.stringify(oldLinks) !== JSON.stringify(newLinks)) {
          changes.push({
            field: 'Ad Links',
            from: `${oldLinks.length} link(s)`,
            to: `${newLinks.length} link(s)`
          });
        }
        
        // Add to edit history if there are changes
        if (changes.length > 0) {
          const editHistory = oldAd.editHistory || [];
          editHistory.push({
            editedAt: new Date().toISOString(),
            editedBy: state.currentUser?.name || 'Unknown',
            changes: changes
          });
          adUpdates.editHistory = editHistory;
          adUpdates.editCount = editHistory.length;
          adUpdates.updatedAt = new Date().toISOString();
        } else {
          adUpdates.editHistory = oldAd.editHistory || [];
          adUpdates.editCount = oldAd.editCount || 0;
        }
        
        updateRecord(state.ads, state.modalData.id, adUpdates);
        showNotification('Updated', 'Ad updated successfully', 'success');
        addLog('update', 'ad', state.modalData.id, `Updated ad with ${allocations.length} receipt link(s)`);
      } else {
        const ad = {
          id: generateId('ad'),
          recordType: 'ad',
          creatorId: state.currentUser?.id || '',
          createdAt: new Date().toISOString(),
          topUps: [],
          ...adUpdates
        };
        addRecord(state.ads, ad);
        showNotification('Success', 'Ad created successfully', 'success');
        addLog('create', 'ad', ad.id, `Created ad with ${allocations.length} receipt link(s)`);
        
        // Log receipt usage for each allocation
        if (isPaid && allocations.length > 0) {
          for (const alloc of allocations) {
            addAuditLog('receipt', alloc.receiptId, 'usage', `Ad ${ad.id} allocated $${alloc.amountUSD.toFixed(2)}`, {
              adId: ad.id,
              amountUSD: alloc.amountUSD,
              receiptId: alloc.receiptId
            });
          }
        }
      }
      
      // Clear temp state
      state.tempAdFunding = { allocations: [] };
      state.tempAdPhotos = [];
      
      // Close modal
      closeModal();
      } catch (error) {
        console.error('Error saving ad:', error);
        showNotification('Error', `Failed to save ad: ${error.message}`, 'error');
      }
      break;
    case 'user':
      const isAdminEditor = isCurrentUserAdmin();
      const editingId = state.modalData?.id;
      const isSelfEdit = !!(isEdit && editingId && String(state.currentUser?.id || '') === String(editingId));
      if (!isAdminEditor && !isSelfEdit) {
        showNotification('Access Denied', state.language === 'ar' ? 'إدارة المستخدمين للأدمن فقط' : 'Admin only', 'error');
        return;
      }

      const roleEl = document.getElementById('user-role');
      let userRole = Security.sanitizeInput((roleEl ? roleEl.value : (state.modalData?.role || '')), { maxLength: 20 });
      if (!isAdminEditor && isEdit) userRole = state.modalData?.role || userRole;
      const userName = Security.sanitizeInput(document.getElementById('user-name').value, { maxLength: 100 });
      const userEmail = Security.sanitizeInput(document.getElementById('user-email').value, { maxLength: 120 }).toLowerCase();

      if (!Security.isValidEmail(userEmail)) {
        showNotification('Validation Error', 'Please enter a valid email address', 'error');
        return;
      }
      
      // Get default permissions based on role
      const getDefaultPermissions = (role) => {
        switch (role) {
          case 'Admin':
            return {}; // Admins get all permissions automatically
          case 'Delivery':
            return PERMISSION_TEMPLATES.deliveryDriver.permissions;
          case 'Employee':
            return PERMISSION_TEMPLATES.salesAgent.permissions;
          default:
            return PERMISSION_TEMPLATES.viewer.permissions;
        }
      };
      
      // SERVER MODE: users are managed by backend (Admin only)
      if (isServerModeEnabled()) {
        if (!isAdminEditor) {
          showNotification('Access Denied', state.language === 'ar' ? 'هذه العملية للأدمن فقط' : 'Admin only', 'error');
          return;
        }
      if (isEdit) {
          const payload = {
            name: userName,
            email: userEmail,
          role: userRole
        };
        const newPassword = document.getElementById('user-password').value;
          if (newPassword) {
            if (String(newPassword).length < 8) {
              showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
              return;
            }
            payload.password = newPassword;
          }

          // Role-based permissions defaults
          const oldRole = state.modalData.role;
          if (oldRole !== userRole) {
            if (userRole === 'Admin') {
              payload.permissions = {};
            } else if (oldRole === 'Admin') {
              payload.permissions = getDefaultPermissions(userRole);
            }
          }

          const updated = await apiUpdateUser(state.modalData.id, payload);
          const idx = state.users.findIndex(u => u.id === state.modalData.id);
          if (idx !== -1 && updated) {
            state.users[idx] = { ...state.users[idx], ...updated, _lastModified: Date.now(), _deleted: false };
            markCollectionDirty('users');
          }
          saveState();
          showNotification('Updated', 'User updated successfully', 'success');
        } else {
          const rawPassword = document.getElementById('user-password').value;
          if (!rawPassword || String(rawPassword).length < 8) {
            showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
            return;
          }

          const payload = {
            name: userName,
            email: userEmail,
            password: rawPassword,
            role: userRole,
            permissions: getDefaultPermissions(userRole)
          };

          const created = await apiCreateUser(payload);
          if (created?.id) {
            state.users.unshift({ ...created, _lastModified: Date.now(), _deleted: false });
            markCollectionDirty('users');
            saveState();
            showNotification('Success', 'User added successfully', 'success');

            if (userRole !== 'Admin') {
              setTimeout(() => showPermissionsModal(created.id), 500);
            }
          } else {
            showNotification('Error', 'Failed to create user', 'error');
          }
        }
        break;
      }
      
      if (isEdit) {
        const updates = {
          name: userName,
          email: userEmail
        };
        if (isAdminEditor) {
          updates.role = userRole;
        }
        const newPassword = document.getElementById('user-password').value;
        if (newPassword) {
          if (String(newPassword).length < 8) {
            showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
            return;
          }
          const hashed = await Security.hashPassword(newPassword, null, { algo: 'pbkdf2-sha256' });
          updates.passwordHash = hashed.hash;
          updates.salt = hashed.salt;
          updates.passwordAlgo = hashed.algo;
          updates.passwordIterations = hashed.iterations;
          // Never store plaintext
          delete updates.password;
        }
        
        // If role changed to Admin, clear custom permissions (they get all by default)
        // If role changed from Admin, set default permissions
        if (isAdminEditor) {
        const oldRole = state.modalData.role;
        if (oldRole !== userRole) {
          if (userRole === 'Admin') {
            updates.permissions = {};
          } else if (oldRole === 'Admin') {
            updates.permissions = getDefaultPermissions(userRole);
            }
          }
        }
        
        updateRecord(state.users, state.modalData.id, updates);
        showNotification('Updated', 'User updated successfully', 'success');
      } else {
        if (!isAdminEditor) {
          showNotification('Access Denied', state.language === 'ar' ? 'إنشاء المستخدمين للأدمن فقط' : 'Admin only', 'error');
          return;
        }
        const rawPassword = document.getElementById('user-password').value;
        if (!rawPassword || String(rawPassword).length < 8) {
          showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
          return;
        }
        const hashed = await Security.hashPassword(rawPassword, null, { algo: 'pbkdf2-sha256' });
        const user = {
          id: generateId('user'),
          name: userName,
          email: userEmail,
          passwordHash: hashed.hash,
          salt: hashed.salt,
          passwordAlgo: hashed.algo,
          passwordIterations: hashed.iterations,
          role: userRole,
          permissions: getDefaultPermissions(userRole)
        };
        addRecord(state.users, user);
        showNotification('Success', 'User added successfully', 'success');
        
        // Show permission modal for non-admin users
        if (userRole !== 'Admin') {
          setTimeout(() => {
            showPermissionsModal(user.id);
          }, 500);
        }
      }
      break;
    case 'page':
      // Get selected customer IDs
      const selectedCustomers = Array.from(document.querySelectorAll('.page-customer-item'))
        .map(item => item.getAttribute('data-customer-id'));
      
      // Validate at least one customer
      if (selectedCustomers.length === 0) {
        showNotification('Validation Error', 'Please select at least one customer to link this page', 'error');
        return;
      }
      
      if (isEdit) {
        updateRecord(state.pages, state.modalData.id, {
          name: document.getElementById('page-name').value,
          category: document.getElementById('page-category').value,
          customerIds: selectedCustomers
        });
        showNotification('Updated', 'Page updated successfully', 'success');
        addLog('update', 'page', state.modalData.id, `Updated page: ${document.getElementById('page-name').value}`);
      } else {
        const page = {
          id: generateId('page'),
          name: document.getElementById('page-name').value,
          category: document.getElementById('page-category').value,
          customerIds: selectedCustomers,
          createdAt: new Date().toISOString(),
          _lastModified: Date.now(),
          _deleted: false
        };
        addRecord(state.pages, page);
        showNotification('Success', 'Page added successfully', 'success');
        addLog('create', 'page', page.id, `Created page: ${page.name} linked to ${selectedCustomers.length} customer(s)`);
      }
      break;
    case 'receipt':
      const receiptAmountEl = document.getElementById('receipt-amount');
      const receiptRateEl = document.getElementById('receipt-rate');
      const receiptFeeEl = document.getElementById('receipt-fee');
      const receiptDiscountEl = document.getElementById('receipt-discount');
      if (!receiptAmountEl || !receiptRateEl) {
        showNotification('Error', 'Receipt form elements not found', 'error');
        return;
      }
      const receiptAmountUSD = parseFloat(receiptAmountEl.value);
      const receiptRate = parseFloat(receiptRateEl.value);
      const officeFee = parseFloat(receiptFeeEl?.value || '0') || 0;
      const discount = parseFloat(receiptDiscountEl?.value || '0') || 0;
      const localAmount = (receiptAmountUSD * receiptRate) + officeFee - discount;
      const receiptPaid = document.getElementById('receipt-paid').checked;
      const receiptOffice = document.getElementById('receipt-office').checked;
      const receiptImageInput = document.getElementById('receipt-image');
      const receiptImage = receiptImageInput?.dataset.imageData || receiptData.receiptImage || '';
      const receiptStartDate = document.getElementById('receipt-start-date').value;
      const receiptEndDate = document.getElementById('receipt-end-date').value;
      
      // Get customer ID from searchable dropdown hidden field
      const receiptCustomerId = document.getElementById('receipt-customer-id').value;
      if (!receiptCustomerId) {
        showNotification('Error', 'Please select a customer', 'error');
        return;
      }
      
      // Validate serial number: if editing and old receipt had a serial, new serial cannot be empty
      const newSerialNumber = (document.getElementById('receipt-serial').value || '').trim();
      const oldSerialNumber = isEdit ? (state.modalData?.serialNumber || '').trim() : '';
      
      if (isEdit && oldSerialNumber && !newSerialNumber) {
        showNotification('Validation Error', state.language === 'ar' ? 'لا يمكن حذف رقم الوصل الموجود' : 'Cannot remove existing receipt serial number. Please enter a serial number.', 'error');
        return;
      }
      
      const receiptUpdates = {
        customerId: receiptCustomerId,
        pageId: document.getElementById('receipt-page')?.value || '',
        amountUSD: receiptAmountUSD,
        exchangeRate: receiptRate,
        amountLocal: localAmount,
        paymentMethod: document.getElementById('receipt-payment').value,
        status: document.getElementById('receipt-status').value,
        isPaid: receiptPaid,
        isReceivedInOffice: receiptOffice,
        serialNumber: newSerialNumber,
        officeFee: officeFee,
        discount: discount,
        phoneNumber: document.getElementById('receipt-phone').value || '',
        adLink: document.getElementById('receipt-ad-link').value || '',
        receiptImage: receiptImage,
        startDate: receiptStartDate ? new Date(receiptStartDate).toISOString() : new Date().toISOString(),
        endDate: receiptEndDate ? new Date(receiptEndDate).toISOString() : new Date().toISOString()
      };
      
      if (receiptPaid && (!state.modalData || !state.modalData.collectionDate)) {
        receiptUpdates.collectionDate = new Date().toISOString();
      }
      
      if (isEdit) {
        updateRecord(state.receipts, state.modalData.id, receiptUpdates);
        showNotification('Updated', 'Receipt updated successfully!', 'success');
      } else {
        const receipt = {
          id: generateId('receipt'),
          recordType: 'receipt',
          creatorId: state.currentUser?.id || '',
          deliveryStatus: 'Office',
          createdAt: new Date().toISOString(),
          payments: [],
          topUps: [],
          ...receiptUpdates
        };
        addRecord(state.receipts, receipt);
        showNotification('Success', 'Receipt created successfully!', 'success');
      }
      break;
  }
  closeModal();
  render();
}

function closeModal() {
  state.activeModal = null;
  state.modalData = null;
  
  // Clear temp funding states
  state.tempAdFunding = null;
  state.tempMergeFunding = null;
  
  // Clear URL params (modal, id)
  clearUrlParams(['modal', 'id']);
  
  // Force remove ALL modals - be very aggressive
  document.querySelectorAll('#app-modal').forEach(el => {
    el.style.display = 'none';
    el.remove();
  });
  
  // Also remove any lingering modals (duplicate warning, etc.)
  const duplicateWarning = document.getElementById('duplicate-receipt-warning');
  if (duplicateWarning) {
    duplicateWarning.remove();
  }
  
  // Remove any modal overlays that might be lingering
  document.querySelectorAll('.fixed.inset-0.bg-slate-900\\/60').forEach(el => el.remove());
  
  // Force re-render to ensure UI is updated
  setTimeout(() => {
    render();
    lucide.createIcons();
  }, 50);
}

// Helper to open modal with URL tracking
function openModalWithUrl(modalType, id = null, data = {}) {
  state.activeModal = modalType;
  state.modalData = { ...data, id };
  
  // Update URL
  updateUrlParams({ modal: modalType, id: id || null });
  
  renderModal();
}

function deleteCustomer(id) {
  // Permission check
  if (!currentUserHasPermission('customers', 'delete')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف العملاء' : 'You do not have permission to delete customers', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === id);
  const customerName = customer?.name || 'Unknown';
  // Check for linked receipts/ads
  const linkedReceipts = state.receipts.filter(r => r.customerId === id && !r._deleted);
  const linkedAds = state.ads.filter(a => a.customerId === id && !a._deleted);
  let warning = `Are you sure you want to delete customer "${customerName}"?`;
  if (linkedReceipts.length > 0 || linkedAds.length > 0) {
    warning += `\n\n⚠️ WARNING: This customer has ${linkedReceipts.length} receipt(s) and ${linkedAds.length} ad(s).`;
    warning += `\n\nChoose an option:`;
    warning += `\n• OK = Delete customer AND all their receipts/ads`;
    warning += `\n• Cancel = Keep everything`;
  }
  if (confirm(warning)) {
    // Cascade delete: also delete linked receipts and ads
    linkedReceipts.forEach(receipt => {
      receipt._deleted = true;
      receipt._lastModified = getMonotonicTime();
      markCollectionDirty('receipts');
      if (isServerModeEnabled()) {
        apiDeleteEntity('receipts', receipt.id).catch(() => {});
      }
    });
    linkedAds.forEach(ad => {
      ad._deleted = true;
      ad._lastModified = getMonotonicTime();
      markCollectionDirty('ads');
      if (isServerModeEnabled()) {
        apiDeleteEntity('ads', ad.id).catch(() => {});
      }
    });
    deleteRecord(state.customers, id);
    const deletedCount = linkedReceipts.length + linkedAds.length;
    showNotification('Deleted', `Customer deleted${deletedCount > 0 ? ` along with ${deletedCount} linked record(s)` : ''}`, 'success');
    render();
  }
}

function deletePage(id) {
  // Permission check
  if (!currentUserHasPermission('pages', 'delete')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الصفحات' : 'You do not have permission to delete pages', 'error');
    return;
  }
  if (confirm('Delete this page?')) {
    deleteRecord(state.pages, id);
    showNotification('Deleted', 'Page deleted', 'success');
    render();
  }
}

function deleteReceipt(id) {
  // Permission check
  const receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'delete', receipt?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الوصولات' : 'You do not have permission to delete this receipt', 'error');
    return;
  }
  const serialNo = receipt?.serialNumber || receipt?.tempReceiptNo || receipt?.finalReceiptNo || id.slice(0, 8);
  const amountUSD = receipt?.amountUSD?.toFixed(2) || '0.00';
  // Check for linked ads
  const linkedAds = state.ads.filter(a =>
    (a.receiptId === id || a.linkedDeliveryReceiptId === id || a.fundingReceiptId === id ||
     (Array.isArray(a.receiptAllocations) && a.receiptAllocations.some(alloc => alloc.receiptId === id)) ||
     (Array.isArray(a.dueAllocations) && a.dueAllocations.some(alloc => alloc.receiptId === id)))
    && !a._deleted
  );
  let warning = `Are you sure you want to delete receipt #${serialNo} ($${amountUSD})?`;
  if (linkedAds.length > 0) {
    warning += `\n\n⚠️ WARNING: ${linkedAds.length} ad(s) are funded by this receipt. Their allocation references will be cleaned up.`;
  }
  if (confirm(warning)) {
    // Clean up allocation references in linked ads
    linkedAds.forEach(ad => {
      let changed = false;
      // Remove from receiptAllocations
      if (Array.isArray(ad.receiptAllocations)) {
        const before = ad.receiptAllocations.length;
        ad.receiptAllocations = ad.receiptAllocations.filter(alloc => alloc.receiptId !== id);
        if (ad.receiptAllocations.length !== before) changed = true;
      }
      // Remove from dueAllocations
      if (Array.isArray(ad.dueAllocations)) {
        const before = ad.dueAllocations.length;
        ad.dueAllocations = ad.dueAllocations.filter(alloc => alloc.receiptId !== id);
        if (ad.dueAllocations.length !== before) changed = true;
      }
      // Clear linked receipt references
      if (ad.receiptId === id) { ad.receiptId = ''; changed = true; }
      if (ad.linkedDeliveryReceiptId === id) { ad.linkedDeliveryReceiptId = ''; changed = true; }
      if (ad.fundingReceiptId === id) { ad.fundingReceiptId = ''; changed = true; }
      // Remove from receiptIds array
      if (Array.isArray(ad.receiptIds)) {
        const before = ad.receiptIds.length;
        ad.receiptIds = ad.receiptIds.filter(rid => rid !== id);
        if (ad.receiptIds.length !== before) changed = true;
      }
      if (changed) {
        ad._lastModified = getMonotonicTime();
        markCollectionDirty('ads');
        if (isServerModeEnabled()) {
          apiUpdateEntity('ads', ad.id, ad).catch(() => {});
        }
      }
    });
    deleteRecord(state.receipts, id);
    showNotification('Deleted', `Receipt deleted${linkedAds.length > 0 ? ` (${linkedAds.length} ad allocation(s) cleaned up)` : ''}`, 'success');
    render();
  }
}

function deleteAd(id) {
  // Permission check
  const ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'delete', ad?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الإعلانات' : 'You do not have permission to delete this ad', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === ad?.customerId);
  const customerName = customer?.name || 'Unknown';
  const amountUSD = ad?.amountUSD?.toFixed(2) || '0.00';
  const warning = `Are you sure you want to delete this ad?\n\nCustomer: ${customerName}\nAmount: $${amountUSD}\n\n⚠️ This action cannot be undone!`;
  if (confirm(warning)) {
    deleteRecord(state.ads, id);
    showNotification('Deleted', 'Ad deleted', 'success');
    render();
  }
}

// Stop Ad - Enter spent amount and return remaining to receipts/customer
function stopAd(id) {
  // Permission check
  if (!canActOnRecord('ads', 'stopAd', state.ads.find(a => a.id === id)?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإيقاف الإعلانات' : 'You do not have permission to stop ads', 'error');
    return;
  }
  
  const ad = state.ads.find(a => a.id === id);
  if (!ad) return;
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const adAmountUSD = ad.amountUSD || 0;
  const currentSpentUSD = ad.spentUSD || 0;
  const isAlreadyStopped = ad.status === 'Stopped';
  const previousRemaining = isAlreadyStopped ? (adAmountUSD - currentSpentUSD) : 0;
  
  // Calculate current remaining from receipt allocations
  let totalAllocated = 0;
  if (Array.isArray(ad.receiptAllocations)) {
    totalAllocated = ad.receiptAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
  }
  
  const modalHTML = `
    <div id="stop-ad-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-md w-full" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
              <i data-lucide="${isAlreadyStopped ? 'edit' : 'square'}" class="w-5 h-5 mr-2 text-orange-500"></i>
              ${isAlreadyStopped ? 'Edit Stop Details' : 'Stop Ad'}
            </h2>
            <button onclick="document.getElementById('stop-ad-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 space-y-4">
          <div>
            <p class="text-sm text-slate-600 dark:text-slate-400 mb-2">
              <strong>Customer:</strong> ${Security.escapeHtml(customer?.name || 'Unknown')}<br>
              <strong>Ad Amount:</strong> $${adAmountUSD.toFixed(2)}<br>
              <strong>Currently Allocated:</strong> $${totalAllocated.toFixed(2)}
              ${isAlreadyStopped && ad.stoppedAt ? `<br><strong>Stopped On:</strong> ${new Date(ad.stoppedAt).toLocaleString()}` : ''}
            </p>
          </div>
          
          ${isAlreadyStopped ? `
            <div class="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-3">
              <div class="text-xs font-medium text-orange-800 dark:text-orange-200 mb-2">Previous Entry:</div>
              <div class="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div>Spent: <span class="font-bold text-orange-600">$${currentSpentUSD.toFixed(2)}</span></div>
                <div>Remaining Returned: <span class="font-bold text-emerald-600">$${previousRemaining.toFixed(2)}</span></div>
              </div>
            </div>
          ` : ''}
          
          <div>
            <label class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Amount Spent (USD) *
            </label>
            <input 
              type="text" 
              inputmode="decimal"
              id="stop-ad-spent" 
              value="${currentSpentUSD}" 
              max="${adAmountUSD}"
              oninput="sanitizeMoneyInput(this)"
              class="w-full glass-input px-4 py-2 rounded-xl text-lg font-bold focus:ring-2 focus:ring-orange-500"
              placeholder="0.00"
            />
            <p class="text-xs text-slate-500 mt-1">${isAlreadyStopped ? 'Edit the amount spent to update the remaining balance' : 'Enter how much was actually spent on this ad'}</p>
          </div>
          
          <div id="stop-ad-calculations" class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">Ad Amount:</span>
              <span class="font-bold">$${adAmountUSD.toFixed(2)}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-slate-600 dark:text-slate-400">Amount Spent:</span>
              <span class="font-bold text-orange-600" id="stop-ad-spent-display">$${currentSpentUSD.toFixed(2)}</span>
            </div>
            <div class="border-t border-slate-200 dark:border-slate-700 pt-2 flex justify-between">
              <span class="text-sm font-medium text-emerald-600">Remaining ${isAlreadyStopped ? '(will be updated)' : '(will be returned)'}:</span>
              <span class="text-sm font-bold text-emerald-600" id="stop-ad-remaining">$${(adAmountUSD - currentSpentUSD).toFixed(2)}</span>
            </div>
          </div>
          
          <div class="flex space-x-3 pt-2">
            <button 
              onclick="document.getElementById('stop-ad-modal').remove()" 
              class="flex-1 px-4 py-3 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button 
              onclick="confirmStopAd('${id}')" 
              class="flex-1 px-4 py-3 bg-orange-600 text-white rounded-xl font-bold hover:bg-orange-700 transition-colors"
            >
              ${isAlreadyStopped ? 'Update' : 'Stop Ad'}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal
  document.getElementById('stop-ad-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons
  lucide.createIcons();
  
  // Update calculations on input
  const spentInput = document.getElementById('stop-ad-spent');
  const spentDisplay = document.getElementById('stop-ad-spent-display');
  const remainingDisplay = document.getElementById('stop-ad-remaining');
  
  if (spentInput && spentDisplay && remainingDisplay) {
    spentInput.addEventListener('input', function() {
      const spent = parseFloat(this.value) || 0;
      const remaining = Math.max(adAmountUSD - spent, 0);
      spentDisplay.textContent = '$' + spent.toFixed(2);
      remainingDisplay.textContent = '$' + remaining.toFixed(2);
    });
    
    // Focus on input
    setTimeout(() => spentInput.focus(), 100);
  }
}

function confirmStopAd(id) {
  const ad = state.ads.find(a => a.id === id);
  if (!ad) return;
  
  const spentInput = document.getElementById('stop-ad-spent');
  if (!spentInput) return;
  
  const spentUSD = parseFloat(spentInput.value) || 0;
  const adAmountUSD = ad.amountUSD || 0;
  
  if (spentUSD < 0 || spentUSD > adAmountUSD) {
    showNotification('Error', 'Spent amount must be between 0 and ad amount', 'error');
    return;
  }
  
  const isEditing = ad.status === 'Stopped';
  const previousSpentUSD = ad.spentUSD || 0;
  const previousRemainingUSD = adAmountUSD - previousSpentUSD;
  const newRemainingUSD = adAmountUSD - spentUSD;
  const remainingDifference = newRemainingUSD - previousRemainingUSD;
  
  // Update ad status and spent amount
  ad.status = 'Stopped';
  ad.spentUSD = spentUSD;
  if (!ad.stoppedAt) {
    ad.stoppedAt = new Date().toISOString();
  }
  ad.lastUpdated = new Date().toISOString();
  
  // Handle receipt allocations - adjust based on remaining difference
  if (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0) {
    const totalAllocated = ad.receiptAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        // Editing: adjust allocations based on difference
        const adjustmentRatio = Math.abs(remainingDifference) / totalAllocated;
        
        ad.receiptAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              // More remaining now - reduce allocation (return more to receipt)
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to receipt balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              // Less remaining now - increase allocation (use more from receipt)
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - used additional $${adjustmentAmount.toFixed(2)} from receipt balance`, {
                adId: ad.id,
                usedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        // First time stopping: reduce allocations proportionally
        const reductionRatio = Math.min(newRemainingUSD / totalAllocated, 1);
        
        ad.receiptAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to receipt balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      // Remove zero allocations
      ad.receiptAllocations = ad.receiptAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
  }
  
  // Handle dueAllocations - for "Not Paid + Driver" mode ads
  if (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0) {
    const totalDueAllocated = ad.dueAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalDueAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        // Editing: adjust allocations based on difference
        const adjustmentRatio = Math.abs(remainingDifference) / totalDueAllocated;
        
        ad.dueAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to delivery receipt due balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - used additional $${adjustmentAmount.toFixed(2)} from delivery receipt due balance`, {
                adId: ad.id,
                usedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        // First time stopping: reduce allocations proportionally
        const reductionRatio = Math.min(newRemainingUSD / totalDueAllocated, 1);
        
        ad.dueAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to delivery receipt due balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      // Remove zero allocations
      ad.dueAllocations = ad.dueAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
    
    // Also update the legacy dueAmountToUseUSD field to match
    ad.dueAmountToUseUSD = ad.dueAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
  } else if (ad.dueAmountToUseUSD > 0 && !isEditing && newRemainingUSD > 0) {
    // Legacy: Handle ads with dueAmountToUseUSD but no dueAllocations array
    const reductionAmount = Math.min(newRemainingUSD, ad.dueAmountToUseUSD);
    ad.dueAmountToUseUSD = Math.max(ad.dueAmountToUseUSD - reductionAmount, 0);
    
    if (ad.linkedDeliveryReceiptId) {
      addAuditLog('receipt', ad.linkedDeliveryReceiptId, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to delivery receipt due balance`, {
        adId: ad.id,
        returnedAmount: reductionAmount,
        spentAmount: spentUSD
      });
    }
  }
  
  // Handle mergedPaidAllocations - for "Not Paid + Driver" mode ads with merged paid receipts
  if (Array.isArray(ad.mergedPaidAllocations) && ad.mergedPaidAllocations.length > 0) {
    const totalMergedAllocated = ad.mergedPaidAllocations.reduce((sum, alloc) => sum + (parseFloat(alloc.amountUSD) || 0), 0);
    
    if (totalMergedAllocated > 0) {
      if (isEditing && remainingDifference !== 0) {
        const adjustmentRatio = Math.abs(remainingDifference) / totalMergedAllocated;
        
        ad.mergedPaidAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const adjustmentAmount = allocatedAmount * adjustmentRatio;
            
            if (remainingDifference > 0) {
              alloc.amountUSD = Math.max(allocatedAmount - adjustmentAmount, 0);
              addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} updated - returned additional $${adjustmentAmount.toFixed(2)} to merged receipt balance`, {
                adId: ad.id,
                returnedAmount: adjustmentAmount,
                spentAmount: spentUSD,
                previousSpent: previousSpentUSD
              });
            } else {
              alloc.amountUSD = allocatedAmount + adjustmentAmount;
            }
          }
        });
      } else if (!isEditing && newRemainingUSD > 0) {
        const reductionRatio = Math.min(newRemainingUSD / totalMergedAllocated, 1);
        
        ad.mergedPaidAllocations.forEach(alloc => {
          const receipt = state.receipts.find(r => r.id === alloc.receiptId);
          if (receipt) {
            const allocatedAmount = parseFloat(alloc.amountUSD) || 0;
            const reductionAmount = allocatedAmount * reductionRatio;
            alloc.amountUSD = Math.max(allocatedAmount - reductionAmount, 0);
            
            addAuditLog('receipt', receipt.id, 'usage', `Ad ${ad.id} stopped - returned $${reductionAmount.toFixed(2)} to merged receipt balance`, {
              adId: ad.id,
              returnedAmount: reductionAmount,
              spentAmount: spentUSD
            });
          }
        });
      }
      
      ad.mergedPaidAllocations = ad.mergedPaidAllocations.filter(alloc => (parseFloat(alloc.amountUSD) || 0) > 0);
    }
  }
  
  // Update customer balance
  const customer = state.customers.find(c => c.id === ad.customerId);
  if (customer) {
    if (isEditing && remainingDifference !== 0) {
      // Adjust customer balance by the difference
      if (customer.balance !== undefined) {
        customer.balance = (customer.balance || 0) + remainingDifference;
        updateRecord(state.customers, customer.id, customer);
      }
      addLog('update', 'customer', customer.id, `Ad stop updated - ${remainingDifference > 0 ? 'returned' : 'used'} $${Math.abs(remainingDifference).toFixed(2)} ${remainingDifference > 0 ? 'to' : 'from'} customer balance`);
    } else if (!isEditing && newRemainingUSD > 0) {
      // First time stopping: add remaining to customer balance
      if (customer.balance !== undefined) {
        customer.balance = (customer.balance || 0) + newRemainingUSD;
        updateRecord(state.customers, customer.id, customer);
      }
      addLog('update', 'customer', customer.id, `Ad stopped - returned $${newRemainingUSD.toFixed(2)} to customer balance`);
    }
  }
  
  // Save ad
  updateRecord(state.ads, ad.id, ad);
  
  // Close modal
  document.getElementById('stop-ad-modal')?.remove();
  
  // Show notification
  const actionText = isEditing ? 'updated' : 'stopped';
  const balanceText = remainingDifference !== 0 || !isEditing ? `$${Math.abs(isEditing ? remainingDifference : newRemainingUSD).toFixed(2)} ${isEditing ? (remainingDifference > 0 ? 'returned' : 'used') : 'returned'} to receipt${ad.receiptAllocations && ad.receiptAllocations.length > 1 ? 's' : ''} and customer balance` : 'No balance changes';
  showNotification(`Ad ${actionText.charAt(0).toUpperCase() + actionText.slice(1)}`, `Ad ${actionText} successfully. ${balanceText}.`, 'success');
  
  // Refresh view
  render();
  lucide.createIcons();
}

function deleteUser(id) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'حذف المستخدمين للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  if (confirm('Delete this user?')) {
    deleteRecord(state.users, id);
    render();
  }
}

function updateExchangeRate(value) {
  state.defaultExchangeRate = parseFloat(value);
  const record = {
    id: generateId('rate'),
    rate: state.defaultExchangeRate,
    date: new Date().toISOString(),
    userId: state.currentUser?.id || 'system'
  };
  addRecord(state.exchangeRateHistory, record);
  showNotification('Updated', 'Exchange rate updated', 'success');
}

function exportData() {
  // Create secure export (no plaintext secrets)
  const exportState = JSON.parse(JSON.stringify(state));
  
  // Remove sensitive data from export
  if (exportState.users) {
    exportState.users = exportState.users.map(u => {
      const copy = { ...u };
      // Never export plaintext passwords (hashed credentials are OK for restore)
      delete copy.password;
      return copy;
    });
  }
  // Wallet/subscriptions are safe to export (no secrets), but keep the structure explicit
  if (!Array.isArray(exportState.walletTransactions)) exportState.walletTransactions = [];
  if (!Array.isArray(exportState.serviceSubscriptions)) exportState.serviceSubscriptions = [];
  if (exportState.cloudConfig) {
    exportState.cloudConfig = {
      ...exportState.cloudConfig,
      apiKey: undefined // Don't export API keys
    };
  }

  // Safety: export VISIBLE records only (do not export deleted/archived items).
  // This prevents "ghost" records from reappearing after restore.
  const countVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted).length : 0);
  const countDeleted = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !!r._deleted).length : 0);
  const filterVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted) : []);

  const counts = {
    ads: { visible: countVisible(exportState.ads), deleted: countDeleted(exportState.ads) },
    receipts: { visible: countVisible(exportState.receipts), deleted: countDeleted(exportState.receipts) },
    customers: { visible: countVisible(exportState.customers), deleted: countDeleted(exportState.customers) },
    pages: { visible: countVisible(exportState.pages), deleted: countDeleted(exportState.pages) },
    users: { visible: countVisible(exportState.users), deleted: countDeleted(exportState.users) },
    exchangeRateHistory: { visible: countVisible(exportState.exchangeRateHistory), deleted: countDeleted(exportState.exchangeRateHistory) },
    logs: { visible: countVisible(exportState.logs), deleted: countDeleted(exportState.logs) },
    walletTransactions: { visible: countVisible(exportState.walletTransactions), deleted: countDeleted(exportState.walletTransactions) },
    serviceSubscriptions: { visible: countVisible(exportState.serviceSubscriptions), deleted: countDeleted(exportState.serviceSubscriptions) }
  };

  exportState.ads = filterVisible(exportState.ads);
  exportState.receipts = filterVisible(exportState.receipts);
  exportState.customers = filterVisible(exportState.customers);
  exportState.pages = filterVisible(exportState.pages);
  exportState.users = filterVisible(exportState.users);
  exportState.exchangeRateHistory = filterVisible(exportState.exchangeRateHistory);
  exportState.logs = filterVisible(exportState.logs);
  exportState.walletTransactions = filterVisible(exportState.walletTransactions);
  exportState.serviceSubscriptions = filterVisible(exportState.serviceSubscriptions);
  
  // Add export metadata
  const checksum = DataIntegrity.calculateChecksum(exportState);
  exportState._exportMetadata = {
    exportedAt: new Date().toISOString(),
    version: '3.0.1',
    source: isServerModeEnabled() ? 'server' : 'local',
    visibleOnly: true,
    counts,
    checksum
  };
  
  const dataStr = JSON.stringify(exportState, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `albayan-backup-${getTodayDateString()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  
  // Create auto backup
  createAutoBackup();
  
  addAuditLog('Export', 'system', 'Data exported successfully');
  showNotification('Exported', 'Data exported successfully', 'success');
}

function importData() {
  // In server mode, import must go through the backend (Admin only) to keep the server as source of truth.
  async function importDataToServer(sanitizedImport) {
    const role = String(state.currentUser?.role || '').toLowerCase();
    if (role !== 'admin') {
      showNotification('Not Allowed', 'Only Admins can import in server mode.', 'error');
      return;
    }

    // Safety: require a full backup structure (prevents accidental wipe from wrong JSON file)
    const requiredCollections = ['customers', 'pages', 'ads', 'receipts', 'exchangeRateHistory'];
    for (const k of requiredCollections) {
      if (!Array.isArray(sanitizedImport?.[k])) {
        showNotification(
          'Invalid Backup',
          `Backup file is missing "${k}" array. Please import a valid Albayan backup JSON (Export Backup).`,
          'error'
        );
        return;
      }
    }

    // Optional integrity check (detect corrupted/edited backups)
    const meta = (sanitizedImport && typeof sanitizedImport === 'object') ? sanitizedImport._exportMetadata : null;
    if (meta && meta.checksum) {
      try {
        const copy = JSON.parse(JSON.stringify(sanitizedImport));
        delete copy._exportMetadata;
        const actual = DataIntegrity.calculateChecksum(copy);
        if (String(actual) !== String(meta.checksum)) {
          showNotification(
            'Invalid Backup',
            'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
            'error'
          );
          return;
        }
      } catch {
        // If checksum verification itself fails, do not proceed.
        showNotification('Invalid Backup', 'Backup file integrity check failed. Please re-export and try again.', 'error');
        return;
      }
    }

    const countVisible = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !r._deleted).length : 0);
    const countDeleted = (arr) => (Array.isArray(arr) ? arr.filter(r => r && typeof r === 'object' && !!r._deleted).length : 0);
    const counts = {
      customers: { visible: countVisible(sanitizedImport.customers), deleted: countDeleted(sanitizedImport.customers) },
      pages: { visible: countVisible(sanitizedImport.pages), deleted: countDeleted(sanitizedImport.pages) },
      ads: { visible: countVisible(sanitizedImport.ads), deleted: countDeleted(sanitizedImport.ads) },
      receipts: { visible: countVisible(sanitizedImport.receipts), deleted: countDeleted(sanitizedImport.receipts) },
      exchangeRateHistory: { visible: countVisible(sanitizedImport.exchangeRateHistory), deleted: countDeleted(sanitizedImport.exchangeRateHistory) }
    };

    const ok1 = confirm(
      `SERVER IMPORT (Admin)\n\nThis will overwrite/replace server data for ALL users.\n\nBackup contains (visible / deleted):\n- Customers: ${counts.customers.visible} / ${counts.customers.deleted}\n- Pages: ${counts.pages.visible} / ${counts.pages.deleted}\n- Ads: ${counts.ads.visible} / ${counts.ads.deleted}\n- Receipts: ${counts.receipts.visible} / ${counts.receipts.deleted}\n- Exchange Rates: ${counts.exchangeRateHistory.visible} / ${counts.exchangeRateHistory.deleted}\n\nContinue?`
    );
    if (!ok1) return;
    const phrase = String(prompt('Type IMPORT to confirm (case-sensitive):') || '');
    if (phrase !== 'IMPORT') {
      showNotification('Cancelled', 'Import cancelled.', 'info');
      return;
    }

    const mapLimit = async (items, limit, worker) => {
      const arr = Array.isArray(items) ? items : [];
      const n = Math.max(1, Math.min(Number(limit) || 1, 10));
      let i = 0;
      const runners = new Array(Math.min(n, arr.length)).fill(0).map(async () => {
        while (i < arr.length) {
          const idx = i++;
          await worker(arr[idx], idx);
        }
      });
      await Promise.all(runners);
    };

    // Stable stringify for deterministic verification (sort object keys recursively)
    const stableStringify = (value) => {
      const seen = new WeakSet();
      const normalize = (v) => {
        if (v === null || v === undefined) return v;
        if (typeof v !== 'object') return v;
        if (seen.has(v)) return null;
        seen.add(v);
        if (Array.isArray(v)) return v.map(normalize);
        const out = {};
        for (const k of Object.keys(v).sort()) {
          const vv = v[k];
          if (vv === undefined) continue;
          out[k] = normalize(vv);
        }
        return out;
      };
      return JSON.stringify(normalize(value));
    };

    const applyCollectionReplace = async (collection, records) => {
      const list = Array.isArray(records) ? records.filter(r => r && typeof r === 'object') : [];
      // Strict: backup must contain explicit IDs (we do NOT generate IDs; that would break relationships)
      const idsAll = new Set();
      for (const r of list) {
        const id = String(r?.id || '').trim();
        if (!id) {
          throw new Error(`Invalid backup: "${collection}" contains a record without an id`);
        }
        if (idsAll.has(id)) {
          throw new Error(`Invalid backup: "${collection}" contains duplicate id "${id}"`);
        }
        // Normalize id back onto record (string)
        r.id = id;
        idsAll.add(id);
      }
      const deletedIds = new Set(list.filter(r => !!r._deleted).map(r => String(r.id || '')).filter(Boolean));
      const activeList = list.filter(r => !r._deleted);
      const activeIds = new Set(activeList.map(r => String(r.id || '')).filter(Boolean));

      // Delete any existing records that should NOT be visible after restore:
      // - records not present in backup at all
      // - records present in backup but marked as _deleted=true
      const existing = await apiLoadCollectionAll(collection).catch(() => []);
      const toDelete = (Array.isArray(existing) ? existing : []).filter((r) => {
        const id = String(r?.id || '');
        if (!id) return false;
        if (r?._deleted) return false; // already deleted on server
        return !idsAll.has(id) || deletedIds.has(id);
      });
      if (toDelete.length) {
        showNotification('Import', `Deleting ${toDelete.length} old ${collection} records...`, 'info');
        await mapLimit(toDelete, 5, async (rec) => {
          try {
            await apiDeleteEntity(collection, String(rec.id));
          } catch (e) {
            // 404 is fine (already gone). Anything else is a real failure: stop the import.
            if (e?.status !== 404) throw e;
          }
        });
      }

      // Restore ACTIVE backup records only (deleted records stay deleted on the server)
      let done = 0;
      const total = activeList.length;
      if (total) showNotification('Import', `Importing ${total} ${collection} records...`, 'info');
      await mapLimit(activeList, 5, async (rec) => {
        const id = String(rec.id || '');
        await apiAdminRestoreEntity(collection, id, rec);
        done++;
        if (total >= 50 && done % 50 === 0) {
          showNotification('Import', `${collection}: ${done}/${total}...`, 'info');
        }
      });

      // Verify: server visible set must match backup visible set (prevents "ghost records" coming back)
      const after = await apiLoadCollectionAll(collection).catch(() => []);
      const serverVisible = (Array.isArray(after) ? after : []).filter(r => r && r.id && !r._deleted);
      const serverVisibleIds = new Set(serverVisible.map(r => String(r.id)));
      const extraVisible = [];
      for (const id of serverVisibleIds) {
        if (!activeIds.has(id)) extraVisible.push(id);
      }
      const missingVisible = [];
      for (const id of activeIds) {
        if (!serverVisibleIds.has(id)) missingVisible.push(id);
      }
      if (extraVisible.length || missingVisible.length) {
        const extraTxt = extraVisible.length ? `Extra on server: ${extraVisible.slice(0, 10).join(', ')}${extraVisible.length > 10 ? '…' : ''}` : '';
        const missTxt = missingVisible.length ? `Missing on server: ${missingVisible.slice(0, 10).join(', ')}${missingVisible.length > 10 ? '…' : ''}` : '';
        throw new Error(`Import verification failed for "${collection}". ${[extraTxt, missTxt].filter(Boolean).join(' | ')}`);
      }

      // Deep verification: record content must match exactly by id (strongest safety check)
      const backupById = new Map(activeList.map(r => [String(r.id), r]));
      const serverById = new Map(serverVisible.map(r => [String(r.id), r]));
      const mismatched = [];
      for (const id of activeIds) {
        const b = backupById.get(id);
        const s = serverById.get(id);
        if (!b || !s) continue;
        const bStr = stableStringify(Security.sanitizeObject(b));
        const sStr = stableStringify(Security.sanitizeObject(s));
        if (bStr !== sStr) mismatched.push(id);
      }
      if (mismatched.length) {
        throw new Error(
          `Import verification failed for "${collection}": ${mismatched.length} record(s) differ from the backup (example: ${mismatched.slice(0, 5).join(', ')}${mismatched.length > 5 ? '…' : ''}).`
        );
      }
    };

    try {
      showNotification('Import', 'Starting server import...', 'info');
      // Replace core collections only (server is source of truth)
      await applyCollectionReplace('customers', sanitizedImport.customers);
      await applyCollectionReplace('pages', sanitizedImport.pages);
      await applyCollectionReplace('ads', sanitizedImport.ads);
      await applyCollectionReplace('receipts', sanitizedImport.receipts);
      await applyCollectionReplace('exchangeRateHistory', sanitizedImport.exchangeRateHistory);

      // Reload fresh server state
      await serverLoadAllData();
      saveState();
      showNotification('Imported', 'Server import completed successfully.', 'success');
      render();
    } catch (e) {
      console.error('Server import failed:', e);
      showNotification('Import Failed', e?.message || 'Server import failed', 'error');
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    
    // Validate file size (max 50MB)
    if (file.size > 50 * 1024 * 1024) {
      showNotification('Error', 'File too large. Maximum size is 50MB.', 'error');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        
        // Validate import structure
        if (!imported || typeof imported !== 'object') {
          throw new Error('Invalid data structure');
        }
        
        // Sanitize imported data
        const sanitizedImport = Security.sanitizeObject(imported);

        // Optional integrity check (detect corrupted/edited backups)
        if (sanitizedImport && typeof sanitizedImport === 'object' && sanitizedImport._exportMetadata?.checksum) {
          const copy = JSON.parse(JSON.stringify(sanitizedImport));
          delete copy._exportMetadata;
          const actual = DataIntegrity.calculateChecksum(copy);
          if (String(actual) !== String(sanitizedImport._exportMetadata.checksum)) {
            showNotification(
              'Invalid Backup',
              'Backup file integrity check failed (checksum mismatch). Please re-export a fresh backup and try again.',
              'error'
            );
            return;
          }
        }

        // Server-mode import: Admin-only and writes to backend collections
        if (isServerModeEnabled()) {
          await importDataToServer(sanitizedImport);
          return;
        }
        
        // Validate required fields exist
        const requiredArrays = ['ads', 'receipts', 'customers', 'pages', 'users', 'exchangeRateHistory', 'logs'];
        for (const arr of requiredArrays) {
          if (sanitizedImport[arr] && !Array.isArray(sanitizedImport[arr])) {
            throw new Error(`Invalid ${arr} data`);
          }
        }
        
        // Check record limits
        for (const arr of requiredArrays) {
          if (sanitizedImport[arr] && sanitizedImport[arr].length > STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION) {
            showNotification('Warning', `${arr} data truncated to ${STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION} records`, 'warning');
            sanitizedImport[arr] = sanitizedImport[arr].slice(0, STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION);
          }
        }
        
        // Apply import safely (replace data collections; keep runtime/session state)
        state.ads = Array.isArray(sanitizedImport.ads) ? sanitizedImport.ads : [];
        state.receipts = Array.isArray(sanitizedImport.receipts) ? sanitizedImport.receipts : [];
        state.customers = Array.isArray(sanitizedImport.customers) ? sanitizedImport.customers : [];
        state.pages = Array.isArray(sanitizedImport.pages) ? sanitizedImport.pages : [];
        state.users = Array.isArray(sanitizedImport.users)
          ? sanitizedImport.users.map(u => {
              const copy = { ...u };
              // Backwards compatibility: if an old backup contains plaintext `password`,
              // keep it ONLY long enough for `ensureUsersHavePasswordHashes()` to hash it,
              // then it is removed from storage.
              if (copy.passwordHash && copy.salt) {
                delete copy.password;
              }
              return copy;
            })
          : [];
        state.exchangeRateHistory = Array.isArray(sanitizedImport.exchangeRateHistory) ? sanitizedImport.exchangeRateHistory : [];
        state.logs = Array.isArray(sanitizedImport.logs) ? sanitizedImport.logs : [];
        state.walletTransactions = Array.isArray(sanitizedImport.walletTransactions) ? sanitizedImport.walletTransactions : [];
        state.serviceSubscriptions = Array.isArray(sanitizedImport.serviceSubscriptions) ? sanitizedImport.serviceSubscriptions : [];

        if (sanitizedImport.defaultExchangeRate !== undefined) {
          const rate = parseFloat(sanitizedImport.defaultExchangeRate);
          if (!Number.isNaN(rate)) state.defaultExchangeRate = rate;
        }

        // Normalize legacy receipt storage
        normalizeReceiptsFromAds();

        // Ensure passwords are hashed and metadata present
        await ensureUsersHavePasswordHashes();

        // Persist all collections to IndexedDB
        if (db) {
          await clearIndexedDBLogs();
        }
        markAllCollectionsDirty();
        await flushDirtyCollections();
        if (db) {
          await syncLogsToIndexedDB();
        }
        
        saveState();
        addAuditLog('Import', 'system', 'Data imported successfully');
        showNotification('Imported', 'Data imported and validated successfully', 'success');
        render();
      } catch (error) {
        addSecurityLog('import_error', error.message);
        showNotification('Error', 'Failed to import data: ' + error.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function clearAllData() {
  if (isServerModeEnabled()) {
    showNotification('Not Allowed', 'Clear-all is disabled in server mode. Use backend admin tools.', 'error');
    return;
  }
  if (confirm('Clear all data? This cannot be undone!')) {
    // Clear in-memory collections
    state.ads = [];
    state.receipts = [];
    state.customers = [];
    state.pages = [];
    state.users = [];
    state.exchangeRateHistory = [];
    state.logs = [];
    state.currentUser = null;
    SessionManager.destroySession();
    
    // Also clear IndexedDB stores
    if (db) {
      await clearIndexedDBLogs();
      await idbClear(DATA_STORE_NAME).catch(() => {});
      await idbClear(BACKUP_STORE_NAME).catch(() => {});
    }
    
    saveState();
    showNotification('Cleared', 'All data cleared', 'success');
    render();
  }
}

// Initialize
async function init() {
  // PERFORMANCE: Show loading screen immediately, don't wait for data
  const loadingScreen = document.getElementById('app-loading-screen');
  const loadingStatus = document.getElementById('loading-status');
  const setLoadingStatus = (msg) => {
    if (loadingStatus) loadingStatus.textContent = msg;
  };
  
  // Apply theme immediately (prevents white flash in dark mode)
  applyTheme();
  document.documentElement.setAttribute('dir', getDir());
  
  setLoadingStatus('Initializing database...');
  
  // Initialize IndexedDB for persistent audit log storage
  await initIndexedDB();

  // Opening the app directly from a local file (file://) bypasses the backend,
  // so server mode can never activate. Warn once so the user runs it via a server.
  try {
    const proto = String(window.location?.protocol || '');
    if (proto === 'file:' && !window.__albayanFileModeWarned) {
      window.__albayanFileModeWarned = true;
      try {
        showNotification(
          'Run via Server',
          'You opened Albayan from a local file (file://). For full functionality, serve it over HTTP instead (e.g. the backend at http://127.0.0.1:8000/ or "npx serve").',
          'warning'
        );
      } catch (_) {}
    }
  } catch (_) {}

  // #region agent log
  // Hypothesis H1: Security.escapeHtml does not escape quotes, which can break attribute contexts (value="...")
  if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
  try {
    const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
    if (!dbg.escapeHtmlSelfTestLogged) {
      dbg.escapeHtmlSelfTestLogged = true;
      const q = Security.escapeHtml('"');
      const a = Security.escapeHtml("'");
      const quoteEscaped = q.includes('&quot;') || q.includes('&#34;');
      const aposEscaped = a.includes('&#39;') || a.includes('&apos;');
      const rawQuoteLeft = q.includes('"');
      const rawAposLeft = a.includes("'");
        window.__albayanDebugEmit('H1', 'script.js:init', 'escapeHtml self-test', {quoteEscaped,aposEscaped,rawQuoteLeft,rawAposLeft});
    }
  } catch (_) {}
  }
  // #endregion

  // #region agent log
  // Hypothesis H-ENV: The app is being opened from a different origin/port (e.g. static server :8080),
  // so server-side telemetry endpoints aren't hit and we miss runtime evidence.
  if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
  try {
    const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
    if (!dbg.envLogged) {
      dbg.envLogged = true;
        window.__albayanDebugEmit('H-ENV', 'script.js:init', 'runtime environment', {
            protocol: String(window.location && window.location.protocol || ''),
            origin: String(window.location && window.location.origin || ''),
            host: String(window.location && window.location.host || ''),
            pathname: String(window.location && window.location.pathname || ''),
        });
    }
  } catch (_) {}
  }
  // #endregion
  
  setLoadingStatus('Loading preferences...');
  const legacyCollections = loadState();

  setLoadingStatus('Connecting to server...');
  // Detect backend (multi-user internet mode)
  const serverOk = await apiHealthCheck();
  state.serverDetected = !!serverOk;
  const override = String(state.serverModeOverride || 'auto');
  if (override === 'local') {
    state.serverMode = false;
  } else if (override === 'server') {
    state.serverMode = true;
  } else {
    state.serverMode = state.serverDetected;
  }

  if (state.serverMode) {
    // Disable legacy cloud sync in server mode (backend is the source of truth)
    if (state.cloudConfig) state.cloudConfig.enabled = false;

    // INSTANT LOAD: First load cached data from IndexedDB (shows data instantly)
    setLoadingStatus('Loading cached data...');
    const cachedCollections = loadState(); // This already loads from localStorage
    if (db) {
      try {
        // Load from IndexedDB (faster than server)
        await loadCollectionsFromStorage(cachedCollections);
      } catch (e) {
        // IndexedDB error - continue with empty state
      }
    }

    // Restore login from backend cookie session
    setLoadingStatus('Checking session...');
    const me = await apiAuthMe().catch(() => null);
    if (me) {
      state.currentUser = me;
      // Restore last page for Admin. Non-admins always land inside Albayan Manager (secret ideas hidden).
      if (String(me.role || '').toLowerCase() === 'admin') {
        state.currentView = String(state.currentView || '').trim() || 'services-hub';
      } else {
        state.currentView = getPostLoginLandingViewForUser(me);
      }
      
      // PERFORMANCE: Show UI immediately with cached data, then update from server
      setLoadingStatus('Ready!');
      
      // Render UI immediately with cached data
      render();
      
      // Check refresh throttle - prevent server overload from rapid refreshes
      if (isRefreshThrottled()) {
        console.log('[init] Refresh throttled - using cached data');
        // Still restore modal from URL
        restoreModalFromUrl();
      } else {
        // Load fresh data from server in background
        serverLoadAllData().then(() => {
          // Migrate old data formats to work with new features
          migrateOldDataFormats();
          // Re-render with fresh data
          render();
          // Restore modal from URL if needed (e.g., user refreshed with modal open)
          restoreModalFromUrl();
        }).catch((e) => {
        console.warn('Server data load failed:', e);
          // Only show warning if we have no cached data
          if (!state.ads?.length && !state.receipts?.length && !state.customers?.length) {
            showNotification('Server Warning', 'Some data failed to load. Try Refresh.', 'warning');
          }
        });
      }

      // Live sync for multi-user updates (no manual refresh)
      startServerLiveSync();
    } else {
      state.currentUser = null;
      stopServerLiveSync();
    }
  } else {
    // Offline/local mode (single-device)
    setLoadingStatus('Loading local data...');
    // Load huge data collections (IndexedDB-first), migrate legacy localStorage if needed
    await loadCollectionsFromStorage(legacyCollections);

    // Sanitize loaded data before any UI renders (prevents stored XSS from legacy data)
    await sanitizeAllCollectionsForRendering();
    
    // Migrate old data formats to work with new features
    migrateOldDataFormats();

    // Ensure user passwords are always stored hashed (no plaintext in storage)
    await ensureUsersHavePasswordHashes();

    // Restore authenticated user from sessionStorage (more secure than localStorage)
    const session = SessionManager.getSession();
    if (session?.userId) {
      state.currentUser = state.users.find(u => u.id === session.userId) || null;
    }
    // If a non-admin session exists, always land inside Albayan Manager (hide platform hub for now).
    if (state.currentUser) {
      if (String(state.currentUser.role || '').toLowerCase() === 'admin') {
        state.currentView = String(state.currentView || '').trim() || 'services-hub';
      } else {
        state.currentView = getPostLoginLandingViewForUser(state.currentUser);
      }
    }
  }
  
  // Load logs from IndexedDB and merge with localStorage logs
  if (db) {
    try {
      const idbLogs = await loadLogsFromIndexedDB();
      if (idbLogs.length > 0) {
        // Merge IndexedDB logs with localStorage logs (avoiding duplicates)
        const existingIds = new Set(state.logs.map(l => l.id));
        const newLogs = idbLogs.filter(l => !existingIds.has(l.id));
        
        if (newLogs.length > 0) {
          state.logs = [...state.logs, ...newLogs];
          // Sort by date (newest first, handle invalid dates safely)
          state.logs.sort((a, b) => {
            const dateA = new Date(a.date || 0).getTime() || 0;
            const dateB = new Date(b.date || 0).getTime() || 0;
            return dateB - dateA;
          });
          console.log(`Merged ${newLogs.length} logs from IndexedDB`);
        }
        
        // Sync all logs to IndexedDB
        await syncLogsToIndexedDB();
      } else if (state.logs.length > 0) {
        // First time: migrate localStorage logs to IndexedDB
        await syncLogsToIndexedDB();
      }
    } catch (e) {
      // IndexedDB not ready or quota exceeded
    }
  }
  
  // Theme and direction already applied at start
  setupScrollPerformanceMode();
  setupUrlRouting();
  
  // URL Routing: If user is logged in, check URL for initial view
  if (state.currentUser) {
    const urlView = getViewFromUrl();
    // Only use URL view if it's valid and user has access
    if (urlView && urlView !== 'services-hub') {
      const canAccess = isCurrentUserAdmin() || userCanAccessView(state.currentUser, urlView) || urlView === 'delivery-dashboard';
      if (canAccess && !PLATFORM_ADMIN_ONLY_VIEWS.has(urlView)) {
        state.currentView = urlView;
      }
    }
    // Update URL to match current view (in case we changed it)
    updateUrlForView(state.currentView, true); // replace, don't push
    
    // Restore modal from URL (if not in server mode - server mode restores after data loads)
    if (!isServerModeEnabled()) {
      setTimeout(() => restoreModalFromUrl(), 200);
    }
  }
  
  setLoadingStatus('Ready!');
  
  // Check for cloud sync URL parameter (with security validation)
  const params = new URLSearchParams(window.location.search);
  const connectString = params.get('sys_connect');
  if (connectString) {
    try {
      // Validate connect string length to prevent DoS
      if (connectString.length > 2000) {
        throw new Error('Connect string too long');
      }
      
      const decoded = atob(connectString);
      const config = JSON.parse(decoded);
      
      // Validate endpoint URL
      if (config.endpoint && config.apiKey) {
        const url = new URL(config.endpoint);
        // Only allow HTTPS endpoints for security
        if (url.protocol !== 'https:') {
          throw new Error('Only HTTPS endpoints are allowed');
        }
        
        state.cloudConfig = { 
          enabled: true, 
          endpoint: Security.sanitizeInput(config.endpoint, { maxLength: 500 }), 
          apiKey: config.apiKey 
        };
        showNotification('System Connected', 'Synchronizing data...', 'success');
        
        // Remove param from URL
        const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.pushState({path:newUrl},'',newUrl);
      }
    } catch (e) {
      addSecurityLog('cloud_connect_error', e.message);
      console.warn('Cloud connect error:', e.message);
    }
  }
  
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') {
      applyTheme();
      render();
    }
  });
  
  if (state.cloudConfig.enabled) {
    startCloudSync();
  }

  // Auto-backup once per day (IndexedDB only)
  if (db) {
    setInterval(() => {
      createAutoBackup().catch(() => {});
    }, STORAGE_CONFIG.AUTO_BACKUP_INTERVAL);
  }
  
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}





