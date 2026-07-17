
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
  setupMobileRuntime().catch((error) => {
    console.warn('[MobileRuntime] Setup failed:', error?.message || error);
  });
  
  setLoadingStatus(state.language === 'ar' ? 'جارٍ تهيئة قاعدة البيانات...' : 'Initializing database...');
  
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
  const serverOk = await apiHealthCheck();
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
  const blockPackagedMobileColdStart = !!(
    isPackagedMobileApp() && state.serverMode && !serverOk && mobileRuntimeNeedsServer()
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
    if (authCheckUnavailable && isPackagedMobileApp() && mobileRuntimeNeedsServer()) {
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
