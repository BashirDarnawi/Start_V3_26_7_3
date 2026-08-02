// ==========================================
// SEARCH & FILTER FUNCTIONS
// ==========================================

// Return one canonical payment state for both current and historical ads.
// Older imports used spaces, hyphens, "unpaid", and apostrophes, while some
// records only have the legacy isPaid boolean.  An explicit status wins over
// isPaid so a stale boolean can never make a known customer debt look paid.
function getAdPaymentState(ad) {
  const rawStatus = String(ad?.paymentStatus ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');

  if (rawStatus === 'paid') return 'paid';
  if (['not_paid', 'notpaid', 'unpaid'].includes(rawStatus)) return 'not_paid';
  if (['wont_pay', 'wontpay'].includes(rawStatus)) return 'wont_pay';
  if (typeof ad?.isPaid === 'boolean') return ad.isPaid ? 'paid' : 'not_paid';

  // Very old records without either field were created before unpaid ads
  // existed, so retaining the historical paid default is the safest choice.
  return 'paid';
}

// Canonical client-side record scope. The server is authoritative and already
// returns scoped collections, but this guard also protects local mode, stale
// offline caches, and permission changes that happen before the next reload.
function getRecordsVisibleToCurrentUser(moduleName, records) {
  const visible = getVisibleRecords(Array.isArray(records) ? records : []);
  if (isCurrentUserAdmin() || currentUserHasPermission(moduleName, 'view')) return visible;
  if (!currentUserHasPermission(moduleName, 'viewOwn')) return [];

  const userId = String(state.currentUser?.id || '');
  if (isDeliveryRole(state.currentUser?.role) && (moduleName === 'ads' || moduleName === 'receipts')) {
    return visible.filter(record => String(record?.deliveryPersonId || '') === userId);
  }
  return visible.filter(record =>
    String(record?.createdBy || record?.creatorId || '') === userId
  );
}

function getAdsVisibleToCurrentUser() {
  return getRecordsVisibleToCurrentUser('ads', state.ads)
    .filter(ad => ad.recordType !== 'receipt');
}

function getReceiptsVisibleToCurrentUser() {
  return getRecordsVisibleToCurrentUser('receipts', state.receipts);
}

function getPagesVisibleToCurrentUser() {
  return getRecordsVisibleToCurrentUser('pages', state.pages);
}

// Current receipts use customerId. Very old local/imported receipts used the
// `customer` relationship field instead. A non-empty customerId is always
// authoritative so a stale legacy value cannot attach one receipt to two
// customers.
function getReceiptCustomerReferenceId(receipt) {
  const customerId = String(receipt?.customerId || '').trim();
  return customerId || String(receipt?.customer || '').trim();
}

// One canonical relationship reader for Receipt -> Ads navigation. This is a
// history drill-down, not a money calculation, so it includes both live links
// and frozen stop/refund funding baselines. settledReceiptId is settlement
// provenance rather than a funding relationship and intentionally does not
// match.
function getAdLinkedReceiptIds(ad) {
  if (!ad || ad._deleted || ad.recordType === 'receipt') return [];
  const ids = new Set();
  const add = value => {
    const id = String(value || '').trim();
    if (id) ids.add(id);
  };
  [ad.receiptId, ad.fundingReceiptId, ad.linkedDeliveryReceiptId, ad.linkedReceiptId].forEach(add);
  if (Array.isArray(ad.receiptIds)) ad.receiptIds.forEach(add);
  [ad.receiptAllocations, ad.dueAllocations, ad.mergedPaidAllocations].forEach(rows => {
    if (Array.isArray(rows)) rows.forEach(row => add(row?.receiptId));
  });
  [ad.stopAllocationBaseline, ad.refundAllocationBaseline, ad.refundDueBaseline].forEach((baseline, index) => {
    if (Array.isArray(baseline)) {
      baseline.forEach(row => add(row?.receiptId));
      return;
    }
    if (!baseline || typeof baseline !== 'object') return;
    if (index === 0) add(baseline.dueLegacyReceiptId);
    Object.values(baseline).forEach(rows => {
      if (Array.isArray(rows)) rows.forEach(row => add(row?.receiptId));
    });
  });
  return Array.from(ids);
}

function isAdLinkedToReceipt(ad, receiptId) {
  const rid = String(receiptId || '').trim();
  return Boolean(rid) && getAdLinkedReceiptIds(ad).includes(rid);
}

function openCustomerReceipts(customerId) {
  const cid = String(customerId || '').trim();
  const allowed = typeof canOpenWorkspaceView === 'function' && canOpenWorkspaceView('receipts');
  const visibleCustomer = Security.isValidRecordId(cid)
    && getCustomersVisibleToCurrentUser().some(customer => String(customer?.id || '') === cid);
  if (!allowed || !visibleCustomer) {
    showNotification(
      state.language === 'ar' ? 'تعذر فتح الوصولات' : 'Cannot Open Receipts',
      state.language === 'ar' ? 'لا تملك صلاحية عرض وصولات هذا العميل.' : 'You do not have permission to view this customer’s receipts.',
      'error'
    );
    return false;
  }
  // This outside action promises every receipt for the customer, so discard a
  // stale list search/dropdown combination before applying the relationship.
  state.receiptSearch = '';
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptDebtFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  state.receiptCustomerFilter = cid;
  state.receiptRecordFilter = '';
  navigateTo('receipts');
  return true;
}

function clearReceiptCustomerFilter() {
  state.receiptCustomerFilter = '';
  if (state.currentView === 'receipts') updateUrlForView('receipts', true);
  debouncedSaveState();
  render();
}

// Open one exact receipt from a warning or drill-down without relying on a
// customer name/serial search. The permission-scoped receipt list is checked
// first so a guessed id can never reveal a cached record.
function openReceiptRecord(receiptId) {
  const rid = String(receiptId || '').trim();
  const receipt = Security.isValidRecordId(rid)
    ? getReceiptsVisibleToCurrentUser().find(item => String(item?.id || '') === rid)
    : null;
  const allowed = typeof canOpenWorkspaceView === 'function' && canOpenWorkspaceView('receipts');
  if (!allowed || !receipt) {
    showNotification(
      state.language === 'ar' ? 'تعذر فتح الوصل' : 'Cannot Open Receipt',
      state.language === 'ar' ? 'لا تملك صلاحية عرض هذا الوصل.' : 'You do not have permission to view this receipt.',
      'error'
    );
    return false;
  }

  state.receiptSearch = '';
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptDebtFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  state.receiptCustomerFilter = getReceiptCustomerReferenceId(receipt);
  state.receiptRecordFilter = rid;
  navigateTo('receipts');
  return true;
}

function clearReceiptRecordFilter() {
  state.receiptRecordFilter = '';
  if (state.currentView === 'receipts') updateUrlForView('receipts', true);
  debouncedSaveState();
  render();
}

function openReceiptAds(receiptId) {
  const rid = String(receiptId || '').trim();
  const allowed = typeof canOpenWorkspaceView === 'function' && canOpenWorkspaceView('ads');
  const visibleReceipt = Security.isValidRecordId(rid)
    && getReceiptsVisibleToCurrentUser().some(receipt => String(receipt?.id || '') === rid);
  if (!allowed || !visibleReceipt) {
    showNotification(
      state.language === 'ar' ? 'تعذر فتح الإعلانات' : 'Cannot Open Ads',
      state.language === 'ar' ? 'لا تملك صلاحية عرض الإعلانات المرتبطة بهذا الوصل.' : 'You do not have permission to view ads linked to this receipt.',
      'error'
    );
    return false;
  }
  state.adSearch = '';
  state.adFilters = { status: 'all', payment: 'all', page: 'all' };
  state.adReceiptFilter = rid;
  navigateTo('ads');
  return true;
}

function clearAdReceiptFilter() {
  state.adReceiptFilter = '';
  if (state.currentView === 'ads') updateUrlForView('ads', true);
  debouncedSaveState();
  render();
}

// Meta-first automation creates a financially neutral draft. Keep that state
// separate from "not paid": a draft has no customer debt until a person opens
// it, chooses the customer/payment/receipt details, and successfully saves it.
function isMetaAdSetupPending(ad) {
  if (!ad || typeof ad !== 'object') return false;
  return String(ad.metaImportState || '').toLowerCase() === 'needs_completion'
    || String(ad.paymentStatus || '').toLowerCase() === 'pending_setup';
}

function getFilteredAds(customersById = null) {
  let filtered = getAdsVisibleToCurrentUser();

  const receiptFilter = String(state.adReceiptFilter || '').trim();
  if (receiptFilter) {
    filtered = filtered.filter(ad => isAdLinkedToReceipt(ad, receiptFilter));
  }

  // Dropdown filters (status / payment / page) — state.adFilters is kept in
  // sync by updateAdFilter(); 'all' or unset means no filtering.
  const f = state.adFilters || {};
  if (f.status && f.status !== 'all') {
    filtered = filtered.filter(ad => String(ad.status || '') === f.status);
  }
  if (f.payment && f.payment !== 'all') {
    filtered = filtered.filter(ad => {
      const needsSetup = isMetaAdSetupPending(ad);
      if (f.payment === 'pending_setup') return needsSetup;
      const paymentState = getAdPaymentState(ad);
      if (f.payment === 'paid') return !needsSetup && paymentState === 'paid';
      if (f.payment === 'wont_pay') return !needsSetup && paymentState === 'wont_pay';
      return !needsSetup && paymentState === 'not_paid';
    });
  }
  if (f.page && f.page !== 'all') {
    filtered = filtered.filter(ad => String(ad.pageId || '') === String(f.page));
  }

  // Read the search term from state (kept in sync by the debounced input handler).
  // Fall back to the DOM only if state hasn't been set yet.
  // foldSearchText on BOTH sides: Arabic-keyboard digits (٠-٩) and unhamza'd
  // Arabic spellings must match the ASCII/canonical stored values.
  const searchTerm = foldSearchText(
    state.adSearch != null ? state.adSearch : (document.getElementById('ad-search')?.value || '')
  ).trim();

  if (searchTerm) {
    // PERFORMANCE: one Map lookup per ad instead of scanning the whole customers
    // array for every ad on every keystroke.
    const custMap = customersById || new Map(state.customers.map(c => [c.id, c]));
    const pageMap = new Map((state.pages || []).map(p => [p.id, p]));
    const canSearchContacts = can('customers', 'viewContacts');
    // The table renders Meta page/ad IDs with a leading '#'; a copied
    // "#123456" search must still match the stored bare digits. A lone "#"
    // must not match everything, so keep the original term as fallback.
    const idTerm = searchTerm.replace(/^#/, '') || searchTerm;
    filtered = filtered.filter(ad => {
      const customer = custMap.get(ad.customerId);
      const page = ad.pageId ? pageMap.get(ad.pageId) : null;
      return (
        foldSearchText(customer?.name).includes(searchTerm) ||
        foldSearchText(ad.id).includes(searchTerm) ||
        (canSearchContacts && foldSearchText(ad.phoneNumber).includes(searchTerm)) ||
        foldSearchText(ad.serialNumber).includes(searchTerm) ||
        foldSearchText(page?.name).includes(searchTerm) ||
        foldSearchText(ad.metaAdId).includes(idTerm) ||
        foldSearchText(ad.metaAdName).includes(searchTerm) ||
        foldSearchText(ad.metaCampaignName).includes(searchTerm) ||
        foldSearchText(ad.metaAdSetName).includes(searchTerm) ||
        // The Page column shows the Meta page ID and name even when no local
        // page record exists — what is visible must be searchable.
        foldSearchText(ad.metaPageId || page?.metaPageId).includes(idTerm) ||
        foldSearchText(ad.metaPageName || page?.metaPageName).includes(searchTerm)
      );
    });
  }

  return filtered;
}

// ==========================================
// CUSTOMER VALIDATION FUNCTIONS
// ==========================================

// Customer identity is phone-based, but the historical data has several
// shapes (`phone`, `phoneNumber`, `phones[]`, and object entries) and several
// spellings of a Libyan number. Keep this canonicalizer in one place so create,
// edit, duplicate discovery and the server all agree that these are identical:
//   0912345678 / 218912345678 / +218 91 234 5678 / 00218-91-234-5678
function getCustomerPhoneValue(entry) {
  if (entry === null || entry === undefined) return '';
  if (typeof entry === 'object') {
    return String(entry.number ?? entry.phone ?? entry.phoneNumber ?? entry.value ?? '').trim();
  }
  return String(entry).trim();
}

function normalizeCustomerPhoneKey(value) {
  let raw = getCustomerPhoneValue(value);
  if (!raw) return '';
  // NFKC handles full-width digits. Translate Arabic-Indic and Persian digits
  // explicitly because customer phones are commonly pasted from Arabic apps.
  try { raw = raw.normalize('NFKC'); } catch (_) {}
  raw = raw
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // International call-prefix spelling (00218...) is the same as +218....
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('218')) {
    let national = digits.slice(3);
    if (national.startsWith('0')) national = national.slice(1);
    // Libyan mobile numbers have a nine-digit national part beginning with 9.
    if (/^9\d{8}$/.test(national)) return `218${national}`;
    return `218${national}`;
  }
  if (/^09\d{8}$/.test(digits)) return `218${digits.slice(1)}`;
  if (/^9\d{8}$/.test(digits)) return `218${digits}`;
  return digits;
}

// Compare-time search normalizer, applied to BOTH the query and the haystack
// at every search/filter site (never to stored values or the visible input —
// rewriting the user's typed ٠-٩ mid-typing would visibly mutate the field):
//  - Arabic-Indic ٠-٩ / Persian ۰-۹ digits fold to ASCII (normalizeDigitsAscii,
//    the same write-side normalizer used by money/receipt-number inputs), so a
//    Gboard/iOS Arabic-keyboard query like ١٢٣ matches stored "123";
//  - toLowerCase() for Latin;
//  - conservative Arabic letter folding so the standard unhamza'd keyboard
//    spellings match: hamza alif forms آأإٱ -> ا, ة -> ه, ى -> ي, and
//    tashkeel/tatweel stripped (U+064B-U+0655 includes the combining
//    hamza/madda so decomposed forms fold too, U+0670 dagger alif, U+0640
//    tatweel).
// NFKC first folds full-width digits and Arabic presentation forms; guarded
// because very old engines lack String.normalize.
function foldSearchText(value) {
  let s = String(value === null || value === undefined ? '' : value);
  try { s = s.normalize('NFKC'); } catch (_) {}
  return normalizeDigitsAscii(s)
    .toLowerCase()
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ٰٕـ]/g, '');
}

// ==========================================
// PAGE CATEGORY VOCABULARY
// ==========================================
// Categories are free text from staff AND the Meta importer, so raw values
// drift: Arabic spelling variants of one word ("حج وعمرة"/"حج وعمره"), double
// spaces, typos that spread once suggested. One key per real category with the
// MOST-USED spelling winning, so the picker teaches the right spelling.
function pageCategoryKey(value) {
  return foldSearchText(value).replace(/\s+/g, ' ').trim();
}

// "Facebook Page" is what the importer stores when Meta exposes no category —
// the server itself treats that exact string as a non-value. Never offer it.
function isPlaceholderPageCategory(value) {
  const key = pageCategoryKey(value);
  return !key || key === 'facebook page' || key === 'صفحه فيسبوك' || key === 'صفحة فيسبوك';
}

// Suggestions for the category picker, most-used first. Scoped to pages the
// user may see, so category text never leaks from pages they cannot open.
function getPageCategorySuggestions() {
  const groups = new Map();
  getPagesVisibleToCurrentUser().forEach(page => {
    const raw = String(page?.category || '').replace(/\s+/g, ' ').trim();
    if (!raw || isPlaceholderPageCategory(raw)) return;
    const key = pageCategoryKey(raw);
    const group = groups.get(key) || { key, count: 0, spellings: new Map() };
    group.count += 1;
    group.spellings.set(raw, (group.spellings.get(raw) || 0) + 1);
    groups.set(key, group);
  });
  const locale = state.language === 'ar' ? 'ar' : 'en';
  return [...groups.values()]
    .map(group => {
      // The spelling used on the most pages becomes the canonical label, so a
      // one-off typo can never outrank the real word.
      let label = '';
      let best = -1;
      group.spellings.forEach((uses, spelling) => {
        if (uses > best) { best = uses; label = spelling; }
      });
      return { key: group.key, label, count: group.count };
    })
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, locale));
}

function getCustomerPhoneEntries(customer) {
  if (!customer || typeof customer !== 'object') return [];
  const source = [
    customer.phone,
    customer.phoneNumber,
    ...(Array.isArray(customer.phones) ? customer.phones : [])
  ];
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    const value = getCustomerPhoneValue(item);
    const key = normalizeCustomerPhoneKey(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ value, key });
  }
  return entries;
}

// Repeated spellings inside the same form are not useful, but they should not
// make a beginner repair the form manually. Preserve the first formatting and
// silently save each real number once.
function dedupeCustomerPhoneValues(phones) {
  const seen = new Set();
  const result = [];
  for (const phone of (Array.isArray(phones) ? phones : [])) {
    const value = getCustomerPhoneValue(phone);
    const key = normalizeCustomerPhoneKey(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

// Check if any phone number is already used by another active customer.
function checkDuplicatePhone(phones, excludeCustomerId = null) {
  const requested = dedupeCustomerPhoneValues(phones).map(phone => ({
    phone,
    key: normalizeCustomerPhoneKey(phone)
  }));
  const excluded = String(excludeCustomerId || '');
  for (const customer of getVisibleRecords(state.customers)) {
    if (!customer || customer._deleted || (excluded && String(customer.id) === excluded)) continue;
    const existingKeys = new Set(getCustomerPhoneEntries(customer).map(entry => entry.key));
    const match = requested.find(entry => entry.key && existingKeys.has(entry.key));
    if (!match) continue;
    return {
      phone: match.phone,
      canonicalPhone: match.key,
      customerId: customer.id,
      customerName: customer.name || 'Unknown',
      customer
    };
  }
  return null;
}

// Return transitive duplicate groups. If A shares one number with B and B
// shares another with C, all three belong to one repair group.
function findDuplicateCustomerGroups(customers = state.customers) {
  const active = getVisibleRecords(Array.isArray(customers) ? customers : [])
    .filter(customer => customer && !customer._deleted && customer.id);
  const byId = new Map(active.map(customer => [String(customer.id), customer]));
  const parent = new Map(active.map(customer => [String(customer.id), String(customer.id)]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = id;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const unite = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  const firstCustomerByPhone = new Map();
  for (const customer of active) {
    const id = String(customer.id);
    for (const { key } of getCustomerPhoneEntries(customer)) {
      const first = firstCustomerByPhone.get(key);
      if (first) unite(first, id);
      else firstCustomerByPhone.set(key, id);
    }
  }
  const grouped = new Map();
  for (const customer of active) {
    const root = find(String(customer.id));
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(customer);
  }
  return Array.from(grouped.values())
    .filter(group => group.length > 1)
    .map(group => {
      const phoneOwners = new Map();
      for (const customer of group) {
        for (const entry of getCustomerPhoneEntries(customer)) {
          if (!phoneOwners.has(entry.key)) phoneOwners.set(entry.key, []);
          phoneOwners.get(entry.key).push(String(customer.id));
        }
      }
      return {
        customers: group,
        sharedPhoneKeys: Array.from(phoneOwners.entries())
          .filter(([, ids]) => new Set(ids).size > 1)
          .map(([key]) => key)
      };
    })
    .sort((a, b) => String(a.customers[0]?.name || '').localeCompare(String(b.customers[0]?.name || '')));
}

// ==========================================
// CUSTOMER STATS CALCULATION FUNCTIONS
// ==========================================

// PERFORMANCE: one-pass grouping of ads/receipts/pages by customer id.
// Build this ONCE before a loop over many customers and pass it to
// getCustomerStats — turns O(customers × records) view rendering into
// O(customers + records). Results are identical to the per-call filters.
function buildCustomerStatsIndex() {
  // Receipts first: the ads loop below needs each receipt's exchange rate to
  // reproduce getDeliveryReceiptDueUsage's legacy-mirror math exactly.
  const receiptsByCustomer = new Map();
  const receiptRateById = new Map();
  for (const r of getVisibleRecords(state.receipts)) {
    // Same fallback chain as getDeliveryReceiptDueUsage's `exchangeRate`.
    receiptRateById.set(String(r.id || ''), r.exchangeRate || state.defaultExchangeRate || 1);
    const customerId = String(r.customerId || '');
    if (!customerId) continue;
    const list = receiptsByCustomer.get(customerId);
    if (list) list.push(r); else receiptsByCustomer.set(customerId, [r]);
  }
  const adsByCustomer = new Map();
  // committedUSDByReceiptId[rid] = the total explicitly committed against that
  // receipt across ALL ads (receiptAllocations + dueAllocations rows + the
  // rowless legacy due mirror) — the same number getDeliveryReceiptDueUsage
  // computes as usedDueUSD, but for every receipt in ONE ads pass instead of
  // one full ads scan per receipt. getCustomerStats' debt block reads this so
  // the customers view no longer rescans state.ads per unpaid receipt on
  // every keystroke / live-sync render.
  const committedUSDByReceiptId = new Map();
  for (const ad of getVisibleRecords(state.ads)) {
    // Very old ads did not have recordType yet. Only the explicit receipt
    // mirror is not an ad; this matches getFilteredAds() and keeps old data
    // visible after a live refresh even before a migration has persisted it.
    if (ad.recordType === 'receipt') continue;
    // Commitments count even when the ad has no customerId, so accumulate them
    // BEFORE the customer grouping guard. Per receipt id the arithmetic below
    // mirrors getDeliveryReceiptDueUsage exactly (filter-then-reduce per pool,
    // then paid + due + legacyDue added per ad) so the sums stay bit-identical.
    const perReceipt = new Map(); // rid -> { paid, due }
    const bucketFor = (rid) => {
      let bucket = perReceipt.get(rid);
      if (!bucket) { bucket = { paid: 0, due: 0 }; perReceipt.set(rid, bucket); }
      return bucket;
    };
    if (Array.isArray(ad.receiptAllocations)) {
      for (const row of ad.receiptAllocations) {
        const rid = String((row && row.receiptId) || '');
        bucketFor(rid).paid += parseFloat(row && row.amountUSD) || 0;
      }
    }
    if (Array.isArray(ad.dueAllocations)) {
      for (const row of ad.dueAllocations) {
        const rid = String((row && row.receiptId) || '');
        bucketFor(rid).due += parseFloat(row && row.amountUSD) || 0;
      }
    }
    // The legacy scalar mirror only speaks for a ROWLESS ad (same guard as
    // getDeliveryReceiptDueUsage): once any positive due row exists the scalar
    // is the rows' sum, not additional money. Candidate receipt ids come from
    // isAdLegacyDueMirrorForReceipt's two link fields; getAdLegacyDueMirrorUSD
    // itself returns 0 for non-mirrors, and duplicate ids must be evaluated
    // once so the same mirror is never added twice.
    const hasAnyPositiveDueRow = Array.isArray(ad.dueAllocations)
      && ad.dueAllocations.some(a => (parseFloat(a?.amountUSD) || 0) > 0);
    const legacyByReceipt = new Map();
    if (!hasAnyPositiveDueRow) {
      const linkedId = String(ad.linkedDeliveryReceiptId || '');
      const receiptRefId = String(ad.receiptId || '');
      const candidates = linkedId === receiptRefId ? [linkedId] : [linkedId, receiptRefId];
      for (const rid of candidates) {
        if (!rid) continue;
        const legacy = getAdLegacyDueMirrorUSD(ad, rid, receiptRateById.get(rid) || 0);
        if (legacy > 0) {
          legacyByReceipt.set(rid, legacy);
          if (!perReceipt.has(rid)) perReceipt.set(rid, { paid: 0, due: 0 });
        }
      }
    }
    for (const [rid, bucket] of perReceipt) {
      const committed = bucket.paid + bucket.due + (legacyByReceipt.get(rid) || 0);
      if (committed > 0) {
        committedUSDByReceiptId.set(rid, (committedUSDByReceiptId.get(rid) || 0) + committed);
      }
    }
    const customerId = String(ad.customerId || ad.customer || '');
    if (!customerId) continue;
    const list = adsByCustomer.get(customerId);
    if (list) list.push(ad); else adsByCustomer.set(customerId, [ad]);
  }
  const pagesByCustomer = new Map();
  for (const p of getVisibleRecords(state.pages)) {
    for (const cid of getPageCustomerIds(p)) {
      const list = pagesByCustomer.get(cid);
      if (list) list.push(p); else pagesByCustomer.set(cid, [p]);
    }
  }
  return { adsByCustomer, receiptsByCustomer, pagesByCustomer, committedUSDByReceiptId };
}

// Status-aware USD "spent" for a single ad — the ONE definition of how much
// an ad counts as spent, so the customer cards and the analytics panels can
// never disagree (they used to: analytics counted full amountUSD for every
// status, so the same customer's "Spend" and "Spent" showed different numbers,
// and a Stopped ad that spent $100 was counted at its full $500).
function getAdSpendUSD(ad) {
  if (!ad) return 0;
  const status = String(ad.status || '').trim().toLowerCase();
  if (status === 'stopped' && ad.spentUSD !== undefined) return parseFloat(ad.spentUSD) || 0;
  if (['completed', 'canceled', 'lost'].includes(status)) {
    return ad.spentUSD !== undefined ? (parseFloat(ad.spentUSD) || 0) : (parseFloat(ad.amountUSD) || 0);
  }
  if (['pending', 'paused'].includes(status)) return 0;
  return parseFloat(ad.amountUSD) || 0;
}

// ---------------- Liquidity coverage (owner solvency tracking) ----------------
// The business historically spent customer deposits. From an admin-chosen start
// date the app tracks NEW cash actually received and NEW ad spending, and
// compares the net against everything still owed to customers — so the owner
// sees whether the fresh money can cover the outstanding customer credit.

// Newest liquidity record wins. state.appSettings is append-only exactly like
// exchangeRateHistory, so the history of changes is the audit trail.
function getLiquidityTrackingConfig() {
  const rows = (Array.isArray(state.appSettings) ? state.appSettings : []).filter(row =>
    row && !row._deleted && String(row.settingKey || '') === 'liquidityTracking' && row.startDate
  );
  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())[0];
}

// When did this receipt's money actually arrive? deliveredAt is the driver
// handover, collectionDate is stamped when a receipt turns Paid, createdAt
// covers receipts born Paid. collectedAt is stamped at the admin's
// reconciliation CLICK, which can be long after the cash arrived — so it may
// only make the money OLDER, never newer: otherwise confirming a backlog of
// old receipts would mint them as "new" cash inside the tracking window.
function getReceiptPaidDate(r) {
  const paidAt = r?.deliveredAt || r?.collectionDate || r?.createdAt || null;
  if (r?.collectedAt && paidAt) {
    return new Date(r.collectedAt) < new Date(paidAt) ? r.collectedAt : paidAt;
  }
  return r?.collectedAt || paidAt;
}

function getLiquiditySnapshot() {
  const config = getLiquidityTrackingConfig();
  const sinceMs = config ? new Date(config.startDate).getTime() : NaN;
  const tracking = Number.isFinite(sinceMs);

  let collectedUSD = 0;
  let liabilityUSD = 0;
  for (const r of getVisibleRecords(state.receipts)) {
    const status = String(r.status || '');
    const detail = r.statusDetail && typeof r.statusDetail === 'object' ? r.statusDetail : {};
    // A canceled PAID receipt whose refund is not yet handed back still holds
    // the customer's cash — it stays in the books until the refund is done.
    const refundOwed = status === 'Canceled' && r.isPaid === true
      && ['full', 'partial'].includes(String(detail.refundAction || ''))
      && String(detail.refundStatus || '') !== 'refunded';
    if ((status === 'Canceled' || status === 'Lost' || status === 'Destroyed') && !refundOwed) continue;
    // Cash-bearing receipts: Paid ones, plus UNDERPAID delivery completions —
    // there the completion flow rewrote amountUSD to the actually-collected
    // cash and stamped deliveredAt, even though the status stays Not Paid.
    const underpaidCollected = !!r.deliveredAt && String(r.paymentResult || '') === 'UNDERPAID';
    if (!(r.isPaid === true || status === 'Paid' || underpaidCollected)) continue;
    // Owed to customers: the unused credit on every paid receipt INCLUDING
    // transfer-ins — each receipt's remaining already subtracts its own usage
    // and outgoing transfers, so summing stays transfer-neutral.
    liabilityUSD += Math.max(getReceiptUsageStats(r).remainingUSD || 0, 0);
    if (!tracking) continue;
    // New cash only: a transfer moves existing money between receipts and a
    // CARRIED_BALANCE receipt records pre-tracking credit — neither is money
    // that newly arrived in the window.
    if (isTransferInReceipt(r)) continue;
    if (String(r.receiptType || '') === 'CARRIED_BALANCE') continue;
    const paidAtMs = new Date(getReceiptPaidDate(r) || 0).getTime();
    if (Number.isFinite(paidAtMs) && paidAtMs >= sinceMs) {
      collectedUSD += parseFloat(r.amountUSD) || 0;
    }
  }

  let adSpendUSD = 0;
  if (tracking) {
    for (const a of getVisibleRecords(state.ads)) {
      if (!a || a.recordType === 'receipt') continue;
      const spend = getAdSpendUSD(a);
      if (spend <= 0) continue;
      const adDateMs = new Date(a.createdAt || a.startDate || 0).getTime();
      if (Number.isFinite(adDateMs) && adDateMs >= sinceMs) {
        adSpendUSD += spend;
      } else {
        // An old ad grown inside the window spends new money only for the
        // dated growth — top-ups plus ordinary budget increases recorded in
        // amountAdjustments — and never more than the ad actually spent.
        const sumDatedRows = (rows, key) => (Array.isArray(rows) ? rows : []).reduce((sum, t) => {
          const tMs = new Date(t?.date || 0).getTime();
          return Number.isFinite(tMs) && tMs >= sinceMs ? sum + (parseFloat(t?.[key]) || 0) : sum;
        }, 0);
        const grownSince = sumDatedRows(a.topUps, 'amount') + sumDatedRows(a.amountAdjustments, 'delta');
        adSpendUSD += Math.min(Math.max(grownSince, 0), spend);
      }
    }
  }

  const netUSD = collectedUSD - adSpendUSD;
  const shortfallUSD = Math.max(liabilityUSD - Math.max(netUSD, 0), 0);
  const coveragePercent = liabilityUSD > 0.005
    ? Math.min(Math.max((Math.max(netUSD, 0) / liabilityUSD) * 100, 0), 999)
    : 100;
  return {
    tracking,
    startDate: tracking ? config.startDate : null,
    setBy: tracking ? String(config.setBy || '') : '',
    collectedUSD: Math.round(collectedUSD * 100) / 100,
    adSpendUSD: Math.round(adSpendUSD * 100) / 100,
    netUSD: Math.round(netUSD * 100) / 100,
    liabilityUSD: Math.round(liabilityUSD * 100) / 100,
    shortfallUSD: Math.round(shortfallUSD * 100) / 100,
    coveragePercent: Math.round(coveragePercent * 10) / 10
  };
}

// Normalize current and historical page links. Current pages use customerIds;
// old exports used one scalar customerId. Comparing normalized strings also
// protects imported numeric-looking ids from silently disappearing.
function getPageCustomerIds(page) {
  if (!page || page._deleted) return [];
  // Once the modern array exists it is authoritative, including when it is
  // empty. Falling back to the old scalar only when the array is absent keeps
  // a removed/reassigned legacy customer from being linked again forever.
  const rawIds = Array.isArray(page.customerIds)
    ? [...page.customerIds]
    : (page.customerId !== undefined && page.customerId !== null && String(page.customerId).trim()
      ? [page.customerId]
      : []);
  return [...new Set(rawIds.map(id => String(id || '').trim()).filter(Boolean))];
}

function getLinkedPagesForCustomer(customerId) {
  const normalizedCustomerId = String(customerId || '').trim();
  if (!Security.isValidRecordId(normalizedCustomerId)) return [];
  return getVisibleRecords(state.pages || []).filter(page =>
    getPageCustomerIds(page).includes(normalizedCustomerId)
  );
}

// Linked unpaid debt uses its receipt as the authoritative rate. Otherwise,
// prefer the exact historical rate recorded by amountLocal/amountUSD: it is
// more reliable than today's default for independent or already-paid ads.
function getAdSpendExchangeRate(ad) {
  // For an unpaid Driver/In-Shop ad, its linked debt receipt is the currency
  // source of truth. This order also repairs historical rows immediately after
  // an admin corrects the receipt from (for example) 9.50 to 9.70, instead of
  // leaving the customer card, receipt card and Ads table disagreeing forever.
  const paymentState = getAdPaymentState(ad);
  const collectionMethod = String(ad?.collectionMethod || '');
  if (paymentState === 'not_paid' && ['driver', 'in_shop'].includes(collectionMethod)) {
    const linkedReceiptId = collectionMethod === 'driver'
      ? String(ad?.linkedDeliveryReceiptId || ad?.receiptId || '')
      : String(ad?.receiptId || '');
    const linkedReceipt = linkedReceiptId
      ? (state.receipts || []).find(receipt => (
          receipt && !receipt._deleted && String(receipt.id || '') === linkedReceiptId
        ))
      : null;
    const linkedRate = Number(linkedReceipt?.exchangeRate);
    if (Number.isFinite(linkedRate) && linkedRate > 0) return linkedRate;
  }

  const amountUSD = Number(ad?.amountUSD);
  const amountLocal = Number(ad?.amountLocal);
  if (Number.isFinite(amountUSD) && amountUSD > 0 && Number.isFinite(amountLocal) && amountLocal > 0) {
    const storedRate = amountLocal / amountUSD;
    if (Number.isFinite(storedRate) && storedRate > 0) return storedRate;
  }
  const effectiveRate = typeof getEffectiveExchangeRate === 'function'
    ? Number(getEffectiveExchangeRate(ad))
    : Number(ad?.exchangeRate);
  if (Number.isFinite(effectiveRate) && effectiveRate > 0) return effectiveRate;
  const recordRate = Number(ad?.exchangeRate);
  if (Number.isFinite(recordRate) && recordRate > 0) return recordRate;
  const fallbackRate = Number(state.defaultExchangeRate);
  return Number.isFinite(fallbackRate) && fallbackRate > 0 ? fallbackRate : 1;
}

function getAdSpendLYD(ad) {
  return Math.round(getAdSpendUSD(ad) * getAdSpendExchangeRate(ad) * 100) / 100;
}

// One read model for the amount a Not Paid receipt represents. Most receipts
// store that amount directly, but historical/manual Driver flows can create a
// zero-value D receipt and keep the real customer debt on its linked ad. That
// link is a collection target only: it must NEVER become paid receipt credit
// or receipt usage (getReceiptUsageStats deliberately remains unchanged).
function getReceiptCollectionTarget(receipt, ads = state.ads) {
  const empty = {
    amountUSD: 0,
    amountLocal: 0,
    debtUSD: 0,
    debtLYD: 0,
    source: 'none',
    linkedAds: []
  };
  if (!receipt || receipt._deleted) return empty;

  const rateValue = Number(receipt.exchangeRate || state.defaultExchangeRate || 0);
  const receiptRate = Number.isFinite(rateValue) && rateValue > 0 ? rateValue : 0;
  const positive = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const finish = (usd, local, source, linkedAds = []) => {
    let amountUSD = positive(usd);
    let amountLocal = positive(local);
    if (!amountUSD && amountLocal && receiptRate) amountUSD = amountLocal / receiptRate;
    if (!amountLocal && amountUSD && receiptRate) amountLocal = amountUSD * receiptRate;
    amountUSD = Math.round(amountUSD * 100) / 100;
    amountLocal = Math.round(amountLocal * 100) / 100;
    return {
      amountUSD,
      amountLocal,
      debtUSD: amountUSD,
      debtLYD: amountLocal,
      source,
      linkedAds
    };
  };

  // Explicit frozen debt is authoritative after a delivery is completed.
  const storedDebtUSD = positive(receipt.debtAmountUSD);
  const storedDebtLocal = positive(receipt.debtAmountLocal);
  if (storedDebtUSD || storedDebtLocal) {
    return finish(storedDebtUSD, storedDebtLocal, 'stored_debt');
  }

  // Current receipts normally store the promised amount in their own amount
  // fields. Legacy aliases are accepted at read time without rewriting data.
  const storedAmountUSD = positive(receipt.amountUSD) || positive(receipt.amount);
  const storedAmountLocal = positive(receipt.amountLocal) || positive(receipt.amountLYD);
  if (storedAmountUSD || storedAmountLocal) {
    return finish(storedAmountUSD, storedAmountLocal, 'receipt_amount');
  }

  // Only a current unpaid Driver receipt may derive a missing target from ads.
  // In-Shop receipts already carry an explicit receipt amount. Paid/cancelled
  // receipts and historical stop/refund baselines are intentionally excluded.
  if (getReceiptDebtType(receipt) !== 'delivery') return empty;
  const receiptId = String(receipt.id || '');
  const customerId = String(receipt.customerId || '');
  if (!receiptId || !customerId) return empty;

  let amountUSD = 0;
  let amountLocal = 0;
  const linkedAds = [];
  for (const ad of getVisibleRecords(Array.isArray(ads) ? ads : [])) {
    if (!ad || ad._deleted || String(ad.recordType || '') === 'receipt') continue;
    if (String(ad.customerId || ad.customer || '') !== customerId) continue;
    if (getAdPaymentState(ad) !== 'not_paid' || String(ad.collectionMethod || '') !== 'driver') continue;

    const linkedId = String(ad.linkedDeliveryReceiptId || '');
    const legacyLinkedId = !linkedId ? String(ad.receiptId || '') : '';
    if (linkedId !== receiptId && legacyLinkedId !== receiptId) continue;

    const spendUSD = Math.max(getAdSpendUSD(ad), 0);
    const paidRows = Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length
      ? ad.receiptAllocations
      : (Array.isArray(ad.mergedPaidAllocations) ? ad.mergedPaidAllocations : []);
    const paidUSD = paidRows.reduce(
      (sum, row) => sum + Math.max(Number(row?.amountUSD) || 0, 0),
      0
    );
    const debtUSD = Math.max(spendUSD - paidUSD, 0);
    if (debtUSD <= 0) continue;

    const adRate = getAdSpendExchangeRate(ad);
    amountUSD += debtUSD;
    amountLocal += debtUSD * adRate;
    linkedAds.push(ad);
  }

  return finish(amountUSD, amountLocal, linkedAds.length ? 'linked_ads' : 'none', linkedAds);
}

// Backward-readable name for receipt-card and reporting call sites.
function getReceiptLinkedDebtStats(receipt, ads = state.ads) {
  return getReceiptCollectionTarget(receipt, ads);
}

// One authoritative, customer-scoped summary for the Customers drill-down.
// Filtering by BOTH ids is essential: a Facebook page can be shared by several
// customers, and page-only totals would charge one customer's ads to another.
function getCustomerPageSpendSummary(customerId, pageId) {
  const normalizedCustomerId = String(customerId || '').trim();
  const normalizedPageId = String(pageId || '').trim();
  if (!Security.isValidRecordId(normalizedCustomerId) || !Security.isValidRecordId(normalizedPageId)) return null;

  const customer = getVisibleRecords(state.customers || []).find(item => String(item.id) === normalizedCustomerId);
  const page = getVisibleRecords(state.pages || []).find(item => String(item.id) === normalizedPageId);
  if (!customer || !page || !getPageCustomerIds(page).includes(normalizedCustomerId)) return null;

  const ads = getVisibleRecords(state.ads || []).filter(ad => {
    if (ad.recordType === 'receipt') return false;
    const adCustomerId = String(ad.customerId || ad.customer || '');
    const adPageId = String(ad.pageId || ad.page || '');
    return adCustomerId === normalizedCustomerId && adPageId === normalizedPageId;
  });

  let totalSpendUSD = 0;
  let totalSpendLYD = 0;
  let paidSpendUSD = 0;
  let paidSpendLYD = 0;
  let unpaidSpendUSD = 0;
  let unpaidSpendLYD = 0;
  const adDates = [];

  ads.forEach(ad => {
    const spendUSD = getAdSpendUSD(ad);
    const spendLYD = getAdSpendLYD(ad);
    totalSpendUSD += spendUSD;
    totalSpendLYD += spendLYD;
    if (getAdPaymentState(ad) === 'paid') {
      paidSpendUSD += spendUSD;
      paidSpendLYD += spendLYD;
    } else {
      // Both Not Paid and Won't Pay belong in the red unpaid-ad spend group.
      unpaidSpendUSD += spendUSD;
      unpaidSpendLYD += spendLYD;
    }
    const time = new Date(ad.startDate || ad.date || ad.createdAt || '').getTime();
    if (Number.isFinite(time)) adDates.push(time);
  });

  return {
    customerId: normalizedCustomerId,
    customerName: String(customer.name || ''),
    pageId: normalizedPageId,
    pageName: String(page.name || ''),
    pageCategory: String(page.category || ''),
    totalAds: ads.length,
    runningAds: ads.filter(ad => String(ad.status || '').trim().toLowerCase() === 'active').length,
    totalSpendUSD,
    totalSpendLYD,
    paidSpendUSD,
    paidSpendLYD,
    unpaidSpendUSD,
    unpaidSpendLYD,
    lastAdDate: adDates.length ? Math.max(...adDates) : null
  };
}

function getPageSpendSummary(pageId) {
  const normalizedPageId = String(pageId || '').trim();
  if (!Security.isValidRecordId(normalizedPageId)) return null;
  const page = getVisibleRecords(state.pages || []).find(item => String(item.id) === normalizedPageId);
  if (!page) return null;
  const ads = getVisibleRecords(state.ads || []).filter(ad =>
    ad.recordType !== 'receipt' && String(ad.pageId || ad.page || '') === normalizedPageId
  );
  const dates = ads
    .map(ad => new Date(ad.startDate || ad.date || ad.createdAt || '').getTime())
    .filter(Number.isFinite);
  return {
    totalAds: ads.length,
    totalSpendUSD: ads.reduce((sum, ad) => sum + getAdSpendUSD(ad), 0),
    totalSpendLYD: ads.reduce((sum, ad) => sum + getAdSpendLYD(ad), 0),
    lastAdDate: dates.length ? Math.max(...dates) : null
  };
}

function getCustomerStats(customerId, statsIndex = null) {
  const normalizedCustomerId = String(customerId || '');
  const customerAds = statsIndex
    ? (statsIndex.adsByCustomer.get(normalizedCustomerId) || [])
    : getVisibleRecords(state.ads).filter(ad => String(ad.customerId || ad.customer || '') === normalizedCustomerId && ad.recordType !== 'receipt');
  const customerReceipts = statsIndex
    ? (statsIndex.receiptsByCustomer.get(normalizedCustomerId) || [])
    : getVisibleRecords(state.receipts).filter(r => String(r.customerId || '') === normalizedCustomerId);
  const linkedPages = statsIndex
    ? (statsIndex.pagesByCustomer.get(normalizedCustomerId) || [])
    : getLinkedPagesForCustomer(normalizedCustomerId);
  
  // Calculate total paid from receipts (in LYD and USD)
  // IMPORTANT: Unpaid receipts (status "Not Paid") should NOT be counted as revenue.
  const paidReceipts = customerReceipts.filter(r => {
    const st = String(r.status || '');
    if (st === 'Canceled' || st === 'Lost' || st === 'Destroyed') return false;
    return st === 'Paid' || r.isPaid === true;
  });
  // Money transferred OUT to another customer is no longer this customer's
  // credit — the recipient's transferred-in receipt counts it instead.
  // Without this deduction the same dollars showed as credit on BOTH
  // customer cards at once (double-counted per-customer credit).
  let transferredOutUSD = 0;
  let transferredOutLYD = 0;
  paidReceipts.forEach(receipt => {
    (Array.isArray(receipt.transfers) ? receipt.transfers : []).forEach(tr => {
      const tUSD = parseFloat(tr?.amountUSD) || 0;
      const tLocal = parseFloat(tr?.amountLocal);
      transferredOutUSD += tUSD;
      transferredOutLYD += Number.isFinite(tLocal) ? tLocal : tUSD * (receipt.exchangeRate || 0);
    });
  });
  const totalPaidLYD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountLocal || 0), 0) - transferredOutLYD;
  const totalPaidUSD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountUSD || 0), 0) - transferredOutUSD;
  
  // Calculate total spent USD from ads (status-aware, shared with analytics)
  const totalSpentUSD = customerAds.reduce((sum, ad) => sum + getAdSpendUSD(ad), 0);

  // Calculate spent LYD proportionally based on USD spent
  // This ensures spentLYD cannot exceed paidLYD
  let totalSpentLYD = 0;
  if (totalPaidUSD > 0) {
    // Proportional calculation: (spentUSD / paidUSD) * paidLYD
    totalSpentLYD = (totalSpentUSD / totalPaidUSD) * totalPaidLYD;
  } else if (totalSpentUSD > 0) {
    // No paid receipts but real ad spend = pure debt. Derive the LYD figure
    // from each ad's OWN exchange rate so the LYD balance reflects the debt
    // instead of showing a misleading 0 (which styled the card as positive
    // and made the "has debt" filter miss a genuine debtor).
    totalSpentLYD = customerAds.reduce((sum, ad) => sum + getAdSpendLYD(ad), 0);
  }
  
  // Standalone unpaid-receipt debt. Paid comes only from paid receipts and
  // Spent only from ads, so a Not Paid receipt whose promised money is not
  // committed to any ad (a plain delivery/in-shop debt) appeared in NO
  // customer total: the card showed 0/0/+0 while the receipts view showed
  // "Customer debt", and the "Has debt" filter missed the customer. Count the
  // UNCOMMITTED remainder of each debt receipt exactly once:
  //  - getReceiptCollectionTarget is the shared capacity read model
  //    (stored debt -> receipt amounts -> linked-ads derivation);
  //  - a 'linked_ads' target lives entirely on unpaid ads already counted in
  //    Spent above, so the receipt itself must contribute nothing;
  //  - money committed to ads from this receipt's due pool
  //    (getDeliveryReceiptDueUsage.usedDueUSD) also surfaces as ad spend, so
  //    only the remainder may be added — the same dollars never count twice.
  let receiptDebtUSD = 0;
  let receiptDebtLYD = 0;
  customerReceipts.forEach(receipt => {
    if (getReceiptDebtType(receipt) === 'none') return;
    const target = getReceiptCollectionTarget(receipt);
    if (target.source === 'linked_ads' || !(target.debtUSD > 0)) return;
    // PERFORMANCE: with a statsIndex (list renders), the committed total is a
    // Map lookup built in ONE ads pass; without one (single-record callers),
    // keep the exact per-receipt scan. Same number either way — the index
    // mirrors getDeliveryReceiptDueUsage.usedDueUSD bit for bit.
    const committedUSD = (statsIndex && statsIndex.committedUSDByReceiptId)
      ? (statsIndex.committedUSDByReceiptId.get(String(receipt.id || '')) || 0)
      : (getDeliveryReceiptDueUsage(receipt).usedDueUSD || 0);
    const uncommittedUSD = Math.max(target.debtUSD - committedUSD, 0);
    if (uncommittedUSD <= 0) return;
    receiptDebtUSD += uncommittedUSD;
    // debtLYD/debtUSD is the receipt's own rate (exchangeRate with the
    // defaultExchangeRate fallback, as normalized by the read model); scaling
    // by it preserves the stored LYD figure exactly when nothing is committed.
    receiptDebtLYD += target.debtLYD * (uncommittedUSD / target.debtUSD);
  });
  receiptDebtUSD = Math.round(receiptDebtUSD * 100) / 100;
  receiptDebtLYD = Math.round(receiptDebtLYD * 100) / 100;

  // Calculate balance (paid - spent - uncommitted receipt debt)
  const balanceLYD = totalPaidLYD - totalSpentLYD - receiptDebtLYD;
  const balanceUSD = totalPaidUSD - totalSpentUSD - receiptDebtUSD;
  
  // Legacy balance (for backwards compatibility)
  const totalSpent = totalSpentLYD;
  const totalPaid = totalPaidLYD;
  const balance = balanceLYD;
  
  // Get last ad date
  const allCustomerAds = [...customerAds, ...customerReceipts];
  const customerActivityDates = allCustomerAds
    .map(ad => new Date(ad.startDate || ad.date || ad.createdAt || '').getTime())
    .filter(Number.isFinite);
  const lastAdDate = customerActivityDates.length ? Math.max(...customerActivityDates) : null;
  
  return {
    totalSpent,
    totalPaid,
    balance,
    // LYD values (TOTAL PAID)
    totalSpentLYD,
    totalPaidLYD,
    balanceLYD,
    // USD values (TOTAL ADS CREDIT)
    totalSpentUSD,
    totalPaidUSD,
    balanceUSD,
    // Uncommitted Not Paid receipt debt (already subtracted from the balances)
    receiptDebtUSD,
    receiptDebtLYD,
    // Other stats
    lastAdDate,
    totalAds: customerAds.length,
    totalReceipts: customerReceipts.length,
    linkedPagesCount: linkedPages.length
  };
}

let _customerPagesReturnFocus = null;
let _customerPagesCustomerId = null;

function renderCustomerPageSpendingDetail(summary, permissions = {}) {
  const isAr = state.language === 'ar';
  if (!summary) {
    return `<div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">${isAr ? 'هذه الصفحة غير مرتبطة بهذا العميل.' : 'This page is not linked to this customer.'}</div>`;
  }

  const canViewAds = permissions.canViewAds !== undefined ? permissions.canViewAds : can('ads', 'view');
  const canViewBalance = permissions.canViewBalance !== undefined ? permissions.canViewBalance : can('customers', 'viewBalance');
  const lastAdText = summary.lastAdDate
    // appDateLocale() (not the raw device locale): an English UI on an ar-SA
    // device otherwise renders this one stat as a Hijri year with Arabic-Indic
    // digits, unlike every other lastAdDate in the app.
    ? new Date(summary.lastAdDate).toLocaleDateString(appDateLocale())
    : (isAr ? 'أبداً' : 'Never');
  const pageName = Security.escapeHtml(summary.pageName || '');
  const category = Security.escapeHtml(summary.pageCategory || '');

  if (!canViewAds) {
    return `
      <div class="space-y-4">
        <div><h3 class="text-lg font-bold text-slate-800 dark:text-white break-words">${pageName}</h3>${category ? `<p class="text-sm text-slate-500 mt-1 break-words">${category}</p>` : ''}</div>
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-4 text-sm text-slate-500">
          <i data-lucide="lock" class="w-4 h-4 inline-block align-text-bottom"></i>
          ${isAr ? 'نشاط الإعلانات محجوب لحسابك.' : 'Ad activity is hidden for your account.'}
        </div>
      </div>`;
  }

  return `
    <div class="space-y-4">
      <div>
        <h3 class="text-lg font-bold text-slate-800 dark:text-white break-words">${pageName}</h3>
        ${category ? `<p class="text-sm text-slate-500 mt-1 break-words">${category}</p>` : ''}
        <p class="text-xs text-indigo-600 dark:text-indigo-300 mt-2">${isAr ? 'إنفاق هذا العميل فقط على هذه الصفحة' : "Only this customer's activity on this page"}</p>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3">
          <div class="text-xs text-slate-500">${isAr ? 'إجمالي الإعلانات' : 'Total ads'}</div>
          <div class="text-xl font-bold text-slate-800 dark:text-white mt-1">${summary.totalAds}</div>
        </div>
        <div class="rounded-xl bg-blue-50 dark:bg-blue-900/20 p-3">
          <div class="text-xs text-blue-600">${isAr ? 'الإعلانات النشطة' : 'Running ads'}</div>
          <div class="text-xl font-bold text-blue-700 dark:text-blue-300 mt-1">${summary.runningAds}</div>
        </div>
        <div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3">
          <div class="text-xs text-slate-500">${isAr ? 'آخر إعلان' : 'Last ad'}</div>
          <div class="text-sm font-bold text-slate-800 dark:text-white mt-1">${Security.escapeHtml(lastAdText)}</div>
        </div>
      </div>
      ${!canViewBalance ? `
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-4 text-sm text-slate-500">
          <i data-lucide="lock" class="w-4 h-4 inline-block align-text-bottom"></i>
          ${isAr ? 'معلومات الإنفاق محجوبة لحسابك.' : 'Spending information is hidden for your account.'}
        </div>
      ` : `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
            <div class="text-xs font-semibold text-slate-500">${isAr ? 'إجمالي الإنفاق' : 'Total spend'}</div>
            <div class="text-lg font-bold text-slate-800 dark:text-white mt-1">$${summary.totalSpendUSD.toFixed(2)}</div>
            <div class="text-xs text-slate-500">${summary.totalSpendLYD.toFixed(2)} LYD</div>
          </div>
          <div class="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 p-3">
            <div class="text-xs font-semibold text-emerald-600">${isAr ? 'إنفاق مدفوع' : 'Paid spend'}</div>
            <div class="text-lg font-bold text-emerald-700 dark:text-emerald-300 mt-1">$${summary.paidSpendUSD.toFixed(2)}</div>
            <div class="text-xs text-emerald-600">${summary.paidSpendLYD.toFixed(2)} LYD</div>
          </div>
          <div class="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-900/20 p-3">
            <div class="text-xs font-semibold text-rose-600">${isAr ? 'إنفاق الإعلانات غير المدفوعة' : 'Spend on unpaid ads'}</div>
            <div class="text-lg font-bold text-rose-700 dark:text-rose-300 mt-1">$${summary.unpaidSpendUSD.toFixed(2)}</div>
            <div class="text-xs text-rose-600">${summary.unpaidSpendLYD.toFixed(2)} LYD</div>
          </div>
        </div>
      `}
    </div>`;
}

function openCustomerPages(customerId, triggerButton = null) {
  const normalizedCustomerId = String(customerId || '').trim();
  const isAr = state.language === 'ar';
  if (!state.currentUser?.id) return;
  if (!Security.isValidRecordId(normalizedCustomerId)) return;

  const customer = getVisibleRecords(state.customers || []).find(item => String(item.id) === normalizedCustomerId);
  const canViewCustomer = customer && canActOnRecord(
    'customers',
    'view',
    customer.createdBy || customer.creatorId
  );
  if (!canViewCustomer || !can('pages', 'view')) {
    showNotification(
      isAr ? 'تم رفض الوصول' : 'Access Denied',
      isAr ? 'لا توجد صلاحية لعرض صفحات العميل.' : 'You do not have permission to view this customer\'s pages.',
      'error'
    );
    return;
  }

  const linkedPages = getLinkedPagesForCustomer(normalizedCustomerId);
  closeCustomerPagesDialog(false);
  _customerPagesReturnFocus = triggerButton || document.activeElement;
  _customerPagesCustomerId = normalizedCustomerId;

  const dialog = document.createElement('div');
  dialog.id = 'customer-pages-dialog';
  dialog.className = 'customer-pages-dialog mobile-dialog-overlay fixed inset-0 z-[90] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'customer-pages-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.dataset.customerId = normalizedCustomerId;
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-4xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <h2 id="customer-pages-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white truncate">${isAr ? 'صفحات العميل' : 'Customer pages'}</h2>
          <p class="text-sm text-slate-500 truncate">${Security.escapeHtml(customer.name || '')}</p>
        </div>
        <button type="button" data-customer-pages-close onclick="closeCustomerPagesDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)] flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
        <div class="p-4 sm:p-5 border-b lg:border-b-0 lg:border-e border-slate-200 dark:border-slate-700 lg:overflow-y-auto">
          <h3 class="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">${isAr ? 'الصفحات المرتبطة' : 'Linked pages'} (${linkedPages.length})</h3>
          <div class="space-y-2">
            ${linkedPages.length ? linkedPages.map(page => `
              <button type="button" data-customer-page-option data-customer-id="${Security.escapeHtml(normalizedCustomerId)}" data-page-id="${Security.escapeHtml(String(page.id || ''))}" onclick="showCustomerPageSpending(this.dataset.customerId, this.dataset.pageId, this)" class="customer-page-option w-full min-h-11 text-start rounded-xl border border-slate-200 dark:border-slate-700 p-3 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors" aria-pressed="false">
                <span class="font-semibold text-slate-800 dark:text-white block break-words">${Security.escapeHtml(page.name || '')}</span>
                ${page.category ? `<span class="text-xs text-slate-500 block mt-1 break-words">${Security.escapeHtml(page.category || '')}</span>` : ''}
              </button>
            `).join('') : `
              <div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-4 text-sm text-slate-500 text-center">${isAr ? 'لا توجد صفحات مرتبطة بهذا العميل.' : 'No pages are linked to this customer.'}</div>
            `}
          </div>
        </div>
        <div id="customer-page-spending-detail" class="p-4 sm:p-5 lg:overflow-y-auto" aria-live="polite">
          <div class="h-full min-h-36 flex flex-col items-center justify-center text-center text-slate-500">
            <i data-lucide="mouse-pointer-click" class="w-8 h-8 mb-3 text-indigo-400"></i>
            <p>${linkedPages.length ? (isAr ? 'اختر صفحة لرؤية معلومات الإنفاق.' : 'Choose a page to see its spending information.') : (isAr ? 'أضف صفحة لهذا العميل أولاً.' : 'Link a page to this customer first.')}</p>
          </div>
        </div>
      </div>
    </div>`;

  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeCustomerPagesDialog();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeCustomerPagesDialog();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  const closeButton = dialog.querySelector('[data-customer-pages-close]');
  if (closeButton?.focus) closeButton.focus(); else dialog.focus();
}

function showCustomerPageSpending(customerId, pageId, triggerButton = null) {
  const normalizedCustomerId = String(customerId || '').trim();
  const normalizedPageId = String(pageId || '').trim();
  if (!state.currentUser?.id) return;
  if (!Security.isValidRecordId(normalizedCustomerId) || !Security.isValidRecordId(normalizedPageId)) return;
  const customer = getVisibleRecords(state.customers || []).find(item => String(item.id) === normalizedCustomerId);
  const canViewCustomer = customer && canActOnRecord(
    'customers',
    'view',
    customer.createdBy || customer.creatorId
  );
  if (!canViewCustomer || !can('pages', 'view')) return;
  const summary = getCustomerPageSpendSummary(normalizedCustomerId, normalizedPageId);
  const detail = document.getElementById('customer-page-spending-detail');
  if (!summary || !detail) return;

  detail.innerHTML = renderCustomerPageSpendingDetail(summary, {
    canViewAds: can('ads', 'view'),
    canViewBalance: can('customers', 'viewBalance')
  });
  const dialog = document.getElementById('customer-pages-dialog');
  if (dialog) dialog.dataset.selectedPageId = normalizedPageId;
  dialog?.querySelectorAll('[data-customer-page-option]').forEach(button => {
    const selected = String(button.dataset.pageId || '') === normalizedPageId;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.classList.toggle('ring-2', selected);
    button.classList.toggle('ring-indigo-500', selected);
    button.classList.toggle('bg-indigo-50', selected);
  });
  IconQueue.schedule(detail);
  if (triggerButton && window.innerWidth < 1024) detail.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

function closeCustomerPagesDialog(restoreFocus = true) {
  document.getElementById('customer-pages-dialog')?.remove();
  let focusTarget = _customerPagesReturnFocus?.isConnected === false ? null : _customerPagesReturnFocus;
  if (!focusTarget && _customerPagesCustomerId) {
    focusTarget = Array.from(document.querySelectorAll?.('[data-action="view-customer-pages"]') || [])
      .find(button => String(button.dataset?.customerId || '') === _customerPagesCustomerId) || null;
  }
  _customerPagesReturnFocus = null;
  _customerPagesCustomerId = null;
  if (restoreFocus && focusTarget?.focus) focusTarget.focus();
}

// Every ad that ran on one page, newest first. Role scoping and deleted rows
// are handled by getAdsVisibleToCurrentUser, so this never leaks an ad the
// current user is not allowed to see.
function getAdsForPage(pageId) {
  const wanted = String(pageId || '').trim();
  if (!wanted) return [];
  const when = ad => {
    const value = new Date(ad?.startDate || ad?._created || 0).getTime();
    return Number.isFinite(value) ? value : 0;
  };
  return getAdsVisibleToCurrentUser()
    .filter(ad => String(ad?.pageId || '') === wanted)
    .sort((left, right) => when(right) - when(left));
}

let _pageAdsReturnFocus = null;

function closePageAdsDialog(restoreFocus = true) {
  document.getElementById('page-ads-dialog')?.remove();
  const target = _pageAdsReturnFocus?.isConnected === false ? null : _pageAdsReturnFocus;
  _pageAdsReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

// Jump to the Ads screen already filtered to this page, for the full table with
// its own search and filters.
function openAdsFilteredByPage(pageId) {
  closePageAdsDialog(false);
  state.adFilters = { status: 'all', payment: 'all', page: String(pageId || '') };
  state.adSearch = '';
  state.adReceiptFilter = '';
  navigateTo('ads');
}

function showPageAdsDialog(pageId, triggerButton) {
  const isAr = state.language === 'ar';
  const page = (state.pages || []).find(item => String(item?.id) === String(pageId));
  if (!page) return;
  if (!can('ads', 'view')) {
    showNotification(
      isAr ? 'تم رفض الوصول' : 'Access Denied',
      isAr ? 'لا توجد صلاحية لعرض الإعلانات.' : 'You do not have permission to view ads.',
      'error'
    );
    return;
  }
  const ads = getAdsForPage(page.id);
  const customersById = new Map((state.customers || []).map(c => [String(c.id), c]));
  closePageAdsDialog(false);
  _pageAdsReturnFocus = triggerButton || document.activeElement;

  const dialog = document.createElement('div');
  dialog.id = 'page-ads-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[90] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'page-ads-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-3xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <h2 id="page-ads-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white truncate">${isAr ? 'إعلانات هذه الصفحة' : 'Ads on this page'}</h2>
          <p class="text-sm text-slate-500 truncate">${Security.escapeHtml(page.name || '')} • ${ads.length}</p>
        </div>
        <button type="button" onclick="closePageAdsDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-2">
        ${ads.length ? ads.map(ad => {
          const customer = customersById.get(String(ad.customerId || ''));
          const pending = isMetaAdSetupPending(ad);
          const amount = Number(ad.amountUSD || 0);
          return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-semibold text-slate-800 dark:text-white break-words">#${Security.escapeHtml(String(ad.displayNumber || ad.id || ''))} — ${Security.escapeHtml(customer?.name || ad.customerName || (isAr ? 'غير معروف' : 'Unknown'))}</span>
              <span class="text-sm font-bold ${pending ? 'text-amber-600' : 'text-emerald-600'}">${pending ? (isAr ? 'يحتاج إكمال' : 'Needs setup') : `$${amount.toFixed(2)}`}</span>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>${trStatus(ad.status || '')}</span>
              <span aria-hidden="true">•</span>
              <span>${formatDateShort(ad.startDate)}</span>
              ${ad.metaAdId ? `<span aria-hidden="true">•</span><span class="font-bold text-blue-600 dark:text-blue-300">Meta</span>` : ''}
            </div>
          </div>`;
        }).join('') : `<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-6 text-sm text-slate-500 text-center">${isAr ? 'لا توجد إعلانات على هذه الصفحة.' : 'No ads have run on this page yet.'}</div>`}
      </div>
      ${ads.length ? `<div class="border-t border-slate-200 dark:border-slate-700 p-3 sm:p-4">
        <button type="button" onclick="openAdsFilteredByPage('${Security.escapeHtml(String(page.id))}')" class="w-full min-h-11 rounded-xl bg-indigo-600 px-4 py-2 font-bold text-white hover:bg-indigo-700">${isAr ? 'فتح في شاشة الإعلانات' : 'Open in the Ads screen'}</button>
      </div>` : ''}
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closePageAdsDialog(); });
  document.body.appendChild(dialog);
  dialog.focus();
}

// The same page added twice — usually a hand-made row beside a Meta import, or
// two spellings of one name. Grouped by the Arabic-aware key the category
// picker already uses, so حج وعمرة / حج وعمره / extra spaces collapse into one
// group. Meta page ids are already de-duplicated by the server on import, so
// name is the case a person has to resolve.
function findDuplicatePageGroups(pages = state.pages) {
  const active = getVisibleRecords(Array.isArray(pages) ? pages : [])
    .filter(page => page && !page._deleted && page.id);
  const groups = new Map();
  for (const page of active) {
    const key = pageCategoryKey(page.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  return Array.from(groups.values())
    .filter(group => group.length > 1)
    .sort((a, b) => String(a[0]?.name || '').localeCompare(String(b[0]?.name || '')));
}

let _pageDuplicatesReturnFocus = null;

function closePageDuplicatesDialog(restoreFocus = true) {
  document.getElementById('page-duplicates-dialog')?.remove();
  const target = _pageDuplicatesReturnFocus?.isConnected === false ? null : _pageDuplicatesReturnFocus;
  _pageDuplicatesReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

// Read-only on purpose: it shows what repeats and lets you open each page, but
// never merges or deletes. Ads carry money and point at a pageId, so combining
// two pages is a decision a person makes one at a time.
function showPageDuplicates(focusPageId, triggerButton) {
  const isAr = state.language === 'ar';
  const wanted = String(focusPageId || '');
  let groups = findDuplicatePageGroups();
  if (wanted) groups = groups.filter(group => group.some(page => String(page.id) === wanted));
  closePageDuplicatesDialog(false);
  _pageDuplicatesReturnFocus = triggerButton || document.activeElement;

  const customersById = new Map((state.customers || []).map(c => [String(c.id), c]));
  const dialog = document.createElement('div');
  dialog.id = 'page-duplicates-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[90] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'page-duplicates-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-3xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <h2 id="page-duplicates-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white truncate">${isAr ? 'صفحات مكررة' : 'Duplicate pages'}</h2>
          <p class="text-sm text-slate-500 truncate">${groups.length ? (isAr ? `${groups.length} مجموعة متطابقة بالاسم` : `${groups.length} group${groups.length > 1 ? 's' : ''} with the same name`) : (isAr ? 'لا يوجد تكرار' : 'Nothing repeated')}</p>
        </div>
        <button type="button" onclick="closePageDuplicatesDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
        ${groups.length ? groups.map(group => `
          <section class="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20 p-3">
            <h3 class="font-bold text-slate-800 dark:text-white break-words mb-2">${Security.escapeHtml(group[0]?.name || '')} <span class="text-xs font-normal text-slate-500">(${group.length})</span></h3>
            <div class="space-y-2">
              ${group.map(page => {
                const owners = getPageCustomerIds(page)
                  .map(id => customersById.get(String(id))?.name || '')
                  .filter(Boolean).join(', ');
                const adCount = can('ads', 'view') ? getAdsForPage(page.id).length : null;
                return `<div class="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-slate-800 dark:text-white break-words">${Security.escapeHtml(page.name || '')}</div>
                    <div class="text-xs text-slate-500 break-words">
                      ${Security.escapeHtml(page.category || (isAr ? 'بدون فئة' : 'No category'))}
                      ${owners ? ` • ${Security.escapeHtml(owners)}` : ` • ${isAr ? 'بدون مالك' : 'No owner'}`}
                      ${adCount === null ? '' : ` • ${isAr ? `${adCount} إعلان` : `${adCount} ad${adCount === 1 ? '' : 's'}`}`}
                      ${page.metaPageId ? ' • Meta' : ''}
                    </div>
                  </div>
                  ${can('pages', 'edit') ? `<button type="button" onclick="closePageDuplicatesDialog(false);editPage('${Security.escapeHtml(String(page.id))}')" class="min-h-10 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-800">${isAr ? 'فتح' : 'Open'}</button>` : ''}
                </div>`;
              }).join('')}
            </div>
          </section>
        `).join('') : `<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-6 text-sm text-slate-500 text-center">${isAr ? 'لا توجد صفحات بنفس الاسم.' : 'No two pages share the same name.'}</div>`}
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closePageDuplicatesDialog(); });
  document.body.appendChild(dialog);
  dialog.focus();
}

function getCustomerSortValue(customer, sortType, statsIndex = null) {
  // Date sorts never touch stats — skip the expensive computation entirely.
  if (sortType === 'newest') return new Date(customer.joinDate).getTime();
  if (sortType === 'oldest') return -new Date(customer.joinDate).getTime();

  const stats = getCustomerStats(customer.id, statsIndex);

  switch (sortType) {
    case 'newest':
      return new Date(customer.joinDate).getTime();
    case 'oldest':
      return -new Date(customer.joinDate).getTime();
    case 'lastActive':
      return stats.lastAdDate || 0;
    case 'highestPaid':
      return stats.totalPaid;
    case 'lowestPaid':
      return -stats.totalPaid;
    case 'mostSpend':
      return stats.totalSpent;
    case 'leastSpend':
      return -stats.totalSpent;
    // Non-qualifying customers sink to the bottom. Use a finite sentinel, not
    // -Infinity: two -Infinity values subtract to NaN in the comparator, which
    // makes the sort order undefined (and can throw in some engines).
    case 'biggestCredit':
      return stats.balance > 0 ? stats.balance : -Number.MAX_VALUE;
    case 'highestDebt':
      return stats.balance < 0 ? -stats.balance : -Number.MAX_VALUE;
    default:
      return 0;
  }
}

function getCustomersVisibleToCurrentUser() {
  const customers = getVisibleRecords(state.customers);
  if (isCurrentUserAdmin() || currentUserHasPermission('customers', 'view')) return customers;
  if (!currentUserHasPermission('customers', 'viewOwn')) return [];

  // The backend defines a delivery user's "own" customers as customers
  // referenced by deliveries assigned to that driver, not customers the driver
  // originally created. Server-mode customer collections are already scoped by
  // that rule. Mirror it in local mode so the phone app and local testing behave
  // the same way without hiding an assigned customer's card/search result.
  if (isDeliveryRole(state.currentUser?.role)) {
    if (isServerModeEnabled()) return customers;
    const userId = String(state.currentUser?.id || '');
    const assignedCustomerIds = new Set();
    [...getVisibleRecords(state.receipts || []), ...getVisibleRecords(state.ads || [])].forEach(record => {
      if (String(record?.deliveryPersonId || '') === userId && record?.customerId) {
        assignedCustomerIds.add(String(record.customerId));
      }
    });
    return customers.filter(customer => assignedCustomerIds.has(String(customer.id)));
  }

  const userId = String(state.currentUser?.id || '');
  return customers.filter(customer =>
    String(customer.createdBy || customer.creatorId || '') === userId
  );
}

function getFilteredCustomers(sharedStatsIndex = null) {
  // Do not rely only on the server/cached collection being pre-scoped. During
  // permission changes and in local mode, a viewOwn user may still have other
  // creators' customers in memory. Scope before search, counts, or rendering.
  let filtered = getCustomersVisibleToCurrentUser();
  // foldSearchText on BOTH sides: Arabic-Indic digits fold to ASCII (so the
  // /\D/ strip below no longer deletes them — it used to turn ٠٩١٢٣٤٥٦٧٨ into
  // '' and skip the canonical phone-key match entirely) and unhamza'd Arabic
  // name spellings match stored hamza forms.
  const searchTerm = foldSearchText(state.customerSearch || '').trim();
  const canViewContacts = can('customers', 'viewContacts');
  const canViewBalance = can('customers', 'viewBalance');
  const financialFilter = canViewBalance ? state.customerFinancialFilter : 'all';
  const requestedSort = String(state.customerSort || 'newest');
  const nonFinancialSorts = new Set(['newest', 'oldest', 'lastActive']);
  const effectiveSort = canViewBalance || nonFinancialSorts.has(requestedSort) ? requestedSort : 'newest';
  const searchPhoneDigits = searchTerm.replace(/\D/g, '');

  if (searchTerm) {
    filtered = filtered.filter(c =>
      foldSearchText(c.name).includes(searchTerm) ||
      (canViewContacts && getCustomerPhoneEntries(c).some(entry => foldSearchText(entry.value).includes(searchTerm) || (searchPhoneDigits && entry.key.includes(searchPhoneDigits)))) ||
      foldSearchText(c.platform).includes(searchTerm)
    );
  }
  
  // PERFORMANCE: build the by-customer stats index ONCE and reuse it for both
  // the financial filter and the sort. Previously the sort comparator called
  // getCustomerStats(customer.id) with no index for BOTH operands of EVERY
  // comparison, and the no-index path rescans all ads+receipts+pages each time —
  // ~O(customers log customers × records), freezing the UI for seconds at a few
  // thousand records on every search keystroke / sort change / live-sync tick.
  const needsStats = (
    financialFilter === 'hasCredit' ||
    financialFilter === 'hasDebt' ||
    !(effectiveSort === 'newest' || effectiveSort === 'oldest')
  );
  // renderCustomersView passes its own index so the whole customers render
  // pass builds it exactly ONCE (header stats + filter + sort + cards).
  const statsIndex = needsStats ? (sharedStatsIndex || buildCustomerStatsIndex()) : sharedStatsIndex;

  // Apply financial filter
  if (financialFilter === 'hasCredit') {
    filtered = filtered.filter(c => getCustomerStats(c.id, statsIndex).balance > 0);
  } else if (financialFilter === 'hasDebt') {
    filtered = filtered.filter(c => getCustomerStats(c.id, statsIndex).balance < 0);
  }

  // Apply sorting (decorate-sort-undecorate: compute each sort value once,
  // reusing the shared statsIndex, instead of recomputing inside the comparator).
  filtered = filtered
    .map(c => ({ c, v: getCustomerSortValue(c, effectiveSort, statsIndex) }))
    .sort((a, b) => b.v - a.v) // Descending order
    .map(x => x.c);

  return filtered;
}

// ==========================================
// HELPER FUNCTIONS FOR VIEWS
// ==========================================

async function editAd(id) {
  // Permission check for editing ads
  let ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'edit', ad?.creatorId)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الإعلانات' : 'You do not have permission to edit this ad', 'error');
    return;
  }
  if (can('ads', 'viewPhotos') && getAdPhotoCount(ad) > 0 && !isEntityMediaHydrated('ads', ad)) {
    try {
      ad = await ensureEntityMediaLoaded('ads', id);
    } catch (_) {
      showNotification(
        state.language === 'ar' ? 'تعذر تحميل الصور' : 'Photos unavailable',
        state.language === 'ar' ? 'تعذر تحميل صور الإعلان. تحقق من الاتصال ثم حاول مرة أخرى.' : 'Could not load this ad\'s photos. Check the connection and try again.',
        'error'
      );
      return;
    }
    if (!ad) return;
  }
  state.activeModal = 'ad';
  state.modalData = ad;
  updateUrlParams({ modal: 'ad', id }); // URL tracking
  renderModal();
}

// Transferred-in receipts mirror money deducted from their SOURCE receipt.
// Editing their amount/payments would break that mirror in either direction
// (invent money the sender never gave, or silently zero it), so edits are
// blocked: to change a transfer, delete the transferred-in receipt (the money
// returns to the source) and transfer again.
function _blockTransferInEdit(receipt) {
  if (String(receipt?.receiptType || '') !== 'TRANSFER_IN') return false;
  const src = state.receipts.find(r => r && !r._deleted && String(r.id) === String(receipt.transferFromReceiptId || ''));
  const srcLabel = src ? (src.serialNumber || src.finalReceiptNo || src.id.slice(0, 8)) : '';
  showNotification(
    state.language === 'ar' ? 'وصل محوَّل' : 'Transfer receipt',
    state.language === 'ar'
      ? `هذا الوصل يعكس مبلغاً محوَّلاً من الوصل الأصلي${srcLabel ? ` رقم ${srcLabel}` : ''} ولا يمكن تعديله. لتغييره: احذفه (يعود المبلغ للوصل الأصلي) ثم حوِّل من جديد.`
      : `This receipt mirrors money transferred from source receipt${srcLabel ? ` #${srcLabel}` : ''} and cannot be edited. To change it: delete it (the money returns to the source) and transfer again.`,
    'warning'
  );
  return true;
}

async function editReceipt(id) {
  // Permission check for editing receipts
  let receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'edit', receipt?.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الوصولات' : 'You do not have permission to edit this receipt', 'error');
    return;
  }
  if (_blockDestroyedReceiptEdit(receipt)) return;
  if (_blockTransferInEdit(receipt)) return;
  if (getReceiptPhotoCount(receipt) > 0 && !isEntityMediaHydrated('receipts', receipt)) {
    try {
      receipt = await ensureEntityMediaLoaded('receipts', id);
    } catch (_) {
      showNotification(
        state.language === 'ar' ? 'تعذر تحميل الصور' : 'Photos unavailable',
        state.language === 'ar' ? 'تعذر تحميل صور الوصل. تحقق من الاتصال ثم حاول مرة أخرى.' : 'Could not load this receipt\'s photos. Check the connection and try again.',
        'error'
      );
      return;
    }
    if (!receipt) return;
  }
  state.activeModal = 'receipt';
  state.modalData = receipt;
  updateUrlParams({ modal: 'receipt', id }); // URL tracking
  renderModal();
}

function editCustomer(id) {
  // Permission check for editing customers
  const customer = state.customers.find(c => c.id === id);
  if (!canActOnRecord('customers', 'edit', customer?.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل العملاء' : 'You do not have permission to edit this customer', 'error');
    return;
  }
  state.activeModal = 'customer';
  state.modalData = customer;
  updateUrlParams({ modal: 'customer', id }); // URL tracking
  renderModal();
}

function editPage(id) {
  // Permission check for editing pages
  if (!currentUserHasPermission('pages', 'edit')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الصفحات' : 'You do not have permission to edit pages', 'error');
    return;
  }
  state.activeModal = 'page';
  state.modalData = state.pages.find(p => p.id === id);
  updateUrlParams({ modal: 'page', id }); // URL tracking
  renderModal();
}

function editUser(id) {
  if (!canManageUsersAction('edit') && String(id) !== String(state.currentUser?.id || '')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
    return;
  }
  state.activeModal = 'user';
  state.modalData = state.users.find(u => u.id === id);
  updateUrlParams({ modal: 'user', id }); // URL tracking
  renderModal();
}

// ==========================================
// ADVANCED PERMISSIONS MANAGEMENT
// ==========================================

function showPermissionsModal(userId) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'المستخدم غير موجود' : 'User not found', 'error');
    return;
  }

  // Admins shouldn't have their permissions edited (they have all by default)
  if (isAdminRole(user.role)) {
    showNotification(state.language === 'ar' ? 'معلومة' : 'Info', state.language === 'ar' ? 'المدراء لديهم صلاحية كاملة افتراضياً' : 'Administrators have full access by default', 'info');
    return;
  }

  updateUrlParams({ modal: 'permissions', id: String(userId) }); // URL tracking
  
  const userPermissions = user.permissions || {};
  const permSummary = getPermissionSummary(userPermissions);
  
  // Preserve scroll position so toggling permissions doesn't jump to the top
  let prevScrollTop = 0;
  const existingModal = document.getElementById('app-modal');
  if (existingModal) {
    const scroller = existingModal.querySelector('#permissions-scroll');
    if (scroller) prevScrollTop = scroller.scrollTop || 0;
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.dataset.modalType = 'permissions';
  modal.dataset.userId = String(userId);
  modal.className = 'mobile-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden animate-slide-up" onclick="event.stopPropagation()">
      <!-- Header -->
      <div class="bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 p-6 text-white">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-4">
            <div class="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <span class="text-2xl font-bold">${user.name.charAt(0)}</span>
            </div>
            <div>
              <h2 class="text-2xl font-bold">${state.language === 'ar' ? 'إدارة الصلاحيات' : 'Permissions Manager'}</h2>
              <div class="flex items-center space-x-2 mt-1">
                <span class="text-white/80">${Security.escapeHtml(user.name || '')}</span>
                <span class="px-2 py-0.5 rounded-full bg-white/20 text-xs font-medium">${Security.escapeHtml(user.role || '')}</span>
              </div>
            </div>
          </div>
          <button onclick="this.closest('#app-modal').remove()" class="w-10 h-10 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
        
        <!-- Permission Stats Bar -->
        <div class="mt-4 flex items-center space-x-4">
          <div class="flex-1 bg-white/20 rounded-full h-3 overflow-hidden">
            <div id="perm-summary-bar" class="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 rounded-full transition-all duration-300" style="width: ${permSummary.percentage}%"></div>
          </div>
          <span id="perm-summary-count" class="font-bold text-lg">${permSummary.granted}/${permSummary.total}</span>
        </div>
      </div>
      
      <div id="permissions-scroll" class="p-6 overflow-y-auto max-h-[calc(90vh-200px)] custom-scrollbar">
        <!-- Quick Templates -->
        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase flex items-center space-x-2">
              <i data-lucide="zap" class="w-4 h-4 text-amber-500"></i>
              <span>${state.language === 'ar' ? 'قوالب سريعة' : 'Quick Templates'}</span>
            </h3>
            <button onclick="clearAllPermissions('${userId}')" class="text-xs text-rose-600 hover:text-rose-700 font-medium flex items-center space-x-1">
              <i data-lucide="trash-2" class="w-3 h-3"></i>
              <span>${state.language === 'ar' ? 'مسح الكل' : 'Clear All'}</span>
            </button>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            ${Object.entries(PERMISSION_TEMPLATES).map(([key, template]) => `
              <button onclick="applyPermissionTemplate('${userId}', '${key}')" class="p-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 hover:border-${template.color}-500 hover:bg-${template.color}-50 dark:hover:bg-${template.color}-900/20 transition-all text-center group">
                <i data-lucide="${template.icon}" class="w-5 h-5 mx-auto mb-1 text-${template.color}-600 group-hover:scale-110 transition-transform"></i>
                <div class="text-xs font-bold text-slate-700 dark:text-slate-300">${template.name}</div>
                <div class="text-[10px] text-slate-500 line-clamp-1">${template.description}</div>
              </button>
            `).join('')}
          </div>
        </div>
        
        <!-- Granular Permissions -->
        <div class="space-y-4">
          ${Object.entries(PERMISSION_MODULES).map(([moduleKey, moduleConfig]) => {
            const modulePerms = userPermissions[moduleKey] || [];
            const modulePermCount = Object.keys(moduleConfig.permissions).length;
            const moduleGranted = modulePerms.length;
            const allSelected = moduleGranted === modulePermCount;
            
            return `
              <div class="border-2 border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden hover:border-${moduleConfig.color}-300 dark:hover:border-${moduleConfig.color}-700 transition-colors">
                <!-- Module Header -->
                <div class="p-4 bg-${moduleConfig.color}-50 dark:bg-${moduleConfig.color}-900/20 flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <div class="w-10 h-10 rounded-xl bg-${moduleConfig.color}-100 dark:bg-${moduleConfig.color}-800 flex items-center justify-center">
                      <i data-lucide="${moduleConfig.icon}" class="w-5 h-5 text-${moduleConfig.color}-600 dark:text-${moduleConfig.color}-400"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800 dark:text-white">${moduleConfig.name}</h4>
                      <p class="text-xs text-slate-500">${moduleConfig.description}</p>
                    </div>
                  </div>
                  <div class="flex items-center space-x-3">
                    <span id="perm-module-count-${moduleKey}" class="text-xs font-bold ${moduleGranted > 0 ? 'text-emerald-600' : 'text-slate-400'}">${moduleGranted}/${modulePermCount}</span>
                    <button id="perm-module-toggle-${moduleKey}" data-color="${moduleConfig.color}" onclick="toggleModulePermissions('${userId}', '${moduleKey}', ${!allSelected})" class="px-3 py-1.5 rounded-lg text-xs font-bold ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : 'bg-' + moduleConfig.color + '-600 text-white'} hover:opacity-80 transition-all">
                      ${allSelected ? (state.language === 'ar' ? 'إلغاء تحديد الكل' : 'Deselect All') : (state.language === 'ar' ? 'تحديد الكل' : 'Select All')}
                    </button>
                  </div>
                </div>
                
                <!-- Permissions Grid -->
                <div class="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  ${Object.entries(moduleConfig.permissions).map(([permKey, permConfig]) => {
                    const isEnabled = modulePerms.includes(permKey);
                    return `
                      <label class="flex items-start space-x-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group">
                        <input type="checkbox" 
                          ${isEnabled ? 'checked' : ''} 
                          onchange="togglePermission('${userId}', '${moduleKey}', '${permKey}', this.checked)"
                          data-module="${moduleKey}"
                          data-perm="${permKey}"
                          class="mt-0.5 w-4 h-4 rounded border-slate-300 text-${moduleConfig.color}-600 focus:ring-${moduleConfig.color}-500 cursor-pointer"
                        />
                        <div class="flex-1">
                          <div class="text-sm font-medium text-slate-700 dark:text-slate-300 group-hover:text-${moduleConfig.color}-600">${permConfig.label}</div>
                          <div class="text-[10px] text-slate-500">${permConfig.description}</div>
                        </div>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <!-- Footer -->
      <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
        <div class="text-xs text-slate-500">
          <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
          ${state.language === 'ar' ? 'يتم حفظ التغييرات تلقائياً' : 'Changes are saved automatically'}
        </div>
        <div class="flex items-center space-x-3">
          <button onclick="exportUserPermissions('${userId}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center space-x-2 transition-colors">
            <i data-lucide="download" class="w-3 h-3"></i>
            <span>${state.language === 'ar' ? 'تصدير' : 'Export'}</span>
          </button>
          <button onclick="importUserPermissions('${userId}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center space-x-2 transition-colors">
            <i data-lucide="upload" class="w-3 h-3"></i>
            <span>${state.language === 'ar' ? 'استيراد' : 'Import'}</span>
          </button>
          <button onclick="this.closest('#app-modal').remove()" class="px-6 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:opacity-90 transition-all">
            ${state.language === 'ar' ? 'تم' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  const scroller = document.getElementById('permissions-scroll');
  if (scroller) scroller.scrollTop = prevScrollTop;
}

function refreshPermissionsModalUi(userId, moduleKey = null) {
  const modal = document.getElementById('app-modal');
  if (!modal || modal.dataset?.modalType !== 'permissions') return;
  if (String(modal.dataset.userId || '') !== String(userId || '')) return;

  const user = state.users.find(u => u && !u._deleted && u.id === userId);
  if (!user) return;

  const perms = user.permissions || {};
  const summary = getPermissionSummary(perms);
  const bar = modal.querySelector('#perm-summary-bar');
  const count = modal.querySelector('#perm-summary-count');
  if (bar) bar.style.width = `${summary.percentage}%`;
  if (count) count.textContent = `${summary.granted}/${summary.total}`;

  const updateModule = (mk) => {
    const cfg = PERMISSION_MODULES[mk];
    if (!cfg) return;
    const modulePerms = perms[mk] || [];
    const modulePermCount = Object.keys(cfg.permissions).length;
    const moduleGranted = modulePerms.length;
    const allSelected = moduleGranted === modulePermCount;

    const countEl = modal.querySelector(`#perm-module-count-${mk}`);
    if (countEl) countEl.textContent = `${moduleGranted}/${modulePermCount}`;

    const btn = modal.querySelector(`#perm-module-toggle-${mk}`);
    if (btn) {
      btn.setAttribute('onclick', `toggleModulePermissions('${String(userId)}', '${String(mk)}', ${!allSelected})`);
      btn.textContent = allSelected ? (state.language === 'ar' ? 'إلغاء تحديد الكل' : 'Deselect All') : (state.language === 'ar' ? 'تحديد الكل' : 'Select All');
      const base = 'px-3 py-1.5 rounded-lg text-xs font-bold hover:opacity-80 transition-all';
      const color = String(btn.dataset.color || cfg.color || 'indigo');
      btn.className = `${base} ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : `bg-${color}-600 text-white`}`;
    }
  };

  if (moduleKey) {
    updateModule(moduleKey);
  } else {
    for (const mk of Object.keys(PERMISSION_MODULES)) updateModule(mk);
  }
}

function togglePermission(userId, moduleKey, permKey, enabled) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!user.permissions) user.permissions = {};
  if (!user.permissions[moduleKey]) user.permissions[moduleKey] = [];
  
  if (enabled) {
    if (!user.permissions[moduleKey].includes(permKey)) {
      user.permissions[moduleKey].push(permKey);
    }
  } else {
    user.permissions[moduleKey] = user.permissions[moduleKey].filter(p => p !== permKey);
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  // Add audit log
  addAuditLog('update', userId, `${enabled ? 'Granted' : 'Revoked'} permission: ${moduleKey}.${permKey} for ${user.name}`, {
    resourceType: 'user',
    permission: `${moduleKey}.${permKey}`,
    action: enabled ? 'grant' : 'revoke'
  });
  
  // Update UI in-place (no blinking)
  refreshPermissionsModalUi(userId, moduleKey);
}

function toggleModulePermissions(userId, moduleKey, enableAll) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const moduleConfig = PERMISSION_MODULES[moduleKey];
  if (!moduleConfig) return;
  
  if (!user.permissions) user.permissions = {};
  
  if (enableAll) {
    user.permissions[moduleKey] = Object.keys(moduleConfig.permissions);
  } else {
    user.permissions[moduleKey] = [];
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `${enableAll ? 'Granted all' : 'Revoked all'} ${moduleKey} permissions for ${user.name}`, {
    resourceType: 'user',
    module: moduleKey,
    action: enableAll ? 'grant_all' : 'revoke_all'
  });
  
  // Update checkbox states in-place + refresh header counts
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll(`input[type="checkbox"][data-module="${moduleKey}"]`).forEach((el) => {
      el.checked = !!enableAll;
    });
  }
  refreshPermissionsModalUi(userId, moduleKey);
}

function applyPermissionTemplate(userId, templateKey) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const template = PERMISSION_TEMPLATES[templateKey];
  if (!template) return;
  
  user.permissions = JSON.parse(JSON.stringify(template.permissions));
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Applied permission template "${template.name}" to ${user.name}`, {
    resourceType: 'user',
    template: templateKey
  });
  
  showNotification(state.language === 'ar' ? 'تم تطبيق القالب' : 'Template Applied', state.language === 'ar' ? `تم تطبيق صلاحيات "${template.name}" على ${user.name}` : `${template.name} permissions applied to ${user.name}`, 'success');
  // Update UI in-place (no blinking)
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
      const mk = el.getAttribute('data-module');
      const pk = el.getAttribute('data-perm');
      const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
      el.checked = allowed;
    });
  }
  refreshPermissionsModalUi(userId);
}

function clearAllPermissions(userId) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!confirm(state.language === 'ar' ? `مسح جميع صلاحيات ${user.name}؟ سيفقد الوصول إلى معظم الميزات.` : `Clear all permissions for ${user.name}? They will lose access to most features.`)) return;
  
  user.permissions = {};
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Cleared all permissions for ${user.name}`, {
    resourceType: 'user',
    action: 'clear_all'
  });
  
  showNotification(state.language === 'ar' ? 'تم المسح' : 'Cleared', state.language === 'ar' ? `تم مسح جميع صلاحيات ${user.name}` : `All permissions cleared for ${user.name}`, 'success');
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => { el.checked = false; });
  }
  refreshPermissionsModalUi(userId);
}

function exportUserPermissions(userId) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const exportData = {
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    exportDate: new Date().toISOString(),
    permissions: user.permissions || {}
  };
  
  const json = JSON.stringify(exportData, null, 2);
  // downloadFile returns false (with its own warning) inside FB/IG in-app
  // browsers where blob downloads silently fail — no false success toast.
  const downloaded = downloadFile(json, `permissions-${user.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  if (downloaded === false) return;

  showNotification(state.language === 'ar' ? 'تم التصدير' : 'Exported', state.language === 'ar' ? `تم تصدير صلاحيات ${user.name}` : `Permissions exported for ${user.name}`, 'success');
}

function importUserPermissions(userId) {
  if (!canManageUsersAction('managePermissions')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'تحتاج صلاحية إدارة الصلاحيات' : 'Requires the Manage Permissions permission', 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        const user = state.users.find(u => u.id === userId);
        if (!user) return;
        
        if (data.permissions) {
          user.permissions = data.permissions;
          user._lastModified = getMonotonicTime();
          markCollectionDirty('users');
          saveState();
          flushDirtyCollections().catch(() => {});
          scheduleServerUserUpdate(userId, { permissions: user.permissions });
          
          addAuditLog('update', userId, `Imported permissions for ${user.name}`, {
            resourceType: 'user',
            action: 'import'
          });
          
          showNotification(state.language === 'ar' ? 'تم الاستيراد' : 'Imported', state.language === 'ar' ? `تم استيراد صلاحيات ${user.name}` : `Permissions imported for ${user.name}`, 'success');
          const modal = document.getElementById('app-modal');
          if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
            modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
              const mk = el.getAttribute('data-module');
              const pk = el.getAttribute('data-perm');
              const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
              el.checked = allowed;
            });
          }
          refreshPermissionsModalUi(userId);
        }
      } catch (error) {
        showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'ملف صلاحيات غير صالح' : 'Invalid permissions file', 'error');
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}

// A delivery action is allowed when the user holds the matching deliveries.*
// permission (office staff), OR when they are the assigned driver acting on
// their OWN delivery. The server enforces the same rule.
function canDoDeliveryAction(action, itemId) {
  if (can('deliveries', action)) return true;
  if (isDeliveryRole(state.currentUser?.role)) {
    const item = (state.receipts || []).find(r => r.id === itemId)
      || (state.ads || []).find(a => a.id === itemId);
    if (item && String(item.deliveryPersonId || '') === String(state.currentUser?.id || '')) return true;
  }
  return false;
}

function denyDeliveryAction() {
  showNotification(
    state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
    state.language === 'ar' ? 'لا تملك صلاحية لهذا الإجراء' : 'You do not have permission for this action',
    'error'
  );
}

async function assignDelivery(itemId, userId) {
  if (!userId) return;
  const already = ((state.receipts || []).find(r => r.id === itemId) || (state.ads || []).find(a => a.id === itemId) || {}).deliveryPersonId;
  const neededAction = String(already || '').trim() ? 'reassign' : 'assign';
  if (!can('deliveries', neededAction) && !can('deliveries', 'assign')) {
    denyDeliveryAction();
    return;
  }
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  let savedOk = false;
  if (isReceipt) {
    savedOk = await updateRecord(state.receipts, itemId, { deliveryPersonId: userId });
  } else {
    savedOk = await updateRecord(state.ads, itemId, { deliveryPersonId: userId });
  }
  if (!savedOk) return;
  showNotification(state.language === 'ar' ? 'تم التعيين' : 'Assigned', state.language === 'ar' ? 'تم تعيين مندوب التوصيل' : 'Delivery person assigned', 'success');
  render();
}

async function updateDeliveryStatus(itemId, status) {
  const s = String(status || '').trim();
  if (!s) return;
  if (s === 'Canceled') {
    // Cancelling is an assign-level action for office staff; the assigned
    // driver may cancel their own delivery.
    if (!canDoDeliveryAction('assign', itemId)) {
      denyDeliveryAction();
      return;
    }
    // Require a reason (handled by modal)
    openDeliveryCancelModal(itemId);
    return;
  }
  if (s === 'Office') {
    // Treat as "delete mission" (remove from delivery tracking)
    removeDeliveryMission(itemId);
    return;
  }
  // An admin may complete a TEMP delivery RECEIPT (D#): the completion modal +
  // server hold them to the driver's proof rules. Ad deliveries and normal
  // receipts stay driver-only, so a mis-tap cannot silently settle money.
  const _adminDeliversReceipt = isCurrentUserAdmin() && state.receipts.some(r => r && !r._deleted && String(r.id) === String(itemId) && isTempDeliveryReceiptNo(r.tempReceiptNo));
  if (s === 'Delivered' && !_adminDeliversReceipt && String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification(state.language === 'ar' ? 'غير مسموح' : 'Not Allowed', state.language === 'ar' ? 'فقط سائق التوصيل المعيَّن يمكنه تحديد هذا التوصيل كـ"تم التوصيل".' : 'Only the assigned delivery driver can mark this delivery as Delivered.', 'warning');
    return;
  }
  if (s === 'Delivered') {
    // Defense in depth (only a driver or admin reaches here): route through the validated
    // collection flow instead of a bare status write. For a temp D# receipt
    // markAsCollected opens the proof modal (final receipt no. + photo +
    // collected amount); a direct deliveryStatus write skipped that and left
    // the delivery inconsistent / raised a raw server error.
    await markAsCollected(itemId);
    return;
  }
  // In Progress => accept; anything else => assign-level change.
  const neededAction = s === 'In Progress' ? 'accept' : 'assign';
  if (!canDoDeliveryAction(neededAction, itemId)) {
    denyDeliveryAction();
    return;
  }
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  let savedOk = false;
  if (isReceipt) {
    savedOk = await updateRecord(state.receipts, itemId, { deliveryStatus: s });
  } else {
    savedOk = await updateRecord(state.ads, itemId, { deliveryStatus: s });
  }
  if (!savedOk) return;
  showNotification(state.language === 'ar' ? 'تم التحديث' : 'Updated', state.language === 'ar' ? `تم تغيير الحالة إلى ${trStatus(s)}` : `Status changed to ${s}`, 'success');
  render();
}

// Rapid double taps can queue two async saves before the first render removes
// the action button. Keep one delivery mutation per item in flight; the server
// remains the authority for transitions across different devices.
const _deliveryActionInFlight = new Set();

async function markAsCollected(itemId) {
  if (!canDoDeliveryAction('markCollected', itemId)) {
    denyDeliveryAction();
    return;
  }
  const actionKey = String(itemId || '');
  if (_deliveryActionInFlight.has(actionKey)) return;
  _deliveryActionInFlight.add(actionKey);
  try {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const currentItem = isReceipt || state.ads.find(a => a.id === itemId);
  if (!currentItem || currentItem.deliveryStatus === 'Delivered') return;
  let savedOk = false;
  if (isReceipt) {
    // Temp delivery receipts require strict completion (final receipt # + photo + amounts).
    if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
      showNotification(state.language === 'ar' ? 'غير مسموح' : 'Not Allowed', state.language === 'ar' ? 'استخدم "تم التوصيل" لإكمال هذا التوصيل مع صورة الوصل والرقم النهائي.' : 'Use "Mark Delivered" to complete this delivery with receipt photo + final number.', 'warning');
      openReceiptDeliveryCompletionModal(itemId);
      return;
    }
    savedOk = await updateRecord(state.receipts, itemId, {
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Paid',
      deliveryStatus: 'Delivered'
    });
  } else {
    if (isServerModeEnabled()) {
      showNotification(
        state.language === 'ar' ? 'غير متاح' : 'Not available',
        state.language === 'ar'
          ? 'يجب تسجيل تحصيل مبلغ الإعلان من خلال سير الدفع المخصص للخادم.'
          : 'Record this ad payment through the server payment workflow; the legacy delivery shortcut is disabled in shared-server mode.',
        'warning'
      );
      return;
    }
    savedOk = await updateRecord(state.ads, itemId, {
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Completed'
    });
  }
  if (!savedOk) return;
  // Statistics are derived from delivery records. Never increment a mutable
  // counter here: a retry from another device must not count twice.
  showNotification(state.language === 'ar' ? 'تم التحصيل' : 'Collected', state.language === 'ar' ? 'تم تسجيل الدفعة كمُحصَّلة' : 'Payment marked as collected', 'success');
  render();
  } finally {
    _deliveryActionInFlight.delete(actionKey);
  }
}

async function acceptDelivery(itemId) {
  if (!canDoDeliveryAction('accept', itemId)) {
    denyDeliveryAction();
    return;
  }
  const actionKey = String(itemId || '');
  if (_deliveryActionInFlight.has(actionKey)) return;
  _deliveryActionInFlight.add(actionKey);
  try {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const currentItem = isReceipt || state.ads.find(a => a.id === itemId);
  if (!currentItem || ['In Progress', 'Delivered', 'Canceled'].includes(currentItem.deliveryStatus)) return;
  const updateData = {
    deliveryStatus: 'In Progress'
  };

  if (isReceipt) {
    if (!await updateRecord(state.receipts, itemId, updateData)) return;
  } else {
    if (!await updateRecord(state.ads, itemId, updateData)) return;
  }
  // Accepted/assigned totals are derived from the delivery records below.
  showNotification(state.language === 'ar' ? 'تم القبول' : 'Accepted', state.language === 'ar' ? 'تم قبول التوصيل' : 'Delivery accepted', 'success');
  render();
  } finally {
    _deliveryActionInFlight.delete(actionKey);
  }
}

// ==========================================
// TEMP DELIVERY RECEIPT: DRIVER CONFIRMATION FLOW
// ==========================================

function normalizePhoneToE164(phone) {
  let s = String(phone || '').trim();
  if (!s) return '';
  // Keep digits and leading +
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

function buildWhatsAppLink(phone) {
  const e164 = normalizePhoneToE164(phone);
  const digits = String(e164 || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}`;
}

function buildWhatsAppShareLink(message) {
  const text = String(message || '').trim();
  return text ? `https://wa.me/?text=${encodeURIComponent(text)}` : '';
}

function _whatsAppShareField(value, maxLength = 350) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isPendingDeliveryReceiptForShare(receipt) {
  if (!receipt || receipt._deleted || !isDeliveryReceiptRecord(receipt)) return false;
  if (getReceiptDebtType(receipt) !== 'delivery') return false;
  const deliveryStatus = String(receipt.deliveryStatus || '').trim().toLowerCase();
  return !['delivered', 'canceled', 'cancelled', 'office'].includes(deliveryStatus);
}

function canShareDeliveryReceiptToWhatsApp(receipt) {
  if (!state.currentUser?.id || !isPendingDeliveryReceiptForShare(receipt)) return false;

  const creatorId = receipt.createdBy || receipt.creatorId || '';
  const uid = String(state.currentUser.id);
  const canViewRecord = isCurrentUserAdmin()
    || currentUserHasPermission('receipts', 'view')
    || currentUserHasPermission('deliveries', 'view')
    || (currentUserHasPermission('receipts', 'viewOwn') && String(creatorId) === uid)
    || (currentUserHasPermission('deliveries', 'viewOwn') && String(receipt.deliveryPersonId || '') === uid);

  // The dispatch text contains the customer's phone and delivery address.
  return canViewRecord && (isCurrentUserAdmin() || currentUserHasPermission('customers', 'viewContacts'));
}

function _getDeliveryReceiptForWhatsApp(receiptId) {
  const rid = String(receiptId || '').trim();
  if (!rid) return null;
  const receipt = (state.receipts || []).find(item => item && !item._deleted && String(item.id) === rid);
  return receipt && canShareDeliveryReceiptToWhatsApp(receipt) ? receipt : null;
}

function buildDeliveryReceiptWhatsAppMessage(receipt) {
  if (!receipt || receipt._deleted) return '';
  const isAr = state.language === 'ar';
  const customer = (state.customers || []).find(item => item && !item._deleted && String(item.id) === String(receipt.customerId || ''));
  const driver = (state.users || []).find(item => item && !item._deleted && String(item.id) === String(receipt.deliveryPersonId || ''));
  const creatorId = receipt.createdBy || receipt.creatorId || '';
  const customerPhoneEntry = Array.isArray(customer?.phones) ? customer.phones.find(Boolean) : '';
  const customerPhone = (customerPhoneEntry && typeof customerPhoneEntry === 'object')
    ? (customerPhoneEntry.number || customerPhoneEntry.phone || customerPhoneEntry.value || '')
    : customerPhoneEntry;

  const number = _whatsAppShareField(receipt.tempReceiptNo || receipt.finalReceiptNo || receipt.serialNumber || '—', 80);
  const customerName = _whatsAppShareField(customer?.name || 'Unknown', 160);
  const phone = _whatsAppShareField(receipt.phoneNumber || customerPhone || '—', 80);
  const place = _whatsAppShareField(receipt.deliveryPlaceName || '—', 350);
  const driverName = _whatsAppShareField(driver?.name || '—', 160);
  const instructions = _whatsAppShareField(receipt.deliveryInstructions || '—', 500);
  const creatorName = _whatsAppShareField(getKnownUserNameById(creatorId) || String(receipt.createdByName || '').trim() || state.currentUser?.name || '—', 160);
  const collectionTarget = getReceiptCollectionTarget(receipt);
  const debtUSD = collectionTarget.amountUSD;
  const debtLocal = collectionTarget.amountLocal;
  const deliveryFee = Number(receipt.quotedDeliveryFee || 0) || 0;
  const money = `${debtLocal.toFixed(2)} LYD${debtUSD > 0 ? ` ($${debtUSD.toFixed(2)})` : ''}`;

  const lines = isAr ? [
    '🚚 توصيل جديد - البيان',
    `رقم الوصل: ${number}`,
    `العميل: ${customerName}`,
    `الهاتف: ${phone}`,
    `مكان التوصيل: ${place}`,
    `المندوب: ${driverName}`,
    `المبلغ المطلوب تحصيله: ${money}`,
    `رسوم التوصيل: ${deliveryFee.toFixed(2)} LYD`,
    'الحالة: غير مدفوع',
    `ملاحظات: ${instructions}`,
    `أنشأه: ${creatorName}`
  ] : [
    '🚚 New Albayan delivery',
    `Receipt: ${number}`,
    `Customer: ${customerName}`,
    `Phone: ${phone}`,
    `Delivery place: ${place}`,
    `Assigned driver: ${driverName}`,
    `Amount to collect: ${money}`,
    `Delivery fee: ${deliveryFee.toFixed(2)} LYD`,
    'Payment status: Not Paid',
    `Instructions: ${instructions}`,
    `Created by: ${creatorName}`
  ];
  return lines.join('\n').slice(0, 1800);
}

let _deliveryWhatsAppReturnFocus = null;

function closeDeliveryWhatsAppPrompt(restoreFocus = true) {
  document.getElementById('delivery-whatsapp-share-dialog')?.remove();
  if (restoreFocus && _deliveryWhatsAppReturnFocus?.focus) {
    try { _deliveryWhatsAppReturnFocus.focus(); } catch (_) {}
  }
  _deliveryWhatsAppReturnFocus = null;
}

async function copyDeliveryReceiptWhatsAppMessage(receiptId) {
  const receipt = _getDeliveryReceiptForWhatsApp(receiptId);
  if (!receipt) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يمكنك مشاركة معلومات هذا التوصيل.' : 'You cannot share this delivery information.', 'error');
    return;
  }
  const copied = await copyTextToClipboard(buildDeliveryReceiptWhatsAppMessage(receipt));
  showNotification(
    copied ? (state.language === 'ar' ? 'تم النسخ' : 'Copied') : (state.language === 'ar' ? 'تعذر النسخ' : 'Copy failed'),
    copied ? (state.language === 'ar' ? 'تم نسخ معلومات التوصيل.' : 'Delivery information copied.') : (state.language === 'ar' ? 'انسخ النص من المعاينة يدوياً.' : 'Copy the text from the preview manually.'),
    copied ? 'success' : 'error'
  );
}

function closeNativeDeliverySharePrompt() {
  closeDeliveryWhatsAppPrompt(false);
}

async function openDeliveryReceiptWhatsAppShare(receiptId) {
  const receipt = _getDeliveryReceiptForWhatsApp(receiptId);
  const isAr = state.language === 'ar';
  if (!receipt) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'لا يمكنك مشاركة معلومات هذا التوصيل.' : 'You cannot share this delivery information.', 'error');
    return;
  }
  const message = buildDeliveryReceiptWhatsAppMessage(receipt);
  if (isPackagedMobileApp() && typeof nativeShareContent === 'function') {
    const shared = await nativeShareContent({
      title: isAr ? 'توصيل جديد - البيان' : 'New Albayan delivery',
      text: message
    });
    if (shared) closeNativeDeliverySharePrompt();
    return;
  }
  const url = buildWhatsAppShareLink(message);
  if (!url) return;

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // FB/IG/Messenger in-app browsers drop script-initiated _blank navigations
  // inconsistently (and iOS never auto-launches an app from a JS navigation).
  // The attempt above is harmless when the shell honors it — but do NOT tear
  // down the dialog (it holds the working Copy fallback) and do NOT claim
  // WhatsApp opened. Keep the preview open and tell the user the way out.
  if (typeof Platform !== 'undefined' && Platform.isInAppBrowser) {
    showNotification(
      isAr ? 'إن لم يفتح واتساب' : 'If WhatsApp did not open',
      isAr
        ? 'داخل متصفح فيسبوك/إنستغرام قد لا يعمل فتح واتساب — انسخ النص من المعاينة، أو افتح هذه الصفحة في متصفحك الحقيقي.'
        : 'Inside the Facebook/Instagram browser the handoff may not work — copy the text from the preview, or open this page in your real browser.',
      'warning'
    );
    return;
  }
  closeDeliveryWhatsAppPrompt(false);
  showNotification(
    isAr ? 'تم فتح واتساب' : 'WhatsApp opened',
    isAr ? 'اختر مجموعة العمل ثم اضغط إرسال. لم يتم الإرسال تلقائياً.' : 'Choose your business group and press Send. Nothing was sent automatically.',
    'info'
  );
}

function showDeliveryWhatsAppPrompt(receiptId, triggerButton = null) {
  const receipt = _getDeliveryReceiptForWhatsApp(receiptId);
  const isAr = state.language === 'ar';
  if (!receipt) {
    showNotification(isAr ? 'غير متاح' : 'Not available', isAr ? 'هذا التوصيل غير متاح للمشاركة أو لا توجد لديك صلاحية لبيانات الاتصال.' : 'This delivery cannot be shared, or you do not have contact-data permission.', 'error');
    return;
  }

  closeDeliveryWhatsAppPrompt(false);
  _deliveryWhatsAppReturnFocus = triggerButton || document.activeElement;
  const message = buildDeliveryReceiptWhatsAppMessage(receipt);
  const receiptNo = _whatsAppShareField(receipt.tempReceiptNo || receipt.finalReceiptNo || receipt.serialNumber || '', 80);
  const dialog = document.createElement('div');
  dialog.id = 'delivery-whatsapp-share-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'delivery-whatsapp-share-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-xl max-h-[92dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-emerald-600 mb-1"><i data-lucide="message-circle" class="w-5 h-5"></i><span class="text-xs font-bold uppercase">WhatsApp</span></div>
          <h2 id="delivery-whatsapp-share-title" class="text-xl font-bold text-slate-800 dark:text-white">${isAr ? 'مشاركة معلومات التوصيل' : 'Share delivery information'}</h2>
          ${receiptNo ? `<p class="text-sm text-slate-500 mt-1">${isAr ? 'الوصل' : 'Receipt'}: ${Security.escapeHtml(receiptNo)}</p>` : ''}
        </div>
        <button type="button" onclick="closeDeliveryWhatsAppPrompt()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center" aria-label="${isAr ? 'إغلاق' : 'Close'}"><span class="text-2xl leading-none" aria-hidden="true">&times;</span></button>
      </div>
      <div class="p-4 sm:p-5 overflow-y-auto">
        <div class="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3 mb-4 text-sm text-amber-800 dark:text-amber-200">
          ${isAr ? 'لم يتم إرسال أي شيء بعد. سيفتح واتساب، ثم اختر مجموعة العمل واضغط إرسال.' : 'Nothing has been sent yet. WhatsApp will open; choose your business group and press Send.'}
        </div>
        <div class="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">${isAr ? 'معاينة الرسالة' : 'Message preview'}</div>
        <pre class="whitespace-pre-wrap break-words rounded-xl bg-slate-50 dark:bg-slate-800 p-3 text-sm text-slate-700 dark:text-slate-200 max-h-[42dvh] overflow-y-auto font-sans">${Security.escapeHtml(message)}</pre>
        <p class="text-xs text-slate-500 mt-3">${isAr ? 'تحتوي الرسالة على هاتف العميل ومكان التوصيل وستتم مشاركتها خارج نظام البيان.' : 'This message contains the customer phone and delivery place and will be shared outside Albayan.'}</p>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-2 p-4 sm:p-5 border-t border-slate-200 dark:border-slate-700">
        <button type="button" data-receipt-id="${Security.escapeHtml(String(receipt.id || ''))}" onclick="copyDeliveryReceiptWhatsAppMessage(this.dataset.receiptId)" class="min-h-11 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-200 flex items-center justify-center gap-2"><i data-lucide="copy" class="w-4 h-4"></i>${isAr ? 'نسخ' : 'Copy'}</button>
        <button id="delivery-whatsapp-share-button" type="button" data-receipt-id="${Security.escapeHtml(String(receipt.id || ''))}" onclick="openDeliveryReceiptWhatsAppShare(this.dataset.receiptId)" class="min-h-11 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center justify-center gap-2"><i data-lucide="message-circle" class="w-5 h-5"></i>${isAr ? 'فتح واتساب' : 'Open WhatsApp'}</button>
        <button type="button" onclick="closeDeliveryWhatsAppPrompt()" class="min-h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-slate-600 dark:text-slate-300">${isAr ? 'لاحقاً' : 'Later'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeDeliveryWhatsAppPrompt();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeDeliveryWhatsAppPrompt();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.appendChild(dialog);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('delivery-whatsapp-share-button')?.focus(), 0);
}

function compareFees(quoted, actual) {
  const q = Number(quoted) || 0;
  const a = Number(actual) || 0;
  const diff = a - q;
  if (Math.abs(diff) < 0.000001) return { feeDifferenceStatus: 'SAME', feeDiff: 0 };
  if (diff < 0) return { feeDifferenceStatus: 'LOWER', feeDiff: diff };
  return { feeDifferenceStatus: 'HIGHER', feeDiff: diff };
}

function compareDebt(debtAmount, collectedAmount) {
  const d = Number(debtAmount) || 0;
  const c = Number(collectedAmount) || 0;
  const difference = c - d;
  if (Math.abs(difference) < 0.000001) return { paymentResult: 'PAID_EXACT', difference: 0, overpaidAmount: 0, remainingDue: 0 };
  if (difference > 0) return { paymentResult: 'OVERPAID', difference, overpaidAmount: difference, remainingDue: 0 };
  return { paymentResult: 'UNDERPAID', difference, overpaidAmount: 0, remainingDue: Math.abs(difference) };
}

function _findReceiptForDeliveryModal(receiptId) {
  const rid = String(receiptId || '');
  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === rid);
  return receipt || null;
}

function _receiptFinalNoExists(serial, excludeId) {
  const s = String(serial || '').trim();
  if (!s) return false;
  return !!state.receipts.find(r =>
    r && !r._deleted &&
    String(r.id) !== String(excludeId || '') &&
    (String(r.serialNumber || '').trim() === s || String(r.finalReceiptNo || '').trim() === s)
  );
}

// ==========================================
// IMAGE COMPRESSION (shared by all photo uploads)
// ==========================================
// A phone camera photo is often 3-6MB; stored as a base64 data URL inside a
// record it inflates every save, sync payload and export by that amount.
// Downscaling to max 1280px JPEG (~80% quality) keeps receipts perfectly
// readable while shrinking payloads 10-20x. PNG stays PNG (transparency),
// and on ANY failure we fall back to the original uncompressed data URL so
// a photo is never lost.
const IMAGE_MAX_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.8;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target?.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

async function compressImageToDataUrl(file) {
  let originalDataUrl = await readFileAsDataUrl(file);
  try {
    let type = String(file.type || '').toLowerCase();
    // Android SAF/content-provider pickers (third-party file managers, Drive
    // routes, FB/IG WebView choosers) hand over real JPEGs with a BLANK or
    // generic MIME type; readAsDataURL then emits data:application/octet-stream
    // and isSafeReceiptPhotoSource rejects a perfectly decodable photo as
    // "unsupported". Sniff the base64 magic bytes and rewrite the prefix so
    // EVERY exit path below (GIF keep-original, small-file keep-original,
    // larger-output keep-original, catch fallback) emits a proper
    // data:image/... URL. Genuinely non-image files sniff to nothing and are
    // rejected exactly as before.
    if (!type || type === 'application/octet-stream') {
      const b64 = originalDataUrl.slice(originalDataUrl.indexOf(',') + 1);
      if (b64.startsWith('/9j/')) type = 'image/jpeg';
      else if (b64.startsWith('iVBOR')) type = 'image/png';
      else if (b64.startsWith('R0lGOD')) type = 'image/gif';
      else if (b64.startsWith('UklGR')) type = 'image/webp';
      else type = '';
      if (type) originalDataUrl = 'data:' + type + ';base64,' + b64;
    }
    if (!/^image\//.test(type)) return originalDataUrl;
    // Animated GIFs cannot survive a canvas re-encode (only the first frame
    // would remain) — always keep them untouched.
    if (type === 'image/gif') return originalDataUrl;
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image decode failed'));
      image.src = originalDataUrl;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return originalDataUrl;
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(w, h));
    // PNG and WebP may carry transparency — re-encode as PNG to keep it.
    const keepAlpha = /image\/(png|webp)/.test(type);
    // Small already and not worth re-encoding? Keep the original.
    if (scale === 1 && originalDataUrl.length < 300 * 1024) return originalDataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalDataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = keepAlpha
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    // Only use the compressed version if it is actually smaller.
    return (out && out.length < originalDataUrl.length) ? out : originalDataUrl;
  } catch (_) {
    return originalDataUrl;
  }
}

// ==========================================
// RECEIPT PHOTO VIEWER
// ==========================================
// Normal receipt uploads are stored in photos[], while completed delivery
// receipts also keep a legacy receiptImage field. Read both so the same viewer
// works everywhere and older receipt photos do not disappear from the UI.
function isSafeReceiptPhotoSource(value) {
  const source = String(value || '').trim();
  // Keep this aligned with the server's MAX_DATA_URL_LENGTH. Matching the
  // complete value prevents an image prefix from hiding HTML/script content.
  if (!source || source.length > 8 * 1024 * 1024) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(source)) return true;
  // Stored remote/relative image paths are supported, but quotes, whitespace,
  // angle brackets and backticks are forbidden so the value is attribute-safe.
  if (/^https:\/\/[^\s"'<>`]+$/i.test(source)) return true;
  return /^(?:\/|\.\/|\.\.\/)[^\s"'<>`]+$/.test(source);
}

// Distinguish "valid image, just bigger than the 8M-char cap above" from a
// truly unsupported format, so an oversized JPG gets the "too large" message
// instead of being told it is not a JPG. Prefix-only regex: never run a
// full-string pattern over an 8M+ character value. Keep the size threshold
// aligned with isSafeReceiptPhotoSource.
function isOversizedReceiptPhotoSource(value) {
  const source = String(value || '').trim();
  return source.length > 8 * 1024 * 1024
    && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source);
}

function getReceiptPhotoSources(receipt) {
  if (!receipt || typeof receipt !== 'object') return [];
  const raw = [
    ...(Array.isArray(receipt.photos) ? receipt.photos : []),
    receipt.receiptImage
  ];
  const seen = new Set();
  return raw.reduce((photos, value) => {
    const source = String(value || '').trim();
    if (!isSafeReceiptPhotoSource(source) || seen.has(source)) return photos;
    seen.add(source);
    photos.push(source);
    return photos;
  }, []);
}

function getReceiptPhotoCount(receipt) {
  const loaded = getReceiptPhotoSources(receipt).length;
  return loaded || getEntityPhotoCountHint('receipts', receipt);
}

function getAdPhotoSources(ad) {
  if (!ad || typeof ad !== 'object') return [];
  const raw = [
    ...(Array.isArray(ad.adPhotos) ? ad.adPhotos : []),
    ...(Array.isArray(ad.photos) ? ad.photos : [])
  ];
  const seen = new Set();
  return raw.reduce((photos, value) => {
    const source = String(value || '').trim();
    if (!isSafeReceiptPhotoSource(source) || seen.has(source)) return photos;
    seen.add(source);
    photos.push(source);
    return photos;
  }, []);
}

function getAdPhotoCount(ad) {
  const loaded = getAdPhotoSources(ad).length;
  return loaded || getEntityPhotoCountHint('ads', ad);
}

// Only the small index is stored on the ad. The actual uploaded photos remain
// in adPhotos/photos and are fetched on demand, so choosing a main photo does
// not re-upload several megabytes of images.
function getAdPrimaryPhotoIndex(ad, sourceCount = getAdPhotoCount(ad)) {
  const count = Array.isArray(sourceCount)
    ? sourceCount.length
    : Math.max(0, Number(sourceCount) || 0);
  if (!count) return 0;
  const index = Number(ad?.primaryAdPhotoIndex);
  return Number.isSafeInteger(index) && index >= 0 && index < count ? index : 0;
}

// In delivery completion, receiptImage is the driver's proof photo and must
// win over older/general attachments in photos[]. Otherwise simply re-saving
// a delivery could replace the proof with photos[0].
function getDeliveryReceiptPhotoSource(receipt) {
  const proofPhoto = String(receipt?.receiptImage || '').trim();
  if (isSafeReceiptPhotoSource(proofPhoto)) return proofPhoto;
  return getReceiptPhotoSources(receipt)[0] || '';
}

let _receiptPhotoViewerSources = [];
let _receiptPhotoViewerIndex = 0;
let _receiptPhotoViewerLabel = '';
let _receiptPhotoViewerReturnFocus = null;
let _adPrimaryPhotoPickerReturnFocus = null;
let _receiptPhotoUploadGeneration = 0;
let _adPhotoUploadGeneration = 0;
let _receiptPhotoUploadsInFlight = 0;
let _adPhotoUploadsInFlight = 0;

async function openReceiptPhotoViewer(receiptId, index = 0) {
  let receipt = (state.receipts || []).find(item => item && !item._deleted && String(item.id) === String(receiptId));
  if (!receipt) return;
  try {
    receipt = await ensureEntityMediaLoaded('receipts', receiptId);
  } catch (_) {
    showNotification(
      state.language === 'ar' ? 'تعذر تحميل الصور' : 'Photos unavailable',
      state.language === 'ar' ? 'تحقق من الاتصال ثم حاول مرة أخرى.' : 'Check the connection and try again.',
      'error'
    );
    return;
  }
  if (!receipt) return;
  const number = receipt.finalReceiptNo || receipt.serialNumber || receipt.tempReceiptNo || '';
  openReceiptPhotoViewerSources(
    getReceiptPhotoSources(receipt),
    index,
    number ? `${state.language === 'ar' ? 'صورة الوصل' : 'Receipt photo'} #${number}` : (state.language === 'ar' ? 'صورة الوصل' : 'Receipt photo')
  );
}

async function openAdPhotoViewer(adId, index = 0, triggerButton = null) {
  if (!can('ads', 'viewPhotos')) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar' ? 'تحتاج صلاحية عرض صور الإعلانات' : 'Requires the View Photos permission',
      'error'
    );
    return;
  }
  let ad = (state.ads || []).find(item => item && !item._deleted && String(item.id) === String(adId));
  if (!ad) return;
  const busyLabel = triggerButton?.querySelector?.('[data-photo-loading-label]') || null;
  const originalLabel = busyLabel?.textContent || '';
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.setAttribute?.('aria-busy', 'true');
    if (busyLabel) busyLabel.textContent = state.language === 'ar' ? 'جارٍ تحميل الصور...' : 'Loading photos...';
  }
  try {
    ad = await ensureEntityMediaLoaded('ads', adId);
  } catch (_) {
    showNotification(
      state.language === 'ar' ? 'تعذر تحميل الصور' : 'Photos unavailable',
      state.language === 'ar' ? 'تحقق من الاتصال ثم حاول مرة أخرى.' : 'Check the connection and try again.',
      'error'
    );
    return;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.removeAttribute?.('aria-busy');
      if (busyLabel) busyLabel.textContent = originalLabel;
    }
  }
  if (!ad) return;
  openReceiptPhotoViewerSources(
    getAdPhotoSources(ad),
    index,
    state.language === 'ar' ? 'صور الإعلان' : 'Ad photos'
  );
}

async function openAdPrimaryPhotoPicker(adId, triggerButton = null) {
  if (!can('ads', 'viewPhotos')) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar' ? 'تحتاج صلاحية عرض صور الإعلانات.' : 'Requires the View Photos permission.',
      'error'
    );
    return;
  }
  let ad = (state.ads || []).find(item => item && !item._deleted && String(item.id) === String(adId));
  if (!ad || !canActOnRecord('ads', 'edit', ad.creatorId || ad.createdBy)) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar' ? 'لا يمكنك تغيير الصورة الرئيسية لهذا الإعلان.' : 'You cannot change this ad\'s main photo.',
      'error'
    );
    return;
  }

  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.setAttribute('aria-busy', 'true');
  }
  try {
    ad = await ensureEntityMediaLoaded('ads', adId);
  } catch (_) {
    showNotification(
      state.language === 'ar' ? 'تعذر تحميل الصور' : 'Photos unavailable',
      state.language === 'ar' ? 'تحقق من الاتصال ثم حاول مرة أخرى.' : 'Check the connection and try again.',
      'error'
    );
    return;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.removeAttribute('aria-busy');
    }
  }

  const photos = getAdPhotoSources(ad);
  if (photos.length < 2) {
    if (photos.length === 1) openAdPhotoViewer(adId, 0, triggerButton);
    return;
  }

  closeAdPrimaryPhotoPicker(false);
  _adPrimaryPhotoPickerReturnFocus = triggerButton || document.activeElement;
  const isAr = state.language === 'ar';
  const selectedIndex = getAdPrimaryPhotoIndex(ad, photos.length);
  const picker = document.createElement('div');
  picker.id = 'ad-primary-photo-picker';
  picker.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-modal', 'true');
  picker.setAttribute('aria-labelledby', 'ad-primary-photo-picker-title');
  picker.tabIndex = -1;
  picker.innerHTML = `
    <div class="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onclick="event.stopPropagation()">
      <div class="flex items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
        <div>
          <h2 id="ad-primary-photo-picker-title" class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'اختر الصورة الرئيسية' : 'Choose the main photo'}</h2>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${isAr ? 'ستظهر الصورة المختارة مباشرة في قائمة الإعلانات.' : 'The selected photo will appear directly in the Ads list.'}</p>
        </div>
        <button type="button" onclick="closeAdPrimaryPhotoPicker()" class="touch-target inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <div class="max-h-[70dvh] overflow-y-auto p-4">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          ${photos.map((source, index) => {
            const selected = index === selectedIndex;
            const label = isAr ? `اختيار الصورة ${index + 1} كرئيسية` : `Choose photo ${index + 1} as main`;
            return `<button type="button" data-ad-id="${Security.escapeHtml(String(ad.id || ''))}" data-primary-photo-index="${index}" onclick="setAdPrimaryPhoto(this.dataset.adId, Number(this.dataset.primaryPhotoIndex), this)" class="group relative overflow-hidden rounded-xl border-2 ${selected ? 'border-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900' : 'border-slate-200 hover:border-indigo-400 dark:border-slate-700'} bg-slate-100 text-left transition" aria-label="${label}" ${selected ? 'aria-current="true"' : ''}>
              <img src="${Security.escapeHtml(source)}" alt="${isAr ? `صورة الإعلان ${index + 1}` : `Ad photo ${index + 1}`}" class="aspect-square w-full object-cover" loading="lazy" decoding="async">
              <span class="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-slate-950/75 px-2 py-1.5 text-[11px] font-bold text-white"><span>${isAr ? `صورة ${index + 1}` : `Photo ${index + 1}`}</span>${selected ? `<span class="inline-flex items-center gap-1 text-emerald-300"><i data-lucide="check-circle-2" class="h-3.5 w-3.5"></i>${isAr ? 'الرئيسية' : 'Main'}</span>` : `<span>${isAr ? 'اختيار' : 'Choose'}</span>`}</span>
            </button>`;
          }).join('')}
        </div>
      </div>
    </div>`;
  picker.addEventListener('click', event => {
    if (event.target === picker) closeAdPrimaryPhotoPicker();
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAdPrimaryPhotoPicker();
  });
  document.body.appendChild(picker);
  IconQueue.schedule(picker);
  picker.focus();
}

async function setAdPrimaryPhoto(adId, index, button = null) {
  const ad = (state.ads || []).find(item => item && !item._deleted && String(item.id) === String(adId));
  const photos = getAdPhotoSources(ad);
  if (!ad || !can('ads', 'viewPhotos') || !canActOnRecord('ads', 'edit', ad.creatorId || ad.createdBy)) return;
  if (!Number.isSafeInteger(index) || index < 0 || index >= photos.length) return;
  const picker = document.getElementById('ad-primary-photo-picker');
  picker?.querySelectorAll('button').forEach(item => { item.disabled = true; });
  button?.setAttribute('aria-busy', 'true');
  const saved = await updateRecord(state.ads, ad.id, { primaryAdPhotoIndex: index }, ad._lastModified);
  if (!saved) {
    picker?.querySelectorAll('button').forEach(item => { item.disabled = false; });
    button?.removeAttribute('aria-busy');
    return;
  }
  closeAdPrimaryPhotoPicker();
  showNotification(
    state.language === 'ar' ? 'تم اختيار الصورة الرئيسية' : 'Main photo selected',
    state.language === 'ar' ? 'ستظهر هذه الصورة الآن من خارج الإعلان.' : 'This photo now appears on the Ads list.',
    'success'
  );
}

function closeAdPrimaryPhotoPicker(restoreFocus = true) {
  document.getElementById('ad-primary-photo-picker')?.remove();
  if (restoreFocus) {
    const returnFocus = _adPrimaryPhotoPickerReturnFocus;
    _adPrimaryPhotoPickerReturnFocus = null;
    setTimeout(() => returnFocus?.focus?.(), 0);
  }
}

function openPendingReceiptPhotoViewer(index = 0) {
  openReceiptPhotoViewerSources(
    (state.tempReceiptPhotos || []).filter(isSafeReceiptPhotoSource),
    index,
    state.language === 'ar' ? 'معاينة صورة الوصل' : 'Receipt photo preview'
  );
}

function openPendingAdPhotoViewer(index = 0) {
  if (!can('ads', 'viewPhotos')) return;
  openReceiptPhotoViewerSources(
    (state.tempAdPhotos || []).filter(isSafeReceiptPhotoSource),
    index,
    state.language === 'ar' ? 'معاينة صورة الإعلان' : 'Ad photo preview'
  );
}

function openDeliveryReceiptPhotoViewer() {
  const source = document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '';
  openReceiptPhotoViewerSources(
    [source].filter(isSafeReceiptPhotoSource),
    0,
    state.language === 'ar' ? 'صورة وصل التوصيل' : 'Delivery receipt photo'
  );
}

function openReceiptPhotoViewerSources(sources, index = 0, label = '') {
  const safeSources = (Array.isArray(sources) ? sources : []).filter(isSafeReceiptPhotoSource);
  if (!safeSources.length) return;
  document.getElementById('receipt-photo-viewer')?.remove();
  _receiptPhotoViewerSources = [...new Set(safeSources)];
  _receiptPhotoViewerIndex = Math.min(Math.max(Number(index) || 0, 0), _receiptPhotoViewerSources.length - 1);
  _receiptPhotoViewerLabel = String(label || (state.language === 'ar' ? 'صورة الوصل' : 'Receipt photo'));
  _receiptPhotoViewerReturnFocus = document.activeElement;

  const viewer = document.createElement('div');
  viewer.id = 'receipt-photo-viewer';
  viewer.className = 'receipt-photo-viewer fixed inset-0 z-[100] bg-slate-950/95 flex flex-col p-3 sm:p-5';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', _receiptPhotoViewerLabel);
  viewer.tabIndex = -1;
  viewer.innerHTML = `
    <div class="flex items-center justify-between gap-3 text-white pb-3">
      <div class="min-w-0">
        <div id="receipt-photo-viewer-title" class="font-bold truncate"></div>
        <div id="receipt-photo-viewer-counter" class="text-xs text-slate-300 mt-0.5"></div>
      </div>
      <button type="button" onclick="closeReceiptPhotoViewer()" class="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center flex-shrink-0" aria-label="${state.language === 'ar' ? 'إغلاق الصورة' : 'Close photo'}">
        <i data-lucide="x" class="w-6 h-6"></i>
      </button>
    </div>
    <div class="receipt-photo-stage relative flex-1 min-h-0 flex items-center justify-center" data-receipt-photo-backdrop="true">
      <button id="receipt-photo-viewer-prev" type="button" onclick="changeReceiptPhotoViewer(-1)" class="absolute z-10 left-1 sm:left-4 w-11 h-11 rounded-full bg-black/55 hover:bg-black/75 text-white flex items-center justify-center" aria-label="${state.language === 'ar' ? 'الصورة السابقة' : 'Previous photo'}">
        <i data-lucide="chevron-left" class="w-7 h-7"></i>
      </button>
      <img id="receipt-photo-viewer-image" class="receipt-photo-full max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
      <button id="receipt-photo-viewer-next" type="button" onclick="changeReceiptPhotoViewer(1)" class="absolute z-10 right-1 sm:right-4 w-11 h-11 rounded-full bg-black/55 hover:bg-black/75 text-white flex items-center justify-center" aria-label="${state.language === 'ar' ? 'الصورة التالية' : 'Next photo'}">
        <i data-lucide="chevron-right" class="w-7 h-7"></i>
      </button>
    </div>
    <div class="text-center text-xs text-slate-300 pt-3">${state.language === 'ar' ? 'اضغط خارج الصورة أو زر الإغلاق للعودة' : 'Click outside the photo or use Close to return'}</div>
  `;
  viewer.addEventListener('click', event => {
    if (event.target === viewer || event.target?.dataset?.receiptPhotoBackdrop === 'true') closeReceiptPhotoViewer();
  });
  viewer.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeReceiptPhotoViewer();
    if (event.key === 'ArrowLeft') changeReceiptPhotoViewer(-1);
    if (event.key === 'ArrowRight') changeReceiptPhotoViewer(1);
  });
  document.body.appendChild(viewer);
  renderReceiptPhotoViewer();
  IconQueue.schedule(viewer);
  viewer.focus();
}

function renderReceiptPhotoViewer() {
  const viewer = document.getElementById('receipt-photo-viewer');
  if (!viewer || !_receiptPhotoViewerSources.length) return;
  const image = document.getElementById('receipt-photo-viewer-image');
  const title = document.getElementById('receipt-photo-viewer-title');
  const counter = document.getElementById('receipt-photo-viewer-counter');
  const previous = document.getElementById('receipt-photo-viewer-prev');
  const next = document.getElementById('receipt-photo-viewer-next');
  if (image) {
    image.src = _receiptPhotoViewerSources[_receiptPhotoViewerIndex];
    image.alt = `${_receiptPhotoViewerLabel} ${_receiptPhotoViewerIndex + 1}`;
  }
  if (title) title.textContent = _receiptPhotoViewerLabel;
  if (counter) counter.textContent = `${_receiptPhotoViewerIndex + 1} / ${_receiptPhotoViewerSources.length}`;
  if (previous) previous.hidden = _receiptPhotoViewerSources.length < 2;
  if (next) next.hidden = _receiptPhotoViewerSources.length < 2;
}

function changeReceiptPhotoViewer(direction) {
  if (_receiptPhotoViewerSources.length < 2) return;
  const delta = Number(direction) < 0 ? -1 : 1;
  _receiptPhotoViewerIndex = (_receiptPhotoViewerIndex + delta + _receiptPhotoViewerSources.length) % _receiptPhotoViewerSources.length;
  renderReceiptPhotoViewer();
}

function closeReceiptPhotoViewer(restoreFocus = true) {
  document.getElementById('receipt-photo-viewer')?.remove();
  _receiptPhotoViewerSources = [];
  _receiptPhotoViewerIndex = 0;
  _receiptPhotoViewerLabel = '';
  if (restoreFocus && _receiptPhotoViewerReturnFocus?.focus) _receiptPhotoViewerReturnFocus.focus();
  _receiptPhotoViewerReturnFocus = null;
}

function handleDeliveryReceiptPhotoUpload(fileList) {
  const file = fileList && fileList.length ? fileList[0] : null;
  if (!file) return;
  compressImageToDataUrl(file).then((dataUrl) => {
    if (!isSafeReceiptPhotoSource(dataUrl)) {
      // A valid image over the cap must say "too large", not "unsupported" —
      // telling a driver their JPG is not a JPG misdirects the retry.
      if (isOversizedReceiptPhotoSource(dataUrl)) {
        _showPhotoPayloadLimit();
        return;
      }
      showNotification(
        state.language === 'ar' ? 'صيغة صورة غير مدعومة' : 'Unsupported photo',
        state.language === 'ar' ? 'استخدم صورة PNG أو JPG أو WEBP أو GIF.' : 'Use a PNG, JPG, WEBP, or GIF image.',
        'error'
      );
      return;
    }
    const hidden = document.getElementById('delivery-receipt-image-data');
    if (hidden) hidden.dataset.imageData = dataUrl;
    const img = document.getElementById('delivery-receipt-image-preview');
    if (img) img.src = dataUrl;
    document.getElementById('delivery-receipt-image-button')?.classList.remove('hidden');
    document.getElementById('delivery-receipt-image-empty')?.classList.add('hidden');
    updateReceiptDeliveryCompletionComputed();
  }).catch((err) => {
    // compressImageToDataUrl only rejects when the FileReader itself fails
    // (iCloud photo that cannot download, expired Android picker document,
    // WebView memory pressure). The proof photo is REQUIRED, so silence here
    // left the driver staring at a disabled submit with no explanation.
    try { console.warn('[deliveryPhoto] Could not read the picked photo:', err?.message || err); } catch (_) {}
    showNotification(
      state.language === 'ar' ? 'خطأ' : 'Error',
      state.language === 'ar' ? 'تعذر قراءة الصورة — حاول مرة أخرى أو اختر صورة أخرى.' : 'Could not read the photo — try again or pick a different photo.',
      'error'
    );
  });
}

// ---- Delivery completion draft (survives Android camera round-trips) -------------
// Tapping the photo input launches the camera activity; on low-RAM phones and
// inside Facebook/Instagram in-app WebViews the OS routinely kills the browser
// process while the camera is foreground, cold-reloading the SPA and destroying
// the transient completion modal. Persist a draft of the typed fields (and the
// already-delivered photo) so reopening the modal restores the driver's work.
// localStorage, NOT sessionStorage: in-app WebView sessionStorage is process
// memory and dies with exactly the kill being defended against.
const _DELIVERY_DRAFT_PREFIX = 'albayan_delivery_draft_';
const _DELIVERY_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let _deliveryDraftSaveTimer = null;

function _deliveryDraftKey(receiptId) {
  return _DELIVERY_DRAFT_PREFIX + String(receiptId || '');
}

// Flush the pending debounced draft write immediately. The 500ms debounce
// alone lost the newest keystrokes in the exact scenario the draft exists
// for: tapping the photo Upload label backgrounds the WebView for the
// camera, timers are suspended before the pending write fires, and the
// process kill happens with the draft stale. visibilitychange:hidden is the
// last reliable moment to write; pagehide covers bfcache navigations.
// _saveDeliveryCompletionDraftNow() self-guards (no completion modal -> no-op),
// so these listeners are safe to keep registered permanently.
function _flushDeliveryCompletionDraftNow() {
  if (_deliveryDraftSaveTimer) {
    clearTimeout(_deliveryDraftSaveTimer);
    _deliveryDraftSaveTimer = null;
  }
  try { _saveDeliveryCompletionDraftNow(); } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _flushDeliveryCompletionDraftNow();
});
window.addEventListener('pagehide', _flushDeliveryCompletionDraftNow, { passive: true });

function _saveDeliveryCompletionDraftNow() {
  const modal = document.getElementById('delivery-complete-modal');
  if (!modal) return;
  const rid = String(modal.dataset.receiptId || '');
  if (!rid) return;
  const rowsEl = document.getElementById('delivery-collected-payments');
  const collected = rowsEl
    ? Array.from(rowsEl.querySelectorAll('.payment-split-item')).map(item => ({
        method: item.querySelector('.payment-method')?.value || '',
        amount: item.querySelector('.payment-amount')?.value || '',
        rate1: item.querySelector('.payment-rate1')?.value || '',
        rate2: item.querySelector('.payment-rate2')?.value || ''
      }))
    : [];
  const draft = {
    // Tie the draft to the exact server copy it was typed against (mirrors the
    // _deliveryCompletionOpen conflict baseline) so a concurrent admin edit
    // invalidates it instead of silently resurfacing stale numbers.
    lastMod: (_deliveryCompletionOpen && _deliveryCompletionOpen.id === rid) ? (_deliveryCompletionOpen.lastMod || 0) : 0,
    savedAt: Date.now(),
    finalNo: String(document.getElementById('delivery-final-receipt-no')?.value || ''),
    collected,
    feeMethod: document.getElementById('delivery-fee-method')?.value || '',
    feeAmount: String(document.getElementById('delivery-fee-amount')?.value || ''),
    feePaidBy: _readDeliveryFeePaidBy(),
    notes: String(document.getElementById('delivery-driver-notes')?.value || ''),
    photo: String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '')
  };
  const key = _deliveryDraftKey(rid);
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch (_) {
    // Quota exceeded (compressed data URLs can be 300KB+): retry once without
    // the photo so at least every typed field survives the round-trip.
    try {
      draft.photo = '';
      localStorage.setItem(key, JSON.stringify(draft));
    } catch (_) {}
  }
}

function _readDeliveryCompletionDraft(receipt) {
  try {
    const raw = localStorage.getItem(_deliveryDraftKey(String(receipt?.id || '')));
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    if ((Number(draft.lastMod) || 0) !== (receipt?._lastModified || 0)) return null;
    const savedAt = Number(draft.savedAt) || 0;
    if (!savedAt || (Date.now() - savedAt) > _DELIVERY_DRAFT_MAX_AGE_MS) return null;
    return draft;
  } catch (_) {
    return null;
  }
}

function _clearDeliveryCompletionDraft(receiptId) {
  try { localStorage.removeItem(_deliveryDraftKey(String(receiptId || ''))); } catch (_) {}
}

// Abandoned drafts (delivery completed on another device, receipt reassigned…)
// must not pile up in localStorage forever — sweep anything past the 24h gate.
function _pruneDeliveryCompletionDrafts() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(_DELIVERY_DRAFT_PREFIX) !== 0) continue;
      let stale = true;
      try {
        const draft = JSON.parse(localStorage.getItem(key) || '');
        const savedAt = Number(draft?.savedAt) || 0;
        stale = !savedAt || (Date.now() - savedAt) > _DELIVERY_DRAFT_MAX_AGE_MS;
      } catch (_) {}
      if (stale) doomed.push(key);
    }
    doomed.forEach(key => localStorage.removeItem(key));
  } catch (_) {}
}

function updateReceiptDeliveryCompletionComputed() {
  const modal = document.getElementById('delivery-complete-modal');
  if (!modal) return;
  const rid = modal.dataset.receiptId || '';
  const receipt = _findReceiptForDeliveryModal(rid);
  if (!receipt) return;

  const debt = getReceiptCollectionTarget(receipt).amountLocal;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;

  // Normalize Arabic-Indic digits at the READ site too (not only oninput) so
  // pastes/autofill that bypass the input handler still validate as ASCII.
  const finalNo = normalizeDigitsAscii(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  // Collected money is split-payment rows (same math as a receipt): R1 = LYD total.
  // The fee is a plain LYD amount — no rates, never part of the USD math.
  const collectedTotals = getPaymentTotalsFromDom(document.getElementById('delivery-collected-payments'));
  const collected = collectedTotals.totalR1;   // LYD — compared against the debt
  const actualFee = _readDeliveryFeeLyd();     // LYD — compared against the quoted fee
  const totalEl = document.getElementById('delivery-collected-total');
  if (totalEl) totalEl.textContent = `${collected.toFixed(0)} LYD` + (collectedTotals.totalR2 ? ` ($${collectedTotals.totalR2.toFixed(2)})` : '');
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();

  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Compute comparisons
  const feeCmp = compareFees(quoted, actualFee);
  const debtCmp = compareDebt(debt, collected);

  const isArC = state.language === 'ar';
  const feeEl = document.getElementById('delivery-fee-compare');
  const debtEl = document.getElementById('delivery-debt-compare');
  if (feeEl) {
    const diff = feeCmp.feeDiff;
    const feeBase = feeCmp.feeDifferenceStatus === 'SAME'
      ? (isArC ? 'قيمة التوصيل: مطابقة' : 'Fee: SAME')
      : (feeCmp.feeDifferenceStatus === 'LOWER'
        ? (isArC ? `قيمة التوصيل: أقل (${Math.abs(diff).toFixed(0)} LYD)` : `Fee: LOWER (${Math.abs(diff).toFixed(0)} LYD)`)
        : (isArC ? `قيمة التوصيل: أعلى (${diff.toFixed(0)} LYD)` : `Fee: HIGHER (${diff.toFixed(0)} LYD)`));
    const feePaidByShop = _readDeliveryFeePaidBy() === 'shop';
    feeEl.textContent = feeBase + (feePaidByShop ? (isArC ? ' • يتحملها المحل' : ' • paid by shop') : '');
  }
  if (debtEl) {
    if (debtCmp.paymentResult === 'PAID_EXACT') debtEl.textContent = isArC ? 'الدفع: مطابق تماماً' : 'Payment: PAID EXACT';
    if (debtCmp.paymentResult === 'OVERPAID') debtEl.textContent = isArC ? `الدفع: زائد (+${debtCmp.overpaidAmount.toFixed(0)} LYD)` : `Payment: OVERPAID (+${debtCmp.overpaidAmount.toFixed(0)} LYD)`;
    if (debtCmp.paymentResult === 'UNDERPAID') debtEl.textContent = isArC ? `الدفع: ناقص (المتبقي ${debtCmp.remainingDue.toFixed(0)} LYD)` : `Payment: UNDERPAID (${debtCmp.remainingDue.toFixed(0)} LYD remaining)`;
  }

  // Validate (allow app-generated auto-serials: S/B/O/E + digits)
  const errEl = document.getElementById('delivery-final-receipt-error');
  const isAutoSerialValidation = isAutoSerialNumber(finalNo);
  let ok = true;
  if (!finalNo) {
    ok = false;
    if (errEl) errEl.textContent = isArC ? 'رقم الوصل النهائي مطلوب.' : 'Final receipt number is required.';
  } else if (!isAutoSerialValidation && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0'))) {
    ok = false;
    if (errEl) errEl.textContent = isArC ? 'رقم الوصل النهائي يجب أن يكون أرقاماً (بدون صفر في البداية) أو رقماً تلقائياً (S1, B1, O1, E1).' : 'Final receipt number must be digits (no leading 0) or an auto-serial (S1, B1, O1, E1).';
  } else if (_receiptFinalNoExists(finalNo, receipt.id)) {
    ok = false;
    if (errEl) errEl.textContent = isArC ? 'رقم الوصل النهائي موجود بالفعل.' : 'Final receipt number already exists.';
  } else {
    if (errEl) errEl.textContent = '';
  }

  if (!Number.isFinite(collected) || collected < 0) ok = false;
  if (!Number.isFinite(actualFee) || actualFee < 0) ok = false;
  if (!imgData) ok = false;

  const btn = document.getElementById('delivery-complete-submit');
  if (btn) btn.disabled = !ok;

  // Keep notes (no-op, but avoids unused var warnings in some linters)
  void notes;

  // Every input/change handler in the modal funnels through this function, so
  // it is the single (debounced) write point for the crash-recovery draft.
  if (_deliveryDraftSaveTimer) clearTimeout(_deliveryDraftSaveTimer);
  _deliveryDraftSaveTimer = setTimeout(() => {
    _deliveryDraftSaveTimer = null;
    _saveDeliveryCompletionDraftNow();
  }, 500);
}

// Snapshot of {id, lastMod} captured when the delivery-completion modal opens,
// used as the conflict baseline on submit (the receipt object is re-resolved
// fresh at save time so its live _lastModified can't be trusted).
let _deliveryCompletionOpen = null;

// ---- Delivery completion: split-payment rows (same mechanism as a receipt) --------
// The driver records what they collected (and the delivery fee) using the exact same
// method/amount/Rate1/Rate2 rows as a receipt. Rows carry the .payment-split-item /
// .payment-method / .payment-amount / .payment-rate1 / .payment-rate2 classes so the
// receipt's own getPaymentTotalsFromDom(root) computes LYD (R1) and USD (R2) totals —
// one call scoped to the collected container, one to the fee container.
const _DELIVERY_USD_METHODS = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];

// Rate 1 turns the entered amount into LYD (R1 = amount x rate1), and the debt
// comparison is done in LYD. getDefaultRate1 returns 0 for methods where a RECEIPT
// expects a hand-entered negotiated rate — but a delivery is plain cash collection, so a
// 0 default would silently record 0 LYD collected. Give a correct LYD conversion instead:
// USD-denominated methods convert at the exchange rate, LYD-denominated ones are 1:1.
function _deliveryDefaultRate1(method) {
  const r = getDefaultRate1(method);
  if (r > 0) return r;
  return _DELIVERY_USD_METHODS.includes(method) ? (Number(state.defaultExchangeRate) || 1) : 1;
}

function _deliveryPaymentRowHtml(payment, opts = {}) {
  const isAr = state.language === 'ar';
  const p = payment || {};
  const method = p.method || PAYMENT_METHODS[0];
  const amount = (p.amount === undefined || p.amount === null) ? '' : p.amount;
  const rate1 = (p.rate1 === undefined || p.rate1 === null || p.rate1 === '') ? _deliveryDefaultRate1(method) : p.rate1;
  // Rate 2 turns the amount into USD. Always seed it with the exchange rate (never 0) so
  // the USD value is computed for every method — a delivery always has a USD equivalent.
  const rate2 = (p.rate2 === undefined || p.rate2 === null || p.rate2 === '')
    ? (Number(state.defaultExchangeRate) || 0)
    : p.rate2;
  return `
    <div class="payment-split-item p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
      <div class="grid grid-cols-2 gap-2">
        <select class="payment-method w-full glass-input px-2 py-1.5 rounded text-xs font-medium" onchange="onDeliveryPaymentMethodChange(this)">
          ${paymentMethodOptions(method).map(m => `<option value="${Security.escapeHtml(m)}" ${m === method ? 'selected' : ''}>${Security.escapeHtml(trMethod(m))}</option>`).join('')}
        </select>
        <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-2 py-1.5 rounded text-xs font-bold" value="${Security.escapeHtml(String(amount))}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
      </div>
      <div class="grid grid-cols-2 gap-2 mt-2">
        <div>
          <div class="text-[9px] font-bold text-slate-400 uppercase mb-0.5">${isAr ? 'السعر 1' : 'Rate 1'}</div>
          <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1 rounded text-xs text-center" value="${Security.escapeHtml(String(rate1))}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptDeliveryCompletionComputed()" />
        </div>
        <div>
          <div class="text-[9px] font-bold text-slate-400 uppercase mb-0.5">${isAr ? 'السعر 2' : 'Rate 2'}</div>
          <input type="text" inputmode="decimal" class="payment-rate2 w-full glass-input px-2 py-1 rounded text-xs text-center" value="${Security.escapeHtml(String(rate2))}" placeholder="0" oninput="sanitizeMoneyInput(this, 4); updateReceiptDeliveryCompletionComputed()" />
        </div>
      </div>
      ${opts.removable ? `<button type="button" onclick="removeDeliveryPaymentRow(this)" class="mt-2 text-[11px] font-bold text-rose-600 dark:text-rose-400">${isAr ? '× حذف' : '× Remove'}</button>` : ''}
    </div>`;
}

// Mirror the receipt's onPaymentMethodChange (auto-fill the rates for the method), but
// without the receipt-serial resync, and recompute the delivery totals instead.
function onDeliveryPaymentMethodChange(sel) {
  const item = sel.closest('.payment-split-item');
  if (!item) return;
  const method = sel.value;
  const r1 = item.querySelector('.payment-rate1');
  const r2 = item.querySelector('.payment-rate2');
  // Never leave a rate at 0 — that would record 0 LYD / 0 USD for the collection.
  if (r1) r1.value = _deliveryDefaultRate1(method).toFixed(2);
  if (r2 && (parseFloat(r2.value) === 0 || !r2.value)) r2.value = (Number(state.defaultExchangeRate) || 0).toFixed(2);
  updateReceiptDeliveryCompletionComputed();
}

function addDeliveryCollectedRow() {
  const c = document.getElementById('delivery-collected-payments');
  if (!c) return;
  c.insertAdjacentHTML('beforeend', _deliveryPaymentRowHtml({ method: PAYMENT_METHODS[0] }, { removable: true }));
  if (window.lucide) lucide.createIcons();
  updateReceiptDeliveryCompletionComputed();
}

function removeDeliveryPaymentRow(btn) {
  const c = document.getElementById('delivery-collected-payments');
  const item = btn.closest('.payment-split-item');
  if (c && item && c.querySelectorAll('.payment-split-item').length > 1) {
    item.remove();
    updateReceiptDeliveryCompletionComputed();
  }
}

// Read the collected rows into a payments[] array (same shape a receipt stores).
function _readDeliveryPaymentRows(containerId) {
  const c = document.getElementById(containerId);
  if (!c) return [];
  return Array.from(c.querySelectorAll('.payment-split-item')).map(item => ({
    method: item.querySelector('.payment-method')?.value || PAYMENT_METHODS[0],
    amount: parseFloat(item.querySelector('.payment-amount')?.value) || 0,
    rate: parseFloat(item.querySelector('.payment-rate1')?.value) || 0,
    rate2: parseFloat(item.querySelector('.payment-rate2')?.value) || 0,
    collectionType: 'delivery'
  })).filter(p => p.amount > 0);
}

// ---- Delivery fee: plain LYD cash (no Rate 1 / Rate 2) ---------------------------
// The delivery fee is flat LYD cash handed to the driver. It must NEVER become
// USD ads credit, so the fee input is a simple LYD amount + method + who paid
// it (customer vs shop) instead of a full split-payment row with rates. The
// stored shape stays deliveryFeePayments[{method, amount, rate, rate2}] so every
// existing reader keeps working: the simplified row writes rate 1 (amount is
// already LYD) and rate2 0 (a fee has no USD value).
function _deliveryFeeStoredLyd(receipt) {
  const rows = Array.isArray(receipt?.deliveryFeePayments) ? receipt.deliveryFeePayments : [];
  if (rows.length) {
    // Backward-read: rows saved by the old rate-based UI hold LYD = amount x rate.
    return rows.reduce((sum, p) => {
      const amount = Number(p?.amount) || 0;
      const rate = Number(p?.rate);
      return sum + amount * (Number.isFinite(rate) && rate > 0 ? rate : 1);
    }, 0);
  }
  const stored = receipt?.actualDeliveryFeeCollected ?? receipt?.deliveryFeeCollected;
  return (stored === undefined || stored === null || stored === '') ? null : (Number(stored) || 0);
}

// Empty input reads as 0 (same as the old getPaymentTotalsFromDom behaviour).
function _readDeliveryFeeLyd() {
  const el = document.getElementById('delivery-fee-amount');
  if (!el) return 0;
  return parseFloat(el.value) || 0;
}

// Who paid the delivery fee: 'customer' (default — today's implicit behaviour)
// or 'shop' (owner covered it: free delivery / paid from shop cash = a loss).
function _readDeliveryFeePaidBy() {
  const checked = document.querySelector('input[name="delivery-fee-paid-by"]:checked');
  return (checked && checked.value === 'shop') ? 'shop' : 'customer';
}

async function openReceiptDeliveryCompletionModal(receiptId) {
  const isArD = state.language === 'ar';
  let receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification(isArD ? 'خطأ' : 'Error', isArD ? 'الوصل غير موجود' : 'Receipt not found', 'error');
    return;
  }
  // Admins may record a completion themselves; the server holds them to the
  // same proof rules as the assigned driver (final number, photo, amounts).
  const isAdminCompletion = isCurrentUserAdmin();
  if (!isAdminCompletion && String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification(isArD ? 'تم رفض الوصول' : 'Access Denied', isArD ? 'لمستخدمي التوصيل أو المدير فقط' : 'Delivery users or admins only', 'error');
    return;
  }
  if (!isAdminCompletion && String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification(isArD ? 'تم رفض الوصول' : 'Access Denied', isArD ? 'هذا الوصل غير معيَّن لك' : 'This receipt is not assigned to you', 'error');
    return;
  }

  // A lightweight sync record carries only the photo count. Hydrate before a
  // driver completes delivery so prepending the new proof cannot overwrite
  // older attachments that were intentionally omitted from the list payload.
  if (getReceiptPhotoCount(receipt) > 0 && !isEntityMediaHydrated('receipts', receipt)) {
    try {
      receipt = await ensureEntityMediaLoaded('receipts', receiptId);
    } catch (_) {
      showNotification(
        isArD ? 'تعذر تحميل الصور' : 'Photos unavailable',
        isArD ? 'تعذر تحميل صور الوصل. تحقق من الاتصال ثم حاول مرة أخرى.' : 'Could not load the existing receipt photos. Check the connection and try again.',
        'error'
      );
      return;
    }
    if (!receipt || (!isAdminCompletion && String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || ''))) return;
  }

  // Freeze the receipt's _lastModified at modal-open time. submitReceipt-
  // DeliveryCompletion re-resolves the receipt fresh at save, and live-sync
  // replaces the array slot, so without this snapshot a concurrent admin edit
  // would be silently clobbered instead of producing a 409 + reload.
  _deliveryCompletionOpen = { id: String(receipt.id), lastMod: receipt._lastModified || 0 };

  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(receipt.customerId));
  const phone = String(receipt.phoneNumber || customer?.phones?.[0] || '').trim();
  const debt = getReceiptCollectionTarget(receipt).amountLocal;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const tempNo = String(receipt.tempReceiptNo || '').trim();
  let finalNo = String(receipt.finalReceiptNo || receipt.serialNumber || '').trim();
  const place = String(receipt.deliveryPlaceName || '').trim();
  let deliveryReceiptPhoto = getDeliveryReceiptPhotoSource(receipt);

  // Initial rows. Re-completing an already-delivered receipt reloads its stored payment
  // rows; a fresh completion seeds one Cash (LYD) row for the collected amount (empty, so
  // the driver types what they actually collected) and one for the fee (pre-filled with
  // the quoted fee). Cash (LYD) => Rate1 1, Rate2 the default exchange rate.
  const _dRate = Number(state.defaultExchangeRate) || 0;
  const _cashLyd = PAYMENT_METHODS.includes('Cash (LYD)') ? 'Cash (LYD)' : PAYMENT_METHODS[0];
  let _storedCollected = Array.isArray(receipt.payments) && receipt.payments.length
    ? receipt.payments.map(p => ({ method: p.method, amount: p.amount, rate1: p.rate, rate2: p.rate2 }))
    : [{ method: _cashLyd, amount: (receipt.amountCollectedFromCustomer ?? ''), rate1: 1, rate2: _dRate }];
  // Fee prefill: stored rows first (old rate-based rows normalize to LYD via
  // _deliveryFeeStoredLyd), then the stored fee amount, then the quoted fee.
  const _storedFeeLyd = _deliveryFeeStoredLyd(receipt);
  let feeAmountValue = (_storedFeeLyd === null) ? (quoted || '') : _storedFeeLyd;
  let feeMethod = (Array.isArray(receipt.deliveryFeePayments) && receipt.deliveryFeePayments[0]?.method) || _cashLyd;
  let feePaidBy = receipt.deliveryFeePaidBy === 'shop' ? 'shop' : 'customer';
  let notesSeed = String(receipt.driverNotes || '');

  // Rehydrate a crash-recovery draft (Android camera round-trips can kill the
  // tab — see _saveDeliveryCompletionDraftNow). Only a draft written against
  // this exact server copy (same _lastModified) and younger than 24h is used;
  // the draft's photo is re-validated before it can reach the DOM.
  _pruneDeliveryCompletionDrafts();
  const _draft = _readDeliveryCompletionDraft(receipt);
  if (_draft) {
    if (typeof _draft.finalNo === 'string') finalNo = _draft.finalNo.trim();
    if (Array.isArray(_draft.collected) && _draft.collected.length) {
      _storedCollected = _draft.collected.map(p => ({
        method: (p && typeof p.method === 'string' && p.method) ? p.method : _cashLyd,
        amount: (p && p.amount !== undefined && p.amount !== null) ? p.amount : '',
        rate1: (p && p.rate1 !== undefined && p.rate1 !== null) ? p.rate1 : '',
        rate2: (p && p.rate2 !== undefined && p.rate2 !== null) ? p.rate2 : ''
      }));
    }
    if (typeof _draft.feeMethod === 'string' && _draft.feeMethod) feeMethod = _draft.feeMethod;
    if (typeof _draft.feeAmount === 'string' || typeof _draft.feeAmount === 'number') feeAmountValue = _draft.feeAmount;
    if (_draft.feePaidBy === 'shop' || _draft.feePaidBy === 'customer') feePaidBy = _draft.feePaidBy;
    if (typeof _draft.notes === 'string') notesSeed = _draft.notes;
    const _draftPhoto = String(_draft.photo || '').trim();
    if (_draftPhoto && isSafeReceiptPhotoSource(_draftPhoto)) deliveryReceiptPhoto = _draftPhoto;
  }
  const collectedRowsHtml = _storedCollected
    .map((p, i) => _deliveryPaymentRowHtml(p, { removable: i > 0 })).join('');

  // Remove any existing modal
  document.getElementById('delivery-complete-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'delivery-complete-modal';
  modal.dataset.receiptId = String(receipt.id);
  modal.className = 'mobile-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  // NO backdrop-dismiss here. On phones the overlay is the scroll surface, and
  // the habitual "tap outside the input to dismiss the keyboard" gesture lands
  // on the backdrop — one stray tap must never destroy a mid-delivery form
  // (typed data + proof photo). Close paths: the header X and Android Back.

  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <i data-lucide="check-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">${isArD ? 'تم التوصيل' : 'Mark Delivered'}</div>
            <div class="text-xs text-slate-500">${Security.escapeHtml(customer?.name || (isArD ? 'غير معروف' : 'Unknown'))}</div>
          </div>
        </div>
        <button onclick="_flushDeliveryCompletionDraftNow(); this.closest('#delivery-complete-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-500 mb-1">${isArD ? 'الوصل' : 'Receipt'}</div>
          <div class="font-bold text-indigo-600">${Security.escapeHtml(tempNo || 'D?')}${finalNo ? ` → ${Security.escapeHtml(finalNo)}` : ''}</div>
          ${place ? `<div class="text-xs text-slate-600 dark:text-slate-300 mt-1"><span class="font-bold">📍</span> ${Security.escapeHtml(place)}</div>` : ''}
          <div class="text-xs text-slate-500 mt-1">${isArD ? 'الدين المستحق' : 'Debt due'}: <span id="delivery-complete-debt" class="font-bold text-slate-800 dark:text-slate-200">${debt.toFixed(0)} LYD</span> • ${isArD ? 'قيمة التوصيل المتفق عليها' : 'Quoted fee'}: <span id="delivery-complete-quoted" class="font-bold text-emerald-600 dark:text-emerald-400">${quoted.toFixed(0)} LYD</span></div>
          ${phone ? `<div class="text-xs text-slate-500 mt-1">${isArD ? 'الهاتف' : 'Phone'}: <span class="font-bold text-slate-700 dark:text-slate-300">${Security.escapeHtml(phone)}</span></div>` : ''}
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">${isArD ? 'رقم الوصل النهائي *' : 'Final receipt number *'}</label>
          <input id="delivery-final-receipt-no" type="text" inputmode="numeric" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="${isArD ? 'مثال: 45873' : 'e.g., 45873'}" value="${Security.escapeHtml(finalNo)}" oninput="this.value=normalizeDigitsAscii(this.value).replace(/[^0-9]/g,''); updateReceiptDeliveryCompletionComputed()" />
          <div id="delivery-final-receipt-error" class="mt-1 text-[11px] text-rose-600 dark:text-rose-400"></div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs font-bold text-slate-600 dark:text-slate-400">${isArD ? 'المبلغ المُحصَّل *' : 'Amount collected *'}</label>
            <button type="button" onclick="addDeliveryCollectedRow()" class="text-[11px] font-bold text-indigo-600 hover:text-indigo-700">${isArD ? '+ طريقة أخرى' : '+ Add method'}</button>
          </div>
          <div id="delivery-collected-payments" class="space-y-2">${collectedRowsHtml}</div>
          <div class="text-[11px] text-slate-500 mt-1">${isArD ? 'إجمالي المُحصَّل' : 'Total collected'}: <span id="delivery-collected-total" class="font-bold text-slate-700 dark:text-slate-200">0 LYD</span></div>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">${isArD ? 'قيمة التوصيل المُحصَّلة (LYD) *' : 'Delivery fee collected (LYD) *'}</label>
          <div id="delivery-fee-payment" class="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
            <div class="grid grid-cols-2 gap-2">
              <select id="delivery-fee-method" class="w-full glass-input px-2 py-1.5 rounded text-xs font-medium">
                ${paymentMethodOptions(feeMethod).map(m => `<option value="${Security.escapeHtml(m)}" ${m === feeMethod ? 'selected' : ''}>${Security.escapeHtml(trMethod(m))}</option>`).join('')}
              </select>
              <input id="delivery-fee-amount" type="text" inputmode="decimal" class="w-full glass-input px-2 py-1.5 rounded text-xs font-bold" value="${Security.escapeHtml(String(feeAmountValue))}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
            </div>
            <div class="mt-2">
              <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">${isArD ? 'من دفع قيمة التوصيل؟' : 'Delivery paid by'}</div>
              <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="${isArD ? 'من دفع قيمة التوصيل' : 'Delivery paid by'}">
                <label class="flex items-center gap-1.5 min-h-11 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input type="radio" name="delivery-fee-paid-by" value="customer" ${feePaidBy === 'shop' ? '' : 'checked'} onchange="updateReceiptDeliveryCompletionComputed()" />
                  <span>${isArD ? 'دفعها العميل' : 'Customer paid'}</span>
                </label>
                <label class="flex items-center gap-1.5 min-h-11 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-bold text-rose-600 cursor-pointer">
                  <input type="radio" name="delivery-fee-paid-by" value="shop" ${feePaidBy === 'shop' ? 'checked' : ''} onchange="updateReceiptDeliveryCompletionComputed()" />
                  <span>${isArD ? 'يتحملها المحل (خسارة)' : 'Shop paid (loss)'}</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div data-photo-paste-target="delivery" tabindex="0" class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div class="text-xs font-bold text-slate-600 dark:text-slate-400">${isArD ? 'صورة الوصل *' : 'Receipt photo *'}</div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" onclick="takeNativePhoto('delivery')" class="min-h-11 px-3 rounded-lg border border-indigo-200 dark:border-indigo-800 text-xs font-bold text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 flex items-center gap-1.5">
                <i data-lucide="camera" class="w-3.5 h-3.5"></i>${isArD ? 'الكاميرا' : 'Camera'}
              </button>
              <button type="button" onclick="pastePhotoFromClipboard('delivery')" class="min-h-11 px-3 rounded-lg border border-indigo-200 dark:border-indigo-800 text-xs font-bold text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 flex items-center gap-1.5">
                <i data-lucide="clipboard-paste" class="w-3.5 h-3.5"></i>${isArD ? 'لصق صورة' : 'Paste photo'}
              </button>
              <label class="min-h-11 px-3 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 cursor-pointer flex items-center gap-1.5">
                <i data-lucide="upload" class="w-3.5 h-3.5"></i>${isArD ? 'رفع' : 'Upload'}
                <input type="file" accept="image/*" class="hidden" onchange="handleDeliveryReceiptPhotoUpload(this.files); this.value=''" />
              </label>
            </div>
          </div>
          <input type="hidden" id="delivery-receipt-image-data" data-image-data="${Security.escapeHtml(deliveryReceiptPhoto)}" />
          <button id="delivery-receipt-image-button" type="button" onclick="openDeliveryReceiptPhotoViewer()" class="${deliveryReceiptPhoto ? '' : 'hidden'} group relative w-full rounded-lg overflow-hidden" title="${isArD ? 'اضغط لعرض الصورة بالحجم الكامل' : 'Click to view full size'}">
            <img id="delivery-receipt-image-preview" src="${Security.escapeHtml(deliveryReceiptPhoto)}" alt="${isArD ? 'صورة وصل التوصيل' : 'Delivery receipt photo'}" class="w-full h-36 object-cover border border-slate-200 dark:border-slate-700 rounded-lg" />
            <span class="absolute inset-0 bg-black/0 group-hover:bg-black/25 group-focus:bg-black/25 transition-colors flex items-center justify-center">
              <span class="opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity px-3 py-1.5 rounded-full bg-black/65 text-white text-xs font-bold flex items-center gap-1.5"><i data-lucide="maximize-2" class="w-4 h-4"></i>${isArD ? 'عرض' : 'View'}</span>
            </span>
          </button>
          <div id="delivery-receipt-image-empty" class="${deliveryReceiptPhoto ? 'hidden' : ''} text-xs text-slate-400">${isArD ? 'لا توجد صورة بعد.' : 'No photo yet.'}</div>
          <p class="mt-2 text-[11px] text-slate-500">${isArD ? 'يمكنك أيضاً نسخ صورة والضغط على Ctrl+V داخل النافذة.' : 'You can also copy an image and press Ctrl+V in this window.'}</p>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">${isArD ? 'ملاحظات السائق (اختياري)' : 'Driver notes (optional)'}</label>
          <textarea id="delivery-driver-notes" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="${isArD ? 'ملاحظات...' : 'Notes...'}" oninput="updateReceiptDeliveryCompletionComputed()">${Security.escapeHtml(notesSeed)}</textarea>
        </div>

        <div class="grid grid-cols-2 gap-3 text-xs">
          <div id="delivery-debt-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
          <div id="delivery-fee-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
        </div>

        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          ${isAdminCompletion ? '' : `
          <button type="button" onclick="openReceiptDeliveryCancelModal('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            <i data-lucide="x-circle" class="w-4 h-4 inline mr-1"></i>${isArD ? 'إلغاء التوصيل' : 'Cancel Delivery'}
          </button>`}
          <button type="button" id="delivery-complete-submit" onclick="submitReceiptDeliveryCompletion('${receipt.id}')" class="flex-1 btn-shine bg-emerald-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed">
            <i data-lucide="check" class="w-4 h-4 inline mr-1"></i>${isArD ? 'تم التوصيل' : 'Mark Delivered'}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  // If we have an existing image, show it
  const img = document.getElementById('delivery-receipt-image-preview');
  if (img && img.getAttribute('src')) img.classList.remove('hidden');
  updateReceiptDeliveryCompletionComputed();
}

// Delivery completion must keep the receipt and every linked ad visually
// consistent in the same user action. The strict delivery PATCH endpoint
// performs the server transaction but returns only the receipt, so refresh ads
// before rendering success. If that read is temporarily unavailable, apply the
// same exact local reclassification plan as offline mode; the next live sync
// will still verify it against the server.
async function refreshAdsAfterReceiptServerCascade(receipt, { allowPaidLocalFallback = false } = {}) {
  try {
    if (typeof apiLoadCollectionAll !== 'function') throw new Error('Ads refresh is unavailable');
    const refreshedAds = await apiLoadCollectionAll('ads', { forceRefresh: true });
    if (!Array.isArray(refreshedAds)) throw new Error('Ads refresh returned an invalid response');
    state.ads = refreshedAds;
    markCollectionDirty('ads');
    return { consistent: true, source: 'server', updated: refreshedAds.length };
  } catch (refreshError) {
    const paid = typeof getReceiptPaymentState === 'function'
      ? getReceiptPaymentState(receipt) === 'paid'
      : (receipt?.isPaid === true || String(receipt?.status || '') === 'Paid');
    if (!allowPaidLocalFallback || !paid) {
      console.warn('[receiptCascade] Linked ads could not be refreshed after the receipt mutation:', refreshError?.message || refreshError);
      return { consistent: false, source: 'pending-sync', updated: 0 };
    }
    try {
      const plans = planLocalReceiptPaidAdUpdates(String(receipt?.id || ''), receipt);
      const updated = applyLocalReceiptPaidAdUpdates(plans);
      if (ALBAYAN_DEBUG_MODE) {
        console.warn('[deliveryCompletion] Authoritative ads refresh failed; applied exact local settlement fallback:', refreshError?.message || refreshError);
      }
      return { consistent: true, source: 'local-fallback', updated };
    } catch (fallbackError) {
      console.warn('[deliveryCompletion] Linked ads could not be refreshed after receipt settlement:', fallbackError?.message || fallbackError);
      return { consistent: false, source: 'pending-sync', updated: 0 };
    }
  }
}

async function refreshAdsAfterReceiptPaidCascade(receipt) {
  const paid = typeof getReceiptPaymentState === 'function'
    ? getReceiptPaymentState(receipt) === 'paid'
    : (receipt?.isPaid === true || String(receipt?.status || '') === 'Paid');
  if (!paid) return { consistent: true, source: 'not-paid', updated: 0 };
  return refreshAdsAfterReceiptServerCascade(receipt, { allowPaidLocalFallback: true });
}

// Map raw engine failures ('Load failed' on Safari, 'Failed to fetch' on
// Chromium, AbortError timeouts) to a bilingual, actionable message. Returns
// null when the server WAS reached (e.status set) or the error does not look
// like a connectivity failure — callers then keep their real HTTP detail.
// Callers should log the raw e.message to the console for diagnostics.
function describeNetworkError(e) {
  if (e?.status) return null; // server WAS reached — keep the real HTTP detail
  const name = String(e?.name || '');
  const msg = String(e?.message || '');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const looksNetwork = offline
    || name === 'AbortError'
    || (name === 'TypeError' && /failed to fetch|load failed|network|cancelled/i.test(msg));
  if (!looksNetwork) return null;
  if (offline) {
    return state.language === 'ar'
      ? 'لا يوجد اتصال بالإنترنت — لم يتم الحفظ ولم يُفقد ما أدخلته. أعد الاتصال ثم حاول مرة أخرى.'
      : 'You are offline — nothing was saved and nothing you entered was lost. Reconnect and try again.';
  }
  return state.language === 'ar'
    ? 'تعذر الوصول إلى الخادم — لم يتم الحفظ ولم يُفقد ما أدخلته. تحقق من الإشارة ثم أعد المحاولة.'
    : 'Could not reach the server — nothing was saved and nothing you entered was lost. Check your signal and try again.';
}

async function submitReceiptDeliveryCompletion(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'الوصل غير موجود' : 'Receipt not found', 'error');
    return;
  }

  // Normalize Arabic-Indic digits at the save-time read too so the /^\d+$/
  // validation below and the stored value are always ASCII-consistent.
  const finalNo = normalizeDigitsAscii(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  // Collected money is split-payment rows (same math as a receipt): R1 = LYD, R2 = USD.
  // The fee is a plain LYD amount + method + payer. Only the COLLECTED rows feed
  // the USD (ads credit) math — the fee never converts to USD.
  const collectedTotals = getPaymentTotalsFromDom(document.getElementById('delivery-collected-payments'));
  const collected = collectedTotals.totalR1;                 // LYD collected (vs debt)
  const collectedUSDFromRows = collectedTotals.totalR2;      // USD value of what was collected
  const actualFee = _readDeliveryFeeLyd();                    // LYD fee (vs quoted)
  const collectedPayments = _readDeliveryPaymentRows('delivery-collected-payments');
  const feeMethod = document.getElementById('delivery-fee-method')?.value || 'Cash (LYD)';
  const feePaidBy = _readDeliveryFeePaidBy();
  // Legacy row shape (rate 1 => amount is already LYD, rate2 0 => no USD value)
  // so every existing reader of deliveryFeePayments keeps working unchanged.
  const feePayments = actualFee > 0
    ? [{ method: feeMethod, amount: actualFee, rate: 1, rate2: 0, collectionType: 'delivery' }]
    : [];
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();
  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Drivers are the most likely Arabic-only users — keep every message bilingual.
  const isArDrv = state.language === 'ar';
  const drvValidationTitle = isArDrv ? 'خطأ في الإدخال' : 'Validation';

  // Allow app-generated auto-serial numbers (S1 / B1 / O1 / E1)
  const isAutoSerialFinal = isAutoSerialNumber(finalNo);
  if (!finalNo || (!isAutoSerialFinal && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0')))) {
    showNotification(drvValidationTitle, isArDrv
      ? 'رقم الوصل النهائي مطلوب (أرقام فقط، بدون صفر في البداية، أو رقم تلقائي مثل S1 / B1 / O1 / E1).'
      : 'Final receipt number is required (digits only, no leading 0, or an auto-serial like S1 / B1 / O1 / E1).', 'error');
    return;
  }
  if (_receiptFinalNoExists(finalNo, receipt.id)) {
    showNotification(drvValidationTitle, isArDrv ? 'رقم الوصل النهائي موجود بالفعل.' : 'Final receipt number already exists.', 'error');
    return;
  }
  if (!imgData) {
    showNotification(drvValidationTitle, isArDrv ? 'صورة الوصل مطلوبة.' : 'Receipt photo is required.', 'error');
    return;
  }
  if (!Number.isFinite(collected) || collected < 0) {
    showNotification(drvValidationTitle, isArDrv ? 'المبلغ المُحصَّل مطلوب.' : 'Amount collected is required.', 'error');
    return;
  }
  if (!Number.isFinite(actualFee) || actualFee < 0) {
    showNotification(drvValidationTitle, isArDrv ? 'قيمة التوصيل الفعلية مطلوبة.' : 'Actual delivery fee is required.', 'error');
    return;
  }

  const collectionTarget = getReceiptCollectionTarget(receipt);
  const debtLocal = collectionTarget.amountLocal;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const debtCmp = compareDebt(debtLocal, collected);
  const feeCmp = compareFees(quoted, actualFee);

  const rate = Number(receipt.exchangeRate || state.defaultExchangeRate || 1) || 1;
  // USD value comes from the payment rows (each method's Rate2). Fall back to the
  // single-rate conversion only if the rows produced no USD (e.g. all rates left blank).
  const collectedUSD = collectedUSDFromRows > 0
    ? collectedUSDFromRows
    : (rate > 0 ? (collected / rate) : 0);

  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({
    ts: new Date().toISOString(),
    userId: state.currentUser?.id || '',
    action: 'DELIVERED',
    tempReceiptNo: receipt.tempReceiptNo || '',
    finalReceiptNo: finalNo,
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee,
    deliveryFeePaidBy: feePaidBy
  });

  const newStatus = (debtCmp.paymentResult === 'UNDERPAID') ? 'Not Paid' : 'Paid';
  const newIsPaid = debtCmp.paymentResult !== 'UNDERPAID';

  const updates = {
    deliveryStatus: 'Delivered',
    deliveredAt: new Date().toISOString(),
    finalReceiptNo: finalNo,
    serialNumber: finalNo,
    receiptImage: imgData,
    photos: [imgData, ...(Array.isArray(receipt.photos) ? receipt.photos.filter(Boolean) : [])].slice(0, 6),
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee,
    deliveryFeeCollected: actualFee,
    // Who paid the fee: 'customer' (default) or 'shop' (owner covered it — a
    // trackable loss). Old records without this field read as 'customer'.
    deliveryFeePaidBy: feePaidBy,
    driverNotes: notes,
    debtAmountLocal: receipt.debtAmountLocal ?? debtLocal,
    debtAmountUSD: receipt.debtAmountUSD ?? collectionTarget.amountUSD,
    paymentResult: debtCmp.paymentResult,
    overpaidAmount: debtCmp.overpaidAmount,
    remainingDue: debtCmp.remainingDue,
    feeDifferenceStatus: feeCmp.feeDifferenceStatus,
    feeDiff: feeCmp.feeDiff,
    ownerCoveredExtraFee: receipt.ownerCoveredExtraFee ?? 0,
    status: newStatus,
    isPaid: newIsPaid,
    amountLocal: collected,
    amountUSD: collectedUSD,
    // The collected money as split-payment rows (same shape a receipt stores), so the
    // delivery becomes a proper receipt recording HOW it was paid; the fee keeps its own
    // method row. amountCollectedFromCustomer (the single LYD total) still drives the
    // server's debt comparison, so a server that ignores these arrays still works.
    payments: collectedPayments,
    deliveryFeePayments: feePayments,
    paymentMethod: collectedPayments.length > 1
      ? 'Split Payment'
      : (collectedPayments[0]?.method || 'Cash (LYD)'),
    deliveryHistory: nextHistory
  };

  // Server-confirmed save for Delivery users: only show success when backend confirms.
  if (isServerModeEnabled()) {
    const btn = document.getElementById('delivery-complete-submit');
    if (btn) btn.disabled = true;
    try {
      // Use the modal-open snapshot as the conflict baseline (not the fresh,
      // possibly live-synced receipt._lastModified) so a concurrent admin edit
      // 409s instead of being silently overwritten.
      const expected = (_deliveryCompletionOpen && _deliveryCompletionOpen.id === String(receipt.id))
        ? _deliveryCompletionOpen.lastMod
        : (receipt._lastModified || 0);
      const res = await apiPatchEntity('receipts', receipt.id, updates, expected);
      const saved = res?.data ? Security.sanitizeObject(res.data) : null;
      if (!saved || !saved.id) {
        showNotification(state.language === 'ar' ? 'خطأ في الخادم' : 'Server Error', state.language === 'ar' ? 'فشل حفظ التوصيل: استجابة غير صالحة من الخادم' : 'Failed to save delivery: invalid server response', 'error');
        if (btn) btn.disabled = false;
        return;
      }
      const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
      if (idx !== -1) state.receipts[idx] = saved;
      markCollectionDirty('receipts');
      // Close the form and paint success IMMEDIATELY. The old code awaited a
      // full (driver-scoped) ads re-download here, freezing a dead "Mark
      // Delivered" button for seconds on field networks. The exact local
      // reclassification plan — the same one the offline fallback uses —
      // keeps the linked ads visually consistent until the authoritative
      // background refresh lands.
      const paidNow = typeof getReceiptPaymentState === 'function'
        ? getReceiptPaymentState(saved) === 'paid'
        : (saved.isPaid === true || String(saved.status || '') === 'Paid');
      if (paidNow) {
        try { applyLocalReceiptPaidAdUpdates(planLocalReceiptPaidAdUpdates(String(saved.id), saved)); } catch (_) {}
      }
      saveState();
      _clearDeliveryCompletionDraft(receipt.id);
      document.getElementById('delivery-complete-modal')?.remove();
      forceFullRender();
      showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
      if (paidNow) {
        // Authoritative ads refresh WITHOUT awaiting (allowPaidLocalFallback
        // stays false — the exact local plan above was already applied, so a
        // failed refresh must not re-apply it). apiLoadCollectionAll's own
        // session-identity guard prevents a post-logout state.ads stomp.
        refreshAdsAfterReceiptServerCascade(saved).then((adRefresh) => {
          if (adRefresh && adRefresh.consistent) {
            saveState();
            RenderQueue.schedule('deliveryAdsCascade');
          } else {
            showNotification(
              state.language === 'ar' ? 'المزامنة معلقة' : 'Sync pending',
              state.language === 'ar' ? 'تم حفظ التوصيل، وسيتم تحديث الإعلانات المرتبطة تلقائياً عند عودة الاتصال.' : 'Delivery was saved. Linked ads will refresh automatically when the connection returns.',
              'warning'
            );
          }
        }).catch(() => {});
      }
    } catch (e) {
      // Idempotency / retries: if we hit a conflict, load latest and succeed if already delivered.
      if (e?.status === 409) {
        try {
          const latest = await apiGetEntity('receipts', receipt.id);
          const latestData = latest?.data ? Security.sanitizeObject(latest.data) : null;
          if (latestData && String(latestData.deliveryStatus || '') === 'Delivered') {
            const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
            if (idx !== -1) state.receipts[idx] = latestData;
            markCollectionDirty('receipts');
            const paidAfterRetry = typeof getReceiptPaymentState === 'function'
              ? getReceiptPaymentState(latestData) === 'paid'
              : (latestData.isPaid === true || String(latestData.status || '') === 'Paid');
            if (paidAfterRetry) {
              try { applyLocalReceiptPaidAdUpdates(planLocalReceiptPaidAdUpdates(String(latestData.id), latestData)); } catch (_) {}
            }
            saveState();
            _clearDeliveryCompletionDraft(receipt.id);
            document.getElementById('delivery-complete-modal')?.remove();
            forceFullRender();
            showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
            if (paidAfterRetry) {
              refreshAdsAfterReceiptServerCascade(latestData).then((adRefresh) => {
                if (adRefresh && adRefresh.consistent) {
                  saveState();
                  RenderQueue.schedule('deliveryAdsCascade');
                } else {
                  showNotification(
                    state.language === 'ar' ? 'المزامنة معلقة' : 'Sync pending',
                    state.language === 'ar' ? 'تم حفظ التوصيل، وسيتم تحديث الإعلانات المرتبطة تلقائياً عند عودة الاتصال.' : 'Delivery was saved. Linked ads will refresh automatically when the connection returns.',
                    'warning'
                  );
                }
              }).catch(() => {});
            }
            return;
          }
          if (latestData && latestData.id) {
            // GENUINE concurrent edit (admin changed the receipt while the
            // form was open). Without a rebase every retry re-sends the same
            // stale baseline and 409s forever; the only old escape was
            // close+reopen, which destroyed the typed data and the photo.
            // Install the fresh copy, rebase the conflict baseline, keep the
            // driver's DOM inputs untouched, and let the next tap succeed.
            const idxLive = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
            if (idxLive !== -1) state.receipts[idxLive] = latestData;
            markCollectionDirty('receipts');
            saveState();
            if (String(latestData.deliveryStatus || '') === 'Canceled') {
              // Re-delivering a canceled receipt must not be one tap away.
              _clearDeliveryCompletionDraft(receipt.id);
              document.getElementById('delivery-complete-modal')?.remove();
              forceFullRender();
              showNotification(
                state.language === 'ar' ? 'غير مسموح' : 'Not Allowed',
                state.language === 'ar' ? 'تم إلغاء هذا التوصيل من الإدارة.' : 'This delivery was canceled by an admin.',
                'error'
              );
              return;
            }
            if (_deliveryCompletionOpen && _deliveryCompletionOpen.id === String(receipt.id)) {
              _deliveryCompletionOpen.lastMod = latestData._lastModified || 0;
            }
            // The toast says "review the figures" — make the baked-in header
            // figures actually show the fresh ones, not the open-time values.
            try {
              const debtEl = document.getElementById('delivery-complete-debt');
              const quotedEl = document.getElementById('delivery-complete-quoted');
              if (debtEl) debtEl.textContent = `${getReceiptCollectionTarget(latestData).amountLocal.toFixed(0)} LYD`;
              if (quotedEl) quotedEl.textContent = `${(Number(latestData.quotedDeliveryFee ?? 0) || 0).toFixed(0)} LYD`;
            } catch (_) {}
            updateReceiptDeliveryCompletionComputed();
            showNotification(
              state.language === 'ar' ? 'تغيّر الوصل' : 'Receipt changed',
              state.language === 'ar' ? 'تغيّر الوصل أثناء فتح النافذة — راجع البيانات ثم اضغط "تم التوصيل" مرة أخرى.' : 'The receipt changed while this form was open — review the figures and tap Mark Delivered again.',
              'warning'
            );
            if (btn) btn.disabled = false;
            return;
          }
        } catch (retryErr) {
          // Fall through to error toast - retry also failed
          if (ALBAYAN_DEBUG_MODE) console.warn('[handleDeliveryComplete] Retry fetch failed:', retryErr?.message || retryErr);
        }
      }
      const netMessage = describeNetworkError(e);
      if (netMessage) {
        // Keep the raw engine string ('Load failed', 'Failed to fetch'…) in
        // the console; the toast must be bilingual and actionable for the
        // Arabic-first drivers this flow targets.
        try { console.warn('[deliveryCompletion] Network failure:', e?.message || e); } catch (_) {}
        showNotification(state.language === 'ar' ? 'مشكلة في الاتصال' : 'Connection problem', netMessage, 'error');
      } else {
        const status = e?.status ? `HTTP ${e.status}` : '';
        const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
        showNotification(state.language === 'ar' ? 'خطأ في الخادم' : 'Server Error', (state.language === 'ar' ? 'فشل حفظ التوصيل: ' : 'Failed to save delivery: ') + `${status ? status + ' - ' : ''}${detail}`, 'error');
      }
      if (btn) btn.disabled = false;
      return;
    }
  } else {
    const saved = await updateRecord(state.receipts, receipt.id, updates);
    if (!saved) return;
    _clearDeliveryCompletionDraft(receipt.id);
    document.getElementById('delivery-complete-modal')?.remove();
    showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
    render();
  }
}

function openReceiptDeliveryCancelModal(receiptId) {
  const isArX = state.language === 'ar';
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification(isArX ? 'خطأ' : 'Error', isArX ? 'الوصل غير موجود' : 'Receipt not found', 'error');
    return;
  }
  if (String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification(isArX ? 'تم رفض الوصول' : 'Access Denied', isArX ? 'لمستخدمي التوصيل فقط' : 'Delivery users only', 'error');
    return;
  }
  if (String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification(isArX ? 'تم رفض الوصول' : 'Access Denied', isArX ? 'هذا الوصل غير معيَّن لك' : 'This receipt is not assigned to you', 'error');
    return;
  }
  if (String(receipt.deliveryStatus || '') === 'Delivered') {
    showNotification(isArX ? 'غير مسموح' : 'Not Allowed', isArX ? 'تم التوصيل بالفعل.' : 'Already delivered.', 'warning');
    return;
  }

  document.getElementById('delivery-cancel-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'delivery-cancel-modal';
  modal.className = 'mobile-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  // Backdrop taps are how phone users dismiss the keyboard — never let one
  // silently destroy a typed cancel reason. Empty form still closes instantly.
  modal.onclick = (e) => {
    if (e.target !== modal) return;
    const typedReason = String(document.getElementById('delivery-cancel-reason')?.value || '');
    if (typedReason.trim() && !confirm(state.language === 'ar' ? 'تجاهل السبب المكتوب؟' : 'Discard the typed reason?')) return;
    modal.remove();
  };
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-md animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center">
            <i data-lucide="x-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">${isArX ? 'إلغاء التوصيل' : 'Cancel Delivery'}</div>
            <div class="text-xs text-slate-500">${isArX ? 'الوصل' : 'Receipt'} ${Security.escapeHtml(String(receipt.tempReceiptNo || receipt.serialNumber || receipt.id))}</div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-cancel-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">${isArX ? 'السبب *' : 'Reason *'}</label>
          <textarea id="delivery-cancel-reason" rows="3" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="${isArX ? 'لماذا تقوم بالإلغاء؟' : 'Why are you cancelling?'}"></textarea>
        </div>
        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="this.closest('#delivery-cancel-modal').remove()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">${isArX ? 'إغلاق' : 'Close'}</button>
          <button type="button" onclick="submitReceiptDeliveryCancel('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            ${isArX ? 'تأكيد الإلغاء' : 'Confirm Cancel'}
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

async function submitReceiptDeliveryCancel(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) return;
  // Double-taps are endemic on touch (iOS fires both clicks ~100-300ms apart):
  // keep one cancel mutation per receipt in flight, same as markAsCollected.
  const actionKey = String(receipt.id || receiptId || '');
  if (_deliveryActionInFlight.has(actionKey)) return;
  _deliveryActionInFlight.add(actionKey);
  try {
    const reason = String(document.getElementById('delivery-cancel-reason')?.value || '').trim();
    if (!reason) {
      showNotification(state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation', state.language === 'ar' ? 'سبب الإلغاء مطلوب.' : 'Cancel reason is required.', 'error');
      return;
    }
    const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
    nextHistory.push({
      ts: new Date().toISOString(),
      userId: state.currentUser?.id || '',
      action: 'CANCELLED_BY_DRIVER',
      reason
    });
    const canceledOk = await updateRecord(state.receipts, receipt.id, {
      deliveryStatus: 'Canceled',
      deliveryCancelReason: reason,
      deliveryCancelledAt: new Date().toISOString(),
      deliveryCancelledBy: state.currentUser?.id || '',
      deliveryHistory: nextHistory
    });
    if (!canceledOk) return;
    // The canceled delivery's debt will never be collected — release any ad
    // funding that was drawn from its due credit.
    let releasedAds = 0;
    if (!isServerModeEnabled()) {
      try {
        releasedAds = await releaseCanceledDeliveryDueFunding(receipt.id);
      } catch (_) {
        return;
      }
    }
    _clearDeliveryCompletionDraft(receipt.id);
    // Both stacked surfaces (cancel dialog over the completion form) close in
    // ONE task, so the body overlay observer (src/01b-mobile-runtime.js) sees
    // a single 2->0 mutation and consumes only ONE overlay-history sentinel —
    // stranding the second and turning the driver's next hardware Back press
    // into a dead no-op + scroll reset. Mirror closeModal's go(-2) teardown:
    // consume both consecutive sentinel entries in one traversal and flag the
    // resulting popstate as bookkeeping; the observer's decrease branch is
    // then skipped via its _overlayHistoryConsumePending() gate.
    const cancelModalEl = document.getElementById('delivery-cancel-modal');
    const completeModalEl = document.getElementById('delivery-complete-modal');
    if (cancelModalEl && completeModalEl
        && typeof isPhoneBrowserHistoryManaged === 'function' && isPhoneBrowserHistoryManaged()
        && typeof _overlaySentinelDepth === 'number' && _overlaySentinelDepth >= 2
        && window.history.state && window.history.state.overlaySentinel
        && !window.history.state.underAlbayanModal) {
      _suppressOverlayPopstateUntil = Date.now() + 800;
      try {
        window.history.go(-2);
        _overlaySentinelDepth -= 2;
      } catch (_) {
        _suppressOverlayPopstateUntil = 0;
      }
    }
    if (cancelModalEl) cancelModalEl.remove();
    if (completeModalEl) completeModalEl.remove();
    render();
    showNotification(
      state.language === 'ar' ? 'تم الإلغاء' : 'Canceled',
      (state.language === 'ar' ? 'تم إلغاء التوصيل' : 'Delivery canceled')
        + (releasedAds > 0 && !isServerModeEnabled()
          ? (state.language === 'ar' ? ` — تم تحرير تمويل ${releasedAds} إعلان(ات) كان مأخوذاً من دين هذا التوصيل` : ` — funding of ${releasedAds} ad(s) drawn from this delivery's debt was released`)
          : ''),
      releasedAds > 0 && !isServerModeEnabled() ? 'warning' : 'success'
    );
    if (isServerModeEnabled()) {
      // Refresh the linked ads WITHOUT blocking the close: the receipt PATCH
      // already committed, the cancel UI only reads receipt.deliveryStatus
      // (updated by the echo above), and ads reconcile seconds later — or via
      // delta live-sync, exactly what the Sync-pending toast promises.
      const savedReceipt = state.receipts.find(row => row && String(row.id) === String(receipt.id)) || receipt;
      saveState();
      refreshAdsAfterReceiptServerCascade(savedReceipt).then((adRefresh) => {
        if (adRefresh && adRefresh.consistent) {
          saveState();
          RenderQueue.schedule('deliveryAdsCascade');
        } else {
          showNotification(
            state.language === 'ar' ? 'المزامنة معلقة' : 'Sync pending',
            state.language === 'ar' ? 'تم حفظ الإلغاء، وسيتم تحديث الإعلانات المرتبطة تلقائياً عند عودة الاتصال.' : 'Cancellation was saved. Linked ads will refresh automatically when the connection returns.',
            'warning'
          );
        }
      }).catch(() => {});
    }
  } finally {
    _deliveryActionInFlight.delete(actionKey);
  }
}

async function markAsDelivered(itemId) {
  // One delivery mutation per item in flight (double-tap guard, same pattern
  // as markAsCollected/acceptDelivery).
  const actionKey = String(itemId || '');
  if (_deliveryActionInFlight.has(actionKey)) return;
  _deliveryActionInFlight.add(actionKey);
  try {
    // Check if it's a receipt or an ad
    const isReceipt = state.receipts.find(r => r.id === itemId);
    if (isReceipt) {
      // Strict flow for temp delivery receipts: require final receipt # + photo + amounts
      if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
        openReceiptDeliveryCompletionModal(itemId);
        return;
      }
      // Delivered ≠ Office Handover. Office handover is a separate step (isReceivedInOffice).
      const savedOk = await updateRecord(state.receipts, itemId, { deliveryStatus: 'Delivered' });
      if (!savedOk) return;
    } else {
      const savedOk = await updateRecord(state.ads, itemId, {
        deliveryStatus: 'Delivered'
      });
      if (!savedOk) return;
    }
    showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم التحديد كمُوصَّل' : 'Marked as delivered', 'success');
    render();
  } finally {
    _deliveryActionInFlight.delete(actionKey);
  }
}

// ==========================================
// RECEIPT FILTER FUNCTIONS
// ==========================================

let _receiptSearchTimer = null;

function updateReceiptSearch(value) {
  const v = String(value || '');
  const clean = Security.sanitizeInput(v, { maxLength: 200 });
  state.receiptSearch = clean;
  if (_receiptSearchTimer) clearTimeout(_receiptSearchTimer);
  // Small debounce to keep typing smooth (same pattern as the customers view).
  // Only the results below the search box are re-rendered, so the input keeps
  // focus naturally — no full-page rebuild, no refocus hack.
  _receiptSearchTimer = setTimeout(() => {
    _receiptSearchTimer = null;
    updateReceiptsViewFiltered();
  }, 120);
}

function updateReceiptsViewFiltered() {
  if (state.currentView !== 'receipts') return;
  const grid = document.getElementById('receipts-grid');
  const countEl = document.getElementById('receipts-count');
  const chipsEl = document.getElementById('receipt-active-filters');
  const clearEl = document.getElementById('receipt-search-clear');
  const clearFiltersEl = document.getElementById('receipt-clear-filters');
  if (!grid || !countEl) {
    // View structure not on screen (e.g. mid-navigation): fall back to a full render.
    render();
    if (window.lucide) lucide.createIcons();
    return;
  }
  // Build the fresh view HTML off-screen, then swap in only the parts that
  // change while searching (results grid, count, filter chips, clear button).
  const tpl = document.createElement('template');
  tpl.innerHTML = renderReceiptsView();
  const src = tpl.content;
  const newGrid = src.querySelector('#receipts-grid');
  const newCount = src.querySelector('#receipts-count');
  const newChips = src.querySelector('#receipt-active-filters');
  const newClear = src.querySelector('#receipt-search-clear');
  const newClearFilters = src.querySelector('#receipt-clear-filters');
  if (newGrid) grid.innerHTML = newGrid.innerHTML;
  if (newCount) countEl.textContent = newCount.textContent;
  if (chipsEl && newChips) chipsEl.innerHTML = newChips.innerHTML;
  if (clearEl && newClear) clearEl.innerHTML = newClear.innerHTML;
  if (clearFiltersEl && newClearFilters) clearFiltersEl.innerHTML = newClearFilters.innerHTML;
  if (window.lucide) lucide.createIcons();
}

function clearReceiptSearch() {
  state.receiptSearch = '';
  render();
  lucide.createIcons();
}

function applyReceiptQuickFilter(mode) {
  // Quick filters are intentionally mutually exclusive so a beginner never
  // gets an empty list from a hidden combination. Keep the typed search term,
  // then reset only the dropdown dimensions before applying the chosen view.
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptDebtFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  if (mode === 'unpaid') state.receiptStatusFilter = 'not_paid';
  if (mode === 'debt') state.receiptDebtFilter = 'any-debt';
  if (mode === 'not-collected') state.receiptCollectedFilter = 'not-collected';
  render();
}

function updateReceiptFilter(filterType, value) {
  switch (filterType) {
    case 'status':
      state.receiptStatusFilter = value;
      break;
    case 'payment':
      state.receiptPaymentFilter = value;
      break;
    case 'date':
      state.receiptDateFilter = value;
      break;
    case 'debt':
      state.receiptDebtFilter = value;
      break;
    case 'collected':
      state.receiptCollectedFilter = value;
      break;
    case 'sort':
      state.receiptSortBy = value;
      break;
  }
  render();
  lucide.createIcons();
}

function clearAllReceiptFilters() {
  state.receiptSearch = '';
  state.receiptCustomerFilter = '';
  state.receiptRecordFilter = '';
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptDebtFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  if (state.currentView === 'receipts') updateUrlForView('receipts', true);
  render();
  lucide.createIcons();
}

// Toggle receipt collected status
function _canMarkCollected() {
  if (!currentUserHasPermission('receipts', 'markCollected')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل حالة التحصيل' : 'You do not have permission to mark receipts as collected', 'error');
    return false;
  }
  return true;
}

function _logReceiptCollection(receipt, action, collectedAmount) {
  state.logs.push({
    id: generateId(),
    type: 'receipt_collection',
    action,
    receiptId: receipt.id,
    userId: state.currentUser?.id,
    timestamp: new Date().toISOString(),
    details: { receiptSerial: receipt.serialNumber, amountUSD: receipt.amountUSD, amountLocal: receipt.amountLocal, collectedAmount }
  });
}

// Open a small modal to record HOW MUCH was collected for a receipt (user
// request). Supports partial collection; the card then shows collected + the
// amount still left to collect. Self-contained (stop-ad-modal style) so it
// doesn't touch renderModal/state.modalData.
// ---- Receipt collection (2-step): ask "same as receipt?" -> Yes records it
// as-is; No opens a payment-methods editor like the ad/receipt forms. ----
let _tempCollectPayments = [];   // [{ method, amount }] working list for the "No" editor
let _collectReceiptId = '';
let _collectTargetLYD = 0;

function _receiptCashCollectionTargetLocal(receipt) {
  return getReceiptPaymentState(receipt) === 'not_paid'
    ? getReceiptCollectionTarget(receipt).amountLocal
    : (Number(receipt?.amountLocal) || 0);
}

// The receipt's own payment breakdown in LYD (used for the "Yes = same" path
// and to seed the "No" editor). Each split's LYD value is amount × rate1.
function _receiptCollectionBreakdown(receipt) {
  const target = _receiptCashCollectionTargetLocal(receipt);
  if (Array.isArray(receipt.payments) && receipt.payments.length) {
    return receipt.payments
      .map(p => ({ method: p.method || 'Cash (LYD)', amount: Math.round((Number(p.amount) || 0) * (Number(p.rate) || 1) * 100) / 100 }))
      .filter(p => p.amount > 0);
  }
  return [{ method: receipt.paymentMethod || 'Cash (LYD)', amount: target }];
}

// Every edit door on a destroyed receipt shows the same bilingual message.
function _blockDestroyedReceiptEdit(receipt) {
  if (String(receipt?.status || '') !== 'Destroyed') return false;
  showNotification(
    state.language === 'ar' ? 'وصل تالف' : 'Destroyed receipt',
    state.language === 'ar'
      ? 'هذا الوصل تالف ورقمه مقفول — لا يمكن تعديله. احذفه إذا أردت تحرير الرقم.'
      : 'This receipt is destroyed and its number is locked — it cannot be edited. Delete it to free the number.',
    'error'
  );
  return true;
}

function openCollectReceiptModal(receiptId) {
  if (!_canMarkCollected()) return;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  if (_blockDestroyedReceiptEdit(receipt)) return;
  const isAr = state.language === 'ar';
  const targetLYD = _receiptCashCollectionTargetLocal(receipt);
  const serialTxt = receipt.serialNumber || receipt.tempReceiptNo || receipt.finalReceiptNo || receiptId.slice(0, 8);
  _collectReceiptId = receiptId;
  _collectTargetLYD = targetLYD;
  _tempCollectPayments = [];
  updateUrlParams({ modal: 'collect-receipt', id: receiptId }); // URL tracking

  document.getElementById('collect-receipt-modal')?.remove();
  const html = `
    <div id="collect-receipt-modal" class="mobile-dialog-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onclick="if(event.target===this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
        <div class="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-800 z-10">
          <h2 class="text-lg font-bold text-slate-800 dark:text-white flex items-center">
            <i data-lucide="hand-coins" class="w-5 h-5 mr-2 text-emerald-600"></i>
            ${isAr ? 'تسجيل التحصيل' : 'Record Collection'}
          </h2>
          <button onclick="document.getElementById('collect-receipt-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div id="collect-modal-body" class="p-5">
          ${_collectAskView(receiptId, receipt, isAr, targetLYD, serialTxt)}
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  if (window.lucide) lucide.createIcons();
}

// Step 1: ask whether the money came in exactly as the receipt states.
function _collectAskView(receiptId, receipt, isAr, targetLYD, serialTxt) {
  const breakdown = _receiptCollectionBreakdown(receipt);
  return `
    <div class="text-sm text-slate-600 dark:text-slate-400 mb-1">
      ${isAr ? 'الوصل' : 'Receipt'} #${Security.escapeHtml(String(serialTxt))} — ${isAr ? 'الإجمالي' : 'Total'}: <span class="font-bold text-slate-800 dark:text-white">${targetLYD.toFixed(2)} LYD</span>
    </div>
    <div class="text-xs text-slate-500 mb-4">
      ${isAr ? 'حسب الوصل' : 'As on the receipt'}: ${breakdown.map(p => `${Security.escapeHtml(trMethod(p.method))} ${p.amount.toFixed(2)} LYD`).join(' • ')}
    </div>
    <p class="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
      ${isAr ? 'هل تم التحصيل بنفس بيانات الوصل الأصلية؟' : 'Did you collect exactly as shown on the receipt?'}
    </p>
    <div class="grid grid-cols-2 gap-3">
      <button onclick="collectReceiptSame('${receiptId}')" class="px-4 py-3 rounded-xl font-bold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2">
        <i data-lucide="check" class="w-4 h-4"></i>${isAr ? 'نعم، كما الوصل' : 'Yes, same'}
      </button>
      <button onclick="collectReceiptCustom('${receiptId}')" class="px-4 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 flex items-center justify-center gap-2">
        <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>${isAr ? 'لا، طرق أخرى' : 'No, different'}
      </button>
    </div>`;
}

// "Yes" — record the collection using the receipt's own breakdown, full amount.
async function collectReceiptSame(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const breakdown = _receiptCollectionBreakdown(receipt);
  await _saveReceiptCollection(receipt, breakdown, _receiptCashCollectionTargetLocal(receipt), true);
}

// "No" — switch the modal to the payment-methods editor (like the ad form).
function collectReceiptCustom(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  // Seed from the receipt's own breakdown so the user just edits amounts/methods.
  _tempCollectPayments = _receiptCollectionBreakdown(receipt).map(p => ({ method: p.method, amount: String(p.amount) }));
  if (_tempCollectPayments.length === 0) _tempCollectPayments = [{ method: PAYMENT_METHODS[0], amount: '' }];
  const body = document.getElementById('collect-modal-body');
  if (body) body.innerHTML = _collectEditorView(receiptId, receipt);
  if (window.lucide) lucide.createIcons();
}

function _collectEditorView(receiptId, receipt) {
  const isAr = state.language === 'ar';
  const target = _collectTargetLYD;
  const rows = _tempCollectPayments.map((p, idx) => `
    <div class="grid grid-cols-12 gap-2 items-end">
      <div class="col-span-7">
        ${idx === 0 ? `<label class="block text-[10px] text-slate-400 mb-1">${isAr ? 'الطريقة' : 'Method'}</label>` : ''}
        <select onchange="updateCollectPaymentRow(${idx}, 'method', this.value)" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm">
          ${paymentMethodOptions(p.method).map(m => `<option value="${m}" ${p.method === m ? 'selected' : ''}>${trMethod(m)}</option>`).join('')}
        </select>
      </div>
      <div class="col-span-4">
        ${idx === 0 ? `<label class="block text-[10px] text-slate-400 mb-1">${isAr ? 'المبلغ (LYD)' : 'Amount (LYD)'}</label>` : ''}
        <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(p.amount || ''))}" oninput="sanitizeMoneyInput(this); updateCollectPaymentRow(${idx}, 'amount', this.value)" onfocus="this.select()" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" placeholder="0.00" />
      </div>
      <div class="col-span-1 flex justify-center pb-1">
        ${_tempCollectPayments.length > 1 ? `<button type="button" onclick="removeCollectPaymentRow(${idx})" class="text-rose-500 hover:text-rose-600"><i data-lucide="x" class="w-4 h-4"></i></button>` : ''}
      </div>
    </div>`).join('');
  const total = _tempCollectPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const left = Math.max(target - total, 0);
  return `
    <div class="text-sm text-slate-600 dark:text-slate-400 mb-3">
      ${isAr ? 'الإجمالي المطلوب' : 'Total due'}: <span class="font-bold text-slate-800 dark:text-white">${target.toFixed(2)} LYD</span>
    </div>
    <div class="space-y-2" id="collect-rows">${rows}</div>
    <button type="button" onclick="addCollectPaymentRow()" class="mt-2 text-xs font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
      <i data-lucide="plus-circle" class="w-4 h-4"></i>${isAr ? 'إضافة طريقة' : 'Add method'}
    </button>
    <div class="mt-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 space-y-1 text-sm">
      <div class="flex justify-between"><span class="text-slate-600 dark:text-slate-400">${isAr ? 'إجمالي المُحصَّل' : 'Total collected'}:</span><span class="font-bold text-emerald-600" id="collect-total">${total.toFixed(2)} LYD</span></div>
      <div class="flex justify-between"><span class="text-slate-600 dark:text-slate-400">${isAr ? 'المتبقي للتحصيل' : 'Left to collect'}:</span><span class="font-bold text-orange-600" id="collect-left">${left.toFixed(2)} LYD</span></div>
    </div>
    <div class="flex space-x-3 pt-4">
      <button onclick="collectReceiptCustomBack('${receiptId}')" class="flex-1 px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold">${isAr ? 'رجوع' : 'Back'}</button>
      <button onclick="confirmCollectReceipt('${receiptId}')" class="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700">${isAr ? 'حفظ' : 'Save'}</button>
    </div>`;
}

function _rerenderCollectEditor() {
  const receipt = state.receipts.find(r => r.id === _collectReceiptId);
  const body = document.getElementById('collect-modal-body');
  if (receipt && body) { body.innerHTML = _collectEditorView(_collectReceiptId, receipt); if (window.lucide) lucide.createIcons(); }
}

function _refreshCollectTotals() {
  const total = _tempCollectPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalEl = document.getElementById('collect-total');
  const leftEl = document.getElementById('collect-left');
  if (totalEl) totalEl.textContent = total.toFixed(2) + ' LYD';
  if (leftEl) leftEl.textContent = Math.max(_collectTargetLYD - total, 0).toFixed(2) + ' LYD';
}

// Row edits: amount just refreshes the totals (no re-render, keeps typing focus);
// method changes state silently; add/remove re-render the whole editor.
function updateCollectPaymentRow(idx, field, value) {
  if (!_tempCollectPayments[idx]) return;
  _tempCollectPayments[idx][field] = value;
  if (field === 'amount') _refreshCollectTotals();
}
function addCollectPaymentRow() { _tempCollectPayments.push({ method: PAYMENT_METHODS[0], amount: '' }); _rerenderCollectEditor(); }
function removeCollectPaymentRow(idx) { _tempCollectPayments.splice(idx, 1); _rerenderCollectEditor(); }
function collectReceiptCustomBack(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  const body = document.getElementById('collect-modal-body');
  if (receipt && body) {
    const serialTxt = receipt.serialNumber || receipt.tempReceiptNo || receipt.finalReceiptNo || receiptId.slice(0, 8);
    body.innerHTML = _collectAskView(receiptId, receipt, state.language === 'ar', _receiptCashCollectionTargetLocal(receipt), serialTxt);
    if (window.lucide) lucide.createIcons();
  }
}

// "No" path save: validate + persist the custom breakdown.
async function confirmCollectReceipt(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const payments = _tempCollectPayments
    .map(p => ({ method: p.method, amount: Math.round((parseFloat(p.amount) || 0) * 100) / 100 }))
    .filter(p => p.amount > 0);
  if (payments.length === 0) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'أدخل مبلغاً واحداً على الأقل' : 'Enter at least one amount', 'error');
    return;
  }
  const total = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  await _saveReceiptCollection(receipt, payments, total, false);
}

// Shared save for both the "Yes" and "No" paths.
async function _saveReceiptCollection(receipt, payments, totalLYD, matchesReceipt) {
  if (!_canMarkCollected()) return;
  const targetLYD = _receiptCashCollectionTargetLocal(receipt);
  const savedOk = await updateRecord(state.receipts, receipt.id, {
    collected: true,
    collectedAmount: totalLYD,
    collectedPayments: payments,
    collectedMatchesReceipt: !!matchesReceipt,
    collectedAt: new Date().toISOString(),
    collectedBy: state.currentUser?.id || 'admin'
  });
  if (!savedOk) return false;
  _logReceiptCollection(receipt, 'collected', totalLYD);
  saveState();
  document.getElementById('collect-receipt-modal')?.remove();
  const leftLYD = Math.max(targetLYD - totalLYD, 0);
  const isAr = state.language === 'ar';
  showNotification(
    isAr ? 'تم التحصيل' : 'Collected',
    (isAr ? `تم تسجيل ${totalLYD.toFixed(2)} LYD` : `Recorded ${totalLYD.toFixed(2)} LYD`) + (leftLYD > 0.01 ? (isAr ? ` — المتبقي ${leftLYD.toFixed(2)} LYD` : ` — ${leftLYD.toFixed(2)} LYD left`) : ''),
    'success'
  );
  render();
  if (window.lucide) lucide.createIcons();
  return true;
}

async function uncollectReceipt(receiptId) {
  if (!_canMarkCollected()) return;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const savedOk = await updateRecord(state.receipts, receiptId, { collected: false, collectedAmount: null, collectedAt: null, collectedBy: null });
  if (!savedOk) return;
  _logReceiptCollection(receipt, 'uncollected', 0);
  saveState();
  showNotification(state.language === 'ar' ? 'تم الإلغاء' : 'Collection Removed', state.language === 'ar' ? 'تم إلغاء التحصيل' : 'Receipt marked as not collected', 'info');
  render();
  if (window.lucide) lucide.createIcons();
}

// Back-compat shim: old callers of the boolean toggle now route to the new
// amount-based flow (open the modal to collect, or undo).
function toggleReceiptCollected(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  if (receipt.collected) uncollectReceipt(receiptId);
  else openCollectReceiptModal(receiptId);
}

// "Existing balance" mode for the NEXT new receipt. It uses the exact same receipt
// form as a normal receipt (all payment methods, serial, collection, delivery, phone,
// photos); the only difference is the saved receipt is tagged CARRIED_BALANCE (its own
// colour + badge) and the amount entered is understood as the customer's REMAINING
// balance. Reset every time the modal opens so a normal receipt is never tagged.
let _newReceiptCarried = false;

function showReceiptModal(carried = false) {
  // Permission check for creating receipts
  if (!currentUserHasPermission('receipts', 'add')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء وصولات' : 'You do not have permission to create receipts', 'error');
    return;
  }
  if (typeof resetReceiptCustomerRiskWarningState === 'function') {
    resetReceiptCustomerRiskWarningState();
  }
  _newReceiptCarried = !!carried;
  state.activeModal = 'receipt';
  state.modalData = null;
  updateUrlParams({ modal: 'receipt', id: 'new' }); // URL tracking for new receipt
  renderModal();
}

// ---- New-Receipt type chooser -------------------------------------------
// Clicking "New Receipt" first asks WHICH kind of receipt: a normal one
// (money received now) or an "existing balance" one (a customer who already
// spent part of his money elsewhere — we only record what's LEFT). The two
// options are deliberately far apart with very different colours so the wrong
// one is hard to pick by accident.
function showNewReceiptChooser() {
  if (!currentUserHasPermission('receipts', 'add')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء وصولات' : 'You do not have permission to create receipts', 'error');
    return;
  }
  const isAr = state.language === 'ar';
  document.getElementById('new-receipt-chooser')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'new-receipt-chooser';
  wrap.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  wrap.innerHTML = `
    <div class="glass-panel w-full max-w-lg p-6 rounded-3xl" onclick="event.stopPropagation()">
      <div class="flex justify-between items-start mb-1">
        <h2 class="text-xl font-bold text-slate-800 dark:text-white">${isAr ? 'اختر نوع الوصل' : 'Choose receipt type'}</h2>
        <button onclick="document.getElementById('new-receipt-chooser')?.remove()" class="text-slate-400 hover:text-slate-600 p-1"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <p class="text-xs text-slate-500 mb-5">${isAr ? 'اختر بعناية — الأنواع مختلفة.' : 'Choose carefully — the types are different.'}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <button type="button" onclick="_pickNewReceipt('normal')"
          class="text-start p-5 rounded-2xl border-2 transition-all hover:shadow-lg"
          style="border-color:#7c3aed;background:#f5f3ff">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center mb-3" style="background:#7c3aed;color:#fff"><i data-lucide="receipt" class="w-6 h-6"></i></div>
          <div class="font-extrabold" style="color:#5b21b6">${isAr ? 'وصل جديد' : 'New Receipt'}</div>
          <div class="text-xs mt-1" style="color:#6d28d9">${isAr ? 'مبلغ استلمته الآن (الوضع المعتاد)' : 'Money received now (the usual)'}</div>
        </button>
        <button type="button" onclick="_pickNewReceipt('carried')"
          class="text-start p-5 rounded-2xl border-2 transition-all hover:shadow-lg"
          style="border-color:#d97706;background:#fffbeb">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center mb-3" style="background:#d97706;color:#fff"><i data-lucide="history" class="w-6 h-6"></i></div>
          <div class="font-extrabold" style="color:#92400e">${isAr ? 'رصيد سابق' : 'Existing Balance'}</div>
          <div class="text-xs mt-1" style="color:#b45309">${isAr ? 'عميل استهلك جزءاً — سجّل المتبقي فقط' : 'Customer already used part — record what is left'}</div>
        </button>
        <button type="button" onclick="_pickNewReceipt('destroyed')"
          class="text-start p-5 rounded-2xl border-2 transition-all hover:shadow-lg sm:col-span-2"
          style="border-color:#dc2626;background:#fef2f2">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center mb-3" style="background:#dc2626;color:#fff"><i data-lucide="file-x" class="w-6 h-6"></i></div>
          <div class="font-extrabold" style="color:#991b1b">${isAr ? 'وصل تالف' : 'Destroyed Receipt'}</div>
          <div class="text-xs mt-1" style="color:#b91c1c">${isAr ? 'ورقة ممزقة لم تُستخدم أبداً — سجّل رقمها فقط حتى لا يدفع أحد بهذا الرقم' : 'Torn paper, never used — record only its number so nobody can ever pay with it'}</div>
        </button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  if (window.lucide) lucide.createIcons();
}

function _pickNewReceipt(kind) {
  document.getElementById('new-receipt-chooser')?.remove();
  if (kind === 'destroyed') {
    showDestroyedReceiptModal();
    return;
  }
  // Both remaining kinds open the SAME full receipt form; carried is tagged on save.
  showReceiptModal(kind === 'carried');
}

// ---- Destroyed receipt: locks the torn paper's number forever ------------
function showDestroyedReceiptModal() {
  if (!currentUserHasPermission('receipts', 'add')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء وصولات' : 'You do not have permission to create receipts', 'error');
    return;
  }
  const isAr = state.language === 'ar';
  document.getElementById('destroyed-receipt-dialog')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'destroyed-receipt-dialog';
  wrap.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  wrap.innerHTML = `
    <div class="glass-panel w-full max-w-md p-6 rounded-3xl" onclick="event.stopPropagation()">
      <div class="flex justify-between items-start mb-1">
        <h2 class="text-xl font-bold" style="color:#991b1b">${isAr ? 'وصل تالف' : 'Destroyed Receipt'}</h2>
        <button onclick="document.getElementById('destroyed-receipt-dialog')?.remove()" class="text-slate-400 hover:text-slate-600 p-1"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <p class="text-xs text-slate-500 mb-4">${isAr ? 'اكتب رقم الوصل الممزق. سيُقفل الرقم للأبد ولن يستطيع أحد الدفع به.' : 'Write the torn receipt’s number. The number is locked forever and nobody can ever pay with it.'}</p>
      <input id="destroyed-receipt-number" type="text" inputmode="text" autocomplete="off"
        class="w-full px-4 py-3 rounded-xl border-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-white font-mono text-lg"
        style="border-color:#dc2626" placeholder="${isAr ? 'رقم الوصل' : 'Receipt number'}" />
      <div class="flex gap-3 mt-5">
        <button type="button" onclick="_saveDestroyedReceipt(this)"
          class="flex-1 px-4 py-3 rounded-xl font-bold text-white transition-all hover:shadow-lg"
          style="background:#dc2626">${isAr ? 'قفل الرقم' : 'Lock the number'}</button>
        <button type="button" onclick="document.getElementById('destroyed-receipt-dialog')?.remove()"
          class="px-4 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('destroyed-receipt-number')?.focus(), 50);
}

async function _saveDestroyedReceipt(buttonEl) {
  const isAr = state.language === 'ar';
  const input = document.getElementById('destroyed-receipt-number');
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  const number = String(input?.value || '')
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianDigits.indexOf(d)))
    .trim().toUpperCase();
  if (!/^(?:[1-9][0-9]*|[SBOE][1-9][0-9]*)$/.test(number)) {
    showNotification(isAr ? 'رقم غير صالح' : 'Invalid number', isAr ? 'اكتب أرقاماً فقط (أو S/B/O/E ثم أرقام)' : 'Digits only (or S/B/O/E followed by digits)', 'error');
    return;
  }
  const taken = getVisibleRecords(state.receipts).some(r =>
    [r.serialNumber, r.finalReceiptNo, r.tempReceiptNo]
      .some(v => String(v || '').trim().toUpperCase() === number));
  if (taken) {
    showNotification(isAr ? 'الرقم مستخدم' : 'Number already used', isAr ? 'يوجد وصل بهذا الرقم بالفعل' : 'A receipt with this number already exists', 'error');
    return;
  }
  const record = {
    id: generateId('receipt'),
    recordType: 'receipt',
    status: 'Destroyed',
    isPaid: false,
    finalReceiptNo: number,
    serialNumber: number,
    amountUSD: 0,
    amountLocal: 0,
    customerId: '',
    date: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  if (buttonEl) buttonEl.disabled = true;
  try {
    if (isServerModeEnabled()) {
      const created = await apiCreateEntity('receipts', record);
      const saved = created?.data ? Security.sanitizeObject(created.data) : null;
      if (!saved || !saved.id) throw new Error('invalid server response');
      const savedIdx = state.receipts.findIndex(r => r && String(r.id) === String(saved.id));
      if (savedIdx === -1) state.receipts.unshift(saved); else state.receipts[savedIdx] = saved;
      markCollectionDirty('receipts');
      saveState();
    } else {
      const savedOk = await addRecord(state.receipts, record);
      if (!savedOk) { if (buttonEl) buttonEl.disabled = false; return; }
    }
  } catch (e) {
    if (buttonEl) buttonEl.disabled = false;
    const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
    showNotification(isAr ? 'فشل الحفظ' : 'Save failed', String(detail), 'error');
    return;
  }
  document.getElementById('destroyed-receipt-dialog')?.remove();
  addLog('create', 'receipt', record.id, `Destroyed receipt #${number} recorded`);
  showNotification(isAr ? 'تم قفل الرقم' : 'Number locked', isAr ? `الوصل ${number} مسجل كتالف — لا يمكن الدفع به أبداً` : `Receipt ${number} is recorded as destroyed — it can never be paid with`, 'success');
  render();
}


function manageSplitPayments(receiptId) {
  const receipt = state.receipts.find(a => a.id === receiptId);
  if (!receipt) return;
  // The split-payment editor rewrites receipt money (server enforces receipts.edit),
  // so gate it the same way editReceipt does — canActOnRecord keeps editOwn semantics.
  if (!canActOnRecord('receipts', 'edit', receipt.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الوصولات' : 'You do not have permission to edit this receipt', 'error');
    return;
  }
  if (_blockTransferInEdit(receipt)) return;

  state.activeModal = 'split-payments';
  state.modalData = receipt;
  updateUrlParams({ modal: 'split-payments', id: receiptId }); // URL tracking
  renderModal();
}

// A top-up adds budget to a LIVE ad. Terminal or refunded ads must NOT be
// toppable: topping up a refunded ad grew its allocation rows but left the
// refund's frozen baseline stale, so re-saving the refund erased the top-up's
// charge and freed that money to be spent again — fabricated receipt balance
// (audit round-3 #1).
function _isAdToppable(ad) {
  if (!ad) return false;
  if (['Canceled', 'Completed', 'Lost', 'Stopped'].includes(String(ad.status || ''))) return false;
  if (ad.refundType && ad.refundType !== 'None') return false;
  if (Array.isArray(ad.refundAllocationBaseline)) return false;
  return true;
}

function manageTopUps(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  // A top-up raises the ad's budget/end date (server enforces ads.edit), so it
  // must be gated by edit permission — not by ad STATE alone. Mirrors editAd.
  if (!canActOnRecord('ads', 'edit', ad.creatorId || ad.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الإعلانات' : 'You do not have permission to edit this ad', 'error');
    return;
  }
  if (!_isAdToppable(ad)) {
    const isAr = state.language === 'ar';
    showNotification(
      isAr ? 'غير ممكن' : 'Not possible',
      isAr ? 'لا يمكن تعبئة إعلان منتهٍ أو مُسترجَع — التعبئة للإعلانات النشطة فقط.' : 'A finished or refunded ad cannot be topped up — top-ups apply to active ads only.',
      'error'
    );
    return;
  }
  if (isServerModeEnabled()) {
    if (getAdPaymentState(ad) !== 'paid') {
      const isAr = state.language === 'ar';
      showNotification(
        isAr ? 'غير ممكن' : 'Not possible',
        isAr ? 'التعبئة متاحة للإعلانات المدفوعة والنشطة فقط.' : 'Top-ups are available only for active paid ads in shared-server mode.',
        'error'
      );
      return;
    }
  }

  // Seed the working list with a COPY of the ad's existing top-ups, so the
  // modal shows them, the X button can delete them, and newly-added ones
  // appear immediately. Starting empty (the old behavior) meant existing
  // top-ups couldn't be removed and new ones were invisible until save.
  tempTopUps = (ad.topUps || []).map(t => ({ ...t }));

  state.activeModal = 'top-ups';
  state.modalData = ad;
  updateUrlParams({ modal: 'top-ups', id: adId }); // URL tracking
  renderModal();
}

function manageRefund(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  // Refund mutates the ad's money exactly like editAd (server enforces ads.edit),
  // so gate it identically — mirrors editAd/stopAd/deleteAd's canActOnRecord guard.
  if (!canActOnRecord('ads', 'edit', ad.creatorId)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لاسترجاع الإعلانات' : 'You do not have permission to refund this ad', 'error');
    return;
  }

  state.activeModal = 'refund';
  state.modalData = ad;
  updateUrlParams({ modal: 'refund', id: adId }); // URL tracking
  renderModal();
}

// Open transfer modal for a receipt
// Only money the business actually RECEIVED can move between customers.
// A "Not Paid" receipt (and a Canceled/Lost one) holds no real money, but the
// transfer used to accept it anyway and mint a spendable Paid receipt for the
// target customer — money invented out of nothing.
function _isTransferableReceipt(r) {
  const st = String(r?.status || '');
  if (st === 'Canceled' || st === 'Lost' || st === 'Destroyed') return false;
  return st === 'Paid' || r?.isPaid === true;
}

function showReceiptTransferModal(receiptId) {
  // Permission check
  if (!currentUserHasPermission('receipts', 'transfer')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتحويل الرصيد' : 'You do not have permission to transfer receipt balance', 'error');
    return;
  }
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!_isTransferableReceipt(receipt)) {
    showNotification(
      state.language === 'ar' ? 'غير ممكن' : 'Not possible',
      state.language === 'ar' ? 'يمكن تحويل الرصيد من الوصولات المدفوعة فقط.' : 'Balance can only be transferred from paid receipts.',
      'error'
    );
    return;
  }
  state.activeModal = 'receipt-transfer';
  state.modalData = receipt;
  updateUrlParams({ modal: 'receipt-transfer', id: receiptId }); // URL tracking
  renderModal();
}

// Quick inline history viewer for receipt transfers
function showReceiptTransferHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  const transfers = receipt?.transfers || [];
  if (!receipt) return;
  const isArT = state.language === 'ar';
  if (!can('receipts', 'viewHistory')) {
    showNotification(isArT ? 'تم رفض الوصول' : 'Access Denied', isArT ? 'تحتاج صلاحية عرض سجل الوصل' : 'Requires the View History permission', 'error');
    return;
  }
  if (transfers.length === 0) {
    showNotification(isArT ? 'التحويلات' : 'Transfers', isArT ? 'لا توجد تحويلات مسجلة لهذا الوصل.' : 'No transfers recorded for this receipt.', 'info');
    return;
  }
  const lines = transfers.map(t => {
    const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
    const name = targetCustomer ? targetCustomer.name : (isArT ? 'غير معروف' : 'Unknown');
    return isArT
      ? `${new Date(t.date).toLocaleString(appDateLocale())}: $${(t.amountUSD || 0).toFixed(2)} إلى ${name}`
      : `${new Date(t.date).toLocaleString(appDateLocale())}: $${(t.amountUSD || 0).toFixed(2)} to ${name}`;
  }).join('\n');
  showNotification(isArT ? 'سجل التحويلات' : 'Transfer history', lines, 'info');
}

// Show receipt edit history modal
function showReceiptEditHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;

  const isArH = state.language === 'ar';
  if (!can('receipts', 'viewHistory')) {
    showNotification(isArH ? 'تم رفض الوصول' : 'Access Denied', isArH ? 'تحتاج صلاحية عرض سجل الوصل' : 'Requires the View History permission', 'error');
    return;
  }
  const editHistory = receipt.editHistory || [];
  if (editHistory.length === 0) {
    showNotification(isArH ? 'سجل التعديلات' : 'Edit History', isArH ? 'لا يوجد سجل تعديلات لهذا الوصل.' : 'No edit history recorded for this receipt.', 'info');
    return;
  }
  
  const customer = state.customers.find(c => c.id === receipt.customerId);
  
  const modalHTML = `
    <div id="edit-history-modal" class="mobile-dialog-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-amber-500"></i>
                ${isArH ? 'سجل التعديلات' : 'Edit History'}
              </h2>
              <p class="text-sm text-slate-500 mt-1">
                ${isArH ? 'وصل' : 'Receipt'} ${receipt.serialNumber ? '#' + receipt.serialNumber : ''} ${isArH ? 'للعميل' : 'for'} ${Security.escapeHtml(customer?.name || (isArH ? 'غير معروف' : 'Unknown'))}
              </p>
            </div>
            <button onclick="document.getElementById('edit-history-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between mb-3">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="shrink-0 text-xs font-bold text-white bg-amber-500 px-2 py-1 rounded-full">${isArH ? 'تعديل' : 'Edit'} #${editHistory.length - idx}</span>
                  <span class="truncate text-xs text-slate-500">${Security.escapeHtml(edit.editedBy || (isArH ? 'غير معروف' : 'Unknown'))}</span>
                </div>
                <span class="text-xs text-slate-400">${new Date(edit.editedAt).toLocaleString(appDateLocale())}</span>
              </div>

              <div class="space-y-2">
                ${edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="min-w-0 flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(_adEditHistoryText(change.field, 'Field'))}</span>
                      <div class="flex flex-wrap items-center mt-1 gap-2 text-xs">
                        <span class="max-w-full break-words px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${Security.escapeHtml(_adEditHistoryText(change.from))}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 shrink-0 text-slate-400"></i>
                        <span class="max-w-full break-words px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${Security.escapeHtml(_adEditHistoryText(change.to))}</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            ${isArH ? `الإجمالي: ${editHistory.length} ${editHistory.length > 1 ? 'تعديلات' : 'تعديل'}` : `Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''}`} •
            ${isArH ? 'تاريخ الإنشاء' : 'Created'}: ${new Date(receipt.createdAt).toLocaleString(appDateLocale())}
          </p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal first
  document.getElementById('edit-history-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons in the new modal
  lucide.createIcons();
}

function _adEditHistoryText(value, fallback = '—') {
  if (value === null || value === undefined) return fallback;
  let text;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  text = String(text || '').trim();
  return text ? text.slice(0, 500) : fallback;
}

// Normalize legacy/imported rows before rendering. Older data can use
// date/userName/oldValue/newValue, and a malformed row must never break the
// whole Ads screen.
function _isLegacyMetaSyncHistoryRow(row) {
  const actor = String(row?.editedBy || row?.userName || row?.actorName || '').trim().toLowerCase();
  return actor.startsWith('meta automatic') || String(row?.source || '').toLowerCase().startsWith('meta_');
}

function _normalizeAdHistoryRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => {
      const rawChanges = Array.isArray(row.changes) ? row.changes : [];
      const changes = rawChanges.map(change => {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          return {
            field: 'Change',
            from: '—',
            to: _adEditHistoryText(change)
          };
        }
        return {
          field: _adEditHistoryText(change.field || change.label, 'Change'),
          from: _adEditHistoryText(change.from ?? change.oldValue ?? change.before),
          to: _adEditHistoryText(change.to ?? change.newValue ?? change.after)
        };
      });
      return {
        editedAt: row.editedAt || row.date || row.updatedAt || '',
        editedBy: _adEditHistoryText(row.editedBy || row.userName || row.actorName, 'Unknown'),
        changes,
        source: _adEditHistoryText(row.source, ''),
        eventId: _adEditHistoryText(row.eventId, ''),
        eventType: _adEditHistoryText(row.eventType, ''),
        objectId: _adEditHistoryText(row.objectId, ''),
        objectType: _adEditHistoryText(row.objectType, ''),
        tool: _adEditHistoryText(row.tool, '')
      };
    });
}

function getAdEditHistoryEntries(ad) {
  const rows = Array.isArray(ad?.editHistory) ? ad.editHistory : [];
  return _normalizeAdHistoryRows(rows.filter(row => !_isLegacyMetaSyncHistoryRow(row)));
}

function getMetaAdHistoryEntries(ad) {
  const dedicated = Array.isArray(ad?.metaChangeHistory) ? ad.metaChangeHistory : [];
  const legacy = (Array.isArray(ad?.editHistory) ? ad.editHistory : []).filter(_isLegacyMetaSyncHistoryRow);
  const seen = new Set();
  return _normalizeAdHistoryRows([...dedicated, ...legacy])
    .filter(row => {
      const key = row.eventId || `${row.editedAt}|${row.editedBy}|${JSON.stringify(row.changes)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const a = new Date(left.editedAt).getTime();
      const b = new Date(right.editedAt).getTime();
      return (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
    });
}

// Who turned a Meta-imported draft into a real ad, for showing on the ads list
// without opening the ad. An imported row is created by the automation, so its
// "Created by" is the importer, never a person — this answers "who did the
// setup?".
//
// The server stamps metaImportCompletedBy inside the guarded
// needs_completion -> complete transition. Ads completed BEFORE that stamp
// existed fall back to their own history: the first human edit of a draft IS
// the completion. Meta's sync rows are excluded, so an automatic budget or
// spend update is never mistaken for a person.
function getAdCompletedByName(ad) {
  if (!ad || typeof ad !== 'object') return '';
  const stampedId = String(ad.metaImportCompletedBy || '').trim();
  if (stampedId) {
    const user = (state.users || []).find(item => String(item?.id || '') === stampedId);
    if (user?.name) return String(user.name).trim();
  }
  const stampedName = String(ad.metaImportCompletedByName || '').trim();
  if (stampedName) return stampedName;
  // Only imported rows have a completion step worth naming.
  const wasImported = !!ad.metaImportState || !!ad.metaImportedAt
    || String(ad.metaImportSource || '').trim() !== '';
  if (!wasImported) return '';
  let earliest = null;
  for (const entry of getAdEditHistoryEntries(ad)) {
    const by = String(entry?.editedBy || '').trim();
    if (!by || by.toLowerCase() === 'unknown') continue;
    const at = new Date(entry?.editedAt).getTime();
    const rank = Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
    if (!earliest || rank < earliest.rank) earliest = { by, rank };
  }
  return earliest ? earliest.by : '';
}

function getAdEditHistoryCount(ad) {
  const detailedCount = getAdEditHistoryEntries(ad).length;
  if (detailedCount > 0) return detailedCount;
  if (Array.isArray(ad?.editHistory) && ad.editHistory.length > 0) return 0;
  const storedCount = Number(ad?.editCount);
  return Number.isSafeInteger(storedCount) && storedCount > 0 ? storedCount : 0;
}

function getMetaAdHistoryCount(ad) {
  const detailedCount = getMetaAdHistoryEntries(ad).length;
  if (detailedCount > 0) return detailedCount;
  const storedCount = Number(ad?.metaChangeCount);
  return Number.isSafeInteger(storedCount) && storedCount > 0 ? storedCount : 0;
}

function _formatAdEditHistoryDate(value, isAr) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? (isAr ? 'تاريخ غير معروف' : 'Unknown date')
    : date.toLocaleString(appDateLocale());
}

// Show ad edit history modal
function showAdEditHistory(adId) {
  const ad = state.ads.find(a => String(a.id || '') === String(adId || ''));
  if (!ad) return;

  const isArH = state.language === 'ar';
  const editHistory = getAdEditHistoryEntries(ad);
  if (editHistory.length === 0) {
    const legacyCount = getAdEditHistoryCount(ad);
    showNotification(
      isArH ? 'سجل التعديلات' : 'Edit History',
      legacyCount > 0
        ? (isArH ? 'عدد التعديلات محفوظ، لكن تفاصيل هذا السجل القديم غير متاحة.' : 'An edit count exists, but details for this older record are unavailable.')
        : (isArH ? 'لا يوجد سجل تعديلات لهذا الإعلان.' : 'No edit history recorded for this ad.'),
      'info'
    );
    return;
  }

  const customer = state.customers.find(c => c.id === ad.customerId);
  const page = state.pages.find(p => p.id === ad.pageId);
  const createdLabel = _formatAdEditHistoryDate(ad.createdAt, isArH);

  const modalHTML = `
    <div id="edit-history-modal" role="dialog" aria-modal="true" aria-labelledby="ad-edit-history-title" class="mobile-dialog-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-4 sm:p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h2 id="ad-edit-history-title" class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-purple-500"></i>
                ${isArH ? 'سجل التعديلات' : 'Edit History'}
              </h2>
              <p class="text-sm text-slate-500 mt-1 truncate">
                ${isArH ? 'إعلان للعميل' : 'Ad for'} ${Security.escapeHtml(customer?.name || ad.customerName || (isArH ? 'غير معروف' : 'Unknown'))} • ${Security.escapeHtml(page?.name || (isArH ? 'صفحة غير معروفة' : 'Unknown Page'))}
              </p>
            </div>
            <button type="button" onclick="document.getElementById('edit-history-modal').remove()" class="min-h-11 min-w-11 inline-flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors" aria-label="${isArH ? 'إغلاق سجل التعديلات' : 'Close edit history'}">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>

        <div class="p-4 sm:p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="shrink-0 text-xs font-bold text-white bg-purple-500 px-2 py-1 rounded-full">${isArH ? 'تعديل' : 'Edit'} #${editHistory.length - idx}</span>
                  <span class="truncate text-xs text-slate-500">${Security.escapeHtml(edit.editedBy)}</span>
                </div>
                <span class="text-xs text-slate-400">${Security.escapeHtml(_formatAdEditHistoryDate(edit.editedAt, isArH))}</span>
              </div>

              <div class="space-y-2">
                ${edit.changes.length ? edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="min-w-0 flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(change.field)}</span>
                      <div class="flex flex-wrap items-center mt-1 gap-2 text-xs">
                        <span class="max-w-full break-words px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${Security.escapeHtml(change.from)}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 shrink-0 text-slate-400"></i>
                        <span class="max-w-full break-words px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${Security.escapeHtml(change.to)}</span>
                      </div>
                    </div>
                  </div>
                `).join('') : `
                  <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-xs text-slate-500">
                    ${isArH ? 'لم تُحفظ تفاصيل الحقول لهذا التعديل القديم.' : 'No field details were saved for this older edit.'}
                  </div>
                `}
              </div>
            </div>
          `).join('')}
        </div>

        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            ${isArH ? `الإجمالي: ${editHistory.length} ${editHistory.length > 1 ? 'تعديلات' : 'تعديل'}` : `Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''}`} •
            ${isArH ? 'تاريخ الإنشاء' : 'Created'}: ${Security.escapeHtml(createdLabel)}
          </p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('edit-history-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  lucide.createIcons();
}

function showMetaAdHistory(adId) {
  const ad = state.ads.find(a => String(a.id || '') === String(adId || ''));
  if (!ad) return;
  const isAr = state.language === 'ar';
  const history = getMetaAdHistoryEntries(ad);
  const account = String(ad.metaAdAccountName || '').trim() || (ad.metaAdAccountId ? `#${ad.metaAdAccountId}` : (isAr ? 'حساب Meta' : 'Meta account'));
  const emptyText = isAr
    ? 'لا توجد تغييرات Meta محفوظة بعد. ستظهر التغييرات هنا بعد اكتشافها في المزامنة.'
    : 'No Meta changes are saved yet. Changes will appear here after synchronization detects them.';
  const rows = history.length ? history.slice().reverse().map((entry, index) => {
    const exactActivity = entry.source === 'meta_activity';
    const sourceLabel = exactActivity
      ? (isAr ? 'سجل نشاط Meta' : 'Meta activity')
      : (entry.source === 'meta_import' ? (isAr ? 'استيراد Meta' : 'Meta import') : (isAr ? 'اكتشفته المزامنة' : 'Detected by sync'));
    const eventLabel = entry.eventType ? entry.eventType.split('_').join(' ') : '';
    return `<article class="rounded-xl border border-blue-100 bg-blue-50/40 p-3 dark:border-blue-900 dark:bg-blue-950/20 sm:p-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="rounded-full bg-blue-600 px-2 py-1 text-[10px] font-black text-white">${isAr ? 'تغيير' : 'Change'} #${history.length - index}</span><span class="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">${sourceLabel}</span></div><p class="mt-2 break-words text-xs font-bold text-slate-700 dark:text-slate-200">${Security.escapeHtml(entry.editedBy)}</p></div>
        <time class="text-xs text-slate-500">${Security.escapeHtml(_formatAdEditHistoryDate(entry.editedAt, isAr))}</time>
      </div>
      ${(eventLabel || entry.tool) ? `<div class="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500">${eventLabel ? `<span>${Security.escapeHtml(eventLabel)}</span>` : ''}${entry.tool ? `<span>• ${Security.escapeHtml(entry.tool)}</span>` : ''}</div>` : ''}
      <div class="mt-3 space-y-2">${entry.changes.length ? entry.changes.map(change => `<div class="rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900"><div class="font-bold text-slate-700 dark:text-slate-200">${Security.escapeHtml(change.field)}</div><div class="mt-2 flex flex-wrap items-center gap-2 text-xs"><span class="max-w-full break-words rounded bg-rose-100 px-2 py-1 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">${Security.escapeHtml(change.from)}</span><i data-lucide="arrow-right" class="h-3 w-3 shrink-0 text-slate-400"></i><span class="max-w-full break-words rounded bg-emerald-100 px-2 py-1 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">${Security.escapeHtml(change.to)}</span></div></div>`).join('') : `<p class="text-xs text-slate-500">${isAr ? 'تفاصيل هذا التغيير القديم غير متاحة.' : 'Details for this older change are unavailable.'}</p>`}</div>
    </article>`;
  }).join('') : `<div class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">${emptyText}</div>`;

  document.getElementById('meta-history-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div id="meta-history-modal" role="dialog" aria-modal="true" aria-labelledby="meta-history-title" class="mobile-dialog-overlay fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-4" onclick="if(event.target === this) this.remove()">
    <div class="flex max-h-[88dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onclick="event.stopPropagation()" dir="${isAr ? 'rtl' : 'ltr'}">
      <header class="flex items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-700 sm:p-5"><div class="min-w-0"><h2 id="meta-history-title" class="flex items-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i data-lucide="history" class="h-5 w-5 text-blue-600"></i>${isAr ? 'سجل تغييرات Meta' : 'Meta Change History'}</h2><p class="mt-1 break-words text-sm text-slate-500">${Security.escapeHtml(ad.metaAdName || `Meta #${ad.metaAdId || ''}`)} • ${Security.escapeHtml(account)}</p></div><button type="button" onclick="document.getElementById('meta-history-modal').remove()" class="touch-target inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button></header>
      <div class="overflow-y-auto p-3 sm:p-5"><div class="mb-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"><strong>${isAr ? 'مهم:' : 'Important:'}</strong> ${isAr ? 'يعرض هذا السجل نشاط Meta الدقيق عندما تسمح به الصلاحيات، ويستخدم مقارنة المزامنة كنسخة احتياطية.' : 'This history uses exact Meta activity when permissions allow it, with synchronization comparison as a safe fallback.'}</div><div class="space-y-3">${rows}</div></div>
      <footer class="border-t border-slate-200 bg-slate-50 px-4 py-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950/50">${isAr ? 'الإجمالي' : 'Total'}: ${history.length}</footer>
    </div>
  </div>`);
  lucide.createIcons();
}

// A response can be lost after the server commits. Keep the same target
// receipt id and idempotency key for an identical retry, and clear them only
// after both authoritative receipt envelopes have been validated and applied.
const _pendingReceiptTransferAttempts = new Map();

function getReceiptTransferAttempt(sourceReceipt, targetCustomerId, amountMinorUSD, note) {
  const sourceReceiptId = String(sourceReceipt?.id || '');
  const expectedSourceLastModified = Number(sourceReceipt?._lastModified);
  if (!Number.isSafeInteger(expectedSourceLastModified) || expectedSourceLastModified < 0) {
    throw new Error('This receipt is missing its server version. Refresh and try again.');
  }
  const slot = sourceReceiptId;
  const fingerprint = JSON.stringify({
    sourceReceiptId,
    targetCustomerId: String(targetCustomerId || ''),
    amountMinorUSD,
    expectedSourceLastModified,
    note: String(note || '')
  });
  const prior = _pendingReceiptTransferAttempts.get(slot);
  if (prior?.fingerprint === fingerprint) return prior;
  if (prior?.promise) return prior;
  const attempt = {
    slot,
    fingerprint,
    targetReceiptId: Security.generateSecureId('receipt'),
    idempotencyKey: ensureOperationIdempotencyKey('', 'receipt-transfer'),
    expectedSourceLastModified,
    promise: null
  };
  _pendingReceiptTransferAttempts.set(slot, attempt);
  return attempt;
}

function completeReceiptTransferAttempt(attempt) {
  if (attempt && _pendingReceiptTransferAttempts.get(attempt.slot) === attempt) {
    _pendingReceiptTransferAttempts.delete(attempt.slot);
  }
}

// Persist a transfer from receipt to another customer
async function saveReceiptTransfer() {
  const receiptId = state.modalData?.id;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  // Defense in depth: the modal opener already blocks this, but the save must
  // never mint spendable money from an unpaid/canceled receipt.
  if (!_isTransferableReceipt(receipt)) {
    showNotification(
      state.language === 'ar' ? 'غير ممكن' : 'Not possible',
      state.language === 'ar' ? 'يمكن تحويل الرصيد من الوصولات المدفوعة فقط.' : 'Balance can only be transferred from paid receipts.',
      'error'
    );
    return;
  }

  const targetCustomerEl = document.getElementById('transfer-target-customer');
  const amountUSDElement = document.getElementById('transfer-amount-usd');
  const noteElement = document.getElementById('transfer-note');
  if (!targetCustomerEl || !amountUSDElement) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'لم يتم العثور على عناصر نموذج التحويل' : 'Transfer form elements not found', 'error');
    return;
  }
  const targetCustomerId = targetCustomerEl.value;
  const amountUSD = parseFloat(amountUSDElement.value) || 0;
  const note = noteElement?.value || '';

  const isArTr = state.language === 'ar';
  if (!targetCustomerId) {
    showNotification(isArTr ? 'خطأ في الإدخال' : 'Validation', isArTr ? 'الرجاء اختيار عميل للتحويل إليه.' : 'Please choose a customer to transfer to.', 'error');
    return;
  }
  if (amountUSD <= 0) {
    showNotification(isArTr ? 'خطأ في الإدخال' : 'Validation', isArTr ? 'يجب أن يكون مبلغ التحويل أكبر من صفر.' : 'Transfer amount must be greater than zero.', 'error');
    return;
  }

  const usage = getReceiptUsageStats(receipt);
  if (amountUSD > usage.remainingUSD) {
    showNotification(isArTr ? 'خطأ في الإدخال' : 'Validation', isArTr ? 'المبلغ يتجاوز الرصيد المتاح.' : 'Amount exceeds available balance.', 'error');
    return;
  }

  const amountMinorUSD = Math.round(amountUSD * 100);
  if (!Number.isSafeInteger(amountMinorUSD) || amountMinorUSD <= 0) {
    showNotification(isArTr ? 'خطأ في الإدخال' : 'Validation', isArTr ? 'مبلغ التحويل غير صالح.' : 'Transfer amount is invalid.', 'error');
    return;
  }

  let serverAttempt = null;
  if (isServerModeEnabled()) {
    try {
      serverAttempt = getReceiptTransferAttempt(receipt, targetCustomerId, amountMinorUSD, note);
    } catch (error) {
      showNotification(isArTr ? 'تعذر التحويل' : 'Transfer Not Saved', error.message, 'error');
      return;
    }
  }

  const rate = receipt.exchangeRate || state.defaultExchangeRate || 1;
  const nowIso = new Date().toISOString();
  const amountLocal = Math.round(amountUSD * rate * 100) / 100;
  // Destination customer's display NAME (never phone/contact) for the local
  // path: stamped onto the target receipt and onto the transfer row rendered on
  // the source receipt card, so a receipts-only role can read who received the
  // transfer. Server mode stamps both authoritatively in the transfer endpoint.
  const _transferToName = String((state.customers || []).find(c => c && String(c.id) === String(targetCustomerId))?.name || '');

  // MONEY-MATH FIX: the transfer must actually ARRIVE somewhere. Previously it
  // only reduced the source receipt's remaining (via transfers[]) — the target
  // customer received nothing usable, so the money effectively vanished (it
  // never appeared in their Receipt Funding options when creating an ad).
  // Now every transfer creates a REAL receipt for the receiving customer,
  // typed TRANSFER_IN and linked back to the source. Accounting stays balanced:
  // source remaining goes down by X, target gains a receipt worth X.
  const inReceipt = {
    id: serverAttempt?.targetReceiptId || generateId('receipt'),
    recordType: 'receipt',
    customerId: targetCustomerId,
    customerName: _transferToName || undefined,
    amountUSD: Math.round(amountUSD * 100) / 100,
    exchangeRate: rate,
    amountLocal,
    status: 'Paid',
    isPaid: true,
    paymentMethod: 'Transfer',
    receiptType: 'TRANSFER_IN',
    transferFromReceiptId: receipt.id,
    transferFromCustomerId: receipt.customerId,
    serialNumber: '',
    payments: [],
    phoneNumber: '',
    // Starts NOT collected (user request): collection is an explicit action
    // the admin records, same as any other receipt.
    collected: false,
    deliveryStatus: 'Office',
    isReceivedInOffice: true,
    startDate: nowIso,
    endDate: nowIso,
    collectionDate: nowIso,
    createdAt: nowIso,
    note: note || ''
  };

  const transfer = {
    id: generateId('transfer'),
    toCustomerId: targetCustomerId,
    toCustomerName: _transferToName || undefined,
    toReceiptId: inReceipt.id,
    amountUSD,
    amountLocal,
    date: nowIso,
    note
  };

  if (serverAttempt) {
    if (serverAttempt.promise) return await serverAttempt.promise;
    const submitButton = document.getElementById('receipt-transfer-submit');
    if (submitButton) submitButton.disabled = true;
    serverAttempt.promise = (async () => {
      try {
        const response = await apiTransferReceipt({
          sourceReceiptId: receipt.id,
          targetCustomerId,
          targetReceiptId: serverAttempt.targetReceiptId,
          amountMinorUSD,
          idempotencyKey: serverAttempt.idempotencyKey,
          expectedSourceLastModified: serverAttempt.expectedSourceLastModified,
          note
        });
        const [savedSource, savedTarget] = applyValidatedServerEntityBatch([
          { collection: 'receipts', entity: response.sourceReceipt },
          { collection: 'receipts', entity: response.targetReceipt }
        ], 'receiptTransfer');
        if (!savedSource || !savedTarget) throw new Error('Invalid receipt transfer response');
        completeReceiptTransferAttempt(serverAttempt);
        addLog('transfer', 'receipt', savedSource.id, `Transferred $${amountUSD.toFixed(2)} to customer (receipt ${savedTarget.id})`, { toCustomerId: targetCustomerId, toReceiptId: savedTarget.id });
        const targetName = state.customers.find(c => c.id === targetCustomerId)?.name || '';
        showNotification(
          state.language === 'ar' ? 'تم التحويل' : 'Transferred',
          state.language === 'ar'
            ? `تم تحويل $${amountUSD.toFixed(2)} إلى ${targetName} — أُنشئ وصل تحويل جاهز للاستخدام.`
            : `Transferred $${amountUSD.toFixed(2)} to ${targetName} — a transfer receipt was created and is ready to use.`,
          'success'
        );
        closeModal();
        render();
        return true;
      } catch (error) {
        const conflict = isVersionConflict409(error);
        showNotification(
          isArTr ? 'تعذر التحويل' : 'Transfer Not Saved',
          error?.status === 409
            ? describe409(error, isArTr ? 'تم تغيير هذا الوصل من مستخدم آخر. حدّث البيانات ثم أعد المحاولة.' : 'This receipt changed on another device. Refresh the data, then try again.')
            : (error?.message || (isArTr ? 'فشل حفظ التحويل.' : 'The transfer could not be saved.')),
          conflict ? 'warning' : 'error'
        );
        return false;
      } finally {
        serverAttempt.promise = null;
        const liveButton = document.getElementById('receipt-transfer-submit');
        if (liveButton) liveButton.disabled = false;
      }
    })();
    return await serverAttempt.promise;
  }

  const targetSaved = await addRecord(state.receipts, inReceipt);
  if (!targetSaved) return;
  const updatedTransfers = [...(receipt.transfers || []), transfer];
  const sourceSaved = await updateRecord(state.receipts, receipt.id, { transfers: updatedTransfers });
  if (!sourceSaved) {
    // Local-device storage has no transaction API. Best-effort compensation
    // prevents the created target receipt from minting money if source save
    // fails. Server mode never enters this two-write path.
    await deleteRecord(state.receipts, inReceipt.id);
    return;
  }
  addLog('transfer', 'receipt', receipt.id, `Transferred $${amountUSD.toFixed(2)} to customer (receipt ${inReceipt.id})`, { toCustomerId: targetCustomerId, toReceiptId: inReceipt.id });
  const targetName = state.customers.find(c => c.id === targetCustomerId)?.name || '';
  showNotification(
    state.language === 'ar' ? 'تم التحويل' : 'Transferred',
    state.language === 'ar'
      ? `تم تحويل $${amountUSD.toFixed(2)} إلى ${targetName} — أُنشئ وصل تحويل جاهز للاستخدام.`
      : `Transferred $${amountUSD.toFixed(2)} to ${targetName} — a transfer receipt was created and is ready to use.`,
    'success'
  );
  closeModal();
  render();
}

function addSplitPayment() {
  const container = document.getElementById('split-payments-container');
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
  const isArSp = state.language === 'ar';

  const div = document.createElement('div');
  div.className = 'split-payment-item p-4 rounded-lg';
  div.innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="block text-xs font-medium mb-1">${isArSp ? 'طريقة الدفع' : 'Payment Method'}</label>
        <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
          ${PAYMENT_METHODS.map(m => `<option value="${m}">${trMethod(m)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">${isArSp ? 'المبلغ (LYD)' : 'Amount (LYD)'}</label>
        <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" oninput="sanitizeMoneyInput(this)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">${isArSp ? 'سعر الصرف' : 'Exchange Rate'}</label>
        <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">${isArSp ? 'سعر الدولار (سعر 2)' : 'USD Rate (Rate 2)'}</label>
        <input type="text" inputmode="decimal" class="split-rate2 w-full glass-input px-3 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">${isArSp ? 'نوع التحصيل' : 'Collection Type'}</label>
        <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
          <option value="office">${trStatus('office')}</option>
          <option value="delivery">${trStatus('delivery')}</option>
          <option value="bank">${trStatus('bank')}</option>
        </select>
      </div>
      ${deliveryUsers.length > 0 ? `
        <div class="col-span-2">
          <label class="block text-xs font-medium mb-1">${isArSp ? 'مندوب التوصيل (إذا كان توصيل)' : 'Delivery Person (if delivery)'}</label>
          <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
            <option value="">${trStatus('None')}</option>
            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div class="col-span-2 flex justify-end">
        <button type="button" onclick="this.closest('.split-payment-item').remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700 text-sm font-medium flex items-center space-x-1">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
          <span>${isArSp ? 'إزالة' : 'Remove'}</span>
        </button>
      </div>
    </div>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

async function saveSplitPayments() {
  // Read the target from the frozen hidden field, not the mutable global, so a
  // stray navigation can't redirect this save onto a different receipt.
  const receiptId = (document.getElementById('split-payments-receipt-id')?.value || '').trim() || state.modalData?.id;
  if (!receiptId || !state.receipts.some(r => r && !r._deleted && String(r.id) === String(receiptId))) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'تعذّر تحديد الوصل' : 'Could not identify the receipt', 'error');
    return;
  }
  // Defense-in-depth: re-check receipts.edit before writing (the modal can be
  // restored via updateUrlParams), mirroring editReceipt's canActOnRecord guard.
  const _permReceipt = state.receipts.find(r => r && String(r.id) === String(receiptId));
  if (!canActOnRecord('receipts', 'edit', _permReceipt?.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الوصولات' : 'You do not have permission to edit this receipt', 'error');
    return;
  }
  // Double-tap guard: a second Save while the first PATCH is in flight would
  // commit an identical duplicate PATCH and show a second "Saved" toast.
  const actionKey = String(receiptId);
  if (_deliveryActionInFlight.has(actionKey)) return;
  _deliveryActionInFlight.add(actionKey);
  try {
  const paymentItems = document.querySelectorAll('.split-payment-item');
  const payments = [];

  paymentItems.forEach(item => {
    const method = item.querySelector('.split-method').value;
    const amount = parseFloat(item.querySelector('.split-amount').value) || 0;
    // Rate 1 reads identically to the live preview (`|| 0`) — see the note in
    // saveReceiptFromModal. The old `|| defaultExchangeRate` fallback squared
    // the stored exchangeRate for zero-rate methods on a no-op Save.
    const rate = parseFloat(item.querySelector('.split-rate').value) || 0;
    // 0/blank Rate 2 means "no USD ads credit" (matches saveReceiptFromModal),
    // NOT "fall back to the LYD rate" — the old fallback fabricated ads credit
    // out of a zero-rate receipt on a no-op Save.
    const rate2 = parseFloat(item.querySelector('.split-rate2')?.value) || 0;
    const collectionType = item.querySelector('.split-collection').value;
    const deliveryPersonId = item.querySelector('.split-delivery-person')?.value || '';

    if (amount > 0) {
      payments.push({
        method,
        amount,
        rate,
        rate2,
        collectionType,
        deliveryPersonId
      });
    }
  });

  // Recompute the receipt totals from the edited payments using the SAME
  // logic as saveReceipt (src/14-forms.js). Previously this saved only the
  // payments array and left amountUSD/amountLocal/exchangeRate stale, so the
  // receipt's money totals no longer matched its own payment lines.
  const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  let totalR1 = 0; // Total PAID (LYD)
  let totalR2 = 0; // Total ADS CREDIT (USD)
  payments.forEach(p => {
    const r1 = p.amount * p.rate;
    let r2 = 0;
    if (p.rate2 > 0) {
      r2 = usdBasedMethods.includes(p.method) ? (r1 / p.rate2) : (p.amount / p.rate2);
      r2 = ceilingRound(r2);
    }
    totalR1 += r1;
    totalR2 += r2;
  });
  // Snap to 2 decimals first so binary float residue doesn't trip the rule.
  totalR2 = Math.round(totalR2 * 100) / 100;
  if (totalR2 % 1 !== 0) totalR2 = Math.round((totalR2 + 0.01) * 100) / 100;
  // Same rule as the receipt form: a single payment stores the rate the user
  // typed; a split stores the effective average.
  const avgRate = receiptExchangeRate(payments, totalR1, totalR2);

  // Money already committed cannot be edited away: ads funded from this
  // receipt plus money transferred to other customers set the floor for the
  // new total. Below it, ads/transfers would hold money the receipt no longer
  // contains.
  const committedStats = getReceiptUsageStats(state.receipts.find(r => r.id === receiptId));
  const committedUSD = Math.round(((committedStats.usedUSD || 0) + (committedStats.transferredUSD || 0)) * 100) / 100;
  if (totalR2 < committedUSD - 0.01) {
    showNotification(
      state.language === 'ar' ? 'غير ممكن' : 'Not possible',
      state.language === 'ar'
        ? `$${committedUSD.toFixed(2)} من هذا الوصل مستخدمة بالفعل (إعلانات وتحويلات) — لا يمكن خفض الإجمالي إلى $${totalR2.toFixed(2)}. حرِّر المبلغ أولاً (عدِّل/أوقف الإعلانات أو احذف التحويل).`
        : `$${committedUSD.toFixed(2)} of this receipt is already used (ads + transfers) — the total cannot go down to $${totalR2.toFixed(2)}. Free the money first (edit/stop the ads or delete the transfer).`,
      'error'
    );
    return;
  }

  // Keep the receipt NUMBER consistent with the new method mix — the main
  // receipt form enforces this (syncReceiptSerialWithPaymentMethods), but this
  // editor bypassed it, orphaning auto-serials and colliding the next number.
  const _existing = state.receipts.find(r => r.id === receiptId);
  const _curSerial = String(_existing?.serialNumber || '').trim().toUpperCase();
  const _methods = payments.map(p => p.method).filter(Boolean);
  const _anyManual = _methods.some(m => !getAutoSerialPrefix(m));
  const _autoMethod = _anyManual ? null : _methods.find(m => getAutoSerialPrefix(m));
  const _serialUpdate = {};
  if (_autoMethod) {
    const _prefix = getAutoSerialPrefix(_autoMethod);
    const _inThisGroup = isAutoSerialNumber(_curSerial) && _curSerial.startsWith(_prefix);
    const _legacyS = _prefix === 'S' && /^\d+$/.test(_curSerial);
    if (!_inThisGroup && !_legacyS) {
      const _next = getNextAutoSerialNumber(_autoMethod);
      if (_next) { _serialUpdate.serialNumber = _next; _serialUpdate.finalReceiptNo = _next; }
    }
  } else if (isAutoSerialNumber(_curSerial)) {
    // Now includes a manual (Cash) method but the stored number is an app-issued
    // auto-serial. A paper number can't be entered here — send the user to the
    // full Edit Receipt form instead of leaving a mismatched number.
    showNotification(
      state.language === 'ar' ? 'غير ممكن هنا' : 'Not here',
      state.language === 'ar'
        ? 'تغيير الطريقة إلى نقدي يحتاج رقم وصل ورقي — غيّر طرق الدفع من نموذج تعديل الوصل الكامل.'
        : 'Switching to a cash method needs a paper receipt number — change payment methods from the full Edit Receipt form.',
      'error'
    );
    return;
  }

  // Pass the modal-open snapshot as the conflict baseline so a concurrent edit
  // (another user, or a driver completing the delivery) 409s + reloads instead
  // of being silently overwritten. state.modalData is the frozen open-time
  // object (live-sync replaces the array slot, not state.modalData).
  const _splitOpenLastMod = (state.modalData && String(state.modalData.id) === String(receiptId))
    ? state.modalData._lastModified
    : _existing?._lastModified;
  const savedOk = await updateRecord(state.receipts, receiptId, {
    payments,
    // The top-level method is DERIVED from the rows — without this it kept the
    // method the receipt was created with and contradicted its own payments
    // (breaking the receipts payment-method filter and the printed receipt).
    paymentMethod: payments.length > 1
      ? 'Split Payment'
      : (payments[0]?.method || ''),
    amountLocal: totalR1,
    amountUSD: totalR2,
    exchangeRate: avgRate,
    ..._serialUpdate
  }, _splitOpenLastMod);
  if (!savedOk) return;
  showNotification(state.language === 'ar' ? 'تم الحفظ' : 'Saved', state.language === 'ar' ? 'تم حفظ الدفعات المقسمة بنجاح' : 'Split payments saved successfully', 'success');
  closeModal();
  render();
  } finally {
    _deliveryActionInFlight.delete(actionKey);
  }
}

// Top-ups management functions
let tempTopUps = [];

// Read whatever the user typed in the Add New Top-up form. Returns a top-up
// entry ({date, amount, extendDays, note}) or null when the form is empty.
// Shared by the "Add Top-up" button AND saveTopUps — previously an amount that
// was typed but not explicitly "Add"ed was SILENTLY DROPPED on Save, which
// made the whole feature look broken.
function _readTopUpForm() {
  const amountEl = document.getElementById('topup-amount');
  if (!amountEl) return null;
  const amount = parseFloat(amountEl.value) || 0;
  const extendDays = parseInt(document.getElementById('topup-extend-days')?.value, 10) || 0;
  if (amount <= 0 && extendDays <= 0) return null;
  const date = document.getElementById('topup-date')?.value;
  return {
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    amount: amount > 0 ? amount : 0,
    extendDays: extendDays > 0 ? extendDays : 0,
    note: document.getElementById('topup-note')?.value || 'Top-up'
  };
}

// Which receipts fund this ad and how much money they still hold. Top-up
// money is drawn FROM these receipts, so this drives the "Available" line in
// the top-ups modal and the overdraft guard. Returns null for ads that are
// not receipt-funded (unpaid ads owe money instead of spending receipt
// balance) — their top-ups keep the old free-form behavior.
function getAdFundingAvailability(ad) {
  if (!ad) return null;
  if (getAdPaymentState(ad) !== 'paid') return null;
  const ids = [];
  if (Array.isArray(ad.receiptAllocations)) {
    ad.receiptAllocations.forEach(a => { if (a && a.receiptId) ids.push(String(a.receiptId)); });
  }
  if (ad.fundingReceiptId) ids.push(String(ad.fundingReceiptId));
  if (ad.receiptId) ids.push(String(ad.receiptId));
  const perReceipt = [];
  let totalRemaining = 0;
  [...new Set(ids)].forEach(id => {
    // Skip soft-deleted receipts: a ghost receipt holds no spendable money,
    // so it must not count as "available" nor be charged by a top-up.
    const receipt = (state.receipts || []).find(r => r && !r._deleted && String(r.id) === id);
    if (!receipt) return;
    const remaining = Math.max(getReceiptUsageStats(receipt).remainingUSD || 0, 0);
    perReceipt.push({ receipt, remaining });
    totalRemaining += remaining;
  });
  if (!perReceipt.length) return null;
  return {
    totalRemaining: Math.round(totalRemaining * 100) / 100,
    perReceipt,
    hasAllocations: Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length > 0
  };
}

// Receipt money still available given the modal's working list. The saved
// top-ups are already inside each receipt's remaining balance, so only the
// DIFFERENCE between the working list and what's saved moves the number
// (removing a saved top-up makes money available again). Returns null when
// the ad isn't receipt-funded.
function _topUpAvailableNow(workingList) {
  const ad = state.ads.find(a => a.id === state.modalData?.id);
  const funding = getAdFundingAvailability(ad);
  if (!funding) return null;
  const savedTotal = (ad.topUps || []).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const workingTotal = (workingList || tempTopUps).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  return Math.round((funding.totalRemaining - (workingTotal - savedTotal)) * 100) / 100;
}

// Live preview (user request): while typing in the Add New Top-up form the
// Ad Details numbers update immediately — new total, new END DATE and how
// much receipt money stays available — so nothing is a surprise after saving.
function _refreshTopUpPreview() {
  const ad = state.ads.find(a => a.id === state.modalData?.id);
  if (!ad) return;
  const isAr = state.language === 'ar';
  const typedAmount = Math.max(parseFloat(document.getElementById('topup-amount')?.value) || 0, 0);
  const typedDays = Math.max(parseInt(document.getElementById('topup-extend-days')?.value, 10) || 0, 0);

  const base = parseFloat(ad.initialAmountUSD || ad.amountUSD) || 0;
  const workingTotal = tempTopUps.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0) + typedAmount;
  const newEl = document.getElementById('topup-preview-new');
  if (newEl) newEl.textContent = `$${(base + workingTotal).toFixed(2)}`;

  const baseEnd = ad.initialEndDate || ad.endDate || '';
  const endEl = document.getElementById('topup-preview-end');
  const endExtraEl = document.getElementById('topup-preview-end-extra');
  if (endEl && baseEnd && !isNaN(new Date(baseEnd).getTime())) {
    const days = tempTopUps.reduce((s, t) => s + (parseInt(t.extendDays, 10) || 0), 0) + typedDays;
    endEl.textContent = new Date(new Date(baseEnd).getTime() + days * 86400000).toLocaleDateString(appDateLocale());
    if (endExtraEl) {
      endExtraEl.textContent = days > 0
        ? (isAr ? `(الأصلية ${new Date(baseEnd).toLocaleDateString(appDateLocale())} + ${days} يوم)` : `(original ${new Date(baseEnd).toLocaleDateString(appDateLocale())} + ${days} day${days > 1 ? 's' : ''})`)
        : '';
    }
  }

  const availEl = document.getElementById('topup-preview-available');
  if (availEl) {
    const avail = _topUpAvailableNow(tempTopUps);
    if (avail !== null) {
      const after = Math.round((avail - typedAmount) * 100) / 100;
      availEl.textContent = `$${after.toFixed(2)}`;
      availEl.className = after < -0.009 ? 'text-rose-600' : (after < 0.01 ? 'text-amber-600' : 'text-emerald-600');
    }
  }
}

function addNewTopUp() {
  const entry = _readTopUpForm();
  if (entry === null && !document.getElementById('topup-amount')) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'لم يتم العثور على عناصر نموذج التعبئة' : 'Top-up form elements not found', 'error');
    return;
  }
  if (!entry) {
    showNotification(
      state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation',
      state.language === 'ar' ? 'أدخل مبلغاً أو عدد أيام تمديد' : 'Enter an amount or extension days',
      'error'
    );
    return;
  }
  // Balance guard (user request): a top-up spends MORE of the customer's
  // receipt money, so it cannot exceed what the funding receipts still hold.
  if (entry.amount > 0) {
    const available = _topUpAvailableNow(tempTopUps);
    if (available !== null && entry.amount > available + 0.01) {
      showNotification(
        state.language === 'ar' ? 'رصيد غير كافٍ' : 'Not enough balance',
        state.language === 'ar'
          ? `المتبقي في وصولات التمويل $${available.toFixed(2)} فقط — لا يمكن إضافة $${entry.amount.toFixed(2)}`
          : `The funding receipt(s) only have $${available.toFixed(2)} left — cannot add $${entry.amount.toFixed(2)}`,
        'error'
      );
      return;
    }
  }
  tempTopUps.push(entry);
  // Re-render modal to show new top-up
  renderModal();
}

function removeTopUp(index) {
  tempTopUps.splice(index, 1);
  renderModal();
}

// ==========================================
// HTTP 409 DISAMBIGUATION (atomic money endpoints)
// ==========================================
// The server reuses status 409 for two very different refusals:
//   1. Optimistic-lock version conflicts — the detail always starts with
//      "Conflict:" ("Conflict: ad has changed", "Conflict: source receipt
//      has changed", ...). Only these mean "someone else changed it".
//   2. Business-rule refusals ("A terminal or refunded ad cannot be
//      edited/stopped", "Idempotency key was already used", ...).
// The catches used to label EVERY 409 as "changed on another device", which
// sent a single-user admin chasing a phantom concurrent editor and told them
// to refresh — advice that can never fix a rule refusal. Keep the conflict
// wording strictly for case 1 and surface the server's real reason
// (localized where known) for everything else.
function isVersionConflict409(error) {
  return error?.status === 409 && /^conflict:/i.test(String(error?.message || '').trim());
}

function describe409(error, conflictText) {
  if (isVersionConflict409(error)) return conflictText;
  const detail = String(error?.message || '');
  if (/destroyed receipt is locked/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل تالف ورقمه مقفول — لا يمكن تغييره. احذف السجل إذا أردت تحرير الرقم.'
      : 'This receipt is destroyed and its number is locked — it cannot be changed. Delete the record to free the number.';
  }
  if (/terminal or refunded ad/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الإعلان منتهٍ أو مُسترجَع، لذا لم يعد هذا التغيير ممكناً. استخدم الاسترجاع لتعديل أمواله.'
      : 'This ad is already finished or refunded, so this change is no longer allowed. Use Refund to adjust its money.';
  }
  // A receipt relink (or any ad-funding save) whose target receipt lacks the
  // balance to back the ad's spend. Name the real reason instead of the raw
  // server string, so the user knows to pick a receipt with enough credit.
  if (/insufficient (balance on receipt|in shop receipt balance|delivery due credit)/i.test(detail)) {
    return state.language === 'ar'
      ? 'الوصل الجديد لا يملك رصيداً كافياً لتغطية المبلغ المُنفَق من هذا الإعلان. اختر وصلاً برصيد كافٍ أو أضف وصلاً آخر.'
      : "The new receipt doesn't have enough available balance to cover this ad's spent amount. Choose a receipt with enough balance.";
  }
  // Receipt money-edit rules from _financial_patch_receipt_atomic. These are
  // deliberate refusals, not concurrency — refreshing can never fix them.
  if (/settled receipt's amount cannot be increased/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل تمت تسويته، لذا لا يمكن زيادة قيمته بالتعديل. مجموع الدفعات يجب أن يبقى مساوياً لقيمة الوصل الحالية.'
      : "This receipt was settled, so its value cannot be increased by editing. The payments must add up to the receipt's current value.";
  }
  if (/receipt amount is below committed ads and transfers|receipt due amount is below committed ads/i.test(detail)) {
    return state.language === 'ar'
      ? 'لا يمكن تخفيض قيمة الوصل تحت المبلغ المحجوز للإعلانات والتحويلات المرتبطة به. حرر الارتباطات أولاً أو اجعل المجموع يغطي المبلغ الملتزم به.'
      : "The receipt's value cannot go below the amount its linked ads and transfers already committed. Release those links first, or keep the total at least equal to the committed amount.";
  }
  if (/funded or transferred receipt must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل يموّل إعلانات أو تحويلات، لذا يجب أن يبقى مدفوعاً.'
      : 'This receipt funds ads or transfers, so it must remain paid.';
  }
  // Paid -> Not Paid debt-conversion refusals (server /unsettle cascade and
  // its local-mode mirror). Honest rule refusals: refreshing never fixes them.
  if (/transferred-in receipt must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل ناتج عن تحويل رصيد من وصل آخر، لذا يجب أن يبقى مدفوعاً.'
      : 'This receipt was transferred in from another receipt, so it must remain paid.';
  }
  if (/receipt with outgoing transfers must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل حوّل جزءاً من رصيده إلى عميل آخر، لذا يجب أن يبقى مدفوعاً. احذف التحويل أولاً.'
      : 'This receipt already transferred part of its balance to another customer, so it must remain paid. Delete the transfer first.';
  }
  if (/funding a finished or refunded ad must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل يموّل إعلاناً منتهياً أو مسترجَعاً، ولا يمكن إعادة كتابة تاريخه المالي — يجب أن يبقى الوصل مدفوعاً.'
      : 'This receipt funds a finished or refunded ad whose money history cannot be rewritten — the receipt must remain paid.';
  }
  if (/ad that owes another receipt must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل يموّل جزئياً إعلاناً عليه دين على وصل آخر، لذا يجب أن يبقى مدفوعاً. سوِّ دين الإعلان أولاً.'
      : "This receipt part-funds an ad that still owes debt on another receipt, so it must remain paid. Settle that ad's debt first.";
  }
  if (/legacy pre-allocation ad must remain paid/i.test(detail)) {
    return state.language === 'ar'
      ? 'هذا الوصل يموّل إعلاناً بصيغة قديمة بدون صفوف تمويل، لذا يجب أن يبقى مدفوعاً.'
      : 'This receipt funds an old-format ad without funding rows, so it must remain paid.';
  }
  return detail || conflictText;
}

async function saveTopUps() {
  const adId = state.modalData.id;
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  // Defense-in-depth: a view-only role must never persist a budget top-up via a
  // restored modal / direct call. Silent close mirrors the _isAdToppable defense
  // just below; manageTopUps already surfaces the Access Denied notification.
  if (!canActOnRecord('ads', 'edit', ad.creatorId || ad.createdBy)) { closeModal(); return; }
  // Defense-in-depth: never charge/extend a terminal or refunded ad (see
  // _isAdToppable). manageTopUps already blocks opening the modal for these.
  if (!_isAdToppable(ad)) { closeModal(); return; }
  const isArTU = state.language === 'ar';

  // Forgiving save: anything still typed in the form counts as a top-up too
  // (the user should not need to click "Add Top-up" before "Save Top-ups").
  // Built WITHOUT touching tempTopUps so a failed balance check below leaves
  // the modal's working list exactly as the user sees it.
  const pending = _readTopUpForm();
  const allTopUps = (pending ? [...tempTopUps, pending] : tempTopUps).map(t => ({ ...t }));

  // tempTopUps is the COMPLETE working list (seeded from ad.topUps on open,
  // plus/minus edits). initialAmountUSD / initialEndDate are the values BEFORE
  // any top-up, so the new totals are base + EVERY top-up — removing a top-up
  // later correctly shrinks both the amount and the end date again.
  const baseAmountUSD = ad.initialAmountUSD || ad.amountUSD;
  const totalTopUps = allTopUps.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const newAmountUSD = Math.round((baseAmountUSD + totalTopUps) * 100) / 100;

  // Balance guard (user request): top-up money comes from the receipts that
  // fund this ad — not from thin air — so the net NEW money (delta) cannot
  // exceed what those receipts still hold.
  const funding = getAdFundingAvailability(ad);
  const delta = Math.round((newAmountUSD - (parseFloat(ad.amountUSD) || 0)) * 100) / 100;
  if (funding && delta > 0.009 && delta > funding.totalRemaining + 0.01) {
    showNotification(
      isArTU ? 'رصيد غير كافٍ' : 'Not enough balance',
      isArTU
        ? `التعبئة تحتاج $${delta.toFixed(2)} والمتبقي في وصولات التمويل $${funding.totalRemaining.toFixed(2)} فقط`
        : `These top-ups need $${delta.toFixed(2)} but the funding receipt(s) only have $${funding.totalRemaining.toFixed(2)} left`,
      'error'
    );
    return;
  }

  const updates = {
    topUps: allTopUps,
    initialAmountUSD: baseAmountUSD,
    amountUSD: newAmountUSD,
    amountLocal: Math.round(newAmountUSD * ad.exchangeRate * 100) / 100
  };

  // End-date extension (user request): top-ups can extend the ad's run.
  const baseEnd = ad.initialEndDate || ad.endDate || '';
  const totalExtendDays = allTopUps.reduce((sum, t) => sum + (parseInt(t.extendDays, 10) || 0), 0);
  let newEndDisplay = '';
  if (baseEnd && !isNaN(new Date(baseEnd).getTime())) {
    updates.initialEndDate = baseEnd;
    updates.endDate = new Date(new Date(baseEnd).getTime() + totalExtendDays * 86400000).toISOString();
    if (totalExtendDays > 0) newEndDisplay = new Date(updates.endDate).toLocaleDateString(appDateLocale());
  }

  // Charge / refund the funding receipts so the money model stays balanced:
  // added top-up money grows this ad's allocation rows (the receipts'
  // remaining balance drops everywhere it is shown), removed top-ups give the
  // money back. Ads WITHOUT allocation rows are counted by their full
  // amountUSD automatically (getReceiptUsageStats fallback), so only explicit
  // allocation rows need updating here.
  if (funding && funding.hasAllocations && Math.abs(delta) > 0.009) {
    const allocations = ad.receiptAllocations.map(a => ({ ...a }));
    if (delta > 0) {
      let rest = delta;
      for (const src of funding.perReceipt) {
        if (rest <= 0.001) break;
        const take = Math.min(src.remaining, rest);
        if (take <= 0) continue;
        const alloc = allocations.find(a => String(a.receiptId) === String(src.receipt.id));
        if (alloc) alloc.amountUSD = Math.round(((parseFloat(alloc.amountUSD) || 0) + take) * 100) / 100;
        else allocations.push({ receiptId: src.receipt.id, amountUSD: Math.round(take * 100) / 100 });
        rest = Math.round((rest - take) * 100) / 100;
      }
      // Rounding crumbs (a cent at most) go on the first row so the
      // allocations always add up to the ad's new amount.
      if (rest > 0.001 && allocations.length) {
        allocations[0].amountUSD = Math.round(((parseFloat(allocations[0].amountUSD) || 0) + rest) * 100) / 100;
      }
    } else {
      let refund = -delta;
      for (let i = allocations.length - 1; i >= 0 && refund > 0.001; i--) {
        const cur = parseFloat(allocations[i].amountUSD) || 0;
        const back = Math.min(cur, refund);
        allocations[i].amountUSD = Math.round((cur - back) * 100) / 100;
        refund = Math.round((refund - back) * 100) / 100;
      }
    }
    updates.receiptAllocations = allocations;
  }

  try {
    if (isServerModeEnabled()) {
      await saveAdThroughAtomicServer(
        'update',
        adId,
        Number(ad._lastModified),
        buildServerAdMutationData(updates)
      );
    } else {
      const topUpsSaved = await updateRecord(state.ads, adId, updates);
      if (!topUpsSaved) return;
    }
  } catch (error) {
    const conflict = isVersionConflict409(error);
    showNotification(
      isArTU ? 'تعذر حفظ التعبئة' : 'Top-ups Not Saved',
      error?.status === 409
        ? describe409(error, isArTU ? 'تم تغيير الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة.' : 'This ad changed on another device. Refresh the data, then try again.')
        : (error?.message || (isArTU ? 'فشل حفظ التعبئة.' : 'The top-ups could not be saved.')),
      conflict ? 'warning' : 'error'
    );
    return;
  }

  tempTopUps = [];
  showNotification(
    isArTU ? 'تم الحفظ' : 'Saved',
    (isArTU ? `تم حفظ التعبئة. المبلغ الجديد: $${newAmountUSD.toFixed(2)}` : `Top-ups saved. New amount: $${newAmountUSD.toFixed(2)}`)
      + (newEndDisplay ? (isArTU ? ` — ينتهي: ${newEndDisplay}` : ` — ends: ${newEndDisplay}`) : ''),
    'success'
  );
  closeModal();
  render();
}

// Refund management functions
function toggleRefundAmount(refundType) {
  const amountSection = document.getElementById('refund-amount-section');
  const statusSection = document.getElementById('refund-status-section');
  
  if (refundType === 'None') {
    amountSection.classList.add('hidden');
    statusSection.classList.add('hidden');
  } else {
    amountSection.classList.remove('hidden');
    statusSection.classList.remove('hidden');
    
    // Auto-fill amount for Full refund
    if (refundType === 'Full' && state.modalData) {
      document.getElementById('refund-amount').value = state.modalData.amountUSD;
    }
  }
}

async function saveRefund() {
  const adId = state.modalData.id;
  const ad = state.ads.find(a => a.id === adId) || state.modalData;
  // Defense-in-depth: block a view-only role from persisting a refund via a
  // restored modal / direct call, mirroring editAd's canActOnRecord('ads','edit').
  if (!canActOnRecord('ads', 'edit', ad?.creatorId)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لاسترجاع الإعلانات' : 'You do not have permission to refund this ad', 'error');
    return;
  }
  const refundType = document.getElementById('refund-type').value;
  let refundAmount = parseFloat(document.getElementById('refund-amount').value) || 0;
  const refundStatus = document.getElementById('refund-status').value;
  const amountUSD = parseFloat(ad.amountUSD) || 0;
  // A refund is between 0 and the ad's amount.
  refundAmount = Math.min(Math.max(refundAmount, 0), amountUSD);
  if (refundType === 'None') refundAmount = 0;

  const updates = {
    refundType,
    refundAmount: refundType !== 'None' ? refundAmount : 0,
    refundStatus: refundType !== 'None' ? refundStatus : undefined,
    status: refundType !== 'None' ? 'Canceled' : state.modalData.status,
    canceledBy: refundType !== 'None' ? state.currentUser?.id : state.modalData.canceledBy
  };

  // The refunded money must actually RETURN in the books, and this must be
  // IDEMPOTENT: re-opening and re-saving a refund (or changing its amount, or
  // flipping Pending→Refunded) must reconcile to the SAME end-state — never
  // subtract again from the already-reduced allocations. We snapshot the
  // pre-refund allocations ONCE (refundAllocationBaseline) and always rebuild
  // the target from that untouched baseline, mirroring confirmStopAd.
  // Previously each re-save re-subtracted refundAmount, fabricating spendable
  // receipt balance the customer never got back.
  // Reduce a frozen baseline array by `amount` from the tail; returns the
  // rebuilt array and how much refund is still unspent.
  const _reduceFromBaseline = (baseline, amount) => {
    const arr = baseline.map(a => ({ ...a }));
    let refund = amount;
    for (let i = arr.length - 1; i >= 0 && refund > 0.001; i--) {
      const cur = parseFloat(arr[i].amountUSD) || 0;
      const back = Math.min(cur, refund);
      arr[i].amountUSD = Math.round((cur - back) * 100) / 100;
      refund = Math.round((refund - back) * 100) / 100;
    }
    return { arr, remaining: refund };
  };

  if (refundType === 'None') {
    // Undoing the refund: restore BOTH allocation sets from their baselines and
    // clear them so a future refund re-snapshots fresh.
    if (Array.isArray(ad.refundAllocationBaseline)) {
      updates.receiptAllocations = ad.refundAllocationBaseline.map(a => ({ ...a }));
      updates.refundAllocationBaseline = null;
    }
    if (Array.isArray(ad.refundDueBaseline)) {
      updates.dueAllocations = ad.refundDueBaseline.map(a => ({ ...a }));
      updates.refundDueBaseline = null;
    }
  } else {
    // A refund frees the ad's WHOLE funding. Return paid-receipt allocations
    // first, then delivery-DUE allocations for the remainder. Previously only
    // receiptAllocations were reduced, so an ad funded from delivery due credit
    // kept that credit locked forever after a full refund (audit round-3 #5).
    // Both use frozen baselines so re-saving a refund is idempotent.
    let remaining = refundAmount;
    if ((Array.isArray(ad.receiptAllocations) && ad.receiptAllocations.length) || Array.isArray(ad.refundAllocationBaseline)) {
      let baseline = Array.isArray(ad.refundAllocationBaseline) ? ad.refundAllocationBaseline : null;
      if (!baseline) {
        baseline = ad.receiptAllocations.map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) || 0 }));
        updates.refundAllocationBaseline = baseline;
      }
      const { arr, remaining: left } = _reduceFromBaseline(baseline, remaining);
      updates.receiptAllocations = arr;
      remaining = left;
    }
    // Rebuild due from baseline whenever a due baseline already exists (so a
    // smaller re-save correctly restores due) OR the refund reaches into due.
    if (Array.isArray(ad.refundDueBaseline) || (remaining > 0.001 && Array.isArray(ad.dueAllocations) && ad.dueAllocations.length)) {
      let dueBaseline = Array.isArray(ad.refundDueBaseline) ? ad.refundDueBaseline : null;
      if (!dueBaseline) {
        dueBaseline = ad.dueAllocations.map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) || 0 }));
        updates.refundDueBaseline = dueBaseline;
      }
      const { arr } = _reduceFromBaseline(dueBaseline, remaining);
      updates.dueAllocations = arr;
    }
    // ROWLESS legacy ads keep their due money only in the dueAmountToUse*
    // mirror, so the branch above never runs for them and a refund left the
    // mirror locking the receipt's credit forever. Stand the due baseline up
    // from the mirror — like the server's _financial_apply_refund — so the
    // refund releases it and an undo can restore it as a real row.
    const legacyRid = String(ad.linkedDeliveryReceiptId || ad.receiptId || '');
    if (!Array.isArray(ad.refundDueBaseline) && !Array.isArray(updates.dueAllocations)
        && remaining > 0.001 && legacyRid && isAdLegacyDueMirrorForReceipt(ad, legacyRid)) {
      const mirrorUSD = getAdLegacyDueMirrorUSD(ad, legacyRid);
      if (mirrorUSD > 0) {
        const dueBaseline = [{ receiptId: legacyRid, amountUSD: mirrorUSD }];
        updates.refundDueBaseline = dueBaseline;
        const { arr } = _reduceFromBaseline(dueBaseline, remaining);
        updates.dueAllocations = arr;
      }
    }
  }
  // Keep the legacy dueAmountToUse* mirror in step with the rows we just wrote.
  // saveAd always writes dueAmountToUseUSD, and the usage readers fall back to it the
  // moment an ad's due rows sum to zero. Leaving it at its pre-refund value is exactly
  // why a FULL refund never returned the credit while a partial one did: the bug bites
  // only at the zero boundary. The rows are the truth; the mirror must follow them.
  if (Array.isArray(updates.dueAllocations)) {
    const dueUSD = updates.dueAllocations
      .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
    updates.dueAmountToUseUSD = Math.round(dueUSD * 100) / 100;
    // The LYD half is read only when the USD half is zero, and nothing else in the app
    // keeps it current. migrateOldDataFormats has already folded any legacy LYD value
    // into a real row, so clearing it here cannot lose information — while leaving a
    // stale value would silently re-lock the credit we are returning.
    updates.dueAmountToUseLYD = 0;
  }
  // Derived from the ad amount (not compounding). Undoing (None) restores the
  // full spend by clearing spentUSD.
  updates.spentUSD = refundType !== 'None'
    ? Math.max(Math.round((amountUSD - refundAmount) * 100) / 100, 0)
    : undefined;

  try {
    if (isServerModeEnabled()) {
      await saveAdThroughAtomicServer(
        'update',
        adId,
        Number(ad._lastModified),
        buildServerAdMutationData(updates)
      );
    } else {
      const refundSaved = await updateRecord(state.ads, adId, updates);
      if (!refundSaved) return;
    }
  } catch (error) {
    const conflict = isVersionConflict409(error);
    showNotification(
      state.language === 'ar' ? 'تعذر حفظ الاسترجاع' : 'Refund Not Saved',
      error?.status === 409
        ? describe409(error, state.language === 'ar' ? 'تم تغيير الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة.' : 'This ad changed on another device. Refresh the data, then try again.')
        : (error?.message || (state.language === 'ar' ? 'فشل حفظ الاسترجاع.' : 'The refund could not be saved.')),
      conflict ? 'warning' : 'error'
    );
    return;
  }
  showNotification(state.language === 'ar' ? 'تم الحفظ' : 'Saved', state.language === 'ar' ? `تم تطبيق الاسترجاع (${trStatus(refundType)})` : `Refund ${refundType} applied`, refundType !== 'None' ? 'warning' : 'success');
  closeModal();
  render();
}
