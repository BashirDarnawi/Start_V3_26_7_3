/**
 * MONEY INVARIANTS for the receipt-balance model.
 *
 * This is the safety net for the coming redesign of "how a receipt funds an ad".
 * It has TWO groups:
 *
 *   GROUP A — MUST HOLD TODAY
 *     Invariants the current code already satisfies. A redesign MUST keep them.
 *     Any failure here fails the run (exit 1).
 *
 *   GROUP B — TARGET BEHAVIOUR (known broken today)
 *     Each test asserts the CORRECT behaviour. Today they fail; the failure is
 *     reported as "KNOWN-BROKEN (expected)" and does NOT fail the run. When the
 *     redesign lands, these must flip to FIXED and then be promoted into GROUP A.
 *
 * Background — a receipt can fund ads through TWO parallel arrays on the ad:
 *   ad.receiptAllocations[]  -> "paid balance" pool  -> getReceiptUsageStats()
 *   ad.dueAllocations[]      -> "delivery due" pool  -> getDeliveryReceiptDueUsage()
 * plus a LEGACY MIRROR ad.dueAmountToUseUSD / dueAmountToUseLYD that both readers
 * fall back to when an ad has no allocation row for the receipt. saveAd writes the
 * mirror alongside dueAllocations (src/15-modals.js ~2392), so real records carry
 * BOTH — the fixtures below do too.
 *
 * Every assertion below runs against the REAL functions inside the built bundle
 * (script.js, generated from src/). Nothing is re-implemented here.
 *
 * Run: node scripts/test-money.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'script.js');

// ---------- minimal browser stubs (same harness as scripts/test-permissions.js) ----------
function makeElement() {
  const el = {
    id: '', className: '', value: '', style: {},
    dataset: {}, checked: false, files: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {}, select() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, insertAdjacentHTML() {}, scrollTop: 0
  };
  let _text = '';
  let _html = '';
  Object.defineProperty(el, 'textContent', {
    get: () => _text,
    set: (v) => {
      _text = String(v);
      _html = _text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => _html,
    set: (v) => { _html = String(v); _text = _html.replace(/<[^>]*>/g, ''); }
  });
  return el;
}

function makeSandbox() {
  const doc = {
    readyState: 'loading', // keeps init() from auto-running
    body: makeElement(),
    documentElement: makeElement(),
    head: makeElement(),
    createElement: () => makeElement(),
    createTextNode: () => makeElement(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    execCommand() {}, cookie: ''
  };
  const store = () => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k),
      clear: () => m.clear(),
      key: () => null, length: 0
    };
  };
  const win = {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/', search: '', href: 'http://localhost/', protocol: 'http:', reload() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame: () => {},
    localStorage: store(), sessionStorage: store(),
    navigator: { userAgent: 'node-test', onLine: true, clipboard: { writeText: async () => {} }, credentials: {} },
    isSecureContext: true,
    print() {}, alert() {}, confirm: () => true, prompt: () => null,
    scrollTo() {}, innerWidth: 1280, innerHeight: 900,
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]', headers: { get: () => null } }),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function () {},
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (i * 7 + 3) % 256; return a; }, randomUUID: () => 'uuid-test', subtle: {} }
  };
  const sandbox = {
    window: win, document: doc, navigator: win.navigator, location: win.location, history: win.history,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, crypto: win.crypto,
    fetch: win.fetch, Blob: win.Blob, URL: win.URL, isSecureContext: true,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    indexedDB: undefined,
    lucide: { createIcons() {} },
    IntersectionObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    alert: win.alert, confirm: win.confirm, prompt: win.prompt,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    matchMedia: win.matchMedia, addEventListener() {}, removeEventListener() {}
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

const sandbox = makeSandbox();
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'script.js' });

// Top-level `const`/`let` (state, Security, …) live in the context's LEXICAL
// scope, not on the global object — pull them across. Function declarations
// (getReceiptUsageStats, getDeliveryReceiptDueUsage, saveRefund, …) are global
// object properties and are reachable as sandbox.<name>.
const bridged = vm.runInContext('({ state, Security })', sandbox);
const S = bridged.state;

// Real app functions under test — no re-implementation of the math anywhere.
const getReceiptUsageStats = sandbox.getReceiptUsageStats;
const getDeliveryReceiptDueUsage = sandbox.getDeliveryReceiptDueUsage;
const getCustomerStats = sandbox.getCustomerStats;
const _deliveryDefaultRate1 = sandbox._deliveryDefaultRate1;
const PAYMENT_METHODS = vm.runInContext('PAYMENT_METHODS', sandbox);

// ---------- test scaffolding ----------
let passedA = 0;
const failuresA = [];   // MUST HOLD -> these fail the run
let fixedB = 0;
const knownBroken = []; // TARGET -> reported, but never fail the run

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps = 0.005) { return Math.abs(Number(a) - Number(b)) < eps; }
function usd(n) { return `$${Number(n).toFixed(2)}`; }

// GROUP A: an invariant the code satisfies today. A failure fails the run.
async function must(name, fn) {
  try {
    await fn();
    passedA++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failuresA.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// GROUP B: the CORRECT behaviour, asserted honestly. It fails today; that is
// recorded as KNOWN-BROKEN and does not fail the run. If it ever passes, the
// bug is fixed and the test should move into GROUP A.
async function target(name, fn) {
  try {
    await fn();
    fixedB++;
    console.log(`  FIXED (promote to GROUP A)  ${name}`);
  } catch (e) {
    knownBroken.push({ name, message: e.message });
    console.log(`  KNOWN-BROKEN (expected)  ${name}\n        ${e.message}`);
  }
}

// ---------- fixtures ----------
const ADMIN = { id: 'u-admin', name: 'Bashir', role: 'Admin', permissions: {} };

function resetState() {
  S.serverMode = false;
  S.currentUser = ADMIN;
  S.users = [ADMIN];
  S.language = 'en';
  S.defaultExchangeRate = 5;
  S.customers = [{ id: 'c1', name: 'Cust One', platform: 'Facebook', phones: [], profileLinks: [] }];
  S.receipts = [];
  S.ads = [];
  S.pages = [];
  S.logs = [];
  S.appSettings = [];
  S.modalData = null;
  S.tempAdFunding = null;
  sandbox.document.getElementById = () => null;
}

// An ordinary PAID receipt: its capacity is amountUSD, read by getReceiptUsageStats.
function paidReceipt(id, amountUSD, rate = 5) {
  const r = {
    id,
    recordType: 'receipt',
    customerId: 'c1',
    amountUSD,
    exchangeRate: rate,
    amountLocal: Math.round(amountUSD * rate * 100) / 100,
    status: 'Paid',
    isPaid: true,
    deliveryStatus: 'Office',
    isReceivedInOffice: true,
    payments: [],
    transfers: [],
    createdAt: new Date().toISOString()
  };
  S.receipts.push(r);
  return r;
}

// A DELIVERY receipt (temp, Not Paid, driver collection). Its DUE capacity is
// (debtAmountLocal ?? amountLocal) / exchangeRate — see getDeliveryReceiptDueUsage.
function deliveryReceipt(id, amountLocal, rate = 10) {
  const r = {
    id,
    recordType: 'receipt',
    customerId: 'c1',
    tempReceiptNo: 'D1',
    amountUSD: Math.round((amountLocal / rate) * 100) / 100, // the paper value of the same money
    amountLocal,
    exchangeRate: rate,
    status: 'Not Paid',
    isPaid: false,
    deliveryStatus: 'Delivered',
    statusDetail: { notPaidCollection: 'delivery' },
    payments: [],
    transfers: [],
    createdAt: new Date().toISOString()
  };
  S.receipts.push(r);
  return r;
}

// The driver hands the cash in: markAsCollected() (src/13-filters-helpers.js:936)
// flips the SAME receipt record to Paid — no new record is created.
function collect(r, amountUSD) {
  r.status = 'Paid';
  r.isPaid = true;
  r.amountUSD = amountUSD;
  r.collectionDate = new Date().toISOString();
  return r;
}

function makeAd(props) {
  const a = Object.assign({
    id: 'ad_x',
    recordType: 'ad',
    customerId: 'c1',
    pageId: '',
    amountUSD: 0,
    status: 'Active',
    paymentStatus: 'paid',
    isPaid: true,
    startDate: new Date().toISOString(),
    createdAt: new Date().toISOString()
  }, props);
  S.ads.push(a);
  return a;
}

// An ad funded from a delivery receipt's DUE credit, shaped EXACTLY the way
// saveAd writes it (src/15-modals.js ~2277-2392): the dueAllocations row AND the
// legacy mirror fields together.
function dueFundedAd(id, receiptId, amountUSD) {
  return makeAd({
    id,
    amountUSD,
    spentUSD: amountUSD,
    receiptAllocations: [],
    dueAllocations: [{ receiptId, amountUSD }],
    linkedDeliveryReceiptId: receiptId,
    dueAmountToUseUSD: amountUSD
  });
}

// Stub the refund modal's three inputs so the real saveRefund() can read them.
function setRefundInputs(type, amount, status) {
  sandbox.document.getElementById = (id) => {
    if (id === 'refund-type') return { value: type };
    if (id === 'refund-amount') return { value: String(amount) };
    if (id === 'refund-status') return { value: status };
    return null;
  };
}

// saveRefund() calls these on its way out — keep them harmless.
const notes = [];
sandbox.showNotification = (t, m, k) => notes.push({ t, m, k });
sandbox.render = () => {};
sandbox.renderModal = () => {};
sandbox.closeModal = () => {};

// ==========================================================================
async function main() {
  console.log('\n############################################################');
  console.log('# GROUP A — MUST HOLD TODAY (a redesign must not break these)');
  console.log('############################################################\n');

  console.log('--- PAID BALANCE POOL: getReceiptUsageStats ---');

  await must('A0. unpaid In Shop receipt makes a -$30 debt, then Paid clears it without double-use', () => {
    resetState();
    S.defaultExchangeRate = 9.7;
    const r = {
      id: 'receipt_shop_a0', recordType: 'receipt', customerId: 'c1',
      amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
      statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: []
    };
    S.receipts.push(r);
    makeAd({
      id: 'ad_shop_a0', amountUSD: 30, amountLocal: 291, spentUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: r.id, receiptAllocations: [],
      dueAllocations: [{ receiptId: r.id, amountUSD: 30 }], dueAmountToUseUSD: 30
    });

    const before = getCustomerStats('c1');
    assert(near(before.totalPaidUSD, 0), `unpaid receipt counted as paid: ${usd(before.totalPaidUSD)}`);
    assert(near(before.balanceUSD, -30), `customer debt should be -$30, got ${usd(before.balanceUSD)}`);
    assert(near(before.balanceLYD, -291), `customer debt should be -291 LYD, got ${before.balanceLYD}`);
    const dueBefore = getDeliveryReceiptDueUsage(r);
    assert(near(dueBefore.usedDueUSD, 30) && near(dueBefore.remainingDueUSD, 0), 'the unpaid receipt was not reserved exactly once');

    collect(r, 30);
    const after = getCustomerStats('c1');
    assert(near(after.balanceUSD, 0), `receipt payment should clear the debt, got ${usd(after.balanceUSD)}`);
    const paidUsage = getReceiptUsageStats(r);
    const dueUsage = getDeliveryReceiptDueUsage(r);
    assert(near(paidUsage.usedUSD, 30), `paid usage should stay $30, got ${usd(paidUsage.usedUSD)}`);
    assert(near(dueUsage.usedDueUSD, 30), `due view should stay $30, got ${usd(dueUsage.usedDueUSD)}`);
    assert(near(paidUsage.usedUSD, dueUsage.usedDueUSD), 'changing Paid exposed a second receipt balance');
  });

  await must('A0b. $4.63 paid plus $0.37 unpaid funds a $5 ad and only $0.37 remains debt', () => {
    resetState();
    const paid = paidReceipt('receipt_mixed_paid', 4.63, 5);
    const unpaid = {
      id: 'receipt_mixed_unpaid', recordType: 'receipt', customerId: 'c1',
      amountUSD: 0.37, amountLocal: 1.85, exchangeRate: 5,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
      statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: []
    };
    S.receipts.push(unpaid);
    makeAd({
      id: 'ad_mixed_a0b', amountUSD: 5, amountLocal: 25, spentUSD: 5,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: unpaid.id,
      receiptAllocations: [{ receiptId: paid.id, amountUSD: 4.63 }],
      dueAllocations: [{ receiptId: unpaid.id, amountUSD: 0.37 }],
      dueAmountToUseUSD: 0.37
    });

    const before = getCustomerStats('c1');
    assert(near(before.totalPaidUSD, 4.63), `paid total should be $4.63, got ${usd(before.totalPaidUSD)}`);
    assert(near(before.totalSpentUSD, 5), `ad spend should be $5, got ${usd(before.totalSpentUSD)}`);
    assert(near(before.balanceUSD, -0.37), `only the difference should be debt, got ${usd(before.balanceUSD)}`);
    const paidUsage = getReceiptUsageStats(paid);
    const dueUsage = getDeliveryReceiptDueUsage(unpaid);
    assert(near(paidUsage.usedUSD, 4.63) && near(paidUsage.remainingUSD, 0), 'paid receipt was not consumed exactly once');
    assert(near(dueUsage.usedDueUSD, 0.37) && near(dueUsage.remainingDueUSD, 0), 'unpaid receipt difference was not reserved exactly once');

    collect(unpaid, 0.37);
    const after = getCustomerStats('c1');
    assert(near(after.totalPaidUSD, 5), `paid total should become $5, got ${usd(after.totalPaidUSD)}`);
    assert(near(after.balanceUSD, 0), `paying the second receipt should clear the debt, got ${usd(after.balanceUSD)}`);
  });

  await must('A1. an ad funded $30 from a $100 paid receipt consumes exactly $30', () => {
    resetState();
    const r = paidReceipt('receipt_a1', 100);
    makeAd({ id: 'ad_a1', amountUSD: 30, spentUSD: 30, receiptAllocations: [{ receiptId: r.id, amountUSD: 30 }] });

    const stats = getReceiptUsageStats(r);
    assert(near(stats.usedUSD, 30), `usedUSD should be 30, got ${usd(stats.usedUSD)}`);
    assert(near(stats.remainingUSD, 70), `remainingUSD should be 100-30=70, got ${usd(stats.remainingUSD)}`);
    assert(near(stats.totalUSD, 100), `totalUSD should be the receipt capacity 100, got ${usd(stats.totalUSD)}`);
    assert(stats.usageStatus === 'Partially Used', `usageStatus should be Partially Used, got ${stats.usageStatus}`);
    assert(stats.fundedAds.length === 1, `exactly 1 funded ad expected, got ${stats.fundedAds.length}`);
    // Conservation: used + remaining == capacity (no transfers on this receipt).
    assert(near(stats.usedUSD + stats.remainingUSD, stats.totalUSD), 'used + remaining must equal the receipt capacity');
  });

  await must('A2. two ads on one $100 paid receipt: usage sums, never exceeds capacity', () => {
    resetState();
    const r = paidReceipt('receipt_a2', 100);
    makeAd({ id: 'ad_a2a', amountUSD: 30, spentUSD: 30, receiptAllocations: [{ receiptId: r.id, amountUSD: 30 }] });
    makeAd({ id: 'ad_a2b', amountUSD: 45, spentUSD: 45, receiptAllocations: [{ receiptId: r.id, amountUSD: 45 }] });

    const stats = getReceiptUsageStats(r);
    assert(near(stats.usedUSD, 75), `usedUSD should be 30+45=75, got ${usd(stats.usedUSD)}`);
    assert(near(stats.remainingUSD, 25), `remainingUSD should be 25, got ${usd(stats.remainingUSD)}`);
    assert(stats.usedUSD <= stats.totalUSD + 0.005, `two ads must not together exceed the receipt: used ${usd(stats.usedUSD)} vs capacity ${usd(stats.totalUSD)}`);
    assert(stats.fundedAds.length === 2, `both ads must be listed as funded, got ${stats.fundedAds.length}`);
  });

  await must('A2b. replacing an ad receipt returns the old credit and charges the new receipt exactly once', () => {
    resetState();
    const oldReceipt = paidReceipt('receipt_relink_old', 100);
    const newReceipt = paidReceipt('receipt_relink_new', 80);
    const ad = makeAd({
      id: 'ad_relink', amountUSD: 30, spentUSD: 30,
      receiptId: oldReceipt.id,
      fundingReceiptId: oldReceipt.id,
      receiptIds: [oldReceipt.id],
      receiptAllocations: [{ receiptId: oldReceipt.id, amountUSD: 30 }]
    });
    assert(near(getReceiptUsageStats(oldReceipt).remainingUSD, 70), 'old receipt did not hold the original allocation');
    assert(near(getReceiptUsageStats(newReceipt).remainingUSD, 80), 'new receipt was charged before replacement');

    // This is the authoritative shape returned by the atomic ad mutation.
    ad.receiptId = newReceipt.id;
    ad.fundingReceiptId = newReceipt.id;
    ad.receiptIds = [newReceipt.id];
    ad.receiptAllocations = [{ receiptId: newReceipt.id, amountUSD: 30 }];

    const oldAfter = getReceiptUsageStats(oldReceipt);
    const newAfter = getReceiptUsageStats(newReceipt);
    assert(near(oldAfter.usedUSD, 0) && near(oldAfter.remainingUSD, 100), `old credit was not fully returned: ${usd(oldAfter.remainingUSD)}`);
    assert(near(newAfter.usedUSD, 30) && near(newAfter.remainingUSD, 50), `new receipt was not charged exactly once: ${usd(newAfter.usedUSD)}`);
    assert(near(oldAfter.usedUSD + newAfter.usedUSD, 30), 'replacement duplicated or lost the ad allocation');
  });

  await must('A3-pre. an ad whose allocations point at ANOTHER receipt is not charged here', () => {
    // The hasAllocationData guard: an ad that HAS allocation arrays (even empty)
    // must never fall back to its full spend on a receipt it does not allocate to.
    resetState();
    const r = paidReceipt('receipt_a3p', 100);
    const other = paidReceipt('receipt_other', 100);
    makeAd({
      id: 'ad_a3p',
      amountUSD: 60,
      spentUSD: 60,
      receiptId: r.id,                                        // linked to r …
      receiptAllocations: [{ receiptId: other.id, amountUSD: 60 }] // … but funded by `other`
    });

    assert(near(getReceiptUsageStats(r).usedUSD, 0), `the linked-but-unfunded receipt must show $0 used, got ${usd(getReceiptUsageStats(r).usedUSD)}`);
    assert(near(getReceiptUsageStats(other).usedUSD, 60), `the funding receipt must show $60 used, got ${usd(getReceiptUsageStats(other).usedUSD)}`);
  });

  console.log('\n--- DELIVERY DUE POOL: getDeliveryReceiptDueUsage ---');

  await must('A3. an ad funded $40 from a $100 delivery due credit consumes exactly $40', () => {
    resetState();
    const r = deliveryReceipt('receipt_a3', 1000, 10); // 1000 LYD / 10 = $100 due
    dueFundedAd('ad_a3', r.id, 40);

    const due = getDeliveryReceiptDueUsage(r);
    assert(near(due.totalDueUSD, 100), `totalDueUSD = amountLocal/rate = 100, got ${usd(due.totalDueUSD)}`);
    assert(near(due.usedDueUSD, 40), `usedDueUSD should be 40, got ${usd(due.usedDueUSD)}`);
    assert(near(due.remainingDueUSD, 60), `remainingDueUSD should be 100-40=60, got ${usd(due.remainingDueUSD)}`);
    assert(near(due.usedDueUSD + due.remainingDueUSD, due.totalDueUSD), 'usedDue + remainingDue must equal the due capacity');
    assert(due.fundedAds.length === 1, `1 due-funded ad expected, got ${due.fundedAds.length}`);
  });

  await must('A3b. debtAmountLocal (when present) defines the due capacity, not amountLocal', () => {
    resetState();
    const r = deliveryReceipt('receipt_a3b', 1000, 10);
    r.debtAmountLocal = 500; // the customer only owes half
    dueFundedAd('ad_a3b', r.id, 20);

    const due = getDeliveryReceiptDueUsage(r);
    assert(near(due.totalDueUSD, 50), `totalDueUSD = debtAmountLocal/rate = 50, got ${usd(due.totalDueUSD)}`);
    assert(near(due.remainingDueUSD, 30), `remainingDueUSD should be 50-20=30, got ${usd(due.remainingDueUSD)}`);
  });

  await must('A4. a LEGACY ad (no dueAllocations array, only linkedDeliveryReceiptId + dueAmountToUseUSD) still consumes the due credit', () => {
    resetState();
    const r = deliveryReceipt('receipt_a4', 1000, 10); // $100 due
    makeAd({
      id: 'ad_a4',
      amountUSD: 25,
      spentUSD: 25,
      linkedDeliveryReceiptId: r.id,
      dueAmountToUseUSD: 25
      // NO receiptAllocations / dueAllocations arrays at all — pre-allocation record
    });

    const due = getDeliveryReceiptDueUsage(r);
    assert(near(due.usedDueUSD, 25), `legacy ad must count as $25 of due used, got ${usd(due.usedDueUSD)}`);
    assert(near(due.remainingDueUSD, 75), `remainingDueUSD should be 75, got ${usd(due.remainingDueUSD)}`);
    assert(due.fundedAds.length === 1, 'the legacy ad must appear in fundedAds');

    // The paid-pool reader falls back to the same legacy mirror.
    const stats = getReceiptUsageStats(r);
    assert(near(stats.usedUSD, 25), `getReceiptUsageStats must also see the legacy $25, got ${usd(stats.usedUSD)}`);
  });

  await must('A4b. a LEGACY ad holding only dueAmountToUseLYD is converted at the ad/receipt rate', () => {
    resetState();
    const r = deliveryReceipt('receipt_a4b', 1000, 10); // $100 due
    makeAd({
      id: 'ad_a4b',
      amountUSD: 30,
      linkedDeliveryReceiptId: r.id,
      dueAmountToUseLYD: 300 // 300 LYD at the receipt's rate of 10 = $30
    });

    const due = getDeliveryReceiptDueUsage(r);
    assert(near(due.usedDueUSD, 30), `300 LYD at rate 10 must count as $30 used, got ${usd(due.usedDueUSD)}`);
    assert(near(due.remainingDueUSD, 70), `remainingDueUSD should be 70, got ${usd(due.remainingDueUSD)}`);
  });

  await must('A4c. a mixed LEGACY In-Shop ad reserves its mirror from the unpaid receipt only', () => {
    resetState();
    const paid = paidReceipt('receipt_a4c_paid', 10, 9.7);
    const shop = {
      id: 'receipt_a4c_shop', recordType: 'receipt', customerId: 'c1',
      amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
      statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: []
    };
    S.receipts.push(shop);
    makeAd({
      id: 'ad_a4c', amountUSD: 40, spentUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: shop.id,
      receiptAllocations: [{ receiptId: paid.id, amountUSD: 10 }],
      dueAllocations: [],
      dueAmountToUseUSD: 30
    });

    const shopUsage = getReceiptUsageStats(shop);
    const shopDueUsage = getDeliveryReceiptDueUsage(shop);
    const paidUsage = getReceiptUsageStats(paid);
    assert(near(shopUsage.usedUSD, 30) && near(shopUsage.remainingUSD, 0),
      `legacy In-Shop mirror should reserve exactly $30, got ${usd(shopUsage.usedUSD)}`);
    assert(near(shopDueUsage.usedDueUSD, 30) && near(shopDueUsage.remainingDueUSD, 0),
      'due view did not recognize the legacy In-Shop mirror');
    assert(near(paidUsage.usedUSD, 10),
      `the separate paid receipt should be charged only $10, got ${usd(paidUsage.usedUSD)}`);
  });

  await must('A4d. a LEGACY In-Shop LYD mirror is converted at the saved rate', () => {
    resetState();
    const shop = {
      id: 'receipt_a4d_shop', recordType: 'receipt', customerId: 'c1',
      amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
      statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: []
    };
    S.receipts.push(shop);
    makeAd({
      id: 'ad_a4d', amountUSD: 30, spentUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: shop.id, receiptAllocations: [],
      dueAmountToUseUSD: 0, dueAmountToUseLYD: 291, exchangeRate: 9.7
    });

    assert(near(getReceiptUsageStats(shop).usedUSD, 30),
      '291 LYD legacy In-Shop mirror did not become exactly $30');
    assert(near(getDeliveryReceiptDueUsage(shop).usedDueUSD, 30),
      'due view did not convert the legacy In-Shop LYD mirror');
  });

  await must('A4e. the OLDEST driver ads (receiptId link only, no linkedDeliveryReceiptId) reserve their due mirror', () => {
    resetState();
    const r = deliveryReceipt('receipt_a4e', 1000, 10); // $100 due
    const other = deliveryReceipt('receipt_a4e_other', 500, 10); // $50 due
    // Pre-linkedDeliveryReceiptId row: the delivery receipt lives in receiptId.
    makeAd({
      id: 'ad_a4e', amountUSD: 40, spentUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: r.id,
      dueAmountToUseUSD: 40
      // NO allocation arrays, NO linkedDeliveryReceiptId — the oldest shape
    });
    // Control: when linkedDeliveryReceiptId IS set, receiptId must NOT charge
    // a second receipt — the fallback only speaks for rows missing the link.
    makeAd({
      id: 'ad_a4e_linked', amountUSD: 10, spentUSD: 10,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      linkedDeliveryReceiptId: other.id,
      receiptId: r.id,
      dueAmountToUseUSD: 10
    });

    const due = getDeliveryReceiptDueUsage(r);
    assert(near(due.usedDueUSD, 40), `receiptId-linked driver mirror must reserve $40, got ${usd(due.usedDueUSD)}`);
    assert(near(due.remainingDueUSD, 60), `remainingDueUSD should be 60, got ${usd(due.remainingDueUSD)}`);
    assert(due.fundedAds.length === 1, `exactly 1 funded ad expected on the main receipt, got ${due.fundedAds.length}`);
    assert(near(getReceiptUsageStats(r).usedUSD, 40),
      `getReceiptUsageStats must count the same $40, got ${usd(getReceiptUsageStats(r).usedUSD)}`);
    assert(near(getDeliveryReceiptDueUsage(other).usedDueUSD, 10),
      'the linked control ad must charge its linkedDeliveryReceiptId receipt');
  });

  await must('A4f. settling a receiptId-linked driver mirror converts EXACTLY what the readers counted, once', () => {
    resetState();
    const r = deliveryReceipt('receipt_a4f', 1000, 10); // $100 due
    const ad = makeAd({
      id: 'ad_a4f', amountUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: r.id,
      dueAmountToUseUSD: 40
    });

    const counted = getDeliveryReceiptDueUsage(r).usedDueUSD;
    assert(near(counted, 40), `pre-settle reader must count $40, got ${usd(counted)}`);

    collect(r, 100);
    const plans = sandbox.planLocalReceiptPaidAdUpdates(r.id);
    assert(plans.length === 1, `the planner must convert the legacy ad, got ${plans.length} plans`);
    const next = plans[0].data;
    const movedUSD = (next.receiptAllocations || [])
      .filter(a => String(a.receiptId) === r.id)
      .reduce((s, a) => s + a.amountUSD, 0);
    assert(near(movedUSD, counted), `planner moved ${usd(movedUSD)} but the readers counted ${usd(counted)} — they must agree`);
    assert(next.isPaid === true && next.paymentStatus === 'paid', 'a fully covered mirror must settle the ad to Paid');
    assert(near(next.dueAmountToUseUSD, 0), 'the mirror must be cleared after conversion');

    sandbox.applyLocalReceiptPaidAdUpdates(plans);
    const after = getReceiptUsageStats(r);
    assert(near(after.usedUSD, 40), `after settlement the receipt must be charged exactly once, got ${usd(after.usedUSD)}`);
    assert(near(after.remainingUSD, 60), `remaining must be 100-40=60, got ${usd(after.remainingUSD)}`);
    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 40),
      'both readers must still describe the same single $40 after settlement');
  });

  await must('A4g. canceling a delivery releases a receiptId-linked driver mirror — USD and LYD both', async () => {
    resetState();
    const r = deliveryReceipt('receipt_a4g', 1000, 10); // $100 due
    const ad = makeAd({
      id: 'ad_a4g', amountUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: r.id,
      dueAmountToUseUSD: 0,
      dueAmountToUseLYD: 400, // 400 LYD at rate 10 = $40
      exchangeRate: 10
    });
    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 40), 'pre-condition: the LYD mirror reserves $40');

    const touched = await sandbox.releaseCanceledDeliveryDueFunding(r.id);
    assert(touched === 1, `the release must touch the legacy ad, touched ${touched}`);
    const stored = S.ads.find(a => a.id === 'ad_a4g');
    assert(near(stored.dueAmountToUseUSD, 0) && near(stored.dueAmountToUseLYD || 0, 0),
      'BOTH mirror fields must be zeroed so the uncollectible money stops backing the ad');
    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 0),
      `after cancel-release nothing may still be reserved, got ${usd(getDeliveryReceiptDueUsage(r).usedDueUSD)}`);
  });

  await must('A4h. a PAID driver ad with a stale receiptId mirror reserves NOTHING and cancel leaves it alone', async () => {
    resetState();
    const r = deliveryReceipt('receipt_a4h', 1000, 10); // $100 due
    makeAd({
      id: 'ad_a4h', amountUSD: 40, spentUSD: 40,
      paymentStatus: 'paid', isPaid: true, collectionMethod: 'driver',
      receiptId: r.id,
      dueAmountToUseUSD: 40,
      receiptAllocations: [] // rows present so the whole-ad legacy fallback stays off
    });

    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 0),
      `a PAID ad's stale mirror must reserve $0 of due credit, got ${usd(getDeliveryReceiptDueUsage(r).usedDueUSD)}`);
    assert(near(getReceiptUsageStats(r).usedUSD, 0),
      `a PAID ad's stale mirror must charge $0 of paid balance, got ${usd(getReceiptUsageStats(r).usedUSD)}`);

    const touched = await sandbox.releaseCanceledDeliveryDueFunding(r.id);
    assert(touched === 0, `cancel-release must not touch a PAID ad, touched ${touched}`);
    const stored = S.ads.find(a => a.id === 'ad_a4h');
    assert(near(stored.dueAmountToUseUSD, 40),
      'the PAID ad\'s stale mirror must stay untouched — it is history, not live debt');
  });

  await must('A4i. a mirror that MIRRORS surviving due rows is never charged or converted a second time', () => {
    resetState();
    const r1 = deliveryReceipt('receipt_a4i_one', 300, 10); // $30 due
    const r2 = deliveryReceipt('receipt_a4i_two', 300, 10); // $30 due
    // Mixed shape: the receiptId identity points at r1, but the ad's only real
    // due money is a row on r2 — and the writers keep the scalar mirror equal
    // to the surviving rows' sum ($30).
    makeAd({
      id: 'ad_a4i', amountUSD: 60, spentUSD: 60,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: r1.id,
      dueAllocations: [{ receiptId: r2.id, amountUSD: 30 }],
      dueAmountToUseUSD: 30
    });

    assert(near(getDeliveryReceiptDueUsage(r1).usedDueUSD, 0),
      `r1 must not be charged the row-total mirror, got ${usd(getDeliveryReceiptDueUsage(r1).usedDueUSD)}`);
    assert(near(getDeliveryReceiptDueUsage(r2).usedDueUSD, 30),
      `r2 must be charged its row exactly once, got ${usd(getDeliveryReceiptDueUsage(r2).usedDueUSD)}`);

    // Settling r1 (collected for exactly its paper value) must succeed and
    // convert NOTHING — the ad's due money belongs to r2.
    collect(r1, 30);
    const plans = sandbox.planLocalReceiptPaidAdUpdates(r1.id);
    assert(plans.length === 0, `settling r1 must not convert the row-total mirror, got ${plans.length} plans`);
    assert(near(getReceiptUsageStats(r1).usedUSD, 0),
      `after settling r1 nothing may be charged to it, got ${usd(getReceiptUsageStats(r1).usedUSD)}`);
    assert(near(getDeliveryReceiptDueUsage(r2).usedDueUSD, 30),
      'r2 must still hold its single $30 commitment after r1 settles');
  });

  await must('A4j. a FULL refund of a rowless receiptId-linked driver mirror returns the due credit', async () => {
    resetState();
    const r = deliveryReceipt('receipt_a4j', 1000, 10); // $100 due
    const ad = makeAd({
      id: 'ad_a4j', amountUSD: 40, spentUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: r.id,
      dueAmountToUseUSD: 40
      // NO allocation arrays — the oldest shape, straight from storage
    });
    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 40), 'pre-condition: the mirror reserves $40');

    S.modalData = { id: ad.id, status: ad.status, canceledBy: undefined };
    setRefundInputs('Full', 40, 'Refunded');
    await sandbox.saveRefund();

    const saved = S.ads.find(a => a.id === 'ad_a4j');
    assert(near(saved.dueAmountToUseUSD, 0), `the mirror must be released, still ${usd(saved.dueAmountToUseUSD)}`);
    assert(near(getDeliveryReceiptDueUsage(r).usedDueUSD, 0),
      `after a full refund the $40 of due credit must return, got ${usd(getDeliveryReceiptDueUsage(r).usedDueUSD)} still used`);
    assert(near(getDeliveryReceiptDueUsage(r).remainingDueUSD, 100),
      'the receipt must be fully spendable again');
  });

  console.log('\n--- LIQUIDITY COVERAGE: getLiquiditySnapshot ---');

  // Raw paid receipt with explicit dates (the fixtures above stamp "now").
  function datedPaidReceipt(id, amountUSD, paidDate, extra = {}) {
    const r = {
      id, recordType: 'receipt', customerId: 'c1',
      amountUSD, amountLocal: amountUSD * 5, exchangeRate: 5,
      status: 'Paid', isPaid: true, deliveryStatus: 'Office',
      collectionDate: paidDate, createdAt: paidDate,
      payments: [], transfers: [], ...extra
    };
    S.receipts.push(r);
    return r;
  }
  function startLiquidityTracking(startDate, recordedAt) {
    S.appSettings.push({
      id: `lq_${recordedAt}`, settingKey: 'liquidityTracking',
      startDate, setBy: 'u-admin', date: recordedAt
    });
  }

  await must('L1. money owed to customers = the unused credit on every paid receipt', () => {
    resetState();
    S.appSettings = [];
    const r1 = paidReceipt('receipt_l1a', 100);
    paidReceipt('receipt_l1b', 50);
    makeAd({ id: 'ad_l1', amountUSD: 30, receiptAllocations: [{ receiptId: r1.id, amountUSD: 30 }] });

    const snap = sandbox.getLiquiditySnapshot();
    assert(snap.tracking === false, 'without a start date nothing is tracked yet');
    assert(near(snap.liabilityUSD, 120), `owed = (100-30)+50 = $120, got ${usd(snap.liabilityUSD)}`);
    assert(near(snap.collectedUSD, 0) && near(snap.adSpendUSD, 0), 'no window means no collected/spent numbers');
  });

  await must('L2. new-cash counts only real money paid inside the window — transfers and carried balances never', () => {
    resetState();
    S.appSettings = [];
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    datedPaidReceipt('receipt_l2_old', 30, '2026-06-01T10:00:00.000Z');                      // before the window
    datedPaidReceipt('receipt_l2_new', 40, '2026-07-10T10:00:00.000Z');                      // real new cash
    datedPaidReceipt('receipt_l2_tin', 25, '2026-07-11T10:00:00.000Z', { receiptType: 'TRANSFER_IN' });   // moved, not new
    datedPaidReceipt('receipt_l2_car', 60, '2026-07-12T10:00:00.000Z', { receiptType: 'CARRIED_BALANCE' }); // old credit, not new
    S.receipts.push({ id: 'receipt_l2_unpaid', recordType: 'receipt', customerId: 'c1', amountUSD: 99,
      status: 'Not Paid', isPaid: false, payments: [], transfers: [], createdAt: '2026-07-13T10:00:00.000Z' });

    const snap = sandbox.getLiquiditySnapshot();
    assert(snap.tracking === true && snap.startDate === '2026-07-01T00:00:00.000Z', 'the start date was not read');
    assert(near(snap.collectedUSD, 40), `only the $40 receipt is NEW cash, got ${usd(snap.collectedUSD)}`);
    assert(near(snap.liabilityUSD, 30 + 40 + 25 + 60), `owed must count every paid receipt, got ${usd(snap.liabilityUSD)}`);

    // The NEWEST start date wins (append-only history, like the exchange rate).
    startLiquidityTracking('2026-07-15T00:00:00.000Z', '2026-07-15T08:00:00.000Z');
    const moved = sandbox.getLiquiditySnapshot();
    assert(near(moved.collectedUSD, 0), `after moving the start to Jul 15 nothing is new yet, got ${usd(moved.collectedUSD)}`);
  });

  await must('L3. new ad spending counts new ads fully and old ads only for their in-window top-ups (capped)', () => {
    resetState();
    S.appSettings = [];
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    datedPaidReceipt('receipt_l3', 100, '2026-07-05T10:00:00.000Z');
    makeAd({ id: 'ad_l3_new', amountUSD: 30, status: 'Active', createdAt: '2026-07-05T12:00:00.000Z' });
    makeAd({ id: 'ad_l3_old', amountUSD: 100, status: 'Active', createdAt: '2026-06-01T12:00:00.000Z',
      topUps: [{ date: '2026-07-08T10:00:00.000Z', amount: 20 }, { date: '2026-06-15T10:00:00.000Z', amount: 5 }] });
    makeAd({ id: 'ad_l3_cap', amountUSD: 500, spentUSD: 10, status: 'Stopped', createdAt: '2026-06-01T12:00:00.000Z',
      topUps: [{ date: '2026-07-09T10:00:00.000Z', amount: 50 }] });
    makeAd({ id: 'ad_l3_pending', amountUSD: 80, status: 'Pending', createdAt: '2026-07-06T12:00:00.000Z' });

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.adSpendUSD, 30 + 20 + 10),
      `spend = new $30 + in-window top-up $20 + capped $10, got ${usd(snap.adSpendUSD)}`);
    assert(near(snap.netUSD, snap.collectedUSD - snap.adSpendUSD), 'net must equal collected minus spent');
  });

  await must('L4. coverage and shortfall describe exactly how much customer money is still uncovered', () => {
    resetState();
    S.appSettings = [];
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    // $100 collected in-window; $40 of it already promised to a new ad;
    // $120 owed overall (the untouched $60 of the new receipt + $60 old).
    const rNew = datedPaidReceipt('receipt_l4_new', 100, '2026-07-05T10:00:00.000Z');
    datedPaidReceipt('receipt_l4_old', 60, '2026-06-01T10:00:00.000Z');
    makeAd({ id: 'ad_l4', amountUSD: 40, status: 'Active', createdAt: '2026-07-06T12:00:00.000Z',
      receiptAllocations: [{ receiptId: rNew.id, amountUSD: 40 }] });

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.collectedUSD, 100), `collected should be $100, got ${usd(snap.collectedUSD)}`);
    assert(near(snap.adSpendUSD, 40), `ad spend should be $40, got ${usd(snap.adSpendUSD)}`);
    assert(near(snap.netUSD, 60), `net new cash should be $60, got ${usd(snap.netUSD)}`);
    assert(near(snap.liabilityUSD, 120), `owed should be (100-40)+60 = $120, got ${usd(snap.liabilityUSD)}`);
    assert(near(snap.shortfallUSD, 60), `uncovered should be 120-60 = $60, got ${usd(snap.shortfallUSD)}`);
    assert(near(snap.coveragePercent, 50), `coverage should be 50%, got ${snap.coveragePercent}%`);
  });

  await must('L5. the explicit cash-arrival stamp beats a rewritten collectionDate', () => {
    resetState();
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    // A form-edit once rewrote this old receipt's collectionDate into the
    // window; its real cash confirmation (collectedAt) is from June and wins.
    datedPaidReceipt('receipt_l5_edited', 50, '2026-07-10T10:00:00.000Z', { collectedAt: '2026-06-01T10:00:00.000Z' });
    // A genuine in-window collection with no other stamps still counts.
    datedPaidReceipt('receipt_l5_real', 15, '2026-07-09T10:00:00.000Z');

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.collectedUSD, 15),
      `only the genuinely new $15 is new cash — the edited old receipt must not count, got ${usd(snap.collectedUSD)}`);
  });

  await must('L6. confirming an OLD receipt as collected inside the window must not mint new cash', () => {
    resetState();
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    // Receipt paid in March; the admin only clicks "collected" in July while
    // reconciling the backlog. The click-time stamp must not make it new.
    datedPaidReceipt('receipt_l6', 500, '2026-03-01T10:00:00.000Z', { collected: true, collectedAt: '2026-07-20T10:00:00.000Z' });

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.collectedUSD, 0),
      `a late confirmation of old money must count $0 new cash, got ${usd(snap.collectedUSD)}`);
    assert(near(snap.liabilityUSD, 500), 'the old receipt still counts as owed');
  });

  await must('L7. a canceled receipt stays in the books until its refund is actually handed back', () => {
    resetState();
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    const r = datedPaidReceipt('receipt_l7', 400, '2026-07-05T10:00:00.000Z');
    r.status = 'Canceled';
    r.statusDetail = { refundAction: 'full', refundStatus: 'pending' };

    const pending = sandbox.getLiquiditySnapshot();
    assert(near(pending.liabilityUSD, 400),
      `while the refund is pending the shop still owes $400, got ${usd(pending.liabilityUSD)}`);
    assert(near(pending.collectedUSD, 400), 'the in-window collection is still real cash while held');

    r.statusDetail.refundStatus = 'refunded';
    const done = sandbox.getLiquiditySnapshot();
    assert(near(done.liabilityUSD, 0),
      `after the refund is handed back nothing is owed, got ${usd(done.liabilityUSD)}`);
    assert(near(done.collectedUSD, 0), 'refunded money is no longer held cash');
  });

  await must('L8. an UNDERPAID delivery completion is real collected cash despite its Not Paid status', () => {
    resetState();
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    S.receipts.push({
      id: 'receipt_l8', recordType: 'receipt', customerId: 'c1',
      amountUSD: 35, amountLocal: 175, exchangeRate: 5,
      status: 'Not Paid', isPaid: false,
      deliveryStatus: 'Delivered', deliveredAt: '2026-07-10T10:00:00.000Z',
      paymentResult: 'UNDERPAID',
      payments: [], transfers: [], createdAt: '2026-06-20T10:00:00.000Z'
    });

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.collectedUSD, 35),
      `the driver really collected $35 in the window, got ${usd(snap.collectedUSD)}`);
    assert(near(snap.liabilityUSD, 35), 'the collected-but-underpaid money is owed to the customer');
  });

  await must('L9. growing a PRE-WINDOW ad by an ordinary edit counts the dated growth (capped at real spend)', () => {
    resetState();
    startLiquidityTracking('2026-07-01T00:00:00.000Z', '2026-07-01T08:00:00.000Z');
    datedPaidReceipt('receipt_l9', 100, '2026-07-05T10:00:00.000Z');
    // Ordinary-edit growth recorded in the append-only amountAdjustments ledger.
    makeAd({ id: 'ad_l9_grown', amountUSD: 100, status: 'Active', createdAt: '2026-06-01T12:00:00.000Z',
      amountAdjustments: [{ delta: 25, date: '2026-07-08T10:00:00.000Z' }, { delta: 10, date: '2026-06-15T10:00:00.000Z' }] });
    // The cap: growth claims $50 but the stopped ad only ever spent $10.
    makeAd({ id: 'ad_l9_capped', amountUSD: 500, spentUSD: 10, status: 'Stopped', createdAt: '2026-06-01T12:00:00.000Z',
      amountAdjustments: [{ delta: 50, date: '2026-07-09T10:00:00.000Z' }] });

    const snap = sandbox.getLiquiditySnapshot();
    assert(near(snap.adSpendUSD, 25 + 10),
      `spend = in-window growth $25 + capped $10, got ${usd(snap.adSpendUSD)}`);
  });

  console.log('\n--- SOFT DELETES ---');

  await must('A5. soft-deleted ads (_deleted) consume NOTHING from either pool', () => {
    resetState();
    const paid = paidReceipt('receipt_a5p', 100);         // paid pool
    const del = deliveryReceipt('receipt_a5d', 1000, 10); // due pool  (allocation-style ad)
    const legacyDel = deliveryReceipt('receipt_a5l', 500, 10); // due pool (legacy-mirror ad)

    const ghostPaid = makeAd({ id: 'ad_a5p', amountUSD: 100, spentUSD: 100, receiptAllocations: [{ receiptId: paid.id, amountUSD: 100 }] });
    const ghostDue = dueFundedAd('ad_a5d', del.id, 100);
    const ghostLegacy = makeAd({ id: 'ad_a5l', amountUSD: 50, linkedDeliveryReceiptId: legacyDel.id, dueAmountToUseUSD: 50 });

    // Everything is spent...
    assert(near(getReceiptUsageStats(paid).usedUSD, 100), 'pre-condition: the paid receipt is fully used');
    assert(near(getDeliveryReceiptDueUsage(del).usedDueUSD, 100), 'pre-condition: the due credit is fully used');
    assert(near(getDeliveryReceiptDueUsage(legacyDel).usedDueUSD, 50), 'pre-condition: the legacy ad holds $50 of due');

    // ...then all three ads are soft-deleted: every dollar must come back.
    ghostPaid._deleted = true;
    ghostDue._deleted = true;
    ghostLegacy._deleted = true;

    const stats = getReceiptUsageStats(paid);
    assert(near(stats.usedUSD, 0), `a deleted ad must consume nothing, got ${usd(stats.usedUSD)} used`);
    assert(near(stats.remainingUSD, 100), `the whole $100 must be spendable again, got ${usd(stats.remainingUSD)}`);
    assert(stats.fundedAds.length === 0, 'a deleted ad must not be listed as funded');

    const due = getDeliveryReceiptDueUsage(del);
    assert(near(due.usedDueUSD, 0), `a deleted ad must consume no due credit, got ${usd(due.usedDueUSD)}`);
    assert(near(due.remainingDueUSD, 100), `the whole $100 of due credit must return, got ${usd(due.remainingDueUSD)}`);
    assert(due.fundedAds.length === 0, 'a deleted ad must not be listed as due-funded');

    const legacyDue = getDeliveryReceiptDueUsage(legacyDel);
    assert(near(legacyDue.usedDueUSD, 0), `a deleted LEGACY ad must consume no due credit, got ${usd(legacyDue.usedDueUSD)}`);
    assert(near(legacyDue.remainingDueUSD, 50), `the legacy ad's $50 of due credit must return, got ${usd(legacyDue.remainingDueUSD)}`);
  });

  await must('A5b. a receipt with no ads at all reports its full capacity as remaining', () => {
    resetState();
    const paid = paidReceipt('receipt_a5b', 100);
    const del = deliveryReceipt('receipt_a5bd', 1000, 10);
    assert(near(getReceiptUsageStats(paid).remainingUSD, 100), 'untouched paid receipt must be fully available');
    assert(getReceiptUsageStats(paid).usageStatus === 'Unused', 'untouched paid receipt must read Unused');
    assert(near(getDeliveryReceiptDueUsage(del).remainingDueUSD, 100), 'untouched due credit must be fully available');
  });

  console.log('\n--- REFUNDS (real saveRefund, driven through the modal inputs) ---');

  await must('A6. a PARTIAL refund of a due-funded ad returns exactly the refunded credit', async () => {
    // This is the half of bug #51 that already works, and it pins the exact
    // boundary of the bug: saveRefund rebuilds ad.dueAllocations from a frozen
    // baseline, so while the allocation sum stays ABOVE zero the reader uses it
    // and the credit comes back correctly. The moment a FULL refund drives that
    // sum to 0, the reader falls back to the stale legacy mirror — see B1.
    resetState();
    const r = deliveryReceipt('receipt_a6', 1000, 10);  // $100 of due credit
    const ad = dueFundedAd('ad_a6', r.id, 100);         // one ad takes all of it

    S.modalData = { id: ad.id, status: ad.status, canceledBy: undefined };
    setRefundInputs('Partial', 40, 'Refunded');
    await sandbox.saveRefund();

    const saved = S.ads.find(a => a.id === 'ad_a6');
    assert(saved.refundType === 'Partial', 'pre-condition: the partial refund did not save');
    assert(near(saved.refundAmount, 40), `pre-condition: refundAmount should be 40, got ${saved.refundAmount}`);
    assert(near(saved.spentUSD, 60), `spentUSD must drop to 100-40=60, got ${usd(saved.spentUSD)}`);

    const after = getDeliveryReceiptDueUsage(r);
    assert(near(after.usedDueUSD, 60), `a $40 refund must leave $60 of due used, got ${usd(after.usedDueUSD)}`);
    assert(near(after.remainingDueUSD, 40), `$40 of due credit must be spendable again, got ${usd(after.remainingDueUSD)}`);
  });

  await must('A6b. re-saving the SAME refund is idempotent (money is not returned twice)', async () => {
    resetState();
    const r = deliveryReceipt('receipt_a6b', 1000, 10);
    const ad = dueFundedAd('ad_a6b', r.id, 100);

    S.modalData = { id: ad.id, status: ad.status, canceledBy: undefined };
    setRefundInputs('Partial', 40, 'Refunded');
    await sandbox.saveRefund();
    const once = getDeliveryReceiptDueUsage(r).remainingDueUSD;

    // Re-open the refund modal on the SAME ad and save the same numbers again.
    const savedAd = S.ads.find(a => a.id === 'ad_a6b');
    S.modalData = { id: savedAd.id, status: savedAd.status, canceledBy: savedAd.canceledBy };
    await sandbox.saveRefund();
    const twice = getDeliveryReceiptDueUsage(r).remainingDueUSD;

    assert(near(once, 40), `first save must return $40, got ${usd(once)}`);
    assert(near(twice, once), `re-saving the same refund must not return the money again: ${usd(once)} -> ${usd(twice)}`);
  });

  await must('A7. a driver-collected ad that spent NO due credit does not consume any', () => {
    resetState();
    // Pending delivery receipt: 1000 LYD @ 5 = $200 of due credit, none of it spent.
    const r = deliveryReceipt('receipt_a7', 1000, 5);

    // A not_paid + driver ad: the customer pays the driver in cash, so this ad is funded by
    // NOTHING. It merely REFERENCES the delivery receipt (receiptId + linkedDeliveryReceiptId
    // are set by the server). It predates allocations, so it carries no arrays at all.
    // getReceiptUsageStats has a whole-ad fallback that charges such an ad's ENTIRE spend
    // against any receipt it references — so the due reader must NOT be built on that
    // fallback, or this ad silently eats $100 of credit the customer really holds.
    makeAd({
      id: 'ad_a7_driver',
      amountUSD: 100,
      spentUSD: 100,
      paymentStatus: 'not_paid',
      collectionMethod: 'driver',
      isPaid: false,
      receiptId: r.id,
      linkedDeliveryReceiptId: r.id,
      dueAmountToUseUSD: 0
      // no receiptAllocations, no dueAllocations — the pre-allocation shape
    });

    const due = getDeliveryReceiptDueUsage(r);
    assert(
      near(due.usedDueUSD, 0),
      `a cash-collected driver ad consumed ${usd(due.usedDueUSD)} of due credit it never spent`
    );
    assert(
      near(due.remainingDueUSD, 200),
      `the customer's full $200 of due credit must still be available, got ${usd(due.remainingDueUSD)} ` +
      `— this ad is funded by the customer's cash, not by the receipt's credit`
    );
  });

  await must('A7b. a rowless In-Shop receipt link with a zero mirror is provenance, not money', () => {
    resetState();
    const shop = {
      id: 'receipt_a7b_shop', recordType: 'receipt', customerId: 'c1',
      amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
      statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: []
    };
    S.receipts.push(shop);
    makeAd({
      id: 'ad_a7b_shop', amountUSD: 30, spentUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: shop.id, dueAmountToUseUSD: 0
      // no allocation arrays: the link is history only and cannot mint $30
    });

    const paidView = getReceiptUsageStats(shop);
    const dueView = getDeliveryReceiptDueUsage(shop);
    assert(near(paidView.usedUSD, 0) && near(paidView.remainingUSD, 30),
      'rowless zero In-Shop provenance incorrectly consumed the whole ad');
    assert(near(dueView.usedDueUSD, 0) && near(dueView.remainingDueUSD, 30),
      'rowless zero In-Shop provenance incorrectly consumed due capacity');
  });

  await must('A8. delivery collection Rate 1 is never 0 for any payment method', () => {
    // The Mark-Delivered form records collected money as split-payment rows and compares
    // the LYD total (sum of amount x Rate1) to the debt. If Rate1 defaults to 0 for a
    // method, a fully-collected delivery records 0 LYD -> falsely UNDERPAID. getDefaultRate1
    // returns 0 for several methods (a receipt expects a hand-entered rate); the delivery
    // must substitute a real conversion so no method silently zeroes the collection.
    S.defaultExchangeRate = 9.5;
    for (const method of PAYMENT_METHODS) {
      const r1 = _deliveryDefaultRate1(method);
      assert(
        Number.isFinite(r1) && r1 > 0,
        `delivery Rate 1 for "${method}" is ${r1} — a 0 rate records 0 LYD collected on a real payment`
      );
    }
  });

  console.log('\n\n############################################################');
  console.log('# GROUP B — TARGET BEHAVIOUR (known broken today)');
  console.log('#   Each test asserts the CORRECT behaviour. It fails today.');
  console.log('#   These are the invariants the redesign must MAKE true.');
  console.log('############################################################\n');

  console.log('--- B1: BUG #51 — a full refund must RETURN delivery due credit ---');

  await target('B1. an ad fully funded from due credit, then fully refunded, returns the credit', async () => {
    resetState();
    const r = deliveryReceipt('receipt_b1', 1000, 10);   // $100 of due credit
    const ad = dueFundedAd('ad_b1', r.id, 100);          // one ad takes ALL of it

    const before = getDeliveryReceiptDueUsage(r);
    assert(near(before.usedDueUSD, 100), `pre-condition: the ad must hold all $100 of due, got ${usd(before.usedDueUSD)}`);

    // Drive the REAL refund flow: saveRefund() reads the modal inputs from the DOM.
    S.modalData = { id: ad.id, status: ad.status, canceledBy: undefined };
    setRefundInputs('Full', 100, 'Refunded');
    await sandbox.saveRefund();

    const saved = S.ads.find(a => a.id === 'ad_b1');
    assert(saved.refundType === 'Full', 'pre-condition: the refund did not save (refundType missing)');
    assert(saved.status === 'Canceled', 'pre-condition: a refunded ad must be Canceled');

    const after = getDeliveryReceiptDueUsage(r);
    assert(
      near(after.remainingDueUSD, after.totalDueUSD),
      `a FULL refund must hand the credit back: remainingDueUSD ${usd(after.remainingDueUSD)} should be back to totalDueUSD ${usd(after.totalDueUSD)} ` +
      `(usedDueUSD is still ${usd(after.usedDueUSD)}). saveRefund zeroes ad.dueAllocations[] but never clears the legacy mirror ` +
      `ad.dueAmountToUseUSD (=${saved.dueAmountToUseUSD}), and getDeliveryReceiptDueUsage falls back to that mirror whenever the ` +
      `allocation sum is 0 — so the credit stays LOCKED.`
    );
    assert(near(after.usedDueUSD, 0), `after a full refund nothing may still be marked used, got ${usd(after.usedDueUSD)}`);

    // The paid-pool reader must agree — it falls back to the same stale mirror.
    const stats = getReceiptUsageStats(r);
    assert(near(stats.usedUSD, 0), `getReceiptUsageStats must also see the refund, still reports ${usd(stats.usedUSD)} used`);
  });

  await target('B1b. a refund that empties the LAST due allocation row must still return the credit', async () => {
    // Same bug from the other side: two ads share the due credit; refunding one
    // of them in FULL drives ITS allocation sum to 0, and the stale mirror on
    // that ad keeps the money locked. (A6 shows a PARTIAL refund works — the bug
    // only bites when an ad's allocation sum reaches exactly 0.)
    resetState();
    const r = deliveryReceipt('receipt_b1b', 1000, 10); // $100 of due credit
    dueFundedAd('ad_b1b_keep', r.id, 30);               // this ad keeps its $30
    const ad = dueFundedAd('ad_b1b_refund', r.id, 70);  // this one is refunded in full

    S.modalData = { id: ad.id, status: ad.status, canceledBy: undefined };
    setRefundInputs('Full', 70, 'Refunded');
    await sandbox.saveRefund();

    const saved = S.ads.find(a => a.id === 'ad_b1b_refund');
    assert(saved.refundType === 'Full', 'pre-condition: the refund did not save');

    const after = getDeliveryReceiptDueUsage(r);
    assert(
      near(after.usedDueUSD, 30),
      `after refunding the $70 ad only the $30 ad may still hold due credit, but usedDueUSD is ${usd(after.usedDueUSD)} ` +
      `(the refunded ad's dueAllocations sum to $0 yet its stale mirror dueAmountToUseUSD=${saved.dueAmountToUseUSD} is counted instead)`
    );
    assert(near(after.remainingDueUSD, 70), `$70 of due credit must be spendable again, got ${usd(after.remainingDueUSD)}`);
  });

  console.log('\n--- B2: CROSS-POOL DOUBLE-SPEND — $200 of ads against a $100 receipt ---');

  await target('B2. due credit already spent leaves NO paid balance to spend again', () => {
    resetState();
    // A delivery receipt worth 1000 LYD @ 10 = $100 of due credit.
    const r = deliveryReceipt('receipt_b2', 1000, 10);
    const capacity = 100;

    // Ad A spends ALL the due credit while the debt is still uncollected.
    dueFundedAd('ad_b2_due', r.id, 100);

    // The driver hands the cash in: the SAME record becomes an ordinary Paid receipt.
    collect(r, capacity);

    // The $100 is GONE — ad A is holding it. The receipt must now offer nothing
    // more, or a second ad can be funded from the very same note. This is the
    // reachable half of the double-spend: it is what the funding pickers read.
    const stats = getReceiptUsageStats(r);
    assert(
      near(stats.remainingUSD, 0),
      `DOUBLE-SPEND: ad_b2_due already holds the receipt's ${usd(capacity)} as due credit, yet ` +
      `getReceiptUsageStats still offers ${usd(stats.remainingUSD)} of spendable paid balance — so a second ` +
      `ad can be funded from the same money. usedUSD reports ${usd(stats.usedUSD)}; it never counts due rows.`
    );
    assert(
      near(stats.usedUSD, capacity),
      `the receipt's ${usd(capacity)} is fully committed to ad_b2_due, but usedUSD reports ${usd(stats.usedUSD)}`
    );
  });

  await target('B2b. spending the paid balance must SHRINK the due credit (the two readers must see each other)', () => {
    resetState();
    const r = deliveryReceipt('receipt_b2b', 1000, 10); // $100 — one pot
    collect(r, 100);

    // A single ad takes the whole $100 from the PAID pool.
    makeAd({
      id: 'ad_b2b',
      amountUSD: 100,
      spentUSD: 100,
      receiptAllocations: [{ receiptId: r.id, amountUSD: 100 }],
      dueAllocations: []
    });

    const due = getDeliveryReceiptDueUsage(r);
    assert(
      near(due.remainingDueUSD, 0),
      `the $100 is already spent from the paid pool, yet getDeliveryReceiptDueUsage still offers ` +
      `${usd(due.remainingDueUSD)} of due credit — it never looks at ad.receiptAllocations, so the same ` +
      `dollars can be handed out a second time.`
    );
  });

  console.log('\n--- B3: ONE-POT — the two readers must not describe two capacities ---');

  await target('B3. the two readers describe ONE pot: same committed, same remaining', () => {
    resetState();
    const r = deliveryReceipt('receipt_b3', 1000, 10); // 1000 LYD @ 10 = $100
    const capacity = 100;

    // ONE ad, funded once, from the due credit. Then the receipt is collected.
    dueFundedAd('ad_b3', r.id, 40);
    collect(r, capacity);

    const paid = getReceiptUsageStats(r);
    const due = getDeliveryReceiptDueUsage(r);

    // The receipt is ONE $100 note held once. Both readers are views over the SAME
    // committed total, so they must AGREE. (Summing them would double-count the very
    // same dollars — that confusion is the bug.)
    assert(
      near(paid.usedUSD, due.usedDueUSD),
      `ONE-POT VIOLATION: the same $40 of funding is reported as ${usd(paid.usedUSD)} used by ` +
      `getReceiptUsageStats but ${usd(due.usedDueUSD)} by getDeliveryReceiptDueUsage. The two readers ` +
      `must count the same commitments against the receipt, not maintain separate ledgers.`
    );
    assert(
      near(paid.remainingUSD, due.remainingDueUSD),
      `the receipt has ONE spendable balance, but the readers disagree: ${usd(paid.remainingUSD)} (paid) ` +
      `vs ${usd(due.remainingDueUSD)} (due). Whichever is larger can be spent twice.`
    );
    assert(
      near(paid.usedUSD + paid.remainingUSD, capacity),
      `used + remaining must reconcile to the receipt's ${usd(capacity)}`
    );
  });

  await target('B3b. the two capacities of a collected delivery receipt are the same money', () => {
    resetState();
    const r = deliveryReceipt('receipt_b3b', 1000, 10);
    collect(r, 100);

    const paidCapacity = getReceiptUsageStats(r).totalUSD;             // amountUSD
    const dueCapacity = getDeliveryReceiptDueUsage(r).totalDueUSD;     // must be the SAME pot

    // Both readers must agree the pot is $100 — and mean the SAME $100.
    assert(near(paidCapacity, 100), `paid capacity should be $100, got ${usd(paidCapacity)}`);
    assert(near(dueCapacity, 100), `due capacity should be $100, got ${usd(dueCapacity)}`);

    // Now spend $60 of it, through EITHER pool. Both readers must report the one
    // remaining balance. If they disagree, the larger figure is spendable a second time
    // — that is the double-spend. (Their remainings must never be ADDED: they are two
    // views of one pot, not two pots.)
    makeAd({
      id: 'ad_b3b',
      amountUSD: 60,
      spentUSD: 60,
      receiptAllocations: [{ receiptId: r.id, amountUSD: 60 }],
      dueAllocations: []
    });

    const paidLeft = getReceiptUsageStats(r).remainingUSD;
    const dueLeft = getDeliveryReceiptDueUsage(r).remainingDueUSD;
    assert(
      near(paidLeft, dueLeft),
      `the receipt has ONE spendable balance, but the readers disagree: ${usd(paidLeft)} (paid) vs ` +
      `${usd(dueLeft)} (due). $60 was already spent, so the same money is still on offer through the ` +
      `other pool and can be handed out twice.`
    );
    assert(near(paidLeft, 40), `after spending $60 of $100, exactly $40 must remain, got ${usd(paidLeft)}`);
  });

  // ---------- report ----------
  const totalA = passedA + failuresA.length;
  const totalB = fixedB + knownBroken.length;

  console.log(`\n${'='.repeat(64)}`);
  console.log(`GROUP A (MUST HOLD TODAY): ${passedA}/${totalA} passed`);
  if (failuresA.length) failuresA.forEach(f => console.log(`  FAILED: ${f}`));
  console.log(`GROUP B (TARGET BEHAVIOUR): ${fixedB}/${totalB} already correct, ${knownBroken.length} KNOWN-BROKEN`);
  knownBroken.forEach(f => console.log(`  KNOWN-BROKEN: ${f.name}`));
  console.log('='.repeat(64));

  if (failuresA.length) {
    console.log(`\nFAILED: ${failuresA.length} money invariant(s) that hold today were broken.`);
    process.exit(1);
  }
  console.log(`\nALL ${passedA} MONEY INVARIANTS HOLD. ${knownBroken.length} target behaviour(s) still broken (documented above).`);
}

main().catch(err => {
  console.error('\nHARNESS ERROR:', err);
  process.exit(1);
});
