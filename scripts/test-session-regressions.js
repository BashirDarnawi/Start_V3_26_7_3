// Desired-behavior regressions for the September session/privacy audit.
// Authoritative browser source in a VM; native/network/storage boundaries are
// mocked. No real camera, credentials, backend, or customer data are accessed.
const assert = require('node:assert/strict');
const loadBrowserSource = require('./helpers/load-browser-source');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const changed = error => error?.code === 'SERVER_SESSION_CHANGED';

function fixture() {
  const f = loadBrowserSource();
  const elements = new Map();
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  f.sandbox.localStorage = f.sandbox.window.localStorage = storage;
  f.sandbox.document.getElementById = id => elements.get(id) || null;
  const makeElement = (id, dataset = {}) => {
    const node = { id, dataset, style: {}, value: '', remove: () => elements.delete(id),
      querySelector: () => null, querySelectorAll: () => [], focus() {},
      classList: { add() {}, remove() {}, toggle() {} } };
    elements.set(id, node);
    return node;
  };
  f.sandbox.nativeHaptic = async () => {};
  return { ...f, elements, makeElement, storage };
}

function cameraFixture(target = 'receipt') {
  const f = fixture();
  f.state.activeModal = target;
  f.state.modalData = { id: 'receipt_a' };
  f.makeElement('receipt-photo-previews');
  if (target === 'delivery') {
    f.makeElement('delivery-complete-modal', { receiptId: 'receipt_a' });
    f.makeElement('delivery-receipt-image-data');
  }
  const routes = [];
  f.sandbox.uploadReceiptPhotos = files => routes.push({ userId: f.state.currentUser.id, id: f.state.modalData.id, files });
  f.sandbox.handleDeliveryReceiptPhotoUpload = files => routes.push({
    userId: f.state.currentUser.id, id: f.elements.get('delivery-complete-modal')?.dataset.receiptId, files
  });
  f.sandbox._nativeCameraResultToFile = async () => ({ name: 'photo.jpg', type: 'image/jpeg' });
  const persist = () => {
    const context = f.sandbox._captureNativePhotoContext(target);
    const { version, createdAt, operationId, userId, scope, entityId } = context;
    const pending = { version, target, createdAt, operationId, userId, scope, entityId };
    f.storage.setItem('albayan_native_photo_pending', JSON.stringify(pending));
    return pending;
  };
  return { ...f, routes, persist, target };
}

async function main() {
  await test('all registered sensitive dialogs and private drafts are removed together', async () => {
    const f = fixture();
    const ids = Array.from(f.run('AUTHENTICATED_DIALOG_IDS'));
    ids.forEach(id => f.makeElement(id));
    let focused = 0;
    f.sandbox.oldOpener = { focus() { focused += 1; } };
    f.run("_companyDebtCoverageDialogState = { busy: true, bodyOverflow: 'hidden', opener: oldOpener }; _customerAdCoverageDialogState = { busy: true, opener: oldOpener }; _receiptPhotoViewerSources = ['private-photo'];");
    f.state.activeModal = 'receipt'; f.state.modalData = { privateNote: 'private' };
    f.state.tempReceiptPhotos = ['private-photo']; f.state.tempAdFunding = ['private-funds'];
    f.storage.setItem('albayan_native_photo_pending', 'private');
    f.storage.setItem('albayan_delivery_draft_receipt_a', 'private draft');
    f.storage.setItem('unrelated-preference', 'keep');
    f.sandbox.resetAuthenticatedServerCaches();
    assert.equal(f.elements.size, 0);
    assert.equal(f.run('_companyDebtCoverageDialogState'), null);
    assert.equal(f.run('_customerAdCoverageDialogState'), null);
    assert.equal(f.run('_receiptPhotoViewerSources.length'), 0);
    assert.equal(f.state.activeModal, null); assert.equal(f.state.modalData, null);
    assert.equal(f.state.tempReceiptPhotos.length, 0); assert.equal(f.state.tempAdFunding, null);
    assert.equal(f.storage.getItem('albayan_native_photo_pending'), null);
    assert.equal(f.storage.getItem('albayan_delivery_draft_receipt_a'), null);
    assert.equal(f.storage.getItem('unrelated-preference'), 'keep');
    assert.equal(focused, 0); assert.equal(f.sandbox.document.body.style.overflow, '');
  });

  for (const path of ['expiry', 'logout', 'permission-change']) {
    await test(`${path} clears dialogs before pending storage/network work finishes`, async () => {
      const f = fixture();
      f.makeElement('company-debt-coverage-modal');
      f.state.activeModal = 'receipt'; f.state.modalData = { id: 'private' };
      const slow = deferred();
      f.sandbox.isServerModeEnabled = () => true;
      f.sandbox.showSessionTransitionOverlay = () => ({ remove() {} });
      f.run('db = null');
      let operation;
      if (path === 'expiry') {
        f.sandbox.wipeAuthenticatedServerDataFromClient = () => slow.promise;
        operation = f.sandbox.handleServerAuthExpired(f.sandbox.getServerSessionIdentity());
      } else if (path === 'logout') {
        f.sandbox.flushPendingUserUpdates = () => slow.promise;
        f.sandbox.apiLogout = async () => {};
        operation = f.sandbox.handleLogout();
      } else {
        f.sandbox.clearServerCollectionsForVisibility = () => slow.promise;
        f.sandbox.serverLoadAllData = async () => ({ ok: true });
        operation = f.sandbox.reloadServerDataForAccessChange({ role: 'Admin', permissions: {} }, () => false);
      }
      await flush();
      assert.equal(f.elements.has('company-debt-coverage-modal'), false);
      assert.equal(f.state.modalData, null);
      slow.resolve(); await operation;
    });
  }

  await test('normal same-form native photo still reaches the existing upload handler', async () => {
    const f = cameraFixture();
    assert.equal(await f.sandbox._deliverNativeCameraResult({}, 'receipt', f.sandbox.capturePhotoPasteContext('receipt')), true);
    assert.equal(f.routes.length, 1); assert.equal(f.routes[0].id, 'receipt_a');
  });
  for (const mutation of ['other-user', 'same-user-new-session', 'new-form', 'reopened-form', 'role-change', 'logout']) {
    await test(`native photo read cannot attach after ${mutation}`, async () => {
      const f = cameraFixture(); const read = deferred();
      f.sandbox._nativeCameraResultToFile = () => read.promise;
      const pending = f.sandbox._deliverNativeCameraResult({}, 'receipt', f.sandbox.capturePhotoPasteContext('receipt'));
      if (mutation === 'other-user') f.state.currentUser = { id: 'next_user', role: 'Employee' };
      if (mutation === 'same-user-new-session') f.sandbox.advanceServerSessionEpoch();
      if (mutation === 'new-form') f.state.modalData = { id: 'receipt_b' };
      if (mutation === 'reopened-form') f.run('_receiptPhotoUploadGeneration += 1');
      if (mutation === 'role-change') f.state.currentUser = { ...f.state.currentUser, role: 'Employee' };
      if (mutation === 'logout') f.sandbox.resetAuthenticatedServerCaches();
      read.resolve({ name: 'old-photo.jpg', type: 'image/jpeg' });
      assert.equal(await pending, false); assert.equal(f.routes.length, 0);
    });
  }
  for (const switched of [false, true]) {
    await test(`native unavailable-target retry ${switched ? 'rejects changed form' : 'retains original form identity'}`, async () => {
      const f = cameraFixture(); f.elements.delete('receipt-photo-previews');
      const wait = deferred(); f.sandbox.setTimeout = callback => { wait.promise.then(callback); return 1; };
      const pending = f.sandbox._deliverNativeCameraResult({}, 'receipt', f.sandbox.capturePhotoPasteContext('receipt'));
      if (switched) f.state.modalData = { id: 'receipt_b' };
      f.makeElement('receipt-photo-previews'); wait.resolve();
      assert.equal(await pending, !switched); assert.equal(f.routes.length, switched ? 0 : 1);
    });
  }
  await test('closing/reopening delivery dialog rejects delayed file read even for same receipt', async () => {
    const f = cameraFixture('delivery'); const read = deferred();
    f.sandbox._nativeCameraResultToFile = () => read.promise;
    const pending = f.sandbox._deliverNativeCameraResult({}, 'delivery', f.sandbox.capturePhotoPasteContext('delivery'));
    f.makeElement('delivery-complete-modal', { receiptId: 'receipt_a' });
    read.resolve({ name: 'photo.jpg', type: 'image/jpeg' });
    assert.equal(await pending, false); assert.equal(f.routes.length, 0);
  });
  await test('restored Android photo reaches only the saved owner and original receipt', async () => {
    const f = cameraFixture('delivery'); const saved = f.persist();
    f.sandbox.advanceServerSessionEpoch(); // process-restored identity may use a fresh epoch
    assert.equal(await f.sandbox._restoreNativeCameraResult({}, saved), true);
    assert.equal(f.routes.length, 1); assert.equal(f.routes[0].id, 'receipt_a');
    assert.equal(f.storage.getItem('albayan_native_photo_pending'), null);
  });
  await test('restored camera waits for auth/form restoration without dropping owner binding', async () => {
    const f = cameraFixture('delivery'); const saved = f.persist(); const user = f.state.currentUser;
    f.state.currentUser = null; f.elements.delete('delivery-complete-modal');
    const wait = deferred(); f.sandbox.setTimeout = callback => { wait.promise.then(callback); return 1; };
    const pending = f.sandbox._restoreNativeCameraResult({}, saved);
    f.state.currentUser = user; f.makeElement('delivery-complete-modal', { receiptId: 'receipt_a' });
    wait.resolve(); assert.equal(await pending, true); assert.equal(f.routes.length, 1);
  });
  for (const invalid of ['different-user', 'expired', 'future', 'legacy-unbound', 'unsaved-form', 'cleared', 'different-server']) {
    await test(`restored native photo rejects ${invalid} context`, async () => {
      const f = cameraFixture('delivery'); const saved = f.persist();
      if (invalid === 'different-user') f.state.currentUser = { id: 'other_user', role: 'Admin' };
      if (invalid === 'expired') saved.createdAt -= 11 * 60 * 1000;
      if (invalid === 'future') saved.createdAt += 60 * 1000;
      if (invalid === 'legacy-unbound') delete saved.version;
      if (invalid === 'unsaved-form') saved.entityId = '';
      if (invalid === 'cleared') f.storage.removeItem('albayan_native_photo_pending');
      if (invalid === 'different-server') saved.scope = 'other-server';
      assert.equal(await f.sandbox._restoreNativeCameraResult({}, saved, 40), false);
      assert.equal(f.routes.length, 0);
    });
  }
  await test('restored camera revalidates user after slow file conversion too', async () => {
    const f = cameraFixture('delivery'); const saved = f.persist(); const read = deferred();
    f.sandbox._nativeCameraResultToFile = () => read.promise;
    const pending = f.sandbox._restoreNativeCameraResult({}, saved);
    f.state.currentUser = { id: 'next_user', role: 'Admin' };
    read.resolve({ name: 'old.jpg', type: 'image/jpeg' });
    assert.equal(await pending, false); assert.equal(f.routes.length, 0);
  });
  await test('stale camera operation cannot remove a newer pending photo', async () => {
    const f = cameraFixture(); const saved = f.persist();
    f.storage.setItem('albayan_native_photo_pending', JSON.stringify({ ...saved, operationId: 'next-op' }));
    f.sandbox._clearNativePhotoPending(saved.operationId);
    assert.equal(JSON.parse(f.storage.getItem('albayan_native_photo_pending')).operationId, 'next-op');
  });

  await test('identity cache and concurrent identity checks share a single same-session request', async () => {
    const f = fixture(); const reply = deferred(); let count = 0;
    f.sandbox.apiJson = () => { count += 1; return reply.promise; };
    const first = f.sandbox.apiAuthMe(); const second = f.sandbox.apiAuthMe();
    reply.resolve(f.state.currentUser);
    assert.equal((await first).id, 'admin'); assert.equal((await second).id, 'admin');
    assert.equal((await f.sandbox.apiAuthMe()).id, 'admin'); assert.equal(count, 1);
  });
  for (const mutation of ['other-user', 'same-user-new-session', 'role-change', 'permission-change', 'cache-reset']) {
    await test(`late auth/me response is rejected after ${mutation}`, async () => {
      const f = fixture(); const reply = deferred(); const old = { ...f.state.currentUser };
      f.sandbox.apiJson = () => reply.promise;
      const pending = f.sandbox.apiAuthMe();
      if (mutation === 'other-user') f.state.currentUser = { id: 'other', role: 'Employee' };
      if (mutation === 'same-user-new-session') f.sandbox.advanceServerSessionEpoch();
      if (mutation === 'role-change') f.state.currentUser.role = 'Employee';
      if (mutation === 'permission-change') f.state.currentUser.permissions = { ads: ['viewOwn'] };
      if (mutation === 'cache-reset') f.sandbox.resetAuthenticatedServerCaches();
      reply.resolve(old);
      await assert.rejects(pending, changed);
      assert.equal(f.run('_sessionCache.user'), null);
    });
  }
  await test('late old-session 401 cannot clear the next user cache', async () => {
    const f = fixture(); const old = deferred(); f.sandbox.apiJson = () => old.promise;
    const pending = f.sandbox.apiAuthMe();
    f.sandbox.advanceServerSessionEpoch(); f.sandbox.resetAuthenticatedServerCaches();
    f.state.currentUser = { id: 'new_user', role: 'Employee' };
    f.sandbox.apiJson = async () => f.state.currentUser;
    await f.sandbox.apiAuthMe();
    old.reject(Object.assign(new Error('expired'), { status: 401 }));
    await assert.rejects(pending, changed);
    assert.equal((await f.sandbox.apiAuthMe()).id, 'new_user');
  });
  await test('expired cache falls back on a timeout only for the same verified session', async () => {
    const f = fixture(); f.sandbox.apiJson = async () => f.state.currentUser;
    await f.sandbox.apiAuthMe(); f.run('_sessionCache.timestamp = 0');
    f.sandbox.setTimeout = callback => { Promise.resolve().then(callback); return 1; };
    f.sandbox.apiJson = async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); };
    assert.equal((await f.sandbox.apiAuthMe()).id, 'admin');
    f.state.currentUser = { id: 'new_user', role: 'Employee' };
    await assert.rejects(f.sandbox.apiAuthMe(), error => error.name === 'AbortError');
  });
  await test('an identity retry cannot send another request under a changed user', async () => {
    const f = fixture(); let requests = 0; let resume;
    f.sandbox.setTimeout = callback => { resume = callback; return 1; };
    f.sandbox.apiJson = async () => { requests += 1; throw new Error('temporary network failure'); };
    const pending = f.sandbox.apiAuthMe(); await flush();
    f.sandbox.advanceServerSessionEpoch(); resume();
    await assert.rejects(pending, changed); assert.equal(requests, 1);
  });
  await test('identity timeout without a verified cache propagates instead of pretending logout', async () => {
    const f = fixture();
    f.sandbox.setTimeout = callback => { Promise.resolve().then(callback); return 1; };
    f.sandbox.apiJson = async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); };
    await assert.rejects(f.sandbox.apiAuthMe(), error => error.name === 'AbortError');
    assert.equal(f.run('_sessionCache.user'), null); assert.equal(f.state.currentUser.id, 'admin');
  });
  for (const mutation of ['other-user', 'same-user-new-session', 'role-change']) {
    await test(`permission refresh caller ignores a late result after ${mutation}`, async () => {
      const f = fixture(); const reply = deferred(); const old = { ...f.state.currentUser };
      f.sandbox.isServerModeEnabled = () => true; f.sandbox.apiAuthMe = () => reply.promise;
      const pending = f.sandbox.refreshCurrentUserPermissions();
      if (mutation === 'other-user') f.state.currentUser = { id: 'next_user', role: 'Employee' };
      if (mutation === 'same-user-new-session') { f.sandbox.advanceServerSessionEpoch(); f.state.currentUser = { ...old, name: 'New session' }; }
      if (mutation === 'role-change') f.state.currentUser = { ...old, role: 'Employee' };
      const expected = { ...f.state.currentUser }; reply.resolve(old);
      assert.equal(await pending, false); assert.deepEqual(f.state.currentUser, expected);
    });
  }
  await test('normal verified permission refresh still applies a changed role', async () => {
    const f = fixture(); f.sandbox.isServerModeEnabled = () => true;
    f.sandbox.apiJson = async () => ({ ...f.state.currentUser, role: 'Employee', permissions: { ads: ['viewOwn'] } });
    assert.equal(await f.sandbox.refreshCurrentUserPermissions(), true);
    assert.equal(f.state.currentUser.role, 'Employee');
  });
  console.log(`\n${passed} session/privacy regressions passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
