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
  '({ state, PERMISSION_MODULES, Security, _serverLiveSync, IconQueue })',
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
    selector === '.p-4.md\\:p-8' ? viewContainer : null
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
  const stop = sandbox.getAdStopAttempt(ad, 1250);
  const stopRetry = sandbox.getAdStopAttempt(ad, 1250);
  assert(stop === stopRetry && stop.idempotencyKey.length >= 8, 'ad stop retry key was not stable');
  sandbox.completeAdStopAttempt(stop);
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

console.log('\n=== RECEIPT PHOTOS: visible and safely clickable inside/outside the form ===');

const SAFE_RECEIPT_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SAFE_RECEIPT_JPEG = 'data:image/jpeg;base64,/9j/2Q==';

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
    receiptDateFilter: 'all', receiptCollectedFilter: 'all', receiptSortBy: 'newest'
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

// ---------- report ----------
console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`ALL ${passed} PERMISSION TESTS PASSED`);
