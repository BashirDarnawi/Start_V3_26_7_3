// Deterministic work-count regressions against source, with synthetic data only.
// No timing thresholds, network, live server, or persistence writes.
const assert = require('node:assert/strict');
const loadBrowserSource = require('./helpers/load-browser-source');

const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const f = loadBrowserSource();
  // The minimal loader has no browser textContent -> innerHTML conversion.
  const create = f.sandbox.document.createElement;
  f.sandbox.document.createElement = (...args) => {
    const element = create(...args);
    let text = '';
    let html = '';
    Object.defineProperty(element, 'textContent', { get: () => text, set: value => {
      text = String(value);
      html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    } });
    Object.defineProperty(element, 'innerHTML', { get: () => html, set: value => { html = String(value); } });
    return element;
  };
  return f;
}
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL  ${name}: ${error.message}`); }
}

function customersFixture() {
  const f = fixture();
  f.state.customers = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, name: `Customer ${i}`, createdBy: 'admin', joinDate: '2026-01-01'
  }));
  f.state.ads = f.state.customers.flatMap(c => Array.from({ length: 10 }, (_, i) => ({
    id: `${c.id}_ad${i}`, customerId: c.id, amountUSD: 10, amountLocal: 50,
    exchangeRate: 5, status: 'Active', paymentStatus: 'not_paid',
    collectionMethod: 'in_shop', createdAt: '2026-01-01'
  })));
  f.state.customerFinancialFilter = 'hasDebt';
  f.state.customerSort = 'highestDebt';
  return f;
}

function receiptFixture() {
  const f = fixture();
  f.state.receipts = Array.from({ length: 24 }, (_, i) => ({
    id: `r${i}`, customerId: 'c1', recordType: 'receipt', tempReceiptNo: `D${i}`,
    amountUSD: 0, amountLocal: 0, exchangeRate: 5 + (i % 3),
    status: 'Not Paid', isPaid: false, deliveryStatus: 'Needs Delivery',
    statusDetail: { notPaidCollection: 'delivery' }, payments: [], transfers: [],
    createdAt: '2026-01-01', createdBy: 'admin'
  }));
  f.state.ads = f.state.receipts.map((r, i) => ({
    id: `linked${i}`, customerId: 'c1', amountUSD: 10, amountLocal: 50,
    status: 'Active', paymentStatus: 'not_paid', collectionMethod: 'driver',
    linkedDeliveryReceiptId: r.id, receiptId: r.id,
    receiptAllocations: [], dueAllocations: [], createdBy: 'hidden_owner'
  }));
  f.state.ads.push(...Array.from({ length: 1000 }, (_, i) => ({
    id: `unrelated${i}`, customerId: 'other', status: 'Active', amountUSD: 900,
    paymentStatus: 'not_paid', collectionMethod: 'driver', linkedDeliveryReceiptId: `other${i}`
  })));
  return f;
}

test('filter, sort, header and cards derive each customer once per render index', () => {
  const { sandbox, state } = customersFixture();
  const original = sandbox.getAdSpendUSD;
  let work = 0;
  sandbox.getAdSpendUSD = ad => { work += 1; return original(ad); };
  const index = sandbox.buildCustomerStatsIndex();
  const filtered = sandbox.getFilteredCustomers(index);
  state.customers.forEach(c => sandbox.getCustomerStats(c.id, index));
  filtered.forEach(c => sandbox.getCustomerStats(c.id, index));
  console.log(`  WORK  customer spend evaluations: ${work} for ${state.ads.length} ads`);
  assert.equal(filtered.length, 20);
  assert.equal(work, state.ads.length * 2, 'each ad has the same two authoritative spend reads, once per customer');
});

test('customer rendering matches uncached totals, ordering and permission controls', () => {
  const { sandbox } = customersFixture();
  const build = sandbox.buildCustomerStatsIndex;
  sandbox.buildCustomerStatsIndex = () => {
    const index = build();
    delete index.statsByCustomer;
    return index;
  };
  const uncached = sandbox.renderCustomersView();
  sandbox.buildCustomerStatsIndex = build;
  assert.equal(sandbox.renderCustomersView(), uncached);
});

test('new render indexes reflect edits, deletion, receipt changes and exchange-rate changes', () => {
  const { sandbox, state } = customersFixture();
  const read = () => sandbox.getCustomerStats('c0', sandbox.buildCustomerStatsIndex());
  assert.equal(read().balanceUSD, -100);
  state.ads[0].amountUSD = 20;
  assert.equal(read().balanceUSD, -110);
  state.ads[0]._deleted = true;
  assert.equal(read().balanceUSD, -90);
  state.receipts.push({ id: 'paid', customerId: 'c0', status: 'Paid', amountUSD: 50, amountLocal: 250 });
  assert.equal(read().balanceUSD, -40);
  state.ads.forEach(ad => { delete ad.amountLocal; delete ad.exchangeRate; });
  state.defaultExchangeRate = 7;
  assert.equal(read().balanceLYD, -380);
});

test('single-record calls remain uncached even after a render was memoized', () => {
  const { sandbox, state } = customersFixture();
  sandbox.getCustomerStats('c0', sandbox.buildCustomerStatsIndex());
  state.ads[0].amountUSD = 15;
  assert.equal(sandbox.getCustomerStats('c0').balanceUSD, -105);
});

test('memoized stats keep the existing independent return-object behavior', () => {
  const { sandbox } = customersFixture();
  const index = sandbox.buildCustomerStatsIndex();
  const first = sandbox.getCustomerStats('c0', index);
  first.balanceUSD = 999;
  const second = sandbox.getCustomerStats('c0', index);
  assert.equal(second.balanceUSD, -100);
  second.balanceUSD = 800;
  assert.equal(sandbox.getCustomerStats('c0', index).balanceUSD, -100);
});

test('new renders reflect transferred funds and changed legacy page links', () => {
  const { sandbox, state } = customersFixture();
  state.receipts.push({ id: 'paid', customerId: 'c0', status: 'Paid', amountUSD: 100, amountLocal: 500,
    exchangeRate: 5, transfers: [] });
  state.pages.push({ id: 'p0', customerId: 'c0' });
  const read = () => sandbox.getCustomerStats('c0', sandbox.buildCustomerStatsIndex());
  assert.equal(read().balanceUSD, 0);
  assert.equal(read().linkedPagesCount, 1);
  state.receipts[0].transfers.push({ amountUSD: 2, amountLocal: 10 });
  state.pages[0].customerIds = [];
  assert.equal(read().balanceUSD, -2);
  assert.equal(read().linkedPagesCount, 0);
});

test('a new account render cannot reuse the previous account visible customer list or balance access', () => {
  const { sandbox, state } = customersFixture();
  sandbox.renderCustomersView();
  state.customers[0].createdBy = 'viewer';
  state.currentUser = { id: 'viewer', role: 'Employee', permissions: { customers: ['viewOwn'] } };
  const html = sandbox.renderCustomersView();
  assert.ok(html.includes('Customer 0'));
  assert.ok(!html.includes('Customer 1'));
  assert.ok(html.includes('Hidden'));
  assert.equal(state.customerFinancialFilter, 'all');
  assert.equal(state.customerSort, 'newest');
});

test('legacy and modern money fixtures match the uncached reader exactly', () => {
  const { sandbox, state } = receiptFixture();
  state.receipts.push(
    { id: 'paid', customerId: 'c1', amountUSD: 5.15, amountLocal: 50, exchangeRate: 9.7, status: 'Paid', transfers: [{ amountUSD: 1, amountLocal: 9.7 }] },
    { id: 'covered', customerId: 'c1', amountUSD: 30, amountLocal: 210, status: 'Not Paid', companyCoveredUSD: 10, customerOutstandingUSD: 20 },
    { id: 'deleted', customerId: 'c1', amountUSD: 900, amountLocal: 900, status: 'Paid', _deleted: true }
  );
  state.ads.push({ id: 'old', customer: 'c1', status: 'Stopped', amountUSD: 15, spentUSD: 5.15,
    receiptAllocations: [{ receiptId: 'paid', amountUSD: 5.15 }],
    companyFundingAllocations: [{ receiptId: 'covered', amountUSD: 2 }], paymentStatus: 'paid' });
  const expected = plain(sandbox.getCustomerStats('c1'));
  const before = plain({ receipts: state.receipts, ads: state.ads });
  const index = sandbox.buildCustomerStatsIndex();
  assert.deepEqual(plain(sandbox.getCustomerStats('c1', index)), expected);
  assert.deepEqual(plain(sandbox.getCustomerStats('c1', index)), expected);
  assert.deepEqual(plain({ receipts: state.receipts, ads: state.ads }), before);
});

test('receipt cards do not rescan all ads for legacy collection targets', () => {
  const { sandbox, state } = receiptFixture();
  const original = sandbox.getReceiptCollectionTarget;
  let visited = 0;
  sandbox.getReceiptCollectionTarget = (receipt, ads = state.ads) => {
    visited += ads.length;
    return original(receipt, ads);
  };
  sandbox.renderReceiptsView();
  console.log(`  WORK  receipt target candidate visits: ${visited} for ${state.receipts.length} cards / ${state.ads.length} ads`);
  assert.equal(visited, state.receipts.length, 'one linked ad candidate per receipt, reused by coverage displays');
});

test('indexed receipt-card HTML matches full scans including old aliases, coverage and stopped ads', () => {
  const { sandbox, state } = receiptFixture();
  state.ads[0].spentUSD = 4;
  state.ads[0].status = 'Stopped';
  delete state.ads[1].linkedDeliveryReceiptId;
  state.ads[1].customer = state.ads[1].customerId;
  delete state.ads[1].customerId;
  state.ads[2].receiptAllocations = [{ receiptId: 'elsewhere', amountUSD: 3 }];
  state.receipts[3].companyCoveredUSD = 2;
  state.receipts[4].customerOutstandingUSD = 1;
  state.receipts[5].debtAmountUSD = 13;
  state.ads.push({ ...state.ads[0], id: 'deleted', _deleted: true, amountUSD: 900 });
  state.ads.push({ ...state.ads[0], id: 'mirror', recordType: 'receipt', amountUSD: 900 });
  state.ads.push({ ...state.ads[0], id: 'different_customer', customerId: 'other', amountUSD: 900 });
  state.ads.push({ ...state.ads[0], id: 'explicit_link_wins', linkedDeliveryReceiptId: 'other', amountUSD: 900 });
  const original = sandbox.getReceiptCollectionTarget;
  sandbox.getReceiptCollectionTarget = receipt => original(receipt);
  const before = plain({ receipts: state.receipts, ads: state.ads });
  const fullScanHTML = sandbox.renderReceiptsView();
  sandbox.getReceiptCollectionTarget = original;
  assert.equal(sandbox.renderReceiptsView(), fullScanHTML);
  assert.deepEqual(plain({ receipts: state.receipts, ads: state.ads }), before);
});

test('receipt money stays unchanged when ad viewing is denied while links remain hidden', () => {
  const { sandbox, state } = receiptFixture();
  state.currentUser = { id: 'viewer', role: 'Employee', permissions: { receipts: ['view'], customers: ['view'] } };
  assert.equal(sandbox.getAdsVisibleToCurrentUser().length, 0);
  const targets = [];
  const original = sandbox.getReceiptCollectionTarget;
  sandbox.getReceiptCollectionTarget = (receipt, ads) => {
    const target = original(receipt, ads);
    targets.push(target.amountUSD);
    return target;
  };
  const html = sandbox.renderReceiptsView();
  assert.ok(targets.length >= state.receipts.length);
  assert.ok(targets.every(amount => amount === 10));
  assert.ok(!html.includes('data-action="view-receipt-ads"'));
  assert.ok(!html.includes('Cover with company funds'));
});

test('new receipt renders pick up relinking, deletion and amount/rate corrections', () => {
  const { sandbox, state } = receiptFixture();
  const targets = [];
  const original = sandbox.getReceiptCollectionTarget;
  sandbox.getReceiptCollectionTarget = (receipt, ads) => {
    const target = original(receipt, ads);
    if (receipt.id === 'r0') targets.push([target.amountUSD, target.amountLocal]);
    return target;
  };
  const read = () => { targets.length = 0; sandbox.renderReceiptsView(); return targets[0]; };
  assert.deepEqual(read(), [10, 50]);
  state.receipts[0].exchangeRate = 9;
  state.ads[0].amountUSD = 12;
  assert.deepEqual(read(), [12, 108]);
  state.ads[0].linkedDeliveryReceiptId = 'r1';
  assert.deepEqual(read(), [0, 0]);
  state.ads[0].linkedDeliveryReceiptId = 'r0';
  state.ads[0]._deleted = true;
  assert.deepEqual(read(), [0, 0]);
});

// Bug hunt r5 (R5-performance-phone-1): Home (Analytics) found every ad's and receipt's customer and
// every top page with a full list scan; it now builds one lookup per render and shows the same lists.
function analyticsFixture() {
  const f = fixture();
  const at = hours => new Date(Date.UTC(2025, 0, 1) + hours * 3600e3).toISOString();
  const ad = (id, customerId, pageId, amountUSD, createdAt) => ({ id, customerId, pageId, amountUSD, createdAt,
    status: 'Active', paymentStatus: 'paid', exchangeRate: 5 });
  f.state.customers = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, createdBy: 'admin' }));
  f.state.pages = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `Page ${i}` }));
  f.state.pages.push({ id: 'p_gone', name: 'Gone Page', _deleted: true }, { id: 'p_gone', name: 'Gone Page copy', _deleted: true });
  f.state.ads = Array.from({ length: 400 }, (_, i) => ad(`a${i}`, `c${i % 300}`, `p${i % 200}`, 1, at(i)));
  f.state.receipts = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, customerId: `c${i}`, amountUSD: 5,
    status: 'Paid', isPaid: true, createdAt: at(i) }));
  // Top spenders, one of them without a customer row ("Unknown").
  [['c10', 500], ['c20', 400], ['ghost', 300], ['c30', 200], ['c40', 100]]
    .forEach(([customerId, usd], i) => f.state.ads.push(ad(`big${i}`, customerId, '', usd, at(-100))));
  // Busiest pages: a deleted page, an unknown page id and three live pages (2 ads each already).
  [['p_gone', 9], ['p_none', 8], ['p3', 5], ['p4', 4], ['p5', 3]].forEach(([pageId, count]) => {
    for (let n = 0; n < count; n += 1) f.state.ads.push(ad(`${pageId}_${n}`, '', pageId, 0, at(-200)));
  });
  // Newest activity, with an ad and a receipt at the same instant (the ad stays first).
  f.state.ads.push(ad('new_ghost', 'ghost2', '', 0, '2026-09-30T10:00:00.000Z'), ad('new2', 'c2', '', 0, '2026-09-30T08:00:00.000Z'),
    ad('tie_ad', 'c4', '', 0, '2026-09-30T06:00:00.000Z'));
  f.state.receipts.push(...[['new1', 'c1', '09'], ['new3', 'c3', '07'], ['tie_r', 'c5', '06'], ['older', 'c6', '05']]
    .map(([id, customerId, hour]) => ({ id, customerId, amountUSD: 5, status: 'Paid', isPaid: true, createdAt: `2026-09-30T${hour}:00:00.000Z` })));
  return f;
}
const analyticsLists = html => {
  const panel = title => html.slice(html.indexOf(title)).split('glass-panel rounded-2xl p-5')[0];
  const names = title => [...panel(title).matchAll(/<p class="font-medium">([^<]*)<\/p>/g)].map(m => m[1]);
  return { customers: names('Top Customers (Spend)'), pages: names('Top Pages (Ads)'), recent: names('Recent Activity') };
};
function countFinds(lists) {
  const counter = { calls: 0 };
  for (const list of lists) {
    const find = list.find;
    Object.defineProperty(list, 'find', { configurable: true, value(...args) { counter.calls += 1; return find.apply(this, args); } });
  }
  return counter;
}

test('R5 performance-phone-1: Home finds customers and pages through one lookup per render, with the same lists', () => {
  const { sandbox, state } = analyticsFixture();
  const finds = countFinds([state.customers, state.pages]);
  const html = sandbox.renderAnalyticsView();
  console.log(`  WORK  customer/page list scans: ${finds.calls} for ${state.ads.length} ads, ${state.receipts.length} receipts`);
  assert.ok(finds.calls <= 2, `before: one customers/pages scan per ad, receipt and listed customer/page (${finds.calls})`);
  const lists = analyticsLists(html);
  assert.deepEqual(lists.customers, ['Customer 10', 'Customer 20', 'Unknown', 'Customer 30', 'Customer 40']);
  assert.deepEqual(lists.pages, ['Gone Page (deleted)', 'Unknown', 'Page 3', 'Page 4', 'Page 5']);
  assert.deepEqual(lists.recent, ['Ad: Unknown', 'Receipt: Customer 1', 'Ad: Customer 2', 'Receipt: Customer 3', 'Ad: Customer 4', 'Receipt: Customer 5']);
  assert.ok(html.includes('502.00 USD') && html.includes('300.00 USD'), 'the spend figures');
});

// The same three lists computed the old way (a full scan per record), for the equivalence check below.
function oldAnalyticsLists(sandbox, state) {
  const ads = sandbox.getVisibleRecords(state.ads).filter(ad => ad.recordType !== 'receipt');
  const receipts = sandbox.getVisibleRecords(state.receipts);
  const name = id => state.customers.find(c => c.id === id)?.name || 'Unknown';
  const spend = {};
  ads.forEach(ad => { if (ad.customerId) spend[ad.customerId] = (spend[ad.customerId] || 0) + sandbox.getAdSpendUSD(ad); });
  const perPage = {};
  ads.forEach(ad => { if (ad.pageId) perPage[ad.pageId] = (perPage[ad.pageId] || 0) + 1; });
  const pageName = id => {
    const live = state.pages.find(p => p && !p._deleted && String(p.id) === String(id));
    const gone = live ? null : state.pages.find(p => p && p._deleted && String(p.id) === String(id));
    return live?.name || (gone?.name ? `${gone.name} (deleted)` : 'Unknown');
  };
  return {
    customers: Object.entries(spend).map(([id, usd]) => ({ id, usd })).sort((a, b) => b.usd - a.usd).slice(0, 5).map(c => name(c.id)),
    pages: Object.entries(perPage).map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count).slice(0, 5).map(p => pageName(p.id)),
    recent: [...ads.map(ad => ({ text: `Ad: ${name(ad.customerId)}`, at: ad.createdAt })),
      ...receipts.map(r => ({ text: `Receipt: ${name(r.customerId)}`, at: r.createdAt }))]
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 6).map(item => item.text)
  };
}

test('R5 performance-phone-1: Home keeps the first-match, exact-id rules of the old scans on messy data', () => {
  const { sandbox, state } = analyticsFixture();
  // A numeric id matches a numeric reference only, the first of two rows with one id wins, a deleted
  // customer still names its records, a live page beats a deleted row with its id, and a bad date sorts as before.
  state.customers.unshift({ id: 7, name: 'Numeric Seven' }, { id: 'c1', name: 'First c1' }, { id: 'c9', name: 'Old Nine', _deleted: true });
  state.pages.unshift({ id: 'p_gone', name: 'Back Again' });
  const ad = (id, customerId, amountUSD, createdAt) => ({ id, customerId, amountUSD, createdAt, status: 'Active', paymentStatus: 'paid' });
  state.ads.push(ad('num7', 7, 1000, '2026-09-30T11:00:00.000Z'), ad('nine', 'c9', 0, '2026-09-30T10:30:00.000Z'),
    ad('baddate', 'c8', 0, 'not a date'), ad('nodate', 'c11', 0, undefined));
  state.receipts.push({ id: 'r_nodate', customerId: 'c12', amountUSD: 1, status: 'Paid' });
  const expected = oldAnalyticsLists(sandbox, state);
  assert.deepEqual(expected.customers, ['Unknown', 'Customer 10', 'Customer 20', 'Unknown', 'Customer 30'], 'spend keys are text: 7 is not "7"');
  assert.deepEqual(expected.pages, ['Back Again', 'Unknown', 'Page 3', 'Page 4', 'Page 5']);
  assert.deepEqual(analyticsLists(sandbox.renderAnalyticsView()), expected);
});

// Bug hunt r5 (R5-performance-phone-4): the driver's Home drew a card for every job ever assigned (3.4 MB of
// HTML for 1,200 jobs, redrawn on each change). It now shows 30 at a time, open jobs first, with Load more.
function driverDashboardFixture() {
  const f = fixture();
  const driver = { id: 'drv1', name: 'Driver', role: 'Delivery', permissions: {} };
  f.state.users = [f.state.currentUser, driver];
  f.state.currentUser = driver;
  f.state.customers = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, phones: [`091${String(1000000 + i)}`] }));
  // r0-r3 still need delivery and are the OLDEST jobs, r4-r5 are on the way, r6-r9 are delivered with the cash still held.
  f.state.receipts = Array.from({ length: 100 }, (_, i) => {
    const deliveryStatus = i < 4 ? 'Needs Delivery' : i < 6 ? 'In Progress' : 'Delivered';
    const done = deliveryStatus === 'Delivered';
    return { id: `r${i}`, recordType: 'receipt', customerId: `c${i % 50}`, tempReceiptNo: `D${i}`, deliveryPersonId: 'drv1',
      deliveryStatus, status: done ? 'Paid' : 'Not Paid', isPaid: done, statusDetail: { notPaidCollection: 'delivery' },
      amountUSD: 10, amountLocal: 50, exchangeRate: 5, isReceivedInOffice: i >= 10,
      ...(done ? { amountCollectedFromCustomer: 50 } : {}), payments: [], transfers: [],
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString() };
  });
  const cards = () => {
    const html = String(f.sandbox.renderDeliveryDashboard());
    return { html, numbers: [...html.matchAll(/Receipt: (D\d+) \(Temp\)/g)].map(m => m[1]),
      tiles: [...html.matchAll(/workspace-stat-value[^>]*><bdi>([^<]*)<\/bdi>/g)].map(m => m[1]) };
  };
  return { ...f, cards };
}

test('R5 performance-phone-4: the driver Home draws 30 jobs, open ones first, and Load more adds 30', () => {
  const { sandbox, state, cards } = driverDashboardFixture();
  const finds = countFinds([state.customers]);
  const first = cards();
  console.log(`  WORK  driver Home cards: ${first.numbers.length} of ${state.receipts.length} jobs; customer scans: ${finds.calls}`);
  assert.equal(first.numbers.length, 30, 'before: every job ever assigned, in one page');
  assert.deepEqual(first.numbers.slice(0, 10), ['D3', 'D2', 'D1', 'D0', 'D5', 'D4', 'D9', 'D8', 'D7', 'D6'], 'open jobs, then held cash, each newest first');
  assert.deepEqual(first.numbers.slice(10, 13), ['D99', 'D98', 'D97']);
  assert.deepEqual(first.tiles, ['4', '2', '94', '4 (200.00 LYD)'], 'the tiles still count every job');
  assert.ok(first.html.includes('onclick="loadMoreDeliveryDashboard()"') && first.html.includes('Load more (70 remaining)'));
  assert.ok(finds.calls <= 1, `before: one customers scan per card (${finds.calls})`);
  sandbox.loadMoreDeliveryDashboard();
  assert.equal(cards().numbers.length, 60);
  assert.equal(cards().numbers.length, 60, 'a live-sync redraw keeps the longer list');
  state.language = 'ar';
  assert.ok(cards().html.includes('عرض المزيد (40 متبقي)'));
  state.language = 'en';
  sandbox.setDeliveryDashboardFilter('Delivered');
  const delivered = cards();
  assert.equal(delivered.numbers.length, 30, 'a new filter starts again at 30');
  assert.deepEqual(delivered.numbers.slice(0, 2), ['D99', 'D98']);
  assert.ok(delivered.html.includes('Load more (64 remaining)'));
  sandbox.setDeliveryDashboardFilter('Needs Delivery');
  assert.deepEqual(cards().numbers, ['D3', 'D2', 'D1', 'D0']);
  assert.ok(!cards().html.includes('loadMoreDeliveryDashboard()'));
  sandbox.setDeliveryDashboardFilter('all');
  sandbox.loadMoreDeliveryDashboard();
  assert.equal(cards().numbers.length, 60);
  sandbox.advanceServerSessionEpoch();  // signed out and in again
  assert.equal(cards().numbers.length, 30, 'a new sign-in starts again at 30');
  sandbox.loadMoreDeliveryDashboard();
  state.currentUser = { ...state.currentUser, id: 'drv2' };
  state.receipts.forEach(r => { r.deliveryPersonId = 'drv2'; });
  assert.equal(cards().numbers.length, 30, 'another driver starts again at 30');
});

// Bug hunt r5 (R5-performance-phone-5): every Admin customer card re-read every ad (and every receipt per
// unpaid driver ad) to find the debt company funds may cover; it now reuses the render's index, same amounts.
function coverableDebtFixture() {
  const f = fixture();
  const rows = (receiptId, amountUSD) => [{ receiptId, amountUSD }];
  f.state.customers = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, createdBy: 'admin', joinDate: '2026-01-01' }));
  f.state.ads = [];
  f.state.receipts = [];
  f.state.customers.forEach(({ id }, i) => {
    // 'Completed' with no spentUSD reads its budget as spend, so every amount below is unchanged
    // (F-cover: only a finished ad is offered; the running one at the end must stay out).
    const ad = (suffix, fields) => f.state.ads.push({ id: `${id}_${suffix}`, customerId: id, status: 'Completed',
      paymentStatus: 'not_paid', exchangeRate: 5, createdAt: '2026-01-01', ...fields });
    f.state.receipts.push({ id: `${id}_open`, customerId: id, status: 'Not Paid', isPaid: false, amountUSD: 7, exchangeRate: 5 },
      { id: `${id}_paid`, customerId: id, status: 'Paid', isPaid: true, amountUSD: 3, exchangeRate: 5 });
    ad('shop', { collectionMethod: 'in_shop', amountUSD: 10.1 + i * 0.07, receiptAllocations: rows('x', 1.13), dueAllocations: [],
      companyFundingAllocations: rows('y', 0.29) });
    ad('drv_open', { collectionMethod: 'driver', linkedDeliveryReceiptId: `${id}_open`, amountUSD: 7, receiptAllocations: [], dueAllocations: [] });
    ad('drv_paid', { collectionMethod: 'driver', linkedDeliveryReceiptId: `${id}_paid`, amountUSD: 9.99 + i * 0.01,
      receiptAllocations: rows(`${id}_paid`, 3), dueAllocations: [] });
    ad('legacy', { amountUSD: 4, fundingReceiptId: `${id}_paid` });
    ad('bare', { customerId: undefined, customer: id, amountUSD: 2.5 + i * 0.13 });
    ad('direct', { collectionMethod: 'in_shop', amountUSD: 6, companyDirectCoverageUSD: 2.2, receiptAllocations: [], dueAllocations: [] });
    ad('stopped', { collectionMethod: 'in_shop', status: 'Stopped', spentUSD: 1.7, amountUSD: 50, receiptAllocations: [], dueAllocations: [] });
    ad('gone', { collectionMethod: 'in_shop', amountUSD: 99, receiptAllocations: [], _deleted: true });
    ad('mirror', { recordType: 'receipt', amountUSD: 99 });
    ad('paid', { collectionMethod: 'in_shop', paymentStatus: 'paid', amountUSD: 99, receiptAllocations: [] });
    ad('running', { collectionMethod: 'in_shop', status: 'Active', amountUSD: 77, receiptAllocations: [], dueAllocations: [] });
  });
  // A deleted settled copy listed first is skipped, and of two live rows with one id the first decides.
  f.state.receipts.unshift({ id: 'c3_open', customerId: 'c3', status: 'Paid', isPaid: true, _deleted: true },
    { id: 'c4_paid', customerId: 'c4', status: 'Not Paid', isPaid: false });
  f.state.ads.push({ id: 'no_customer', status: 'Completed', paymentStatus: 'not_paid', collectionMethod: 'in_shop', amountUSD: 8, receiptAllocations: [] });
  return f;
}

test('R5 performance-phone-5: Admin customer cards reuse the render index for coverable ad debt, with identical amounts', () => {
  const { sandbox, state } = coverableDebtFixture();
  const index = sandbox.buildCustomerStatsIndex();
  for (const id of [...state.customers.map(c => c.id), '', 'nobody']) {
    const indexed = sandbox.getCustomerCoverableAdDebt(id, index);
    const full = sandbox.getCustomerCoverableAdDebt(id);
    assert.deepEqual(plain(indexed), plain(full), `customer ${id}`);
    assert.ok(indexed.ads.every((row, i) => row.ad === full.ads[i].ad), `customer ${id}: the same ad rows`);
  }
  assert.equal(sandbox.getCustomerCoverableAdDebt('c4', index).ads.some(row => row.ad.id === 'c4_drv_paid'), false, 'the first c4_paid row is unpaid');
  assert.equal(sandbox.getCustomerCoverableAdDebt('', index).totalUSD, 8, 'an empty id still finds ads without a customer');
  assert.ok(sandbox.getCustomerCoverableAdDebt('c1', index).totalUSD > 0);
  assert.equal(sandbox.getCustomerCoverableAdDebt('c1', index).ads.some(row => row.ad.id === 'c1_running'), false, 'a running ad is never offered');
  const read = sandbox.getVisibleRecords;
  const reads = { ads: 0, receipts: 0 };
  sandbox.getVisibleRecords = list => {
    if (list === state.ads) reads.ads += 1;
    if (list === state.receipts) reads.receipts += 1;
    return read(list);
  };
  const html = sandbox.renderCustomersView();
  console.log(`  WORK  customers render list reads: ads ${reads.ads}, receipts ${reads.receipts} for ${state.customers.length} cards`);
  assert.ok(reads.ads <= 3, `before: one full ads read per card (${reads.ads})`);
  assert.ok(reads.receipts <= 4, `before: one full receipts read per unpaid driver ad (${reads.receipts})`);
  const indexedReader = sandbox.getCustomerCoverableAdDebt;
  sandbox.getCustomerCoverableAdDebt = customerId => indexedReader(customerId);
  const fullScanHtml = sandbox.renderCustomersView();
  sandbox.getCustomerCoverableAdDebt = indexedReader;
  assert.equal(html, fullScanHtml);
  assert.ok(html.includes('Pay debt from company funds') && html.includes('($30.88)'), 'c1: $23.88 of ad debt plus its $7 open receipt');
});

console.log(`Render performance: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
