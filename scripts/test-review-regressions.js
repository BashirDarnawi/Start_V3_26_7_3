const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const loadBrowserSource = require('./helpers/load-browser-source');

// The Clothes System is a lazy bundle: load its source on top of the startup files.
function clothesFixture() {
  const fixture = loadBrowserSource();
  fixture.run(fs.readFileSync(path.join(__dirname, '..', 'src', '15b-clothes.js'), 'utf8'));
  const notes = [];
  fixture.sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
  fixture.sandbox.updateClothesOrdersFiltered = () => {};
  fixture.sandbox.refreshClothesPhotoPreview = () => {};
  return { ...fixture, notes };
}

// Let promise chains started inside the sandbox settle (it shares this microtask queue).
const settle = () => new Promise(resolve => setImmediate(resolve));

let passed = 0;
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.005, `expected ${expected}, received ${actual}`);
}
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

async function nativeFixture() {
  const fixture = loadBrowserSource();
  const { sandbox, run } = fixture;
  const native = { locked: false, authCalls: 0, allow: false, foreground: null };
  sandbox.isPackagedMobileApp = () => true;
  sandbox.setupAdaptiveViewport = () => {};
  sandbox.nativeSecureGet = async key => key === 'biometric_lock_enabled';
  sandbox.getNativeBiometricInfo = async () => ({ isAvailable: true });
  sandbox.hydrateAppLoginPendingFromSecureStorage = async () => {};
  sandbox.getCapacitorAppPlugin = () => ({ addListener: async (event, callback) => {
    if (event === 'appStateChange') native.foreground = callback;
  } });
  sandbox.getCapacitorPlugin = () => null;
  sandbox.syncNativeSystemBarsTheme = async () => {};
  sandbox.renderNativeAppLock = () => { native.locked = true; };
  sandbox.removeNativeAppLock = () => { native.locked = false; };
  sandbox.authenticateNativeDevice = async () => { native.authCalls += 1; return native.allow; };
  await sandbox.setupNativeServices();
  native.flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  native.backgroundLong = () => run('_nativeBackgroundedAt = Date.now() - NATIVE_APP_LOCK_AFTER_MS - 1');
  return { ...fixture, native };
}

function moneyFixture(paidRate = 5, debtRate = 10, covered = 50) {
  const fixture = loadBrowserSource();
  const { state } = fixture;
  state.receipts = [
    { id: 'paid', customerId: 'c1', amountUSD: 50, amountLocal: 50 * paidRate, exchangeRate: paidRate, status: 'Paid', isPaid: true, payments: [], transfers: [] },
    { id: 'debt', customerId: 'c1', amountUSD: 50, amountLocal: 50 * debtRate, exchangeRate: debtRate,
      status: 'Not Paid', isPaid: false, deliveryStatus: 'Office', companyCoveredUSD: covered, customerOutstandingUSD: 50 - covered }
  ];
  state.ads = [{
    id: 'ad1', customerId: 'c1', amountUSD: 100, spentUSD: 100, amountLocal: 100 * debtRate, exchangeRate: debtRate,
    status: 'Active', paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop', receiptId: 'debt',
    receiptAllocations: [{ receiptId: 'paid', amountUSD: 50 }],
    dueAllocations: [{ receiptId: 'debt', amountUSD: 50 - covered }],
    companyFundingAllocations: [{ receiptId: 'debt', amountUSD: covered }]
  }];
  return fixture;
}

async function scopeFixture(nextRole = 'Employee', nextPermissions = { receipts: ['viewOwn'], customers: ['viewOwn'], ads: ['viewOwn'] }) {
  const fixture = loadBrowserSource();
  const { sandbox, state, run } = fixture;
  state.currentUser = { id: 'driver1', role: 'Delivery', permissions: { receipts: ['viewOwn'], customers: ['viewOwn'], ads: ['viewOwn'] } };
  state.users = [state.currentUser];
  state.receipts = [{ id: 'old_receipt', customerId: 'c1', createdBy: 'admin', deliveryPersonId: 'driver1', amountUSD: 500, status: 'Not Paid' }];
  state.ads = [{ id: 'old_ad', customerId: 'c1', createdBy: 'admin', deliveryPersonId: 'driver1' }];
  const writes = [];
  const events = [];
  run("SERVER_API.liveSyncEnabled = true; _serverLiveSync.lastUsersSyncAt = 0; db = {}; _collectionCache.receipts = { data: [{ id: 'cached_secret' }], timestamp: Date.now(), identity: 'old' }; _serverLiveSync.collectionCursors.receipts = 123;");
  sandbox.isServerModeEnabled = () => true;
  sandbox.apiAuthMe = async () => ({ id: 'driver1', role: nextRole, permissions: nextPermissions });
  sandbox.apiLoadCollectionSince = async () => [];
  sandbox.saveCollectionToIndexedDB = async (name, rows) => { writes.push({ name, ids: rows.map(row => row.id) }); return true; };
  sandbox._closeCustomerPagesDialogForStateChange = () => { events.push('close-dialogs'); };
  sandbox.closeReceiptPhotoViewer = () => { events.push('close-photos'); };
  return { ...fixture, writes, events };
}

// Albayan Studio: the lazy studio.js sources (manifest order) on top of the startup files, signed in
// as a customer with the Ads Studio plan, server mode on and a scripted apiJson (no network).
function studioFixture() {
  const fixture = loadBrowserSource();
  const { sandbox, state, run } = fixture;
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'manifest.json'), 'utf8'));
  for (const file of manifest.lazy['studio.js']) run(fs.readFileSync(path.join(root, 'src', file), 'utf8'));
  // The browser's textContent -> innerHTML escaping (this fake document has no innerHTML).
  run('Security').escapeHtml = value => (value === null || value === undefined ? '' : String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  state.currentUser = { id: 'cust1', role: 'Employee', permissions: { adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn'] }, subscriptions: ['ad_maker'] };
  state.users = [state.currentUser];
  state.currentView = 'ads-studio';
  sandbox.isServerModeEnabled = () => true;
  const calls = [];
  const renders = [];
  const replies = Object.create(null);
  sandbox.render = () => { renders.push(Date.now()); };
  sandbox.apiJson = async (url, options = {}) => {
    calls.push({ url, method: String(options.method || 'GET'), body: options.body });
    const reply = replies[url];
    if (typeof reply === 'function') return reply(options);
    if (reply !== undefined) return reply;
    throw new Error(`Unexpected call ${url}`);
  };
  return { ...fixture, calls, renders, replies };
}

async function main() {
  await test('rejected biometric challenge survives Home and immediate reopen', async () => {
    const { sandbox, native } = await nativeFixture();
    assert.equal(await sandbox.unlockNativeApp(), false);
    assert.equal(native.locked, true);
    native.foreground({ isActive: false });
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, true);
    assert.equal(native.authCalls, 2);
  });
  await test('cold-start lock cannot be removed by a quick foreground event', async () => {
    const { native } = await nativeFixture();
    native.foreground({ isActive: false });
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, true);
    assert.equal(native.authCalls, 1);
  });
  await test('authenticated quick return does not demand another biometric prompt', async () => {
    const { sandbox, native } = await nativeFixture();
    native.allow = true;
    assert.equal(await sandbox.unlockNativeApp(), true);
    native.foreground({ isActive: false });
    assert.equal(native.locked, true);
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, false);
    assert.equal(native.authCalls, 1);
  });
  await test('long background requires authentication again and preserves a rejection', async () => {
    const { sandbox, native } = await nativeFixture();
    native.allow = true;
    await sandbox.unlockNativeApp();
    native.allow = false;
    native.foreground({ isActive: false });
    native.backgroundLong();
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, true);
    assert.equal(native.authCalls, 2);
  });
  // Review loop r3 n27: Android sends isActive:true on EVERY onResume (the translucent biometric
  // prompt closing too) but isActive:false only on onStop. A lone resume must not prompt again.
  await test('Android resume after a successful unlock does not prompt again (cold start)', async () => {
    const { sandbox, native } = await nativeFixture();
    native.allow = true;
    assert.equal(await sandbox.unlockNativeApp(), true);
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, false);
    assert.equal(native.authCalls, 1);
  });
  await test('Android resume after a cancelled prompt keeps the lock without reopening the prompt', async () => {
    const { sandbox, native } = await nativeFixture();
    assert.equal(await sandbox.unlockNativeApp(), false);
    native.foreground({ isActive: true });
    await native.flush();
    assert.equal(native.locked, true);
    assert.equal(native.authCalls, 1);
  });
  await test('Android resume of the prompt after a long background does not loop', async () => {
    const { native } = await nativeFixture();
    native.allow = true;
    native.foreground({ isActive: false });
    native.backgroundLong();
    native.foreground({ isActive: true });  // the real return: one prompt
    await native.flush();
    assert.equal(native.authCalls, 1);
    assert.equal(native.locked, false);
    native.foreground({ isActive: true });  // the prompt's own onResume, the stop time still old
    await native.flush();
    assert.equal(native.authCalls, 1);
    assert.equal(native.locked, false);
  });
  // Review loop r3 n29: with the phone's screen lock removed the lock cannot open; it offers sign-out.
  async function lockFixture(info, authenticate) {
    const fixture = loadBrowserSource();
    const { sandbox, state } = fixture;
    const nodes = new Map();
    const doc = sandbox.document;
    const make = doc.createElement;
    doc.getElementById = id => nodes.get(id) || null;
    doc.createElement = tag => { const el = make(tag); el.remove = () => { if (nodes.get(el.id) === el) nodes.delete(el.id); }; return el; };
    doc.body.appendChild = el => { if (el.id) nodes.set(el.id, el); };
    const secure = { biometric_lock_enabled: true };
    const calls = { auth: 0, logout: 0 };
    sandbox.isPackagedMobileApp = () => true;
    sandbox.setupAdaptiveViewport = () => {};
    sandbox.nativeSecureGet = async key => (key in secure ? secure[key] : null);
    sandbox.nativeSecureSet = async (key, value) => { secure[key] = value; return true; };
    sandbox.hydrateAppLoginPendingFromSecureStorage = async () => {};
    sandbox.getCapacitorAppPlugin = () => null;
    sandbox.syncNativeSystemBarsTheme = async () => {};
    sandbox.getCapacitorPlugin = name => (name === 'BiometricAuthNative'
      ? { checkBiometry: async () => info, internalAuthenticate: async () => { calls.auth += 1; return authenticate(); } }
      : null);
    sandbox.handleLogout = async () => { calls.logout += 1; state.currentUser = null; return true; };
    await sandbox.setupNativeServices();
    return { ...fixture, nodes, secure, calls };
  }
  await test('app lock offers sign-out when the phone no longer has a screen lock', async () => {
    const { sandbox, run, nodes, secure, calls } = await lockFixture({ isAvailable: false, deviceIsSecure: false }, () => {});
    assert.equal(await sandbox.unlockNativeApp(), false);
    const lock = nodes.get('native-app-lock');
    assert.ok(lock && lock.innerHTML.includes('onclick="nativeLockSignOut()"'), 'the lock offers sign-out');
    assert.ok(lock.innerHTML.includes('No screen lock'), 'the lock says why it cannot open');
    assert.equal(calls.auth, 0);
    assert.equal(typeof sandbox.nativeLockSignOut, 'function');
    await sandbox.nativeLockSignOut();
    assert.equal(secure.biometric_lock_enabled, false);
    assert.equal(calls.logout, 1);
    assert.equal(nodes.has('native-app-lock'), false);
    assert.equal(run('_nativePrefs.biometricEnabled'), false);
  });
  await test('a phone with a screen lock keeps the plain lock (no sign-out shortcut)', async () => {
    const { sandbox, nodes, calls } = await lockFixture({ isAvailable: true, deviceIsSecure: true }, () => { throw new Error('userCancel'); });
    assert.equal(await sandbox.unlockNativeApp(), false);
    const lock = nodes.get('native-app-lock');
    assert.ok(lock && lock.innerHTML.includes('onclick="unlockNativeApp()"'));
    assert.ok(!lock.innerHTML.includes('nativeLockSignOut'));
    assert.equal(calls.auth, 1);
    assert.equal(calls.logout, 0);
  });
  // Review loop r3 n28: Android's Network plugin re-registers on every onResume and reports
  // connected:true, so retryMobileConnection runs on every return to the app.
  await test('a resume network event on the signed-out screen does not reload the page', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    let reloads = 0;
    sandbox.window.location.reload = () => { reloads += 1; };
    sandbox.isPackagedMobileApp = () => true;
    sandbox.apiHealthCheck = async () => true;
    state.currentUser = null;
    state.serverMode = true;
    run('setMobileColdStartBlocked(false)');
    assert.equal(await sandbox.retryMobileConnection(), true);
    assert.equal(reloads, 0, 'the login form must survive an app switch');
    run('setMobileColdStartBlocked(true)');
    assert.equal(await sandbox.retryMobileConnection(), true);
    assert.equal(reloads, 1, 'a blocked cold start still reloads to restore the session');
    run('setMobileColdStartBlocked(false)');
    state.serverMode = false;  // a phone browser that fell into local mode on a failed first probe
    assert.equal(await sandbox.retryMobileConnection(), true);
    assert.equal(reloads, 2);
  });
  for (const [paidRate, debtRate] of [[5, 10], [10, 5]]) {
    await test(`full company coverage settles USD and LYD at different rates ${paidRate}/${debtRate}`, () => {
      const { sandbox } = moneyFixture(paidRate, debtRate);
      const stats = sandbox.getCustomerStats('c1');
      near(stats.balanceUSD, 0);
      near(stats.balanceLYD, 0);
      near(stats.totalSpentLYD, 50 * paidRate + 50 * debtRate);
    });
  }
  await test('partial coverage leaves only the debt receipt remaining liability at its own rate', () => {
    const { sandbox } = moneyFixture(5, 10, 20);
    const stats = sandbox.getCustomerStats('c1');
    near(stats.balanceUSD, -30);
    near(stats.balanceLYD, -300);
    const indexed = sandbox.getCustomerStats('c1', sandbox.buildCustomerStatsIndex());
    near(indexed.balanceUSD, stats.balanceUSD);
    near(indexed.balanceLYD, stats.balanceLYD);
  });
  await test('unrelated unused receipt retains its exact credit and does not reprice spending', () => {
    const { sandbox, state } = moneyFixture();
    state.receipts.push({ id: 'unused', customerId: 'c1', amountUSD: 10, amountLocal: 70, exchangeRate: 7, status: 'Paid', isPaid: true });
    const stats = sandbox.getCustomerStats('c1');
    near(stats.balanceUSD, 10);
    near(stats.balanceLYD, 70);
  });
  await test('direct company coverage uses the same value on both sides of mixed-rate balance', () => {
    const { sandbox, state } = moneyFixture();
    state.receipts.splice(1, 1);
    Object.assign(state.ads[0], { receiptId: '', dueAllocations: [], companyFundingAllocations: [], companyDirectCoverageUSD: 50 });
    near(sandbox.getCustomerStats('c1').balanceLYD, 0);
    near(sandbox.getCustomerStats('c1').balanceUSD, 0);
  });
  await test('a fully consumed receipt preserves rounded saved LYD instead of creating a few cents', () => {
    const { sandbox, state } = moneyFixture();
    state.receipts = [{ id: 'rounded', customerId: 'c1', amountUSD: 5.15, amountLocal: 50, exchangeRate: 9.7, status: 'Paid', isPaid: true }];
    state.ads = [{ id: 'ad', customerId: 'c1', amountUSD: 5.15, spentUSD: 5.15, status: 'Active', paymentStatus: 'paid', receiptAllocations: [{ receiptId: 'rounded', amountUSD: 5.15 }] }];
    near(sandbox.getCustomerStats('c1').balanceLYD, 0);
  });
  await test('delivery promotion clears memory, request cache, IndexedDB and dialogs before reloading', async () => {
    const { sandbox, state, run, writes, events } = await scopeFixture();
    let reloads = 0;
    sandbox.serverLoadAllData = async () => {
      reloads += 1;
      assert.equal(state.receipts.length, 0);
      assert.equal(state.ads.length, 0);
      assert.equal(run('_collectionCache.receipts.data'), null);
      assert.equal(run('_serverLiveSync.collectionCursors.receipts'), 0);
      assert.ok(writes.some(write => write.name === 'receipts' && write.ids.length === 0));
      assert.ok(events.includes('close-dialogs') && events.includes('close-photos'));
      state.receipts = [{ id: 'owned_receipt', createdBy: 'driver1' }];
      return { failed: [] };
    };
    assert.equal((await sandbox.serverLiveSyncOnce()).ok, true);
    assert.equal((await sandbox.serverLiveSyncOnce()).ok, true);
    assert.equal(reloads, 1);
    assert.deepEqual(Array.from(state.receipts, row => row.id), ['owned_receipt']);
  });
  await test('failed scoped reload cannot restore old driver records after access removal', async () => {
    const { sandbox, state } = await scopeFixture('Employee', {});
    sandbox.serverLoadAllData = async () => ({ failed: [{ collection: 'receipts', status: 503 }] });
    assert.equal((await sandbox.serverLiveSyncOnce()).ok, false);
    assert.equal(state.receipts.length, 0);
    assert.equal(state.ads.length, 0);
  });
  await test('all revoked memory and media are cleared before slow IndexedDB storage settles', async () => {
    const { sandbox, state, events } = await scopeFixture();
    let finishWrite;
    sandbox.saveCollectionToIndexedDB = () => new Promise(resolve => { finishWrite = resolve; });
    const clear = sandbox.clearServerCollectionsForVisibility(['ads', 'receipts', 'customers']);
    assert.equal(state.ads.length, 0);
    assert.equal(state.receipts.length, 0);
    assert.equal(state.customers.length, 0);
    assert.ok(events.includes('close-photos'));
    // Let later writes complete without blocking the test.
    sandbox.saveCollectionToIndexedDB = async () => true;
    finishWrite(true);
    await clear;
  });
  // ---- Review loop r3, batch OS: offline storage, sync and the privacy of the browser cache.
  await test('r3 OS n5: server mode writes no daily device backup; local mode still does', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    const opened = [];
    sandbox.__fakeDb = { transaction(stores) { opened.push(Array.from(stores).join()); throw new Error('stub store'); } };
    sandbox.console = { ...sandbox.console, error() {} };  // the stub store's refusal is expected
    run('db = __fakeDb');
    state.serverMode = true;
    assert.equal(await sandbox.createAutoBackup(), false);
    assert.deepEqual(opened, [], 'a server-mode session must not copy the signed-in user\'s data into the backups store');
    state.serverMode = false;
    await sandbox.createAutoBackup();
    assert.deepEqual(opened, ['backups']);
  });
  await test('r3 OS n5/n10: sign-out clears deleted-staff names, the device audit trail and the backups store', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('db = {}');
    const cleared = [];
    sandbox.saveCollectionToIndexedDB = async () => true;
    sandbox.clearIndexedDBLogs = async () => { cleared.push('auditLogs'); return true; };
    sandbox.idbClear = async (store) => { cleared.push(store); return true; };
    state.userTombstones = { u1: 'Ali' };
    state.logs = [{ id: 'log1', metadata: { old: { phone: '0912345678' } } }];
    await sandbox.wipeAuthenticatedServerDataFromClient();
    assert.equal(Object.keys(state.userTombstones).length, 0);
    assert.equal(state.logs.length, 0);
    assert.ok(cleared.includes('auditLogs') && cleared.includes('backups'), `cleared ${cleared.join()}`);
    state.userTombstones = { u2: 'Omar' };
    sandbox.emergencyFinishClientSignOut(true, false);
    assert.equal(Object.keys(state.userTombstones).length, 0, 'the emergency sign-out keeps no deleted-staff names');
  });
  await test('r3 OS n7: local mode warns once when IndexedDB refuses a save, and again after a recovery', async () => {
    for (const serverMode of [false, true]) {
      const { sandbox, state, run } = loadBrowserSource();
      state.serverMode = serverMode;
      run('db = {}');
      const notes = [];
      sandbox.showNotification = (title, message, type) => notes.push({ title, type });
      let saves = false;
      sandbox.saveCollectionToIndexedDB = async () => saves;
      const flush = async () => { run("markCollectionDirty('receipts')"); await sandbox.flushDirtyCollections(); };
      await flush();
      await flush();
      assert.ok(run("idbSync.dirty.has('receipts')"), 'the failed collection stays queued for a retry');
      if (serverMode) { assert.equal(notes.length, 0, 'in server mode IndexedDB is only a cache'); continue; }
      // A refusal with no quota error behind it is not called "storage full" (see the follow-up test).
      assert.deepEqual(notes.map(n => `${n.title}/${n.type}`), ['Saving Delayed/warning']);
      saves = true;
      await flush();
      saves = false;
      await flush();
      assert.equal(notes.length, 2, 'a new failing spell after a good save warns again');
    }
  });
  await test('r3 OS n7 follow-up: only a real quota refusal says "Storage Full"; a transient abort warns neutrally', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.serverMode = false;
    run('db = {}');
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.console = { ...sandbox.console, error() {} };  // the refused writes below are expected
    // The real saveCollectionToIndexedDB runs; only the IndexedDB transaction is replaced.
    sandbox.idbGet = async () => null;
    const failures = [];
    sandbox.idbAtomicWrite = async () => {
      const name = failures.shift();
      if (name) throw Object.assign(new Error(name), { name });
      return true;
    };
    const flush = async (...names) => {
      for (const name of names) run(`markCollectionDirty('${name}')`);
      await sandbox.flushDirtyCollections();
    };
    const seen = () => notes.map(n => `${n.title}/${n.type}`);
    failures.push('UnknownError');                    // an iOS WebView went to the background mid-write
    await flush('receipts');
    assert.deepEqual(seen(), ['Saving Delayed/warning'], 'a transient abort is not reported as a full disk');
    assert.match(notes[0].message, /could not be saved to this device yet/);
    assert.doesNotMatch(notes[0].message, /storage is full/);
    assert.ok(run("idbSync.dirty.has('receipts')"), 'the failed collection stays queued for a retry');
    failures.push('AbortError');
    await flush('receipts');
    assert.equal(notes.length, 1, 'the neutral note shows once per failing spell');
    failures.push('QuotaExceededError', 'AbortError');  // receipts: quota; ads: a later transient abort
    await flush('receipts', 'ads');
    assert.deepEqual(seen().slice(1), ['Storage Full/error'], 'a real quota refusal still says so, even after the neutral note');
    failures.push('QuotaExceededError');
    await flush('receipts');
    assert.equal(notes.length, 2, '"Storage Full" shows once per failing spell');
    await flush('receipts', 'ads');                   // both saves go through: the spell is over
    assert.equal(run('idbSync.dirty.size'), 0);
    state.language = 'ar';
    failures.push('QuotaExceededError');
    await flush('receipts');
    assert.deepEqual(notes.slice(2).map(n => `${n.title}/${n.type}`), ['مساحة التخزين ممتلئة/error'], 'a new spell starts over, and quota is said at once');
    failures.push('UnknownError');
    await flush('ads');
    assert.equal(notes.length, 3, 'a transient abort after "Storage Full" adds no weaker note');
    await flush('ads');
    failures.push('UnknownError');
    await flush('ads');
    assert.deepEqual(notes.slice(3).map(n => `${n.title}/${n.type}`), ['تأخّر الحفظ/warning']);
    assert.match(notes[3].message, /تعذّر حفظ التغييرات على هذا الجهاز/);
  });
  await test('r3 OS n8: the ads refresh after a delivery change re-reads ads changed during its paged load', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.isServerModeEnabled = () => true;
    state.serverMode = true;
    run('SERVER_API.liveSyncEnabled = true; _serverLiveSync.lastUsersSyncAt = Date.now(); _serverLiveSync.collectionCursors.ads = 1000;');
    const server = { X: { id: 'X', customerId: 'c1', spentUSD: 5, _lastModified: 1000 } };
    state.ads = [{ ...server.X }];
    const epoch = run('_serverLiveSync.pollerEpoch');
    sandbox.apiLoadCollectionAll = async () => {
      const pageRead = { ...server.X };                 // X's page is read at version 1000
      server.X = { ...server.X, spentUSD: 9, _lastModified: 50000 };
      state.ads = [{ ...server.X }];                    // a poll applies the colleague's edit...
      run('_serverLiveSync.collectionCursors.ads = 90000');  // ...and a later ad write moves the cursor on
      return [pageRead];
    };
    const result = await sandbox.refreshAdsAfterReceiptServerCascade({ id: 'r1', status: 'Not Paid' });
    assert.equal(result.source, 'server');
    assert.equal(run('_serverLiveSync.collectionCursors.ads'), 1000, 'the cursor goes back to where the load began');
    assert.equal(run('_serverLiveSync.pollerEpoch'), epoch + 1, 'a poll in flight cannot raise it again');
    sandbox.refreshServerDataCompatibility = async () => ({ ok: true });
    sandbox.apiLoadCollectionSince = async (collection, since) =>
      (collection === 'ads' ? [server.X].filter(row => row._lastModified > since - 15000) : []);
    assert.equal((await sandbox.serverLiveSyncOnce()).ok, true);
    assert.equal(state.ads[0]._lastModified, 50000, 'the newer ad came back instead of staying stale for good');
    assert.equal(state.ads[0].spentUSD, 9);
  });
  await test('r3 OS n9: writes carry the account header too; sign-in, sign-out and setup do not', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.AbortController = AbortController;
    const sent = [];
    sandbox.fetch = async (url, opts) => {
      sent.push(opts.headers || {});
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' };
    };
    state.currentUser = { id: 'u_A', role: 'Admin', permissions: {} };
    await sandbox.apiFetch('/api/collections/customers', { method: 'POST', body: {} });
    await sandbox.apiFetch('/api/collections/customers/c1', { method: 'PATCH', body: {} });
    await sandbox.apiFetch('/api/batch/delete', { method: 'POST', body: { items: [] } });
    await sandbox.apiFetch('/api/collections/customers', { method: 'GET' });
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/setup-admin', '/api/auth/app-login/exchange']) {
      await sandbox.apiFetch(path, { method: 'POST', body: {} });
    }
    assert.deepEqual(sent.map(headers => headers['X-Albayan-User'] || ''), ['u_A', 'u_A', 'u_A', 'u_A', '', '', '', '']);
    run("_serverUserUpdate.timers.set('u2', 1); _serverUserUpdate.pending.set('u2', { name: 'Edited' });");
    await sandbox.flushPendingUserUpdates();
    assert.equal(sent[sent.length - 1]['X-Albayan-User'], 'u_A', 'the keepalive permission flush names its account too');
  });
  await test('r3 OS n6: a batch delete adopts the server tombstone stamps, never over a newer copy', async () => {
    const { sandbox, state } = loadBrowserSource();
    sandbox.isServerModeEnabled = () => true;
    state.receipts = [{ id: 'r1', _deleted: true, _lastModified: 5 }, { id: 'r2', _deleted: true, _lastModified: 5 }];
    const ops = state.receipts.map(record => ({ collection: 'receipts', id: record.id, old: { ...record, _deleted: false }, array: state.receipts, record }));
    state.receipts[1] = { id: 'r2', _lastModified: 99999 };  // live sync installed a newer copy mid-flight
    sandbox.apiBatchDeleteEntities = async () => ({ ok: true, deleted: 2, skipped: 0, stamps: { 'receipts:r1': 777, 'receipts:r2': 778 } });
    assert.equal(await sandbox.flushBatchDeletes(ops), true);
    assert.equal(state.receipts[0]._lastModified, 777, 'the device-clock stamp is replaced by the server stamp');
    assert.equal(state.receipts[1]._lastModified, 99999);
  });
  await test('existing admin-to-employee scope changes use the same cleanup and reload', async () => {
    const { sandbox, state, writes } = await scopeFixture();
    state.currentUser.role = 'Admin';
    sandbox.apiListUsersForUi = async () => [];
    let reloads = 0;
    sandbox.serverLoadAllData = async () => {
      reloads += 1;
      assert.equal(state.receipts.length, 0);
      assert.ok(writes.some(write => write.name === 'receipts' && write.ids.length === 0));
      return { failed: [] };
    };
    assert.equal((await sandbox.serverLiveSyncOnce()).ok, true);
    assert.equal(reloads, 1);
    assert.equal(state.currentUser.role, 'Employee');
  });
  await test('scope cleanup aborts after a session switch and never launches an old reload', async () => {
    const { sandbox, state, run } = await scopeFixture();
    let reloads = 0;
    sandbox.serverLoadAllData = async () => { reloads += 1; return { failed: [] }; };
    sandbox.saveCollectionToIndexedDB = async () => {
      run('advanceServerSessionEpoch()');
      state.currentUser = null;
      return true;
    };
    assert.equal((await sandbox.serverLiveSyncOnce()).skipped, true);
    assert.equal(reloads, 0);
  });
  await test('customer card credits the cash a driver collected on an underpaid delivery; Collect prints its USD', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.language = 'en';
    state.defaultExchangeRate = 10;
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    state.users = [state.currentUser];
    state.customers = [{ id: 'c1', name: 'Under Paid' }];
    state.pages = [];
    const now = new Date().toISOString();
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', exchangeRate: 10, payments: [], transfers: [], createdAt: now,
      statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'Delivered', deliveredAt: now,
      amountUSD: 70, amountLocal: 700, debtAmountUSD: 100, debtAmountLocal: 1000, amountCollectedFromCustomer: 700, paymentResult: 'UNDERPAID',
      remainingDue: 300, customerOutstandingUSD: 30, status: 'Not Paid', isPaid: false }];
    state.ads = [{ id: 'a1', recordType: 'ad', customerId: 'c1', amountUSD: 100, amountLocal: 1000, exchangeRate: 10, spentUSD: 100, status: 'Active',
      paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop', receiptId: 'r1', receiptAllocations: [],
      dueAllocations: [{ receiptId: 'r1', amountUSD: 100 }], dueAmountToUseUSD: 100, startDate: now, createdAt: now }];
    const stats = sandbox.getCustomerStats('c1');
    near(stats.totalPaidUSD, 70);
    near(stats.balanceUSD, -30);   // before: -100 — the $70 the driver collected was credited nowhere
    const rows = sandbox.shellDebtorRows();
    assert.equal(rows.length, 1);
    near(rows[0].dueUsd, 30);      // before: the LYD balance printed as dollars
    near(rows[0].dueLyd, 300);
  });
  await test('user form: a target outranks the editor only by grants the editor does not cover', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.currentUser = { id: 'mgr', role: 'Employee', permissions: { users: ['view', 'changeRole', 'resetPassword'], customers: ['view', 'viewContacts'], deliveries: ['view', 'assign', 'accept', 'markCollected'], ads: ['view'] } };
    assert.equal(sandbox._targetOutranksEditor({ role: 'Employee', permissions: { customers: ['viewOwn'] } }), false);       // view covers viewOwn
    assert.equal(sandbox._targetOutranksEditor({ role: 'Delivery', permissions: { deliveries: ['viewOwn', 'accept', 'complete', 'markCollected'], ads: ['viewOwn'], customers: ['viewOwn', 'viewContacts'] } }), false);  // template driver
    assert.equal(sandbox._targetOutranksEditor({ role: 'Employee', permissions: { receipts: ['view'] } }), true);
    assert.equal(sandbox._targetOutranksEditor({ role: 'Employee', permissions: { deliveries: ['complete'] } }), true);      // office account: complete is not covered
  });
  await test('an employee with analytics.view lands on Analytics, never on the admin-only Control Center', async () => {
    const { sandbox } = loadBrowserSource();
    assert.equal(sandbox.getAlbayanManagerLandingViewForUser({ role: 'Employee', permissions: { analytics: ['view'], customers: ['view'] } }), 'analytics');
    assert.equal(sandbox.getAlbayanManagerLandingViewForUser({ role: 'Employee', permissions: { customers: ['view'] } }), 'customers');
    assert.equal(sandbox.getAlbayanManagerLandingViewForUser({ role: 'Admin', permissions: {} }), 'control-center');
  });
  // Review loop r4 batch OPS: the Control Center lives in the lazy admin-tools bundle.
  const controlCenterFixture = () => {
    const fixture = loadBrowserSource();
    fixture.run(fs.readFileSync(path.join(__dirname, '..', 'src', '12b-control-center.js'), 'utf8'));
    const notes = [];
    fixture.sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
    fixture.sandbox.loadControlCenterStatus = async () => {};
    fixture.run('_controlCenter.loadedAt = Date.now();');
    // The harness's fake DOM has no innerHTML escaping; use a real escaper so the escaping assertions mean something.
    fixture.run("Security.escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')");
    return { ...fixture, notes };
  };
  await test('Control Center: a debt the company covered in full is not an unpaid receipt (n=15)', async () => {
    const { sandbox, state } = controlCenterFixture();
    state.receipts = [
      { id: 'covered', customerId: 'c1', status: 'Not Paid', isPaid: false, amountUSD: 50, debtAmountUSD: 50, companyCoveredUSD: 50, customerOutstandingUSD: 0 },
      { id: 'owed', customerId: 'c1', status: 'Not Paid', isPaid: false, amountUSD: 20 },
      { id: 'zero', customerId: 'c1', status: 'Not Paid', isPaid: false, amountUSD: 0 }  // no coverage fields: the status decides, as on the server
    ];
    const facts = sandbox.getControlCenterFacts();
    assert.deepEqual(facts.unpaidReceipts.map(receipt => receipt.id), ['owed', 'zero']);
    assert.equal(facts.attentionCount, 2);
  });
  await test('Control Center: a failing off-site copy, the rolling error rate and every closed month are shown (n=5, 11, 16, 13)', async () => {
    const { sandbox, run } = controlCenterFixture();
    run(`_controlCenter.operations = {
      backup: { enabled: true, encryptionReady: true, offsiteConfigured: true, lastOffsiteError: '403 <b>InvalidAccessKeyId', lastOffsiteAt: 0, workerRunning: true },
      monitoring: { total_requests: 2000000, error_rate: 0.0002, recent_error_rate: 0.3, recent_sample_size: 1000, response_ms_p95: 100 },
      setupTasks: ['Off-site backup copy is failing - check the S3 bucket, keys and region'],
      financialPeriods: ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01'].map(period => ({ period, status: 'closed' }))
    };`);
    const html = sandbox.renderControlCenterView();
    assert.ok(!html.includes('>Connected<') && html.includes('>Failing<'), 'a failed upload is not "Connected"');
    assert.ok(html.includes('403 &lt;b&gt;InvalidAccessKeyId'), 'the upload error is shown, escaped');
    assert.ok(!html.includes('>Configured<') && html.includes('>Setup needed<'), 'protection is not "Configured" without an off-site copy');
    assert.ok(/text-rose-600">30\.0% errors/.test(html), 'the health tile uses the rolling window like the task');
    assert.ok(html.includes("unlockControlCenterMonth('2026-01')"), 'the oldest closed month can be unlocked');
    run('_controlCenter.operations.monitoring = { total_requests: 100, error_rate: 0.2, recent_error_rate: 0, recent_sample_size: 100 };');
    assert.ok(/text-emerald-600">0\.0% errors/.test(sandbox.renderControlCenterView()), 'an old incident no longer paints the tile red');
  });
  await test('Control Center: Backup now warns when only the local copy was saved and reports a running backup as busy (n=5, 8)', async () => {
    const { sandbox, notes } = controlCenterFixture();
    sandbox.apiRunEncryptedBackup = async () => ({ ok: true, backup: { offsite: false, offsiteError: '403 InvalidAccessKeyId' } });
    await sandbox.runControlCenterBackup();
    assert.equal(notes[notes.length - 1].type, 'warning');
    assert.ok(notes[notes.length - 1].message.includes('403 InvalidAccessKeyId'));
    sandbox.apiRunEncryptedBackup = async () => { throw Object.assign(new Error('A backup is already running; it will appear under Last backup when it finishes'), { status: 409 }); };
    await sandbox.runControlCenterBackup();
    assert.equal(notes[notes.length - 1].type, 'info');
    assert.ok(!notes.some(note => note.type === 'error' || note.type === 'success'), JSON.stringify(notes));
  });
  await test('audit export pages by the last row cursor and a failed page downloads nothing (n=7)', async () => {
    const { sandbox } = loadBrowserSource();
    const notes = [];
    sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
    sandbox.isServerModeEnabled = () => true;
    const page = (start, count) => Array.from({ length: count }, (_, i) => ({ id: `a${start + i}`, ts: 5000 - start - i, action: 'x', resource_type: 'auth', message: 'm' }));
    const urls = [];
    sandbox.apiJson = async url => { urls.push(url); return urls.length === 1 ? page(0, 1000) : page(1000, 3); };
    assert.equal((await sandbox.apiListAllAuditLogs()).length, 1003);
    assert.ok(urls[1].includes('&before_ts=4001&before_id=a999'), urls[1]);
    let downloads = 0;
    sandbox.downloadFile = () => { downloads += 1; return true; };
    urls.length = 0;
    sandbox.apiJson = async url => { urls.push(url); if (urls.length % 2 === 1) return page(0, 1000); throw new Error('Request timed out'); };
    await sandbox.exportAuditLogs('csv');
    await sandbox.backupAuditLogs();
    assert.equal(downloads, 0, 'no partial file');
    assert.equal(notes.filter(note => note.type === 'error' && /timed out/.test(note.message)).length, 2);
  });
  await test('Meta Insights shows the money inside each ad account, escaped, with a failing account kept visible', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.language = 'en';
    state.ads = [{ id: 'a1', metaAdAccountId: '555555555555555', metaAdAccountName: 'Prepaid Balance 3' }];
    // The harness's fake DOM has no innerHTML escaping; use a real escaper so the escaping assertions mean something.
    run("Security.escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')");
    run(`metaInsightsUi.funds = ${JSON.stringify({
      fetchedAt: '2026-09-23T09:00:00Z', truncated: false,
      accounts: [
        { id: '555555555555555', name: 'Ad account 555555555555555', error: 'Meta said "no" & stopped' },
        { id: '222222222222222', name: 'View only "A&B"', currency: 'USD', fundsText: '', fundsMinor: null, fundsHidden: true, capRemainingMinor: null, amountDueMinor: 0 },
        { id: '444444444444444', name: 'Prepaid Balance 2', currency: 'USD', fundsText: 'Available Balance ($200.00 USD)', fundsMinor: 20000, capRemainingMinor: null, amountDueMinor: 0 },
        { id: '333333333333333', name: 'Card account', currency: 'USD', fundsText: '<img src=x onerror=alert(1)>', fundsMinor: null, capRemainingMinor: 37655, amountDueMinor: 700 },
        { id: '111111111111111', name: 'Paused account', currency: 'USD', fundsText: 'Available Balance ($50.00 USD)', fundsMinor: 5000, stale: true, readAt: '2026-09-23T08:00:00Z', staleReason: 'Meta is temporarily limiting synchronization.' },
        { id: '666666666666666', name: 'Never read yet', error: 'Meta synchronization is paused safely and will resume automatically.', waiting: true }
      ],
      provider: { paused: true, retryAfterSeconds: 250 }
    })}`);
    const html = sandbox.metaInsightsFundsCard(false);
    assert.ok(html.includes('Money in the ad accounts'));
    assert.ok(html.includes('text-sky-700 dark:text-sky-300">$200.00</span>'), 'prepaid funds drawn as the big amount');
    assert.ok(html.indexOf('Prepaid Balance 2') < html.indexOf('Prepaid Balance 3'), 'accounts holding money are listed first');
    assert.ok(html.includes('Prepaid Balance 3'), 'an unreadable account keeps the name the ads know it by');
    assert.ok(html.includes('Meta said &quot;no&quot; &amp; stopped') && !html.includes('Meta said "no"'), 'the error is shown, escaped');
    assert.ok(html.includes('View only &quot;A&amp;B&quot;') && html.includes('Full control'), 'hidden funds explain the access Meta needs');
    assert.ok(html.includes('Last known amount') && html.includes('$50.00'), 'a paused re-read keeps the last good amount');
    assert.ok(html.includes('Waiting for Meta') && !html.includes('text-rose-600">Meta synchronization is paused'), 'an account not read yet waits calmly, not in red');
    assert.ok(html.includes('Next automatic try in about 5 min'), 'the pause says when Albayan tries again');
    assert.ok(html.includes('Spend limit left') && html.includes('$376.55') && html.includes('Amount due') && html.includes('$7.00'));
    assert.ok(!html.includes('<img src=x'), 'Meta text is escaped');
    assert.ok(sandbox.metaInsightsFundsCard(true).includes('الأموال في حسابات الإعلانات'), 'Arabic title');
    sandbox.resetAuthenticatedServerCaches();
    assert.equal(run('metaInsightsUi.funds'), null, 'account money never survives logout');
  });
  // Review loop r2 M2 #3: only the version check's "Conflict: ..." 409 is "the ad changed"; the
  // link's other 409s (a Studio ad, a Meta ad another Albayan ad holds) show the server's reason.
  await test('Meta link: a 409 that is not a version conflict shows the server reason, in both languages', async () => {
    const linkWith = async (message, language = 'en') => {
      const { sandbox, state, run } = loadBrowserSource();
      state.language = language;
      state.ads = [{ id: 'ad1', _lastModified: 5 }];
      const reloads = [];
      sandbox.metaAdsRenderModal = () => {};
      sandbox.apiGetEntity = async (collection, id) => { reloads.push(id); throw new Error('offline'); };
      sandbox.apiLinkMetaAd = async () => { throw Object.assign(new Error(message), { status: 409 }); };
      run("metaAdsUi.targetAdId = 'ad1'; metaAdsUi.busyAction = '';");
      await sandbox.metaAdsRunMutation('link', '123456789012345');
      return { error: run('metaAdsUi.error'), busy: run('metaAdsUi.busyAction'), reloads };
    };
    const taken = await linkWith('This Meta ad is already linked to another Albayan ad');
    assert.equal(taken.error, 'This Meta ad is already linked to another Albayan ad');
    assert.equal(taken.busy, '');
    const studio = 'This Meta ad belongs to Albayan Studio (a studio request linked its campaign). It cannot be linked to an Albayan Manager ad.';
    assert.equal((await linkWith(studio)).error, studio);
    assert.ok(!/changed while you were working/.test((await linkWith(studio)).error));
    const takenAr = await linkWith('This Meta ad is already linked to another Albayan ad', 'ar');
    assert.ok(/مرتبط بإعلان آخر/.test(takenAr.error) && !/[A-Za-z]{5,}/.test(takenAr.error.replace(/Meta|Albayan|Studio/g, '')), takenAr.error);
    assert.ok(/Albayan Studio/.test((await linkWith(studio, 'ar')).error) && /تابع/.test((await linkWith(studio, 'ar')).error));
    const stale = await linkWith('Conflict: ad has changed');
    assert.ok(/changed while you were working/.test(stale.error), stale.error);
    assert.deepEqual(stale.reloads, ['ad1'], 'a version conflict reloads the ad');
  });
  // Review loop r2 M2 #7: a check that found the background pass already running is not "no new ads".
  await test('Check for new ads: a busy server pass is reported as running, never as "no new ads"', async () => {
    for (const language of ['en', 'ar']) {
      const { sandbox, state, run } = loadBrowserSource();
      state.language = language;
      const notes = [];
      sandbox.metaAdsRenderModal = () => {};
      sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
      sandbox.apiRunMetaAutoImport = async () => ({ imported: [], busy: true, state: { lastError: '' } });
      run("metaAdsUi.busyAction = ''; metaAdsUi.status = { configured: true };");
      await sandbox.metaAdsCheckForNewAds();
      assert.equal(notes.length, 1);
      assert.ok(!/no new ads|لا توجد إعلانات جديدة/.test(notes[0].message), notes[0].message);
      assert.equal(notes[0].type, 'info');
      assert.ok(language === 'en' ? /running/.test(notes[0].title) : /يعمل/.test(notes[0].title), notes[0].title);
      assert.equal(run('metaAdsUi.busyAction'), '', 'the button is released');
      assert.deepEqual(run('metaAdsUi.status.importState'), { lastError: '' });
    }
    const { sandbox, state } = loadBrowserSource();
    state.language = 'en';
    const notes = [];
    sandbox.metaAdsRenderModal = () => {};
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.apiRunMetaAutoImport = async () => ({ imported: [], busy: false, state: {} });
    await sandbox.metaAdsCheckForNewAds();
    assert.equal(notes[0].message, 'There are no new ads right now.', 'a finished pass with nothing new still says so');
  });
  await test('clothes: editing a Paid order to add a piece saves it as Partially Paid instead of crashing', async () => {
    const { sandbox, state, run, notes } = clothesFixture();
    state.clothesProducts = [{ id: 'p1', name: 'Shirt', costUSD: 5, priceLYD: 50, variants: [], createdBy: 'admin' }];
    const oldLine = { productId: 'p1', color: '', size: '', qty: 2, priceLYD: 50, costUSDAtSale: 5 };
    state.clothesOrders = [{ id: 'o1', orderNo: 12, customerName: 'Sara', status: 'New', paymentStatus: 'Paid', amountPaidLYD: 100,
      deliveryFeeLYD: 0, lines: [oldLine], stockDeducted: true, _lastModified: 7, createdBy: 'admin' }];
    const fields = { 'clothes-order-customer': 'Sara', 'clothes-order-fee': '0', 'clothes-order-paystatus': 'Paid',
      'clothes-order-paid': '100', 'clothes-order-editing-id': 'o1' };
    sandbox.document.getElementById = id => (id in fields ? { value: fields[id] } : null);
    run(`_clothesTempOrderLines = [${JSON.stringify(oldLine)}, { productId: 'p1', color: '', size: '', qty: 1, priceLYD: 50 }]; _clothesOrderEditBaseline = 7;`);
    let sent = null;
    sandbox.isServerModeEnabled = () => true;
    sandbox.apiMutateClothesOrder = async request => { sent = request; return {}; };
    sandbox.applyClothesOrderMutationResponse = () => {};
    // Before the fix this threw "Assignment to constant variable." and nothing was sent.
    assert.equal(await sandbox.saveClothesOrderFromModal(), true);
    assert.equal(sent.action, 'update');
    assert.equal(sent.orderId, 'o1');
    assert.equal(sent.data.paymentStatus, 'Partially Paid');
    near(sent.data.amountPaidLYD, 100);   // the 100 LYD already collected stays; the new 50 is still to collect
    assert.equal(sent.data.lines.length, 2);
    assert.ok(notes.some(note => note.title === 'Order is now partially paid'));
  });
  await test('clothes: the Partially Paid prompt reads Arabic digits and grouped commas, and refuses unclear text', async () => {
    const cases = [['1,000', 1000], ['١٥٠', 150], ['12,5', 12.5], ['١٬٠٠٠', 1000], ['٥٠٫٢٥', 50.25], [' ‏750.5 ', 750.5], ['1,000.50', 1000.5], ['0', 0],
      ['1.500,00', null], ['12,5.5', null], ['1,5000', null], ['1 500', null], ['abc', null], ['100 LYD', null], ['12.345', null], ['1,2,3', null], ['-5', null], ['99999', null]];
    for (const [typed, expected] of cases) {
      const { sandbox, state, notes } = clothesFixture();
      state.clothesOrders = [{ id: 'o1', orderNo: 3, customerName: 'Sara', status: 'New', paymentStatus: 'Paid', amountPaidLYD: 1500,
        deliveryFeeLYD: 0, lines: [{ productId: 'p1', qty: 1, priceLYD: 1500 }], _lastModified: 4, createdBy: 'admin' }];
      let sent = null;
      sandbox.prompt = () => typed;
      sandbox.isServerModeEnabled = () => true;
      sandbox.apiMutateClothesOrder = async request => { sent = request; return {}; };
      sandbox.applyClothesOrderMutationResponse = () => {};
      await sandbox.setClothesOrderPayment('o1', 'Partially Paid');
      if (expected === null) {
        assert.equal(sent, null, `"${typed}" must not be saved`);
        assert.ok(notes.some(note => note.title === 'Invalid amount'), `"${typed}" must say Invalid amount`);
      } else {
        assert.ok(sent, `"${typed}" must be saved`);
        near(sent.data.amountPaidLYD, expected);   // before: "1,000" saved 1, "١٥٠" saved 0, "12,5" saved 12
      }
    }
  });
  await test('clothes: a new product photo is shrunk to a 600 px JPEG on white; GIFs and unreadable images stay as they were', async () => {
    const png = `data:image/png;base64,${'A'.repeat(5000)}`;
    const jpeg = `data:image/jpeg;base64,${'B'.repeat(400)}`;
    const gif = `data:image/gif;base64,R0lGOD${'C'.repeat(50)}`;
    for (const [source, decodes, expected] of [[png, true, jpeg], [gif, true, gif], [png, false, png]]) {
      const { sandbox, state, run } = clothesFixture();
      const ops = [];
      const ctx = { fillStyle: '', fillRect(...args) { ops.push(['fill', this.fillStyle, ...args]); }, drawImage(img, x, y, w, h) { ops.push(['draw', w, h]); } };
      const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: (type, quality) => { ops.push(['encode', type, quality]); return jpeg; } };
      const makeElement = sandbox.document.createElement;
      sandbox.document.createElement = tag => (tag === 'canvas' ? canvas : makeElement(tag));
      sandbox.Image = function FakeImage() {
        let src = '';
        Object.defineProperty(this, 'src', { get: () => src, set: value => {
          src = value; this.naturalWidth = 1600; this.naturalHeight = 1200;
          Promise.resolve().then(() => (decodes ? this.onload() : this.onerror()));
        } });
      };
      sandbox.compressImageToDataUrl = async () => source;
      state.activeModal = 'clothes-product';
      sandbox.uploadClothesProductPhotoFiles([{ type: 'image/png' }]);
      await settle();
      assert.equal(run('_clothesTempPhoto'), expected);
      if (expected === jpeg) {
        assert.equal(canvas.width, 600);
        assert.equal(canvas.height, 450);
        assert.deepEqual(ops, [['fill', '#ffffff', 0, 0, 600, 450], ['draw', 600, 450], ['encode', 'image/jpeg', 0.75]]);
      } else {
        assert.ok(!ops.some(op => op[0] === 'encode'), 'a GIF or an unreadable image is never re-encoded');
      }
    }
  });
  await test('WhatsApp reminder opens one tab and keeps Albayan on screen (web), with no second open in the app', async () => {
    for (const mode of ['web', 'popup-blocked', 'packaged']) {
      const { sandbox, state } = loadBrowserSource();
      state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
      sandbox.shellDebtorRows = () => [{ customer: { id: 'c1', name: 'Debtor', phone: '0912345678' }, dueLyd: 300 }];
      sandbox.isPackagedMobileApp = () => mode === 'packaged';
      const opens = [];
      const tab = { opener: { name: 'albayan' } };
      // Spec behaviour: a 'noopener'/'noreferrer' feature makes open() return null even when the tab opened.
      sandbox.window.open = (url, target, features = '') => {
        opens.push({ url, target, features });
        if (/noopener|noreferrer/.test(features) || mode !== 'web') return null;
        return tab;
      };
      const home = sandbox.window.location.href;
      sandbox.remindDebtor('c1');
      assert.equal(opens.length, 1);
      assert.ok(opens[0].url.startsWith('https://wa.me/218912345678?text='));
      assert.equal(opens[0].target, '_blank');
      if (mode === 'web') {
        assert.equal(sandbox.window.location.href, home, 'the Albayan tab must not also go to WhatsApp');
        assert.equal(tab.opener, null, 'the WhatsApp tab gets no handle back to Albayan');
      } else if (mode === 'packaged') {
        assert.equal(sandbox.window.location.href, home, 'the app must not launch WhatsApp a second time');
      } else {
        assert.equal(sandbox.window.location.href, opens[0].url, 'a blocked popup still falls back to this tab');
      }
    }
  });
  await test('paywall: the plan purchase carries the price shown on the card, so a changed price is refused (review loop r3 n15)', async () => {
    const { sandbox } = loadBrowserSource();
    const posts = [];
    sandbox.isServerModeEnabled = () => true;
    sandbox.apiJson = async (path, options) => { posts.push({ path, body: JSON.parse(JSON.stringify(options.body)) }); return { subscriptions: [] }; };
    await sandbox.handleSubscribePlan('svc:ad_maker', '', 5000);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/api/subscriptions/purchase-plan');
    assert.equal(posts[0].body.expectedPriceMinor, 5000);  // before: dropped, so the server's 409 price check never ran
    assert.equal(posts[0].body.planId, 'svc:ad_maker');
  });
  await test('paywall: an Arabic reader sees the server\'s plan refusals in Arabic, an English reader the server\'s words (review loop r3 n18)', async () => {
    const { sandbox, state } = loadBrowserSource();
    const notes = [];
    let detail = '';
    sandbox.isServerModeEnabled = () => true;
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.refreshSubscriptionPlans = async () => [];
    sandbox.apiJson = async () => { throw Object.assign(new Error('Request failed'), { status: 409, payload: { detail } }); };
    const arabic = {
      'Insufficient wallet balance': 'الرصيد لا يكفي؛ اشحن المحفظة أولاً.',
      'Plan is no longer sold': 'الباقة غير متاحة.',
      'Plan is not available for subscription': 'الباقة غير متاحة.',
      'Subscription is prepaid too far ahead': 'اشتراكك مدفوع مسبقاً لمدة طويلة.',
      'Service is already active without expiry': 'الخدمة مفعّلة بلا انتهاء.',
      'The plan price changed; reload the plans and try again': 'تغيّر سعر الباقة؛ راجع السعر.',
      'A free plan can only be renewed near its end': 'تُجدَّد الباقة المجانية قرب نهايتها.',
      'Something new the server says': 'حاول مرة أخرى.'
    };
    state.language = 'ar';
    for (const [english, words] of Object.entries(arabic)) {
      detail = english;
      notes.length = 0;
      await sandbox.handleSubscribePlan('svc:ad_maker', '', 100);
      assert.equal(notes.length, 1, english);
      assert.equal(notes[0].type, 'error');
      assert.equal(notes[0].message, words, english);  // before: the raw English detail under an Arabic title
      assert.ok(!/[A-Za-z]/.test(notes[0].title + notes[0].message), english);
    }
    state.language = 'en';
    detail = 'Subscription is prepaid too far ahead';
    notes.length = 0;
    await sandbox.handleSubscribePlan('svc:ad_maker', '', 100);
    assert.equal(notes[0].message, 'Subscription is prepaid too far ahead');
  });
  // ---- review loop r4, batch MG: merge tools and CSV phones ----
  const mergeToolsFixture = ({ ownerSaves = true, closedRows = [], serverMode = false, periodsFail = false } = {}) => {
    const fixture = loadBrowserSource();
    const { sandbox, state, run } = fixture;
    run(fs.readFileSync(path.join(__dirname, '..', 'src', '13b-merge-tools.js'), 'utf8'));
    state.serverMode = serverMode;
    state.customers = [{ id: 'c1', name: 'Hajj Customer' }];
    state.pages = [
      { id: 'pm_meta', name: 'Hajj Travel', metaPageId: '9911', customerIds: [], _lastModified: 10 },
      { id: 'pm_manual', name: 'Hajj Travel', customerIds: ['c1'], _lastModified: 11 }
    ];
    state.ads = [];
    const writes = [];
    const deletes = [];
    const periodCalls = [];
    sandbox.updateRecord = async (array, id, updates) => {
      const collection = array === state.pages ? 'pages' : 'ads';
      writes.push({ collection, id, updates });
      if (collection === 'pages') return ownerSaves;
      const ad = state.ads.find(row => row.id === id);
      // The server's 423: an ad in a closed month refuses every edit, a page move included.
      if (closedRows.some(row => row.status === 'closed' && sandbox._mergeAdPeriod(ad) === row.period)) return false;
      Object.assign(ad, updates);
      return true;
    };
    sandbox.deleteRecord = async (array, id) => { deletes.push(id); return true; };
    sandbox.apiJson = async requestPath => {
      periodCalls.push(requestPath);
      if (periodsFail) throw new Error('offline');
      return closedRows;
    };
    return { ...fixture, writes, deletes, periodCalls };
  };
  await test('page merge (MG #12/#19): a failed owner copy keeps the hand-made page and moves nothing', async () => {
    const { sandbox, state, writes, deletes } = mergeToolsFixture({ ownerSaves: false });
    state.ads = [{ id: 'a1', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-09-01', _lastModified: 5 }];
    const result = await sandbox._mergeOnePageIntoMeta('pm_meta', 'pm_manual');
    assert.equal(result.ok, false, 'a merge that lost the owner reported success');
    assert.deepEqual(deletes, [], 'the only page that recorded the owner was deleted');
    assert.match(result.reason, /owner could not be copied/);
    assert.ok(!writes.some(write => write.collection === 'ads'), 'ads moved onto an owner-less Meta page');
    assert.equal(state.ads[0].pageId, 'pm_manual');
  });
  await test('page merge (MG #12/#19): the owner is copied first, then the ads move, then the old page goes', async () => {
    const { sandbox, state, writes, deletes } = mergeToolsFixture();
    state.ads = [{ id: 'a1', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-09-01', _lastModified: 5 }];
    const result = await sandbox._mergeOnePageIntoMeta('pm_meta', 'pm_manual');
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(writes.map(write => write.collection), ['pages', 'ads']);
    assert.deepEqual(Array.from(writes[0].updates.customerIds), ['c1']);
    assert.deepEqual(deletes, ['pm_manual']);
  });
  await test('page merge (MG #18): ads in a closed month block the merge up front, named, with nothing written', async () => {
    const closedRows = [{ period: '2026-01', status: 'closed' }, { period: '2026-02', status: 'open' }];
    const { sandbox, state, writes, deletes, periodCalls } = mergeToolsFixture({ serverMode: true, closedRows });
    state.ads = [
      { id: 'a_jan', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-01-15' },
      { id: 'a_mar', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-03-02T10:00:00.000Z' },
      // 23:30 UTC on 31 January is already 1 February in Tripoli, an open month (the server's business calendar).
      { id: 'a_feb', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-01-31T23:30:00.000Z' },
      { id: 'a_old', pageId: 'pm_manual', customerId: 'c1', createdAt: '2026-01-05T12:00:00Z' }
    ];
    assert.equal(sandbox._mergeAdPeriod(state.ads[2]), '2026-02');
    assert.equal(sandbox._mergeAdPeriod({ _created: Date.UTC(2026, 0, 20) }), '2026-01');
    const result = await sandbox._mergeOnePageIntoMeta('pm_meta', 'pm_manual');
    assert.equal(result.ok, false);
    assert.deepEqual(writes, [], 'the merge wrote into a page it can never finish');
    assert.deepEqual(deletes, []);
    assert.equal(periodCalls.length, 1);
    assert.match(result.reason, /2 of 4 ads are in closed months \(2026-01\)/);
    assert.match(result.reason, /Hajj Customer \(2026-01\)/);
    assert.match(result.reason, /unlock those months/);
    assert.ok(!/run it again/i.test(result.reason), 'the admin was told to repeat a merge that can never finish');
    state.language = 'ar';
    const arabic = await sandbox._mergeOnePageIntoMeta('pm_meta', 'pm_manual');
    assert.match(arabic.reason, /أشهر مغلقة/);
  });
  await test('page merge (MG #18): unreadable closed months write nothing; Merge all reads them once', async () => {
    const offline = mergeToolsFixture({ serverMode: true, periodsFail: true });
    offline.state.ads = [{ id: 'a1', pageId: 'pm_manual', customerId: 'c1', startDate: '2026-09-01' }];
    const result = await offline.sandbox._mergeOnePageIntoMeta('pm_meta', 'pm_manual');
    assert.equal(result.ok, false);
    assert.deepEqual(offline.writes, []);
    assert.deepEqual(offline.deletes, []);
    const bulk = mergeToolsFixture({ serverMode: true, closedRows: [] });
    bulk.state.pages.push({ id: 'pm_meta2', name: 'Umrah', metaPageId: '7', customerIds: [] }, { id: 'pm_manual2', name: 'Umrah', customerIds: [] });
    bulk.sandbox.closePageDuplicatesDialog = () => {};
    await bulk.sandbox.runAllPageMerges();
    assert.equal(bulk.periodCalls.length, 1, 'every page re-read the closed months');
    assert.deepEqual(bulk.deletes.slice().sort(), ['pm_manual', 'pm_manual2']);
  });
  await test('customer merge (MG #20): a three-way group pairs the kept record with one that shares its phone', async () => {
    const { sandbox, state } = loadBrowserSource();
    const notes = [];
    sandbox.showNotification = (title, message) => notes.push(`${title}: ${message}`);
    let renders = 0;
    sandbox.renderModal = () => { renders += 1; };
    state.serverMode = true;
    state.customers = [
      { id: 'A', name: 'Ali', phones: ['0911111111'], _lastModified: 1 },
      { id: 'C', name: 'Ali C', phones: ['0922222222'], _lastModified: 1 },
      { id: 'B', name: 'Ali B', phones: ['0911111111', '0922222222'], _lastModified: 1 }
    ];
    state.receipts = ['r1', 'r2', 'r3'].map(id => ({ id, customerId: 'A' }));
    assert.equal(sandbox.setCustomerMergePairFromGroup(0), true);
    assert.equal(state.modalData.keepCustomerId, 'A');
    assert.equal(state.modalData.duplicateCustomerId, 'B', 'the default pair shares no phone');
    state.activeModal = 'customer-merge';
    state.modalData.duplicateCustomerId = 'C';
    sandbox.selectCustomerMergeKeep('A');
    assert.equal(state.modalData.duplicateCustomerId, 'B');
    assert.deepEqual(Array.from(sandbox.customerMergeSharedKeys(state.customers[0], state.customers[1])), []);
    // A pair that shares no phone is re-picked on submit instead of "refresh and try again".
    state.modalData.duplicateCustomerId = 'C';
    let merged = false;
    sandbox.apiMergeCustomers = async () => { merged = true; throw new Error('must not be called'); };
    const realGet = sandbox.document.getElementById;
    sandbox.document.getElementById = id => (id === 'customer-merge-confirm' ? { checked: true } : realGet(id));
    await sandbox.handleModalSubmit();
    sandbox.document.getElementById = realGet;
    assert.equal(merged, false);
    assert.ok(renders >= 2, 'the dialog was not re-drawn with a valid pair');
    assert.ok(!notes.some(note => /refresh/i.test(note)), notes.join(' | '));
  });
  await test('merged customer refusal (MG #21) reads right in Arabic on create, edit and the ad form', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.language = 'ar';
    const merged = { status: 409, message: 'This customer was merged into another customer; choose the customer that was kept instead' };
    const latin = /[A-Za-z]/;
    const created = sandbox._serverRefusalToast('create', 'receipts', merged);
    assert.ok(!latin.test(created.join(' ')), created.join(' | '));
    assert.match(created[1], /دُمج هذا العميل/);
    assert.ok(!latin.test(sandbox.describe409(merged, 'x')), 'the edit path kept the English text');
    assert.ok(!latin.test(sandbox._serverRefusalToast('save', 'ads', { status: 404, message: 'Ad customer not found' })[1]));
    assert.ok(!latin.test(sandbox._serverRefusalToast('create', 'ads', { status: 409, message: 'This customer was deleted; restore the customer first' })[1]));
    state.language = 'en';
    assert.equal(sandbox.describe409(merged, 'x'), merged.message);
    const modals = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
    assert.ok(modals.includes(": _serverRefusalToast('save', 'ads', error)[1],"), 'the ad form still shows the raw server text');
    assert.equal(typeof run('_SERVER_REFUSAL_AR'), 'object');
  });
  await test('CSV phones (MG #6) keep the leading 0 and never show an apostrophe, in both exports', async () => {
    const { sandbox, state } = loadBrowserSource();
    assert.equal(sandbox._csvPhoneText('0912345678'), '091 2345678');
    assert.equal(sandbox._csvPhoneText('+218 91 234 5678'), '00218 91 234 5678');
    assert.equal(sandbox._csvPhoneText('+218912345678'), '00218 912345678');
    assert.equal(sandbox._csvPhoneText('00218912345678'), '00218 912345678');
    assert.equal(sandbox._csvPhoneText('021 333 4455'), '021 333 4455');
    assert.equal(sandbox._csvPhoneText(undefined), '');
    // The CSV injection guard still applies to anything that is not a phone.
    assert.equal(sandbox.csvCell(sandbox._csvPhoneText('=HYPERLINK(1)')), `"'=HYPERLINK(1)"`);
    let delivery = '';
    sandbox.downloadFile = content => { delivery = content; return true; };
    state.receipts = [{ id: 'r1', customerId: 'c1', status: 'Not Paid', deliveryStatus: 'Out for Delivery', phoneNumber: '0912345678', amountLocal: 100, amountUSD: 20, exchangeRate: 5 }];
    sandbox.exportDeliveryReport();
    assert.ok(delivery.includes('"091 2345678"'), delivery);
    const clothes = clothesFixture();
    let orders = '';
    clothes.sandbox.downloadFile = content => { orders = content; return true; };
    clothes.sandbox.getFilteredClothesOrders = () => [
      { id: 'o1', orderNo: 1, customerName: 'Mona', customerPhone: '+218 91 234 5678', status: 'new', paymentStatus: 'unpaid', lines: [] },
      { id: 'o2', orderNo: 2, customerName: 'Sara', customerPhone: '0923456789', status: 'new', paymentStatus: 'unpaid', lines: [] }
    ];
    clothes.sandbox.exportClothesOrdersCSV();
    assert.ok(orders.includes('"00218 91 234 5678"') && orders.includes('"092 3456789"'), orders);
    assert.ok(!orders.includes(`"'+`), 'a literal apostrophe reached the clothes CSV');
  });
  await test('password change signs this device out saying "sign in with your new password", never "Session Expired"', async () => {
    const expected = {
      en: ['Password changed successfully', 'Sign in with your new password.'],
      ar: ['تم تغيير كلمة المرور بنجاح', 'سجّل الدخول بكلمة المرور الجديدة.']
    };
    for (const language of ['en', 'ar']) {
      const { sandbox, state } = loadBrowserSource();
      const notes = [];
      sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
      const overlays = [];
      sandbox.showSessionTransitionOverlay = message => { overlays.push(message); return { remove() {} }; };
      sandbox.isServerModeEnabled = () => true;
      sandbox.URLSearchParams = URLSearchParams;  // closeModal clears ?modal= from the address bar
      const fields ={ 'cp-current': 'OldPassword1!', 'cp-new': 'NewPassword1!', 'cp-confirm': 'NewPassword1!' };
      sandbox.document.getElementById = id => (id in fields ? { value: fields[id] } : null);
      const calls = [];
      sandbox.apiChangePassword = async (current, next) => { calls.push([current, next]); return { ok: true, requires_reauth: true }; };
      state.language = language;
      state.currentUser = { id: 'u1', role: 'Employee', permissions: {} };
      state.activeModal = 'change-password';
      await sandbox.handleModalSubmit();
      await settle();
      assert.deepEqual(calls, [['OldPassword1!', 'NewPassword1!']]);
      // Before: the workspace stayed on screen until a later request got 401 and said "Session Expired".
      assert.equal(state.currentUser, null, 'the server ended every session, so this device signs out at once');
      assert.equal(state.activeModal, null);
      assert.deepEqual(notes.map(note => [note.title, note.message, note.type]), [[...expected[language], 'success']]);
      assert.deepEqual(overlays, [expected[language][0]]);
    }
  });
  // ---- Review loop r4, batch BP: ad request form parity and the studio account

  await test('r4 BP n=27: the sanitizer keeps phone= and utm_content= in links, and still strips event handlers', async () => {
    const { run } = studioFixture();
    const wa = 'https://api.whatsapp.com/send?phone=218912345678&utm_content=spring&conversion=1';
    assert.equal(run(`Security.sanitizeInput(${JSON.stringify(wa)})`), wa);
    for (const attack of ['a onclick=b', 'x" onmouseover=alert(1)', '?onerror=x', 'oonclick=nclick=']) {
      const out = String(run(`Security.sanitizeInput(${JSON.stringify(attack)})`));
      assert.ok(!/(^|[^A-Za-z0-9_])on[a-z]+\s*=/i.test(out), `${attack} -> ${out}`);
    }
    // The classic save sends the link as typed, and a stored request read back through sanitizeObject keeps it.
    run(`_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Offer', destination: ${JSON.stringify(wa)} };`);
    assert.equal(run('sanitizedAdsStudioDraft().destination'), wa);
    assert.equal(run(`Security.sanitizeObject({ destination: ${JSON.stringify(wa)} }).destination`), wa);
    const post = 'https://www.facebook.com/shop/posts/1?utm_content=boost';
    run(`_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Boost', boostType: 'boost_post', destination: '', sourcePostRef: ${JSON.stringify(post)} };`);
    const boost = JSON.parse(run('JSON.stringify(sanitizedAdsStudioDraft())'));
    assert.equal(boost.sourcePostRef, post);
    assert.equal(boost.destination, post);
  });

  await test('r4 BP n=28: an https link with @ in its path is a destination (the host check still refuses userinfo)', async () => {
    const { run } = studioFixture();
    for (const link of ['https://www.tiktok.com/@myshop', 'https://www.google.com/maps/place/Shop/@32.8872,13.1913,17z', 'https://www.youtube.com/@channel']) {
      assert.equal(run(`adsStudioIsValidDestination(${JSON.stringify(link)})`), true, link);
      assert.equal(run(`studioBuilderDestination(${JSON.stringify(link)})`), link, link);
    }
    for (const bad of ['https://a.com@evil.com', 'https://user:pw@evil.com', 'https://a.com:1@evil.com', 'http://www.tiktok.com/@shop']) {
      assert.equal(run(`adsStudioIsValidDestination(${JSON.stringify(bad)})`), false, bad);
    }
  });

  await test('r4 BP n=29: an objective changed in classic clears the goal of a v2 request (never refused as T9)', async () => {
    const { run } = studioFixture();
    run("_adsStudioDraft = { ...newAdsStudioDraft(), name: 'From v2', goalDetail: 'messages', objective: 'traffic' };");
    const changed = JSON.parse(run('JSON.stringify(sanitizedAdsStudioDraft())'));
    assert.equal(changed.goalDetail, '');
    assert.equal(changed.objective, 'traffic');
    run("_adsStudioDraft.objective = 'messages';");
    assert.equal(run("Object.prototype.hasOwnProperty.call(sanitizedAdsStudioDraft(), 'goalDetail')"), false);
    run("_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Classic', objective: 'traffic' };");
    assert.equal(run("Object.prototype.hasOwnProperty.call(sanitizedAdsStudioDraft(), 'goalDetail')"), false);
  });

  await test('r4 BP n=30: a link longer than 500 characters is kept whole up to the server limit (2048)', async () => {
    const { run } = studioFixture();
    const long = `https://shop.example.com/p?x=${'a'.repeat(600)}`;
    assert.equal(run(`studioBuilderDestination(${JSON.stringify(long)})`), long);
    run(`_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Long', destination: ${JSON.stringify(long)} };`);
    assert.equal(run('sanitizedAdsStudioDraft().destination'), long);
    assert.ok(String(run('renderAdsStudioCreativeStep()')).includes('maxlength="2048" value="https://shop.example.com/p?x='));
    const field = String(run("studioBuilderDestinationField({ draft: { destination: '' }, shown: {} }, 'content')"));
    assert.ok(field.includes('maxlength="2048"'), field);
    assert.equal(run(`studioBuilderDestination(${JSON.stringify(`https://shop.example.com/p?x=${'a'.repeat(2048)}`)})`), null);
  });

  await test('r4 BP n=40: a Libyan number typed without its 0 is +218 in the classic payload, and a foreign-looking one is refused', async () => {
    const { run } = studioFixture();
    for (const [typed, expected] of [['91 234 5678', '+218912345678'], ['92-123-4567', '+218921234567'], ['0912345678', '+218912345678'], ['+44 20 7946 0958', '+442079460958']]) {
      assert.equal(run(`adsStudioIsValidDestination(${JSON.stringify(typed)})`), true, typed);
      run(`_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Phone', destination: ${JSON.stringify(typed)} };`);
      assert.equal(run('sanitizedAdsStudioDraft().destination'), expected, typed);
      assert.equal(run(`studioBuilderDestination(${JSON.stringify(typed)})`), expected, typed);
    }
    for (const typed of ['21 333 3333', '12345678', '9123456789']) {
      assert.equal(run(`adsStudioIsValidDestination(${JSON.stringify(typed)})`), false, typed);
    }
  });

  await test('r4 BP n=41: a WhatsApp number saved in v2 is shown in the classic help tab and removed there; an admin can remove it from a ticket', async () => {
    const { sandbox, run, calls, renders, replies } = studioFixture();
    replies['/api/studio/profile'] = options => (String(options.method || 'GET') === 'PUT'
      ? { whatsappNumber: null, whatsappConsentAt: null, updatedAt: '2026-09-29T10:00:00Z' }
      : { whatsappNumber: '+218912345678', whatsappConsentAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z' });
    let sheet = null;
    sandbox.studioWalletSheet = options => { sheet = options; };
    let html = String(run('renderStudioHelpClassic()'));
    assert.ok(!html.includes('studio-help-whatsapp-remove'), 'the number is not known before the read');
    await settle();
    assert.equal(calls.filter(call => call.url === '/api/studio/profile' && call.method === 'GET').length, 1);
    assert.ok(renders.length >= 1, 'the classic tab is drawn again when the read is done');
    html = String(run('renderStudioHelpClassic()'));
    assert.ok(html.includes('data-testid="studio-help-whatsapp-number"') && html.includes('+218912345678'), html);
    assert.ok(html.includes('onclick="studioHelpWhatsappRemove()"'));
    assert.equal(calls.filter(call => call.url === '/api/studio/profile' && call.method === 'GET').length, 1, 'one read per session');
    const before = renders.length;
    run('studioHelpWhatsappRemove()');
    assert.ok(sheet && sheet.danger === true, 'an in-page sheet confirms (never a native dialog)');
    sheet.onConfirm();
    await settle(); await settle();
    const put = calls.find(call => call.method === 'PUT');
    assert.deepEqual(JSON.parse(JSON.stringify(put.body)), { whatsappNumber: null, whatsappConsent: false });
    assert.ok(renders.length > before, 'the classic tab is drawn again after the removal');
    assert.ok(!String(run('renderStudioHelpClassic()')).includes('studio-help-whatsapp-remove'));

    // The staff side (classic review tab): an admin who opened the contact link can remove the number.
    sandbox.isCurrentUserAdmin = () => true;
    run("_studioStaff.forUser = studioHelpUserId(); studioStaffThreadSlot('tkt_1').ticket = { id: 'tkt_1', ownerId: 'cust9', status: 'open' }; _studioStaff.contacts.set('tkt_1', { url: 'https://wa.me/218912345678', error: '', loading: null });");
    const thread = String(run("renderStudioStaffThread('tkt_1')"));
    assert.ok(thread.includes('data-testid="studio-staff-whatsapp-remove"') && thread.includes("studioStaffRemoveContact('tkt_1')"), thread);
    replies['/api/studio/staff/customers/cust9/contact'] = { customerId: 'cust9', whatsapp: null };
    sheet = null;
    run("studioStaffRemoveContact('tkt_1')");
    assert.ok(sheet && sheet.danger === true);
    sheet.onConfirm();
    await settle(); await settle();
    assert.ok(calls.some(call => call.url === '/api/studio/staff/customers/cust9/contact' && call.method === 'DELETE'));
    assert.equal(run("_studioStaff.contacts.get('tkt_1').url"), '');
    sandbox.isCurrentUserAdmin = () => false;
    run("_studioStaff.contacts.set('tkt_1', { url: 'https://wa.me/218912345678', error: '', loading: null });");
    assert.ok(!String(run("renderStudioStaffThread('tkt_1')")).includes('studio-staff-whatsapp-remove'), 'a reviewer gets no remove button');
  });

  await test('r4 BP n=44: the classic Add-money amount and currency survive a full render such as the language switch', async () => {
    const { sandbox, state, run } = studioFixture();
    const nodes = { 'ads-studio-charge-amount': { value: '500' }, 'ads-studio-charge-currency': { value: 'LYD' }, 'ads-studio-lyd-preview': { textContent: '' } };
    sandbox.document.getElementById = id => nodes[id] || null;
    run("_adsStudioWalletForUser = String(state.currentUser.id); _adsStudioWalletMine = []; _adsStudioWalletPendingAll = []; _adsStudioPayMethods = [{ id: 'bank_transfer', name: { en: 'Bank', ar: 'مصرف' } }]; _adsStudioPayRate = { usdToLyd: 5 };");
    run('adsStudioUpdateLydPreview()');
    state.language = 'ar';
    let html = String(run('renderAdsStudioWallet()'));
    assert.ok(html.includes('<option value="LYD" selected>'), 'the currency stays LYD');
    assert.ok(/id="ads-studio-charge-amount"[^>]*value="500"/.test(html), 'the amount stays 500');
    // USD shows its LYD preview straight away; another user starts empty on USD.
    nodes['ads-studio-charge-currency'].value = 'USD';
    run('adsStudioUpdateLydPreview()');
    assert.equal(nodes['ads-studio-lyd-preview'].textContent, '≈ 2500.00 LYD @ 5');
    html = String(run('renderAdsStudioWallet()'));
    assert.ok(html.includes('≈ 2500.00 LYD @ 5</span>') && !html.includes('<option value="LYD" selected>'));
    state.currentUser = { id: 'cust2', role: 'Employee', permissions: {} };
    html = String(run('renderAdsStudioWallet()'));
    assert.ok(!/id="ads-studio-charge-amount"[^>]*value="500"/.test(html) && !html.includes('<option value="LYD" selected>'));
    state.language = 'en';
  });

  console.log(`\n${passed} review behavior regressions passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
