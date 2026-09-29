// ==========================================
// META TOOLS (lazy meta-tools.js) — META SYNC & META INSIGHTS DIALOGS
// ==========================================
// Loaded on demand by src/15d1-meta-tools-loader.js; the ad-row renderers,
// the shared metaAdsUi / metaInsightsUi state and both dialog closers stay in
// the startup bundle (src/15d0-meta-ads-core.js). The startup openers
// openMetaInsightsModal() / openMetaAdsConnectionModal() load this bundle,
// then call the *Now functions below.

const META_INSIGHTS_CLIENT_CACHE_MS = 5 * 60 * 1000;

function openMetaInsightsModalNow() {
  const isAr = metaAdsIsArabic();
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access denied', isAr ? 'مؤشرات Meta متاحة للمدير فقط.' : 'Meta insights are available to administrators only.', 'error');
    return;
  }
  metaInsightsUi.open = true;
  metaInsightsUi.error = '';
  metaInsightsRenderModal();
  metaInsightsUi.fundsError = '';
  const fundsTtl = (metaInsightsUi.funds?.accounts || []).some(a => a && (a.error || a.stale)) ? 30000 : META_INSIGHTS_CLIENT_CACHE_MS;
  if (!metaInsightsUi.funds || Date.now() - metaInsightsUi.fundsAtMs >= fundsTtl) metaInsightsLoadFunds(false);
  // The server already caches the statistics; do not spend a request (or the
  // rate budget) when this browser fetched them moments ago.
  if (metaInsightsUi.stats && Date.now() - metaInsightsUi.loadedAtMs < META_INSIGHTS_CLIENT_CACHE_MS) return;
  metaInsightsLoad(false);
}

async function metaInsightsLoad(refresh) {
  // Single flight: one request at a time, and a response that was overtaken
  // by a newer request (e.g. Refresh clicked during a slow load) is dropped.
  if (metaInsightsUi.loading || metaInsightsUi.refreshing) return;
  const seq = ++metaInsightsUi.requestSeq;
  if (refresh || metaInsightsUi.stats) metaInsightsUi.refreshing = true;
  else metaInsightsUi.loading = true;
  metaInsightsUi.error = '';
  metaInsightsRenderModal();
  try {
    const stats = await apiMetaPartnerPages(refresh === true);
    if (seq !== metaInsightsUi.requestSeq) return;
    metaInsightsUi.stats = stats;
    metaInsightsUi.loadedAtMs = Date.now();
  } catch (error) {
    if (seq === metaInsightsUi.requestSeq) metaInsightsUi.error = metaAdsErrorMessage(error);
  } finally {
    if (seq === metaInsightsUi.requestSeq) {
      metaInsightsUi.loading = false;
      metaInsightsUi.refreshing = false;
      metaInsightsRenderModal();
    }
  }
}

async function metaInsightsLoadFunds(refresh) {
  const ui = metaInsightsUi;
  if (ui.fundsLoading) return;
  const seq = ++ui.fundsSeq;
  ui.fundsLoading = true;
  ui.fundsError = '';
  metaInsightsRenderModal();
  try {
    const result = await apiMetaAccountFunds(refresh === true);
    if (seq === ui.fundsSeq) { ui.funds = result; ui.fundsAtMs = Date.now(); }
  } catch (error) {
    if (seq === ui.fundsSeq) ui.fundsError = metaAdsErrorMessage(error);
  } finally {
    if (seq === ui.fundsSeq) { ui.fundsLoading = false; metaInsightsRenderModal(); }
  }
}

// Money Meta reports INSIDE each ad account (prepaid available funds, spend limit
// left, amount due) — not the remaining budget of the active ads above.
function metaInsightsFundsCard(isAr) {
  const ui = metaInsightsUi;
  const names = new Map((state.ads || []).filter(a => a && a.metaAdAccountId && a.metaAdAccountName).map(a => [String(a.metaAdAccountId), String(a.metaAdAccountName)]));
  const rows = (Array.isArray(ui.funds?.accounts) ? ui.funds.accounts : []).slice().sort((a, b) => (Number(b.fundsMinor) || 0) - (Number(a.fundsMinor) || 0));
  const esc = value => Security.escapeHtml(String(value ?? ''));
  const money = (minor, cur) => esc(metaAdsFormatMoney(minor, cur || 'USD'));
  const row = a => {
    const name = /^Ad account \d+$/.test(String(a.name || '')) ? (names.get(String(a.id)) || a.name) : (a.name || `#${a.id}`);
    // Only the amount sits in the right column; every sentence wraps under the name (phone width).
    const main = a.error ? '' : a.fundsMinor != null ? `<span class="text-lg font-black text-sky-700 dark:text-sky-300">${money(a.fundsMinor, a.currency)}</span>`
      : a.fundsText || a.fundsHidden ? '' : `<span class="text-xs text-slate-400">${isAr ? 'لم تذكر Meta رصيداً' : 'No balance reported by Meta'}</span>`;
    const amber = 'text-amber-700 dark:text-amber-300';
    const note = a.error && a.waiting ? [isAr ? 'بانتظار Meta. يقرأ Albayan هذا الحساب تلقائياً عندما تسمح Meta.' : 'Waiting for Meta. Albayan reads this account automatically as soon as Meta allows.', amber]
      : a.error ? [a.error, 'text-rose-600']
      : a.stale ? [`${isAr ? 'آخر رصيد معروف، قُرئ في' : 'Last known amount, read'} ${metaAdsFormatDate(a.readAt, true)}`, amber]
      : a.fundsMinor == null && a.fundsText ? [a.fundsText, 'text-slate-600 dark:text-slate-300']
      : a.fundsMinor == null && a.fundsHidden ? [isAr ? 'لم تشارك Meta رصيد هذا الحساب. تعرضه فقط إذا كان لاتصال Albayan صلاحية "التحكم الكامل" على الحساب.' : 'Meta did not share this account\'s funds. It shows them only when the Albayan connection has Full control (Manage) on the account.', 'text-amber-700 dark:text-amber-300']
      : null;
    const extra = [
      a.capRemainingMinor != null ? `${isAr ? 'المتبقي من حد الإنفاق' : 'Spend limit left'}: ${money(a.capRemainingMinor, a.currency)}` : '',
      Number(a.amountDueMinor) > 0 ? `${isAr ? 'مستحق الدفع' : 'Amount due'}: ${money(a.amountDueMinor, a.currency)}` : ''
    ].filter(Boolean).join(' · ');
    return `<div class="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 dark:bg-slate-900/40" title="${esc(a.fundsText)}"><div class="min-w-0"><div class="break-words text-sm font-bold text-slate-800 dark:text-white">${esc(name)}</div><div class="font-mono text-[10px] text-slate-500">#${esc(a.id)}</div>${extra ? `<div class="text-[11px] text-slate-500">${extra}</div>` : ''}${note ? `<div class="mt-0.5 break-words text-xs font-bold ${note[1]}">${esc(note[0])}</div>` : ''}</div><div class="shrink-0 text-end">${main}</div></div>`;
  };
  return `<div data-role="meta-account-funds" class="mt-4 rounded-xl border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-800 dark:bg-sky-950/20">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 font-black text-sky-800 dark:text-sky-200"><i data-lucide="banknote" class="h-4 w-4"></i>${isAr ? 'الأموال في حسابات الإعلانات' : 'Money in the ad accounts'}</div>
      <button type="button" onclick="metaInsightsLoadFunds(true)" ${ui.fundsLoading ? 'disabled' : ''} class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-sky-200 px-2.5 text-xs font-bold text-sky-700 hover:bg-sky-100 disabled:opacity-60 dark:border-sky-800 dark:text-sky-300"><i data-lucide="refresh-cw" class="h-3.5 w-3.5 ${ui.fundsLoading ? 'animate-spin' : ''}"></i>${isAr ? 'تحديث' : 'Refresh'}</button>
    </div>
    <p class="mt-1 text-xs text-slate-500">${isAr ? 'ما تذكره Meta كرصيد في كل حساب (المال الذي أضفته ولم يُصرف بعد)، وهو غير ميزانية الإعلانات أعلاه.' : 'What Meta reports inside each account (money you added that is not spent yet). This is not the ads budget above.'}</p>
    ${ui.funds?.provider?.paused && rows.some(a => a.stale || a.waiting) ? `<div class="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">${isAr ? `طلبت Meta من Albayan التمهل الآن. المحاولة التلقائية التالية بعد نحو ${Math.max(1, Math.ceil((Number(ui.funds.provider.retryAfterSeconds) || 0) / 60))} دقيقة.` : `Meta asked Albayan to slow down right now. Next automatic try in about ${Math.max(1, Math.ceil((Number(ui.funds.provider.retryAfterSeconds) || 0) / 60))} min.`}</div>` : ''}
    ${ui.fundsError ? `<div role="alert" class="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200">${esc(ui.fundsError)}</div>` : ''}
    ${ui.fundsLoading && !ui.funds ? `<div class="mt-3 flex items-center justify-center gap-2 p-4 text-sm text-slate-500"><i data-lucide="loader-circle" class="h-4 w-4 animate-spin"></i>${isAr ? 'جارٍ القراءة من Meta...' : 'Reading from Meta...'}</div>` : ''}
    ${rows.length ? `<div class="mt-3 space-y-1.5">${rows.map(row).join('')}</div>` : (ui.funds && !ui.fundsLoading ? `<div class="mt-3 text-xs text-slate-500">${isAr ? 'لا توجد حسابات إعلانية مرتبطة.' : 'No ad accounts are connected.'}</div>` : '')}
    ${ui.funds?.fetchedAt ? `<div class="mt-2 text-[10px] text-slate-400">${isAr ? 'آخر قراءة' : 'Last read'}: ${esc(metaAdsFormatDate(ui.funds.fetchedAt, true))}${ui.funds.truncated ? (isAr ? ' — أول 25 حساباً فقط' : ' — first 25 accounts only') : ''}</div>` : ''}
  </div>`;
}

function metaInsightsPageRow(page, isAr, currency) {
  const spendText = metaAdsFormatMoney(Number(page.spendMinor) || 0, currency || 'USD');
  return `<div class="flex items-center justify-between gap-3 rounded-xl border p-2.5 ${page.qualified ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-slate-200 dark:border-slate-700'}">
    <div class="min-w-0">
      <div class="break-words text-sm font-bold text-slate-800 dark:text-white">${Security.escapeHtml(String(page.pageName || ''))}</div>
      <div class="break-all font-mono text-[10px] text-slate-500">#${Security.escapeHtml(String(page.pageId || ''))}</div>
    </div>
    <div class="shrink-0 text-end">
      <div class="text-sm font-black ${page.qualified ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'}">${Security.escapeHtml(spendText)}</div>
      ${page.qualified
        ? `<div class="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white"><i data-lucide="check" class="h-3 w-3"></i>${isAr ? 'مؤهلة' : 'Qualified'}</div>`
        : `<div class="text-[10px] font-medium text-slate-400">${isAr ? 'أقل من 100$' : 'Under $100'}</div>`}
    </div>
  </div>`;
}

function metaInsightsRenderModal() {
  // Never re-create the dialog after the user closed it: an in-flight load
  // finishing later must not resurrect a dismissed overlay.
  if (!metaInsightsUi.open) return;
  const isAr = metaAdsIsArabic();
  let modal = document.getElementById('meta-insights-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'meta-insights-modal';
    modal.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center overflow-hidden bg-slate-900/60 p-2 backdrop-blur-sm sm:items-center sm:p-4';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.onclick = event => { if (event.target === modal) closeMetaInsightsModal(); };
    document.body.appendChild(modal);
  }
  const summary = metaAdsActiveRemainingSummary();
  const stats = metaInsightsUi.stats;
  const pages = Array.isArray(stats?.pages) ? stats.pages : [];
  const qualifiedPages = pages.filter(page => page && page.qualified);
  const otherPages = pages.filter(page => page && !page.qualified);
  const targetCount = Number(stats?.targetCount) || 500;
  const qualifiedCount = Number(stats?.qualifiedCount) || qualifiedPages.length;
  const progressPercent = Math.max(0, Math.min(100, (qualifiedCount / targetCount) * 100));
  const computedText = stats?.computedAt ? metaAdsFormatDate(stats.computedAt, true) : '';
  const shownOthers = otherPages.slice(0, 15);
  const accountErrors = Array.isArray(stats?.accountErrors) ? stats.accountErrors : [];

  modal.innerHTML = `<div class="glass-panel w-full max-w-2xl overflow-y-auto rounded-2xl p-4 shadow-2xl custom-scrollbar sm:p-6" style="max-height:85dvh" dir="${isAr ? 'rtl' : 'ltr'}" onclick="event.stopPropagation()">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i data-lucide="gauge" class="h-6 w-6 text-emerald-600"></i>${isAr ? 'مؤشرات Meta' : 'Meta Insights'}</h2>
        <p class="mt-1 text-sm text-slate-500">${isAr ? 'قراءة فقط — من حسابات الإعلانات المرتبطة.' : 'Read-only — from the connected ad accounts.'}</p>
      </div>
      <button type="button" onclick="closeMetaInsightsModal()" class="touch-target rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>

    <div data-role="meta-active-remaining" class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
      <div class="flex items-center gap-2 font-black text-emerald-800 dark:text-emerald-200"><i data-lucide="wallet" class="h-4 w-4"></i>${isAr ? 'الميزانية المتبقية — كل الإعلانات النشطة معاً' : 'Total remaining budget — all active ads combined'}</div>
      <div class="mt-2 text-3xl font-black text-emerald-700 dark:text-emerald-300">${Security.escapeHtml(metaAdsFormatMoney(summary.totalMinor, summary.currency))}</div>
      <div class="mt-1 text-xs text-slate-500">${isAr ? `${summary.count} إعلان نشط على Meta الآن (المستوردة تلقائياً + المربوطة يدوياً)` : `${summary.count} ad(s) currently ACTIVE on Meta (auto-imported + manually linked)`}${summary.openEnded ? ` · ${isAr ? `${summary.openEnded} إعلان مفتوح بدون ميزانية إجمالية (غير محسوب)` : `${summary.openEnded} open-ended ad(s) without a total budget (not counted)`}` : ''}</div>
      ${summary.byAccount.length ? `<div class="mt-3 space-y-1.5">${summary.byAccount.map(account => `<div class="flex items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-1.5 text-xs dark:bg-slate-900/40"><span class="min-w-0 break-words font-bold text-slate-700 dark:text-slate-200">${Security.escapeHtml(account.name)} <span class="font-normal text-slate-400">(${account.count})</span></span><span class="shrink-0 font-black text-emerald-700 dark:text-emerald-300">${Security.escapeHtml(metaAdsFormatMoney(account.totalMinor, summary.currency))}</span></div>`).join('')}</div>` : ''}
    </div>

    ${metaInsightsFundsCard(isAr)}

    <div data-role="meta-active-pages" class="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-800 dark:bg-indigo-950/20">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 font-black text-indigo-800 dark:text-indigo-200"><i data-lucide="files" class="h-4 w-4"></i>${isAr ? 'الصفحات النشطة (معيار شريك Meta)' : 'Active pages (Meta partner metric)'}</div>
        <button type="button" onclick="metaInsightsLoad(true)" ${metaInsightsUi.refreshing || metaInsightsUi.loading ? 'disabled' : ''} class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-indigo-200 px-2.5 text-xs font-bold text-indigo-700 disabled:opacity-60 dark:border-indigo-700 dark:text-indigo-200"><i data-lucide="${metaInsightsUi.refreshing ? 'loader-circle' : 'refresh-cw'}" class="h-3.5 w-3.5 ${metaInsightsUi.refreshing ? 'animate-spin' : ''}"></i>${isAr ? 'تحديث' : 'Refresh'}</button>
      </div>
      <p class="mt-1 text-xs text-slate-500">${isAr ? 'عدد الصفحات المرتبطة بحسابات الإعلانات التي تجاوز إنفاقها 100$ خلال آخر 90 يوماً.' : 'Pages connected to the ad accounts with over $100 in spend over the last 90 days.'}</p>
      ${metaInsightsUi.error ? `<div role="alert" class="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200">${Security.escapeHtml(metaInsightsUi.error)}</div>` : ''}
      ${metaInsightsUi.loading ? `<div class="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white/60 p-6 text-slate-500 dark:bg-slate-900/40"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'حساب الصفحات النشطة...' : 'Calculating active pages...'}</div>` : ''}
      ${!metaInsightsUi.loading && stats ? `
        <div class="mt-3 flex items-end gap-2"><span class="text-3xl font-black text-indigo-700 dark:text-indigo-300">${qualifiedCount}</span><span class="pb-1 text-sm font-bold text-slate-500">/ ${targetCount} ${isAr ? 'هدف الشارة' : 'badge target'}</span></div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div class="h-full rounded-full bg-indigo-600" style="width:${progressPercent.toFixed(1)}%"></div></div>
        ${computedText ? `<div class="mt-1 text-[10px] text-slate-400">${isAr ? 'آخر حساب' : 'Last calculated'}: ${Security.escapeHtml(computedText)}</div>` : ''}
        ${accountErrors.length ? `<div class="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">${Security.escapeHtml(accountErrors[0])}</div>` : ''}
        ${Array.isArray(stats.notes) && stats.notes.length ? `<div class="mt-2 text-xs text-slate-500">${Security.escapeHtml(stats.notes[0])}</div>` : ''}
        ${Number(stats.unmatchedAdCount) ? `<div class="mt-2 text-xs text-slate-500">${isAr ? `لا يزال ${Number(stats.unmatchedAdCount)} إعلان قديم قيد التحليل — الرقم يقترب من رقم Meta مع كل تحديث.` : `${Number(stats.unmatchedAdCount)} older ad(s) still being analyzed — the number converges to Meta's with each refresh.`}</div>` : ''}
        <div class="mt-3 space-y-2">
          ${qualifiedPages.length ? `<div class="text-xs font-black text-emerald-700 dark:text-emerald-300">${isAr ? `الصفحات المؤهلة (${qualifiedPages.length})` : `Qualified pages (${qualifiedPages.length})`}</div>` : `<div class="rounded-xl bg-white/60 p-4 text-center text-sm text-slate-500 dark:bg-slate-900/40">${isAr ? 'لا توجد صفحات مؤهلة بعد.' : 'No qualified pages yet.'}</div>`}
          ${qualifiedPages.map(page => metaInsightsPageRow(page, isAr, stats.currency)).join('')}
          ${shownOthers.length ? `<div class="pt-1 text-xs font-black text-slate-500">${isAr ? 'الأقرب إلى التأهل' : 'Closest to qualifying'}</div>` : ''}
          ${shownOthers.map(page => metaInsightsPageRow(page, isAr, stats.currency)).join('')}
          ${otherPages.length > shownOthers.length ? `<div class="text-center text-[10px] text-slate-400">${isAr ? `و${otherPages.length - shownOthers.length} صفحة أخرى أقل إنفاقاً` : `and ${otherPages.length - shownOthers.length} more lower-spend page(s)`}</div>` : ''}
        </div>
      ` : ''}
    </div>
  </div>`;
  IconQueue.schedule(modal);
}

function metaAdsErrorMessage(error) {
  const raw = String(error?.message || error?.detail || '').trim();
  const isAr = metaAdsIsArabic();
  if (isAr && /belongs to Albayan Studio/.test(raw)) return 'هذا إعلان تابع لـ Albayan Studio ولا يمكن ربطه هنا.';
  if (isAr && /already linked to another Albayan ad/.test(raw)) return 'إعلان Meta هذا مرتبط بإعلان آخر (ربما مسودة مستوردة).';
  return raw || (isAr ? 'تعذّر الاتصال بـ Meta. حاول مرة أخرى.' : 'Could not connect to Meta. Please try again.');
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

function openMetaAdsConnectionModalNow(adId = '') {
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
  const importState = status?.importState && typeof status.importState === 'object' ? status.importState : {};
  const providerState = status?.providerState && typeof status.providerState === 'object' ? status.providerState : {};
  const retryAfterSeconds = Math.max(0, Number(providerState.retryAfterSeconds || status?.remoteBackoffSeconds) || 0);
  const providerPaused = providerState.paused === true || retryAfterSeconds > 0;
  const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const importError = /temporarily limiting|paused safely|rate.?limit/i.test(String(importState.lastError || '')) ? '' : String(importState.lastError || '');
  const lastDiscoveryText = metaAdsFormatDate(importState.lastDiscoveryAt, true);
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
      <div class="rounded-xl border ${providerPaused ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20' : 'border-slate-200 dark:border-slate-700'} p-3"><div class="text-xs text-slate-500">${isAr ? 'المزامنة التلقائية' : 'Automatic sync'}</div><div class="mt-1 font-bold ${providerPaused ? 'text-amber-700 dark:text-amber-300' : ''}">${providerPaused ? (isAr ? `متوقفة بأمان · إعادة المحاولة خلال ${retryMinutes} دقيقة` : `Paused safely · retry in ${retryMinutes} min`) : (status.backgroundSync ? `${Number(status.syncIntervalMinutes) || 15} ${isAr ? 'دقيقة' : 'minutes'}` : (isAr ? 'متوقفة' : 'Off'))}</div></div>
    </div>` : ''}

    ${!metaAdsUi.loading && configured && providerPaused ? `<div role="status" class="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"><div class="flex items-start gap-2"><i data-lucide="shield-check" class="mt-0.5 h-5 w-5 shrink-0"></i><div><div class="font-black">${isAr ? 'Albayan يحمي اتصال Meta' : 'Albayan is protecting the Meta connection'}</div><div class="mt-1">${isAr ? `وصل الاستخدام إلى ${Number(providerState.usagePercent) || 0}٪، لذلك توقفت الطلبات مؤقتاً وستستأنف تلقائياً خلال حوالي ${retryMinutes} دقيقة. لا تحتاج إلى فعل شيء.` : `Usage reached ${Number(providerState.usagePercent) || 0}%, so requests are paused temporarily and will resume automatically in about ${retryMinutes} minute(s). You do not need to do anything.`}</div></div></div></div>` : ''}

    ${!metaAdsUi.loading && configured ? `<div class="mt-3 rounded-xl border ${providerPaused ? 'border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20' : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20'} p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div class="flex items-center gap-2 font-black text-emerald-800 dark:text-emerald-200"><i data-lucide="sparkles" class="h-4 w-4"></i>${isAr ? 'الاستيراد التلقائي للإعلانات والصفحات' : 'Automatic ad and page import'}</div>
          <div class="mt-1 text-xs text-emerald-700 dark:text-emerald-300">${status.autoImport ? (isAr ? `يعمل كل ${Number(status.discoveryIntervalSeconds) || 60} ثانية` : `Runs every ${Number(status.discoveryIntervalSeconds) || 60} seconds`) : (isAr ? 'متوقف' : 'Off')} · ${isAr ? 'الحسابات' : 'Accounts'}: ${Number(importState.accountCount || status.allowedAccountCount) || 0}</div>
          <div class="mt-1 text-xs text-slate-500">${lastDiscoveryText ? `${isAr ? 'آخر فحص' : 'Last check'}: ${Security.escapeHtml(lastDiscoveryText)} · ` : ''}${isAr ? 'تم استيراد' : 'Imported'}: ${Number(importState.totalImported) || 0}${Number(importState.lastImportedCount) ? ` (${isAr ? 'آخر فحص' : 'last check'}: ${Number(importState.lastImportedCount)})` : ''}</div>
          ${importError ? `<div class="mt-1 text-xs font-medium text-rose-600 dark:text-rose-300">${Security.escapeHtml(importError)}</div>` : ''}
        </div>
        <button type="button" onclick="metaAdsCheckForNewAds()" ${metaAdsUi.busyAction || providerPaused ? 'disabled' : ''} class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"><i data-lucide="${metaAdsUi.busyAction === 'discover' ? 'loader-circle' : 'radar'}" class="h-4 w-4 ${metaAdsUi.busyAction === 'discover' ? 'animate-spin' : ''}"></i>${providerPaused ? (isAr ? 'سيستأنف تلقائياً' : 'Resumes automatically') : (isAr ? 'فحص الإعلانات الجديدة الآن' : 'Check for new ads now')}</button>
      </div>
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

    ${configured && !metaAdsUi.loading ? `<div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><p class="text-xs text-slate-500">${isAr ? 'يعمل الاستيراد والمزامنة في السيرفر حتى عندما تغلق هذه الصفحة.' : 'Automatic import and sync run on the server even when this page is closed.'}</p><button type="button" onclick="metaAdsSyncAllDue()" ${metaAdsUi.busyAction || providerPaused ? 'disabled' : ''} class="min-h-11 rounded-xl border border-blue-200 px-3 text-sm font-bold text-blue-700 disabled:opacity-60 dark:border-blue-800 dark:text-blue-200">${providerPaused ? (isAr ? 'إعادة المحاولة تلقائياً' : 'Automatic retry pending') : (isAr ? 'مزامنة المستحق الآن' : 'Sync due now')}</button></div>` : ''}
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
    // Only the version check's "Conflict: ..." means the ad changed; other 409s keep the server's words.
    const is409 = Number(error?.status) === 409;
    if (is409) await metaAdsRefreshAfterConflict(target.id);
    metaAdsUi.error = is409 && /^conflict\b/i.test(error?.message || '')
      ? (isAr ? 'تغيّر الإعلان أثناء العمل. تم تحميل النسخة الجديدة؛ راجعها وحاول مرة أخرى.' : 'The ad changed while you were working. The latest version was loaded; review it and try again.')
      : metaAdsErrorMessage(error);
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

async function metaAdsCheckForNewAds() {
  if (metaAdsUi.busyAction) return;
  const isAr = metaAdsIsArabic();
  metaAdsUi.busyAction = 'discover';
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    const result = await apiRunMetaAutoImport();
    if (result.imported.length) {
      applyValidatedServerEntityBatch(result.imported.map(entity => ({ collection: 'ads', entity })), 'metaAutoImport');
    }
    if (metaAdsUi.status) metaAdsUi.status.importState = result.state;
    if (result.busy) return showNotification(isAr ? 'فحص Meta يعمل الآن' : 'A Meta check is running', isAr ? 'ستظهر الإعلانات الجديدة بعد قليل.' : 'New ads will appear in a moment.', 'info');
    const count = result.imported.length;
    showNotification(
      isAr ? 'اكتمل فحص Meta' : 'Meta check complete',
      count
        ? (isAr ? `تم إنشاء ${count} إعلان جديد كمسودة آمنة تحتاج إكمال.` : `${count} new ad(s) were created as safe drafts that need completion.`)
        : (isAr ? 'لا توجد إعلانات جديدة الآن.' : 'There are no new ads right now.'),
      'success'
    );
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
  } finally {
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
  }
}

async function metaAdsSyncAllDue() {
  if (metaAdsUi.busyAction) return;
  const isAr = metaAdsIsArabic();
  metaAdsUi.busyAction = 'all';
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    const result = await apiSyncDueMetaAds(4);
    const entities = [...result.ads, ...result.imported];
    if (entities.length) applyValidatedServerEntityBatch(entities.map(entity => ({ collection: 'ads', entity })), 'metaSyncDue');
    if (metaAdsUi.status) metaAdsUi.status.importState = result.importState;
    showNotification(isAr ? 'اكتملت المزامنة' : 'Sync complete', isAr ? `تم تحديث ${result.ads.length} واستيراد ${result.imported.length} إعلان.` : `Updated ${result.ads.length} and imported ${result.imported.length} ad(s).`, 'success');
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
  } finally {
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
  }
}
