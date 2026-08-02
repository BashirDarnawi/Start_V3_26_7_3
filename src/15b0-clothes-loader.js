// ==========================================
// CLOTHES SYSTEM LAZY LOADER (main bundle)
// ==========================================
// The Clothes System ships as its own bundle (clothes.js, see
// src/manifest.json "lazy") so the main bundle keeps startup headroom.
// This loader stays in the main bundle: it fetches clothes.js once, renders
// a bilingual loading/retry card meanwhile, and re-renders when ready.

let _clothesBundlePromise = null;
let _clothesBundleState = 'unloaded'; // 'loading' | 'ready' | 'failed'

function _clothesBundleUrl() {
  // Derive from the script tag that provably loaded: correct under any base
  // path, Capacitor (capacitor://localhost), and any static host. Version
  // with the main bundle's ?v= (same deploy = same version) when present.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, 'clothes.js');
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return 'clothes.js';
}

function clothesBundleReady() {
  return typeof renderClothesSystemView === 'function';
}

function ensureClothesSystemLoaded() {
  if (clothesBundleReady()) {
    _clothesBundleState = 'ready';
    return Promise.resolve();
  }
  if (_clothesBundlePromise) return _clothesBundlePromise;
  _clothesBundleState = 'loading';
  _clothesBundlePromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _clothesBundleUrl();
    tag.onload = () => {
      _clothesBundleState = clothesBundleReady() ? 'ready' : 'failed';
      if (_clothesBundleState === 'ready' && state.currentView === 'clothes-system') {
        // A deep-linked ?tab= was skipped before the bundle existed.
        try { if (typeof restoreClothesTabFromUrl === 'function') restoreClothesTabFromUrl(); } catch (_) {}
        try { render(); } catch (_) {}
      }
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      _clothesBundleState = 'failed';
      _clothesBundlePromise = null;
      try { if (state.currentView === 'clothes-system') render(); } catch (_) {}
      resolve();
    };
    document.head.appendChild(tag);
  });
  return _clothesBundlePromise;
}

function retryClothesSystemLoad() {
  _clothesBundleState = 'unloaded';
  _clothesBundlePromise = null;
  ensureClothesSystemLoaded();
  render();
}

// Deep links open clothes modals before the bundle exists (?modal=clothes-*).
// Load first, then run the modal opener; drop silently on load failure — the
// view's own retry card is the recovery path.
function withClothesSystem(run) {
  if (clothesBundleReady()) { run(); return; }
  ensureClothesSystemLoaded().then(() => {
    try { if (clothesBundleReady()) run(); } catch (_) {}
  });
}

function renderClothesLoadingState() {
  const isAr = state.language === 'ar';
  if (_clothesBundleState === 'failed') {
    return `
      <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
        <i data-lucide="cloud-off" class="w-10 h-10 mx-auto text-slate-400 mb-3"></i>
        <p class="font-bold text-slate-800 dark:text-white">${isAr ? 'تعذر تحميل نظام الملابس' : "Couldn't load the Clothes System"}</p>
        <p class="text-sm text-slate-500 mt-1">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
        <button onclick="retryClothesSystemLoad()" class="mt-4 px-5 py-2.5 rounded-xl font-bold text-white bg-blue-600 hover:bg-blue-700">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>
      </div>`;
  }
  return `
    <div class="max-w-md mx-auto mt-16 glass-panel rounded-2xl p-8 text-center" dir="${isAr ? 'rtl' : 'ltr'}">
      <div class="w-8 h-8 mx-auto mb-3 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p class="text-sm text-slate-500">${isAr ? 'جاري تحميل نظام الملابس…' : 'Loading the Clothes System…'}</p>
    </div>`;
}

// Boot kick: clothes deep links download the bundle in parallel with init()'s
// storage work instead of waiting for first render.
if (/^\/clothes-system(\/|$)/.test(window.location.pathname || '')
  || /modal=clothes-/.test(window.location.search || '')) {
  try { ensureClothesSystemLoaded(); } catch (_) {}
}
