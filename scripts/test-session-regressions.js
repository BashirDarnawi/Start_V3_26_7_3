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
        f.state.currentUser.role = 'Employee';  // a real narrowing: this Admin was demoted
        operation = f.sandbox.reloadServerDataForAccessChange({ id: 'admin', role: 'Admin', permissions: {} }, () => false);
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
  // ---- Bug-hunt round 2: iPhone key order, access grants, sign-out address/badge, signed-out dialog links ----
  await test('R2 ios-1: Security.stableJson ignores key order, keeps array order, skips undefined and survives a cycle', async () => {
    const stable = fixture().run('Security.stableJson');
    assert.equal(stable({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } }), stable({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
    assert.notEqual(stable([1, 2]), stable([2, 1]));
    assert.equal(stable({ a: 1, gone: undefined }), '{"a":1}');
    const shared = { x: 1 }; const loop = { shared }; loop.self = loop;
    assert.equal(stable({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
    assert.equal(stable(loop), '{"self":null,"shared":{"x":1}}');
  });
  for (const [label, reply, expected] of [
    ['only reorders the permission keys (iPhone native reply) is no access change', { customers: ['view'], receipts: ['view'] }, false],
    ['adds an action is still an access change', { customers: ['view'], receipts: ['view', 'edit'] }, true]
  ]) {
    await test(`R2 ios-1: a permission refresh that ${label}`, async () => {
      const f = fixture(); f.sandbox.isServerModeEnabled = () => true;
      f.state.currentUser = { id: 'emp', name: 'Emp', role: 'Employee', permissions: { receipts: ['view'], customers: ['view'] }, subscriptions: [] };
      f.state.users = [f.state.currentUser];
      f.sandbox.apiJson = async () => ({ id: 'emp', name: 'Emp', role: 'Employee', permissions: reply, subscriptions: [] });
      assert.equal(await f.sandbox.refreshCurrentUserPermissions(), expected);  // before: true for the reorder too
    });
  }
  // The receipt form re-saved over stored Paid receipt r1; only the serial can differ.
  async function resaveReceipt(payments, serial) {
    const f = fixture();
    f.sandbox.crypto.getRandomValues = v => require('node:crypto').webcrypto.getRandomValues(v);
    f.state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', _lastModified: 1, status: 'Paid', isPaid: true,
      serialNumber: '123', finalReceiptNo: '123', amountUSD: 100, amountLocal: 500, exchangeRate: 5, paymentMethod: 'Cash (LYD)',
      editCount: 1, editHistory: [{ editedAt: '2026-09-01', editedBy: 'Admin', changes: [{ field: 'Status', from: 'Not Paid', to: 'Paid' }] }], payments }];
    const field = value => ({ value, dataset: {}, classList: { add() {}, remove() {} }, focus() {} });
    const nodes = Object.fromEntries(Object.entries({ 'receipt-editing-id': 'r1', 'receipt-customer-id': 'c1', 'receipt-status': 'Paid',
      'paid-collection-value': 'office', 'notpaid-collection-value': 'office', 'receipt-serial': serial, 'receipt-delivery-place': '',
      'receipt-quoted-delivery-fee': '0', 'receipt-phone-search': '' }).map(([id, value]) => [id, field(value)]));
    const cells = { '.payment-method': 'Cash (LYD)', '.payment-amount': '500', '.payment-rate1': '1', '.payment-rate2': '5', '.collection-type': 'office' };
    const row = { querySelector: sel => (sel in cells ? { value: cells[sel] } : null) };
    f.sandbox.document.getElementById = id => nodes[id] || null;
    f.sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? [row] : []);
    const saved = [];
    f.sandbox.updateRecord = async (array, id, record) => { saved.push(record); return true; };
    await f.run('_saveReceiptFromModalInner()');
    assert.equal(saved.length, 1);
    return saved[0];
  }
  await test('R2 ios-1: re-saving a receipt whose payment row the iPhone stored in another key order records no "Payments" edit', async () => {
    const native = [{ rate2: 5, method: 'Cash (LYD)', amount: 500, rate: 1, collectionType: 'office', deliveryPersonId: '' }];
    const same = await resaveReceipt(native, '123');
    assert.equal(same.editCount, 1, JSON.stringify(same.editHistory));  // before: 2, "Payments: 1 payment(s) -> 1 payment(s)"
    assert.equal(same.editHistory.length, 1);
    const serial = await resaveReceipt(native, '124');
    assert.equal(serial.editCount, 2);
    assert.deepEqual(Array.from(serial.editHistory[1].changes, change => change.field), ['Serial Number']);
  });
  await test('R2 ios-1: re-saving an ad whose funding rows the iPhone stored in another key order records no "Receipt Funding" edit', async () => {
    const f = fixture();
    f.state.pages = [{ id: 'p1', name: 'Page', customerId: 'c1' }];
    f.state.receipts = [{ id: 'P', customerId: 'c1', amountUSD: 60, amountLocal: 300, exchangeRate: 5, status: 'Paid', isPaid: true, deliveryStatus: 'Office', payments: [], transfers: [] }];
    const ad = { id: 'adP', customerId: 'c1', pageId: 'p1', status: 'Active', paymentStatus: 'paid', isPaid: true, collectionMethod: 'in_shop',
      deliveryStatus: 'Office', amountUSD: 60, amountLocal: 300, exchangeRate: 5, receiptId: 'P', dueAllocations: [],
      receiptAllocations: [{ amountUSD: 60, receiptId: 'P' }],
      startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-10T00:00:00.000Z', editCount: 0, editHistory: [], _lastModified: 7 };
    Object.assign(f.state, { ads: [ad], modalData: ad, activeModal: 'ad', tempAdFunding: { allocations: [{ receiptId: 'P', amountUSD: '60.00' }] },
      tempMergeFunding: { enabled: false, allocations: [] }, tempAdPhotos: [], tempAdPhotosDirty: false });
    const values = { 'ad-payment-status': 'paid', 'ad-collection-method': '', 'ad-start-date': '2026-09-01', 'ad-end-date': '2026-09-10',
      'ad-days': '9', 'ad-page': 'p1', 'ad-customer-id': 'c1' };
    f.sandbox.document.getElementById = id => (id in values ? { value: values[id], dataset: {}, classList: { add() {}, remove() {}, toggle() {} } } : null);
    const saved = [];
    f.sandbox.isServerModeEnabled = () => true;
    f.sandbox.closeModal = () => {};
    f.sandbox.saveAdThroughAtomicServer = async (action, id, version, data) => { saved.push(data); return data; };
    await f.sandbox.handleModalSubmit();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].editCount, 0, JSON.stringify(saved[0].editHistory));  // before: 1, "Receipt Funding: 1 allocation(s) ..."
  });

  // An admin changed this user's access; live sync runs reloadServerDataForAccessChange.
  function accessChangeFixture(before, after) {
    const f = fixture();
    f.makeElement('app-modal');
    f.state.currentUser = { id: 'emp', name: 'Emp', role: 'Employee', ...after };
    f.state.users = [f.state.currentUser];
    f.state.activeModal = 'receipt'; f.state.modalData = { id: 'r1' };
    f.state.tempReceiptPhotos = ['data:image/jpeg;base64,AAAA']; f.state.receiptSearch = 'Tripoli';
    f.run("_deliveryCompletionOpen = { id: 'r9', lastMod: 7 }; db = null");
    f.storage.setItem('albayan_delivery_draft_r9', '{"notes":"typed"}');
    let loads = 0;
    f.sandbox.serverLoadAllData = async () => { loads += 1; return { ok: true }; };
    const reload = () => f.sandbox.reloadServerDataForAccessChange({ id: 'emp', role: 'Employee', ...before }, () => false);
    return { ...f, reload, loads: () => loads };
  }
  await test('R2 auth-sync-1: a pure grant keeps the open form, its photos, filters and the delivery draft, and still reloads', async () => {
    const f = accessChangeFixture({ permissions: { receipts: ['view'], ads: ['view'] }, subscriptions: ['clothes_system'] },
      { permissions: { ads: ['view', 'export'], receipts: ['view', 'edit'], customers: ['add'] }, subscriptions: ['clothes_system', 'ads_studio'] });
    await f.reload();
    assert.equal(f.state.activeModal, 'receipt'); assert.equal(f.state.modalData?.id, 'r1');  // before: null
    assert.equal(f.state.tempReceiptPhotos.length, 1); assert.equal(f.state.receiptSearch, 'Tripoli');
    assert.equal(f.run('_deliveryCompletionOpen?.id'), 'r9');
    assert.equal(f.storage.getItem('albayan_delivery_draft_r9'), '{"notes":"typed"}');
    assert.equal(f.elements.has('app-modal'), true);
    assert.equal(f.loads(), 1);
  });
  for (const [label, before, after] of [
    ['removing customers.viewContacts (same role)', { permissions: { customers: ['view', 'viewContacts'] } }, { permissions: { customers: ['view'] } }],
    ['adding review to adCampaignRequests (a narrower scope)', { permissions: { adCampaignRequests: ['view'] } }, { permissions: { adCampaignRequests: ['view', 'review'] } }],
    ['a removed subscription', { permissions: {}, subscriptions: ['clothes_system'] }, { permissions: {}, subscriptions: [] }],
    ['a role change', { role: 'Employee', permissions: {} }, { role: 'Delivery', permissions: {} }]
  ]) {
    await test(`R2 auth-sync-1: ${label} still closes the dialogs and drops the drafts`, async () => {
      const f = accessChangeFixture(before, after);
      await f.reload();
      assert.equal(f.state.activeModal, null); assert.equal(f.state.tempReceiptPhotos.length, 0);
      assert.equal(f.storage.getItem('albayan_delivery_draft_r9'), null);
      assert.equal(f.elements.has('app-modal'), false);
      assert.equal(f.loads(), 1);
    });
  }

  // This tab's address bar: replaceState/pushState move it as a browser does.
  function addressBar(f, url) {
    const loc = f.sandbox.window.location;
    const go = next => { const u = new URL(String(next), 'http://localhost'); loc.pathname = u.pathname; loc.search = u.search; loc.href = u.href; };
    f.sandbox.URLSearchParams = URLSearchParams;
    f.sandbox.window.history = { state: null,
      replaceState(value, _title, next) { this.state = value; go(next); }, pushState(value, _title, next) { this.state = value; go(next); } };
    go(url);
    return { go, url: () => loc.pathname + loc.search };
  }
  for (const path of ['logout', 'expiry', 'emergency sign-out']) {
    await test(`R2 auth-sync-4: ${path} drops the filtered address, so the next person's sign-in starts unfiltered`, async () => {
      const f = fixture();
      const address = addressBar(f, '/receipts?customer=c_A1&receipt=r_A9');
      f.sandbox.isServerModeEnabled = () => true;
      f.sandbox.showSessionTransitionOverlay = () => ({ remove() {} });
      f.run('db = null');
      f.state.currentView = 'receipts';
      if (path === 'expiry') {
        await f.sandbox.handleServerAuthExpired(f.sandbox.getServerSessionIdentity());
      } else {
        f.sandbox.flushPendingUserUpdates = async () => {};
        f.sandbox.apiLogout = async () => { if (path !== 'logout') throw new Error('failed logout'); };
        f.sandbox.console.error = () => {};  // the failed logout falls back to emergencyFinishClientSignOut
        await f.sandbox.handleLogout();
      }
      assert.equal(f.state.currentUser, null);
      assert.ok(!address.url().includes('customer='), address.url());  // before: /receipts?customer=c_A1&receipt=r_A9
      const next = { id: 'emp_b', name: 'B', role: 'Employee', permissions: { receipts: ['view'] } };
      f.sandbox.handleLogin = async () => {
        f.state.currentUser = next; f.state.users = [next];
        f.run('resetPerUserListFilters()');
        f.state.currentView = f.sandbox.getPostLoginLandingViewForUser(next);
        return true;
      };
      await f.sandbox.loginFromCurrentRoute('b@example.com', 'pw', false);
      await flush();
      assert.equal(f.state.currentUser, next);
      assert.equal(f.state.receiptCustomerFilter, '');  // before: 'c_A1'
      assert.equal(f.state.receiptRecordFilter, '');  // before: 'r_A9'
    });
  }

  // A body that really mounts the sync badge, and timers fired by hand.
  function badgeFixture() {
    const f = fixture();
    f.sandbox.isServerModeEnabled = () => true;
    f.sandbox.showSessionTransitionOverlay = () => ({ remove() {} });
    f.run('db = null');
    f.sandbox.document.createElement = () => {
      const node = { style: {}, dataset: {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
        remove: () => { if (f.elements.get(node.id) === node) f.elements.delete(node.id); } };
      return node;
    };
    f.sandbox.document.body.appendChild = node => { f.elements.set(node.id, node); return node; };
    const timers = new Map(); let nextId = 0;
    f.sandbox.setTimeout = (fn, ms) => { nextId += 1; timers.set(nextId, { fn, ms }); return nextId; };
    f.sandbox.clearTimeout = id => { timers.delete(id); };
    const fire = ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
    const notes = [];
    f.sandbox.showNotification = (title, message, type) => notes.push(`${type}: ${title}`);
    return { ...f, fire, notes, badge: () => f.elements.get('sync-status-indicator') || null };
  }
  await test('R2 auth-sync-3: a live-sync tick that finds the session expired leaves no "Syncing..." badge on the login screen', async () => {
    const f = badgeFixture();
    f.sandbox.console.warn = () => {};
    f.sandbox.apiFetch = async () => ({ ok: false, status: 401, statusText: '', headers: { get: () => '' }, text: async () => '{"detail":"Not authenticated"}' });
    await f.sandbox.serverLiveSyncTick();  // every request answers 401
    await flush();
    assert.equal(f.state.currentUser, null, 'the 401 signed this device out');
    f.fire(1200);  // the tick's slow-sync badge timer (SYNC_BADGE_SLOW_MS)
    assert.equal(f.badge(), null);  // before: "Syncing..." on the login screen, forever
    assert.equal(f.run('_syncIndicatorShowTimer'), null);
  });
  await test('R2 auth-sync-3: Log out removes a "Sync failed - Tap to retry" badge; a tap while signed out paints and says nothing', async () => {
    const f = badgeFixture();
    f.sandbox.serverLiveSyncOnce = async () => ({ ok: false });  // what a 503 tick returns
    await f.sandbox.serverLiveSyncTick();
    assert.equal(f.badge()?.dataset.status, 'error');
    f.sandbox.flushPendingUserUpdates = async () => {};
    f.sandbox.apiLogout = async () => {};
    await f.sandbox.handleLogout();
    assert.equal(f.badge(), null);  // before: the red badge stayed on the login screen
    f.notes.length = 0;
    await f.sandbox.manualSyncData();
    assert.equal(f.badge(), null); assert.deepEqual(f.notes, []);
  });
  await test('R2 auth-sync-3: a delivery dashboard Refresh tapped while signed out, or still loading at Log out, leaves no badge', async () => {
    const f = badgeFixture();
    const driver = f.state.currentUser;
    f.state.currentUser = null;
    f.sandbox.apiLoadCollectionAll = async () => [];
    await f.sandbox.refreshDeliveryDashboard();
    assert.equal(f.badge(), null); assert.deepEqual(f.notes, []);  // before: "Syncing..." then "Synced" on the login screen
    f.state.currentUser = driver;
    const reply = deferred();
    f.sandbox.apiLoadCollectionAll = () => reply.promise;
    const refreshing = f.sandbox.refreshDeliveryDashboard();
    f.sandbox.flushPendingUserUpdates = async () => {};
    f.sandbox.apiLogout = async () => {};
    await f.sandbox.handleLogout();
    f.notes.length = 0;
    reply.reject(Object.assign(new Error('session changed'), { code: 'SERVER_SESSION_CHANGED' }));
    await refreshing;
    assert.equal(f.badge(), null); assert.deepEqual(f.notes, []);  // before: "Sync failed - Tap to retry" + "Refresh Failed"
  });

  // A dialog link opened while signed out: /receipts?modal=receipt&id=r1.
  function bootLinkFixture() {
    const f = fixture();
    const address = addressBar(f, '/receipts?modal=receipt&id=r1');
    f.run("_bootModalParams = { modal: 'receipt', id: 'r1' }");  // captured as the page loaded
    const timers = [];
    f.sandbox.setTimeout = fn => { timers.push(fn); return timers.length; };
    const opened = [];
    f.sandbox.editReceipt = id => { opened.push(id); f.state.activeModal = 'receipt'; f.state.modalData = { id }; };
    let popstate = null;
    f.sandbox.window.addEventListener = (type, handler) => { if (type === 'popstate') popstate = handler; };
    f.sandbox.setupUrlRouting();
    const back = (url, view) => { address.go(url); popstate({ state: { view } }); };
    const signIn = user => { f.state.currentUser = user; f.state.users = [user]; };
    return { ...f, opened, back, signIn, runTimers: () => timers.splice(0).forEach(fn => fn()) };
  }
  const linkAdmin = { id: 'admin', name: 'Admin', role: 'Admin', permissions: {} };
  await test('R2 auth-sync-5: a dialog link opened while signed out opens right after sign-in, never again on a later Back', async () => {
    const f = bootLinkFixture();
    f.signIn(linkAdmin);
    f.sandbox.restoreRequestedViewAfterLogin('receipts');
    f.runTimers();
    assert.deepEqual(f.opened, ['r1']);  // before: nothing opened at sign-in
    f.sandbox.navigateTo('customers'); f.sandbox.navigateTo('ads');
    f.back('/customers', 'customers'); f.runTimers();
    assert.deepEqual(f.opened, ['r1']);
  });
  await test('R2 auth-sync-5: a sign-in that skips the restore (app browser login) never replays the link on Back', async () => {
    const f = bootLinkFixture();
    f.signIn(linkAdmin);
    f.sandbox.navigateTo('customers'); f.sandbox.navigateTo('ads');
    f.back('/customers', 'customers'); f.runTimers();
    assert.deepEqual(f.opened, []);  // before: the receipt popped open on this Back
  });
  await test('R2 auth-sync-5: a link still pending at Log out is dropped, so the next person\'s sign-in never opens it', async () => {
    const f = bootLinkFixture();
    f.signIn(linkAdmin);  // a sign-in that skipped the restore (app browser login)
    f.sandbox.flushPendingUserUpdates = async () => {};
    f.sandbox.showSessionTransitionOverlay = () => ({ remove() {} });
    f.run("Security.escapeHtml = text => String(text ?? '')");  // this fake document has no innerHTML
    assert.equal(await f.sandbox.handleLogout(), true);
    f.signIn({ id: 'emp', name: 'Emp', role: 'Employee', permissions: { receipts: ['view'] } });
    f.sandbox.restoreRequestedViewAfterLogin('receipts');
    f.runTimers();
    assert.deepEqual(f.opened, []);  // before: the previous session's receipt opened for the next person
  });
  await test('R2 auth-sync-5: a link to a view this user may not open is dropped at sign-in', async () => {
    const f = bootLinkFixture();
    f.signIn({ id: 'emp', name: 'Emp', role: 'Employee', permissions: { customers: ['view'] } });
    f.sandbox.restoreRequestedViewAfterLogin('receipts');
    f.runTimers();
    assert.equal(f.run('_bootModalParams'), null);  // before: still waiting for a Back press
    assert.deepEqual(f.opened, []);
  });
  // Bug hunt r2 (R2-client-auth-sync-2): servers now answer a mistyped current
  // password with 403; older servers answered 401, which apiJson read as an
  // expired session (sign-out + wiped device data) although the session lived.
  for (const status of [403, 401]) {
    await test(`a mistyped current password (HTTP ${status}) keeps the user signed in with their data`, async () => {
      const f = fixture();
      Object.assign(f.sandbox, { AbortController, Response, Headers, DOMException, console: { ...f.sandbox.console, warn() {} } });
      const notes = []; const overlays = []; const requests = [];
      f.sandbox.showNotification = (title, message, type) => notes.push([title, message, type]);
      f.sandbox.showSessionTransitionOverlay = message => { overlays.push(message); return { remove() {} }; };
      f.sandbox.wipeAuthenticatedServerDataFromClient = async () => {};
      f.sandbox.fetch = async (url, options) => {
        requests.push(`${options.method} ${new URL(url, 'http://localhost').pathname}`);
        return new Response(JSON.stringify({ detail: 'Invalid current password' }), { status, headers: { 'Content-Type': 'application/json' } });
      };
      f.makeElement('cp-current').value = 'MistypedOld123!';
      f.makeElement('cp-new').value = 'BrandNewPass123';
      f.makeElement('cp-confirm').value = 'BrandNewPass123';
      f.run('db = null');
      const user = { id: 'u_staff1', name: 'Staff One', role: 'Employee', permissions: { customers: ['view'] } };
      Object.assign(f.state, { serverMode: true, currentUser: user, users: [user], currentView: 'settings',
        customers: [{ id: 'c1', name: 'Customer A' }, { id: 'c2', name: 'Customer B' }], receipts: [{ id: 'r1', customerId: 'c1' }],
        activeModal: 'change-password', modalData: {} });
      await f.sandbox.handleModalSubmit();
      for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(requests, ['POST /api/auth/password-change']);
      assert.equal(f.state.currentUser, user, 'still signed in: the server session is valid');
      assert.equal(f.state.customers.length, 2); assert.equal(f.state.receipts.length, 1);
      assert.equal(f.state.activeModal, 'change-password', 'the dialog stays open for another try');
      assert.deepEqual(overlays, []);
      assert.deepEqual(notes, [['Error', 'Invalid current password', 'error']], 'no "Session Expired"');
    });
  }
  // Bug hunt r34 (R4-ios-capacitor-bridge-2): the phone apps reported a timed-out or dropped save as a
  // refusal (a fake HTTP 499: "Not allowed"), or as an unknown error; the web says the answer was lost.
  await test('R4 ios-capacitor-bridge-2: a native timeout or dropped connection reads as a lost answer, never a refusal', async () => {
    const fs = require('fs');
    const path = require('path');
    const f = fixture();
    f.sandbox.DOMException = DOMException;
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    for (const file of manifest.lazy['studio.js']) f.run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    f.run("Platform._cache = Object.assign({}, Platform.detect(), { isCapacitor: true, platform: 'ios', isIOS: true })");
    let reply = () => new Promise(() => {});
    f.sandbox.window.Capacitor = { Plugins: { CapacitorHttp: { request: () => reply() } } };
    const send = controller => f.sandbox._nativeAwareFetch('https://app.example/api/social-studio/posts', { method: 'POST', headers: {} }, { caption: 'x' }, controller, 20000);
    // 1. The JS deadline: the plugin never answers and the timer aborts.
    const controller = new AbortController();
    let calls = 0;
    const pending = f.sandbox.withRetry(() => { calls += 1; return send(controller); });
    controller.abort();
    const timeout = await pending.then(() => null, e => e);
    assert.equal(timeout?.name, 'AbortError');
    assert.equal(timeout?.status, undefined, 'before: a fake HTTP 499');
    assert.equal(timeout?.noRetry, true);
    assert.equal(calls, 1, 'a write that may have committed is never re-sent');
    assert.notEqual(f.sandbox._serverRefusalToast('save', 'receipts', timeout)[0], 'Not allowed');
    assert.match(f.sandbox.describeNetworkError(timeout), /could not be confirmed and may have gone through/);
    assert.equal(f.sandbox.studioErrorInfo(timeout, 'action').code, 'NETWORK');
    assert.equal(f.sandbox.socialAnswerLost(timeout), true, 'Social Studio must say the post may have been saved');
    // 2. The plugin's own failure (an NSURLError timeout): the browser's 'Load failed'.
    reply = () => Promise.reject(Object.assign(new Error('The request timed out.'), { code: 'NSURLErrorDomain' }));
    const dropped = await send(new AbortController()).then(() => null, e => e);
    assert.equal(dropped?.name, 'TypeError');
    assert.equal(dropped?.message, 'Load failed');
    assert.equal(dropped?.status, undefined);
    assert.equal(f.sandbox.studioErrorInfo(dropped, 'action').code, 'NETWORK', 'before: UNKNOWN');
    assert.match(String(f.sandbox.describeNetworkError(dropped)), /could not be confirmed/);
    // 3. An HTTP answer still resolves as a Response with its status.
    reply = async () => ({ status: 403, data: { detail: 'Forbidden' }, headers: {} });
    Object.assign(f.sandbox, { Response, Headers });
    const answered = await send(new AbortController());
    assert.equal(answered.status, 403);
  });
  console.log(`\n${passed} session/privacy regressions passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
