// File pickers and FileReader are deliberately delayed. No real files, users,
// database, or server are touched by these authoritative-source regressions.
const assert = require('node:assert/strict');
const loadBrowserSource = require('./helpers/load-browser-source');

function fixture() {
  const f = loadBrowserSource();
  const pickers = [], readers = [], writes = [], notifications = [];
  f.sandbox.document.createElement = () => {
    const input = { click() {} };
    pickers.push(input);
    return input;
  };
  f.sandbox.FileReader = function () {
    readers.push(this);
    this.readAsText = () => {};
  };
  f.sandbox.showNotification = (...args) => notifications.push(args);
  f.sandbox.markCollectionDirty = () => {};
  f.sandbox.flushDirtyCollections = async () => {};
  f.sandbox.saveState = () => writes.push('state');
  f.sandbox.addAuditLog = () => writes.push('audit');
  f.sandbox.scheduleServerUserUpdate = () => writes.push('server-user');
  f.sandbox.refreshPermissionsModalUi = () => {};
  f.sandbox.normalizeReceiptsFromAds = () => {};
  f.sandbox.clearCollectionCorruption = () => {};
  f.sandbox.markAllCollectionsDirty = () => writes.push('dirty-all');
  f.sandbox.isServerModeEnabled = () => f.state.serverMode;
  f.run('db = null');
  f.state.users.push({ id: 'employee', name: 'Employee', role: 'Employee', permissions: { ads: ['viewOwn'] } });
  const choose = () => pickers.at(-1).onchange({ target: { files: [{ size: 100 }] } });
  const load = value => readers.at(-1).onload({ target: { result: JSON.stringify(value) } });
  return { ...f, pickers, readers, writes, notifications, choose, load };
}

function changeContext(f, change) {
  if (change === 'logout') f.state.currentUser = null;
  if (change === 'other-admin') {
    f.state.currentUser = { id: 'new-admin', role: 'Admin', permissions: {} };
    f.state.users.push(f.state.currentUser);
  }
  if (change === 'new-session') f.run('_serverLiveSync.sessionEpoch += 1');
  if (change === 'revoked') f.state.currentUser.role = 'Employee';
  if (change === 'server-mode') f.state.serverMode = true;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error.message}`); }
}

async function main() {
  for (const operation of ['permissions', 'audit']) {
    const start = f => operation === 'permissions'
      ? f.sandbox.importUserPermissions('employee') : f.sandbox.restoreAuditLogs();
    const payload = operation === 'permissions'
      ? { permissions: { ads: ['view'] } }
      : { logs: [{ id: 'private_log', userId: 'admin', details: 'Private old account data' }], totalLogs: 1 };
    await test(`${operation}: same-session import remains available`, async () => {
      const f = fixture(); start(f); f.choose(); await f.load(payload);
      if (operation === 'permissions') assert.deepEqual(Array.from(f.state.users[1].permissions.ads), ['view']);
      else assert.equal(f.state.logs[0]?.id, 'private_log');
      assert.ok(f.writes.length > 0);
    });
    for (const change of ['logout', 'other-admin', 'new-session', 'revoked', 'server-mode']) {
      for (const boundary of ['picker', 'reader']) {
        await test(`${operation}: ${change} during ${boundary} cannot import`, async () => {
          const f = fixture(); start(f);
          if (boundary === 'reader') f.choose();
          changeContext(f, change);
          if (boundary === 'picker') f.choose();
          if (f.readers.length) await f.load(payload);
          assert.equal(f.writes.length, 0, 'stale importer still wrote data');
          assert.equal(f.state.logs.length, 0, 'private logs entered a different session');
          assert.deepEqual(Array.from(f.state.users.find(u => u.id === 'employee').permissions.ads), ['viewOwn']);
        });
      }
    }
  }
  const legacyBackup = { customers: [{ id: 'old_customer', name: 'Legacy', legacyNote: 'keep me' }],
    pages: [], ads: [], receipts: [], users: [], exchangeRateHistory: [], logs: [] };
  await test('local backup: same-session older data and unknown fields survive', async () => {
    const f = fixture(); f.sandbox.importData(); f.choose(); await f.load(legacyBackup);
    assert.equal(f.state.customers[0]?.id, 'old_customer');
    assert.equal(f.state.customers[0]?.legacyNote, 'keep me');
    assert.ok(f.writes.length > 0);
  });
  await test('local backup: earlier delayed file cannot overwrite a newer completed import', async () => {
    const f = fixture();
    f.sandbox.importData(); f.choose();
    const firstReader = f.readers.at(-1);
    f.sandbox.importData(); f.choose();
    await f.load({ ...legacyBackup, customers: [{ id: 'newer_backup', name: 'Newer' }] });
    await firstReader.onload({ target: { result: JSON.stringify(legacyBackup) } });
    assert.equal(f.state.customers[0]?.id, 'newer_backup');
  });
  for (const change of ['logout', 'other-admin', 'new-session', 'revoked', 'server-mode']) {
    for (const boundary of ['picker', 'reader']) {
      await test(`local backup: ${change} during ${boundary} cannot import`, async () => {
      const f = fixture();
      f.sandbox.apiAdminBulkImport = async () => { f.writes.push('server-restore'); throw new Error('Stop at fake server boundary'); };
      f.sandbox.confirm = () => { f.writes.push('server-restore-prompt'); return false; };
      f.sandbox.stopServerLiveSync = () => {};
      f.sandbox.startServerLiveSync = () => {};
      f.sandbox.importData();
      if (boundary === 'reader') f.choose();
      changeContext(f, change);
      if (boundary === 'picker') f.choose();
      if (f.readers.length) await f.load(legacyBackup);
      assert.equal(f.writes.length, 0, 'stale backup import still ran');
      assert.equal(f.state.customers[0]?.id, 'c1');
      });
    }
  }
  for (const change of ['logout', 'other-admin', 'new-session', 'revoked', 'server-mode']) {
    await test(`audit: ${change} during IndexedDB write stops remaining import`, async () => {
      const f = fixture();
      let finish;
      f.run('db = {}');
      f.sandbox.saveLogToIndexedDB = () => new Promise(resolve => { finish = resolve; });
      f.sandbox.restoreAuditLogs(); f.choose();
      const running = f.load({ logs: [{ id: 'log_1' }, { id: 'log_2', details: 'private second log' }] });
      assert.equal(typeof finish, 'function');
      changeContext(f, change); f.state.logs = [];
      finish(true); await running;
      assert.equal(f.state.logs.length, 0);
      assert.equal(f.writes.length, 0);
    });
  }
  for (const change of ['none', 'logout', 'other-admin', 'new-session', 'revoked', 'server-mode']) {
    await test(`local backup: legacy password hashing with ${change}`, async () => {
      const f = fixture(); let finish;
      f.run('Security.hashPassword = () => __pendingHash()');
      f.sandbox.__pendingHash = () => new Promise(resolve => { finish = resolve; });
      f.sandbox.importData(); f.choose();
      const running = f.load({ ...legacyBackup, users: [{ id: 'legacy_user', name: 'Legacy', password: 'Legacy test password' }] });
      assert.equal(typeof finish, 'function');
      assert.equal(f.state.customers[0]?.id, 'c1', 'import was published before hashing completed');
      assert.equal(f.state.users.some(user => user.password), false, 'plaintext password entered live state');
      if (change !== 'none') changeContext(f, change);
      finish({ hash: 'safe-test-hash', salt: 'safe-test-salt', algo: 'pbkdf2-sha256', iterations: 310000 });
      await running;
      if (change === 'none') {
        assert.equal(f.state.customers[0]?.id, 'old_customer');
        assert.equal(f.state.users[0]?.passwordHash, 'safe-test-hash');
        assert.equal(Object.hasOwn(f.state.users[0], 'password'), false);
      } else {
        assert.equal(f.writes.length, 0, 'stale password migration persisted data');
        assert.equal(f.state.customers[0]?.id, 'c1');
        assert.equal(f.state.users.some(user => user.id === 'legacy_user'), false);
      }
    });
  }
  await test('default password helper still migrates live users and persists metadata', async () => {
    const f = fixture();
    f.state.users = [
      { id: 'plain', password: 'legacy-test-password', extra: 'keep' },
      { id: 'old_hash', passwordHash: 'hash', salt: 'salt' },
      { id: 'old_pbkdf', passwordHash: 'hash2', salt: 'salt2', passwordAlgo: 'pbkdf2-sha256' }
    ];
    f.sandbox.__hash = async () => ({ hash: 'prepared', salt: 'prepared-salt', algo: 'pbkdf2-sha256', iterations: 310000 });
    f.run('Security.hashPassword = __hash');
    await f.sandbox.ensureUsersHavePasswordHashes();
    assert.equal(f.state.users[0].passwordHash, 'prepared');
    assert.equal(f.state.users[0].extra, 'keep');
    assert.equal(Object.hasOwn(f.state.users[0], 'password'), false);
    assert.equal(f.state.users[1].passwordAlgo, 'sha256');
    assert.equal(f.state.users[2].passwordIterations, 310000);
    assert.ok(f.writes.includes('state'));
  });
  await test('failed detached password migration leaves current local data unchanged', async () => {
    const f = fixture();
    f.sandbox.__hash = async () => { throw new Error('Mock crypto unavailable'); };
    f.run('Security.hashPassword = __hash');
    f.sandbox.importData(); f.choose();
    await f.load({ ...legacyBackup, users: [{ id: 'legacy', password: 'test-password' }] });
    assert.equal(f.state.customers[0]?.id, 'c1');
    assert.equal(f.state.users.some(user => user.id === 'legacy'), false);
    assert.equal(f.notifications.at(-1)?.[2], 'error');
  });
  for (const step of ['clear-logs', 'flush-collections', 'sync-logs']) {
    await test(`local backup stops completion after account change during ${step}`, async () => {
      const f = fixture(); let finish;
      f.run('db = {}');
      f.sandbox.clearIndexedDBLogs = async () => {};
      f.sandbox.syncLogsToIndexedDB = async () => {};
      const pending = () => new Promise(resolve => { finish = resolve; });
      if (step === 'clear-logs') f.sandbox.clearIndexedDBLogs = pending;
      if (step === 'flush-collections') f.sandbox.flushDirtyCollections = pending;
      if (step === 'sync-logs') f.sandbox.syncLogsToIndexedDB = pending;
      f.sandbox.importData(); f.choose();
      const running = f.load(legacyBackup);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      assert.equal(typeof finish, 'function');
      changeContext(f, 'other-admin');
      f.state.customers = [{ id: 'new_account_customer' }];
      const priorWrites = f.writes.length;
      const priorNotifications = f.notifications.length;
      finish(); await running;
      assert.equal(f.writes.length, priorWrites);
      assert.equal(f.notifications.length, priorNotifications);
      assert.equal(f.state.customers[0].id, 'new_account_customer');
    });
  }
  for (const operation of ['permissions', 'audit', 'backup']) {
    await test(`${operation}: canceled file picker leaves state untouched`, async () => {
      const f = fixture();
      if (operation === 'permissions') f.sandbox.importUserPermissions('employee');
      if (operation === 'audit') f.sandbox.restoreAuditLogs();
      if (operation === 'backup') f.sandbox.importData();
      await f.pickers.at(-1).onchange({ target: { files: [] } });
      assert.equal(f.writes.length, 0);
      assert.equal(f.readers.length, 0);
    });
  }
  console.log(`Import boundaries: ${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
