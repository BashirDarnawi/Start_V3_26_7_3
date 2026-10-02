// Work-count and race regressions against authoritative browser source.
// Network and storage completions are controlled; no real server or user data.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const loadBrowserSource = require('./helpers/load-browser-source');

let passed = 0;
let failed = 0;
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function test(name, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test did not settle')), 5000); })]);
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) { failed += 1; process.exitCode = 1; console.error(`  FAIL  ${name}\n${error.stack}`); }
  finally { clearTimeout(timer); }
}
function persistenceFixture() {
  const f = loadBrowserSource();
  f.run('db = {};');
  const writes = [];
  f.sandbox.saveCollectionToIndexedDB = async (name, rows) => {
    writes.push({ name, rows: plain(rows) }); return true;
  };
  return { ...f, writes };
}
function syncFixture() {
  const f = loadBrowserSource();
  f.sandbox.isServerModeEnabled = () => true;
  f.run('SERVER_API.liveSyncEnabled = true; SERVER_API.liveSyncConcurrency = 4; _serverLiveSync.lastUsersSyncAt = Date.now(); RenderQueue.schedule = () => {};');
  f.sandbox.refreshServerDataCompatibility = async () => null;
  return f;
}
const entity = (id, version = 20) => ({ id, data: { id, name: id, _lastModified: version }, lastModified: version });
// load-browser-source stubs saveState: the snapshot tests re-evaluate the real one.
const persistenceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', '06-persistence.js'), 'utf8');
function useRealSaveState(f) {
  const at = persistenceSrc.indexOf('function saveState() {');
  f.run(persistenceSrc.slice(at, persistenceSrc.indexOf('\n}\n', at) + 2));
  return f;
}
const snapshotOf = f => JSON.parse(f.sandbox.localStorage.getItem('albayan_complete_state') || 'null');
const drain = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };
// An IndexedDB backups store with a byte quota and real transaction semantics: requests run one tick
// later, a request that throws aborts its transaction and undoes every write made in it, and a
// transaction that ends cleanly commits on its own (oncomplete).
function quotaBackupsDb(quotaBytes) {
  const fake = { rows: new Map(), otherBytes: 0, refused: 0 };
  const used = () => fake.otherBytes + [...fake.rows.values()].reduce((sum, row) => sum + row.bytes, 0);
  fake.transaction = () => {
    const tx = {}, undo = [];
    let pending = 0, failed = false, ended = false;
    const finish = () => {
      if (pending || ended) return;
      ended = true;
      setImmediate(() => {
        if (!failed) { if (tx.oncomplete) tx.oncomplete(); return; }
        undo.reverse().forEach(step => step());
        if (tx.onabort) tx.onabort();
      });
    };
    const write = (id, row) => {
      const had = fake.rows.has(id), old = fake.rows.get(id);
      undo.push(() => (had ? fake.rows.set(id, old) : fake.rows.delete(id)));
      if (row) fake.rows.set(id, row); else fake.rows.delete(id);
    };
    const request = work => {
      const req = {};
      pending += 1;
      setImmediate(() => {
        pending -= 1;
        try { req.result = work(); if (req.onsuccess) req.onsuccess({ target: req }); }
        catch (error) { req.error = error; failed = true; if (req.onerror) req.onerror({ target: req }); if (tx.onerror) tx.onerror({ target: req }); }
        finish();
      });
      return req;
    };
    const cursor = (range, direction) => {
      const req = {};
      const list = [...fake.rows.entries()].filter(([, row]) => !range || row.value.createdAt <= range.upper)
        .sort((a, b) => (a[1].value.createdAt - b[1].value.createdAt) * (direction === 'prev' ? -1 : 1));
      pending += 1;
      const step = () => setImmediate(() => {
        const entry = list.shift();
        let more = false;
        const result = entry ? { primaryKey: entry[0], key: entry[1].value.createdAt, value: entry[1].value, continue: () => { more = true; step(); } } : null;
        if (req.onsuccess) req.onsuccess({ target: { result } });
        if (!more) { pending -= 1; finish(); }
      });
      step();
      return req;
    };
    const store = {
      put: value => request(() => {
        const bytes = JSON.stringify(value).length;
        if (used() - (fake.rows.get(value.id)?.bytes || 0) + bytes > quotaBytes) {
          fake.refused += 1;
          throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
        }
        write(value.id, { value, bytes });
        return value.id;
      }),
      clear: () => request(() => { for (const id of [...fake.rows.keys()]) write(id, null); }),
      delete: id => request(() => { write(id, null); }),
      index: () => ({ openCursor: cursor, openKeyCursor: cursor })
    };
    tx.objectStore = () => store;
    setImmediate(finish);  // a transaction given no request commits at once
    return tx;
  };
  return fake;
}

async function main() {
  await test('edits before a collection write starts need 2 writes, not 3, and save latest records', async () => {
    const f = persistenceFixture();
    const first = deferred();
    const save = f.sandbox.saveCollectionToIndexedDB;
    f.sandbox.saveCollectionToIndexedDB = async (name, rows) => {
      const result = await save(name, rows);
      if (name === 'ads') await first.promise;
      return result;
    };
    f.state.receipts = [{ id: 'r1', amountUSD: 20 }];
    f.sandbox.markCollectionDirty('ads'); f.sandbox.markCollectionDirty('receipts');
    const flush = f.sandbox.flushDirtyCollections();
    f.state.receipts[0].amountUSD = 30;
    f.state.receipts.push({ id: 'r2', amountUSD: 5 });
    f.sandbox.markCollectionDirty('receipts');
    first.resolve(); await flush;
    console.log(`        Collection writes: ${f.writes.length}; receipts: ${f.writes.filter(write => write.name === 'receipts').length}`);
    assert.deepEqual(f.writes.map(write => write.name), ['ads', 'receipts']);
    assert.deepEqual(f.writes[1].rows, f.state.receipts);
    assert.equal(f.run('idbSync.dirty.size'), 0);
  });
  await test('edits during the same collection write retain the required second durable save', async () => {
    const f = persistenceFixture(); const first = deferred();
    const save = f.sandbox.saveCollectionToIndexedDB;
    f.state.receipts = [{ id: 'r1', amountUSD: 20 }];
    f.sandbox.saveCollectionToIndexedDB = async (name, rows) => {
      const result = await save(name, rows);
      if (f.writes.length === 1) await first.promise;
      return result;
    };
    f.sandbox.markCollectionDirty('receipts');
    const flush = f.sandbox.flushDirtyCollections();
    f.state.receipts[0].amountUSD = 30;
    f.sandbox.markCollectionDirty('receipts');
    first.resolve(); await flush;
    assert.deepEqual(f.writes.map(write => write.rows[0].amountUSD), [20, 30]);
  });
  await test('many pending edits coalesce without losing a different collection', async () => {
    const f = persistenceFixture(); const first = deferred();
    const save = f.sandbox.saveCollectionToIndexedDB;
    f.sandbox.saveCollectionToIndexedDB = async (name, rows) => {
      const result = await save(name, rows);
      if (name === 'ads') await first.promise;
      return result;
    };
    f.sandbox.markCollectionDirty('ads'); f.sandbox.markCollectionDirty('receipts');
    const flush = f.sandbox.flushDirtyCollections();
    for (let i = 0; i < 100; i += 1) f.sandbox.markCollectionDirty('receipts');
    f.sandbox.markCollectionDirty('pages'); first.resolve(); await flush;
    assert.deepEqual(f.writes.map(write => write.name), ['ads', 'receipts', 'pages']);
  });
  await test('failed persistence retains dirty marker and bounded retry', async () => {
    const f = persistenceFixture(); const timers = [];
    f.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    f.sandbox.saveCollectionToIndexedDB = async () => false;
    f.sandbox.markCollectionDirty('receipts'); await f.sandbox.flushDirtyCollections();
    assert.equal(f.run("idbSync.dirty.has('receipts')"), true);
    assert.equal(timers.at(-1).ms, 2000);
    f.sandbox.saveCollectionToIndexedDB = async (name, rows) => { f.writes.push({ name, rows }); return true; };
    timers.at(-1).fn(); await settle();
    assert.equal(f.writes.length, 1); assert.equal(f.run('idbSync.dirty.size'), 0);
  });
  await test('scope change discards old batch and does not write its remaining collections', async () => {
    const f = persistenceFixture(); const first = deferred();
    f.sandbox.saveCollectionToIndexedDB = async name => { f.writes.push(name); await first.promise; return false; };
    f.sandbox.markCollectionDirty('ads'); f.sandbox.markCollectionDirty('receipts');
    const flush = f.sandbox.flushDirtyCollections();
    f.sandbox.resetDirtyCollectionQueueForScopeChange(); first.resolve(); await flush;
    assert.deepEqual(f.writes, ['ads']); assert.equal(f.run('idbSync.dirty.size'), 0);
  });
  await test('corruption protection and lost writer lock still block persistence', async () => {
    const f = persistenceFixture();
    f.sandbox.markCollectionCorrupted('receipts'); f.sandbox.markCollectionDirty('receipts');
    assert.equal(f.run('idbSync.dirty.size'), 0);
    f.sandbox.markCollectionDirty('ads'); f.sandbox.isAnotherTabWriter = () => true;
    await f.sandbox.flushDirtyCollections(); assert.equal(f.writes.length, 0);
    assert.equal(f.run("idbSync.dirty.has('ads')"), true);
  });

  for (const oldFails of [false, true]) {
    await test(`stopped tick ${oldFails ? 'failure' : 'completion'} cannot unlock the replacement tick or set its badge/backoff`, async () => {
      const f = syncFixture(); const old = deferred(); const fresh = deferred(); const badges = [];
      let calls = 0;
      f.sandbox.serverLiveSyncOnce = () => (++calls === 1 ? old : fresh).promise;
      f.sandbox.updateSyncIndicator = status => badges.push(status);
      const oldTick = f.sandbox.serverLiveSyncTick();
      const oldWait = f.run('_serverLiveSync.tickPromise');
      f.sandbox.stopServerLiveSync();
      const freshTick = f.sandbox.serverLiveSyncTick();
      const freshWait = f.run('_serverLiveSync.tickPromise');
      if (oldFails) old.reject(new Error('old disconnected request')); else old.resolve({ ok: true });
      await oldTick; await oldWait;
      const inFlight = f.run('_serverLiveSync.inFlight');
      const currentWait = f.run('_serverLiveSync.tickPromise');
      const streak = f.run('_serverLiveSync.failStreak');
      const afterOldBadges = [...badges];
      const thirdTick = f.sandbox.serverLiveSyncTick(); // must not start a third overlapping tick
      fresh.resolve({ ok: true }); await freshTick; await freshWait; await thirdTick;
      console.log(`        Concurrent tick starts before replacement settles: ${calls}`);
      assert.equal(inFlight, true); assert.equal(currentWait, freshWait);
      assert.equal(streak, 0); assert.deepEqual(afterOldBadges, ['syncing', 'syncing']);
      assert.equal(calls, 2); assert.equal(f.run('_serverLiveSync.inFlight'), false);
    });
  }
  await test('ordinary failed and successful ticks retain bounded backoff and badge behavior', async () => {
    const f = syncFixture(); const badges = [];
    f.sandbox.updateSyncIndicator = status => badges.push(status);
    f.sandbox.serverLiveSyncOnce = async () => ({ ok: false });
    await f.sandbox.serverLiveSyncTick();
    assert.equal(f.run('_serverLiveSync.failStreak'), 1);
    assert.ok(f.run('_serverLiveSync.nextAllowedAt') > Date.now());
    f.sandbox.serverLiveSyncOnce = async () => ({ ok: true }); await f.sandbox.serverLiveSyncTick();
    assert.equal(f.run('_serverLiveSync.failStreak'), 0);
    assert.equal(f.run('_serverLiveSync.nextAllowedAt'), 0);
    assert.deepEqual(badges, ['syncing', 'error', 'syncing', 'synced']);
  });
  await test('a backwards clock step never suspends polling: a wait past the 60 s cap polls at once', async () => {
    const f = syncFixture(); let callback = null; let ticks = 0;
    f.sandbox.setInterval = fn => { callback = fn; return 1; };
    f.sandbox.serverLiveSyncTick = async () => { ticks++; };
    f.sandbox.startServerLiveSync();
    assert.equal(typeof callback, 'function');
    const base = ticks; // the start itself fires one catch-up tick
    f.run('_serverLiveSync.nextAllowedAt = Date.now() + 30000'); callback();
    assert.equal(ticks - base, 0);
    f.run('_serverLiveSync.nextAllowedAt = Date.now() + 3600000'); callback();
    assert.equal(ticks - base, 1);
  });
  await test('a native write that hits the JS deadline is not re-sent: the abort carries noRetry (no fake HTTP status) and the native budget is shorter', async () => {
    const f = syncFixture(); const requests = [];
    f.sandbox.DOMException = DOMException;
    f.run("Platform.detect = () => ({ isCapacitor: true, isIOS: true, isAndroid: false, isWeb: false, isNative: true })");
    f.sandbox.window.Capacitor = { Plugins: { CapacitorHttp: { request: options => { requests.push(options); return new Promise(() => {}); } } } };
    const controller = new AbortController();
    let calls = 0;
    const pending = f.sandbox.withRetry(() => { calls += 1; return f.sandbox._nativeAwareFetch('https://app.example/api/x', { method: 'POST', headers: {} }, { a: 1 }, controller, 5000); });
    controller.abort();
    const error = await pending.then(() => null, e => e);
    assert.equal(error?.name, 'AbortError'); assert.equal(error?.status, undefined); assert.equal(error?.noRetry, true);
    assert.equal(calls, 1, 'withRetry sent the write a second time');
    assert.equal(requests.length, 1); assert.equal(requests[0].connectTimeout, 4000); assert.equal(requests[0].readTimeout, 4000);
  });
  // Bug hunt r34 (R4-concurrency-idempotency-5): a create with photos had a fixed 20 s budget; it now
  // gets the 90 s photo budget and one retry, like a photo PATCH.
  await test('R4 concurrency-idempotency-5: a create with photos gets the 90 s photo budget and one retry; small and Ads Studio creates keep theirs', async () => {
    const f = syncFixture(); const seen = [];
    f.sandbox.setTimeout = fn => { fn(); return 1; };  // withRetry's backoff runs at once
    f.sandbox.apiJson = async (path, options, timeout) => { seen.push(timeout?.timeoutMs); throw new TypeError('Load failed'); };
    const photo = `data:image/jpeg;base64,${'A'.repeat(4000)}`;
    const attempts = async (collection, record) => {
      seen.length = 0;
      const error = await f.sandbox.apiCreateEntity(collection, record).then(() => null, e => e);
      assert.equal(error?.message, 'Load failed');
      return { calls: seen.length, timeouts: [...new Set(seen)] };
    };
    assert.deepEqual(await attempts('receipts', { id: 'r1', customerId: 'c1', photos: [photo, photo] }), { calls: 2, timeouts: [90000] }, 'before: 20 s and two retries');
    assert.deepEqual(await attempts('clothesProducts', { id: 'p1', name: 'Dress', photo }), { calls: 2, timeouts: [90000] });
    assert.deepEqual(await attempts('receipts', { id: 'r2', customerId: 'c1', notes: 'x'.repeat(210 * 1024) }), { calls: 2, timeouts: [90000] }, 'a body over 200 KB');
    assert.deepEqual(await attempts('customers', { id: 'c2', name: 'Ali' }), { calls: 3, timeouts: [20000] });
    assert.deepEqual(await attempts('adCampaignRequests', { id: 'q1', creativeImages: [photo] }), { calls: 3, timeouts: [90000] });
  });
  for (const errorStatus of [0, 403, 503]) {
    await test(`stopped delta fan-out launches only 4 of 14 requests and ignores late ${errorStatus || 'successful'} results`, async () => {
      const f = syncFixture(); const pending = deferred(); const calls = [];
      f.sandbox.apiLoadCollectionSince = async name => {
        calls.push(name); await pending.promise;
        if (errorStatus) throw Object.assign(new Error('late response'), { status: errorStatus });
        return [{ id: 'stale', _lastModified: 900 }];
      };
      const sync = f.sandbox.serverLiveSyncOnce(); await settle();
      assert.equal(calls.length, 4);
      f.sandbox.stopServerLiveSync(); f.run("_serverLiveSync.collectionCursors.ads = 777; _serverLiveSync.lastFailure = { message: 'fresh' };");
      pending.resolve(); const result = await sync;
      console.log(`        Requests started across stop boundary: ${calls.length}`);
      assert.equal(calls.length, 4); assert.equal(result.skipped, true);
      assert.equal(f.run('_serverLiveSync.collectionCursors.ads'), 777);
      assert.equal(f.run('_serverLiveSync.lastFailure.message'), 'fresh');
      assert.equal(f.state.ads.length, 0);
    });
  }
  await test('compatibility refresh stops queued collections and never acknowledges canceled data', async () => {
    const f = loadBrowserSource(); const pending = deferred(); const calls = [];
    f.sandbox.isServerModeEnabled = () => true;
    f.sandbox.apiGetSyncWatermarks = async () => ({ dataCompatibilityVersion: 7 });
    f.sandbox.apiLoadCollectionSince = async name => { calls.push(name); await pending.promise; return []; };
    const refresh = f.sandbox.refreshServerDataCompatibility(); await settle();
    assert.equal(calls.length, 4); f.sandbox.stopServerLiveSync(); pending.resolve();
    const result = await refresh;
    assert.equal(calls.length, 4); assert.equal(result.aborted, true);
    assert.equal(f.run('_serverLiveSync.dataCompatibilityVersion'), null);
  });
  for (const change of ['account', 'poller']) {
    await test(`delta pagination stops before another request after ${change} changes`, async () => {
      const f = syncFixture(); const pending = deferred(); const calls = [];
      f.run('SERVER_API.pageSize = 2;');
      f.sandbox.apiJson = async path => { calls.push(path); if (calls.length === 1) return pending.promise; return []; };
      const request = f.sandbox.apiLoadCollectionSince('pages', 0);
      if (change === 'account') { f.sandbox.advanceServerSessionEpoch(); f.state.currentUser = { id: 'other', role: 'Admin' }; }
      else f.sandbox.stopServerLiveSync();
      pending.resolve([entity('p1'), entity('p2')]);
      const result = await request.then(() => null, error => error);
      assert.equal(calls.length, 1); assert.equal(result?.code, 'SERVER_SESSION_CHANGED');
    });
  }
  await test('a stopped retry does not issue a new HTTP request after its delay', async () => {
    const f = syncFixture(); const timers = []; let calls = 0;
    f.sandbox.setTimeout = fn => { timers.push(fn); return timers.length; };
    f.sandbox.apiJson = async () => { calls += 1; if (calls === 1) throw new Error('network failed'); return []; };
    const request = f.sandbox.apiLoadCollectionSince('pages', 0); await settle();
    assert.equal(timers.length, 1); f.sandbox.stopServerLiveSync(); timers[0]();
    const result = await request.then(() => null, error => error);
    assert.equal(calls, 1); assert.equal(result?.code, 'SERVER_SESSION_CHANGED');
  });
  await test('ordinary pagination keeps all records, newest duplicate versions and tombstones', async () => {
    const f = syncFixture(); const calls = [];
    f.run('SERVER_API.pageSize = 2;');
    const deleted = entity('p1', 30); deleted.data._deleted = true;
    const pages = [[entity('p1'), entity('p2')], [deleted]];
    f.sandbox.apiJson = async path => { calls.push(path); return pages.shift(); };
    const rows = await f.sandbox.apiLoadCollectionSince('pages', 10);
    assert.equal(calls.length, 2); assert.ok(calls[1].includes('after_id=p2'));
    assert.equal(rows.length, 2); assert.equal(rows.find(row => row.id === 'p1')._deleted, true);
    assert.equal(rows.find(row => row.id === 'p1')._lastModified, 30);
  });
  await test('R1 storage-integrity-3: a mid-session IndexedDB reopen that stalls past the 3 s watchdog keeps the snapshot marked newest, so the next launch keeps the edit', async () => {
    const f = useRealSaveState(loadBrowserSource());
    const timers = new Map();
    let seq = 0;
    f.sandbox.setTimeout = (fn, ms) => { timers.set(++seq, { fn, ms: Number(ms) || 0 }); return seq; };
    f.sandbox.clearTimeout = id => { timers.delete(id); };
    const advance = ms => { for (const [id, timer] of [...timers]) if (timer.ms <= ms) { timers.delete(id); timer.fn(); } };
    const opens = [];
    f.sandbox.indexedDB = f.sandbox.window.indexedDB = { open: () => { const request = {}; opens.push(request); return request; } };
    const database = { objectStoreNames: { contains: () => true }, close() {} };
    f.run('db = null');
    const boot = f.sandbox.initIndexedDB();
    opens[0].onsuccess({ target: { result: database } });
    assert.equal(await boot, database);
    assert.equal(f.sandbox.window.__albayanIdbOpenInconclusive, false);
    f.state.receipts = [{ id: 'r_old', amountUSD: 10 }];
    database.onclose();  // iOS drops the connection in the background, and the reopen never answers
    assert.equal(opens.length, 2);
    advance(3000); await settle();
    assert.equal(f.run('db'), null);
    assert.notEqual(f.sandbox.window.__albayanIdbOpenInconclusive, true, 'a stalled REopen is not an unreadable boot: memory is complete');
    assert.equal(await f.sandbox.addRecord(f.state.receipts, { id: 'r_new', amountUSD: 25 }), true);
    const saved = snapshotOf(f);
    assert.ok(saved._collectionsInline, 'before: the snapshot lost its "newest copy" marker');
    assert.deepEqual(saved.receipts.map(row => row.id), ['r_new', 'r_old']);
    // The next launch: IndexedDB opens again and still holds the copy from before the drop.
    const next = loadBrowserSource();
    next.sandbox.localStorage.setItem('albayan_complete_state', JSON.stringify(saved));
    const legacy = next.sandbox.loadState();
    next.run('db = {}');
    next.sandbox.loadCollectionFromIndexedDB = async name => (name === 'receipts' ? [{ id: 'r_old', amountUSD: 10 }] : null);
    next.sandbox.saveCollectionToIndexedDB = async () => true;
    await next.sandbox.loadCollectionsFromStorage(legacy);
    assert.deepEqual(Array.from(next.state.receipts, row => row.id), ['r_new', 'r_old'], 'before: the receipt typed after the drop vanished');
  });
  await test('R1 storage-integrity-3: a boot whose IndexedDB never answers keeps the marker of the snapshot it adopted, and never marks empty arrays it did not adopt', async () => {
    for (const marked of [true, false]) {
      const f = useRealSaveState(loadBrowserSource());
      f.run('db = null');
      f.sandbox.window.__albayanIdbOpenInconclusive = true;
      const legacy = { _collectionsInline: marked };
      for (const name of f.run('PERSISTED_COLLECTIONS')) legacy[name] = marked ? [] : null;
      if (marked) legacy.receipts = [{ id: 'r_new', amountUSD: 25 }];
      await f.sandbox.loadCollectionsFromStorage(legacy);
      assert.equal(!!snapshotOf(f)._collectionsInline, marked, marked ? 'before: the first save dropped the adopted marker' : 'nothing adopted: its empty arrays must never win');
      f.state.receipts.unshift({ id: 'r_next', amountUSD: 5 });
      f.sandbox.saveState();
      assert.equal(!!snapshotOf(f)._collectionsInline, marked);
      f.sandbox.resetDirtyCollectionQueueForScopeChange();  // another storage scope forgets the adoption
      f.sandbox.saveState();
      assert.equal(!!snapshotOf(f)._collectionsInline, false);
    }
  });
  await test('R1 storage-integrity-5: local auto-backups keep ONE rolling copy over 45 days, and a copy refused for quota leaves no stale copy behind', async () => {
    const f = loadBrowserSource();
    const DAY = 86400000;
    f.sandbox.__now = Date.UTC(2026, 0, 1);
    f.run('Date.now = () => globalThis.__now;');
    f.sandbox.IDBKeyRange = { upperBound: upper => ({ upper }) };
    const photo = `data:image/jpeg;base64,${'A'.repeat(150 * 1024)}`;
    f.state.receipts = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, amountUSD: 10, photos: [photo] }));
    const workspace = JSON.stringify(f.state.receipts).length;  // ~5.9 MB with the photos
    const fake = quotaBackupsDb(workspace * 5);  // the device has room for the workspace and about four copies
    fake.otherBytes = workspace;
    for (const id of ['backup_legacy_1', 'backup_legacy_2']) fake.rows.set(id, { value: { id, createdAt: f.sandbox.__now - DAY }, bytes: 100 });
    f.sandbox.__fakeDb = fake;
    f.run('db = __fakeDb');
    let most = 0;
    const results = [];
    for (let day = 1; day <= 45; day += 1) {
      f.sandbox.__now += DAY;
      results.push(await f.sandbox.createAutoBackup());
      await drain();
      most = Math.max(most, fake.rows.size);
    }
    console.log(`        Workspace ${(workspace / 1048576).toFixed(1)} MB; most copies stored over 45 days: ${most}`);
    assert.equal(most, 1, 'before: full copies piled up until the quota was full, and none was pruned again');
    assert.ok(results.every(Boolean), `refused on days ${results.map((ok, i) => (ok ? '' : i + 1)).filter(String).join()}`);
    assert.deepEqual([...fake.rows.keys()], ['auto-latest']);
    // An export within a day keeps the copy instead of rewriting it; a day later it is refreshed.
    const kept = fake.rows.get('auto-latest').value.createdAt;
    f.sandbox.__now += DAY / 2;
    assert.equal(await f.sandbox.createAutoBackup(DAY), false);
    await drain();
    assert.equal(fake.rows.get('auto-latest').value.createdAt, kept);
    f.sandbox.__now += DAY;
    assert.equal(await f.sandbox.createAutoBackup(DAY), true);
    await drain();
    assert.equal(fake.rows.get('auto-latest').value.createdAt, f.sandbox.__now);
    // The phone fills up: the new copy no longer fits, and the stale one is gone as well.
    fake.otherBytes = workspace * 4.5;
    f.sandbox.__now += DAY;
    assert.equal(await f.sandbox.createAutoBackup(), false);
    await drain();
    assert.equal(fake.refused, 1);
    assert.equal(fake.rows.size, 0, 'a refused copy leaves no stale copy holding the space');
  });
  console.log(`\n${passed} sync/persistence work regressions passed; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
