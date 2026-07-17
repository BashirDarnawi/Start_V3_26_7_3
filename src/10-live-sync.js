// ==========================================
// LIVE SERVER SYNC (Always‑Online Multi‑User Mode)
// ==========================================

const _serverLiveSync = {
  timer: null,
  inFlight: false,
  cursor: 0,
  lastUsersSyncAt: 0,
  startedForUserId: null,
  // Signature of the last delivery-role payload, so identical polls don't
  // force a full re-render every 3s (which snapped dropdowns shut on phones).
  lastDeliverySig: null,
  // Highest _lastModified ever seen in an ACTUAL server response. The delta
  // cursor is seeded/re-seeded from this, never from client-written _lastModified
  // values — otherwise a device whose clock runs fast would seed the cursor
  // minutes ahead of server time and silently skip everyone else's updates
  // (the server's updated_since window only looks back 15s).
  serverWatermark: 0,
  fullLoadCursorReady: false,
  collectionCursors: Object.create(null),
  serviceEntitlements: null,
  // Authentication identity and poller lifecycle are deliberately separate.
  // sessionEpoch changes only when the authenticated session changes; it is
  // part of getServerSessionIdentity(), so late full-load/cache responses are
  // rejected. pollerEpoch changes whenever polling is stopped/restarted, so a
  // late tick is discarded without invalidating an unrelated full load.
  sessionEpoch: 0,
  pollerEpoch: 0
};

function advanceServerSessionEpoch() {
  _serverLiveSync.sessionEpoch = (_serverLiveSync.sessionEpoch || 0) + 1;
  _serverLiveSync.serverWatermark = 0;
  _serverLiveSync.cursor = 0;
  _serverLiveSync.fullLoadCursorReady = false;
  _serverLiveSync.collectionCursors = Object.create(null);
  _serverLiveSync.serviceEntitlements = null;
  if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache('adCampaignRequests');
  _serverLiveSync.lastDeliverySig = null;
}

const SERVER_SERVICE_ENTITLEMENT_COLLECTIONS = Object.freeze({
  ad_maker: Object.freeze(['adCampaignRequests']),
  clothes_system: Object.freeze(['clothesProducts', 'clothesShipments', 'clothesOrders', 'clothesSettings'])
});
const SERVER_MEDIA_BEARING_COLLECTIONS = new Set(['ads', 'receipts', 'adCampaignRequests', 'clothesProducts']);

function getServerServiceEntitlementSnapshot(user = state.currentUser, subscriptions = state.serviceSubscriptions, nowMs = Date.now()) {
  const uid = String(user?.id || '');
  const rows = Array.isArray(subscriptions) ? subscriptions : [];
  const snapshot = Object.create(null);
  for (const serviceId of Object.keys(SERVER_SERVICE_ENTITLEMENT_COLLECTIONS)) {
    snapshot[serviceId] = !!uid && rows.some(row => row && !row._deleted &&
      String(row.userId || '') === uid && String(row.serviceId || '') === serviceId &&
      String(row.status || '') === 'active' &&
      (!row.expiresAt || new Date(row.expiresAt).getTime() > nowMs));
  }
  return snapshot;
}

function getRevokedServerServiceEntitlements(before, after) {
  return Object.keys(SERVER_SERVICE_ENTITLEMENT_COLLECTIONS)
    .filter(serviceId => before?.[serviceId] === true && after?.[serviceId] !== true);
}

function getServerCollectionCursor(collection) {
  const cursors = _serverLiveSync.collectionCursors;
  if (!cursors || typeof cursors !== 'object') return 0;
  const value = Number(cursors[String(collection || '')]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function _maxLastModifiedFromArray(arr) {
  if (!Array.isArray(arr)) return 0;
  let max = 0;
  for (const r of arr) {
    const v = Number(r?._lastModified);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function computeServerCursorFromState() {
  return Math.max(
    _maxLastModifiedFromArray(state.ads),
    _maxLastModifiedFromArray(state.receipts),
    _maxLastModifiedFromArray(state.customers),
    _maxLastModifiedFromArray(state.pages),
    _maxLastModifiedFromArray(state.exchangeRateHistory),
    _maxLastModifiedFromArray(state.clothesProducts),
    _maxLastModifiedFromArray(state.clothesShipments),
    _maxLastModifiedFromArray(state.clothesOrders),
    _maxLastModifiedFromArray(state.clothesSettings),
    _maxLastModifiedFromArray(state.adCampaignRequests),
    _maxLastModifiedFromArray(state.walletTransactions),
    _maxLastModifiedFromArray(state.serviceSubscriptions)
  );
}

function getServerCollectionVisibilityScope(user, collection) {
  if (!user?.id) return 'none';
  const name = String(collection || '');
  const role = String(user.role || '').toLowerCase();
  if (name === 'exchangeRateHistory') return 'all';
  if (name === 'walletTransactions' || name === 'serviceSubscriptions') {
    return role === 'admin' ? 'all' : 'own';
  }
  if (role === 'admin') return 'all';
  if (role === 'delivery' && ['ads', 'receipts', 'customers'].includes(name)) return 'assigned';
  const modulePermissions = user.permissions?.[name];
  if (!Array.isArray(modulePermissions)) return 'none';
  // Review access is deliberately narrower than ordinary view-all access: the
  // server omits unfinished customer drafts. Keeping this scope distinct also
  // forces cache/IndexedDB purge when an employee changes from view to review.
  if (name === 'adCampaignRequests' && modulePermissions.some(action => String(action).toLowerCase() === 'review')) return 'review';
  if (modulePermissions.some(action => String(action).toLowerCase() === 'view')) return 'all';
  if (modulePermissions.some(action => String(action).toLowerCase() === 'viewown')) return 'own';
  return 'none';
}

function getServerVisibilityScopeChanges(beforeUser, afterUser) {
  return SERVER_SYNC_COLLECTIONS.filter(collection =>
    getServerCollectionVisibilityScope(beforeUser, collection) !==
    getServerCollectionVisibilityScope(afterUser, collection)
  );
}

function getAuthorizedServerSyncCollections(user = state.currentUser) {
  return SERVER_SYNC_COLLECTIONS.filter(collection => {
    if (getServerCollectionVisibilityScope(user, collection) === 'none') return false;
    if (collection.startsWith('clothes') && !isAdminRole(user?.role)) {
      return hasSubscription('clothes_system');
    }
    if (collection === 'adCampaignRequests' && !isAdminRole(user?.role)) {
      const isReviewer = Array.isArray(user?.permissions?.adCampaignRequests) &&
        user.permissions.adCampaignRequests.some(action => String(action).toLowerCase() === 'review');
      return isReviewer || hasSubscription('ad_maker');
    }
    return true;
  });
}

// Remove data the current authorization scope may no longer expose. Clearing
// only the in-memory array is insufficient: a reload would rehydrate the old
// broader result from IndexedDB, and the five-second request cache could do the
// same without a page reload.
async function clearServerCollectionsForVisibility(collections) {
  const identity = getServerSessionIdentity();
  const names = Array.from(new Set((collections || []).map(String)))
    .filter(name => SERVER_SYNC_COLLECTIONS.includes(name));
  if (names.length === 0) return false;
  // Body-mounted viewers outlive the view HTML. Close them synchronously before
  // any media-bearing collection is purged or an old photo can remain visible.
  if (names.some(name => SERVER_MEDIA_BEARING_COLLECTIONS.has(name)) && typeof closeReceiptPhotoViewer === 'function') {
    closeReceiptPhotoViewer(false);
  }
  if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache(names);
  for (const name of names) {
    if (serverSessionIdentityChanged(identity)) return false;
    state[name] = [];
    if (_collectionCache[name]) {
      _collectionCache[name] = { data: null, timestamp: 0, identity: '' };
    }
    if (_serverLiveSync.collectionCursors && typeof _serverLiveSync.collectionCursors === 'object') {
      _serverLiveSync.collectionCursors[name] = 0;
    }
    if (typeof clearCollectionCorruption === 'function') clearCollectionCorruption(name);
    if (db) {
      const cleared = await saveCollectionToIndexedDB(name, []);
      if (serverSessionIdentityChanged(identity)) return false;
      if (cleared === false) markCollectionDirty(name);
      else if (typeof idbSync === 'object' && idbSync?.dirty) idbSync.dirty.delete(name);
    }
  }
  if (serverSessionIdentityChanged(identity)) return false;
  _serverLiveSync.cursor = Math.max(0, ...Object.values(_serverLiveSync.collectionCursors || {}).map(Number).filter(Number.isFinite));
  _serverLiveSync.serverWatermark = _serverLiveSync.cursor;
  saveState();
  return true;
}

async function apiLoadCollectionSince(collection, sinceMs) {
  const all = [];
  const indexById = new Map();
  let afterLastModified = null;
  let afterId = '';
  const limit = Math.min(1000, SERVER_API.pageSize || 1000);
  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  while (true) {
    let path = `/api/collections/${encodeURIComponent(collection)}?updated_since=${encodeURIComponent(String(since))}&limit=${limit}&include_deleted=true`;
    if (LIGHTWEIGHT_MEDIA_COLLECTIONS.has(String(collection || ''))) path += '&include_media=false';
    if (afterLastModified !== null && afterId) {
      path += `&after_last_modified=${encodeURIComponent(String(afterLastModified))}&after_id=${encodeURIComponent(afterId)}`;
    }
    // Use retry logic for resilience against transient server errors/timeouts
    const items = await withRetry(
      () => apiJson(
      path,
      { method: 'GET' },
      { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }
      ),
      2, // 2 retries for delta sync (less aggressive than full load)
      500 // 500ms base delay
    );
    if (!Array.isArray(items) || items.length === 0) break;
    let lastEntity = null;
    for (const rawEntity of items) {
      const entity = validateServerEntityResponse(collection, rawEntity, `delta[${all.length}]`);
      if (String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord(collection, entity.data);
      lastEntity = entity;
      mergeServerEntityDataById(all, indexById, entity);
    }
    if (items.length < limit) break;
    const nextLastModified = Number(lastEntity?.lastModified);
    const nextId = String(lastEntity?.id || '');
    if (!Number.isSafeInteger(nextLastModified) || nextLastModified < 0 || !Security.isValidRecordId(nextId)) {
      const cursorError = new Error(`Invalid ${collection} delta cursor`);
      cursorError.code = 'INCOMPLETE_COLLECTION_LOAD';
      throw cursorError;
    }
    if (nextLastModified === afterLastModified && nextId === afterId) {
      const cursorError = new Error(`Repeated ${collection} delta cursor`);
      cursorError.code = 'INCOMPLETE_COLLECTION_LOAD';
      throw cursorError;
    }
    afterLastModified = nextLastModified;
    afterId = nextId;
  }
  return all;
}

// Cheap change-detection fingerprint for a fetched collection. Only reads each
// record's id and _lastModified (tiny), never the heavy base64 photo fields, so
// it is orders of magnitude cheaper than JSON.stringify of the full payload.
function _cheapSyncSig(arr) {
  if (!Array.isArray(arr)) return 'n';
  let h = 0;
  let maxLM = 0;
  for (const r of arr) {
    const id = String((r && r.id) || '');
    const lm = Number((r && r._lastModified) || 0) | 0;
    if (lm > maxLM) maxLM = lm;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    h = ((h << 5) - h + lm) | 0;
  }
  return arr.length + ':' + maxLM + ':' + (h >>> 0);
}

function _deltaRecordVersion(record) {
  if (!record || record._lastModified == null || record._lastModified === '') return null;
  const version = Number(record._lastModified);
  return Number.isFinite(version) ? version : null;
}

// The server deliberately overlaps each delta window so an update cannot be
// missed at a cursor boundary. Most records in a poll are therefore exact
// replays of records already in memory. Replace an existing object only for a
// newer server revision (or the equal-revision deletion tie handled below);
// preserving object identity for normal equal/stale replays also prevents a
// needless whole-view render every 3s.
function _shouldApplyDeltaRecord(incoming, current) {
  const incomingVersion = _deltaRecordVersion(incoming);
  const currentVersion = _deltaRecordVersion(current);

  if (incomingVersion !== null && currentVersion !== null) {
    if (incomingVersion > currentVersion) return true;
    if (incomingVersion < currentVersion) return false;

    // A generic server delete can land in the same millisecond as the write it
    // deletes. In that tie, deletion must win or the active row can survive on
    // this client forever. Replayed tombstones remain no-ops, and an equal-
    // version active record can never resurrect a tombstone.
    return incoming._deleted === true && current?._deleted !== true;
  }
  if (incomingVersion !== null) return true;
  if (currentVersion !== null) return false;

  // Legacy/offline records may predate server revision stamps. Keep supporting
  // them without reporting an identical replay as a change.
  try {
    return JSON.stringify(incoming) !== JSON.stringify(current);
  } catch (_) {
    return true;
  }
}

function applyServerDelta(collectionName, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  if (!Array.isArray(state[collectionName])) state[collectionName] = [];
  const arr = state[collectionName];

  // PERFORMANCE: build id->index ONCE. The old code did arr.findIndex per
  // incoming record (O(delta × collection)) plus an O(n) arr.unshift per new
  // record, so a large catch-up delta (tab hidden overnight / cursor frozen on
  // failures) froze the UI for hundreds of ms. This is O(delta + collection).
  const byId = new Map();
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x && x.id != null) byId.set(x.id, i);
  }

  const newOnes = [];         // staged new records (in delta order)
  const newById = new Map();  // id -> index in newOnes (dedup within this delta)
  let changed = false;

  for (const rec of records) {
    if (!rec || !rec.id) continue;
    const existingIndex = byId.get(rec.id);
    const existing = existingIndex !== undefined ? arr[existingIndex] : null;
    const prepared = mergeMatchingVersionInlineMedia(collectionName, rec, existing);
    const clean = Security.sanitizeObject(prepared);
    const idx = byId.get(clean.id);
    if (idx !== undefined) {
      if (!_shouldApplyDeltaRecord(clean, arr[idx])) continue;
      arr[idx] = clean;                       // update existing in place
      changed = true;
    } else if (newById.has(clean.id)) {
      const stagedIndex = newById.get(clean.id);
      if (!_shouldApplyDeltaRecord(clean, newOnes[stagedIndex])) continue;
      newOnes[stagedIndex] = clean;           // duplicate id -> keep newest revision
      changed = true;
    } else {
      newById.set(clean.id, newOnes.length);
      newOnes.push(clean);
      changed = true;
    }
  }

  // Prepend new records once. Reverse to preserve the previous behavior where
  // per-record unshift left the last delta record at the very front.
  if (newOnes.length) {
    newOnes.reverse();
    arr.unshift(...newOnes);
  }
  return changed;
}

// Customer page spending and the delivery WhatsApp preview are body-mounted
// dialogs rather than children of #app. A normal view render cannot update or
// remove them, so any authoritative state replacement must close them before
// stale financial/contact data can remain visible. Never restore focus here:
// the original card/button may already have been replaced by sync or logout.
function _closeCustomerPagesDialogForStateChange() {
  let closed = false;
  const shareDialog = document.getElementById('delivery-whatsapp-share-dialog');
  if (shareDialog) {
    try {
      if (typeof closeDeliveryWhatsAppPrompt === 'function') closeDeliveryWhatsAppPrompt(false);
      else shareDialog.remove();
    } catch (_) { shareDialog.remove(); }
    closed = true;
  }
  const dialog = document.getElementById('customer-pages-dialog');
  if (!dialog) return closed;
  try {
    if (typeof closeCustomerPagesDialog === 'function') {
      closeCustomerPagesDialog(false);
      return true;
    }
  } catch (_) {}
  dialog.remove();
  return true;
}

async function serverLiveSyncOnce() {
  if (!isServerModeEnabled()) return { ok: false, skipped: true };
  if (!state.currentUser) return { ok: false, skipped: true };
  if (!SERVER_API.liveSyncEnabled) return { ok: false, skipped: true };
  if (document.visibilityState === 'hidden') return { ok: true, skipped: true };

  // Snapshot the session epoch. After any await we bail if the user logged out
  // (epoch bumped / currentUser cleared) so a late response can't resurrect the
  // wiped state — the "logout wipe undone by an in-flight sync" bug.
  const _sessionEpoch = _serverLiveSync.sessionEpoch;
  const _pollerEpoch = _serverLiveSync.pollerEpoch;
  const _syncAborted = () => (
    !state.currentUser ||
    _serverLiveSync.sessionEpoch !== _sessionEpoch ||
    _serverLiveSync.pollerEpoch !== _pollerEpoch
  );

  const roleLower = String(state.currentUser.role || '').toLowerCase();

  // Delivery users: do a small "replace" sync of only assigned deliveries + linked customers.
  // This guarantees removals (unassigned items) disappear without needing manual refresh.
  if (roleLower === 'delivery') {
    const safeAll = async (collection) => {
      try {
        return await apiLoadCollectionAll(collection);
      } catch (e) {
        // Network errors during sync - don't break the app, just return null
        if (ALBAYAN_DEBUG_MODE) console.warn(`[safeAll] Failed to load ${collection}:`, e?.message || e);
        return null;
      }
    };

    const [ads, receipts, customers] = await Promise.all([
      safeAll('ads'),
      safeAll('receipts'),
      safeAll('customers')
    ]);

    // Bail if the user logged out while these were in flight (see _syncAborted).
    if (_syncAborted()) return { ok: false, skipped: true };
    const deliveryFetchFailed = !Array.isArray(ads) || !Array.isArray(receipts) || !Array.isArray(customers);

    // Only treat the tick as "changed" when the fetched payload actually
    // differs from the previous one. Comparing against state would always
    // differ (migrateOldDataFormats mutates state records in place), so
    // compare the raw fetched arrays via a signature.
    // PERFORMANCE: use a CHEAP fingerprint (count + max/rolling-hash of
    // id+_lastModified) instead of JSON.stringify of the whole payload. The
    // full payload carries receiptImage base64 (~50-200KB each), so stringifying
    // it every 3s serialized tens of MB and stalled the main thread even when
    // nothing changed. Additions/removals change the count+hash; any edit bumps
    // _lastModified, so this detects every real change without touching photos.
    let sig = null;
    try {
      sig = _cheapSyncSig(ads) + '|' + _cheapSyncSig(receipts) + '|' + _cheapSyncSig(customers);
    } catch (_) {}
    const changed = (sig === null) || sig !== _serverLiveSync.lastDeliverySig;
    if (changed) {
      if (Array.isArray(ads)) state.ads = ads;
      if (Array.isArray(receipts)) state.receipts = receipts;
      if (Array.isArray(customers)) state.customers = customers;
      if (sig !== null) _serverLiveSync.lastDeliverySig = sig;
    }
    
    // Ensure data migration on live sync (only if data changed, and debounced)
    if (changed) {
      // Run migration in background (don't block render)
      setTimeout(() => {
        migrateOldDataFormats();
        assignSequentialNumbers(false); // Use cache if available
      }, 100);
    }

    const nextCursor = computeServerCursorFromState();
    _serverLiveSync.cursor = Math.max(_serverLiveSync.cursor || 0, nextCursor);
    if (deliveryFetchFailed) state.serverLastSyncErrorAt = new Date().toISOString();
    else {
      state.serverLastSyncAt = new Date().toISOString();
      state.serverLastSyncErrorAt = null;
    }
    // Always re-render when data changed (not just cursor) - ensures edits from admin show immediately.
    // The delivery replacement includes ads/customers, so an open customer-page
    // summary would otherwise keep showing the pre-sync snapshot above the new view.
    if (changed) {
      _closeCustomerPagesDialogForStateChange();
      RenderQueue.schedule('liveSync(delivery)');
    }
    return { ok: !deliveryFetchFailed };
  }

  // Admin/Employee: each collection owns its cursor. A single shared cursor is
  // unsafe because requests are not one database snapshot: a newer ad could
  // otherwise advance past an older receipt update that arrived just after
  // the receipts request finished.
  // Do not hammer forbidden/unsubscribed endpoints every three seconds. A
  // permission or subscription refresh changes this list on the next tick,
  // whose zero cursor then performs a complete catch-up for the newly granted
  // collection.
  const deltaCollections = getAuthorizedServerSyncCollections();
  const entitlementBefore = _serverLiveSync.serviceEntitlements || getServerServiceEntitlementSnapshot();
  if (!_serverLiveSync.collectionCursors || typeof _serverLiveSync.collectionCursors !== 'object') {
    _serverLiveSync.collectionCursors = Object.create(null);
  }
  let anyFetchFailed = false;
  const safeSince = async (collection) => {
    const since = getServerCollectionCursor(collection);
    try {
      const records = await apiLoadCollectionSince(collection, since);
      return { collection, since, records, ok: true, forbidden: false };
    } catch (e) {
      // Keep forbidden collections at cursor zero. If permission is granted
      // later, the next tick obtains the full newly-visible history.
      if (e?.status === 403) {
        _serverLiveSync.collectionCursors[collection] = 0;
        return { collection, since, records: [], ok: true, forbidden: true };
      }
      anyFetchFailed = true;
      return { collection, since, records: [], ok: false, forbidden: false };
    }
  };
  const deltaResults = await Promise.all(deltaCollections.map(safeSince));
  const deltaByCollection = new Map(deltaResults.map(result => [result.collection, result]));
  const recordsFor = (name) => deltaByCollection.get(name)?.records || [];
  const adsDelta = recordsFor('ads');
  const receiptsDelta = recordsFor('receipts');
  const customersDelta = recordsFor('customers');
  const pagesDelta = recordsFor('pages');
  const exhDelta = recordsFor('exchangeRateHistory');
  const clothesProductsDelta = recordsFor('clothesProducts');
  const clothesShipmentsDelta = recordsFor('clothesShipments');
  const clothesOrdersDelta = recordsFor('clothesOrders');
  const clothesSettingsDelta = recordsFor('clothesSettings');
  const adCampaignRequestsDelta = recordsFor('adCampaignRequests');
  const walletTxDelta = recordsFor('walletTransactions');
  const subsDelta = recordsFor('serviceSubscriptions');

  // Logged out (or a new session started) while these fetches were in flight?
  // Drop the result — applying it would re-fill the just-wiped state.
  if (_syncAborted()) return { ok: false, skipped: true };

  // A 403 is an authorization result, not merely an empty delta. Purge the old
  // broader collection from memory, request cache and this user's IndexedDB
  // namespace before anything can render it again.
  const forbiddenCollections = deltaResults.filter(result => result.forbidden).map(result => result.collection);
  const customerPageForbidden = forbiddenCollections.some(name =>
    name === 'ads' || name === 'receipts' || name === 'customers' || name === 'pages' || name === 'exchangeRateHistory'
  );
  // A 403 means access is already revoked. Close the financial snapshot before
  // awaiting cache/IndexedDB cleanup so slow storage cannot prolong exposure.
  if (customerPageForbidden) _closeCustomerPagesDialogForStateChange();
  if (forbiddenCollections.length > 0) {
    await clearServerCollectionsForVisibility(forbiddenCollections);
    if (_syncAborted()) return { ok: false, skipped: true };
  }

  let changed = forbiddenCollections.length > 0;
  let customerPagesDataChanged = customerPageForbidden;
  const adsChanged = applyServerDelta('ads', adsDelta);
  changed = adsChanged || changed;
  const receiptsChanged = applyServerDelta('receipts', receiptsDelta);
  changed = receiptsChanged || changed;
  const customersChanged = applyServerDelta('customers', customersDelta);
  changed = customersChanged || changed;
  const pagesChanged = applyServerDelta('pages', pagesDelta);
  changed = pagesChanged || changed;
  customerPagesDataChanged = adsChanged || receiptsChanged || customersChanged || pagesChanged || customerPagesDataChanged;
  const exchangeRatesChanged = applyServerDelta('exchangeRateHistory', exhDelta);
  changed = exchangeRatesChanged || changed;
  customerPagesDataChanged = exchangeRatesChanged || customerPagesDataChanged;
  changed = applyServerDelta('clothesProducts', clothesProductsDelta) || changed;
  changed = applyServerDelta('clothesShipments', clothesShipmentsDelta) || changed;
  changed = applyServerDelta('clothesOrders', clothesOrdersDelta) || changed;
  changed = applyServerDelta('clothesSettings', clothesSettingsDelta) || changed;
  changed = applyServerDelta('adCampaignRequests', adCampaignRequestsDelta) || changed;
  changed = applyServerDelta('walletTransactions', walletTxDelta) || changed;
  changed = applyServerDelta('serviceSubscriptions', subsDelta) || changed;

  const entitlementAfter = getServerServiceEntitlementSnapshot();
  const revokedServices = getRevokedServerServiceEntitlements(entitlementBefore, entitlementAfter);
  _serverLiveSync.serviceEntitlements = entitlementAfter;
  if (revokedServices.length > 0) {
    const revokedCollections = Array.from(new Set(revokedServices.flatMap(serviceId => SERVER_SERVICE_ENTITLEMENT_COLLECTIONS[serviceId] || [])));
    // Hide body-mounted photos and unfinished Ads Studio form state before the
    // first await. Slow IndexedDB cleanup must never extend revoked access.
    if (revokedServices.includes('ad_maker') && typeof resetAdsStudioSessionState === 'function') resetAdsStudioSessionState();
    await clearServerCollectionsForVisibility(revokedCollections);
    if (_syncAborted()) return { ok: false, skipped: true };
    cancelPendingRequests();
    const scopedReload = await serverLoadAllData();
    if (_syncAborted() || scopedReload?.aborted) return { ok: false, skipped: true };
    _serverLiveSync.serviceEntitlements = getServerServiceEntitlementSnapshot();
    const reloadFailed = Array.isArray(scopedReload?.failed) && scopedReload.failed.length > 0;
    if (reloadFailed) state.serverLastSyncErrorAt = new Date().toISOString();
    else {
      state.serverLastSyncAt = new Date().toISOString();
      state.serverLastSyncErrorAt = null;
    }
    RenderQueue.schedule('liveSync(subscription-revoked)');
    return { ok: !reloadFailed };
  }
  
  // Ensure data migration on live sync (only if data changed, debounced to not block render)
  if (changed) {
    setTimeout(() => {
      migrateOldDataFormats();
      assignSequentialNumbers(false); // Use cache if available
    }, 100);
  }

  // Advance only the collection whose request completed. Failed collections
  // retain their own prior cursor and are retried without blocking others.
  for (const result of deltaResults) {
    if (!result.ok || result.forbidden) continue;
    const maxDelta = _maxLastModifiedFromArray(result.records);
    _serverLiveSync.collectionCursors[result.collection] = Math.max(result.since, maxDelta);
    if (maxDelta > (_serverLiveSync.serverWatermark || 0)) _serverLiveSync.serverWatermark = maxDelta;
  }
  // Compatibility/debug aggregate only; correctness never reads this value.
  _serverLiveSync.cursor = Math.max(0, ...Object.values(_serverLiveSync.collectionCursors).map(Number).filter(Number.isFinite));
  if (anyFetchFailed && typeof updateSyncIndicator === 'function') {
    try { updateSyncIndicator('error'); } catch (_) {}
  }
  // Refresh minimal users list occasionally (for assignment dropdowns)
  const now = Date.now();
  if ((now - (_serverLiveSync.lastUsersSyncAt || 0)) > (SERVER_API.usersSyncIntervalMs || 60000)) {
    _serverLiveSync.lastUsersSyncAt = now;
    try {
      const usersBefore = JSON.stringify(state.users || []);
      const usersList = await apiListUsersForUi();
      if (_syncAborted()) return { ok: false, skipped: true };
      if (Array.isArray(usersList)) {
        const byId = new Map();
        for (const u of usersList) {
          if (u && u.id) byId.set(u.id, u);
        }
        if (state.currentUser?.id) byId.set(state.currentUser.id, { ...byId.get(state.currentUser.id), ...state.currentUser });
        // Records with a debounce-pending server update (admin mid-edit in the
        // Permissions Manager) must keep the LOCAL version — the fetched list
        // may predate the pending PATCH and would silently revert the edits.
        try {
          if (typeof _serverUserUpdate === 'object' && _serverUserUpdate?.pending?.size) {
            for (const uid of _serverUserUpdate.pending.keys()) {
              const local = (state.users || []).find(u => u && String(u.id) === String(uid));
              if (local) byId.set(local.id, local);
            }
          }
        } catch (_) {}
        state.users = Array.from(byId.values());
      }
      // Also refresh current user's permissions (so they don't need to re-login
      // for new permissions). Either change must trigger a re-render — without
      // it, a locked sidebar stays locked even after the data recovers.
      const accessBefore = Security.sanitizeObject(state.currentUser || {});
      const permsChanged = await refreshCurrentUserPermissions();
      if (_syncAborted()) return { ok: false, skipped: true };
      const scopeChanges = permsChanged
        ? getServerVisibilityScopeChanges(accessBefore, state.currentUser)
        : [];
      if (permsChanged) {
        // Access revocation can hide pages, ads, balances, or the customer itself.
        // Close immediately, before cache writes/refetches, so its old authorized
        // snapshot cannot outlive the newly-scoped state even on a slow network.
        _closeCustomerPagesDialogForStateChange();
        customerPagesDataChanged = true;
        // Stop reusing any in-flight/broader snapshot, purge the affected
        // collections, then perform a fresh server-scoped load. A view->viewOwn
        // response has no tombstones for rows that became unauthorized, so
        // merging deltas can never repair this transition safely.
        cancelPendingRequests();
        invalidateUsersListCache();
        // The Admin users list is authorization-scoped too. Keep only the
        // freshly-authenticated caller until /api/users (or /users/public)
        // returns the new scope, and replace its persisted cache immediately.
        state.users = [];
        upsertCurrentUserIntoUsers();
        if (db) {
          const usersCleared = await saveCollectionToIndexedDB('users', state.users);
          if (_syncAborted()) return { ok: false, skipped: true };
          if (usersCleared === false) markCollectionDirty('users');
          else if (typeof idbSync === 'object' && idbSync?.dirty) idbSync.dirty.delete('users');
        }
        await clearServerCollectionsForVisibility(scopeChanges);
        if (_syncAborted()) return { ok: false, skipped: true };
        const scopedReload = await serverLoadAllData();
        if (_syncAborted() || scopedReload?.aborted) return { ok: false, skipped: true };
        if (Array.isArray(scopedReload?.failed) && scopedReload.failed.length > 0) anyFetchFailed = true;
        changed = true;
      }
      if (permsChanged || usersBefore !== JSON.stringify(state.users || [])) {
        changed = true;
      }
    } catch (e) {
      // User list sync failure - non-critical, just log in debug mode
      anyFetchFailed = true;
      state.serverLastSyncErrorAt = new Date().toISOString();
      if (ALBAYAN_DEBUG_MODE) console.warn('[serverLiveSyncOnce] Users sync failed:', e?.message || e);
    }
  }

  if (anyFetchFailed) state.serverLastSyncErrorAt = new Date().toISOString();
  else {
    state.serverLastSyncAt = new Date().toISOString();
    state.serverLastSyncErrorAt = null;
  }
  if (customerPagesDataChanged) _closeCustomerPagesDialogForStateChange();
  if (changed) RenderQueue.schedule('liveSync(delta)');
  return { ok: !anyFetchFailed };
}

async function serverLiveSyncTick() {
  if (_serverLiveSync.inFlight) return;
  _serverLiveSync.inFlight = true;
  updateSyncIndicator('syncing');
  try {
    const result = await serverLiveSyncOnce();
    updateSyncIndicator(result?.ok === false ? 'error' : 'synced');
  } catch (e) {
    console.warn('[serverLiveSyncTick] Sync failed:', e?.message || e);
    updateSyncIndicator('error');
  } finally {
    _serverLiveSync.inFlight = false;
  }
}

// Visual sync indicator
function updateSyncIndicator(status) {
  let indicator = document.getElementById('sync-status-indicator');
  if (!indicator) {
    // Create indicator if it doesn't exist
    indicator = document.createElement('div');
    indicator.id = 'sync-status-indicator';
    indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300';
    document.body.appendChild(indicator);
  }

  switch (status) {
    case 'syncing':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse mr-2"></span>' + (state.language === 'ar' ? 'جارٍ المزامنة...' : 'Syncing...');
      indicator.style.opacity = '1';
      break;
    case 'synced':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-emerald-500 rounded-full mr-2"></span>' + (state.language === 'ar' ? 'تمت المزامنة' : 'Synced');
      // Fade out after 2 seconds
      setTimeout(() => {
        if (indicator) indicator.style.opacity = '0';
      }, 2000);
      break;
    case 'error':
      indicator.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-300 bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300 cursor-pointer';
      indicator.innerHTML = '<span class="inline-block w-2 h-2 bg-rose-500 rounded-full mr-2"></span>' + (state.language === 'ar' ? 'فشلت المزامنة - اضغط لإعادة المحاولة' : 'Sync failed - Tap to retry');
      indicator.style.opacity = '1';
      indicator.onclick = () => manualSyncData();
      break;
  }
}

// Manual sync function for users
async function manualSyncData() {
  if (!isServerModeEnabled()) {
    showNotification(state.language === 'ar' ? 'وضع عدم الاتصال' : 'Offline Mode', state.language === 'ar' ? 'غير متصل بالسيرفر' : 'Not connected to server', 'info');
    return;
  }

  updateSyncIndicator('syncing');
  showNotification(state.language === 'ar' ? 'جارٍ المزامنة' : 'Syncing', state.language === 'ar' ? 'جارٍ تحديث البيانات من السيرفر...' : 'Refreshing data from server...', 'info');

  const syncIdentity = getServerSessionIdentity();
  stopServerLiveSync();
  try {
    // Clear cache to force fresh data
    for (const key of Object.keys(_collectionCache)) {
      _collectionCache[key] = { data: null, timestamp: 0, identity: '' };
    }
    cancelPendingRequests();

    const result = await serverLoadAllData();
    if (result?.aborted) return;
    if (Array.isArray(result?.failed) && result.failed.length > 0) {
      throw new Error(`Failed collections: ${result.failed.map(x => x.collection).filter(Boolean).join(', ')}`);
    }
    updateSyncIndicator('synced');
    showNotification(state.language === 'ar' ? 'تمت المزامنة' : 'Synced', state.language === 'ar' ? 'تم تحديث البيانات بنجاح' : 'Data refreshed successfully', 'success');
    forceFullRender();
  } catch (e) {
    console.error('[manualSyncData] Failed:', e);
    updateSyncIndicator('error');
    showNotification(state.language === 'ar' ? 'فشلت المزامنة' : 'Sync Failed', state.language === 'ar' ? 'تعذر تحديث البيانات. تحقق من اتصالك.' : 'Could not refresh data. Check your connection.', 'error');
  } finally {
    if (!serverSessionIdentityChanged(syncIdentity)) startServerLiveSync();
  }
}

// Expose to window for debugging and manual use
window.manualSyncData = manualSyncData;

function stopServerLiveSync() {
  // Stop/restart invalidates only poll ticks. Authentication identity is
  // advanced explicitly at login/logout boundaries; changing it here made
  // startup abort its own cookie-session full load.
  _serverLiveSync.pollerEpoch = (_serverLiveSync.pollerEpoch || 0) + 1;
  if (_serverLiveSync.timer) {
    clearInterval(_serverLiveSync.timer);
    _serverLiveSync.timer = null;
  }
  _serverLiveSync.inFlight = false;
  _serverLiveSync.startedForUserId = null;

  // Clean up event listeners
  if (_serverLiveSync.visibilityHandler) {
    document.removeEventListener('visibilitychange', _serverLiveSync.visibilityHandler);
    _serverLiveSync.visibilityHandler = null;
  }
  if (_serverLiveSync.onlineHandler) {
    window.removeEventListener('online', _serverLiveSync.onlineHandler);
    _serverLiveSync.onlineHandler = null;
  }
}

function startServerLiveSync() {
  if (!isServerModeEnabled()) return;
  if (!state.currentUser) return;
  if (!SERVER_API.liveSyncEnabled) return;

  const uid = String(state.currentUser.id || '');
  if (_serverLiveSync.timer && _serverLiveSync.startedForUserId === uid) return;

  stopServerLiveSync();
  _serverLiveSync.startedForUserId = uid;
  _serverLiveSync.serviceEntitlements = getServerServiceEntitlementSnapshot();
  // Seed from the server watermark when we have one (authoritative, skew-free).
  // Before the first server load this session it is 0, so fall back to the state
  // estimate for a fast start; serverLoadAllData re-seeds authoritatively (and
  // can only LOWER a clock-skewed estimate) the moment it completes.
  // Only a COMPLETE full load may seed a non-zero global cursor. If startup
  // was throttled or even one collection failed, begin at zero so a failed
  // collection cannot permanently miss changes below another collection's
  // newer timestamp.
  _serverLiveSync.cursor = _serverLiveSync.fullLoadCursorReady
    ? (_serverLiveSync.serverWatermark || 0)
    : 0;
  _serverLiveSync.lastUsersSyncAt = 0;

  // Run one immediately, then poll.
  serverLiveSyncTick().catch(() => {});
  _serverLiveSync.timer = setInterval(() => {
    // BATTERY/SERVER SAVER: skip polls while the tab/app is hidden. The
    // visibilitychange handler below fires an immediate catch-up sync the
    // moment the app becomes visible again, so no update is ever missed.
    if (document.visibilityState === 'hidden') return;
    serverLiveSyncTick().catch(() => {});
  }, SERVER_API.liveSyncIntervalMs || 3000);

  // Resume sync when tab becomes visible again (after being backgrounded)
  if (!_serverLiveSync.visibilityHandler) {
    _serverLiveSync.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && state.currentUser) {
        // Tab is now visible - do an immediate sync to catch up
        console.log('[LiveSync] Tab visible - triggering immediate sync');
        serverLiveSyncTick().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', _serverLiveSync.visibilityHandler);
  }

  // Also sync when network comes back online
  if (!_serverLiveSync.onlineHandler) {
    _serverLiveSync.onlineHandler = () => {
      if (state.currentUser) {
        console.log('[LiveSync] Network online - triggering immediate sync');
        showNotification(state.language === 'ar' ? 'عاد الاتصال' : 'Back Online', state.language === 'ar' ? 'تمت إعادة الاتصال بالسيرفر، جارٍ المزامنة...' : 'Reconnected to server, syncing...', 'info');
        serverLiveSyncTick().catch(() => {});
      }
    };
    window.addEventListener('online', _serverLiveSync.onlineHandler);
  }
}

let _loginGeneration = 0;
let _activeLogin = null;
let _logoutInFlight = null;
let _serverAuthExpiryInFlight = null;

function setLoginFormBusy(busy) {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.setAttribute('aria-busy', busy ? 'true' : 'false');
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = !!busy;
  for (const input of form.querySelectorAll('input')) input.disabled = !!busy;
}

function loginAttemptIsCurrent(generation) {
  return generation === _loginGeneration && !_logoutInFlight && !_serverAuthExpiryInFlight;
}

function handleLogin(email, password) {
  if (_logoutInFlight || _serverAuthExpiryInFlight) {
    showNotification(
      state.language === 'ar' ? 'الرجاء الانتظار' : 'Please Wait',
      state.language === 'ar' ? 'جارٍ إنهاء الجلسة السابقة.' : 'The previous session is still closing.',
      'info'
    );
    return Promise.resolve(false);
  }
  if (_activeLogin && _activeLogin.generation === _loginGeneration) return _activeLogin.promise;

  const generation = ++_loginGeneration;
  setLoginFormBusy(true);
  const promise = _handleLoginOnce(email, password, generation)
    .catch((error) => {
      if (loginAttemptIsCurrent(generation)) {
        console.warn('[handleLogin] Failed:', error?.message || error);
        showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'تعذّر تسجيل الدخول.' : 'Could not sign in.', 'error');
      }
      return false;
    });
  const entry = { generation, promise };
  _activeLogin = entry;
  const cleanup = () => {
    if (_activeLogin === entry) _activeLogin = null;
    if (loginAttemptIsCurrent(generation)) setLoginFormBusy(false);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

async function _handleLoginOnce(email, password, loginGeneration) {
  // #region agent log
  // Hypothesis H-LOGIN: Login failures are caused by one of:
  // (a) user not found due to stored email whitespace/case issues
  // (b) password verification mismatch due to iterations stored as string (PBKDF2)
  // (c) user has missing password data from old backups
  // Log only non-PII metadata (counts/booleans/types).
  try {
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'start', {
        protocol: String(window.location?.protocol || '').slice(0, 16),
        serverMode: !!isServerModeEnabled(),
        usersCount: Array.isArray(state.users) ? state.users.length : 0,
      });
    }
  } catch (_) {}
  // #endregion

  if (isServerModeEnabled()) {
    // IMPORTANT: Successful login should never be shown as "Login Failed" due to a later data-load error.
    // We'll render immediately after auth, then load data in a separate guarded step.
    try {
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_attempt', {
            emailLen: String(email || '').length,
            hasAt: String(email || '').includes('@'),
          });
        }
      } catch (_) {}
      // #endregion
      const user = await apiLogin(email, password);
      if (!loginAttemptIsCurrent(loginGeneration)) return false;
      if (!user) {
        // #region agent log
        try {
          if (typeof window.__albayanDebugEmit === 'function') {
            window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_no_user', {});
          }
        } catch (_) {}
        // #endregion
        showNotification(state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed', state.language === 'ar' ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة' : 'Invalid email or password', 'error');
        return;
      }

      // Abort/detach every request and response cache belonging to the prior
      // anonymous/user identity before activating this login.
      cancelPendingRequests();
      invalidateUsersListCache();
      for (const key of Object.keys(_collectionCache)) {
        _collectionCache[key] = { data: null, timestamp: 0, identity: '' };
      }
      advanceServerSessionEpoch();
      state.currentUser = user;
      // Switch from the unauthenticated namespace to this exact
      // server+user cache before any business data is read or written.
      activateServerCollectionStorage(user);
      if (db) {
        try {
          await loadCollectionsFromStorage(null);
          if (!loginAttemptIsCurrent(loginGeneration)) return false;
          assertCachedCollectionIdentifiersSafe();
        } catch (_) {
          for (const name of PERSISTED_COLLECTIONS) state[name] = [];
        }
      }
      // Seed state.users immediately: the first render happens BEFORE
      // serverLoadAllData, and hasPermission/sidebar read state.users — on a
      // fresh device it would otherwise be empty and show "No access granted".
      upsertCurrentUserIntoUsers();
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_ok', {
            role: String(user?.role || '').slice(0, 32),
          });
        }
      } catch (_) {}
      // #endregion

      // Ensure user has subscriptions array
      if (!Array.isArray(state.currentUser.subscriptions)) {
        state.currentUser.subscriptions = [];
        if (isAdminRole(state.currentUser.role)) {
          state.currentUser.subscriptions = Object.keys(SERVICES);
        }
      }

      state.currentView = getPostLoginLandingViewForUser(user);
      saveState();

      showNotification(state.language === 'ar' ? 'مرحباً!' : 'Welcome!', state.language === 'ar' ? `تم تسجيل الدخول باسم ${Security.escapeHtml(user.name)}. جارٍ تحميل البيانات...` : `Logged in as ${Security.escapeHtml(user.name)}. Loading data...`, 'success');
      render(); // immediately leave the login screen

      // Show loading indicator
      const loadingOverlay = document.createElement('div');
      loadingOverlay.id = 'data-loading-overlay';
      loadingOverlay.className = 'fixed inset-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center';
      loadingOverlay.innerHTML = `
        <div class="text-center">
          <div class="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p id="loading-progress" class="text-slate-600 dark:text-slate-300 font-medium">${state.language === 'ar' ? 'جارٍ تحميل البيانات...' : 'Loading data...'}</p>
          <p class="text-xs text-slate-400 mt-2">${state.language === 'ar' ? 'الرجاء الانتظار بينما تتم مزامنة بياناتك' : 'Please wait while we sync your data'}</p>
        </div>
      `;
      document.body.appendChild(loadingOverlay);

      try {
        const loadResult = await serverLoadAllData();
        if (!loginAttemptIsCurrent(loginGeneration)) return false;
        if (loadResult?.aborted) return;
        if (loadResult && Array.isArray(loadResult.failed) && loadResult.failed.length > 0) {
          showNotification(state.language === 'ar' ? 'تحميل جزئي' : 'Partially Loaded', state.language === 'ar' ? 'تم تسجيل الدخول، لكن فشل تحميل بعض البيانات. جرّب التحديث.' : 'Logged in, but some data failed to load. Try Refresh.', 'warning');
        } else {
          showNotification(state.language === 'ar' ? 'تم تحميل البيانات' : 'Data Loaded', state.language === 'ar' ? 'تمت مزامنة جميع البيانات بنجاح' : 'All data synchronized successfully', 'success');
        }
      } catch (e) {
        if (!loginAttemptIsCurrent(loginGeneration)) return false;
        // serverLoadAllData should be tolerant, but keep a belt-and-suspenders guard.
        console.warn('Server data load failed after login:', e);
        showNotification(state.language === 'ar' ? 'تحذير السيرفر' : 'Server Warning', state.language === 'ar' ? 'تم تسجيل الدخول، لكن فشل تحميل بعض البيانات. جرّب التحديث.' : 'Logged in, but some data failed to load. Try Refresh.', 'warning');
      } finally {
        // Remove loading overlay
        document.getElementById('data-loading-overlay')?.remove();
      }

      // Start live sync so other users' changes appear without manual refresh.
      if (!loginAttemptIsCurrent(loginGeneration)) return false;
      startServerLiveSync();
      render();
      return;
    } catch (e) {
      if (!loginAttemptIsCurrent(loginGeneration)) return false;
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'server_login_error', {
            status: e?.status ?? null,
            name: String(e?.name || '').slice(0, 40),
            msg: String(e?.message || '').slice(0, 120),
          });
        }
      } catch (_) {}
      // #endregion
      // Fresh server with no users yet — show the first-run setup screen so the
      // owner can create the first admin from the browser (no shell needed).
      // The server returns 503 with a "not initialized" hint in that case.
      const _msg = String(e?.message || '');
      if (e?.status === 503 && /not initialized|no users/i.test(_msg)) {
        const setupStatus = await apiNeedsSetup();
        const browserSetupAvailable = setupStatus?.needsSetup === true && setupStatus?.setupEnabled === true;
        state.needsServerSetup = browserSetupAvailable;
        state.serverHasNoUsers = true;
        state.serverSetupEnabled = setupStatus?.setupEnabled === true;
        if (browserSetupAvailable) {
          showNotification(
            state.language === 'ar' ? 'إعداد أول مرة' : 'First-time setup',
            state.language === 'ar' ? 'لا يوجد حساب بعد. أدخل رمز إعداد الخادم لإنشاء المدير الأول.' : 'No account exists yet. Enter the server setup token to create the first admin.',
            'info'
          );
        } else {
          showNotification(
            state.language === 'ar' ? 'إعداد الخادم مطلوب' : 'Server Setup Required',
            state.language === 'ar'
              ? 'إعداد المتصفح معطّل. يجب على مشغل الخادم استخدام متغيرات ALBAYAN_BOOTSTRAP_ADMIN_* أو أمر إنشاء المدير من الطرفية.'
              : 'Browser setup is disabled. The server operator must use the ALBAYAN_BOOTSTRAP_ADMIN_* environment variables or the create-admin CLI command.',
            'warning'
          );
        }
        render();
        return;
      }
      if (e?.status === 401) {
        showNotification(
          state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed',
          state.language === 'ar'
            ? 'بيانات الدخول غير صحيحة (حساب السيرفر). إذا كنت تريد حساب المتصفح المحلي، اضغط "استخدام المحلي".'
            : 'Invalid email or password (server account). If you meant your local browser account, click “Use Local”.',
          'error'
        );
        return;
      }
      showNotification(state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed', e?.message || (state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login failed'), 'error');
      return;
    }
  }

  // Sanitize inputs
  const sanitizedEmail = Security.sanitizeInput(email.toLowerCase().trim(), { maxLength: 100 });
  const sanitizedPassword = password; // Don't modify password as it might contain special chars
  
  // Validate email format
  if (!Security.isValidEmail(sanitizedEmail)) {
    showNotification(state.language === 'ar' ? 'بريد إلكتروني غير صحيح' : 'Invalid Email', state.language === 'ar' ? 'الرجاء إدخال بريد إلكتروني صحيح' : 'Please enter a valid email address', 'error');
    addSecurityLog('invalid_email_format', sanitizedEmail);
    return;
  }

  if (!Array.isArray(state.users) || state.users.length === 0) {
    showNotification(state.language === 'ar' ? 'لا يوجد مستخدمون محليون' : 'No Local Users', state.language === 'ar' ? 'هذا النشر يستخدم تسجيل الدخول عبر السيرفر. الرجاء تشغيل الخادم وتسجيل الدخول هناك.' : 'This deployment uses server login. Please run the backend and login there.', 'error');
    return;
  }
  
  // Check rate limiting
  const rateCheck = Security.checkRateLimit(sanitizedEmail, 5, 15 * 60 * 1000);
  if (!rateCheck.allowed) {
    showNotification(state.language === 'ar' ? 'محاولات كثيرة جداً' : 'Too Many Attempts', state.language === 'ar' ? `الرجاء الانتظار ${rateCheck.waitMinutes} دقيقة قبل المحاولة مرة أخرى` : `Please wait ${rateCheck.waitMinutes} minutes before trying again`, 'error');
    addSecurityLog('rate_limit_exceeded', sanitizedEmail);
    return;
  }
  
  // Record login attempt
  Security.recordLoginAttempt(sanitizedEmail);
  
  // Find user
  const _users = Array.isArray(state.users) ? state.users : [];
  // Debug-only: check whether trimming stored emails would change lookup result.
  let _exactFound = false;
  let _trimFound = false;
  try {
    _exactFound = !!_users.find(u => !u?._deleted && String(u?.email || '').toLowerCase() === sanitizedEmail);
    _trimFound = !!_users.find(u => !u?._deleted && String(u?.email || '').toLowerCase().trim() === sanitizedEmail);
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'user_lookup', {
        exactFound: _exactFound,
        trimFound: _trimFound,
        usersCount: _users.length,
      });
    }
  } catch (_) {}

  const user = _users.find(u => 
    !u._deleted &&
    u.email.toLowerCase() === sanitizedEmail
  );
  
  if (!user) {
    showNotification(state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed', state.language === 'ar' ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة' : 'Invalid email or password', 'error');
    addSecurityLog('failed_login_unknown_user', sanitizedEmail);
    return;
  }
  
  // If imported from very old backups, a user might have neither hash nor plaintext.
  // In that case, require password reset instead of silently failing.
  if (!user.passwordHash && !user.password) {
    showNotification(
      state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed',
      state.language === 'ar'
        ? 'لا توجد بيانات كلمة مرور لهذا الحساب (ربما من نسخة احتياطية قديمة). اطلب من المدير تعيين كلمة مرور جديدة.'
        : 'This account has no password data (likely from an old backup). Ask an administrator to set a new password.',
      'error'
    );
    addSecurityLog('login_missing_password_data', sanitizedEmail);
    return;
  }
  
  // Verify password
  let passwordValid = false;
  
  if (user.passwordHash && user.salt) {
    // Verify using stored algorithm (PBKDF2 recommended; legacy SHA-256 supported)
    const algo = user.passwordAlgo || 'sha256';
    const iterations = user.passwordIterations || null;
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        const iterRaw = iterations;
        const iterRawStr = String(iterRaw ?? '');
        const iterLooksNumeric = /^[0-9]{1,10}$/.test(iterRawStr);
        const iterParsed = iterLooksNumeric ? Number(iterRawStr) : null;
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'verify_password_before', {
          algo: String(algo || '').slice(0, 24),
          iterType: typeof iterRaw,
          iterRaw: iterLooksNumeric ? iterRawStr : null,
          iterParsed: Number.isFinite(iterParsed) ? iterParsed : null,
          hashLen: String(user.passwordHash || '').length,
          saltLen: String(user.salt || '').length,
        });
      }
    } catch (_) {}
    // #endregion
    passwordValid = await Security.verifyPassword(sanitizedPassword, user.passwordHash, user.salt, algo, iterations);
    if (!loginAttemptIsCurrent(loginGeneration)) return false;
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'verify_password_after', {
          ok: !!passwordValid,
        });
      }
    } catch (_) {}
    // #endregion
    } else {
    // Legacy plain text password (migrate on successful login)
    passwordValid = user.password === sanitizedPassword;
    
    if (passwordValid) {
      // Migrate to PBKDF2 hashed password
      const { hash, salt, algo, iterations } = await Security.hashPassword(sanitizedPassword, null, { algo: 'pbkdf2-sha256' });
      if (!loginAttemptIsCurrent(loginGeneration)) return false;
      user.passwordHash = hash;
      user.salt = salt;
      user.passwordAlgo = algo;
      user.passwordIterations = iterations;
      delete user.password; // Remove plain text password
      markCollectionDirty('users');
      saveState();
    }
  }
  
  if (passwordValid) {
    // Clear rate limiting on successful login
    Security.clearLoginAttempts(sanitizedEmail);
    
    // Create secure session
    SessionManager.createSession(user.id);
    
    state.currentUser = user;
    
    // Ensure user has subscriptions array (backwards compatibility)
    if (!Array.isArray(state.currentUser.subscriptions)) {
      state.currentUser.subscriptions = [];
      // Give Admin all services by default
      if (isAdminRole(state.currentUser.role)) {
        state.currentUser.subscriptions = Object.keys(SERVICES);
      }
    }
    
    state.currentView = getPostLoginLandingViewForUser(user);
    // Upgrade legacy hashes to PBKDF2 after successful login
    if ((user.passwordAlgo || 'sha256') !== 'pbkdf2-sha256') {
      try {
        const upgraded = await Security.hashPassword(sanitizedPassword, null, { algo: 'pbkdf2-sha256' });
        if (!loginAttemptIsCurrent(loginGeneration)) return false;
        user.passwordHash = upgraded.hash;
        user.salt = upgraded.salt;
        user.passwordAlgo = upgraded.algo;
        user.passwordIterations = upgraded.iterations;
        markCollectionDirty('users');
      } catch (e) {
        console.warn('Password upgrade failed:', e);
      }
    }

    saveState();
    addAuditLog('Login', user.id, `User ${Security.escapeHtml(user.name)} logged in`);
    showNotification(state.language === 'ar' ? 'مرحباً!' : 'Welcome!', state.language === 'ar' ? `تم تسجيل الدخول باسم ${Security.escapeHtml(user.name)}` : `Logged in as ${Security.escapeHtml(user.name)}`, 'success');
    render();
  } else {
    // #region agent log
    try {
      if (typeof window.__albayanDebugEmit === 'function') {
        window.__albayanDebugEmit('H-LOGIN', 'script.js:handleLogin', 'password_invalid', {
          serverMode: !!isServerModeEnabled(),
          exactFound: !!_exactFound,
          trimFound: !!_trimFound,
          hasHash: !!user?.passwordHash,
          hasSalt: !!user?.salt,
          algo: String(user?.passwordAlgo || '').slice(0, 24),
          iterType: typeof (user?.passwordIterations),
        });
      }
    } catch (_) {}
    // #endregion
    showNotification(state.language === 'ar' ? 'فشل تسجيل الدخول' : 'Login Failed', state.language === 'ar' ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة' : 'Invalid email or password', 'error');
    addSecurityLog('failed_login_wrong_password', sanitizedEmail);
  }
}

function waitForPromiseBounded(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
    Promise.resolve(promise).then(finish, finish);
  });
}

function showSessionTransitionOverlay(message) {
  document.getElementById('session-transition-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'session-transition-overlay';
  overlay.className = 'fixed inset-0 bg-white/85 dark:bg-slate-900/85 backdrop-blur-sm z-[100] flex items-center justify-center';
  overlay.innerHTML = `<div class="text-center"><div class="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div><p class="font-medium text-slate-700 dark:text-slate-200">${Security.escapeHtml(message)}</p></div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function resetAuthenticatedServerCaches() {
  _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
  _usersListCache = { data: null, timestamp: 0, cacheDurationMs: 30000, identity: '' };
  for (const key of Object.keys(_collectionCache)) {
    _collectionCache[key] = { data: null, timestamp: 0, identity: '' };
  }
  _pendingRequests.clear();
  _serverLiveSync.serverWatermark = 0;
  _serverLiveSync.cursor = 0;
  _serverLiveSync.fullLoadCursorReady = false;
  _serverLiveSync.collectionCursors = Object.create(null);
  _serverLiveSync.serviceEntitlements = null;
  if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache('adCampaignRequests');
  // A body-mounted full-screen photo must never survive logout or expiry. Do
  // not restore focus to a control that belonged to the previous user.
  if (typeof closeReceiptPhotoViewer === 'function') closeReceiptPhotoViewer(false);
  // Ads Studio keeps an unsaved draft and compressed photos in memory. Reset
  // them with every auth transition so one customer can never inherit another
  // customer's unfinished work after logout or session expiry.
  if (typeof resetAdsStudioSessionState === 'function') resetAdsStudioSessionState();
}

function discardPendingServerUserUpdates() {
  try {
    for (const timer of _serverUserUpdate.timers.values()) clearTimeout(timer);
    _serverUserUpdate.timers.clear();
    _serverUserUpdate.pending.clear();
  } catch (_) {}
}

async function wipeAuthenticatedServerDataFromClient() {
  // This helper is also used by the session-expiry path, which does not pass
  // through the normal logout function. Remove body-mounted financial data
  // before clearing auth/state or awaiting IndexedDB writes.
  _closeCustomerPagesDialogForStateChange();
  const collections = Array.isArray(PERSISTED_COLLECTIONS)
    ? PERSISTED_COLLECTIONS
    : ['ads', 'receipts', 'customers', 'pages', 'exchangeRateHistory'];
  for (const name of collections) state[name] = [];
  state.logs = [];
  state.serverLogs = [];
  state.serverLogsLoadedAt = 0;
  if (!db) return;
  const writes = collections.map(name => saveCollectionToIndexedDB(name, []));
  writes.push(clearIndexedDBLogs());
  await Promise.allSettled(writes);
}

function emergencyFinishClientSignOut(serverMode, expired) {
  _closeCustomerPagesDialogForStateChange();
  try { stopServerLiveSync(); } catch (_) {}
  try { advanceServerSessionEpoch(); } catch (_) {}
  try { cancelPendingRequests(); } catch (_) {}
  try { discardPendingServerUserUpdates(); } catch (_) {}
  try { SessionManager.destroySession(); } catch (_) {}
  try { resetAuthenticatedServerCaches(); } catch (_) {}
  if (serverMode) {
    for (const name of PERSISTED_COLLECTIONS) state[name] = [];
    state.logs = [];
    state.serverLogs = [];
  }
  state.currentUser = null;
  if (serverMode) activateAnonymousServerCollectionStorage();
  state.currentView = 'analytics';
  saveState();
  showNotification(
    state.language === 'ar' ? (expired ? 'انتهت الجلسة' : 'تم تسجيل الخروج') : (expired ? 'Session Expired' : 'Logged Out'),
    state.language === 'ar' ? 'سجّل الدخول مرة أخرى للمتابعة.' : 'Please sign in again to continue.',
    expired ? 'warning' : 'info'
  );
  render();
}

async function _handleLogoutOnce() {
  const serverMode = isServerModeEnabled();
  const overlay = showSessionTransitionOverlay(state.language === 'ar' ? 'جارٍ تسجيل الخروج...' : 'Signing out...');
  _closeCustomerPagesDialogForStateChange();
  try {
    if (state.currentUser) {
      addAuditLog('Logout', state.currentUser.id, `User ${Security.escapeHtml(state.currentUser.name)} logged out`);
    }
    // Stop new sync work immediately, but keep the authenticated identity until
    // pending user edits and the logout request have settled. Rendering the
    // login screen before apiLogout completed allowed that delayed request to
    // delete a newly-created replacement session.
    stopServerLiveSync();
    let pendingUpdates = null;
    try { pendingUpdates = flushPendingUserUpdates(); } catch (_) {}
    await waitForPromiseBounded(pendingUpdates, 5000);
    if (serverMode) await apiLogout(); // apiLogout has its own bounded timeout

    advanceServerSessionEpoch();
    cancelPendingRequests();
    discardPendingServerUserUpdates();
    SessionManager.destroySession();
    resetAuthenticatedServerCaches();
    if (serverMode) await wipeAuthenticatedServerDataFromClient();

    state.currentUser = null;
    if (serverMode) activateAnonymousServerCollectionStorage();
    state.currentView = 'analytics';
    saveState();
    showNotification(state.language === 'ar' ? 'تم تسجيل الخروج' : 'Logged Out', state.language === 'ar' ? 'إلى اللقاء قريباً!' : 'See you soon!', 'info');
    render();
  } finally {
    overlay.remove();
  }
  return true;
}

function handleLogout() {
  if (_logoutInFlight) return _logoutInFlight;
  _loginGeneration += 1; // invalidate any post-login load still finishing
  const serverMode = isServerModeEnabled();
  const promise = Promise.resolve().then(_handleLogoutOnce).catch((error) => {
    console.error('[handleLogout] Failed; forcing local sign-out:', error);
    emergencyFinishClientSignOut(serverMode, false);
    return false;
  });
  _logoutInFlight = promise;
  const cleanup = () => {
    if (_logoutInFlight === promise) _logoutInFlight = null;
  };
  promise.then(cleanup, cleanup);
  return promise;
}

function handleServerAuthExpired(requestIdentity) {
  if (!state.currentUser || serverSessionIdentityChanged(requestIdentity)) return Promise.resolve(false);
  if (_logoutInFlight) return _logoutInFlight;
  if (_serverAuthExpiryInFlight) return _serverAuthExpiryInFlight;
  _loginGeneration += 1;
  const promise = Promise.resolve().then(async () => {
    const overlay = showSessionTransitionOverlay(state.language === 'ar' ? 'انتهت الجلسة. جارٍ تأمين البيانات...' : 'Session expired. Securing local data...');
    try {
      stopServerLiveSync();
      advanceServerSessionEpoch();
      cancelPendingRequests();
      discardPendingServerUserUpdates();
      SessionManager.destroySession();
      resetAuthenticatedServerCaches();
      // Do not call /auth/logout here: the cookie is already invalid. Wipe the
      // current user's namespace before switching to anonymous storage.
      await wipeAuthenticatedServerDataFromClient();
      state.currentUser = null;
      activateAnonymousServerCollectionStorage();
      state.currentView = 'analytics';
      saveState();
      showNotification(
        state.language === 'ar' ? 'انتهت الجلسة' : 'Session Expired',
        state.language === 'ar' ? 'سجّل الدخول مرة أخرى للمتابعة.' : 'Please sign in again to continue.',
        'warning'
      );
      render();
      return true;
    } finally {
      overlay.remove();
    }
  }).catch((error) => {
    console.error('[handleServerAuthExpired] Failed; forcing local sign-out:', error);
    emergencyFinishClientSignOut(true, true);
    return false;
  });
  _serverAuthExpiryInFlight = promise;
  const cleanup = () => {
    if (_serverAuthExpiryInFlight === promise) _serverAuthExpiryInFlight = null;
  };
  promise.then(cleanup, cleanup);
  return promise;
}
