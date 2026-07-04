// ==========================================
// LOCALSTORAGE PERSISTENCE
// ==========================================

// Maximum logs to store in localStorage (the rest stay in IndexedDB only)
const MAX_LOGS_IN_LOCALSTORAGE = 500;

// Large collections are stored in IndexedDB for huge data support
const PERSISTED_COLLECTIONS = [
  'ads',
  'receipts',
  'customers',
  'pages',
  'users',
  'exchangeRateHistory',
  // Platform foundation (future‑proof)
  'walletTransactions',
  'serviceSubscriptions'
];

// Debounced IndexedDB sync (avoid writing huge arrays on every keystroke)
const idbSync = {
  dirty: new Set(),
  timer: null,
  flushing: false,
  debounceMs: 800
};

function getCollectionNameFromArray(array) {
  if (array === state.ads) return 'ads';
  if (array === state.receipts) return 'receipts';
  if (array === state.customers) return 'customers';
  if (array === state.pages) return 'pages';
  if (array === state.users) return 'users';
  if (array === state.exchangeRateHistory) return 'exchangeRateHistory';
  if (array === state.walletTransactions) return 'walletTransactions';
  if (array === state.serviceSubscriptions) return 'serviceSubscriptions';
  return null;
}

function markCollectionDirty(collectionName) {
  if (!db) return;
  if (!collectionName || !PERSISTED_COLLECTIONS.includes(collectionName)) return;
  // DATA SAFETY: never re-save a collection whose IndexedDB copy loaded
  // incomplete — rewriting it would overwrite the intact (unread) chunks with
  // the truncated in-memory array and destroy the missing records for good.
  if (typeof isCollectionCorrupted === 'function' && isCollectionCorrupted(collectionName)) {
    console.warn(`[albayan] Skipping IndexedDB re-save of "${collectionName}" — its stored copy is incomplete (protected from overwrite).`);
    return;
  }
  idbSync.dirty.add(collectionName);

  if (idbSync.timer) clearTimeout(idbSync.timer);
  idbSync.timer = setTimeout(() => {
    flushDirtyCollections().catch((e) => console.warn('IndexedDB flush error:', e));
  }, idbSync.debounceMs);
}

function markAllCollectionsDirty() {
  for (const name of PERSISTED_COLLECTIONS) markCollectionDirty(name);
}

async function flushDirtyCollections() {
  if (!db || idbSync.flushing) return;
  if (idbSync.dirty.size === 0) return;

  idbSync.flushing = true;
  const toFlush = Array.from(idbSync.dirty);
  idbSync.dirty.clear();

  try {
    for (const name of toFlush) {
      await saveCollectionToIndexedDB(name, state[name]);
    }
  } finally {
    idbSync.flushing = false;
  }
  // Collections marked dirty WHILE this flush was running hit the re-entrancy
  // guard above and had their debounce swallowed — they would otherwise sit
  // unpersisted until some unrelated later edit. Flush them now. Terminates
  // because each pass clears the set.
  if (idbSync.dirty.size > 0) {
    await flushDirtyCollections();
  }
}

function saveState() {
  try {
    // Create a copy of state with optimized log storage
    // Keep only recent logs in localStorage, all logs are in IndexedDB
    const logsForStorage = db ? state.logs.slice(0, MAX_LOGS_IN_LOCALSTORAGE) : state.logs;
    
    const toSave = { ...state };
    toSave.logs = logsForStorage; // Only store recent logs in localStorage
    // Never persist full user object in localStorage (sessionStorage is the source of truth)
    delete toSave.currentUser;
    // Persist large collections in IndexedDB only. CRITICAL: if IndexedDB is
    // unavailable (db === null — e.g. some private-browsing modes and older
    // WebViews), keep the collections inside this localStorage snapshot.
    // Deleting them here with no IndexedDB would leave business data in
    // memory only, and it would vanish on the next reload.
    if (db) {
      for (const key of PERSISTED_COLLECTIONS) {
        delete toSave[key];
      }
    }
    // Mark metadata for migration/debugging
    toSave._storageVersion = 2;
    toSave._persistedAt = new Date().toISOString();
    // Avoid persisting runtime-only UI fields
    delete toSave.isMobileMenuOpen;
    delete toSave.commandPaletteOpen;
    delete toSave.activeModal;
    delete toSave.modalData;
    delete toSave.tempAdFunding;
    delete toSave.tempAdPhotos;
    
    // Sanitize before persistence (defense-in-depth)
    const sanitizedToSave = Security.sanitizeObject(toSave);
    // PERFORMANCE: serialize ONCE and reuse for both the size check and the
    // write. The old code stringified the whole snapshot twice and also built a
    // throwaway Blob just to measure it — in no-IndexedDB mode that snapshot
    // includes every collection with base64 photos, and saveState runs on hot
    // paths (every permission toggle / record update), so that was 2× multi-MB
    // serialization + a Blob allocation per call. dataString.length ≈ the byte
    // size here (base64 photos + JSON keys are ASCII), so no Blob is needed.
    let dataString = JSON.stringify(sanitizedToSave);
    const sizeInMB = dataString.length / (1024 * 1024);
    if (sizeInMB > 4) {
      console.warn(`LocalStorage data size: ${sizeInMB.toFixed(2)}MB - approaching limit`);
      // Further reduce logs and re-serialize only in this rare branch.
      sanitizedToSave.logs = state.logs.slice(0, 100);
      dataString = JSON.stringify(sanitizedToSave);
    }

    localStorage.setItem('albayan_complete_state', dataString);
  } catch (error) {
    console.error('Error saving state:', error);
    
    // If quota exceeded, try with fewer logs
    if (error.name === 'QuotaExceededError' || error.message.includes('quota')) {
      // CRITICAL: without IndexedDB, this localStorage snapshot is the ONLY
      // persisted copy of the business data. Overwriting it with a reduced,
      // collection-less snapshot would destroy that copy — so in no-IDB mode
      // we keep the last good snapshot untouched and just warn the user.
      if (!db) {
        console.warn('Storage quota exceeded and IndexedDB is unavailable — keeping the previous snapshot to protect data.');
        try {
          showNotification(
            state.language === 'ar' ? 'مساحة التخزين ممتلئة' : 'Storage Full',
            state.language === 'ar'
              ? 'لا يمكن حفظ آخر التغييرات — مساحة المتصفح ممتلئة. صدّر نسخة احتياطية من الإعدادات.'
              : 'Latest changes could not be saved — browser storage is full. Please export a backup from Settings.',
            'error'
          );
        } catch (_) {}
        return;
      }
      try {
        const reducedSave = Security.sanitizeObject({
          language: state.language,
          theme: state.theme,
          currentView: state.currentView,
          logs: state.logs.slice(0, 50),
          defaultExchangeRate: state.defaultExchangeRate,
          cloudConfig: state.cloudConfig,
          _storageVersion: 2,
          _persistedAt: new Date().toISOString()
        });
        localStorage.setItem('albayan_complete_state', JSON.stringify(reducedSave));
      } catch (e) {
        // Suppress notification: quota exceeded is not critical (data is in IndexedDB + server)
      }
    } else {
      // Only show error for non-quota issues
    }
  }
}

// PERFORMANCE: Debounced saveState to avoid blocking UI during rapid navigation
let _saveStateTimer = null;
function debouncedSaveState() {
  if (_saveStateTimer) clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(() => {
    _saveStateTimer = null;
    saveState();
  }, 300); // Save after 300ms of inactivity
}

function loadState() {
  try {
    const saved = localStorage.getItem('albayan_complete_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      
      // Sanitize loaded data to prevent XSS from corrupted storage
      const sanitizedData = Security.sanitizeObject(parsed);

      // Extract legacy large collections (older versions stored everything in
      // localStorage, and no-IndexedDB mode still does). Built from
      // PERSISTED_COLLECTIONS so every collection saveState() persists is
      // round-tripped — a hard-coded list here once missed walletTransactions
      // and serviceSubscriptions, wiping wallets on reload in no-IDB mode.
      const legacyCollections = {};
      for (const key of PERSISTED_COLLECTIONS) {
        legacyCollections[key] = Array.isArray(sanitizedData[key]) ? sanitizedData[key] : null;
      }
      // Do not merge large collections from localStorage into runtime state (they belong in IndexedDB)
      for (const key of PERSISTED_COLLECTIONS) delete sanitizedData[key];
      
      // Merge saved state but keep runtime-only properties
      Object.assign(state, sanitizedData, {
        isMobileMenuOpen: false,
        commandPaletteOpen: false,
        activeModal: null,
        modalData: null
      });
      
      // Ensure arrays exist (for backwards compatibility)
      if (!Array.isArray(state.receipts)) state.receipts = [];
      if (!Array.isArray(state.ads)) state.ads = [];
      if (!Array.isArray(state.customers)) state.customers = [];
      if (!Array.isArray(state.pages)) state.pages = [];
      if (!Array.isArray(state.logs)) state.logs = [];
      if (!Array.isArray(state.users)) state.users = [];
      if (!Array.isArray(state.exchangeRateHistory)) state.exchangeRateHistory = [];
      if (!Array.isArray(state.walletTransactions)) state.walletTransactions = [];
      if (!Array.isArray(state.serviceSubscriptions)) state.serviceSubscriptions = [];
      
      // Validate language (must be 'en' or 'ar')
      if (state.language !== 'en' && state.language !== 'ar') {
        state.language = 'en';
      }
      
      // Validate theme (must be 'light', 'dark', or 'system')
      if (state.theme !== 'light' && state.theme !== 'dark' && state.theme !== 'system') {
        state.theme = 'light';
      }
      
      // Migrate receipts from ads array to receipts array (backwards compatibility)
      const receiptsInAds = state.ads.filter(a => a.recordType === 'receipt');
      if (receiptsInAds.length > 0) {
        receiptsInAds.forEach(r => {
          if (!state.receipts.find(existing => existing.id === r.id)) {
            state.receipts.push(r);
          }
        });
        // Remove receipts from ads array
        state.ads = state.ads.filter(a => a.recordType !== 'receipt');
        saveState();
      }
      
      // Validate session if user is logged in
      if (state.currentUser && !SessionManager.isAuthenticated()) {
        state.currentUser = null; // Session expired, log out
      }

      return legacyCollections;
    }
  } catch (error) {
    console.error('Error loading state:', error);
    // Log security event for potential data tampering
    addSecurityLog('data_load_error', error.message);
  }
  return null;
}

// Security logging for suspicious activities
function addSecurityLog(type, details) {
  const log = {
    id: Security.generateSecureId('security'),
    type,
    details: Security.sanitizeInput(details),
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent
  };
  
  // Store in a separate security log
  try {
    const securityLogs = JSON.parse(localStorage.getItem('albayan_security_logs') || '[]');
    securityLogs.unshift(log);
    // BEST PRACTICE: Use constant for limit
    if (securityLogs.length > LIMIT_CONSTANTS.MAX_SECURITY_LOGS) securityLogs.length = LIMIT_CONSTANTS.MAX_SECURITY_LOGS;
    localStorage.setItem('albayan_security_logs', JSON.stringify(securityLogs));
  } catch (e) {
    console.error('Failed to log security event:', e);
  }
}

// ==========================================
// DATA LOADING, MIGRATION, SANITIZATION (IndexedDB-first)
// ==========================================

function normalizeReceiptsFromAds() {
  if (!Array.isArray(state.ads)) state.ads = [];
  if (!Array.isArray(state.receipts)) state.receipts = [];

  const receiptsInAds = state.ads.filter(a => a && a.recordType === 'receipt');
  if (receiptsInAds.length === 0) return false;

  for (const r of receiptsInAds) {
    if (!state.receipts.find(existing => existing.id === r.id)) {
      state.receipts.push(r);
    }
  }
  state.ads = state.ads.filter(a => !a || a.recordType !== 'receipt');
  return true;
}

// Warn the user (once per collection) that a stored collection loaded incomplete
// and is protected from being overwritten, so they can restore a backup.
function _notifyCollectionCorruption(name) {
  try {
    if (!Array.isArray(state._corruptedCollections)) state._corruptedCollections = [];
    if (!state._corruptedCollections.includes(name)) state._corruptedCollections.push(name);
    console.error(`[albayan] IndexedDB copy of "${name}" is incomplete — protected from overwrite; restore a backup.`);
    if (typeof showNotification === 'function') {
      const ar = `تعذّر تحميل بعض بيانات (${name}) كاملة من هذا الجهاز، وتم منع الكتابة فوقها لحمايتها. الرجاء الاستعادة من نسخة احتياطية حديثة من الإعدادات.`;
      const en = `Some saved "${name}" data could not be fully loaded from this device and has been protected from being overwritten. Please restore from a recent backup in Settings.`;
      showNotification(
        state.language === 'ar' ? 'تحذير سلامة البيانات' : 'Data Safety Warning',
        state.language === 'ar' ? ar : en,
        'error'
      );
    }
  } catch (_) {}
}

async function loadCollectionsFromStorage(legacyCollections = null) {
  const legacy = legacyCollections || {};

  for (const name of PERSISTED_COLLECTIONS) {
    let loaded = null;

    if (db) {
      try {
        loaded = await loadCollectionFromIndexedDB(name);
      } catch (e) {
        if (e && e.code === 'IDB_COLLECTION_CORRUPT') {
          // The IndexedDB copy is incomplete. Prefer the legacy localStorage
          // snapshot if present (it may be complete); otherwise keep the partial
          // records we could read. Either way the collection stays flagged
          // corrupted so it is NOT re-saved over the intact chunks, and we warn
          // the user to restore a backup.
          if (Array.isArray(legacy[name])) {
            state[name] = legacy[name];
          } else if (Array.isArray(e.partialData)) {
            state[name] = e.partialData;
          } else if (!Array.isArray(state[name])) {
            state[name] = [];
          }
          _notifyCollectionCorruption(name);
          continue;
        }
        throw e;
      }
    }

    if (loaded !== null && loaded !== undefined) {
      state[name] = loaded;
    } else if (Array.isArray(legacy[name])) {
      // Legacy migration path: seed IndexedDB from localStorage snapshot
      state[name] = legacy[name];
      if (db) {
        await saveCollectionToIndexedDB(name, state[name]);
      }
    } else {
      if (!Array.isArray(state[name])) state[name] = [];
    }
  }

  // Backwards compatibility: receipts used to be stored in ads[]
  const normalized = normalizeReceiptsFromAds();
  if (normalized && db) {
    // Never re-save a corrupted collection (would overwrite intact chunks).
    if (!isCollectionCorrupted('ads')) await saveCollectionToIndexedDB('ads', state.ads);
    if (!isCollectionCorrupted('receipts')) await saveCollectionToIndexedDB('receipts', state.receipts);
  }

  // Persist the refreshed localStorage snapshot. With IndexedDB available
  // this drops the large arrays from localStorage; without IndexedDB,
  // saveState() now keeps them there so existing data is never wiped.
  saveState();
}

async function sanitizeCollectionInPlace(collectionName) {
  const arr = state[collectionName];
  if (!Array.isArray(arr) || arr.length === 0) return;

  const chunk = 500;
  for (let i = 0; i < arr.length; i += chunk) {
    const end = Math.min(i + chunk, arr.length);
    for (let j = i; j < end; j++) {
      const item = arr[j];
      if (item && typeof item === 'object') {
        arr[j] = Security.sanitizeObject(item);
      } else if (typeof item === 'string') {
        arr[j] = Security.sanitizeInput(item);
      }
    }
    // Yield to keep UI responsive
    await new Promise(r => setTimeout(r, 0));
  }
}

async function sanitizeAllCollectionsForRendering() {
  for (const name of PERSISTED_COLLECTIONS) {
    await sanitizeCollectionInPlace(name);
  }
}

// ==========================================
// DATA MIGRATION: Normalize old records
// ==========================================
// Ensures old data has all required fields so new features work correctly
function migrateOldDataFormats() {
  let changed = false;

  // Migrate Receipts - ALWAYS process ALL receipts (including old data)
  if (Array.isArray(state.receipts)) {
    for (const receipt of state.receipts) {
      if (!receipt) continue;
      // Process even deleted records to ensure data consistency

      // Ensure receipt has isPaid boolean
      if (receipt.isPaid === undefined) {
        const status = String(receipt.status || '').toLowerCase();
        receipt.isPaid = (status === 'paid');
        changed = true;
      }

      // Ensure receipt has amountUSD/amountLocal
      if (receipt.amountUSD === undefined && receipt.amount !== undefined) {
        receipt.amountUSD = parseFloat(receipt.amount) || 0;
        changed = true;
      }
      if (receipt.amountLocal === undefined && receipt.amountLYD !== undefined) {
        receipt.amountLocal = parseFloat(receipt.amountLYD) || 0;
        changed = true;
      }

      // Ensure serialNumber is consistent with finalReceiptNo
      if (!receipt.serialNumber && receipt.finalReceiptNo) {
        receipt.serialNumber = receipt.finalReceiptNo;
        changed = true;
      }

      // Normalize createdAt
      if (!receipt.createdAt && receipt.startDate) {
        receipt.createdAt = receipt.startDate;
        changed = true;
      }

      // Fix delivery status - ensure it's a valid status
      if (receipt.deliveryStatus) {
        const validStatuses = ['Office', 'Needs Delivery', 'In Progress', 'Delivered', 'Canceled'];
        if (!validStatuses.includes(receipt.deliveryStatus)) {
          receipt.deliveryStatus = 'Office';
          changed = true;
        }
      }

      // Ensure exchangeRate is a number
      if (receipt.exchangeRate !== undefined && typeof receipt.exchangeRate !== 'number') {
        receipt.exchangeRate = parseFloat(receipt.exchangeRate) || state.defaultExchangeRate || 1;
        changed = true;
      }

      // Ensure editHistory is an array
      if (receipt.editHistory && !Array.isArray(receipt.editHistory)) {
        receipt.editHistory = [];
        changed = true;
      }
      if (typeof receipt.editCount !== 'number') {
        receipt.editCount = Array.isArray(receipt.editHistory) ? receipt.editHistory.length : 0;
        changed = true;
      }
    }
  }

  // Migrate Ads - ALWAYS process ALL ads (including old data)
  if (Array.isArray(state.ads)) {
    for (const ad of state.ads) {
      if (!ad) continue;

      // Ensure ad has receiptAllocations array
      if (!Array.isArray(ad.receiptAllocations)) {
        ad.receiptAllocations = [];

        // Migrate old single-receipt linking to receiptAllocations
        const linkedReceiptId = ad.fundingReceiptId || ad.receiptId;
        if (linkedReceiptId && (ad.amountUSD || ad.spentUSD)) {
          ad.receiptAllocations.push({
            receiptId: String(linkedReceiptId),
            amountUSD: ad.spentUSD || ad.amountUSD || 0
          });
          changed = true;
        }
      }

      // Normalize string IDs in receiptAllocations
      if (Array.isArray(ad.receiptAllocations)) {
        for (const alloc of ad.receiptAllocations) {
          if (alloc && alloc.receiptId) {
            alloc.receiptId = String(alloc.receiptId);
          }
        }
      }

      // Ensure dueAllocations array exists
      if (!Array.isArray(ad.dueAllocations)) {
        ad.dueAllocations = [];
        // Migrate from linkedDeliveryReceiptId if present
        if (ad.linkedDeliveryReceiptId && !ad.isPaid) {
          ad.dueAllocations.push({
            receiptId: String(ad.linkedDeliveryReceiptId),
            amountUSD: ad.amountUSD || 0
          });
          changed = true;
        }
      }

      // Ensure ad has customerId
      if (!ad.customerId && ad.customer) {
        ad.customerId = ad.customer;
        changed = true;
      }

      // Ensure ad has pageId
      if (!ad.pageId && ad.page) {
        ad.pageId = ad.page;
        changed = true;
      }

      // Normalize createdAt
      if (!ad.createdAt && ad.startDate) {
        ad.createdAt = ad.startDate;
        changed = true;
      }

      // Fix delivery status
      if (ad.deliveryStatus) {
        const validStatuses = ['Office', 'Needs Delivery', 'In Progress', 'Delivered', 'Canceled'];
        if (!validStatuses.includes(ad.deliveryStatus)) {
          ad.deliveryStatus = 'Office';
          changed = true;
        }
      }
    }
  }

  // Migrate Customers - ALWAYS process ALL customers
  if (Array.isArray(state.customers)) {
    for (const customer of state.customers) {
      if (!customer) continue;

      // Ensure phones is an array
      if (!Array.isArray(customer.phones)) {
        if (customer.phone) {
          customer.phones = [customer.phone];
        } else {
          customer.phones = [];
        }
        changed = true;
      }

      // Ensure name exists
      if (!customer.name) {
        customer.name = 'Unknown';
        changed = true;
      }
    }
  }

  // Migrate Pages - ALWAYS process ALL pages
  if (Array.isArray(state.pages)) {
    for (const page of state.pages) {
      if (!page) continue;

      // Ensure customerIds is an array
      if (!Array.isArray(page.customerIds)) {
        if (page.customerId) {
          page.customerIds = [page.customerId];
        } else {
          page.customerIds = [];
        }
        changed = true;
      }

      // Ensure name exists
      if (!page.name) {
        page.name = 'Unnamed Page';
        changed = true;
      }
    }
  }

  // Assign sequential numbers to all records
  assignSequentialNumbers();

  if (changed) {
    console.log('[Migration] Data formats updated for ALL records');
    markAllCollectionsDirty();
    // Save immediately to persist migrations
    saveState();
  }

  return changed;
}

// ==========================================
// SEQUENTIAL NUMBERING: Assign display numbers
// ==========================================
// Assigns sequential numbers (1, 2, 3...) to records based on creation order
// PERFORMANCE: Only assigns if missing, uses cached sort when possible
let _seqNoCache = {
  ads: null,
  receipts: null,
  customers: null,
  pages: null,
  lastUpdate: 0
};

function assignSequentialNumbers(force = false) {
  const now = Date.now();
  // Only recalculate if forced or cache is stale (>5 seconds old)
  if (!force && (now - _seqNoCache.lastUpdate) < 5000 && _seqNoCache.ads !== null) {
    return; // Use cached numbers
  }
  
  // Helper to sort by creation time (optimized - cache timestamps)
  const getTime = (item) => {
    if (item._cachedTime !== undefined) return item._cachedTime;
    const time = new Date(item.createdAt || item.startDate || item._created || 0).getTime();
    item._cachedTime = time; // Cache for next sort
    return time;
  };
  
  const sortByCreated = (a, b) => getTime(a) - getTime(b);
  
  // Assign numbers to Ads (only if missing or forced)
  if (Array.isArray(state.ads)) {
    const visible = getVisibleRecords(state.ads);
    const needsUpdate = force || visible.some(ad => !ad._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((ad, idx) => {
        ad._seqNo = idx + 1;
      });
      _seqNoCache.ads = sorted.length;
    }
  }
  
  // Assign numbers to Receipts
  if (Array.isArray(state.receipts)) {
    const visible = getVisibleRecords(state.receipts);
    const needsUpdate = force || visible.some(r => !r._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((receipt, idx) => {
        receipt._seqNo = idx + 1;
      });
      _seqNoCache.receipts = sorted.length;
    }
  }
  
  // Assign numbers to Customers
  if (Array.isArray(state.customers)) {
    const visible = getVisibleRecords(state.customers);
    const needsUpdate = force || visible.some(c => !c._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((customer, idx) => {
        customer._seqNo = idx + 1;
      });
      _seqNoCache.customers = sorted.length;
    }
  }
  
  // Assign numbers to Pages
  if (Array.isArray(state.pages)) {
    const visible = getVisibleRecords(state.pages);
    const needsUpdate = force || visible.some(p => !p._seqNo);
    if (needsUpdate) {
      const sorted = visible.slice().sort(sortByCreated);
      sorted.forEach((page, idx) => {
        page._seqNo = idx + 1;
      });
      _seqNoCache.pages = sorted.length;
    }
  }
  
  _seqNoCache.lastUpdate = now;
}

async function ensureUsersHavePasswordHashes() {
  if (!Array.isArray(state.users)) return;

  let changed = false;
  for (const user of state.users) {
    if (!user || user._deleted) continue;

    // If user has a plaintext password (legacy), migrate immediately
    if (!user.passwordHash && user.password) {
      const hashed = await Security.hashPassword(user.password, null, { algo: 'pbkdf2-sha256' });
      user.passwordHash = hashed.hash;
      user.salt = hashed.salt;
      user.passwordAlgo = hashed.algo;
      user.passwordIterations = hashed.iterations;
      delete user.password;
      changed = true;
      continue;
    }

    // Normalize algorithm metadata for existing hashes
    if (user.passwordHash && user.salt && !user.passwordAlgo) {
      user.passwordAlgo = 'sha256'; // legacy default
      changed = true;
    }
    if (user.passwordAlgo === 'pbkdf2-sha256' && !user.passwordIterations) {
      user.passwordIterations = 310000;
      changed = true;
    }
  }

  if (changed) {
    markCollectionDirty('users');
    saveState();
    await flushDirtyCollections();
  }
}

