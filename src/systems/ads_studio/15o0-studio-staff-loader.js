// ==========================================
// ALBAYAN STUDIO — STAFF BUNDLE LOADER (studio.js; plan task P3-06b, M12)
// ==========================================
// The staff-only screens ship as their own lazy bundle, studio-staff.js (src/manifest.json "lazy"):
// the admin health section (15i), the Team desk sections (15p) and the admin tools (15q). Customers
// never download them, and studio.js keeps its headroom. This small loader stays in studio.js: it
// fetches studio-staff.js once (the URL comes from the script tag that provably loaded, with the
// same ?v=), shows a bilingual loading/retry card meanwhile, backs off 30 s after a failure and
// draws the screen again once the bundle is ready. Same pattern as src/15c0-ads-studio-loader.js.
//
// The one call both frames make is renderStudioStaffSection(section, route):
// - the v2 Team desk frame (15h) passes the section of the address and its route;
// - the classic review tab (15c) passes 'health' with no route: the admin health section alone.

let _studioStaffBundlePromise = null;
let _studioStaffBundleState = 'unloaded'; // 'loading' | 'ready' | 'failed'
let _studioStaffLastFailureAt = 0;
const _STUDIO_STAFF_RETRY_COOLDOWN_MS = 30000;

function _studioStaffBundleUrl() {
  // Derive from the script tag that provably loaded: correct under /studio/, Capacitor
  // (capacitor://localhost) and any static host. Version with the main bundle's ?v= (same deploy
  // = same version) when present.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, 'studio-staff.js');
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return 'studio-staff.js';
}

function studioStaffBundleReady() {
  return typeof renderStudioDeskSection === 'function' && typeof renderStudioHealthSection === 'function';
}

function ensureStudioStaffLoaded() {
  if (studioStaffBundleReady()) {
    _studioStaffBundleState = 'ready';
    return Promise.resolve();
  }
  if (_studioStaffBundlePromise) return _studioStaffBundlePromise;
  // Cooldown after a failure: every render calls this, and re-requesting looped offline.
  if (_studioStaffBundleState === 'failed' && Date.now() - _studioStaffLastFailureAt < _STUDIO_STAFF_RETRY_COOLDOWN_MS) return Promise.resolve();
  _studioStaffBundleState = 'loading';
  _studioStaffBundlePromise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _studioStaffBundleUrl();
    tag.onload = () => {
      _studioStaffBundleState = studioStaffBundleReady() ? 'ready' : 'failed';
      try { if (state.currentView === 'ads-studio') render(); } catch (_) {}
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      _studioStaffBundleState = 'failed';
      _studioStaffBundlePromise = null;
      _studioStaffLastFailureAt = Date.now();
      try { if (state.currentView === 'ads-studio') render(); } catch (_) {}
      resolve();
    };
    document.head.appendChild(tag);
  });
  return _studioStaffBundlePromise;
}

function retryStudioStaffLoad() {
  _studioStaffBundleState = 'unloaded';
  _studioStaffBundlePromise = null;
  _studioStaffLastFailureAt = 0;
  ensureStudioStaffLoaded();
  render();
}

// The card shown while the bundle downloads (or after it failed): the v2 frame's own look.
function renderStudioStaffLoadingState() {
  const isAr = state.language === 'ar';
  if (_studioStaffBundleState === 'failed') {
    return `
          <div class="studio-v2-soon studio-staff-loading" data-testid="studio-staff-bundle-failed" dir="${isAr ? 'rtl' : 'ltr'}" role="alert">
            <span class="studio-v2-soon-icon" aria-hidden="true"><i data-lucide="cloud-off" class="studio-v2-icon"></i></span>
            <h2 class="studio-v2-soon-title">${isAr ? 'تعذر تحميل مكتب الفريق' : "Couldn't load the Team desk"}</h2>
            <p class="studio-v2-soon-note">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
            <button type="button" onclick="retryStudioStaffLoad()" class="studio-v2-action is-primary" data-testid="studio-staff-bundle-retry">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>
          </div>`;
  }
  return `
          <div class="studio-v2-loading studio-staff-loading" data-testid="studio-staff-bundle-loading" dir="${isAr ? 'rtl' : 'ltr'}" role="status">
            <span class="studio-v2-spinner" aria-hidden="true"></span>
            <p>${isAr ? 'جارٍ تحميل مكتب الفريق…' : 'Loading the Team desk…'}</p>
          </div>`;
}

// section: one of the desk sections (15h STUDIO_V2_STAFF_SECTIONS); route: the v2 route, or null
// from the classic review tab (only the admin health section is drawn there).
function renderStudioStaffSection(section, route = null) {
  if (studioStaffBundleReady()) {
    _studioStaffBundleState = 'ready';
    if (!route) return String(section || '') === 'health' ? renderStudioHealthSection() : '';
    return renderStudioDeskSection(section, route);
  }
  ensureStudioStaffLoaded();
  return renderStudioStaffLoadingState();
}
