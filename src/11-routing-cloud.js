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
    service: params.get('service'),
    customer: params.get('customer'),
    receipt: params.get('receipt')
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
  if (view === 'receipts') {
    const customerId = String(state.receiptCustomerFilter || '').trim();
    const receiptId = String(state.receiptRecordFilter || '').trim();
    return {
      customer: Security.isValidRecordId(customerId) ? customerId : null,
      receipt: Security.isValidRecordId(receiptId) ? receiptId : null
    };
  }
  if (view === 'ads') {
    const receiptId = String(state.adReceiptFilter || '').trim();
    return { receipt: Security.isValidRecordId(receiptId) ? receiptId : null };
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
  if (view === 'receipts') {
    const customerFilter = params.customer && Security.isValidRecordId(params.customer)
      ? String(params.customer)
      : '';
    const receiptFilter = params.receipt && Security.isValidRecordId(params.receipt)
      ? String(params.receipt)
      : '';
    if (customerFilter || receiptFilter) {
      state.receiptSearch = '';
      state.receiptStatusFilter = 'all';
      state.receiptPaymentFilter = 'all';
      state.receiptDateFilter = 'all';
      state.receiptDebtFilter = 'all';
      state.receiptCollectedFilter = 'all';
      state.receiptSortBy = 'newest';
    }
    state.receiptCustomerFilter = customerFilter;
    state.receiptRecordFilter = receiptFilter;
  }
  if (view === 'ads') {
    const receiptFilter = params.receipt && Security.isValidRecordId(params.receipt)
      ? String(params.receipt)
      : '';
    if (receiptFilter) {
      state.adSearch = '';
      state.adFilters = { status: 'all', payment: 'all', page: 'all' };
    }
    state.adReceiptFilter = receiptFilter;
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

  // Stamp modal-pushed entries so closeModal() can tell "the top entry was
  // pushed for this dialog" and consume it with history.back() instead of
  // leaving a dead same-URL entry stacked (Back then degraded into N no-op
  // presses on phones). The timestamp lets the overlay observer
  // (01b-mobile-runtime.js) skip its sentinel for surfaces whose opener
  // already created a history entry (tracked modals, collect-receipt).
  const entryState = { view: state.currentView, params: newParams, albayanModal: !!newParams.modal };
  if (newParams.modal) _albayanLastModalUrlPushAt = Date.now();

  try {
    // Same-address guard (mirror of updateUrlForView's samePlace): the URL
    // restore path re-runs the real modal openers, whose own updateUrlParams
    // call must not push a DUPLICATE entry for the address being restored.
    const samePlace = newUrl === window.location.pathname + window.location.search;
    // Consume a live overlay sentinel (a chooser/palette surface replaced by
    // this modal in the same gesture — New Receipt chooser, command-palette
    // quick actions) by REPLACING it instead of stacking on top: a stranded
    // sentinel costs the user one dead Back press plus a scroll jump after
    // the modal closes. Mirrors navigateToInternal; see the overlay history
    // model in 01b-mobile-runtime.js.
    const topWasOverlaySentinel = !!(window.history.state && window.history.state.overlaySentinel);
    if (replace || samePlace || topWasOverlaySentinel) {
      window.history.replaceState(entryState, '', newUrl);
      if (topWasOverlaySentinel && typeof _overlaySentinelDepth === 'number' && _overlaySentinelDepth > 0) {
        _overlaySentinelDepth--;
      }
    } else {
      window.history.pushState(entryState, '', newUrl);
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
    // A history.back() issued by the app itself purely to consume an
    // overlay/modal entry (X/Cancel close — see the overlay history model in
    // 01b-mobile-runtime.js): the UI is already correct, and running the
    // router would only re-render and scroll-reset the unchanged view.
    if (typeof shouldSuppressOverlayPopstate === 'function' && shouldSuppressOverlayPopstate()) return;

    // Phone browsers: hardware/gesture Back closes the top-most open
    // overlay/modal/drawer — the same order as the packaged app's native
    // Back handler — instead of navigating the screen underneath it. The
    // popped entry is the surface's own sentinel/?modal entry, so the
    // address bar is already back at the pre-overlay URL and the pop is
    // fully consumed by the close. Desktop and Capacitor behaviour are
    // unchanged. Never call history.back()/forward() from here: the
    // re-fired popstate would re-run restoreModalFromUrl's opener and
    // clobber unsaved form state.
    if (typeof closeTopMobileSurface === 'function'
        && typeof isPhoneBrowserHistoryManaged === 'function'
        && isPhoneBrowserHistoryManaged()) {
      _closingSurfaceFromPopstate = true;
      let closedSurface = false;
      try { closedSurface = closeTopMobileSurface(); }
      finally { _closingSurfaceFromPopstate = false; }
      if (markOverlayPopClose(closedSurface)) return;
    }

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
    if (typeof resetReceiptCustomerRiskWarningState === 'function') {
      resetReceiptCustomerRiskWarningState();
    }
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

// A closeModal() consume (history.back()/go(-2)) issued in this same task has
// not landed yet — history traversal is async, so pushing the new view NOW
// would stack it on top of the very entries the traversal is about to pop,
// and the traversal would then strand the user on a stale ?modal entry that a
// later Back resurrects (e.g. duplicate-serial warning → "View Customer").
// Wait for the suppressed bookkeeping popstate before stamping the URL, with
// a short fallback timeout in case the traversal is silently dropped at the
// session-history edge. See the overlay history model in 01b-mobile-runtime.js.
function _pushViewUrlAfterHistoryConsume(view) {
  let done = false;
  let fallbackTimer = null;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', onConsumePop);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    // A newer navigation owns the address bar by now — never stamp a stale view.
    if (state.currentView !== view) return;
    const consumesOverlaySentinel = !!(window.history.state && window.history.state.overlaySentinel);
    updateUrlForView(view, consumesOverlaySentinel);
  };
  // Push AFTER the popstate dispatch finishes so the router's own listener
  // (which swallows this bookkeeping pop) always sees the untouched entry.
  const onConsumePop = () => { setTimeout(finish, 0); };
  window.addEventListener('popstate', onConsumePop);
  fallbackTimer = setTimeout(finish, 300);
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
    // Special views that don't need permissions. The Delivery role is granted
    // both the delivery dashboard AND the deliveries tab unconditionally by the
    // nav gates (canOpenWorkspaceView, renderSidebar, renderMobileBottomNavigation),
    // so the router must exempt both — otherwise a driver lacking deliveries.viewOwn
    // sees a "Delivery" tab that only pops an Access Denied toast (dead button).
    // Other roles still need a real permission for either view.
    const isExempt = view === 'no-access' ||
      ((view === 'delivery-dashboard' || view === 'deliveries') && isDeliveryRole(state.currentUser?.role));
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
    if (typeof _overlayHistoryConsumePending === 'function'
        && typeof isPhoneBrowserHistoryManaged === 'function'
        && isPhoneBrowserHistoryManaged()
        && _overlayHistoryConsumePending()) {
      // closeModal() in this same gesture issued an entry-consume that has
      // not landed yet — defer the push or it stacks on doomed entries.
      _pushViewUrlAfterHistoryConsume(view);
    } else {
      // If the top history entry is an overlay sentinel (the nav drawer or a
      // command-palette style surface pushed it and this navigation closes
      // it), REPLACE that entry instead of pushing: the sentinel is consumed
      // and Back from the new view returns to the pre-overlay screen in one
      // press. See the overlay history model in 01b-mobile-runtime.js.
      const consumesOverlaySentinel = !!(window.history.state && window.history.state.overlaySentinel);
      updateUrlForView(view, consumesOverlaySentinel);
    }
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
  // Phone-browser Back parity: one consumable history entry per drawer open
  // (the drawer renders inside #app, so the body overlay observer in
  // 01b-mobile-runtime.js cannot see it — push/consume explicitly here).
  if (typeof isPhoneBrowserHistoryManaged === 'function' && isPhoneBrowserHistoryManaged()) {
    if (state.isMobileMenuOpen) {
      pushMobileOverlayHistoryEntry();
    } else if (window.history.state && window.history.state.overlaySentinel && _overlaySentinelDepth > 0) {
      _overlaySentinelDepth--;
      consumeOverlayHistoryEntry();
    }
  }
  // The drawer/backdrop live outside the partial view container. A normal
  // same-view render can intentionally be a no-op when the page HTML did not
  // change, which used to make the hamburger appear completely unresponsive.
  forceFullRender();
}

// ==========================================
// COMMAND PALETTE
// ==========================================

let _commandPaletteSearchTimer = null;

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

function closeCommandPalette() {
  if (_commandPaletteSearchTimer) {
    clearTimeout(_commandPaletteSearchTimer);
    _commandPaletteSearchTimer = null;
  }
  state.commandPaletteOpen = false;
  renderCommandPalette();
}

function commandPaletteNavigate(view, beforeNavigate = null) {
  closeCommandPalette();
  if (typeof beforeNavigate === 'function') beforeNavigate();
  navigateTo(view);
}

function getCommandPaletteBaseCommands() {
  const isAr = state.language === 'ar';
  const commands = [];
  const addView = (id, view, label, icon) => {
    if (typeof canOpenWorkspaceView === 'function' && !canOpenWorkspaceView(view)) return;
    commands.push({ id, label, icon, section: isAr ? 'الصفحات' : 'Pages', action: () => commandPaletteNavigate(view) });
  };

  addView('analytics', 'analytics', isAr ? 'التحليلات' : 'Analytics', 'layout-dashboard');
  addView('customers', 'customers', isAr ? 'العملاء' : 'Customers', 'users');
  addView('receipts', 'receipts', isAr ? 'الوصولات' : 'Receipts', 'receipt');
  addView('pages', 'pages', isAr ? 'الصفحات' : 'Pages', 'file-text');
  addView('ads', 'ads', isAr ? 'الإعلانات' : 'Ads', 'megaphone');
  addView('deliveries', 'deliveries', isAr ? 'التوصيلات' : 'Deliveries', 'truck');

  if (isAdminRole(state.currentUser?.role) || currentUserHasPermission('analytics', 'view')) {
    commands.push({ id: 'reconciliation', label: isAr ? 'التسوية' : 'Reconciliation', icon: 'clipboard-check', section: isAr ? 'الصفحات' : 'Pages', action: () => commandPaletteNavigate('reconciliation') });
  }
  if (isAdminRole(state.currentUser?.role) || currentUserHasPermission('users', 'view') || currentUserHasPermission('users', 'viewOwn')) {
    commands.push({ id: 'users', label: isAr ? 'المستخدمون' : 'Users', icon: 'users-round', section: isAr ? 'الصفحات' : 'Pages', action: () => commandPaletteNavigate('users') });
  }
  if (isAdminRole(state.currentUser?.role) || currentUserHasPermission('settings', 'view') || currentUserHasPermission('settings', 'viewOwn')) {
    commands.push({ id: 'settings', label: isAr ? 'الإعدادات' : 'Settings', icon: 'settings', section: isAr ? 'الصفحات' : 'Pages', action: () => commandPaletteNavigate('settings') });
  }

  if (can('customers', 'add')) {
    commands.push({ id: 'add-customer', label: isAr ? 'إضافة عميل جديد' : 'Add new customer', icon: 'user-plus', section: isAr ? 'إجراءات سريعة' : 'Quick actions', action: () => { closeCommandPalette(); showCustomerModal(); } });
  }
  if (can('ads', 'add')) {
    commands.push({ id: 'add-ad', label: isAr ? 'إضافة إعلان جديد' : 'Add new ad', icon: 'plus-circle', section: isAr ? 'إجراءات سريعة' : 'Quick actions', action: () => { closeCommandPalette(); showAdModal(); } });
  }
  if (can('receipts', 'add')) {
    commands.push({ id: 'add-receipt', label: isAr ? 'إضافة وصل جديد' : 'Add new receipt', icon: 'receipt', section: isAr ? 'إجراءات سريعة' : 'Quick actions', action: () => { closeCommandPalette(); showNewReceiptChooser(); } });
  }
  if (isCurrentUserAdmin()) {
    commands.push({ id: 'export', label: isAr ? 'تصدير تقرير البيانات' : 'Export data report', icon: 'download', section: isAr ? 'إجراءات سريعة' : 'Quick actions', action: () => { closeCommandPalette(); exportData(); } });
  }

  commands.push(
    { id: 'workspace-mode', label: isAdvancedWorkspaceMode() ? (isAr ? 'استخدام العرض البسيط' : 'Use Simple view') : (isAr ? 'استخدام العرض المتقدم' : 'Use Advanced view'), icon: isAdvancedWorkspaceMode() ? 'sparkles' : 'sliders-horizontal', section: isAr ? 'التفضيلات' : 'Preferences', action: () => { closeCommandPalette(); toggleWorkspaceExperienceMode(); } },
    { id: 'dark-mode', label: isAr ? 'تبديل المظهر' : 'Change appearance', icon: 'moon', section: isAr ? 'التفضيلات' : 'Preferences', action: () => { closeCommandPalette(); toggleTheme(); } },
    { id: 'language', label: isAr ? 'التبديل إلى الإنجليزية' : 'Switch to Arabic', icon: 'globe', section: isAr ? 'التفضيلات' : 'Preferences', action: () => { closeCommandPalette(); toggleLanguage(); } },
    { id: 'logout', label: isAr ? 'تسجيل الخروج' : 'Log out', icon: 'log-out', section: isAr ? 'الحساب' : 'Account', action: () => { closeCommandPalette(); handleLogout(); } }
  );
  return commands;
}

function getCommandPaletteEntityCommands(searchTerm) {
  const rawTerm = Security.sanitizeInput(String(searchTerm || ''), { maxLength: 120 }).trim();
  if (rawTerm.length < 2) return [];
  const term = rawTerm.toLocaleLowerCase();
  const isAr = state.language === 'ar';
  const results = [];
  const matches = (...values) => values.some(value => String(value || '').toLocaleLowerCase().includes(term));
  const takeMatching = (records, predicate, limit = 5) => {
    const matchesFound = [];
    for (const record of records) {
      if (predicate(record)) matchesFound.push(record);
      if (matchesFound.length >= limit) break;
    }
    return matchesFound;
  };
  const canViewContacts = can('customers', 'viewContacts');

  if (typeof canOpenWorkspaceView !== 'function' || canOpenWorkspaceView('customers')) {
    const customers = typeof getCustomersVisibleToCurrentUser === 'function'
      ? getCustomersVisibleToCurrentUser()
      : getVisibleRecords(state.customers || []);
    takeMatching(customers, customer => {
      const phones = canViewContacts
        ? [customer.phone, customer.phoneNumber, ...(Array.isArray(customer.phones) ? customer.phones : [])]
        : [];
      return matches(customer.name, customer.id, ...phones);
    }).forEach((customer, index) => {
      const label = String(customer.name || (isAr ? 'عميل بدون اسم' : 'Unnamed customer'));
      const phone = canViewContacts
        ? String((Array.isArray(customer.phones) ? customer.phones.find(Boolean) : '') || customer.phone || customer.phoneNumber || '')
        : '';
      results.push({
        id: `entity-customer-${index}`,
        label,
        description: [isAr ? 'عميل' : 'Customer', phone].filter(Boolean).join(' • '),
        icon: 'user-round',
        section: isAr ? 'نتائج العملاء' : 'Customer results',
        action: () => commandPaletteNavigate('customers', () => {
          state.customerSearch = label;
          state.customerFinancialFilter = 'all';
        })
      });
    });
  }

  if (typeof canOpenWorkspaceView !== 'function' || canOpenWorkspaceView('receipts')) {
    const customersById = new Map((state.customers || []).map(customer => [String(customer.id), customer]));
    takeMatching(getReceiptsVisibleToCurrentUser(), receipt => {
      const customer = customersById.get(String(receipt.customerId));
      return matches(
        receipt.finalReceiptNo,
        receipt.serialNumber,
        receipt.tempReceiptNo,
        canViewContacts ? receipt.phoneNumber : '',
        customer?.name
      );
    }).forEach((receipt, index) => {
      const customer = customersById.get(String(receipt.customerId));
      const serial = String(receipt.finalReceiptNo || receipt.serialNumber || receipt.tempReceiptNo || '');
      results.push({
        id: `entity-receipt-${index}`,
        label: customer?.name || (isAr ? 'وصل' : 'Receipt'),
        description: `${isAr ? 'وصل' : 'Receipt'}${serial ? ` • ${serial}` : ''}`,
        icon: 'receipt',
        section: isAr ? 'نتائج الوصولات' : 'Receipt results',
        action: () => commandPaletteNavigate('receipts', () => {
          state.receiptSearch = serial || String(customer?.name || '');
          state.receiptStatusFilter = 'all';
          state.receiptPaymentFilter = 'all';
          state.receiptDateFilter = 'all';
          state.receiptDebtFilter = 'all';
          state.receiptCollectedFilter = 'all';
        })
      });
    });
  }

  if (typeof canOpenWorkspaceView !== 'function' || canOpenWorkspaceView('pages')) {
    takeMatching(getPagesVisibleToCurrentUser(), page => matches(page.name, page.category, page.id)).forEach((page, index) => {
      const label = String(page.name || (isAr ? 'صفحة بدون اسم' : 'Unnamed page'));
      results.push({
        id: `entity-page-${index}`,
        label,
        description: [isAr ? 'صفحة' : 'Page', page.category].filter(Boolean).join(' • '),
        icon: 'file-text',
        section: isAr ? 'نتائج الصفحات' : 'Page results',
        action: () => commandPaletteNavigate('pages', () => { state.pageSearch = label; })
      });
    });
  }

  if (typeof canOpenWorkspaceView !== 'function' || canOpenWorkspaceView('ads')) {
    const customersById = new Map((state.customers || []).map(customer => [String(customer.id), customer]));
    const pagesById = new Map((state.pages || []).map(page => [String(page.id), page]));
    takeMatching(getAdsVisibleToCurrentUser(), ad => {
      const customer = customersById.get(String(ad.customerId));
      const page = pagesById.get(String(ad.pageId || ad.page));
      return matches(ad.serialNumber, ad.id, canViewContacts ? ad.phoneNumber : '', customer?.name, page?.name);
    }).forEach((ad, index) => {
      const customer = customersById.get(String(ad.customerId));
      const page = pagesById.get(String(ad.pageId || ad.page));
      const searchValue = String(ad.serialNumber || customer?.name || page?.name || ad.id || '');
      results.push({
        id: `entity-ad-${index}`,
        label: customer?.name || (isAr ? 'إعلان' : 'Ad'),
        description: [isAr ? 'إعلان' : 'Ad', page?.name, ad.serialNumber].filter(Boolean).join(' • '),
        icon: 'megaphone',
        section: isAr ? 'نتائج الإعلانات' : 'Ad results',
        action: () => commandPaletteNavigate('ads', () => {
          state.adSearch = searchValue;
          state.adFilters = { status: 'all', payment: 'all', page: 'all' };
        })
      });
    });
  }
  return results.slice(0, 20);
}

function buildCommandPaletteCommands(searchTerm = '') {
  const term = String(searchTerm || '').trim().toLocaleLowerCase();
  const base = getCommandPaletteBaseCommands();
  const matchingBase = term
    ? base.filter(command => `${command.label} ${command.description || ''} ${command.section || ''}`.toLocaleLowerCase().includes(term))
    : base;
  return [...getCommandPaletteEntityCommands(searchTerm), ...matchingBase];
}

function renderCommandPaletteResults(commands) {
  const isAr = state.language === 'ar';
  if (!commands.length) {
    return `<div class="px-4 py-10 text-center text-sm text-slate-500"><i data-lucide="search-x" class="mx-auto mb-3 h-8 w-8 text-slate-300"></i>${isAr ? 'لا توجد نتائج مطابقة' : 'No matching results'}</div>`;
  }
  let lastSection = '';
  return commands.map(command => {
    const section = String(command.section || '');
    const heading = section && section !== lastSection
      ? `<div class="command-section-label">${Security.escapeHtml(section)}</div>`
      : '';
    lastSection = section;
    return `${heading}
      <button type="button" onclick="executeCommand('${Security.escapeHtml(command.id)}')" class="command-item w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800">
        <span class="command-item-icon"><i data-lucide="${Security.escapeHtml(command.icon)}" class="h-5 w-5"></i></span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-semibold text-slate-800 dark:text-white">${Security.escapeHtml(command.label)}</span>
          ${command.description ? `<span class="block truncate text-xs text-slate-500">${Security.escapeHtml(command.description)}</span>` : ''}
        </span>
        <i data-lucide="arrow-right" class="h-4 w-4 text-slate-400 rtl:rotate-180"></i>
      </button>`;
  }).join('');
}

function renderCommandPalette() {
  const existing = document.getElementById('command-palette-modal');
  if (existing) existing.remove();
  if (!state.commandPaletteOpen) return;

  const isAr = state.language === 'ar';
  const commands = buildCommandPaletteCommands('');
  const modal = document.createElement('div');
  modal.id = 'command-palette-modal';
  modal.className = 'mobile-dialog-overlay fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center pt-20 sm:pt-28 p-4';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'command-palette-title');
  modal.onclick = closeCommandPalette;
  modal.innerHTML = `
    <div class="command-palette-panel glass-panel rounded-2xl p-3 sm:p-4 w-full max-w-2xl" onclick="event.stopPropagation()">
      <h2 id="command-palette-title" class="sr-only">${isAr ? 'البحث الذكي والإجراءات السريعة' : 'Smart search and quick actions'}</h2>
      <div class="flex items-center gap-3 mb-3 pb-3 border-b border-slate-200 dark:border-slate-700">
        <i data-lucide="search" class="w-5 h-5 text-indigo-600"></i>
        <input type="search" id="command-search" placeholder="${isAr ? 'ابحث عن عميل أو وصل أو صفحة أو إعلان...' : 'Find a customer, receipt, page or ad...'}" class="min-w-0 flex-1 bg-transparent outline-none text-slate-800 dark:text-white" oninput="onCommandPaletteSearch(this.value)" aria-label="${isAr ? 'البحث في النظام' : 'Search the system'}" autocomplete="off" />
        <button type="button" onclick="closeCommandPalette()" class="touch-target flex h-10 w-10 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <div class="mb-2 px-2 text-xs text-slate-500">${isAr ? 'اكتب حرفين على الأقل للبحث في بيانات العمل' : 'Type at least 2 characters to search business records'}</div>
      <div id="command-results" class="space-y-1 max-h-[60dvh] overflow-y-auto custom-scrollbar">
        ${renderCommandPaletteResults(commands)}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  window.commandPaletteCommands = commands;
}

function filterCommands(searchTerm) {
  const results = document.getElementById('command-results');
  if (!results) return;
  const commands = buildCommandPaletteCommands(searchTerm);
  window.commandPaletteCommands = commands;
  results.innerHTML = renderCommandPaletteResults(commands);
  IconQueue.schedule(results);
}

function onCommandPaletteSearch(searchTerm) {
  if (_commandPaletteSearchTimer) clearTimeout(_commandPaletteSearchTimer);
  _commandPaletteSearchTimer = setTimeout(() => {
    _commandPaletteSearchTimer = null;
    filterCommands(searchTerm);
  }, 80);
}

function executeCommand(commandId) {
  const commands = window.commandPaletteCommands || [];
  const command = commands.find(item => item.id === commandId);
  if (command && typeof command.action === 'function') command.action();
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
