// Compatibility and deployment-refresh regressions use synthetic browser state.
// No application server, production database, credentials, or real network.
const assert = require('node:assert/strict');
const loadBrowserSource = require('./helpers/load-browser-source');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}
const plain = value => JSON.parse(JSON.stringify(value));
function watermarks(version = 1) {
  const values = { ads: 20, receipts: 20, customers: 20, pages: 20 };
  if (version !== undefined) Object.defineProperty(values, 'dataCompatibilityVersion', { value: version });
  return values;
}
function fixture() {
  const f = loadBrowserSource();
  const rows = { ads: [], receipts: [], customers: [], pages: [] };
  const calls = [];
  let versionChecks = 0;
  let payload = watermarks();
  f.state.currentUser = { id: 'admin', role: 'Admin', permissions: {} };
  f.state.customers = []; f.state.receipts = []; f.state.pages = []; f.state.ads = [];
  f.sandbox.isServerModeEnabled = () => true;
  f.sandbox.getAuthorizedServerSyncCollections = () => Object.keys(rows);
  f.sandbox.apiGetSyncWatermarks = async () => { versionChecks += 1; return payload; };
  f.sandbox.apiLoadCollectionSince = async (collection, since) => {
    calls.push([collection, since]);
    return rows[collection];
  };
  f.run('RenderQueue.schedule = () => {};');
  return { ...f, rows, calls, checks: () => versionChecks,
    setVersion(value) { payload = value; },
    check: () => f.sandbox.refreshServerDataCompatibility(),
    retry() { f.run('_serverLiveSync.lastCompatibilityCheckAt = 0'); },
    version: () => f.run('_serverLiveSync.dataCompatibilityVersion') };
}

async function main() {
  await test('one shared migration updates legacy shapes without inventing financial or creator history', () => {
    const f = fixture();
    f.state.receipts = [{ id: 'old_receipt', status: 'paid', amount: '12.34', amountLYD: '61.7', exchangeRate: '5', finalReceiptNo: 'R1' }];
    f.state.ads = [{ id: 'old_ad', customer: 'c1', page: 'p1', amountUSD: 12.34, receiptAllocations: [], dueAllocations: [] }];
    f.state.customers = [{ id: 'c1', name: 'Customer', phone: '0910000000' }];
    f.state.pages = [{ id: 'p1', name: 'Page', customerId: 'c1' }];
    assert.equal(f.sandbox.migrateOldDataFormats(), true);
    assert.equal(f.state.receipts[0].amountUSD, 12.34);
    assert.equal(f.state.receipts[0].amountLocal, 61.7);
    assert.equal(f.state.receipts[0].isPaid, true);
    assert.equal(f.state.receipts[0].serialNumber, 'R1');
    assert.equal(f.state.ads[0].customerId, 'c1');
    assert.equal(f.state.ads[0].pageId, 'p1');
    assert.deepEqual(plain(f.state.pages[0].customerIds), ['c1']);
    assert.deepEqual(plain(f.state.customers[0].phones), ['0910000000']);
    assert.equal(f.state.ads[0].createdBy, undefined);
    assert.equal(f.state.receipts[0].customerOutstandingUSD, undefined);
    assert.equal(f.sandbox.migrateOldDataFormats(), false);
  });

  await test('explicit modern zeroes, false flags, and existing allocations remain authoritative', () => {
    const f = fixture();
    const receipts = [{ id: 'r1', isPaid: false, status: 'paid', amountUSD: 0, amount: 90, amountLocal: 0, amountLYD: 450, exchangeRate: 9.7, customerOutstandingUSD: 0 }];
    f.sandbox.normalizeLegacyCollectionRecords('receipts', receipts);
    assert.equal(receipts[0].isPaid, false);
    assert.equal(receipts[0].amountUSD, 0);
    assert.equal(receipts[0].amountLocal, 0);
    assert.equal(receipts[0].exchangeRate, 9.7);
    assert.equal(receipts[0].customerOutstandingUSD, 0);
    const ads = [{ id: 'a1', receiptAllocations: [], dueAllocations: [], fundingReceiptId: 'r1', amountUSD: 90 }];
    f.sandbox.normalizeLegacyCollectionRecords('ads', ads);
    assert.deepEqual(ads[0].receiptAllocations, []);
    assert.deepEqual(ads[0].dueAllocations, []);
  });

  await test('incoming-row migration neither scans unrelated arrays nor writes to storage', () => {
    const f = fixture();
    f.state.receipts = [{ id: 'unrelated', amount: '20' }];
    let saves = 0;
    f.sandbox.saveState = () => { saves += 1; };
    const rows = [{ id: 'p1', customerId: 'c1', name: 'Page' }];
    assert.equal(f.sandbox.normalizeLegacyCollectionRecords('pages', rows), true);
    assert.deepEqual(plain(rows[0].customerIds), ['c1']);
    assert.equal(f.state.receipts[0].amountUSD, undefined);
    assert.equal(saves, 0);
  });

  await test('adding a missing legacy due array is reported as a migration', () => {
    const f = fixture();
    assert.equal(f.sandbox.normalizeLegacyCollectionRecords('ads', [{ id: 'a1', receiptAllocations: [] }]), true);
  });

  for (const rate of [undefined, null, '', ' ', 'unknown', '9.7bad', 0, -5, Infinity, true, {}]) {
    await test(`unknown legacy rate ${String(rate)} never becomes today's rate or invented USD debt`, () => {
      const f = fixture();
      f.state.defaultExchangeRate = 99;
      const receipt = { id: 'r1', exchangeRate: rate };
      const ad = { id: 'a1', paymentStatus: 'not_paid', collectionMethod: 'driver',
        linkedDeliveryReceiptId: 'r1', dueAmountToUseLYD: 97, exchangeRate: rate };
      f.sandbox.normalizeLegacyCollectionRecords('receipts', [receipt]);
      f.sandbox.normalizeLegacyCollectionRecords('ads', [ad]);
      assert.equal(receipt.exchangeRate, rate);
      assert.deepEqual(plain(ad.dueAllocations), []);
      assert.equal(ad.dueAmountToUseLYD, 97);
    });
  }

  await test('known historical rates still convert explicit LYD mirrors at the saved rate', () => {
    const f = fixture();
    f.state.defaultExchangeRate = 99;
    const ad = { id: 'a1', paymentStatus: 'not_paid', linkedDeliveryReceiptId: 'r1', dueAmountToUseLYD: 97, exchangeRate: '9.7' };
    f.sandbox.normalizeLegacyCollectionRecords('ads', [ad]);
    assert.deepEqual(plain(ad.dueAllocations), [{ receiptId: 'r1', amountUSD: 10 }]);
  });

  for (const [legacy, expected] of [['Delivered', 'Delivered'], ['delivered', 'Delivered'], ['needs_delivery', 'Needs Delivery'],
    ['IN-PROGRESS', 'In Progress'], ['cancelled', 'Canceled'], ['legacy pending review', 'legacy pending review'], ['constructor', 'constructor']]) {
    await test(`delivery status '${legacy}' keeps its meaning for old receipts and ads`, () => {
      const f = fixture();
      for (const collection of ['receipts', 'ads']) {
        const record = { id: 'r1', deliveryStatus: legacy };
        f.sandbox.normalizeLegacyCollectionRecords(collection, [record]);
        assert.equal(record.deliveryStatus, expected);
      }
    });
  }

  await test('live deltas normalize old rows before any render or timer', () => {
    const f = fixture();
    assert.equal(f.sandbox.applyServerDelta('pages', [{ id: 'old_page', customerId: 'c1', _lastModified: 10 }]), true);
    assert.deepEqual(plain(f.state.pages[0].customerIds), ['c1']);
    assert.equal(f.state.pages[0].name, 'Unnamed Page');
    const current = f.state.pages[0];
    assert.equal(f.sandbox.applyServerDelta('pages', [{ id: 'old_page', customerId: 'c1', _lastModified: 10 }]), false);
    assert.equal(f.state.pages[0], current);
  });

  for (const mode of ['local', 'cache']) {
    await test(`${mode} full migration remains compatible with existing saved rows`, () => {
      const f = fixture();
      f.sandbox.isServerModeEnabled = () => mode === 'cache';
      f.state.pages = [{ id: 'p1', customerId: 'c1' }];
      f.state.receipts = [{ id: 'r1', amount: 10, status: 'unpaid' }];
      f.sandbox.migrateOldDataFormats();
      assert.deepEqual(plain(f.state.pages[0].customerIds), ['c1']);
      assert.equal(f.state.receipts[0].amountUSD, 10);
      assert.equal(f.state.receipts[0].isPaid, false);
      assert.equal(f.calls.length, 0);
    });
  }

  for (const invalid of [0, -1, '1', 1.5, {}, Infinity]) {
    await test(`malformed compatibility version ${JSON.stringify(invalid)} is rejected`, async () => {
      const f = loadBrowserSource();
      f.sandbox.apiJson = async () => ({ watermarks: { receipts: 10 }, dataCompatibilityVersion: invalid });
      await assert.rejects(f.sandbox.apiGetSyncWatermarks(), error => error.code === 'INVALID_SYNC_WATERMARKS');
    });
  }

  await test('version metadata cannot be mistaken for a collection timestamp', async () => {
    const f = loadBrowserSource();
    f.sandbox.apiJson = async () => ({ watermarks: { receipts: 10 }, dataCompatibilityVersion: 1 });
    const result = await f.sandbox.apiGetSyncWatermarks();
    assert.equal(result.dataCompatibilityVersion, 1);
    assert.deepEqual(plain(result), { receipts: 10 });
    assert.deepEqual(Object.values(result), [10]);
  });

  await test('older server without a compatibility version does not force a full refresh', async () => {
    const f = fixture();
    f.setVersion({ receipts: 20 });
    assert.equal(await f.check(), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.version(), null);
  });

  await test('a deployment refreshes unchanged old receipt projections exactly once', async () => {
    const f = fixture();
    f.state.receipts = [{ id: 'r1', _lastModified: 10, customerOutstandingUSD: 70, isPaid: false }];
    f.rows.receipts = [{ id: 'r1', _lastModified: 10, customerOutstandingUSD: 30, isPaid: false }];
    const result = await f.check();
    assert.equal(result.refreshed, true);
    assert.equal(f.state.receipts[0].customerOutstandingUSD, 30);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.calls.map(row => row[1]), [0, 0, 0, 0]);
    f.retry();
    assert.equal(await f.check(), null);
    assert.equal(f.calls.length, 4);
  });

  await test('version checks are bounded to once per minute', async () => {
    const f = fixture();
    await f.check();
    await f.check();
    await f.check();
    assert.equal(f.checks(), 1);
    assert.equal(f.calls.length, 4);
  });

  await test('a later compatibility version initiates one further refresh', async () => {
    const f = fixture();
    await f.check();
    f.setVersion(watermarks(2)); f.retry();
    await f.check();
    assert.equal(f.version(), 2);
    assert.equal(f.calls.length, 8);
  });

  await test('a failed collection leaves every current row and version untouched, then retries safely', async () => {
    const f = fixture();
    f.state.pages = [{ id: 'p1', name: 'Local', _lastModified: 10 }];
    f.rows.pages = [{ id: 'p1', name: 'Changed projection', _lastModified: 10 }];
    const loader = f.sandbox.apiLoadCollectionSince;
    f.sandbox.apiLoadCollectionSince = async (name, since) => {
      if (name === 'receipts') throw new Error('Synthetic temporary failure');
      return loader(name, since);
    };
    assert.equal((await f.check()).ok, false);
    assert.equal(f.state.pages[0].name, 'Local');
    assert.equal(f.version(), null);
    f.sandbox.apiLoadCollectionSince = loader; f.retry();
    assert.equal((await f.check()).ok, true);
    assert.equal(f.state.pages[0].name, 'Changed projection');
    assert.equal(f.version(), 1);
  });

  await test('version refresh preserves newer saves and absent unsynced local records', async () => {
    const f = fixture();
    f.state.pages = [{ id: 'p1', name: 'Newer save', _lastModified: 30 }, { id: 'offline', name: 'Unsynced' }];
    f.rows.pages = [{ id: 'p1', name: 'Older response', _lastModified: 10 }];
    await f.check();
    assert.equal(f.state.pages.find(row => row.id === 'p1').name, 'Newer save');
    assert.equal(f.state.pages.find(row => row.id === 'offline').name, 'Unsynced');
    assert.equal(f.run('_serverLiveSync.collectionCursors.pages'), 20);
  });

  await test('an equal-version tombstone is never resurrected by a projection refresh', async () => {
    const f = fixture();
    f.state.pages = [{ id: 'p1', name: 'Deleted', _lastModified: 10, _deleted: true }];
    f.rows.pages = [{ id: 'p1', name: 'Active', _lastModified: 10 }];
    await f.check();
    assert.equal(f.state.pages[0]._deleted, true);
  });

  for (const field of ['modal', 'pending-ad', 'pending-receipt', 'dialog', 'local-mode']) {
    await test(`${field} defers deployment refresh without touching draft data`, async () => {
      const f = fixture();
      if (field === 'modal') f.state.activeModal = 'receipt';
      if (field === 'pending-ad') f.run("_pendingAdMutationAttempts.set('a1', { operationId: 'op1', promise: {} })");
      if (field === 'pending-receipt') f.run('_savingReceiptInFlight = true');
      if (field === 'dialog') f.sandbox.document.querySelector = () => ({});
      if (field === 'local-mode') f.sandbox.isServerModeEnabled = () => false;
      assert.equal(await f.check(), null);
      assert.equal(f.checks(), 0);
      assert.equal(f.calls.length, 0);
    });
  }

  for (const interruption of ['session-change', 'poller-restart', 'form-opened', 'access-change']) {
    await test(`${interruption} during full-history fetch discards responses without acknowledgement`, async () => {
      const f = fixture();
      let altered = false;
      f.state.pages = [{ id: 'p1', name: 'Existing', _lastModified: 10 }];
      const load = f.sandbox.apiLoadCollectionSince;
      f.sandbox.apiLoadCollectionSince = async (name, since) => {
        if (!altered) {
          altered = true;
          if (interruption === 'session-change') f.sandbox.advanceServerSessionEpoch();
          if (interruption === 'poller-restart') f.run('_serverLiveSync.pollerEpoch += 1');
          if (interruption === 'form-opened') f.state.activeModal = 'ad';
          if (interruption === 'access-change') f.state.currentUser.role = 'Employee';
        }
        return load(name, since);
      };
      await f.check();
      assert.equal(f.state.pages[0].name, 'Existing');
      assert.equal(f.version(), null);
    });
  }

  await test('session reset discards compatibility acknowledgement and timer', async () => {
    const f = fixture();
    await f.check();
    f.sandbox.advanceServerSessionEpoch();
    assert.equal(f.version(), null);
    assert.equal(f.run('_serverLiveSync.lastCompatibilityCheckAt'), 0);
  });

  for (const failed of [false, true]) {
    await test(`full server load normalizes old records and ${failed ? 'does not acknowledge a partial result' : 'acknowledges a complete result'}`, async () => {
      const f = fixture();
      f.sandbox.apiLoadCollectionAll = async name => {
        if (name === 'receipts' && failed) throw new Error('Synthetic failed receipt fetch');
        return name === 'pages' ? [{ id: 'p1', customerId: 'c1', name: 'Page' }] : [];
      };
      f.sandbox.apiListUsersForUi = async () => [f.state.currentUser];
      f.sandbox.queueNativeReminderSync = () => {};
      const result = await f.sandbox.serverLoadAllData();
      assert.equal(result.failed.length, failed ? 1 : 0);
      assert.deepEqual(plain(f.state.pages[0].customerIds), ['c1']);
      assert.equal(f.version(), failed ? null : 1);
    });
  }

  console.log(`\n${passed} legacy-data compatibility regressions passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
