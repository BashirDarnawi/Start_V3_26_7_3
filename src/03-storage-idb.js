// ==========================================
// LARGE DATA STORAGE - IndexedDB for big datasets
// ==========================================

const DB_NAME = 'AlbayanDB';
/**
 * IndexedDB Schema Version History
 * ---------------------------------
 * v1: Initial schema (auditLogs, appData stores)
 * v2: Added backups store for auto-backup feature
 * 
 * IMPORTANT: Increment DB_VERSION when:
 * - Adding new object stores
 * - Adding new indexes
 * - Changing key paths
 * 
 * The onupgradeneeded handler MUST handle upgrading from any previous version.
 */
const DB_VERSION = 2;
const LOG_STORE_NAME = 'auditLogs';
const DATA_STORE_NAME = 'appData';
const BACKUP_STORE_NAME = 'backups';

// Storage quotas and limits
const STORAGE_CONFIG = {
  MAX_RECORDS_PER_COLLECTION: 100000, // 100k records per type
  MAX_LOCALSTORAGE_MB: 4,
  BACKUP_RETENTION_DAYS: 30,
  AUTO_BACKUP_INTERVAL: 24 * 60 * 60 * 1000, // Daily
  CHUNK_SIZE: 1000 // Records per chunk for large operations
};

// BEST PRACTICE: Extract magic numbers to named constants for better maintainability
const TIME_CONSTANTS = {
  MILLISECONDS_PER_SECOND: 1000,
  SECONDS_PER_MINUTE: 60,
  MINUTES_PER_HOUR: 60,
  HOURS_PER_DAY: 24,
  MILLISECONDS_PER_MINUTE: 60 * 1000,
  MILLISECONDS_PER_HOUR: 60 * 60 * 1000,
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
  SESSION_DURATION_HOURS: 8,
  RATE_LIMIT_WINDOW_MINUTES: 15,
  API_TIMEOUT_MS: 15000,
  API_TIMEOUT_LONG_MS: 20000,
  WEBAUTHN_TIMEOUT_MS: 60000
};

const LIMIT_CONSTANTS = {
  MAX_SECURITY_LOGS: 1000,
  MAX_RATE_LIMIT_ATTEMPTS: 5,
  MAX_PAYMENT_METHODS: 50, // Reasonable limit
  MAX_PHONE_NUMBERS: 10, // Per customer
  MAX_PROFILE_LINKS: 10 // Per customer
};

let db = null;

// Business-data caches are isolated by workspace + authenticated user. Local
// mode keeps the historical unscoped keys so existing single-device data is
// preserved. Server mode activates a different scope only AFTER /api/auth/me
// or login has identified the user, so pre-auth startup can never render the
// previous user's cached customers, receipts or wallet rows.
let _collectionStorageScope = 'local';

function _hashStorageScope(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function setCollectionStorageScope(scope) {
  const next = String(scope || 'server:anonymous');
  if (next === _collectionStorageScope) return next;
  _collectionStorageScope = next;
  _corruptedCollections.clear();
  // A debounced write created for user A must not run after user B's scope is
  // activated. In-flight IDB writes capture their keys below and remain safe.
  try {
    if (typeof resetDirtyCollectionQueueForScopeChange === 'function') {
      resetDirtyCollectionQueueForScopeChange();
    }
  } catch (_) {}
  return next;
}

function activateLocalCollectionStorage() {
  return setCollectionStorageScope('local');
}

function activateAnonymousServerCollectionStorage() {
  return setCollectionStorageScope('server:anonymous');
}

function activateServerCollectionStorage(user) {
  const userId = String(user?.id || '').trim();
  if (!Security.isValidRecordId(userId)) throw new Error('Cannot activate cache: invalid authenticated user id');
  let serverIdentity = '';
  try {
    serverIdentity = (typeof getServerBaseUrl === 'function' && getServerBaseUrl()) || window.location?.origin || 'server';
  } catch (_) {
    serverIdentity = 'server';
  }
  return setCollectionStorageScope(`server:${_hashStorageScope(String(serverIdentity).toLowerCase())}:${userId}`);
}

function getCollectionStorageScope() {
  return _collectionStorageScope;
}

function _scopedCollectionStorageName(collectionName, capturedScope = _collectionStorageScope) {
  const name = String(collectionName || '');
  return capturedScope === 'local' ? name : `${capturedScope}:${name}`;
}

/**
 * Initialize IndexedDB for large data storage and caching.
 * Creates necessary object stores and handles version upgrades.
 * Falls back gracefully if IndexedDB is not supported.
 *
 * @param {Function} [onLateOpen] - Adoption callback for an open that succeeds
 *   AFTER this promise already resolved null (watchdog / onblocked). Passing it
 *   means "adopt the late connection AND recover": the callback must re-persist
 *   the authoritative in-memory state (the onclose reopen path does this via
 *   markAllCollectionsDirty() + saveState()). Without it a late connection is
 *   closed and `db` stays null — required at startup, where the collections
 *   were already loaded WITHOUT IndexedDB and flushing them would overwrite
 *   the intact stored copies.
 * @returns {Promise<IDBDatabase|null>} Promise resolving to database instance or null if unsupported
 */
function initIndexedDB(onLateOpen) {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported, falling back to localStorage');
      resolve(null);
      return;
    }

    // RESILIENCE: this promise must ALWAYS settle and can NEVER reject —
    // init() awaits it before the first render, so a hung or failed open
    // would strand the user on the loading screen forever. Known hangs:
    // Safari 14.1–15.x can drop the open request without firing any event,
    // and a DB_VERSION bump in another tab leaves this request in the
    // (previously unhandled) "blocked" state.
    let settled = false;
    let timer = null;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    // Watchdog: if no event ever arrives, continue without IndexedDB.
    // This outcome is INCONCLUSIVE — the store may hold an intact workspace
    // that simply could not be read this session — so flag it for init() /
    // render(), which must not present the workspace as a fresh install.
    // A connection that arrives AFTER this fires is NOT silently adopted
    // (that used to flip saveState() into drop-collections mode and let the
    // next flush overwrite the intact IndexedDB data): see the case split in
    // request.onsuccess below.
    timer = setTimeout(() => {
      console.warn('IndexedDB open timed out, continuing without it');
      window.__albayanIdbOpenInconclusive = true;
      done(null);
    }, 3000);

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      // Chrome throws a synchronous SecurityError when site data is blocked.
      console.warn('IndexedDB unavailable:', e);
      done(null);
      return;
    }

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      done(null);
    };

    // Another tab still holds a connection at an older schema version.
    // Fall back to localStorage mode instead of hanging forever. Like the
    // watchdog, this is inconclusive: the stored data itself is intact.
    request.onblocked = () => {
      console.warn('IndexedDB open blocked by another tab');
      window.__albayanIdbOpenInconclusive = true;
      done(null);
    };

    request.onsuccess = (event) => {
      const database = event.target.result;
      // LATE OPEN (the watchdog or onblocked already resolved this promise
      // with null): adopting the connection is only safe when the caller can
      // recover, because `db` truthiness makes saveState() drop the business
      // collections from the localStorage snapshot and re-enables the dirty
      // flush — with in-memory arrays that were loaded WITHOUT IndexedDB.
      // At startup (no onLateOpen) close the connection and stay in the
      // db === null snapshot mode for the whole session; the intact
      // IndexedDB dataset survives untouched until the next reload. The
      // onclose reopen path passes a recovery callback instead: there the
      // in-memory state IS authoritative, so adopt and re-persist it.
      if (settled && typeof onLateOpen !== 'function') {
        try { database.close(); } catch (_) {}
        return;
      }
      db = database;
      window.__albayanIdbOpenInconclusive = false;
      // Let a future DB_VERSION bump in another tab proceed instead of being
      // blocked forever. Closing mid-session degrades gracefully: every idb*
      // helper guards `if (!db)` per call.
      database.onversionchange = () => {
        try { database.close(); } catch (_) {}
        if (db === database) db = null;
      };
      // iOS Safari force-closes the connection when the tab is backgrounded
      // or the device is locked ("Connection to Indexed Database server
      // lost"). Null the handle immediately — saveState() then keeps the
      // business collections inside the localStorage snapshot — and try to
      // reopen; a successful reopen re-persists everything to IndexedDB via
      // the normal dirty-flush machinery.
      database.onclose = () => {
        if (db !== database) return; // a newer connection already took over
        db = null;
        // Recovery runs whether the reopen settles in time (then branch) or
        // arrives late after its own watchdog (onLateOpen inside onsuccess):
        // edits made during the db === null window live only in the
        // localStorage snapshot, so everything must be marked dirty and
        // re-persisted the moment a connection is adopted — otherwise the
        // next saveState() would strip the collections from the snapshot
        // while IndexedDB still holds the pre-close data.
        const recover = () => {
          if (typeof markAllCollectionsDirty === 'function') {
            markAllCollectionsDirty();
            saveState();
          }
        };
        initIndexedDB(recover).then((reopened) => {
          if (reopened) recover();
        }).catch(() => {});
      };
      if (settled) {
        // Late adoption (onclose reopen path only): re-persist before anyone
        // can observe the truthy `db` and skip collections in saveState().
        try { onLateOpen(); } catch (_) {}
      }
      done(database);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      
      // Create audit logs store with indexes for efficient querying
      if (!database.objectStoreNames.contains(LOG_STORE_NAME)) {
        const logStore = database.createObjectStore(LOG_STORE_NAME, { keyPath: 'id' });
        logStore.createIndex('date', 'date', { unique: false });
        logStore.createIndex('userId', 'userId', { unique: false });
        logStore.createIndex('action', 'action', { unique: false });
        logStore.createIndex('category', 'category', { unique: false });
        logStore.createIndex('severity', 'severity', { unique: false });
        logStore.createIndex('resourceType', 'resourceType', { unique: false });
      }
      
      // Create main data store for large datasets
      if (!database.objectStoreNames.contains(DATA_STORE_NAME)) {
        const dataStore = database.createObjectStore(DATA_STORE_NAME, { keyPath: 'key' });
        dataStore.createIndex('type', 'type', { unique: false });
        dataStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      
      // Create backup store
      if (!database.objectStoreNames.contains(BACKUP_STORE_NAME)) {
        const backupStore = database.createObjectStore(BACKUP_STORE_NAME, { keyPath: 'id' });
        backupStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
  });
}

// ==========================================
// LARGE DATA OPERATIONS - Store big datasets in IndexedDB
// ==========================================

// BEST PRACTICE: Transaction queue to prevent race conditions in IndexedDB
let idbTransactionQueue = [];
let idbTransactionInProgress = false;

async function processIdbQueue() {
  if (idbTransactionInProgress || idbTransactionQueue.length === 0) return;
  
  idbTransactionInProgress = true;
  while (idbTransactionQueue.length > 0) {
    const task = idbTransactionQueue.shift();
    try {
      await task();
    } catch (error) {
      console.error('IndexedDB queue task error:', error);
    }
  }
  idbTransactionInProgress = false;
}

/**
 * Retrieve a value from IndexedDB by key.
 *
 * @param {string} storeName - Name of the object store
 * @param {string} key - Key to retrieve
 * @returns {Promise<any>} Promise resolving to the stored value or null if not found
 */
function idbGet(storeName, key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Store a value in IndexedDB.
 * BEST PRACTICE: Queued to prevent race conditions from concurrent writes.
 *
 * @param {string} storeName - Name of the object store
 * @param {any} value - Value to store (must have an 'id' property)
 * @returns {Promise<void>} Promise resolving when storage is complete
 */
function idbPut(storeName, value) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const task = () => {
      return new Promise((innerResolve, innerReject) => {
        try {
          const tx = db.transaction([storeName], 'readwrite');
          const store = tx.objectStore(storeName);
          const req = store.put(value);
          req.onsuccess = () => innerResolve(true);
          req.onerror = () => innerReject(req.error);
        } catch (e) {
          innerReject(e);
        }
      });
    };
    
    // BEST PRACTICE: Queue write operations to prevent race conditions
    idbTransactionQueue.push(() => task().then(resolve).catch(reject));
    processIdbQueue();
  });
}

function idbDelete(storeName, key) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Perform several puts and deletes in ONE IndexedDB transaction, atomically.
 * Either every operation commits or none does — so an interrupted collection
 * save (tab close / crash / quota) can never leave new chunks mixed with old
 * ones under a stale meta record (which silently corrupts the collection).
 * Enqueued on the same write queue to preserve serialization. Do NOT await
 * anything between the put/delete calls — an intervening await would let the
 * transaction auto-commit early and defeat atomicity.
 *
 * @param {Array<object>} puts - records to store (each has a `key`)
 * @param {Array<string>} deleteKeys - keys to delete
 * @returns {Promise<boolean>}
 */
function idbAtomicWrite(puts, deleteKeys) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const task = () => new Promise((innerResolve, innerReject) => {
      try {
        const tx = db.transaction([DATA_STORE_NAME], 'readwrite');
        const store = tx.objectStore(DATA_STORE_NAME);
        tx.oncomplete = () => innerResolve(true);
        tx.onerror = () => innerReject(tx.error);
        tx.onabort = () => innerReject(tx.error || new Error('IndexedDB transaction aborted'));
        for (const v of (puts || [])) store.put(v);
        for (const k of (deleteKeys || [])) store.delete(k);
      } catch (e) {
        innerReject(e);
      }
    });
    idbTransactionQueue.push(() => task().then(resolve).catch(reject));
    processIdbQueue();
  });
}

function idbClear(storeName) {
  if (!db) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function getCollectionMetaKey(collectionName, capturedScope = _collectionStorageScope) {
  return `collection:${_scopedCollectionStorageName(collectionName, capturedScope)}:meta`;
}

function getCollectionChunkKey(collectionName, index, capturedScope = _collectionStorageScope) {
  return `collection:${_scopedCollectionStorageName(collectionName, capturedScope)}:chunk:${index}`;
}

/**
 * Save a large collection to IndexedDB by chunking it into smaller pieces.
 * Uses metadata and chunked storage for efficient retrieval.
 *
 * @param {string} collectionName - Name of the collection (e.g., 'customers', 'ads')
 * @param {Array} data - Array of items to store
 * @returns {Promise<void>} Promise resolving when all chunks are saved
 */
async function saveCollectionToIndexedDB(collectionName, data) {
  if (!db) return false;
  // MULTI-TAB SAFETY: a tab that lost the single-writer lock must never
  // rewrite a collection from its (possibly stale) in-memory array — that
  // would silently delete records the winning tab already persisted.
  if (typeof isAnotherTabWriter === 'function' && isAnotherTabWriter()) return false;
  const name = String(collectionName || '');
  if (!name) return false;
  // Capture the scope before the first await. A logout/login during the write
  // cannot redirect later chunks into a different user's namespace.
  const capturedScope = _collectionStorageScope;
  const dataKey = _scopedCollectionStorageName(name, capturedScope);

  try {
    const metaKey = getCollectionMetaKey(name, capturedScope);
    const prevMeta = await idbGet(DATA_STORE_NAME, metaKey);
    const prevChunkCount = prevMeta?.chunkCount || 0;

    // Small payload -> single record (backwards compatible)
    const isArray = Array.isArray(data);
    const recordCount = isArray ? data.length : 0;
    if (!isArray || recordCount <= STORAGE_CONFIG.CHUNK_SIZE) {
      const record = {
        key: dataKey,
        type: 'collection',
        data,
        checksum: DataIntegrity.calculateChecksum(data),
        updatedAt: Date.now(),
        recordCount
      };

      // Atomic: write the single record AND drop any old chunked layout in one
      // transaction, so we can never end up with both present (which would make
      // load prefer the stale chunked copy).
      const deleteKeys = [];
      if (prevChunkCount > 0) {
        for (let i = 0; i < prevChunkCount; i++) deleteKeys.push(getCollectionChunkKey(name, i, capturedScope));
        deleteKeys.push(metaKey);
      }
      await idbAtomicWrite([record], deleteKeys);
      return true;
    }

    // Large payload -> chunked
    const chunkSize = STORAGE_CONFIG.CHUNK_SIZE;
    const chunkCount = Math.ceil(recordCount / chunkSize);
    const updatedAt = Date.now();

    // Build every chunk record + the meta record, then commit them together
    // with the cleanup deletes in ONE atomic transaction. An interrupted save
    // now rolls back entirely, leaving the previous consistent generation
    // (chunks + meta) intact instead of a corrupt mix.
    const puts = [];
    for (let i = 0; i < chunkCount; i++) {
      const chunk = data.slice(i * chunkSize, (i + 1) * chunkSize);
      puts.push({
        key: getCollectionChunkKey(name, i, capturedScope),
        type: 'collection_chunk',
        collection: name,
        index: i,
        updatedAt,
        data: chunk
      });
    }
    puts.push({
      key: metaKey,
      type: 'collection_meta',
      collection: name,
      chunkSize,
      chunkCount,
      recordCount,
      checksum: DataIntegrity.calculateChecksum(data),
      updatedAt
    });

    const deleteKeys = [];
    // Leftover old chunks beyond the new count
    if (prevChunkCount > chunkCount) {
      for (let i = chunkCount; i < prevChunkCount; i++) deleteKeys.push(getCollectionChunkKey(name, i, capturedScope));
    }
    // Legacy single-record storage, if it exists
    deleteKeys.push(dataKey);

    await idbAtomicWrite(puts, deleteKeys);
    return true;
  } catch (error) {
    console.error('Error saving collection to IndexedDB:', error);
    return false;
  }
}

// DATA SAFETY: collections whose IndexedDB copy loaded INCOMPLETE (a chunk was
// missing / the record count didn't match). Such a collection must never be
// re-saved, or the truncated in-memory array would overwrite the intact-but-
// unread chunks and permanently destroy the missing records.
let _corruptedCollections = new Set();
function isCollectionCorrupted(name) { return _corruptedCollections.has(String(name || '')); }
function markCollectionCorrupted(name) { _corruptedCollections.add(String(name || '')); }
function clearCollectionCorruption(name) { _corruptedCollections.delete(String(name || '')); }

async function loadCollectionFromIndexedDB(collectionName) {
  if (!db) return null;
  const name = String(collectionName || '');
  if (!name) return null;
  const capturedScope = _collectionStorageScope;
  const dataKey = _scopedCollectionStorageName(name, capturedScope);

  try {
    const metaKey = getCollectionMetaKey(name, capturedScope);
    const meta = await idbGet(DATA_STORE_NAME, metaKey);

    // Chunked layout
    if (meta && meta.type === 'collection_meta' && Number.isFinite(meta.chunkCount)) {
      const chunks = [];
      let missingChunk = false;
      for (let i = 0; i < meta.chunkCount; i++) {
        const chunk = await idbGet(DATA_STORE_NAME, getCollectionChunkKey(name, i, capturedScope));
        if (chunk && Array.isArray(chunk.data)) {
          chunks.push(...chunk.data);
        } else {
          console.warn(`Missing chunk for ${name} index ${i}`);
          missingChunk = true;
        }
      }

      let checksumMismatch = false;
      if (meta.checksum) {
        const currentChecksum = DataIntegrity.calculateChecksum(chunks);
        if (currentChecksum !== meta.checksum) {
          console.warn(`Data integrity warning for ${name}: checksum mismatch`);
          checksumMismatch = true;
        }
      }

      // A missing chunk, or a loaded record-count that doesn't match what was
      // saved, means the data we could read is INCOMPLETE. Returning it as if
      // complete would let the caller adopt a truncated collection and re-save
      // it, wiping the unread records. Flag corruption (blocks re-save) and
      // throw so the loader can fall back / warn instead of silently truncating.
      // A checksum mismatch with all chunks present AND a matching record count
      // is treated as a soft warning only (avoids false positives from checksum
      // nuances bricking otherwise-complete data).
      const recordCountMismatch = Number.isFinite(meta.recordCount) && chunks.length !== meta.recordCount;
      if (missingChunk || recordCountMismatch || (checksumMismatch && recordCountMismatch)) {
        markCollectionCorrupted(name);
        const err = new Error(`IndexedDB collection "${name}" is incomplete (${missingChunk ? 'missing chunk' : 'record count mismatch'})`);
        err.code = 'IDB_COLLECTION_CORRUPT';
        err.partialData = chunks;
        throw err;
      }

      return chunks;
    }

    // Legacy single-record layout
    const record = await idbGet(DATA_STORE_NAME, dataKey);
    if (record) {
      const currentChecksum = DataIntegrity.calculateChecksum(record.data);
      if (record.checksum && currentChecksum !== record.checksum) {
        console.warn(`Data integrity warning for ${name}: checksum mismatch`);
      }
      return record.data ?? null;
    }

    return null;
  } catch (error) {
    // Let the corruption signal reach the loader so it can fall back + warn.
    if (error && error.code === 'IDB_COLLECTION_CORRUPT') throw error;
    console.error('Error loading collection from IndexedDB:', error);
    return null;
  }
}

async function createAutoBackup() {
  if (!db) return false;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([BACKUP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(BACKUP_STORE_NAME);
      
      const backup = {
        id: Security.generateSecureId('backup'),
        createdAt: Date.now(),
        state: {
          ads: state.ads,
          receipts: state.receipts,
          customers: state.customers,
          pages: state.pages,
          users: state.users.map(u => ({
            ...u,
            password: undefined,
            passwordHash: u.passwordHash,
            salt: u.salt,
            passwordAlgo: u.passwordAlgo,
            passwordIterations: u.passwordIterations
          })),
          settings: {
            defaultExchangeRate: state.defaultExchangeRate,
            exchangeRateHistory: state.exchangeRateHistory
          }
        },
        checksum: DataIntegrity.calculateChecksum(state)
      };
      
      const request = store.put(backup);
      request.onsuccess = () => {
        // Clean old backups
        cleanOldBackups();
        resolve(true);
      };
      request.onerror = () => resolve(false);
    } catch (error) {
      console.error('Error creating backup:', error);
      resolve(false);
    }
  });
}

async function cleanOldBackups() {
  if (!db) return;
  
  try {
    const cutoffDate = Date.now() - (STORAGE_CONFIG.BACKUP_RETENTION_DAYS * TIME_CONSTANTS.MILLISECONDS_PER_DAY);
    const transaction = db.transaction([BACKUP_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(BACKUP_STORE_NAME);
    const index = store.index('createdAt');
    const range = IDBKeyRange.upperBound(cutoffDate);
    
    index.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  } catch (error) {
    console.error('Error cleaning old backups:', error);
  }
}

async function saveLogToIndexedDB(log) {
  if (!db) return false;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.put(log);
      
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => {
        console.error('Error saving log to IndexedDB:', e);
        resolve(false);
      };
    } catch (error) {
      console.error('IndexedDB transaction error:', error);
      resolve(false);
    }
  });
}

async function loadLogsFromIndexedDB() {
  if (!db) return [];
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readonly');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const logs = request.result || [];
        // Sort by date descending (handle invalid dates safely)
        logs.sort((a, b) => {
          const dateA = new Date(a.date || 0).getTime() || 0;
          const dateB = new Date(b.date || 0).getTime() || 0;
          return dateB - dateA;
        });
        resolve(logs);
      };
      
      request.onerror = (e) => {
        console.error('Error loading logs from IndexedDB:', e);
        resolve([]);
      };
    } catch (error) {
      console.error('IndexedDB load error:', error);
      resolve([]);
    }
  });
}

async function syncLogsToIndexedDB() {
  if (!db || !state.logs) return;
  
  const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(LOG_STORE_NAME);
  
  for (const log of state.logs) {
    try {
      store.put(log);
    } catch (e) {
      console.error('Error syncing log:', e);
    }
  }
}

async function clearIndexedDBLogs() {
  if (!db) return;
  
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction([LOG_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(LOG_STORE_NAME);
      const request = store.clear();
      
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    } catch (error) {
      resolve(false);
    }
  });
}
