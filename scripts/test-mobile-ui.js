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
const clothes = read('src/15b-clothes.js');
const adsStudio = read('src/15c-ads-studio.js');
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
  dataAudit.includes("], 'receiptSettlement');") &&
  dataAudit.includes('...settlement.updatedAds.map') &&
  dataAudit.includes('if (!(_settlesReceipt && isServerModeEnabled()))') &&
  dataAudit.indexOf('if (!(_settlesReceipt && isServerModeEnabled()))') < dataAudit.indexOf("], 'receiptSettlement');"));
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
check('driver completion refreshes linked ads before final render and success',
  helpers.includes('async function refreshAdsAfterReceiptServerCascade(receipt') &&
  helpers.includes('async function refreshAdsAfterReceiptPaidCascade(receipt)') &&
  helpers.includes("apiLoadCollectionAll('ads', { forceRefresh: true })") &&
  (helpers.match(/await refreshAdsAfterReceiptPaidCascade\(/g) || []).length >= 2 &&
  helpers.indexOf('const adRefresh = await refreshAdsAfterReceiptPaidCascade(saved);') < helpers.indexOf('forceFullRender();', helpers.indexOf('const adRefresh = await refreshAdsAfterReceiptPaidCascade(saved);')) &&
  helpers.indexOf('const adRefresh = await refreshAdsAfterReceiptPaidCascade(saved);') < helpers.indexOf("showNotification(state.language === 'ar' ? 'تم التوصيل'", helpers.indexOf('const adRefresh = await refreshAdsAfterReceiptPaidCascade(saved);')));
check('server delivery cancellation refreshes released ads without stale ad PATCHes',
  views.includes('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);') &&
  views.includes('} else {\n      try {\n        releasedAds = await releaseCanceledDeliveryDueFunding(receipt.id);') &&
  helpers.includes('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);') &&
  helpers.includes('} else {\n    try {\n      releasedAds = await releaseCanceledDeliveryDueFunding(receipt.id);') &&
  views.indexOf('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);') < views.indexOf('forceFullRender();', views.indexOf('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);')) &&
  helpers.indexOf('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);') < helpers.indexOf('forceFullRender();', helpers.indexOf('adRefresh = await refreshAdsAfterReceiptServerCascade(savedReceipt);')));
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
