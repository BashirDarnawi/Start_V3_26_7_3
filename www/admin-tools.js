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

// Written the one way (DESIGN.md 5.4): "$1,234.50", "1,234.50 LYD", in Arabic "1,234.50 د.ل".
// In Arabic an amount is one piece with its own direction (moneyPiece, 07); this file also runs alone in its tests.
function analyticsPiece(text, rtl) {
  return typeof moneyPiece === 'function' ? moneyPiece(text, rtl) : text;
}
function analyticsUsd(value) {
  const text = analyticsMoney(value);
  return analyticsPiece(text[0] === '-' ? `-$${text.slice(1)}` : `$${text}`);
}
function analyticsLyd(value) {
  const text = analyticsMoney(value);
  if (!(typeof state !== 'undefined' && state.language === 'ar')) return `${text} LYD`;
  return analyticsPiece(`${text[0] === '-' ? analyticsPiece(text) : text} د.ل`, true);
}

function analyticsEscape(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

function analyticsDateValue(value) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? `${value}T00:00:00` : value;  // local midnight, like the lots
  const time = new Date(day || 0).getTime();
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
  const frozenFinalSpend = getFrozenFinalAdSpendUSD(ad);
  if (frozenFinalSpend !== null) return frozenFinalSpend;
  const metaMinor = Number(ad.metaSpendMinor);
  // Meta reports in the ad account's currency; only USD accounts are dollars.
  if (ad.metaAdId && Number.isFinite(metaMinor) && metaMinor >= 0 && String(ad.metaCurrency || 'USD').toUpperCase() === 'USD') {
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
    ? [ad?.stoppedAt, ad?.endDate, ad?.metaSyncedAt, ad?.startDate, ad?.createdAt, ad?._created]
    : [ad?.metaSyncedAt, ad?.stoppedAt, ad?.endDate, ad?.startDate, ad?.createdAt, ad?._created];  // the server writes metaSyncedAt
  for (const value of values) {
    const time = analyticsDateValue(value);
    if (time) return time;
  }
  return Date.now();
}

function _adFundingReceiptRateLYD(ad, receiptsById) {
  // The rate the customer actually paid: weighted over the funding receipts.
  // receiptsById (from the snapshot) holds the row find() would pick; other callers still scan.
  const receipts = state.receipts || [];
  const find = id => (id ? (receiptsById ? receiptsById.get(String(id)) || null : receipts.find(r => r && !r._deleted && String(r.id) === String(id))) : null);
  const rateOf = r => {
    const explicit = analyticsNumber(r?.exchangeRate);
    if (explicit > 0) return explicit;
    const usd = analyticsNumber(r?.amountUSD), local = analyticsNumber(r?.amountLocal);
    return usd > 0 && local > 0 ? local / usd : 0;
  };
  for (const key of ['receiptAllocations', 'dueAllocations', 'mergedPaidAllocations']) {
    let total = 0, weighted = 0;
    for (const alloc of (Array.isArray(ad?.[key]) ? ad[key] : [])) {
      const rate = rateOf(find(alloc?.receiptId)), amount = analyticsNumber(alloc?.amountUSD);
      if (rate > 0 && amount > 0) { weighted += rate * amount; total += amount; }
    }
    if (total > 0) return weighted / total;
  }
  for (const id of [ad?.fundingReceiptId, ad?.receiptId, ad?.linkedDeliveryReceiptId]) {
    const rate = rateOf(find(id));
    if (rate > 0) return rate;
  }
  return 0;
}

function getAdSaleRateLYD(ad, receiptsById) {
  // No local price on the ad means nobody agreed a sale rate with a customer;
  // pricing it at today's default rate would invent revenue that moves every
  // time the default rate is edited. It stays under "missing sale rate".
  if (!(analyticsNumber(ad?.amountLocal) > 0) && !(analyticsNumber(ad?.exchangeRate || ad?.rate) > 0)) return 0;
  // A paid ad funded by receipts earned the LYD those receipts carry, not the
  // default rate of the day the ad was typed in.
  if (typeof getAdPaymentState === 'function' && getAdPaymentState(ad) === 'paid') {
    const fundedRate = _adFundingReceiptRateLYD(ad, receiptsById);
    if (fundedRate > 0) return fundedRate;
  }
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

  // One receipt index per build (first live row per id, as find() picks): a find() per
  // allocation froze big workspaces. Not memoised: state.receipts changes in place.
  const receiptsById = new Map();
  for (const r of (Array.isArray(state.receipts) ? state.receipts : [])) {
    if (r && !r._deleted && !receiptsById.has(String(r.id))) receiptsById.set(String(r.id), r);
  }
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
    const saleRateLYD = getAdSaleRateLYD(event.ad, receiptsById);
    const recognizedRevenueLYD = paid && saleRateLYD > 0 ? (coveredCents / 100) * saleRateLYD : 0;
    const writtenOff = !paid && typeof getAdPaymentState === 'function' && getAdPaymentState(event.ad) === 'wont_pay';  // a known loss, not "not yet billed"
    rows.push({
      ad: event.ad,
      adId: String(event.ad.id || ''),
      eventTime: event.time,
      paid,
      writtenOff,
      soldBudgetUSD: Math.max(0, analyticsNumber(event.ad.amountUSD)),
      soldBudgetLYD: Math.max(0, analyticsNumber(event.ad.amountLocal)) || Math.max(0, analyticsNumber(event.ad.amountUSD)) * saleRateLYD,
      actualSpendUSD: event.spendCents / 100,
      coveredUSD: coveredCents / 100,
      unpricedUSD: neededCents / 100,
      saleRateLYD,
      costLYD,
      recognizedRevenueLYD,
      knownProfitLYD: paid ? recognizedRevenueLYD - costLYD : (writtenOff ? -costLYD : 0),
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
  const writtenOffRows = rows.filter(row => row.writtenOff);
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
    paidCoveredUSD: paidRows.reduce((sum, row) => sum + row.coveredUSD, 0),
    writtenOffCostLYD: writtenOffRows.reduce((sum, row) => sum + row.costLYD, 0),
    writtenOffSpendUSD: writtenOffRows.reduce((sum, row) => sum + row.actualSpendUSD, 0),
    knownGrossProfitLYD: paidRows.reduce((sum, row) => sum + row.knownProfitLYD, 0) + writtenOffRows.reduce((sum, row) => sum + row.knownProfitLYD, 0),
    unpricedSpendUSD: rows.reduce((sum, row) => sum + row.unpricedUSD, 0),
    unpaidSpendUSD: rows.filter(row => !row.paid && !row.writtenOff).reduce((sum, row) => sum + row.actualSpendUSD, 0),
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
      ? start.toLocaleDateString(typeof appDateLocale === 'function' ? appDateLocale() : 'en-GB', { month: 'short', year: 'numeric' })
      : kind === 'week'
        ? `${start.toLocaleDateString(typeof appDateLocale === 'function' ? appDateLocale() : 'en-GB', { day: '2-digit', month: 'short' })}`
        : start.toLocaleDateString(typeof appDateLocale === 'function' ? appDateLocale() : 'en-GB', { day: '2-digit', month: 'short' });
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
  // Same receipt sets as the KPI cards that open this dialog: Collection Status
  // counts carried balances (revenueReceipts), Receipts Volume does not (saleReceipts).
  const receipts = (Array.isArray(options.receipts) ? options.receipts : getVisibleRecords(state.receipts || []))
    .filter(row => row && !row._deleted && (typeof isTransferInReceipt !== 'function' || !isTransferInReceipt(row))
      && (metric === 'collection-status' || String(row.receiptType || '') !== 'CARRIED_BALANCE')
      && !(typeof getReceiptPaymentState === 'function' && ['canceled', 'lost'].includes(getReceiptPaymentState(row))));
  const profit = options.profitSnapshot || buildAdProfitabilitySnapshot(options.purchases || state.dollarPurchases || [], ads);
  const findPeriod = time => periods.find(period => time >= period.start && time < period.end);

  if (metric === 'ad-revenue') {
    for (const ad of ads) {
      if (!ad || ad._deleted || ad.recordType === 'receipt') continue;
      const paid = typeof getAdPaymentState === 'function' ? getAdPaymentState(ad) === 'paid' : !!ad.isPaid;
      const profitRow = profit.rowsByAdId.get(String(ad.id || ''));
      if (!paid && !profitRow?.writtenOff) continue;
      const period = findPeriod(analyticsRecordTime(ad, 'ad'));
      if (!period) continue;
      if (paid) {
        period.count += 1;
        period.primaryUSD += Math.max(0, analyticsNumber(getAdSpendUSD(ad)));
        period.secondaryUSD += profitRow?.actualSpendUSD || 0;
      }
      period.profitLYD += profitRow?.knownProfitLYD || 0;  // a written-off loss belongs to its period too
    }
  } else {
    for (const receipt of receipts) {
      const period = findPeriod(analyticsRecordTime(receipt, 'receipt'));
      if (!period) continue;
      const amount = Math.max(0, analyticsNumber(receipt.amountUSD));
      period.count += 1;
      if (metric === 'collection-status') {
        // A partly collected receipt splits: its collected share and what is left.
        const share = _receiptCollectedFraction(receipt);
        period.primaryUSD += amount * share;
        period.secondaryUSD += amount * (1 - share);
      } else {
        // A verified UNDERPAID completion rewrites amountUSD to the cash taken;
        // the sale is still debtAmountUSD — the card and the month close count that.
        const underpaid = !!receipt.deliveredAt && String(receipt.paymentResult || '') === 'UNDERPAID';
        period.primaryUSD += underpaid ? Math.max(amount, analyticsNumber(receipt.debtAmountUSD)) : amount;
      }
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
          <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 p-4"><p class="text-xs text-slate-500">${labels.primary}</p><p class="text-xl font-bold">${analyticsUsd(totals.primary)}</p></div>
          ${labels.secondary ? `<div class="rounded-2xl bg-amber-50 dark:bg-amber-950/40 p-4"><p class="text-xs text-slate-500">${labels.secondary}</p><p class="text-xl font-bold">${analyticsUsd(totals.secondary)}</p></div>` : ''}
          ${showProfit ? `<div class="rounded-2xl bg-cyan-50 dark:bg-cyan-950/40 p-4"><p class="text-xs text-slate-500">${isAr ? 'ربح معروف' : 'Known profit'}</p><p class="text-xl font-bold">${analyticsLyd(totals.profit)}</p></div>` : ''}
        </div>
        <div class="space-y-2 mb-6" aria-label="Trend chart">
          ${data.periods.map(row => `<div class="grid grid-cols-[64px_1fr_90px] sm:grid-cols-[90px_1fr_120px] items-center gap-3 text-xs">
            <span class="text-slate-500">${analyticsEscape(row.label)}</span>
            <div class="h-5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
              <div class="h-full bg-indigo-500" style="width:${Math.max(0, row.primaryUSD / maxValue * 100)}%"></div>
              ${row.secondaryUSD ? `<div class="h-full bg-amber-400" style="width:${Math.max(0, row.secondaryUSD / maxValue * 100)}%"></div>` : ''}
            </div>
            <span class="font-semibold text-right">${analyticsUsd(row.primaryUSD)}</span>
          </div>`).join('')}
        </div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-700">
          <table class="w-full min-w-[620px] text-sm">
            <thead class="bg-slate-50 dark:bg-slate-800"><tr><th class="p-3 text-left">${isAr ? 'الفترة' : 'Period'}</th><th class="p-3 text-right">${isAr ? 'العدد' : 'Count'}</th><th class="p-3 text-right">${labels.primary}</th>${labels.secondary ? `<th class="p-3 text-right">${labels.secondary}</th>` : ''}${showProfit ? `<th class="p-3 text-right">${isAr ? 'الربح المعروف' : 'Known profit'}</th>` : ''}</tr></thead>
            <tbody>${data.periods.slice().reverse().map(row => `<tr class="border-t border-slate-100 dark:border-slate-800"><td class="p-3 font-medium">${analyticsEscape(row.label)}</td><td class="p-3 text-right">${row.count}</td><td class="p-3 text-right">${analyticsUsd(row.primaryUSD)}</td>${labels.secondary ? `<td class="p-3 text-right">${analyticsUsd(row.secondaryUSD)}</td>` : ''}${showProfit ? `<td class="p-3 text-right ${row.profitLYD >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${analyticsLyd(row.profitLYD)}</td>` : ''}</tr>`).join('')}</tbody>
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
        <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'إيراد معترف به' : 'Recognized revenue'}</p><p class="text-xl font-bold text-emerald-700">${analyticsLyd(snapshot.paidRevenueLYD)}</p><p class="text-xs text-slate-500 mt-1">${analyticsUsd(snapshot.paidCoveredUSD ?? snapshot.paidActualSpendUSD)} ${isAr ? 'إنفاق مدفوع مُسعَّر' : 'priced paid spend'}</p></div>
        <div class="rounded-2xl bg-rose-50 dark:bg-rose-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'تكلفة فيسبوك' : 'Facebook cost'}</p><p class="text-xl font-bold text-rose-700">${analyticsLyd(snapshot.paidCostLYD)}</p><p class="text-xs text-slate-500 mt-1">${isAr ? 'من دفعات الدولار المسجلة' : 'from recorded USD lots'}</p></div>
        <div class="rounded-2xl ${profitPositive ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'bg-rose-50 dark:bg-rose-950/30'} p-4"><p class="text-xs text-slate-500">${isAr ? 'الربح الإجمالي المعروف' : 'Known gross profit'}</p><p class="text-xl font-bold ${profitPositive ? 'text-cyan-700' : 'text-rose-700'}">${analyticsLyd(snapshot.knownGrossProfitLYD)}</p><p class="text-xs text-slate-500 mt-1">${isAr ? 'الإيراد ناقص تكلفة الدولار' : 'revenue minus dollar cost'}</p></div>
        <div class="rounded-2xl bg-indigo-50 dark:bg-indigo-950/30 p-4"><p class="text-xs text-slate-500">${isAr ? 'مخزون الدولار المتبقي' : 'Remaining USD inventory'}</p><p class="text-xl font-bold text-indigo-700">${analyticsUsd(snapshot.inventoryUSD)}</p><p class="text-xs text-slate-500 mt-1">${analyticsLyd(snapshot.inventoryCostLYD)} ${isAr ? 'تكلفة' : 'cost'}</p></div>
      </div>
      ${(snapshot.unpricedSpendUSD > 0 || snapshot.missingSaleRateUSD > 0 || snapshot.unpaidSpendUSD > 0) ? `<div class="mt-4 p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
        <strong>${isAr ? 'يحتاج إكمال:' : 'Needs attention:'}</strong>
        ${snapshot.unpaidSpendUSD > 0 ? `${isAr ? 'إنفاق على إعلانات غير مدفوعة (دولارات استُهلكت ولم تُحصَّل بعد)' : 'spend on unpaid ads (dollars used, not yet billed)'}: ${analyticsUsd(snapshot.unpaidSpendUSD)}.` : ''}
        ${snapshot.writtenOffSpendUSD > 0 ? ` ${isAr ? 'إنفاق مشطوب (لن يُدفع، محسوب كخسارة)' : 'written-off spend (will not be paid, counted as a loss)'}: ${analyticsUsd(snapshot.writtenOffSpendUSD)} = ${analyticsLyd(snapshot.writtenOffCostLYD)}.` : ''}
        ${snapshot.unpricedSpendUSD > 0 ? `${isAr ? 'إنفاق بلا تكلفة دولار' : 'spend without a recorded dollar cost'}: ${analyticsUsd(snapshot.unpricedSpendUSD)}.` : ''}
        ${snapshot.missingSaleRateUSD > 0 ? `${isAr ? 'إنفاق مدفوع بلا سعر بيع' : 'paid spend without a sale rate'}: ${analyticsUsd(snapshot.missingSaleRateUSD)}.` : ''}
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
            <div class="rounded-xl bg-white dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي ما دفعته' : 'Total paid'}</p><p id="dollar-purchase-total" class="text-xl font-bold text-indigo-700 mt-1">${analyticsLyd(0)}</p></div>
            <label class="text-sm font-medium sm:col-span-2">${isAr ? 'المصدر أو الحساب (اختياري)' : 'Source/account (optional)'}<input name="source" maxlength="120" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl" placeholder="${isAr ? 'مثال: السوق / الحساب المسبق 1' : 'Example: Market / Prepaid Balance 1'}"></label>
            <label class="text-sm font-medium sm:col-span-2">${isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}<input name="note" maxlength="240" class="glass-input mt-1 w-full px-3 py-2.5 rounded-xl"></label>
          </div>
          <div class="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><p class="text-xs text-slate-500">${isAr ? 'السجل غير قابل للتعديل. لتصحيح خطأ، احذفه وأنشئه من جديد.' : 'Records are immutable. To correct a mistake, delete it and create it again.'}</p><button type="submit" class="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold">${isAr ? 'حفظ شراء الدولار' : 'Save Dollar Purchase'}</button></div>
        </form>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3"><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي المشترى' : 'Total purchased'}</p><p class="font-bold">${analyticsUsd(snapshot.totalPurchasedUSD)}</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إجمالي التكلفة' : 'Total cost'}</p><p class="font-bold">${analyticsLyd(snapshot.totalPurchaseCostLYD)}</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'المتبقي' : 'Inventory'}</p><p class="font-bold">${analyticsUsd(snapshot.inventoryUSD)}</p></div><div class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3"><p class="text-xs text-slate-500">${isAr ? 'إنفاق بلا تكلفة' : 'Unpriced spend'}</p><p class="font-bold ${snapshot.unpricedSpendUSD ? 'text-amber-600' : 'text-emerald-600'}">${analyticsUsd(snapshot.unpricedSpendUSD)}</p></div></div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-700"><table class="w-full min-w-[720px] text-sm"><thead class="bg-slate-50 dark:bg-slate-800"><tr><th class="p-3 text-left">${isAr ? 'التاريخ' : 'Date'}</th><th class="p-3 text-right">USD</th><th class="p-3 text-right">${isAr ? 'السعر' : 'Rate'}</th><th class="p-3 text-right">${isAr ? 'التكلفة' : 'Cost'}</th><th class="p-3 text-right">${isAr ? 'المتبقي' : 'Remaining'}</th><th class="p-3 text-left">${isAr ? 'المصدر / الملاحظة' : 'Source / note'}</th><th class="p-3"></th></tr></thead><tbody>${purchases.length ? purchases.map(row => `<tr class="border-t border-slate-100 dark:border-slate-800"><td class="p-3 font-medium">${analyticsEscape(row.purchaseDate)}</td><td class="p-3 text-right">${analyticsUsd(row.amountUSD)}</td><td class="p-3 text-right">${analyticsMoney(row.rateLYD, 4)}</td><td class="p-3 text-right">${analyticsLyd(row.totalLYD || analyticsNumber(row.amountUSD) * analyticsNumber(row.rateLYD))}</td><td class="p-3 text-right">${analyticsUsd(remaining.get(String(row.id || '')) || 0)}</td><td class="p-3"><div class="font-medium">${analyticsEscape(row.source || '—')}</div><div class="text-xs text-slate-500">${analyticsEscape(row.note || '')}</div></td><td class="p-3 text-right"><button type="button" onclick="deleteDollarPurchase('${analyticsEscape(row.id)}')" class="p-2 rounded-lg text-rose-600 hover:bg-rose-50" aria-label="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button></td></tr>`).join('') : `<tr><td colspan="7" class="p-8 text-center text-slate-500">${isAr ? 'لم تسجل أي عملية شراء دولارات بعد.' : 'No dollar purchases recorded yet.'}</td></tr>`}</tbody></table></div>
      </div>
    </section>`;
  if (window.lucide) lucide.createIcons({ nodes: [root] });
}

function openDollarPurchaseManager() {
  if (!isCurrentUserAdmin()) { showNotification(state.language === 'ar' ? 'غير مسموح' : 'Not Allowed', state.language === 'ar' ? 'المدير فقط يمكنه إدارة تكاليف شراء الدولار.' : 'Only an Admin can manage dollar purchase costs.', 'error'); return; }
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
  output.textContent = analyticsLyd(analyticsNumber(form.amountUSD?.value) * analyticsNumber(form.rateLYD?.value));
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
    showNotification(state.language === 'ar' ? 'راجع القيم' : 'Check the values', state.language === 'ar' ? 'أدخل تاريخاً حالياً أو سابقاً ومبلغاً بالدولار وسعر السوق.' : 'Enter a valid past or current date, USD amount, and market rate.', 'error');
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
    showNotification(state.language === 'ar' ? 'تم حفظ شراء الدولار' : 'Dollar purchase saved', state.language === 'ar' ? 'أعيد حساب الربح والمخزون.' : 'Profit and inventory were recalculated.', 'success');
    renderDollarPurchaseDialog();
    if (state.currentView === 'analytics') RenderQueue.schedule('profitability-purchase');
  } else if (submit) submit.disabled = false;
}

async function deleteDollarPurchase(id) {
  if (!isCurrentUserAdmin() || !Security.isValidRecordId(id)) return;
  if (!await appConfirm(state.language === 'ar' ? 'حذف شراء الدولار هذا؟ سيُعاد حساب الربح والمخزون.' : 'Delete this dollar purchase? Profit and inventory will be recalculated.', 'delete')) return;
  const ok = await deleteRecord(state.dollarPurchases, id);
  if (ok) {
    showNotification(state.language === 'ar' ? 'تم حذف شراء الدولار' : 'Dollar purchase deleted', state.language === 'ar' ? 'أعيد حساب الربح والمخزون.' : 'Profit and inventory were recalculated.', 'success');
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
// ==========================================
// OWNER DASHBOARD: THE DAILY CONTROL CENTER (ADMIN)
// ==========================================
// The Admin's first screen after sign-in. It does not change accounting automatically. The "Today"
// tab lists the work that is waiting across the whole business (office, deliveries, collections, the
// Ads Studio desk, the Clothes System): each line shows the same sum its own screen shows and has one
// button that opens the list behind the number. Month close sits beside it. The "System and plans"
// tab keeps server upkeep (encrypted backup, connections, setup tasks, plan prices) out of the way of
// daily work. Design and sources, line by line: docs/redesign/ADMIN_DASHBOARD.md.

let _controlCenter = {
  loading: false,
  loadedAt: 0,
  operations: null,
  meta: null,
  error: '',
  period: '',
  tab: 'today',         // 'today' | 'system'
  userId: '',           // whose server answers are held here (another sign-in starts clean)
  studio: null,         // the Studio desk's own counter: counts only, never a name or an amount
  studioFailed: false,
  clothesAsked: false,  // the Clothes bundle was asked for once, for its two numbers
  check: null,          // the last month check: { period, totals, blockers }
  checking: false,
  dialog: null          // the open confirmation: { kind: 'close' | 'unlock', period, blockers, busy }
};

// Platform-owner screen; still, Arabic admins deserve Arabic messages.
function ccText(en, ar) {
  return state.language === 'ar' ? ar : en;
}

// A server or network error as the admin reads it. English: the server's own sentence. Arabic: the
// shared translation of a known refusal, else the Arabic fallback (never a raw English sentence
// under an Arabic title); the server's words stay in the console for whoever supports the office.
function ccErrorText(error, fallbackEn, fallbackAr) {
  const detail = error && error.payload && error.payload.detail;
  const raw = String((typeof detail === 'string' && detail) || (detail && detail.message) || (error && error.message) || '').trim();
  if (state.language !== 'ar') return raw || fallbackEn;
  const known = raw && typeof _serverRefusalText === 'function' ? _serverRefusalText(raw) : raw;
  if (known && /[\u0600-\u06FF]/.test(known)) return known;
  if (raw) console.warn('[control-center]', raw);
  return fallbackAr;
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
  const never = ccText('Never', 'أبداً');
  if (!Number.isFinite(number) || number <= 0) return never;
  try { return (typeof fmtDay === 'function' ? fmtDay(number, true) : new Date(number).toLocaleString()) || never; } catch (_) { return never; }
}

// One way of writing money on this screen: thousands separator, two decimals, the currency always shown.
function controlCenterLyd(value) {
  return controlCenterPiece(`${controlCenterMoney(value)} ${ccText('LYD', 'د.ل')}`, true);
}
function controlCenterUsd(value) {
  return controlCenterPiece(`$${controlCenterMoney(value)}`);
}
// In Arabic an amount is one piece with its own direction (moneyPiece, 07); this file also runs alone in its tests.
function controlCenterPiece(text, rtl) {
  return typeof moneyPiece === 'function' ? moneyPiece(text, rtl) : text;
}

function controlCenterLocale() {
  return typeof appDateLocale === 'function' ? appDateLocale() : undefined;
}

// "2026-10" as a person says it: "October 2026".
function controlCenterMonthName(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!match) return String(period || '');
  try { return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(controlCenterLocale(), { month: 'long', year: 'numeric' }); } catch (_) { return match[0]; }
}

// "12:04", for "Server checks updated 12:04".
function controlCenterClock(value) {
  try { return new Date(Number(value) || Date.now()).toLocaleTimeString(controlCenterLocale(), { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}

// Server answers belong to the person who asked for them: another sign-in starts clean.
function controlCenterKeepSession() {
  const userId = String(state.currentUser?.id || '');
  if (_controlCenter.userId === userId) return;
  Object.assign(_controlCenter, { userId, loadedAt: 0, operations: null, meta: null, error: '', studio: null, studioFailed: false, check: null, checking: false, tab: 'today' });
  closeControlCenterDialog(true);
}

// Month-close blockers carry a stable code; the server's English message is
// only the fallback for a code this screen does not know yet.
const CONTROL_CENTER_BLOCKER_TEXT = {
  ads_need_setup: ['Ads still need customer, amount, or payment setup', 'إعلانات تحتاج استكمال العميل أو المبلغ أو الدفع'],
  unpaid_receipts: ['Receipts are still unpaid', 'وصولات لا تزال غير مدفوعة'],
  ads_still_running: ['Ads from this month are still running (not stopped or completed)', 'إعلانات من هذا الشهر لا تزال تعمل (لم تُوقف ولم تكتمل)'],
  deliveries_open: ['Delivery jobs from this month are still open', 'مهام توصيل من هذا الشهر لا تزال مفتوحة'],
  driver_cash_not_handed_over: ['Drivers still hold cash collected for this month\'s deliveries', 'نقود توصيلات هذا الشهر لم تُسلَّم للمكتب بعد']
};
function controlCenterBlockerLine(item) {
  const pair = CONTROL_CENTER_BLOCKER_TEXT[String(item?.code || '')];
  return `${Array.isArray(pair) ? ccText(pair[0], pair[1]) : String(item?.message || item?.code || '')} (${Number(item?.count) || 0})`;
}

// Server setup tasks arrive as English sentences; show the known ones in Arabic.
const CONTROL_CENTER_SETUP_TASK_AR = {
  'Last backup is overdue - check the backup worker and the log': 'آخر نسخة احتياطية متأخرة — راجع عامل النسخ الاحتياطي والسجل',
  'Enable encrypted daily backups': 'فعّل النسخ الاحتياطي اليومي المشفّر',
  'Add a permanent backup encryption key': 'أضف مفتاح تشفير دائماً للنسخ الاحتياطية',
  'Connect private S3-compatible off-site storage': 'اربط تخزيناً خارجياً خاصاً متوافقاً مع S3',
  'Off-site backup copy is failing - check the S3 bucket, keys and region': 'النسخة الخارجية تفشل — راجع حاوية S3 والمفاتيح والمنطقة',
  'Connect an operations alert webhook': 'اربط رابط تنبيهات التشغيل (Webhook)'
};

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
    // Nor is a debt the company covered in full (it keeps Not Paid by design): the month
    // close (operations.py _customer_outstanding) and the dashboard use the same rule.
    // Without coverage fields the status alone decides, as on the server.
    if ((receipt.companyCoveredUSD != null || receipt.customerOutstandingUSD != null) && typeof _receiptCustomerOutstandingUSD === 'function' && _receiptCustomerOutstandingUSD(receipt) <= 0.005) return false;
    return true;
  });
  const metaFailures = ads.filter(ad => { const code = String(ad.metaSyncErrorCode || ad.metaLastErrorCode || '').trim(); return code && !['pending_enrichment', 'insights_unavailable', 'duplicate_link'].includes(code); });  // informational states are not failures
  const metaDuplicates = ads.filter(ad => String(ad.metaSyncErrorCode || '').trim() === 'duplicate_link');  // needs an unlink, not a retry
  let snapshot = null;
  try { snapshot = typeof getCurrentProfitabilitySnapshot === 'function' ? getCurrentProfitabilitySnapshot(ads) : null; } catch (_) {}
  return {
    ads,
    receipts,
    setupAds,
    unpaidReceipts,
    metaFailures,
    metaDuplicates,
    snapshot,
    attentionCount: setupAds.length + unpaidReceipts.length + metaFailures.length + metaDuplicates.length + ((snapshot?.unpricedSpendUSD || 0) > 0.005 ? 1 : 0)
  };
}

// The "Today" figures are counted over every receipt, ad and customer. The usual redraw (a live-sync
// poll with nothing new) reuses the last count instead of counting again. The key changes with any
// record of any stored list (its version and its deleted mark), the signed-in account, the exchange
// rate, the Clothes door arriving and the minute, so a figure is never older than one minute.
let _controlCenterTodayMemo = { key: '', today: null };

function controlCenterDataKey() {
  let key = `${state.currentUser?.id}|${state.defaultExchangeRate}|${typeof clothesOwnerSummary}|${Math.floor(Date.now() / 60000)}`;
  for (const name of PERSISTED_COLLECTIONS) {
    const rows = state[name];
    if (!Array.isArray(rows)) continue;
    let mix = rows.length;
    for (const row of rows) mix = (mix * 31 + (Number(row?._lastModified) || 0) % 1000003 + (row?._deleted ? 7 : 0)) | 0;
    key += `|${mix}`;
  }
  return key;
}

// Everything the "Today" tab shows that the browser already holds. Each figure comes from the function
// its own screen uses (named beside it), so the dashboard and that screen can never disagree.
function getControlCenterToday() {
  const key = controlCenterDataKey();
  if (_controlCenterTodayMemo.key !== key) _controlCenterTodayMemo = { key, today: countControlCenterToday() };
  return _controlCenterTodayMemo.today;
}

function countControlCenterToday() {
  const facts = getControlCenterFacts();
  const debtors = shellDebtorRows();  // Collect a debt: its own list
  return {
    facts,
    reconciliation: facts.ads.filter(ad => isAdReadyForReconciliation(ad) && !isAdReconciliationDone(ad)).length,  // Reconciliation: "Ads ready for review"
    delivery: getDeliveryStats(getDeliveryRows()),  // Deliveries: its tiles and "Pending Assignment"
    overdue: debtors.filter(row => row.overdue).length,  // Collect a debt: the "Overdue" filter
    owedLyd: debtors.reduce((sum, row) => sum + row.dueLyd, 0),  // Collect a debt: its total (Home: "Owed")
    month: shellMonthCollected(facts.receipts),  // Home: "Collected this month"
    clothes: typeof clothesOwnerSummary === 'function' ? clothesOwnerSummary() : null  // the Clothes System's own door
  };
}

// The Studio desk's counter as the server hands it over (GET /api/studio/staff/pulse): whole numbers only.
function controlCenterStudioCounts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const whole = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const stopRequests = whole(raw.stopRequests);
  return {
    stopRequests,
    waitingReview: whole(raw.waitingReview),
    // A stop request opens a queue row and a ticket: it is counted once, on its own line.
    otherTickets: Math.max(0, whole(raw.openTickets) - whole(raw.stopTicketsOpen)),
    paymentsWaiting: whole(raw.paymentsWaiting),
    // The lengths of the desk's own Launch and Settle lists, counted by the server for the Admin.
    toLaunch: whole(raw.toLaunch),
    toSettle: whole(raw.toSettle),
    alerts: whole(raw.alerts)
  };
}

// "Needs you today": one line per kind of waiting work, grouped by area. A line exists only while its
// count is above zero. `count` is the length of the list its button opens (a money line counts as one).
function getControlCenterAttention(today, studio) {
  const { facts, delivery, clothes } = today;
  const one = (count, single, many) => (count === 1 ? single : many);
  const groups = [];
  const group = (id, title, lines) => { const shown = lines.filter(Boolean); if (shown.length) groups.push({ id, title, lines: shown }); };
  const line = (id, count, tone, title, detail, label, open, icon = '') => (count > 0 ? { id, count, tone, title, detail, label, open, icon } : null);
  const unpriced = Number(facts.snapshot?.unpricedSpendUSD) || 0;

  group('office', ccText('Office', 'المكتب'), [
    line('ads-setup', facts.setupAds.length, 'amber',
      ccText(one(facts.setupAds.length, 'ad needs setup', 'ads need setup'), one(facts.setupAds.length, 'إعلان يحتاج استكمال البيانات', 'إعلانات تحتاج استكمال البيانات')),
      ccText('Add the customer, selling amount, payment and receipt.', 'أضف العميل وسعر البيع وبيانات الدفع والوصل.'),
      ccText('Open ads', 'فتح الإعلانات'), "controlCenterOpenAds('setup')"),
    line('receipts-unpaid', facts.unpaidReceipts.length, 'rose',
      ccText(one(facts.unpaidReceipts.length, 'receipt is unpaid', 'receipts are unpaid'), one(facts.unpaidReceipts.length, 'وصل غير مدفوع', 'وصولات غير مدفوعة')),
      ccText('Money customers still owe.', 'مبالغ لا تزال مستحقة على العملاء.'),
      ccText('Open receipts', 'فتح الوصولات'), 'controlCenterOpenReceipts()'),
    line('unpriced-spend', unpriced > 0.005 ? 1 : 0, 'rose',
      ccText(`${controlCenterUsd(unpriced)} of Meta spend has no purchase cost`, `إنفاق ميتا بقيمة ${controlCenterUsd(unpriced)} دون تكلفة شراء مسجلة`),
      ccText('Record the real dollar purchase so profit is not guessed.', 'سجّل التكلفة الفعلية لشراء الدولار حتى لا يُحسب الربح بالتخمين.'),
      ccText('Fix profit data', 'استكمال بيانات الربح'), "navigateTo('analytics')", 'circle-dollar-sign'),
    line('meta-duplicates', facts.metaDuplicates.length, 'amber',
      ccText(one(facts.metaDuplicates.length, 'ad shares its Meta ad with another', 'ads share one Meta ad'), one(facts.metaDuplicates.length, 'إعلان مرتبط بإعلان ميتا مستخدم في إعلان آخر', 'إعلانات مرتبطة بنفس إعلان ميتا')),
      ccText('Unlink the duplicate so both can sync again.', 'افصل الإعلان المكرر ليعود التزامن للاثنين.'),
      ccText('Review', 'مراجعة'), "navigateTo('ads')"),
    line('meta-retry', facts.metaFailures.length, 'rose',
      ccText(one(facts.metaFailures.length, 'Meta sync item needs a retry', 'Meta sync items need a retry'), one(facts.metaFailures.length, 'عنصر مزامنة ميتا يحتاج إعادة المحاولة', 'عناصر مزامنة ميتا تحتاج إعادة المحاولة')),
      ccText('The server keeps retrying; open Ads to inspect the affected rows.', 'يواصل الخادم إعادة المحاولة؛ افتح الإعلانات لمراجعة العناصر المتأثرة.'),
      ccText('Review', 'مراجعة'), "navigateTo('ads')"),
    line('reconciliation', today.reconciliation, 'blue',
      ccText(one(today.reconciliation, 'finished ad is waiting for reconciliation', 'finished ads are waiting for reconciliation'), one(today.reconciliation, 'إعلان منتهٍ بانتظار التسوية', 'إعلانات منتهية بانتظار التسوية')),
      ccText('Enter the real spend and return the rest.', 'أدخل الإنفاق الفعلي وأعد الباقي.'),
      ccText('Open', 'فتح'), "navigateTo('reconciliation')")
  ]);

  group('deliveries', ccText('Deliveries', 'التوصيل'), [
    line('delivery-unassigned', delivery.pendingAssignment, 'amber',
      ccText(one(delivery.pendingAssignment, 'delivery is waiting for a driver', 'deliveries are waiting for a driver'), one(delivery.pendingAssignment, 'توصيلة بانتظار تعيين سائق', 'توصيلات بانتظار تعيين سائق')),
      '', ccText('Assign', 'تعيين'), 'controlCenterOpenDeliveries()'),
    line('driver-cash', delivery.heldByDrivers, 'amber',
      ccText(one(delivery.heldByDrivers, 'delivery has cash still with its driver', 'deliveries have cash still with drivers'), one(delivery.heldByDrivers, 'توصيلة نقدها لا يزال مع السائق', 'توصيلات نقدها لا يزال مع السائقين')),
      ccText(`${controlCenterLyd(delivery.driverCashLYD)} not yet handed to the office.`, `${controlCenterLyd(delivery.driverCashLYD)} لم تُسلَّم للمكتب بعد.`),
      ccText('Open deliveries', 'فتح التوصيل'), 'controlCenterOpenDeliveries()')
  ]);

  group('collections', ccText('Collections', 'التحصيل'), [
    line('overdue', today.overdue, 'rose',
      ccText(one(today.overdue, 'customer is overdue', 'customers are overdue'), one(today.overdue, 'عميل متأخر عن السداد', 'عملاء متأخرون عن السداد')),
      ccText(`Oldest unpaid receipt older than ${SHELL_OVERDUE_DAYS} days.`, `أقدم وصل غير مدفوع تجاوز ${SHELL_OVERDUE_DAYS} يوماً.`),
      ccText('Collect', 'تحصيل'), 'controlCenterOpenOverdue()')
  ]);

  if (studio) {
    group('studio', ccText('Ads Studio', 'استوديو الإعلانات'), [
      // First in its group: a customer is waiting for their money to stop being spent.
      line('studio-stop', studio.stopRequests, 'rose',
        ccText(one(studio.stopRequests, 'stop request', 'stop requests'), one(studio.stopRequests, 'طلب إيقاف', 'طلبات إيقاف')),
        ccText('A customer asked to stop a running ad.', 'عميل طلب إيقاف إعلان يعمل.'),
        ccText('Open', 'فتح'), "controlCenterOpenDesk('tickets')"),
      line('studio-review', studio.waitingReview, 'blue',
        ccText(one(studio.waitingReview, 'request is waiting for review', 'requests are waiting for review'), one(studio.waitingReview, 'طلب بانتظار المراجعة', 'طلبات بانتظار المراجعة')),
        '', ccText('Review', 'مراجعة'), "controlCenterOpenDesk('requests')"),
      line('studio-payments', studio.paymentsWaiting, 'amber',
        ccText(one(studio.paymentsWaiting, 'payment is waiting for your confirmation', 'payments are waiting for your confirmation'), one(studio.paymentsWaiting, 'دفعة بانتظار تأكيدك', 'دفعات بانتظار تأكيدك')),
        '', ccText('Confirm', 'تأكيد'), "controlCenterOpenDesk('more')"),
      line('studio-tickets', studio.otherTickets, 'blue',
        ccText(one(studio.otherTickets, 'ticket is waiting for the team', 'tickets are waiting for the team'), one(studio.otherTickets, 'تذكرة بانتظار الفريق', 'تذاكر بانتظار الفريق')),
        ccText('Not counting stop requests.', 'دون طلبات الإيقاف.'),
        ccText('Answer', 'الرد'), "controlCenterOpenDesk('tickets')"),
      line('studio-launch', studio.toLaunch, 'blue',
        ccText(one(studio.toLaunch, 'approved request is waiting to be launched', 'approved requests are waiting to be launched'), one(studio.toLaunch, 'طلب مقبول بانتظار الإطلاق', 'طلبات مقبولة بانتظار الإطلاق')),
        ccText('Not linked to a Meta campaign yet.', 'لم تُربط بحملة في ميتا بعد.'),
        ccText('Launch', 'الإطلاق'), "controlCenterOpenDesk('launch')"),
      line('studio-settle', studio.toSettle, 'amber',
        ccText(one(studio.toSettle, 'ended ad is waiting to be settled', 'ended ads are waiting to be settled'), one(studio.toSettle, 'إعلان منتهٍ بانتظار التسوية', 'إعلانات منتهية بانتظار التسوية')),
        ccText('The final amount is not settled yet.', 'لم يُسوَّ المبلغ النهائي بعد.'),
        ccText('Settle', 'التسوية'), "controlCenterOpenDesk('settle')"),
      line('studio-alerts', studio.alerts, 'amber',
        ccText(one(studio.alerts, 'Studio alert', 'Studio alerts'), one(studio.alerts, 'تنبيه في الاستوديو', 'تنبيهات في الاستوديو')),
        ccText('From the last 24 hours, not yet acknowledged.', 'من آخر 24 ساعة، لم يُطّلع عليها بعد.'),
        ccText('Open health', 'فتح الحالة'), "controlCenterOpenDesk('health')")
    ]);
  }

  if (clothes) {
    const owed = Number(clothes.owedLYD) || 0;
    const few = Number(clothes.lowStockAt) || 0;
    group('clothes', ccText('Clothes', 'الملابس'), [
      line('clothes-low', Number(clothes.lowStock) || 0, 'amber',
        ccText(one(clothes.lowStock, 'item is running low', 'items are running low'), one(clothes.lowStock, 'صنف يوشك على النفاد', 'أصناف توشك على النفاد')),
        ccText(`${few === 2 ? 'Two' : few} pieces or fewer.`, few === 2 ? 'قطعتان أو أقل.' : `${few} قطع أو أقل.`),
        ccText('Open products', 'فتح البضاعة'), "controlCenterOpenAddress('clothes-system', 'tab=products')"),
      line('clothes-owed', owed > 0.005 ? 1 : 0, 'rose',
        ccText(`Customers still owe ${controlCenterLyd(owed)} on Clothes orders`, `متبقٍ عند الزبائن ${controlCenterLyd(owed)} في طلبات الملابس`),
        '', ccText('Open orders', 'فتح الطلبات'), "controlCenterOpenAddress('clothes-system', 'tab=orders')", 'banknote')
    ]);
  }
  return groups;
}

async function loadControlCenterStatus(force = false) {
  if (_controlCenter.loading) return;
  if (!force && _controlCenter.loadedAt && Date.now() - _controlCenter.loadedAt < 60000) return;
  // Local mode has no server to ask: the lines the browser works out stay, the rest says so.
  if (!isServerModeEnabled()) { _controlCenter.loadedAt = Date.now(); return; }
  _controlCenter.loading = true;
  _controlCenter.error = '';
  if (state.currentView === 'control-center') RenderQueue.schedule('control-center-loading');
  try {
    // The Studio hands the dashboard its desk counter through its own server door (counts only).
    const [operations, meta, studio] = await Promise.allSettled([apiOperationsStatus(), apiMetaAdsStatus(), apiJson('/api/studio/staff/pulse', { method: 'GET' }, { timeoutMs: 15000 })]);
    const errors = [];
    if (operations.status === 'fulfilled') _controlCenter.operations = operations.value;
    else errors.push(`${ccText('Server checks', 'فحوصات الخادم')}: ${ccErrorText(operations.reason, 'unavailable', 'غير متاحة')}`);
    if (meta.status === 'fulfilled') _controlCenter.meta = meta.value;
    else errors.push(`${ccText('Meta', 'ميتا')}: ${ccErrorText(meta.reason, 'unavailable', 'غير متاحة')}`);
    _controlCenter.studio = studio.status === 'fulfilled' ? controlCenterStudioCounts(studio.value) : null;
    _controlCenter.studioFailed = !_controlCenter.studio;
    _controlCenter.error = errors.join(' | ');
    _controlCenter.loadedAt = Date.now();
  } catch (error) {
    _controlCenter.error = ccErrorText(error, 'Could not load the server checks', 'تعذّر تحميل فحوصات الخادم');
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

function controlCenterOpenDeliveries() {
  state.deliveryFilter = {};
  navigateTo('deliveries');
}

// Collect a debt, already on its own "Overdue" filter.
function controlCenterOpenOverdue() {
  navigateTo('collect');
  if (state.currentView === 'collect') collectSetFilter('overdue');
}

// Opens a screen at its own address, the way a bookmark would: the screen (or its system, once its
// bundle has loaded) reads its tab from the address. The dashboard never reaches into a system.
function controlCenterOpenAddress(view, query) {
  openAddress(view, query);
}

// The Ads Studio team desk, at one of its own sections (requests, tickets, health, more).
function controlCenterOpenDesk(section) {
  controlCenterOpenAddress('ads-studio', `tab=review&section=${encodeURIComponent(section)}`);
}

function controlCenterSetTab(tab) {
  _controlCenter.tab = tab === 'system' ? 'system' : 'today';
  render();
}

function controlCenterChosenPeriod() {
  return String(document.getElementById('control-center-period')?.value || _controlCenter.period || controlCenterPreviousMonth());
}

// Where each month-close check leads, so its line can open the list behind it.
const CONTROL_CENTER_BLOCKER_OPEN = {
  ads_need_setup: ["controlCenterOpenAds('setup')", 'Open ads', 'فتح الإعلانات'],
  unpaid_receipts: ['controlCenterOpenReceipts()', 'Open receipts', 'فتح الوصولات'],
  ads_still_running: ["navigateTo('ads')", 'Open ads', 'فتح الإعلانات'],
  deliveries_open: ['controlCenterOpenDeliveries()', 'Open deliveries', 'فتح التوصيل'],
  driver_cash_not_handed_over: ['controlCenterOpenDeliveries()', 'Open deliveries', 'فتح التوصيل']
};
// What a check reads when it found nothing.
const CONTROL_CENTER_BLOCKER_CLEAR = {
  ads_need_setup: ['No ads need setup', 'لا إعلانات تحتاج استكمال البيانات'],
  unpaid_receipts: ['No receipts are unpaid', 'لا وصولات غير مدفوعة'],
  ads_still_running: ['No ads from this month are still running', 'لا إعلانات من هذا الشهر ما زالت تعمل'],
  deliveries_open: ['No delivery jobs from this month are open', 'لا مهام توصيل مفتوحة من هذا الشهر'],
  driver_cash_not_handed_over: ['No driver holds cash from this month', 'لا نقود من هذا الشهر مع السائقين']
};

function controlCenterBlockerName(item) {
  const pair = CONTROL_CENTER_BLOCKER_TEXT[String(item?.code || '')];
  return Array.isArray(pair) ? ccText(pair[0], pair[1]) : String(item?.message || item?.code || '');
}

// "Check month": the server's read-only preview. Its totals and its five checks are shown on the
// screen as lines (they used to be text inside a browser alert box).
async function previewControlCenterMonth() {
  const period = controlCenterChosenPeriod();
  if (_controlCenter.checking) return;
  _controlCenter.checking = true;
  if (state.currentView === 'control-center') render();
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    _controlCenter.check = { period, totals: preview?.totals || {}, blockers: Array.isArray(preview?.blockers) ? preview.blockers : [] };
  } catch (error) {
    showNotification(ccText('Month check failed', 'فشل فحص الشهر'), ccErrorText(error, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _controlCenter.checking = false;
    if (state.currentView === 'control-center') render();
  }
}

// "Close month": a fresh check first, then the app's own confirmation. With open checks the server
// requires a written reason (at least 10 characters); the dialog asks for it. No rule lives here.
async function closeControlCenterMonth() {
  const period = controlCenterChosenPeriod();
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
    _controlCenter.check = { period, totals: preview?.totals || {}, blockers };
    openControlCenterDialog({ kind: 'close', period, blockers });
  } catch (error) {
    showNotification(ccText('Could not close month', 'تعذر إقفال الشهر'), ccErrorText(error, 'Please try again.', 'لم يُقفل الشهر. راجع فحص الشهر ثم حاول مرة أخرى.'), 'error');
  }
}

// "Unlock": the server requires a written reason; the dialog asks for it.
function unlockControlCenterMonth(period) {
  openControlCenterDialog({ kind: 'unlock', period: String(period || ''), blockers: [] });
}

// ---- The dashboard's confirmation dialog (month close, month unlock) ----
// The app's own dialog instead of the browser's confirm and prompt boxes: it names the month, lists
// what is still open, and takes the written reason the server already requires.

function controlCenterDialogNeedsReason(dialog) {
  return dialog.kind === 'unlock' || dialog.blockers.length > 0;
}

function renderControlCenterDialog(dialog) {
  const month = Security.escapeHtml(controlCenterMonthName(dialog.period));
  const closing = dialog.kind === 'close';
  const needsReason = controlCenterDialogNeedsReason(dialog);
  const title = closing ? ccText(`Close ${month}?`, `إقفال ${month}؟`) : ccText(`Unlock ${month}?`, `فتح ${month}؟`);
  const lead = closing
    ? ccText('After closing, its receipts, ads and dollar purchases cannot be changed.', 'بعد الإقفال لا يمكن تعديل وصولاته وإعلاناته ومشتريات الدولار.')
    : ccText('Its receipts, ads and dollar purchases can be corrected again. Close it again when finished.', 'يمكن تصحيح وصولاته وإعلاناته ومشتريات الدولار من جديد. أقفله مجدداً عند الانتهاء.');
  const open = dialog.blockers.map(item => `<li><span>${Security.escapeHtml(controlCenterBlockerName(item))}</span><strong>${Number(item?.count) || 0}</strong></li>`).join('');
  const reasonLabel = closing ? ccText('Reason for closing with open items', 'سبب الإقفال مع وجود عناصر مفتوحة') : ccText('Reason for unlocking', 'سبب الفتح');
  const confirm = closing ? ccText(`Close ${month}`, `إقفال ${month}`) : ccText(`Unlock ${month}`, `فتح ${month}`);
  return `
    <div class="app-dialog-panel glass-panel w-full max-w-lg" dir="${state.language === 'ar' ? 'rtl' : 'ltr'}">
      <div class="app-dialog-titlebar">
        <h2 id="control-center-dialog-title" class="app-dialog-title">${title}</h2>
        <button type="button" onclick="closeControlCenterDialog()" class="app-dialog-close" aria-label="${ccText('Close', 'إغلاق')}"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <p id="control-center-dialog-lead" class="management-dialog-lead">${lead}</p>
      ${open ? `<p class="management-dialog-note">${ccText('Still open in this month:', 'ما زال مفتوحاً في هذا الشهر:')}</p><ul class="management-dialog-list">${open}</ul>` : ''}
      ${needsReason ? `
        <label for="control-center-dialog-reason" class="management-field-label">${reasonLabel}</label>
        <textarea id="control-center-dialog-reason" rows="3" maxlength="500" dir="auto" class="glass-input w-full rounded-xl px-3 py-2" aria-describedby="control-center-dialog-hint" oninput="controlCenterDialogTyped()"></textarea>
        <p id="control-center-dialog-hint" class="management-dialog-note">${ccText('At least 10 characters. Recorded in the audit log.', '10 أحرف على الأقل. يُسجَّل في سجل التدقيق.')}</p>` : ''}
      <p id="control-center-dialog-error" class="management-dialog-error" role="alert" hidden></p>
      <div class="management-button-row">
        <button type="button" onclick="closeControlCenterDialog()" class="app-dialog-cancel management-button">${ccText('Cancel', 'إلغاء')}</button>
        <button type="button" id="control-center-dialog-confirm" onclick="confirmControlCenterDialog()" class="management-button is-primary" ${needsReason ? 'disabled' : ''}>${confirm}</button>
      </div>
    </div>`;
}

function openControlCenterDialog(dialog) {
  closeControlCenterDialog(true);
  let opener = null;
  try { opener = document.activeElement || null; } catch (_) {}
  _controlCenter.dialog = { ...dialog, busy: false, opener };
  const host = document.createElement('div');
  host.id = 'control-center-dialog';
  host.className = 'mobile-dialog-overlay app-dialog-overlay fixed inset-0 z-[80] flex items-center justify-center p-4';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'control-center-dialog-title');
  host.setAttribute('aria-describedby', 'control-center-dialog-lead');
  host.innerHTML = renderControlCenterDialog(_controlCenter.dialog);
  host.onclick = event => { if (event.target === host) closeControlCenterDialog(); };
  host.onkeydown = controlCenterDialogKeydown;
  document.body.appendChild(host);
  try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(host); } catch (_) {}
  // The reason field first (there is something to type), else Cancel: never the confirming button.
  try { (host.querySelector('#control-center-dialog-reason') || host.querySelector('.app-dialog-cancel'))?.focus(); } catch (_) {}
}

function closeControlCenterDialog(force = false) {
  const dialog = _controlCenter.dialog;
  if (dialog?.busy && !force) return false;
  _controlCenter.dialog = null;
  try { document.getElementById('control-center-dialog')?.remove(); } catch (_) {}
  if (dialog && !force) { try { dialog.opener?.focus?.(); } catch (_) {} }
  return true;
}

// Escape closes; Tab stays inside the dialog.
function controlCenterDialogKeydown(event) {
  const host = document.getElementById('control-center-dialog');
  if (!host) return;
  if (event.key === 'Escape') { event.preventDefault(); closeControlCenterDialog(); return; }
  if (event.key !== 'Tab') return;
  const stops = Array.from(host.querySelectorAll('button:not([disabled]), textarea:not([disabled])'));
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// The confirming button wakes up once the reason is long enough (the server's own minimum).
function controlCenterDialogTyped() {
  const reason = String(document.getElementById('control-center-dialog-reason')?.value || '').trim();
  const confirm = document.getElementById('control-center-dialog-confirm');
  if (confirm) confirm.disabled = reason.length < 10 || !!_controlCenter.dialog?.busy;
}

async function confirmControlCenterDialog() {
  const dialog = _controlCenter.dialog;
  if (!dialog || dialog.busy) return;
  const reason = String(document.getElementById('control-center-dialog-reason')?.value || '').trim();
  const problem = document.getElementById('control-center-dialog-error');
  if (controlCenterDialogNeedsReason(dialog) && reason.length < 10) {
    if (problem) { problem.textContent = ccText('Please write at least 10 characters.', 'اكتب 10 أحرف على الأقل.'); problem.hidden = false; }
    return;
  }
  dialog.busy = true;
  const confirm = document.getElementById('control-center-dialog-confirm');
  if (confirm) confirm.disabled = true;
  const closing = dialog.kind === 'close';
  const period = dialog.period;
  try {
    if (closing) await apiCloseFinancialPeriod(period, reason);
    else await apiUnlockFinancialPeriod(period, reason);
    closeControlCenterDialog(true);
    _controlCenter.check = null;
    if (closing) showNotification(ccText('Month closed safely', 'تم إقفال الشهر بأمان'), ccText(`${period} is now protected from changes.`, `${period} أصبح محمياً من التعديل.`), 'success');
    else showNotification(ccText('Month unlocked', 'تم فتح الشهر'), ccText(`${period} can be corrected now. Close it again when finished.`, `يمكن تصحيح ${period} الآن. أقفله مجدداً عند الانتهاء.`), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    // The dialog stays open with what was typed; the server's refusal is shown in it.
    dialog.busy = false;
    if (confirm) confirm.disabled = false;
    const text = closing
      ? ccErrorText(error, 'The month was not closed. Please try again.', 'لم يُقفل الشهر. راجع فحص الشهر ثم حاول مرة أخرى.')
      : ccErrorText(error, 'The month was not unlocked. Please try again.', 'لم يُفتح الشهر. حاول مرة أخرى.');
    if (problem) { problem.textContent = text; problem.hidden = false; }
    else showNotification(closing ? ccText('Could not close month', 'تعذر إقفال الشهر') : ccText('Could not unlock month', 'تعذر فتح الشهر'), text, 'error');
  }
}

async function runControlCenterBackup() {
  try {
    showNotification(ccText('Backup started', 'بدأ النسخ الاحتياطي'), ccText('Please keep this page open while the server creates the encrypted copy.', 'أبقِ هذه الصفحة مفتوحة بينما ينشئ الخادم النسخة المشفرة.'), 'info');
    const response = await apiRunEncryptedBackup();
    // The server answers 200 when the local copy was saved but the off-site upload failed.
    if (response?.backup?.offsiteError) showNotification(ccText('Saved on this server only', 'حُفظت على هذا الخادم فقط'), `${ccText('The off-site copy failed:', 'فشلت النسخة الخارجية:')} ${String(response.backup.offsiteError)}`, 'warning');
    else showNotification(ccText('Backup complete', 'اكتمل النسخ الاحتياطي'), response?.backup?.offsite ? ccText('Encrypted backup saved locally and off-site.', 'حُفظت النسخة المشفرة محلياً وخارجياً.') : ccText('Encrypted backup saved.', 'حُفظت النسخة المشفرة.'), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    // 409: a backup is already running (the daily one, or an earlier press) - busy, not failed.
    if (error?.status === 409) showNotification(ccText('Backup already running', 'النسخ الاحتياطي يعمل الآن'), ccText('It will appear under Last backup when it finishes.', 'ستظهر تحت «آخر نسخة» عند انتهائه.'), 'info');
    else showNotification(ccText('Backup failed', 'فشل النسخ الاحتياطي'), ccErrorText(error, 'Please try again.', 'لم تُنشأ النسخة. حاول مرة أخرى.'), 'error');
  }
}

// ---- Subscription plans manager (owner pricing without redeploys) ----
let _planManager = { loading: false, loadedAt: 0, failedAt: 0, version: 0, plans: [], error: '', dirty: false, saving: false, addOpen: false };
// Mirrors the server's KNOWN_SERVICE_IDS; the server re-validates anyway.
const PLAN_MANAGER_SERVICE_IDS = ['international_shipping', 'local_shipping', 'warehouse', 'smart_systems', 'clothes_system', 'ad_maker'];

// The service's own name in the screen language (the raw id, e.g. clothes_system, showed in Arabic too).
function planManagerServiceName(serviceId) {
  // A Smart System sold on its own (Clothes, Ads Studio) is named in its own list.
  const service = (typeof SERVICES === 'object' && SERVICES ? SERVICES[String(serviceId)] : null)
    || (typeof SMART_SYSTEMS_CHILDREN === 'object' && SMART_SYSTEMS_CHILDREN ? SMART_SYSTEMS_CHILDREN[String(serviceId)] : null);
  if (!service) return String(serviceId);
  return String((state.language === 'ar' ? service.nameAr : service.name) || serviceId);
}

async function loadPlanManager(force = false) {
  if (_planManager.loading || !isServerModeEnabled()) return;
  if (!force && _planManager.loadedAt && Date.now() - _planManager.loadedAt < 60000) return;
  if (!force && _planManager.dirty) return; // never clobber unsaved edits
  // After a failure only Reload asks at once: every render re-asked, looping while offline.
  if (!force && _planManager.failedAt && Date.now() - _planManager.failedAt < 30000) return;
  _planManager.loading = true;
  _planManager.error = '';
  try {
    const payload = await apiJson('/api/admin/subscription-plans', { method: 'GET' });
    _planManager.plans = Array.isArray(payload?.plans) ? payload.plans : [];
    _planManager.version = Number(payload?.version || 0);
    _planManager.loadedAt = Date.now();
    _planManager.failedAt = 0;
    _planManager.dirty = false;
  } catch (error) {
    _planManager.failedAt = Date.now();
    _planManager.error = ccErrorText(error, 'Could not load the plan catalog', 'تعذّر تحميل كتالوج الخطط');
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
    plan._priceText = String(value ?? '').slice(0, 20);  // a redraw shows what was typed ("12."), not "12.00"
    if (raw === '' || !Number.isFinite(parsed)) return;
    plan.priceMinor = Math.max(0, Math.round(parsed * 100));
  }
  else if (field === 'durationDays') plan.durationDays = Math.max(1, Math.min(3660, Math.trunc(Number(value) || 30)));
  else if (field === 'sortOrder') plan.sortOrder = Math.trunc(Number(value) || 0);
  else if (field === 'active') plan.active = value === true;
  else if (field === 'name' || field === 'nameAr') plan[field] = String(value || '').slice(0, 80);
  _planManager.dirty = true;
  // Update in place: no render() while typing (a redraw from elsewhere keeps the focus through the inputs' ids).
  const save = document.getElementById('plan-manager-save');
  if (save) save.disabled = _planManager.saving;
  document.getElementById('plan-manager-dirty')?.classList.remove('hidden');
}

async function planManagerReload() {
  if (_planManager.dirty && !await appConfirm(ccText('Discard unsaved plan changes and reload from the server?', 'تجاهل تغييرات الخطط غير المحفوظة وإعادة التحميل من الخادم؟'))) return;
  return loadPlanManager(true);
}

async function planManagerAddBundle(sure) {
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
  // An empty or unreadable price (a number box reports '' for "abc") must never silently
  // become a free bundle (as in planManagerSetField); a 0 LYD one is added only after a yes.
  const rawPrice = read('plan-new-price').replace(',', '.');
  const parsedPrice = Number(rawPrice);
  if (rawPrice === '' || !Number.isFinite(parsedPrice) || parsedPrice < 0 || parsedPrice > 1e10) {  // the server takes up to 1e12 minor
    showNotification(ccText('Enter the bundle price', 'أدخل سعر الباقة'), ccText('Type the price in LYD as a number, for example 150. Nothing was added.', 'اكتب السعر بالدينار كرقم، مثلاً 150. لم تتم إضافة الباقة.'), 'warning');
    return;
  }
  const priceMinor = Math.max(0, Math.round(parsedPrice * 100));
  // Asked once; after a yes the form is read and checked again.
  if (priceMinor === 0 && !sure) return await appConfirm(ccText('This bundle will be free for customers - add it anyway?', 'ستكون هذه الباقة مجانية للعملاء - هل تريد إضافتها على أي حال؟')) && planManagerAddBundle(1);
  _planManager.plans.push({
    id: rawId,
    serviceIds: services,
    name,
    nameAr,
    priceMinor,
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
  if (!_planManager.plans.length || _planManager.saving) return;
  _planManager.saving = true;
  const sentPlans = JSON.stringify(_planManager.plans);
  if (state.currentView === 'control-center') render();
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
    // Typed while this save was on its way: before, the reload below replaced it with the server's
    // copy and the "unsaved" hint went away without a word. It stays, marked unsaved, for the next save.
    const editedMeanwhile = JSON.stringify(_planManager.plans) !== sentPlans;
    _planManager.dirty = editedMeanwhile;
    _planManager.loadedAt = editedMeanwhile ? Date.now() : 0;
    showNotification(ccText('Plans saved', 'تم حفظ الخطط'), ccText(`Catalog version ${_planManager.version} is live — new purchases use it immediately.`, `الإصدار ${_planManager.version} من الكتالوج أصبح فعالاً — المشتريات الجديدة تستخدمه فوراً.`), 'success');
    if (typeof refreshSubscriptionPlans === 'function') refreshSubscriptionPlans(true).catch(() => {});
    if (!editedMeanwhile) loadPlanManager(true);
  } catch (error) {
    showNotification(ccText('Could not save plans', 'تعذر حفظ الخطط'), ccErrorText(error, 'Save failed', 'لم تُحفظ الخطط. أعد التحميل ثم حاول مرة أخرى.'), 'error');
  } finally {
    _planManager.saving = false;
    if (state.currentView === 'control-center') render();
  }
}

function renderPlanManagerSection() {
  if (!isServerModeEnabled()) return '';
  const rows = _planManager.plans.map((plan, index) => {
    const safeName = Security.escapeHtml(String(plan.name || plan.id));
    const services = (Array.isArray(plan.serviceIds) ? plan.serviceIds : []).map(planManagerServiceName).join(' + ');
    return `
      <div class="management-plan-row grid grid-cols-2 items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800 sm:grid-cols-[1.2fr_1fr_90px_80px_70px_70px]">
        <div class="min-w-0">
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالإنجليزية' : 'Plan name in English'}" id="plan-${index}-name" value="${safeName}" oninput="planManagerSetField(${index}, 'name', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 font-bold text-slate-800 focus:border-indigo-300 dark:text-white" />
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالعربية' : 'Plan name in Arabic'}" value="${Security.escapeHtml(String(plan.nameAr || ''))}" id="plan-${index}-name-ar" dir="rtl" oninput="planManagerSetField(${index}, 'nameAr', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 text-xs text-slate-500 focus:border-indigo-300" />
        </div>
        <div class="truncate text-xs text-slate-500" title="${Security.escapeHtml(String(plan.id))}">${Security.escapeHtml(services)}</div>
        <label class="text-xs text-slate-500 sm:text-right">LYD<input id="plan-${index}-price" type="number" min="0" step="0.01" value="${Security.escapeHtml(String(plan._priceText ?? (Math.max(0, Number(plan.priceMinor) || 0) / 100).toFixed(2)))}" oninput="planManagerSetField(${index}, 'priceLYD', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono font-bold dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">${ccText('Days', 'الأيام')}<input id="plan-${index}-days" type="number" min="1" max="3660" value="${Math.max(1, Number(plan.durationDays) || 30)}" oninput="planManagerSetField(${index}, 'durationDays', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">${ccText('Order', 'الترتيب')}<input id="plan-${index}-order" type="number" value="${Math.trunc(Number(plan.sortOrder) || 0)}" oninput="planManagerSetField(${index}, 'sortOrder', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="flex items-center justify-end gap-1 text-xs font-bold ${plan.active !== false ? 'text-emerald-600' : 'text-slate-400'}"><input type="checkbox" ${plan.active !== false ? 'checked' : ''} onchange="planManagerSetField(${index}, 'active', this.checked)" class="h-5 w-5 accent-emerald-600" />${ccText('On', 'مفعّلة')}</label>
      </div>`;
  }).join('');
  return `
      <section class="glass-panel rounded-3xl p-5 sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><div class="flex items-center gap-2"><i data-lucide="badge-dollar-sign" class="h-5 w-5 text-emerald-600"></i><h2 class="text-xl font-black text-slate-900 dark:text-white">${ccText('Subscription plans & prices', 'خطط الاشتراك والأسعار')}</h2></div>
          <p class="mt-1 text-sm text-slate-500">${ccText('Prices are LYD and live on the server — saving here changes what customers pay next, never what they already bought. Catalog version:', 'الأسعار بالدينار ومحفوظة على الخادم — الحفظ هنا يغيّر ما يدفعه العملاء لاحقاً، ولا يغيّر ما اشتروه سابقاً. إصدار الكتالوج:')} ${Number(_planManager.version) || 0}<span id="plan-manager-dirty"${_planManager.dirty ? '' : ' class="hidden"'}> · <span class="font-bold text-amber-600">${ccText('unsaved changes', 'تغييرات غير محفوظة')}</span></span></p></div>
          <div class="flex gap-2">
            <button type="button" onclick="planManagerReload()" class="min-h-11 rounded-xl border border-slate-300 px-4 font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">${ccText('Reload', 'إعادة التحميل')}</button>
            <button type="button" id="plan-manager-save" onclick="savePlanManager()" ${_planManager.dirty && !_planManager.saving ? '' : 'disabled'} class="min-h-11 rounded-xl bg-emerald-600 px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">${ccText('Save all plans', 'حفظ كل الخطط')}</button>
          </div>
        </div>
        ${_planManager.error ? `<div class="mb-3 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">${Security.escapeHtml(_planManager.error)}</div>` : ''}
        <div class="space-y-2">${rows || `<div class="text-sm text-slate-500">${_planManager.loading ? ccText('Loading plans…', 'جارٍ تحميل الخطط…') : ccText('Press Reload to fetch the plan catalog.', 'اضغط «إعادة التحميل» لجلب كتالوج الخطط.')}</div>`}</div>
        <details ${_planManager.addOpen ? 'open' : ''} ontoggle="_planManager.addOpen = this.open" class="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <summary class="cursor-pointer select-none font-bold text-slate-700 dark:text-slate-200">${ccText('Add a bundle (one subscription, many systems)', 'إضافة باقة (اشتراك واحد لعدة أنظمة)')}</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="text-xs font-bold text-slate-500">${ccText('Bundle id (letters/numbers/underscore)', 'معرّف الباقة (حروف إنجليزية/أرقام/شرطة سفلية)')}<input id="plan-new-id" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="pro_bundle" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Price (LYD)', 'السعر (د.ل)')}<input id="plan-new-price" type="number" min="0" step="0.01" required class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="150.00" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Name (English)', 'الاسم (بالإنجليزية)')}<input id="plan-new-name" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="Pro Bundle" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Name (Arabic)', 'الاسم (بالعربية)')}<input id="plan-new-name-ar" dir="rtl" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="الباقة الاحترافية" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Duration (days)', 'المدة (بالأيام)')}<input id="plan-new-days" type="number" min="1" max="3660" value="30" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
            <div class="text-xs font-bold text-slate-500">${ccText('Included systems', 'الأنظمة المشمولة')}<div class="mt-1 grid grid-cols-2 gap-1">${PLAN_MANAGER_SERVICE_IDS.map(sid => `<label class="flex items-center gap-2 rounded-lg bg-slate-100 px-2 py-1.5 dark:bg-slate-800"><input id="plan-new-svc-${sid}" type="checkbox" class="h-4 w-4 accent-indigo-600" /><span class="truncate">${Security.escapeHtml(planManagerServiceName(sid))}</span></label>`).join('')}</div></div>
          </div>
          <button type="button" onclick="planManagerAddBundle()" class="mt-3 min-h-11 rounded-xl bg-indigo-600 px-4 font-bold text-white">${ccText('Add to list (save to publish)', 'أضف إلى القائمة (احفظ للنشر)')}</button>
        </details>
      </section>`;
}

// ---- Drawing ----

function controlCenterSetPeriod(value) {
  _controlCenter.period = String(value || '');
  // A check belongs to the month it read: another month hides it.
  if (_controlCenter.check && _controlCenter.check.period !== _controlCenter.period) { _controlCenter.check = null; render(); }
}

const CONTROL_CENTER_TONES = { rose: 'is-danger', amber: 'is-warning', blue: 'is-info' };

// One line of "Needs you today": how many, why, and the one button that opens the list behind the number.
function renderControlCenterLine(line) {
  return `
    <li class="management-attention-row" data-attention="${line.id}">
      <span class="management-attention-count ${CONTROL_CENTER_TONES[line.tone] || 'is-info'}">${line.icon ? `<i data-lucide="${line.icon}" class="h-4 w-4" aria-hidden="true"></i>` : `<bdi>${line.count}</bdi>`}</span>
      <span class="management-attention-text"><strong>${Security.escapeHtml(line.title)}</strong>${line.detail ? `<span>${Security.escapeHtml(line.detail)}</span>` : ''}</span>
      <button type="button" onclick="${line.open}" class="management-button">${Security.escapeHtml(line.label)}</button>
    </li>`;
}

// A small coloured word: a dot and the state.
function controlCenterChip(text, tone = '') {
  return `<span class="management-chip ${tone}"><span aria-hidden="true"></span>${Security.escapeHtml(text)}</span>`;
}

function renderControlCenterNeedsServer() {
  return `<p class="management-note">${ccText('Needs the server connection.', 'يحتاج إلى اتصال الخادم.')}</p>`;
}

// The month check on the screen: the totals and the five checks, each a line with its own button.
function renderControlCenterCheck(check) {
  const found = new Map(check.blockers.map(item => [String(item?.code || ''), item]));
  const lines = Object.keys(CONTROL_CENTER_BLOCKER_TEXT).map(code => {
    const item = found.get(code);
    found.delete(code);
    const open = CONTROL_CENTER_BLOCKER_OPEN[code];
    const button = `<button type="button" onclick="${open[0]}" class="management-button">${ccText(open[1], open[2])}</button>`;
    if (!item) return `<li class="is-clear"><span class="management-attention-count is-ok"><i data-lucide="check" class="h-4 w-4" aria-hidden="true"></i></span><span class="management-attention-text"><strong>${ccText(...CONTROL_CENTER_BLOCKER_CLEAR[code])}</strong></span>${button}</li>`;
    return `<li><span class="management-attention-count is-warning"><bdi>${Number(item.count) || 0}</bdi></span><span class="management-attention-text"><strong>${Security.escapeHtml(controlCenterBlockerName(item))}</strong></span>${button}</li>`;
  });
  // A check this screen does not know yet: the server's own sentence, with its count.
  for (const item of found.values()) lines.push(`<li><span class="management-attention-count is-warning"><bdi>${Number(item?.count) || 0}</bdi></span><span class="management-attention-text"><strong>${Security.escapeHtml(controlCenterBlockerName(item))}</strong></span></li>`);
  const totals = check.totals || {};
  const total = (label, value) => `<div><dt>${label}</dt><dd><bdi>${controlCenterUsd(value)}</bdi></dd></div>`;
  return `
    <div class="management-check" role="status" data-month-check="${Security.escapeHtml(check.period)}">
      <h3>${Security.escapeHtml(controlCenterMonthName(check.period))}: ${check.blockers.length ? ccText('items to review before closing', 'عناصر للمراجعة قبل الإقفال') : ccText('no closing problems found', 'لا توجد مشاكل تمنع الإقفال')}</h3>
      <dl class="management-check-totals">${total(ccText('Receipts', 'الوصولات'), totals.receiptVolumeUSD)}${total(ccText('Ad sales', 'مبيعات الإعلانات'), totals.adSalesUSD)}${total(ccText('Ad spend (actual)', 'الإنفاق الإعلاني الفعلي'), totals.adSpendUSD ?? totals.metaSpendUSD)}</dl>
      <ul class="management-attention-list">${lines.join('')}</ul>
    </div>`;
}

function renderControlCenterMonthCard(server, operations) {
  const periods = Array.isArray(operations.financialPeriods) ? operations.financialPeriods : [];
  const closed = periods.filter(row => String(row.status || '').toLowerCase() === 'closed');
  const last = controlCenterPreviousMonth();
  const lastClosed = closed.some(row => String(row.period || '') === last);
  const known = !!_controlCenter.operations;
  const lastName = Security.escapeHtml(controlCenterMonthName(last));
  const check = _controlCenter.check && _controlCenter.check.period === _controlCenter.period ? _controlCenter.check : null;
  return `
    <section class="management-card management-month${known && !lastClosed ? ' is-due' : ''}" aria-labelledby="control-center-month-title">
      <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="lock-keyhole" class="h-5 w-5"></i></span><div><h2 id="control-center-month-title">${ccText('Month close', 'إقفال الشهر')}</h2><p>${ccText('Review first, then protect the finished month from accidental edits.', 'راجع الشهر المنتهي ثم احمه من التعديلات غير المقصودة.')}</p></div></div>
      ${!server ? renderControlCenterNeedsServer() : `
      ${known ? (lastClosed ? controlCenterChip(ccText(`${lastName} is closed`, `${lastName} مُقفل`), 'is-ok') : controlCenterChip(ccText(`${lastName} is still open`, `${lastName} لم يُقفل بعد`), 'is-warning')) : ''}
      <label for="control-center-period" class="management-field-label">${ccText('Month', 'الشهر')}</label><input id="control-center-period" type="month" max="${last}" value="${Security.escapeHtml(_controlCenter.period)}" onchange="controlCenterSetPeriod(this.value)" class="management-input">
      <div class="management-button-row"><button type="button" onclick="previewControlCenterMonth()" class="management-button" ${_controlCenter.checking ? 'disabled' : ''}>${_controlCenter.checking ? ccText('Checking…', 'جارٍ الفحص…') : ccText('Check month', 'فحص الشهر')}</button><button type="button" onclick="closeControlCenterMonth()" class="management-button is-primary">${ccText('Close month', 'إقفال الشهر')}</button></div>
      ${check ? renderControlCenterCheck(check) : ''}
      <div class="management-closed-periods">${closed.map(row => `<div data-period="${Security.escapeHtml(String(row.period || ''))}"><span><strong>${Security.escapeHtml(controlCenterMonthName(row.period))}</strong> · ${ccText('Closed', 'مُقفل')}</span><button type="button" onclick="unlockControlCenterMonth('${Security.escapeHtml(String(row.period || ''))}')" class="management-button is-warning">${ccText('Unlock', 'إعادة الفتح')}</button></div>`).join('') || `<p>${ccText('No months have been closed yet.', 'لم يُقفل أي شهر بعد.')}</p>`}</div>`}
    </section>`;
}

// What the server's setup sentences mean in plain words. The sentence itself (in Arabic where known)
// stays behind "Show technical steps" for whoever maintains the server.
const CONTROL_CENTER_SETUP_TASK_PLAIN = {
  'Last backup is overdue - check the backup worker and the log': ['The last backup is overdue.', 'آخر نسخة احتياطية متأخرة.', 'No backup file was made for two backup periods.', 'لم يُنشأ ملف نسخة احتياطية منذ فترتين.'],
  'Enable encrypted daily backups': ['Automatic encrypted backups are off.', 'النسخ الاحتياطي المشفّر التلقائي متوقف.', 'The server is not making a regular backup yet.', 'الخادم لا يُنشئ نسخة احتياطية دورية بعد.'],
  'Add a permanent backup encryption key': ['The backup encryption key is not set.', 'مفتاح تشفير النسخ الاحتياطية غير مضبوط.', 'An encrypted backup cannot be made until it is.', 'لا يمكن إنشاء نسخة مشفّرة قبل ضبطه.'],
  'Connect private S3-compatible off-site storage': ['No copy is kept outside this server.', 'لا توجد نسخة محفوظة خارج هذا الخادم.', 'Backups stay on this server only.', 'تبقى النسخ الاحتياطية على هذا الخادم فقط.'],
  'Off-site backup copy is failing - check the S3 bucket, keys and region': ['The copy outside this server is failing.', 'النسخة خارج هذا الخادم تفشل.', 'Backups are saved on this server only until the upload works again.', 'تُحفظ النسخ على هذا الخادم فقط حتى يعود الرفع للعمل.'],
  'Connect an operations alert webhook': ['Operations alerts are not connected.', 'تنبيهات التشغيل غير موصولة.', 'The server cannot send an alert when a backup or the server has a problem.', 'لا يستطيع الخادم إرسال تنبيه عند مشكلة في النسخ الاحتياطي أو الخادم.']
};

// A setup task: plain words first, the technical detail folded.
function renderControlCenterSetupTask(title, detail, steps, urgent = false) {
  return `
    <li class="management-setup-task${urgent ? ' is-urgent' : ''}">
      <p><strong>${Security.escapeHtml(title)}</strong> ${Security.escapeHtml(detail)}</p>
      ${steps ? `<details><summary>${ccText('Show technical steps', 'عرض الخطوات التقنية')}</summary><p>${Security.escapeHtml(steps)}</p></details>` : ''}
    </li>`;
}

// What both tabs need to know about the server's upkeep, worked out once.
function getControlCenterSystem() {
  const operations = _controlCenter.operations || {};
  const backup = operations.backup || {};
  const monitoring = operations.monitoring || {};
  const meta = _controlCenter.meta || {};
  const isAr = state.language === 'ar';
  const recentRate = Number(monitoring.recent_error_rate ?? monitoring.error_rate ?? 0), recentSample = Number(monitoring.recent_sample_size ?? monitoring.total_requests ?? 0);  // rolling window, not since-boot
  const p95 = Math.round(Number(monitoring.response_ms_p95 || 0));
  // "Connected" only says the S3 settings exist; a failed last upload means no copy outside this server.
  const offsiteFailed = !!(backup.offsiteConfigured && backup.lastOffsiteError);
  const backupConfigured = !!(backup.enabled && backup.encryptionReady && backup.offsiteConfigured && !offsiteFailed);
  const serverErrors = recentRate >= 0.05 && recentSample >= 50;
  const tasks = [];
  if (!meta.webhookConfigured) tasks.push(renderControlCenterSetupTask(
    ccText('Instant Meta notifications are not set up yet.', 'إشعارات ميتا الفورية لم تُضبط بعد.'),
    ccText('The app still checks Meta every few minutes.', 'يواصل التطبيق فحص ميتا كل بضع دقائق.'),
    ccText('Add ALBAYAN_META_WEBHOOK_VERIFY_TOKEN in Jelastic, then subscribe Meta to /api/meta-ads/webhook. Polling remains active until then.', 'أضف ALBAYAN_META_WEBHOOK_VERIFY_TOKEN في Jelastic، ثم اشترك في ميتا على /api/meta-ads/webhook. يبقى الفحص الدوري يعمل حتى ذلك الحين.')));
  if (serverErrors) tasks.push(renderControlCenterSetupTask(
    ccText('The server is reporting errors.', 'الخادم يسجّل أخطاء.'),
    ccText(`${(recentRate * 100).toFixed(1)}% of recent requests failed.`, `فشلت ${(recentRate * 100).toFixed(1)}% من الطلبات الأخيرة.`),
    ccText('Check the Jelastic logs.', 'راجع سجلات Jelastic.'), true));
  if (p95 >= 3000 && Number(monitoring.total_requests || 0) >= 50) tasks.push(renderControlCenterSetupTask(
    ccText('The server is answering slowly.', 'الخادم يستجيب ببطء.'),
    ccText(`The slowest normal requests take about ${p95} ms.`, `أبطأ الطلبات العادية تستغرق نحو ${p95} ms.`),
    ccText('Check database and container resources.', 'راجع موارد قاعدة البيانات والحاوية.')));
  let backupTrouble = offsiteFailed || !!backup.lastBackupError;
  (operations.setupTasks || []).forEach(task => {
    const sentence = String(task);
    const overdue = /overdue/i.test(sentence), failing = /failing/i.test(sentence);
    if (overdue || failing) backupTrouble = true;
    const plain = CONTROL_CENTER_SETUP_TASK_PLAIN[sentence];
    const steps = `${(isAr && CONTROL_CENTER_SETUP_TASK_AR[sentence]) || sentence}. ${overdue
      ? ccText('The backup worker has not produced a file for two intervals. Check the operations log and the backup volume.', 'لم يُنتج عامل النسخ الاحتياطي ملفاً منذ فترتين. راجع سجل التشغيل ومساحة النسخ الاحتياطية.')
      : failing ? ccText('The error is shown under Encrypted backup.', 'الخطأ ظاهر تحت «نسخة احتياطية مشفرة».')
      : ccText('This protection needs one server setting in Jelastic. No secret is shown in Albayan.', 'هذه الحماية تحتاج إعداداً واحداً في الخادم عبر Jelastic. لا يُعرض أي سر داخل البيان.')}`;
    // A sentence this screen does not know yet is shown as the server wrote it.
    tasks.push(plain ? renderControlCenterSetupTask(ccText(plain[0], plain[1]), ccText(plain[2], plain[3]), steps, overdue || failing) : renderControlCenterSetupTask(sentence, '', '', overdue || failing));
  });
  const connections = [
    { name: ccText('Meta read connection', 'اتصال قراءة ميتا'), ok: !!meta.configured, word: meta.configured ? ccText('Ready', 'جاهز') : ccText('Needs setup', 'يحتاج إعداداً') },
    { name: ccText('Instant Meta notifications', 'إشعارات ميتا الفورية'), ok: !!meta.webhookConfigured, soft: true, word: meta.webhookConfigured ? ccText('Ready', 'جاهزة') : ccText('Checking every few minutes', 'فحص كل بضع دقائق') },
    { name: ccText('Backup worker', 'عامل النسخ الاحتياطي'), ok: !!backup.workerRunning, word: backup.workerRunning ? ccText('Running', 'يعمل') : ccText('Not running', 'لا يعمل') },
    { name: ccText('Server health', 'حالة الخادم'), ok: recentRate < 0.05, danger: recentRate >= 0.05, word: recentSample ? `${(recentRate * 100).toFixed(1)}% ${ccText('errors', 'أخطاء')}` : ccText('Collecting data', 'جارٍ جمع البيانات'), note: `P95 ${p95} ms` }
  ];
  return { backup, offsiteFailed, backupConfigured, tasks, connections, urgent: backupTrouble || serverErrors };
}

function renderControlCenterSystem(server) {
  if (!server) return `<section class="management-card"><div class="management-section-heading"><div><h2>${ccText('System and plans', 'النظام والباقات')}</h2></div></div>${renderControlCenterNeedsServer()}</section>`;
  const { backup, offsiteFailed, tasks, connections } = getControlCenterSystem();
  return `
      <div class="management-system-layout">
        <section class="management-card" aria-labelledby="control-center-backup-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="archive-restore" class="h-5 w-5"></i></span><div><h2 id="control-center-backup-title">${ccText('Encrypted backup', 'نسخة احتياطية مشفرة')}</h2><p>${ccText('Keep a recoverable copy of your work.', 'احتفظ بنسخة يمكن استعادة العمل منها.')}</p></div></div>
          <dl class="management-facts"><div><dt>${ccText('Last backup', 'آخر نسخة')}</dt><dd>${Security.escapeHtml(controlCenterTimestamp(backup.lastBackupAt))}</dd></div><div><dt>${ccText('Off-site copy', 'النسخة الخارجية')}</dt><dd${offsiteFailed ? ' class="text-rose-600"' : ''}>${offsiteFailed ? ccText('Failing', 'متعطلة') : backup.offsiteConfigured ? ccText('Connected', 'متصلة') : ccText('Not connected', 'غير متصلة')}</dd></div>${backup.offsiteConfigured ? `<div><dt>${ccText('Last off-site copy', 'آخر نسخة خارجية')}</dt><dd>${Security.escapeHtml(controlCenterTimestamp(backup.lastOffsiteAt))}</dd></div>` : ''}</dl>
          ${backup.lastBackupError ? `<div class="management-alert">${Security.escapeHtml(backup.lastBackupError)}</div>` : ''}
          ${offsiteFailed ? `<div class="management-alert">${ccText('Off-site upload failed:', 'فشل رفع النسخة الخارجية:')} ${Security.escapeHtml(backup.lastOffsiteError)}</div>` : ''}
          <button type="button" onclick="runControlCenterBackup()" ${backup.enabled && backup.encryptionReady ? '' : 'disabled'} class="management-button is-primary management-full-button">${ccText('Create encrypted backup now', 'إنشاء نسخة مشفرة الآن')}</button>
          ${backup.enabled && backup.encryptionReady ? '' : `<p class="management-note">${ccText('Backups are not set up yet: see the setup tasks.', 'النسخ الاحتياطي لم يُضبط بعد: راجع مهام الإعداد.')}</p>`}
        </section>

        <section class="management-card" aria-labelledby="control-center-connections-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="network" class="h-5 w-5"></i></span><div><h2 id="control-center-connections-title">${ccText('Live connections', 'الاتصالات المباشرة')}</h2><p>${ccText('Readiness of the services running behind your workspace.', 'جاهزية الخدمات التي تعمل خلف مساحة العمل.')}</p></div></div>
          <ul class="management-connection-list">${connections.map(item => `<li>${controlCenterChip(item.word, item.ok ? 'is-ok' : item.danger ? 'is-danger' : item.soft ? '' : 'is-warning')}<strong>${item.name}</strong>${item.note ? `<small>${item.note}</small>` : ''}</li>`).join('')}</ul>
        </section>

        <section class="management-card management-setup" aria-labelledby="control-center-setup-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="list-checks" class="h-5 w-5"></i></span><div><h2 id="control-center-setup-title">${ccText('Setup tasks', 'مهام الإعداد')}</h2><p>${ccText('Things the server still needs. The technical steps are for whoever maintains it.', 'أمور ما زال الخادم يحتاجها. الخطوات التقنية لمن يتولى صيانته.')}</p></div><span class="management-count">${tasks.length}</span></div>
          ${tasks.length ? `<ul class="management-setup-list">${tasks.join('')}</ul>` : `<p class="management-note">${ccText('Nothing is waiting for setup.', 'لا شيء بانتظار الإعداد.')}</p>`}
        </section>
      </div>

      <div class="management-plan-workspace">${renderPlanManagerSection()}</div>`;
}

function renderControlCenterToday(server) {
  const today = getControlCenterToday();
  const groups = getControlCenterAttention(today, server ? _controlCenter.studio : null);
  const kinds = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const operations = _controlCenter.operations || {};
  // The Studio's lines come from the server: while it is being asked, or when it did not answer, say so
  // (never a zero that is not known).
  const studioNote = !server ? '' : (_controlCenter.studio ? '' : _controlCenter.studioFailed
    ? `<div class="management-attention-note"><span>${ccText('Could not read the Studio desk.', 'تعذّرت قراءة مكتب الاستوديو.')}</span><button type="button" onclick="navigateTo('ads-studio')" class="management-button">${ccText('Open the desk', 'فتح المكتب')}</button></div>`
    : `<div class="management-attention-note"><span>${ccText('Checking the Studio desk…', 'جارٍ فحص مكتب الاستوديو…')}</span></div>`);
  const checkedAt = controlCenterClock(_controlCenter.loadedAt);
  const list = kinds
    ? groups.map(group => `<h3 class="management-eyebrow" id="control-center-group-${group.id}">${Security.escapeHtml(group.title)}</h3><ul class="management-attention-list" aria-labelledby="control-center-group-${group.id}">${group.lines.map(renderControlCenterLine).join('')}</ul>`).join('')
    : `<div class="management-empty"><i data-lucide="circle-check" class="h-9 w-9"></i><h3>${ccText('Nothing needs you right now.', 'لا شيء يحتاجك الآن.')}</h3><p>${ccText(`Checked at ${checkedAt}`, `آخر فحص ${checkedAt}`)}</p></div>`;
  const month = today.month;
  const monthName = (() => { try { return month.now.toLocaleDateString(controlCenterLocale(), { month: 'long', year: 'numeric' }); } catch (_) { return ''; } })();
  const versus = month.pct === null ? ccText('first month on record', 'أول شهر مُسجَّل') : ccText(`${month.pct >= 0 ? '+' : ''}${month.pct}% vs last month`, `\u2066${month.pct >= 0 ? '+' : ''}${month.pct}%\u2069 مقابل الشهر الماضي`);
  const figure = (label, value, note, open) => `<button type="button" onclick="${open}" class="management-figure"><span>${label}</span><strong><bdi>${Security.escapeHtml(value)}</bdi></strong><small>${Security.escapeHtml(note)}</small></button>`;
  const system = server ? getControlCenterSystem() : null;
  const ready = system ? system.connections.filter(item => item.ok).length : 0;
  const tiles = shellMoreTiles();
  const tileLine = id => { const tile = tiles.find(item => item.id === id); return tile ? `${tile.name} · ${tile.sub}` : ''; };
  const door = (view, icon, name, sub) => `<button type="button" onclick="navigateTo('${view}')" class="management-door"><i data-lucide="${icon}" class="h-5 w-5" aria-hidden="true"></i><span><strong>${name}</strong><small>${sub}</small></span><i data-lucide="chevron-right" class="h-4 w-4 management-direction-icon" aria-hidden="true"></i></button>`;
  return `
      <div class="management-control-layout">
        <section class="management-card management-priority-panel" aria-labelledby="control-center-needs-title">
          <div class="management-section-heading"><div><h2 id="control-center-needs-title">${ccText('Needs you today', 'يحتاجك اليوم')}</h2><p>${kinds ? ccText(`${kinds} ${kinds === 1 ? 'kind' : 'kinds'} of work ${kinds === 1 ? 'is' : 'are'} waiting`, kinds === 1 ? 'نوع واحد من العمل بالانتظار' : `${kinds} أنواع من العمل بالانتظار`) : ccText('Work across the whole business that is waiting for a decision.', 'أعمال من كل أقسام النشاط بانتظار قرار.')}</p></div><span class="management-count">${kinds}</span></div>
          ${list}
          ${studioNote}
        </section>

        <aside class="management-protection-stack" aria-label="${ccText('Money and month close', 'الأموال وإقفال الشهر')}">
          <section class="management-card" aria-labelledby="control-center-money-title">
            <div class="management-section-heading"><div><h2 id="control-center-money-title">${ccText('Money at a glance', 'الأموال في لمحة')}</h2></div></div>
            <div class="management-figures">
              ${figure(ccText('Collected this month', 'المُحصَّل هذا الشهر'), controlCenterLyd(month.collectedLyd), `${monthName} · ${versus}`, "navigateTo('analytics')")}
              ${figure(ccText('Owed by customers', 'مستحق على العملاء'), controlCenterLyd(today.owedLyd), ccText('Today', 'اليوم'), "navigateTo('collect')")}
              ${figure(ccText('Known gross profit', 'الربح الإجمالي المعروف'), controlCenterLyd(today.facts.snapshot?.knownGrossProfitLYD), ccText('Based on recorded purchase costs', 'بحسب تكاليف الشراء المسجلة'), "navigateTo('analytics')")}
              ${figure(ccText('To collect on deliveries', 'للتحصيل في التوصيل'), controlCenterLyd(today.delivery.uncollectedLYD), ccText('Today', 'اليوم'), 'controlCenterOpenDeliveries()')}
            </div>
          </section>

          ${renderControlCenterMonthCard(server, operations)}

          <section class="management-card" aria-labelledby="control-center-system-title">
            <div class="management-section-heading"><div><h2 id="control-center-system-title">${ccText('System and plans', 'النظام والباقات')}</h2></div><button type="button" onclick="controlCenterSetTab('system')" class="management-button">${ccText('Open', 'فتح')}</button></div>
            ${!server ? renderControlCenterNeedsServer() : !_controlCenter.operations ? `<p class="management-note">${_controlCenter.loading ? ccText('Checking the server…', 'جارٍ فحص الخادم…') : ccText('The server checks could not be read.', 'تعذّرت قراءة فحوصات الخادم.')}</p>` : `<p class="management-note${system.urgent ? ' is-urgent' : ''}" data-system-summary>${ccText(`Protection: ${system.backupConfigured ? 'set up' : 'setup needed'}`, `الحماية: ${system.backupConfigured ? 'مهيّأة' : 'تحتاج إعداداً'}`)} · ${ccText(`Connections: ${ready} of ${system.connections.length} ready`, `الاتصالات: ${ready} من ${system.connections.length} جاهزة`)} · ${ccText(`${system.tasks.length} setup ${system.tasks.length === 1 ? 'task' : 'tasks'}`, `مهام الإعداد: ${system.tasks.length}`)}</p>`}
          </section>
        </aside>
      </div>

      <nav class="management-doors" aria-label="${ccText('Areas', 'الأقسام')}">
        ${door('analytics', 'megaphone', ccText('Albayan Manager', 'مدير البيان'), tileLine('ads'))}
        ${door('deliveries', 'truck', ccText('Deliveries', 'التوصيل'), tiles.find(item => item.id === 'deliveries')?.sub || '')}
        ${door('ads-studio', 'rocket', ccText('Ads Studio', 'استوديو الإعلانات'), ccText('Team desk', 'مكتب الفريق'))}
        ${door('clothes-system', 'shirt', ccText('Clothes System', 'نظام الملابس'), ccText('Stock and orders', 'المخزون والطلبات'))}
        ${door('users', 'users', ccText('Team', 'الفريق'), tiles.find(item => item.id === 'users')?.sub || '')}
        ${door('services-hub', 'grid-3x3', ccText('Services', 'الخدمات'), ccText('All platform services', 'كل خدمات المنصة'))}
      </nav>`;
}

function renderControlCenterView() {
  if (!isAdminRole(state.currentUser?.role)) return renderNoAccessView();
  controlCenterKeepSession();
  const server = isServerModeEnabled();
  if (!_controlCenter.period) _controlCenter.period = controlCenterPreviousMonth();
  if (!_controlCenter.loading && (!_controlCenter.loadedAt || Date.now() - _controlCenter.loadedAt > 60000)) {
    setTimeout(() => loadControlCenterStatus(false), 0);
  }
  if (server && !_planManager.loading && !_planManager.loadedAt && (!_planManager.failedAt || Date.now() - _planManager.failedAt > 30000)) {
    setTimeout(() => loadPlanManager(false), 0);
  }
  // The Clothes System hands over its two numbers through its own bundle: asked for once, and only
  // when there are Clothes records to count.
  if (typeof clothesOwnerSummary !== 'function' && !_controlCenter.clothesAsked && ((state.clothesProducts || []).length || (state.clothesOrders || []).length)) {
    _controlCenter.clothesAsked = true;
    setTimeout(() => ensureClothesSystemLoaded().then(() => { if (state.currentView === 'control-center' && typeof clothesOwnerSummary === 'function') render(); }), 0);
  }
  const isAr = state.language === 'ar';
  const system = _controlCenter.tab === 'system';
  const today = (() => { try { return new Date().toLocaleDateString(controlCenterLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) { return ''; } })();
  const live = !server ? ccText('This device only (local mode)', 'هذا الجهاز فقط (الوضع المحلي)')
    : _serverLiveSync.startupLoadPending ? ccText('Loading your records…', 'جارٍ تحميل سجلاتك…')
    : _serverLiveSync.failStreak > 0 ? ccText('Connection lost: showing the last figures', 'انقطع الاتصال: تُعرض آخر الأرقام')
    : ccText('Figures are live', 'الأرقام مباشرة');
  const checks = !server ? '' : _controlCenter.loading ? ccText('Checking server…', 'جارٍ فحص الخادم…')
    : _controlCenter.error ? ccText('Some checks could not be read', 'تعذّرت قراءة بعض الفحوصات')
    : _controlCenter.loadedAt ? ccText(`Server checks updated ${controlCenterClock(_controlCenter.loadedAt)}`, `تحديث فحوصات الخادم ${controlCenterClock(_controlCenter.loadedAt)}`)
    : ccText('Waiting for checks', 'بانتظار الفحوصات');
  const tab = (id, label) => `<button type="button" onclick="controlCenterSetTab('${id}')" class="management-tab${_controlCenter.tab === id ? ' is-active' : ''}" aria-pressed="${_controlCenter.tab === id ? 'true' : 'false'}">${label}</button>`;
  return `
    <div class="management-workspace control-workspace" dir="${isAr ? 'rtl' : 'ltr'}" data-control-tab="${_controlCenter.tab}">
      <header class="management-hero">
        <div class="management-hero-copy"><h1>${ccText('Daily Control Center', 'مركز المتابعة اليومي')}</h1><p>${Security.escapeHtml(today)} · ${live}</p></div>
        <div class="management-hero-side">
          <div class="management-tabs" role="group" aria-label="${ccText('What to show', 'ما يُعرض')}">${tab('today', ccText('Today', 'اليوم'))}${tab('system', ccText('System and plans', 'النظام والباقات'))}</div>
          ${server ? `<span class="management-status ${_controlCenter.error ? 'is-warning' : ''}" role="status"><span aria-hidden="true"></span>${checks}</span>` : ''}
          <button type="button" onclick="refreshControlCenter()" class="management-button"><i data-lucide="refresh-cw" class="h-4 w-4 ${_controlCenter.loading ? 'animate-spin' : ''}"></i>${ccText('Refresh', 'تحديث')}</button>
        </div>
      </header>

      ${_controlCenter.error ? `<div class="management-alert" role="alert"><strong>${ccText('Server checks could not be read. Try again.', 'تعذّرت قراءة فحوصات الخادم. حاول مرة أخرى.')}</strong><details><summary>${ccText('Show technical steps', 'عرض الخطوات التقنية')}</summary><p>${Security.escapeHtml(_controlCenter.error)}</p></details></div>` : ''}

      ${system ? renderControlCenterSystem(server) : renderControlCenterToday(server)}
    </div>`;
}
// PERMISSIONS MANAGER ARABIC TEXT (lazy admin-tools.js): ~14 KB of Arabic does
// not fit the startup budget. Keyed by the PERMISSION_MODULES / PERMISSION_TEMPLATES
// keys (which never change); permText() in the startup bundle reads it through
// permissionTextAr() and shows the English text until this bundle has loaded.
// Entries are [name, description].
const PERMISSION_TEXT_AR = {
  modules: {
    analytics: ['التحليلات', 'الوصول إلى لوحة المعلومات والتقارير'],
    ads: ['الإعلانات', 'إدارة الحملات الإعلانية'],
    receipts: ['الوصولات', 'إدارة الوصولات والمدفوعات'],
    customers: ['العملاء', 'إدارة علاقات العملاء'],
    pages: ['الصفحات', 'إدارة الصفحات'],
    deliveries: ['التوصيل', 'عمليات التوصيل'],
    users: ['المستخدمون', 'إدارة المستخدمين'],
    settings: ['الإعدادات', 'إعدادات النظام'],
    auditLogs: ['سجل التدقيق', 'سجل تتبع العمليات في النظام'],
    clothesProducts: ['الملابس — البضاعة', 'نظام الملابس: المنتجات والمخزون'],
    clothesShipments: ['الملابس — الشحنات', 'نظام الملابس: الشحنات القادمة'],
    clothesOrders: ['الملابس — الطلبات', 'نظام الملابس: طلبات الزبائن'],
    clothesSettings: ['الملابس — الإعدادات', 'نظام الملابس: الإعدادات الشخصية (سعر الصرف)'],
    adCampaignRequests: ['استوديو الإعلانات — طلبات الحملات', 'مسودات حملات العملاء الذاتية واعتمادها']
  },
  perms: {
    'analytics.view': ['عرض التحليلات', 'عرض لوحة المعلومات والتقارير'],
    'analytics.export': ['تصدير التقارير', 'تصدير بيانات التحليلات إلى CSV/PDF'],
    'analytics.viewFinancials': ['عرض الأرقام المالية', 'عرض الإيرادات والمؤشرات المالية'],
    'analytics.viewSensitive': ['عرض البيانات الحساسة', 'عرض التفاصيل المالية المفصّلة'],

    'ads.view': ['عرض الإعلانات', 'عرض كل الحملات الإعلانية'],
    'ads.viewOwn': ['عرض إعلاناته فقط', 'عرض الإعلانات التي أنشأها بنفسه فقط'],
    'ads.add': ['إنشاء إعلانات', 'إنشاء حملات إعلانية جديدة'],
    'ads.edit': ['تعديل الإعلانات', 'تعديل أي حملة إعلانية'],
    'ads.editOwn': ['تعديل إعلاناته فقط', 'تعديل الإعلانات التي أنشأها بنفسه فقط'],
    'ads.delete': ['حذف الإعلانات', 'حذف الحملات الإعلانية'],
    'ads.changeStatus': ['تغيير الحالة', 'تغيير حالة الإعلان (إيقاف مؤقت، إيقاف، إكمال)'],
    'ads.stopAd': ['إيقاف الإعلانات', 'إيقاف الإعلانات الجارية وإرجاع المبالغ'],
    'ads.assignDelivery': ['إسناد التوصيل', 'إسناد مهام التوصيل إلى السائقين'],
    'ads.viewPhotos': ['عرض الصور', 'عرض صور الإعلانات ولقطات الشاشة'],
    'ads.uploadPhotos': ['رفع الصور', 'رفع صور الإعلانات'],

    'receipts.view': ['عرض الوصولات', 'عرض كل الوصولات'],
    'receipts.viewOwn': ['عرض وصولاته فقط', 'عرض الوصولات التي أنشأها بنفسه فقط'],
    'receipts.add': ['إنشاء وصولات', 'إنشاء وصولات جديدة'],
    'receipts.edit': ['تعديل الوصولات', 'تعديل أي وصل'],
    'receipts.editOwn': ['تعديل وصولاته فقط', 'تعديل الوصولات التي أنشأها بنفسه فقط'],
    'receipts.delete': ['حذف الوصولات', 'حذف الوصولات'],
    'receipts.markCollected': ['تسجيل التحصيل', 'تعليم الوصولات كمحصَّلة'],
    'receipts.transfer': ['تحويل الرصيد', 'تحويل الرصيد بين الحسابات'],
    'receipts.viewHistory': ['عرض السجل', 'عرض سجل تعديلات الوصل'],
    'receipts.export': ['تصدير الوصولات', 'تصدير بيانات الوصولات'],

    'customers.view': ['عرض العملاء', 'عرض كل العملاء'],
    'customers.viewOwn': ['عرض عملائه فقط', 'عرض العملاء المسندين إليه فقط'],
    'customers.add': ['إضافة عملاء', 'إضافة عملاء جدد'],
    'customers.edit': ['تعديل العملاء', 'تعديل بيانات العملاء'],
    'customers.editOwn': ['تعديل عملائه فقط', 'تعديل العملاء المسندين إليه فقط'],
    'customers.delete': ['حذف العملاء', 'حذف العملاء'],
    'customers.viewBalance': ['عرض الرصيد', 'عرض الرصيد المالي للعميل'],
    'customers.viewContacts': ['عرض أرقام التواصل', 'عرض أرقام هواتف العملاء'],
    'customers.export': ['تصدير العملاء', 'تصدير بيانات العملاء'],

    'pages.view': ['عرض الصفحات', 'عرض كل الصفحات'],
    'pages.add': ['إضافة صفحات', 'إضافة صفحات جديدة'],
    'pages.edit': ['تعديل الصفحات', 'تعديل بيانات الصفحات'],
    'pages.delete': ['حذف الصفحات', 'حذف الصفحات'],
    'pages.linkCustomers': ['ربط العملاء', 'ربط العملاء بالصفحات'],

    'deliveries.view': ['عرض التوصيلات', 'عرض كل عمليات التوصيل'],
    'deliveries.viewOwn': ['عرض توصيلاته فقط', 'عرض التوصيلات المسندة إليه فقط'],
    'deliveries.accept': ['قبول التوصيلات', 'قبول التوصيلات المسندة إليه'],
    'deliveries.complete': ['إكمال التوصيلات', 'تعليم التوصيلات كمكتملة'],
    'deliveries.markCollected': ['تسجيل التحصيل', 'تعليم مبالغ التوصيل كمحصَّلة'],
    'deliveries.assign': ['إسناد التوصيلات', 'إسناد التوصيلات إلى السائقين'],
    'deliveries.reassign': ['إعادة إسناد التوصيلات', 'نقل التوصيلات إلى سائق آخر'],
    'deliveries.viewStats': ['عرض الإحصائيات', 'عرض إحصائيات التوصيل'],

    'users.view': ['عرض المستخدمين', 'عرض كل المستخدمين'],
    'users.add': ['إضافة مستخدمين', 'إضافة مستخدمين جدد'],
    'users.edit': ['تعديل المستخدمين', 'تعديل بيانات المستخدمين'],
    'users.delete': ['حذف المستخدمين', 'حذف المستخدمين'],
    'users.managePermissions': ['إدارة الصلاحيات', 'إدارة صلاحيات المستخدمين'],
    'users.changeRole': ['تغيير الأدوار', 'تغيير أدوار المستخدمين'],
    'users.resetPassword': ['إعادة تعيين كلمة المرور', 'إعادة تعيين كلمات مرور المستخدمين'],
    'users.viewActivity': ['عرض النشاط', 'عرض سجلات نشاط المستخدمين'],

    'settings.view': ['عرض الإعدادات', 'عرض إعدادات النظام'],
    'settings.edit': ['تعديل الإعدادات', 'تعديل إعدادات النظام'],
    'settings.manageExchangeRate': ['إدارة سعر الصرف', 'تغيير أسعار الصرف'],

    'auditLogs.view': ['عرض سجل التدقيق', 'عرض كل سجلات التدقيق'],
    'auditLogs.viewOwn': ['عرض سجله فقط', 'عرض نشاطه الشخصي فقط'],
    'auditLogs.export': ['تصدير السجلات', 'تصدير سجلات التدقيق'],
    'auditLogs.clear': ['مسح السجلات', 'مسح سجلات التدقيق'],

    'clothesProducts.view': ['عرض كل البضاعة', 'عرض بضاعة كل المستخدمين (موظفو المنصة)'],
    'clothesProducts.viewOwn': ['عرض بضاعته فقط', 'عرض المنتجات التي أنشأها بنفسه فقط (مشترك)'],
    'clothesProducts.add': ['إضافة بضاعة', 'إنشاء منتجات جديدة'],
    'clothesProducts.edit': ['تعديل كل البضاعة', 'تعديل أي منتج'],
    'clothesProducts.editOwn': ['تعديل بضاعته فقط', 'تعديل المنتجات التي أنشأها بنفسه فقط'],
    'clothesProducts.delete': ['حذف كل البضاعة', 'حذف أي منتج'],
    'clothesProducts.deleteOwn': ['حذف بضاعته فقط', 'حذف المنتجات التي أنشأها بنفسه فقط'],

    'clothesShipments.view': ['عرض كل الشحنات', 'عرض شحنات كل المستخدمين (موظفو المنصة)'],
    'clothesShipments.viewOwn': ['عرض شحناته فقط', 'عرض الشحنات التي أنشأها بنفسه فقط (مشترك)'],
    'clothesShipments.add': ['إضافة شحنات', 'إنشاء شحنات جديدة'],
    'clothesShipments.edit': ['تعديل كل الشحنات', 'تعديل أي شحنة'],
    'clothesShipments.editOwn': ['تعديل شحناته فقط', 'تعديل الشحنات التي أنشأها بنفسه فقط'],
    'clothesShipments.delete': ['حذف كل الشحنات', 'حذف أي شحنة'],
    'clothesShipments.deleteOwn': ['حذف شحناته فقط', 'حذف الشحنات التي أنشأها بنفسه فقط'],

    'clothesOrders.view': ['عرض كل الطلبات', 'عرض طلبات كل المستخدمين (موظفو المنصة)'],
    'clothesOrders.viewOwn': ['عرض طلباته فقط', 'عرض الطلبات التي أنشأها بنفسه فقط (مشترك)'],
    'clothesOrders.add': ['إضافة طلبات', 'إنشاء طلبات جديدة'],
    'clothesOrders.edit': ['تعديل كل الطلبات', 'تعديل أي طلب'],
    'clothesOrders.editOwn': ['تعديل طلباته فقط', 'تعديل الطلبات التي أنشأها بنفسه فقط'],
    'clothesOrders.delete': ['حذف كل الطلبات', 'حذف أي طلب'],
    'clothesOrders.deleteOwn': ['حذف طلباته فقط', 'حذف الطلبات التي أنشأها بنفسه فقط'],

    'clothesSettings.viewOwn': ['عرض إعداداته', 'عرض إعدادات الملابس الخاصة به'],
    'clothesSettings.add': ['إنشاء الإعدادات', 'إنشاء سجل إعداداته الخاص'],
    'clothesSettings.editOwn': ['تعديل إعداداته', 'تعديل إعدادات الملابس الخاصة به'],

    'adCampaignRequests.view': ['عرض كل الطلبات', 'عرض كل طلبات حملات العملاء'],
    'adCampaignRequests.viewOwn': ['عرض طلباته فقط', 'عرض طلبات الحملات التي أنشأها بنفسه فقط'],
    'adCampaignRequests.add': ['إنشاء طلبات', 'إنشاء مسودات حملات'],
    'adCampaignRequests.edit': ['تعديل كل الطلبات', 'تعديل أي طلب حملة قابل للتعديل'],
    'adCampaignRequests.editOwn': ['تعديل طلباته فقط', 'تعديل مسوداته والتعديلات المطلوبة منه'],
    'adCampaignRequests.delete': ['حذف كل الطلبات', 'حذف طلبات الحملات المسموح بحذفها'],
    'adCampaignRequests.deleteOwn': ['حذف طلباته فقط', 'حذف مسوداته المسموح بحذفها'],
    'adCampaignRequests.submit': ['إرسال أي طلب', 'إرسال أي حملة مؤهلة للمراجعة'],
    'adCampaignRequests.submitOwn': ['إرسال طلباته', 'إرسال حملاته لمراجعة الموظفين'],
    'adCampaignRequests.review': ['مراجعة الطلبات', 'الاعتماد أو الرفض أو طلب تعديلات'],
    'adCampaignRequests.stop': ['إيقاف أي حملة', 'إيقاف أي حملة معتمدة وإرجاع ميزانيتها غير المصروفة'],
    'adCampaignRequests.stopOwn': ['إيقاف حملاته', 'إيقاف حملاته المعتمدة قبل بدئها مع استرجاع كامل']
  },
  templates: {
    fullAdmin: ['مدير بصلاحيات كاملة', 'وصول كامل إلى كل الميزات'],
    manager: ['مدير عمليات', 'إدارة العمليات دون إعدادات النظام'],
    salesAgent: ['مندوب مبيعات', 'المبيعات وإدارة العملاء'],
    deliveryDriver: ['سائق توصيل', 'عمليات التوصيل فقط'],
    accountant: ['محاسب', 'الوصول إلى الإدارة المالية'],
    viewer: ['قراءة فقط', 'عرض فقط دون أي تعديل'],
    clothesSubscriber: ['مشترك نظام الملابس', 'يدير تجارة الملابس الخاصة به ويرى بياناته فقط'],
    adsStudioCustomer: ['عميل استوديو الإعلانات', 'ينشئ حملاته الإعلانية ويرسلها فقط'],
    adsStudioReviewer: ['مراجع استوديو الإعلانات', 'يراجع حملات العملاء دون الوصول إلى البيانات المالية الداخلية'],
    appReviewDemo: ['حساب مراجعة المتجر', 'لمراجع المتجر: يرى فقط السجلات التي أنشأها هذا الحساب']
  }
};
// The startup bundle's typeof-guarded entry point (a function, like every lazy bundle's: a startup
// check of a later script's const can stay "undefined" once that check has run hot in a vm sandbox).
function permissionTextAr() { return PERMISSION_TEXT_AR; }
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

// The month the server files an ad under, mirroring _record_date in
// server/operations.py: the first of startDate, date, metaStartTime, createdAt,
// _created; timestamps and full ISO times count on the Tripoli calendar.
function _mergeAdPeriod(ad) {
  for (const key of ['startDate', 'date', 'metaStartTime', 'createdAt', '_created']) {
    const value = ad?.[key];
    if (value === null || value === undefined || value === '') continue;
    let when = null;
    if (typeof value === 'number') {
      when = new Date(Math.abs(value) < 100000000000 ? value * 1000 : value);
    } else {
      const textValue = String(value).trim();
      if (textValue.length > 10 && textValue.includes('T')) {
        const parsed = new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(textValue) ? textValue : `${textValue}Z`);
        if (!Number.isNaN(parsed.getTime())) when = parsed;
      }
      if (!when) {
        if (/^\d{4}-\d{2}-\d{2}/.test(textValue)) return textValue.slice(0, 7);
        continue;
      }
    }
    if (Number.isNaN(when.getTime())) continue;
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit' }).formatToParts(when);
      return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
    } catch (_) {
      return when.toISOString().slice(0, 7);
    }
  }
  return '';
}

// The months the server has closed, or null when they cannot be read. Only a
// server can close a month, so a local-only app has none.
async function _loadClosedMergePeriods() {
  if (!isServerModeEnabled()) return new Set();
  try {
    const rows = await apiJson('/api/admin/operations/financial-periods', { method: 'GET' }, { timeoutMs: 20000 });
    return new Set((Array.isArray(rows) ? rows : [])
      .filter(row => String(row?.status || '').toLowerCase() === 'closed')
      .map(row => String(row.period || '')));
  } catch (_) {
    return null;
  }
}

// The write sequence for ONE page. Returns a plain result instead of showing a
// toast, so merging 48 pages can report once at the end instead of 48 times.
// Order is the safety property: every ad lands on the Meta page BEFORE the old
// page is removed, so an interrupted run is always safe to repeat.
// closedPeriods: the Set from _loadClosedMergePeriods (the bulk run reads it
// once); left out, it is read here.
async function _mergeOnePageIntoMeta(keepPageId, losePageId, closedPeriods) {
  const isAr = state.language === 'ar';
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) return { ok: false, moved: 0, total: 0, name: '', keepName: '', reason: plan.blocked };
  const name = String(plan.losePage.name || '');
  const keepName = String(plan.keepPage.name || '');
  const total = plan.ads.length;
  let moved = 0;

  // The server refuses every edit of an ad in a closed month (423), this page
  // move included, so such a merge could never finish. Check before writing
  // anything: the admin learns which ads and months block it, and no ad is
  // moved into a half-merged page.
  const closed = closedPeriods === undefined ? await _loadClosedMergePeriods() : closedPeriods;
  if (!closed) {
    return {
      ok: false, moved, total, name, keepName,
      reason: isAr
        ? `«${name}»: تعذّر التحقق من الأشهر المغلقة، فلم يتغير شيء. أعد المحاولة.`
        : `"${name}": could not check which months are closed, so nothing was changed. Try again.`
    };
  }
  const lockedAds = plan.ads.filter(ad => closed.has(_mergeAdPeriod(ad)));
  if (lockedAds.length) {
    const separator = isAr ? '، ' : ', ';
    const months = [...new Set(lockedAds.map(_mergeAdPeriod))].sort().join(separator);
    const list = lockedAds.slice(0, 5).map(ad => `${_describeMergeAdCustomer(ad, isAr)} (${_mergeAdPeriod(ad)})`).join(separator)
      + (lockedAds.length > 5 ? ' …' : '');
    return {
      ok: false, moved, total, name, keepName, lockedAds: lockedAds.length,
      reason: isAr
        ? `«${name}»: ${lockedAds.length} من ${total} إعلان في أشهر مغلقة (${months}): ${list}. لم يُنقل أي إعلان ولم تُحذف الصفحة القديمة. يجب أن يعيد المدير فتح هذه الأشهر من مركز التحكم أولاً، ثم أعد الدمج.`
        : `"${name}": ${lockedAds.length} of ${total} ads are in closed months (${months}): ${list}. No ad was moved and the old page was kept. An Admin must unlock those months in the Control Center first, then merge again.`
    };
  }

  // Carry the hand-made page's owner across FIRST. An imported page arrives
  // with no owner at all, so this is usually the only place that knowledge
  // exists: it only adds ids, is safe to repeat, and must never be lost to a
  // delete. Read from live state, not the plan's snapshot.
  const liveKeepPage = getVisibleRecords(state.pages).find(page => String(page.id) === String(plan.keepPage.id)) || plan.keepPage;
  const keepOwnerIds = getPageCustomerIds(liveKeepPage).map(String);
  const addedOwnerIds = getPageCustomerIds(plan.losePage).map(String).filter(id => !keepOwnerIds.includes(id));
  if (addedOwnerIds.length) {
    const keepExpected = Number(liveKeepPage._lastModified);
    const ownersSaved = await updateRecord(
      state.pages,
      liveKeepPage.id,
      { customerIds: [...keepOwnerIds, ...addedOwnerIds] },
      Number.isFinite(keepExpected) ? keepExpected : undefined
    );
    if (!ownersSaved) {
      return {
        ok: false, moved, total, name, keepName,
        reason: isAr
          ? `«${name}»: تعذّر نسخ مالك الصفحة إلى صفحة Meta، فلم يُنقل أي إعلان ولم تُحذف الصفحة القديمة. أعد المحاولة.`
          : `"${name}": the owner could not be copied to the Meta page, so no ad was moved and the old page was kept. Run it again.`
      };
    }
  }

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
  // Two customers can each own a page with the same name. When both pages have owners and
  // share none, the bulk run leaves the pair alone: only the one-by-one dialog, which shows
  // both owners, may put two customers' ads under one page. jobs.differentOwners counts them.
  jobs.differentOwners = 0;
  for (const group of findPageMergeGroups()) {
    const keepOwners = getPageCustomerIds(group.keepPage).map(String);
    for (const losePage of group.manualPages) {
      const loseOwners = getPageCustomerIds(losePage).map(String);
      if (keepOwners.length && loseOwners.length && !loseOwners.some(id => keepOwners.includes(id))) {
        jobs.differentOwners += 1;
        continue;
      }
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
  if (!jobs.length && jobs.differentOwners) {
    showNotification(isAr ? 'ادمجها واحدة واحدة' : 'Merge these one by one',
      isAr ? `${jobs.differentOwners} صفحة لها نفس اسم صفحة Meta لكنها لعميل آخر. افتح كل واحدة وتأكد من المالك قبل الدمج.` : `${jobs.differentOwners} page(s) share a Meta page's name but belong to a different customer. Open each one and check the owner before merging.`, 'warning');
    return;
  }
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
          ${jobs.differentOwners ? `<div data-merge-all-skipped="${jobs.differentOwners}">• ${isAr ? `${jobs.differentOwners} صفحة لعميل مختلف عن صفحة Meta بنفس الاسم: لن تُدمج هنا. ادمجها واحدة واحدة بعد التأكد من المالك.` : `${jobs.differentOwners} page(s) belong to a different customer than the Meta page of the same name: they are not merged here. Merge them one by one after checking the owner.`}</div>` : ''}
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
    // Read the closed months once for the whole run; unreadable means nothing is written.
    const closedPeriods = await _loadClosedMergePeriods();
    if (!closedPeriods) {
      problems.push(isAr ? 'تعذّر التحقق من الأشهر المغلقة، فلم يُدمج شيء. أعد المحاولة.' : 'Could not check which months are closed, so nothing was merged. Try again.');
    }
    for (const job of closedPeriods ? jobs : []) {
      if (_mergeAllStopRequested) break;
      if (progress) {
        progress.textContent = isAr
          ? `جارٍ الدمج ${done + 1} من ${jobs.length}: ${job.name}`
          : `Merging ${done + 1} of ${jobs.length}: ${job.name}`;
      }
      let result;
      try {
        result = await _mergeOnePageIntoMeta(job.keepId, job.loseId, closedPeriods);
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
          const money = fmtUsd(partner.amountUSD);
          const when = partner.startDate ? new Date(partner.startDate) : null;
          const dateText = when && !Number.isNaN(when.getTime()) ? fmtDay(when) : '';
          return `<button type="button" onclick="showAdMergeDialog('${Security.escapeHtml(ids.keepId)}','${Security.escapeHtml(ids.draftId)}', this)" class="w-full text-start rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20">
            <div class="font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(_describeMergeAdCustomer(partner, isAr))}</div>
            <div class="mt-0.5 text-xs text-slate-500 break-all">
              ${String(partner.metaAdId || '').trim() ? `Meta #${Security.escapeHtml(String(partner.metaAdId))}` : `${isAr ? 'المبلغ' : 'Amount'}: ${money}`}
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

  const keepAmount = fmtUsd(plan.keepAd.amountUSD);
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
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300">${isAr ? 'المبلغ' : 'Amount'}: ${keepAmount}</div>
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
    // 0. While Meta has asked Albayan to wait, the unlink below still succeeds but neither the new
    //    link nor the restore can be made: the Meta ad ended up linked to neither copy and the pair
    //    was no longer offered for a retry. Ask first; nothing is changed unless Meta is reachable.
    let metaStatus = null;
    try { metaStatus = await apiMetaAdsStatus(); } catch (_) { metaStatus = null; }
    const metaProvider = metaStatus?.providerState && typeof metaStatus.providerState === 'object' ? metaStatus.providerState : {};
    const metaWaitSeconds = Math.max(0, Number(metaProvider.retryAfterSeconds || metaStatus?.remoteBackoffSeconds) || 0);
    if (!metaStatus || metaStatus.configured !== true || metaProvider.paused === true || metaWaitSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(metaWaitSeconds / 60));
      showNotification(
        isAr ? 'لم يتغير شيء' : 'Nothing was changed',
        !metaStatus
          ? (isAr ? 'تعذّر التحقق من اتصال Meta، فلم يبدأ الدمج. أعد المحاولة.' : 'The Meta connection could not be checked, so the merge did not start. Try again.')
          : metaStatus.configured !== true
            ? (isAr ? 'Meta غير متصل حالياً، فلم يبدأ الدمج.' : 'Meta is not connected right now, so the merge did not start.')
            : (isAr ? `طلبت Meta من البيان الانتظار. أعد الدمج بعد حوالي ${minutes} دقيقة.` : `Meta asked Albayan to wait. Merge again in about ${minutes} minute(s).`),
        'warning'
      );
      return;
    }

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
    // The link/unlink refusals are English server texts: say the known ones in the user's language
    // (a version conflict, the Meta link rules, then the shared map, e.g. a closed month).
    const raw = String(error?.message || '').trim();
    const metaText = raw && typeof metaAdsErrorMessage === 'function' ? metaAdsErrorMessage(error) : raw;
    const text = Number(error?.status) === 409 && /^conflict\b/i.test(raw)
      ? (isAr ? 'تغيّر الإعلان أثناء الدمج. حدّث البيانات ثم أعد المحاولة.' : 'The ad changed during the merge. Refresh and try again.')
      : (metaText !== raw ? metaText : _serverRefusalText(raw));
    showNotification(
      isAr ? 'تعذّر الدمج' : 'Merge failed',
      text || (isAr ? 'حدث خطأ أثناء الدمج. أعد المحاولة.' : 'Something went wrong during the merge. Try again.'),
      'error'
    );
  } finally {
    _mergeToolsBusy = '';
    resetAdMergePairCache();
    closeAdMergeDialog(false);
    render();
  }
}
