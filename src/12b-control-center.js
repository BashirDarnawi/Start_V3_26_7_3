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
  try { return new Date(number).toLocaleString(); } catch (_) { return 'Never'; }
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
  const metaFailures = ads.filter(ad => String(ad.metaSyncErrorCode || ad.metaLastErrorCode || '').trim());
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
      `Receipts: $${controlCenterMoney(totals.receiptVolumeUSD)}`,
      `Ad sales: $${controlCenterMoney(totals.adSalesUSD)}`,
      `Meta spend: $${controlCenterMoney(totals.metaSpendUSD)}`,
      blockers.length ? `Problems to review: ${blockers.map(item => `${item.message} (${item.count})`).join(', ')}` : 'No closing problems found.'
    ].join('\n');
    window.alert(message);
  } catch (error) {
    showNotification('Month check failed', String(error?.message || error), 'error');
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
      forceReason = window.prompt(`This month has items to review:\n${blockerText}\n\nFix them first, or type a clear reason (at least 10 characters) to close anyway:`) || '';
      if (forceReason.trim().length < 10) return;
    } else if (!window.confirm(`Close ${period}? After closing, its receipts, ads, and dollar purchases cannot be changed.`)) return;
    await apiCloseFinancialPeriod(period, forceReason);
    showNotification('Month closed safely', `${period} is now protected from changes.`, 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification('Could not close month', String(error?.message || error), 'error');
  }
}

async function unlockControlCenterMonth(period) {
  const reason = window.prompt(`Why must ${period} be unlocked? This action is recorded in the audit log.`) || '';
  if (reason.trim().length < 10) {
    showNotification('Reason required', 'Please write at least 10 characters.', 'warning');
    return;
  }
  try {
    await apiUnlockFinancialPeriod(period, reason);
    showNotification('Month unlocked', `${period} can be corrected now. Close it again when finished.`, 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification('Could not unlock month', String(error?.message || error), 'error');
  }
}

async function runControlCenterBackup() {
  try {
    showNotification('Backup started', 'Please keep this page open while the server creates the encrypted copy.', 'info');
    const response = await apiRunEncryptedBackup();
    showNotification('Backup complete', response?.backup?.offsite ? 'Encrypted backup saved locally and off-site.' : 'Encrypted backup saved.', 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    showNotification('Backup failed', String(error?.message || error), 'error');
  }
}

function renderControlCenterTask(icon, color, title, detail, actionHtml = '') {
  return `
    <div class="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-700 dark:bg-slate-900/50 sm:flex-row sm:items-center">
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${color}"><i data-lucide="${icon}" class="h-5 w-5"></i></span>
        <div class="min-w-0"><div class="font-bold text-slate-900 dark:text-white">${Security.escapeHtml(title)}</div><div class="mt-1 text-sm text-slate-500 dark:text-slate-400">${Security.escapeHtml(detail)}</div></div>
      </div>
      ${actionHtml}
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
  if (field === 'priceLYD') plan.priceMinor = Math.max(0, Math.round((Number(String(value).replace(',', '.')) || 0) * 100));
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
    showNotification('Missing details', 'A bundle needs an id, both names, and at least one service.', 'warning');
    return;
  }
  if (_planManager.plans.some(p => String(p.id) === rawId)) {
    showNotification('Duplicate id', 'A plan with this id already exists.', 'warning');
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
    })));
    _planManager.version = Number(payload?.version || _planManager.version + 1);
    _planManager.dirty = false;
    _planManager.loadedAt = 0;
    showNotification('Plans saved', `Catalog version ${_planManager.version} is live — new purchases use it immediately.`, 'success');
    if (typeof refreshSubscriptionPlans === 'function') refreshSubscriptionPlans(true).catch(() => {});
    loadPlanManager(true);
  } catch (error) {
    const detail = (error?.payload && error.payload.detail) ? error.payload.detail : (error?.message || 'Save failed');
    showNotification('Could not save plans', String(detail), 'error');
  }
}

function renderPlanManagerSection() {
  if (!isServerModeEnabled()) return '';
  const rows = _planManager.plans.map((plan, index) => {
    const safeName = Security.escapeHtml(String(plan.name || plan.id));
    const services = (Array.isArray(plan.serviceIds) ? plan.serviceIds : []).join(' + ');
    return `
      <div class="grid grid-cols-2 items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800 sm:grid-cols-[1.2fr_1fr_90px_80px_70px_70px]">
        <div class="min-w-0">
          <input value="${safeName}" oninput="planManagerSetField(${index}, 'name', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 font-bold text-slate-800 focus:border-indigo-300 dark:text-white" />
          <input value="${Security.escapeHtml(String(plan.nameAr || ''))}" dir="rtl" oninput="planManagerSetField(${index}, 'nameAr', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 text-xs text-slate-500 focus:border-indigo-300" />
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
  if (facts.setupAds.length) tasks.push(renderControlCenterTask('wand-sparkles', 'bg-amber-100 text-amber-700', `${facts.setupAds.length} ads need setup`, 'Add the customer, selling amount, payment, and receipt.', '<button type="button" onclick="controlCenterOpenAds(\'setup\')" class="min-h-11 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white">Open ads</button>'));
  if (facts.unpaidReceipts.length) tasks.push(renderControlCenterTask('receipt', 'bg-rose-100 text-rose-700', `${facts.unpaidReceipts.length} receipts are unpaid`, 'Review money that customers still owe.', '<button type="button" onclick="controlCenterOpenReceipts()" class="min-h-11 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white">Open receipts</button>'));
  if ((facts.snapshot?.unpricedSpendUSD || 0) > 0.005) tasks.push(renderControlCenterTask('circle-dollar-sign', 'bg-rose-100 text-rose-700', `$${controlCenterMoney(facts.snapshot.unpricedSpendUSD)} Meta spend has no purchase cost`, 'Record the real dollar purchase so profit is not guessed.', '<button type="button" onclick="navigateTo(\'analytics\')" class="min-h-11 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white">Fix profit data</button>'));
  if (facts.metaFailures.length) tasks.push(renderControlCenterTask('refresh-cw-off', 'bg-rose-100 text-rose-700', `${facts.metaFailures.length} Meta sync items need retry`, 'The server keeps retrying; open Ads to inspect the affected rows.', '<button type="button" onclick="navigateTo(\'ads\')" class="min-h-11 rounded-xl border border-rose-300 px-4 py-2 text-sm font-bold text-rose-700">Review</button>'));
  if (!meta.webhookConfigured) tasks.push(renderControlCenterTask('webhook', 'bg-violet-100 text-violet-700', 'Meta instant notifications need setup', 'Add ALBAYAN_META_WEBHOOK_VERIFY_TOKEN in Jelastic, then subscribe Meta to /api/meta-ads/webhook. Polling remains active until then.'));
  if (Number(monitoring.error_rate || 0) >= 0.05 && Number(monitoring.total_requests || 0) >= 50) tasks.push(renderControlCenterTask('server-crash', 'bg-rose-100 text-rose-700', 'Server errors need attention', `${(Number(monitoring.error_rate || 0) * 100).toFixed(1)}% of requests failed in this server process. Check Jelastic logs.`));
  if (Number(monitoring.response_ms_p95 || 0) >= 3000 && Number(monitoring.total_requests || 0) >= 50) tasks.push(renderControlCenterTask('timer-off', 'bg-amber-100 text-amber-700', 'Server responses are slow', `The slowest normal requests take about ${Math.round(Number(monitoring.response_ms_p95 || 0))} ms. Check database and container resources.`));
  (operations.setupTasks || []).forEach(task => tasks.push(renderControlCenterTask('shield-alert', 'bg-sky-100 text-sky-700', task, 'This protection needs one server setting in Jelastic. No secret is shown in Albayan.')));
  if (!tasks.length && !_controlCenter.loading) tasks.push(renderControlCenterTask('badge-check', 'bg-emerald-100 text-emerald-700', 'Everything important is ready', 'No unfinished ads, profit gaps, sync failures, or operations setup problems were found.'));

  return `
    <div class="space-y-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><div class="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Owner workspace</div><h1 class="mt-1 text-3xl font-black text-slate-900 dark:text-white">Daily Control Center</h1><p class="mt-1 text-slate-500 dark:text-slate-400">One page shows what needs your attention today.</p></div>
        <button type="button" onclick="refreshControlCenter()" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-4 py-2 font-bold text-indigo-700 dark:border-indigo-800 dark:bg-slate-900 dark:text-indigo-300"><i data-lucide="refresh-cw" class="h-4 w-4 ${_controlCenter.loading ? 'animate-spin' : ''}"></i>Refresh checks</button>
      </div>

      ${_controlCenter.error ? `<div class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">${Security.escapeHtml(_controlCenter.error)}</div>` : ''}

      <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button type="button" onclick="controlCenterOpenAds('setup')" class="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left dark:border-amber-900 dark:bg-amber-950/30"><div class="text-sm text-amber-700">Ads to finish</div><div class="mt-1 text-3xl font-black text-amber-900 dark:text-amber-200">${facts.setupAds.length}</div></button>
        <button type="button" onclick="controlCenterOpenReceipts()" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-left dark:border-rose-900 dark:bg-rose-950/30"><div class="text-sm text-rose-700">Unpaid receipts</div><div class="mt-1 text-3xl font-black text-rose-900 dark:text-rose-200">${facts.unpaidReceipts.length}</div></button>
        <button type="button" onclick="navigateTo('analytics')" class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left dark:border-emerald-900 dark:bg-emerald-950/30"><div class="text-sm text-emerald-700">Known gross profit</div><div class="mt-1 text-xl font-black text-emerald-900 dark:text-emerald-200">${controlCenterMoney(facts.snapshot?.knownGrossProfitLYD)} LYD</div></button>
        <div class="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/30"><div class="text-sm text-indigo-700">Protection state</div><div class="mt-1 text-lg font-black text-indigo-900 dark:text-indigo-200">${backup.enabled && backup.encryptionReady && backup.offsiteConfigured ? 'Protected' : 'Setup needed'}</div></div>
      </section>

      <section class="glass-panel rounded-3xl p-5 sm:p-6"><div class="mb-4 flex items-center justify-between"><div><h2 class="text-xl font-black text-slate-900 dark:text-white">Today’s work</h2><p class="text-sm text-slate-500">Do the first item, then continue downward.</p></div><span class="rounded-full px-3 py-1 text-sm font-bold ${facts.attentionCount ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}">${facts.attentionCount || 0} data items</span></div><div class="space-y-3">${tasks.join('')}</div></section>

      <div class="grid gap-6 lg:grid-cols-2">
        <section class="glass-panel rounded-3xl p-5 sm:p-6">
          <div class="flex items-center gap-2"><i data-lucide="archive-restore" class="h-5 w-5 text-sky-600"></i><h2 class="text-xl font-black text-slate-900 dark:text-white">Encrypted backup</h2></div>
          <div class="mt-4 grid grid-cols-2 gap-3 text-sm"><div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><div class="text-slate-500">Last backup</div><div class="mt-1 font-bold">${Security.escapeHtml(controlCenterTimestamp(backup.lastBackupAt))}</div></div><div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><div class="text-slate-500">Off-site copy</div><div class="mt-1 font-bold">${backup.offsiteConfigured ? 'Connected' : 'Not connected'}</div></div></div>
          ${backup.lastBackupError ? `<div class="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">${Security.escapeHtml(backup.lastBackupError)}</div>` : ''}
          <button type="button" onclick="runControlCenterBackup()" ${backup.enabled && backup.encryptionReady ? '' : 'disabled'} class="mt-4 min-h-11 w-full rounded-xl bg-sky-600 px-4 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">Create encrypted backup now</button>
        </section>

        <section class="glass-panel rounded-3xl p-5 sm:p-6">
          <div class="flex items-center gap-2"><i data-lucide="lock-keyhole" class="h-5 w-5 text-indigo-600"></i><h2 class="text-xl font-black text-slate-900 dark:text-white">Monthly financial close</h2></div>
          <p class="mt-2 text-sm text-slate-500">Check a finished month, then lock it so old money cannot change by mistake.</p>
          <label class="mt-4 block text-sm font-bold text-slate-700 dark:text-slate-300">Month</label><input id="control-center-period" type="month" max="${controlCenterPreviousMonth()}" value="${Security.escapeHtml(_controlCenter.period)}" onchange="_controlCenter.period=this.value" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
          <div class="mt-3 grid grid-cols-2 gap-3"><button type="button" onclick="previewControlCenterMonth()" class="min-h-11 rounded-xl border border-indigo-300 px-3 font-bold text-indigo-700">Check month</button><button type="button" onclick="closeControlCenterMonth()" class="min-h-11 rounded-xl bg-indigo-600 px-3 font-bold text-white">Close month</button></div>
          <div class="mt-4 space-y-2">${closedPeriods.slice(0, 4).map(row => `<div class="flex items-center justify-between rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800"><span><strong>${Security.escapeHtml(row.period || '')}</strong> · Closed</span><button type="button" onclick="unlockControlCenterMonth('${Security.escapeHtml(String(row.period || ''))}')" class="min-h-10 rounded-lg px-3 font-bold text-amber-700">Unlock</button></div>`).join('') || '<div class="text-sm text-slate-500">No months have been closed yet.</div>'}</div>
        </section>
      </div>

      ${renderPlanManagerSection()}

      <section class="glass-panel rounded-3xl p-5 sm:p-6"><h2 class="text-xl font-black text-slate-900 dark:text-white">Live connections</h2><div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div class="rounded-2xl bg-slate-100 p-4 dark:bg-slate-800"><div class="text-sm text-slate-500">Meta read connection</div><div class="mt-1 font-black ${meta.configured ? 'text-emerald-600' : 'text-amber-600'}">${meta.configured ? 'Ready' : 'Needs setup'}</div></div><div class="rounded-2xl bg-slate-100 p-4 dark:bg-slate-800"><div class="text-sm text-slate-500">Instant Meta webhook</div><div class="mt-1 font-black ${meta.webhookConfigured ? 'text-emerald-600' : 'text-amber-600'}">${meta.webhookConfigured ? 'Ready' : 'Polling fallback'}</div></div><div class="rounded-2xl bg-slate-100 p-4 dark:bg-slate-800"><div class="text-sm text-slate-500">Backup worker</div><div class="mt-1 font-black ${backup.workerRunning ? 'text-emerald-600' : 'text-amber-600'}">${backup.workerRunning ? 'Running' : 'Not running'}</div></div><div class="rounded-2xl bg-slate-100 p-4 dark:bg-slate-800"><div class="text-sm text-slate-500">Server health</div><div class="mt-1 font-black ${Number(monitoring.error_rate || 0) < 0.05 ? 'text-emerald-600' : 'text-rose-600'}">${Number(monitoring.total_requests || 0) ? `${(Number(monitoring.error_rate || 0) * 100).toFixed(1)}% errors` : 'Collecting data'}</div><div class="mt-1 text-xs text-slate-500">P95 ${Math.round(Number(monitoring.response_ms_p95 || 0))} ms</div></div></div></section>
    </div>`;
}
