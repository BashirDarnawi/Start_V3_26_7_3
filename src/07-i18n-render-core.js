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
    dashboard: 'Dashboard',
    ads: 'Ads',
    receipts: 'Receipts',
    users: 'Users',
    customers: 'Customers',
    pages: 'Pages',
    deliveries: 'Deliveries',
    auditLogs: 'Audit Logs',
    settings: 'Settings',
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
    dashboard: 'لوحة التحكم',
    ads: 'الإعلانات',
    receipts: 'الإيصالات',
    users: 'المستخدمين',
    customers: 'العملاء',
    pages: 'الصفحات',
    deliveries: 'التوصيل',
    auditLogs: 'سجل التدقيق',
    settings: 'الإعدادات',
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

function getDir() {
  return state.language === 'ar' ? 'rtl' : 'ltr';
}

// ==========================================
// THEME MANAGEMENT
// ==========================================

function applyTheme() {
  const root = document.documentElement;
  const isDark = state.theme === 'dark' || 
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

function toggleTheme() {
  const themes = ['light', 'dark', 'system'];
  const currentIndex = themes.indexOf(state.theme);
  state.theme = themes[(currentIndex + 1) % themes.length];
  applyTheme();
  saveState();
  render();
}

function toggleLanguage() {
  state.language = state.language === 'en' ? 'ar' : 'en';
  document.documentElement.setAttribute('dir', getDir());
  saveState();
  render();
}

// ==========================================
// PERFORMANCE: Smooth Scrolling Mode + Optimized Rendering
// ==========================================
let _scrollPerfInit = false;
let _scrollRafId = null;
function setupScrollPerformanceMode() {
  if (_scrollPerfInit) return;
  _scrollPerfInit = true;
  let timer = null;
  const onScroll = () => {
    if (!document.body) return;
    // Use RAF for smoother class toggling
    if (_scrollRafId) cancelAnimationFrame(_scrollRafId);
    _scrollRafId = requestAnimationFrame(() => {
    document.body.classList.add('is-scrolling');
    });
    if (timer) clearTimeout(timer);
    // Longer debounce (250ms) prevents rapid on/off toggling during momentum scroll
    timer = setTimeout(() => {
      document.body.classList.remove('is-scrolling');
    }, 250);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
}

// Debounced icon refresh (batches multiple calls)
const IconQueue = {
  pending: new Set(),
  timer: null,
  flush() {
    if (!window.lucide) return;
    const containers = Array.from(IconQueue.pending);
    IconQueue.pending.clear();
    IconQueue.timer = null;
    requestAnimationFrame(() => {
      if (containers.length === 0 || containers.includes(null)) {
        // Full scan needed
        lucide.createIcons();
      } else {
        // Scoped scan - much faster
        for (const c of containers) {
          if (c instanceof Element) {
            lucide.createIcons({ nodes: c.querySelectorAll('[data-lucide]') });
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
      // Skip render while scrolling (causes jank)
      if (document.body?.classList?.contains('is-scrolling')) {
        RenderQueue.schedule(reason);
        return;
      }
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

function showNotification(title, message, type = 'info') {
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
  const notification = document.createElement('div');
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
    <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors">
      <i data-lucide="x" class="w-4 h-4"></i>
    </button>
  `;
  
  container.appendChild(notification);
  IconQueue.schedule(notification);
  
  setTimeout(() => {
    notification.classList.remove('notification-enter');
    notification.classList.add('notification-exit');
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

