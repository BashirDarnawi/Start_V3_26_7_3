// ==========================================
// TRANSLATIONS
// ==========================================

const translations = {
  en: {
    appName: 'Albayan',
    adManager: 'Albayan Manager',
    signInTitle: 'Sign In to Continue',
    email: 'Email Address',
    password: 'Password',
    loginButton: 'Sign In',
    forgotPassword: 'Forgot password?',
    resetPassword: 'Reset Password',
    resetCode: 'Reset Code',
    sendResetCode: 'Send Reset Code',
    recoveryKey: 'Recovery Key',
    newPassword: 'New Password',
    confirmPassword: 'Confirm Password',
    currentPassword: 'Current Password',
    changePassword: 'Change Password',
    security: 'Security',
    generateRecoveryKey: 'Generate Recovery Key',
    logout: 'Logout',
    analytics: 'Analytics',
    controlCenter: 'Control Center',
    dashboard: 'Dashboard',
    ads: 'Ads',
    receipts: 'Receipts',
    users: 'Users',
    customers: 'Customers',
    pages: 'Pages',
    deliveries: 'Deliveries',
    auditLogs: 'Audit Logs',
    settings: 'Settings',
    clothesSystem: 'Clothes System',
    jobReconciliation: 'Reconciliation',
    totalRevenue: 'Total Revenue',
    totalAds: 'Total Ads',
    pendingAds: 'Pending',
    completedAds: 'Completed',
    welcome: 'Welcome',
    addCustomer: 'Add Customer',
    addAd: 'Add Ad',
    addReceipt: 'Add Receipt',
    addUser: 'Add User',
    addPage: 'Add Page',
    name: 'Name',
    phone: 'Phone',
    platform: 'Platform',
    amount: 'Amount',
    exchangeRate: 'Exchange Rate',
    status: 'Status',
    actions: 'Actions',
    delete: 'Delete',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    search: 'Search',
    filter: 'Filter',
    export: 'Export',
    import: 'Import',
    print: 'Print',
    wallet: 'Wallet',
    balance: 'Balance',
    transfer: 'Transfer',
    topUp: 'Top Up',
    transactions: 'Transactions',
    note: 'Note',
    recipient: 'Recipient',
    send: 'Send',
  },
  ar: {
    appName: 'البيان',
    adManager: 'مدير البيان',
    signInTitle: 'تسجيل الدخول للمتابعة',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    loginButton: 'تسجيل الدخول',
    forgotPassword: 'نسيت كلمة المرور؟',
    resetPassword: 'إعادة تعيين كلمة المرور',
    resetCode: 'رمز الاستعادة',
    sendResetCode: 'إرسال رمز الاستعادة',
    recoveryKey: 'مفتاح الاستعادة',
    newPassword: 'كلمة مرور جديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    currentPassword: 'كلمة المرور الحالية',
    changePassword: 'تغيير كلمة المرور',
    security: 'الأمان',
    generateRecoveryKey: 'إنشاء مفتاح استعادة',
    logout: 'تسجيل خروج',
    analytics: 'التحليلات',
    controlCenter: 'مركز التحكم',
    dashboard: 'لوحة التحكم',
    ads: 'الإعلانات',
    receipts: 'الإيصالات',
    users: 'المستخدمين',
    customers: 'العملاء',
    pages: 'الصفحات',
    deliveries: 'التوصيل',
    auditLogs: 'سجل التدقيق',
    settings: 'الإعدادات',
    clothesSystem: 'نظام الملابس',
    jobReconciliation: 'التسوية',
    totalRevenue: 'إجمالي الإيرادات',
    totalAds: 'إجمالي الإعلانات',
    pendingAds: 'المعلقة',
    completedAds: 'المكتملة',
    welcome: 'مرحبا',
    addCustomer: 'إضافة عميل',
    addAd: 'إضافة إعلان',
    addReceipt: 'إضافة إيصال',
    addUser: 'إضافة مستخدم',
    addPage: 'إضافة صفحة',
    name: 'الاسم',
    phone: 'الهاتف',
    platform: 'المنصة',
    amount: 'المبلغ',
    exchangeRate: 'سعر الصرف',
    status: 'الحالة',
    actions: 'الإجراءات',
    delete: 'حذف',
    edit: 'تعديل',
    save: 'حفظ',
    cancel: 'إلغاء',
    search: 'بحث',
    filter: 'تصفية',
    export: 'تصدير',
    import: 'استيراد',
    print: 'طباعة',
    wallet: 'المحفظة',
    balance: 'الرصيد',
    transfer: 'تحويل',
    topUp: 'شحن',
    transactions: 'المعاملات',
    note: 'ملاحظة',
    recipient: 'المستلم',
    send: 'إرسال',
  }
};

function getTodayDateString() {
  const d = new Date();
  return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
}

function t(key) {
  const lang = translations[state.language] || translations['en'];
  return lang[key] || key;
}

// Arabic display names for DYNAMIC status/enum values stored in records.
// IMPORTANT: this is DISPLAY ONLY — never store the translated value, and CSS
// class derivation (e.g. status-${s.toLowerCase()}) must keep using the RAW
// English value. Unmapped values (and English mode) pass through unchanged.
const STATUS_TRANSLATIONS_AR = {
  // Payment / receipt status
  'Paid': 'مدفوع',
  'Not Paid': 'غير مدفوع',
  'Unpaid': 'غير مدفوع',
  'Pending': 'قيد الانتظار',
  "Won't Pay": 'لن يدفع',
  // Ad lifecycle
  'Active': 'نشط',
  'Paused': 'متوقف مؤقتاً',
  'Completed': 'مكتمل',
  'Canceled': 'ملغي',
  'Cancelled': 'ملغي',
  'Lost': 'ضائع',
  'Destroyed': 'تالف',
  'Stopped': 'موقوف',
  'posted': 'منشور',
  // Delivery pipeline
  'Needs Delivery': 'بحاجة توصيل',
  'In Progress': 'قيد التوصيل',
  'Delivered': 'تم التوصيل',
  'Office': 'المكتب',
  // Receipt usage
  'Unused': 'غير مستخدم',
  'Partially Used': 'مستخدم جزئياً',
  'Fully Used': 'مستخدم بالكامل',
  'Unknown': 'غير معروف',
  // Delivered payment results
  'PAID_EXACT': 'مدفوع بالضبط',
  'OVERPAID': 'دفع زائد',
  'UNDERPAID': 'دفع ناقص',
  // Collection types
  'office': 'المكتب',
  'delivery': 'توصيل',
  'bank': 'مصرف',
  // Refund
  'None': 'بدون',
  'Full': 'كامل',
  'Partial': 'جزئي',
};

// One way of writing money everywhere (DESIGN.md 5.4): a thousands separator, two decimals, the
// currency always shown; dollars "$1,250.00", dinars "1,250.00 LYD" (Arabic "1,250.00 د.ل"). The
// digits are the ones toFixed(2) gives, so no figure changes: only how it is written.
function fmt2(value) {
  return (Number(value) || 0).toFixed(2).replace(/\B(?=(\d{3})+\.)/g, ',');
}
// An Arabic page reads right to left, and the browser's own rules would then draw "$35.00" as "35.00$",
// "-12.50" as "12.50-" and, inside a left-to-right box, د.ل on the wrong side of its number. So in Arabic every
// amount is one piece with its own direction: U+2066 starts a left-to-right piece, U+2067 a right-to-left one,
// U+2069 ends it (the same invisible marks the delivery message already puts around a phone number).
function moneyPiece(text, rtl) {
  return state.language === 'ar' ? `${rtl ? '\u2067' : '\u2066'}${text}\u2069` : text;
}
// A record number or a code in a line of text is one left-to-right piece too ("#D12", never "D12#"). In markup,
// <bdi> or dir="ltr" does the same.
function codePiece(text) {
  return moneyPiece(text);
}
// sign: '+' or '-' in front of the amount ("+$5.00"); a negative value brings its own minus ("-$12.50", never "$-12.50").
function fmtUsd(value, sign = '') {
  const text = fmt2(value);
  return moneyPiece(text[0] === '-' ? `-$${text.slice(1)}` : `${sign}$${text}`);
}
// English "1,250.00 LYD"; Arabic reads the number first and then د.ل, which is drawn on its left.
function fmtLyd(value, sign = '') {
  const text = sign + fmt2(value);
  if (state.language !== 'ar') return `${text} LYD`;
  return moneyPiece(`${/^[+-]/.test(text) ? moneyPiece(text) : text} د.ل`, true);
}
// One way of writing dates (DESIGN.md 5.4): "19 Nov 2026", with a time "19 Nov 2026, 12:33"; the
// same order in Arabic, with the Western digits and Gregorian months the app already pins.
function fmtDay(value, withTime) {
  const date = new Date(value);
  if (!value || isNaN(date)) return '';
  return date.toLocaleString(appDateLocale(), { day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}

// Translate a stored status/enum value for display (Arabic mode only).
function trStatus(value) {
  if (state.language !== 'ar') return value == null ? '' : String(value);
  const s = String(value == null ? '' : value).trim();
  return STATUS_TRANSLATIONS_AR[s] || s;
}

// A customer's platform for display only (stored and <option> values stay English); brand names stay.
function platformLabel(p) {
  return state.language === 'ar' && p === 'Phone' ? 'هاتف' : String(p || '');
}

// Payment channel names: Libyana/Madar/LTT/Sadad/USDT are proper names and
// stay as-is; only the generic words are localized.
const METHOD_TRANSLATIONS_AR = {
  'Transfer': 'تحويل',
  'Cash (LYD)': 'نقدي (LYD)',
  'Cash (USD)': 'نقدي (USD)',
  'Bank Transfer': 'حوالة مصرفية',
  'Bank Transfer (LYD)': 'حوالة مصرفية (LYD)',
  'Bank Transfer (USD)': 'حوالة مصرفية (USD)',
  'Transfer Office': 'مكتب صرافة',
  'Split Payment': 'دفعات مقسّمة',
};

// Translate a payment-method LABEL for display (values stay raw English).
function trMethod(value) {
  if (state.language !== 'ar') return value == null ? '' : String(value);
  const s = String(value == null ? '' : value).trim();
  return METHOD_TRANSLATIONS_AR[s] || s;
}

function getDir() {
  return state.language === 'ar' ? 'rtl' : 'ltr';
}

// ==========================================
// THEME MANAGEMENT
// ==========================================

// <html dir/lang> for the current language. Called at boot (before and after
// the saved preference loads) and by toggleLanguage().
function applyDocumentLanguage() {
  try {
    document.documentElement.setAttribute('dir', getDir());
    document.documentElement.setAttribute('lang', state.language === 'ar' ? 'ar' : 'en');
  } catch (_) {}
}

function applyTheme() {
  const root = document.documentElement;
  const isDark = state.theme === 'dark' ||
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // Keep the used color-scheme in sync with the APP theme so native widgets (selects, date
  // pickers, scrollbars) are not white on dark and Chrome auto-dark does not invert the light theme.
  try { root.style.colorScheme = isDark ? 'dark' : 'light'; } catch (_) {}
  // The inline script in index.html reads this before script.js loads, so a
  // dark-theme user never sees a light flash on startup.
  try { localStorage.setItem('albayan_theme', isDark ? 'dark' : 'light'); } catch (_) {}

  // index.html's two media-keyed theme-color metas follow the OS for first paint only: pin BOTH to the
  // app theme (media filter dropped, same content) so the toolbar / PWA status bar match. As index.html.
  try {
    const themeMetas = document.querySelectorAll('meta[name="theme-color"]');
    for (let i = 0; i < themeMetas.length; i++) {
      themeMetas[i].removeAttribute('media');
      themeMetas[i].setAttribute('content', isDark ? '#020617' : '#f8fafc');
    }
  } catch (_) {}

  if (typeof syncNativeSystemBarsTheme === 'function') {
    syncNativeSystemBarsTheme().catch(() => {});
  }
}

function toggleTheme() {
  const themes = ['light', 'dark', 'system'];
  const currentIndex = themes.indexOf(state.theme);
  state.theme = themes[(currentIndex + 1) % themes.length];
  applyTheme();
  saveState();
  forceFullRender();  // redraws the sidebar/drawer theme button too
}

function toggleLanguage() {
  state.language = state.language === 'en' ? 'ar' : 'en';
  document.documentElement.setAttribute('dir', getDir());
  document.documentElement.setAttribute('lang', state.language === 'ar' ? 'ar' : 'en');
  saveState();
  // A FULL re-render, not the same-view swap: <main>'s sidebar margin depends on direction
  // (md:ml-72 LTR, md:mr-72 RTL), so a partial update left the content under the moved sidebar.
  _lastRenderedView = null;
  _lastRenderedUserId = null;
  render();
  if (window.lucide) lucide.createIcons();
}

// The old scroll "performance mode" (body.is-scrolling per scroll) was removed: its mid-scroll
// restyles swallowed touchpad scrolling on weak machines; body.perf-lite turns effects off instead.

// Strip data-lucide from converted SVGs after each createIcons() pass: lucide keeps the
// attribute, so every later pass rebuilt every icon (full-page DOM churn per render tick).
// 14-forms re-sets data-lucide on one SVG to swap it. Installed lazily (lucide is deferred).
function ensureLucideCreateIconsWrapped() {
  if (!window.lucide || lucide.__iconsWrapped) return;
  const _originalCreateIcons = lucide.createIcons.bind(lucide);
  lucide.createIcons = function (opts) {
    _originalCreateIcons(opts);
    const root = (opts && opts.root) || document;
    root.querySelectorAll('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
  };
  lucide.__iconsWrapped = true;
}
ensureLucideCreateIconsWrapped();

// Debounced icon refresh. lucide.min.js is deferred and runs AFTER this classic script, so
// flush() keeps the queue and retries until the library arrives (before DOMContentLoaded).
const IconQueue = {
  pending: new Set(),
  timer: null,
  retries: 0,
  flush() {
    if (!window.lucide) {
      // Retry every 50ms; give up after ~10s (blocked/404 library) so no
      // timer spins forever. A later schedule() starts a fresh retry window.
      IconQueue.retries++;
      if (IconQueue.retries > 200) {
        IconQueue.retries = 0;
        IconQueue.timer = null;
        return;
      }
      IconQueue.timer = setTimeout(() => IconQueue.flush(), 50);
      return;
    }
    ensureLucideCreateIconsWrapped();
    IconQueue.retries = 0;
    const containers = Array.from(IconQueue.pending);
    IconQueue.pending.clear();
    IconQueue.timer = null;
    requestAnimationFrame(() => {
      if (containers.length === 0 || containers.includes(null)) {
        // Full scan needed
        lucide.createIcons();
      } else {
        // Scoped scan: `root` is what the bundled lucide supports; the old `nodes:` does not exist and
        // silently fell back to a FULL document scan per queued container.
        for (const c of containers) {
          if (c instanceof Element) {
            lucide.createIcons({ root: c });
          }
        }
      }
    });
  },
  schedule(container = null) {
    IconQueue.pending.add(container);
    if (IconQueue.timer) return;
    IconQueue.timer = setTimeout(() => IconQueue.flush(), 16); // ~1 frame
  }
};

// Debounced render to avoid "missing updates" without forcing hard refreshes.
const RenderQueue = {
  timer: null,
  rafId: null,
  lastRenderTime: 0,
  minIntervalMs: 50, // Reduced to 50ms for snappier UI (was 100ms)
  schedule(reason = '') {
    if (RenderQueue.timer) return;
    const now = Date.now();
    const elapsed = now - RenderQueue.lastRenderTime;
    const delay = Math.max(0, RenderQueue.minIntervalMs - elapsed);
    RenderQueue.timer = setTimeout(() => {
      RenderQueue.timer = null;
      // (the old is-scrolling defer was removed together with the scroll
      // performance mode — the class is never set anymore)
      // Skip render if another render is in progress
      if (_renderInProgress) {
        RenderQueue.schedule(reason);
        return;
      }
      // Use RAF for smoother visual updates
      if (RenderQueue.rafId) cancelAnimationFrame(RenderQueue.rafId);
      RenderQueue.rafId = requestAnimationFrame(() => {
        RenderQueue.rafId = null;
        RenderQueue.lastRenderTime = Date.now();
        try {
          render();
        } catch (e) {
          console.warn('RenderQueue failed:', reason, e);
        }
      });
    }, delay);
  }
};

// ==========================================
// NOTIFICATIONS
// ==========================================

// In-app browsers (Facebook/Instagram/Messenger webviews, bare Android
// WebViews) and the packaged app (no print or download handler in its
// shell) silently swallow blob <a download> clicks and window.print().
// Callers gate on this and warn INSTEAD of trying (and of a false success toast).
function cannotPrintOrDownload() {
  return typeof Platform !== 'undefined' && (Platform.isCapacitor || Platform.isInAppBrowser);
}

// kind: 'download' | 'print'. The packaged app never sends people to the web (App Review).
function inAppLimitationText(kind) {
  const ar = state.language === 'ar', print = kind === 'print';
  if (isPackagedMobileApp()) return ar ? `${print ? 'الطباعة غير متاحة' : 'التنزيل غير متاح'} داخل التطبيق.` : `${print ? "Printing isn't" : "Downloads aren't"} available in the app.`;
  return ar
    ? `${print ? 'الطباعة' : 'التنزيلات'} لا تعمل داخل متصفح فيسبوك/إنستغرام المدمج — افتح الصفحة في Safari أو Chrome (قائمة ⋯ ← «فتح في المتصفح») ثم أعد المحاولة.`
    : `${print ? "Printing doesn't" : "Downloads don't"} work inside the Facebook/Instagram in-app browser — open this page in Safari or Chrome (menu -> "Open in browser"), then try again.`;
}

function notifyInAppBrowserLimitation(kind) {
  const isAr = state.language === 'ar';
  showNotification(
    kind === 'print' ? (isAr ? 'الطباعة غير متاحة هنا' : 'Printing unavailable here') : (isAr ? 'التنزيل غير متاح هنا' : 'Download unavailable here'),
    inAppLimitationText(kind),
    'warning'
  );
}

// A message may offer one action, for the thing that was just done: { label, run }. Today that is "Undo",
// only where the app already had a way back (see undoAction).
function showNotification(title, message, type = 'info', action = null) {
  // #region agent log
  // Hypothesis H-NOLOG: user can reproduce issue but we see no NDJSON logs; capture error/warn toasts to pinpoint.
  try {
    if ((type === 'error' || type === 'warning') && typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-NOLOG', 'script.js:showNotification', 'toast', {
        type: String(type || '').slice(0, 16),
        title: String(title || '').slice(0, 120),
        message: String(message || '').slice(0, 240),
      });
    }
  } catch (_) {}
  // #endregion

  const container = document.getElementById('notification-container');
  if (!container) return;

  // De-duplicate: if an IDENTICAL toast is already on screen, pulse it and
  // reset its 5s timer instead of stacking a copy. Repeated clicks on a
  // blocked save were piling up the same error toast many times over.
  const notifKey = `${type}|${title}|${message}`.slice(0, 400);
  const existing = Array.from(container.children).find(el => el.dataset && el.dataset.notifKey === notifKey);
  const act = action && action.label && typeof action.run === 'function' ? action : null;
  // An action belongs to the record of THIS message: an identical message still on screen (the same amount
  // collected on another receipt a moment ago) is replaced, never reused with its earlier action.
  if (existing && act) {
    if (existing._hideTimer) clearTimeout(existing._hideTimer);
    existing.remove();
  } else if (existing) {
    if (existing._hideTimer) clearTimeout(existing._hideTimer);
    existing.classList.remove('notification-enter', 'notification-exit', 'notification-pulse');
    void existing.offsetWidth; // restart the CSS animation
    existing.classList.add('notification-pulse');
    existing._hideTimer = setTimeout(() => {
      existing.classList.remove('notification-pulse');
      existing.classList.add('notification-exit');
      setTimeout(() => existing.remove(), 300);
    }, 5000);
    return;
  }

  const notification = document.createElement('div');
  notification.dataset.notifKey = notifKey;
  notification.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
  notification.setAttribute('aria-live', type === 'error' || type === 'warning' ? 'assertive' : 'polite');
  notification.setAttribute('aria-atomic', 'true');
  notification.className = `notification-enter glass-panel px-4 py-3 rounded-xl shadow-lg flex items-start space-x-3 mb-2 ${
    type === 'success' ? 'border-l-4 border-green-500' :
    type === 'error' ? 'border-l-4 border-red-500' :
    type === 'warning' ? 'border-l-4 border-yellow-500' :
    'border-l-4 border-blue-500'
  }`;
  
  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };
  
  // Escape title and message to prevent XSS
  const safeTitle = Security.escapeHtml(title);
  const safeMessage = Security.escapeHtml(message);
  
  notification.innerHTML = `
    <div class="text-2xl">${icons[type]}</div>
    <div class="flex-1 min-w-0">
      <div class="font-bold text-sm truncate">${safeTitle}</div>
      <div class="text-xs opacity-80 break-words">${safeMessage}</div>
    </div>
    ${act ? `<button type="button" class="notification-action">${Security.escapeHtml(act.label)}</button>` : ''}
    <button onclick="this.parentElement.remove()" aria-label="${state.language === 'ar' ? 'إغلاق الإشعار' : 'Close notification'}" class="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors">
      <i data-lucide="x" class="w-4 h-4"></i>
    </button>
  `;
  if (act) {
    notification.querySelector('.notification-action')?.addEventListener('click', () => {
      if (notification._hideTimer) clearTimeout(notification._hideTimer);
      notification.remove();
      act.run();
    });
  }

  container.appendChild(notification);
  IconQueue.schedule(notification);

  // A message that offers an action stays a little longer, so there is time to read it and press.
  notification._hideTimer = setTimeout(() => {
    notification.classList.remove('notification-enter');
    notification.classList.add('notification-exit');
    setTimeout(() => notification.remove(), 300);
  }, act ? 8000 : 5000);
}

// "Undo" for a message, where the app already has a way back: the action runs that same way back, with its
// own checks and its own message. No new undo logic lives here.
function undoAction(run) {
  return { label: state.language === 'ar' ? 'تراجع' : 'Undo', run };
}

// The app's own question box, in place of the browser's confirm and prompt boxes: the same question
// and the same answer (true or false; with a text field, the typed text or null), in the app's look
// and language. One at a time: a new question cancels the one before it.
let _appAsk = null;

function closeAppAsk(answer) {
  const open = _appAsk;
  if (!open) return;
  _appAsk = null;
  document.removeEventListener('keydown', open.key, true);
  open.host.remove();
  try { open.from?.focus?.(); } catch (_) {}
  open.done(answer === undefined ? (open.input ? null : false) : answer);
}

// kind: 'delete' (red "Delete"), 'go' ("Continue"), any other text is the button's own label.
function appConfirm(message, kind = '', ask) {
  closeAppAsk();
  return new Promise(done => {
    const ar = state.language === 'ar', host = document.createElement('div');
    const lines = Security.escapeHtml(String(message)).split('\n').filter(line => line.trim());
    const title = lines[0].length > 90 ? (ar ? 'يرجى التأكيد' : 'Please confirm') : lines.shift();
    const yes = { '': ['Confirm', 'تأكيد'], delete: ['Delete', 'حذف'], go: ['Continue', 'متابعة'] }[kind]?.[+ar] || Security.escapeHtml(kind);
    host.id = 'app-ask';
    host.className = 'mobile-dialog-overlay app-dialog-overlay fixed inset-0 flex items-center justify-center p-4';
    host.setAttribute('role', 'alertdialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-labelledby', 'app-ask-title');
    host.setAttribute('aria-describedby', 'app-ask-text');
    host.innerHTML = `<div class="app-dialog-panel glass-panel w-full max-w-md" dir="${ar ? 'rtl' : 'ltr'}"><h2 id="app-ask-title" class="app-dialog-title">${title}</h2><div id="app-ask-text">${lines.map(line => `<p>${line}</p>`).join('')}</div>${ask === undefined ? '' : `<input id="app-ask-input" class="glass-input w-full rounded-xl px-3 py-2" dir="auto" autocomplete="off" aria-labelledby="app-ask-title" value="${Security.escapeHtml(String(ask))}">`}<div class="management-button-row"><button type="button" class="app-dialog-cancel management-button">${ar ? 'إلغاء' : 'Cancel'}</button><button type="button" class="management-button ${kind === 'delete' ? 'is-danger' : 'is-primary'}">${yes}</button></div></div>`;
    const input = host.querySelector('input'), [no, ok] = host.querySelectorAll('button'), stops = input ? [input, no, ok] : [no, ok];
    const key = event => {
      if (event.key === 'Escape') closeAppAsk();
      else if (event.key === 'Enter' && event.target === input) closeAppAsk(input.value);
      else if (event.key === 'Tab') stops[(stops.indexOf(document.activeElement) + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
      else if (!((event.ctrlKey || event.metaKey) && event.key === 'k')) return;  // no search palette behind a question
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    let from = null;
    try { from = document.activeElement; } catch (_) {}
    _appAsk = { host, key, done, input, from };
    host.onclick = event => { if (event.target === host || event.target === no) closeAppAsk(); else if (event.target === ok) closeAppAsk(input ? input.value : true); };
    document.addEventListener('keydown', key, true);
    document.body.appendChild(host);
    try { (input || no).focus(); input?.select(); } catch (_) {}
  });
}

function appPrompt(message, value = '', kind = '') {
  return appConfirm(message, kind, value);
}
