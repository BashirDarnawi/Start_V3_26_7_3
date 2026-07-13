/**
 * Permission enforcement tests for the built bundle (script.js).
 *
 * Loads script.js in a stubbed browser sandbox (init() never runs because
 * document.readyState is 'loading') and drives the real render/handler
 * functions with different permission sets, asserting that a user only ever
 * sees and does what their permissions allow.
 *
 * Run: node scripts/test-permissions.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'script.js');

// ---------- minimal browser stubs ----------
function makeElement() {
  const el = {
    id: '', className: '', value: '', style: {},
    dataset: {}, checked: false, files: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, click() {}, focus() {}, select() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, insertAdjacentHTML() {}, scrollTop: 0
  };
  // Security.escapeHtml() sets textContent and reads back innerHTML, relying on
  // the browser to escape &, < and >. Emulate that faithfully — without it every
  // escaped string would render EMPTY and the leak assertions would pass falsely.
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

// `const`/`let` top-level declarations (state, PERMISSION_MODULES, …) live in
// the context's global LEXICAL scope, not on the global object — pull the ones
// the tests need across the boundary. Function declarations are already global
// object properties, so they are reachable as sandbox.<name>.
const bridged = vm.runInContext(
  '({ state, PERMISSION_MODULES })',
  sandbox
);

// ---------- test scaffolding ----------
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Strip HTML comments before asserting: section comments like
// "<!-- Driver Performance & Delivery Log Grid -->" are not visible content and
// would otherwise make a leak assertion fail (or pass) for the wrong reason.
function visible(html) { return String(html).replace(/<!--[\s\S]*?-->/g, ''); }

// Stub the receipt form's payment rows so the real DOM-reading helpers
// (getSelectedAutoSerialMethod, syncReceiptSerialWithPaymentMethods) can run.
function setPaymentRows(methods) {
  const rows = methods.map(m => ({
    querySelector: (sel) => (sel === '.payment-method' ? { value: m } : null)
  }));
  sandbox.document.querySelectorAll = (sel) =>
    (sel === '.payment-split-item' ? rows : []);
}

const S = bridged.state;

const ADMIN = { id: 'u-admin', name: 'Bashir', role: 'Admin', permissions: {} };
const OTHER = { id: 'u-other', name: 'Abdu', role: 'Employee', permissions: {} };

// Build an employee with an explicit permission map.
function employee(permissions) {
  return { id: 'u-emp', name: 'Albayan', role: 'Employee', permissions };
}

function loginAs(user) {
  S.currentUser = user;
  S.users = [ADMIN, OTHER, user].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
  S.serverMode = false; // exercise the local-log path (server path is covered by pytest)
}

// A device-local audit trail holding entries from THREE different users —
// exactly the shared-browser situation from the production report.
function seedLogs() {
  S.logs = [
    { id: 'log-1', userId: 'u-admin', userName: 'Bashir', action: 'Logout', category: 'auth', severity: 'info', description: 'User Bashir logged out', date: new Date().toISOString() },
    { id: 'log-2', userId: 'u-other', userName: 'Abdu', action: 'Logout', category: 'auth', severity: 'info', description: 'User Abdu logged out', date: new Date().toISOString() },
    { id: 'log-3', userId: 'u-emp', userName: 'Albayan', action: 'Update', category: 'general', severity: 'info', description: 'Updated Receipt', date: new Date().toISOString() }
  ];
}

function seedBusinessData() {
  S.customers = [{ id: 'c1', name: 'Cust One', platform: 'Facebook', phones: ['0911234567'], profileLinks: [], createdBy: 'u-admin' }];
  S.receipts = [{ id: 'r1', customerId: 'c1', amountUSD: 100, status: 'Paid', isPaid: true, deliveryStatus: 'Needs Delivery', deliveryPersonId: '', createdBy: 'u-admin', editHistory: [{ date: new Date().toISOString(), userName: 'Bashir', changes: [] }], transfers: [] }];
  S.ads = [{ id: 'a1', customerId: 'c1', amountUSD: 50, isPaid: true, paymentStatus: 'paid', createdBy: 'u-admin' }];
  S.pages = [];
  S.exchangeRateHistory = [];
  S.logs = S.logs || [];
}

const notes = [];
sandbox.showNotification = (t, m, k) => notes.push({ t, m, k });
sandbox.render = () => {};
sandbox.renderModal = () => {};
sandbox.RenderQueue = { schedule() {} };
sandbox.IconQueue = { schedule() {} };
function lastNote() { return notes[notes.length - 1]; }
function clearNotes() { notes.length = 0; }

console.log('\n=== AUDIT LOGS: viewOwn must never reveal another user\'s activity ===');
seedLogs(); seedBusinessData();

check('viewOwn-only employee sees ONLY their own log entries', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  const visible = sandbox.getVisibleAuditLogs();
  assert(visible.length === 1, `expected 1 own log, got ${visible.length}`);
  assert(visible[0].id === 'log-3', 'wrong log returned');
});

check('viewOwn-only employee: rendered Audit screen contains no other user\'s entry', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  const html = visible(sandbox.renderAuditView());
  assert(!html.includes('Bashir logged out'), "admin's log leaked into the page");
  assert(!html.includes('Abdu logged out'), "another user's log leaked into the page");
  assert(html.includes('Updated Receipt'), 'own log entry is missing');
});

check('viewOwn-only employee: user-filter dropdown does not enumerate other users', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  const html = visible(sandbox.renderAuditView());
  const optionArea = html.split('All Users')[1] || '';
  assert(!optionArea.includes('u-admin'), 'admin id exposed in the users filter');
  assert(!optionArea.includes('u-other'), 'other user id exposed in the users filter');
});

check('auditLogs.view (full) DOES see every entry', () => {
  loginAs(employee({ auditLogs: ['view'] }));
  const visible = sandbox.getVisibleAuditLogs();
  assert(visible.length === 3, `expected all 3 logs, got ${visible.length}`);
});

check('no auditLogs permission => no logs at all + no-access screen', () => {
  loginAs(employee({ analytics: ['view'] }));
  assert(sandbox.getVisibleAuditLogs().length === 0, 'logs returned without permission');
  const html = visible(sandbox.renderAuditView());
  assert(!html.includes('Updated Receipt') && !html.includes('Bashir logged out'), 'logs rendered without permission');
});

check('Admin sees everything (role bypass)', () => {
  loginAs(ADMIN);
  assert(sandbox.getVisibleAuditLogs().length === 3, 'admin should see all logs');
});

console.log('\n=== AUDIT LOGS: action buttons + handlers are permission-gated ===');

check('viewOwn-only employee: Backup/Restore/Cleanup/CSV/JSON buttons are NOT rendered', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  const html = visible(sandbox.renderAuditView());
  assert(!html.includes('backupAuditLogs()'), 'Backup button rendered');
  assert(!html.includes('restoreAuditLogs()'), 'Restore button rendered');
  assert(!html.includes('cleanupAuditLogs()'), 'Cleanup button rendered');
  assert(!html.includes("exportAuditLogs('csv')"), 'CSV button rendered');
});

check('auditLogs.export grants the CSV/JSON/Backup buttons only', () => {
  loginAs(employee({ auditLogs: ['view', 'export'] }));
  const html = visible(sandbox.renderAuditView());
  assert(html.includes("exportAuditLogs('csv')"), 'CSV button missing for export holder');
  assert(html.includes('backupAuditLogs()'), 'Backup button missing for export holder');
  assert(!html.includes('cleanupAuditLogs()'), 'Cleanup button must need the clear permission');
});

check('exportAuditLogs handler refuses without auditLogs.export', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  clearNotes();
  sandbox.exportAuditLogs('csv');
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'export was not blocked');
});

check('restoreAuditLogs handler refuses without auditLogs.clear', () => {
  loginAs(employee({ auditLogs: ['view', 'export'] }));
  clearNotes();
  sandbox.restoreAuditLogs();
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'restore was not blocked');
});

check('showLogDetails refuses another user\'s entry for a viewOwn user', () => {
  loginAs(employee({ auditLogs: ['viewOwn'] }));
  clearNotes();
  sandbox.showLogDetails('log-1'); // the admin's entry
  assert(lastNote() && /Access Denied/i.test(lastNote().t), "another user's log detail was opened");
});

console.log('\n=== CUSTOMERS: viewContacts / viewBalance ===');

check('without viewContacts, phone numbers are masked', () => {
  loginAs(employee({ customers: ['view'] }));
  const html = visible(sandbox.renderCustomersGrid(S.customers));
  assert(!html.includes('0911234567'), 'phone number leaked');
});

check('with viewContacts, phone numbers are shown', () => {
  loginAs(employee({ customers: ['view', 'viewContacts'] }));
  const html = visible(sandbox.renderCustomersGrid(S.customers));
  assert(html.includes('0911234567'), 'phone number missing for permitted user');
});

check('without viewBalance, balances are hidden', () => {
  loginAs(employee({ customers: ['view', 'viewContacts'] }));
  const html = visible(sandbox.renderCustomersGrid(S.customers));
  assert(/Balances hidden|الأرصدة محجوبة/.test(html), 'balances not hidden');
  assert(!html.includes('Ads Credit (USD)'), 'financial grid rendered without viewBalance');
});

check('with viewBalance, balances are shown', () => {
  loginAs(employee({ customers: ['view', 'viewBalance'] }));
  const html = visible(sandbox.renderCustomersGrid(S.customers));
  assert(html.includes('Ads Credit (USD)'), 'financial grid missing for permitted user');
});

console.log('\n=== ANALYTICS: viewFinancials / viewSensitive ===');

check('without viewFinancials, money KPIs are not rendered', () => {
  loginAs(employee({ analytics: ['view'] }));
  const html = visible(sandbox.renderAnalyticsView());
  assert(!html.includes('Ad Revenue (Paid)'), 'revenue KPI leaked');
  assert(!html.includes('Available Balance'), 'balance KPI leaked');
  assert(!html.includes('Revenue & Collections'), 'cashflow panel leaked');
});

check('with viewFinancials, money KPIs render', () => {
  loginAs(employee({ analytics: ['view', 'viewFinancials'] }));
  const html = visible(sandbox.renderAnalyticsView());
  assert(html.includes('Ad Revenue (Paid)'), 'revenue KPI missing for permitted user');
});

check('viewSensitive gates the detailed breakdowns (Top Customers spend)', () => {
  loginAs(employee({ analytics: ['view', 'viewFinancials'] }));
  assert(!visible(sandbox.renderAnalyticsView()).includes('Top Customers (Spend)'), 'sensitive panel leaked');
  loginAs(employee({ analytics: ['view', 'viewFinancials', 'viewSensitive'] }));
  assert(visible(sandbox.renderAnalyticsView()).includes('Top Customers (Spend)'), 'sensitive panel missing for permitted user');
});

console.log('\n=== DELIVERIES: viewStats + action gating ===');

check('without viewStats, driver performance + money tiles are hidden', () => {
  loginAs(employee({ deliveries: ['view'] }));
  const html = visible(sandbox.renderDeliveriesView());
  assert(!html.includes('Driver Performance'), 'driver performance leaked');
  assert(!html.includes('Uncollected Value'), 'money tile leaked');
});

check('with viewStats, they are shown', () => {
  loginAs(employee({ deliveries: ['view', 'viewStats'] }));
  const html = visible(sandbox.renderDeliveriesView());
  assert(html.includes('Driver Performance'), 'driver performance missing for permitted user');
});

check('acceptDelivery refuses without deliveries.accept', () => {
  loginAs(employee({ deliveries: ['view'] }));
  clearNotes();
  sandbox.acceptDelivery('r1');
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'accept was not blocked');
  assert(S.receipts[0].deliveryStatus === 'Needs Delivery', 'record was mutated despite denial');
});

check('markAsCollected refuses without deliveries.markCollected', () => {
  loginAs(employee({ deliveries: ['view'] }));
  clearNotes();
  sandbox.markAsCollected('r1');
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'markCollected was not blocked');
});

check('assigned driver CAN accept their own delivery (role path still works)', () => {
  const driver = { id: 'u-driver', name: 'Driver', role: 'Delivery', permissions: {} };
  S.receipts[0].deliveryPersonId = 'u-driver';
  loginAs(driver);
  assert(sandbox.canDoDeliveryAction('accept', 'r1') === true, 'assigned driver was blocked from their own delivery');
  S.receipts[0].deliveryPersonId = '';
});

console.log('\n=== RECEIPTS / ADS / SETTINGS ===');

check('receipt edit history refuses without receipts.viewHistory', () => {
  loginAs(employee({ receipts: ['view'] }));
  clearNotes();
  sandbox.showReceiptEditHistory('r1');
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'history was not blocked');
});

check('uploadAdPhotos refuses without ads.uploadPhotos', () => {
  loginAs(employee({ ads: ['view', 'add'] }));
  clearNotes();
  sandbox.uploadAdPhotos([{ name: 'x.png' }]);
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'photo upload was not blocked');
});

check('updateExchangeRate refuses without settings.manageExchangeRate', () => {
  loginAs(employee({ settings: ['view', 'edit'] }));
  clearNotes();
  const before = S.defaultExchangeRate;
  sandbox.updateExchangeRate('9.99');
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'rate change was not blocked');
  assert(S.defaultExchangeRate === before, 'exchange rate was mutated despite denial');
});

check('updateExchangeRate works WITH settings.manageExchangeRate', () => {
  loginAs(employee({ settings: ['view', 'manageExchangeRate'] }));
  clearNotes();
  sandbox.updateExchangeRate('7.25');
  assert(S.defaultExchangeRate === 7.25, 'permitted rate change did not apply');
});

check('exportData (full backup) is Admin only', () => {
  loginAs(employee({ settings: ['view', 'edit'], auditLogs: ['view', 'export'] }));
  clearNotes();
  sandbox.exportData();
  assert(lastNote() && /Access Denied/i.test(lastNote().t), 'full backup export was not blocked');
});

check('settings screen hides the exchange-rate editor without the permission', () => {
  loginAs(employee({ settings: ['view'] }));
  const html = visible(sandbox.renderSettingsView());
  assert(!html.includes('updateExchangeRate('), 'rate editor rendered without permission');
  assert(!html.includes('exportData()'), 'backup export button rendered for non-admin');
});

console.log('\n=== SIDEBAR: the original lockout must stay fixed ===');

check('employee with full permissions sees the full sidebar', () => {
  const all = {};
  for (const [mod, cfg] of Object.entries(bridged.PERMISSION_MODULES)) all[mod] = Object.keys(cfg.permissions);
  loginAs(employee(all));
  const html = visible(sandbox.renderSidebar());
  assert(!html.includes('No access granted'), 'fully-permissioned employee is locked out');
  for (const label of ['analytics', 'customers', 'receipts', 'pages', 'ads', 'deliveries', 'users', 'audit', 'settings']) {
    assert(html.includes(`navigateTo('${label}')`), `sidebar is missing the ${label} link`);
  }
});

check('permissions survive even when state.users lacks the record (login-response fallback)', () => {
  const emp = employee({ analytics: ['view'], receipts: ['view'] });
  S.currentUser = emp;
  S.users = []; // the users-list fetch failed — this used to lock the whole UI
  assert(sandbox.currentUserHasPermission('analytics', 'view') === true, 'permission lost when users list is empty');
  assert(!visible(sandbox.renderSidebar()).includes('No access granted'), 'sidebar locked despite valid permissions');
});

console.log('\n=== RECEIPT AUTO-SERIALS: B / O / E / S groups ===');

check('generic "Bank Transfer" is gone; the LYD/USD variants remain', () => {
  const methods = vm.runInContext('PAYMENT_METHODS', sandbox);
  assert(!methods.includes('Bank Transfer'), 'the duplicate generic Bank Transfer is still offered');
  assert(methods.includes('Bank Transfer (LYD)') && methods.includes('Bank Transfer (USD)'), 'the LYD/USD variants must remain');
});

check('an old receipt using the removed "Bank Transfer" keeps it in its dropdown', () => {
  const opts = sandbox.paymentMethodOptions('Bank Transfer');
  assert(opts.includes('Bank Transfer'), 'legacy method dropped from an existing receipt');
  assert(!sandbox.paymentMethodOptions('Cash (LYD)').includes('Bank Transfer'), 'legacy method offered on a new receipt');
});

check('each payment method maps to the right counter prefix', () => {
  const cases = {
    'Bank Transfer (LYD)': 'B', 'Bank Transfer (USD)': 'B', 'Bank Transfer': 'B',
    'Transfer Office': 'O',
    'Sadad': 'E', 'USDT': 'E',
    'LTT': 'S', 'Libyana': 'S', 'Madar': 'S'
  };
  for (const [method, prefix] of Object.entries(cases)) {
    assert(sandbox.getAutoSerialPrefix(method) === prefix, `${method} should map to ${prefix}, got ${sandbox.getAutoSerialPrefix(method)}`);
  }
  // Cash keeps a manual, hand-typed receipt number
  assert(sandbox.getAutoSerialPrefix('Cash (LYD)') === null, 'Cash (LYD) must stay manual');
  assert(sandbox.getAutoSerialPrefix('Cash (USD)') === null, 'Cash (USD) must stay manual');
});

check('first receipt of each group starts at 1 (B1 / O1 / E1 / S1)', () => {
  S.receipts = [];
  assert(sandbox.getNextAutoSerialNumber('Bank Transfer (LYD)') === 'B1', 'bank transfer must start at B1');
  assert(sandbox.getNextAutoSerialNumber('Transfer Office') === 'O1', 'transfer office must start at O1');
  assert(sandbox.getNextAutoSerialNumber('Sadad') === 'E1', 'Sadad must start at E1');
  assert(sandbox.getNextAutoSerialNumber('USDT') === 'E1', 'USDT shares the E counter');
  assert(sandbox.getNextAutoSerialNumber('LTT') === 'S1', 'LTT must start at S1');
});

check('counters are independent and increment per group', () => {
  S.receipts = [
    { id: 'x1', paymentMethod: 'Bank Transfer (LYD)', serialNumber: 'B1' },
    { id: 'x2', paymentMethod: 'Bank Transfer (USD)', serialNumber: 'B2' },
    { id: 'x3', paymentMethod: 'Transfer Office', serialNumber: 'O1' },
    { id: 'x4', paymentMethod: 'Sadad', serialNumber: 'E1' },
    { id: 'x5', paymentMethod: 'Cash (LYD)', serialNumber: '12629' }
  ];
  assert(sandbox.getNextAutoSerialNumber('Bank Transfer (USD)') === 'B3', 'B counter should be at B3');
  assert(sandbox.getNextAutoSerialNumber('Transfer Office') === 'O2', 'O counter should be at O2');
  assert(sandbox.getNextAutoSerialNumber('USDT') === 'E2', 'E counter should be at E2 (shared with Sadad)');
  assert(sandbox.getNextAutoSerialNumber('LTT') === 'S1', 'S counter must not be advanced by other groups');
});

check('split payments feed their group counter', () => {
  S.receipts = [
    { id: 'y1', paymentMethod: '', payments: [{ method: 'Cash (LYD)' }, { method: 'Transfer Office' }], serialNumber: 'O7' }
  ];
  assert(sandbox.getNextAutoSerialNumber('Transfer Office') === 'O8', 'split payment did not advance the O counter');
});

check('legacy bare numbers still advance the S counter only', () => {
  S.receipts = [
    { id: 'z1', paymentMethod: 'Libyana', serialNumber: '4' }, // pre-prefix legacy
    { id: 'z2', paymentMethod: 'Bank Transfer (LYD)', serialNumber: 'B9' }
  ];
  assert(sandbox.getNextAutoSerialNumber('Madar') === 'S5', 'legacy numeric serial should continue the S sequence');
  assert(sandbox.getNextAutoSerialNumber('Bank Transfer (USD)') === 'B10', 'B counter must be independent');
});

check('isAutoSerialNumber recognises S/B/O/E and rejects plain numbers', () => {
  for (const s of ['S1', 'B2', 'O33', 'E7', 'b4', 'o1']) {
    assert(sandbox.isAutoSerialNumber(s) === true, `${s} should be recognised as an auto-serial`);
  }
  for (const s of ['12629', '', 'D3', 'X1', 'B', 'BB1']) {
    assert(sandbox.isAutoSerialNumber(s) === false, `${s} must NOT be treated as an auto-serial`);
  }
});

check('typing cannot corrupt an auto-serial (validator preserves the prefix)', () => {
  const input = { value: 'B12', classList: { add() {}, remove() {} } };
  sandbox.validateReceiptNumberInput(input);
  assert(input.value === 'B12', `auto-serial was mangled to "${input.value}"`);
  const manual = { value: '0123', classList: { add() {}, remove() {} } };
  sandbox.validateReceiptNumberInput(manual);
  assert(manual.value === '123', 'manual serials must still strip a leading zero');
});

console.log('\n=== MIXED PAYMENTS: cash in the split => manual receipt number ===');

check('all-auto split (Libyana + Sadad) still auto-numbers', () => {
  setPaymentRows(['Libyana', 'Sadad']);
  assert(sandbox.getSelectedAutoSerialMethod() === 'Libyana', 'an all-auto split must auto-number from the first row');
});

check('Cash + Libyana => NO auto number (user types the paper receipt number)', () => {
  setPaymentRows(['Cash (LYD)', 'Libyana']);
  assert(sandbox.getSelectedAutoSerialMethod() === null, 'a split containing Cash must require a manual number');
});

check('Libyana + Cash (any position) => still manual', () => {
  setPaymentRows(['Libyana', 'Cash (USD)']);
  assert(sandbox.getSelectedAutoSerialMethod() === null, 'Cash anywhere in the split forces a manual number');
});

check('single Bank Transfer row => auto B number', () => {
  setPaymentRows(['Bank Transfer (LYD)']);
  assert(sandbox.getSelectedAutoSerialMethod() === 'Bank Transfer (LYD)', 'a lone bank transfer must auto-number');
});

check('single Cash row => manual', () => {
  setPaymentRows(['Cash (LYD)']);
  assert(sandbox.getSelectedAutoSerialMethod() === null, 'cash-only must stay manual');
});

check('no payment rows => manual (nothing to number from)', () => {
  setPaymentRows([]);
  assert(sandbox.getSelectedAutoSerialMethod() === null, 'empty form must not auto-number');
});

console.log('\n=== SERIAL RE-SYNC when the payment method changes (the reported bug) ===');

// Drive the real sync function against a stubbed Receipt Number field.
function serialField(initial) {
  const el = { value: initial, readOnly: false, title: '', classList: { add() {}, remove() {} } };
  sandbox.document.getElementById = (id) => (id === 'receipt-serial' ? el : null);
  return el;
}

check('cash receipt (manual number) switched to Bank Transfer => gets a B number', () => {
  S.receipts = [{ id: 'r-old', paymentMethod: 'Bank Transfer (LYD)', serialNumber: 'B4' }];
  S.modalData = { id: 'r-saved' };            // EDITING a saved receipt
  const el = serialField('12851');            // its old paper number from cash
  setPaymentRows(['Bank Transfer (LYD)']);    // user switches the method
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === 'B5', `expected B5, got "${el.value}" (the stale paper number was kept)`);
  assert(el.readOnly === true, 'the field must lock once it is app-numbered');
  S.modalData = null;
});

check('new receipt: typed number then switched to Transfer Office => gets an O number', () => {
  S.receipts = [];
  const el = serialField('999');
  setPaymentRows(['Transfer Office']);
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === 'O1', `expected O1, got "${el.value}"`);
});

check('switching between auto groups re-issues from the new counter', () => {
  S.receipts = [{ id: 'a', paymentMethod: 'Sadad', serialNumber: 'E2' }];
  const el = serialField('B7');
  setPaymentRows(['USDT']);
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === 'E3', `expected E3, got "${el.value}"`);
});

check('a number already in the right group is KEPT (no pointless renumbering)', () => {
  S.receipts = [{ id: 'a', paymentMethod: 'Bank Transfer (LYD)', serialNumber: 'B9' }];
  S.modalData = { id: 'a' };
  const el = serialField('B9');
  setPaymentRows(['Bank Transfer (USD)']); // same B group
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === 'B9', `B9 should have been kept, got "${el.value}"`);
  S.modalData = null;
});

check('adding a Cash row to an auto-numbered receipt clears the app number', () => {
  S.receipts = [];
  const el = serialField('B3');
  setPaymentRows(['Bank Transfer (LYD)', 'Cash (LYD)']);
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === '', `app number must be cleared, got "${el.value}"`);
  assert(el.readOnly === false, 'the field must unlock so a paper number can be typed');
});

check('merely OPENING a saved receipt never renumbers it', () => {
  S.receipts = [{ id: 'r1', paymentMethod: 'Libyana', serialNumber: '4' }]; // legacy bare number
  S.modalData = { id: 'r1' };
  const el = serialField('4');
  setPaymentRows(['Libyana']);
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: false });
  assert(el.value === '4', `open must not renumber; got "${el.value}"`);
  S.modalData = null;
});

check('a saved legacy S receipt keeps its bare number when switching within the S group', () => {
  S.receipts = [{ id: 'r1', paymentMethod: 'Libyana', serialNumber: '4' }];
  S.modalData = { id: 'r1' };
  const el = serialField('4');
  setPaymentRows(['Madar']); // same S group
  sandbox.syncReceiptSerialWithPaymentMethods({ reissue: true });
  assert(el.value === '4', `legacy S number should be kept, got "${el.value}"`);
  S.modalData = null;
});

console.log('\n=== URLs: every view and modal is addressable ===');

check('every renderView case has a URL path', () => {
  const map = vm.runInContext('VIEW_TO_PATH', sandbox);
  const views = ['services-hub', 'smart-systems', 'clothes-system', 'service-placeholder', 'wallet',
    'analytics', 'customers', 'receipts', 'pages', 'ads', 'deliveries', 'reconciliation',
    'users', 'audit', 'settings', 'delivery-dashboard', 'no-access'];
  const missing = views.filter(v => !map[v]);
  assert(missing.length === 0, `views without a URL: ${missing.join(', ')}`);
});

check('paths are unique and round-trip back to their view', () => {
  const map = vm.runInContext('VIEW_TO_PATH', sandbox);
  const back = vm.runInContext('PATH_TO_VIEW', sandbox);
  const paths = Object.values(map);
  assert(new Set(paths).size === paths.length, 'two views share the same path');
  for (const [view, path] of Object.entries(map)) {
    assert(back[path] === view, `${path} does not map back to ${view}`);
  }
});

check('every record modal has a URL handler with a real opener', () => {
  const handlers = vm.runInContext('MODAL_URL_HANDLERS', sandbox);
  const expected = ['ad', 'receipt', 'customer', 'page', 'user', 'split-payments', 'top-ups',
    'refund', 'receipt-transfer', 'collect-receipt', 'permissions', 'wallet-topup',
    'clothes-product', 'clothes-shipment', 'clothes-order'];
  const missing = expected.filter(m => !handlers[m]);
  assert(missing.length === 0, `modals without a URL handler: ${missing.join(', ')}`);
  for (const [name, h] of Object.entries(handlers)) {
    assert(typeof h.open === 'function', `${name}: open() is not wired`);
  }
});

check('secret dialogs are NOT addressable by URL', () => {
  const handlers = vm.runInContext('MODAL_URL_HANDLERS', sandbox);
  for (const secret of ['recovery-key', 'password-reset', 'change-password']) {
    assert(!handlers[secret], `${secret} must never be reachable from a link`);
  }
});

check('server serves index.html for every client path (no 404 on refresh)', () => {
  const map = vm.runInContext('VIEW_TO_PATH', sandbox);
  const py = fs.readFileSync(path.join(__dirname, '..', 'server', 'main.py'), 'utf8');
  const block = py.split('FRONTEND_ROUTES = {')[1].split('}')[0];
  const missing = Object.values(map)
    .filter(p => p !== '/')
    .filter(p => !block.includes(`"${p}"`));
  assert(missing.length === 0, `paths missing from the server's FRONTEND_ROUTES: ${missing.join(', ')}`);
});

console.log('\n=== MONEY SAFETY: stale-state bugs found by the audit ===');

check('a stored rate of 0 is NOT re-rendered as the market rate (was: receipt money rewritten on re-save)', () => {
  S.defaultExchangeRate = 5.5;
  // Bank transfers / Sadad / USDT / LTT legitimately store rate 0.
  assert(sandbox.paymentRate1Value({ method: 'Sadad', rate: 0 }) === 0,
    'a stored 0 rate was replaced by the market rate — reopening the receipt would inflate its LYD total');
  assert(sandbox.paymentRate1Value({ method: 'Cash (LYD)', rate: 9.5 }) === 9.5, 'a real rate must be shown as-is');
  // Only a genuinely absent rate falls back — to the method's own default.
  assert(sandbox.paymentRate1Value({ method: 'Sadad' }) === 0, 'missing rate should fall back to the method default (0)');
  assert(sandbox.paymentRate1Value({ method: 'Cash (LYD)' }) === 1, 'Cash (LYD) default rate is 1');
});

check('every zero-rate method really does default to 0', () => {
  for (const m of ['Bank Transfer (LYD)', 'Bank Transfer (USD)', 'Sadad', 'USDT', 'LTT', 'Cash (USD)']) {
    assert(sandbox.getDefaultRate1(m) === 0, `${m} should default Rate 1 to 0`);
  }
});

check('getSelectedPaymentMethods reads the live rows (no invented "Cash (USD)")', () => {
  setPaymentRows(['Bank Transfer (LYD)', 'Cash (LYD)']);
  const methods = sandbox.getSelectedPaymentMethods();
  assert(methods.length === 2 && methods[0] === 'Bank Transfer (LYD)', `got ${JSON.stringify(methods)}`);
});

// ---------- report ----------
console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`ALL ${passed} PERMISSION TESTS PASSED`);
