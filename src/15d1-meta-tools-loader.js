// META TOOLS LAZY LOADER (main bundle): the Meta Sync and Meta Insights
// dialogs ship as meta-tools.js (manifest "lazy") to keep the startup budget;
// the ad rows and headers that open them stay in 15d0-meta-ads-core.js. This
// loader fetches the bundle once, warms it when an Admin draws the Ads header,
// shows a bilingual loading/retry card if a dialog is asked for first, and the
// two openers below are the only way startup code reaches into the bundle.

let _metaToolsBundlePromise = null;
let _metaToolsBundleState = 'unloaded'; // 'loading' | 'ready' | 'failed'
// After a failed download the automatic warm-up backs off for a while so a
// missing/offline bundle never turns every render into a new request storm.
let _metaToolsLastFailureAt = 0;
const _META_TOOLS_RETRY_COOLDOWN_MS = 30000;
// The dialog asked for while the bundle was still downloading.
let _metaToolsPendingOpen = null;

function _metaToolsBundleUrl() {
  // Derive from the script tag that provably loaded: correct under any base
  // path, Capacitor (capacitor://localhost), and any static host. Version with
  // the main bundle's ?v= (same deploy = same version) when present.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, 'meta-tools.js');
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return 'meta-tools.js';
}

function metaToolsBundleReady() {
  return typeof openMetaAdsConnectionModalNow === 'function' && typeof openMetaInsightsModalNow === 'function';
}

function ensureMetaToolsLoaded() {
  if (metaToolsBundleReady()) {
    _metaToolsBundleState = 'ready';
    return Promise.resolve();
  }
  if (_metaToolsBundlePromise) return _metaToolsBundlePromise;
  // Cooldown after a failure: every Ads render warms this, and re-requesting looped offline.
  if (_metaToolsBundleState === 'failed' && Date.now() - _metaToolsLastFailureAt < _META_TOOLS_RETRY_COOLDOWN_MS) return Promise.resolve();
  _metaToolsBundleState = 'loading';
  _metaToolsBundlePromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _metaToolsBundleUrl();
    tag.onload = () => {
      if (metaToolsBundleReady()) {
        _metaToolsBundleState = 'ready';
      } else {
        // The file arrived but did not register its functions (a mismatched or truncated copy): the
        // same failed state as a lost request, with its cooldown, so a later open or Retry asks again.
        try { tag.remove(); } catch (_) {}
        _metaToolsBundleState = 'failed';
        _metaToolsBundlePromise = null;
        _metaToolsLastFailureAt = Date.now();
      }
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      _metaToolsBundleState = 'failed';
      _metaToolsBundlePromise = null;
      _metaToolsLastFailureAt = Date.now();
      resolve();
    };
    document.head.appendChild(tag);
  });
  return _metaToolsBundlePromise;
}

// Called while an Admin's Ads header renders: the first tap then opens at once.
function preloadMetaTools() {
  try {
    if (_metaToolsBundleState === 'failed' && Date.now() - _metaToolsLastFailureAt < _META_TOOLS_RETRY_COOLDOWN_MS) return;
    ensureMetaToolsLoaded();
  } catch (_) {}
}

// Run a dialog opener from the bundle: at once when it is loaded, otherwise
// behind the loading card. Closing the card (or a sign-out sweeping the
// overlays) cancels the open, so a late download never pops a dialog up.
function withMetaTools(run) {
  if (metaToolsBundleReady()) { run(); return; }
  _metaToolsPendingOpen = run;
  // Start (or reuse) the download first so the card shows its real state.
  const loading = ensureMetaToolsLoaded();
  renderMetaToolsLoadingCard();
  loading.then(_metaToolsSettlePendingOpen);
}

function _metaToolsSettlePendingOpen() {
  const card = document.getElementById('meta-tools-loading');
  if (!metaToolsBundleReady()) {
    if (card) renderMetaToolsLoadingCard();
    return;
  }
  const run = _metaToolsPendingOpen;
  _metaToolsPendingOpen = null;
  if (!card) return;
  card.remove();
  try { if (run) run(); } catch (_) {}
}

function retryMetaToolsLoad() {
  _metaToolsBundleState = 'unloaded';
  _metaToolsBundlePromise = null;
  _metaToolsLastFailureAt = 0;
  const loading = ensureMetaToolsLoaded();
  if (document.getElementById('meta-tools-loading')) renderMetaToolsLoadingCard();
  loading.then(_metaToolsSettlePendingOpen);
}

function closeMetaToolsLoadingCard() {
  _metaToolsPendingOpen = null;
  document.getElementById('meta-tools-loading')?.remove();
}

function renderMetaToolsLoadingCard() {
  const isAr = state.language === 'ar';
  let overlay = document.getElementById('meta-tools-loading');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'meta-tools-loading';
    overlay.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center overflow-hidden bg-slate-900/60 p-2 backdrop-blur-sm sm:items-center sm:p-4';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.onclick = event => { if (event.target === overlay) closeMetaToolsLoadingCard(); };
    document.body.appendChild(overlay);
  }
  const failed = _metaToolsBundleState === 'failed';
  overlay.setAttribute('aria-label', failed ? (isAr ? 'تعذر تحميل أدوات Meta' : "Couldn't load the Meta tools") : (isAr ? 'جاري تحميل أدوات Meta…' : 'Loading the Meta tools…'));
  const body = failed
    ? `<i data-lucide="cloud-off" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i>
        <p class="font-bold text-slate-800 dark:text-white">${isAr ? 'تعذر تحميل أدوات Meta' : "Couldn't load the Meta tools"}</p>
        <p class="text-sm text-slate-500 mt-1">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
        <button type="button" onclick="retryMetaToolsLoad()" class="touch-target mt-4 min-h-11 px-5 py-2.5 rounded-xl font-bold text-white bg-blue-600 hover:bg-blue-700">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>`
    : `<div class="w-8 h-8 mx-auto mb-3 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-sm text-slate-500">${isAr ? 'جاري تحميل أدوات Meta…' : 'Loading the Meta tools…'}</p>`;
  overlay.innerHTML = `<div class="glass-panel w-full max-w-md rounded-2xl p-6 text-center shadow-2xl" dir="${isAr ? 'rtl' : 'ltr'}" onclick="event.stopPropagation()">
      <div class="flex justify-end"><button type="button" onclick="closeMetaToolsLoadingCard()" class="touch-target rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button></div>
      ${body}
    </div>`;
  IconQueue.schedule(overlay);
}

// The two entry points the Ads header and ad rows call (inline onclick).
function openMetaAdsConnectionModal(adId = '') {
  withMetaTools(() => openMetaAdsConnectionModalNow(adId));
}

function openMetaInsightsModal() {
  withMetaTools(() => openMetaInsightsModalNow());
}
