// ==========================================
// SERVICES HUB, SMART SYSTEMS AND WALLET SCREENS
// ==========================================
// Split out of 12-views.js when that module passed its 475 KiB cap.
// These screens form one product area: the service catalogue, its
// subscription state, and the wallet that pays for it.

function renderServicesHub() {
  const userName = state.currentUser?.name || 'User';
  const isRTL = state.language === 'ar';
  const walletBalanceMinor = state.currentUser?.id ? WALLET.getBalanceMinor(state.currentUser.id, WALLET.currency) : 0;
  const walletBalanceLabel = walletFormatMinor(walletBalanceMinor, WALLET.currency);

  const hubServices = Object.values(SERVICES)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const serviceCards = hubServices.map(service => {
    if (!service || !service.id) return '';

    const serviceName = isRTL ? service.nameAr : service.name;
    const serviceDesc = isRTL ? service.descriptionAr : service.description;
    const access = checkServiceAccess(service.id);
    const disabled = !!service.comingSoon;

    return `
      <button
        type="button"
        onclick="handleServiceClick('${service.id}')"
        class="group relative glass-panel p-6 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${disabled ? `
          <div class="absolute top-3 right-3 px-3 py-1 rounded-full text-[10px] font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}

        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-3 right-3">
            <i data-lucide="lock" class="w-4 h-4 text-amber-500"></i>
          </div>
        ` : ''}

        <div class="w-14 h-14 rounded-2xl bg-gradient-to-br ${service.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg">
          <i data-lucide="${service.icon}" class="w-7 h-7 text-white"></i>
        </div>

        <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">${serviceName}</h3>
        <p class="text-sm text-slate-500 dark:text-slate-400">${serviceDesc}</p>

        ${service.hasChildren ? `
          <div class="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold">
            <i data-lucide="layers" class="w-3.5 h-3.5"></i>
            <span>${(service.children?.length || 0)} ${isRTL ? 'أنظمة' : 'systems'}</span>
          </div>
        ` : ''}
        ${service.requiresSubscription && typeof renderSubscriptionStatusBadge === 'function' ? renderSubscriptionStatusBadge(service.id, isRTL) : ''}
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Header -->
      <div class="mb-8 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center text-white text-xl font-bold shadow-lg">
            ${userName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 class="text-2xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? `مرحبا، ${userName}!` : `Welcome, ${userName}!`}
            </h1>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL ? 'اختر خدمة للبدء' : 'Choose a service to get started'}
            </p>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <button onclick="navigateTo('wallet')" class="px-4 py-3 glass-panel rounded-xl hover:scale-105 transition-transform flex items-center gap-2">
            <i data-lucide="wallet" class="w-5 h-5 text-indigo-600"></i>
            <span class="text-sm font-bold text-slate-700 dark:text-slate-200">${walletBalanceLabel}</span>
          </button>
          <button onclick="toggleTheme()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform">
            <i data-lucide="sun" class="w-5 h-5"></i>
          </button>
          <button onclick="toggleLanguage()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-sm font-bold">
            ${isRTL ? 'EN' : 'عربي'}
          </button>
          <button onclick="handleLogout()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-rose-500">
            <i data-lucide="log-out" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
      
      <!-- Hero Banner (Optional) -->
      <div class="glass-panel p-8 rounded-3xl mb-8 alb-hero">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2 alb-gradient-text">
              ${isRTL ? 'فروع جديدة!' : 'New Services!'}
            </h2>
            <p class="text-slate-600 dark:text-slate-300">
              ${isRTL ? 'أهلاً بشركاء النجاح' : 'Welcome to our partner success platform'}
            </p>
          </div>
          <div class="hidden md:block">
            <i data-lucide="sparkles" class="w-16 h-16 text-indigo-400 opacity-50"></i>
          </div>
        </div>
      </div>
      
      <!-- Services Grid -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        ${serviceCards}
      </div>
    </div>
  `;
}

function renderSmartSystems() {
  const isRTL = state.language === 'ar';
  
  const children = Object.values(SMART_SYSTEMS_CHILDREN)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const childCards = children.map(child => {
    const childName = isRTL ? child.nameAr : child.name;
    const childDesc = isRTL ? child.descriptionAr : child.description;
    const access = checkServiceAccess(child.id);
    const disabled = child.comingSoon;
    
    return `
      <button 
        type="button"
        onclick="handleSmartSystemClick('${child.id}')"
        class="group relative glass-panel p-8 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-2xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${child.comingSoon ? `
          <div class="absolute top-4 right-4 px-3 py-1 rounded-full text-xs font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}
        
        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-4 right-4">
            <i data-lucide="lock" class="w-5 h-5 text-amber-500"></i>
          </div>
        ` : ''}
        
        <div class="w-20 h-20 rounded-3xl bg-gradient-to-br ${child.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform shadow-2xl">
          <i data-lucide="${child.icon}" class="w-10 h-10 text-white"></i>
        </div>
        
        <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${childName}</h3>
        <p class="text-slate-500 dark:text-slate-400">${childDesc}</p>
        ${child.requiresSubscription && typeof renderSubscriptionStatusBadge === 'function' ? renderSubscriptionStatusBadge(child.id, isRTL) : ''}
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Header -->
      <div class="mb-8">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-2xl">
            <i data-lucide="cpu" class="w-8 h-8 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? 'الأنظمة الذكية' : 'Smart Systems'}
            </h1>
            <p class="text-slate-500 dark:text-slate-400">
              ${isRTL ? 'أدوات الأعمال المتقدمة' : 'Advanced business tools'}
            </p>
          </div>
        </div>
      </div>
      
      <!-- Systems Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${childCards}
      </div>
    </div>
  `;
}

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
    <div class="max-w-4xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Placeholder Content -->
      <div class="glass-panel p-12 rounded-3xl text-center">
        <div class="w-24 h-24 rounded-3xl bg-gradient-to-br ${service.color} flex items-center justify-center mx-auto mb-6 shadow-2xl">
          <i data-lucide="${service.icon}" class="w-12 h-12 text-white"></i>
        </div>
        
        <h1 class="text-3xl font-bold text-slate-800 dark:text-white mb-3">${serviceName}</h1>
        <p class="text-lg text-slate-500 dark:text-slate-400 mb-8">${serviceDesc}</p>
        
        ${service.comingSoon ? `
          <div class="inline-flex items-center space-x-3 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-white font-bold shadow-lg">
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
    ? balances.map(({ c, m }) => `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(m, c)}</div>`).join('')
    : `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(0, WALLET.currency)}</div>`;
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
        <div class="text-right font-black ${isIn ? 'text-emerald-600' : 'text-rose-600'}">
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
          <button onclick="cancelSubscriptionFromUi('${Security.escapeHtml(row.serviceId)}', ${daysLeft}, '${Security.escapeHtml(exp)}')" class="text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-1.5 rounded-lg">
            ${isRTL ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">${isRTL ? 'لا توجد اشتراكات نشطة' : 'No active subscriptions'}</div>`;

  return `
    <div class="max-w-6xl mx-auto">
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>

      <div class="mb-8 flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-xl">
            <i data-lucide="wallet" class="w-7 h-7 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('wallet')}</h1>
            <p class="text-slate-500 dark:text-slate-400">${isRTL ? 'محفظتك واشتراكاتك' : 'Your balance and subscriptions'}</p>
          </div>
        </div>
        <div class="glass-panel px-5 py-3 rounded-2xl">
          <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">${t('balance')}</div>
          <div class="space-y-1 mt-1">${balancesHtml}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div class="glass-panel p-6 rounded-2xl">
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
            <button id="wallet-transfer-submit" onclick="walletTransferFromUi()" class="w-full btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-50" type="button">
              <i data-lucide="send" class="w-4 h-4 inline mr-2"></i>${t('send')}
            </button>
            <div class="text-[11px] text-slate-400">
              ${isRTL ? 'ملاحظة: في الوضع المحلي، هذا للعرض والتجربة فقط.' : 'Note: In local mode this is for testing/demo only.'}
            </div>
          </div>
        </div>

        ${isAdmin ? (isServerModeEnabled() ? `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-2">${t('topUp')}</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL
                ? 'في وضع السيرفر: شحن الرصيد يتم فقط عبر قنوات التمويل الخارجية (البنك/المعالج) وليس يدوياً.'
                : 'In server mode: top-ups must come from external funding rails (bank/processor), not manual admin credits.'}
            </p>
          </div>
        ` : `
          <div class="glass-panel p-6 rounded-2xl">
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
              <button id="wallet-topup-submit" onclick="walletTopUpFromUi()" class="w-full btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 disabled:opacity-50" type="button">
                <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>${t('topUp')}
              </button>
            </div>
          </div>
        `) : `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${isRTL ? 'الاشتراكات' : 'Subscriptions'}</h3>
            ${subsRows}
            <button onclick="navigateTo('services-hub')" class="mt-4 w-full bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إدارة الخدمات' : 'Manage services'}
            </button>
          </div>
        `}
      </div>

      <div class="glass-panel p-6 rounded-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white">${t('transactions')}</h3>
          <div class="text-xs text-slate-500 dark:text-slate-400">${isAdmin ? (isRTL ? 'آخر 50 (الكل)' : 'Latest 50 (all)') : (isRTL ? 'آخر 50 (لك فقط)' : 'Latest 50 (yours)')}</div>
        </div>
        ${txRows}
      </div>
    </div>
  `;
}

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
