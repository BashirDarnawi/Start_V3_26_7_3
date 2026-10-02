// ==========================================
// DATA HELPERS
// ==========================================

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getMonotonicTime() {
  return Date.now();
}

// Per-record PATCH chains (server mode), keyed `${collection}:${id}`: a rapid second edit waits for the
// first PATCH's echo and uses its server _lastModified as the baseline (the client stamp was a false 409).
const _patchChains = new Map();
// Optimistic copy -> the last server-confirmed copy behind it (see updateRecord).
const _patchConfirmedBase = new WeakMap();

// A sent number as the server stores it (main.py sanitize_json, arrays under their parent's key): amounts
// 0..1e7 at 2 decimals, rates 0.001..1000 at 4, Python round() (exact tie to even); NaN is sent as null.
const _SERVER_AMOUNT_KEYS = new Set(['amountUSD', 'amountLocal', 'amount', 'debtAmountUSD', 'debtAmountLocal', 'spentUSD',
  'spentLocal', 'remainingUSD', 'remainingLocal', 'collectedAmount', 'amountCollectedFromCustomer', 'quotedDeliveryFee',
  'actualDeliveryFeeCollected', 'deliveryFeeCollected', 'overpaidAmount', 'remainingDue', 'dueAmountToUseUSD', 'dueAmountToUseLYD']);
function _serverStoredNumbers(v, key = '') {
  if (Array.isArray(v)) return v.map(x => _serverStoredNumbers(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, _serverStoredNumbers(x, k)]));
  const rate = key === 'rate' || key === 'exchangeRate';
  if (typeof v !== 'number' || !Number.isFinite(v) || !(rate || _SERVER_AMOUNT_KEYS.has(key))) return v;
  const x = rate ? Math.min(Math.max(v, 0.001), 1000) : Math.min(Math.max(v, 0), 1e7), p = rate ? 1e4 : 100;
  const t = x * (rate ? 32 : 8), k = Math.floor(x * p);  // t is odd exactly when x * p ends in .5
  return Number.isInteger(t) && t % 2 ? (k + k % 2) / p : Number(x.toFixed(rate ? 4 : 2));
}

function serverRecordMatchesCreateRetry(serverRecord, requestedRecord) {
  if (!serverRecord || !requestedRecord || String(serverRecord.id || '') !== String(requestedRecord.id || '')) return false;
  const ignored = new Set(['_lastModified', '_created', '_deleted', 'createdAt', 'createdBy', 'createdByName']);
  requestedRecord = _serverStoredNumbers(requestedRecord);  // a lost answer's row holds the stored numbers
  for (const [key, value] of Object.entries(requestedRecord)) {
    if (ignored.has(key) || value === undefined) continue;
    if (Security.stableJson(serverRecord[key]) !== Security.stableJson(value)) return false;  // iPhone replies reorder keys
  }
  return true;
}

// ---- CREATOR NAME RESOLUTION (survives user deletion) ----
// Deleted accounts stop syncing, so records showed "Created by: Unknown". Order: live state.users,
// the server tombstone directory, the record's createdByName. Anonymized accounts stay "Deleted user".
function getKnownUserNameById(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const live = (state.users || []).find(u => u && String(u.id) === uid);
  if (live && live.name) return String(live.name);
  const tombs = state.userTombstones;
  if (tombs && typeof tombs === 'object' && typeof tombs[uid] === 'string' && tombs[uid]) return String(tombs[uid]);
  return '';
}

function resolveCreatorDisplayName(record, isAr) {
  const uid = String(record?.createdBy || record?.creatorId || '').trim();
  if (uid === 'system') return isAr ? 'النظام' : 'System';
  const known = uid ? getKnownUserNameById(uid) : '';
  if (known) return known;
  const stamped = String(record?.createdByName || '').trim();
  if (stamped) return stamped;
  // Unknown creator id: fetch the deleted-users directory (throttled) so records older than the
  // createdByName stamp regain their creator's name on the next render.
  if (uid) requestUserTombstoneRefresh();
  return isAr ? 'غير معروف' : 'Unknown';
}

const _userTombstoneRefresh = { inFlight: false, lastAttemptAt: 0 };
function requestUserTombstoneRefresh() {
  if (typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return;
  if (typeof apiJson !== 'function') return;
  const nowTs = Date.now();
  if (_userTombstoneRefresh.inFlight || (nowTs - _userTombstoneRefresh.lastAttemptAt) < 60000) return;
  _userTombstoneRefresh.inFlight = true;
  _userTombstoneRefresh.lastAttemptAt = nowTs;
  apiJson('/api/users/tombstones', { method: 'GET' }, { timeoutMs: 10000 })
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      const map = {};
      rows.forEach((r) => {
        if (r && r.id && typeof r.name === 'string' && r.name) map[String(r.id)] = String(r.name);
      });
      // REPLACE, never merge: an anonymized tombstone is renamed "Deleted user"; a merge resurrected the name.
      const next = Security.sanitizeObject(map);
      if (JSON.stringify(state.userTombstones || {}) !== JSON.stringify(next)) {
        state.userTombstones = next;
        saveState();
        RenderQueue.schedule('userTombstones');
      }
    })
    .catch(() => {})
    .finally(() => { _userTombstoneRefresh.inFlight = false; });
}

/** Add a record to a collection: sanitise, generate a secure id, stamp
 * metadata, add locally (optimistic), sync to the server; on failure roll the
 * local record back and show the error; audit logged. */
function addRecord(array, record) {
  if (!Array.isArray(array) || !record || typeof record !== 'object') return Promise.resolve(false);
  const collectionName = getCollectionNameFromArray(array);
  const cleanRecord = Security.sanitizeRecord(collectionName, record);
  if (!cleanRecord.id) cleanRecord.id = Security.generateSecureId(collectionName || 'id');
  const idCheck = Security.validateRecordIdentifiers(cleanRecord, collectionName || 'record');
  if (!idCheck.valid || !Security.isValidRecordId(cleanRecord.id)) {
    showNotification('Invalid Record', idCheck.error || 'The record id is not allowed.', 'error');
    return Promise.resolve(false);
  }
  if (array.some(item => item && String(item.id) === String(cleanRecord.id))) {
    showNotification(state.language === 'ar' ? 'سجل مكرر' : 'Duplicate Record', state.language === 'ar' ? 'هذا السجل موجود مسبقاً.' : 'This record already exists.', 'error');
    return Promise.resolve(false);
  }

  cleanRecord._lastModified = getMonotonicTime();
  cleanRecord._deleted = false;
  if (!cleanRecord._created) cleanRecord._created = getMonotonicTime();
  if (!cleanRecord.createdBy && state.currentUser?.id) cleanRecord.createdBy = state.currentUser.id;
  // Stamp the creator's name at creation: deleted accounts stop syncing, so this keeps "Created by"
  // readable (resolveCreatorDisplayName); the server overrides it with the users-table name.
  if (!cleanRecord.createdByName && cleanRecord.createdBy) {
    const _creatorName = (String(cleanRecord.createdBy) === String(state.currentUser?.id || '') && state.currentUser?.name)
      ? String(state.currentUser.name)
      : getKnownUserNameById(cleanRecord.createdBy);
    if (_creatorName) cleanRecord.createdByName = _creatorName;
  }

  const localRecord = isServerModeEnabled() && collectionName === 'adCampaignRequests' && typeof makeLightweightMediaRecord === 'function'
    ? makeLightweightMediaRecord(collectionName, cleanRecord)
    : cleanRecord;
  array.unshift(localRecord);
  if (collectionName) markCollectionDirty(collectionName);
  saveState();
  addAuditLog('Create', cleanRecord.id || 'Unknown', `Created new ${getRecordType(cleanRecord)}`);
  RenderQueue.schedule('addRecord');

  // Server write-through (always-online multi-user mode)
  if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
    const id = cleanRecord.id;
    return apiCreateEntity(collectionName, cleanRecord)
      .then((entity) => {
        if (entity?.data && entity?.id) {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) {
            array[idx] = Security.sanitizeRecord(collectionName, entity.data);
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
          }
        }
        return true;
      })
      .catch(async (e) => {
        // A POST may commit and lose its answer: the retry's 409 is accepted only if the stored row
        // matches; otherwise roll back as a real collision.
        if (e?.status === 409) {
          try {
            const existing = await apiGetEntity(collectionName, id);
            if (existing?.data && serverRecordMatchesCreateRetry(existing.data, cleanRecord)) {
              const idx = array.findIndex(x => x && x.id === id);
               if (idx !== -1) {
                 const existingData = Security.sanitizeRecord(collectionName, existing.data);
                 array[idx] = collectionName === 'adCampaignRequests' && typeof makeLightweightMediaRecord === 'function'
                   ? makeLightweightMediaRecord(collectionName, existingData)
                   : existingData;
               }
              markCollectionDirty(collectionName);
              saveState();
              return true;
            }
          } catch (_) {}
        }
        // Rollback on failure
        const idx = array.findIndex(x => x && x.id === id);
        if (idx !== -1) array.splice(idx, 1);
        if (collectionName) markCollectionDirty(collectionName);
        saveState();
        // Handle 401 - session expired, prompt re-login
        if (e?.status === 401) {
          showNotification(..._sessionExpiredToast(), 'warning');
          // Clear cached session to force re-auth on next action
          _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
        } else {
          showNotification(..._serverRefusalToast('create', collectionName, e), 'error');
        }
        return false;
      });
  } else if (isServerModeEnabled() && collectionName === 'users') {
    // Creating users requires server-side password handling; this path should not be used.
    const idx = array.findIndex(x => x && x.id === cleanRecord.id);
    if (idx !== -1) array.splice(idx, 1);
    markCollectionDirty('users');
    saveState();
    showNotification('Server Mode', 'Create users from the server-backed Users screen (Admin only).', 'warning');
    return Promise.resolve(false);
  }
  return Promise.resolve(true);
}

function _localFundingMinor(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return 0;
  if (typeof value === 'boolean') throw new Error('Stored funding amount is invalid');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Stored funding amount is invalid');
  if (parsed === 0) return 0;
  // Local settlement math is integer cents: a scale-aware epsilon before half-up rounding keeps
  // 1.005 from becoming 100 cents (binary floating point).
  const scaled = parsed * 100;
  return Math.floor(scaled + 0.5 + (Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4));
}

function _localFundingMap(rows) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const receiptId = String(row?.receiptId || '');
    const amount = _localFundingMinor(row?.amountUSD);
    if (!receiptId || amount <= 0) continue;
    result.set(receiptId, (result.get(receiptId) || 0) + amount);
  }
  return result;
}

function _localFundingRows(values) {
  return [...values.entries()]
    .filter(([, amount]) => amount > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([receiptId, amount]) => ({ receiptId, amountUSD: amount / 100 }));
}

function _localLegacyDueMinor(ad) {
  const direct = _localFundingMinor(ad?.dueAmountToUseUSD);
  if (direct > 0) return direct;
  const rawLocal = ad?.dueAmountToUseLYD;
  if (rawLocal === undefined || rawLocal === null || (typeof rawLocal === 'string' && rawLocal.trim() === '')) return 0;
  if (typeof rawLocal === 'boolean') throw new Error('Stored funding amount is invalid');
  const lyd = Number(rawLocal);
  if (!Number.isFinite(lyd) || lyd < 0) throw new Error('Stored funding amount is invalid');
  if (lyd === 0) return 0;
  if (typeof ad?.exchangeRate === 'boolean') throw new Error('Stored funding exchange rate is invalid');
  const rate = Number(ad?.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Stored funding exchange rate is invalid');
  if (rate <= 0.001 || rate === 1) return 0;  // the 0.001 sentinel / an unset rate never converts (mirrors _financial_ad_due_usage)
  return _localFundingMinor(lyd / rate);
}

// Legacy debt rows kept the promise in dueAmountToUseUSD/LYD. Its receipt: a Driver ad's
// linkedDeliveryReceiptId (oldest rows: receiptId), an In-Shop ad's receiptId; balance readers honor
// that fallback like settlement does. A zero-amount link is provenance only, never money.
function isAdLegacyDueMirrorForReceipt(ad, receiptId) {
  const rid = String(receiptId || '');
  if (!ad || !rid) return false;
  if (String(ad.linkedDeliveryReceiptId || '') === rid) return true;
  const paymentState = typeof getAdPaymentState === 'function'
    ? getAdPaymentState(ad)
    : (ad.isPaid === true ? 'paid' : 'not_paid');
  if (paymentState !== 'not_paid') return false;
  const method = String(ad.collectionMethod || '');
  if (method === 'in_shop') return String(ad.receiptId || '') === rid;
  return method === 'driver'
    && String(ad.linkedDeliveryReceiptId || '') === ''
    && String(ad.receiptId || '') === rid;
}

function getAdLegacyDueMirrorUSD(ad, receiptId, fallbackRate = 0) {
  if (!isAdLegacyDueMirrorForReceipt(ad, receiptId)) return 0;
  const direct = Number(ad?.dueAmountToUseUSD);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct * 100) / 100;
  const local = Number(ad?.dueAmountToUseLYD);
  const explicit = Number(ad?.exchangeRate);
  // The 0.001 sentinel and an unset "1" never convert; the receipt's rate is the documented fallback (test-money A4b).
  const trusted = Number.isFinite(explicit) && explicit > 0.001 && explicit !== 1 ? explicit : 0;
  const rate = trusted || Number(fallbackRate) || Number(state.defaultExchangeRate) || 0;
  if (!Number.isFinite(local) || local <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round((local / rate) * 100) / 100;
}

function _localAdCommittedMinor(ad, receiptId) {
  const rid = String(receiptId || '');
  const paid = _localFundingMap(ad?.receiptAllocations).get(rid) || 0;
  const dueMap = _localFundingMap(ad?.dueAllocations);
  const due = dueMap.get(rid) || 0;
  let legacyDue = 0;
  // The scalar mirror is standalone money ONLY for rowless ads: with due rows the writers keep it
  // equal to their sum, and counting it again would put the same dollars on two receipts.
  if (isAdLegacyDueMirrorForReceipt(ad, rid) && due === 0 && dueMap.size === 0) {
    legacyDue = _localLegacyDueMinor(ad);
  }
  const explicit = paid + due + legacyDue;
  if (explicit > 0) return explicit;

  // With either allocation ledger present, a missing row means zero (the full ad amount would charge
  // another receipt's money).
  if (Array.isArray(ad?.receiptAllocations) || Array.isArray(ad?.dueAllocations)) return 0;
  const paymentState = typeof getAdPaymentState === 'function'
    ? getAdPaymentState(ad)
    : (ad?.isPaid === true ? 'paid' : 'not_paid');
  if (paymentState === 'not_paid' && ['driver', 'in_shop'].includes(String(ad?.collectionMethod || ''))) {
    return 0;
  }
  const references = new Set([
    String(ad?.fundingReceiptId || ''),
    String(ad?.receiptId || ''),
    String(ad?.linkedDeliveryReceiptId || '')
  ]);
  if (!references.has(rid)) return 0;
  return _localFundingMinor(ad?.spentUSD !== undefined && ad?.spentUSD !== null ? ad.spentUSD : ad?.amountUSD);
}

function _localReceiptOutgoingMinor(receipt) {
  if (receipt?.transfers === undefined || receipt?.transfers === null) return 0;
  if (!Array.isArray(receipt.transfers)) throw new Error('Stored receipt transfers are invalid');
  return receipt.transfers.reduce((sum, transfer) => {
    if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer)) {
      throw new Error('Stored receipt transfer is invalid');
    }
    const amount = Number(transfer.amountUSD);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Stored receipt transfer amount is invalid');
    return sum + _localFundingMinor(amount);
  }, 0);
}

// Local parity for the server settlement transaction: converts only explicit due money (a row
// or a positive legacy dueAmount mirror; a bare link never mints credit). Every plan is
// validated before updateRecord changes the receipt or any ad.
function planLocalReceiptPaidAdUpdates(receiptId, nextReceipt = null) {
  const rid = String(receiptId || '');
  const receipt = nextReceipt || (state.receipts || []).find(row => row && String(row.id) === rid);
  if (!receipt || receipt._deleted) throw new Error('Receipt not found');
  const receiptCustomerId = String(receipt.customerId || '');
  const actorId = String(state.currentUser?.id || '');
  const now = new Date().toISOString();
  const plans = [];
  const plannedById = new Map();
  for (let index = 0; index < (state.ads || []).length; index++) {
    const ad = state.ads[index];
    if (!ad || ad._deleted || String(ad.recordType || '') === 'receipt') continue;
    const paymentState = typeof getAdPaymentState === 'function'
      ? getAdPaymentState(ad)
      : (ad.isPaid === true ? 'paid' : 'not_paid');
    const collectionMethod = String(ad.collectionMethod || '');
    const isDriverLink = paymentState === 'not_paid'
      && collectionMethod === 'driver'
      && String(ad.linkedDeliveryReceiptId || ad.receiptId || '') === rid;
    const isShopLink = paymentState === 'not_paid'
      && collectionMethod === 'in_shop'
      && String(ad.receiptId || '') === rid;

    const paid = _localFundingMap(ad.receiptAllocations);
    const due = _localFundingMap(ad.dueAllocations);
    let moved = due.get(rid) || 0;
    due.delete(rid);
    // The mirror converts only for rowless ads: with due rows left for other receipts it is their
    // sum, and converting it would mint the same dollars twice.
    if (moved <= 0 && (isDriverLink || isShopLink) && due.size === 0) moved = _localLegacyDueMinor(ad);

    const stopBaseline = ad.stopAllocationBaseline;
    const hasStopBaseline = !!stopBaseline && typeof stopBaseline === 'object' && !Array.isArray(stopBaseline);
    const stopPaid = _localFundingMap(hasStopBaseline ? stopBaseline.receipt : []);
    const stopDue = _localFundingMap(hasStopBaseline ? stopBaseline.due : []);
    const stopMoved = stopDue.get(rid) || 0;
    stopDue.delete(rid);
    const stopLegacy = hasStopBaseline && stopMoved <= 0 && (isDriverLink || isShopLink)
      ? _localFundingMinor(stopBaseline.dueLegacy)
      : 0;
    const refundPaid = _localFundingMap(ad.refundAllocationBaseline);
    const refundDue = _localFundingMap(ad.refundDueBaseline);
    const refundMoved = refundDue.get(rid) || 0;
    refundDue.delete(rid);
    const baselineChanged = stopMoved + stopLegacy + refundMoved > 0;
    if (moved <= 0 && !baselineChanged) continue;

    if (String(ad.customerId || '') !== receiptCustomerId) {
      throw new Error('Linked ad and receipt belong to different customers');
    }

    const next = { ...ad };
    let fullyFunded = false;
    if (moved > 0) {
      paid.set(rid, (paid.get(rid) || 0) + moved);
      const target = _localFundingMinor(ad.spentUSD !== undefined && ad.spentUSD !== null ? ad.spentUSD : ad.amountUSD);
      const totalAfter = [...paid.values(), ...due.values()].reduce((sum, amount) => sum + amount, 0);
      if (totalAfter > target) throw new Error('Linked ad funding exceeds its authoritative amount');

      const receiptAllocations = _localFundingRows(paid);
      const dueAllocations = _localFundingRows(due);
      fullyFunded = totalAfter === target && due.size === 0;
      Object.assign(next, {
        receiptAllocations,
        dueAllocations,
        dueAmountToUseUSD: [...due.values()].reduce((sum, amount) => sum + amount, 0) / 100,
        dueAmountToUseLYD: 0,
        receiptIds: receiptAllocations.map(row => row.receiptId),
        fundingReceiptId: receiptAllocations[0]?.receiptId || ''
      });
      if (fullyFunded) {
        Object.assign(next, {
          paymentStatus: 'paid', isPaid: true, collectionMethod: '', collectionPayments: [],
          paymentMethod: '', linkedDeliveryReceiptId: '', mergedPaidAllocations: [],
          hasMergedPaidFunds: false, receiptId: receiptAllocations[0]?.receiptId || ''
        });
      } else {
        next.paymentStatus = 'not_paid';
        next.isPaid = false;
        next.mergedPaidAllocations = collectionMethod === 'driver'
          ? receiptAllocations.map(row => ({ ...row }))
          : [];
        next.hasMergedPaidFunds = collectionMethod === 'driver' && receiptAllocations.length > 0;
        if (collectionMethod === 'in_shop' && due.size === 0) next.receiptId = '';
      }
    }

    // Frozen stop/refund baselines move even when live funding is zero. A later
    // reconciliation/refund reversal must never resurrect paid money as debt.
    if (hasStopBaseline && (stopMoved > 0 || stopLegacy > 0)) {
      stopPaid.set(rid, (stopPaid.get(rid) || 0) + stopMoved + stopLegacy);
      const baselineReceiptRows = _localFundingRows(stopPaid);
      const nextBaseline = {
        ...stopBaseline,
        receipt: baselineReceiptRows,
        due: _localFundingRows(stopDue),
        dueLegacy: 0
      };
      if (stopDue.size === 0 && [...stopPaid.values()].reduce((sum, amount) => sum + amount, 0) === _localFundingMinor(ad.amountUSD)) {
        nextBaseline.paymentStatus = 'paid';
      }
      nextBaseline.merged = String(nextBaseline.paymentStatus || '') !== 'paid'
        && getAdPaymentState(next) === 'not_paid'
        && String(next.collectionMethod || '') === 'driver'
          ? baselineReceiptRows.map(row => ({ ...row }))
          : [];
      next.stopAllocationBaseline = nextBaseline;
    }
    if (refundMoved > 0) {
      refundPaid.set(rid, (refundPaid.get(rid) || 0) + refundMoved);
      next.refundAllocationBaseline = _localFundingRows(refundPaid);
      next.refundDueBaseline = _localFundingRows(refundDue);
      if (refundDue.size === 0 && [...refundPaid.values()].reduce((sum, amount) => sum + amount, 0) === _localFundingMinor(ad.amountUSD)) {
        next.refundBaselinePaymentStatus = 'paid';
      }
    }

    // A stopped-at-zero or fully refunded ad may have no live due row (only its frozen baseline
    // held the promise): align the badge/provenance once its live rows cover the effective
    // spend, zero included.
    const livePaid = _localFundingMap(next.receiptAllocations);
    const liveDue = _localFundingMap(next.dueAllocations);
    const liveTarget = _localFundingMinor(next.spentUSD !== undefined && next.spentUSD !== null ? next.spentUSD : next.amountUSD);
    if (baselineChanged && liveDue.size === 0 && [...livePaid.values()].reduce((sum, amount) => sum + amount, 0) === liveTarget) {
      const paidRows = _localFundingRows(livePaid);
      const paidIds = paidRows.map(row => row.receiptId);
      Object.assign(next, {
        paymentStatus: 'paid',
        isPaid: true,
        collectionMethod: '',
        collectionPayments: [],
        paymentMethod: '',
        linkedDeliveryReceiptId: '',
        mergedPaidAllocations: [],
        hasMergedPaidFunds: false,
        receiptAllocations: paidRows,
        receiptIds: paidIds,
        fundingReceiptId: paidIds[0] || '',
        receiptId: paidIds[0] || rid,
        dueAmountToUseUSD: 0,
        dueAmountToUseLYD: 0
      });
    }

    Object.assign(next, {
      settledReceiptId: rid,
      receiptSettledAt: now,
      receiptSettledBy: actorId,
      lastUpdated: now,
      _lastModified: getMonotonicTime()
    });
    const plan = { index, data: next };
    plans.push(plan);
    plannedById.set(String(ad.id || ''), next);
  }

  // Simulate the complete batch before changing anything: the newly Paid receipt's one capacity is
  // its amountUSD minus transfers out and every surviving paid/due ad commitment.
  const capacity = _localFundingMinor(receipt.amountUSD);
  let committed = _localReceiptOutgoingMinor(receipt);
  for (const ad of state.ads || []) {
    if (!ad || ad._deleted || String(ad.recordType || '') === 'receipt') continue;
    const simulated = plannedById.get(String(ad.id || '')) || ad;
    committed += _localAdCommittedMinor(simulated, rid);
  }
  if (committed > capacity) throw new Error('Paid receipt balance is insufficient for all linked ads');
  return plans;
}

// Local parity for the server's /unsettle: a funded PAID receipt flipped to Not Paid moves each linked
// ad's paid rows for THIS receipt into its due pool, to the cent (nothing else changes). Blocked cases
// throw the server's own detail strings, localized through describe409 as in server mode.
function planLocalReceiptDebtAdUpdates(receiptId, nextReceipt = null) {
  const rid = String(receiptId || '');
  const receipt = nextReceipt || (state.receipts || []).find(row => row && String(row.id) === rid);
  if (!receipt || receipt._deleted) throw new Error('Receipt not found');
  if (String(receipt.receiptType || '') === 'TRANSFER_IN' || receipt.transferFromReceiptId) {
    throw new Error('A transferred-in receipt must remain paid');
  }
  if (_localReceiptOutgoingMinor(receipt) > 0) {
    throw new Error('A receipt with outgoing transfers must remain paid');
  }
  const receiptCustomerId = String(receipt.customerId || '');
  const notPaidCollection = String(receipt.statusDetail?.notPaidCollection || '').trim().toLowerCase();
  const isDelivery = notPaidCollection === 'delivery'
    || String(receipt.deliveryStatus || '').trim() === 'Needs Delivery';
  const method = isDelivery ? 'driver' : 'in_shop';
  const now = new Date().toISOString();
  const plans = [];
  for (let index = 0; index < (state.ads || []).length; index++) {
    const ad = state.ads[index];
    if (!ad || ad._deleted || String(ad.recordType || '') === 'receipt') continue;
    const paid = _localFundingMap(ad.receiptAllocations);
    const moved = paid.get(rid) || 0;
    if (moved <= 0) {
      // A legacy rowless paid ad charges its spend by reference: no row to migrate, so refuse.
      if (!Array.isArray(ad.receiptAllocations) && !Array.isArray(ad.dueAllocations)
          && _localAdCommittedMinor(ad, rid) > 0) {
        throw new Error('A receipt funding a legacy pre-allocation ad must remain paid');
      }
      continue;
    }
    paid.delete(rid);
    if (String(ad.customerId || '') !== receiptCustomerId) {
      throw new Error('Linked ad and receipt belong to different customers');
    }
    if (['Stopped', 'Canceled', 'Completed', 'Lost'].includes(String(ad.status || ''))
        || (ad.refundType && String(ad.refundType) !== 'None')) {
      throw new Error('A receipt funding a finished or refunded ad must remain paid');
    }
    const due = _localFundingMap(ad.dueAllocations);
    for (const key of due.keys()) {
      if (String(key) !== rid) throw new Error('A receipt funding an ad that owes another receipt must remain paid');
    }
    due.set(rid, (due.get(rid) || 0) + moved);

    const receiptAllocations = _localFundingRows(paid);
    const dueAllocations = _localFundingRows(due);
    const next = {
      ...ad,
      receiptAllocations,
      dueAllocations,
      receiptIds: receiptAllocations.map(row => row.receiptId),
      fundingReceiptId: receiptAllocations[0]?.receiptId || '',
      dueAmountToUseUSD: [...due.values()].reduce((sum, amount) => sum + amount, 0) / 100,
      dueAmountToUseLYD: 0,
      paymentStatus: 'not_paid',
      isPaid: false,
      collectionMethod: method,
      collectionPayments: [],
      paymentMethod: '',
      mergedPaidAllocations: method === 'driver'
        ? receiptAllocations.map(row => ({ ...row }))
        : [],
      hasMergedPaidFunds: method === 'driver' && receiptAllocations.length > 0,
      linkedDeliveryReceiptId: method === 'driver' ? rid : '',
      receiptId: rid,
      lastUpdated: now,
      _lastModified: getMonotonicTime()
    };
    plans.push({ index, data: next });
  }
  return plans;
}

function applyLocalReceiptPaidAdUpdates(plans) {
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!Number.isInteger(plan?.index) || !plan?.data) continue;
    state.ads[plan.index] = plan.data;
  }
  if (Array.isArray(plans) && plans.length > 0) markCollectionDirty('ads');
  return Array.isArray(plans) ? plans.length : 0;
}

/** Update a record in a collection (merge semantics): sanitise, drop protected
 * fields (id, timestamps, ownership), apply locally (optimistic), sync with
 * expectedLastModified; the server version wins, a 409 reloads the latest,
 * errors roll back; permission checks apply; immutable rows are refused. */
function updateRecord(array, id, updates, expectedLastModified) {
  if (!Array.isArray(array) || !Security.isValidRecordId(id)) {
    showNotification('Invalid Record', 'The record id is not allowed.', 'error');
    return Promise.resolve(false);
  }
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const old = { ...array[index] };
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions are immutable. Create a new transaction to correct mistakes.', 'error');
      return Promise.resolve(false);
    }

    const sanitizedUpdates = Security.sanitizeRecord(collectionName, updates);
    const updatesIdCheck = Security.validateRecordIdentifiers(sanitizedUpdates, `${collectionName || 'record'}.updates`);
    if (!updatesIdCheck.valid) {
      showNotification('Invalid Record', updatesIdCheck.error, 'error');
      return Promise.resolve(false);
    }
    // Protected fields never change; createdByName/customerName are creation stamps (the creator once
    // deleted, the customer for receipts/ads-only roles); the live customer name wins on read.
    const protectedFields = ['id', '_created', 'createdBy', 'createdByName', 'customerName', 'createdAt', 'creatorId'];
    for (const field of protectedFields) {
      if (sanitizedUpdates[field] !== undefined) delete sanitizedUpdates[field];
    }
    // Users: only an Admin changes role/permissions/subscriptions; others edit their own profile
    // (name, password, passkeys), never privilege fields.
    if (collectionName === 'users' && state.currentUser && !isAdminRole(state.currentUser.role)) {
      const isSelf = String(state.currentUser.id || '') === String(id || '');
      if (!isSelf) {
        showNotification('Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
        return Promise.resolve(false);
      }
      const blocked = ['role', 'permissions', 'subscriptions'];
      for (const k of blocked) {
        if (sanitizedUpdates[k] !== undefined) delete sanitizedUpdates[k];
      }
    }

    // Not Paid -> Paid moves every linked ad from due to paid funding in ONE transaction, installed
    // together; one stable key per attempt lets a network retry replay it instead of charging twice.
    const _oldReceiptStatus = collectionName === 'receipts'
      ? String(old.status || '').trim().toLowerCase()
      : '';
    // Paid/Not Paid stay consistent for legacy callers sending one side; Canceled/Lost keep their own
    // status (they may hold historical money without being "Paid").
    const _requestedReceiptStatus = collectionName === 'receipts' && sanitizedUpdates.status !== undefined
      ? String(sanitizedUpdates.status || '').trim().toLowerCase()
      : '';
    if (_requestedReceiptStatus === 'paid') sanitizedUpdates.isPaid = true;
    if (_requestedReceiptStatus === 'not paid' || _requestedReceiptStatus === 'not_paid') sanitizedUpdates.isPaid = false;
    if (collectionName === 'receipts'
        && sanitizedUpdates.status === undefined
        && sanitizedUpdates.isPaid === true
        && (_oldReceiptStatus === 'not paid' || _oldReceiptStatus === 'not_paid')) {
      sanitizedUpdates.status = 'Paid';
    }
    const _nextReceiptStatus = collectionName === 'receipts'
      ? String(sanitizedUpdates.status ?? old.status ?? '').trim().toLowerCase()
      : '';
    // EVERY resulting Paid receipt takes the cascade endpoint (it repairs legacy due rows), EXCEPT a
    // paid-keeping edit of only the narrow-grant fields (markCollected / deliveries.*; /settle 403s them).
    const _RECEIPT_NARROW_GRANT_FIELDS = new Set([
      'collected', 'collectedAmount', 'collectedPayments', 'collectedMatchesReceipt',
      'collectedAt', 'collectedBy', 'isReceivedInOffice', 'receivedInOfficeAt',
      'officeHandover', 'officeHandoverAt', 'deliveryPersonId', 'deliveryStatus',
      'acceptedDate', 'deliveryCancelReason', 'deliveryCancelledAt', 'deliveryCancelledBy',
      'deliveryNotes', 'deliveryHistory', 'statusDetail', '_lastModified'
    ]);
    const _narrowPaidKeepingEdit = collectionName === 'receipts'
      && (_oldReceiptStatus === 'paid' || old.isPaid === true)
      && sanitizedUpdates.status === undefined
      && sanitizedUpdates.isPaid === undefined
      && Object.keys(sanitizedUpdates).length > 0
      && Object.keys(sanitizedUpdates).every(key => _RECEIPT_NARROW_GRANT_FIELDS.has(key));
    const _settlesReceipt = collectionName === 'receipts'
      && _nextReceiptStatus === 'paid'
      && !_narrowPaidKeepingEdit;
    const _receiptSettlementKey = _settlesReceipt
      ? Security.generateSecureId('receipt-settlement')
      : '';
    // The REVERSE transition (a PAID receipt edited to Not Paid) moves its funding into the ads' due pool
    // in the SAME commit, to the cent (/unsettle; local planLocalReceiptDebtAdUpdates). The server
    // refuses that PATCH even unfunded; only local mode keeps the ordinary path for those.
    const _convertsReceipt = collectionName === 'receipts'
      && !_settlesReceipt
      && (_oldReceiptStatus === 'paid' || old.isPaid === true)
      && (_nextReceiptStatus === 'not paid' || _nextReceiptStatus === 'not_paid')
      && (isServerModeEnabled() || (state.ads || []).some(ad => ad && !ad._deleted
          && String(ad.recordType || '') !== 'receipt'
          && (_localFundingMap(ad.receiptAllocations).get(String(id)) || 0) > 0));
    const _receiptConversionKey = _convertsReceipt
      ? Security.generateSecureId('receipt-unsettle')
      : '';
    let _localReceiptAdPlans = [];
    if (_settlesReceipt && !isServerModeEnabled()) {
      try {
        _localReceiptAdPlans = planLocalReceiptPaidAdUpdates(id, {
          ...old,
          ...sanitizedUpdates,
          status: 'Paid',
          isPaid: true
        });
      } catch (error) {
        showNotification(
          state.language === 'ar' ? 'تعذر تسوية الوصل' : 'Receipt settlement blocked',
          error?.message || 'Linked ad funding is invalid.',
          'error'
        );
        return Promise.resolve(false);
      }
    } else if (_convertsReceipt && !isServerModeEnabled()) {
      try {
        _localReceiptAdPlans = planLocalReceiptDebtAdUpdates(id, {
          ...old,
          ...sanitizedUpdates,
          status: 'Not Paid',
          isPaid: false
        });
      } catch (error) {
        // Same refusals and wording as server mode (the planner throws server details; describe409 translates).
        const _detail = String(error?.message || '');
        const reason = typeof describe409 === 'function'
          ? describe409({ status: 409, message: _detail }, _detail)
          : _detail;
        showNotification(
          state.language === 'ar' ? 'تعذر تحويل الوصل إلى دين' : 'Receipt conversion blocked',
          reason || 'Linked ad funding is invalid.',
          'error'
        );
        return Promise.resolve(false);
      }
    }

    // The object this call optimistically wrote (null when settle/convert skips that write). Errors roll
    // the slot back only while it still holds THIS object: live sync and chained echoes install newer
    // committed copies there, which the stale open-time snapshot would clobber.
    let _optimisticRecord = null;
    // The last SAVED copy behind this edit: a slot still holding a pending
    // PATCH's optimistic copy hands on that copy's own saved base.
    const _confirmedBase = _patchConfirmedBase.get(array[index]) || old;
    // Optimistic paint, except settlement and its reverse: the receipt is not shown Paid/Not Paid
    // before its linked ads commit too (two contradictory money states).
    if (!((_settlesReceipt || _convertsReceipt) && isServerModeEnabled())) {
      array[index] = { ...array[index], ...sanitizedUpdates, _lastModified: getMonotonicTime() };
      if (isServerModeEnabled() && collectionName === 'adCampaignRequests' && typeof makeLightweightMediaRecord === 'function') {
        array[index] = makeLightweightMediaRecord(collectionName, array[index]);
      }
      _optimisticRecord = array[index];
      if (isServerModeEnabled()) _patchConfirmedBase.set(_optimisticRecord, _confirmedBase);
      // Keep currentUser in sync when updating own user record (important for profile changes)
      if (collectionName === 'users' && state.currentUser?.id === id) {
        state.currentUser = array[index];
      }
      if (collectionName) markCollectionDirty(collectionName);
      const locallyUpdatedAds = applyLocalReceiptPaidAdUpdates(_localReceiptAdPlans);
      saveState();
      addAuditLog('Update', id, `Updated ${getRecordType(array[index])}`, {
        old,
        new: array[index],
        locallySettledAdIds: locallyUpdatedAds > 0
          ? _localReceiptAdPlans.map(plan => String(plan.data?.id || '')).filter(Boolean)
          : []
      });
      RenderQueue.schedule('updateRecord');
    }

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      const _patchChainKey = collectionName + ':' + id;
      // A PATCH already in flight for this record: this edit queues behind it on the FRESH echoed baseline.
      const _queuedBehind = _patchChains.has(_patchChainKey);
      const _providedExpected = Number.isFinite(Number(expectedLastModified))
        ? Number(expectedLastModified)
        : null;
      const _patchIdentity = getServerSessionIdentity();
      const sendPatch = () => {
        // Queued behind a slow PATCH while this account signed out: never send it as the next one.
        if (serverSessionIdentityChanged(_patchIdentity)) return false;
        // The caller's own baseline when given (the modal snapshot edited), so someone else's change
        // in between 409s instead of being overwritten. Queued behind an in-flight PATCH: the
        // record's CURRENT _lastModified (that PATCH's echo replaced it).
        let expected;
        if (_queuedBehind) {
          const cur = array.find(x => x && x.id === id);
          expected = (cur && Number.isFinite(Number(cur._lastModified)))
            ? Number(cur._lastModified)
            : (_providedExpected != null ? _providedExpected : (old._lastModified || 0));
        } else {
          expected = _providedExpected != null ? _providedExpected : (old._lastModified || 0);
        }
        const mutation = _settlesReceipt
          ? apiSettleReceipt({
              receiptId: id,
              expectedLastModified: expected,
              idempotencyKey: _receiptSettlementKey,
              data: sanitizedUpdates
            })
          : (_convertsReceipt
            ? apiUnsettleReceipt({
                receiptId: id,
                expectedLastModified: expected,
                idempotencyKey: _receiptConversionKey,
                data: sanitizedUpdates
              })
            : apiPatchEntity(collectionName, id, sanitizedUpdates, expected));
        return mutation
        .then((entityOrSettlement) => {
          _patchConfirmedBase.delete(_optimisticRecord);
          if (_settlesReceipt || _convertsReceipt) {
            const settlement = entityOrSettlement;
            const [savedReceipt] = applyValidatedServerEntityBatch([
              { collection: 'receipts', entity: settlement.receipt },
              ...settlement.updatedAds.map(entity => ({ collection: 'ads', entity }))
            ], _settlesReceipt ? 'receiptSettlement' : 'receiptDebtConversion');
            addAuditLog('Update', id, `${_settlesReceipt ? 'Settled' : 'Converted to debt'} ${getRecordType(savedReceipt || old)}`, {
              old,
              new: savedReceipt || settlement.receipt?.data,
              updatedAdIds: settlement.updatedAds.map(entity => entity.id),
              replayed: settlement.replayed === true
            });
          } else if (entityOrSettlement?.data) {
            const idx = array.findIndex(x => x && x.id === id);
            if (idx !== -1) {
              array[idx] = Security.sanitizeRecord(collectionName, entityOrSettlement.data);
              if (collectionName) markCollectionDirty(collectionName);
              saveState();
            }
          }
          // Settle/convert skipped the optimistic paint: this echo is the FIRST paint (full render); a
          // plain PATCH echo was painted, so a normal render keeps an identical echo DOM-free.
          if (_settlesReceipt || _convertsReceipt) {
            forceFullRender();
          } else {
            RenderQueue.schedule('patchEcho');
          }
          return true;
        })
        .catch(async (e) => {
          // Only a REAL version conflict ("Conflict: ...") means someone else changed the record (reload
          // and retry). Any other 409 is a business-rule refusal: "changed on another device" sent users
          // chasing phantom editors, so name the real reason.
          const _realConflict = e?.status === 409 &&
            (typeof isVersionConflict409 === 'function'
              ? isVersionConflict409(e)
              : /^conflict:/i.test(String(e?.message || '').trim()));
          if (_realConflict) {
            try {
              const latest = await apiGetEntity(collectionName, id);
              const idx = array.findIndex(x => x && x.id === id);
              let _latestData = null;
              if (idx !== -1 && latest?.data) {
                 _latestData = Security.sanitizeRecord(collectionName, latest.data);
                 array[idx] = collectionName === 'adCampaignRequests' && typeof makeLightweightMediaRecord === 'function'
                   ? makeLightweightMediaRecord(collectionName, _latestData)
                   : _latestData;
                if (collectionName) markCollectionDirty(collectionName);
                saveState();
              }
              // Reload the OPEN modal from the fresh copy, fields AND baseline (a fresh stamp under stale
              // fields let the next Save overwrite the other change); unsaved edits are lost.
              if (_latestData && state.modalData && String(state.modalData.id) === String(id)
                  && idx !== -1 && state.activeModal) {
                state.modalData = array[idx];
                if (typeof reseedClothesEditState === 'function') { try { reseedClothesEditState(collectionName, array[idx]); } catch (_) {} }  // temp rows + baseline follow
                try { if (typeof renderModal === 'function') renderModal(); } catch (_) {}
              }
              // A settle/unsettle whose first attempt committed but lost its answer meets this 409 on the manual
              // retry: "already saved" ONLY if the stored record matches this save field by field (volatile
              // server keys excluded); a miss only shows the honest conflict warning.
              const _volatileMatchKeys = ['_lastModified', 'lastModified', 'updatedAt', 'editHistory', 'editCount', 'collectionDate', 'deliveryHistory', 'customerName', 'createdByName'];
              const _intentMatchesLatest = () => {
                try {
                  return Object.keys(sanitizedUpdates || {}).every(key => {
                    if (_volatileMatchKeys.includes(key)) return true;
                    const sent = sanitizedUpdates[key] === undefined ? null : sanitizedUpdates[key];
                    const stored = _latestData[key] === undefined ? null : _latestData[key];
                    return JSON.stringify(sent) === JSON.stringify(stored);
                  });
                } catch (_) { return false; }
              };
              const _alreadyApplied = !!_latestData && (
                (_settlesReceipt && (String(_latestData.status || '').toLowerCase() === 'paid' || _latestData.isPaid === true)) ||
                (_convertsReceipt && _latestData.isPaid === false)
              ) && _intentMatchesLatest();
              if (_alreadyApplied) {
                showNotification(
                  state.language === 'ar' ? 'تم الحفظ' : 'Already saved',
                  state.language === 'ar'
                    ? 'تم حفظ تغييرك بالفعل رغم انقطاع الشبكة. تم تحميل أحدث نسخة.'
                    : 'Already saved: your first attempt reached the server despite the network error. Showing the latest version.',
                  'success'
                );
              } else {
                showNotification(
                  state.language === 'ar' ? 'تعارض' : 'Conflict',
                  state.language === 'ar'
                    ? 'تم تغيير هذا السجل من مستخدم آخر. تم تحميل أحدث نسخة.'
                    : 'This record was changed by another user. We loaded the latest version.',
                  'warning'
                );
              }
              render();
              return false;
            } catch (err) {
              // fallthrough to rollback
            }
          } else if (e?.status === 409) {
            // Rule refusal: roll back and show the server's reason (localized when known). Restore only
            // while the slot holds this call's optimistic object (a live-sync or echo copy is newer
            // committed money state); settle/convert wrote nothing optimistic.
            const idx = array.findIndex(x => x && x.id === id);
            if (idx !== -1 && _optimisticRecord && array[idx] === _optimisticRecord) {
              array[idx] = old;
              if (collectionName) markCollectionDirty(collectionName);
              saveState();
            }
            const reason = typeof describe409 === 'function' && !/^clothes/.test(collectionName)
              ? describe409(e, String(e?.message || ''))
              : _collectionRefusalText(collectionName, e?.message);
            showNotification(
              state.language === 'ar' ? 'غير مسموح' : 'Not Allowed',
              reason || (state.language === 'ar' ? 'رفض الخادم هذا التعديل.' : 'The server refused this change.'),
              'warning'
            );
            render();
            return false;
          }

          // Rollback, with the rule-refusal branch's identity guard: never over a slot live sync or a
          // chained echo replaced mid-flight; settle/convert (no optimistic write) restore nothing.
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && _optimisticRecord && array[idx] === _optimisticRecord) {
            array[idx] = old;
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
          }
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification(..._sessionExpiredToast(), 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification(..._serverRefusalToast('save', collectionName, e), 'error');
          }
          render();
          return false;
        });
      };
      // A queued edit whose predecessor FAILED is never sent: built on that failed copy, after a conflict
      // reload it would undo another device's change (fast stock taps erasing a sale). A slot still holding
      // our copy reloads; offline it falls back to the last SAVED copy, never `old` (the failed tap's).
      const abandonQueued = async () => {
        if (_optimisticRecord && array.includes(_optimisticRecord)) {
          let fresh = _confirmedBase;
          try {
            const latest = await apiGetEntity(collectionName, id);
            if (latest?.data) fresh = Security.sanitizeRecord(collectionName, latest.data);
          } catch (_) {}
          const idx = array.indexOf(_optimisticRecord);
          if (idx !== -1) {
            array[idx] = collectionName === 'adCampaignRequests' && typeof makeLightweightMediaRecord === 'function'
              ? makeLightweightMediaRecord(collectionName, fresh) : fresh;
            markCollectionDirty(collectionName);
            saveState();
          }
        }
        RenderQueue.schedule('patchAbandoned');
        return false;
      };
      // Chain after any in-flight PATCH of this record; the entry is dropped when it settles.
      const _prevPatch = _patchChains.get(_patchChainKey) || Promise.resolve();
      const _thisPatch = _prevPatch.then(ok => (ok === false ? abandonQueued() : sendPatch()), abandonQueued);
      _patchChains.set(_patchChainKey, _thisPatch);
      const cleanupPatchChain = () => {
        if (_patchChains.get(_patchChainKey) === _thisPatch) _patchChains.delete(_patchChainKey);
      };
      // Not finally(): its derived Promise rejected unhandled even when the caller caught
      // _thisPatch. Both branches here resolve after cleanup.
      _thisPatch.then(cleanupPatchChain, cleanupPatchChain);
      return _thisPatch;
    } else if (isServerModeEnabled() && collectionName === 'users') {
      // Map to server user update API (Admin only)
      const payload = {};
      if (sanitizedUpdates.name !== undefined) payload.name = sanitizedUpdates.name;
      if (sanitizedUpdates.email !== undefined) payload.email = sanitizedUpdates.email;
      if (sanitizedUpdates.role !== undefined) payload.role = sanitizedUpdates.role;
      if (sanitizedUpdates.permissions !== undefined) payload.permissions = sanitizedUpdates.permissions;
      if (sanitizedUpdates._deleted !== undefined) payload.deleted = !!sanitizedUpdates._deleted;

      return apiUpdateUser(id, payload)
        .then((updatedUser) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && updatedUser) {
            array[idx] = { ...array[idx], ...updatedUser, _lastModified: Date.now(), _deleted: false };
            if (collectionName) markCollectionDirty(collectionName);
            saveState();
            render();
          }
          return true;
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          showNotification(..._serverRefusalToast('save', 'users', e), 'error');
          render();
          return false;
        });
    }
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

function deleteRecord(array, id, opts) {
  if (!Array.isArray(array) || !Security.isValidRecordId(id)) {
    showNotification('Invalid Record', 'The record id is not allowed.', 'error');
    return Promise.resolve(false);
  }
  const index = array.findIndex(item => item.id === id);
  if (index !== -1) {
    const collectionName = getCollectionNameFromArray(array);
    if (collectionName === 'walletTransactions') {
      showNotification('Not Allowed', 'Wallet transactions cannot be deleted. Use a reversal transaction.', 'error');
      return Promise.resolve(false);
    }
    if (collectionName === 'serviceSubscriptions') {
      showNotification('Not Allowed', 'Subscription history cannot be deleted.', 'error');
      return Promise.resolve(false);
    }
    const old = { ...array[index] };
    array[index]._deleted = true;
    array[index]._lastModified = getMonotonicTime();
    // Rollbacks below may only restore the slot while it still holds this
    // object (live-sync may install a newer copy mid-flight).
    const _optimisticRecord = array[index];
    if (collectionName) markCollectionDirty(collectionName);
    saveState();
    addAuditLog('Delete', id, `Deleted ${getRecordType(array[index])}`);
    RenderQueue.schedule('deleteRecord');

    // Cascade deletes collect their server pushes into ONE all-or-nothing batch
    // (flushBatchDeletes); local state above is already updated.
    if (opts && Array.isArray(opts.collectServerOps)) {
      if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
        opts.collectServerOps.push({ collection: collectionName, id, old, array, record: _optimisticRecord });
      }
      return Promise.resolve(true);
    }

    // Server write-through (always-online multi-user mode)
    if (isServerModeEnabled() && collectionName && collectionName !== 'users') {
      return apiDeleteEntity(collectionName, id)
        .then((res) => {
          const i = array.findIndex(x => x && x.id === id);
          if (i !== -1 && array[i] === _optimisticRecord && Number(res?.lastModified) > 0) array[i]._lastModified = Number(res.lastModified);
          render();
          return true;
        })
        .catch((e) => {
          if (e?.status === 404) { render(); return true; } // already gone server-side
          // Rollback on failure, only while the slot still holds this call's
          // own object (see _optimisticRecord above).
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && array[idx] === _optimisticRecord) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification(..._sessionExpiredToast(), 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification(..._serverRefusalToast('delete', collectionName, e), 'error');
          }
          render();
          return false;
        });
    } else if (isServerModeEnabled() && collectionName === 'users') {
      return apiUpdateUser(id, { deleted: true })
        .then(() => {
          showNotification(state.language === 'ar' ? 'تم الحذف' : 'Deleted', state.language === 'ar' ? 'تم حذف المستخدم' : 'User deleted', 'success');
          render();
          return true;
        })
        .catch((e) => {
          const idx = array.findIndex(x => x && x.id === id);
          if (idx !== -1 && array[idx] === _optimisticRecord) array[idx] = old;
          if (collectionName) markCollectionDirty(collectionName);
          saveState();
          // Handle 401 - session expired, prompt re-login
          if (e?.status === 401) {
            showNotification(..._sessionExpiredToast(), 'warning');
            _sessionCache = { user: null, timestamp: 0, cacheDurationMs: 10000 };
          } else {
            showNotification(..._serverRefusalToast('delete', 'users', e), 'error');
          }
          render();
          return false;
        });
    }
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

// Push a cascade's soft-deletes as ONE all-or-nothing server transaction
// (POST /api/batch/delete); on failure the local soft-deletes roll back.
async function flushBatchDeletes(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return true;
  if (!isServerModeEnabled()) return true;
  return await apiBatchDeleteEntities(ops.map(o => ({ collection: o.collection, id: o.id })))
    .then((res) => {
      // Adopt the server's tombstone stamps, as the single DELETE does.
      ops.forEach(o => {
        const i = o.array.findIndex(x => x && x.id === o.id), ts = Number(res?.stamps?.[o.collection + ':' + o.id]);
        if (i !== -1 && o.array[i] === o.record && ts > 0) { o.array[i]._lastModified = ts; markCollectionDirty(o.collection); }
      });
      render();
      return true;
    })
    .catch((e) => {
      if (e?.status === 404 || e?.status === 405) {
        // Never fall back to fire-and-forget deletes (a partial cascade).
      }
      // Roll back each local soft-delete while the slot still holds the object this cascade marked.
      ops.forEach(o => {
        const idx = o.array.findIndex(x => x && x.id === o.id);
        if (idx !== -1 && (!o.record || o.array[idx] === o.record)) o.array[idx] = o.old;
        markCollectionDirty(o.collection);
      });
      saveState();
      if (e?.status === 401) showNotification(..._sessionExpiredToast(), 'warning');
      else {  // the rule's own reason (closed month, linked records), named by the record asked for
        const [title, body] = _serverRefusalToast('delete', ops[ops.length - 1]?.collection, e);
        showNotification(title, body + (state.language === 'ar' ? ' — تم التراجع عن الحذف بالكامل.' : ' — the whole delete was rolled back.'), 'error');
      }
      render();
      return false;
    });
}

function getVisibleRecords(array) {
  if (!Array.isArray(array)) return [];
  return array.filter(item => item && !item._deleted);
}

// Safe CSV cell for every user-derived export field: always quoted (a comma, quote or newline shifted
// later columns), and a leading = + - @ or control char gets an apostrophe (Excel/Sheets formula injection).
function csvCell(value) {
  let s = (value === null || value === undefined) ? '' : String(value).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');  // bidi controls reorder neighbouring cells
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function getRecordType(record) {
  if (record.email) return 'User';
  if (record.platform) return 'Customer';
  if (record.category) return 'Page';
  if (record.amountUSD !== undefined) return record.recordType === 'receipt' ? 'Receipt' : 'Ad';
  return 'Record';
}

// ====
// AUDIT LOGGING
// ====

function redactSensitive(obj, depth = 0) {
  if (depth > 12) return null;
  if (obj === null || obj === undefined) return obj;
  // Audit metadata must never duplicate inline image bodies.
  if (typeof obj === 'string' && /^data:image\//i.test(obj.trim())) return '[media omitted]';
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
    if (/^(?:photo|photos|adPhotos|receiptImage|image|images|screenshot|screenshots)$/i.test(k)) {
      const count = Array.isArray(v) ? v.filter(Boolean).length : (v ? 1 : 0);
      out[k] = count ? `[media omitted: ${count}]` : '[no media]';
      continue;
    }
    out[k] = redactSensitive(v, depth + 1);
  }
  return out;
}

function addAuditLog(action, resourceId, description, metadata = {}) {
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
  
  // Newest first
  state.logs.unshift(log);
  
  if (!state.sessionId) {
    state.sessionId = generateId('session');
  }
  
  // IndexedDB (fire-and-forget)
  if (db) {
    saveLogToIndexedDB(log).catch(e => console.warn('IndexedDB save failed:', e));
  }
  
  saveState();
}

// Lightweight logging helper (action: 'create' | 'update' | 'delete' | …).
function addLog(action, resourceType, resourceId, description, metadata = {}) {
  addAuditLog(action, resourceId, description, { resourceType, ...metadata });
}

function isCurrentUserAdmin() {
  return (state.currentUser?.role || '').toLowerCase() === 'admin';
}

// "Secret ideas" gating (UI only). Non-admin users are kept inside Albayan Manager for now.
const PLATFORM_ADMIN_ONLY_VIEWS = new Set(['services-hub', 'control-center', 'smart-systems', 'service-placeholder', 'wallet', 'plans', 'charge-wallet']);

// View -> permission module mapping (used for landing + access checks)
const VIEW_PERMISSION_MODULES = {
  collect: 'receipts',
  reminders: 'customers',
  'control-center': 'analytics',
  analytics: 'analytics',
  customers: 'customers',
  receipts: 'receipts',
  pages: 'pages',
  ads: 'ads',
  deliveries: 'deliveries',
  reconciliation: 'analytics',
  users: 'users',
  audit: 'auditLogs',
  settings: 'settings',
  // Clothes System is open to non-admins holding clothesProducts view/viewOwn
  // (subscription checked inside renderClothesSystemView)
  'clothes-system': 'clothesProducts',
  // Customer self-service portal. This view is deliberately not part of
  // PLATFORM_ADMIN_ONLY_VIEWS; server ownership rules still isolate records.
  'ads-studio': 'adCampaignRequests'
};

const ALBAYAN_MANAGER_VIEW_ORDER = [
  'control-center',
  'analytics',
  'customers',
  'receipts',
  'pages',
  'ads',
  'deliveries',
  'reconciliation',
  'audit',
  'settings',
  'users',
  'clothes-system',
  'ads-studio'
];

function userCanAccessView(user, view) {
  if (!user) return false;
  if (String(view || '') === 'more') return true; // launcher page, per-tile gating inside
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
  // Pick the first view they are allowed to open (the router bounces staff off admin-only views)
  const staff = role.toLowerCase() !== 'admin';
  for (const view of ALBAYAN_MANAGER_VIEW_ORDER) {
    if (staff && PLATFORM_ADMIN_ONLY_VIEWS.has(view)) continue;
    if (userCanAccessView(user, view)) return view;
  }
  return 'no-access';
}

function getPostLoginLandingViewForUser(user) {
  // The studio door leads only into the studio — admins included.
  if (IS_STUDIO_SHELL) return 'ads-studio';
  const roleLower = String(user?.role || '').toLowerCase();
  if (roleLower === 'admin') return 'services-hub';
  return getAlbayanManagerLandingViewForUser(user);
}

function enforceSecretFeaturesGate() {
  // If not logged in, no gating needed.
  if (!state.currentUser) return;
  // The studio shell renders the studio view and nothing else.
  if (IS_STUDIO_SHELL) {
    if (state.currentView !== 'ads-studio') {
      state.currentView = 'ads-studio';
      state.viewData = null;
      saveState();
    }
    return;
  }
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
  // Mirror the router: drivers keep both their dashboard and the Deliveries tab.
  const _deliveryExempt = (view === 'delivery-dashboard' || view === 'deliveries') && isDeliveryRole(state.currentUser?.role);
  if (view && !_deliveryExempt && view !== 'no-access' && !userCanAccessView(state.currentUser, view)) {
    // User doesn't have permission for this view, find first allowed view
    state.currentView = getAlbayanManagerLandingViewForUser(state.currentUser);
    state.viewData = null;
    saveState();
  }
}

// ==========================================
// RECEIPT USAGE / TRANSFER HELPERS
// ==========================================

// A TRANSFER_IN receipt is MOVED money: it counts in the target customer's balance but never in
// business-wide revenue/volume/collection totals (each transferred dollar would count twice).
function isTransferInReceipt(r) {
  return String(r?.receiptType || '') === 'TRANSFER_IN';
}

// receiptId -> the ads naming it as funding, in ONE pass (a per-card scan of every ad froze Receipts on
// phones). The predicate MUST match getReceiptUsageStats' .filter(), in array order (lastUsedAt needs it).
function buildReceiptUsageAdIndex(ads = state.ads) {
  const index = new Map();
  getVisibleRecords(Array.isArray(ads) ? ads : []).forEach(ad => {
    if (ad.recordType === 'receipt') return;
    // A Set: one ad can name the same receipt twice (funding + allocation),
    // and the original .filter() yields it once.
    const ids = new Set();
    const add = value => { const id = String(value || ''); if (id) ids.add(id); };
    add(ad.fundingReceiptId);
    add(ad.receiptId);
    add(ad.linkedDeliveryReceiptId);
    if (Array.isArray(ad.receiptAllocations)) ad.receiptAllocations.forEach(a => add(a && a.receiptId));
    if (Array.isArray(ad.dueAllocations)) ad.dueAllocations.forEach(a => add(a && a.receiptId));
    if (Array.isArray(ad.companyFundingAllocations)) ad.companyFundingAllocations.forEach(a => add(a && a.receiptId));
    ids.forEach(id => {
      const bucket = index.get(id);
      if (bucket) bucket.push(ad);
      else index.set(id, [ad]);
    });
  });
  return index;
}

// Usage stats of a receipt from the ads it funds
function getReceiptUsageStats(receipt, adsByReceiptId = null) {
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

  const receiptId = String(receiptObj.id || '');

  // Ads funded from this receipt: receiptAllocations AND dueAllocations (delivery receipts that
  // became Paid). The index serves real ids only: an id-less record keeps the slow path's (odd)
  // match of every link-less ad.
  const fundedAds = (adsByReceiptId instanceof Map && receiptId)
    ? (adsByReceiptId.get(receiptId) || [])
    : getVisibleRecords(state.ads || []).filter(
      ad => ad.recordType !== 'receipt' && (
        String(ad.fundingReceiptId || '') === receiptId ||
        String(ad.receiptId || '') === receiptId ||
        (Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
        (Array.isArray(ad.dueAllocations) && ad.dueAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
        (Array.isArray(ad.companyFundingAllocations) && ad.companyFundingAllocations.some(a => String(a.receiptId || '') === receiptId)) ||
        String(ad.linkedDeliveryReceiptId || '') === receiptId
      )
    );

  // Used = receiptAllocations + dueAllocations: after Delivered, ads drawing its due amount
  // still use the receipt's funds.
  const usedUSD = fundedAds.reduce((sum, ad) => {
    // Paid rows
    const receiptAllocSum = Array.isArray(ad.receiptAllocations)
      ? ad.receiptAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Due rows (still used once the receipt becomes Paid)
    const dueAllocSum = Array.isArray(ad.dueAllocations)
      ? ad.dueAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Company-covered rows are pot money too (company paid instead of the
    // customer). Skipping them would show covered dollars as free again.
    const companyAllocSum = Array.isArray(ad.companyFundingAllocations)
      ? ad.companyFundingAllocations.filter(a => String(a.receiptId || '') === receiptId).reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0)
      : 0;

    // Legacy due mirrors belong to Driver links (linkedDeliveryReceiptId) or
    // Not Paid In-Shop links (receiptId), but only for ROWLESS ads: once any
    // positive due row exists, the writers keep the scalar mirror equal to the
    // rows' sum, so reading it here would charge the same money twice.
    const hasAnyPositiveDueRow = Array.isArray(ad.dueAllocations)
      && ad.dueAllocations.some(a => (parseFloat(a?.amountUSD) || 0) > 0);
    const legacyDueUsage = !hasAnyPositiveDueRow
      ? getAdLegacyDueMirrorUSD(ad, receiptId, receiptObj.exchangeRate)
      : 0;

    const explicitAllocations = receiptAllocSum + dueAllocSum + legacyDueUsage + companyAllocSum;
    if (explicitAllocations > 0) {
      return sum + explicitAllocations;
    }

    // MONEY-MATH: fall back to spentUSD/amountUSD ONLY for legacy ads with no allocation arrays at all.
    // Present-but-empty arrays (funding receipt deleted) or rows on OTHER receipts mean this receipt
    // funded nothing; charging the full spend would count the same dollars on two receipts.
    const hasAllocationData =
      Array.isArray(ad.receiptAllocations) ||
      Array.isArray(ad.dueAllocations) ||
      Array.isArray(ad.companyFundingAllocations);
    if (hasAllocationData) {
      return sum;
    }

    // A rowless Not Paid Driver/In-Shop reference is provenance, not proof that
    // the receipt funded the whole ad. Only the positive legacy mirror above
    // can turn this link into a commitment.
    const paymentState = typeof getAdPaymentState === 'function'
      ? getAdPaymentState(ad)
      : (ad.isPaid === true ? 'paid' : 'not_paid');
    if (paymentState === 'not_paid' && ['driver', 'in_shop'].includes(String(ad.collectionMethod || ''))) {
      return sum;
    }

    const spend = ad.spentUSD ?? ad.amountUSD ?? 0;
    return sum + spend;
  }, 0);

  const transfers = receiptObj.transfers || [];
  const transferredUSD = transfers.reduce((sum, t) => sum + (t.amountUSD || 0), 0);

  // A settled receipt's amountUSD is CUSTOMER cash only; the company-covered
  // share is equally real pot money (it keeps funding the ads it covered).
  // Mirrors the server's capacity reader exactly.
  const isPaidReceipt = receiptObj.isPaid === true || String(receiptObj.status || '') === 'Paid';
  const coveredUSD = isPaidReceipt ? Math.max(parseFloat(receiptObj.companyCoveredUSD) || 0, 0) : 0;
  const totalUSD = (receiptObj.amountUSD || 0) + coveredUSD;
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

// Compute usage stats for a receipt's promised/due amount (Not Paid receipts).
// This covers both delivery debt and unpaid In Shop receipt budgets.
function getDeliveryReceiptDueUsage(receipt) {
  const receiptObj = typeof receipt === 'string'
    ? (state.receipts || []).find(r => r.id === receipt)
    : receipt;

  if (!receiptObj) {
    return { totalDueUSD: 0, usedDueUSD: 0, remainingDueUSD: 0, fundedAds: [] };
  }

  // ONE POT: "delivery due" and "paid balance" are two names for one sum. Both readers are
  // views over the SAME committed total (getReceiptUsageStats sums every commitment).
  const exchangeRate = receiptObj.exchangeRate || state.defaultExchangeRate || 1;
  const dueAmountLocal = Number(receiptObj.debtAmountLocal ?? receiptObj.amountLocal ?? 0) || 0;
  const debtUSD = exchangeRate > 0 ? dueAmountLocal / exchangeRate : 0;
  const statusDetail = receiptObj.statusDetail && typeof receiptObj.statusDetail === 'object'
    ? receiptObj.statusDetail
    : {};
  const notPaidCollection = String(statusDetail.notPaidCollection || '').trim().toLowerCase();

  // Capacity: the debt the driver will collect until collection, then what was ACTUALLY collected
  // (amountUSD); the debt fields stay as history (re-reading them invents balance).
  const collected = receiptObj.isPaid === true || String(receiptObj.status || '') === 'Paid';
  const isShopReceipt = ['office', 'in_shop', 'shop'].includes(notPaidCollection);
  const totalDueUSD = (collected || isShopReceipt)
    ? (Number(receiptObj.amountUSD) || 0)
    : debtUSD;

  // Count only EXPLICIT commitments (rows in either pool, or the legacy due mirror), NOT
  // getReceiptUsageStats.usedUSD: its whole-ad fallback charges an ad's spend to any receipt it merely
  // REFERENCES, and a driver-collected ad is paid in cash, so that would destroy real customer credit.
  const receiptId = String(receiptObj.id || '');
  const fundedAds = [];
  let usedDueUSD = 0;
  let usedCompanyUSD = 0;
  for (const ad of getVisibleRecords(state.ads || [])) {
    if (!ad || ad._deleted || ad.recordType === 'receipt') continue;
    const sumFor = (rows) => (Array.isArray(rows) ? rows : [])
      .filter(a => String(a.receiptId || '') === receiptId)
      .reduce((s, a) => s + (parseFloat(a.amountUSD) || 0), 0);

    const paidRows = sumFor(ad.receiptAllocations);
    const dueRows = sumFor(ad.dueAllocations);
    // Company-covered rows hold pot money like due rows (never funding new ads), kept apart from
    // usedDueUSD: customerOutstandingUSD already excludes covered dollars.
    const companyRows = sumFor(ad.companyFundingAllocations);

    // The legacy mirror speaks only for a ROWLESS ad: with any positive due row it is the rows' sum.
    let legacyDue = 0;
    const hasAnyPositiveDueRow = Array.isArray(ad.dueAllocations)
      && ad.dueAllocations.some(a => (parseFloat(a?.amountUSD) || 0) > 0);
    if (!hasAnyPositiveDueRow) legacyDue = getAdLegacyDueMirrorUSD(ad, receiptId, exchangeRate);

    const committed = paidRows + dueRows + legacyDue;
    if (committed > 0) {
      usedDueUSD += committed;
    }
    if (companyRows > 0) {
      usedCompanyUSD += companyRows;
    }
    if (committed > 0 || companyRows > 0) {
      fundedAds.push(ad);
    }
  }

  // transferredUSD reads only receiptObj.transfers (getReceiptUsageStats' reduce): calling that
  // here was a SECOND full ads scan per receipt in every keystroke render.
  const transfers = receiptObj.transfers || [];
  const transferredUSD = transfers.reduce((sum, t) => sum + (t.amountUSD || 0), 0) || 0;
  const remainingDueUSD = Math.max(
    totalDueUSD - usedDueUSD - usedCompanyUSD - transferredUSD, 0
  );

  return {
    totalDueUSD,
    usedDueUSD,
    usedCompanyUSD,
    remainingDueUSD,
    fundedAds,
    exchangeRate
  };
}

// Canonical receipt status for filters and debt reports: old spellings (Pending, Unpaid, Cancelled)
// map at read time to Not Paid / Canceled, so financial history is never rewritten.
function getReceiptPaymentState(receipt) {
  if (!receipt || receipt._deleted) return 'unknown';
  const status = String(receipt.status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  if (status === 'canceled' || status === 'cancelled') return 'canceled';
  // A destroyed (torn, never-used) receipt reads as canceled: never debt, revenue or attention.
  if (status === 'destroyed') return 'canceled';
  if (status === 'lost') return 'lost';
  if (status === 'paid') return 'paid';
  if (status === 'notpaid' || status === 'unpaid' || status === 'pending') return 'not_paid';

  if (receipt.isPaid === true) return 'paid';
  if (receipt.isPaid === false) return 'not_paid';
  return 'unknown';
}

// Bilingual wrappers for the raw server refusal toasts: known rules translated, anything else
// still shown (never hidden) under a bilingual title and a human noun, never the collection name.
const _SERVER_REFUSAL_AR = [
  ['Receipt type is server-controlled', 'نوع الوصل يحدده الخادم ولا يمكن تغييره.'],
  ['Receipt transfer fields are server-controlled', 'حقول تحويل الوصل يحددها الخادم.'],
  ['Meta synchronization fields are server-controlled', 'حقول مزامنة ميتا يحددها الخادم.'],
  ['Meta page identity fields are server-controlled', 'هوية صفحة ميتا يحددها الخادم.'],
  ['Company coverage fields are server-controlled', 'حقول تغطية الشركة يحددها الخادم.'],
  ['Ad payment classification requires the transactional ad API', 'تغيير تصنيف دفع الإعلان يتم من نموذج الإعلان فقط.'],
  ['Ad funding and stopping require the transactional ad API', 'تمويل الإعلان وإيقافه يتمان من نموذج الإعلان فقط.'],
  ['Ad page not found', 'صفحة الإعلان غير موجودة.'],
  ['Only a paid receipt can convert its funding to customer debt', 'الوصل المدفوع فقط يمكن تحويل تمويله إلى دين على العميل.'],
  ['This customer was merged', 'دُمج هذا العميل في عميل آخر؛ اختر العميل الباقي.'],
  ['This customer was deleted', 'تم حذف هذا العميل؛ يجب استرجاعه أولاً.'],
  ['Ad customer not found', 'عميل الإعلان غير موجود أو محذوف.'],
  ['This imported ad ran on Facebook page', 'هذا الإعلان يخص صفحة فيسبوك أخرى؛ اختر الصفحة المطابقة أو اطلب من المدير تغييرها.'],
  // [prefix or /regex/ ($1 allowed), Arabic, optional English]
  [/^Financial period (\S+) is being closed.*/, 'الشهر $1 قيد الإقفال أو الفتح الآن؛ أعد المحاولة بعد لحظات.'],
  [/^Financial period (\S+) is closed.*/, 'الشهر $1 مُقفل مالياً؛ اطلب من المدير فتحه قبل التعديل.'],
  [/^(Receipt number|serialNumber|\w+ReceiptNo) already exists/, 'رقم الوصل هذا مسجّل لوصل آخر. تأكد من الرقم ثم أعد المحاولة.', 'This receipt number is already used by another receipt. Check the number and try again.'],
  ['The ad budget cannot go below the company funds already recorded on it', 'لا يمكن إنزال ميزانية الإعلان تحت المبلغ الذي غطّته الشركة له. أوقف الإعلان على مصروفه الحقيقي، وسيرجع الزائد إلى أموال الشركة.', 'The ad budget cannot go below the company money already recorded on it. Stop the ad at its real spend instead; the extra goes back to company funds.'],
  ['Company money on this ad cannot be returned automatically', 'لا يمكن إرجاع أموال الشركة عن هذا الإعلان تلقائياً لأنها مسجّلة على وصل ما زال غير مدفوع. سدّد ذلك الوصل أولاً، أو أبقِ المصروف مساوياً لمبلغ الشركة أو أعلى منه.'],
  ["Spent amount exceeds the ad's funding baseline", 'المبلغ المصروف أكبر من التمويل المسجّل لهذا الإعلان.'],
  [/^Receipt (\S+ )?cannot be deleted while linked to .*/, 'هذا الوصل مرتبط بتمويل إعلان أو بتحويل، فلا يمكن حذفه. حرّر هذه الارتباطات أولاً.', 'This receipt is linked to ad funding or a transfer, so it cannot be deleted. Release those links first.'],
  ['An ad paid from company funds cannot be deleted', 'هذا الإعلان مدفوع من أموال الشركة، لذلك لا يمكن حذفه. أوقفه بدلاً من ذلك.', 'This ad was paid from company funds, so it cannot be deleted. Stop it instead.'],
  ['Customer cannot be deleted while linked records exist', 'لا يمكن حذف العميل لوجود وصولات أو إعلانات مرتبطة به.'],
  ['At least one valid phone number is required', 'رقم هاتف صحيح واحد على الأقل مطلوب (من 7 إلى 15 رقماً).', 'At least one valid phone number is required (7 to 15 digits).'],
  ['This phone number is already linked to another customer', 'رقم الهاتف هذا مسجّل لعميل آخر؛ ابحث عنه واستخدم العميل الموجود.'],
  // A re-press of a pinned new form whose first Save went through (its answer was lost) but differs now
  [/^(?:Order ID|ID|Record with this ID) already exists$/, 'حُفظ هذا السجل في الحفظ الأول. أغلق النموذج وافتحه من القائمة لتعديله.', 'This was already saved by your first Save. Close the form and open it from the list to change it.'],
  // Users: create / edit / delete
  ['This account has campaigns under review or approved', 'لهذا الحساب حملات قيد المراجعة أو معتمدة؛ قرّر فيها أو أوقفها أولاً.'],
  ['This account has payment requests waiting for confirmation', 'لهذا الحساب طلبات دفع تنتظر التأكيد؛ ألغِها أولاً.'],
  ['This account still has money in its wallet', 'ما زال في محفظة هذا الحساب مال؛ حوّله إلى مستخدم آخر أولاً ثم احذف الحساب.'],
  ['This driver still has open delivery jobs', 'لدى هذا السائق مهام توصيل مفتوحة؛ أعد إسنادها أو أنهِها أولاً.'],
  ['A user with this email already exists', 'يوجد مستخدم بهذا البريد الإلكتروني بالفعل.'],
  ['Conflict: this user was changed by someone else', 'عدّل مدير آخر هذا المستخدم للتو؛ أعد فتح النموذج وحاول مجدداً.', 'Another manager just changed this user; reopen the form and try again.'],
  ['Cannot remove the last remaining admin', 'لا يمكن إزالة آخر مدير؛ رقِّ مستخدماً آخر إلى مدير أولاً.'],
  ['Cannot change the role of a user who holds permissions you do not', 'لا يمكنك تغيير دور مستخدم يملك صلاحيات لا تملكها.'],
  ['Cannot reset the password of a user who holds permissions you do not', 'لا يمكنك تغيير كلمة مرور مستخدم يملك صلاحيات لا تملكها.'],
  ["Reassign a paid receipt's customer", 'وصل له رصيد أو إعلانات لا يتغير عميله بالتعديل؛ استخدم تحويل رصيد الوصل.', 'A receipt with money or ads keeps its customer; use a receipt balance transfer.'],
  ['A canceled receipt the company already covered', 'غطّت الشركة هذا الوصل الملغى فلا يُعاد فتحه؛ سجّل وصلاً جديداً.'],
  ['The company already covered', 'لا يمكن أن يقل مبلغ الوصل عن المبلغ الذي غطّته الشركة منه.'],
  ['This receipt is partly covered by the company', 'هذا الوصل مغطّى جزئياً من الشركة: سجّل مبلغ الوصل الكامل أو المبلغ الصافي الذي دفعه العميل فعلاً.'],
  ['Insufficient available receipt balance', 'رصيد الوصل المتاح لا يكفي.'],
  ['A Paid receipt cannot be changed to Not Paid with a normal', 'حدّث الصفحة ثم أعد المحاولة.', 'Refresh the page and try again.'],
  ["Paid receipt funding must exactly settle the customer's share", 'يجب أن يساوي تمويل الوصولات حصة العميل غير المدفوعة بالضبط.'],
  ['Complete this imported Meta ad', 'أكمل العميل والدفع لإعلان Meta المستورد أولاً.'],
  // Deliveries (a driver's screen): a status named in the Arabic goes through trStatus
  [/^Delivery is already '(.+)'.*/, (m, s) => `حالة هذا التوصيل الآن: ${trStatus(s)}؛ حدّث القائمة.`],
  [/^Cannot change (?:delivery )?status from '(.+?)' - this is a terminal state.*/, (m, s) => `حالة هذا التوصيل «${trStatus(s)}» نهائية ولا يمكن تغييرها؛ حدّث القائمة.`],
  [/^Cannot change status from '(.+?)' to '(.+?)' - a delivery job cannot be reopened.*/, (m, a, b) => `لا يُنقل التوصيل من «${trStatus(a)}» إلى «${trStatus(b)}»: مهمة التوصيل لا يُعاد فتحها ولا ترجع للخلف.`],
  ['Collected amount far exceeds the delivery debt', 'المبلغ المحصّل أكبر بكثير من دين التوصيل. تأكد من المبلغ (ربما أصفار زائدة) أو اطلب تأكيد المكتب.', 'The collected amount is far above the delivery debt. Check the amount (extra zeros?) or ask the office to confirm.'],
  ['An accepted delivery job cannot move back', 'التوصيل المقبول لا يعود إلى «بحاجة توصيل»؛ ألغِه أو احذف المهمة.'],
  ['A finished delivery job keeps its driver', 'التوصيل المنتهي يبقى مع سائقه ولا يُحوَّل إلى سائق آخر.'],
  [/^(Assign an|deliveryPersonId must be an) active delivery user.*/, 'اختر سائق توصيل نشطاً.']
];
function _serverRefusalText(raw) {
  raw = String(raw || '').trim();
  const hit = _SERVER_REFUSAL_AR.find(([en]) => en.test ? en.test(raw) : raw.startsWith(en));
  const out = hit?.[state.language === 'ar' ? 1 : 2];
  return out ? (hit[0].test ? raw.replace(hit[0], out) : out) : raw;
}
// Clothes refusals read the Clothes map (lazy clothes.js) first: it names the product, never its id.
function _collectionRefusalText(collectionName, raw) {
  return /^clothes/.test(collectionName) && typeof clothesServerDetailText === 'function' ? clothesServerDetailText(raw) : _serverRefusalText(raw);
}
function _serverRefusalNoun(collectionName) {
  const isAr = state.language === 'ar';
  const nouns = {
    receipts: ['الوصل', 'receipt'], ads: ['الإعلان', 'ad'], customers: ['العميل', 'customer'],
    pages: ['الصفحة', 'page'], users: ['المستخدم', 'user'], deliveries: ['التوصيل', 'delivery'],
    clothesProducts: ['المنتج', 'product'], clothesShipments: ['الشحنة', 'shipment'], clothesOrders: ['الطلب', 'order']
  };
  const pair = nouns[String(collectionName || '')] || ['السجل', 'record'];
  return isAr ? pair[0] : pair[1];
}
// No answer (dropped connection, timeout); an app error raised while offline keeps its own words.
function _isConnectionFailure(error) {
  return !error?.status && (error?.name === 'AbortError' || error?.name === 'TypeError')
    && typeof describeNetworkError === 'function' && !!describeNetworkError(error);
}
function _serverRefusalToast(action, collectionName, error) {
  const isAr = state.language === 'ar';
  const raw = String(error?.message || '').trim();
  const status = Number(error?.status) || 0;
  if (status === 403 && (!raw || /^forbidden$/i.test(raw))) return [isAr ? 'غير مسموح' : 'Not allowed', isAr ? 'ليس لديك صلاحية لهذا الإجراء.' : "You don't have permission for this action."];
  const detail = _collectionRefusalText(collectionName, raw);
  const noun = _serverRefusalNoun(collectionName);
  const verbs = { save: ['فشل حفظ', 'Failed to save'], create: ['فشل إنشاء', 'Failed to create'], delete: ['فشل حذف', 'Failed to delete'] };
  const verb = (verbs[action] || verbs.save)[isAr ? 0 : 1];
  if (_isConnectionFailure(error)) {  // the write may have committed: never "nothing was saved"
    const del = action === 'delete';
    return [isAr ? 'مشكلة في الاتصال' : 'Connection problem', `${verb} ${noun}: ${isAr
      ? `لم يرد الخادم، فتعذّر تأكيد ${del ? 'الحذف' : 'الحفظ'} وربما تم. ${del ? 'راجع القائمة قبل المحاولة مرة أخرى.' : 'ما أدخلته ما زال في النموذج: راجع القائمة قبل إدخاله مرة أخرى.'}`
      : `the server did not answer, so the ${del ? 'delete' : 'save'} could not be confirmed and may have gone through. ${del ? 'Check the list before trying again.' : 'What you entered is still in the form: check the list before entering it again.'}`}`];
  }
  return [
    status > 399 && status < 500 ? (isAr ? 'غير مسموح' : 'Not allowed') : (isAr ? 'خطأ في الخادم' : 'Server Error'),  // a refusal names its rule, never "server error"
    `${verb} ${noun}: ${detail || (isAr ? 'خطأ' : 'Error')}${status >= 500 ? ` (${status})` : ''}`
  ];
}
function _sessionExpiredToast() {
  const isAr = state.language === 'ar';
  return [
    isAr ? 'انتهت الجلسة' : 'Session Expired',
    isAr ? 'انتهت جلستك. يرجى تسجيل الخروج ثم الدخول مرة أخرى.' : 'Your session has expired. Please log out and log back in.'
  ];
}

// Delivery identity is independent of payment: strong persisted markers first; deliveryPersonId
// is only a fallback for older records that predate statusDetail/receiptType.
function isDeliveryReceiptRecord(receipt) {
  if (!receipt || receipt._deleted) return false;
  const detail = receipt.statusDetail && typeof receipt.statusDetail === 'object'
    ? receipt.statusDetail
    : {};
  const unpaidCollection = String(detail.notPaidCollection || '').trim().toLowerCase();
  const paidCollection = String(detail.paidCollection || '').trim().toLowerCase();
  const receiptType = String(receipt.receiptType || '').trim().toUpperCase();
  const tempNo = String(receipt.tempReceiptNo || '').trim();
  const deliveryStatus = String(receipt.deliveryStatus || '').trim().toLowerCase();

  if (unpaidCollection === 'delivery' || paidCollection === 'delivery') return true;
  if (receiptType === 'DELIVERY_TEMP') return true;
  if (/^D\d+$/i.test(tempNo)) return true;
  if (deliveryStatus && deliveryStatus !== 'office') return true;

  const explicitShop = ['office', 'in_shop', 'shop'].includes(unpaidCollection);
  return !explicitShop && !!String(receipt.deliveryPersonId || detail.paidDeliveryPersonId || '').trim();
}

// The CURRENT customer debt source (collection/reconciliation never decides whether money is owed).
function getReceiptDebtType(receipt) {
  if (!receipt || receipt._deleted) return 'none';
  const receiptType = String(receipt.receiptType || '').trim().toUpperCase();
  if (receiptType === 'TRANSFER_IN') return 'none';
  if (getReceiptPaymentState(receipt) !== 'not_paid') return 'none';
  // A canceled delivery keeps its payment label/history, but its debt is released (never
  // collected): keep it out of customer-debt totals and filters.
  const deliveryStatus = String(receipt.deliveryStatus || '').trim().toLowerCase();
  if (deliveryStatus === 'canceled' || deliveryStatus === 'cancelled') return 'none';
  return isDeliveryReceiptRecord(receipt) ? 'delivery' : 'shop';
}

// Locale for every user-visible date: Arabic phones default to ar-SA (Hijri, Arabic-Indic digits: 2026
// showed as ١٤٤٨); the -u- keys pin Gregorian and latin digits (supported far below iOS 15).
function appDateLocale() {
  return state.language === 'ar' ? 'ar-LY-u-ca-gregory-nu-latn' : 'en-GB';
}

function formatDateShort(date) {
  const never = state.language === 'ar' ? 'أبداً' : 'Never';
  if (!date) return never;
  try {
    return new Date(date).toLocaleString(appDateLocale());
  } catch (e) {
    return never;
  }
}

/** The ad's effective exchange rate, the same everywhere. Priority: linked delivery receipt's rate; weighted
 * average of its receipt allocations; single funding receipt's rate; the ad's own rate; the state default. */
function getEffectiveExchangeRate(ad) {
  if (!ad) return state.defaultExchangeRate || 1;

  // 1. Linked delivery receipt's rate
  if (ad.linkedDeliveryReceiptId) {
    const linkedReceipt = state.receipts.find(r => r.id === ad.linkedDeliveryReceiptId);
    if (linkedReceipt?.exchangeRate) {
      return linkedReceipt.exchangeRate;
    }
  }

  // 2. Weighted average of receipt allocations
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

  // 3. dueAllocations
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
