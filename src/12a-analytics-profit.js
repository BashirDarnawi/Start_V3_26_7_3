// ==========================================
// ANALYTICS BREAKDOWNS + META PROFIT LEDGER
// ==========================================

const ANALYTICS_PERIOD_COUNTS = Object.freeze({ day: 30, week: 12, month: 12 });
let _analyticsBreakdownState = { metric: '', granularity: 'day', trigger: null };
let _dollarPurchaseTrigger = null;

function analyticsNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function analyticsMoney(value, digits = 2) {
  return analyticsNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function analyticsEscape(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

function analyticsDateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function analyticsLocalDateISO(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function getAdActualSpendUSD(ad) {
  if (!ad || ad._deleted) return 0;
  const metaMinor = Number(ad.metaSpendMinor);
  if (ad.metaAdId && Number.isFinite(metaMinor) && metaMinor >= 0) {
    return Math.max(0, metaMinor / 100);
  }
  const recorded = Number(ad.spentUSD);
  if (Number.isFinite(recorded) && recorded >= 0) return recorded;
  const status = String(ad.status || '').toLowerCase();
  if (['stopped', 'completed', 'canceled', 'cancelled', 'lost'].includes(status)) {
    return Math.max(0, analyticsNumber(getAdSpendUSD(ad)));
  }
  // An active manual ad has only a planned budget, not verified spend. Treating
  // that plan as cost would overstate expenses and consume dollar inventory.
  return 0;
}

function getAdProfitEventTime(ad) {
  const status = String(ad?.status || ad?.metaEffectiveStatus || '').toLowerCase();
  const isFinal = ['stopped', 'completed', 'canceled', 'cancelled', 'lost', 'archived'].includes(status);
  // A completed ad is priced at the date its spend finished, not the date a
  // later sync happened to read it. Active ads use the latest spend snapshot.
  const values = isFinal
    ? [ad?.stoppedAt, ad?.endDate, ad?.metaLastSyncedAt, ad?.startDate, ad?.createdAt, ad?._created]
    : [ad?.metaLastSyncedAt, ad?.stoppedAt, ad?.endDate, ad?.startDate, ad?.createdAt, ad?._created];
  for (const value of values) {
    const time = analyticsDateValue(value);
    if (time) return time;
  }
  return Date.now();
}

function getAdSaleRateLYD(ad) {
  const helperRate = typeof getAdSpendExchangeRate === 'function'
    ? analyticsNumber(getAdSpendExchangeRate(ad))
    : 0;
  if (helperRate > 0) return helperRate;
  const explicit = analyticsNumber(ad?.exchangeRate || ad?.rate);
  if (explicit > 0) return explicit;
  const amount = analyticsNumber(ad?.amountUSD);
  const local = analyticsNumber(ad?.amountLocal);
  return amount > 0 && local > 0 ? local / amount : 0;
}

/**
 * Build a conservative FIFO profit snapshot. Each USD purchase is a cost lot;
 * spend can only consume lots that existed on/before the ad's observation date.
 * This prevents a newly-entered purchase from silently pricing old spend.
 */
function buildAdProfitabilitySnapshot(purchases, ads) {
  const lots = (Array.isArray(purchases) ? purchases : [])
    .filter(row => row && !row._deleted && analyticsNumber(row.amountUSD) > 0 && analyticsNumber(row.rateLYD) > 0)
    .map(row => {
      const amountCents = Math.max(0, Math.round(analyticsNumber(row.amountUSD) * 100));
      const dateMs = analyticsDateValue(`${String(row.purchaseDate || '').slice(0, 10)}T00:00:00`) || analyticsDateValue(row.createdAt || row._created);
      return {
        id: String(row.id || ''),
        dateMs,
        purchaseDate: String(row.purchaseDate || '').slice(0, 10),
        amountCents,
        remainingCents: amountCents,
        rateLYD: analyticsNumber(row.rateLYD),
        source: String(row.source || '')
      };
    })
    .sort((a, b) => a.dateMs - b.dateMs || a.id.localeCompare(b.id));

  const adEvents = (Array.isArray(ads) ? ads : [])
    .filter(ad => ad && !ad._deleted && ad.recordType !== 'receipt')
    .map(ad => ({ ad, time: getAdProfitEventTime(ad), spendCents: Math.max(0, Math.round(getAdActualSpendUSD(ad) * 100)) }))
    .sort((a, b) => a.time - b.time || String(a.ad.id || '').localeCompare(String(b.ad.id || '')));

  let nextLot = 0;
  const available = [];
  const rows = [];
  for (const event of adEvents) {
    while (nextLot < lots.length && lots[nextLot].dateMs <= event.time) available.push(lots[nextLot++]);
    let neededCents = event.spendCents;
    let costLYD = 0;
    const allocations = [];
    for (const lot of available) {
      if (neededCents <= 0) break;
      if (lot.remainingCents <= 0) continue;
      const usedCents = Math.min(neededCents, lot.remainingCents);
      lot.remainingCents -= usedCents;
      neededCents -= usedCents;
      const usedUSD = usedCents / 100;
      const lotCost = usedUSD * lot.rateLYD;
      costLYD += lotCost;
      allocations.push({ purchaseId: lot.id, amountUSD: usedUSD, rateLYD: lot.rateLYD, costLYD: lotCost });
    }
    const coveredCents = event.spendCents - neededCents;
    const paid = typeof getAdPaymentState === 'function'
      ? getAdPaymentState(event.ad) === 'paid'
      : !!event.ad.isPaid;
    const saleRateLYD = getAdSaleRateLYD(event.ad);
    const recognizedRevenueLYD = paid && saleRateLYD > 0 ? (coveredCents / 100) * saleRateLYD : 0;
    rows.push({
      ad: event.ad,
      adId: String(event.ad.id || ''),
      eventTime: event.time,
      paid,
      soldBudgetUSD: Math.max(0, analyticsNumber(event.ad.amountUSD)),
      soldBudgetLYD: Math.max(0, analyticsNumber(event.ad.amountLocal)) || Math.max(0, analyticsNumber(event.ad.amountUSD)) * saleRateLYD,
      actualSpendUSD: event.spendCents / 100,
      coveredUSD: coveredCents / 100,
      unpricedUSD: neededCents / 100,
      saleRateLYD,
      costLYD,
      recognizedRevenueLYD,
      knownProfitLYD: recognizedRevenueLYD - costLYD,
      allocations
    });
  }

  while (nextLot < lots.length) available.push(lots[nextLot++]);
  const visibleLots = lots.map(lot => ({ ...lot, remainingUSD: lot.remainingCents / 100 }));
  const totalPurchasedUSD = visibleLots.reduce((sum, lot) => sum + lot.amountCents / 100, 0);
  const totalPurchaseCostLYD = visibleLots.reduce((sum, lot) => sum + (lot.amountCents / 100) * lot.rateLYD, 0);
  const inventoryUSD = visibleLots.reduce((sum, lot) => sum + lot.remainingUSD, 0);
  const inventoryCostLYD = visibleLots.reduce((sum, lot) => sum + lot.remainingUSD * lot.rateLYD, 0);
  const paidRows = rows.filter(row => row.paid);
  return {
    lots: visibleLots,
    rows,
    rowsByAdId: new Map(rows.map(row => [row.adId, row])),
    totalPurchasedUSD,
    totalPurchaseCostLYD,
    inventoryUSD,
    inventoryCostLYD,
    soldBudgetUSD: rows.reduce((sum, row) => sum + row.soldBudgetUSD, 0),
    actualSpendUSD: rows.reduce((sum, row) => sum + row.actualSpendUSD, 0),
    paidActualSpendUSD: paidRows.reduce((sum, row) => sum + row.actualSpendUSD, 0),
    paidRevenueLYD: paidRows.reduce((sum, row) => sum + row.recognizedRevenueLYD, 0),
    paidCostLYD: paidRows.reduce((sum, row) => sum + row.costLYD, 0),
    knownGrossProfitLYD: paidRows.reduce((sum, row) => sum + row.knownProfitLYD, 0),
    unpricedSpendUSD: rows.reduce((sum, row) => sum + row.unpricedUSD, 0),
    unpaidSpendUSD: rows.filter(row => !row.paid).reduce((sum, row) => sum + row.actualSpendUSD, 0),
    missingSaleRateUSD: paidRows.filter(row => row.saleRateLYD <= 0).reduce((sum, row) => sum + row.coveredUSD, 0)
  };
}

function getCurrentProfitabilitySnapshot(adsOverride) {
  return buildAdProfitabilitySnapshot(
    getVisibleRecords(state.dollarPurchases || []),
    Array.isArray(adsOverride) ? adsOverride : getVisibleRecords(state.ads || [])
  );
}

function analyticsStartOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function analyticsPeriods(granularity, nowValue) {
  const kind = ANALYTICS_PERIOD_COUNTS[granularity] ? granularity : 'day';
  const count = ANALYTICS_PERIOD_COUNTS[kind];
  const now = analyticsStartOfDay(nowValue || Date.now());
  let current;
  if (kind === 'week') {
    current = new Date(now);
    const day = current.getDay() || 7;
    current.setDate(current.getDate() - day + 1);
  } else if (kind === 'month') {
    current = new Date(now.getFullYear(), now.getMonth(), 1);
  } else current = now;

  const periods = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    let start;
    if (kind === 'month') start = new Date(current.getFullYear(), current.getMonth() - offset, 1);
    else {
      start = new Date(current);
      start.setDate(start.getDate() - offset * (kind === 'week' ? 7 : 1));
    }
    let end;
    if (kind === 'month') end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    else {
      end = new Date(start);
      end.setDate(end.getDate() + (kind === 'week' ? 7 : 1));
    }
    const label = kind === 'month'
      ? start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      : kind === 'week'
        ? `${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
        : start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    periods.push({ start: start.getTime(), end: end.getTime(), label, count: 0, primaryUSD: 0, secondaryUSD: 0, profitLYD: 0 });
  }
  return periods;
}

function analyticsRecordTime(record, type) {
  const candidates = type === 'receipt'
    ? [record?.receiptDate, record?.date, record?.createdAt, record?._created]
    : [record?.startDate, record?.createdAt, record?._created];
  for (const value of candidates) {
    const time = analyticsDateValue(value);
    if (time) return time;
  }
  return 0;
}

function buildAnalyticsBreakdown(metric, granularity, options = {}) {
  const periods = analyticsPeriods(granularity, options.now || Date.now());
  const ads = Array.isArray(options.ads) ? options.ads : getVisibleRecords(state.ads || []);
  const receipts = (Array.isArray(options.receipts) ? options.receipts : getVisibleRecords(state.receipts || []))
    .filter(row => row && !row._deleted && (typeof isTransferInReceipt !== 'function' || !isTransferInReceipt(row)));
  const profit = options.profitSnapshot || buildAdProfitabilitySnapshot(options.purchases || state.dollarPurchases || [], ads);
  const findPeriod = time => periods.find(period => time >= period.start && time < period.end);

  if (metric === 'ad-revenue') {
    for (const ad of ads) {
      if (!ad || ad._deleted || ad.recordType === 'receipt') continue;
      const paid = typeof getAdPaymentState === 'function' ? getAdPaymentState(ad) === 'paid' : !!ad.isPaid;
      if (!paid) continue;
      const period = findPeriod(analyticsRecordTime(ad, 'ad'));
      if (!period) continue;
      const profitRow = profit.rowsByAdId.get(String(ad.id || ''));
      period.count += 1;
      period.primaryUSD += Math.max(0, analyticsNumber(getAdSpendUSD(ad)));
      period.secondaryUSD += profitRow?.actualSpendUSD || 0;
      period.profitLYD += profitRow?.knownProfitLYD || 0;
    }
  } else {
    for (const receipt of receipts) {
      const period = findPeriod(analyticsRecordTime(receipt, 'receipt'));
      if (!period) continue;
      const amount = Math.max(0, analyticsNumber(receipt.amountUSD));
      period.count += 1;
      if (metric === 'collection-status') {
        if (receipt.collected) period.primaryUSD += amount;
        else period.secondaryUSD += amount;
      } else period.primaryUSD += amount;
    }
  }
  return { metric, granularity: ANALYTICS_PERIOD_COUNTS[granularity] ? granularity : 'day', periods };
}

function analyticsMetricTitle(metric, isAr) {
  const titles = {
    'ad-revenue': isAr ? 'تفصيل إيراد الإعلانات المدفوعة' : 'Paid Ad Revenue Breakdown',
    'receipts-volume': isAr ? 'تفصيل حجم الوصولات' : 'Receipts Volume Breakdown',
    'collection-status': isAr ? 'تفصيل حالة التحصيل' : 'Collection Status Breakdown'
  };
  return titles[metric] || titles['ad-revenue'];
}

function renderAnalyticsBreakdownDialog() {
  const root = document.getElementById('analytics-breakdown-dialog');
  if (!root) return;
  if (typeof can !== 'function' || !can('analytics', 'viewFinancials')) {
    closeAnalyticsBreakdown(false);
    return;
  }
  const isAr = state.language === 'ar';
  const data = buildAnalyticsBreakdown(_analyticsBreakdownState.metric, _analyticsBreakdownState.granularity);
  const maxValue = Math.max(1, ...data.periods.map(row => row.primaryUSD + row.secondaryUSD));
  const showProfit = isCurrentUserAdmin() && _analyticsBreakdownState.metric === 'ad-revenue';
  const metric = _analyticsBreakdownState.metric;
  const labels = metric === 'collection-status'
    ? { primary: isAr ? 'محصل' : 'Collected', secondary: isAr ? 'غير محصل' : 'Outstanding' }
    : metric === 'ad-revenue'
      ? { primary: isAr ? 'إيراد مسجل' : 'Booked revenue', secondary: isAr ? 'إنفاق فعلي' : 'Actual spend' }
      : { primary: isAr ? 'قيمة الوصولات' : 'Receipt value', secondary: '' };
  const totals = data.periods.reduce((acc, row) => ({
    count: acc.count + row.count,
    primary: acc.primary + row.primaryUSD,
    secondary: acc.secondary + row.secondaryUSD,
    profit: acc.profit + row.profitLYD
  }), { count: 0, primary: 0, secondary: 0, profit: 0 });

  root.innerHTML = `
    <div class="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" onclick="closeAnalyticsBreakdown()"></div>
    <section role="dialog" aria-modal="true" aria-labelledby="analytics-breakdown-title" dir="${isAr ? 'rtl' : 'ltr'}"
      class="fixed inset-x-3 top-4 bottom-4 sm:inset-x-[8%] lg:inset-x-[16%] glass-panel rounded-3xl shadow-2xl overflow-hidden flex flex-col">
      <header class="p-4 sm:p-6 border-b border-slate-200/70 dark:border-slate-700 flex items-start justify-between gap-4">
        <div>
          <h2 id="analytics-breakdown-title" class="text-xl font-bold text-slate-900 dark:text-white">${analyticsMetricTitle(metric, isAr)}</h2>
          <p class="text-sm text-slate-500 mt-1">${isAr ? 'اختر يومي أو أسبوعي أو شهري لفهم التغيرات بوضوح.' : 'Switch between daily, weekly, and monthly views to understand the trend.'}</p>
        </div>
        <button type="button" onclick="closeAnalyticsBreakdown()" aria-label="Close" class="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"><i data-lucide="x" class="w-5 h-5"></i></button>
      </header>
      <div class="p-4 sm:p-6 overflow-y-auto flex-1">
        <div class="grid grid-cols-3 gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-5">
          ${['day', 'week', 'month'].map(kind => `<button type="button" onclick="setAnalyticsBreakdownGranularity('${kind}')" class="px-3 py-2 rounded-lg text-sm font-semibold ${data.granularity === kind ? 'bg-white dark:bg-slate-700 text-indigo-600 shadow-sm' : 'text-slate-500'}">${kind === 'day' ? (isAr ? 'يومي' : 'Daily') : kind === 'week' ? (isAr ? 'أسبوعي' : 'Weekly') : (isAr ? 'شهري' : 'Monthly')}</button>`).join('')}
        </div>
        <div class="grid grid-cols-2 ${showProfit ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-3 mb-6">
          <div class="rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 p-4"><p class="text-xs text-slate-500">${isAr ? 'السجلات' : 'Records'}</p><p class="text-xl font-bold">${totals.count}</p></div>
          <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 p-4"><p class="text-xs text-slate-500">${labels.primary}</p><p class="text-xl font-bold">$${analyticsMoney(totals.primary)}</p></div>
          ${labels.secondary ? `<div class="rounded-2xl bg-amber-50 dark:bg-amber-950/40 p-4"><p class="text-xs text-slate-500">${labels.secondary}</p><p class="text-xl font-bold">$${analyticsMoney(totals.secondary)}</p></div>` : ''}
          ${showProfit ? `<div class="rounded-2xl bg-cyan-50 dark:bg-cyan-950/40 p-4"><p class="text-xs text-slate-500">${isAr ? 'ربح معروف' : 'Known profit'}</p><p class="text-xl font-bold">${analyticsMoney(totals.profit)} LYD</p></div>` : ''}
        </div>
        <div class="space-y-2 mb-6" aria-label="Trend chart">
          ${data.periods.map(row => `<div class="grid grid-cols-[64px_1fr_90px] sm:grid-cols-[90px_1fr_120px] items-center gap-3 text-xs">
            <span class="text-slate-500">${analyticsEscape(row.label)}</span>
            <div class="h-5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
              <div class="h-full bg-indigo-500" style="width:${Math.max(0, row.primaryUSD / maxValue * 100)}%"></div>
              ${row.secondaryUSD ? `<div class="h-full bg-amber-400" style="width:${Math.max(0, row.secondaryUSD / maxValue * 100)}%"></div>` : ''}
            </div>
            <span class="font-semibold text-right">$${analyticsMoney(row.primaryUSD)}</span>
          </div>`).join('')}
        </div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-700">
          <table class="w-full min-w-[620px] text-sm">
            <thead class="bg-slate-50 dark:bg-slate-800"><tr><th class="p-3 text-left">${isAr ? 'الفترة' : 'Period'}</th><th class="p-3 text-right">${isAr ? 'العدد' : 'Count'}</th><th class="p-3 text-right">${labels.primary}</th>${labels.secondary ? `<th class="p-3 text-right">${labels.secondary}</th>` : ''}${showProfit ? `<th class="p-3 text-right">${isAr ? 'الربح المعروف' : 'Known profit'}</th>` : ''}</tr></thead>
            <tbody>${data.periods.slice().reverse().map(row => `<tr class="border-t border-slate-100 dark:border-slate-800"><td class="p-3 font-medium">${analyticsEscape(row.label)}</td><td class="p-3 text-right">${row.count}</td><td class="p-3 text-right">$${analyticsMoney(row.primaryUSD)}</td>${labels.secondary ? `<td class="p-3 text-right">$${analyticsMoney(row.secondaryUSD)}</td>` : ''}${showProfit ? `<td class="p-3 text-right ${row.profitLYD >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${analyticsMoney(row.profitLYD)} LYD</td>` : ''}</tr>`).join('')}</tbody>
          </table>
        </div>
        ${metric === 'collection-status' ? `<button type="button" onclick="openOutstandingReceiptsFromAnalytics()" class="mt-5 w-full sm:w-auto px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold">${isAr ? 'عرض الوصولات غير المحصلة' : 'View outstanding receipts'}</button>` : ''}
      </div>
    </section>`;
  if (window.lucide) lucide.createIcons({ nodes: [root] });
}

function openAnalyticsBreakdown(metric, granularity = 'day') {
  if (!['ad-revenue', 'receipts-volume', 'collection-status'].includes(metric)) return;
  if (typeof can !== 'function' || !can('analytics', 'viewFinancials')) {
    showNotification(
      state.language === 'ar' ? 'غير مسموح' : 'Permission required',
      state.language === 'ar' ? 'هذه التفاصيل المالية متاحة للمستخدمين المصرح لهم فقط.' : 'These financial details are available only to authorized users.',
      'error'
    );
    return;
  }
  closeAnalyticsBreakdown(false);
  _analyticsBreakdownState = { metric, granularity, trigger: document.activeElement };
  const root = document.createElement('div');
  root.id = 'analytics-breakdown-dialog';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '10000';
  document.body.appendChild(root);
  document.body.classList.add('overflow-hidden');
  renderAnalyticsBreakdownDialog();
  setTimeout(() => document.querySelector('#analytics-breakdown-dialog button')?.focus(), 0);
}

function setAnalyticsBreakdownGranularity(granularity) {
  if (!ANALYTICS_PERIOD_COUNTS[granularity]) return;
  _analyticsBreakdownState.granularity = granularity;
  renderAnalyticsBreakdownDialog();
}

function closeAnalyticsBreakdown(restoreFocus = true) {
  document.getElementById('analytics-breakdown-dialog')?.remove();
  if (!document.getElementById('dollar-purchase-dialog')) document.body.classList.remove('overflow-hidden');
  if (restoreFocus && _analyticsBreakdownState.trigger?.focus) _analyticsBreakdownState.trigger.focus();
}

function openOutstandingReceiptsFromAnalytics() {
  closeAnalyticsBreakdown(false);
  state.receiptCollectedFilter = 'not-collected';
  navigateTo('receipts');
}

function renderProfitabilityPanel(snapshot, isAr) {
  if (!isCurrentUserAdmin()) return '';
  const profitPositive = snapshot.knownGrossProfitLYD >= 0;
  return `
    <section class="glass-panel rounded-3xl p-5 sm:p-6" aria-labelledby="profitability-title">
      <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-5">
        <div>
          <div class="flex items-center gap-2"><i data-lucide="chart-no-axes-combined" class="w-5 h-5 text-indigo-600"></i><h2 id="profitability-title" class="text-xl font-bold text-slate-900 dark:text-white">${isAr ? 'ربحية إعلانات ميتا' : 'Meta Ads Profitability'}</h2></div>
          <p class="text-sm text-slate-500 mt-1 max-w-3xl">${isAr ? 'يحسب النظام تكلفة الدولارات بطريقة الأقدم أولاً. لا يظهر الربح إلا للإنفاق الفعلي المدفوع الذي نعرف تكلفة دولاراته.' : 'Dollar purchase lots are consumed oldest-first (FIFO). Profit is recognized only for paid, actual ad spend whose dollar cost is known.'}</p>
        </div>
        <button type="button" onclick="openDollarPurchaseManager()" class="w-full lg:w-auto px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-lg flex items-center justify-center gap-2"><i data-lucide="badge-dollar-sign" class="w-5 h-5"></i>${isAr ? 'تسجيل شراء دولارات' : 'Record Dollar Purchase'}</button>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'إيراد معترف به' : 'Recognized revenue'}</p><p class="text-xl font-bold text-emerald-700">${analyticsMoney(snapshot.paidRevenueLYD)} LYD</p><p class="text-xs text-slate-500 mt-1">$${analyticsMoney(snapshot.paidActualSpendUSD)} ${isAr ? 'إنفاق مدفوع' : 'paid spend'}</p></div>
        <div class="rounded-2xl bg-rose-50 dark:bg-rose-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'تكلفة فيسبوك' : 'Facebook cost'}</p><p class="text-xl font-bold text-rose-700">${analyticsMoney(snapshot.paidCostLYD)} LYD</p><p class="text-xs text-slate-500 mt-1">${isAr ? 'من دفعات الدولار المسجلة' : 'from recorded USD lots'}</p></div>
        <div class="rounded-2xl ${profitPositive ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'bg-rose-50 dark:bg-rose-950/30'} p-4"><p class="text-xs text-slate-500">${isAr ? 'الربح الإجمالي المعروف' : 'Known gross profit'}</p><p class="text-xl font-bold ${profitPositive ? 'text-cyan-700' : 'text-rose-700'}">${analyticsMoney(snapshot.knownGrossProfitLYD)} LYD</p><p class="text-xs text-slate-500 mt-1">${isAr ? 'الإيراد ناقص تكلفة الدولار' : 'revenue minus dollar cost'}</p></div>
        <div class="rounded-2xl bg-indigo-50 dark:bg-indigo-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'مخزون الدولار المتبقي' : 'Remaining USD inventory'}</p><p class="text-xl font-bold text-indigo-700">$${analyticsMoney(snapshot.inventoryUSD)}</p><p class="text-xs text-slate-500 mt-1">${analyticsMoney(snapshot.inventoryCostLYD)} LYD ${isAr ? 'تكلفة' : 'cost'}</p></div>
      </div>
      ${(snapshot.unpricedSpendUSD > 0 || snapshot.missingSaleRateUSD > 0) ? `<div class="mt-4 p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
        <strong>${isAr ? 'يحتاج إكمال:' : 'Needs attention:'}</strong>
        ${snapshot.unpricedSpendUSD > 0 ? `${isAr ? 'إنفاق بلا تكلفة دولار' : 'spend without a recorded dollar cost'}: $${analyticsMoney(snapshot.unpricedSpendUSD)}.` : ''}
        ${snapshot.missingSaleRateUSD > 0 ? `${isAr ? 'إنفاق مدفوع بلا سعر بيع' : 'paid spend without a sale rate'}: $${analyticsMoney(snapshot.missingSaleRateUSD)}.` : ''}
        ${isAr ? 'هذه المبالغ مستبعدة من الربح حتى تكتمل البيانات.' : 'These amounts stay out of profit until their data is complete.'}
      </div>` : ''}
    </section>`;
}

function dollarPurchaseRemainingById(snapshot) {
  return new Map(snapshot.lots.map(lot => [lot.id, lot.remainingUSD]));
}

function renderDollarPurchaseDialog() {
  const root = document.getElementById('dollar-purchase-dialog');
  if (!root) return;
  if (!isCurrentUserAdmin()) { closeDollarPurchaseManager(); return; }
  const isAr = state.language === 'ar';
  const snapshot = getCurrentProfitabilitySnapshot();
  const remaining = dollarPurchaseRemainingById(snapshot);
  const purchases = getVisibleRecords(state.dollarPurchases || []).slice().sort((a, b) => String(b.purchaseDate || '').localeCompare(String(a.purchaseDate || '')) || analyticsDateValue(b.createdAt || b._created) - analyticsDateValue(a.createdAt || a._created));
  const today = analyticsLocalDateISO();
  root.innerHTML = `
    <div class="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" onclick="closeDollarPurchaseManager()"></div>
    <section role="dialog" aria-modal="true" aria-labelledby="dollar-purchase-title" dir="${isAr ? 'rtl' : 'ltr'}" class="fixed inset-x-3 top-4 bottom-4 sm:inset-x-[7%] lg:inset-x-[14%] glass-panel rounded-3xl shadow-2xl overflow-hidden flex flex-col">
      <header class="p-4 sm:p-6 border-b border-slate-200/70 dark:border-slate-700 flex items-start justify-between gap-4"><div><h2 id="dollar-purchase-title" class="text-xl font-bold">${isAr ? 'سجل شراء دولارات فيسبوك' : 'Facebook Dollar Purchase Ledger'}</h2><p class="text-sm text-slate-500 mt-1">${isAr ? 'سجل كل مرة تشتري فيها دولارات مع السعر الحقيقي في السوق.' : 'Record every USD purchase at the real market rate you paid.'}</p></div><button type="button" onclick="closeDollarPurchaseManager()" aria-label="Close" class="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"><i data-lucide="x" class="w-5 h-5"></i></button></header>
      <div class="p-4 sm:p-6 overflow-y-auto flex-1 space-y-6">
        <form id="dollar-purchase-form" onsubmit="saveDollarPurchase(event)" class="rounded-2xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-800 p-4 sm:p-5">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <label class="text-sm font-medium">${isAr ? 'تاريخ الشراء' : 'Purchase date'}<input name="purchaseDate" type="date" value="${today}" max="${today}" required class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl"></label>
            <label class="text-sm font-medium">${isAr ? 'المبلغ بالدولار' : 'USD amount'}<input name="amountUSD" type="number" min="0.01" max="1000000" step="0.01" inputmode="decimal" required oninput="updateDollarPurchasePreview()" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl" placeholder="100.00"></label>
            <label class="text-sm font-medium">${isAr ? 'سعر 1 دولار بالدينار' : 'LYD paid per $1'}<input name="rateLYD" type="number" min="0.0001" max="1000" step="0.0001" inputmode="decimal" required oninput="updateDollarPurchasePreview()" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl" placeholder="9.7000"></label>
            <div class="rounded-xl bg-white dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي ما دفعته' : 'Total paid'}</p><p id="dollar-purchase-total" class="text-xl font-bold text-indigo-700 mt-1">0.00 LYD</p></div>
            <label class="text-sm font-medium sm:col-span-2">${isAr ? 'المصدر أو الحساب (اختياري)' : 'Source/account (optional)'}<input name="source" maxlength="120" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl" placeholder="${isAr ? 'مثال: السوق / الحساب المسبق 1' : 'Example: Market / Prepaid Balance 1'}"></label>
            <label class="text-sm font-medium sm:col-span-2">${isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}<input name="note" maxlength="240" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl"></label>
          </div>
          <div class="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><p class="text-xs text-slate-500">${isAr ? 'السجل غير قابل للتعديل. لتصحيح خطأ، احذفه وأنشئه من جديد.' : 'Records are immutable. To correct a mistake, delete it and create it again.'}</p><button type="submit" class="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold">${isAr ? 'حفظ شراء الدولار' : 'Save Dollar Purchase'}</button></div>
        </form>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3"><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي المشترى' : 'Total purchased'}</p><p class="font-bold">$${analyticsMoney(snapshot.totalPurchasedUSD)}</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي التكلفة' : 'Total cost'}</p><p class="font-bold">${analyticsMoney(snapshot.totalPurchaseCostLYD)} LYD</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'المتبقي' : 'Inventory'}</p><p class="font-bold">$${analyticsMoney(snapshot.inventoryUSD)}</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إنفاق بلا تكلفة' : 'Unpriced spend'}</p><p class="font-bold ${snapshot.unpricedSpendUSD ? 'text-amber-600' : 'text-emerald-600'}">$${analyticsMoney(snapshot.unpricedSpendUSD)}</p></div></div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-700"><table class="w-full min-w-[720px] text-sm"><thead class="bg-slate-50 dark:bg-slate-800"><tr><th class="p-3 text-left">${isAr ? 'التاريخ' : 'Date'}</th><th class="p-3 text-right">USD</th><th class="p-3 text-right">${isAr ? 'السعر' : 'Rate'}</th><th class="p-3 text-right">${isAr ? 'التكلفة' : 'Cost'}</th><th class="p-3 text-right">${isAr ? 'المتبقي' : 'Remaining'}</th><th class="p-3 text-left">${isAr ? 'المصدر / الملاحظة' : 'Source / note'}</th><th class="p-3"></th></tr></thead><tbody>${purchases.length ? purchases.map(row => `<tr class="border-t border-slate-100 dark:border-slate-800"><td class="p-3 font-medium">${analyticsEscape(row.purchaseDate)}</td><td class="p-3 text-right">$${analyticsMoney(row.amountUSD)}</td><td class="p-3 text-right">${analyticsMoney(row.rateLYD, 4)}</td><td class="p-3 text-right">${analyticsMoney(row.totalLYD || analyticsNumber(row.amountUSD) * analyticsNumber(row.rateLYD))} LYD</td><td class="p-3 text-right">$${analyticsMoney(remaining.get(String(row.id || '')) || 0)}</td><td class="p-3"><div class="font-medium">${analyticsEscape(row.source || '—')}</div><div class="text-xs text-slate-500">${analyticsEscape(row.note || '')}</div></td><td class="p-3 text-right"><button type="button" onclick="deleteDollarPurchase('${analyticsEscape(row.id)}')" class="p-2 rounded-lg text-rose-600 hover:bg-rose-50" aria-label="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td></tr>`).join('') : `<tr><td colspan="7" class="p-8 text-center text-slate-500">${isAr ? 'لم تسجل أي عملية شراء دولارات بعد.' : 'No dollar purchases recorded yet.'}</td></tr>`}</tbody></table></div>
      </div>
    </section>`;
  if (window.lucide) lucide.createIcons({ nodes: [root] });
}

function openDollarPurchaseManager() {
  if (!isCurrentUserAdmin()) { showNotification('Not Allowed', 'Only an Admin can manage dollar purchase costs.', 'error'); return; }
  closeDollarPurchaseManager(false);
  _dollarPurchaseTrigger = document.activeElement;
  const root = document.createElement('div');
  root.id = 'dollar-purchase-dialog';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '10001';
  document.body.appendChild(root);
  document.body.classList.add('overflow-hidden');
  renderDollarPurchaseDialog();
  setTimeout(() => document.querySelector('#dollar-purchase-form input')?.focus(), 0);
}

function closeDollarPurchaseManager(restoreFocus = true) {
  document.getElementById('dollar-purchase-dialog')?.remove();
  if (!document.getElementById('analytics-breakdown-dialog')) document.body.classList.remove('overflow-hidden');
  if (restoreFocus && _dollarPurchaseTrigger?.focus) _dollarPurchaseTrigger.focus();
}

function updateDollarPurchasePreview() {
  const form = document.getElementById('dollar-purchase-form');
  const output = document.getElementById('dollar-purchase-total');
  if (!form || !output) return;
  output.textContent = `${analyticsMoney(analyticsNumber(form.amountUSD?.value) * analyticsNumber(form.rateLYD?.value))} LYD`;
}

async function saveDollarPurchase(event) {
  event?.preventDefault();
  if (!isCurrentUserAdmin()) return;
  const form = event?.currentTarget || document.getElementById('dollar-purchase-form');
  if (!form || !form.reportValidity()) return;
  const amountUSD = analyticsNumber(form.amountUSD.value);
  const rateLYD = analyticsNumber(form.rateLYD.value);
  const purchaseDate = String(form.purchaseDate.value || '');
  const today = analyticsLocalDateISO();
  if (amountUSD <= 0 || rateLYD <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) || purchaseDate > today) {
    showNotification('Check the values', 'Enter a valid past or current date, USD amount, and market rate.', 'error');
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  const ok = await addRecord(state.dollarPurchases, {
    purchaseDate,
    amountUSD: Math.round(amountUSD * 100) / 100,
    rateLYD: Math.round(rateLYD * 10000) / 10000,
    totalLYD: Math.round(amountUSD * rateLYD * 100) / 100,
    source: String(form.source.value || '').trim(),
    note: String(form.note.value || '').trim(),
    createdAt: new Date().toISOString()
  });
  if (ok) {
    showNotification('Dollar purchase saved', 'Profit and inventory were recalculated.', 'success');
    renderDollarPurchaseDialog();
    if (state.currentView === 'analytics') RenderQueue.schedule('profitability-purchase');
  } else if (submit) submit.disabled = false;
}

async function deleteDollarPurchase(id) {
  if (!isCurrentUserAdmin() || !Security.isValidRecordId(id)) return;
  if (!confirm('Delete this dollar purchase? Profit and inventory will be recalculated.')) return;
  const ok = await deleteRecord(state.dollarPurchases, id);
  if (ok) {
    showNotification('Dollar purchase deleted', 'Profit and inventory were recalculated.', 'success');
    renderDollarPurchaseDialog();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('dollar-purchase-dialog')) closeDollarPurchaseManager();
    else if (document.getElementById('analytics-breakdown-dialog')) closeAnalyticsBreakdown();
  });
}
