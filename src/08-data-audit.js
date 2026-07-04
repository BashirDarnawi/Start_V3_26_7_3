// ==========================================
// DATA HELPERS
// ==========================================

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getMonotonicTime() {
  return Date.now();
}

// Per-record PATCH chains (server mode). Keyed by `${collection}:${id}` so a
// rapid second edit to the same record waits for the first PATCH's echo (which
// carries the server's authoritative _lastModified) and uses THAT as its
// concurrency baseline — instead of the first edit's client timestamp, which
// the server never stored and which always produced a false 409.
const _patchChains = new Map();

/**
 * Add a new record to a collection (receipts, ads, customers, etc.).
 * 
 * Features:
 *   - Automatic ID generation if not provided
 *   - Security sanitization of all data
 *   - Server write-through in online mode
 *   - Rollback on server failure
 *   - Audit logging
 * 
 * @param {Array} array - State collection array (e.g., state.receipts)
 * @param {Object} record - Record data to add
 * 
 * Flow:
 *   1. Sanitize input data (prevent XSS/injection)
 *   2. Generate secure ID if missing
 *   3. Set timestamps and metadata
 *   4. Add to local state (optimistic)
 *   5. Sync to server (if enabled)
 *   6. On success: keep local record
 *   7. On failure: rollback local record + show error
 * 
 * Thread Safety:
 *   - Optimistic updates for fast UI
 *   - Server-side validation catches conflicts
 *   - Automatic rollback prevents data loss
 */
function addRecord(array, record) {
  const collectionName = getCollectionNameFromArray(array);
  const cleanRecord = Security.sanitizeObject(record);
  if (!cleanRecord.id) cleanRecord.id = Security.generateSecureId(collectionName || 'id');

  cleanRecord._lastModified = getMonotonicTime();
  cleanRecord._deleted = false;
  if (!cleanRecord._created) cleanRecord._created = getMonotonicTime();
  if (!cleanRecord.createdBy && state.currentUser?.id) cleanRecord.createdBy = state.currentUser.id;

  array.unshift(cleanRecord);
  if (collectionName) markCollectionDirty(collectionName);
  saveState();
  addAuditLog('Create', cleanRecord.id || 'Unknown', `Created new ${getRecordType(cleanRecord)}`);
  RenderQueue.schedule('addRecord');

  // Server write-through (always-online multi-user mode)
  if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
    const id = cleanRecord.id;
    apiCreateEntity(collectionName, cleanRecord)
      .then((entity) => {
        if (entity?.data && entity?.id) {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) {
            array[idx] = Security.sanitizeObject(entity.data);
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
          }
        }
      })
      .catch((e) => {
        // Rollback on failure
        const idx = array.findIndex(x => x && x.id === id);
        if (idx !== -1) array.splice(idx, 1);
        if (collectionName) markCollectionDirty(collectionName);
        saveState();
        // Handle 401 - session expired, prompt re-login
        if (e?.status === 401) {
          showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
          // Clear cached session to force re-auth on next action
          _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
        } else {
          showNotification('Server Error', `Failed to create ${collectionName}: ${e.message || 'Error'}`, 'error');
        }
      });
  } else if (isServerModeEnabled() && collectionName === 'users') {
    // Creating users requires server-side password handling; this path should not be used.
    showNotification('Server Mode', 'Create users from the server-backed Users screen (Admin only).', 'warning');
  }
}

/**
 * Update an existing record in a collection (merge semantics).
 * 
 * Features:
 *   - Merge updates into existing record (partial updates supported)
 *   - Protected fields cannot be changed (id, timestamps, ownership)
 *   - Security sanitization
 *   - Server write-through with optimistic concurrency control
 *   - Automatic rollback on conflicts or errors
 *   - Permission checks (e.g., users can't edit other users unless admin)
 * 
 * @param {Array} array - State collection array
 * @param {string} id - Record ID to update
 * @param {Object} updates - Fields to update (merged with existing data)
 * 
 * Flow:
 *   1. Find record by ID
 *   2. Sanitize updates
 *   3. Remove protected fields
 *   4. Apply updates locally (optimistic)
 *   5. Sync to server with expectedLastModified (for conflict detection)
 *   6. On success: use server version (authoritative)
 *   7. On conflict (409): reload latest from server
 *   8. On error: rollback to old version
 * 
 * Immutability Rules:
 *   - walletTransactions: Cannot be edited (immutable for audit trail)
 *   - Users: Non-admin users cannot edit role/permissions
 * 
 * Concurrency:
 *   - Uses optimistic locking (expectedLastModified timestamp)
 *   - Prevents lost updates in multi-user scenarios
 */
function updateRecord(array, id, updates, expectedLastModified) {
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const old = { ...array[index] };
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions are immutable. Create a new transaction to correct mistakes.', 'error');
      return;
    }

    const sanitizedUpdates = Security.sanitizeObject(updates);
    // Never allow changing protected fields
    const protectedFields = ['id', '_created', 'createdBy', 'createdAt', 'creatorId'];
    for (const field of protectedFields) {
      if (sanitizedUpdates[field] !== undefined) delete sanitizedUpdates[field];
    }
    // Users: only Admin can change access-control fields (role/permissions/subscriptions).
    // Non-admin users may update their own profile fields (e.g., name/password/passkeys), but not privilege fields.
    if (collectionName === 'users' && state.currentUser && !isAdminRole(state.currentUser.role)) {
      const isSelf = String(state.currentUser.id || '') === String(id || '');
      if (!isSelf) {
        showNotification('Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
        return;
      }
      const blocked = ['role', 'permissions', 'subscriptions'];
      for (const k of blocked) {
        if (sanitizedUpdates[k] !== undefined) delete sanitizedUpdates[k];
      }
    }

    array[index] = { ...array[index], ...sanitizedUpdates, _lastModified: getMonotonicTime() };
    // Keep currentUser in sync when updating own user record (important for profile changes)
    if (collectionName === 'users' && state.currentUser?.id === id) {
      state.currentUser = array[index];
    }
    if (collectionName) markCollectionDirty(collectionName);
    saveState();
    addAuditLog('Update', id, `Updated ${getRecordType(array[index])}`, { old, new: array[index] });
    RenderQueue.schedule('updateRecord');

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      const _patchChainKey = collectionName + ':' + id;
      // If a PATCH for this record is already in flight, this edit is queued
      // behind it and must use the FRESH echoed baseline, not the modal snapshot.
      const _queuedBehind = _patchChains.has(_patchChainKey);
      const _providedExpected = Number.isFinite(Number(expectedLastModified))
        ? Number(expectedLastModified)
        : null;
      const sendPatch = () => {
        // Use the baseline the caller actually saw when supplied (e.g. the modal
        // snapshot the user edited), so a change committed by someone else in
        // between produces a 409 conflict instead of silently overwriting it.
        // For an edit queued behind an in-flight PATCH, read the record's CURRENT
        // _lastModified (the prior PATCH's echo replaced it with the server value).
        let expected;
        if (_queuedBehind) {
          const cur = array.find(x => x && x.id === id);
          expected = (cur && Number.isFinite(Number(cur._lastModified)))
            ? Number(cur._lastModified)
            : (_providedExpected != null ? _providedExpected : (old._lastModified || 0));
        } else {
          expected = _providedExpected != null ? _providedExpected : (old._lastModified || 0);
        }
        return apiPatchEntity(collectionName, id, sanitizedUpdates, expected)
        .then((entity) => {
          if (entity?.data) {
            const idx = array.findIndex(x => x && x.id === id);
            if (idx !== -1) {
              array[idx] = Security.sanitizeObject(entity.data);
              if (collectionName) markCollectionDirty(collectionName);
              saveState();
              // Force full render to ensure list views update
              forceFullRender();
            }
          }
        })
        .catch(async (e) => {
          if (e?.status === 409) {
            try {
              const latest = await apiGetEntity(collectionName, id);
              const idx = array.findIndex(x => x && x.id === id);
              if (idx !== -1 && latest?.data) {
                array[idx] = Security.sanitizeObject(latest.data);
                if (collectionName) markCollectionDirty(collectionName);
                saveState();
              }
              showNotification('Conflict', 'This record was changed by another user. We loaded the latest version.', 'warning');
              render();
              return;
            } catch (err) {
              // fallthrough to rollback
            }
          }

          // Rollback on failure
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to save ${collectionName}: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
      };
      // Chain this PATCH after any in-flight PATCH for the same record (run
      // regardless of whether the previous one resolved or rejected), and drop
      // the chain entry once it settles so a later idle edit starts fresh.
      const _prevPatch = _patchChains.get(_patchChainKey) || Promise.resolve();
      const _thisPatch = _prevPatch.then(sendPatch, sendPatch);
      _patchChains.set(_patchChainKey, _thisPatch);
      _thisPatch.finally(() => {
        if (_patchChains.get(_patchChainKey) === _thisPatch) _patchChains.delete(_patchChainKey);
      });
    } else if (isServerModeEnabled() && collectionName === 'users') {
      // Map to server user update API (Admin only)
      const payload = {};
      if (sanitizedUpdates.name !== undefined) payload.name = sanitizedUpdates.name;
      if (sanitizedUpdates.email !== undefined) payload.email = sanitizedUpdates.email;
      if (sanitizedUpdates.role !== undefined) payload.role = sanitizedUpdates.role;
      if (sanitizedUpdates.permissions !== undefined) payload.permissions = sanitizedUpdates.permissions;
      if (sanitizedUpdates._deleted !== undefined) payload.deleted = !!sanitizedUpdates._deleted;

      apiUpdateUser(id, payload)
        .then((updatedUser) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && updatedUser) {
            array[idx] = { ...array[idx], ...updatedUser, _lastModified: Date.now(), _deleted: false };
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
            render();
          }
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          showNotification('Server Error', `Failed to update user: ${e.message || 'Error'}`, 'error');
          render();
        });
    }
  }
}

function deleteRecord(array, id) {
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions cannot be deleted. Use a reversal transaction.', 'error');
      return;
    }
    if (collectionName === 'serviceSubscriptions') {
      showNotification('Not Allowed', 'Subscription history cannot be deleted.', 'error');
      return;
    }
    const old = { ...array[index] };
    array[index]._deleted = true;
    array[index]._lastModified = getMonotonicTime();
    if (collectionName) markCollectionDirty(collectionName);
    saveState();
    addAuditLog('Delete', id, `Deleted ${getRecordType(array[index])}`);
    RenderQueue.schedule('deleteRecord');

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      apiDeleteEntity(collectionName, id)
        .then(() => {
          // ok
          render();
        })
        .catch((e) => {
          // Rollback on failure
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to delete ${collectionName}: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
    } else if (isServerModeEnabled() && collectionName === 'users') {
      apiUpdateUser(id, { deleted: true })
        .then(() => {
          showNotification('Deleted', 'User deleted', 'success');
          render();
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification('Session Expired', 'Your session has expired. Please log out and log back in.', 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification('Server Error', `Failed to delete user: ${e.message || 'Error'}`, 'error');
          }
          render();
        });
    }
  }
}

function getVisibleRecords(array) {
  if (!Array.isArray(array)) return [];
  return array.filter(item => item && !item._deleted);
}

function getRecordType(record) {
  if (record.email) return 'User';
  if (record.platform) return 'Customer';
  if (record.category) return 'Page';
  if (record.amountUSD !== undefined) return record.recordType === 'receipt' ? 'Receipt' : 'Ad';
  return 'Record';
}

// ==========================================
// AUDIT LOGGING
// ==========================================

function redactSensitive(obj, depth = 0) {
  if (depth > 12) return null;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(x => redactSensitive(x, depth + 1));

  const SENSITIVE_KEYS = new Set([
    'password',
    'passwordHash',
    'salt',
    'passwordAlgo',
    'passwordIterations',
    'token',
    'tokenHash',
    'recoveryKey',
    'localRecovery'
  ]);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    out[k] = redactSensitive(v, depth + 1);
  }
  return out;
}

function addAuditLog(action, resourceId, description, metadata = {}) {
  // Determine severity level based on action type
  const severityMap = {
    'create': 'info',
    'update': 'info',
    'delete': 'warning',
    'Login': 'info',
    'Logout': 'info',
    'transfer': 'warning',
    'stop': 'warning',
    'receipt': 'info',
    'error': 'error',
    'security': 'critical'
  };
  
  // Determine category based on action and metadata
  const categoryMap = {
    'create': 'data',
    'update': 'data',
    'delete': 'data',
    'Login': 'auth',
    'Logout': 'auth',
    'transfer': 'financial',
    'stop': 'financial',
    'receipt': 'financial'
  };
  
  const redacted = redactSensitive(metadata);
  const safeMetadata = (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) ? redacted : {};
  const log = {
    id: generateId('log'),
    date: new Date().toISOString(),
    userId: state.currentUser?.id || 'system',
    userName: state.currentUser?.name || 'System',
    action,
    resourceId,
    resourceType: metadata.resourceType || 'Mixed',
    category: categoryMap[action] || 'general',
    severity: severityMap[action] || 'info',
    description,
    metadata: {
      browser: navigator.userAgent,
      ip: 'local',
      sessionId: state.sessionId || generateId('session'),
      ...safeMetadata
    },
    _lastModified: getMonotonicTime(),
    _deleted: false,
    _archived: false
  };
  
  // Add to beginning of logs array (newest first)
  state.logs.unshift(log);
  
  // Initialize session ID if not exists
  if (!state.sessionId) {
    state.sessionId = generateId('session');
  }
  
  // Save to IndexedDB for persistent storage (async, fire-and-forget)
  if (db) {
    saveLogToIndexedDB(log).catch(e => console.warn('IndexedDB save failed:', e));
  }
  
  saveState();
}

// Lightweight logging helper used across feature codepaths
// action: 'create' | 'update' | 'delete' | etc.
// resourceType: e.g., 'receipt', 'page'
// resourceId: the id of the entity being logged
// description: human-readable description
function addLog(action, resourceType, resourceId, description, metadata = {}) {
  addAuditLog(action, resourceId, description, { resourceType, ...metadata });
}

function isCurrentUserAdmin() {
  return (state.currentUser?.role || '').toLowerCase() === 'admin';
}

// "Secret ideas" gating (UI only). Non-admin users are kept inside Albayan Manager for now.
const PLATFORM_ADMIN_ONLY_VIEWS = new Set(['services-hub', 'smart-systems', 'service-placeholder', 'wallet']);

// View -> permission module mapping (used for landing + access checks)
const VIEW_PERMISSION_MODULES = {
  analytics: 'analytics',
  customers: 'customers',
  receipts: 'receipts',
  pages: 'pages',
  ads: 'ads',
  deliveries: 'deliveries',
  reconciliation: 'analytics',
  users: 'users',
  audit: 'auditLogs',
  settings: 'settings'
};

const ALBAYAN_MANAGER_VIEW_ORDER = [
  'analytics',
  'customers',
  'receipts',
  'pages',
  'ads',
  'deliveries',
  'reconciliation',
  'audit',
  'settings',
  'users'
];

function userCanAccessView(user, view) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  const moduleKey = VIEW_PERMISSION_MODULES[String(view || '')];
  if (!moduleKey) return false;
  const perms = user.permissions || {};
  const actions = perms[moduleKey];
  if (!Array.isArray(actions)) return false;
  return actions.includes('view') || actions.includes('viewOwn');
}

function getAlbayanManagerLandingViewForUser(user) {
  const role = String(user?.role || '');
  if (isDeliveryRole(role)) return 'delivery-dashboard';
  // Pick the first view they are allowed to open
  for (const view of ALBAYAN_MANAGER_VIEW_ORDER) {
    if (userCanAccessView(user, view)) return view;
  }
  return 'no-access';
}

function getPostLoginLandingViewForUser(user) {
  const roleLower = String(user?.role || '').toLowerCase();
  if (roleLower === 'admin') return 'services-hub';
  return getAlbayanManagerLandingViewForUser(user);
}

function enforceSecretFeaturesGate() {
  // If not logged in, no gating needed.
  if (!state.currentUser) return;
  // Admin can access everything.
  if (isCurrentUserAdmin()) return;
  // Non-admin: block secret platform views.
  if (PLATFORM_ADMIN_ONLY_VIEWS.has(String(state.currentView || ''))) {
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.viewData = null;
    saveState();
    return;
  }
  // Also check if user has permission for the current Albayan Manager view
  const view = String(state.currentView || '');
  if (view && view !== 'delivery-dashboard' && view !== 'no-access' && !userCanAccessView(state.currentUser, view)) {
    // User doesn't have permission for this view, find first allowed view
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.viewData = null;
    saveState();
  }
}

// ==========================================
// RECEIPT USAGE / TRANSFER HELPERS
// ==========================================

// Compute usage stats for a receipt based on ads funded by this receipt
function getReceiptUsageStats(receipt) {
  // Handle both receipt object and receipt ID
  const receiptObj = typeof receipt === 'string'
    ? (state.receipts || []).find(r => r.id === receipt)
    : receipt;

  if (!receiptObj) {
    return {
      usedUSD: 0,
      transferredUSD: 0,
      remainingUSD: 0,
      linkedAds: 0,
      fundedAds: [],
      lastUsedAt: null,
      usageStatus: 'Unknown'
    };
  }

  // Use consistent ID for all comparisons
  const receiptId = String(receiptObj.id || '');

  // Ads that reference this receipt as a funding source
  // Include both regular receiptAllocations AND dueAllocations (for delivery receipts that became Paid)
  const fundedAds = getVisibleRecords(state.ads || []).filter(
    ad => ad.recordType !== 'receipt' && (
      String(ad.fundingReceiptId || '') === receiptId ||
      String(ad.receiptId || '') === receiptId ||
      (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
      (Array.isArray(ad.dueAllocations) && ad.dueAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
      String(ad.linkedDeliveryReceiptId || '') === receiptId
    )
  );

  // Calculate used amount from both receiptAllocations and dueAllocations
  // When a delivery receipt is marked Delivered, ads that used its due amount via dueAllocations
  // should still count as using the receipt's funds
  const usedUSD = fundedAds.reduce((sum, ad) => {
    // Check receiptAllocations first (normal paid receipt usage)
    const receiptAllocSum = Array.isArray(ad.receiptAllocations)
      ? ad.receiptAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Check dueAllocations (delivery receipt due amount usage - critical for when receipt becomes Paid)
    const dueAllocSum = Array.isArray(ad.dueAllocations)
      ? ad.dueAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Legacy: check linkedDeliveryReceiptId with dueAmountToUseUSD
    let legacyDueUsage = 0;
    if (String(ad.linkedDeliveryReceiptId || '') === receiptId && dueAllocSum === 0) {
      legacyDueUsage = parseFloat(ad.dueAmountToUseUSD) || 0;
    }

    // Use explicit allocations if available, otherwise fall back to ad spend
    const explicitAllocations = receiptAllocSum + dueAllocSum + legacyDueUsage;
    if (explicitAllocations > 0) {
      return sum + explicitAllocations;
    }

    // MONEY-MATH: fall back to spentUSD/amountUSD ONLY when the ad carries no
    // allocation data at all (legacy records that predate allocations). If the
    // ad HAS allocation entries — they just point at OTHER receipts — then a
    // zero sum for THIS receipt means this receipt funded nothing; charging the
    // full ad spend here would count the same dollars on two receipts at once
    // (e.g. a delivery ad matched via linkedDeliveryReceiptId but funded
    // entirely from a merged paid receipt).
    const hasAllocationData =
      (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0) ||
      (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0);
    if (hasAllocationData) {
      return sum;
    }

    // Fall back to spentUSD or amountUSD only if no explicit allocations
    const spend = ad.spentUSD ?? ad.amountUSD ?? 0;
    return sum + spend;
  }, 0);

  const transfers = receiptObj.transfers || [];
  const transferredUSD = transfers.reduce((sum, t) => sum + (t.amountUSD || 0), 0);

  const totalUSD = receiptObj.amountUSD || 0;
  const remainingUSD = Math.max(totalUSD - usedUSD - transferredUSD, 0);

  const lastUsedAt = fundedAds.length > 0
    ? new Date(Math.max(...fundedAds.map(ad => new Date(ad.endDate || ad.startDate || ad.createdAt || 0).getTime())))
    : null;

  let usageStatus = 'Unused';
  if (usedUSD > 0 && remainingUSD > 0) usageStatus = 'Partially Used';
  if (remainingUSD <= 0 && totalUSD > 0) usageStatus = 'Fully Used';

  return {
    fundedAds,
    usedUSD,
    transferredUSD,
    remainingUSD,
    totalUSD,
    usageStatus,
    lastUsedAt
  };
}

// Compute usage stats for a DELIVERY receipt's due amount (Not Paid receipts)
// This tracks how much of the debt/due amount has been used by ads linking to this receipt
function getDeliveryReceiptDueUsage(receipt) {
  const receiptObj = typeof receipt === 'string'
    ? (state.receipts || []).find(r => r.id === receipt)
    : receipt;

  if (!receiptObj) {
    return { totalDueUSD: 0, usedDueUSD: 0, remainingDueUSD: 0, fundedAds: [] };
  }

  const receiptId = String(receiptObj.id || '');

  // Total due amount in USD (convert from LYD using receipt's exchange rate)
  const exchangeRate = receiptObj.exchangeRate || state.defaultExchangeRate || 1;
  const dueAmountLocal = Number(receiptObj.debtAmountLocal ?? receiptObj.amountLocal ?? 0) || 0;
  const totalDueUSD = exchangeRate > 0 ? dueAmountLocal / exchangeRate : 0;

  // Find all ads that use this delivery receipt's due amount
  const fundedAds = getVisibleRecords(state.ads || []).filter(ad => {
    if (ad._deleted || ad.recordType === 'receipt') return false;
    // Check if ad has dueAllocations pointing to this receipt
    if (Array.isArray(ad.dueAllocations)) {
      return ad.dueAllocations.some(a => String(a.receiptId || '') === receiptId);
    }
    // Legacy: check linkedDeliveryReceiptId
    return String(ad.linkedDeliveryReceiptId || '') === receiptId && (ad.dueAmountToUseUSD > 0 || ad.dueAmountToUseLYD > 0);
  });
  
  // Calculate total used from due
  const usedDueUSD = fundedAds.reduce((sum, ad) => {
    // First check dueAllocations (new system)
    if (Array.isArray(ad.dueAllocations)) {
      const allocSum = ad.dueAllocations
        .filter(a => String(a.receiptId || '') === receiptId)
        .reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0);
      if (allocSum > 0) return sum + allocSum;
    }
    // Legacy: check dueAmountToUseUSD or convert from LYD
    if (String(ad.linkedDeliveryReceiptId || '') === receiptId) {
      if (ad.dueAmountToUseUSD > 0) return sum + ad.dueAmountToUseUSD;
      if (ad.dueAmountToUseLYD > 0) {
        const adExRate = ad.exchangeRate || exchangeRate || 1;
        return sum + (ad.dueAmountToUseLYD / adExRate);
      }
    }
    return sum;
  }, 0);
  
  const remainingDueUSD = Math.max(totalDueUSD - usedDueUSD, 0);
  
  return {
    totalDueUSD,
    usedDueUSD,
    remainingDueUSD,
    fundedAds,
    exchangeRate
  };
}

function formatDateShort(date) {
  if (!date) return 'Never';
  try {
    return new Date(date).toLocaleString();
  } catch (e) {
    return 'Never';
  }
}

/**
 * Get the effective exchange rate for an ad.
 * Priority order:
 * 1. Linked delivery receipt's exchange rate (if ad is linked to delivery receipt)
 * 2. Weighted average from receipt allocations (if ad has multiple funding receipts)
 * 3. Single funding receipt's exchange rate
 * 4. Ad's own exchange rate
 * 5. Default exchange rate from state
 *
 * This ensures consistent exchange rate calculations across the application.
 */
function getEffectiveExchangeRate(ad) {
  if (!ad) return state.defaultExchangeRate || 1;

  // 1. For delivery-linked ads, use the linked receipt's rate
  if (ad.linkedDeliveryReceiptId) {
    const linkedReceipt = state.receipts.find(r => r.id === ad.linkedDeliveryReceiptId);
    if (linkedReceipt?.exchangeRate) {
      return linkedReceipt.exchangeRate;
    }
  }

  // 2. Weighted average from receipt allocations (based on amount allocated)
  if (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0) {
    let totalAmount = 0;
    let weightedSum = 0;

    for (const alloc of ad.receiptAllocations) {
      const receipt = state.receipts.find(r => r.id === alloc.receiptId);
      const amount = parseFloat(alloc.amountUSD) || 0;
      const rate = receipt?.exchangeRate;

      if (rate && amount > 0) {
        weightedSum += rate * amount;
        totalAmount += amount;
      }
    }

    if (totalAmount > 0) {
      return weightedSum / totalAmount;
    }
  }

  // 3. Also check dueAllocations for delivery receipt funding
  if (Array.isArray(ad.dueAllocations) && ad.dueAllocations.length > 0) {
    let totalAmount = 0;
    let weightedSum = 0;

    for (const alloc of ad.dueAllocations) {
      const receipt = state.receipts.find(r => r.id === alloc.receiptId);
      const amount = parseFloat(alloc.amountUSD) || 0;
      const rate = receipt?.exchangeRate;

      if (rate && amount > 0) {
        weightedSum += rate * amount;
        totalAmount += amount;
      }
    }

    if (totalAmount > 0) {
      return weightedSum / totalAmount;
    }
  }

  // 4. Single funding receipt
  if (ad.fundingReceiptId) {
    const receipt = state.receipts.find(r => r.id === ad.fundingReceiptId);
    if (receipt?.exchangeRate) return receipt.exchangeRate;
  }

  // 5. Legacy receiptId field
  if (ad.receiptId) {
    const receipt = state.receipts.find(r => r.id === ad.receiptId);
    if (receipt?.exchangeRate) return receipt.exchangeRate;
  }

  // 6. Ad's own exchange rate
  if (ad.exchangeRate) return ad.exchangeRate;

  // 7. Fall back to default
  return state.defaultExchangeRate || 1;
}

