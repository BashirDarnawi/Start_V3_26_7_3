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

/**
 * Initialize IndexedDB for large data storage and caching.
 * Creates necessary object stores and handles version upgrades.
 * Falls back gracefully if IndexedDB is not supported.
 *
 * @returns {Promise<IDBDatabase|null>} Promise resolving to database instance or null if unsupported
 */
function initIndexedDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported, falling back to localStorage');
      resolve(null);
      return;
    }
    
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      resolve(null);
    };
    
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
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

function getCollectionMetaKey(collectionName) {
  return `collection:${collectionName}:meta`;
}

function getCollectionChunkKey(collectionName, index) {
  return `collection:${collectionName}:chunk:${index}`;
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
  const name = String(collectionName || '');
  if (!name) return false;

  try {
    const metaKey = getCollectionMetaKey(name);
    const prevMeta = await idbGet(DATA_STORE_NAME, metaKey);
    const prevChunkCount = prevMeta?.chunkCount || 0;

    // Small payload -> single record (backwards compatible)
    const isArray = Array.isArray(data);
    const recordCount = isArray ? data.length : 0;
    if (!isArray || recordCount <= STORAGE_CONFIG.CHUNK_SIZE) {
      const record = {
        key: name,
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
        for (let i = 0; i < prevChunkCount; i++) deleteKeys.push(getCollectionChunkKey(name, i));
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
        key: getCollectionChunkKey(name, i),
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
      for (let i = chunkCount; i < prevChunkCount; i++) deleteKeys.push(getCollectionChunkKey(name, i));
    }
    // Legacy single-record storage, if it exists
    deleteKeys.push(name);

    await idbAtomicWrite(puts, deleteKeys);
    return true;
  } catch (error) {
    console.error('Error saving collection to IndexedDB:', error);
    return false;
  }
}

async function loadCollectionFromIndexedDB(collectionName) {
  if (!db) return null;
  const name = String(collectionName || '');
  if (!name) return null;

  try {
    const metaKey = getCollectionMetaKey(name);
    const meta = await idbGet(DATA_STORE_NAME, metaKey);

    // Chunked layout
    if (meta && meta.type === 'collection_meta' && Number.isFinite(meta.chunkCount)) {
      const chunks = [];
      for (let i = 0; i < meta.chunkCount; i++) {
        const chunk = await idbGet(DATA_STORE_NAME, getCollectionChunkKey(name, i));
        if (chunk && Array.isArray(chunk.data)) {
          chunks.push(...chunk.data);
        } else {
          console.warn(`Missing chunk for ${name} index ${i}`);
        }
      }

      if (meta.checksum) {
        const currentChecksum = DataIntegrity.calculateChecksum(chunks);
        if (currentChecksum !== meta.checksum) {
          console.warn(`Data integrity warning for ${name}: checksum mismatch`);
        }
      }

      return chunks;
    }

    // Legacy single-record layout
    const record = await idbGet(DATA_STORE_NAME, name);
    if (record) {
      const currentChecksum = DataIntegrity.calculateChecksum(record.data);
      if (record.checksum && currentChecksum !== record.checksum) {
        console.warn(`Data integrity warning for ${name}: checksum mismatch`);
      }
      return record.data ?? null;
    }

    return null;
  } catch (error) {
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

async function getStorageEstimate() {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      usagePercentage: estimate.quota ? ((estimate.usage / estimate.quota) * 100).toFixed(2) : 0
    };
  }
  return { usage: 0, quota: 0, usagePercentage: 0 };
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

