// ==========================================
// META ADS — SECURE READ-ONLY SYNCHRONIZATION
// ==========================================
// Albayan remains the source of truth for customers, receipts, payments,
// exchange rates, photos and notes. Meta facts live only in server-controlled
// meta* fields and are displayed beside (never over) Albayan's own values.

const metaAdsUi = {
  targetAdId: '',
  status: null,
  accounts: [],
  ads: [],
  selectedAccountId: '',
  search: '',
  loading: false,
  loadingAds: false,
  busyAction: '',
  error: '',
  pendingOperations: new Map()
};
let metaAdsViewportResizeHandler = null;

function metaAdsIsArabic() {
  return state.language === 'ar';
}

function metaAdsFindLocalAd(adId) {
  return (state.ads || []).find(ad => ad && !ad._deleted && String(ad.id) === String(adId || '')) || null;
}

function metaAdsFormatMoney(minor, currency) {
  const amount = Math.max(0, Number(minor) || 0) / 100;
  const code = String(currency || 'USD').toUpperCase().slice(0, 12);
  try {
    return new Intl.NumberFormat(metaAdsIsArabic() ? 'ar-LY' : 'en-US', {
      style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(amount);
  } catch (_) {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function metaAdsFormatDate(value, withTime = false) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(appDateLocale(), withTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' });
  } catch (_) {
    return date.toLocaleDateString(appDateLocale());
  }
}

function metaAdsStatusTone(value) {
  const status = String(value || '').toUpperCase();
  if (['ACTIVE'].includes(status)) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(status)) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  if (['DISAPPROVED', 'WITH_ISSUES', 'ERROR'].includes(status)) return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300';
  return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
}

function renderMetaAdsHeaderButton(isAr) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) return '';
  return `<button type="button" onclick="openMetaAdsConnectionModal()" class="btn-shine inline-flex min-h-11 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 font-bold text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200" title="${isAr ? 'اتصال آمن للقراءة فقط مع إعلانات Meta' : 'Secure read-only Meta Ads connection'}"><i data-lucide="facebook" class="h-4 w-4"></i><span>${isAr ? 'ربط Meta' : 'Meta Sync'}</span></button>`;
}

function renderMetaAdStatusSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const liveStatus = String(ad.metaEffectiveStatus || ad.metaConfiguredStatus || 'UNKNOWN');
  const synced = metaAdsFormatDate(ad.metaSyncedAt, true);
  const error = String(ad.metaSyncError || '');
  return `<div data-role="meta-ad-status" class="mt-2 max-w-[15rem] rounded-lg border border-blue-100 bg-blue-50/70 p-2 text-[10px] leading-4 dark:border-blue-900 dark:bg-blue-950/30">
    <div class="flex flex-wrap items-center gap-1"><span class="font-bold text-blue-700 dark:text-blue-300">Meta</span><span class="rounded-full px-1.5 py-0.5 font-bold ${metaAdsStatusTone(liveStatus)}">${Security.escapeHtml(liveStatus)}</span></div>
    ${ad.metaAdName ? `<div class="mt-1 truncate font-medium text-slate-700 dark:text-slate-200" title="${Security.escapeHtml(ad.metaAdName)}">${Security.escapeHtml(ad.metaAdName)}</div>` : ''}
    ${synced ? `<div class="text-slate-500">${isAr ? 'آخر مزامنة' : 'Last sync'}: ${Security.escapeHtml(synced)}</div>` : ''}
    ${error ? `<div class="mt-1 text-rose-600 dark:text-rose-300" title="${Security.escapeHtml(error)}">${Security.escapeHtml(error)}</div>` : ''}
  </div>`;
}

function renderMetaAdBudgetSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const currency = ad.metaCurrency || 'USD';
  const daily = Number(ad.metaDailyBudgetMinor) || 0;
  const lifetime = Number(ad.metaLifetimeBudgetMinor) || 0;
  const budget = lifetime || daily;
  const budgetLabel = lifetime ? (isAr ? 'ميزانية Meta الكلية' : 'Meta lifetime') : (isAr ? 'ميزانية Meta اليومية' : 'Meta daily');
  return `<div data-role="meta-ad-budget" class="mt-1 text-[10px] font-medium text-blue-600 dark:text-blue-300">
    ${budget ? `<div>${budgetLabel}: ${Security.escapeHtml(metaAdsFormatMoney(budget, currency))}</div>` : ''}
    <div>${isAr ? 'مصروف Meta' : 'Meta spent'}: ${Security.escapeHtml(metaAdsFormatMoney(ad.metaSpendMinor, currency))}</div>
  </div>`;
}

function renderMetaAdScheduleSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const start = metaAdsFormatDate(ad.metaStartTime);
  const end = metaAdsFormatDate(ad.metaEndTime);
  if (!start && !end) return '';
  return `<div data-role="meta-ad-schedule" class="mt-2 border-t border-blue-100 pt-1 text-[10px] text-blue-600 dark:border-blue-900 dark:text-blue-300">
    <div class="font-bold">Meta</div>
    ${start ? `<div>${isAr ? 'بدء' : 'Start'}: ${Security.escapeHtml(start)}</div>` : ''}
    ${end ? `<div>${isAr ? 'انتهاء' : 'End'}: ${Security.escapeHtml(end)}</div>` : ''}
  </div>`;
}

function renderMetaAdActionButton(ad, isAr) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled() || !ad) return '';
  const linked = !!ad.metaAdId;
  return `<button type="button" data-action="meta-ad-link" data-ad-id="${Security.escapeHtml(String(ad.id || ''))}" onclick="openMetaAdsConnectionModal(this.dataset.adId)" class="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold ${linked ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200' : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300'}" title="${linked ? (isAr ? 'عرض ومزامنة رابط Meta' : 'View and sync Meta link') : (isAr ? 'ربط هذا الإعلان بإعلان Meta' : 'Link this ad to Meta')}"><i data-lucide="${linked ? 'refresh-cw' : 'link'}" class="h-4 w-4"></i><span>${linked ? 'Meta' : (isAr ? 'ربط' : 'Link')}</span></button>`;
}

function metaAdsErrorMessage(error) {
  const raw = String(error?.message || error?.detail || '').trim();
  return raw || (metaAdsIsArabic() ? 'تعذّر الاتصال بـ Meta. حاول مرة أخرى.' : 'Could not connect to Meta. Please try again.');
}

function metaAdsOperationId(action, adId, value = '') {
  const key = `${action}:${adId}:${value}`;
  if (!metaAdsUi.pendingOperations.has(key)) {
    metaAdsUi.pendingOperations.set(key, Security.generateSecureId(`meta_${action}`));
  }
  return { key, value: metaAdsUi.pendingOperations.get(key) };
}

function metaAdsFinishOperation(key) {
  metaAdsUi.pendingOperations.delete(key);
}

function closeMetaAdsConnectionModal() {
  document.getElementById('meta-ads-modal')?.remove();
  if (metaAdsViewportResizeHandler) {
    window.removeEventListener('resize', metaAdsViewportResizeHandler);
    window.visualViewport?.removeEventListener('resize', metaAdsViewportResizeHandler);
    metaAdsViewportResizeHandler = null;
  }
  metaAdsUi.busyAction = '';
}

function metaAdsInteractiveHeight() {
  const values = [Number(window.innerHeight), Number(window.visualViewport?.height)].filter(value => Number.isFinite(value) && value > 0);
  return Math.max(240, Math.floor(values.length ? Math.min(...values) : 640));
}

function metaAdsFitModalToViewport() {
  const panel = document.querySelector('#meta-ads-modal > div');
  // Reserve room for mobile browser chrome that can appear without firing a
  // reliable resize event (observed in iOS Safari when its bottom bar settles).
  if (panel) {
    // The shared phone-dialog stylesheet normally lets the entire overlay
    // scroll. This connection manager keeps its close button in view and uses
    // its own scroll area, so these two scoped rules intentionally win.
    panel.style.setProperty('max-height', `${metaAdsInteractiveHeight() - 48}px`, 'important');
    panel.style.setProperty('overflow-y', 'auto', 'important');
  }
}

function openMetaAdsConnectionModal(adId = '') {
  const isAr = metaAdsIsArabic();
  if (!isCurrentUserAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access denied', isAr ? 'ربط Meta متاح للمدير فقط.' : 'Only an administrator can link Meta ads.', 'error');
    return;
  }
  if (!isServerModeEnabled()) {
    showNotification(isAr ? 'يتطلب السيرفر' : 'Server required', isAr ? 'مزامنة Meta تعمل فقط مع السيرفر المباشر.' : 'Meta synchronization only works with the live server.', 'warning');
    return;
  }
  const target = adId ? metaAdsFindLocalAd(adId) : null;
  if (adId && !target) {
    showNotification(isAr ? 'غير موجود' : 'Not found', isAr ? 'لم يتم العثور على الإعلان.' : 'The Albayan ad was not found.', 'error');
    return;
  }
  metaAdsUi.targetAdId = target ? String(target.id) : '';
  metaAdsUi.status = null;
  metaAdsUi.accounts = [];
  metaAdsUi.ads = [];
  metaAdsUi.selectedAccountId = target?.metaAdAccountId || '';
  metaAdsUi.search = '';
  metaAdsUi.error = '';
  metaAdsUi.loading = true;
  metaAdsUi.loadingAds = false;
  metaAdsUi.busyAction = '';
  metaAdsRenderModal();
  metaAdsLoadConnection();
}

function metaAdsRenderModal() {
  const isAr = metaAdsIsArabic();
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  let modal = document.getElementById('meta-ads-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'meta-ads-modal';
    modal.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center overflow-hidden bg-slate-900/60 p-2 backdrop-blur-sm sm:items-center sm:p-4';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.onclick = event => { if (event.target === modal) closeMetaAdsConnectionModal(); };
    document.body.appendChild(modal);
    metaAdsViewportResizeHandler = () => metaAdsFitModalToViewport();
    window.addEventListener('resize', metaAdsViewportResizeHandler, { passive: true });
    window.visualViewport?.addEventListener('resize', metaAdsViewportResizeHandler, { passive: true });
  }
  const status = metaAdsUi.status;
  const configured = status?.configured === true;
  // iOS Safari's CSS vh/dvh can describe the layout viewport while the address
  // bar leaves a shorter interactive viewport. A measured pixel cap keeps the
  // close button and the panel's own scrollbar inside what the user can touch.
  const interactiveHeight = metaAdsInteractiveHeight();
  const currentName = target ? (target.metaAdName || `Meta #${target.metaAdId || ''}`) : '';
  const accountsOptions = metaAdsUi.accounts.map(account => `<option value="${Security.escapeHtml(String(account.id || ''))}" ${String(account.id) === String(metaAdsUi.selectedAccountId) ? 'selected' : ''}>${Security.escapeHtml(account.name || `Ad account ${account.id}`)} (${Security.escapeHtml(account.currency || '')})</option>`).join('');
  const adsRows = metaAdsUi.ads.map(metaAd => {
    const alreadySelected = target && String(target.metaAdId || '') === String(metaAd.id || '');
    return `<button type="button" data-meta-ad-id="${Security.escapeHtml(String(metaAd.id || ''))}" onclick="metaAdsLinkSelected(this.dataset.metaAdId)" ${!target || metaAdsUi.busyAction ? 'disabled' : ''} class="w-full rounded-xl border p-3 text-start transition-colors ${alreadySelected ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:hover:border-blue-700 dark:hover:bg-blue-950/30'} disabled:cursor-not-allowed disabled:opacity-60">
      <div class="flex items-start justify-between gap-2"><span class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(metaAd.name || `Meta ad ${metaAd.id}`)}</span><span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${metaAdsStatusTone(metaAd.effectiveStatus || metaAd.status)}">${Security.escapeHtml(metaAd.effectiveStatus || metaAd.status || 'UNKNOWN')}</span></div>
      <div class="mt-1 text-xs text-slate-500">#${Security.escapeHtml(String(metaAd.id || ''))}${metaAd.campaignName ? ` · ${Security.escapeHtml(metaAd.campaignName)}` : ''}</div>
      ${alreadySelected ? `<div class="mt-1 text-xs font-bold text-emerald-600">${isAr ? 'مرتبط حالياً' : 'Currently linked'}</div>` : ''}
    </button>`;
  }).join('');

  modal.innerHTML = `<div class="meta-ads-dialog-panel glass-panel w-full max-w-3xl overflow-y-auto rounded-2xl p-4 shadow-2xl custom-scrollbar sm:p-6" style="max-height:${interactiveHeight - 48}px" dir="${isAr ? 'rtl' : 'ltr'}" onclick="event.stopPropagation()">
    <div class="flex items-start justify-between gap-3">
      <div><h2 class="flex items-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i data-lucide="facebook" class="h-6 w-6 text-blue-600"></i>${isAr ? 'مزامنة إعلانات Meta' : 'Meta Ads Sync'}</h2><p class="mt-1 text-sm text-slate-500">${isAr ? 'قراءة فقط — معلومات Albayan المالية والصور لا تتغير.' : 'Read-only — Albayan accounting and photos are never changed.'}</p></div>
      <button type="button" onclick="closeMetaAdsConnectionModal()" class="touch-target rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>

    ${metaAdsUi.loading ? `<div class="mt-6 flex items-center justify-center gap-2 rounded-xl bg-slate-50 p-8 text-slate-500 dark:bg-slate-800/50"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'فحص الاتصال الآمن...' : 'Checking the secure connection...'}</div>` : ''}
    ${metaAdsUi.error ? `<div role="alert" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200">${Security.escapeHtml(metaAdsUi.error)}</div>` : ''}

    ${!metaAdsUi.loading && status ? `<div class="mt-4 grid gap-3 sm:grid-cols-3">
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div class="text-xs text-slate-500">${isAr ? 'الاتصال' : 'Connection'}</div><div class="mt-1 font-bold ${configured ? 'text-emerald-600' : 'text-amber-600'}">${configured ? (isAr ? 'جاهز' : 'Ready') : (isAr ? 'يحتاج إعداد' : 'Setup needed')}</div></div>
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div class="text-xs text-slate-500">Meta Graph API</div><div class="mt-1 font-bold">${Security.escapeHtml(status.graphApiVersion || '—')}</div></div>
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div class="text-xs text-slate-500">${isAr ? 'المزامنة التلقائية' : 'Automatic sync'}</div><div class="mt-1 font-bold">${status.backgroundSync ? `${Number(status.syncIntervalMinutes) || 15} ${isAr ? 'دقيقة' : 'minutes'}` : (isAr ? 'متوقفة' : 'Off')}</div></div>
    </div>` : ''}

    ${!metaAdsUi.loading && status && !configured ? `<div class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"><div class="font-black">${isAr ? 'أضف هذه المتغيرات في Jelastic ثم أعد تشغيل الحاوية:' : 'Add these environment variables in Jelastic, then restart the container:'}</div><code class="mt-2 block select-all whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-emerald-300" dir="ltr">ALBAYAN_META_ACCESS_TOKEN=your_token\nALBAYAN_META_APP_SECRET=your_app_secret\nALBAYAN_META_AD_ACCOUNT_IDS=123456789</code><p class="mt-2">${isAr ? 'لا تكتب رمز الدخول في Albayan أو في المحادثة. ضعه فقط داخل إعدادات Jelastic.' : 'Never type the access token into Albayan or chat. Put it only in Jelastic settings.'}</p></div>` : ''}

    ${target ? `<div class="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-800 dark:bg-indigo-950/20"><div class="text-xs font-bold text-indigo-600">${isAr ? 'إعلان Albayan المحدد' : 'Selected Albayan ad'}</div><div class="mt-1 font-black text-slate-800 dark:text-white">#${Security.escapeHtml(String(target.id))} · ${Security.escapeHtml(target.customerName || target.pageName || (isAr ? 'إعلان' : 'Ad'))}</div>${target.metaAdId ? `<div class="mt-2 text-sm text-slate-600 dark:text-slate-300">${isAr ? 'مرتبط بـ' : 'Linked to'}: <strong>${Security.escapeHtml(currentName)}</strong> (#${Security.escapeHtml(String(target.metaAdId))})</div><div class="mt-3 flex flex-wrap gap-2"><button type="button" onclick="metaAdsSyncCurrent()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-60"><i data-lucide="refresh-cw" class="h-4 w-4 ${metaAdsUi.busyAction === 'sync' ? 'animate-spin' : ''}"></i>${isAr ? 'مزامنة الآن' : 'Sync now'}</button><button type="button" onclick="metaAdsUnlinkCurrent()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-200 px-4 py-2 font-bold text-rose-600 disabled:opacity-60"><i data-lucide="unlink" class="h-4 w-4"></i>${isAr ? 'إلغاء الربط' : 'Unlink'}</button></div>` : `<div class="mt-2 text-sm text-slate-500">${isAr ? 'غير مرتبط حتى الآن.' : 'Not linked yet.'}</div>`}</div>` : `<div class="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">${isAr ? 'لفتح الربط: أغلق هذه النافذة واضغط زر «ربط» الصغير بجانب إعلان Albayan.' : 'To link an ad: close this window and press the small Link button beside an Albayan ad.'}</div>`}

    ${configured && target ? `<div class="mt-5 space-y-3"><h3 class="font-black text-slate-800 dark:text-white">${target.metaAdId ? (isAr ? 'تغيير إعلان Meta المرتبط' : 'Change linked Meta ad') : (isAr ? 'اختر إعلان Meta' : 'Choose a Meta ad')}</h3>
      <div class="grid gap-2 sm:grid-cols-[1fr_auto]"><select id="meta-account-select" onchange="metaAdsSelectAccount(this.value)" class="glass-input min-h-11 w-full rounded-xl px-3"><option value="">${isAr ? 'اختر حساب الإعلانات...' : 'Choose an ad account...'}</option>${accountsOptions}</select><button type="button" onclick="metaAdsReloadAccounts()" class="min-h-11 rounded-xl border border-slate-200 px-3 font-bold dark:border-slate-700"><i data-lucide="refresh-cw" class="mx-auto h-4 w-4"></i></button></div>
      ${metaAdsUi.selectedAccountId ? `<div class="grid gap-2 sm:grid-cols-[1fr_auto]"><input id="meta-ads-search" type="search" value="${Security.escapeHtml(metaAdsUi.search)}" onkeydown="if(event.key==='Enter'){event.preventDefault();metaAdsSearch(this.value)}" placeholder="${isAr ? 'ابحث بالاسم أو رقم الإعلان...' : 'Search name or ad ID...'}" class="glass-input min-h-11 w-full rounded-xl px-3"><button type="button" onclick="metaAdsSearch(document.getElementById('meta-ads-search').value)" class="min-h-11 rounded-xl bg-slate-800 px-4 font-bold text-white dark:bg-slate-600">${isAr ? 'بحث' : 'Search'}</button></div>` : ''}
      ${metaAdsUi.loadingAds ? `<div class="flex items-center justify-center gap-2 p-6 text-slate-500"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'تحميل إعلانات Meta...' : 'Loading Meta ads...'}</div>` : ''}
      ${!metaAdsUi.loadingAds && metaAdsUi.selectedAccountId ? `<div class="max-h-72 space-y-2 overflow-y-auto pr-1 custom-scrollbar">${adsRows || `<div class="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500 dark:bg-slate-800/50">${isAr ? 'لم يتم العثور على إعلانات.' : 'No Meta ads found.'}</div>`}</div>` : ''}
      <div class="rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700"><label for="meta-direct-ad-id" class="block text-xs font-bold text-slate-500">${isAr ? 'أو الصق رقم إعلان Meta مباشرة' : 'Or paste the numeric Meta ad ID'}</label><div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]"><input id="meta-direct-ad-id" inputmode="numeric" pattern="[0-9]*" placeholder="123456789012345" class="glass-input min-h-11 w-full rounded-xl px-3" dir="ltr"><button type="button" onclick="metaAdsLinkDirect()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="min-h-11 rounded-xl bg-blue-600 px-4 font-bold text-white disabled:opacity-60">${isAr ? 'ربط' : 'Link'}</button></div></div>
    </div>` : ''}

    ${configured && !metaAdsUi.loading ? `<div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><p class="text-xs text-slate-500">${isAr ? 'المزامنة التلقائية تعمل في السيرفر حتى عندما تغلق هذه الصفحة.' : 'Automatic sync runs on the server even when this page is closed.'}</p><button type="button" onclick="metaAdsSyncAllDue()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="min-h-11 rounded-xl border border-blue-200 px-3 text-sm font-bold text-blue-700 disabled:opacity-60 dark:border-blue-800 dark:text-blue-200">${isAr ? 'مزامنة المستحق الآن' : 'Sync due now'}</button></div>` : ''}
  </div>`;
  metaAdsFitModalToViewport();
  window.requestAnimationFrame(() => metaAdsFitModalToViewport());
  IconQueue.schedule(modal);
}

async function metaAdsLoadConnection() {
  try {
    metaAdsUi.status = await apiMetaAdsStatus();
    metaAdsUi.loading = false;
    metaAdsUi.error = '';
    metaAdsRenderModal();
    if (metaAdsUi.status?.configured) await metaAdsReloadAccounts();
  } catch (error) {
    metaAdsUi.loading = false;
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsRenderModal();
  }
}

async function metaAdsReloadAccounts() {
  metaAdsUi.loadingAds = true;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    metaAdsUi.accounts = await apiMetaAdsAccounts();
    if (!metaAdsUi.selectedAccountId && metaAdsUi.accounts.length === 1) metaAdsUi.selectedAccountId = String(metaAdsUi.accounts[0].id || '');
    if (metaAdsUi.selectedAccountId && !metaAdsUi.accounts.some(a => String(a.id) === String(metaAdsUi.selectedAccountId))) metaAdsUi.selectedAccountId = '';
    metaAdsUi.loadingAds = false;
    metaAdsRenderModal();
    if (metaAdsUi.selectedAccountId) await metaAdsLoadAds();
  } catch (error) {
    metaAdsUi.loadingAds = false;
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsRenderModal();
  }
}

async function metaAdsSelectAccount(accountId) {
  metaAdsUi.selectedAccountId = String(accountId || '');
  metaAdsUi.search = '';
  metaAdsUi.ads = [];
  metaAdsRenderModal();
  if (metaAdsUi.selectedAccountId) await metaAdsLoadAds();
}

async function metaAdsSearch(value) {
  metaAdsUi.search = String(value || '').slice(0, 100);
  await metaAdsLoadAds();
}

async function metaAdsLoadAds() {
  if (!metaAdsUi.selectedAccountId) return;
  metaAdsUi.loadingAds = true;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    metaAdsUi.ads = await apiMetaAdsForAccount(metaAdsUi.selectedAccountId, metaAdsUi.search);
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsUi.ads = [];
  } finally {
    metaAdsUi.loadingAds = false;
    metaAdsRenderModal();
  }
}

async function metaAdsRefreshAfterConflict(adId) {
  try {
    const latest = await apiGetEntity('ads', adId);
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: latest }], 'metaConflictRefresh');
  } catch (_) {}
}

async function metaAdsRunMutation(action, metaAdId = '') {
  const isAr = metaAdsIsArabic();
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  if (!target || metaAdsUi.busyAction) return;
  const expected = Number(target._lastModified);
  if (!Number.isFinite(expected)) {
    showNotification(isAr ? 'حدّث الصفحة' : 'Refresh needed', isAr ? 'حدّث البيانات ثم حاول مرة أخرى.' : 'Refresh the data and try again.', 'warning');
    return;
  }
  const operation = metaAdsOperationId(action, target.id, metaAdId);
  metaAdsUi.busyAction = action;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    let response;
    if (action === 'link') response = await apiLinkMetaAd(target.id, metaAdId, expected, operation.value);
    else if (action === 'sync') response = await apiSyncMetaAd(target.id, expected, operation.value);
    else response = await apiUnlinkMetaAd(target.id, expected, operation.value);
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: response.ad }], `meta${action}`);
    metaAdsFinishOperation(operation.key);
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
    showNotification(isAr ? 'تم بنجاح' : 'Success', action === 'unlink'
      ? (isAr ? 'تم إلغاء ربط إعلان Meta.' : 'The Meta ad was unlinked.')
      : (isAr ? 'تم تحديث معلومات Meta بدون تغيير الحسابات.' : 'Meta information updated without changing accounting.'), 'success');
  } catch (error) {
    metaAdsUi.busyAction = '';
    if (Number(error?.status) === 409 || String(error?.message || '').toLowerCase().includes('conflict')) {
      await metaAdsRefreshAfterConflict(target.id);
      metaAdsUi.error = isAr ? 'تغيّر الإعلان أثناء العمل. تم تحميل النسخة الجديدة؛ راجعها وحاول مرة أخرى.' : 'The ad changed while you were working. The latest version was loaded; review it and try again.';
    } else {
      metaAdsUi.error = metaAdsErrorMessage(error);
    }
    metaAdsRenderModal();
  }
}

function metaAdsLinkSelected(metaAdId) {
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  if (!target) return;
  const isChanging = target.metaAdId && String(target.metaAdId) !== String(metaAdId);
  if (isChanging && !confirm(metaAdsIsArabic() ? 'هل تريد تغيير إعلان Meta المرتبط؟ لن تتغير الأموال أو الوصل أو الصور.' : 'Change the linked Meta ad? Money, receipts and photos will not change.')) return;
  metaAdsRunMutation('link', String(metaAdId || ''));
}

function metaAdsLinkDirect() {
  const value = String(document.getElementById('meta-direct-ad-id')?.value || '').trim();
  if (!/^[0-9]{1,40}$/.test(value)) {
    showNotification(metaAdsIsArabic() ? 'رقم غير صحيح' : 'Invalid ID', metaAdsIsArabic() ? 'الصق رقم إعلان Meta فقط.' : 'Paste the numeric Meta ad ID only.', 'warning');
    return;
  }
  metaAdsLinkSelected(value);
}

function metaAdsSyncCurrent() {
  metaAdsRunMutation('sync');
}

function metaAdsUnlinkCurrent() {
  if (!confirm(metaAdsIsArabic() ? 'إلغاء الربط؟ ستبقى كل أموال ووصل وصور Albayan كما هي.' : 'Unlink Meta? All Albayan money, receipts and photos will remain unchanged.')) return;
  metaAdsRunMutation('unlink');
}

async function metaAdsSyncAllDue() {
  if (metaAdsUi.busyAction) return;
  const isAr = metaAdsIsArabic();
  metaAdsUi.busyAction = 'all';
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    const entities = await apiSyncDueMetaAds(20);
    if (entities.length) applyValidatedServerEntityBatch(entities.map(entity => ({ collection: 'ads', entity })), 'metaSyncDue');
    showNotification(isAr ? 'اكتملت المزامنة' : 'Sync complete', isAr ? `تم فحص وتحديث ${entities.length} إعلان.` : `Checked and updated ${entities.length} ad(s).`, 'success');
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
  } finally {
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
  }
}
