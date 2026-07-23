// ==========================================
// CAPACITOR MOBILE RUNTIME
// ==========================================
// Native Android Back handling and a clear connectivity notice for the
// packaged app. The web app keeps normal browser history/online behaviour.

let _mobileRuntimeReady = false;
let _mobileLastBackAt = 0;
let _mobileServerReachable = true;
let _mobileColdStartBlocked = false;

function getCapacitorAppPlugin() {
  try {
    return window.Capacitor?.Plugins?.App || null;
  } catch (_) {
    return null;
  }
}

function isPackagedMobileApp() {
  return !!(typeof Platform !== 'undefined' && Platform.isCapacitor);
}

// Connectivity notices/gate apply to the packaged app AND phone browsers:
// a phone-browser user whose server is unreachable must see the retryable
// notice instead of a bare login screen (17-init.js calls this when defined).
function connectivityUiEnabled() {
  return isPackagedMobileApp() || (typeof Platform !== 'undefined' && Platform.isMobileBrowser === true);
}

function mobileRuntimeNeedsServer() {
  try {
    return typeof state === 'undefined' || String(state.serverModeOverride || 'auto') !== 'local';
  } catch (_) {
    return true;
  }
}

function mobileRuntimeIsArabic() {
  try { return typeof state !== 'undefined' && state.language === 'ar'; }
  catch (_) { return false; }
}

function removeMobileConnectivityNotice() {
  document.getElementById('mobile-connectivity-notice')?.remove();
}

function removeMobileConnectionGate() {
  document.getElementById('mobile-connection-gate')?.remove();
}

function renderMobileConnectionGate() {
  if (!connectivityUiEnabled() || !mobileRuntimeNeedsServer()) return;
  _mobileColdStartBlocked = true;
  removeMobileConnectivityNotice();
  const app = document.getElementById('app');
  if (!app) return;

  const isAr = mobileRuntimeIsArabic();
  const browserOffline = navigator.onLine === false;
  app.innerHTML = `
    <main id="mobile-connection-gate" class="min-h-screen flex items-center justify-center p-5" role="alert" aria-live="assertive">
      <section class="glass-panel w-full max-w-md rounded-3xl p-7 text-center">
        <div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          <i data-lucide="wifi-off" class="h-8 w-8" aria-hidden="true"></i>
        </div>
        <h1 class="text-2xl font-extrabold text-slate-900 dark:text-white">
          ${browserOffline
            ? (isAr ? 'لا يوجد اتصال بالإنترنت' : 'No internet connection')
            : (isAr ? 'تعذّر الوصول إلى الخادم' : 'Server unavailable')}
        </h1>
        <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          ${isAr
            ? 'لم يتم تسجيل خروجك. يجب أن يتصل البيان بالخادم للتحقق من جلستك وتحميل بياناتك بأمان.'
            : 'You have not been signed out. Albayan must reach the server to verify your session and safely load your data.'}
        </p>
        <button type="button" onclick="retryMobileConnection()" class="mt-6 min-h-12 w-full rounded-xl bg-amber-600 px-5 py-3 font-extrabold text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-60">
          ${isAr ? 'إعادة المحاولة' : 'Retry connection'}
        </button>
      </section>
    </main>`;
  try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(app); } catch (_) {}
}

function setMobileColdStartBlocked(blocked) {
  _mobileColdStartBlocked = blocked === true;
  if (_mobileColdStartBlocked) renderMobileConnectionGate();
  else removeMobileConnectionGate();
}

function showMobileConnectivityNotice({ serverReachable = _mobileServerReachable } = {}) {
  if (!connectivityUiEnabled() || !mobileRuntimeNeedsServer()) {
    removeMobileConnectivityNotice();
    return;
  }

  _mobileServerReachable = serverReachable !== false;
  if (_mobileColdStartBlocked) {
    renderMobileConnectionGate();
    return;
  }
  const browserOffline = navigator.onLine === false;
  if (!browserOffline && _mobileServerReachable) {
    removeMobileConnectivityNotice();
    return;
  }

  const isAr = mobileRuntimeIsArabic();
  let notice = document.getElementById('mobile-connectivity-notice');
  if (!notice) {
    notice = document.createElement('section');
    notice.id = 'mobile-connectivity-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.className = 'fixed inset-x-3 z-[120] mx-auto max-w-xl rounded-2xl border border-amber-300 bg-amber-50 p-3 text-amber-950 shadow-2xl dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100';
    notice.style.top = 'calc(var(--app-safe-top, 0px) + 0.75rem)';
    document.body.appendChild(notice);
  }

  const message = browserOffline
    ? (isAr ? 'لا يوجد اتصال بالإنترنت. ستبقى الشاشة الحالية ظاهرة، لكن الحفظ والمزامنة يحتاجان إلى الاتصال.' : 'No internet connection. Your current screen stays visible, but saving and syncing need a connection.')
    : (isAr ? 'تعذّر الوصول إلى خادم البيان. تحقق من الاتصال ثم أعد المحاولة.' : 'Albayan cannot reach the server. Check the connection and try again.');

  notice.innerHTML = `
    <div class="flex items-center gap-3">
      <i data-lucide="wifi-off" class="h-5 w-5 flex-none" aria-hidden="true"></i>
      <p class="min-w-0 flex-1 text-sm font-semibold">${message}</p>
      <button type="button" onclick="retryMobileConnection()" class="min-h-11 flex-none rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-60">
        ${isAr ? 'إعادة المحاولة' : 'Retry'}
      </button>
    </div>`;
  try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(notice); } catch (_) {}
}

async function retryMobileConnection() {
  if (!mobileRuntimeNeedsServer()) {
    removeMobileConnectivityNotice();
    return true;
  }
  const surface = document.getElementById('mobile-connection-gate') || document.getElementById('mobile-connectivity-notice');
  const button = surface?.querySelector('button');
  if (button) button.disabled = true;

  if (navigator.onLine === false) {
    if (_mobileColdStartBlocked) renderMobileConnectionGate();
    else showMobileConnectivityNotice({ serverReachable: false });
    return false;
  }

  let serverOk = false;
  try {
    serverOk = typeof apiHealthCheck === 'function' ? await apiHealthCheck() : true;
  } catch (_) {
    serverOk = false;
  }
  _mobileServerReachable = !!serverOk;

  if (!serverOk) {
    if (_mobileColdStartBlocked) renderMobileConnectionGate();
    else showMobileConnectivityNotice({ serverReachable: false });
    const retryButton = document.querySelector('#mobile-connection-gate button, #mobile-connectivity-notice button');
    if (retryButton) retryButton.disabled = false;
    return false;
  }

  removeMobileConnectivityNotice();
  removeMobileConnectionGate();
  if (typeof state !== 'undefined' && state.currentUser) {
    try {
      if (typeof serverLiveSyncOnce === 'function') await serverLiveSyncOnce();
    } catch (_) {
      showMobileConnectivityNotice({ serverReachable: false });
      return false;
    }
  } else {
    // A cold start while offline cannot restore the server session. Reload
    // only from the logged-out state so unsaved forms are never discarded.
    window.location.reload();
  }
  return true;
}

function updateMobileServerReachability(serverReachable) {
  _mobileServerReachable = serverReachable !== false;
  showMobileConnectivityNotice({ serverReachable: _mobileServerReachable });
}

function mobileSurfaceZIndex(element) {
  try {
    const computed = Number.parseInt(window.getComputedStyle(element).zIndex, 10);
    if (Number.isFinite(computed)) return computed;
  } catch (_) {}
  const classes = String(element?.className || '');
  const arbitrary = classes.match(/(?:^|\s)z-\[(\d+)\](?:\s|$)/);
  if (arbitrary) return Number(arbitrary[1]);
  const simple = classes.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
  return simple ? Number(simple[1]) : 0;
}

function getTopMobileSurface() {
  const surfaces = Array.from(document.querySelectorAll(
    '.mobile-dialog-overlay, #receipt-photo-viewer, #command-palette-modal'
  )).filter(element => element && element.isConnected !== false);
  return surfaces
    .map((element, domOrder) => ({ element, domOrder, zIndex: mobileSurfaceZIndex(element) }))
    .sort((a, b) => (a.zIndex - b.zIndex) || (a.domOrder - b.domOrder))
    .pop()?.element || null;
}

function clearGenericMobileModalState(surface) {
  // A standalone overlay can still own ?modal=&id= (currently the receipt
  // collection dialog). Never clear an underlying tracked app-modal.
  const hasTrackedModalUnderneath = !!(typeof state !== 'undefined' && state.activeModal);
  if (!hasTrackedModalUnderneath) {
    try {
      const params = typeof getUrlParams === 'function' ? getUrlParams() : null;
      if (params?.modal && typeof clearUrlParams === 'function') clearUrlParams(['modal', 'id']);
    } catch (_) {}
    if (typeof state !== 'undefined') state.modalData = null;
  }
  if (surface?.id === 'collect-receipt-modal') {
    try { if (typeof _collectReceiptId !== 'undefined') _collectReceiptId = null; } catch (_) {}
    try { if (typeof _collectTargetLYD !== 'undefined') _collectTargetLYD = 0; } catch (_) {}
    try { if (typeof _tempCollectPayments !== 'undefined') _tempCollectPayments = []; } catch (_) {}
  }
}

function closeTopMobileSurface() {
  const topSurface = getTopMobileSurface();
  if (!topSurface) {
    if (typeof state !== 'undefined' && state.isMobileMenuOpen) {
      state.isMobileMenuOpen = false;
      if (typeof forceFullRender === 'function') forceFullRender();
      else if (typeof render === 'function') render();
      return true;
    }
    return false;
  }

  if (topSurface.id === 'command-palette-modal') {
    if (typeof state !== 'undefined') state.commandPaletteOpen = false;
    topSurface.remove();
    return true;
  }

  if (topSurface.id === 'receipt-photo-viewer') {
    if (typeof closeReceiptPhotoViewer === 'function') closeReceiptPhotoViewer();
    else topSurface.remove();
    return true;
  }

  if (topSurface.id === 'customer-pages-dialog') {
    if (typeof closeCustomerPagesDialog === 'function') closeCustomerPagesDialog();
    else topSurface.remove();
    return true;
  }

  // This alert requires an explicit decision. Android Back follows the safe
  // "choose another customer" path instead of merely deleting the overlay and
  // leaving an unacknowledged customer selected underneath it.
  if (topSurface.id === 'receipt-customer-risk-warning') {
    if (typeof cancelReceiptCustomerRiskWarning === 'function') cancelReceiptCustomerRiskWarning();
    else topSurface.remove();
    return true;
  }

  if (topSurface.id === 'app-modal') {
    if (typeof closeModal === 'function') closeModal();
    else {
      topSurface.remove();
      clearGenericMobileModalState(topSurface);
    }
    return true;
  }

  // Delivery, collect, history and chooser dialogs are standalone overlays
  // without activeModal state. Clean their URL/working state as well as DOM.
  topSurface.remove();
  clearGenericMobileModalState(topSurface);
  return true;
}

function getMobileLandingView() {
  if (typeof state === 'undefined' || !state.currentUser) return '';
  if (typeof isAdminRole === 'function' && isAdminRole(state.currentUser.role)) return 'services-hub';
  if (typeof getPostLoginLandingViewForUser === 'function') {
    return getPostLoginLandingViewForUser(state.currentUser);
  }
  return state.currentView || '';
}

async function handleAndroidBackButton(event = {}) {
  if (closeTopMobileSurface()) {
    _mobileLastBackAt = 0;
    return;
  }

  const landingView = getMobileLandingView();
  const currentView = typeof state !== 'undefined' ? String(state.currentView || '') : '';
  if (landingView && currentView && currentView !== landingView) {
    _mobileLastBackAt = 0;
    if (event.canGoBack) window.history.back();
    else if (typeof navigateToInternal === 'function') navigateToInternal(landingView, true);
    return;
  }

  const now = Date.now();
  if (now - _mobileLastBackAt <= 2000) {
    const App = getCapacitorAppPlugin();
    if (App?.exitApp) await App.exitApp();
    return;
  }

  _mobileLastBackAt = now;
  const isAr = mobileRuntimeIsArabic();
  if (typeof showNotification === 'function') {
    showNotification(
      isAr ? 'الخروج من البيان' : 'Exit Albayan',
      isAr ? 'اضغط رجوع مرة أخرى للخروج.' : 'Press Back again to exit.',
      'info'
    );
  }
}

async function setupMobileRuntime() {
  // Phone browsers get the connectivity notice/gate too; the Android
  // backButton listener below stays Capacitor-only (plugin guards).
  if (_mobileRuntimeReady || !connectivityUiEnabled()) return;
  _mobileRuntimeReady = true;

  window.addEventListener('offline', () => showMobileConnectivityNotice({ serverReachable: false }));
  window.addEventListener('online', () => {
    // Browser connectivity returned; verify Albayan itself before hiding the
    // warning. This also restores a cold-start session when appropriate.
    retryMobileConnection().catch(() => showMobileConnectivityNotice({ serverReachable: false }));
  });
  showMobileConnectivityNotice({ serverReachable: navigator.onLine !== false });

  if (typeof Platform !== 'undefined' && Platform.isAndroid) {
    const App = getCapacitorAppPlugin();
    if (App?.addListener) {
      try {
        await App.addListener('backButton', handleAndroidBackButton);
      } catch (error) {
        console.warn('[MobileRuntime] Android Back listener unavailable:', error?.message || error);
      }
    }
  }
}

// ==========================================
// PHONE BROWSER BACK + OVERLAY HISTORY MODEL
// ==========================================
// DESIGN:
// 1) Tracked #app-modal dialogs push a ?modal=&id= entry on open
//    (updateUrlParams stamps it { albayanModal: true }); every OTHER
//    standalone surface (photo viewer, confirm dialogs, command palette) gets
//    one same-URL sentinel entry ({ overlaySentinel: true }) pushed centrally
//    by the <body> observer below, so the ~19 creation sites need no edits.
//    The nav drawer pushes its own sentinel in toggleMobileMenu because it
//    renders inside #app where the body observer cannot see it.
// 2) Hardware/gesture Back pops that entry; the popstate handler
//    (setupUrlRouting, 11-routing-cloud.js) closes the top surface via
//    closeTopMobileSurface() and stops — the view underneath never navigates
//    and unsaved form state (temp photos, top-ups…) survives.
// 3) Closing with X/Cancel/backdrop instead consumes the entry via
//    history.back() (closeModal, toggleMobileMenu, the observer), and that
//    popstate is flagged as bookkeeping so the router never re-renders or
//    scroll-resets the unchanged view.
// 4) A navigation that starts while a sentinel is on top REPLACES it
//    (navigateToInternal), keeping Back balanced after drawer/palette navs.
// 5) Capacitor keeps its native backButton path (isPackagedMobileApp() gates
//    the sentinel/popstate logic off); desktop keeps today's behaviour — no
//    sentinels, but closeModal still consumes its own ?modal entries.

let _overlaySentinelDepth = 0;          // sentinels pushed and not yet consumed this session
let _albayanLastModalUrlPushAt = 0;     // set by updateUrlParams({ modal… }) — see 11-routing-cloud.js
let _lastOverlayPopCloseAt = 0;         // a Back press just closed a surface (entry already popped)
let _suppressOverlayPopstateUntil = 0;  // our own balancing history.back() is in flight
let _closingSurfaceFromPopstate = false;

function isPhoneBrowserHistoryManaged() {
  return !isPackagedMobileApp() && typeof Platform !== 'undefined' && !!Platform.isMobile;
}

function pushMobileOverlayHistoryEntry() {
  if (!isPhoneBrowserHistoryManaged()) return;
  try {
    // Same-URL entry: Back pops it and the popstate handler turns the pop
    // into "close the top overlay". albayanModal is explicitly cleared so
    // closeModal() never mistakes a sentinel for a tracked-modal entry;
    // underAlbayanModal remembers that the dialog's own ?modal entry sits
    // directly beneath this sentinel (overlay opened late over a tracked
    // modal — e.g. the duplicate-serial warning), so closeModal() can
    // consume BOTH entries when it tears the whole stack down at once.
    window.history.pushState(
      Object.assign({}, window.history.state || {}, {
        overlaySentinel: true,
        albayanModal: false,
        underAlbayanModal: !!(window.history.state && window.history.state.albayanModal)
      }),
      '', window.location.href
    );
    _overlaySentinelDepth++;
  } catch (_) {}
}

function consumeOverlayHistoryEntry() {
  // Pop the entry that open pushed. The popstate this triggers is pure
  // bookkeeping (the surface is already closed), so flag it for the router.
  _suppressOverlayPopstateUntil = Date.now() + 800;
  try {
    window.history.back();
    return true;
  } catch (_) {
    _suppressOverlayPopstateUntil = 0;
    return false;
  }
}

function _overlayHistoryConsumePending() {
  return Date.now() < _suppressOverlayPopstateUntil;
}

function shouldSuppressOverlayPopstate() {
  const suppress = _overlayHistoryConsumePending();
  _suppressOverlayPopstateUntil = 0; // one-shot: never swallow a real Back
  return suppress;
}

function markOverlayPopClose(closed) {
  if (closed) {
    _lastOverlayPopCloseAt = Date.now();
    // The popped entry was the surface's sentinel/?modal entry. Depth may
    // under-count after a tracked-modal pop; under-counting only ever makes
    // the observer SKIP an auto-consume (the old status quo), never over-pop.
    if (_overlaySentinelDepth > 0) _overlaySentinelDepth--;
  }
  return !!closed;
}

// ==========================================
// CENTRAL OVERLAY OBSERVER (history + iOS body scroll lock)
// ==========================================
// Every standalone surface is appended directly to <body> (verified across
// src/), so one childList observer is the single hook for all creation
// sites: it pushes/consumes the sentinel entries above and toggles a body
// scroll lock while any dialog is open. The lock matters on iOS < 16, where
// overscroll-behavior (style.css) is unsupported: drags inside a dialog
// scrolled the page underneath, and at scrollTop 0 triggered pull-to-refresh
// — reloading the SPA and discarding half-filled forms. The existing CSS
// stays as the iOS 16+/Android fast path.

let _overlayObservedCount = 0;
let _scrollLockActive = false;
let _scrollLockY = 0;

function _overlaySurfaceCount() {
  return document.querySelectorAll(
    '.mobile-dialog-overlay, #receipt-photo-viewer, #command-palette-modal'
  ).length;
}

function _lockBodyScrollForOverlay() {
  if (_scrollLockActive) return;
  // Same media condition as the .mobile-dialog-overlay scroll rules in
  // style.css — phones and short landscape windows; desktop stays untouched.
  try {
    if (!window.matchMedia('(max-width: 900px), (max-height: 500px)').matches) return;
  } catch (_) { return; }
  _scrollLockY = window.scrollY || window.pageYOffset || 0;
  const bodyStyle = document.body.style;
  bodyStyle.position = 'fixed';
  bodyStyle.top = (-_scrollLockY) + 'px';
  bodyStyle.left = '0';
  bodyStyle.right = '0';
  bodyStyle.width = '100%';
  _scrollLockActive = true;
}

function _unlockBodyScrollForOverlay() {
  if (!_scrollLockActive) return;
  _scrollLockActive = false;
  const bodyStyle = document.body.style;
  bodyStyle.position = '';
  bodyStyle.top = '';
  bodyStyle.left = '';
  bodyStyle.right = '';
  bodyStyle.width = '';
  const y = _scrollLockY;
  window.scrollTo(0, y);
  // closeModal triggers render(), whose own scroll save/restore may read
  // scrollY as 0 while the body was still position:fixed — restore again
  // after that render had its chance to run.
  requestAnimationFrame(() => window.scrollTo(0, y));
}

function _handleOverlayDomChange() {
  const count = _overlaySurfaceCount();
  const previous = _overlayObservedCount;
  if (count === previous) return;
  _overlayObservedCount = count;

  if (count > previous) {
    // Surface(s) opened. If the opener itself just pushed a ?modal history
    // entry (all tracked #app-modal openers and the collect-receipt dialog
    // do, via updateUrlParams), Back already has an entry to consume — a
    // sentinel too would cost the user an extra Back press. One sentinel per
    // transition: batch-opens of several untracked surfaces in one task are
    // not a real flow.
    if (Date.now() - _albayanLastModalUrlPushAt > 400) {
      pushMobileOverlayHistoryEntry();
    }
  } else {
    // Surface(s) closed by their own X/Cancel/backdrop handler. A Back-press
    // close is excluded via _lastOverlayPopCloseAt (entry already popped),
    // and an in-flight closeModal consume via _overlayHistoryConsumePending.
    const backJustClosedIt = Date.now() - _lastOverlayPopCloseAt <= 300;
    const entryState = window.history.state;
    if (isPhoneBrowserHistoryManaged() && !backJustClosedIt && !_overlayHistoryConsumePending()) {
      if (entryState && entryState.overlaySentinel && _overlaySentinelDepth > 0) {
        _overlaySentinelDepth--;
        consumeOverlayHistoryEntry();
      } else if (entryState && entryState.albayanModal && count === 0
                 && (typeof state === 'undefined' || !state.activeModal)) {
        // Untracked ?modal surface (collect-receipt) closed by its inline
        // backdrop/X remove(): its own pushed entry is on top — consume it.
        consumeOverlayHistoryEntry();
      }
    }
  }

  if (count > 0 && previous === 0) _lockBodyScrollForOverlay();
  else if (count === 0 && previous > 0) _unlockBodyScrollForOverlay();
}

let _overlayObserverInstalled = false;
function setupOverlaySurfaceObserver() {
  if (_overlayObserverInstalled) return;
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  _overlayObserverInstalled = true;
  try {
    const observer = new MutationObserver(_handleOverlayDomChange);
    // childList only: all overlay surfaces are direct <body> children.
    observer.observe(document.body, { childList: true });
    _overlayObservedCount = _overlaySurfaceCount();
  } catch (_) {
    _overlayObserverInstalled = false;
  }
}
// script.js executes at the end of <body>, so document.body exists here.
setupOverlaySurfaceObserver();
