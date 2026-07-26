/**
 * Static regression checks for the shared phone UI contract.
 *
 * These checks protect the shell, modal and table rules that are easy to break
 * in a large template-driven vanilla-JS application. Browser tests still cover
 * the real interactions; this file makes the dangerous regressions fail fast.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const platform = read('src/01-platform.js');
const stateServices = read('src/05-state-services.js');
const mobileRuntime = read('src/01b-mobile-runtime.js');
const dataAudit = read('src/08-data-audit.js');
const serverApi = read('src/09-api-auth.js');
const init = read('src/17-init.js');
const liveSync = read('src/10-live-sync.js');
const routing = read('src/11-routing-cloud.js');
const views = read('src/12-views.js');
const helpers = read('src/13-filters-helpers.js');
const forms = read('src/14-forms.js');
const modals = read('src/15-modals.js');
const customerMergeModal = modals.slice(
  modals.indexOf("case 'customer-merge':"),
  modals.indexOf("case 'ad':")
);
const adEditModal = modals.slice(
  modals.indexOf("case 'ad':"),
  modals.indexOf("case 'user':")
);
const adEditHistoryViewer = helpers.slice(
  helpers.indexOf('function _adEditHistoryText'),
  helpers.indexOf('const _pendingReceiptTransferAttempts')
);
const clothes = read('src/15b-clothes.js');
const adsStudio = read('src/15c-ads-studio.js');
const metaAds = read('src/15d-meta-ads.js');
const photoPaste = read('src/15e-photo-paste.js');
const actionsIo = read('src/16-actions-io.js');
const css = read('style.css');

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const toggleBody = routing.match(/function toggleMobileMenu\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
check('mobile drawer forces a shell render', /forceFullRender\(\)/.test(toggleBody));
check('real navigation resets to the top without affecting drawer redraws',
  routing.includes('requestViewScrollReset();') &&
  routing.includes('if (wasMobileMenuOpen) forceFullRender();') &&
  views.includes('let _resetScrollOnNextRender = false;') &&
  views.includes('_resetScrollOnNextRender = false;') &&
  views.includes('resetScroll ? { top: 0, left: 0 }'));
check('main app exposes semantic mobile shell hooks',
  ['app-shell', 'app-main', 'mobile-app-header', 'app-sidebar', 'mobile-menu-backdrop']
    .every(token => views.includes(token)));
check('hamburger has accessible drawer state',
  views.includes('aria-controls="app-sidebar"') && views.includes('aria-expanded='));

check('Simple and Advanced workspace modes are persistent shell preferences',
  platform.includes("const ALBAYAN_EXPERIENCE_MODE_KEY = 'albayan_experience_mode';") &&
  platform.includes("return preference === 'advanced' ? 'advanced' : 'simple';") &&
  platform.includes("localStorage.setItem(ALBAYAN_EXPERIENCE_MODE_KEY, next)") &&
  platform.includes("document.body.classList.toggle('workspace-advanced', advanced)") &&
  platform.includes("document.body.classList.toggle('workspace-simple', !advanced)") &&
  views.includes('renderWorkspaceTopbar()') &&
  views.includes('onclick="toggleWorkspaceExperienceMode()"') &&
  views.includes("onclick=\"setWorkspaceExperienceMode('simple')\"") &&
  views.includes("onclick=\"setWorkspaceExperienceMode('advanced')\"") &&
  css.includes('.workspace-topbar') &&
  css.includes('.workspace-mode-toggle'));
check('workspace progressive panels stay accessible in both experience modes',
  views.includes('if (isAdvancedWorkspaceMode()) return true;') &&
  views.includes('function renderWorkspaceFilterToggle(view, activeCount = 0)') &&
  views.includes('aria-expanded="${expanded ? \'true\' : \'false\'}"') &&
  views.includes('aria-controls="${safeView}-advanced-filters"') &&
  ['customers', 'receipts', 'ads', 'audit']
    .every(view => views.includes(`isWorkspaceFilterPanelExpanded('${view}')`)) &&
  css.includes('.workspace-advanced-panel.hidden'));
check('smart search safely discovers permitted customers, receipts, pages, and ads',
  routing.includes('function getCommandPaletteEntityCommands(searchTerm)') &&
  routing.includes('if (rawTerm.length < 2) return [];') &&
  ['customers', 'receipts', 'pages', 'ads']
    .every(view => routing.includes(`canOpenWorkspaceView('${view}')`)) &&
  ['entity-customer-', 'entity-receipt-', 'entity-page-', 'entity-ad-']
    .every(prefix => routing.includes(prefix)) &&
  routing.includes("action: () => commandPaletteNavigate('customers'") &&
  routing.includes("action: () => commandPaletteNavigate('receipts'") &&
  routing.includes("action: () => commandPaletteNavigate('pages'") &&
  routing.includes("action: () => commandPaletteNavigate('ads'") &&
  routing.includes('return results.slice(0, 20);') &&
  views.includes('aria-haspopup="dialog"') &&
  routing.includes('Type at least 2 characters to search business records'));
const currentReceiptLinkHelper = helpers.slice(
  helpers.indexOf('function getAdLinkedReceiptIds(ad)'),
  helpers.indexOf('function openCustomerReceipts(customerId)')
);
const scopedAdFilter = helpers.slice(
  helpers.indexOf('function getFilteredAds(customersById = null)'),
  helpers.indexOf('// Read the search term from state')
);
check('customer and receipt cards expose phone-safe permission-scoped relationship navigation',
  stateServices.includes("receiptCustomerFilter: ''") &&
  stateServices.includes("receiptRecordFilter: ''") &&
  stateServices.includes("adReceiptFilter: ''") &&
  routing.includes("customer: Security.isValidRecordId(customerId) ? customerId : null") &&
  routing.includes("receipt: Security.isValidRecordId(receiptId) ? receiptId : null") &&
  routing.includes("const customerFilter = params.customer && Security.isValidRecordId(params.customer)") &&
  routing.includes("const receiptFilter = params.receipt && Security.isValidRecordId(params.receipt)") &&
  views.includes('data-action="view-customer-receipts"') &&
  views.includes('data-action="view-receipt-ads"') &&
  views.includes('id="ad-receipt-link-filter"') &&
  /data-action="view-customer-receipts"[^>]*min-h-11/.test(views) &&
  /data-action="view-receipt-ads"[^>]*min-h-11/.test(views) &&
  views.includes('flex min-w-0 flex-wrap items-center gap-2 mt-1') &&
  views.includes('onclick="clearReceiptCustomerFilter()" class="min-h-11 min-w-11') &&
  ['receiptId', 'fundingReceiptId', 'linkedDeliveryReceiptId', 'linkedReceiptId', 'receiptIds', 'receiptAllocations', 'dueAllocations', 'mergedPaidAllocations', 'stopAllocationBaseline', 'refundAllocationBaseline', 'refundDueBaseline']
    .every(field => currentReceiptLinkHelper.includes(field)) &&
  !currentReceiptLinkHelper.includes('settledReceiptId') &&
  scopedAdFilter.indexOf('getAdsVisibleToCurrentUser()') < scopedAdFilter.indexOf('isAdLinkedToReceipt'));
check('full workspace navigation renders an expensive view exactly once',
  views.includes('function renderMainApp(viewHTML = null)') &&
  views.includes('${viewHTML === null ? renderView() : viewHTML}') &&
  (views.match(/app\.innerHTML = renderMainApp\(viewHTML\);/g) || []).length >= 2 &&
  !views.includes('app.innerHTML = renderMainApp();') &&
  /Navigation \(or first render after login\)[\s\S]{0,400}const viewHTML = renderView\(\);[\s\S]{0,120}app\.innerHTML = renderMainApp\(viewHTML\);/.test(views));

check('table card conversion is opt-in',
  css.includes('.mobile-card-table') && !css.includes('.glass-panel table'));
check('audit logs expose all table fields as phone cards',
  views.includes('mobile-card-table audit-mobile-table') &&
  views.includes('audit-description-cell') &&
  css.includes('.audit-mobile-table'));
check('hosted audit detail buttons resolve the server-visible row',
  views.includes('? (Array.isArray(state.serverLogs) ? state.serverLogs : [])') &&
  views.includes("const canViewOwnLogs = currentUserHasPermission('auditLogs', 'viewOwn');") &&
  views.includes('audit-detail-grid'));
check('hidden table cells stay hidden in card mode',
  css.includes('.mobile-card-table tbody tr td.hidden'));
check('global flex header rewrite is absent',
  !css.includes('.flex.justify-between.items-center'));
check('global grid rewrite is absent',
  !css.includes('.grid.grid-cols-2') && !css.includes('.grid.grid-cols-3'));
check('panels do not shrink when a child is tapped',
  !css.includes('.glass-panel:active'));

check('phone dialogs use one safe scrolling overlay',
  css.includes('.mobile-dialog-overlay') &&
  views.includes('mobile-dialog-overlay fixed inset-0') &&
  helpers.includes('mobile-dialog-overlay fixed inset-0') &&
  modals.includes('mobile-dialog-overlay fixed inset-0'));
check('Edit Ad keeps an always-visible phone-sized history action in its fixed header',
  adEditModal.includes('data-action="view-ad-edit-history"') &&
  adEditModal.includes('data-ad-id="${Security.escapeHtml(String(adData.id || \'\'))}"') &&
  adEditModal.includes('onclick="showAdEditHistory(this.dataset.adId)"') &&
  adEditModal.includes('class="min-h-11 inline-flex') &&
  adEditModal.includes("const adHistoryCount = getAdEditHistoryCount(adData);") &&
  adEditModal.includes("${isEdit ? `"));
check('ad history rendering is defensive, escaped and accessible',
  adEditHistoryViewer.includes("Array.isArray(ad?.editHistory)") &&
  adEditHistoryViewer.includes("Security.escapeHtml(edit.editedBy)") &&
  adEditHistoryViewer.includes("Security.escapeHtml(change.field)") &&
  adEditHistoryViewer.includes("Security.escapeHtml(change.from)") &&
  adEditHistoryViewer.includes("Security.escapeHtml(change.to)") &&
  adEditHistoryViewer.includes('role="dialog"') &&
  adEditHistoryViewer.includes('aria-modal="true"') &&
  adEditHistoryViewer.includes('No field details were saved for this older edit.'));
check('ad edit history is detached before save so failed edits cannot create ghost rows',
  modals.includes('function buildAdEditHistoryUpdates(') &&
  modals.includes('oldAd.editHistory.map(entry =>') &&
  modals.includes('Object.assign(adUpdates, buildAdEditHistoryUpdates(oldAd, changes));') &&
  !modals.includes('const editHistory = oldAd.editHistory || [];'));
check('Android keeps normal document scrolling',
  !/body\.platform-android\s*\{[^}]*overflow\s*:\s*hidden/s.test(css) &&
  !/body\.platform-android\s+#app\s*\{/s.test(css));
check('safe-area variables cover phone browser chrome and notches',
  ['--app-safe-top', '--app-safe-right', '--app-safe-bottom', '--app-safe-left']
    .every(token => css.includes(token)));

check('receipt phone picker stacks and fits the viewport',
  modals.includes('receipt-phone-search grid grid-cols-1') &&
  modals.includes('max-w-[calc(100vw-2rem)]'));
check('new receipt customer warnings require an accessible phone-safe decision',
  forms.includes("warning.id = 'receipt-customer-risk-warning'") &&
  forms.includes("warning.setAttribute('role', 'alertdialog')") &&
  forms.includes("warning.setAttribute('aria-modal', 'true')") &&
  forms.includes("warning.setAttribute('aria-labelledby', 'receipt-customer-risk-title')") &&
  forms.includes("warning.setAttribute('aria-describedby', 'receipt-customer-risk-description')") &&
  forms.includes('max-h-[90dvh]') &&
  forms.includes('min-h-0 flex-1 space-y-3 overflow-y-auto') &&
  forms.includes('grid-cols-1 gap-3') && forms.includes('sm:grid-cols-2') &&
  (forms.match(/min-h-11/g) || []).length >= 3 &&
  forms.includes("const editingId = String(document.getElementById('receipt-editing-id')?.value || '').trim();") &&
  forms.includes('if (!editTarget && requireReceiptCustomerRiskAcknowledgement(customerId))') &&
  forms.includes('event.stopImmediatePropagation();') &&
  mobileRuntime.includes("topSurface.id === 'receipt-customer-risk-warning'") &&
  mobileRuntime.includes('cancelReceiptCustomerRiskWarning()'));
check('receipt status choices become a readable phone grid',
  modals.includes('grid grid-cols-2 sm:grid-cols-4') &&
  css.includes('.receipt-filter-controls'));
check('receipt debt-source filter is available in the responsive filter bar',
  views.includes("updateReceiptFilter('debt', this.value)") &&
  ['any-debt', 'delivery-debt', 'shop-debt', 'no-debt']
    .every(value => views.includes(`option value="${value}"`)) &&
  views.includes('receipt-filter-controls'));
check('receipt filters progressively disclose advanced controls without hiding quick actions',
  views.includes("const receiptAdvancedFiltersOpen = isWorkspaceFilterPanelExpanded('receipts');") &&
  views.includes("renderWorkspaceFilterToggle('receipts', receiptAdvancedFilterCount)") &&
  views.includes('id="receipts-advanced-filters"') &&
  views.includes("applyReceiptQuickFilter('all')") &&
  views.includes("applyReceiptQuickFilter('unpaid')") &&
  views.includes("applyReceiptQuickFilter('debt')") &&
  views.includes("applyReceiptQuickFilter('not-collected')") &&
  helpers.includes('Quick filters are intentionally mutually exclusive') &&
  helpers.includes("if (mode === 'unpaid') state.receiptStatusFilter = 'not_paid';") &&
  helpers.includes("if (mode === 'debt') state.receiptDebtFilter = 'any-debt';") &&
  helpers.includes("if (mode === 'not-collected') state.receiptCollectedFilter = 'not-collected';") &&
  helpers.includes("const newGrid = src.querySelector('#receipts-grid');") &&
  helpers.includes("const newChips = src.querySelector('#receipt-active-filters');"));
check('receipt and delivery cards expose a tap-sized WhatsApp dispatch action',
  views.includes('showDeliveryWhatsAppPrompt(this.dataset.receiptId, this)') &&
  views.includes('data-receipt-id=') &&
  views.includes('Share delivery information to WhatsApp') &&
  views.includes('inline-flex min-h-11') &&
  (views.match(/canShareDeliveryReceiptToWhatsApp\(/g) || []).length >= 4);
check('receipt settlement installs the Paid receipt and affected ads as one server-confirmed batch',
  serverApi.includes('async function apiSettleReceipt(payload)') &&
  serverApi.includes('/settle?include_media=false') &&
  serverApi.includes('!Array.isArray(response.updatedAds)') &&
  serverApi.includes("validateServerEntityResponse('receipts', response.receipt") &&
  serverApi.includes("validateServerEntityResponse('ads', entity, `settlement.updatedAds[") &&
  // The reverse (paid -> Not Paid debt conversion) shares the exact batch
  // rule: neither direction paints the receipt optimistically, and both
  // install receipt + ads from the same server-confirmed envelope.
  serverApi.includes('async function apiUnsettleReceipt(payload)') &&
  serverApi.includes('/unsettle?include_media=false') &&
  dataAudit.includes("], _settlesReceipt ? 'receiptSettlement' : 'receiptDebtConversion');") &&
  dataAudit.includes('...settlement.updatedAds.map') &&
  dataAudit.includes('if (!((_settlesReceipt || _convertsReceipt) && isServerModeEnabled()))') &&
  dataAudit.indexOf('if (!((_settlesReceipt || _convertsReceipt) && isServerModeEnabled()))') < dataAudit.indexOf("], _settlesReceipt ? 'receiptSettlement' : 'receiptDebtConversion');"));
check('offline receipt settlement validates the whole money batch and migrates frozen baselines',
  dataAudit.includes('function planLocalReceiptPaidAdUpdates(receiptId, nextReceipt = null)') &&
  dataAudit.includes("throw new Error('Linked ad and receipt belong to different customers')") &&
  dataAudit.includes("throw new Error('Paid receipt balance is insufficient for all linked ads')") &&
  dataAudit.includes('const baselineChanged = stopMoved + stopLegacy + refundMoved > 0;') &&
  dataAudit.includes("next.refundBaselinePaymentStatus = 'paid';") &&
  dataAudit.includes('baselineChanged && liveDue.size === 0') &&
  dataAudit.includes('settledReceiptId: rid'));
check('legacy In-Shop debt mirrors use one shared reader without turning zero links into money',
  dataAudit.includes('function isAdLegacyDueMirrorForReceipt(ad, receiptId)') &&
  dataAudit.includes("if (method === 'in_shop') return String(ad.receiptId || '') === rid;") &&
  dataAudit.includes("&& String(ad.linkedDeliveryReceiptId || '') === ''") &&
  dataAudit.includes('function getAdLegacyDueMirrorUSD(ad, receiptId, fallbackRate = 0)') &&
  dataAudit.includes("['driver', 'in_shop'].includes(String(ad.collectionMethod || ''))") &&
  forms.includes('getAdLegacyDueMirrorUSD(existingAd, rid, r.exchangeRate)') &&
  modals.includes('const selectedDueReceipt = state.receipts.find(') &&
  modals.includes('getAdLegacyDueMirrorUSD(existingAd, linkedReceiptId, selectedDueReceipt?.exchangeRate)'));
check('Edit Ad receipt replacement is explicit, atomic-looking and phone accessible',
  forms.includes('function renderAdPaidReceiptReplacementNotice()') &&
  forms.includes('function renderAdDueReceiptReplacementNotice()') &&
  forms.includes('current link unavailable — choose a replacement') &&
  forms.includes('Both changes happen together with no double charge.') &&
  forms.includes('The ad and both receipt balances update together with no double charge.') &&
  forms.includes('Never clamp a saved $30') &&
  !forms.includes('allocation.amountUSD = Math.min') &&
  forms.includes('const replacingSavedReceipt = !!state.modalData?.id') &&
  forms.includes('dueInput.value = originalDueAmount.toFixed(2)') &&
  forms.includes("? `${isArL ? 'عجز' : 'Short'} $${Math.abs(balance).toFixed(2)}`") &&
  forms.includes('grid grid-cols-1 sm:grid-cols-2') &&
  forms.includes('id="ad-funding-receipt-${idx}"') &&
  forms.includes('id="ad-funding-amount-${idx}"') &&
  modals.includes('id="ad-linked-receipt-change" role="status" aria-live="polite"') &&
  modals.includes('id="ad-funding-change-notice" role="status" aria-live="polite"') &&
  modals.includes('The ad amount was not changed.') &&
  modals.includes('Choose a Paid replacement receipt.') &&
  modals.includes('aria-describedby="ad-temp-receipt-hint ad-linked-receipt-help ad-linked-receipt-change"'));
check('driver completion closes instantly and reconciles linked ads without blocking the driver',
  helpers.includes('async function refreshAdsAfterReceiptServerCascade(receipt') &&
  helpers.includes('async function refreshAdsAfterReceiptPaidCascade(receipt)') &&
  helpers.includes("apiLoadCollectionAll('ads', { forceRefresh: true })") &&
  // The old flow AWAITED a full driver-scoped ads re-download between the
  // receipt PATCH and the modal close — a dead "Mark Delivered" button for
  // seconds on field networks. New contract: apply the exact local ad
  // reclassification plan synchronously, close + toast, then run the
  // authoritative refresh in the background (never re-blocking the UI).
  !helpers.includes('await refreshAdsAfterReceiptPaidCascade(') &&
  !helpers.includes('await refreshAdsAfterReceiptServerCascade(') &&
  helpers.includes('applyLocalReceiptPaidAdUpdates(planLocalReceiptPaidAdUpdates(String(saved.id), saved))') &&
  helpers.includes('applyLocalReceiptPaidAdUpdates(planLocalReceiptPaidAdUpdates(String(latestData.id), latestData))') &&
  helpers.includes('refreshAdsAfterReceiptServerCascade(saved).then(') &&
  helpers.includes('refreshAdsAfterReceiptServerCascade(latestData).then(') &&
  helpers.indexOf("showNotification(state.language === 'ar' ? 'تم التوصيل'") < helpers.indexOf('refreshAdsAfterReceiptServerCascade(saved).then('));
check('server delivery cancellation refreshes released ads without stale ad PATCHes',
  // views: submitDeliveryCancel now follows the SAME non-blocking contract as
  // the driver cancel — the receipt PATCH (which releases the rows atomically
  // server-side) is awaited, then the modal closes + renders immediately and
  // the authoritative ads refresh runs in the background; on failure the
  // Sync-pending toast promises the delta live-sync reconciliation. It must
  // never AWAIT the full ads re-download before closing (dead Cancel button
  // for seconds on field networks) and must never issue stale ad PATCHes.
  !views.includes('await refreshAdsAfterReceiptServerCascade(') &&
  views.includes('refreshAdsAfterReceiptServerCascade(savedReceipt).then(') &&
  views.includes('} else {\n      try {\n        releasedAds = await releaseCanceledDeliveryDueFunding(receipt.id);') &&
  views.includes('if (deferredServerAdsRefresh) deferredServerAdsRefresh();') &&
  // close + render + Canceled toast all come BEFORE the deferred refresh kick
  views.indexOf("state.language === 'ar' ? 'أُلغيت' : 'Canceled'") < views.indexOf('if (deferredServerAdsRefresh) deferredServerAdsRefresh();') &&
  // helpers: the DRIVER cancel keeps the same contract.
  helpers.includes('refreshAdsAfterReceiptServerCascade(savedReceipt).then(') &&
  helpers.includes('releasedAds = await releaseCanceledDeliveryDueFunding(receipt.id);') &&
  helpers.indexOf("state.language === 'ar' ? 'تم الإلغاء' : 'Canceled'") < helpers.indexOf('refreshAdsAfterReceiptServerCascade(savedReceipt).then('));
check('driver final receipt number normalizes Arabic-Indic digits instead of deleting them',
  forms.includes('function normalizeDigitsAscii(value)') &&
  helpers.includes("this.value=normalizeDigitsAscii(this.value).replace(/[^0-9]/g,'')") &&
  (helpers.match(/normalizeDigitsAscii\(document\.getElementById\('delivery-final-receipt-no'\)\?\.value \|\| ''\)\.trim\(\)/g) || []).length >= 2);
const deliveryCompletionModalsSection = (() => {
  const start = helpers.indexOf('async function openReceiptDeliveryCompletionModal');
  const end = helpers.indexOf('async function submitReceiptDeliveryCancel');
  return (start > 0 && end > start) ? helpers.slice(start, end) : '';
})();
check('one stray backdrop tap cannot destroy the driver completion form',
  deliveryCompletionModalsSection.length > 0 &&
  // The completion modal must have NO backdrop-dismiss at all; the stacked
  // cancel dialog may only dismiss after confirming a typed reason away.
  !deliveryCompletionModalsSection.includes('if (e.target === modal) modal.remove();') &&
  deliveryCompletionModalsSection.includes('Discard the typed reason?') &&
  deliveryCompletionModalsSection.includes('تجاهل السبب المكتوب؟'));
check('delivery completion draft survives camera round-trip process kills',
  helpers.includes("const _DELIVERY_DRAFT_PREFIX = 'albayan_delivery_draft_';") &&
  helpers.includes('function _saveDeliveryCompletionDraftNow()') &&
  helpers.includes('localStorage.setItem(key, JSON.stringify(draft));') &&
  helpers.includes('const _draft = _readDeliveryCompletionDraft(receipt);') &&
  (helpers.match(/_clearDeliveryCompletionDraft\(receipt\.id\);/g) || []).length >= 4 &&
  helpers.includes('_pruneDeliveryCompletionDrafts();'));
check('driver photo retry and read failures are surfaced, not swallowed',
  helpers.includes('onchange="handleDeliveryReceiptPhotoUpload(this.files); this.value=\'\'"') &&
  helpers.includes('تعذر قراءة الصورة — حاول مرة أخرى أو اختر صورة أخرى.') &&
  helpers.includes('Could not read the photo — try again or pick a different photo.'));
check('a genuine 409 during delivery completion rebases instead of dead-looping',
  helpers.includes('_deliveryCompletionOpen.lastMod = latestData._lastModified || 0;') &&
  helpers.includes('The receipt changed while this form was open — review the figures and tap Mark Delivered again.') &&
  helpers.includes('This delivery was canceled by an admin.') &&
  helpers.includes('function describeNetworkError(e)'));
check('delivery log paginates filtered rows and exposes bilingual phone-card labels',
  views.includes('const DELIVERIES_PAGE_SIZE = 30;') &&
  views.includes('_deliveriesShowLimit += DELIVERIES_PAGE_SIZE;') &&
  views.includes('const deliveryFilterFingerprint = JSON.stringify([filterStatus, filterDriver, searchTerm]);') &&
  views.includes('_deliveriesShowLimit = DELIVERIES_PAGE_SIZE;') &&
  views.includes('const visibleDeliveryRows = filteredDeliveries.slice(0, _deliveriesShowLimit);') &&
  views.includes('const remainingDeliveryRows = filteredDeliveries.length - visibleDeliveryRows.length;') &&
  views.includes('onclick="loadMoreDeliveries()"') &&
  ['Customer', 'Driver', 'Amount', 'Status', 'Office handover', 'Date', 'Actions']
    .every(label => views.includes(`: '${label}'}`)) &&
  views.includes('mobile-card-table delivery-mobile-table') &&
  css.includes('content: attr(data-label)'));
check('WhatsApp dispatch preview is a phone-safe consent dialog',
  helpers.includes("dialog.id = 'delivery-whatsapp-share-dialog'") &&
  helpers.includes('mobile-dialog-overlay fixed inset-0') &&
  helpers.includes('max-h-[92dvh]') &&
  helpers.includes('overflow-y-auto') &&
  helpers.includes('Nothing has been sent yet. WhatsApp will open; choose your business group and press Send.') &&
  helpers.includes('This message contains the customer phone and delivery place and will be shared outside Albayan.') &&
  helpers.includes('id="delivery-whatsapp-share-button"') &&
  helpers.includes('min-h-11'));
check('new delivery saves offer WhatsApp only after the saved row is confirmed',
  forms.includes("let newlyCreatedDeliveryReceiptId = '';") &&
  forms.includes('if (isTempDelivery && canShareDeliveryReceiptToWhatsApp(saved))') &&
  forms.includes("newlyCreatedDeliveryReceiptId = String(saved.id || '');") &&
  forms.includes('if (isTempDelivery && canShareDeliveryReceiptToWhatsApp(savedLocalReceipt))') &&
  forms.includes('setTimeout(() => showDeliveryWhatsAppPrompt(newlyCreatedDeliveryReceiptId), 0);') &&
  forms.indexOf("saved = created?.data ? Security.sanitizeObject(created.data) : null;") <
    forms.indexOf('if (isTempDelivery && canShareDeliveryReceiptToWhatsApp(saved))'));
check('delivery fee input is plain LYD with a payer choice and no rate fields',
  (() => {
    // The fee section of the Mark-Delivered modal: simple LYD amount + method +
    // who paid it (customer vs shop). The old split-payment row exposed Rate 1 /
    // Rate 2 on a flat cash fee — those must never come back, and the fee must
    // never join the USD (ads credit) math.
    const feeStart = helpers.indexOf('id="delivery-fee-payment"');
    const feeEnd = helpers.indexOf('delivery-receipt-image-data', feeStart);
    if (feeStart === -1 || feeEnd === -1 || feeEnd < feeStart) return false;
    const feeSection = helpers.slice(feeStart, feeEnd);
    return feeSection.includes('id="delivery-fee-amount"') &&
      feeSection.includes('id="delivery-fee-method"') &&
      feeSection.includes('name="delivery-fee-paid-by"') &&
      feeSection.includes('value="customer"') &&
      feeSection.includes('value="shop"') &&
      feeSection.includes('Customer paid') &&
      feeSection.includes('دفعها العميل') &&
      feeSection.includes('Shop paid (loss)') &&
      feeSection.includes('يتحملها المحل (خسارة)') &&
      !feeSection.includes('payment-rate1') &&
      !feeSection.includes('payment-rate2') &&
      !feeSection.includes('payment-split-item') &&
      helpers.includes('function _readDeliveryFeeLyd()') &&
      helpers.includes('function _readDeliveryFeePaidBy()') &&
      helpers.includes("rate: 1, rate2: 0, collectionType: 'delivery'") &&
      helpers.includes('deliveryFeePaidBy: feePaidBy');
  })());
check('collected fee and payer surface on receipt cards and delivery summaries',
  views.includes("String(receipt.deliveryFeePaidBy || 'customer') === 'shop'") &&
  views.includes("String(ad.deliveryFeePaidBy || 'customer') === 'shop'") &&
  views.includes('paid by shop (loss)') &&
  views.includes('paid by customer') &&
  views.includes('يتحملها المحل (خسارة)') &&
  views.includes('دفعها العميل') &&
  views.includes('feesShopPaidLYD') &&
  views.includes('feeVarianceLYD') &&
  views.includes("isAr ? 'رسوم يتحملها المحل (خسارة):' : 'Shop-paid Fees (Loss):'"));
check('customer filters cannot overflow the phone card',
  views.includes('customer-filter-controls') &&
  css.includes('.customer-filter-controls'));
check('duplicate customer repair is admin-only, transactional and phone-sized',
  helpers.includes('function normalizeCustomerPhoneKey(value)') &&
  helpers.includes('function findDuplicateCustomerGroups') &&
  views.includes('onclick="showCustomerDuplicateMerge()"') &&
  modals.includes("state.activeModal = 'customer-merge'") &&
  modals.includes('Only an administrator can merge customers.') &&
  modals.includes('min-h-12') &&
  modals.includes('No receipt or ad is deleted and no amount is changed.') &&
  serverApi.includes("apiJson('/api/customers/merge?include_media=false'") &&
  serverApi.includes('validateServerEntityResponse(\'customers\', response.duplicate'));
check('duplicate customer merge is a single-scroll accessible dialog',
  customerMergeModal.includes('id="customer-merge-title" tabindex="-1"') &&
  customerMergeModal.includes('<form id="modal-form" class="space-y-5 pr-1">') &&
  !customerMergeModal.includes('max-h-[72vh] overflow-y-auto') &&
  modals.includes("' role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"customer-merge-title\"'") &&
  modals.includes("? ' max-h-[90dvh] overflow-y-auto custom-scrollbar'") &&
  modals.includes("if (event.key !== 'Tab') return;") &&
  modals.includes("if (event.key === 'Escape')") &&
  modals.includes('previousCustomerMergeFocusId') &&
  modals.includes('_customerMergeReturnFocus') &&
  modals.includes('button[aria-haspopup="dialog"][onclick="showCustomerDuplicateMerge()"]'));
check('customer linked-pages drill-down is phone-sized and tap-friendly',
  views.includes('customer-pages-button min-h-11') &&
  helpers.includes('customer-pages-dialog mobile-dialog-overlay') &&
  helpers.includes('max-h-[90dvh]') &&
  helpers.includes('customer-page-option w-full min-h-11') &&
  helpers.includes('grid grid-cols-1 sm:grid-cols-3'));
check('customer pages dialog is closed on logout and relevant live updates',
  (liveSync.match(/_closeCustomerPagesDialogForStateChange\(\)/g) || []).length >= 5 &&
  ['ads', 'receipts', 'customers', 'pages', 'exchangeRateHistory']
    .every(name => liveSync.includes(`name === '${name}'`)));
check('customer pages dialog traps focus and Escape closes it globally',
  helpers.includes("event.key !== 'Tab'") &&
  helpers.includes('document.activeElement === last') &&
  routing.includes("document.getElementById('customer-pages-dialog')") &&
  routing.includes('stopImmediatePropagation()') &&
  routing.includes('isCommandPaletteShortcut'));
check('ad photo viewer is a clear phone-sized action',
  views.includes('mobile-card-table w-full') &&
  views.includes('ad-photo-view-button') &&
  views.includes('data-action="view-ad-photos"') &&
  views.includes('data-role="ad-creator"') &&
  css.includes('button.ad-photo-view-button') &&
  css.includes('min-height: 2.75rem'));
check('receipt photo viewer allows native pan and pinch zoom',
  helpers.includes('receipt-photo-stage') && css.includes('touch-action: pan-x pan-y pinch-zoom'));
check('packaged Android handles Back in UI order before exiting',
  mobileRuntime.includes("App.addListener('backButton', handleAndroidBackButton)") &&
  mobileRuntime.includes('function getTopMobileSurface()') &&
  mobileRuntime.includes('zIndex: mobileSurfaceZIndex(element)') &&
  mobileRuntime.includes("topSurface.id === 'receipt-photo-viewer'") &&
  mobileRuntime.includes("topSurface.id === 'command-palette-modal'") &&
  mobileRuntime.includes('state.isMobileMenuOpen = false') &&
  mobileRuntime.includes('Press Back again to exit.') &&
  mobileRuntime.includes('App.exitApp()'));
check('Android Back resets exit confirmation after closing or navigating',
  (mobileRuntime.match(/_mobileLastBackAt = 0;/g) || []).length >= 3 &&
  mobileRuntime.includes('if (closeTopMobileSurface())') &&
  mobileRuntime.includes('currentView !== landingView'));
check('generic Android Back closes clean URL and modal working state',
  mobileRuntime.includes('function clearGenericMobileModalState(surface)') &&
  mobileRuntime.includes("clearUrlParams(['modal', 'id'])") &&
  mobileRuntime.includes("surface?.id === 'collect-receipt-modal'") &&
  mobileRuntime.includes('_tempCollectPayments = []'));
check('packaged mobile shows a retryable offline/server notice',
  mobileRuntime.includes("window.addEventListener('offline'") &&
  mobileRuntime.includes("window.addEventListener('online'") &&
  mobileRuntime.includes('mobile-connectivity-notice') &&
  mobileRuntime.includes('retryMobileConnection()') &&
  mobileRuntime.includes('Albayan cannot reach the server'));
check('packaged mobile cold start gates before auth instead of showing Login',
  init.includes('const blockPackagedMobileColdStart') &&
  init.includes('setMobileColdStartBlocked(true);') &&
  init.indexOf('if (blockPackagedMobileColdStart)') < init.indexOf('me = await apiAuthMe()') &&
  mobileRuntime.includes('id="mobile-connection-gate"') &&
  mobileRuntime.includes('You have not been signed out.') &&
  mobileRuntime.includes('window.location.reload()'));
check('mobile session timeout cannot be mistaken for a real logout',
  serverApi.includes('Without that cache, propagate the connectivity failure') &&
  /if \(_sessionCache\.user\)[\s\S]*?return _sessionCache\.user;[\s\S]*?throw e;/.test(serverApi) &&
  init.includes('let authCheckUnavailable = false;') &&
  init.includes('if (authCheckUnavailable && connectivityGateEnabled && mobileRuntimeNeedsServer())') &&
  init.includes("const connectivityGateEnabled = (typeof connectivityUiEnabled === 'function')") &&
  init.includes(': isPackagedMobileApp();') &&
  init.includes('stopForPackagedMobileConnection();'));
check('sync indicator cancels stale hide timers before every new status',
  liveSync.includes('let _syncIndicatorHideTimer = null;') &&
  liveSync.includes('clearTimeout(_syncIndicatorHideTimer);') &&
  liveSync.includes('_syncIndicatorHideTimer = null;') &&
  liveSync.indexOf('clearTimeout(_syncIndicatorHideTimer);') < liveSync.indexOf('switch (status)') &&
  liveSync.includes("indicator.dataset.status = String(status || '');") &&
  liveSync.includes("if (indicator?.dataset.status === 'synced') indicator.style.opacity = '0';") &&
  liveSync.includes('indicator.onclick = null;') &&
  liveSync.includes("indicator.setAttribute('aria-live', 'polite')"));
check('settings exposes public privacy and account-deletion actions',
  views.includes('https://albayanhub.com/privacy') &&
  views.includes('https://albayanhub.com/delete-account') &&
  views.includes('Request Account Deletion') &&
  views.includes('طلب حذف الحساب') &&
  views.includes('rel="noopener noreferrer"'));
check('clothes line items use responsive named grids',
  ['clothes-variant-row', 'clothes-shipment-subgrid', 'clothes-order-subgrid']
    .every(token => clothes.includes(token) && css.includes(`.${token}`)));
check('Ads Studio wizard is mobile-first and touch accessible',
  adsStudio.includes('overflow-x-auto custom-scrollbar') &&
  adsStudio.includes('touch-target min-h-12') &&
  adsStudio.includes('grid gap-3 sm:grid-cols-2') &&
  adsStudio.includes('max-w-4xl mx-auto') &&
  !adsStudio.includes('<table'));
check('Ads Studio mobile client never handles Meta secrets or live publishing',
  adsStudio.includes('never ask for a Facebook password') &&
  adsStudio.includes('Meta adapter must run on the backend') &&
  !/accessToken|access_token|appSecret|app_secret/.test(adsStudio) &&
  !/Publish Now|Publish Live/i.test(adsStudio));
check('Ads Studio photos use the shared compressed and lazy-hydrated pipeline',
  adsStudio.includes('compressImageToDataUrl(file)') &&
  adsStudio.includes("ensureEntityMediaLoaded('adCampaignRequests'") &&
  adsStudio.includes('creativeImages') &&
  adsStudio.includes('ADS_STUDIO_MAX_TOTAL_CREATIVE_BYTES = 5 * 1024 * 1024'));
check('Ads Studio phone picker rejects unsupported image formats before compression',
  adsStudio.includes('accept="image/png,image/jpeg,image/webp"') &&
  adsStudio.includes('ADS_STUDIO_ALLOWED_IMAGE_MIME_TYPES.has') &&
  adsStudio.includes('isSafeAdsStudioCreativeSource(output)') &&
  adsStudio.includes('ADS_STUDIO_MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024') &&
  adsStudio.includes('adsStudioDataUrlDecodedBytes(src)') &&
  adsStudio.includes('Use PNG, JPEG or WebP images only.') &&
  adsStudio.includes('On iPhone, choose JPEG / Most Compatible; HEIC is not supported yet.'));
check('all photo forms offer clipboard paste without bypassing their upload pipelines',
  ['ad', 'receipt'].every(target => modals.includes(`data-photo-paste-target="${target}"`) && modals.includes(`pastePhotoFromClipboard('${target}')`)) &&
  helpers.includes('data-photo-paste-target="delivery"') && helpers.includes("pastePhotoFromClipboard('delivery')") &&
  clothes.includes('data-photo-paste-target="clothes-product"') && clothes.includes("pastePhotoFromClipboard('clothes-product')") &&
  adsStudio.includes('data-photo-paste-target="ads-studio"') && adsStudio.includes("pastePhotoFromClipboard('ads-studio')") &&
  photoPaste.includes("uploadAdPhotos(images)") &&
  photoPaste.includes("uploadReceiptPhotos(images)") &&
  photoPaste.includes("handleDeliveryReceiptPhotoUpload(images)") &&
  photoPaste.includes("uploadAdsStudioCreativeFiles(images)") &&
  photoPaste.includes("uploadClothesProductPhotoFiles(images)"));
check('photo paste is installed once and preserves normal text paste',
  init.includes("typeof setupPhotoPasteSupport === 'function'") &&
  photoPaste.includes('if (_photoPasteListenerInstalled) return;') &&
  photoPaste.includes("document.addEventListener('paste', handlePhotoPasteEvent)") &&
  photoPaste.includes('pasteContext !== capturePhotoPasteContext(target)') &&
  photoPaste.includes('isPhotoPasteTextEntry(event?.target)') &&
  photoPaste.includes('isPhotoPasteTextEntry(document.activeElement)'));
check('Ads Studio clears private drafts and blocks late photo callbacks across sessions',
  adsStudio.includes('function resetAdsStudioSessionState()') &&
  adsStudio.includes('_adsStudioDraft !== draftRef') &&
  adsStudio.includes("state.currentView !== 'ads-studio'") &&
  liveSync.includes("typeof resetAdsStudioSessionState === 'function'") &&
  liveSync.includes('closeReceiptPhotoViewer(false)') &&
  helpers.includes('function closeReceiptPhotoViewer(restoreFocus = true)'));
check('Ads Studio live rerenders preserve in-progress confirmation and review notes',
  adsStudio.includes('_adsStudioConfirmationChecked ? \'checked\' : \'\'') &&
  adsStudio.includes('_adsStudioReviewNotes[String(campaign.id || \'\')]') &&
  adsStudio.includes('setAdsStudioReviewNote') &&
  adsStudio.includes('_adsStudioSaveAndSubmitPromise'));
check('Ads Studio creative hydration is bounded and released on visibility or auth changes',
  serverApi.includes('MAX_TRANSIENT_AD_CAMPAIGN_MEDIA = 3') &&
  serverApi.includes('cacheTransientAdCampaignMedia(key, full)') &&
  serverApi.includes('makeLightweightMediaRecord(collection, entity.data)') &&
  serverApi.includes("String(collection || '') === 'adCampaignRequests') entity.data = makeLightweightMediaRecord") &&
  liveSync.includes("clearTransientEntityMediaCache('adCampaignRequests')") &&
  liveSync.includes('SERVER_MEDIA_BEARING_COLLECTIONS'));
check('Ads Studio subscription revocation purges protected collections immediately',
  liveSync.includes('getRevokedServerServiceEntitlements') &&
  liveSync.includes("revokedServices.includes('ad_maker')") &&
  liveSync.includes("RenderQueue.schedule('liveSync(subscription-revoked)')"));
check('Ads Studio workflow buttons are single-flight and retries carry operation IDs',
  adsStudio.includes('_adsStudioSubmitPromises.has(campaignId)') &&
  adsStudio.includes('_adsStudioReviewPromises.has(campaignId)') &&
  adsStudio.includes("Security.generateSecureId('campaign-submit')") &&
  adsStudio.includes("Security.generateSecureId('campaign-review')") &&
  serverApi.includes('body = { expectedLastModified, operationId }'));
check('Ads Studio media requests allow realistic slow mobile uploads',
  serverApi.includes('ADS_STUDIO_MEDIA_TIMEOUT_MS = 90000') &&
  serverApi.includes("name === 'adCampaignRequests' ? ADS_STUDIO_MEDIA_TIMEOUT_MS : 15000") &&
  serverApi.includes("String(collection || '') === 'adCampaignRequests' ? ADS_STUDIO_MEDIA_TIMEOUT_MS"));
check('Ads Studio dates and destinations are validated for the phone timezone',
  adsStudio.includes('date.getFullYear()') &&
  !/function _adsStudioDateOffset[\s\S]{0,240}toISOString/.test(adsStudio) &&
  adsStudio.includes('adsStudioIsValidDestination') &&
  adsStudio.includes('String(d.startDate) < _adsStudioDateOffset(0)'));

check('receipt edits preserve the saved collection date (liquidity window integrity)',
  forms.includes("collectionDate: (editTarget ? editTarget.collectionDate : '') || (receiptIsPaid ? new Date().toISOString() : '')") &&
  helpers.includes('function getReceiptPaidDate(r)') &&
  helpers.includes('function getLiquiditySnapshot()') &&
  helpers.includes("const paidAt = r?.deliveredAt || r?.collectionDate || r?.createdAt || null;") &&
  helpers.includes("new Date(r.collectedAt) < new Date(paidAt) ? r.collectedAt : paidAt"));

// Arabic-keyboard search: every list search folds Arabic-Indic/Persian digits
// and unhamza'd Arabic spellings on BOTH the query and the haystack. Without
// this, a driver typing ٠٩١٢٣٤٥٦٧٨ or احمد on a phone keyboard gets silent
// zero results against the ASCII/hamza-form stored values.
check('search folds Arabic-Indic digits and Arabic spelling variants on both sides',
  helpers.includes('function foldSearchText(value)') &&
  /function foldSearchText[\s\S]{0,400}normalizeDigitsAscii\(/.test(helpers) &&
  // customers view: folded term feeds the digit-only phone key match (the
  // /\D/ strip must never see unfolded ٠-٩, which it would delete)
  helpers.includes("const searchTerm = foldSearchText(state.customerSearch || '').trim();") &&
  helpers.includes("const searchPhoneDigits = searchTerm.replace(/\\D/g, '');") &&
  helpers.includes('foldSearchText(c.name).includes(searchTerm)') &&
  // ads, receipts, deliveries, audit log, command palette, pickers
  helpers.includes('foldSearchText(customer?.name).includes(searchTerm)') &&
  views.includes("const receiptSearchTerm = foldSearchText(state.receiptSearch || '');") &&
  views.includes("const name = foldSearchText(customer?.name || '');") &&
  views.includes('const auditSearchTerm = state.auditSearch ? foldSearchText(state.auditSearch) : \'\';') &&
  routing.includes('const matches = (...values) => values.some(value => foldSearchText(value).includes(term));') &&
  forms.includes('foldSearchText(item.phone).includes(searchTerm)') &&
  forms.includes('foldSearchText(c.name).includes(searchTerm)'));

// WhatsApp dispatch inside FB/IG in-app browsers: script-initiated _blank
// navigation is silently dropped by Meta shells, so the share handler must
// NOT close the dialog (it holds the Copy fallback) and must NOT toast
// "WhatsApp opened" — it warns and returns, keeping the preview open.
const whatsAppShareBody = helpers.slice(
  helpers.indexOf('function openDeliveryReceiptWhatsAppShare'),
  helpers.indexOf('function showDeliveryWhatsAppPrompt')
);
check('startup URL restoration never rebuilds an active form and erases unsaved phone input',
  routing.includes("const activeModalElement = document.getElementById('app-modal');") &&
  routing.includes("state.activeModal === params.modal") &&
  routing.includes("activeModalId === String(params.id)"));
check('in-app browsers keep the WhatsApp share dialog open instead of faking success',
  /Platform\.isInAppBrowser/.test(whatsAppShareBody) &&
  whatsAppShareBody.indexOf('Platform.isInAppBrowser') < whatsAppShareBody.indexOf('closeDeliveryWhatsAppPrompt(false)') &&
  /if \(typeof Platform !== 'undefined' && Platform\.isInAppBrowser\) \{[\s\S]{0,700}?return;[\s\S]{0,40}?\}/.test(whatsAppShareBody) &&
  whatsAppShareBody.includes('copy the text from the preview, or open this page in your real browser'));

// Login experience: device-local saved-account chooser + opt-in remember-me.
const permissionsSrc = read('src/04-permissions.js');
const savedAccountsSection = views.slice(
  views.indexOf('const ALBAYAN_SAVED_ACCOUNTS_KEY'),
  views.indexOf('function _renderLoginBrandHeader(')
);
check('saved sign-in accounts store only name/email/lastUsedAt (never credentials)',
  savedAccountsSection.length > 0 &&
  savedAccountsSection.includes("'albayan_saved_accounts'") &&
  savedAccountsSection.includes('ALBAYAN_SAVED_ACCOUNTS_MAX = 5') &&
  savedAccountsSection.includes('lastUsedAt: Math.max(0, Number(') &&
  (savedAccountsSection.match(/try \{/g) || []).length >= 3 &&
  !/password|token|secret|hash|session/i.test(savedAccountsSection),
  'saved-account helpers must persist only {name,email,lastUsedAt} inside try/catch');
check('login account chooser renders when saved accounts exist',
  views.includes('const savedAccounts = getSavedLoginAccounts();') &&
  views.includes("savedAccounts.length > 0 && _loginChooserMode === 'auto'") &&
  views.includes('function renderLoginAccountChooser(') &&
  views.includes('اختر حسابًا') &&
  views.includes('onclick="loginChooserPick(this.dataset.email)"') &&
  views.includes('onclick="loginChooserUseAnother()"') &&
  views.includes('onclick="removeSavedLoginAccount(this.dataset.email)"') &&
  views.includes('maskEmailForDisplay(acc.email)') &&
  views.includes('onclick="loginShowAccountChooser()"'));
check('remember-me is opt-in and wired into the server login payload',
  views.includes('id="login-remember"') &&
  !views.includes('id="login-remember" checked') &&
  views.includes("document.getElementById('login-remember')") &&
  liveSync.includes('function handleLogin(email, password, rememberMe)') &&
  liveSync.includes('_handleLoginOnce(email, password, generation, rememberMe === true)') &&
  serverApi.includes('rememberMe: rememberMe === true'));
check('password and passkey logins both upsert the device account list',
  (liveSync.match(/rememberLoginAccount\(user\);/g) || []).length >= 2 &&
  permissionsSrc.includes('rememberLoginAccount(user);'));
check('server login does not advertise unfinished passkey authentication',
  views.includes('const passkeySupported = !isServerModeEnabled()') &&
  views.includes('Passkey sign-in is not enabled in server mode yet.') &&
  views.includes("${!isServerModeEnabled() ? `<div class=\"mt-3\">") &&
  !views.includes('saved passwords and passkeys work there.'));
check('admin data integrity check is read-only, phone-safe, and server-backed',
  views.includes('onclick="runDataIntegrityAudit()"') &&
  actionsIo.includes("apiFetch('/api/admin/data-integrity'") &&
  actionsIo.includes("if (!isCurrentUserAdmin())") &&
  actionsIo.includes("updateUrlParams({ modal: 'data-integrity', id: 'report' })") &&
  modals.includes("case 'data-integrity':") &&
  modals.includes('max-h-[80dvh] overflow-y-auto'));

check('Meta Ads UI is admin-only, server-backed, and explicitly read-only',
  metaAds.includes('if (!isCurrentUserAdmin() || !isServerModeEnabled()) return') &&
  metaAds.includes('Read-only — Albayan accounting and photos are never changed.') &&
  metaAds.includes('apiMetaAdsStatus()') &&
  metaAds.includes('apiLinkMetaAd(') &&
  metaAds.includes('apiSyncMetaAd(') &&
  metaAds.includes('apiUnlinkMetaAd(') &&
  !metaAds.includes('api.facebook.com') &&
  !metaAds.includes('graph.facebook.com') &&
  !metaAds.includes('localStorage.setItem'));
check('Meta Ads controls are reachable outside edit and fit phone dialogs',
  views.includes('renderMetaAdsHeaderButton(isAr)') &&
  views.includes('renderMetaAdActionButton(ad, isAr)') &&
  views.includes('renderMetaAdStatusSummary(ad, isAr)') &&
  metaAds.includes('Math.min(...values)') &&
  metaAds.includes("window.visualViewport?.addEventListener('resize'") &&
  metaAds.includes("panel.style.setProperty('max-height'") &&
  metaAds.includes("panel.style.setProperty('overflow-y', 'auto', 'important')") &&
  metaAds.includes('style="max-height:${interactiveHeight - 48}px"') &&
  metaAds.includes('w-full max-w-3xl overflow-y-auto') &&
  metaAds.includes('min-h-11') &&
  metaAds.includes('sm:grid-cols'));
check('Meta Ads API wrapper never accepts a token from browser code',
  serverApi.includes("apiJson('/api/meta-ads/status'") &&
  serverApi.includes("'/api/meta-ads/sync-due'") &&
  !serverApi.includes('metaAccessToken') &&
  !serverApi.includes('access_token'));

// Phase 2 — SYSTEM-BROWSER app login for the packaged Capacitor apps:
// the app opens the hosted login page in the real browser and receives a
// one-time code back through the albayan://auth deep link (PKCE-bound).
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const iosPlist = read('ios/App/App/Info.plist');
const appLoginStartBody = serverApi.slice(
  serverApi.indexOf('async function startAppBrowserLogin('),
  serverApi.indexOf('function cancelAppBrowserLogin(')
);

check('packaged app defaults to the system-browser sign-in with an in-app fallback',
  views.includes('function renderNativeAppLogin(') &&
  views.includes('return renderNativeAppLogin(bannersHTML, isRTL);') &&
  views.includes('onclick="startAppBrowserLogin()"') &&
  views.includes('onclick="nativeLoginUseForm()"') &&
  views.includes('onclick="nativeLoginUseBrowser()"') &&
  views.includes('onclick="cancelAppBrowserLogin()"') &&
  serverApi.includes('Platform.isCapacitor && isServerModeEnabled()'));

check('browser login sends only the SHA-256 challenge — the verifier never leaves the device',
  appLoginStartBody.includes('_appLoginSha256Hex(verifier)') &&
  appLoginStartBody.includes("'&app_challenge='") &&
  !appLoginStartBody.includes('app_verifier') &&
  appLoginStartBody.indexOf('app_challenge=') !== -1 &&
  appLoginStartBody.indexOf('encodeURIComponent(challenge)') !== -1 &&
  !/app_challenge=[^']*verifier/.test(appLoginStartBody),
  'startAppBrowserLogin must put the challenge (not the verifier) in the URL');

check('deep-link callback is state-bound and exchanged for a session (PKCE)',
  serverApi.includes("const APP_LOGIN_DEEP_LINK = 'albayan://auth'") &&
  serverApi.includes('parsed.state !== pending.state') &&
  serverApi.includes("'/api/auth/app-login/exchange'") &&
  liveSync.includes('async function completeAppBrowserLogin(code, verifier)') &&
  liveSync.includes('await apiAppLoginExchange(code, verifier)') &&
  liveSync.includes('await _activateServerSession(user, generation);'));

check('password login and app-exchange share one post-auth pipeline',
  liveSync.includes('async function _activateServerSession(user, loginGeneration)') &&
  liveSync.includes('return await _activateServerSession(user, loginGeneration);'));

check('albayan://auth deep link is registered and listened for on both platforms',
  androidManifest.includes('android:scheme="albayan"') &&
  androidManifest.includes('android.intent.category.BROWSABLE') &&
  iosPlist.includes('<string>albayan</string>') &&
  serverApi.includes("addListener('appUrlOpen'") &&
  serverApi.includes('getLaunchUrl') &&
  mobileRuntime.includes('setupAppLoginDeepLinks'));

check('web login page captures the app request, scrubs the URL, and hands off a one-time code',
  init.includes('detectAppLoginRequestFromUrl') &&
  serverApi.includes('sessionStorage.setItem(APP_LOGIN_WEB_REQUEST_KEY') &&
  serverApi.includes("['app_login', 'app_state', 'app_challenge', 'app_platform'].forEach((k) => params.delete(k));") &&
  liveSync.includes('await maybeCompleteAppLoginHandoff(user);') &&
  serverApi.includes("'/api/auth/app-login/handoff'") &&
  views.includes('Signing in to the Albayan app'));

check('an already-signed-in web session never hands off to the app without an explicit tap',
  init.includes('maybeOfferAppLoginHandoffForActiveSession') &&
  serverApi.includes('function maybeOfferAppLoginHandoffForActiveSession()') &&
  serverApi.includes('albayanConfirmAppHandoff()') &&
  serverApi.includes('albayanDeclineAppHandoff()') &&
  serverApi.includes('clearPendingAppLoginRequest();'));

const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
check('mobile stylesheet braces are balanced', openBraces === closeBraces,
  `${openBraces} opening vs ${closeBraces} closing braces`);

if (failures.length) {
  console.error(`\n${failures.length} mobile UI regression check(s) failed:`);
  failures.forEach(failure => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log(`\n${passed} mobile UI regression checks passed.`);
