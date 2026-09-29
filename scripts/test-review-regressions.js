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
      assert.deepEqual(notes.map(n => `${n.title}/${n.type}`), ['Storage Full/error']);
      saves = true;
      await flush();
      saves = false;
      await flush();
      assert.equal(notes.length, 2, 'a new failing spell after a good save warns again');
    }
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
  console.log(`\n${passed} review behavior regressions passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
