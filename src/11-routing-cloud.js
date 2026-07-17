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
  'deliveries': '/deliveries',
  'reconciliation': '/reconciliation',
  'settings': '/settings',
  // The Audit Logs view id is 'audit' (see renderView switch)
  'audit': '/audit-logs',
  'delivery-dashboard': '/delivery',
  'no-access': '/no-access',
  // Platform views (admin only)
  'smart-systems': '/smart-systems',
  'clothes-system': '/clothes-system',
  'ads-studio': '/ads-studio',
  'service-placeholder': '/service',
  'wallet': '/wallet'
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
    page: params.get('page'),
    service: params.get('service')
  };
}

// Sub-state that belongs in the URL for a given view (so the link reopens the
// exact same screen): the Clothes System tab, the service being viewed.
function viewUrlParamsFor(view) {
  if (view === 'clothes-system') {
    return { tab: (typeof _clothesActiveTab !== 'undefined' && _clothesActiveTab) || null };
  }
  if (view === 'ads-studio') {
    return { tab: (typeof _adsStudioActiveTab !== 'undefined' && _adsStudioActiveTab) || null };
  }
  if (view === 'service-placeholder') {
    return { service: state.viewData?.serviceId || null };
  }
  return {};
}

// Re-apply the sub-state carried in the URL when a view is opened by link.
function restoreViewStateFromUrl(view) {
  const params = getUrlParams();
  if (view === 'clothes-system' && typeof restoreClothesTabFromUrl === 'function') {
    restoreClothesTabFromUrl();
  }
  if (view === 'ads-studio' && typeof restoreAdsStudioTabFromUrl === 'function') {
    restoreAdsStudioTabFromUrl();
  }
  if (view === 'service-placeholder' && params.service) {
    state.viewData = { serviceId: params.service };
  }
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

// Update browser URL without reload. Carries the view's sub-state (Clothes
// tab, service id) so the address always reproduces the screen you are on.
function updateUrlForView(view, replace = false) {
  const path = VIEW_TO_PATH[view] || '/';
  const sub = viewUrlParamsFor(view);
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(sub)) {
    if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
  }
  const qs = search.toString();
  const newUrl = window.location.origin + path + (qs ? `?${qs}` : '');

  // Already on this exact address: don't push a duplicate history entry, but
  // still stamp {view} on the current entry — otherwise the initial entry
  // keeps a null state and popstate falls back to services-hub/Restricted.
  const samePlace = window.location.pathname === path
    && (window.location.search || '') === (qs ? `?${qs}` : '');
  if (samePlace) {
    try { window.history.replaceState({ view }, '', newUrl); } catch (_) {}
    return;
  }

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
    // The address in the bar is the source of truth after back/forward:
    // re-apply the view's sub-state (Clothes tab, service id) before rendering.
    restoreViewStateFromUrl(view);
    // Navigate without pushing to history (already handled by popstate)
    navigateToInternal(view, false);

    // Also restore modal state from URL params
    restoreModalFromUrl();
  });
}

// Every modal that has a shareable link: how to (re)open it from ?modal=&id=.
// `open` re-runs the real opener so the modal's temp state (variants, split
// lines, idempotency keys…) is initialised exactly as a click would.
// Security note: recovery-key / password-reset / change-password are
// deliberately NOT linkable — a URL must never resurrect a secrets dialog.
const MODAL_URL_HANDLERS = {
  'ad':               { newOpen: () => showAdModal(),        open: (id) => editAd(id) },
  'receipt':          { newOpen: () => showReceiptModal(),   open: (id) => editReceipt(id) },
  'customer':         { newOpen: () => showCustomerModal(),  open: (id) => editCustomer(id) },
  'page':             { newOpen: () => showPageModal(),      open: (id) => editPage(id) },
  'user':             { newOpen: () => showUserModal(),      open: (id) => editUser(id) },
  'split-payments':   { open: (id) => manageSplitPayments(id) },
  'top-ups':          { open: (id) => manageTopUps(id) },
  'refund':           { open: (id) => manageRefund(id) },
  'receipt-transfer': { open: (id) => showReceiptTransferModal(id) },
  'collect-receipt':  { open: (id) => openCollectReceiptModal(id) },
  'permissions':      { open: (id) => showPermissionsModal(id) },
  'wallet-topup':     { open: (id) => showWalletTopupModal(id) },
  'clothes-product':  { newOpen: () => showClothesProductModal(),  open: (id) => editClothesProduct(id) },
  'clothes-shipment': { newOpen: () => showClothesShipmentModal(), open: (id) => editClothesShipment(id) },
  'clothes-order':    { newOpen: () => showClothesOrderModal(),    open: (id) => editClothesOrder(id) }
};

// Restore modal from URL params (e.g., ?modal=ad&id=123 or ?modal=ad&id=new)
// The modal/id present in the URL when the app FIRST loaded — captured now,
// during module evaluation, BEFORE init() calls updateUrlForView() which
// rebuilds the query from viewUrlParamsFor() and drops ?modal&id. Without this,
// refreshing or sharing a dialog deep-link never reopened the dialog.
let _bootModalParams = (() => {
  try { const p = getUrlParams(); return (p && p.modal && p.id) ? { modal: p.modal, id: p.id } : null; }
  catch (_) { return null; }
})();

function restoreModalFromUrl() {
  let params = getUrlParams();
  // On first load the boot URL was already rewritten by updateUrlForView, so
  // fall back to the captured boot params (one-shot).
  const fromBoot = (!params || !params.modal) && !!_bootModalParams;
  if (fromBoot) params = _bootModalParams;
  _bootModalParams = null;

  if (params.modal) {
    const handler = MODAL_URL_HANDLERS[params.modal];
    if (!handler || !params.id) return;

    // A blank create form must never be resurrected from the boot URL. Every
    // showXModal() stamps ?modal=X&id=new, so that param survives a refresh and
    // would reopen an empty dialog on EVERY load — a full-screen overlay that
    // swallows all clicks (sidebar included) until it is closed by hand.
    // Back/forward within the session still reopens it; only boot is skipped.
    if (fromBoot && params.id === 'new') {
      updateUrlForView(state.currentView, true);
      return;
    }

    // Re-open via the real opener so permissions are re-checked and the
    // modal's temp state is seeded properly.
    setTimeout(() => {
      try {
        if (params.id === 'new') {
          if (handler.newOpen) handler.newOpen();
          return;
        }
        if (handler.open) handler.open(params.id);
        // The record is gone (deleted after the link was made): the edit modals
        // still mark themselves active and paint an all-but-empty overlay that
        // blocks the whole app. Every opener that finds its record populates
        // modalData, so active-without-data means "not found" — tear it down.
        if (state.activeModal && !state.modalData) closeModal();
      } catch (e) {
        console.warn('[restoreModalFromUrl] failed to open', params.modal, e?.message || e);
        closeModal(); // never leave a half-built overlay blocking every click
      }
    }, 100);
  } else {
    // No modal in URL, close any open modal
    if (state.activeModal) {
      state.activeModal = null;
      state.modalData = null;
      // Discard pending unsaved modal state so it cannot leak into the next
      // record (same cleanup closeModal does — the browser-back path bypasses
      // closeModal and previously left these dangling).
      state.tempAdFunding = null;
      state.tempMergeFunding = null;
      state.tempAdPhotos = [];
      state.tempReceiptPhotos = [];
      state.tempAdPhotosDirty = false;
      state.tempReceiptPhotosDirty = false;
      _adPhotoUploadGeneration++;
      _receiptPhotoUploadGeneration++;
      _adPhotoUploadsInFlight = 0;
      _receiptPhotoUploadsInFlight = 0;
      tempTopUps = [];
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
    showNotification(state.language === 'ar' ? 'غير متاح' : 'Restricted', state.language === 'ar' ? 'هذه الميزات مخفية حالياً' : 'These features are hidden for now', 'info');
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.isMobileMenuOpen = false;
    if (pushHistory) updateUrlForView(state.currentView);
    debouncedSaveState();
    requestViewScrollReset();
    render();
    return;
  }
  
  // Check permission (Admin always allowed)
  if (!isCurrentUserAdmin() && !userCanAccessView(state.currentUser, view)) {
    // Special views that don't need permissions (delivery dashboard is for
    // the Delivery role only — other roles must hold a real permission)
    const isExempt = view === 'no-access' ||
      (view === 'delivery-dashboard' && isDeliveryRole(state.currentUser?.role));
    if (!isExempt) {
      showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية' : `You don't have permission to access this page`, 'error');
      return;
    }
  }
  
  // PERFORMANCE: Update state and render immediately (don't wait for save)
  const wasMobileMenuOpen = state.isMobileMenuOpen;
  state.currentView = view;
  state.isMobileMenuOpen = false;
  
  // Update URL
  if (pushHistory) {
    updateUrlForView(view);
  }
  
  // Render immediately for instant feedback
  requestViewScrollReset();
  // The drawer belongs to the outer shell. When the user taps the already
  // active page, the inner view HTML is unchanged, so a partial render is a
  // deliberate no-op and cannot close the drawer. Rebuild the shell only for
  // this navigation case.
  if (wasMobileMenuOpen) forceFullRender();
  else render();
  
  // Save in background (debounced - doesn't block UI)
  debouncedSaveState();
}

function navigateTo(view) {
  navigateToInternal(view, true);
}

function toggleMobileMenu() {
  state.isMobileMenuOpen = !state.isMobileMenuOpen;
  // The drawer/backdrop live outside the partial view container. A normal
  // same-view render can intentionally be a no-op when the page HTML did not
  // change, which used to make the hamburger appear completely unresponsive.
  forceFullRender();
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
  
  const isAr = state.language === 'ar';
  const commands = [
    { id: 'analytics', label: isAr ? 'التحليلات' : 'Analytics', icon: 'layout-dashboard', action: () => navigateTo('analytics') },
    { id: 'customers', label: isAr ? 'العملاء' : 'Customers', icon: 'smile', action: () => navigateTo('customers') },
    { id: 'receipts', label: isAr ? 'الوصولات' : 'Receipts', icon: 'receipt', action: () => navigateTo('receipts') },
    { id: 'pages', label: isAr ? 'الصفحات' : 'Pages', icon: 'file-text', action: () => navigateTo('pages') },
    { id: 'ads', label: isAr ? 'الإعلانات' : 'Ads', icon: 'megaphone', action: () => navigateTo('ads') },
    { id: 'deliveries', label: isAr ? 'التوصيلات' : 'Deliveries', icon: 'truck', action: () => navigateTo('deliveries') },
    { id: 'users', label: isAr ? 'المستخدمون' : 'Users', icon: 'users', action: () => navigateTo('users') },
    { id: 'settings', label: isAr ? 'الإعدادات' : 'Settings', icon: 'settings', action: () => navigateTo('settings') },
    { id: 'add-customer', label: isAr ? 'إضافة عميل' : 'Add Customer', icon: 'user-plus', action: () => { toggleCommandPalette(); showCustomerModal(); } },
    { id: 'add-ad', label: isAr ? 'إضافة إعلان' : 'Add Ad', icon: 'plus-circle', action: () => { toggleCommandPalette(); showAdModal(); } },
    { id: 'add-receipt', label: isAr ? 'إضافة وصل' : 'Add Receipt', icon: 'receipt', action: () => { toggleCommandPalette(); showReceiptModal(); } },
    { id: 'export', label: isAr ? 'تصدير البيانات' : 'Export Data', icon: 'download', action: () => { toggleCommandPalette(); exportData(); } },
    { id: 'dark-mode', label: isAr ? 'تبديل الوضع الداكن' : 'Toggle Dark Mode', icon: 'moon', action: () => { toggleCommandPalette(); toggleTheme(); } },
    { id: 'language', label: isAr ? 'تبديل اللغة' : 'Toggle Language', icon: 'globe', action: () => { toggleCommandPalette(); toggleLanguage(); } },
    { id: 'logout', label: isAr ? 'تسجيل الخروج' : 'Logout', icon: 'log-out', action: () => { toggleCommandPalette(); handleLogout(); } },
  ];
  
  const modal = document.createElement('div');
  modal.id = 'command-palette-modal';
  modal.className = 'mobile-dialog-overlay fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center pt-32 p-4';
  modal.onclick = toggleCommandPalette;
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-4 w-full max-w-2xl" onclick="event.stopPropagation()">
      <div class="flex items-center space-x-3 mb-4 pb-3 border-b border-slate-200 dark:border-slate-700">
        <i data-lucide="command" class="w-5 h-5 text-indigo-600"></i>
        <input 
          type="text" 
          id="command-search" 
          placeholder="${isAr ? 'اكتب أمراً أو ابحث...' : 'Type a command or search...'}"
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

// The customer-pages summary is a standalone body dialog rather than an
// `activeModal`. Handle its keys in capture phase so this runs before the
// lower-priority command-palette/modal shortcuts. That also prevents Ctrl/Cmd+K
// from opening a hidden palette behind the dialog.
document.addEventListener('keydown', (e) => {
  const dialog = document.getElementById('customer-pages-dialog');
  if (!dialog) return;
  const isEscape = e.key === 'Escape';
  const isCommandPaletteShortcut = (e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k';
  if (!isEscape && !isCommandPaletteShortcut) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!isEscape) return;
  if (typeof closeCustomerPagesDialog === 'function') closeCustomerPagesDialog();
  else dialog.remove();
}, true);

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
    showNotification(state.language === 'ar' ? 'تمت المزامنة' : 'Synced', state.language === 'ar' ? 'تم رفع البيانات إلى السحابة' : 'Data pushed to cloud', 'success');
    
  } catch (error) {
    console.error('Cloud push error:', error);
    state.cloudSyncStatus = 'error';
    renderSyncStatus();
    showNotification(state.language === 'ar' ? 'خطأ في المزامنة' : 'Sync Error', error.message, 'error');
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
        ${state.cloudSyncStatus === 'syncing' ? (state.language === 'ar' ? 'جارٍ المزامنة...' : 'Syncing...') : state.cloudSyncStatus === 'success' ? (state.language === 'ar' ? 'تمت المزامنة' : 'Synced') : state.cloudSyncStatus === 'error' ? (state.language === 'ar' ? 'خطأ' : 'Error') : (state.language === 'ar' ? 'جاهز' : 'Ready')}
      </span>
    </div>
  `;
  
  lucide.createIcons();
}
