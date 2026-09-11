const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Minimal browser surface for behavior tests against the authoritative source
// fragments. Deliberately do not run init or depend on regenerated script.js.
module.exports = function loadBrowserSource() {
  const element = () => ({
    style: {}, dataset: {}, value: '', files: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  });
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key), clear: () => values.clear(), key: () => null, length: 0 };
  };
  const document = {
    readyState: 'loading', visibilityState: 'visible', body: element(), head: element(), documentElement: element(),
    createElement: element, createTextNode: element, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, cookie: ''
  };
  const window = {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/', search: '', href: 'http://localhost/', protocol: 'http:' },
    history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: 'node-test', onLine: true, clipboard: {}, credentials: {} },
    localStorage: storage(), sessionStorage: storage(),
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    isSecureContext: true, innerWidth: 1280, innerHeight: 900,
    crypto: { getRandomValues: value => value.fill(1), randomUUID: () => 'test-uuid', subtle: {} },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async () => { throw new Error('Unexpected network request in behavior test'); }
  };
  const sandbox = {
    window, document, navigator: window.navigator, location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage, crypto: window.crypto,
    fetch: window.fetch, URL: window.URL, Blob: function () {}, indexedDB: undefined, isSecureContext: true,
    console: { ...console, log() {}, debug() {} },
    // No background work in unit tests; awaited application functions still run normally.
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    matchMedia: window.matchMedia, addEventListener() {}, removeEventListener() {},
    alert() {}, confirm: () => true, prompt: () => null,
    lucide: { createIcons() {} },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {} }; }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));
  const source = manifest.files.map(file => fs.readFileSync(path.join(root, 'src', file), 'utf8')).join('\n');
  vm.runInContext(source, sandbox, { filename: 'src/manifest.json fragments' });
  const run = code => vm.runInContext(code, sandbox);
  const state = run('state');
  state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
  state.users = [state.currentUser];
  state.language = 'en';
  state.serverMode = false;
  state.defaultExchangeRate = 5;
  state.customers = [{ id: 'c1', name: 'Customer', createdBy: 'driver1' }];
  state.ads = [];
  state.receipts = [];
  state.pages = [];
  state.logs = [];
  sandbox.saveState = () => {};
  sandbox.showNotification = () => {};
  sandbox.forceFullRender = () => {};
  sandbox.render = () => {};
  return { sandbox, state, run };
};
