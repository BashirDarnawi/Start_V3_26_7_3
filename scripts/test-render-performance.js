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

console.log(`Render performance: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
