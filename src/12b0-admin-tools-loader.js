// ==========================================
// ADMIN TOOLS LAZY LOADER (main bundle)
// ==========================================
// The Control Center and the merge tools (page / ad / merge-all dialogs) are
// Admin-only and ship as their own bundle (admin-tools.js, see
// src/manifest.json "lazy") so the startup bundle keeps its 2.4 MiB budget.
// This loader stays in the main bundle: it fetches admin-tools.js once, is
// kicked as soon as an Admin session renders (so the tools are ready before
// the first tap), shows a bilingual loading/retry card for the Control Center
// meanwhile, and re-renders when the bundle arrives. Every cross-bundle call
// site is guarded with `typeof fn === 'function'`, so a slow network never
// throws — the merge buttons simply appear once the bundle is in.

let _adminToolsBundlePromise = null;
let _adminToolsBundleState = 'unloaded'; // 'loading' | 'ready' | 'failed'
// After a failed download the automatic warm-up backs off for a while so a
// missing/offline bundle never turns every render into a new request storm.
let _adminToolsLastFailureAt = 0;
const _ADMIN_TOOLS_RETRY_COOLDOWN_MS = 30000;

function _adminToolsBundleUrl() {
  // Derive from the script tag that provably loaded: correct under any base
  // path, Capacitor (capacitor://localhost), and any static host. Version with
  // the main bundle's ?v= (same deploy = same version) when present.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, 'admin-tools.js');
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return 'admin-tools.js';
}

function adminToolsBundleReady() {
  return typeof renderControlCenterView === 'function' && typeof showPageMergeDialog === 'function';
}

// Views whose HTML changes once the bundle exists (merge buttons, Control Center).
const _ADMIN_TOOLS_VIEWS = new Set(['control-center', 'ads', 'pages', 'customers']);

function ensureAdminToolsLoaded() {
  if (adminToolsBundleReady()) {
    _adminToolsBundleState = 'ready';
    return Promise.resolve();
  }
  if (_adminToolsBundlePromise) return _adminToolsBundlePromise;
  _adminToolsBundleState = 'loading';
  _adminToolsBundlePromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _adminToolsBundleUrl();
    tag.onload = () => {
      _adminToolsBundleState = adminToolsBundleReady() ? 'ready' : 'failed';
      if (_adminToolsBundleState === 'ready' && _ADMIN_TOOLS_VIEWS.has(String(state.currentView || ''))) {
        try { render(); } catch (_) {}
      }
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      _adminToolsBundleState = 'failed';
      _adminToolsBundlePromise = null;
      _adminToolsLastFailureAt = Date.now();
      try { if (state.currentView === 'control-center') render(); } catch (_) {}
      resolve();
    };
    document.head.appendChild(tag);
  });
  return _adminToolsBundlePromise;
}

function retryAdminToolsLoad() {
  _adminToolsBundleState = 'unloaded';
  _adminToolsBundlePromise = null;
  _adminToolsLastFailureAt = 0;
  ensureAdminToolsLoaded();
  render();
}

// Called from renderView(): Admins get the bundle warmed on their first render.
function preloadAdminToolsForCurrentUser() {
  try {
    if (_adminToolsBundleState === 'failed' && Date.now() - _adminToolsLastFailureAt < _ADMIN_TOOLS_RETRY_COOLDOWN_MS) return;
    if (typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin()) ensureAdminToolsLoaded();
  } catch (_) {}
}

function renderAdminToolsLoadingState() {
  const isAr = state.language === 'ar';
  if (_adminToolsBundleState === 'failed') {
    return `
      <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
        <i data-lucide="cloud-off" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i>
        <p class="font-bold text-slate-800 dark:text-white">${isAr ? 'تعذر تحميل مركز التحكم' : "Couldn't load the Control Center"}</p>
        <p class="text-sm text-slate-500 mt-1">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
        <button onclick="retryAdminToolsLoad()" class="touch-target mt-4 min-h-11 px-5 py-2.5 rounded-xl font-bold text-white bg-blue-600 hover:bg-blue-700">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>
      </div>`;
  }
  return `
    <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
      <div class="w-8 h-8 mx-auto mb-3 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-sm text-slate-500">${isAr ? 'جاري تحميل مركز التحكم…' : 'Loading the Control Center…'}</p>
    </div>`;
}

// Boot kick: a Control Center deep link downloads the bundle in parallel with
// init()'s storage work instead of waiting for the first render.
if (/^\/control-center(\/|$)/.test(window.location.pathname || '')) {
  try { ensureAdminToolsLoaded(); } catch (_) {}
}
