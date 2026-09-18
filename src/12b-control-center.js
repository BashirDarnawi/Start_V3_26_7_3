// ==========================================
// DAILY CONTROL CENTER (ADMIN)
// ==========================================
// A small operational cockpit: it does not change accounting automatically.
// It points the owner to incomplete work, verifies infrastructure readiness,
// and exposes the audited month-close / encrypted-backup controls.

let _controlCenter = {
  loading: false,
  loadedAt: 0,
  operations: null,
  meta: null,
  error: '',
  period: ''
};

// Platform-owner screen; still, Arabic admins deserve Arabic messages.
function ccText(en, ar) {
  return state.language === 'ar' ? ar : en;
}

function controlCenterPreviousMonth() {
  const now = new Date();
  const value = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function controlCenterMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function controlCenterTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 'Never';
  try { return new Date(number).toLocaleString(typeof appDateLocale === 'function' ? appDateLocale() : undefined); } catch (_) { return 'Never'; }
}

function getControlCenterFacts() {
  const ads = getVisibleRecords(state.ads || []);
  const receipts = getVisibleRecords(state.receipts || []);
  const setupAds = ads.filter(ad => {
    if (typeof isMetaAdSetupPending === 'function' && isMetaAdSetupPending(ad)) return true;
    return !String(ad.customerId || '').trim() || Number(ad.amountUSD || 0) <= 0 || !String(ad.paymentStatus || '').trim();
  });
  const unpaidReceipts = receipts.filter(receipt => {
    if (String(receipt.receiptType || '').toUpperCase() === 'TRANSFER_IN') return false;
    // Canceled/Lost/Destroyed receipts are settled history, not money the
    // owner still needs to chase — they must not inflate the attention count.
    if (getReceiptPaymentState(receipt) !== 'not_paid') return false;
    return true;
  });
  const metaFailures = ads.filter(ad => { const code = String(ad.metaSyncErrorCode || ad.metaLastErrorCode || '').trim(); return code && !['pending_enrichment', 'insights_unavailable'].includes(code); });  // informational states are not failures
  let snapshot = null;
  try { snapshot = typeof getCurrentProfitabilitySnapshot === 'function' ? getCurrentProfitabilitySnapshot(ads) : null; } catch (_) {}
  return {
    ads,
    receipts,
    setupAds,
    unpaidReceipts,
    metaFailures,
    snapshot,
    attentionCount: setupAds.length + unpaidReceipts.length + metaFailures.length + ((snapshot?.unpricedSpendUSD || 0) > 0.005 ? 1 : 0)
  };
}

async function loadControlCenterStatus(force = false) {
  if (_controlCenter.loading) return;
  if (!force && _controlCenter.loadedAt && Date.now() - _controlCenter.loadedAt < 60000) return;
  _controlCenter.loading = true;
  _controlCenter.error = '';
  if (state.currentView === 'control-center') RenderQueue.schedule('control-center-loading');
  try {
    const [operations, meta] = await Promise.allSettled([apiOperationsStatus(), apiMetaAdsStatus()]);
    const errors = [];
    if (operations.status === 'fulfilled') _controlCenter.operations = operations.value;
    else errors.push(`Operations: ${String(operations.reason?.message || 'unavailable')}`);
    if (meta.status === 'fulfilled') _controlCenter.meta = meta.value;
    else errors.push(`Meta: ${String(meta.reason?.message || 'unavailable')}`);
    _controlCenter.error = errors.join(' | ');
    _controlCenter.loadedAt = Date.now();
  } catch (error) {
    _controlCenter.error = String(error?.message || 'Could not load the server checks');
  } finally {
    _controlCenter.loading = false;
    if (state.currentView === 'control-center') RenderQueue.schedule('control-center-loaded');
  }
}

function refreshControlCenter() {
  _controlCenter.loadedAt = 0;
  loadControlCenterStatus(true);
}

function controlCenterOpenAds(mode) {
  state.adFilters = { status: 'all', payment: 'all', page: 'all' };
  if (mode === 'setup') state.adFilters.payment = 'pending_setup';
  if (mode === 'unpaid') state.adFilters.payment = 'not_paid';
  navigateTo('ads');
}

function controlCenterOpenReceipts() {
  state.receiptStatusFilter = 'unpaid';
  state.receiptPaymentFilter = 'all';
  navigateTo('receipts');
}

async function previewControlCenterMonth() {
  const input = document.getElementById('control-center-period');
  const period = String(input?.value || _controlCenter.period || controlCenterPreviousMonth());
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    const totals = preview?.totals || {};
    const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
    const message = [
      `${ccText('Receipts', 'الوصولات')}: $${controlCenterMoney(totals.receiptVolumeUSD)}`,
      `${ccText('Ad sales', 'مبيعات الإعلانات')}: $${controlCenterMoney(totals.adSalesUSD)}`,
      `${ccText('Ad spend (actual)', 'الإنفاق الإعلاني الفعلي')}: $${controlCenterMoney(totals.adSpendUSD ?? totals.metaSpendUSD)}`,
      blockers.length ? `${ccText('Problems to review', 'مشاكل للمراجعة')}: ${blockers.map(item => `${item.message} (${item.count})`).join(', ')}` : ccText('No closing problems found.', 'لا توجد مشاكل تمنع الإقفال.')
    ].join('\n');
    window.alert(message);
  } catch (error) {
    showNotification(ccText('Month check failed', 'فشل فحص الشهر'), String(error?.message || error), 'error');
  }
}

async function closeControlCenterMonth() {
  const period = String(document.getElementById('control-center-period')?.value || controlCenterPreviousMonth());
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
    let forceReason = '';
    if (blockers.length) {
      const blockerText = blockers.map(item => `${item.message} (${item.count})`).join('\n');
      forceReason = window.prompt(ccText(
        `This month has items to review:\n${blockerText}\n\nFix them first, or type a clear reason (at least 10 characters) to close anyway:`,
        `هذا الشهر فيه عناصر تحتاج مراجعة:\n${blockerText}\n\nأصلحها أولاً، أو اكتب سبباً واضحاً (10 أحرف على الأقل) للإقفال رغم ذلك:`
      )) || '';
      if (forceReason.trim().length < 10) return;
    } else if (!window.confirm(ccText(
      `Close ${period}? After closing, its receipts, ads, and dollar purchases cannot be changed.`,
      `إقفال ${period}؟ بعد الإقفال لا يمكن تعديل وصولاته وإعلاناته ومشتريات الدولار.`
    ))) return;
    await apiCloseFinancialPeriod(period, forceReason);
    showNotification(ccText('Month closed safely', 'تم إقفال الشهر بأمان'), ccText(`${period} is now protected from changes.`, `${period} أصبح محمياً من التعديل.`), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification(ccText('Could not close month', 'تعذر إقفال الشهر'), String(error?.message || error), 'error');
  }
}

async function unlockControlCenterMonth(period) {
  const reason = window.prompt(ccText(
    `Why must ${period} be unlocked? This action is recorded in the audit log.`,
    `لماذا يجب فتح ${period}؟ يُسجَّل هذا الإجراء في سجل التدقيق.`
  )) || '';
  if (reason.trim().length < 10) {
    showNotification(ccText('Reason required', 'السبب مطلوب'), ccText('Please write at least 10 characters.', 'اكتب 10 أحرف على الأقل.'), 'warning');
    return;
  }
  try {
    await apiUnlockFinancialPeriod(period, reason);
    showNotification(ccText('Month unlocked', 'تم فتح الشهر'), ccText(`${period} can be corrected now. Close it again when finished.`, `يمكن تصحيح ${period} الآن. أقفله مجدداً عند الانتهاء.`), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification(ccText('Could not unlock month', 'تعذر فتح الشهر'), String(error?.message || error), 'error');
  }
}

async function runControlCenterBackup() {
  try {
    showNotification(ccText('Backup started', 'بدأ النسخ الاحتياطي'), ccText('Please keep this page open while the server creates the encrypted copy.', 'أبقِ هذه الصفحة مفتوحة بينما ينشئ الخادم النسخة المشفرة.'), 'info');
    const response = await apiRunEncryptedBackup();
    showNotification(ccText('Backup complete', 'اكتمل النسخ الاحتياطي'), response?.backup?.offsite ? ccText('Encrypted backup saved locally and off-site.', 'حُفظت النسخة المشفرة محلياً وخارجياً.') : ccText('Encrypted backup saved.', 'حُفظت النسخة المشفرة.'), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification(ccText('Backup failed', 'فشل النسخ الاحتياطي'), String(error?.message || error), 'error');
  }
}

function renderControlCenterTask(icon, color, title, detail, actionHtml = '') {
  return `
    <div class="management-priority-item" role="listitem">
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${color}"><i data-lucide="${icon}" class="h-5 w-5"></i></span>
        <div class="min-w-0"><div class="font-bold text-slate-900 dark:text-white">${Security.escapeHtml(title)}</div><div class="mt-1 text-sm text-slate-500 dark:text-slate-400">${Security.escapeHtml(detail)}</div></div>
      </div>
      ${actionHtml ? `<div class="management-task-action">${actionHtml}</div>` : ''}
    </div>`;
}

// ---- Subscription plans manager (owner pricing without redeploys) ----
let _planManager = { loading: false, loadedAt: 0, version: 0, plans: [], error: '', dirty: false };
// Mirrors the server's KNOWN_SERVICE_IDS; the server re-validates anyway.
const PLAN_MANAGER_SERVICE_IDS = ['international_shipping', 'local_shipping', 'warehouse', 'smart_systems', 'clothes_system', 'ad_maker'];

async function loadPlanManager(force = false) {
  if (_planManager.loading || !isServerModeEnabled()) return;
  if (!force && _planManager.loadedAt && Date.now() - _planManager.loadedAt < 60000) return;
  if (!force && _planManager.dirty) return; // never clobber unsaved edits
  _planManager.loading = true;
  _planManager.error = '';
  try {
    const payload = await apiJson('/api/admin/subscription-plans', { method: 'GET' });
    _planManager.plans = Array.isArray(payload?.plans) ? payload.plans : [];
    _planManager.version = Number(payload?.version || 0);
    _planManager.loadedAt = Date.now();
    _planManager.dirty = false;
  } catch (error) {
    _planManager.error = String(error?.payload?.detail || error?.message || 'Could not load the plan catalog');
  } finally {
    _planManager.loading = false;
    if (state.currentView === 'control-center') render();
  }
}

function planManagerSetField(index, field, value) {
  const plan = _planManager.plans[Number(index)];
  if (!plan) return;
  if (field === 'priceLYD') {
    // A half-typed or malformed price ("12.", "1,234.50", "") must never
    // silently become 0 and turn a paid plan into a free one; keep the
    // previous price until the input parses.
    const raw = String(value ?? '').trim().replace(',', '.');
    const parsed = Number(raw);
    if (raw === '' || !Number.isFinite(parsed)) return;
    plan.priceMinor = Math.max(0, Math.round(parsed * 100));
  }
  else if (field === 'durationDays') plan.durationDays = Math.max(1, Math.min(3660, Math.trunc(Number(value) || 30)));
  else if (field === 'sortOrder') plan.sortOrder = Math.trunc(Number(value) || 0);
  else if (field === 'active') plan.active = value === true;
  else if (field === 'name' || field === 'nameAr') plan[field] = String(value || '').slice(0, 80);
  _planManager.dirty = true;
}

function planManagerAddBundle() {
  const read = id => String(document.getElementById(id)?.value || '').trim();
  const rawId = read('plan-new-id').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  const name = read('plan-new-name').slice(0, 80);
  const nameAr = read('plan-new-name-ar').slice(0, 80);
  const services = PLAN_MANAGER_SERVICE_IDS.filter(sid => document.getElementById(`plan-new-svc-${sid}`)?.checked);
  if (rawId.length < 2 || !name || !nameAr || !services.length) {
    showNotification(ccText('Missing details', 'بيانات ناقصة'), ccText('A bundle needs an id, both names, and at least one service.', 'الباقة تحتاج إلى معرّف واسمين وخدمة واحدة على الأقل.'), 'warning');
    return;
  }
  if (_planManager.plans.some(p => String(p.id) === rawId)) {
    showNotification(ccText('Duplicate id', 'معرّف مكرر'), ccText('A plan with this id already exists.', 'توجد خطة بهذا المعرّف بالفعل.'), 'warning');
    return;
  }
  _planManager.plans.push({
    id: rawId,
    serviceIds: services,
    name,
    nameAr,
    priceMinor: Math.max(0, Math.round((Number(read('plan-new-price').replace(',', '.')) || 0) * 100)),
    currency: 'LYD',
    durationDays: Math.max(1, Math.min(3660, Math.trunc(Number(read('plan-new-days')) || 30))),
    badge: services.length > 1 ? 'best_value' : null,
    savingsPct: null,
    active: true,
    sortOrder: 0
  });
  _planManager.dirty = true;
  render();
}

async function savePlanManager() {
  if (!_planManager.plans.length) return;
  try {
    const payload = await apiAdminSaveSubscriptionPlans(_planManager.plans.map(p => ({
      id: String(p.id),
      serviceIds: Array.isArray(p.serviceIds) ? p.serviceIds : [],
      name: String(p.name || ''),
      nameAr: String(p.nameAr || ''),
      priceMinor: Math.max(0, Math.trunc(Number(p.priceMinor) || 0)),
      currency: 'LYD',
      durationDays: Math.max(1, Math.min(3660, Math.trunc(Number(p.durationDays) || 30))),
      badge: p.badge || null,
      savingsPct: Number.isFinite(Number(p.savingsPct)) && p.savingsPct !== null && p.savingsPct !== '' ? Math.trunc(Number(p.savingsPct)) : null,
      active: p.active !== false,
      sortOrder: Math.trunc(Number(p.sortOrder) || 0)
    })), _planManager.version);
    _planManager.version = Number(payload?.version || _planManager.version + 1);
    _planManager.dirty = false;
    _planManager.loadedAt = 0;
    showNotification(ccText('Plans saved', 'تم حفظ الخطط'), ccText(`Catalog version ${_planManager.version} is live — new purchases use it immediately.`, `الإصدار ${_planManager.version} من الكتالوج أصبح فعالاً — المشتريات الجديدة تستخدمه فوراً.`), 'success');
    if (typeof refreshSubscriptionPlans === 'function') refreshSubscriptionPlans(true).catch(() => {});
    loadPlanManager(true);
  } catch (error) {
    const detail = (error?.payload && error.payload.detail) ? error.payload.detail : (error?.message || 'Save failed');
    showNotification(ccText('Could not save plans', 'تعذر حفظ الخطط'), String(detail), 'error');
  }
}

function renderPlanManagerSection() {
  if (!isServerModeEnabled()) return '';
  const rows = _planManager.plans.map((plan, index) => {
    const safeName = Security.escapeHtml(String(plan.name || plan.id));
    const services = (Array.isArray(plan.serviceIds) ? plan.serviceIds : []).join(' + ');
    return `
      <div class="management-plan-row grid grid-cols-2 items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800 sm:grid-cols-[1.2fr_1fr_90px_80px_70px_70px]">
        <div class="min-w-0">
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالإنجليزية' : 'Plan name in English'}" value="${safeName}" oninput="planManagerSetField(${index}, 'name', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 font-bold text-slate-800 focus:border-indigo-300 dark:text-white" />
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالعربية' : 'Plan name in Arabic'}" value="${Security.escapeHtml(String(plan.nameAr || ''))}" dir="rtl" oninput="planManagerSetField(${index}, 'nameAr', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 text-xs text-slate-500 focus:border-indigo-300" />
        </div>
        <div class="truncate text-xs text-slate-500" title="${Security.escapeHtml(String(plan.id))}">${Security.escapeHtml(services)}</div>
        <label class="text-xs text-slate-500 sm:text-right">LYD<input type="number" min="0" step="0.01" value="${(Math.max(0, Number(plan.priceMinor) || 0) / 100).toFixed(2)}" oninput="planManagerSetField(${index}, 'priceLYD', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono font-bold dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">Days<input type="number" min="1" max="3660" value="${Math.max(1, Number(plan.durationDays) || 30)}" oninput="planManagerSetField(${index}, 'durationDays', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">Order<input type="number" value="${Math.trunc(Number(plan.sortOrder) || 0)}" oninput="planManagerSetField(${index}, 'sortOrder', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="flex items-center justify-end gap-1 text-xs font-bold ${plan.active !== false ? 'text-emerald-600' : 'text-slate-400'}"><input type="checkbox" ${plan.active !== false ? 'checked' : ''} onchange="planManagerSetField(${index}, 'active', this.checked)" class="h-5 w-5 accent-emerald-600" />On</label>
      </div>`;
  }).join('');
  return `
      <section class="glass-panel rounded-3xl p-5 sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><div class="flex items-center gap-2"><i data-lucide="badge-dollar-sign" class="h-5 w-5 text-emerald-600"></i><h2 class="text-xl font-black text-slate-900 dark:text-white">Subscription plans & prices</h2></div>
          <p class="mt-1 text-sm text-slate-500">Prices are LYD and live on the server — saving here changes what customers pay next, never what they already bought. Catalog version: ${Number(_planManager.version) || 0}${_planManager.dirty ? ' · <span class="font-bold text-amber-600">unsaved changes</span>' : ''}</p></div>
          <div class="flex gap-2">
            <button type="button" onclick="loadPlanManager(true)" class="min-h-11 rounded-xl border border-slate-300 px-4 font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Reload</button>
            <button type="button" onclick="savePlanManager()" ${_planManager.dirty ? '' : 'disabled'} class="min-h-11 rounded-xl bg-emerald-600 px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">Save all plans</button>
          </div>
        </div>
        ${_planManager.error ? `<div class="mb-3 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">${Security.escapeHtml(_planManager.error)}</div>` : ''}
        <div class="space-y-2">${rows || `<div class="text-sm text-slate-500">${_planManager.loading ? 'Loading plans…' : 'Press Reload to fetch the plan catalog.'}</div>`}</div>
        <details class="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <summary class="cursor-pointer select-none font-bold text-slate-700 dark:text-slate-200">Add a bundle (one subscription, many systems)</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="text-xs font-bold text-slate-500">Bundle id (letters/numbers/underscore)<input id="plan-new-id" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="pro_bundle" /></label>
            <label class="text-xs font-bold text-slate-500">Price (LYD)<input id="plan-new-price" type="number" min="0" step="0.01" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="150.00" /></label>
            <label class="text-xs font-bold text-slate-500">Name (English)<input id="plan-new-name" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="Pro Bundle" /></label>
            <label class="text-xs font-bold text-slate-500">Name (Arabic)<input id="plan-new-name-ar" dir="rtl" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="الباقة الاحترافية" /></label>
            <label class="text-xs font-bold text-slate-500">Duration (days)<input id="plan-new-days" type="number" min="1" max="3660" value="30" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
            <div class="text-xs font-bold text-slate-500">Included systems<div class="mt-1 grid grid-cols-2 gap-1">${PLAN_MANAGER_SERVICE_IDS.map(sid => `<label class="flex items-center gap-2 rounded-lg bg-slate-100 px-2 py-1.5 dark:bg-slate-800"><input id="plan-new-svc-${sid}" type="checkbox" class="h-4 w-4 accent-indigo-600" /><span class="truncate">${sid}</span></label>`).join('')}</div></div>
          </div>
          <button type="button" onclick="planManagerAddBundle()" class="mt-3 min-h-11 rounded-xl bg-indigo-600 px-4 font-bold text-white">Add to list (save to publish)</button>
        </details>
      </section>`;
}

function renderControlCenterView() {
  if (!isAdminRole(state.currentUser?.role)) return renderNoAccessView();
  const isAr = state.language === 'ar';
  const text = (english, arabic) => isAr ? arabic : english;
  if (!_controlCenter.period) _controlCenter.period = controlCenterPreviousMonth();
  if (!_controlCenter.loading && (!_controlCenter.loadedAt || Date.now() - _controlCenter.loadedAt > 60000)) {
    setTimeout(() => loadControlCenterStatus(false), 0);
  }
  if (isServerModeEnabled() && !_planManager.loading && !_planManager.loadedAt) {
    setTimeout(() => loadPlanManager(false), 0);
  }
  const facts = getControlCenterFacts();
  const operations = _controlCenter.operations || {};
  const backup = operations.backup || {};
  const monitoring = operations.monitoring || {};
  const meta = _controlCenter.meta || {};
  const periods = Array.isArray(operations.financialPeriods) ? operations.financialPeriods : [];
  const closedPeriods = periods.filter(row => String(row.status || '').toLowerCase() === 'closed');
  const tasks = [];
  if (facts.setupAds.length) tasks.push(renderControlCenterTask('wand-sparkles', 'bg-amber-100 text-amber-700', text(`${facts.setupAds.length} ads need setup`, `${facts.setupAds.length} إعلانات تحتاج استكمال البيانات`), text('Add the customer, selling amount, payment, and receipt.', 'أضف العميل وسعر البيع وبيانات الدفع والوصل.'), `<button type="button" onclick="controlCenterOpenAds('setup')" class="min-h-11 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white">${text('Open ads', 'فتح الإعلانات')}</button>`));
  if (facts.unpaidReceipts.length) tasks.push(renderControlCenterTask('receipt', 'bg-rose-100 text-rose-700', text(`${facts.unpaidReceipts.length} receipts are unpaid`, `${facts.unpaidReceipts.length} وصولات غير مدفوعة`), text('Review money that customers still owe.', 'راجع المبالغ التي لا تزال مستحقة على العملاء.'), `<button type="button" onclick="controlCenterOpenReceipts()" class="min-h-11 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white">${text('Open receipts', 'فتح الوصولات')}</button>`));
  if ((facts.snapshot?.unpricedSpendUSD || 0) > 0.005) tasks.push(renderControlCenterTask('circle-dollar-sign', 'bg-rose-100 text-rose-700', text(`$${controlCenterMoney(facts.snapshot.unpricedSpendUSD)} Meta spend has no purchase cost`, `إنفاق ميتا بقيمة ${controlCenterMoney(facts.snapshot.unpricedSpendUSD)} دولار دون تكلفة شراء مسجلة`), text('Record the real dollar purchase so profit is not guessed.', 'سجّل التكلفة الفعلية لشراء الدولار حتى لا يُحسب الربح بالتخمين.'), `<button type="button" onclick="navigateTo('analytics')" class="min-h-11 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white">${text('Fix profit data', 'استكمال بيانات الربح')}</button>`));
  if (facts.metaFailures.length) tasks.push(renderControlCenterTask('refresh-cw-off', 'bg-rose-100 text-rose-700', text(`${facts.metaFailures.length} Meta sync items need retry`, `${facts.metaFailures.length} عناصر مزامنة ميتا تحتاج إعادة المحاولة`), text('The server keeps retrying; open Ads to inspect the affected rows.', 'يواصل الخادم إعادة المحاولة؛ افتح الإعلانات لمراجعة العناصر المتأثرة.'), `<button type="button" onclick="navigateTo('ads')" class="min-h-11 rounded-xl border border-rose-300 px-4 py-2 text-sm font-bold text-rose-700">${text('Review', 'مراجعة')}</button>`));
  const systemTasks = [];
  if (!meta.webhookConfigured) systemTasks.push(renderControlCenterTask('webhook', 'bg-violet-100 text-violet-700', 'Meta instant notifications need setup', 'Add ALBAYAN_META_WEBHOOK_VERIFY_TOKEN in Jelastic, then subscribe Meta to /api/meta-ads/webhook. Polling remains active until then.'));
  if (Number(monitoring.error_rate || 0) >= 0.05 && Number(monitoring.total_requests || 0) >= 50) systemTasks.push(renderControlCenterTask('server-crash', 'bg-rose-100 text-rose-700', 'Server errors need attention', `${(Number(monitoring.error_rate || 0) * 100).toFixed(1)}% of requests failed in this server process. Check Jelastic logs.`));
  if (Number(monitoring.response_ms_p95 || 0) >= 3000 && Number(monitoring.total_requests || 0) >= 50) systemTasks.push(renderControlCenterTask('timer-off', 'bg-amber-100 text-amber-700', 'Server responses are slow', `The slowest normal requests take about ${Math.round(Number(monitoring.response_ms_p95 || 0))} ms. Check database and container resources.`));
  (operations.setupTasks || []).forEach(task => systemTasks.push(renderControlCenterTask('shield-alert', 'bg-sky-100 text-sky-700', task, 'This protection needs one server setting in Jelastic. No secret is shown in Albayan.')));
  const backupConfigured = backup.enabled && backup.encryptionReady && backup.offsiteConfigured;

  return `
    <div class="management-workspace control-workspace" dir="${isAr ? 'rtl' : 'ltr'}">
      <header class="management-hero">
        <div class="management-hero-copy"><span class="management-eyebrow">${text('Owner workspace', 'مساحة المدير')}</span><h1>${text('Daily Control Center', 'مركز المتابعة اليومي')}</h1><p>${text('Start with what needs attention. Keep money, protection and connections in view.', 'ابدأ بما يحتاج المتابعة، وراقب الأموال والحماية والاتصالات من مكان واحد.')}</p></div>
        <div class="management-hero-side"><span class="management-status ${_controlCenter.error ? 'is-warning' : ''}" role="status"><span aria-hidden="true"></span>${_controlCenter.loading ? text('Checking server…', 'جارٍ فحص الخادم…') : _controlCenter.error ? text('Some checks need review', 'بعض الفحوصات تحتاج مراجعة') : _controlCenter.loadedAt ? text('Checks updated', 'تم تحديث الفحوصات') : text('Waiting for checks', 'بانتظار الفحوصات')}</span><button type="button" onclick="refreshControlCenter()" class="management-button"><i data-lucide="refresh-cw" class="h-4 w-4 ${_controlCenter.loading ? 'animate-spin' : ''}"></i>${text('Refresh checks', 'تحديث الفحوصات')}</button></div>
      </header>

      ${_controlCenter.error ? `<div class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">${Security.escapeHtml(_controlCenter.error)}</div>` : ''}

      <section class="management-metrics" aria-label="${text('At a glance', 'نظرة سريعة')}">
        <button type="button" onclick="controlCenterOpenAds('setup')" class="management-metric"><span class="management-metric-label"><i data-lucide="megaphone" class="h-4 w-4"></i>${text('Ads to finish', 'إعلانات للاستكمال')}</span><strong>${facts.setupAds.length}</strong><span>${text('Complete customer and funding', 'أكمل العميل والتمويل')}</span></button>
        <button type="button" onclick="controlCenterOpenReceipts()" class="management-metric"><span class="management-metric-label"><i data-lucide="receipt" class="h-4 w-4"></i>${text('Unpaid receipts', 'وصولات غير مدفوعة')}</span><strong class="text-rose-600">${facts.unpaidReceipts.length}</strong><span>${text('Review customer collections', 'راجع تحصيل العملاء')}</span></button>
        <button type="button" onclick="navigateTo('analytics')" class="management-metric management-metric-finance"><span class="management-metric-label"><i data-lucide="chart-no-axes-combined" class="h-4 w-4"></i>${text('Known gross profit', 'الربح الإجمالي المعروف')}</span><strong><bdi>${controlCenterMoney(facts.snapshot?.knownGrossProfitLYD)}</bdi><small>LYD</small></strong><span>${text('Based on recorded purchase costs', 'بحسب تكاليف الشراء المسجلة')}</span></button>
        <div class="management-metric"><span class="management-metric-label"><i data-lucide="shield-check" class="h-4 w-4"></i>${text('Protection state', 'حالة الحماية')}</span><strong class="management-metric-word">${backupConfigured ? text('Configured', 'مهيّأة') : text('Setup needed', 'تحتاج إعداداً')}</strong><span>${text('Encryption and off-site backup', 'التشفير والنسخة الخارجية')}</span></div>
      </section>

      <div class="management-control-layout">
      <section class="management-card management-priority-panel"><div class="management-section-heading"><div><span class="management-eyebrow">${text('Start here', 'ابدأ هنا')}</span><h2>${text('Today’s work', 'مهام اليوم')}</h2><p>${text('Customer work and money that need a decision.', 'أعمال العملاء والأموال التي تحتاج قراراً.')}</p></div><span class="management-count">${facts.attentionCount || 0}</span></div><div class="management-priority-list" role="list">${tasks.join('') || `<div class="management-empty"><i data-lucide="circle-check" class="h-9 w-9"></i><h3>${text('No customer tasks waiting', 'لا توجد مهام عملاء معلّقة')}</h3><p>${text('Check the protection and connection panels for server setup tasks.', 'راجع لوحات الحماية والاتصالات لمهام إعداد الخادم.')}</p></div>`}</div><div class="management-quick-links"><button type="button" onclick="navigateTo('ads')" class="management-button">${text('All ads', 'كل الإعلانات')}<i data-lucide="arrow-up-right" class="h-4 w-4"></i></button><button type="button" onclick="navigateTo('analytics')" class="management-button">${text('Open analytics', 'عرض التحليلات')}<i data-lucide="chart-no-axes-combined" class="h-4 w-4"></i></button></div></section>

      <aside class="management-protection-stack" aria-label="${text('Finance and protection', 'الأموال والحماية')}">
        <section class="management-card">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="archive-restore" class="h-5 w-5"></i></span><div><h2>${text('Encrypted backup', 'نسخة احتياطية مشفرة')}</h2><p>${text('Keep a recoverable copy of your work.', 'احتفظ بنسخة يمكن استعادة العمل منها.')}</p></div></div>
          <dl class="management-facts"><div><dt>${text('Last backup', 'آخر نسخة')}</dt><dd>${Security.escapeHtml(controlCenterTimestamp(backup.lastBackupAt))}</dd></div><div><dt>${text('Off-site copy', 'النسخة الخارجية')}</dt><dd>${backup.offsiteConfigured ? text('Connected', 'متصلة') : text('Not connected', 'غير متصلة')}</dd></div></dl>
          ${backup.lastBackupError ? `<div class="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">${Security.escapeHtml(backup.lastBackupError)}</div>` : ''}
          <button type="button" onclick="runControlCenterBackup()" ${backup.enabled && backup.encryptionReady ? '' : 'disabled'} class="management-button is-primary management-full-button">${text('Create encrypted backup now', 'إنشاء نسخة مشفرة الآن')}</button>
        </section>

        <section class="management-card">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="lock-keyhole" class="h-5 w-5"></i></span><div><h2>${text('Monthly financial close', 'الإغلاق المالي الشهري')}</h2><p>${text('Review first, then protect the finished month from accidental edits.', 'راجع الشهر المنتهي ثم احمه من التعديلات غير المقصودة.')}</p></div></div>
          <label for="control-center-period" class="management-field-label">${text('Month', 'الشهر')}</label><input id="control-center-period" type="month" max="${controlCenterPreviousMonth()}" value="${Security.escapeHtml(_controlCenter.period)}" onchange="_controlCenter.period=this.value" class="management-input">
          <div class="management-button-row"><button type="button" onclick="previewControlCenterMonth()" class="management-button">${text('Check month', 'فحص الشهر')}</button><button type="button" onclick="closeControlCenterMonth()" class="management-button is-primary">${text('Close month', 'إغلاق الشهر')}</button></div>
          <div class="management-closed-periods">${closedPeriods.slice(0, 4).map(row => `<div><span><strong>${Security.escapeHtml(row.period || '')}</strong> · ${text('Closed', 'مغلق')}</span><button type="button" onclick="unlockControlCenterMonth('${Security.escapeHtml(String(row.period || ''))}')" class="management-button is-warning">${text('Unlock', 'إعادة الفتح')}</button></div>`).join('') || `<p>${text('No months have been closed yet.', 'لم يُغلق أي شهر بعد.')}</p>`}</div>
        </section>
      </aside>
      </div>

      <section class="management-card"><div class="management-section-heading"><span class="management-section-icon"><i data-lucide="network" class="h-5 w-5"></i></span><div><h2>${text('Live connections', 'الاتصالات المباشرة')}</h2><p>${text('Readiness of the services running behind your workspace.', 'جاهزية الخدمات التي تعمل خلف مساحة العمل.')}</p></div></div><div class="management-connection-grid"><div><span>${text('Meta read connection', 'اتصال قراءة ميتا')}</span><strong class="${meta.configured ? 'text-emerald-600' : 'text-amber-600'}">${meta.configured ? text('Ready', 'جاهز') : text('Needs setup', 'يحتاج إعداداً')}</strong></div><div><span>${text('Instant Meta webhook', 'إشعارات ميتا الفورية')}</span><strong class="${meta.webhookConfigured ? 'text-emerald-600' : 'text-amber-600'}">${meta.webhookConfigured ? text('Ready', 'جاهزة') : text('Polling fallback', 'الفحص الدوري')}</strong></div><div><span>${text('Backup worker', 'عامل النسخ الاحتياطي')}</span><strong class="${backup.workerRunning ? 'text-emerald-600' : 'text-amber-600'}">${backup.workerRunning ? text('Running', 'يعمل') : text('Not running', 'لا يعمل')}</strong></div><div><span>${text('Server health', 'حالة الخادم')}</span><strong class="${Number(monitoring.error_rate || 0) < 0.05 ? 'text-emerald-600' : 'text-rose-600'}">${Number(monitoring.total_requests || 0) ? `${(Number(monitoring.error_rate || 0) * 100).toFixed(1)}% ${text('errors', 'أخطاء')}` : text('Collecting data', 'جارٍ جمع البيانات')}</strong><small>P95 ${Math.round(Number(monitoring.response_ms_p95 || 0))} ms</small></div></div>${systemTasks.length ? `<div class="management-system-tasks" role="list" aria-label="${text('Connection and protection tasks', 'مهام الاتصالات والحماية')}">${systemTasks.join('')}</div>` : ''}</section>

      <div class="management-plan-workspace">${renderPlanManagerSection()}</div>
    </div>`;
}
