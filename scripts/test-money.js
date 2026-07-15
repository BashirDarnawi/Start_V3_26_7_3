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
