// ==========================================
// LIVE SERVER SYNC (Always‑Online Multi‑User Mode)
// ==========================================

const _serverLiveSync = {
  timer: null,
  inFlight: false,
  cursor: 0,
  lastUsersSyncAt: 0,
  startedForUserId: null,
  // Signature of the last delivery-role payload, so identical polls don't
  // force a full re-render every 3s (which snapped dropdowns shut on phones).
  lastDeliverySig: null
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

// Cheap change-detection fingerprint for a fetched collection. Only reads each
// record's id and _lastModified (tiny), never the heavy base64 photo fields, so
// it is orders of magnitude cheaper than JSON.stringify of the full payload.
function _cheapSyncSig(arr) {
  if (!Array.isArray(arr)) return 'n';
  let h = 0;
  let maxLM = 0;
  for (const r of arr) {
    const id = String((r && r.id) || '');
    const lm = Number((r && r._lastModified) || 0) | 0;
    if (lm > maxLM) maxLM = lm;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    h = ((h << 5) - h + lm) | 0;
  }
  return arr.length + ':' + maxLM + ':' + (h >>> 0);
}

function applyServerDelta(collectionName, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  if (!Array.isArray(state[collectionName])) state[collectionName] = [];
  const arr = state[collectionName];

  // PERFORMANCE: build id->index ONCE. The old code did arr.findIndex per
  // incoming record (O(delta × collection)) plus an O(n) arr.unshift per new
  // record, so a large catch-up delta (tab hidden overnight / cursor frozen on
  // failures) froze the UI for hundreds of ms. This is O(delta + collection).
  const byId = new Map();
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x && x.id != null) byId.set(x.id, i);
  }

  const newOnes = [];         // staged new records (in delta order)
  const newById = new Map();  // id -> index in newOnes (dedup within this delta)
  let changed = false;

  for (const rec of records) {
    if (!rec || !rec.id) continue;
    const clean = Security.sanitizeObject(rec);
    const idx = byId.get(clean.id);
    if (idx !== undefined) {
      arr[idx] = clean;                       // update existing in place
    } else if (newById.has(clean.id)) {
      newOnes[newById.get(clean.id)] = clean; // dup id within this delta -> keep last
    } else {
      newById.set(clean.id, newOnes.length);
      newOnes.push(clean);
    }
    changed = true;
  }

  // Prepend new records once. Reverse to preserve the previous behavior where
  // per-record unshift left the last delta record at the very front.
  if (newOnes.length) {
    newOnes.reverse();
    arr.unshift(...newOnes);
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

    // Only treat the tick as "changed" when the fetched payload actually
    // differs from the previous one. Comparing against state would always
    // differ (migrateOldDataFormats mutates state records in place), so
    // compare the raw fetched arrays via a signature.
    // PERFORMANCE: use a CHEAP fingerprint (count + max/rolling-hash of
    // id+_lastModified) instead of JSON.stringify of the whole payload. The
    // full payload carries receiptImage base64 (~50-200KB each), so stringifying
    // it every 3s serialized tens of MB and stalled the main thread even when
    // nothing changed. Additions/removals change the count+hash; any edit bumps
    // _lastModified, so this detects every real change without touching photos.
    let sig = null;
    try {
      sig = _cheapSyncSig(ads) + '|' + _cheapSyncSig(receipts) + '|' + _cheapSyncSig(customers);
    } catch (_) {}
    const changed = (sig === null) || sig !== _serverLiveSync.lastDeliverySig;
    if (changed) {
      if (Array.isArray(ads)) state.ads = ads;
      if (Array.isArray(receipts)) state.receipts = receipts;
      if (Array.isArray(customers)) state.customers = customers;
      if (sig !== null) _serverLiveSync.lastDeliverySig = sig;
    }
    
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

  let anyFetchFailed = false;
  const safeSince = async (collection) => {
    try {
      return await apiLoadCollectionSince(collection, since);
    } catch (e) {
      if (e?.status === 403) return [];
      // A genuine fetch failure: do NOT let the cursor advance past updates we
      // never received, or those records would be skipped forever.
      anyFetchFailed = true;
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
  // Freeze the cursor for this tick if any collection failed to load, so the
  // next tick re-requests the same window (idempotent — applyServerDelta
  // upserts by id) instead of permanently skipping the missed collection.
  _serverLiveSync.cursor = anyFetchFailed ? since : Math.max(since, maxDelta);
  if (anyFetchFailed && typeof updateSyncIndicator === 'function') {
    try { updateSyncIndicator('error'); } catch (_) {}
  }
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
    // BATTERY/SERVER SAVER: skip polls while the tab/app is hidden. The
    // visibilitychange handler below fires an immediate catch-up sync the
    // moment the app becomes visible again, so no update is ever missed.
    if (document.visibilityState === 'hidden') return;
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
        if (isAdminRole(state.currentUser.role)) {
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
      if (isAdminRole(state.currentUser.role)) {
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

