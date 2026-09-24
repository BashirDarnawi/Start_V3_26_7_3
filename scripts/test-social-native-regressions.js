// Authoritative browser fragments with deferred API/native boundaries only.
// No real Meta publishing, notifications, camera, server or customer records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadBrowserSource = require('./helpers/load-browser-source');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  PASS  ${name}`); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function fixture() {
  const f = loadBrowserSource();
  for (const file of ['systems/ads_studio/15c-ads-studio.js', 'systems/ads_studio/15f-social-studio.js']) {
    f.run(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  }
  f.state.currentView = 'ads-studio';
  f.sandbox.socialStudioAvailable = () => true;
  f.sandbox.socialRefreshNow = () => {};
  const notices = [];
  f.sandbox.showNotification = (...args) => notices.push(args);
  f.run("_social.forUser = 'admin'; _social.pages = [{ id: 'page_a', name: 'Page A', platform: 'fb' }]; _social.posts = [{ id: 'post_a', caption: 'A summary' }, { id: 'post_b', caption: 'B summary' }]; _social.rules = [{ id: 'rule_a', name: 'Rule A', enabled: true }]; _social.availablePages = [{ metaPageId: '123', platform: 'fb', name: 'Available page' }];");
  const newComposer = () => f.run("_social.composer = { id: '', pageIds: ['page_a'], caption: 'A caption', media: [], mode: 'now', scheduledAt: '', autoReply: false, autoReplyRuleId: '' }; _social.screen = 'compose';");
  const newRule = () => f.run("_social.ruleDraft = { ...socialNewRule(), id: 'rule_a', name: 'Rule A', trigger: 'every', publicReply: 'Thank you' }; _social.screen = 'rule';");
  const switchSession = (kind = 'user') => {
    if (kind === 'permissions') f.state.currentUser.permissions = { ads: { view: false } };
    else {
      f.sandbox.resetAuthenticatedServerCaches();
      if (kind === 'user') f.state.currentUser = { id: 'customer_b', role: 'Customer', permissions: {} };
      if (kind === 'logout') f.state.currentUser = null;
    }
  };
  return { ...f, notices, newComposer, newRule, switchSession };
}

function nativeFixture() {
  const f = fixture();
  f.sandbox.isPackagedMobileApp = () => true;
  f.run('_nativePrefs.remindersEnabled = true');
  f.state.ads = [{ id: 'ad_a' }];
  f.sandbox.getAdReconciliationAvailableDay = () => f.run('new Date(Date.now() + 86400000)');
  const notes = new Map();
  const calls = [];
  const plugin = {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    getPending: async () => ({ notifications: [...notes.values()] }),
    schedule: async ({ notifications }) => { calls.push(['schedule', notifications]); notifications.forEach(n => notes.set(n.id, n)); },
    cancel: async ({ notifications }) => { calls.push(['cancel', notifications]); notifications.forEach(n => notes.delete(n.id)); }
  };
  f.sandbox.getCapacitorPlugin = name => name === 'LocalNotifications' ? plugin : null;
  f.sandbox.nativeSecureSet = async () => true;
  return { ...f, notes, calls, plugin };
}

async function main() {
  for (const change of ['user', 'logout', 'same-user-reset', 'permissions']) {
    await test(`late private post cannot refill the composer after ${change}`, async () => {
      const f = fixture(), gate = deferred();
      f.sandbox.apiJson = () => gate.promise;
      const op = f.sandbox.socialEditPost('post_a');
      f.switchSession(change);
      f.run("_social.composer = { id: 'new_b', caption: 'Keep B', media: [] }; _social.screen = 'compose';");
      gate.resolve({ post: { id: 'post_a', caption: 'Private A', media: ['private photo'], pageIds: ['private page'] } });
      await op;
      assert.equal(f.run('_social.composer.caption'), 'Keep B');
      assert.equal(f.notices.length, 0);
    });
  }
  await test('the latest edit selection wins when responses arrive out of order', async () => {
    const f = fixture(), a = deferred(), b = deferred();
    f.sandbox.apiJson = url => url.endsWith('post_a') ? a.promise : b.promise;
    const first = f.sandbox.socialEditPost('post_a'), second = f.sandbox.socialEditPost('post_b');
    b.resolve({ post: { id: 'post_b', caption: 'Chosen B' } }); await second;
    a.resolve({ post: { id: 'post_a', caption: 'Old A' } }); await first;
    assert.equal(f.run('_social.composer.caption'), 'Chosen B');
  });
  await test('closing a pending editor does not reopen it when data arrives', async () => {
    const f = fixture(), gate = deferred(); f.sandbox.apiJson = () => gate.promise;
    const op = f.sandbox.socialEditPost('post_a'); f.sandbox.socialComposerClose();
    gate.resolve({ post: { id: 'post_a', caption: 'Private A' } }); await op;
    assert.equal(f.run('_social.composer'), null); assert.equal(f.run('_social.screen'), '');
  });
  await test('same-session unavailable photo request still opens the existing summary', async () => {
    const f = fixture(); f.sandbox.apiJson = async () => { throw new Error('offline'); };
    await f.sandbox.socialEditPost('post_a'); assert.equal(f.run('_social.composer.caption'), 'A summary');
  });
  await test('same-user auth reset invalidates the complete studio load', async () => {
    const f = fixture(), gate = deferred(); f.sandbox.apiJson = () => gate.promise;
    const op = f.sandbox.socialStudioEnsureLoaded(true);
    f.switchSession('same-user-reset'); f.run('_social.loading = true');
    gate.resolve({ pages: [{ id: 'private' }], posts: [{ id: 'private' }], rules: [{ id: 'private' }] }); await op;
    assert.equal(f.run('_social.pages.length'), 0); assert.equal(f.run('_social.posts.length'), 0);
    assert.equal(f.run('_social.loading'), true); assert.equal(f.run('_social.loadedAt'), 0);
  });
  await test('reset invalidates available Meta pages and clears the previous link owner', async () => {
    const f = fixture(), gate = deferred(); f.sandbox.apiJson = () => gate.promise;
    f.run("_social.availablePages = null; _social.linkOwnerId = 'old_owner';");
    f.sandbox.socialOpenLinkSheet(); f.switchSession(); f.run('_social.availableBusy = true');
    gate.resolve({ pages: [{ id: 'private' }] }); await flush();
    assert.equal(f.run('_social.availablePages'), null); assert.equal(f.run('_social.availableBusy'), true);
    assert.equal(f.run('_social.linkOwnerId'), ''); assert.equal(f.notices.length, 0);
  });
  const operations = [
    ['link page', f => f.sandbox.socialLinkPage('123', 'fb', '')],
    ['unlink page', f => f.sandbox.socialUnlinkPage('page_a')],
    ['publish post', f => f.sandbox.socialPublishPost('post_a')],
    ['cancel schedule', f => f.sandbox.socialCancelPost('post_a')],
    ['delete post', f => f.sandbox.socialDeletePost('post_a')],
    ['toggle master', f => f.sandbox.socialToggleMaster()],
    ['toggle rule', f => f.sandbox.socialToggleRule('rule_a')],
    ['save rule', f => { f.newRule(); return f.sandbox.socialRuleSave(); }],
    ['delete rule', f => { f.newRule(); return f.sandbox.socialRuleDelete(); }],
    ['save/publish composer', f => { f.newComposer(); return f.sandbox.socialComposerSave('now'); }]
  ];
  for (const [label, start] of operations) {
    await test(`late ${label} cannot modify another session or start further requests`, async () => {
      const f = fixture(), gate = deferred(); let requests = 0;
      f.sandbox.apiJson = () => { requests++; return gate.promise; };
      const op = start(f); f.switchSession();
      f.run("_social.busy = true; _social.composer = { id: 'keep_b' }; _social.settings = { marker: 'B' };");
      gate.resolve({ post: { id: 'saved_a' }, settings: { masterEnabled: false }, rule: { id: 'rule_a' } }); await op;
      assert.equal(requests, 1); assert.equal(f.run('_social.busy'), true);
      assert.equal(f.run('_social.composer.id'), 'keep_b'); assert.equal(f.run('_social.settings.marker'), 'B');
      assert.equal(f.notices.length, 0);
    });
  }
  for (const change of ['new-draft', 'close', 'edit-caption']) {
    await test(`old create response cannot publish or erase ${change}`, async () => {
      const f = fixture(), gate = deferred(); f.newComposer(); const calls = [];
      f.sandbox.apiJson = url => { calls.push(url); return gate.promise; };
      const op = f.sandbox.socialComposerSave('now');
      if (change === 'close') f.sandbox.socialComposerClose();
      else if (change === 'new-draft') { f.sandbox.socialBeginCompose(); f.run("_social.composer.caption = 'Keep new draft'"); }
      else f.run("_social.composer.caption = 'Keep changed caption'");
      gate.resolve({ post: { id: 'saved_a' } }); await op;
      assert.equal(calls.length, 1); assert.notEqual(f.run('_social.screen'), 'post-done');
      if (change === 'close') assert.equal(f.run('_social.composer'), null);
      else assert.ok(f.run('_social.composer.caption').startsWith('Keep'));
      if (change === 'edit-caption') assert.equal(f.run('_social.composer.id'), 'saved_a');
    });
  }
  await test('normal new post saves, publishes once and shows its completion', async () => {
    const f = fixture(); f.newComposer(); const calls = [];
    f.sandbox.apiJson = async (url, options) => { calls.push([url, options]); return { post: { id: 'saved_a', status: url.endsWith('/publish') ? 'published' : 'draft' } }; };
    await f.sandbox.socialComposerSave('now');
    assert.equal(calls.length, 2); assert.equal(calls[1][0], '/api/social-studio/posts/saved_a/publish');
    assert.equal(f.run('_social.screen'), 'post-done'); assert.equal(f.run('_social.lastDone.post.status'), 'published');
  });
  await test('publish failure retry edits the saved post instead of creating a duplicate', async () => {
    const f = fixture(); f.newComposer(); const calls = []; let publishAttempts = 0;
    f.sandbox.apiJson = async (url, options) => {
      calls.push([url, options.method]);
      if (url.endsWith('/publish') && ++publishAttempts === 1) throw new Error('temporary network failure');
      return { post: { id: 'saved_a', status: 'draft' } };
    };
    await f.sandbox.socialComposerSave('now'); assert.equal(f.run('_social.composer.id'), 'saved_a');
    await f.sandbox.socialComposerSave('now');
    assert.equal(calls.filter(([url, method]) => url === '/api/social-studio/posts' && method === 'POST').length, 1);
    assert.deepEqual(calls[2], ['/api/social-studio/posts/saved_a', 'PATCH']);
  });
  for (const action of ['save', 'delete']) {
    await test(`late rule ${action} keeps a replacement rule draft intact`, async () => {
      const f = fixture(), gate = deferred(); f.newRule(); f.sandbox.apiJson = () => gate.promise;
      const op = action === 'save' ? f.sandbox.socialRuleSave() : f.sandbox.socialRuleDelete();
      f.sandbox.socialBeginRule(); f.run("_social.ruleDraft.name = 'Keep new rule'");
      gate.resolve({}); await op; assert.equal(f.run('_social.ruleDraft.name'), 'Keep new rule');
    });
  }

  await test('normal native reminders still schedule with record links', async () => {
    const f = nativeFixture(); assert.equal(await f.sandbox.syncNativeReconciliationReminders(), true);
    assert.equal(f.notes.size, 1); assert.equal([...f.notes.values()][0].extra.adId, 'ad_a');
  });
  for (const boundary of ['getPending', 'schedule']) {
    for (const change of ['disable', 'logout']) {
      await test(`native ${change} wins over an old in-flight ${boundary}`, async () => {
        const f = nativeFixture(), gate = deferred(); const original = f.plugin[boundary]; let first = true;
        f.plugin[boundary] = async (...args) => { if (first) { first = false; await gate.promise; } return original(...args); };
        const sync = f.sandbox.syncNativeReconciliationReminders(); await flush();
        let stop;
        if (change === 'disable') stop = f.sandbox.setNativeRemindersEnabled(false);
        else { f.sandbox.resetAuthenticatedServerCaches(); f.state.currentUser = null; stop = f.run('_nativeReminderWork'); }
        await flush(); gate.resolve(); await Promise.all([sync, stop]);
        assert.equal(f.notes.size, 0);
        if (change === 'disable') assert.equal(f.run('_nativePrefs.remindersEnabled'), false);
      });
    }
  }
  await test('disabling removes Albayan reconciliation reminders, not unrelated notifications', async () => {
    const f = nativeFixture(); f.notes.set(1, { id: 1, extra: { albayanType: 'other' } });
    await f.sandbox.syncNativeReconciliationReminders(); await f.sandbox.setNativeRemindersEnabled(false);
    assert.deepEqual([...f.notes.keys()], [1]);
  });
  await test('new session schedules only its own reminders after old cancellation', async () => {
    const f = nativeFixture(); await f.sandbox.syncNativeReconciliationReminders();
    f.sandbox.resetNativeReminderSession(); f.state.currentUser = { id: 'customer_b', role: 'Admin', permissions: {} }; f.state.ads = [{ id: 'ad_b' }];
    await f.sandbox.syncNativeReconciliationReminders();
    assert.deepEqual([...f.notes.values()].map(n => n.extra.adId), ['ad_b']);
  });
  await test('permission prompt completing after disable cannot turn reminders on', async () => {
    const f = nativeFixture(), gate = deferred(); f.run('_nativePrefs.remindersEnabled = false');
    f.plugin.checkPermissions = async () => ({ display: 'prompt' }); f.plugin.requestPermissions = () => gate.promise;
    const on = f.sandbox.setNativeRemindersEnabled(true); await flush();
    const off = f.sandbox.setNativeRemindersEnabled(false); gate.resolve({ display: 'granted' }); await Promise.all([on, off]);
    assert.equal(f.run('_nativePrefs.remindersEnabled'), false); assert.equal(f.notes.size, 0);
  });
  await test('disable suppresses newly queued sync and cancels existing notes while secure storage waits', async () => {
    const f = nativeFixture(), gate = deferred();
    await f.sandbox.syncNativeReconciliationReminders(); assert.equal(f.notes.size, 1);
    f.sandbox.nativeSecureSet = () => gate.promise;
    const off = f.sandbox.setNativeRemindersEnabled(false); await flush();
    assert.equal(f.notes.size, 0);
    assert.equal(f.run('_nativePrefs.remindersEnabled'), true, 'persisted preference is unchanged until confirmed');
    const calls = f.calls.filter(([kind]) => kind === 'schedule').length;
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false);
    f.sandbox.queueNativeReminderSync(); assert.equal(f.run('_nativeReminderTimer'), null);
    assert.equal(f.calls.filter(([kind]) => kind === 'schedule').length, calls);
    gate.resolve(true); assert.equal(await off, true); assert.equal(f.notes.size, 0);
  });
  await test('failed disable reports failure but remains suppressed without pretending preference was saved', async () => {
    const f = nativeFixture(); await f.sandbox.syncNativeReconciliationReminders();
    f.sandbox.nativeSecureSet = async () => false;
    assert.equal(await f.sandbox.setNativeRemindersEnabled(false), false); await flush();
    assert.equal(f.run('_nativePrefs.remindersEnabled'), true);
    assert.equal(f.run('_nativeReminderSchedulingSuppressed'), true); assert.equal(f.notes.size, 0);
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false);
    assert.ok(f.notices.some(args => args[0] === 'Could not save reminder setting' && args[1].includes('this session only')));
  });
  await test('successful re-enable lifts suppression only after secure storage confirms', async () => {
    const f = nativeFixture(); await f.sandbox.setNativeRemindersEnabled(false);
    const gate = deferred(); f.sandbox.nativeSecureSet = () => gate.promise;
    const on = f.sandbox.setNativeRemindersEnabled(true); await flush();
    assert.equal(f.run('_nativeReminderSchedulingSuppressed'), true);
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false);
    gate.resolve(true); assert.equal(await on, true);
    assert.equal(f.run('_nativeReminderSchedulingSuppressed'), false);
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), true); assert.equal(f.notes.size, 1);
  });
  await test('failed re-enable never lifts the disable suppression fence', async () => {
    const f = nativeFixture(); await f.sandbox.setNativeRemindersEnabled(false);
    f.sandbox.nativeSecureSet = async () => false;
    assert.equal(await f.sandbox.setNativeRemindersEnabled(true), false);
    assert.equal(f.run('_nativeReminderSchedulingSuppressed'), true);
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false); assert.equal(f.notes.size, 0);
  });
  for (const lastEnabled of [true, false]) {
    await test(`rapid toggles during secure storage preserve latest ${lastEnabled ? 'enable' : 'disable'} intent`, async () => {
      const f = nativeFixture(), gate = deferred(); const writes = []; let first = true;
      f.sandbox.nativeSecureSet = async (_key, value) => { writes.push(value); if (first) { first = false; await gate.promise; } return true; };
      const off = f.sandbox.setNativeRemindersEnabled(false); await flush();
      const on = f.sandbox.setNativeRemindersEnabled(true);
      const final = lastEnabled ? on : f.sandbox.setNativeRemindersEnabled(false);
      assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false);
      gate.resolve(); await Promise.all([off, on, final]);
      assert.equal(writes.at(-1), lastEnabled);
      assert.equal(f.run('_nativePrefs.remindersEnabled'), lastEnabled);
      assert.equal(f.run('_nativeReminderSchedulingSuppressed'), !lastEnabled);
      assert.equal(await f.sandbox.syncNativeReconciliationReminders(), lastEnabled);
      assert.equal(f.notes.size, lastEnabled ? 1 : 0);
    });
  }
  await test('late re-enable storage completion after logout cannot lift suppression', async () => {
    const f = nativeFixture(); await f.sandbox.setNativeRemindersEnabled(false);
    const gate = deferred(); f.sandbox.nativeSecureSet = () => gate.promise;
    const on = f.sandbox.setNativeRemindersEnabled(true); await flush();
    f.sandbox.resetAuthenticatedServerCaches(); f.state.currentUser = null;
    gate.resolve(true); assert.equal(await on, false);
    assert.equal(f.run('_nativeReminderSchedulingSuppressed'), true); assert.equal(f.notes.size, 0);
  });
  await test('web fallback does not invoke a native notification service', async () => {
    const f = fixture(); let calls = 0; f.sandbox.getCapacitorPlugin = () => { calls++; return null; };
    assert.equal(await f.sandbox.syncNativeReconciliationReminders(), false);
    assert.equal(await f.sandbox.setNativeRemindersEnabled(true), false); assert.equal(calls, 0);
  });
  console.log(`\n${passed} Social Studio/native regressions passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
