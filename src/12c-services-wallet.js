// ==========================================
// SERVICES HUB, SMART SYSTEMS, PLANS, CHARGE WALLET AND WALLET SCREENS
// ==========================================
// Split out of 12-views.js when that module passed its 475 KiB cap.
// These screens form one product area: the service catalogue, its
// subscription state, the plan catalog, and the wallet that pays for it.
//
// Design (2026-09 "Albayan Studio" refresh): ONE responsive layout for web,
// iOS and Android — a centred phone-first column that widens into a grid on
// desktop. No feature was removed: every old action (coming-soon toast,
// paywall, theme/language/logout, wallet transfer, admin top-up in local
// mode, subscription cancel, transactions) still lives on these screens.
//
// Money rules are untouched: prices come ONLY from the server plan catalog
// (`state.subscriptionPlans`), purchases go through SUBSCRIPTIONS.purchasePlan
// and the server re-reads its own catalog inside the transaction.

// ---------- shared helpers ----------

function hubText(en, ar) {
  return state.language === 'ar' ? ar : en;
}

function hubEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

// Days left on the current user's real subscription rows for a service
// (null when there is no dated active row — e.g. an Admin, who is granted
// everything without buying it).
function hubDaysLeft(serviceId) {
  const expiry = typeof getSubscriptionExpiryForCurrentUser === 'function'
    ? getSubscriptionExpiryForCurrentUser(serviceId)
    : null;
  if (!expiry) return null;
  return Math.max(0, Math.ceil((expiry - Date.now()) / TIME_CONSTANTS.MILLISECONDS_PER_DAY));
}

// Server plan that sells exactly this one service (the implicit `svc:<id>`
// row, or any active single-service plan for it). Null until the catalog is
// loaded — the hub then shows "Subscribe" instead of inventing a price.
function hubPlanForService(serviceId) {
  const sid = String(serviceId || '');
  const plans = Array.isArray(state.subscriptionPlans) ? state.subscriptionPlans : [];
  return plans.find(p => p && String(p.id) === `svc:${sid}`)
    || plans.find(p => p && Array.isArray(p.serviceIds) && p.serviceIds.length === 1 && p.serviceIds[0] === sid)
    || null;
}

// "25 LYD" (major units, no trailing zeros for whole numbers) — pills only.
function hubMoney(minor, currency = 'LYD') {
  const major = walletFromMinor(Math.max(0, Number(minor) || 0), currency);
  const text = Number.isInteger(major)
    ? major.toLocaleString('en-US')
    : major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} ${walletNormalizeCurrency(currency)}`;
}

function hubPeriodLabel(durationDays) {
  const days = Number(durationDays) || 30;
  if (days === 30 || days === 31) return hubText('/ month', '/ شهر');
  if (days === 365 || days === 360) return hubText('/ year', '/ سنة');
  return hubText(`/ ${days} days`, `/ ${days} يوم`);
}

function hubPriceLabel(serviceId) {
  const plan = hubPlanForService(serviceId);
  if (!plan) return '';
  const price = Math.max(0, Number(plan.priceMinor) || 0);
  if (price <= 0) return hubText('Free', 'مجاني');
  return `${hubMoney(price, plan.currency || 'LYD')} ${hubPeriodLabel(plan.durationDays)}`;
}

// One status object drives every pill on these screens:
//   coming  -> "Coming soon"
//   active  -> "Active · N d" (amber "Expires in N d" once ≤ 7 days remain)
//   admin   -> "Included" (Admin is granted every service)
//   locked  -> price from the server catalog, or "Subscribe"
function hubServiceStatus(serviceId) {
  const sid = String(serviceId || '');
  const svc = SERVICES[sid] || SMART_SYSTEMS_CHILDREN[sid];
  if (!svc) return { kind: 'locked', label: hubText('Subscribe', 'اشترك'), tone: 'blue', days: null };
  if (svc.comingSoon) return { kind: 'coming', label: hubText('Coming soon', 'قريباً'), tone: 'slate', days: null };
  const required = Array.isArray(svc.requiredSubscriptions) && svc.requiredSubscriptions.length
    ? svc.requiredSubscriptions
    : [sid];
  let days = null;
  for (const rid of required) {
    const d = hubDaysLeft(rid);
    if (d !== null && (days === null || d > days)) days = d;
  }
  if (days !== null) {
    const soon = days <= 7;
    return {
      kind: 'active',
      days,
      soon,
      tone: soon ? 'amber' : 'emerald',
      label: soon
        ? hubText(`Expires in ${days} d`, `ينتهي خلال ${days} يوم`)
        : hubText(`Active · ${days} d`, `نشط · ${days} يوم`)
    };
  }
  if (!svc.requiresSubscription) return { kind: 'admin', label: hubText('Open', 'فتح'), tone: 'emerald', days: null };
  if (isCurrentUserAdmin()) return { kind: 'admin', label: hubText('Included', 'ضمن حسابك'), tone: 'emerald', days: null };
  const price = hubPriceLabel(required[0] || sid);
  return { kind: 'locked', label: price || hubText('Subscribe', 'اشترك'), tone: 'blue', days: null };
}

function hubPill(label, tone = 'slate', extraClass = '') {
  const tones = {
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  };
  return `<span class="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ${tones[tone] || tones.slate} ${extraClass}">${label}</span>`;
}

function hubServiceIcon(service, sizeClass = 'w-11 h-11', iconClass = 'w-5 h-5') {
  return `<span class="${sizeClass} rounded-2xl bg-gradient-to-br ${hubEsc(service.color || 'from-slate-500 to-slate-600')} flex items-center justify-center text-white shadow-md flex-shrink-0"><i data-lucide="${hubEsc(service.icon || 'box')}" class="${iconClass}"></i></span>`;
}

function hubBackButton(targetView = 'services-hub') {
  const isRTL = state.language === 'ar';
  return `<button type="button" onclick="navigateTo('${hubEsc(targetView)}')" class="touch-target flex h-11 w-11 items-center justify-center rounded-full bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200" aria-label="${hubText('Back', 'رجوع')}"><i data-lucide="${isRTL ? 'chevron-right' : 'chevron-left'}" class="w-5 h-5"></i></button>`;
}

function hubPageHeader(title, { backTo = 'services-hub', trailing = '' } = {}) {
  return `
    <div class="flex items-center gap-3 mb-5">
      ${hubBackButton(backTo)}
      <h1 class="flex-1 min-w-0 truncate text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">${title}</h1>
      ${trailing}
    </div>`;
}

// Wallet balance card shared by the hub, plans and wallet screens.
function hubWalletCard({ topUp = true, plansLink = false } = {}) {
  const uid = String(state.currentUser?.id || '');
  const balanceMinor = uid ? WALLET.getBalanceMinor(uid, 'LYD') : 0;
  return `
    <div class="hub-card flex items-center gap-3 p-3.5 mb-5">
      <button type="button" onclick="navigateTo('wallet')" class="flex flex-1 min-w-0 items-center gap-3 text-start touch-target">
        <span class="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 flex items-center justify-center flex-shrink-0"><i data-lucide="wallet" class="w-5 h-5"></i></span>
        <span class="min-w-0">
          <span class="block text-[11px] text-slate-500 dark:text-slate-400">${hubText('Wallet balance', 'رصيد المحفظة')}</span>
          <span class="block text-base font-extrabold text-slate-900 dark:text-white" dir="ltr">${hubEsc(walletFormatMinor(balanceMinor, 'LYD'))}</span>
        </span>
      </button>
      ${plansLink ? `<button type="button" onclick="navigateTo('plans')" class="touch-target min-h-10 rounded-full bg-slate-100 dark:bg-slate-800 px-3.5 text-xs font-bold text-slate-700 dark:text-slate-200">${hubText('Plans', 'الباقات')}</button>` : ''}
      ${topUp ? `<button type="button" onclick="hubOpenChargeWallet()" class="touch-target min-h-10 rounded-full bg-blue-50 dark:bg-blue-900/30 px-4 text-xs font-bold text-blue-700 dark:text-blue-300">${hubText('Top up', 'شحن')}</button>` : ''}
    </div>`;
}

// Load the server plan catalog once per session for price pills. Never
// authoritative for money — the paywall forces a fresh fetch before buying.
let _hubPlansRequested = false;
function hubEnsurePlansLoaded() {
  if (!isServerModeEnabled() || _hubPlansRequested) return;
  if (Array.isArray(state.subscriptionPlans) && state.subscriptionPlans.length) return;
  if (typeof refreshSubscriptionPlans !== 'function') return;
  _hubPlansRequested = true;
  refreshSubscriptionPlans().then(() => {
    if (['services-hub', 'smart-systems', 'plans'].includes(state.currentView)) render();
  }).catch(() => {});
}

function hubGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return hubText('Good morning', 'صباح الخير');
  if (hour < 18) return hubText('Good afternoon', 'مساء الخير');
  return hubText('Good evening', 'مساء الخير');
}

// ---------- Services Hub ----------

function renderServicesHub() {
  const userName = state.currentUser?.name || 'User';
  const isRTL = state.language === 'ar';
  hubEnsurePlansLoaded();

  const hubServices = Object.values(SERVICES)
    .slice()
    .filter(s => s && s.id && s.id !== 'placeholder_coming_soon')
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  // Smart Systems children that are sold as their own product (clothes, Ads
  // Studio) show as "your services" rows once bought, so they are one tap away.
  const ownedChildren = Object.values(SMART_SYSTEMS_CHILDREN)
    .filter(c => c && !c.comingSoon && Array.isArray(c.requiredSubscriptions) && !c.requiredSubscriptions.includes('smart_systems'))
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const activeRows = [];
  const exploreTiles = [];
  for (const service of hubServices) {
    const status = hubServiceStatus(service.id);
    if (status.kind === 'active') activeRows.push({ service, status, onclick: `handleServiceClick('${hubEsc(service.id)}')` });
    else exploreTiles.push({ service, status, onclick: `handleServiceClick('${hubEsc(service.id)}')` });
  }
  for (const child of ownedChildren) {
    const status = hubServiceStatus(child.id);
    if (status.kind === 'active') activeRows.push({ service: child, status, onclick: `handleSmartSystemClick('${hubEsc(child.id)}')` });
  }

  const chevron = isRTL ? 'chevron-left' : 'chevron-right';
  const activeHtml = activeRows.map(({ service, status, onclick }) => `
    <button type="button" onclick="${onclick}" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 text-start touch-target">
      ${hubServiceIcon(service)}
      <span class="flex-1 min-w-0">
        <span class="block truncate text-[15px] font-bold text-slate-900 dark:text-white">${hubEsc(isRTL ? service.nameAr : service.name)}</span>
        <span class="block truncate text-xs text-slate-500 dark:text-slate-400 mt-0.5">${hubEsc(isRTL ? service.descriptionAr : service.description)}</span>
      </span>
      ${hubPill(status.label, status.tone)}
      <i data-lucide="${chevron}" class="w-4 h-4 text-slate-400 flex-shrink-0"></i>
    </button>`).join('');

  const exploreHtml = exploreTiles.map(({ service, status, onclick }) => {
    const disabled = status.kind === 'coming';
    return `
      <button type="button" onclick="${onclick}" class="hub-card hub-tile relative overflow-hidden w-full p-4 text-start touch-target ${disabled ? 'opacity-70' : ''}">
        <i data-lucide="${hubEsc(service.icon || 'box')}" class="hub-tile-watermark" aria-hidden="true"></i>
        <span class="relative block">
          ${hubServiceIcon(service)}
          <span class="mt-3 block truncate text-sm font-bold text-slate-900 dark:text-white">${hubEsc(isRTL ? service.nameAr : service.name)}</span>
          <span class="block truncate text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 mb-2.5">${hubEsc(isRTL ? service.descriptionAr : service.description)}</span>
          <span class="flex flex-wrap items-center gap-1.5">
            ${hubPill(status.label, status.tone)}
            ${service.hasChildren ? hubPill(`${(service.children?.length || 0)} ${hubText('systems', 'أنظمة')}`, 'slate') : ''}
            ${status.kind === 'locked' ? `<i data-lucide="lock" class="w-3.5 h-3.5 text-amber-500"></i>` : ''}
          </span>
        </span>
      </button>`;
  }).join('');

  return `
    <div class="hub-shell">
      <!-- Header: avatar, greeting, quick actions (all pre-existing actions kept) -->
      <div class="flex items-center gap-3 mb-4">
        <div class="w-11 h-11 rounded-full alb-gradient-brand flex items-center justify-center text-white text-base font-bold shadow-md flex-shrink-0">
          ${hubEsc(userName.charAt(0).toUpperCase())}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">${hubGreeting()}</div>
          <div class="truncate text-base font-bold text-slate-900 dark:text-white">${isRTL ? `مرحباً، ${hubEsc(userName)}!` : `Welcome, ${hubEsc(userName)}!`}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" onclick="toggleTheme()" class="touch-target h-10 w-10 rounded-full bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200" aria-label="${hubText('Theme', 'المظهر')}"><i data-lucide="${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}" class="w-4 h-4"></i></button>
          <button type="button" onclick="toggleLanguage()" class="touch-target h-10 min-w-10 px-2 rounded-full bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-xs font-bold text-slate-700 dark:text-slate-200" aria-label="${hubText('Language', 'اللغة')}">${isRTL ? 'EN' : 'عربي'}</button>
          <button type="button" onclick="handleLogout()" class="touch-target h-10 w-10 rounded-full bg-rose-50 dark:bg-rose-900/20 text-rose-600 flex items-center justify-center" aria-label="${t('logout')}"><i data-lucide="log-out" class="w-4 h-4"></i></button>
        </div>
      </div>

      <h1 class="text-[26px] font-extrabold tracking-tight text-slate-900 dark:text-white mb-4">${hubText('Services Hub', 'مركز الخدمات')}</h1>

      ${hubWalletCard({ topUp: true, plansLink: false })}

      <!-- Hero -->
      <div class="hub-hero relative overflow-hidden rounded-3xl p-5 mb-6 text-white">
        <div class="absolute -top-10 -end-6 w-40 h-40 rounded-full bg-white/10"></div>
        <div class="relative flex items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-white/70">${hubText('New on Albayan', 'جديد في البيان')}</div>
            <div class="mt-1 text-xl font-extrabold">${hubText('Ads Studio: posts & auto-replies', 'استوديو الإعلانات: منشورات وردود تلقائية')}</div>
            <div class="mt-1 text-sm text-white/80">${hubText('Welcome to our partner success platform', 'أهلاً بشركاء النجاح')}</div>
          </div>
          <i data-lucide="sparkles" class="w-12 h-12 text-white/60 flex-shrink-0"></i>
        </div>
      </div>

      ${activeRows.length ? `
        <div class="hub-section-title">${hubText('Your services', 'خدماتك')}</div>
        <div class="space-y-2.5 mb-6">${activeHtml}</div>
      ` : ''}

      <div class="flex items-center justify-between mb-2.5">
        <div class="hub-section-title mb-0">${hubText('Explore', 'استكشف')}</div>
        <button type="button" onclick="navigateTo('plans')" class="touch-target min-h-10 px-2 text-[13px] font-semibold text-blue-600 dark:text-blue-300">${hubText('Plans & bundles', 'الباقات والاشتراكات')}</button>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        ${exploreHtml}
      </div>
    </div>
  `;
}

// ---------- Smart Systems ----------

function renderSmartSystems() {
  const isRTL = state.language === 'ar';
  hubEnsurePlansLoaded();

  const children = Object.values(SMART_SYSTEMS_CHILDREN)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const parentStatus = hubServiceStatus('smart_systems');
  const headerPill = parentStatus.kind === 'active'
    ? parentStatus.label
    : parentStatus.kind === 'admin'
      ? hubText('Included', 'ضمن حسابك')
      : hubText('Requires subscription', 'يتطلب اشتراكاً');
  const headerCta = parentStatus.kind === 'active' ? hubText('Renew', 'جدّد') : hubText('Subscribe', 'اشترك');

  const rows = children.map(child => {
    const status = hubServiceStatus(child.id);
    const locked = status.kind === 'locked';
    const pillTone = locked ? 'rose' : status.tone;
    const pillLabel = locked ? hubText('Requires subscription', 'يتطلب اشتراكاً') : status.label;
    return `
      <button type="button" onclick="handleSmartSystemClick('${hubEsc(child.id)}')" class="hub-card hub-row w-full flex items-center gap-3 p-3.5 text-start touch-target ${status.kind === 'coming' ? 'opacity-70' : ''}">
        ${hubServiceIcon(child)}
        <span class="flex-1 min-w-0">
          <span class="block truncate text-[15px] font-bold text-slate-900 dark:text-white">${hubEsc(isRTL ? child.nameAr : child.name)}</span>
          <span class="block truncate text-xs text-slate-500 dark:text-slate-400 mt-0.5">${hubEsc(isRTL ? child.descriptionAr : child.description)}</span>
        </span>
        <span class="flex items-center gap-1.5 flex-shrink-0">
          ${hubPill(pillLabel, pillTone)}
          ${locked ? `<i data-lucide="lock" class="w-4 h-4 text-slate-400"></i>` : ''}
        </span>
      </button>`;
  }).join('');

  return `
    <div class="hub-shell">
      ${hubPageHeader(hubText('Smart Systems', 'الأنظمة الذكية'))}
      <div class="relative overflow-hidden rounded-3xl p-5 mb-5 text-white bg-gradient-to-br from-violet-700 to-fuchsia-600 shadow-xl">
        <div class="absolute -top-8 -end-5 w-36 h-36 rounded-full bg-white/15"></div>
        <div class="relative">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-white/70">${hubText('Business tools & portals', 'أدوات الأعمال والبوابات')}</span>
            <span class="rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold">${headerPill}</span>
          </div>
          <div class="mt-2 text-2xl font-black">${hubText('Smart Systems', 'الأنظمة الذكية')}</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <span class="text-xs text-white/70">${children.length} ${hubText('systems', 'أنظمة')}</span>
            <button type="button" onclick="showSubscriptionModal('smart_systems', 'smart_systems')" class="touch-target min-h-10 rounded-full bg-white/20 px-4 text-xs font-bold text-white hover:bg-white/30">${headerCta}</button>
          </div>
        </div>
      </div>
      <div class="space-y-2.5">${rows}</div>
    </div>
  `;
}

// ---------- Plans & bundles ----------

let _plansViewFetchedAt = 0;
function plansEnsureFresh() {
  if (!isServerModeEnabled() || typeof refreshSubscriptionPlans !== 'function') return;
  if (Date.now() - _plansViewFetchedAt < 60000) return;
  _plansViewFetchedAt = Date.now();
  refreshSubscriptionPlans(true).then(() => { if (state.currentView === 'plans') render(); }).catch(() => {});
}

function hubServiceName(serviceId) {
  const svc = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  if (!svc) return String(serviceId || '');
  return state.language === 'ar' ? svc.nameAr : svc.name;
}

function hubPlanIsActive(plan) {
  const ids = Array.isArray(plan?.serviceIds) ? plan.serviceIds : [];
  if (!ids.length) return { active: false, days: null };
  let minDays = null;
  for (const sid of ids) {
    const d = hubDaysLeft(sid);
    if (d === null) return { active: false, days: null };
    if (minDays === null || d < minDays) minDays = d;
  }
  return { active: true, days: minDays };
}

function renderPlanRow(plan) {
  const isRTL = state.language === 'ar';
  const isBundle = Array.isArray(plan.serviceIds) && plan.serviceIds.length > 1;
  const bestValue = plan.badge === 'best_value' || isBundle;
  const price = Math.max(0, Number(plan.priceMinor) || 0);
  const { active, days } = hubPlanIsActive(plan);
  const soon = active && days !== null && days <= 7;
  const includes = (Array.isArray(plan.serviceIds) ? plan.serviceIds : []).map(sid =>
    `<span class="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300">${hubEsc(hubServiceName(sid))}</span>`).join('');
  return `
    <div class="hub-card p-4">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-[15px] font-bold text-slate-900 dark:text-white">${hubEsc((isRTL ? plan.nameAr : plan.name) || plan.id)}</span>
        ${bestValue ? `<span class="rounded-full bg-gradient-to-r from-blue-600 to-teal-400 px-2.5 py-1 text-[10px] font-extrabold text-white">${hubText('Best value', 'الأفضل قيمة')}</span>` : ''}
      </div>
      ${isBundle ? `<div class="flex flex-wrap gap-1.5 my-1.5">${includes}</div>` : `<div class="text-xs text-slate-500 dark:text-slate-400">${hubText('Single service', 'خدمة واحدة')}</div>`}
      ${Number(plan.savingsPct) > 0 ? `<div class="mt-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">${hubText(`Save ${Number(plan.savingsPct)}%`, `وفّر ${Number(plan.savingsPct)}%`)}</div>` : ''}
      <div class="mt-2.5 flex items-center justify-between gap-3">
        <span class="text-lg font-black text-slate-900 dark:text-white" dir="ltr">${price > 0 ? hubEsc(hubMoney(price, plan.currency || 'LYD')) : hubText('Free', 'مجاني')} <span class="text-xs font-semibold text-slate-500">${hubEsc(hubPeriodLabel(plan.durationDays))}</span></span>
        ${active ? hubPill(soon ? hubText(`Expires in ${days} d`, `ينتهي خلال ${days} يوم`) : hubText(`Active · ${days} d`, `نشط · ${days} يوم`), soon ? 'amber' : 'emerald') : ''}
      </div>
      <button type="button" onclick="openPlanPaywall('${hubEsc(plan.id)}')" class="touch-target mt-3 w-full min-h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold btn-shine">${active ? hubText('Renew', 'جدّد') : hubText('Subscribe', 'اشترك')}</button>
    </div>`;
}

function renderPlansView() {
  plansEnsureFresh();
  const plans = (Array.isArray(state.subscriptionPlans) ? state.subscriptionPlans : [])
    .filter(p => p && p.id && Array.isArray(p.serviceIds) && p.serviceIds.length)
    .slice()
    .sort((a, b) => {
      // Bundles first (best value), then the catalog order.
      const bundleDiff = (b.serviceIds.length > 1 ? 1 : 0) - (a.serviceIds.length > 1 ? 1 : 0);
      return bundleDiff || (Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    });

  let body = '';
  if (!isServerModeEnabled()) {
    body = `
      <div class="hub-card p-5 text-sm text-slate-600 dark:text-slate-300">
        <div class="font-bold text-slate-900 dark:text-white mb-1">${hubText('Plans need the server connection', 'الباقات تحتاج إلى اتصال الخادم')}</div>
        ${hubText('In local mode, open a service and subscribe from its card instead.', 'في الوضع المحلي، افتح الخدمة واشترك من بطاقتها.')}
      </div>`;
  } else if (!plans.length) {
    body = `
      <div class="hub-card p-6 text-center text-sm text-slate-500">
        <div class="w-6 h-6 mx-auto mb-2 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        ${hubText('Loading prices…', 'جاري تحميل الأسعار…')}
        <div class="mt-3"><button type="button" onclick="_plansViewFetchedAt = 0; plansEnsureFresh();" class="touch-target min-h-10 px-3 text-xs font-bold text-blue-600 underline">${hubText('Retry', 'إعادة المحاولة')}</button></div>
      </div>`;
  } else {
    body = `<div class="space-y-3">${plans.map(renderPlanRow).join('')}</div>`;
  }

  return `
    <div class="hub-shell">
      ${hubPageHeader(hubText('Plans & bundles', 'الباقات والاشتراكات'))}
      ${hubWalletCard({ topUp: true })}
      ${body}
      ${isCurrentUserAdmin() && isServerModeEnabled() ? `
        <p class="mt-5 text-center text-xs text-slate-500 dark:text-slate-400">
          ${hubText('Prices are set in Control Center → Plan manager.', 'تُضبط الأسعار من مركز التحكم ← إدارة الباقات.')}
        </p>` : ''}
    </div>
  `;
}

// Opens the paywall sheet with this plan pre-selected. The modal fetches a
// fresh catalog before any purchase — the row on screen is never trusted.
function openPlanPaywall(planId) {
  const pid = String(planId || '');
  const plan = (Array.isArray(state.subscriptionPlans) ? state.subscriptionPlans : []).find(p => p && String(p.id) === pid);
  if (!plan || !Array.isArray(plan.serviceIds) || !plan.serviceIds.length) return;
  const primary = plan.serviceIds[0];
  showSubscriptionModal(primary, primary, pid);
}

// ---------- Charge wallet ----------

const _chargeWallet = { amountText: '50', currency: 'LYD', method: '', busy: false, created: null };
let _walletPayMethods = null;
let _walletPayRate = null;
let _walletPayMethodsBusy = false;

function hubOpenChargeWallet() {
  _chargeWallet.created = null;
  navigateTo('charge-wallet');
}

function ensureWalletPayMethods() {
  if (!isServerModeEnabled() || _walletPayMethods !== null || _walletPayMethodsBusy) return;
  if (typeof apiWalletPaymentMethods !== 'function') return;
  _walletPayMethodsBusy = true;
  apiWalletPaymentMethods().then(catalog => {
    _walletPayMethods = Array.isArray(catalog?.methods) ? catalog.methods : [];
    _walletPayRate = catalog?.rate || null;
  }).catch(() => {
    _walletPayMethods = [];
  }).finally(() => {
    _walletPayMethodsBusy = false;
    if (state.currentView === 'charge-wallet') render();
  });
}

function chargeWalletAmountMinor() {
  const major = parseFloat(String(_chargeWallet.amountText || '').replace(/,/g, ''));
  if (!Number.isFinite(major) || major <= 0) return 0;
  return Math.round(major * 100);
}

function chargeWalletSetAmount(value) {
  _chargeWallet.amountText = String(value);
  render();
}

function chargeWalletAmountInput(el) {
  if (typeof sanitizeMoneyInput === 'function') sanitizeMoneyInput(el);
  _chargeWallet.amountText = String(el.value || '');
  const preview = document.getElementById('charge-wallet-amount-display');
  if (preview) preview.textContent = _chargeWallet.amountText || '0';
}

function chargeWalletSetCurrency(currency) {
  _chargeWallet.currency = currency === 'USD' ? 'USD' : 'LYD';
  render();
}

function chargeWalletPickMethod(id) {
  _chargeWallet.method = String(id || '');
  render();
}

function _walletPayMethodById(id) {
  return (Array.isArray(_walletPayMethods) ? _walletPayMethods : []).find(m => m && String(m.id) === String(id)) || null;
}

function chargeWalletInstructions(created) {
  const d = created && created.data ? created.data : (created || {});
  const entry = _walletPayMethodById(d.method);
  const isAr = state.language === 'ar';
  const template = entry && entry.instructions ? String(isAr ? entry.instructions.ar : entry.instructions.en) : '';
  if (!template) {
    return hubText(
      `Pay with reference ${d.reference || ''} — the wallet fills up as soon as the payment is confirmed.`,
      `ادفع بذكر الرمز ${d.reference || ''} — تتعبأ المحفظة فور تأكيد الدفع.`
    );
  }
  return template
    .split('{reference}').join(String(d.reference || ''))
    .split('{amountLYD}').join(d.amountMinorLYD ? (d.amountMinorLYD / 100).toFixed(2) : '—')
    .split('{amountUSD}').join(String(d.currency || 'USD') === 'USD' ? (Number(d.amountMinor || 0) / 100).toFixed(2) : '—')
    .split('{rate}').join(String(d.lydRate || ''));
}

async function chargeWalletCreateRequest() {
  if (_chargeWallet.busy) return;
  const amountMinor = chargeWalletAmountMinor();
  const currency = _chargeWallet.currency;
  if (amountMinor < 100) {
    showNotification(hubText('Invalid amount', 'مبلغ غير صالح'), hubText(`Minimum charge is 1.00 ${currency}`, `أقل مبلغ للشحن هو 1.00 ${currency}`), 'error');
    return;
  }
  if (!_chargeWallet.method || !_walletPayMethodById(_chargeWallet.method)) {
    showNotification(hubText('Pick a payment method', 'اختر طريقة الدفع'), hubText('Choose how you will pay, then create the request.', 'اختر كيف ستدفع ثم أنشئ الطلب.'), 'warning');
    return;
  }
  _chargeWallet.busy = true;
  render();
  try {
    const idem = `paycreate-${state.currentUser?.id || 'me'}-${Date.now()}`;
    const created = await apiWalletPaymentRequestCreate(amountMinor, _chargeWallet.method, idem, currency);
    _chargeWallet.created = created && created.data ? created.data : created;
    showNotification(hubText('Request created', 'تم إنشاء الطلب'), chargeWalletInstructions(_chargeWallet.created), 'success');
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
    showNotification(hubText('Could not create the request', 'تعذر إنشاء الطلب'), String(detail), 'error');
  } finally {
    _chargeWallet.busy = false;
    render();
  }
}

function renderChargeWalletView() {
  const isRTL = state.language === 'ar';
  ensureWalletPayMethods();

  if (!isServerModeEnabled()) {
    return `
      <div class="hub-shell">
        ${hubPageHeader(hubText('Charge wallet', 'اشحن المحفظة'))}
        <div class="hub-card p-5 text-sm text-slate-600 dark:text-slate-300">
          <div class="font-bold text-slate-900 dark:text-white mb-1">${hubText('Local mode', 'الوضع المحلي')}</div>
          ${hubText('Charge requests need the server connection. In local mode an Admin can add balance from the Wallet screen.', 'طلبات الشحن تحتاج إلى اتصال الخادم. في الوضع المحلي يمكن للمدير إضافة رصيد من شاشة المحفظة.')}
          <button type="button" onclick="navigateTo('wallet')" class="touch-target mt-4 w-full min-h-12 rounded-xl bg-slate-200 dark:bg-slate-700 font-bold text-slate-800 dark:text-white">${t('wallet')}</button>
        </div>
      </div>`;
  }

  const created = _chargeWallet.created;
  if (created) {
    const amountLabel = walletFormatMinor(Number(created.amountMinor || 0), created.currency || 'USD');
    const methodEntry = _walletPayMethodById(created.method);
    const methodName = methodEntry ? String((isRTL ? methodEntry.name?.ar : methodEntry.name?.en) || created.method) : String(created.method || '');
    return `
      <div class="hub-shell">
        ${hubPageHeader(hubText('Charge wallet', 'اشحن المحفظة'))}
        <div class="hub-card p-6 text-center">
          <span class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300"><i data-lucide="check" class="w-8 h-8"></i></span>
          <div class="text-xl font-extrabold text-slate-900 dark:text-white">${hubText('Request created', 'تم إنشاء الطلب')}</div>
          <div class="mt-1 text-sm text-slate-500 dark:text-slate-400">${hubText('The wallet fills as soon as the payment is confirmed', 'تتعبأ المحفظة فور تأكيد الدفع')}</div>
          <div class="mt-5 rounded-2xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 text-sm text-start">
            <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${hubText('Reference', 'الرمز المرجعي')}</span><span class="font-mono font-extrabold text-slate-900 dark:text-white" dir="ltr">${hubEsc(created.reference || '')}</span></div>
            <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${t('amount')}</span><span class="font-bold text-slate-900 dark:text-white" dir="ltr">${hubEsc(amountLabel)}</span></div>
            ${created.amountMinorLYD && String(created.currency || 'USD') !== 'LYD' ? `<div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${hubText('In LYD', 'بالدينار')}</span><span class="font-bold text-slate-900 dark:text-white" dir="ltr">${hubEsc(walletFormatMinor(Number(created.amountMinorLYD || 0), 'LYD'))}</span></div>` : ''}
            <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${hubText('Method', 'طريقة الدفع')}</span><span class="font-bold text-slate-900 dark:text-white">${hubEsc(methodName)}</span></div>
          </div>
          <p class="mt-4 text-sm text-slate-600 dark:text-slate-300 text-start leading-6">${hubEsc(chargeWalletInstructions(created))}</p>
          <button type="button" onclick="navigateTo('wallet')" class="touch-target mt-5 w-full min-h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold btn-shine">${hubText('View wallet', 'عرض المحفظة')}</button>
          <button type="button" onclick="_chargeWallet.created = null; render();" class="touch-target mt-2 w-full min-h-12 rounded-xl bg-slate-100 dark:bg-slate-800 font-bold text-slate-700 dark:text-slate-200">${hubText('New request', 'طلب جديد')}</button>
        </div>
      </div>`;
  }

  const methods = Array.isArray(_walletPayMethods) ? _walletPayMethods : [];
  if (methods.length && !_walletPayMethodById(_chargeWallet.method)) _chargeWallet.method = String(methods[0].id || '');
  const quick = [50, 100, 250];
  const currency = _chargeWallet.currency;
  const methodIcons = { bank_transfer: 'landmark', card: 'credit-card', qr: 'qr-code' };
  const rateNote = currency === 'USD' && _walletPayRate && _walletPayRate.usdToLyd
    ? `<div class="mt-2 text-center text-xs text-slate-500 dark:text-slate-400" dir="ltr">1 USD ≈ ${hubEsc(_walletPayRate.usdToLyd)} LYD</div>`
    : '';

  return `
    <div class="hub-shell">
      ${hubPageHeader(hubText('Charge wallet', 'اشحن المحفظة'))}

      <div class="text-center mt-2 mb-4">
        <div class="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400 mb-2">${t('amount')}</div>
        <div class="flex items-end justify-center gap-2" dir="ltr">
          <span id="charge-wallet-amount-display" class="text-5xl font-black tracking-tight text-slate-900 dark:text-white">${hubEsc(_chargeWallet.amountText || '0')}</span>
          <span class="mb-2 text-lg font-semibold text-slate-500">${currency}</span>
        </div>
        <label class="sr-only" for="charge-wallet-amount">${t('amount')}</label>
        <input id="charge-wallet-amount" type="text" inputmode="decimal" value="${hubEsc(_chargeWallet.amountText)}" oninput="chargeWalletAmountInput(this)" class="mt-3 mx-auto block w-40 glass-input rounded-xl px-4 py-2.5 text-center text-lg font-bold" placeholder="0" dir="ltr" />
        ${rateNote}
      </div>

      <div class="flex justify-center gap-2 mb-5">
        ${quick.map(q => `<button type="button" onclick="chargeWalletSetAmount(${q})" class="touch-target min-h-10 rounded-full px-5 text-[13px] font-bold ${String(_chargeWallet.amountText) === String(q) ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}">${q}</button>`).join('')}
      </div>

      <div class="hub-section-title">${hubText('Currency', 'العملة')}</div>
      <div class="grid grid-cols-2 gap-2 mb-5">
        ${['LYD', 'USD'].map(c => `<button type="button" onclick="chargeWalletSetCurrency('${c}')" class="touch-target min-h-11 rounded-xl text-sm font-bold ${currency === c ? 'bg-blue-600 text-white' : 'hub-card text-slate-700 dark:text-slate-200'}">${c === 'LYD' ? hubText('LYD · services', 'دينار · الخدمات') : hubText('USD · ads', 'دولار · الإعلانات')}</button>`).join('')}
      </div>

      <div class="hub-section-title">${hubText('Method', 'طريقة الدفع')}</div>
      ${methods.length ? `
        <div class="grid grid-cols-3 gap-2 mb-6">
          ${methods.map(m => {
            const picked = String(m.id) === _chargeWallet.method;
            const name = String((isRTL ? m.name?.ar : m.name?.en) || m.id || '');
            return `<button type="button" onclick="chargeWalletPickMethod('${hubEsc(m.id)}')" class="touch-target flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-2xl px-2 py-3 text-xs font-bold ${picked ? 'bg-blue-600 text-white shadow-md' : 'hub-card text-slate-700 dark:text-slate-200'}" aria-pressed="${picked}"><i data-lucide="${hubEsc(m.icon || methodIcons[String(m.id)] || 'wallet')}" class="w-5 h-5"></i><span class="text-center leading-tight">${hubEsc(name)}</span></button>`;
          }).join('')}
        </div>` : `
        <div class="hub-card p-4 mb-6 text-sm text-slate-500">
          ${_walletPayMethodsBusy || _walletPayMethods === null
            ? hubText('Loading payment methods…', 'جاري تحميل طرق الدفع…')
            : hubText('Payment methods did not load — check your connection and retry.', 'لم يتم تحميل طرق الدفع — تأكد من الاتصال ثم أعد المحاولة.')}
          ${_walletPayMethods !== null && !_walletPayMethodsBusy ? `<button type="button" onclick="_walletPayMethods = null; ensureWalletPayMethods();" class="touch-target ms-2 min-h-10 px-2 text-xs font-bold text-blue-600 underline">${hubText('Retry', 'إعادة المحاولة')}</button>` : ''}
        </div>`}

      <button type="button" onclick="chargeWalletCreateRequest()" ${_chargeWallet.busy || !methods.length ? 'disabled' : ''} class="touch-target w-full min-h-14 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-base font-bold btn-shine">
        ${_chargeWallet.busy ? hubText('Creating…', 'جاري الإنشاء…') : hubText('Create charge request', 'إنشاء طلب شحن')}
      </button>
      <p class="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">${hubText('You get a reference code; the wallet fills up the moment the payment is confirmed.', 'ستحصل على رمز مرجعي، وتتعبأ المحفظة فور تأكيد الدفع.')}</p>
    </div>
  `;
}

// ---------- Service placeholder ----------

function renderServicePlaceholder() {
  const serviceId = state.viewData?.serviceId || state.modalData?.serviceId || '';
  const service = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  const isRTL = state.language === 'ar';

  if (!service) {
    return `<div class="text-center py-12"><p class="text-slate-500">${isRTL ? 'الخدمة غير موجودة' : 'Service not found'}</p></div>`;
  }

  const serviceName = isRTL ? service.nameAr : service.name;
  const serviceDesc = isRTL ? service.descriptionAr : service.description;

  return `
    <div class="hub-shell">
      ${hubPageHeader(hubEsc(serviceName))}
      <div class="hub-card p-10 text-center">
        <div class="w-20 h-20 rounded-3xl bg-gradient-to-br ${service.color} flex items-center justify-center mx-auto mb-5 shadow-xl">
          <i data-lucide="${service.icon}" class="w-10 h-10 text-white"></i>
        </div>
        <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${hubEsc(serviceName)}</h2>
        <p class="text-slate-500 dark:text-slate-400 mb-6">${hubEsc(serviceDesc)}</p>
        ${service.comingSoon ? `
          <div class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-white font-bold shadow-lg">
            <i data-lucide="clock" class="w-5 h-5"></i>
            <span>${isRTL ? 'قريباً' : 'Coming Soon'}</span>
          </div>
        ` : `
          <p class="text-slate-600 dark:text-slate-300">${isRTL ? 'هذه الخدمة قيد الإنشاء' : 'This service is under construction'}</p>
        `}
      </div>
    </div>
  `;
}

async function cancelSubscriptionFromUi(serviceId, paidDaysLeft = 0, paidUntil = '') {
  try {
    if (!state.currentUser?.id) return;
    const sid = String(serviceId || '').trim();
    if (!sid) return;
    const isRTL = state.language === 'ar';
    // Cancelling ends EVERY paid period of this service immediately, and
    // there is no subscription refund. Say so before it happens — a customer
    // who renewed early would otherwise lose prepaid days to a one-word Yes.
    const days = Math.max(0, Math.trunc(Number(paidDaysLeft) || 0));
    const warning = days > 0
      ? (isRTL
        ? `سينتهي وصولك فوراً. أنت مدفوع حتى ${paidUntil} — ستفقد ${days} يوماً مدفوعاً ولا يوجد استرداد. هل أنت متأكد؟`
        : `Your access ends immediately. You are paid until ${paidUntil} — ${days} paid day(s) will be lost and there is no refund. Are you sure?`)
      : (isRTL ? 'هل تريد إلغاء الاشتراك؟' : 'Cancel this subscription?');
    const ok = confirm(warning);
    if (!ok) return;
    await SUBSCRIPTIONS.cancel(state.currentUser.id, sid);
    showNotification(isRTL ? 'نجاح' : 'Success', isRTL ? 'تم إلغاء الاشتراك' : 'Subscription canceled', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || (state.language === 'ar' ? 'فشل إلغاء الاشتراك' : 'Failed to cancel subscription'), 'error');
  }
}

// ---------- Wallet ----------

function renderWalletView() {
  const isRTL = state.language === 'ar';
  const uid = String(state.currentUser?.id || '');
  const isAdmin = isAdminRole(state.currentUser?.role);

  const balances = [];
  if (uid) {
    for (const c of WALLET_SUPPORTED_CURRENCIES) {
      const m = WALLET.getBalanceMinor(uid, c);
      if (m !== 0 || c === WALLET.currency) balances.push({ c, m });
    }
  }
  const balancesHtml = balances.length
    ? balances.map(({ c, m }) => `<div class="text-base font-black text-slate-800 dark:text-white" dir="ltr">${walletFormatMinor(m, c)}</div>`).join('')
    : `<div class="text-base font-black text-slate-800 dark:text-white" dir="ltr">${walletFormatMinor(0, WALLET.currency)}</div>`;
  const currencyOptions = WALLET_SUPPORTED_CURRENCIES
    .map(c => `<option value="${c}" ${c === WALLET.currency ? 'selected' : ''}>${c}</option>`)
    .join('');
  const users = Array.isArray(state.users) ? state.users : [];
  const userById = new Map();
  for (const u of users) {
    if (!u || u._deleted || !u.id) continue;
    userById.set(String(u.id), u);
  }

  const allTx = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  const visibleTx = getVisibleRecords(allTx);
  const txs = (isAdmin ? visibleTx : visibleTx.filter(t => t && (t.fromUserId === uid || t.toUserId === uid))).slice(0, 50);

  const allSubs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
  const now = Date.now();
  const activeSubs = getVisibleRecords(allSubs)
    .filter(s => s && s.userId === uid && s.status === 'active' && (!s.expiresAt || new Date(s.expiresAt).getTime() > now))
    .slice(0, 50);

  const txRows = txs.map(tx => {
    const isIn = tx.toUserId === uid;
    const otherId = isIn ? tx.fromUserId : tx.toUserId;
    const other =
      !otherId || otherId === 'system'
        ? (isRTL ? 'النظام' : 'System')
        : (userById.get(String(otherId))?.name || userById.get(String(otherId))?.email || String(otherId || ''));

    const amountStr = walletFormatMinor(walletTxAmountMinor(tx), walletTxCurrency(tx));
    const when = tx.createdAt ? new Date(tx.createdAt).toLocaleString(appDateLocale()) : '';
    const memo = Security.escapeHtml(String(tx.memo || ''));

    return `
      <div class="flex items-start justify-between gap-4 py-3 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="min-w-0">
          <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(tx.type || 'tx')}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${Security.escapeHtml(other)} ${when ? `• ${Security.escapeHtml(when)}` : ''}</div>
          ${memo ? `<div class="text-[11px] text-slate-400 mt-1 break-words">${memo}</div>` : ''}
        </div>
        <div class="text-end font-black ${isIn ? 'text-emerald-600' : 'text-rose-600'}" dir="ltr">
          ${isIn ? '+' : '-'}${Security.escapeHtml(amountStr)}
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">${isRTL ? 'لا توجد معاملات بعد' : 'No transactions yet'}</div>`;

  // Renewals APPEND rows, so one service can hold several prepaid periods.
  // Showing them as separate lines (each with its own Cancel) implied a
  // per-period control that does not exist — cancel always ends the whole
  // service. One truthful line per service: the LAST paid date.
  const subsByService = new Map();
  for (const s of activeSubs) {
    const sid = String(s.serviceId || '');
    const end = s.expiresAt ? new Date(s.expiresAt).getTime() : 0;
    const seen = subsByService.get(sid);
    if (!seen) subsByService.set(sid, { serviceId: sid, end, periods: 1 });
    else { seen.periods += 1; if (end > seen.end) seen.end = end; }
  }
  const subsRows = Array.from(subsByService.values()).map(row => {
    const svc = SERVICES[row.serviceId] || SMART_SYSTEMS_CHILDREN[row.serviceId];
    const name = svc ? (isRTL ? svc.nameAr : svc.name) : row.serviceId;
    const exp = row.end ? new Date(row.end).toLocaleDateString(appDateLocale()) : '';
    const daysLeft = row.end ? Math.max(0, Math.ceil((row.end - now) / TIME_CONSTANTS.MILLISECONDS_PER_DAY)) : 0;
    return `
      <div class="flex items-center justify-between gap-4 py-2 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="min-w-0">
          <div class="font-bold text-slate-800 dark:text-white truncate">${Security.escapeHtml(name)}</div>
          ${row.periods > 1 ? `<div class="text-[11px] text-emerald-600 dark:text-emerald-400 font-bold">${isRTL ? `${row.periods} فترات مدفوعة` : `${row.periods} paid periods`}</div>` : ''}
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">
            ${exp ? (isRTL ? `مدفوع حتى: ${Security.escapeHtml(exp)}` : `Paid until: ${Security.escapeHtml(exp)}`) : ''}
          </div>
          <button onclick="cancelSubscriptionFromUi('${Security.escapeHtml(row.serviceId)}', ${daysLeft}, '${Security.escapeHtml(exp)}')" class="touch-target min-h-10 text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-1.5 rounded-lg">
            ${isRTL ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">${isRTL ? 'لا توجد اشتراكات نشطة' : 'No active subscriptions'}</div>`;

  return `
    <div class="hub-shell hub-shell-wide">
      ${hubPageHeader(t('wallet'))}

      <div class="hub-card p-4 mb-5 flex flex-wrap items-center gap-4">
        <span class="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-md flex-shrink-0"><i data-lucide="wallet" class="w-6 h-6 text-white"></i></span>
        <div class="flex-1 min-w-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">${t('balance')}</div>
          <div class="space-y-0.5 mt-0.5">${balancesHtml}</div>
        </div>
        <div class="flex w-full sm:w-auto gap-2">
          ${isServerModeEnabled() ? `<button type="button" onclick="hubOpenChargeWallet()" class="touch-target flex-1 sm:flex-none min-h-11 rounded-xl bg-blue-600 hover:bg-blue-700 px-4 text-sm font-bold text-white btn-shine">${isRTL ? 'اشحن المحفظة' : 'Charge wallet'}</button>` : ''}
          <button type="button" onclick="navigateTo('plans')" class="touch-target flex-1 sm:flex-none min-h-11 rounded-xl bg-slate-100 dark:bg-slate-800 px-4 text-sm font-bold text-slate-700 dark:text-slate-200">${isRTL ? 'الباقات' : 'Plans & bundles'}</button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div class="hub-card p-6">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('transfer')}</h3>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
              <input id="wallet-transfer-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستلم أو المعرّف' : 'Recipient email or ID'}" maxlength="140" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                <input id="wallet-transfer-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                <select id="wallet-transfer-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                  ${currencyOptions}
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('note')}</label>
                <input id="wallet-transfer-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
              </div>
            </div>
            <button id="wallet-transfer-submit" onclick="walletTransferFromUi()" class="touch-target w-full min-h-12 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-50" type="button">
              <i data-lucide="send" class="w-4 h-4 inline me-2"></i>${t('send')}
            </button>
            <div class="text-[11px] text-slate-400">
              ${isRTL ? 'ملاحظة: في الوضع المحلي، هذا للعرض والتجربة فقط.' : 'Note: In local mode this is for testing/demo only.'}
            </div>
          </div>
        </div>

        ${isAdmin ? (isServerModeEnabled() ? `
          <div class="hub-card p-6">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-2">${t('topUp')}</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL
                ? 'في وضع السيرفر: شحن الرصيد يتم فقط عبر قنوات التمويل الخارجية (البنك/المعالج) وليس يدوياً. أنشئ طلب شحن من زر "اشحن المحفظة".'
                : 'In server mode: top-ups must come from external funding rails (bank/processor), not manual admin credits. Create a charge request with the "Charge wallet" button.'}
            </p>
          </div>
        ` : `
          <div class="hub-card p-6">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('topUp')} (${isRTL ? 'أدمن' : 'Admin'})</h3>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
                <input id="wallet-topup-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستخدم أو المعرّف' : 'User email or ID'}" maxlength="140" />
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                  <input id="wallet-topup-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                  <select id="wallet-topup-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                    ${currencyOptions}
                  </select>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${t('note')}</label>
                  <input id="wallet-topup-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
                </div>
              </div>
              <button id="wallet-topup-submit" onclick="walletTopUpFromUi()" class="touch-target w-full min-h-12 btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 disabled:opacity-50" type="button">
                <i data-lucide="plus" class="w-4 h-4 inline me-2"></i>${t('topUp')}
              </button>
            </div>
          </div>
        `) : `
          <div class="hub-card p-6">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${isRTL ? 'الاشتراكات' : 'Subscriptions'}</h3>
            ${subsRows}
            <button onclick="navigateTo('services-hub')" class="touch-target mt-4 w-full min-h-12 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إدارة الخدمات' : 'Manage services'}
            </button>
          </div>
        `}
      </div>

      <div class="hub-card p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white">${t('transactions')}</h3>
          <div class="text-xs text-slate-500 dark:text-slate-400">${isAdmin ? (isRTL ? 'آخر 50 (الكل)' : 'Latest 50 (all)') : (isRTL ? 'آخر 50 (لك فقط)' : 'Latest 50 (yours)')}</div>
        </div>
        ${txRows}
      </div>
    </div>
  `;
}

// ---------- Navigation handlers ----------

function handleServiceClick(serviceId) {
  const service = SERVICES[serviceId];
  if (!service) return;

  if (service.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذه الخدمة ستكون متاحة قريباً' : 'This service will be available soon',
      'info'
    );
    return;
  }

  const access = checkServiceAccess(serviceId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      showSubscriptionModal(serviceId, access.subscribeToId || serviceId);
      return;
    }
  }

  // Navigate to service
  const targetView = service.openView || (serviceId === 'smart_systems' ? 'smart-systems' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId } : null;

  saveState();
  render();
}

function handleSmartSystemClick(systemId) {
  const system = SMART_SYSTEMS_CHILDREN[systemId];
  if (!system) return;

  if (system.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذا النظام سيكون متاحاً قريباً' : 'This system will be available soon',
      'info'
    );
    return;
  }

  const access = checkServiceAccess(systemId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      // An expired Ads Studio customer whose campaigns still hold money must
      // reach the read-only view (and its Stop & refund button) — the view
      // shows the activate card itself. Everyone else sees the paywall.
      const moneyRecovery = systemId === 'ad_maker'
        && typeof adsStudioCanViewOwn === 'function' && adsStudioCanViewOwn()
        && typeof adsStudioHasRecoverableCampaigns === 'function' && adsStudioHasRecoverableCampaigns();
      if (!moneyRecovery) {
        showSubscriptionModal(systemId, access.subscribeToId || systemId);
        return;
      }
    }
  }

  // Navigate to system
  const targetView = system.openView || (systemId === 'albayan_manager' ? 'analytics' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId: systemId } : null;
  saveState();
  render();
}
