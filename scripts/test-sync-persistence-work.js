// Work-count and race regressions against authoritative browser source.
// Network and storage completions are controlled; no real server or user data.
const assert = require('node:assert/strict');
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
  console.log(`\n${passed} sync/persistence work regressions passed; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
