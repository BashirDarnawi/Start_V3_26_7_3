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
    set: (v) => { _html = String(v); _text = _html.replace(/<[^>]*>/g, ''); },
    configurable: true
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
    fetch: win.fetch, Blob: win.Blob, URL: win.URL, URLSearchParams, isSecureContext: true,
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
  '({ state, PERMISSION_MODULES, Security, _serverLiveSync, IconQueue })',
  sandbox
);

// ---------- test scaffolding ----------
let passed = 0;
const failures = [];
const asyncChecks = [];
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
function checkAsync(name, fn) { asyncChecks.push({ name, fn }); }
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
// Most tests replace render() with a no-op below because they only exercise
// HTML-producing helpers. Keep the real function for the focused render-
// stability regressions, where DOM write/layout/scroll activity is measured.
const realRender = sandbox.render;

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

// Run the real render() against a deliberately small, tracked DOM. The normal
// VM element stub does not parse innerHTML, so this helper supplies the main
// view container explicitly and records every operation that could make a
// background live-sync tick flash, shake, or move the visible page.
function withTrackedPagesRender(run) {
  const originalGetElementById = sandbox.document.getElementById;
  const originalDocumentElement = sandbox.document.documentElement;
  const hadActiveElement = Object.prototype.hasOwnProperty.call(sandbox.document, 'activeElement');
  const originalActiveElement = sandbox.document.activeElement;
  const originalGlobalRaf = sandbox.requestAnimationFrame;
  const originalWindowRaf = sandbox.window.requestAnimationFrame;
  const originalScrollTo = sandbox.window.scrollTo;
  const originalPageYOffset = sandbox.window.pageYOffset;
  const originalPageXOffset = sandbox.window.pageXOffset;
  const originalScrollY = sandbox.window.scrollY;
  const originalScrollX = sandbox.window.scrollX;
  const originalIconSchedule = bridged.IconQueue.schedule;
  const stateBefore = {
    currentUser: S.currentUser,
    users: S.users,
    customers: S.customers,
    receipts: S.receipts,
    ads: S.ads,
    pages: S.pages,
    currentView: S.currentView,
    language: S.language,
    serverMode: S.serverMode,
    isMobileMenuOpen: S.isMobileMenuOpen
  };

  const metrics = {
    appWrites: 0,
    viewWrites: 0,
    layoutClassOps: 0,
    appHeightOps: 0,
    scrollCalls: 0,
    iconSchedules: 0,
    rafCalls: 0,
    animationRemovals: [],
    reset() {
      this.appWrites = 0;
      this.viewWrites = 0;
      this.layoutClassOps = 0;
      this.appHeightOps = 0;
      this.scrollCalls = 0;
      this.iconSchedules = 0;
      this.rafCalls = 0;
      this.animationRemovals = [];
    }
  };

  const trackedClassList = () => {
    const values = new Set();
    return {
      add(...names) {
        for (const name of names) {
          values.add(name);
          if (name === 'is-rendering') metrics.layoutClassOps++;
        }
      },
      remove(...names) {
        for (const name of names) {
          values.delete(name);
          if (name === 'is-rendering') metrics.layoutClassOps++;
        }
      },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !values.has(name) : !!force;
        if (shouldAdd) this.add(name);
        else this.remove(name);
        return shouldAdd;
      },
      contains(name) { return values.has(name); }
    };
  };

  const animationNode = {
    classList: {
      remove(...names) { metrics.animationRemovals.push(...names); }
    }
  };
  let viewHTML = '';
  const viewContainer = makeElement();
  Object.defineProperty(viewContainer, 'innerHTML', {
    get: () => viewHTML,
    set: value => {
      metrics.viewWrites++;
      viewHTML = String(value);
    },
    configurable: true
  });
  viewContainer.seedHTML = value => { viewHTML = String(value); };
  viewContainer.querySelectorAll = selector => (
    String(selector).includes('animate-fade-in-up') ? [animationNode] : []
  );

  let appHTML = '';
  const app = makeElement();
  app.offsetHeight = 1200;
  app.classList = trackedClassList();
  app.style = {
    setProperty(name) { if (name === '--app-height') metrics.appHeightOps++; },
    removeProperty(name) { if (name === '--app-height') metrics.appHeightOps++; }
  };
  app.querySelector = selector => (
    selector === '#workspace-view-content' ? viewContainer : null
  );
  Object.defineProperty(app, 'innerHTML', {
    get: () => appHTML,
    set: value => {
      metrics.appWrites++;
      appHTML = String(value);
    },
    configurable: true
  });

  const htmlElement = makeElement();
  htmlElement.classList = trackedClassList();
  htmlElement.scrollTop = 240;
  const immediateRaf = callback => {
    metrics.rafCalls++;
    callback();
    return metrics.rafCalls;
  };

  try {
    loginAs(ADMIN);
    Object.assign(S, {
      currentView: 'pages',
      language: 'en',
      serverMode: false,
      isMobileMenuOpen: false,
      customers: [],
      receipts: [],
      ads: [],
      pages: [{
        id: 'page_render_stable',
        name: 'Stable Page',
        category: 'Testing',
        customerIds: [],
        _lastModified: 100
      }]
    });
    sandbox.document.documentElement = htmlElement;
    sandbox.document.activeElement = null;
    sandbox.document.getElementById = id => (id === 'app' ? app : null);
    sandbox.window.pageYOffset = 240;
    sandbox.window.pageXOffset = 0;
    sandbox.window.scrollY = 240;
    sandbox.window.scrollX = 0;
    sandbox.window.scrollTo = () => { metrics.scrollCalls++; };
    sandbox.requestAnimationFrame = immediateRaf;
    sandbox.window.requestAnimationFrame = immediateRaf;
    bridged.IconQueue.schedule = () => { metrics.iconSchedules++; };

    // Establish the first-render cache exactly as the browser does on navigation.
    vm.runInContext(
      '_lastRenderedView = null; _lastRenderedUserId = null; _lastViewHTML = null; _renderInProgress = false;',
      sandbox
    );
    realRender();
    // The fake app does not parse its full innerHTML into children; seed the
    // supplied child with the same HTML a real browser received.
    viewContainer.seedHTML(sandbox.renderView());
    metrics.reset();
    run({ metrics, viewContainer });
  } finally {
    sandbox.document.getElementById = originalGetElementById;
    sandbox.document.documentElement = originalDocumentElement;
    if (hadActiveElement) sandbox.document.activeElement = originalActiveElement;
    else delete sandbox.document.activeElement;
    sandbox.requestAnimationFrame = originalGlobalRaf;
    sandbox.window.requestAnimationFrame = originalWindowRaf;
    sandbox.window.scrollTo = originalScrollTo;
    sandbox.window.pageYOffset = originalPageYOffset;
    sandbox.window.pageXOffset = originalPageXOffset;
    sandbox.window.scrollY = originalScrollY;
    sandbox.window.scrollX = originalScrollX;
    bridged.IconQueue.schedule = originalIconSchedule;
    Object.assign(S, stateBefore);
    vm.runInContext(
      '_lastRenderedView = null; _lastRenderedUserId = null; _lastViewHTML = null; _renderInProgress = false;',
      sandbox
    );
  }
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

check('smart search never matches or displays contact data without viewContacts', () => {
  seedBusinessData();
  S.customers[0].phones = ['0919876543'];
  S.receipts[0].phoneNumber = '0919876543';
  S.ads[0].phoneNumber = '0919876543';
  loginAs(employee({ customers: ['view'], receipts: ['view'], ads: ['view'], pages: ['view'] }));
  let results = sandbox.getCommandPaletteEntityCommands('091987');
  assert(results.length === 0, 'phone search revealed a record without viewContacts');

  loginAs(employee({ customers: ['view', 'viewContacts'], receipts: ['view'], ads: ['view'], pages: ['view'] }));
  results = sandbox.getCommandPaletteEntityCommands('091987');
  assert(results.some(item => item.section === 'Customer results'), 'modern phones[] was not searchable with viewContacts');
  assert(results.some(item => String(item.description || '').includes('0919876543')), 'permitted phone was not described');
});

check('smart search and main lists scope viewOwn records before matching', () => {
  loginAs(employee({ customers: ['viewOwn'], receipts: ['viewOwn'], ads: ['viewOwn'], pages: ['viewOwn'] }));
  S.customers = [
    { id: 'c-own', name: 'Own Customer', createdBy: 'u-emp', joinDate: '2026-01-02' },
    { id: 'c-other', name: 'Forbidden Customer', createdBy: 'u-other', joinDate: '2026-01-01' }
  ];
  S.receipts = [
    { id: 'r-own', customerId: 'c-own', finalReceiptNo: 'OWN-R', createdBy: 'u-emp' },
    { id: 'r-other', customerId: 'c-other', finalReceiptNo: 'SECRET-R', createdBy: 'u-other' }
  ];
  S.ads = [
    { id: 'a-own', customerId: 'c-own', serialNumber: 'OWN-A', createdBy: 'u-emp' },
    { id: 'a-other', customerId: 'c-other', serialNumber: 'SECRET-A', createdBy: 'u-other' }
  ];
  S.pages = [
    { id: 'p-own', name: 'Own Page', createdBy: 'u-emp' },
    { id: 'p-other', name: 'Forbidden Page', createdBy: 'u-other' }
  ];
  assert(sandbox.getCommandPaletteEntityCommands('SECRET').length === 0, 'viewOwn search exposed another creator');
  assert(sandbox.getReceiptsVisibleToCurrentUser().length === 1, 'receipt viewOwn list was not scoped');
  assert(sandbox.getAdsVisibleToCurrentUser().length === 1, 'ad viewOwn list was not scoped');
  assert(sandbox.getPagesVisibleToCurrentUser().length === 1, 'page viewOwn list was not scoped');
});

check('delivery viewOwn resolves assigned customers instead of creator ownership', () => {
  loginAs({ id: 'u-driver', name: 'Driver', role: 'Delivery', permissions: { customers: ['viewOwn'], receipts: ['viewOwn'] } });
  S.customers = [
    { id: 'c-assigned', name: 'Assigned', createdBy: 'u-admin' },
    { id: 'c-unassigned', name: 'Unassigned', createdBy: 'u-admin' }
  ];
  S.receipts = [{ id: 'r-assigned', customerId: 'c-assigned', deliveryPersonId: 'u-driver', createdBy: 'u-admin' }];
  S.ads = [];
  const customers = sandbox.getCustomersVisibleToCurrentUser();
  assert(customers.length === 1 && customers[0].id === 'c-assigned', 'assigned delivery customer was hidden or unassigned customer leaked');
});

check('customer financial filters and sorts disappear without viewBalance', () => {
  seedBusinessData();
  loginAs(employee({ customers: ['view'] }));
  S.customerFinancialFilter = 'hasDebt';
  S.customerSort = 'highestDebt';
  const html = visible(sandbox.renderCustomersView());
  assert(S.customerFinancialFilter === 'all' && S.customerSort === 'newest', 'persisted financial filter survived permission removal');
  assert(!html.includes('Has debt') && !html.includes('Highest Debt'), 'financial filter controls leaked customer status');
});

console.log('\n=== CUSTOMERS: duplicate prevention and safe merge discovery ===');

check('Libyan phone aliases, Arabic digits, legacy fields and object entries share one identity key', () => {
  const aliases = [
    '0912345678',
    '218912345678',
    '+218 91 234 5678',
    '00218-91-234-5678',
    '٠٩١٢٣٤٥٦٧٨',
    { number: '۰۹۱۲۳۴۵۶۷۸', label: 'Mobile' }
  ];
  const keys = aliases.map(value => sandbox.normalizeCustomerPhoneKey(value));
  assert(keys.every(key => key === '218912345678'), `phone aliases did not normalize equally: ${keys.join(',')}`);

  S.customers = [
    { id: 'legacy-phone', name: 'Legacy Phone', phone: '+218 91 234 5678' },
    { id: 'object-phone', name: 'Object Phone', phones: [{ number: '0923456789', label: 'WhatsApp' }] }
  ];
  assert(sandbox.checkDuplicatePhone(['0912345678'])?.customerId === 'legacy-phone', 'legacy scalar phone was missed');
  assert(sandbox.checkDuplicatePhone(['+218 92 345 6789'])?.customerId === 'object-phone', 'object phone entry was missed');
  seedBusinessData();
});

check('customer form phone values de-duplicate aliases while preserving first formatting', () => {
  const values = sandbox.dedupeCustomerPhoneValues([
    '+218 91 234 5678',
    '0912345678',
    '00218912345678',
    '0923456789'
  ]);
  assert(values.length === 2, `expected two unique numbers, got ${values.length}`);
  assert(values[0] === '+218 91 234 5678', 'first phone formatting was not preserved');
  assert(values[1] === '0923456789', 'second unique phone was removed');
});

check('duplicate discovery is transitive and recommends the record with more linked data', () => {
  loginAs(ADMIN);
  S.customers = [
    { id: 'customer-a', name: 'A', phones: ['0911111111'] },
    { id: 'customer-b', name: 'B', phoneNumber: '+218 91 111 1111', phones: ['0922222222'] },
    { id: 'customer-c', name: 'C', phones: [{ number: '00218 92 222 2222' }] }
  ];
  S.pages = [{ id: 'page-b', customerIds: ['customer-b'] }];
  S.receipts = [{ id: 'receipt-b', customerId: 'customer-b' }];
  S.ads = [{ id: 'ad-b', customerId: 'customer-b', recordType: 'ad' }];
  const groups = sandbox.findDuplicateCustomerGroups(S.customers);
  assert(groups.length === 1 && groups[0].customers.length === 3, 'transitive duplicates were split into separate groups');
  assert(sandbox.getRecommendedCustomerToKeep(groups[0].customers)?.id === 'customer-b', 'record with the most links was not recommended');
  seedBusinessData();
});

check('Find duplicates and per-card duplicate actions are admin-only', () => {
  S.language = 'en';
  S.customerSearch = '';
  S.customerSort = 'newest';
  S.customerFinancialFilter = 'all';
  S.customers = [
    { id: 'duplicate-1', name: 'First', phones: ['0912345678'], joinDate: '2026-01-01' },
    { id: 'duplicate-2', name: 'Second', phone: '+218 91 234 5678', joinDate: '2026-01-02' }
  ];
  S.pages = [];
  S.receipts = [];
  S.ads = [];
  loginAs(employee({ customers: ['view', 'viewContacts', 'viewBalance'] }));
  const employeeHtml = visible(sandbox.renderCustomersView());
  assert(!employeeHtml.includes('Find duplicates') && !employeeHtml.includes('showCustomerDuplicateMerge'), 'merge discovery leaked to a non-admin');

  loginAs(ADMIN);
  const adminHtml = visible(sandbox.renderCustomersView());
  assert(adminHtml.includes('Find duplicates'), 'admin duplicate finder is missing');
  assert(adminHtml.includes('showCustomerDuplicateMerge'), 'duplicate card does not open the safe merge dialog');
  assert(adminHtml.includes('Duplicate'), 'duplicate card is not visibly marked');
  seedBusinessData();
});

checkAsync('a customer can NEVER be saved with an empty phone number (create and edit)', async () => {
  loginAs(ADMIN);
  S.serverMode = false;
  S.language = 'en';
  S.customers = [];
  const fields = {
    'customer-name': { value: 'No Phone Guy' },
    'customer-platform': { value: 'Facebook' },
    'customer-joindate': { value: '' }
  };
  const phoneRows = values => values.map(v => ({ value: v }));
  let phones = phoneRows(['   ']); // whitespace passes HTML `required`
  const original = {
    getElementById: sandbox.document.getElementById,
    querySelectorAll: sandbox.document.querySelectorAll,
    closeModal: sandbox.closeModal
  };
  sandbox.document.getElementById = id => fields[id] || null;
  sandbox.document.querySelectorAll = sel =>
    (sel === '.customer-phone' ? phones : []);
  sandbox.closeModal = () => {};
  try {
    S.activeModal = 'customer';
    S.modalData = null; // creating a NEW customer
    notes.length = 0;
    await sandbox.handleModalSubmit();
    assert(S.customers.length === 0, 'a customer with a blank phone number was SAVED');
    assert(notes.some(n => /phone number is required/i.test(String(n.m || ''))),
      'no error message was shown for the empty phone number');

    // Formatting-only input is not a number either.
    phones = phoneRows(['-- ()']);
    notes.length = 0;
    await sandbox.handleModalSubmit();
    assert(S.customers.length === 0, 'a customer with a formatting-only phone was SAVED');

    // A real number still saves normally.
    phones = phoneRows(['0912345678']);
    notes.length = 0;
    await sandbox.handleModalSubmit();
    assert(S.customers.length === 1, 'a valid customer failed to save');

    // EDITING: clearing the number must be blocked and the saved number kept.
    const saved = S.customers[0];
    S.modalData = saved;
    phones = phoneRows(['']);
    notes.length = 0;
    await sandbox.handleModalSubmit();
    const after = S.customers.find(c => c.id === saved.id);
    assert(Array.isArray(after.phones) && after.phones.length === 1 && after.phones[0] === '0912345678',
      'editing with an empty phone erased the saved phone number');
    assert(notes.some(n => /phone number is required/i.test(String(n.m || ''))),
      'no error message was shown when clearing the phone during edit');
  } finally {
    sandbox.document.getElementById = original.getElementById;
    sandbox.document.querySelectorAll = original.querySelectorAll;
    sandbox.closeModal = original.closeModal;
    S.activeModal = null;
    S.modalData = null;
    seedBusinessData();
  }
});

console.log('\n=== LIQUIDITY COVERAGE: visibility and the admin-only start date ===');

check('liquidity panel is hidden from an analytics view-only employee', () => {
  seedBusinessData();
  S.language = 'en';
  loginAs(employee({ analytics: ['view'] }));
  const html = visible(sandbox.renderAnalyticsView());
  assert(!html.includes('Liquidity Coverage'), 'the liquidity panel leaked without viewFinancials+viewSensitive');
});

check('liquidity panel is admin-only — even full financial employees do not see it', () => {
  // The appSettings config only syncs to admins; showing the panel to a
  // financially-cleared employee would leave them a permanently empty card.
  seedBusinessData();
  S.language = 'en';
  loginAs(employee({ analytics: ['view', 'viewFinancials', 'viewSensitive'] }));
  const html = visible(sandbox.renderAnalyticsView());
  assert(!html.includes('Liquidity Coverage'), 'the liquidity panel leaked to a non-admin');
  assert(!html.includes('liquidity-start-date'), 'the start-date control leaked to a non-admin');
});

check('admin sees the liquidity panel WITH the start-date control', () => {
  seedBusinessData();
  S.language = 'en';
  loginAs(ADMIN);
  const html = visible(sandbox.renderAnalyticsView());
  assert(html.includes('Liquidity Coverage'), 'the admin cannot see the liquidity panel');
  assert(html.includes('liquidity-start-date'), 'the admin start-date control is missing');
});

checkAsync('updateLiquidityTrackingStart refuses non-admins and validates the date for admins', async () => {
  seedBusinessData();
  S.language = 'en';
  S.serverMode = false;
  S.appSettings = [];
  loginAs(employee({
    analytics: ['view', 'viewFinancials', 'viewSensitive'],
    settings: ['view', 'edit', 'manageExchangeRate']
  }));
  notes.length = 0;
  await sandbox.updateLiquidityTrackingStart('2026-07-01');
  assert(S.appSettings.length === 0, 'a NON-ADMIN was able to start liquidity tracking');
  assert(notes.some(n => /admin/i.test(String(n.m || ''))), 'no refusal message was shown to the non-admin');

  loginAs(ADMIN);
  notes.length = 0;
  await sandbox.updateLiquidityTrackingStart('');
  assert(S.appSettings.length === 0, 'an empty start date was accepted');

  // Backdating is forbidden: old receipts edited before the collectionDate fix
  // carry rewritten dates, so a past window would count old money as new.
  notes.length = 0;
  await sandbox.updateLiquidityTrackingStart('2020-01-01');
  assert(S.appSettings.length === 0, 'a PAST start date was accepted — backdating must be refused');

  notes.length = 0;
  await sandbox.updateLiquidityTrackingStart(new Date().toISOString().slice(0, 10));
  assert(S.appSettings.length === 1 && S.appSettings[0].settingKey === 'liquidityTracking',
    'the admin start date was not recorded');
  assert(String(S.appSettings[0].setBy || '') === String(S.currentUser.id),
    'the liquidity record must remember who set it');
  S.appSettings = [];
  seedBusinessData();
});

console.log('\n=== CUSTOMERS: linked pages and customer-scoped page spending ===');

function seedCustomerPageDrilldown() {
  S.language = 'en';
  S.defaultExchangeRate = 9.5;
  S.customers = [
    { id: 'c1', name: 'Cust <One>', platform: 'Facebook', phones: [], profileLinks: [] },
    { id: 'c2', name: 'Customer Two', platform: 'Facebook', phones: [], profileLinks: [] }
  ];
  S.receipts = [];
  S.pages = [
    { id: 'pshared', name: 'Shared <Page>', category: 'Retail <img src=x onerror=alert(1)>', customerIds: ['c1', 'c2'], customerId: 'c1' },
    { id: 'plegacy', name: 'Legacy Page', category: 'Legacy', customerId: 'c1' },
    { id: 'pclone', name: 'Shared <Page>', category: 'New page with same name', customerIds: ['c1'] },
    { id: 'pforeign', name: 'Foreign Page', category: '', customerIds: ['c2'] },
    { id: 'pdeleted', name: 'Deleted Page', category: '', customerIds: ['c1'], _deleted: true }
  ];
  S.ads = [
    { id: 'a-paid', customerId: 'c1', pageId: 'pshared', recordType: 'ad', status: 'Active', paymentStatus: 'paid', amountUSD: 10, amountLocal: 95, startDate: '2026-07-10T00:00:00Z' },
    { id: 'a-stopped', customerId: 'c1', pageId: 'pshared', status: ' stopped ', paymentStatus: 'Not Paid', amountUSD: 30, amountLocal: 291, spentUSD: 12, startDate: '2026-07-11T00:00:00Z' },
    { id: 'a-wont', customerId: 'c1', pageId: 'pshared', recordType: 'ad', status: 'COMPLETED', paymentStatus: "won't pay", amountUSD: 5, amountLocal: 47.5, spentUSD: 4, startDate: '2026-07-12T00:00:00Z' },
    { id: 'a-pending', customerId: 'c1', pageId: 'pshared', recordType: 'ad', status: ' pending ', paymentStatus: 'Not Paid', amountUSD: 20, amountLocal: 190, startDate: '2026-07-13T00:00:00Z' },
    { id: 'a-other-customer', customerId: 'c2', pageId: 'pshared', recordType: 'ad', status: 'Active', paymentStatus: 'paid', amountUSD: 99, amountLocal: 940.5 },
    { id: 'a-same-name-new-page', customerId: 'c1', pageId: 'pclone', recordType: 'ad', status: 'Active', paymentStatus: 'paid', amountUSD: 8, amountLocal: 76 },
    { id: 'a-legacy', customer: 'c1', page: 'plegacy', status: 'PAUSED', paymentStatus: 'paid', amountUSD: 50, amountLocal: 475 },
    { id: 'a-deleted', customerId: 'c1', pageId: 'pshared', recordType: 'ad', status: 'Active', paymentStatus: 'paid', amountUSD: 100, amountLocal: 950, _deleted: true },
    { id: 'receipt-mirror', customerId: 'c1', pageId: 'pshared', recordType: 'receipt', status: 'Active', amountUSD: 77, amountLocal: 731.5 }
  ];
}

check('linked page count is a touch-sized dialog button only with pages.view', () => {
  seedCustomerPageDrilldown();
  loginAs(employee({ customers: ['view'] }));
  const denied = visible(sandbox.renderCustomersGrid([S.customers[0]]));
  assert(!denied.includes('data-action="view-customer-pages"'), 'page button leaked without pages.view');
  assert(!denied.includes('3 pages'), 'linked-page relationship count leaked without pages.view');

  loginAs(employee({ customers: ['view'], pages: ['view'] }));
  const allowed = visible(sandbox.renderCustomersGrid([S.customers[0]]));
  assert(allowed.includes('data-action="view-customer-pages"'), 'linked pages are not clickable');
  assert(allowed.includes('openCustomerPages(this.dataset.customerId, this)'), 'button does not use its safe data id');
  assert(allowed.includes('aria-haspopup="dialog"'), 'button does not announce the dialog');
  assert(allowed.includes('min-h-11'), 'button is too small for phone taps');
  assert(allowed.includes('3 pages'), 'legacy, modern, and same-name pages were not counted by id');
  seedBusinessData();
});

check('modern customerIds is authoritative over a stale legacy customerId', () => {
  seedCustomerPageDrilldown();
  loginAs(ADMIN);
  try {
    const reassigned = {
      id: 'page-reassigned',
      name: 'Reassigned Page',
      customerIds: ['c2'],
      customerId: 'c1'
    };
    const explicitlyUnlinked = {
      id: 'page-unlinked',
      name: 'Unlinked Page',
      customerIds: [],
      customerId: 'c1'
    };
    const legacyOnly = {
      id: 'page-legacy-only',
      name: 'Legacy Only',
      customerId: 'c1'
    };
    S.pages = [reassigned, explicitlyUnlinked, legacyOnly];

    assert(sandbox.getPageCustomerIds(reassigned).join(',') === 'c2', 'stale scalar owner overrode a modern reassignment');
    assert(sandbox.getPageCustomerIds(explicitlyUnlinked).length === 0, 'stale scalar owner revived an explicitly empty link array');
    assert(sandbox.getPageCustomerIds(legacyOnly).join(',') === 'c1', 'true legacy scalar link stopped working');
    assert(sandbox.getLinkedPagesForCustomer('c1').map(page => page.id).join(',') === 'page-legacy-only', 'stale legacy links leaked into the customer page list');
    assert(sandbox.getLinkedPagesForCustomer('c2').map(page => page.id).join(',') === 'page-reassigned', 'modern reassigned owner lost the page');
  } finally {
    seedBusinessData();
  }
});

check('customers.viewOwn shows and opens only the current user\'s customer', () => {
  const originalAppendChild = sandbox.document.body.appendChild;
  let appended = null;
  sandbox.document.body.appendChild = element => { appended = element; };
  try {
    S.language = 'en';
    S.customerSearch = '';
    S.customerSort = 'newest';
    S.customerFinancialFilter = 'all';
    S.customers = [
      { id: 'customer-own', name: 'Own Customer', platform: 'Facebook', phones: [], profileLinks: [], createdBy: 'u-emp', joinDate: '2026-07-17T00:00:00Z' },
      { id: 'customer-other', name: 'Other Customer', platform: 'Facebook', phones: [], profileLinks: [], createdBy: 'u-other', joinDate: '2026-07-16T00:00:00Z' }
    ];
    S.pages = [
      { id: 'page-own-customer', name: 'Own Customer Page', category: '', customerIds: ['customer-own'] },
      { id: 'page-other-customer', name: 'Other Customer Page', category: '', customerIds: ['customer-other'] }
    ];
    S.ads = [];
    S.receipts = [];
    loginAs(employee({ customers: ['viewOwn'], pages: ['view'] }));

    const html = visible(sandbox.renderCustomersView());
    assert(html.includes('Own Customer'), 'viewOwn user cannot see their own customer');
    assert(!html.includes('Other Customer'), 'viewOwn user can see another creator\'s customer');

    sandbox.openCustomerPages('customer-other');
    assert(appended === null, 'viewOwn user opened another creator\'s customer pages');
    sandbox.openCustomerPages('customer-own');
    assert(appended?.id === 'customer-pages-dialog', 'viewOwn user could not open their own customer pages');
    assert(appended.innerHTML.includes('Own Customer Page'), 'own customer dialog omitted its linked page');
    assert(!appended.innerHTML.includes('Other Customer Page'), 'other customer page leaked into the own-customer dialog');
  } finally {
    sandbox.document.body.appendChild = originalAppendChild;
    seedBusinessData();
  }
});

check('customer-page spending isolates shared-page customers and uses historical spend rules', () => {
  seedCustomerPageDrilldown();
  loginAs(ADMIN);
  const summary = sandbox.getCustomerPageSpendSummary('c1', 'pshared');
  assert(summary?.totalAds === 4, `expected four selected-customer ads, got ${summary?.totalAds}`);
  assert(summary.runningAds === 1, `expected one running ad, got ${summary.runningAds}`);
  assert(Math.abs(summary.totalSpendUSD - 26) < 1e-9, `wrong USD spend ${summary.totalSpendUSD}`);
  assert(Math.abs(summary.totalSpendLYD - 249.4) < 1e-9, `wrong LYD spend ${summary.totalSpendLYD}`);
  assert(Math.abs(summary.paidSpendUSD - 10) < 1e-9, `wrong paid spend ${summary.paidSpendUSD}`);
  assert(Math.abs(summary.unpaidSpendUSD - 16) < 1e-9, `wrong unpaid-ad spend ${summary.unpaidSpendUSD}`);
  assert(sandbox.getAdSpendUSD(S.ads.find(ad => ad.id === 'a-stopped')) === 12, 'lowercase Stopped used its full budget');
  assert(sandbox.getAdSpendUSD(S.ads.find(ad => ad.id === 'a-pending')) === 0, 'lowercase Pending counted as spend');
  assert(sandbox.getAdSpendUSD(S.ads.find(ad => ad.id === 'a-legacy')) === 0, 'uppercase Paused counted as spend');
  assert(sandbox.getLinkedPagesForCustomer('c1').length === 3, 'legacy scalar or deleted page handling is wrong');
  const customerStats = sandbox.getCustomerStats('c1');
  assert(Math.abs(customerStats.totalSpentLYD - 325.4) < 1e-9, `customer debt lost historical LYD rates: ${customerStats.totalSpentLYD}`);
  assert(sandbox.getCustomerPageSpendSummary('c1', 'pforeign') === null, 'unlinked page/customer pair was accepted');
  assert(sandbox.getCustomerPageSpendSummary('c1', 'pdeleted') === null, 'deleted page was accepted');
  assert(sandbox.getCustomerPageSpendSummary('c1', 'pclone').totalSpendUSD === 8, 'same-name page ids were merged');
  assert(sandbox.getCustomerPageSpendSummary('c1', 'plegacy').totalAds === 1, 'legacy ad/page aliases disappeared');
  seedBusinessData();
});

check('page detail escapes names and never shows false or unauthorized money', () => {
  seedCustomerPageDrilldown();
  loginAs(ADMIN);
  const summary = sandbox.getCustomerPageSpendSummary('c1', 'pshared');
  const noAds = visible(sandbox.renderCustomerPageSpendingDetail(summary, { canViewAds: false, canViewBalance: true }));
  assert(noAds.includes('Ad activity is hidden'), 'missing no-ad-access explanation');
  assert(!noAds.includes('$26.00'), 'money rendered without ads.view');

  const noBalance = visible(sandbox.renderCustomerPageSpendingDetail(summary, { canViewAds: true, canViewBalance: false }));
  assert(noBalance.includes('Total ads'), 'nonfinancial ad count disappeared');
  assert(noBalance.includes('Spending information is hidden'), 'missing balance permission explanation');
  assert(!noBalance.includes('$26.00'), 'money rendered without customers.viewBalance');

  const full = visible(sandbox.renderCustomerPageSpendingDetail(summary, { canViewAds: true, canViewBalance: true }));
  assert(full.includes('$26.00') && full.includes('249.40 LYD'), 'authorized total spending is missing');
  assert(full.includes('$16.00') && full.includes('Spend on unpaid ads'), 'unpaid-ad spend is missing or mislabeled');
  assert(full.includes('&lt;Page&gt;') && full.includes('&lt;img src=x onerror=alert(1)&gt;'), 'page text was not escaped');
  assert(!full.includes('<img src=x'), 'page category became executable HTML');
  seedBusinessData();
});

check('customer pages dialog is session-gated, mobile-safe, and contains only escaped data', () => {
  seedCustomerPageDrilldown();
  const originalAppendChild = sandbox.document.body.appendChild;
  let appended = null;
  sandbox.document.body.appendChild = element => { appended = element; };
  try {
    S.currentUser = null;
    sandbox.openCustomerPages('c1');
    assert(appended === null, 'dialog opened without an authenticated session');

    loginAs(ADMIN);
    sandbox.openCustomerPages('c1');
    assert(appended?.id === 'customer-pages-dialog', 'dialog was not created');
    assert(appended.className.includes('mobile-dialog-overlay'), 'dialog lacks the phone-safe overlay');
    assert(appended.innerHTML.includes('max-h-[90dvh]'), 'dialog can overflow the phone viewport');
    assert(appended.innerHTML.includes('data-page-id="pshared"'), 'linked page identity is missing');
    assert(appended.innerHTML.includes('this.dataset.customerId, this.dataset.pageId'), 'page action does not use safe data attributes');
    assert(appended.innerHTML.includes('Shared &lt;Page&gt;'), 'page name was not escaped in the list');
    assert(!appended.innerHTML.includes('<img src=x'), 'page category injected HTML into the dialog');
  } finally {
    sandbox.document.body.appendChild = originalAppendChild;
    seedBusinessData();
  }
});

check('Pages cards use canonical old-data spending and hide incomplete financial totals', () => {
  seedCustomerPageDrilldown();
  try {
    loginAs(employee({ pages: ['view'] }));
    const noAds = visible(sandbox.renderPagesView());
    assert(noAds.includes('Ad activity hidden'), 'page card claims zero activity without ads.view');
    assert(!noAds.includes('$125.00'), 'page money leaked without ads.view');

    loginAs(employee({ pages: ['view'], ads: ['view'] }));
    const noFinancials = visible(sandbox.renderPagesView());
    assert(noFinancials.includes('Total Spend') && noFinancials.includes('Hidden'), 'financial permission placeholder is missing');
    assert(!noFinancials.includes('$125.00'), 'page money leaked without analytics.viewFinancials');

    loginAs(employee({ pages: ['view'], ads: ['view'], analytics: ['viewFinancials'] }));
    const financialsOnly = visible(sandbox.renderPagesView());
    assert(financialsOnly.includes('Total Spend') && financialsOnly.includes('Hidden'), 'aggregate page money needs analytics.viewSensitive as well as viewFinancials');
    assert(!financialsOnly.includes('$125.00'), 'aggregate page money leaked with viewFinancials alone');

    loginAs(employee({ pages: ['view'], ads: ['view'], analytics: ['viewFinancials', 'viewSensitive'] }));
    const authorized = visible(sandbox.renderPagesView());
    assert(authorized.includes('$125.00'), 'shared page canonical USD total is wrong');
    assert(authorized.includes('1189.90 LYD'), 'shared page historical LYD total is wrong');
  } finally {
    seedBusinessData();
  }
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

checkAsync('rapid duplicate delivery actions write once and never increment user counters', async () => {
  const originalUpdateRecord = sandbox.updateRecord;
  const driver = {
    id: 'u-driver-idempotent', name: 'Driver', role: 'Delivery', permissions: {},
    stats: { totalAds: 9, accepted: 7, collected: 4 }
  };
  const beforeStats = JSON.stringify(driver.stats);
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let receiptWrites = 0;
  let userWrites = 0;
  try {
    seedBusinessData();
    S.receipts[0].deliveryPersonId = driver.id;
    S.receipts[0].deliveryStatus = 'Needs Delivery';
    loginAs(driver);
    sandbox.updateRecord = async (array, id, updates) => {
      if (array === S.users) userWrites++;
      if (array === S.receipts) receiptWrites++;
      await saveGate;
      const record = array.find(item => item.id === id);
      if (record) Object.assign(record, updates);
      return true;
    };

    const first = sandbox.acceptDelivery('r1');
    const duplicate = sandbox.acceptDelivery('r1');
    await Promise.resolve();
    assert(receiptWrites === 1, `duplicate accept performed ${receiptWrites} writes`);
    releaseSave();
    await Promise.all([first, duplicate]);
    assert(userWrites === 0, 'accept wrote a mutable user stats counter');
    assert(JSON.stringify(driver.stats) === beforeStats, 'accept mutated driver stats');

    receiptWrites = 0;
    let releaseCollect;
    const collectGate = new Promise(resolve => { releaseCollect = resolve; });
    sandbox.updateRecord = async (array, id, updates) => {
      if (array === S.users) userWrites++;
      if (array === S.receipts) receiptWrites++;
      await collectGate;
      const record = array.find(item => item.id === id);
      if (record) Object.assign(record, updates);
      return true;
    };
    const collected = sandbox.markAsCollected('r1');
    const duplicateCollected = sandbox.markAsCollected('r1');
    await Promise.resolve();
    assert(receiptWrites === 1, `duplicate collection performed ${receiptWrites} writes`);
    releaseCollect();
    await Promise.all([collected, duplicateCollected]);
    assert(userWrites === 0, 'collection wrote a mutable user stats counter');
    assert(JSON.stringify(driver.stats) === beforeStats, 'collection mutated driver stats');
  } finally {
    sandbox.updateRecord = originalUpdateRecord;
    seedBusinessData();
  }
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

console.log('\n=== MONEY MATH: no phantom cents from floating-point residue ===');

check('291 LYD at rate 9.70 gives exactly $30.00 (was $30.02)', () => {
  const r2 = sandbox.ceilingRound(291 / 9.7);
  assert(r2 === 30, `291/9.7 should credit $30.00, got $${r2}`);
  // the "+0.01 when it has decimals" rule must not fire on a whole number
  assert(r2 % 1 === 0, 'a whole-dollar credit must not gain a cent');
});

check('the receipt stores the rate the user typed (was 9.69 for 9.70)', () => {
  const rate = sandbox.receiptExchangeRate([{ method: 'Cash (LYD)', rate2: 9.7 }], 291, 30);
  assert(rate === 9.7, `expected the typed rate 9.7, got ${rate}`);
});

check('a split still stores the effective average rate', () => {
  const rate = sandbox.receiptExchangeRate(
    [{ method: 'Cash (LYD)', rate2: 9.7 }, { method: 'Libyana', rate2: 9.0 }], 300, 31.5);
  assert(Math.abs(rate - (300 / 31.5)) < 1e-9, `split should average, got ${rate}`);
});

check('rounding UP in the customer\'s favour still happens for real fractions', () => {
  assert(sandbox.ceilingRound(90.100143062) === 90.11, 'must round up to 90.11');
  assert(sandbox.ceilingRound(100 / 9.5) === 10.53, '100/9.5 must round up to 10.53');
  // A genuine fraction of a cent still rounds up (the business rule)...
  assert(sandbox.ceilingRound(30.0001) === 30.01, 'a real fraction must still round up');
  // ...but binary residue from a division must NOT invent one.
  assert(sandbox.ceilingRound(291 / 9.7) === 30, 'float residue must not create a phantom cent');
  assert(sandbox.ceilingRound(873 / 9.7) === 90, 'float residue must not create a phantom cent (x3)');
  assert(sandbox.ceilingRound(0) === 0 && sandbox.ceilingRound(NaN) === 0, 'zero/NaN stay 0');
});

console.log('\n=== FRONTEND SAFETY: cache identity, ids, sync, idempotency ===');

check('record ids cannot break out of attributes or inline handlers', () => {
  const Security = bridged.Security;
  for (const safe of ['receipt_123_abc', 'u-admin', 'abc.def:4']) {
    assert(Security.isValidRecordId(safe), `safe id rejected: ${safe}`);
  }
  for (const unsafe of ["x');alert(1)//", 'white space', '../receipt', '<img>', '', 'a'.repeat(81)]) {
    assert(!Security.isValidRecordId(unsafe), `unsafe id accepted: ${unsafe}`);
  }
  const nested = Security.validateRecordIdentifiers({ id: 'receipt_ok', customerId: "c');alert(1)//" }, 'receipt');
  assert(!nested.valid, 'unsafe relationship id was accepted');
});

check('opaque nested ids remain compatible while explicit relationships stay strict', () => {
  const Security = bridged.Security;
  const credentialId = 'credential_' + 'A'.repeat(180);
  const passkeyRecord = Security.validateRecordIdentifiers({
    id: 'user_safe',
    passkeys: [{ id: credentialId, publicKeyJwk: { kty: 'EC' } }]
  }, 'user');
  assert(passkeyRecord.valid, 'opaque WebAuthn credential id was treated as an entity id');
  const badRelationship = Security.validateRecordIdentifiers({
    id: 'receipt_safe',
    metadata: { customerId: "bad');alert(1)//" }
  }, 'receipt');
  assert(!badRelationship.valid, 'nested explicit relationship id was accepted');
});

check('every entity response path rejects poisoned relationship ids', () => {
  const safe = {
    id: 'receipt_safe', type: 'receipts', deleted: false,
    createdAt: 1, lastModified: 1,
    data: { id: 'receipt_safe', customerId: 'customer_safe' }
  };
  assert(sandbox.validateServerEntityResponse('receipts', safe, 'test') === safe, 'safe entity was rejected');
  let rejected = false;
  try {
    sandbox.validateServerEntityResponse('receipts', {
      ...safe,
      data: { id: 'receipt_safe', customerId: "bad');alert(1)//" }
    }, 'test');
  } catch (e) {
    rejected = e && e.code === 'UNSAFE_RECORD_IDENTIFIER';
  }
  assert(rejected, 'poisoned entity response was accepted');
});

check('keyset page overlap deduplicates IDs and keeps the newest version', () => {
  const rows = [];
  const indexes = new Map();
  sandbox.mergeServerEntityDataById(rows, indexes, {
    id: 'receipt_safe', lastModified: 10,
    data: { id: 'receipt_safe', _lastModified: 10, note: 'old' }
  });
  sandbox.mergeServerEntityDataById(rows, indexes, {
    id: 'receipt_safe', lastModified: 20,
    data: { id: 'receipt_safe', _lastModified: 20, note: 'new' }
  });
  assert(rows.length === 1, 'duplicate page boundary left two copies of one record');
  assert(rows[0].note === 'new', 'dedupe kept the stale record version');
});

check('live-sync replay and stale rows are no-ops and preserve object identity', () => {
  const current = {
    id: 'page_delta_stable',
    name: 'Current Page',
    _lastModified: 100
  };
  S.pages = [current];

  const replayChanged = sandbox.applyServerDelta('pages', [{ ...current }]);
  assert(replayChanged === false, 'same-version overlap was reported as a real change');
  assert(S.pages.length === 1, 'same-version overlap duplicated the row');
  assert(S.pages[0] === current, 'same-version overlap replaced the existing object');

  const staleChanged = sandbox.applyServerDelta('pages', [{
    id: current.id,
    name: 'Stale Page',
    _lastModified: 99
  }]);
  assert(staleChanged === false, 'stale overlap was reported as a real change');
  assert(S.pages[0] === current, 'stale overlap replaced the existing object');
  assert(S.pages[0].name === 'Current Page', 'stale overlap rolled visible data backward');
});

check('live-sync newer rows report a real change and replace the visible record', () => {
  const current = {
    id: 'page_delta_newer',
    name: 'Before Sync',
    _lastModified: 100
  };
  S.pages = [current];

  const changed = sandbox.applyServerDelta('pages', [{
    id: current.id,
    name: 'After Sync',
    _lastModified: 101
  }]);
  assert(changed === true, 'newer server row was not reported as a real change');
  assert(S.pages.length === 1, 'newer server row duplicated the record');
  assert(S.pages[0] !== current, 'newer server row did not replace the old object');
  assert(S.pages[0].name === 'After Sync', 'newer server value did not reach state');
  assert(S.pages[0]._lastModified === 101, 'newer server version was not preserved');
});

check('equal-version tombstone deletes an active row and its replay is a no-op', () => {
  const active = {
    id: 'page_delta_equal_delete',
    name: 'Delete Me',
    _lastModified: 200
  };
  S.pages = [active];

  const tombstone = {
    id: active.id,
    name: active.name,
    _lastModified: 200,
    _deleted: true
  };
  const deleted = sandbox.applyServerDelta('pages', [tombstone]);
  assert(deleted === true, 'equal-version tombstone was ignored');
  assert(S.pages.length === 1, 'equal-version tombstone duplicated the row');
  assert(S.pages[0] !== active, 'equal-version tombstone did not replace the active object');
  assert(S.pages[0]._deleted === true, 'equal-version tombstone did not mark the row deleted');

  const appliedTombstone = S.pages[0];
  const replayed = sandbox.applyServerDelta('pages', [{ ...tombstone }]);
  assert(replayed === false, 'replayed equal-version tombstone reported another change');
  assert(S.pages[0] === appliedTombstone, 'replayed tombstone replaced the stored object');
});

check('same-version duplicate delta always keeps the tombstone regardless of order', () => {
  const active = {
    id: 'page_delta_order_tie',
    name: 'Boundary Write',
    _lastModified: 300
  };
  const tombstone = {
    ...active,
    _deleted: true
  };

  for (const records of [
    [{ ...active }, { ...tombstone }],
    [{ ...tombstone }, { ...active }]
  ]) {
    S.pages = [];
    const changed = sandbox.applyServerDelta('pages', records);
    assert(changed === true, 'new duplicate-id delta was not applied');
    assert(S.pages.length === 1, 'duplicate-id delta produced more than one row');
    assert(S.pages[0]._deleted === true, 'active record won an equal-version tombstone tie');
  }
});

check('legacy no-version replay is stable but changed data still replaces the row', () => {
  const legacy = {
    id: 'page_delta_legacy',
    name: 'Legacy Page',
    category: 'Old Data'
  };
  S.pages = [legacy];

  const replayed = sandbox.applyServerDelta('pages', [{ ...legacy }]);
  assert(replayed === false, 'identical legacy row was reported as changed');
  assert(S.pages[0] === legacy, 'identical legacy row lost object identity');

  const changed = sandbox.applyServerDelta('pages', [{ ...legacy, name: 'Legacy Page Updated' }]);
  assert(changed === true, 'changed legacy row was ignored without a revision stamp');
  assert(S.pages[0] !== legacy, 'changed legacy row did not replace the old object');
  assert(S.pages[0].name === 'Legacy Page Updated', 'changed legacy value did not reach state');
});

check('unchanged Pages HTML performs no DOM, layout, icon, RAF, or scroll work', () => {
  withTrackedPagesRender(({ metrics }) => {
    realRender();
    assert(metrics.appWrites === 0, 'unchanged render replaced the full app');
    assert(metrics.viewWrites === 0, 'unchanged render replaced the current view');
    assert(metrics.layoutClassOps === 0, 'unchanged render toggled the layout lock class');
    assert(metrics.appHeightOps === 0, 'unchanged render wrote the app height lock');
    assert(metrics.iconSchedules === 0, 'unchanged render rescanned/recreated icons');
    assert(metrics.rafCalls === 0, 'unchanged render scheduled paint work');
    assert(metrics.scrollCalls === 0, 'unchanged render forced a scroll restoration');
  });
});

check('a visible Pages change updates only the view and strips entry animation', () => {
  withTrackedPagesRender(({ metrics, viewContainer }) => {
    S.pages[0] = {
      ...S.pages[0],
      name: 'Changed by Live Sync',
      _lastModified: 101
    };
    realRender();
    assert(metrics.appWrites === 0, 'same-view data change replaced the full app/sidebar');
    assert(metrics.viewWrites === 1, `visible data change wrote the view ${metrics.viewWrites} times`);
    assert(viewContainer.innerHTML.includes('Changed by Live Sync'), 'updated page name was not rendered');
    assert(
      metrics.animationRemovals.includes('animate-fade-in-up'),
      'same-view update kept the entry animation that makes cards jump'
    );
  });
});

check('IndexedDB collection keys are isolated by server and authenticated user', () => {
  sandbox.activateLocalCollectionStorage();
  const localKey = sandbox.getCollectionMetaKey('receipts');
  sandbox.activateServerCollectionStorage({ id: 'user_a' });
  const userAKey = sandbox.getCollectionMetaKey('receipts');
  sandbox.activateServerCollectionStorage({ id: 'user_b' });
  const userBKey = sandbox.getCollectionMetaKey('receipts');
  sandbox.activateAnonymousServerCollectionStorage();
  const anonymousKey = sandbox.getCollectionMetaKey('receipts');
  assert(localKey !== userAKey, 'server cache reused the local key');
  assert(userAKey !== userBKey, 'two users shared one business cache key');
  assert(userBKey !== anonymousKey, 'authenticated cache reused the anonymous key');
});

check('cookie-session startup can start/stop polling without aborting its full load identity', () => {
  S.serverMode = true;
  S.currentUser = ADMIN;
  sandbox.activateServerCollectionStorage(ADMIN);
  const beforeIdentity = sandbox.getServerSessionIdentity();
  const beforeSessionEpoch = bridged._serverLiveSync.sessionEpoch;
  const beforePollerEpoch = bridged._serverLiveSync.pollerEpoch;
  sandbox.stopServerLiveSync();
  assert(sandbox.getServerSessionIdentity() === beforeIdentity, 'poller stop changed authenticated load identity');
  assert(bridged._serverLiveSync.sessionEpoch === beforeSessionEpoch, 'poller stop advanced auth session epoch');
  assert(bridged._serverLiveSync.pollerEpoch > beforePollerEpoch, 'poller generation did not advance');
  S.serverMode = false;
});

check('full-load cursors use pre-load watermarks and never snapshot maxima', () => {
  const sync = bridged._serverLiveSync;
  sync.cursor = 30;
  sync.serverWatermark = 30;
  sync.fullLoadCursorReady = false;
  sync.collectionCursors = { customers: 30 };
  const results = {
    ads: { ok: true, data: [{ id: 'ad_safe', _lastModified: 500 }] },
    receipts: { ok: true, data: [{ id: 'receipt_safe', _lastModified: 400 }] },
    customers: { ok: false, data: null }
  };
  const seeded = sandbox.reseedServerCursorFromFullLoad(results, [{ collection: 'customers' }], { ads: 100, receipts: 80 });
  assert(seeded === true, 'captured watermarks were not accepted');
  assert(sync.collectionCursors.ads === 100, 'ads cursor used a snapshot maximum instead of its pre-load watermark');
  assert(sync.collectionCursors.receipts === 80, 'receipts cursor used a snapshot maximum instead of its pre-load watermark');
  assert(sync.collectionCursors.customers === 30, 'failed collection did not retain its prior cursor');
  assert(sync.cursor === 100 && sync.serverWatermark === 100, 'debug aggregate does not reflect captured cursors');

  const fallback = sandbox.reseedServerCursorFromFullLoad(results, [], null);
  assert(fallback === false, 'missing watermark endpoint claimed an authoritative boundary');
  assert(sync.collectionCursors.ads === 0 && sync.collectionCursors.receipts === 0, '404/failure fallback did not force a since=0 catch-up');
  assert(sync.collectionCursors.customers === 30, 'fallback changed a failed collection cursor');
});

check('permission scope changes detect view-to-own, view-to-none, and Admin demotion', () => {
  const full = employee({ ads: ['view'], receipts: ['view'] });
  const own = employee({ ads: ['viewOwn'], receipts: ['view'] });
  const none = employee({ receipts: ['view'] });
  assert(sandbox.getServerVisibilityScopeChanges(full, own).includes('ads'), 'view -> viewOwn was not detected');
  assert(sandbox.getServerVisibilityScopeChanges(own, none).includes('ads'), 'viewOwn -> none was not detected');
  assert(sandbox.getServerCollectionVisibilityScope(full, 'ads') === 'all', 'view scope classified incorrectly');
  assert(sandbox.getServerCollectionVisibilityScope(own, 'ads') === 'own', 'viewOwn scope classified incorrectly');
  assert(sandbox.getServerCollectionVisibilityScope(none, 'ads') === 'none', 'revoked scope classified incorrectly');
  assert(sandbox.getServerVisibilityScopeChanges(ADMIN, none).includes('pages'), 'Admin demotion was not detected from role');
});

check('server mode never grants access from the legacy subscription array', () => {
  S.currentUser = employee({});
  S.currentUser.subscriptions = ['clothes_system'];
  S.serviceSubscriptions = [];
  S.serverMode = true;
  assert(!sandbox.hasSubscription('clothes_system'), 'legacy client field granted a server subscription');
  S.serverMode = false;
  assert(sandbox.hasSubscription('clothes_system'), 'local-mode legacy compatibility was removed');
});

check('delta cursor zero stays zero even when cached state has newer timestamps', () => {
  const sync = bridged._serverLiveSync;
  S.ads = [{ id: 'ad_cached', _lastModified: 999999 }];
  sync.cursor = 999999;
  sync.collectionCursors = Object.create(null);
  assert(sandbox.getServerCollectionCursor('ads') === 0, 'missing per-collection cursor fell back to state/global max');
  sync.collectionCursors.ads = 500;
  sync.collectionCursors.receipts = 100;
  assert(sandbox.getServerCollectionCursor('ads') === 500, 'ads cursor not isolated');
  assert(sandbox.getServerCollectionCursor('receipts') === 100, 'receipts cursor not isolated');
});

check('money operations always create a backend-valid idempotency key', () => {
  const generated = sandbox.ensureOperationIdempotencyKey('', 'transfer');
  const replacedShort = sandbox.ensureOperationIdempotencyKey('tiny', 'topup');
  const preserved = sandbox.ensureOperationIdempotencyKey('stable-operation-key', 'subscription');
  assert(generated.length >= 8, 'missing generated key');
  assert(replacedShort.length >= 8 && replacedShort !== 'tiny', 'short invalid key was kept');
  assert(preserved === 'stable-operation-key', 'valid retry key was not preserved');
});

check('clothes order retries keep one id and idempotency key until success', () => {
  const payload = { customerName: 'Customer', lines: [{ productId: 'product_safe', qty: 1 }] };
  const first = sandbox.getClothesOrderMutationAttempt('create', '', null, payload);
  const retry = sandbox.getClothesOrderMutationAttempt('create', '', null, payload);
  assert(first === retry, 'same create retry did not reuse its pending attempt');
  assert(first.orderId && first.idempotencyKey.length >= 8, 'create attempt lacks stable backend identifiers');
  sandbox.completeClothesOrderMutationAttempt(first);
  const later = sandbox.getClothesOrderMutationAttempt('create', '', null, payload);
  assert(later !== first, 'completed create attempt was incorrectly reused');
  sandbox.completeClothesOrderMutationAttempt(later);
});

check('receipt transfer retries keep one target receipt and key until success', () => {
  const source = { id: 'receipt_source', _lastModified: 123 };
  const first = sandbox.getReceiptTransferAttempt(source, 'customer_target', 2500, 'move credit');
  const retry = sandbox.getReceiptTransferAttempt(source, 'customer_target', 2500, 'move credit');
  assert(first === retry, 'same transfer retry did not reuse its pending attempt');
  assert(first.targetReceiptId && first.idempotencyKey.length >= 8, 'transfer attempt lacks stable identifiers');
  sandbox.completeReceiptTransferAttempt(first);
  const later = sandbox.getReceiptTransferAttempt(source, 'customer_target', 2500, 'move credit');
  assert(later !== first, 'completed transfer attempt was incorrectly reused');
  sandbox.completeReceiptTransferAttempt(later);
});

check('ad mutation and stop retries keep stable idempotency keys', () => {
  const dataA = { customerId: 'customer_safe', receiptAllocations: [{ receiptId: 'receipt_safe', amountUSD: 10 }], updatedAt: '2026-01-01T00:00:00Z' };
  const dataB = { ...dataA, updatedAt: '2026-01-02T00:00:00Z' };
  const first = sandbox.getAdMutationAttempt('create', '', null, dataA);
  const retry = sandbox.getAdMutationAttempt('create', '', null, dataB);
  assert(first === retry, 'volatile audit timestamp changed the ad retry identity');
  assert(first.adId && first.idempotencyKey.length >= 8, 'ad mutation attempt lacks stable identifiers');
  sandbox.completeAdMutationAttempt(first);

  const ad = { id: 'ad_safe', _lastModified: 456 };
  const stop = sandbox.getAdStopAttempt(ad, 1250, false);
  const stopRetry = sandbox.getAdStopAttempt(ad, 1250, false);
  assert(stop === stopRetry && stop.idempotencyKey.length >= 8, 'ad stop retry key was not stable');
  const informedStop = sandbox.getAdStopAttempt(ad, 1250, true);
  assert(informedStop !== stop, 'customer-informed confirmation reused the wrong stop request identity');
  sandbox.completeAdStopAttempt(informedStop);
});

check('changing reconciled spend clears stale customer confirmation until it is checked again', () => {
  const originalAds = S.ads;
  const originalLanguage = S.language;
  const originalGetElementById = sandbox.document.getElementById;
  const input = makeElement();
  const remaining = makeElement();
  const informed = makeElement();
  const help = makeElement();
  try {
    loginAs(ADMIN);
    S.language = 'en';
    S.ads = [{
      id: 'recon-confirmation',
      creatorId: ADMIN.id,
      amountUSD: 10,
      spentUSD: 4,
      remainingCustomerInformed: true,
      remainingCustomerInformedAt: '2026-07-18T10:00:00.000Z'
    }];
    input.value = '5.00';
    informed.checked = true;
    informed.disabled = true;
    sandbox.document.getElementById = id => ({
      'reconciliation-spent-recon-confirmation': input,
      'reconciliation-remaining-recon-confirmation': remaining,
      'reconciliation-informed-recon-confirmation': informed,
      'reconciliation-informed-help-recon-confirmation': help
    }[id] || null);

    sandbox.updateReconciliationPreview('recon-confirmation');
    assert(remaining.textContent === '$5.00', 'changed remainder preview is incorrect');
    assert(informed.checked === false && informed.disabled === false, 'old confirmation was not cleared and re-enabled');
    assert(help.textContent.includes('changed'), 'the UI did not explain why confirmation is required again');

    input.value = '4.00';
    sandbox.updateReconciliationPreview('recon-confirmation');
    assert(informed.checked === true && informed.disabled === true, 'original confirmation was not restored for its unchanged amount');

    input.value = '';
    sandbox.updateReconciliationPreview('recon-confirmation');
    assert(informed.checked === false && informed.disabled === true, 'invalid spend kept a stale confirmation active');
  } finally {
    S.ads = originalAds;
    S.language = originalLanguage;
    sandbox.document.getElementById = originalGetElementById;
  }
});

check('reconciliation waits one day after an ad ends or is stopped and shows only eligible ads', () => {
  const boundaryAd = { id: 'recon-boundary', endDate: '2026-07-17T00:00:00.000Z' };
  assert(!sandbox.isAdReadyForReconciliation(boundaryAd, '2026-07-17T23:59:00'), 'ad appeared on its end date');
  assert(sandbox.isAdReadyForReconciliation(boundaryAd, '2026-07-18T00:00:00'), 'ad did not appear on the next calendar day');
  const stoppedBoundaryAd = { id: 'recon-stopped-boundary', status: 'Stopped', stoppedAt: '2026-07-17T10:00:00.000Z', endDate: '2026-08-17T00:00:00.000Z' };
  assert(!sandbox.isAdReadyForReconciliation(stoppedBoundaryAd, '2026-07-17T23:59:00'), 'stopped ad appeared on its stop day');
  assert(sandbox.isAdReadyForReconciliation(stoppedBoundaryAd, '2026-07-18T00:00:00'), 'stopped ad did not appear the next day');
  const endedThenSaved = { id: 'recon-ended-then-saved', status: 'Stopped', endDate: '2026-07-16T00:00:00.000Z', stoppedAt: '2026-07-18T10:00:00.000Z' };
  assert(sandbox.isAdReadyForReconciliation(endedThenSaved, '2026-07-18T12:00:00'), 'saving an ended ad postponed its reconciliation eligibility');
  assert(sandbox.getAdReconciliationTriggerDay(endedThenSaved).getDate() === 16, 'the later save timestamp replaced the real end day');

  loginAs(ADMIN);
  S.language = 'en';
  S.customers = [{ id: 'recon-customer', name: 'Finished Customer' }];
  S.pages = [{ id: 'recon-page', name: 'Finished Page' }];
  S.ads = [
    { id: 'recon-finished', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Active', amountUSD: 30, startDate: '1999-12-20T00:00:00.000Z', endDate: '2000-01-01T00:00:00.000Z' },
    { id: 'recon-stopped-early', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Stopped', stoppedAt: '2000-01-01T10:00:00.000Z', amountUSD: 35, startDate: '1999-12-21T00:00:00.000Z', endDate: '2999-01-01T00:00:00.000Z' },
    { id: 'recon-paused', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Paused', amountUSD: 20, startDate: '1999-12-22T00:00:00.000Z', endDate: '2000-01-02T00:00:00.000Z' },
    { id: 'recon-future', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Active', amountUSD: 40, endDate: '2999-01-01T00:00:00.000Z' },
    { id: 'recon-canceled', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Canceled', amountUSD: 50, endDate: '2000-01-01T00:00:00.000Z' },
    { id: 'recon-no-date', customerId: 'recon-customer', pageId: 'recon-page', creatorId: ADMIN.id, status: 'Active', amountUSD: 60 }
  ];
  const html = sandbox.renderReconciliationView();
  assert(html.includes('recon-finished'), 'finished ad is missing from reconciliation');
  assert(html.includes('recon-stopped-early'), 'early-stopped ad is missing after its waiting day');
  assert(html.includes('recon-paused'), 'paused finished ad is missing from reconciliation');
  assert(!html.includes('recon-future'), 'future ad leaked into reconciliation');
  assert(!html.includes('recon-canceled'), 'canceled ad leaked into reconciliation');
  assert(!html.includes('recon-no-date'), 'ad without an end date leaked into reconciliation');
  assert(html.includes('Actual Facebook spend (USD)'), 'actual-spend input is missing');
  assert(html.includes('Start:'), 'outside start date is missing');
  assert(html.includes('bg-rose-100') && html.includes('Stopped'), 'stopped ad does not have its red status treatment');
  assert(html.includes('bg-violet-100') && html.includes('Paused'), 'paused ad does not have its purple status treatment');
  assert(html.includes('I confirm that I told the customer'), 'customer-informed checkbox is missing');
  assert(html.includes('Save &amp; return remaining') || html.includes('Save & return remaining'), 'return-to-customer action is missing');
});

check('multi-entity server apply validates the whole batch before changing state', () => {
  S.receipts = [{ id: 'receipt_original', note: 'keep' }];
  let rejected = false;
  try {
    sandbox.applyValidatedServerEntityBatch([
      { collection: 'receipts', entity: { id: 'receipt_source', lastModified: 10, data: { id: 'receipt_source' } } },
      { collection: 'receipts', entity: { id: 'bad id', lastModified: 11, data: { id: 'bad id' } } }
    ], 'testBatch');
  } catch (_) {
    rejected = true;
  }
  assert(rejected, 'malformed second entity was accepted');
  assert(S.receipts.length === 1 && S.receipts[0].id === 'receipt_original', 'first entity applied before the batch was fully validated');
});

check('first-run UI separates local, token-enabled, and disabled server setup', () => {
  S.serverMode = false;
  S.needsServerSetup = false;
  let html = sandbox.renderFirstRunSetup();
  assert(html.includes('Create Admin (Local)'), 'local first run lost its local admin form');
  assert(!html.includes('first-setup-token'), 'local first run incorrectly asks for a server token');

  S.serverMode = true;
  S.needsServerSetup = true;
  S.serverSetupEnabled = true;
  html = sandbox.renderFirstRunSetup();
  assert(html.includes('first-setup-token'), 'enabled server setup has no token field');

  S.needsServerSetup = false;
  S.serverHasNoUsers = true;
  S.serverSetupEnabled = false;
  html = sandbox.renderLogin();
  assert(html.includes('Browser setup is disabled.'), 'disabled setup has no persistent operator guidance');
  assert(!html.includes('onclick="startServerSetup()"'), 'disabled setup still renders a usable setup button');
  S.serverMode = false;
  S.serverHasNoUsers = false;
});

check('server money/subscription calls use dedicated transactional endpoints', () => {
  const built = fs.readFileSync(SCRIPT, 'utf8');
  for (const endpoint of ['/api/wallet/transfers', '/api/wallet/top-ups', '/api/wallet/reversals', '/api/subscriptions/purchase', '/api/clothes/orders/mutate', '/api/receipts/transfers', '/api/ads/mutate', '/stop', '/api/sync/watermarks']) {
    assert(built.includes(endpoint), `missing dedicated endpoint ${endpoint}`);
  }
  assert(built.includes('expectedSourceLastModified: serverAttempt.expectedSourceLastModified'), 'receipt transfer omits optimistic version');
  assert(built.includes("await saveAdThroughAtomicServer(\n            'update'"), 'ad edits still use generic collection PATCH');
  assert(built.includes('const response = await apiStopAd(storedAd.id'), 'ad stop does not use the atomic endpoint');
  const financialHelpersSource = fs.readFileSync(path.join(__dirname, '..', 'src', '13-filters-helpers.js'), 'utf8');
  const topUpBody = financialHelpersSource.split('async function saveTopUps()')[1]?.split('// Refund management functions')[0] || '';
  const refundBody = financialHelpersSource.split('async function saveRefund()')[1] || '';
  assert(topUpBody.includes('await saveAdThroughAtomicServer('), 'server ad top-ups still use generic funding PATCH');
  assert(refundBody.includes('await saveAdThroughAtomicServer('), 'server ad refunds still use generic funding PATCH');
  assert(built.includes('const deltaCollections = getAuthorizedServerSyncCollections();'), 'live sync still polls known-forbidden collections');
  assert(built.includes("body: { name, email, password, setupToken }"), 'first-admin API omits the setup token');
  assert(built.includes('state.serverSetupEnabled === true'), 'browser setup UI is not gated by server capability');
  assert(built.includes('Browser setup is disabled. The server operator must use the ALBAYAN_BOOTSTRAP_ADMIN_*'), 'disabled browser setup lacks operator guidance');
  assert(built.includes('Forgot your password? Contact an administrator.'), 'server login still advertises unusable email reset');
  assert(built.includes("code = incompleteError.code || 'INCOMPLETE_COLLECTION_LOAD'"), 'partial page failures are not propagated');
  assert(built.includes('for (const name of failed) idbSync.dirty.add(name)'), 'failed IndexedDB writes are not requeued');
  assert(built.includes('const requestKey = `${identity}|${String(collection || \'\')}|${forceRefresh ? \'fresh\' : \'cached\'}|${mediaMode}`'), 'collection requests are not session-identity/freshness/media scoped');
  assert(built.includes('const loadAborted = () => ('), 'full server loads have no session-change guard');
  assert(built.includes("error.code = 'SERVER_SESSION_CHANGED'"), 'late responses cannot signal a changed session');
  assert(built.includes("if (isServerModeEnabled()) {\n      showNotification(\n        state.language === 'ar' ? 'غير متاح' : 'Not Available'"), 'server-mode passkey registration is not disabled');
  assert(built.includes('const startupLoad = serverLoadAllData()'), 'cookie startup does not sequence its full load');
  assert(built.includes('startupLoad.finally(() => {'), 'live poller is not started after the startup full load settles');
  assert(built.includes('_serverLiveSync.fullLoadCursorReady'), 'partial startup has no cursor-zero fallback');
  assert(built.includes('const since = getServerCollectionCursor(collection);'), 'delta requests do not use per-collection cursors');
  assert(!built.includes('const since = _serverLiveSync.cursor || computeServerCursorFromState() || 0'), 'cursor zero is still defeated by state fallback');
  assert(built.includes('const result = await apiLoadCollectionAll(collection, { forceRefresh: true });'), 'full load can reuse a pre-watermark stale cache');
  assert(built.includes('&before_created_at=${encodeURIComponent(String(beforeCreatedAt))}&before_id=${encodeURIComponent(beforeId)}'), 'full collection paging does not use a stable createdAt/id keyset');
  assert(built.includes('&after_last_modified=${encodeURIComponent(String(afterLastModified))}&after_id=${encodeURIComponent(afterId)}'), 'delta paging does not use a stable lastModified/id keyset');
  assert(!built.includes('&offset=${offset}&include_deleted=true'), 'collection sync still uses race-prone OFFSET pagination');
  assert(built.includes('await clearServerCollectionsForVisibility(forbiddenCollections);'), '403 deltas do not purge previously visible records');
  assert(built.includes('const scopedReload = await serverLoadAllData();'), 'permission scope changes do not perform an authoritative reload');
  assert(built.includes("role: String(state.currentUser.role || '').toLowerCase()"), 'auth refresh access signature omits role');
  assert(built.includes("attempt = getClothesOrderMutationAttempt('status'"), 'clothes status changes bypass the atomic mutation API');
  assert(built.includes("attempt = getClothesOrderMutationAttempt('payment'"), 'clothes payment changes bypass the atomic mutation API');
  assert(built.includes("attempt = getClothesOrderMutationAttempt('delete'"), 'clothes deletes bypass the atomic mutation API');
  assert(!built.includes('_thisPatch.finally(() => {'), 'PATCH-chain cleanup still creates an unhandled rejecting Promise');
  assert(built.includes('if (_activeLogin && _activeLogin.generation === _loginGeneration) return _activeLogin.promise;'), 'double-submit login guard is missing');
  assert(built.includes('if (_logoutInFlight || _serverAuthExpiryInFlight)'), 'login is not blocked while a prior session is closing');
  assert(built.includes('if (serverMode) await apiLogout();'), 'logout renders before the server logout request settles');
  assert(!built.includes('Promise.resolve(_flushP).then(() => apiLogout())'), 'delayed logout can still destroy a newly-created session');
  assert(built.includes('await handleServerAuthExpired(requestSessionIdentity);'), 'authenticated 401 responses do not trigger a secure local wipe');
  assert(built.includes('await wipeAuthenticatedServerDataFromClient();'), 'session expiry does not await the current cache-namespace wipe');
  assert(built.includes("backupScope: serverPartialSnapshot ? 'client-cache-partial' : 'full-local'"), 'server export is still mislabeled as a full backup');
  assert(built.includes('Users, wallet/subscription history, and audit logs were not restored.'), 'server import still claims a false full restore');
  assert(!built.includes('Server does not support atomic import yet — importing record by record'), 'unsafe non-transactional server import fallback remains');
  assert(built.includes("isAr ? 'استيراد الخادم معطّل' : 'Server Import Disabled'"), 'server-mode import is not explicitly disabled');
  assert(built.includes('delete exportState.clothesOrders;'), 'server report still exports transaction-controlled clothes orders');
  assert(built.includes("restorableCollections: serverPartialSnapshot\n      ? []"), 'server report still advertises restorable collections');
});

console.log('\n=== UNPAID DRIVER ADS: manual budget remains customer debt until paid ===');

check('driver budget normalization accepts positive money and rejects invalid debt values', () => {
  assert(sandbox.normalizeAdDriverBudgetUSD('42.345') === 42.35, 'driver budget was not rounded to cents');
  assert(sandbox.normalizeAdDriverBudgetUSD('0.01') === 0.01, 'smallest positive cent was rejected');
  for (const invalid of ['', 0, -1, 'not-a-number', NaN, Infinity, -Infinity]) {
    assert(sandbox.normalizeAdDriverBudgetUSD(invalid) === 0, `invalid driver budget was accepted: ${String(invalid)}`);
  }
});

check('server ad payload sends only the scoped Not Paid + Driver budget request', () => {
  const driver = sandbox.buildServerAdMutationData({
    customerId: 'customer_driver_budget',
    paymentStatus: 'not_paid',
    collectionMethod: 'driver',
    amountUSD: 42.345,
    amountLocal: 402.2775,
    driverBudgetUSD: 999,
    receiptAllocations: [],
    dueAllocations: []
  });
  assert(driver.driverBudgetUSD === 42.35, `driverBudgetUSD should be 42.35, got ${driver.driverBudgetUSD}`);
  assert(!Object.prototype.hasOwnProperty.call(driver, 'amountUSD'), 'derived amountUSD leaked into the server request');
  assert(!Object.prototype.hasOwnProperty.call(driver, 'amountLocal'), 'derived amountLocal leaked into the server request');

  const paid = sandbox.buildServerAdMutationData({
    customerId: 'customer_driver_budget',
    paymentStatus: 'paid',
    collectionMethod: '',
    amountUSD: 42.35,
    driverBudgetUSD: 42.35,
    receiptAllocations: [{ receiptId: 'receipt_paid_budget', amountUSD: 42.35 }]
  });
  assert(!Object.prototype.hasOwnProperty.call(paid, 'driverBudgetUSD'), 'paid ad can forge a manual driver budget');
  assert(!Object.prototype.hasOwnProperty.call(paid, 'amountUSD'), 'paid ad can forge its server-derived amount');

  const inShop = sandbox.buildServerAdMutationData({
    paymentStatus: 'not_paid',
    collectionMethod: 'in_shop',
    amountUSD: 42.35,
    driverBudgetUSD: 42.35
  });
  assert(!Object.prototype.hasOwnProperty.call(inShop, 'driverBudgetUSD'), 'non-driver unpaid ad received the driver-only budget field');
});

check('positive unpaid driver budget appears as negative customer balance without paid receipts', () => {
  S.language = 'en';
  S.defaultExchangeRate = 9.5;
  S.customers = [{ id: 'customer_debt', name: 'Debt Customer' }];
  S.pages = [];
  S.receipts = [{
    id: 'delivery_reference', recordType: 'receipt', customerId: 'customer_debt',
    amountUSD: 100, amountLocal: 950, exchangeRate: 9.5,
    status: 'Not Paid', isPaid: false, tempReceiptNo: 'D1',
    deliveryStatus: 'Needs Delivery', deliveryPersonId: 'driver_1', transfers: []
  }];
  S.ads = [{
    id: 'ad_driver_debt', recordType: 'ad', customerId: 'customer_debt',
    amountUSD: 40, amountLocal: 380, exchangeRate: 9.5,
    status: 'Active', paymentStatus: 'not_paid', collectionMethod: 'driver', isPaid: false,
    receiptId: 'delivery_reference', linkedDeliveryReceiptId: 'delivery_reference',
    receiptAllocations: [], dueAllocations: [], mergedPaidAllocations: [], dueAmountToUseUSD: 0
  }];

  const stats = sandbox.getCustomerStats('customer_debt');
  assert(stats.totalPaidUSD === 0, `unpaid delivery reference counted as paid: $${stats.totalPaidUSD}`);
  assert(stats.totalSpentUSD === 40, `positive ad budget should count as $40 spent, got $${stats.totalSpentUSD}`);
  assert(stats.balanceUSD === -40, `customer debt should be -$40, got $${stats.balanceUSD}`);
  assert(stats.balanceLYD === -380, `customer debt should be -380 LYD, got ${stats.balanceLYD}`);

  const due = sandbox.getDeliveryReceiptDueUsage('delivery_reference');
  assert(due.usedDueUSD === 0, `link-only driver ad consumed $${due.usedDueUSD} of receipt credit`);
  assert(due.remainingDueUSD === 100, `link-only driver ad left only $${due.remainingDueUSD} of $100 receipt credit`);
});

check('Not Paid + Driver toggle shows the budget field and Paid hides it without erasing input', () => {
  const withTrackedClasses = (hidden = false) => {
    const element = makeElement();
    const tokens = new Set(hidden ? ['hidden'] : []);
    element.classList = {
      add: (...names) => names.forEach(name => tokens.add(name)),
      remove: (...names) => names.forEach(name => tokens.delete(name)),
      toggle: (name, force) => {
        if (force === true) tokens.add(name);
        else if (force === false) tokens.delete(name);
        else if (tokens.has(name)) tokens.delete(name);
        else tokens.add(name);
      },
      contains: name => tokens.has(name)
    };
    return element;
  };

  const elements = new Map();
  for (const id of [
    'ad-pay-status-paid', 'ad-pay-status-not-paid', 'ad-pay-status-wont',
    'ad-collect-shop', 'ad-collect-driver'
  ]) elements.set(id, makeElement());
  elements.set('ad-payment-status', makeElement());
  elements.set('ad-collection-method', makeElement());
  elements.set('ad-not-paid-options', withTrackedClasses(true));
  elements.set('ad-receipt-funding-section', withTrackedClasses(false));
  elements.set('ad-unpaid-financial', withTrackedClasses(true));
  elements.set('ad-wont-pay-section', withTrackedClasses(true));
  elements.set('ad-collection-details', withTrackedClasses(true));
  elements.set('ad-driver-select', withTrackedClasses(true));
  elements.set('ad-driver-budget-section', withTrackedClasses(true));
  const budgetInput = makeElement();
  budgetInput.value = '40.00';
  elements.set('ad-driver-budget-usd', budgetInput);

  const originalGetElementById = sandbox.document.getElementById;
  const originalModalData = S.modalData;
  sandbox.document.getElementById = id => elements.get(id) || null;
  S.modalData = { id: 'ad_driver_debt', paymentStatus: 'not_paid', collectionMethod: 'driver', amountUSD: 40 };
  try {
    sandbox.setAdPaymentStatus('not_paid');
    sandbox.setAdCollectionMethod('driver');
    assert(elements.get('ad-payment-status').value === 'not_paid', 'Not Paid status was not stored');
    assert(elements.get('ad-collection-method').value === 'driver', 'Driver method was not stored');
    assert(!elements.get('ad-driver-budget-section').classList.contains('hidden'), 'driver budget field stayed hidden');

    sandbox.setAdPaymentStatus('paid');
    assert(elements.get('ad-driver-budget-section').classList.contains('hidden'), 'driver budget field stayed visible in Paid mode');
    assert(elements.get('ad-collection-method').value === '', 'Paid mode did not clear the driver collection method');
    assert(budgetInput.value === '40.00', 'switching status erased the typed budget before save');
  } finally {
    sandbox.document.getElementById = originalGetElementById;
    S.modalData = originalModalData;
  }
});

check('same delivered D receipt is available when its due-funded driver ad is settled', () => {
  const originalAds = S.ads;
  const originalReceipts = S.receipts;
  const originalModalData = S.modalData;
  const originalTempAdFunding = S.tempAdFunding;
  const originalGetElementById = sandbox.document.getElementById;
  const deliveryReceipt = {
    id: 'delivery_settlement_receipt', recordType: 'receipt', customerId: 'customer_debt',
    amountUSD: 40, amountLocal: 380, exchangeRate: 9.5,
    status: 'Paid', isPaid: true, tempReceiptNo: 'D2', finalReceiptNo: '13001',
    deliveryStatus: 'Delivered', deliveryPersonId: 'driver_1', transfers: []
  };
  const driverAd = {
    id: 'driver_due_settlement_ad', recordType: 'ad', customerId: 'customer_debt',
    amountUSD: 40, paymentStatus: 'not_paid', collectionMethod: 'driver',
    receiptAllocations: [],
    dueAllocations: [{ receiptId: deliveryReceipt.id, amountUSD: 40 }],
    linkedDeliveryReceiptId: deliveryReceipt.id
  };
  S.ads = [driverAd];
  S.receipts = [deliveryReceipt];
  S.modalData = { ...driverAd };
  S.tempAdFunding = { allocations: [] };
  try {
    const usage = sandbox.getReceiptUsageStats(deliveryReceipt);
    assert(usage.remainingUSD === 0, `saved due allocation should currently consume the receipt, got $${usage.remainingUSD} remaining`);
    const restored = sandbox.getEditingAdExistingAllocationUSD(deliveryReceipt.id);
    assert(restored === 40, `edit settlement did not add back its own $40 due allocation: $${restored}`);
    assert(usage.remainingUSD + restored === 40, 'same receipt is still unavailable for atomic Paid conversion');

    const elements = new Map();
    const fundingList = makeElement();
    elements.set('ad-funding-list', fundingList);
    const customerInput = makeElement();
    customerInput.value = 'customer_debt';
    elements.set('ad-customer-id', customerInput);
    elements.set('ad-page', makeElement());
    const paymentStatus = makeElement();
    paymentStatus.value = 'paid';
    elements.set('ad-payment-status', paymentStatus);
    elements.set('ad-funding-summary', makeElement());
    sandbox.document.getElementById = id => elements.get(id) || null;

    sandbox.renderAdFundingList();
    assert(
      fundingList.innerHTML.includes(`value="${deliveryReceipt.id}"`),
      'same delivered D receipt is missing from the Paid funding picker'
    );
  } finally {
    S.ads = originalAds;
    S.receipts = originalReceipts;
    S.modalData = originalModalData;
    S.tempAdFunding = originalTempAdFunding;
    sandbox.document.getElementById = originalGetElementById;
  }
});

check('local Paid conversion replaces the old D link with its paid funding receipt', () => {
  assert(sandbox.resolveAdPrimaryReceiptId({
    paymentStatus: 'not_paid', collectionMethod: 'driver',
    linkedDeliveryReceiptId: 'delivery_old', allocations: []
  }) === 'delivery_old', 'unpaid driver ad lost its delivery reference');
  assert(sandbox.resolveAdPrimaryReceiptId({
    paymentStatus: 'paid', collectionMethod: 'driver',
    linkedDeliveryReceiptId: 'delivery_old',
    allocations: [{ receiptId: 'paid_new', amountUSD: 40 }]
  }) === 'paid_new', 'Paid conversion kept the stale delivery receipt link');
  assert(sandbox.resolveAdPrimaryReceiptId({
    paymentStatus: 'not_paid', collectionMethod: 'in_shop',
    linkedDeliveryReceiptId: 'delivery_old', allocations: []
  }) === '', 'non-driver unpaid ad kept a phantom receipt link');
});

check('ad modal contains the beginner-facing manual budget control', () => {
  const modalSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
  const persistenceSource = fs.readFileSync(path.join(__dirname, '..', 'src', '06-persistence.js'), 'utf8');
  assert(modalSource.includes('id="ad-driver-budget-usd"'), 'Not Paid + Driver has no budget input');
  assert(modalSource.includes('This amount appears as customer debt until payment is recorded.'), 'budget field does not explain the resulting debt');
  assert(modalSource.includes('remaining += getEditingAdExistingAllocationUSD(receiptId);'), 'Paid conversion still blocks the ad\'s own due-funded receipt');
  assert(modalSource.includes('receiptId: resolveAdPrimaryReceiptId({'), 'local ad saves still keep a stale delivery receipt link');
  assert(modalSource.includes('const adPaymentState = getAdPaymentState(adData);'), 'historical payment aliases are not normalized when the ad modal opens');
  assert(modalSource.includes('id="ad-payment-status" value="${adPaymentState}"'), 'the ad modal keeps a non-canonical historical payment value');
  assert(modalSource.includes('const initialPaymentStatus = getAdPaymentState(adData);'), 'the opened ad form does not initialize from canonical payment state');
  assert(persistenceSource.includes("ad.fundingReceiptId || (!isLinkedUnpaidDebt ? ad.receiptId : '')"), 'linked unpaid receipts can still be migrated into false paid funding');
});

console.log('\n=== UNPAID IN-SHOP RECEIPTS: reserve debt now and settle later ===');

check('In Shop picker accepts only same-customer unpaid office receipts', () => {
  const base = {
    id: 'shop_due', customerId: 'shop_customer', status: 'Not Paid', isPaid: false,
    amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
    deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' }
  };
  assert(sandbox.isUnpaidShopReceipt(base, 'shop_customer') === true, 'valid unpaid office receipt was rejected');
  assert(sandbox.isUnpaidShopReceipt({ ...base, customerId: 'other' }, 'shop_customer') === false, 'other customer receipt was accepted');
  assert(sandbox.isUnpaidShopReceipt({ ...base, status: 'Paid', isPaid: true }, 'shop_customer') === false, 'paid receipt was accepted');
  assert(sandbox.isUnpaidShopReceipt({ ...base, tempReceiptNo: 'D9', deliveryStatus: 'Needs Delivery', statusDetail: { notPaidCollection: 'delivery' } }, 'shop_customer') === false, 'delivery receipt was accepted as In Shop');
  assert(sandbox.isUnpaidShopReceipt({ ...base, _deleted: true }, 'shop_customer') === false, 'deleted receipt was accepted');
});

check('unpaid shop receipt + linked ad is minus until receipt becomes Paid', () => {
  const original = {
    customers: S.customers, receipts: S.receipts, ads: S.ads,
    modalData: S.modalData, defaultExchangeRate: S.defaultExchangeRate
  };
  const receipt = {
    id: 'shop_debt_receipt', recordType: 'receipt', customerId: 'shop_debt_customer',
    amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
    status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
    statusDetail: { notPaidCollection: 'office' }, transfers: []
  };
  const ad = {
    id: 'shop_debt_ad', recordType: 'ad', customerId: 'shop_debt_customer',
    amountUSD: 30, amountLocal: 291, exchangeRate: 9.7, status: 'Active',
    paymentStatus: 'not_paid', collectionMethod: 'in_shop', isPaid: false,
    receiptId: receipt.id, receiptAllocations: [],
    dueAllocations: [{ receiptId: receipt.id, amountUSD: 30 }], dueAmountToUseUSD: 30
  };
  S.customers = [{ id: 'shop_debt_customer', name: 'Shop Debt Customer' }];
  S.receipts = [receipt];
  S.ads = [ad];
  S.defaultExchangeRate = 9.7;
  try {
    const before = sandbox.getCustomerStats('shop_debt_customer');
    assert(before.totalPaidUSD === 0, `unpaid receipt counted as paid: $${before.totalPaidUSD}`);
    assert(before.totalSpentUSD === 30, `shop ad spend should be $30, got $${before.totalSpentUSD}`);
    assert(before.balanceUSD === -30, `shop debt should be -$30, got $${before.balanceUSD}`);
    assert(before.balanceLYD === -291, `shop debt should be -291 LYD, got ${before.balanceLYD}`);
    const dueBefore = sandbox.getDeliveryReceiptDueUsage(receipt);
    assert(dueBefore.usedDueUSD === 30 && dueBefore.remainingDueUSD === 0, 'unpaid shop receipt capacity was not reserved exactly once');

    receipt.status = 'Paid';
    receipt.isPaid = true;
    const afterReceiptPaid = sandbox.getCustomerStats('shop_debt_customer');
    assert(afterReceiptPaid.balanceUSD === 0, `paid receipt should clear customer debt, got $${afterReceiptPaid.balanceUSD}`);
    const dueAfter = sandbox.getDeliveryReceiptDueUsage(receipt);
    assert(dueAfter.usedDueUSD === 30 && dueAfter.remainingDueUSD === 0, 'changing receipt Paid duplicated or released its committed $30');

    S.modalData = { ...ad };
    const addBack = sandbox.getEditingAdExistingAllocationUSD(receipt.id);
    assert(addBack === 30, `Paid conversion did not add back its own shop due row: $${addBack}`);
  } finally {
    S.customers = original.customers;
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.defaultExchangeRate = original.defaultExchangeRate;
  }
});

check('local In Shop debt links its due receipt and Paid conversion replaces it', () => {
  assert(sandbox.resolveAdPrimaryReceiptId({
    paymentStatus: 'not_paid', collectionMethod: 'in_shop', allocations: [],
    dueAllocations: [{ receiptId: 'shop_unpaid_receipt', amountUSD: 30 }]
  }) === 'shop_unpaid_receipt', 'unpaid shop ad lost its receipt link');
  assert(sandbox.resolveAdPrimaryReceiptId({
    paymentStatus: 'paid', collectionMethod: 'in_shop',
    allocations: [{ receiptId: 'shop_paid_receipt', amountUSD: 30 }],
    dueAllocations: [{ receiptId: 'shop_unpaid_receipt', amountUSD: 30 }]
  }) === 'shop_paid_receipt', 'Paid conversion kept the stale unpaid shop link');
});

check('mixed In Shop funding restores both pools and exposes the shortfall action', () => {
  const original = {
    modalData: S.modalData,
    tempMergeFunding: S.tempMergeFunding,
    tempMixedReceiptTargetUSD: S.tempMixedReceiptTargetUSD
  };
  const modalSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
  try {
    S.modalData = {
      id: 'mixed_shop_ad', paymentStatus: 'not_paid', collectionMethod: 'in_shop',
      amountUSD: 5,
      receiptAllocations: [{ receiptId: 'mixed_paid', amountUSD: 4.63 }],
      dueAllocations: [{ receiptId: 'mixed_unpaid', amountUSD: 0.37 }]
    };
    S.tempMergeFunding = null;
    sandbox.initMergeFunding();
    assert(S.tempMergeFunding.enabled === true, 'saved mixed paid rows were not enabled on edit');
    assert(S.tempMergeFunding.allocations.length === 1, 'saved paid portion was not restored');
    assert(S.tempMergeFunding.allocations[0].receiptId === 'mixed_paid', 'wrong paid receipt restored');
    assert(Number(S.tempMergeFunding.allocations[0].amountUSD) === 4.63, 'paid portion changed during edit initialization');
    assert(modalSource.includes('onclick="startAdMixedReceiptFunding()"'), 'Paid form has no beginner-facing unpaid shortfall action');
    assert(modalSource.includes("collectionMethod === 'driver' || collectionMethod === 'in_shop'"), 'save path does not capture paid rows for mixed In Shop funding');
  } finally {
    S.modalData = original.modalData;
    S.tempMergeFunding = original.tempMergeFunding;
    S.tempMixedReceiptTargetUSD = original.tempMixedReceiptTargetUSD;
  }
});

check('Paid shortfall action caps paid credit and prepares the exact unpaid difference', () => {
  const original = {
    customers: S.customers,
    receipts: S.receipts,
    ads: S.ads,
    modalData: S.modalData,
    tempAdFunding: S.tempAdFunding,
    tempMergeFunding: S.tempMergeFunding,
    tempMixedReceiptTargetUSD: S.tempMixedReceiptTargetUSD,
    getElementById: sandbox.document.getElementById,
    setPaymentStatus: sandbox.setAdPaymentStatus,
    setCollectionMethod: sandbox.setAdCollectionMethod,
    reflectMergeFundingUI: sandbox.reflectMergeFundingUI
  };
  let selectedStatus = '';
  let selectedCollection = '';
  try {
    S.customers = [{ id: 'mixed_customer', name: 'Mixed Customer' }];
    S.receipts = [
      {
        id: 'mixed_paid_receipt', customerId: 'mixed_customer', recordType: 'receipt',
        amountUSD: 4.63, amountLocal: 23.15, exchangeRate: 5,
        status: 'Paid', isPaid: true, deliveryStatus: 'Office', transfers: []
      },
      {
        id: 'mixed_unpaid_receipt', customerId: 'mixed_customer', recordType: 'receipt',
        amountUSD: 0.37, amountLocal: 1.85, exchangeRate: 5,
        status: 'Not Paid', isPaid: false, deliveryStatus: 'Office',
        statusDetail: { notPaidCollection: 'office' }, transfers: []
      }
    ];
    S.ads = [];
    S.modalData = null;
    S.tempAdFunding = {
      allocations: [{ receiptId: 'mixed_paid_receipt', amountUSD: 5 }]
    };
    S.tempMergeFunding = null;
    S.tempMixedReceiptTargetUSD = null;
    sandbox.document.getElementById = id => id === 'ad-customer-id'
      ? { value: 'mixed_customer' }
      : null;
    sandbox.setAdPaymentStatus = status => { selectedStatus = status; };
    sandbox.setAdCollectionMethod = method => { selectedCollection = method; };
    sandbox.reflectMergeFundingUI = () => {};

    sandbox.startAdMixedReceiptFunding();
    assert(selectedStatus === 'not_paid', 'shortfall flow did not visibly switch to Not Paid');
    assert(selectedCollection === 'in_shop', 'shortfall flow did not select In Shop collection');
    assert(S.tempMixedReceiptTargetUSD === 5, 'the intended $5 budget was lost');
    assert(S.tempMergeFunding.enabled === true, 'paid funding working state was not enabled');
    assert(S.tempMergeFunding.allocations.length === 1, 'paid receipt row was lost');
    assert(Number(S.tempMergeFunding.allocations[0].amountUSD) === 4.63, 'paid row was not capped to its real $4.63 balance');
    assert(S.tempAdFunding.allocations.length === 0, 'paid form rows leaked into the due allocation state');
  } finally {
    S.customers = original.customers;
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.tempAdFunding = original.tempAdFunding;
    S.tempMergeFunding = original.tempMergeFunding;
    S.tempMixedReceiptTargetUSD = original.tempMixedReceiptTargetUSD;
    sandbox.document.getElementById = original.getElementById;
    sandbox.setAdPaymentStatus = original.setPaymentStatus;
    sandbox.setAdCollectionMethod = original.setCollectionMethod;
    sandbox.reflectMergeFundingUI = original.reflectMergeFundingUI;
  }
});

const SAFE_RECEIPT_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SAFE_RECEIPT_JPEG = 'data:image/jpeg;base64,/9j/2Q==';

console.log('\n=== RECEIPT DEBT FILTERS + SAFE WHATSAPP DELIVERY SHARING ===');

check('new and historical receipt spellings use one debt classification', () => {
  const cases = [
    [{ status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, receiptType: 'DELIVERY_TEMP', deliveryStatus: 'Needs Delivery' }, 'not_paid', 'delivery'],
    [{ status: 'Pending', isPaid: true, tempReceiptNo: 'D17', deliveryStatus: 'In Progress' }, 'not_paid', 'delivery'],
    [{ status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'office' }, deliveryStatus: 'Office' }, 'not_paid', 'shop'],
    [{ status: 'Unpaid', isPaid: true, deliveryStatus: 'Office' }, 'not_paid', 'shop'],
    [{ status: 'Paid', isPaid: true, statusDetail: { paidCollection: 'delivery' }, deliveryStatus: 'Delivered', tempReceiptNo: 'D9' }, 'paid', 'none'],
    [{ status: 'Cancelled', isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'Canceled' }, 'canceled', 'none'],
    [{ status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'Canceled', tempReceiptNo: 'D18' }, 'not_paid', 'none'],
    [{ status: 'Not Paid', isPaid: false, receiptType: 'TRANSFER_IN', statusDetail: { notPaidCollection: 'delivery' } }, 'not_paid', 'none'],
    [{ status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, _deleted: true }, 'unknown', 'none']
  ];

  cases.forEach(([receipt, paymentState, debtType], index) => {
    assert(sandbox.getReceiptPaymentState(receipt) === paymentState, `case ${index + 1} payment state should be ${paymentState}`);
    assert(sandbox.getReceiptDebtType(receipt) === debtType, `case ${index + 1} debt type should be ${debtType}`);
  });
});

function seedReceiptDebtFilterState() {
  loginAs(ADMIN);
  S.language = 'en';
  S.defaultExchangeRate = 9.5;
  S.receiptSearch = '';
  S.receiptStatusFilter = 'all';
  S.receiptPaymentFilter = 'all';
  S.receiptDateFilter = 'all';
  S.receiptDebtFilter = 'all';
  S.receiptCollectedFilter = 'all';
  S.receiptSortBy = 'newest';
  S.ads = [];
  S.pages = [];
  S.customers = [
    { id: 'customer_new_delivery', name: 'New Delivery Debt' },
    { id: 'customer_legacy_delivery', name: 'Legacy Delivery Debt' },
    { id: 'customer_shop', name: 'Shop Debt' },
    { id: 'customer_paid', name: 'Paid Customer' }
  ];
  S.receipts = [
    {
      id: 'receipt_new_delivery', customerId: 'customer_new_delivery', status: 'Not Paid', isPaid: false,
      statusDetail: { notPaidCollection: 'delivery' }, receiptType: 'DELIVERY_TEMP', deliveryStatus: 'Needs Delivery',
      deliveryPersonId: 'u-driver', tempReceiptNo: 'D31', amountUSD: 10, amountLocal: 95,
      exchangeRate: 9.5, createdAt: '2026-07-17T12:00:00Z', payments: [], transfers: []
    },
    {
      id: 'receipt_legacy_delivery', customerId: 'customer_legacy_delivery', status: 'Pending', isPaid: true,
      tempReceiptNo: 'D12', deliveryStatus: 'In Progress', deliveryPersonId: 'u-driver',
      amountUSD: 20, amountLocal: 190, exchangeRate: 9.5, createdAt: '2026-07-16T12:00:00Z', payments: [], transfers: []
    },
    {
      id: 'receipt_shop', customerId: 'customer_shop', status: 'Unpaid', isPaid: true,
      statusDetail: { notPaidCollection: 'office' }, deliveryStatus: 'Office', serialNumber: 'B8',
      amountUSD: 30, amountLocal: 285, exchangeRate: 9.5, createdAt: '2026-07-15T12:00:00Z', payments: [], transfers: []
    },
    {
      id: 'receipt_paid', customerId: 'customer_paid', status: 'Paid', isPaid: true,
      statusDetail: { paidCollection: 'delivery' }, deliveryStatus: 'Delivered', finalReceiptNo: 'B9',
      amountUSD: 40, amountLocal: 380, exchangeRate: 9.5, createdAt: '2026-07-14T12:00:00Z', payments: [], transfers: []
    }
  ];
}

check('receipt view renders every debt filter and filters old and new records', () => {
  seedReceiptDebtFilterState();
  const allHtml = visible(sandbox.renderReceiptsView());
  for (const value of ['any-debt', 'delivery-debt', 'shop-debt', 'no-debt']) {
    assert(allHtml.includes(`option value="${value}"`), `missing ${value} filter option`);
  }

  S.receiptDebtFilter = 'delivery-debt';
  const deliveryHtml = visible(sandbox.renderReceiptsView());
  assert(deliveryHtml.includes('New Delivery Debt'), 'new delivery debt was filtered out');
  assert(deliveryHtml.includes('Legacy Delivery Debt'), 'historical delivery debt was filtered out');
  assert(!deliveryHtml.includes('Shop Debt'), 'shop debt leaked into delivery debt results');
  assert(!deliveryHtml.includes('Paid Customer'), 'paid receipt leaked into delivery debt results');

  S.receiptDebtFilter = 'shop-debt';
  const shopHtml = visible(sandbox.renderReceiptsView());
  assert(shopHtml.includes('Shop Debt'), 'shop debt was filtered out');
  assert(!shopHtml.includes('New Delivery Debt') && !shopHtml.includes('Legacy Delivery Debt'), 'delivery debt leaked into shop results');
  assert(!shopHtml.includes('Paid Customer'), 'paid receipt leaked into shop debt results');

  S.receiptDebtFilter = 'no-debt';
  const noDebtHtml = visible(sandbox.renderReceiptsView());
  assert(noDebtHtml.includes('Paid Customer'), 'paid receipt is missing from No Debt');
  assert(!noDebtHtml.includes('New Delivery Debt') && !noDebtHtml.includes('Legacy Delivery Debt') && !noDebtHtml.includes('Shop Debt'), 'a debt receipt leaked into No Debt');

  S.receiptDebtFilter = 'any-debt';
  const anyDebtHtml = visible(sandbox.renderReceiptsView());
  assert(anyDebtHtml.includes('New Delivery Debt') && anyDebtHtml.includes('Legacy Delivery Debt') && anyDebtHtml.includes('Shop Debt'), 'Any Debt omitted a debt source');
  assert(!anyDebtHtml.includes('Paid Customer'), 'Any Debt included a paid receipt');
});

function seedWhatsAppDeliveryState() {
  loginAs(ADMIN);
  S.language = 'en';
  S.defaultExchangeRate = 9.5;
  S.customers = [{
    id: 'customer_internal_secret', name: 'Amina Customer',
    phones: [{ number: '0912345678', label: 'Mobile' }]
  }];
  S.users = [
    ADMIN,
    { id: 'driver_internal_secret', name: 'Salem Driver', role: 'Delivery', permissions: {} },
    { id: 'creator_internal_secret', name: 'Aseel Creator', role: 'Employee', permissions: {} }
  ];
  const receipt = {
    id: 'receipt_internal_uuid_secret', recordType: 'receipt', customerId: 'customer_internal_secret',
    creatorId: 'creator_internal_secret', deliveryPersonId: 'driver_internal_secret',
    status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' },
    receiptType: 'DELIVERY_TEMP', deliveryStatus: 'Needs Delivery', tempReceiptNo: 'D42',
    amountUSD: 25, amountLocal: 237.5, debtAmountUSD: 25, debtAmountLocal: 237.5,
    exchangeRate: 9.5, quotedDeliveryFee: 15, deliveryPlaceName: 'Tripoli - Hay Al Andalus',
    deliveryInstructions: 'Call before arrival',
    photos: [SAFE_RECEIPT_PNG], receiptImage: SAFE_RECEIPT_JPEG
  };
  S.receipts = [receipt];
  return receipt;
}

check('delivery WhatsApp text includes dispatch fields but never internal ids or photos', () => {
  const receipt = seedWhatsAppDeliveryState();
  const message = sandbox.buildDeliveryReceiptWhatsAppMessage(receipt);
  for (const expected of [
    'Receipt: D42', 'Customer: Amina Customer', 'Phone: 0912345678',
    'Delivery place: Tripoli - Hay Al Andalus', 'Assigned driver: Salem Driver',
    'Amount to collect: 237.50 LYD ($25.00)', 'Delivery fee: 15.00 LYD',
    'Payment status: Not Paid', 'Instructions: Call before arrival', 'Created by: Aseel Creator'
  ]) {
    assert(message.includes(expected), `delivery message is missing: ${expected}`);
  }
  for (const secret of [receipt.id, receipt.customerId, receipt.deliveryPersonId, receipt.creatorId, 'data:image', SAFE_RECEIPT_PNG, SAFE_RECEIPT_JPEG]) {
    assert(!message.includes(secret), `delivery message leaked internal/photo data: ${secret}`);
  }
});

check('WhatsApp share URL preserves the complete message through encoding', () => {
  const message = 'Receipt: D42\nCustomer: Amina & Sons\nNote: 50% paid\nArabic: \u062a\u0648\u0635\u064a\u0644';
  const url = sandbox.buildWhatsAppShareLink(message);
  assert(url.startsWith('https://wa.me/?text='), 'share URL does not use the official wa.me text composer');
  assert(decodeURIComponent(url.slice('https://wa.me/?text='.length)) === message, 'share URL did not round-trip its text exactly');
  assert(sandbox.buildWhatsAppShareLink('   ') === '', 'blank messages should not create a WhatsApp URL');
});

check('only authorized viewers or the assigned driver can share customer contact data', () => {
  const receipt = seedWhatsAppDeliveryState();

  loginAs(employee({ deliveries: ['viewOwn'], customers: ['viewContacts'] }));
  receipt.deliveryPersonId = 'u-emp';
  assert(sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'assigned driver with contact permission cannot share their delivery');

  receipt.deliveryPersonId = 'another-driver';
  assert(!sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'unassigned driver can share another driver\'s delivery');

  receipt.deliveryPersonId = 'u-emp';
  loginAs(employee({ deliveries: ['viewOwn'] }));
  assert(!sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'driver without customer contact permission can export the phone/address');

  loginAs(employee({ receipts: ['view'], customers: ['viewContacts'] }));
  assert(sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'receipt viewer with contact permission cannot share a pending delivery');

  loginAs(employee({ receipts: ['viewOwn'], customers: ['viewContacts'] }));
  receipt.creatorId = 'u-emp';
  assert(sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'creator with viewOwn and contact permission cannot share their receipt');
  receipt.creatorId = 'another-user';
  assert(!sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'viewOwn user can share a receipt created by someone else');

  loginAs(ADMIN);
  receipt.creatorId = 'creator_internal_secret';
  receipt.deliveryStatus = 'Delivered';
  assert(!sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'completed delivery still exposes the pending-dispatch share action');
  receipt.deliveryStatus = 'Office';
  receipt.statusDetail = { notPaidCollection: 'office' };
  receipt.receiptType = '';
  receipt.tempReceiptNo = '';
  assert(!sandbox.canShareDeliveryReceiptToWhatsApp(receipt), 'shop debt exposes a delivery dispatch action');
});

console.log('\n=== RECEIPT PHOTOS: visible and safely clickable inside/outside the form ===');

check('receipt photo normalization supports current and legacy records without duplicates', () => {
  const sources = sandbox.getReceiptPhotoSources({
    photos: [SAFE_RECEIPT_PNG, SAFE_RECEIPT_PNG, 'https://cdn.example.com/receipt.webp'],
    receiptImage: SAFE_RECEIPT_JPEG
  });
  assert(sources.length === 3, `expected 3 unique safe photos, got ${sources.length}`);
  assert(sources[0] === SAFE_RECEIPT_PNG, 'photos[] is not the preferred current format');
  assert(sources[2] === SAFE_RECEIPT_JPEG, 'legacy receiptImage fallback is missing');
  assert(sandbox.getReceiptPhotoSources({ receiptImage: SAFE_RECEIPT_PNG })[0] === SAFE_RECEIPT_PNG, 'legacy-only photo disappeared');
  assert(sandbox.isSafeReceiptPhotoSource('/assets/receipt.png'), 'safe relative image path was rejected');
});

check('delivery completion preserves its proof photo when general attachments also exist', () => {
  const receipt = { photos: [SAFE_RECEIPT_PNG], receiptImage: SAFE_RECEIPT_JPEG };
  assert(sandbox.getDeliveryReceiptPhotoSource(receipt) === SAFE_RECEIPT_JPEG, 'delivery proof lost precedence over photos[0]');
  assert(sandbox.getDeliveryReceiptPhotoSource({ photos: [SAFE_RECEIPT_PNG] }) === SAFE_RECEIPT_PNG, 'delivery photo fallback to photos[] is missing');
});

check('receipt photo sources reject executable or attribute-injection values', () => {
  const unsafe = [
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
    'data:image/png;base64,AAAA\" onerror=\"alert(1)',
    'https://example.com/photo.png\" onerror=\"alert(1)',
    'http://example.com/photo.png',
    'blob:https://example.com/temporary'
  ];
  unsafe.forEach(source => assert(!sandbox.isSafeReceiptPhotoSource(source), `unsafe source accepted: ${source}`));
  assert(sandbox.getReceiptPhotoSources({ photos: unsafe, receiptImage: '' }).length === 0, 'unsafe photo reached the normalized list');
});

function setReceiptPhotoRenderState(photoFields) {
  loginAs(ADMIN);
  seedBusinessData();
  Object.assign(S, {
    language: 'en', defaultExchangeRate: 9.5,
    receiptSearch: '', receiptStatusFilter: 'all', receiptPaymentFilter: 'all',
    receiptDateFilter: 'all', receiptDebtFilter: 'all', receiptCollectedFilter: 'all', receiptSortBy: 'newest'
  });
  Object.assign(S.receipts[0], {
    amountLocal: 950, exchangeRate: 9.5, serialNumber: '12791',
    createdAt: '2026-07-15T16:44:50.000Z', payments: [], collected: false,
    ...photoFields
  });
  return visible(sandbox.renderReceiptsView());
}

check('receipt card shows an outside photo button without embedding the image', () => {
  const html = setReceiptPhotoRenderState({ photos: [SAFE_RECEIPT_PNG], receiptImage: '' });
  assert(!html.includes(`src="${SAFE_RECEIPT_PNG}"`), 'receipt card still embeds and decodes the full photo');
  assert(html.includes('data-receipt-id="r1"'), 'receipt id is not stored in a data attribute');
  assert(html.includes('openReceiptPhotoViewer(this.dataset.receiptId, 0)'), 'receipt card has no photo viewer action');
  assert(html.includes('Photos 1'), 'outside photo button does not show its count');
  assert(!html.includes("openReceiptPhotoViewer('r1'"), 'receipt id is still embedded in JavaScript source');
});

check('receipt card exposes a legacy receiptImage through the same outside button', () => {
  const html = setReceiptPhotoRenderState({ photos: [], receiptImage: SAFE_RECEIPT_JPEG });
  assert(!html.includes(`src="${SAFE_RECEIPT_JPEG}"`), 'legacy image is still embedded in the receipt list');
  assert(html.includes('View receipt photos (1)'), 'legacy image is not clickable');
  assert(html.includes('Photos 1'), 'legacy image count is missing from the outside button');
});

check('lightweight media summaries keep counts and never reuse stale photo bytes', () => {
  const full = { id: 'r1', _lastModified: 10, photos: [SAFE_RECEIPT_PNG] };
  const same = { id: 'r1', _lastModified: 10, _mediaOmitted: true, _photoCount: 1 };
  const newer = { id: 'r1', _lastModified: 11, _mediaOmitted: true, _photoCount: 1 };
  const reused = sandbox.mergeMatchingVersionInlineMedia('receipts', same, full);
  assert(reused.photos?.[0] === SAFE_RECEIPT_PNG, 'matching cached media was not reused');
  assert(sandbox.isEntityMediaHydrated('receipts', reused), 'matching media still looks unhydrated');
  const invalidated = sandbox.mergeMatchingVersionInlineMedia('receipts', newer, full);
  assert(!Object.prototype.hasOwnProperty.call(invalidated, 'photos'), 'newer summary reused stale media');
  assert(!sandbox.isEntityMediaHydrated('receipts', invalidated), 'newer summary incorrectly looks hydrated');
  assert(sandbox.getReceiptPhotoCount(invalidated) === 1, 'photo-count hint disappeared');
  const mutationEcho = sandbox.mergeMutationInlineMedia('receipts', newer, { photos: [SAFE_RECEIPT_JPEG] });
  assert(mutationEcho.photos?.[0] === SAFE_RECEIPT_JPEG, 'lightweight mutation response lost known local media');
  assert(sandbox.isEntityMediaHydrated('receipts', mutationEcho), 'reattached mutation media still looks omitted');
});

check('ad photo normalization and outside button support current and legacy fields', () => {
  const adSources = sandbox.getAdPhotoSources({
    adPhotos: [SAFE_RECEIPT_PNG, SAFE_RECEIPT_PNG],
    photos: [SAFE_RECEIPT_JPEG, 'javascript:alert(1)']
  });
  assert(adSources.length === 2, `expected two safe unique ad photos, got ${adSources.length}`);
  loginAs(ADMIN);
  seedBusinessData();
  S.language = 'en';
  S.adSearch = '';
  S.adFilters = {};
  S.pages = [{ id: 'p1', name: 'Page One', category: '', customerIds: ['c1'] }];
  Object.assign(S.ads[0], {
    pageId: 'p1', recordType: 'ad', status: 'Active', startDate: '2026-07-15T00:00:00Z',
    endDate: '2026-07-20T00:00:00Z', exchangeRate: 9.5, amountLocal: 475,
    adPhotos: [SAFE_RECEIPT_PNG]
  });
  const html = visible(sandbox.renderAdsView());
  assert(html.includes('data-ad-id="a1"'), 'ad photo button does not use a safe data id');
  assert(html.includes('data-action="view-ad-photos"'), 'ad photo viewer is not exposed as a clear outside action');
  assert(html.includes('openAdPhotoViewer(this.dataset.adId, 0, this)'), 'ad has no outside photo viewer action or loading trigger');
  assert(html.includes('View Photos (1)'), 'ad outside photo button or count is missing');
  assert(html.includes('ad-photo-view-button'), 'ad photo action is still an easy-to-miss icon/link');
  assert(!html.includes(`src="${SAFE_RECEIPT_PNG}"`), 'ads list embeds the full photo body');

  delete S.ads[0].adPhotos;
  delete S.ads[0].photos;
  S.ads[0]._mediaOmitted = true;
  S.ads[0]._photoCount = 2;
  const leanHtml = visible(sandbox.renderAdsView());
  assert(leanHtml.includes('data-action="view-ad-photos"'), 'lean production ad summary lost its photo button');
  assert(leanHtml.includes('View Photos (2)'), 'lean production ad summary lost its photo count');
  assert(!leanHtml.includes('src="data:image/'), 'lean ads list unexpectedly embeds image bytes');

  loginAs(employee({ ads: ['view'] }));
  const deniedHtml = visible(sandbox.renderAdsView());
  assert(!deniedHtml.includes('openAdPhotoViewer('), 'ads.viewPhotos permission is not gating the outside button');
});

check('ad rows show their creator and color unpaid debt red', () => {
  loginAs(ADMIN);
  seedBusinessData();
  S.language = 'en';
  S.adSearch = '';
  S.adFilters = {};
  S.pages = [{ id: 'p1', name: 'Page One', category: '', customerIds: ['c1'] }];
  Object.assign(S.ads[0], {
    pageId: 'p1', recordType: 'ad', status: 'Active', startDate: '2026-07-15T00:00:00Z',
    endDate: '2026-07-20T00:00:00Z', exchangeRate: 9.5, amountLocal: 475,
    paymentStatus: 'not_paid', isPaid: false, createdBy: 'u-admin', creatorId: 'u-other'
  });

  const unpaidHtml = visible(sandbox.renderAdsView());
  assert(/data-role="ad-creator"[\s\S]*?Created by:[\s\S]*?>Bashir<\/span>/.test(unpaidHtml), 'creator label and name are not together in the outside ad row');
  assert(!unpaidHtml.includes('Created by: <span class="font-semibold text-slate-700 dark:text-slate-200">Abdu'), 'legacy creatorId overrode canonical createdBy metadata');
  assert(unpaidHtml.includes('data-payment-state="unpaid"'), 'unpaid ad is not marked as debt in the table');
  assert(/class="[^"]*text-rose-600[^"]*" data-label="Amount" data-payment-state="unpaid"/.test(unpaidHtml), 'unpaid USD amount is not red');
  assert(/class="[^"]*text-rose-600[^"]*" data-label="Local"/.test(unpaidHtml), 'unpaid LYD amount is not red');
  assert(unpaidHtml.includes('Unpaid debt'), 'red amount has no beginner-facing debt label');

  S.ads[0].paymentStatus = 'Not Paid';
  S.ads[0].isPaid = true;
  S.serverMode = true;
  const historicalDebtHtml = visible(sandbox.renderAdsView());
  assert(historicalDebtHtml.includes('data-payment-state="unpaid"'), 'historical Not Paid alias is not red in the real table');
  assert(!historicalDebtHtml.includes(`manageTopUps('${S.ads[0].id}')`), 'server UI offers paid-funds top-up on historical unpaid debt');
  S.serverMode = false;

  delete S.ads[0].createdBy;
  const legacyCreatorHtml = visible(sandbox.renderAdsView());
  assert(legacyCreatorHtml.includes('Created by: <span class="font-semibold text-slate-700 dark:text-slate-200">Abdu'), 'legacy creatorId fallback is not displayed');

  S.ads[0].createdBy = 'u-admin';
  S.ads[0].paymentStatus = '';
  S.ads[0].isPaid = false;
  const blankStatusHtml = visible(sandbox.renderAdsView());
  assert(blankStatusHtml.includes('data-payment-state="unpaid"'), 'blank status with isPaid=false incorrectly looks paid');

  S.ads[0].paymentStatus = 'wont_pay';
  const wontPayHtml = visible(sandbox.renderAdsView());
  assert(wontPayHtml.includes('data-payment-state="unpaid"'), "Won't Pay amount incorrectly looks paid");

  S.ads[0].paymentStatus = 'paid';
  delete S.ads[0].isPaid;
  const paidHtml = visible(sandbox.renderAdsView());
  assert(paidHtml.includes('data-payment-state="paid"'), 'paid ad is not marked paid in the table');
  assert(/class="[^"]*text-emerald-600[^"]*" data-label="Amount" data-payment-state="paid"/.test(paidHtml), 'paid USD amount is not green');

  delete S.ads[0].paymentStatus;
  delete S.ads[0].isPaid;
  const oldestPaidHtml = visible(sandbox.renderAdsView());
  assert(oldestPaidHtml.includes('data-payment-state="paid"'), 'pre-unpaid historical ad without payment fields is not kept paid');
});

check('historical ad payment spellings use one authoritative state', () => {
  const cases = [
    [{ paymentStatus: 'paid', isPaid: false }, 'paid'],
    [{ paymentStatus: 'Not Paid', isPaid: true }, 'not_paid'],
    [{ paymentStatus: 'not-paid', isPaid: true }, 'not_paid'],
    [{ paymentStatus: 'unpaid', isPaid: true }, 'not_paid'],
    [{ paymentStatus: "won't pay", isPaid: true }, 'wont_pay'],
    [{ paymentStatus: 'Won\u2019t Pay', isPaid: true }, 'wont_pay'],
    [{ paymentStatus: '', isPaid: false }, 'not_paid'],
    [{ paymentStatus: '', isPaid: true }, 'paid'],
    [{}, 'paid']
  ];
  cases.forEach(([ad, expected]) => {
    assert(
      sandbox.getAdPaymentState(ad) === expected,
      `${JSON.stringify(ad)} should normalize to ${expected}`
    );
  });

  loginAs(ADMIN);
  seedBusinessData();
  S.ads = [
    { id: 'paid-ad', customerId: 'c1', recordType: 'ad', paymentStatus: 'paid', isPaid: false },
    { id: 'debt-ad', customerId: 'c1', recordType: 'ad', paymentStatus: 'Not Paid', isPaid: true }
  ];
  S.adFilters = { payment: 'paid' };
  assert(sandbox.getFilteredAds().map(ad => ad.id).join(',') === 'paid-ad', 'Paid filter disagrees with the amount color rule');
  S.adFilters = { payment: 'not_paid' };
  assert(sandbox.getFilteredAds().map(ad => ad.id).join(',') === 'debt-ad', 'Not Paid filter disagrees with the amount color rule');
});

check('historical unpaid aliases survive migration without becoming paid funding', () => {
  const original = {
    ads: S.ads,
    receipts: S.receipts,
    customers: S.customers,
    pages: S.pages,
    defaultExchangeRate: S.defaultExchangeRate
  };
  const originalSaveState = sandbox.saveState;
  const legacy = {
    id: 'legacy_unpaid_alias', recordType: 'ad', customerId: 'legacy_customer',
    amountUSD: 30, amountLocal: 291, exchangeRate: 9.7, status: 'Active',
    paymentStatus: 'Not Paid', isPaid: true, collectionMethod: 'driver',
    receiptId: 'legacy_due_receipt', linkedDeliveryReceiptId: 'legacy_due_receipt',
    dueAmountToUseUSD: 30
  };
  S.ads = [legacy];
  S.receipts = [];
  S.customers = [{ id: 'legacy_customer', name: 'Legacy Customer' }];
  S.pages = [];
  S.defaultExchangeRate = 9.7;
  sandbox.saveState = () => {};
  try {
    sandbox.migrateOldDataFormats();
    assert(Array.isArray(legacy.receiptAllocations) && legacy.receiptAllocations.length === 0, 'legacy debt receipt was converted into paid funding');
    assert(legacy.dueAllocations?.length === 1, 'legacy due mirror was not materialized for the unpaid alias');
    assert(legacy.dueAllocations[0].receiptId === 'legacy_due_receipt', 'legacy due receipt identity was lost');
    assert(legacy.dueAllocations[0].amountUSD === 30, 'legacy due amount changed during migration');
  } finally {
    sandbox.saveState = originalSaveState;
    S.ads = original.ads;
    S.receipts = original.receipts;
    S.customers = original.customers;
    S.pages = original.pages;
    S.defaultExchangeRate = original.defaultExchangeRate;
  }
});

check('historical unpaid aliases open and save through canonical ad debt paths', () => {
  const original = {
    ads: S.ads,
    modalData: S.modalData,
    tempAdFunding: S.tempAdFunding,
    defaultExchangeRate: S.defaultExchangeRate
  };
  const due = { receiptId: 'legacy_shop_due', amountUSD: 30 };
  const paid = { receiptId: 'wrong_paid_source', amountUSD: 30 };
  const legacyShop = {
    id: 'legacy_shop_alias', paymentStatus: 'not-paid', isPaid: true,
    collectionMethod: 'in_shop', amountUSD: 30,
    receiptAllocations: [paid], dueAllocations: [due], receiptId: due.receiptId
  };
  S.ads = [legacyShop];
  S.modalData = { ...legacyShop };
  S.defaultExchangeRate = 9.7;
  try {
    sandbox.initAdFunding(legacyShop);
    assert(S.tempAdFunding.allocations.length === 1, 'legacy shop debt did not open with exactly one allocation');
    assert(S.tempAdFunding.allocations[0].receiptId === due.receiptId, 'legacy shop debt opened its paid rows instead of due rows');
    assert(sandbox.getEditingAdExistingAllocationUSD(due.receiptId) === 30, 'legacy alias did not restore its own due allocation while editing');
    assert(sandbox.getOriginalUnpaidAdBudgetUSD() === 30, 'legacy alias lost its saved unpaid budget');
    assert(sandbox.resolveAdPrimaryReceiptId({
      paymentStatus: 'Not Paid', collectionMethod: 'in_shop',
      allocations: [paid], dueAllocations: [due]
    }) === due.receiptId, 'legacy alias resolved to the wrong primary receipt');

    const request = sandbox.buildServerAdMutationData({
      paymentStatus: 'unpaid', collectionMethod: 'driver', amountUSD: 30,
      receiptAllocations: [], dueAllocations: []
    });
    assert(request.paymentStatus === 'not_paid', 'legacy alias was not canonicalized before server save');
    assert(request.driverBudgetUSD === 30, 'legacy unpaid driver budget was dropped before server save');
    const partial = sandbox.buildServerAdMutationData({ topUps: [] });
    assert(!Object.prototype.hasOwnProperty.call(partial, 'paymentStatus'), 'partial mutation invented a Paid status');
  } finally {
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.tempAdFunding = original.tempAdFunding;
    S.defaultExchangeRate = original.defaultExchangeRate;
  }
});

check('saved ad photos cannot be replaced without permission to view them', () => {
  S.activeModal = 'ad';
  S.modalData = { id: 'a1', _mediaOmitted: true, _photoCount: 2 };
  loginAs(employee({ ads: ['view', 'edit', 'uploadPhotos'] }));
  assert(!sandbox.canModifyAdPhotosInCurrentModal(), 'upload-only editor can replace unseen saved photos');

  loginAs(employee({ ads: ['view', 'edit', 'viewPhotos', 'uploadPhotos'] }));
  assert(sandbox.canModifyAdPhotosInCurrentModal(), 'fully authorized editor cannot manage photos');

  S.modalData = {};
  loginAs(employee({ ads: ['view', 'add', 'uploadPhotos'] }));
  assert(sandbox.canModifyAdPhotosInCurrentModal(), 'new ad upload is incorrectly blocked when no saved photos exist');
  S.activeModal = null;
  S.modalData = null;
});

check('audit logs omit all inline photo bodies', () => {
  const redacted = sandbox.redactSensitive({
    old: { photos: [SAFE_RECEIPT_PNG], nested: ['data:image/png;base64,BBBB'] },
    new: { adPhotos: [SAFE_RECEIPT_JPEG], receiptImage: SAFE_RECEIPT_PNG }
  });
  const encoded = JSON.stringify(redacted);
  assert(!encoded.includes('data:image'), 'audit metadata still contains an inline image');
  assert(encoded.includes('media omitted'), 'audit metadata gives no media-redaction marker');
  assert(encoded.length < 500, `redacted audit metadata is unexpectedly large (${encoded.length})`);
});

check('unchanged edits omit photo payloads and ad uploads have receipt-grade safety', () => {
  const formsSource = fs.readFileSync(path.join(__dirname, '..', 'src', '14-forms.js'), 'utf8');
  const modalSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
  assert(formsSource.includes('delete receipt.photos;'), 'unchanged receipt edits still upload photos');
  assert(modalSource.includes('delete adUpdates.adPhotos;'), 'unchanged ad edits still upload photos');
  assert(formsSource.includes('uploadGeneration !== _adPhotoUploadGeneration'), 'late ad upload callback can leak into another modal');
  assert(formsSource.includes('Math.max(6 - state.tempAdPhotos.length, 0)'), 'ads have no six-photo cap');
  assert(formsSource.includes('openPendingAdPhotoViewer(${idx})'), 'pending ad thumbnails cannot open full-size');
  assert(formsSource.includes('MAX_ENTITY_PHOTO_PAYLOAD_CHARS'), 'photo uploads do not enforce a total request-size budget');
  assert(formsSource.includes('_compressPhotosForUpload(files, concurrency = 2)'), 'large photo batches are not concurrency-bounded');
  assert(modalSource.includes('state.tempReceiptPhotosDirty = false;'), 'receipt photo dirty tracking is not initialized');
  const persistenceSource = fs.readFileSync(path.join(__dirname, '..', 'src', '06-persistence.js'), 'utf8');
  assert(persistenceSource.includes('delete toSave.tempReceiptPhotos;'), 'unsaved receipt photos are copied into localStorage');
});

check('receipt form thumbnails can be viewed full-size and still removed', () => {
  const originalGetElementById = sandbox.document.getElementById;
  const previews = makeElement();
  sandbox.document.getElementById = id => (id === 'receipt-photo-previews' ? previews : null);
  S.language = 'en';
  S.tempReceiptPhotos = [SAFE_RECEIPT_PNG];
  sandbox.renderReceiptPhotoPreviews();
  sandbox.document.getElementById = originalGetElementById;
  assert(previews.innerHTML.includes('openPendingReceiptPhotoViewer(0)'), 'form thumbnail has no full-size action');
  assert(previews.innerHTML.includes('removeReceiptPhoto(0)'), 'form thumbnail lost its remove action');
});

check('closing the full-size viewer preserves the open receipt and unsaved photos', () => {
  const originalAppendChild = sandbox.document.body.appendChild;
  let appendedViewer = null;
  sandbox.document.body.appendChild = element => { appendedViewer = element; };
  S.activeModal = 'receipt';
  S.tempReceiptPhotos = [SAFE_RECEIPT_PNG];
  sandbox.openPendingReceiptPhotoViewer(0);
  assert(appendedViewer?.id === 'receipt-photo-viewer', 'full-size viewer was not created');
  assert(appendedViewer.innerHTML.includes('object-contain'), 'viewer does not preserve the whole image');
  sandbox.closeReceiptPhotoViewer();
  sandbox.document.body.appendChild = originalAppendChild;
  assert(S.activeModal === 'receipt', 'closing a photo closed the receipt form');
  assert(S.tempReceiptPhotos.length === 1 && S.tempReceiptPhotos[0] === SAFE_RECEIPT_PNG, 'closing a photo erased unsaved receipt photos');
});

check('cancelled receipt forms invalidate pending photo compression and clear temporary photos', () => {
  const formsSource = fs.readFileSync(path.join(__dirname, '..', 'src', '14-forms.js'), 'utf8');
  const modalSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
  assert(formsSource.includes('uploadGeneration !== _receiptPhotoUploadGeneration'), 'late upload callback is not invalidated');
  assert(formsSource.includes('state.tempReceiptPhotos.length >= 6'), 'async upload can exceed the six-photo cap');
  assert(modalSource.includes('state.tempReceiptPhotos = [];'), 'cancel does not clear temporary receipt photos');
  assert(modalSource.includes('_receiptPhotoUploadGeneration++;'), 'cancel/open does not advance the receipt upload generation');
});

check('Ads Studio customer preset is isolated from internal business data', () => {
  const preset = vm.runInContext('PERMISSION_TEMPLATES.adsStudioCustomer.permissions', sandbox);
  assert(Array.isArray(preset.adCampaignRequests), 'Ads Studio customer has no campaign permissions');
  assert(preset.adCampaignRequests.includes('viewOwn') && preset.adCampaignRequests.includes('submitOwn'), 'customer cannot view and submit own campaigns');
  for (const forbidden of ['ads', 'receipts', 'customers', 'pages', 'walletTransactions']) {
    assert(!Object.prototype.hasOwnProperty.call(preset, forbidden), `customer preset leaks ${forbidden}`);
  }
});

check('Ads Studio reviewers cannot edit or submit customer drafts', () => {
  const preset = vm.runInContext('PERMISSION_TEMPLATES.adsStudioReviewer.permissions', sandbox);
  const actions = preset.adCampaignRequests || [];
  assert(actions.includes('view') && actions.includes('review'), 'reviewer cannot inspect and review submitted campaigns');
  for (const forbidden of ['add', 'edit', 'editOwn', 'submit', 'submitOwn', 'delete', 'deleteOwn']) {
    assert(!actions.includes(forbidden), `reviewer can ${forbidden} a customer campaign`);
  }
  const reviewer = employee({ adCampaignRequests: ['view', 'review'] });
  reviewer.subscriptions = [];
  loginAs(reviewer);
  assert(sandbox.adsStudioCanUse(), 'staff reviewer was incorrectly forced to buy a customer subscription');
  assert(sandbox.getAuthorizedServerSyncCollections(reviewer).includes('adCampaignRequests'), 'review queue was excluded from reviewer live sync');
});

check('Ads Studio session reset destroys drafts and invalidates pending photos', () => {
  vm.runInContext(`
    _adsStudioActiveTab = 'builder';
    _adsStudioWizardStep = 4;
    _adsStudioEditingId = 'campaign-secret';
    _adsStudioDraft = { name: 'Private unfinished campaign', creativeImages: ['data:image/png;base64,secret'] };
    _adsStudioSearch = 'private';
    _adsStudioConfirmationChecked = true;
    _adsStudioReviewNotes['private-campaign'] = 'Private reviewer note';
  `, sandbox);
  const before = vm.runInContext('_adsStudioPhotoToken', sandbox);
  sandbox.resetAdsStudioSessionState();
  assert(vm.runInContext('_adsStudioDraft', sandbox) === null, 'draft survived session reset');
  assert(vm.runInContext('_adsStudioEditingId', sandbox) === '', 'editing campaign survived session reset');
  assert(vm.runInContext('_adsStudioActiveTab', sandbox) === 'dashboard', 'private tab state survived session reset');
  assert(vm.runInContext('_adsStudioPhotoToken', sandbox) === before + 1, 'pending photo compression was not invalidated');
  assert(vm.runInContext('_adsStudioConfirmationChecked', sandbox) === false, 'builder confirmation survived session reset');
  assert(vm.runInContext("Object.keys(_adsStudioReviewNotes).length", sandbox) === 0, 'review textarea text survived session reset');
  const liveSyncSource = fs.readFileSync(path.join(__dirname, '..', 'src', '10-live-sync.js'), 'utf8');
  const helperSource = fs.readFileSync(path.join(__dirname, '..', 'src', '13-filters-helpers.js'), 'utf8');
  assert(liveSyncSource.includes('closeReceiptPhotoViewer(false)'), 'logout can leave a full-screen customer photo visible');
  assert(helperSource.includes('function closeReceiptPhotoViewer(restoreFocus = true)'), 'auth reset cannot close photos without focusing an old-session element');
});

check('Ads Studio reviewer cache scope and visible records exclude unfinished customer work', () => {
  const reviewer = employee({ adCampaignRequests: ['view', 'review'] });
  loginAs(reviewer);
  S.adCampaignRequests = [
    { id: 'review-draft', status: 'Draft', createdBy: 'customer-1' },
    { id: 'review-changes', status: 'Changes Requested', createdBy: 'customer-1' },
    { id: 'review-submitted', status: 'Submitted', createdBy: 'customer-1' },
    { id: 'review-approved', status: 'Approved', createdBy: 'customer-1' },
    { id: 'review-rejected', status: 'Rejected', createdBy: 'customer-1' }
  ];
  const statuses = sandbox.getVisibleAdsStudioCampaigns().map(item => item.status).sort();
  assert(JSON.stringify(statuses) === JSON.stringify(['Approved', 'Rejected', 'Submitted']), `reviewer saw wrong statuses: ${statuses.join(', ')}`);
  assert(sandbox.getServerCollectionVisibilityScope(reviewer, 'adCampaignRequests') === 'review', 'review permission reused the broader all-data cache scope');
  const formerFullViewer = employee({ adCampaignRequests: ['view'] });
  assert(sandbox.getServerVisibilityScopeChanges(formerFullViewer, reviewer).includes('adCampaignRequests'), 'view-all to reviewer did not trigger a cache purge');
});

check('Ads Studio card actions require the exact edit, submit and delete permission', () => {
  S.language = 'en';
  const ownId = 'u-emp';
  const base = { id: 'campaign-actions', name: 'Permissions', status: 'Draft', createdBy: ownId, platforms: ['facebook'] };

  loginAs(employee({ adCampaignRequests: ['viewOwn'] }));
  let html = visible(sandbox.renderAdsStudioCampaignCard(base));
  assert(!html.includes('>Edit</button>') && !html.includes('>Submit</button>') && !html.includes('>Delete</button>'), 'mere ownership exposed mutation actions');

  loginAs(employee({ adCampaignRequests: ['view', 'edit', 'submitOwn'] }));
  html = visible(sandbox.renderAdsStudioCampaignCard({ ...base, createdBy: 'another-customer' }));
  assert(html.includes('>Edit</button>'), 'edit-all permission did not expose edit');
  assert(!html.includes('>Submit</button>'), 'submitOwn exposed submit on another customer campaign');

  loginAs(employee({ adCampaignRequests: ['viewOwn', 'editOwn', 'submitOwn', 'deleteOwn'] }));
  html = visible(sandbox.renderAdsStudioCampaignCard(base));
  assert(html.includes('>Edit</button>') && html.includes('>Submit</button>') && html.includes('>Delete</button>'), 'owner mutation permissions did not expose their actions');
  const terminal = visible(sandbox.renderAdsStudioCampaignCard({ ...base, status: 'Approved' }));
  assert(terminal.includes('>Archive</button>') && !terminal.includes('>Submit</button>'), 'terminal owner campaign did not expose archive-only workflow');
});

check('Ads Studio accepts only PNG JPEG or WebP creatives and requires one before submit', () => {
  assert(sandbox.isSafeAdsStudioCreativeSource(SAFE_RECEIPT_PNG), 'safe PNG was rejected');
  assert(!sandbox.isSafeAdsStudioCreativeSource('data:image/gif;base64,R0lGODlh'), 'GIF creative was accepted');
  clearNotes();
  const input = { files: [{ type: 'image/gif', name: 'animated.gif' }], value: 'selected' };
  sandbox.onAdsStudioCreativeSelected(input);
  assert(input.value === '', 'unsupported file input was not reset');
  assert(lastNote()?.k === 'warning' && /PNG|JPEG|WebP/.test(lastNote()?.m || ''), 'unsupported creative did not show a clear format warning');
  const draft = {
    name: 'Photo requirement', objective: 'messages', platforms: ['facebook'], pageName: 'Page',
    primaryText: 'Copy', destination: '+218900000000', creativeImages: ['data:image/gif;base64,R0lGODlh']
  };
  assert(sandbox.adsStudioValidateStep(2, draft).some(message => /PNG|JPEG|WebP/.test(message)), 'creative requirement is missing from client validation');
  draft.creativeImages = [SAFE_RECEIPT_PNG];
  assert(!sandbox.adsStudioValidateStep(2, draft).some(message => /PNG|JPEG|WebP/.test(message)), 'safe creative did not satisfy validation');
  assert(sandbox.adsStudioDataUrlDecodedBytes(SAFE_RECEIPT_PNG) > 0, 'decoded creative byte estimator returned zero');
  assert(sandbox.adsStudioIsValidDestination('https://wa.me/218900000000'), 'HTTPS destination was rejected');
  assert(sandbox.adsStudioIsValidDestination('+218 90 000 0000'), 'international phone destination was rejected');
  assert(!sandbox.adsStudioIsValidDestination('http://unsafe.example.com'), 'insecure HTTP destination was accepted');
});

check('Ads Studio preserves live form state but escapes retained review history', () => {
  const reviewer = employee({ adCampaignRequests: ['view', 'review'] });
  loginAs(reviewer);
  S.language = 'en';
  S.adCampaignRequests = [{ id: 'campaign-note', name: 'Queued', status: 'Submitted', createdBy: 'customer-1' }];
  sandbox.setAdsStudioReviewNote('campaign-note', 'Keep this through sync');
  let html = visible(sandbox.renderAdsStudioReviewQueue());
  assert(html.includes('Keep this through sync'), 'review textarea text disappeared on rerender');

  vm.runInContext('_adsStudioConfirmationChecked = true; _adsStudioDraft = newAdsStudioDraft(); _adsStudioWizardStep = 5;', sandbox);
  html = visible(sandbox.renderAdsStudioReviewStep());
  assert(/id="ads-studio-confirm-accurate"[^>]*checked/.test(html), 'builder confirmation disappeared on rerender');

  const malicious = visible(sandbox.renderAdsStudioCampaignCard({
    id: 'campaign-history', name: 'History', status: 'Approved', createdBy: 'customer-1',
    reviewHistory: [{ decision: 'Approved', reviewedAt: '2026-07-17T12:00:00Z', note: '<img src=x onerror=alert(1)>' }]
  }));
  assert(!malicious.includes('<img src=x'), 'review history rendered executable markup');
  assert(malicious.includes('&lt;img'), 'escaped review history was not rendered');
});

check('Ads Studio media hydration is session-only and bounded', () => {
  for (let i = 0; i < 6; i++) sandbox.cacheTransientAdCampaignMedia(`session|adCampaignRequests|${i}`, { id: String(i), creativeImages: [SAFE_RECEIPT_PNG] });
  assert(vm.runInContext('_transientAdCampaignMedia.size', sandbox) === 3, 'transient creative cache grew beyond its bound');
  sandbox.clearTransientEntityMediaCache('adCampaignRequests');
  assert(vm.runInContext('_transientAdCampaignMedia.size', sandbox) === 0, 'auth/media purge retained creative bytes');
  const lean = sandbox.makeLightweightMediaRecord('adCampaignRequests', { id: 'lean-campaign', creativeImages: [SAFE_RECEIPT_PNG] });
  assert(!Object.prototype.hasOwnProperty.call(lean, 'creativeImages'), 'lean campaign record retained inline creative bytes');
  assert(lean._mediaOmitted === true && lean._photoCount === 1, 'lean campaign record lost its safe photo-count hint');
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', '09-api-auth.js'), 'utf8');
  const dataSource = fs.readFileSync(path.join(__dirname, '..', 'src', '08-data-audit.js'), 'utf8');
  assert(apiSource.includes("if (name === 'adCampaignRequests')") && apiSource.includes('cacheTransientAdCampaignMedia(key, full);'), 'campaign hydration is not routed to transient memory');
  assert(apiSource.includes("String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord"), 'campaign mutations still reattach inline creative bytes');
  assert(dataSource.includes("collectionName === 'adCampaignRequests'") && dataSource.includes('makeLightweightMediaRecord(collectionName, cleanRecord)'), 'optimistic draft create still persists creative bytes');
});

check('service entitlement revocation maps to immediate protected-collection purge', () => {
  const customer = employee({ adCampaignRequests: ['viewOwn'] });
  const before = sandbox.getServerServiceEntitlementSnapshot(customer, [
    { userId: customer.id, serviceId: 'ad_maker', status: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    { userId: customer.id, serviceId: 'clothes_system', status: 'active', expiresAt: '2099-01-01T00:00:00Z' }
  ], Date.parse('2026-07-17T00:00:00Z'));
  const after = sandbox.getServerServiceEntitlementSnapshot(customer, [
    { userId: customer.id, serviceId: 'ad_maker', status: 'canceled' },
    { userId: customer.id, serviceId: 'clothes_system', status: 'active', expiresAt: '2026-07-16T00:00:00Z' }
  ], Date.parse('2026-07-17T00:00:00Z'));
  const revoked = sandbox.getRevokedServerServiceEntitlements(before, after).sort();
  assert(JSON.stringify(revoked) === JSON.stringify(['ad_maker', 'clothes_system']), `revocation detection failed: ${revoked.join(', ')}`);
  const syncSource = fs.readFileSync(path.join(__dirname, '..', 'src', '10-live-sync.js'), 'utf8');
  assert(syncSource.includes("RenderQueue.schedule('liveSync(subscription-revoked)')"), 'revocation path does not safely rerender');
  assert(syncSource.includes('names.some(name => SERVER_MEDIA_BEARING_COLLECTIONS.has(name))'), 'visibility purge does not close media viewers');
  assert(syncSource.includes("clearTransientEntityMediaCache('adCampaignRequests')"), 'auth reset does not release transient campaign media');
});

check('Ads Studio header returns authorized staff to another landing view only', () => {
  const staff = employee({ customers: ['view'], adCampaignRequests: ['viewOwn'] });
  loginAs(staff);
  assert(sandbox.adsStudioBackTarget() === 'customers', 'authorized alternate landing view was not selected');
  assert(sandbox.renderAdsStudioHeader().includes("navigateTo('customers')"), 'non-admin back control was hidden');
  const portalOnly = employee({ adCampaignRequests: ['viewOwn'] });
  loginAs(portalOnly);
  assert(sandbox.adsStudioBackTarget() === '', 'portal-only customer received an unauthorized back target');
});

check('Ads Studio submit and review retries reuse a per-click operation id', () => {
  const studioSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15c-ads-studio.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', '09-api-auth.js'), 'utf8');
  assert(studioSource.includes("Security.generateSecureId('campaign-submit')") && studioSource.includes("Security.generateSecureId('campaign-review')"), 'workflow clicks do not generate operation ids');
  assert(apiSource.includes('const body = { expectedLastModified, operationId };'), 'submit retry body omits operation id');
  assert(apiSource.includes('const body = { expectedLastModified, decision, note, operationId };'), 'review retry body omits operation id');
  assert(apiSource.includes('withRetry(() => apiJson(`/api/ad-studio/campaigns/'), 'workflow request is not retried with its stable body');
  assert(studioSource.includes('_adsStudioSavePromise') && studioSource.includes('_adsStudioSubmitPromises.has(campaignId)'), 'double-tap single-flight guards are missing');
});

check('Ads Studio never edits a thin campaign after creative hydration fails', () => {
  const studioSource = fs.readFileSync(path.join(__dirname, '..', 'src', '15c-ads-studio.js'), 'utf8');
  assert(studioSource.includes("Your existing images are safe. Check the connection before editing this campaign."), 'creative load failure is not explained to the customer');
  assert(studioSource.includes("!isEntityMediaHydrated('adCampaignRequests', campaign)"), 'thin draft can still open without its stored creatives');
  assert(studioSource.includes('_adsStudioDraft === draftAtSaveStart'), 'slow save can overwrite a replacement or reset draft');
  assert(studioSource.includes('...current,\n      ...liveDraft'), 'slow save completion overwrites newer typed fields');
});

checkAsync('Ads Studio resaves changes made during save and never submits a stale draft', async () => {
  const originalAddRecord = sandbox.addRecord;
  const originalUpdateRecord = sandbox.updateRecord;
  const originalSubmit = sandbox.submitAdsStudioCampaign;
  const customer = employee({ adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn'] });
  customer.subscriptions = ['ad_maker'];
  let modified = 100;

  const installDraft = (name) => {
    sandbox.__adsStudioRegressionDraft = {
      ...sandbox.newAdsStudioDraft(),
      name,
      pageName: 'Regression Page',
      primaryText: 'Regression copy',
      destination: '+218900000000',
      creativeImages: [SAFE_RECEIPT_PNG]
    };
    vm.runInContext(`
      _adsStudioDraft = __adsStudioRegressionDraft;
      _adsStudioEditingId = '';
      _adsStudioConfirmationChecked = true;
      _adsStudioSavePromise = null;
      _adsStudioSaveAndSubmitPromise = null;
    `, sandbox);
  };

  const commitCreate = (array, record) => {
    array.unshift({
      ...record,
      createdBy: customer.id,
      _created: ++modified,
      _lastModified: modified,
      _deleted: false
    });
    return true;
  };

  const commitUpdate = (array, id, updates) => {
    const index = array.findIndex(item => String(item?.id || '') === String(id || ''));
    assert(index !== -1, 'resave tried to update a missing draft');
    array[index] = { ...array[index], ...updates, _lastModified: ++modified };
    return true;
  };

  try {
    loginAs(customer);
    S.language = 'en';
    S.adCampaignRequests = [];
    installDraft('Original copy');

    let releaseFirstSave;
    const firstSaveGate = new Promise(resolve => { releaseFirstSave = resolve; });
    const writes = [];
    const submittedNames = [];
    sandbox.addRecord = async (array, record) => {
      writes.push(record.name);
      await firstSaveGate;
      return commitCreate(array, record);
    };
    sandbox.updateRecord = async (array, id, updates) => {
      writes.push(updates.name);
      return commitUpdate(array, id, updates);
    };
    sandbox.submitAdsStudioCampaign = async (id) => {
      const record = S.adCampaignRequests.find(item => String(item?.id || '') === String(id || ''));
      submittedNames.push(record?.name || '');
      return true;
    };

    const submitAfterSave = sandbox.saveAndSubmitAdsStudioDraftOnce();
    assert(writes.length === 1 && writes[0] === 'Original copy', 'initial save did not start with the original snapshot');
    vm.runInContext("_adsStudioDraft.name = 'Latest customer copy';", sandbox);
    releaseFirstSave();
    await submitAfterSave;

    assert(JSON.stringify(writes) === JSON.stringify(['Original copy', 'Latest customer copy']), `changed draft was not resaved exactly once: ${writes.join(' -> ')}`);
    assert(JSON.stringify(submittedNames) === JSON.stringify(['Latest customer copy']), `submission used stale content: ${submittedNames.join(', ')}`);

    S.adCampaignRequests = [];
    installDraft('Rapid copy 0');
    let rapidWrites = 0;
    let rapidSubmits = 0;
    sandbox.addRecord = async (array, record) => {
      rapidWrites++;
      commitCreate(array, record);
      vm.runInContext(`_adsStudioDraft.name = 'Rapid copy ${rapidWrites}';`, sandbox);
      return true;
    };
    sandbox.updateRecord = async (array, id, updates) => {
      rapidWrites++;
      commitUpdate(array, id, updates);
      vm.runInContext(`_adsStudioDraft.name = 'Rapid copy ${rapidWrites}';`, sandbox);
      return true;
    };
    sandbox.submitAdsStudioCampaign = async () => { rapidSubmits++; return true; };

    await sandbox.saveAndSubmitAdsStudioDraftOnce();
    assert(rapidWrites === 3, `continuous edits caused ${rapidWrites} writes instead of the bounded three`);
    assert(rapidSubmits === 0, 'continuously changing draft was submitted from a stale snapshot');
    assert(vm.runInContext('_adsStudioDraft.name', sandbox) === 'Rapid copy 3', 'latest rapid edit was discarded when submission was stopped');
  } finally {
    sandbox.addRecord = originalAddRecord;
    sandbox.updateRecord = originalUpdateRecord;
    sandbox.submitAdsStudioCampaign = originalSubmit;
    delete sandbox.__adsStudioRegressionDraft;
    vm.runInContext(`
      _adsStudioDraft = null;
      _adsStudioEditingId = '';
      _adsStudioConfirmationChecked = false;
      _adsStudioSavePromise = null;
      _adsStudioSaveAndSubmitPromise = null;
    `, sandbox);
  }
});

check('Ads Studio renders daily and lifetime requested budgets as separate totals', () => {
  const customer = employee({ adCampaignRequests: ['viewOwn'] });
  customer.subscriptions = ['ad_maker'];
  loginAs(customer);
  S.language = 'en';
  S.adCampaignRequests = [
    { id: 'campaign-lifetime-budget', name: 'Lifetime campaign', status: 'Draft', createdBy: customer.id, budgetType: 'lifetime', budgetMinorUSD: 10000 },
    { id: 'campaign-daily-budget', name: 'Daily campaign', status: 'Draft', createdBy: customer.id, budgetType: 'daily', budgetMinorUSD: 1000 }
  ];
  const html = visible(sandbox.renderAdsStudioDashboard());
  assert(/Lifetime requested[\s\S]*?\$100\.00[\s\S]*?Daily requested[\s\S]*?\$10\.00[\s\S]*?\/ day/.test(html), 'dashboard did not label and render the two budget units separately');
  assert(!html.includes('$110.00'), 'dashboard added a daily rate to a lifetime total');
});

check('Ads Studio view and records are ownership scoped for customer accounts', () => {
  const customer = employee({ adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'deleteOwn', 'submitOwn'] });
  customer.subscriptions = ['ad_maker'];
  loginAs(customer);
  S.language = 'en';
  S.adCampaignRequests = [
    { id: 'campaign-own', name: 'My offer', status: 'Draft', createdBy: customer.id, objective: 'messages', platforms: ['facebook'], pageName: 'My Page', budgetMinorUSD: 2500, startDate: '2026-07-18', endDate: '2026-07-25', primaryText: 'Hello', destination: '+218900000000', locations: ['Libya'], ageMin: 18, ageMax: 65 },
    { id: 'campaign-other', name: 'SECRET OTHER CAMPAIGN', status: 'Submitted', createdBy: 'u-other', objective: 'sales', platforms: ['instagram'], pageName: 'Other Page', budgetMinorUSD: 9900, startDate: '2026-07-18', endDate: '2026-07-25' }
  ];
  const visibleCampaigns = sandbox.getVisibleAdsStudioCampaigns();
  assert(visibleCampaigns.length === 1 && visibleCampaigns[0].id === 'campaign-own', 'viewOwn customer can see another customer campaign');
  assert(sandbox.userCanAccessView(customer, 'ads-studio'), 'customer cannot open the Ads Studio view');
  const html = visible(sandbox.renderAdsStudioView());
  assert(html.includes('Albayan Ads Studio'), 'customer portal did not render');
  assert(!html.includes('SECRET OTHER CAMPAIGN'), 'other customer campaign leaked into portal HTML');
  assert(!html.includes('Review Queue'), 'customer received staff review tools');
  assert(html.includes('No money is spent by this request system') || html.includes('not actual spend'), 'portal does not explain that requested budgets are not charges');
});

check('Ads Studio campaign builder uses integer budget cents and no live-publish action', () => {
  const customer = employee({ adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'deleteOwn', 'submitOwn'] });
  customer.subscriptions = ['ad_maker'];
  loginAs(customer);
  sandbox.beginAdsStudioCampaign();
  sandbox.adsStudioSetDraftField('name', 'Launch campaign');
  sandbox.adsStudioSetDraftField('budgetMinorUSD', '12.34');
  const sanitized = sandbox.sanitizedAdsStudioDraft();
  assert(sanitized.budgetMinorUSD === 1234, `budget was not stored as integer cents (${sanitized.budgetMinorUSD})`);
  vm.runInContext('_adsStudioActiveTab = "builder"; _adsStudioWizardStep = 5;', sandbox);
  const html = visible(sandbox.renderAdsStudioView());
  assert(html.includes('Save &amp; submit for review') || html.includes('Save & submit for review'), 'builder has no review submission action');
  assert(!/publish\s+(now|live)/i.test(html), 'customer UI exposes a live-publish action');
  assert(html.includes('Special category'), 'builder review omits Special Ad Category');
});

check('Ads Studio routing restores a directly linked tab', () => {
  sandbox.window.location.pathname = '/ads-studio';
  sandbox.window.location.search = '?tab=connections';
  assert(sandbox.getViewFromUrl() === 'ads-studio', 'Ads Studio URL does not resolve to its view');
  sandbox.restoreAdsStudioTabFromUrl();
  assert(vm.runInContext('_adsStudioActiveTab', sandbox) === 'connections', 'Ads Studio tab was not restored from URL');
  sandbox.window.location.pathname = '/';
  sandbox.window.location.search = '';
});

check('post-login routing preserves only authorized direct Ads Studio links', () => {
  const customer = employee({ adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn'] });
  customer.subscriptions = ['ad_maker'];
  const unrelatedEmployee = employee({ customers: ['view'] });
  assert(sandbox.getAllowedPostLoginView(ADMIN, 'ads-studio') === 'ads-studio', 'Admin direct link was discarded');
  assert(sandbox.getAllowedPostLoginView(customer, 'ads-studio') === 'ads-studio', 'authorized customer direct link was discarded');
  assert(sandbox.getAllowedPostLoginView(unrelatedEmployee, 'ads-studio') === null, 'unauthorized employee could restore Ads Studio');
  assert(sandbox.getAllowedPostLoginView(customer, 'not-a-real-view') === null, 'unknown direct route was accepted');

  loginAs(customer);
  S.currentView = 'services-hub';
  sandbox.window.location.pathname = '/ads-studio';
  sandbox.window.location.search = '?tab=campaigns';
  assert(sandbox.restoreRequestedViewAfterLogin('ads-studio') === true, 'authorized direct route was not restored');
  assert(S.currentView === 'ads-studio', 'successful login still ended at Services Hub');

  loginAs(unrelatedEmployee);
  S.currentView = 'customers';
  assert(sandbox.restoreRequestedViewAfterLogin('ads-studio') === false, 'unauthorized direct route was restored');
  assert(S.currentView === 'customers', 'unauthorized route replaced the safe landing');
  sandbox.window.location.pathname = '/';
  sandbox.window.location.search = '';
});

check('Edit Ad receipt replacement preserves the exact saved amount and exposes shortfall', () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    modalData: S.modalData,
    tempAdFunding: S.tempAdFunding,
    getElementById: sandbox.document.getElementById
  };
  try {
    loginAs(ADMIN);
    S.receipts = [
      { id: 'relink_old', customerId: 'relink_customer', amountUSD: 30, status: 'Paid', isPaid: true, transfers: [] },
      { id: 'relink_large', customerId: 'relink_customer', amountUSD: 100, status: 'Paid', isPaid: true, transfers: [] },
      { id: 'relink_small', customerId: 'relink_customer', amountUSD: 20, status: 'Paid', isPaid: true, transfers: [] }
    ];
    const ad = {
      id: 'relink_ad', customerId: 'relink_customer', amountUSD: 30,
      paymentStatus: 'paid', isPaid: true,
      receiptAllocations: [{ receiptId: 'relink_old', amountUSD: 30 }],
      dueAllocations: []
    };
    S.ads = [ad];
    S.modalData = { ...ad, receiptAllocations: ad.receiptAllocations.map(row => ({ ...row })) };

    const elements = new Map();
    const customer = makeElement(); customer.value = 'relink_customer';
    const payment = makeElement(); payment.value = 'paid';
    const fundingList = makeElement();
    elements.set('ad-customer-id', customer);
    elements.set('ad-page', makeElement());
    elements.set('ad-payment-status', payment);
    elements.set('ad-funding-list', fundingList);
    elements.set('ad-funding-summary', makeElement());
    elements.set('ad-funding-change-notice', makeElement());
    sandbox.document.getElementById = id => elements.get(id) || null;

    S.tempAdFunding = { allocations: [{ receiptId: 'relink_old', amountUSD: 30 }] };
    sandbox.updateAdFundingReceipt(0, 'relink_large');
    assert(Number(S.tempAdFunding.allocations[0].amountUSD) === 30,
      'replacing a $30 allocation with a $100 receipt grew or shrank the ad amount');

    S.tempAdFunding = { allocations: [{ receiptId: 'relink_old', amountUSD: 30 }] };
    sandbox.updateAdFundingReceipt(0, 'relink_small');
    assert(Number(S.tempAdFunding.allocations[0].amountUSD) === 30,
      'replacing a $30 allocation with a $20 receipt silently clamped the ad amount');
    assert(fundingList.innerHTML.includes('Short $10.00'),
      'insufficient replacement did not show the exact $10 shortfall');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.tempAdFunding = original.tempAdFunding;
    sandbox.document.getElementById = original.getElementById;
  }
});

check('Unpaid Ad settlement shows customer receipts and fills the exact replacement amount', () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    modalData: S.modalData,
    tempAdFunding: S.tempAdFunding,
    getElementById: sandbox.document.getElementById
  };
  try {
    loginAs(ADMIN);
    S.receipts = [
      {
        id: 'settle_old_due', customerId: 'settle_customer', pageId: 'page_a', amountUSD: 9,
        status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'office' }, transfers: []
      },
      {
        id: 'settle_paid_replacement', customerId: 'settle_customer', pageId: 'legacy_page_b', amountUSD: 10,
        status: 'Paid', isPaid: true, receiptType: 'DELIVERY_TEMP', tempReceiptNo: 'D8',
        finalReceiptNo: '12854', deliveryStatus: 'Office', transfers: []
      },
      {
        id: 'settle_paid_second', customerId: 'settle_customer', pageId: 'legacy_page_c', amountUSD: 20,
        status: 'Paid', isPaid: true, transfers: []
      },
      {
        id: 'settle_unfinished_temp', customerId: 'settle_customer', amountUSD: 50,
        status: 'Paid', isPaid: true, receiptType: 'DELIVERY_TEMP', tempReceiptNo: 'D9',
        finalReceiptNo: '', deliveryStatus: 'In Progress', transfers: []
      },
      {
        id: 'settle_other_customer', customerId: 'another_customer', amountUSD: 100,
        status: 'Paid', isPaid: true, transfers: []
      }
    ];
    const ad = {
      id: 'settle_partial_ad', customerId: 'settle_customer', pageId: 'page_a', amountUSD: 9,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: 'settle_old_due', linkedDeliveryReceiptId: '',
      receiptAllocations: [], dueAllocations: [{ receiptId: 'settle_old_due', amountUSD: 1.24 }],
      dueAmountToUseUSD: 1.24
    };
    const otherAd = {
      id: 'settle_other_ad', customerId: 'settle_customer', pageId: 'legacy_page_b', amountUSD: 1,
      paymentStatus: 'paid', isPaid: true,
      receiptAllocations: [{ receiptId: 'settle_paid_replacement', amountUSD: 1 }], dueAllocations: []
    };
    S.ads = [ad, otherAd];
    S.modalData = {
      ...ad,
      receiptAllocations: [],
      dueAllocations: ad.dueAllocations.map(row => ({ ...row }))
    };
    S.tempAdFunding = { allocations: [{ receiptId: 'settle_old_due', amountUSD: 1.24 }] };

    const elements = new Map();
    const customer = makeElement(); customer.value = 'settle_customer';
    const page = makeElement(); page.value = 'page_a';
    const payment = makeElement(); payment.value = 'paid';
    const fundingList = makeElement();
    elements.set('ad-customer-id', customer);
    elements.set('ad-page', page);
    elements.set('ad-payment-status', payment);
    elements.set('ad-funding-list', fundingList);
    elements.set('ad-funding-summary', makeElement());
    elements.set('ad-funding-change-notice', makeElement());
    sandbox.document.getElementById = id => elements.get(id) || null;

    sandbox.renderAdFundingList();
    assert(fundingList.innerHTML.includes('value="settle_paid_replacement"'),
      'same-customer Paid replacement was hidden by legacy page/delivery state');
    assert(!fundingList.innerHTML.includes('value="settle_other_customer"'),
      'another customer receipt appeared in the funding selector');
    assert(!fundingList.innerHTML.includes('value="settle_unfinished_temp"'),
      'unfinished temporary delivery receipt appeared in the funding selector');
    assert(fundingList.innerHTML.includes('current link unavailable'),
      'the old unpaid link was not clearly labelled as unavailable');

    sandbox.updateAdFundingReceipt(0, 'settle_paid_replacement');
    assert(S.tempAdFunding.allocations[0].receiptId === 'settle_paid_replacement',
      'replacement receipt was not selected');
    assert(Number(S.tempAdFunding.allocations[0].amountUSD) === 9,
      `partial $1.24 due was not expanded to the exact $9 settlement (${S.tempAdFunding.allocations[0].amountUSD})`);

    S.tempAdFunding = {
      allocations: [
        { receiptId: 'settle_paid_replacement', amountUSD: 1.24 },
        { receiptId: '', amountUSD: 0 }
      ]
    };
    sandbox.updateAdFundingReceipt(1, 'settle_paid_second');
    assert(Number(S.tempAdFunding.allocations[1].amountUSD) === 7.76,
      `second receipt did not fill the exact $7.76 settlement remainder (${S.tempAdFunding.allocations[1].amountUSD})`);
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.tempAdFunding = original.tempAdFunding;
    sandbox.document.getElementById = original.getElementById;
  }
});

check('Edit Ad due-receipt replacement preserves the exact saved debt amount', () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    modalData: S.modalData,
    tempAdFunding: S.tempAdFunding,
    tempMergeFunding: S.tempMergeFunding,
    tempMixedReceiptTargetUSD: S.tempMixedReceiptTargetUSD,
    getElementById: sandbox.document.getElementById
  };
  try {
    loginAs(ADMIN);
    S.receipts = [
      { id: 'due_old', customerId: 'due_customer', amountUSD: 30, status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'office' }, transfers: [] },
      { id: 'due_large', customerId: 'due_customer', amountUSD: 100, status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'office' }, transfers: [] },
      { id: 'due_small', customerId: 'due_customer', amountUSD: 20, status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'office' }, transfers: [] }
    ];
    const ad = {
      id: 'due_relink_ad', customerId: 'due_customer', amountUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: 'due_old', linkedDeliveryReceiptId: '',
      receiptAllocations: [], dueAllocations: [{ receiptId: 'due_old', amountUSD: 30 }],
      dueAmountToUseUSD: 30
    };
    S.ads = [ad];
    S.modalData = { ...ad, dueAllocations: ad.dueAllocations.map(row => ({ ...row })) };
    S.tempAdFunding = { allocations: [{ receiptId: 'due_old', amountUSD: 30 }] };
    S.tempMergeFunding = null;
    S.tempMixedReceiptTargetUSD = 30;

    const elements = new Map();
    const collection = makeElement(); collection.value = 'in_shop';
    const payment = makeElement(); payment.value = 'not_paid';
    const customer = makeElement(); customer.value = 'due_customer';
    elements.set('ad-collection-method', collection);
    elements.set('ad-payment-status', payment);
    elements.set('ad-customer-id', customer);
    elements.set('ad-linked-receipt-id', makeElement());
    elements.set('ad-temp-receipt-hint', makeElement());
    elements.set('ad-delivery-person', makeElement());
    elements.set('ad-due-amount-section', makeElement());
    elements.set('ad-merge-funds-toggle', makeElement());
    elements.set('ad-due-available', makeElement());
    elements.set('ad-due-amount-to-use', makeElement());
    elements.set('ad-unpaid-financial', makeElement());
    elements.set('ad-driver-budget-rate', makeElement());
    elements.set('ad-linked-receipt-change', makeElement());
    sandbox.document.getElementById = id => elements.get(id) || null;

    sandbox.onAdTempReceiptChange('due_large');
    assert(Number(elements.get('ad-due-amount-to-use').value) === 30,
      'replacing a $30 due allocation with a $100 receipt changed the debt amount');
    sandbox.onAdTempReceiptChange('due_small');
    assert(Number(elements.get('ad-due-amount-to-use').value) === 30,
      'replacing a $30 due allocation with a $20 receipt silently clamped the debt amount');
    assert(Number(elements.get('ad-due-amount-to-use').dataset.maxDue) === 20,
      'small replacement did not retain its real $20 save-time capacity');
    assert(S.tempAdFunding.allocations[0].receiptId === 'due_small'
      && Number(S.tempAdFunding.allocations[0].amountUSD) === 30,
    'working allocation did not keep the exact $30 against the selected replacement');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.tempAdFunding = original.tempAdFunding;
    S.tempMergeFunding = original.tempMergeFunding;
    S.tempMixedReceiptTargetUSD = original.tempMixedReceiptTargetUSD;
    sandbox.document.getElementById = original.getElementById;
  }
});

checkAsync('local Paid settlement moves due and frozen baselines before one visible update', async () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    serverMode: S.serverMode
  };
  try {
    loginAs(ADMIN);
    S.serverMode = false;
    S.receipts = [{
      id: 'local_settle_receipt', customerId: 'local_settle_customer',
      amountUSD: 30, status: 'Not Paid', isPaid: false, transfers: [], _lastModified: 10
    }];
    S.ads = [
      {
        id: 'local_settle_live', customerId: 'local_settle_customer', amountUSD: 30,
        paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
        receiptId: 'local_settle_receipt', linkedDeliveryReceiptId: 'local_settle_receipt',
        receiptAllocations: [], dueAllocations: [{ receiptId: 'local_settle_receipt', amountUSD: 30 }],
        dueAmountToUseUSD: 30
      },
      {
        id: 'local_settle_provenance_only', customerId: 'local_settle_customer', amountUSD: 5,
        paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
        receiptId: 'local_settle_receipt', linkedDeliveryReceiptId: 'local_settle_receipt',
        receiptAllocations: [], dueAllocations: [], dueAmountToUseUSD: 0
      }
    ];

    assert(await sandbox.updateRecord(
      S.receipts,
      'local_settle_receipt',
      { status: 'Paid', isPaid: true },
      10
    ) === true, 'local receipt settlement failed');
    assert(S.receipts[0].status === 'Paid' && S.receipts[0].isPaid === true,
      'local receipt was not marked Paid');
    assert(S.ads[0].paymentStatus === 'paid' && S.ads[0].dueAllocations.length === 0,
      'local linked ad did not become Paid with its receipt');
    assert(S.ads[0].receiptAllocations[0].amountUSD === 30,
      'local due money was not moved exactly into paid funding');
    assert(S.ads[1].paymentStatus === 'not_paid' && S.ads[1].receiptAllocations.length === 0,
      'zero-due provenance link minted paid credit');

    // A stopped-at-zero legacy row has no live due money, but its frozen stop
    // and refund baselines still need conversion and its current badge must align.
    S.receipts = [{
      id: 'local_baseline_receipt', customerId: 'local_settle_customer',
      amountUSD: 30, status: 'Not Paid', isPaid: false, transfers: [], _lastModified: 20
    }];
    S.ads = [{
      id: 'local_baseline_ad', customerId: 'local_settle_customer', amountUSD: 30, spentUSD: 0,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      receiptId: 'local_baseline_receipt', linkedDeliveryReceiptId: 'local_baseline_receipt',
      receiptAllocations: [], dueAllocations: [], dueAmountToUseUSD: 0,
      stopAllocationBaseline: {
        receipt: [], due: [{ receiptId: 'local_baseline_receipt', amountUSD: 30 }],
        merged: [], dueLegacy: 0, paymentStatus: 'not_paid'
      },
      refundAllocationBaseline: [],
      refundDueBaseline: [{ receiptId: 'local_baseline_receipt', amountUSD: 30 }]
    }];
    assert(await sandbox.updateRecord(
      S.receipts,
      'local_baseline_receipt',
      { status: 'Paid', isPaid: true },
      20
    ) === true, 'baseline-only local settlement failed');
    const baselineAd = S.ads[0];
    assert(baselineAd.stopAllocationBaseline.paymentStatus === 'paid'
      && baselineAd.stopAllocationBaseline.due.length === 0
      && baselineAd.stopAllocationBaseline.receipt[0].amountUSD === 30,
    'stop baseline did not move from due to paid');
    assert(baselineAd.refundBaselinePaymentStatus === 'paid'
      && baselineAd.refundDueBaseline.length === 0
      && baselineAd.refundAllocationBaseline[0].amountUSD === 30,
    'refund baseline did not move from due to paid');
    assert(baselineAd.paymentStatus === 'paid' && baselineAd.isPaid === true,
      'baseline-only stopped/refunded ad did not align its current Paid badge');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.serverMode = original.serverMode;
    seedBusinessData();
  }
});

checkAsync('local Paid settlement preserves mixed legacy In-Shop funding and converts its mirror exactly', async () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    modalData: S.modalData,
    serverMode: S.serverMode
  };
  try {
    loginAs(ADMIN);
    S.serverMode = false;
    S.receipts = [
      {
        id: 'legacy_shop_paid_other', customerId: 'legacy_shop_customer', amountUSD: 10,
        status: 'Paid', isPaid: true, transfers: [], _lastModified: 40
      },
      {
        id: 'legacy_shop_due', customerId: 'legacy_shop_customer', amountUSD: 30,
        amountLocal: 291, exchangeRate: 9.7, status: 'Not Paid', isPaid: false,
        statusDetail: { notPaidCollection: 'office' }, transfers: [], _lastModified: 41
      }
    ];
    const ad = {
      id: 'legacy_shop_mixed_ad', customerId: 'legacy_shop_customer', amountUSD: 40, spentUSD: 40,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: 'legacy_shop_due', linkedDeliveryReceiptId: '',
      receiptAllocations: [{ receiptId: 'legacy_shop_paid_other', amountUSD: 10 }],
      dueAllocations: [], dueAmountToUseUSD: 30
    };
    S.ads = [ad];
    S.modalData = { ...ad, receiptAllocations: ad.receiptAllocations.map(row => ({ ...row })), dueAllocations: [] };

    assert(sandbox.getEditingAdExistingAllocationUSD('legacy_shop_due') === 30,
      'Edit Ad did not add back the legacy In-Shop mirror for its current receipt');
    assert(await sandbox.updateRecord(
      S.receipts, 'legacy_shop_due', { status: 'Paid', isPaid: true }, 41
    ) === true, 'legacy In-Shop receipt settlement failed');

    const settled = S.ads[0];
    const rows = new Map(settled.receiptAllocations.map(row => [String(row.receiptId), Number(row.amountUSD)]));
    assert(settled.paymentStatus === 'paid' && settled.isPaid === true,
      'fully funded legacy In-Shop ad did not become Paid');
    assert(rows.get('legacy_shop_paid_other') === 10,
      'existing paid receipt allocation was lost during settlement');
    assert(rows.get('legacy_shop_due') === 30,
      'legacy In-Shop mirror was not moved exactly into paid allocations');
    assert(settled.dueAllocations.length === 0 && settled.dueAmountToUseUSD === 0,
      'legacy debt mirror survived after the receipt became Paid');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.modalData = original.modalData;
    S.serverMode = original.serverMode;
    seedBusinessData();
  }
});

checkAsync('saving a legacy In-Shop receipt replacement resolves its selected receipt in save scope', async () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    pages: S.pages,
    customers: S.customers,
    modalData: S.modalData,
    activeModal: S.activeModal,
    serverMode: S.serverMode,
    tempAdFunding: S.tempAdFunding,
    tempMergeFunding: S.tempMergeFunding,
    tempMixedReceiptTargetUSD: S.tempMixedReceiptTargetUSD,
    tempAdPhotos: S.tempAdPhotos,
    tempAdPhotosDirty: S.tempAdPhotosDirty,
    getElementById: sandbox.document.getElementById,
    querySelectorAll: sandbox.document.querySelectorAll,
    closeModal: sandbox.closeModal
  };
  try {
    loginAs(ADMIN);
    clearNotes();
    S.serverMode = false;
    S.activeModal = 'ad';
    S.customers = [{ id: 'scope_customer', name: 'Scope Customer' }];
    S.pages = [{ id: 'scope_page', customerId: 'scope_customer', name: 'Scope Page' }];
    S.receipts = [
      {
        id: 'scope_due_old', customerId: 'scope_customer', amountUSD: 30,
        amountLocal: 291, exchangeRate: 9.7, status: 'Not Paid', isPaid: false,
        deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' }, transfers: []
      },
      {
        id: 'scope_due_new', customerId: 'scope_customer', amountUSD: 30,
        amountLocal: 300, exchangeRate: 10, status: 'Not Paid', isPaid: false,
        deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' }, transfers: []
      }
    ];
    const ad = {
      id: 'scope_legacy_shop_ad', customerId: 'scope_customer', pageId: 'scope_page',
      amountUSD: 30, amountLocal: 291, exchangeRate: 9.7,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      receiptId: 'scope_due_old', linkedDeliveryReceiptId: '',
      receiptAllocations: [], dueAllocations: [], dueAmountToUseUSD: 30,
      startDate: '2026-07-20T00:00:00.000Z', endDate: '2026-07-25T00:00:00.000Z'
    };
    S.ads = [ad];
    S.modalData = { ...ad, receiptAllocations: [], dueAllocations: [] };
    S.tempAdFunding = { allocations: [] };
    S.tempMergeFunding = { enabled: false, allocations: [] };
    S.tempMixedReceiptTargetUSD = 30;
    S.tempAdPhotos = [];
    S.tempAdPhotosDirty = false;

    const elements = new Map();
    const withValue = value => { const element = makeElement(); element.value = value; return element; };
    elements.set('ad-payment-status', withValue('not_paid'));
    elements.set('ad-collection-method', withValue('in_shop'));
    elements.set('ad-linked-receipt-id', withValue('scope_due_new'));
    elements.set('ad-due-amount-to-use', withValue('30'));
    elements.set('ad-start-date', withValue('2026-07-20'));
    elements.set('ad-end-date', withValue('2026-07-25'));
    elements.set('ad-days', withValue('5'));
    elements.set('ad-page', withValue('scope_page'));
    elements.set('ad-customer-id', withValue('scope_customer'));
    sandbox.document.getElementById = id => elements.get(id) || null;
    sandbox.document.querySelectorAll = () => [];
    sandbox.closeModal = () => {};

    await sandbox.handleModalSubmit();
    const saved = S.ads[0];
    assert(saved.receiptId === 'scope_due_new', 'replacement receipt was not saved');
    assert(saved.dueAllocations?.length === 1
      && saved.dueAllocations[0].receiptId === 'scope_due_new'
      && Number(saved.dueAllocations[0].amountUSD) === 30,
    'replacement did not reserve the exact saved debt amount');
    assert(!notes.some(note => /linkedReceipt is not defined/.test(String(note?.m || ''))),
      'save still failed on the block-scoped linkedReceipt reference');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.pages = original.pages;
    S.customers = original.customers;
    S.modalData = original.modalData;
    S.activeModal = original.activeModal;
    S.serverMode = original.serverMode;
    S.tempAdFunding = original.tempAdFunding;
    S.tempMergeFunding = original.tempMergeFunding;
    S.tempMixedReceiptTargetUSD = original.tempMixedReceiptTargetUSD;
    S.tempAdPhotos = original.tempAdPhotos;
    S.tempAdPhotosDirty = original.tempAdPhotosDirty;
    sandbox.document.getElementById = original.getElementById;
    sandbox.document.querySelectorAll = original.querySelectorAll;
    sandbox.closeModal = original.closeModal;
    seedBusinessData();
  }
});

checkAsync('local Paid settlement blocks cross-customer and over-capacity batches before mutation', async () => {
  const original = { receipts: S.receipts, ads: S.ads, serverMode: S.serverMode };
  try {
    loginAs(ADMIN);
    S.serverMode = false;
    S.receipts = [{
      id: 'local_capacity_receipt', customerId: 'capacity_customer', amountUSD: 20,
      status: 'Not Paid', isPaid: false, transfers: [], _lastModified: 30
    }];
    S.ads = [{
      id: 'local_capacity_ad', customerId: 'capacity_customer', amountUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      linkedDeliveryReceiptId: 'local_capacity_receipt', receiptAllocations: [],
      dueAllocations: [{ receiptId: 'local_capacity_receipt', amountUSD: 30 }]
    }];
    assert(await sandbox.updateRecord(
      S.receipts, 'local_capacity_receipt', { status: 'Paid', isPaid: true }, 30
    ) === false, 'over-capacity local settlement was accepted');
    assert(S.receipts[0].status === 'Not Paid' && S.ads[0].dueAllocations.length === 1,
      'over-capacity failure partially mutated receipt or ad');

    S.receipts[0].amountUSD = 30;
    S.ads[0].customerId = 'different_customer';
    assert(await sandbox.updateRecord(
      S.receipts, 'local_capacity_receipt', { status: 'Paid', isPaid: true }, 30
    ) === false, 'cross-customer local settlement was accepted');
    assert(S.receipts[0].status === 'Not Paid' && S.ads[0].paymentStatus === 'not_paid',
      'cross-customer failure partially mutated receipt or ad');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.serverMode = original.serverMode;
    seedBusinessData();
  }
});

checkAsync('driver completion refresh installs the server-cascaded Paid ad before success render', async () => {
  const originalApiLoadCollectionAll = sandbox.apiLoadCollectionAll;
  const originalAds = S.ads;
  const originalServerMode = S.serverMode;
  try {
    loginAs(ADMIN);
    S.serverMode = true;
    S.ads = [{
      id: 'delivery_refresh_ad', customerId: 'delivery_refresh_customer', amountUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      linkedDeliveryReceiptId: 'delivery_refresh_receipt', receiptAllocations: [],
      dueAllocations: [{ receiptId: 'delivery_refresh_receipt', amountUSD: 30 }]
    }];
    sandbox.apiLoadCollectionAll = async (collection, options) => {
      assert(collection === 'ads' && options?.forceRefresh === true,
        'delivery completion did not request an authoritative ads refresh');
      return [{
        id: 'delivery_refresh_ad', customerId: 'delivery_refresh_customer', amountUSD: 30,
        paymentStatus: 'paid', isPaid: true, collectionMethod: '',
        receiptId: 'delivery_refresh_receipt', fundingReceiptId: 'delivery_refresh_receipt',
        receiptIds: ['delivery_refresh_receipt'], linkedDeliveryReceiptId: '',
        receiptAllocations: [{ receiptId: 'delivery_refresh_receipt', amountUSD: 30 }],
        dueAllocations: []
      }];
    };
    const result = await sandbox.refreshAdsAfterReceiptPaidCascade({
      id: 'delivery_refresh_receipt', customerId: 'delivery_refresh_customer',
      status: 'Paid', isPaid: true, amountUSD: 30, transfers: []
    });
    assert(result.consistent === true && result.source === 'server',
      'delivery receipt cascade did not finish with an authoritative ad state');
    assert(S.ads[0].paymentStatus === 'paid' && S.ads[0].dueAllocations.length === 0,
      'linked ad was still Not Paid after delivery completion refresh returned');
  } finally {
    sandbox.apiLoadCollectionAll = originalApiLoadCollectionAll;
    S.ads = originalAds;
    S.serverMode = originalServerMode;
    seedBusinessData();
  }
});

checkAsync('server receipt cancellation installs released linked ads without a stale ad mutation', async () => {
  const originalApiLoadCollectionAll = sandbox.apiLoadCollectionAll;
  const originalAds = S.ads;
  const originalServerMode = S.serverMode;
  try {
    loginAs(ADMIN);
    S.serverMode = true;
    S.ads = [{
      id: 'delivery_cancel_ad', customerId: 'delivery_cancel_customer', amountUSD: 30,
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'driver',
      linkedDeliveryReceiptId: 'delivery_cancel_receipt', receiptAllocations: [],
      dueAllocations: [{ receiptId: 'delivery_cancel_receipt', amountUSD: 30 }]
    }];
    sandbox.apiLoadCollectionAll = async (collection, options) => {
      assert(collection === 'ads' && options?.forceRefresh === true,
        'receipt cancellation did not request an authoritative ads refresh');
      return [{
        ...S.ads[0],
        linkedDeliveryReceiptId: '', receiptId: '', dueAmountToUseUSD: 0,
        dueAmountToUseLYD: 0, dueAllocations: []
      }];
    };
    const result = await sandbox.refreshAdsAfterReceiptServerCascade({
      id: 'delivery_cancel_receipt', customerId: 'delivery_cancel_customer',
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Canceled', amountUSD: 30
    });
    assert(result.consistent === true && result.source === 'server',
      'canceled receipt did not finish with authoritative linked ads');
    assert(S.ads[0].dueAllocations.length === 0 && S.ads[0].linkedDeliveryReceiptId === '',
      'canceled receipt left stale due funding visible on its linked ad');
  } finally {
    sandbox.apiLoadCollectionAll = originalApiLoadCollectionAll;
    S.ads = originalAds;
    S.serverMode = originalServerMode;
    seedBusinessData();
  }
});

checkAsync('delivery cancel handler refreshes server cascades and uses local release only offline', async () => {
  const original = {
    receipts: S.receipts,
    ads: S.ads,
    serverMode: S.serverMode,
    getElementById: sandbox.document.getElementById,
    findReceipt: sandbox._findReceiptForDeliveryModal,
    findAd: sandbox._findAdForDeliveryModal,
    updateRecord: sandbox.updateRecord,
    refreshCascade: sandbox.refreshAdsAfterReceiptServerCascade,
    releaseDue: sandbox.releaseCanceledDeliveryDueFunding,
    forceFullRender: sandbox.forceFullRender
  };
  let refreshCalls = 0;
  let releaseCalls = 0;
  try {
    loginAs(ADMIN);
    const reason = makeElement(); reason.value = 'Customer canceled';
    const modal = makeElement();
    sandbox.document.getElementById = id => {
      if (id === 'delivery-cancel-reason') return reason;
      if (id === 'delivery-cancel-modal' || id === 'delivery-complete-modal') return modal;
      return null;
    };
    const receipt = {
      id: 'cancel_handler_receipt', customerId: 'cancel_handler_customer',
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Needs Delivery', deliveryHistory: []
    };
    const ad = {
      id: 'cancel_handler_ad', customerId: 'cancel_handler_customer',
      deliveryStatus: 'Needs Delivery', deliveryHistory: []
    };
    S.receipts = [receipt];
    S.ads = [ad];
    sandbox._findReceiptForDeliveryModal = id => id === receipt.id ? receipt : null;
    sandbox._findAdForDeliveryModal = id => id === ad.id ? ad : null;
    sandbox.updateRecord = async (collection, id, updates) => {
      const row = collection.find(item => String(item.id) === String(id));
      if (row) Object.assign(row, updates);
      return true;
    };
    sandbox.refreshAdsAfterReceiptServerCascade = async () => {
      refreshCalls++;
      return { consistent: true, source: 'server', updated: 1 };
    };
    sandbox.releaseCanceledDeliveryDueFunding = async () => {
      releaseCalls++;
      return 1;
    };
    sandbox.forceFullRender = () => {};

    S.serverMode = true;
    await sandbox.submitDeliveryCancel('receipt', receipt.id);
    assert(refreshCalls === 1, 'server receipt cancel did not refresh its atomically released ads');
    assert(releaseCalls === 0, 'server receipt cancel issued the stale local ad-release mutation');

    S.serverMode = false;
    await sandbox.submitDeliveryCancel('receipt', receipt.id);
    assert(refreshCalls === 1, 'offline receipt cancel incorrectly called the server cascade refresh');
    assert(releaseCalls === 1, 'offline receipt cancel did not release local due funding');

    await sandbox.submitDeliveryCancel('ad', ad.id);
    assert(ad.deliveryStatus === 'Canceled', 'ad-only delivery cancel branch did not complete safely');
  } finally {
    S.receipts = original.receipts;
    S.ads = original.ads;
    S.serverMode = original.serverMode;
    sandbox.document.getElementById = original.getElementById;
    sandbox._findReceiptForDeliveryModal = original.findReceipt;
    sandbox._findAdForDeliveryModal = original.findAd;
    sandbox.updateRecord = original.updateRecord;
    sandbox.refreshAdsAfterReceiptServerCascade = original.refreshCascade;
    sandbox.releaseCanceledDeliveryDueFunding = original.releaseDue;
    sandbox.forceFullRender = original.forceFullRender;
    seedBusinessData();
  }
});

checkAsync('Not Paid to Paid waits for one receipt+ads settlement batch with no partial optimistic state', async () => {
  const originalApiSettleReceipt = sandbox.apiSettleReceipt;
  const originalServerMode = S.serverMode;
  let settlePayload = null;
  let finishSettlement = null;
  try {
    loginAs(ADMIN);
    S.serverMode = true;
    S.receipts = [{
      id: 'receipt_atomic_paid', customerId: 'customer_atomic_paid',
      status: 'Not Paid', isPaid: false, amountUSD: 30, _lastModified: 100
    }];
    S.ads = [{
      id: 'ad_atomic_paid', customerId: 'customer_atomic_paid',
      paymentStatus: 'not_paid', isPaid: false, amountUSD: 30,
      receiptId: 'receipt_atomic_paid', linkedDeliveryReceiptId: 'receipt_atomic_paid',
      receiptAllocations: [], dueAllocations: [{ receiptId: 'receipt_atomic_paid', amountUSD: 30 }],
      _lastModified: 200
    }];
    sandbox.apiSettleReceipt = payload => {
      settlePayload = payload;
      return new Promise(resolve => { finishSettlement = resolve; });
    };

    const saving = sandbox.updateRecord(
      S.receipts,
      'receipt_atomic_paid',
      { status: 'Paid', isPaid: true, paymentMethod: 'Cash (LYD)' },
      100
    );
    await Promise.resolve();
    assert(S.receipts[0].status === 'Not Paid' && S.receipts[0].isPaid === false,
      'receipt was painted Paid before the linked ads were committed');
    assert(S.ads[0].paymentStatus === 'not_paid' && S.ads[0].dueAllocations.length === 1,
      'ad changed before the atomic settlement response');
    assert(settlePayload?.expectedLastModified === 100, 'modal-open receipt version was not sent');
    assert(String(settlePayload?.idempotencyKey || '').length > 0, 'settlement has no stable idempotency key');

    finishSettlement({
      receipt: {
        id: 'receipt_atomic_paid', lastModified: 101,
        data: {
          id: 'receipt_atomic_paid', customerId: 'customer_atomic_paid',
          status: 'Paid', isPaid: true, amountUSD: 30, paymentMethod: 'Cash (LYD)', _lastModified: 101
        }
      },
      updatedAds: [{
        id: 'ad_atomic_paid', lastModified: 201,
        data: {
          id: 'ad_atomic_paid', customerId: 'customer_atomic_paid',
          paymentStatus: 'paid', isPaid: true, amountUSD: 30,
          receiptId: 'receipt_atomic_paid', fundingReceiptId: 'receipt_atomic_paid',
          receiptIds: ['receipt_atomic_paid'], linkedDeliveryReceiptId: '',
          receiptAllocations: [{ receiptId: 'receipt_atomic_paid', amountUSD: 30 }],
          dueAllocations: [], dueAmountToUseUSD: 0, _lastModified: 201
        }
      }],
      replayed: false
    });
    assert(await saving === true, 'settlement updateRecord did not report success');
    assert(S.receipts[0].status === 'Paid' && S.receipts[0]._lastModified === 101,
      'authoritative Paid receipt was not installed');
    assert(S.ads[0].paymentStatus === 'paid' && S.ads[0].dueAllocations.length === 0,
      'authoritative linked ad was not installed with the receipt');
    assert(S.ads[0].receiptAllocations[0].receiptId === 'receipt_atomic_paid',
      'due allocation was not reclassified into the paid receipt allocation');
  } finally {
    sandbox.apiSettleReceipt = originalApiSettleReceipt;
    S.serverMode = originalServerMode;
    seedBusinessData();
  }
});

console.log('\n=== NEW RECEIPT CUSTOMER WARNINGS: debt and existing balance ===');

function seedReceiptCustomerRiskData() {
  S.language = 'en';
  S.defaultExchangeRate = 10;
  S.customers = [
    { id: 'customer-risk', name: 'Risk Customer', platform: 'Facebook', phones: ['0910000000'], createdBy: 'u-emp' },
    { id: 'customer-clean', name: 'Clean Customer', platform: 'Facebook', phones: ['0920000000'], createdBy: 'u-emp' },
    { id: 'customer-other', name: 'Other Customer', platform: 'Facebook', phones: ['0930000000'], createdBy: 'u-other' }
  ];
  const receipt = (id, extra = {}) => ({
    id, customerId: 'customer-risk', amountUSD: 10, amountLocal: 100, exchangeRate: 10,
    status: 'Paid', isPaid: true, payments: [], transfers: [], createdAt: '2026-07-22T00:00:00Z',
    createdBy: 'u-emp', ...extra
  });
  S.receipts = [
    receipt('risk-debt-current', { serialNumber: 'DEBT-CURRENT', status: 'Not Paid', isPaid: false, amountUSD: 30, amountLocal: 300, statusDetail: { notPaidCollection: 'office' } }),
    receipt('risk-debt-legacy', { serialNumber: 'DEBT-LEGACY', customerId: '', customer: 'customer-risk', status: 'Pending', isPaid: false, amountUSD: 8, amountLocal: 80, statusDetail: { notPaidCollection: 'shop' } }),
    receipt('risk-debt-conflict', { serialNumber: 'DEBT-CONFLICT', status: 'Not Paid', isPaid: false, amountUSD: 20, amountLocal: 200, debtAmountUSD: 100, debtAmountLocal: 500, exchangeRate: 10, statusDetail: { notPaidCollection: 'delivery' } }),
    receipt('risk-debt-zero', { serialNumber: 'DEBT-ZERO', status: 'Not Paid', isPaid: false, amountUSD: 0, amountLocal: 0, debtAmountUSD: 0, debtAmountLocal: 0, statusDetail: { notPaidCollection: 'delivery' } }),
    receipt('risk-debt-operational-partial', { serialNumber: 'DEBT-OPERATIONAL-PARTIAL', status: 'Not Paid', isPaid: false, amountUSD: 30, amountLocal: 300, debtAmountUSD: 30, debtAmountLocal: 300, exchangeRate: 10, collected: true, collectedAmount: 200, statusDetail: { notPaidCollection: 'delivery' } }),
    receipt('risk-debt-operational-collected', { serialNumber: 'DEBT-OPERATIONAL-COLLECTED', status: 'Not Paid', isPaid: false, amountUSD: 30, amountLocal: 300, collected: true, statusDetail: { notPaidCollection: 'shop' } }),
    receipt('risk-debt-canceled', { serialNumber: 'DEBT-CANCELED', status: 'Not Paid', isPaid: false, deliveryStatus: 'Canceled', statusDetail: { notPaidCollection: 'delivery' } }),
    receipt('risk-lost', { serialNumber: 'LOST', status: 'Lost', isPaid: false }),
    receipt('risk-transfer', { serialNumber: 'TRANSFER', status: 'Not Paid', isPaid: false, receiptType: 'TRANSFER_IN' }),
    receipt('risk-paid-unused', { serialNumber: 'PAID-UNUSED', amountUSD: 20, amountLocal: 200 }),
    receipt('risk-paid-partial', { serialNumber: 'PAID-PARTIAL', amountUSD: 10, amountLocal: 100 }),
    receipt('risk-paid-full', { serialNumber: 'PAID-FULL', amountUSD: 5, amountLocal: 50 }),
    receipt('risk-paid-dust', { serialNumber: 'PAID-DUST', amountUSD: 0.004, amountLocal: 0.04 }),
    receipt('risk-deleted', { serialNumber: 'DELETED', status: 'Not Paid', isPaid: false, _deleted: true }),
    receipt('risk-other-customer', { serialNumber: 'OTHER-CUSTOMER', customerId: 'customer-other', status: 'Not Paid', isPaid: false }),
    receipt('risk-hidden-owner', { serialNumber: 'HIDDEN-OWNER', amountUSD: 99, amountLocal: 990, createdBy: 'u-other' })
  ];
  S.ads = [
    { id: 'risk-ad-partial', customerId: 'customer-risk', amountUSD: 4, paymentStatus: 'paid', receiptAllocations: [{ receiptId: 'risk-paid-partial', amountUSD: 4 }], dueAllocations: [], createdBy: 'u-emp' },
    { id: 'risk-ad-full', customerId: 'customer-risk', amountUSD: 5, paymentStatus: 'paid', receiptAllocations: [{ receiptId: 'risk-paid-full', amountUSD: 5 }], dueAllocations: [], createdBy: 'u-emp' }
  ];
  S.pages = [];
}

check('warning classifier finds real debt and cent-positive paid balance without false positives', () => {
  try {
    seedReceiptCustomerRiskData();
    loginAs(ADMIN);
    const notices = sandbox.getReceiptCustomerRiskNotices('customer-risk');
    const ids = notices.map(notice => notice.receipt.id).sort();
    assert(ids.join(',') === ['risk-debt-conflict', 'risk-debt-current', 'risk-debt-legacy', 'risk-debt-operational-collected', 'risk-debt-operational-partial', 'risk-hidden-owner', 'risk-paid-partial', 'risk-paid-unused'].sort().join(','), `wrong warning receipts: ${ids.join(',')}`);
    assert(notices.filter(notice => notice.kind === 'debt').length === 5, 'debt section count is wrong');
    assert(notices.find(notice => notice.receipt.id === 'risk-debt-conflict')?.cents === 5000, 'conflicting legacy debt fields did not follow the authoritative local/rate value');
    assert(notices.find(notice => notice.receipt.id === 'risk-debt-operational-partial')?.cents === 3000 && notices.find(notice => notice.receipt.id === 'risk-debt-operational-collected')?.cents === 3000, 'operational collection incorrectly hid or reduced a still-Not-Paid customer debt');
    assert(notices.find(notice => notice.receipt.id === 'risk-paid-partial')?.cents === 600, 'partial paid balance did not subtract ad usage');
    assert(!ids.includes('risk-paid-full') && !ids.includes('risk-paid-dust'), 'fully used or sub-cent paid balance triggered a warning');
    assert(!ids.includes('risk-debt-zero') && !ids.includes('risk-debt-canceled') && !ids.includes('risk-lost') && !ids.includes('risk-transfer') && !ids.includes('risk-deleted'), 'zero or historical non-debt receipt triggered a warning');
    assert(sandbox.getReceiptCustomerRiskNotices('customer-clean').length === 0, 'clean customer triggered a warning');

    loginAs(employee({ customers: ['viewOwn'], receipts: ['viewOwn', 'add'] }));
    const ownIds = sandbox.getReceiptCustomerRiskNotices('customer-risk').map(notice => notice.receipt.id);
    assert(!ownIds.includes('risk-hidden-owner'), 'viewOwn warning leaked another creator receipt');
    assert(!ownIds.includes('risk-other-customer'), 'warning included another customer receipt');

    loginAs(employee({ customers: ['viewOwn'], receipts: ['add'] }));
    assert(sandbox.getReceiptCustomerRiskNotices('customer-risk').length === 0, 'warning leaked receipt details without receipt view permission');
  } finally {
    seedBusinessData();
  }
});

check('new receipt selection requires explicit acknowledgement, escapes data, and edit selection stays quiet', () => {
  const originalGetElementById = sandbox.document.getElementById;
  const originalAppendChild = sandbox.document.body.appendChild;
  let appendedWarning = null;
  const elements = new Map();
  const element = value => {
    const item = makeElement();
    item.value = value || '';
    item.isConnected = true;
    item.removeAttribute = () => {};
    return item;
  };
  try {
    loginAs(ADMIN);
    S.language = 'en';
    S.activeModal = 'receipt';
    S.customers = [
      { id: 'customer-risk-ui', name: 'Customer <img src=x onerror=boom>', platform: 'Facebook', phones: ['0912345678'], createdBy: 'u-admin' },
      { id: 'customer-clean-ui', name: 'Clean Customer', platform: 'Facebook', phones: ['0922345678'], createdBy: 'u-admin' }
    ];
    S.receipts = [
      {
        id: 'risk-paid-ui', customerId: 'customer-risk-ui', serialNumber: '<svg onload=boom>',
        amountUSD: 20, amountLocal: 200, exchangeRate: 10, status: 'Paid', isPaid: true,
        payments: [], transfers: [], createdBy: 'u-admin'
      },
      {
        id: 'risk-debt-ui', customerId: 'customer-risk-ui', serialNumber: 'DEBT-UI',
        amountUSD: 20, amountLocal: 200, debtAmountUSD: 20, debtAmountLocal: 200,
        exchangeRate: 10, status: 'Not Paid', isPaid: false,
        statusDetail: { notPaidCollection: 'delivery' }, payments: [], transfers: [], createdBy: 'u-admin'
      }
    ];
    S.ads = [];

    elements.set('app-modal', element());
    elements.set('receipt-editing-id', element(''));
    elements.set('receipt-customer-id', element(''));
    elements.set('receipt-customer-name', element(''));
    elements.set('receipt-phone-search', element(''));
    elements.set('receipt-phone-dropdown', element(''));
    sandbox.document.getElementById = id => elements.get(id) || null;
    sandbox.document.body.appendChild = item => {
      appendedWarning = item;
      item.isConnected = true;
      item.remove = () => { elements.delete(item.id); item.isConnected = false; };
      elements.set(item.id, item);
    };

    assert(sandbox.selectReceiptPhone('0912345678', 'customer-risk-ui') === true, 'new receipt customer was not selected');
    assert(appendedWarning?.id === 'receipt-customer-risk-warning', 'risk dialog did not open');
    assert(appendedWarning.innerHTML.includes('Unpaid debt receipts (1)'), 'debt section is missing');
    assert(appendedWarning.innerHTML.includes('Paid receipts with balance (1)'), 'paid balance section is missing');
    assert(appendedWarning.innerHTML.includes('&lt;img src=x onerror=boom&gt;') && !appendedWarning.innerHTML.includes('<img src=x onerror=boom>'), 'customer name was not escaped');
    assert(appendedWarning.innerHTML.includes('&lt;svg onload=boom&gt;') && !appendedWarning.innerHTML.includes('<svg onload=boom>'), 'receipt number was not escaped');
    assert(appendedWarning.innerHTML.includes('data-receipt-id="risk-paid-ui"') && appendedWarning.innerHTML.includes('this.dataset.receiptId'), 'exact receipt action is missing or unsafe');

    sandbox.acknowledgeReceiptCustomerRiskWarning();
    assert(sandbox.requireReceiptCustomerRiskAcknowledgement('customer-risk-ui') === false, 'unchanged acknowledgement did not persist for this form');

    assert(sandbox.requireReceiptCustomerRiskAcknowledgement('customer-clean-ui') === false, 'clean customer unexpectedly opened a warning');
    assert(sandbox.requireReceiptCustomerRiskAcknowledgement('customer-risk-ui') === true, 'acknowledgement survived switching to another customer');
    sandbox.acknowledgeReceiptCustomerRiskWarning();

    S.receipts[1].statusDetail.notPaidCollection = 'shop';
    assert(sandbox.requireReceiptCustomerRiskAcknowledgement('customer-risk-ui') === true, 'debt-source change did not invalidate acknowledgement');
    sandbox.acknowledgeReceiptCustomerRiskWarning();

    S.receipts[0].amountUSD = 21;
    assert(sandbox.requireReceiptCustomerRiskAcknowledgement('customer-risk-ui') === true, 'live balance change did not invalidate acknowledgement');
    sandbox.cancelReceiptCustomerRiskWarning();
    assert(elements.get('receipt-customer-id').value === '' && elements.get('receipt-customer-name').value === '' && elements.get('receipt-phone-search').value === '', 'safe cancel left the risky customer selected');

    appendedWarning = null;
    elements.get('receipt-editing-id').value = 'risk-paid-ui';
    assert(sandbox.selectReceiptPhone('0912345678', 'customer-risk-ui') === true, 'edit customer was not pre-populated');
    assert(appendedWarning === null, 'editing an existing receipt opened the new-receipt warning');
  } finally {
    try { sandbox.resetReceiptCustomerRiskWarningState(); } catch (_) {}
    sandbox.document.getElementById = originalGetElementById;
    sandbox.document.body.appendChild = originalAppendChild;
    S.activeModal = null;
    seedBusinessData();
  }
});

console.log('\n=== RELATIONSHIP NAVIGATION: customer -> receipts -> ads ===');

function seedRelationshipNavigationData() {
  S.language = 'en';
  S.customerSearch = '';
  S.customerSort = 'newest';
  S.customerFinancialFilter = 'all';
  S.receiptSearch = '';
  S.receiptCustomerFilter = '';
  S.receiptRecordFilter = '';
  S.receiptStatusFilter = 'all';
  S.receiptPaymentFilter = 'all';
  S.receiptDateFilter = 'all';
  S.receiptDebtFilter = 'all';
  S.receiptCollectedFilter = 'all';
  S.receiptSortBy = 'newest';
  S.adSearch = '';
  S.adReceiptFilter = '';
  S.adFilters = { status: 'all', payment: 'all', page: 'all' };
  S.customers = [
    { id: 'customer-own', name: 'Own Linked Customer', platform: 'Facebook', phones: [], profileLinks: [], createdBy: 'u-emp' },
    { id: 'customer-other', name: 'Other Linked Customer', platform: 'Facebook', phones: [], profileLinks: [], createdBy: 'u-other' }
  ];
  const receipt = (id, serial, extra = {}) => ({
    id, finalReceiptNo: serial, amountUSD: 10, amountLocal: 95, exchangeRate: 9.5,
    status: 'Paid', isPaid: true, payments: [], transfers: [], createdDate: '2026-07-22T00:00:00Z',
    createdBy: 'u-emp', ...extra
  });
  S.receipts = [
    receipt('receipt-modern', 'MODERN-LINK', { customerId: 'customer-own' }),
    receipt('receipt-legacy', 'LEGACY-LINK', { customer: 'customer-own' }),
    receipt('receipt-stale', 'STALE-LEGACY', { customerId: 'customer-other', customer: 'customer-own' }),
    receipt('receipt-other-owner', 'OTHER-OWNER', { customerId: 'customer-own', createdBy: 'u-other' })
  ];
  S.pages = [];
  S.ads = [
    { id: 'ad-due-own', customerId: 'customer-own', amountUSD: 5, status: 'Active', paymentStatus: 'not_paid', createdBy: 'u-emp', receiptIds: ['receipt-modern'], dueAllocations: [{ receiptId: 'receipt-modern', amountUSD: 5 }] },
    { id: 'ad-multi-own', customerId: 'customer-own', amountUSD: 5, status: 'Active', paymentStatus: 'paid', createdBy: 'u-emp', receiptIds: ['receipt-modern', 'receipt-legacy'] },
    { id: 'ad-other-owner', customerId: 'customer-own', amountUSD: 5, status: 'Active', paymentStatus: 'paid', createdBy: 'u-other', receiptId: 'receipt-modern' }
  ];
}

check('receipt history links cover modern, legacy, due, multi-receipt, stop and refund shapes', () => {
  assert(sandbox.getReceiptCustomerReferenceId({ customerId: 'new-owner', customer: 'old-owner' }) === 'new-owner', 'legacy customer overrode customerId');
  assert(sandbox.getReceiptCustomerReferenceId({ customer: 'legacy-owner' }) === 'legacy-owner', 'legacy customer fallback disappeared');
  const rid = 'receipt-target';
  [
    { receiptId: rid }, { fundingReceiptId: rid }, { linkedDeliveryReceiptId: rid },
    { receiptIds: ['other', rid] }, { receiptAllocations: [{ receiptId: rid }] },
    { dueAllocations: [{ receiptId: rid }] }, { mergedPaidAllocations: [{ receiptId: rid }] },
    { linkedReceiptId: rid },
    { stopAllocationBaseline: { receipt: [{ receiptId: rid }], due: [], merged: [] } },
    { stopAllocationBaseline: { dueLegacyReceiptId: rid, dueLegacy: 5 } },
    { refundAllocationBaseline: [{ receiptId: rid }] },
    { refundDueBaseline: [{ receiptId: rid }] }
  ].forEach((ad, index) => assert(sandbox.isAdLinkedToReceipt(ad, rid), `supported receipt link shape ${index} was missed`));
  assert(!sandbox.isAdLinkedToReceipt({ settledReceiptId: rid }, rid), 'settled audit history became a current link');
  assert(sandbox.getAdLinkedReceiptIds({ receiptId: rid, receiptIds: [rid], dueAllocations: [{ receiptId: rid }] }).length === 1, 'one ad/receipt link was counted more than once');
});

check('customer receipt navigation is touch-safe, counted, scoped, and URL-addressable', () => {
  seedRelationshipNavigationData();
  const originalPushState = sandbox.window.history.pushState;
  const originalPath = sandbox.window.location.pathname;
  const originalSearch = sandbox.window.location.search;
  let pushedUrl = '';
  sandbox.window.history.pushState = (_state, _title, url) => { pushedUrl = String(url); };
  try {
    loginAs(employee({ customers: ['viewOwn'], receipts: ['viewOwn'], ads: ['viewOwn'] }));
    const card = visible(sandbox.renderCustomersGrid([S.customers[0]]));
    assert(card.includes('data-action="view-customer-receipts"'), 'customer receipt button is missing');
    assert(card.includes('min-h-11'), 'customer receipt button is too small for phone taps');
    assert(card.includes('Receipts 2'), 'permission-scoped modern/legacy receipt count is wrong');

    S.receiptCustomerFilter = 'do-not-change';
    assert(sandbox.openCustomerReceipts('customer-other') === false, 'viewOwn user opened another customer');
    assert(S.receiptCustomerFilter === 'do-not-change', 'denied navigation changed the active filter');

    S.receiptSearch = 'stale';
    sandbox.window.location.pathname = '/customers';
    sandbox.window.location.search = '';
    assert(sandbox.openCustomerReceipts('customer-own') === true, 'own customer receipts did not open');
    assert(S.receiptCustomerFilter === 'customer-own' && S.receiptSearch === '', 'relationship navigation did not reset stale receipt filters');
    assert(pushedUrl.includes('/receipts?customer=customer-own'), `customer relationship URL is missing: ${pushedUrl}`);

    const receiptsHtml = visible(sandbox.renderReceiptsView());
    assert(receiptsHtml.includes('MODERN-LINK') && receiptsHtml.includes('LEGACY-LINK'), 'modern or legacy customer receipt is missing');
    assert(!receiptsHtml.includes('STALE-LEGACY'), 'stale legacy customer field defeated authoritative customerId');
    assert(!receiptsHtml.includes('OTHER-OWNER'), 'viewOwn receipt scope leaked another creator');
    assert(receiptsHtml.includes('Ads 2'), 'permission-scoped linked ad count is wrong');

    loginAs(employee({ customers: ['viewOwn'] }));
    const deniedCard = visible(sandbox.renderCustomersGrid([S.customers[0]]));
    assert(!deniedCard.includes('data-action="view-customer-receipts"'), 'receipt relationship leaked without receipt view permission');
  } finally {
    sandbox.window.history.pushState = originalPushState;
    sandbox.window.location.pathname = originalPath;
    sandbox.window.location.search = originalSearch;
    seedBusinessData();
    S.receiptCustomerFilter = '';
    S.receiptRecordFilter = '';
    S.adReceiptFilter = '';
  }
});

check('receipt ad navigation is permission-scoped, URL-addressable, and restores with Back', () => {
  seedRelationshipNavigationData();
  const originalPushState = sandbox.window.history.pushState;
  const originalPath = sandbox.window.location.pathname;
  const originalSearch = sandbox.window.location.search;
  let pushedUrl = '';
  sandbox.window.history.pushState = (_state, _title, url) => { pushedUrl = String(url); };
  try {
    loginAs(employee({ customers: ['viewOwn'], receipts: ['viewOwn'], ads: ['viewOwn'] }));
    S.adReceiptFilter = 'do-not-change';
    assert(sandbox.openReceiptAds('receipt-other-owner') === false, 'viewOwn user opened another creator receipt');
    assert(S.adReceiptFilter === 'do-not-change', 'denied receipt navigation changed the active filter');

    sandbox.window.location.pathname = '/receipts';
    sandbox.window.location.search = '?customer=customer-own';
    assert(sandbox.openReceiptAds('receipt-modern') === true, 'own receipt ads did not open');
    assert(S.adReceiptFilter === 'receipt-modern', 'receipt relationship filter was not set');
    assert(pushedUrl.includes('/ads?receipt=receipt-modern'), `receipt relationship URL is missing: ${pushedUrl}`);
    assert(sandbox.getFilteredAds().map(ad => ad.id).sort().join(',') === 'ad-due-own,ad-multi-own', 'linked ads were not scoped before relationship filtering');

    sandbox.window.location.search = '?customer=customer-own';
    sandbox.restoreViewStateFromUrl('receipts');
    assert(S.receiptCustomerFilter === 'customer-own', 'Back did not restore the customer relationship');
    assert(S.receiptRecordFilter === '', 'customer-only URL kept a stale exact receipt filter');
    sandbox.window.location.search = '?customer=customer-own&receipt=receipt-legacy';
    sandbox.restoreViewStateFromUrl('receipts');
    assert(S.receiptCustomerFilter === 'customer-own' && S.receiptRecordFilter === 'receipt-legacy', 'exact receipt URL did not restore both relationships');
    sandbox.window.location.search = '?receipt=receipt-legacy';
    sandbox.restoreViewStateFromUrl('ads');
    assert(S.adReceiptFilter === 'receipt-legacy', 'Back did not restore the receipt relationship');
    sandbox.window.location.search = '';
    sandbox.restoreViewStateFromUrl('receipts');
    sandbox.restoreViewStateFromUrl('ads');
    assert(S.receiptCustomerFilter === '' && S.receiptRecordFilter === '' && S.adReceiptFilter === '', 'Back to an unfiltered URL kept a stale relationship');
  } finally {
    sandbox.window.history.pushState = originalPushState;
    sandbox.window.location.pathname = originalPath;
    sandbox.window.location.search = originalSearch;
    seedBusinessData();
    S.receiptCustomerFilter = '';
    S.receiptRecordFilter = '';
    S.adReceiptFilter = '';
  }
});

check('warning receipt links open one exact permission-scoped receipt', () => {
  seedRelationshipNavigationData();
  const originalPushState = sandbox.window.history.pushState;
  const originalPath = sandbox.window.location.pathname;
  const originalSearch = sandbox.window.location.search;
  let pushedUrl = '';
  sandbox.window.history.pushState = (_state, _title, url) => { pushedUrl = String(url); };
  try {
    loginAs(employee({ customers: ['viewOwn'], receipts: ['viewOwn'], ads: ['viewOwn'] }));
    S.receiptCustomerFilter = 'unchanged-customer';
    S.receiptRecordFilter = 'unchanged-receipt';
    assert(sandbox.openReceiptRecord('receipt-other-owner') === false, 'viewOwn user opened another creator receipt');
    assert(S.receiptCustomerFilter === 'unchanged-customer' && S.receiptRecordFilter === 'unchanged-receipt', 'denied exact navigation changed filters');
    assert(sandbox.openReceiptRecord('unsafe id!') === false, 'unsafe receipt id was accepted');

    sandbox.window.location.pathname = '/customers';
    sandbox.window.location.search = '';
    assert(sandbox.openReceiptRecord('receipt-modern') === true, 'own receipt did not open');
    assert(S.receiptCustomerFilter === 'customer-own' && S.receiptRecordFilter === 'receipt-modern', 'exact receipt/customer filters were not set');
    assert(pushedUrl.includes('/receipts?') && pushedUrl.includes('customer=customer-own') && pushedUrl.includes('receipt=receipt-modern'), `exact receipt URL is missing: ${pushedUrl}`);

    const exactHtml = visible(sandbox.renderReceiptsView());
    assert(exactHtml.includes('MODERN-LINK'), 'target receipt is missing from exact view');
    assert(!exactHtml.includes('LEGACY-LINK'), 'exact view included another customer receipt');
    assert(exactHtml.includes('data-receipt-id="receipt-modern"'), 'target receipt card has no exact record hook');
    assert(exactHtml.includes('onclick="clearReceiptRecordFilter()"'), 'exact receipt filter cannot be cleared');
  } finally {
    sandbox.window.history.pushState = originalPushState;
    sandbox.window.location.pathname = originalPath;
    sandbox.window.location.search = originalSearch;
    seedBusinessData();
    S.receiptCustomerFilter = '';
    S.receiptRecordFilter = '';
    S.adReceiptFilter = '';
  }
});

// ---------- report ----------
async function reportResults() {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
      console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (failures.length) {
    console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`ALL ${passed} PERMISSION TESTS PASSED`);
}

reportResults().catch((error) => {
  console.error(error);
  process.exit(1);
});
