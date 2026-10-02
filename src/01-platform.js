// ==========================================
// ALBAYAN MANAGER - VANILLA JS COMPLETE
// Full-featured conversion from React
// SECURITY ENHANCED VERSION
// ==========================================
// PLATFORM RULES (PLATFORM_FOUNDATION.md, CONTRIBUTING.md, MONEY_PLATFORM_ROADMAP.md):
// walletTransactions is an append-only ledger (balance computed, never stored; reversals, not edits);
// serviceSubscriptions is the source of truth for access; service ids never change after launch;
// large collections go in state + PERSISTED_COLLECTIONS; no plaintext secrets; audit logs stay redacted.
//
// PLATFORM DETECTION: web, iOS, Android, HarmonyOS and capabilities.

// /studio (or a studio. subdomain) boots the standalone Ads Studio shell.
const IS_STUDIO_SHELL = (
  /^\/studio(\/|$)/.test(window.location.pathname || '')
  || /^studio\./i.test(window.location.hostname || '')
);

const Platform = {
  // Cache detection results for performance
  _cache: null,
  
  // Detect platform once and cache results
  detect: function() {
    if (this._cache) return this._cache;
    
    const ua = navigator.userAgent || '';
    const uaLower = ua.toLowerCase();
    
    // Capacitor (mobile app). document.URL is read defensively: test sandboxes stub document
    // without it, and routing paths reach detect().
    const docUrl = String((typeof document !== 'undefined' && document.URL) || '');
    const isCapacitor = typeof window.Capacitor !== 'undefined' ||
                        docUrl.startsWith('capacitor://') ||
                        docUrl.startsWith('ionic://');
    
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

    // Detect in-app browsers (FB/IG/Messenger break downloads, print and _blank). Token-based
    // only: no "iOS without Safari/" guess (the installed PWA drops that token too). Capacitor is
    // excluded first: its Android shell UA carries the same '; wv)' marker.
    let isInAppBrowser = false;
    let inAppBrowserKind = null;
    if (!isCapacitor) {
      try {
        if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) {
          // Facebook family; Messenger adds its own app names to the same FB tokens.
          isInAppBrowser = true;
          inAppBrowserKind = /messenger|orca/i.test(ua) ? 'messenger' : 'facebook';
        } else if (/instagram/i.test(ua)) {
          isInAppBrowser = true;
          inAppBrowserKind = 'instagram';
        } else if (/android/i.test(ua) && /; wv\)/.test(ua)) {
          // Stock Android WebView ("; wv)"): FB Lite, Gmail, any app hosting a bare WebView.
          isInAppBrowser = true;
          inAppBrowserKind = 'android-webview';
        } else if (/\bLine\/|MicroMessenger|Snapchat|TikTok|musical_ly|BytedanceWebview|\bGSA\//i.test(ua)) {
          // Other in-app shells (LINE, WeChat, Snapchat, TikTok, the Google app): same limits.
          isInAppBrowser = true;
          inAppBrowserKind = 'other';
        }
      } catch (_) {
        // Never let UA sniffing break platform detection.
        isInAppBrowser = false;
        inAppBrowserKind = null;
      }
    }

    this._cache = {
      isCapacitor,
      platform,
      isTouch,
      supportsHover,
      isMobileBrowser,
      isInAppBrowser,
      inAppBrowserKind,
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
  // In-app webview shells: consumers degrade where those silently break downloads/printing.
  get isInAppBrowser() { return this.detect().isInAppBrowser; },
  // 'facebook' | 'instagram' | 'messenger' | 'android-webview' | 'other' | null
  get inAppBrowserKind() { return this.detect().inAppBrowserKind; },
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
    body.classList.remove('platform-web', 'platform-ios', 'platform-android', 'platform-harmony', 'platform-capacitor', 'platform-inapp', 'is-touch', 'no-hover', 'is-mobile');

    // Add new classes
    if (p.isCapacitor) body.classList.add('platform-capacitor');
    body.classList.add(`platform-${p.platform}`);
    if (p.isTouch) body.classList.add('is-touch');
    if (!p.supportsHover) body.classList.add('no-hover');
    if (p.isMobile) body.classList.add('is-mobile');
    if (p.isInAppBrowser) body.classList.add('platform-inapp');
  }
};

// Apply platform classes immediately when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Platform.applyBodyClasses());
} else {
  Platform.applyBodyClasses();
}

// IPHONE APP: Apple allows only its own In-App Purchase for anything sold inside an app, so the owner
// sells nothing there. True = hide every buy, subscribe and top-up button (balances, plans in use and
// history stay). The web and the Android app are unchanged.
function inAppPurchasingHidden() {
  if (typeof Platform === 'undefined' || !Platform.isCapacitor) return false;
  if (Platform.isIOS) return true;
  // The same Apple build on an iPad, Mac or Vision Pro can send a desktop user agent: ask the shell.
  try { return window.Capacitor.getPlatform() === 'ios'; } catch (_) { return false; }
}

// ==========================================
// ROLE HELPERS
// ==========================================
// Case-insensitive like the server (main.py lowercases): a role stored as 'admin' passed every
// server check while failing the UI's exact 'Admin' checks.
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
// body.perf-lite (style.css) keeps ALL features but turns the GPU-heavy decorations off
// (aurora blur, backdrop blur). Per-device preference; lite is the DEFAULT.

function isPerformanceModeOn() {
  let pref = null;
  try { pref = localStorage.getItem('albayan_perf_mode'); } catch (_) {}
  // Lite is the DEFAULT (user request): only an explicit 'full' in Settings restores the heavy effects.
  return pref !== 'full';
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

// ==========================================
// WORKSPACE EXPERIENCE
// ==========================================
// Albayan now has one consistent workspace: the complete Advanced view. Keep
// the compatibility helpers because older cached bundles and inline actions
// can still call them while a device updates, but never hide business tools.
const ALBAYAN_EXPERIENCE_MODE_KEY = 'albayan_experience_mode';

function getWorkspaceExperienceMode() {
  return 'advanced';
}

function isAdvancedWorkspaceMode() {
  return true;
}

function applyWorkspaceExperienceMode() {
  try {
    localStorage.removeItem(ALBAYAN_EXPERIENCE_MODE_KEY);
    if (document.body) {
      document.body.classList.add('workspace-advanced');
      document.body.classList.remove('workspace-simple');
    }
  } catch (_) {}
  return 'advanced';
}

function setWorkspaceExperienceMode(_mode, options = {}) {
  applyWorkspaceExperienceMode();

  // A full shell render refreshes the global header, navigation and every
  // progressive filter panel. Guard the calls because this module loads before
  // the renderer is declared in the generated bundle.
  if (options.render !== false) {
    if (typeof forceFullRender === 'function') forceFullRender();
    else if (typeof render === 'function') render();
  }

  return 'advanced';
}

function toggleWorkspaceExperienceMode() {
  return setWorkspaceExperienceMode('advanced');
}

// Apply before the first app render to avoid controls flashing open and then
// collapsing on startup.
applyWorkspaceExperienceMode();
