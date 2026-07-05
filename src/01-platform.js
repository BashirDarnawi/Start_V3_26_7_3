// ==========================================
// ALBAYAN MANAGER - VANILLA JS COMPLETE
// Full-featured conversion from React
// SECURITY ENHANCED VERSION
// ==========================================

// ==========================================
// ALBAYAN PLATFORM (FUTURE PLAN + RULES)
// ==========================================
// This codebase is intended to evolve into a **multi-service platform** (web now, mobile later).
// New services must plug in cleanly without breaking existing ones (especially Albayan Manager).
//
// Core platform primitives (do NOT break these):
// - Services catalog: `SERVICES` + `SMART_SYSTEMS_CHILDREN` (config-driven, stable IDs)
// - Wallet: `walletTransactions` is an **immutable ledger** (balance is computed, not stored)
// - Subscriptions: `serviceSubscriptions` is the source of truth for service access
// - Server mode (FastAPI/Postgres): server is authoritative for multi-user internet usage
//
// Non‑negotiable rules for future edits (human + AI):
// 1) NEVER store wallet balance as a mutable field; only append ledger transactions.
// 2) NEVER allow editing/deleting `walletTransactions` or subscription history (use reversals/cancel records).
// 3) NEVER change a service `id` after launch (it becomes part of URLs, mobile deep links, subscriptions).
// 4) Any new “large” collection must be persisted in IndexedDB: add to `state` + `PERSISTED_COLLECTIONS`.
// 5) Keep services isolated; reuse platform modules instead of copy/paste logic across services.
// 6) No plaintext secrets (passwords, tokens, recovery keys). Keep audit logs redacted.
//
// Docs to read before major changes:
// - `PLATFORM_FOUNDATION.md` (architecture + portability)
// - `CONTRIBUTING.md` (how to extend safely)
// - `MONEY_PLATFORM_ROADMAP.md` (payments/POS/cards roadmap + money safety rules)
//
// ==========================================
// PLATFORM DETECTION MODULE
// ==========================================
// Detects platform (web, iOS, Android, HarmonyOS) and capabilities

const Platform = {
  // Cache detection results for performance
  _cache: null,
  
  // Detect platform once and cache results
  detect: function() {
    if (this._cache) return this._cache;
    
    const ua = navigator.userAgent || '';
    const uaLower = ua.toLowerCase();
    
    // Check for Capacitor (mobile app)
    const isCapacitor = typeof window.Capacitor !== 'undefined' ||
                        document.URL.startsWith('capacitor://') ||
                        document.URL.startsWith('ionic://');
    
    // Detect specific platform
    let platform = 'web';
    if (isCapacitor) {
      if (/iphone|ipad|ipod/i.test(ua)) {
        platform = 'ios';
      } else if (/android/i.test(ua)) {
        platform = 'android';
      } else if (/harmonyos/i.test(ua) || /huawei/i.test(ua)) {
        platform = 'harmony';
      } else {
        platform = 'capacitor-unknown';
      }
    }
    
    // Detect touch capability
    const isTouch = ('ontouchstart' in window) ||
                    (navigator.maxTouchPoints > 0) ||
                    (navigator.msMaxTouchPoints > 0);
    
    // Detect if hover is supported (CSS media query approach)
    const supportsHover = window.matchMedia('(hover: hover)').matches;
    
    // Detect mobile browser (not Capacitor but mobile browser)
    const isMobileBrowser = !isCapacitor && (
      /iphone|ipad|ipod|android|blackberry|windows phone/i.test(ua) ||
      (isTouch && window.innerWidth < 768)
    );
    
    this._cache = {
      isCapacitor,
      platform,
      isTouch,
      supportsHover,
      isMobileBrowser,
      isMobile: isCapacitor || isMobileBrowser,
      isWeb: !isCapacitor,
      isIOS: platform === 'ios',
      isAndroid: platform === 'android',
      isHarmony: platform === 'harmony',
      userAgent: ua
    };
    
    // Log platform detection for debugging
    console.log('[Platform] Detected:', this._cache);
    
    return this._cache;
  },
  
  // Convenience getters
  get isCapacitor() { return this.detect().isCapacitor; },
  get platform() { return this.detect().platform; },
  get isTouch() { return this.detect().isTouch; },
  get supportsHover() { return this.detect().supportsHover; },
  get isMobile() { return this.detect().isMobile; },
  get isMobileBrowser() { return this.detect().isMobileBrowser; },
  get isWeb() { return this.detect().isWeb; },
  get isIOS() { return this.detect().isIOS; },
  get isAndroid() { return this.detect().isAndroid; },
  get isHarmony() { return this.detect().isHarmony; },
  
  // Apply platform-specific CSS classes to document
  applyBodyClasses: function() {
    const p = this.detect();
    const body = document.body;
    if (!body) return;
    
    // Remove old classes
    body.classList.remove('platform-web', 'platform-ios', 'platform-android', 'platform-harmony', 'platform-capacitor', 'is-touch', 'no-hover', 'is-mobile');
    
    // Add new classes
    if (p.isCapacitor) body.classList.add('platform-capacitor');
    body.classList.add(`platform-${p.platform}`);
    if (p.isTouch) body.classList.add('is-touch');
    if (!p.supportsHover) body.classList.add('no-hover');
    if (p.isMobile) body.classList.add('is-mobile');
  }
};

// Apply platform classes immediately when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Platform.applyBodyClasses());
} else {
  Platform.applyBodyClasses();
}

// ==========================================
// ROLE HELPERS
// ==========================================
// The server compares roles case-insensitively (server/main.py lowercases),
// but the client used to do exact-case checks like role === 'Admin'. A role
// stored as 'admin' would then pass ALL server permission checks while
// failing the client's UI checks — half-privileged, inconsistent behavior.
// These helpers make the client tolerant of case the same way the server is.
function isAdminRole(role) {
  return String(role || '').trim().toLowerCase() === 'admin';
}

function isDeliveryRole(role) {
  return String(role || '').trim().toLowerCase() === 'delivery';
}

// BATTERY SAVER: pause the infinite aurora background animations while the
// app/tab is hidden (style.css: body.app-hidden rules). Purely a GPU/battery
// win — the user never sees the page while it is hidden.
document.addEventListener('visibilitychange', () => {
  try {
    document.body.classList.toggle('app-hidden', document.visibilityState === 'hidden');
  } catch (_) {}
});

// ==========================================
// PERFORMANCE MODE (for weak/old devices)
// ==========================================
// The default look leans hard on the GPU: a viewport-sized aurora layer under
// filter:blur(110px) animating forever, a full-screen backdrop-blur overlay,
// and backdrop-filter blur(14px) on every glass panel. On an old laptop or a
// cheap phone that turns every scroll and repaint into a slideshow.
// body.perf-lite (style.css) keeps ALL features and the same layout but turns
// those decorations off. Preference is per-device (localStorage), with
// auto-detection for weak hardware when the user hasn't chosen.

function isWeakDevice() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    const mem = navigator.deviceMemory;         // Chrome/WebView only, capped at 8
    const cores = navigator.hardwareConcurrency;
    if (typeof mem === 'number' && mem <= 4) return true;
    if (typeof cores === 'number' && cores <= 2) return true;
  } catch (_) {}
  return false;
}

function isPerformanceModeOn() {
  let pref = null;
  try { pref = localStorage.getItem('albayan_perf_mode'); } catch (_) {}
  return pref === 'lite' || (pref !== 'full' && isWeakDevice());
}

function applyPerformanceMode() {
  const lite = isPerformanceModeOn();
  try {
    if (document.body) document.body.classList.toggle('perf-lite', lite);
  } catch (_) {}
  return lite;
}

function togglePerformanceMode(on) {
  try { localStorage.setItem('albayan_perf_mode', on ? 'lite' : 'full'); } catch (_) {}
  applyPerformanceMode();
  if (typeof showNotification === 'function' && typeof state !== 'undefined') {
    const isAr = state.language === 'ar';
    showNotification(
      isAr ? 'وضع الأداء' : 'Performance Mode',
      on
        ? (isAr ? 'تم تفعيل وضع الأداء — التطبيق أخف وأسرع.' : 'Performance mode ON — lighter and faster.')
        : (isAr ? 'تم إيقاف وضع الأداء — عادت التأثيرات المرئية.' : 'Performance mode OFF — visual effects restored.'),
      'success'
    );
  }
}

// Apply immediately at load (script.js is at the end of <body>, so body
// exists) — before the first render, so there is no styled->lite flash.
applyPerformanceMode();

