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
  'serviceSubscriptions',
  // Clothes System
  'clothesProducts',
  'clothesShipments',
  'clothesOrders',
  'clothesSettings',
  // Customer-facing Ads Studio requests (never the internal ads ledger)
  'adCampaignRequests',
  // Admin-only app configuration (liquidity tracking start etc.)
  'appSettings'
];

// Debounced IndexedDB sync (avoid writing huge arrays on every keystroke)
const idbSync = {
  dirty: new Set(),
  timer: null,
  flushing: false,
  scopeGeneration: 0,
  debounceMs: 800,
  retryDelayMs: 2000,
  maxRetryDelayMs: 30000
};

function resetDirtyCollectionQueueForScopeChange() {
  if (idbSync.timer) clearTimeout(idbSync.timer);
  idbSync.timer = null;
  idbSync.dirty.clear();
  idbSync.retryDelayMs = 2000;
  idbSync.scopeGeneration += 1;
}

// ==========================================
// SINGLE-WRITER TAB LOCK (multi-tab safety)
// ==========================================
// saveCollectionToIndexedDB rewrites whole collections from this tab's
// in-memory arrays, so a second tab of the same origin silently overwrites
// the first tab's records (last writer wins). BroadcastChannel and Web Locks
// are Safari 15.4+ (above the iOS 15.0 baseline), so coordination uses
// localStorage only: the newest tab claims the lock and older tabs stop
// persisting until reloaded. A superseded tab deliberately never re-claims a
// lock on its own (not even a stale one) — the other tab may have written to
// IndexedDB, and resuming writes from this tab's stale arrays would recreate
// the exact overwrite bug this lock exists to prevent. Reloading re-claims
// the lock and re-reads fresh data through the normal init path. Expiry-by-
// heartbeat (not unload cleanup) is the liveness signal because iOS kills
// tabs without firing unload.
const TAB_LOCK_KEY = 'albayan_tab_lock';
const TAB_LOCK_HEARTBEAT_MS = 5000;
const _albayanTabLock = {
  enabled: false,
  id: '',
  lost: false,
  heartbeatTimer: null
};

function _readTabLockEntry() {
  try {
    const raw = localStorage.getItem(TAB_LOCK_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;
    return entry;
  } catch (_) {
    return null;
  }
}

function _writeTabLockClaim() {
  try {
    localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ id: _albayanTabLock.id, ts: Date.now() }));
    return true;
  } catch (_) {
    return false;
  }
}

// True when another tab has claimed the writer lock. Re-reads localStorage
// synchronously on every call: iOS Safari suspends background tabs and can
// deliver 'storage' events late or never, so the listener below is only for
// showing the overlay promptly — this check is the actual safety mechanism.
function isAnotherTabWriter() {
  if (!_albayanTabLock.enabled) return false;
  if (_albayanTabLock.lost) return true;
  const entry = _readTabLockEntry();
  if (entry && entry.id !== _albayanTabLock.id) {
    _markTabLockLost();
    return true;
  }
  return false;
}

function _markTabLockLost() {
  if (_albayanTabLock.lost) return;
  _albayanTabLock.lost = true;
  if (_albayanTabLock.heartbeatTimer) {
    clearInterval(_albayanTabLock.heartbeatTimer);
    _albayanTabLock.heartbeatTimer = null;
  }
  _showTabLockOverlay();
}

// Blocking overlay for the superseded tab — LOCAL MODE ONLY. In server mode
// the backend is the source of truth (every edit goes through the API and
// live sync reconciles), so the losing tab keeps working and merely skips
// its local cache writes.
function _showTabLockOverlay() {
  try {
    if ((typeof isServerModeEnabled === 'function') && isServerModeEnabled()) return;
    if (!document.body || document.getElementById('albayan-tab-lock-overlay')) return;
    const isAr = (typeof state !== 'undefined') && state.language === 'ar';
    const overlay = document.createElement('div');
    overlay.id = 'albayan-tab-lock-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    // Inline styles: this overlay must render even if a stylesheet failed.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:rgba(15,23,42,0.94);color:#fff;text-align:center;';
    overlay.innerHTML = `
      <div style="max-width:26rem;">
        <h2 style="font-size:1.25rem;font-weight:800;margin-bottom:0.75rem;">
          ${isAr ? 'التطبيق مفتوح في علامة تبويب أخرى' : 'App is open in another tab'}
        </h2>
        <p style="font-size:0.9rem;line-height:1.6;margin-bottom:1.25rem;">
          ${isAr
            ? 'لحماية بياناتك من الكتابة المتعارضة، تعمل علامة تبويب واحدة فقط في كل مرة. أغلق هذه النافذة أو أعد تحميلها لاستخدام التطبيق هنا.'
            : 'To protect your data from conflicting writes, only one tab can be active at a time. Close this tab, or reload it to use the app here.'}
        </p>
        <button type="button" onclick="window.location.reload()" style="min-height:2.75rem;padding:0.6rem 1.5rem;border-radius:0.75rem;border:0;background:#4f46e5;color:#fff;font-weight:700;cursor:pointer;">
          ${isAr ? 'إعادة التحميل والاستخدام هنا' : 'Reload and use here'}
        </button>
      </div>`;
    document.body.appendChild(overlay);
  } catch (_) {}
}

function initAlbayanTabWriterLock() {
  try {
    // The packaged Capacitor WebView is single-instance — no lock needed.
    if (typeof Platform !== 'undefined' && Platform.isCapacitor) return;
    if (typeof localStorage === 'undefined') return;
    _albayanTabLock.id = Security.generateSecureId('tab');
    // Newest tab wins: claim unconditionally. If storage is blocked entirely,
    // fail open (no coordination possible, but persistence must keep working).
    if (!_writeTabLockClaim()) return;
    _albayanTabLock.enabled = true;
    const heartbeat = setInterval(() => {
      if (_albayanTabLock.lost) return;
      const entry = _readTabLockEntry();
      if (entry && entry.id !== _albayanTabLock.id) {
        _markTabLockLost();
        return;
      }
      _writeTabLockClaim();
    }, TAB_LOCK_HEARTBEAT_MS);
    // In the browser this is a number; in the Node test sandbox it is a
    // Timeout object that would otherwise keep the test process alive.
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
    _albayanTabLock.heartbeatTimer = heartbeat;
    // 'storage' fires only in OTHER tabs — the moment a newer tab claims,
    // surface the overlay here instead of waiting for the next write attempt.
    window.addEventListener('storage', (e) => {
      if (e && e.key !== TAB_LOCK_KEY) return;
      if (isAnotherTabWriter()) _showTabLockOverlay();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isAnotherTabWriter()) _showTabLockOverlay();
    });
  } catch (_) {}
}
initAlbayanTabWriterLock();

function getCollectionNameFromArray(array) {
  if (array === state.ads) return 'ads';
  if (array === state.receipts) return 'receipts';
  if (array === state.customers) return 'customers';
  if (array === state.pages) return 'pages';
  if (array === state.users) return 'users';
  if (array === state.exchangeRateHistory) return 'exchangeRateHistory';
  if (array === state.walletTransactions) return 'walletTransactions';
  if (array === state.serviceSubscriptions) return 'serviceSubscriptions';
  if (array === state.clothesProducts) return 'clothesProducts';
  if (array === state.clothesShipments) return 'clothesShipments';
  if (array === state.clothesOrders) return 'clothesOrders';
  if (array === state.clothesSettings) return 'clothesSettings';
  if (array === state.adCampaignRequests) return 'adCampaignRequests';
  if (array === state.appSettings) return 'appSettings';
  return null;
}

function markCollectionDirty(collectionName) {
  if (!db) return;
  if (!collectionName || !PERSISTED_COLLECTIONS.includes(collectionName)) return;
  // DATA SAFETY: never re-save a collection whose IndexedDB copy loaded
  // incomplete — rewriting it would overwrite the intact (unread) chunks with
  // the truncated in-memory array and destroy the missing records for good.
  if (typeof isCollectionCorrupted === 'function' && isCollectionCorrupted(collectionName)) {
    console.warn(`[albayan] Skipping IndexedDB re-save of "${collectionName}" — its stored copy is incomplete (protected from overwrite).`);
    return;
  }
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
  // Another tab owns persistence now — writing this tab's (possibly stale)
  // arrays would overwrite its records. See the single-writer tab lock above.
  if (isAnotherTabWriter()) return;
  if (!db || idbSync.flushing) return;
  if (idbSync.dirty.size === 0) return;

  idbSync.flushing = true;
  const flushGeneration = idbSync.scopeGeneration;
  const toFlush = Array.from(idbSync.dirty);
  idbSync.dirty.clear();
  const failed = [];

  try {
    for (const name of toFlush) {
      if (flushGeneration !== idbSync.scopeGeneration) break;
      try {
        const saved = await saveCollectionToIndexedDB(name, state[name]);
        if (saved === false) failed.push(name);
      } catch (e) {
        // A connection iOS Safari force-closed can race past onclose: the
        // handle is dead but still truthy and every transaction() throws
        // InvalidStateError. Null it so saveState() immediately falls back to
        // keeping collections inside the localStorage snapshot; the onclose
        // reopen path re-persists to IndexedDB once a connection returns.
        if (e && e.name === 'InvalidStateError') {
          console.warn('IndexedDB connection lost mid-flush — falling back to localStorage');
          db = null;
          saveState();
          return;
        }
        console.warn(`IndexedDB save failed for "${name}":`, e);
        failed.push(name);
      }
    }
  } finally {
    idbSync.flushing = false;
  }

  // The authenticated cache namespace changed while a write was in flight.
  // The completed write captured its old scope; do not continue this batch or
  // requeue its names into the new user's namespace.
  if (flushGeneration !== idbSync.scopeGeneration) return;

  // Never lose the dirty marker when IndexedDB rejects a write (quota,
  // transaction abort, temporary WebView failure). Requeue it with bounded
  // backoff instead of tight-looping or waiting for an unrelated later edit.
  if (failed.length > 0) {
    for (const name of failed) idbSync.dirty.add(name);
    if (idbSync.timer) clearTimeout(idbSync.timer);
    const delay = idbSync.retryDelayMs;
    idbSync.retryDelayMs = Math.min(idbSync.retryDelayMs * 2, idbSync.maxRetryDelayMs);
    idbSync.timer = setTimeout(() => {
      idbSync.timer = null;
      flushDirtyCollections().catch((e) => console.warn('IndexedDB retry error:', e));
    }, delay);
    return;
  }
  idbSync.retryDelayMs = 2000;
  // Collections marked dirty WHILE this flush was running hit the re-entrancy
  // guard above and had their debounce swallowed — they would otherwise sit
  // unpersisted until some unrelated later edit. Flush them now. Terminates
  // because each pass clears the set.
  if (idbSync.dirty.size > 0) {
    await flushDirtyCollections();
  }
}

// ==========================================
// STORAGE-EVICTION DETECTION (local mode)
// ==========================================
// iOS Safari's ITP deletes ALL script-writable storage (localStorage AND
// IndexedDB, including the in-app backups store) for an origin after 7 days
// of Safari use without a visit; Chrome/Android can evict non-persistent
// origins under disk pressure. After such a wipe the app is indistinguishable
// from a fresh install — except for this cookie, which browsers do not evict
// with site storage (best-effort on iOS, where ITP caps JS cookies at 7 days).
let _hadDataSentinelSet = false;
function _maybeSetHadDataSentinel() {
  if (_hadDataSentinelSet) return;
  try {
    if ((typeof isServerModeEnabled === 'function') && isServerModeEnabled()) return;
    if (!Array.isArray(state.users) || state.users.length === 0) return;
    document.cookie = 'albayan_had_data=1; max-age=63072000; path=/; SameSite=Lax';
    _hadDataSentinelSet = true;
  } catch (_) {}
}

// True when the sentinel cookie above exists — i.e. a local workspace with
// real data lived on this device at some point, however storage looks now.
function _albayanHadDataCookie() {
  try {
    return String(document.cookie || '')
      .split(';')
      .some(part => part.trim().indexOf('albayan_had_data=') === 0);
  } catch (_) {
    return false;
  }
}

// Captured ONCE at boot by loadState(): the snapshot was missing while the
// sentinel cookie survived. It must be a runtime flag, not a render-time
// localStorage re-read — loadCollectionsFromStorage()'s trailing saveState()
// re-creates the snapshot BEFORE the first render, so re-reading it later
// could never observe the eviction.
let _storageLossAtBoot = false;

// Render-side contract: when the local first-run branch would show the
// "create your first admin" setup screen, call this first — true means the
// browser deleted this device's stored business data (loadState() found the
// sentinel cookie but no snapshot at boot) and a data-loss/recovery screen
// (restore from an exported backup) must be rendered instead of first-run
// setup. Restoring a backup or creating an admin clears it via the
// users.length guard; renderStorageLossRecovery's "start fresh" button opts
// out via state._storageLossAcknowledged.
function albayanDetectStorageLoss() {
  try {
    if ((typeof isServerModeEnabled === 'function') && isServerModeEnabled()) return false;
    if (Array.isArray(state.users) && state.users.length > 0) return false;
    return _storageLossAtBoot;
  } catch (_) {
    return false;
  }
}

// The Settings export flow should call this after a successful backup export
// so the local-mode durability reminder stays quiet for the next few days.
function albayanNoteBackupExported() {
  try { localStorage.setItem('albayan_last_backup_export_at', String(Date.now())); } catch (_) {}
}

function saveState() {
  // Another tab is the single writer now (see the tab lock above) — this
  // tab's snapshot may be stale and must not clobber the winner's.
  if (isAnotherTabWriter()) return;
  try {
    // Create a copy of state with optimized log storage
    // Keep only recent logs in localStorage, all logs are in IndexedDB
    const logsForStorage = db ? state.logs.slice(0, MAX_LOGS_IN_LOCALSTORAGE) : state.logs;
    
    const toSave = { ...state };
    toSave.logs = logsForStorage; // Only store recent logs in localStorage
    // Never persist full user object in localStorage (sessionStorage is the source of truth)
    delete toSave.currentUser;
    // Persist large collections in IndexedDB only. CRITICAL: if IndexedDB is
    // unavailable (db === null — e.g. some private-browsing modes and older
    // WebViews), keep the collections inside this localStorage snapshot.
    // Deleting them here with no IndexedDB would leave business data in
    // memory only, and it would vanish on the next reload.
    const serverBacked = (typeof isServerModeEnabled === 'function') && isServerModeEnabled();
    if (db || serverBacked) {
      for (const key of PERSISTED_COLLECTIONS) {
        delete toSave[key];
      }
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
    delete toSave.tempReceiptPhotos;
    delete toSave.tempAdPhotosDirty;
    delete toSave.tempReceiptPhotosDirty;
    // Runtime-only connectivity flag (first-visit health-probe result)
    delete toSave.serverProbeFailed;

    // Sanitize before persistence (defense-in-depth)
    const sanitizedToSave = Security.sanitizeObject(toSave);
    // PERFORMANCE: serialize ONCE and reuse for both the size check and the
    // write. The old code stringified the whole snapshot twice and also built a
    // throwaway Blob just to measure it — in no-IndexedDB mode that snapshot
    // includes every collection with base64 photos, and saveState runs on hot
    // paths (every permission toggle / record update), so that was 2× multi-MB
    // serialization + a Blob allocation per call. dataString.length ≈ the byte
    // size here (base64 photos + JSON keys are ASCII), so no Blob is needed.
    let dataString = JSON.stringify(sanitizedToSave);
    const sizeInMB = dataString.length / (1024 * 1024);
    if (sizeInMB > 4) {
      console.warn(`LocalStorage data size: ${sizeInMB.toFixed(2)}MB - approaching limit`);
      // Further reduce logs and re-serialize only in this rare branch.
      sanitizedToSave.logs = state.logs.slice(0, 100);
      dataString = JSON.stringify(sanitizedToSave);
    }

    localStorage.setItem('albayan_complete_state', dataString);
    // Storage-eviction sentinel: in local mode with real data, leave a cookie
    // behind so a later browser wipe of localStorage+IndexedDB (Safari ITP,
    // Chrome storage pressure) is distinguishable from a genuine first run.
    _maybeSetHadDataSentinel();
  } catch (error) {
    console.error('Error saving state:', error);
    
    // If quota exceeded, try with fewer logs
    if (error.name === 'QuotaExceededError' || error.message.includes('quota')) {
      // CRITICAL: without IndexedDB, this localStorage snapshot is the ONLY
      // persisted copy of the business data. Overwriting it with a reduced,
      // collection-less snapshot would destroy that copy — so in no-IDB mode
      // we keep the last good snapshot untouched and just warn the user.
      if (!db) {
        console.warn('Storage quota exceeded and IndexedDB is unavailable — keeping the previous snapshot to protect data.');
        try {
          showNotification(
            state.language === 'ar' ? 'مساحة التخزين ممتلئة' : 'Storage Full',
            state.language === 'ar'
              ? 'لا يمكن حفظ آخر التغييرات — مساحة المتصفح ممتلئة. صدّر نسخة احتياطية من الإعدادات.'
              : 'Latest changes could not be saved — browser storage is full. Please export a backup from Settings.',
            'error'
          );
        } catch (_) {}
        return;
      }
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
    if (!saved) {
      // EVICTION SIGNAL — capture it now or never. init()'s local branch runs
      // loadCollectionsFromStorage(), whose trailing saveState() re-creates
      // this snapshot before the first render; a missing snapshot combined
      // with a surviving sentinel cookie means the browser wiped this
      // device's stored data (Safari ITP 7-day wipe, Chrome disk pressure).
      // Only the clean not-present case counts: a corrupt-but-present
      // snapshot throws below and must not be misreported as eviction.
      _storageLossAtBoot = _albayanHadDataCookie();
    }
    if (saved) {
      const parsed = JSON.parse(saved);
      
      // Sanitize loaded data to prevent XSS from corrupted storage
      const sanitizedData = Security.sanitizeObject(parsed);

      // Extract legacy large collections (older versions stored everything in
      // localStorage, and no-IndexedDB mode still does). Built from
      // PERSISTED_COLLECTIONS so every collection saveState() persists is
      // round-tripped — a hard-coded list here once missed walletTransactions
      // and serviceSubscriptions, wiping wallets on reload in no-IDB mode.
      const legacyCollections = {};
      for (const key of PERSISTED_COLLECTIONS) {
        legacyCollections[key] = Array.isArray(sanitizedData[key]) ? sanitizedData[key] : null;
      }
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
      if (!Array.isArray(state.clothesProducts)) state.clothesProducts = [];
      if (!Array.isArray(state.clothesShipments)) state.clothesShipments = [];
      if (!Array.isArray(state.clothesOrders)) state.clothesOrders = [];
      if (!Array.isArray(state.clothesSettings)) state.clothesSettings = [];
      if (!Array.isArray(state.appSettings)) state.appSettings = [];

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

// Warn the user (once per collection) that a stored collection loaded incomplete
// and is protected from being overwritten, so they can restore a backup.
function _notifyCollectionCorruption(name) {
  try {
    if (!Array.isArray(state._corruptedCollections)) state._corruptedCollections = [];
    if (!state._corruptedCollections.includes(name)) state._corruptedCollections.push(name);
    console.error(`[albayan] IndexedDB copy of "${name}" is incomplete — protected from overwrite; restore a backup.`);
    if (typeof showNotification === 'function') {
      const ar = `تعذّر تحميل بعض بيانات (${name}) كاملة من هذا الجهاز، وتم منع الكتابة فوقها لحمايتها. الرجاء الاستعادة من نسخة احتياطية حديثة من الإعدادات.`;
      const en = `Some saved "${name}" data could not be fully loaded from this device and has been protected from being overwritten. Please restore from a recent backup in Settings.`;
      showNotification(
        state.language === 'ar' ? 'تحذير سلامة البيانات' : 'Data Safety Warning',
        state.language === 'ar' ? ar : en,
        'error'
      );
    }
  } catch (_) {}
}

async function loadCollectionsFromStorage(legacyCollections = null) {
  const legacy = legacyCollections || {};

  for (const name of PERSISTED_COLLECTIONS) {
    let loaded = null;

    if (db) {
      try {
        loaded = await loadCollectionFromIndexedDB(name);
      } catch (e) {
        if (e && e.code === 'IDB_COLLECTION_CORRUPT') {
          // The IndexedDB copy is incomplete. Prefer the legacy localStorage
          // snapshot if present (it may be complete); otherwise keep the partial
          // records we could read. Either way the collection stays flagged
          // corrupted so it is NOT re-saved over the intact chunks, and we warn
          // the user to restore a backup.
          if (Array.isArray(legacy[name])) {
            state[name] = legacy[name];
          } else if (Array.isArray(e.partialData)) {
            state[name] = e.partialData;
          } else if (!Array.isArray(state[name])) {
            state[name] = [];
          }
          _notifyCollectionCorruption(name);
          continue;
        }
        throw e;
      }
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
    // Never re-save a corrupted collection (would overwrite intact chunks).
    if (!isCollectionCorrupted('ads')) await saveCollectionToIndexedDB('ads', state.ads);
    if (!isCollectionCorrupted('receipts')) await saveCollectionToIndexedDB('receipts', state.receipts);
  }

  // Persist the refreshed localStorage snapshot. With IndexedDB available
  // this drops the large arrays from localStorage; without IndexedDB,
  // saveState() now keeps them there so existing data is never wiped.
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

  // Old local caches predate strict id validation. Quarantine unsafe records
  // instead of rendering them (stored XSS) or silently discarding them. The
  // original sanitized rows remain exportable in state for manual recovery;
  // an IndexedDB source is marked protected so the filtered array cannot
  // overwrite it.
  const safe = [];
  const quarantined = [];
  for (let i = 0; i < arr.length; i++) {
    const result = Security.validateRecordIdentifiers(arr[i], `${collectionName}[${i}]`);
    if (result.valid) safe.push(arr[i]);
    else quarantined.push({ record: arr[i], reason: result.error || 'Invalid identifier' });
  }
  if (quarantined.length > 0) {
    if (!state._quarantinedUnsafeRecords || typeof state._quarantinedUnsafeRecords !== 'object') {
      state._quarantinedUnsafeRecords = {};
    }
    state._quarantinedUnsafeRecords[collectionName] = quarantined;
    state[collectionName] = safe;
    if (db) markCollectionCorrupted(collectionName);
    _notifyCollectionCorruption(collectionName);
  }
}

async function sanitizeAllCollectionsForRendering() {
  for (const name of PERSISTED_COLLECTIONS) {
    await sanitizeCollectionInPlace(name);
  }
}

function assertCachedCollectionIdentifiersSafe() {
  for (const name of PERSISTED_COLLECTIONS) {
    const records = state[name];
    if (!Array.isArray(records)) continue;
    const result = Security.validateRecordIdentifiers(records, `cache.${name}`);
    if (!result.valid) {
      const error = new Error(`Unsafe cached business data rejected: ${result.error}`);
      error.code = 'UNSAFE_CACHED_IDENTIFIER';
      throw error;
    }
  }
  return true;
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
        changed = true;

        // Migrate old single-receipt linking to receiptAllocations
        // For receipt-linked unpaid ads, receiptId is the debt source reference,
        // not proof that money was already paid. Turning it into paid funding
        // would consume the receipt twice and erase the customer's debt.
        const isLinkedUnpaidDebt = getAdPaymentState(ad) === 'not_paid'
          && ['driver', 'in_shop'].includes(String(ad.collectionMethod || '').toLowerCase());
        const linkedReceiptId = ad.fundingReceiptId || (!isLinkedUnpaidDebt ? ad.receiptId : '');
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
        // Materialize the row from the legacy dueAmountToUse* mirror — the amount the
        // usage helpers already credit this ad with. It is NOT ad.amountUSD: an ad can
        // draw only part of its budget from delivery due credit and the rest from a paid
        // receipt, and writing the whole ad amount here invented due usage that never
        // happened, over-locking the delivery receipt and disagreeing with the server
        // (which derives the same number from the mirror). This runs on every live-sync
        // tick, so the error compounded across devices.
        const legacyDueUSD = (() => {
          const usd = parseFloat(ad.dueAmountToUseUSD) || 0;
          if (usd > 0) return usd;
          const lyd = parseFloat(ad.dueAmountToUseLYD) || 0;
          const rate = ad.exchangeRate || state.defaultExchangeRate || 1;
          return lyd > 0 && rate > 0 ? lyd / rate : 0;
        })();
        if (ad.linkedDeliveryReceiptId && getAdPaymentState(ad) !== 'paid' && legacyDueUSD > 0) {
          ad.dueAllocations.push({
            receiptId: String(ad.linkedDeliveryReceiptId),
            amountUSD: Math.round(legacyDueUSD * 100) / 100
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
// LIFECYCLE FLUSH (phone browsers)
// ==========================================
// Phone browsers freeze all timers the instant the page is hidden, and iOS
// jettisons backgrounded tabs before they resume — losing whatever sat in the
// 800ms-debounced IndexedDB flush and the 300ms-debounced saveState (in local
// mode with IndexedDB, that debounced flush is the ONLY durable copy of the
// business collections). visibilitychange:hidden is the last moment IndexedDB
// transactions can still start on iOS app-switch; pagehide covers real
// navigations/reloads. Double-firing is harmless: flushDirtyCollections is
// re-entrancy-guarded and a no-op when nothing is dirty.
function flushPersistenceNow() {
  try {
    if (_saveStateTimer) { clearTimeout(_saveStateTimer); _saveStateTimer = null; }
    saveState();
  } catch (_) {}
  try {
    if (idbSync.timer) { clearTimeout(idbSync.timer); idbSync.timer = null; }
    flushDirtyCollections().catch(() => {});
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPersistenceNow();
});
window.addEventListener('pagehide', flushPersistenceNow, { passive: true });
