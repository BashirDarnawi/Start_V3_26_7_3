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

// The Meta Sync / Meta Insights dialogs are the lazy meta-tools.js bundle: load its sources on top.
function metaToolsFixture() {
  const fixture = loadBrowserSource();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
  for (const file of manifest.lazy['meta-tools.js']) fixture.run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
  return fixture;
}

// Let promise chains started inside the sandbox settle (it shares this microtask queue).
const settle = () => new Promise(resolve => setImmediate(resolve));

// A classList that remembers its classes (the fake document's one forgets them).
function fakeClassList() {
  const set = new Set();
  return { add: (...names) => names.forEach(n => set.add(n)), remove: (...names) => names.forEach(n => set.delete(n)), contains: n => set.has(n), toggle() {} };
}

// Plain escaping for sandboxes that render whole views (the fake document has no innerHTML).
const plainEscape = value => (value === null || value === undefined ? '' : String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

// True when every occurrence of text in the markup sits inside an element with the no-print class.
function everyOccurrenceNoPrint(html, text) {
  let found = 0;
  for (let at = html.indexOf(text); at >= 0; at = html.indexOf(text, at + 1)) {
    found += 1;
    const stack = [];
    const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
    let m;
    while ((m = tags.exec(html)) && m.index < at) {
      if (!m[2]) continue;
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const i = stack.map(e => e.tag).lastIndexOf(tag);
        if (i >= 0) stack.length = i;
      } else if (!/^(br|img|input|hr|meta|link|source)$/.test(tag) && !/\/\s*$/.test(m[3])) {
        stack.push({ tag, cls: (m[3].match(/class="([^"]*)"/) || [])[1] || '' });
      }
    }
    if (!stack.some(e => /(^|\s)no-print(\s|$)/.test(e.cls))) return false;
  }
  assert.ok(found > 0, `the markup never shows ${text}`);
  return true;
}

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

// The classic Social Studio (15f, lazy studio.js) on top of the startup files, its API held by the test.
function socialFixture() {
  const fixture = loadBrowserSource();
  for (const file of ['systems/ads_studio/15c-ads-studio.js', 'systems/ads_studio/15f-social-studio.js']) {
    fixture.run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
  }
  fixture.state.currentView = 'ads-studio';
  fixture.sandbox.socialStudioAvailable = () => true;
  fixture.sandbox.socialRefreshNow = () => {};
  const notes = [];
  fixture.sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
  const calls = [];
  const gates = [];
  fixture.sandbox.apiJson = (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(JSON.stringify(options.body)) : null });
    return new Promise((resolve, reject) => gates.push({ resolve, reject }));
  };
  fixture.run("_social.forUser = 'admin'; _social.pages = [{ id: 'page_a', name: 'Page A', platform: 'fb' }]; _social.posts = []; _social.rules = [];");
  const compose = (mode = 'now') => fixture.run(`_social.composer = { id: '', pageIds: ['page_a'], caption: 'A caption', media: [], mode: '${mode}',
    scheduledAt: ${mode === 'schedule' ? 'socialIsoToLocalInput(new Date(Date.now() + 3 * 3600000).toISOString())' : "''"}, autoReply: false, autoReplyRuleId: '' }; _social.screen = 'compose';`);
  const refusal = detail => Object.assign(new Error(detail), { status: 400, payload: { detail } });
  return { ...fixture, notes, calls, gates, compose, refusal };
}

async function main() {
  await test('classic composer (review loop r4 #31): a retry after a lost answer sends the same operationId, so the server saves one post', async () => {
    const { sandbox, run, calls, gates, compose } = socialFixture();
    compose('schedule');
    const first = sandbox.socialComposerSave('schedule');
    gates[0].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));  // the 20 s timeout
    await first;
    assert.equal(run('_social.composer.id'), '', 'no answer: the composer still has no post id');
    const second = sandbox.socialComposerSave('schedule');
    gates[1].resolve({ post: { id: 'spost_saved', status: 'scheduled' } });
    await second;
    const creates = calls.filter(c => c.url === '/api/social-studio/posts' && c.method === 'POST');
    assert.equal(creates.length, 2);
    assert.ok(creates[0].body.operationId, 'the create carries an operationId');  // before: none, a second post
    assert.equal(creates[1].body.operationId, creates[0].body.operationId);
    assert.match(creates[0].body.operationId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/);  // the server's shape
    assert.equal(run('_social.screen'), 'post-done');
  });
  await test('classic composer (review loop r4 #33): a Schedule save that raced a keystroke says it was scheduled with the earlier text, never "Saved as a draft"', async () => {
    for (const [action, status, title] of [['schedule', 'scheduled', 'Scheduled with the earlier text'], ['draft', 'draft', 'Saved as a draft']]) {
      const { sandbox, run, notes, calls, gates, compose } = socialFixture();
      compose('schedule');
      const op = sandbox.socialComposerSave(action);
      run("_social.composer.caption = 'A caption, fixed'");  // typed while the save was on its way
      gates[0].resolve({ post: { id: 'spost_saved', status } });
      await op;
      assert.deepEqual(notes.map(n => n.title), [title], `${action}: ${JSON.stringify(notes)}`);
      if (action === 'schedule') assert.equal(notes[0].type, 'warning');
      assert.equal(run('_social.composer.caption'), 'A caption, fixed');
      assert.equal(run('_social.composer.id'), 'spost_saved');
      assert.equal(calls.length, 1);
      // One more Schedule sends the newer text to the same post (an edit, no operationId).
      const again = sandbox.socialComposerSave(action);
      gates[1].resolve({ post: { id: 'spost_saved', status } });
      await again;
      assert.equal(calls[1].method, 'PATCH');
      assert.equal(calls[1].url, '/api/social-studio/posts/spost_saved');
      assert.equal(calls[1].body.caption, 'A caption, fixed');
      assert.ok(!('operationId' in calls[1].body));
    }
  });
  await test('classic composer and rule editor (review loop r4 #32): Back while saving is never silent', async () => {
    // "Publish now", Back, the save lands: kept as a draft, not published (as before), and said.
    let f = socialFixture();
    f.compose('now');
    let op = f.sandbox.socialComposerSave('now');
    f.sandbox.socialComposerClose();
    f.gates[0].resolve({ post: { id: 'spost_saved', status: 'draft' } });
    await op;
    assert.equal(f.calls.length, 1, 'no publish after Back');
    assert.equal(f.run('_social.composer'), null);
    assert.deepEqual(f.notes.map(n => [n.title, n.type]), [['Saved as a draft, not published', 'warning']]);
    // Schedule, Back, the server refuses: nothing was saved, and it is said.
    f = socialFixture();
    f.compose('schedule');
    op = f.sandbox.socialComposerSave('schedule');
    f.sandbox.socialComposerClose();
    f.gates[0].reject(f.refusal('scheduledAt must be at least one minute in the future'));
    await op;
    assert.deepEqual(f.notes.map(n => [n.title, n.type]), [['Could not save the post', 'error']]);
    // A keystroke while the save failed is no reason to hide the failure either.
    f = socialFixture();
    f.compose('schedule');
    op = f.sandbox.socialComposerSave('schedule');
    f.run("_social.composer.caption = 'Typed meanwhile'");
    f.gates[0].reject(f.refusal('Choose at least one page'));
    await op;
    assert.deepEqual(f.notes.map(n => n.title), ['Could not save the post']);
    // A rule save refused after Back.
    f = socialFixture();
    f.run("_social.ruleDraft = { ...socialNewRule(), id: 'rule_a', name: 'Rule A', trigger: 'every', publicReply: 'Thank you' }; _social.screen = 'rule';");
    op = f.sandbox.socialRuleSave();
    f.sandbox.socialRuleClose();
    f.gates[0].reject(f.refusal('publicReply must be 1000 characters or fewer'));
    await op;
    assert.deepEqual(f.notes.map(n => [n.title, n.type]), [['Could not save the rule', 'error']]);
    // Schedule, Back, the answer is lost (the 20 s timeout, a dropped connection, a gateway 5xx): the post
    // may be saved and a new editor has a new operationId, so it must not say "Please try again".
    const lost = [Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }), new TypeError('Failed to fetch'),
      Object.assign(new Error('Gateway Timeout'), { status: 504, payload: '<html>504</html>' })];
    for (const error of lost) {
      f = socialFixture();
      f.compose('schedule');
      op = f.sandbox.socialComposerSave('schedule');
      f.sandbox.socialComposerClose();
      f.gates[0].reject(error);
      await op;
      assert.equal(f.notes.length, 1, `${error.name}: ${JSON.stringify(f.notes)}`);
      assert.equal(f.notes[0].type, 'warning');
      assert.equal(f.notes[0].title, 'The answer did not arrive');
      assert.doesNotMatch(f.notes[0].message, /try again/i);
      assert.match(f.notes[0].message, /may have been saved/);
    }
    // Still in the editor, a lost answer keeps "try again": the retry reuses the same operationId.
    f = socialFixture();
    f.compose('schedule');
    op = f.sandbox.socialComposerSave('schedule');
    f.gates[0].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await op;
    assert.deepEqual(f.notes.map(n => [n.title, n.message, n.type]), [['Could not save the post', 'Please try again.', 'error']]);
    // A new rule, Back, the answer is lost: the same warning, never "Please try again" (no second rule).
    f = socialFixture();
    f.run("_social.ruleDraft = { ...socialNewRule(), id: '', name: 'Rule B', trigger: 'every', publicReply: 'Thank you' }; _social.screen = 'rule';");
    op = f.sandbox.socialRuleSave();
    f.sandbox.socialRuleClose();
    f.gates[0].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await op;
    assert.equal(f.calls[0].method, 'POST');
    assert.deepEqual(f.notes.map(n => [n.title, n.type]), [['The answer did not arrive', 'warning']]);
    assert.match(f.notes[0].message, /rule may have been saved/);
    // Another session meanwhile stays silent (the late-session rule).
    f = socialFixture();
    f.compose('now');
    op = f.sandbox.socialComposerSave('now');
    f.sandbox.resetAuthenticatedServerCaches();
    f.state.currentUser = { id: 'customer_b', role: 'Customer', permissions: {} };
    f.gates[0].reject(f.refusal('Choose at least one page'));
    await op;
    assert.deepEqual(f.notes, []);
  });
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
  // R1 ios-webview-runtime-1: the test above passes only because its getElementById never finds the gate.
  // With the gate really on screen (#app holds nothing else), Retry cleared the blocked flag together with
  // the gate, so a signed-out phone whose connection came back was left on a blank page.
  await test('R1 ios-webview-runtime-1: a cold start blocked on the "No internet" gate reloads when the connection is back; a signed-in user renders instead', async () => {
    for (const signedIn of [false, true]) {
      const { sandbox, state, run } = loadBrowserSource();
      const nodes = new Map();
      const app = { id: 'app', querySelector: () => null };
      Object.defineProperty(app, 'innerHTML', { get: () => '', set(html) {
        if (!html.includes('id="mobile-connection-gate"')) return;
        nodes.set('mobile-connection-gate', { id: 'mobile-connection-gate', querySelector: () => null, remove: () => nodes.delete('mobile-connection-gate') });
      } });
      nodes.set('app', app);
      sandbox.document.getElementById = id => nodes.get(id) || null;
      let reloads = 0, renders = 0;
      sandbox.window.location.reload = () => { reloads += 1; };
      sandbox.render = () => { renders += 1; };
      sandbox.isPackagedMobileApp = () => true;
      sandbox.apiHealthCheck = async () => true;
      sandbox.serverLiveSyncTick = async () => {};
      state.serverMode = true;
      state.currentUser = signedIn ? { id: 'admin', role: 'Admin', permissions: {} } : null;
      run('setMobileColdStartBlocked(true)');
      assert.ok(nodes.has('mobile-connection-gate'), 'the gate is drawn into #app');
      assert.equal(await sandbox.retryMobileConnection(), true);
      assert.equal(nodes.has('mobile-connection-gate'), false, 'the gate is gone');
      assert.equal(reloads, signedIn ? 0 : 1, signedIn ? 'a signed-in user is not reloaded' : 'before: no reload, a blank screen');
      assert.equal(renders, signedIn ? 1 : 0);
      assert.equal(run('_mobileColdStartBlocked'), false);
    }
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
    const { sandbox, state, run } = metaToolsFixture();
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
  await test('sign-out resets the Meta dialog state from the startup bundle alone (meta-tools.js never loaded)', async () => {
    const { sandbox, run } = loadBrowserSource();
    assert.equal(run('typeof openMetaAdsConnectionModalNow'), 'undefined', 'the dialogs are not in the startup bundle');
    assert.equal(run('typeof openMetaAdsConnectionModal'), 'function', 'the row and header opener is');
    run("metaInsightsUi.funds = { accounts: [] }; metaInsightsUi.open = true; metaAdsUi.busyAction = 'sync';");
    sandbox.resetAuthenticatedServerCaches();
    assert.equal(run('metaInsightsUi.funds'), null);
    assert.equal(run('metaInsightsUi.open'), false);
    assert.equal(run('metaAdsUi.busyAction'), '');
  });
  // Review loop r2 M2 #3: only the version check's "Conflict: ..." 409 is "the ad changed"; the
  // link's other 409s (a Studio ad, a Meta ad another Albayan ad holds) show the server's reason.
  await test('Meta link: a 409 that is not a version conflict shows the server reason, in both languages', async () => {
    const linkWith = async (message, language = 'en') => {
      const { sandbox, state, run } = metaToolsFixture();
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
      const { sandbox, state, run } = metaToolsFixture();
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
    const { sandbox, state } = metaToolsFixture();
    state.language = 'en';
    const notes = [];
    sandbox.metaAdsRenderModal = () => {};
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.apiRunMetaAutoImport = async () => ({ imported: [], busy: false, state: {} });
    await sandbox.metaAdsCheckForNewAds();
    assert.equal(notes[0].message, 'There are no new ads right now.', 'a finished pass with nothing new still says so');
  });
  // Review loop r7 M: a tiny body for the Meta dialogs (the harness's fake document keeps no nodes).
  function metaDialogDom({ sandbox, run }) {
    const nodes = new Map();
    run('Security.escapeHtml = s => String(s ?? "")');
    sandbox.document.getElementById = id => nodes.get(id) || null;
    sandbox.document.querySelectorAll = selector => (/mobile-dialog-overlay/.test(selector) ? [...nodes.values()] : []);
    sandbox.document.body.appendChild = node => {
      nodes.set(node.id, node);
      node.remove = () => { if (nodes.get(node.id) === node) nodes.delete(node.id); };
      return node;
    };
    sandbox.isServerModeEnabled = () => true;
    return nodes;
  }
  await test('r7 M n=1: a Meta Sync dialog closed while it loads stays closed when the load ends (X, or a sign-out that aborts it)', async () => {
    for (const closeWith of ['x', 'sign-out']) {
      const fixture = metaToolsFixture();
      const { sandbox } = fixture;
      const nodes = metaDialogDom(fixture);
      let status;
      sandbox.apiMetaAdsStatus = () => new Promise((resolve, reject) => { status = { resolve, reject }; });
      sandbox.apiMetaAdsAccounts = async () => [{ id: '111', name: 'Previous admin account', currency: 'USD' }];
      sandbox.apiMetaAdsForAccount = async () => [{ id: '9', name: 'Previous admin ad' }];
      sandbox.openMetaAdsConnectionModalNow();
      assert.ok(nodes.has('meta-ads-modal'), 'the dialog opens on its loading card');
      if (closeWith === 'x') sandbox.closeMetaAdsConnectionModal();
      else sandbox.resetAuthenticatedServerCaches();
      assert.ok(!nodes.has('meta-ads-modal'));
      if (closeWith === 'x') status.resolve({ configured: true });
      else status.reject(new Error('signal is aborted without reason'));
      await settle();
      assert.ok(!nodes.has('meta-ads-modal'), `${closeWith}: the late answer must not bring the dialog back`);
    }
  });
  await test('r7 M n=1: Android Back closes Meta Sync and Meta Insights through their closers, so a later load cannot reopen them', async () => {
    const fixture = metaToolsFixture();
    const { sandbox, run } = fixture;
    const nodes = metaDialogDom(fixture);
    let status;
    sandbox.apiMetaAdsStatus = () => new Promise(resolve => { status = resolve; });
    sandbox.openMetaAdsConnectionModalNow();
    assert.equal(sandbox.closeTopMobileSurface(), true);
    assert.ok(!nodes.has('meta-ads-modal'));
    status({ configured: false });
    await settle();
    assert.ok(!nodes.has('meta-ads-modal'), 'Meta Sync stays closed after Back');
    let pages;
    sandbox.apiMetaPartnerPages = () => new Promise(resolve => { pages = resolve; });
    sandbox.apiMetaAccountFunds = () => new Promise(() => {});
    sandbox.openMetaInsightsModalNow();
    assert.ok(nodes.has('meta-insights-modal'));
    assert.equal(sandbox.closeTopMobileSurface(), true);
    assert.equal(run('metaInsightsUi.open'), false, 'Back runs the Meta Insights closer');
    pages({ pages: [] });
    await settle();
    assert.ok(!nodes.has('meta-insights-modal'), 'Meta Insights stays closed after Back');
  });
  // Bug hunt R6 (R6-android-runtime-4): phone Back removed the company-funds dialogs without their closers,
  // so <body> stayed overflow:hidden (the phone header stopped sticking) and the dialog state stayed behind.
  await test('R6 android-runtime-4: Android Back closes the company-funds dialogs through their closers; a busy request keeps its dialog', async () => {
    const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; SM-A145F; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
    for (const id of ['company-debt-coverage-modal', 'customer-ad-coverage-modal', 'company-coverage-receipt-picker']) {
      for (const busy of id === 'company-coverage-receipt-picker' ? [false] : [false, true]) {
        const { sandbox, run } = loadBrowserSource();
        sandbox.window.Capacitor = { Plugins: {} };
        sandbox.navigator.userAgent = androidUserAgent;
        run('Platform._cache = null');
        let open = true;
        const dialog = { id, className: 'mobile-dialog-overlay fixed inset-0 z-[80]', isConnected: true, _bodyOverflow: '', focus() {},
          remove() { open = false; this.isConnected = false; } };
        sandbox.document.querySelectorAll = selector => (open && selector.includes('.mobile-dialog-overlay') ? [dialog] : []);
        sandbox.document.getElementById = name => (open && name === id ? dialog : null);
        const removedListeners = [];
        sandbox.document.removeEventListener = type => removedListeners.push(type);
        sandbox.document.body.style.overflow = 'hidden'; // what each opener sets
        if (id === 'company-debt-coverage-modal') run(`_companyDebtCoverageDialogState = { bodyOverflow: '', opener: null, busy: ${busy}, keyHandler: _handleCompanyDebtCoverageKeydown }`);
        if (id === 'customer-ad-coverage-modal') run(`_customerAdCoverageDialogState = { bodyOverflow: '', opener: null, busy: ${busy}, keyHandler: _handleCustomerAdCoverageKeydown }`);
        if (id === 'company-coverage-receipt-picker') dialog._keyHandler = () => {};
        assert.equal(sandbox.closeTopMobileSurface(), true, `${id}: Back is handled`);
        assert.equal(open, busy, `${id}: ${busy ? 'a busy request keeps its dialog (like its X)' : 'the dialog closes'}`);
        assert.equal(sandbox.document.body.style.overflow, busy ? 'hidden' : '', `${id}: before, the page stayed scroll-locked`);
        assert.equal(run('_companyDebtCoverageDialogState === null && _customerAdCoverageDialogState === null'), !busy, `${id}: before, the dialog state stayed behind`);
        assert.deepEqual(removedListeners, busy ? [] : ['keydown'], `${id}: its Escape/Tab handler goes with it`);
      }
    }
  });
  await test('r7 M n=2: a slow reply for the previous ad account or search never fills the list of the newer choice', async () => {
    const { sandbox, run } = metaToolsFixture();
    sandbox.metaAdsRenderModal = () => {};
    const pending = {};
    sandbox.apiMetaAdsForAccount = (accountId, search) => new Promise(resolve => { pending[`${accountId}/${search}`] = resolve; });
    const first = sandbox.metaAdsSelectAccount('111');
    const second = sandbox.metaAdsSelectAccount('222');
    pending['222/']([{ id: '2' }]);
    await settle();
    pending['111/']([{ id: '1' }]);
    await Promise.all([first, second]);
    assert.equal(run('metaAdsUi.selectedAccountId'), '222');
    assert.equal(run("metaAdsUi.ads.map(ad => ad.id).join(',')"), '2', 'account 111 ads must not show under account 222');
    assert.equal(run('metaAdsUi.loadingAds'), false);
    const older = sandbox.metaAdsSearch('old');
    const newer = sandbox.metaAdsSearch('new');
    pending['222/old']([{ id: 'o' }]);
    await settle();
    assert.equal(run('metaAdsUi.loadingAds'), true, 'the older reply does not end the newer search\'s loading state');
    assert.notEqual(run("metaAdsUi.ads.map(ad => ad.id).join(',')"), 'o', 'the older search result is dropped');
    pending['222/new']([{ id: 'n' }]);
    await Promise.all([older, newer]);
    assert.equal(run("metaAdsUi.ads.map(ad => ad.id).join(',')"), 'n');
    assert.equal(run('metaAdsUi.loadingAds'), false);
    // A reply for a dialog that was closed and opened again (same account) never lands in the new one.
    const late = sandbox.metaAdsSelectAccount('333');
    sandbox.closeMetaAdsConnectionModal();
    sandbox.isServerModeEnabled = () => true;
    sandbox.apiMetaAdsStatus = () => new Promise(() => {});
    run("state.ads = [{ id: 'ad1', metaAdId: '5', metaAdAccountId: '333' }]");
    sandbox.openMetaAdsConnectionModalNow('ad1');
    assert.equal(run('metaAdsUi.open'), true, 'the dialog opened again');
    assert.equal(run('metaAdsUi.selectedAccountId'), '333');
    pending['333/']([{ id: '3' }]);
    await late;
    assert.equal(run("metaAdsUi.ads.map(ad => ad.id).join(',')"), '', 'the reopened dialog starts empty');
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

  await test('r4 BP n=41 follow-up: with the Help service off (no Help tab, no tickets) the classic Overview shows and removes the number', async () => {
    const { sandbox, run, calls, renders, replies } = studioFixture();
    replies['/api/studio/profile'] = options => (String(options.method || 'GET') === 'PUT'
      ? { whatsappNumber: null, whatsappConsentAt: null, updatedAt: '2026-09-29T10:00:00Z' }
      : { whatsappNumber: '+218912345678', whatsappConsentAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z' });
    let sheet = null;
    sandbox.studioWalletSheet = options => { sheet = options; };
    sandbox.refreshAdsStudioLimits = () => {};  // the /me read of the budget limits is not this test's business
    // Help is off for this customer (the default services.help 'off', or 'pilot' after leaving the allowlist).
    assert.equal(run('studioHelpClassicTab()'), false);
    assert.ok(!run('adsStudioTabsForUser()').some(tab => tab.id === 'help'), 'no classic Help tab');
    run("_adsStudioActiveTab = 'dashboard';");
    let html = String(run('renderAdsStudioView()'));
    assert.ok(!html.includes('studio-classic-whatsapp'), 'the number is not known before the read');
    await settle(); await settle();
    assert.equal(calls.filter(call => call.url === '/api/studio/profile' && call.method === 'GET').length, 1);
    assert.ok(renders.length >= 1, 'the Overview is drawn again when the read is done');
    html = String(run('renderAdsStudioView()'));
    assert.ok(html.includes('data-testid="studio-classic-whatsapp"') && html.includes('data-testid="studio-help-whatsapp-number"') && html.includes('+218912345678'), html);
    assert.ok(html.includes('onclick="studioHelpWhatsappRemove()"'));
    run('studioHelpWhatsappRemove()');
    assert.ok(sheet && sheet.danger === true, 'an in-page sheet confirms (never a native dialog)');
    sheet.onConfirm();
    await settle(); await settle();
    const put = calls.find(call => call.method === 'PUT' && call.url === '/api/studio/profile');
    assert.deepEqual(JSON.parse(JSON.stringify(put.body)), { whatsappNumber: null, whatsappConsent: false });
    assert.ok(!String(run('renderAdsStudioView()')).includes('studio-classic-whatsapp'), 'gone once removed');
    // A lapsed subscription (the classic paywall) still shows it: the promise is "at any time".
    replies['/api/studio/profile'] = { whatsappNumber: '+218912345678', whatsappConsentAt: '2026-09-01T10:00:00Z' };
    run("state.currentUser = { id: 'cust3', role: 'Employee', permissions: { adCampaignRequests: ['viewOwn'] }, subscriptions: [] }; state.users = [state.currentUser];");
    run('renderAdsStudioView()');
    await settle(); await settle();
    assert.ok(String(run('renderAdsStudioView()')).includes('data-testid="studio-classic-whatsapp"'));
  });

  await test('r4 BP n=41 follow-up: an admin removes a number with no ticket and without handing it out first', async () => {
    const { sandbox, run, calls, replies } = studioFixture();
    let sheet = null;
    sandbox.studioWalletSheet = options => { sheet = options; };
    const notes = [];
    sandbox.showNotification = (title, text, type) => { notes.push({ title, text, type }); };
    sandbox.isCurrentUserAdmin = () => true;
    replies['/api/studio/staff/tickets?status=active'] = { items: [], nextCursor: null };
    // On a ticket: the Remove button stands next to "Message on WhatsApp" (the number was never read).
    run("_studioStaff.forUser = studioHelpUserId(); studioStaffThreadSlot('tkt_2').ticket = { id: 'tkt_2', ownerId: 'cust8', status: 'open' };");
    const thread = String(run("renderStudioStaffThread('tkt_2')"));
    assert.ok(thread.includes('data-testid="studio-staff-whatsapp"') && thread.includes("studioStaffRemoveContact('tkt_2')"), thread);
    replies['/api/studio/staff/customers/cust8/contact'] = options => (String(options.method) === 'DELETE' ? { customerId: 'cust8', whatsapp: null, removed: false } : Promise.reject(new Error('the number must not be read')));
    run("studioStaffRemoveContact('tkt_2')");
    assert.ok(sheet && sheet.danger === true, 'an in-page sheet confirms');
    sheet.onConfirm();
    await settle(); await settle();
    assert.deepEqual(calls.filter(call => call.url.startsWith('/api/studio/staff/customers/cust8/contact')).map(call => call.method), ['DELETE'], 'no GET (no contact_link hand-out)');
    assert.ok(/nothing to remove/i.test(String(run("_studioStaff.contacts.get('tkt_2').error"))), 'the answer says there was nothing to remove');
    assert.equal(notes.at(-1).type, 'success');

    // With no ticket at all: the admin card in the staff tickets section takes the customer's user id.
    let section = String(run('renderStudioStaffTicketsClassic()'));
    assert.ok(section.includes('data-testid="studio-staff-remover"') && section.includes('onclick="studioStaffRemoverAsk()"'), section);
    sheet = null;
    run("studioStaffRemoverDraft({ value: 'not an id!' }); studioStaffRemoverAsk();");
    assert.equal(sheet, null, 'a bad id opens nothing');
    assert.ok(String(run('renderStudioStaffTicketsClassic()')).includes('data-testid="studio-staff-remover-note"'));
    replies['/api/studio/staff/customers/cust7/contact'] = options => (String(options.method) === 'DELETE' ? { customerId: 'cust7', whatsapp: null, removed: true } : Promise.reject(new Error('the number must not be read')));
    run("studioStaffRemoverDraft({ value: ' cust7 ' }); studioStaffRemoverAsk();");
    assert.ok(sheet && sheet.danger === true);
    sheet.onConfirm();
    await settle(); await settle();
    assert.deepEqual(calls.filter(call => call.url.startsWith('/api/studio/staff/customers/cust7/')).map(call => call.method), ['DELETE']);
    assert.equal(run('_studioStaff.remover.error'), 'The number was removed.');
    // A reviewer gets neither the card nor the ticket's Remove button.
    sandbox.isCurrentUserAdmin = () => false;
    run("state.currentUser.permissions = { adCampaignRequests: ['view', 'review'] };");
    section = String(run('renderStudioStaffTicketsClassic()'));
    assert.ok(section.includes('data-testid="studio-staff-tickets"') && !section.includes('studio-staff-remover'), section);
    assert.ok(!String(run("renderStudioStaffThread('tkt_2')")).includes('studio-staff-whatsapp-remove'));
    sheet = null;
    run("studioStaffRemoverDraft({ value: 'cust7' }); studioStaffRemoverAsk();");
    assert.equal(sheet, null, 'the removal itself refuses a reviewer');
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

  // ---- Review loop r5 batch MGR: Manager money screens and Arabic texts ----
  const realEscape = "Security.escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')";
  await test('r5 MGR n=11: driver completion shows the exact 107.25 LYD debt and the real 0.25 shortfall, never "107" and "remaining 0"', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.language = 'ar';
    state.customers = [{ id: 'c1', name: 'Ali' }];
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', tempReceiptNo: 'D1', status: 'Not Paid', isPaid: false,
      statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'In Progress', deliveryPersonId: 'admin',
      amountUSD: 15, amountLocal: 0, exchangeRate: 7.15, payments: [], transfers: [] }];
    const created = [];
    const realCreate = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const element = realCreate(tag); created.push(element); return element; };
    await sandbox.openReceiptDeliveryCompletionModal('r1');
    const modal = created.find(element => element.id === 'delivery-complete-modal');
    assert.ok(modal, 'the completion dialog was not built');
    assert.match(String(modal.innerHTML), /id="delivery-complete-debt"[^>]*>107\.25 LYD</);
    // The driver types the 107 they were shown: the verdict names the 0.25 that stays owed.
    const nodes = { 'delivery-complete-modal': { dataset: { receiptId: 'r1' } }, 'delivery-collected-total': {}, 'delivery-fee-compare': {}, 'delivery-debt-compare': {} };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.getPaymentTotalsFromDom = () => ({ totalR1: 107, totalR2: 0 });
    sandbox._readDeliveryFeeLyd = () => 0;
    sandbox.updateReceiptDeliveryCompletionComputed();
    assert.ok(nodes['delivery-debt-compare'].textContent.includes('0.25 LYD'), nodes['delivery-debt-compare'].textContent);
    assert.equal(nodes['delivery-collected-total'].textContent, '107.00 LYD');
  });
  await test('r5 MGR n=12: a settled or company-covered underpaid delivery leaves the uncollected tile, the CSV and the card', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.language = 'en';
    state.customers = [{ id: 'c1', name: 'Ali' }];
    const base = { recordType: 'receipt', customerId: 'c1', statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'Delivered',
      paymentResult: 'UNDERPAID', remainingDue: 50, amountCollectedFromCustomer: 450, debtAmountLocal: 500, debtAmountUSD: 100,
      amountLocal: 450, amountUSD: 90, exchangeRate: 5, payments: [], transfers: [], createdAt: '2026-09-01' };
    state.receipts = [
      { ...base, id: 'settled', tempReceiptNo: 'D1', status: 'Paid', isPaid: true, customerOutstandingUSD: 10 },    // uncovered settle keeps the old outstanding
      { ...base, id: 'covered', tempReceiptNo: 'D2', status: 'Not Paid', isPaid: false, companyCoveredUSD: 10, customerOutstandingUSD: 0 },
      { ...base, id: 'owed', tempReceiptNo: 'D3', status: 'Not Paid', isPaid: false, customerOutstandingUSD: 10 }
    ];
    const due = id => sandbox._getOutstandingDueLocal(state.receipts.find(receipt => receipt.id === id));
    assert.equal(due('settled'), 0);
    assert.equal(due('covered'), 0);
    near(due('owed'), 50);
    near(sandbox._getOutstandingDueLocal({ ...base, id: 'legacy', status: 'Not Paid', isPaid: false }), 50);  // legacy row: stored shortfall still counts
    near(sandbox._getOutstandingDueLocal({ ...base, id: 'partly', status: 'Not Paid', isPaid: false, companyCoveredUSD: 6, customerOutstandingUSD: 4 }), 20);
    // USD-cent rounding of the stored outstanding ($6.99 x 7.15 = 49.98) never trims the exact 50.00 shortfall.
    near(sandbox._getOutstandingDueLocal({ ...base, id: 'rounded', status: 'Not Paid', isPaid: false, debtAmountLocal: 715, exchangeRate: 7.15, customerOutstandingUSD: 6.99 }), 50);
    const html = String(sandbox.renderReceiptsView());
    const card = id => html.split('data-receipt-id="').find(part => part.startsWith(`${id}"`)) || '';
    assert.ok(card('settled') && card('covered') && card('owed'), 'every receipt card rendered');
    assert.ok(!/Remaining 50/.test(card('settled')) && !/Remaining 50/.test(card('covered')), 'a settled or covered receipt still shows "Remaining 50"');
    assert.ok(/Remaining 50\.00 LYD/.test(card('owed')), 'the real shortfall is still shown');
  });
  await test('r5 MGR n=13/14/17: closed-month, duplicate-number and company-funding refusals read right in Arabic, under "Not allowed"', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.language = 'ar';
    const closed = { status: 423, message: 'Financial period 2026-08 is closed. An Admin must unlock it before editing.' };
    const toast = sandbox._serverRefusalToast('save', 'receipts', closed);
    assert.equal(toast[0], 'غير مسموح');
    assert.ok(toast[1].includes('2026-08') && toast[1].includes('مُقفل') && !/Financial|Admin/.test(toast[1]), toast[1]);
    const busy = sandbox._serverRefusalText('Financial period 2026-08 is being closed or unlocked; retry after it finishes');
    assert.ok(busy.includes('2026-08') && !/[A-Za-z]/.test(busy), busy);
    for (const message of ['serialNumber already exists', 'Receipt number already exists', 'finalReceiptNo already exists', 'tempReceiptNo already exists',
      'Final spend cannot be less than recorded company funding; reconcile company coverage separately first', "Spent amount exceeds the ad's funding baseline"]) {
      const text = sandbox.describe409({ status: 409, message }, 'x');
      assert.ok(!/[A-Za-z]/.test(text), text);
    }
    // The destroyed-receipt dialog: the server's duplicate refusal, not "serialNumber already exists".
    const notes = [];
    sandbox.showNotification = (title, message) => notes.push(`${title}: ${message}`);
    state.serverMode = true;
    sandbox.document.getElementById = id => (id === 'destroyed-receipt-number' ? { value: '98765' } : null);
    sandbox.apiCreateEntity = async () => { throw Object.assign(new Error('serialNumber already exists'), { status: 409, payload: { detail: 'serialNumber already exists' } }); };
    await sandbox._saveDestroyedReceipt(null);
    assert.ok(notes.length && !/[A-Za-z]/.test(notes[notes.length - 1]), notes.join(' | '));
    // The new-receipt form now uses the same bilingual toast (no "HTTP 409 -" prefix).
    const forms = fs.readFileSync(path.join(__dirname, '..', 'src', '14-forms.js'), 'utf8');
    assert.ok(forms.includes("showNotification(..._serverRefusalToast('create', 'receipts', e), 'error');") && !forms.includes('HTTP ${e.status}'));
    const actions = fs.readFileSync(path.join(__dirname, '..', 'src', '16-actions-io.js'), 'utf8');
    assert.ok(actions.includes(": (_serverRefusalText(error?.message) || (isAr ? 'فشل حفظ إيقاف الإعلان.'"), 'the ad stop shows a 423 raw');
    state.language = 'en';
    assert.equal(sandbox._serverRefusalToast('save', 'receipts', closed)[0], 'Not allowed');
    assert.equal(sandbox._serverRefusalToast('save', 'receipts', { status: 500, message: 'boom' })[0], 'Server Error');
    assert.equal(sandbox.describe409({ status: 409, message: 'serialNumber already exists' }, 'x'), 'This receipt number is already used by another receipt. Check the number and try again.');
    assert.equal(sandbox._serverRefusalText(closed.message), closed.message);
  });
  await test('r5 MGR n=15: the admin wallet ledger shows other people\'s money without a red minus, with both names and bilingual titles', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.language = 'ar';
    state.currentUser = { id: 'adm', role: 'Admin', permissions: {} };
    state.users = [state.currentUser, { id: 'cust1', name: 'Ali', role: 'Customer' }];
    state.walletTransactions = [
      { id: 't1', type: 'credit', fromUserId: null, toUserId: 'cust1', amountMinor: 5000, currency: 'USD' },
      { id: 't2', type: 'campaign_payment', fromUserId: 'cust1', toUserId: 'system', amountMinor: 400, currency: 'USD' },
      { id: 't3', type: 'credit', fromUserId: null, toUserId: 'adm', amountMinor: 700, currency: 'USD' }
    ];
    const rows = String(sandbox.renderWalletView()).split('workspace-wallet-row').slice(1);
    assert.equal(rows.length, 3);
    assert.ok(rows[0].includes('شحن المحفظة') && rows[0].includes('Ali') && !rows[0].includes('text-rose-600') && !/-\s*50\.00/.test(rows[0]), rows[0]);
    assert.ok(rows[1].includes('ميزانية حملة') && rows[1].includes('Ali') && rows[1].includes('النظام') && !rows[1].includes('text-rose-600'), rows[1]);
    assert.ok(/\+7\.00/.test(rows[2]) && rows[2].includes('text-emerald-600'), 'the admin\'s own top-up keeps its + sign');
    assert.ok(!rows.some(row => />(credit|campaign_payment)</.test(row)), 'a raw type code is the title');
  });
  await test('R2 meta-ads-4: a lean server ad row shows Albayan\'s archived Meta creative through its route, never only the expiring signed link', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    const signed = 'https://scontent.xx.fbcdn.net/v/t45.1600-4/123_n.jpg?oh=x&oe=66AA0000';
    // Exactly what GET /api/collections/ads?include_media=false returns once the photo count is 0: no inline copy, no _mediaOmitted.
    const lean = { id: 'ad 7', recordType: 'ad', metaAdId: '120000000000777', metaThumbnailUrl: signed, metaThumbnailArchivedFrom: signed,
      _lastModified: 1790894613404, _photoCount: 0 };
    const route = '/api/collections/ads/ad%207/meta-thumbnail?v=1790894613404';
    state.serverMode = true;
    assert.equal(sandbox.metaAdThumbnailSrc(lean), route, 'before: the signed fbcdn link, which expires');
    assert.equal(sandbox.metaAdThumbnailSrc({ ...lean, metaThumbnailData: 'data:image/jpeg;base64,QUJD' }), 'data:image/jpeg;base64,QUJD');
    assert.equal(sandbox.metaAdThumbnailSrc({ ...lean, metaThumbnailArchivedFrom: '' }), signed, 'nothing archived yet: the signed link');
    const tile = String(sandbox.renderMetaAdThumbnail(lean, false));
    assert.ok(tile.includes(`src="${route}"`) && !tile.includes('referrerpolicy') && tile.includes('onerror="metaAdsThumbnailError(this)"'), tile);
    const fresh = String(sandbox.renderMetaAdThumbnail({ ...lean, metaThumbnailArchivedFrom: '' }, false));
    assert.ok(fresh.includes(`src="${plainEscape(signed)}"`) && fresh.includes('referrerpolicy="no-referrer"') && !fresh.includes('crossorigin'), fresh);
    // The packaged app: the <img> goes through the session interceptor with credentials, like an uploaded photo,
    // while the manager shell's safety check still sees a plain https link (an iPhone origin is capacitor://).
    state.serverBaseUrl = 'https://albayanhub.com';
    run('Platform.detect()').isCapacitor = true;
    sandbox.window.Capacitor = { getServerUrl: () => 'capacitor://localhost' };
    const packaged = String(sandbox.renderMetaAdThumbnail(lean, false));
    assert.ok(packaged.includes(`src="capacitor://localhost/_capacitor_http_interceptor_?u=${encodeURIComponent(`https://albayanhub.com${route}`)}"`)
      && packaged.includes('crossorigin="use-credentials"'), packaged);
    assert.equal(sandbox.isSafeReceiptPhotoSource(sandbox.metaAdThumbnailSrc(lean)), true, 'the manager shell would drop the tile');
    // Local mode never asks a server.
    state.serverMode = false;
    assert.equal(sandbox.metaAdThumbnailSrc(lean), signed);
  });
  await test('r5 MGR n=16: Meta money on ad cards is 1,250.00 in Arabic too, never the ar-LY 1.250,00', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.language = 'ar';
    const text = sandbox.metaAdsFormatMoney(125000, 'USD');
    assert.ok(text.includes('1,250.00') && !text.includes('1.250,00'), text);
  });
  await test('r5 MGR n=18: the month-close prompt, the month check and the Control Center panels speak Arabic', async () => {
    const { sandbox, state, run } = controlCenterFixture();
    state.language = 'ar';
    sandbox.apiPreviewFinancialPeriod = async () => ({ totals: {}, blockers: [
      { code: 'unpaid_receipts', count: 12, message: 'Receipts are still unpaid' },
      { code: 'ads_need_setup', count: 3, message: 'Ads still need customer, amount, or payment setup' },
      { code: 'ads_still_running', count: 1, message: 'Ads from this month are still running (not stopped or completed)' }] });
    let prompted = '';
    let alerted = '';
    sandbox.window.prompt = text => { prompted = text; return ''; };
    sandbox.window.alert = text => { alerted = text; };
    sandbox.document.getElementById = id => (id === 'control-center-period' ? { value: '2026-08' } : null);
    await sandbox.closeControlCenterMonth();
    assert.ok(prompted.includes('(12)') && !/[A-Za-z]{3,}/.test(prompted), prompted);
    await sandbox.previewControlCenterMonth();
    assert.ok(alerted.includes('(3)') && !/[A-Za-z]{3,}/.test(alerted), alerted);
    assert.equal(sandbox.controlCenterTimestamp(0), 'أبداً');
    state.serverMode = true;
    run(`_controlCenter.error = ''; _controlCenter.operations = { backup: {}, monitoring: { recent_error_rate: 0.3, recent_sample_size: 100, response_ms_p95: 5000, total_requests: 100 },
      setupTasks: ['Enable encrypted daily backups', 'Connect an operations alert webhook'] }; _controlCenter.meta = { webhookConfigured: false };
      _planManager.loadedAt = Date.now(); _planManager.plans = [{ id: 'p1', name: 'P', nameAr: 'خ', serviceIds: ['ad_maker'], priceMinor: 100, durationDays: 30 }];`);
    const html = String(sandbox.renderControlCenterView());
    for (const english of ['Meta instant notifications need setup', 'Server errors need attention', 'Server responses are slow', 'Enable encrypted daily backups',
      'Connect an operations alert webhook', 'This protection needs one server setting', '>Never<', 'Save all plans', '>Reload<', 'Subscription plans &', '>Days<', 'Add a bundle']) {
      assert.ok(!html.includes(english), english);
    }
    assert.ok(html.includes('فعّل النسخ الاحتياطي اليومي المشفّر'));
    state.language = 'en';
  });
  await test('R2 clothes-operations-1: the month check names open deliveries and cash still with drivers, in Arabic too', async () => {
    const { sandbox, state } = controlCenterFixture();
    sandbox.apiPreviewFinancialPeriod = async () => ({ totals: {}, blockers: [
      { code: 'deliveries_open', count: 2, message: 'Delivery jobs from this month are still open' },
      { code: 'driver_cash_not_handed_over', count: 1, message: "Drivers still hold cash collected for this month's deliveries" }] });
    let alerted = '';
    sandbox.window.alert = text => { alerted = text; };
    sandbox.document.getElementById = id => (id === 'control-center-period' ? { value: '2026-08' } : null);
    state.language = 'ar';
    await sandbox.previewControlCenterMonth();
    assert.ok(alerted.includes('مهام توصيل من هذا الشهر لا تزال مفتوحة (2)') && alerted.includes('(1)') && !/[A-Za-z]{3,}/.test(alerted),
      `before: the server's English - ${alerted}`);
    state.language = 'en';
    await sandbox.previewControlCenterMonth();
    assert.ok(alerted.includes('Delivery jobs from this month are still open (2)')
      && alerted.includes("Drivers still hold cash collected for this month's deliveries (1)"), alerted);
  });
  await test('R6 ads-lifecycle-1: the month check names every ad still running, not only Meta ads, in English and Arabic', async () => {
    const { sandbox, state } = controlCenterFixture();
    sandbox.apiPreviewFinancialPeriod = async () => ({ totals: {}, blockers: [
      { code: 'ads_still_running', count: 2, message: 'Ads from this month are still running (not stopped or completed)' }] });
    let alerted = '';
    sandbox.window.alert = text => { alerted = text; };
    sandbox.document.getElementById = id => (id === 'control-center-period' ? { value: '2026-08' } : null);
    await sandbox.previewControlCenterMonth();
    assert.ok(alerted.includes('Ads from this month are still running (not stopped or completed) (2)') && !alerted.includes('Meta ads'), `before: "Meta ads ..." - ${alerted}`);
    state.language = 'ar';
    await sandbox.previewControlCenterMonth();
    assert.ok(alerted.includes('إعلانات من هذا الشهر لا تزال تعمل (لم تُوقف ولم تكتمل) (2)') && !alerted.includes('ميتا') && !/[A-Za-z]{3,}/.test(alerted), alerted);
    state.language = 'en';
  });
  await test('r5 MGR n=11 follow-up: the driver job list and the collected-payment chips show 107.25 LYD, not a rounded 107', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.language = 'en';
    state.currentUser = { id: 'drv1', name: 'Driver', role: 'Delivery', permissions: {} };
    state.customers = [{ id: 'c1', name: 'Ali' }];
    const debt = { recordType: 'receipt', customerId: 'c1', status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' },
      amountUSD: 15, amountLocal: 0, exchangeRate: 7.15, payments: [], transfers: [], createdAt: '2026-09-01' };
    state.receipts = [{ ...debt, id: 'r1', tempReceiptNo: 'D1', deliveryStatus: 'In Progress', deliveryPersonId: 'drv1' }];
    const job = String(sandbox.renderDeliveryDashboard());
    assert.ok(job.includes('$15.00 (107.25 LYD)') && !job.includes('(107 LYD)'), 'the driver job list rounds the debt to whole dinars');
    state.currentUser = { id: 'adm', name: 'Admin', role: 'Admin', permissions: {} };
    state.receipts = [{ ...debt, id: 'r2', tempReceiptNo: 'D2', deliveryStatus: 'Delivered', collected: true, collectedAmount: 107.25,
      collectedMatchesReceipt: false, collectedPayments: [{ method: 'Cash', amount: 100.25 }, { method: 'Bank Transfer', amount: 7 }] }];
    const card = String(sandbox.renderReceiptsView());
    assert.ok(/: 100\.25 LYD</.test(card) && /: 7\.00 LYD</.test(card) && !/: 100 LYD</.test(card), 'a collected-payment chip rounds to whole dinars');
  });
  // ---- Review loop r6 batch A: Manager ad screens ----
  const conflict409 = () => Object.assign(new Error('Conflict: ad has changed'), { status: 409 });
  await test('r6 A n=14: the Top-ups modal saves against the version it opened with and a conflict reloads its list', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    const t1 = { date: '2026-09-01T00:00:00.000Z', amount: 10, extendDays: 0, note: 'T1' };
    const t2 = { date: '2026-09-02T00:00:00.000Z', amount: 20, extendDays: 5, note: 'T2' };
    const base = { id: 'adX', customerId: 'c1', status: 'Active', paymentStatus: 'paid', isPaid: true, exchangeRate: 5, initialAmountUSD: 50 };
    const opened = { ...base, amountUSD: 60, topUps: [t1], _lastModified: 100 };
    const live = { ...base, amountUSD: 80, topUps: [t1, t2], _lastModified: 200 };  // a colleague added T2 meanwhile
    state.ads = [live];
    state.modalData = opened;
    state.activeModal = 'top-ups';
    run(`tempTopUps = [${JSON.stringify(t1)}, { date: '2026-09-03T00:00:00.000Z', amount: 15, extendDays: 0, note: 'T3' }]`);
    const notes = [];
    const sent = [];
    sandbox.showNotification = (title, message, type) => notes.push({ message, type });
    sandbox.isServerModeEnabled = () => true;
    sandbox.renderModal = () => {};
    sandbox.closeModal = () => { throw new Error('the modal must stay open with the reloaded list'); };
    sandbox.saveAdThroughAtomicServer = async (action, id, version, data) => { sent.push({ version, data }); throw conflict409(); };
    sandbox.apiGetEntity = async () => ({ id: 'adX', data: live, lastModified: 200 });
    sandbox.applyValidatedServerEntityBatch = entries => { state.ads[0] = entries[0].entity.data; return [state.ads[0]]; };
    await run('saveTopUps()');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].version, 100, 'the save used the live version with the list built at open, erasing T2 with no conflict');
    assert.equal(state.modalData, live, 'the open modal was not re-pointed at the reloaded ad');
    assert.deepEqual(Array.from(run('tempTopUps'), t => t.note), ['T1', 'T2'], 'the working list still misses the colleague\'s top-up');
    assert.ok(notes.some(n => n.type === 'warning' && /loaded the latest version/.test(n.message)), JSON.stringify(notes));
  });
  // ---- Bug hunt r34 (ad-form-network): Edit Ad conflicts, failed ad saves, the New Ad id, the subscribe sheet ----
  const r34Photo = `data:image/jpeg;base64,${'A'.repeat(64)}`;
  const r34AdV1 = () => ({
    id: 'ad_1', recordType: 'ad', customerId: 'cust_1', pageId: 'page_1', amountUSD: 50, amountLocal: 250,
    exchangeRate: 5, paymentStatus: 'paid', collectionMethod: '', status: 'Active', deliveryStatus: 'Office',
    deliveryPersonId: '', receiptAllocations: [{ receiptId: 'rcpt_1', amountUSD: 50 }], receiptIds: ['rcpt_1'],
    fundingReceiptId: 'rcpt_1', receiptId: 'rcpt_1', dueAllocations: [], mergedPaidAllocations: [],
    adLinks: ['https://fb.example/old'], adLink: 'https://fb.example/old', adPhotos: [r34Photo], topUps: [],
    startDate: '2026-09-20T00:00:00.000Z', endDate: '2026-09-27T00:00:00.000Z', days: 7,
    editHistory: [], createdBy: 'user_a', creatorId: 'user_a', _lastModified: 1790000000000
  });
  // A colleague's top-up (+$20, +3 days), as live sync delivers it: the photos stay on the server.
  const r34TopUp = () => {
    const { adPhotos, ...rest } = r34AdV1();
    return { ...rest, _mediaOmitted: true, _photoCount: 1, amountUSD: 70, amountLocal: 350, initialAmountUSD: 50,
      receiptAllocations: [{ receiptId: 'rcpt_1', amountUSD: 70 }], topUps: [{ date: '2026-09-22', amount: 20, extendDays: 3, note: 'B top-up' }],
      initialEndDate: '2026-09-27T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z', _lastModified: 1790000060000 };
  };
  const r34Full = ad => { const { _mediaOmitted, _photoCount, ...rest } = ad; return { ...rest, adPhotos: [r34Photo] }; };
  function r34AdForm(openAd) {
    const fixture = loadBrowserSource();
    const { sandbox, state } = fixture;
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.console = { ...sandbox.console, error() {} };
    let n = 0;
    sandbox.crypto.getRandomValues = arr => { for (let i = 0; i < arr.length; i += 1) arr[i] = (n++ * 37 + i) & 255; return arr; };
    Object.assign(state, {
      serverMode: true, currentUser: { id: 'user_a', role: 'Admin', name: 'Staff A', permissions: {} },
      customers: [{ id: 'cust_1', name: 'Customer One', _lastModified: 1000 }],
      pages: [{ id: 'page_1', name: 'Page One', customerIds: ['cust_1'], _lastModified: 1000 }],
      receipts: [{ id: 'rcpt_1', customerId: 'cust_1', status: 'Paid', isPaid: true, amountUSD: 100, amountLocal: 500, exchangeRate: 5,
        serialNumber: '1001', paymentMethod: 'Cash (LYD)', payments: [], transfers: [], _lastModified: 1000 }],
      ads: openAd ? [openAd] : [], activeModal: 'ad', modalData: openAd || null
    });
    state.users = [state.currentUser];
    if (openAd) sandbox.initAdFunding(openAd);
    else state.tempAdFunding = { allocations: [{ receiptId: 'rcpt_1', amountUSD: 40 }] };
    state.tempAdPhotos = openAd ? [...openAd.adPhotos] : [r34Photo];
    state.tempAdPhotosDirty = !openAd;
    const fields = { 'ad-payment-status': 'paid', 'ad-collection-method': '', 'ad-linked-receipt-id': '', 'ad-start-date': '2026-09-20',
      'ad-end-date': '2026-09-27', 'ad-days': '7', 'ad-page': 'page_1', 'ad-customer-id': 'cust_1' };
    const form = { id: 'modal-form', dataset: {} };
    const links = ['https://fb.example/new'];
    sandbox.document.getElementById = id => (id === 'modal-form' ? (state.activeModal ? form : null) : (id in fields ? { id, value: fields[id], dataset: {} } : null));
    sandbox.document.querySelectorAll = sel => (sel === '.ad-link-input' ? links.map(value => ({ value })) : []);
    const notes = [];
    const renders = [];
    const sent = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.renderModal = () => renders.push(state.modalData);
    sandbox.apiGetEntity = async () => { throw new TypeError('Load failed'); };
    const replies = [];
    sandbox.apiMutateAd = async payload => {
      sent.push(JSON.parse(JSON.stringify(payload)));
      const reply = replies.shift();
      if (reply) return reply(payload);
      const version = Date.now();
      const base = state.ads.find(ad => ad.id === payload.adId) || {};
      return { ad: { id: payload.adId, data: { ...base, ...payload.data, id: payload.adId, _lastModified: version }, lastModified: version }, updatedReceipts: [] };
    };
    return { ...fixture, fields, form, links, notes, renders, sent, replies };
  }
  await test('R4 concurrency-idempotency-1: Edit Ad never saves its old values over a colleague\'s top-up; a Meta or spend sync still saves', async () => {
    const t = r34AdForm(r34AdV1());
    const { sandbox, state } = t;
    const opened = state.modalData;
    const topUp = r34TopUp();
    assert.equal(sandbox.applyServerDelta('ads', [topUp]), true);
    const asked = [];
    sandbox.apiGetEntity = async (collection, id) => { asked.push(`${collection}/${id}`); return { id, data: r34Full(topUp), lastModified: topUp._lastModified }; };
    await sandbox.handleModalSubmit();
    assert.deepEqual(t.sent, [], 'before: the save sent the old $50 funding against the top-up\'s version, undoing it');
    assert.equal(state.activeModal, 'ad');
    assert.notEqual(state.modalData, opened);
    assert.equal(state.modalData, state.ads[0]);
    assert.equal(state.modalData._lastModified, topUp._lastModified);
    assert.deepEqual(Array.from(state.tempAdFunding.allocations, row => row.amountUSD), [70]);
    assert.deepEqual(state.modalData.adPhotos, [r34Photo], 'the newest copy came with its photos');
    assert.deepEqual(asked, ['ads/ad_1']);
    assert.equal(t.renders.length, 1, 'the form is drawn again from the newest copy');
    assert.ok(t.notes.some(note => note.type === 'warning' && /changed on another device/.test(note.message)), JSON.stringify(t.notes));
    // Photos the device cannot show: the form stays as typed (no save, no reload) until they can be loaded.
    const unloaded = r34AdForm(r34AdV1());
    unloaded.sandbox.applyServerDelta('ads', [topUp]);
    await unloaded.sandbox.handleModalSubmit();
    assert.deepEqual(unloaded.sent, []);
    assert.equal(unloaded.renders.length, 0);
    assert.equal(unloaded.state.activeModal, 'ad');
    assert.ok(unloaded.notes.some(note => /Refresh the data/.test(note.message)), JSON.stringify(unloaded.notes));
    // The reloaded form (end date and days now the top-up's) saves against the newest version.
    t.notes.length = 0;
    t.fields['ad-end-date'] = '2026-09-30';
    await sandbox.handleModalSubmit();
    assert.equal(t.sent.length, 1, JSON.stringify(t.notes));
    assert.equal(t.sent[0].expectedLastModified, topUp._lastModified);
    assert.deepEqual(t.sent[0].data.receiptAllocations, [{ receiptId: 'rcpt_1', amountUSD: 70 }]);
    assert.equal(state.activeModal, null);
    // Only a Meta or spend sync happened meanwhile (the photos stay on the server): the save goes out against it.
    const spend = r34AdForm(r34AdV1());
    const { adPhotos, ...thin } = r34AdV1();
    const synced = { ...thin, _mediaOmitted: true, _photoCount: 1, spentUSD: 12.5, metaSpendUSD: 12.5, metaEffectiveStatus: 'ACTIVE', _lastModified: 1790000030000 };
    spend.sandbox.applyServerDelta('ads', [synced]);
    await spend.sandbox.handleModalSubmit();
    assert.equal(spend.sent.length, 1, JSON.stringify(spend.notes));
    assert.equal(spend.sent[0].expectedLastModified, synced._lastModified);
    assert.deepEqual(spend.sent[0].data.adLinks, ['https://fb.example/new']);
    assert.ok(!('adPhotos' in spend.sent[0].data), 'unchanged photos are not re-sent');
  });
  await test('R4 concurrency-idempotency-2: a server version conflict reloads the open Edit Ad form from the newest copy instead of closing it', async () => {
    const t = r34AdForm(r34AdV1());
    const { sandbox, state } = t;
    const topUp = r34TopUp();
    t.replies.push(() => { throw Object.assign(new Error('Conflict: ad has changed'), { status: 409 }); });
    sandbox.apiGetEntity = async (collection, id) => ({ id, data: r34Full(topUp), lastModified: topUp._lastModified });
    await sandbox.handleModalSubmit();
    assert.equal(t.sent.length, 1);
    assert.equal(state.activeModal, 'ad', 'before: the conflict closed the form');
    assert.equal(state.modalData._lastModified, topUp._lastModified);
    assert.deepEqual(Array.from(state.tempAdFunding.allocations, row => row.amountUSD), [70]);
    assert.equal(t.renders.length, 1);
    assert.ok(t.notes.some(note => note.type === 'warning' && /loaded the latest version/.test(note.message)), JSON.stringify(t.notes));
  });
  for (const failure of ['timeout', 'HTTP 502']) {
    await test(`R4 concurrency-idempotency-2: a New Ad save that fails (${failure}) keeps the form; the next Save keeps the ad id and meets the first one`, async () => {
      const t = r34AdForm(null);
      const { sandbox, state } = t;
      const funding = state.tempAdFunding;
      const photos = state.tempAdPhotos;
      t.replies.push(() => { throw failure === 'timeout' ? new DOMException('The request timed out', 'AbortError') : Object.assign(new Error('The server is busy or restarting (HTTP 502). Try again in a moment.'), { status: 502 }); });
      t.replies.push(() => { throw Object.assign(new Error('Ad ID already exists'), { status: 409 }); });
      await sandbox.handleModalSubmit();
      assert.equal(t.sent.length, 1);
      assert.equal(state.activeModal, 'ad', 'before: the failed save closed the form and dropped what was typed');
      assert.equal(state.tempAdFunding, funding);
      assert.equal(state.tempAdPhotos, photos);
      assert.equal(t.form.dataset.draftAdId, t.sent[0].adId);
      // The first Save had gone through. The user fixes the link and saves again.
      t.links[0] = 'https://fb.example/fixed';
      const stored = { ...t.sent[0].data, id: t.sent[0].adId, _lastModified: 5 };
      const asked = [];
      sandbox.apiGetEntity = async (collection, id) => { asked.push(`${collection}/${id}`); return { id, data: stored, lastModified: 5 }; };
      await sandbox.handleModalSubmit();
      assert.equal(t.sent.length, 2, 'no third create');
      assert.equal(t.sent[1].adId, t.sent[0].adId, 'before: a new ad id, so the committed first Save became a second ad');
      assert.notEqual(t.sent[1].idempotencyKey, t.sent[0].idempotencyKey);
      assert.deepEqual(t.sent[1].data.adLinks, ['https://fb.example/fixed']);
      assert.deepEqual(asked, [`ads/${t.sent[0].adId}`]);
      assert.deepEqual(state.ads.map(ad => ad.id), [t.sent[0].adId], 'the stored ad is installed');
      assert.equal(state.activeModal, null);
      assert.ok(t.notes.some(note => note.title === 'Already saved' && /first Save went through/.test(note.message)), JSON.stringify(t.notes));
      // The next New Ad form gets a new id.
      state.activeModal = 'ad';
      state.tempAdFunding = { allocations: [{ receiptId: 'rcpt_1', amountUSD: 40 }] };
      t.form.dataset = {};
      await sandbox.handleModalSubmit();
      assert.equal(t.sent.length, 3);
      assert.notEqual(t.sent[2].adId, t.sent[0].adId);
    });
  }
  await test('R4 permission-matrix-4: the subscribe sheet sends a non-admin short of balance to the office, not to the admin-only Charge wallet', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    const drawn = () => { made.length = 0; sandbox.renderModal(); return made.map(el => String(el.innerHTML || '')).join('\n'); };
    state.serverMode = true;
    state.walletTransactions = [];
    state.subscriptionPlans = [{ id: 'plan_clothes', name: 'Clothes monthly', nameAr: 'الملابس شهرياً', serviceIds: ['clothes-system'], priceMinor: 5000, durationDays: 30 }];
    state.currentUser = { id: 'shop1', role: 'Employee', name: 'Shop', permissions: JSON.parse(JSON.stringify(run('PERMISSION_TEMPLATES.clothesSubscriber.permissions'))) };
    state.users = [state.currentUser];
    state.activeModal = 'subscription-lock';
    state.modalData = { serviceId: 'clothes-system', serviceName: 'Clothes System' };
    let html = drawn();
    assert.ok(html.includes("handleSubscribePlan('plan_clothes'") && html.includes('disabled'), html.slice(0, 300));
    assert.ok(!html.includes('hubOpenChargeWallet'), 'before: a Charge wallet button that leads to an admin-only page');
    assert.ok(!html.includes('charge the wallet first'));
    assert.ok(html.includes('Balance is short — ask the office to top up your wallet.'), 'the short-balance hint');
    assert.ok(html.includes('>Ask the office to top up your wallet.</p>'), 'the line under the plans');
    state.language = 'ar';
    html = drawn();
    assert.ok(html.includes('الرصيد غير كافٍ — اطلب من المكتب شحن محفظتك.') && html.includes('>اطلب من المكتب شحن محفظتك.</p>'));
    assert.ok(!html.includes('اشحن المحفظة'));
    // An admin keeps Charge wallet and its hint.
    state.language = 'en';
    state.currentUser = { id: 'adm', role: 'Admin', name: 'Admin', permissions: {} };
    state.users = [state.currentUser];
    html = drawn();
    assert.ok(html.includes('hubOpenChargeWallet') && html.includes('Charge wallet') && html.includes('charge the wallet first'));
    assert.ok(!html.includes('Ask the office'));
  });
  // F-iap-shell (owner decision, 2 October 2026): Apple allows only its own In-App Purchase for anything sold inside
  // an iPhone app, so the iPhone app sells nothing. Every buy, subscribe and top-up button is hidden there (balances,
  // plans in use and history stay) and one neutral line, naming no other way to pay, stands in its place. The website
  // and the Android app must keep every button. The lazy screens (Clothes, Ads Studio) are covered separately.
  {
    const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Albayan/1.0';
    const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
    const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Albayan/1.0';
    const NEUTRAL = { en: 'Purchases are not available in this app.', ar: 'الشراء غير متاح في هذا التطبيق.' };
    // A sandbox posing as the website (no bridge), the packaged iPhone app or the packaged Android app, through the
    // real platform detection (Capacitor bridge + user agent). Server mode, 75.00 LYD in the wallet, a priced catalog.
    const shell = (userAgent, bridge, { role = 'Admin', language = 'en', subscribed = false, serverMode = true } = {}) => {
      const fixture = loadBrowserSource();
      const { sandbox, state, run } = fixture;
      run('Security').escapeHtml = plainEscape;
      if (userAgent) sandbox.navigator.userAgent = userAgent;
      if (bridge) sandbox.window.Capacitor = bridge;
      run('Platform._cache = null');
      state.serverMode = serverMode;
      state.language = language;
      state.currentUser = { id: 'u1', role, name: 'Sara', permissions: {} };
      state.users = [state.currentUser];
      state.walletTransactions = [{ id: 'wtx_1', type: 'credit', fromUserId: 'system', toUserId: 'u1', amountMinor: 7500, currency: 'LYD', status: 'posted', createdAt: '2026-10-01T10:00:00.000Z', memo: 'Cash at the office' }];
      state.serviceSubscriptions = subscribed
        ? [{ id: 'sub_1', userId: 'u1', serviceId: 'clothes_system', status: 'active', expiresAt: new Date(Date.now() + 12 * 86400000 - 60000).toISOString() }]
        : [];
      state.subscriptionPlans = [
        { id: 'svc:clothes_system', name: 'Clothes monthly', nameAr: 'الملابس شهرياً', serviceIds: ['clothes_system'], priceMinor: 5000, durationDays: 30, currency: 'LYD' },
        { id: 'svc:smart_systems', name: 'Smart Systems monthly', nameAr: 'الأنظمة شهرياً', serviceIds: ['smart_systems'], priceMinor: 2500, durationDays: 30, currency: 'LYD' },
        { id: 'bundle1', name: 'Everything', nameAr: 'كل شيء', serviceIds: ['clothes_system', 'ad_maker'], priceMinor: 9000, durationDays: 30, currency: 'LYD', savingsPct: 20, badge: 'best_value' }
      ];
      const asked = { methods: 0, prices: [], ledger: 0 };
      sandbox.apiWalletPaymentMethods = async () => { asked.methods += 1; return { methods: [] }; };
      sandbox.refreshSubscriptionPlans = async force => { asked.prices.push(force); };
      sandbox.serverLiveSyncTick = async () => { asked.ledger += 1; };
      // What renderModal() draws (the fake document keeps no tree).
      const made = [];
      const makeElement = sandbox.document.createElement;
      sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
      const sheet = open => { made.length = 0; open(); return made.map(el => String(el.innerHTML || '')).join('\n'); };
      return { ...fixture, asked, sheet };
    };
    const PLATFORMS = {
      web: options => shell('', null, options),
      iphone: options => shell(IPHONE_UA, { getPlatform: () => 'ios' }, options),
      android: options => shell(ANDROID_UA, { getPlatform: () => 'android' }, options)
    };
    const has = (html, ...parts) => parts.filter(part => !html.includes(part));
    const lacks = (html, ...parts) => parts.filter(part => html.includes(part));

    await test('F-iap-shell: the iPhone app sells nothing: Services Hub, Smart Systems, Plans, Charge wallet and Wallet show no buy or top-up button and the neutral line; the website and the Android app keep every button', async () => {
      // The one switch. Safari on an iPhone is the website; the same Apple build with a desktop user agent is hidden too.
      assert.equal(PLATFORMS.web().sandbox.inAppPurchasingHidden(), false);
      assert.equal(shell(IPHONE_UA, null).sandbox.inAppPurchasingHidden(), false, 'the website in Safari on an iPhone');
      assert.equal(PLATFORMS.android().sandbox.inAppPurchasingHidden(), false);
      assert.equal(shell(DESKTOP_UA, {}).sandbox.inAppPurchasingHidden(), false, 'an unknown shell is not the iPhone app');
      assert.equal(PLATFORMS.iphone().sandbox.inAppPurchasingHidden(), true);
      assert.equal(shell(DESKTOP_UA, { getPlatform: () => 'ios' }).sandbox.inAppPurchasingHidden(), true, 'the Apple build on an iPad or a Mac');

      for (const language of ['en', 'ar']) {
        const neutral = NEUTRAL[language];
        // ---- the iPhone app ----
        let f = PLATFORMS.iphone({ language });
        let hub = String(f.sandbox.renderServicesHub());
        assert.deepEqual(has(hub, neutral, '75.00 LYD', "navigateTo('wallet')"), [], `${language} hub keeps the balance and shows the neutral line`);
        assert.deepEqual(lacks(hub, 'hubOpenChargeWallet', "navigateTo('plans')", 'Top up', 'Plans & bundles', 'الباقات والاشتراكات', 'Subscribe', 'اشترك', 'Renew'), [], `${language} hub`);
        assert.deepEqual(lacks(String(f.sandbox.hubWalletCard({ topUp: true, plansLink: true })), 'hubOpenChargeWallet', "navigateTo('plans')"), [], `${language} wallet card, both buttons asked for`);
        assert.deepEqual(lacks(String(f.sandbox.renderSmartSystems()), 'showSubscriptionModal(', '>Subscribe<', '>Renew<', '>اشترك<', '>جدّد<'), [], `${language} Smart Systems`);
        const charge = String(f.sandbox.renderChargeWalletView());
        assert.deepEqual(has(charge, neutral, "navigateTo('wallet')", "navigateTo('services-hub')"), [], `${language} Charge wallet is the neutral card with a way back`);
        assert.deepEqual(lacks(charge, 'chargeWalletCreateRequest', 'charge-wallet-amount', 'chargeWalletPickMethod', 'Create charge request', 'Charge wallet', 'اشحن المحفظة', 'إنشاء طلب شحن'), [], `${language} Charge wallet`);
        assert.equal(f.asked.methods, 0, 'the iPhone app never asks for the payment methods');
        const wallet = String(f.sandbox.renderWalletView());
        assert.deepEqual(has(wallet, neutral, '75.00 LYD', 'Cash at the office', 'walletTransferFromUi()'), [], `${language} Wallet keeps the balance, the history and transfers`);
        assert.deepEqual(lacks(wallet, 'hubOpenChargeWallet', "navigateTo('plans')", 'walletTopUpFromUi', 'Charge wallet', 'اشحن المحفظة', 'Plans & bundles', 'external funding rails', 'قنوات التمويل'), [], `${language} Wallet`);
        // A locked service reads "Not active": never a price to pay or "Subscribe".
        f = PLATFORMS.iphone({ language, role: 'Employee', subscribed: true });
        hub = String(f.sandbox.renderServicesHub());
        assert.deepEqual(has(hub, neutral, language === 'ar' ? 'غير مفعّلة' : 'Not active', language === 'ar' ? 'نشط · 12 يوم' : 'Active · 12 d'), [], `${language} hub pills`);
        assert.deepEqual(lacks(hub, '25 LYD', 'Subscribe', 'اشترك', "navigateTo('plans')", 'hubOpenChargeWallet'), [], `${language} hub pills`);
        // Plans: read-only rows (name, services, days left) and no price, offer badge or button.
        const plans = String(f.sandbox.renderPlansView());
        assert.deepEqual(has(plans, neutral, '75.00 LYD', language === 'ar' ? 'كل شيء' : 'Everything', language === 'ar' ? 'الملابس شهرياً' : 'Clothes monthly',
          language === 'ar' ? 'نشط · 12 يوم' : 'Active · 12 d', language === 'ar' ? 'غير مفعّلة' : 'Not active', "navigateTo('services-hub')"), [], `${language} Plans`);
        assert.deepEqual(lacks(plans, 'openPlanPaywall', 'hubOpenChargeWallet', 'Subscribe', 'اشترك', 'Renew', 'جدّد', '50 LYD', '90 LYD', '25 LYD', 'Best value', 'الأفضل قيمة', 'Save 20%', 'وفّر 20%', 'Top up', 'Loading prices'), [], `${language} Plans`);
        f.state.subscriptionPlans = [];  // the catalog has not arrived: nothing to wait for, no "Loading prices…"
        assert.deepEqual(lacks(String(f.sandbox.renderPlansView()), 'Loading prices', 'جاري تحميل الأسعار', 'plansEnsureFresh();', 'animate-spin'), [], `${language} Plans without a catalog`);
        f = PLATFORMS.iphone({ language, serverMode: false });  // local mode: no "subscribe from its card", no admin top-up form
        assert.deepEqual(lacks(String(f.sandbox.renderPlansView()) + String(f.sandbox.renderWalletView()) + String(f.sandbox.renderChargeWalletView()),
          'subscribe from its card', 'واشترك من بطاقتها', 'walletTopUpFromUi', 'wallet-topup-amount', 'Charge requests need', 'طلبات الشحن'), [], `${language} local mode`);

        // ---- the website and the Android app: every button is still there, and no neutral line ----
        for (const platform of ['web', 'android']) {
          f = PLATFORMS[platform]({ language });
          hub = String(f.sandbox.renderServicesHub());
          assert.deepEqual(has(hub, 'onclick="hubOpenChargeWallet()"', "onclick=\"navigateTo('plans')\"", language === 'ar' ? '>شحن<' : '>Top up<', language === 'ar' ? '>الباقات والاشتراكات<' : '>Plans & bundles<'), [], `${platform} ${language} hub`);
          assert.deepEqual(has(String(f.sandbox.hubWalletCard({ topUp: true, plansLink: true })), 'onclick="hubOpenChargeWallet()"', "onclick=\"navigateTo('plans')\"", language === 'ar' ? '>الباقات<' : '>Plans<'), [], `${platform} ${language} wallet card`);
          assert.deepEqual(has(String(f.sandbox.renderSmartSystems()), "onclick=\"showSubscriptionModal('smart_systems', 'smart_systems')\"", language === 'ar' ? '>اشترك<' : '>Subscribe<'), [], `${platform} ${language} Smart Systems`);
          const webCharge = String(f.sandbox.renderChargeWalletView());
          assert.deepEqual(has(webCharge, 'onclick="chargeWalletCreateRequest()"', 'id="charge-wallet-amount"', language === 'ar' ? 'اشحن المحفظة' : 'Charge wallet'), [], `${platform} ${language} Charge wallet`);
          assert.equal(f.asked.methods, 1, `${platform}: the payment methods are asked for`);
          const webWallet = String(f.sandbox.renderWalletView());
          assert.deepEqual(has(webWallet, 'onclick="hubOpenChargeWallet()"', "onclick=\"navigateTo('plans')\"", language === 'ar' ? 'اشحن المحفظة' : 'Charge wallet', language === 'ar' ? 'قنوات التمويل الخارجية' : 'external funding rails'), [], `${platform} ${language} Wallet`);
          f = PLATFORMS[platform]({ language, role: 'Employee', subscribed: true });
          const webHub = String(f.sandbox.renderServicesHub());
          assert.deepEqual(has(webHub, language === 'ar' ? '25 LYD / شهر' : '25 LYD / month', language === 'ar' ? 'اشترك' : 'Subscribe'), [], `${platform} ${language} hub pills`);
          const webPlans = String(f.sandbox.renderPlansView());
          assert.deepEqual(has(webPlans, "onclick=\"openPlanPaywall('bundle1')\"", "onclick=\"openPlanPaywall('svc:clothes_system')\"", '90 LYD', '50 LYD',
            language === 'ar' ? '>اشترك<' : '>Subscribe<', language === 'ar' ? '>جدّد<' : '>Renew<', language === 'ar' ? 'الأفضل قيمة' : 'Best value', language === 'ar' ? 'وفّر 20%' : 'Save 20%', 'onclick="hubOpenChargeWallet()"'), [], `${platform} ${language} Plans`);
          assert.deepEqual(lacks(hub + webCharge + webWallet + webHub + webPlans, NEUTRAL.en, NEUTRAL.ar, 'Not active', 'غير مفعّلة'), [], `${platform} ${language}: nothing of the iPhone wording`);
        }
      }
      // The App Review note tells Apple the same thing, and quotes the line the reviewer will see.
      const reviewGuide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'store', 'IOS_APP_STORE_RELEASE.md'), 'utf8').replace(/\n\s*>\s?/g, ' ').replace(/\s+/g, ' ');
      assert.ok(reviewGuide.includes('Nothing can be bought in the iPhone app.') && reviewGuide.includes(`the iPhone app shows "${NEUTRAL.en}"`), 'the App Review note does not say what the iPhone app shows');
    });

    await test('F-iap-shell: in the iPhone app the subscribe sheet only says the service is not active (no price, no Subscribe, no Charge wallet) and loads no prices; on the website and in the Android app it still sells', async () => {
      const SAYS = { en: 'This service is not active on your account.', ar: 'هذه الخدمة غير مفعّلة في حسابك.' };
      const BUYING = ['handleSubscribePlan', 'handleSubscribe(', 'hubOpenChargeWallet', 'adsStudioOpenChargeForm', 'refreshSubscriptionPlans', 'Subscribe', 'اشترك', 'Charge wallet', 'اشحن المحفظة',
        'Ask the office', 'اطلب من المكتب', 'Requires subscription', 'يتطلب اشتراكاً', 'Wallet balance', 'رصيد المحفظة', '50.00', '90.00', '75.00', 'LYD', 'Other plans', 'Best value', 'href='];
      for (const language of ['en', 'ar']) {
        for (const role of ['Employee', 'Admin']) {
          for (const serverMode of [true, false]) {
            const f = PLATFORMS.iphone({ language, role, serverMode });
            const name = language === 'ar' ? 'نظام الملابس' : 'Clothes System';
            // Every way in: a locked service, a plan row left over from an older screen, and a redraw of an open sheet.
            const ways = [
              () => f.sandbox.showSubscriptionModal('clothes_system', 'clothes_system'),
              () => f.sandbox.openPlanPaywall('bundle1'),
              () => { f.state.activeModal = 'subscription-lock'; f.state.modalData = { serviceId: 'clothes_system', serviceName: name, subscribeToId: 'clothes_system', planId: 'bundle1' }; f.sandbox.renderModal(); }
            ];
            for (const [index, open] of ways.entries()) {
              const html = f.sheet(open);
              const label = `iPhone ${language} ${role} ${serverMode ? 'server' : 'local'} way ${index + 1}`;
              assert.equal(f.state.activeModal, 'subscription-lock', label);
              assert.deepEqual(has(html, `<h2>${name}</h2>`, SAYS[language], NEUTRAL[language], 'onclick="closeModal()"'), [], label);
              assert.deepEqual(lacks(html, ...BUYING), [], label);
            }
            await settle();
            assert.deepEqual(f.asked.prices, [], 'no price catalog is fetched for a sheet that shows no price');
            assert.equal(f.asked.ledger, 0);
          }
        }
      }
      // The website and the Android app: the paywall as before (the price, Subscribe, and where to get credit).
      for (const platform of ['web', 'android']) {
        let f = PLATFORMS[platform]({ role: 'Employee' });
        let html = f.sheet(() => f.sandbox.showSubscriptionModal('clothes_system', 'clothes_system'));
        assert.deepEqual(has(html, "handleSubscribePlan('svc:clothes_system', 'clothes_system', 5000)", 'Subscribe — 50.00 LYD', "handleSubscribePlan('bundle1', 'clothes_system', 9000)",
          'Requires subscription', 'Wallet balance', '75.00 LYD', '>Ask the office to top up your wallet.</p>'), [], `${platform} member sheet`);
        assert.deepEqual(lacks(html, NEUTRAL.en, SAYS.en), [], `${platform} member sheet`);
        await settle();
        assert.deepEqual(f.asked.prices, [true], `${platform}: the sheet forces a fresh price catalog`);
        assert.equal(f.asked.ledger, 1);
        html = f.sheet(() => f.sandbox.openPlanPaywall('bundle1'));
        assert.deepEqual(has(html, "handleSubscribePlan('bundle1', 'clothes_system', 9000)", 'Subscribe — 90.00 LYD'), [], `${platform} plan paywall`);
        f = PLATFORMS[platform]({ role: 'Admin' });
        html = f.sheet(() => f.sandbox.showSubscriptionModal('clothes_system', 'clothes_system'));
        assert.deepEqual(has(html, 'hubOpenChargeWallet()', '>Charge wallet</button>', 'Subscribe — 50.00 LYD'), [], `${platform} admin sheet`);
        f = PLATFORMS[platform]({ role: 'Employee', serverMode: false });
        html = f.sheet(() => f.sandbox.showSubscriptionModal('clothes_system', 'clothes_system'));
        assert.deepEqual(has(html, "handleSubscribe('clothes_system', 'clothes_system')", 'You are not subscribed to'), [], `${platform} local sheet`);
      }
    });
  }
  await test('r6 A n=15: a live Not-Paid ad the company partly covered can be switched to Paid with the customer\'s share', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.pages = [{ id: 'p1', name: 'Page', customerId: 'c1' }];
    state.receipts = [
      { id: 'R', customerId: 'c1', amountUSD: 100, amountLocal: 500, exchangeRate: 5, status: 'Not Paid', isPaid: false, deliveryStatus: 'Office', payments: [], transfers: [], companyCoveredUSD: 40, customerOutstandingUSD: 60 },
      { id: 'P', customerId: 'c1', amountUSD: 60, amountLocal: 300, exchangeRate: 5, status: 'Paid', isPaid: true, deliveryStatus: 'Office', payments: [], transfers: [] }
    ];
    const ad = { id: 'adC', customerId: 'c1', pageId: 'p1', status: 'Active', paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop',
      amountUSD: 100, amountLocal: 500, exchangeRate: 5, receiptId: 'R', receiptAllocations: [], dueAllocations: [{ receiptId: 'R', amountUSD: 60 }],
      companyFundingAllocations: [{ receiptId: 'R', amountUSD: 40 }], startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-10T00:00:00.000Z', _lastModified: 7 };
    state.ads = [ad];
    state.modalData = ad;
    assert.equal(sandbox.getOriginalUnpaidAdBudgetUSD(), 60, 'the settle target still demands the company-covered $40 from the customer');
    state.modalData = { ...ad, companyFundingAllocations: [], companyDirectCoverageUSD: 40, collectionMethod: 'driver' };
    assert.equal(sandbox.getOriginalUnpaidAdBudgetUSD(), 60, 'receipt-less direct coverage is ignored');
    state.modalData = { ...ad, status: 'Stopped' };
    assert.equal(sandbox.getOriginalUnpaidAdBudgetUSD(), 60, 'a terminal ad keeps its committed-total target');

    // Submit the ad form: Paid, $60 from the paid receipt.
    state.modalData = ad;
    state.activeModal = 'ad';
    state.tempAdFunding = { allocations: [{ receiptId: 'P', amountUSD: '60.00' }] };
    state.tempMergeFunding = { enabled: false, allocations: [] };
    state.tempAdPhotos = [];
    state.tempAdPhotosDirty = false;
    const values = { 'ad-payment-status': 'paid', 'ad-collection-method': '', 'ad-start-date': '2026-09-01', 'ad-end-date': '2026-09-10',
      'ad-days': '9', 'ad-page': 'p1', 'ad-customer-id': 'c1' };
    sandbox.document.getElementById = id => (id in values ? { value: values[id], dataset: {}, classList: { add() {}, remove() {}, toggle() {} } } : null);
    const notes = [];
    const saved = [];
    sandbox.showNotification = (title, message, type) => notes.push({ message, type });
    sandbox.isServerModeEnabled = () => true;
    sandbox.closeModal = () => {};
    sandbox.saveAdThroughAtomicServer = async (action, id, version, data) => { saved.push({ action, version, data }); return data; };
    await sandbox.handleModalSubmit();
    assert.ok(!notes.some(n => /must equal/.test(n.message)), JSON.stringify(notes));
    assert.equal(saved.length, 1, JSON.stringify(notes));
    assert.equal(saved[0].data.paymentStatus, 'paid');
    assert.deepEqual(JSON.parse(JSON.stringify(saved[0].data.receiptAllocations)), [{ receiptId: 'P', amountUSD: 60 }]);
    assert.ok(!(saved[0].data.editHistory || []).some(row => (row.changes || []).some(c => c.field === 'Amount (USD)')), 'history shows a false $100 -> $60 drop');

    // Fully covered: settles with no receipt at all (the server allows empty paid funding then).
    const full = { ...ad, dueAllocations: [], companyFundingAllocations: [{ receiptId: 'R', amountUSD: 100 }] };
    state.ads = [full];
    state.modalData = full;
    state.tempAdFunding = { allocations: [] };
    notes.length = 0;
    await sandbox.handleModalSubmit();
    assert.equal(saved.length, 2, JSON.stringify(notes));
    assert.deepEqual(Array.from(saved[1].data.receiptAllocations), []);
  });
  await test('r6 A n=16: the Stop dialog stops against the version it showed and a conflict rebuilds it from the latest ad', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    const htmls = [];
    const modal = { remove() {}, get dataset() { return { v: (htmls[htmls.length - 1].match(/data-v="([^"]*)"/) || [])[1] }; } };
    const nodes = { 'stop-ad-spent': { value: '40.00' }, 'stop-ad-customer-informed': { checked: false, disabled: false }, 'stop-ad-submit': { disabled: false } };
    sandbox.document.body.insertAdjacentHTML = (where, html) => { htmls.push(html); };
    sandbox.document.getElementById = id => (id === 'stop-ad-modal' ? (htmls.length ? modal : null) : (nodes[id] || null));
    const active = { id: 'adS', customerId: 'c1', status: 'Active', paymentStatus: 'paid', isPaid: true, amountUSD: 100, spentUSD: 0, _lastModified: 5 };
    const stoppedByColleague = { ...active, status: 'Stopped', spentUSD: 47, remainingCustomerInformed: true, _lastModified: 6 };
    state.ads = [active];
    sandbox.stopAd('adS');
    assert.ok(/data-v="5"/.test(htmls[0]), 'the dialog does not record the version it was built from');
    state.ads = [stoppedByColleague];  // live-sync, while the dialog still says "Stop Ad / $40"
    const bodies = [];
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ message, type });
    sandbox.isServerModeEnabled = () => true;
    sandbox.apiStopAd = async (id, body) => { bodies.push(body); throw conflict409(); };
    sandbox.apiGetEntity = async () => ({ id: 'adS', data: stoppedByColleague, lastModified: 6 });
    sandbox.applyValidatedServerEntityBatch = entries => { state.ads[0] = entries[0].entity.data; return [state.ads[0]]; };
    await sandbox.confirmStopAd('adS');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].expectedLastModified, 5, 'the stale dialog re-stopped against the colleague\'s newer version');
    assert.equal(htmls.length, 2, 'the conflict did not rebuild the dialog');
    assert.ok(/data-v="6"/.test(htmls[1]) && htmls[1].includes('Edit Stop Details') && htmls[1].includes('$47.00'), 'the rebuilt dialog does not show the saved stop');
    assert.ok(notes.some(n => n.type === 'warning' && /loaded the latest version - check the amount/.test(n.message)), 'the rebuilt dialog still says "Refresh the data": ' + JSON.stringify(notes));
  });
  await test('r6 A n=16 follow-up: a Stop conflict on an ad a colleague canceled or refunded closes the dialog instead of rebuilding it', async () => {
    for (const change of [{ status: 'Canceled' }, { refundType: 'Full' }, { _deleted: true }]) {
      const { sandbox, state, run } = loadBrowserSource();
      run(realEscape);
      const htmls = [];
      let open = false;
      const modal = { remove() { open = false; }, get dataset() { return { v: (htmls[htmls.length - 1].match(/data-v="([^"]*)"/) || [])[1] }; } };
      const nodes = { 'stop-ad-spent': { value: '40.00' }, 'stop-ad-customer-informed': { checked: false, disabled: false }, 'stop-ad-submit': { disabled: false } };
      sandbox.document.body.insertAdjacentHTML = (where, html) => { htmls.push(html); open = true; };
      sandbox.document.getElementById = id => (id === 'stop-ad-modal' ? (open ? modal : null) : (nodes[id] || null));
      const active = { id: 'adS', customerId: 'c1', status: 'Active', paymentStatus: 'paid', isPaid: true, amountUSD: 100, spentUSD: 0, _lastModified: 5 };
      const changed = { ...active, ...change, _lastModified: 6 };
      state.ads = [active];
      sandbox.stopAd('adS');
      assert.equal(htmls.length, 1);
      const notes = [];
      sandbox.showNotification = (title, message, type) => notes.push({ message, type });
      sandbox.isServerModeEnabled = () => true;
      sandbox.apiStopAd = async () => { throw conflict409(); };
      sandbox.apiGetEntity = async () => ({ id: 'adS', data: changed, lastModified: 6 });
      sandbox.applyValidatedServerEntityBatch = entries => { state.ads[0] = entries[0].entity.data; return [state.ads[0]]; };
      await sandbox.confirmStopAd('adS');
      assert.equal(htmls.length, 1, `a new Stop dialog was built for an ad that is now ${JSON.stringify(change)}`);
      assert.equal(open, false, `the stale Stop dialog stayed open for an ad that is now ${JSON.stringify(change)}`);
      assert.ok(notes.some(n => n.type === 'warning' && /can no longer be stopped/.test(n.message)), JSON.stringify(notes));
    }
  });
  await test('r6 A n=17: unfinished Meta-import drafts stay off the reconciliation list; the server refusal reads in Arabic', async () => {
    const { sandbox, state } = loadBrowserSource();
    const draft = { id: 'ad_draft', status: 'Active', customerId: '', amountUSD: 0, paymentStatus: 'pending_setup', metaImportState: 'needs_completion',
      endDate: '2026-09-01T00:00:00.000Z', metaCurrency: 'USD', metaSpendMinor: 1200 };
    assert.equal(sandbox.isAdReadyForReconciliation(draft, '2026-09-20T12:00:00'), false, 'a draft with no customer or budget is offered for final settlement');
    assert.equal(sandbox.isAdReadyForReconciliation({ ...draft, paymentStatus: 'paid', metaImportState: 'complete', customerId: 'c1', amountUSD: 20 }, '2026-09-20T12:00:00'), true);
    state.language = 'ar';
    for (const message of ['Complete this imported Meta ad (customer and payment) before stopping it',
      "Paid receipt funding must exactly settle the customer's share of the unpaid ad amount"]) {
      assert.ok(!/[A-Za-z]{3,}/.test(sandbox._serverRefusalText(message).replace('Meta', '')), sandbox._serverRefusalText(message));
    }
  });
  await test('R6 ads-lifecycle-2: a Meta ad that runs continuously stays off Reconciliation until it is stopped or Meta pauses it', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.serverMode = true;
    sandbox.isServerModeEnabled = () => true;
    state.pages = [{ id: 'p1', name: 'Page One', customerIds: ['c1'] }];
    // Imported with no end time: the server stored end = start, and Facebook keeps delivering.
    const meta = { id: 'ad_meta', recordType: 'ad', status: 'Active', customerId: 'c1', pageId: 'p1', paymentStatus: 'paid', isPaid: true,
      amountUSD: 50, amountLocal: 350, exchangeRate: 7, receiptAllocations: [{ receiptId: 'r1', amountUSD: 50 }],
      startDate: '2026-09-20T00:00:00.000Z', endDate: '2026-09-20T00:00:00.000Z', metaAdId: '120200000000000001', metaImportState: 'complete',
      metaEffectiveStatus: 'ACTIVE', metaEndTime: '', metaCurrency: 'USD', metaSpendMinor: 1800, metaSyncedAt: new Date().toISOString(),
      creatorId: 'admin', _lastModified: 5 };
    const on = '2026-09-22T12:00:00';
    assert.equal(sandbox.isAdReadyForReconciliation(meta, on), false, 'before: listed as "Ended" while Facebook keeps spending');
    for (const status of ['IN_PROCESS', 'PENDING_REVIEW', 'PREAPPROVED', 'WITH_ISSUES', 'active']) {
      assert.equal(sandbox.isAdReadyForReconciliation({ ...meta, metaEffectiveStatus: status }, on), false, status);
    }
    assert.equal(sandbox.isAdReadyForReconciliation({ ...meta, status: 'Stopped', stoppedAt: '2026-09-21T10:00:00.000Z', spentUSD: 18 }, on), true, 'a stopped ad is ready the next day');
    for (const status of ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED']) {
      assert.equal(sandbox.isAdReadyForReconciliation({ ...meta, metaEffectiveStatus: status }, on), true, `${status}: Meta stopped delivering`);
    }
    // Meta keeps an ad ACTIVE after its real end: an ad with an end time keeps its stored end date.
    assert.equal(sandbox.isAdReadyForReconciliation({ ...meta, metaEndTime: '2026-09-20T21:00:00Z' }, on), true);
    const manual = { ...meta, metaAdId: '', metaEffectiveStatus: '', metaSpendMinor: undefined, metaSyncedAt: '' };
    assert.equal(sandbox.isAdReadyForReconciliation(manual, on), true, 'a manual ad still appears the day after its end');
    assert.equal(sandbox.isAdReadyForReconciliation(manual, '2026-09-20T12:00:00'), false);
    // The screen itself: no "Ended" card offering $32.00 back while the ad runs; it appears once Meta pauses it.
    const day = new Date();
    day.setDate(day.getDate() - 2);
    const started = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}T00:00:00.000Z`;
    state.ads = [{ ...meta, startDate: started, endDate: started }];
    let html = String(sandbox.renderReconciliationView());
    assert.ok(!html.includes('data-reconciliation-card="ad_meta"') && !html.includes('$32.00'), 'before: badge "Ended", "Remaining returned to customer $32.00"');
    state.ads = [{ ...meta, startDate: started, endDate: started, metaEffectiveStatus: 'PAUSED' }];
    html = String(sandbox.renderReconciliationView());
    assert.ok(html.includes('data-reconciliation-card="ad_meta"') && html.includes('id="reconciliation-remaining-ad_meta">$32.00<'), 'a paused ad is offered for settlement');
  });
  await test('R6 ads-lifecycle-3: Stop Ad shows only on ads that can still be stopped, to staff allowed to stop them; a finished ad says why', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    Object.assign(state, { currentView: 'ads', adSearch: '', adFilters: { status: 'all', payment: 'all', page: 'all' }, adReceiptFilter: '' });
    state.pages = [{ id: 'p1', name: 'Page One', customerIds: ['c1'] }];
    const base = { recordType: 'ad', customerId: 'c1', pageId: 'p1', amountUSD: 50, amountLocal: 350, exchangeRate: 7, paymentStatus: 'paid', isPaid: true,
      receiptAllocations: [], startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-05T00:00:00.000Z', creatorId: 'admin', _lastModified: 100 };
    state.ads = [
      { ...base, id: 'ad_active', status: 'Active' },
      { ...base, id: 'ad_refunded', status: 'Canceled', refundType: 'Full', refundAmount: 50, refundStatus: 'Pending', preRefundStatus: 'Active', spentUSD: 0 },
      { ...base, id: 'ad_lost', status: 'Lost' },
      { ...base, id: 'ad_stopped', status: 'Stopped', spentUSD: 20, stoppedAt: '2026-09-03T10:00:00.000Z' }
    ];
    const withStop = () => {
      const html = String(sandbox.renderAdsView());
      return state.ads.map(ad => ad.id).filter(id => html.includes(`onclick="stopAd('${id}')"`));
    };
    assert.deepEqual(withStop(), ['ad_active', 'ad_stopped'], 'before: Stop Ad on the refunded and Lost ads too, which the server always refuses');
    const html = String(sandbox.renderAdsView());
    assert.ok(html.includes("manageRefund('ad_refunded')") && html.includes("manageRefund('ad_lost')") && html.includes('Edit Stop Details'), 'Refund and Edit Stop Details stay');
    const asEmployee = permissions => {
      state.currentUser = { id: 'emp1', name: 'Staff', role: 'Employee', permissions: JSON.parse(JSON.stringify(permissions)) };
      state.users = [state.currentUser];
    };
    asEmployee({ ads: ['view', 'edit', 'changeStatus'] });
    assert.deepEqual(withStop(), [], 'an Employee without Stop Ads is offered a button that only refuses');
    asEmployee(run('PERMISSION_TEMPLATES.manager.permissions'));
    assert.deepEqual(withStop(), ['ad_active', 'ad_stopped'], 'the Manager template stops ads (R6 ads-lifecycle-4)');
    // Reached another way (an old tab, a dialog left open): say why and open nothing.
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    state.users = [state.currentUser];
    const opened = [];
    const notes = [];
    sandbox.document.body.insertAdjacentHTML = (where, markup) => opened.push(markup);
    sandbox.showNotification = (title, message, type) => notes.push({ message, type });
    sandbox.stopAd('ad_refunded');
    sandbox.stopAd('ad_lost');
    assert.equal(opened.length, 0, 'before: the Stop dialog opened and the save then failed with 409');
    assert.deepEqual(notes.map(n => n.message), Array(2).fill('This ad is already finished or refunded, so this change is no longer allowed. Use Refund to adjust its money.'));
    state.language = 'ar';
    sandbox.stopAd('ad_refunded');
    assert.ok(notes.length === 3 && !/[A-Za-z]{3,}/.test(notes[2].message), notes[2]?.message);
    state.language = 'en';
    state.ads.push({ ...base, id: 'ad_draft', status: 'Active', customerId: '', amountUSD: 0, paymentStatus: 'pending_setup', metaImportState: 'needs_completion', metaAdId: '120200000000000002' });
    sandbox.stopAd('ad_draft');
    assert.equal(notes[3]?.message, 'Complete this imported Meta ad (customer and payment) before stopping it', 'a draft is not "finished or refunded"');
    assert.equal(opened.length, 0);
    sandbox.stopAd('ad_stopped');
    assert.ok(opened.length === 1 && opened[0].includes('Edit Stop Details'), 'a Stopped ad keeps its Edit Stop Details dialog');
  });
  await test('r6 A n=23: the analytics breakdowns count the same receipts and amounts as the KPI cards that open them', async () => {
    const { sandbox, run } = loadBrowserSource();
    run(fs.readFileSync(path.join(__dirname, '..', 'src', '12a-analytics-profit.js'), 'utf8'));
    const now = new Date('2026-09-20T12:00:00').getTime();
    const receipts = [
      { id: 'u', date: '2026-09-10T10:00:00', status: 'Not Paid', isPaid: false, deliveredAt: '2026-09-11T10:00:00', paymentResult: 'UNDERPAID', amountUSD: 60, debtAmountUSD: 100, collected: false },
      { id: 'cb', date: '2026-09-12T10:00:00', status: 'Paid', isPaid: true, receiptType: 'CARRIED_BALANCE', amountUSD: 40, collected: true }
    ];
    const options = { receipts, ads: [], profitSnapshot: { rowsByAdId: new Map() }, now };
    const month = result => result.periods[result.periods.length - 1];
    const volume = month(sandbox.buildAnalyticsBreakdown('receipts-volume', 'month', options));
    assert.equal(volume.count, 1, 'a carried balance is not a sale');
    near(volume.primaryUSD, 100);
    const collection = month(sandbox.buildAnalyticsBreakdown('collection-status', 'month', options));
    assert.equal(collection.count, 2, 'the Collection Status card counts carried balances, its breakdown must too');
    near(collection.primaryUSD, 40);
    near(collection.secondaryUSD, 60);
  });

  await test('r5 PRN n=19: Remind all skips overdue customers with no usable phone, reaches the next one and says how many were skipped', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    const rows = [
      { customer: { id: 'short', name: 'Short number', phone: '0912345' }, overdue: true, dueLyd: 100 },
      { customer: { id: 'none', name: 'No phone' }, overdue: true, dueLyd: 50 },
      { customer: { id: 'b', name: 'Reachable', phone: '0912345678' }, overdue: true, dueLyd: 200 },
      { customer: { id: 'fresh', name: 'Not overdue', phone: '0923456789' }, overdue: false, dueLyd: 20 }
    ];
    sandbox.shellDebtorRows = () => rows;
    const notes = [];
    sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
    const opens = [];
    sandbox.window.open = url => { opens.push(url); return { opener: {} }; };
    sandbox.remindAllOverdue();
    // Before: the walk stopped on 'short' ("Phone number not readable") on every tap and never opened WhatsApp.
    assert.equal(opens.length, 1);
    assert.ok(opens[0].startsWith('https://wa.me/218912345678?text='), opens[0]);
    assert.ok(notes.some(n => n.type === 'warning' && n.message.includes('Skipped 2 ')), JSON.stringify(notes));
    assert.ok(!notes.some(n => /not readable|No phone number/.test(n.title)), 'no per-customer dead end');
    // Next tap: the reachable one is stamped, the unreachable two are never stamped and still counted.
    notes.length = 0;
    sandbox.remindAllOverdue();
    assert.equal(opens.length, 1, 'nobody else to open');
    assert.ok(notes.length === 1 && notes[0].type === 'warning' && notes[0].message.includes('Skipped 2 '), JSON.stringify(notes));
    const log = JSON.parse(sandbox.localStorage.getItem('albayan_debt_reminders_v1:admin') || '{}');
    assert.deepEqual(Object.keys(log), ['b']);
    // Everyone reachable reminded and nobody skipped: the old "All reminded".
    rows.splice(0, 2);
    notes.length = 0;
    sandbox.remindAllOverdue();
    assert.ok(notes.length === 1 && notes[0].type === 'success' && notes[0].title === 'All reminded', JSON.stringify(notes));
  });

  await test('r5 PRN n=20 + R3 ios-app-review-5: the packaged app draws no Print or Export button that can only fail; a direct call says it is not available in the app (never "use the web version") and never claims a download', async () => {
    // The buttons: drawn on the web, gone in the packaged app.
    const drawn = app => {
      const { sandbox, state, run } = loadBrowserSource();
      run('Security').escapeHtml = plainEscape;
      run('Platform.detect()').isCapacitor = app;
      state.serverMode = true;
      sandbox.refreshServerAuditLogs = () => {};
      state.receipts = [{ id: 'r1', customerId: 'c1', recordType: 'receipt', amountUSD: 100, amountLocal: 500, exchangeRate: 5, status: 'Paid', isPaid: true, createdAt: new Date().toISOString(), createdBy: 'admin' }];
      const html = {};
      for (const view of ['Receipts', 'Ads', 'Deliveries', 'Audit', 'Settings']) html[view] = String(run(`render${view}View()`));
      const clothes = clothesFixture();
      clothes.run('Security').escapeHtml = plainEscape;
      clothes.run('Platform.detect()').isCapacitor = app;
      Object.assign(clothes.state, { clothesProducts: [{ id: 'p1', name: 'Shirt', variants: [], createdBy: 'admin' }],
        clothesShipments: [{ id: 's1', supplier: 'X', status: 'ordered', createdBy: 'admin' }],
        clothesOrders: [{ id: 'o1', lines: [], status: 'New', paymentStatus: 'unpaid', createdBy: 'admin', createdAt: new Date().toISOString() }] });
      for (const tab of ['Products', 'Shipments', 'Orders']) html[`clothes${tab}`] = String(clothes.run(`renderClothes${tab}Tab()`));
      return html;
    };
    const buttons = [['Receipts', 'printReceiptCard(this)'], ['Ads', 'printCurrentPage()'], ['Deliveries', 'exportDeliveryReport()'],
      ['Audit', "exportAuditLogs('csv')"], ['Audit', "exportAuditLogs('json')"], ['Audit', 'backupAuditLogs()'], ['Settings', 'downloadFullServerBackup(this)'],
      ['clothesProducts', 'exportClothesProductsCSV()'], ['clothesShipments', 'exportClothesShipmentsCSV()'], ['clothesOrders', 'exportClothesOrdersCSV()'], ['clothesOrders', "printClothesOrderSlip('o1')"]];
    const web = drawn(false);
    const packaged = drawn(true);
    for (const [view, call] of buttons) {
      assert.ok(web[view].includes(call), `the web keeps ${call}`);
      assert.ok(!packaged[view].includes(call), `before: the app drew ${call}, which can only fail there`);
    }
    assert.ok(packaged.Settings.includes('exportData()'), 'Settings Export stays: in the app it offers the clipboard');
    // A direct call (an old link, the command palette) still never fakes a download or a print.
    const { sandbox, state, run } = loadBrowserSource();
    run('Platform.detect()').isCapacitor = true;
    const notes = [];
    sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
    const clicks = [];
    const prints = [];
    sandbox.document.createElement = tag => ({ tag, style: {}, dataset: {}, setAttribute() {}, remove() {}, click() { clicks.push(tag); } });
    sandbox.document.body.classList = fakeClassList();
    sandbox.window.print = () => { prints.push('print'); };
    assert.equal(run("downloadFile('a,b', 'report.csv', 'text/csv')"), false);
    const card = { isConnected: true, classList: fakeClassList(), getAttribute: () => 'r1' };
    run('printReceiptCard')({ closest: () => card });
    run('printCurrentPage()');
    const asked = [];
    sandbox.confirm = text => { asked.push(text); return false; };
    sandbox.createAutoBackup = () => {};
    sandbox.addAuditLog = () => {};
    run('exportData()');
    const clothes = clothesFixture();
    clothes.run('Platform.detect()').isCapacitor = true;
    clothes.sandbox.document.createElement = tag => ({ tag, style: {}, dataset: {}, setAttribute() {}, remove() {}, click() { clicks.push(tag); } });
    clothes.sandbox.window.print = () => { prints.push('slip'); };
    clothes.sandbox.getVisibleClothesOrders = () => [{ id: 'o1', lines: [], status: 'New' }];
    clothes.run("printClothesOrderSlip('o1')");
    clothes.run("_clothesDownloadCsv([['Order'], ['1']], 'clothes-orders')");
    assert.equal(clicks.length, 0, 'no <a download> was clicked');
    assert.equal(prints.length, 0, 'window.print() never ran');
    assert.ok(!sandbox.document.body.classList.contains('print-single') && !card.classList.contains('print-target'));
    for (const list of [notes, clothes.notes]) assert.ok(!list.some(n => n.type === 'success'), JSON.stringify(list));
    // download, receipt print, page print, and the backup after its clipboard offer was declined
    assert.deepEqual(notes.map(n => `${n.type}: ${n.message}`), ["warning: Downloads aren't available in the app.", "warning: Printing isn't available in the app.",
      "warning: Printing isn't available in the app.", "warning: Downloads aren't available in the app."]);
    assert.deepEqual(clothes.notes.map(n => n.message), ["Printing isn't available in the app.", "Downloads aren't available in the app."]);
    assert.ok(asked.length === 1 && asked[0] === "Downloads aren't available in the app.\n\nCopy the backup to the clipboard instead?", asked[0]);
    state.language = 'ar';
    run("notifyInAppBrowserLimitation('print')");
    assert.equal(notes.at(-1).message, 'الطباعة غير متاحة داخل التطبيق.');
    assert.equal(run("inAppLimitationText('download')"), 'التنزيل غير متاح داخل التطبيق.');
    for (const text of [...notes.map(n => n.message), ...clothes.notes.map(n => n.message), ...asked]) {
      assert.ok(!/web version|in a browser|نسخة الويب/.test(text), `the app never sends people to the web: ${text}`);
    }
    // A Facebook in-app browser keeps its own way out.
    const web2 = loadBrowserSource();
    Object.assign(web2.run('Platform.detect()'), { isInAppBrowser: true });
    const webNotes = [];
    web2.sandbox.showNotification = (title, message, type) => { webNotes.push({ title, message, type }); };
    assert.equal(web2.run("downloadFile('a', 'x.csv', 'text/csv')"), false);
    assert.ok(webNotes[0].message.includes('Facebook/Instagram in-app browser — open this page in Safari or Chrome'), webNotes[0].message);
  });

  await test('r5 PRN n=21: the printed receipt hides company coverage, the shop-paid fee, the fee flag and staff names', async () => {
    const { state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    state.customers = [{ id: 'c1', name: 'Customer', phones: [{ number: '0912345678' }] }];
    state.users = [state.currentUser, { id: 'drv', name: 'Driver Salem', role: 'Delivery', permissions: {} }];
    state.receipts = [{
      id: 'r1', customerId: 'c1', recordType: 'receipt', amountUSD: 100, amountLocal: 500, exchangeRate: 5,
      status: 'Not Paid', isPaid: false, createdAt: new Date().toISOString(), createdBy: 'admin',
      feeDifferenceStatus: 'LOWER', deliveryStatus: 'Delivered', actualDeliveryFeeCollected: 10, deliveryFeePaidBy: 'shop',
      collected: true, collectedAmount: 100, collectedBy: 'drv', companyCoveredUSD: 40
    }];
    state.currentView = 'receipts';
    const html = String(run('renderReceiptsView()'));
    for (const internal of ['Company funds debt coverage', 'Business expense only', 'paid by shop (loss)', 'Fee lower', 'Driver Salem']) {
      assert.ok(everyOccurrenceNoPrint(html, internal), `${internal} would print on the customer's paper`);
    }
    // What the customer needs still prints.
    for (const kept of ['Delivery fee', 'Exchange Rate', 'Created by']) assert.equal(everyOccurrenceNoPrint(html, kept), false, `${kept} must still print`);
  });

  await test('r5 PRN n=22/23: text cut through an emoji still opens WhatsApp and the Studio contact sheet; Arabic keeps the phone in reading order', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.customers = [{ id: 'c1', name: 'Amina', phones: [{ number: '+218 91 456 7890' }] }];
    const receipt = {
      id: 'r1', recordType: 'receipt', customerId: 'c1', status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' },
      receiptType: 'DELIVERY_TEMP', deliveryStatus: 'Needs Delivery', tempReceiptNo: 'D42', amountUSD: 25, amountLocal: 237.5,
      debtAmountUSD: 25, debtAmountLocal: 237.5, exchangeRate: 9.5, quotedDeliveryFee: 15,
      deliveryInstructions: 'a'.repeat(499) + '\u{1F600}' + 'tail'
    };
    const url = sandbox.buildWhatsAppShareLink(sandbox.buildDeliveryReceiptWhatsAppMessage(receipt));  // threw URIError: URI malformed
    assert.ok(url.startsWith('https://wa.me/?text='));
    assert.ok(decodeURIComponent(url.slice('https://wa.me/?text='.length)).includes(`Instructions: ${'a'.repeat(499)}\n`));
    state.language = 'ar';
    const lines = sandbox.buildDeliveryReceiptWhatsAppMessage(Object.assign({}, receipt, { phoneNumber: '+218‮ 91 456 7890' })).split('\n');
    assert.ok(lines.includes('الهاتف: ⁦+218 91 456 7890⁩'), lines.join(' | '));
    assert.ok(lines.includes('رقم الوصل: ⁦D42⁩'), lines.join(' | '));
    const studio = studioFixture();
    studio.sandbox.studioMe = () => ({ contact: { whatsapp: '+218912345678', email: 'help@albayan.example' } });
    const contact = studio.run('renderStudioAdsContact');
    const prefix = 'Hello Albayan team, I have a question about my request "'.length;
    for (const name of ['b'.repeat(79) + '\u{1F600}' + 'c'.repeat(20), 'd'.repeat(119 - prefix) + '\u{1F600}' + 'e'.repeat(5)]) {
      const sheet = String(contact({ name }, 'ask'));
      assert.ok(sheet.includes('href="https://wa.me/218912345678?text=') && sheet.includes('href="mailto:help@albayan.example?subject='), sheet);
    }
  });

  await test('r5 PRN n=24: the Clothes order slip prints "Owed back" when a Paid order total was lowered', async () => {
    for (const language of ['en', 'ar']) {
      const clothes = clothesFixture();
      clothes.state.language = language;
      clothes.run('Security').escapeHtml = plainEscape;
      let slip = null;
      clothes.sandbox.document.body.appendChild = node => { slip = node; };
      clothes.sandbox.document.body.classList = fakeClassList();
      clothes.sandbox.window.print = () => {};
      clothes.sandbox.getVisibleClothesOrders = () => [{ id: 'o1', orderNo: 7, status: 'Delivered', paymentStatus: 'Paid', customerName: 'Mona',
        lines: [{ productId: 'p1', qty: 1, priceLYD: 80 }], deliveryFeeLYD: 0, amountPaidLYD: 100, createdAt: '2026-09-01T10:00:00Z' }];
      clothes.run("printClothesOrderSlip('o1')");
      const text = String(slip && slip.innerHTML);
      assert.ok(text.includes(language === 'ar' ? 'مستحق للإرجاع' : 'Owed back') && text.includes('20.00 LYD'), text);
    }
  });

  await test('r5 PRN n=25: a receipt that leaves the list while the print sheet is open prints blank, never the whole Receipts page', async () => {
    const { sandbox, run } = loadBrowserSource();
    const listeners = {};
    sandbox.window.addEventListener = (type, fn) => { listeners[type] = fn; };
    sandbox.window.removeEventListener = (type, fn) => { if (listeners[type] === fn) delete listeners[type]; };
    sandbox.window.print = () => { if (listeners.beforeprint) listeners.beforeprint(); };
    sandbox.document.body.classList = fakeClassList();
    sandbox.document.querySelector = () => null;
    const card = { isConnected: true, classList: fakeClassList(), getAttribute: () => 'r1' };
    run('printReceiptCard')({ closest: () => card });
    assert.ok(card.classList.contains('print-target') && sandbox.document.body.classList.contains('print-single'));
    card.isConnected = false;   // collected on another device: live sync drew it out of the Unpaid list
    listeners.beforeprint();    // the phone's print sheet re-paginates
    assert.ok(sandbox.document.body.classList.contains('print-single'), 'single-card print mode stays on (before: removed, so the whole page printed)');
    assert.ok(typeof listeners.pointerdown === 'function', 'the usual first-interaction cleanup is still armed');
    listeners.pointerdown();
    assert.ok(!sandbox.document.body.classList.contains('print-single') && !listeners.beforeprint, 'and it still ends the print mode');
  });
  // ---- r5 DBL: double submission of money actions ----
  const realRandom = fixture => { fixture.sandbox.crypto.getRandomValues = v => require('node:crypto').webcrypto.getRandomValues(v); };
  const formField = value => ({ value, dataset: {}, classList: { add() {}, remove() {} }, focus() {} });

  function receiptFormFixture() {
    const fixture = loadBrowserSource();
    const { sandbox } = fixture;
    realRandom(fixture);
    const nodes = {
      'receipt-editing-id': formField(''), 'receipt-customer-id': formField('c1'), 'receipt-status': formField('Not Paid'),
      'notpaid-collection-value': formField('delivery'), 'notpaid-delivery-person': formField('driver1'),
      'receipt-serial': formField(''), 'receipt-delivery-place': formField('Tripoli'),
      'receipt-quoted-delivery-fee': formField('10'), 'receipt-phone-search': formField('0911111111')
    };
    const cells = { '.payment-method': { value: 'Cash (LYD)' }, '.payment-amount': { value: '500' }, '.payment-rate1': { value: '1' },
      '.payment-rate2': { value: '5' }, '.collection-type': { value: 'delivery' } };
    const row = { querySelector: sel => cells[sel] || null };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? [row] : []);
    sandbox.requireReceiptCustomerRiskAcknowledgement = () => false;
    sandbox.isServerModeEnabled = () => true;
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const server = { posted: [], stored: null, lostReply: 'retry409' };
    // The server stores the row with the D-number, type and name it assigns itself.
    const commit = record => { server.stored = { ...record, tempReceiptNo: 'D57', receiptType: 'DELIVERY_TEMP', customerName: 'Customer', startDate: '2020-01-01T00:00:00.000Z' }; };
    sandbox.apiCreateEntity = async (collection, record) => {
      server.posted.push(record.id);
      if (server.stored && server.stored.id === record.id) throw Object.assign(new Error('ID already exists'), { status: 409 });
      commit(record);
      // retry409: withRetry's second attempt met the committed row; network: every attempt was lost.
      if (server.lostReply === 'retry409') throw Object.assign(new Error('ID already exists'), { status: 409 });
      throw new TypeError('Failed to fetch');
    };
    sandbox.apiGetEntity = async (collection, id) => (server.stored && server.stored.id === id ? { id, data: server.stored } : null);
    return { ...fixture, nodes, notes, server };
  }

  await test('r5 DBL n=30: a lost reply on a new delivery receipt is accepted as saved, not a 409 that invites a second job', async () => {
    const { state, run, notes, server } = receiptFormFixture();
    await run('_saveReceiptFromModalInner()');
    assert.equal(server.posted.length, 1);
    assert.ok(!notes.some(n => n.type === 'error'), JSON.stringify(notes));
    assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0].id, server.posted[0]);
    assert.equal(state.receipts[0].tempReceiptNo, 'D57');
    // A different row under that id (another amount) is still refused.
    assert.equal(run('receiptCreateRetryMatches')({ ...server.stored, amountLocal: 999 }, { ...server.stored, tempReceiptNo: '', receiptType: '' }), false);
  });

  await test('r5 DBL n=30: after every attempt is lost, pressing Create again reuses the same receipt id and makes no second receipt', async () => {
    const { state, run, notes, server, nodes } = receiptFormFixture();
    server.lostReply = 'network';
    await run('_saveReceiptFromModalInner()');
    assert.ok(notes.some(n => n.type === 'error'), 'the lost reply is reported');
    assert.equal(state.receipts.length, 0);
    await run('_saveReceiptFromModalInner()');
    assert.equal(server.posted.length, 2);
    assert.equal(server.posted[1], server.posted[0], 'the manual retry must hit the same id');
    assert.equal(nodes['receipt-editing-id'].dataset.draftId, server.posted[0]);
    assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0].tempReceiptNo, 'D57');
    assert.equal(notes[notes.length - 1].type, 'success');
  });

  function receiptTransferFixture() {
    const fixture = loadBrowserSource();
    const { sandbox, state } = fixture;
    realRandom(fixture);
    state.customers.push({ id: 'c2', name: 'Other' });
    state.receipts = [{ id: 'src', customerId: 'c1', amountUSD: 500, amountLocal: 2500, exchangeRate: 5, status: 'Paid', isPaid: true, payments: [], transfers: [], _lastModified: 1 }];
    state.modalData = state.receipts[0];
    const nodes = { 'transfer-target-customer': formField('c2'), 'transfer-amount-usd': formField('100'), 'transfer-note': formField('move'),
      'receipt-transfer-submit': formField('') };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.isServerModeEnabled = () => true;
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const payloads = [];
    const answers = [];
    sandbox.apiTransferReceipt = async payload => { payloads.push(payload); throw answers.shift(); };
    return { ...fixture, payloads, answers, notes };
  }

  await test('r5 DBL n=31: a transfer retried after a lost reply and a live-sync update keeps its key, target id and version', async () => {
    const { state, run, payloads, answers } = receiptTransferFixture();
    answers.push(new TypeError('Failed to fetch'));
    assert.equal(await run('saveReceiptTransfer()'), false);
    // Live sync installs the source receipt with our own committed transfer.
    state.receipts[0] = { ...state.receipts[0], _lastModified: 2, transfers: [{ id: 't1', toReceiptId: payloads[0].targetReceiptId, amountUSD: 100 }] };
    answers.push(new TypeError('Failed to fetch'));
    await run('saveReceiptTransfer()');
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].idempotencyKey, payloads[0].idempotencyKey);
    assert.equal(payloads[1].targetReceiptId, payloads[0].targetReceiptId);
    assert.equal(payloads[1].expectedSourceLastModified, 1, 'the retry keeps the version the server can replay');
    // A definite refusal committed nothing: the next tap starts a fresh attempt on the live version.
    answers.push(Object.assign(new Error('Conflict: source receipt has changed'), { status: 409 }));
    await run('saveReceiptTransfer()');
    answers.push(new TypeError('Failed to fetch'));
    await run('saveReceiptTransfer()');
    assert.equal(payloads.length, 4);
    assert.notEqual(payloads[3].idempotencyKey, payloads[0].idempotencyKey);
    assert.equal(payloads[3].expectedSourceLastModified, 2);
  });

  // r8 K n=1: a fake server that commits each new key once, replays a known key
  // (replayed:true) and can lose the reply after it committed.
  function receiptTransferServer(fixture) {
    const { sandbox, state, payloads } = fixture;
    const server = { moves: 0, targets: new Map(), loseReply: false };
    sandbox.renderModal = () => {};
    sandbox.updateUrlParams = () => {};
    sandbox.closeModal = () => { state.activeModal = null; state.modalData = null; };
    sandbox.apiTransferReceipt = async payload => {
      payloads.push(payload);
      const replayed = server.targets.has(payload.idempotencyKey);
      if (!replayed) {
        server.moves += 1;
        server.targets.set(payload.idempotencyKey, payload.targetReceiptId);
      }
      if (server.loseReply) { server.loseReply = false; throw new TypeError('Failed to fetch'); }
      const version = 1 + server.moves;
      const tid = server.targets.get(payload.idempotencyKey);
      return {
        sourceReceipt: { id: 'src', lastModified: version, data: { ...state.receipts.find(r => r.id === 'src'), _lastModified: version } },
        targetReceipt: { id: tid, lastModified: version, data: { id: tid, customerId: 'c2', amountUSD: 100, status: 'Paid', isPaid: true, receiptType: 'TRANSFER_IN', _lastModified: version } },
        replayed
      };
    };
    // Live sync shows the transfer the lost reply committed.
    server.sync = () => { state.receipts[0] = { ...state.receipts[0], _lastModified: 2, transfers: [{ id: 't1', toReceiptId: payloads[0].targetReceiptId, amountUSD: 100 }] }; };
    return server;
  }

  await test('r8 K n=1: after one lost reply, the next identical transfer from a newly opened dialog really moves the money', async () => {
    const fixture = receiptTransferFixture();
    const { run, payloads, notes } = fixture;
    const server = receiptTransferServer(fixture);
    run("showReceiptTransferModal('src')");
    server.loseReply = true;
    assert.equal(await run('saveReceiptTransfer()'), false);
    server.sync();
    run('closeModal()');
    // Later the customer asks for another identical $100 to the same customer.
    run("showReceiptTransferModal('src')");
    assert.equal(await run('saveReceiptTransfer()'), true);
    assert.equal(server.moves, 2, 'the second intended transfer must be a new transfer, not a replay of the first');
    assert.notEqual(payloads[1].idempotencyKey, payloads[0].idempotencyKey);
    assert.notEqual(payloads[1].targetReceiptId, payloads[0].targetReceiptId);
    assert.equal(payloads[1].expectedSourceLastModified, 2, 'the new transfer is checked against the live version');
    assert.equal(notes[notes.length - 1].title, 'Transferred');
  });

  await test('r8 K n=1: a retry in the same dialog after a lost reply still moves once and says it was already saved, never "Transferred"', async () => {
    const fixture = receiptTransferFixture();
    const { state, run, payloads, notes } = fixture;
    const server = receiptTransferServer(fixture);
    run("showReceiptTransferModal('src')");
    server.loseReply = true;
    assert.equal(await run('saveReceiptTransfer()'), false);
    server.sync();
    assert.equal(await run('saveReceiptTransfer()'), true);
    assert.equal(server.moves, 1, 'the retry must replay the first transfer, not move the money twice');
    assert.equal(payloads[1].idempotencyKey, payloads[0].idempotencyKey);
    const last = notes[notes.length - 1];
    assert.equal(last.title, 'Already transferred');
    assert.equal(last.message, 'This transfer was already saved earlier; nothing new was moved.');
    assert.equal(last.type, 'info');
    assert.ok(!notes.some(n => n.title === 'Transferred'), JSON.stringify(notes));
    assert.equal(state.activeModal, null, 'the dialog closes: that transfer is done');
    // The attempt is finished: a later dialog is a new transfer (Arabic wording too).
    state.language = 'ar';
    run("showReceiptTransferModal('src')");
    server.loseReply = true;
    await run('saveReceiptTransfer()');
    await run('saveReceiptTransfer()');
    assert.equal(server.moves, 2);
    assert.equal(notes[notes.length - 1].title, 'تم التحويل مسبقاً');
  });

  function walletFixture() {
    const fixture = loadBrowserSource();
    const { sandbox, state, run } = fixture;
    realRandom(fixture);
    state.users.push({ id: 'u2', name: 'Two', email: 'two@example.com', role: 'Employee' });
    state.walletTransactions = [];
    const nodes = { 'wallet-transfer-to': formField('u2'), 'wallet-transfer-amount': formField('200'), 'wallet-transfer-memo': formField(''),
      'wallet-transfer-currency': formField('LYD'), 'wallet-transfer-submit': formField('') };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.isServerModeEnabled = () => true;
    const keys = [];
    const replies = [];
    sandbox.apiWalletTransfer = body => { keys.push(body.idempotencyKey); return replies.shift()(); };
    // Past the 1.8 s WalletUiGuard window, and a live-sync render swaps the button.
    const rerender = () => { run('WalletUiGuard._last.clear()'); nodes['wallet-transfer-submit'] = formField(''); };
    return { ...fixture, nodes, keys, replies, rerender };
  }

  await test('r5 DBL n=32: a wallet transfer retried after a re-render swapped its button keeps the idempotency key', async () => {
    const { run, keys, replies, rerender } = walletFixture();
    replies.push(() => Promise.reject(new TypeError('Failed to fetch')));
    await run('walletTransferFromUi()');
    rerender();
    replies.push(() => Promise.reject(new TypeError('Failed to fetch')));
    await run('walletTransferFromUi()');
    assert.equal(keys.length, 2);
    assert.equal(keys[1], keys[0], 'the retry must replay the first transfer, not send a second one');
  });

  await test('r8 K n=2: after a lost wallet transfer reply that sync then shows, the next identical transfer is not faked as "completed"; it says already saved, then really goes', async () => {
    const { sandbox, state, run, rerender } = walletFixture();
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const rows = new Map();
    const sent = [];
    let loseReply = true;
    sandbox.apiWalletTransfer = async body => {
      sent.push(body.idempotencyKey);
      if (!rows.has(body.idempotencyKey)) rows.set(body.idempotencyKey, { id: `wtx${rows.size + 1}`, type: 'transfer', fromUserId: 'admin', toUserId: body.toUserId, amountMinor: body.amountMinor, currency: body.currency, idempotencyKey: body.idempotencyKey });
      if (loseReply) { loseReply = false; throw new TypeError('Failed to fetch'); }
      const row = rows.get(body.idempotencyKey);
      return { id: row.id, data: { ...row } };
    };
    await run('walletTransferFromUi()');
    // Live sync brings the committed row: the sender can see it landed.
    state.walletTransactions.push({ ...rows.get(sent[0]) });
    rerender();
    // Later the same person sends another identical 200 LYD.
    state.language = 'ar';
    await run('walletTransferFromUi()');
    assert.equal(sent.length, 1);
    assert.ok(!notes.some(n => n.type === 'success'), `nothing new was sent, so no success may show: ${JSON.stringify(notes)}`);
    assert.equal(notes[notes.length - 1].title, 'تم مسبقاً');
    state.language = 'en';
    rerender();
    await run('walletTransferFromUi()');
    assert.equal(rows.size, 2, 'the second intended transfer reaches the server as a new one');
    assert.notEqual(sent[1], sent[0]);
    assert.equal(notes[notes.length - 1].message, 'Transfer completed');
  });

  await test('r8 K n=2: leaving the Wallet page or another admin signing in ends a lost top-up attempt; a same-page retry still replays', async () => {
    const { sandbox, state, run, nodes } = walletFixture();
    Object.assign(nodes, { 'wallet-topup-to': formField('u2'), 'wallet-topup-amount': formField('500'), 'wallet-topup-memo': formField(''),
      'wallet-topup-currency': formField('LYD'), 'wallet-topup-submit': formField('') });
    sandbox.preloadAdminToolsForCurrentUser = () => {};
    const credits = new Map();
    const sent = [];
    sandbox.apiWalletTopUp = async body => {
      sent.push(body.idempotencyKey);
      if (!credits.has(body.idempotencyKey)) credits.set(body.idempotencyKey, { id: `wtx${credits.size + 1}` });
      throw new TypeError('The request timed out');
    };
    const press = async () => { run('WalletUiGuard._last.clear()'); await run('walletTopUpFromUi()'); };
    state.currentView = 'wallet';
    run('Security.escapeHtml = s => String(s ?? "")');
    await press();
    run('renderView()');
    await press();
    assert.equal(credits.size, 1, 'a retry on the Wallet page keeps its key');
    assert.equal(sent[1], sent[0]);
    // The admin leaves the Wallet page and comes back for the next customer's payment.
    state.currentView = 'no-access';
    run('renderView()');
    state.currentView = 'wallet';
    await press();
    assert.equal(credits.size, 2, 'a new visit to the page starts a new top-up');
    // Another admin signs in on this tab and records an identical payment.
    state.currentUser = { id: 'admin2', role: 'Admin', permissions: {} };
    state.users.push(state.currentUser);
    await press();
    assert.equal(credits.size, 3, 'the next admin never inherits the previous key');
  });

  await test('r5 DBL n=32: while a wallet transfer is in flight a re-rendered button is disabled and a tap sends nothing', async () => {
    const { run, nodes, keys, replies, rerender } = walletFixture();
    let finish;
    replies.push(() => new Promise(resolve => { finish = resolve; }));
    const first = run('walletTransferFromUi()');
    await settle();
    rerender();
    run('Security.escapeHtml = s => String(s ?? "")');
    assert.ok(/id="wallet-transfer-submit" disabled onclick/.test(String(run('renderWalletView()'))), 'the re-rendered button is disabled');
    await run('walletTransferFromUi()');
    assert.equal(keys.length, 1, 'no second request while the first is in flight');
    finish({ id: 'wtx1', data: { id: 'wtx1', type: 'transfer', fromUserId: 'admin', toUserId: 'u2', amountMinor: 20000, currency: 'LYD', idempotencyKey: keys[0] } });
    await first;
    assert.ok(/id="wallet-transfer-submit" onclick/.test(String(run('renderWalletView()'))));
    assert.equal(nodes['wallet-transfer-submit'].disabled, false);
  });

  // Review loop r6 batch U: user management.
  await test('r6 U n=37: the password field protects a driver who holds unscoped grants; a template driver stays resettable', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.currentUser = { id: 'mgr', role: 'Employee', permissions: { users: ['view', 'resetPassword'] } };
    state.users = [state.currentUser];
    const template = { deliveries: ['viewOwn', 'accept', 'complete', 'markCollected'], ads: ['viewOwn'], customers: ['viewOwn', 'viewContacts'], receipts: ['viewOwn'] };
    assert.equal(sandbox._targetOutranksEditor({ role: 'Delivery', permissions: template }, true), false);
    assert.equal(sandbox._targetOutranksEditor({ role: 'Delivery', permissions: { ...template, users: ['managePermissions'] } }, true), true);  // before: exempt
    assert.equal(sandbox._targetOutranksEditor({ role: 'Delivery', permissions: { ...template, auditLogs: ['view'] } }, true), true);
    assert.equal(sandbox._targetOutranksEditor({ role: 'Delivery', permissions: template }), true, 'a role change keeps the narrow skip');
    const modals = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
    assert.ok(modals.includes("(!canManageUsersAction('resetPassword') || _targetOutranksEditor(userData, true))") && !modals.includes('!isDeliveryRole(userData.role))'));
  });
  await test('r6 U n=34: a users.add holder opens Add User and creates an Employee without an unauthorised permission map', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    const notes = [];
    sandbox.showNotification = (title, message) => notes.push(`${title}: ${message}`);
    sandbox.renderModal = () => {};
    sandbox.updateUrlParams = () => {};
    sandbox.closeModal = () => {};
    state.serverMode = true;
    state.currentUser = { id: 'mgr', role: 'Employee', permissions: { users: ['view', 'add'] } };
    state.users = [state.currentUser];
    sandbox.showUserModal();
    assert.equal(state.activeModal, 'user', notes.join(' | '));   // before: "Admin only"
    assert.equal(notes.length, 0, notes.join(' | '));
    const fields = { 'user-name': { value: 'New Person' }, 'user-email': { value: 'new.person@example.com' },
      'user-password': { value: 'LongEnough123' }, 'user-role': { value: 'Employee' } };
    sandbox.document.getElementById = id => fields[id] || null;
    const sent = [];
    sandbox.apiCreateUser = async payload => { sent.push(JSON.parse(JSON.stringify(payload))); return { id: `u${sent.length}`, ...payload }; };
    await sandbox.handleModalSubmit();
    assert.equal(sent.length, 1, notes.join(' | '));
    assert.ok(!('permissions' in sent[0]), JSON.stringify(sent[0]));   // before: the salesAgent map (server 403)
    // A managePermissions holder who holds every preset grant still sends the preset.
    const preset = run('PERMISSION_TEMPLATES.salesAgent.permissions');
    state.currentUser.permissions = { ...JSON.parse(JSON.stringify(preset)), users: ['view', 'add', 'managePermissions'] };
    fields['user-email'].value = 'second.person@example.com';
    await sandbox.handleModalSubmit();
    assert.deepEqual(sent[1].permissions, JSON.parse(JSON.stringify(preset)));
    // ...but not one who lacks a preset grant.
    state.currentUser.permissions = { users: ['view', 'add', 'managePermissions'], customers: ['view'] };
    fields['user-email'].value = 'third.person@example.com';
    await sandbox.handleModalSubmit();
    assert.ok(!('permissions' in sent[2]), JSON.stringify(sent[2]));
    // Without users.add the modal stays closed.
    state.activeModal = null;
    state.currentUser.permissions = { users: ['view'] };
    sandbox.showUserModal();
    assert.equal(state.activeModal, null);
  });
  await test('r6 U review: local-mode Add User stays Admin only at open; a users.add-only editor is told the account starts with no permissions', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");   // the fake document has no real innerHTML
    const notes = [];
    sandbox.showNotification = (title, message) => notes.push(`${title}: ${message}`);
    sandbox.updateUrlParams = () => {};
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    const modalHtml = () => made.map(el => String(el.innerHTML || '')).join('\n');
    state.activeModal = null;
    state.currentUser = { id: 'mgr', role: 'Employee', permissions: { users: ['view', 'add'] } };
    state.users = [state.currentUser];
    // Local mode: the create is Admin only (handleModalSubmit), so the form must not open.
    state.serverMode = false;
    sandbox.showUserModal();
    assert.equal(state.activeModal, null, 'before: the form opened and refused only on Save');
    assert.deepEqual(notes, ['Access Denied: Admin only']);
    // Server mode: the users.add holder gets the form, with a true line about permissions.
    state.serverMode = true;
    notes.length = 0;
    sandbox.showUserModal();
    assert.equal(state.activeModal, 'user', notes.join(' | '));
    let html = modalHtml();
    assert.ok(html.includes('The new account starts with no permissions; an Admin grants them.'), html.slice(0, 200));
    assert.ok(!html.includes('Default permissions will be assigned'), 'before: promised default permissions it never sends');
    state.language = 'ar';
    made.length = 0;
    sandbox.renderModal();
    html = modalHtml();
    assert.ok(html.includes('يبدأ الحساب الجديد بلا صلاحيات؛ يمنحها الأدمن.') && !html.includes('سيتم تعيين صلاحيات افتراضية'));
    // A managePermissions holder (and the Admin) keeps the permissions-step text.
    state.language = 'en';
    state.currentUser.permissions = { users: ['view', 'add', 'managePermissions'] };
    made.length = 0;
    sandbox.renderModal();
    html = modalHtml();
    assert.ok(html.includes('Default permissions will be assigned') && !html.includes('starts with no permissions'));
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    state.serverMode = false;
    state.activeModal = null;
    notes.length = 0;
    made.length = 0;
    sandbox.showUserModal();
    assert.equal(state.activeModal, 'user', notes.join(' | '));
    assert.ok(modalHtml().includes('Default permissions will be assigned'));
  });
  await test('r6 U n=35: the audit log names deleted staff from the deleted-users directory (list, CSV)', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.serverMode = true;
    state.users = [state.currentUser];
    state.userTombstones = { u_gone: 'Dismissed Ali' };
    const calls = [];
    sandbox.apiJson = async url => {
      calls.push(url);
      if (String(url).startsWith('/api/audit')) return [{ id: 'a1', ts: 1, user_id: 'u_gone', action: 'Delete', resource_type: 'receipts' }, { id: 'a2', ts: 2, user_id: 'u_unknown', action: 'Delete', resource_type: 'receipts' }];
      return [];
    };
    const rows = await sandbox.apiListAuditLogs(500);
    assert.equal(rows[0].userName, 'Dismissed Ali');   // before: 'u_gone'
    assert.ok(calls.includes('/api/users/tombstones'), 'an unknown id asks for the deleted-users directory');
    // A directory that arrives after the rows were cached is still used by the export.
    state.userTombstones = { u_gone: 'Dismissed Ali', u_unknown: 'Late Arrival' };
    let csv = '';
    sandbox.loadAuditLogsForExport = async () => rows;
    sandbox.downloadFile = content => { csv = content; return true; };
    run("Security.escapeHtml = s => String(s ?? '')");
    await sandbox.exportAuditLogs('csv');
    assert.ok(csv.includes('Dismissed Ali') && csv.includes('Late Arrival') && !csv.includes('u_unknown,'), csv);
    // ...and by the list, which re-renders from the cached rows.
    state.serverLogs = rows;
    sandbox.refreshServerAuditLogs = () => {};
    const html = String(sandbox.renderAuditView());
    assert.ok(html.includes('<strong>Late Arrival</strong>') && !html.includes('<strong>u_unknown</strong>'), 'the list shows the raw id');
  });
  await test('r6 U n=36: user delete/create/edit refusals read in Arabic, a 409 never under "Server Error"', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.language = 'ar';
    for (const message of [
      'This account has campaigns under review or approved; decide or stop them first',
      'This account has payment requests waiting for confirmation; cancel them first',
      'This account still has money in its wallet; transfer it to another user first, then delete the account',
      'This driver still has open delivery jobs; reassign or finish them first',
      'This driver still has open delivery jobs; reassign or finish them before changing the role',
      'A user with this email already exists',
      'Cannot remove the last remaining admin. Promote another user to Admin first.',
      'Cannot change the role of a user who holds permissions you do not',
      'Cannot reset the password of a user who holds permissions you do not'
    ]) {
      const [title, body] = sandbox._serverRefusalToast('delete', 'users', { status: 409, message });
      assert.notEqual(title, 'خطأ في الخادم');
      assert.ok(!/[A-Za-z]/.test(body), body);
    }
    state.language = 'en';
    assert.equal(sandbox._serverRefusalText('A user with this email already exists'), 'A user with this email already exists');
    // The shared form-submit catch (user create / edit) passes the server's reason through the same map.
    const modals = fs.readFileSync(path.join(__dirname, '..', 'src', '15-modals.js'), 'utf8');
    assert.ok(modals.includes('const detail = _serverRefusalText(err?.message);'));
  });
  await test('r6 U n=38: a refused driver delete gives the cleared receipt and ad jobs back to the driver', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.users = [state.currentUser, { id: 'd1', name: 'Driver', role: 'Delivery', permissions: {} }];
    state.receipts = [{ id: 'r1', deliveryPersonId: 'd1', deliveryStatus: 'In Progress' }, { id: 'r2', deliveryPersonId: 'd1', deliveryStatus: 'Delivered', isReceivedInOffice: true }];
    state.ads = [{ id: 'a1', deliveryPersonId: 'd1', deliveryStatus: 'Needs Delivery' }];
    const writes = [];
    sandbox.updateRecord = async (arr, id, updates) => { writes.push(`${id}=${updates.deliveryPersonId}`); Object.assign(arr.find(r => r.id === id), updates); return true; };
    let allowDelete = false;
    sandbox.deleteRecord = async () => allowDelete;
    await sandbox.deleteUser('d1');
    assert.equal(state.receipts[0].deliveryPersonId, 'd1', writes.join(' '));   // before: '' - a driverless In Progress job
    assert.equal(state.ads[0].deliveryPersonId, 'd1', writes.join(' '));
    assert.deepEqual(writes, ['r1=', 'a1=', 'r1=d1', 'a1=d1']);
    allowDelete = true;
    writes.length = 0;
    await sandbox.deleteUser('d1');
    assert.deepEqual(writes, ['r1=', 'a1=']);
    assert.equal(state.receipts[0].deliveryPersonId, '');
    assert.equal(state.ads[0].deliveryPersonId, '');
    assert.equal(state.receipts[1].deliveryPersonId, 'd1', 'delivered history keeps the driver');
  });
  // ---- r6 R: receipt screens ----
  // The receipt form opened on stored receipt r1; `form` / `cells` override the DOM values.
  function receiptEditFixture(stored, form = {}, cells = {}) {
    const fixture = loadBrowserSource();
    const { sandbox, state } = fixture;
    realRandom(fixture);
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', _lastModified: 1, ...stored }];
    const nodes = Object.fromEntries(Object.entries({ 'receipt-editing-id': 'r1', 'receipt-customer-id': 'c1', 'receipt-status': 'Paid',
      'paid-collection-value': 'office', 'notpaid-collection-value': 'office', 'receipt-serial': '123', 'receipt-delivery-place': '',
      'receipt-quoted-delivery-fee': '0', 'receipt-phone-search': '', ...form }).map(([id, value]) => [id, formField(value)]));
    const values = { '.payment-method': 'Cash (LYD)', '.payment-amount': '500', '.payment-rate1': '1', '.payment-rate2': '5',
      '.collection-type': 'office', ...cells };
    const row = { querySelector: sel => (sel in values ? { value: values[sel] } : null) };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? [row] : []);
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const saved = [];
    sandbox.updateRecord = async (array, id, record) => { saved.push(record); return true; };
    return { ...fixture, notes, saved };
  }
  const paidReceipt = { status: 'Paid', isPaid: true, serialNumber: '123', finalReceiptNo: '123', amountUSD: 100, amountLocal: 500, exchangeRate: 5,
    payments: [{ method: 'Cash (LYD)', amount: 500, rate: 1, rate2: 5, collectionType: 'office' }] };

  await test('r6 R n=1: the delivery completion row seeds Rate 2 (and a USD row\'s Rate 1) with the receipt\'s own rate, not today\'s', async () => {
    const { state, run } = loadBrowserSource();
    run(realEscape);
    state.defaultExchangeRate = 9.5;
    state.receipts = [{ id: 'd1', exchangeRate: 9.7 }];
    run("_deliveryCompletionOpen = { id: 'd1', lastMod: 0 }");
    const cash = String(run("_deliveryPaymentRowHtml({ method: 'Cash (LYD)', amount: 970 })"));
    assert.ok(/payment-rate2[^>]*value="9\.7"/.test(cash), 'the collected row must credit at the receipt rate 9.7, not the default 9.5');
    const usd = String(run("_deliveryPaymentRowHtml({ method: 'Cash (USD)', amount: 100 })"));
    assert.ok(/payment-rate1[^>]*value="9\.7"/.test(usd) && /payment-rate2[^>]*value="9\.7"/.test(usd));
  });

  await test('r6 R n=1: a no-op office edit of a delivered receipt keeps its credited $100 although the driver row carries Rate 2 9.5', async () => {
    const delivered = { status: 'Paid', isPaid: true, deliveryStatus: 'Delivered', tempReceiptNo: 'D5', serialNumber: '777', finalReceiptNo: '777',
      amountUSD: 100, amountLocal: 970, exchangeRate: 9.7, statusDetail: { paidCollection: 'delivery' },
      payments: [{ method: 'Cash (LYD)', amount: 970, rate: 1, rate2: 9.5, collectionType: 'delivery' }] };
    const form = { 'receipt-serial': '777', 'paid-collection-value': 'delivery' };
    const same = receiptEditFixture(delivered, form, { '.payment-amount': '970', '.payment-rate2': '9.5', '.collection-type': 'delivery' });
    await same.run('_saveReceiptFromModalInner()');
    assert.equal(same.saved.length, 1, JSON.stringify(same.notes));
    assert.equal(same.saved[0].amountUSD, 100, 'before: 102.12 (970 / 9.5 + the house cent)');
    assert.equal(same.saved[0].amountLocal, 970);
    assert.equal(same.saved[0].exchangeRate, 9.7);
    // Rows the office really edited still recompute the money.
    const edited = receiptEditFixture(delivered, form, { '.payment-amount': '1067', '.payment-rate2': '9.7', '.collection-type': 'delivery' });
    await edited.run('_saveReceiptFromModalInner()');
    assert.equal(edited.saved[0].amountLocal, 1067);
    near(edited.saved[0].amountUSD, 110);
  });

  // The Manage Split Payments editor opened on stored receipt r1; `cells` override the one row's DOM values.
  async function splitSave(stored, cells = {}) {
    const fixture = loadBrowserSource();
    const { sandbox, state, run } = fixture;
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', createdBy: 'admin', _lastModified: 1, ...stored }];
    const values = { '.split-method': 'Cash (LYD)', '.split-amount': '970', '.split-rate': '1', '.split-rate2': '9.5',
      '.split-collection': 'delivery', '.split-delivery-person': '', ...cells };
    const row = { querySelector: sel => (sel in values ? { value: values[sel] } : null) };
    sandbox.document.getElementById = id => (id === 'split-payments-receipt-id' ? { value: 'r1' } : null);
    sandbox.document.querySelectorAll = sel => (sel === '.split-payment-item' ? [row] : []);
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.closeModal = () => {};
    const saved = [];
    sandbox.updateRecord = async (array, id, record) => { saved.push(record); return true; };
    await run('saveSplitPayments()');
    return { saved, notes };
  }

  await test('r6 R n=1 (Split): a no-op Save Split Payments on a delivered receipt keeps its credited $100; edited rows still recompute', async () => {
    const delivered = { status: 'Paid', isPaid: true, deliveryStatus: 'Delivered', tempReceiptNo: 'D5', serialNumber: '777', finalReceiptNo: '777',
      amountUSD: 100, amountLocal: 970, exchangeRate: 9.7,
      payments: [{ method: 'Cash (LYD)', amount: 970, rate: 1, rate2: 9.5, collectionType: 'delivery' }] };
    const same = await splitSave(delivered);
    assert.equal(same.saved.length, 1, JSON.stringify(same.notes));
    assert.equal(same.saved[0].amountUSD, 100, 'before: 102.12 (970 / 9.5 + the house cent) minted $2.12');
    assert.equal(same.saved[0].amountLocal, 970);
    assert.equal(same.saved[0].exchangeRate, 9.7);
    // A server-credited HALF_UP amount survives too (the client re-derivation adds the ceil + house cent).
    const halfUp = await splitSave({ ...delivered, amountUSD: 103.09, amountLocal: 1000, payments: [{ method: 'Cash (LYD)', amount: 1000, rate: 1, rate2: 9.7 }] },
      { '.split-amount': '1000', '.split-rate2': '9.7' });
    assert.equal(halfUp.saved[0].amountUSD, 103.09, 'before: 103.11');
    // Rows the office really edited still recompute the money.
    const edited = await splitSave(delivered, { '.split-amount': '1067', '.split-rate2': '9.7' });
    assert.equal(edited.saved[0].amountLocal, 1067);
    near(edited.saved[0].amountUSD, 110);
  });

  await test('r6 R n=2: in server mode an unfunded Paid receipt changed to Not Paid goes through /unsettle, never the refused PATCH', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.isServerModeEnabled = () => true;
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', status: 'Paid', isPaid: true, amountUSD: 100, _lastModified: 1 }];
    const calls = [];
    const refuse = where => async () => { calls.push(where); throw Object.assign(new Error('stop'), { status: 409 }); };
    sandbox.apiPatchEntity = refuse('patch');
    sandbox.apiUnsettleReceipt = refuse('unsettle');
    await run("updateRecord(state.receipts, 'r1', { status: 'Not Paid', isPaid: false }, 1)");
    assert.deepEqual(calls, ['unsettle']);
  });

  await test('r6 R n=2/7: the receipt-form refusals the form invites read as plain Arabic / English, never "endpoint" or a missing action', async () => {
    const { state, run } = loadBrowserSource();
    const say = text => String(run('describe409')({ status: 409, message: text }, 'conflict'));
    const texts = ["Reassign a paid receipt's customer through the receipt transfer endpoint",
      'A canceled receipt the company already covered cannot be reopened; record a new receipt',
      'Insufficient available receipt balance',
      'A Paid receipt cannot be changed to Not Paid with a normal edit. Use the dedicated receipt debt-conversion action.'];
    state.language = 'ar';
    for (const text of texts) {
      const out = say(text);
      assert.ok(/[؀-ۿ]/.test(out) && !/[A-Za-z]{4}/.test(out), `${text} -> ${out}`);
    }
    state.language = 'en';
    assert.ok(!/endpoint/.test(say(texts[0])) && !/debt-conversion/.test(say(texts[3])));
  });

  await test('r6 R n=3: staff without customers.viewContacts keep the stored phone and delivery place when they edit a receipt', async () => {
    const accountant = { id: 'acc', name: 'Accountant', role: 'Employee', permissions: { receipts: ['view', 'add', 'edit'], customers: ['view', 'viewBalance'] } };
    const paid = receiptEditFixture(paidReceipt);
    paid.state.currentUser = accountant;
    await paid.run('_saveReceiptFromModalInner()');
    assert.equal(paid.saved.length, 1, JSON.stringify(paid.notes));
    assert.ok(!('phoneNumber' in paid.saved[0]) && !('deliveryPlaceName' in paid.saved[0]), 'the blank hidden fields would overwrite the stored ones');
    // A pending D-receipt: its place is hidden from them, and the edit still saves.
    const pending = receiptEditFixture({ status: 'Not Paid', isPaid: false, tempReceiptNo: 'D9', deliveryStatus: 'Needs Delivery',
      deliveryPersonId: 'driver1', statusDetail: { notPaidCollection: 'delivery' }, amountUSD: 100, amountLocal: 500, exchangeRate: 5 },
    { 'receipt-status': 'Not Paid', 'notpaid-collection-value': 'delivery', 'notpaid-delivery-person': 'driver1', 'receipt-serial': 'D9' });
    pending.state.currentUser = accountant;
    await pending.run('_saveReceiptFromModalInner()');
    assert.equal(pending.saved.length, 1, JSON.stringify(pending.notes));
    assert.ok(!('deliveryPlaceName' in pending.saved[0]));
    // An office Not Paid receipt they switch to Delivery becomes a new job: its place is still required.
    const office = { status: 'Not Paid', isPaid: false, deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' },
      amountUSD: 100, amountLocal: 500, exchangeRate: 5 };
    const toDelivery = { 'receipt-status': 'Not Paid', 'notpaid-collection-value': 'delivery', 'notpaid-delivery-person': 'driver1', 'receipt-serial': 'D10' };
    const switched = receiptEditFixture(office, toDelivery);
    switched.state.currentUser = accountant;
    await switched.run('_saveReceiptFromModalInner()');
    assert.equal(switched.saved.length, 0, 'before: a live delivery job saved with no place');
    assert.ok(switched.notes.some(n => n.message === 'Delivery place name is required.'), JSON.stringify(switched.notes));
    const placed = receiptEditFixture(office, { ...toDelivery, 'receipt-delivery-place': 'Tripoli' });
    placed.state.currentUser = accountant;
    await placed.run('_saveReceiptFromModalInner()');
    assert.equal(placed.saved.length, 1, JSON.stringify(placed.notes));
    assert.equal(placed.saved[0].deliveryPlaceName, 'Tripoli');
    // A user who can see contacts still saves what the form shows.
    const admin = receiptEditFixture(paidReceipt, { 'receipt-phone-search': '0911111111' });
    await admin.run('_saveReceiptFromModalInner()');
    assert.equal(admin.saved[0].phoneNumber, '0911111111');
  });

  await test('r6 R n=4: a new Cash (LYD) split row starts at Rate 1 = 1 and every row\'s rates follow its method', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.defaultExchangeRate = 9.7;
    const fields = { '.split-method': { value: 'Cash (LYD)' }, '.split-rate': { value: '9.7' }, '.split-rate2': { value: '9.7' } };
    const div = { innerHTML: '', querySelector: sel => fields[sel] || null };
    fields['.split-method'].closest = () => div;
    sandbox.document.createElement = () => div;
    sandbox.document.getElementById = id => (id === 'split-payments-container' ? { appendChild() {} } : null);
    run('addSplitPayment()');
    assert.equal(fields['.split-rate'].value, '1.00', 'before: the market rate 9.7 multiplied the LYD amount');
    assert.equal(fields['.split-rate2'].value, '9.7');
    assert.ok(div.innerHTML.includes('onchange="onSplitMethodChange(this)"'));
    fields['.split-method'].value = 'USDT';
    run('onSplitMethodChange')(fields['.split-method']);
    assert.equal(fields['.split-rate'].value, '0.00');
    assert.equal(fields['.split-rate2'].value, '0');
    fields['.split-method'].value = 'Libyana';
    run('onSplitMethodChange')(fields['.split-method']);
    assert.equal(fields['.split-rate'].value, '0.70');
    assert.equal(fields['.split-rate2'].value, '9.70');
  });

  await test('r6 R n=5: a Rate 1 of 0 counts as 0 on the receipt card and in Mark Collected, as in the form', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(realEscape);
    state.customers = [{ id: 'c1', name: 'Ali' }];
    const receipt = { id: 'z1', recordType: 'receipt', customerId: 'c1', status: 'Paid', isPaid: true, serialNumber: '55', amountLocal: 500,
      amountUSD: 100, exchangeRate: 5, transfers: [], createdAt: '2026-09-01',
      payments: [{ method: 'Cash (LYD)', amount: 500, rate: 1, rate2: 5 }, { method: 'Bank Transfer (LYD)', amount: 1000, rate: 0, rate2: 0 }] };
    state.receipts = [receipt];
    const rows = run('_receiptCollectionBreakdown')(receipt);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 500, 'before: [500, 1000] = 1500 LYD against a 500 LYD receipt');
    const html = String(sandbox.renderReceiptsView());
    assert.ok(/Total Paid:<\/span><span>500\.00 LYD/.test(html), 'Total Paid must match the receipt');
    assert.ok(!html.includes('1000.00 LYD') && !html.includes('1500.00 LYD'));
  });

  await test('r6 R n=13: editing an old receipt keeps its dates, and the customer card reads a receipt by its own day', async () => {
    const old = '2025-01-01T00:00:00.000Z';
    const { saved, notes, run } = receiptEditFixture({ ...paidReceipt, startDate: old, endDate: old, createdAt: old });
    await run('_saveReceiptFromModalInner()');
    assert.equal(saved.length, 1, JSON.stringify(notes));
    assert.equal(saved[0].startDate, old);
    assert.equal(saved[0].endDate, old);
    // Receipts an earlier edit already rewrote still show their real day.
    const { sandbox, state } = loadBrowserSource();
    state.receipts = [{ id: 'x', recordType: 'receipt', customerId: 'c1', status: 'Paid', isPaid: true, amountUSD: 10, amountLocal: 50,
      exchangeRate: 5, createdAt: old, startDate: '2026-09-20T00:00:00.000Z' }];
    assert.equal(sandbox.getCustomerStats('c1').lastAdDate, Date.parse(old));
  });

  await test('r6 R n=20: settling an old Not Paid receipt dates the payment today; a paid receipt keeps its date', async () => {
    const stale = '2026-07-10T00:00:00.000Z';
    const start = Date.now();
    const settle = receiptEditFixture({ status: 'Not Paid', isPaid: false, deliveryStatus: 'Office', collectionDate: stale,
      statusDetail: { notPaidCollection: 'office' }, amountUSD: 100, amountLocal: 500, exchangeRate: 5 });
    await settle.run('_saveReceiptFromModalInner()');
    assert.equal(settle.saved.length, 1, JSON.stringify(settle.notes));
    assert.ok(Date.parse(settle.saved[0].collectionDate) >= start - 1000, `before: kept the stale ${stale}`);
    const kept = receiptEditFixture({ ...paidReceipt, collectionDate: stale });
    await kept.run('_saveReceiptFromModalInner()');
    assert.equal(kept.saved[0].collectionDate, stale);
  });
  // ---------- Review loop r6 batch C: customers, debts and reconciliation ----------
  function debtFixture() {
    const fixture = loadBrowserSource();
    const { state } = fixture;
    state.defaultExchangeRate = 10;
    state.customers = [{ id: 'c1', name: 'Debtor', phones: ['0912345678'] }];
    return fixture;
  }
  const receiptLessDebtAd = (id, usd, rate) => ({ id, recordType: 'ad', customerId: 'c1', amountUSD: usd, spentUSD: usd, exchangeRate: rate, amountLocal: usd * rate,
    status: 'Active', paymentStatus: 'not_paid', isPaid: false, collectionMethod: 'in_shop', receiptAllocations: [], dueAllocations: [], createdAt: new Date().toISOString() });
  const customerIdsFor = (sandbox, state, filter) => {
    state.customerSearch = ''; state.customerSort = 'newest'; state.customerFinancialFilter = filter;
    return sandbox.getFilteredCustomers().map(c => c.id);
  };

  await test('r6 C n=8: a Rate 1 = 0 bank-transfer receipt pays its LYD on both sides of the balance (no fake debt, credit shown, reminder amount right)', async () => {
    const { sandbox, state } = debtFixture();
    state.defaultExchangeRate = 9.5;
    // The receipt form saves Rate 1 = 0 methods with amountLocal 0 and amountUSD = amount / rate2.
    state.receipts = [{ id: 'bt', recordType: 'receipt', customerId: 'c1', paymentMethod: 'Bank Transfer (LYD)', amountUSD: 105.28, amountLocal: 0, exchangeRate: 9.5,
      status: 'Paid', isPaid: true, payments: [{ method: 'Bank Transfer (LYD)', amount: 1000, rate: 0, rate2: 9.5 }], transfers: [], createdAt: new Date().toISOString() }];
    // Unspent: the $105.28 credit must show in LYD too.
    let stats = sandbox.getCustomerStats('c1');
    near(stats.totalPaidLYD, 1000.16);
    assert.ok(stats.balanceLYD > 0, `an unspent transfer is credit, got ${stats.balanceLYD}`);
    assert.deepEqual(customerIdsFor(sandbox, state, 'hasCredit'), ['c1']);
    // Fully spent by one ad: settled, not "Owes 1,000.16 LYD".
    state.ads = [{ id: 'a1', recordType: 'ad', customerId: 'c1', amountUSD: 105.28, spentUSD: 105.28, exchangeRate: 9.5, status: 'Active', paymentStatus: 'paid', isPaid: true,
      receiptId: 'bt', receiptAllocations: [{ receiptId: 'bt', amountUSD: 105.28 }], dueAllocations: [] }];
    stats = sandbox.getCustomerStats('c1');
    near(stats.balanceUSD, 0);
    near(stats.balanceLYD, 0);   // before: -1000.16
    assert.deepEqual(customerIdsFor(sandbox, state, 'hasDebt'), []);
    // A second, unpaid $10 ad: the reminder asks for about 95 LYD, not about 1,095.
    state.ads.push(receiptLessDebtAd('a2', 10, 9.5));
    const rows = sandbox.shellDebtorRows();
    assert.equal(rows.length, 1);
    near(rows[0].dueLyd, 95);
    assert.ok(sandbox.shellReminderMessage(rows[0]).includes('95 LYD'));
  });

  await test('r6 C n=10: the customer list, debt filters, sort, pill, header tile and Home Owed pick debtors by the USD balance, like Collect', async () => {
    const { sandbox, state, run } = debtFixture();
    run('Security.escapeHtml = s => String(s ?? "")');
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', amountUSD: 100, amountLocal: 1000, exchangeRate: 10, status: 'Paid', isPaid: true, payments: [], transfers: [] }];
    state.ads = [receiptLessDebtAd('a1', 105, 9)];   // owes $5 while the unlinked LYD reads +55
    let stats = sandbox.getCustomerStats('c1');
    near(stats.balanceUSD, -5);
    near(stats.balanceLYD, 55);
    assert.equal(sandbox.shellDebtorRows().length, 1);
    assert.deepEqual(customerIdsFor(sandbox, state, 'hasDebt'), ['c1']);    // before: hidden
    assert.deepEqual(customerIdsFor(sandbox, state, 'hasCredit'), []);      // before: listed as credit
    near(sandbox.getCustomerSortValue(state.customers[0], 'highestDebt'), 50);
    const pill = sandbox.shellCustomerRow(state.customers[0], stats, '', { canSeeBalance: true });
    assert.ok(pill.includes('Owes 50 LYD') && !pill.includes('Credit'), 'the pill must say Owes');
    assert.ok(sandbox.renderManagerHomeHero([], [], true).includes('50 LYD'), 'Home Owed counts the debtor');
    // The reverse: USD settled while the LYD mirror reads -100 — nobody owes.
    state.ads = [receiptLessDebtAd('a1', 100, 11)];
    stats = sandbox.getCustomerStats('c1');
    near(stats.balanceUSD, 0);
    near(stats.balanceLYD, -100);
    assert.equal(sandbox.shellDebtorRows().length, 0);
    assert.deepEqual(customerIdsFor(sandbox, state, 'hasDebt'), []);        // before: listed
    assert.ok(sandbox.shellCustomerRow(state.customers[0], stats, '', { canSeeBalance: true }).includes('Settled'));
    const hero = sandbox.renderManagerHomeHero([], [], true);
    assert.ok(!hero.includes('100 LYD') && hero.includes('0 LYD'), 'Home Owed must not count a settled customer');
  });

  await test('r6 C n=9/19: Collect a debt opens the receipt form with Paid chosen (the real settle path), never the handover-only dialog', async () => {
    const { sandbox, state } = debtFixture();
    const receipt = { id: 'np', recordType: 'receipt', customerId: 'c1', amountUSD: 95, amountLocal: 950, exchangeRate: 10, status: 'Not Paid', isPaid: false,
      deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: [], createdBy: 'admin', createdAt: new Date().toISOString() };
    state.receipts = [receipt];
    const calls = [];
    sandbox.openCollectReceiptModal = id => calls.push(['collectDialog', id]);
    sandbox.editReceipt = async id => { calls.push(['edit', id]); state.activeModal = 'receipt'; state.modalData = receipt; };
    sandbox.setReceiptStatus = (tab, status) => calls.push(['status', status]);
    sandbox.openCustomerReceipts = cid => { calls.push(['list', cid]); return true; };
    sandbox.document.querySelector = selector => (selector === '#receipt-status-tabs button[data-status="Paid"]' ? { dataset: { status: 'Paid' } } : null);
    await sandbox.openDebtorCollection('c1');
    assert.deepEqual(calls, [['edit', 'np'], ['status', 'Paid']]);
    // Without receipts.edit (a collections clerk): the customer's unpaid receipts, not the handover dialog.
    calls.length = 0;
    state.currentUser = { id: 'clerk', role: 'Employee', permissions: { receipts: ['view', 'markCollected'], customers: ['view', 'viewBalance'] } };
    await sandbox.openDebtorCollection('c1');
    assert.deepEqual(calls, [['list', 'c1']]);
    assert.equal(state.receiptStatusFilter, 'not_paid');
    // A driver (D#) receipt settles through its delivery, so the list opens too.
    calls.length = 0;
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    Object.assign(receipt, { tempReceiptNo: 'D7', deliveryStatus: 'Needs Delivery', statusDetail: { notPaidCollection: 'delivery' } });
    await sandbox.openDebtorCollection('c1');
    assert.deepEqual(calls, [['list', 'c1']]);
  });

  await test('r6 C n=9: the Record Collection dialog on an unpaid receipt says it does not mark the receipt Paid', async () => {
    const { sandbox, state, run } = debtFixture();
    run('Security.escapeHtml = s => String(s ?? "")');
    state.receipts = [{ id: 'np', recordType: 'receipt', customerId: 'c1', amountUSD: 95, amountLocal: 950, exchangeRate: 10, status: 'Not Paid', isPaid: false,
      deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' }, payments: [], transfers: [] },
    { id: 'pd', recordType: 'receipt', customerId: 'c1', amountUSD: 10, amountLocal: 100, exchangeRate: 10, status: 'Paid', isPaid: true, payments: [], transfers: [] }];
    let html = '';
    sandbox.document.body.insertAdjacentHTML = (where, markup) => { html = markup; };
    sandbox.updateUrlParams = () => {};
    sandbox.openCollectReceiptModal('np');
    assert.ok(html.includes('it does not mark the receipt Paid'));
    sandbox.openCollectReceiptModal('pd');
    assert.ok(html.includes('Record Collection') && !html.includes('does not mark the receipt Paid'));
  });

  await test('r6 C n=11: a refused server customer delete leaves the pages linked; a committed one unlinks them after', async () => {
    const { sandbox, state } = debtFixture();
    sandbox.isServerModeEnabled = () => true;
    state.pages = [{ id: 'p1', name: 'Page', customerIds: ['c1', 'c2'] }];
    const pageWrites = [];
    sandbox.updateRecord = async (array, id, updates) => { pageWrites.push(id); Object.assign(array.find(x => x.id === id), updates); return true; };
    sandbox.addAuditLog = () => {};
    sandbox.apiBatchDeleteEntities = async () => { throw Object.assign(new Error('Customer cannot be deleted while linked records exist'), { status: 409 }); };
    await sandbox.deleteCustomer('c1');
    assert.deepEqual(pageWrites, [], 'no page PATCH may go out before the atomic delete');
    assert.deepEqual(state.pages[0].customerIds, ['c1', 'c2']);
    assert.ok(!state.customers[0]._deleted, 'the refused delete rolled back');
    // R5 error-paths-offline-4: the refusal names its rule (in Arabic too), not "Server Error" and the English sentence.
    const toasts = [];
    sandbox.showNotification = (title, message) => toasts.push([title, message]);
    state.language = 'ar';
    await sandbox.deleteCustomer('c1');
    assert.deepEqual(toasts, [['غير مسموح', 'فشل حذف العميل: لا يمكن حذف العميل لوجود وصولات أو إعلانات مرتبطة به. — تم التراجع عن الحذف بالكامل.']]);
    assert.ok(!state.customers[0]._deleted);
    state.language = 'en';
    sandbox.apiBatchDeleteEntities = async () => ({ stamps: {} });
    await sandbox.deleteCustomer('c1');
    assert.deepEqual(pageWrites, ['p1']);
    assert.deepEqual(state.pages[0].customerIds, ['c2']);
    assert.ok(state.customers[0]._deleted);
  });

  await test('r6 C n=12: customer search finds a partly typed local number stored as +218', async () => {
    const { sandbox, state } = debtFixture();
    state.customers = [{ id: 'c9', name: 'X', phones: ['+218 91 234 5678'] }, { id: 'c8', name: 'Y', phones: ['+218 92 876 5432'] }];
    const find = term => { state.customerSearch = term; state.customerSort = 'newest'; state.customerFinancialFilter = 'all'; return sandbox.getFilteredCustomers().map(c => c.id); };
    assert.deepEqual(find('0912345'), ['c9']);      // before: []
    assert.deepEqual(find('091234567'), ['c9']);    // before: []
    assert.deepEqual(find('0912345678'), ['c9']);
    assert.deepEqual(find('0000'), []);             // stripped to nothing: never matches everyone
  });

  await test('r6 C n=18: reconciliation shows a just-ended ad first, not after 200 old finished ones past the 150-card cap', async () => {
    const { sandbox, state, run } = debtFixture();
    run('Security.escapeHtml = s => String(s ?? "")');
    const day = n => new Date(Date.now() - n * 86400000).toISOString();
    state.ads = [];
    for (let i = 0; i < 200; i += 1) {
      state.ads.push({ id: `old_${i}`, recordType: 'ad', customerId: 'c1', amountUSD: 50, spentUSD: 50, status: 'Stopped',
        startDate: day(130), endDate: day(100 - (i % 30)), stoppedAt: day(100 - (i % 30)), createdAt: day(130) });
    }
    state.ads.push({ id: 'new_ad', recordType: 'ad', customerId: 'c1', amountUSD: 100, status: 'Active', startDate: day(20), endDate: day(3), createdAt: day(20) });
    const html = String(sandbox.renderReconciliationView());
    assert.ok(html.includes('data-reconciliation-card="new_ad"'), 'the just-ended ad is not drawn');   // before: index 200, cut
    assert.ok(html.indexOf('data-reconciliation-card="new_ad"') < html.indexOf('data-reconciliation-card="old_'), 'pending comes first');
    assert.ok(html.includes('<strong>1</strong>'), 'the header counts the one ad still to review');
    assert.ok(html.includes('Showing 150 of 201'));
  });

  await test('r6 C n=22: the receipts "Not Collected" filter keeps a partly collected receipt; "Collected" keeps only full ones', async () => {
    const { sandbox, state, run } = debtFixture();
    run('Security.escapeHtml = s => String(s ?? "")');
    const base = { recordType: 'receipt', customerId: 'c1', exchangeRate: 10, status: 'Paid', isPaid: true, payments: [], transfers: [], createdAt: new Date().toISOString() };
    const partial = { ...base, id: 'rcpt_partial_x', amountUSD: 100, amountLocal: 1000, collected: true, collectedAmount: 300 };
    const full = { ...base, id: 'rcpt_full_x', amountUSD: 10, amountLocal: 100, collected: true, collectedAmount: 100 };
    const legacy = { ...base, id: 'rcpt_legacy_x', amountUSD: 10, amountLocal: 100, collected: true };
    near(sandbox._receiptCollectedFraction(partial), 0.3);
    near(sandbox._receiptCollectedFraction(full), 1);
    near(sandbox._receiptCollectedFraction(legacy), 1);
    near(sandbox._receiptCollectedFraction({ ...full, collected: false }), 0);
    state.receipts = [partial, full, legacy];
    const listed = filter => { state.receiptCollectedFilter = filter; const html = String(sandbox.renderReceiptsView()); return state.receipts.map(r => r.id).filter(id => html.includes(id)); };
    assert.deepEqual(listed('not-collected'), ['rcpt_partial_x']);   // before: [] — the 700 LYD still held was nowhere
    assert.deepEqual(listed('collected'), ['rcpt_full_x', 'rcpt_legacy_x']);
    // The analytics Collection Status card: $30 collected, $70 outstanding, 0 of 1 fully collected.
    state.receipts = [partial];
    const analytics = String(sandbox.renderAnalyticsView());
    assert.ok(analytics.includes('✓ $30') && analytics.includes('○ $70') && analytics.includes('0/1'), 'Collection Status counts the partial receipt as fully collected');
  });

  await test('r6 C n=25: the home hero Receipts count leaves out canceled, lost and destroyed receipts', async () => {
    const { sandbox, run } = debtFixture();
    run('Security.escapeHtml = s => String(s ?? "")');
    const now = new Date().toISOString();
    const r = (id, status, isPaid) => ({ id, recordType: 'receipt', customerId: 'c1', amountUSD: 10, amountLocal: 100, exchangeRate: 10, status, isPaid, createdAt: now, payments: [], transfers: [] });
    const receipts = [r('a', 'Paid', true), r('b', 'Not Paid', false), r('c', 'Canceled', false), r('d', 'Lost', false), r('e', 'Destroyed', false)];
    const html = String(sandbox.renderManagerHomeHero(receipts, [], false));
    assert.ok(/shell-hero-value[^>]*>2</.test(html), 'the hero shows 2 live receipts');   // before: 5
    assert.ok(/Receipts<\/span>\s*<span class="shell-kpi-value[^>]*>2</.test(html), 'the Receipts KPI shows 2');
  });

  await test('r6 C n=24: the Liquidity start-date picker shows the local start day, like its label', async () => {
    const savedTZ = process.env.TZ;
    process.env.TZ = 'Africa/Tripoli';
    try {
      const { sandbox, state, run } = debtFixture();
      run('Security.escapeHtml = s => String(s ?? "")');
      const start = new Date(2026, 8, 29).toISOString();   // local midnight = 2026-09-28T22:00:00.000Z
      assert.equal(start, '2026-09-28T22:00:00.000Z');
      state.appSettings = [{ id: 'lq', settingKey: 'liquidityTracking', startDate: start, setBy: 'admin', date: start }];
      const html = String(sandbox.renderAnalyticsView());
      assert.ok(html.includes('id="liquidity-start-date" value="2026-09-29"'), 'the picker must prefill 29 Sep');   // before: 2026-09-28
    } finally {
      if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
    }
  });
  // ---- Review loop r7, batch N: deep links and reloads

  // The fake window's address bar and history, moved by replaceState/pushState the way a browser moves them.
  function addressBar(sandbox, url, entryState = null) {
    const loc = sandbox.window.location;
    const move = next => { const u = new URL(String(next), 'http://localhost'); loc.pathname = u.pathname; loc.search = u.search; loc.href = u.href; };
    const history = { state: entryState, pushes: 0,
      replaceState(value, _title, next) { this.state = value; move(next); },
      pushState(value, _title, next) { this.pushes += 1; this.state = value; move(next); } };
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.window.history = history;
    move(url);
    return history;
  }

  await test('r7 N n=3: the start-up and sign-in rewrites keep a studio deep link (section, id, step) and the v2 Back chain', async () => {
    const { sandbox, run } = studioFixture();
    const chain = { chain: ['home|||', 'campaigns|||', 'campaigns||adreq_1|'] };
    const history = addressBar(sandbox, '/ads-studio?tab=campaigns&id=adreq_1', { view: 'ads-studio', params: { tab: 'campaigns' }, studioV2: chain });
    run("restoreViewStateFromUrl('ads-studio'); updateUrlForView('ads-studio', true);");  // init's rewrite after a reload
    assert.equal(sandbox.window.location.search, '?tab=campaigns&id=adreq_1');  // before: '?tab=campaigns'
    assert.deepEqual(JSON.parse(JSON.stringify(history.state)), { view: 'ads-studio', studioV2: chain });  // before: { view } only
    run("updateUrlForView('ads-studio')");  // the post-login route restore at the same address
    assert.equal(history.pushes, 0, 'no second entry for the same screen');
    assert.equal(sandbox.window.location.search, '?tab=campaigns&id=adreq_1');
    // A v2 tab the classic list cannot take (its 'dashboard' stands in for it) keeps its address too.
    addressBar(sandbox, '/ads-studio?tab=wallet&section=history&step=2');
    run("_adsStudioActiveTab = 'dashboard'; restoreViewStateFromUrl('ads-studio'); updateUrlForView('ads-studio', true);");
    assert.equal(sandbox.window.location.search, '?tab=wallet&section=history&step=2');  // before: '?tab=dashboard'
    // Another tab starts clean: the old id is not carried over to it, and a stale classic tab is replaced.
    addressBar(sandbox, '/ads-studio?tab=campaigns&id=adreq_1');
    run("_adsStudioActiveTab = 'posts'; updateUrlForView('ads-studio', true);");
    assert.equal(sandbox.window.location.search, '?tab=posts');
    addressBar(sandbox, '/ads-studio?tab=campaigns&id=adreq_1');
    run("_adsStudioActiveTab = 'dashboard'; updateUrlForView('ads-studio', true);");
    assert.equal(sandbox.window.location.search, '?tab=dashboard');
    // Entering the studio from another screen still writes only the tab (and pushes a new entry).
    const other = addressBar(sandbox, '/receipts?tab=campaigns&id=adreq_1');
    run("_adsStudioActiveTab = 'campaigns'; updateUrlForView('ads-studio');");
    assert.equal(sandbox.window.location.pathname + sandbox.window.location.search, '/ads-studio?tab=campaigns');
    assert.equal(other.pushes, 1);
  });

  await test('r7 N n=4: a tab link opened before its lazy bundle runs keeps ?tab= for the loader\'s restore (Clothes, classic studio)', async () => {
    const { sandbox, run } = loadBrowserSource();
    addressBar(sandbox, '/clothes-system?tab=orders');
    run("updateUrlForView('clothes-system', true)");  // init's rewrite, clothes.js not run yet
    assert.equal(sandbox.window.location.search, '?tab=orders');  // before: '' (the Overview after the load)
    addressBar(sandbox, '/receipts?tab=orders');
    run("updateUrlForView('clothes-system', true)");  // another page's tab is not taken along
    assert.equal(sandbox.window.location.pathname + sandbox.window.location.search, '/clothes-system');
    addressBar(sandbox, '/ads-studio?tab=review&section=tickets');
    run("updateUrlForView('ads-studio', true)");  // studio.js not run yet
    assert.equal(sandbox.window.location.search, '?tab=review&section=tickets');  // before: ''
    // The bundles arrive: the loaders' restore reads the tab the address kept.
    addressBar(sandbox, '/clothes-system?tab=orders');
    run("updateUrlForView('clothes-system', true)");
    run(fs.readFileSync(path.join(__dirname, '..', 'src', '15b-clothes.js'), 'utf8'));
    run('restoreClothesTabFromUrl()');
    assert.equal(run('_clothesActiveTab'), 'orders');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    addressBar(sandbox, '/ads-studio?tab=review');
    run("updateUrlForView('ads-studio', true)");
    for (const file of manifest.lazy['studio.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    run('restoreAdsStudioTabFromUrl()');
    assert.equal(run('_adsStudioActiveTab'), 'review');  // the admin's review queue, not the Overview
  });

  await test('r7 N n=5: before the start-up load settles, a request or plan missing from an old cache reads "loading", never gone or ended', async () => {
    const { sandbox, state, run } = studioFixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    for (const file of manifest.lazy['studio-pages.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    sandbox.refreshAdsStudioLimits = () => {};
    sandbox.renderStudioV2View = () => '';  // the classic layout
    run("state.currentUser = { id: 'cust3', role: 'Employee', permissions: { adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn'] }, subscriptions: [] }; state.users = [state.currentUser];");
    state.adCampaignRequests = [];
    // The device cache still has last month's lapsed plan; the renewal is on its way in the load.
    state.serviceSubscriptions = [{ id: 'sub_old', userId: 'cust3', serviceId: 'ad_maker', status: 'active', expiresAt: '2026-01-01T00:00:00Z' }];
    const screens = () => ({
      detail: String(run("renderStudioAdsDetail({ tab: 'campaigns', section: '', id: 'adreq_x', step: 0 })")),
      list: String(run("renderStudioAdsList({ tab: 'campaigns', section: '', id: '', step: 0 })")),
      classic: String(run('renderAdsStudioView()')),
      needs: JSON.parse(run('JSON.stringify(studioHomeNeeds([], null).map(item => item.key))')),
      pages: String(run("renderStudioPagesBody({ tab: 'replies', section: 'pages', id: '', step: 0 })")),
      // The v2 Home a v2 customer lands on, its placeholder (no Home screen registered) and the builder's banners.
      home: String(run('renderStudioHomeBody()')),
      placeholder: String(run("(() => { const draw = _studioV2Screens.get('home'); _studioV2Screens.delete('home'); try { return renderStudioV2CustomerScreen({ tab: 'home', section: '', id: '', step: 0 }); } finally { _studioV2Screens.set('home', draw); } })()")),
      builder: String(run("studioBuilderBanners({ status: 'ready' })"))
    });
    run('_serverLiveSync.startupLoadPending = true;');
    const loading = screens();
    assert.ok(!loading.detail.includes('studio-ad-missing') && !loading.detail.includes('not in your list any more'), loading.detail);
    assert.ok(loading.detail.includes('data-testid="studio-ad-loading"') && loading.detail.includes('Loading your requests…'));
    assert.ok(!loading.list.includes('You have no ad requests yet') && loading.list.includes('data-testid="studio-ads-loading"'), loading.list);
    assert.ok(!loading.classic.includes('Activate Ads Studio') && !loading.classic.includes('Your subscription has ended'), loading.classic);
    assert.ok(!loading.needs.includes('plan'), 'no "Your plan has ended" on Home yet');
    assert.ok(!loading.pages.includes('studio-pg-plan-ended') && loading.pages.includes('data-testid="studio-pg-loading"'), loading.pages);
    assert.ok(loading.home.includes('data-testid="studio-home"') && !loading.home.includes('Activate Ads Studio') && !loading.home.includes('Activate your plan to start'), loading.home);
    assert.ok(loading.placeholder.includes('data-testid="studio-screen-home"') && !loading.placeholder.includes('Activate Ads Studio'), loading.placeholder);
    assert.ok(!loading.builder.includes('Your plan is not active'), loading.builder);
    // The load settled and the rows still say so: the real wording.
    run('_serverLiveSync.startupLoadPending = false;');
    const settled = screens();
    assert.ok(settled.detail.includes('data-testid="studio-ad-missing"') && settled.detail.includes('This request is not in your list any more.'));
    assert.ok(settled.list.includes('data-testid="studio-ads-empty"') && settled.list.includes('You have no ad requests yet'));
    assert.ok(settled.classic.includes('Activate Ads Studio'), settled.classic);
    assert.ok(settled.needs.includes('plan'));
    assert.ok(settled.pages.includes('data-testid="studio-pg-plan-ended"'));
    assert.ok(settled.home.includes('Activate Ads Studio') && settled.home.includes('Activate your plan to start'), settled.home);
    assert.ok(settled.placeholder.includes('Activate Ads Studio'), settled.placeholder);
    assert.ok(settled.builder.includes('Your plan is not active'), settled.builder);
    // A new sign-in (a new session) is never left "loading".
    run('_serverLiveSync.startupLoadPending = true; advanceServerSessionEpoch();');
    assert.equal(run('adsStudioStartupLoading()'), false);
  });

  await test('r7 N n=6: a reload within 2 s (throttled boot) replays a ?modal=&id= link after the first catch-up tick, so a record the cache lacked still opens', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    addressBar(sandbox, '/receipts?modal=receipt&id=R1');
    run("_bootModalParams = { modal: 'receipt', id: 'R1' };");  // captured when the page loaded
    const timers = [];
    sandbox.setTimeout = fn => { timers.push(fn); return timers.length; };
    const runTimers = () => timers.splice(0).forEach(fn => fn());
    const me = { id: 'admin', role: 'Admin', permissions: {}, name: 'Admin' };
    Object.assign(sandbox, {
      initIndexedDB: async () => null, loadState: () => null, apiHealthCheck: async () => true, apiAuthMe: async () => me,
      activateServerCollectionStorage() {}, activateAnonymousServerCollectionStorage() {}, setupMobileRuntime: async () => {},
      updateMobileServerReachability() {}, setMobileColdStartBlocked() {}, initializeNativeSessionProtection: async () => true,
      isRefreshThrottled: () => true  // the tab booted less than 2 s ago
    });
    state.serverModeOverride = 'server';
    state.receipts = [];  // R1 was made by a colleague: not in this device's cache
    let finishTick = null;
    sandbox.serverLiveSyncOnce = () => new Promise(resolve => { finishTick = resolve; });
    const opened = [];
    sandbox.editReceipt = id => {
      opened.push(id);
      const receipt = state.receipts.find(row => row.id === id);
      if (receipt) { state.activeModal = 'receipt'; state.modalData = receipt; }
    };
    await run('init()');
    assert.equal(sandbox.window.location.search, '', 'the address was rewritten to the view');
    assert.equal(typeof finishTick, 'function', 'the first catch-up tick is running');
    runTimers();
    assert.deepEqual(opened, [], 'nothing is opened against the cache alone');  // before: R1 tried, not found, dropped
    assert.equal(run('_serverLiveSync.startupLoadPending'), true, 'the screens know the load is not done (n=5)');
    state.receipts = [{ id: 'R1', customerId: 'c1' }];  // the tick brings it
    finishTick({ ok: true });
    await settle(); await settle();
    runTimers();
    assert.deepEqual(opened, ['R1']);
    assert.equal(state.activeModal, 'receipt');
    assert.equal(run('_serverLiveSync.startupLoadPending'), false);
  });
  // Review loop r7 K n=20: three fast "+" taps on a Clothes stock chip. The server row is the truth;
  // `firstFails` makes the first PATCH fail (a version conflict or a lost network) while taps 2 and 3
  // wait behind it.
  async function stepperRun(serverStart, localStart, firstFails) {
    const { sandbox, state } = clothesFixture();
    let server = { id: 'p1', name: 'Shirt', createdBy: 'admin', ...serverStart };
    state.clothesProducts = [{ id: 'p1', name: 'Shirt', createdBy: 'admin', ...localStart }];
    const sent = [];
    sandbox.isServerModeEnabled = () => true;
    sandbox.updateClothesProductsFiltered = () => {};
    sandbox.apiGetEntity = async () => {
      if (firstFails === 'offline') throw new TypeError('Failed to fetch');
      return { data: JSON.parse(JSON.stringify(server)) };
    };
    sandbox.apiPatchEntity = async (collection, id, updates, expected) => {
      sent.push({ qty: updates.variants[0].qty, expected });
      if (sent.length === 1 && (firstFails === 'network' || firstFails === 'offline')) throw new TypeError('Failed to fetch');
      if (Number(expected) !== server._lastModified) throw Object.assign(new Error('Conflict: product has changed'), { status: 409 });
      server = { ...server, ...JSON.parse(JSON.stringify(updates)), _lastModified: server._lastModified + 1 };
      return { data: JSON.parse(JSON.stringify(server)) };
    };
    await Promise.all([1, 2, 3].map(() => sandbox.adjustClothesVariantQty('p1', 'Red', 'M', 1)));
    await settle();
    return { sent, server, local: state.clothesProducts[0] };
  }

  await test('r7 K n=20: fast stock "+" taps after a missed sale never undo that sale (queued taps behind a failed one are dropped)', async () => {
    // The phone sold 2 (5 -> 3 at version 101); this tab still shows 5 at version 100.
    const conflict = await stepperRun({ _lastModified: 101, variants: [{ color: 'Red', size: 'M', qty: 3 }] },
      { _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] }, 'conflict');
    assert.deepEqual(conflict.sent.map(call => call.qty), [6], 'before: [6, 7, 8] - 7 and 8 were accepted on the reloaded version');
    assert.equal(conflict.server.variants[0].qty, 3, 'the other device\'s sale stays');
    assert.equal(conflict.local.variants[0].qty, 3, 'the screen shows the server stock');
    // A lost network on the first tap: the queued taps are not sent on a guessed version either.
    const network = await stepperRun({ _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] },
      { _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] }, 'network');
    assert.deepEqual(network.sent.map(call => call.qty), [6]);
    assert.equal(network.server.variants[0].qty, 5);
    assert.equal(network.local.variants[0].qty, 5, 'the dropped taps\' optimistic count is replaced by the server copy');
    // Fully offline: the reload fails too. The screen falls back to the last SAVED copy (5 at version
    // 100), never to tap 2's unsaved optimistic copy (before: 7 with a client-clock version).
    const offline = await stepperRun({ _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] },
      { _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] }, 'offline');
    assert.deepEqual(offline.sent.map(call => call.qty), [6]);
    assert.equal(offline.local.variants[0].qty, 5, 'the last saved count, not the unsaved 7');
    assert.equal(offline.local._lastModified, 100, 'the saved version, so the next tap does not 409');
    // Offline, but live sync installed the other device's sale (3 at version 101) while tap 1 was in
    // flight: the tap queued after it falls back to THAT saved copy, not to the older 5.
    {
      const { sandbox, state } = clothesFixture();
      const product = (qty, version) => ({ id: 'p1', name: 'Shirt', createdBy: 'admin', _lastModified: version, variants: [{ color: 'Red', size: 'M', qty }] });
      state.clothesProducts = [product(5, 100)];
      const sent = [];
      sandbox.isServerModeEnabled = () => true;
      sandbox.updateClothesProductsFiltered = () => {};
      sandbox.apiGetEntity = async () => { throw new TypeError('Failed to fetch'); };
      sandbox.apiPatchEntity = async (collection, id, updates) => { sent.push(updates.variants[0].qty); throw new TypeError('Failed to fetch'); };
      const tap1 = sandbox.adjustClothesVariantQty('p1', 'Red', 'M', 1);
      state.clothesProducts[0] = product(3, 101);
      const tap2 = sandbox.adjustClothesVariantQty('p1', 'Red', 'M', 1);
      await Promise.all([tap1, tap2]);
      await settle();
      assert.deepEqual(sent, [6]);
      assert.equal(state.clothesProducts[0].variants[0].qty, 3);
      assert.equal(state.clothesProducts[0]._lastModified, 101);
    }
    // Control: in sync, all three taps still chain on each echoed version.
    const ok = await stepperRun({ _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] },
      { _lastModified: 100, variants: [{ color: 'Red', size: 'M', qty: 5 }] }, '');
    assert.deepEqual(ok.sent, [{ qty: 6, expected: 100 }, { qty: 7, expected: 101 }, { qty: 8, expected: 102 }]);
    assert.equal(ok.server.variants[0].qty, 8);
    assert.equal(ok.local.variants[0].qty, 8);
  });

  await test('R2 clothes-operations-2: a colour/size picked in an open order or shipment form, and a stock +/- tap, keep that exact colour and size after another device removes a row', async () => {
    const { sandbox, state, run, notes } = clothesFixture();
    run('Security').escapeHtml = plainEscape;
    const shirt = variants => ({ id: 'p1', name: 'Shirt', createdBy: 'admin', costUSD: 3, priceLYD: 20, _lastModified: 100, variants });
    const fullList = () => shirt([{ color: 'Red', size: 'S', qty: 0 }, { color: 'Red', size: 'M', qty: 5 }, { color: 'Blue', size: 'M', qty: 5 }]);
    const afterRemoval = () => shirt([{ color: 'Red', size: 'M', qty: 5 }, { color: 'Blue', size: 'M', qty: 5 }]);
    const unescapeAttr = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const wraps = { 'clothes-order-lines': { innerHTML: '' }, 'clothes-ship-lines': { innerHTML: '' } };
    sandbox.document.getElementById = id => wraps[id] || null;
    // The value the browser hands the handler for the option whose text starts with label.
    const optionValue = (wrapId, label) => {
      const m = new RegExp(`<option value="([^"]*)"[^>]*>${label}`).exec(wraps[wrapId].innerHTML);
      assert.ok(m, `no "${label}" option in ${wraps[wrapId].innerHTML}`);
      return unescapeAttr(m[1]);
    };
    const picked = name => run(`${name}.map(line => line.color + '/' + line.size).join()`);
    state.clothesProducts = [fullList()];
    run("_clothesTempOrderLines = [{ productId: 'p1', color: '', size: '', qty: 1, priceLYD: '20' }]");
    run("_clothesTempShipLines = [{ productId: 'p1', color: '', size: '', qty: 10, unitCostUSD: '3' }]");
    sandbox.refreshClothesOrderLines();
    sandbox.refreshClothesShipLines();
    const onScreen = { orderRedM: optionValue('clothes-order-lines', 'Red · M'), orderRedS: optionValue('clothes-order-lines', 'Red · S'),
      shipRedM: optionValue('clothes-ship-lines', 'Red · M') };
    // Live sync from another device removes the unused Red/S row while both forms are still open.
    state.clothesProducts = [afterRemoval()];
    sandbox.onClothesOrderLineVariantPick(0, onScreen.orderRedM);
    sandbox.onClothesShipLineVariantPick(0, onScreen.shipRedM);
    assert.equal(picked('_clothesTempOrderLines'), 'Red/M', 'before: the order line became Blue/M');
    assert.equal(picked('_clothesTempShipLines'), 'Red/M', 'before: the shipment line became Blue/M');
    assert.equal(notes.length, 0, JSON.stringify(notes));
    // The removed row is cleared with a notice, never swapped for the row now in its place.
    sandbox.onClothesOrderLineVariantPick(0, onScreen.orderRedS);
    assert.equal(picked('_clothesTempOrderLines'), '/', 'before: Red/S picked Red/M');
    assert.equal(notes.length, 1, JSON.stringify(notes));
    assert.equal(notes[0].type, 'warning');
    // A colour with quotes, a bar and a percent sign survives the option value.
    state.clothesProducts = [shirt([{ color: 'Rose | "Night" & 50%', size: "Men's L", qty: 2 }])];
    sandbox.refreshClothesOrderLines();
    sandbox.onClothesOrderLineVariantPick(0, optionValue('clothes-order-lines', 'Rose'));
    assert.equal(picked('_clothesTempOrderLines'), `Rose | "Night" & 50%/Men's L`);
    // A stock "+" tap on the Red · M chip drawn before the removal changes Red/M only.
    state.clothesProducts = [fullList()];
    const card = String(sandbox.renderClothesProductCard(state.clothesProducts[0]));
    const plus = /<button([^>]*)>\+<\/button>/.exec(card.slice(card.indexOf('<span>Red · M</span>')))[1];
    const dataset = {};
    for (const m of plus.matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[m[1]] = unescapeAttr(m[2]);
    const tap = run(`(function () { return ${unescapeAttr(/onclick="([^"]*)"/.exec(plus)[1])}; })`);
    state.clothesProducts = [afterRemoval()];
    sandbox.updateClothesProductsFiltered = () => {};
    await tap.call({ dataset });
    await settle();
    assert.deepEqual(state.clothesProducts[0].variants.map(v => `${v.color}/${v.size}=${v.qty}`), ['Red/M=6', 'Blue/M=5'], 'before: Blue/M went up');
  });
  await test('r7 K n=21: a "partial" payment of the whole order total is shown and stored as Paid', async () => {
    for (const serverMode of [true, false]) {
      const { sandbox, state, notes } = clothesFixture();
      state.clothesOrders = [{ id: 'o1', orderNo: 3, customerName: 'Sara', status: 'New', paymentStatus: 'Not Paid', amountPaidLYD: 0,
        deliveryFeeLYD: 5, lines: [{ productId: 'p1', qty: 2, priceLYD: 20 }], _lastModified: 4, createdBy: 'admin' }];
      let sent = null;
      let patched = null;
      sandbox.prompt = () => '45';
      sandbox.isServerModeEnabled = () => serverMode;
      sandbox.apiMutateClothesOrder = async request => { sent = request; return {}; };
      sandbox.applyClothesOrderMutationResponse = () => {};
      sandbox.updateRecord = async (array, id, updates) => { patched = updates; return true; };
      await sandbox.setClothesOrderPayment('o1', 'Partially Paid');
      if (serverMode) {
        assert.equal(sent.paymentStatus, 'Partially Paid', 'the amount the user typed is sent; the server makes it Paid');
        near(sent.data.amountPaidLYD, 45);
      } else {
        assert.equal(patched.paymentStatus, 'Paid');
        near(patched.amountPaidLYD, 45);
        assert.ok(patched.paidAt);
      }
      assert.ok(notes.some(note => note.message === 'Payment status is now: Paid'), JSON.stringify(notes));
    }
    // The order form (local mode): Partially Paid with the whole total is saved as Paid with its date.
    const { sandbox, state, run } = clothesFixture();
    state.clothesProducts = [{ id: 'p1', name: 'Shirt', costUSD: 5, priceLYD: 20, variants: [{ color: 'Red', size: 'M', qty: 5 }], createdBy: 'admin' }];
    state.clothesOrders = [];
    const fields = { 'clothes-order-customer': 'Sara', 'clothes-order-fee': '5', 'clothes-order-paystatus': 'Partially Paid', 'clothes-order-paid': '45' };
    sandbox.document.getElementById = id => (id in fields ? { value: fields[id] } : null);
    run("_clothesTempOrderLines = [{ productId: 'p1', color: 'Red', size: 'M', qty: 2, priceLYD: 20 }];");
    let added = null;
    sandbox.isServerModeEnabled = () => false;
    sandbox.applyClothesOrderStockDelta = async () => true;
    sandbox.addRecord = async (array, record) => { added = record; return record; };
    assert.equal(await sandbox.saveClothesOrderFromModal(), true);
    assert.equal(added.paymentStatus, 'Paid');
    near(added.amountPaidLYD, 45);
    assert.ok(added.paidAt, 'a paid order carries its paid date');
  });

  await test('r7 K n=22: Clothes order and shipment refusals speak Arabic and name the product, never its internal id', async () => {
    const { sandbox, state, notes } = clothesFixture();
    state.clothesProducts = [{ id: 'clothesProducts_x1', name: 'قميص', variants: [], createdBy: 'admin' }];
    const cases = [
      ['order', 'Product variant is unavailable: clothesProducts_x1', true],
      ['order', 'Insufficient stock for clothesProducts_x1: 1 available, 2 requested', true],
      ['shipment', 'Cannot un-receive clothesProducts_x1: 1 available, 3 required', true],
      ['shipment', 'Cannot un-receive missing product variant: clothesProducts_x1', true],
      ['shipment', 'Shipment product is missing: clothesProducts_gone', false],
      ['order', 'Product not found: clothesProducts_gone', false],
      ['order', 'Conflict: order has changed', false],
      ['shipment', 'Conflict: shipment has changed', false],
      ['order', 'An active clothes_system subscription is required', false],
      ['order', 'Returned/Canceled orders cannot be edited', false]
    ];
    const show = (kind, message) => {
      notes.length = 0;
      const error = Object.assign(new Error(message), { status: 409 });
      if (kind === 'order') sandbox.showClothesOrderMutationError(error);
      else sandbox.showClothesShipmentMutationError(error);
      return notes[0].message;
    };
    state.language = 'ar';
    for (const [kind, message, named] of cases) {
      const text = show(kind, message);
      assert.ok(!/clothesProducts_|[A-Za-z]{3,}/.test(text), `${message} -> ${text}`);
      if (named) assert.ok(text.includes('"قميص"'), `${message} -> ${text}`);
    }
    state.language = 'en';
    state.clothesProducts[0].name = 'Shirt $1';
    const english = show('order', 'Product variant is unavailable: clothesProducts_x1');
    assert.ok(english.includes('"Shirt $1"') && !english.includes('clothesProducts_'), english);
    assert.equal(show('order', 'Some new server rule'), 'Some new server rule', 'an unknown refusal is still shown as sent');
  });

  await test('r7 K n=22: a new order line whose product has no stock at all is refused before sending, in Arabic', async () => {
    const { sandbox, state, run, notes } = clothesFixture();
    state.language = 'ar';
    state.clothesProducts = [{ id: 'p1', name: 'قميص', costUSD: 5, priceLYD: 20, variants: [], createdBy: 'admin' }];
    state.clothesOrders = [];
    const fields = { 'clothes-order-customer': 'Sara', 'clothes-order-fee': '0', 'clothes-order-paystatus': 'Not Paid', 'clothes-order-paid': '0' };
    sandbox.document.getElementById = id => (id in fields ? { value: fields[id] } : null);
    run("_clothesTempOrderLines = [{ productId: 'p1', color: '', size: '', qty: 1, priceLYD: 20 }];");
    let calls = 0;
    sandbox.isServerModeEnabled = () => true;
    sandbox.apiMutateClothesOrder = async () => { calls += 1; return {}; };
    assert.equal(await sandbox.saveClothesOrderFromModal(), false);
    assert.equal(calls, 0, 'before: the request went out and the English server refusal came back');
    assert.ok(notes.some(note => note.message.includes('"قميص"') && !/[A-Za-z]{3,}/.test(note.message)), JSON.stringify(notes));
  });
  // ---- Review loop r8, batch B: the v2 request builder (and the classic save, for the same sanitizer)

  await test('r8 B n=15: ad words are saved as typed ("data:" and "on…=" kept) by the v2 builder and the classic form', async () => {
    const { run } = studioFixture();
    const words = { name: 'Only = 5 LYD', pageName: 'Data: Shop', primaryText: 'Mobile data: 10GB for 30 LYD', headline: 'Buy one = get one free', notes: 'data: plan, onsale=yes' };
    run(`var __r8Draft = { ...newAdsStudioDraft(), ...${JSON.stringify(words)} };`);
    const v2 = JSON.parse(run('JSON.stringify(studioBuilderPayload(__r8Draft, null))'));
    run(`_adsStudioDraft = { ...newAdsStudioDraft(), ...${JSON.stringify(words)}, description: 'onboard = free' };`);
    const classic = JSON.parse(run('JSON.stringify(sanitizedAdsStudioDraft())'));
    for (const [field, value] of Object.entries(words)) {
      assert.equal(v2[field], value, `v2 ${field}`);
      assert.equal(classic[field], value, `classic ${field}`);
    }
    assert.equal(classic.description, 'onboard = free');
    // What the server strips itself still goes before the save: < and >.
    run("__r8Draft.primaryText = '<b>Hi</b>'; _adsStudioDraft.primaryText = '<b>Hi</b>';");
    assert.equal(run('studioBuilderPayload(__r8Draft, null).primaryText'), 'bHi/b');
    assert.equal(run('sanitizedAdsStudioDraft().primaryText'), 'bHi/b');
    // A leading "javascript:"/"vbscript:" goes (the server would save the whole field empty), the rest stays.
    run("__r8Draft.headline = 'JavaScript: a course for kids'; _adsStudioDraft.headline = 'JavaScript: a course for kids';");
    run("__r8Draft.notes = ' vbscript:JAVASCRIPT: <x>hi'; _adsStudioDraft.notes = ' vbscript:JAVASCRIPT: <x>hi';");
    assert.equal(run('studioBuilderPayload(__r8Draft, null).headline'), 'a course for kids');
    assert.equal(run('sanitizedAdsStudioDraft().headline'), 'a course for kids');
    assert.equal(run('studioBuilderPayload(__r8Draft, null).notes'), 'xhi');
    assert.equal(run('sanitizedAdsStudioDraft().notes'), 'xhi');
  });
  // ---- Loop round 34, studio (R3 studio-client-1..5) ----
  await test('R3 studio-client-1: ad words with "data:", "JavaScript:" or "on…=" are saved, synced, reopened and reviewed as typed; other records are still stripped', async () => {
    const studio = studioFixture();
    const { sandbox, state, run, calls, replies } = studio;
    const words = { primaryText: 'Mobile data: 10GB for 30 LYD', headline: 'Learn JavaScript: from zero', description: 'Order online=fast' };
    const wordsOf = row => ({ primaryText: row.primaryText, headline: row.headline, description: row.description });
    const sent = [];
    let version = 100;
    sandbox.apiCreateEntity = async (collection, record) => {
      sent.push(['create', JSON.parse(JSON.stringify(record))]);
      return { id: record.id, data: { ...record, createdBy: 'cust1', _lastModified: version }, lastModified: version };
    };
    sandbox.apiPatchEntity = async (collection, id, updates) => {
      sent.push(['patch', JSON.parse(JSON.stringify(updates))]);
      version += 1;
      const row = state.adCampaignRequests.find(item => item.id === id) || {};
      return { id, data: { ...row, ...updates, _lastModified: version }, lastModified: version };
    };
    state.adCampaignRequests = [];
    // The classic Save draft (addRecord), then an edit of it (updateRecord): the words go as typed.
    run(`_adsStudioDraft = { ...newAdsStudioDraft(), name: 'Summer offer', ...${JSON.stringify(words)} };`);
    await sandbox.saveAdsStudioDraft(false);
    assert.equal(sent[0][0], 'create');
    assert.deepEqual(wordsOf(sent[0][1]), words, 'before: primaryText arrived as "Mobile  10GB for 30 LYD"');
    const id = sent[0][1].id;
    assert.deepEqual(wordsOf(state.adCampaignRequests[0]), words, 'the saved copy on this device');
    run("_adsStudioDraft.headline = 'Buy one = get one, onsale=yes'; _adsStudioDraft.notes = 'data: plan';");
    await sandbox.saveAdsStudioDraft(false);
    assert.equal(sent[1][0], 'patch');
    assert.equal(sent[1][1].headline, 'Buy one = get one, onsale=yes');
    assert.equal(sent[1][1].notes, 'data: plan');
    // Live sync, a batch echo and the full read for the photos keep them (and the team's words).
    const row = { ...JSON.parse(JSON.stringify(state.adCampaignRequests[0])), ...words, notes: 'data: plan',
      reviewNote: 'Fix the JavaScript: part', stopReason: 'onhold=yes', status: 'Draft', _lastModified: 500 };
    assert.equal(sandbox.applyServerDelta('adCampaignRequests', [row]), true);
    assert.deepEqual(wordsOf(state.adCampaignRequests[0]), words, 'before: live sync stored "Mobile  10GB…"');
    assert.deepEqual([state.adCampaignRequests[0].notes, state.adCampaignRequests[0].reviewNote, state.adCampaignRequests[0].stopReason],
      ['data: plan', 'Fix the JavaScript: part', 'onhold=yes']);
    sandbox.applyValidatedServerEntityBatch([{ collection: 'adCampaignRequests', entity: { id, data: { ...row, _lastModified: 600 }, lastModified: 600 } }]);
    assert.deepEqual(wordsOf(state.adCampaignRequests[0]), words, 'a batch echo');
    const lean = { ...state.adCampaignRequests[0], _mediaOmitted: true, _photoCount: 1 };
    delete lean.creativeImages;
    state.adCampaignRequests[0] = lean;
    sandbox.apiGetEntity = async () => ({ id, data: { ...row, creativeImages: ['data:image/png;base64,AAAA'], _lastModified: 600 }, lastModified: 600 });
    assert.deepEqual(wordsOf(await sandbox.ensureEntityMediaLoaded('adCampaignRequests', id)), words, 'the full read for the photos');
    assert.deepEqual(wordsOf(await sandbox.ensureEntityMediaLoaded('adCampaignRequests', id)), words, 'its cached copy');
    state.adCampaignRequests[0] = { ...row, _lastModified: 600 };
    // The reopened forms: the v2 builder's draft and the classic edit.
    assert.deepEqual(wordsOf(JSON.parse(run('JSON.stringify(studioBuilderDraftFromCampaign(state.adCampaignRequests[0]))'))), words, 'v2 builder draft');
    run('_adsStudioDraft = null;');
    await sandbox.startAdsStudioCampaign(id);
    assert.deepEqual(wordsOf(run('_adsStudioDraft')), words, 'classic edit draft');
    // The copy on this device (saved state, loaded state, a cache cleaned before drawing).
    const whole = run("Security.sanitizeObject({ adCampaignRequests: [{ id: 'a1', primaryText: 'Mobile data: 10GB', name: '<b>Sale</b>' }], receipts: [{ id: 'r1', notes: 'data: x' }] })");
    assert.deepEqual([whole.adCampaignRequests[0].primaryText, whole.adCampaignRequests[0].name, whole.receipts[0].notes], ['Mobile data: 10GB', 'bSale/b', 'x']);
    const later = sandbox.setTimeout;
    sandbox.setTimeout = fn => { fn(); return 1; };  // its yield between chunks
    state.adCampaignRequests = [{ ...row }];
    state.receipts = [{ id: 'r1', notes: 'data: x onclick=go' }];
    await sandbox.sanitizeCollectionInPlace('adCampaignRequests');
    await sandbox.sanitizeCollectionInPlace('receipts');
    sandbox.setTimeout = later;
    assert.deepEqual(wordsOf(state.adCampaignRequests[0]), words, 'a cache cleaned before drawing');
    // Guards: every other record keeps today's stripping; < and > still go from the ad words.
    assert.equal(run("Security.sanitizeObject({ notes: 'data: x' }).notes"), 'x');
    assert.equal(run("Security.sanitizeRecord('receipts', { notes: 'data: x' }).notes"), 'x');
    assert.equal(state.receipts[0].notes, 'x go');
    assert.equal(run("Security.sanitizeRecord('adCampaignRequests', { headline: ' javascript:<i>Go</i> now', notes: 'data: x' }).headline"), 'iGo/i now');
    // The team's note is sent and kept as written: the classic review and the Team desk.
    state.currentUser = { id: 'staff1', role: 'Employee', permissions: { adCampaignRequests: ['view', 'review'] } };
    state.users = [state.currentUser];
    state.adCampaignRequests = [{ ...row, status: 'Submitted', createdBy: 'cust1', _lastModified: 700 }];
    const url = `/api/ad-studio/campaigns/${encodeURIComponent(id)}/review`;
    replies[url] = options => ({ id, data: { ...row, status: 'Changes Requested', reviewNote: options.body.note, _lastModified: 800 }, lastModified: 800 });
    run(`setAdsStudioReviewNote('${id}', 'data: plan, onsale=no'); setAdsStudioReviewReason('${id}', 'text_policy');`);
    await sandbox.reviewAdsStudioCampaign(id, 'Changes Requested');
    const review = calls.filter(call => call.url === url);
    assert.equal(review.length, 1);
    assert.equal(review[0].body.note, 'data: plan, onsale=no', 'before: the note arrived as "plan, no"');
    assert.equal(state.adCampaignRequests[0].reviewNote, 'data: plan, onsale=no');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    for (const file of manifest.lazy['studio-staff.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    state.adCampaignRequests = [{ ...row, status: 'Submitted', createdBy: 'cust1', _lastModified: 900 }];
    run(`(() => { const draft = studioDeskDecision('${id}'); draft.reason = 'text_policy'; draft.note = 'Mobile data: say it once'; })();`);
    await sandbox.studioDeskDecide(id, 'Changes Requested');
    assert.equal(calls.filter(call => call.url === url)[1].body.note, 'Mobile data: say it once', 'the desk note');
    // Drawn escaped: a request name with a double quote stays inside its text.
    const card = String(sandbox.renderAdsStudioCampaignCard({ ...row, name: 'Say "hi" onmouseover=alert(1)', status: 'Draft' }));
    assert.ok(card.includes('Say &quot;hi&quot; onmouseover=alert(1)') && !card.includes('"hi"'), card);
  });

  await test('R3 studio-client-2: sign-out stops the v2 builder; a draft whose first save is still retrying is never created in the next account', async () => {
    for (const how of ['sign-out', 'switch', 'same user']) {
      const { sandbox, state, run } = studioFixture();
      sandbox.URLSearchParams = URLSearchParams;
      sandbox.studioV2Frame = () => 'customer';  // the v2 layout (its /me is not read here)
      const timers = new Map();
      let seq = 0;
      sandbox.setTimeout = fn => { seq += 1; timers.set(seq, fn); return seq; };
      sandbox.clearTimeout = timer => { timers.delete(timer); };
      const fire = async () => {
        for (let round = 0; round < 4; round++) { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); await settle(); }
      };
      const listeners = { pagehide: [], visibilitychange: [] };
      sandbox.window.addEventListener = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };
      sandbox.document.addEventListener = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };
      let online = false;
      const creates = [];
      sandbox.apiCreateEntity = async (collection, record) => {
        creates.push([String(state.currentUser?.id || ''), record.primaryText]);
        if (!online) throw new TypeError('Failed to fetch');
        return { id: record.id, data: { ...record, status: 'Draft', _lastModified: 5 }, lastModified: 5 };
      };
      run("studioBuilderStart('full'); studioBuilderListen(); studioBuilderInput('text', { value: 'A private offer' });");
      await fire();  // the autosave a second later: no connection, a retry is armed
      assert.equal(run('_studioBuilder.session.status'), 'offline');
      assert.ok(creates.length >= 1 && creates.every(([uid]) => uid === 'cust1'), JSON.stringify(creates));
      if (how === 'sign-out') sandbox.closeSensitiveAuthenticatedUi();  // sign-out and session expiry run this
      if (how !== 'same user') {
        state.currentUser = { id: 'adminB', role: 'Admin', permissions: {} };
        state.users = [state.currentUser];
      }
      online = true;
      await fire();
      sandbox.document.visibilityState = 'hidden';
      listeners.visibilitychange.forEach(fn => fn());
      listeners.pagehide.forEach(fn => fn());
      await fire();
      assert.deepEqual(creates.filter(([uid]) => uid !== 'cust1'), [], `${how}: before, the draft was created as adminB`);
      if (how === 'sign-out') assert.equal(run('_studioBuilder.session'), null, 'sign-out drops the draft and its photos');
      if (how === 'same user') {
        assert.equal(run('_studioBuilder.session.status'), 'saved', 'the same account still saves once the connection is back');
        assert.deepEqual(creates[creates.length - 1], ['cust1', 'A private offer']);
      }
    }
  });

  await test('R3 studio-client-3: the classic Overview\'s wallet activity reads each row\'s type in Arabic with the request\'s name, never the ledger\'s English memo with ids', () => {
    const { sandbox, state, run } = studioFixture();
    state.language = 'ar';
    state.adCampaignRequests = [{ id: 'cmp_1', name: 'عرض الصيف', createdBy: 'cust1', status: 'Approved' }];
    state.walletTransactions = [
      { id: 't3', type: 'campaign_refund', memo: 'Refund of stopped campaign cmp_1', fromUserId: 'system', toUserId: 'cust1', currency: 'USD', amountMinor: 200, referenceType: 'adCampaignRequest', referenceId: 'cmp_1' },
      { id: 't4', type: 'campaign_payment_release', memo: 'Release of unapproved campaign payment cmp_1', fromUserId: 'system', toUserId: 'cust1', currency: 'USD', amountMinor: 300, referenceType: 'reversalOf', referenceId: 't2' },
      { id: 't2', type: 'campaign_payment', memo: 'Ad campaign budget cmp_1', fromUserId: 'cust1', toUserId: 'system', currency: 'USD', amountMinor: 500, referenceType: 'adCampaignRequest', referenceId: 'cmp_1' },
      { id: 't1', type: 'credit', memo: 'Top-up', fromUserId: 'system', toUserId: 'cust1', currency: 'USD', amountMinor: 1000 }
    ];
    run("_adsStudioWalletMine = []; _adsStudioWalletForUser = 'cust1';");
    const titles = () => {
      const html = String(sandbox.renderAdsStudioWallet());
      const rows = html.slice(html.indexOf(run("adsStudioText('Recent wallet activity', 'آخر حركات المحفظة')"))).split('workspace-wallet-row').slice(1);
      return { html, rows, titles: rows.map(row => (/<span class="text-slate-600 dark:text-slate-300">([\s\S]*?)<\/span>/.exec(row) || [])[1] || '') };
    };
    let view = titles();
    assert.deepEqual(view.titles, ['استرجاع حملة · <bdi>عرض الصيف</bdi>', 'إرجاع ميزانية حملة · <bdi>عرض الصيف</bdi>', 'ميزانية حملة · <bdi>عرض الصيف</bdi>', 'شحن المحفظة'],
      'before: the titles were "Refund of stopped campaign cmp_1", … and "Top-up"');
    for (const memo of ['Ad campaign budget cmp_1', 'Refund of stopped campaign cmp_1', 'Release of unapproved campaign payment cmp_1']) {
      assert.ok(!view.html.includes(memo), `${memo} is never shown`);
    }
    assert.ok(/<bdi dir="ltr">Top-up<\/bdi>/.test(view.rows[3]), 'a memo with no request stays a small line, left to right');
    state.language = 'en';
    view = titles();
    assert.deepEqual(view.titles, ['Campaign refund · <bdi>عرض الصيف</bdi>', 'Campaign budget returned · <bdi>عرض الصيف</bdi>', 'Campaign budget · <bdi>عرض الصيف</bdi>', 'Wallet top-up']);
    // One label map for both screens; the main Wallet page keeps its titles.
    assert.deepEqual(['credit', 'transfer', 'reversal', 'service_payment', 'campaign_payment', 'campaign_refund', 'campaign_payment_release', 'odd_type', 'constructor'].map(type => sandbox.walletTxLabel(type, true)),
      ['شحن المحفظة', 'تحويل', 'عكس معاملة', 'اشتراك', 'ميزانية حملة', 'استرجاع حملة', 'إرجاع ميزانية حملة', 'odd_type', 'constructor']);
    assert.equal(sandbox.walletTxLabel('campaign_payment_release', false), 'Campaign budget returned');
    state.language = 'ar';
    const page = String(sandbox.renderWalletView());
    assert.ok(['شحن المحفظة', 'ميزانية حملة', 'استرجاع حملة', 'إرجاع ميزانية حملة'].every(title => page.includes(`<div class="font-bold text-slate-800 dark:text-white">${title}</div>`)), page);
  });

  await test('R3 studio-client-4: the phone\'s Back closes the classic Withdraw, Unlink and Link sheets first (never "Press Back again to exit"), and keeps the desk section under the Link sheet', async () => {
    const { sandbox, run } = studioFixture();
    sandbox.URLSearchParams = URLSearchParams;
    const notes = [];
    const moves = [];
    sandbox.showNotification = (title, message) => { notes.push(`${title}: ${message}`); };
    sandbox.navigateToInternal = view => { moves.push(`navigate:${view}`); };
    sandbox.getMobileLandingView = () => 'ads-studio';  // a customer whose landing screen is the studio
    const history = sandbox.window.history;
    history.back = () => { moves.push('back'); };
    history.go = step => { moves.push(`go:${step}`); };
    history.pushState = (stateObject, title, url) => { moves.push(`push:${url}`); };
    history.replaceState = (stateObject, title, url) => { moves.push(`replace:${url}`); };
    const sheets = [
      ['_adsStudioWithdrawConfirmId', "'c1'"],
      ['_adsStudioUnlinkSheet', "{ campaignId: 'c1', reason: '', busy: false, outcome: null }"],
      ['_adsStudioLinkSheet', "{ campaignId: 'c1', accountId: '', metaCampaignId: '', busy: false, outcome: null }"]
    ];
    for (const [flag, value] of sheets) {
      run(`${flag} = ${value};`);
      await sandbox.handleAndroidBackButton({ canGoBack: true });
      assert.ok(!run(flag), `${flag}: before, Back left the sheet open`);
      assert.deepEqual(notes, [], `${flag}: before, "Press Back again to exit" (and the next Back closed the app)`);
      assert.deepEqual(moves, []);
      run(`${flag} = ${value};`);
      assert.equal(sandbox.studioHandleBack(), true);
      assert.ok(!run(flag));
    }
    // Nothing open: Back on the studio landing still asks before leaving the app.
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.equal(notes.length, 1);
    // The Team desk (v2) on Launch with the Link sheet open: Back closes the sheet, the section stays.
    notes.length = 0;
    sandbox.studioV2Frame = () => 'staff';
    sandbox.window.location.search = '?tab=review&section=launch';
    run(sheets[2].join(' = '));
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.equal(run('_adsStudioLinkSheet'), null);
    assert.deepEqual(moves, [], 'before: Back moved the desk from Launch to Requests under the open sheet');
    assert.deepEqual(notes, []);
    // With the sheet closed, Back on Launch goes up to Requests as before.
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.ok(moves.some(move => /section=requests/.test(move)), JSON.stringify(moves));
  });

  await test('R3 studio-client-5: a studio read the app cancels by moving on is "not read yet", never a failure (results card, payment methods, post picker); a timeout or a 500 still fails', async () => {
    const { sandbox, run } = studioFixture();
    sandbox.AbortController = AbortController;
    const calls = [];
    let mode = 'wait';
    // As apiFetch: a navigation (cancelPendingRequests) aborts the read with an AbortError; so does a timeout.
    sandbox.apiJson = url => new Promise((resolve, reject) => {
      calls.push(url);
      const aborted = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      if (mode === 'timeout') return reject(aborted());
      if (mode === '500') return reject(Object.assign(new Error('Server Error'), { status: 500 }));
      sandbox.getNavigationSignal().addEventListener('abort', () => reject(aborted()), { once: true });
    });
    const cancel = async read => { const running = read(); sandbox.cancelPendingRequests(); await running; await settle(); };
    const readsAgain = (read, url) => { const before = calls.length; read(); assert.equal(calls.length, before + 1, `${url}: asked again`); assert.equal(calls[calls.length - 1], url); sandbox.cancelPendingRequests(); };
    // The Meta results card.
    await cancel(() => sandbox.adsStudioLoadResults('cmp_1'));
    assert.equal(run("_adsStudioResults.byId.get('cmp_1').state"), '', 'before: failed ("Meta\'s numbers are late" for a minute)');
    assert.equal(run("_adsStudioResults.byId.get('cmp_1').at"), 0, 'no retry wait, no freshness stamp');
    await settle();
    readsAgain(() => sandbox.adsStudioLoadResults('cmp_1'), '/api/studio/campaigns/cmp_1/results');
    await settle();
    run("Object.assign(_adsStudioResults.byId.get('cmp_1'), { data: { stage: 5 }, state: 'done', at: 1234 });");
    await cancel(() => sandbox.adsStudioLoadResults('cmp_1', true));
    assert.deepEqual(JSON.parse(run("JSON.stringify(_adsStudioResults.byId.get('cmp_1'))")), { state: 'done', data: { stage: 5 }, at: 1234, promise: null }, 'a kept reading stays as it was');
    // Add money's payment methods.
    await cancel(() => sandbox.studioWalletLoadMethods());
    assert.equal(run('_studioWallet.methodsFailed'), false, 'before: "The payment methods could not be read."');
    readsAgain(() => sandbox.studioWalletLoadMethods(), '/api/wallet/payment-requests/methods');
    await settle();
    // The classic post picker: the pages, then one page's posts.
    await cancel(() => sandbox.adsStudioLoadPostPages());
    assert.deepEqual(JSON.parse(run('JSON.stringify([_adsStudioPostPicker.pagesState, _adsStudioPostPicker.pagesError, _adsStudioPostPicker.pagesFailedAt])')), ['', null, 0], 'before: failed');
    readsAgain(() => sandbox.adsStudioLoadPostPages(), '/api/studio/pages');
    await settle();
    run("_adsStudioPostPicker.pagesState = 'done'; _adsStudioPostPicker.pages = [{ id: 'p1', name: 'Shop', fb: true, ig: false }]; _adsStudioPostPicker.pageId = 'p1';");
    await cancel(() => sandbox.adsStudioLoadPagePosts('p1'));
    assert.equal(run("_adsStudioPostPicker.posts.p1"), undefined, 'before: "(The operation was aborted.)"');
    readsAgain(() => sandbox.adsStudioLoadPostPages(), '/api/studio/pages/p1/recent-posts');  // the next draw asks for the list again
    await settle();
    run("_adsStudioPostPicker.posts.p1 = { state: 'done', posts: [{ id: 'po1' }], checkedAt: '', platforms: {}, error: null, at: 1234 };");
    const kept = run('_adsStudioPostPicker.posts.p1');
    await cancel(() => sandbox.adsStudioLoadPagePosts('p1', true));
    assert.equal(run('_adsStudioPostPicker.posts.p1'), kept, 'Try again cancelled: the list shown before comes back');
    // A real failure (a timeout while the page stays, or a 500) still fails.
    mode = 'timeout';
    run("_adsStudioResults.byId.clear(); _adsStudioPostPicker.pagesState = ''; delete _adsStudioPostPicker.posts.p1;");
    await sandbox.adsStudioLoadResults('cmp_1');
    await sandbox.adsStudioLoadPostPages();
    assert.equal(run("_adsStudioResults.byId.get('cmp_1').state"), 'failed');
    assert.equal(run('_adsStudioPostPicker.pagesState'), 'failed');
    mode = '500';
    await sandbox.studioWalletLoadMethods();
    await sandbox.adsStudioLoadPagePosts('p1');
    assert.equal(run('_studioWallet.methodsFailed'), true);
    assert.equal(run('_adsStudioPostPicker.posts.p1.state'), 'failed');
  });

  // ---- Review loop R5, studio v2 second pass. The lazy studio.js sources on top of the startup files, signed in
  // as a customer with the plan, with a fake browser history wired to the real router (setupUrlRouting; history.go
  // moves on a timer, as in a browser), queued timers and render() drawing the studio view. me: the /me reply
  // already known (the new studio), or null for a read still to come.
  const studioV2Me = { ui: 'v2', staffDesk: 'classic', isAdmin: false, isStaff: false, services: { help: true, stopRequest: true, tiktok: false }, intake: { open: true }, contact: {}, serviceHours: {} };
  function studioRouterFixture(me = studioV2Me) {
    const fixture = loadBrowserSource();
    const { sandbox, state, run } = fixture;
    Object.assign(sandbox, { URLSearchParams, URL, AbortController });
    sandbox.window.URLSearchParams = URLSearchParams;
    sandbox.performance = sandbox.window.performance = { getEntriesByType: () => [{ type: 'navigate', name: 'http://localhost/ads-studio' }], now: () => 0 };
    let timers = [];
    let seq = 0;
    sandbox.setTimeout = sandbox.window.setTimeout = (fn, ms) => { seq += 1; timers.push({ id: seq, fn, ms: Number(ms) || 0 }); return seq; };
    sandbox.clearTimeout = sandbox.window.clearTimeout = id => { timers = timers.filter(timer => timer.id !== id); };
    const location = sandbox.window.location;
    const entries = [{ state: { view: 'ads-studio' }, url: '/ads-studio?tab=home' }];
    let index = 0;
    const apply = url => { const next = new URL(url, 'http://localhost'); location.pathname = next.pathname; location.search = next.search; location.href = next.href; };
    apply(entries[0].url);
    const listeners = [];
    sandbox.window.addEventListener = (type, fn, capture) => { if (type === 'popstate') listeners.push({ fn, capture: !!capture }); };
    const pop = () => [...listeners.filter(l => l.capture), ...listeners.filter(l => !l.capture)].forEach(l => l.fn({ state: entries[index].state }));
    sandbox.window.history = {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      pushState(value, _title, url) { entries.splice(index + 1); entries.push({ state: value, url: url || entries[index].url }); index += 1; apply(entries[index].url); },
      replaceState(value, _title, url) { entries[index] = { state: value, url: url || entries[index].url }; apply(entries[index].url); },
      go(delta) { const to = Math.max(0, Math.min(entries.length - 1, index + Number(delta || 0))); if (to !== index) { index = to; apply(entries[index].url); sandbox.setTimeout(pop, 0); } },
      back() { this.go(-1); }
    };
    sandbox.history = sandbox.window.history;
    let html = '';
    // The builder asks the document whether its screen is drawn already (studioBuilderEntering).
    sandbox.document.querySelector = selector => {
      const m = /^\[data-testid="([^"]+)"\]$/.exec(selector);
      return m && html.includes(`data-testid="${m[1]}"`) ? { getAttribute: () => null } : null;
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    for (const file of manifest.lazy['studio.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    run('Security').escapeHtml = plainEscape;
    state.currentUser = { id: 'cust1', name: 'Customer One', role: 'Employee', permissions: { adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn', 'deleteOwn', 'stopOwn'] }, subscriptions: ['ad_maker'] };
    state.users = [state.currentUser];
    state.currentView = 'ads-studio';
    state.adCampaignRequests = [];
    state.walletTransactions = [];
    state.serviceSubscriptions = [{ id: 'sub1', userId: 'cust1', serviceId: 'ad_maker', status: 'active', expiresAt: new Date(Date.now() + 20 * 86400000).toISOString() }];
    state.serverMode = true;
    sandbox.isServerModeEnabled = () => true;
    run('hasSubscription = () => true');
    sandbox.refreshAdsStudioLimits = () => {};
    sandbox.render = () => {
      html = state.currentView === 'ads-studio' ? String(run('renderAdsStudioView()')) : '';
      run(`_lastRenderedView = ${JSON.stringify(state.currentView)}`);
    };
    sandbox.forceFullRender = sandbox.render;
    const calls = [];
    const replies = Object.create(null);
    sandbox.apiJson = async (url, options = {}) => {
      calls.push(`${String(options.method || 'GET')} ${url}`);
      const reply = replies[url];
      if (typeof reply === 'function') return reply(options);
      if (reply !== undefined) return JSON.parse(JSON.stringify(reply));
      throw Object.assign(new Error(`Unexpected call ${url}`), { status: 404 });
    };
    replies['/api/studio/wallet/summary'] = { usd: { availableMinor: 100000, reservedMinor: 0 }, pendingPayments: [] };
    replies['/api/studio/campaigns/summary'] = {};
    replies['/api/studio/ad-options'] = { goals: [], locations: [{ key: 'libya', labelEn: 'All of Libya', labelAr: 'كل ليبيا' }] };
    replies['/api/studio/pages'] = { pages: [] };
    // The builder's saves and its send, as the server answers them.
    let saved = null;
    sandbox.apiCreateEntity = async (_collection, data) => { saved = { ...data, status: 'Draft', createdBy: 'cust1', _lastModified: 1000 }; return { id: data.id, data: saved, lastModified: 1000 }; };
    sandbox.apiPatchEntity = async (_collection, id, changes, base) => { saved = { ...saved, ...changes, _lastModified: base + 1 }; return { id, data: saved, lastModified: base + 1 }; };
    sandbox.apiSubmitAdCampaignRequest = async (id, expected) => { saved = { ...saved, status: 'Submitted', totalBudgetMinorUSD: 5000, _lastModified: expected + 1 }; return { id, data: saved, lastModified: expected + 1 }; };
    run('setupUrlRouting()');
    if (me) {
      replies['/api/studio/me'] = me;
      run(`_studioMe.forUser = 'cust1'; _studioMe.value = studioCleanMe(${JSON.stringify(me)}); _studioMe.loadedAt = Date.now();`);
    }
    // Runs the timers due now (and those they start), letting the promises settle between rounds.
    const flush = async () => {
      for (let round = 0; round < 20; round++) {
        for (let i = 0; i < 4; i++) await settle();
        const due = timers.filter(timer => timer.ms <= 0);
        if (!due.length) return;
        timers = timers.filter(timer => timer.ms > 0);
        due.forEach(timer => timer.fn());
      }
    };
    const draw = () => { sandbox.render(); return html; };
    const later = ms => run(`Date.now = (n => () => n + ${Number(ms)})(Date.now())`);
    return { ...fixture, calls, replies, flush, draw, later, html: () => html, url: () => location.pathname + location.search };
  }

  await test('R5 studio-v2-second-pass-1: a failed or slow first /me never swaps the classic wizard, and the text and photo typed in it, for the new studio mid-task; an idle classic screen or an empty wizard still switches, and the next visit opens the new studio', async () => {
    for (const how of ['failed', 'slow', 'idle', 'empty']) {
      const f = studioRouterFixture(null);
      const { sandbox, state, run } = f;
      let release = null;
      let answer = null;
      if (how === 'slow') {
        sandbox.window.localStorage.setItem('albayan.studio.v2.layout.cust1', 'customer');  // the last visit was the new studio
        f.replies['/api/studio/me'] = () => new Promise(resolve => { release = resolve; });
      } else {
        f.replies['/api/studio/me'] = () => (answer ? Promise.resolve(answer) : Promise.reject(new TypeError('Failed to fetch')));
      }
      f.draw(); await f.flush(); f.draw();
      if (how === 'slow') {
        assert.ok(f.html().includes('data-testid="studio-v2-loading"'), 'a known new-studio customer waits for /me a moment');
        f.later(3200);  // longer than the wait: the classic screens
        f.draw();
      }
      assert.ok(!f.html().includes('studio-v2-frame') && !f.html().includes('studio-v2-loading'), `${how}: the classic screens`);
      let draft = null;
      if (how !== 'idle') {
        run("setAdsStudioTab('builder')");  // Create Campaign (a ?tab=builder link opens the same empty draft)
        if (how !== 'empty') run("adsStudioSetDraftField('primaryText', 'Our new menu, delivery all over Tripoli'); _adsStudioDraft.creativeImages = ['data:image/jpeg;base64,/9j/4AAQ'];");
        draft = run('_adsStudioDraft');
        assert.ok(f.draw().includes('id="ads-studio-wizard-step"'), 'the classic wizard');
      }
      // The line recovers and /me says the new studio: the slow read answers, a failed one is read again a minute later.
      if (how === 'slow') { release(studioV2Me); f.replies['/api/studio/me'] = studioV2Me; } else { answer = studioV2Me; f.later(61000); f.draw(); }
      await f.flush(); f.draw();
      if (how === 'idle' || how === 'empty') {
        // Nothing of the customer's is on screen (an idle classic screen, or a wizard with nothing typed in it):
        // the new studio comes as soon as /me answers.
        assert.ok(f.html().includes('data-testid="studio-v2-frame"'), `${how}: the new studio comes when /me answers`);
        if (how === 'empty') assert.ok(f.html().includes('data-testid="studio-builder"'), 'on its own request builder');
        continue;
      }
      assert.equal(run('_adsStudioDraft'), draft, `${how}: before, the new studio's builder replaced the classic draft`);
      assert.equal(draft.primaryText, 'Our new menu, delivery all over Tripoli');
      assert.equal(draft.creativeImages.length, 1);
      assert.ok(f.html().includes('id="ads-studio-wizard-step"') && !f.html().includes('studio-v2-frame'), `${how}: before, the screen switched to the new studio under the customer`);
      // The next /me read (every 5 minutes) changes nothing for this visit either.
      f.later(6 * 60000); f.draw(); await f.flush(); f.draw();
      assert.ok(f.html().includes('id="ads-studio-wizard-step"') && run('_adsStudioDraft') === draft, `${how}: the re-read kept the classic wizard`);
      // Leaving the studio and coming back: the new studio (and the next page load starts there too).
      state.currentView = 'customers'; f.draw();
      state.currentView = 'ads-studio';
      sandbox.window.history.replaceState({ view: 'ads-studio' }, '', '/ads-studio?tab=dashboard');
      f.draw(); await f.flush();
      assert.ok(f.draw().includes('data-testid="studio-v2-frame"'), `${how}: the next visit opens the new studio`);
      assert.equal(sandbox.window.localStorage.getItem('albayan.studio.v2.layout.cust1'), 'customer');
    }
  });

  await test('R5 studio-v2-second-pass-2: the builder reads the linked pages and their posts again (a page linked or a post published later shows up), keeps the list on screen meanwhile, and offers Refresh', async () => {
    const f = studioRouterFixture();
    const { run } = f;
    const reads = url => f.calls.filter(call => call === `GET ${url}`).length;
    const page = (id, name) => ({ id, name, hasFacebook: true, hasInstagram: false, healthy: true });
    const post = (id, text) => ({ id, platform: 'fb', excerpt: text, imageUrl: '', permalink: `https://www.facebook.com/123/posts/${id.split('_')[1]}`, createdAt: '2026-09-28T10:00:00Z' });
    const posts = list => ({ pageId: 'spg_1', posts: list, checkedAt: '2026-09-28T10:00:00Z', platforms: { fb: { state: 'ok' } } });
    f.draw();
    // (a) Nothing is linked yet: the page picker (a full request) and "Promote a post" say so, with Refresh.
    run("studioHomeGoal('messages')"); await f.flush();
    assert.equal(run('studioBuilderNext()'), true);
    await f.flush();
    assert.ok(f.draw().includes('No page is linked to your account yet. Write the page name'), f.html());
    assert.ok(f.html().includes('data-testid="studio-builder-pages-refresh" onclick="studioBuilderRetryPages()"'), 'before: no Refresh in the page picker');
    run("studioHomeGoal('promote')"); await f.flush();
    assert.ok(f.draw().includes('No page is linked to your account yet, so paste the link'), f.html());
    assert.ok(f.html().includes('data-testid="studio-builder-pages-refresh" onclick="studioBuilderRetryPages()"'), 'before: no Refresh under "No page is linked"');
    // The team links the page; 6 minutes later a new request reads the pages again and lists the page's posts.
    f.replies['/api/studio/pages'] = { pages: [page('spg_1', 'My Shop')] };
    f.replies['/api/studio/pages/spg_1/recent-posts'] = posts([post('123_1', 'Old post')]);
    run('studioBuilderDone()'); await f.flush();
    f.later(6 * 60000);
    run("studioHomeGoal('promote')"); await f.flush();
    assert.equal(run('_studioBuilder.pages.list.length'), 1, 'before: the builder kept the empty list of its first read');
    assert.ok(!f.draw().includes('No page is linked') && f.html().includes('data-testid="studio-builder-post-0"') && f.html().includes('Old post'), f.html());
    assert.ok(f.html().includes('data-testid="studio-builder-posts-refresh" onclick="studioBuilderRetryPosts()"'), 'before: no Refresh under a loaded post list');
    // (b) 11 minutes on, a new post and a second page: both lists are old and read again (the posts without
    // ?refresh=1, so the server's own 10-minute cache decides), the old ones staying on screen meanwhile.
    f.replies['/api/studio/pages'] = { pages: [page('spg_1', 'My Shop'), page('spg_2', 'Second Shop')] };
    f.replies['/api/studio/pages/spg_1/recent-posts'] = posts([post('123_2', 'NEW Eid offer'), post('123_1', 'Old post')]);
    const before = { pages: reads('/api/studio/pages'), posts: reads('/api/studio/pages/spg_1/recent-posts') };
    f.later(11 * 60000);
    const waiting = f.draw();
    assert.ok(waiting.includes('Old post') && !waiting.includes('Loading your recent posts') && !waiting.includes('Loading your linked pages'), waiting);
    await f.flush();
    assert.equal(reads('/api/studio/pages') - before.pages, 1, 'before: the pages were never read again');
    assert.equal(reads('/api/studio/pages/spg_1/recent-posts') - before.posts, 1, 'before: the posts were never read again');
    assert.ok(f.draw().includes('NEW Eid offer') && f.html().includes('Second Shop'), 'before: the new post and the second page never appeared');
    // A re-read the app cancels (it moved on, R3 studio-client-5) keeps the posts on screen while they are asked again.
    let cancelled = false;
    let second = null;
    f.replies['/api/studio/pages/spg_1/recent-posts'] = () => {
      if (cancelled) return new Promise(resolve => { second = resolve; });
      cancelled = true;
      f.sandbox.cancelPendingRequests();
      return Promise.reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    };
    f.later(11 * 60000);
    f.draw(); await f.flush();
    assert.ok(cancelled && typeof second === 'function', 'the cancelled re-read is asked again');
    assert.ok(f.draw().includes('NEW Eid offer') && !f.html().includes('Loading your recent posts'), 'a cancelled re-read blanked the post list');
    second(posts([post('123_2', 'NEW Eid offer'), post('123_1', 'Old post')]));
    await f.flush();
    // (c) Refresh reads the pages at once; the picker keeps its list until the answer.
    let release = null;
    f.replies['/api/studio/pages'] = () => new Promise(resolve => { release = resolve; });
    run('studioBuilderRetryPages()');
    assert.equal(typeof release, 'function', 'Refresh reads the pages');
    assert.ok(f.draw().includes('NEW Eid offer') && f.html().includes('Second Shop') && !f.html().includes('Loading your linked pages'), 'Refresh blanked the picker');
    release({ pages: [page('spg_1', 'My Shop')] });
    await f.flush();
    assert.ok(!f.draw().includes('Second Shop') && f.html().includes('NEW Eid offer'), f.html());
  });

  await test('R5 studio-v2-second-pass-3: after "Send request" one Back (the header arrow and the phone\'s Back, or the browser\'s own) goes Home, never through the old steps showing "Sent for review" again', async () => {
    for (const goal of ['messages', 'promote']) {
      for (const how of ['app', 'browser']) {
        const f = studioRouterFixture();
        const { sandbox, run } = f;
        const kind = goal === 'promote' ? 'boost' : 'full';
        const steps = kind === 'boost' ? 3 : 6;
        f.draw();
        run(`studioHomeGoal('${goal}')`); await f.flush();
        run("Object.assign(_studioBuilder.session.draft, { pageName: 'My shop', primaryText: 'Offer', creativeImages: ['data:image/png;base64,iVBORw0KGgo='], destination: 'https://example.com', sourcePostRef: 'https://www.facebook.com/123/posts/456', budgetMinorUSD: 5000 });");
        for (let step = 1; step < steps; step++) {
          assert.equal(run('studioBuilderNext()'), true, `${goal}: Next on step ${step}`);
          await f.flush();
        }
        run('_studioBuilder.session.rights = true;');
        assert.equal(await run('studioBuilderSend(null)'), true, `${goal}: sent`);
        await f.flush();
        assert.ok(f.draw().includes('data-testid="studio-builder-sent"'), 'Sent for review');
        assert.equal(f.url(), `/ads-studio?tab=builder&section=${kind}&step=${steps}`);
        if (how === 'app') assert.equal(run('studioHandleBack()'), true);  // the phone's Back; the header arrow is studioV2Back
        else sandbox.window.history.go(-1);  // the browser's own Back: one entry
        await f.flush();
        assert.equal(f.url(), '/ads-studio?tab=home', `${goal}, ${how} Back: before, it showed "Sent for review" again on step ${steps - 1}`);
        assert.ok(f.draw().includes('data-testid="studio-home"') && !f.html().includes('studio-builder-sent'), f.html());
        assert.equal(run('studioHandleBack()'), false, 'on Home the app\'s own Back runs next');
      }
    }
  });

  // ---- r8 O: misc (retries across an account switch, per-user filters, a dead IndexedDB connection) ----
  // Account A signs out and B signs in on the same tab (what _handleLogoutOnce + a login do to the identity).
  const switchAccount = (run, state) => {
    run('advanceServerSessionEpoch()');
    state.currentUser = { id: 'userB', name: 'B', role: 'Employee', permissions: {} };
  };

  await test('r8 O n=19: a plan purchase retried after a sign-out and a sign-in as someone else is never sent as the new account', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.currentUser = { id: 'userA', role: 'Employee', permissions: {} };
    sandbox.setTimeout = fn => { Promise.resolve().then(fn); return 1; };  // the retry back-off passes at once
    const sent = [];
    sandbox.apiJson = async path => {
      sent.push(`${path}@${state.currentUser?.id}`);
      if (sent.length === 1) {
        switchAccount(run, state);  // while the first attempt times out
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return { subscriptions: [] };
    };
    await assert.rejects(sandbox.apiPurchasePlan({ planId: 'p1', idempotencyKey: 'idem_12345678', expectedPriceMinor: 100 }),
      error => error?.code === 'SERVER_SESSION_CHANGED');
    assert.deepEqual(sent, ['/api/subscriptions/purchase-plan@userA'], 'the retry must not charge the new account');
    // The same account keeps its retries.
    sent.length = 0;
    let failures = 1;
    sandbox.apiJson = async path => { sent.push(path); if (failures-- > 0) throw new TypeError('Failed to fetch'); return { subscriptions: [] }; };
    await sandbox.apiPurchasePlan({ planId: 'p1', idempotencyKey: 'idem_12345678', expectedPriceMinor: 100 });
    assert.equal(sent.length, 2);
  });

  await test('r8 O n=19: an edit queued behind a slow save is dropped, not sent, once the account changed', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.isServerModeEnabled = () => true;
    state.customers = [{ id: 'c1', name: 'Customer', _lastModified: 1 }];
    const sent = [];
    let finishFirst;
    sandbox.apiPatchEntity = (collection, id, updates) => {
      sent.push(`${updates.name}@${state.currentUser?.id}`);
      if (sent.length > 1) return Promise.resolve({ id, data: { id, name: updates.name, _lastModified: 3 }, lastModified: 3 });
      return new Promise(resolve => { finishFirst = resolve; });
    };
    const first = run("updateRecord(state.customers, 'c1', { name: 'One' })");
    const second = run("updateRecord(state.customers, 'c1', { name: 'Two' })");
    await settle();
    switchAccount(run, state);
    finishFirst({ id: 'c1', data: { id: 'c1', name: 'One', _lastModified: 2 }, lastModified: 2 });
    await first;
    assert.equal(await second, false);
    assert.deepEqual(sent, ['One@admin'], 'the queued edit must not go out as the next account');
  });

  const setPerUserFilters = state => Object.assign(state, {
    customerSearch: '0912345678', receiptRecordFilter: 'receipt_of_a', adReceiptFilter: 'receipt_of_a',
    adFilters: { status: 'all', payment: 'all', page: 'page_of_a' }, deliveryFilter: { search: 'Ali' }, auditUserFilter: 'userA'
  });
  const assertFiltersCleared = (state, where) => {
    assert.equal(state.customerSearch, '', `${where}: typed search`);
    assert.equal(state.receiptRecordFilter, '', `${where}: receipt record filter`);
    assert.equal(state.adReceiptFilter, '', `${where}: ad receipt filter`);
    assert.equal(state.adFilters.page, 'all', `${where}: ad page filter`);
    assert.equal(state.deliveryFilter.search, undefined, `${where}: delivery search`);
    assert.equal(state.auditUserFilter, 'all', `${where}: audit user filter`);
  };

  await test('r8 O n=20: sign-out clears the record filters, and a sign-in over a stale snapshot clears every per-user filter', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    setPerUserFilters(state);
    sandbox.closeSensitiveAuthenticatedUi();
    assertFiltersCleared(state, 'sign-out');
    // The old session expired with no sign-out: the saved snapshot still carries A's filters.
    setPerUserFilters(state);
    state.currentUser = null;
    sandbox.serverLoadAllData = async () => ({ failed: [] });
    sandbox.startServerLiveSync = () => {};
    run('Security.escapeHtml = s => String(s ?? "")');  // the fake document cannot escape
    await run("_activateServerSession({ id: 'userB', name: 'B', role: 'Employee', permissions: {} }, _loginGeneration)");
    assert.equal(state.currentUser.id, 'userB');
    assertFiltersCleared(state, 'sign-in');
  });

  await test('r8 O n=21: local mode recovers from a dead IndexedDB connection instead of retrying it forever', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    state.serverMode = false;
    sandbox.console = { ...sandbox.console, error() {}, warn() {} };  // the dead connection is logged on purpose
    const deadConnection = () => { throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' }); };
    sandbox.idbGet = async () => deadConnection();
    const reopened = [];
    sandbox.initIndexedDB = onLateOpen => { reopened.push(typeof onLateOpen); return Promise.resolve(null); };
    const snapshots = [];
    sandbox.saveState = () => snapshots.push(run('db'));
    run('db = {}');
    // Every other caller still gets a plain false (sign-out wipe, live sync, start-up load).
    assert.equal(await sandbox.saveCollectionToIndexedDB('ads', []), false);
    run("markCollectionDirty('ads')");
    await sandbox.flushDirtyCollections();
    assert.equal(run('db'), null, 'the dead handle is dropped');
    assert.deepEqual(snapshots, [null], 'the snapshot is saved with the collections kept in it');
    assert.deepEqual(reopened, ['function'], 'the connection is reopened');
    // A refusal that is not a dead connection keeps the usual retry.
    run('db = {}; _idbConnectionLost = false');
    sandbox.idbGet = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    run("markCollectionDirty('ads')");
    await sandbox.flushDirtyCollections();
    assert.notEqual(run('db'), null);
    assert.ok(run("idbSync.dirty.has('ads')"));
    assert.equal(reopened.length, 1);
  });

  // ---- r9 M (company-covered receipt money) ----
  await test('r9 M n=4: lowering a receipt below its company coverage reads the refusal in Arabic', async () => {
    const { sandbox, state } = loadBrowserSource();
    const message = 'The company already covered $30.00 of this receipt; its amount cannot go below that';
    state.language = 'ar';
    assert.ok(!/[A-Za-z]{3,}/.test(sandbox._serverRefusalText(message)), sandbox._serverRefusalText(message));
    state.language = 'en';
    assert.equal(sandbox._serverRefusalText(message), message);
  });

  // ---- r9 M review corrections ----
  await test('r9 M: the partly-covered receipt refusal reads in Arabic', async () => {
    const { sandbox, state } = loadBrowserSource();
    const message = "This receipt is partly covered by the company: record the full receipt amount or the customer's net cash";
    state.language = 'ar';
    assert.ok(!/[A-Za-z]{3,}/.test(sandbox._serverRefusalText(message)), sandbox._serverRefusalText(message));
    state.language = 'en';
    assert.equal(sandbox._serverRefusalText(message), message);
  });
  // ---- Review loop r9, batch A: server refusals said in Arabic (Clothes saves, the Meta Sync import line, the ad merge) ----
  // True when no English word is left once the brand names are taken out.
  const r9NoEnglish = text => !/[A-Za-z]{3,}/.test(String(text).replace(/Albayan|Studio|Meta|access token/g, ''));
  await test('r9 A n=6: Clothes product, stock, shipment and delete refusals from the generic save path are said in Arabic, without the product id', async () => {
    const refuse = (message, status) => async () => { throw Object.assign(new Error(message), { status }); };
    const clothesArabic = () => {
      const fixture = clothesFixture();
      const { sandbox, state } = fixture;
      state.language = 'ar';
      state.clothesProducts = [{ id: 'p1', name: 'قميص', createdBy: 'admin', _lastModified: 100, variants: [{ color: 'Blck', size: 'M', qty: 2 }] }];
      state.clothesShipments = [{ id: 's1', ref: 'S-1', status: 'Received', lines: [], createdBy: 'admin', _lastModified: 50 }];
      sandbox.isServerModeEnabled = () => true;
      sandbox.updateClothesProductsFiltered = () => {};
      sandbox.apiGetEntity = refuse('offline', 0);
      return fixture;
    };
    // 1. Renaming a colour that a shipment received: the rule-refusal (409) branch of updateRecord.
    {
      const { sandbox, state, notes } = clothesArabic();
      sandbox.apiPatchEntity = refuse('A referenced product variant cannot be removed', 409);
      assert.equal(await sandbox.updateRecord(state.clothesProducts, 'p1', { variants: [{ color: 'Black', size: 'M', qty: 2 }] }, 100), false);
      const note = notes.at(-1);
      assert.ok(/اللون\/المقاس مستخدم/.test(note.message) && r9NoEnglish(note.message), `before: raw English - ${note.message}`);
      assert.equal(state.clothesProducts[0].variants[0].color, 'Blck', 'the refused rename is rolled back');
    }
    // 2. A stock +/- tap after the subscription lapsed (403, the generic failure toast).
    {
      const { sandbox, state, notes } = clothesArabic();
      sandbox.apiPatchEntity = refuse('An active clothes_system subscription is required', 403);
      await sandbox.adjustClothesVariantQty('p1', 'Blck', 'M', 1);
      await settle();
      const note = notes.at(-1);
      assert.ok(/اشتراك نظام الملابس/.test(note.message) && r9NoEnglish(note.message), `before: raw English - ${note.message}`);
    }
    // 3. A new shipment whose product was deleted on another device: no internal id, and it says deleted.
    {
      const { sandbox, state, notes } = clothesArabic();
      state.clothesProducts = [];
      sandbox.apiCreateEntity = refuse('Shipment product is missing: prod_abc123', 409);
      assert.equal(await sandbox.addRecord(state.clothesShipments, { ref: 'S-2', status: 'Ordered', lines: [{ productId: 'prod_abc123', qty: 1 }] }), false);
      const note = notes.at(-1);
      assert.ok(!note.message.includes('prod_abc123') && /محذوف/.test(note.message) && r9NoEnglish(note.message), `before: raw English with the id - ${note.message}`);
    }
    // 4. Editing a shipment another device received, and deleting a product that orders use.
    {
      const { sandbox, state, notes } = clothesArabic();
      sandbox.apiPatchEntity = refuse('A received shipment cannot be edited', 409);
      await sandbox.updateRecord(state.clothesShipments, 's1', { note: 'x' }, 50);
      assert.ok(/شحنة مستلمة/.test(notes.at(-1).message) && r9NoEnglish(notes.at(-1).message), notes.at(-1).message);
      sandbox.apiDeleteEntity = refuse('A referenced product cannot be deleted', 409);
      assert.equal(await sandbox.deleteRecord(state.clothesProducts, 'p1'), false);
      assert.ok(/المنتج مستخدم/.test(notes.at(-1).message) && r9NoEnglish(notes.at(-1).message), notes.at(-1).message);
    }
    // English keeps a readable sentence; other collections keep the shared map (unchanged).
    {
      const { sandbox, state, notes } = clothesArabic();
      state.language = 'en';
      sandbox.apiPatchEntity = refuse('A referenced product variant cannot be removed', 409);
      await sandbox.updateRecord(state.clothesProducts, 'p1', { variants: [] }, 100);
      assert.ok(/cannot be removed or renamed; add a new color\/size instead/.test(notes.at(-1).message), notes.at(-1).message);
      state.language = 'ar';
      assert.equal(sandbox._collectionRefusalText('ads', 'Financial period 2026-08 is closed. An Admin must unlock it before editing.'),
        'الشهر 2026-08 مُقفل مالياً؛ اطلب من المدير فتحه قبل التعديل.');
    }
  });
  await test('r9 A n=7: the Meta Sync import-status line is Arabic in the Arabic dialog; the server words stay in its tooltip', async () => {
    const cases = [
      ['One Meta ad could not be imported. Albayan will retry.', /تعذّر استيراد إعلان Meta واحد\. سيحاول Albayan/],
      ["Albayan is waiting to read a new ad's Meta campaign name before importing it.", /اسم حملة Meta/],
      ['Meta authorization failed. Reconnect the access token.', /أعد ربط رمز الدخول/],
      ['Meta returned an invalid response.', /حدثت مشكلة أثناء فحص إعلانات Meta\.$/]
    ];
    for (const language of ['ar', 'en']) {
      for (const [raw, arabic] of cases) {
        const fixture = metaToolsFixture();
        const { sandbox, state, run } = fixture;
        const nodes = metaDialogDom(fixture);
        state.language = language;
        run(`metaAdsUi.open = true; metaAdsUi.loading = false; metaAdsUi.error = ''; metaAdsUi.status = ${JSON.stringify({ configured: true, autoImport: true, importState: { lastError: raw } })};`);
        sandbox.metaAdsRenderModal();
        const html = nodes.get('meta-ads-modal').innerHTML;
        const line = html.match(/text-rose-600 dark:text-rose-300"(?: title="([^"]*)")?>([^<]*)</);
        assert.ok(line, 'the import-status line is drawn');
        if (language === 'en') {
          assert.equal(line[2], raw);
        } else {
          assert.ok(arabic.test(line[2]) && r9NoEnglish(line[2]), `before: raw English - ${line[2]}`);
          assert.ok(!html.replace(/<[^>]*>/g, ' ').includes(raw), 'no raw English sentence is visible in the Arabic dialog');
        }
        assert.equal(line[1], raw, 'the server words stay in the tooltip');
      }
    }
  });
  await test('r9 A n=8: the ad merge says a closed month, a version conflict and a Studio claim in Arabic, and still restores the draft link', async () => {
    const mergeFails = async (error, { language = 'ar', metaTools = false } = {}) => {
      const fixture = metaTools ? metaToolsFixture() : loadBrowserSource();
      const { sandbox, state, run } = fixture;
      run(fs.readFileSync(path.join(__dirname, '..', 'src', '13b-merge-tools.js'), 'utf8'));
      state.language = language;
      const keepAd = { id: 'keep', _lastModified: 5 };
      const draftAd = { id: 'draft', metaAdId: '123456789', _lastModified: 6 };
      state.ads = [keepAd, draftAd];
      sandbox.isMergeToolsAdmin = () => true;
      sandbox.getAdMergePlan = () => ({ keepAd, draftAd, metaAdId: '123456789', blocked: '' });
      sandbox.applyValidatedServerEntityBatch = () => {};
      sandbox.apiUnlinkMetaAd = async () => ({ ad: { ...draftAd, metaAdId: '' } });
      const links = [];
      sandbox.apiLinkMetaAd = async adId => { links.push(adId); if (adId === 'keep') throw error; return { ad: draftAd }; };
      const notes = [];
      sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
      await sandbox.runAdMerge('keep', 'draft');
      assert.deepEqual(links, ['keep', 'draft'], 'the draft gets its Meta link back');
      const failed = notes.filter(note => note.type === 'error');
      assert.equal(failed.length, 1);
      return failed[0].message;
    };
    const closed = 'Financial period 2026-08 is closed. An Admin must unlock it before editing.';
    const closedAr = await mergeFails(Object.assign(new Error(closed), { status: 423 }));
    assert.ok(/مُقفل مالياً/.test(closedAr) && closedAr.includes('2026-08') && r9NoEnglish(closedAr), `before: raw English - ${closedAr}`);
    const conflictAr = await mergeFails(Object.assign(new Error('Conflict: ad has changed'), { status: 409 }));
    assert.ok(/تغيّر الإعلان أثناء الدمج/.test(conflictAr) && r9NoEnglish(conflictAr), `before: raw English - ${conflictAr}`);
    const studio = 'This Meta ad belongs to Albayan Studio (a studio request linked its campaign). It cannot be linked to an Albayan Manager ad.';
    const studioAr = await mergeFails(Object.assign(new Error(studio), { status: 409 }), { metaTools: true });
    assert.ok(/تابع لـ Albayan Studio/.test(studioAr) && r9NoEnglish(studioAr), `before: raw English - ${studioAr}`);
    // English keeps the server's sentence; a conflict gets the merge wording in both languages.
    assert.equal(await mergeFails(Object.assign(new Error(closed), { status: 423 }), { language: 'en' }), closed);
    assert.equal(await mergeFails(Object.assign(new Error('Conflict: ad has changed'), { status: 409 }), { language: 'en' }),
      'The ad changed during the merge. Refresh and try again.');
  });

  // ---- Bug-hunt R1, client-a: customer contacts, ad page switch, stale saves, receipt history, ?modal entries, phone search ----
  await test('R1 data-plane-1: staff without viewContacts edit a customer with no phone box, and the save sends no phones or links', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.URLSearchParams = URLSearchParams;
    run("Security.escapeHtml = s => String(s ?? '')");
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    const drawn = () => { made.length = 0; sandbox.renderModal(); return made.map(el => String(el.innerHTML || '')).join('\n'); };
    // The row exactly as the server serves it to this clerk: every contact field removed.
    const projected = { id: 'cust_1', name: 'Hidden', platform: 'Facebook', createdBy: 'admin', _lastModified: 1000 };
    state.currentUser = { id: 'clerk', role: 'Employee', permissions: { customers: ['view', 'add', 'edit'] } };
    state.users = [state.currentUser];
    state.customers = [projected];
    state.activeModal = 'customer';
    state.modalData = projected;
    let html = drawn();
    assert.ok(html.includes('id="customer-name"'), 'the edit form is drawn');
    assert.ok(!html.includes('customer-phone') && !html.includes('customer-link'), 'before: an empty required phone box replaced every stored number');
    assert.ok(html.includes('Contact details are hidden for your role'), html.slice(0, 300));
    const fields = { 'modal-form': {}, 'customer-name': { value: 'Hidden (fixed)' }, 'customer-platform': { value: 'Facebook' }, 'customer-joindate': { value: '2026-09-01' } };
    sandbox.document.getElementById = id => fields[id] || null;
    sandbox.document.querySelectorAll = () => [];
    const sent = [];
    sandbox.updateRecord = async (array, id, updates, expected) => { sent.push({ id, updates: JSON.parse(JSON.stringify(updates)), expected }); return true; };
    const notes = [];
    sandbox.showNotification = (title, message) => notes.push(message);
    await sandbox.handleModalSubmit();
    assert.equal(sent.length, 1, `before: ${notes.join(' | ')}`);
    assert.equal(sent[0].id, 'cust_1');
    assert.equal(sent[0].expected, 1000);
    assert.equal(sent[0].updates.name, 'Hidden (fixed)');
    assert.ok(!('phones' in sent[0].updates) && !('profileLinks' in sent[0].updates), JSON.stringify(sent[0].updates));
    // Creating a customer still asks for a phone, and an editor who sees contacts keeps the boxes.
    assert.equal(state.activeModal, null, 'the saved form closed');
    sandbox.document.getElementById = () => null;
    state.activeModal = 'customer';
    state.modalData = null;
    assert.ok(drawn().includes('customer-phone'), 'the create form lost its phone box');
    state.currentUser.permissions = { customers: ['view', 'add', 'edit', 'viewContacts'] };
    state.modalData = { ...projected, phones: ['0912345678'] };
    html = drawn();
    assert.ok(html.includes('customer-phone') && !html.includes('Contact details are hidden'), 'a viewContacts editor lost the phone boxes');
  });

  await test('R1 forms-modals-1: switching the ad page clears a customer the new page does not have, and the receipt list follows', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    const els = new Map();
    for (const id of ['ad-page', 'ad-page-search', 'ad-customer-section', 'ad-customer-display', 'ad-customer-id', 'ad-customer-hint', 'ad-page-dropdown']) {
      els.set(id, { id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, classList: fakeClassList(), focus() {} });
    }
    sandbox.document.getElementById = id => els.get(id) || null;
    sandbox.renderAdFundingList = () => {};
    sandbox.clearAdMergeFunding = () => {};
    const refreshedFor = [];
    sandbox.refreshAdTempReceiptOptions = () => refreshedFor.push(els.get('ad-customer-id').value);
    state.customers = [{ id: 'custX', name: 'X' }, { id: 'custY', name: 'Y' }, { id: 'custZ', name: 'Z' }];
    state.pages = [
      { id: 'pageA', name: 'A', customerIds: ['custX'] },
      { id: 'pageB', name: 'B', customerIds: ['custY', 'custZ'] },
      { id: 'pageC', name: 'C', customerIds: ['custY'] }
    ];
    const customerId = () => els.get('ad-customer-id').value;
    sandbox.selectAdPage('pageA');
    assert.equal(customerId(), 'custX');
    refreshedFor.length = 0;
    sandbox.selectAdPage('pageB');
    assert.equal(customerId(), '', "before: page B kept page A's customer, so Save charged the wrong customer");
    assert.ok(!/bg-indigo-600 text-white/.test(els.get('ad-customer-display').innerHTML), 'no customer card is preselected');
    assert.deepEqual(refreshedFor, [''], 'the D#/unpaid receipt list follows the cleared customer');
    // A one-customer page switches X -> Y: the receipt list is rebuilt for Y.
    sandbox.selectAdPage('pageA');
    refreshedFor.length = 0;
    sandbox.selectAdPage('pageC');
    assert.equal(customerId(), 'custY');
    assert.deepEqual(refreshedFor, ['custY'], "before: the list still showed X's receipts");
    // A customer the new page also has stays chosen, with nothing to rebuild.
    refreshedFor.length = 0;
    sandbox.selectAdPage('pageB');
    assert.equal(customerId(), 'custY');
    assert.deepEqual(refreshedFor, []);
    // Editing keeps a saved customer the page no longer lists (edit init picks it right after).
    els.get('ad-customer-id').value = 'custX';
    refreshedFor.length = 0;
    sandbox.selectAdPage('pageB', true);
    sandbox.selectAdCustomer('custX', true);
    assert.equal(customerId(), 'custX');
    assert.deepEqual(refreshedFor, ['custX'], 'edit init refreshes once, through selectAdCustomer');
  });

  await test('R1 forms-modals-2: a slow save finishing after Cancel never closes the form opened next', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.URLSearchParams = URLSearchParams;
    run("Security.escapeHtml = s => String(s ?? '')");
    const els = new Map();
    const node = (id, value = '') => ({ id, value, isConnected: true, style: {}, dataset: {}, classList: fakeClassList(),
      setAttribute() {}, removeAttribute() {}, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      remove() { if (els.get(id) === this) els.delete(id); this.isConnected = false; } });
    sandbox.document.getElementById = id => els.get(id) || null;
    sandbox.document.querySelectorAll = sel => (sel === '#app-modal' ? [els.get('app-modal')].filter(Boolean) : (sel === '.customer-phone' ? [node('', '0912345678')] : []));
    const formIds = ['modal-form', 'customer-name', 'customer-platform', 'customer-joindate'];
    const openCustomerForm = () => {
      state.activeModal = 'customer';
      state.modalData = null;
      els.set('app-modal', node('app-modal'));
      for (const [id, value] of [['modal-form', ''], ['customer-name', 'New Customer'], ['customer-platform', 'Facebook'], ['customer-joindate', '2026-10-01']]) els.set(id, node(id, value));
    };
    let finish;
    sandbox.addRecord = () => new Promise(resolve => { finish = resolve; });
    openCustomerForm();
    const pending = sandbox.handleModalSubmit();
    // Cancel removes the dialog and the form inside it; then a receipt form opens with a photo.
    sandbox.closeModal();
    for (const id of formIds) els.get(id)?.remove();
    state.activeModal = 'receipt';
    state.modalData = null;
    state.tempReceiptPhotos = ['data:image/png;base64,AAAA'];
    const receiptDialog = node('app-modal');
    els.set('app-modal', receiptDialog);
    finish(true);
    await pending;
    assert.equal(state.activeModal, 'receipt', 'before: the old customer save closed the receipt form');
    assert.equal(els.get('app-modal'), receiptDialog, 'the receipt dialog is still on screen');
    assert.equal(state.tempReceiptPhotos.length, 1, 'the attached photo is kept');
    // Control: a save that finishes on its own form still closes it.
    state.tempReceiptPhotos = [];
    openCustomerForm();
    sandbox.addRecord = async () => true;
    await sandbox.handleModalSubmit();
    assert.equal(state.activeModal, null, 'a current save closes its own form');
    assert.ok(!els.get('app-modal'));
    // A save that changes the signed-in user's role (a self-edit) still closes its own form.
    openCustomerForm();
    sandbox.addRecord = async () => { state.currentUser = { ...state.currentUser, role: 'Employee', permissions: { customers: ['view'] } }; return true; };
    await sandbox.handleModalSubmit();
    assert.equal(state.activeModal, null, 'a role change during its own save left the form open');
  });

  await test('R1 forms-modals-2: a receipt create finishing after Cancel saves once and leaves the next receipt form alone', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    sandbox.URLSearchParams = URLSearchParams;
    run("Security.escapeHtml = s => String(s ?? '')");
    const els = new Map();
    const node = (id, value = '') => ({ id, value, checked: false, isConnected: true, innerHTML: '', textContent: '', style: {}, dataset: {},
      classList: fakeClassList(), setAttribute() {}, removeAttribute() {}, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      remove() { if (els.get(id) === this) els.delete(id); this.isConnected = false; } });
    let paymentRows = [];
    const formIds = ['receipt-editing-id', 'receipt-phone-search', 'receipt-customer-name', 'receipt-serial-error', 'receipt-save-btn', 'receipt-customer-id', 'receipt-status', 'paid-collection-value', 'receipt-serial'];
    const openReceiptForm = serial => {
      state.activeModal = 'receipt';
      state.modalData = null;
      els.set('app-modal', node('app-modal'));
      for (const id of formIds) els.set(id, node(id));
      els.get('receipt-customer-id').value = 'c1';
      els.get('receipt-status').value = 'Paid';
      els.get('paid-collection-value').value = 'office';
      els.get('receipt-serial').value = serial;
      const field = { '.payment-method': 'Cash (LYD)', '.payment-amount': '100', '.payment-rate1': '1', '.payment-rate2': '5', '.collection-type': 'office' };
      paymentRows = [{ querySelector: sel => (sel in field ? node('', field[sel]) : null) }];
    };
    sandbox.document.getElementById = id => els.get(id) || null;
    sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? paymentRows : (sel === '#app-modal' ? [els.get('app-modal')].filter(Boolean) : []));
    state.serverMode = true;
    sandbox.isServerModeEnabled = () => true;
    sandbox.markCollectionDirty = () => {};
    sandbox.addLog = () => {};
    sandbox.requireReceiptCustomerRiskAcknowledgement = () => false;
    state.customers = [{ id: 'c1', name: 'Customer One', phones: ['0911111111'] }];
    state.receipts = [];
    const creates = [];
    let finish;
    sandbox.apiCreateEntity = (_collection, data) => {
      creates.push(data.id);
      return new Promise(resolve => { finish = () => resolve({ data: { ...data, _lastModified: 1 } }); });
    };
    openReceiptForm('5551');
    const pending = sandbox.saveReceiptFromModal();
    // Cancel: the first form, its hidden editing-id field included, leaves the page.
    sandbox.closeModal();
    for (const id of formIds) els.get(id)?.remove();
    openReceiptForm('5552');
    state.tempReceiptPhotos = ['data:image/png;base64,AAAA'];
    const secondDialog = els.get('app-modal');
    finish();
    await pending;
    assert.equal(state.activeModal, 'receipt', 'before: the first save closed the second receipt form');
    assert.equal(els.get('app-modal'), secondDialog, 'the second dialog is still on screen');
    assert.equal(state.tempReceiptPhotos.length, 1, "the second form's photo is kept");
    assert.equal(creates.length, 1);
    assert.deepEqual(state.receipts.map(r => r.serialNumber), ['5551'], 'the first receipt is saved once');
    // Control: the second form's own save still closes it.
    sandbox.apiCreateEntity = async (_collection, data) => { creates.push(data.id); return { data: { ...data, _lastModified: 2 } }; };
    await sandbox.saveReceiptFromModal();
    assert.equal(state.activeModal, null, 'a current receipt save closes its own form');
    assert.equal(state.receipts.length, 2);
  });

  await test('R1 storage-integrity-2: a failed receipt save leaves no phantom history row, so a retried edit is recorded once and a refused one never', async () => {
    const plain = value => JSON.parse(JSON.stringify(value));
    const scenario = async (status, firstError, firstAmount, secondAmount) => {
      const { sandbox, state, run } = loadBrowserSource();
      sandbox.setTimeout = fn => setTimeout(fn, 0);
      sandbox.clearTimeout = id => clearTimeout(id);
      run('RenderQueue.schedule = () => {};');
      sandbox.isServerModeEnabled = () => true;
      state.serverMode = true;
      state.currentUser = { id: 'admin', name: 'Owner', role: 'Admin', permissions: {} };
      state.users = [state.currentUser];
      state.customers = [{ id: 'c1', name: 'Customer One', phones: ['0912345678'] }];
      const paid = status === 'Paid';
      const row = { method: 'Cash (LYD)', amount: 500, rate: 1, rate2: 5, collectionType: 'office', deliveryPersonId: '' };
      state.receipts = [{
        id: 'r1', recordType: 'receipt', customerId: 'c1', status, isPaid: paid, amountUSD: 100, amountLocal: 500, exchangeRate: 5,
        paymentMethod: 'Cash (LYD)', payments: paid ? [row] : [], plannedPayments: paid ? [] : [row],
        serialNumber: paid ? '123' : '', finalReceiptNo: paid ? '123' : '', deliveryStatus: 'Office', phoneNumber: '0912345678',
        statusDetail: paid ? { paidCollection: 'office' } : { notPaidCollection: 'office' }, createdAt: '2026-09-01T10:00:00.000Z', _lastModified: 1000,
        editHistory: [{ editedAt: '2026-09-02T10:00:00.000Z', editedBy: 'Owner', changes: [{ field: 'Phone Number', from: 'None', to: '0912345678' }] }],
        editCount: 1
      }];
      let amount = firstAmount;
      const value = v => ({ value: v, dataset: {}, classList: fakeClassList(), focus() {}, checked: false });
      const fields = { 'receipt-editing-id': 'r1', 'receipt-customer-id': 'c1', 'receipt-status': status, 'receipt-serial': paid ? '123' : '',
        'receipt-phone-search': '0912345678', 'paid-collection-value': 'office', 'notpaid-collection-value': 'office' };
      const item = { querySelector: sel => ({ '.payment-method': value('Cash (LYD)'), '.payment-amount': value(amount), '.payment-rate1': value('1'),
        '.payment-rate2': value('5'), '.collection-type': value('office'), '.delivery-person': null })[sel] };
      sandbox.document.getElementById = id => (id in fields ? value(fields[id]) : null);
      sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? [item] : []);
      const sent = [];
      let calls = 0;
      const echo = (id, updates) => ({ id, data: { ...plain(state.receipts.find(r => r.id === id)), ...plain(updates), _lastModified: 2000 + calls }, lastModified: 2000 + calls });
      sandbox.apiPatchEntity = async (_collection, id, updates) => { calls += 1; sent.push(plain(updates)); if (calls === 1) throw firstError; return echo(id, updates); };
      sandbox.apiSettleReceipt = async ({ receiptId, data }) => { calls += 1; sent.push(plain(data)); if (calls === 1) throw firstError; return { receipt: echo(receiptId, data), updatedAds: [], replayed: false }; };
      await sandbox._saveReceiptFromModalInner();
      const afterFailure = plain(state.receipts[0]);
      amount = secondAmount;
      await sandbox._saveReceiptFromModalInner();
      return { afterFailure, firstSent: sent[0], retrySent: sent[1] };
    };
    const rows = history => history.map(entry => entry.changes.map(c => `${c.field}: ${c.from} -> ${c.to}`).join('; '));
    // 1. The network drops the first save; the same edit is saved again.
    {
      const { afterFailure, firstSent, retrySent } = await scenario('Paid', Object.assign(new Error('Network request failed'), { status: 0 }), '600', '600');
      assert.equal(firstSent.editHistory.length, 2, 'the failed attempt did carry the new row');
      assert.equal(afterFailure.editHistory.length, 1, 'before: the failed save left a phantom row on the live receipt');
      assert.equal(afterFailure.editCount, 1);
      assert.equal(retrySent.editHistory.length, 2, 'before: the retry uploaded the same edit twice');
      assert.equal(retrySent.editCount, 2);
      assert.match(rows(retrySent.editHistory)[1], /Amount \(USD\): \$100\.00 -> \$120\.00/);
    }
    // 2. The server refuses the first change (409 rule); a different, allowed change is saved.
    {
      const { afterFailure, retrySent } = await scenario('Not Paid', Object.assign(new Error('Receipt amount is locked by linked ads'), { status: 409 }), '600', '550');
      assert.equal(afterFailure.editHistory.length, 1, 'before: the refused change was left in the history');
      const uploaded = rows(retrySent.editHistory);
      assert.equal(uploaded.length, 2, 'before: the refused change was uploaded as if it happened');
      assert.match(uploaded[1], /Amount \(USD\): \$100\.00 -> \$110\.00/);
      assert.ok(!uploaded.some(text => text.includes('$120.00')), uploaded.join(' | '));
    }
  });

  // A fake browser history wired to the real router (desktop: no phone-browser sentinels).
  const historyFixture = path => {
    const fixture = loadBrowserSource();
    const { sandbox, run } = fixture;
    sandbox.URLSearchParams = URLSearchParams;
    const location = sandbox.window.location;
    const entries = [{ state: { view: path.slice(1) }, url: path }];
    let index = 0;
    const apply = url => { const next = new URL(url, 'http://localhost'); location.pathname = next.pathname; location.search = next.search; location.href = next.href; };
    apply(path);
    const pops = [];
    let backs = 0;
    sandbox.window.addEventListener = (type, fn) => { if (type === 'popstate') pops.push(fn); };
    sandbox.window.history = {
      get state() { return entries[index].state; },
      pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url: url || entries[index].url }); index += 1; apply(entries[index].url); },
      replaceState(state, _title, url) { entries[index] = { state, url: url || entries[index].url }; apply(entries[index].url); },
      back() { backs += 1; if (index > 0) { index -= 1; apply(entries[index].url); pops.forEach(fn => fn({ state: entries[index].state })); } }
    };
    let timers = [];
    sandbox.setTimeout = fn => { timers.push(fn); return timers.length; };
    const flush = () => { while (timers.length) { const due = timers; timers = []; due.forEach(fn => fn()); } };
    run("Security.escapeHtml = s => String(s ?? '')");
    run('setupUrlRouting()');
    assert.equal(run('isPhoneBrowserHistoryManaged()'), false);
    return { ...fixture, flush, url: () => location.pathname + location.search, backs: () => backs };
  };

  await test('R1 forms-modals-3: closing the collect dialog (X, backdrop, or after saving) consumes its ?modal entry, so Back never reopens it', async () => {
    for (const how of ['x', 'backdrop', 'saved']) {
      const fixture = historyFixture('/receipts');
      const { sandbox, state, run } = fixture;
      const dialogs = new Map();
      let markup = '';
      sandbox.document.getElementById = id => dialogs.get(id) || null;
      sandbox.document.body.insertAdjacentHTML = (_where, html) => {
        markup = html;
        const id = html.match(/id="([^"]+)"/)[1];
        dialogs.set(id, { id, remove() { dialogs.delete(id); } });
      };
      sandbox.updateRecord = async (array, id, updates) => { Object.assign(array.find(row => row.id === id), updates); return true; };
      state.currentView = 'receipts';
      state.receipts = [{ id: 'r1', serialNumber: '1001', status: 'Paid', isPaid: true, amountUSD: 10, amountLocal: 50, exchangeRate: 5,
        payments: [{ method: 'Cash (LYD)', amount: 50, rate: 1 }], customerId: 'c1' }];
      sandbox.openCollectReceiptModal('r1');
      assert.equal(fixture.url(), '/receipts?modal=collect-receipt&id=r1');
      const dialog = dialogs.get('collect-receipt-modal');
      if (how === 'x') run(markup.match(/<button onclick="([^"]+)"[^>]*><i data-lucide="x"/)[1]);
      if (how === 'backdrop') run(`(function (event) { ${markup.match(/id="collect-receipt-modal"[^>]*onclick="([^"]+)"/)[1]} })`).call(dialog, { target: dialog });
      if (how === 'saved') {
        run("_tempCollectPayments = [{ method: 'Cash (LYD)', amount: '30' }]");
        await sandbox.confirmCollectReceipt('r1');
        assert.equal(state.receipts[0].collectedAmount, 30);
      }
      assert.ok(!dialogs.has('collect-receipt-modal'), `${how}: the dialog closed`);
      assert.equal(fixture.url(), '/receipts', `${how}: before, the address kept ?modal=collect-receipt`);
      // A second tap on the already-closed dialog consumes nothing more.
      const backsAfterClose = fixture.backs();
      sandbox._closeUrlTrackedOverlay(Object.assign(dialog, { isConnected: false }));
      assert.equal(fixture.backs(), backsAfterClose);
      run("navigateTo('ads')");
      fixture.flush();
      sandbox.window.history.back();
      fixture.flush();
      assert.equal(fixture.url(), '/receipts', how);
      assert.ok(!dialogs.has('collect-receipt-modal'), `${how}: before, Back reopened the collect dialog`);
    }
  });

  await test('R1 forms-modals-3: closing the Permissions Manager (Done, X, backdrop) consumes its ?modal entry', async () => {
    for (const how of ['done', 'x', 'backdrop']) {
      const fixture = historyFixture('/users');
      const { sandbox, state, run } = fixture;
      const els = new Map();
      sandbox.document.createElement = () => ({ style: {}, dataset: {}, classList: fakeClassList(), setAttribute() {}, addEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, remove() { if (els.get(this.id) === this) els.delete(this.id); } });
      sandbox.document.getElementById = id => els.get(id) || null;
      sandbox.document.body.appendChild = el => { if (el && el.id) els.set(el.id, el); };
      run('IconQueue').schedule = () => {};
      state.currentView = 'users';
      state.users = [state.currentUser, { id: 'u2', name: 'Employee Two', role: 'Employee', permissions: { ads: ['view'] } }];
      sandbox.showPermissionsModal('u2');
      const modal = els.get('app-modal');
      assert.equal(fixture.url(), '/users?modal=permissions&id=u2');
      const button = { closest: selector => (selector === '#app-modal' ? modal : null) };
      const handler = pattern => run(`(function () { ${modal.innerHTML.match(pattern)[1]} })`).call(button);
      if (how === 'done') handler(/<button onclick="([^"]+)"[^>]*>\s*Done\s*<\/button>/);
      if (how === 'x') handler(/<button onclick="([^"]+)"[^>]*>\s*<i data-lucide="x"/);
      if (how === 'backdrop') modal.onclick({ target: modal });
      assert.ok(!els.has('app-modal'), `${how}: the manager closed`);
      assert.equal(fixture.url(), '/users', `${how}: before, the address kept ?modal=permissions`);
      run("navigateTo('customers')");
      fixture.flush();
      sandbox.window.history.back();
      fixture.flush();
      assert.ok(!els.has('app-modal'), `${how}: before, Back reopened the Permissions Manager`);
    }
  });

  await test('R1 forms-modals-4: the receipt and page pickers find a phone typed in another spelling; a name with a digit no longer matches everyone', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    const els = new Map();
    for (const id of ['receipt-phone-search', 'receipt-phone-dropdown', 'page-customer-search', 'page-customer-dropdown']) {
      els.set(id, { id, value: '', innerHTML: '', classList: fakeClassList() });
    }
    sandbox.document.getElementById = id => els.get(id) || null;
    state.customers = [
      { id: 'c1', name: 'Salem Ali', phones: ['+218 91-234-5678'], platform: 'Facebook', createdBy: 'admin' },
      { id: 'c2', name: 'Huda', phones: ['00218 92 765 4321'], platform: 'Instagram', createdBy: 'admin' },
      { id: 'c3', name: 'Store 2', phones: ['0913333333'], platform: 'Facebook', createdBy: 'admin' }
    ];
    const picked = (picker, term) => {
      els.get(`${picker}-search`).value = term;
      els.get(`${picker}-dropdown`).innerHTML = '';
      els.get(`${picker}-dropdown`).classList.add('hidden');
      run(picker === 'receipt-phone' ? 'invalidateReceiptPhoneRows(); filterReceiptPhonesNow()' : 'filterPageCustomersNow()');
      const dropdown = els.get(`${picker}-dropdown`);
      if (dropdown.classList.contains('hidden')) return [];
      return [...new Set((dropdown.innerHTML.match(/data-(?:customer|record)-id="[^"]+"/g) || []).map(found => found.split('"')[1]))];
    };
    for (const picker of ['receipt-phone', 'page-customer']) {
      assert.deepEqual(picked(picker, '0912345678'), ['c1'], `${picker}: before, nothing was found`);
      assert.deepEqual(picked(picker, '٠٩١٢٣٤٥٦٧٨'), ['c1'], picker);
      assert.deepEqual(picked(picker, '0927654321'), ['c2'], picker);
      assert.deepEqual(picked(picker, 'Store 2'), ['c3'], picker);
      assert.deepEqual(picked(picker, '0000'), [], `${picker}: zeros match nobody`);
    }
    const find = term => { state.customerSearch = term; state.customerSort = 'newest'; state.customerFinancialFilter = 'all'; return sandbox.getFilteredCustomers().map(c => c.id); };
    assert.deepEqual(find('Store 2'), ['c3'], 'before: every 218… phone key contains a 2');
    state.customers.push({ id: 'c4', name: 'محل 7', phones: ['0945555555'], createdBy: 'admin' });
    assert.deepEqual(find('محل 7'), ['c4'], 'before: unrelated customers matched the 7');
    assert.deepEqual(find('0912345678'), ['c1']);
    assert.deepEqual(find('234-5678'), ['c1']);
    assert.deepEqual(find('092765'), ['c2']);
  });

  await test('R1 ios-webview-runtime-3: Android Back while the app lock shows leaves the dialog, its input and photos behind the lock alone and only backgrounds the app', async () => {
    const { sandbox, state } = loadBrowserSource();
    const removed = [];
    const modal = { id: 'app-modal', className: 'mobile-dialog-overlay', isConnected: true, style: {}, setAttribute() {}, removeAttribute() {}, remove: () => removed.push('app-modal') };
    const nodes = new Map([['native-app-lock', { id: 'native-app-lock', remove: () => removed.push('native-app-lock') }], ['app-modal', modal]]);
    sandbox.document.getElementById = id => nodes.get(id) || null;
    sandbox.document.querySelectorAll = selector => (/\.mobile-dialog-overlay|#app-modal/.test(String(selector)) ? [modal] : []);
    const calls = { back: 0, navigate: 0, exit: 0, minimize: 0 };
    sandbox.URLSearchParams = URLSearchParams;  // an unlocked Back's closeModal() clears ?modal=
    sandbox.isPackagedMobileApp = () => true;
    sandbox.window.history.back = () => { calls.back += 1; };
    sandbox.navigateToInternal = () => { calls.navigate += 1; };
    sandbox.getCapacitorAppPlugin = () => ({ exitApp: async () => { calls.exit += 1; }, minimizeApp: async () => { calls.minimize += 1; } });
    state.currentView = 'receipts';  // not the landing view: an unlocked Back would navigate
    state.activeModal = 'receipt';
    state.tempReceiptPhotos = [{ id: 'photo1', dataUrl: 'data:image/jpeg;base64,AAAA' }];
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.equal(state.activeModal, 'receipt', 'before: closeModal() threw the half-filled receipt away');
    assert.equal(state.tempReceiptPhotos.length, 1, 'the unsaved photo is kept');
    assert.deepEqual(removed, []);
    assert.deepEqual(calls, { back: 0, navigate: 0, exit: 0, minimize: 1 });
    await sandbox.handleAndroidBackButton({ canGoBack: true });  // a second press is not "press Back again to exit"
    assert.deepEqual(calls, { back: 0, navigate: 0, exit: 0, minimize: 2 });
    assert.equal(state.activeModal, 'receipt');
  });

  await test('R1 ios-webview-runtime-5: a short landscape screen is not taken for an open keyboard (the bottom nav stays); a real keyboard still is', () => {
    const { sandbox } = loadBrowserSource();
    const classes = new Set();
    sandbox.document.body.classList = {
      add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name), toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); return !!on; }
    };
    sandbox.document.documentElement.style.setProperty = () => {};
    const keyboardOpen = (innerHeight, visualHeight) => {
      Object.assign(sandbox.window, { innerWidth: 844, innerHeight, visualViewport: { width: 844, height: visualHeight, offsetTop: 0 } });
      sandbox._updateVisualViewportVariables();
      return classes.has('keyboard-open');
    };
    assert.equal(keyboardOpen(343, 343), false, 'a phone held sideways, nothing focused: before, the nav was hidden');
    assert.equal(keyboardOpen(659, 350), true, 'portrait keyboard');
    assert.equal(keyboardOpen(343, 150), true, 'landscape keyboard');
    assert.equal(keyboardOpen(900, 900), false);
    classes.add('native-keyboard-open');
    assert.equal(keyboardOpen(343, 343), true, 'the packaged app\'s native keyboard event still decides');
  });

  // load-browser-source stubs saveState: snapshot tests re-evaluate the real one.
  const persistenceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', '06-persistence.js'), 'utf8');
  const useRealSaveState = run => {
    const at = persistenceSrc.indexOf('function saveState() {');
    run(persistenceSrc.slice(at, persistenceSrc.indexOf('\n}\n', at) + 2));
  };
  await test('R1 storage-integrity-4: Clear All Data (local mode) empties all 15 stored collections and the old recovery key, in memory and in the saved snapshot', async () => {
    for (const withDb of [false, true]) {
      const { sandbox, state, run } = loadBrowserSource();
      useRealSaveState(run);
      const names = Array.from(run('PERSISTED_COLLECTIONS'));
      assert.equal(names.length, 15);
      for (const name of names) state[name] = [{ id: `${name}_1`, name: 'Private row', phone: '0912345678' }];
      state.localRecovery = { hash: 'old-hash', salt: 'old-salt', createdAt: 1 };
      state._quarantinedUnsafeRecords = { receipts: [{ record: { id: 'bad id' }, reason: 'Invalid identifier' }] };
      const cleared = [];
      if (withDb) {
        run('db = {}');
        sandbox.clearIndexedDBLogs = async () => { cleared.push('auditLogs'); return true; };
        sandbox.idbClear = async store => { cleared.push(store); return true; };
        sandbox.markCollectionDirty('walletTransactions');
        sandbox.markCollectionDirty('clothesOrders');
        sandbox.markCollectionCorrupted('dollarPurchases');
      } else run('db = null');
      await sandbox.clearAllData();
      const snapshot = JSON.parse(sandbox.localStorage.getItem('albayan_complete_state'));
      for (const name of names) {
        assert.deepEqual(Array.from(state[name]), [], `${name} survived in memory`);
        if (!withDb) assert.deepEqual(snapshot[name], [], `${name} survived in the snapshot`);
      }
      assert.equal(state.localRecovery, null, 'the old recovery key could still reset passwords');
      assert.equal(snapshot.localRecovery, null);
      assert.equal(state._quarantinedUnsafeRecords, undefined);
      assert.equal('_quarantinedUnsafeRecords' in snapshot, false);
      if (withDb) {
        assert.equal(run('idbSync.dirty.size'), 0, 'no collection is left queued for a later flush');
        assert.equal(sandbox.isCollectionCorrupted('dollarPurchases'), false, 'the next workspace can be saved again');
        assert.ok(cleared.includes('appData') && cleared.includes('backups'), cleared.join());
      }
    }
  });

  // R2 client-ui-core-1: the "This phone" card (Face ID lock, reminders) lived only on the admin-only Settings page.
  await test('R2 client-ui-core-1: in the phone app every role gets the Face ID lock on More; reminders only for ads or reconciliation users; web unchanged', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    const templates = run('PERMISSION_TEMPLATES');
    const page = (role, permissions, view = 'more') => {
      state.currentUser = { id: `u_${role}`, name: 'Staff', role, permissions: JSON.parse(JSON.stringify(permissions)) };
      state.users = [state.currentUser];
      state.currentView = view;
      return String(run(view === 'more' ? 'renderMoreView()' : 'renderSettingsView()'));
    };
    const lock = 'setNativeBiometricLockEnabled(', reminders = 'setNativeRemindersEnabled(';
    let html = page('Employee', templates.manager.permissions);
    assert.ok(!html.includes(lock) && !html.includes(reminders), 'a browser More page has no phone card');
    html = page('Admin', {}, 'settings');
    assert.ok(!html.includes(lock) && !html.includes(reminders));
    sandbox.isPackagedMobileApp = () => true;
    html = page('Employee', templates.manager.permissions);
    assert.ok(html.includes(lock) && html.includes(reminders), 'before: no non-admin could reach either switch');
    assert.ok(page('Delivery', templates.deliveryDriver.permissions).includes(lock));
    html = page('Employee', { customers: ['view'], receipts: ['view'] });
    assert.ok(html.includes(lock) && !html.includes(reminders), 'no ads or reconciliation: no reminders switch');
    html = page('Admin', {}, 'settings');
    assert.ok(html.includes(lock) && html.includes(reminders) && html.includes('data-native-device-settings'));
    // Both switches redraw the More page they sit on.
    page('Employee', templates.manager.permissions);
    let renders = 0;
    sandbox.render = () => { renders += 1; };
    sandbox.nativeSecureSet = async () => true;
    sandbox.getCapacitorPlugin = name => (name === 'LocalNotifications' ? { getPending: async () => ({ notifications: [] }), cancel: async () => {} } : null);
    assert.equal(await sandbox.setNativeBiometricLockEnabled(false), true);
    assert.equal(await sandbox.setNativeRemindersEnabled(false), true);
    assert.equal(renders, 2, 'before: only the Settings page re-rendered');
  });

  await test('R2 client-ui-core-2: a receipt tapped under Home > Recent activity opens even when Collect a debt left the Unpaid filter on', () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    sandbox.URLSearchParams = URLSearchParams;
    const createdAt = new Date().toISOString();
    state.receipts = [
      { id: 'r_paid', customerId: 'c1', amountUSD: 10, amountLocal: 50, exchangeRate: 5, status: 'Paid', isPaid: true, createdAt, createdBy: 'admin' },
      { id: 'r_debt', customerId: 'c1', amountUSD: 20, amountLocal: 100, exchangeRate: 5, status: 'Not Paid', isPaid: false, createdAt, createdBy: 'admin' }
    ];
    state.currentView = 'analytics';
    state.receiptStatusFilter = 'not_paid';   // as Collect a debt leaves it
    state.receiptCustomerFilter = 'c1';
    run("openReceiptFromHome('r_paid')");
    assert.equal(state.currentView, 'receipts');
    assert.equal(state.receiptStatusFilter, 'all', 'before: the Unpaid filter stayed on');
    assert.equal(state.receiptRecordFilter, 'r_paid');
    const html = String(run('renderView()'));
    assert.ok(html.includes('data-receipt-id="r_paid"') && !html.includes('No receipts match your filters'));
  });

  await test('R2 client-ui-core-3: Complete on a Meta ad whose page has no customer shows a title, the whole instruction and a warning, then opens the page', () => {
    for (const language of ['en', 'ar']) {
      const { sandbox, state } = loadBrowserSource();
      state.language = language;
      state.pages = [{ id: 'p_meta', name: 'Imported page', customerIds: [] }];
      state.ads = [{ id: 'a_meta', pageId: 'p_meta', metaAdId: '1200', needsSetup: true }];
      const calls = [], opened = [];
      sandbox.showNotification = (...args) => { calls.push(args); };
      sandbox.editPage = id => { opened.push(id); };
      sandbox.editAd = () => { throw new Error('the ad editor must wait for the customer'); };
      sandbox.completeMetaImportedAd('a_meta');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].length, 3, 'before: (instruction, "warning"), so the body read "warning"');
      const [title, message, type] = calls[0];
      assert.equal(type, 'warning');
      assert.equal(title, language === 'ar' ? 'اربط الصفحة بعميل أولاً' : 'Assign the page to a customer first');
      assert.equal(message, language === 'ar'
        ? 'اربط صفحة Meta بعميل أولاً، ثم أكمل الدفع والوصل في الإعلان.'
        : 'First assign the imported Meta page to a customer, then complete payment and receipt details in the ad.');
      assert.deepEqual(opened, ['p_meta']);
    }
  });

  await test('R2 client-ui-core-4: the sidebar theme button shows the new theme right after toggleTheme() or shellSetTheme()', () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    // The real render(): load-browser-source stubs it, and this needs the shell outside the view container.
    const viewsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', '12-views.js'), 'utf8');
    for (const name of ['render', 'forceFullRender']) {
      const at = viewsSrc.indexOf(`\nfunction ${name}() {`) + 1;
      run(viewsSrc.slice(at, viewsSrc.indexOf('\n}\n', at) + 2));
    }
    const view = { innerHTML: '', querySelectorAll: () => [] };
    const app = { innerHTML: '', style: { setProperty() {} }, classList: { add() {}, remove() {} },
      querySelector: sel => (sel === '#workspace-view-content' && app.innerHTML.includes('id="workspace-view-content"') ? view : null) };
    sandbox.document.getElementById = id => (id === 'app' ? app : null);
    sandbox.document.documentElement.classList = fakeClassList();
    sandbox.document.documentElement.style.setProperty = () => {};
    const button = () => {
      const html = (app.innerHTML.match(/<button onclick="toggleTheme\(\)"[\s\S]*?<\/button>/) || [''])[0];
      return [(html.match(/data-lucide="([^"]+)"/) || [])[1], (html.match(/<span>([^<]*)<\/span>/) || [])[1]];
    };
    state.theme = 'light';
    state.currentView = 'customers';
    run('render()');
    assert.deepEqual(button(), ['sun', 'Light']);
    run('toggleTheme()');
    assert.deepEqual(button(), ['moon', run("shellThemeLabel('dark', false)")], 'before: still Light / sun');
    run('toggleTheme()');
    assert.deepEqual(button(), ['monitor', 'System']);
    run("shellSetTheme('dark')");
    assert.deepEqual(button(), ['moon', 'Dark']);
  });

  await test('R2 client-ui-core-5: Audit Logs in Arabic shows Arabic action and category tags and action options; values and filtering keep the raw ids', () => {
    const { sandbox, state, run } = loadBrowserSource();
    run("Security.escapeHtml = s => String(s ?? '')");
    sandbox.refreshServerAuditLogs = () => {};
    const date = new Date().toISOString();
    state.logs = [
      { id: 'l1', action: 'login', category: 'auth', severity: 'info', userId: 'admin', date, description: 'Signed in' },
      { id: 'l2', action: 'delete', category: 'data', severity: 'warning', userId: 'admin', date, description: 'Deleted a customer' },
      { id: 'l3', action: 'create', category: 'data', severity: 'info', userId: 'admin', date, description: 'Created a receipt' }
    ];
    const audit = () => {
      const html = String(run('renderAuditView()'));
      const tags = [...html.matchAll(/<span class="management-(?:action|category)-tag">([^<]*)<\/span>/g)].map(m => m[1]);
      const select = (html.match(/<select aria-label="(?:الإجراء|Action)"[\s\S]*?<\/select>/) || [''])[0];
      const options = [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]).slice(1);
      return { html, tags, options };
    };
    state.language = 'ar';
    let { tags, options } = audit();
    for (const label of ['تسجيل دخول', 'حذف', 'إنشاء', 'مصادقة', 'بيانات']) assert.ok(tags.includes(label), `${label} missing from ${tags}`);
    assert.ok(!tags.some(tag => ['login', 'delete', 'create', 'auth', 'data'].includes(tag)), `raw English tags: ${tags}`);
    assert.deepEqual(options.map(o => o[0]).sort(), ['create', 'delete', 'login'], 'option values stay the raw ids');
    assert.deepEqual(options.map(o => o[1]).sort(), ['إنشاء', 'تسجيل دخول', 'حذف'].sort());
    state.auditActionFilter = 'login';
    ({ tags } = audit());
    assert.deepEqual(tags, ['تسجيل دخول', 'مصادقة'], 'filtering by the raw id still finds the login row only');
    state.language = 'en';
    state.auditActionFilter = 'all';
    ({ tags } = audit());
    assert.ok(tags.includes('login') && tags.includes('auth'), 'English keeps the stored ids');
    // The Settings account card names the role in Arabic, like the More page and the sidebar.
    state.language = 'ar';
    const card = String(run('renderSettingsAppearanceCard()'));
    assert.ok(card.includes(run("shellRoleLabel('Admin', true)")) && !card.includes('>Admin'), 'before: the role read "Admin"');
  });

  await test('R2 ios-device-behaviour-2: an opaque PNG (every iPhone paste) is stored as a JPEG; transparency or unreadable pixels stay PNG; Paste photo hands over a JPEG', async () => {
    const { sandbox } = loadBrowserSource();
    let pixels = null;
    const encoded = [];
    const ctx = { drawImage() {}, getImageData: () => { if (!pixels) throw new Error('tainted canvas'); return { data: pixels }; } };
    const canvas = { width: 0, height: 0, getContext: () => ctx,
      toDataURL: type => { encoded.push(type); return type === 'image/png' ? 'data:image/png;base64,iVBORw0K' : 'data:image/jpeg;base64,/9j/4AAQ'; } };
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => (tag === 'canvas' ? canvas : makeElement(tag));
    sandbox.Image = function FakeImage() {
      let src = '';
      Object.defineProperty(this, 'src', { get: () => src, set: value => {
        src = value; this.naturalWidth = 4032; this.naturalHeight = 3024;
        Promise.resolve().then(() => this.onload());
      } });
    };
    // Blob/File/FileReader for the bytes _nativeDataUrlToFile builds (sandbox typed arrays: ArrayBuffer.isView).
    const bytes = blob => Buffer.concat((blob.parts || []).map(part => (ArrayBuffer.isView(part) ? Buffer.from(part.buffer, part.byteOffset, part.byteLength) : bytes(part))));
    sandbox.Blob = function FakeBlob(parts, options = {}) { this.parts = parts; this.type = options.type || ''; this.size = bytes(this).length; };
    sandbox.File = function FakeFile(parts, name, options = {}) { sandbox.Blob.call(this, parts, options); this.name = name; };
    sandbox.FileReader = function FakeReader() {
      this.readAsDataURL = blob => Promise.resolve().then(() => this.onload({ target: { result: `data:${blob.type};base64,${bytes(blob).toString('base64')}` } }));
    };
    sandbox.atob = text => Buffer.from(text, 'base64').toString('binary');
    const fullSizePng = new sandbox.File([new Uint8Array(Buffer.alloc(600 * 1024, 7))], 'paste.png', { type: 'image/png' });
    const opaque = new Uint8ClampedArray(64).fill(255);
    const seeThrough = new Uint8ClampedArray(64).fill(255);
    seeThrough[43] = 254;
    for (const [data, expected] of [[opaque, 'image/jpeg'], [seeThrough, 'image/png'], [null, 'image/png']]) {
      pixels = data;
      encoded.length = 0;
      const out = await sandbox.compressImageToDataUrl(fullSizePng);
      assert.deepEqual(encoded, [expected], 'before: every PNG was encoded as image/png');
      assert.ok(out.startsWith(`data:${expected};base64,`), out.slice(0, 40));
    }
    assert.equal(canvas.width, 1280);
    // The packaged app's Paste photo: the Clipboard plugin returns the full-size PNG as a data URL.
    pixels = opaque;
    sandbox.isPackagedMobileApp = () => true;
    sandbox.window.Capacitor = { Plugins: { Clipboard: { read: async () => ({ type: 'image/png', value: `data:image/png;base64,${Buffer.alloc(600 * 1024, 7).toString('base64')}` }) } } };
    const pasted = await sandbox.readNativeClipboardImage();
    assert.equal(pasted.type, 'image/jpeg', 'before: the full-size PNG went straight to the form');
    assert.equal(pasted.name, 'clipboard-photo.jpg');
    // A compression failure still hands over the original photo.
    sandbox.compressImageToDataUrl = async () => { throw new Error('decode failed'); };
    assert.equal((await sandbox.readNativeClipboardImage()).type, 'image/png');
  });


  // ---- Bug-hunt round 34 (admin tools and App Review) ----
  await test('R3 admin-tools-1: a plan list that fails to load is asked for once, not again on every redraw; Reload retries at once and a redraw 30 s later tries once more', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
    for (const file of manifest.lazy['admin-tools.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
    run(realEscape);
    const timers = [];
    sandbox.setTimeout = fn => { timers.push(fn); return timers.length; };  // FIFO, run by hand
    const tick = async count => { for (let i = 0; i < count && timers.length; i += 1) { timers.shift()(); await settle(); } };
    sandbox.render = () => { sandbox.renderView(); };
    sandbox.isServerModeEnabled = () => true;
    sandbox.loadControlCenterStatus = async () => {};
    run('_controlCenter.loadedAt = Date.now();');
    let gets = 0;
    sandbox.apiJson = async (url, options = {}) => {
      if (url === '/api/admin/subscription-plans' && String(options.method || 'GET') === 'GET') gets += 1;
      throw new Error('Failed to fetch');  // offline, or the server restarting
    };
    state.currentView = 'control-center';
    sandbox.render();
    await tick(120);
    assert.equal(gets, 1, `before: one visit sent ${gets} plan requests`);
    assert.ok(String(sandbox.renderPlanManagerSection()).includes('Failed to fetch'), 'the error banner shows');
    await sandbox.loadPlanManager(true);  // the Reload button
    await tick(120);
    assert.equal(gets, 2, 'Reload asks once more, right away');
    run('_planManager.failedAt = Date.now() - 31000;');  // half a minute later
    sandbox.render();
    await tick(120);
    assert.equal(gets, 3, 'a redraw after 30 s tries once more by itself');
  });
  await test('R3 admin-tools-3: editing a loaded plan turns "Save all plans" on and shows "unsaved changes" without a redraw; Reload asks before throwing the edit away', async () => {
    const { sandbox, run } = controlCenterFixture();
    sandbox.isServerModeEnabled = () => true;
    const plan = { id: 'p1', name: 'Plan', nameAr: 'خطة', serviceIds: ['ad_maker'], priceMinor: 10000, durationDays: 30 };
    run(`_planManager.loadedAt = Date.now(); _planManager.version = 3; _planManager.plans = [${JSON.stringify(plan)}];`);
    const clean = String(sandbox.renderPlanManagerSection());
    assert.ok(/id="plan-manager-save"[^>]*\sdisabled\s/.test(clean), 'Save starts off');
    assert.ok(/id="plan-manager-dirty" class="hidden"/.test(clean), 'no marker while nothing changed');
    assert.ok(clean.includes('onclick="planManagerReload()"'), 'Reload goes through the discard question');
    const save = { disabled: true };
    const marker = { classList: fakeClassList() };
    marker.classList.add('hidden');
    sandbox.document.getElementById = id => ({ 'plan-manager-save': save, 'plan-manager-dirty': marker })[id] || null;
    let renders = 0;
    sandbox.render = () => { renders += 1; };
    sandbox.planManagerSetField(0, 'priceLYD', '150');
    assert.equal(save.disabled, false, 'before: Save stayed disabled after the edit');
    assert.equal(marker.classList.contains('hidden'), false, 'the unsaved marker shows');
    assert.equal(renders, 0, 'no redraw while typing: it would close the phone keyboard');
    assert.equal(run('_planManager.plans[0].priceMinor'), 15000);
    const edited = String(sandbox.renderPlanManagerSection());
    assert.ok(!/id="plan-manager-save"[^>]*\sdisabled\s/.test(edited) && !/id="plan-manager-dirty" class="hidden"/.test(edited), 'a later redraw agrees');
    const calls = [];
    sandbox.apiJson = async url => { calls.push(url); return { version: 3, plans: [{ ...plan }] }; };
    const asked = [];
    sandbox.window.confirm = text => { asked.push(text); return false; };
    await sandbox.planManagerReload();
    assert.equal(calls.length, 0, 'kept the edit: nothing reloaded');
    assert.equal(run('_planManager.plans[0].priceMinor'), 15000);
    assert.ok(asked.length === 1 && asked[0].includes('Discard unsaved plan changes'), JSON.stringify(asked));
    sandbox.window.confirm = text => { asked.push(text); return true; };
    await sandbox.planManagerReload();
    assert.deepEqual(calls, ['/api/admin/subscription-plans']);
    assert.equal(run('_planManager.plans[0].priceMinor'), 10000, 'the server copy is back');
    assert.equal(run('_planManager.dirty'), false);
    asked.length = 0;
    await sandbox.planManagerReload();  // nothing to lose: no question
    assert.equal(asked.length, 0);
    assert.equal(calls.length, 2);
  });
  await test('R3 admin-tools-2: the profit snapshot reads the receipts list once per build, and every number matches the old per-allocation search', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run(fs.readFileSync(path.join(__dirname, '..', 'src', '12a-analytics-profit.js'), 'utf8'));
    const receipts = [
      { id: 'r1', _deleted: true, exchangeRate: 99, amountUSD: 10, amountLocal: 990 },  // a deleted twin listed first
      { id: 'r1', exchangeRate: 5, amountUSD: 100, amountLocal: 500 },
      { id: 'r1', exchangeRate: 7, amountUSD: 100, amountLocal: 700 },  // a duplicate id: the first live row wins
      { id: 2, amountUSD: 50, amountLocal: 300 },  // a numeric id, its rate from the amounts
      { id: 'r3', exchangeRate: 6.5, amountUSD: 20, amountLocal: 130 },
      { id: 'r4', exchangeRate: 0, amountUSD: 0, amountLocal: 0 },  // no usable rate
      null,
      { id: 'r5', exchangeRate: 8, amountUSD: 10, amountLocal: 80 }
    ];
    const sold = { paymentStatus: 'paid', status: 'Completed', endDate: '2026-02-01', amountUSD: 100, amountLocal: 600, exchangeRate: 6, spentUSD: 100 };
    const ads = [
      { ...sold, id: 'a1', receiptAllocations: [{ receiptId: 'r1', amountUSD: 60 }, { receiptId: '2', amountUSD: 40 }] },
      { ...sold, id: 'a2', receiptAllocations: [{ receiptId: 'missing', amountUSD: 10 }], dueAllocations: [{ receiptId: 'r3', amountUSD: 30 }, { receiptId: 'r1', amountUSD: 70 }] },
      { ...sold, id: 'a3', mergedPaidAllocations: [{ receiptId: 'r5', amountUSD: 100 }] },
      { ...sold, id: 'a4', fundingReceiptId: 'r4', receiptId: 'r3' },  // falls back past a receipt without a rate
      { ...sold, id: 'a5', linkedDeliveryReceiptId: 2 },
      { ...sold, id: 'a6', receiptAllocations: [{ receiptId: '', amountUSD: 50 }] },
      { ...sold, id: 'a7', paymentStatus: 'not_paid', receiptAllocations: [{ receiptId: 'r1', amountUSD: 100 }] }
    ];
    for (let i = 0; i < 300; i += 1) {
      receipts.push({ id: `bulk${i}`, exchangeRate: 5 + (i % 7) / 10, amountUSD: 10, amountLocal: 50 });
      ads.push({ ...sold, id: `bulk_ad${i}`, endDate: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`,
        receiptAllocations: [{ receiptId: `bulk${i}`, amountUSD: 60 }, { receiptId: `bulk${299 - i}`, amountUSD: 40 }] });
    }
    const purchases = [{ id: 'p1', purchaseDate: '2026-01-01', amountUSD: 20000, rateLYD: 5.2 }, { id: 'p2', purchaseDate: '2026-03-10', amountUSD: 9000, rateLYD: 5.6 }];
    let reads = 0;
    state.receipts = new Proxy(receipts, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, receiver); } });
    const fresh = sandbox.buildAdProfitabilitySnapshot(purchases, ads);
    assert.ok(reads <= receipts.length, `before: ${reads} receipt reads for ${receipts.length} receipts (one search per allocation)`);
    near(fresh.rowsByAdId.get('a1').saleRateLYD, 5.4);
    near(fresh.rowsByAdId.get('a2').saleRateLYD, 5.45);
    near(fresh.rowsByAdId.get('a4').saleRateLYD, 6.5);
    near(fresh.rowsByAdId.get('a5').saleRateLYD, 6);
    // The old lookup (one receipts.find per allocation), kept as the reference.
    run(`function _adFundingReceiptRateLYD(ad) {
      const receipts = state.receipts || [];
      const find = id => (id ? receipts.find(r => r && !r._deleted && String(r.id) === String(id)) : null);
      const rateOf = r => {
        const explicit = analyticsNumber(r?.exchangeRate);
        if (explicit > 0) return explicit;
        const usd = analyticsNumber(r?.amountUSD), local = analyticsNumber(r?.amountLocal);
        return usd > 0 && local > 0 ? local / usd : 0;
      };
      for (const key of ['receiptAllocations', 'dueAllocations', 'mergedPaidAllocations']) {
        let total = 0, weighted = 0;
        for (const alloc of (Array.isArray(ad?.[key]) ? ad[key] : [])) {
          const rate = rateOf(find(alloc?.receiptId)), amount = analyticsNumber(alloc?.amountUSD);
          if (rate > 0 && amount > 0) { weighted += rate * amount; total += amount; }
        }
        if (total > 0) return weighted / total;
      }
      for (const id of [ad?.fundingReceiptId, ad?.receiptId, ad?.linkedDeliveryReceiptId]) {
        const rate = rateOf(find(id));
        if (rate > 0) return rate;
      }
      return 0;
    }`);
    assert.deepEqual(fresh, sandbox.buildAdProfitabilitySnapshot(purchases, ads), 'the same snapshot, to the last number');
  });
  await test('R3 admin-tools-5: Android Back closes the Analytics breakdown and the Dollar purchase dialog (the top one first) through their closers, instead of changing the page under them', async () => {
    const { sandbox, state } = loadBrowserSource();
    const children = [];
    const matches = (el, selector) => selector.split(',').map(part => part.trim()).some(part => (part.startsWith('#') ? el.id === part.slice(1)
      : part.startsWith('.') && String(el.className || '').split(/\s+/).includes(part.slice(1))));
    sandbox.document.querySelectorAll = selector => children.filter(el => matches(el, String(selector)));
    sandbox.document.getElementById = id => children.find(el => el.id === id) || null;
    sandbox.window.getComputedStyle = el => ({ zIndex: el.style.zIndex || 'auto' });
    const open = (id, zIndex, className = '') => {
      const el = { id, className, style: { zIndex }, isConnected: true, setAttribute() {}, remove() { el.isConnected = false; children.splice(children.indexOf(el), 1); } };
      children.push(el);
      return el;
    };
    const closed = [];
    sandbox.closeAnalyticsBreakdown = () => { closed.push('breakdown'); sandbox.document.getElementById('analytics-breakdown-dialog')?.remove(); };
    sandbox.closeDollarPurchaseManager = () => { closed.push('dollar'); sandbox.document.getElementById('dollar-purchase-dialog')?.remove(); };
    const calls = { back: 0, navigate: 0, exit: 0, notes: 0 };
    sandbox.window.history.back = () => { calls.back += 1; };
    sandbox.navigateToInternal = () => { calls.navigate += 1; };
    sandbox.getCapacitorAppPlugin = () => ({ exitApp: async () => { calls.exit += 1; } });
    sandbox.showNotification = () => { calls.notes += 1; };
    sandbox.URLSearchParams = URLSearchParams;
    state.currentView = 'analytics';  // not the landing view: a Back that misses the dialog navigates
    open('analytics-breakdown-dialog', '10000');
    assert.equal(sandbox.getTopMobileSurface()?.id, 'analytics-breakdown-dialog', 'before: Back did not see the breakdown');
    assert.equal(sandbox._overlaySurfaceCount(), 1, 'the phone-browser Back entry counts it too');
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.deepEqual(closed, ['breakdown']);
    open('dollar-purchase-dialog', '10001');
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.deepEqual(closed, ['breakdown', 'dollar']);
    for (const order of [['analytics-breakdown-dialog', 'dollar-purchase-dialog'], ['dollar-purchase-dialog', 'analytics-breakdown-dialog']]) {
      closed.length = 0;
      for (const id of order) open(id, id === 'dollar-purchase-dialog' ? '10001' : '10000');
      await sandbox.handleAndroidBackButton({ canGoBack: true });
      await sandbox.handleAndroidBackButton({ canGoBack: true });
      assert.deepEqual(closed, ['dollar', 'breakdown'], `${order.join(' then ')}: the dollar dialog sits on top`);
    }
    assert.deepEqual(calls, { back: 0, navigate: 0, exit: 0, notes: 0 }, 'the page underneath never changed and no exit notice');
    const merge = open('page-merge-dialog', '50', 'mobile-dialog-overlay fixed inset-0');  // control: an ordinary dialog
    await sandbox.handleAndroidBackButton({ canGoBack: true });
    assert.equal(merge.isConnected, false);
    assert.deepEqual(calls, { back: 0, navigate: 0, exit: 0, notes: 0 });
    await sandbox.handleAndroidBackButton({ canGoBack: true });  // nothing open: Back leaves the page
    assert.equal(calls.back, 1);
  });
  await test('R3 ios-app-review-2: a Clothes System subscriber on the phone can switch language, sign out and open Privacy and Delete account (paywall and main view); the Studio Account lists account deletion', async () => {
    const { sandbox, state, run } = clothesFixture();
    run('Security').escapeHtml = plainEscape;
    run('Platform.detect()').isCapacitor = true;
    const subscriberPermissions = JSON.parse(JSON.stringify(run('PERMISSION_TEMPLATES.clothesSubscriber.permissions')));
    state.currentUser = { id: 'sub1', name: 'Sub', role: 'Employee', permissions: subscriberPermissions };
    state.users = [state.currentUser];
    state.currentView = 'clothes-system';
    for (const subscribed of [false, true]) {
      sandbox.hasSubscription = id => subscribed && id === 'clothes_system';
      const html = String(run('renderMainApp()'));
      assert.equal(html.includes('Subscribe now'), !subscribed);
      for (const control of ['onclick="toggleLanguage()"', 'onclick="handleLogout()"', 'href="https://albayanhub.com/privacy"', 'href="https://albayanhub.com/delete-account"']) {
        assert.ok(html.includes(control), `${subscribed ? 'main view' : 'paywall'}: before, no ${control}`);
      }
    }
    sandbox.hasSubscription = () => true;
    state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
    const admin = String(run('renderMainApp()'));
    assert.ok(admin.includes("navigateTo('smart-systems')") && !admin.includes('handleLogout()'), 'an admin keeps the back button and gets no strip');
    state.currentUser = { id: 'emp', role: 'Employee', permissions: { ...subscriberPermissions, customers: ['view'] } };
    const staff = String(run('renderMainApp()'));
    assert.ok(staff.includes("navigateTo('customers')") && !staff.includes('handleLogout()'), 'staff with other pages keep the back button');
    const studio = studioFixture();
    studio.replies['/api/studio/profile'] = { whatsappNumber: '' };
    studio.state.serverBaseUrl = 'https://albayanhub.com';
    const account = String(studio.run('renderStudioAccountScreen()'));
    assert.ok(account.includes('data-testid="studio-account-delete" href="https://albayanhub.com/delete-account"'), 'before: no account-deletion row');
    assert.ok(account.indexOf('studio-account-terms') < account.indexOf('studio-account-delete') && account.indexOf('studio-account-delete') < account.indexOf('studio-account-logout'));
    studio.state.language = 'ar';
    assert.ok(String(studio.run('renderStudioAccountScreen()')).includes('طلب حذف الحساب'));
  });
  await test('R3 ios-app-review-3: the server sign-in screen draws no disabled Passkey button and no "not enabled yet" note; local mode with passkey support still offers it', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    sandbox.window.PublicKeyCredential = function PublicKeyCredential() {};
    state.serverMode = true;
    for (const app of [false, true]) {
      run('Platform.detect()').isCapacitor = app;
      run("_nativeLoginMode = 'form'");  // the app's own form, not the browser hand-off card
      const html = String(run('renderLogin()'));
      assert.ok(html.includes('id="login-form"'), 'the password form is drawn');
      assert.ok(!html.includes('passkeySignIn()') && !/passkey/i.test(html), `${app ? 'app' : 'web'}: before, a disabled Passkey button and "not enabled in server mode yet"`);
    }
    run('Platform.detect()').isCapacitor = false;
    state.serverMode = false;
    const local = String(run('renderLogin()'));
    assert.ok(local.includes('onclick="passkeySignIn()"') && local.includes('Sign in with a Passkey') && !/passkeySignIn\(\)"\s*disabled/.test(local), 'local mode keeps a working Passkey button');
  });

  // ---- F-iap-lazy: the iPhone app sells nothing (inAppPurchasingHidden, 01-platform.js). There the
  // lazy screens (Clothes paywall, Ads Studio) hide every subscribe, activate, renew and add-money
  // control and show one neutral line; the web and the packaged Android app are unchanged.
  {
    const NO_BUY = { en: 'Purchases are not available in this app.', ar: 'الشراء غير متاح في هذا التطبيق.' };
    const combos = ['web', 'android', 'ios'].flatMap(platform => ['en', 'ar'].map(language => [platform, language]));
    // Draws as the web, the packaged Android app or the packaged iPhone app, in one language.
    const drawAs = (fixture, platform, language) => {
      const detected = fixture.run('Platform.detect()');
      if (platform !== 'web') Object.assign(detected, { isCapacitor: true, isWeb: false, isMobile: true, platform, isIOS: platform === 'ios', isAndroid: platform === 'android' });
      // The switch belongs to the platform (01-platform.js); a tree without it gets the agreed one.
      if (fixture.run('typeof inAppPurchasingHidden') !== 'function') {
        fixture.run("function inAppPurchasingHidden() { return !!(typeof Platform !== 'undefined' && Platform.isCapacitor && Platform.isIOS); }");
      }
      assert.equal(fixture.run('inAppPurchasingHidden()'), platform === 'ios', `${platform}: the switch`);
      fixture.run('Security').escapeHtml = plainEscape;
      fixture.state.language = language;
    };
    // Every neutral line of a studio screen: exactly the agreed words, no link and no other way to pay.
    const neutralLines = html => Array.from(html.matchAll(/<p [^>]*data-testid="studio-no-purchase">([\s\S]*?)<\/p>/g), match => match[1]);
    const onlyNeutral = (html, language, count, where) => {
      const lines = neutralLines(html);
      assert.ok(lines.length >= count && lines.every(text => text === NO_BUY[language]), `${where}: ${lines.length} neutral line(s) ${JSON.stringify(lines)}`);
    };
    const piece = (html, from, to) => {
      const at = html.indexOf(from);
      return at < 0 ? '' : html.slice(at, html.indexOf(to, at) + to.length);
    };
    // The words of the buying controls, as the screens write them.
    const BUY_WORDS = { en: /Subscribe|Activate|Renew|Add money|Add dinars|Top up|Charge your wallet|Create charge request/, ar: /اشترك الآن|فعّل اشتراكك|فعّل الاشتراك|فعّل استوديو|فعّل الخدمة|تفعيل الخدمة|جدّد|أضف مالاً|أضف رصيداً|إضافة رصيد|أضف ديناراً|اشحن|إنشاء طلب شحن/ };
    const BUY_CALLS = /showSubscriptionModal|studioWalletOpenAdd|studioBuilderAddMoney|adsStudioCreateWalletCharge|studioWalletCreate|AttachReceipt/;
    const summary = (usd = {}, pendingPayments = null) => ({
      usd: { addedMinor: 10000, adjustmentsMinor: 0, reservedMinor: 1000, inAdsMinor: 2000, metaUsedInAdsMinor: null, metaCheckedAt: null, beingReturnedMinor: 0, spentMinor: 500, availableMinor: 6500, ...usd },
      reserved: [], inAds: [], chains: [], lyd: { balanceMinor: 5000 },
      pendingPayments: pendingPayments || [
        { reference: 'PAY-USDAAAA1', amountMinor: 2500, currency: 'USD', createdAt: '2026-09-25T08:00:00Z', dueAt: null },
        { reference: 'PAY-LYDBBBB2', amountMinor: 15000, currency: 'LYD', createdAt: '2026-09-25T07:00:00Z', dueAt: null }
      ]
    });
    const payments = [
      { id: 'wpr_1', data: { reference: 'PAY-USDAAAA1', status: 'pending', currency: 'USD', amountMinor: 2500, amountMinorLYD: 17250, lydRate: 6.9, method: 'adfali', createdAt: '2026-09-25T08:00:00Z' } },
      { id: 'wpr_2', data: { reference: 'PAY-LYDBBBB2', status: 'pending', currency: 'LYD', amountMinor: 15000, amountMinorLYD: 15000, method: 'bank_transfer', createdAt: '2026-09-25T07:00:00Z' } },
      { id: 'wpr_3', data: { reference: 'PAY-DONECCC3', status: 'confirmed', currency: 'USD', amountMinor: 10000, method: 'adfali', createdAt: '2026-09-20T07:00:00Z', confirmedAt: '2026-09-20T09:00:00Z' } }
    ];
    const methods = [
      { id: 'adfali', name: { en: 'Adfali', ar: 'ادفع لي' }, desc: { en: 'Pay from your phone balance', ar: 'ادفع من رصيد هاتفك' }, icon: 'smartphone', requiresReceiptPhoto: false,
        instructions: { en: 'Pay {amountLYD} LYD via Adfali and keep the code {reference} in the payment note.', ar: 'ادفع {amountLYD} د.ل عبر ادفع لي واذكر الرمز {reference} في ملاحظة الدفع.' } },
      { id: 'bank_transfer', name: { en: 'Bank transfer', ar: 'حوالة مصرفية' }, desc: { en: 'Transfer and attach the receipt photo', ar: 'حوّل وأرفق صورة الإيصال' }, icon: 'landmark', requiresReceiptPhoto: true,
        instructions: { en: 'Transfer {amountLYD} LYD, write {reference} in the transfer note, then attach the receipt photo here.', ar: 'حوّل {amountLYD} د.ل واكتب {reference} في بيان الحوالة ثم أرفق صورة الإيصال هنا.' } }
    ];
    // An Ads Studio customer: plan 'active', 'ended' (their plan ran out) or 'none'.
    const studioAs = (platform, language, plan, walletReply) => {
      const fixture = studioFixture();
      const { sandbox, state, run, replies } = fixture;
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'manifest.json'), 'utf8'));
      for (const file of manifest.lazy['studio-pages.js']) run(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'));
      drawAs(fixture, platform, language);
      state.currentUser = { id: 'cust1', name: 'Customer', role: 'Employee', permissions: { adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'submitOwn', 'stopOwn'] } };
      state.users = [state.currentUser];
      state.adCampaignRequests = [];
      state.walletTransactions = [];
      state.serviceSubscriptions = plan === 'none' ? [] : [{ id: 'sub1', userId: 'cust1', serviceId: 'ad_maker', status: 'active',
        expiresAt: new Date(Date.now() + (plan === 'active' ? 20 : -20) * 86400000).toISOString() }];
      assert.equal(run('adsStudioCanUse()'), plan === 'active');
      sandbox.refreshAdsStudioLimits = () => {};
      const notes = [];
      sandbox.showNotification = (title, message, type) => { notes.push({ title, message, type }); };
      replies['/api/studio/wallet/summary'] = walletReply || summary();
      replies['/api/wallet/payment-requests'] = { requests: payments };
      replies['/api/wallet/payment-requests/methods'] = { methods, rate: { usdToLyd: 6.9, date: '2026-09-25' } };
      replies['/api/studio/campaigns/summary'] = {};
      replies['/api/studio/pages'] = { pages: [] };
      const settled = async () => { for (let i = 0; i < 8; i++) await settle(); };
      return { ...fixture, notes, settled };
    };

    await test('F-iap-lazy: the iPhone app draws the Clothes paywall without "Subscribe now" (one neutral line, no link, a way out for the subscriber and for staff) and never says "renew it"; the web and the Android app keep both', async () => {
      for (const [platform, language] of combos) {
        const fixture = clothesFixture();
        const { sandbox, state, run } = fixture;
        drawAs(fixture, platform, language);
        const ios = platform === 'ios';
        const permissions = JSON.parse(JSON.stringify(run('PERMISSION_TEMPLATES.clothesSubscriber.permissions')));
        state.currentView = 'clothes-system';
        sandbox.hasSubscription = () => false;
        const drawFor = user => { state.currentUser = user; state.users = [user]; return String(run('renderMainApp()')); };
        const subscriber = { id: 'sub1', name: 'Sub', role: 'Employee', permissions };
        const staffUser = { id: 'emp', name: 'Emp', role: 'Employee', permissions: { ...permissions, customers: ['view'] } };
        const alone = drawFor(subscriber);
        const staff = drawFor(staffUser);
        const buy = language === 'ar' ? 'اشترك الآن' : 'Subscribe now';
        for (const [who, html] of [['subscriber', alone], ['staff', staff]]) {
          const where = `${platform} ${language} ${who}`;
          assert.equal(html.includes(buy), !ios, `${where}: before, the iPhone paywall offered "${buy}"`);
          assert.equal(html.includes("onclick=\"showSubscriptionModal('clothes_system', 'clothes_system')\""), !ios, `${where}: the subscribe dialog`);
          assert.equal(html.includes('data-testid="clothes-no-purchase"') && html.includes(NO_BUY[language]), ios, `${where}: the neutral line`);
          if (!ios) continue;
          assert.ok(!BUY_WORDS[language].test(html) && !BUY_CALLS.test(html), `${where}: nothing to buy`);
          // The card names no other way or place to pay: no link, no button.
          const card = piece(html, 'glass-panel rounded-2xl p-12 text-center', NO_BUY[language]);
          assert.ok(card && !/<a\s|href=|<button|onclick=/.test(card), `${where}: ${card}`);
        }
        // A save refused because the subscription ran out: the reason, without "renew it" in the iPhone app.
        const ended = language === 'ar' ? 'اشتراك نظام الملابس غير نشط أو انتهى.' : 'Your Clothes System subscription is not active or has ended.';
        assert.equal(String(run("clothesServerDetailText('An active clothes_system subscription is required')")),
          ios ? ended : `${ended} ${language === 'ar' ? 'جدّد الاشتراك ثم أعد المحاولة.' : 'Renew it, then try again.'}`, `${platform} ${language}: the refused save`);
        assert.equal(String(run("clothesServerDetailText('Conflict: order has changed')")),
          language === 'ar' ? 'تم تغييره من جهاز آخر. راجع أحدث نسخة ثم أعد المحاولة.' : 'It was changed on another device. Check the latest version, then try again.', `${platform} ${language}: the other refusals`);
        if (ios) {
          // Never a dead end: the subscriber keeps the account strip, staff get the way back.
          for (const control of ['onclick="toggleLanguage()"', 'onclick="handleLogout()"', 'href="https://albayanhub.com/privacy"', 'href="https://albayanhub.com/delete-account"']) {
            assert.ok(alone.includes(control), `${language} subscriber: ${control}`);
          }
          assert.ok(staff.includes("onclick=\"navigateTo('customers')\""), `${language} staff: the way back`);
          // With the subscription the system itself opens, as everywhere.
          sandbox.hasSubscription = id => id === 'clothes_system';
          const open = drawFor(subscriber);
          assert.ok(!open.includes('clothes-no-purchase') && !open.includes(NO_BUY[language]) && open.includes('data-testid="clothes-account-strip"'));
        }
      }
    });

    await test('F-iap-lazy: the iPhone app draws the studio wallet, Add money, Home, the request builder and Pages with nothing to buy (balances, the plan balance, waiting requests and history stay; one neutral line where a button was); the web and the Android app are unchanged', async () => {
      for (const [platform, language] of combos) {
        const ios = platform === 'ios';
        const where = `${platform} ${language}`;
        const en = language === 'en';
        // ---- an active plan: the wallet, Add money, the builder's wallet lines
        let f = studioAs(platform, language, 'active');
        const wallet = id => String(f.run(`renderStudioWalletScreen({ tab: 'wallet', section: '', id: '${id}', step: 0 })`));
        wallet('');  // asks for the summary, the payment requests and the methods
        await f.settled();
        const page = wallet('');
        // What stays everywhere: the four numbers, the plan balance, the waiting requests with Cancel, the history, Refresh.
        assert.ok(page.includes('data-testid="studio-wallet-available-amount"><bdi dir="ltr">$65.00</bdi>') && page.includes(`data-testid="studio-wallet-lyd-amount"><bdi dir="ltr">50.00 ${en ? 'LYD' : 'د.ل'}</bdi>`), `${where}: the balances`);
        assert.equal((page.match(/data-testid="studio-wallet-pending-item"/g) || []).length, 2, `${where}: the waiting requests`);
        assert.ok(page.includes('PAY-USDAAAA1') && page.includes("onclick=\"studioWalletAskCancel('wpr_1')\"") && page.includes('data-testid="studio-wallet-refresh"'), where);
        assert.ok(piece(page, 'data-testid="studio-wallet-history"', '</section>').includes('PAY-DONECCC3'), `${where}: the history`);
        // The buying controls: the web and Android only.
        assert.equal(/data-testid="studio-wallet-add"[^>]*onclick="studioWalletOpenAdd\(\)"/.test(page), !ios, `${where}: before, the iPhone wallet offered Add money`);
        assert.equal(page.includes(`data-testid="studio-wallet-renew" onclick="showSubscriptionModal('ad_maker', 'ad_maker')"`), !ios, `${where}: Renew or activate the plan`);
        assert.equal(page.includes(`data-testid="studio-wallet-add-lyd" onclick="studioWalletOpenAdd('plan')"`), !ios, `${where}: Add dinars for the plan`);
        assert.equal((page.match(/data-testid="studio-wallet-instruction"/g) || []).length, ios ? 0 : 2, `${where}: how to pay a waiting request`);
        assert.equal(page.includes("studioWalletAttachReceipt('wpr_2', this)"), !ios, `${where}: the receipt upload`);
        assert.equal(page.includes(en ? 'Adfali' : 'ادفع لي') && page.includes('172.50'), !ios, `${where}: the method and the dinars to pay`);
        assert.equal(BUY_WORDS[language].test(page), !ios, `${where}: the buying words`);
        assert.equal(neutralLines(page).length, ios ? 2 : 0, `${where}: the neutral lines (the top of the wallet, the plan card)`);
        if (ios) {
          onlyNeutral(page, language, 2, where);
          assert.ok(!BUY_CALLS.test(page) && !page.includes('studioWalletCopy'), `${where}: no buying call`);
          assert.ok(piece(page, 'data-testid="studio-wallet-lyd"', '</section>').includes(NO_BUY[language]), `${where}: the plan card says so`);
        }
        // ?tab=wallet&id=add-money (a link, or a leftover call such as the builder's "Add money").
        const add = wallet('add-money');
        f.run("studioWalletOpenAdd('plan', 12000)");
        const addPlan = wallet('add-money');
        for (const [label, html] of [['add', add], ['add for the plan', addPlan]]) {
          assert.ok(html.includes('data-testid="studio-wallet-add-flow"'), `${where} ${label}: never an empty screen`);
          assert.equal(html.includes('data-step="none"') && html.includes('data-testid="studio-wallet-done" onclick="studioWalletFinishAdd()"'), ios, `${where} ${label}: the neutral card with the way back`);
          assert.equal(/studio-wallet-purpose-|studio-wallet-preset-|id="studio-wallet-amount"|studio-wallet-add-step/.test(html), !ios, `${where} ${label}: before, the iPhone app drew the Add money steps`);
          if (ios) { onlyNeutral(html, language, 1, `${where} ${label}`); assert.ok(!BUY_WORDS[language].test(html) && !BUY_CALLS.test(html)); }
        }
        if (!ios) assert.ok(add.includes('data-step="1"') && add.includes('data-testid="studio-wallet-purpose-plan"') && addPlan.includes('data-step="2"'), `${where}: the steps as before`);
        // Five waiting requests: the "pay or cancel one to add more" note belongs to the Add money button.
        f.replies['/api/studio/wallet/summary'] = summary({}, [1, 2, 3, 4, 5].map(n => ({ reference: `PAY-FULL000${n}`, amountMinor: 1000, currency: 'USD', createdAt: '2026-09-25T08:00:00Z', dueAt: null })));
        f.run("studioDataWant('wallet', true)");
        await f.settled();
        const full = wallet('');
        assert.equal((full.match(/data-testid="studio-wallet-pending-item"/g) || []).length, 5, where);
        assert.equal(full.includes('id="studio-wallet-full"') && /data-testid="studio-wallet-add"[^>]* disabled/.test(full), !ios, `${where}: the five-requests note`);
        // The builder's wallet lines: the missing amount stays (the neutral explanation), "Add money" does not.
        f.replies['/api/studio/wallet/summary'] = summary({ availableMinor: 1000, addedMinor: 0 });
        f.run("studioDataWant('wallet', true)");
        await f.settled();
        const lines = String(f.run("studioBuilderWalletHtml({ draft: { budgetType: 'lifetime', budgetMinorUSD: 5000, durationDays: 5 } })"));
        assert.ok(lines.includes('data-testid="studio-builder-wallet-short"') && lines.includes('<bdi dir="ltr">$40.00</bdi>') && lines.includes('PAY-USDAAAA1'), `${where}: short by $40.00, the payment being confirmed`);
        assert.equal(lines.includes('data-testid="studio-builder-add-money" onclick="studioBuilderAddMoney()"'), !ios, `${where}: before, the iPhone builder offered Add money`);
        assert.equal(neutralLines(lines).length, ios ? 1 : 0, where);
        if (ios) { onlyNeutral(lines, language, 1, where); assert.ok(!BUY_WORDS[language].test(lines) && !/<button|onclick=/.test(lines), lines); }
        const enough = String(f.run("studioBuilderWalletHtml({ draft: { budgetType: 'lifetime', budgetMinorUSD: 500, durationDays: 5 } })"));
        assert.ok(!enough.includes('studio-no-purchase') && !enough.includes('studio-builder-add-money'), `${where}: enough money, nothing to say`);
        // Home with a plan and no ad money yet: Getting started offers "Add money" on the web only.
        f.run('renderStudioHomeBody()');
        await f.settled();
        const fresh = String(f.run('renderStudioHomeBody()'));
        assert.equal(fresh.includes('data-testid="studio-start-plan"') && fresh.includes('data-testid="studio-start-money"'), !ios, `${where}: the plan and money steps`);
        assert.equal(BUY_WORDS[language].test(fresh), !ios, `${where}: Home with a plan`);
        assert.ok(fresh.includes('data-testid="studio-start-page"') && fresh.includes('data-testid="studio-start-first"') && fresh.includes("onclick=\"studioHomeGoal('messages')\""), `${where}: the other steps stay`);

        // ---- a plan that ended: Home, the builder's banner, Pages
        f = studioAs(platform, language, 'ended', summary({ addedMinor: 0 }, []));
        f.run('renderStudioHomeBody()');
        await f.settled();
        const home = String(f.run('renderStudioHomeBody()'));
        const need = piece(home, 'data-testid="studio-need-plan"', '</li>');
        assert.ok(need.includes(en ? 'Your plan has ended' : 'انتهى اشتراكك'), `${where}: the plan-ended card stays`);
        assert.equal(need.includes(`onclick="showSubscriptionModal('ad_maker', 'ad_maker')"`), !ios, `${where}: before, the iPhone Home offered Renew`);
        assert.equal(need.includes(NO_BUY[language]) && !/<button/.test(need), ios, `${where}: ${need}`);
        assert.equal(BUY_CALLS.test(String(f.run('JSON.stringify(studioHomeNeeds([], null))'))), !ios, `${where}: the card's own data`);
        assert.equal(piece(home, 'data-testid="studio-start-plan"', '</li>').includes("showSubscriptionModal('ad_maker', 'ad_maker')"), !ios, `${where}: Activate in Getting started`);
        assert.equal(piece(home, 'data-testid="studio-start-money"', '</li>').includes("studioV2Open('wallet')"), !ios, `${where}: Add money in Getting started`);
        assert.equal(home.includes(en ? 'Activate your plan to start a new ad request.' : 'فعّل اشتراكك لتبدأ طلب إعلان جديد.'), !ios, where);
        assert.equal(home.includes(en ? 'Activate Ads Studio' : 'فعّل استوديو الإعلانات') && home.includes(en ? 'Activate service' : 'تفعيل الخدمة'), !ios, `${where}: the activate card`);
        assert.equal(BUY_WORDS[language].test(home) || BUY_CALLS.test(home), !ios, `${where}: Home after the plan ended`);
        if (ios) {
          onlyNeutral(home, language, 1, where);
          // The two steps left are numbered 1 and 2, and the wallet (read only) stays one tap away.
          assert.ok(/data-testid="studio-start-page"[^>]*>\s*<span class="studio-home-step-number" aria-hidden="true">1<\/span>/.test(home)
            && /data-testid="studio-start-first"[^>]*>\s*<span class="studio-home-step-number" aria-hidden="true">2<\/span>/.test(home), `${where}: the steps`);
          assert.ok(home.includes(en ? 'Your plan is not active.' : 'اشتراكك غير نشط.') && home.includes(en ? 'Ads Studio is not active on your account' : 'استوديو الإعلانات غير مفعّل في حسابك')
            && home.includes("onclick=\"studioV2Open('wallet')\""), where);
        }
        const banner = String(f.run("studioBuilderBanners({ status: 'ready' })"));
        assert.ok(banner.includes(en ? 'Your plan is not active.' : 'اشتراكك غير نشط.'), `${where}: the builder says why nothing is sent`);
        assert.equal(banner.includes(`onclick="showSubscriptionModal('ad_maker', 'ad_maker')"`) && banner.includes(en ? 'Activate the plan' : 'فعّل الاشتراك'), !ios, `${where}: before, the iPhone builder offered Activate the plan`);
        assert.equal(banner.includes(NO_BUY[language]) && !/<button|onclick=|<a\s/.test(banner), ios, `${where}: ${banner}`);
        f.run("studioV2Frame = () => 'customer'");  // the v2 layout, where Pages offered "Renew from Wallet"
        const pages = piece(String(f.run("renderStudioPagesBody({ tab: 'replies', section: 'pages', id: '', step: 0 })")), 'data-testid="studio-pg-plan-ended"', '</section>');
        assert.ok(pages.includes(en ? 'Your plan has ended' : 'انتهى اشتراكك') && pages.includes(en ? 'Nothing of yours was removed.' : 'لم يُحذف شيء مما لديك.'), `${where}: Pages`);
        assert.equal(pages.includes(`data-testid="studio-pg-renew" onclick="studioV2Open('wallet')"`), !ios, `${where}: before, the iPhone Pages screen offered Renew from Wallet`);
        assert.equal(neutralLines(pages).length, ios ? 1 : 0, where);
        if (ios) { onlyNeutral(pages, language, 1, where); assert.ok(!BUY_WORDS[language].test(pages) && !/<button|onclick=/.test(pages) && !/renew|تجديد/.test(pages), pages); }
      }
    });

    await test('F-iap-lazy: the classic studio in the iPhone app has no activate card button, no Add money form and no receipt upload, and says "not enough balance" without "charge first"; admins keep the payments list; the web and the Android app are unchanged', async () => {
      const adminRows = {};
      for (const [platform, language] of combos) {
        const ios = platform === 'ios';
        const where = `${platform} ${language}`;
        const en = language === 'en';
        // ---- no plan: the activate card; with an old campaign: the banner above it
        let f = studioAs(platform, language, 'ended');
        f.sandbox.renderStudioV2View = () => '';  // the classic layout
        const gate = String(f.run('renderAdsStudioView()'));
        assert.equal(gate.includes(en ? 'Activate Ads Studio' : 'فعّل استوديو الإعلانات') && gate.includes(en ? 'Activate service' : 'تفعيل الخدمة')
          && gate.includes(`onclick="showSubscriptionModal('ad_maker', 'ad_maker')"`), !ios, `${where}: before, the iPhone app drew "Activate service"`);
        assert.equal(gate.includes(en ? 'Ads Studio is not active on your account' : 'استوديو الإعلانات غير مفعّل في حسابك') && neutralLines(gate).length === 1, ios, `${where}: the neutral card`);
        assert.ok(gate.includes('onclick="handleLogout()"') && gate.includes('onclick="toggleLanguage()"'), `${where}: never a dead end`);
        if (ios) { onlyNeutral(gate, language, 1, where); assert.ok(!BUY_WORDS[language].test(gate) && !BUY_CALLS.test(gate), `${where}: nothing to buy`); }
        f.state.adCampaignRequests = [{ id: 'adreq_1', status: 'Approved', createdBy: 'cust1', name: 'Old campaign', budgetType: 'lifetime', budgetMinorUSD: 2000, paidMinorUSD: 2000 }];
        const lapsed = String(f.run('renderAdsStudioView()'));
        assert.ok(lapsed.includes(en ? 'Your subscription has ended. You can still see your campaigns' : 'انتهى اشتراكك. لا يزال بإمكانك رؤية حملاتك') && lapsed.includes('Old campaign'), `${where}: the campaigns stay`);
        assert.equal(lapsed.includes(en ? 'to your wallet. Activate the service to create new campaigns.</span>' : 'إلى محفظتك. فعّل الخدمة لإنشاء حملات جديدة.</span>'), !ios, `${where}: the banner's last sentence`);
        assert.equal(BUY_WORDS[language].test(lapsed) || /showSubscriptionModal/.test(lapsed), !ios, `${where}: the lapsed customer's screen`);
        assert.equal(f.run("adsStudioRefusalText('Insufficient wallet balance')"), en ? 'Insufficient wallet balance'
          : (ios ? 'رصيد المحفظة لا يكفي لهذه الميزانية' : 'رصيد المحفظة لا يكفي لهذه الميزانية — اشحن المحفظة أولاً'), `${where}: the server's balance refusal`);
        // A send the server refuses for the balance ends in "charge the wallet first" (ad_campaign_actions.py), and English
        // readers get the server's own words: the iPhone app drops that tail too, in the classic layout and in the builder.
        const refusedSend = 'Insufficient wallet balance for this budget — charge the wallet first';
        const refusedSays = en ? (ios ? 'Insufficient wallet balance for this budget' : refusedSend)
          : (ios ? 'رصيد المحفظة لا يكفي لهذه الميزانية' : 'رصيد المحفظة لا يكفي لهذه الميزانية — اشحن المحفظة أولاً');
        assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server', 'systems', 'ads_studio', 'ad_campaign_actions.py'), 'utf8').includes(`detail="${refusedSend}"`), 'the server words this refusal differently now: update the iPhone rule in adsStudioRefusalText');
        assert.equal(f.run(`adsStudioRefusalText(${JSON.stringify(refusedSend)})`), refusedSays, `${where}: before, the iPhone app told an English reader to charge the wallet first`);
        assert.equal(f.run(`studioErrorInfo({ status: 409, message: ${JSON.stringify(refusedSend)}, payload: { detail: ${JSON.stringify(refusedSend)} } }, 'action').text`), refusedSays, `${where}: the same refusal in the request builder`);
        assert.equal(f.run("adsStudioRefusalText('Stop the campaign first')"), en ? 'Stop the campaign first' : 'أوقف الحملة أولاً حتى تعود الميزانية غير المصروفة إلى المحفظة', `${where}: the other refusals`);

        // ---- an active plan: the wallet on the Overview
        f = studioAs(platform, language, 'active');
        f.sandbox.renderStudioV2View = () => '';
        f.run(`_adsStudioWalletForUser = 'cust1'; _adsStudioPayMethods = ${JSON.stringify(methods)}; _adsStudioPayRate = { usdToLyd: 6.9 };
          _adsStudioWalletMine = ${JSON.stringify(payments)}; _adsStudioWalletPendingAll = [];`);
        const classic = String(f.run('renderAdsStudioWallet()'));
        assert.ok(classic.includes(en ? 'Wallet balance' : 'رصيد المحفظة') && classic.includes(en ? 'Available to spend' : 'متاح للصرف'), `${where}: the balances stay`);
        assert.ok(['PAY-USDAAAA1', 'PAY-LYDBBBB2', 'PAY-DONECCC3'].every(code => classic.includes(code)) && classic.includes(`onclick="adsStudioDecideWalletCharge('wpr_1', 'cancel')"`), `${where}: the requests and Cancel stay`);
        assert.equal(classic.includes('id="ads-studio-charge-amount"') && classic.includes('onclick="adsStudioCreateWalletCharge()"') && classic.includes(en ? 'Create charge request' : 'إنشاء طلب شحن'), !ios, `${where}: before, the iPhone app drew the Add money form`);
        assert.equal(classic.includes(`onchange="adsStudioAttachReceipt('wpr_2', this)"`), !ios, `${where}: the receipt upload`);
        assert.equal(classic.includes(`150.00 ${en ? 'LYD' : 'د.ل'} • ${en ? 'Bank transfer' : 'حوالة مصرفية'}`) && classic.includes('≈ 172.50 LYD'), !ios, `${where}: how a waiting request is paid`);
        assert.ok(classic.includes(`$100.00 • ${en ? 'Adfali' : 'ادفع لي'}`), `${where}: a confirmed payment keeps its method (history)`);
        assert.equal(neutralLines(classic).length, ios ? 1 : 0, where);
        if (ios) { onlyNeutral(classic, language, 1, where); assert.ok(!BUY_WORDS[language].test(classic) && !BUY_CALLS.test(classic), `${where}: nothing to buy`); }
        // An admin's list of everyone's payments (confirm, receipt) is the same on every platform.
        const adminRow = String(f.run(`_adsStudioWalletRequestRow(${JSON.stringify(payments[1])}, true)`));
        adminRows[language] = adminRows[language] || adminRow;
        assert.ok(adminRow === adminRows[language] && adminRow.includes(`adsStudioDecideWalletCharge('wpr_2', 'confirm')`) && adminRow.includes(en ? 'Bank transfer' : 'حوالة مصرفية'), `${where}: the admin row`);
        // The budget step's wallet line: what is missing, and "Add money before you send" on the web and Android only.
        const missing = en ? 'Available in your wallet: $0.00 — short by $70.00.' : 'المتاح في محفظتك: $0.00 — ينقصك $70.00.';
        assert.equal(String(f.run("adsStudioBudgetWalletText({ budgetType: 'daily', budgetMinorUSD: 1000, durationDays: 7 })")),
          ios ? missing : `${missing} ${en ? 'Add money before you send.' : 'أضف رصيداً قبل الإرسال.'}`, `${where}: the budget step`);
        // Sending a request the balance does not cover: the reason, and no "charge first" in the iPhone app.
        f.state.adCampaignRequests = [{ id: 'short1', status: 'Draft', createdBy: 'cust1', name: 'Daily check', objective: 'messages', platforms: ['facebook'], pageName: 'Page',
          primaryText: 'Copy', destination: '+218900000000', creativeImages: ['data:image/png;base64,AAAA'], locations: ['Libya'], ageMin: 18, ageMax: 65,
          startDate: '2099-01-01', endDate: '2099-01-07', durationDays: 7, budgetType: 'daily', budgetMinorUSD: 1000, _lastModified: 5 }];
        f.run('_adsStudioIntakeOpen = null;');
        f.notes.length = 0;
        assert.equal(await f.run("submitAdsStudioCampaignOnce('short1')"), false);
        const expected = en
          ? [`${ios ? 'Your balance is not enough for this request' : 'Charge your wallet first'} — the total budget ($70.00) is held from it when you submit.`, 'Not enough wallet balance']
          : [`${ios ? 'رصيد محفظتك لا يكفي لهذا الطلب' : 'اشحن محفظتك أولاً'} — إجمالي الميزانية ($70.00) يُحجز منها عند الإرسال.`, 'رصيد المحفظة غير كافٍ'];
        assert.deepEqual(f.notes.map(note => [note.message, note.title, note.type]), [[...expected, 'error']], `${where}: the balance check before sending`);
      }
    });
  }

  await test('R4 xss-injection-sweep-1: a quote stored in a receipt payment row stays inside its attribute on every receipt editor', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    // What a staff account with only "Create receipts" could store in a payment row.
    const row = { method: 'Cash" onfocus="C', amount: '1" onfocus="A', rate: '1" onfocus="B', rate2: '7" autofocus onfocus="X', collectionType: 'office" data-x="1' };
    const planted = /onfocus="[ABCX]"|data-x="1"|"\s+autofocus/;
    const safe = (html, where) => {
      assert.doesNotMatch(html, planted, `${where}: the stored value became an attribute`);
      assert.match(html, /&quot;/, `${where}: the value was not kept as text`);
    };
    safe(run('renderReceiptFinancials')([row], [row], []), 'one payment');
    safe(run('renderReceiptFinancials')([row, { ...row }], [row, { ...row }], []), 'split payments');
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    state.activeModal = 'split-payments';
    state.modalData = { id: 'r1', amountUSD: 10, amountLocal: 97, exchangeRate: 9.7, payments: [row] };
    sandbox.renderModal();
    safe(made.map(el => String(el.innerHTML || '')).join('\n'), 'Manage Split Payments');
    run("_collectTargetLYD = 97; _tempCollectPayments = [{ method: 'Cash\" onfocus=\"C', amount: '97' }]");
    safe(sandbox._collectEditorView('r1', state.modalData), 'collect editor');
  });
  await test('R4 concurrency-idempotency-4: a new receipt whose app number another cashier just took saves with the next free one; a paper number still stops', async () => {
    const { sandbox, state } = loadBrowserSource();
    state.serverMode = true;
    state.currentUser = { id: 'cashier_b', role: 'Employee', name: 'Cashier B', permissions: { receipts: ['view', 'add', 'edit'], customers: ['view'] } };
    state.users = [state.currentUser];
    state.customers = [{ id: 'cust_1', name: 'Customer One', phones: ['0912345678'] }, { id: 'cust_2', name: 'Customer Two', phones: ['0923456789'] }];
    const paid = (id, serialNumber, method) => ({ id, customerId: 'cust_2', status: 'Paid', isPaid: true, paymentMethod: method,
      payments: [{ method, amount: 50, rate: 1, rate2: 9.7 }], serialNumber, amountUSD: 5.16, _lastModified: 2 });
    state.receipts = [paid('r41', 'S41', 'Libyana')];
    const el = props => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, contains() { return false; } }, focus() {}, ...props });
    const ids = {};
    const openForm = (method, serial) => {
      const cells = { '.payment-method': method, '.payment-amount': '100', '.payment-rate1': '1', '.payment-rate2': '9.7', '.collection-type': 'office' };
      const row = el({ querySelector: sel => (sel in cells ? el({ value: cells[sel] }) : null) });
      sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? [row] : []);
      Object.assign(ids, { 'receipt-editing-id': el({ value: '' }), 'receipt-customer-id': el({ value: 'cust_1' }), 'receipt-status': el({ value: 'Paid' }),
        'receipt-serial': el({ value: serial, readOnly: true }), 'receipt-serial-error': el({}), 'paid-collection-value': el({ value: 'office' }),
        'receipt-phone-search': el({ value: '0912345678' }) });
    };
    sandbox.document.getElementById = id => ids[id] || null;
    sandbox.requireReceiptCustomerRiskAcknowledgement = () => false;
    const dialogs = [];
    const sent = [];
    const notes = [];
    let echo = record => record;
    sandbox.showDuplicateReceiptWarning = number => dialogs.push(number);
    sandbox.apiCreateEntity = async (collection, record) => { sent.push(record); return { id: record.id, data: echo({ ...record }) }; };
    sandbox.showNotification = (title, message) => notes.push(`${title}: ${message}`);
    // B's form shows S42 for Libyana; cashier A's S42 arrives by live sync before B taps Save.
    openForm('Libyana', sandbox.getNextAutoSerialNumber('Libyana'));
    assert.equal(ids['receipt-serial'].value, 'S42');
    sandbox.applyServerDelta('receipts', [paid('r42_a', 'S42', 'Libyana')]);
    await sandbox._saveReceiptFromModalInner();
    assert.deepEqual(dialogs, [], 'before: "Receipt Number Already Exists" on every Save, with a read-only number');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].serialNumber, 'S43');
    assert.equal(sent[0].finalReceiptNo, 'S43');
    assert.equal(ids['receipt-serial'].value, 'S43');
    assert.ok(notes.includes('Receipt number changed: Receipt number changed to S43 (S42 was just used by another receipt).'), notes.join(' | '));
    // The server handed out another free number itself: the cashier is told that one too.
    echo = record => ({ ...record, serialNumber: 'S45', finalReceiptNo: 'S45' });
    openForm('Libyana', sandbox.getNextAutoSerialNumber('Libyana'));
    notes.length = 0;
    await sandbox._saveReceiptFromModalInner();
    assert.equal(sent[1].serialNumber, 'S44');
    assert.ok(notes.includes('Receipt number changed: Receipt number changed to S45 (S44 was just used by another receipt).'), notes.join(' | '));
    // A retry after a lost reply accepts its own row with the server's number, never another receipt.
    assert.equal(sandbox.receiptCreateRetryMatches({ ...sent[1], serialNumber: 'S45', finalReceiptNo: 'S45' }, sent[1]), true);
    assert.equal(sandbox.receiptCreateRetryMatches({ ...sent[1], serialNumber: 'S45', finalReceiptNo: 'S45', amountUSD: 1 }, sent[1]), false);
    // A paper number that is already saved still stops with the duplicate dialog, and nothing is sent.
    state.receipts.push(paid('r_paper', '4521', 'Cash (LYD)'));
    openForm('Cash (LYD)', '4521');
    await sandbox._saveReceiptFromModalInner();
    assert.deepEqual(dialogs, ['4521']);
    assert.equal(sent.length, 2);
  });

  // ---- R6 receipts-flows (bug-hunt round 6): the receipt form driven through its real serial, status and save code ----
  // `fields`: the rendered form's values (other ids are blank elements); `rows`: its payment rows. Saves are captured.
  function r6ReceiptForm({ user, customers, receipts = [], modalData = null, fields = {}, rows = [] } = {}) {
    const fixture = loadBrowserSource();
    const { sandbox, state, run } = fixture;
    realRandom(fixture);
    run('Security').escapeHtml = plainEscape;
    state.serverMode = true;
    state.currentUser = user || { id: 'admin', role: 'Admin', permissions: {}, name: 'Office Admin' };
    state.users = [state.currentUser, { id: 'drv1', role: 'Delivery', name: 'Driver', permissions: {} }];
    state.customers = customers || [{ id: 'c1', name: 'Customer One', platform: 'Facebook', phones: ['0912345678', '0923456789'] }];
    state.receipts = receipts;
    state.activeModal = 'receipt';
    state.modalData = modalData;
    const el = (id, value = '') => ({ id, value: String(value), dataset: {}, style: {}, disabled: false, readOnly: false, checked: false, placeholder: '',
      title: '', textContent: '', innerHTML: '', isConnected: true, classList: fakeClassList(), closest: () => null, querySelector: () => null,
      querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null, addEventListener() {}, focus() {}, remove() { this.isConnected = false; } });
    const els = new Map(Object.entries({ 'receipt-editing-id': modalData?.id || '', 'receipt-customer-id': modalData?.customerId || '',
      'receipt-status': 'Paid', 'paid-collection-value': 'office', 'notpaid-collection-value': 'office', 'receipt-quoted-delivery-fee': '0', ...fields })
      .map(([id, value]) => [id, el(id, value)]));
    sandbox.document.getElementById = id => els.get(id) || els.set(id, el(id)).get(id);
    const rowEls = rows.map(r => {
      const row = el('');
      const cells = { '.payment-method': r.method, '.payment-amount': r.amount, '.payment-rate1': r.rate1, '.payment-rate2': r.rate2,
        '.collection-type': r.collectionType || 'office', '.delivery-person': r.deliveryPersonId || '', '.payment-r1-display': '', '.payment-r2-display': '' };
      for (const sel of Object.keys(cells)) cells[sel] = Object.assign(el(''), { value: String(cells[sel]), closest: () => row });
      row.querySelector = sel => cells[sel] || null;
      return row;
    });
    sandbox.document.querySelectorAll = sel => (sel === '.payment-split-item' ? rowEls : []);
    sandbox.document.querySelector = () => null;
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const saved = [];
    sandbox.updateRecord = async (array, id, record) => { saved.push(record); return true; };
    const posted = [];
    sandbox.apiCreateEntity = async (collection, record) => { posted.push(record); return { id: record.id, data: { ...record } }; };
    sandbox.requireReceiptCustomerRiskAcknowledgement = () => false;
    sandbox.addLog = () => {};
    sandbox.clearUrlParams = () => {};
    return { ...fixture, rows: rowEls, notes, saved, posted, field: id => sandbox.document.getElementById(id) };
  }

  await test('R6 receipts-flows-1: a new receipt whose save landed but lost its answer is recognised although the server stored rate 0 as 0.001 and 67.89999999999999 as 67.9', async () => {
    const { run } = loadBrowserSource();
    const matches = run('receiptCreateRetryMatches');
    // What the form sent, and the row the real POST /api/collections/receipts stored for it (its retry then met 409).
    const sent = { id: 'receipt_ec3e2cd9', recordType: 'receipt', customerId: 'customers_b042f3e1', pageId: '', creatorId: 'user_2519', status: 'Paid',
      statusDetail: { paidCollection: 'office', paidDeliveryPersonId: '', notPaidCollection: 'office', allowSerialOverride: false, refundAction: '', refundStatus: '', lostResolution: '' },
      isPaid: true, deliveryStatus: 'Office', deliveryPersonId: '', isReceivedInOffice: true, startDate: '2026-10-02T05:00:00.000Z', endDate: '2026-10-02T05:00:00.000Z',
      createdAt: '2026-10-02T05:00:00.000Z', receiptType: '', deliveryPlaceName: '', deliveryInstructions: '', quotedDeliveryFee: 0, officeFee: 0, discount: 0,
      phoneNumber: '', collectionDate: '2026-10-02T05:00:00.000Z', plannedPayments: [], photos: [], amountUSD: 14.3, exchangeRate: 7, amountLocal: 0,
      paymentMethod: 'LTT', serialNumber: 'S975158', finalReceiptNo: 'S975158', tempReceiptNo: '',
      payments: [{ method: 'LTT', amount: 100, rate: 0, rate2: 7, collectionType: 'office', deliveryPersonId: '' }] };
    const stamps = { _lastModified: 1790909910071, _created: 1790909910071, createdBy: 'user_2519', createdByName: 'admin', customerName: 'R6 Cust aed760fb' };
    const pay = (method, amount, rate, rate2) => [{ method, amount, rate, rate2, collectionType: 'office', deliveryPersonId: '' }];
    const libyana = { ...sent, paymentMethod: 'Libyana', amountUSD: 10, amountLocal: 67.89999999999999, exchangeRate: 9.7, serialNumber: 'S839034',
      finalReceiptNo: 'S839034', payments: pay('Libyana', 97, 0.7, 9.7) };
    const cash = { ...sent, paymentMethod: 'Cash (LYD)', amountUSD: 100, amountLocal: 700, serialNumber: '737664', finalReceiptNo: '737664',
      payments: pay('Cash (LYD)', 700, 1, 7) };
    const bank = { ...sent, status: 'Not Paid', isPaid: false, isReceivedInOffice: false, collectionDate: '', paymentMethod: 'Bank Transfer (LYD)',
      amountUSD: 100, serialNumber: '', finalReceiptNo: '', payments: [], plannedPayments: pay('Bank Transfer (LYD)', 700, 0, 7) };
    const pairs = {
      ltt_paid: [sent, { ...sent, ...stamps, payments: pay('LTT', 100, 0.001, 7) }],
      libyana_paid: [libyana, { ...libyana, ...stamps, amountLocal: 67.9 }],
      notpaid_bank: [bank, { ...bank, ...stamps, plannedPayments: pay('Bank Transfer (LYD)', 700, 0.001, 7) }],
      cash_paid: [cash, { ...cash, ...stamps }],
      split: [{ ...cash, exchangeRate: 9.683333333 }, { ...cash, ...stamps, exchangeRate: 9.6833 }]
    };
    for (const [name, [request, stored]] of Object.entries(pairs)) {
      assert.equal(matches(JSON.parse(JSON.stringify(stored)), request), true, `${name}: before, every Save said "ID already exists"`);
    }
    // Another amount or another customer under that id is still another receipt.
    const [request, stored] = pairs.ltt_paid;
    assert.equal(matches({ ...stored, payments: pay('LTT', 101, 0.001, 7) }, request), false);
    assert.equal(matches({ ...stored, customerId: 'customers_other' }, request), false);
    assert.equal(matches({ ...stored, amountUSD: 14.31 }, request), false);
    // End to end: the form's first POST stored the row but its answer was lost, so the retry meets 409.
    const form = r6ReceiptForm({ fields: { 'receipt-customer-id': 'c1', 'receipt-phone-search': '0912345678' },
      receipts: [{ id: 'old', recordType: 'receipt', status: 'Paid', paymentMethod: 'LTT', serialNumber: 'S41', payments: [{ method: 'LTT', amount: 50 }] }],
      rows: [{ method: 'LTT', amount: 100, rate1: '0.00', rate2: '7.00' }] });
    let row = null;
    form.sandbox.apiCreateEntity = async (collection, record) => {
      // The server keeps Rate 1 = 0 as 0.001 (validate_exchange_rate) and stamps the row.
      row = { ...JSON.parse(JSON.stringify(record)), ...stamps, payments: record.payments.map(p => ({ ...p, rate: Math.max(p.rate, 0.001) })) };
      throw Object.assign(new Error('ID already exists'), { status: 409 });
    };
    form.sandbox.apiGetEntity = async (collection, id) => (row && row.id === id ? { id, data: row } : null);
    form.run('initReceiptSerialOnOpen()');
    await form.run('_saveReceiptFromModalInner()');
    assert.equal(row.payments[0].rate, 0.001);
    assert.ok(!form.notes.some(n => n.type === 'error'), JSON.stringify(form.notes));  // before: "Failed to create receipt: ID already exists"
    assert.equal(form.notes[form.notes.length - 1].message, 'Receipt created successfully!');
    assert.equal(form.state.activeModal, null, 'the form closes');
    assert.ok(form.state.receipts.some(r => r.id === row.id), 'the receipt is listed');
  });

  await test('R6 receipts-flows-2: editing a Not Paid receipt keeps the D-number and paper number it has, and staff keep an Admin\'s number', async () => {
    // (a) Underpaid and already delivered (D5, paper 12345, still Not Paid): the office only fixes the phone.
    const delivered = { id: 'r1', recordType: 'receipt', customerId: 'c1', status: 'Not Paid', isPaid: false,
      statusDetail: { notPaidCollection: 'delivery', paidCollection: 'office' }, deliveryStatus: 'Delivered', deliveryPersonId: 'drv1',
      isReceivedInOffice: false, tempReceiptNo: 'D5', serialNumber: '12345', finalReceiptNo: '12345', receiptType: 'DELIVERY_TEMP',
      amountLocal: 300, amountUSD: 30, exchangeRate: 10, debtAmountLocal: 500, debtAmountUSD: 50, amountCollectedFromCustomer: 300,
      paymentResult: 'UNDERPAID', remainingDue: 200, payments: [{ method: 'Cash (LYD)', amount: 300, rate: 1, rate2: 10, collectionType: 'delivery' }],
      plannedPayments: [{ method: 'Cash (LYD)', amount: 500, rate: 1, rate2: 10, collectionType: 'delivery', deliveryPersonId: 'drv1' }],
      deliveryPlaceName: 'Hay Andalus', quotedDeliveryFee: 10, phoneNumber: '0912345678', createdBy: 'admin', createdAt: '2026-09-01T10:00:00.000Z', _lastModified: 1000 };
    const a = r6ReceiptForm({ receipts: [delivered], modalData: delivered,
      fields: { 'receipt-status': 'Not Paid', 'notpaid-collection-value': 'delivery', 'notpaid-delivery-person': 'drv1', 'receipt-serial': '12345',
        'receipt-delivery-place': 'Hay Andalus', 'receipt-quoted-delivery-fee': '10', 'receipt-phone-search': '0912345678' },
      rows: [{ method: 'Cash (LYD)', amount: 500, rate1: 1, rate2: 10, collectionType: 'delivery', deliveryPersonId: 'drv1' }] });
    a.run('initReceiptSerialOnOpen()');
    a.run("updateReceiptStatusUI('Not Paid')");
    assert.equal(a.field('receipt-serial').value, 'D5', 'before: blank, "assigned when saved"');
    assert.ok(a.field('receipt-serial').disabled && a.field('receipt-serial').readOnly);
    a.field('receipt-phone-search').value = '0923456789';
    await a.run('_saveReceiptFromModalInner()');
    assert.equal(a.saved.length, 1, JSON.stringify(a.notes));
    const patch = a.saved[0];
    assert.deepEqual([patch.tempReceiptNo, patch.serialNumber, patch.finalReceiptNo], ['D5', '12345', '12345'], "before: tempReceiptNo '' and serialNumber ''");
    assert.equal(patch.phoneNumber, '0923456789');
    assert.ok(!patch.editHistory.slice(-1)[0].changes.some(c => c.field === 'Serial Number'));
    // (b) An Admin saved a Not Paid in-shop receipt with its paper number; an Employee with receipts.edit fixes the phone.
    const numbered = { id: 'r2', recordType: 'receipt', customerId: 'c1', status: 'Not Paid', isPaid: false,
      statusDetail: { notPaidCollection: 'office', paidCollection: 'office', allowSerialOverride: true }, deliveryStatus: 'Office', deliveryPersonId: '',
      isReceivedInOffice: false, tempReceiptNo: '', serialNumber: '385454', finalReceiptNo: '385454', receiptType: '', amountLocal: 700, amountUSD: 100,
      exchangeRate: 7, payments: [], plannedPayments: [{ method: 'Cash (LYD)', amount: 700, rate: 1, rate2: 7, collectionType: 'office', deliveryPersonId: '' }],
      phoneNumber: '0912345678', createdBy: 'admin', createdAt: '2026-09-01T10:00:00.000Z', _lastModified: 2000 };
    const cashier = { id: 'emp1', role: 'Employee', name: 'Cashier', permissions: { receipts: ['view', 'edit', 'add'], customers: ['view', 'viewContacts'] } };
    const openNumbered = stored => {
      const f = r6ReceiptForm({ user: cashier, receipts: [stored], modalData: stored,
        fields: { 'receipt-status': 'Not Paid', 'receipt-serial': stored.serialNumber, 'receipt-phone-search': '0912345678' },
        rows: [{ method: 'Cash (LYD)', amount: 700, rate1: 1, rate2: 7 }] });
      f.field('status-not-paid-admin-override').checked = !!stored.statusDetail.allowSerialOverride;  // ticked by the template
      f.run('initReceiptSerialOnOpen()');
      f.run("updateReceiptStatusUI('Not Paid')");
      f.field('receipt-phone-search').value = '0923456789';
      return f;
    };
    const b = openNumbered(numbered);
    assert.ok(b.field('receipt-serial').disabled, 'staff still cannot type a number');
    await b.run('_saveReceiptFromModalInner()');
    assert.equal(b.saved.length, 1, JSON.stringify(b.notes));
    assert.deepEqual([b.saved[0].serialNumber, b.saved[0].finalReceiptNo, b.saved[0].statusDetail.allowSerialOverride], ['385454', '385454', true],
      "before: '', '' and false (the paper number was free for another receipt)");
    // A Not Paid receipt without a number gets none from staff, whatever the field holds.
    const plain = openNumbered({ ...numbered, serialNumber: '', finalReceiptNo: '', statusDetail: { notPaidCollection: 'office', paidCollection: 'office' } });
    plain.field('receipt-serial').value = '777';
    await plain.run('_saveReceiptFromModalInner()');
    assert.deepEqual([plain.saved[0].serialNumber, plain.saved[0].finalReceiptNo, plain.saved[0].statusDetail.allowSerialOverride], ['', '', false]);
  });

  await test('R6 receipts-flows-4: the stock Accountant (no View contacts) finds a customer by name, saves a receipt, and cannot move one to another customer', async () => {
    // The customer rows GET /api/collections/customers returns to this role: every contact field removed.
    const phoneless = [{ name: 'Picker Cust 5e521363', platform: 'Facebook', _lastModified: 1790910631467, id: 'customers_916bccf7', _created: 1790910631467,
      createdBy: 'user_9394', createdByName: 'admin', _deleted: false }, { name: 'Other Cust', platform: 'Instagram', id: 'customers_other', _deleted: false }];
    const asAccountant = f => {
      f.state.currentUser = { id: 'acct', role: 'Employee', name: 'Accountant', permissions: f.run('PERMISSION_TEMPLATES').accountant.permissions };
      f.state.users = [f.state.currentUser];
      return f;
    };
    const form = asAccountant(r6ReceiptForm({ customers: phoneless, fields: { 'receipt-serial': '12345' }, rows: [{ method: 'Cash (LYD)', amount: 700, rate1: 1, rate2: 7 }] }));
    assert.equal(form.run('can')('customers', 'viewContacts'), false);
    assert.equal(form.run('getReceiptPhoneRows().length'), 2, 'before: 0 rows');
    form.field('receipt-phone-search').value = 'Picker';
    form.run('showReceiptPhoneDropdown()');
    const dropdown = form.field('receipt-phone-dropdown');
    assert.ok(!dropdown.classList.contains('hidden') && dropdown.innerHTML.includes('Picker Cust 5e521363'), 'before: the dropdown stayed hidden');
    assert.ok(dropdown.innerHTML.includes('data-phone=""') && dropdown.innerHTML.includes('—') && !dropdown.innerHTML.includes('Other Cust'));
    assert.equal(form.run("selectReceiptPhone('', 'customers_916bccf7')"), true);  // the row's onclick
    assert.equal(form.field('receipt-customer-name').value, 'Picker Cust 5e521363');
    await form.run('_saveReceiptFromModalInner()');
    assert.equal(form.posted.length, 1, JSON.stringify(form.notes));  // before: "Please select a customer by phone"
    assert.equal(form.posted[0].customerId, 'customers_916bccf7');
    assert.equal(form.posted[0].phoneNumber, '');
    // Editing one of their receipts: the opened form shows the customer's name (the pre-fill needed a phone).
    const stored = { id: 'r9', recordType: 'receipt', customerId: 'customers_916bccf7', status: 'Paid', isPaid: true, serialNumber: '4521', finalReceiptNo: '4521',
      amountUSD: 100, amountLocal: 700, exchangeRate: 7, payments: [{ method: 'Cash (LYD)', amount: 700, rate: 1, rate2: 7, collectionType: 'office' }],
      phoneNumber: '0910000000', createdBy: 'acct', createdAt: '2026-09-01T10:00:00.000Z', _lastModified: 5 };
    const edit = asAccountant(r6ReceiptForm({ customers: phoneless, receipts: [stored], modalData: stored, fields: { 'receipt-customer-id': '', 'receipt-serial': '4521' },
      rows: [{ method: 'Cash (LYD)', amount: 700, rate1: 1, rate2: 7 }] }));
    const timers = [];
    edit.sandbox.setTimeout = fn => { timers.push(fn); return 1; };
    edit.sandbox.renderModal();
    timers.forEach(fn => fn());
    assert.equal(edit.field('receipt-customer-name').value, 'Picker Cust 5e521363', 'before: blank');
    assert.equal(edit.field('receipt-customer-id').value, 'customers_916bccf7');
    // Moving it to another customer would keep the old customer's hidden phone: refused, the form stays open.
    edit.field('receipt-customer-id').value = 'customers_other';
    await edit.run('_saveReceiptFromModalInner()');
    assert.equal(edit.saved.length, 0);
    assert.equal(edit.notes.pop().message, 'Moving this receipt to another customer needs the View contacts permission.');
    assert.equal(edit.state.activeModal, 'receipt');
    edit.field('receipt-customer-id').value = 'customers_916bccf7';
    await edit.run('_saveReceiptFromModalInner()');
    assert.equal(edit.saved.length, 1, JSON.stringify(edit.notes));
    assert.ok(!('phoneNumber' in edit.saved[0]), 'the stored phone is left alone');
    // Staff who see contacts still get one row per phone.
    const staff = r6ReceiptForm();
    assert.deepEqual(Array.from(staff.run('getReceiptPhoneRows()'), r => r.phone), ['0912345678', '0923456789']);
  });

  await test('R6 receipts-flows-5: delivery receipts on LTT save: a Not Paid receipt takes no shop number, and a D-receipt paid in the shop gets one', async () => {
    const lastS = { id: 'old', recordType: 'receipt', status: 'Paid', paymentMethod: 'LTT', serialNumber: 'S41', payments: [{ method: 'LTT', amount: 50 }] };
    // (a) New receipt: Not Paid, Delivery, then the method becomes LTT (the customer pays the driver by LTT).
    const a = r6ReceiptForm({ receipts: [lastS], fields: { 'receipt-customer-id': 'c1', 'notpaid-delivery-person': 'drv1', 'receipt-delivery-place': 'Hay Andalus',
      'receipt-quoted-delivery-fee': '10', 'receipt-phone-search': '0912345678' },
    rows: [{ method: 'Cash (LYD)', amount: 100, rate1: '1.00', rate2: '7.00', deliveryPersonId: 'drv1' }] });
    a.run('initReceiptSerialOnOpen()');
    a.field('receipt-status').value = 'Not Paid';
    a.run("updateReceiptStatusUI('Not Paid')");
    a.run("selectNotPaidCollection('delivery')");
    const method = a.rows[0].querySelector('.payment-method');
    method.value = 'LTT';
    a.sandbox.onPaymentMethodChange(method);
    assert.equal(a.field('receipt-serial').value, '', 'before: S42 in the locked field');
    await a.run('_saveReceiptFromModalInner()');
    assert.ok(!a.notes.some(n => n.type === 'error'), JSON.stringify(a.notes));  // before: "Temporary receipt number must look like D12, D13, ..."
    assert.equal(a.posted.length, 1);
    assert.deepEqual([a.posted[0].tempReceiptNo, a.posted[0].serialNumber], ['', ''], 'the server gives the D-number');
    // (b) A pending D5 receipt planned on LTT; the customer pays by LTT in the shop: Paid (In Office).
    const d5 = { id: 'r5', recordType: 'receipt', customerId: 'c1', status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery', paidCollection: 'office' },
      deliveryStatus: 'Needs Delivery', deliveryPersonId: 'drv1', isReceivedInOffice: false, tempReceiptNo: 'D5', serialNumber: '', finalReceiptNo: '',
      receiptType: 'DELIVERY_TEMP', amountLocal: 0, amountUSD: 14.3, exchangeRate: 7, debtAmountLocal: 0, debtAmountUSD: 14.3, payments: [],
      plannedPayments: [{ method: 'LTT', amount: 100, rate: 0, rate2: 7, collectionType: 'delivery', deliveryPersonId: 'drv1' }],
      deliveryPlaceName: 'Hay Andalus', quotedDeliveryFee: 10, phoneNumber: '0912345678', createdBy: 'admin', createdAt: '2026-09-01T10:00:00.000Z', _lastModified: 3000 };
    const openD5 = () => {
      const f = r6ReceiptForm({ receipts: [d5, lastS], modalData: d5, fields: { 'receipt-status': 'Not Paid', 'notpaid-collection-value': 'delivery',
        'notpaid-delivery-person': 'drv1', 'receipt-serial': 'D5', 'receipt-delivery-place': 'Hay Andalus', 'receipt-quoted-delivery-fee': '10',
        'receipt-phone-search': '0912345678' }, rows: [{ method: 'LTT', amount: 100, rate1: 0, rate2: 7, collectionType: 'delivery', deliveryPersonId: 'drv1' }] });
      f.run('initReceiptSerialOnOpen()');
      f.run("updateReceiptStatusUI('Not Paid')");
      assert.equal(f.field('receipt-serial').value, 'D5');
      f.field('receipt-status').value = 'Paid';
      f.run("updateReceiptStatusUI('Paid')");
      return f;
    };
    const b = openD5();
    assert.equal(b.field('receipt-serial').value, 'S42', 'before: D5 stayed in the locked field');
    await b.run('_saveReceiptFromModalInner()');
    assert.equal(b.saved.length, 1, JSON.stringify(b.notes));  // before: "Invalid Receipt Number", nothing sent
    assert.deepEqual([b.saved[0].serialNumber, b.saved[0].finalReceiptNo, b.saved[0].tempReceiptNo], ['S42', 'S42', 'D5']);
    // (c) Paid, then back to Delivery: the receipt's own D5 returns, never a blank tempReceiptNo.
    const c = openD5();
    c.field('receipt-status').value = 'Not Paid';
    c.run("updateReceiptStatusUI('Not Paid')");
    assert.equal(c.field('receipt-serial').value, 'D5');
    await c.run('_saveReceiptFromModalInner()');
    assert.equal(c.saved[0].tempReceiptNo, 'D5', JSON.stringify(c.notes));
    // (d) A new Paid LTT receipt still gets its S-number when the form opens.
    const d = r6ReceiptForm({ receipts: [lastS], fields: { 'receipt-customer-id': 'c1' }, rows: [{ method: 'LTT', amount: 100, rate1: '0.00', rate2: '7.00' }] });
    d.run('initReceiptSerialOnOpen()');
    d.run("updateReceiptStatusUI('Paid')");
    assert.equal(d.field('receipt-serial').value, 'S42');
  });

  await test('R6 ads-lifecycle-5: Edit Ad shows the customer the ad belongs to, marked, when its page now links another customer', () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    const els = new Map();
    const node = id => els.get(id) || els.set(id, { id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, classList: fakeClassList(),
      querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {}, setAttribute() {}, focus() {} }).get(id);
    sandbox.document.getElementById = node;
    sandbox.renderAdFundingList = () => {};
    sandbox.refreshAdTempReceiptOptions = () => {};
    state.customers = ['Ahmed (ad owner)', 'Bilal (page owner now)', 'Camil'].map((name, i) => ({ id: `c${'ABC'[i]}`, name, platform: 'Facebook' }));
    state.pages = [{ id: 'p1', name: 'Shop Page', customerIds: ['cB'] }, { id: 'p2', name: 'Two owners', customerIds: ['cB', 'cC'] }, { id: 'p3', name: 'No owner', customerIds: [] }];
    // The Edit Ad post-render init (src/15-modals.js): the template's hidden customer id, then the page, then the ad's customer.
    const openEdit = (pageId, customerId) => {
      els.clear();
      state.modalData = { id: 'ad1', customerId, pageId, status: 'Active', paymentStatus: 'paid' };
      node('ad-customer-id').value = customerId;
      sandbox.selectAdPage(pageId, true);
      sandbox.selectAdCustomer(customerId, true);
      return { card: node('ad-customer-display').innerHTML, hint: node('ad-customer-hint').textContent, saved: node('ad-customer-id').value };
    };
    const moved = openEdit('p1', 'cA');
    assert.ok(moved.card.includes('Ahmed (ad owner)') && !moved.card.includes('Bilal'), `before: the page's customer was shown: ${moved.card}`);
    assert.ok(moved.card.includes('Not linked to this page any more (kept from the saved ad)'));
    assert.equal(moved.hint, '(saved customer)', 'before: (auto-selected)');
    assert.equal(moved.saved, 'cA', 'Save keeps the ad on its own customer');
    for (const pageId of ['p2', 'p3']) {
      const other = openEdit(pageId, 'cA');
      assert.ok(other.card.includes('Ahmed (ad owner)') && other.card.includes('Not linked') && other.saved === 'cA', pageId);
    }
    // The ad's customer is the page's only customer: card and hint unchanged.
    const own = openEdit('p1', 'cB');
    assert.ok(own.card.includes('Bilal (page owner now)') && !own.card.includes('Not linked'));
    assert.equal(own.hint, '(auto-selected)');
    assert.equal(own.saved, 'cB');
    state.language = 'ar';
    const ar = openEdit('p1', 'cA');
    assert.ok(ar.card.includes('لم يعد مرتبطاً بهذه الصفحة (محفوظ من الإعلان)') && ar.hint === '(العميل المحفوظ)');
  });

  await test('R4 display-correctness-1: an audit filter pages past the newest 500 entries, and a partial trail says so with Load older entries', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    sandbox.isServerModeEnabled = () => true;
    state.currentView = 'audit';
    // One event every 30 minutes, newest first; GET /api/audit honours the (before_ts, before_id) cursor.
    const base = Date.parse('2026-09-30T12:00:00Z');
    const makeTrail = n => Array.from({ length: n }, (_, i) => ({ id: `log${String(i).padStart(5, '0')}`, ts: base - i * 1800000, user_id: '',
      action: i === 900 ? 'delete' : 'update', resource_type: 'receipts', message: i === 900 ? 'Deleted receipt R-900' : `Updated ${i}` }));
    let trail = makeTrail(1200);
    const calls = [];
    sandbox.apiJson = async url => {
      calls.push(String(url));
      const q = new URLSearchParams(String(url).split('?')[1]);
      const bts = q.has('before_ts') ? Number(q.get('before_ts')) : Infinity;
      const bid = q.get('before_id') || '';
      return trail.filter(r => r.ts < bts || (r.ts === bts && r.id < bid)).slice(0, Number(q.get('limit')));
    };
    const settleAudit = async () => { for (let i = 0; i < 100 && run('_auditFetchInFlight'); i++) await settle(); };
    const view = () => String(sandbox.renderAuditView());
    await sandbox.refreshServerAuditLogs({ force: true });
    assert.equal(state.serverLogs.length, 500);
    let page = view();
    assert.ok(page.includes('Newest 500 entries') && page.includes('Load older entries') && !page.includes('Records available to you'),
      'before: "Records available to you" over only the newest 500');
    assert.equal(calls.length, 1, 'no filter: only the newest page is read');
    // A date filter on the day of an entry older than the newest 500: the screen pages back by itself.
    const day = new Date(trail[900].ts);
    const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    Object.assign(state, { auditDateFrom: ymd, auditDateTo: ymd });
    view();
    await settleAudit();
    assert.ok(calls[1].includes(`&before_ts=${trail[499].ts}&before_id=log00499`), calls[1]);
    page = view();
    assert.ok(page.includes('Deleted receipt R-900'), 'before: "No logs match your filters" for an entry 19 days old');
    assert.ok(page.includes('Records available to you') && !page.includes('Load older entries'), 'the whole 1,200-row trail is here');
    // The 15-second refresh of the first page keeps the older pages; a forced one (after a cleanup) starts over.
    trail = [{ id: 'log_new', ts: base + 60000, user_id: '', action: 'login', resource_type: 'auth', message: 'New login' }, ...trail];
    state.serverLogsLoadedAt = 0;
    await sandbox.refreshServerAuditLogs();
    assert.equal(state.serverLogs.length, 1201);
    assert.ok(view().includes('Deleted receipt R-900'), 'a refresh dropped the older pages');
    Object.assign(state, { auditDateFrom: '', auditDateTo: '' });
    await sandbox.refreshServerAuditLogs({ force: true });
    assert.equal(state.serverLogs.length, 500);
    // A trail longer than the automatic reach: ten more pages at most, then the button.
    trail = makeTrail(12000);
    Object.assign(state, { serverLogs: [], serverLogsLoadedAt: 0, auditDateFrom: '', auditDateTo: '', auditSearch: 'no such words' });
    calls.length = 0;
    await sandbox.refreshServerAuditLogs({ force: true });
    assert.equal(calls.length, 11);
    assert.equal(state.serverLogs.length, 10500);
    page = view();
    assert.ok(page.includes('Newest 10,500 entries') && page.includes('No match in the newest 10,500 entries') && page.includes('Load older entries'), 'the cap is not named');
    assert.equal(calls.length, 11, 'no further automatic reads');
    await sandbox.refreshServerAuditLogs({ older: true });
    assert.equal(state.serverLogs.length, 12000);
    assert.ok(view().includes('Records available to you'));
    state.language = 'ar';
    // A short trail is complete: the usual label, no button.
    trail = makeTrail(120);
    Object.assign(state, { serverLogs: [], serverLogsLoadedAt: 0, auditSearch: '' });
    await sandbox.refreshServerAuditLogs({ force: true });
    page = view();
    assert.ok(page.includes('السجلات المتاحة لك') && !page.includes('تحميل سجلات أقدم'));
    // A page that arrives after the account changed is not kept.
    Object.assign(state, { serverLogs: [], serverLogsLoadedAt: 0 });
    const pending = sandbox.refreshServerAuditLogs();
    state.currentUser = { id: 'next_user', role: 'Employee', permissions: { auditLogs: ['viewOwn'] } };
    await pending;
    assert.deepEqual(Array.from(state.serverLogs), [], 'the last account\'s audit rows reached the next one');
  });
  await test('R4 display-correctness-2: a page filter left by a merged or deleted page is dropped, and filters that hide every ad say so with Clear', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    state.pages = [{ id: 'p_live', name: 'Live Page' }, { id: 'p_quiet', name: 'Quiet Page' }];
    state.ads = ['a1', 'a2', 'a3'].map(id => ({ id, customerId: 'c1', pageId: 'p_live', status: 'Active', paymentStatus: 'paid', isPaid: true,
      amountUSD: 10, exchangeRate: 5, amountLocal: 50, createdAt: '2026-09-01' }));
    state.adSearch = '';
    state.adFilters = { status: 'all', payment: 'all', page: 'p_merged_away' };
    let html = String(sandbox.renderAdsView());
    assert.ok(html.includes('3 total ads') && !html.includes('No ads yet'), 'before: "0 total ads / No ads yet" while every control says All');
    assert.equal(state.adFilters.page, 'all');
    // A live page filter that matches nothing: named, with Clear, and "All" is not lit.
    state.adFilters = { status: 'all', payment: 'all', page: 'p_quiet' };
    html = String(sandbox.renderAdsView());
    assert.ok(html.includes('0 total ads') && html.includes('No ads match your filters') && html.includes(`onclick="state.adSearch='';applyAdQuickFilter('all')"`), 'no Clear');
    assert.ok(!html.includes(`onclick="applyAdQuickFilter('all')" class="smart-filter-chip is-active"`), 'the All chip is lit over a page filter');
    assert.equal(state.adFilters.page, 'p_quiet', 'a live page filter stays');
    state.language = 'ar';
    assert.ok(String(sandbox.renderAdsView()).includes('لا توجد إعلانات تطابق الفلاتر'));
    state.adFilters = { status: 'all', payment: 'all', page: 'all' };
    state.ads = [];
    assert.ok(String(sandbox.renderAdsView()).includes('لا توجد إعلانات بعد'), 'no filter, no ads: "No ads yet"');
  });
  await test('R4 display-correctness-3: in Arabic a phone with spaces or + reads left to right on every delivery screen, the customer card and the ads table', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    state.language = 'ar';
    const phone = '+218 91 456 7890';
    const ltr = `<bdi dir="ltr">${phone}</bdi>`;
    const noPhone = 'لا يوجد هاتف';
    state.customers = [{ id: 'c1', name: 'Ali', phones: [phone] }, { id: 'c2', name: 'Huda', phones: [] }];
    const admin = state.currentUser;
    const driver = { id: 'drv1', name: 'Driver', role: 'Delivery', permissions: {} };
    state.users = [admin, driver];
    const job = { recordType: 'receipt', status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus: 'In Progress',
      deliveryPersonId: 'drv1', amountUSD: 10, amountLocal: 50, exchangeRate: 5, payments: [], transfers: [], createdAt: '2026-09-01' };
    state.receipts = [{ ...job, id: 'r1', customerId: 'c1', tempReceiptNo: 'D1', phoneNumber: phone }, { ...job, id: 'r2', customerId: 'c2', tempReceiptNo: 'D2' }];
    state.currentUser = driver;
    const dash = String(sandbox.renderDeliveryDashboard());
    assert.ok(dash.includes(ltr), 'before: the driver dashboard shows "7890 456 91 218+"');
    assert.ok(dash.includes(noPhone) && !dash.includes(`dir="ltr">${noPhone}`), 'the no-phone text keeps its own direction');
    state.currentUser = admin;
    assert.ok(String(sandbox.renderCustomersGrid([state.customers[0]])).includes(`dark:text-slate-300">${ltr}</div>`), 'customer card');
    const ops = String(sandbox.renderDeliveriesView(true));
    assert.ok(ops.includes(`<p class="ops-record-phone">${ltr}</p>`) && ops.includes(`<p class="ops-record-phone">${noPhone}</p>`), 'delivery log card');
    state.ads = [{ id: 'a1', customerId: 'c1', phoneNumber: phone, status: 'Active', paymentStatus: 'paid', isPaid: true, amountUSD: 10, exchangeRate: 5, amountLocal: 50 }];
    assert.ok(String(sandbox.renderAdsView()).includes(ltr), 'ads table');
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    const dialog = () => String(made[made.length - 1].innerHTML || '');
    sandbox.showDeliveryDetails('r1');
    assert.ok(dialog().includes(ltr), 'delivery details');
    sandbox.showDeliveryDetails('r2');
    assert.ok(dialog().includes(`<span>${noPhone}</span>`), 'delivery details without a phone');
    sandbox.openDeliveryCancelModal('r1');
    assert.ok(dialog().includes(` • ${ltr}`), 'cancel dialog');
    await sandbox.openReceiptDeliveryCompletionModal('r1');
    const complete = made.find(el => el.id === 'delivery-complete-modal');
    assert.ok(complete && String(complete.innerHTML).includes(ltr), 'Mark Delivered dialog');
  });
  await test('R4 display-correctness-4: Delivery Operations finds a delivered receipt by its paper number (with or without #) or its D-number, and its card shows D17 → 4521', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    state.customers = [{ id: 'c1', name: 'Ali', phones: ['0911111111'] }];
    state.receipts = [{ id: 'r1', recordType: 'receipt', customerId: 'c1', tempReceiptNo: 'D17', finalReceiptNo: '4521', serialNumber: '4521', status: 'Paid', isPaid: true,
      deliveryStatus: 'Delivered', deliveryPersonId: 'drv1', amountUSD: 10, amountLocal: 50, exchangeRate: 5, payments: [], transfers: [], createdAt: '2026-09-01' }];
    for (const search of ['4521', '#4521', 'D17']) {
      state.deliveryFilter = { search };
      const html = String(sandbox.renderDeliveriesView(true));
      assert.ok(html.includes('data-delivery-record="r1"'), `before: "${search}" finds nothing`);
      assert.ok(html.includes('<bdi>#D17 → 4521</bdi>'), 'the card shows only the temporary D-number');
    }
    state.deliveryFilter = { search: '9999' };
    assert.ok(!String(sandbox.renderDeliveriesView(true)).includes('data-delivery-record="r1"'));
  });
  await test('R4 display-correctness-5: the driver Held tile and the fee lines show the exact 107.25 / 7.50 LYD the office sees, not whole dinars', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    state.language = 'en';
    const admin = state.currentUser;
    state.currentUser = { id: 'drv1', name: 'Driver', role: 'Delivery', permissions: {} };
    state.users = [admin, state.currentUser];
    state.customers = [{ id: 'c1', name: 'Ali' }];
    const base = { recordType: 'receipt', customerId: 'c1', deliveryPersonId: 'drv1', quotedDeliveryFee: 7.5, amountUSD: 15, exchangeRate: 7.15,
      payments: [], transfers: [], createdAt: '2026-09-01' };
    state.receipts = [{ ...base, id: 'r1', tempReceiptNo: 'D1', finalReceiptNo: '4521', status: 'Paid', isPaid: true, deliveryStatus: 'Delivered',
      amountLocal: 107.25, amountCollectedFromCustomer: 107.25, actualDeliveryFeeCollected: 5.25, deliveryFeePaidBy: 'customer', feeDifferenceStatus: 'LOWER', feeDiff: -2.25 }];
    const dash = String(sandbox.renderDeliveryDashboard());
    assert.ok(dash.includes('1 (107.25 LYD)') && !dash.includes('(107 LYD)'), 'before: the Held tile reads 107 LYD while the office sees 107.25');
    assert.ok(dash.includes('>7.50 LYD</span>') && dash.includes('>5.25 LYD</span>') && dash.includes('(-2.25 LYD vs quoted)'), 'quoted fee, fee collected, variance');
    state.currentUser = admin;
    assert.ok(String(sandbox.renderReceiptsView()).includes('Delivery fee: 5.25 LYD'), 'the receipt card fee line');
    state.receipts.push({ ...base, id: 'r2', tempReceiptNo: 'D2', status: 'Not Paid', isPaid: false, statusDetail: { notPaidCollection: 'delivery' },
      deliveryStatus: 'In Progress', amountLocal: 0 });
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    await sandbox.openReceiptDeliveryCompletionModal('r2');
    const complete = made.find(el => el.id === 'delivery-complete-modal');
    assert.match(String(complete?.innerHTML), /id="delivery-complete-quoted"[^>]*>7\.50 LYD</);
    const nodes = { 'delivery-complete-modal': { dataset: { receiptId: 'r2' } }, 'delivery-collected-total': {}, 'delivery-fee-compare': {}, 'delivery-debt-compare': {} };
    sandbox.document.getElementById = id => nodes[id] || null;
    sandbox.getPaymentTotalsFromDom = () => ({ totalR1: 107.25, totalR2: 0 });
    sandbox._readDeliveryFeeLyd = () => 5.25;
    sandbox.updateReceiptDeliveryCompletionComputed();
    assert.equal(nodes['delivery-fee-compare'].textContent, 'Fee: LOWER (2.25 LYD)');
  });
  await test('R4 permission-matrix-3: a deliveries.assign holder without reassign or receipts.edit is offered no driver change and no Delete Mission on In Progress or Canceled jobs; an editor still is', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security').escapeHtml = plainEscape;
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    const saved = [];
    sandbox.updateRecord = async (list, id, updates) => { saved.push({ id, updates }); return true; };
    const grant = { id: 'ops1', name: 'Ops', role: 'Employee', permissions: { receipts: ['view'], deliveries: ['view', 'accept', 'markCollected', 'assign', 'viewStats'] } };
    const editor = { ...grant, id: 'ops2', permissions: { ...grant.permissions, receipts: ['view', 'edit'] } };
    state.users = [grant, editor, { id: 'drv1', name: 'Driver One', role: 'Delivery', permissions: {} }, { id: 'drv2', name: 'Driver Two', role: 'Delivery', permissions: {} }];
    state.customers = [{ id: 'c1', name: 'Ali' }];
    const job = (id, deliveryStatus, extra = {}) => ({ id, recordType: 'receipt', customerId: 'c1', createdBy: 'admin', tempReceiptNo: id.toUpperCase(), status: 'Not Paid',
      isPaid: false, statusDetail: { notPaidCollection: 'delivery' }, deliveryStatus, amountUSD: 10, amountLocal: 50, exchangeRate: 5, payments: [], transfers: [], createdAt: '2026-09-01', ...extra });
    state.receipts = [job('d1', 'In Progress', { deliveryPersonId: 'drv1' }), job('d2', 'Canceled', { deliveryPersonId: 'drv1' }), job('d3', 'Needs Delivery')];
    state.currentUser = grant;
    await sandbox.assignDelivery('d1', 'drv2');
    assert.deepEqual(saved, [], 'before: the driver change went to the server, which refuses it');
    assert.equal(notes.pop()?.title, 'Access Denied');
    const cards = html => id => html.split('data-delivery-record="').find(part => part.startsWith(`${id}"`)) || '';
    const options = part => [...part.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    let card = cards(String(sandbox.renderDeliveriesView()));
    assert.ok(!card('d1').includes('removeDeliveryMission') && !card('d2').includes('removeDeliveryMission'), 'Delete Mission on an In Progress or Canceled job');
    assert.ok(card('d3').includes("removeDeliveryMission('d3')"), 'a waiting job keeps Delete Mission');
    assert.deepEqual(options(card('d1')), ['In Progress', 'Canceled'], 'the status picker offers moves the server refuses');
    await sandbox.removeDeliveryMission('d1');
    assert.deepEqual(saved, []);
    assert.equal(notes.pop()?.message, 'This job is already in progress or canceled; cancel it instead, or ask someone who can edit the receipt.');
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    const details = id => { sandbox.showDeliveryDetails(id); return String(made[made.length - 1].innerHTML || ''); };
    assert.ok(!details('d1').includes('assignDelivery(') && details('d1').includes('Driver One'), 'the Details driver picker on an assigned job');
    assert.ok(details('d3').includes("assignDelivery('d3'"), 'an unassigned job keeps its driver picker');
    // A receipts.edit holder skips the workflow rule, as on the server.
    state.currentUser = editor;
    await sandbox.assignDelivery('d1', 'drv2');
    await sandbox.removeDeliveryMission('d1');
    assert.deepEqual(saved.map(s => s.id), ['d1', 'd1']);
    card = cards(String(sandbox.renderDeliveriesView()));
    assert.ok(card('d1').includes("removeDeliveryMission('d1')") && card('d2').includes("removeDeliveryMission('d2')"));
    assert.deepEqual(options(card('d1')), ['Needs Delivery', 'In Progress', 'Delivered', 'Canceled', 'Office']);
    assert.ok(details('d1').includes("assignDelivery('d1'"));
  });

  // Bug hunt r5 (R5-i18n-arabic-sweep-2): drivers read the server's English delivery refusals, and
  // Mark Delivered titled a rule refusal (an amount typed with extra zeros, a closed month) "Server error".
  await test('R5 i18n-arabic-sweep-2: delivery refusals read Arabic with no English status names; Mark Delivered calls a 4xx "Not allowed" with its reason, never "Server error" or "HTTP n"', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    const latin = /[A-Za-z]/;
    state.language = 'ar';
    const toast = sandbox._serverRefusalToast('save', 'receipts', { status: 400, message: "Cannot change status from 'Canceled' - this is a terminal state" });
    assert.ok(!latin.test(toast.join(' ')) && toast[1].includes('ملغي'), JSON.stringify(toast));
    const already = sandbox.describe409({ status: 409, message: "Delivery is already 'Canceled'" }, '');
    assert.ok(!latin.test(already) && already.includes('ملغي'), already);
    for (const detail of [
      "Cannot change delivery status from 'Delivered' - this is a terminal state",
      'An accepted delivery job cannot move back to Needs Delivery; cancel it or delete the mission',
      "Cannot change status from 'Delivered' to 'Needs Delivery' - a delivery job cannot be reopened or moved backwards",
      'A finished delivery job keeps its driver',
      'Assign an active delivery user',
      'deliveryPersonId must be an active delivery user'
    ]) {
      const text = sandbox._serverRefusalText(detail);
      assert.ok(text && !latin.test(text), `${detail} -> ${text}`);
    }
    // Mark Delivered: the server refuses, the job itself is unchanged (still this driver's, In Progress).
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.isServerModeEnabled = () => true;
    state.serverMode = true;
    const driver = { id: 'drv1', name: 'Ali', role: 'Delivery', permissions: { deliveries: ['viewOwn', 'accept', 'complete', 'markCollected'] } };
    state.currentUser = driver; state.users = [driver];
    const job = { id: 'r2', customerId: 'c1', status: 'Not Paid', isPaid: false, amountUSD: 50, amountLocal: 250, exchangeRate: 5,
      tempReceiptNo: 'D12', receiptType: 'DELIVERY_TEMP', deliveryStatus: 'In Progress', deliveryPersonId: 'drv1',
      statusDetail: { notPaidCollection: 'delivery' }, _lastModified: 1001 };
    state.receipts = [job];
    run("getPaymentTotalsFromDom = () => ({ totalR1: 25000, totalR2: 0 }); _readDeliveryFeeLyd = () => 10; _readDeliveryFeePaidBy = () => 'customer'; _readDeliveryPaymentRows = () => [{ method: 'Cash (LYD)', amount: 25000, rate: 1, rate2: 0 }];");
    const field = value => ({ value, dataset: { imageData: 'data:image/jpeg;base64,/9j/AAAA' }, disabled: false, remove() {} });
    const els = { 'delivery-final-receipt-no': field('88002'), 'delivery-receipt-image-data': field(''), 'delivery-driver-notes': field(''), 'delivery-fee-method': field('Cash (LYD)'), 'delivery-complete-submit': field('') };
    sandbox.document.getElementById = id => els[id] || null;
    sandbox.apiGetEntity = async () => ({ data: { ...job } });
    const refuse = async (status, detail) => {
      notes.length = 0;
      sandbox.apiPatchEntity = async () => { throw Object.assign(new Error(detail), { status, payload: { detail } }); };
      await sandbox.submitReceiptDeliveryCompletion('r2');
      assert.equal(notes.length, 1, JSON.stringify(notes));
      assert.equal(els['delivery-complete-submit'].disabled, false, 'the driver can fix the amount and tap again');
      return notes[0];
    };
    let note = await refuse(400, 'Collected amount far exceeds the delivery debt; office confirmation required');
    assert.equal(note.title, 'غير مسموح', 'before: "Server error"');
    assert.ok(note.message.includes('أصفار زائدة') && !latin.test(note.message), note.message);
    note = await refuse(423, 'Financial period 2026-09 is closed. An Admin must unlock it before editing.');
    assert.equal(note.title, 'غير مسموح');
    assert.equal(note.message, 'فشل حفظ التوصيل: ' + sandbox._serverRefusalText('Financial period 2026-09 is closed. An Admin must unlock it before editing.'));
    assert.ok(note.message.includes('مُقفل') && !note.message.includes('HTTP'), note.message);
    // A real server failure keeps its title and status.
    note = await refuse(500, 'Internal Server Error');
    assert.deepEqual([note.title, note.message], ['خطأ في الخادم', 'فشل حفظ التوصيل: HTTP 500 - Internal Server Error']);
    // English: the same rule, with the hint in English.
    state.language = 'en';
    note = await refuse(400, 'Collected amount far exceeds the delivery debt; office confirmation required');
    assert.deepEqual([note.title, note.message], ['Not Allowed', 'Failed to save delivery: The collected amount is far above the delivery debt. Check the amount (extra zeros?) or ask the office to confirm.']);
    assert.equal(sandbox._serverRefusalText("Delivery is already 'Canceled'"), "Delivery is already 'Canceled'", 'English keeps the server sentence');
  });

  // Bug hunt r5 (R5-i18n-arabic-sweep-3): the Meta panel on every Meta-linked ad showed raw Meta status
  // codes and the server's English sync sentences, and its Meta change-history dialog was English.
  await test('R5 i18n-arabic-sweep-3: in Arabic the Meta panel, its history and the Meta Sync rows name Meta statuses and sync problems in Arabic; the tooltip keeps the server sentence; English is unchanged', async () => {
    const { sandbox, state, run } = metaToolsFixture();
    run('Security').escapeHtml = plainEscape;
    const visible = html => String(html).replace(/<[^>]*>/g, ' ');
    sandbox.isServerModeEnabled = () => true;
    state.serverMode = true;
    const metaAd = (id, status, error, code) => ({ id, customerId: 'c1', status: 'Active', paymentStatus: 'paid', isPaid: true, amountUSD: 50, exchangeRate: 5, amountLocal: 250,
      createdAt: '2026-09-25', metaAdId: `1202100000${id.slice(-1)}`, metaAdName: 'Summer sale', metaAdAccountName: 'Shop account', metaAdAccountId: '1234567890',
      metaCurrency: 'USD', metaEffectiveStatus: status, metaSyncedAt: '2026-09-26T10:00:00Z', metaSyncError: error, metaSyncErrorCode: code,
      metaChangeHistory: [
        { editedAt: '2026-09-26T10:00:00Z', editedBy: 'Meta automatic sync', source: 'snapshot',
          changes: [{ field: 'Meta live status', from: 'ACTIVE', to: 'CAMPAIGN_PAUSED' }, { field: 'Meta daily budget', from: '5.00 USD', to: '7.00 USD' }] },
        { editedAt: '2026-09-27T10:00:00Z', editedBy: 'Meta automatic import', source: 'meta_import', eventType: 'create_ad',
          changes: [{ field: 'Meta ad imported', from: 'Not in Albayan', to: 'Needs completion' }] }] });
    state.ads = [
      metaAd('m1', 'CAMPAIGN_PAUSED', 'Meta did not answer in time. Albayan will retry.', 'timeout'),
      metaAd('m2', 'WITH_ISSUES', 'Meta authorization failed. Reconnect the access token.', 'authorization:190'),
      metaAd('m3', 'PENDING_REVIEW', 'Meta could not return the requested ad information.', 'request_failed:100'),
      metaAd('m4', 'ACTIVE', 'Meta is temporarily limiting synchronization. Albayan will retry.', 'rate_limited:17')
    ];
    state.language = 'ar';
    let html = String(sandbox.renderAdsView());
    for (const english of ['CAMPAIGN_PAUSED', 'WITH_ISSUES', 'PENDING_REVIEW', '[timeout]', 'Meta did not answer', 'Meta authorization failed', 'authorization:190', 'temporarily limiting']) {
      assert.ok(!visible(html).includes(english), `before: the Arabic Ads list shows "${english}"`);
    }
    for (const arabic of ['الحملة متوقفة', 'به مشكلات', 'قيد المراجعة', 'تعذر الوصول إلى Meta الآن؛ سيعيد البيان المحاولة.', 'رفض Meta الإذن؛ أعد ربط رمز الوصول.', 'تعذرت مزامنة Meta لهذا الإعلان.']) {
      assert.ok(html.includes(arabic), arabic);
    }
    assert.ok(html.includes('title="Meta did not answer in time. Albayan will retry. [timeout]"'), 'the tooltip keeps the server sentence and its code');
    assert.ok(/bg-amber-100[^"]*">الحملة متوقفة</.test(html) && /bg-rose-100[^"]*">به مشكلات</.test(html), 'the tone stays keyed on the raw code');
    // The history dialog: the server's field names, Meta statuses, actors and event type.
    let dialog = '';
    sandbox.document.body.insertAdjacentHTML = (_, markup) => { dialog = markup; };
    sandbox.showMetaAdHistory('m1');
    for (const english of ['Meta live status', 'CAMPAIGN_PAUSED', 'ACTIVE', 'Meta daily budget', 'Meta automatic sync', 'Meta automatic import', 'Not in Albayan', 'Needs completion', 'create ad']) {
      assert.ok(!visible(dialog).includes(english), `before: the Arabic Meta history shows "${english}"`);
    }
    for (const arabic of ['حالة Meta الفعلية', 'نشط', 'الحملة متوقفة', 'ميزانية Meta اليومية', 'مزامنة Meta التلقائية', 'استيراد Meta التلقائي', 'غير موجود في البيان', 'إنشاء إعلان']) {
      assert.ok(dialog.includes(arabic), arabic);
    }
    assert.ok(dialog.includes('5.00 USD') && dialog.includes('Summer sale'), "Meta's own values and names stay as stored");
    // The Meta Sync dialog's ad rows (lazy meta-tools.js).
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    run("metaAdsUi.open = true; metaAdsUi.loading = false; metaAdsUi.loadingAds = false; metaAdsUi.status = { configured: true }; metaAdsUi.targetAdId = 'm1';"
      + " metaAdsUi.accounts = []; metaAdsUi.selectedAccountId = '1234567890'; metaAdsUi.ads = [{ id: '120210000099', name: 'Winter', effectiveStatus: 'DISAPPROVED' }];");
    sandbox.metaAdsRenderModal();
    const rows = String(made.find(el => el.id === 'meta-ads-modal')?.innerHTML || '');
    assert.ok(rows.includes('مرفوض') && !visible(rows).includes('DISAPPROVED'), 'before: the Meta Sync row shows DISAPPROVED');
    // English stays exactly as it was.
    state.language = 'en';
    html = String(sandbox.renderAdsView());
    assert.ok(visible(html).includes('CAMPAIGN_PAUSED') && html.includes('Meta did not answer in time. Albayan will retry. <span class="font-mono opacity-70">[timeout]</span>'));
    assert.ok(!visible(html).includes('temporarily limiting'), 'a shared Meta throttle stays hidden on the row');
    sandbox.showMetaAdHistory('m1');
    assert.ok(visible(dialog).includes('Meta live status') && visible(dialog).includes('CAMPAIGN_PAUSED') && visible(dialog).includes('Meta automatic sync') && visible(dialog).includes('create ad'));
  });

  // ---- Bug hunt R5 (saves-errors): a second Save while sending, one id per open new form, refusals and dropped connections, ad dates ----
  const r5Ids = sandbox => { let n = 0; sandbox.crypto.getRandomValues = arr => { for (let i = 0; i < arr.length; i += 1) arr[i] = (n++ * 37 + i) & 255; return arr; }; };
  await test('R5 error-paths-offline-1: a second, different Save of an ad (or of its stop) while the first is still sending is refused, never reported as saved', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    r5Ids(sandbox);
    state.serverMode = true;
    sandbox.isServerModeEnabled = () => true;
    const calls = [];
    const pending = [];
    sandbox.apiMutateAd = payload => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return new Promise(resolve => pending.push(() => {
        const version = Date.now();
        resolve({ ad: { id: payload.adId, data: { ...payload.data, id: payload.adId, _lastModified: version }, lastModified: version }, updatedReceipts: [] });
      }));
    };
    const outcome = promise => promise.then(() => 'saved', error => error.code || error.message);
    // Edit Ad: changed values while the first update is sending.
    const first = sandbox.saveAdThroughAtomicServer('update', 'ad1', 5, { customerId: 'c1', adLinks: ['https://fb.example/a'] });
    const second = outcome(sandbox.saveAdThroughAtomicServer('update', 'ad1', 5, { customerId: 'c1', adLinks: ['https://fb.example/b'] }));
    pending.shift()();
    await first;
    assert.equal(await second, 'AD_SAVE_BUSY', 'before: the second Save got the first one\'s answer, so it was reported as saved');
    assert.equal(calls.length, 1);
    // New Ad: a different ad saved after cancelling a slow one is refused, and its form is not pinned to the first ad.
    const formA = { dataset: {} };
    const formB = { dataset: {} };
    const created = sandbox.saveAdThroughAtomicServer('create', '', null, { customerId: 'c1', adLinks: ['https://fb.example/a'] }, formA);
    const other = outcome(sandbox.saveAdThroughAtomicServer('create', '', null, { customerId: 'c2', adLinks: ['https://fb.example/c'] }, formB));
    pending.shift()();
    await created;
    assert.equal(await other, 'AD_SAVE_BUSY');
    assert.equal(formB.dataset.draftAdId, undefined, 'before: the second New Ad form took the first ad\'s id');
    assert.equal(calls.length, 2);
    // The same Save pressed twice still shares one request.
    const once = sandbox.saveAdThroughAtomicServer('update', 'ad2', 5, { adLinks: ['https://fb.example/d'] });
    const twice = sandbox.saveAdThroughAtomicServer('update', 'ad2', 5, { adLinks: ['https://fb.example/d'] });
    pending.shift()();
    assert.deepEqual([(await once).id, (await twice).id], ['ad2', 'ad2']);
    assert.equal(calls.length, 3);
    // Stop: a changed spend while the first stop is sending.
    const stopAd = { id: 'ad_stop', _lastModified: 7 };
    const stop = sandbox.getAdStopAttempt(stopAd, 1250, false);
    stop.promise = new Promise(() => {});
    assert.equal(sandbox.getAdStopAttempt(stopAd, 1250, false), stop, 'the same stop still shares its request');
    assert.throws(() => sandbox.getAdStopAttempt(stopAd, 1300, false), error => error.code === 'AD_STOP_BUSY' && /still being sent/.test(error.message),
      'before: the changed spend was handed the first stop\'s answer');
    // Top-ups pressed again with a changed amount while the first save is sending.
    state.receipts = [{ id: 'r1', customerId: 'c1', status: 'Paid', isPaid: true, amountUSD: 200, amountLocal: 1000, exchangeRate: 5, payments: [], transfers: [], _lastModified: 1 }];
    const topAd = { id: 'adT', customerId: 'c1', status: 'Active', paymentStatus: 'paid', isPaid: true, exchangeRate: 5, amountUSD: 50, amountLocal: 250,
      initialAmountUSD: 50, topUps: [], receiptAllocations: [{ receiptId: 'r1', amountUSD: 50 }], _lastModified: 100 };
    state.ads = [topAd];
    state.modalData = topAd;
    state.activeModal = 'top-ups';
    const notes = [];
    let closes = 0;
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.closeModal = () => { closes += 1; };
    const button = { disabled: false, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } };
    sandbox.document.querySelector = selector => (selector === 'button[onclick="saveTopUps()"]' || selector === 'button[onclick="saveRefund()"]' ? button : null);
    run("tempTopUps = [{ date: '2026-09-01T00:00:00.000Z', amount: 10, extendDays: 0, note: 'A' }]");
    const firstTopUp = sandbox.saveTopUps();
    run("tempTopUps = [{ date: '2026-09-01T00:00:00.000Z', amount: 30, extendDays: 0, note: 'B' }]");
    const secondTopUp = sandbox.saveTopUps();
    await settle();
    const busyWhileSending = [button.disabled, button.attrs['aria-busy']];  // the refused re-tap leaves it busy
    pending.shift()();
    await Promise.all([firstTopUp, secondTopUp]);
    const saved = notes.filter(note => note.type === 'success');
    assert.equal(saved.length, 1, `before: the changed second tap was reported as saved: ${JSON.stringify(notes)}`);
    assert.ok(saved[0].message.includes('$60.00'), saved[0].message);
    assert.equal(closes, 1);
    assert.equal(calls.length, 4, 'the changed top-up never went out');
    assert.ok(notes.some(note => note.title === 'Top-ups Not Saved' && /still being sent/.test(note.message)), JSON.stringify(notes));
    assert.deepEqual(busyWhileSending, [true, 'true'], 'the Save button stays busy while the first save is sending');
    assert.equal(button.disabled, false);
    assert.ok(!('aria-busy' in button.attrs));
    // Refund: the same rule.
    const refundAd = { ...topAd, id: 'adR', _lastModified: 200 };
    state.ads.push(refundAd);
    state.modalData = refundAd;
    state.activeModal = 'refund';
    const inputs = { 'refund-type': 'Partial', 'refund-amount': '10', 'refund-status': 'Pending' };
    sandbox.document.getElementById = id => (id in inputs ? { value: inputs[id] } : null);
    notes.length = 0;
    closes = 0;
    const firstRefund = sandbox.saveRefund();
    inputs['refund-amount'] = '20';
    const secondRefund = sandbox.saveRefund();
    await settle();
    const refundBusy = [button.disabled, button.attrs['aria-busy']];
    pending.shift()();
    await Promise.all([firstRefund, secondRefund]);
    assert.equal(notes.filter(note => note.title === 'Saved').length, 1, `before: both refunds were reported as applied: ${JSON.stringify(notes)}`);
    assert.equal(closes, 1);
    assert.equal(calls.length, 5);
    assert.ok(notes.some(note => note.title === 'Refund Not Saved' && /still being sent/.test(note.message)), JSON.stringify(notes));
    assert.deepEqual(refundBusy, [true, 'true'], 'a refused re-tap must not free the Save button while the first refund is sending');
    assert.equal(button.disabled, false);
  });
  await test('R5 error-paths-offline-2: a re-press after a lost answer meets its own committed row: one page, customer, product, shipment and order, and one stock take', async () => {
    for (const lost of ['Load failed', 'timeout']) {
      const { sandbox, state, run, notes } = clothesFixture();
      r5Ids(sandbox);
      sandbox.URLSearchParams = URLSearchParams;
      state.serverMode = true;
      sandbox.isServerModeEnabled = () => true;
      sandbox.console = { ...sandbox.console, error() {}, warn() {} };
      const loseAnswer = () => (lost === 'timeout' ? Object.assign(new DOMException('The request timed out', 'AbortError'), { noRetry: true }) : new TypeError('Load failed'));
      // The server: a create commits, then its answer is lost once; a known id answers 409. Copies come back with their keys reordered (iPhone).
      const rows = new Map();
      const reorder = value => (Array.isArray(value) ? value.map(reorder) : (value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value));
      let dropNext = true;
      sandbox.apiCreateEntity = async (collection, record) => {
        const key = `${collection}/${record.id}`;
        if (rows.has(key)) throw Object.assign(new Error('ID already exists'), { status: 409 });
        rows.set(key, JSON.parse(JSON.stringify(record)));
        if (dropNext) { dropNext = false; throw loseAnswer(); }
        return { id: record.id, data: record };
      };
      sandbox.apiGetEntity = async (collection, id) => ({ id, data: reorder(rows.get(`${collection}/${id}`)) });
      const count = collection => [...rows.keys()].filter(key => key.startsWith(`${collection}/`)).length;
      // A new page, Save pressed twice.
      let form = { id: 'modal-form', dataset: {} };
      const fields = { 'page-name': 'Albayan Shop', 'page-category': 'Shop' };
      sandbox.document.getElementById = id => (id === 'modal-form' ? (state.activeModal ? form : null) : (id in fields ? { value: fields[id] } : null));
      sandbox.document.querySelectorAll = selector => (selector === '.page-customer-item' ? [{ getAttribute: () => 'c1' }] : []);
      state.activeModal = 'page';
      state.modalData = null;
      await sandbox.handleModalSubmit();
      assert.equal(state.activeModal, 'page', 'the form stays open after the lost answer');
      await sandbox.handleModalSubmit();
      assert.equal(count('pages'), 1, `before: a second page was created (${lost})`);
      assert.deepEqual(state.pages.map(page => page.name), ['Albayan Shop']);
      assert.equal(state.activeModal, null, 'the second press found its own first Save and closed the form');
      // The first press said the save may have gone through (R5 error-paths-offline-4).
      assert.ok(notes.some(note => note.title === 'Connection problem' && /may have gone through/.test(note.message) && !/Load failed|nothing was saved/i.test(note.message)), JSON.stringify(notes));
      // A fresh form gets a fresh id.
      form = { id: 'modal-form', dataset: {} };
      fields['page-name'] = 'Second Page';
      state.activeModal = 'page';
      await sandbox.handleModalSubmit();
      assert.equal(count('pages'), 2);
      // A new customer, Save pressed twice.
      form = { id: 'modal-form', dataset: {} };
      const customerFields = { 'customer-name': 'Huda', 'customer-platform': 'Phone', 'customer-joindate': '2026-09-30' };
      sandbox.document.getElementById = id => (id === 'modal-form' ? (state.activeModal ? form : null) : (id in customerFields ? { value: customerFields[id] } : null));
      sandbox.document.querySelectorAll = selector => (selector === '.customer-phone' ? [{ value: '0912345678' }] : []);
      state.activeModal = 'customer';
      dropNext = true;
      await sandbox.handleModalSubmit();
      assert.equal(state.activeModal, 'customer');
      await sandbox.handleModalSubmit();
      assert.equal(count('customers'), 1, `before: a second customer was created (${lost})`);
      assert.equal(state.activeModal, null);
      // A Clothes product with two variants (the stored copy has its keys in another order).
      const productFields = { 'clothes-product-name': 'Shirt', 'clothes-product-cost': '5', 'clothes-product-price': '50' };
      sandbox.document.getElementById = id => (id in productFields ? { value: productFields[id] } : null);
      run("_clothesDraftId = ''; _clothesTempVariants = [{ color: 'Red', size: 'M', qty: 2 }, { color: 'Blue', size: 'L', qty: 1 }]; _clothesTempPhoto = null;");
      dropNext = true;
      assert.equal(await sandbox.saveClothesProductFromModal(), false);
      assert.equal(await sandbox.saveClothesProductFromModal(), true, `before: a second product, or its reordered copy was refused (${lost})`);
      assert.equal(count('clothesProducts'), 1);
      assert.equal(state.clothesProducts.length, 1);
      // A Clothes shipment.
      const shipmentFields = { 'clothes-shipment-ref': 'SH-1', 'clothes-shipment-date': '2026-09-30' };
      sandbox.document.getElementById = id => (id in shipmentFields ? { value: shipmentFields[id] } : null);
      run(`_clothesDraftId = ''; _clothesTempShipLines = [{ productId: '${state.clothesProducts[0].id}', color: 'Red', size: 'M', qty: 4, unitCostUSD: '3' }];`);
      dropNext = true;
      assert.equal(await sandbox.saveClothesShipmentFromModal(), false);
      assert.equal(await sandbox.saveClothesShipmentFromModal(), true);
      assert.equal(count('clothesShipments'), 1, `before: a second shipment (${lost})`);
      // A Clothes order: the phone is fixed before Save is pressed again; the stock is taken once.
      state.clothesProducts.push({ id: 'p1', name: 'Dress', costUSD: 5, priceLYD: 20, variants: [{ color: 'Red', size: 'M', qty: 5 }], createdBy: 'admin' });
      const orderFields = { 'clothes-order-customer': 'Sara', 'clothes-order-phone': '0911111111', 'clothes-order-fee': '0', 'clothes-order-paystatus': 'Not Paid', 'clothes-order-paid': '0' };
      sandbox.document.getElementById = id => (id in orderFields ? { value: orderFields[id] } : null);
      const orderLines = "_clothesTempOrderLines = [{ productId: 'p1', color: 'Red', size: 'M', qty: 2, priceLYD: 20 }];";
      run(`_clothesDraftId = ''; ${orderLines}`);
      const orders = new Map();
      const replies = new Map();
      const sentOrders = [];
      let stockTakes = 0;
      dropNext = true;
      sandbox.applyClothesOrderMutationResponse = response => response.order.data;
      sandbox.apiMutateClothesOrder = async request => {
        sentOrders.push(JSON.parse(JSON.stringify(request)));
        if (replies.has(request.idempotencyKey)) return replies.get(request.idempotencyKey);
        if (orders.has(request.orderId)) throw Object.assign(new Error('Order ID already exists'), { status: 409 });
        orders.set(request.orderId, request.data);
        stockTakes += 1;
        const reply = { order: { id: request.orderId, data: { ...request.data, id: request.orderId }, lastModified: Date.now() }, updatedProducts: [] };
        replies.set(request.idempotencyKey, reply);
        if (dropNext) { dropNext = false; throw loseAnswer(); }
        return reply;
      };
      notes.length = 0;
      assert.equal(await sandbox.saveClothesOrderFromModal(), false);
      const firstPressNotes = notes.splice(0);
      orderFields['clothes-order-phone'] = '0922222222';
      assert.equal(await sandbox.saveClothesOrderFromModal(), false);
      assert.equal(sentOrders.length, 2);
      assert.equal(sentOrders[1].orderId, sentOrders[0].orderId, `before: a new order id, so the stock was taken twice (${lost})`);
      assert.notEqual(sentOrders[1].idempotencyKey, sentOrders[0].idempotencyKey);
      assert.equal(stockTakes, 1);
      assert.ok(notes.some(note => note.message.includes('already saved by your first Save')), JSON.stringify(notes));
      assert.ok(firstPressNotes.some(note => note.title === 'Connection problem' && !/Load failed/.test(note.message)), JSON.stringify(firstPressNotes));
      // Closing the form: the next new order is a new order.
      sandbox.closeModal();
      run(orderLines);
      orderFields['clothes-order-customer'] = 'Mona';
      assert.equal(await sandbox.saveClothesOrderFromModal(), true);
      assert.notEqual(sentOrders[2].orderId, sentOrders[0].orderId);
      assert.equal(stockTakes, 2);
    }
  });
  await test('R5 error-paths-offline-4: refusals and dropped connections read in Arabic with the real reason, never "Server Error", an internal id or "Load failed"', async () => {
    const { sandbox, state, run } = loadBrowserSource();
    run('Security.escapeHtml = s => String(s ?? "")');
    state.language = 'ar';
    state.serverMode = true;
    sandbox.isServerModeEnabled = () => true;
    sandbox.console = { ...sandbox.console, error() {} };
    const notes = [];
    sandbox.showNotification = (title, message, type) => notes.push({ title, message, type });
    sandbox.addAuditLog = () => {};
    // A receipt delete in a closed month (the batch delete path).
    state.receipts = [{ id: 'receipt_123', recordType: 'receipt', customerId: 'c1', amountUSD: 10, amountLocal: 50, exchangeRate: 5, status: 'Paid', isPaid: true,
      serialNumber: '7001', payments: [], transfers: [], createdBy: 'admin', _lastModified: 3 }];
    sandbox.apiBatchDeleteEntities = async () => { throw Object.assign(new Error('Financial period 2026-09 is closed. An Admin must unlock it before editing.'), { status: 423 }); };
    await sandbox.deleteReceipt('receipt_123');
    let note = notes[notes.length - 1];
    assert.equal(note.title, 'غير مسموح', `before: "Server Error" with the English sentence: ${JSON.stringify(notes)}`);
    assert.ok(note.message.includes('مُقفل') && note.message.includes('تم التراجع عن الحذف بالكامل') && !/Financial period|Server/.test(note.message), note.message);
    assert.ok(!state.receipts[0]._deleted, 'the refused delete rolled back');
    // The batch wording carries the receipt's internal id: it never reaches the toast.
    sandbox.apiBatchDeleteEntities = async () => { throw Object.assign(new Error('Receipt receipt_123 cannot be deleted while linked to ad funding'), { status: 409 }); };
    await sandbox.deleteReceipt('receipt_123');
    note = notes[notes.length - 1];
    assert.ok(!note.message.includes('receipt_') && !/[A-Za-z]{3,}/.test(note.message), note.message);
    state.language = 'en';
    assert.equal(sandbox._serverRefusalText('Receipt cannot be deleted while linked to outgoing transfer'),
      'This receipt is linked to ad funding or a transfer, so it cannot be deleted. Release those links first.');
    state.language = 'ar';
    // An expired session says so.
    sandbox.apiBatchDeleteEntities = async () => { throw Object.assign(new Error('Not authenticated'), { status: 401 }); };
    await sandbox.deleteReceipt('receipt_123');
    assert.equal(notes[notes.length - 1].title, 'انتهت الجلسة');
    // A dropped connection: "may have gone through", never "Load failed", "Server Error" or "nothing was saved".
    const lost = sandbox._serverRefusalToast('save', 'receipts', new TypeError('Load failed'));
    assert.equal(lost[0], 'مشكلة في الاتصال', `before: ${lost.join(' | ')}`);
    assert.ok(!/Load failed|خطأ في الخادم|لم يتم الحفظ/.test(lost.join(' ')) && lost[1].includes('ما أدخلته ما زال في النموذج'), lost.join(' | '));
    // An app refusal raised while the phone is offline is no lost answer: it keeps its own words.
    sandbox.navigator.onLine = false;
    const busy = sandbox._serverRefusalToast('save', 'ads', sandbox.adSaveBusyError('AD_SAVE_BUSY'));
    assert.ok(busy[1].includes('ما زال قيد الإرسال') && busy[0] !== 'مشكلة في الاتصال', busy.join(' | '));
    assert.equal(sandbox._serverRefusalToast('save', 'receipts', new TypeError('Load failed'))[0], 'مشكلة في الاتصال');
    sandbox.navigator.onLine = true;
    const lostDelete = sandbox._serverRefusalToast('delete', 'customers', Object.assign(new DOMException('The request timed out', 'AbortError'), { noRetry: true }));
    assert.equal(lostDelete[0], 'مشكلة في الاتصال');
    assert.ok(lostDelete[1].includes('تأكيد الحذف') && !lostDelete[1].includes('النموذج'), lostDelete[1]);
    // The shared form submit handler (any form whose save throws): the same connection text.
    let submit = null;
    const form = { id: 'modal-form', dataset: {}, addEventListener: (type, handler) => { if (type === 'submit') submit = handler; } };
    sandbox.document.getElementById = id => (id === 'modal-form' ? form : null);
    state.activeModal = 'customer';
    state.modalData = null;
    sandbox.renderModal();
    assert.equal(typeof submit, 'function');
    sandbox.handleModalSubmit = async () => { throw new TypeError('Load failed'); };
    notes.length = 0;
    await submit({ preventDefault() {}, submitter: null });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, 'مشكلة في الاتصال', `before: "Error" / "Load failed": ${JSON.stringify(notes)}`);
    assert.ok(!notes[0].message.includes('Load failed'), notes[0].message);
    // Customer form: a phone the server would refuse is refused here, in Arabic, before anything is sent.
    const fixture = loadBrowserSource();
    const f = fixture.sandbox;
    f.URLSearchParams = URLSearchParams;
    fixture.state.language = 'ar';
    let added = 0;
    f.addRecord = async () => { added += 1; return true; };
    const formNotes = [];
    f.showNotification = (title, message) => formNotes.push({ title, message });
    const customerFields = { 'customer-name': 'Ali', 'customer-platform': 'Phone', 'customer-joindate': '' };
    let typedPhone = '0';
    f.document.getElementById = id => (id in customerFields ? { value: customerFields[id] } : null);
    f.document.querySelectorAll = selector => (selector === '.customer-phone' ? [{ value: typedPhone }] : []);
    fixture.state.activeModal = 'customer';
    fixture.state.modalData = null;
    await f.handleModalSubmit();
    assert.equal(added, 0, 'before: "0" was sent and the server\'s English refusal came back');
    assert.ok(formNotes.some(n => n.title === 'خطأ في الإدخال' && n.message === 'رقم هاتف صحيح واحد على الأقل مطلوب (من 7 إلى 15 رقماً).'), JSON.stringify(formNotes));
    typedPhone = '091 234 5678';
    fixture.state.activeModal = 'customer';
    await f.handleModalSubmit();
    assert.equal(added, 1, 'a real number still saves');
    // The platform "Phone" reads "هاتف" on the customer card and in the form; the stored value stays "Phone".
    state.customers = [{ id: 'c9', name: 'Huda', platform: 'Phone', phones: ['0912345678'], createdBy: 'admin', _lastModified: 1 }];
    sandbox.document.getElementById = () => null;
    const view = String(sandbox.renderCustomersView());
    assert.ok(view.includes('rounded-full">هاتف</span>') && !view.includes('>Phone<'), 'before: the card said "Phone"');
    const row = String(sandbox.shellCustomerRow(state.customers[0], null, '', { canSeeContacts: false, canSeeBalance: false }));
    assert.ok(row.includes('هاتف') && !row.includes('Phone'), 'the summary row (no contacts or balance access) names the platform in Arabic');
    const made = [];
    const makeElement = sandbox.document.createElement;
    sandbox.document.createElement = tag => { const el = makeElement(tag); made.push(el); return el; };
    state.activeModal = 'customer';
    state.modalData = state.customers[0];
    sandbox.renderModal();
    const markup = made.map(el => String(el.innerHTML || '')).join('\n');
    assert.ok(markup.includes('<option value="Phone" selected>هاتف</option>') && markup.includes('<option value="Facebook" >Facebook</option>'), 'the option value stays "Phone"');
  });
  await test('R5 dates-timezones-1: after a top-up, saving an unchanged ad writes no fake Start/End Date change into its history', async () => {
    const savedTZ = process.env.TZ;
    process.env.TZ = 'Africa/Tripoli';
    try {
      // The server stores a top-up's end date with whole seconds; a Meta ad starts at a real UTC time (00:30 Tripoli).
      const ad = () => ({ ...r34AdV1(), adLinks: ['https://fb.example/new'], adLink: 'https://fb.example/new',
        startDate: '2026-09-30T22:30:00Z', endDate: '2026-10-07T00:00:00Z', days: 6, editCount: 0 });
      const t = r34AdForm(ad());
      Object.assign(t.fields, { 'ad-start-date': '2026-10-01', 'ad-end-date': '2026-10-07', 'ad-days': '6' });
      await t.sandbox.handleModalSubmit();
      assert.equal(t.sent.length, 1, JSON.stringify(t.notes));
      const rows = sent => (sent.data.editHistory || []).flatMap(entry => entry.changes || []).map(change => change.field);
      assert.deepEqual(rows(t.sent[0]), [], 'before: "End Date 07/10/2026 -> 07/10/2026" and a Start Date row nobody made');
      assert.equal(t.sent[0].data.editCount, 0);
      // A real change of the end date is still recorded, once.
      const real = r34AdForm(ad());
      Object.assign(real.fields, { 'ad-start-date': '2026-10-01', 'ad-end-date': '2026-10-09', 'ad-days': '8' });
      await real.sandbox.handleModalSubmit();
      assert.deepEqual(rows(real.sent[0]), ['End Date']);
      assert.equal(real.sent[0].data.editCount, 1);
    } finally {
      if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
    }
  });

  // Bug hunt R6 (R6-clothes-second-pass-1): a shipment line left on "— color & size —" for a product with
  // colors/sizes saved, and receiving it put every piece in a stray "unspecified" stock row (orders refused).
  await test('R6 clothes-second-pass-1: a shipment line needs a color & size when its product has them, as an order line does; a new or reopened color/size and a product without them still save', async () => {
    const { sandbox, state, run, notes } = clothesFixture();
    const fields = { 'clothes-shipment-ref': 'Turkey batch', 'clothes-shipment-date': '2026-10-01', 'clothes-shipment-shipping': '0',
      'clothes-shipment-editing-id': '', 'clothes-shipment-editing-version': '0' };
    sandbox.document.getElementById = id => (id in fields ? { value: fields[id] } : null);
    const sent = [];
    sandbox.addRecord = async (list, record) => { sent.push(record.lines); return true; };
    sandbox.updateRecord = async (list, id, updates) => { sent.push(updates.lines); return true; };
    sandbox.renderModal = () => {};
    sandbox.updateUrlParams = () => {};
    state.clothesProducts = [
      { id: 'p1', name: 'Shirt', costUSD: 2, priceLYD: 20, createdBy: 'admin', variants: [{ color: 'Red', size: 'M', qty: 0 }, { color: 'Blue', size: 'L', qty: 0 }] },
      { id: 'p2', name: 'Scarf', costUSD: 1, priceLYD: 10, createdBy: 'admin', variants: [] }
    ];
    state.clothesShipments = [];
    const save = line => { run(`_clothesTempShipLines = [${JSON.stringify(line)}]`); return sandbox.saveClothesShipmentFromModal(); };
    const blank = { productId: 'p1', color: '', size: '', qty: 10, unitCostUSD: '2' };
    assert.equal(await save(blank), false, 'before: saved with color "", so receiving filled an "unspecified" row');
    assert.equal(notes.pop()?.message, 'Choose a color & size for "Shirt".');
    assert.equal(await save({ ...blank, _newVariant: true }), false, '"+ new color/size" chosen with nothing typed');
    state.language = 'ar';
    assert.equal(await save(blank), false);
    assert.equal(notes.pop()?.message, 'اختر اللون والمقاس للمنتج "Shirt".');
    state.language = 'en';
    assert.equal(sent.length, 0, 'nothing was sent');
    assert.equal(await save({ ...blank, color: 'Red', size: 'M' }), true);
    assert.equal(await save({ ...blank, color: 'Green', size: 'XL', _newVariant: true }), true, 'a new color/size typed');
    assert.equal(await save({ productId: 'p2', color: '', size: '', qty: 5, unitCostUSD: '1' }), true, 'a product without colors/sizes');
    // A saved shipment reopened before it is received: its new Green/XL is not on the product yet.
    state.clothesShipments = [{ id: 's1', status: 'Ordered', createdBy: 'admin', _lastModified: 3, lines: [{ productId: 'p1', color: 'Green', size: 'XL', qty: 3, unitCostUSD: 2 }] }];
    sandbox.editClothesShipment('s1');
    fields['clothes-shipment-editing-id'] = 's1';
    assert.equal(await sandbox.saveClothesShipmentFromModal(), true, 'the reopened Green/XL line still saves');
    // A product that really has a blank ('', '') row may still receive into it.
    fields['clothes-shipment-editing-id'] = '';
    state.clothesProducts[0].variants.push({ color: '', size: '', qty: 4 });
    assert.equal(await save(blank), true);
    assert.deepEqual(sent.map(lines => lines.map(l => `${l.productId}:${l.color}/${l.size}x${l.qty}`).join()),
      ['p1:Red/Mx10', 'p1:Green/XLx10', 'p2:/x5', 'p1:Green/XLx3', 'p1:/x10']);
  });
  // R6-clothes-second-pass-2: an account given the Clothes "View all" permissions (platform staff) opened an
  // empty Clothes System: every screen kept only the records that account created.
  await test('R6 clothes-second-pass-2: staff with the Clothes "view" permissions see the shop\'s products, shipments and orders; a viewOwn subscriber still sees only their own', async () => {
    const { sandbox, state, run } = clothesFixture();
    run('Security').escapeHtml = plainEscape;
    const staff = { id: 'staff1', name: 'Staff', role: 'Employee',
      permissions: { clothesProducts: ['view', 'edit'], clothesShipments: ['view'], clothesOrders: ['view', 'add', 'edit'] } };
    const own = ['viewOwn', 'add', 'editOwn', 'deleteOwn'];
    const subscriber = { id: 'sub2', name: 'Shop', role: 'Employee', permissions: { clothesProducts: own, clothesShipments: own, clothesOrders: own } };
    state.users = [staff, subscriber];
    state.clothesProducts = [{ id: 'cp1', name: 'Owner shirt', costUSD: 2, priceLYD: 20, createdBy: 'owner', variants: [{ color: 'Red', size: 'M', qty: 5 }] }];
    state.clothesShipments = [{ id: 's1', ref: 'Turkey', status: 'Ordered', createdBy: 'owner', lines: [] }];
    state.clothesOrders = [{ id: 'o1', orderNo: 7, customerName: 'Walk-in', status: 'New', paymentStatus: 'Not Paid', createdBy: 'owner', lines: [] }];
    const lines = { innerHTML: '' };
    sandbox.document.getElementById = id => (id === 'clothes-order-lines' ? lines : null);
    const counts = () => [sandbox.getVisibleClothesProducts().length, sandbox.getVisibleClothesShipments().length, sandbox.getVisibleClothesOrders().length];
    state.currentUser = staff;
    assert.deepEqual(counts(), [1, 1, 1], 'before: 0, 0, 0');
    assert.ok(!String(sandbox.renderClothesProductsTab()).includes('No products yet'), 'before: "No products yet"');
    run("_clothesTempOrderLines = [{ productId: '', color: '', size: '', qty: 1, priceLYD: '' }]");
    sandbox.refreshClothesOrderLines();
    assert.ok(lines.innerHTML.includes('>Owner shirt</option>'), 'the order form offers the shop\'s product');
    state.currentUser = subscriber;
    assert.deepEqual(counts(), [0, 0, 0], 'a subscriber never sees another shop\'s records');
    state.clothesProducts.push({ id: 'cp2', name: 'Mine', createdBy: 'sub2', variants: [] });
    assert.equal(sandbox.getVisibleClothesProducts().map(p => p.id).join(), 'cp2');
  });
  // R6-clothes-second-pass-3: an Edit tap on a record whose photos were still loading later replaced whatever
  // form the user had opened meanwhile, so the order, product, ad or receipt being typed was lost.
  await test('R6 clothes-second-pass-3: a product Edit still loading its photo never replaces an order form opened meanwhile, nor a later Edit (an ad Edit too)', async () => {
    const { sandbox, state, run } = clothesFixture();
    const opened = [];
    sandbox.renderModal = () => opened.push(`${state.activeModal}:${state.modalData ? state.modalData.id : 'new'}`);
    sandbox.updateUrlParams = () => {};
    const release = {};
    sandbox.ensureEntityMediaLoaded = (collection, id) => new Promise(resolve => {
      const list = collection === 'ads' ? state.ads : state.clothesProducts;
      release[id] = () => resolve({ ...list.find(r => r.id === id), photo: 'data:image/jpeg;base64,AAAA', _mediaOmitted: false });
    });
    const lean = id => ({ id, name: `Shirt ${id}`, createdBy: 'admin', _lastModified: 5, _mediaOmitted: true, _photoCount: 1, variants: [{ color: 'Red', size: 'M', qty: 3 }] });
    state.clothesProducts = [lean('pA'), { ...lean('pB'), _mediaOmitted: false, photo: 'data:image/jpeg;base64,BBBB' }];
    state.ads = [{ id: 'adA', createdBy: 'admin', creatorId: 'admin', _mediaOmitted: true, _photoCount: 1 }];
    let late = sandbox.editClothesProduct('pA');
    sandbox.showClothesOrderModal();
    run("_clothesTempOrderLines = [{ productId: 'pA', color: 'Red', size: 'M', qty: 2, priceLYD: '25' }]");
    release.pA(); await late;
    assert.equal(state.activeModal, 'clothes-order', 'before: the product form replaced the order being typed');
    assert.equal(state.modalData, null);
    assert.equal(run('JSON.stringify(_clothesTempOrderLines)'), JSON.stringify([{ productId: 'pA', color: 'Red', size: 'M', qty: 2, priceLYD: '25' }]));
    // Edit A (loading) then B (already loaded): B stays open.
    state.activeModal = null; state.modalData = null;
    late = sandbox.editClothesProduct('pA');
    await sandbox.editClothesProduct('pB');
    release.pA(); await late;
    assert.equal(state.modalData?.id, 'pB', 'before: A replaced B');
    // Product A, then an ad, both loading: only the last tap opens, whichever answer comes first.
    state.activeModal = null; state.modalData = null;
    late = sandbox.editClothesProduct('pA');
    const ad = sandbox.editAd('adA');
    release.pA(); await late;
    release.adA(); await ad;
    assert.deepEqual(opened, ['clothes-order:new', 'clothes-product:pB', 'ad:adA']);
  });
  await test('R6 clothes-second-pass-3: an ad or receipt Edit still loading its photos never replaces a receipt form opened meanwhile, nor a later Edit; the last tap wins', async () => {
    const { sandbox, state } = loadBrowserSource();
    const opened = [];
    sandbox.renderModal = () => opened.push(`${state.activeModal}:${state.modalData ? state.modalData.id : 'new'}`);
    sandbox.updateUrlParams = () => {};
    const release = {};
    sandbox.ensureEntityMediaLoaded = (collection, id) => new Promise(resolve => {
      const list = collection === 'ads' ? state.ads : state.receipts;
      release[id] = () => resolve({ ...list.find(r => r.id === id), photos: ['data:image/jpeg;base64,AAAA'], _mediaOmitted: false });
    });
    const lean = { createdBy: 'admin', creatorId: 'admin', _mediaOmitted: true, _photoCount: 1 };
    state.ads = [{ id: 'adA', ...lean }, { id: 'adB', createdBy: 'admin', creatorId: 'admin' }];
    state.receipts = [{ id: 'rA', status: 'Not Paid', ...lean }, { id: 'rB', status: 'Not Paid', createdBy: 'admin' }];
    for (const [edit, modal, a, b] of [['editAd', 'ad', 'adA', 'adB'], ['editReceipt', 'receipt', 'rA', 'rB']]) {
      state.activeModal = null; state.modalData = null; opened.length = 0;
      let late = sandbox[edit](a);
      sandbox.showReceiptModal();  // a new receipt typed while A's photos load
      release[a](); await late;
      assert.equal(state.activeModal, 'receipt');
      assert.equal(state.modalData, null, `before: ${edit} replaced the new receipt form`);
      state.activeModal = null; state.modalData = null;
      late = sandbox[edit](a);
      await sandbox[edit](b);
      release[a](); await late;
      assert.equal(state.modalData?.id, b, `before: ${edit} A replaced B`);
      assert.deepEqual(opened, ['receipt:new', `${modal}:${b}`]);
    }
    state.activeModal = null; state.modalData = null; opened.length = 0;
    const first = sandbox.editAd('adA'), second = sandbox.editReceipt('rA');
    release.adA(); await first;
    release.rA(); await second;
    assert.deepEqual(opened, ['receipt:rA'], 'before: the ad form opened, then the receipt replaced it');
  });
  // R6-clothes-second-pass-5: the Orders search by phone missed the same number written another way.
  await test('R6 clothes-second-pass-5: the Clothes Orders search finds a phone however it was written (091-..., +218 91 ..., 00218...), like the receipt search', async () => {
    const { state, run } = clothesFixture();
    const phones = ['0912345678', '091-234-5678', '+218 91 234 5678', '00218912345678'];
    state.clothesOrders = phones.map((customerPhone, i) => ({ id: `o${i}`, orderNo: i + 1, customerName: `Store ${i + 1}`, customerPhone,
      status: 'New', paymentStatus: 'Not Paid', lines: [], createdBy: 'admin' }));
    state.clothesOrders.push({ id: 'o42', orderNo: 42, customerName: 'Walk-in', customerPhone: '0920000000', status: 'New', paymentStatus: 'Not Paid', lines: [], createdBy: 'admin' },
      { id: 'o5', orderNo: 5, customerName: 'Hana', customerPhone: '0924200000', status: 'New', paymentStatus: 'Not Paid', lines: [], createdBy: 'admin' });
    const found = q => { run(`_clothesOrderSearch = ${JSON.stringify(q)}`); return run('getFilteredClothesOrders().map(o => o.id).join()'); };
    assert.equal(found('0912345678'), 'o0,o1,o2,o3', 'before: o0 only');
    assert.equal(found('091 234 5678'), 'o0,o1,o2,o3', 'before: none');
    assert.equal(found('+218912345678'), 'o0,o1,o2,o3', 'before: none');
    assert.equal(found('٠٩١٢٣٤٥٦٧٨'), 'o0,o1,o2,o3', 'Arabic digits');
    assert.equal(found('Store 2'), 'o1', 'a name search matches no phone');
    assert.equal(found('0042'), 'o42', 'order #0042 typed as the list shows it stays an order-number search');
  });
  // Bug hunt r6 (R6-ios-fresh-install-journey-1): init() applied the theme before loadState() restored it,
  // so a saved Dark (or System on a dark phone) started light and saved 'light' for the next first paint.
  await test('R6 ios-fresh-install-journey-1: a saved Dark theme, or System on a dark phone, is painted at start-up and kept for the next first paint; Light stays light', async () => {
    const boot = async (theme, phoneDark) => {
      const { sandbox, state, run } = loadBrowserSource();
      const root = sandbox.document.documentElement;
      root.classList = fakeClassList();
      sandbox.window.matchMedia = sandbox.matchMedia = query => ({ matches: phoneDark && query === '(prefers-color-scheme: dark)', addEventListener() {}, addListener() {} });
      sandbox.URLSearchParams = URLSearchParams;
      // What saveState() left on the device, and the first paint index.html's inline script made from it.
      sandbox.localStorage.setItem('albayan_complete_state', JSON.stringify({ language: 'en', theme, serverModeOverride: 'local' }));
      const painted = theme === 'dark' || (theme === 'system' && phoneDark) ? 'dark' : 'light';
      sandbox.localStorage.setItem('albayan_theme', painted);
      if (painted === 'dark') root.classList.add('dark');
      state.currentUser = null; state.users = []; state.theme = 'light';
      // No storage or server; the sanitizer's chunked pass waits on timers this sandbox never runs.
      Object.assign(sandbox, { initIndexedDB: async () => null, apiHealthCheck: async () => false, sanitizeAllCollectionsForRendering: async () => {} });
      await run('init()');
      assert.equal(state.theme, theme, 'loadState() restored the saved choice');
      return { dark: root.classList.contains('dark'), firstPaint: sandbox.localStorage.getItem('albayan_theme'), colorScheme: root.style.colorScheme };
    };
    assert.deepEqual(await boot('dark', false), { dark: true, firstPaint: 'dark', colorScheme: 'dark' }, 'before: painted light, and light saved for the next start');
    assert.deepEqual(await boot('system', true), { dark: true, firstPaint: 'dark', colorScheme: 'dark' });
    assert.deepEqual(await boot('system', false), { dark: false, firstPaint: 'light', colorScheme: 'light' });
    assert.deepEqual(await boot('light', true), { dark: false, firstPaint: 'light', colorScheme: 'light' });
  });
  // Bug hunt r6 (R6-ios-fresh-install-journey-3): the sign-in "Welcome" toasts escaped the name, and
  // showNotification escaped it again, so "O'Neil & Sons" read "O&#39;Neil &amp; Sons".
  await test('R6 ios-fresh-install-journey-3: the Welcome toast after a server, local or passkey sign-in shows a name with \' and & as typed, and markup in a name stays text', async () => {
    const signIn = async (how, name, language = 'en') => {
      const { sandbox, state, run } = loadBrowserSource();
      run('Security').escapeHtml = plainEscape;  // the browser's textContent -> innerHTML, plus quotes
      delete sandbox.showNotification;  // the helper's stub hides the real one; the context still holds it
      const toasts = [];
      const container = { children: [], appendChild: node => toasts.push(node) };
      const getElementById = sandbox.document.getElementById;
      sandbox.document.getElementById = id => (id === 'notification-container' ? container : getElementById(id));
      state.language = language;
      const user = { id: 'u_1', name, email: 'owner@example.com', role: 'Admin', permissions: {},
        passwordHash: 'hash', salt: 'salt', passwordAlgo: 'pbkdf2-sha256', passwordIterations: 10000000 };
      if (how === 'server') {
        Object.assign(sandbox, { serverLoadAllData: async () => ({ failed: [] }), startServerLiveSync() {}, activateServerCollectionStorage() {} });
        await sandbox._activateServerSession(user, run('_loginGeneration'));
      } else if (how === 'local') {
        state.users = [user];
        run('Security').verifyPassword = async () => true;
        await sandbox._handleLocalLoginOnce(user.email, 'secret', run('_loginGeneration'));
        assert.equal(state.logs[0]?.description, `User ${name} logged in`, 'the audit line keeps the name; its views escape it once');
      } else {
        // A stored passkey the device signs for (the WebAuthn checks pass).
        Object.assign(sandbox, { TextEncoder, TextDecoder, _isPasskeySupported: () => true, _getRpId: () => 'localhost',
          _listAllStoredPasskeys: () => [{ user, key: { id: 'cred_1', publicKeyJwk: {} } }],
          _b64urlToBuf: () => new Uint8Array(1), _bufToB64url: () => 'cred_1', _sha256: async () => new Uint8Array(32) });
        sandbox.crypto.subtle = { importKey: async () => ({}), verify: async () => true };
        sandbox.navigator.credentials.get = async () => ({ rawId: new Uint8Array(1), response: {
          clientDataJSON: new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', origin: sandbox.location.origin })),
          authenticatorData: new Uint8Array(37), signature: new Uint8Array(1) } });
        await sandbox.passkeySignIn();
      }
      assert.equal(state.currentUser?.id, 'u_1', `the ${how} sign-in went through`);
      const welcome = toasts.find(node => /Welcome!|مرحباً!/.test(String(node.innerHTML)));
      return (String(welcome?.innerHTML).match(/<div class="text-xs opacity-80 break-words">([^<]*)<\/div>/) || [])[1];
    };
    assert.equal(await signIn('server', "O'Neil & Sons"), 'Logged in as O&#39;Neil &amp; Sons. Loading data...', 'before: O&amp;#39;Neil &amp;amp; Sons');
    assert.equal(await signIn('server', "O'Neil & Sons", 'ar'), 'تم تسجيل الدخول باسم O&#39;Neil &amp; Sons. جارٍ تحميل البيانات...');
    assert.equal(await signIn('local', "O'Neil & Sons"), 'Logged in as O&#39;Neil &amp; Sons');
    assert.equal(await signIn('passkey', "O'Neil & Sons"), 'Logged in as O&#39;Neil &amp; Sons');
    // Escaped once is still escaped: a name holding markup reaches the toast only as text.
    const hostile = await signIn('server', '<img src=x onerror=alert(1)>');
    assert.equal(hostile, 'Logged in as &lt;img src=x onerror=alert(1)&gt;. Loading data...');
  });
  console.log(`\n${passed} review behavior regressions passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
