// ==========================================
// ALBAYAN STUDIO — LAZY BUNDLE LOADER (studio.js; plan tasks P3-06b, M12; stage 15 size cap)
// ==========================================
// Two parts of the studio ship as their own lazy bundles (src/manifest.json "lazy"), so studio.js
// keeps its headroom under the 1 MiB budget and nobody downloads what they never open:
// - studio-staff.js: the admin health section (15i), the Team desk sections (15p) and the admin
//   tools (15q). Customers never download it.
// - studio-pages.js: Pages & replies, the page-link request and the help guides (15o). Fetched when
//   the replies or posts tab is drawn, when a screen asks for guide links, when the Help list draws
//   the guides card, and by the classic Replies / Posts tabs (15f) before they hand over.
// This small loader stays in studio.js: ensureStudioBundle(name) fetches a bundle once (the URL comes
// from the script tag that provably loaded, with the same ?v=), keeps one promise per bundle, backs
// off 30 s after a failure, shows a bilingual loading/retry card meanwhile and draws the screen again
// once the bundle is ready. Same pattern as src/15c0-ads-studio-loader.js.
//
// The calls the other files make (each guarded with typeof at its call site):
// - renderStudioStaffSection(section, route): the v2 Team desk frame (15h) passes the section of the
//   address and its route; the classic review tab (15c) passes 'health' with no route;
// - studioBundleScreen(name): the shell (15h) for a tab whose screen lives in a lazy bundle;
// - studioGuideLinks(keys, testId): guide links for a screen (15k, 15m): the bundle is asked for,
//   the links appear with the next draw;
// - studioPagesClassicHandover(tab): the classic Replies / Posts tabs (15f) while /me says v2.

const STUDIO_LAZY_BUNDLES = Object.freeze({
  'studio-staff.js': Object.freeze({
    key: 'staff',
    ready: () => typeof renderStudioDeskSection === 'function' && typeof renderStudioHealthSection === 'function',
    loading: ['Loading the Team desk…', 'جارٍ تحميل مكتب الفريق…'],
    failed: ["Couldn't load the Team desk", 'تعذر تحميل مكتب الفريق']
  }),
  'studio-pages.js': Object.freeze({
    key: 'pages',
    ready: () => typeof renderStudioPagesBody === 'function' && typeof studioGuideOpen === 'function',
    loading: ['Loading pages and guides…', 'جارٍ تحميل الصفحات والأدلة…'],
    failed: ["Couldn't load pages and guides", 'تعذر تحميل الصفحات والأدلة']
  })
});
const _STUDIO_BUNDLE_RETRY_COOLDOWN_MS = 30000;
const _studioBundles = new Map();  // name -> { state: 'unloaded' | 'loading' | 'ready' | 'failed', promise, failedAt }

function _studioBundleSlot(name) {
  const key = String(name || '');
  if (!Object.prototype.hasOwnProperty.call(STUDIO_LAZY_BUNDLES, key)) return null;
  if (!_studioBundles.has(key)) _studioBundles.set(key, { state: 'unloaded', promise: null, failedAt: 0 });
  return _studioBundles.get(key);
}

function _studioLazyBundleUrl(name) {
  // Derive from the script tag that provably loaded: correct under /studio/, Capacitor
  // (capacitor://localhost) and any static host. Version with the main bundle's ?v= (same deploy
  // = same version) when present.
  try {
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
      const src = String(tags[i].src || '');
      if (/script(\.min)?\.js(\?|$)/.test(src)) {
        const parts = src.split('?');
        const base = parts[0].replace(/script(\.min)?\.js$/, name);
        return parts[1] ? base + '?' + parts[1] : base;
      }
    }
  } catch (_) {}
  return name;
}

// True once the bundle's functions are here (readyCheck: the bundle's own check, or a caller's).
function studioBundleReady(name, readyCheck = null) {
  const bundle = STUDIO_LAZY_BUNDLES[String(name || '')];
  if (!bundle) return false;
  const check = typeof readyCheck === 'function' ? readyCheck : bundle.ready;
  try { return check() === true; } catch (_) { return false; }
}

function studioBundleState(name) {
  const slot = _studioBundleSlot(name);
  return slot ? slot.state : 'unknown';
}

// Fetches the bundle once; resolves when it is here or when the attempt ended (never rejects).
function ensureStudioBundle(name, readyCheck = null) {
  const slot = _studioBundleSlot(name);
  if (!slot) return Promise.resolve();
  if (studioBundleReady(name, readyCheck)) {
    slot.state = 'ready';
    return Promise.resolve();
  }
  if (slot.promise) return slot.promise;
  // Cooldown after a failure: every render calls this, and re-requesting looped offline.
  if (slot.state === 'failed' && Date.now() - slot.failedAt < _STUDIO_BUNDLE_RETRY_COOLDOWN_MS) return Promise.resolve();
  slot.state = 'loading';
  slot.promise = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = _studioLazyBundleUrl(name);
    tag.onload = () => {
      if (studioBundleReady(name, readyCheck)) {
        slot.state = 'ready';
      } else {
        // The file arrived but did not register its functions (a mismatched or truncated copy): the
        // same failed state as a lost request, with its cooldown, so a later draw or Retry asks again.
        try { tag.remove(); } catch (_) {}
        slot.state = 'failed';
        slot.promise = null;
        slot.failedAt = Date.now();
      }
      try { if (state.currentView === 'ads-studio') render(); } catch (_) {}
      resolve();
    };
    tag.onerror = () => {
      // A failed classic script created no bindings: retry is safe.
      try { tag.remove(); } catch (_) {}
      slot.state = 'failed';
      slot.promise = null;
      slot.failedAt = Date.now();
      try { if (state.currentView === 'ads-studio') render(); } catch (_) {}
      resolve();
    };
    document.head.appendChild(tag);
  });
  return slot.promise;
}

function retryStudioBundle(name) {
  const slot = _studioBundleSlot(name);
  if (!slot) return;
  slot.state = 'unloaded';
  slot.promise = null;
  slot.failedAt = 0;
  ensureStudioBundle(name);
  render();
}

// The card shown while a bundle downloads (or after it failed): the v2 frame's own look.
function renderStudioBundleCard(name) {
  const bundle = STUDIO_LAZY_BUNDLES[String(name || '')];
  if (!bundle) return '';
  const isAr = state.language === 'ar';
  if (studioBundleState(name) === 'failed') {
    return `
          <div class="studio-v2-soon studio-bundle-loading" data-testid="studio-${bundle.key}-bundle-failed" dir="${isAr ? 'rtl' : 'ltr'}" role="alert">
            <span class="studio-v2-soon-icon" aria-hidden="true"><i data-lucide="cloud-off" class="studio-v2-icon"></i></span>
            <h2 class="studio-v2-soon-title">${isAr ? bundle.failed[1] : bundle.failed[0]}</h2>
            <p class="studio-v2-soon-note">${isAr ? 'تحقق من الاتصال ثم أعد المحاولة.' : 'Check your connection and try again.'}</p>
            <button type="button" onclick="retryStudioBundle('${name}')" class="studio-v2-action is-primary" data-testid="studio-${bundle.key}-bundle-retry">${isAr ? 'إعادة المحاولة' : 'Retry'}</button>
          </div>`;
  }
  return `
          <div class="studio-v2-loading studio-bundle-loading" data-testid="studio-${bundle.key}-bundle-loading" dir="${isAr ? 'rtl' : 'ltr'}" role="status">
            <span class="studio-v2-spinner" aria-hidden="true"></span>
            <p>${isAr ? bundle.loading[1] : bundle.loading[0]}</p>
          </div>`;
}

// For the shell (15h): a tab whose screen lives in `name` and is not registered yet. '' once the
// bundle is here (the screen registered itself, or its draw failed: the shell's own placeholder);
// otherwise the bundle is asked for and the card is drawn meanwhile.
function studioBundleScreen(name) {
  if (studioBundleReady(name)) return '';
  ensureStudioBundle(name);
  return renderStudioBundleCard(name);
}

// section: one of the desk sections (15h STUDIO_V2_STAFF_SECTIONS); route: the v2 route, or null
// from the classic review tab (only the admin health section is drawn there).
function renderStudioStaffSection(section, route = null) {
  if (studioBundleReady('studio-staff.js')) {
    if (!route) return String(section || '') === 'health' ? renderStudioHealthSection() : '';
    return renderStudioDeskSection(section, route);
  }
  ensureStudioBundle('studio-staff.js');
  return renderStudioBundleCard('studio-staff.js');
}

// Guide links for a screen (15o renderStudioGuideLinks): '' while studio-pages.js is on its way (it is
// asked for; the links appear with the next draw) or after it failed (the screen stays complete).
function studioGuideLinks(keys, testId = 'studio-guide-links') {
  if (typeof renderStudioGuideLinks === 'function') return renderStudioGuideLinks(keys, testId);
  ensureStudioBundle('studio-pages.js');
  return '';
}

// The classic Replies / Posts tabs (15f) while /me says the v2 layout: the v2 screens of 15o once the
// bundle is here, its card meanwhile; '' = the classic screens draw (classic layout, /me unknown).
function studioPagesClassicHandover(tab) {
  const me = typeof studioMe === 'function' ? studioMe() : null;
  if (!me || me.ui !== 'v2') return '';
  if (studioBundleReady('studio-pages.js')) return studioPagesClassicDelegate(tab);
  ensureStudioBundle('studio-pages.js');
  return `<div class="studio-pg-classic" data-testid="studio-pg-classic" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">${renderStudioBundleCard('studio-pages.js')}</div>`;
}
