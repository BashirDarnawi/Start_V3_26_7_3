// Local mode, bug hunt 2026-11-16: iOS closes the IndexedDB connection while the app is in the
// background. If that happens during the start-up load, the collections that could not be read
// must stay protected: before the fix they were taken as empty, and the recovery flush then
// wrote the empty lists over the intact stored rows (the device's only copy).
// Runs the real src/03-storage-idb.js and src/06-persistence.js against a fake IndexedDB whose
// connection dies during the "receipts" read.
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const stores = { appData: new Map(), auditLogs: new Map(), backups: new Map() };
const seed = (name, rows) => stores.appData.set(name, { key: name, type: 'collection', data: rows, checksum: 'x', recordCount: rows.length });
seed('ads', [{ id: 'a1' }]); seed('receipts', [{ id: 'r1' }, { id: 'r2' }]); seed('customers', [{ id: 'c1' }]);
seed('pages', [{ id: 'p1' }]); seed('users', [{ id: 'u1', email: 'owner@example.com' }]);
const writes = []; const conns = []; let killOnKey = 'collection:receipts:meta';
const fakeIDB = { open() { const req = {}; setTimeout(() => {
  const dbh = { dead: false, objectStoreNames: { contains: () => true }, close() { dbh.dead = true; },
    transaction(names) {
      if (dbh.dead) { const e = new Error('The database connection is closing'); e.name = 'InvalidStateError'; throw e; }
      const tx = { error: null }; let pending = 0, finished = false;
      const settle = () => setTimeout(() => { if (finished || pending) return; finished = true; if (dbh.dead) { tx.error = new Error('Connection to Indexed Database server lost'); tx.onabort && tx.onabort(); } else tx.oncomplete && tx.oncomplete(); }, 0);
      const mk = fn => { const r = {}; pending++; setTimeout(() => { pending--; if (dbh.dead) { if (!finished) { finished = true; tx.error = new Error('Connection to Indexed Database server lost'); tx.onabort && tx.onabort(); } return; } r.result = fn(); r.onsuccess && r.onsuccess({ target: r }); settle(); }, 2); return r; };
      tx.objectStore = name => ({
        get: k => { if (k === killOnKey) { killOnKey = null; setTimeout(() => { dbh.dead = true; dbh.onclose && dbh.onclose(); }, 0); } return mk(() => stores[name].get(k)); },
        put: v => mk(() => { const k = v.key ?? v.id; stores[name].set(k, v); writes.push([k, Array.isArray(v.data) ? v.data.length : '-']); }),
        delete: k => mk(() => stores[name].delete(k)), clear: () => mk(() => stores[name].clear()), getAll: () => mk(() => [...stores[name].values()]),
        index: () => ({ openCursor: () => mk(() => null), openKeyCursor: () => mk(() => null) }) });
      settle(); return tx; } };
  conns.push(dbh); req.onsuccess && req.onsuccess({ target: { result: dbh } }); }, 1); return req; } };
const ls = new Map();
const sandbox = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {},
  indexedDB: fakeIDB, localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
  document: { addEventListener() {}, cookie: '', body: null, getElementById: () => null, visibilityState: 'visible' }, navigator: { userAgent: 'node' } };
sandbox.window = { indexedDB: fakeIDB, addEventListener() {} };
vm.createContext(sandbox);
const prelude = `
var state = { ads: [], receipts: [], customers: [], pages: [], users: [], logs: [], language: 'en', exchangeRateHistory: [] };
var Security = { generateSecureId: p => p + '-1', sanitizeObject: x => JSON.parse(JSON.stringify(x)), sanitizeInput: x => String(x), isValidRecordId: () => true };
var DataIntegrity = { calculateChecksum: () => 'x' };
var Platform = { isCapacitor: false };
function isServerModeEnabled() { return false; }
function showNotification() {}
function getVisibleRecords(a) { return a; }
var notes = [];
`;
const code = prelude + fs.readFileSync(path.join(SRC, '03-storage-idb.js'), 'utf8') + '\n' + fs.readFileSync(path.join(SRC, '06-persistence.js'), 'utf8') + `
;(async () => {
  await initIndexedDB();
  activateLocalCollectionStorage();
  await loadCollectionsFromStorage(null);
  globalThis.__afterLoad = JSON.stringify({ ads: state.ads.length, receipts: state.receipts.length, customers: state.customers.length, pages: state.pages.length, users: state.users.length, corruptFlags: ['receipts','customers','users'].map(isCollectionCorrupted) });
  await new Promise(r => setTimeout(r, 2500));
  globalThis.__done = true;
})();`;
vm.runInContext(code, sandbox);
const t = setInterval(() => { if (!sandbox.__done) return; clearInterval(t);
  const stored = Object.fromEntries(['ads', 'receipts', 'customers', 'pages', 'users'].map(k => [k, stores.appData.get(k) ? stores.appData.get(k).data.length : -1]));
  try {
    assert.equal(conns.length, 2, 'the connection was lost once and reopened');
    assert.deepEqual(stored, { ads: 1, receipts: 2, customers: 1, pages: 1, users: 1 }, 'every stored row survives the recovery flush');
    assert.deepEqual(JSON.parse(sandbox.__afterLoad).corruptFlags, [true, true, true], 'unread collections are protected from overwrite');
    assert.ok(writes.every(([key, rows]) => key === 'ads' || rows !== 0), `an empty list was written: ${JSON.stringify(writes)}`);
    console.log('Local storage loss during start-up: 4 checks passed; 0 failed');
    process.exit(0);
  } catch (error) {
    console.error('FAIL local storage loss during start-up:', error.message);
    process.exit(1);
  }
}, 100);
