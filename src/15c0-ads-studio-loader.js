// ==========================================
// ADS STUDIO LAZY LOADER (main bundle)
// ==========================================
// The Ads Studio ships as studio.js (manifest "lazy") to keep startup headroom.
// This loader fetches it once, shows a bilingual loading/retry card meanwhile
// and redraws when it lands, but not before init() settles: its last render()
// draws it then, and an earlier draw showed the sign-in form (session unknown).

let _studioBundlePromise = null;
let _studioBundleState = 'unloaded'; // 'loading' | 'ready' | 'failed'
let _studioLastFailureAt = 0;
const _STUDIO_RETRY_COOLDOWN_MS = 30000;

function _studioBundleUrl() {
  // Beside the script tag that loaded (/studio/, Capacitor, any host), same ?v=.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, 'studio.js');
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return 'studio.js';
}

function adsStudioBundleReady() {
  return typeof renderAdsStudioView === 'function';
}

function ensureAdsStudioLoaded() {
  if (adsStudioBundleReady()) {
    _studioBundleState = 'ready';
    return Promise.resolve();
  }
  if (_studioBundlePromise) return _studioBundlePromise;
  // Cooldown after a failure: every render calls this, and re-requesting looped offline.
  if (_studioBundleState === 'failed' && Date.now() - _studioLastFailureAt < _STUDIO_RETRY_COOLDOWN_MS) return Promise.resolve();
  _studioBundleState = 'loading';
  _studioBundlePromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _studioBundleUrl();
    tag.onload = () => {
      _studioBundleState = adsStudioBundleReady() ? 'ready' : 'failed';
      if (_studioBundleState === 'ready' && state.currentView === 'ads-studio') {
        // A deep-linked ?tab= was skipped before the bundle existed.
        try { if (typeof restoreAdsStudioTabFromUrl === 'function') restoreAdsStudioTabFromUrl(); } catch (_) {}
        try { if (window.__albayanInitSettled === true) render(); } catch (_) {}
      }
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      _studioBundleState = 'failed';
      _studioBundlePromise = null;
      _studioLastFailureAt = Date.now();
      try { if (window.__albayanInitSettled === true && state.currentView === 'ads-studio') render(); } catch (_) {}
      resolve();
    };
    document.head.appendChild(tag);
  });
  return _studioBundlePromise;
}

function retryAdsStudioLoad() {
  _studioBundleState = 'unloaded';
  _studioBundlePromise = null;
  _studioLastFailureAt = 0;
  ensureAdsStudioLoaded();
  render();
}

function renderAdsStudioLoadingState() {
  const isAr = state.language === 'ar';
  if (_studioBundleState === 'failed') {
    return `
      <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
        <i data-lucide="cloud-off" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i>
        <p class="font-bold text-slate-800 dark:text-white">${isAr ? 'تعذر تحميل الاستوديو' : "Couldn't load the studio"}</p>
        <p class="text-sm text-slate-500 mt-1">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
        <button onclick="retryAdsStudioLoad()" class="mt-4 px-5 py-2.5 rounded-xl font-bold text-white bg-blue-600 hover:bg-blue-700">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>
      </div>`;
  }
  return `
    <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
      <div class="w-8 h-8 mx-auto mb-3 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-sm text-slate-500">${isAr ? 'جاري تحميل الاستوديو…' : 'Loading the studio…'}</p>
    </div>`;
}

// Boot kick: the studio shell and studio deep links download the bundle in
// parallel with init()'s storage work instead of waiting for first render.
if (IS_STUDIO_SHELL || /^\/(ads-studio|studio)(\/|$)/.test(window.location.pathname || '')) {
  try { ensureAdsStudioLoaded(); } catch (_) {}
}
