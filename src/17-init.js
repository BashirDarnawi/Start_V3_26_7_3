
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
  document.documentElement.setAttribute('lang', state.language === 'ar' ? 'ar' : 'en');
  setupMobileRuntime().catch((error) => {
    console.warn('[MobileRuntime] Setup failed:', error?.message || error);
  });
  
  setLoadingStatus(state.language === 'ar' ? 'جارٍ تهيئة قاعدة البيانات...' : 'Initializing database...');
  
  // Initialize IndexedDB for persistent audit log storage. initIndexedDB()
  // can no longer reject or hang (watchdog + onblocked), but keep this await
  // unable to abort init() before the first render no matter what.
  await initIndexedDB().catch((e) => {
    console.warn('IndexedDB init failed:', e);
    return null;
  });

  // Ask the browser to mark this origin's storage persistent (best-effort,
  // fire-and-forget). Protects Chrome/Android against storage-pressure
  // eviction; it does NOT exempt iOS Safari from ITP's 7-day script-storage
  // wipe (only Add to Home Screen does), and navigator.storage is undefined
  // on insecure (plain-HTTP LAN) origins — hence the guards.
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
  } catch (_) {}

  // Opening the app directly from a local file (file://) bypasses the backend,
  // so server mode can never activate. Warn once so the user runs it via a server.
  try {
    const proto = String(window.location?.protocol || '');
    if (proto === 'file:' && !window.__albayanFileModeWarned) {
      window.__albayanFileModeWarned = true;
      try {
        showNotification(
          state.language === 'ar' ? 'شغّل عبر خادم' : 'Run via Server',
          state.language === 'ar'
            ? 'لقد فتحت البيان من ملف محلي (//:file). للحصول على كامل الوظائف، شغّله عبر HTTP بدلاً من ذلك (مثلاً الخادم على /http://127.0.0.1:8000 أو "npx serve").'
            : 'You opened Albayan from a local file (file://). For full functionality, serve it over HTTP instead (e.g. the backend at http://127.0.0.1:8000/ or "npx serve").',
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
  
  setLoadingStatus(state.language === 'ar' ? 'جارٍ تحميل التفضيلات...' : 'Loading preferences...');
  const legacyCollections = loadState();

  setLoadingStatus(state.language === 'ar' ? 'جارٍ الاتصال بالسيرفر...' : 'Connecting to server...');
  // Detect backend (multi-user internet mode)
  let serverOk = await apiHealthCheck();
  // First-ever visit on this browser profile: a single 3s probe on a slow
  // phone network silently strands the user in an empty local workspace
  // (nothing ever re-probes). Escalate 3s → 5s → 8s before deciding, but
  // ONLY in the ambiguous fresh-install case so returning users, desktop
  // local testing and Capacitor keep their startup timing. With no backend
  // at all each attempt fails fast (connection refused / 404), so the
  // retries only spend time when requests actually hang — exactly the
  // ambiguous case.
  //
  // A returning LOCAL-mode install is NOT a first-ever visit and must keep
  // the old 3s cold start (hanging networks would otherwise block it 16s on
  // "Connecting to server..."). Any prior snapshot (loadState() returned
  // one) or the storage-eviction sentinel cookie (survives Safari ITP /
  // Chrome wipes — and after a wipe the user needs the storage-loss recovery
  // screen promptly, not more probing) proves a workspace existed here.
  const hadPriorLocalWorkspace = legacyCollections !== null ||
    (typeof _albayanHadDataCookie === 'function' && _albayanHadDataCookie());
  if (!serverOk && SERVER_API.enabledByDefault && !hadPriorLocalWorkspace &&
      String(state.serverModeOverride || 'auto') === 'auto' &&
      state.serverWorkspaceKnown !== true && state.serverMode !== true) {
    for (const timeoutMs of [5000, 8000]) {
      try {
        const data = await apiJson('/api/health', { method: 'GET' }, { timeoutMs });
        serverOk = !!data?.ok;
      } catch (_) {
        serverOk = false;
      }
      if (serverOk) break;
    }
  }
  // Recoverable-failure signal (runtime-only, never persisted): the login /
  // first-run screens can show a "server unreachable — Retry" banner that
  // calls retryServerDetection() instead of silently offering a device-local
  // workspace.
  state.serverProbeFailed = !serverOk && SERVER_API.enabledByDefault &&
    String(state.serverModeOverride || 'auto') === 'auto';
  state.serverDetected = !!serverOk;
  const override = String(state.serverModeOverride || 'auto');
  if (override === 'local') {
    state.serverMode = false;
  } else if (override === 'server') {
    state.serverMode = true;
  } else {
    // Once this installation has used the team server, a temporary health
    // check failure must not silently open an unrelated local workspace. The
    // packaged mobile app is always server-backed unless the user explicitly
    // chose the local override.
    const packagedMobile = !!(typeof Platform !== 'undefined' && Platform.isCapacitor);
    const previouslyServerBacked = state.serverWorkspaceKnown === true || state.serverMode === true;
    state.serverMode = state.serverDetected || packagedMobile || previouslyServerBacked;
  }
  if (state.serverDetected) state.serverWorkspaceKnown = true;
  if (state.serverMode) updateMobileServerReachability(!!serverOk);
  else removeMobileConnectivityNotice();

  // A packaged phone app cannot safely decide that a failed health check
  // means "logged out". Stop before /auth/me and before rendering Login: the
  // server session may still be valid, but it cannot be verified offline.
  // Keep cached business rows out of the anonymous screen and offer one clear
  // retry action; a successful retry reloads and resumes normal startup.
  const stopForPackagedMobileConnection = () => {
    if (state.cloudConfig) state.cloudConfig.enabled = false;
    for (const name of PERSISTED_COLLECTIONS) state[name] = [];
    state.logs = [];
    state.serverLogs = [];
    state.currentUser = null;
    try { stopServerLiveSync(); } catch (_) {}
    try { activateAnonymousServerCollectionStorage(); } catch (_) {}
    try { saveState(); } catch (_) {}
    setupUrlRouting();
    if (loadingScreen) loadingScreen.style.display = 'none';
    setMobileColdStartBlocked(true);
  };
  // The connectivity gate is Capacitor-only today because the gate/notice
  // renderers in src/01b-mobile-runtime.js early-return for browsers. When
  // that layer defines connectivityUiEnabled() (packaged app OR phone
  // browser), both cold-start gates below activate for phone browsers too;
  // until then behavior is byte-for-byte unchanged.
  const connectivityGateEnabled = (typeof connectivityUiEnabled === 'function')
    ? !!connectivityUiEnabled()
    : isPackagedMobileApp();
  const blockPackagedMobileColdStart = !!(
    connectivityGateEnabled && state.serverMode && !serverOk && mobileRuntimeNeedsServer()
  );
  if (blockPackagedMobileColdStart) {
    stopForPackagedMobileConnection();
    return;
  }
  setMobileColdStartBlocked(false);

  if (state.serverMode) {
    // Disable legacy cloud sync in server mode (backend is the source of truth)
    if (state.cloudConfig) state.cloudConfig.enabled = false;

    // loadState() runs before backend detection so preferences can be applied
    // immediately. In no-IDB/legacy installations it may also have contained
    // business arrays; clear them before auth so no previous-user data can be
    // rendered or used if /auth/me fails.
    for (const name of PERSISTED_COLLECTIONS) state[name] = [];
    activateAnonymousServerCollectionStorage();
    saveState(); // persist serverWorkspaceKnown without persisting business arrays

    // Restore login from backend cookie session
    setLoadingStatus(state.language === 'ar' ? 'جارٍ التحقق من الجلسة...' : 'Checking session...');
    let me = null;
    let authCheckUnavailable = false;
    try {
      me = await apiAuthMe();
    } catch (error) {
      authCheckUnavailable = true;
      console.warn('[MobileRuntime] Session verification unavailable:', error?.message || error);
    }
    // A successful health response does not guarantee that the session check
    // also reached the server. Treat a network/timeout failure differently
    // from a definitive 401 (which apiAuthMe returns as null).
    if (authCheckUnavailable && connectivityGateEnabled && mobileRuntimeNeedsServer()) {
      updateMobileServerReachability(false);
      stopForPackagedMobileConnection();
      return;
    }
    if (me) {
      updateMobileServerReachability(true);
      cancelPendingRequests();
      invalidateUsersListCache();
      for (const key of Object.keys(_collectionCache)) {
        _collectionCache[key] = { data: null, timestamp: 0, identity: '' };
      }
      advanceServerSessionEpoch();
      state.currentUser = me;
      // Only now is it safe to open this user's cache namespace.
      activateServerCollectionStorage(me);
      setLoadingStatus(state.language === 'ar' ? 'جارٍ تحميل البيانات المخزنة...' : 'Loading cached data...');
      if (db) {
        try {
          await loadCollectionsFromStorage(null);
          assertCachedCollectionIdentifiersSafe();
        } catch (e) {
          // IndexedDB error - continue with empty state and load from server.
          for (const name of PERSISTED_COLLECTIONS) state[name] = [];
        }
      }
      // Merge the fresh session user (with permissions) into state.users BEFORE
      // the first render — the cached users list can be empty (wiped by logout,
      // private browsing) or stale, and hasPermission reads state.users.
      upsertCurrentUserIntoUsers();
      // Restore last page for Admin. Non-admins always land inside Albayan Manager (secret ideas hidden).
      if (String(me.role || '').toLowerCase() === 'admin') {
        state.currentView = String(state.currentView || '').trim() || 'services-hub';
      } else {
        state.currentView = getPostLoginLandingViewForUser(me);
      }
      
      // PERFORMANCE: Show UI immediately with cached data, then update from server
      setLoadingStatus(state.language === 'ar' ? 'جاهز!' : 'Ready!');
      
      // Render UI immediately with cached data
      render();
      
      // Check refresh throttle - prevent server overload from rapid refreshes
      if (isRefreshThrottled()) {
        console.log('[init] Refresh throttled - using cached data');
        // Still restore modal from URL
        restoreModalFromUrl();
        // No authoritative full snapshot is running in this branch, so start
        // the catch-up poller now (it will use cursor 0 when needed).
        startServerLiveSync();
      } else {
        // Complete the authoritative snapshot before starting delta polling.
        // Running both concurrently allowed a newer delta to be applied and
        // then overwritten by an older full-list response.
        const startupIdentity = getServerSessionIdentity();
        const startupLoad = serverLoadAllData().then((loadResult) => {
          if (loadResult?.aborted) return;
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
            showNotification(state.language === 'ar' ? 'تحذير السيرفر' : 'Server Warning', state.language === 'ar' ? 'فشل تحميل بعض البيانات. جرّب التحديث.' : 'Some data failed to load. Try Refresh.', 'warning');
          }
        });
        startupLoad.finally(() => {
          if (!serverSessionIdentityChanged(startupIdentity)) startServerLiveSync();
        });
      }
    } else {
      advanceServerSessionEpoch();
      state.currentUser = null;
      stopServerLiveSync();
      // Fresh server with no admin yet? Surface the first-run setup option on
      // the login page directly, so the operator doesn't have to fail a login
      // first to discover it.
      const fresh = await apiNeedsSetup();
      state.serverHasNoUsers = fresh?.needsSetup === true;
      state.serverSetupEnabled = fresh?.setupEnabled === true;
      state.needsServerSetup = fresh?.needsSetup === true;
    }
  } else {
    activateLocalCollectionStorage();
    // Offline/local mode (single-device)
    setLoadingStatus(state.language === 'ar' ? 'جارٍ تحميل البيانات المحلية...' : 'Loading local data...');
    // Load huge data collections (IndexedDB-first), migrate legacy localStorage if needed
    await loadCollectionsFromStorage(legacyCollections);

    // The IndexedDB open never settled this boot (watchdog / onblocked): the
    // store may still hold the full workspace even though this session could
    // not read it and loaded the collections empty (or from a stale legacy
    // snapshot). Freeze them so no late-arriving connection can ever flush
    // these in-memory arrays over the intact stored copies —
    // markCollectionDirty honors isCollectionCorrupted. A reload with a
    // healthy open restores everything through the normal path.
    if (!db && window.__albayanIdbOpenInconclusive === true &&
        typeof markCollectionCorrupted === 'function') {
      for (const name of PERSISTED_COLLECTIONS) markCollectionCorrupted(name);
    }

    // Sanitize loaded data before any UI renders (prevents stored XSS from legacy data)
    await sanitizeAllCollectionsForRendering();
    
    // Migrate old data formats to work with new features
    migrateOldDataFormats();

    // Ensure user passwords are always stored hashed (no plaintext in storage)
    await ensureUsersHavePasswordHashes();

    // Local-mode data lives only in this browser and the browser may evict it
    // (Safari ITP 7-day wipe, Chrome disk pressure) — remind about backups.
    maybeShowLocalDataDurabilityReminder();

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
  setupUrlRouting();
  
  // URL Routing: If user is logged in, check URL for initial view
  if (state.currentUser) {
    const urlView = getViewFromUrl();
    // Only use URL view if it's valid and the user may open it. Platform views
    // (services hub, wallet, smart systems, service pages) are Admin-only, but
    // an Admin MUST be able to deep-link into them.
    if (urlView && urlView !== 'services-hub') {
      const isPlatformView = PLATFORM_ADMIN_ONLY_VIEWS.has(urlView);
      const canAccess = isPlatformView
        ? isCurrentUserAdmin()
        : (isCurrentUserAdmin() || userCanAccessView(state.currentUser, urlView) ||
           (urlView === 'delivery-dashboard' && isDeliveryRole(state.currentUser?.role)));
      if (canAccess) {
        state.currentView = urlView;
        // Re-apply what the link carries (Clothes tab, service id)
        restoreViewStateFromUrl(urlView);
      }
    }
    // Update URL to match current view (in case we changed it)
    updateUrlForView(state.currentView, true); // replace, don't push
    
    // Restore modal from URL (if not in server mode - server mode restores after data loads)
    if (!isServerModeEnabled()) {
      setTimeout(() => restoreModalFromUrl(), 200);
    }
  }
  
  setLoadingStatus(state.language === 'ar' ? 'جاهز!' : 'Ready!');
  
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

        // SECURITY: a crafted link could otherwise silently redirect all of
        // this device's data to an attacker-controlled endpoint. Require an
        // explicit, informed confirmation from the user before enabling.
        const confirmMsg = state.language === 'ar'
          ? 'رابط يطلب مزامنة بيانات هذا الجهاز مع خادم خارجي:\n\n' + url.host + '\n\nلا توافق إلا إذا كنت تثق بمصدر هذا الرابط. هل تريد المتابعة؟'
          : 'This link asks to sync ALL data on this device with an external server:\n\n' + url.host + '\n\nOnly continue if you trust where this link came from. Enable sync?';
        if (!window.confirm(confirmMsg)) {
          addSecurityLog('cloud_connect_rejected', 'User declined sys_connect to ' + url.host);
          throw new Error('User declined the connection request');
        }

        state.cloudConfig = {
          enabled: true,
          endpoint: Security.sanitizeInput(config.endpoint, { maxLength: 500 }),
          apiKey: config.apiKey
        };
        showNotification(state.language === 'ar' ? 'تم توصيل النظام' : 'System Connected', state.language === 'ar' ? 'جارٍ مزامنة البيانات...' : 'Synchronizing data...', 'success');

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

  // Auto-backup once per day (IndexedDB only). A phone browser never keeps a
  // tab alive for 24 continuous hours, so a bare setInterval alone never
  // fired there — run a due-check at startup, on tab resume AND on the
  // interval. The newest-backup lookup keeps every trigger idempotent (at
  // most one backup per AUTO_BACKUP_INTERVAL), and callback-style IDB means
  // no new awaits before render(). `db` is re-checked per call because the
  // connection can now drop/reopen mid-session.
  const runDailyBackupIfDue = () => {
    if (!db) return;
    try {
      const tx = db.transaction([BACKUP_STORE_NAME], 'readonly');
      const req = tx.objectStore(BACKUP_STORE_NAME).index('createdAt').openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        const newest = cursor && cursor.value ? cursor.value.createdAt || 0 : 0;
        if (Date.now() - newest >= STORAGE_CONFIG.AUTO_BACKUP_INTERVAL) {
          createAutoBackup().catch(() => {});
        }
      };
      req.onerror = () => { createAutoBackup().catch(() => {}); };
    } catch (_) {
      createAutoBackup().catch(() => {});
    }
  };
  runDailyBackupIfDue();
  setInterval(runDailyBackupIfDue, STORAGE_CONFIG.AUTO_BACKUP_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runDailyBackupIfDue();
  });

  render();
}

// Local mode keeps ALL business data (and the in-app auto-backups) inside
// this browser's evictable storage: iOS Safari deletes every kind of site
// storage after 7 days of Safari use without a visit, and Chrome/Android can
// evict under disk pressure. There is no server copy, so remind the user to
// export backups from Settings — at most once every 5 days, and not when a
// recent export exists (the export flow records albayanNoteBackupExported()).
function maybeShowLocalDataDurabilityReminder() {
  try {
    if (isPackagedMobileApp()) return;
    if (!Array.isArray(state.users) || state.users.length === 0) return;
    const fiveDays = 5 * TIME_CONSTANTS.MILLISECONDS_PER_DAY;
    const now = Date.now();
    const lastExport = Number(localStorage.getItem('albayan_last_backup_export_at')) || 0;
    const lastReminder = Number(localStorage.getItem('albayan_backup_reminder_at')) || 0;
    if (now - lastExport < fiveDays || now - lastReminder < fiveDays) return;
    localStorage.setItem('albayan_backup_reminder_at', String(now));
    showNotification(
      state.language === 'ar' ? 'بياناتك في هذا المتصفح فقط' : 'Your Data Lives Only in This Browser',
      state.language === 'ar'
        ? 'قد يحذف المتصفح البيانات المخزنة محلياً (سفاري يحذفها بعد 7 أيام دون زيارة). صدّر نسخة احتياطية من الإعدادات بانتظام، وأضِف التطبيق إلى الشاشة الرئيسية.'
        : 'The browser may delete locally stored data (Safari wipes it after 7 days without a visit). Export a backup from Settings regularly, and add the app to your Home Screen.',
      'warning'
    );
  } catch (_) {}
}

// Track whether the on-screen keyboard is likely open (a text-entry element
// has focus) via body.keyboard-open. style.css hides the fixed bottom nav
// while it is set: iOS Safari anchors position:fixed to the layout viewport,
// so with the keyboard up the nav otherwise floats mid-screen over the form
// being typed into. focusout re-checks after a tick so focus moving between
// fields (or render()'s synchronous focus restore) never flickers the class.
(function setupKeyboardOpenTracking() {
  function isTextEntry(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = String(el.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color'].includes(type);
  }
  document.addEventListener('focusin', (e) => {
    if (isTextEntry(e.target)) document.body.classList.add('keyboard-open');
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!isTextEntry(document.activeElement)) {
        document.body.classList.remove('keyboard-open');
      }
    }, 0);
  });
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
