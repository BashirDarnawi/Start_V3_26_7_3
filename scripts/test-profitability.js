#!/usr/bin/env node
/** Regression tests for FIFO dollar-cost allocation and analytics periods. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const finalSpendSource = fs.readFileSync(path.join(__dirname, '..', 'src', '11b-ad-final-spend.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', '12a-analytics-profit.js'), 'utf8');
const state = { language: 'en', dollarPurchases: [], ads: [], receipts: [] };
let admin = true;
let financialAccess = true;
let createdElements = 0;
let notifications = 0;
const sandbox = {
  console,
  Date,
  Map,
  Math,
  Number,
  String,
  Array,
  Object,
  Security: {
    escapeHtml: value => String(value),
    isValidRecordId: () => true
  },
  state,
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    body: { classList: { add() {}, remove() {} }, appendChild() {} },
    createElement() { createdElements += 1; return { style: {}, remove() {} }; },
    activeElement: null
  },
  window: { lucide: null },
  getVisibleRecords: rows => rows.filter(row => row && !row._deleted),
  isTransferInReceipt: receipt => receipt.receiptType === 'TRANSFER_IN',
  getAdPaymentState: ad => ad.paymentStatus === 'wont_pay' ? 'wont_pay' : (ad.paymentStatus === 'paid' || ad.isPaid ? 'paid' : 'unpaid'),
  getAdSpendUSD: ad => Number(ad.spentUSD ?? ad.amountUSD ?? 0),
  getAdSpendExchangeRate: ad => Number(ad.exchangeRate || 0),
  isCurrentUserAdmin: () => admin,
  can: (module, action) => module === 'analytics' && action === 'viewFinancials' && financialAccess,
  showNotification() { notifications += 1; },
  confirm: () => true,
  addRecord: async () => true,
  deleteRecord: async () => true,
  RenderQueue: { schedule() {} },
  navigateTo() {},
  setTimeout: fn => fn()
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(finalSpendSource, sandbox, { filename: 'src/11b-ad-final-spend.js' });
vm.runInContext(source, sandbox, { filename: 'src/12a-analytics-profit.js' });

let passed = 0;
const failures = [];
function near(actual, expected, epsilon = 0.005) {
  if (Math.abs(Number(actual) - Number(expected)) > epsilon) {
    throw new Error(`expected ${expected}, received ${actual}`);
  }
}
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.log(`  FAIL  ${name}\n        ${error.message}`); }
}

test('a written-off (wont_pay) ad counts its dollars as a known loss, not "not yet billed"', () => {
  const snapshot = sandbox.buildAdProfitabilitySnapshot(
    [{ id: 'lot-w', purchaseDate: '2026-01-05', amountUSD: 1000, rateLYD: 9 }],
    [
      { id: 'lost-ad', status: 'Stopped', stoppedAt: '2026-01-20T10:00:00Z', spentUSD: 300, paymentStatus: 'wont_pay', amountUSD: 300, amountLocal: 2910 },
      { id: 'paid-ad', status: 'Stopped', stoppedAt: '2026-01-21T10:00:00Z', spentUSD: 100, paymentStatus: 'paid', amountUSD: 100, amountLocal: 970, exchangeRate: 9.7 }
    ]
  );
  near(snapshot.writtenOffSpendUSD, 300);
  near(snapshot.writtenOffCostLYD, 2700);
  near(snapshot.unpaidSpendUSD, 0);
  near(snapshot.knownGrossProfitLYD, 970 - 900 - 2700);
});

test('a paid ad funded by a receipt is priced at the rate the customer actually paid', () => {
  const previousReceipts = sandbox.state.receipts;
  sandbox.state.receipts = [{ id: 'rcpt-950', exchangeRate: 9.5, amountUSD: 100, amountLocal: 950 }];
  try {
    const snapshot = sandbox.buildAdProfitabilitySnapshot(
      [{ id: 'lot-r', purchaseDate: '2026-01-05', amountUSD: 100, rateLYD: 9 }],
      [{ id: 'funded-ad', status: 'Stopped', stoppedAt: '2026-01-20T10:00:00Z', spentUSD: 100, paymentStatus: 'paid',
         amountUSD: 100, amountLocal: 970, exchangeRate: 9.7, receiptAllocations: [{ receiptId: 'rcpt-950', amountUSD: 100 }] }]
    );
    near(snapshot.paidRevenueLYD, 950);
    near(snapshot.knownGrossProfitLYD, 50);
  } finally {
    sandbox.state.receipts = previousReceipts;
  }
});

test('legacy stopped spend stays final even when Meta later reports more', () => {
  near(sandbox.getAdActualSpendUSD({
    status: 'Stopped', spentUSD: 20, metaAdId: 'legacy-meta', metaSpendMinor: 2400
  }), 20);
});

test('active non-final spend continues to use the latest Meta reading', () => {
  near(sandbox.getAdActualSpendUSD({
    status: 'Active', spentUSD: 20, metaAdId: 'active-meta', metaSpendMinor: 2400
  }), 24);
});

test('an explicitly saved zero remains a valid stopped final spend', () => {
  near(sandbox.getAdActualSpendUSD({
    status: 'Stopped', spentUSD: 0, metaAdId: 'zero-meta', metaSpendMinor: 500
  }), 0);
});

test('FIFO uses only dollar lots available by the ad observation date', () => {
  const snapshot = sandbox.buildAdProfitabilitySnapshot([
    { id: 'lot1', purchaseDate: '2026-01-01', amountUSD: 10, rateLYD: 5 },
    { id: 'lot2', purchaseDate: '2026-01-03', amountUSD: 10, rateLYD: 7 }
  ], [
    { id: 'ad1', startDate: '2026-01-02', metaAdId: 'meta1', metaSpendMinor: 1200, paymentStatus: 'paid', exchangeRate: 9.5, amountUSD: 20 },
    { id: 'ad2', startDate: '2026-01-04', metaAdId: 'meta2', metaSpendMinor: 500, paymentStatus: 'unpaid', exchangeRate: 9.5, amountUSD: 10 }
  ]);
  const first = snapshot.rowsByAdId.get('ad1');
  near(first.coveredUSD, 10);
  near(first.unpricedUSD, 2);
  near(first.costLYD, 50);
  near(first.knownProfitLYD, 45);
  near(snapshot.inventoryUSD, 5);
  near(snapshot.knownGrossProfitLYD, 45);
  near(snapshot.unpricedSpendUSD, 2);
});

test('a later purchase never retroactively prices older spend', () => {
  const snapshot = sandbox.buildAdProfitabilitySnapshot(
    [{ id: 'future-lot', purchaseDate: '2026-02-10', amountUSD: 100, rateLYD: 8 }],
    [{ id: 'old-ad', startDate: '2026-02-01', metaAdId: 'm', metaSpendMinor: 2500, paymentStatus: 'paid', exchangeRate: 10 }]
  );
  near(snapshot.rows[0].coveredUSD, 0);
  near(snapshot.rows[0].knownProfitLYD, 0);
  near(snapshot.unpricedSpendUSD, 25);
  near(snapshot.inventoryUSD, 100);
});

test('a late sync cannot move a completed ad into a newer dollar-cost lot', () => {
  const snapshot = sandbox.buildAdProfitabilitySnapshot(
    [{ id: 'new-lot', purchaseDate: '2026-02-05', amountUSD: 100, rateLYD: 8 }],
    [{
      id: 'completed-ad', status: 'completed', endDate: '2026-02-03',
      metaSyncedAt: '2026-02-20T12:00:00Z', metaAdId: 'm2', metaSpendMinor: 2500,
      paymentStatus: 'paid', exchangeRate: 10
    }]
  );
  near(snapshot.rows[0].coveredUSD, 0);
  near(snapshot.unpricedSpendUSD, 25);
  near(snapshot.inventoryUSD, 100);
});

test('daily receipt breakdown excludes transfers and fills empty days', () => {
  const result = sandbox.buildAnalyticsBreakdown('receipts-volume', 'day', {
    now: new Date('2026-03-30T12:00:00').getTime(),
    ads: [],
    purchases: [],
    receipts: [
      { id: 'r1', date: '2026-03-30T10:00:00', amountUSD: 15 },
      { id: 'r2', date: '2026-03-29T10:00:00', amountUSD: 20 },
      { id: 'r3', date: '2026-03-30T11:00:00', amountUSD: 999, receiptType: 'TRANSFER_IN' }
    ]
  });
  if (result.periods.length !== 30) throw new Error('daily breakdown must contain 30 periods');
  near(result.periods.reduce((sum, row) => sum + row.primaryUSD, 0), 35);
  if (result.periods.reduce((sum, row) => sum + row.count, 0) !== 2) throw new Error('wrong receipt count');
});

test('weekly collection breakdown separates collected and outstanding cash', () => {
  const result = sandbox.buildAnalyticsBreakdown('collection-status', 'week', {
    now: new Date('2026-03-30T12:00:00').getTime(), ads: [], purchases: [],
    receipts: [
      { id: 'r1', date: '2026-03-30T10:00:00', amountUSD: 40, collected: true },
      { id: 'r2', date: '2026-03-30T11:00:00', amountUSD: 25, collected: false }
    ]
  });
  if (result.periods.length !== 12) throw new Error('weekly breakdown must contain 12 periods');
  near(result.periods.reduce((sum, row) => sum + row.primaryUSD, 0), 40);
  near(result.periods.reduce((sum, row) => sum + row.secondaryUSD, 0), 25);
});

test('profit controls render only for an Admin', () => {
  const snapshot = sandbox.buildAdProfitabilitySnapshot([], []);
  admin = false;
  if (sandbox.renderProfitabilityPanel(snapshot, false) !== '') throw new Error('non-admin saw profit panel');
  admin = true;
  if (!sandbox.renderProfitabilityPanel(snapshot, false).includes('Record Dollar Purchase')) throw new Error('admin control missing');
});

test('financial breakdown dialog refuses users without financial permission', () => {
  financialAccess = false;
  const beforeElements = createdElements;
  const beforeNotifications = notifications;
  sandbox.openAnalyticsBreakdown('receipts-volume');
  if (createdElements !== beforeElements) throw new Error('unauthorized financial dialog was created');
  if (notifications !== beforeNotifications + 1) throw new Error('permission warning was not shown');
  financialAccess = true;
});

if (failures.length) {
  console.error(`\nProfitability tests failed (${failures.length}):`);
  failures.forEach(failure => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`\nProfitability tests passed: ${passed}`);
