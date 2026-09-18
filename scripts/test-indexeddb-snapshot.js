// Production collection storage, real browser IndexedDB, no application server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('@playwright/test');
const source = fs.readFileSync(path.join(__dirname, '../src/03-storage-idb.js'), 'utf8');
let passed = 0, failed = 0;

async function main() {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      async function test(label, run) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated storage test</title>' }));
          await page.goto('http://albayan-storage.test/');
          await page.addScriptTag({ content: 'const DataIntegrity = { calculateChecksum: data => JSON.stringify(data) };' + source });
          await page.evaluate(async () => {
            await initIndexedDB();
            if (!db) throw new Error('Real IndexedDB did not initialize');
            STORAGE_CONFIG.CHUNK_SIZE = 2;
            window.rows = (generation, length = 6) => Array.from({ length }, (_, id) => ({ id: String(id), generation, amount: generation === 'old' ? 10 : 20 }));
            const nativeTransaction = db.transaction.bind(db);
            window.transactions = 0;
            db.transaction = (...args) => { window.transactions += 1; return nativeTransaction(...args); };
            // Enqueue a real competing transaction at a deterministic request
            // boundary. It is blocked by an active snapshot, but not by the
            // previous implementation's separate transaction for every chunk.
            window.competingWriteAfter = (key, puts, deletes = [], callback = () => {}) => {
              const originalGet = IDBObjectStore.prototype.get;
              let armed = true;
              window.writer = Promise.resolve();
              IDBObjectStore.prototype.get = function (requested) {
                const request = originalGet.call(this, requested);
                if (armed && requested === key) {
                  armed = false;
                  request.addEventListener('success', () => {
                    callback();
                    window.writer = new Promise((resolve, reject) => {
                      const tx = nativeTransaction([DATA_STORE_NAME], 'readwrite');
                      tx.oncomplete = resolve;
                      tx.onabort = () => reject(tx.error || new Error('Fixture writer aborted'));
                      const store = tx.objectStore(DATA_STORE_NAME);
                      puts.forEach(value => store.put(value));
                      deletes.forEach(value => store.delete(value));
                    });
                  }, { once: true });
                }
                return request;
              };
            };
            window.chunked = data => {
              const count = Math.ceil(data.length / STORAGE_CONFIG.CHUNK_SIZE);
              return [
                { key: getCollectionMetaKey('ads'), type: 'collection_meta', chunkCount: count, recordCount: data.length, checksum: DataIntegrity.calculateChecksum(data) },
                ...Array.from({ length: count }, (_, index) => ({ key: getCollectionChunkKey('ads', index), data: data.slice(index * 2, index * 2 + 2) }))
              ];
            };
          });
          await run(page);
          passed += 1;
          console.log(`PASS ${name}: ${label}`);
        } catch (error) {
          failed += 1;
          console.error(`FAIL ${name}: ${label}: ${error.message}`);
        } finally { await context.close(); }
      }

      await test('chunked collection reads use one transaction and keep order', async page => {
        const result = await page.evaluate(async () => {
          const data = rows('old', 202);
          await saveCollectionToIndexedDB('ads', data);
          transactions = 0;
          const originalGet = IDBObjectStore.prototype.get;
          let outstanding = 0, maxOutstanding = 0;
          IDBObjectStore.prototype.get = function (key) {
            const request = originalGet.call(this, key);
            maxOutstanding = Math.max(maxOutstanding, ++outstanding);
            request.addEventListener('success', () => { outstanding--; }, { once: true });
            return request;
          };
          const loaded = await loadCollectionFromIndexedDB('ads');
          return { equal: JSON.stringify(loaded) === JSON.stringify(data), transactions, maxOutstanding };
        });
        assert.ok(result.equal);
        assert.equal(result.transactions, 1, '101 chunks must not create 102 separate transactions');
        assert.ok(result.maxOutstanding <= 32, 'requests must be queued in bounded batches');
      });
      await test('concurrent atomic save cannot mix generations between chunks', async page => {
        const result = await page.evaluate(async () => {
          const oldRows = rows('old'), newRows = rows('new');
          await saveCollectionToIndexedDB('ads', oldRows);
          competingWriteAfter(getCollectionChunkKey('ads', 0), chunked(newRows));
          const loaded = await loadCollectionFromIndexedDB('ads');
          await writer;
          const after = await loadCollectionFromIndexedDB('ads');
          return { loaded, oldRows, after, newRows, corrupt: isCollectionCorrupted('ads') };
        });
        assert.deepEqual(result.loaded, result.oldRows);
        assert.deepEqual(result.after, result.newRows);
        assert.equal(result.corrupt, false);
      });
      await test('concurrent conversion from chunks to a single record is consistent', async page => {
        const result = await page.evaluate(async () => {
          const oldRows = rows('old');
          await saveCollectionToIndexedDB('ads', oldRows);
          const newRows = rows('new', 1);
          competingWriteAfter(getCollectionMetaKey('ads'), [{ key: 'ads', type: 'collection', data: newRows }],
            [getCollectionMetaKey('ads'), ...[0, 1, 2].map(i => getCollectionChunkKey('ads', i))]);
          const loaded = await loadCollectionFromIndexedDB('ads');
          await writer;
          return { loaded, oldRows, after: await loadCollectionFromIndexedDB('ads'), newRows };
        });
        assert.deepEqual(result.loaded, result.oldRows);
        assert.deepEqual(result.after, result.newRows);
      });
      await test('concurrent conversion from a single record to chunks is consistent', async page => {
        const result = await page.evaluate(async () => {
          const oldRows = rows('old', 1);
          await saveCollectionToIndexedDB('ads', oldRows);
          const newRows = rows('new');
          competingWriteAfter(getCollectionMetaKey('ads'), chunked(newRows), ['ads']);
          const loaded = await loadCollectionFromIndexedDB('ads');
          await writer;
          return { loaded, oldRows, after: await loadCollectionFromIndexedDB('ads'), newRows };
        });
        assert.deepEqual(result.loaded, result.oldRows);
        assert.deepEqual(result.after, result.newRows);
      });
      await test('missing chunks still block unsafe re-saving of incomplete data', async page => {
        const result = await page.evaluate(async () => {
          await saveCollectionToIndexedDB('ads', rows('old'));
          await idbAtomicWrite([], [getCollectionChunkKey('ads', 1)]);
          try { await loadCollectionFromIndexedDB('ads'); return { code: 'NOT_REJECTED' }; }
          catch (error) { return { code: error.code, partial: error.partialData.length, corrupt: isCollectionCorrupted('ads') }; }
        });
        assert.deepEqual(result, { code: 'IDB_COLLECTION_CORRUPT', partial: 4, corrupt: true });
      });
      await test('record-count mismatch remains a corruption error', async page => {
        const result = await page.evaluate(async () => {
          await saveCollectionToIndexedDB('ads', rows('old'));
          const key = getCollectionMetaKey('ads');
          const meta = await idbGet(DATA_STORE_NAME, key);
          await idbAtomicWrite([{ ...meta, recordCount: 99 }], []);
          try { await loadCollectionFromIndexedDB('ads'); return 'NOT_REJECTED'; }
          catch (error) { return error.code; }
        });
        assert.equal(result, 'IDB_COLLECTION_CORRUPT');
      });
      await test('legacy single record, missing and empty collections still load', async page => {
        const result = await page.evaluate(async () => {
          await idbAtomicWrite([{ key: 'legacy', data: [{ id: 'old-record', amount: 9.7 }] }], []);
          await saveCollectionToIndexedDB('empty', []);
          return { legacy: await loadCollectionFromIndexedDB('legacy'), empty: await loadCollectionFromIndexedDB('empty'), missing: await loadCollectionFromIndexedDB('missing') };
        });
        assert.deepEqual(result, { legacy: [{ id: 'old-record', amount: 9.7 }], empty: [], missing: null });
      });
      await test('complete legacy data with checksum mismatch stays readable', async page => {
        const result = await page.evaluate(async () => {
          await saveCollectionToIndexedDB('ads', rows('old'));
          const meta = await idbGet(DATA_STORE_NAME, getCollectionMetaKey('ads'));
          await idbAtomicWrite([{ ...meta, checksum: 'legacy-checksum' }], []);
          const loaded = await loadCollectionFromIndexedDB('ads');
          return { count: loaded.length, corrupt: isCollectionCorrupted('ads') };
        });
        assert.deepEqual(result, { count: 6, corrupt: false });
      });
      await test('old-account corruption does not poison the newly active account', async page => {
        const result = await page.evaluate(async () => {
          setCollectionStorageScope('server:A');
          await saveCollectionToIndexedDB('ads', rows('old'));
          await idbAtomicWrite([], [getCollectionChunkKey('ads', 1)]);
          competingWriteAfter(getCollectionMetaKey('ads'), [], [], () => setCollectionStorageScope('server:B'));
          let code;
          try { await loadCollectionFromIndexedDB('ads'); } catch (error) { code = error.code; }
          await writer;
          return { code, corrupt: isCollectionCorrupted('ads'), scope: getCollectionStorageScope() };
        });
        assert.deepEqual(result, { code: 'IDB_COLLECTION_CORRUPT', corrupt: false, scope: 'server:B' });
      });
      await test('aborted reads never return partially loaded records as success', async page => {
        const result = await page.evaluate(async () => {
          await saveCollectionToIndexedDB('ads', rows('old'));
          const originalGet = IDBObjectStore.prototype.get;
          IDBObjectStore.prototype.get = function (key) {
            const request = originalGet.call(this, key);
            if (key === getCollectionChunkKey('ads', 0)) {
              request.addEventListener('success', () => request.transaction.abort(), { once: true });
            }
            return request;
          };
          return { loaded: await loadCollectionFromIndexedDB('ads'), corrupt: isCollectionCorrupted('ads') };
        });
        assert.deepEqual(result, { loaded: null, corrupt: false });
      });
      await test('invalid chunk metadata fails safely before queuing chunk reads', async page => {
        const result = await page.evaluate(async () => {
          const results = [];
          for (const chunkCount of [-1, 1.5, Number.MAX_VALUE, Infinity, '3', null]) {
            clearCollectionCorruption('ads');
            await idbAtomicWrite([{ key: getCollectionMetaKey('ads'), type: 'collection_meta', chunkCount }], []);
            try { await loadCollectionFromIndexedDB('ads'); results.push('NOT_REJECTED'); }
            catch (error) { results.push(error.code + ':' + isCollectionCorrupted('ads')); }
          }
          return results;
        });
        assert.deepEqual(result, Array(6).fill('IDB_COLLECTION_CORRUPT:true'));
      });
    } finally { await browser.close(); }
  }
  console.log(`IndexedDB snapshots: ${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
