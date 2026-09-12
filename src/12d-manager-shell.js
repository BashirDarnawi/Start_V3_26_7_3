// ==========================================
// ALBAYAN MANAGER PHONE SHELL (2026-09 design refresh)
// ==========================================
// The "Albayan Studio" design gives the manager a phone-first shell: a home
// hero with quick actions, a bottom tab bar with a centre "+", a More page,
// a Collect-a-debt flow with WhatsApp reminders, appearance rows in Settings
// and a one-time onboarding on the packaged app. Every piece here delegates
// to the EXISTING flows (receipt chooser, collect modal, customer receipts,
// theme/language toggles, logout) — nothing about money or permissions is
// re-implemented, only presented the new way. Desktop keeps the sidebar and
// simply shares the same cards.

// ---------- small shared helpers ----------

function shellText(en, ar) {
  return state.language === 'ar' ? ar : en;
}

function shellEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

function shellInitial(name) {
  const text = String(name || '').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

// Money in LYD with no trailing zeros for whole numbers ("1,250 LYD").
function shellLyd(amount) {
  const n = Number(amount) || 0;
  const rounded = Math.round(n * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} ${shellText('LYD', 'د.ل')}`;
}

function shellUsd(amount) {
  return `$${(Number(amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shellIsNativeApp() {
  try {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch (_) { return false; }
}

function shellReceiptLyd(receipt) {
  const local = Number(receipt?.amountLocal);
  if (Number.isFinite(local) && local > 0) return local;
  const usd = Number(receipt?.amountUSD) || 0;
  const rate = Number(receipt?.exchangeRate) || Number(state.defaultExchangeRate) || 0;
  return usd * rate;
}

function shellReceiptNumber(receipt) {
  return String(receipt?.finalReceiptNo || receipt?.serialNumber || receipt?.tempReceiptNo || '').trim();
}

function shellReceiptStatusMeta(receipt) {
  const paymentState = getReceiptPaymentState(receipt);
  if (paymentState === 'paid') return { label: shellText('Paid', 'مدفوع'), tone: 'emerald' };
  if (paymentState === 'canceled') return { label: shellText('Canceled', 'ملغى'), tone: 'slate' };
  if (paymentState === 'lost') return { label: shellText('Lost', 'ضائع'), tone: 'rose' };
  return { label: shellText('Unpaid', 'غير مدفوع'), tone: 'amber' };
}

function shellPill(label, tone = 'slate') {
  const tones = {
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  };
  return `<span class="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ${tones[tone] || tones.slate}">${label}</span>`;
}

// Same gate the sidebar uses, so the More page and the tab bar never show a
// destination the user cannot open.
const SHELL_VIEW_MODULES = Object.freeze({
  'control-center': 'analytics', analytics: 'analytics', customers: 'customers', receipts: 'receipts',
  pages: 'pages', ads: 'ads', deliveries: 'deliveries', reconciliation: 'analytics', users: 'users',
  audit: 'auditLogs', settings: 'settings', 'clothes-system': 'clothesProducts'
});

function shellCanOpen(viewId) {
  if (isAdminRole(state.currentUser?.role)) return true;
  if (isDeliveryRole(state.currentUser?.role) && (viewId === 'delivery-dashboard' || viewId === 'deliveries')) return true;
  const moduleName = SHELL_VIEW_MODULES[viewId];
  if (!moduleName) return false;
  return currentUserHasPermission(moduleName, 'view') || currentUserHasPermission(moduleName, 'viewOwn');
}

function shellCanCollect() {
  return shellCanOpen('receipts') && (isCurrentUserAdmin() || can('customers', 'viewBalance'));
}

// ---------- bottom tab bar (Home · Receipts · + · Customers · More) ----------

function renderManagerTabBar() {
  const isAr = state.language === 'ar';
  const delivery = isDeliveryRole(state.currentUser?.role);
  const lead = delivery
    ? [{ id: 'delivery-dashboard', icon: 'layout-dashboard', label: isAr ? 'الرئيسية' : 'Home' }, { id: 'deliveries', icon: 'truck', label: isAr ? 'التوصيل' : 'Delivery' }]
    : [{ id: 'analytics', icon: 'house', label: isAr ? 'الرئيسية' : 'Home' }, { id: 'receipts', icon: 'receipt', label: isAr ? 'الوصولات' : 'Receipts' }];
  const trail = delivery ? [] : [{ id: 'customers', icon: 'users', label: isAr ? 'العملاء' : 'Customers' }];
  const canAddReceipt = !delivery && currentUserHasPermission('receipts', 'add');
  const item = (entry) => `
      <button type="button" onclick="navigateTo('${entry.id}')" class="mobile-bottom-nav-item ${state.currentView === entry.id ? 'is-active' : ''}" aria-current="${state.currentView === entry.id ? 'page' : 'false'}">
        <i data-lucide="${entry.icon}" class="h-5 w-5"></i>
        <span>${entry.label}</span>
      </button>`;
  return `
    <nav class="mobile-bottom-nav" aria-label="${isAr ? 'التنقل السريع' : 'Quick navigation'}">
      ${lead.filter(entry => shellCanOpen(entry.id)).map(item).join('')}
      ${canAddReceipt ? `
      <button type="button" onclick="showNewReceiptChooser()" class="mobile-bottom-nav-item mobile-bottom-nav-fab" aria-label="${isAr ? 'إنشاء وصل' : 'Create receipt'}">
        <span class="mobile-bottom-nav-fab-circle"><i data-lucide="plus" class="h-6 w-6"></i></span>
      </button>` : ''}
      ${trail.filter(entry => shellCanOpen(entry.id)).map(item).join('')}
      <button type="button" onclick="navigateTo('more')" class="mobile-bottom-nav-item ${state.currentView === 'more' ? 'is-active' : ''}" aria-label="${isAr ? 'المزيد' : 'More'}">
        <i data-lucide="grid-3x3" class="h-5 w-5"></i>
        <span>${isAr ? 'المزيد' : 'More'}</span>
      </button>
    </nav>
  `;
}

// ---------- More page ----------

function shellMoreTiles() {
  const isAr = state.language === 'ar';
  const admin = isCurrentUserAdmin();
  const receipts = Array.isArray(state.receipts) ? getVisibleRecords(state.receipts) : [];
  const pendingDeliveries = receipts.filter(r => ['Needs Delivery', 'In Progress'].includes(String(r?.deliveryStatus || '').trim())).length;
  const activeAds = (Array.isArray(state.ads) ? getVisibleRecords(state.ads) : []).filter(a => a && a.recordType !== 'receipt' && String(a.status || '') === 'Active').length;
  const pagesCount = (Array.isArray(state.pages) ? getVisibleRecords(state.pages) : []).length;
  const usersCount = (Array.isArray(state.users) ? getVisibleRecords(state.users) : []).length;
  const tiles = [
    { id: 'pages', icon: 'file-text', color: 'from-sky-500 to-blue-500', name: isAr ? 'الصفحات' : 'Pages', sub: isAr ? `${pagesCount} مُدارة` : `${pagesCount} managed` },
    { id: 'ads', icon: 'megaphone', color: 'from-indigo-500 to-violet-500', name: isAr ? 'الحملات الإعلانية' : 'Ad campaigns', sub: isAr ? `${activeAds} نشطة` : `${activeAds} active` },
    { id: 'deliveries', icon: 'truck', color: 'from-emerald-500 to-teal-500', name: isAr ? 'التوصيل' : 'Deliveries', sub: isAr ? `${pendingDeliveries} معلّقة` : `${pendingDeliveries} pending` },
    { id: 'reconciliation', icon: 'clipboard-check', color: 'from-amber-500 to-orange-500', name: isAr ? 'التسوية' : 'Reconciliation', sub: isAr ? 'النقد اليومي' : 'Daily cash' },
    { id: 'collect', icon: 'hand-coins', color: 'from-rose-500 to-pink-500', name: isAr ? 'تحصيل دين' : 'Collect a debt', sub: isAr ? 'المستحقات والتذكيرات' : 'Debts & reminders', allowed: shellCanCollect() },
    { id: 'users', icon: 'users', color: 'from-blue-500 to-cyan-500', name: isAr ? 'الفريق' : 'Team', sub: isAr ? `${usersCount} أعضاء` : `${usersCount} members` },
    { id: 'audit', icon: 'file-clock', color: 'from-slate-500 to-slate-600', name: isAr ? 'سجل التدقيق' : 'Audit log', sub: isAr ? 'كل النشاط' : 'All activity' },
    { id: 'settings', icon: 'settings', color: 'from-slate-600 to-slate-700', name: isAr ? 'الإعدادات' : 'Settings', sub: isAr ? 'المظهر · الحساب' : 'Theme · account' },
    { id: 'control-center', icon: 'gauge', color: 'from-violet-600 to-fuchsia-600', name: isAr ? 'مركز التحكم' : 'Control Center', sub: isAr ? 'الباقات والأدوات' : 'Plans & tools', allowed: admin },
    { id: 'wallet', icon: 'wallet', color: 'from-emerald-600 to-green-500', name: isAr ? 'المحفظة' : 'Wallet', sub: isAr ? 'الرصيد والتحويلات' : 'Balance & transfers', allowed: admin },
    { id: 'services-hub', icon: 'grid-3x3', color: 'from-blue-600 to-cyan-500', name: isAr ? 'مركز الخدمات' : 'Services Hub', sub: isAr ? 'كل خدمات المنصة' : 'All platform services', allowed: admin },
    { id: 'clothes-system', icon: 'shirt', color: 'from-rose-500 to-pink-500', name: isAr ? 'نظام الملابس' : 'Clothes System', sub: isAr ? 'المستودع والشحنات' : 'Warehouse & shipments' },
    { id: 'ads-studio', icon: 'rocket', color: 'from-blue-600 to-cyan-500', name: isAr ? 'استوديو الإعلانات' : 'Ads Studio', sub: isAr ? 'منشورات وردود تلقائية' : 'Posts & auto-replies', allowed: admin || hasSubscription('ad_maker') }
  ];
  return tiles.filter(tile => tile.allowed === undefined ? shellCanOpen(tile.id) : tile.allowed);
}

function renderMoreView() {
  const isAr = state.language === 'ar';
  const tiles = shellMoreTiles();
  const user = state.currentUser || {};
  return `
    <div class="hub-shell">
      <h1 class="text-[26px] font-extrabold tracking-tight text-slate-900 dark:text-white mb-4">${isAr ? 'المزيد' : 'More'}</h1>
      <button type="button" onclick="editUser('${shellEsc(user.id)}')" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 mb-5 text-start touch-target">
        <span class="w-11 h-11 rounded-full alb-mark flex items-center justify-center text-white font-bold flex-shrink-0">${shellEsc(shellInitial(user.name))}</span>
        <span class="flex-1 min-w-0"><span class="block truncate font-bold text-slate-900 dark:text-white">${shellEsc(user.name || 'User')}</span><span class="block text-xs text-slate-500">${shellEsc(user.role || '')}</span></span>
        <i data-lucide="${isAr ? 'chevron-left' : 'chevron-right'}" class="w-4 h-4 text-slate-400"></i>
      </button>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${tiles.map(tile => `
          <button type="button" onclick="navigateTo('${tile.id}')" class="hub-card hub-tile w-full p-4 text-start touch-target">
            <span class="w-11 h-11 rounded-2xl bg-gradient-to-br ${tile.color} flex items-center justify-center text-white shadow-md"><i data-lucide="${tile.icon}" class="w-5 h-5"></i></span>
            <span class="mt-3 block truncate text-sm font-bold text-slate-900 dark:text-white">${tile.name}</span>
            <span class="block truncate text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${tile.sub}</span>
          </button>`).join('')}
      </div>
      <div class="mt-6 grid grid-cols-2 gap-2">
        <button type="button" onclick="toggleTheme()" class="hub-card touch-target min-h-12 flex items-center justify-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><i data-lucide="${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}" class="w-4 h-4"></i>${isAr ? 'المظهر' : 'Theme'}: ${shellEsc(state.theme)}</button>
        <button type="button" onclick="toggleLanguage()" class="hub-card touch-target min-h-12 flex items-center justify-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><i data-lucide="globe" class="w-4 h-4"></i>${isAr ? 'English' : 'العربية'}</button>
      </div>
      <button type="button" onclick="handleLogout()" class="touch-target mt-3 w-full min-h-12 rounded-2xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 font-bold flex items-center justify-center gap-2"><i data-lucide="log-out" class="w-4 h-4"></i>${t('logout')}</button>
      <div class="mt-3">${renderAlwaysAvailableAccountLinks()}</div>
    </div>
  `;
}

// ---------- Home hero (top of the analytics view) ----------

function renderManagerHomeHero(receipts, ads, canViewFinancials) {
  const isAr = state.language === 'ar';
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const inWindow = (value, from, to) => { const ts = new Date(value || 0).getTime(); return Number.isFinite(ts) && ts >= from && ts < to; };
  const revenueReceipts = (Array.isArray(receipts) ? receipts : []).filter(r => r && !isTransferInReceipt(r));
  const paidThisMonth = revenueReceipts.filter(r => getReceiptPaymentState(r) === 'paid' && inWindow(r.createdAt || r.startDate, monthStart, Infinity));
  const paidLastMonth = revenueReceipts.filter(r => getReceiptPaymentState(r) === 'paid' && inWindow(r.createdAt || r.startDate, prevStart, monthStart));
  const collectedLyd = paidThisMonth.reduce((sum, r) => sum + shellReceiptLyd(r), 0);
  const collectedUsd = paidThisMonth.reduce((sum, r) => sum + (Number(r.amountUSD) || 0), 0);
  const prevLyd = paidLastMonth.reduce((sum, r) => sum + shellReceiptLyd(r), 0);
  const pct = prevLyd > 0 ? Math.round(((collectedLyd - prevLyd) / prevLyd) * 100) : null;
  const receiptsThisMonth = revenueReceipts.filter(r => inWindow(r.createdAt || r.startDate, monthStart, Infinity)).length;
  const adSpendUsd = (Array.isArray(ads) ? ads : []).filter(a => a && inWindow(a.createdAt || a.startDate, monthStart, Infinity)).reduce((sum, a) => sum + getAdSpendUSD(a), 0);
  let owedLyd = 0;
  let owedCount = 0;
  if (canViewFinancials) {
    const statsIndex = buildCustomerStatsIndex();
    getCustomersVisibleToCurrentUser().forEach(c => {
      const stats = getCustomerStats(c.id, statsIndex);
      if (stats.balance < -0.005) {
        owedCount += 1;
        const lyd = Number(stats.balanceLYD);
        owedLyd += Math.abs(Number.isFinite(lyd) && lyd !== 0 ? lyd : stats.balance * (Number(state.defaultExchangeRate) || 0));
      }
    });
  }
  const monthName = (() => { try { return now.toLocaleDateString(appDateLocale(), { month: 'long' }); } catch (_) { return ''; } })();
  const recent = revenueReceipts.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
  const customersById = new Map((Array.isArray(state.customers) ? state.customers : []).map(c => [String(c.id), c]));
  const canAddReceipt = currentUserHasPermission('receipts', 'add');
  const canAddAd = can('ads', 'add');
  const quick = [
    canAddReceipt ? { icon: 'receipt', label: isAr ? 'وصل' : 'Receipt', onclick: 'showNewReceiptChooser()' } : null,
    canAddAd ? { icon: 'megaphone', label: isAr ? 'إعلان' : 'New ad', onclick: 'showAdModal()' } : null,
    shellCanCollect() ? { icon: 'hand-coins', label: isAr ? 'تحصيل' : 'Collect', onclick: "navigateTo('collect')" } : null,
    { icon: 'grid-3x3', label: isAr ? 'المزيد' : 'More', onclick: "navigateTo('more')" }
  ].filter(Boolean);
  const kpi = (label, value, onclick) => `
    <button type="button" onclick="${onclick}" class="hub-card p-3.5 text-start touch-target">
      <span class="block text-[11px] text-slate-500 dark:text-slate-400">${label}</span>
      <span class="block mt-1 text-lg font-extrabold text-slate-900 dark:text-white truncate" dir="ltr">${value}</span>
    </button>`;
  return `
    <section class="manager-home-hero space-y-4" data-manager-home-hero>
      <button type="button" onclick="navigateTo('receipts')" class="hub-hero relative overflow-hidden w-full rounded-3xl p-5 text-start text-white touch-target">
        <span class="absolute -top-10 -end-6 w-40 h-40 rounded-full bg-white/10"></span>
        <span class="relative block">
          <span class="block text-[11px] font-bold uppercase tracking-[0.14em] text-white/70">Albayan</span>
          <span class="block mt-1 text-sm text-white/80">${canViewFinancials ? (isAr ? `المُحصَّل · ${shellEsc(monthName)}` : `Collected · ${shellEsc(monthName)}`) : (isAr ? `وصولات · ${shellEsc(monthName)}` : `Receipts · ${shellEsc(monthName)}`)}</span>
          <span class="block mt-1 text-3xl font-black tracking-tight" dir="ltr">${canViewFinancials ? shellEsc(shellLyd(collectedLyd)) : receiptsThisMonth}</span>
          ${canViewFinancials ? `<span class="mt-2 flex flex-wrap items-center gap-3 text-xs text-white/80">
            ${pct === null ? `<span>${isAr ? 'أول شهر مُسجَّل' : 'First month on record'}</span>` : `<span class="inline-flex items-center gap-1"><i data-lucide="${pct >= 0 ? 'trending-up' : 'trending-down'}" class="w-3.5 h-3.5"></i>${pct >= 0 ? '+' : ''}${pct}% ${isAr ? 'مقابل الشهر الماضي' : 'vs last month'}</span>`}
            <span dir="ltr">≈ ${shellEsc(shellUsd(collectedUsd))}</span>
          </span>` : ''}
        </span>
      </button>
      <div class="grid gap-2" style="grid-template-columns: repeat(${quick.length}, minmax(0, 1fr));">
        ${quick.map(q => `<button type="button" onclick="${q.onclick}" class="hub-card touch-target flex flex-col items-center justify-center gap-1.5 p-3 text-center"><span class="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 flex items-center justify-center"><i data-lucide="${q.icon}" class="w-5 h-5"></i></span><span class="text-[11px] font-bold text-slate-700 dark:text-slate-200">${q.label}</span></button>`).join('')}
      </div>
      <div class="grid grid-cols-3 gap-2">
        ${kpi(isAr ? 'الوصولات' : 'Receipts', receiptsThisMonth, "navigateTo('receipts')")}
        ${canViewFinancials ? kpi(isAr ? 'مستحق' : 'Owed', shellEsc(shellLyd(owedLyd)), shellCanCollect() ? "navigateTo('collect')" : "navigateTo('customers')") : kpi(isAr ? 'العملاء' : 'Customers', getCustomersVisibleToCurrentUser().length, "navigateTo('customers')")}
        ${canViewFinancials ? kpi(isAr ? 'الإنفاق' : 'Ad spend', shellEsc(shellUsd(adSpendUsd)), "navigateTo('ads')") : kpi(isAr ? 'الإعلانات' : 'Ads', (Array.isArray(ads) ? ads.length : 0), "navigateTo('ads')")}
      </div>
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="hub-section-title mb-0">${isAr ? 'النشاط الأخير' : 'Recent activity'}</span>
          <button type="button" onclick="navigateTo('receipts')" class="touch-target min-h-10 px-2 text-[13px] font-semibold text-blue-600 dark:text-blue-300">${isAr ? 'عرض الكل' : 'See all'}</button>
        </div>
        ${recent.length ? `<div class="space-y-2">${recent.map(r => {
          const customerName = customersById.get(String(getReceiptCustomerReferenceId(r)))?.name || r.customerName || (isAr ? 'غير معروف' : 'Unknown');
          const meta = shellReceiptStatusMeta(r);
          const number = shellReceiptNumber(r);
          return `<button type="button" onclick="openReceiptFromHome('${shellEsc(r.id)}')" class="hub-card hub-row w-full flex items-center gap-3 p-3 text-start touch-target">
            <span class="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center font-bold flex-shrink-0">${shellEsc(shellInitial(customerName))}</span>
            <span class="flex-1 min-w-0"><span class="block truncate text-sm font-bold text-slate-900 dark:text-white">${shellEsc(customerName)}</span><span class="block truncate text-[11px] text-slate-500">${number ? `#${shellEsc(number)} · ` : ''}${r.createdAt ? shellEsc(new Date(r.createdAt).toLocaleDateString(appDateLocale())) : ''}</span></span>
            <span class="text-end flex-shrink-0"><span class="block text-sm font-extrabold text-slate-900 dark:text-white" dir="ltr">${canViewFinancials ? shellEsc(shellLyd(shellReceiptLyd(r))) : ''}</span>${shellPill(meta.label, meta.tone)}</span>
          </button>`;
        }).join('')}</div>` : `<div class="hub-card p-5 text-center text-sm text-slate-500">${isAr ? 'لا يوجد نشاط بعد' : 'No activity yet'}</div>`}
      </div>
    </section>
  `;
}

function openReceiptFromHome(receiptId) {
  const id = String(receiptId || '');
  if (!id) return;
  state.receiptSearch = '';
  state.receiptCustomerFilter = '';
  state.receiptRecordFilter = id;
  navigateTo('receipts');
}

// ---------- Collect a debt ----------

let _collectFilter = 'all'; // 'all' | 'overdue' | 'oldest'
const SHELL_OVERDUE_DAYS = 30;

function collectSetFilter(mode) {
  _collectFilter = ['overdue', 'oldest'].includes(mode) ? mode : 'all';
  render();
}

function shellDebtorRows() {
  const statsIndex = buildCustomerStatsIndex();
  const now = Date.now();
  const rows = [];
  getCustomersVisibleToCurrentUser().forEach(c => {
    const stats = getCustomerStats(c.id, statsIndex);
    if (!(stats.balance < -0.005)) return;
    const unpaid = (statsIndex.receiptsByCustomer.get(String(c.id)) || []).filter(r => r && !r._deleted && getReceiptPaymentState(r) === 'not_paid');
    let oldest = null;
    unpaid.forEach(r => { const ts = new Date(r.createdAt || r.startDate || 0).getTime(); if (Number.isFinite(ts) && ts > 0 && (oldest === null || ts < oldest)) oldest = ts; });
    const ageDays = oldest === null ? null : Math.max(0, Math.floor((now - oldest) / TIME_CONSTANTS.MILLISECONDS_PER_DAY));
    const lyd = Number(stats.balanceLYD);
    const dueLyd = Math.abs(Number.isFinite(lyd) && lyd !== 0 ? lyd : stats.balance * (Number(state.defaultExchangeRate) || 0));
    rows.push({
      customer: c, stats, unpaid, oldest, ageDays, dueLyd, dueUsd: Math.abs(stats.balance),
      overdue: ageDays !== null && ageDays > SHELL_OVERDUE_DAYS,
      number: unpaid.length ? shellReceiptNumber(unpaid.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0]) : ''
    });
  });
  return rows;
}

function shellAgeText(ageDays) {
  if (ageDays === null || ageDays === undefined) return shellText('no open receipt', 'بدون وصل مفتوح');
  if (ageDays === 0) return shellText('today', 'اليوم');
  if (ageDays === 1) return shellText('1 day', 'يوم واحد');
  return shellText(`${ageDays} days`, `${ageDays} يوماً`);
}

function renderCollectView() {
  const isAr = state.language === 'ar';
  if (!shellCanCollect()) {
    return `<div class="hub-shell"><div class="hub-card p-8 text-center"><i data-lucide="lock" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${isAr ? 'لا توجد صلاحية' : 'No access'}</p><p class="text-sm text-slate-500 mt-1">${isAr ? 'تحصيل الديون يحتاج صلاحية عرض الوصولات وأرصدة العملاء.' : 'Collecting debts needs receipt and customer-balance permissions.'}</p></div></div>`;
  }
  let rows = shellDebtorRows();
  const totalLyd = rows.reduce((sum, r) => sum + r.dueLyd, 0);
  const overdueCount = rows.filter(r => r.overdue).length;
  if (_collectFilter === 'overdue') rows = rows.filter(r => r.overdue);
  rows.sort((a, b) => _collectFilter === 'oldest'
    ? ((a.oldest || Infinity) - (b.oldest || Infinity))
    : (b.dueLyd - a.dueLyd));
  const chips = [['all', isAr ? 'الكل' : 'All'], ['overdue', isAr ? 'المتأخرة' : 'Overdue'], ['oldest', isAr ? 'الأقدم أولاً' : 'Oldest first']];
  return `
    <div class="hub-shell">
      ${hubPageHeader(isAr ? 'تحصيل دين' : 'Collect a debt', { backTo: 'analytics' })}
      <div class="hub-card p-4 mb-4">
        <div class="text-[11px] text-slate-500 dark:text-slate-400">${isAr ? 'الرصيد المستحق' : 'Outstanding balance'}</div>
        <div class="mt-1 text-3xl font-black text-slate-900 dark:text-white" dir="ltr">${shellEsc(shellLyd(totalLyd))}</div>
        <div class="mt-1 text-xs text-slate-500">${isAr ? `${rows.length === 1 ? 'عميل واحد' : `${rows.length} عملاء`} · ${overdueCount} متأخر` : `${rows.length} customer${rows.length === 1 ? '' : 's'} · ${overdueCount} overdue`}</div>
      </div>
      <div class="flex gap-2 mb-3 overflow-x-auto custom-scrollbar pb-1">
        ${chips.map(([id, label]) => `<button type="button" onclick="collectSetFilter('${id}')" class="touch-target min-h-10 whitespace-nowrap rounded-full px-4 text-sm font-bold ${_collectFilter === id ? 'bg-blue-600 text-white' : 'hub-card text-slate-700 dark:text-slate-200'}">${label}</button>`).join('')}
      </div>
      ${can('customers', 'viewContacts') ? `<button type="button" onclick="navigateTo('reminders')" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 mb-4 text-start touch-target">
        <span class="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 flex items-center justify-center flex-shrink-0"><i data-lucide="message-circle" class="w-5 h-5"></i></span>
        <span class="flex-1 min-w-0 text-sm font-bold text-slate-900 dark:text-white">${isAr ? 'إرسال التذكيرات' : 'Send reminders'}</span>
        <i data-lucide="${isAr ? 'chevron-left' : 'chevron-right'}" class="w-4 h-4 text-slate-400"></i>
      </button>` : ''}
      ${rows.length ? `<div class="space-y-2">${rows.map(row => `
        <button type="button" onclick="openDebtorCollection('${shellEsc(row.customer.id)}')" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 text-start touch-target">
          <span class="w-11 h-11 rounded-full ${row.overdue ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'} flex items-center justify-center font-bold flex-shrink-0">${shellEsc(shellInitial(row.customer.name))}</span>
          <span class="flex-1 min-w-0"><span class="block truncate text-sm font-bold text-slate-900 dark:text-white">${shellEsc(row.customer.name)}</span><span class="block truncate text-[11px] text-slate-500">${row.number ? `#${shellEsc(row.number)} · ` : ''}<span class="${row.overdue ? 'text-rose-600 font-bold' : ''}">${shellEsc(shellAgeText(row.ageDays))}</span></span></span>
          <span class="text-end flex-shrink-0"><span class="block text-sm font-extrabold text-slate-900 dark:text-white" dir="ltr">${shellEsc(shellLyd(row.dueLyd))}</span><span class="block text-[10px] text-slate-400" dir="ltr">${shellEsc(shellUsd(row.dueUsd))}</span></span>
          <i data-lucide="${isAr ? 'chevron-left' : 'chevron-right'}" class="w-4 h-4 text-slate-400"></i>
        </button>`).join('')}</div>`
        : `<div class="hub-card p-8 text-center"><i data-lucide="badge-check" class="w-10 h-10 mx-auto text-emerald-400 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${isAr ? 'لا توجد ديون مستحقة' : 'Nothing outstanding'}</p><p class="text-sm text-slate-500 mt-1">${isAr ? 'كل العملاء مسدَّدون.' : 'Every customer is settled.'}</p></div>`}
    </div>
  `;
}

// One open receipt: go straight to the collect dialog. Several: show the
// customer's unpaid receipts so the right one is picked.
function openDebtorCollection(customerId) {
  const cid = String(customerId || '');
  const statsIndex = buildCustomerStatsIndex();
  const unpaid = (statsIndex.receiptsByCustomer.get(cid) || []).filter(r => r && !r._deleted && getReceiptPaymentState(r) === 'not_paid');
  if (unpaid.length === 1 && currentUserHasPermission('receipts', 'markCollected') && typeof openCollectReceiptModal === 'function') {
    openCollectReceiptModal(unpaid[0].id);
    return;
  }
  if (openCustomerReceipts(cid)) {
    state.receiptStatusFilter = 'not_paid';
    render();
  }
}

// ---------- WhatsApp reminders ----------

const SHELL_REMINDER_LOG_KEY = 'albayan_debt_reminders_v1';

function shellReminderLog() {
  try { const raw = localStorage.getItem(SHELL_REMINDER_LOG_KEY); const parsed = raw ? JSON.parse(raw) : {}; return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_) { return {}; }
}

function shellReminderStamp(customerId) {
  try { const log = shellReminderLog(); log[String(customerId)] = Date.now(); localStorage.setItem(SHELL_REMINDER_LOG_KEY, JSON.stringify(log)); } catch (_) {}
}

function shellReminderAgo(ts) {
  if (!ts) return shellText('never', 'لا يوجد');
  const days = Math.floor((Date.now() - Number(ts)) / TIME_CONSTANTS.MILLISECONDS_PER_DAY);
  if (days <= 0) return shellText('today', 'اليوم');
  if (days === 1) return shellText('yesterday', 'أمس');
  return shellText(`${days} days ago`, `قبل ${days} يوماً`);
}

function shellReminderMessage(row) {
  const office = shellText('Albayan', 'البيان');
  const amount = shellLyd(row.dueLyd);
  return state.language === 'ar'
    ? `مرحباً ${row.customer.name}، تذكير ودّي من ${office}: لديك رصيد مستحق بقيمة ${amount}. يسعدنا استلامه في أقرب وقت. شكراً لتعاونك.`
    : `Hello ${row.customer.name}, a friendly reminder from ${office}: your outstanding balance is ${amount}. We would appreciate settling it at your earliest convenience. Thank you.`;
}

function remindDebtor(customerId) {
  if (!can('customers', 'viewContacts')) return;
  const row = shellDebtorRows().find(r => String(r.customer.id) === String(customerId));
  if (!row) return;
  const phone = (getCustomerPhoneEntries(row.customer).map(entry => entry.value).find(Boolean)) || '';
  if (!phone) {
    showNotification(shellText('No phone number', 'لا يوجد رقم هاتف'), shellText('Add a phone number to this customer first.', 'أضف رقم هاتف لهذا العميل أولاً.'), 'warning');
    return;
  }
  const base = buildWhatsAppLink(phone);
  const url = `${base}${base.includes('?') ? '&' : '?'}text=${encodeURIComponent(shellReminderMessage(row))}`;
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) { try { window.location.href = url; } catch (_) {} }
  shellReminderStamp(row.customer.id);
  showNotification(shellText('Reminder opened', 'تم فتح التذكير'), shellText('WhatsApp is ready with the message.', 'واتساب جاهز بالرسالة.'), 'success');
  render();
}

// Browsers only allow one new window per tap, so "Remind all" walks the
// overdue list one tap at a time: each tap opens the next customer not
// reminded in the last day.
function remindAllOverdue() {
  const log = shellReminderLog();
  const dayAgo = Date.now() - TIME_CONSTANTS.MILLISECONDS_PER_DAY;
  const next = shellDebtorRows().filter(r => r.overdue).find(r => !(Number(log[String(r.customer.id)]) > dayAgo));
  if (!next) {
    showNotification(shellText('All reminded', 'تم تذكير الجميع'), shellText('Every overdue customer was reminded in the last day.', 'تم تذكير كل العملاء المتأخرين خلال اليوم الأخير.'), 'success');
    return;
  }
  remindDebtor(next.customer.id);
}

function renderRemindersView() {
  const isAr = state.language === 'ar';
  if (!shellCanCollect() || !can('customers', 'viewContacts')) {
    return `<div class="hub-shell"><div class="hub-card p-8 text-center"><i data-lucide="lock" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${isAr ? 'لا توجد صلاحية' : 'No access'}</p><p class="text-sm text-slate-500 mt-1">${isAr ? 'التذكيرات تحتاج صلاحية عرض أرقام العملاء.' : 'Reminders need permission to see customer contacts.'}</p></div></div>`;
  }
  const log = shellReminderLog();
  const rows = shellDebtorRows().sort((a, b) => (b.overdue - a.overdue) || (b.dueLyd - a.dueLyd));
  const overdueCount = rows.filter(r => r.overdue).length;
  return `
    <div class="hub-shell">
      ${hubPageHeader(isAr ? 'التذكيرات' : 'Reminders', { backTo: 'collect' })}
      <div class="hub-card p-3.5 mb-4 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
        <i data-lucide="message-circle" class="w-5 h-5 text-emerald-600 flex-shrink-0"></i>
        <span>${isAr ? 'تذكير كل المتأخرين عبر واتساب — كل ضغطة تفتح العميل التالي.' : 'Remind all overdue via WhatsApp — each tap opens the next customer.'}</span>
      </div>
      ${rows.length ? `<div class="space-y-2">${rows.map(row => `
        <div class="hub-card flex items-center gap-3 p-3.5">
          <span class="w-11 h-11 rounded-full ${row.overdue ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'} flex items-center justify-center font-bold flex-shrink-0">${shellEsc(shellInitial(row.customer.name))}</span>
          <span class="flex-1 min-w-0"><span class="block truncate text-sm font-bold text-slate-900 dark:text-white">${shellEsc(row.customer.name)}</span><span class="block truncate text-[11px] text-slate-500"><span dir="ltr">${shellEsc(shellLyd(row.dueLyd))}</span> · ${isAr ? 'آخر تذكير' : 'Last reminder'}: ${shellEsc(shellReminderAgo(log[String(row.customer.id)]))}</span></span>
          <button type="button" onclick="remindDebtor('${shellEsc(row.customer.id)}')" class="touch-target min-h-10 rounded-full bg-emerald-600 hover:bg-emerald-700 px-4 text-xs font-bold text-white">${isAr ? 'تذكير' : 'Remind'}</button>
        </div>`).join('')}</div>
      <button type="button" onclick="remindAllOverdue()" ${overdueCount ? '' : 'disabled'} class="touch-target mt-4 w-full min-h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold">${isAr ? `تذكير كل المتأخرين (${overdueCount})` : `Remind all overdue (${overdueCount})`}</button>`
        : `<div class="hub-card p-8 text-center"><i data-lucide="badge-check" class="w-10 h-10 mx-auto text-emerald-400 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${isAr ? 'لا أحد يحتاج تذكيراً' : 'Nobody needs a reminder'}</p></div>`}
    </div>
  `;
}

// ---------- Settings: appearance + account rows ----------

function shellSetTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : theme === 'system' ? 'system' : 'light';
  applyTheme();
  saveState();
  render();
}

function renderSettingsAppearanceCard() {
  const isAr = state.language === 'ar';
  const user = state.currentUser || {};
  const dark = state.theme === 'dark';
  const row = (label, value, onclick, extra = '') => `
    <button type="button" onclick="${onclick}" class="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-start touch-target">
      <span class="text-sm font-semibold text-slate-800 dark:text-white">${label}</span>
      <span class="flex items-center gap-2 text-sm text-slate-500">${value}${extra}</span>
    </button>`;
  return `
    <button type="button" onclick="editUser('${shellEsc(user.id)}')" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 text-start touch-target">
      <span class="w-11 h-11 rounded-full alb-mark flex items-center justify-center text-white font-bold flex-shrink-0">${shellEsc(shellInitial(user.name))}</span>
      <span class="flex-1 min-w-0"><span class="block truncate font-bold text-slate-900 dark:text-white">${shellEsc(user.name || 'User')}</span><span class="block text-xs text-slate-500">${shellEsc(user.role || '')}${user.email ? ` · <span dir="ltr">${shellEsc(user.email)}</span>` : ''}</span></span>
      <i data-lucide="${isAr ? 'chevron-left' : 'chevron-right'}" class="w-4 h-4 text-slate-400"></i>
    </button>
    <div class="hub-section-title mt-5">${isAr ? 'المظهر' : 'Appearance'}</div>
    <div class="hub-card divide-y divide-slate-200 dark:divide-slate-700">
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span class="text-sm font-semibold text-slate-800 dark:text-white">${isAr ? 'الوضع الداكن' : 'Dark mode'}</span>
        <button type="button" role="switch" aria-checked="${dark ? 'true' : 'false'}" onclick="shellSetTheme('${dark ? 'light' : 'dark'}')" class="touch-target relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors ${dark ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}" aria-label="${isAr ? 'الوضع الداكن' : 'Dark mode'}"><span class="absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${dark ? 'ltr:left-6 rtl:right-6' : 'ltr:left-1 rtl:right-1'}"></span></button>
      </div>
      ${row(isAr ? 'اتباع النظام' : 'Follow system theme', state.theme === 'system' ? (isAr ? 'مفعّل' : 'On') : (isAr ? 'متوقف' : 'Off'), "shellSetTheme('" + (state.theme === 'system' ? 'light' : 'system') + "')")}
      ${row(isAr ? 'اللغة' : 'Language', isAr ? 'العربية ›' : 'English ›', 'toggleLanguage()')}
    </div>
  `;
}

// ---------- one-time onboarding (packaged app only) ----------

const SHELL_ONBOARDED_KEY = 'albayan_onboarded_v1';
let _onboardingStep = 0;

function shellShouldShowOnboarding() {
  if (!state.currentUser || IS_STUDIO_SHELL || !shellIsNativeApp()) return false;
  try { return localStorage.getItem(SHELL_ONBOARDED_KEY) !== '1'; } catch (_) { return false; }
}

function dismissMobileOnboarding() {
  try { localStorage.setItem(SHELL_ONBOARDED_KEY, '1'); } catch (_) {}
  _onboardingStep = 0;
  document.getElementById('mobile-onboarding')?.remove();
}

function onboardingStep(delta) {
  _onboardingStep = Math.max(0, Math.min(2, _onboardingStep + delta));
  const host = document.getElementById('mobile-onboarding');
  if (!host) return;
  host.outerHTML = renderMobileOnboarding();
  const fresh = document.getElementById('mobile-onboarding');
  if (fresh && typeof IconQueue !== 'undefined') IconQueue.schedule(fresh);
}

function renderMobileOnboarding() {
  const isAr = state.language === 'ar';
  const slides = [
    { icon: 'briefcase', title: isAr ? 'مكتب إعلاناتك في جيبك' : 'Your ad office, in your pocket', text: isAr ? 'الوصولات والعملاء والإعلانات والتوصيل — في مكان واحد.' : 'Receipts, customers, ads and deliveries — all in one place.' },
    { icon: 'hand-coins', title: isAr ? 'حصّل الديون أينما كنت' : 'Collect debts on the go', text: isAr ? 'سجّل دفعة أو أرسل سائقاً، ويُسوّى النقد تلقائياً.' : 'Record a payment or send a driver; cash is reconciled automatically.' },
    { icon: 'languages', title: isAr ? 'بالعربية والإنجليزية، كما تحب' : 'Arabic & English, your way', text: isAr ? 'دعم كامل من اليمين لليسار، الدينار والدولار، فاتح أو داكن.' : 'Full right-to-left, LYD & USD, dark or light.' }
  ];
  const step = Math.max(0, Math.min(slides.length - 1, _onboardingStep));
  const slide = slides[step];
  const last = step === slides.length - 1;
  return `
    <div id="mobile-onboarding" class="fixed inset-0 z-[70] flex flex-col bg-white dark:bg-slate-950 p-6" dir="${isAr ? 'rtl' : 'ltr'}" role="dialog" aria-modal="true">
      <div class="flex items-center justify-between">
        ${step > 0 ? `<button type="button" onclick="onboardingStep(-1)" class="touch-target flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800" aria-label="${isAr ? 'رجوع' : 'Back'}"><i data-lucide="${isAr ? 'chevron-right' : 'chevron-left'}" class="w-5 h-5"></i></button>` : '<span></span>'}
        <button type="button" onclick="dismissMobileOnboarding()" class="touch-target min-h-11 px-3 text-sm font-bold text-slate-500">${isAr ? 'تخطّي' : 'Skip'}</button>
      </div>
      <div class="flex flex-1 flex-col items-center justify-center text-center">
        <span class="mb-6 flex h-24 w-24 items-center justify-center rounded-3xl alb-mark text-white shadow-xl"><i data-lucide="${slide.icon}" class="w-12 h-12"></i></span>
        <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white">${slide.title}</h2>
        <p class="mt-3 max-w-xs text-sm text-slate-500 dark:text-slate-400">${slide.text}</p>
      </div>
      <div>
        <div class="mb-4 flex justify-center gap-2">${slides.map((_, i) => `<span class="h-2 rounded-full ${i === step ? 'w-6 bg-blue-600' : 'w-2 bg-slate-300 dark:bg-slate-700'}"></span>`).join('')}</div>
        <button type="button" onclick="${last ? 'dismissMobileOnboarding()' : 'onboardingStep(1)'}" class="touch-target w-full min-h-14 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-base font-bold">${last ? (isAr ? 'ابدأ الآن' : 'Get started') : (isAr ? 'التالي' : 'Next')}</button>
      </div>
    </div>
  `;
}

// ---------- compact list rows (Receipts · Customers · Pages · Team) ----------
// The design draws these lists as one-line rows. Each row expands in place to
// the app's full card, so every existing button keeps working exactly as
// before — the row is only a summary on top of it.

const _shellExpanded = new Set();

function shellRowKey(kind, id) {
  return `${kind}:${id}`;
}

function shellRowIsOpen(kind, id) {
  return _shellExpanded.has(shellRowKey(kind, id));
}

function shellToggleRow(kind, id) {
  const key = shellRowKey(kind, id);
  if (_shellExpanded.has(key)) _shellExpanded.delete(key); else _shellExpanded.add(key);
  render();
}

function shellAvatar(initial, tone = 'blue', extra = '') {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    brand: 'alb-mark text-white'
  };
  return `<span class="w-11 h-11 rounded-full ${tones[tone] || tones.blue} flex items-center justify-center font-bold flex-shrink-0 ${extra}">${shellEsc(initial)}</span>`;
}

function shellSummaryButton({ kind, id, avatar, title, sub, trailing = '', open = false }) {
  const isAr = state.language === 'ar';
  const safeKind = shellEsc(kind);
  const safeId = shellEsc(id);
  return `
      <button type="button" onclick="shellToggleRow('${safeKind}', '${safeId}')" aria-expanded="${open ? 'true' : 'false'}" class="w-full flex items-center gap-3 p-3.5 text-start touch-target">
        ${avatar}
        <span class="flex-1 min-w-0">
          <span class="block truncate text-[15px] font-bold text-slate-900 dark:text-white">${title}</span>
          <span class="block truncate text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${sub}</span>
        </span>
        ${trailing ? `<span class="text-end flex-shrink-0 flex flex-col items-end gap-1">${trailing}</span>` : ''}
        <i data-lucide="${open ? 'chevron-up' : (isAr ? 'chevron-left' : 'chevron-right')}" class="w-4 h-4 text-slate-400 flex-shrink-0"></i>
      </button>`;
}

function shellListRow({ kind, id, avatar, title, sub, trailing = '', card = '', open = false, accent = '' }) {
  const safeKind = shellEsc(kind);
  const safeId = shellEsc(id);
  return `
    <div class="hub-card shell-row ${open ? 'is-open' : ''}" data-shell-row="${safeKind}" data-shell-row-id="${safeId}"${accent ? ` style="border-inline-start:4px solid ${shellEsc(accent)}"` : ''}>
      ${shellSummaryButton({ kind, id, avatar, title, sub, trailing, open })}
      ${card ? `<div class="shell-row-body"${open ? '' : ' hidden'}>${card}</div>` : ''}
    </div>`;
}

// Table lists (Ads, Deliveries): on phones a summary row sits above each
// detail row and the detail row shows only when expanded; on desktop the
// summary rows are hidden and the table stays a table (see style.css).
function shellTableSummaryRow(kind, id, fields, colspan) {
  const open = shellRowIsOpen(kind, id);
  return `<tr class="shell-tr-summary ${open ? 'is-open' : ''}" data-shell-row="${shellEsc(kind)}" data-shell-row-id="${shellEsc(id)}"><td colspan="${Number(colspan) || 1}" class="shell-tr-cell">${shellSummaryButton({ kind, id, open, ...fields })}</td></tr>`;
}

function shellTableDetailAttrs(kind, id) {
  return `data-shell-detail="${shellEsc(kind)}" data-shell-detail-id="${shellEsc(id)}"`;
}

function shellAdSummaryRow(ad, meta = {}) {
  const isAr = state.language === 'ar';
  const id = String(ad?.id || '');
  const name = meta.customer?.name || ad?.customerName || (meta.needsSetup ? (ad?.metaAdName || (isAr ? 'إعلان Meta جديد' : 'New Meta ad')) : (isAr ? 'غير معروف' : 'Unknown'));
  const tone = meta.needsSetup ? 'amber' : meta.isAdPaid ? 'emerald' : 'rose';
  const statusTones = { Pending: 'amber', Paused: 'slate', Completed: 'emerald', Canceled: 'rose', Lost: 'rose', Stopped: 'blue', Active: 'emerald' };
  const status = String(ad?.status || 'Active');
  const subParts = [];
  if (meta.adDisplayNum) subParts.push(`#${meta.adDisplayNum}`);
  if (meta.adPage?.name) subParts.push(shellEsc(meta.adPage.name));
  const start = new Date(ad?.startDate);
  if (!Number.isNaN(start.getTime()) && ad?.startDate) subParts.push(shellEsc(start.toLocaleDateString(appDateLocale())));
  if (meta.deliveryPerson?.name) subParts.push(shellEsc(meta.deliveryPerson.name));
  const amount = meta.needsSetup
    ? `<span class="text-xs font-bold text-amber-600">${isAr ? 'غير محدد' : 'Not set'}</span>`
    : `<span class="text-sm font-extrabold ${meta.isAdPaid ? 'text-slate-900 dark:text-white' : 'text-rose-600 dark:text-rose-400'}" dir="ltr">${shellEsc(shellUsd(Number(ad?.amountUSD) || 0))}</span>`;
  const pills = shellPill(shellEsc(trStatus(status)), statusTones[status] || 'slate')
    + (meta.needsSetup ? shellPill(isAr ? 'يحتاج إكمال' : 'Needs setup', 'amber') : (!meta.isAdPaid ? shellPill(isAr ? 'دين غير مدفوع' : 'Unpaid debt', 'rose') : ''));
  return shellTableSummaryRow('ads', id, {
    avatar: shellAvatar(shellInitial(name), tone),
    title: shellEsc(name),
    sub: subParts.join(' · '),
    trailing: `${amount}<span class="flex flex-wrap justify-end gap-1">${pills}</span>`
  }, 10);
}

function shellDeliverySummaryRow(item, meta = {}) {
  const isAr = state.language === 'ar';
  const id = String(item?.id || '');
  const name = meta.customer?.name || (isAr ? 'غير معروف' : 'Unknown');
  const status = String(item?.deliveryStatus || 'Needs Delivery');
  const tones = { 'Needs Delivery': 'amber', 'In Progress': 'blue', 'Delivered': 'emerald', 'Canceled': 'rose' };
  const subParts = [];
  subParts.push(meta.deliveryPerson?.name ? shellEsc(meta.deliveryPerson.name) : (isAr ? 'غير مُعيَّن' : 'Unassigned'));
  if (item?.createdAt || item?.date) subParts.push(shellEsc(formatDateShort(item.createdAt || item.date)));
  return shellTableSummaryRow('deliveries', id, {
    avatar: shellAvatar(shellInitial(name), tones[status] || 'slate'),
    title: shellEsc(name),
    sub: subParts.join(' · '),
    trailing: `<span class="text-sm font-extrabold text-slate-900 dark:text-white" dir="ltr">${shellEsc(shellLyd(Number(meta.debtLocal) || 0))}</span>${shellPill(shellEsc(trStatus(status)), tones[status] || 'slate')}`
  }, 7);
}

function shellReceiptRow(receipt, customer, card, meta = {}) {
  const isAr = state.language === 'ar';
  const id = String(receipt?.id || '');
  const name = customer?.name || receipt?.customerName || (isAr ? 'غير معروف' : 'Unknown');
  const serial = meta.displayFinalNo || meta.displayTempNo || '';
  const when = receipt?.createdAt || receipt?.startDate ? new Date(receipt.createdAt || receipt.startDate).toLocaleDateString(appDateLocale()) : '';
  const paymentState = getReceiptPaymentState(receipt);
  let tone = 'emerald';
  let pill = shellPill(isAr ? 'مدفوع' : 'Paid', 'emerald');
  if (meta.destroyed) { tone = 'rose'; pill = shellPill(isAr ? 'تالف' : 'Destroyed', 'rose'); }
  else if (meta.hasCustomerDebt) { tone = 'rose'; pill = shellPill(isAr ? 'دين العميل' : 'Customer debt', 'rose'); }
  else if (paymentState === 'canceled') { tone = 'slate'; pill = shellPill(isAr ? 'ملغى' : 'Canceled', 'slate'); }
  else if (paymentState === 'lost') { tone = 'rose'; pill = shellPill(isAr ? 'ضائع' : 'Lost', 'rose'); }
  else if (paymentState !== 'paid') { tone = 'amber'; pill = shellPill(isAr ? 'غير مدفوع' : 'Unpaid', 'amber'); }
  const amountLyd = meta.hasCustomerDebt && meta.collectionTarget
    ? Number(meta.collectionTarget.amountLocal) || 0
    : Number(receipt?.amountLocal) || 0;
  const trailing = `${meta.destroyed ? '' : `<span class="text-sm font-extrabold ${meta.hasCustomerDebt ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}" dir="ltr">${shellEsc(shellLyd(amountLyd))}</span>`}${pill}`;
  const subParts = [];
  if (meta.receiptDisplayNum) subParts.push(`#${meta.receiptDisplayNum}`);
  if (serial) subParts.push(`${isAr ? 'رقم' : 'No.'} ${shellEsc(serial)}${meta.displayTempNo && !meta.displayFinalNo ? (isAr ? ' (مؤقت)' : ' (temp)') : ''}`);
  if (when) subParts.push(shellEsc(when));
  if (receipt?.collected && !meta.destroyed) subParts.push(isAr ? 'مُحصَّل' : 'collected');
  const open = shellRowIsOpen('receipts', id) || (meta.receiptRecordFilter && meta.receiptRecordFilter === id);
  return shellListRow({
    kind: 'receipts', id, open, card,
    avatar: shellAvatar(shellInitial(name), tone),
    title: shellEsc(name),
    sub: subParts.join(' · '),
    trailing
  });
}

function shellCustomerRow(customer, stats, card, meta = {}) {
  const isAr = state.language === 'ar';
  const id = String(customer?.id || '');
  const phones = Array.isArray(meta.phones) ? meta.phones.filter(Boolean) : [];
  const sub = meta.canSeeContacts
    ? (phones.length ? `<span dir="ltr">${shellEsc(phones[0])}</span>${phones.length > 1 ? ` +${phones.length - 1}` : ''}` : (isAr ? 'لا يوجد هاتف' : 'No phone'))
    : shellEsc(customer?.platform || '');
  let trailing = shellPill(shellEsc(customer?.platform || ''), 'slate');
  let tone = 'blue';
  if (meta.canSeeBalance && stats) {
    const bal = Number(stats.balanceLYD) || 0;
    const balancePill = bal < -0.005
      ? shellPill(`${isAr ? 'مدين' : 'Owes'} ${shellEsc(shellLyd(Math.abs(bal)))}`, 'rose')
      : bal > 0.005
        ? shellPill(`${isAr ? 'رصيد' : 'Credit'} ${shellEsc(shellLyd(bal))}`, 'blue')
        : shellPill(isAr ? 'مسدَّد' : 'Settled', 'slate');
    tone = bal < -0.005 ? 'rose' : 'blue';
    trailing = `<span class="text-sm font-extrabold text-slate-900 dark:text-white" dir="ltr">${shellEsc(shellLyd(Number(stats.totalPaidLYD) || 0))}</span>${balancePill}`;
  }
  return shellListRow({
    kind: 'customers', id, card,
    open: shellRowIsOpen('customers', id),
    avatar: shellAvatar(shellInitial(customer?.name), tone),
    title: shellEsc(customer?.name || ''),
    sub: `${meta.displayNum ? `#${meta.displayNum} · ` : ''}${sub}`, trailing
  });
}

function shellPageRow(page, card, meta = {}) {
  const isAr = state.language === 'ar';
  const id = String(page?.id || '');
  const owners = Array.isArray(meta.linkedCustomers) ? meta.linkedCustomers : [];
  const subParts = [];
  if (page?.category) subParts.push(shellEsc(page.category));
  if (meta.canSeePageAds) subParts.push(`${Number(meta.pageStats?.totalAds) || 0} ${isAr ? 'إعلان' : 'ads'}`);
  if (owners.length) subParts.push(shellEsc(owners[0].name || '') + (owners.length > 1 ? ` +${owners.length - 1}` : ''));
  const pills = [];
  if (meta.isMetaImportedPage) pills.push(shellPill('Meta', 'blue'));
  if (meta.needsPageOwner) pills.push(shellPill(isAr ? 'يحتاج مالك' : 'Needs owner', 'amber'));
  const spend = meta.canSeePageFinancials && meta.pageStats
    ? `<span class="text-sm font-extrabold text-slate-900 dark:text-white" dir="ltr">${shellEsc(shellUsd(meta.pageStats.totalSpendUSD || 0))}</span>`
    : '';
  return shellListRow({
    kind: 'pages', id, card,
    open: shellRowIsOpen('pages', id),
    avatar: shellAvatar(shellInitial(page?.name), meta.needsPageOwner ? 'amber' : 'blue'),
    title: shellEsc(page?.name || ''),
    sub: subParts.join(' · ') || (isAr ? 'صفحة فيسبوك' : 'Facebook page'),
    trailing: `${spend}${pills.join('')}`
  });
}

function shellUserRow(user, card) {
  const isAr = state.language === 'ar';
  const id = String(user?.id || '');
  const roleLabel = isAr ? (({ Admin: 'مدير', Employee: 'موظف', Delivery: 'سائق توصيل' })[user?.role] || user?.role || '') : (user?.role || '');
  const rolePill = shellPill(shellEsc(roleLabel), isAdminRole(user?.role) ? 'rose' : isDeliveryRole(user?.role) ? 'blue' : 'slate');
  return shellListRow({
    kind: 'users', id, card,
    open: shellRowIsOpen('users', id),
    avatar: shellAvatar(shellInitial(user?.name), 'brand'),
    title: `${shellEsc(user?.name || '')}${String(user?.id) === String(state.currentUser?.id) ? ` <span class="text-[11px] font-semibold text-blue-600">${isAr ? '(أنت)' : '(You)'}</span>` : ''}`,
    sub: `<span dir="ltr">${shellEsc(user?.email || '')}</span>`,
    trailing: rolePill
  });
}
