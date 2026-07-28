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
  // NOTE: the poll loop in src/10-live-sync.js reads this ONCE when it creates
  // its setInterval (and already skips ticks while the tab is hidden, with an
  // immediate catch-up sync on visibilitychange). Failure backoff therefore
  // has to live in that loop — a dynamic getter here would never be re-read.
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
  const requestSessionIdentity = (typeof getServerSessionIdentity === 'function')
    ? getServerSessionIdentity()
    : '';
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
    // A definitive 401 during an authenticated request means cached business
    // data must not remain visible indefinitely. Login/setup failures and the
    // user's own logout request are intentionally excluded.
    if (
      resp.status === 401 &&
      state.currentUser &&
      !['/api/auth/login', '/api/auth/setup-admin', '/api/auth/logout'].includes(path) &&
      typeof handleServerAuthExpired === 'function' &&
      !serverSessionIdentityChanged(requestSessionIdentity)
    ) {
      await handleServerAuthExpired(requestSessionIdentity);
    }
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
    // Fast health check (3 second timeout). init() escalates with longer
    // timeouts on a first-ever visit — see the probe retry in src/17-init.js.
    const data = await apiJson('/api/health', { method: 'GET' }, { timeoutMs: 3000 });
    return !!data?.ok;
  } catch {
    return false;
  }
}

// Recovery path for a failed first-visit backend detection (state.serverProbeFailed).
// The login/first-run screens can offer a Retry button that calls this: one
// generous health check, then a reload so init() re-runs full mode detection.
async function retryServerDetection() {
  let ok = false;
  try {
    const data = await apiJson('/api/health', { method: 'GET' }, { timeoutMs: 8000 });
    ok = !!data?.ok;
  } catch (_) {
    ok = false;
  }
  if (ok) {
    window.location.reload();
    return true;
  }
  try {
    showNotification(
      state.language === 'ar' ? 'الخادم غير متاح' : 'Server Unreachable',
      state.language === 'ar'
        ? 'ما زال تعذّر الوصول إلى الخادم. تحقق من الاتصال ثم حاول مجدداً.'
        : 'Still unable to reach the server. Check the connection and try again.',
      'error'
    );
  } catch (_) {}
  return false;
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
    // On timeout/network error, use a previously verified in-memory session
    // when one exists. Without that cache, propagate the connectivity failure
    // so mobile startup can show Retry instead of a misleading Login screen.
    if (e?.name === 'AbortError' || e?.message?.includes('timeout')) {
      console.warn('[apiAuthMe] Timeout - using cached session');
      if (_sessionCache.user) {
        return _sessionCache.user;
      }
      throw e;
    }
    throw e;
  }
}

async function apiLogin(email, password, rememberMe = false) {
  // Check client-side rate limit cooldown first
  const cooldownCheck = isRateLimited('login');
  if (cooldownCheck.limited) {
    const minutes = Math.ceil(cooldownCheck.retryAfter / 60);
    const err = new Error(state.language === 'ar' ? `محاولات دخول كثيرة جداً. الرجاء الانتظار ${minutes} دقيقة قبل المحاولة مرة أخرى.` : `Too many login attempts. Please wait ${minutes} minute(s) before trying again.`);
    err.status = 429;
    err.retryAfter = cooldownCheck.retryAfter;
    throw err;
  }

  // rememberMe is a STRICT boolean opt-in: when true the server issues a
  // long-lived session (ALBAYAN_SESSION_REMEMBER_MS, default 30 days) instead
  // of the standard one. Older servers simply ignore the extra field.
  const payload = { email, password, rememberMe: rememberMe === true };
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

// Does the server still need its first admin? Used so the login page can offer
// setup up-front instead of only after a failed login. Never throws.
async function apiNeedsSetup() {
  try {
    const res = await apiJson('/api/auth/needs-setup', { method: 'GET' }, { timeoutMs: 8000 });
    return {
      needsSetup: res?.needsSetup === true,
      setupEnabled: res?.setupEnabled === true
    };
  } catch {
    return { needsSetup: false, setupEnabled: false };
  }
}

// First-run bootstrap: create the very first admin straight from the browser
// (replaces the shell `python -m server.create_admin` step). The server only
// honors this while zero users exist, then logs the new admin in.
async function apiSetupAdmin(name, email, password, setupToken) {
  const res = await apiJson('/api/auth/setup-admin', {
    method: 'POST',
    body: { name, email, password, setupToken }
  }, { timeoutMs: 15000 });
  return res?.user || null;
}

async function apiLogout() {
  try {
    await apiJson('/api/auth/logout', { method: 'POST', body: {} }, { timeoutMs: 12000 });
  } catch (e) {
    // Expected to fail sometimes (session already expired, network issues)
    if (ALBAYAN_DEBUG_MODE) console.warn('[apiLogout] Failed (expected if session expired):', e?.message || e);
  }
}

function getServerSessionIdentity() {
  const epoch = (typeof _serverLiveSync === 'object' && _serverLiveSync)
    ? Number(_serverLiveSync.sessionEpoch || 0)
    : 0;
  const userId = String(state.currentUser?.id || '');
  const scope = (typeof getCollectionStorageScope === 'function')
    ? String(getCollectionStorageScope() || '')
    : '';
  return `${epoch}|${userId}|${scope}`;
}

function serverSessionIdentityChanged(snapshot) {
  return String(snapshot || '') !== getServerSessionIdentity();
}

function makeSessionChangedError() {
  const error = new Error('Authenticated session changed while data was loading');
  error.code = 'SERVER_SESSION_CHANGED';
  return error;
}

// Collections synchronized through the generic collection API. Keep this one
// list shared by full loads, per-collection cursors and visibility purges so a
// newly-added collection cannot accidentally miss one of the safety paths.
const SERVER_SYNC_COLLECTIONS = Object.freeze([
  'ads', 'receipts', 'customers', 'pages', 'exchangeRateHistory',
  'clothesProducts', 'clothesShipments', 'clothesOrders', 'clothesSettings',
  'adCampaignRequests',
  'walletTransactions', 'serviceSubscriptions',
  'appSettings'
]);

// Receipt/ad photos are large base64 strings. Normal lists and live deltas
// request lightweight records and fetch the full item only when a user opens
// Photos or Edit. Old servers safely ignore the query parameter, while old
// clients keep receiving full records because the backend default is true.
const LIGHTWEIGHT_MEDIA_COLLECTIONS = new Set(['ads', 'receipts', 'adCampaignRequests']);
const ADS_STUDIO_MEDIA_TIMEOUT_MS = 90000;
// Media-carrying money writes (delivery-completion PATCH embedding the
// driver's required base64 proof photo plus existing photos, ad edits with
// adPhotos) legitimately need minutes on a weak mobile uplink (10-50KB/s on
// 3G / in-app WebViews). A fixed 20s abort made those saves deterministically
// impossible in the field, so any request body that embeds an image — or is
// simply large — gets the same 90s budget Ads Studio media already uses.
// Small bodies keep the 20s timeout everywhere (desktop behavior unchanged).
const MEDIA_BODY_SIZE_THRESHOLD_BYTES = 200 * 1024;
function mediaAwareTimeoutMs(body) {
  // Deliberately NOT JSON.stringify(body): apiFetch serializes the same body
  // again for the wire, and doubling a multi-megabyte photo payload's
  // serialization caused a real memory/CPU spike on old phones. A shallow
  // walk over string values (photos live at most a few levels deep:
  // data.photos[i], data.adPhotos[i], data.receiptImage) sums lengths and
  // spots data-URL prefixes without materializing a second copy.
  try {
    let size = 0;
    const scan = (val, depth) => {
      if (val === null || val === undefined || size > MEDIA_BODY_SIZE_THRESHOLD_BYTES) return false;
      if (typeof val === 'string') {
        size += val.length;
        return val.length > 32 && val.indexOf('data:image/') === 0;
      }
      if (depth <= 0 || typeof val !== 'object') return false;
      const values = Array.isArray(val) ? val : Object.values(val);
      for (const child of values) {
        if (scan(child, depth - 1)) return true;
      }
      return false;
    };
    if (scan(body || {}, 4) || size > MEDIA_BODY_SIZE_THRESHOLD_BYTES) {
      return ADS_STUDIO_MEDIA_TIMEOUT_MS;
    }
  } catch (_) {}
  return TIME_CONSTANTS.API_TIMEOUT_LONG_MS;
}
const INLINE_MEDIA_FIELDS_BY_COLLECTION = Object.freeze({
  ads: Object.freeze(['adPhotos', 'photos']),
  receipts: Object.freeze(['photos', 'receiptImage']),
  adCampaignRequests: Object.freeze(['creativeImages'])
});

function _inlineMediaFields(collection) {
  return INLINE_MEDIA_FIELDS_BY_COLLECTION[String(collection || '')] || [];
}

function getEntityPhotoCountHint(collection, record) {
  if (!record || typeof record !== 'object') return 0;
  const seen = new Set();
  for (const field of _inlineMediaFields(collection)) {
    const value = record[field];
    const values = Array.isArray(value) ? value : [value];
    for (const source of values) {
      if (typeof source === 'string' && source.trim()) seen.add(source.trim());
    }
  }
  if (seen.size > 0 || record._mediaOmitted !== true) return seen.size;
  const hinted = Number(record._photoCount);
  return Number.isSafeInteger(hinted) && hinted > 0 ? hinted : 0;
}

function makeLightweightMediaRecord(collection, record) {
  if (!record || typeof record !== 'object') return record;
  const lightweight = { ...record };
  const photoCount = getEntityPhotoCountHint(collection, record);
  for (const field of _inlineMediaFields(collection)) delete lightweight[field];
  if (photoCount > 0) {
    lightweight._mediaOmitted = true;
    lightweight._photoCount = photoCount;
  } else {
    delete lightweight._mediaOmitted;
    delete lightweight._photoCount;
  }
  return lightweight;
}

function isEntityMediaHydrated(collection, record) {
  if (!LIGHTWEIGHT_MEDIA_COLLECTIONS.has(String(collection || ''))) return true;
  if (!record || typeof record !== 'object') return false;
  if (record._mediaOmitted !== true) return true;
  if (getEntityPhotoCountHint(collection, record) === 0) return true;
  return _inlineMediaFields(collection).some(field => Object.prototype.hasOwnProperty.call(record, field));
}

// A same-version IndexedDB/state record may safely donate its already-loaded
// photo bodies to a lightweight response. Never do this across revisions: an
// equally-sized replacement photo would otherwise show stale bytes.
function mergeMatchingVersionInlineMedia(collection, incoming, current) {
  if (!incoming || typeof incoming !== 'object' || incoming._mediaOmitted !== true) return incoming;
  if (String(collection || '') === 'adCampaignRequests') return incoming;
  if (!current || typeof current !== 'object' || !isEntityMediaHydrated(collection, current)) return incoming;
  const incomingVersion = Number(incoming._lastModified);
  const currentVersion = Number(current._lastModified);
  if (!Number.isFinite(incomingVersion) || incomingVersion !== currentVersion) return incoming;
  const merged = { ...incoming };
  let copied = false;
  for (const field of _inlineMediaFields(collection)) {
    if (!Object.prototype.hasOwnProperty.call(current, field)) continue;
    const value = current[field];
    merged[field] = Array.isArray(value) ? value.slice() : value;
    copied = true;
  }
  if (copied) merged._mediaOmitted = false;
  return merged;
}

// A successful mutation tells us exactly which media fields changed. Reattach
// those known bytes to the lightweight response so the server does not need to
// echo the same base64 payload back over the network.
function mergeMutationInlineMedia(collection, incoming, knownRecord) {
  if (!incoming || typeof incoming !== 'object' || incoming._mediaOmitted !== true) return incoming;
  if (!knownRecord || typeof knownRecord !== 'object') return incoming;
  const merged = { ...incoming };
  let copied = false;
  for (const field of _inlineMediaFields(collection)) {
    if (!Object.prototype.hasOwnProperty.call(knownRecord, field)) continue;
    const value = knownRecord[field];
    merged[field] = Array.isArray(value) ? value.slice() : value;
    copied = true;
  }
  if (copied) merged._mediaOmitted = false;
  return merged;
}

// Capture server-issued collection watermarks BEFORE a full load starts. A
// full load spans several requests and is not one DB snapshot; seeding a delta
// cursor from the rows it happened to return can skip a write that lands after
// an early collection request. Starting the follow-up delta at these captured
// values makes every write concurrent with the snapshot visible.
async function apiGetSyncWatermarks() {
  const identity = getServerSessionIdentity();
  const payload = await apiJson('/api/sync/watermarks', { method: 'GET' }, { timeoutMs: 10000 });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const source = payload?.watermarks && typeof payload.watermarks === 'object'
    ? payload.watermarks
    : payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    const error = new Error('Invalid sync watermarks response');
    error.code = 'INVALID_SYNC_WATERMARKS';
    throw error;
  }
  const watermarks = Object.create(null);
  for (const collection of SERVER_SYNC_COLLECTIONS) {
    const raw = source[collection];
    // A forbidden/omitted collection deliberately stays at zero. If access is
    // granted later, the next delta fetch must retrieve its full visible set.
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      const error = new Error(`Invalid sync watermark for ${collection}`);
      error.code = 'INVALID_SYNC_WATERMARKS';
      throw error;
    }
    watermarks[collection] = value;
  }
  return watermarks;
}

// Cache for users list to avoid repeated API calls. It is identity-scoped:
// an Admin's full user list must never be reused by a later non-admin session.
let _usersListCache = { data: null, timestamp: 0, cacheDurationMs: 30000, identity: '' }; // 30 second cache

// Session cache to prevent logout on rapid refresh
let _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 }; // 10 second cache

async function apiListUsersForUi() {
  const identity = getServerSessionIdentity();
  // Return cached data if fresh (within 30 seconds)
  const now = Date.now();
  if (_usersListCache.identity === identity && _usersListCache.data && (now - _usersListCache.timestamp) < _usersListCache.cacheDurationMs) {
    return _usersListCache.data;
  }
  
  // Admins (and users with the users.view permission) can access the full
  // list; others get the minimal public list.
  try {
    try {
      const result = await withRetry(
        () => apiJson('/api/users', { method: 'GET' }, { timeoutMs: 10000 }), // Faster timeout
        2, 300 // Faster retry
      );
      if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
      _usersListCache = { data: result, timestamp: now, cacheDurationMs: 30000, identity };
      return result;
    } catch (e) {
      if (e?.status !== 403) throw e;
      const result = await withRetry(
        () => apiJson('/api/users/public', { method: 'GET' }, { timeoutMs: 10000 }),
        2, 300
      );
      if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
      _usersListCache = { data: result, timestamp: now, cacheDurationMs: 30000, identity };
      return result;
    }
  } catch (e) {
    // On error (either endpoint), return cached data even if stale
    if (_usersListCache.identity === identity && _usersListCache.data) {
      console.warn('[apiListUsersForUi] Using stale cache due to error');
      return _usersListCache.data;
    }
    throw e;
  }
}

// The users-list cache must never outlive a user mutation, or the next
// live-sync tick re-serves pre-edit permissions and overwrites fresh local
// state with stale data.
function invalidateUsersListCache() {
  _usersListCache = { data: null, timestamp: 0, cacheDurationMs: 30000, identity: '' };
}

// The server's audit trail. GET /api/audit enforces auditLogs.view (all rows)
// vs auditLogs.viewOwn (own rows only), so what comes back is already scoped
// to the caller — unlike the device-local state.logs trail.
async function apiListAuditLogs(limit = 500) {
  const rows = await apiJson(`/api/audit?limit=${encodeURIComponent(limit)}&offset=0`, { method: 'GET' }, { timeoutMs: 15000 });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const uid = String(r.user_id || '');
    const u = (state.users || []).find(x => x && String(x.id) === uid);
    return {
      id: String(r.id || ''),
      date: new Date(Number(r.ts) || 0).toISOString(),
      userId: uid,
      userName: u?.name || (uid ? uid : 'System'),
      action: String(r.action || ''),
      category: String(r.resource_type || 'general'),
      severity: 'info',
      description: String(r.message || ''),
      resourceId: String(r.resource_id || ''),
      metadata: (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}
    };
  });
}

async function apiCreateUser(user) {
  const res = await apiJson('/api/users', { method: 'POST', body: user }, { timeoutMs: 20000 });
  invalidateUsersListCache();
  return res;
}

async function apiUpdateUser(userId, updates) {
  const res = await apiJson(`/api/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: updates }, { timeoutMs: 20000 });
  invalidateUsersListCache();
  return res;
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
  // Permission edits are made by Admins or users.managePermissions holders;
  // the server enforces the same rule.
  if (!canManageUsersAction('managePermissions')) return;

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

// Fire all debounce-pending user updates IMMEDIATELY. Called on pagehide and
// logout: without this, closing/reloading the tab within the 700ms debounce
// silently drops a permission grant — the admin's screen keeps showing 90/90
// (saved locally) while the server row never received it.
// Uses raw fetch with keepalive so the request survives page teardown, and no
// navigation-abort signal is attached.
function flushPendingUserUpdates() {
  const inflight = [];
  try {
    for (const [uid, timer] of _serverUserUpdate.timers) {
      clearTimeout(timer);
      _serverUserUpdate.timers.delete(uid);
      const payload = _serverUserUpdate.pending.get(uid);
      _serverUserUpdate.pending.delete(uid);
      if (!payload || Object.keys(payload).length === 0) continue;
      try {
        inflight.push(fetch(`${getServerBaseUrl()}/api/users/${encodeURIComponent(uid)}`, {
          method: 'PATCH',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(() => { try { invalidateUsersListCache(); } catch (_) {} }).catch(() => {}));
      } catch (_) {}
    }
  } catch (_) {}
  return Promise.allSettled(inflight);
}

// Collection data cache for instant loading
const _collectionCache = {
  ads: { data: null, timestamp: 0, identity: '' },
  receipts: { data: null, timestamp: 0, identity: '' },
  customers: { data: null, timestamp: 0, identity: '' },
  pages: { data: null, timestamp: 0, identity: '' },
  exchangeRateHistory: { data: null, timestamp: 0, identity: '' }
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

// Cancel pending requests when the page is being unloaded (refresh/back).
// FIRST flush any debounce-pending user updates (permission grants) with
// keepalive so they are not silently lost with the page.
try {
  window.addEventListener('pagehide', () => {
    try { flushPendingUserUpdates(); } catch (_) {}
    cancelPendingRequests();
  }, { passive: true });
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

// Every entity endpoint returns the same envelope. Validate it at this single
// trust boundary before any caller can merge the payload into state. This is
// intentionally shared by list/delta/get/create/patch and the transactional
// wallet/subscription endpoints: validating only list responses left conflict
// recovery and payment refresh able to upsert poisoned relationship ids.
function validateServerEntityResponse(collection, entity, context = 'response') {
  const name = String(collection || 'entity');
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    const error = new Error(`Invalid ${name} ${context}: missing entity envelope`);
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  if (typeof entity.id !== 'string' || !Security.isValidRecordId(entity.id)) {
    const error = new Error(`Rejected unsafe ${name} ${context}: invalid entity id`);
    error.code = 'UNSAFE_RECORD_IDENTIFIER';
    throw error;
  }
  if (!entity.data || typeof entity.data !== 'object' || Array.isArray(entity.data)) {
    const error = new Error(`Invalid ${name} ${context}: missing record data`);
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const idCheck = Security.validateRecordIdentifiers(entity.data, `${name}.${context}`);
  if (!idCheck.valid) {
    const error = new Error(`Rejected unsafe ${name} ${context}: ${idCheck.error}`);
    error.code = 'UNSAFE_RECORD_IDENTIFIER';
    throw error;
  }
  if (typeof entity.data.id !== 'string' || entity.data.id !== entity.id) {
    const error = new Error(`Invalid ${name} ${context}: envelope/data id mismatch`);
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  return entity;
}

async function requestValidatedServerEntity(collection, context, loader) {
  const identity = getServerSessionIdentity();
  const entity = await loader();
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  return validateServerEntityResponse(collection, entity, context);
}

function mergeServerEntityDataById(target, indexById, entity) {
  const existingIndex = indexById.get(entity.id);
  if (existingIndex === undefined) {
    indexById.set(entity.id, target.length);
    target.push(entity.data);
    return true;
  }
  if (Number(entity.lastModified || 0) >= Number(target[existingIndex]?._lastModified || 0)) {
    target[existingIndex] = entity.data;
  }
  return false;
}

// Apply a group of already-committed server entities to local state as one
// in-memory step. Prepare and validate every item first so a malformed second
// envelope can never leave only the first item applied locally.
function applyValidatedServerEntityBatch(entries, reason = 'serverMutation') {
  const prepared = (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const collection = String(entry?.collection || '');
    if (!collection || !Array.isArray(state[collection])) {
      const error = new Error(`Invalid server mutation collection at index ${index}`);
      error.code = 'INVALID_ENTITY_RESPONSE';
      throw error;
    }
    const entity = validateServerEntityResponse(collection, entry.entity, `${reason}[${index}]`);
    return { collection, saved: Security.sanitizeObject(entity.data) };
  });

  for (const { collection, saved } of prepared) {
    const target = state[collection];
    const existingIndex = target.findIndex(row => row && String(row.id) === String(saved.id));
    if (existingIndex === -1) target.unshift(saved);
    else target[existingIndex] = saved;
    if (_collectionCache[collection]) {
      _collectionCache[collection] = { data: null, timestamp: 0, identity: '' };
    }
    if (typeof clearCollectionCorruption === 'function') clearCollectionCorruption(collection);
    markCollectionDirty(collection);
  }
  if (prepared.length > 0) {
    saveState();
    RenderQueue.schedule(reason);
  }
  return prepared.map(item => item.saved);
}

async function apiLoadCollectionAll(collection, { forceRefresh = false, includeMedia = false } = {}) {
  const identity = getServerSessionIdentity();
  const omitMedia = LIGHTWEIGHT_MEDIA_COLLECTIONS.has(String(collection || '')) && includeMedia !== true;
  const mediaMode = omitMedia ? 'thin' : 'full';
  const requestKey = `${identity}|${String(collection || '')}|${forceRefresh ? 'fresh' : 'cached'}|${mediaMode}`;
  const now = Date.now();

  // Return cached data immediately if fresh (but only for non-critical refreshes)
  const cache = _collectionCache[collection];
  if (!forceRefresh && cache && cache.identity === identity && cache.mediaMode === mediaMode && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  // Request deduplication: if there's already a pending request for this collection, wait for it
  if (_pendingRequests.has(requestKey)) {
    try {
      const shared = await _pendingRequests.get(requestKey);
      if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
      return shared;
    } catch (e) {
      // If the pending request failed, we'll try again below
      _pendingRequests.delete(requestKey);
      if (e?.code === 'SERVER_SESSION_CHANGED') throw e;
    }
  }

  // Create the actual request with timeout protection
  const requestPromise = (async () => {
    const all = [];
    const indexById = new Map();
    let beforeCreatedAt = null;
    let beforeId = '';
    const limit = SERVER_API.pageSize || 300;
    const timeoutMs = getCollectionTimeout(collection);
    let pageCount = 0;
    const currentById = new Map(
      (Array.isArray(state[collection]) ? state[collection] : [])
        .filter(record => record && record.id != null)
        .map(record => [String(record.id), record])
    );
    // Safety cap against infinite loops. Must be high enough to load the
    // designed maximum collection size (STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION,
    // 100k) — the old flat 50 pages capped every collection at 50×300 = 15,000
    // records and silently returned only the NEWEST 15k as if complete, dropping
    // the oldest from view and understating every total.
    const _maxRecords = (typeof STORAGE_CONFIG !== 'undefined' && STORAGE_CONFIG.MAX_RECORDS_PER_COLLECTION) || 100000;
    const maxPages = Math.ceil(_maxRecords / limit) + 5;
    let lastPageFull = false;

    while (pageCount < maxPages) {
      pageCount++;
      try {
        // Use retry logic for resilience against transient server errors/timeouts
        let path = `/api/collections/${encodeURIComponent(collection)}?limit=${limit}&include_deleted=true`;
        if (omitMedia) path += '&include_media=false';
        if (beforeCreatedAt !== null && beforeId) {
          path += `&before_created_at=${encodeURIComponent(String(beforeCreatedAt))}&before_id=${encodeURIComponent(beforeId)}`;
        }
        const items = await withRetry(
          () => apiJson(
            path,
            { method: 'GET' },
            { timeoutMs }
          ),
          2, // 2 retries (3 total attempts) - reduced for faster failure
          300 // 300ms base delay (faster retry)
        );
        if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();

        if (!Array.isArray(items) || items.length === 0) { lastPageFull = false; break; }

        let lastEntity = null;
        for (const rawEntity of items) {
          const entity = validateServerEntityResponse(collection, rawEntity, `list[${all.length}]`);
          entity.data = mergeMatchingVersionInlineMedia(collection, entity.data, currentById.get(String(entity.id)));
          if (String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord(collection, entity.data);
          lastEntity = entity;
          // Defensive only: keyset pages should not overlap, but a record can
          // be updated while pagination is running. Keep one ID and prefer the
          // newest server version rather than rendering duplicates.
          mergeServerEntityDataById(all, indexById, entity);
        }

        if (items.length < limit) { lastPageFull = false; break; }
        lastPageFull = true;
        const nextCreatedAt = Number(lastEntity?.createdAt);
        const nextId = String(lastEntity?.id || '');
        if (!Number.isSafeInteger(nextCreatedAt) || nextCreatedAt < 0 || !Security.isValidRecordId(nextId)) {
          const cursorError = new Error(`Invalid ${collection} full-page cursor`);
          cursorError.code = 'INCOMPLETE_COLLECTION_LOAD';
          throw cursorError;
        }
        if (nextCreatedAt === beforeCreatedAt && nextId === beforeId) {
          const cursorError = new Error(`Repeated ${collection} full-page cursor`);
          cursorError.code = 'INCOMPLETE_COLLECTION_LOAD';
          throw cursorError;
        }
        beforeCreatedAt = nextCreatedAt;
        beforeId = nextId;
      } catch (pageError) {
        // A failed later page is never authoritative, even if it happens to
        // contain more rows than the current cache. Propagate an explicit
        // incomplete result so no caller can replace/persist complete state
        // with a prefix of the server collection.
        const incompleteError = pageError instanceof Error ? pageError : new Error('Collection page failed');
        incompleteError.code = incompleteError.code || 'INCOMPLETE_COLLECTION_LOAD';
        incompleteError.collection = collection;
        incompleteError.partialCount = all.length;
        console.warn(`[apiLoadCollectionAll] Incomplete load for ${collection}: got ${all.length} items before error`, incompleteError.message);
        throw incompleteError;
      }
    }

    // If we stopped because we hit the page cap while the last page was still
    // full, the server has MORE records than we fetched — do not treat this as
    // an authoritative complete load (don't cache), and warn loudly.
    if (lastPageFull && pageCount >= maxPages) {
      console.warn(`[apiLoadCollectionAll] ${collection}: hit ${maxPages}-page cap (${all.length} records) with a full final page — collection exceeds the supported maximum and was truncated.`);
      const capError = new Error(`${collection} exceeds the supported maximum; refusing truncated data`);
      capError.code = 'INCOMPLETE_COLLECTION_LOAD';
      capError.collection = collection;
      capError.partialCount = all.length;
      throw capError;
    }

    // Reaching here proves every page completed. Only complete arrays may enter
    // the in-memory request cache or IndexedDB persistence path.
    if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
    if (_collectionCache[collection]) {
      _collectionCache[collection] = { data: all, timestamp: Date.now(), identity, mediaMode };
    }

    return all;
  })();

  // Store the pending request
  _pendingRequests.set(requestKey, requestPromise);

  try {
    const result = await requestPromise;
    if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
    return result;
  } finally {
    // Clean up pending request
    if (_pendingRequests.get(requestKey) === requestPromise) _pendingRequests.delete(requestKey);
  }
}

async function apiGetEntity(collection, id, { timeoutMs = 15000 } = {}) {
  return await requestValidatedServerEntity(collection, 'get', () =>
    apiJson(`/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'GET' }, { timeoutMs })
  );
}

const _pendingEntityMediaLoads = new Map();
// Ads Studio creative bodies are deliberately ephemeral. Keeping every opened
// campaign in state would copy base64 into IndexedDB and grow without bound on
// a reviewer device. A tiny session-scoped LRU avoids repeat downloads without
// persisting customer media.
const _transientAdCampaignMedia = new Map();
const MAX_TRANSIENT_AD_CAMPAIGN_MEDIA = 3;

function clearTransientEntityMediaCache(collections = null) {
  const names = collections === null
    ? null
    : new Set((Array.isArray(collections) ? collections : [collections]).map(String));
  for (const key of Array.from(_transientAdCampaignMedia.keys())) {
    if (names === null || names.has('adCampaignRequests')) _transientAdCampaignMedia.delete(key);
  }
}

function cacheTransientAdCampaignMedia(key, record) {
  _transientAdCampaignMedia.delete(key);
  _transientAdCampaignMedia.set(key, record);
  while (_transientAdCampaignMedia.size > MAX_TRANSIENT_AD_CAMPAIGN_MEDIA) {
    _transientAdCampaignMedia.delete(_transientAdCampaignMedia.keys().next().value);
  }
}

async function ensureEntityMediaLoaded(collection, id) {
  const name = String(collection || '');
  const safeId = String(id || '');
  const findCurrent = () => (Array.isArray(state[name]) ? state[name] : [])
    .find(record => record && !record._deleted && String(record.id) === safeId) || null;
  let current = findCurrent();
  if (!current || !LIGHTWEIGHT_MEDIA_COLLECTIONS.has(name) || isEntityMediaHydrated(name, current)) return current;
  if (!isServerModeEnabled()) return current;

  const identity = getServerSessionIdentity();
  const key = `${identity}|${name}|${safeId}`;
  if (name === 'adCampaignRequests') {
    const cached = _transientAdCampaignMedia.get(key);
    if (cached && Number(cached._lastModified) === Number(current._lastModified)) {
      // Refresh LRU order and return a detached object so callers cannot mutate
      // the cached copy while editing their local draft.
      cacheTransientAdCampaignMedia(key, cached);
      return Security.sanitizeObject(cached);
    }
  }
  if (_pendingEntityMediaLoads.has(key)) return await _pendingEntityMediaLoads.get(key);

  const request = (async () => {
    // A live delta can win while the item GET is in flight. Retry once instead
    // of replacing that newer summary with an older full response.
    for (let attempt = 0; attempt < 2; attempt++) {
      const entity = await apiGetEntity(name, safeId, { timeoutMs: name === 'adCampaignRequests' ? ADS_STUDIO_MEDIA_TIMEOUT_MS : 15000 });
      if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
      const full = entity?.data ? Security.sanitizeObject(entity.data) : null;
      const latest = findCurrent();
      if (!full || !latest || latest._deleted) return latest;
      const responseVersion = Number(full._lastModified);
      const latestVersion = Number(latest._lastModified);
      if (Number.isFinite(responseVersion) && Number.isFinite(latestVersion) && responseVersion < latestVersion) continue;

      if (name === 'adCampaignRequests') {
        cacheTransientAdCampaignMedia(key, full);
        return Security.sanitizeObject(full);
      }

      const target = state[name];
      const index = target.findIndex(record => record && String(record.id) === safeId);
      if (index === -1) return null;
      target[index] = full;
      if (_collectionCache[name]?.identity === identity && Array.isArray(_collectionCache[name].data)) {
        const cachedIndex = _collectionCache[name].data.findIndex(record => record && String(record.id) === safeId);
        if (cachedIndex !== -1) _collectionCache[name].data[cachedIndex] = full;
      }
      markCollectionDirty(name);
      saveState();
      return full;
    }
    return findCurrent();
  })();
  _pendingEntityMediaLoads.set(key, request);
  try {
    return await request;
  } finally {
    if (_pendingEntityMediaLoads.get(key) === request) _pendingEntityMediaLoads.delete(key);
  }
}

async function apiCreateEntity(collection, record) {
  const omitMedia = LIGHTWEIGHT_MEDIA_COLLECTIONS.has(String(collection || ''));
  const path = `/api/collections/${encodeURIComponent(collection)}${omitMedia ? '?include_media=false' : ''}`;
  const timeoutMs = String(collection || '') === 'adCampaignRequests' ? ADS_STUDIO_MEDIA_TIMEOUT_MS : 20000;
  const entity = await requestValidatedServerEntity(collection, 'create', () =>
    withRetry(() =>
      apiJson(path, { method: 'POST', body: { id: record.id, data: record } }, { timeoutMs })
    , 2, 500)
  );
  // Customer campaign images stay in the builder/transient LRU. Never reattach
  // them to the collection response, which is persisted to IndexedDB.
  if (String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord(collection, entity.data);
  else entity.data = mergeMutationInlineMedia(collection, entity.data, record);
  return entity;
}

// Server-authoritative money operations. These endpoints validate balance,
// catalog price/duration, permissions and idempotency inside one DB
// transaction; callers must not emulate them with generic collection writes.
async function apiWalletTransfer({ toUserId, amountMinor, currency, idempotencyKey, memo }) {
  return await requestValidatedServerEntity('walletTransactions', 'transfer', () =>
    apiJson('/api/wallet/transfers', {
      method: 'POST',
      body: { toUserId, amountMinor, currency, idempotencyKey, memo }
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS })
  );
}

async function apiWalletTopUp({ userId, amountMinor, currency, idempotencyKey, memo }) {
  return await requestValidatedServerEntity('walletTransactions', 'top-up', () =>
    apiJson('/api/wallet/top-ups', {
      method: 'POST',
      body: { userId, amountMinor, currency, idempotencyKey, memo }
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS })
  );
}

async function apiWalletReversal({ transactionId, memo }) {
  return await requestValidatedServerEntity('walletTransactions', 'reversal', () =>
    apiJson('/api/wallet/reversals', {
      method: 'POST',
      body: { transactionId, memo }
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS })
  );
}

async function apiPurchaseSubscription({ serviceId, idempotencyKey, userId }) {
  const body = { serviceId, idempotencyKey };
  if (userId) body.userId = userId;
  return await requestValidatedServerEntity('serviceSubscriptions', 'purchase', () =>
    apiJson('/api/subscriptions/purchase', {
      method: 'POST',
      body
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS })
  );
}

// Atomic receipt transfer: source deduction and target TRANSFER_IN receipt are
// committed by the server together. The caller owns the stable target id and
// idempotency key so a response-loss retry replays the same result.
async function apiTransferReceipt(payload) {
  const identity = getServerSessionIdentity();
  // A stable body/idempotency key makes a response-loss retry safe: the server
  // checks the receiptTransfer marker BEFORE the version-conflict check and
  // replays the committed result instead of moving the same balance twice.
  const response = await withRetry(() => apiJson('/api/receipts/transfers?include_media=false', {
    method: 'POST',
    body: payload
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500);
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid receipt transfer response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const sourceReceipt = validateServerEntityResponse('receipts', response.sourceReceipt, 'transfer.sourceReceipt');
  const targetReceipt = validateServerEntityResponse('receipts', response.targetReceipt, 'transfer.targetReceipt');
  const localSource = (state.receipts || []).find(row => row && String(row.id) === String(payload?.sourceReceiptId || ''));
  const localTarget = (state.receipts || []).find(row => row && String(row.id) === String(payload?.targetReceiptId || ''));
  sourceReceipt.data = mergeMutationInlineMedia('receipts', sourceReceipt.data, localSource);
  targetReceipt.data = mergeMutationInlineMedia('receipts', targetReceipt.data, localTarget);
  return {
    sourceReceipt,
    targetReceipt,
    replayed: response.replayed === true
  };
}

// Settle one unpaid receipt and every ad funded from its due/debt balance in a
// single server transaction. A receipt becoming Paid changes the meaning of
// those ad allocations, so accepting only a receipt envelope would leave the
// browser showing stale "Not Paid" ads until the next full sync.
async function apiSettleReceipt(payload) {
  const receiptId = String(payload?.receiptId || '').trim();
  if (!Security.isValidRecordId(receiptId)) throw new Error('Invalid receipt settlement id');
  const expectedLastModified = Number(payload?.expectedLastModified);
  if (!Number.isSafeInteger(expectedLastModified) || expectedLastModified < 0) {
    throw new Error('This receipt is missing its server version. Refresh and try again.');
  }
  const body = {
    expectedLastModified,
    idempotencyKey: String(payload?.idempotencyKey || '').trim(),
    data: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : {}
  };
  if (!body.idempotencyKey) throw new Error('Receipt settlement idempotency key is required');

  const identity = getServerSessionIdentity();
  // A stable body/idempotency key makes a response-loss retry safe: the server
  // replays the committed result instead of moving the same funding twice.
  const response = await withRetry(() => apiJson(
    `/api/receipts/${encodeURIComponent(receiptId)}/settle?include_media=false`,
    { method: 'POST', body },
    { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
  ), 2, 500);
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.updatedAds)) {
    const error = new Error('Invalid receipt settlement response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }

  const receipt = validateServerEntityResponse('receipts', response.receipt, 'settlement.receipt');
  const localReceipt = (state.receipts || []).find(row => row && String(row.id) === receiptId);
  // include_media=false keeps the response small. Prefer newly edited media
  // from this request over the old local copy so adding/removing a photo while
  // marking Paid is reflected immediately instead of waiting for a full sync.
  receipt.data = mergeMutationInlineMedia('receipts', receipt.data, {
    ...(localReceipt || {}),
    ...(body.data || {})
  });
  const updatedAds = response.updatedAds.map((entity, index) => {
    const validated = validateServerEntityResponse('ads', entity, `settlement.updatedAds[${index}]`);
    const localAd = (state.ads || []).find(row => row && String(row.id) === String(validated.id));
    validated.data = mergeMutationInlineMedia('ads', validated.data, localAd);
    return validated;
  });
  return {
    receipt,
    updatedAds,
    replayed: response.replayed === true
  };
}

// The exact REVERSE of apiSettleReceipt: convert a funded PAID receipt back
// into customer debt. The server migrates every linked ad's paid rows for
// this receipt into its due pool in the same transaction, so the browser must
// install the receipt AND the converted ads together — a receipt-only
// envelope would briefly show paid ads backed by an unpaid receipt.
async function apiUnsettleReceipt(payload) {
  const receiptId = String(payload?.receiptId || '').trim();
  if (!Security.isValidRecordId(receiptId)) throw new Error('Invalid receipt conversion id');
  const expectedLastModified = Number(payload?.expectedLastModified);
  if (!Number.isSafeInteger(expectedLastModified) || expectedLastModified < 0) {
    throw new Error('This receipt is missing its server version. Refresh and try again.');
  }
  const body = {
    expectedLastModified,
    idempotencyKey: String(payload?.idempotencyKey || '').trim(),
    data: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : {}
  };
  if (!body.idempotencyKey) throw new Error('Receipt conversion idempotency key is required');

  const identity = getServerSessionIdentity();
  // A stable body/idempotency key makes a response-loss retry safe: the server
  // replays the committed result instead of moving the same funding twice.
  const response = await withRetry(() => apiJson(
    `/api/receipts/${encodeURIComponent(receiptId)}/unsettle?include_media=false`,
    { method: 'POST', body },
    { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
  ), 2, 500);
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.updatedAds)) {
    const error = new Error('Invalid receipt conversion response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }

  const receipt = validateServerEntityResponse('receipts', response.receipt, 'conversion.receipt');
  const localReceipt = (state.receipts || []).find(row => row && String(row.id) === receiptId);
  receipt.data = mergeMutationInlineMedia('receipts', receipt.data, {
    ...(localReceipt || {}),
    ...(body.data || {})
  });
  const updatedAds = response.updatedAds.map((entity, index) => {
    const validated = validateServerEntityResponse('ads', entity, `conversion.updatedAds[${index}]`);
    const localAd = (state.ads || []).find(row => row && String(row.id) === String(validated.id));
    validated.data = mergeMutationInlineMedia('ads', validated.data, localAd);
    return validated;
  });
  return {
    receipt,
    updatedAds,
    replayed: response.replayed === true
  };
}

// Paid/due/merged allocations change receipt availability, so ad create/edit
// must cross one server transaction boundary rather than generic collection
// POST/PATCH calls.
async function apiMutateAd(payload) {
  const action = String(payload?.action || '');
  if (!['create', 'update'].includes(action)) throw new Error('Invalid ad mutation action');
  const identity = getServerSessionIdentity();
  // A stable body/idempotency key makes a response-loss retry safe: the server
  // checks the adFunding idempotency marker BEFORE the version-conflict check
  // and replays the committed result instead of moving the same funding twice
  // (the caller pins adId + idempotencyKey + payload per attempt, so retries
  // resend identical bytes). Bodies carrying adPhotos get the media timeout;
  // those retry once instead of twice because each retry re-uploads the whole
  // body from byte 0 and would otherwise saturate a weak uplink for minutes.
  const _mutateTimeoutMs = mediaAwareTimeoutMs(payload && payload.data);
  const response = await withRetry(() => apiJson('/api/ads/mutate?include_media=false', {
    method: 'POST',
    body: payload
  }, { timeoutMs: _mutateTimeoutMs }), _mutateTimeoutMs === ADS_STUDIO_MEDIA_TIMEOUT_MS ? 1 : 2, 500);
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid ad mutation response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const ad = validateServerEntityResponse('ads', response.ad, `${action}.ad`);
  const localAd = (state.ads || []).find(row => row && String(row.id) === String(payload?.adId || ''));
  ad.data = mergeMutationInlineMedia('ads', ad.data, { ...(localAd || {}), ...(payload?.data || {}) });
  return {
    ad,
    replayed: response.replayed === true
  };
}

// Read-only Meta Ads integration. Tokens never enter the browser: these calls
// talk only to Albayan's authenticated backend, which talks to Meta server-side.
async function apiMetaAdsStatus() {
  return await apiJson('/api/meta-ads/status', { method: 'GET' }, { timeoutMs: 15000 });
}

async function apiMetaAdsAccounts() {
  const response = await apiJson('/api/meta-ads/accounts', { method: 'GET' }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  return Array.isArray(response?.accounts) ? response.accounts : [];
}

async function apiMetaAdsForAccount(accountId, search = '') {
  const safeAccountId = String(accountId || '').replace(/^act_/, '');
  if (!/^[0-9]{1,40}$/.test(safeAccountId)) throw new Error('Invalid Meta ad-account ID');
  const query = search ? `?search=${encodeURIComponent(String(search).slice(0, 100))}` : '';
  const response = await apiJson(
    `/api/meta-ads/accounts/${encodeURIComponent(safeAccountId)}/ads${query}`,
    { method: 'GET' },
    { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
  );
  return Array.isArray(response?.ads) ? response.ads : [];
}

function validateMetaAdMutationResponse(response, context, localAd) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid Meta synchronization response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const ad = validateServerEntityResponse('ads', response.ad, context);
  ad.data = mergeMutationInlineMedia('ads', ad.data, localAd);
  return {
    ad,
    replayed: response.replayed === true,
    changes: Array.isArray(response.changes) ? response.changes : []
  };
}

async function apiLinkMetaAd(adId, metaAdId, expectedLastModified, operationId) {
  const safeAdId = String(adId || '');
  const safeMetaAdId = String(metaAdId || '');
  if (!Security.isValidRecordId(safeAdId)) throw new Error('Invalid Albayan ad ID');
  if (!/^[0-9]{1,40}$/.test(safeMetaAdId)) throw new Error('Enter a valid numeric Meta ad ID');
  const identity = getServerSessionIdentity();
  const response = await apiJson(`/api/meta-ads/ads/${encodeURIComponent(safeAdId)}/link`, {
    method: 'POST',
    body: { metaAdId: safeMetaAdId, expectedLastModified, operationId }
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const localAd = (state.ads || []).find(row => row && String(row.id) === safeAdId);
  return validateMetaAdMutationResponse(response, 'metaLink.ad', localAd);
}

async function apiSyncMetaAd(adId, expectedLastModified, operationId) {
  const safeAdId = String(adId || '');
  if (!Security.isValidRecordId(safeAdId)) throw new Error('Invalid Albayan ad ID');
  const identity = getServerSessionIdentity();
  const response = await apiJson(`/api/meta-ads/ads/${encodeURIComponent(safeAdId)}/sync`, {
    method: 'POST',
    body: { expectedLastModified, operationId }
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const localAd = (state.ads || []).find(row => row && String(row.id) === safeAdId);
  return validateMetaAdMutationResponse(response, 'metaSync.ad', localAd);
}

async function apiUnlinkMetaAd(adId, expectedLastModified, operationId) {
  const safeAdId = String(adId || '');
  if (!Security.isValidRecordId(safeAdId)) throw new Error('Invalid Albayan ad ID');
  const identity = getServerSessionIdentity();
  const response = await apiJson(`/api/meta-ads/ads/${encodeURIComponent(safeAdId)}/unlink`, {
    method: 'POST',
    body: { expectedLastModified, operationId }
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const localAd = (state.ads || []).find(row => row && String(row.id) === safeAdId);
  return validateMetaAdMutationResponse(response, 'metaUnlink.ad', localAd);
}

async function apiSyncDueMetaAds(limit = 4) {
  const identity = getServerSessionIdentity();
  const response = await apiJson('/api/meta-ads/sync-due', {
    method: 'POST',
    body: { limit: Math.max(1, Math.min(100, Number(limit) || 20)) }
  }, { timeoutMs: 120000 });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const validateRows = (rows, context) => (Array.isArray(rows) ? rows : []).map((entity, index) => {
    const validated = validateServerEntityResponse('ads', entity, `${context}[${index}]`);
    const localAd = (state.ads || []).find(row => row && String(row.id) === String(validated.id));
    validated.data = mergeMutationInlineMedia('ads', validated.data, localAd);
    return validated;
  });
  return {
    ads: validateRows(response?.ads, 'metaSyncDue.ads'),
    imported: validateRows(response?.imported, 'metaSyncDue.imported'),
    importState: response?.importState && typeof response.importState === 'object' ? response.importState : {}
  };
}

async function apiRunMetaAutoImport() {
  const identity = getServerSessionIdentity();
  const response = await apiJson('/api/meta-ads/auto-import/run', {
    method: 'POST',
    // Historical Meta ads are deliberately not imported. This button checks
    // only for ads that appeared after Albayan established its safe baseline.
    body: { includeExisting: false }
  }, { timeoutMs: 120000 });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  const rows = Array.isArray(response?.imported) ? response.imported : [];
  return {
    imported: rows.map((entity, index) => {
      const validated = validateServerEntityResponse('ads', entity, `metaAutoImport.imported[${index}]`);
      const localAd = (state.ads || []).find(row => row && String(row.id) === String(validated.id));
      validated.data = mergeMutationInlineMedia('ads', validated.data, localAd);
      return validated;
    }),
    busy: response?.busy === true,
    state: response?.state && typeof response.state === 'object' ? response.state : {}
  };
}

// Merge two duplicate customers and every relationship that points at the
// duplicate in ONE server transaction. Generic PATCH + DELETE calls are not
// safe here: a timeout between requests could leave pages, receipts or ads
// split across both identities. The idempotency key makes a response-loss retry
// return the same committed result instead of running the merge twice.
async function apiMergeCustomers(payload) {
  const keepCustomerId = String(payload?.keepCustomerId || '');
  const duplicateCustomerId = String(payload?.duplicateCustomerId || '');
  if (!Security.isValidRecordId(keepCustomerId) || !Security.isValidRecordId(duplicateCustomerId) || keepCustomerId === duplicateCustomerId) {
    throw new Error('Choose two different valid customer records.');
  }
  const identity = getServerSessionIdentity();
  const response = await withRetry(() => apiJson('/api/customers/merge?include_media=false', {
    method: 'POST',
    body: payload
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500);
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid customer merge response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  if (!Array.isArray(response.updatedPages) || !Array.isArray(response.updatedReceipts) || !Array.isArray(response.updatedAds)) {
    const error = new Error('Invalid customer merge relationship response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const customer = validateServerEntityResponse('customers', response.customer, 'merge.customer');
  const duplicate = validateServerEntityResponse('customers', response.duplicate, 'merge.duplicate');
  const updatedPages = response.updatedPages.map((entity, index) =>
    validateServerEntityResponse('pages', entity, `merge.updatedPages[${index}]`)
  );
  const updatedReceipts = response.updatedReceipts.map((entity, index) => {
    const validated = validateServerEntityResponse('receipts', entity, `merge.updatedReceipts[${index}]`);
    const local = (state.receipts || []).find(row => row && String(row.id) === String(validated.id));
    validated.data = mergeMutationInlineMedia('receipts', validated.data, local);
    return validated;
  });
  const updatedAds = response.updatedAds.map((entity, index) => {
    const validated = validateServerEntityResponse('ads', entity, `merge.updatedAds[${index}]`);
    const local = (state.ads || []).find(row => row && String(row.id) === String(validated.id));
    validated.data = mergeMutationInlineMedia('ads', validated.data, local);
    return validated;
  });
  return {
    customer,
    duplicate,
    updatedPages,
    updatedReceipts,
    updatedAds,
    replayed: response.replayed === true
  };
}

// Stop/re-edit is also server-authoritative: the client submits only the spent
// amount and optimistic version; the server derives all allocation balances.
async function apiStopAd(adId, payload) {
  const safeAdId = String(adId || '');
  if (!Security.isValidRecordId(safeAdId)) throw new Error('Invalid ad id');
  const identity = getServerSessionIdentity();
  const response = await apiJson(`/api/ads/${encodeURIComponent(safeAdId)}/stop?include_media=false`, {
    method: 'POST',
    body: payload
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid ad stop response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const ad = validateServerEntityResponse('ads', response.ad, 'stop.ad');
  const localAd = (state.ads || []).find(row => row && String(row.id) === safeAdId);
  ad.data = mergeMutationInlineMedia('ads', ad.data, localAd);
  return {
    ad,
    replayed: response.replayed === true
  };
}

// Clothes orders and their stock changes must commit together. Generic
// collection POST/PATCH/DELETE calls cannot provide that guarantee, so every
// server-mode order action uses this one idempotent transaction boundary.
async function apiMutateClothesOrder(payload) {
  const action = String(payload?.action || '');
  if (!['create', 'update', 'status', 'payment', 'delete'].includes(action)) {
    throw new Error('Invalid clothes order action');
  }
  const identity = getServerSessionIdentity();
  const response = await apiJson('/api/clothes/orders/mutate', {
    method: 'POST',
    body: payload
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error('Invalid clothes order mutation response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const order = validateServerEntityResponse('clothesOrders', response.order, `${action}.order`);
  if (!Array.isArray(response.updatedProducts)) {
    const error = new Error('Invalid clothes order products response');
    error.code = 'INVALID_ENTITY_RESPONSE';
    throw error;
  }
  const updatedProducts = response.updatedProducts.map((entity, index) =>
    validateServerEntityResponse('clothesProducts', entity, `${action}.updatedProducts[${index}]`)
  );
  return { order, updatedProducts, replayed: response.replayed === true };
}

// Ads Studio workflow transitions are server-controlled. Customers may save
// draft fields through the collection API, but only these endpoints can move
// a request into review or record a staff decision.
async function apiSubmitAdCampaignRequest(campaignId, expectedLastModified, operationId) {
  const identity = getServerSessionIdentity();
  const body = { expectedLastModified, operationId };
  const entity = await requestValidatedServerEntity('adCampaignRequests', 'submit', () =>
    withRetry(() => apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/submit`, {
      method: 'POST', body
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500)
  );
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  return entity;
}

async function apiReviewAdCampaignRequest(campaignId, expectedLastModified, decision, note, operationId) {
  const identity = getServerSessionIdentity();
  const body = { expectedLastModified, decision, note, operationId };
  const entity = await requestValidatedServerEntity('adCampaignRequests', 'review', () =>
    withRetry(() => apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/review`, {
      method: 'POST', body
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500)
  );
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  return entity;
}

async function apiPatchEntity(collection, id, updates, expectedLastModified) {
  const omitMedia = LIGHTWEIGHT_MEDIA_COLLECTIONS.has(String(collection || ''));
  const local = (Array.isArray(state[collection]) ? state[collection] : [])
    .find(row => row && String(row.id) === String(id));
  const path = `/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}${omitMedia ? '?include_media=false' : ''}`;
  // Delivery-completion PATCHes embed the driver's required base64 proof
  // photo (plus re-sent existing photos) and can never finish inside 20s on a
  // slow uplink, so image-carrying bodies get the 90s media budget. Those
  // retry once instead of twice: each retry re-uploads the whole body from
  // byte 0, and three 90s uploads would hold a weak uplink ~4.5 minutes.
  // adCampaignRequests keeps its shipped 90s + 2-retries behavior unchanged.
  const _isAdsStudioPatch = String(collection || '') === 'adCampaignRequests';
  const timeoutMs = _isAdsStudioPatch ? ADS_STUDIO_MEDIA_TIMEOUT_MS : mediaAwareTimeoutMs(updates);
  const _patchRetries = (!_isAdsStudioPatch && timeoutMs === ADS_STUDIO_MEDIA_TIMEOUT_MS) ? 1 : 2;
  const entity = await requestValidatedServerEntity(collection, 'patch', () =>
    withRetry(() =>
      apiJson(
        path,
        { method: 'PATCH', body: { data: updates, expectedLastModified } },
        { timeoutMs }
      )
    , _patchRetries, 500)
  );
  if (String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord(collection, entity.data);
  else entity.data = mergeMutationInlineMedia(collection, entity.data, { ...(local || {}), ...(updates || {}) });
  return entity;
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
  return await requestValidatedServerEntity(collection, 'restore', () =>
    apiJson(
      `/api/admin/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/restore`,
      { method: 'PUT', body: payload },
      { timeoutMs: 60000 }
    )
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

// A single global delta cursor is safe to reseed only when EVERY collection
// in the full snapshot completed. If (for example) receipts failed while ads
// succeeded with a newer timestamp, advancing to the ads timestamp would make
// the next receipt delta permanently skip older unseen receipt changes.
function reseedServerCursorFromFullLoad(results, failed, preLoadWatermarks) {
  if (typeof _serverLiveSync !== 'object' || !_serverLiveSync) return false;
  const loaded = results && typeof results === 'object' ? results : {};
  const captured = preLoadWatermarks && typeof preLoadWatermarks === 'object'
    ? preLoadWatermarks
    : null;
  let watermark = 0;
  const collectionCursors = (_serverLiveSync.collectionCursors && typeof _serverLiveSync.collectionCursors === 'object')
    ? { ..._serverLiveSync.collectionCursors }
    : Object.create(null);
  for (const name of SERVER_SYNC_COLLECTIONS) {
    const entry = loaded[name];
    // Forbidden collections stay at implicit cursor zero so a future
    // permission grant fetches their entire newly-visible history.
    if (entry?.status === 403) {
      collectionCursors[name] = 0;
      continue;
    }
    // A failed collection keeps its previous cursor (normally zero on a new
    // session) so the next poll retries from the same safe position.
    if (!entry || entry.ok === false || entry.data === null) continue;
    // No pre-load watermark (old server/temporary endpoint failure) means zero,
    // intentionally forcing one complete catch-up delta after the full load.
    // Never derive this cursor from snapshot rows: those requests are not an
    // atomic snapshot and their maxima are unsafe as a boundary.
    const cursor = captured && Number.isSafeInteger(Number(captured[name]))
      ? Math.max(0, Number(captured[name]))
      : 0;
    collectionCursors[name] = cursor;
  }
  for (const value of Object.values(collectionCursors)) {
    const cursor = Number(value);
    if (Number.isFinite(cursor)) watermark = Math.max(watermark, cursor);
  }
  _serverLiveSync.collectionCursors = collectionCursors;
  _serverLiveSync.serverWatermark = watermark;
  _serverLiveSync.cursor = watermark;
  _serverLiveSync.fullLoadCursorReady = !!captured;
  return !!captured;
}

async function serverLoadAllData() {
  const loadIdentity = getServerSessionIdentity();
  const loadUserId = String(state.currentUser?.id || '');
  const loadAborted = () => (
    !loadUserId ||
    String(state.currentUser?.id || '') !== loadUserId ||
    serverSessionIdentityChanged(loadIdentity)
  );
  const abortedResult = () => ({ failed: [], forbidden: [], aborted: true });
  if (loadAborted()) return abortedResult();
  // Capture a safe boundary before issuing any collection request. If an older
  // server does not expose the endpoint (or it is temporarily unavailable),
  // leave this null: successful collections will be seeded at zero and the
  // live poller's first pass becomes a safe full catch-up.
  let preLoadWatermarks = null;
  try {
    preLoadWatermarks = await apiGetSyncWatermarks();
  } catch (e) {
    if (e?.code === 'SERVER_SESSION_CHANGED' || loadAborted()) return abortedResult();
    if (ALBAYAN_DEBUG_MODE) console.warn('[serverLoadAllData] Watermarks unavailable; using since=0 catch-up:', e?.message || e);
  }
  if (loadAborted()) return abortedResult();
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
      const result = await apiLoadCollectionAll(collection, { forceRefresh: true });
      if (loadAborted()) return { ok: false, collection, data: null, aborted: true };
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
      if (e?.code === 'SERVER_SESSION_CHANGED' || loadAborted()) {
        return { ok: false, collection, data: null, aborted: true };
      }
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
  const collections = SERVER_SYNC_COLLECTIONS;
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
    if (loadAborted()) return abortedResult();
    const batch = collections.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (c) => {
      const result = await safeLoad(c);
      if (!loadAborted()) updateProgress(c);
      return result;
    }));
    if (loadAborted() || batchResults.some(r => r?.aborted)) return abortedResult();
    batchResults.forEach((r) => {
      if (r && r.collection) results[r.collection] = r;
    });

    // Apply data immediately after each batch for progressive rendering
    for (const r of batchResults) {
      if (r && r.collection && r.data !== null) {
        state[r.collection] = r.data;
        clearCollectionCorruption(r.collection); // authoritative complete server copy repairs the cache
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
  if (loadAborted()) return abortedResult();
  try {
    const usersList = await apiListUsersForUi();
    if (loadAborted()) return abortedResult();
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
    if (e?.code === 'SERVER_SESSION_CHANGED' || loadAborted()) return abortedResult();
    failed.push({ collection: 'users', status: e?.status || null, message: e?.message || 'Failed to load users' });
  }
  if (loadAborted()) return abortedResult();
  // ALWAYS keep the current user (with their login-response permissions) in
  // state.users — even when the users-list fetch failed. hasPermission and the
  // sidebar read state.users; without this, a failed fetch locks the whole UI.
  if (typeof upsertCurrentUserIntoUsers === 'function') upsertCurrentUserIntoUsers();

  if (loadAborted()) return abortedResult();
  if (failed.length === 0) {
    state.serverLastSyncAt = new Date().toISOString();
    state.serverLastSyncErrorAt = null;
  } else {
    state.serverLastSyncErrorAt = new Date().toISOString();
  }

  // Authoritatively (re)seed the live-sync cursor from server-issued timestamps.
  // This is the ONLY skew-free source: the freshly-loaded arrays carry the
  // server's last_modified, so re-seeding here corrects a cursor that
  // startServerLiveSync may have estimated too high from a clock-skewed device.
  try {
    if (loadAborted()) return abortedResult();
    reseedServerCursorFromFullLoad(results, failed, preLoadWatermarks);
  } catch (_) {}

  // Cache server data locally (IndexedDB) for performance (optional)
  if (loadAborted()) return abortedResult();
  if (db) {
    markAllCollectionsDirty();
    await flushDirtyCollections();
  }

  // One clean warning (avoid spam). These are user-specific and expected sometimes.
  if (loadAborted()) return abortedResult();
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
  // Let callers (login flow) distinguish a clean load from a partial one so
  // they don't show "All data synchronized successfully" over missing data.
  if (loadAborted()) return abortedResult();
  if (typeof queueNativeReminderSync === 'function') queueNativeReminderSync();
  return { failed, forbidden };
}

// ==========================================
// SYSTEM-BROWSER APP LOGIN (Phase 2)
// ==========================================
// Optional secure-browser sign-in for packaged Capacitor iOS/Android apps.
// The normal app-owned form uses the same HttpOnly server session as the web
// app. This alternative opens the hosted login page in Safari/Chrome for
// password-manager, passkey, or SSO use, then returns via the albayan://auth
// deep link carrying a ONE-TIME code. The app exchanges code+verifier
// (PKCE-style: only the verifier's SHA-256 leaves the device) for its session.
//
// Two sides live here because both run from this same bundle:
//   NATIVE side (Capacitor): startAppBrowserLogin / deep-link handling.
//   WEB side (system browser): detects ?app_login=1 requests, mints the
//   handoff code after login, renders the "return to app" screen.

const APP_LOGIN_DEEP_LINK = 'albayan://auth';
// Native app: the pending {state, verifier} is kept in Keychain/Keystore so
// Android can restore the activity without exposing it to web storage. The
// browser build retains a localStorage fallback for its non-native flow.
const APP_LOGIN_PENDING_KEY = 'albayan_app_login_pending';
// Web page: the app's sign-in request {state, challenge} while the user
// authenticates. sessionStorage: tab-scoped and gone when the tab closes.
const APP_LOGIN_WEB_REQUEST_KEY = 'albayan_app_login_request';
const APP_LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;

let _appLoginCallbackQueue = '';
let _appLoginDrainAttempts = 0;
let _appLoginExchangeBusy = false;
let _appLoginPendingCache = null;
let _appLoginPendingHydrated = false;
// Start with the app-owned form so Albayan opens like a normal native app.
// The system-browser flow remains available for password managers and SSO.
let _nativeLoginMode = 'form';

// Secure-browser sign-in is available only in server mode (a local-only
// override has no server to sign in to).
function isSystemBrowserLoginEnabled() {
  return !!(typeof Platform !== 'undefined' && Platform.isCapacitor && isServerModeEnabled());
}

// Unbiased random lowercase-hex token (n bytes -> 2n hex chars).
function _appLoginRandomHex(nBytes) {
  const n = Math.max(8, Number(nBytes) || 32);
  try {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 256).toString(16).slice(1);
    return out;
  } catch (_) {
    // Capacitor WebViews always have crypto; this fallback only keeps the
    // flow alive in exotic test sandboxes.
    let out = '';
    while (out.length < n * 2) out += Math.floor(Math.random() * 16).toString(16);
    return out.slice(0, n * 2);
  }
}

// SHA-256 of a string as lowercase hex. Uses WebCrypto (always present in
// the app WebViews' secure context) with the pure-JS fallback from
// 02-security.js for insecure test/LAN origins.
async function _appLoginSha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  let digest;
  if (globalThis.crypto && globalThis.crypto.subtle) {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  } else if (typeof _albFallbackSha256 === 'function') {
    digest = _albFallbackSha256(data);
  } else {
    throw new Error('SHA-256 unavailable');
  }
  let out = '';
  for (let i = 0; i < digest.length; i++) out += (digest[i] + 256).toString(16).slice(1);
  return out;
}

// ---------- NATIVE SIDE (packaged app) ----------

function _validateAppLoginPending(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const stateToken = String((parsed && parsed.state) || '');
    const verifier = String((parsed && parsed.verifier) || '');
    const createdAt = Number(parsed && parsed.createdAt) || 0;
    if (!/^[0-9a-f]{32,128}$/.test(stateToken) || !/^[0-9a-f]{32,128}$/.test(verifier)) return null;
    if (!createdAt || Date.now() - createdAt > APP_LOGIN_REQUEST_TTL_MS) return null;
    return { state: stateToken, verifier: verifier, createdAt: createdAt };
  } catch (_) {
    return null;
  }
}

function _readAppLoginPending() {
  if (isPackagedMobileApp()) return _appLoginPendingCache;
  try { return _validateAppLoginPending(localStorage.getItem(APP_LOGIN_PENDING_KEY)); }
  catch (_) { return null; }
}

async function readAppLoginPendingAsync() {
  if (!isPackagedMobileApp()) return _readAppLoginPending();
  if (_appLoginPendingHydrated) return _appLoginPendingCache;
  _appLoginPendingHydrated = true;
  let pending = null;
  if (typeof nativeSecureGet === 'function') {
    pending = _validateAppLoginPending(await nativeSecureGet(APP_LOGIN_PENDING_KEY));
  }
  // Migrate a request created by an older release, then erase the web copy.
  if (!pending) {
    try { pending = _validateAppLoginPending(localStorage.getItem(APP_LOGIN_PENDING_KEY)); } catch (_) {}
    if (pending && typeof nativeSecureSet === 'function') {
      const migrated = await nativeSecureSet(APP_LOGIN_PENDING_KEY, pending);
      if (!migrated) pending = null;
    }
  }
  try { localStorage.removeItem(APP_LOGIN_PENDING_KEY); } catch (_) {}
  _appLoginPendingCache = pending;
  return pending;
}

async function hydrateAppLoginPendingFromSecureStorage() {
  const before = _appLoginPendingCache;
  await readAppLoginPendingAsync();
  if (before !== _appLoginPendingCache && typeof render === 'function') {
    try { render(); } catch (_) {}
  }
}

async function _storeAppLoginPending(pending) {
  const validated = _validateAppLoginPending(pending);
  if (!validated) return false;
  if (isPackagedMobileApp()) {
    if (typeof nativeSecureSet !== 'function') return false;
    const saved = await nativeSecureSet(APP_LOGIN_PENDING_KEY, validated);
    if (saved) {
      _appLoginPendingCache = validated;
      _appLoginPendingHydrated = true;
      try { localStorage.removeItem(APP_LOGIN_PENDING_KEY); } catch (_) {}
    }
    return saved;
  }
  try {
    localStorage.setItem(APP_LOGIN_PENDING_KEY, JSON.stringify(validated));
    return true;
  } catch (_) { return false; }
}

function clearAppBrowserLoginPending() {
  _appLoginPendingCache = null;
  _appLoginPendingHydrated = true;
  if (isPackagedMobileApp() && typeof nativeSecureRemove === 'function') {
    nativeSecureRemove(APP_LOGIN_PENDING_KEY).catch(() => {});
  }
  try { localStorage.removeItem(APP_LOGIN_PENDING_KEY); } catch (_) {}
}

// The native login screen shows a waiting card while a browser round-trip
// is pending, and a busy card while the code exchange runs.
function isAppBrowserLoginWaiting() {
  return !!_readAppLoginPending();
}
function isAppBrowserLoginExchanging() {
  return _appLoginExchangeBusy === true;
}

async function _openInSystemBrowser(url) {
  if (isPackagedMobileApp() && typeof openNativeBrowser === 'function') {
    return await openNativeBrowser(url);
  }
  // Capacitor routes external-origin _blank navigations to the real system
  // browser (Safari / Chrome) — the same mechanism the login screen's
  // privacy-policy links already rely on in the packaged app.
  try {
    const win = window.open(url, '_blank');
    if (win) return true;
  } catch (_) {}
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (_) {
    return false;
  }
}

// Kick off the Sabil-style sign-in: mint state+verifier, remember them
// device-locally, and open the hosted login page with the CHALLENGE only.
async function startAppBrowserLogin() {
  if (!isSystemBrowserLoginEnabled()) return false;
  try {
    const existing = await readAppLoginPendingAsync();
    let stateToken;
    let verifier;
    if (existing) {
      // Re-tapping "Open browser again" keeps the SAME pending request so a
      // login already in progress in the browser can still come back.
      stateToken = existing.state;
      verifier = existing.verifier;
    } else {
      stateToken = _appLoginRandomHex(16);
      verifier = _appLoginRandomHex(32);
      const stored = await _storeAppLoginPending({
        state: stateToken,
        verifier: verifier,
        createdAt: Date.now()
      });
      if (!stored) {
        showNotification(
          state.language === 'ar' ? 'التخزين غير متاح' : 'Storage Unavailable',
          state.language === 'ar'
            ? 'تعذّر بدء تسجيل الدخول عبر المتصفح. استخدم تسجيل الدخول داخل التطبيق.'
            : 'Could not start browser sign-in. Use in-app sign-in instead.',
          'error'
        );
        return false;
      }
    }
    const challenge = await _appLoginSha256Hex(verifier);
    const base = getServerBaseUrl() || MOBILE_SERVER_URL;
    const url = base + '/?app_login=1'
      + '&app_state=' + encodeURIComponent(stateToken)
      + '&app_challenge=' + encodeURIComponent(challenge)
      + '&app_platform=' + encodeURIComponent((typeof Platform !== 'undefined' && Platform.platform) || 'app');
    const opened = await _openInSystemBrowser(url);
    if (!opened) {
      clearAppBrowserLoginPending();
      showNotification(
        state.language === 'ar' ? 'تعذّر فتح المتصفح' : 'Could Not Open Browser',
        state.language === 'ar'
          ? 'لم يتمكن التطبيق من فتح المتصفح. استخدم تسجيل الدخول داخل التطبيق.'
          : 'The app could not open the browser. Use in-app sign-in instead.',
        'error'
      );
    }
    render();
    return opened;
  } catch (e) {
    clearAppBrowserLoginPending();
    console.warn('[AppLogin] start failed:', e?.message || e);
    showNotification(
      state.language === 'ar' ? 'خطأ' : 'Error',
      state.language === 'ar' ? 'تعذّر بدء تسجيل الدخول عبر المتصفح.' : 'Could not start browser sign-in.',
      'error'
    );
    render();
    return false;
  }
}

function cancelAppBrowserLogin() {
  clearAppBrowserLoginPending();
  render();
}

function isAppLoginCallbackUrl(url) {
  return /^albayan:\/\/auth([/?#]|$)/i.test(String(url || ''));
}

// Parse albayan://auth?code=...&state=... defensively (custom-scheme URLs
// parse inconsistently across WebViews, so never rely on new URL()).
function _parseAppLoginCallback(url) {
  const raw = String(url || '');
  const q = raw.indexOf('?');
  if (q < 0) return null;
  let query = raw.slice(q + 1);
  const h = query.indexOf('#');
  if (h >= 0) query = query.slice(0, h);
  let params;
  try { params = new URLSearchParams(query); } catch (_) { return null; }
  const code = String(params.get('code') || '');
  const stateToken = String(params.get('state') || '');
  if (!/^[A-Za-z0-9._~-]{20,256}$/.test(code)) return null;
  if (!/^[0-9a-f]{16,128}$/.test(stateToken)) return null;
  return { code: code, state: stateToken };
}

// Deep-link entry point (appUrlOpen + cold-start launch URL). Queues the
// callback until init() has settled server mode and storage, because the
// exchange runs the full post-login pipeline.
function handleAppLoginDeepLink(url) {
  if (!isAppLoginCallbackUrl(url)) return false;
  _appLoginCallbackQueue = String(url);
  _appLoginDrainAttempts = 0;
  _drainAppLoginCallbackQueue();
  return true;
}

function _drainAppLoginCallbackQueue() {
  if (!_appLoginCallbackQueue) return;
  if (window.__albayanInitSettled !== true) {
    // Cold start: init() is still probing the server / restoring storage.
    if (_appLoginDrainAttempts++ < 240) setTimeout(_drainAppLoginCallbackQueue, 250);
    else _appLoginCallbackQueue = '';
    return;
  }
  const url = _appLoginCallbackQueue;
  _appLoginCallbackQueue = '';
  _processAppLoginCallback(url).catch((e) => {
    console.warn('[AppLogin] callback processing failed:', e?.message || e);
  });
}

async function _processAppLoginCallback(url) {
  if (_appLoginExchangeBusy) return;
  if (typeof state !== 'undefined' && state.currentUser) {
    // Already signed in (e.g. stale link re-opened) — nothing to do.
    clearAppBrowserLoginPending();
    if (typeof closeNativeBrowser === 'function') closeNativeBrowser();
    return;
  }
  const parsed = _parseAppLoginCallback(url);
  const pending = await readAppLoginPendingAsync();
  const isAr = typeof state !== 'undefined' && state.language === 'ar';
  if (!parsed || !pending || parsed.state !== pending.state) {
    // Unknown/expired/foreign link: never exchange a code this app did not
    // request (state binding), and burn any stale pending request.
    clearAppBrowserLoginPending();
    showNotification(
      isAr ? 'انتهت صلاحية الرابط' : 'Sign-In Link Expired',
      isAr ? 'ابدأ تسجيل الدخول من التطبيق مرة أخرى.' : 'Start the sign-in from the app again.',
      'error'
    );
    if (typeof render === 'function') render();
    return;
  }
  _appLoginExchangeBusy = true;
  if (typeof closeNativeBrowser === 'function') closeNativeBrowser();
  try { if (typeof render === 'function') render(); } catch (_) {}
  try {
    await completeAppBrowserLogin(parsed.code, pending.verifier);
  } finally {
    _appLoginExchangeBusy = false;
    clearAppBrowserLoginPending();
    if (typeof state === 'undefined' || !state.currentUser) {
      try { if (typeof render === 'function') render(); } catch (_) {}
    }
  }
}

async function apiAppLoginExchange(code, verifier) {
  const res = await apiJson(
    '/api/auth/app-login/exchange',
    { method: 'POST', body: { code: code, verifier: verifier } },
    { timeoutMs: 15000 }
  );
  return (res && res.user) || null;
}

// Register the albayan:// deep-link listeners (packaged app only). Called
// from setupMobileRuntime(); safe to call multiple times.
let _appLoginDeepLinksReady = false;
async function setupAppLoginDeepLinks() {
  if (_appLoginDeepLinksReady) return;
  if (!(typeof Platform !== 'undefined' && Platform.isCapacitor)) return;
  const App = (typeof getCapacitorAppPlugin === 'function') ? getCapacitorAppPlugin() : null;
  if (!App) return;
  _appLoginDeepLinksReady = true;
  try {
    if (App.addListener) {
      await App.addListener('appUrlOpen', (event) => {
        try { handleAppLoginDeepLink(event && event.url); } catch (_) {}
      });
    }
  } catch (e) {
    console.warn('[AppLogin] appUrlOpen listener unavailable:', e?.message || e);
  }
  try {
    // Cold start: the deep link may have LAUNCHED the app instead of
    // resuming it — the listener above never fires for that first URL.
    if (App.getLaunchUrl) {
      const launch = await App.getLaunchUrl();
      if (launch && launch.url) handleAppLoginDeepLink(launch.url);
    }
  } catch (_) {}
}

// ---------- WEB SIDE (page opened in the system browser) ----------

// Called early in init(): capture ?app_login=1&app_state=&app_challenge=
// into sessionStorage and scrub the parameters from the address bar so they
// never linger in history/bookmarks/share sheets.
function detectAppLoginRequestFromUrl() {
  if (typeof Platform !== 'undefined' && Platform.isCapacitor) return;
  let params;
  try { params = new URLSearchParams(window.location.search || ''); } catch (_) { return; }
  if (params.get('app_login') !== '1') return;
  const stateToken = String(params.get('app_state') || '');
  const challenge = String(params.get('app_challenge') || '');
  const platform = String(params.get('app_platform') || '').slice(0, 16);
  if (/^[0-9a-f]{16,128}$/.test(stateToken) && /^[0-9a-f]{64}$/.test(challenge)) {
    try {
      sessionStorage.setItem(APP_LOGIN_WEB_REQUEST_KEY, JSON.stringify({
        state: stateToken,
        challenge: challenge,
        platform: platform,
        createdAt: Date.now()
      }));
    } catch (_) { /* storage blocked: banner/handoff simply won't appear */ }
  }
  try {
    ['app_login', 'app_state', 'app_challenge', 'app_platform'].forEach((k) => params.delete(k));
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (qs ? '?' + qs : '')
    );
  } catch (_) {}
}

function getPendingAppLoginRequest() {
  try {
    const raw = sessionStorage.getItem(APP_LOGIN_WEB_REQUEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const stateToken = String((parsed && parsed.state) || '');
    const challenge = String((parsed && parsed.challenge) || '');
    const createdAt = Number(parsed && parsed.createdAt) || 0;
    if (!/^[0-9a-f]{16,128}$/.test(stateToken) || !/^[0-9a-f]{64}$/.test(challenge)) return null;
    if (!createdAt || Date.now() - createdAt > APP_LOGIN_REQUEST_TTL_MS) {
      clearPendingAppLoginRequest();
      return null;
    }
    return {
      state: stateToken,
      challenge: challenge,
      platform: String((parsed && parsed.platform) || '').slice(0, 16),
      createdAt: createdAt
    };
  } catch (_) {
    return null;
  }
}

function clearPendingAppLoginRequest() {
  try { sessionStorage.removeItem(APP_LOGIN_WEB_REQUEST_KEY); } catch (_) {}
}

async function apiAppLoginHandoff(challenge, platform) {
  const res = await apiJson(
    '/api/auth/app-login/handoff',
    { method: 'POST', body: { challenge: challenge, platform: platform || null } },
    { timeoutMs: 12000 }
  );
  return (res && res.code) || '';
}

function _appLoginReturnDeepLink(code, stateToken) {
  return APP_LOGIN_DEEP_LINK
    + '?code=' + encodeURIComponent(String(code))
    + '&state=' + encodeURIComponent(String(stateToken));
}

function albayanReturnToApp() {
  const ret = window.__albayanAppLoginReturn;
  if (!ret || !ret.code) return;
  try { window.location.href = _appLoginReturnDeepLink(ret.code, ret.state); } catch (_) {}
}

// "You're signed in — return to the app" surface. Stored on window so any
// stray render() re-paints IT (renderLogin short-circuits to this) instead
// of dropping the user back onto a login form.
function _renderAppLoginReturnHTML() {
  const ret = window.__albayanAppLoginReturn;
  if (!ret) return '';
  const isAr = state.language === 'ar';
  const name = Security.escapeHtml(String(ret.name || ''));
  return `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <div class="glass-panel w-full p-8 rounded-3xl animate-fade-in-up text-center">
          <div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <i data-lucide="check" class="h-8 w-8" aria-hidden="true"></i>
          </div>
          <h1 class="text-2xl font-extrabold text-slate-900 dark:text-white">
            ${isAr ? 'تم تسجيل الدخول' : 'You are signed in'}
          </h1>
          ${name ? `<p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${name}</p>` : ''}
          <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
            ${isAr ? 'جارٍ إرجاعك إلى تطبيق البيان...' : 'Returning you to the Albayan app...'}
          </p>
          <button type="button" onclick="albayanReturnToApp()"
            class="mt-6 min-h-12 w-full btn-shine alb-btn-primary rounded-xl px-5 py-3 font-extrabold text-white">
            ${isAr ? 'فتح تطبيق البيان' : 'Open the Albayan app'}
          </button>
          <p class="mt-4 text-xs text-slate-400">
            ${isAr ? 'يمكنك إغلاق هذا التبويب بعد فتح التطبيق.' : 'You can close this tab once the app opens.'}
          </p>
        </div>
      </div>
    </div>`;
}

function renderAppLoginReturnScreen(user, code, stateToken) {
  window.__albayanAppLoginReturn = {
    code: String(code),
    state: String(stateToken),
    name: String((user && user.name) || '')
  };
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = _renderAppLoginReturnHTML();
    try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(app); } catch (_) {}
  }
  // Automatic bounce back into the app; the button stays as the fallback
  // for browsers that block scripted custom-scheme navigations.
  albayanReturnToApp();
}

// Hook for the login flows: when this browser tab is an app sign-in
// round-trip, mint the one-time code and bounce back instead of loading the
// full workspace here. Returns true when the handoff took over the screen.
async function maybeCompleteAppLoginHandoff(user) {
  const request = getPendingAppLoginRequest();
  if (!request) return false;
  try {
    const code = await apiAppLoginHandoff(request.challenge, request.platform);
    if (!code) throw new Error('No handoff code returned');
    clearPendingAppLoginRequest();
    renderAppLoginReturnScreen(user, code, request.state);
    return true;
  } catch (e) {
    console.warn('[AppLogin] handoff failed:', e?.message || e);
    clearPendingAppLoginRequest();
    showNotification(
      state.language === 'ar' ? 'تعذّر الرجوع إلى التطبيق' : 'Could Not Return to the App',
      state.language === 'ar'
        ? 'تعذّر تسليم تسجيل الدخول إلى التطبيق. ابدأ من التطبيق مرة أخرى.'
        : 'The sign-in could not be handed back to the app. Start again from the app.',
      'error'
    );
    return false;
  }
}

// Web session already signed in when an app sign-in request arrives: ask
// before handing that session to the app (never silently — the link could
// have been opened into someone else's signed-in browser).
function maybeOfferAppLoginHandoffForActiveSession() {
  if (typeof state === 'undefined' || !state.currentUser) return false;
  if (typeof Platform !== 'undefined' && Platform.isCapacitor) return false;
  const request = getPendingAppLoginRequest();
  if (!request) return false;
  if (document.getElementById('app-login-handoff-confirm')) return true;
  const isAr = state.language === 'ar';
  const name = Security.escapeHtml(String(state.currentUser.name || state.currentUser.email || ''));
  const overlay = document.createElement('div');
  overlay.id = 'app-login-handoff-confirm';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 p-4';
  overlay.innerHTML = `
    <div class="glass-panel w-full max-w-sm rounded-3xl p-6 text-center">
      <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
        <i data-lucide="smartphone" class="h-7 w-7" aria-hidden="true"></i>
      </div>
      <h2 class="text-xl font-extrabold text-slate-900 dark:text-white">
        ${isAr ? 'تسجيل الدخول إلى تطبيق البيان؟' : 'Sign in to the Albayan app?'}
      </h2>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
        ${isAr ? `سيتم تسجيل دخول التطبيق على هذا الهاتف باسم ${name}.` : `The app on this phone will be signed in as ${name}.`}
      </p>
      <button type="button" onclick="albayanConfirmAppHandoff()"
        class="mt-5 min-h-12 w-full btn-shine alb-btn-primary rounded-xl px-5 py-3 font-extrabold text-white">
        ${isAr ? 'متابعة إلى التطبيق' : 'Continue to the app'}
      </button>
      <button type="button" onclick="albayanDeclineAppHandoff()"
        class="mt-3 min-h-11 w-full rounded-xl px-5 py-2 font-bold text-slate-500 hover:text-slate-700 dark:text-slate-300">
        ${isAr ? 'ليس الآن' : 'Not now'}
      </button>
    </div>`;
  document.body.appendChild(overlay);
  try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(overlay); } catch (_) {}
  return true;
}

async function albayanConfirmAppHandoff() {
  const request = getPendingAppLoginRequest();
  document.getElementById('app-login-handoff-confirm')?.remove();
  if (!request || !state.currentUser) return;
  await maybeCompleteAppLoginHandoff(state.currentUser);
}

function albayanDeclineAppHandoff() {
  clearPendingAppLoginRequest();
  document.getElementById('app-login-handoff-confirm')?.remove();
}
