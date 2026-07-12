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
    const err = new Error(state.language === 'ar' ? `محاولات دخول كثيرة جداً. الرجاء الانتظار ${minutes} دقيقة قبل المحاولة مرة أخرى.` : `Too many login attempts. Please wait ${minutes} minute(s) before trying again.`);
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
      showNotification(state.language === 'ar' ? 'محاولات كثيرة جداً' : 'Too Many Attempts', state.language === 'ar' ? `الرجاء الانتظار ${minutes} دقيقة قبل المحاولة مرة أخرى.` : `Please wait ${minutes} minute(s) before trying again.`, 'error');
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
        showNotification(state.language === 'ar' ? 'خطأ في السيرفر' : 'Server Error', state.language === 'ar' ? `فشل حفظ تغييرات المستخدم: ${e?.message || 'خطأ'}` : `Failed to save user changes: ${e?.message || 'Error'}`, 'error');
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
    // Safety cap against infinite loops. Must be high enough to load the
    // designed maximum collection size (STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION,
    // 100k) — the old flat 50 pages capped every collection at 50×300 = 15,000
    // records and silently returned only the NEWEST 15k as if complete, dropping
    // the oldest from view and understating every total.
    const _maxRecords = (typeof STORAGE_CONFIG !== 'undefined' && STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION) || 100000;
    const maxPages = Math.ceil(_maxRecords / limit) + 5;
    let partial = false;
    let lastPageFull = false;

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

        if (!Array.isArray(items) || items.length === 0) { lastPageFull = false; break; }

        for (const entity of items) {
          if (entity && entity.data) all.push(entity.data);
        }

        if (items.length < limit) { lastPageFull = false; break; }
        lastPageFull = true;
        offset += limit;
      } catch (pageError) {
        // Partial load: only accept it if it is not WORSE than what the app
        // already has. Otherwise let the error propagate so the caller's
        // keep-existing-data guard preserves the more complete local copy
        // instead of wholesale-replacing it with a truncated list.
        const existing = Array.isArray(state[collection]) ? state[collection].length : 0;
        if (all.length > 0 && all.length >= existing) {
          console.warn(`[apiLoadCollectionAll] Partial load for ${collection}: got ${all.length} items before error`, pageError?.message);
          partial = true;
          break;
        }
        throw pageError;
      }
    }

    // If we stopped because we hit the page cap while the last page was still
    // full, the server has MORE records than we fetched — do not treat this as
    // an authoritative complete load (don't cache), and warn loudly.
    if (lastPageFull && pageCount >= maxPages) {
      console.warn(`[apiLoadCollectionAll] ${collection}: hit ${maxPages}-page cap (${all.length} records) with a full final page — collection exceeds the supported maximum and was truncated.`);
      partial = true;
    }

    // Update cache only for complete loads — never persist a truncated result.
    if (!partial && _collectionCache[collection]) {
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

// Full-record update used by the delete-cascade cleanup (15-modals.js). This
// name was referenced there but never defined, so in server mode deleting a
// receipt that funded an ad crashed with a ReferenceError HALF-WAY through the
// cleanup — the receipt survived while the ad lost its funding locally.
// Delegates to apiPatchEntity, which brings retry + timeout handling.
async function apiUpdateEntity(collection, id, record) {
  return await apiPatchEntity(collection, id, record);
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
  // Retry like create/patch do — a single 20s hiccup used to silently drop a
  // deletion, letting the record resurrect from the server later.
  return await withRetry(() =>
    apiJson(`/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }, { timeoutMs: 20000 })
  , 2, 500);
}

// Soft-delete several records in ONE all-or-nothing server transaction.
// Used by cascade deletes (customer + receipts + ads + linked transfer
// receipts) so a flaky connection can never leave a cascade half-applied.
async function apiBatchDeleteEntities(items) {
  return await withRetry(() =>
    apiJson('/api/batch/delete', { method: 'POST', body: { items } }, { timeoutMs: 30000 })
  , 2, 500);
}

// Transactional whole-backup import: the server replaces every listed
// collection inside one database transaction — a failure anywhere rolls back
// everything, so the server can never be left half backup / half current.
async function apiAdminBulkImport(collections) {
  return await apiJson('/api/admin/import', { method: 'POST', body: { collections } }, { timeoutMs: 120000 });
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
    clothesProducts: Array.isArray(state.clothesProducts) ? state.clothesProducts.length : 0,
    clothesShipments: Array.isArray(state.clothesShipments) ? state.clothesShipments.length : 0,
    clothesOrders: Array.isArray(state.clothesOrders) ? state.clothesOrders.length : 0,
    clothesSettings: Array.isArray(state.clothesSettings) ? state.clothesSettings.length : 0,
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
  const collections = ['ads', 'receipts', 'customers', 'pages', 'exchangeRateHistory', 'clothesProducts', 'clothesShipments', 'clothesOrders', 'clothesSettings', 'walletTransactions', 'serviceSubscriptions'];
  const CONCURRENCY = SERVER_API.initialLoadConcurrency || 3;

  // Show loading progress
  let loadedCount = 0;
  const updateProgress = (collection) => {
    loadedCount++;
    const pct = Math.round((loadedCount / collections.length) * 100);
    // Update any loading indicator if present
    const progressEl = document.getElementById('loading-progress');
    if (progressEl) progressEl.textContent = state.language === 'ar' ? `جارٍ تحميل البيانات... ${pct}%` : `Loading data... ${pct}%`;
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

  // Authoritatively (re)seed the live-sync cursor from server-issued timestamps.
  // This is the ONLY skew-free source: the freshly-loaded arrays carry the
  // server's last_modified, so re-seeding here corrects a cursor that
  // startServerLiveSync may have estimated too high from a clock-skewed device.
  try {
    const _wm = Math.max(
      _maxLastModifiedFromArray(results.ads && results.ads.data),
      _maxLastModifiedFromArray(results.receipts && results.receipts.data),
      _maxLastModifiedFromArray(results.customers && results.customers.data),
      _maxLastModifiedFromArray(results.pages && results.pages.data),
      _maxLastModifiedFromArray(results.exchangeRateHistory && results.exchangeRateHistory.data),
      _maxLastModifiedFromArray(results.clothesProducts && results.clothesProducts.data),
      _maxLastModifiedFromArray(results.clothesShipments && results.clothesShipments.data),
      _maxLastModifiedFromArray(results.clothesOrders && results.clothesOrders.data),
      _maxLastModifiedFromArray(results.clothesSettings && results.clothesSettings.data)
    );
    if (_wm > 0 && typeof _serverLiveSync === 'object' && _serverLiveSync) {
      _serverLiveSync.serverWatermark = _wm;
      _serverLiveSync.cursor = _wm;
    }
  } catch (_) {}

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
        state.language === 'ar' ? 'وصول محدود' : 'Limited Access',
        state.language === 'ar'
          ? `حسابك لا يمكنه الوصول إلى: ${forbidden.join(', ')}. اطلب من المسؤول منح الصلاحيات.`
          : `Your account cannot access: ${forbidden.join(', ')}. Ask an Admin to grant permissions.`,
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
      state.language === 'ar' ? 'تحذير السيرفر' : 'Server Warning',
      state.language === 'ar'
        ? `فشل تحميل بعض البيانات: ${names.join(', ')}. يمكنك تجربة التحديث.`
        : `Some data failed to load: ${names.join(', ')}. You can try Refresh.`,
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

