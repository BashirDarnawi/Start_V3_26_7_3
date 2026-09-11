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
    })), _planManager.version);
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
// ==========================================
// MERGE TOOLS — one real page, one real ad
// ==========================================
// The Meta import leaves two kinds of doubles behind, and both were previously
// dead ends: showPageDuplicates could only LIST repeated pages, and an imported
// draft that described an ad the staff had already recorded by hand could only
// be completed a second time or thrown away.
//
//  1. PAGE: the row someone typed by hand before the import existed, beside the
//     row the Meta sync created. Only the Meta row carries metaPageId, which is
//     the identity the server writes to, so the hand-made row is always the one
//     that gives up its ads and goes. The opposite direction would strand every
//     future imported ad on a fresh page row and re-create the duplicate
//     immediately (server/meta_ads.py only re-points an imported ad at its own
//     Meta-derived page, and _ensure_import_page only looks at live pages).
//
//  2. AD: the ad the staff recorded with the customer's money, beside the empty
//     draft the importer created for the same Meta ad. Combining them is really
//     a RE-LINK: the Meta identity moves onto the record that holds the money,
//     and the empty draft is removed.
//
// Neither flow moves money. Both are built only out of writes the server
// already accepts on their own: ad.pageId is an ordinary relationship field,
// and the Meta link travels through the existing transactional
// /api/meta-ads/ads/{id}/unlink + /link endpoints, which are the only writers
// allowed to move a metaAdId. Nothing here PATCHes a server-controlled meta*
// field, so no new backend surface is required.
//
// Both flows are also re-runnable on purpose. They do the harmless work first
// and remove the losing record LAST, so a connection that drops halfway leaves
// a visibly unfinished merge that finishes correctly when repeated — never a
// half-deleted one.

// Guards the two dialogs against a double submit (and against a second merge
// starting while the first is still writing).
let _mergeToolsBusy = '';
let _pageMergeReturnFocus = null;
let _adMergeReturnFocus = null;
let _mergeAllReturnFocus = null;

function isMergeToolsAdmin() {
  return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
}

function getPageMetaIdValue(page) {
  return String(page?.metaPageId || '').trim();
}

// ------------------------------------------------------------------
// 1. Merge a hand-made page into the Meta page with the same name
// ------------------------------------------------------------------

// Same grouping key the duplicate finder and the category picker already use
// (Arabic hamza/ة/ى folding, tashkeel stripped, digits folded, spaces
// collapsed), so "حج وعمرة" and "حج وعمره" land in one group here too.
function findPageMergeGroups(pages = getPagesVisibleToCurrentUser()) {
  const active = getVisibleRecords(Array.isArray(pages) ? pages : [])
    .filter(page => page && !page._deleted && page.id);
  const groups = new Map();
  for (const page of active) {
    const key = pageCategoryKey(page.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  const mergeable = [];
  for (const group of groups.values()) {
    const metaPages = group.filter(page => getPageMetaIdValue(page));
    const manualPages = group.filter(page => !getPageMetaIdValue(page));
    // Exactly one Meta row is the only unambiguous case. Two Meta rows for one
    // name is a different problem (two real Facebook pages, or a server-side
    // import bug) and must not be guessed at here.
    if (metaPages.length !== 1 || manualPages.length === 0) continue;
    mergeable.push({ keepPage: metaPages[0], manualPages });
  }
  return mergeable.sort((a, b) => String(a.keepPage?.name || '').localeCompare(String(b.keepPage?.name || '')));
}

function countPageMergeGroups() {
  return isMergeToolsAdmin() ? findPageMergeGroups().length : 0;
}

// Everything the dialog needs, plus the single reason a merge is refused.
// Recomputed immediately before the write so a dialog left open on a stale
// screen cannot merge something that changed underneath it.
function getPageMergePlan(keepPageId, losePageId) {
  const isAr = state.language === 'ar';
  const pages = getVisibleRecords(state.pages);
  const keepPage = pages.find(page => String(page.id) === String(keepPageId || '')) || null;
  const losePage = pages.find(page => String(page.id) === String(losePageId || '')) || null;
  const plan = { keepPage, losePage, ads: [], blocked: '' };
  if (!keepPage || !losePage) {
    plan.blocked = isAr ? 'إحدى الصفحتين لم تعد موجودة. حدّث الصفحة وحاول مرة أخرى.' : 'One of the two pages no longer exists. Refresh and try again.';
    return plan;
  }
  if (String(keepPage.id) === String(losePage.id)) {
    plan.blocked = isAr ? 'اختر صفحتين مختلفتين.' : 'Choose two different pages.';
    return plan;
  }
  if (!getPageMetaIdValue(keepPage)) {
    plan.blocked = isAr ? 'الصفحة الباقية يجب أن تكون صفحة Meta.' : 'The surviving page must be the Meta page.';
    return plan;
  }
  if (getPageMetaIdValue(losePage)) {
    plan.blocked = isAr ? 'لا يمكن دمج صفحة Meta في صفحة أخرى. تُدمج الصفحة اليدوية فقط.' : 'A Meta page cannot be merged away. Only the hand-made page is merged.';
    return plan;
  }
  if (pageCategoryKey(keepPage.name) !== pageCategoryKey(losePage.name)) {
    plan.blocked = isAr ? 'الصفحتان ليس لهما نفس الاسم.' : 'The two pages do not share the same name.';
    return plan;
  }
  plan.ads = getAdsForPage(losePage.id);
  return plan;
}

function closePageMergeDialog(restoreFocus = true) {
  document.getElementById('page-merge-dialog')?.remove();
  const target = _pageMergeReturnFocus?.isConnected === false ? null : _pageMergeReturnFocus;
  _pageMergeReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

function showPageMergeDialog(keepPageId, losePageId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }
  closePageMergeDialog(false);
  _pageMergeReturnFocus = triggerButton || document.activeElement;

  const adCount = plan.ads.length;
  const keepAdCount = getAdsForPage(plan.keepPage.id).length;
  const customersById = new Map((state.customers || []).map(customer => [String(customer.id), customer]));
  const describeOwners = page => getPageCustomerIds(page)
    .map(id => customersById.get(String(id))?.name || '')
    .filter(Boolean).join(', ');
  const loseOwners = describeOwners(plan.losePage);
  const keepOwners = describeOwners(plan.keepPage);
  const movedOwners = getPageCustomerIds(plan.losePage)
    .map(String)
    .filter(id => !getPageCustomerIds(plan.keepPage).map(String).includes(id));

  const dialog = document.createElement('div');
  dialog.id = 'page-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'page-merge-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-2xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="flex items-start gap-3 min-w-0">
          <span class="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
            <i data-lucide="combine" class="w-6 h-6"></i>
          </span>
          <div class="min-w-0">
            <h2 id="page-merge-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${isAr ? 'دمج الصفحة القديمة في صفحة Meta' : 'Merge the old page into the Meta page'}</h2>
            <p class="text-sm text-slate-500 break-words">${isAr ? 'تنتقل كل الإعلانات إلى صفحة Meta، ولا يتغير أي مبلغ.' : 'Every ad moves to the Meta page. No money changes.'}</p>
          </div>
        </div>
        <button type="button" onclick="closePageMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
        <div class="grid gap-3 md:grid-cols-2">
          <section class="rounded-xl border-2 border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">${isAr ? 'ستُزال' : 'Will be removed'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(plan.losePage.name || '')}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300 break-words">
              ${Security.escapeHtml(plan.losePage.category || (isAr ? 'بدون فئة' : 'No category'))}
              ${loseOwners ? ` • ${Security.escapeHtml(loseOwners)}` : ` • ${isAr ? 'بدون مالك' : 'No owner'}`}
            </div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">
              ${isAr ? `${adCount} إعلان سينتقل` : `${adCount} ad${adCount === 1 ? '' : 's'} will move`}
            </div>
          </section>
          <section class="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">${isAr ? 'ستبقى' : 'Will be kept'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(plan.keepPage.name || '')}</div>
            <div class="mt-1 font-mono text-[11px] text-slate-500 break-all">#${Security.escapeHtml(getPageMetaIdValue(plan.keepPage))}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300 break-words">
              ${Security.escapeHtml(plan.keepPage.category || (isAr ? 'بدون فئة' : 'No category'))}
              ${keepOwners ? ` • ${Security.escapeHtml(keepOwners)}` : ` • ${isAr ? 'بدون مالك' : 'No owner'}`}
            </div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">
              ${isAr ? `${keepAdCount} إعلان الآن` : `${keepAdCount} ad${keepAdCount === 1 ? '' : 's'} today`}
            </div>
          </section>
        </div>

        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <div class="font-bold text-slate-800 dark:text-white">${isAr ? 'ماذا سيحدث' : 'What will happen'}</div>
          <div>• ${isAr ? `تنتقل ${adCount} إعلان إلى صفحة Meta.` : `${adCount} ad${adCount === 1 ? '' : 's'} move to the Meta page.`}</div>
          ${movedOwners.length ? `<div>• ${isAr ? 'يُضاف مالك الصفحة القديمة إلى صفحة Meta.' : 'The old page owner is added to the Meta page.'}</div>` : ''}
          <div>• ${isAr ? 'تُحذف الصفحة القديمة بعد انتقال كل إعلان.' : 'The old page is removed after every ad has moved.'}</div>
          <div>• ${isAr ? 'لا يتغير أي مبلغ أو وصل أو صورة.' : 'No amount, receipt or photo changes.'}</div>
        </div>
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4 flex flex-col sm:flex-row gap-2">
        <button type="button" id="page-merge-confirm" onclick="runPageMerge('${Security.escapeHtml(String(plan.keepPage.id))}','${Security.escapeHtml(String(plan.losePage.id))}')" class="flex-1 btn-shine bg-amber-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-amber-700 min-h-11">
          <i data-lucide="combine" class="w-4 h-4 inline mr-2"></i>${isAr ? 'دمج الآن' : 'Merge now'}
        </button>
        <button type="button" onclick="closePageMergeDialog()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closePageMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

async function runPageMerge(keepPageId, losePageId) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  if (_mergeToolsBusy) return;
  // Re-checked against live state, not against what the dialog was drawn from.
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }

  _mergeToolsBusy = 'page';
  const confirmButton = document.getElementById('page-merge-confirm');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = isAr ? 'جارٍ الدمج…' : 'Merging…';
  }

  try {
    const result = await _mergeOnePageIntoMeta(keepPageId, losePageId);
    if (result.ok) {
      showNotification(
        isAr ? 'تم الدمج' : 'Merged',
        isAr
          ? `تم نقل ${result.moved} إعلان إلى «${result.keepName}» وحُذفت الصفحة القديمة.`
          : `${result.moved} ad${result.moved === 1 ? '' : 's'} moved to "${result.keepName}" and the old page was removed.`,
        'success'
      );
    } else {
      showNotification(isAr ? 'لم يكتمل الدمج' : 'Merge did not finish', result.reason, 'warning');
    }
  } catch (error) {
    showNotification(
      isAr ? 'تعذّر الدمج' : 'Merge failed',
      error?.message || (isAr ? 'حدث خطأ أثناء الدمج. أعد المحاولة.' : 'Something went wrong during the merge. Try again.'),
      'error'
    );
  } finally {
    _mergeToolsBusy = '';
    closePageMergeDialog(false);
    closePageDuplicatesDialog(false);
    render();
  }
}

// The write sequence for ONE page. Returns a plain result instead of showing a
// toast, so merging 48 pages can report once at the end instead of 48 times.
// Order is the safety property: every ad lands on the Meta page BEFORE the old
// page is removed, so an interrupted run is always safe to repeat.
async function _mergeOnePageIntoMeta(keepPageId, losePageId) {
  const isAr = state.language === 'ar';
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) return { ok: false, moved: 0, total: 0, name: '', keepName: '', reason: plan.blocked };
  const name = String(plan.losePage.name || '');
  const keepName = String(plan.keepPage.name || '');
  let moved = 0;

  for (const ad of plan.ads) {
    const updates = { pageId: String(plan.keepPage.id) };
    // Only refresh the denormalised copy when the ad actually carries one —
    // writing it onto rows that never had it would invent a new field.
    if (String(ad.pageName || '').trim()) updates.pageName = keepName;
    const expected = Number(ad._lastModified);
    const saved = await updateRecord(state.ads, ad.id, updates, Number.isFinite(expected) ? expected : undefined);
    if (!saved) {
      return {
        ok: false, moved, total: plan.ads.length, name, keepName,
        reason: isAr
          ? `«${name}»: تم نقل ${moved} من ${plan.ads.length} إعلان. لم تُحذف الصفحة القديمة، أعد المحاولة لإكمال الباقي.`
          : `"${name}": ${moved} of ${plan.ads.length} ads moved. The old page was kept — run it again to finish the rest.`
      };
    }
    moved += 1;
  }

  // Carry the hand-made page's owner across. An imported page arrives with no
  // owner at all, so this is usually the only place that knowledge exists.
  const keepOwnerIds = getPageCustomerIds(plan.keepPage).map(String);
  const addedOwnerIds = getPageCustomerIds(plan.losePage).map(String).filter(id => !keepOwnerIds.includes(id));
  if (addedOwnerIds.length) {
    const keepExpected = Number(plan.keepPage._lastModified);
    await updateRecord(
      state.pages,
      plan.keepPage.id,
      { customerIds: [...keepOwnerIds, ...addedOwnerIds] },
      Number.isFinite(keepExpected) ? keepExpected : undefined
    );
  }

  const removed = await deleteRecord(state.pages, plan.losePage.id);
  if (!removed) {
    return {
      ok: false, moved, total: plan.ads.length, name, keepName,
      reason: isAr
        ? `«${name}»: انتقلت كل الإعلانات، لكن تعذّر حذف الصفحة القديمة. احذفها يدوياً.`
        : `"${name}": every ad moved, but the old page could not be removed. Delete it by hand.`
    };
  }
  return { ok: true, moved, total: plan.ads.length, name, keepName, reason: '' };
}

// ---- Merge every duplicate in one run -----------------------------------
// 48 groups is far too many to confirm one at a time. This does the identical
// per-page work in a loop, keeps going when one page fails (one bad page must
// not block the other 47), and can be stopped between pages.

let _mergeAllStopRequested = false;

function stopAllPageMerges() {
  _mergeAllStopRequested = true;
  const button = document.getElementById('merge-all-stop');
  if (button) button.textContent = state.language === 'ar' ? 'جارٍ الإيقاف…' : 'Stopping…';
}

// Every (Meta page <- hand-made page) move that is currently possible, flattened
// out of the groups so a group holding three hand-made rows contributes three.
function buildAllPageMergeJobs() {
  const jobs = [];
  if (!isMergeToolsAdmin()) return jobs;
  for (const group of findPageMergeGroups()) {
    for (const losePage of group.manualPages) {
      jobs.push({
        keepId: String(group.keepPage.id),
        loseId: String(losePage.id),
        name: String(losePage.name || ''),
        ads: getAdsForPage(losePage.id).length
      });
    }
  }
  return jobs;
}

function closeMergeAllDialog(restoreFocus = true) {
  document.getElementById('merge-all-dialog')?.remove();
  const target = _mergeAllReturnFocus?.isConnected === false ? null : _mergeAllReturnFocus;
  _mergeAllReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

function showMergeAllDialog(triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  const jobs = buildAllPageMergeJobs();
  if (!jobs.length) {
    showNotification(isAr ? 'لا يوجد ما يُدمج' : 'Nothing to merge', isAr ? 'لا توجد صفحة يدوية لها صفحة Meta بنفس الاسم.' : 'No hand-made page has a Meta page of the same name.', 'success');
    return;
  }
  closeMergeAllDialog(false);
  _mergeAllReturnFocus = triggerButton || document.activeElement;
  const totalAds = jobs.reduce((sum, job) => sum + job.ads, 0);

  const dialog = document.createElement('div');
  dialog.id = 'merge-all-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[96] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'merge-all-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-lg max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700 flex items-start gap-3">
        <span class="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
          <i data-lucide="layers" class="w-6 h-6"></i>
        </span>
        <div class="min-w-0">
          <h2 id="merge-all-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${isAr ? 'دمج كل الصفحات المكررة' : 'Merge every duplicate page'}</h2>
          <p class="text-sm text-slate-500 break-words">${isAr ? 'يتم تنفيذها واحدة بعد الأخرى، ويمكنك الإيقاف في أي وقت.' : 'Done one after another. You can stop at any point.'}</p>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3">
        <div class="grid grid-cols-2 gap-3 text-center">
          <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
            <div class="text-2xl font-bold text-slate-800 dark:text-white">${jobs.length}</div>
            <div class="text-xs text-slate-500">${isAr ? 'صفحة قديمة ستُزال' : 'old pages removed'}</div>
          </div>
          <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
            <div class="text-2xl font-bold text-slate-800 dark:text-white">${totalAds}</div>
            <div class="text-xs text-slate-500">${isAr ? 'إعلان سينتقل' : 'ads will move'}</div>
          </div>
        </div>
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <div>• ${isAr ? 'لا يتغير أي مبلغ أو وصل أو صورة.' : 'No amount, receipt or photo changes.'}</div>
          <div>• ${isAr ? 'كل صفحة تُحذف فقط بعد انتقال كل إعلاناتها.' : 'Each page is removed only after all of its ads have moved.'}</div>
          <div>• ${isAr ? 'إذا فشلت صفحة، تستمر البقية وتظهر لك قائمة بما لم يكتمل.' : 'If one page fails the rest continue, and you get a list of what did not finish.'}</div>
        </div>
        <div id="merge-all-progress" class="hidden rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 text-sm font-bold text-slate-700 dark:text-slate-200" role="status" aria-live="polite"></div>
        <div id="merge-all-report" class="hidden rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200 space-y-1 max-h-48 overflow-y-auto"></div>
      </div>
      <div class="p-4 border-t border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row gap-2">
        <button type="button" id="merge-all-start" onclick="runAllPageMerges()" class="flex-1 btn-shine bg-amber-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-amber-700 min-h-11">
          <i data-lucide="layers" class="w-4 h-4 inline mr-2"></i>${isAr ? `دمج الكل (${jobs.length})` : `Merge all (${jobs.length})`}
        </button>
        <button type="button" id="merge-all-stop" onclick="stopAllPageMerges()" class="hidden flex-1 bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200 px-4 py-3 rounded-xl font-bold min-h-11">${isAr ? 'إيقاف' : 'Stop'}</button>
        <button type="button" id="merge-all-close" onclick="closeMergeAllDialog()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog && !_mergeToolsBusy) closeMergeAllDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

async function runAllPageMerges() {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  if (_mergeToolsBusy) return;
  const jobs = buildAllPageMergeJobs();
  if (!jobs.length) {
    showNotification(isAr ? 'لا يوجد ما يُدمج' : 'Nothing to merge', isAr ? 'لا توجد صفحة يدوية لها صفحة Meta بنفس الاسم.' : 'No hand-made page has a Meta page of the same name.', 'success');
    return;
  }

  _mergeToolsBusy = 'page-all';
  _mergeAllStopRequested = false;
  const startButton = document.getElementById('merge-all-start');
  const stopButton = document.getElementById('merge-all-stop');
  const closeButton = document.getElementById('merge-all-close');
  const progress = document.getElementById('merge-all-progress');
  if (startButton) startButton.classList.add('hidden');
  if (closeButton) closeButton.classList.add('hidden');
  if (stopButton) stopButton.classList.remove('hidden');
  if (progress) progress.classList.remove('hidden');

  let done = 0;
  let movedAds = 0;
  const problems = [];
  try {
    for (const job of jobs) {
      if (_mergeAllStopRequested) break;
      if (progress) {
        progress.textContent = isAr
          ? `جارٍ الدمج ${done + 1} من ${jobs.length}: ${job.name}`
          : `Merging ${done + 1} of ${jobs.length}: ${job.name}`;
      }
      let result;
      try {
        result = await _mergeOnePageIntoMeta(job.keepId, job.loseId);
      } catch (error) {
        result = { ok: false, moved: 0, reason: `"${job.name}": ${error?.message || 'unexpected error'}` };
      }
      // One page failing must never stop the other 47 — collect and carry on.
      if (result.ok) {
        done += 1;
        movedAds += result.moved;
      } else {
        problems.push(result.reason);
      }
    }
  } finally {
    _mergeToolsBusy = '';
    _mergeAllStopRequested = false;
    if (stopButton) stopButton.classList.add('hidden');
    if (closeButton) closeButton.classList.remove('hidden');
    if (progress) {
      progress.textContent = isAr
        ? `تم دمج ${done} صفحة ونقل ${movedAds} إعلان.`
        : `Merged ${done} page${done === 1 ? '' : 's'} and moved ${movedAds} ad${movedAds === 1 ? '' : 's'}.`;
    }
    const report = document.getElementById('merge-all-report');
    if (report && problems.length) {
      report.classList.remove('hidden');
      report.innerHTML = `<div class="font-bold">${isAr ? `${problems.length} لم تكتمل:` : `${problems.length} did not finish:`}</div>`
        + problems.map(text => `<div>• ${Security.escapeHtml(String(text))}</div>`).join('');
    }
    showNotification(
      problems.length ? (isAr ? 'اكتمل الدمج جزئياً' : 'Merged with some left over') : (isAr ? 'تم دمج الكل' : 'All merged'),
      isAr
        ? `تم دمج ${done} صفحة ونقل ${movedAds} إعلان.${problems.length ? ` ${problems.length} لم تكتمل.` : ''}`
        : `Merged ${done} page${done === 1 ? '' : 's'} and moved ${movedAds} ad${movedAds === 1 ? '' : 's'}.${problems.length ? ` ${problems.length} did not finish.` : ''}`,
      problems.length ? 'warning' : 'success'
    );
    closePageDuplicatesDialog(false);
    render();
  }
}

// ------------------------------------------------------------------
// 2. Link a hand-made ad to the Meta draft that describes the same ad
// ------------------------------------------------------------------

// A row is "imported" when the automation made it, whatever its current link
// state. Used to tell the two sides of a pair apart.
function isImportedMetaAd(ad) {
  return !!ad && (
    !!String(ad.metaImportState || '').trim()
    || !!String(ad.metaImportedAt || '').trim()
    || !!String(ad.metaImportSource || '').trim()
  );
}

// Every way this ad names a page, so the two sides can be recognised as the
// same page even while the manual ad still points at the old page record and
// the draft already points at the Meta one.
function _adPageMergeKeys(ad, pagesById) {
  const keys = new Set();
  const pageId = String(ad?.pageId || '').trim();
  const page = !pageId
    ? null
    : (pagesById
      ? (pagesById.get(pageId) || null)
      : ((state.pages || []).find(item => item && !item._deleted && String(item.id) === pageId) || null));
  if (pageId) keys.add(`id:${pageId}`);
  const metaPageId = String(ad?.metaPageId || page?.metaPageId || '').trim();
  if (metaPageId) keys.add(`meta:${metaPageId}`);
  const rawName = String(page?.name || ad?.pageName || ad?.metaPageName || '').trim();
  // "Facebook Page 1234…" is the importer's stand-in, not a name. Matching on it
  // would pair two unrelated ads that are both waiting for their real name.
  if (rawName && !metaAdsIsPlaceholderPageName(rawName, metaPageId || pageId)) {
    const nameKey = pageCategoryKey(rawName);
    if (nameKey) keys.add(`name:${nameKey}`);
  }
  return keys;
}

function adsShareAPage(left, right) {
  const leftKeys = _adPageMergeKeys(left);
  if (!leftKeys.size) return false;
  for (const key of _adPageMergeKeys(right)) {
    if (leftKeys.has(key)) return true;
  }
  return false;
}

// The draft must be genuinely empty. Money on both sides is a decision a person
// has to make one receipt at a time, so it is refused rather than guessed.
function metaDraftCarriesMoney(ad) {
  if (!ad) return false;
  if ((Number(ad.amountUSD) || 0) > 0) return true;
  if (getAdLinkedReceiptIds(ad).length > 0) return true;
  if (Array.isArray(ad.topUps) && ad.topUps.length > 0) return true;
  return !!String(ad.customerId || '').trim();
}

// The ads table asks about every row, so the WHOLE pairing is resolved in one
// pass and cached for the render — never once per row. Comparing each ad with
// every other ad (and re-finding its page each time) is O(ads² × pages) and was
// measurably the wrong shape for a list this long. Cleared at the top of
// renderAdsView and after a merge, so it can never describe stale data.
let _adMergePairCache = null;

function resetAdMergePairCache() {
  _adMergePairCache = null;
}

function _buildAdMergePairIndex() {
  const pairs = new Map();
  if (!isMergeToolsAdmin() || !isServerModeEnabled()) return pairs;

  const pagesById = new Map(
    (state.pages || [])
      .filter(page => page && !page._deleted && page.id)
      .map(page => [String(page.id), page])
  );
  const manualAds = [];
  const draftAds = [];
  const keysByAdId = new Map();
  for (const ad of getVisibleRecords(state.ads)) {
    if (!ad || ad.recordType === 'receipt' || !ad.id) continue;
    const linked = !!String(ad.metaAdId || '').trim();
    const imported = isImportedMetaAd(ad);
    if (imported && linked) {
      // A draft that already grew a customer, an amount or a receipt is a real
      // ad in its own right and must never be absorbed.
      if (metaDraftCarriesMoney(ad)) continue;
      draftAds.push(ad);
    } else if (!imported && !linked) {
      manualAds.push(ad);
    } else {
      // Already linked by hand, or imported and since unlinked: neither half.
      continue;
    }
    keysByAdId.set(String(ad.id), _adPageMergeKeys(ad, pagesById));
  }
  if (!manualAds.length || !draftAds.length) return pairs;

  const draftsByKey = new Map();
  for (const draft of draftAds) {
    for (const key of keysByAdId.get(String(draft.id))) {
      if (!draftsByKey.has(key)) draftsByKey.set(key, []);
      draftsByKey.get(key).push(draft);
    }
  }

  // Several hand-made ads of the same price on one page, beside several drafts,
  // is the NORMAL shape of this problem — refusing everything that is not a
  // clean one-to-one would hide the feature exactly where it is needed. So every
  // ad keeps its full candidate list and the owner picks; only the pick itself
  // is ever written, and getAdMergePlan re-checks it.
  for (const manual of manualAds) {
    const found = new Map();
    for (const key of keysByAdId.get(String(manual.id))) {
      for (const draft of draftsByKey.get(key) || []) found.set(String(draft.id), draft);
    }
    if (!found.size) continue;
    const partners = [...found.values()];
    pairs.set(String(manual.id), { role: 'manual', ad: manual, partners });
    for (const draft of partners) {
      const entry = pairs.get(String(draft.id)) || { role: 'draft', ad: draft, partners: [] };
      entry.partners.push(manual);
      pairs.set(String(draft.id), entry);
    }
  }
  return pairs;
}

function getAdMergePartnersFor(adId) {
  const wanted = String(adId || '');
  if (!wanted) return null;
  if (!_adMergePairCache) _adMergePairCache = _buildAdMergePairIndex();
  const entry = _adMergePairCache.get(wanted) || null;
  return entry && entry.partners.length ? entry : null;
}

// One button in the ads-table Actions column, on BOTH halves of a possible pair.
// "Link" is already taken there by the ad -> Meta connection manager, so this
// says Merge/دمج like the customer flow does.
function renderAdMergeActionButton(ad, isAr) {
  const entry = getAdMergePartnersFor(ad?.id);
  if (!entry) return '';
  const count = entry.partners.length;
  const label = isAr ? 'دمج' : 'Merge';
  const title = entry.role === 'manual'
    ? (isAr ? 'دمج هذا الإعلان مع نسخته المستوردة من Meta على نفس الصفحة' : 'Merge this ad with its Meta-imported copy on the same page')
    : (isAr ? 'دمج هذه النسخة المستوردة مع الإعلان الأصلي على نفس الصفحة' : 'Merge this imported copy into the original ad on the same page');
  return `<button type="button" data-action="merge-meta-twin" data-ad-id="${Security.escapeHtml(String(ad.id))}" onclick="openAdMergePicker(this.dataset.adId, this)" class="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-purple-200 bg-purple-50 px-2 text-xs font-bold text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-200" title="${Security.escapeHtml(title)}"><i data-lucide="combine" class="h-4 w-4"></i><span>${label}${count > 1 ? ` (${count})` : ''}</span></button>`;
}

// One candidate goes straight to the confirmation. Several means the owner has
// to say which two ads are really the same ad — the app must not guess.
function openAdMergePicker(adId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  const entry = getAdMergePartnersFor(adId);
  if (!entry) {
    showNotification(isAr ? 'لا يوجد ما يُدمج' : 'Nothing to merge', isAr ? 'لم يعد هناك إعلان مطابق على نفس الصفحة.' : 'There is no matching ad on the same page any more.', 'warning');
    return;
  }
  const pairFor = partner => (entry.role === 'manual'
    ? { keepId: String(entry.ad.id), draftId: String(partner.id) }
    : { keepId: String(partner.id), draftId: String(entry.ad.id) });
  if (entry.partners.length === 1) {
    const only = pairFor(entry.partners[0]);
    showAdMergeDialog(only.keepId, only.draftId, triggerButton);
    return;
  }

  closeAdMergeDialog(false);
  _adMergeReturnFocus = triggerButton || document.activeElement;
  const dialog = document.createElement('div');
  dialog.id = 'ad-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ad-merge-picker-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <h2 id="ad-merge-picker-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${entry.role === 'manual' ? (isAr ? 'أي نسخة Meta هي نفس هذا الإعلان؟' : 'Which Meta copy is the same ad?') : (isAr ? 'أي إعلان هو نفس هذه النسخة؟' : 'Which ad is this copy?')}</h2>
          <p class="text-sm text-slate-500 break-words">${isAr ? 'كلها على نفس الصفحة. اختر واحداً لمراجعة الدمج قبل تنفيذه.' : 'They are all on the same page. Pick one to review the merge before it runs.'}</p>
        </div>
        <button type="button" onclick="closeAdMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-2">
        ${entry.partners.map(partner => {
          const ids = pairFor(partner);
          const money = (Number(partner.amountUSD) || 0).toFixed(2);
          const when = partner.startDate ? new Date(partner.startDate) : null;
          const dateText = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString(appDateLocale()) : '';
          return `<button type="button" onclick="showAdMergeDialog('${Security.escapeHtml(ids.keepId)}','${Security.escapeHtml(ids.draftId)}', this)" class="w-full text-start rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20">
            <div class="font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(_describeMergeAdCustomer(partner, isAr))}</div>
            <div class="mt-0.5 text-xs text-slate-500 break-all">
              ${String(partner.metaAdId || '').trim() ? `Meta #${Security.escapeHtml(String(partner.metaAdId))}` : `${isAr ? 'المبلغ' : 'Amount'}: $${money}`}
              ${dateText ? ` • ${Security.escapeHtml(dateText)}` : ''}
            </div>
          </button>`;
        }).join('')}
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4">
        <button type="button" onclick="closeAdMergeDialog()" class="w-full bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closeAdMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

// Re-validates an explicitly chosen pair (the dialog and the write both use it,
// so a stale dialog can never merge two ads that stopped being a pair).
function getAdMergePlan(keepAdId, draftAdId) {
  const isAr = state.language === 'ar';
  const ads = getVisibleRecords(state.ads);
  const keepAd = ads.find(item => String(item.id) === String(keepAdId || '')) || null;
  const draftAd = ads.find(item => String(item.id) === String(draftAdId || '')) || null;
  const plan = { keepAd, draftAd, metaAdId: '', blocked: '' };
  if (!keepAd || !draftAd || String(keepAd.id) === String(draftAd.id)) {
    plan.blocked = isAr ? 'أحد الإعلانين لم يعد موجوداً. حدّث الصفحة وحاول مرة أخرى.' : 'One of the two ads no longer exists. Refresh and try again.';
    return plan;
  }
  if (!isServerModeEnabled()) {
    plan.blocked = isAr ? 'الدمج يحتاج الاتصال بالخادم.' : 'Merging needs a live server connection.';
    return plan;
  }
  plan.metaAdId = String(draftAd.metaAdId || '').trim();
  if (!plan.metaAdId || !isImportedMetaAd(draftAd)) {
    plan.blocked = isAr ? 'الإعلان الثاني ليس نسخة مستوردة من Meta.' : 'The second ad is not a Meta-imported copy.';
    return plan;
  }
  if (String(keepAd.metaAdId || '').trim()) {
    plan.blocked = isAr ? 'الإعلان الأساسي مرتبط بـ Meta بالفعل. ألغِ ربطه أولاً.' : 'The main ad is already linked to Meta. Unlink it first.';
    return plan;
  }
  if (isImportedMetaAd(keepAd)) {
    plan.blocked = isAr ? 'الإعلانان كلاهما مستورد من Meta.' : 'Both ads were imported from Meta.';
    return plan;
  }
  if (metaDraftCarriesMoney(draftAd)) {
    plan.blocked = isAr
      ? 'النسخة المستوردة عليها عميل أو مبلغ أو وصل. أفرغها أو احذفها بنفسك أولاً.'
      : 'The imported copy already has a customer, an amount or a receipt. Empty or delete it yourself first.';
    return plan;
  }
  if (!adsShareAPage(keepAd, draftAd)) {
    plan.blocked = isAr ? 'الإعلانان ليسا على نفس الصفحة.' : 'The two ads are not on the same page.';
    return plan;
  }
  return plan;
}

function closeAdMergeDialog(restoreFocus = true) {
  document.getElementById('ad-merge-dialog')?.remove();
  const target = _adMergeReturnFocus?.isConnected === false ? null : _adMergeReturnFocus;
  _adMergeReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

function _describeMergeAdCustomer(ad, isAr) {
  const customer = (state.customers || []).find(item => String(item.id) === String(ad?.customerId || ''));
  return String(customer?.name || ad?.customerName || ad?.metaAdName || (isAr ? 'بدون عميل' : 'No customer')).trim();
}

function showAdMergeDialog(keepAdId, draftAdId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  const plan = getAdMergePlan(keepAdId, draftAdId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }
  closeAdMergeDialog(false);
  _adMergeReturnFocus = triggerButton || document.activeElement;

  const keepAmount = (Number(plan.keepAd.amountUSD) || 0).toFixed(2);
  const keepReceipts = getAdLinkedReceiptIds(plan.keepAd).length;
  const dialog = document.createElement('div');
  dialog.id = 'ad-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ad-merge-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-2xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="flex items-start gap-3 min-w-0">
          <span class="w-11 h-11 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 flex items-center justify-center shrink-0">
            <i data-lucide="combine" class="w-6 h-6"></i>
          </span>
          <div class="min-w-0">
            <h2 id="ad-merge-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${isAr ? 'دمج الإعلان مع نسخة Meta' : 'Merge this ad with its Meta copy'}</h2>
            <p class="text-sm text-slate-500 break-words">${isAr ? 'ينتقل ربط Meta إلى الإعلان الذي يحمل المال، وتُحذف النسخة الفارغة.' : 'The Meta link moves to the ad that holds the money, and the empty copy is removed.'}</p>
          </div>
        </div>
        <button type="button" onclick="closeAdMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
        <div class="grid gap-3 md:grid-cols-2">
          <section class="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">${isAr ? 'سيبقى' : 'Will be kept'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(_describeMergeAdCustomer(plan.keepAd, isAr))}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300">${isAr ? 'المبلغ' : 'Amount'}: $${keepAmount}</div>
            <div class="text-xs text-slate-600 dark:text-slate-300">${isAr ? `${keepReceipts} وصل مرتبط` : `${keepReceipts} linked receipt${keepReceipts === 1 ? '' : 's'}`}</div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">${isAr ? 'سيأخذ ربط Meta' : 'Gains the Meta link'}</div>
          </section>
          <section class="rounded-xl border-2 border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">${isAr ? 'ستُزال' : 'Will be removed'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(String(plan.draftAd.metaAdName || (isAr ? 'مسودة Meta' : 'Meta draft')))}</div>
            <div class="mt-1 font-mono text-[11px] text-slate-500 break-all">Meta #${Security.escapeHtml(plan.metaAdId)}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300">${isAr ? 'بدون عميل أو مبلغ أو وصل' : 'No customer, amount or receipt'}</div>
          </section>
        </div>

        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <div class="font-bold text-slate-800 dark:text-white">${isAr ? 'ماذا سيحدث' : 'What will happen'}</div>
          <div>• ${isAr ? 'يُفك ربط Meta عن النسخة الفارغة.' : 'The empty copy releases the Meta link.'}</div>
          <div>• ${isAr ? 'يُربط الإعلان الباقي بنفس إعلان Meta ويأخذ الصورة والميزانية والمصروف.' : 'The surviving ad is linked to the same Meta ad and picks up its photo, budget and spend.'}</div>
          <div>• ${isAr ? 'تُحذف النسخة الفارغة في النهاية.' : 'The empty copy is removed last.'}</div>
          <div>• ${isAr ? 'لا يتغير أي مبلغ أو وصل أو صورة في الإعلان الباقي.' : 'No amount, receipt or photo on the surviving ad changes.'}</div>
        </div>
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4 flex flex-col sm:flex-row gap-2">
        <button type="button" id="ad-merge-confirm" onclick="runAdMerge('${Security.escapeHtml(String(plan.keepAd.id))}','${Security.escapeHtml(String(plan.draftAd.id))}')" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-purple-700 min-h-11">
          <i data-lucide="combine" class="w-4 h-4 inline mr-2"></i>${isAr ? 'دمج الآن' : 'Merge now'}
        </button>
        <button type="button" onclick="closeAdMergeDialog()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closeAdMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

function _liveMergeAd(adId) {
  return (state.ads || []).find(item => item && String(item.id) === String(adId || '')) || null;
}

async function runAdMerge(keepAdId, draftAdId) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  if (_mergeToolsBusy) return;
  const plan = getAdMergePlan(keepAdId, draftAdId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }

  _mergeToolsBusy = 'ad';
  const confirmButton = document.getElementById('ad-merge-confirm');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = isAr ? 'جارٍ الدمج…' : 'Merging…';
  }

  const metaAdId = plan.metaAdId;
  const draftId = String(plan.draftAd.id);
  const keepId = String(plan.keepAd.id);
  let released = false;
  try {
    // 1. Release the link. Meta allows one Albayan ad per Meta ad and the check
    //    ignores deleted rows, so the draft has to let go before the real ad can
    //    take over.
    const draftBefore = _liveMergeAd(draftId);
    // Without a known version the server cannot detect that someone else edited
    // the ad first, so refuse rather than overwrite blindly.
    if (!Number.isFinite(Number(draftBefore?._lastModified))) {
      throw new Error(isAr ? 'حدّث البيانات ثم أعد المحاولة.' : 'Refresh the data and try again.');
    }
    const unlinked = await apiUnlinkMetaAd(
      draftId,
      Number(draftBefore._lastModified),
      Security.generateSecureId('merge_unlink')
    );
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: unlinked.ad }], 'adMergeUnlink');
    released = true;

    // 2. Give the link to the ad that actually holds the money. This also pulls
    //    the Meta photo, budget, spend and schedule onto it.
    const keepBefore = _liveMergeAd(keepId);
    if (!Number.isFinite(Number(keepBefore?._lastModified))) {
      throw new Error(isAr ? 'حدّث البيانات ثم أعد المحاولة.' : 'Refresh the data and try again.');
    }
    const linked = await apiLinkMetaAd(
      keepId,
      metaAdId,
      Number(keepBefore._lastModified),
      Security.generateSecureId('merge_link')
    );
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: linked.ad }], 'adMergeLink');
    released = false;

    // 3. Only now is the empty draft redundant. A draft carries no money, so
    //    removing it returns nothing and unwinds nothing.
    const removed = await deleteRecord(state.ads, draftId);
    if (!removed) {
      showNotification(
        isAr ? 'تم الربط' : 'Linked',
        isAr ? 'انتقل ربط Meta بنجاح، لكن تعذّر حذف النسخة الفارغة. احذفها يدوياً.' : 'The Meta link moved successfully, but the empty copy could not be removed. Delete it by hand.',
        'warning'
      );
      return;
    }
    showNotification(
      isAr ? 'تم الدمج' : 'Merged',
      isAr ? 'أصبح الإعلان مرتبطاً بـ Meta وحُذفت النسخة المكررة.' : 'The ad is now linked to Meta and the duplicate copy was removed.',
      'success'
    );
  } catch (error) {
    // The draft gave up its link and the real ad never took it. Put it back so
    // the pair is exactly as it was and the merge can simply be retried.
    if (released) {
      try {
        const draftNow = _liveMergeAd(draftId);
        const restored = await apiLinkMetaAd(
          draftId,
          metaAdId,
          Number(draftNow?._lastModified),
          Security.generateSecureId('merge_restore')
        );
        applyValidatedServerEntityBatch([{ collection: 'ads', entity: restored.ad }], 'adMergeRestore');
      } catch (_) {
        showNotification(
          isAr ? 'يحتاج انتباهك' : 'Needs your attention',
          isAr
            ? `لم يكتمل الدمج وبقيت النسخة المستوردة بدون ربط. اربطها يدوياً بإعلان Meta رقم ${metaAdId}.`
            : `The merge did not finish and the imported copy is left unlinked. Link it back to Meta ad ${metaAdId} by hand.`,
          'error'
        );
      }
    }
    showNotification(
      isAr ? 'تعذّر الدمج' : 'Merge failed',
      error?.message || (isAr ? 'حدث خطأ أثناء الدمج. أعد المحاولة.' : 'Something went wrong during the merge. Try again.'),
      'error'
    );
  } finally {
    _mergeToolsBusy = '';
    resetAdMergePairCache();
    closeAdMergeDialog(false);
    render();
  }
}
